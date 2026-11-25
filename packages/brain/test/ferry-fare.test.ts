import { expect, test } from 'bun:test';
import type { Outcome } from '../../core/src/act';
import type { Tile } from '../../core/src/world';
import { walkWithFerryFallback as logisticsWalk } from '../../workers/src/logistics/walk';
import { walkWithFerryFallback as marketWalk } from '../../workers/src/market/walk';
import { ferryFallbackFare } from '../src/ferry-fare';

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
