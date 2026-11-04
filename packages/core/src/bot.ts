import { existsSync, readFileSync } from 'node:fs';
import {accountForSdk,registerRouteActor} from './door-policy';
import { join, resolve } from 'node:path';
import { connectInProcess, type Session } from './inprocess';
import { isLocalServer } from './localserver';
import { logout } from './logout';
import { waitUntil } from './ticks';
import { stalled, startLedger, formatLedger } from './ledger';
import { assertSideOwns } from './fleet';
import { startStatus } from './status';
import { watchRandomEvents, type RandomEventWatch } from './randomevents';
import { createWorld, rsPathLength, type Account, type World } from './world';
import {assertLiveWorkerRelease} from './worker-release';
import { createTickRecorder } from './tick-record';
import { executionContext } from '../../../vendor/rs-sdk/sdk/execution-context';

// Ticks without xp, an item change or dialog before a session counts as stalled and stops (STALL_TICKS=0: never).
const STALL_TICKS = Number(process.env.STALL_TICKS ?? 900);
const repoRoot = resolve(import.meta.dir, '..', '..', '..');

// Opens an in-process session for a bot created by packages/practice (reads its bot.env),
// waits until it is in game, and prints `START x z level` for the proving harness.
// The bot's server from its bot.env SERVER line; empty or missing means our local practice server.
export function serverFromEnv(env: string): string {
    const v = env.match(/^SERVER=(.*)$/m)?.[1]?.trim();
    return v ? v : 'localhost:8888';
}

// rs-sdk's bot.env template defaults to the public demo server, so a practice bot whose --local rewrite failed
// would silently log in there. Anything but our local server needs DEMO_OK=1, set on purpose by the caller.
export function assertServerAllowed(server: string, env: Record<string, string | undefined> = process.env): void {
    if (isLocalServer(server)) return;
    if (env.DEMO_OK === '1') return;
    throw new Error(`refusing to connect to ${server}: not the local practice server; set DEMO_OK=1 to allow it on purpose`);
}

export function sessionDied(initial: any, now: any): boolean {
    return !!now && (now.isDead === true || (now.respawnCount ?? 0) > (initial?.respawnCount ?? 0)
        || (initial?.lifeId !== undefined && now.lifeId !== undefined && now.lifeId !== initial.lifeId));
}

export function watchUnexpectedEnd(s: Pick<Session,'ended'>, isSettling:()=>boolean, stopRequested:()=>boolean,
    onEnd:(detail:string)=>Promise<unknown>):void {
    void s.ended.then(end=>{
        if(!isSettling()&&!stopRequested())void onEnd(`session ended: ${end.reason}`).catch(e=>console.error('Session end cleanup failed',e));
    });
}

export async function awaitBotReady(s: Session, log: (line: string) => void): Promise<void> {
    try {
        // A connection may finish opening after its owner has already stopped.
        executionContext.getStore()?.signal.throwIfAborted();
        const ready = await waitUntil(s, st => st?.inGame && !!st.player
            && (st.skills?.find((k:any)=>k.name==='Hitpoints')?.baseLevel ?? 0)>0, { timeoutTicks: 100 });
        executionContext.getStore()?.signal.throwIfAborted();
        if (!ready) throw new Error(`${s.name} not in game after 100 ticks`);
    } catch (error) {
        s.lifecycle?.record('ready-failed', String(error));
        // The failed/cancelled readiness wait does not own a usable worker yet.
        // Keep its session cleanup outside that cancelled scope.
        await executionContext.exit(async () => {
            try { log(`LOGOUT ${await logoutSession(s)}`); }
            finally { await closeWithin([s], 5000); }
        });
        throw error;
    }
}

