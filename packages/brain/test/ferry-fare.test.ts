import { expect, test } from 'bun:test';
import type { Outcome } from '../../core/src/act';
import type { Tile } from '../../core/src/world';
import { walkWithFerryFallback as logisticsWalk } from '../../workers/src/logistics/walk';
import { walkWithFerryFallback as marketWalk } from '../../workers/src/market/walk';
import { ferryFallbackFare, loadFerryTravelEdges } from '../src/ferry-fare';

const ARDOUGNE_NORTH: Tile = { x: 2619, z: 3332, level: 0 };
const VARROCK_WEST: Tile = { x: 3185, z: 3436, level: 0 };

test('ferryFallbackFare is the fare that both ferry fallbacks stage before they walk', async () => {
    const cases: [string, Tile, Tile, number][] = [
        ['Falador bank to Ardougne', { x: 2945, z: 3368, level: 0 }, ARDOUGNE_NORTH, 60],
        ['east of the Al Kharid gate to Ardougne', { x: 3269, z: 3164, level: 0 }, { x: 2615, z: 3332, level: 0 }, 70],
        ['Ardougne to Varrock', { x: 2584, z: 3293, level: 0 }, VARROCK_WEST, 60],
        ['Kandarin to Varrock, by Ardougne north', { x: 2809, z: 3441, level: 0 }, VARROCK_WEST, 60],
        ['Ardougne upper floor to Falador', { x: 2575, z: 3269, level: 1 }, { x: 3017, z: 3288, level: 0 }, 60],
        ['Zanaris to Ardougne, by the shed', { x: 3220, z: 9592, level: 0 }, ARDOUGNE_NORTH, 60],
        ['Taverley to Varrock', { x: 2895, z: 3440, level: 0 }, VARROCK_WEST, 0],
        ['Kandarin to Ardougne', { x: 2809, z: 3441, level: 0 }, ARDOUGNE_NORTH, 0],
    ];
    const ok = async (): Promise<Outcome> => ({ ok: true, ticks: 1 });
    for (const [name, from, to, fare] of cases) {
        expect([name, ferryFallbackFare(from, to)]).toEqual([name, fare]);
        for (const walk of [logisticsWalk, marketWalk]) {
            let staged = 0;
            await walk(from, to, ok, ok, () => 0, async need => { staged = need; return { ok: true, ticks: 1 }; });
            expect([name, staged]).toEqual([name, fare]);
        }
    }
});

test('with no route to Ardougne North, the walk east from Kandarin stages no fare, and so does ferryFallbackFare', async () => {
    // MeatNTwoVeg at 2793,3516: inside the Kandarin box, east of White Wolf Mountain.
    const from: Tile = { x: 2793, z: 3516, level: 0 };
    const isNorth = (t: Tile) => t.x === ARDOUGNE_NORTH.x && t.z === ARDOUGNE_NORTH.z && t.level === ARDOUGNE_NORTH.level;
    expect(ferryFallbackFare(from, VARROCK_WEST, undefined, t => !isNorth(t))).toBe(0);
    expect(ferryFallbackFare(from, VARROCK_WEST)).toBe(60);
    const walkTo = async (t: Tile): Promise<Outcome> =>
        isNorth(t) ? { ok: false, reason: 'precondition', detail: 'no route to 2619,3332,0', ticks: 0 } : { ok: true, ticks: 1 };
    for (const walk of [logisticsWalk, marketWalk]) {
        let staged = 0;
        const out = await walk(from, VARROCK_WEST, walkTo, async () => ({ ok: true, ticks: 1 }), () => 0, async need => { staged = need; return { ok: true, ticks: 1 }; });
        expect(out.ok).toBe(true);
        expect(staged).toBe(0);
    }
});

test('loadFerryTravelEdges returns only the 5 ferry and toll entries without loading full travel graph', () => {
    const edges = loadFerryTravelEdges();
    expect(edges.length).toBe(5);
    expect(edges.every(e => typeof e.id === 'string' && e.from !== null && Number.isFinite(e.coins))).toBe(true);
});
