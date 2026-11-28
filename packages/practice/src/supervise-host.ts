// Keeps a bot host run going (packages/core/src/host.ts: N accounts in one process). Same rules as supervise.ts,
// applied per account: an account is done after RESULT ok, stopped after a stop file or "no food", and never run
// again after a death or no-progress block. The host is restarted with only the accounts that failed otherwise, until each account has
// an end or the restarts run out.
// CLI: bun packages/practice/src/supervise-host.ts <script> <maxRestarts> <account...> [--arg v]... [--args a,b]
//      [--env <account> KEY=value]...   (the process env passes through to every account)
// `--arg` and `--args` are the script arguments of every account; `--env` is one variable for one account. Both go
// to host.ts as given, except that a restart passes only the env of the accounts it runs.
// Prints `SUPERVISE-HOST account <name> <reason> after <n> runs` once per account, then `SUPERVISE-HOST end`.

import {
    CLAIM_AUTHORITY_PAUSE_MS, drainPause, isDeathLine, isHpFloorLine, isHpFloorStop, isUncaughtErrorLine,
    gainedInRun, isClaimAuthorityFault, failureShape, HELD_CLAIM_TRIES, isEntryRefusal, isHeldClaimRefusal,
    isNoProgressFailure, isPrerequisiteFailure, isTransportStall, keepOutput, lineKeeper, madeProgress,
    newestStatusWrite, participantsDrainStopped, participantsHaveStopFile, repeatableFailure, STALL_MS, supervise,
} from './supervise';
import { assertWorkerRelease, isWorkerReleaseHold } from '../../core/src/worker-release';
import { fleetLeaseAllowsWorker } from '../../core/src/fleet-lease';
import { hasStopFile } from '../../core/src/practice-paths';
import { workerDrain } from '../../core/src/live-update-pending';
import { baseProcessEnv, isChainScript, runHostedBot, type HostedBot, type RunHostedBotOpts } from '../../core/src/host';
import { leanBunEnv } from '../../core/src/lean-bun-env';
import { parseStep } from '../../core/src/chain-step';
import { writeAtomicFile } from '../../core/src/atomic-file';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type AccountEnd = 'done' | 'stopped' | 'died' | 'blocked' | 'gave-up' | 'release-paused' | 'refused';

// The end an account's last RESULT line means, or null when the account must run again. Same order as supervise.ts.
export function classify(result: string | undefined, stopFile: boolean): AccountEnd | null {
    const r = result ?? '(no RESULT)';
    if (/^RESULT ok\b/.test(r)) return 'done';
    if (stopFile || /stop file/.test(r)) return 'stopped';
    // A death means the route or the food plan failed; a blind restart repeats it.
    if (/died=true|RESULT fail died/.test(r)) return 'died';
    // The session HP floor escaped at low Hitpoints (supervise.ts isHpFloorStop): a defect to fix, never a retry.
    if (isHpFloorStop(r)) return 'blocked';
    // Out of food: a restart only logs in again and finds the same empty bank.
    if (/RESULT fail no food/.test(r)) return 'stopped';
    if (isWorkerReleaseHold(r)) return 'release-paused';
    if (isEntryRefusal(r)) return 'refused';
    if (!isTransportStall(r) && (isNoProgressFailure(r) || isPrerequisiteFailure(r))) return 'blocked';
    return null;
}

// The lines of host output that the supervisor reads: the RESULT, the LEDGER and the HP_FLOOR escape line of each
// account (the key is the kind and the account). Everything else is dropped as it arrives.
const HOST_FLOOR_RE = /^\[([^\]]+)\] (?:\s*\|\s*)?HP_FLOOR escape /;
export function keptHostLine(line: string): string | null {
    const floor = line.match(HOST_FLOOR_RE);
    if (floor) return `H${floor[1]}`;
    const x = line.match(/^\[([^\]]+)\] (RESULT |LEDGER ticks=\d)/);
    return x ? `${x[2]![0]}${x[1]}` : null;
}

// The accounts whose session HP floor started an escape in this host output. Such an account ends as blocked whatever
// RESULT its script printed after the escape.
export function hpFloorAccounts(stdout: string): Set<string> {
    const out = new Set<string>();
    for (const l of stdout.split(/\r?\n/)) { const x = l.match(HOST_FLOOR_RE); if (x) out.add(x[1]!); }
    return out;
}

