import { expect, test } from 'bun:test';
import { fleetNames, hitByPlayer, pickTarget, verdict } from './pk-hunt';

const me = { z: 3556, combatLevel: 126 };
const p = (index: number, name: string, combatLevel: number, distance: number, extra: object = {}) => ({ index, name, combatLevel, z: 3556, distance, ...extra });

test('the target is whoever is hitting us, even a fleet account', () => {
    const players = [p(1, 'Stranger', 126, 2), p(2, 'KnightRider', 126, 5)];
    expect(pickTarget(me, players, new Set(['knightrider']), 2)?.name).toBe('KnightRider');
});

test('otherwise the nearest attackable stranger who is not already fighting a player', () => {
    const players = [p(1, 'KnightRider', 126, 1), p(2, 'Busy', 126, 2, { inCombat: true, combatTargetType: 'player' }), p(3, 'Far', 125, 9), p(4, 'Near', 124, 4), p(5, 'Low', 100, 3)];
    expect(pickTarget(me, players, new Set(['knightrider']), null)?.name).toBe('Near');
    expect(pickTarget(me, [p(5, 'Low', 100, 3)], new Set(), null)).toBeUndefined();
    expect(pickTarget(me, [p(6, 'NpcFighter', 126, 2, { inCombat: true, combatTargetType: 'npc' })], new Set(), null)?.name).toBe('NpcFighter');
});

test('fleet names cover every side and the main account, in lower case', () => {
    const owners = new Map([['knightrider', { side: 'claude-cloud-4', server: 's' }], ['porksword', { side: 'cloud', server: 's' }]]);
    expect(fleetNames(owners as any)).toEqual(new Set(['knightrider', 'porksword', 'haggis']));
});

test('every seen player gets a verdict: fleet, out of range, busy or attackable', () => {
    const ours = new Set(['knightrider']);
    expect(verdict(me, p(1, 'KnightRider', 126, 1), ours)).toBe('fleet');
    expect(verdict(me, p(2, 'Low', 100, 1), ours)).toBe('out of range');
    expect(verdict(me, p(3, 'Busy', 126, 1, { inCombat: true, combatTargetType: 'player' }), ours)).toBe('busy');
    expect(verdict(me, p(4, 'Fair', 122, 1), ours)).toBe('attackable');
});

test("only a player's hit on us counts as an attack, not an NPC's damage reported as taken", () => {
    expect(hitByPlayer({ type: 'damage_taken', sourceType: 'other_player', targetType: 'player', sourceIndex: 2 })).toBe(true);
    expect(hitByPlayer({ type: 'damage_taken', sourceType: 'other_player', targetType: 'npc', sourceIndex: -1 })).toBe(false);
    expect(hitByPlayer({ type: 'damage_taken', sourceType: 'npc', targetType: 'player', sourceIndex: 5 })).toBe(false);
    expect(hitByPlayer({ type: 'damage_dealt', sourceType: 'player', targetType: 'other_player', sourceIndex: 0 })).toBe(false);
});
