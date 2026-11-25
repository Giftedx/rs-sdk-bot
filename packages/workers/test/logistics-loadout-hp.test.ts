import { expect, test } from 'bun:test';
import { loadoutHpFatal } from '../src/logistics/stage';

test('an owned loadout ends on a Hitpoints drop or no level, and goes on while Hitpoints regenerate', () => {
    // A member that came back from a fight at 38 of 99 regenerates during the loadout.
    expect(loadoutHpFatal(38, 38)).toBe(false);
    expect(loadoutHpFatal(38, 39)).toBe(false);
    expect(loadoutHpFatal(38, 99)).toBe(false);
    // Damage or poison at the bank.
    expect(loadoutHpFatal(38, 37)).toBe(true);
    expect(loadoutHpFatal(99, 98)).toBe(true);
    // No Hitpoints level at the start.
    expect(loadoutHpFatal(0, 0)).toBe(true);
});