// `opts.log` receives the START and LOGOUT lines; the bot host (host.ts) passes a per-bot log. Default console.log.
// `opts.record` names the worker script and its arguments for the run record (tick-record.ts); the bot host passes
// the hosted script, a standalone worker uses its own process arguments.
export async function openBot(name: string, opts: { log?: (line: string) => void; onStop?: (s: Session, detail: string) => Promise<unknown>; onSessionEnd?: (s: Session, detail: string) => Promise<unknown>; record?: { script: string; argv: string[] } } = {}): Promise<Session> {
    if (executionContext.getStore()?.signal.aborted) return new Promise(() => {});
    // An in-process runner in a bot host routes this account's logins through the host's own openBot, so the host
    // tracks the session and logs it out when the runner ends. The hook is lifted for the call it makes back here.
    const hook = openHooks.get(name.toLowerCase());
    if (hook) { openHooks.delete(name.toLowerCase()); try { return await hook(name, opts); } finally { openHooks.set(name.toLowerCase(), hook); } }
    // A replay (replay.ts) serves its recorded accounts through hooks and never logs in for real.
    if (process.env.REPLAY_ONLY === '1') throw new Error(`replay has no record for ${name}; it never logs in`);
    // Never log in an account the other fleet side owns (fleet/owners.json): two machines would fight over it.
    assertSideOwns(name);
    const log = opts.log ?? ((l: string) => console.log(l));
    const env = readFileSync(join(repoRoot, 'vendor', 'rs-sdk', 'bots', name, 'bot.env'), 'utf8');
    const password = env.match(/^PASSWORD=(.*)$/m)?.[1]?.trim();
    if (!password) throw new Error(`no PASSWORD in bots/${name}/bot.env`);
    const server = serverFromEnv(env);
    assertServerAllowed(server);
    assertLiveWorkerRelease(server);
    const s = await connectInProcess({ name, password, server });
    await awaitBotReady(s, log);
    const p = s.sdk.getState()!.player!;
    // Life fields copied while connected: after a disconnect the state's player is no evidence of a death (a run
    // whose logout timed out ended the next login, and the stale player read as a new life).
    const life = (q: any) => q ? { isDead: q.isDead, respawnCount: q.respawnCount, lifeId: q.lifeId } : undefined;
    const born = life(p);
    let lastLife = born;
    s.lifecycle?.record('ready', `${p.worldX} ${p.worldZ} ${p.level}`);
    log(`START ${p.worldX} ${p.worldZ} ${p.level}`);
    const record = createTickRecorder({ account: name, server, script: opts.record?.script ?? process.argv[1] ?? 'unknown',
        argv: opts.record?.argv ?? process.argv.slice(2), startedAt: Date.now() });
    if (record && s.record) { s.record(record); records.set(s, record); }
    // Every session keeps a tick ledger (packages/core/src/ledger.ts); finish() prints it.
    const led = startLedger(s as any);
    ledgers.set(s, led);
    // Random events (dryad, genie, lost axe...): handled on every tick unless RANDOM_EVENTS=0 (packages/core/src/randomevents.ts).
    if (process.env.RANDOM_EVENTS !== '0') randomEvents.set(s, watchRandomEvents(s));
    // Any bot stops cleanly when .practice/stop-<name> appears (checked every 25 ticks): a script that never checks
    // it (seen: fishing30 under the supervisor) still logs out in game.
    let stopTicks = 0;
    let stopping = false;
    s.onTick(() => {
        lastLife = life(s.sdk.getState()?.player) ?? lastLife;
        const reason = sessionDied(born,lastLife) ? 'died' : ++stopTicks % 25 === 0 && existsSync(join(repoRoot, '.practice', `stop-${name}`)) ? 'stop file'
            : stopTicks % 50 === 0 && stalled(led.rows, STALL_TICKS) ? `no progress: ${STALL_TICKS} ticks without xp, items or dialog` : null;
        if (!stopping && !settling.has(s) && reason) {
            stopping = true;
            void (opts.onStop ? opts.onStop(s,reason) : finish([s], false, reason));
        }
    });
    // Live status for the dashboard (packages/dashboard).
    statuses.set(s, startStatus(s as any, server, () => { const c: Record<string, number> = {}; for (const r of led.rows) c[r.kind] = (c[r.kind] ?? 0) + 1; return c; }, () => led.rows.slice(-300).map(r => r.kind === 'inventory' ? 'v' : r.kind[0]).join('')));
    // No more game ticks arrive after disconnect. End a script waiting on them
    // through its own session owner, while planned logout/stop keeps its result.
    watchUnexpectedEnd(s,()=>settling.has(s),()=>stopping,detail=>
        opts.onSessionEnd?opts.onSessionEnd(s,sessionDied(born,lastLife)?'died':detail)
            :finish([s],false,sessionDied(born,lastLife)?'died':detail));
    return s;
}

