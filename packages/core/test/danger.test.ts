import { expect, test } from 'bun:test';
import { combatLevel, dangerTiles, deadly, escapeTiles, parseHunter } from '../src/danger';
import { createWorld, type PathLength } from '../src/world';
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

test('a monster without a hunt mode is no danger', () => {
    expect(parseHunter({ name: 'Man', combat: 2, spawns: [{ x: 1, z: 1, level: 0 }] }, 'wanderrange=5')).toBeNull();
});

test('the route takes a boat only when the account holds two fares', () => {
    const boat: Travel = { id: 'b', kind: 'boat', name: 'A to B', from: { x: 0, z: 0, level: 0 }, to: { x: 1000, z: 0, level: 0 }, coins: 30, needs: [], runes: [], run: { how: 'npc', npc: 'Captain', op: 1, options: [], deck: true }, cost: 40 };
    // Walks are free within 50 tiles; the two docks are 1000 tiles apart.
    const pathLength: PathLength = (a, b, _bl, tol) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) <= 50 ? Math.max(0, Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) - tol) : null;
    const w = createWorld({ transports: [], doors: [], travel: [boat], pathLength });
    const from = { x: 10, z: 0, level: 0 }, to = { x: 1010, z: 0, level: 0 };
    expect(w.route(from, to, { skills: {}, varps: {}, items: [], coins: 59 }).ok).toBe(false);
    const r = w.route(from, to, { skills: {}, varps: {}, items: [], coins: 60 });
    expect(r.ok && r.legs.map(l => l.kind)).toEqual(['walk', 'travel', 'walk']);
});
