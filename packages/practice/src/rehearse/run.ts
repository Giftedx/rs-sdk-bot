import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { localFile } from '../../../core/src/launch-evidence';
import { FREE_FLOOR_GB } from '../../../core/src/memory';
import { killTree } from '../../../core/src/proc';
import { missionSignature } from '../../../core/src/session-admission';
import { capabilityRevision, workerEntries } from '../../../core/src/worker-release';
import { createBot } from '../bots';
import { practiceBotsRoot, practiceDir, rsSdkRoot } from '../paths';
import { applyPreset, PRESETS } from '../presets';
import { runBotName } from '../prove';
import { addEntry, captureSave, loadSnapshot, onlineState, playerSavePath, rsSdkRevision, summarize, type SaveSummary } from '../save-library';
import { SPECIALIST_TICK_MS } from '../specialist-rehearsal';
import type { Stack } from '../stack';
import { pointBotAt, rehearsalChildEnv, rehearseLockstep, startIsolatedStack, stopHelperProcs, waitForSuppliersOnline } from './env';
import { writeSpecialistReceipt } from './receipt';
import { ISOLATED, REHEARSE_ROOT, SUPPLIER_ONLINE_TIMEOUT_MS, type RehearsalReport, type ScoredRun, type Segment, type SupplierSpec } from './types';
import { checkExpect, checkSpecialistSegment, findSegment, resolveSegmentSuppliers, TickWindow } from './validate';

async function spawnSuppliers(
    seg: Segment,
    supplierSpecs: readonly SupplierSpec[],
    account: string,
    opts: {out: string; scored?: ScoredRun},
    endpoints: {port: number; engine: number; gateway: number; host: string},
    helperProcs: ReturnType<typeof Bun.spawn>[],
): Promise<string[]> {
    const helpers: string[] = [];
    const seenHelpers = new Set<string>();
    const helperBase = 'sp' + seg.id.replace(/[^a-z0-9]/gi, '').slice(0, 3);
    for (let i = 0; i < supplierSpecs.length; i++) {
        const sup = supplierSpecs[i]!;
        let helper = runBotName(helperBase, i + 1);
        while (seenHelpers.has(helper.toLowerCase())) helper = runBotName(helperBase, i + 1);
        seenHelpers.add(helper.toLowerCase());
        if (existsSync(join(practiceBotsRoot(), helper)) || existsSync(join(rsSdkRoot(), 'bots', helper))) throw new Error('fresh supplier account required');
        const helperSave = playerSavePath(helper);
        if (existsSync(helperSave)) throw new Error('fresh supplier account already has an engine save');
        const helperState = await onlineState(helper, endpoints.port);
        if (helperState.online || helperState.pendingLogout) throw new Error('fresh supplier account already has an engine session');
        const {envPath: helperEnvPath} = await createBot(helper);
        pointBotAt(helperEnvPath, endpoints.engine, endpoints.gateway, endpoints.host);
        await applyPreset(helper, sup.save);
        helpers.push(helper);
        const helperArgs = (sup.args ?? []).map(a => a === '{ACTOR}' ? account : a);
        const helperEnv = rehearsalChildEnv(process.env, sup.env, {scored: !!opts.scored, role: 'supplier'});
        const logSuffix = supplierSpecs.length === 1 ? 'supplier' : `supplier-${i + 1}`;
        helperProcs.push(Bun.spawn(['bun', sup.script, helper, ...helperArgs], {
            cwd: REHEARSE_ROOT, env: helperEnv,
            stdout: Bun.file(join(opts.out, `${seg.id}.${logSuffix}.log`)),
            stderr: Bun.file(join(opts.out, `${seg.id}.${logSuffix}.err`)),
            windowsHide: true,
        }));
    }
    await waitForSuppliersOnline(helpers, helperProcs, async h => (await onlineState(h, endpoints.port)).online, SUPPLIER_ONLINE_TIMEOUT_MS);
    return helpers;
}

