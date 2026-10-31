// Practice rehearsal of one route segment from a library save (or a preset), with ticks measured by the engine.
// A segment names its start, the worker command, the planned ticks and the expected end state (library.json
// `segments`). The runner loads the start under a fresh practice account, runs the worker, reads the engine tick when
// the account enters and leaves the world, and compares the end save with the expectation. With `capture` it also
// stores a state in the library: mid-run from the save endpoint (no logout), or the end save.
// Practice only: the engine is local, on ports apart from the shared practice slot (8888), and every bot.env is
// rewritten to that local engine before login.
// Usage: bun packages/practice/src/rehearse.ts <segment-id> [--start] [--out <dir>]
//   --start  start an isolated practice engine with the save endpoint, and stop it at the end.
import {existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {freemem} from 'node:os';
import {join, resolve} from 'node:path';
import {FREE_FLOOR_GB, PRACTICE_STARTUP_GB} from '../../core/src/memory';
import {isLocalServer} from '../../core/src/localserver';
import {createBot} from './bots';
import {practiceDir, rsSdkRoot} from './paths';
import {applyPreset, PRESETS, type SaveConfig} from './presets';
import {killTree} from './proc';
import {runBotName} from './prove';
import {SAVE_PORT_ENV} from './save-endpoint';
import {addEntry, captureSave, loadSnapshot, onlineState, readLibrary, rsSdkRevision, summarize, LIBRARY_DIR, playerSavePath, SKILLS, type SaveSummary} from './save-library';
import {startStack, type Stack} from './stack';

const root = resolve(import.meta.dir, '..', '..', '..');

// Every port the engine and its login/friend/logger workers open, moved off the shared practice slot.
export const ISOLATED = {engine: 8910, gateway: 7791, save: 8912} as const;
export const ISOLATED_ENGINE_ENV: Record<string, string> = {
    WEB_MANAGEMENT_PORT: '8911', NODE_PORT: '43610', LOGIN_PORT: '43611', FRIEND_PORT: '43612', LOGGER_PORT: '43613',
    [SAVE_PORT_ENV]: String(ISOLATED.save),
};

type Where = 'inventory' | 'bank' | 'worn' | 'any';
export interface Segment {
    id: string;
    route?: {file: string; step: string};
    start: {snapshot: string} | {preset: string} | {save: SaveConfig};
    script: string;
    args?: string[];
    env?: Record<string, string>;
    // Absent for a seed run that only captures a state.
    plan?: {ticks: number; source: string};
    expect: {
        skills?: Record<string, number>; // minimum saved level
        items?: Record<string, {min?: number; max?: number; in?: Where}>; // keyed by obj id
        position?: {x: number; z: number; level: number; radius: number};
    };
    // Stores a library save: when `when` holds (read from the endpoint save each poll), after `afterTicks`, else the end save.
    capture?: {name: string; segment: string; afterTicks?: number; when?: {skill: string; level: number}};
    timeoutMs?: number;
}

export function findSegment(id: string, dir = LIBRARY_DIR): Segment {
    const s = ((readLibrary(dir) as {segments?: Segment[]}).segments ?? []).find(s => s.id === id);
    if (!s) throw new Error(`no segment ${id} in ${join(dir, 'library.json')}`);
    return s;
}

export function itemCount(s: SaveSummary, id: string, where: Where = 'any'): number {
    const from = where === 'any' ? [s.inventory, s.bank, s.worn] : [s[where]];
    return from.reduce((n, c) => n + (c[id] ?? 0), 0);
}

export function checkExpect(s: SaveSummary, expect: Segment['expect']): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const [skill, min] of Object.entries(expect.skills ?? {})) {
        if (!SKILLS.includes(skill as never)) throw new Error(`unknown skill ${skill}`);
        out[`skill.${skill}>=${min}`] = (s.skills[skill]?.level ?? 1) >= min;
    }
    for (const [id, e] of Object.entries(expect.items ?? {})) {
        const n = itemCount(s, id, e.in);
        out[`item.${id}.${e.in ?? 'any'}`] = (e.min === undefined || n >= e.min) && (e.max === undefined || n <= e.max);
    }
    const p = expect.position;
    if (p) out.position = s.position.level === p.level && Math.max(Math.abs(s.position.x - p.x), Math.abs(s.position.z - p.z)) <= p.radius;
    return out;
}

