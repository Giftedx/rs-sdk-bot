// Offline: private bytes and working set of one bot process at each route step a solo worker takes (no login).
// The steps: the bot and walker imports, the main-thread world (getWorld: grid, area labels, leg cache), a local
// findPath, then trip plans by planTripOffThread (the route worker, or the host route service when ROUTE_SERVICE
// names one), with the time of each plan.
// Usage: bun scripts/measure/solo-route-memory.ts
import { processMemory } from './private-bytes';

const line = (label: string, ms: number) => {
    Bun.gc(true);
    const m = processMemory();
    console.log(`${label.padEnd(28)} private=${m.privateMb ?? '-'} MB  ws=${m.workingSetMb} MB  ${Math.round(ms)} ms`);
};
const step = async (label: string, f: () => unknown) => { const t = performance.now(); await f(); line(label, performance.now() - t); };

const acct = { skills: { hitpoints: 10 }, coins: 20000, varps: {}, items: [], worn: [], unlocks: [], questStages: {} } as any;
await step('base', () => 0);
await step('import bot+walk', async () => { await import('../../packages/core/src/bot'); await import('../../packages/core/src/walk'); });
await step('getWorld', async () => { const { getWorld } = await import('../../packages/core/src/bot/open'); await getWorld(); });
await step('findLongPath 20 tiles', async () => { const pf: any = await import('../../vendor/rs-sdk/sdk/pathfinding'); pf.findLongPath(0, 3222, 3218, 3240, 3225); });
const { planTripOffThread } = await import('../../packages/core/src/route-plan');
const trips: [string, any, any][] = [
    ['plan Lumbridge-Varrock', { x: 3222, z: 3218, level: 0 }, { x: 3210, z: 3424, level: 0 }],
    ['plan Lumbridge-Catherby', { x: 3222, z: 3218, level: 0 }, { x: 2809, z: 3441, level: 0 }],
    ['plan Lumbridge-Varrock again', { x: 3222, z: 3218, level: 0 }, { x: 3210, z: 3424, level: 0 }],
];
for (const [label, from, to] of trips) await step(label, async () => { const p = await planTripOffThread(from, to, acct); if (!p) console.log('  no plan'); });
process.exit(0);
