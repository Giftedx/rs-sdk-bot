// RSS of the shared world a bot builds (bot.ts getWorld): after rsPathLength() and createWorld(), after blockedDoors()
// (what a walking bot asks for), and after the first call that builds the route graph (navigationGraph(); before this
// change createWorld() built it, so the last row is the old state at creation). Each run is its own bun process.
// Usage: bun scripts/measure/world-lazy-memory.ts [runs=3]
const mb = (n: number) => Math.round(n / 2 ** 20);
if (process.argv[2] === 'one') {
    const rows: string[] = [];
    const sample = (label: string) => { Bun.gc(true); rows.push(`${label} rss ${mb(process.memoryUsage().rss)} peak ${mb(process.resourceUsage().maxRSS * 1024)} objects ${(require('bun:jsc') as any).heapStats().objectCount}`); };
    const { createWorld, rsPathLength } = await import('../../packages/core/src/world');
    sample('imports');
    const world = createWorld({ pathLength: await rsPathLength() });
    sample('createWorld');
    world.blockedDoors({ skills: {}, varps: {}, items: [] });
    sample('blockedDoors');
    world.navigationGraph!();
    sample('route graph built');
    console.log(rows.join(' | '));
    process.exit(0);
}
const run = () => Bun.spawnSync(['bun', import.meta.path, 'one'], { stdout: 'pipe', stderr: 'inherit', windowsHide: true }).stdout.toString();
run(); // builds the snapshot and the leg-cache files when there are none
for (let i = 0; i < Number(process.argv[2] ?? 3); i++) process.stdout.write(run());