// The last RESULT line of each account in host output (`[name] RESULT ...`).
export function lastResults(stdout: string): Map<string, string> {
    const m = new Map<string, string>();
    for (const l of stdout.split(/\r?\n/)) {
        const x = l.match(/^\[([^\]]+)\] (RESULT .*)$/);
        if (x) m.set(x[1]!, x[2]!);
    }
    return m;
}

export interface SuperviseHostDeps {
    run(accounts: string[]): Promise<{ stdout: string; exitCode: number }>;
    stopped(account: string): boolean;
    pause(ms: number): Promise<void>;
    maxRestarts: number;
    log?(line: string): void;
    // The files of a waiting live update that the next host run would load (supervise.ts drainPause).
    drained?(): readonly string[];
}

export async function superviseHost(accounts: string[], d: SuperviseHostDeps): Promise<{ ends: Record<string, AccountEnd>; runs: number }> {
    const ends: Record<string, AccountEnd> = Object.create(null);
    const end = (a: string, why: AccountEnd, runs: number) => { ends[a] = why; d.log?.(`SUPERVISE-HOST account ${a} ${why} after ${runs} runs`); };
    const fails = new Map<string, number>(), held = new Map<string, number>(), lastShape = new Map<string, string | null>();
    let runs = 0;
    for (;;) {
        // A stop file that appeared while the host was down ends that account before the next start.
        for (const a of accounts) if (!ends[a] && d.stopped(a)) end(a, 'stopped', runs);
        const active = accounts.filter(a => !ends[a]);
        if (active.length === 0) return { ends, runs };
        runs++;
        const r = await d.run(active);
        const results = lastResults(r.stdout), floors = hpFloorAccounts(r.stdout);
        // A peer's work cannot reset this account's streak. Only its own last ledger counts, as in supervise.ts.
        const ledgers = new Map<string, string>();
        for (const line of r.stdout.split(/\r?\n/)) {
            const match = line.match(/^\[([^\]]+)\] (LEDGER ticks=\d+.*)$/);
            if (match) ledgers.set(match[1]!, match[2]!);
        }
        let retry = 0, slowAuthority = false;
        for (const a of active) {
            const res = results.get(a);
            d.log?.(`SUPERVISE-HOST run ${runs} exit ${r.exitCode} ${a}: ${(res ?? '(no RESULT)').slice(0, 200)}`);
            const why = classify(res, d.stopped(a));
            if (why) { end(a, why, runs); continue; }
            if (floors.has(a)) { end(a, 'blocked', runs); continue; }
            const heldTries = res && isHeldClaimRefusal(res) ? (held.get(a) ?? 0) + 1 : 0;
            held.set(a, heldTries);
            if (heldTries >= HELD_CLAIM_TRIES) { end(a, 'gave-up', runs); continue; }
            const worked = madeProgress(ledgers.get(a) ?? '');
            const shape = !(worked && gainedInRun(ledgers.get(a) ?? '')) && res && repeatableFailure(res) ? failureShape(res) : null;
            if (shape !== null && shape === lastShape.get(a)) { end(a, 'blocked', runs); continue; }
            lastShape.set(a, shape);
            const failures = worked ? 1 : (fails.get(a) ?? 0) + 1;
            fails.set(a, failures);
            if (failures > d.maxRestarts) { end(a, 'gave-up', runs); continue; }
            if (res && isClaimAuthorityFault(res)) slowAuthority = true;
            retry++;
        }
        if (retry === 0) return { ends, runs };
        const pause = drainPause(d.drained?.());
        if (pause) {
            d.log?.(pause);
            for (const a of active) if (!ends[a]) end(a, 'release-paused', runs);
            return { ends, runs };
        }
        await d.pause(slowAuthority ? CLAIM_AUTHORITY_PAUSE_MS : 10_000);
    }
}

export interface SuperviseHostArgs { script: string; maxRestarts: number; accounts: string[]; args: string[]; env: Record<string, Record<string, string>> }

