// Swarm dashboard server. Usage: bun packages/dashboard/server.ts  ->  http://localhost:3100
// Sources: the status files every bot writes (.practice/status/<name>.json, packages/core/src/status.ts), the live
// accounts in vendor/rs-sdk/bots (SERVER = the demo), the swarm controller (.practice/swarm-state.json), the world feed
// (who is in the world, server tick, player count), our live hiscore ranks (cached 5 min), the board
// snapshot (each skill board's #1), the live Equipment, Bank and Runite boards, Grand Exchange prices
// (/api/market/items), research/owner-requests.md (the owner's request queue), the Haggis plan (research/haggis-run.md
// when it has a board table, else haggis-plan.json here), and this machine (memory, CPU, bun processes).
// One state is built every 2 s while someone watches and sent to every client over server-sent events.
// Files it keeps: .practice/events.jsonl (phase changes), .practice/results.jsonl (RESULT lines),
// .practice/rank-history.jsonl (rank changes). It reads .practice/vault-log.jsonl (the banker's transfers).
import { join } from 'node:path';
import { bindRetry } from './bind-retry';
import { reloadDue, respawnDaemon } from '../core/src/live-reload';
import { HOST, PORT, sourceRoot, startMapBuild, startedAt } from './server/config';
import { startMarketRefresh } from './server/market';
import { createFetchHandler } from './server/routes';
import { clients, startStateBackground } from './server/state';
import { startHiscoresRefresh, startWorldFeed } from './server/world';

startMapBuild();
startWorldFeed();
startHiscoresRefresh();
startMarketRefresh();
startStateBackground();

const dashboardServer = await bindRetry(() => Bun.serve({
    hostname: HOST,
    port: PORT,
    idleTimeout: 0,
    fetch: createFetchHandler(),
}), { log: console.log });

// Reload the collector's imported code as well as the files the browser reads from disk.
const reloadTimer = setInterval(async () => {
    if (!reloadDue(sourceRoot, 'dashboard', startedAt)) return;
    clearInterval(reloadTimer);
    const stopped = dashboardServer.stop();
    // SSE streams otherwise keep graceful shutdown open. Let ordinary requests finish before exiting.
    for (const client of clients) { try { client.close(); } catch { /* already closed */ } }
    clients.clear();
    await stopped;
    const pid = respawnDaemon(sourceRoot, [join(sourceRoot, 'packages/dashboard/server.ts'), ...process.argv.slice(2)], join(sourceRoot, '.practice/dashboard.out.log'));
    console.log(`dashboard: reload after a live update: successor pid ${pid}`);
    process.exit(0);
}, 5_000);
// The listening host, not "localhost": that name can resolve to ::1 first on this PC, and HOST is IPv4.
console.log(`dashboard: http://${HOST}:${PORT} (listening on ${HOST})`);
