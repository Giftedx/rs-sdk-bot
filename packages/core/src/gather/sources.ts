// Static item, loc, NPC, mining, firemaking, use, combine and kill source tables for gathering.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type Item = { id: number; count: number };
export type Tile = { x: number; z: number; level: number };
export type Gather = { id: number; count: number; how: 'spawn' | 'milk' | 'loc' | 'kill' | 'pick' | 'npc' | 'combine' | 'use' | 'mine' | 'burn'; kit?: 'ranged' | 'magic' };
export type NpcSource = { npc: number; name: string; tile: Tile; needs: Item[]; coins: number; yields: number; choices: RegExp[] };

export const count = (rows: readonly Item[], id: number) => rows.filter(r => r.id === id).reduce((n, r) => n + r.count, 0);

// The bucket is a pack item like any other: bank or shop.
export const MILK = 1927, BUCKET = 1925, COW = 81;
// Garlic: the cupboard upstairs in Morgan's house, Draynor (general_use/scripts/cupboards.rs2:34, loc 2612 shut,
// 2613 open: Open, then Search). The only shops are the Greengrocers on Miscellania and in Rellekka.
export const LOC_SOURCES: Record<number, { tile: Tile; open: RegExp; take: RegExp }> = { 1550: { tile: { x: 3096, z: 3268, level: 1 }, open: /^open$/i, take: /^search$/i } };
// A plant picked for its item: onions are loc 3366 with the Pick option (general_use/scripts/pickables.rs2:31-39; the
// plant stands again 50 ticks after a pick).
// The five pickable plants (general_use/scripts/pickables.rs2; tiles in knowledge/pickables.json): a cabbage from the
// fields beside Falador or Draynor is nearer than any cabbage shop.
export const PICK_SOURCES: Record<number, { loc: number; option: RegExp }> = {
    1957: { loc: 3366, option: /^pick$/i },
    1965: { loc: 1161, option: /^pick$/i },
    1942: { loc: 312, option: /^pick$/i },
    1947: { loc: 313, option: /^pick$/i },
    1779: { loc: 2646, option: /^pick$/i },
};

// An item an NPC hands over in dialogue for ingredients and coins: Aggie in Draynor makes red dye from 3 redberries,
// yellow from 2 onions and blue from 2 woad leaves, 5 coins each (area_draynor/scripts/aggie.rs2:71-115); Wyson the
// gardener in Falador park sells 2 woad leaves for 20 coins (area_falador/scripts/wyson_the_gardener.rs2:26-35).
// `choices` are the dialogue options taken in order; a page with no matching option is continued.
const AGGIE = { npc: 922, name: 'Aggie', tile: { x: 3086, z: 3259, level: 0 } };
const WYSON = { npc: 36, name: 'Wyson the gardener', tile: { x: 3027, z: 3379, level: 0 } };
export const NPC_SOURCES: Record<number, NpcSource> = {
    1793: { ...WYSON, needs: [], coins: 20, yields: 2, choices: [/looking for woad leaves/i, /how about 20 coins/i] },
    1763: { ...AGGIE, needs: [{ id: 1951, count: 3 }], coins: 5, yields: 1, choices: [/make dyes for me/i, /make red dye/i, /^okay, make me some red dye/i] },
    1765: { ...AGGIE, needs: [{ id: 1957, count: 2 }], coins: 5, yields: 1, choices: [/make dyes for me/i, /make yellow dye/i, /^okay, make me some yellow dye/i] },
    1767: { ...AGGIE, needs: [{ id: 1793, count: 2 }], coins: 5, yields: 1, choices: [/make dyes for me/i, /make blue dye/i, /^okay, make me some blue dye/i] },
};

// Two items used on each other: orange dye is red on yellow (skill_crafting/scripts/dye_mixing.rs2); soft clay is clay
// on a bucket of water, which comes back empty (skill_crafting/scripts/pottery/pottery.rs2 make_softclay); a seasoned
// sardine is doogle leaves on a raw sardine (quests/quest_fluffs/scripts/quest_fluffs.rs2 opheldu). The leaves grow as
// a ground spawn beside Gertrude's house; Gerrant in Port Sarim sells the sardine.
export const COMBINE_SOURCES: Record<number, [number, number]> = { 1769: [1763, 1765], 1761: [434, 1929], 1552: [327, 1573] };

