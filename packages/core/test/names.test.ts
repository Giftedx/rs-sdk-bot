import { test, expect } from 'bun:test';
import { NAMES, pickName } from '../src/names';

test('every name fits the server rule: 1-12 letters or digits', () => {
    for (const list of Object.values(NAMES)) for (const n of list) expect(n).toMatch(/^[A-Za-z0-9]{1,12}$/);
});

test('no name appears twice across roles', () => {
    const all = Object.values(NAMES).flat().map(n => n.toLowerCase());
    expect(new Set(all).size).toBe(all.length);
});

test('pickName gives the first unused name for the role, ignoring case', () => {
    const first = NAMES.thieving[0]!;
    expect(pickName('thieving', [])).toBe(first);
    expect(pickName('thieving', [first.toLowerCase()])).toBe(NAMES.thieving[1]);
});

test('pickName throws when a role has no names left', () => {
    expect(() => pickName('thieving', NAMES.thieving)).toThrow(/no names left/);
});
