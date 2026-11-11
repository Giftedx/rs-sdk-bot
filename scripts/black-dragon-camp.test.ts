import { expect, test } from 'bun:test';
import { BLACK_DRAGON, canShoot, footprintDistance, swTile } from './black-dragon-camp';
import { BLACK_ENTRY, BLACK_KIT, blackKit, combatKitTotals, validateCombatKit } from './microbot-combat-trip';
import { initPathfinding } from '../vendor/rs-sdk/sdk/pathfinding';
import * as rsmod from '../vendor/rs-sdk/server/vendor/rsmod-pathfinder';
import { CollisionType } from '../vendor/rs-sdk/server/vendor/rsmod-pathfinder';

const key = (x: number, z: number) => `${x},${z}`;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;
// Every tile a mover of `size` reaches from `starts` by the engine's own step rule.
function reach(starts: { x: number; z: number }[], size: number): { x: number; z: number }[] {
    initPathfinding();
    const seen = new Set(starts.map(t => key(t.x, t.z))), queue = starts.map(t => [t.x, t.z] as [number, number]);
    while (queue.length) {
        const [x, z] = queue.shift()!;
        for (const [dx, dz] of DIRS) {
            const nx = x + dx, nz = z + dz;
            if (nx < 2790 || nx > 2880 || nz < 9780 || nz > 9860 || seen.has(key(nx, nz)) || !rsmod.canTravel(0, x, z, dx, dz, size, 0, CollisionType.NORMAL)) continue;
            seen.add(key(nx, nz)); queue.push([nx, nz]);
        }
    }
    return [...seen].map(k => k.split(',').map(Number)).map(([x, z]) => ({ x: x!, z: z! }));
}

test('the distance to a dragon is to its 4x4 footprint, zero under it', () => {
    const sw = { x: 2835, z: 9822 };
    expect(footprintDistance(sw, { x: 2835, z: 9820 })).toBe(2);
    expect(footprintDistance(sw, { x: 2836, z: 9823 })).toBe(0);
    expect(footprintDistance(sw, { x: 2839, z: 9826 })).toBe(1);
    expect(footprintDistance(sw, { x: 2830, z: 9829 })).toBe(5);
    // The route tile, not the render position, names the south-west tile.
    expect(swTile({ x: 2837, z: 9826, tileX: 2835, tileZ: 9824 })).toEqual({ x: 2835, z: 9824 });
    expect(swTile({ x: 2837, z: 9826 })).toEqual({ x: 2837, z: 9826 });
});

test('no black dragon can stand within a tile of the camp tile, and a player reaches the tile from the south', () => {
    const dragons = reach([...BLACK_DRAGON.spawns], BLACK_DRAGON.size), safe = BLACK_DRAGON.safe;
    // The cave holds a few dozen south-west positions; the corridor is none of them.
    expect(dragons.length).toBeGreaterThan(20);
    expect(dragons.length).toBeLessThan(60);
    expect(Math.min(...dragons.map(d => footprintDistance(d, safe)))).toBe(2);
    // The same holds for the rest of the corridor's south half, where the trip's walk may end.
    for (const x of [2834, 2835, 2836]) for (const z of [9818, 9819, 9820]) expect(Math.min(...dragons.map(d => footprintDistance(d, { x, z })))).toBeGreaterThanOrEqual(2);
    // The row north of the tile is beside dragon ground: the camp must never stand there.
    expect(Math.min(...dragons.map(d => footprintDistance(d, { x: safe.x, z: safe.z + 1 })))).toBe(1);
    // A player walks in from the poison spiders' side without crossing a tile a dragon can cover.
    const covered = new Set(dragons.flatMap(d => [0, 1, 2, 3].flatMap(i => [0, 1, 2, 3].map(j => key(d.x + i, d.z + j)))));
    const [last] = BLACK_ENTRY.slice(-1);
    const player = reach([{ x: last![0], z: last![1] }], 1);
    expect(player.some(t => t.x === safe.x && t.z === safe.z)).toBe(true);
    for (const [x, z] of BLACK_ENTRY) expect(covered.has(key(x, z))).toBe(false);
    expect(Math.abs(last![0] - safe.x)).toBeLessThanOrEqual(1);
    expect(last![1]).toBeLessThanOrEqual(safe.z - 1);
});

test('the camp shoots only a dragon whose south-west tile is in sight within five tiles', () => {
    const safe = BLACK_DRAGON.safe;
    // The dragon that spawns north of the corridor, and one parked at the corridor mouth.
    expect(canShoot(safe, { x: 2835, z: 9824 })).toBe(true);
    expect(canShoot(safe, { x: 2835, z: 9822 })).toBe(true);
    // Seven tiles west: a shot from there walked the account onto dragon ground on practice.
    expect(canShoot(safe, { x: 2828, z: 9824 })).toBe(false);
    expect(canShoot(safe, BLACK_DRAGON.spawns[0]!)).toBe(false);
    // Behind rock: no sight from the dungeon's entrance ladder, whatever the range.
    expect(canShoot({ x: 2884, z: 9797 }, { x: 2835, z: 9824 }, 80)).toBe(false);
});

test('the trip kit is a bow, arrows, the key, the escape runes and food, and asks Ranged 50', () => {
    expect(validateCombatKit(BLACK_KIT)).toEqual([{ skill: 'Ranged', level: 50 }]);
    expect(combatKitTotals(BLACK_KIT)).toEqual({ 861: 1, 888: 700, 1590: 1, 563: 1, 556: 3, 554: 1, 385: 6 });
    // The arrow is a choice: iron arrows by the thousand, and nothing that is not an arrow.
    expect(combatKitTotals(blackKit('iron_arrow', 1200))).toMatchObject({ 861: 1, 884: 1200 });
    expect(validateCombatKit(blackKit('iron_arrow', 1200))).toEqual([{ skill: 'Ranged', level: 50 }]);
    expect(() => blackKit('bolt', 700)).toThrow();
    expect(() => blackKit('iron_arrow', 50)).toThrow();
});
