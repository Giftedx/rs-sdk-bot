// Haggis travel model loader and teleport, spirit-tree, gnome-glider, and Wilderness lever leg routing.
import { readFileSync } from 'node:fs';
import { leg, legTicks, loadTravel, type Place, type TravelModel } from '../travel';
import { BOARDS_FILE } from './model';

interface TeleportSite {
    id: string;
    place: string;
    magicLevel: number;
    castTicks: number;
    requiresDone?: string;
}

// Standard Magic teleports (magic_spells.dbrow:62-105; teleport.rs2:17-35), jewellery teleports
// (amulet_of_glory.rs2:30-33, ring_of_dueling.rs2:21-23), and the East Ardougne / Deserted Keep Wilderness lever
// (wilderness_lever.constant:1-2, wilderness_lever.rs2:24-44).
const STANDARD_TELEPORTS: readonly TeleportSite[] = [
    { id: 'varrock', place: 'varrock-teleport', magicLevel: 25, castTicks: 4 },
    { id: 'lumbridge', place: 'lumbridge-spawn', magicLevel: 31, castTicks: 4 },
    { id: 'falador', place: 'falador-teleport', magicLevel: 37, castTicks: 4 },
    { id: 'camelot', place: 'camelot-teleport', magicLevel: 45, castTicks: 4 },
    { id: 'ardougne', place: 'ardougne-market', magicLevel: 51, castTicks: 4, requiresDone: 'plague-city' },
    { id: 'glory-edgeville', place: 'glory-edgeville', magicLevel: 1, castTicks: 5, requiresDone: 'trade-start' },
    { id: 'glory-karamja', place: 'glory-karamja', magicLevel: 1, castTicks: 5, requiresDone: 'trade-start' },
    { id: 'glory-draynor', place: 'glory-draynor', magicLevel: 1, castTicks: 5, requiresDone: 'trade-start' },
    { id: 'glory-al-kharid', place: 'glory-al-kharid', magicLevel: 1, castTicks: 5, requiresDone: 'trade-start' },
    { id: 'dueling-arena', place: 'dueling-arena', magicLevel: 1, castTicks: 6, requiresDone: 'trade-start' },
    { id: 'dueling-castle-wars', place: 'dueling-castle-wars', magicLevel: 1, castTicks: 6, requiresDone: 'trade-start' },
    { id: 'games-burthorpe', place: 'kaqemeex', magicLevel: 1, castTicks: 58, requiresDone: 'trade-start' },
];
const WILDY_LEVER_IN = 'ardougne-lever';
const WILDY_LEVER_OUT = 'deserted-keep-lever';
const WILDY_LEVER_TICKS = 6;
const SPIRIT_TREE_DESTS = ['spirit-tree-village', 'spirit-tree-stronghold', 'spirit-tree-khazard', 'spirit-tree-varrock'] as const;
const SPIRIT_TREE_TICKS = 8;
const GLIDER_OUTPOSTS = ['glider-digsite', 'glider-al-kharid', 'glider-karamja'] as const;
const GLIDER_TICKS = 6;
const HAGGIS_TRAVEL_MODELS = new WeakSet<TravelModel>();
const HAGGIS_LEG_CACHES = new WeakMap<TravelModel, HaggisLegCache>();
const inDeepWilderness = (p: Place | undefined) => !!p && p.x >= 2944 && p.x <= 3391 && p.z >= 3680 && p.z <= 3967;

export type HaggisLegCache = Array<Map<string, Map<string, { ticks: number; method: string }>> | undefined>;

export function createHaggisLegCache(): HaggisLegCache {
    return new Array(512);
}

/** Shared leg cache bound to a TravelModel returned by haggisTravel(). */
export function legCacheFor(m: TravelModel | undefined): HaggisLegCache | undefined {
    if (!m || !HAGGIS_TRAVEL_MODELS.has(m)) return undefined;
    let cache = HAGGIS_LEG_CACHES.get(m);
    if (!cache) {
        cache = createHaggisLegCache();
        HAGGIS_LEG_CACHES.set(m, cache);
    }
    return cache;
}

