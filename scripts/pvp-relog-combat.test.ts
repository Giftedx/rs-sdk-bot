import { expect, test } from 'bun:test';
import { componentId } from '../packages/core/src/logout';
import { needsPotionDose, parsePvpSkill, rankTanksForSwing, selectRangedKit, styleComponentFor } from './pvp-relog-combat';

test('parsePvpSkill normalizes supported combat skills', () => {
    expect(parsePvpSkill('atk')).toBe('Attack');
    expect(parsePvpSkill('Strength')).toBe('Strength');
    expect(parsePvpSkill('def')).toBe('Defence');
    expect(parsePvpSkill('ranged')).toBe('Ranged');
    expect(() => parsePvpSkill('magic')).toThrow(/unknown skill/);
});

test('selectRangedKit respects bow and arrow tier locks', () => {
    const allHeld = new Set([841, 843, 849, 853, 857, 861, 882, 884, 886, 888, 890, 892]);
    expect(selectRangedKit(1, allHeld).bow?.id).toBe(841);
    expect(selectRangedKit(1, allHeld).arrow?.id).toBe(884);
    expect(selectRangedKit(20, allHeld).bow?.id).toBe(849);
    expect(selectRangedKit(20, allHeld).arrow?.id).toBe(888);
    expect(selectRangedKit(40, allHeld).bow?.id).toBe(857);
    expect(selectRangedKit(40, allHeld).arrow?.id).toBe(892);
    expect(selectRangedKit(50, allHeld).bow?.id).toBe(861);
    expect(selectRangedKit(50, allHeld).arrow?.id).toBe(892);
});

test('styleComponentFor avoids clicks on default style 0 and selects heavysword styles for str/def', () => {
    expect(styleComponentFor('Attack', 1319)).toBeNull();
    expect(styleComponentFor('Ranged', 861)).toBeNull();
    expect(styleComponentFor('Strength', 1319)).toBe(componentId('combat_heavysword:heavy1'));
    expect(styleComponentFor('Defence', 1319)).toBe(componentId('combat_heavysword:heavy3'));
});

test('needsPotionDose triggers when boost drops below margin', () => {
    expect(needsPotionDose(83, 83, 'melee', 3)).toBe(true);
    expect(needsPotionDose(83, 100, 'melee', 3)).toBe(false);
    expect(needsPotionDose(90, 100, 'melee', 3)).toBe(true);
    expect(needsPotionDose(50, 59, 'ranged', 2)).toBe(false);
    expect(needsPotionDose(50, 50, 'ranged', 2)).toBe(true);
});

test('rankTanksForSwing round-robins healthy keep tanks and skips dead or banking tanks', () => {
    const localState = new Map([
        ['t1', { hp: 85, banking: false }],
        ['t2', { hp: 30, banking: false }],
        ['t3', { hp: 99, banking: true }],
        ['t4', { hp: 92, banking: false }],
    ]);
    const players = [
        { index: 1, name: 't1', x: 3155, z: 3924 },
        { index: 2, name: 't2', x: 3154, z: 3923 },
        { index: 3, name: 't3', x: 3155, z: 3924 },
        { index: 4, name: 't4', x: 3154, z: 3923 },
    ];
    const lastHit = new Map([['t1', 5], ['t4', 2]]);
    const ranked = rankTanksForSwing(players, ['t1', 't2', 't3', 't4'], { x: 3154, z: 3924 }, lastHit, localState);
    expect(ranked.map(p => p.name)).toEqual(['t4', 't1']);
});
