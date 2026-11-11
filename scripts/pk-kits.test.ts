import { expect, test } from 'bun:test';
import { itemId, kitCost, kitItems, kitOptions, KITS, kitSwitches } from './pk-kits';
import { KNOBS, readNets, stats, verdict } from './measure/pk-spar-climb';
import { matrix, readList } from './measure/pk-spar-matrix';
import { benchCases } from './measure/aio-bench-cases';
import { flipped, netRate, sparScore } from './pk-spar';
import type { FightResult } from './pk';

test('every kit names real items, wears its first weapon, carries its other switches and leaves a free slot', () => {
    for (const [name, kit] of Object.entries(KITS)) {
        const { equipment, inventory } = kitItems(name), held = new Set([...equipment, ...inventory].map(i => i.id));
        expect(inventory.length).toBeLessThanOrEqual(27);
        for (const ids of Object.values(kitSwitches(name))) for (const id of ids!) expect(held.has(id)).toBe(true);
        expect(equipment.some(e => e.slot === 3)).toBe(true);
        expect(new Set(equipment.map(e => e.slot)).size).toBe(equipment.length);
        for (const style of kit.options?.rotation ?? []) expect(kitSwitches(name)[style]?.length).toBeGreaterThan(0);
    }
    expect(() => itemId('no_such_item')).toThrow(/no item named/);
    expect(kitOptions('ranger')).toEqual({ rotation: ['ranged'] });
});

test('each cheaper tribrid tier costs less than the tier above it', () => {
    expect(kitCost('tribrid')).toBeGreaterThan(kitCost('tribrid-adamant'));
    expect(kitCost('tribrid-adamant')).toBeGreaterThan(kitCost('tribrid-mithril'));
    expect(kitCost('tribrid-mithril')).toBeGreaterThan(0);
});

test('the kit matrix case stages each pair in its two kits, and each kit has a mirror batch', () => {
    const cases = benchCases(), all = cases.find(c => c.key === 'extra:spar-kits-x8')!;
    const kits = all.scriptArgs.find(a => a.startsWith('SPAR_KITS='))!.slice(10).split(',').map(p => p.split(':'));
    expect(kits.length).toBe(8);
    const weapon = (c: { equipment?: { id: number; slot: number }[] }) => c.equipment!.find(e => e.slot === 3)!.id;
    expect(weapon(all.presetConfig!)).toBe(weapon(kitItems(kits[0]![0]!)));
    all.companions!.forEach((c, i) => expect(weapon(c.presetConfig!)).toBe(weapon(kitItems(kits[(i + 1) >> 1]![(i + 1) % 2]!))));
    for (const kit of Object.keys(KITS)) expect(cases.some(c => c.key === `extra:spar-kit-${kit}-x8`)).toBe(true);
});

test('the climber reads the net rates of a batch and decides from the paired samples', () => {
    expect(readNets('RESULT ok spar-batch fights=2 kills=0 valid=2 nets=4.5,-3 scores=4,-3')).toEqual([4.5, -3]);
    expect(readNets('RESULT fail spar-batch nets=1,2')).toBeNull();
    expect(stats([2, 4, 6, 8])).toEqual({ n: 4, mean: 5, sd: 2.58, t: 3.87 });
    const good = Array.from({ length: 16 }, (_, i) => 5 + (i % 2 ? 3 : -3)), flat = Array.from({ length: 16 }, (_, i) => (i % 2 ? 9 : -9));
    expect(verdict(good, 2, 3)).toBe('accept');
    expect(verdict(flat, 2, 3)).toBe('reject');
    expect(verdict(good.slice(0, 8), 1, 3)).toBe('more');
    expect(verdict(good.slice(0, 8).map(n => -n), 1, 3)).toBe('reject'); // clearly worse after one batch
    expect(verdict([1, 9, -2, 8, 3, 7, -1, 6, 2, 9, -3, 8, 1, 7, 0, 5], 3, 3)).toBe('accept');
    expect(KNOBS.every(k => k.candidates.length > 0)).toBe(true);
});

test('a swapped pair is turned back to the candidate side, and the matrix groups pairs by matchup', () => {
    const f = (outcome: FightResult['outcome'], taken: number): FightResult => ({ outcome, ticks: 200, dealt: 0, taken, eaten: 0, attacks: { magic: 1, ranged: 0, melee: 0 }, freezes: 0, specs: 0 });
    const r = sparScore(f('kill', 40), f('timeout', 100));
    expect(netRate(r)).toBe(30);
    expect(flipped(r)).toMatchObject({ winner: 'b', score: -r.score });
    expect(netRate(flipped(r))).toBe(-30);
    expect(readList('RESULT ok spar-batch nets=1,-2 scores=250,-120', 'scores')).toEqual([250, -120]);
    expect(matrix(['a:b', 'a:c', 'a:b'], [{ nets: [10, -4, 20], scores: [250, -120, 30] }, { nets: [0, 6, 10], scores: [-300, 99, 150] }])).toEqual([
        { matchup: 'a:b', fights: 4, kills: 2, deaths: 1, net: 10 }, { matchup: 'a:c', fights: 2, kills: 0, deaths: 1, net: 1 },
    ]);
});