// An ore mined from a rock with any pickaxe in the pack or wielded (skill_mining/scripts/pickaxe_checker.rs2). The
// rocks are the locs of skill_mining/configs/rocks.loc at the tiles the map files (maps/*.jm2) place them; `level` is the
// Mining level the rock asks (mine.dbrow rock_level). The six clay rocks inside the Crafting Guild (2937-2943,
// 3282-3285; Crafting 40 and a brown apron at its door) are left out. A bronze pickaxe (1 coin in general stores) is
// the plan's tool; the fight takes whichever pickaxe the pack holds.
export const PICKAXES = [1265, 1267, 1269, 1273, 1271, 1275];
export const BRONZE_PICKAXE = 1265;
export const MINE_SOURCES: Record<number, { name: string; locs: number[]; level: number; tiles: Tile[] }> = {
    434: { name: 'clay rock', locs: [2108, 2109], level: 1, tiles: [{ x: 2447, z: 9902, level: 0 }, { x: 2449, z: 9907, level: 0 }, { x: 2451, z: 9906, level: 0 }, { x: 2451, z: 9908, level: 0 }, { x: 2453, z: 9905, level: 0 }, { x: 2487, z: 9915, level: 0 }, { x: 2490, z: 9916, level: 0 }, { x: 2490, z: 9917, level: 0 }, { x: 2491, z: 9912, level: 0 }, { x: 2629, z: 3143, level: 0 }, { x: 2629, z: 3145, level: 0 }, { x: 2630, z: 3143, level: 0 }, { x: 2632, z: 3139, level: 0 }, { x: 2680, z: 3707, level: 0 }, { x: 2684, z: 3707, level: 0 }, { x: 2684, z: 3709, level: 0 }, { x: 2686, z: 3704, level: 0 }, { x: 2986, z: 3239, level: 0 }, { x: 2987, z: 3240, level: 0 }, { x: 3028, z: 9808, level: 0 }, { x: 3030, z: 9809, level: 0 }, { x: 3030, z: 9810, level: 0 }, { x: 3053, z: 9818, level: 0 }, { x: 3054, z: 9819, level: 0 }, { x: 3179, z: 3371, level: 0 }, { x: 3180, z: 3372, level: 0 }, { x: 3183, z: 3377, level: 0 }] },
    436: { name: 'copper rock', locs: [2090, 2091], level: 1, tiles: [{ x: 2470, z: 3255, level: 0 }, { x: 2472, z: 3256, level: 0 }, { x: 2475, z: 3256, level: 0 }, { x: 2630, z: 3137, level: 0 }, { x: 2630, z: 3145, level: 0 }, { x: 2640, z: 3151, level: 0 }, { x: 2640, z: 3153, level: 0 }, { x: 2907, z: 3361, level: 0 }, { x: 2909, z: 3364, level: 0 }, { x: 2976, z: 3247, level: 0 }, { x: 2977, z: 3245, level: 0 }, { x: 2977, z: 3247, level: 0 }, { x: 2978, z: 3248, level: 0 }, { x: 2979, z: 3248, level: 0 }, { x: 3021, z: 9801, level: 0 }, { x: 3024, z: 9798, level: 0 }, { x: 3026, z: 9801, level: 0 }, { x: 3027, z: 9802, level: 0 }, { x: 3030, z: 9825, level: 0 }, { x: 3030, z: 9826, level: 0 }, { x: 3033, z: 9828, level: 0 }, { x: 3038, z: 9780, level: 0 }, { x: 3039, z: 9781, level: 0 }, { x: 3039, z: 9783, level: 0 }, { x: 3040, z: 9784, level: 0 }, { x: 3141, z: 9880, level: 0 }, { x: 3143, z: 9877, level: 0 }, { x: 3282, z: 3367, level: 0 }, { x: 3282, z: 3368, level: 0 }, { x: 3286, z: 3361, level: 0 }, { x: 3286, z: 3364, level: 0 }, { x: 3287, z: 3365, level: 0 }, { x: 3288, z: 3361, level: 0 }, { x: 3288, z: 9469, level: 0 }, { x: 3289, z: 3361, level: 0 }, { x: 3289, z: 3363, level: 0 }, { x: 3289, z: 9469, level: 0 }, { x: 3290, z: 3362, level: 0 }, { x: 3290, z: 9468, level: 0 }, { x: 3294, z: 9468, level: 0 }, { x: 3295, z: 9469, level: 0 }, { x: 3296, z: 3314, level: 0 }, { x: 3296, z: 9426, level: 0 }, { x: 3296, z: 9469, level: 0 }, { x: 3297, z: 3315, level: 0 }, { x: 3299, z: 3015, level: 0 }, { x: 3300, z: 3017, level: 0 }, { x: 3300, z: 9425, level: 0 }, { x: 3301, z: 3016, level: 0 }, { x: 3301, z: 3318, level: 0 }, { x: 3302, z: 3015, level: 0 }, { x: 3304, z: 9425, level: 0 }, { x: 3306, z: 9424, level: 0 }] },
    440: { name: 'iron rock', locs: [2092, 2093], level: 15, tiles: [{ x: 2435, z: 9904, level: 0 }, { x: 2435, z: 9906, level: 0 }, { x: 2436, z: 9902, level: 0 }, { x: 2436, z: 9903, level: 0 }, { x: 2437, z: 9900, level: 0 }, { x: 2439, z: 9898, level: 0 }, { x: 2440, z: 9903, level: 0 }, { x: 2488, z: 9908, level: 0 }, { x: 2581, z: 3231, level: 0 }, { x: 2583, z: 3235, level: 0 }, { x: 2589, z: 3229, level: 0 }, { x: 2589, z: 3238, level: 0 }, { x: 2590, z: 3230, level: 0 }, { x: 2591, z: 3232, level: 0 }, { x: 2592, z: 3234, level: 0 }, { x: 2602, z: 3233, level: 0 }, { x: 2602, z: 3234, level: 0 }, { x: 2602, z: 3236, level: 0 }, { x: 2605, z: 3233, level: 0 }, { x: 2605, z: 3235, level: 0 }, { x: 2605, z: 3237, level: 0 }, { x: 2625, z: 3150, level: 0 }, { x: 2625, z: 3151, level: 0 }, { x: 2626, z: 3149, level: 0 }, { x: 2626, z: 3150, level: 0 }, { x: 2627, z: 3142, level: 0 }, { x: 2628, z: 3140, level: 0 }, { x: 2628, z: 3141, level: 0 }, { x: 2634, z: 3136, level: 0 }, { x: 2638, z: 3138, level: 0 }, { x: 2667, z: 9680, level: 0 }, { x: 2667, z: 9681, level: 0 }, { x: 2669, z: 9684, level: 0 }, { x: 2672, z: 9685, level: 0 }, { x: 2673, z: 9680, level: 0 }, { x: 2691, z: 3329, level: 0 }, { x: 2692, z: 3328, level: 0 }, { x: 2693, z: 3329, level: 0 }, { x: 2696, z: 3333, level: 0 }, { x: 2697, z: 3334, level: 0 }, { x: 2710, z: 3328, level: 0 }, { x: 2711, z: 3329, level: 0 }, { x: 2712, z: 3329, level: 0 }, { x: 2713, z: 3332, level: 0 }, { x: 2714, z: 3330, level: 0 }, { x: 2715, z: 3331, level: 0 }, { x: 2722, z: 3695, level: 0 }, { x: 2723, z: 3692, level: 0 }, { x: 2723, z: 3695, level: 0 }, { x: 2723, z: 3696, level: 0 }, { x: 2724, z: 3688, level: 0 }, { x: 2725, z: 3691, level: 0 }, { x: 2725, z: 3694, level: 0 }, { x: 2727, z: 3692, level: 0 }, { x: 2728, z: 3695, level: 0 }, { x: 2848, z: 3037, level: 0 }, { x: 2903, z: 3353, level: 0 }, { x: 2904, z: 3354, level: 0 }, { x: 2904, z: 3356, level: 0 }, { x: 2968, z: 3239, level: 0 }, { x: 2969, z: 3240, level: 0 }, { x: 2969, z: 3242, level: 0 }, { x: 2971, z: 3237, level: 0 }, { x: 2981, z: 3233, level: 0 }, { x: 2982, z: 3234, level: 0 }, { x: 3032, z: 9826, level: 0 }, { x: 3033, z: 9825, level: 0 }, { x: 3036, z: 9775, level: 0 }, { x: 3037, z: 9776, level: 0 }, { x: 3039, z: 9777, level: 0 }, { x: 3044, z: 9769, level: 0 }, { x: 3045, z: 9771, level: 0 }, { x: 3053, z: 9822, level: 0 }, { x: 3054, z: 9828, level: 0 }, { x: 3057, z: 3941, level: 0 }, { x: 3075, z: 3771, level: 0 }, { x: 3076, z: 3770, level: 0 }, { x: 3076, z: 3771, level: 0 }, { x: 3088, z: 3769, level: 0 }, { x: 3089, z: 3768, level: 0 }, { x: 3090, z: 3767, level: 0 }, { x: 3090, z: 3768, level: 0 }, { x: 3091, z: 3768, level: 0 }, { x: 3099, z: 3765, level: 0 }, { x: 3099, z: 3766, level: 0 }, { x: 3099, z: 3767, level: 0 }, { x: 3099, z: 3768, level: 0 }, { x: 3100, z: 3765, level: 0 }, { x: 3100, z: 3766, level: 0 }, { x: 3101, z: 3765, level: 0 }, { x: 3101, z: 3768, level: 0 }, { x: 3104, z: 3570, level: 0 }, { x: 3105, z: 3569, level: 0 }, { x: 3139, z: 9875, level: 0 }, { x: 3141, z: 9872, level: 0 }, { x: 3143, z: 9876, level: 0 }, { x: 3175, z: 3366, level: 0 }, { x: 3175, z: 3368, level: 0 }, { x: 3181, z: 3373, level: 0 }, { x: 3284, z: 3015, level: 0 }, { x: 3285, z: 3017, level: 0 }, { x: 3285, z: 3368, level: 0 }, { x: 3285, z: 3369, level: 0 }, { x: 3286, z: 3369, level: 0 }, { x: 3287, z: 3015, level: 0 }, { x: 3288, z: 3370, level: 0 }, { x: 3294, z: 3310, level: 0 }, { x: 3295, z: 3309, level: 0 }, { x: 3295, z: 3311, level: 0 }, { x: 3302, z: 3285, level: 0 }, { x: 3303, z: 3284, level: 0 }, { x: 3303, z: 3309, level: 0 }, { x: 3303, z: 3310, level: 0 }, { x: 3304, z: 3301, level: 0 }, { x: 3305, z: 3302, level: 0 }] },
};

