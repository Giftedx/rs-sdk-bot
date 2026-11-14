import { expect, test } from 'bun:test';
import { CAGED, combatLevel, dangerTiles, deadly, escapeTiles, liveHunters, loadHunters, parseHunter } from '../src/danger';
import { createWorld, routeFares, type PathLength } from '../src/world';
import type { Travel } from '../src/travel';

const wolf = parseHunter({ name: 'White wolf', combat: 25, spawns: [{ x: 100, z: 100, level: 0 }] }, 'wanderrange=3\nattack=20\nhuntrange=2\nhuntmode=cowardly')!;

test('a cowardly wolf kills an 11 HP account and ignores a combat-70 one', () => {
    expect(wolf.reach).toBe(5);
    expect(combatLevel({ hitpoints: 11 })).toBe(3);
    expect(deadly(wolf, 3, 11)).toBe(true);
    expect(deadly(wolf, combatLevel({ attack: 70, strength: 70, defence: 70, hitpoints: 70 }), 70)).toBe(false);
    const box = { minX: 0, maxX: 200, minZ: 0, maxZ: 200 };
    expect(dangerTiles({ skills: { hitpoints: 11 }, varps: {}, items: [] }, 0, box, [wolf]).length).toBe(13 * 13);
});

test('an account inside a danger square may walk out through that square only', () => {
    const weak = { skills: { hitpoints: 11 }, varps: {}, items: [] };
    expect(escapeTiles(weak, { x: 103, z: 98, level: 0 }, [wolf]).length).toBe(13 * 13);
    expect(escapeTiles(weak, { x: 120, z: 100, level: 0 }, [wolf])).toEqual([]);
    expect(escapeTiles(weak, { x: 103, z: 98, level: 1 }, [wolf])).toEqual([]);
});

test('a caged monster closes no ground: the Wizards\' Tower lesser demon', () => {
    const demon = loadHunters().filter(h => h.name === 'Lesser demon');
    expect(demon.length).toBeGreaterThan(0);
    for (const h of demon) for (const c of CAGED) expect(h.spawns.some(s => s.x === c.x && s.z === c.z && s.level === c.level)).toBe(false);
    const weak = { skills: { attack: 69, strength: 1, defence: 1, hitpoints: 37, magic: 99 }, varps: {}, items: [] };
    expect(dangerTiles(weak, 2, { minX: 3100, maxX: 3120, minZ: 3150, maxZ: 3170 }).length).toBe(0);
});

test('a monster without a hunt mode is no danger', () => {
    expect(parseHunter({ name: 'Man', combat: 2, spawns: [{ x: 1, z: 1, level: 0 }] }, 'wanderrange=5')).toBeNull();
});

test('one boat needs one fare; two boats need both fares', () => {
    const boat: Travel = { id: 'b', kind: 'boat', name: 'A to B', from: { x: 0, z: 0, level: 0 }, to: { x: 1000, z: 0, level: 0 }, coins: 30, needs: [], runes: [], run: { how: 'npc', npc: 'Captain', op: 1, options: [], deck: true }, cost: 40 };
    // Walks are free within 50 tiles; the two docks are 1000 tiles apart.
    const pathLength: PathLength = (a, b, _bl, tol) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) <= 50 ? Math.max(0, Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) - tol) : null;
    const w = createWorld({ transports: [], doors: [], travel: [boat], pathLength });
    const from = { x: 10, z: 0, level: 0 }, to = { x: 1010, z: 0, level: 0 };
    expect(w.route(from, to, { skills: {}, varps: {}, items: [], coins: 29 }).ok).toBe(false);
    const r = w.route(from, to, { skills: {}, varps: {}, items: [], coins: 30 });
    expect(r.ok && r.legs.map(l => l.kind)).toEqual(['walk', 'travel', 'walk']);
    const second: Travel = { ...boat, id: 'c', name: 'B to C', from: { x: 1000, z: 0, level: 0 }, to: { x: 2000, z: 0, level: 0 } };
    const two = createWorld({ transports: [], doors: [], travel: [boat, second], pathLength });
    expect(two.route(from, { x: 2010, z: 0, level: 0 }, { skills: {}, varps: {}, items: [], coins: 59 }).ok).toBe(false);
    expect(two.route(from, { x: 2010, z: 0, level: 0 }, { skills: {}, varps: {}, items: [], coins: 60 }).ok).toBe(true);
});

test('three paid crossings require their complete fare even when each retry edge is affordable', () => {
    const dock = (x: number) => ({ x, z: 0, level: 0 });
    const boats: Travel[] = [0, 1, 2].map(i => ({
        id: `boat-${i}`, kind: 'boat', name: `Dock ${i} to ${i + 1}`, from: dock(i * 1000), to: dock((i + 1) * 1000),
        coins: 30, needs: [], runes: [], run: { how: 'npc', npc: 'Captain', op: 1, options: [], deck: true }, cost: 40,
    }));
    const pathLength: PathLength = (a, b) => a.x === b.x && a.z === b.z ? 0 : null;
    const world = createWorld({ transports: [], doors: [], travel: boats, pathLength });
    for (const coins of [0, 29, 30, 59, 60, 89]) {
        expect(world.route(dock(0), dock(3000), { skills: {}, varps: {}, items: [], coins })).toEqual({ ok: false, reason: 'no_route' });
    }
    for (const coins of [90, 91]) {
        const route = world.route(dock(0), dock(3000), { skills: {}, varps: {}, items: [], coins });
        expect(route.ok).toBe(true);
        if (route.ok) {
            expect(routeFares(route.legs)).toBe(90);
            expect(route.legs.filter(l => l.kind === 'travel')).toHaveLength(3);
        }
    }
});

