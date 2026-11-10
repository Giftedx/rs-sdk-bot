import { expect, test } from 'bun:test';
import { PROFILES, sparOptions, sparScore, sparValid } from './pk-spar';
import { ladderSummary, readFight } from './measure/pk-spar-ladder';
import { benchCases } from './measure/aio-bench-cases';
import type { FightResult, Kit } from './pk';

const fight = (outcome: FightResult['outcome'], dealt: number, attacks = 10): FightResult =>
    ({ outcome, ticks: 200, dealt, taken: 0, eaten: 0, attacks: { magic: attacks, ranged: 0, melee: 0 }, freezes: 0, specs: 0 });
const kit: Kit = { magic: [1401], ranged: [861], melee: [1231, 1201] };

test('a win scores above a draw and a draw above a loss, whatever the damage margin', () => {
    expect(sparScore(fight('kill', 99), fight('timeout', 400))).toMatchObject({ winner: 'a', score: 1 });
    expect(sparScore(fight('timeout', 400), fight('timeout', 99))).toMatchObject({ winner: 'draw', score: 99 });
    expect(sparScore(fight('died', 400), fight('timeout', 99))).toMatchObject({ winner: 'b', score: -1 });
    expect(sparScore(fight('timeout', 150), fight('died', 120))).toMatchObject({ winner: 'a', score: 130 });
    expect(sparScore(fight('died', 99), fight('died', 99))).toMatchObject({ winner: 'draw', score: 0 });
});

test('a spar is valid only when both sides attacked and the fight ended in a kill or at the cap', () => {
    expect(sparValid(sparScore(fight('kill', 99), fight('timeout', 80)))).toBe(true);
    expect(sparValid(sparScore(fight('timeout', 99), fight('timeout', 80)))).toBe(true);
    expect(sparValid(sparScore(fight('kill', 99), fight('timeout', 0, 0)))).toBe(false);
    expect(sparValid(sparScore(fight('lost', 10), fight('timeout', 10)))).toBe(false);
    expect(sparValid(sparScore(fight('session ended', 10), fight('timeout', 10)))).toBe(false);
});

test('a profile changes only its own options, and JSON options go on top', () => {
    const base = sparOptions('base', undefined, kit, 900);
    expect(base).toMatchObject({ kit, cap: 900, spec: { cost: 250, below: 0.65 } });
    expect(sparOptions('no-spec', undefined, kit, 900).spec).toBeUndefined();
    expect(sparOptions('spec-early', undefined, kit, 900).spec).toMatchObject({ cost: 250, below: 0.8 });
    expect(sparOptions('freeze', '{"eatAt":60}', kit, 900)).toMatchObject({ freeze: true, eatAt: 60 });
    expect(() => sparOptions('nope', undefined, kit, 900)).toThrow(/unknown profile/);
    for (const name of Object.keys(PROFILES)) expect(sparOptions(name, undefined, kit, 900).kit).toBe(kit);
});

test('the ladder counts each fight from the side the challenger played', () => {
    const line = (winner: string, score: number) => `RESULT ok spar winner=${winner} score=${score} ticks=210 a=x b=base`;
    const fights = [readFight(1, 'a', true, line('a', 140)), readFight(1, 'b', true, line('a', 120)), readFight(2, 'a', true, line('draw', 30)), readFight(2, 'b', true, line('b', -150))];
    expect(ladderSummary(fights)).toMatchObject({ fights: 4, failed: 0, wins: 2, losses: 1, draws: 1, scores: [140, -120, 30, 150], mean: 50, verdict: 'challenger' });
    expect(ladderSummary([fights[1]!, fights[2]!])).toMatchObject({ wins: 0, losses: 1, verdict: 'champion' });
    expect(readFight(3, 'a', false, 'RESULT fail spar')).toMatchObject({ ok: false });
    expect(ladderSummary([...fights, readFight(3, 'a', true, null)])).toMatchObject({ failed: 1, verdict: 'invalid' });
});

test('the bench spar is a mirror: both sides start with the same stats and items, two tiles apart in the Wilderness', () => {
    const c = benchCases().find(k => k.key === 'pvp:spar')!;
    const a = c.presetConfig!, b = c.companions![0]!.presetConfig!;
    expect({ ...a, position: null }).toEqual({ ...b, position: null });
    expect([a.position, b.position]).toEqual([{ x: 3094, z: 3555, level: 0 }, { x: 3096, z: 3555, level: 0 }]);
    expect(a.inventory!.length).toBeLessThan(28); // a free slot: the shield comes off for the bow
});
