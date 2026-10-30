import { expect, test } from 'bun:test';
import { objSpawns, parseObjSpawns, spawnsByDistance } from '../src/spawn-index';

test('an OBJ line gives the world tile of its map square', () => {
    const m = parseObjSpawns('m51_52.jm2', '==== MAP ====\n0 1 1: 9\n==== OBJ ====\n0 2 33: 753 1\n1 9 47: 753 1\n');
    expect(m.get(753)).toEqual([{ x: 3266, z: 3361, level: 0 }, { x: 3273, z: 3375, level: 1 }]);
    expect(m.has(9)).toBe(false);
});

test('the pinned maps hold the cadava berry spawns south-east of Varrock, nearest first', () => {
    expect(spawnsByDistance(753, { x: 3270, z: 3360, level: 0 }, objSpawns())[0]).toEqual({ x: 3266, z: 3361, level: 0 });
});
