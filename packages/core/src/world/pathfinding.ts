import { join } from 'node:path';
import type { InteractionTarget } from '../../../knowledge/src/transports';
import { accountForSdk, registerRouteActor, withDoorPolicy } from '../door-policy';
import { mapAreas, separated } from '../components';
import { activeDanger, guardRoute, guardWalk } from '../danger';
import { legCache, routeDangerHash } from '../leg-cache';
import { blockedDoorsNear, doorBlock, doorBlocks, getKnownDoorFacts } from './filters';
import { cheb, tileKey, worldRepoRoot, type DoorBlock, type PathLength, type Tile } from './model';

let rsPath: { findLongPath: Function; getDoorAt: Function } | null = null;
let activePathPolicy: { owner: object; blocked: DoorBlock[] } | null = null;
const policySdks = new WeakSet<object>();

async function loadPathfinding() {
    if (!rsPath) rsPath = await import(join(worldRepoRoot, 'vendor', 'rs-sdk', 'sdk', 'pathfinding.ts'));
    return rsPath!;
}

/** Installs per-account door policy and danger guards on an SDK instance's findPath method. */
export async function installDoorPolicy(sdk: any, client?: unknown): Promise<void> {
    registerRouteActor(sdk, client);
    if (typeof sdk?.findPath !== 'function' || policySdks.has(sdk)) return;
    const pf = await loadPathfinding();
    const grid = await import('../../../../vendor/rs-sdk/server/vendor/rsmod-pathfinder');
    if (policySdks.has(sdk)) return;
    const original = sdk.findPath;
    sdk.findPath = function(x: number, z: number, ...args: unknown[]) {
        const state = sdk.getState(), p = state?.player;
        if (!p) return original.call(sdk, x, z, ...args);
        (pf as any).initPathfinding();
        const from = { x: p.worldX, z: p.worldZ, level: p.level };
        const blocks = blockedDoorsNear(from, { x, z, level: p.level }, accountForSdk(sdk))
            .map(b => b.whenAxis === undefined ? { ...b, ...pf.getDoorAt(b.level, b.x, b.z) } : b);
        return guardWalk(grid, accountForSdk(sdk), from, { x, z, level: p.level }, 32, () => withDoorPolicy(grid, blocks, () => original.call(sdk, x, z, ...args)));
    };
    policySdks.add(sdk);
}

