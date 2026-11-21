// Gathering plan builder choosing spawns, cows, locs, pickables, kills, NPC crafts, mining and fires.
import { locsByDistance, spawnsByDistance } from '../spawn-index';
import { canKill, killStyle } from './combat';
import {
    BRONZE_PICKAXE,
    BUCKET,
    BURN_SOURCES,
    COMBINE_SOURCES,
    LOC_SOURCES,
    MILK,
    MINE_SOURCES,
    NPC_SOURCES,
    PICK_SOURCES,
    TINDERBOX,
    USE_SOURCES,
    cows,
    killSpawns,
    nearest,
    type Gather,
    type Item,
    type Tile,
} from './sources';

// A spawn wins over a shop when it is nearer: eggs lie by Lumbridge, while the only egg seller is in Rellekka.
// `seller` gives the straight-line distance to the nearest seller (Infinity when no shop sells the item).
// A recipe's ingredients are planned like any missing item (a spawn, a plant, a shop, a kill, another recipe) and its
// own step follows them, so the gathers run ingredients first. `coins` is what the recipes cost; `still` is what no
// source covers and the shop plan takes.
export function gatherPlan(
    missing: readonly Item[],
    at: Tile,
    spawns: (id: number, at: Tile) => Tile[] = spawnsByDistance,
    seller: (id: number) => number = () => Infinity,
    kills: (id: number) => Tile[] = killSpawns,
    attack = 99,
    ranged = 1,
    picks: (loc: number, at: Tile) => Tile[] = locsByDistance,
    magic = 1,
    strength = attack,
) {
    const gathers: Gather[] = [], still: Item[] = [], tools: Item[] = [];
    let coins = 0;
    const d = (t: Tile) => Math.max(Math.abs(t.x - at.x), Math.abs(t.z - at.z));
    const place = (m: Item, depth: number): void => {
        const sold = seller(m.id), spot = spawns(m.id, at)[0], pick = PICK_SOURCES[m.id] ? picks(PICK_SOURCES[m.id]!.loc, at)[0] : undefined;
        // Milk comes from the nearest cow when it is nearer than the spawn and the seller: the milk spawn and seller are both
        // far north while cows graze beside Lumbridge and Ardougne.
        const cow = m.id === MILK ? nearest(cows(), at)[0] : undefined;
        if (m.id === MILK && (sold === Infinity || (cow && d(cow) < Math.min(sold, spot ? d(spot) : Infinity)))) {
            gathers.push({ ...m, how: 'milk' });
            tools.push({ id: BUCKET, count: m.count });
        }
        // A loc that hands the item out for a use beats a farther spawn: a bucket of water from the sink by the Ardougne bank,
        // not the spawn at Catherby.
        // Each spawn gives one item at a time, so a count beyond the spawns within the seller's distance (four buckets, one
        // bucket spawn by the bank) goes to the shop; with no seller the spawns are waited on.
        else if (spot && d(spot) < sold && (sold === Infinity || spawns(m.id, at).filter(t => d(t) < sold).length >= m.count) && !(USE_SOURCES[m.id] && nearest(USE_SOURCES[m.id]!.tiles, at).some(t => d(t) < d(spot)))) {
            gathers.push({ ...m, how: 'spawn' });
        } else if (LOC_SOURCES[m.id] && d(LOC_SOURCES[m.id]!.tile) < sold) {
            gathers.push({ ...m, how: 'loc' });
        } else if (pick && d(pick) < sold) {
            gathers.push({ ...m, how: 'pick' });
        }
        // A kill wins over a shop when its animal is nearer, as a spawn does: Rufus in Canifis sells every meat, 850 tiles
        // from Ardougne and behind Priest in Peril, while cows graze beside the Ardougne banks.
        else if (canKill(m.id, attack, ranged, magic, strength) && kills(m.id).some(t => t.level === at.level && d(t) < sold)) {
            const style = killStyle(m.id, attack, ranged, magic, strength)!;
            gathers.push({ ...m, how: 'kill', ...(style === 'melee' ? {} : { kit: style }) });
        }
        // A loc that hands the item out for a use beats a shop farther off, as a spawn does: the sink by the Ardougne bank
        // fills a bucket where the nearest bucket-of-water seller is Jossik at the Lighthouse.
        else if (USE_SOURCES[m.id] && depth < 4 && nearest(USE_SOURCES[m.id]!.tiles, at).some(t => d(t) < sold)) {
            for (const id of USE_SOURCES[m.id]!.uses) place({ id, count: m.count }, depth + 1);
            gathers.push({ ...m, how: 'use' });
        } else if (sold < Infinity) {
            still.push(m);
        } else if (NPC_SOURCES[m.id] && depth < 4) {
            const r = NPC_SOURCES[m.id]!, units = Math.ceil(m.count / r.yields);
            for (const n of r.needs) place({ id: n.id, count: n.count * units }, depth + 1);
            coins += r.coins * units;
            gathers.push({ id: m.id, count: units * r.yields, how: 'npc' });
        } else if (COMBINE_SOURCES[m.id] && depth < 4) {
            for (const id of COMBINE_SOURCES[m.id]!) place({ id, count: m.count }, depth + 1);
            gathers.push({ ...m, how: 'combine' });
        } else if (MINE_SOURCES[m.id] && nearest(MINE_SOURCES[m.id]!.tiles, at).some(t => d(t) < sold)) {
            gathers.push({ ...m, how: 'mine' });
            if (!tools.some(t => t.id === BRONZE_PICKAXE)) tools.push({ id: BRONZE_PICKAXE, count: 1 });
        } else if (BURN_SOURCES[m.id] && depth < 4) {
            const b = BURN_SOURCES[m.id]!;
            place({ id: b.logs, count: m.count }, depth + 1);
            if (b.uses) place({ id: b.uses, count: m.count }, depth + 1);
            if (!tools.some(t => t.id === TINDERBOX)) tools.push({ id: TINDERBOX, count: 1 });
            gathers.push({ ...m, how: 'burn' });
        } else {
            still.push(m);
        }
    };
    for (const m of missing) place(m, 0);
    return { gathers, still, tools, coins };
}