export function parseSuperviseHostArgs(argv: readonly string[]): SuperviseHostArgs {
    const positional: string[] = [], args: string[] = [], env: Record<string, Record<string, string>> = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (a === '--args') { args.push(...(argv[++i] ?? '').split(',').filter(Boolean)); continue; }
        if (a === '--arg') { const v = argv[++i]; if (v === undefined) throw Error('--arg requires a value'); args.push(v); continue; }
        if (a === '--env') {
            const name = argv[++i], pair = argv[++i], m = pair?.match(/^([A-Z_][A-Z0-9_]*)=([^]*)$/);
            if (!name || name.startsWith('--') || !m) throw Error('--env requires <account> KEY=value');
            (env[name] ??= {})[m[1]!] = m[2]!;
            continue;
        }
        if (a.startsWith('--')) throw Error(`unknown option ${a}`);
        positional.push(a);
    }
    const [script, maxArg, ...accounts] = positional;
    if (!script || accounts.length === 0) throw Error('usage: supervise-host.ts <script> <maxRestarts> <account...> [--arg v]... [--env <account> KEY=value]...');
    const maxRestarts = Number(maxArg);
    if (!Number.isSafeInteger(maxRestarts) || maxRestarts < 0) throw Error(`maxRestarts must be a whole number: ${maxArg}`);
    for (const name of Object.keys(env)) if (!accounts.includes(name)) throw Error(`--env names ${name}, which is not a hosted account`);
    return { script, maxRestarts, accounts, args, env };
}

// The host options of one run: every script argument, and the env of the accounts in this run only.
export function hostOptions(p: Pick<SuperviseHostArgs, 'args' | 'env'>, active: readonly string[]): string[] {
    return [...p.args.flatMap(a => ['--arg', a]), ...active.flatMap(a => Object.entries(p.env[a] ?? {}).flatMap(([k, v]) => ['--env', a, `${k}=${v}`]))];
}

export function hostStopped(account: string, root = process.cwd()): boolean {
    return !fleetLeaseAllowsWorker(root) || hasStopFile(account, root);
}

// Dynamic multi-bot host pool: runs up to maxBots heterogeneous supervised bots in ONE detached Bun process,
// eliminating both per-bot supervise.ts processes and duplicate Bun/WebClient/LocIndex/SDK runtimes.
export const DEFAULT_POOL_MAX_BOTS = 8;
export const DEFAULT_POOL_MAX_LAUNCHES = 64;
export const DEFAULT_POOL_IDLE_EXIT_MS = 30_000;
export const DEFAULT_POOL_POLL_MS = 500;

export type PoolCommand =
    | {
          op: 'start';
          id: string;
          bot: string;
          script: string;
          args?: string[];
          maxRestarts?: number;
          env?: Record<string, string>;
          logPath: string;
          header?: string;
      }
    | { op: 'cancel'; id: string; bot: string; reason?: string }
    | { op: 'drain'; id: string };

export interface PoolMeta {
    poolId: string;
    pid: number;
    startedAt: number;
    source: string;
    maxBots: number;
    maxLaunches: number;
}

export interface PoolArgs {
    poolId: string;
    maxBots: number;
    maxLaunches: number;
    idleExitMs: number;
    source: string;
}

export function poolDir(root: string, poolId: string): string {
    return join(root, '.practice', 'host-pools', poolId);
}

export function poolInboxDir(root: string, poolId: string): string {
    return join(poolDir(root, poolId), 'inbox');
}

export function poolMetaPath(root: string, poolId: string): string {
    return join(poolDir(root, poolId), 'meta.json');
}

export function writePoolCommand(root: string, poolId: string, cmd: PoolCommand): string {
    const inbox = poolInboxDir(root, poolId);
    mkdirSync(inbox, { recursive: true });
    const safeId = cmd.id.replace(/[^A-Za-z0-9_.-]/g, '_');
    const file = join(inbox, `${String(Date.now()).padStart(13, '0')}-${safeId}.json`);
    writeAtomicFile(file, JSON.stringify(cmd));
    return file;
}

