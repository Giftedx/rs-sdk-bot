import { expect, test } from 'bun:test';
import { parseConfigs } from './config';
import { buildGear, paramDefaults, parsePvpSpecials, parseRequirements, parseStaffItems } from './gear';

test('parseRequirements reads the levels in the order the label names its skills, and the quest', () => {
    const req = parseRequirements([{ file: 'tier60.rs2', text: [
        '[opheld2,dragon_halberd] @levelrequire_regicide_quest_attack_strength(60, 30, last_slot);',
        '[opheld2,red_dragonhide_body] @levelrequire_ranged_and_defence(60, 40, last_slot);',
        '[opheld2,iban_staff] @levelrequire_iban_staff(last_slot);',
        '[opheld2,rune_platebody] @levelrequire_dragon_slayer_quest_defence(40, last_slot);',
    ].join('\n') }]);
    expect(req.get('dragon_halberd')).toMatchObject({ skills: { attack: 60, strength: 30 }, quest: 'Regicide', src: 'tier60.rs2:1' });
    expect(req.get('red_dragonhide_body')).toMatchObject({ skills: { ranged: 60, defence: 40 } });
    expect(req.get('iban_staff')).toMatchObject({ skills: { magic: 50, attack: 50 } });
    expect(req.get('rune_platebody')).toMatchObject({ skills: { defence: 40 }, quest: 'Dragon Slayer' });
});

test('buildGear takes every bonus param, the param defaults, the special and the staff mark', () => {
    const objs = parseConfigs([
        '[dragon_dagger]', 'name=Dragon dagger', 'wearpos=righthand', 'param=stabattack,40', 'param=strengthbonus,40', 'param=sa_energy,250',
        '[rune_platebody]', 'name=Rune platebody', 'wearpos=torso', 'wearpos2=arms', 'param=magicattack,-30', 'param=rangedefence,80',
        '[staff_dagger]', 'wearpos=righthand', 'param=stabattack,255',
        '[rune_arrow]', 'wearpos=quiver', 'param=rangebonus,49', 'param=levelrequire,40',
        '[shark]', 'name=Shark',
    ].join('\n'), 'x.obj');
    const defaults = paramDefaults(parseConfigs('[attackrate]\ntype=int\ndefault=4\n[sa_energy]\ndefault=1000', 'combat.param'));
    const pack = new Map([[1, 'dragon_dagger'], [2, 'rune_platebody'], [3, 'staff_dagger'], [4, 'rune_arrow'], [5, 'shark']]);
    const gear = buildGear(objs, pack, new Map(), parsePvpSpecials('case dragon_dagger, dragon_dagger_p : @x;'), defaults, parseStaffItems([{ text: 'if (staffmodlevel >= 3 & inv_getobj(worn, ^wearpos_rhand) = staff_dagger) {' }]));
    expect(gear.map(g => g.debugname)).toEqual(['dragon_dagger', 'rune_platebody', 'staff_dagger', 'rune_arrow']);
    expect(gear[0]).toMatchObject({ slot: 'righthand', attackRate: 4, special: { energy: 250, pvp: true }, bonuses: { stabAttack: 40, strength: 40, magicAttack: 0 } });
    expect(gear[1]).toMatchObject({ covers: ['arms'], bonuses: { magicAttack: -30, rangeDefence: 80 } });
    expect(gear[1]!.attackRate).toBeUndefined();
    expect(gear[2]!.staffOnly).toBe(true);
    expect(gear[3]).toMatchObject({ tier: 40, bonuses: { rangeStrength: 49 } });
});
