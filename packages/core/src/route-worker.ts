// Route planning off the game thread. A cold route search can take a minute; run on the bot's own thread it stops
// the client from reading packets, and its next walk click fails with "RangeError: Out of bounds access". This
// worker owns a separate pathfinder (its own rsmod wasm instance) and answers plan requests by message, as rs2b0t
// src/bot/event/webwalk/NavWorker.ts does (commit ae56ccc9, MIT License, Copyright (c) 2026 N64Jive).
import { loadPathfinding } from './pathcache';
import { planTrip, type BankStock } from './trip';
import { createWorld, rsPathLength, type Account, type Tile, type World } from './world';

export type PlanRequest = { id: number; from: Tile; to: Tile; acct: Account; stock?: BankStock; budgetMs?: number };
declare const self: { onmessage: ((e: MessageEvent<PlanRequest>) => void) | null; postMessage(m: unknown): void };

let world: Promise<World> | null = null;
self.onmessage = async e => {
    const { id, from, to, acct, stock, budgetMs } = e.data;
    try {
        world ??= (async () => { await loadPathfinding(); return createWorld({ pathLength: await rsPathLength() }); })();
        const w = await world, deadline = budgetMs === undefined ? undefined : performance.now() + budgetMs;
        self.postMessage({ id, plan: planTrip(w, from, to, acct, stock, undefined, undefined, { deadline }) });
    } catch (error) {
        self.postMessage({ id, error: String((error as Error)?.stack ?? error) });
    }
};