// An item a fire gives: a tinderbox on logs lights a fire that burns 100 to 199 ticks, then ashes lie on its tile for
// 100 ticks (skill_firemaking/scripts/firemaking.rs2 firemaking_success); cooked meat used on the fire burns every time
// (skill_cooking/configs/cooking_source/cooking_generic.dbrow cooking_burn_meat, successchance 1,1). The logs and the
// item `uses` are gathered first; the tinderbox is the plan's tool.
export const TINDERBOX = 590, LOGS = 1511, FIRE_TICKS = 200;
export const BURN_SOURCES: Record<number, { name: string; logs: number; uses?: number }> = { 592: { name: 'ashes', logs: LOGS }, 2146: { name: 'burnt meat', logs: LOGS, uses: 2142 } };

// An item taken from a loc by using items on it in turn, each use consumed: a bucket of wax from a Catherby beehive
// (area_seers/scripts/bees.rs2: insect repellent clears the bees, then an empty bucket takes the wax; a bucket on a
// hive with bees stings). The uses are gathered first, as a recipe's ingredients are.
// A bucket of water is an empty bucket on a sink, fountain or well (general_use/scripts/water_sources.rs2 oplocu
// _watersource/_well); the sinks and fountains of East Ardougne stand by its banks. Any option text names the loc.
const WATER_SOURCES: Tile[] = [{ x: 2658, z: 3273, level: 0 }, { x: 2675, z: 3310, level: 0 }, { x: 2629, z: 3311, level: 0 }, { x: 2640, z: 3311, level: 0 }, { x: 2639, z: 3369, level: 0 }];
export const USE_SOURCES: Record<number, { name: string; tiles: Tile[]; uses: number[]; option: RegExp }> = {
    1929: { name: 'water source', option: /.*/, uses: [1925], tiles: WATER_SOURCES },
    30: { name: 'beehive', option: /take-from/i, uses: [28, 1925], tiles: [{ x: 2755, z: 3440, level: 0 }, { x: 2755, z: 3443, level: 0 }, { x: 2755, z: 3447, level: 0 }, { x: 2758, z: 3440, level: 0 }, { x: 2758, z: 3447, level: 0 }, { x: 2759, z: 3444, level: 0 }, { x: 2762, z: 3440, level: 0 }, { x: 2762, z: 3443, level: 0 }] },
};

