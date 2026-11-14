import { expect, test } from 'bun:test';
import { gangSummary, gangValid, packOf, pickAttacker, plannedPickups, PICKUP_ITEMS, pickRunner, startsAttack, type GangResult } from './pk-gang';
import { PROFILES, sparOptions } from './pk-spar';
import { combatLevel, itemId, kitCost, kitItems, kitOptions, kitRoute, KITS, kitSkills, kitSwitches, kitVarps } from './pk-kits';
import { benchCases, GANKER_POST } from './measure/aio-bench-cases';
import { wildernessLevel, type FightResult } from './pk';

const fight = (outcome: FightResult['outcome'], attacks = 10): FightResult =>
    ({ outcome, ticks: 200, dealt: 0, taken: 0, eaten: 0, attacks: { magic: 0, ranged: 0, melee: attacks }, freezes: 0, specs: 0 });
const result = (end: GangResult['end'], kills: number, fights: FightResult[], gang: FightResult[]): GangResult => ({ end, kills, ticks: 500, taken: 200, eaten: 9, specs: 4, refused: 0, foodLeft: 9, prayerLeft: 40, prayerDoses: 3, trips: 1, gangTrips: 0, prayerOut: -1, fights, gang });

test('our account fights the one of the gang that hit it last, else the nearest that lives', () => {
    const near = [{ name: 'Sugma', index: 5, distance: 3 }, { name: 'Ligma', index: 6, distance: 1 }, { name: 'Goondelf', index: 7, distance: 2 }, { name: 'Passerby', index: 8, distance: 0 }];
    const all = new Set(['sugma', 'ligma', 'goondelf']);
    expect(pickAttacker(near, all, 5)?.name).toBe('Sugma');
    expect(pickAttacker(near, all, null)?.name).toBe('Ligma');
    // A hit from a player that is not of the gang, or from one that is dead, names nobody.
    expect(pickAttacker(near, all, 8)?.name).toBe('Ligma');
    expect(pickAttacker(near, new Set(['goondelf', 'ligma']), 5)?.name).toBe('Ligma');
    expect(pickAttacker(near, new Set(), 5)).toBeNull();
    // An account that the game just refused is left out, unless every one was refused.
    expect(pickAttacker(near, all, null, new Set(['ligma']))?.name).toBe('Goondelf');
    expect(pickAttacker(near, all, null, new Set(['ligma', 'goondelf', 'sugma']))?.name).toBe('Ligma');
});

test('focusRunner picks the lowest bar at or under the fraction that the single-way rule lets through', () => {
    const near = [{ name: 'Sugma', index: 5 }, { name: 'Ligma', index: 6 }, { name: 'Goondelf', index: 7 }, { name: 'Passerby', index: 8 }];
    const all = new Set(['sugma', 'ligma', 'goondelf']);
    const bars = new Map<number, number | null>([[5, 0.8], [6, 0.3], [7, 0.2], [8, 0.05]]);
    const health = (i: number) => bars.get(i) ?? null;
    expect(pickRunner(near, all, 0.35, health, () => true)?.name).toBe('Goondelf');
    // The lowest one is locked out (another hit us in the last 8 ticks): the next lowest that is open.
    expect(pickRunner(near, all, 0.35, health, p => p.index !== 7)?.name).toBe('Ligma');
    // Over the fraction, no bar shown, or not of the gang: nobody.
    expect(pickRunner(near, all, 0.1, health, () => true)).toBeNull();
    expect(pickRunner(near, all, 0.35, () => null, () => true)).toBeNull();
});

test('a meeting counts when both sides attacked, and the summary counts each end', () => {
    const cleared = result('cleared', 3, [fight('kill'), fight('kill'), fight('kill')], [fight('died'), fight('died'), fight('died')]);
    const died = result('died', 1, [fight('kill'), fight('died')], [fight('died'), fight('kill'), fight('timeout')]);
    expect(gangValid(cleared)).toBe(true);
    expect(gangValid(died)).toBe(true);
    expect(gangValid(result('cap', 0, [fight('timeout', 0)], [fight('timeout')]))).toBe(false);
    expect(gangValid(result('cap', 0, [fight('timeout')], [fight('timeout', 0), fight('timeout', 0)]))).toBe(false);
    expect(gangValid(result('cap', 0, [fight('session ended')], [fight('timeout')]))).toBe(false);
    expect(gangSummary([cleared, died])).toEqual({ groups: 2, cleared: 1, died: 1, escaped: 0, away: 0, cap: 0, kills: 4, ticks: 500, killsEach: [3, 1] });
});

