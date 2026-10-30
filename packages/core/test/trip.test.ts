import { expect, test } from 'bun:test';
import { planTrip } from '../src/trip';
import { createWorld, type Boat, type PathLength } from '../src/world';

const boat: Boat = { name: 'A to B', npc: '^captain$', choices: [], from: { x: 0, z: 0, level: 0 }, to: { x: 1000, z: 0, level: 0 }, deck: { x: 1000, z: 5 }, fare: 30 };
const pathLength: PathLength = (a, b, _bl, tol) => { const d = Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)); return d <= 50 ? Math.max(0, d - tol) : null; };
const world = createWorld({ transports: [], doors: [], boats: [boat], pathLength });
const from = { x: 10, z: 0, level: 0 }, to = { x: 1010, z: 0, level: 0 }, bank = { x: 20, z: 5, level: 0 };
const poor = { skills: {}, varps: {}, items: [], coins: 0 };

test('an account with coins only in the bank stops at the bank, then sails', () => {
    const p = planTrip(world, from, to, poor, { coins: 5000 }, [bank])!;
    expect(p.bank?.at).toEqual(bank);
    expect(p.bank?.coins).toBe(1000);
    expect(p.bank?.then.map(l => l.kind)).toEqual(['walk', 'boat', 'walk']);
});

test('no bank coins and no fare held gives no trip', () => {
    expect(planTrip(world, from, to, poor, { coins: 0 }, [bank])).toBeNull();
    expect(planTrip(world, from, to, poor, undefined, [bank])).toBeNull();
});

test('an account holding fares goes direct', () => {
    const p = planTrip(world, from, to, { ...poor, coins: 500 }, { coins: 5000 }, [bank])!;
    expect(p.bank).toBeUndefined();
    expect(p.legs.map(l => l.kind)).toEqual(['walk', 'boat', 'walk']);
});
