import { expect, test } from 'bun:test';
import { CAGED, combatLevel, dangerTiles, deadly, escapeTiles, liveHunters, loadHunters, parseHunter } from '../src/danger';
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
