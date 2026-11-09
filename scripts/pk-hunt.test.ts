import { test, expect } from 'bun:test';
import { canAttack, lap, pickTarget, wildLevel } from './pk-hunt';

test('wildLevel: 8 tiles per level from z 3520 inside x 2944-3392', () => {
    expect(wildLevel(3094, 3519)).toBe(0);
    expect(wildLevel(3094, 3520)).toBe(1);
    expect(wildLevel(3094, 3527)).toBe(1);
    expect(wildLevel(3094, 3528)).toBe(2);
    expect(wildLevel(3058, 3884)).toBe(46); // rune rocks, matches research
    expect(wildLevel(2943, 3700)).toBe(0);
});

test('canAttack uses the lower of the two Wilderness levels', () => {
    const me = { x: 3058, z: 3884, combat: 126 };
    expect(canAttack(me, { x: 3058, z: 3880, combatLevel: 95 })).toBe(true);   // gap 31, both ~level 45
    expect(canAttack(me, { x: 3094, z: 3530, combatLevel: 120 })).toBe(false); // target at level 2
    expect(canAttack({ ...me, z: 3500 }, { x: 3058, z: 3880, combatLevel: 126 })).toBe(false); // I am outside
});

test('pickTarget skips our accounts, fighters, unreachable and too deep; takes the closest', () => {
    const me = { x: 3050, z: 3700, combat: 100 };
    const base = { combatLevel: 100, inCombat: false, reachable: true };
    const players = [
        { ...base, name: 'Moneyshot', x: 3050, z: 3701, distance: 1 },
        { ...base, name: 'Busy', x: 3050, z: 3702, distance: 2, inCombat: true },
        { ...base, name: 'Walled', x: 3050, z: 3703, distance: 3, reachable: false },
        { ...base, name: 'Far', x: 3050, z: 3720, distance: 20 },
        { ...base, name: 'Near', x: 3050, z: 3710, distance: 10 },
        { ...base, name: 'Deep', x: 3050, z: 3950, distance: 5 },
    ];
    expect(pickTarget(me, players, new Set(['moneyshot']), 30)?.name).toBe('Near');
    expect(pickTarget(me, [], new Set(), 30)).toBeNull();
});

test('lap drops legs deeper than the limit', () => {
    expect(lap(56).length).toBe(12);
    expect(lap(10).every(p => wildLevel(p.x, p.z) <= 10)).toBe(true);
    expect(lap(10).length).toBeLessThan(12);
});