// Engine ticks from the first poll that sees the account in the world to the first poll that sees it gone.
// One poll every 100 ms against a 150 ms tick reads each boundary to within one tick.
export class TickWindow {
    enter: number | null = null;
    leave: number | null = null;
    observe(tick: number, inWorld: boolean) {
        if (inWorld && this.enter === null) this.enter = tick;
        if (!inWorld && this.enter !== null && this.leave === null) this.leave = tick;
    }
    get ticks(): number | null { return this.enter !== null && this.leave !== null ? this.leave - this.enter : null; }
}

export function pointBotAt(envPath: string, engine: number, gateway: number) {
    const server = `localhost:${engine}`;
    if (!isLocalServer(server)) throw new Error('rehearsal bots must use the local engine');
    let env = readFileSync(envPath, 'utf8').replace(/\r\n/g, '\n');
    for (const [k, v] of [['SERVER', server], ['GATEWAY_URL', `ws://localhost:${gateway}`]] as const)
        env = new RegExp(`^${k}=.*$`, 'm').test(env) ? env.replace(new RegExp(`^${k}=.*$`, 'gm'), `${k}=${v}`) : `${env.trimEnd()}\n${k}=${v}\n`;
    writeFileSync(envPath, env);
    if (!new RegExp(`^SERVER=${server}$`, 'm').test(readFileSync(envPath, 'utf8'))) throw new Error('bot.env SERVER rewrite failed');
}

export interface RehearsalReport {
    ok: boolean;
    segment: string;
    route?: Segment['route'];
    account: string;
    start: Segment['start'];
    plan: Segment['plan'];
    ticks: {used: number | null; enter: number | null; leave: number | null; overPlan: number | null; afterCapture?: number | null};
    child: {code: number; timedOut: boolean};
    checks: Record<string, boolean>;
    end: SaveSummary | null;
    captured?: {name: string; via: string; tick: number | null};
    scope: string;
}

