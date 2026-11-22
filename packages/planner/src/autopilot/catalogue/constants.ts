// Shared catalogue band numbers, army kit/supply thresholds, and production recipe constants.
import { boneXp, castRunes, objId } from '../../../../core/src/content-facts';
import type { Needs } from '../world';

export const GRAIL_RUNES: Readonly<Record<string, number>> = castRunes({ falador_teleport: 6, camelot_teleport: 5, varrock_teleport: 1 });
const LOST_CITY_FOOD = ['lobster', 'swordfish', 'shark'] as const;
// Underground Pass and Regicide for a build with the dragon halberd (BUILD_QUESTS; ROUTE_BEFORE). One account at a
// time: the fights of the pass are single fights. UPASS_AGILITY: a bridge of the pass rolls stat_random(agility, 160,
// 300) (upass_obstacles.rs2:374; PlayerOps.ts STAT_RANDOM: the value 256 of 256 from level 68, 255 at 67), so it
// cannot fail from level 68, and a fall puts the account on the floor of the chasm, which the quest scripts do not
// leave. UPASS_THIEVING: the two cage doors of the pass ask Thieving 50.
// QUEST_BOW_ARROWS: the rune arrows of the practice cases. The meals are the sharks of the cases: 12 for the pass, and
// for Regicide 10 in the pack with 20 in the bank for its second crossing.
export const UPASS_AGILITY = 68, UPASS_THIEVING = 50, UPASS_MEALS = 12, REGICIDE_MEALS = 30, QUEST_BOW_ARROWS = 600;
// The runes of Regicide: the Falador and the Ardougne teleport (the quest pack of quest_regicide).
export const REGICIDE_RUNES: Readonly<Record<string, number>> = castRunes({ falador_teleport: 1, ardougne_teleport: 2 });
// What the account holds for Regicide beside the bow pack, the items of the practice case
// extra:sweep-regicide-pure-hally. The quest script takes the coal of the still, the rabbit and a second rope out of
// the bank at Falador, and the sweep takes the first rope for the pack. No shop sells the limestone and the iron fire
// arrows of the quest pack: without them the sweep ends "missing 2532:2,3211:1". For the pestle and mortar the sweep
// goes to the ogre merchant, whose shop does not open. The Grand Exchange lists coal and ropes (a rope from 79,564
// coins; a shop sells one for 23) and none of the others.
export const REGICIDE_PACK: Readonly<Record<string, number>> = { coal: 8, 'cooked rabbit': 1, limestone: 1, 'iron fire arrow': 2, 'pestle and mortar': 1, rope: 2 };
// Fletching 25 for the lyre of The Fremennik Trials: FLETCH_MAKE headless arrows give 25 XP each at the server's
// rate, 5,250 XP against the 4,863 of level 25. The worker keeps FLETCH_KEEP shafts and feathers in the bank
// (scripts/fletch-arrows.ts planHeadless), so the band asks both amounts of each.
export const FLETCH_TO = 25, FLETCH_MAKE = 210, FLETCH_KEEP = 100;
// Lost City for an account with a Defence 1 build: the levels, the food and the prayer potions of the practice case
// `extra:lostcity-pure-pray` (scripts/measure/aio-bench-cases.ts). Four seeds: 844 to 1,174 ticks, no food eaten, lowest
// Hitpoints 73 of 93, XP in Strength and Hitpoints only (research/pvp-fight-loop.md, "Quest routes of the builds").
// Under Defence 90 the sweep takes the two prayer potions of the quest pack and reports them when the bank has none.
export const LOST_CITY_BUILD: Needs = {
    skills: { Attack: 60, Strength: 99, Prayer: 43, Hitpoints: 93 }, items: { 'prayer potion(4)': 2 }, pieces: { of: LOST_CITY_FOOD, count: 6 },
};

// The food that scripts/goldfarm.ts eats, and its rule for a thief with few Hitpoints (FRAIL_HP and FRAIL_FLOOR there;
// scripts/goldfarm.test.ts keeps the numbers equal): with fewer food items than the floor in its pack and its bank,
// that worker ends the run at once, so such an account gets no knight spot.
export const GOLDFARM_FOOD = ['slice of cake', '2/3 cake', 'cake', 'chocolate slice', 'bread', 'trout', 'salmon', 'lobster', 'shark'] as const;
export const GOLDFARM_FRAIL = { hitpoints: 20, of: GOLDFARM_FOOD, count: 2 } as const;
// The food buy of a frail thief that has coins and no food (plan): 200 units feed about one 9,000 tick run of an
// account with 99 Thieving (16 of 256 picks fail for 3 damage, about 0.19 damage a pick; estimate, not measured).
export const FRAIL_FOOD_BUY = 200, FRAIL_FOOD_BUY_ID = 'goldfarm-food';

