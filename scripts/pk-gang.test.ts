import { expect, test } from 'bun:test';
import { gangSummary, gangValid, pickAttacker, startsAttack, type GangResult } from './pk-gang';
import { PROFILES, sparOptions } from './pk-spar';
import { combatLevel, itemId, kitItems, kitOptions, kitRoute, KITS, kitSkills, kitSwitches, kitVarps } from './pk-kits';
import { benchCases, GANKER_POST } from './measure/aio-bench-cases';
import { wildernessLevel, type FightResult } from './pk';

const fight = (outcome: FightResult['outcome'], attacks = 10): FightResult =>
    ({ outcome, ticks: 200, dealt: 0, taken: 0, eaten: 0, attacks: { magic: 0, ranged: 0, melee: attacks }, freezes: 0, specs: 0 });
const result = (end: GangResult['end'], kills: number, fights: FightResult[], gang: FightResult[]): GangResult => ({ end, kills, ticks: 500, taken: 200, eaten: 9, specs: 4, refused: 0, foodLeft: 9, prayerLeft: 40, fights, gang });

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
    expect(Object.keys(KITS).filter(k => KITS[k]!.rival).sort()).toEqual(['ganker-dds', 'ganker-max']);
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
    // The hunter kit: the glory is in its pack (the fight loop rubs a glory that it carries), with a super defence,
    // three prayer potions and the dragon helm and legs; its profile keeps the armour on and has the way out.
    const hunter = kitItems('gang-hunter'), count = (name: string) => hunter.inventory.filter(i => i.id === itemId(name)).length;
    expect([count('amulet_of_glory_4'), count('4dose2defense'), count('4doseprayerrestore'), count('shark'), hunter.inventory.length]).toEqual([1, 1, 3, 18, 27]);
    expect(hunter.equipment.filter(e => e.slot === 0 || e.slot === 7).map(e => e.id)).toEqual([itemId('dragon_med_helm'), itemId('dragon_platelegs')]);
    expect(sparOptions('gang-hunter', undefined, kitSwitches('gang-hunter'), 900, kitOptions('gang-hunter'))).toMatchObject({ ...PROFILES.champion, castArmour: 'keep', escapeAt: 60 });
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
