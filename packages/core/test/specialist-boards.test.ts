import { test, expect } from 'bun:test';
import { NAMES, pickName } from '../src/names';
import { RESERVED_ACCOUNTS, SPECIALIST_BOARDS } from '../src/specialist-boards';
import { SPECIALIST_BOARDS as LAUNCH_BOARDS } from '../src/specialist-launch';

test('the launch gate reads the same specialist registry', () => {
    expect(LAUNCH_BOARDS).toBe(SPECIALIST_BOARDS);
});

test('each specialist has its own skill board and a name from the name lists', () => {
    const names = Object.values(NAMES).flat().map(n => n.toLowerCase());
    const boards = Object.values(SPECIALIST_BOARDS).map(b => b.name);
    expect(new Set(boards).size).toBe(boards.length);
    for (const account of Object.keys(SPECIALIST_BOARDS)) {
        expect(account).toBe(account.toLowerCase());
        expect(names).toContain(account);
    }
});

test('the reserved list is the main account and every specialist', () => {
    expect([...RESERVED_ACCOUNTS].sort()).toEqual([
        'bigboner', 'bigswinger', 'castmyload', 'cutmyjewels', 'dipyourwick', 'fullblooded',
        'grindmyherb', 'haggis', 'halfinch', 'hiltsdeep', 'justthetip', 'lochnessrod', 'mineshafted',
        'nockandload', 'polevaulter', 'pouchstuffed', 'rocksolid', 'shaftshooter', 'steelrod',
    ]);
    expect(SPECIALIST_BOARDS.nockandload).toEqual({ name: 'Fletching', category: 10 });
});

test('an ordinary account never receives a specialist name', () => {
    const used = NAMES.combat.filter(n => !Object.hasOwn(SPECIALIST_BOARDS, n.toLowerCase()));
    expect(() => pickName('combat', used)).toThrow(/no names left/);
    expect(pickName('ranged', [])).not.toBe('Shaftshooter');
});