let world: World | null = null;
export async function getWorld(): Promise<World> {
    world ??= { ...createWorld({ pathLength: await rsPathLength() }), offThread: true };
    return world;
}

export function accountOf(s: Session): Account {
    registerRouteActor(s.sdk,s.client);
    return accountForSdk(s.sdk);
}

// Logs one session out in game. The click skips the action queue, and is retried through the combat window.
// The result goes to this session's own lifecycle attempt; only its server end reason confirms logout.
export function logoutSession(s: Session): Promise<string> {
    const adapter = { sdk: { sendClickComponent: (id: number) => s.direct({ type: 'clickComponent', componentId: id, reason: 'SDK' }) }, ended: s.ended };
    return logout(adapter, 15_000).catch(e => `error ${String(e)}`).then(out => { s.lifecycle?.record('logout', out); return out; });
}

// A session close can hang (seen: one proving run printed RESULT ok, then sat until the 300 s
// kill). Each close gets `ms`; the caller exits either way, and the engine saves on socket close.
export async function closeWithin(sessions: Pick<Session, 'close'>[], ms: number): Promise<{ closed: number; timedOut: number }> {
    let closed = 0;
    let timedOut = 0;
    await Promise.all(sessions.map(async s => {
        const done = await Promise.race([s.close().then(() => true, () => true), Bun.sleep(ms).then(() => false)]);
        if (done) closed++; else timedOut++;
    }));
    return { closed, timedOut };
}

// Prints exactly one RESULT line, logs every account out in game (so playtime stops at once), closes every
// session (5 s limit each), and exits with 0 on ok.
const ledgers = new Map<Session, ReturnType<typeof startLedger>>();
const statuses = new Map<Session, ReturnType<typeof startStatus>>();
const randomEvents = new Map<Session, RandomEventWatch>();
const records = new Map<Session, NonNullable<ReturnType<typeof createTickRecorder>>>();
// A record whose file is not complete in this time is left as it is; the exit does not wait longer.
const RECORD_FLUSH_MS = 3000;
const settling = new WeakSet<Session>();
const settlements = new WeakMap<Session, Promise<boolean>>();
// The session's random event watcher, so a script can pause its loop while busy() is true.
export const randomEventsOf = (s: Session): RandomEventWatch | undefined => randomEvents.get(s);

// A worker may report after confirmed logout, using counters settled beforehand.
// Logout freezes the client cache; it cannot reveal a later server-side credit.
// String callers keep the same interface and the session owner keeps cleanup.
type FinishDetail = string | ((ok: boolean) => string);
// An in-process runner (scripts/quest-chain.ts in a bot host) registers an account here: finish() for that account
// then settles (RESULT, logout) and reports to the runner instead of exiting the process, which holds other bots.
export const finishHooks = new Map<string, (ok: boolean, detail: FinishDetail) => void>();
export const openHooks = new Map<string, (name: string, opts: Parameters<typeof openBot>[1]) => Promise<Session>>();
export async function finish(sessions: Session[], ok: boolean, detail: FinishDetail): Promise<never> {
    const hook = finishHooks.get(String((sessions[0] as { name?: string } | undefined)?.name ?? '').toLowerCase());
    if (hook) { const final = await settle(sessions, ok, detail); hook(final, detail); return new Promise<never>(() => {}); }
    // Inside a bot host other bots share this process: log this one out and stop here, never exit the host.
    if ((globalThis as { __rsBotHost?: unknown }).__rsBotHost) { await settle(sessions, ok, detail); console.log('WARN finish inside a bot host without a runner hook; this bot stops, the host keeps running'); return new Promise<never>(() => {}); }
    const final = await settle(sessions, ok, detail, {
        // Backstop: two proving runs printed RESULT ok and then sat until the 300 s kill (cause not found).
        // Logout runs first, so the account leaves the world either way; this only bounds the process.
        onReported: okNow => { setTimeout(() => { console.log('WARN finish backstop exit'); process.exit(okNow() ? 0 : 1); }, 30_000).unref?.(); },
    });
    process.exit(final ? 0 : 1);
}

