import { expect, test } from 'bun:test';
import { fallbackTiles, parseWalkOptions, walkFirstReachable } from '../src/logistics/walk';

const ARDOUGNE = { x: 2619, z: 3332, level: 0 }, VARROCK = { x: 3185, z: 3436, level: 0 };
const noRoute = (t: { x: number; z: number; level: number }) => ({ ok: false, reason: 'precondition', detail: `no route to ${t.x},${t.z},${t.level}` });

test('walk options: one of ground, boat or the fallbacks of a planned walk', () => {
    expect(parseWalkOptions([])).toEqual({ ground: false, or: [], orBank: false });
    expect(parseWalkOptions(['--ground']).ground).toBe(true);
    expect(parseWalkOptions(['--boat=npc:x']).boatId).toBe('npc:x');
    expect(parseWalkOptions(['--or=3185,3436,0;3013,3355,0', '--or-bank'])).toEqual({ ground: false, or: [VARROCK, { x: 3013, z: 3355, level: 0 }], orBank: true });
    expect(() => parseWalkOptions(['--ground', '--or-bank'])).toThrow('unknown walk option');
    expect(() => parseWalkOptions(['--ground', '--ground'])).toThrow('unknown walk option');
    expect(() => parseWalkOptions(['--boat=a', '--or=1,2,0'])).toThrow('unknown walk option');
    expect(() => parseWalkOptions(['--or=1,2'])).toThrow('bad walk fallback tile');
    expect(() => parseWalkOptions(['--or=1,2,0,4'])).toThrow('bad walk fallback tile');
    expect(() => parseWalkOptions(['--fast'])).toThrow('unknown walk option');
});

test('fallback tiles: target, listed tiles, then the nearest banks on the floor, one tile a place', () => {
    const burthorpe = { x: 2821, z: 3552, level: 0 };
    const banks = [
        { x: 2809, z: 3441, level: 0 },  // Catherby
        { x: 3186, z: 3438, level: 0 },  // Varrock West again: the same place as the listed hub
        { x: 2946, z: 3368, level: 0 },  // Falador West
        { x: 3013, z: 3355, level: 0 },  // Falador East
        { x: 3092, z: 3243, level: 0 },  // Draynor
        { x: 2443, z: 3083, level: 1 },  // another floor
    ];
    expect(fallbackTiles(ARDOUGNE, [VARROCK], true, burthorpe, banks)).toEqual([ARDOUGNE, VARROCK, banks[0], banks[2], banks[3]]);
    expect(fallbackTiles(ARDOUGNE, [VARROCK], false, burthorpe, banks)).toEqual([ARDOUGNE, VARROCK]);
    expect(fallbackTiles(ARDOUGNE, [], true, null, banks)).toEqual([ARDOUGNE]);
});

test('a walk with no route to the nearest hub goes to the next tile that has one', async () => {
    const tried: string[] = [], lines: string[] = [];
    const r = await walkFirstReachable([ARDOUGNE, VARROCK], async t => { tried.push(`${t.x},${t.z}`); return t === ARDOUGNE ? noRoute(t) : { ok: true }; }, l => lines.push(l));
    expect(r.ok).toBe(true);
    expect(tried).toEqual(['2619,3332', '3185,3436']);
    expect(lines[0]).toStartWith('WALK_FALLBACK {"to":{"x":2619,"z":3332,"level":0},"detail":"no route to 2619,3332,0"');
    expect(lines[1]).toBe('WALK_FALLBACK_TARGET {"to":{"x":3185,"z":3436,"level":0},"ok":true,"tried":1}');
});

test('a walk that failed after its route was found ends there', async () => {
    const tried: string[] = [];
    const stuck = { ok: false, reason: 'precondition', detail: 'walk rejected 3 times' };
    const r = await walkFirstReachable([ARDOUGNE, VARROCK], async t => { tried.push(`${t.x},${t.z}`); return stuck; }, () => {});
    expect(r).toEqual(stuck);
    expect(tried).toEqual(['2619,3332']);
});

test('with no route to any tile the walk reports the last no route', async () => {
    const r = await walkFirstReachable([ARDOUGNE, VARROCK], async t => noRoute(t), () => {});
    expect(r).toEqual(noRoute(VARROCK));
});