// Places of haggis-boards.json and the leg cache haggis-travel.json. The run starts where the tutorial skip lands.
export function haggisTravel(path = BOARDS_FILE, cachePath?: string): TravelModel {
    const data = JSON.parse(readFileSync(path, 'utf8')) as { places?: Record<string, Place> };
    const model = { ...loadTravel(data.places ?? {}, cachePath), start: 'lumbridge-spawn' };
    HAGGIS_TRAVEL_MODELS.add(model);
    return model;
}

/** Picks the fastest travel leg between two places using unlocked teleports, spirit trees, gliders, and the wildy lever. */
export function bestHaggisLeg(
    m: TravelModel,
    from: string,
    to: string,
    magicLevel: number,
    doneAt: ReadonlyMap<string, number>,
    disableTeleports: boolean,
    legCache?: HaggisLegCache,
): { ticks: number; method: string } {
    if (!HAGGIS_TRAVEL_MODELS.has(m) || disableTeleports || from === to) return leg(m, from, to);

    const hasPlagueCity = doneAt.has('plague-city');
    const hasTradeStart = doneAt.has('trade-start');
    const hasTree = doneAt.has('tree');
    const hasGrandtree = doneAt.has('grandtree');

    let stateKey = 0;
    let byFrom: Map<string, { ticks: number; method: string }> | undefined;
    let stateMap: Map<string, Map<string, { ticks: number; method: string }>> | undefined;
    if (legCache) {
        const magicTier = magicLevel >= 51 ? 5 : magicLevel >= 45 ? 4 : magicLevel >= 37 ? 3 : magicLevel >= 31 ? 2 : magicLevel >= 25 ? 1 : 0;
        stateKey = (magicTier << 4)
            | (hasPlagueCity ? 1 : 0)
            | (hasTradeStart ? 2 : 0)
            | (hasTree ? 4 : 0)
            | (hasGrandtree ? 8 : 0);
        stateMap = legCache[stateKey];
        if (stateMap) {
            byFrom = stateMap.get(from);
            const hit = byFrom?.get(to);
            if (hit) return hit;
        }
    }

    const direct = leg(m, from, to);
    let bestTicks = direct.ticks;
    let bestMethod: string | null = null;

    const unlocked: TeleportSite[] = [];
    for (let i = 0; i < STANDARD_TELEPORTS.length; i++) {
        const tp = STANDARD_TELEPORTS[i]!;
        if (magicLevel < tp.magicLevel) continue;
        if (tp.requiresDone === 'plague-city' && !hasPlagueCity) continue;
        if (tp.requiresDone === 'trade-start' && !hasTradeStart) continue;
        if (m.places[tp.place]) unlocked.push(tp);
    }

    const fromPlace = m.places[from] ?? m.cache.banks[from];
    const hasLever = !!m.places[WILDY_LEVER_IN] && !!m.places[WILDY_LEVER_OUT];
    const treeHubs: string[] = [];
    if (hasTree && m.places['spirit-tree-village']) treeHubs.push('spirit-tree-village');
    if (hasGrandtree && m.places['spirit-tree-stronghold']) treeHubs.push('spirit-tree-stronghold');
    const treeDests: string[] = [];
    if (treeHubs.length > 0) {
        for (let i = 0; i < SPIRIT_TREE_DESTS.length; i++) {
            const p = SPIRIT_TREE_DESTS[i]!;
            if (m.places[p]) treeDests.push(p);
        }
    }
    const gliderUnlocked = hasGrandtree && !!m.places['glider-grandtree'];

    const minFromWithTp = (src: string, dest: string): number => {
        let bestT = legTicks(m, src, dest);
        for (let i = 0; i < unlocked.length; i++) {
            const tp = unlocked[i]!;
            const t = tp.castTicks + legTicks(m, tp.place, dest);
            if (t < bestT) bestT = t;
        }
        return bestT;
    };

    if (!inDeepWilderness(fromPlace)) {
        for (let i = 0; i < unlocked.length; i++) {
            const tp = unlocked[i]!;
            const ticks = tp.castTicks + legTicks(m, tp.place, to);
            if (ticks < bestTicks) { bestTicks = ticks; bestMethod = `teleport:${tp.id}`; }
        }
        for (let hi = 0; hi < treeHubs.length; hi++) {
            const hub = treeHubs[hi]!;
            const toHub = minFromWithTp(from, hub);
            for (let di = 0; di < treeDests.length; di++) {
                const dest = treeDests[di]!;
                if (dest === hub) continue;
                const t = toHub + SPIRIT_TREE_TICKS + legTicks(m, dest, to);
                if (t < bestTicks) { bestTicks = t; bestMethod = 'spirit-tree'; }
            }
        }
        if (gliderUnlocked) {
            let toTree = minFromWithTp(from, 'glider-grandtree');
            if (treeHubs.length > 0) {
                const strongholdToGlider = legTicks(m, 'spirit-tree-stronghold', 'glider-grandtree');
                for (let hi = 0; hi < treeHubs.length; hi++) {
                    const t = minFromWithTp(from, treeHubs[hi]!) + SPIRIT_TREE_TICKS + strongholdToGlider;
                    if (t < toTree) toTree = t;
                }
            }
            for (let i = 0; i < GLIDER_OUTPOSTS.length; i++) {
                const dest = GLIDER_OUTPOSTS[i]!;
                if (!m.places[dest]) continue;
                const t = toTree + GLIDER_TICKS + legTicks(m, dest, to);
                if (t < bestTicks) { bestTicks = t; bestMethod = 'gnome-glider'; }
            }
            const gliderToTo = legTicks(m, 'glider-grandtree', to);
            for (let i = 0; i < GLIDER_OUTPOSTS.length; i++) {
                const src = GLIDER_OUTPOSTS[i]!;
                if (!m.places[src]) continue;
                const toSrc = minFromWithTp(from, src);
                const t = toSrc + GLIDER_TICKS + gliderToTo;
                if (t < bestTicks) { bestTicks = t; bestMethod = 'gnome-glider'; }
            }
        }
        if (hasLever) {
            const toLever = minFromWithTp(from, WILDY_LEVER_IN);
            const leverTicks = toLever + WILDY_LEVER_TICKS + legTicks(m, WILDY_LEVER_OUT, to);
            if (leverTicks < bestTicks) { bestTicks = leverTicks; bestMethod = 'wildy-lever'; }
        }
    } else if (hasLever) {
        const exitTicks = legTicks(m, from, WILDY_LEVER_OUT) + WILDY_LEVER_TICKS;
        let fromArdy = minFromWithTp(WILDY_LEVER_IN, to);
        for (let hi = 0; hi < treeHubs.length; hi++) {
            const hub = treeHubs[hi]!;
            const toHub = minFromWithTp(WILDY_LEVER_IN, hub);
            for (let di = 0; di < treeDests.length; di++) {
                const dest = treeDests[di]!;
                if (dest === hub) continue;
                const t = toHub + SPIRIT_TREE_TICKS + legTicks(m, dest, to);
                if (t < fromArdy) fromArdy = t;
            }
        }
        if (exitTicks + fromArdy < bestTicks) {
            bestTicks = exitTicks + fromArdy;
            bestMethod = 'wildy-exit-lever';
        }
    }

    const res = bestMethod === null ? direct : { ticks: bestTicks, method: bestMethod };
    if (legCache) {
        if (!stateMap) {
            stateMap = new Map();
            legCache[stateKey] = stateMap;
        }
        if (!byFrom) {
            byFrom = new Map();
            stateMap.set(from, byFrom);
        }
        byFrom.set(to, res);
    }
    return res;
}
