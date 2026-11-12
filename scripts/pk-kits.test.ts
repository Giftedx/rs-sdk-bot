import { expect, test } from 'bun:test';
import { combatLevel, itemId, kitCost, kitItems, kitOptions, kitRoute, KITS, kitSkills, levelsBeforeRoute, overBuild, QUEST_CHAIN, kitSwitches, kitVarps, trained } from './pk-kits';
import { KNOBS, readNets, stats, verdict } from './measure/pk-spar-climb';
import { matrix, readList } from './measure/pk-spar-matrix';
import { mayRun } from './measure/pk-spar-wait';
import { rankKits } from './measure/pk-build-rank';
import { benchCases, BUILD_BRACKETS, BUILD_BRACKETS_2, BUILD_PAIRS, BUILD_PAIRS_2, questKeepsBuild } from './measure/aio-bench-cases';
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
    // A kit has the quests of its route and no other: the Prayer pure has Lost City and not Dragon Slayer.
    expect(kitVarps('pure-pray')).toEqual({ 147: 6, 300: 1000 });
    expect(kitVarps('baby-pure')).toEqual({ 300: 1000 });
    expect(kitVarps('tank-range')).toEqual({ 300: 1000, 347: 10 });
});

test('a trained build has the Hitpoints of its combat XP, and each bracket fits in Wilderness level 34', () => {
    expect(trained({ Attack: 99, Strength: 99, Defence: 99 }).Hitpoints).toBe(99);
    expect(trained({}).Hitpoints).toBe(10);
    expect(combatLevel(kitSkills('zerker'))).toBe(96);
    expect(kitSkills('zerker').Defence).toBe(60);
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
test('every kit has a quest route, and the planner holds the route of every build', async () => {
    const { BUILD_QUESTS } = await import('../packages/planner/src/autopilot');
    // No reward of a quest that a kit needs gives a level over the kit.
    // A kit with no route says so (`noRoute`): it stays for a bench comparison.
    for (const [name, kit] of Object.entries(KITS)) if (kit.noRoute) expect(kitRoute(name).breaks.length).toBeGreaterThan(0); else expect([name, kitRoute(name).breaks]).toEqual([name, []]);
    expect(Object.keys(KITS).filter(name => KITS[name]!.noRoute)).toEqual(['pure-iban', 'pure-rock']);
    expect(kitRoute('pure-rock').breaks).toEqual(['Prayer 1 under the 37 of the Mage Arena']);
    expect(kitRoute('pure-god')).toEqual({ quests: ['Mage Arena'], breaks: [] });
    expect(kitRoute('pure-iban').breaks).toEqual(['no skill at 99 for the 53,400 fight XP of quest_upass']);
    expect(kitRoute('pure-hally').breaks).toEqual([]);
    // The planner's table is the route of each kit with levels of its own.
    const builds = Object.fromEntries(Object.entries(KITS).filter(([, kit]) => kit.skills && !kit.noRoute).map(([name]) => [name, kitRoute(name).quests]));
    expect(Object.fromEntries(Object.entries(BUILD_QUESTS).map(([kit, quests]) => [kit, [...quests].sort()]))).toEqual(builds);
    for (const quest of Object.values(BUILD_QUESTS).flat()) expect(QUEST_CHAIN[quest]).toBeDefined();
    expect(kitRoute('tribrid').quests).toEqual(['Dragon Slayer', 'Lost City']);
    expect(kitRoute('tribrid-mace').quests).toEqual(['Dragon Slayer', "Heroes' Quest"]);
    expect(kitRoute('zerker')).toEqual({ quests: ['Lost City', 'The Fremennik Trials'], breaks: [] });
    // The gear that a build with a Defence level leaves out, and the levels that a quest brings with it.
    const { levelForXp } = await import('../packages/planner/src/curve');
    expect(levelForXp(18650 * 25)).toBe(88);        // Dragon Slayer: Strength and Defence (quest_dragon.rs2:33-34)
    expect(levelForXp(2812.4 * 25)).toBe(60);       // The Fremennik Trials: Attack, Strength, Defence, Hitpoints (quest_viking.rs2:135-138)
    expect(levelForXp(3000 * 25)).toBe(61);         // Underground Pass: Attack (quest_upass.rs2:801)
    for (const name of Object.keys(KITS)) if ((kitSkills(name).Defence ?? 1) < 88) {
        const { equipment, inventory } = kitItems(name), held = new Set([...equipment, ...inventory].map(i => i.id));
        for (const item of ['rune_platebody', 'dragon_sq_shield', 'dragon_mace', 'dragon_battleaxe']) expect([name, item, held.has(itemId(item))]).toEqual([name, item, false]);
    }
    expect(kitSkills('zerker')).toMatchObject({ Attack: 60, Defence: 60 });
    expect(kitSkills('pure-hally')).toMatchObject({ Attack: 61, Magic: 54, Prayer: 43, Defence: 1 });
    // Magic 54 is free under Attack 61 and Strength 99, and before Regicide the build keeps Magic 51 for its teleports.
    expect(combatLevel(kitSkills('pure-hally'))).toBe(combatLevel({ ...kitSkills('pure-hally'), Magic: 1 }));
    expect(levelsBeforeRoute('pure-hally')).toMatchObject({ Attack: 11, Magic: 53, Ranged: 99, Prayer: 43 });
    expect(levelsBeforeRoute('pure-hally').Magic!).toBeGreaterThanOrEqual(51);
    // The melee levels of a range tank add no combat level: Attack 74 and Strength 73 stay under Ranged 99.
    for (const name of ['range-tank', 'tank-range']) {
        expect(kitSkills(name)).toMatchObject({ Attack: 74, Strength: 73, Defence: name === 'tank-range' ? 99 : 60 });
        expect(combatLevel(kitSkills(name))).toBe(combatLevel({ ...kitSkills(name), Attack: 1, Strength: 1 }));
    }
    // Before the route a build has the levels that the rewards and the fights of its quests complete. The Fremennik
    // Trials give 70,310 XP in Attack, Strength and Defence, and their fights up to 35,000 XP in Strength.
    expect(levelsBeforeRoute('range-tank')).toMatchObject({ Attack: 68, Strength: 60, Defence: 7, Ranged: 99, Prayer: 43 });
    expect(levelsBeforeRoute('zerker')).toMatchObject({ Attack: 7, Strength: 99, Defence: 7 });
    expect(levelsBeforeRoute('pure-pray')).toEqual(kitSkills('pure-pray'));
    // A run keeps the build when its XP, on top of the levels before, ends at or under the kit.
    const before = levelsBeforeRoute('range-tank');
    expect(overBuild('range-tank', before, { attack: 70310, strength: 93410, defence: 70310, hitpoints: 77922 })).toBeNull();
    expect(overBuild('range-tank', before, { attack: 76710, strength: 70310, defence: 70310 })).toBe('Attack 75');
    expect(overBuild('range-tank', before, { defence: 76000 })).toBe('Defence 62');
    const keeps = questKeepsBuild('range-tank', before);
    expect(keeps('RESULT ok qp=3  xp=attack=70310,strength=93410,defence=70310,hitpoints=77922 at=1,1,0 ticks=3430 hpMin=1 eats=0 died=false milestones=a')).toBe(true);
    expect(keeps('RESULT ok qp=3  xp=attack=76710,strength=70310,defence=70310 at=1,1,0 ticks=3430 died=false milestones=a')).toBe(false);
    expect(keeps('RESULT ok qp=3  xp=attack=70310 at=1,1,0 ticks=3430 died=true milestones=a')).toBe(false);
    expect(keeps('RESULT fail died')).toBe(false);
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