export async function rehearse(seg: Segment, opts: {out: string; port?: number; engine?: number; gateway?: number; scored?: ScoredRun}): Promise<RehearsalReport> {
    const port = opts.port ?? ISOLATED.save, engine = opts.engine ?? ISOLATED.engine, gateway = opts.gateway ?? ISOLATED.gateway;
    if (seg.capture?.when && !Object.keys(seg.capture.when).length) throw new Error(`${seg.id}: capture.when has no condition`);
    if (seg.capture?.when) checkExpect({position: {x: 0, z: 0, level: 0}, skills: {}, inventory: {}, worn: {}, bank: {}, varps: 0}, seg.capture.when);
    mkdirSync(opts.out, {recursive: true});
    const account = runBotName('rh' + seg.id.replace(/[^a-z0-9]/gi, '').slice(0, 3), 1);
    if (existsSync(join(practiceBotsRoot(), account)) || existsSync(join(rsSdkRoot(), 'bots', account))) throw new Error('fresh account required');
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
    const host = opts.scored ? '127.0.0.1' : 'localhost';
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
    const supplierSpecs = resolveSegmentSuppliers(seg);
    const helperProcs: ReturnType<typeof Bun.spawn>[] = [];
    try {
        const helpers = supplierSpecs.length > 0
            ? await spawnSuppliers(seg, supplierSpecs, account, opts, {port, engine, gateway, host}, helperProcs)
            : [];
        const env = rehearsalChildEnv(process.env, seg.env, {scored: !!opts.scored, role: 'worker', supplier: helpers.length ? helpers.join(',') : undefined});
        const proc = Bun.spawn(['bun', seg.script, account, ...(seg.args ?? [])], {cwd: REHEARSE_ROOT, env,
            stdout: Bun.file(log), stderr: Bun.file(join(opts.out, `${seg.id}.err`)), windowsHide: true});
        const window = new TickWindow(!!opts.scored);
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
        let code = 1, settledSave = false;
        try {
            let done = false;
            void proc.exited.then(() => { done = true; });
            while (!done) {
                await poll().catch(() => {});
                if (done) break;
                let pollTimer: ReturnType<typeof setTimeout> | undefined;
                await Promise.race([proc.exited, new Promise<void>(r => { pollTimer = setTimeout(r, 25); })]).finally(() => clearTimeout(pollTimer));
            }
            code = await proc.exited;
            // The logout save lands after the client exits. Wait for the account to leave and the file to change.
            if (!timedOut) {
                const deadline = Date.now() + 20_000;
                while (Date.now() < deadline) {
                    const s = await onlineState(account, port).catch(() => null);
                    if (s) {
                        window.observe(s.tick, s.online);
                        if (!s.online && !s.pendingLogout && saved()) {
                            settledSave = true;
                            break;
                        }
                    }
                    await Bun.sleep(25);
                }
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
            scope: `One practice rehearsal (local engine, ${opts.scored ? SPECIALIST_TICK_MS : process.env.REHEARSE_TICK_MS ?? 150} ms ticks${rehearseLockstep() ? ', lockstep' : ''}, 25x XP). No live or speed claim.` + (captureError ? ` evidence error: ${captureError}` : '')};
        writeFileSync(join(opts.out, `${seg.id}.json`), JSON.stringify(report, null, 2));
        return report;
    } finally {
        await stopHelperProcs(helperProcs);
    }
}

export async function runRehearseCli(args: string[]): Promise<void> {
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
            const source = capabilityRevision(workerEntries(spec.script, spec.args ?? [], REHEARSE_ROOT), REHEARSE_ROOT);
            if (existsSync(out)) throw Error('specialist rehearsal output directory already exists');
            const output = relative(REHEARSE_ROOT, out).replaceAll('\\', '/');
            if (!output.startsWith('.practice/')) throw Error('specialist rehearsal output must be in this checkout’s .practice directory');
            mkdirSync(out, {recursive: true});
            localFile(REHEARSE_ROOT, output);
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