// finish() without the exit: prints RESULT, the ledgers and events, logs every account out, closes every session,
// and returns the final ok. The bot host (host.ts) calls it once per hosted script.
export function settle(sessions: Session[], ok: boolean, detail: FinishDetail, opts: { log?: (line: string) => void; onReported?: (okNow: () => boolean) => void } = {}): Promise<boolean> {
    const unique = [...new Set(sessions)];
    const existing = [...new Set(unique.map(s => settlements.get(s)).filter((p): p is Promise<boolean> => !!p))];
    const fresh = unique.filter(s => !settlements.has(s));
    if (!fresh.length && existing.length === 1) return existing[0]!;
    if (!fresh.length && existing.length > 1) return Promise.all(existing).then(results => results.every(Boolean));
    const prior = Promise.all(existing).then(results => results.every(Boolean));
    const result = settleOnce(fresh, ok, detail, opts, prior);
    for (const s of fresh) settlements.set(s, result);
    return result;
}

async function settleOnce(sessions: Session[], ok: boolean, detail: FinishDetail, opts: { log?: (line: string) => void; onReported?: (okNow: () => boolean) => void }, prior: Promise<boolean>): Promise<boolean> {
    for (const s of sessions) settling.add(s);
    const log = opts.log ?? ((l: string) => console.log(l));
    for (const s of sessions) {
        const l = ledgers.get(s); if (l) log(`${formatLedger(l.stop())} bot=${s.name}`);
        const e = randomEvents.get(s); if (e) { e.stop(); log(`EVENTS ${JSON.stringify(e.counts())} bot=${s.name}`); }
    }
    opts.onReported?.(() => ok);
    const outs = await Promise.all(sessions.map(s => logoutSession(s)));
    log(`LOGOUT ${outs.join(' ')}`);
    // A session the server did not end keeps adding scored playtime until its 500-tick timeout, so it fails the run.
    if (outs.some(o => o !== 'logged-out')) { log(`WARN logout did not complete: ${outs.join(' ')}`); ok = false; }
    const c = await closeWithin(sessions, 5000);
    if (c.timedOut > 0) log(`WARN ${c.timedOut} session close(s) timed out`);
    if (c.timedOut > 0) ok = false;
    // The session end normally ends its record; a close that timed out may not have. Then wait for the file.
    await Promise.all(sessions.map(s => {
        const r = records.get(s); if (!r) return;
        records.delete(s);
        r.end(s.tick(), 'settled');
        return Promise.race([r.flushed, Bun.sleep(RECORD_FLUSH_MS)]);
    }));
    if (!await prior) ok = false;
    let finalDetail: string;
    try { finalDetail = typeof detail === 'function' ? detail(ok) : detail; }
    catch (error) { ok = false; finalDetail = `final accounting: ${String(error)}`; }
    log(`RESULT ${ok ? 'ok' : 'fail'} ${finalDetail}`);
    for (const s of sessions) { statuses.get(s)?.stop(); ledgers.delete(s); statuses.delete(s); randomEvents.delete(s); }
    return ok;
}

export const countItems = (s: Session, re: RegExp): number =>
    (s.sdk.getState()?.inventory ?? []).filter((i: { name: string }) => re.test(i.name)).reduce((n: number, i: { count: number }) => n + i.count, 0);
