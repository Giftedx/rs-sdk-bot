import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { BONUSES, type Gear } from '../knowledge/src/gear';
import { combatSpells, itemBonuses, spellbook, weaponSpeeds } from './gen-combat-data';

test('bonus assets preserve the exact Black dagger and dragonhide variants from the gear catalogue', () => {
    const gear = JSON.parse(readFileSync(new URL('../../knowledge/gear.json', import.meta.url), 'utf8')) as Gear[];
    const out = itemBonuses(gear), shipped = JSON.parse(readFileSync(new URL('./client-assets/item-bonuses.json', import.meta.url), 'utf8'));
    for (const data of [out, shipped]) {
        expect(data[1217]).toEqual([10, 5, -4, 1, 0, 0, 0, 0, 1, 0, 7, 0, 0]);
        expect(data[746]).toEqual([5, 3, -4, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
        expect(data[1135].slice(3, 10)).toEqual([-15, 15, 40, 32, 45, 20, 40]);
        expect(data[2503].slice(3, 10)).toEqual([-15, 30, 55, 47, 60, 50, 55]);
        expect(data['Black dagger']).toBeUndefined();
        expect(data['Dragonhide body']).toBeUndefined();
    }
});

test('known zero bonuses and identical name aliases survive without choosing a differing variant', () => {
    const zero = Object.fromEntries(BONUSES.map(b => [b, 0])) as Gear['bonuses'];
    const out = itemBonuses([{ id: 1, name: 'Plain ring', bonuses: zero }, { id: 2, name: 'Plain ring', bonuses: { ...zero } },
        { id: 3, name: 'Different ring', bonuses: zero }, { id: 4, name: 'Different ring', bonuses: { ...zero, prayer: 1 } }]);
    expect(out[1]).toEqual(new Array(13).fill(0));
    expect(out['Plain ring']).toEqual(out[1]);
    expect(out['Different ring']).toBeUndefined();
    expect(out[4]![12]).toBe(1);
});

test('spellbook: teleport spells with the Magic level and rune names, and the staffs by rune', () => {
    const names = new Map([['firerune', 'Fire rune'], ['lawrune', 'Law rune'], ['staff_of_fire', 'Staff of fire']]);
    expect(spellbook({ teleports: [
        { kind: 'spell', name: 'Varrock teleport', requires: [{ type: 'skill', skill: 'magic', level: 25 }], runes: [{ item: 'firerune', count: 1 }, { item: 'lawrune', count: 1 }] },
        { kind: 'jewellery', name: 'Amulet of glory' },
    ], staffs: [{ rune: 'firerune', staffs: ['staff_of_fire'] }] }, names)).toEqual({
        spells: [['Varrock teleport', 25, [['Fire rune', 1], ['Law rune', 1]]]],
        staffs: { 'Fire rune': ['Staff of fire'] },
        combat: [],
    });
});

test('combat spells: rows with a max hit, level, runes and the staff worn; Crumble Undead is left out', () => {
    const text = '[magic_spell_fire_blast]\ndata=name,Fire Blast\ndata=levelrequired,59\ndata=runesrequired,deathrune,1,firerune,5,airrune,4\ndata=maxhit,16\n\n'
        + '[magic_spell_crumble]\ndata=name,Crumble Undead\ndata=levelrequired,39\ndata=runesrequired,chaosrune,1,null,null\ndata=maxhit,15\n\n'
        + '[magic_spell_iban]\ndata=name,Iban Blast\ndata=levelrequired,50\ndata=runesrequired,deathrune,1,firerune,5,null,null\ndata=wornrequired,iban_staff\ndata=maxhit,25\n\n'
        + '[magic_spell_bind]\ndata=name,Bind\ndata=levelrequired,20\n';
    expect(combatSpells(text, new Map([['deathrune', 'Death rune'], ['firerune', 'Fire rune'], ['airrune', 'Air rune'], ['iban_staff', "Iban's staff"]]))).toEqual([
        ['Iban Blast', 50, 25, [['Death rune', 1], ['Fire rune', 5]], "Iban's staff", 0],
        ['Fire Blast', 59, 16, [['Death rune', 1], ['Fire rune', 5], ['Air rune', 4]], null, 0],
    ]);
});

test('weapon speeds preserve exact IDs and omit ambiguous name aliases', () => {
    expect(weaponSpeeds([{ id: 1, name: 'Training blade', attackRate: 4 }, { id: 2, name: 'Training blade', attackRate: 7 },
        { id: 3, name: 'Scimitar', attackRate: 4 }, { id: 4, name: 'Ring' }])).toEqual({ 1: 4, 2: 7, 3: 4, Scimitar: 4 });
    const shipped = JSON.parse(readFileSync(new URL('./client-assets/weapon-speed.json', import.meta.url), 'utf8'));
    expect(shipped[1217]).toBe(4);
    expect(shipped[746]).toBe(4);
});
