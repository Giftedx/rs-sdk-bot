import { expect, test } from 'bun:test';
import { runecraftTable, runesPerEssence } from './gen-runecraft';

test('the runecraft table: level and multiplier by rune name, 0 when a rune has no multiplier', () => {
    const dbrow = '[runecraft_air]\ntable=runecraft_table\ndata=level,1\ndata=rune,airrune\ndata=multiplier,11\n\n[runecraft_law]\ntable=runecraft_table\ndata=level,54\ndata=rune,lawrune\n';
    expect(runecraftTable(dbrow, new Map([['airrune', 'Air rune'], ['lawrune', 'Law rune']]))).toEqual({ 'Air rune': [1, 11], 'Law rune': [54, 0] });
});

test('runes per essence: floor(level / multiplier) + 1, and 1 with no multiplier', () => {
    expect(runesPerEssence(10, 11)).toBe(1);
    expect(runesPerEssence(11, 11)).toBe(2);
    expect(runesPerEssence(99, 11)).toBe(10);
    expect(runesPerEssence(91, 91)).toBe(2);
    expect(runesPerEssence(99, 0)).toBe(1);
});
