// RSS and peak RSS of one bot process at login and after its first long route, with the route finder loaded at login
// (`eager`, what connectInProcess did before) and loaded at its first use (`lazy`, now). Each mode runs in its own bun
// process, three times; a warm-up run first builds the snapshot in .practice/cache. No login: the steps are the same
// module loads as connectInProcess (bot.ts, the SDK, the web client session) and the same route call.
// Usage: bun scripts/measure/route-finder-lazy-memory.ts [runs=3]
import { existsSync } from 'node:fs';

const mode = process.argv[2];
const mb = (n: number) => Math.round(n / 2 ** 20);
const peak = () => mb(process.resourceUsage().maxRSS * 1024);

if (mode === 'eager' || mode === 'lazy') {
    const { DEFAULT_CACHE, loadPathfinding } = await import('../../packages/core/src/pathcache');
    await import('../../packages/core/src/bot');
    const pf = await import('../../vendor/rs-sdk/sdk/pathfinding');
    const rows: string[] = [];
    const sample = (label: string) => { Bun.gc(true); rows.push(`${label} rss ${mb(process.memoryUsage().rss)} peak ${peak()}`); };
    sample('imports');
    if (mode === 'eager') await loadPathfinding();
    sample('at login');
    const t0 = performance.now();
    const path = pf.findLongPath(0, 3222, 3218, 3087, 3230);
    const ms = Math.round(performance.now() - t0);
    sample(`after first route (${path.length} points, ${ms} ms, snapshot ${existsSync(DEFAULT_CACHE)})`);
    console.log(`${mode.padEnd(5)} ${rows.join(' | ')}`);
    process.exit(0);
}
const run = (m: string) => Bun.spawnSync(['bun', import.meta.path, m], { stdout: 'pipe', stderr: 'inherit', windowsHide: true }).stdout.toString();
run('eager'); // builds the snapshot when there is none
for (let i = 0; i < Number(process.argv[2] ?? 3); i++) for (const m of ['eager', 'lazy']) process.stdout.write(run(m));
