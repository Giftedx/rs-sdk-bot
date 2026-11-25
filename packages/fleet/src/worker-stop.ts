// A controller that exits while its attached workers run kills them without a logout: each child dies with it. The
// server then keeps each session for LOST_SESSION_DROP_MS (200 s), and in that window every new live start on the
// server fails "release peer state unknown" (core/src/worker-release/peers.ts closedSessionRow). So a controller that
// must stop asks each worker to stop with its account stop file first, and waits for the workers to end.
// A worker reads its stop file every 25 ticks (15 s or less) and then logs out (core/src/bot/rules.ts stopReasonOf).
// One logout window is 15 s, with up to 3 tries in combat (core/src/combat-end.ts confirmedLogout).
export const WORKER_LOGOUT_GRACE_MS = 90_000;

export interface StoppingWorker {
    readonly account: string;
    readonly ended: () => boolean;
}

export interface LogOutOptions {
    // Writes the account's stop file. It must keep a stop file that is already there (an owner stop stays an owner stop).
    readonly writeStop: (account: string) => void;
    readonly graceMs?: number;
    readonly pollMs?: number;
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
}

// Asks every worker to log out, then waits until all of them end or the grace ends.
// Returns the accounts whose workers still run at the end. The caller's exit ends them.
export async function askWorkersToLogOut(workers: readonly StoppingWorker[], o: LogOutOptions): Promise<string[]> {
    const now = o.now ?? Date.now, sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
    const running = () => workers.filter(w => !w.ended());
    for (const w of running()) {
        try { o.writeStop(w.account); } catch { /* the wait below still bounds the stop */ }
    }
    const deadline = now() + (o.graceMs ?? WORKER_LOGOUT_GRACE_MS);
    while (running().length > 0 && now() < deadline) await sleep(Math.min(o.pollMs ?? 500, Math.max(0, deadline - now())));
    return running().map(w => w.account);
}
