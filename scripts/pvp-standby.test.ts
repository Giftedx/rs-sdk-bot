import { expect, test } from 'bun:test';
import { combatTwelveStandbyProfile, shallowStandbyThreat } from './pvp-standby';

test('shallow standby blocks adjacent combat brackets and unknown levels', () => {
    const tile = { x: 3135, z: 3523, level: 0 };
    const nearby = { x: 3135, z: 3521 };
    expect(shallowStandbyThreat({ ...nearby, combatLevel: 5 }, tile, 6)).toBe(true);
    expect(shallowStandbyThreat({ ...nearby, combatLevel: 7 }, tile, 6)).toBe(true);
    expect(shallowStandbyThreat({ ...nearby, combatLevel: 20 }, tile, 6)).toBe(false);
    expect(shallowStandbyThreat({ ...nearby, combatLevel: 9 }, tile, 6)).toBe(false);
    expect(shallowStandbyThreat({ ...nearby, combatLevel: 0 }, tile, 6)).toBe(true);
    expect(shallowStandbyThreat({ ...nearby, z: 3519, combatLevel: 6 }, tile, 6)).toBe(false);
});


test('combat 12 stages only the trained Ranged and full health builds', () => {
    const profile = combatTwelveStandbyProfile(14, 17);
    expect(profile?.tile).toEqual({ x: 3134, z: 3525, level: 0 });
    expect(profile?.magic).toBe(13);
    expect(combatTwelveStandbyProfile(15, 18)?.ranged).toBe(18);
    expect(combatTwelveStandbyProfile(13, 17)).toBeUndefined();
    expect(combatTwelveStandbyProfile(15, 16)).toBeUndefined();
});
