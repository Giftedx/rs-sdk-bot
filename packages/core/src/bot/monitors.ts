// Per-session monitors, hooks, readiness, logout, tick-stall watches, and close cleanup.
import { executionContext } from '../../../../vendor/rs-sdk/sdk/execution-context';
import type { startEatGuard } from '../eat-guard';
import type { Session } from '../inprocess';
import type { startLedger } from '../ledger';
import { logout } from '../logout';
import type { startPrayerGuard } from '../prayer-guard';
import type { RandomEventWatch } from '../randomevents';
import type { startStatus } from '../status';
import type { createTickRecorder } from '../tick-record';
import { startTickStallWatch } from '../tick-stall';
import { waitUntil } from '../ticks';
import type { FinishDetail, OpenBotOptions } from './rules';

export const ledgers = new Map<Session, ReturnType<typeof startLedger>>();
export const statuses = new Map<Session, ReturnType<typeof startStatus>>();
export const stallWatches = new Map<Session, { stop(): void }>();
export const randomEvents = new Map<Session, RandomEventWatch>();
// A WeakMap: finish() and deathRecoveryOf() read it after the session ended, so nothing deletes an entry, and a long host
// process must not keep each dead session's object graph through it.
export const deathRecoveries = new WeakMap<Session, Promise<string>>();
export const prayerGuards = new Map<Session, ReturnType<typeof startPrayerGuard>>();
export const eatGuards = new Map<Session, ReturnType<typeof startEatGuard>>();
export const records = new Map<Session, NonNullable<ReturnType<typeof createTickRecorder>>>();
export const sessionLogs = new WeakMap<Session, (line: string) => void>();
export const settling = new WeakSet<Session>();
export const settlements = new WeakMap<Session, Promise<boolean>>();

// An in-process runner (scripts/quest-chain.ts in a bot host) registers an account here: finish() for that account
// then settles (RESULT, logout) and reports to the runner instead of exiting the process, which holds other bots.
export const finishHooks = new Map<string, (ok: boolean, detail: FinishDetail) => void>();
export const openHooks = new Map<string, (name: string, opts?: OpenBotOptions) => Promise<Session>>();

// For a script that owns the prayers and needs them all off at its start (scripts/microbot-prayer-flick.ts).
export const releasePrayerGuard = async (s: Session): Promise<void> => {
    const guard = prayerGuards.get(s);
    prayerGuards.delete(s);
    await guard?.release();
};

// The session's random event watcher, so a script can pause its loop while busy() is true.
export const randomEventsOf = (s: Session): RandomEventWatch | undefined => randomEvents.get(s);

// The death recovery of a session that runs now, or undefined. An end step that walks waits for it first.
export const deathRecoveryOf = (s: Session): Promise<unknown> | undefined => deathRecoveries.get(s);

// The session as logout() takes it (logout.ts): the logout click and the session's end.
export const logoutAdapter = (s: Pick<Session, 'direct' | 'ended'>) =>
    ({ sdk: { sendClickComponent: (id: number) => s.direct({ type: 'clickComponent', componentId: id, reason: 'SDK' }) }, ended: s.ended });

// Logs one session out in game. The click skips the action queue, and is retried through the combat window.
// The result goes to this session's own lifecycle attempt; only its server end reason confirms logout.
export function logoutSession(s: Session): Promise<string> {
    return logout(logoutAdapter(s), 15_000).catch(e => `error ${String(e)}`).then(out => { s.lifecycle?.record('logout', out); return out; });
}

/** Stops all per-session monitors and timers when an intermediate session closes outside `settleOnce`. */
function cleanupClosedSession(s: Session): void {
    stallWatches.get(s)?.stop();
    stallWatches.delete(s);
    if (settling.has(s)) return;
    statuses.get(s)?.stop();
    statuses.delete(s);
    ledgers.get(s)?.stop();
    ledgers.delete(s);
    randomEvents.get(s)?.stop();
    randomEvents.delete(s);
    eatGuards.get(s)?.stop();
    eatGuards.delete(s);
    const guard = prayerGuards.get(s);
    if (guard) {
        prayerGuards.delete(s);
        void guard.release().catch(() => {});
    }
    const rec = records.get(s);
    if (rec) {
        records.delete(s);
        rec.end(typeof s.tick === 'function' ? s.tick() : 0, 'closed');
    }
}

/** Attaches a tick-stall watch that disarms automatically when `s.ended` settles or `closeWithin` closes `s`. */
export function attachTickStallWatch(
    s: Pick<Session, 'onTick' | 'ended'>,
    onStall: (detail: string) => void,
    opts?: Parameters<typeof startTickStallWatch>[2],
): { stop(): void } {
    let watch: { stop(): void } | undefined;
    watch = startTickStallWatch(s, reason => {
        watch?.stop();
        stallWatches.delete(s as Session);
        onStall(reason);
    }, opts);
    stallWatches.set(s as Session, watch);
    const disarm = () => {
        stallWatches.get(s as Session)?.stop();
        stallWatches.delete(s as Session);
    };
    void s.ended.then(disarm, disarm);
    return watch;
}

// A session close can hang (seen: one proving run printed RESULT ok, then sat until the 300 s
// kill). Each close gets `ms`; the caller exits either way, and the engine saves on socket close.
export async function closeWithin(sessions: Pick<Session, 'close'>[], ms: number): Promise<{ closed: number; timedOut: number }> {
    let closed = 0;
    let timedOut = 0;
    await Promise.all(sessions.map(async s => {
        const done = await Promise.race([s.close().then(() => true, () => true), Bun.sleep(ms).then(() => false)]);
        cleanupClosedSession(s as Session);
        if (done) closed++; else timedOut++;
    }));
    return { closed, timedOut };
}

export async function awaitBotReady(s: Session, log: (line: string) => void): Promise<void> {
    try {
        // A connection may finish opening after its owner has already stopped.
        executionContext.getStore()?.signal.throwIfAborted();
        const ready = await waitUntil(s, st => st?.inGame && !!st.player
            && (st.skills?.find((k: any) => k.name === 'Hitpoints')?.baseLevel ?? 0) > 0, { timeoutTicks: 100 });
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
