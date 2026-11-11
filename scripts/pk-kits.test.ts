import { expect, test } from 'bun:test';
import { combatLevel, itemId, kitCost, kitItems, kitOptions, KITS, kitSkills, kitSwitches, kitVarps, trained } from './pk-kits';
import { KNOBS, readNets, stats, verdict } from './measure/pk-spar-climb';
import { matrix, readList } from './measure/pk-spar-matrix';
import { mayRun } from './measure/pk-spar-wait';
import { rankKits } from './measure/pk-build-rank';
import { benchCases, BUILD_BRACKETS, BUILD_BRACKETS_2, BUILD_PAIRS, BUILD_PAIRS_2 } from './measure/aio-bench-cases';
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
    // A case that failed in one seed leaves its places empty: the other cases of the seed still count.
    const holes = { nets: [] as number[], scores: [] as number[] };
    holes.nets[1] = 8; holes.scores[1] = 220;
    expect(matrix(['a:b', 'a:c'], [{ nets: [10, -4], scores: [250, -120] }, holes])).toEqual([
        { matchup: 'a:b', fights: 1, kills: 1, deaths: 0, net: 10 }, { matchup: 'a:c', fights: 2, kills: 1, deaths: 1, net: 2 },
    ]);
});

test('the memory wait asks for the memory of every run that starts at the same time', () => {
    expect(mayRun(6.3, 0, false)).toBe(true);
    expect(mayRun(6.3, 0, false, 2)).toBe(false);
    expect(mayRun(8, 0, false, 2)).toBe(true);
    expect(mayRun(9, 3, false)).toBe(true);
    expect(mayRun(9, 3, false, 2)).toBe(false);
    expect(mayRun(20, 0, true, 2)).toBe(false);
});

test('each pure has its combat level, stays at Defence 1 and Hitpoints 10, and meets a skiller where the game lets it attack', () => {
    expect(['pure-iban', 'pure-rock', 'pure-bolt', 'skiller'].map(k => combatLevel(kitSkills(k)))).toEqual([27, 46, 19, 3]);
    expect(combatLevel(kitSkills('tribrid'))).toBe(126);
    for (const kit of ['pure-iban', 'pure-rock', 'pure-bolt']) {
        expect(kitSkills(kit)).toMatchObject({ Defence: 1, Hitpoints: 10 });
        const c = benchCases().find(b => b.key === `extra:spar-${kit}-vs-skiller-x4`)!;
        // Wilderness level of the spot (wilderness_levels.rs2:4-16) against the combat gap.
        const wild = Math.floor((c.presetConfig!.position!.z - 3520) / 8) + 1;
        expect(wild).toBeGreaterThanOrEqual(combatLevel(c.presetConfig!.skills!) - 3);
        expect(c.companions![0]!.presetConfig!.skills).toEqual(kitSkills('skiller'));
        expect(benchCases().some(b => b.key === `extra:spar-duel-${kit}-x8`)).toBe(false);
    }
    expect(kitVarps('pure-iban')).toMatchObject({ 288: 120, 300: 1000 });
    expect(kitVarps('tribrid')).toEqual({ 147: 6, 176: 10, 300: 1000 });
});

test('a trained build has the Hitpoints of its combat XP, and each bracket fits in Wilderness level 34', () => {
    expect(trained({ Attack: 99, Strength: 99, Defence: 99 }).Hitpoints).toBe(99);
    expect(trained({}).Hitpoints).toBe(10);
    expect(combatLevel(kitSkills('zerker'))).toBe(92);
    expect(kitSkills('zerker').Defence).toBe(45);
    const cases = benchCases().filter(c => c.key.startsWith('extra:spar-builds-'));
    const staged = new Set(cases.flatMap(c => c.scriptArgs.find(a => a.startsWith('SPAR_KITS='))!.slice(10).split(',')).map(p => p.split(':').sort().join(':')));
    for (const kits of Object.values(BUILD_BRACKETS)) {
        const levels = kits.map(k => combatLevel(kitSkills(k)));
        expect(Math.max(...levels) - Math.min(...levels)).toBeLessThanOrEqual(34);
        kits.forEach((a, i) => kits.slice(i + 1).forEach(b => expect(staged.has([a, b].sort().join(':'))).toBe(true)));
    }
    // 28 pairs for each bracket of 8, less the 3 pairs that both brackets hold; each case in 8 processes.
    expect(staged.size).toBe(53);
    expect(BUILD_PAIRS.length).toBe(53);
    expect(cases.length).toBe(4);
    for (const c of cases) expect(c.scriptArgs).toContain('SPAR_PROCS=8');
});

