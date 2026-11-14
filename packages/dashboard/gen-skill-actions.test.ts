import { expect, test } from 'bun:test';
import { contentRows, fishingRows, inputCounts, objParamRows, skillActions } from './gen-skill-actions';

test('skill actions give the XP of one action on this server: base XP times the XP rate', () => {
    const names = new Map([['logs', 'Logs'], ['oak_logs', 'Oak logs']]);
    const out = skillActions([
        { skill: 'woodcutting', row: 'oak_table', level: 15, xp: 37.5, outputs: ['oak_logs'] },
        { skill: 'woodcutting', row: 'tree_table', level: 1, xp: 25, outputs: ['logs'] },
        { skill: 'woodcutting', row: 'dead_table', level: 1, xp: 0 },
    ], names, 25);
    expect(out.woodcutting).toEqual([['Logs', 1, 625, [], ['Logs'], []], ['Oak logs', 15, 937.5, [], ['Oak logs'], []]]);
});

test('map variants of one rock give one action without the number', () => {
    const out = skillActions([1, 2, 3].map(n => ({ skill: 'mining', row: `limestone_rock${n}_table`, level: 10, xp: 26.5 })), new Map(), 1);
    expect(out.mining).toEqual([['Limestone rock', 10, 26.5, [], [], []]]);
});

test('an action is named after its table row when several rows of the skill give the same first output', () => {
    const out = skillActions([
        { skill: 'thieving', row: 'pickpocket_man', level: 1, xp: 8, outputs: ['coins'] },
        { skill: 'thieving', row: 'pickpocket_farmer', level: 10, xp: 14.5, outputs: ['coins'] },
        { skill: 'thieving', row: 'cake_stall', level: 5, xp: 16, outputs: ['cake'] },
    ], new Map([['coins', 'Coins'], ['cake', 'Cake']]), 1);
    expect(out.thieving!.map(a => a[0])).toEqual(['Pickpocket man', 'Cake', 'Pickpocket farmer']);
    expect(out.thieving![0]![4]).toEqual(['Coins']);
});

test('item params give Prayer and Firemaking actions: bone_exp and productexp in tenths, tradeable items only', () => {
    const files: [string, string][] = [
        ['scripts/skill_prayer/configs/bones.obj', '[bones]\nname=Bones\nparam=bone_exp,45\n\n[mm_skeleton_bones]\nname=Bones\nparam=bone_exp,30\n'],
        ['scripts/skill_firemaking/configs/firemaking.obj', '[oak_logs]\nname=Oak logs\nparam=levelrequire,15\nparam=productexp,600\n'],
        ['scripts/tutorial/configs/tutorial.obj', '[tut_bones]\nparam=bone_exp,45\n'],
    ];
    const rows = objParamRows(files, debug => debug !== 'mm_skeleton_bones');
    expect(skillActions(rows, new Map([['bones', 'Bones'], ['oak_logs', 'Oak logs']]), 25, new Map([['bones', 526], ['oak_logs', 1521]]))).toEqual({
        prayer: [['Bones', 1, 112.5, ['Bones'], [], [526]]],
        firemaking: [['Oak logs', 15, 1500, ['Oak logs'], [], [1521]]],
    });
});

