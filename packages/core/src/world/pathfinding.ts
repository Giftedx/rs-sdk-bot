import { join } from 'node:path';
import type { InteractionTarget } from '../../../knowledge/src/transports';
import { accountForSdk, registerRouteActor, withDoorPolicy } from '../door-policy';
import { mapAreas, separated } from '../components';
import { activeDanger, guardRoute, guardWalk } from '../danger';
import { legCache, routeDangerHash } from '../leg-cache';
import { blockedDoorsNear, doorBlock, doorBlocks, getKnownDoorFacts } from './filters';
import { cheb, tileKey, worldRepoRoot, type DoorBlock, type PathLength, type Tile } from './model';
import { unwrapGuarded } from '../worker-execution';

let rsPath: { findLongPath: Function; getDoorAt: Function } | null = null;
let activePathPolicy: { owner: object; blocked: DoorBlock[] } | null = null;
const policySdks = new WeakSet<object>();

async function loadPathfinding() {
    if (!rsPath) rsPath = await import(join(worldRepoRoot, 'vendor', 'rs-sdk', 'sdk', 'pathfinding.ts'));
    return rsPath!;
}

/** Installs per-account door policy and danger guards on an SDK instance's findPath method. */
export async function installDoorPolicy(sdk: any, client?: unknown): Promise<void> {
    const raw = unwrapGuarded(sdk);
    registerRouteActor(raw, client);
    if (typeof raw?.findPath !== 'function' || policySdks.has(raw)) return;
    const pf = await loadPathfinding();
    const grid = await import('../../../../vendor/rs-sdk/server/vendor/rsmod-pathfinder');
    if (policySdks.has(raw)) return;
    const original = raw.findPath;
    raw.findPath = function(x: number, z: number, ...args: unknown[]) {
        const state = raw.getState(), p = state?.player;
        if (!p) return original.call(raw, x, z, ...args);
        (pf as any).initPathfinding();
        const from = { x: p.worldX, z: p.worldZ, level: p.level };
        const blocks = blockedDoorsNear(from, { x, z, level: p.level }, accountForSdk(raw))
            .map(b => b.whenAxis === undefined ? { ...b, ...pf.getDoorAt(b.level, b.x, b.z) } : b);
        return guardWalk(grid, accountForSdk(raw), from, { x, z, level: p.level }, 32, () => withDoorPolicy(grid, blocks, () => original.call(raw, x, z, ...args)));
    };
    policySdks.add(raw);
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
    const cache = legCache(), policyKeys = new WeakMap<DoorBlock[], string>(), dangerKeys = new WeakMap<object, string>(), interactionKeys = new WeakMap<object, string>();
    const areas = mapAreas(pf, grid, worldRepoRoot);
    let lastBlocked: DoorBlock[] | undefined, lastShut = '', lastDanger: object | null | undefined, lastDk = '-';
    let interactionAreasScope = '';
    const interactionAreasCache = new Map<string, number[] | null>();
    const scopePrefix = (blocked: DoorBlock[]): string => {
        const d = activeDanger();
        let changed = false;
        if (blocked !== lastBlocked) {
            lastBlocked = blocked;
            let shut = policyKeys.get(blocked);
            if (shut === undefined) { shut = cache.hash(blocked); policyKeys.set(blocked, shut); }
            if (shut !== lastShut) { lastShut = shut; changed = true; }
        }
        if (d !== lastDanger) {
            lastDanger = d;
            let dk = '-';
            if (d) {
                const cached = dangerKeys.get(d);
                if (cached !== undefined) dk = cached;
                else { dk = routeDangerHash(d, cache); dangerKeys.set(d, dk); }
            }
            if (dk !== lastDk) { lastDk = dk; changed = true; }
        }
        if (changed) {
            interactionAreasScope = `kept:${lastShut}${lastDk}`;
            interactionAreasCache.clear();
        }
        return interactionAreasScope || (interactionAreasScope = `kept:${lastShut}${lastDk}`);
    };
    const interactionKey = (q: InteractionTarget): string => {
        let cachedIk = interactionKeys.get(q);
        if (cachedIk === undefined) { cachedIk = cache.hash(q); interactionKeys.set(q, cachedIk); }
        return cachedIk;
    };
    const separatedInteraction = (from: Tile, to: Tile, blocked: DoorBlock[], tol: number, q: InteractionTarget): boolean => {
        if (from.level !== to.level) return false;
        const lvl = from.level;
        const own = areas.area(lvl, from.x, from.z);
        if (own === -2) return false;
        let starts: number[] | null = null;
        if (own < 0) {
            starts = [];
            for (let x = from.x - 1; x <= from.x + 1; x++) for (let z = from.z - 1; z <= from.z + 1; z++) {
                const v = areas.area(lvl, x, z);
                if (v === -2) return false;
                if (v >= 0 && !starts.includes(v)) starts.push(v);
            }
            if (starts.length === 0) return false;
        }
        scopePrefix(blocked);
        const key = `${to.x},${to.z},${lvl}:${tol}:${interactionKey(q)}`;
        let targetAreas = interactionAreasCache.get(key);
        if (targetAreas === undefined) {
            const r = Math.max(tol, 1);
            const x0 = to.x - r, z0 = to.z - r, x1 = to.x + q.width - 1 + r, z1 = to.z + q.height - 1 + r;
            const list: number[] = [];
            let unknown = false;
            for (let x = x0; x <= x1 && !unknown; x++) for (let z = z0; z <= z1; z++) {
                if (!grid.reached(lvl, x, z, to.x, to.z, q.width, q.height, 1, q.angle, q.shape, q.blockAccessFlags)) continue;
                const v = areas.area(lvl, x, z);
                if (v === -2) { unknown = true; break; }
                if (v >= 0 && !list.includes(v)) list.push(v);
            }
            targetAreas = unknown ? null : list;
            interactionAreasCache.set(key, targetAreas);
        }
        if (!targetAreas || targetAreas.length === 0) return false;
        if (own >= 0) return !targetAreas.includes(own);
        for (let i = 0; i < starts!.length; i++) if (targetAreas.includes(starts![i]!)) return false;
        return true;
    };
    const measureNow = (from: Tile, to: Tile, blocked: DoorBlock[], tol: number, interaction?: InteractionTarget): number | null => {
        if (!interaction) {
            const pts: Tile[] | null = scoped(blocked, () => pf.findLongPath(from.level, from.x, from.z, to.x, to.z, 500));
            if (pts === null) return null;
            if (pts.length === 0) return cheb(from, to) <= tol ? 0 : null;
            const last = pts[pts.length - 1]!;
            if (cheb(last, to) > tol) return null;
            let len = 0, prev = from;
            for (let i = 0; i < pts.length; i++) { const p = pts[i]!; len += cheb(prev, p); prev = p; }
            return len;
        }
        const q = interaction;
        return scoped(blocked, () => {
            if (grid.reached(from.level, from.x, from.z, to.x, to.z, q.width, q.height, 1, q.angle, q.shape, q.blockAccessFlags)) return 0;
            const raw: Uint32Array = grid.findLongPath(from.level, from.x, from.z, to.x, to.z, 1, q.width, q.height, q.angle, q.shape, false, q.blockAccessFlags, 500, grid.CollisionType.NORMAL);
            if (!raw.length) return null;
            const lastPacked = raw[raw.length - 1]!;
            const endX = (lastPacked >>> 14) & 0x3fff, endZ = lastPacked & 0x3fff;
            if (!grid.reached(from.level, endX, endZ, to.x, to.z, q.width, q.height, 1, q.angle, q.shape, q.blockAccessFlags)) return null;
            let len = 0, px = from.x, pz = from.z;
            for (let i = 0; i < raw.length; i++) {
                const p = raw[i]!, nx = (p >>> 14) & 0x3fff, nz = p & 0x3fff;
                const dx = nx - px, dz = nz - pz;
                const adx = dx < 0 ? -dx : dx, adz = dz < 0 ? -dz : dz;
                len += adx > adz ? adx : adz;
                px = nx; pz = nz;
            }
            return len;
        });
    };
    const lookupOrMeasure = (from: Tile, to: Tile, blocked: DoorBlock[], tol: number, interaction?: InteractionTarget): number | null => {
        const prefix = scopePrefix(blocked);
        const ik = interaction ? `:${interactionKey(interaction)}` : '';
        const k = `${prefix}${from.x},${from.z},${from.level}>${to.x},${to.z},${to.level}:${tol}${ik}`;
        const cached = cache.get(k);
        if (cached !== undefined) return cached;
        const v = measureNow(from, to, blocked, tol, interaction);
        cache.set(k, v);
        return v;
    };
    const measure: PathLength = (from, to, blocked, tol, interaction) => {
        if (from.level !== to.level) return null;
        if (!interaction && tol === 0 && (from.x !== to.x || from.z !== to.z) && !(pf as any).isTileWalkable(to.level, to.x, to.z)) return null;
        // Different connected areas: no walk exists, and the search would scan the whole grid (components.ts).
        if (interaction ? separatedInteraction(from, to, blocked, tol, interaction) : separated(areas, from, to, tol)) return null;
        return lookupOrMeasure(from, to, blocked, tol, interaction);
    };
    measure.measurePrechecked = (from, to, blocked, tol, interaction) => {
        if (from.level !== to.level) return null;
        if (interaction) {
            if (separatedInteraction(from, to, blocked, tol, interaction)) return null;
        } else if (tol === 0 && (from.x !== to.x || from.z !== to.z) && !(pf as any).isTileWalkable(to.level, to.x, to.z)) {
            return null;
        }
        return lookupOrMeasure(from, to, blocked, tol, interaction);
    };
    measure.withPolicy = scoped;
    measure.walkable = t => { (pf as any).initPathfinding(); return (pf as any).isTileWalkable(t.level, t.x, t.z); };
    measure.areaOf = t => areas.area(t.level, t.x, t.z);
    // Ground of monsters that would kill this account is closed for the whole search (danger.ts).
    // Labels first: built under closed danger tiles they would carry one account's danger to every account.
    measure.withDanger = (acct, from, to, query) => { try { return guardRoute(grid, acct, [from, to], query); } finally { interactionAreasCache.clear(); cache.save(); } };
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
