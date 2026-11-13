import { expect, test } from 'bun:test';
import { inputCounts, objParamRows, skillActions } from './gen-skill-actions';

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

test('input counts come from the dbrow block of the row; each input is listed once a unit, with its item id', () => {
    const block = '[craft_dragonhide_body_black]\ntable=craft_leather_table\ndata=levelrequired,84\ndata=leather,dragon_leather_black,3\r\ndata=product,black_dragonhide_body\n';
    expect(inputCounts(['dragon_leather_black', 'thread'], block)).toEqual([3, 1]);
    const out = skillActions([{ skill: 'crafting', row: 'craft_dragonhide_body_black', level: 84, xp: 258, inputs: ['dragon_leather_black'], outputs: ['black_dragonhide_body'], counts: [3] }],
        new Map([['dragon_leather_black', 'Dragon leather'], ['black_dragonhide_body', "Black d'hide body"]]), 25, new Map([['dragon_leather_black', 2509]]));
    expect(out.crafting).toEqual([["Black d'hide body", 84, 6450, ['Dragon leather', 'Dragon leather', 'Dragon leather'], ["Black d'hide body"], [2509, 2509, 2509]]]);
});
