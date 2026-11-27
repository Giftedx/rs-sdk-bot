// The refusals of a Grand Exchange buy round that may not start (scripts/buy-owned-ge-item.ts), in one place: the text each cause
// prints, its pattern, and what the callers do with a result that ends on one. The buy script prints the text, the supervisor
// (packages/practice/src/supervise.ts) ends the job after one login, the brain/outcome classifier reads unplaced causes cleanly,
// and the shop proof reads it. A cause that nothing prints is not listed.
//
// A result is a refusal when its JSON says the order never reached the Grand Exchange: `"phase":"unplaced"`, nothing acquired and
// nothing escrowed.

export type OrderRefusalInput = { now: number; deadline: number; over: boolean; coins: number; escrow: number; quantity: number; limit: number; reserve: number; pack: number };

// The coins that a planned buy keeps above the escrow and the reserve: the plan sizes a buy on coins observed minutes before the
// run, and fares, food and fees can take a few dozen coins in between.
export const ORDER_COIN_MARGIN = 500;

export type RefusalCause = 'deadline' | 'stop' | 'coins' | 'pack' | 'baseline' | 'present';
export const REFUSAL_PATTERNS: Readonly<Record<RefusalCause, RegExp>> = {
    deadline: /^order deadline passed \d+ s ago/,
    stop: /^order stopped: /,
    coins: /^coins \d+ are under the escrow \d+ \(\d+ x \d+\) plus the reserve \d+: \d+ short/,
    pack: /^pack holds \d+ items, over 26: two collection slots unavailable/,
    baseline: /^owned item baseline \d+ differs from EXPECTED_OWNED \d+/,
    present: /^owned item already present;/,
};
// The causes that a second login would meet again: the coins and the pack do not change between two logins unless a job changes
// them, and a request with no EXPECTED_OWNED meets its held stock again. The swarm holds the market pair back for them
// (packages/fleet/src/swarm.ts stockOutEnd). A passed deadline and a baseline that differs are settled by a fresh status or a new
// request, so the planner does not hold the pair back for them.
export const STABLE_CAUSES: readonly RefusalCause[] = ['coins', 'pack', 'present'];

// Why a round may not start, or null: each cause names its numbers. The escrow of a round is its quantity at the limit price; the
// coins held (pack, bank and worn) must cover it and the reserve; two collection slots need a pack of at most 26 items.
export function orderRefusal(v: OrderRefusalInput): string | null {
    if (v.now >= v.deadline) return `order deadline passed ${Math.round((v.now - v.deadline) / 1000)} s ago (deadline ${new Date(v.deadline).toISOString()})`;
    if (v.over) return 'order stopped: the session ended, died, was damaged, was told to stop or used its 500-tick budget';
    if (v.coins < v.escrow + v.reserve) return `coins ${v.coins} are under the escrow ${v.escrow} (${v.quantity} x ${v.limit}) plus the reserve ${v.reserve}: ${v.escrow + v.reserve - v.coins} short`;
    if (v.pack > 26) return `pack holds ${v.pack} items, over 26: two collection slots unavailable`;
    return null;
}

// The cause of a result line that ends an unplaced buy, or undefined. The line is the buy script's RESULT line (or a chain's copy of it).
export function unplacedCause(result: string): RefusalCause | undefined {
    if (!/"phase":"unplaced"/.test(result) || !/"acquired":0\b/.test(result) || !/"escrow":0\b/.test(result)) return undefined;
    const failure = result.match(/"failure":"Error: ([^"]*)"/)?.[1];
    if (failure === undefined) return undefined;
    return (Object.keys(REFUSAL_PATTERNS) as RefusalCause[]).find(cause => REFUSAL_PATTERNS[cause].test(failure));
}

// The source of a regular expression for the failure text of any cause, for a caller that builds one expression (DRAIN_RESULT).
export const REFUSAL_ANY_SOURCE = Object.values(REFUSAL_PATTERNS).map(p => p.source.replace(/^\^/, '')).join('|');
