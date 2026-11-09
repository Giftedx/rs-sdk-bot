// Practice rehearsal of one route segment from a library save (or a preset), with ticks measured by the engine.
// A segment names its start, the worker command, the planned ticks and the expected end state (library.json
// `segments`). The runner loads the start under a fresh practice account, runs the worker, reads the engine tick when
// the account enters and leaves the world, and compares the end save with the expectation. With `capture` it also
// stores a state in the library: mid-run from the save endpoint (no logout), or the end save.
// Practice only: the engine is local, on ports, a pid file and logs apart from the shared practice slot (8888), and every bot.env is
// rewritten to that local engine before login.
// Usage: bun packages/practice/src/rehearse.ts <segment-id> [--start] [--out <dir>]
//        bun packages/practice/src/rehearse.ts --specialist <segment.json> --start [--out <dir>]
//   --start  start an isolated practice engine with the save endpoint, and stop it at the end.
import {appendFileSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {freemem} from 'node:os';
import {join, relative, resolve} from 'node:path';
import {localFile, sha, type Binding} from '../../core/src/launch-evidence';
import {FREE_FLOOR_GB, PRACTICE_STARTUP_GB} from '../../core/src/memory';
import {isLocalServer} from '../../core/src/localserver';
import {missionSignature} from '../../core/src/session-admission';
import {SPECIALIST_BOARDS, specialistContext} from '../../core/src/specialist-launch';
import {recordRoot, scriptKey} from '../../core/src/tick-record';
import {capabilityRevision, workerEntries} from '../../core/src/worker-release';
import {createBot} from './bots';
import {practiceDir, rsSdkRoot} from './paths';
import {applyPreset, PRESETS, type SaveConfig} from './presets';
import {killTree} from './proc';
import {runBotName} from './prove';
import {SAVE_PORT_ENV} from './save-endpoint';
import {addEntry, captureSave, loadSnapshot, onlineState, readLibrary, rsSdkRevision, summarize, LIBRARY_DIR, playerSavePath, SKILLS, type SaveSummary} from './save-library';
import {startStack, type Stack} from './stack';
import {confirmLivingSession, observedSupplies, scoredClock, SPECIALIST_TICK_MS, successfulWorkerLog} from './specialist-rehearsal';

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
    start: {snapshot: string} | {preset: string} | {save: SaveConfig} | {fresh: true};
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
    // Stores a library save: when `when` (an expectation on the endpoint save, read each poll) holds, after `afterTicks`, else the end save.
    capture?: {name: string; segment: string; afterTicks?: number; when?: Segment['expect']};
    timeoutMs?: number;
}

export function checkSpecialistSegment(seg: Segment, account: string) {
    const name = typeof account === 'string' ? account.toLowerCase() : '';
    const board = Object.hasOwn(SPECIALIST_BOARDS, name) ? SPECIALIST_BOARDS[name]!.name : undefined;
    if (!board) throw Error('unknown reserved specialist');
    if (!seg.start || !('fresh' in seg.start) || seg.start.fresh !== true || Object.keys(seg.start).length !== 1 || seg.capture)
        throw Error('specialist rehearsal needs a fresh engine account with no fixture or segment capture');
    if (seg.expect?.skills?.[board] !== 99) throw Error('specialist rehearsal must target level 99');
    if (!seg.plan || !Number.isSafeInteger(seg.plan.ticks) || seg.plan.ticks <= 0 || !seg.plan.source?.trim())
        throw Error('specialist rehearsal needs a priced route plan');
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(seg.id) || !/^scripts\/[\w/-]+\.ts$/.test(seg.script))
        throw Error('invalid specialist segment or worker path');
    if (Object.keys(seg.env ?? {}).some(k => !/^[_a-z][_a-z0-9]*$/i.test(k) || /PASSWORD|SECRET|TOKEN|HAGGIS_RUN|WORKER_|DEMO_OK|^BUN_|^COORDINATOR_|^TICK_RECORD|^REPLAY_ONLY/i.test(k)))
        throw Error('invalid specialist worker environment');
    return board;
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
    const unknown = Object.keys(expect).filter(k => !['skills', 'items', 'position'].includes(k));
    if (unknown.length) throw new Error(`unknown expectation keys: ${unknown.join(', ')}`);
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