// A bow and arrows the account owns: shortbow or longbow, bronze, iron or steel arrows (the kinds the fleet's banks hold).
export const BOWS = [841, 839, 843, 845], ARROWS = [884, 886, 882], ARROWS_PER_KILL = 6;
// The strike spells (skill_combat/configs/magic/magic_combat_spells.dbrow): level, runes per cast and max hit. A worn
// elemental staff stands in for its rune (skill_magic/configs/magic_staff.dbrow). Fire Strike's 8 kills a goblin in one
// cast and a bear in four.
export const SPELLS = [
    { component: 'magic:wind_strike', level: 1, runes: { 558: 1, 556: 1 }, maxhit: 2 },
    { component: 'magic:water_strike', level: 5, runes: { 558: 1, 555: 1, 556: 1 }, maxhit: 4 },
    { component: 'magic:earth_strike', level: 9, runes: { 558: 1, 557: 2, 556: 1 }, maxhit: 6 },
    { component: 'magic:fire_strike', level: 13, runes: { 558: 1, 554: 3, 556: 2 }, maxhit: 8 },
] as const;
export const STAFF_RUNE: Record<number, number> = { 1381: 556, 1397: 556, 1383: 555, 1395: 555, 1385: 557, 1399: 557, 1387: 554, 1393: 554 };
export const CASTS_MIN = 6;