export function parsePoolArgs(argv: readonly string[]): PoolArgs | null {
    if (!argv.includes('--pool')) return null;
    let poolId = '';
    let maxBots = DEFAULT_POOL_MAX_BOTS;
    let maxLaunches = DEFAULT_POOL_MAX_LAUNCHES;
    let idleExitMs = DEFAULT_POOL_IDLE_EXIT_MS;
    let source = '';
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (a === '--pool') { poolId = argv[++i] ?? ''; continue; }
        if (a === '--max-bots') { maxBots = Number(argv[++i]); continue; }
        if (a === '--max-launches') { maxLaunches = Number(argv[++i]); continue; }
        if (a === '--idle-exit-ms') { idleExitMs = Number(argv[++i]); continue; }
        if (a === '--source') { source = argv[++i] ?? ''; continue; }
        throw Error(`unknown pool option ${a}`);
    }
    if (!poolId || !/^[A-Za-z0-9_.-]{1,64}$/.test(poolId)) throw Error('invalid --pool id');
    if (!Number.isSafeInteger(maxBots) || maxBots < 1) throw Error(`invalid --max-bots: ${maxBots}`);
    if (!Number.isSafeInteger(maxLaunches) || maxLaunches < 1) throw Error(`invalid --max-launches: ${maxLaunches}`);
    if (!Number.isSafeInteger(idleExitMs) || idleExitMs < 0) throw Error(`invalid --idle-exit-ms: ${idleExitMs}`);
    return { poolId, maxBots, maxLaunches, idleExitMs, source };
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) return Bun.sleep(ms);
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, ms);
        signal.addEventListener('abort', done, { once: true });
    });
}

export interface HostPoolDeps {
    root?: string;
    pollMs?: number;
    stallMs?: number;
    stallCheckMs?: number;
    runBot?: (bot: HostedBot, opts: RunHostedBotOpts) => Promise<{ name: string; ok: boolean; code: number; result: string; stalled: boolean }>;
    assertRelease?: (env: Record<string, string | undefined>, root: string) => void;
    leaseAllows?: (root: string) => boolean;
    stopped?: (bot: string, root: string) => boolean;
    drainStopped?: (bot: string, root: string) => boolean;
    drained?: (root: string) => readonly string[];
    swarmStopped?: (root: string) => boolean;
    newestStatus?: (accounts: readonly string[], root?: string) => number;
    pause?: (ms: number, signal: AbortSignal) => Promise<void>;
    log?: (line: string) => void;
    registerSignals?: boolean;
}

