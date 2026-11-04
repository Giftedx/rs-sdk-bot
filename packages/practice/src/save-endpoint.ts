// Practice-only save endpoint. Loaded with `bun --preload` into a local practice engine only when stack.ts receives
// enginePreload with PRACTICE_SAVE_PORT set. It changes no pinned source: it reads World and calls Player.save(false),
// which serializes without the market checkpoint, the same bytes a logout writes. World.cycle() is synchronous, so a
// request runs between two ticks and the snapshot is a whole tick boundary. It binds 127.0.0.1 only.
// Idea source: UberMouse/rs-sdk conductor `GET /save/<name>` (9df2d4c9, MIT). No code is copied.
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {isMainThread} from 'node:worker_threads';

export const SAVE_PORT_ENV = 'PRACTICE_SAVE_PORT';
export interface SaveWorld {
    currentTick: number;
    getPlayerByUsername(name: string): {save(checkpoint?: boolean): Uint8Array} | undefined;
    logoutRequests?: Map<string, unknown>;
}
const NAME = /^[a-z0-9_ ]{1,12}$/i;
const json = (body: unknown, status = 200) => Response.json(body, {status});

// GET /tick, GET /online/<name>, GET /save/<name>. Anything else is 404.
export function handleSaveRequest(world: SaveWorld, req: Request): Response {
    if (req.method !== 'GET') return json({error: 'method'}, 405);
    const parts = new URL(req.url).pathname.split('/').filter(Boolean);
    if (parts.length === 1 && parts[0] === 'tick') return json({tick: world.currentTick});
    const [route, raw] = parts;
    if (parts.length !== 2 || (route !== 'online' && route !== 'save')) return json({error: 'not found'}, 404);
    const name = decodeURIComponent(raw!).toLowerCase();
    if (!NAME.test(name)) return json({error: 'invalid name'}, 400);
    const player = world.getPlayerByUsername(name);
    const pendingLogout = world.logoutRequests?.has(name) ?? false;
    if (route === 'online') return json({tick: world.currentTick, online: !!player, pendingLogout});
    if (!player) return json({error: 'not online', tick: world.currentTick, pendingLogout}, 404);
    const bytes = player.save(false);
    return new Response(bytes.slice(), {headers: {'content-type': 'application/octet-stream', 'x-tick': String(world.currentTick)}});
}

export function serveSaves(world: SaveWorld, port: number) {
    return Bun.serve({hostname: '127.0.0.1', port, fetch: req => handleSaveRequest(world, req)});
}

async function installFromEngine(engineRoot: string, port: number) {
    const load = (p: string) => import(pathToFileURL(join(engineRoot, p)).href);
    // Same import order as shark-fishing-diagnostic.ts: the pack tools first, then World.
    await load('tools/pack/PackAll.ts');
    const World = (await load('src/engine/World.ts')).default as SaveWorld;
    serveSaves(World, port);
}

// Main engine thread only: the login/friend/logger worker threads must never load a second World.
if (!import.meta.main && isMainThread && process.env[SAVE_PORT_ENV])
    await installFromEngine(process.cwd(), Number(process.env[SAVE_PORT_ENV]));