export const HUNT_BAND = 10, HIDE_TARGET = 42;
export const HUNT_ARROWS = 600, HUNT_KILLS = 9, HUNT_FOOD = 6;
// The rune arrows of a hunt trip: a kill used 35, 47 and 14 rune arrows against 60, 81 and 52 mithril arrows, and took 236,
// 271 and 184 ticks against 312, 388 and 298 (bench cases extra:black-dragon-rune and boss:black-dragon, hosted run
// 44473165322, seeds 1 to 3). Nine kills at the most that one kill used, and the Ranging Guild shelf holds 400.
export const HUNT_RUNE_ARROWS = 400;
// Their price off a full shelf: 400 coins and 1% of it more for each arrow bought before (shop.rs2), 479,200 for 400.
export const HUNT_RUNE_SPEND = 500_000;
// What a hunter's supply run brings it up to: the arrows of two trips, and the air and fire runes of twenty teleports.
export const HUNT_ARROW_STOCK = 1200, HUNT_RUNE_STOCK = 60;
// Dragon longswords from Jakut (scripts/shop-buyer.ts profile jukat): the swords one visit buys (his shelf holds two,
// a unit of an emptied shelf costs 101,000), the coins the run takes for them with its reserve, the ticks it waits
// inside with no buy (six restocks: one diamond pays for the wait) and the run's tick cap.
export const JAKUT_SWORDS = 2, JAKUT_RESERVE = 5_000, JAKUT_COINS = JAKUT_SWORDS * 103_000 + JAKUT_RESERVE, JAKUT_WAIT = 3000, JAKUT_CAP = 9000;
// The armour of the hides (scripts/black-dhide-sets.ts): a set is a body, chaps and vambraces of SET_HIDES hides, the
// body asks Crafting LEATHER_LEVEL, a hide costs TAN_COIN to tan and a run takes SET_SHOP coins for a needle and
// thread. ARMOUR_SETS: the bodies one account makes, half the army's. FLAX_SPIN: the flax one spinning run takes.
export const LEATHER_LEVEL = 84, SET_HIDES = 6, TAN_COIN = 20, SET_SHOP = 100, ARMOUR_SETS = 7, FLAX_SPIN = 168;

// The first pass takes bands 0, 1 and 5; each later pass takes the next three bands from 10.
const COW_PASSES = [45, 60, 70, 80, 90, 99] as const;
export const COW_BANDS: readonly { skill: 'Strength' | 'Attack' | 'Defence'; band: number; to: number }[] = COW_PASSES.flatMap((to, k) =>
    (['Strength', 'Attack', 'Defence'] as const).map((skill, i) => ({ skill, to, band: k === 0 ? [0, 1, 5][i]! : 7 + 3 * k + i })));
const TROOPER_FOOD = ['shark', 'swordfish', 'lobster', 'trout', 'cooked meat', 'bread', 'chocolate slice', 'slice of cake', '2/3 cake', 'cake'] as const;
const TROOPER_STOCK = [...TROOPER_FOOD, 'raw beef'] as const;
// What feeds a trooper run: 10 pieces of stock held, or Thieving 5 with observed HP above half, with which the job's
// food stage steals a pack at the Ardougne baker's stalls (scripts/trooper-food.ts). Injury or unknown HP needs stock.
export const TROOPER_FED: readonly Needs[] = [{ pieces: { of: TROOPER_STOCK, count: 10 } }, { skills: { Thieving: 5 }, hpAboveHalf: true }];
export const TROOPER_BANDS: readonly { skill: 'Strength' | 'Attack' | 'Defence'; band: number }[] = [
    { skill: 'Strength', band: 6 }, { skill: 'Attack', band: 7 }, { skill: 'Defence', band: 8 },
];
export const MAGIC_BAND = 2, PRAYER_BAND = 3;
// Bought bones: Prayer XP a bury (scripts/train-prayer.ts BONE_XP; a test keeps the two tables equal), the bones the
// trainer keeps (its BONE_RESERVE floor) and the bones a bury band starts with.
export const BOUGHT_BONE_XP: Readonly<Record<number, number>> = { [objId('dragon bones')]: boneXp('dragon bones'), [objId('big bones')]: boneXp('big bones') };
export const BONE_KEEP = 6, BONE_START = 16, BONE_PURSE = 100_000, BONE_SKILL = 90;
export const PRAYER_FIELD_BAND = 9;
export const RANGED_BAND = 4, GUILD_BAND = 3.9, RANGED_TROOPER_DEFENCE = 60;
export const ZAFF_WAIT = 1100;
// What the alchemy supply jobs bring an account up to: feathers for every cast to 99, fire runes for Magic 21 to 66.
export const FEATHER_STOCK = 700, FIRE_STOCK = 500;
// What a Magic Guild trip brings an account up to: a nature rune and an air rune for every High Alchemy cast from
// Magic 66 to 99 (553 casts of 1,625 XP).
export const NATURE_STOCK = 600, AIR_STOCK = 600;

