import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseConfigs } from './config';
import { buildGear, paramDefaults, parsePvpSpecials, parseRequirements, parseStaffItems } from './gear';

test('parseRequirements reads the levels in the order the label names its skills, and the quest', () => {
    const req = parseRequirements([{ file: 'tier60.rs2', text: [
        '[opheld2,dragon_halberd] @levelrequire_regicide_quest_attack_strength(60, 30, last_slot);',
        '[opheld2,red_dragonhide_body] @levelrequire_ranged_and_defence(60, 40, last_slot);',
        '[opheld2,iban_staff] @levelrequire_iban_staff(last_slot);',
        '[opheld2,rune_platebody] @levelrequire_dragon_slayer_quest_defence(40, last_slot);',
        '[opheld2,viking_helmet_crush] @levelrequire_viking_quest_helm(45, last_slot);',
        '[opheld2,granite_shield] @levelrequire_defence_and_strength(50, last_slot);',
    ].join('\n') }]);
    expect(req.get('dragon_halberd')).toMatchObject({ skills: { attack: 60, strength: 30 }, quest: 'Regicide', src: 'tier60.rs2:1' });
    expect(req.get('red_dragonhide_body')).toMatchObject({ skills: { ranged: 60, defence: 40 } });
    expect(req.get('iban_staff')).toMatchObject({ skills: { magic: 50, attack: 50 } });
    expect(req.get('rune_platebody')).toMatchObject({ skills: { defence: 40 }, quest: 'Dragon Slayer' });
    expect(req.get('viking_helmet_crush')).toMatchObject({ skills: { defence: 45 }, quest: 'The Fremennik Trials' });
    expect(req.get('granite_shield')).toMatchObject({ skills: { defence: 50, strength: 50 } });
});

test('buildGear takes every bonus param, the param defaults, the special and the staff mark', () => {
    const objs = parseConfigs([
        '[dragon_dagger]', 'name=Dragon dagger', 'wearpos=righthand', 'param=stabattack,40', 'param=strengthbonus,40', 'param=sa_energy,250',
        '[dragon_battleaxe]', 'name=Dragon battleaxe', 'wearpos=righthand', 'param=specwep,^true', 'param=attackrate,6',
        '[rune_platebody]', 'name=Rune platebody', 'wearpos=torso', 'wearpos2=arms', 'param=magicattack,-30', 'param=rangedefence,80',
        '[staff_dagger]', 'wearpos=righthand', 'param=stabattack,255',
        '[rune_arrow]', 'wearpos=quiver', 'param=rangebonus,49', 'param=levelrequire,40',
        '[shark]', 'name=Shark',
    ].join('\n'), 'x.obj');
    const defaults = paramDefaults(parseConfigs('[attackrate]\ntype=int\ndefault=4\n[sa_energy]\ndefault=1000', 'combat.param'));
    const pack = new Map([[1, 'dragon_dagger'], [2, 'dragon_battleaxe'], [3, 'rune_platebody'], [4, 'staff_dagger'], [5, 'rune_arrow'], [6, 'shark']]);
    const gear = buildGear(objs, pack, new Map(), parsePvpSpecials('case dragon_dagger, dragon_dagger_p : @x;'), defaults, parseStaffItems([{ text: 'if (staffmodlevel >= 3 & inv_getobj(worn, ^wearpos_rhand) = staff_dagger) {' }]));
    expect(gear.map(g => g.debugname)).toEqual(['dragon_dagger', 'dragon_battleaxe', 'rune_platebody', 'staff_dagger', 'rune_arrow']);
    expect(gear[0]).toMatchObject({ slot: 'righthand', attackRate: 4, special: { energy: 250, pvp: true }, bonuses: { stabAttack: 40, strength: 40, magicAttack: 0 } });
    expect(gear[1]).toMatchObject({ slot: 'righthand', attackRate: 6, special: { energy: 1000, pvp: false } });
    expect(gear[2]).toMatchObject({ covers: ['arms'], bonuses: { magicAttack: -30, rangeDefence: 80 } });
    expect(gear[2]!.attackRate).toBeUndefined();
    expect(gear[3]!.staffOnly).toBe(true);
    expect(gear[4]).toMatchObject({ tier: 40, bonuses: { rangeStrength: 49 } });
});

test('parseRequirements reads the block form: a quest gate, then the levelrequire call on its own line', () => {
    const req = parseRequirements([{ file: 'tier30.rs2', text: [
        '[opheld2,adamant_halberd] @levelrequire_attack_and_strength(30, 15, last_slot);',
        '[opheld2,viking_sword]',
        'if (%viking < ^viking_complete) {',
        '    mes("You need to complete The Fremennik Trials first.");',
        '    return;',
        '}',
        '@levelrequire_attack(30, last_slot);',
        '',
        '[opheld2,viking_helmet]',
        'if (%viking < ^viking_complete) {',
        '    return;',
        '}',
        '@levelrequire_defence(30, last_slot); // quest requirement missing',
        '[opheld2,plain_block]',
        '@levelrequire_defence(40, last_slot);',
        '[opheld2,no_call]',
        'mes("nothing");',
    ].join('\n') }]);
    expect(req.get('viking_sword')).toEqual({ skills: { attack: 30 }, quest: 'The Fremennik Trials', src: 'tier30.rs2:7' });
    expect(req.get('viking_helmet')).toEqual({ skills: { defence: 30 }, quest: 'The Fremennik Trials', src: 'tier30.rs2:13' });
    expect(req.get('plain_block')).toEqual({ skills: { defence: 40 }, src: 'tier30.rs2:15' });
    expect(req.get('adamant_halberd')).toEqual({ skills: { attack: 30, strength: 15 }, src: 'tier30.rs2:1' });
    expect(req.has('no_call')).toBe(false);
});

test('the built gear holds the Fremennik blade, helm and shield wear rules of tier30.rs2', () => {
    const gear = JSON.parse(readFileSync(new URL('../../../knowledge/gear.json', import.meta.url), 'utf8')) as { id: number; requires: { skills: Record<string, number>; quest?: string; src?: string } }[];
    const rule = (id: number) => gear.find(g => g.id === id)!.requires;
    // levelrequire/scripts/tier30.rs2: the blade needs Attack 30, the helm and the shield Defence 30, each after the quest.
    expect(rule(3757)).toMatchObject({ skills: { attack: 30 }, quest: 'The Fremennik Trials', src: 'scripts/levelrequire/scripts/tier30.rs2:24' });
    expect(rule(3748)).toMatchObject({ skills: { defence: 30 }, quest: 'The Fremennik Trials', src: 'scripts/levelrequire/scripts/tier30.rs2:40' });
    expect(rule(3758)).toMatchObject({ skills: { defence: 30 }, quest: 'The Fremennik Trials', src: 'scripts/levelrequire/scripts/tier30.rs2:47' });
});