export function pointBotAt(envPath: string, engine: number, gateway: number, host = "localhost") {
    const server = `${host}:${engine}`;
    if (!isLocalServer(server)) throw new Error('rehearsal bots must use the local engine');
    let env = readFileSync(envPath, 'utf8').replace(/\r\n/g, '\n');
    for (const [k, v] of [['SERVER', server], ['GATEWAY_URL', `ws://${host}:${gateway}`]] as const)
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
    specialist?: {receipt: Binding; candidate: Binding};
}

type ScoredRun = {account: string; board: string; source: string; mission: string; ledger: string; engineLog: string};

function bind(file: string): Binding {
    const path = relative(root, file).replaceAll('\\', '/');
    return {path, sha256: sha(readFileSync(localFile(root, path)))};
}

async function writeSpecialistReceipt(seg: Segment, scored: ScoredRun, actor: string, server: string, out: string, log: string, savePath: string) {
    const workerLog = readFileSync(log, 'utf8');
    if (!successfulWorkerLog(workerLog)) throw Error('need one successful raw worker run with confirmed logout');
    const recordDir = join(recordRoot(root), scriptKey(seg.script));
    const records = readdirSync(recordDir).filter(file => file.startsWith(actor.toLowerCase() + '-') && file.endsWith('.ticks.ndjson.gz'));
    if (records.length !== 1) throw Error('need one complete tick record of the fresh actor');
    const tickRecord = join(recordDir, records[0]!);
    await confirmLivingSession(tickRecord, actor, server);
    if (/\[trade-ledger\].*failed/.test(readFileSync(scored.engineLog, 'utf8'))) throw Error('practice trade ledger write failed');
    const save = readFileSync(savePath), {endPlaytime, boardTick} = scoredClock(save, scored.board);
    const planTicks = seg.plan!.ticks;
    if (Math.abs(endPlaytime - planTicks) > planTicks * .02 || Math.abs(boardTick - planTicks) > planTicks * .02)
        throw Error('saved specialist clocks differ from the plan by more than 2%');
    if (capabilityRevision(workerEntries(seg.script, seg.args ?? [], root), root) !== scored.source)
        throw Error('worker source changed during specialist rehearsal');
    const externalSupplies = observedSupplies(readFileSync(scored.ledger, 'utf8'), actor,
        JSON.parse(readFileSync(join(root, 'knowledge/items.json'), 'utf8')));
    const context = specialistContext(scored.account, scored.source, scored.mission, externalSupplies);
    const finalSave = join(out, seg.id + '.final.sav');
    writeFileSync(finalSave, save, {flag: 'wx'});
    const retainedTicks = join(out, seg.id + '.ticks.ndjson.gz');
    copyFileSync(tickRecord, retainedTicks, constants.COPYFILE_EXCL);
    const stamp = {version: 2, context, runId: actor, actor, server, at: Date.now(), startPlaytime: 0, endPlaytime, planTicks,
        ok: true, died: false, logout: 'logged-out', boardTicks: {[scored.board]: boardTick}, externalSupplies,
        artifacts: {finalSave: bind(finalSave), tradeLedger: bind(scored.ledger), tickRecord: bind(retainedTicks)}};
    appendFileSync(log, '\nREHEARSAL ' + JSON.stringify(stamp) + '\n');
    const receipt = join(out, seg.id + '.receipt.json'), candidate = join(out, seg.id + '.candidate.json');
    writeFileSync(receipt, JSON.stringify({...stamp, log: bind(log)}, null, 2) + '\n', {flag: 'wx'});
    writeFileSync(candidate, JSON.stringify({version: 1, account: scored.account, board: scored.board,
        context, planTicks, requirements: externalSupplies, rehearsal: bind(receipt)}, null, 2) + '\n', {flag: 'wx'});
    return {receipt: bind(receipt), candidate: bind(candidate)};
}

