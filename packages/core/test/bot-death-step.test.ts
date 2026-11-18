import { expect, test } from 'bun:test';
import { deathStep, sessionDied, stopReasonOf } from '../src/bot';

const alive = (lifeId: number, respawnCount = 0) => ({ isDead: false, respawnCount, lifeId });
const dead = (lifeId: number, respawnCount = 0) => ({ isDead: true, respawnCount, lifeId });

test('by default a death is a stop', () => {
    const born = alive(1);
    expect(deathStep(born, alive(1), false, false)).toEqual({ died: false, born, seen: false, announce: false });
    expect(deathStep(born, dead(1), false, false).died).toBe(true);
    expect(deathStep(born, alive(2, 1), false, false).died).toBe(true);
});

test('with continueAfterDeath a death asks for one DEATH line, moves the baseline to the new life and is not a stop', () => {
    const born = alive(1);
    // Dead: announced once, no stop, the baseline stays until the account is alive in the new life.
    const first = deathStep(born, dead(1), true, false);
    expect(first).toEqual({ died: false, born, seen: true, announce: true });
    const still = deathStep(first.born, dead(1), true, first.seen);
    expect(still).toEqual({ died: false, born, seen: true, announce: false });
    // Alive in the new life: the baseline moves, and a later check sees no death.
    const respawned = deathStep(still.born, alive(2, 1), true, still.seen);
    expect(respawned).toEqual({ died: false, born: alive(2, 1), seen: false, announce: false });
    expect(sessionDied(respawned.born, alive(2, 1))).toBe(false);
    // A second death is announced again.
    expect(deathStep(respawned.born, dead(2, 1), true, respawned.seen)).toMatchObject({ died: false, seen: true, announce: true });
    // A respawn seen in one tick is announced and moves the baseline at once.
    expect(deathStep(alive(1), alive(2, 1), true, false)).toEqual({ died: false, born: alive(2, 1), seen: false, announce: true });
});

test('after a death that the caller handles, a stop file, a lost lease and a stall still end the session', () => {
    const base = { stallTicks: 3000, stopFile: () => false, leaseLost: () => false, stalled: () => false };
    // The tick of a death, with continueAfterDeath, is not died, so the other reasons are read.
    const afterDeath = (o: Partial<Parameters<typeof stopReasonOf>[0]>) => stopReasonOf({ ...base, died: false, stopTicks: 25, ...o });
    expect(afterDeath({})).toBeNull();
    expect(afterDeath({ stopFile: () => true })).toBe('stop file');
    expect(afterDeath({ leaseLost: () => true })).toBe('fleet controller lease unavailable');
    expect(afterDeath({ stopTicks: 50, stalled: () => true })).toBe('no progress: 3000 ticks without xp, items, dialog or a journey');
    // The checks run every 25 and 50 ticks only; a death is a stop in the default case.
    expect(afterDeath({ stopTicks: 24, stopFile: () => true })).toBeNull();
    expect(afterDeath({ stopTicks: 25, stalled: () => true })).toBeNull();
    expect(stopReasonOf({ ...base, died: true, stopTicks: 1 })).toBe('died');
});