export async function runHostPool(args: PoolArgs, deps: HostPoolDeps = {}): Promise<{ launches: number; ends: Record<string, string> }> {
    const root = deps.root ?? process.cwd();
    const pollMs = deps.pollMs ?? DEFAULT_POOL_POLL_MS;
    const stallMs = deps.stallMs ?? STALL_MS;
    const runBot = deps.runBot ?? runHostedBot;
    const assertRelease = deps.assertRelease ?? ((env, r) => { assertWorkerRelease(env, r); });
    const leaseAllows = deps.leaseAllows ?? fleetLeaseAllowsWorker;
    const stoppedCheck = deps.stopped ?? ((bot, r) => participantsHaveStopFile([bot], r));
    const drainStoppedCheck = deps.drainStopped ?? ((bot, r) => participantsDrainStopped([bot], r));
    const drainedCheck = deps.drained ?? workerDrain;
    const swarmStoppedCheck = deps.swarmStopped ?? (r => hasStopFile('swarm', r));
    const newestStatus = deps.newestStatus ?? newestStatusWrite;
    const pauseFn = deps.pause ?? abortableSleep;
    const log = deps.log ?? (l => console.log(l));

    const dir = poolDir(root, args.poolId);
    const inbox = poolInboxDir(root, args.poolId);
    const metaFile = poolMetaPath(root, args.poolId);
    mkdirSync(inbox, { recursive: true });
    const meta: PoolMeta = {
        poolId: args.poolId,
        pid: process.pid,
        startedAt: Date.now(),
        source: args.source || baseProcessEnv().WORKER_RELEASE || '',
        maxBots: args.maxBots,
        maxLaunches: args.maxLaunches,
    };
    writeAtomicFile(metaFile, JSON.stringify(meta));
    log(`HOST-POOL start id=${args.poolId} pid=${process.pid} maxBots=${args.maxBots} maxLaunches=${args.maxLaunches}`);

    const active = new Map<string, { bot: string; cancel: AbortController; task: Promise<void> }>();
    const ends: Record<string, string> = Object.create(null);
    let totalLaunches = 0;
    let draining = false;
    let lastActiveAt = Date.now();

    const startBot = (cmd: Extract<PoolCommand, { op: 'start' }>) => {
        const key = cmd.bot.toLowerCase();
        if (active.has(key)) return;
        totalLaunches++;
        lastActiveAt = Date.now();
        const cancel = new AbortController();
        const logPath = cmd.logPath;
        mkdirSync(dirname(logPath), { recursive: true });
        const writeLog = (line: string) => {
            try { appendFileSync(logPath, line.endsWith('\n') ? line : line + '\n'); } catch { /* log file is optional */ }
        };
        if (cmd.header) writeLog(cmd.header);
        const botEnv: Record<string, string | undefined> = { ...baseProcessEnv(), ...(cmd.env ?? {}) };
        const maxRestarts = cmd.maxRestarts ?? 20;
        const scriptArgs = cmd.args ?? [];

        const task = (async () => {
            try {
                const r = await supervise({
                    run: async () => {
                        if (botEnv.DEMO_OK === '1' && botEnv.STANDING !== '1') {
                            try { assertRelease(botEnv, root); }
                            catch (e) {
                                const line = `RESULT fail ${String(e)}`;
                                writeLog(line);
                                return { stdout: line, exitCode: 1 };
                            }
                        }
                        const keepOut = lineKeeper(l =>
                            l.startsWith('RESULT') ? 'RESULT'
                                : /^LEDGER ticks=\d+/.test(l) ? 'LEDGER'
                                : isDeathLine(l) ? 'DEATH'
                                : isHpFloorLine(l) ? 'HP_FLOOR'
                                : null,
                        );
                        const keepErr = lineKeeper(l => isUncaughtErrorLine(l) ? 'ERROR' : null);
                        let steps: ReturnType<typeof parseStep>[] | undefined;
                        if (isChainScript(cmd.script)) {
                            if (!scriptArgs.length) {
                                const msg = 'RESULT fail usage: chain.ts <account> "<script> [args] [KEY=value]" ...';
                                keepOut.push(msg + '\n');
                                writeLog(msg);
                                return { stdout: keepOut.text(), stderr: '', exitCode: 2 };
                            }
                            try { steps = scriptArgs.map(parseStep); }
                            catch (e) {
                                const err = `error: ${(e as Error).message}`;
                                keepErr.push(err + '\n');
                                writeLog(err);
                                return { stdout: '', stderr: keepErr.text(), exitCode: 1 };
                            }
                        }
                        const hosted: HostedBot = {
                            name: cmd.bot,
                            script: cmd.script,
                            args: scriptArgs,
                            env: cmd.env,
                            ...(steps ? { steps } : {}),
                        };
                        const res = await runBot(hosted, {
                            out: line => {
                                keepOut.push(line + '\n');
                                if (isUncaughtErrorLine(line)) keepErr.push(line + '\n');
                                writeLog(line);
                            },
                            logFile: null,
                            prefix: false,
                            root,
                            stallMs,
                            checkMs: deps.stallCheckMs,
                            newestStatus,
                            drained: () => drainedCheck(root),
                            cancel: cancel.signal,
                        });
                        return { stdout: keepOut.text(), stderr: keepErr.text(), exitCode: res.code };
                    },
                    stopped: () => cancel.signal.aborted || !leaseAllows(root) || stoppedCheck(cmd.bot, root),
                    pause: ms => pauseFn(ms, cancel.signal),
                    maxRestarts,
                    log: l => writeLog(l),
                    drained: () => drainedCheck(root),
                    drainStopped: () => drainStoppedCheck(cmd.bot, root),
                });
                const endLine = `SUPERVISE end ${r.reason} after ${r.runs} runs`;
                writeLog(endLine);
                ends[cmd.bot] = `${r.reason} after ${r.runs} runs`;
                log(`HOST-POOL account ${cmd.bot} ${r.reason} after ${r.runs} runs`);
            } catch (e) {
                const endLine = `SUPERVISE end gave-up after 0 runs`;
                writeLog(`ERROR host-pool supervise threw: ${String(e)}`);
                writeLog(endLine);
                ends[cmd.bot] = 'gave-up after 0 runs';
                log(`HOST-POOL account ${cmd.bot} error: ${String(e)}`);
            } finally {
                active.delete(key);
                lastActiveAt = Date.now();
                try { Bun.gc(true); } catch { /* optional GC hint */ }
            }
        })();
        active.set(key, { bot: cmd.bot, cancel, task });
    };

    const drainInbox = () => {
        let files: string[];
        try { files = readdirSync(inbox).filter(f => f.endsWith('.json') && !f.includes('.tmp-')).sort(); }
        catch { return; }
        for (const f of files) {
            const full = join(inbox, f);
            let cmd: PoolCommand;
            try {
                cmd = JSON.parse(readFileSync(full, 'utf8')) as PoolCommand;
                rmSync(full, { force: true });
            } catch {
                try { rmSync(full, { force: true }); } catch { /* ignore */ }
                continue;
            }
            if (cmd.op === 'start') {
                startBot(cmd);
            } else if (cmd.op === 'cancel') {
                const entry = active.get(cmd.bot.toLowerCase());
                if (entry) entry.cancel.abort(cmd.reason ?? 'stop file');
            } else if (cmd.op === 'drain') {
                draining = true;
            }
        }
    };

    const onSignal = () => {
        draining = true;
        for (const entry of active.values()) entry.cancel.abort('stop file');
    };
    if (deps.registerSignals) {
        process.on('SIGINT', onSignal);
        process.on('SIGTERM', onSignal);
    }

    try {
        for (;;) {
            drainInbox();
            if (active.size > 0) {
                lastActiveAt = Date.now();
            } else {
                const shouldExit = draining
                    || totalLaunches >= args.maxLaunches
                    || swarmStoppedCheck(root)
                    || !leaseAllows(root)
                    || (Date.now() - lastActiveAt >= args.idleExitMs);
                if (shouldExit) break;
            }
            await Bun.sleep(pollMs);
        }
        if (active.size > 0) await Promise.allSettled([...active.values()].map(a => a.task));
    } finally {
        if (deps.registerSignals) {
            process.off('SIGINT', onSignal);
            process.off('SIGTERM', onSignal);
        }
        try {
            if (existsSync(metaFile)) {
                const cur = JSON.parse(readFileSync(metaFile, 'utf8')) as PoolMeta;
                if (cur?.pid === process.pid) rmSync(metaFile, { force: true });
            }
        } catch { /* ignore */ }
        try {
            if (existsSync(inbox) && readdirSync(inbox).length === 0) rmSync(dir, { recursive: true, force: true });
        } catch { /* ignore */ }
    }
    log(`HOST-POOL end id=${args.poolId} launches=${totalLaunches}`);
    return { launches: totalLaunches, ends };
}