test('the ganker kit is what the three accounts wear, at combat 126, and no build of ours', () => {
    expect(combatLevel(kitSkills('ganker-dds'))).toBe(126);
    // Ligma and Sugma have Prayer 90 and Magic 28: one combat level less.
    expect(combatLevel({ ...kitSkills('ganker-dds'), Prayer: 90, Magic: 28 })).toBe(125);
    const { equipment, inventory } = kitItems('ganker-dds');
    expect(equipment.map(e => [e.id, e.slot])).toEqual([[itemId('blackwizhat'), 0], [itemId('monkrobetop'), 4], [itemId('monkrobebottom'), 7], [itemId('dragon_dagger_p'), 3]]);
    expect(inventory.length).toBeGreaterThan(0);
    expect(inventory.every(i => i.id === itemId('shark'))).toBe(true);
    expect(kitSwitches('ganker-dds')).toEqual({ melee: [itemId('dragon_dagger_p')] });
    expect(kitVarps('ganker-dds')).toEqual({ 147: 6, 300: 1000 });
    expect(kitRoute('ganker-dds')).toEqual({ quests: ['Lost City'], breaks: [] });
    expect(Object.keys(KITS).filter(k => KITS[k]!.rival).sort()).toEqual(['ganker-dds', 'ganker-dds-skull', 'ganker-max']);
    // The skulled copy: the same items, and the skull of the live gang (varp 78) for its loot.
    expect(kitItems('ganker-dds-skull')).toEqual(kitItems('ganker-dds'));
    expect(kitVarps('ganker-dds-skull')).toEqual({ 78: 2000, 147: 6, 300: 1000 });
    // The most the gang can be: the same worn items and levels, with potions and a full pack.
    expect(kitItems('ganker-max').equipment).toEqual(equipment);
    expect(kitSkills('ganker-max')).toEqual(kitSkills('ganker-dds'));
    expect(kitItems('ganker-max').inventory.length).toBe(27);
    expect(kitItems('ganker-max').inventory.filter(i => i.id === itemId('shark')).length).toBe(23);
});

test('the ganker profiles: melee only, a special from the first health bar, a shark at 79, no flick, and no protect prayer on ganker-bare', () => {
    const ganker = sparOptions('ganker', undefined, kitSwitches('ganker-dds'), 900, kitOptions('ganker-dds'));
    expect(ganker).toMatchObject({ rotation: ['melee'], eatAt: 79, prayerFlick: false, readOverheads: false, spec: { cost: 250, below: 1, style: 'melee' } });
    expect(ganker.overheadPrayer).toBeUndefined();
    expect(PROFILES['ganker-bare']).toEqual({ ...PROFILES.ganker!, overheadPrayer: false });
});

