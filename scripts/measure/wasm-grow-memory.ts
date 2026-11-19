// Does a route call grow the rsmod WASM memory after the snapshot restore, and what does it cost in RSS? Prints the
// memory size in pages and the RSS after the restore, after the first findLongPath, and after a second one. A grown
// memory is a new backing buffer with a copy of the old one. No login.
// Usage: bun scripts/measure/wasm-grow-memory.ts [runs=3]
const mb = (n: number) => Math.round(n / 2 ** 20);
if (process.argv[2] === 'one') {
    const { loadPathfinding } = await import('../../packages/core/src/pathcache');
    const rsmod: any = await import('../../vendor/rs-sdk/server/vendor/rsmod-pathfinder/rsmod-pathfinder.js');
    const pf: any = await import('../../vendor/rs-sdk/sdk/pathfinding');
    await loadPathfinding();
    const rows: string[] = [];
    const sample = (label: string) => { Bun.gc(true); rows.push(`${label}: ${rsmod.__wasm.memory.buffer.byteLength / 65536} pages, rss ${mb(process.memoryUsage().rss)} peak ${mb(process.resourceUsage().maxRSS * 1024)}`); };
    sample('restored');
    pf.findLongPath(0, 3222, 3218, 3087, 3230);
    sample('after 1st findLongPath');
    pf.findLongPath(0, 3222, 3218, 3087, 3230);
    sample('after 2nd findLongPath');
    pf.findLongPath(0, 2655, 3283, 3185, 3436);
    sample('after a long one');
    console.log(rows.join(' | '));
    process.exit(0);
}
const run = () => Bun.spawnSync(['bun', import.meta.path, 'one'], { stdout: 'pipe', stderr: 'inherit', windowsHide: true }).stdout.toString();
run();
for (let i = 0; i < Number(process.argv[2] ?? 3); i++) process.stdout.write(run());
