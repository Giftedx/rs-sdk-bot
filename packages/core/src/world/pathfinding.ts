import { join } from 'node:path';
import type { InteractionTarget } from '../../../knowledge/src/transports';
import { accountForSdk, directionalMasks, registerRouteActor, withDoorPolicy } from '../door-policy';
import { eitherWay, labelAreas, mapAreas, separated, type Labels } from '../components';
import { activeDanger, closedOf, combatLevel, escapeTiles, routeHarmKeep, guardRoute, guardWalk, withOpened, npcReach, pack, planAroundHarm, setDangerDoorAt, stateWalkProfile, type DangerScope, type NpcReach } from '../danger';
import { legCache, routeDangerHash, type LegCache } from '../leg-cache';
import { blockedDoorsNear, doorBlock, doorBlocks, getKnownDoorFacts } from './filters';
import { npcBlockTiles, withNpcBlocks } from './npc-blocks';
import { NO_CHANGES, WAYPOINT_LIMIT, changeBuilder, hintLengths, legKey, tileTable, windowKey, withHint, type ChangeTable } from './leg-key';
import { cheb, tileKey, worldRepoRoot, type DoorBlock, type PathLength, type Tile } from './model';
import { unwrapGuarded } from '../worker-execution';

let rsPath: { findLongPath: Function; getDoorAt: Function } | null = null;
let activePathPolicy: { owner: object; blocked: DoorBlock[] } | null = null;
// Scope labels (rsPathLength labelScope): measured nulls in one scope before it is labelled, scopes kept labelled, and
// scopes whose nulls are counted.
const SCOPE_LABEL_NULLS = 64, SCOPE_LABEL_KEEP = 3, SCOPE_NULL_KEYS = 256;
const policySdks = new WeakSet<object>();

async function loadPathfinding() {
    if (!rsPath) { rsPath = await import(join(worldRepoRoot, 'vendor', 'rs-sdk', 'sdk', 'pathfinding.ts')); setDangerDoorAt(rsPath!.getDoorAt as Parameters<typeof setDangerDoorAt>[0]); }
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
    let reach: NpcReach | undefined;
    raw.findPath = function(x: number, z: number, ...args: unknown[]) {
        const state = raw.getState(), p = state?.player;
        if (!p) return original.call(raw, x, z, ...args);
        (pf as any).initPathfinding();
        const from = { x: p.worldX, z: p.worldZ, level: p.level };
        const blocks = blockedDoorsNear(from, { x, z, level: p.level }, accountForSdk(raw))
            .map(b => b.whenAxis === undefined ? { ...b, ...pf.getDoorAt(b.level, b.x, b.z) } : b);
        const npcTiles = npcBlockTiles(Array.isArray(state.nearbyNpcs) ? state.nearbyNpcs : [], from, { x, z, level: p.level });
        const acct = accountForSdk(raw);
        const find = () => guardWalk(grid, acct, from, { x, z, level: p.level }, 32, () => withDoorPolicy(grid, blocks, () => withNpcBlocks(grid, npcTiles, () => original.call(raw, x, z, ...args))));
        // Harm ground (danger/exposure.ts): a path that hunters of this account can attack goes round them when the way
        // round is inside its bound. Outermost, so the NPC floods read the plain grid.
        return planAroundHarm(grid, stateWalkProfile(acct, p), p.level, from, { x, z }, 32, find, { reach: reach ??= npcReach(grid, pf.getDoorAt as any) });
    };
    policySdks.add(raw);
}

