import { expect, test } from 'bun:test';
import { JAKUT, JAKUT_MARGIN, JAKUT_RESERVE, jakutCoins, swordsToBuy } from './jakut-swords';

test('a visit buys what was asked, what the shelf holds and what the coins pay for', () => {
    expect(swordsToBuy(2, 2, 100_000, 211_000)).toBe(2);
    // The shelf is the limit, then the coins: the reserve stays in the pack.
    expect(swordsToBuy(5, 2, 100_000, 1_000_000)).toBe(2);
    expect(swordsToBuy(2, 2, 101_000, 101_000 + JAKUT_RESERVE - 1)).toBe(0);
    expect(swordsToBuy(2, 2, 101_000, 101_000 + JAKUT_RESERVE)).toBe(1);
    expect(swordsToBuy(1, 0, 100_000, 500_000)).toBe(0);
    // Nonsense in, nothing bought.
    expect(swordsToBuy(1, 1, 0, 500_000)).toBe(0);
    expect(swordsToBuy(1, 1, Number.NaN, 500_000)).toBe(0);
});

test('the coins a run takes cover each sword at the shelf\'s dearest price, and the reserve', () => {
    expect(jakutCoins(1)).toBe(JAKUT.price + JAKUT_MARGIN + JAKUT_RESERVE);
    expect(jakutCoins(2)).toBe(2 * (JAKUT.price + JAKUT_MARGIN) + JAKUT_RESERVE);
    // Practice: two swords cost 201,000 and 202,000 (100,000 with two on the shelf, 101,000 with one).
    expect(jakutCoins(2)).toBeGreaterThanOrEqual(202_000 + JAKUT_RESERVE);
});

test('the planner asks the coins the worker takes for its two swords', async () => {
    const { JAKUT_COINS, JAKUT_SWORDS, catalogue } = await import('../packages/planner/src/autopilot');
    expect(JAKUT_COINS).toBe(jakutCoins(JAKUT_SWORDS));
    const t = catalogue().find(t => t.id === 'army-jakut-swords')!;
    expect(t.worker).toBe('scripts/jakut-swords.ts');
    expect(t.args).toContain(`SWORDS=${JAKUT_SWORDS}`);
});

