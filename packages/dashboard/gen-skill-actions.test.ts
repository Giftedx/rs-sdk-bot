import { expect, test } from 'bun:test';
import { skillActions } from './gen-skill-actions';

test('skill actions give the XP of one action on this server: base XP times the XP rate', () => {
    const names = new Map([['logs', 'Logs'], ['oak_logs', 'Oak logs']]);
    const out = skillActions([
        { skill: 'woodcutting', row: 'oak_table', level: 15, xp: 37.5, outputs: ['oak_logs'] },
        { skill: 'woodcutting', row: 'tree_table', level: 1, xp: 25, outputs: ['logs'] },
        { skill: 'woodcutting', row: 'dead_table', level: 1, xp: 0 },
    ], names, 25);
    expect(out.woodcutting).toEqual([['Logs', 1, 625, [], ['Logs']], ['Oak logs', 15, 937.5, [], ['Oak logs']]]);
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
