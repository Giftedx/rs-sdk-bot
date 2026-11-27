import { expect, test } from 'bun:test';
import { ORDER_COIN_MARGIN, REFUSAL_ANY_SOURCE, REFUSAL_PATTERNS, STABLE_CAUSES, orderRefusal, unplacedCause, type OrderRefusalInput, type RefusalCause } from '../src/order-refusal';
import { isPrerequisiteFailure } from '../../practice/src/supervise';

const DRAIN_RESULT = new RegExp(`^RESULT fail (?:.*"phase":"unplaced",.*"escrow":0,.*"failure":"Error: (?:${REFUSAL_ANY_SOURCE}))`);

const ok: OrderRefusalInput = { now: 1000, deadline: 5000, over: false, coins: 161000, escrow: 160000, quantity: 16, limit: 10000, reserve: 1000, pack: 10 };
const result = (failure: string, extra = '') => `RESULT fail {"ok":false,"phase":"unplaced","quantity":16,"acquired":0,"escrow":0${extra},"failure":"Error: ${failure}"}`;
const texts: Record<RefusalCause, string> = {
    deadline: orderRefusal({ ...ok, now: 8000 })!, stop: orderRefusal({ ...ok, over: true })!, coins: orderRefusal({ ...ok, coins: 160940 })!, pack: orderRefusal({ ...ok, pack: 27 })!,
    baseline: 'owned item baseline 68 differs from EXPECTED_OWNED 10', present: 'owned item already present;allocate it instead of buying duplicate stock',
};

test('every refusal text matches its own pattern and no other', () => {
    for (const cause of Object.keys(texts) as RefusalCause[]) {
        expect(unplacedCause(result(texts[cause]))).toBe(cause);
        for (const other of Object.keys(REFUSAL_PATTERNS) as RefusalCause[]) if (other !== cause) expect([cause, other, REFUSAL_PATTERNS[other].test(texts[cause])]).toEqual([cause, other, false]);
    }
});

test('one source: the supervisor, the drain rule and the planner mark read the same causes', () => {
    for (const cause of Object.keys(texts) as RefusalCause[]) {
        // A stop can differ at the next login, so the supervisor restarts it; every other cause fails the same way again.
        expect([cause, isPrerequisiteFailure(result(texts[cause]))]).toEqual([cause, cause !== 'stop']);
        expect([cause, DRAIN_RESULT.test(result(texts[cause]))]).toEqual([cause, true]);
    }
    // A buy that placed an offer, or a failure of another kind, is none of them.
    expect(unplacedCause(result(texts.coins).replace('"escrow":0', '"escrow":9'))).toBeUndefined();
    expect(unplacedCause(result('GE interface unavailable'))).toBeUndefined();
    expect(DRAIN_RESULT.test(result('GE interface unavailable'))).toBe(false);
    expect(STABLE_CAUSES).toEqual(['coins', 'pack', 'present']);
});

test('a round starts with the margin of coins and names its numbers when it does not', () => {
    expect(ORDER_COIN_MARGIN).toBe(500);
    expect(orderRefusal(ok)).toBeNull();
    expect(texts.coins).toBe('coins 160940 are under the escrow 160000 (16 x 10000) plus the reserve 1000: 60 short');
    expect(texts.pack).toBe('pack holds 27 items, over 26: two collection slots unavailable');
    expect(orderRefusal({ ...ok, pack: 26 })).toBeNull();
    expect(orderRefusal({ ...ok, now: 9000, coins: 0 })).toMatch(/^order deadline passed/);
});
