import { expect, test } from 'bun:test';
import { combatSpells, itemBonuses, objBonuses, spellbook } from './gen-combat-data';

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
        combat: [],
    });
});

test('combat spells: rows with a max hit, level, runes and the staff worn; Crumble Undead is left out', () => {
    const text = '[magic_spell_fire_blast]\ndata=name,Fire Blast\ndata=levelrequired,59\ndata=runesrequired,deathrune,1,firerune,5,airrune,4\ndata=maxhit,16\n\n'
        + '[magic_spell_crumble]\ndata=name,Crumble Undead\ndata=levelrequired,39\ndata=runesrequired,chaosrune,1,null,null\ndata=maxhit,15\n\n'
        + '[magic_spell_iban]\ndata=name,Iban Blast\ndata=levelrequired,50\ndata=runesrequired,deathrune,1,firerune,5,null,null\ndata=wornrequired,iban_staff\ndata=maxhit,25\n\n'
        + '[magic_spell_bind]\ndata=name,Bind\ndata=levelrequired,20\n';
    expect(combatSpells(text, new Map([['deathrune', 'Death rune'], ['firerune', 'Fire rune'], ['airrune', 'Air rune'], ['iban_staff', "Iban's staff"]]))).toEqual([
        ['Iban Blast', 50, 25, [['Death rune', 1], ['Fire rune', 5]], "Iban's staff"],
        ['Fire Blast', 59, 16, [['Death rune', 1], ['Fire rune', 5], ['Air rune', 4]], null],
    ]);
});