// Default walk cost: rs-sdk findLongPath turn points, summed as Chebyshev steps. Null if the path stops short.
export async function rsPathLength(): Promise<PathLength> {
    const pf = await loadPathfinding();
    const grid = await import('../../../../vendor/rs-sdk/server/vendor/rsmod-pathfinder');
    const owner = {};
    const scoped = <T>(blocked: DoorBlock[], query: () => T): T => {
        if (activePathPolicy?.owner === owner && activePathPolicy.blocked === blocked) return query();
        if (activePathPolicy) throw Error('A different route policy cannot nest inside an active query');
        (pf as any).initPathfinding();
        const policy = blocked.map(b => b.whenAxis === undefined ? { ...b, ...pf.getDoorAt(b.level, b.x, b.z) } : b);
        return withDoorPolicy(grid, policy, () => {
            activePathPolicy = { owner, blocked };
            try { return query(); } finally { activePathPolicy = null; }
        });
    };
    // Searched legs are kept on disk (leg-cache.ts) under hashes of the doors kept shut and the danger key. A leg
    // the cheap checks refuse is not stored: refusing it again costs less than reading it back.
    const cache = legCache(), policyKeys = new WeakMap<DoorBlock[], string>(), dangerKeys = new WeakMap<object, string>();
    const measureNow = (from: Tile, to: Tile, blocked: DoorBlock[], tol: number, interaction?: InteractionTarget): number | null => {
        const pts: Tile[] | null = scoped(blocked, () => {
            if (!interaction) return pf.findLongPath(from.level, from.x, from.z, to.x, to.z, 500);
            const q = interaction;
            if (grid.reached(from.level, from.x, from.z, to.x, to.z, q.width, q.height, 1, q.angle, q.shape, q.blockAccessFlags)) return [];
            const raw = grid.findLongPath(from.level, from.x, from.z, to.x, to.z, 1, q.width, q.height, q.angle, q.shape, false, q.blockAccessFlags, 500, grid.CollisionType.NORMAL);
            const path = Array.from(raw, p => ({ x: (p >>> 14) & 0x3fff, z: p & 0x3fff, level: (p >>> 28) & 3 }));
            const end = path.at(-1) ?? from;
            return grid.reached(from.level, end.x, end.z, to.x, to.z, q.width, q.height, 1, q.angle, q.shape, q.blockAccessFlags) ? path : null;
        });
        if (pts === null) return null;
        if (interaction) {
            let len = 0, prev = from;
            for (const p of pts) { len += cheb(prev, p); prev = p; }
            return len;
        }
        if (pts.length === 0) return cheb(from, to) <= tol ? 0 : null;
        const last = pts[pts.length - 1]!;
        if (cheb(last, to) > tol) return null;
        let len = 0, prev = from;
        for (const p of pts) { len += cheb(prev, p); prev = p; }
        return len;
    };
    const measure: PathLength = (from, to, blocked, tol, interaction) => {
        if (from.level !== to.level) return null;
        (pf as any).initPathfinding();
        if (!interaction && tol === 0 && tileKey(from) !== tileKey(to) && !(pf as any).isTileWalkable(to.level, to.x, to.z)) return null;
        // Different connected areas: no walk exists, and the search would scan the whole grid (components.ts).
        if (separated(mapAreas(pf, grid, worldRepoRoot), from, to, tol, interaction, interaction && ((x, z) => grid.reached(to.level, x, z, to.x, to.z, interaction.width, interaction.height, 1, interaction.angle, interaction.shape, interaction.blockAccessFlags)))) return null;
        const d = activeDanger(), shut = policyKeys.get(blocked) ?? (policyKeys.set(blocked, cache.hash(blocked)), policyKeys.get(blocked)!);
        const dk = d ? dangerKeys.get(d) ?? (dangerKeys.set(d, routeDangerHash(d, cache)), dangerKeys.get(d)!) : '-';
        const k = `kept:${shut}${dk}${tileKey(from)}>${tileKey(to)}:${tol}${interaction ? ':' + cache.hash(interaction) : ''}`;
        const cached = cache.get(k);
        if (cached !== undefined) return cached;
        const v = measureNow(from, to, blocked, tol, interaction);
        cache.set(k, v);
        return v;
    };
    measure.withPolicy = scoped;
    measure.walkable = t => { (pf as any).initPathfinding(); return (pf as any).isTileWalkable(t.level, t.x, t.z); };
    measure.areaOf = t => mapAreas(pf, grid, worldRepoRoot).area(t.level, t.x, t.z);
    // Ground of monsters that would kill this account is closed for the whole search (danger.ts).
    // Labels first: built under closed danger tiles they would carry one account's danger to every account.
    measure.withDanger = (acct, from, to, query) => { mapAreas(pf, grid, worldRepoRoot); try { return guardRoute(grid, acct, [from, to], query); } finally { cache.save(); } };
    return measure;
}

// Finds the operable face of the exact placed transport, with the same native
// reach semantics and current account policy as its route cost. No grid mask
// stays active while the caller awaits movement.
export async function interactionApproach(sdk: any, at: Tile, q: InteractionTarget): Promise<Tile | null> {
    const pf = await loadPathfinding(), grid = await import('../../../../vendor/rs-sdk/server/vendor/rsmod-pathfinder');
    const state = sdk.getState(), p = state?.player;
    if (!p || p.level !== at.level || !state.nearbyLocs?.some((l: any) => l.id === q.id && l.x === at.x && l.z === at.z && l.level === at.level)) return null;
    (pf as any).initPathfinding();
    const acct = accountForSdk(sdk), facts = getKnownDoorFacts();
    const blocked = facts.filter(d => doorBlocks(d, acct)).map(doorBlock).map(b => b.whenAxis === undefined ? { ...b, ...pf.getDoorAt(b.level, b.x, b.z) } : b);
    return withDoorPolicy(grid, blocked, () => {
        const from = { x: p.worldX, z: p.worldZ, level: p.level };
        const reached = (t: Tile) => grid.reached(t.level, t.x, t.z, at.x, at.z, q.width, q.height, 1, q.angle, q.shape, q.blockAccessFlags);
        if (reached(from)) return from;
        const path = grid.findLongPath(from.level, from.x, from.z, at.x, at.z, 1, q.width, q.height, q.angle, q.shape, false, q.blockAccessFlags, 500, grid.CollisionType.NORMAL);
        if (!path.length) return null;
        const packed = path[path.length - 1]!, end = { x: (packed >>> 14) & 0x3fff, z: packed & 0x3fff, level: (packed >>> 28) & 3 };
        return reached(end) ? end : null;
    });
}
