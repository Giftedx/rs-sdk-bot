import { expect, test } from 'bun:test';
import { itemBonuses, objBonuses, spellbook } from './gen-combat-data';

test('obj bonuses: each block with its name and its 13 bonuses; items with no bonus are left out', () => {
    const blocks = objBonuses('[rune_scimitar]\nname=Rune scimitar\nparam=stabattack,7\nparam=slashattack,45\r\nparam=crushattack,-2\nparam=strengthbonus,44\nparam=slash,1\n\n[logs]\nname=Logs\n');
    expect(blocks.map(b => b.debug)).toEqual(['rune_scimitar', 'logs']);
    expect(itemBonuses(blocks, new Map())).toEqual({ 'Rune scimitar': [7, 45, -2, 0, 0, 0, 0, 0, 0, 0, 44, 0, 0] });
});

test('spellbook: teleport spells with the Magic level and rune names, and the staffs by rune', () => {
    const names = new Map([['firerune', 'Fire rune'], ['lawrune', 'Law rune'], ['staff_of_fire', 'Staff of fire']]);
    expect(spellbook({ teleports: [
        { kind: 'spell', name: 'Varrock teleport', requires: [{ type: 'skill', skill: 'magic', level: 25 }], runes: [{ item: 'firerune', count: 1 }, { item: 'lawrune', count: 1 }] },
        { kind: 'jewellery', name: 'Amulet of glory' },
    ], staffs: [{ rune: 'firerune', staffs: ['staff_of_fire'] }] }, names)).toEqual({
        spells: [['Varrock teleport', 25, [['Fire rune', 1], ['Law rune', 1]]]],
        staffs: { 'Fire rune': ['Staff of fire'] },
    });
});
