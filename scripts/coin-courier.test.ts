import { test, expect } from 'bun:test';
import { parseCoins, exactCoinDelta, coinTradeObservation, meetingTiles } from './coin-courier';
import type { Session } from '../packages/core/src/inprocess';

test('trade diagnostics retain unreachable counter geometry and exact holdings', () => {
    const trade = { isOpen: false, screen: null, partner: null, myAccepted: false, partnerAccepted: false, myOffer: [], theirOffer: [] };
    const session = {
        name: 'Giver', tick: () => 30,
        bankObservation: () => ({ generation: 3, items: [{ id: 995, count: 37655 }] }),
        sdk: {
            getState: () => ({ player: { worldX: 3186, worldZ: 3437, level: 0 }, bank: { isOpen: false }, secret: 'do not log' }),
            getInventory: () => [{ id: 995, count: 12354 }, { id: 1265, count: 1 }],
            getTradeState: () => trade,
            findNearbyPlayer: (pattern: RegExp) => {
                expect(pattern.test('Taker')).toBe(true);
                expect(pattern.test('Taker2')).toBe(false);
                return { name: 'Taker', index: 1, x: 3185, z: 3436, distance: 1, reachable: false };
            },
        },
    } as unknown as Session;
    expect(coinTradeObservation(session, 'Taker')).toEqual({
        account: 'Giver', tick: 30, position: { x: 3186, z: 3437, level: 0 },
        partner: { name: 'Taker', index: 1, x: 3185, z: 3436, distance: 1, reachable: false },
        bankOpen: false, bank: { generation: 3, coins: 37655 }, pack: 12354, trade,
    });
});

test('trade diagnostics keep missing entry evidence explicit', () => {
    const session = {
        name: 'Giver', tick: () => 0,
        sdk: { getState: () => null, getInventory: () => [], findNearbyPlayer: () => null, getTradeState: () => ({ isOpen: false }) },
    } as unknown as Session;
    expect(coinTradeObservation(session, 'Taker')).toMatchObject({ position: null, partner: null, bankOpen: null, bank: null, pack: 0 });
});

test('named consumer retains its CLI and shared bank', () => {
    const c = parseCoins(['Pocketpython', 'Abracadickra', '2000000']);
    expect(c.amount).toBe(2000000);
    expect([c.x, c.z]).toEqual([3185, 3436]);
});
test('meeting tiles are adjacent public floor joined to the bank tile, off the booth counter', async () => {
    const c = parseCoins(['Pocketpython', 'Abracadickra', '2000000']);
    const [a, b] = meetingTiles(c)!;
    expect(Math.abs(a.x - b.x) + Math.abs(a.z - b.z)).toBe(1);
    expect([a, b].every(t => t.level === 0 && t.x <= 3184)).toBe(true);
    expect(meetingTiles({ x: 3253, z: 3420 })).toBeNull();
    const pf: any = await import('../vendor/rs-sdk/sdk/pathfinding');
    pf.initPathfinding();
    const joined = (from: { x: number; z: number }, to: { x: number; z: number }) => pf.findLongPath(0, from.x, from.z, to.x, to.z, 500)?.at(-1);
    for (const t of [a, b]) {
        expect(pf.isTileWalkable(0, t.x, t.z)).toBe(true);
        expect(joined({ x: c.x, z: c.z }, t)).toMatchObject({ x: t.x, z: t.z });
    }
    expect(joined(a, b)).toMatchObject({ x: b.x, z: b.z });
    // A tile behind the counter has no route to the meeting floor.
    expect(joined({ x: 3186, z: 3437 }, a)).not.toMatchObject({ x: a.x, z: a.z });
}, 60000);
test('amount, identity and bounds fail before login', () => {
    for (const amount of ['0', '-1', '1.5', 'NaN', '2147483648']) expect(() => parseCoins(['Giver', 'Taker', amount])).toThrow();
    expect(() => parseCoins(['Giver', 'giver', '1'])).toThrow();
    expect(() => parseCoins(['Haggis', 'Taker', '1'])).toThrow();
    expect(() => parseCoins(['Giver', 'Taker', '1', '--notes'])).toThrow();
});
test('both bank deltas must match, with original pocket coins retained', () => {
    const before = [{ bank: 3000, pack: 9 }, { bank: 50, pack: 7 }];
    const after = [{ bank: 2000, pack: 9 }, { bank: 1050, pack: 7 }];
    expect(exactCoinDelta(before, after, 1000)).toBe(true);
    expect(exactCoinDelta(before, [{ bank: 2000, pack: 9 }, { bank: 50, pack: 1007 }], 1000)).toBe(false);
    expect(exactCoinDelta(before, [{ bank: 1999, pack: 10 }, after[1]!], 1000)).toBe(false);
    expect(exactCoinDelta(before, [after[0]!, { bank: 1051, pack: 6 }], 1000)).toBe(false);
    expect(exactCoinDelta(before, [], 1000)).toBe(false);
});