export const PICKAXES = ['bronze pickaxe', 'iron pickaxe', 'steel pickaxe', 'mithril pickaxe', 'adamant pickaxe', 'rune pickaxe'] as const;
export const AXES = ['bronze axe', 'iron axe', 'steel axe', 'black axe', 'mithril axe', 'adamant axe', 'rune axe'] as const;
// scripts/quest-sweep.ts MEALS, by item name (scripts/autopilot.test.ts checks the two agree).
export const SWEEP_MEALS = ['shark', 'swordfish', 'lobster', 'bass', 'tuna', 'trout', 'salmon', 'cake', '2/3 cake', 'slice of cake', 'bread'] as const;
// One pack of steel bars beside the ammo mould, and the food a blood chest run asks.
export const CANNON_BARS = 27, BLOOD_MEALS = 5;
// scripts/blood-chest.ts BANK_FOOD, by item name (scripts/autopilot.test.ts checks the two agree).
export const BLOOD_FOOD = ['shark', 'swordfish', 'lobster', 'tuna', 'salmon', 'trout', 'cake'] as const;
// The most units one run at the bank makes (scripts/microbot-production.ts MAX_MAKE), and the rings of one furnace
// trip: 13 gold bars and 13 gems fit beside the mould.
export const MAKE_BATCH = 100, RING_BATCH = 13, STEW_BATCH = 3;
// The unfinished potions of the route bill: the herb of the bill line (`<herb> potion (unf)`), the item the bank
// holds, and the Herblore level (brew_potion.struct; scripts/autopilot.test.ts checks each against the worker's recipe).
export const UNF_POTIONS: readonly (readonly [herb: string, item: string, level: number])[] = [
    ['guam', 'guam leaf', 3], ['marrentill', 'marrentill', 5], ['tarromin', 'tarromin', 12], ['harralander', 'harralander', 22], ['ranarr', 'ranarr weed', 30],
    ['toadflax', 'toadflax', 34], ['irit', 'irit leaf', 45], ['avantoe', 'avantoe', 50], ['kwuarm', 'kwuarm', 55], ['snapdragon', 'snapdragon', 63],
    ['cadantine', 'cadantine', 66], ['lantadyme', 'lantadyme', 69], ['dwarf weed', 'dwarf weed', 72], ['torstol', 'torstol', 78]];
// The gem rings of the route bill: the gem and the Crafting level (jewellery.struct).
export const GEM_RINGS: readonly (readonly [gem: string, level: number])[] = [['sapphire', 20], ['emerald', 27], ['ruby', 34], ['diamond', 43]];
export const LOST_CITY_MEAL_ITEMS = LOST_CITY_FOOD;

export const holdsUnderKeys = (items: readonly string[]) => Object.fromEntries(items.map(i => [i, 1]));
export const shopRun = (profile: string, cap: number, items: string, target: number, spend: number, wait = 25) => [
    'scripts/aio-market.ts', 'shop-buy', profile, String(cap), `ITEMS=${items}`, `STOCK_TARGET=${target}`,
    'STOP_AT_TARGET=1', 'BANK_PACK=1', 'BANK_AT=0', `NO_BUY_TICKS=${wait}`, `FLOAT=${spend + 1000}`, 'COIN_RESERVE=500', `MAX_SPEND=${spend}`,
].join(' ');
