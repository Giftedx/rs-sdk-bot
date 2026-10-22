import { test, expect } from 'bun:test';
import { planSkill, type Method } from '../src/plan';
import { xpForLevel } from '../src/curve';

const A: Method = { id: 'trees', skill: 'woodcutting', level: 1, xpPerHour: 10_000, source: 'estimated' };
const B: Method = { id: 'oaks', skill: 'woodcutting', level: 15, xpPerHour: 40_000, source: 'estimated' };
const C: Method = { id: 'slow_willows', skill: 'woodcutting', level: 30, xpPerHour: 5_000, source: 'estimated' };

test('uses the fastest unlocked method and switches when a faster one unlocks', () => {
    const p = planSkill({ skill: 'woodcutting', fromXp: 0, toLevel: 31, methods: [A, B, C] });
    expect(p.segments.map(s => [s.method, s.fromLevel, s.toLevel])).toEqual([['trees', 1, 15], ['oaks', 15, 31]]);
    const hours = xpForLevel(15) / 10_000 + (xpForLevel(31) - xpForLevel(15)) / 40_000;
    expect(p.hours).toBeCloseTo(hours, 6);
});

test('starts from the current XP, not from level 1', () => {
    const p = planSkill({ skill: 'woodcutting', fromXp: xpForLevel(20), toLevel: 21, methods: [A, B] });
    expect(p.segments).toHaveLength(1);
    expect(p.segments[0]).toMatchObject({ method: 'oaks', fromLevel: 20, toLevel: 21 });
});

test('a level with no unlocked method makes the plan impossible, with the level named', () => {
    const p = planSkill({ skill: 'woodcutting', fromXp: 0, toLevel: 20, methods: [B] });
    expect(p).toMatchObject({ ok: false, blockedAt: 1 });
});

test('methods of other skills are ignored', () => {
    const p = planSkill({ skill: 'woodcutting', fromXp: 0, toLevel: 2, methods: [{ ...B, skill: 'mining', level: 1, xpPerHour: 1e9 }, A] });
    expect(p.segments.map(s => s.method)).toEqual(['trees']);
});
