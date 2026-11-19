// Peak RSS of a process that reads the doors of vendor/rs-sdk/sdk/collision-data.json after a snapshot restore:
// the whole file as one string (the method before) against the tail read of collision-lazy.ts. Each mode runs in
// its own bun process. This script does not load the collision-lazy preload for the file, it reads the JSON itself.
// Usage: bun scripts/measure/collision-doors-memory.ts
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { lazyCollisionSource } from '../../packages/core/src/collision-lazy';

const file = resolve(import.meta.dir, '..', '..', 'vendor', 'rs-sdk', 'sdk', 'collision-data.json');
const mode = process.argv[2];
if (mode === 'whole' || mode === 'tail') {
    const base = process.memoryUsage().rss;
    let peak = base;
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 1);
    let doors: unknown[];
    if (mode === 'whole') {
        const text = readFileSync(file, 'utf8'), at = text.lastIndexOf('"doors":');
        doors = JSON.parse(text.slice(at + 8, text.trimEnd().length - 1));
    } else {
        const dir = mkdtempSync(join(tmpdir(), 'doors-')), mod = join(dir, 'lazy.js');
        writeFileSync(mod, lazyCollisionSource(file));
        (globalThis as { __rsPathRestored?: boolean }).__rsPathRestored = true;
        doors = (await import(mod)).default.doors;
    }
    clearInterval(timer);
    peak = Math.max(peak, process.memoryUsage().rss);
    console.log(`${mode.padEnd(5)} doors ${doors.length}, rss before ${Math.round(base / 2 ** 20)} MB, peak ${Math.round(peak / 2 ** 20)} MB, peak over before +${Math.round((peak - base) / 2 ** 20)} MB`);
    process.exit(0);
}
for (const m of ['whole', 'tail']) process.stdout.write(Bun.spawnSync(['bun', import.meta.path, m], { stdout: 'pipe', stderr: 'inherit', windowsHide: true }).stdout.toString());