export async function rehearse(seg: Segment, opts: {out: string; port?: number; engine?: number; gateway?: number; scored?: ScoredRun}): Promise<RehearsalReport> {
    const port = opts.port ?? ISOLATED.save, engine = opts.engine ?? ISOLATED.engine, gateway = opts.gateway ?? ISOLATED.gateway;
    if (seg.capture?.when && !Object.keys(seg.capture.when).length) throw new Error(`${seg.id}: capture.when has no condition`);
    if (seg.capture?.when) checkExpect({position: {x: 0, z: 0, level: 0}, skills: {}, inventory: {}, worn: {}, bank: {}, varps: 0}, seg.capture.when);
    mkdirSync(opts.out, {recursive: true});
    const account = runBotName('rh' + seg.id.replace(/[^a-z0-9]/gi, '').slice(0, 3), 1);
    if (existsSync(join(rsSdkRoot(), 'bots', account))) throw new Error('fresh account required');
    const savePath = playerSavePath(account);
    const fresh = 'fresh' in seg.start;
    if (fresh) {
        if (!opts.scored) throw Error('fresh account rehearsals require --specialist');
        checkSpecialistSegment(seg, opts.scored.account);
        if (existsSync(savePath)) throw Error('fresh account already has an engine save');
        const state = await onlineState(account, port);
        if (state.online || state.pendingLogout) throw Error('fresh account already has an engine session');
    } else if (opts.scored) throw Error('specialist rehearsal refuses a fixture start');
    const {envPath} = await createBot(account);
    const host = opts.scored ? "127.0.0.1" : "localhost";
    pointBotAt(envPath, engine, gateway, host);
    if ('snapshot' in seg.start) await loadSnapshot(seg.start.snapshot, account, {port});
    else if ('save' in seg.start) await applyPreset(account, seg.start.save);
    else if ('preset' in seg.start) {
        const p = PRESETS[seg.start.preset];
        if (!p) throw new Error(`unknown preset ${seg.start.preset}`);
        await applyPreset(account, p);
    }
    const loadedAt = fresh ? 0 : statSync(savePath).mtimeMs;
    const saved = () => (statSync(savePath, {throwIfNoEntry: false})?.mtimeMs ?? 0) > loadedAt;

    const log = join(opts.out, `${seg.id}.log`);
    const env = opts.scored ? {...process.env, ...seg.env, DEMO_OK: '', TICK_RECORD: '1', COORDINATOR_RUN_ID: ''} :
        {...process.env, RANDOM_EVENTS: '0', ...seg.env, DEMO_OK: ''};
    const proc = Bun.spawn(['bun', seg.script, account, ...(seg.args ?? [])], {cwd: root, env,
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
                    const {version: _v, ...now} = summarize(c.bytes);
                    if (c.source.via === 'endpoint' && (!cap.when || Object.values(checkExpect(now, cap.when)).every(Boolean))) {
                        addEntry({name: cap.name, bytes: c.bytes, source: c.source, segment: cap.segment, rsSdk: rsSdkRevision()});
                        captured = {name: cap.name, via: c.source.via, tick: c.source.tick};
                    }
                }
            } catch (e) { captureError = String(e); }
        }
        if (freemem() / 2 ** 30 < FREE_FLOOR_GB && !timedOut) { timedOut = true; void killTree(proc.pid); }
    };
    let code: number, settledSave = false;
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
            if (!s.online && !s.pendingLogout && saved()) {
                settledSave = true;
                break;
            }
            await Bun.sleep(100);
        }
    } finally { clearTimeout(timer); if (proc.exitCode === null) await killTree(proc.pid); }

    let end: SaveSummary | null = null;
    const checks: Record<string, boolean> = {exit: code === 0 && !timedOut, saved: saved(), ticksMeasured: window.ticks !== null};
    if (opts.scored) checks.settledSave = settledSave;
    try { const {version: _v, ...s} = summarize(readFileSync(savePath)); end = s; Object.assign(checks, checkExpect(s, seg.expect)); }
    catch (e) { checks.endSave = false; captureError ||= String(e); }
    if (seg.capture && seg.capture.afterTicks === undefined && !seg.capture.when && checks.saved) {
        const c = await captureSave(account, port);
        addEntry({name: seg.capture.name, bytes: c.bytes, source: c.source, segment: seg.capture.segment, rsSdk: rsSdkRevision()});
        captured = {name: seg.capture.name, via: c.source.via, tick: c.source.tick};
    }
    if (seg.capture) checks.captured = !!captured;
    const used = window.ticks;
    let specialist: RehearsalReport['specialist'];
    if (opts.scored && Object.values(checks).every(Boolean)) {
        try { specialist = await writeSpecialistReceipt(seg, opts.scored, account, `${host}:${engine}`, opts.out, log, savePath); }
        catch (error) { captureError = String(error); }
    }
    if (opts.scored) checks.wholeClock = !!specialist;
    const report: RehearsalReport = {ok: Object.values(checks).every(Boolean), segment: seg.id, route: seg.route, account, start: seg.start, plan: seg.plan,
        ticks: {used, enter: window.enter, leave: window.leave, overPlan: used === null || !seg.plan ? null : used - seg.plan.ticks,
            afterCapture: captured?.tick != null && window.leave !== null ? window.leave - captured.tick : undefined},
        child: {code, timedOut}, checks, end, captured, specialist,
        scope: `One practice rehearsal (local engine, ${opts.scored ? SPECIALIST_TICK_MS : process.env.REHEARSE_TICK_MS ?? 150} ms ticks, 25x XP). No live or speed claim.` + (captureError ? ` evidence error: ${captureError}` : '')};
    writeFileSync(join(opts.out, `${seg.id}.json`), JSON.stringify(report, null, 2));
    return report;
}

