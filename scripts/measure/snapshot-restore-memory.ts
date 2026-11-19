// RSS and peak RSS after a pathfinding snapshot restore into a fresh rsmod memory: every payload byte written (`all`,
// the method before) against the zero pages skipped (`skip`, pathcache.ts copyNonZeroPages). Each mode runs in its own bun
// process, `runs` times (default 3); a warm-up child builds the snapshot first. Also prints how many pages are zero.
// Usage: bun scripts/measure/snapshot-restore-memory.ts [runs=3]
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const mode = process.argv[2];
const mb = (n: number) => Math.round(n / 2 ** 20);
if (mode === 'warm' || mode === 'all' || mode === 'skip') {
    const { DEFAULT_CACHE, loadPathfinding, pathfindingSourceKey, restorePathfindingSnapshotFile } = await import('../../packages/core/src/pathcache');
    if (mode === 'warm') { await loadPathfinding(); process.exit(0); }
    const rsmod: any = await import('../../vendor/rs-sdk/server/vendor/rsmod-pathfinder/rsmod-pathfinder.js');
    const memory: WebAssembly.Memory = rsmod.__wasm.memory;
    Bun.gc(true);
    const before = process.memoryUsage().rss;
    let zeroPages = 0;
    if (mode === 'skip') {
        if (!restorePathfindingSnapshotFile(DEFAULT_CACHE, pathfindingSourceKey(), memory)) throw Error('no valid snapshot');
    } else {
        // The method before: stage the payload, grow, write every byte.
        const fd = openSync(DEFAULT_CACHE, 'r'), total = fstatSync(fd).size, head = Buffer.alloc(4);
        readSync(fd, head, 0, 4, 0);
        const offset = 4 + head.readUInt32LE(0), payload = Buffer.alloc(total - offset);
        readSync(fd, payload, 0, payload.length, offset);
        closeSync(fd);
        memory.grow(payload.length / 65536 - memory.buffer.byteLength / 65536);
        new Uint8Array(memory.buffer, 0, payload.length).set(payload);
    }
    Bun.gc(true);
    // Sample first: counting the zero pages reads (and so maps) every page.
    const after = process.memoryUsage().rss, peak = process.resourceUsage().maxRSS * 1024;
    for (let at = 0; at < memory.buffer.byteLength; at += 65536) if (Buffer.compare(Buffer.from(memory.buffer, at, 65536), Buffer.alloc(65536)) === 0) zeroPages++;
    console.log(`${mode.padEnd(4)} rss before ${mb(before)} MB, after ${mb(after)} MB, peak ${mb(peak)} MB, pages ${memory.buffer.byteLength / 65536}, zero pages ${zeroPages}`);
    process.exit(0);
}
const run = (m: string) => Bun.spawnSync(['bun', import.meta.path, m], { stdout: 'pipe', stderr: 'inherit', windowsHide: true }).stdout.toString();
run('warm');
for (let i = 0; i < Number(process.argv[2] ?? 3); i++) for (const m of ['all', 'skip']) process.stdout.write(run(m));
