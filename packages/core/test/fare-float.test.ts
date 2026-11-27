import { expect, test } from 'bun:test';
import { fareCrossings, loadTravel } from '../src/travel';
import { FARE_FLOAT, FARE_FLOAT_AFFORD, fareFloatTake, knownBanks, planTrip } from '../src/trip';
import { fareFloatNeed, walkPath, type PathDeps } from '../src/walk';
import { createWorld, rsPathLength, type Account, type Tile } from '../src/world';

const AL_KHARID_BANK: Tile = { x: 3269, z: 3167, level: 0 }, DRAYNOR_BANK: Tile = { x: 3092, z: 3243, level: 0 };
const LUMBRIDGE: Tile = { x: 3222, z: 3218, level: 0 }, VARROCK_WEST: Tile = { x: 3185, z: 3436, level: 0 };
const need = (from: Tile, to: Tile, held: number, bankCoins: number | undefined, coinSlot = true) =>
    fareFloatNeed({ from, to, held, bankCoins, coinSlot, travel: loadTravel(), crossings: fareCrossings(), banks: knownBanks() });

test('the float is a standing FARE_FLOAT for an account whose bank can afford it, else the fares twice', () => {
    expect(fareFloatTake(0, 5000, 10)).toBe(FARE_FLOAT);
    expect(fareFloatTake(120, 5000, 10)).toBe(FARE_FLOAT - 120);
    expect(fareFloatTake(0, FARE_FLOAT_AFFORD - 1, 10)).toBe(20);
    expect(fareFloatTake(0, 15, 10)).toBe(15);
    expect(fareFloatTake(400, 5000, 10)).toBe(0);
});

test('a walk from a bank through the toll gate with an empty pack takes the float there', () => {
    expect(need(AL_KHARID_BANK, LUMBRIDGE, 0, 5000)).toMatchObject({ bank: AL_KHARID_BANK, fare: 10, take: FARE_FLOAT });
    expect(need(DRAYNOR_BANK, AL_KHARID_BANK, 0, 5000)).toMatchObject({ bank: DRAYNOR_BANK, fare: 10, take: FARE_FLOAT });
    // A bank not seen yet: the float is asked for and the bank's answer decides.
    expect(need(AL_KHARID_BANK, LUMBRIDGE, 0, undefined)?.take).toBe(FARE_FLOAT);
    // The pack holds the fare, no bank holds coins, the pack has no slot, the walk starts away from a bank, or is short.
    expect(need(AL_KHARID_BANK, LUMBRIDGE, 10, 5000)).toBeNull();
    expect(need(AL_KHARID_BANK, LUMBRIDGE, 0, 5)).toBeNull();
    expect(need(AL_KHARID_BANK, LUMBRIDGE, 0, 5000, false)).toBeNull();
    expect(need(LUMBRIDGE, AL_KHARID_BANK, 0, 5000)).toBeNull();
    expect(need(AL_KHARID_BANK, { x: 3280, z: 3180, level: 0 }, 0, 5000)).toBeNull();
    // A walk with no fare near it (Draynor to Varrock) takes nothing out of the bank.
    expect(need(DRAYNOR_BANK, VARROCK_WEST, 0, 5000)).toBeNull();
});

test('a bank stop on the way leaves the standing float, not only the fares', async () => {
    const world = createWorld({ pathLength: await rsPathLength() });
    const acct: Account = { skills: { attack: 1, strength: 1, defence: 1, hitpoints: 10 }, varps: {}, items: [], counts: {}, coins: 0 };
    const trip = planTrip(world, AL_KHARID_BANK, LUMBRIDGE, acct, { coins: 5000 });
    expect(trip?.bank?.coins).toBe(FARE_FLOAT);
    // Through the gate after the bank stop: far under the 307-tick walk round the fence.
    expect(trip!.cost).toBeLessThan(160);
    const poor = planTrip(world, AL_KHARID_BANK, LUMBRIDGE, acct, { coins: 50 });
    expect(poor?.bank?.coins).toBe(20);
}, 120_000);

test('walkPath runs its prepare step before it plans', async () => {
    const order: string[] = [];
    const deps: PathDeps = {
        pos: () => ({ x: 3000, z: 3200, level: 0 }),
        onTick: () => () => {},
        walk: () => {}, interactLoc: () => {}, locs: () => [],
        plan: () => { order.push('plan'); return []; },
        prepare: async goal => { order.push(`prepare ${goal.x},${goal.z},${goal.level}`); },
    };
    await walkPath(deps, [{ x: 3001, z: 3200, tol: 2 }]);
    expect(order).toEqual(['prepare 3001,3200,0', 'plan']);
});
