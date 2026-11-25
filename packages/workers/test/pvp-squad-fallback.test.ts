import { describe, expect, test } from 'bun:test';
import { HELD_FOCUS, heldFocusOf, squadFallbackPlan } from '../src/pvp/squad';

// A member on a multi-way tile at the gang post (Wilderness 16) with a teleport in the pack.
const at = (o: { hp: number; enemyCount: number; allyCount: number; targetingMe: number; held?: boolean }) => squadFallbackPlan({
    z: 3640, hp: o.hp, maxHp: 99, foodCount: 10, enemyCount: o.enemyCount, allyCount: o.allyCount, targetingMe: o.targetingMe,
    inMulti: true, hasGlory: false, hasTeleport: true, ...(o.held ? { heldFocus: { ...HELD_FOCUS } } : {}),
});

describe('heldFocusOf', () => {
    test('the default is HELD_FOCUS, off gives the plain fractions, a pair sets both', () => {
        expect(heldFocusOf(undefined)).toEqual({ pile: 0.60, heavy: 0.50 });
        expect(heldFocusOf('')).toEqual({ pile: 0.60, heavy: 0.50 });
        expect(heldFocusOf('off')).toBeUndefined();
        expect(heldFocusOf('0.7,0.6')).toEqual({ pile: 0.7, heavy: 0.6 });
        for (const bad of ['0.7', '0.7,0', '1.2,0.5', '0.6,0.5,0.4', 'x,y']) expect(() => heldFocusOf(bad)).toThrow('SQUAD_HELD_FOCUS');
    });
});

describe('squadFallbackPlan with the held focus', () => {
    test('a member that the gang piles on stays while the squad holds its numbers (the fallbacks of live run 3)', () => {
        // 2 on this member at 72 HP, 4 of ours against 3: the plain heavy focus (0.76) sends it out.
        expect(at({ hp: 72, enemyCount: 3, allyCount: 3, targetingMe: 2 })).toBe('teleport');
        expect(at({ hp: 72, enemyCount: 3, allyCount: 3, targetingMe: 2, held: true })).toBe('hold');
        // 3 on this member at 84 HP, 4 of ours against 3: the plain focus pile (0.86) sends it out.
        expect(at({ hp: 84, enemyCount: 3, allyCount: 3, targetingMe: 3 })).toBe('teleport');
        expect(at({ hp: 84, enemyCount: 3, allyCount: 3, targetingMe: 3, held: true })).toBe('hold');
        // 3 of ours against 3 holds the numbers too.
        expect(at({ hp: 70, enemyCount: 3, allyCount: 2, targetingMe: 2, held: true })).toBe('hold');
    });
    test('the held fractions still send a member out under them', () => {
        expect(at({ hp: 59, enemyCount: 3, allyCount: 3, targetingMe: 3, held: true })).toBe('teleport');
        expect(at({ hp: 49, enemyCount: 3, allyCount: 3, targetingMe: 2, held: true })).toBe('teleport');
    });
    test('a member that walks back alone into a pile of 5 leaves at its first hits, and walks on at full HP', () => {
        // The bank trip's walk back stops on this rule (squad.ts returnStop). Seed 16 of run 45701974509: the member stood at 75 to
        // 90 HP in the pile for 130 ticks on its walk back and died. At 75 the rule sends it out.
        expect(at({ hp: 75, enemyCount: 5, allyCount: 0, targetingMe: 2, held: true })).toBe('teleport');
        expect(at({ hp: 87, enemyCount: 5, allyCount: 0, targetingMe: 0, held: true })).toBe('teleport');
        expect(at({ hp: 95, enemyCount: 5, allyCount: 0, targetingMe: 2, held: true })).toBe('hold');
    });
    test('an outnumbered squad keeps the plain fractions', () => {
        // 2 of ours against 3: no held fractions.
        expect(at({ hp: 75, enemyCount: 3, allyCount: 1, targetingMe: 2, held: true })).toBe('teleport');
        expect(at({ hp: 84, enemyCount: 3, allyCount: 1, targetingMe: 3, held: true })).toBe('teleport');
    });
});
