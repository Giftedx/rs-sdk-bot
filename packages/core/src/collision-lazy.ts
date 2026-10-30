// Preloaded for every bun process in this repo (bunfig.toml). vendor/rs-sdk/sdk/pathfinding.ts imports
// collision-data.json at module level, so its 1.27 million tile arrays stay referenced for the life of the
// process (about 300 MB of heap, once more in the route worker), though only initPathfinding reads them.
// This serves the same JSON as a module whose zones and tiles parse on first access and are dropped on the
// next timer turn, after the synchronous initPathfinding has finished. When pathcache.ts has restored the wasm
// snapshot (globalThis.__rsPathRestored), the zones and tiles are already in the grid and are not parsed at all;
// only the doors are read, for pathfinding.ts's door index. The vendor file is unchanged.
import { plugin } from 'bun';

export function lazyCollisionSource(file: string): string {
    return `import { readFileSync } from 'node:fs';
let parsed, doors;
const full = () => {
    if (!parsed) { parsed = JSON.parse(readFileSync(${JSON.stringify(file)}, 'utf8')); setTimeout(() => { parsed = undefined; }, 0); }
    return parsed;
};
const restored = () => globalThis.__rsPathRestored === true;
export default {
    get zones() { return restored() ? [] : full().zones; },
    get tiles() { return restored() ? [] : full().tiles; },
    // "doors" is the file's last key: parse only its array, not the 1.27 million tiles before it.
    get doors() {
        if (doors) return doors;
        const text = readFileSync(${JSON.stringify(file)}, 'utf8'), at = text.lastIndexOf('"doors":');
        return doors = at >= 0 && text.trimEnd().endsWith('}') ? JSON.parse(text.slice(at + 8, text.trimEnd().length - 1)) : full().doors;
    },
};`;
}

plugin({
    name: 'collision-lazy',
    setup(build) {
        build.onLoad({ filter: /[\\/]sdk[\\/]collision-data\.json$/ }, args => ({ contents: lazyCollisionSource(args.path), loader: 'js' }));
    },
});
