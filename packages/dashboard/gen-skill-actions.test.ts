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