// Default walk cost: rs-sdk findLongPath turn points, summed as Chebyshev steps. Null if the path stops short.
// `opts.legs`: the store of measured walk lengths (default the shared file, leg-cache.ts); a test passes an empty one.
// `opts.lazyLabels`: build the map labels at the first query that reads them, not now. Built now, they are shared with
// this process's route worker (route-plan.ts), which then builds none of its own.
export async function rsPathLength(opts: { legs?: LegCache; lazyLabels?: boolean } = {}): Promise<PathLength> {
    const pf = await loadPathfinding();
    const grid = await import('../../../../vendor/rs-sdk/server/vendor/rsmod-pathfinder');
    const owner = {};
    const resolved = (blocked: DoorBlock[]): DoorBlock[] => blocked.map(b => b.whenAxis === undefined ? { ...b, ...pf.getDoorAt(b.level, b.x, b.z) } : b);
    const scoped = <T>(blocked: DoorBlock[], query: () => T): T => {
        if (activePathPolicy?.owner === owner && activePathPolicy.blocked === blocked) return query();
        if (activePathPolicy) throw Error('A different route policy cannot nest inside an active query');
        (pf as any).initPathfinding();
        const policy = resolved(blocked);
        return withDoorPolicy(grid, policy, () => {
            activePathPolicy = { owner, blocked };
            try { return query(); } finally { activePathPolicy = null; }
        });
    };
    // Searched legs are kept on disk (leg-cache.ts) under the changes of the scope that the leg's search could read
    // (leg-key.ts), so accounts and quest steps with other doors or danger far from a leg share its length. A leg the
    // cheap checks refuse is not stored: refusing it again costs less than reading it back.
    const cache = opts.legs ?? legCache(), policyKeys = new WeakMap<DoorBlock[], string>(), dangerKeys = new WeakMap<object, string>(), interactionKeys = new WeakMap<object, string>();
    // With lazyLabels, a process whose plans go to the route service (route-plan.ts) and that never asks this world
    // for a length holds no map labels.
    let mapLabels: Labels | null = null;
    const areasOf = (): Labels => mapLabels ??= mapAreas(pf, grid, worldRepoRoot);
    if (!opts.lazyLabels) areasOf();
    // The map labels (`areasOf`) join tiles with every door open and no danger ground closed. A scope (the doors an
    // account keeps shut and the ground of monsters that would kill it) can split one map area in two: for a 10 HP
    // account White Wolf Mountain closes, and Burthorpe and Ardougne stay in one map area. Each leg between the two
    // parts then measures null only after a findLongPath flood of up to 524,288 tiles (5 to 8 ms): a cold search from
    // Burthorpe to Ardougne made 20,040 such floods, 106 s of its 126 s. After SCOPE_LABEL_NULLS measured nulls in one
    // scope, the scope gets its own labels (about 1 s for every level) and a leg between two of its areas is null at
    // once. A search with fewer nulls pays nothing.
    const scopeLabels = new Map<string, Labels>(), scopeNulls = new Map<string, number>();
    const plainScope = (blocked: DoorBlock[]) => { const d = activeDanger(); return blocked.length === 0 && (!d || d.key === 'none'); };
    const labelScope = (prefix: string, blocked: DoorBlock[]) => {
        if (scopeLabels.has(prefix)) return;
        if (plainScope(blocked)) return; // the map labels already hold for this scope
        const n = (scopeNulls.get(prefix) ?? 0) + 1;
        if (n < SCOPE_LABEL_NULLS) {
            if (!scopeNulls.has(prefix) && scopeNulls.size >= SCOPE_NULL_KEYS) scopeNulls.delete(scopeNulls.keys().next().value!);
            scopeNulls.set(prefix, n);
            return;
        }
        buildScopeLabels(prefix, blocked);
    };
    const buildScopeLabels = (prefix: string, blocked: DoorBlock[]) => {
        scopeNulls.delete(prefix);
        const zones: [number, number, number][] = [];
        for (const k of areasOf().zones.keys()) zones.push([k >>> 28, ((k >>> 14) & 0x3fff) << 3, (k & 0x3fff) << 3]);
        // eitherWay: a one-way door of the policy joins its two sides, so a walk out through it is never refused.
        const walkable = (l: number, x: number, z: number): boolean => (pf as any).isTileWalkable(l, x, z);
        const oneWay = new Set(directionalMasks(blocked).map(m => pack(m.level, m.x, m.z)));
        const labels = scoped(blocked, () => labelAreas(zones, walkable,
            eitherWay(walkable, (l, x, z, dx, dz) => grid.canTravel(l, x, z, dx, dz, 1, 0, grid.CollisionType.NORMAL),
                (l, x, z) => oneWay.has(pack(l, x, z)))));
        if (scopeLabels.size >= SCOPE_LABEL_KEEP) scopeLabels.delete(scopeLabels.keys().next().value!);
        scopeLabels.set(prefix, labels);
    };
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
    // The changes of a scope as tables (leg-key.ts): the walls of its shut doors and the tiles its danger rule closed.
    const doorTables = new WeakMap<DoorBlock[], ChangeTable>(), dangerTables = new WeakMap<DangerScope, ChangeTable>(), openedTables = new WeakMap<DangerScope, ChangeTable>();
    let tablesBlocked: DoorBlock[] | undefined, tablesDanger: DangerScope | null | undefined, tables: ChangeTable[] = [NO_CHANGES, NO_CHANGES];
    const doorChanges = (blocked: DoorBlock[]): ChangeTable => {
        (pf as any).initPathfinding();
        const policy = resolved(blocked), changes = changeBuilder();
        // The two kinds of change withDoorPolicy makes.
        for (const b of policy) if (b.whenAxis === undefined && Number.isInteger(b.angle) && Number.isInteger(b.shape)) changes.add(b.level, b.x, b.z, 0, b.angle!, b.shape!, b.blockrange ? 1 : 0);
        for (const m of directionalMasks(policy)) changes.add(m.level, m.x, m.z, 1, m.mask);
        return changes.build();
    };
    // A danger scope is new for each search, but the tiles it closed are the same for each search of an account whose
    // ends stand outside closed ground: the newest tables are kept with the tile lists they were built from (a weak
    // account's 389,378 tiles: 28 to 41 ms to build, 1 to 3 ms to compare).
    const recentDanger: { lists: Int32Array[]; table: ChangeTable }[] = [];
    const sameTiles = (a: Int32Array[], b: Int32Array[]): boolean => {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            const x = a[i]!, y = b[i]!;
            if (x.length !== y.length) return false;
            for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return false;
        }
        return true;
    };
    const dangerChanges = (d: DangerScope): ChangeTable => {
        const lists: Int32Array[] = [];
        for (let s: DangerScope | null = d; s; s = s.outer) lists.push(s.closed);
        const seen = recentDanger.find(r => sameTiles(r.lists, lists));
        if (seen) return seen.table;
        const table = tileTable(lists, 2);
        if (recentDanger.length >= 4) recentDanger.shift();
        recentDanger.push({ lists, table });
        return table;
    };
    const scopeTables = (blocked: DoorBlock[]): ChangeTable[] => {
        const d = activeDanger();
        if (blocked === tablesBlocked && d === tablesDanger) return tables;
        let doors = doorTables.get(blocked);
        if (!doors) { doors = blocked.length ? doorChanges(blocked) : NO_CHANGES; doorTables.set(blocked, doors); }
        // A scope that opened tiles for a walk from a landing (danger/tiles.ts withOpened) shares the table of the scope
        // under it and adds a table of the tiles it opened, so keys differ from both the shut and the plain grid.
        const base = d?.opened ? d.outer : d;
        let danger = NO_CHANGES;
        if (base) { danger = dangerTables.get(base) ?? dangerChanges(base); dangerTables.set(base, danger); }
        tablesBlocked = blocked; tablesDanger = d; tables = [doors, danger];
        if (d?.opened) { let o = openedTables.get(d); if (!o) openedTables.set(d, o = tileTable([d.opened], 3)); tables = [doors, danger, o]; }
        return tables;
    };
    const interactionKey = (q: InteractionTarget): string => {
        let cachedIk = interactionKeys.get(q);
        if (cachedIk === undefined) { cachedIk = cache.hash(q); interactionKeys.set(q, cachedIk); }
        return cachedIk;
    };
    // The areas of the tiles that reach loc `q` at `to` (within max(tol, 1)); null when one is outside the loaded map.
    const reachAreas = (to: Tile, tol: number, q: InteractionTarget, labels: Labels): number[] | null => {
        const r = Math.max(tol, 1), list: number[] = [];
        for (let x = to.x - r; x <= to.x + q.width - 1 + r; x++) for (let z = to.z - r; z <= to.z + q.height - 1 + r; z++) {
            if (!grid.reached(to.level, x, z, to.x, to.z, q.width, q.height, 1, q.angle, q.shape, q.blockAccessFlags)) continue;
            const v = labels.area(to.level, x, z);
            if (v === -2) return null;
            if (v >= 0 && !list.includes(v)) list.push(v);
        }
        return list;
    };
    const separatedInteraction = (from: Tile, to: Tile, blocked: DoorBlock[], tol: number, q: InteractionTarget, labels: Labels = areasOf()): boolean => {
        if (from.level !== to.level) return false;
        const lvl = from.level;
        const own = labels.area(lvl, from.x, from.z);
        if (own === -2) return false;
        let starts: number[] | null = null;
        if (own < 0) {
            starts = [];
            for (let x = from.x - 1; x <= from.x + 1; x++) for (let z = from.z - 1; z <= from.z + 1; z++) {
                const v = labels.area(lvl, x, z);
                if (v === -2) return false;
                if (v >= 0 && !starts.includes(v)) starts.push(v);
            }
            if (starts.length === 0) return false;
        }
        scopePrefix(blocked);
        const key = `${labels === mapLabels ? 'm' : 's'}:${to.x},${to.z},${lvl}:${tol}:${interactionKey(q)}`;
        let targetAreas = interactionAreasCache.get(key);
        if (targetAreas === undefined) interactionAreasCache.set(key, targetAreas = reachAreas(to, tol, q, labels));
        if (!targetAreas || targetAreas.length === 0) return false;
        if (own >= 0) return !targetAreas.includes(own);
        for (let i = 0; i < starts!.length; i++) if (targetAreas.includes(starts![i]!)) return false;
        return true;
    };
    // measureNow sets `reachedGoal` when the flood took the goal from its queue: the length then depends only on the
    // tiles near the walk (leg-key.ts legKey), and any other result on the whole findLongPath grid (windowKey).
    let reachedGoal = false;
    // One flood from a walk's start serves every later walk from that start in the same scope (doors and danger). A
    // cold search from Varrock to Ardougne measured 9,472 walks from 516 starts. The flood is a breadth-first search
    // over grid.canTravel steps (the moves findLongPath takes) inside a box of FLOOD_R tiles: from Lumbridge it settles
    // 113,368 tiles in 25 ms, where one findLongPath leg of 150 to 300 tiles costs 3.75 ms; its distances equalled the
    // findLongPath lengths on 4,773 of 4,773 walks of a search. It keeps only the distances to the route graph's tiles
    // (addTargets), so a few hundred floods stay in memory. A start gets its flood on its second measured walk.
    const FLOOD_R = 340, FLOOD_SIDE = 2 * FLOOD_R + 1, FLOOD_KEEP = 512, FLOOD_AFTER = 2;
    type Flood = { dist: Map<number, number>; complete: boolean; targets: number };
    const floods = new Map<string, Flood>(), floodMisses = new Map<string, number>();
    let floodsBuilt = 0;
    const scopeIds = new WeakMap<object, number>(), noDanger = {};
    let nextScopeId = 0;
    const idOf = (o: object) => { let id = scopeIds.get(o); if (id === undefined) scopeIds.set(o, id = ++nextScopeId); return id; };
    // The tiles a flood keeps: route graph tiles in 64-tile buckets.
    const targetSet = new Map<number, number>(), targetBuckets = new Map<number, number[]>();
    const bucketOf = (level: number, x: number, z: number) => (level << 16) | ((x >> 6) << 8) | (z >> 6);
    const addTargets = (tiles: readonly Tile[]) => {
        for (const t of tiles) {
            const k = pack(t.level, t.x, t.z);
            if (targetSet.has(k)) continue;
            targetSet.set(k, targetSet.size);
            const b = bucketOf(t.level, t.x, t.z), list = targetBuckets.get(b);
            if (list) list.push(k); else targetBuckets.set(b, [k]);
        }
    };
    const seen = new Uint16Array(FLOOD_SIDE * FLOOD_SIDE), qx = new Int32Array(FLOOD_SIDE * FLOOD_SIDE), qz = new Int32Array(FLOOD_SIDE * FLOOD_SIDE);
    const floodFrom = (from: Tile): Flood => {
        const x0 = from.x - FLOOD_R, z0 = from.z - FLOOD_R, lvl = from.level;
        let head = 0, tail = 0, complete = true;
        qx[tail] = from.x; qz[tail++] = from.z; seen[FLOOD_R * FLOOD_SIDE + FLOOD_R] = 1;
        while (head < tail) {
            const x = qx[head]!, z = qz[head++]!, d = seen[(x - x0) * FLOOD_SIDE + (z - z0)]! + 1;
            for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
                if (!dx && !dz) continue;
                const nx = x + dx, nz = z + dz;
                if (nx < x0 || nz < z0 || nx >= x0 + FLOOD_SIDE || nz >= z0 + FLOOD_SIDE) { if (complete && grid.canTravel(lvl, x, z, dx, dz, 1, 0, grid.CollisionType.NORMAL)) complete = false; continue; }
                const i = (nx - x0) * FLOOD_SIDE + (nz - z0);
                if (seen[i] || !grid.canTravel(lvl, x, z, dx, dz, 1, 0, grid.CollisionType.NORMAL)) continue;
                seen[i] = d; qx[tail] = nx; qz[tail++] = nz;
            }
        }
        const dist = new Map<number, number>();
        for (let bx = x0 >> 6; bx <= (x0 + FLOOD_SIDE - 1) >> 6; bx++) for (let bz = z0 >> 6; bz <= (z0 + FLOOD_SIDE - 1) >> 6; bz++) {
            for (const k of targetBuckets.get(bucketOf(lvl, bx << 6, bz << 6)) ?? []) {
                const x = (k >>> 14) & 0x3fff, z = k & 0x3fff;
                if (x < x0 || z < z0 || x >= x0 + FLOOD_SIDE || z >= z0 + FLOOD_SIDE) continue;
                const d = seen[(x - x0) * FLOOD_SIDE + (z - z0)]!;
                if (d) dist.set(k, d - 1);
            }
        }
        for (let i = 0; i < tail; i++) seen[(qx[i]! - x0) * FLOOD_SIDE + (qz[i]! - z0)] = 0;
        return { dist, complete, targets: targetSet.size };
    };
    // The length of a walk read from the flood of its start, null when the walk has no path, or undefined when the
    // flood does not decide it (the walk then goes to findLongPath). A path that leaves the box is at least
    // 2 * (FLOOD_R + 1) - cheb(start, goal) long, so a shorter distance inside the box is the shortest path.
    const floodLength = (from: Tile, to: Tile, blocked: DoorBlock[], tol: number): number | null | undefined => {
        if (from.level !== to.level) return undefined;
        const c = cheb(from, to), goal = pack(to.level, to.x, to.z);
        if (c > FLOOD_R || !targetSet.has(goal)) return undefined;
        const key = `${blocked.length ? idOf(blocked) : 0}:${idOf(activeDanger() ?? noDanger)}:${from.level},${from.x},${from.z}`;
        let f = floods.get(key);
        if (!f) {
            const n = (floodMisses.get(key) ?? 0) + 1;
            if (n < FLOOD_AFTER) {
                if (floodMisses.size >= 8192) floodMisses.delete(floodMisses.keys().next().value!);
                floodMisses.set(key, n);
                return undefined;
            }
            floodMisses.delete(key);
            f = scoped(blocked, () => floodFrom(from));
            floodsBuilt++;
            if (floods.size >= FLOOD_KEEP) floods.delete(floods.keys().next().value!);
            floods.set(key, f);
        }
        // A tile added after the flood was taken is not in it.
        if (targetSet.get(goal)! >= f.targets) return undefined;
        const d = f.dist.get(goal);
        if (d !== undefined) return d <= 2 * (FLOOD_R + 1) - c ? d : undefined;
        // A goal the complete flood did not reach has no path. With a tolerance, findLongPath walks to the nearest
        // tile it reaches, which the flood does not choose.
        return tol === 0 && f.complete ? null : undefined;
    };
    const measureNow = (from: Tile, to: Tile, blocked: DoorBlock[], tol: number, interaction?: InteractionTarget): number | null => {
        reachedGoal = false;
        const same = from.x === to.x && from.z === to.z;
        if (!interaction && !same && process.env.ROUTE_FLOOD !== '0') {
            const v = floodLength(from, to, blocked, tol);
            if (v !== undefined) { reachedGoal = v !== null; return v; }
        }
        if (!interaction) {
            // A leg that must end on its goal asks for no closest approach (moveNear false): a goal the flood does not
            // reach then returns no path at once, where moveNear scans the 2048x2048 grid for the nearest tile first
            // (8.3 ms against 6.8 ms a null leg, the same lengths on 3,776 legs of a weak account's search).
            if (tol === 0) return scoped(blocked, () => {
                const raw: Uint32Array = grid.findLongPath(from.level, from.x, from.z, to.x, to.z, 1, 1, 1, 0, -1, false, 0, WAYPOINT_LIMIT, grid.CollisionType.NORMAL);
                if (!raw.length) { reachedGoal = same; return same ? 0 : null; }
                const lastPacked = raw[raw.length - 1]!;
                if (((lastPacked >>> 14) & 0x3fff) !== to.x || (lastPacked & 0x3fff) !== to.z) return null;
                // A cut path drops the goal end first (pathfinder.rs pop_back), so a path that ends on the goal is whole.
                reachedGoal = true;
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
            const pts: Tile[] | null = scoped(blocked, () => pf.findLongPath(from.level, from.x, from.z, to.x, to.z, WAYPOINT_LIMIT));
            if (pts === null) return null;
            if (pts.length === 0) { reachedGoal = same; return cheb(from, to) <= tol ? 0 : null; }
            const last = pts[pts.length - 1]!;
            if (cheb(last, to) > tol) return null;
            reachedGoal = last.x === to.x && last.z === to.z;
            let len = 0, prev = from;
            for (let i = 0; i < pts.length; i++) { const p = pts[i]!; len += cheb(prev, p); prev = p; }
            return len;
        }
        const q = interaction;
        return scoped(blocked, () => {
            if (grid.reached(from.level, from.x, from.z, to.x, to.z, q.width, q.height, 1, q.angle, q.shape, q.blockAccessFlags)) { reachedGoal = true; return 0; }
            const raw: Uint32Array = grid.findLongPath(from.level, from.x, from.z, to.x, to.z, 1, q.width, q.height, q.angle, q.shape, false, q.blockAccessFlags, WAYPOINT_LIMIT, grid.CollisionType.NORMAL);
            if (!raw.length) return null;
            const lastPacked = raw[raw.length - 1]!;
            const endX = (lastPacked >>> 14) & 0x3fff, endZ = lastPacked & 0x3fff;
            if (!grid.reached(from.level, endX, endZ, to.x, to.z, q.width, q.height, 1, q.angle, q.shape, q.blockAccessFlags)) return null;
            // A path at the waypoint limit may be cut short of the tile the flood reached the loc from.
            reachedGoal = raw.length < WAYPOINT_LIMIT;
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
    // Rows of one leg (leg-key.ts): `<leg>|h` the newest exact lengths; `<leg>|<len>|<changes near the walk>` an exact
    // length; `<leg>|w|<changes in the grid>` any other result. A row of the prior store (leg-cache.ts) is read with
    // the whole-scope key it was written with and copied into the rows of the current scope.
    const lookupOrMeasure = (from: Tile, to: Tile, blocked: DoorBlock[], tol: number, interaction?: InteractionTarget): number | null => {
        const prefix = scopePrefix(blocked);
        const ik = interaction ? `:${interactionKey(interaction)}` : '';
        const leg = `${from.x},${from.z},${from.level}>${to.x},${to.z},${to.level}:${tol}${ik}`;
        const changes = scopeTables(blocked), span = interaction ? Math.max(interaction.width, interaction.height) : 1;
        const hint = cache.get(`${leg}|h`);
        if (typeof hint === 'number') for (const len of hintLengths(hint)) {
            const v = cache.get(`${leg}|${len}|${legKey(changes, from, to, len, span)}`);
            if (v !== undefined) return v;
        }
        const gridKey = `${leg}|w|${windowKey(changes, from)}`;
        const flooded = cache.get(gridKey);
        if (flooded !== undefined) return flooded;
        let v = cache.prior?.(`${prefix}${leg}`), exact: boolean;
        // A prior length that ends on its goal: a non-null length of a leg with no tolerance or of a loc approach
        // under the waypoint limit (measureNow).
        if (v !== undefined) exact = v !== null && (tol === 0 && !interaction || !!interaction && v < WAYPOINT_LIMIT);
        else { v = measureNow(from, to, blocked, tol, interaction); exact = reachedGoal; }
        if (exact && v !== null) {
            cache.set(`${leg}|${v}|${legKey(changes, from, to, v, span)}`, v);
            const next = withHint(hint, v);
            if (next !== hint) cache.set(`${leg}|h`, next);
        } else cache.set(gridKey, v);
        if (v === null) labelScope(prefix, blocked);
        return v;
    };
    // True when the labels of the active scope (labelScope) put the two ends in areas no walk joins.
    const scopeSeparated = (from: Tile, to: Tile, blocked: DoorBlock[], tol: number, interaction?: InteractionTarget): boolean => {
        if (scopeLabels.size === 0) return false;
        const labels = scopeLabels.get(scopePrefix(blocked));
        if (!labels) return false;
        return interaction ? separatedInteraction(from, to, blocked, tol, interaction, labels) : separated(labels, from, to, tol);
    };
    const measure: PathLength = (from, to, blocked, tol, interaction) => {
        if (from.level !== to.level) return null;
        if (!interaction && tol === 0 && (from.x !== to.x || from.z !== to.z) && !(pf as any).isTileWalkable(to.level, to.x, to.z)) return null;
        // Different connected areas: no walk exists, and the search would scan the whole grid (components.ts).
        if (interaction ? separatedInteraction(from, to, blocked, tol, interaction) : separated(areasOf(), from, to, tol)) return null;
        if (scopeSeparated(from, to, blocked, tol, interaction)) return null;
        return lookupOrMeasure(from, to, blocked, tol, interaction);
    };
    measure.measurePrechecked = (from, to, blocked, tol, interaction) => {
        if (from.level !== to.level) return null;
        if (interaction) {
            if (separatedInteraction(from, to, blocked, tol, interaction)) return null;
        } else if (tol === 0 && (from.x !== to.x || from.z !== to.z) && !(pf as any).isTileWalkable(to.level, to.x, to.z)) {
            return null;
        }
        if (scopeSeparated(from, to, blocked, tol, interaction)) return null;
        return lookupOrMeasure(from, to, blocked, tol, interaction);
    };
    measure.withPolicy = scoped;
    measure.walkable = t => { (pf as any).initPathfinding(); return (pf as any).isTileWalkable(t.level, t.x, t.z); };
    measure.areaOf = t => areasOf().area(t.level, t.x, t.z);
    measure.addTargets = addTargets;
    measure.floodCount = () => floodsBuilt;
    // Labels that exist: the map labels of a plain scope, or the labels that SCOPE_LABEL_NULLS measured nulls built.
    // None are built here, so a search that can still finish does not pay a label flood inside its budget.
    measure.scopeAreas = blocked => {
        const labels = plainScope(blocked) ? areasOf() : scopeLabels.get(scopePrefix(blocked));
        if (!labels) return null;
        return {
            area: (l, x, z) => labels.area(l, x, z),
            reach: (to, tol, q) => reachAreas(to, tol, q, labels),
            // A walk from a tile that is not walkable leaves it by one step to a neighbour (findLongPath's first step).
            step: t => {
                const out: number[] = [];
                for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
                    if ((dx || dz) && grid.canTravel(t.level, t.x, t.z, dx, dz, 1, 0, grid.CollisionType.NORMAL)) {
                        const v = labels.area(t.level, t.x + dx, t.z + dz);
                        if (v === -2) return null;
                        if (v >= 0 && !out.includes(v)) out.push(v);
                    }
                }
                return out;
            },
            // The areas a walk from `at` reaches with `open` open again: a flood from `at` through the opened tiles,
            // which stops at the first labelled tile past them.
            escape: (at, open) => {
                const inside = new Set<number>(open), out: number[] = [];
                return withOpened(grid, open, `${at.level},${at.x},${at.z}`, () => {
                    const seen = new Set<number>([pack(at.level, at.x, at.z)]), qx = [at.x], qz = [at.z];
                    for (let i = 0; i < qx.length; i++) {
                        const x = qx[i]!, z = qz[i]!;
                        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
                            if (!(dx || dz) || !grid.canTravel(at.level, x, z, dx, dz, 1, 0, grid.CollisionType.NORMAL)) continue;
                            const k = pack(at.level, x + dx, z + dz);
                            if (seen.has(k)) continue;
                            seen.add(k);
                            if (inside.has(k)) { qx.push(x + dx); qz.push(z + dz); continue; }
                            const v = labels.area(at.level, x + dx, z + dz);
                            if (v >= 0 && !out.includes(v)) out.push(v);
                        }
                    }
                    return out;
                });
            },
        };
    };
    // Ground of monsters that would kill this account is closed for the whole search (danger.ts).
    // Labels first: built under closed danger tiles they would carry one account's danger to every account.
    measure.withDanger = (acct, from, to, query) => { try { return guardRoute(grid, acct, [from, to], query); } finally { interactionAreasCache.clear(); cache.save(); } };
    // A route landing inside the account's closed ground: the closed tiles of the squares that hold it (escapeTiles),
    // which a walk from that landing may cross as a walk from the route start does.
    // An account that avoids harm (guard.ts guardRoute) also has the harm squares holding the landing closed (exposure.ts routeHarmKeep).
    measure.escapeAt = (acct, at) => closedOf(acct.avoidHarm ? [...escapeTiles(acct, at), ...routeHarmKeep(combatLevel(acct.skills), [at]).tiles] : escapeTiles(acct, at));
    measure.withOpened = (open, at, query) => withOpened(grid, open, `${at.level},${at.x},${at.z}`, query);
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