test('affordable fallback and cheaper walking routes keep their existing selection', () => {
    const tile = (x: number) => ({ x, z: 0, level: 0 });
    const boat = (id: string, from: number, to: number, coins: number, cost: number): Travel => ({
        id, kind: 'boat', name: id, from: tile(from), to: tile(to), coins, cost, needs: [], runes: [],
        run: { how: 'npc', npc: 'Captain', op: 1, options: [], deck: true },
    });
    const island: PathLength = (a, b) => a.x === b.x ? 0 : null;
    // The cheapest first-pass route costs 50 + 20 coins. The retry drops the 50-coin edge and keeps the affordable 30 + 30 route.
    const world = createWorld({ transports: [], doors: [], pathLength: island, travel: [
        boat('expensive-first', 0, 1000, 50, 40), boat('expensive-second', 1000, 2000, 20, 40),
        boat('affordable-first', 0, 3000, 30, 60), boat('affordable-second', 3000, 2000, 30, 60),
    ] });
    const account = { skills: {}, varps: {}, items: [], coins: 60 };
    const fallback = world.route(tile(0), tile(2000), account);
    expect(fallback.ok).toBe(true);
    if (fallback.ok) {
        expect(routeFares(fallback.legs)).toBe(60);
        expect(fallback.legs.filter(l => l.kind === 'travel').map(l => l.travel.id)).toEqual(['affordable-first', 'affordable-second']);
    }
    const walking = createWorld({ transports: [], doors: [], pathLength: (a, b) => Math.abs(a.x - b.x), travel: [boat('unneeded', 0, 20, 30, 40)] });
    const direct = walking.route(tile(0), tile(20), { ...account, coins: 0 });
    expect(direct.ok).toBe(true);
    if (direct.ok) { expect(routeFares(direct.legs)).toBe(0); expect(direct.cost).toBe(20); }
});

test('a live Karamja scorpion is a hunter to dodge for an HP 10 account, though not deadly', () => {
    const scorpion = loadHunters().find(h => h.name === 'Scorpion' && h.combat === 14)!;
    expect(scorpion.id).toBe(107);
    expect(scorpion.hunt).toBe(2);
    expect(deadly(scorpion, 3, 10)).toBe(false);
    const seen = [{ id: 107, name: 'Scorpion', x: 2869, z: 3175, tileX: 2868, tileZ: 3174, size: 2, hp: 17 }, { id: 557, name: 'Wydin', x: 3014, z: 3204 }];
    expect(liveHunters(seen, { skills: { hitpoints: 10 } })).toEqual([{ x: 2868, z: 3174, r: 5, name: 'Scorpion' }]);
    expect(liveHunters([{ ...seen[0]!, hp: 0 }], { skills: { hitpoints: 10 } })).toEqual([]);
    // A combat-46 account is more than twice the scorpion's level: a cowardly monster leaves it alone.
    expect(liveHunters(seen, { skills: { attack: 40, strength: 40, defence: 40, hitpoints: 40 } })).toEqual([]);
});

import { deadlyTo, meleeOnly, PROTECT_MELEE_LEVEL } from '../src/danger';
test('Protect from Melee opens the ground of melee-only hunters, not of ranged or magic ones', () => {
    const dog = parseHunter({ id: 99001, name: 'Guard dog', combat: 44, spawns: [{ x: 100, z: 100, level: 0 }] }, 'huntmode=cowardly')!;
    const archer = parseHunter({ id: 99002, name: 'Archer', combat: 44, spawns: [{ x: 100, z: 100, level: 0 }] }, 'huntmode=ranged')!;
    const styles = new Map<number, readonly string[]>([[99002, ['ranged']]]);
    expect(meleeOnly(dog, styles)).toBe(true);
    expect(meleeOnly(archer, styles)).toBe(false);
    expect(meleeOnly(wolf, styles)).toBe(false);
    const runner = { hitpoints: 10, magic: 59, prayer: 99 }, low = { hitpoints: 10, magic: 59, prayer: PROTECT_MELEE_LEVEL - 1 };
    expect(deadlyTo(dog, runner, styles)).toBe(false);
    expect(deadlyTo(dog, low, styles)).toBe(true);
    expect(deadlyTo(archer, runner, styles)).toBe(true);
    const saved = process.env.PRAYER_GUARD;
    process.env.PRAYER_GUARD = '0';
    try { expect(deadlyTo(dog, runner, styles)).toBe(true); } finally { if (saved === undefined) delete process.env.PRAYER_GUARD; else process.env.PRAYER_GUARD = saved; }
});
