import { expect, test } from 'bun:test';
import { multiEdges, multiZones } from './gen-multiway';

test('two side-by-side multi zones give one outline of four joined edges', () => {
    // Zones (3200..3208, 3520..3528) and (3208..3216, 3520..3528) on level 0: mapsquare 50,55, local 0,0 and 8,0.
    const zones = multiZones('// test\n0_50_55_0_0\n0_50_55_8_0\nbad line\n');
    expect([...zones].sort()).toEqual(['0,400,440', '0,401,440']);
    expect(multiEdges(zones)).toEqual([
        [3200, 3520, 3200, 3528, 0],
        [3200, 3520, 3216, 3520, 0],
        [3200, 3528, 3216, 3528, 0],
        [3216, 3520, 3216, 3528, 0],
    ]);
});