export const CLUSTER = 20;
// Spawn tiles with at least `min` of their list within CLUSTER tiles. A series of kills for a drop by chance wants a dense
// cluster (Lumbridge's 20 goblin tiles, Port Sarim's 12, the Goblin Village's 21), not a lone pair east of Varrock, where
// a series waited out its budget on one goblin at a time.
const SERIES_CLUSTER = 4;
export const denseSpawns = (tiles: readonly Tile[], min = SERIES_CLUSTER): Tile[] =>
    tiles.filter(t => tiles.filter(u => u.level === t.level && Math.max(Math.abs(u.x - t.x), Math.abs(u.z - t.z)) <= CLUSTER).length >= min);

// Meats no shop sells drop from animals on death, every kill (drop tables/scripts/cow.rs2, chicken.rs2, giant_rat.rs2,
// bear.rs2 `always` rows); goblin mail drops from a goblin on 5 of 128 rolls (goblin.rs2:19,53; 10 of 128 for the Goblin
// Village ones, :75,119). The account kills the nearest one and takes the drop. NPC ids and spawns come from
// knowledge/npcs.json. `combat` is the strongest of the animal's forms. An account fights one only below its Attack level,
// or at combat 6 or less (a chicken, cow or giant rat dies to anyone): a dark bear (19) killed an 81-hitpoint, Attack 6
// account on practice. `chance` is the drop's share of kills; the attempt budget follows it.
// `arrows`: the arrows a kill of this animal takes when ARROWS_PER_KILL is too few (a giant bat has 32 hitpoints and
// flees when hurt, so many shots miss or fall short).
export const KILL_SOURCES: Record<number, { npcs: number[]; name: string; combat: number; hp: number; chance: number; arrows?: number }> = {
    2132: { npcs: [81], name: 'cow', combat: 2, hp: 8, chance: 1 },
    2138: { npcs: [41, 1017], name: 'chicken', combat: 1, hp: 3, chance: 1 },
    2134: { npcs: [86, 87, 950], name: 'giant rat', combat: 6, hp: 5, chance: 1 },
    2136: { npcs: [105, 106], name: 'bear', combat: 21, hp: 27, chance: 1 },
    288: { npcs: [100, 101, 298, 299], name: 'goblin', combat: 5, hp: 5, chance: 5 / 128 },
    // Imp Catcher's beads (imp.rs2:10-19): one roll of 128 a kill, five faces each for black, red, white and yellow.
    1470: { npcs: [708], name: 'imp', combat: 2, hp: 8, chance: 5 / 128 },
    1472: { npcs: [708], name: 'imp', combat: 2, hp: 8, chance: 5 / 128 },
    1474: { npcs: [708], name: 'imp', combat: 2, hp: 8, chance: 5 / 128 },
    1476: { npcs: [708], name: 'imp', combat: 2, hp: 8, chance: 5 / 128 },
    // Bat bones from a giant bat every kill (all.npc [bat] death_drop); they roost around Keep Le Faye and Hemenster.
    530: { npcs: [78], name: 'giant bat', combat: 27, hp: 32, chance: 1, arrows: 15 },
};
export const EASY_KILL = 6;

let npcRows: { id: number; spawns?: Tile[] }[] | undefined;
const npcSpawns = (ids: readonly number[]): Tile[] =>
    (npcRows ??= JSON.parse(readFileSync(resolve(import.meta.dir, '../../../../knowledge/npcs.json'), 'utf8')) as { id: number; spawns?: Tile[] }[])
        .filter(n => ids.includes(n.id)).flatMap(n => n.spawns ?? []);

export const killSpawns = (id: number): Tile[] => KILL_SOURCES[id] ? npcSpawns(KILL_SOURCES[id]!.npcs) : [];

let cowTiles: Tile[] | undefined;
export const cows = () => cowTiles ??= npcSpawns([COW]);

export const nearest = (tiles: readonly Tile[], at: Tile) =>
    tiles.filter(t => t.level === at.level).sort((a, b) => Math.max(Math.abs(a.x - at.x), Math.abs(a.z - at.z)) - Math.max(Math.abs(b.x - at.x), Math.abs(b.z - at.z)));
