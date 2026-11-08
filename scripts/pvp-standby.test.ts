import { expect, test } from 'bun:test';
import { shallowStandbyThreat } from './pvp-standby';

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
