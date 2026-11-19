// Preloaded for every bun process in this repo (bunfig.toml). vendor/rs-sdk/sdk/pathfinding.ts imports
// collision-data.json at module level, so its 1.27 million tile arrays stay referenced for the life of the
// process (about 300 MB of heap, once more in the route worker), though only initPathfinding reads them.
// This serves the same JSON as a module whose zones and tiles parse on first access and are dropped on the
// next timer turn, after the synchronous initPathfinding has finished. When pathcache.ts has restored the wasm
// snapshot (globalThis.__rsPathRestored), the zones and tiles are already in the grid and are not parsed at all;
// only the doors are read, for pathfinding.ts's door index. The vendor file is unchanged.
import { plugin } from 'bun';

export function lazyCollisionSource(file: string): string {
    return `import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
let parsed, doors;
// The doors array of the file, from its last bytes: 4 times more bytes at each try until "doors": is in them.
const doorsFromTail = () => {
    const fd = openSync(${JSON.stringify(file)}, 'r');
    try {
        const size = fstatSync(fd).size;
        for (let want = 1 << 16; ; want *= 4) {
            const length = Math.min(want, size), bytes = Buffer.alloc(length);
            if (readSync(fd, bytes, 0, length, size - length) !== length) return undefined;
            const text = bytes.toString('utf8'), at = text.lastIndexOf('"doors":');
            if (at >= 0) {
                const body = text.slice(at + 8).trimEnd();
                // Doors that are not the last key leave more than the array here: the whole file answers then.
                try { return body.endsWith('}') ? JSON.parse(body.slice(0, -1)) : undefined; } catch { return undefined; }
            }
            if (length === size) return undefined;
        }
    } finally { closeSync(fd); }
};
const full = () => {
    if (!parsed) { parsed = JSON.parse(readFileSync(${JSON.stringify(file)}, 'utf8')); setTimeout(() => { parsed = undefined; }, 0); }
    return parsed;
};
const restored = () => globalThis.__rsPathRestored === true;
export default {
    // initPathfinding reads zones first: a process that did not call loadPathfinding restores the snapshot here
    // (pathcache.ts restorePathfindingOnFirstUse sets __rsPathEnsure; without it nothing happens).
    get zones() { globalThis.__rsPathEnsure?.(); return restored() ? [] : full().zones; },
    get tiles() { return restored() ? [] : full().tiles; },
    // "doors" is the file's last key: read and parse only its array, not the 27 MB of tiles before it.
    get doors() {
        return doors ??= doorsFromTail() ?? full().doors;
    },
};`;
}

plugin({
    name: 'collision-lazy',
    setup(build) {
        build.onLoad({ filter: /[\\/]sdk[\\/]collision-data\.json$/ }, args => ({ contents: lazyCollisionSource(args.path), loader: 'js' }));
    },
});