test('the ganker cases stand at the post: the spars in pairs, the gang on one tile with our account two tiles east', () => {
    const cases = benchCases();
    expect(wildernessLevel(GANKER_POST.z)).toBe(16);
    for (const [key, profile] of [['extra:spar-ganker-x12', 'ganker'], ['extra:spar-ganker-bare-x12', 'ganker-bare']] as const) {
        const c = cases.find(k => k.key === key)!;
        expect(c.scriptArgs).toContain(`SPAR_B_PROFILES=${profile}`);
        expect(c.scriptArgs.find(a => a.startsWith('SPAR_KITS='))).toBe(`SPAR_KITS=${Array.from({ length: 12 }, () => 'tribrid-snare:ganker-dds').join(',')}`);
        expect(c.presetConfig!.position).toEqual({ ...GANKER_POST, level: 0 });
        expect(c.companions![0]!.presetConfig).toMatchObject({ position: { x: GANKER_POST.x + 2, z: GANKER_POST.z, level: 0 }, skills: kitSkills('ganker-dds'), ...kitItems('ganker-dds') });
    }
    const g = cases.find(k => k.key === 'extra:gang-ganker-x4')!;
    expect(g.scriptArgs.slice(0, 6)).toEqual(['gang', '{bot:b}', '{bot:c}', '{bot:d}', '900', '{bot:e}']);
    expect(g.scriptArgs).toEqual(expect.arrayContaining(['SPAR_GANG=3', 'SPAR_KITS=tribrid-snare:ganker-dds', 'SPAR_B=ganker']));
    expect(g.companions!.map(c => c.suffix).join('')).toBe('bcdefghijklmnop');
    const ours = { position: { x: GANKER_POST.x + 2, z: GANKER_POST.z, level: 0 }, ...kitItems('tribrid-snare') }, theirs = { position: { ...GANKER_POST, level: 0 }, ...kitItems('ganker-dds') };
    expect(g.presetConfig).toMatchObject(ours);
    // Accounts in the order of the run: ours, three of the gang, ours, three of the gang, and so on.
    g.companions!.forEach((c, i) => expect(c.presetConfig).toMatchObject((i + 1) % 4 === 0 ? ours : theirs));
    expect(cases.find(k => k.key === 'extra:gang-ganker-bare-x4')!.scriptArgs).toContain('SPAR_B=ganker-bare');
    expect(cases.find(k => k.key === 'pvp:gang')!.scriptArgs).toContain('SPAR_B=ganker');
    // Each kit of ours meets the gang as seen and the gang at its most, and the way out is a case of its own.
    for (const kit of ['hybrid', 'gang-hunter']) expect(cases.find(k => k.key === `extra:gang-ganker-${kit}-x4`)!.presetConfig).toMatchObject(kitItems(kit));
    for (const kit of ['tribrid-snare', 'hybrid', 'gang-hunter']) {
        const max = cases.find(k => k.key === `extra:gang-ganker-max-${kit}-x4`)!;
        expect(max.scriptArgs).toEqual(expect.arrayContaining([`SPAR_KITS=${kit}:ganker-max`, 'SPAR_CAP=2400']));
        expect(max.companions![0]!.presetConfig).toMatchObject(kitItems('ganker-max'));
    }
    // The hunter kit: a super defence, a super antipoison, no prayer potion and no second glory (the one it wears is
    // its way out); its profile keeps the armour on, flicks each 2 ticks with no Protect Item, and has the way out.
    const hunter = kitItems('gang-hunter'), count = (name: string) => hunter.inventory.filter(i => i.id === itemId(name)).length;
    expect([count('amulet_of_glory_4'), count('4dose2defense'), count('4dose2antipoison'), count('4doseprayerrestore'), count('shark'), hunter.inventory.length]).toEqual([0, 1, 1, 0, 21, 27]);
    expect(hunter.equipment.filter(e => [0, 2, 4, 5, 7].includes(e.slot)).map(e => e.id).sort((x, y) => x - y)).toEqual(['mithril_full_helm', 'amulet_of_glory_4', 'adamant_platebody', 'mithril_kiteshield', 'mithril_platelegs'].map(itemId).sort((x, y) => x - y));
    expect(kitCost('gang-hunter')).toBeLessThan(75_000);
    expect(sparOptions('gang-hunter', undefined, kitSwitches('gang-hunter'), 900, kitOptions('gang-hunter'))).toMatchObject({ ...PROFILES.champion, adaptStyles: false, mixStyles: false, eatAt: 40, castArmour: 'keep', escapeAt: 60, escapeSpell: 1174, protectItem: false, flickEvery: 2, chase: false, spec: { below: 1 } });
    for (const key of ['extra:gang-ganker-gang-hunter-x4', 'extra:gang-ganker-max-gang-hunter-x4', 'extra:gang-ganker-escape-worn-x4']) expect(cases.find(k => k.key === key)!.scriptArgs).toContain('SPAR_A=gang-hunter');
    // The worn-glory case starts our account with 3 sharks.
    expect(cases.find(k => k.key === 'extra:gang-ganker-escape-worn-x4')!.presetConfig!.inventory!.filter(i => i.id === itemId('shark')).length).toBe(3);
    const escape = cases.find(k => k.key === 'extra:gang-ganker-escape-x4')!;
    expect(escape.scriptArgs).toContain('SPAR_A_OPTS={"escapeAt":60}');
    expect(escape.pass('RESULT ok gang groups=4 cleared=0 died=0 escaped=4 away=0 cap=0 kills=0')).toBe(true);
    expect(escape.pass('RESULT ok gang groups=4 cleared=1 died=0 escaped=3 away=0 cap=0 kills=3')).toBe(false);
});

test('an attack of the gang shows as a dagger animation in its first frame', () => {
    // human_ddagger_lunge 376, human_ddagger_hack 377 and puncture 1062 in the content pack; 378 is the block, 829 an eat.
    for (const anim of [376, 377, 1062]) expect(startsAttack({ primaryAnim: anim, primaryAnimCycle: 0, primaryAnimFrame: 0 })).toBe(true);
    for (const anim of [378, 829, -1]) expect(startsAttack({ primaryAnim: anim, primaryAnimCycle: 0, primaryAnimFrame: 0 })).toBe(false);
    // A later frame of the same animation is no new attack.
    expect(startsAttack({ primaryAnim: 376, primaryAnimCycle: 7, primaryAnimFrame: 3 })).toBe(false);
    expect(startsAttack(null)).toBe(false);
});