export async function startIsolatedStack(scored?: {ledger: string; market: string}): Promise<Stack> {
    if (freemem() / 2 ** 30 < PRACTICE_STARTUP_GB) throw new Error(`practice startup needs ${PRACTICE_STARTUP_GB} GiB free`);
    const env = scored ? {...ISOLATED_ENGINE_ENV, TRADE_LEDGER_FILE: scored.ledger, GE_ENABLED: 'false', GE_DATABASE: scored.market} : ISOLATED_ENGINE_ENV;
    return startStack({tickMs: scored ? SPECIALIST_TICK_MS : Number(process.env.REHEARSE_TICK_MS ?? 150), xpRate: 25, ports: {engine: ISOLATED.engine, gateway: ISOLATED.gateway},
        readyTimeoutMs: 300_000, enginePreload: {module: resolve(import.meta.dir, 'save-endpoint.ts'), env}, instance: 'rehearse'});
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const outFlag = args.indexOf('--out');
    const out = outFlag >= 0 ? resolve(args[outFlag + 1]!) : join(practiceDir(), 'rehearse', String(Date.now()));
    let stack: Stack | undefined;
    try {
        if (args[0] === '--specialist') {
            if (!args[1] || !args.includes('--start')) throw Error('usage: rehearse.ts --specialist <segment.json> --start [--out <dir>]');
            const spec = JSON.parse(readFileSync(resolve(args[1]), 'utf8')) as Segment & {specialist: string};
            const board = checkSpecialistSegment(spec, spec.specialist), account = spec.specialist.toLowerCase();
            const env = {...spec.env, CAP: spec.env?.CAP ?? '1600'};
            const mission = missionSignature({account, script: spec.script, args: spec.args, env: {...env, COORDINATOR_RUN_ID: ''}});
            const source = capabilityRevision(workerEntries(spec.script, spec.args ?? [], root), root);
            if (existsSync(out)) throw Error('specialist rehearsal output directory already exists');
            const output = relative(root, out).replaceAll('\\', '/');
            if (!output.startsWith('.practice/')) throw Error('specialist rehearsal output must be in this checkout’s .practice directory');
            mkdirSync(out, {recursive: true});
            localFile(root, output);
            const ledger = join(out, 'trades.jsonl');
            writeFileSync(ledger, '', {flag: 'wx'});
            stack = await startIsolatedStack({ledger, market: join(out, 'market.sqlite')});
            const cache = await fetch(`http://127.0.0.1:${ISOLATED.engine}/crc`, {signal: AbortSignal.timeout(5000)});
            if (!cache.ok) throw Error('practice engine cache probe failed: HTTP ' + cache.status);
            await cache.arrayBuffer();
            const report = await rehearse({...spec, env}, {out, scored: {account, board, source, mission, ledger, engineLog: stack.logs.engine}});
            console.log(`SPECIALIST_REHEARSAL ${report.ok ? 'ok' : 'fail'} report=${join(out, spec.id + '.json')}`);
            process.exitCode = report.ok ? 0 : 1;
        } else {
            const ids = args.filter(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--out');
            if (!ids.length) throw Error('usage: rehearse.ts <segment-id>... [--start] [--out <dir>]');
            if (args.includes('--start')) stack = await startIsolatedStack();
            let ok = true;
            for (const id of ids) {
                const r = await rehearse(findSegment(id), {out});
                ok &&= r.ok;
                console.log(`REHEARSAL ${r.ok ? 'ok' : 'fail'} ${r.segment} ticks used=${r.ticks.used} plan=${r.plan ? `${r.plan.ticks} (${r.plan.source})` : 'none'} ` +
                    `checks=${Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k).join(',') || 'all'} report=${join(out, `${r.segment}.json`)}`);
            }
            process.exitCode = ok ? 0 : 1;
        }
    } finally { await stack?.stop(); }
}
