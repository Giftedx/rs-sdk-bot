import { expect, test } from 'bun:test';
import { fleetNames, pickTarget } from './pk-hunt';

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