test('a bank trip takes the pack again: each item that is no food and no boost, the arrows, and a slot for each shark and boost', () => {
    const eat = [{ text: 'Eat' }], drink = [{ text: 'Drink' }], use = [{ text: 'Wield' }];
    const pack = packOf([
        { id: 861, count: 1, optionsWithIndex: use }, { id: 2436, count: 1, optionsWithIndex: drink }, { id: 2440, count: 1, optionsWithIndex: drink }, { id: 2444, count: 1, optionsWithIndex: drink },
        { id: 2442, count: 1, optionsWithIndex: drink }, { id: 2448, count: 1, optionsWithIndex: drink }, { id: 385, count: 1, optionsWithIndex: eat }, { id: 385, count: 1, optionsWithIndex: eat },
    ], [{ id: 886, count: 150, slot: 13 }, { id: 1231, count: 1, slot: 3 }]);
    // Bow, super defence, antipoison and the arrows are named; the three boosts and the two sharks are five slots.
    expect(pack).toEqual({ food: 5, items: [{ id: 861, count: 1 }, { id: 2442, count: 1 }, { id: 2448, count: 1 }, { id: 886, count: 150 }] });
});

test('the walk-in kit has no glory: an amulet of power, the runes of Camelot Teleport, and cases that go to the bank first', () => {
    const walker = kitItems('gang-walker'), count = (name: string) => walker.inventory.filter(i => i.id === itemId(name)).reduce((n, i) => n + i.count, 0);
    expect([count('lawrune'), count('airrune'), count('shark'), count('amulet_of_glory_4'), walker.inventory.length]).toEqual([2, 10, 19, 0, 27]);
    expect(walker.equipment.find(e => e.slot === 2)!.id).toBe(itemId('amulet_of_power'));
    expect(kitCost('gang-walker')).toBeLessThan(58_000);
    // Camelot Teleport is the way out of the profile for an account with no glory.
    expect(PROFILES['gang-hunter']!.escapeSpell).toBe(1174);
    const cases = benchCases();
    for (const [key, tile] of [['extra:gang-ganker-max-gang-walker-prepot-x2', GANKER_POST], ['extra:gang-ganker-max-gang-walker-prepot-near-x2', null]] as const) {
        const c = cases.find(k => k.key === key)!;
        expect(c.scriptArgs).toEqual(expect.arrayContaining(['SPAR_PRETRIP=1', 'SPAR_A=gang-hunter', 'SPAR_KITS=gang-walker:ganker-max']));
        expect(c.scriptArgs.some(a => a.startsWith('SPAR_TRIPS') || a.includes('escapeWalk'))).toBe(false);
        expect(c.presetConfig!.bank!.some(b => b.id === itemId('shark'))).toBe(true);
        if (tile) expect(c.presetConfig!.position).toEqual({ x: tile.x + 2, z: tile.z, level: 0 });
    }
});

test('the gang that holds its protect prayer is the gang with one more option, and has a case of its own', () => {
    expect(PROFILES['ganker-sticky']).toEqual({ ...PROFILES.ganker!, overheadHold: 20 });
    const c = benchCases().find(k => k.key === 'extra:gang-ganker-max-gang-walker-sticky-near-x2')!;
    expect(c.scriptArgs).toEqual(expect.arrayContaining(['SPAR_B=ganker-sticky', 'SPAR_A=gang-hunter', 'SPAR_PRETRIP=1']));
});

test('plannedPickups takes the wanted stacks within the radius, nearest first', () => {
    const g = (id: number, distance: number) => ({ id, count: 3, x: 3078 + distance, z: 3640, distance });
    const ids = new Set([884, ...PICKUP_ITEMS]);
    expect(plannedPickups([g(884, 5), g(526, 1), g(385, 1), g(1231, 2), g(884, 15)], ids, 12).map(p => [p.id, p.distance])).toEqual([[884, 5], [1231, 2], [385, 1]]);
    expect(plannedPickups([g(385, 1), g(1231, 2)], new Set(PICKUP_ITEMS), 12).map(p => p.id)).toEqual([1231, 385]);
    expect(PICKUP_ITEMS).toContain(itemId('dragon_dagger_p'));
});
