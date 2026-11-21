// Haggis travel model loader and teleport, spirit-tree, gnome-glider, and Wilderness lever leg routing.
import { readFileSync } from 'node:fs';
import { leg, loadTravel, type Place, type TravelModel } from '../travel';
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
];
const WILDY_LEVER_IN = 'ardougne-lever';
const WILDY_LEVER_OUT = 'deserted-keep-lever';
const WILDY_LEVER_TICKS = 6;
const SPIRIT_TREE_DESTS = ['spirit-tree-village', 'spirit-tree-stronghold', 'spirit-tree-khazard', 'spirit-tree-varrock'] as const;
const SPIRIT_TREE_TICKS = 8;
const GLIDER_OUTPOSTS = ['glider-digsite', 'glider-al-kharid', 'glider-karamja'] as const;
const GLIDER_TICKS = 6;
const HAGGIS_TRAVEL_MODELS = new WeakSet<TravelModel>();
const inDeepWilderness = (p: Place | undefined) => !!p && p.x >= 2944 && p.x <= 3391 && p.z >= 3680 && p.z <= 3967;

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
): { ticks: number; method: string } {
    const direct = leg(m, from, to);
    if (!HAGGIS_TRAVEL_MODELS.has(m) || disableTeleports || from === to) return direct;
    let best: { ticks: number; method: string } = direct;
    const unlocked = STANDARD_TELEPORTS.filter(tp => magicLevel >= tp.magicLevel && (!tp.requiresDone || doneAt.has(tp.requiresDone)) && !!m.places[tp.place]);
    const fromPlace = m.places[from] ?? m.cache.banks[from];
    const hasLever = !!m.places[WILDY_LEVER_IN] && !!m.places[WILDY_LEVER_OUT];
    const treeHubs: string[] = [];
    if (doneAt.has('tree') && m.places['spirit-tree-village']) treeHubs.push('spirit-tree-village');
    if (doneAt.has('grandtree') && m.places['spirit-tree-stronghold']) treeHubs.push('spirit-tree-stronghold');
    const treeDests = treeHubs.length > 0
        ? SPIRIT_TREE_DESTS.filter(p => !!m.places[p])
        : [];
    const gliderUnlocked = doneAt.has('grandtree') && !!m.places['glider-grandtree'];
    if (!inDeepWilderness(fromPlace)) {
        for (const tp of unlocked) {
            const ticks = tp.castTicks + leg(m, tp.place, to).ticks;
            if (ticks < best.ticks) best = { ticks, method: `teleport:${tp.id}` };
        }
        for (const hub of treeHubs) {
            let toHub = leg(m, from, hub).ticks;
            for (const tp of unlocked) toHub = Math.min(toHub, tp.castTicks + leg(m, tp.place, hub).ticks);
            for (const dest of treeDests) {
                if (dest === hub) continue;
                const t = toHub + SPIRIT_TREE_TICKS + leg(m, dest, to).ticks;
                if (t < best.ticks) best = { ticks: t, method: 'spirit-tree' };
            }
        }
        if (gliderUnlocked) {
            const toTree = Math.min(
                leg(m, from, 'glider-grandtree').ticks,
                ...unlocked.map(tp => tp.castTicks + leg(m, tp.place, 'glider-grandtree').ticks),
                ...treeHubs.map(h => {
                    let toHub = leg(m, from, h).ticks;
                    for (const tp of unlocked) toHub = Math.min(toHub, tp.castTicks + leg(m, tp.place, h).ticks);
                    return toHub + SPIRIT_TREE_TICKS + leg(m, 'spirit-tree-stronghold', 'glider-grandtree').ticks;
                }),
            );
            for (const dest of GLIDER_OUTPOSTS) {
                if (!m.places[dest]) continue;
                const t = toTree + GLIDER_TICKS + leg(m, dest, to).ticks;
                if (t < best.ticks) best = { ticks: t, method: 'gnome-glider' };
            }
            for (const src of GLIDER_OUTPOSTS) {
                if (!m.places[src]) continue;
                let toSrc = leg(m, from, src).ticks;
                for (const tp of unlocked) toSrc = Math.min(toSrc, tp.castTicks + leg(m, tp.place, src).ticks);
                const t = toSrc + GLIDER_TICKS + leg(m, 'glider-grandtree', to).ticks;
                if (t < best.ticks) best = { ticks: t, method: 'gnome-glider' };
            }
        }
        if (hasLever) {
            let toLever = leg(m, from, WILDY_LEVER_IN).ticks;
            for (const tp of unlocked) toLever = Math.min(toLever, tp.castTicks + leg(m, tp.place, WILDY_LEVER_IN).ticks);
            const leverTicks = toLever + WILDY_LEVER_TICKS + leg(m, WILDY_LEVER_OUT, to).ticks;
            if (leverTicks < best.ticks) best = { ticks: leverTicks, method: 'wildy-lever' };
        }
    } else if (hasLever) {
        const exitTicks = leg(m, from, WILDY_LEVER_OUT).ticks + WILDY_LEVER_TICKS;
        let fromArdy = leg(m, WILDY_LEVER_IN, to).ticks;
        for (const tp of unlocked) fromArdy = Math.min(fromArdy, tp.castTicks + leg(m, tp.place, to).ticks);
        for (const hub of treeHubs) {
            const toHub = Math.min(
                leg(m, WILDY_LEVER_IN, hub).ticks,
                ...unlocked.map(tp => tp.castTicks + leg(m, tp.place, hub).ticks),
            );
            for (const dest of treeDests) {
                if (dest === hub) continue;
                fromArdy = Math.min(fromArdy, toHub + SPIRIT_TREE_TICKS + leg(m, dest, to).ticks);
            }
        }
        if (exitTicks + fromArdy < best.ticks) best = { ticks: exitTicks + fromArdy, method: 'wildy-exit-lever' };
    }
    return best;
}
