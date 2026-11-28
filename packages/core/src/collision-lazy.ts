// Preloaded for every bun process in this repo (bunfig.toml). vendor/rs-sdk/sdk/pathfinding.ts imports
// collision-data.json at module level, so its 1.27 million tile arrays stay referenced for the life of the
// process (about 300 MB of heap, once more in the route worker), though only initPathfinding reads them.
// This serves the same JSON as a module whose zones and tiles parse on first access and are dropped on the
// next timer turn, after the synchronous initPathfinding has finished. When pathcache.ts has restored the wasm
// snapshot (globalThis.__rsPathRestored), the zones and tiles are already in the grid and are not parsed at all;
// only the doors are read, for pathfinding.ts's door index. The vendor file is unchanged.
import { plugin } from 'bun';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
    // Released on the next timer turn after initPathfinding/ensureDoorIndex populates doorIndex.
    get doors() {
        if (!doors) { doors = doorsFromTail() ?? full().doors; setTimeout(() => { doors = undefined; }, 0); }
        return doors;
    },
};`;
}

// Defers rsmod_bg.wasm compilation and instantiation until the first WASM call or __wasm read, so importing
// sdk/index.ts or sdk/pathfinding.ts allocates no WASM memory and spawns no WASM compiler threads when a bot
// routes through route-service.ts. Pure enum exports (CollisionFlag, CollisionType, ...) stay eager.
const RSMOD_EAGER_RE = /const path = require\('path'\)\.join\(__dirname, 'rsmod_bg\.wasm'\);\r?\nconst bytes = require\('fs'\)\.readFileSync\(path\);\r?\n\r?\nconst wasmModule = new WebAssembly\.Module\(bytes\);\r?\nconst wasmInstance = new WebAssembly\.Instance\(wasmModule, imports\);\r?\nwasm = wasmInstance\.exports;\r?\nmodule\.exports\.__wasm = wasm;\r?\n\r?\nwasm\.__wbindgen_start\(\);/;

export function lazyRsmodSource(source: string, filePath: string): string {
    if (!RSMOD_EAGER_RE.test(source)) return source;
    const wasmFile = join(dirname(filePath), 'rsmod_bg.wasm');
    const exportsList: string[] = [];
    for (const m of source.matchAll(/^module\.exports\.([A-Za-z0-9_$]+)\s*=/gm)) {
        const name = m[1]!;
        if (!name.startsWith('__wbg') && name !== '__wasm' && !exportsList.includes(name)) exportsList.push(name);
    }
    const replacement = `function __rsmodEnsure() {
    if (wasm) return wasm;
    const bytes = require('fs').readFileSync(${JSON.stringify(wasmFile)});
    const wasmModule = new WebAssembly.Module(bytes);
    const wasmInstance = new WebAssembly.Instance(wasmModule, imports);
    wasm = wasmInstance.exports;
    __wasm = wasm;
    Object.defineProperty(module.exports, '__wasm', { value: wasm, enumerable: true, configurable: true, writable: true });
    wasm.__wbindgen_start();
    return wasm;
}
module.exports.__ensureWasm = __rsmodEnsure;
Object.defineProperty(module.exports, '__wasm', { enumerable: false, configurable: true, get() { return __rsmodEnsure(); } });
for (const k of Object.keys(module.exports)) {
    if (k.startsWith('__wbg') || k === '__wasm' || k === '__ensureWasm') continue;
    const fn = module.exports[k];
    if (typeof fn === 'function') {
        module.exports[k] = function(...args) { if (!wasm) __rsmodEnsure(); return fn.apply(this, args); };
    }
}`;
    const body = source.replace(RSMOD_EAGER_RE, replacement);
    const namedExports = exportsList.map(k => `export const ${k} = module.exports.${k};`).join('\n');
    return `const module = { exports: {} };\nconst exports = module.exports;\nexport let __wasm;\n${body}\nexport const __ensureWasm = __rsmodEnsure;\n${namedExports}\nexport default module.exports;\n`;
}

// Populates doorIndex from collision-data.json's tail doors array without running initPathfinding() or touching WASM,
// so findDoorsAlongPath, getDoorAt and sdk.blockDoorTemporarily work in bots that delegate pathfinding to route-service.ts.
const DOOR_KEY_RE = /function doorKey\(level: number, x: number, z: number\): string \{\r?\n    return `\$\{level\},\$\{x\},\$\{z\}`;\r?\n\}/;
const FIND_DOORS_RE = /export function findDoorsAlongPath\(\r?\n    waypoints: Array<\{ x: number; z: number; level: number \}>\r?\n\): DoorInfo\[\] \{/;
const GET_DOOR_RE = /export function getDoorAt\(level: number, x: number, z: number\): DoorInfo \| undefined \{\r?\n    if \(!initialized\) initPathfinding\(\);\r?\n    return doorIndex\.get\(doorKey\(level, x, z\)\);\r?\n\}/;

export function lazyPathfindingDoorsSource(source: string): string {
    if (!DOOR_KEY_RE.test(source) || !FIND_DOORS_RE.test(source) || !GET_DOOR_RE.test(source)) return source;
    const helper = `$&\n\nlet doorsIndexed = false;\nfunction ensureDoorIndex(): void {\n    if (doorsIndexed) return;\n    doorsIndexed = true;\n    const data = collisionData as CollisionData;\n    if (!data.doors) return;\n    for (const [level, x, z, shape, angle, blockrange] of data.doors) {\n        const key = doorKey(level, x, z);\n        if (ONE_WAY_DOORS.has(key)) continue;\n        doorIndex.set(key, { level, x, z, shape, angle, blockrange: !!blockrange });\n    }\n}`;
    return source
        .replace(DOOR_KEY_RE, helper)
        .replace(FIND_DOORS_RE, '$&\n    ensureDoorIndex();')
        .replace(GET_DOOR_RE, 'export function getDoorAt(level: number, x: number, z: number): DoorInfo | undefined {\n    ensureDoorIndex();\n    return doorIndex.get(doorKey(level, x, z));\n}');
}

plugin({
    name: 'collision-lazy',
    setup(build) {
        build.onLoad({ filter: /[\\/]sdk[\\/]collision-data\.json$/ }, args => ({ contents: lazyCollisionSource(args.path), loader: 'js' }));
        build.onLoad({ filter: /[\\/]rsmod-pathfinder[\\/]rsmod-pathfinder\.js$/ }, args => ({ contents: lazyRsmodSource(readFileSync(args.path, 'utf8'), args.path), loader: 'js' }));
        build.onLoad({ filter: /[\\/]sdk[\\/]pathfinding\.ts$/ }, args => ({ contents: lazyPathfindingDoorsSource(readFileSync(args.path, 'utf8')), loader: 'ts' }));
    },
});
