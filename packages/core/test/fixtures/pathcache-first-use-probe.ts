// Child process for pathcache.test.ts: never calls loadPathfinding. The first SDK path call builds the grid, and the
// first-use hook of pathcache.ts restores the snapshot file that the test names (when it is valid).
import { existsSync } from 'node:fs';
import { loadPathfinding, restorePathfindingOnFirstUse } from '../../src/pathcache';

const file = process.argv[2]!;
(globalThis as { __rsPathEnsure?: () => void }).__rsPathEnsure = () => { restorePathfindingOnFirstUse(file); };
const pf = await import('../../../../vendor/rs-sdk/sdk/pathfinding');
const routes: [number, number, number, number, number][] = [
    [0, 3222, 3218, 3087, 3230],
    [0, 3222, 3218, 3205, 3209],
    [0, 3210, 3459, 3285, 3365],
];
const t0 = Date.now();
const paths = routes.map(([lv, sx, sz, dx, dz]) => pf.findLongPath(lv, sx, sz, dx, dz).map(p => `${p.x},${p.z}`).join(' '));
const ms = Date.now() - t0;
const restored = (globalThis as { __rsPathRestored?: boolean }).__rsPathRestored === true;
// With no valid snapshot the hook queued loadPathfinding: it ends after the grid is built and writes the snapshot.
await loadPathfinding({ cacheFile: file });
console.log(`PROBE ${JSON.stringify({ restored, ms, paths, written: existsSync(file) })}`);