if (import.meta.main) {
    const argv = process.argv.slice(2);
    let pool: PoolArgs | null = null;
    try { pool = parsePoolArgs(argv); } catch (e) { console.log(String(e)); process.exit(2); }
    if (pool) {
        await runHostPool(pool, { registerSignals: true });
        process.exit(0);
    }
    let parsed: SuperviseHostArgs;
    try { parsed = parseSuperviseHostArgs(argv); } catch (e) { console.log(String(e)); process.exit(2); }
    const { script, accounts } = parsed;
    const r = await superviseHost(accounts, {
        run: async active => {
            // A standing owner job has no coordinator acceptance, so it runs the current source without the release pin.
            if(process.env.DEMO_OK==='1'&&process.env.STANDING!=='1')try{assertWorkerRelease();}catch(e){return {stdout:active.map(a=>`[${a}] RESULT fail ${String(e)}`).join('\n'),exitCode:1};}
            const p = Bun.spawn(['bun', '--smol', 'packages/core/src/host.ts', script, ...active, '--stagger-ms', '2000', ...hostOptions(parsed, active)], { stdout: 'pipe', stderr: 'inherit', env: leanBunEnv(process.env) ,windowsHide:true});
            const stdout = await keepOutput(p.stdout, keptHostLine);
            return { stdout, exitCode: await p.exited };
        },
        stopped: a => hostStopped(a, process.cwd()),
        pause: ms => Bun.sleep(ms),
        maxRestarts: parsed.maxRestarts,
        log: l => console.log(l),
        drained: () => workerDrain(process.cwd()),
    });
    console.log(`SUPERVISE-HOST end after ${r.runs} runs ${JSON.stringify(r.ends)}`);
    process.exit(Object.values(r.ends).every(e => e === 'done') ? 0 : 1);
}
