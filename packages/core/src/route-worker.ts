// Route planning off the game thread. A cold route search can take a minute; run on the bot's own thread it stops
// the client from reading packets, and its next walk click fails with "RangeError: Out of bounds access". This
// worker owns a separate pathfinder (its own rsmod wasm instance) and answers plan requests by message, as rs2b0t
// src/bot/event/webwalk/NavWorker.ts does (commit ae56ccc9, MIT License, Copyright (c) 2026 N64Jive).
import type { SharedLabels } from './components';
import { loadPathfinding } from './pathcache';
import { planTrip, type BankStock } from './trip';
import { createWorld, rsPathLength, type Account, type Tile, type World } from './world';

export type PlanRequest = { id: number; from: Tile; to: Tile; acct: Account; stock?: BankStock; budgetMs?: number; sharedAreas?: SharedLabels };
declare const self: { onmessage: ((e: MessageEvent<PlanRequest>) => void) | null; postMessage(m: unknown): void };

let world: Promise<World> | null = null;
self.onmessage = async e => {
    const { id, from, to, acct, stock, budgetMs, sharedAreas } = e.data;
    const started=performance.now();
    const trace=(phase:string)=>{if(process.env.BENCH_TRACE||process.env.ROUTE_TRACE==='1')console.log('ROUTE_PHASE '+JSON.stringify({id,phase,at:Date.now(),elapsedMs:Math.round(performance.now()-started),from,to}));};
    try {
        trace('world-start');
        if (sharedAreas) {
            const { attachSharedLabels } = await import('./components');
            attachSharedLabels(sharedAreas);
        }
        world ??= (async () => { await loadPathfinding();trace('pathfinding-ready');const pathLength=await rsPathLength();trace('path-length-ready');return createWorld({ pathLength }); })().catch(error=>{world=null;throw error;});
        const w = await world, deadline = budgetMs === undefined ? undefined : performance.now() + budgetMs;
        trace('world-ready');
        const plan=planTrip(w, from, to, acct, stock, undefined, undefined, { deadline });
        trace('search-ready');
        (globalThis as { Bun?: { gc?: (sync?: boolean) => void } }).Bun?.gc?.(true);
        self.postMessage({ id, plan });
    } catch (error) {
        self.postMessage({ id, error: String((error as Error)?.stack ?? error) });
    }
};