// The quest rewards of the server content (knowledge/quests.json, whole XP before the XP rate) and the quests that a
// band of the planner runs for each quest of a route.
test('no quest on the route of a build gives a level over the build', async () => {
    const { BUILD_QUESTS } = await import('../packages/planner/src/autopilot');
    const { levelForXp } = await import('../packages/planner/src/curve');
    const { readFileSync } = await import('node:fs');
    const rewards = JSON.parse(readFileSync(new URL('../knowledge/quests.json', import.meta.url), 'utf8')) as { folder: string; xp: { skill: string; xp: number }[] }[];
    const CHAIN: Record<string, string[]> = { 'Lost City': ['quest_drunkmonk', 'quest_murder', 'quest_zanaris'] };
    const XP_RATE = 25, COMBAT = ['Attack', 'Strength', 'Defence', 'Ranged', 'Magic', 'Prayer', 'Hitpoints'];
    // The first skill that a list of quests takes over the levels, from the levels of a new account.
    const breaks = (folders: string[], levels: Record<string, number>) => {
        for (const skill of COMBAT) {
            const xp = folders.flatMap(f => rewards.filter(r => r.folder === f).flatMap(r => r.xp)).filter(x => x.skill === skill.toLowerCase()).reduce((n, x) => n + x.xp * XP_RATE, 0);
            if (xp > 0 && levelForXp(xp) > (levels[skill] ?? 1)) return `${skill} ${levelForXp(xp)}`;
        }
        return null;
    };
    for (const f of Object.values(CHAIN).flat()) expect(rewards.some(r => r.folder === f)).toBe(true);
    for (const [kit, route] of Object.entries(BUILD_QUESTS)) for (const quest of route) {
        expect(CHAIN[quest]).toBeDefined();
        if (kit in KITS) expect(breaks(CHAIN[quest]!, kitSkills(kit))).toBeNull();
    }
    // Why the other builds have no route: the quest that the gear needs gives a level over the build.
    expect(breaks(['quest_dragon'], kitSkills('dragon'))).toBe('Defence 88');
    expect(breaks(['quest_hero'], kitSkills('dragon'))).toBe('Attack 62');
    expect(breaks(['quest_viking'], kitSkills('range-tank'))).toBe('Attack 60');
    expect(breaks(['quest_viking'], { ...kitSkills('range-tank'), Attack: 60, Strength: 60 })).toBeNull();
});

test('the second set of builds: levels, gear that the levels can wear, and one case place for each new pair', () => {
    expect(combatLevel(kitSkills('pure-scim'))).toBe(71);
    expect(combatLevel(kitSkills('pure-pray31'))).toBe(78);
    expect(combatLevel(kitSkills('pure-max'))).toBe(94);
    expect(combatLevel(kitSkills('tank-range'))).toBe(102);
    expect(combatLevel(kitSkills('baby-pure'))).toBe(52);
    expect(kitSkills('addy-pure').Defence).toBe(30);
    expect(kitSkills('def50').Defence).toBe(50);
    // A thrown weapon is a stack in the weapon slot.
    expect(kitItems('pure-knives').equipment.find(e => e.slot === 3)).toEqual({ id: itemId('rune_knife'), count: 500, slot: 3 });
    expect(kitItems('pure-dds-msb').equipment.find(e => e.slot === 3)!.count).toBe(1);
    // No Defence 1 build holds a weapon of Heroes' Quest, and no build under Defence 60 a Fremennik helm.
    for (const [name, kit] of Object.entries(KITS)) {
        if (!kit.skills) continue;
        const items = [...Object.values(kit.worn).filter((v): v is string => typeof v === 'string'), ...kit.carried.map(c => (typeof c === 'string' ? c : c[0]))];
        if (kit.skills.Defence! < 60 && name !== 'zerker') expect(items.filter(i => /^viking_helmet/.test(i))).toEqual([]);
        if (kit.skills.Defence === 1) expect(items.filter(i => /^dragon_(mace|battleaxe)/.test(i))).toEqual([]);
    }
    const cases = benchCases().filter(c => c.key.startsWith('extra:spar-builds2-'));
    const staged = new Set(cases.flatMap(c => c.scriptArgs.find(a => a.startsWith('SPAR_KITS='))!.slice(10).split(',')).map(p => p.split(':').sort().join(':')));
    const first = new Set(BUILD_PAIRS.map(p => [...p].sort().join(':')));
    for (const kits of Object.values(BUILD_BRACKETS_2)) {
        const levels = kits.map(k => combatLevel(kitSkills(k)));
        expect(Math.max(...levels) - Math.min(...levels)).toBeLessThanOrEqual(34);
        kits.forEach((a, i) => kits.slice(i + 1).forEach(b => { const key = [a, b].sort().join(':'); expect(staged.has(key) || first.has(key)).toBe(true); }));
    }
    // No pair of the first set runs again.
    for (const key of staged) expect(first.has(key)).toBe(false);
    // 53 pairs of the three brackets and 5 of `top` (the pair of `tank-range` and `dragon` is in the Defence bracket).
    expect(BUILD_PAIRS_2.length).toBe(58);
    expect(cases.length).toBe(5);
    for (const c of cases) { expect(c.scriptArgs).toContain('SPAR_PROCS=8'); expect(c.scriptArgs).toContain('SPAR_CAP=600'); }
});

test('the build rank counts each pair for both kits and turns side B over', () => {
    const line = (matchup: string, fights: number, kills: number, deaths: number, net: number) => `MATRIX ${JSON.stringify({ matchup, fights, kills, deaths, net, costA: 0, costB: 0 })}`;
    const ranked = rankKits(['SPAR_WAIT free 9 GB', line('dragon:pure-pray', 3, 2, 1, 30), line('pure-pray:zerker', 2, 2, 0, 50), line('zerker:dragon', 1, 0, 0, -4), 'MATRIX_RUN_FAILED seed 2']);
    expect(ranked.map(r => r.kit)).toEqual(['pure-pray', 'dragon', 'zerker']);
    expect(ranked[0]).toMatchObject({ fights: 5, wins: 3, losses: 2, draws: 0, winRate: 0.6, net: 2, combat: 80, against: { dragon: '1-2', zerker: '2-0' } });
    expect(ranked[1]).toMatchObject({ fights: 4, wins: 2, losses: 1, draws: 1, net: 23.5, against: { 'pure-pray': '2-1', zerker: '0-0' } });
    expect(ranked[2]).toMatchObject({ fights: 3, wins: 0, losses: 2, draws: 1, net: -34.7 });
    // The same kit on both sides is one row.
    expect(rankKits([line('dragon:dragon', 8, 5, 3, 10)])).toMatchObject([{ kit: 'dragon', fights: 8, wins: 5, losses: 3, against: { dragon: '5-3' } }]);
});
