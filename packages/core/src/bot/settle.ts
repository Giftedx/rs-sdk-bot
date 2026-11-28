// Session settlement, logout reporting, monitor teardown, and process exit handling.
import type { Session } from '../inprocess';
import {
    closeWithin,
    deathRecoveries,
    eatGuards,
    finishHooks,
    ledgers,
    logoutSession,
    prayerGuards,
    randomEvents,
    records,
    settlements,
    settling,
    stallWatches,
    statuses,
} from './monitors';
import type { FinishDetail, SettlementOptions } from './rules';
import { currentHostedScope } from './host-scope';

// A record whose file is not complete in this time is left as it is; the exit does not wait longer.
const RECORD_FLUSH_MS = 3000;

export async function finish(sessions: Session[], ok: boolean, detail: FinishDetail, opts: Pick<SettlementOptions, 'logout'> = {}): Promise<never> {
    const hook = finishHooks.get(String((sessions[0] as { name?: string } | undefined)?.name ?? '').toLowerCase());
    if (hook) { const final = await settle(sessions, ok, detail, opts); hook(final, detail); return new Promise<never>(() => {}); }
    // A helper module's finish() inside a bot host ends the hosted bot that runs it (host-scope.ts).
    const hosted = currentHostedScope();
    if (hosted) return hosted.finish(sessions, ok, detail);
    // Inside a bot host other bots share this process: log this one out and stop here, never exit the host.
    if ((globalThis as { __rsBotHost?: unknown }).__rsBotHost) { await settle(sessions, ok, detail, opts); console.log('WARN finish inside a bot host without a runner hook; this bot stops, the host keeps running'); return new Promise<never>(() => {}); }
    const final = await settle(sessions, ok, detail, {
        ...opts,
        // Backstop: two proving runs printed RESULT ok and then sat until the 300 s kill (cause not found).
        // Logout runs first, so the account leaves the world either way; this only bounds the process.
        onReported: okNow => { setTimeout(() => { console.log('WARN finish backstop exit'); process.exit(okNow() ? 0 : 1); }, 30_000).unref?.(); },
    });
    process.exit(final ? 0 : 1);
}

// finish() without the exit: prints RESULT, the ledgers and events, logs every account out, closes every session,
// and returns the final ok. The bot host (host.ts) calls it once per hosted script.
export function settle(sessions: Session[], ok: boolean, detail: FinishDetail, opts: SettlementOptions = {}): Promise<boolean> {
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

async function settleOnce(sessions: Session[], ok: boolean, detail: FinishDetail, opts: SettlementOptions, prior: Promise<boolean>): Promise<boolean> {
    const [{ formatLedger }, { runShutdownTasks }, { tickWaits }] = await Promise.all([
        import('../ledger'),
        import('../shutdown'),
        import('../tick-stream'),
    ]);
    // A script that ends during a death recovery does not log the account out under it.
    await Promise.all(sessions.map(s => deathRecoveries.get(s)));
    for (const s of sessions) settling.add(s);
    // The tasks of shutdown.ts (an open kill-feed check and its socket) finish before the logout and the exit.
    await runShutdownTasks();
    // A settling script waits for nothing more, and logout needs ticks: count as waiting so a lockstep tick is not held.
    tickWaits.active++;
    try {
        const log = opts.log ?? ((l: string) => console.log(l));
        for (const s of sessions) {
            const l = ledgers.get(s); if (l) log(`${formatLedger(l.stop())} bot=${s.name}`);
            // The guard's own prayers go off before the logout: a prayer that stays on drains until the session ends.
            void prayerGuards.get(s)?.release(); prayerGuards.delete(s);
            eatGuards.get(s)?.stop(); eatGuards.delete(s);
            const e = randomEvents.get(s); if (e) { e.stop(); log(`EVENTS ${JSON.stringify(e.counts())} bot=${s.name}`); }
        }
        opts.onReported?.(() => ok);
        const outs = await Promise.all(sessions.map(s => (opts.logout ?? logoutSession)(s)));
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
            r.end(typeof s.tick === 'function' ? s.tick() : 0, 'settled');
            return Promise.race([r.flushed, Bun.sleep(RECORD_FLUSH_MS)]);
        }));
        if (!await prior) ok = false;
        let finalDetail: string;
        try { finalDetail = typeof detail === 'function' ? detail(ok) : detail; }
        catch (error) { ok = false; finalDetail = `final accounting: ${String(error)}`; }
        log(`RESULT ${ok ? 'ok' : 'fail'} ${finalDetail}`);
        return ok;
    } finally {
        for (const s of sessions) {
            ledgers.get(s)?.stop();
            ledgers.delete(s);
            const pg = prayerGuards.get(s);
            if (pg) { prayerGuards.delete(s); void pg.release().catch(() => {}); }
            eatGuards.get(s)?.stop();
            eatGuards.delete(s);
            statuses.get(s)?.stop();
            statuses.delete(s);
            stallWatches.get(s)?.stop();
            stallWatches.delete(s);
            randomEvents.get(s)?.stop();
            randomEvents.delete(s);
            const rec = records.get(s);
            if (rec) { records.delete(s); rec.end(typeof s.tick === 'function' ? s.tick() : 0, 'settled'); }
        }
        tickWaits.active = Math.max(0, tickWaits.active - 1);
    }
}
