import { expect, test } from 'bun:test';
import { planTrip } from '../src/trip';
import { createWorld, type PathLength } from '../src/world';
import type { Travel } from '../src/travel';

const boat: Travel = { id: 'b', kind: 'boat', name: 'A to B', from: { x: 0, z: 0, level: 0 }, to: { x: 1000, z: 0, level: 0 }, coins: 30, needs: [], runes: [], run: { how: 'npc', npc: 'Captain', op: 1, options: [], deck: true }, cost: 40 };
const pathLength: PathLength = (a, b, _bl, tol) => { const d = Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)); return d <= 50 ? Math.max(0, d - tol) : null; };
const world = createWorld({ transports: [], doors: [], travel: [boat], pathLength });
const from = { x: 10, z: 0, level: 0 }, to = { x: 1010, z: 0, level: 0 }, bank = { x: 20, z: 5, level: 0 };
const poor = { skills: {}, varps: {}, items: [], coins: 0 };

test('an account with coins only in the bank stops at the bank, then sails', () => {
    const p = planTrip(world, from, to, poor, { coins: 5000 }, [bank])!;
    expect(p.bank?.at).toEqual(bank);
    expect(p.bank?.coins).toBe(60);
    expect(p.bank?.then.map(l => l.kind)).toEqual(['walk', 'travel', 'walk']);
});

test('no bank coins and no fare held gives no trip', () => {
    expect(planTrip(world, from, to, poor, { coins: 0 }, [bank])).toBeNull();
    expect(planTrip(world, from, to, poor, undefined, [bank])).toBeNull();
});

test('an account holding fares goes direct', () => {
    const p = planTrip(world, from, to, { ...poor, coins: 500 }, { coins: 5000 }, [bank])!;
    expect(p.bank).toBeUndefined();
    expect(p.legs.map(l => l.kind)).toEqual(['walk', 'travel', 'walk']);
});

test('a teleport leaves from the route start when the account holds its runes', () => {
    const spell: Travel = { id: 's', kind: 'spell', name: 'Far teleport', from: null, to: { x: 2000, z: 0, level: 0 }, coins: 0, needs: [{ skill: 'magic', level: 25 }],
        runes: [{ item: 'lawrune', count: 1 }], run: { how: 'spell', component: 'magic:far' }, cost: 5 };
    const w = createWorld({ transports: [], doors: [], travel: [spell], pathLength });
    const goal = { x: 2010, z: 0, level: 0 };
    expect(w.route(from, goal, { ...poor, skills: { magic: 25 }, counts: {} }).ok).toBe(false);
    expect(w.route(from, goal, { ...poor, skills: { magic: 24 }, counts: { lawrune: 1 } }).ok).toBe(false);
    const r = w.route(from, goal, { ...poor, skills: { magic: 25 }, counts: { lawrune: 1 } });
    expect(r.ok && r.legs.map(l => l.kind)).toEqual(['travel', 'walk']);
});

// A world whose direct route costs 400 and whose route from the bank costs 50 only with a law rune.
function countingWorld() {
    const calls: string[] = [];
    const law = (a: { counts?: Record<string, number> }) => a.counts?.lawrune ?? 0;
    const w = {
        route: (a: { x: number }, b: { x: number }, acct: { counts?: Record<string, number> }) => {
            calls.push(`${a.x}>${b.x}`);
            const cost = a.x === from.x && b.x === to.x ? 400 : b.x === bank.x ? 5 : law(acct) > 0 ? 50 : 400;
            return { ok: true as const, legs: [], cost };
        },
        blockedDoors: () => [],
        routeGain: (a: { counts?: Record<string, number> }, b: { counts?: Record<string, number> }) => law(a) === 0 && law(b) > 0,
    };
    return { w, calls };
}

test('a bank that opens no travel or door and adds no fare coins is not searched', () => {
    const { w, calls } = countingWorld();
    const p = planTrip(w as any, from, to, { ...poor, coins: 5000 }, { coins: 9000, items: { bronzeaxe: 1, airrune: 500 } }, [bank])!;
    expect(p.cost).toBe(400);
    expect(p.bank).toBeUndefined();
    expect(calls).toEqual([`${from.x}>${to.x}`]);
});

test('a bank that opens a travel is still searched, and its stop wins when cheaper', () => {
    const { w, calls } = countingWorld();
    const p = planTrip(w as any, from, to, { ...poor, coins: 5000 }, { coins: 9000, items: { lawrune: 3 } }, [bank])!;
    expect(calls.length).toBe(3);
    expect(p.bank?.at).toEqual(bank);
    expect(p.cost).toBe(5 + 10 + 50);
});

test('routeGain is true only when the second account may take a travel or pass a key door that the first may not', () => {
    const spell: Travel = { id: 's', kind: 'spell', name: 'Far teleport', from: null, to: { x: 2000, z: 0, level: 0 }, coins: 0, needs: [{ skill: 'magic', level: 25 }],
        runes: [{ item: 'lawrune', count: 1 }, { item: 'airrune', count: 3 }], run: { how: 'spell', component: 'magic:far' }, cost: 5 };
    const w = createWorld({ transports: [], doors: [{ id: 1, loc: 'door', x: 5, z: 5, level: 0, kind: 'key', need: { item: 'elenakey' }, trigger: '', src: '' }], travel: [spell], pathLength });
    const mage = { ...poor, skills: { magic: 25 }, counts: { airrune: 3 } };
    // Air runes without a law rune open nothing.
    expect(w.routeGain!(mage, { ...mage, counts: { airrune: 500 } })).toBe(false);
    expect(w.routeGain!(mage, { ...mage, counts: { airrune: 3, lawrune: 1 } })).toBe(true);
    // A law rune does not help below the spell's Magic level.
    expect(w.routeGain!({ ...mage, skills: { magic: 1 } }, { ...mage, skills: { magic: 1 }, counts: { airrune: 3, lawrune: 1 } })).toBe(false);
    expect(w.routeGain!(poor, { ...poor, items: ['elenakey'] })).toBe(true);
    expect(w.routeGain!(poor, poor)).toBe(false);
});
