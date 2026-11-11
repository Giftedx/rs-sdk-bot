import { expect, test } from 'bun:test';
import { PROFILES, sparOptions, sparScore, sparValid } from './pk-spar';
import { againstSummary, ladderSummary, readFight } from './measure/pk-spar-ladder';
import { benchCases } from './measure/aio-bench-cases';
import type { FightResult, Kit } from './pk';

const fight = (outcome: FightResult['outcome'], taken: number, attacks = 10): FightResult =>
    ({ outcome, ticks: 200, dealt: 0, taken, eaten: 0, attacks: { magic: attacks, ranged: 0, melee: 0 }, freezes: 0, specs: 0 });
const kit: Kit = { magic: [1401], ranged: [861], melee: [1231, 1201] };

test('a kill scores above an escape, an escape above a draw, and a draw above a death, whatever the damage margin', () => {
    expect(sparScore(fight('kill', 400), fight('timeout', 99))).toMatchObject({ winner: 'a', end: 'kill', score: 101 });
    expect(sparScore(fight('escaped', 400), fight('timeout', 99))).toMatchObject({ winner: 'a', end: 'escape', score: 100 });
    expect(sparScore(fight('timeout', 99), fight('timeout', 400))).toMatchObject({ winner: 'draw', end: 'cap', score: 99 });
    expect(sparScore(fight('timeout', 400), fight('timeout', 99))).toMatchObject({ winner: 'draw', score: -99 });
    expect(sparScore(fight('lost', 10), fight('timeout', 300))).toMatchObject({ winner: 'b', end: 'escape', score: -100 });
    expect(sparScore(fight('died', 99), fight('timeout', 400))).toMatchObject({ winner: 'b', end: 'kill', score: -101 });
    expect(sparScore(fight('timeout', 120), fight('died', 150))).toMatchObject({ winner: 'a', score: 230 });
    expect(sparScore(fight('died', 99), fight('died', 99))).toMatchObject({ winner: 'draw', end: 'kill', score: 0 });
});

test('a spar is valid only when both sides attacked and the fight ended in a kill or at the cap', () => {
    expect(sparValid(sparScore(fight('kill', 99), fight('timeout', 80)))).toBe(true);
    expect(sparValid(sparScore(fight('timeout', 99), fight('timeout', 80)))).toBe(true);
    expect(sparValid(sparScore(fight('kill', 99), fight('timeout', 0, 0)))).toBe(false);
    expect(sparValid(sparScore(fight('timeout', 10), fight('escaped', 10)))).toBe(true);
    expect(sparValid(sparScore(fight('lost', 10), fight('timeout', 10)))).toBe(true);
    expect(sparValid(sparScore(fight('lost', 10, 0), fight('timeout', 10)))).toBe(false);
    expect(sparValid(sparScore(fight('session ended', 10), fight('timeout', 10)))).toBe(false);
});

test('a profile changes only its own options, and JSON options go on top', () => {
    const base = sparOptions('base', undefined, kit, 900);
    expect(base).toMatchObject({ kit, cap: 900, spec: { cost: 250, below: 0.65 } });
    expect(sparOptions('no-spec', undefined, kit, 900).spec).toBeUndefined();
    expect(sparOptions('spec-early', undefined, kit, 900).spec).toMatchObject({ cost: 250, below: 0.8 });
    expect(sparOptions('freeze', '{"eatAt":60}', kit, 900)).toMatchObject({ freeze: true, eatAt: 60 });
    expect(() => sparOptions('nope', undefined, kit, 900)).toThrow(/unknown profile/);
    expect(sparOptions('base', undefined, kit, 900, { escapeAt: 60 })).toMatchObject({ escapeAt: 60 });
    expect(sparOptions('base', '{"escapeAt":40}', kit, 900, { escapeAt: 60 })).toMatchObject({ escapeAt: 40 });
    for (const name of Object.keys(PROFILES)) expect(sparOptions(name, undefined, kit, 900).kit).toBe(kit);
});

test('the ladder counts each fight from the side the challenger played', () => {
    const line = (winner: string, score: number) => `RESULT ok spar winner=${winner} score=${score} ticks=210 a=x b=base`;
    const fights = [readFight(1, 'a', true, line('a', 140)), readFight(1, 'b', true, line('a', 120)), readFight(2, 'a', true, line('draw', 30)), readFight(2, 'b', true, line('b', -150))];
    expect(ladderSummary(fights)).toMatchObject({ fights: 4, failed: 0, wins: 2, losses: 1, draws: 1, scores: [140, -120, 30, 150], mean: 50, verdict: 'challenger' });
    expect(ladderSummary([fights[1]!, fights[2]!])).toMatchObject({ wins: 0, losses: 1, verdict: 'champion' });
    expect(readFight(3, 'a', false, 'RESULT fail spar')).toMatchObject({ ok: false });
    expect(ladderSummary([...fights, readFight(3, 'a', true, null)])).toMatchObject({ failed: 1, verdict: 'invalid' });
    expect(againstSummary([fights[0]!, fights[2]!], [fights[1]!, fights[3]!])).toMatchObject({ challenger: { mean: 85, wins: 1 }, champion: { mean: -15, wins: 1 }, verdict: 'challenger' });
});

test('the map cases change only the start tiles, and the runner of the escape case has 3 sharks and a glory', () => {
    const cases = benchCases(), of = (key: string) => cases.find(k => k.key === key)!;
    const tiles = (key: string) => [of(key).presetConfig!.position, of(key).companions![0]!.presetConfig!.position].map(p => [p!.x, p!.z]);
    expect(tiles('extra:spar-gap')).toEqual([[3088, 3555], [3100, 3555]]);
    expect(tiles('extra:spar-trees')).toEqual([[3099, 3536], [3105, 3536]]);
    expect(tiles('extra:spar-escape')).toEqual([[3094, 3800], [3096, 3800]]);
    expect(of('extra:spar-gap').presetConfig!.inventory).toEqual(of('pvp:spar').presetConfig!.inventory);
    const runner = of('extra:spar-escape').companions![0]!.presetConfig!.inventory!;
    expect([runner.filter(i => i.id === 385).length, runner.filter(i => i.id === 1712).length]).toEqual([3, 1]);
    expect(of('extra:spar-escape').scriptArgs).toContain('SPAR_SCENARIO=escape');
});

test('the bench spar is a mirror: both sides start with the same stats and items, two tiles apart in the Wilderness', () => {
    const c = benchCases().find(k => k.key === 'pvp:spar')!;
    const a = c.presetConfig!, b = c.companions![0]!.presetConfig!;
    expect({ ...a, position: null }).toEqual({ ...b, position: null });
    expect([a.position, b.position]).toEqual([{ x: 3094, z: 3555, level: 0 }, { x: 3096, z: 3555, level: 0 }]);
    expect(a.inventory!.length).toBeLessThan(28); // a free slot: the shield comes off for the bow
});