export async function rehearse(seg: Segment, opts: {out: string; port?: number; engine?: number; gateway?: number}): Promise<RehearsalReport> {
    const port = opts.port ?? ISOLATED.save, engine = opts.engine ?? ISOLATED.engine, gateway = opts.gateway ?? ISOLATED.gateway;
    mkdirSync(opts.out, {recursive: true});
    const account = runBotName('rh' + seg.id.replace(/[^a-z0-9]/gi, '').slice(0, 3), 1);
    if (existsSync(join(rsSdkRoot(), 'bots', account))) throw new Error('fresh account required');
    const {envPath} = await createBot(account);
    pointBotAt(envPath, engine, gateway);
    if ('snapshot' in seg.start) await loadSnapshot(seg.start.snapshot, account, {port});
    else if ('save' in seg.start) await applyPreset(account, seg.start.save);
    else {
        const p = PRESETS[seg.start.preset];
        if (!p) throw new Error(`unknown preset ${seg.start.preset}`);
        await applyPreset(account, p);
    }
    const savePath = playerSavePath(account);
    const loadedAt = statSync(savePath).mtimeMs;

    const log = join(opts.out, `${seg.id}.log`);
    const proc = Bun.spawn(['bun', seg.script, account, ...(seg.args ?? [])], {cwd: root, env: {...process.env, DEMO_OK: '', RANDOM_EVENTS: '0', ...seg.env},
        stdout: Bun.file(log), stderr: Bun.file(join(opts.out, `${seg.id}.err`)), windowsHide: true});
    const window = new TickWindow();
    let timedOut = false, captured: RehearsalReport['captured'], captureError = '';
    const timer = setTimeout(() => { timedOut = true; void killTree(proc.pid); }, seg.timeoutMs ?? 600_000);
    const poll = async () => {
        const s = await onlineState(account, port);
        window.observe(s.tick, s.online);
        const cap = seg.capture;
        if (cap && !captured && s.online && window.enter !== null && (cap.when || cap.afterTicks !== undefined)) {
            try {
                if (cap.when || s.tick - window.enter >= cap.afterTicks!) {
                    const c = await captureSave(account, port);
                    const level = cap.when ? summarize(c.bytes).skills[cap.when.skill]?.level ?? 1 : 0;
                    if (c.source.via === 'endpoint' && (!cap.when || level >= cap.when.level)) {
                        addEntry({name: cap.name, bytes: c.bytes, source: c.source, segment: cap.segment, rsSdk: rsSdkRevision()});
                        captured = {name: cap.name, via: c.source.via, tick: c.source.tick};
                    }
                }
            } catch (e) { captureError = String(e); }
        }
        if (freemem() / 2 ** 30 < FREE_FLOOR_GB && !timedOut) { timedOut = true; void killTree(proc.pid); }
    };
    let code: number;
    try {
        let done = false;
        void proc.exited.then(() => { done = true; });
        while (!done) { await poll().catch(() => {}); await Bun.sleep(100); }
        code = await proc.exited;
        // The logout save lands after the client exits. Wait for the account to leave and the file to change.
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
            const s = await onlineState(account, port);
            window.observe(s.tick, s.online);
            if (!s.online && !s.pendingLogout && statSync(savePath).mtimeMs > loadedAt) break;
            await Bun.sleep(100);
        }
    } finally { clearTimeout(timer); if (proc.exitCode === null) await killTree(proc.pid); }

    let end: SaveSummary | null = null;
    const checks: Record<string, boolean> = {exit: code === 0 && !timedOut, saved: statSync(savePath).mtimeMs > loadedAt, ticksMeasured: window.ticks !== null};
    try { const {version: _v, ...s} = summarize(readFileSync(savePath)); end = s; Object.assign(checks, checkExpect(s, seg.expect)); }
    catch (e) { checks.endSave = false; captureError ||= String(e); }
    if (seg.capture && seg.capture.afterTicks === undefined && !seg.capture.when && checks.saved) {
        const c = await captureSave(account, port);
        addEntry({name: seg.capture.name, bytes: c.bytes, source: c.source, segment: seg.capture.segment, rsSdk: rsSdkRevision()});
        captured = {name: seg.capture.name, via: c.source.via, tick: c.source.tick};
    }
    if (seg.capture) checks.captured = !!captured;
    const used = window.ticks;
    const report: RehearsalReport = {ok: Object.values(checks).every(Boolean), segment: seg.id, route: seg.route, account, start: seg.start, plan: seg.plan,
        ticks: {used, enter: window.enter, leave: window.leave, overPlan: used === null || !seg.plan ? null : used - seg.plan.ticks,
            afterCapture: captured?.tick != null && window.leave !== null ? window.leave - captured.tick : undefined},
        child: {code, timedOut}, checks, end, captured,
        scope: `One practice rehearsal (local engine, ${process.env.REHEARSE_TICK_MS ?? 150} ms ticks, 25x XP). No live or speed claim.` + (captureError ? ` capture error: ${captureError}` : '')};
    writeFileSync(join(opts.out, `${seg.id}.json`), JSON.stringify(report, null, 2));
    return report;
}

export async function startIsolatedStack(): Promise<Stack> {
    if (freemem() / 2 ** 30 < PRACTICE_STARTUP_GB) throw new Error(`practice startup needs ${PRACTICE_STARTUP_GB} GiB free`);
    return startStack({tickMs: Number(process.env.REHEARSE_TICK_MS ?? 150), xpRate: 25, ports: {engine: ISOLATED.engine, gateway: ISOLATED.gateway},
        readyTimeoutMs: 300_000, enginePreload: {module: resolve(import.meta.dir, 'save-endpoint.ts'), env: ISOLATED_ENGINE_ENV}});
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const ids = args.filter(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--out');
    if (!ids.length) { console.error('usage: rehearse.ts <segment-id>... [--start] [--out <dir>]'); process.exit(2); }
    const outFlag = args.indexOf('--out');
    const out = outFlag >= 0 ? resolve(args[outFlag + 1]!) : join(practiceDir(), 'rehearse', String(Date.now()));
    let stack: Stack | undefined;
    try {
        if (args.includes('--start')) stack = await startIsolatedStack();
        let ok = true;
        for (const id of ids) {
            const r = await rehearse(findSegment(id), {out});
            ok &&= r.ok;
            console.log(`REHEARSAL ${r.ok ? 'ok' : 'fail'} ${r.segment} ticks used=${r.ticks.used} plan=${r.plan ? `${r.plan.ticks} (${r.plan.source})` : 'none'} ` +
                `checks=${Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k).join(',') || 'all'} report=${join(out, `${r.segment}.json`)}`);
        }
        process.exitCode = ok ? 0 : 1;
    } finally { await stack?.stop(); }
}
