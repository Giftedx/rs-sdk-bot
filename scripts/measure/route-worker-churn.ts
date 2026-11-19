// Parent RSS around route-worker cycles: plan, wait for the idle close (WORKER_IDLE_MS after the last plan), repeat.
// Each row is the parent's RSS after a garbage collection, taken 3 s after the close. Claimed: each new Worker() then
// terminate() leaves about 100 MB in the parent. No login. With `keep` as the first argument the worker is not closed
// (the plans repeat on the one worker), for the comparison.
// Usage: bun scripts/measure/route-worker-churn.ts [cycles=3] [keep]
import { WORKER_IDLE_MS, planTripOffThread } from '../../packages/core/src/route-plan';

const mb = (n: number) => Math.round(n / 2 ** 20);
const cycles = Number(process.argv[2] ?? 3), keep = process.argv[3] === 'keep';
const acct = { skills: { hitpoints: 10 }, coins: 20000, varps: {}, items: [], worn: [], unlocks: [], questStages: {} } as any;
const sample = async (label: string) => {
    await Bun.sleep(3000);
    Bun.gc(true);
    console.log(`${label.padEnd(28)} parent rss ${mb(process.memoryUsage().rss)} MB, peak ${mb(process.resourceUsage().maxRSS * 1024)} MB`);
};
await sample('start');
for (let i = 1; i <= cycles; i++) {
    const t0 = performance.now();
    const plan = await planTripOffThread({ x: 3222, z: 3218, level: 0 }, { x: 3087, z: 3230, level: 0 }, acct);
    const ms = Math.round(performance.now() - t0);
    await sample(`cycle ${i} after plan (${plan ? plan.legs.length : 'no'} legs, ${ms} ms)`);
    if (!keep) {
        await Bun.sleep(WORKER_IDLE_MS + 2000);
        await sample(`cycle ${i} after the close`);
    }
}
process.exit(0);
