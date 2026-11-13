import { expect, test } from 'bun:test';
import { objParamRows, skillActions } from './gen-skill-actions';

test('skill actions give the XP of one action on this server: base XP times the XP rate', () => {
    const names = new Map([['logs', 'Logs'], ['oak_logs', 'Oak logs']]);
    const out = skillActions([
        { skill: 'woodcutting', row: 'oak_table', level: 15, xp: 37.5, outputs: ['oak_logs'] },
        { skill: 'woodcutting', row: 'tree_table', level: 1, xp: 25, outputs: ['logs'] },
        { skill: 'woodcutting', row: 'dead_table', level: 1, xp: 0 },
    ], names, 25);
    expect(out.woodcutting).toEqual([['Logs', 1, 625, [], ['Logs']], ['Oak logs', 15, 937.5, [], ['Oak logs']]]);
});

test('map variants of one rock give one action without the number', () => {
    const out = skillActions([1, 2, 3].map(n => ({ skill: 'mining', row: `limestone_rock${n}_table`, level: 10, xp: 26.5 })), new Map(), 1);
    expect(out.mining).toEqual([['Limestone rock', 10, 26.5, [], []]]);
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
    expect(skillActions(rows, new Map([['bones', 'Bones'], ['oak_logs', 'Oak logs']]))).toEqual({
        prayer: [['Bones', 1, 112.5, ['Bones'], []]],
        firemaking: [['Oak logs', 15, 1500, ['Oak logs'], []]],
    });
});
