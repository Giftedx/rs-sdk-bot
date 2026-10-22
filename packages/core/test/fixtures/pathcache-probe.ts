// Child process for pathcache.test.ts: loads pathfinding through the cache and prints timing and paths.
import { loadPathfinding } from '../../src/pathcache';

const file = process.argv[2]!;
const r = await loadPathfinding({ cacheFile: file });
const pf = await import('../../../../vendor/rs-sdk/sdk/pathfinding');
const routes: [number, number, number, number, number][] = [
    [0, 3222, 3218, 3087, 3230], // Lumbridge to Draynor
    [0, 3222, 3218, 3205, 3209], // Lumbridge castle courtyard to the staircase
    [0, 3210, 3459, 3285, 3365], // Varrock palace to the SE mine
];
const paths = routes.map(([lv, sx, sz, dx, dz]) => pf.findLongPath(lv, sx, sz, dx, dz).map(p => `${p.x},${p.z}`).join(' '));
console.log(`PROBE ${JSON.stringify({ restored: r.restored, ms: r.ms, paths })}`);