test('Smithing and Herblore actions from the smelting and potion structs, the smithing dbrow and the herb params', () => {
    const rows = contentRows({
        smelting: '[smelting_steel_bar]\nparam=product,steel_bar\nparam=levelrequired,30\nparam=productexp,175\nparam=ingredient,iron_ore\nparam=bar_count,1\nparam=ingredient_secondary,coal\nparam=ingredient_secondary_count,2\n',
        smithingStruct: '[smithing_rune_bar]\nparam=xpperbar,750\nparam=namedobj,runite_bar\n',
        smithingRows: '[rune_platebody]\ntable=smithing\ndata=product,rune_platebody\ndata=product_amount,1\ndata=levelrequired,99\ndata=bar,runite_bar\ndata=bar_amount,5\n',
        brewing: '[unf_guam_potion]\nparam=brew_potion_ingredient,guam_leaf\nparam=brew_potion_solvent,vial_water\nparam=brew_potion_mixture,guamvial\n\n[attack_potion]\nparam=brew_potion_ingredient,eye_of_newt\nparam=brew_potion_solvent,guamvial\nparam=brew_potion_mixture,attack_potion3\nparam=brew_potion_exp,250\n',
        herbs: '[guam_leaf]\nname=Guam leaf\nparam=identified_herb_exp,25\n\n[marentill]\nparam=identified_herb_level,5\nparam=identified_herb_exp,38\n',
        identify: '[opheld1,unidentified_guam]\n~attempt_identify_herb(guam_leaf, last_slot());\n',
        params: '[identified_herb_level]\ntype=int\ndefault=3\n\n[identified_herb_exp]\ntype=int\ndefault=0\n\n[brew_potion_level]\ntype=int\ndefault=3\n\n[brew_potion_solvent]\ntype=namedobj\ndefault=null\n',
    });
    const names = new Map([['steel_bar', 'Steel bar'], ['iron_ore', 'Iron ore'], ['coal', 'Coal'], ['runite_bar', 'Runite bar'], ['rune_platebody', 'Rune platebody'],
        ['eye_of_newt', 'Eye of newt'], ['guamvial', 'Unfinished potion'], ['attack_potion3', 'Attack potion(3)'], ['guam_leaf', 'Guam leaf'], ['marentill', 'Marrentill'], ['unidentified_guam', 'Herb']]);
    const ids = new Map([['iron_ore', 440], ['coal', 453], ['runite_bar', 2363], ['eye_of_newt', 221], ['guamvial', 91], ['unidentified_guam', 199]]);
    expect(skillActions(rows, names, 25, ids)).toEqual({
        smithing: [['Steel bar', 30, 437.5, ['Iron ore', 'Coal', 'Coal'], ['Steel bar'], [440, 453, 453]], ['Rune platebody', 99, 9375, ['Runite bar', 'Runite bar', 'Runite bar', 'Runite bar', 'Runite bar'], ['Rune platebody'], [2363, 2363, 2363, 2363, 2363]]],
        // The unfinished potion gives no XP. Identifying takes the unidentified herb that identify.rs2 pairs (all named
        // "Herb", told apart by id) at the param default level 3; a herb with no pairing has no input.
        // Attack potion has no brew_potion_level: it takes the param default 3.
        herblore: [['Guam leaf', 3, 62.5, ['Herb'], ['Guam leaf'], [199]], ['Attack potion(3)', 3, 625, ['Eye of newt', 'Unfinished potion'], ['Attack potion(3)'], [221, 91]], ['Marrentill', 5, 95, [], ['Marrentill'], []]],
    });
});

test('input counts come from the dbrow block of the row; each input is listed once a unit, with its item id', () => {
    const block = '[craft_dragonhide_body_black]\ntable=craft_leather_table\ndata=levelrequired,84\ndata=leather,dragon_leather_black,3\r\ndata=product,black_dragonhide_body\n';
    expect(inputCounts(['dragon_leather_black', 'thread'], block)).toEqual([3, 1]);
    const out = skillActions([{ skill: 'crafting', row: 'craft_dragonhide_body_black', level: 84, xp: 258, inputs: ['dragon_leather_black'], outputs: ['black_dragonhide_body'], counts: [3] }],
        new Map([['dragon_leather_black', 'Dragon leather'], ['black_dragonhide_body', "Black d'hide body"]]), 25, new Map([['dragon_leather_black', 2509]]));
    expect(out.crafting).toEqual([["Black d'hide body", 84, 6450, ['Dragon leather', 'Dragon leather', 'Dragon leather'], ["Black d'hide body"], [2509, 2509, 2509]]]);
});

test('Fishing actions from the spot scripts: the gate level, the second fish at its own level, and the bait', () => {
    const spot = '[label,fish_trout_salmon]\nif (stat(fishing) < 20) {\n    return;\n}\nif (%action_delay = map_clock) {\n    if (stat(fishing) >= 30) {\n        ~fish_roll(raw_trout, raw_salmon, fly_fishing_rod, feather);\n    } else {\n        ~fish_roll(raw_trout, null, fly_fishing_rod, feather);\n    }\n}\n\n[label,fish_shrimps]\n~fish_roll(raw_shrimp, null, net, null);\n';
    const obj = '[raw_trout]\nparam=fishing_struct,fs_trout\n\n[raw_salmon]\nparam=fishing_struct,fs_salmon\n\n[raw_shrimp]\nparam=fishing_struct,fs_shrimp\n';
    const struct = '[fs_trout]\nparam=productexp,500\n\n[fs_salmon]\nparam=productexp,700\n\n[fs_shrimp]\nparam=productexp,100\n';
    const names = new Map([['raw_trout', 'Raw trout'], ['raw_salmon', 'Raw salmon'], ['raw_shrimp', 'Raw shrimps'], ['feather', 'Feather']]);
    expect(skillActions(fishingRows([spot], obj, struct), names, 25)).toEqual({ fishing: [
        ['Raw shrimps', 1, 250, [], ['Raw shrimps'], []],
        ['Raw trout', 20, 1250, ['Feather'], ['Raw trout'], [0]],
        ['Raw salmon', 30, 1750, ['Feather'], ['Raw salmon'], [0]],
    ] });
});
