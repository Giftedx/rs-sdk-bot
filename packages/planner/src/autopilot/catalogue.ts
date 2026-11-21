// Proven job template catalogues (army, quest demand, AIO skiller, squad supplies, maker chains/shops) and PK build band adaptation.
import { xpForLevel } from '../curve';
import { alchSupplies } from '../alch-plan';
import { boneXp, castRunes, objId, spellFact } from '../../../core/src/content-facts';
import {
    AIO_PLACES, ARMOUR_BAND, ARMY_BANK, BLACK_CAVE, CHICKEN_PENS, COW_FIELD, DRAYNOR_BANK, FEATHER_TARGET,
    FREMENNIK, FREMENNIK_BAND, FREMENNIK_MEALS, GRAIL_BAND, GRAIL_MEALS, GRAIL_PLACE, KNIGHT_SPOTS, LOST_CITY, LOST_CITY_MEALS,
    PEN_QUEST_POINTS, QUEST_BAND, QUEST_DEMAND, QUEST_DEMAND_BAND, QUEST_DEMAND_ROWS, REGICIDE_BAND, SEERS_BANK,
    SHOP_STOCK, SPLASH_FENCE, STRIKE_TILE, TROOPER_FIELD, UPASS, UPASS_BAND, WEAPON_BAND, norm, questDone,
    questResource, type Acct, type Needs, type Template,
} from './world';
import {
    ARROW_LOW, ARROW_STOCK, ARROWS, BOWS, FIRE_STAFFS, LOWE_STOCK,
    PICKAXE_LADDER, RANGED_KIT, RUNE_ARROW_COST, RUNE_ARROW_SPEND, SPLASH_KIT, SPLASH_START,
    SPLASH_TO, SQUAD_RUN_MAX, SQUAD_UNIT_COST, WEAPON_HELD, knightCoinsPerTick, splashKit,
} from './pricing';

export const GRAIL_RUNES: Readonly<Record<string, number>> = castRunes({ falador_teleport: 6, camelot_teleport: 5, varrock_teleport: 1 });
export const LOST_CITY_FOOD = ['lobster', 'swordfish', 'shark'] as const;
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
export const COW_PASSES = [45, 60, 70, 80, 90, 99] as const;
export const COW_BANDS: readonly { skill: 'Strength' | 'Attack' | 'Defence'; band: number; to: number }[] = COW_PASSES.flatMap((to, k) =>
    (['Strength', 'Attack', 'Defence'] as const).map((skill, i) => ({ skill, to, band: k === 0 ? [0, 1, 5][i]! : 7 + 3 * k + i })));
export const TROOPER_FOOD = ['shark', 'swordfish', 'lobster', 'trout', 'cooked meat', 'bread', 'chocolate slice', 'slice of cake', '2/3 cake', 'cake'] as const;
export const TROOPER_STOCK = [...TROOPER_FOOD, 'raw beef'] as const;
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

// The quest route of each PK build (scripts/pk-kits.ts), by kit name: the quests that the items and varps of the kit
// need. No reward of those quests, or of the quests they need, gives a level over the kit: scripts/pk-kits.ts
// `kitRoute` works the route out from the wear rules and the quest rewards of the content, and scripts/pk-kits.test.ts
// keeps this table equal to it (research/pvp-fight-loop.md, "Quest routes of the builds"). A band of the route runs
// every quest of its chain. The fights of Lost City give their XP to Strength and Hitpoints: the quest script sets
// that style before each fight (quest-lib.ts strengthStyle). A kit with no entry has no route.
const LOST: readonly string[] = ['Lost City'], NONE: readonly string[] = [], TRIALS: readonly string[] = ['The Fremennik Trials'];
export const BUILD_QUESTS: Readonly<Record<string, readonly string[]>> = {
    'pure-bolt': NONE, 'pure-dds': LOST, 'pure-dds-msb': LOST, 'pure-r2h': NONE,
    'pure-hally': ['Regicide'], 'pure-ranger': NONE, 'pure-mage': NONE, 'pure-tribrid': LOST, 'pure-pray': LOST, 'rune-pure': LOST,
    zerker: ['Lost City', 'The Fremennik Trials'], dragon: LOST, 'range-tank': TRIALS, 'mage-tank': NONE, 'pure-scim': NONE, 'pure-dlong': LOST,
    'pure-knives': LOST, 'pure-pray31': LOST, 'pure-god': ['Mage Arena'], 'pure-max': LOST, 'addy-pure': LOST, def50: LOST, 'tank-range': TRIALS,
    'baby-pure': NONE, 'low-ranger': NONE, 'low-mage': NONE, 'low-addy': NONE, skiller: NONE,
    // The least build that fights the dagger gang at its post (combat 111).
    'live-walker-iron-snare-rune-nopot-b111': ['Dragon Slayer', 'Lost City'],
};
// A quest of a route with the quests that it needs and that have a band of their own: a band for one of those is on
// the route too (scripts/pk-kits.ts QUEST_CHAIN has the whole chain of each quest).
export const ROUTE_BEFORE: Readonly<Record<string, readonly string[]>> = { Regicide: ['Underground Pass'] };
const onRoute = (quests: readonly string[], name: string) => quests.some(q => norm(q) === norm(name) || (ROUTE_BEFORE[q] ?? []).some(b => norm(b) === norm(name)));
// A goal band for an account with a PK build, or null when the account must not take it. A build is its levels: one
// level over the Defence or Prayer of a build is a different build, and no account goes back. So such an account
// takes only bands that train one skill, and a band stops at the level of the build:
// - a skill at its level takes no band;
// - a band of scripts/gather-combat.ts whose TRAIN_SKILL is the skill of the band stops at the level (TARGET_LEVEL;
//   giantStyle picks a style that gives XP to that skill and to Hitpoints only). It buries no bones (GIANT_BURY):
//   bones give Prayer XP whatever the band trains;
// - a gather-combat band with another TRAIN_SKILL or a kill count (GIANT_KILLS) is refused: the kill count replaces
//   the level stop, and TRAIN_SKILL=Hitpoints keeps the style the account had, which can train any melee skill;
// - the Prayer band that buries held normal bones (scripts/train-prayer.ts) stops at the level: its target argument;
// - the adaptive Ranged worker stops at its target argument and delegates troopers without burying bones;
// - a band of another script that ends above the level is refused: that script has no proved stop;
// - a quest band is refused unless the quest is on the route of the build (BUILD_QUESTS): a quest reward gives XP in
//   skills nobody chose. A quest of the route is refused too while a skill of the account is over its level before
//   the route (`before`): the reward on top of that level ends over the build. A band that names the skills its
//   chain gives XP in (`gives`) checks only those: Regicide gives no Attack, so the Attack 61 that Underground Pass
//   gave does not refuse it;
// - while a quest of the route is open, a training band stops at the level before the route, not at the level of
//   the build: the quest brings the rest;
// - a stock band is refused: a fight for loot gives XP in skills nobody chose.
// A `buildOnly` band goes to no account without a build.
export function buildBand(t: Template, a: Acct, build?: Readonly<Record<string, number>>, quests: readonly string[] = [], before?: Readonly<Record<string, number>>): Template | null {
    if (!build) return t.buildOnly ? null : t;
    if (t.tier !== 'goal') return t;
    if (t.quest) return onRoute(quests, t.quest.name) && Object.entries(before ?? {}).every(([skill, level]) => skill === 'Hitpoints' || (t.gives && !t.gives.includes(skill)) || (a.skills[skill] ?? 1) <= level) ? t : null;
    if (t.id === 'army-quest-fletch-30') return null;
    if (!t.trains) return null;
    if (t.route && !(onRoute(quests, t.route) && !questDone(a, t.route))) return null;
    const open = quests.some(q => !questDone(a, q)), cap = build[t.trains.skill];
    const level = cap !== undefined && open && before?.[t.trains.skill] !== undefined ? Math.min(cap, before[t.trains.skill]!) : cap;
    const combat = t.script === 'scripts/gather-combat.ts';
    if (combat && (t.env?.TRAIN_SKILL !== t.trains.skill || t.env.GIANT_KILLS !== undefined)) return null;
    if (level === undefined) return combat ? { ...t, env: { ...t.env, GIANT_BURY: '0' } } : t;
    if ((a.skills[t.trains.skill] ?? 1) >= level) return null;
    const to = Math.min(t.trains.to, level);
    if (combat) return { ...t, env: { ...t.env, TARGET_LEVEL: String(to), GIANT_BURY: '0' }, trains: { ...t.trains, to } };
    if (t.script === 'scripts/ranged-train.ts' && t.trains.skill === 'Ranged') return { ...t, args: [String(to), ...(t.args ?? []).slice(1)], env: { ...t.env, TARGET_LEVEL: String(to) }, trains: { ...t.trains, to } };
    // Normal bones give 112.5 Prayer XP each, under the XP of one level from level 6 up, and the worker counts its
    // buries from the XP still needed (planPrayer). A band of bought bones (BONE_ID) is refused: one dragon bone gives
    // 1,800 XP, more than the level after 43.
    if (t.script === 'scripts/train-prayer.ts' && t.env?.BONE_ID === undefined && !t.batchFor) return { ...t, args: [String(to)], trains: { ...t.trains, to } };
    return t.trains.to <= level ? t : null;
}

const PICKAXES = ['bronze pickaxe', 'iron pickaxe', 'steel pickaxe', 'mithril pickaxe', 'adamant pickaxe', 'rune pickaxe'] as const;
const AXES = ['bronze axe', 'iron axe', 'steel axe', 'black axe', 'mithril axe', 'adamant axe', 'rune axe'] as const;
// scripts/quest-sweep.ts MEALS, by item name (scripts/autopilot.test.ts checks the two agree).
export const SWEEP_MEALS = ['shark', 'swordfish', 'lobster', 'bass', 'tuna', 'trout', 'salmon', 'cake', '2/3 cake', 'slice of cake', 'bread'] as const;
export const BOWSTRING_BATCH = 56, SHAFT_LOGS = 25;
// One pack of steel bars beside the ammo mould, the loots of one blood chest run, and the food that run asks.
export const CANNON_BARS = 27, BLOOD_LOOTS = 6, BLOOD_MEALS = 5;
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

// One sweep job for each quest of QUEST_DEMAND_ROWS, run through the AIO route `quester:quest:<slug>`.
export function questDemand(): Template[] {
    return QUEST_DEMAND_ROWS.map((q, i): Template => ({
        id: `quest-${q.slug}`, family: `aio:quester:quest:${q.slug}`, script: 'scripts/aio.ts', args: ['quester', 'sweep', q.slug], aio: `quester:quest:${q.slug}`,
        worker: 'scripts/quest-sweep.ts', pilot: true, once: true, role: 'quest', goal: `complete ${q.name} once for the quest board`, tier: 'goal',
        ...(q.wilderness ? { wilderness: true as const } : {}),
        band: QUEST_DEMAND_BAND + i / 100, quest: { name: q.name, unlocks: [] }, resources: [questResource(q.slug), QUEST_DEMAND], yields: () => [],
        needs: { ...(Object.keys(q.skills).length ? { skills: q.skills } : {}), ...(q.quests.length ? { quests: q.quests } : {}), ...(q.questPoints ? { questPoints: q.questPoints } : {}),
            ...(Object.keys(q.items).length ? { items: q.items } : {}), ...(q.meals ? { pieces: { of: SWEEP_MEALS, count: q.meals } } : {}) },
        kitFirst: true,
    }));
}

export function aioTemplates(): Template[] {
    const aio = (id: string, key: string, worker: string, args: string[], rest: Omit<Template, 'id' | 'family' | 'script' | 'args' | 'aio' | 'worker' | 'pilot'>): Template =>
        ({ id, family: `aio:${key}`, script: 'scripts/aio.ts', args: [key.split(':')[0]!, ...args], aio: key, worker, pilot: true, ...rest });
    const essence = aio('aio-essence', 'skiller:mining:essence', 'scripts/gather-essence.ts', ['mining', 'essence', 'CAP=1800', 'BANK_AT=28'], {
        role: 'mining', goal: 'mine rune essence through Aubury and bank it at Varrock East', resources: [AIO_PLACES.essence],
        needs: { quests: ['Rune Mysteries Quest'], pieces: { of: PICKAXES, count: 1 } }, yields: () => [{ item: 'rune essence', perTick: 0.03 }] });
    // `load`: the bars of one pack load, which `needs` asks the ore and the coal for.
    const bars = (bar: string, level: number, ore: string, coal: number, load: number, perTick: number) =>
        aio(`aio-${bar}-bars`, 'skiller:smithing:smelt', 'scripts/smelt-bars.ts', ['smithing', 'smelt', '1500', bar, 'MAX_MAKE=28', 'ORE_RESERVE=0'], {
            role: 'smithing', goal: `smelt banked ${ore}${coal ? ' and coal' : ''} into ${bar} bars at Al Kharid`,
            repeats: false, production: { output: `${bar} bar`, outputPerUnit: 1, maximum: 28, inputs: { [ore]: 1, ...coal ? { coal } : {} },
                resize: n => ({ args: ['skiller', 'smithing', 'smelt', '1500', bar, `MAX_MAKE=${n}`, 'ORE_RESERVE=0'] }) },
            needs: { skills: { Smithing: level }, items: { [ore]: load, ...(coal ? { coal: coal * load } : {}) } }, yields: () => [{ item: `${bar} bar`, perTick }] });
    // One recipe of the bank-standing worker, up to MAKE_BATCH units of what the bank holds.
    const make = (id: string, recipe: string, goal: string, role: string, needs: Needs, item: string, consumed: Record<string, number> = needs.items ?? {}) =>
        aio(id, 'skiller:crafting:inventory', 'scripts/microbot-production.ts', ['crafting', 'inventory', recipe, `MAX_MAKE=${MAKE_BATCH}`, 'CAP=1500', 'MEMBERS=1', 'ORDER_MODE=best-effort'], {
            role, goal, needs, repeats: false, production: { output: item, outputPerUnit: 1, maximum: MAKE_BATCH, inputs: consumed,
                resize: n => ({ args: ['skiller', 'crafting', 'inventory', recipe, `MAX_MAKE=${n}`, 'CAP=1500', 'MEMBERS=1', 'ORDER_MODE=best-effort'] }) }, yields: () => [{ item, perTick: 0.1 }] });
    const potions = UNF_POTIONS.map(([herb, item, level]) => make(`aio-unf-${herb.replace(' ', '-')}`, `brew:unf_${herb.replace(' ', '_')}_potion`,
        `mix banked ${item} and vials of water into unfinished ${herb} potions`, 'herblore', { skills: { Herblore: level }, items: { [item]: 1, 'vial of water': 1 } }, `${herb} potion (unf)`));
    const dust = (id: string, raw: string, item: string) => make(id, `grind:${raw.replace(/ /g, '_')}`, `grind banked ${raw}s into ${item}`, 'herblore', { items: { 'pestle and mortar': 1, [raw]: 1 } }, item, { [raw]: 1 });
    const rings = GEM_RINGS.map(([gem, level]) => aio(`aio-${gem}-rings`, 'skiller:crafting:jewellery-trip', 'scripts/microbot-jewellery-trip.ts',
        ['crafting', 'jewellery-trip', `RECIPE=${gem}_ring`, `TARGET=${RING_BATCH}`, `BATCH=${RING_BATCH}`, 'CAP=1500'], {
            role: 'crafting', goal: `make ${RING_BATCH} ${gem} rings from banked gold bars and gems at the Al Kharid furnace`,
            repeats: false, production: { output: `${gem} ring`, outputPerUnit: 1, maximum: RING_BATCH, inputs: { 'gold bar': 1, [gem]: 1 },
                resize: n => ({ args: ['skiller', 'crafting', 'jewellery-trip', `RECIPE=${gem}_ring`, `TARGET=${n}`, `BATCH=${n}`, 'CAP=1500'] }) },
            needs: { skills: { Crafting: level }, items: { 'ring mould': 1, 'gold bar': RING_BATCH, [gem]: RING_BATCH } },
            yields: () => [{ item: `${gem} ring`, perTick: 0.05 }] }));
    return [
        aio('aio-flax', 'skiller:foraging:flax', 'scripts/gather-flax.ts', ['foraging', 'flax', '1800', '28'], {
            role: 'crafting', goal: 'pick flax at Seers and bank it', resources: [AIO_PLACES.flax], yields: () => [{ item: 'flax', perTick: 0.18 }] }),
        aio('aio-bowstrings', 'skiller:crafting:bowstrings', 'scripts/spin-bowstrings.ts', ['crafting', 'bowstrings', '1250', `MAX_MAKE=${BOWSTRING_BATCH}`, 'RAW_RESERVE=0', 'MAX_TRIPS=4'], {
            role: 'crafting', goal: `spin ${BOWSTRING_BATCH} banked flax into bow strings at Seers`, needs: { skills: { Crafting: 10 }, items: { flax: BOWSTRING_BATCH } },
            repeats: false, production: { output: 'bow string', outputPerUnit: 1, maximum: BOWSTRING_BATCH, inputs: { flax: 1 }, resize: n => ({ args: ['skiller', 'crafting', 'bowstrings', '1250', `MAX_MAKE=${n}`, 'RAW_RESERVE=0', 'MAX_TRIPS=4'] }) },
            yields: () => [{ item: 'bow string', perTick: 0.12 }] }),
        aio('aio-yews', 'skiller:woodcutting:yews', 'scripts/gather-yews.ts', ['woodcutting', 'yews', '1800', '27', 'MAX_TRIPS=4'], {
            role: 'woodcutting', goal: 'cut yew logs at Seers and bank them', resources: [AIO_PLACES.yews],
            needs: { skills: { Woodcutting: 60 }, pieces: { of: AXES, count: 1 } }, yields: () => [{ item: 'yew logs', perTick: 0.018 }] }),
        aio('aio-shafts', 'skiller:fletching:shafts', 'scripts/fletch-arrows.ts', ['fletching', 'shafts', '600', `MAX_MAKE=${SHAFT_LOGS}`, 'LOG_RESERVE=0'], {
            role: 'fletching', goal: `cut ${SHAFT_LOGS} banked logs into arrow shafts`, needs: { items: { knife: 1, logs: SHAFT_LOGS } },
            repeats: false, production: { output: 'arrow shaft', outputPerUnit: 15, maximum: SHAFT_LOGS, inputs: { logs: 1 }, resize: n => ({ args: ['skiller', 'fletching', 'shafts', '600', `MAX_MAKE=${n}`, 'LOG_RESERVE=0'] }) },
            yields: () => [{ item: 'arrow shaft', perTick: 1 }] }),
        aio('aio-ore', 'skiller:mining:ore', 'scripts/gather-ore.ts', ['mining', 'ore', '1800', '25', 'MAX_TRIPS=3'], {
            role: 'mining', goal: 'mine ore at Varrock East and bank three loads', resources: [AIO_PLACES.ore],
            needs: { combat: 13, pieces: { of: PICKAXES, count: 1 } },
            // Iron from Mining 15; copper and tin before it.
            yields: a => (a.skills.Mining ?? 1) >= 15 ? [{ item: 'iron ore', perTick: 0.064 }] : [{ item: 'copper ore', perTick: 0.032 }, { item: 'tin ore', perTick: 0.032 }] }),
        essence,
        aio('aio-air-runes', 'skiller:runecraft:bank-craft', 'scripts/rune-bank-craft.ts', ['runecraft', 'bank-craft', '99', 'RUNE_ALTAR=air', 'ESSENCE_TARGET=28', 'CAP=4000'], {
            role: 'magic', goal: 'craft 28 banked rune essence into air runes', resources: [AIO_PLACES.air],
            needs: { items: { 'air talisman': 1, 'rune essence': 28 } }, yields: () => [{ item: 'air rune', perTick: 0.09 }] }),
        bars('runite', 85, 'runite ore', 8, 2, 0.06),
        bars('adamantite', 70, 'adamantite ore', 6, 4, 0.07),
        bars('mithril', 50, 'mithril ore', 4, 5, 0.08),
        bars('iron', 15, 'iron ore', 0, 28, 0.074),
        bars('steel', 30, 'iron ore', 2, 9, 0.1),
        aio('aio-cannonballs', 'skiller:smithing:cannonballs', 'scripts/microbot-a-cannonballs.ts', ['smithing', 'cannonballs', String(CANNON_BARS), '1500', 'CANNON_XP_RATE=25'], {
            role: 'smithing', goal: `cast ${CANNON_BARS} banked steel bars into cannonballs at Al Kharid`,
            repeats: false, production: { output: 'cannonball', outputPerUnit: 4, maximum: CANNON_BARS, inputs: { 'steel bar': 1 }, resize: n => ({ args: ['skiller', 'smithing', 'cannonballs', String(n), '1500', 'CANNON_XP_RATE=25'] }) },
            needs: { skills: { Smithing: 35 }, items: { 'ammo mould': 1, 'steel bar': CANNON_BARS } }, yields: () => [{ item: 'cannonball', perTick: 0.2 }] }),
        aio('aio-rune-scimitars', 'skiller:smithing:anvil', 'scripts/smelt-bars.ts', ['smithing', 'anvil', '1500', 'PRODUCT_ID=1333', 'MAX_MAKE=1', 'BAR_RESERVE=0'], {
            role: 'smithing', goal: 'smith a rune scimitar from two banked runite bars at the Varrock West anvils',
            repeats: false, production: { output: 'rune scimitar', outputPerUnit: 1, maximum: 1, inputs: { 'runite bar': 2 }, resize: () => ({ args: ['skiller', 'smithing', 'anvil', '1500', 'PRODUCT_ID=1333', 'MAX_MAKE=1', 'BAR_RESERVE=0'] }) },
            needs: { skills: { Smithing: 90 }, items: { hammer: 1, 'runite bar': 2, coins: 10 } }, yields: () => [{ item: 'rune scimitar', perTick: 0.003 }] }),
        aio('aio-rune-axe', 'skiller:smithing:anvil', 'scripts/smelt-bars.ts', ['smithing', 'anvil', '1500', 'PRODUCT_ID=1359', 'MAX_MAKE=1', 'BAR_RESERVE=0'], {
            role: 'smithing', goal: 'smith a rune axe from a banked runite bar at the Varrock West anvils',
            repeats: false, production: { output: 'rune axe', outputPerUnit: 1, maximum: 1, inputs: { 'runite bar': 1 }, resize: () => ({ args: ['skiller', 'smithing', 'anvil', '1500', 'PRODUCT_ID=1359', 'MAX_MAKE=1', 'BAR_RESERVE=0'] }) },
            needs: { skills: { Smithing: 86 }, items: { hammer: 1, 'runite bar': 1, coins: 10 }, holdsUnder: { 'rune axe': 1 } }, yields: () => [{ item: 'rune axe', perTick: 0.003 }] }),
        ...potions,
        dust('aio-unicorn-horn-dust', 'unicorn horn', 'unicorn horn dust'),
        dust('aio-dragon-scale-dust', 'blue dragon scale', 'dragon scale dust'),
        ...rings,
        aio('aio-blood-chest', 'skiller:thieving:blood-chest', 'scripts/blood-chest.ts', ['thieving', 'blood-chest', '4000', `MAX_LOOTS=${BLOOD_LOOTS}`, 'CAP=4000'], {
            role: 'thieving', goal: `loot the Ardougne blood rune chests ${BLOOD_LOOTS} times and bank the runes`, resources: [AIO_PLACES.blood],
            needs: { skills: { Thieving: 59 }, pieces: { of: BLOOD_FOOD, count: BLOOD_MEALS } },
            yields: () => [{ item: 'blood rune', perTick: 0.01 }, { item: 'coins', perTick: 2.5 }] }),
        aio('aio-quest-runemysteries', 'quester:mode:sweep', 'scripts/quest-sweep.ts', ['sweep', 'runemysteries'], {
            role: 'quest', goal: 'complete Rune Mysteries for the essence mine', quest: { name: 'Rune Mysteries Quest', unlocks: [essence.id] },
            needs: { items: { 'law rune': 2, 'air rune': 6, 'fire rune': 1, 'earth rune': 1 }, pieces: { of: SWEEP_MEALS, count: 4 } }, yields: () => [] }),
    ];
}

// The essence of one water-rune craft run, as aio-air-runes (ESSENCE_TARGET=28).
export const SQUAD_CRAFT_ESSENCE = 28;
// The 15-arrow sets of one rune-arrow run, and the sharks of one shark run (the default count of scripts/shark-supply.ts).
export const SQUAD_RUNE_SETS = 20, SQUAD_SHARK_RUN = 25;
export function squadSupplies(): Template[] {
    const shop = (id: string, profile: string, item: string, items: string, perTick: number, goal: string, needs: Needs): Template => {
        const cost = SQUAD_UNIT_COST[item]!, max = SQUAD_RUN_MAX[item]!;
        const sized = (units: number, held = 0) => {
            const spend = Math.ceil(units * cost * 2);
            return { args: [profile, '1200'], env: { ITEMS: items, STOCK_TARGET: String(held + units), STOP_AT_TARGET: '1', BANK_PACK: '1', NO_BUY_TICKS: '25', FLOAT: String(spend + 200), COIN_RESERVE: '200', MAX_SPEND: String(spend) } };
        };
        return { id, family: 'shop-buyer', script: 'scripts/shop-buyer.ts', ...sized(max), role: 'bank', goal, resources: [`shop:${profile}`], needs, squadOnly: true,
            yields: () => [{ item, perTick }], spends: () => [{ item: 'coins', perTick: perTick * cost }], repeats: false,
            production: { output: item, outputPerUnit: 1, maximum: max, inputs: {}, resize: sized } };
    };
    const invMake = (
        id: string, recipe: string, item: string, level: number,
        inputs: Readonly<Record<string, number>>, tools: Readonly<Record<string, number>>,
        perTick = 0.1, goal = `make ${item} at the bank for the gang squad`, max = MAKE_BATCH,
        opts: { skill?: string; role?: string; members?: 0 | 1; strictOutput?: true; ownSupply?: readonly string[] } = {},
    ): Template => {
        const argsFor = (n: number) => [recipe, `MAX_MAKE=${n}`, 'CAP=1500', `MEMBERS=${opts.members ?? 1}`, 'ORDER_MODE=best-effort'];
        const skill = opts.skill ?? 'Herblore', role = opts.role ?? 'herblore';
        return {
            id, family: 'skiller:crafting:inventory', script: 'scripts/microbot-production.ts', args: argsFor(max), role,
            goal, resources: ['squad:herblore-bank'], squadOnly: true, repeats: false,
            ...(opts.ownSupply ? { ownSupply: opts.ownSupply } : {}),
            needs: { skills: { [skill]: level }, items: { ...inputs, ...tools } },
            production: { output: item, outputPerUnit: 1, maximum: max, inputs, ...(opts.strictOutput ? { strictOutput: true as const } : {}), resize: n => ({ args: argsFor(n) }) },
            yields: () => [{ item, perTick }],
        };
    };
    const bankJobArg = (job: Record<string, unknown>) => ['bank-job', `--job=${encodeURIComponent(JSON.stringify(job))}`];
    const smithAnvil = (id: string, productId: number, item: string, level: number, bars: number, outputPerUnit = 1, max = Math.max(1, Math.floor(27 / bars)), barName = 'runite bar'): Template => {
        const argsFor = (n: number) => ['skiller', 'smithing', 'anvil', '1500', 'ORDER_ACTION=smith', `PRODUCT_ID=${productId}`, `MAX_MAKE=${n}`, 'BAR_RESERVE=0'];
        return {
            id, family: 'aio:skiller:smithing:anvil', script: 'scripts/aio.ts', args: argsFor(max), role: 'smithing',
            goal: `smith ${item} from banked ${barName}s at Varrock West for supply demand`, resources: ['squad:varrock-smithing'], squadOnly: true, repeats: false,
            needs: { skills: { Smithing: level }, items: { hammer: 1, [barName]: bars, coins: 10 } },
            production: { output: item, outputPerUnit, maximum: max, inputs: { [barName]: bars }, resize: n => ({ args: argsFor(n) }) },
            yields: () => [{ item, perTick: 0.005 * outputPerUnit }],
        };
    };
    // Water runes crafted from banked rune essence at the water altar (scripts/rune-bank-craft.ts RUNE_ALTAR=water, bench case
    // extra:water-supply): one rune for each essence under Runecraft 19. The talisman is held for good; the essence comes from
    // the fleet's stock through the planner's item orders. The bench case makes 10 runes in 399 to 403 ticks from the Draynor
    // bank (hosted run 44464164017, seeds 1 to 3); the rate below is an estimate for a 28-essence run.
    const waterCraft: Template = { id: 'squad-water-craft', family: 'aio:skiller:runecraft:bank-craft', script: 'scripts/aio.ts', aio: 'skiller:runecraft:bank-craft',
        worker: 'scripts/rune-bank-craft.ts', args: ['skiller', 'runecraft', 'bank-craft', '99', 'RUNE_ALTAR=water', `ESSENCE_TARGET=${SQUAD_CRAFT_ESSENCE}`, 'CAP=4000'],
        role: 'magic', goal: 'craft banked rune essence into water runes at the water altar for the gang squad', resources: ['aio:water-altar'], squadOnly: true,
        needs: { skills: { Runecraft: 5 }, items: { 'water talisman': 1, 'rune essence': SQUAD_CRAFT_ESSENCE } }, repeats: false,
        production: { output: 'water rune', outputPerUnit: 1, maximum: SQUAD_CRAFT_ESSENCE, inputs: { 'rune essence': 1 },
            resize: n => ({ args: ['skiller', 'runecraft', 'bank-craft', '99', 'RUNE_ALTAR=water', `ESSENCE_TARGET=${n}`, 'CAP=4000'] }) },
        yields: () => [{ item: 'water rune', perTick: 0.08 }] };
    const earthCraft: Template = { id: 'squad-earth-craft', family: 'aio:skiller:runecraft:bank-craft', script: 'scripts/aio.ts', aio: 'skiller:runecraft:bank-craft',
        worker: 'scripts/rune-bank-craft.ts', args: ['skiller', 'runecraft', 'bank-craft', '99', 'RUNE_ALTAR=earth', `ESSENCE_TARGET=${SQUAD_CRAFT_ESSENCE}`, 'CAP=4000'],
        role: 'magic', goal: 'craft banked rune essence into earth runes at the earth altar for the gang squad', resources: ['squad:varrock-earth-altar'], squadOnly: true,
        needs: { skills: { Runecraft: 9 }, items: { 'earth talisman': 1, 'rune essence': SQUAD_CRAFT_ESSENCE } }, repeats: false,
        production: { output: 'earth rune', outputPerUnit: 1, maximum: SQUAD_CRAFT_ESSENCE, inputs: { 'rune essence': 1 },
            resize: n => ({ args: ['skiller', 'runecraft', 'bank-craft', '99', 'RUNE_ALTAR=earth', `ESSENCE_TARGET=${n}`, 'CAP=4000'] }) },
        yields: () => [{ item: 'earth rune', perTick: 0.08 }] };
    const cosmicCraft: Template = { id: 'squad-cosmic-craft', family: 'aio:skiller:runecraft:bank-craft', script: 'scripts/aio.ts', aio: 'skiller:runecraft:bank-craft',
        worker: 'scripts/rune-bank-craft.ts', args: ['skiller', 'runecraft', 'bank-craft', '99', 'RUNE_ALTAR=cosmic', `ESSENCE_TARGET=${SQUAD_CRAFT_ESSENCE}`, 'CAP=4000'],
        role: 'magic', goal: 'craft banked rune essence into cosmic runes in Zanaris for ring of recoil enchanting', resources: ['squad:cosmic-altar'], squadOnly: true,
        needs: { skills: { Runecraft: 27 }, quests: ['Lost City'], items: { 'dramen staff': 1, 'cosmic talisman': 1, 'rune essence': SQUAD_CRAFT_ESSENCE } }, repeats: false,
        production: { output: 'cosmic rune', outputPerUnit: 1, maximum: SQUAD_CRAFT_ESSENCE, inputs: { 'rune essence': 1 },
            resize: n => ({ args: ['skiller', 'runecraft', 'bank-craft', '99', 'RUNE_ALTAR=cosmic', `ESSENCE_TARGET=${n}`, 'CAP=4000'] }) },
        yields: () => [{ item: 'cosmic rune', perTick: 0.08 }] };
    // The water talisman that squad-water-craft needs: wizards at the Wizards' Tower until one drops (3 in 128; scripts/
    // gather-combat.ts TARGET=wizard UNTIL_ITEM, bench case fighter:wizard). No shop sells one and the Grand Exchange holds none.
    const waterTalisman: Template = { id: 'squad-water-talisman', family: 'aio:fighter:wizard', script: 'scripts/aio.ts', aio: 'fighter:wizard',
        worker: 'scripts/gather-combat.ts', args: ['fighter', 'wizard', '10000', 'wizard', 'MAX_KILLS=200', 'UNTIL_ITEM=water talisman'],
        role: 'combat', goal: "kill wizards at the Wizards' Tower until a water talisman drops, for the gang squad's water runes", resources: ['fighter:wizards-tower'], squadOnly: true,
        needs: { combat: 40, holdsUnder: { 'water talisman': 1 } }, repeats: false, yields: () => [], provides: { item: 'water talisman', unlocks: ['squad-water-craft'] } };
    // Rune arrows from the fleet's headless arrows, one chain job: rune arrowtips bought at Hickton's in Catherby (200 coins,
    // half the price of a finished rune arrow), then 15 tips with 15 headless arrows into 15 rune arrows at the Catherby bank
    // (scripts/fletch-arrows.ts MODE=native-arrows TIP_TYPE=rune, arrows.dbrow: Fletching 75). One job, because the planner
    // finds a missing input only in stock and on the market, not from another maker. Bench case extra:fletch-rune-arrows: 30
    // arrows in 14 ticks (hosted run 44470543603); the tip purchase is not in that time.
    const runeSteps = (sets: number) => {
        const tips = sets * 15, spend = tips * SQUAD_UNIT_COST['rune arrowtips']! * 2;
        return [`scripts/shop-buyer.ts catherby 1200 ITEMS=rune.arrowtips STOCK_TARGET=${tips} STOP_AT_TARGET=1 BANK_PACK=1 NO_BUY_TICKS=25 FLOAT=${spend + 200} COIN_RESERVE=200 MAX_SPEND=${spend}`,
            `scripts/fletch-arrows.ts 3000 native-arrows rune MAX_MAKE=${tips} HEADLESS_RESERVE=0 TIP_RESERVE=0`];
    };
    const runeArrows: Template = { id: 'squad-rune-arrows', family: 'fletch', script: 'scripts/chain.ts', args: runeSteps(SQUAD_RUNE_SETS), env: { ROUNDS: '1' },
        role: 'fletching', goal: 'buy rune arrowtips at Catherby and fletch them with banked headless arrows into rune arrows for the gang squad',
        resources: ['shop:catherby'], squadOnly: true, repeats: false,
        needs: { skills: { Fletching: 75 }, items: { coins: SQUAD_RUNE_SETS * 15 * SQUAD_UNIT_COST['rune arrowtips']! * 2 + 200, 'headless arrow': SQUAD_RUNE_SETS * 15 } },
        production: { output: 'rune arrow', outputPerUnit: 15, maximum: SQUAD_RUNE_SETS, inputs: { 'headless arrow': 15 }, resize: n => ({ args: runeSteps(n) }) },
        yields: () => [{ item: 'rune arrow', perTick: 1 }], spends: () => [{ item: 'coins', perTick: SQUAD_UNIT_COST['rune arrowtips']! }] };
    const bankedRuneArrowSets = SQUAD_RUNE_SETS * 2;
    const fletchBankedRuneArrows: Template = {
        id: 'squad-fletch-rune-arrows-bank', family: 'fletch', script: 'scripts/fletch-arrows.ts',
        args: ['3000', 'native-arrows', 'rune'], env: { MAX_MAKE: String(bankedRuneArrowSets * 15), HEADLESS_RESERVE: '0', TIP_RESERVE: '0' },
        role: 'fletching', goal: 'fletch banked rune arrowtips and headless arrows into rune arrows for the gang squad',
        resources: ['squad:herblore-bank'], squadOnly: true, repeats: false,
        needs: { skills: { Fletching: 75 }, items: { 'headless arrow': 15, 'rune arrowtips': 15 } },
        production: {
            output: 'rune arrow', outputPerUnit: 15, maximum: bankedRuneArrowSets, inputs: { 'headless arrow': 15, 'rune arrowtips': 15 },
            resize: n => ({ args: ['3000', 'native-arrows', 'rune'], env: { MAX_MAKE: String(n * 15), HEADLESS_RESERVE: '0', TIP_RESERVE: '0' } }),
        },
        yields: () => [{ item: 'rune arrow', perTick: 2 }],
    };
    // Sharks fished and cooked at Catherby (scripts/shark-supply.ts: Fishing 76, Cooking 80; it buys a harpoon when it has none,
    // and it carries two banked trout, salmon or lobsters for the way back). Bench case extra:shark-supply: 3 sharks in 182, 250 and
    // 348 ticks (hosted run 44470543603, seeds 1 to 3); the rate is from those runs.
    const sharkSteps = (n: number) => ({ args: [String(n), '9000'], env: { SHARK_CONSUMER: 'gang squad' } });
    const sharks: Template = { id: 'squad-sharks', family: 'shark-supply', script: 'scripts/shark-supply.ts', ...sharkSteps(SQUAD_SHARK_RUN),
        role: 'fishing', goal: 'fish and cook sharks at Catherby for the gang squad', resources: ['squad:catherby-sharks'], squadOnly: true, repeats: false,
        needs: { skills: { Fishing: 76, Cooking: 80 }, items: { lobster: 2 } },
        production: { output: 'shark', outputPerUnit: 1, maximum: SQUAD_SHARK_RUN, inputs: {}, resize: n => sharkSteps(n) },
        yields: () => [{ item: 'shark', perTick: 0.01 }] };
    // Karambwanji and karambwan fishing (Shilo Village + Tai Bwo Wannai Trio), vessel buy fallback, and Catherby cooking.
    const karambwanjiFish: Template = {
        id: 'squad-karambwanji-fish', family: 'aio-skiller:bank-job', script: 'scripts/aio-skiller.ts',
        args: bankJobArg({ family: 'fishing', recipe: 'karambwanji', target: 100, batch: 25, cap: 3000, returnTicks: 600, members: true, reserve: 0, bank: { x: 2852, z: 2955, level: 0 }, site: { x: 2806, z: 3009, level: 0 } }),
        role: 'fishing', goal: 'fish raw karambwanji near Tai Bwo Wannai for karambwan bait', resources: ['squad:shilo-karambwanji'], squadOnly: true, repeats: false,
        needs: { skills: { Fishing: 5, Prayer: 43 }, quests: ['Shilo Village', 'Tai Bwo Wannai Trio'], items: { 'small fishing net': 1 } },
        production: { output: 'raw karambwanji', outputPerUnit: 1, maximum: 100, inputs: {},
            resize: n => ({ args: bankJobArg({ family: 'fishing', recipe: 'karambwanji', target: n, batch: Math.min(25, n), cap: 3000, returnTicks: 600, members: true, reserve: 0, bank: { x: 2852, z: 2955, level: 0 }, site: { x: 2806, z: 3009, level: 0 } }) }) },
        yields: () => [{ item: 'raw karambwanji', perTick: 0.05 }],
    };
    const karambwanFish: Template = {
        id: 'squad-karambwan-fish', family: 'aio-skiller:bank-job', script: 'scripts/aio-skiller.ts',
        args: bankJobArg({ family: 'fishing', recipe: 'karambwan', target: 27, batch: 9, cap: 3000, returnTicks: 600, members: true, reserve: 0, bank: { x: 2852, z: 2955, level: 0 }, site: { x: 2899, z: 3118, level: 0 } }),
        role: 'fishing', goal: 'fish raw karambwan north of Tai Bwo Wannai and bank at Shilo Village', resources: ['squad:shilo-karambwan'], squadOnly: true, repeats: false,
        needs: { skills: { Fishing: 65, Prayer: 43 }, quests: ['Shilo Village', 'Tai Bwo Wannai Trio'], items: { 'karambwan vessel': 1, 'raw karambwanji': 27 } },
        production: { output: 'raw karambwan', outputPerUnit: 1, maximum: 27, inputs: { 'raw karambwanji': 3 },
            resize: n => ({ args: bankJobArg({ family: 'fishing', recipe: 'karambwan', target: n, batch: Math.min(9, n), cap: 3000, returnTicks: 600, members: true, reserve: 0, bank: { x: 2852, z: 2955, level: 0 }, site: { x: 2899, z: 3118, level: 0 } }) }) },
        yields: () => [{ item: 'raw karambwan', perTick: 0.02 }],
    };
    const tiadecheDangerGate: readonly Needs[] = [{ skills: { Hitpoints: 22 } }, { combat: 32 }, { skills: { Prayer: 43 } }];
    const karambwanVessel: Template = {
        id: 'squad-karambwan-vessel', family: 'shop-buyer', script: 'scripts/shop-buyer.ts',
        args: ['tiadeche', '1200'], env: { ITEMS: 'karambwan vessel', STOCK_TARGET: '2', STOP_AT_TARGET: '1', BANK_PACK: '1', NO_BUY_TICKS: '25', FLOAT: '500', COIN_RESERVE: '200', MAX_SPEND: '200' },
        role: 'bank', goal: 'buy karambwan vessels from Tiadeche for squad karambwan fishing', resources: ['shop:tiadeche'], squadOnly: true, repeats: false,
        needs: { quests: ['Tai Bwo Wannai Trio'], items: { coins: 500 }, holdsUnder: { 'karambwan vessel': 1 }, anyOf: tiadecheDangerGate },
        yields: () => [], provides: { item: 'karambwan vessel', unlocks: ['squad-karambwan-fish'] },
    };
    const karambwanCook: Template = {
        id: 'squad-karambwan-cook', family: 'aio-skiller:bank-job', script: 'scripts/aio-skiller.ts',
        args: bankJobArg({ family: 'cooking', recipe: 'cooking_generic_karambwan', target: 112, batch: 28, cap: 1500, returnTicks: 300, members: true, reserve: 0 }),
        role: 'cooking', goal: 'cook banked raw karambwan at Catherby range for the gang squad', resources: ['squad:catherby-cooking'], squadOnly: true, repeats: false,
        needs: { skills: { Cooking: 30 }, quests: ['Tai Bwo Wannai Trio'], items: { 'raw karambwan': 1 } },
        production: { output: 'cooked karambwan', outputPerUnit: 1, maximum: 112, inputs: { 'raw karambwan': 1 },
            resize: n => ({ args: bankJobArg({ family: 'cooking', recipe: 'cooking_generic_karambwan', target: n, batch: Math.min(28, n), cap: 1500, returnTicks: 300, members: true, reserve: 0 }) }) },
        yields: () => [{ item: 'cooked karambwan', perTick: 0.15 }],
    };
    // Magic logs and Magic shortbow stringing chain at Seers' Village.
    const magicLogs: Template = {
        id: 'squad-magic-logs', family: 'aio:skiller:woodcutting:yews', script: 'scripts/aio.ts',
        args: ['skiller', 'woodcutting', 'yews', '3000', '27', 'MAX_TRIPS=4', 'TREE=magic', 'WOOD_GROVE=native-processing'],
        role: 'woodcutting', goal: "chop magic logs at Seers' Village for squad magic shortbows", resources: ['squad:seers-magic-trees'], squadOnly: true, repeats: false,
        needs: { skills: { Woodcutting: 75 }, pieces: { of: ['rune axe', 'adamant axe', 'mithril axe', 'black axe', 'steel axe'], count: 1 } },
        yields: () => [{ item: 'magic log', perTick: 0.01 }],
    };
    const bowStep = (recipe: string, n: number) => `scripts/aio.ts skiller crafting inventory ${recipe} MAX_MAKE=${n} CAP=1500 MEMBERS=1 ORDER_MODE=best-effort`;
    const bowBankWalk = `scripts/walk-to.ts ${SEERS_BANK.x} ${SEERS_BANK.z}`;
    const magicShortbow: Template = {
        id: 'squad-magic-shortbow', family: 'fletch', script: 'scripts/chain.ts',
        args: [bowBankWalk, bowStep('cut-bow:unstrung_magic_shortbow', 4), bowStep('bow-string:magic_shortbow', 4)], env: { ROUNDS: '1' },
        role: 'fletching', goal: 'cut banked magic logs into magic shortbows and string them for the gang squad', resources: ['squad:seers-fletch'], squadOnly: true, repeats: false,
        needs: { skills: { Fletching: 80 }, items: { knife: 1, 'magic log': 1, 'bow string': 1 } },
        production: { output: 'magic shortbow', outputPerUnit: 1, maximum: 4, inputs: { 'magic log': 1, 'bow string': 1 },
            resize: n => ({ args: [bowBankWalk, bowStep('cut-bow:unstrung_magic_shortbow', n), bowStep('bow-string:magic_shortbow', n)] }) },
        yields: () => [{ item: 'magic shortbow', perTick: 0.02 }],
    };
    // Black dragonhide from non-Wilderness Taverley Black Dragons -> tanned and crafted sets/vambraces at Al Kharid.
    const taverleyBlackDragons: Template = {
        id: 'squad-taverley-black-dragon', family: 'combat', script: 'scripts/gather-combat.ts',
        args: ['6000', 'taverley_black_dragon'], env: { MAX_KILLS: '10' }, role: 'combat',
        goal: 'slay Black dragons in Taverley Dungeon (non-Wilderness) for black dragonhide and blood/law runes',
        resources: ['squad:taverley-black-dragons'], squadOnly: true, repeats: false,
        needs: { combat: 85, items: { 'anti-dragon shield': 1, 'dusty key': 1 }, food: 8 },
        yields: () => [{ item: 'dragonhide_black', perTick: 0.01 }, { item: 'blood rune', perTick: 0.02 }, { item: 'law rune', perTick: 0.02 }],
    };
    const blackDhideSets: Template = {
        id: 'squad-black-dhide-sets', family: 'aio:skiller:crafting:black-dhide-sets', script: 'scripts/black-dhide-sets.ts',
        args: [], role: 'crafting', goal: 'tan banked black dragonhide at Al Kharid and craft full black dragonhide sets for the gang squad',
        resources: ['squad:al-kharid-craft'], squadOnly: true, repeats: false,
        needs: { skills: { Crafting: LEATHER_LEVEL }, items: { coins: SET_HIDES * TAN_COIN + SET_SHOP, dragonhide_black: SET_HIDES } },
        yields: () => [{ item: 'black_dragonhide_body', perTick: 0.02 }, { item: 'black_dragonhide_chaps', perTick: 0.02 }, { item: 'black_dragon_vambraces', perTick: 0.02 }],
    };
    const blackDhideVambraces: Template = {
        id: 'squad-black-dhide-vambraces', family: 'aio:skiller:crafting:black-dhide-sets', script: 'scripts/black-dhide-sets.ts',
        args: [], env: { PIECE: 'vambraces', SETS: '0' }, role: 'crafting',
        goal: 'tan banked black dragonhide or craft black dragon leather into black dragonhide vambraces at Al Kharid',
        resources: ['squad:al-kharid-craft'], squadOnly: true, repeats: false,
        needs: { skills: { Crafting: 79 }, items: { coins: TAN_COIN + SET_SHOP }, anyOf: [{ items: { dragonhide_black: 1 } }, { items: { dragon_leather_black: 1 } }] },
        yields: () => [{ item: 'black_dragon_vambraces', perTick: 0.02 }],
    };
    // Rings of Recoil: mine gold ore -> smelt gold bars -> cut sapphires -> craft sapphire rings -> enchant lvl 1.
    const goldOre: Template = {
        id: 'squad-gold-ore', family: 'aio-skiller:bank-job', script: 'scripts/aio-skiller.ts',
        args: bankJobArg({ family: 'mining', recipe: 'gold_rock_table', target: 28, batch: 28, cap: 2500, returnTicks: 300, members: true, reserve: 0, bank: { x: 2946, z: 3368, level: 0 }, site: { x: 2977, z: 3233, level: 0 } }),
        role: 'mining', goal: 'mine gold ore at Rimmington and bank at Falador West for sapphire rings', resources: ['squad:rimmington-gold'], squadOnly: true, repeats: false,
        needs: { skills: { Mining: 40 }, pieces: { of: PICKAXES, count: 1 } },
        yields: () => [{ item: 'gold ore', perTick: 0.05 }],
    };
    const goldBars: Template = {
        id: 'squad-gold-bars', family: 'aio:skiller:smithing:smelt', script: 'scripts/aio.ts',
        args: ['skiller', 'smithing', 'smelt', '1500', 'gold', 'MAX_MAKE=28', 'ORE_RESERVE=0'], role: 'smithing',
        goal: 'smelt banked gold ore into gold bars at Al Kharid for sapphire rings', resources: ['squad:al-kharid-craft'], squadOnly: true, repeats: false,
        needs: { skills: { Smithing: 40 }, items: { 'gold ore': 28 } },
        production: { output: 'gold bar', outputPerUnit: 1, maximum: 28, inputs: { 'gold ore': 1 },
            resize: n => ({ args: ['skiller', 'smithing', 'smelt', '1500', 'gold', `MAX_MAKE=${n}`, 'ORE_RESERVE=0'] }) },
        yields: () => [{ item: 'gold bar', perTick: 0.08 }],
    };
    const cutSapphire: Template = {
        id: 'squad-cut-sapphire', family: 'skiller:crafting:inventory', script: 'scripts/microbot-production.ts',
        args: ['cut-sapphire', `MAX_MAKE=${MAKE_BATCH}`, 'CAP=1500', 'MEMBERS=0', 'ORDER_MODE=best-effort'], role: 'crafting',
        goal: 'cut banked uncut sapphires for sapphire rings', resources: ['squad:herblore-bank'], squadOnly: true, repeats: false,
        needs: { skills: { Crafting: 20 }, items: { chisel: 1, 'uncut sapphire': 1 } },
        production: { output: 'sapphire', outputPerUnit: 1, maximum: MAKE_BATCH, inputs: { 'uncut sapphire': 1 },
            resize: n => ({ args: ['cut-sapphire', `MAX_MAKE=${n}`, 'CAP=1500', 'MEMBERS=0', 'ORDER_MODE=best-effort'] }) },
        yields: () => [{ item: 'sapphire', perTick: 0.15 }],
    };
    const cutEmerald: Template = {
        id: 'squad-cut-emerald', family: 'skiller:crafting:inventory', script: 'scripts/microbot-production.ts',
        args: ['cut-emerald', `MAX_MAKE=${MAKE_BATCH}`, 'CAP=1500', 'MEMBERS=0', 'ORDER_MODE=best-effort'], role: 'crafting',
        goal: 'cut banked uncut emeralds for emerald rings', resources: ['squad:herblore-bank'], squadOnly: true, repeats: false,
        needs: { skills: { Crafting: 27 }, items: { chisel: 1, 'uncut emerald': 1 } },
        production: { output: 'emerald', outputPerUnit: 1, maximum: MAKE_BATCH, inputs: { 'uncut emerald': 1 },
            resize: n => ({ args: ['cut-emerald', `MAX_MAKE=${n}`, 'CAP=1500', 'MEMBERS=0', 'ORDER_MODE=best-effort'] }) },
        yields: () => [{ item: 'emerald', perTick: 0.15 }],
    };
    const sapphireRings: Template = {
        id: 'squad-sapphire-ring', family: 'aio:skiller:crafting:jewellery-trip', script: 'scripts/aio.ts',
        args: ['skiller', 'crafting', 'jewellery-trip', 'RECIPE=sapphire_ring', `TARGET=${RING_BATCH}`, `BATCH=${RING_BATCH}`, 'CAP=1500'], role: 'crafting',
        goal: 'smith banked gold bars and cut sapphires into sapphire rings at Al Kharid', resources: ['squad:al-kharid-craft'], squadOnly: true, repeats: false,
        needs: { skills: { Crafting: 20 }, items: { 'ring mould': 1, 'gold bar': 1, sapphire: 1 } },
        production: { output: 'sapphire ring', outputPerUnit: 1, maximum: RING_BATCH, inputs: { 'gold bar': 1, sapphire: 1 },
            resize: n => ({ args: ['skiller', 'crafting', 'jewellery-trip', 'RECIPE=sapphire_ring', `TARGET=${n}`, `BATCH=${n}`, 'CAP=1500'] }) },
        yields: () => [{ item: 'sapphire ring', perTick: 0.05 }],
    };
    const emeraldRings: Template = {
        id: 'squad-emerald-ring', family: 'aio:skiller:crafting:jewellery-trip', script: 'scripts/aio.ts',
        args: ['skiller', 'crafting', 'jewellery-trip', 'RECIPE=emerald_ring', `TARGET=${RING_BATCH}`, `BATCH=${RING_BATCH}`, 'CAP=1500'], role: 'crafting',
        goal: 'smith banked gold bars and cut emeralds into emerald rings at Al Kharid', resources: ['squad:al-kharid-craft'], squadOnly: true, repeats: false,
        needs: { skills: { Crafting: 27 }, items: { 'ring mould': 1, 'gold bar': 1, emerald: 1 } },
        production: { output: 'emerald ring', outputPerUnit: 1, maximum: RING_BATCH, inputs: { 'gold bar': 1, emerald: 1 },
            resize: n => ({ args: ['skiller', 'crafting', 'jewellery-trip', 'RECIPE=emerald_ring', `TARGET=${n}`, `BATCH=${n}`, 'CAP=1500'] }) },
        yields: () => [{ item: 'emerald ring', perTick: 0.05 }],
    };
    const enchantRecoil: Template = {
        id: 'squad-ring-of-recoil', family: 'aio:skiller:magic:items', script: 'scripts/aio.ts',
        args: ['skiller', 'magic', 'items', 'enchant:sapphire_ring', '-', '27', '1500'], role: 'magic',
        goal: 'enchant banked sapphire rings into rings of recoil at the Draynor bank', resources: ['squad:magic-enchant'], squadOnly: true, repeats: false,
        needs: { skills: { Magic: 7 }, items: { 'sapphire ring': 1, 'cosmic rune': 1, 'water rune': 1 } },
        production: { output: 'ring of recoil', outputPerUnit: 1, maximum: 27, inputs: { 'sapphire ring': 1, 'cosmic rune': 1, 'water rune': 1 },
            resize: n => ({ args: ['skiller', 'magic', 'items', 'enchant:sapphire_ring', '-', String(n), '1500'] }) },
        yields: () => [{ item: 'ring of recoil', perTick: 0.25 }],
    };
    const enchantDueling: Template = {
        id: 'squad-ring-of-dueling', family: 'aio:skiller:magic:items', script: 'scripts/aio.ts',
        args: ['skiller', 'magic', 'items', 'enchant:emerald_ring', '-', '27', '1500'], role: 'magic',
        goal: 'enchant banked emerald rings into rings of dueling(8) at the Draynor bank', resources: ['squad:magic-enchant'], squadOnly: true, repeats: false,
        needs: { skills: { Magic: 27 }, items: { 'emerald ring': 1, 'cosmic rune': 1, 'air rune': 3 } },
        production: { output: 'ring of dueling(8)', outputPerUnit: 1, maximum: 27, inputs: { 'emerald ring': 1, 'cosmic rune': 1, 'air rune': 3 },
            resize: n => ({ args: ['skiller', 'magic', 'items', 'enchant:emerald_ring', '-', String(n), '1500'] }) },
        yields: () => [{ item: 'ring of dueling(8)', perTick: 0.25 }],
    };
    // Non-Wilderness mainland gatherers for potions, secondaries and runes.
    const taverleyDruids: Template = {
        id: 'squad-taverley-druids', family: 'combat', script: 'scripts/gather-combat.ts',
        args: ['6000', 'taverley_druid'], env: { MAX_KILLS: '40' }, role: 'combat',
        goal: 'farm Taverley Dungeon Chaos druids (non-Wilderness) for herbs, snape grass, law and nature runes',
        resources: ['squad:taverley-druids'], squadOnly: true, repeats: false,
        needs: { combat: 25, food: 4 },
        yields: () => [
            { item: 'unidentified ranarr', perTick: 0.01 }, { item: 'unidentified irit', perTick: 0.01 },
            { item: 'unidentified kwuarm', perTick: 0.008 }, { item: 'unidentified cadantine', perTick: 0.006 },
            { item: 'unidentified dwarf weed', perTick: 0.006 }, { item: 'unidentified marentill', perTick: 0.012 },
            { item: 'unidentified avantoe', perTick: 0.005 }, { item: 'unidentified toadflax', perTick: 0.004 },
            { item: 'unidentified harralander', perTick: 0.008 }, { item: 'snape grass', perTick: 0.005 },
            { item: 'nature rune', perTick: 0.02 }, { item: 'law rune', perTick: 0.015 },
        ],
    };
    const taverleyBlackKnights: Template = {
        id: 'squad-taverley-black-knights', family: 'combat', script: 'scripts/gather-combat.ts',
        args: ['6000', 'taverley_black_knight'], env: { MAX_KILLS: '40' }, role: 'combat',
        goal: 'farm Taverley Dungeon Black Knights (non-Wilderness) for death, chaos, cosmic and law runes',
        resources: ['squad:taverley-black-knights'], squadOnly: true, repeats: false,
        needs: { combat: 45, food: 6 },
        yields: () => [
            { item: 'death rune', perTick: 0.015 }, { item: 'chaos rune', perTick: 0.025 },
            { item: 'cosmic rune', perTick: 0.008 }, { item: 'law rune', perTick: 0.01 },
            { item: 'unidentified ranarr', perTick: 0.004 }, { item: 'mithril bar', perTick: 0.005 },
        ],
    };
    const ardougneGiants: Template = {
        id: 'squad-ardougne-giants', family: 'combat', script: 'scripts/gather-combat.ts',
        args: ['6000', 'giant'], env: { MAX_KILLS: '40' }, role: 'combat',
        goal: 'farm surface Hill Giants for limpwurt roots, cosmic, death, chaos and nature runes and herbs',
        resources: ['squad:ardougne-giants'], squadOnly: true, repeats: false,
        needs: { combat: 30, food: 4 },
        yields: () => [
            { item: 'limpwurt root', perTick: 0.02 }, { item: 'nature rune', perTick: 0.03 },
            { item: 'cosmic rune', perTick: 0.015 }, { item: 'law rune', perTick: 0.015 },
            { item: 'chaos rune', perTick: 0.01 }, { item: 'death rune', perTick: 0.004 },
            { item: 'uncut sapphire', perTick: 0.003 }, { item: 'uncut emerald', perTick: 0.003 },
            { item: 'unidentified ranarr', perTick: 0.005 },
        ],
    };
    const edgevilleUnicorns: Template = {
        id: 'squad-edgeville-unicorns', family: 'combat', script: 'scripts/gather-combat.ts',
        args: ['6000', 'unicorn'], env: { MAX_KILLS: '28' }, role: 'combat',
        goal: 'hunt Edgeville surface Unicorns (south of Wilderness border) for unicorn horns',
        resources: ['squad:edgeville-unicorns'], squadOnly: true, repeats: false,
        needs: { combat: 25, food: 2 },
        yields: () => [{ item: 'unicorn horn', perTick: 0.06 }],
    };
    const snapeGrass: Template = {
        id: 'squad-snape-grass', family: 'gather-spawn', script: 'scripts/gather-spawn.ts',
        args: ['231', '27'], env: { TICKS: '3000' }, role: 'herblore',
        goal: 'gather snape grass at Hobgoblin peninsula (non-Wilderness) for prayer potions',
        resources: ['squad:hobgoblin-snape'], squadOnly: true, repeats: false,
        yields: () => [{ item: 'snape grass', perTick: 0.08 }],
    };
    const taverleyScales: Template = {
        id: 'squad-taverley-scales', family: 'combat', script: 'scripts/gather-combat.ts',
        args: ['4000', 'taverley_scales'], env: { MAX_KILLS: '27' }, role: 'herblore',
        goal: 'gather blue dragon scales in Taverley Dungeon (Dusty key + Anti-dragon shield) for weapon poison',
        resources: ['squad:taverley-scales'], squadOnly: true, repeats: false,
        needs: { items: { 'anti-dragon shield': 1, 'dusty key': 1 }, food: 4 },
        yields: () => [{ item: 'blue dragon scale', perTick: 0.04 }],
    };
    const chaosWine: Template = {
        id: 'squad-chaos-wine', family: 'combat', script: 'scripts/gather-combat.ts',
        args: ['4000', 'chaos_wine'], env: { MAX_KILLS: '25', TELEGRAB_MAX: '25' }, role: 'magic',
        goal: 'telekinetic-grab Wine of Zamorak at the Chaos Temple south of Wilderness for ranging potions',
        resources: ['squad:chaos-temple-wine'], squadOnly: true, repeats: false,
        needs: { skills: { Magic: 33 }, items: { 'law rune': 25, 'air rune': 25 } },
        yields: () => [{ item: 'wine of zamorak', perTick: 0.03 }],
    };
    const whiteBerries: Template = {
        id: 'squad-white-berries', family: 'gather-spawn', script: 'scripts/chain.ts',
        args: ['scripts/walk-to.ts 2262 3168', 'scripts/gather-spawn.ts 239 27'], env: { TICKS: '3000', ROUNDS: '1' }, role: 'herblore',
        goal: 'gather white berries in Isafdar (post-Regicide, non-Wilderness) for super defence potions',
        resources: ['squad:isafdar-berries'], squadOnly: true, repeats: false,
        needs: { quests: ['Regicide'] },
        yields: () => [{ item: 'white berrie', perTick: 0.05 }],
    };
    const barbarianPlanks: Template = {
        id: 'squad-barbarian-planks', family: 'gather-spawn', script: 'scripts/chain.ts',
        args: ['scripts/walk-to.ts 2552 3574', 'scripts/gather-spawn.ts 960 27'], env: { TICKS: '3000', ROUNDS: '1' }, role: 'supply',
        goal: 'gather planks at Barbarian Outpost (non-Wilderness) for quest demand',
        resources: ['squad:barbarian-planks'], squadOnly: true, repeats: false,
        yields: () => [{ item: 'plank', perTick: 0.08 }],
    };
    const gnomeToads: Template = {
        id: 'squad-gnome-toads', family: 'gather-spawn', script: 'scripts/chain.ts',
        args: ['scripts/walk-to.ts 2417 3512', 'scripts/gather-spawn.ts 2150 27'], env: { TICKS: '3000', ROUNDS: '1' }, role: 'herblore',
        goal: 'gather swamp toads in Tree Gnome Stronghold for agility potions',
        resources: ['squad:gnome-toads'], squadOnly: true, repeats: false,
        yields: () => [{ item: 'swamp toad', perTick: 0.12 }],
    };
    const bloodChest: Template = {
        id: 'squad-blood-chest', family: 'aio:skiller:thieving:blood-chest', script: 'scripts/blood-chest.ts',
        args: [], role: 'thieving', goal: 'loot the Ardougne Castle blood rune chests for the gang squad',
        resources: ['squad:ardougne-blood-chest'], squadOnly: true, repeats: false,
        needs: { skills: { Thieving: 59 }, pieces: { of: BLOOD_FOOD, count: BLOOD_MEALS } },
        yields: () => [{ item: 'blood rune', perTick: 0.01 }, { item: 'coins', perTick: 2.5 }],
    };
    // Herb cleaning templates feeding unfinished potion brewers.
    const cleanHerbs = ([
        ['guam', 'identify:guam_leaf', 'unidentified guam', 'guam leaf', 3],
        ['marentill', 'identify:marentill', 'unidentified marentill', 'marrentill', 5],
        ['tarromin', 'identify:tarromin', 'unidentified tarromin', 'tarromin', 11],
        ['harralander', 'identify:harralander', 'unidentified harralander', 'harralander', 20],
        ['ranarr', 'identify:ranarr_weed', 'unidentified ranarr', 'ranarr weed', 25],
        ['toadflax', 'identify:toadflax', 'unidentified toadflax', 'toadflax', 30],
        ['irit', 'identify:irit_leaf', 'unidentified irit', 'irit leaf', 40],
        ['avantoe', 'identify:avantoe', 'unidentified avantoe', 'avantoe', 48],
        ['kwuarm', 'identify:kwuarm', 'unidentified kwuarm', 'kwuarm', 54],
        ['snapdragon', 'identify:snapdragon', 'unidentified snapdragon', 'snapdragon', 59],
        ['cadantine', 'identify:cadantine', 'unidentified cadantine', 'cadantine', 65],
        ['lantadyme', 'identify:lantadyme', 'unidentified lantadyme', 'lantadyme', 67],
        ['dwarf-weed', 'identify:dwarf_weed', 'unidentified dwarf weed', 'dwarf weed', 70],
        ['torstol', 'identify:torstol', 'unidentified torstol', 'torstol', 75],
    ] as const).map(([slug, recipe, raw, clean, lvl]) =>
        invMake(`squad-identify-${slug}`, recipe, clean, lvl, { [raw]: 1 }, {}, 0.2, `identify banked ${raw} for squad potions`));
    const unfPotions = UNF_POTIONS.map(([herb, item, lvl]) =>
        invMake(`squad-unf-${herb.replace(' ', '-')}`, `brew:unf_${herb.replace(' ', '_')}_potion`, `${herb} potion (unf)`, lvl,
            { [item]: 1, 'vial of water': 1 }, {}, 0.15, `mix banked ${item} and vials of water into ${herb} potion (unf)`));
    const decantPotions = ([
        ['prayer_restore', 'prayer potion'],
        ['super_attack', 'super attack'],
        ['super_strength', 'super strength'],
        ['super_defense', 'super defence'],
        ['ranging_potion', 'ranging potion'],
        ['super_energy', 'super energy'],
        ['agility_potion', 'agility potion'],
        ['super_antipoison', 'superantipoison'],
        ['super_restore', 'super restore'],
        ['magic_potion', 'magic potion'],
        ['zamorak_potion', 'zamorak potion'],
        ['restore_potion', 'restore potion'],
    ] as const).flatMap(([slug, label]) => [
        invMake(`squad-decant-${slug}`, `decant:${slug}`, `${label}(4)`, 1, { [`${label}(3)`]: 2 }, {}, 0.3,
            `decant ${label}(3) doses into ${label}(4) at the bank`, MAKE_BATCH, { strictOutput: true, ownSupply: [`${label}(3)`] }),
        invMake(`squad-decant2-${slug}`, `decant2:${slug}`, `${label}(4)`, 1, { [`${label}(2)`]: 2 }, {}, 0.4,
            `decant ${label}(2) doses into ${label}(4) at the bank`, MAKE_BATCH, { ownSupply: [`${label}(2)`] }),
        invMake(`squad-decant31-${slug}`, `decant31:${slug}`, `${label}(4)`, 1, { [`${label}(3)`]: 1, [`${label}(1)`]: 1 }, {}, 0.4,
            `decant ${label}(3) and (1) doses into ${label}(4) at the bank`, MAKE_BATCH, { ownSupply: [`${label}(3)`, `${label}(1)`] }),
    ]);
    const poisonArrowsArgs = (units: number) => ['poison:rune-arrow', `MAX_MAKE=${units * 5}`, 'CAP=1500', 'MEMBERS=1', 'ORDER_MODE=best-effort'];
    const poisonRuneArrows: Template = {
        id: 'squad-poison-rune-arrows', family: 'skiller:crafting:inventory', script: 'scripts/microbot-production.ts',
        args: poisonArrowsArgs(MAKE_BATCH), role: 'herblore',
        goal: 'poison banked rune arrows with weapon poison at the bank for the gang squad',
        resources: ['squad:herblore-bank'], squadOnly: true, repeats: false,
        needs: { skills: { Herblore: 1 }, items: { 'rune arrow': 5, 'weapon poison': 1 } },
        production: {
            output: 'rune arrow(p)', outputPerUnit: 5, maximum: MAKE_BATCH,
            inputs: { 'rune arrow': 5, 'weapon poison': 1 },
            resize: n => ({ args: poisonArrowsArgs(n) }),
        },
        yields: () => [{ item: 'rune arrow(p)', perTick: 0.5 }],
    };
    const karamjaRedSpidersEggs: Template = {
        id: 'squad-karamja-red-spiders-eggs', family: 'gather-spawn', script: 'scripts/chain.ts',
        args: ['scripts/walk-to.ts 2832 9586', 'scripts/gather-spawn.ts 223 27'], env: { TICKS: '3000', ROUNDS: '1' }, role: 'herblore',
        goal: "gather red spiders' eggs in Karamja Volcano (non-Wilderness) for super restore potions",
        resources: ['squad:karamja-red-spiders-eggs'], squadOnly: true, repeats: false,
        needs: { items: { coins: 120 }, food: 4, anyOf: [{ skills: { Hitpoints: 23 } }, { combat: 34 }, { skills: { Prayer: 43 } }] },
        yields: () => [{ item: "red spiders' egg", perTick: 0.04 }],
    };
    const cutDragonstone: Template = {
        id: 'squad-cut-dragonstone', family: 'skiller:crafting:inventory', script: 'scripts/microbot-production.ts',
        args: ['cut-dragonstone', `MAX_MAKE=${MAKE_BATCH}`, 'CAP=1500', 'MEMBERS=1', 'ORDER_MODE=best-effort'], role: 'crafting',
        goal: 'cut banked uncut dragonstones into dragonstones for dragonstone jewellery', resources: ['squad:herblore-bank'], squadOnly: true, repeats: false,
        needs: { skills: { Crafting: 55 }, items: { chisel: 1, 'uncut dragonstone': 1 } },
        production: { output: 'dragonstone', outputPerUnit: 1, maximum: MAKE_BATCH, inputs: { 'uncut dragonstone': 1 },
            resize: n => ({ args: ['cut-dragonstone', `MAX_MAKE=${n}`, 'CAP=1500', 'MEMBERS=1', 'ORDER_MODE=best-effort'] }) },
        yields: () => [{ item: 'dragonstone', perTick: 0.15 }],
    };
    const dragonstoneJewellery = (id: string, recipe: string, output: string, level: number, mould: string): Template => ({
        id, family: 'aio:skiller:crafting:jewellery-trip', script: 'scripts/aio.ts',
        args: ['skiller', 'crafting', 'jewellery-trip', `RECIPE=${recipe}`, `TARGET=${RING_BATCH}`, `BATCH=${RING_BATCH}`, 'CAP=1500', 'MEMBERS=1'], role: 'crafting',
        goal: `smith banked gold bars and cut dragonstones into ${output}s at Al Kharid`, resources: ['squad:al-kharid-craft'], squadOnly: true, repeats: false,
        needs: { skills: { Crafting: level }, items: { [mould]: 1, 'gold bar': 1, dragonstone: 1 } },
        production: { output, outputPerUnit: 1, maximum: RING_BATCH, inputs: { 'gold bar': 1, dragonstone: 1 },
            resize: n => ({ args: ['skiller', 'crafting', 'jewellery-trip', `RECIPE=${recipe}`, `TARGET=${n}`, `BATCH=${n}`, 'CAP=1500', 'MEMBERS=1'] }) },
        yields: () => [{ item: output, perTick: 0.05 }],
    });
    const DRAYNOR_TILE = { ...DRAYNOR_BANK, level: 0 };
    const enchantGloryArgs = (n: number) => bankJobArg({ family: 'magic', recipe: 'enchant:strung_dragonstone_amulet', target: n, batch: Math.min(24, n), cap: 1500, returnTicks: 300, members: true, reserve: 0, bank: DRAYNOR_TILE, site: DRAYNOR_TILE });
    const enchantGlory: Template = {
        id: 'squad-enchant-glory', family: 'aio-skiller:bank-job', script: 'scripts/aio-skiller.ts',
        args: enchantGloryArgs(24), role: 'magic',
        goal: 'enchant banked strung dragonstone amulets into amulets of glory at the Draynor bank', resources: ['squad:magic-enchant'], squadOnly: true, repeats: false,
        needs: { skills: { Magic: 68 }, items: { 'strung dragonstone amulet': 1, 'cosmic rune': 1, 'earth rune': 15, 'water rune': 15 } },
        production: { output: 'amulet of glory', outputPerUnit: 1, maximum: 24, inputs: { 'strung dragonstone amulet': 1, 'cosmic rune': 1, 'earth rune': 15, 'water rune': 15 },
            resize: n => ({ args: enchantGloryArgs(n) }) },
        yields: () => [{ item: 'amulet of glory', perTick: 0.25 }],
    };
    const crystalChest: Template = {
        id: 'squad-crystal-chest', family: 'crystal-chest', script: 'scripts/crystal-chest.ts',
        args: ['2000'], env: { MAX_KEYS: '4' }, role: 'crafting',
        goal: 'open Taverley crystal chests with banked crystal keys or key halves for uncut dragonstones and cosmic runes',
        resources: ['squad:crystal-chest'], squadOnly: true, repeats: false,
        needs: { anyOf: [{ items: { 'crystal key': 1 } }, { items: { keyhalf1: 1, keyhalf2: 1 } }] },
        yields: () => [{ item: 'uncut dragonstone', perTick: 0.05 }, { item: 'cosmic rune', perTick: 0.03 }],
    };
    const chargeGlory: Template = {
        id: 'squad-charge-glory', family: 'charge-glory', script: 'scripts/charge-glory.ts',
        args: ['2000'], env: { MAX_GLORIES: '28' }, role: 'magic',
        goal: 'recharge uncharged or partial amulets of glory at the Fountain of Heroes for the gang squad',
        resources: ['squad:heroes-fountain'], squadOnly: true, repeats: false,
        needs: {
            quests: ["Hero's Quest"], skills: { Hitpoints: 75 },
            anyOf: [
                { items: { 'amulet of glory': 1 } },
                { items: { 'amulet of glory(1)': 1 } },
                { items: { 'amulet of glory(2)': 1 } },
                { items: { 'amulet of glory(3)': 1 } },
            ],
        },
        yields: () => [{ item: 'amulet of glory(4)', perTick: 0.08 }],
    };
    return [
        waterCraft, earthCraft, cosmicCraft, waterTalisman, runeArrows, fletchBankedRuneArrows, sharks,
        karambwanjiFish, karambwanFish, karambwanVessel, karambwanCook,
        smithAnvil('squad-smith-rune-tips', 44, 'rune arrowtips', 90, 1, 15, 27),
        smithAnvil('squad-smith-rune-full-helm', 1163, 'rune full helm', 92, 2, 1, 10),
        smithAnvil('squad-smith-rune-kiteshield', 1201, 'rune kiteshield', 97, 3, 1, 8),
        smithAnvil('squad-smith-rune-platelegs', 1079, 'rune plateleg', 99, 3, 1, 8),
        smithAnvil('squad-smith-rune-platebody', 1127, 'rune platebody', 99, 5, 1, 5),
        smithAnvil('squad-smith-steel-nails', 1539, 'nail', 34, 1, 2, 27, 'steel bar'),
        magicLogs, magicShortbow, taverleyBlackDragons, blackDhideSets, blackDhideVambraces, crystalChest, chargeGlory,
        goldOre, goldBars, cutSapphire, cutEmerald, sapphireRings, emeraldRings, enchantRecoil, enchantDueling,
        taverleyDruids, taverleyBlackKnights, ardougneGiants, edgevilleUnicorns, snapeGrass, taverleyScales, chaosWine, whiteBerries,
        barbarianPlanks, gnomeToads, bloodChest,
        ...cleanHerbs, ...unfPotions, ...decantPotions,
        invMake('squad-grind-unicorn-horn', 'grind:unicorn_horn', 'unicorn horn dust', 1, { 'unicorn horn': 1 }, { 'pestle and mortar': 1 }, 0.2),
        invMake('squad-grind-dragon-scale', 'grind:blue_dragon_scale', 'dragon scale dust', 1, { 'blue dragon scale': 1 }, { 'pestle and mortar': 1 }, 0.2),
        invMake('squad-grind-chocolate', 'grind:chocolate_bar', 'chocolate dust', 1, { 'chocolate bar': 1 }, { 'pestle and mortar': 1 }, 0.2,
            'grind banked chocolate bars into chocolate dust for potions and cakes'),
        invMake('squad-combine-crystal-key', 'combine:crystal-key', 'crystal key', 1, { keyhalf1: 1, keyhalf2: 1 }, {}, 0.2,
            'combine banked crystal key halves into crystal keys'),
        invMake('squad-strip-swamp-toad', 'strip:swamp-toad', "toad's leg", 1, { 'swamp toad': 1 }, {}, 0.2, "strip banked swamp toads into toad's legs"),
        invMake('squad-chocolate-cake', 'prepare:chocolate-cake', 'chocolate cake', 50, { cake: 1, 'chocolate bar': 1 }, {}, 0.15,
            'combine banked cakes and chocolate bars into chocolate cakes', MAKE_BATCH, { skill: 'Cooking', role: 'cooking', members: 0 }),
        invMake('squad-prayer-potion', 'brew:3doseprayerrestore', 'prayer potion(3)', 38, { 'ranarr potion (unf)': 1, 'snape grass': 1 }, {}),
        invMake('squad-super-attack', 'brew:3dose2attack', 'super attack(3)', 45, { 'irit potion (unf)': 1, 'eye of newt': 1 }, {}),
        invMake('squad-super-strength', 'brew:3dose2strength', 'super strength(3)', 55, { 'kwuarm potion (unf)': 1, 'limpwurt root': 1 }, {}),
        invMake('squad-super-defence', 'brew:3dose2defense', 'super defence(3)', 66, { 'cadantine potion (unf)': 1, 'white berrie': 1 }, {}),
        invMake('squad-ranging-potion', 'brew:3doserangerspotion', 'ranging potion(3)', 72, { 'dwarf weed potion (unf)': 1, 'wine of zamorak': 1 }, {}),
        invMake('squad-super-energy', 'brew:3dose2energy', 'super energy(3)', 52, { 'avantoe potion (unf)': 1, 'mort myre fungi': 1 }, {}),
        invMake('squad-agility-potion', 'brew:3dose1agility', 'agility potion(3)', 34, { 'toadflax potion (unf)': 1, "toad's leg": 1 }, {}),
        invMake('squad-super-restore', 'brew:3dose2restore', 'super restore(3)', 63, { 'snapdragon potion (unf)': 1, "red spiders' egg": 1 }, {}),
        invMake('squad-magic-potion', 'brew:3dose1magic', 'magic potion(3)', 76, { 'lantadyme potion (unf)': 1, 'potato cactu': 1 }, {}),
        invMake('squad-zamorak-potion', 'brew:3dosepotionofzamorak', 'zamorak potion(3)', 78, { 'torstol potion (unf)': 1, jangerberrie: 1 }, {}),
        invMake('squad-superantipoison', 'brew:3dose2antipoison', 'superantipoison(3)', 48, { 'irit potion (unf)': 1, 'unicorn horn dust': 1 }, {}),
        invMake('squad-antipoison-brew', 'brew:3doseantipoison', 'antipoison(3)', 5, { 'marrentill potion (unf)': 1, 'unicorn horn dust': 1 }, {}),
        invMake('squad-weapon-poison', 'brew:weapon_poison', 'weapon poison', 60, { 'kwuarm potion (unf)': 1, 'dragon scale dust': 1 }, {}),
        invMake('squad-poison-dds', 'poison:dragon-dagger', 'dragon dagger(p)', 1, { 'dragon dagger': 1, 'weapon poison': 1 }, {}),
        poisonRuneArrows,
        karamjaRedSpidersEggs,
        cutDragonstone,
        dragonstoneJewellery('squad-dragonstone-ring', 'dragonstone_ring', 'dragonstone ring', 55, 'ring mould'),
        dragonstoneJewellery('squad-dragon-necklace', 'dragonstone_necklace', 'dragon necklace', 72, 'necklace mould'),
        dragonstoneJewellery('squad-dragonstone-amulet', 'unstrung_dragonstone_amulet', 'unstrung dragonstone amulet', 80, 'amulet mould'),
        invMake('squad-string-dragonstone-amulet', 'string-dragonstone-amulet', 'strung dragonstone amulet', 1, { 'unstrung dragonstone amulet': 1, 'ball of wool': 1 }, {}, 0.15,
            'string banked unstrung dragonstone amulets with balls of wool', MAKE_BATCH, { skill: 'Crafting', role: 'crafting' }),
        enchantGlory,
        shop('squad-arrows-dargaud', 'dargaud', 'rune arrow', 'rune arrow', 0.4, 'buy rune arrows in the Ranging Guild for the gang squad', { skills: { Ranged: 40 }, items: { coins: 30_000 } }),
        shop('squad-karambwan-shop', 'alfonse', 'cooked karambwan', 'cooked karambwan', 0.05, 'buy cooked karambwan at Brimhaven Fish Restaurant for the gang squad', { items: { coins: 32_000 } }),
        shop('squad-raw-karambwan-shop', 'tiadeche', 'raw karambwan', 'raw karambwan', 0.05, 'buy raw karambwan from Tiadeche for the gang squad', { quests: ['Tai Bwo Wannai Trio'], items: { coins: 52_000 }, anyOf: tiadecheDangerGate }),
        shop('squad-water-betty', 'betty', 'water rune', 'water rune', 0.7, "buy water runes at Betty's in Port Sarim for the gang squad", { items: { coins: 6000 } }),
        shop('squad-water-aubury', 'aubury', 'water rune', 'water rune', 0.7, "buy water runes at Aubury's in Varrock for the gang squad", { items: { coins: 6000 } }),
        shop('squad-water-guild', 'magic_guild_elemental', 'water rune', 'water rune', 0.7, 'buy water runes at the Magic Guild for the gang squad', { skills: { Magic: 66 }, items: { coins: 12_000 } }),
        shop('squad-earth-betty', 'betty', 'earth rune', 'earth rune', 0.7, "buy earth runes at Betty's in Port Sarim for the gang squad", { items: { coins: 6000 } }),
        shop('squad-earth-guild', 'magic_guild_elemental', 'earth rune', 'earth rune', 0.7, 'buy earth runes at the Magic Guild for the gang squad', { skills: { Magic: 66 }, items: { coins: 12_000 } }),
        shop('squad-air-betty', 'betty', 'air rune', 'air rune', 0.7, "buy air runes at Betty's in Port Sarim for the gang squad", { items: { coins: 6000 } }),
        shop('squad-air-aubury', 'aubury', 'air rune', 'air rune', 0.7, "buy air runes at Aubury's in Varrock for the gang squad", { items: { coins: 6000 } }),
        shop('squad-fire-betty', 'betty', 'fire rune', 'fire rune', 0.7, "buy fire runes at Betty's in Port Sarim for the gang squad", { items: { coins: 6000 } }),
        shop('squad-fire-aubury', 'aubury', 'fire rune', 'fire rune', 0.7, "buy fire runes at Aubury's in Varrock for the gang squad", { items: { coins: 6000 } }),
        shop('squad-fire-guild', 'magic_guild', 'fire rune', 'fire rune', 0.7, 'buy fire runes at the Magic Guild for the gang squad', { skills: { Magic: 66 }, items: { coins: 12_000 } }),
        shop('squad-blood-guild', 'magic_guild', 'blood rune', 'blood rune', 0.2, 'buy blood runes at the Magic Guild for the gang squad', { skills: { Magic: 66 }, items: { coins: 110_000 } }),
        shop('squad-death-betty', 'betty', 'death rune', 'death rune', 0.3, "buy death runes at Betty's in Port Sarim", { items: { coins: 40_000 } }),
        shop('squad-death-aubury', 'aubury', 'death rune', 'death rune', 0.3, "buy death runes at Aubury's in Varrock", { items: { coins: 40_000 } }),
        shop('squad-death-guild', 'magic_guild', 'death rune', 'death rune', 0.4, 'buy death runes at the Magic Guild', { skills: { Magic: 66 }, items: { coins: 80_000 } }),
        shop('squad-chaos-betty', 'betty', 'chaos rune', 'chaos rune', 0.4, "buy chaos runes at Betty's in Port Sarim", { items: { coins: 30_000 } }),
        shop('squad-chaos-aubury', 'aubury', 'chaos rune', 'chaos rune', 0.4, "buy chaos runes at Aubury's in Varrock", { items: { coins: 30_000 } }),
        shop('squad-chaos-guild', 'magic_guild_elemental', 'chaos rune', 'chaos rune', 0.5, 'buy chaos runes at the Magic Guild', { skills: { Magic: 66 }, items: { coins: 60_000 } }),
        shop('squad-mind-betty', 'betty', 'mind rune', 'mind rune', 0.7, "buy mind runes at Betty's in Port Sarim", { items: { coins: 4000 } }),
        shop('squad-mind-aubury', 'aubury', 'mind rune', 'mind rune', 0.7, "buy mind runes at Aubury's in Varrock", { items: { coins: 4000 } }),
        shop('squad-nature-guild', 'magic_guild', 'nature rune', 'nature rune', 0.4, 'buy nature runes at the Magic Guild for the gang squad', { skills: { Magic: 66 }, items: { coins: 40_000 } }),
        shop('squad-law-guild', 'magic_guild', 'law rune', 'law rune', 0.4, 'buy law runes at the Magic Guild for the gang squad', { skills: { Magic: 66 }, items: { coins: 17_000 } }),
        shop('squad-antipoison-jiminua', 'jiminua', 'antipoison(3)', 'antipoison', 0.02, "buy antipoison(3) at Jiminua's in Karamja for the gang squad", { items: { coins: 8000 } }),
        shop('squad-dragon-dagger', 'jukat_dagger', 'dragon dagger', 'dragon dagger', 0.01, 'buy dragon daggers from Jakut in Zanaris for weapon poisoning', { quests: ['Lost City'], items: { coins: 130_000, diamond: 1 } }),
        shop('squad-berserker-helm', 'skulgrimen', 'berserker helm', 'berserker helm', 0.01, 'buy berserker helms from Skulgrimen after The Fremennik Trials for the gang squad', { quests: ['The Fremennik Trials'], skills: { Hitpoints: 45 }, items: { coins: 160_000 } }),
        shop('squad-oziach-platebody', 'oziach', 'rune platebody', 'rune platebody', 0.01, 'buy rune platebodies from Oziach after Dragon Slayer for the gang squad', { quests: ['Dragon Slayer'], items: { coins: 170_000 } }),
        shop('squad-scavvo-platelegs', 'scavvo', 'rune plateleg', 'rune platelegs', 0.01, "buy rune platelegs from Scavvo at the Champions' Guild for the gang squad", { quests: ['Dragon Slayer'], items: { coins: 130_000 } }),
        shop('squad-tenzing-boots', 'tenzing', 'climbing boot', 'climbing boots', 0.05, 'buy climbing boots from Tenzing after Death Plateau for the gang squad', { quests: ['Death Plateau'], items: { coins: 300 } }),
        shop('squad-sapphire-herquin', 'herquin', 'uncut sapphire', 'uncut sapphire', 0.02, "buy uncut sapphires at Herquin's in Falador for rings of recoil", { items: { coins: 15_000 } }),
        shop('squad-sapphire-gem-trader', 'gem_trader', 'uncut sapphire', 'uncut sapphire', 0.02, 'buy uncut sapphires in Al Kharid for rings of recoil', { items: { coins: 15_000 } }),
        shop('squad-emerald-gem-trader', 'gem_trader', 'uncut emerald', 'uncut emerald', 0.02, 'buy uncut emeralds in Al Kharid for rings of dueling(8)', { items: { coins: 20_000 } }),
        shop('squad-eye-of-newt', 'taverley', 'eye of newt', 'eye of newt', 0.3, "buy eye of newt at Jatix's Herblore shop in Taverley", { items: { coins: 1000 } }),
        shop('squad-vial-of-water', 'ardy', 'vial of water', 'vial of water', 0.3, "buy vials of water from Aemad's store in East Ardougne", { items: { coins: 1500 } }),
        shop('squad-shantay-waterskin', 'shantay', 'waterskin(4)', 'waterskin', 0.05, 'buy waterskins(4) at Shantay Pass for quest supply demand', { items: { coins: 1000 } }),
        shop('squad-shantay-bronze-bar', 'shantay', 'bronze bar', 'bronze bar', 0.02, 'buy bronze bars at Shantay Pass for quest and smithing demand', { items: { coins: 1000 } }),
        shop('squad-horvik-black-body', 'horvik', 'black platebody', 'black platebody', 0.005, "buy black platebodies at Horvik's Armoury in Varrock", { items: { coins: 8000 } }),
        shop('squad-louie-black-legs', 'louie', 'black plateleg', 'black platelegs', 0.005, 'buy black platelegs from Louie Legs in Al Kharid', { items: { coins: 4000 } }),
        shop('squad-valaine-black-helm', 'valaine', 'black full helm', 'black full helm', 0.005, "buy black full helms at Valaine's shop in the Champions' Guild", { questPoints: PEN_QUEST_POINTS['3197,3353'], items: { coins: 2500 } }),
        shop('squad-chocolate-bar', 'wydin_choc', 'chocolate bar', 'chocolate bar', 0.05, "buy chocolate bars at Wydin's Food Store in Port Sarim", { items: { coins: 600 } }),
        shop('squad-cake-baker', 'baker', 'cake', 'cake', 0.03, 'buy cakes at the East Ardougne bakery for chocolate cakes', { items: { coins: 800 } }),
        shop('squad-priest-gown', 'thessalia_gown', 'priest gown', 'priest gown', 0.02, "buy priest gowns at Thessalia's Clothes Shop in Varrock", { items: { coins: 500 } }),
        shop('squad-leather-gloves', 'thessalia', 'leather glove', 'leather gloves', 0.03, "buy leather gloves at Thessalia's Clothes Shop in Varrock", { items: { coins: 500 } }),
        shop('squad-fishing-bait', 'sarim', 'fishing bait', 'fishing bait', 0.3, "buy fishing bait at Gerrant's in Port Sarim", { items: { coins: 1500 } }),
        shop('squad-papyrus', 'ardy', 'papyrus', 'papyrus', 0.05, "buy papyrus from Aemad's store in East Ardougne", { items: { coins: 500 } }),
        shop('squad-ball-of-wool', 'ardy', 'ball of wool', 'ball of wool', 0.05, "buy balls of wool from Aemad's store in East Ardougne", { items: { coins: 500 } }),
        shop('squad-charcoal', 'jiminua', 'charcoal', 'charcoal', 0.02, "buy charcoal at Jiminua's Jungle Store on Karamja", { items: { coins: 1500 } }),
        shop('squad-cape-of-legends', 'siegfried', 'cape of legend', 'cape of legends', 0.01, "buy capes of legends from Siegfried Erkle in the Legends' Guild", { quests: ['Legends Quest'], items: { coins: 2000 } }),
        shop('squad-shield-right-half', 'siegfried', 'shield right half', 'shield right half', 0.005, "buy shield right halves from Siegfried Erkle in the Legends' Guild", { quests: ['Legends Quest'], items: { coins: 1_500_000 } }),
        shop('squad-dragon-battleaxe', 'helemos', 'dragon battleaxe', 'dragon battleaxe', 0.005, "buy dragon battleaxes from Helemos in the Heroes' Guild", { quests: ["Hero's Quest"], items: { coins: 400_000 } }),
        shop('squad-dragon-mace', 'helemos', 'dragon mace', 'dragon mace', 0.005, "buy dragon maces from Helemos in the Heroes' Guild", { quests: ["Hero's Quest"], items: { coins: 100_000 } }),
    ];
}

// The shop step of a maker whose only missing input is a ring mould: Dommik's Crafting Store in Al Kharid sells it
// (scripts/shop-buyer.ts profile dommik: ring mould shelf 4, necklace/amulet moulds shelf 2). The moulds cost 5 coins each in item data and the run
// stops at the first one held (STOCK_TARGET 1).
export const RING_MOULD_COINS = 100;
export function makerShopSteps(): Template[] {
    return [{
        id: 'shop-ring-mould', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['dommik', '600'],
        env: { ITEMS: 'ring mould', STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: String(RING_MOULD_COINS), COIN_RESERVE: '50', MAX_SPEND: '50' },
        role: 'supply', goal: "buy a ring mould from Dommik's Crafting Store in Al Kharid for the ring makers", repeats: false,
        resources: ['shop:dommik'], yields: () => [], provides: { item: 'ring mould', unlocks: [...GEM_RINGS.map(([gem]) => `aio-${gem}-rings`), 'squad-sapphire-ring', 'squad-emerald-ring', 'squad-dragonstone-ring'] },
        needs: { items: { coins: RING_MOULD_COINS }, holdsUnder: { 'ring mould': 1 } },
    }, {
        id: 'shop-necklace-mould', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['dommik_moulds', '600'],
        env: { ITEMS: 'necklace mould', STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: String(RING_MOULD_COINS), COIN_RESERVE: '50', MAX_SPEND: '50' },
        role: 'supply', goal: "buy a necklace mould from Dommik's Crafting Store in Al Kharid for necklace makers", repeats: false,
        resources: ['shop:dommik_moulds'], yields: () => [], provides: { item: 'necklace mould', unlocks: ['squad-dragon-necklace'] },
        needs: { items: { coins: RING_MOULD_COINS }, holdsUnder: { 'necklace mould': 1 } },
    }, {
        id: 'shop-amulet-mould', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['dommik_moulds', '600'],
        env: { ITEMS: 'amulet mould', STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: String(RING_MOULD_COINS), COIN_RESERVE: '50', MAX_SPEND: '50' },
        role: 'supply', goal: "buy an amulet mould from Dommik's Crafting Store in Al Kharid for amulet makers", repeats: false,
        resources: ['shop:dommik_moulds'], yields: () => [], provides: { item: 'amulet mould', unlocks: ['squad-dragonstone-amulet'] },
        needs: { items: { coins: RING_MOULD_COINS }, holdsUnder: { 'amulet mould': 1 } },
    }];
}
export function makerChains(): Template[] {
    const step = (recipe: string, max: number, cap = 1500) => `scripts/aio.ts skiller crafting inventory ${recipe} MAX_MAKE=${max} CAP=${cap} MEMBERS=1 ORDER_MODE=best-effort`;
    const chain = (id: string, steps: string[], rest: Pick<Template, 'role' | 'goal' | 'needs' | 'yields' | 'repeats' | 'production'>): Template =>
        ({ id, pilot: true, family: 'aio:skiller:crafting:inventory', script: 'scripts/chain.ts', args: steps, env: { ROUNDS: '1' }, worker: 'scripts/microbot-production.ts', ...rest });
    return [
        chain('make-yew-shortbow', [step('cut-bow:unstrung_yew_shortbow', 1, 600), step('bow-string:yew_shortbow', 1, 600)], {
            role: 'fletching', goal: 'cut a banked yew log into a shortbow and string it', repeats: false,
            production: { output: 'yew shortbow', outputPerUnit: 1, maximum: 1, inputs: { 'yew logs': 1, 'bow string': 1 }, resize: n => ({ args: [step('cut-bow:unstrung_yew_shortbow', n, 600), step('bow-string:yew_shortbow', n, 600)] }) },
            needs: { skills: { Fletching: 65 }, items: { knife: 1, 'yew logs': 1, 'bow string': 1 }, holdsUnder: { 'yew shortbow': 1 } },
            yields: () => [{ item: 'yew shortbow', perTick: 0.01 }] }),
        chain('make-uncooked-stew', [step('prepare:potato-stew', STEW_BATCH), step('prepare:uncooked-stew', STEW_BATCH)], {
            role: 'cooking', goal: 'make uncooked stews from banked potatoes, bowls of water and cooked meat',
            repeats: false, production: { output: 'uncooked stew', outputPerUnit: 1, maximum: STEW_BATCH, inputs: { potato: 1, 'bowl of water': 1, 'cooked meat': 1 }, resize: n => ({ args: [step('prepare:potato-stew', n), step('prepare:uncooked-stew', n)] }) },
            needs: { skills: { Cooking: 25 }, items: { potato: STEW_BATCH, 'bowl of water': STEW_BATCH, 'cooked meat': STEW_BATCH } },
            yields: () => [{ item: 'uncooked stew', perTick: 0.05 }] }),
    ];
}

// Proven job templates. Rates are estimates from each script's header model; tick-waste discounts them by measurement.
export function catalogue(): Template[] {
    const goldfarm = KNIGHT_SPOTS.map((spot): Template => ({
        id: `goldfarm@${spot}`, family: 'goldfarm', script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: spot, TICKS: '9000' }, role: 'thieving',
        goal: `goldfarm knights at ${spot}`, needs: { skills: { Thieving: 55 }, frail: GOLDFARM_FRAIL }, resources: [`knight:${spot}`],
        yields: a => [{ item: 'coins', perTick: knightCoinsPerTick(a.skills.Thieving ?? 1) }],
    }));
    const cows = COW_BANDS.map(({ skill, band, to }): Template => ({
        id: `army-cow-${skill.toLowerCase()}-${to}`, family: 'combat-train', script: 'scripts/gather-combat.ts', args: ['3000', 'cow'],
        env: { TRAIN_SKILL: skill, TARGET_LEVEL: String(to), COW_BANK_PROFILE: 'north', MAX_KILLS: '8', COW_STAGE: '1', LOOT_WATCH: '0' }, role: 'combat', goal: `train ${skill} to ${to} on the Ardougne cows`,
        tier: 'goal', band, repeats: true, trains: { skill, to, unlocks: [] }, resources: [COW_FIELD], yields: () => [],
        needs: { food: 14, meleeWeapon: true },
        // One trip to the Grand Exchange brings food for many runs, not the two trout one start needs.
        batch: { trout: 30 },
    }));
    const troopers = TROOPER_BANDS.map(({ skill, band }): Template => ({
        id: `army-trooper-${skill.toLowerCase()}-99`, family: 'combat-train', script: 'scripts/gather-combat.ts', args: ['1500', 'trooper'],
        env: { TRAIN_SKILL: skill, TARGET_LEVEL: '99', GIANT_FOOD: '20', GIANT_BURY: '1', TROOPER_COOK: '1', LOOT_WATCH: '0' }, role: 'combat', goal: `train ${skill} to 99 on the Khazard troopers`,
        tier: 'goal', band, repeats: true, trains: { skill, to: 99, unlocks: [] }, resources: [TROOPER_FIELD], yields: () => [],
        needs: { skills: { Attack: 60, Strength: 60, Defence: 60, Hitpoints: 40 }, anyOf: TROOPER_FED },
        batch: { trout: 100 },
    }));
    // The alchemy band's consumables for the casts an account's Magic level still has to Magic 99 (the batch of a kit buy and what a donor keeps).
    const alchBatch = (a: Acct, item: string): Record<string, number> => {
        const need = alchSupplies(a.skills.Magic ?? 1);
        return { 'nature rune': need.nature, [item]: need.item, 'fire rune': need.fire };
    };
    const magic: Template = {
        id: 'army-alch-magic-99', family: 'combat-train', script: 'scripts/alch-train.ts', args: ['99', '5000'], role: 'combat', goal: 'train Magic to 99 with alchemy at the Ardougne north bank',
        tier: 'goal', band: MAGIC_BAND, repeats: true, trains: { skill: 'Magic', to: 99, unlocks: [] }, resources: [], yields: () => [],
        needs: { skills: { Magic: 21 }, items: { 'nature rune': 50, feather: 50 }, anyOf: [{ items: { 'fire rune': 250 } }, ...FIRE_STAFFS.map(item => ({ items: { [item]: 1 } }))] },
        // One buy brings every consumable of the casts left to Magic 99 (alchSupplies: one nature rune and one item a cast, and fire
        // runes for the casts), as far as the account's coins reach (`partBatch`). Magic 21 to 99 is 642 casts: 642 nature runes, 642
        // feathers and 3,098 fire runes. A start's 250 fire runes cover 50 casts, so a band bought by starts returns to the shop many times.
        // With no coins for the whole batch the buy takes the share they pay for, down to the cash reserve and margin (`keepCoins` is not set).
        batchFor: a => alchBatch(a, 'feather'), partBatch: true,
    };
    // Magic 1 to 21 for Low Alchemy: Wind Strike on the fenced Guard dog (scripts/alch-train.ts strikeStart). Practice,
    // fresh accounts started at the goldfarm knights: Magic 1 to 21-23 in 17-22 casts, no damage taken, about 180 ticks alone.
    const strike: Template = {
        id: 'army-strike-magic-21', family: 'combat-train', script: 'scripts/alch-train.ts', args: ['21', '1500'], role: 'combat', goal: 'train Magic to 21 with Wind Strike from the safe tile at the Ardougne north bank',
        tier: 'goal', band: MAGIC_BAND, repeats: true, trains: { skill: 'Magic', to: 21, unlocks: [magic.id] }, resources: [STRIKE_TILE], yields: () => [],
        needs: { items: { 'mind rune': 35, 'air rune': 35 } },
    };
    // The alchemy band's fire, band 2. The market lists no fire rune under the kit caps (live claude-cloud: "unsold"),
    // and a cast takes 3 or 5 of them; a staff of fire stands for all of them (scripts/alch-train.ts). An account that
    // holds the band's nature runes and feathers but no fire buys one staff at Zaff's shop in Varrock (staffshop: 2 in
    // stock, one back every 1,000 ticks) and banks it at Varrock West. A kit buy on the Grand Exchange leaves the
    // account next to the shop; from Ardougne scripts/shop-buyer.ts takes the ferries. A pilot (off unless a plan's
    // `aio` list names it): live, the shelf stood at 0 through five visits, one of 1,100 ticks, so another player takes
    // each staff as it comes back. On an empty shelf the run waits
    // ZAFF_WAIT ticks, a little over the 1,000 a staff takes to come back, so one visit brings a staff: a run that
    // waits less ends ok with nothing bought, and a long one of those reads as tick waste (live claude-cloud:
    // UnderMyKilt, 799 ticks, boughtTotal=0 after a 200-tick wait). STALL_TICKS=0: the session's idle guard would end
    // the wait at 900 ticks (packages/core/src/bot.ts); the run's own cap bounds it.
    const staff: Template = {
        id: 'army-staff-zaff', pilot: true, family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['zaff', '3000'],
        env: { ITEMS: 'staff of fire', STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: String(ZAFF_WAIT), STALL_TICKS: '0', FLOAT: '13000', COIN_RESERVE: '500', MAX_SPEND: '12000' },
        role: 'supply', goal: "buy a staff of fire at Zaff's shop in Varrock for the alchemy band",
        tier: 'goal', band: MAGIC_BAND, repeats: true, trains: { skill: 'Magic', to: 99, unlocks: [magic.id] }, resources: ['shop:zaff'], yields: () => [],
        needs: { skills: { Magic: 21 }, items: { coins: 15000, 'nature rune': 50, feather: 50 }, holdsUnder: { ...Object.fromEntries(FIRE_STAFFS.map(item => [item, 1])), 'fire rune': 250 } },
    };
    const noFire = { ...Object.fromEntries(FIRE_STAFFS.map(item => [item, 1])), 'fire rune': 250 };
    // `wait`: the ticks with no buy that end the run. Under the shelf's restock interval, the run leaves an emptied
    // shelf; over it, the run stays and buys each unit as it comes back.
    const shopRun = (profile: string, cap: number, items: string, target: number, spend: number, wait = 25) => ['scripts/shop-buyer.ts', profile, String(cap), `ITEMS=${items}`, `STOCK_TARGET=${target}`,
        'STOP_AT_TARGET=1', 'BANK_PACK=1', 'BANK_AT=0', `NO_BUY_TICKS=${wait}`, `FLOAT=${spend + 1000}`, 'COIN_RESERVE=500', `MAX_SPEND=${spend}`].join(' ');
    const supply = (id: string, goal: string, shop: string, steps: string[], needs: Needs): Template => ({
        id, family: 'shop-buyer', script: 'scripts/chain.ts', args: steps, env: { ROUNDS: '1' }, role: 'supply', goal,
        tier: 'goal', band: MAGIC_BAND, repeats: true, trains: { skill: 'Magic', to: 99, unlocks: [magic.id] }, resources: [`shop:${shop}`], yields: () => [], needs });
    const feathers = supply('army-feathers-sarim', "buy feathers at Gerrant's in Port Sarim for the alchemy band", 'sarim',
        [shopRun('sarim', 3000, 'feather', FEATHER_STOCK, 10000)], { under: { Magic: 66 }, items: { coins: 12000, 'nature rune': 50 }, holdsUnder: { feather: 50 } });
    const fireRunes = supply('army-fire-aubury', "buy fire runes at Aubury's in Varrock for the alchemy band", 'aubury',
        [shopRun('aubury', 3000, 'fire.rune', FIRE_STOCK, 9000)], { skills: { Magic: 21 }, under: { Magic: 66 }, items: { coins: 11000, 'nature rune': 50, feather: 50 }, holdsUnder: noFire });
    const guildRunes = [shopRun('magic_guild', 900, 'nature.rune', NATURE_STOCK, 45000), shopRun('magic_guild', 600, 'air.rune', AIR_STOCK, 10000)];
    const staffGuild = supply('army-staff-guild', 'buy a staff of fire, fire, nature and air runes at the Magic Guild in Yanille for the alchemy band', 'magic_guild',
        [shopRun('magic_guild', 1500, 'staff.of.fire', 1, 12000), shopRun('magic_guild', 600, 'fire.rune', FIRE_STOCK, 9000), ...guildRunes],
        { skills: { Magic: 66 }, items: { coins: 80000 }, holdsUnder: noFire });
    const natureGuild = supply('army-nature-guild', 'buy nature and air runes at the Magic Guild in Yanille for the alchemy band', 'magic_guild', guildRunes,
        { skills: { Magic: 66 }, items: { coins: 60000 }, holdsUnder: { 'nature rune': 50 }, anyOf: [{ items: { 'fire rune': 250 } }, ...FIRE_STAFFS.map(item => ({ items: { [item]: 1 } }))] });
    const airGuild = supply('army-air-guild', 'buy air runes at the Magic Guild in Yanille for the alchemy band', 'magic_guild',
        [shopRun('magic_guild', 600, 'air.rune', AIR_STOCK, 10000)],
        { skills: { Magic: 66 }, items: { coins: 15000, 'nature rune': 50 }, holdsUnder: { 'air rune': 50, feather: 50 }, anyOf: [{ items: { 'fire rune': 250 } }, ...FIRE_STAFFS.map(item => ({ items: { [item]: 1 } }))] });
    const magicAir: Template = { ...magic, id: 'army-alch-air-magic-99', env: { ALCH_ITEM: 'airrune' }, goal: 'train Magic to 99 with alchemy on air runes at the Ardougne north bank',
        needs: { skills: { Magic: 66 }, items: { 'nature rune': 50, 'air rune': 50 }, anyOf: magic.needs!.anyOf }, batchFor: a => alchBatch(a, 'air rune'), shopKit: true };
    const splash: Template = {
        id: 'army-splash-magic-66', pilot: true, family: 'combat-train', script: 'scripts/splash-train.ts', args: [String(SPLASH_TO), '6000'], role: 'combat',
        goal: `train Magic to ${SPLASH_TO} with a curse cast over the fence of the Ardougne cow field`,
        tier: 'goal', band: MAGIC_BAND, repeats: true, trains: { skill: 'Magic', to: SPLASH_TO, unlocks: [magic.id] }, resources: [SPLASH_FENCE], yields: () => [],
        needs: { items: { ...SPLASH_START, 'mind rune': 2, 'air rune': 2 } }, batchFor: a => splashKit(a.skills.Magic ?? 1), kitFirst: true,
    };
    const waterJob = (id: string, where: string, shop: string): Template => ({
        ...supply(id, `buy water runes at ${where} for the curse band`, shop, [shopRun(shop, 3000, 'water.rune', SPLASH_KIT['water rune'], 12000)],
            { under: { Magic: SPLASH_TO }, items: { coins: 14000, 'body rune': SPLASH_START['body rune'], 'earth rune': SPLASH_START['earth rune'] }, holdsUnder: { 'water rune': SPLASH_START['water rune'] } }),
        pilot: true, trains: { skill: 'Magic', to: SPLASH_TO, unlocks: [splash.id] },
    });
    const water = waterJob('army-water-aubury', "Aubury's in Varrock", 'aubury'), waterBetty = waterJob('army-water-betty', "Betty's in Port Sarim", 'betty');
    const body: Template = {
        ...supply('army-body-aubury', "buy body runes at Aubury's in Varrock for the curse band", 'aubury', [shopRun('aubury', 3000, 'body.rune', SPLASH_KIT['body rune'], 8000)],
            { under: { Magic: SPLASH_TO }, items: { coins: 10000, 'earth rune': SPLASH_START['earth rune'] }, holdsUnder: { 'body rune': SPLASH_START['body rune'] } }),
        pilot: true, trains: { skill: 'Magic', to: SPLASH_TO, unlocks: [splash.id] },
    };
    const prayer: Template = {
        id: 'army-bury-prayer-99', family: 'combat-train', script: 'scripts/train-prayer.ts', args: ['99'], env: { BURY_HELD: '1', BONE_RESERVE: '6', CAP: '4000' }, role: 'combat',
        goal: 'train Prayer to 99 burying the held bones', tier: 'goal', band: PRAYER_BAND, repeats: false, trains: { skill: 'Prayer', to: 99, unlocks: [] }, yields: () => [],
        needs: { items: { bones: 100 } },
    };
    const boneBand = (id: string, bone: string, boneId: number, band: number): Template => ({
        id, family: 'combat-train', script: 'scripts/train-prayer.ts', args: ['99'], env: { BURY_HELD: '1', BONE_ID: String(boneId), BONE_RESERVE: String(BONE_KEEP), CAP: '4000' }, role: 'combat',
        goal: `train Prayer to 99 burying bought ${bone}`, tier: 'goal', band, repeats: false, trains: { skill: 'Prayer', to: 99, unlocks: [] }, yields: () => [],
        needs: { skills: { Ranged: BONE_SKILL, Magic: BONE_SKILL }, items: { [bone]: BONE_START } }, partBatch: true,
        // An account with Ranged or Magic still to finish keeps BONE_PURSE for arrows, a staff and a blade.
        keepCoins: a => (a.skills.Ranged ?? 1) < 99 || (a.skills.Magic ?? 1) < 99 ? BONE_PURSE : 0,
        batchFor: a => ({ [norm(bone)]: BONE_KEEP + Math.ceil((xpForLevel(99) - xpForLevel(a.skills.Prayer ?? 1)) / BOUGHT_BONE_XP[boneId]!) }),
    });
    const dragonBones = boneBand('army-bury-dragon-99', 'dragon bones', 536, PRAYER_BAND + 0.1), bigBones = boneBand('army-bury-big-99', 'big bones', 532, PRAYER_BAND + 0.2);
    const dustyKey: Template = {
        id: 'army-dusty-key', pilot: true, family: 'aio:quester:mode:dusty-key', script: 'scripts/aio.ts', args: ['quester', 'dusty-key'], aio: 'quester:mode:dusty-key', worker: 'scripts/dusty-key.ts',
        role: 'quest', goal: "get the dusty key from Velrak for Taverley dungeon's inner gate", tier: 'goal', band: HUNT_BAND, filler: true, repeats: false, stock: { item: 'dusty key', to: 1 }, yields: () => [],
        needs: { skills: { Attack: 90, Strength: 90, Defence: 90, Hitpoints: 90, Ranged: 90, Prayer: 60, Magic: 25 } },
    };
    const huntOn = (id: string, arrow: string, arrows = HUNT_ARROWS): Template => ({
        id, pilot: true, family: 'combat-train', script: 'scripts/black-dragon-camp.ts', args: ['9000'],
        env: { KILLS: String(HUNT_KILLS), ARROW: arrow.replace(' ', '_'), ARROWS: String(arrows) }, role: 'combat', goal: `kill Taverley's black dragons for their hides and bones, on ${arrow}s`,
        tier: 'goal', band: HUNT_BAND, filler: true, repeats: true, stock: { item: 'dragonhide', to: HIDE_TARGET }, resources: [BLACK_CAVE], yields: () => [],
        ownSupply: ['rune arrow', 'iron arrow', 'bronze arrow', 'air rune', 'fire rune'],
        needs: { skills: { Defence: 90, Hitpoints: 90, Ranged: 90, Prayer: 60, Magic: 25 },
            items: { 'dusty key': 1, 'magic shortbow': 1, [arrow]: arrows, 'law rune': 1, 'air rune': 3, 'fire rune': 1, shark: HUNT_FOOD } },
    });
    const huntRune: Template = { ...huntOn('army-hunt-black-dragons-rune', 'rune arrow', HUNT_RUNE_ARROWS), band: HUNT_BAND - 0.01 };
    const hunt = huntOn('army-hunt-black-dragons', 'iron arrow'), huntBronze = huntOn('army-hunt-black-dragons-bronze', 'bronze arrow');
    const huntSupplyRune: Template = {
        id: 'army-hunt-supply-rune', pilot: true, family: 'shop-buyer', script: 'scripts/chain.ts',
        args: [shopRun('dargaud', 2500, 'rune.arrow', HUNT_RUNE_ARROWS, HUNT_RUNE_SPEND, 8), shopRun('aubury', 800, 'air.rune|fire.rune', HUNT_RUNE_STOCK, 2000, 8)],
        env: { ROUNDS: '1' }, role: 'supply', goal: "buy rune arrows at the Ranging Guild and teleport runes at Aubury's for the black dragon hunt",
        tier: 'goal', band: HUNT_BAND + 0.2, filler: true, repeats: true, stock: { item: 'dragonhide', to: HIDE_TARGET }, resources: ['shop:dargaud', 'shop:aubury'], yields: () => [],
        needs: { skills: hunt.needs!.skills, items: { coins: HUNT_RUNE_SPEND + 4000 }, shortOf: { 'rune arrow': HUNT_RUNE_ARROWS, 'air rune': 3, 'fire rune': 1 } },
    };
    const huntSupply: Template = {
        id: 'army-hunt-supply', pilot: true, family: 'shop-buyer', script: 'scripts/chain.ts',
        args: [shopRun('lowe', 2500, 'iron.arrow|bronze.arrow', HUNT_ARROW_STOCK, 28000, 8), shopRun('aubury', 800, 'air.rune|fire.rune', HUNT_RUNE_STOCK, 2000, 8)],
        env: { ROUNDS: '1' }, role: 'supply', goal: "buy iron and bronze arrows at Lowe's and teleport runes at Aubury's in Varrock for the black dragon hunt",
        tier: 'goal', band: HUNT_BAND + 0.3, filler: true, repeats: true, stock: { item: 'dragonhide', to: HIDE_TARGET }, resources: ['shop:lowe', 'shop:aubury'], yields: () => [],
        needs: { skills: hunt.needs!.skills, items: { coins: 32000 }, shortOf: { 'iron arrow': HUNT_ARROWS, 'air rune': 3, 'fire rune': 1 } },
    };
    const jakut: Template = {
        id: 'army-jakut-swords', pilot: true, family: 'shop-buyer', script: 'scripts/chain.ts', env: { ROUNDS: '1' },
        args: [['scripts/shop-buyer.ts', 'jukat', String(JAKUT_CAP), 'BLIND_BUY=1', `STOCK_TARGET=${JAKUT_SWORDS}`, 'STOP_AT_TARGET=1', 'BANK_AT=0', `NO_BUY_TICKS=${JAKUT_WAIT}`, 'STALL_TICKS=0',
            `COIN_RESERVE=${JAKUT_RESERVE}`, `FLOAT=${JAKUT_COINS}`].join(' ')],
        role: 'supply', goal: 'buy dragon longswords from Jakut in the Zanaris market', resources: ['shop:jukat'],
        tier: 'goal', band: HUNT_BAND + 0.05, filler: true, repeats: false, stock: { item: 'dragon longsword', to: 1 }, yields: () => [],
        needs: { quests: ['Lost City'], items: { 'dramen staff': 1, diamond: 1, coins: JAKUT_COINS } },
    };
    const leatherNeeds = { ...hunt.needs!.skills, Crafting: 10 };
    const leatherTrain = { skill: 'Crafting', to: LEATHER_LEVEL, unlocks: [] };
    const dhideSets: Template = {
        id: 'army-black-dhide-sets', pilot: true, family: 'aio:skiller:crafting:black-dhide-sets', script: 'scripts/aio.ts', args: ['skiller', 'crafting', 'black-dhide-sets'],
        aio: 'skiller:crafting:black-dhide-sets', worker: 'scripts/black-dhide-sets.ts', role: 'crafting', goal: 'tan black dragonhide at Al Kharid and craft sets of body, chaps and vambraces',
        tier: 'goal', band: HUNT_BAND + 0.1, filler: true, repeats: true, stock: { item: 'dragonhide body', to: ARMOUR_SETS }, yields: () => [],
        needs: { skills: { Crafting: LEATHER_LEVEL }, items: { coins: SET_HIDES * TAN_COIN + SET_SHOP }, holds: { dragonhide: SET_HIDES } },
    };
    const leatherFlax: Template = {
        id: 'army-leather-flax', pilot: true, family: 'aio:skiller:foraging:flax', script: 'scripts/aio.ts', args: ['skiller', 'foraging', 'flax', '1800', '28'],
        aio: 'skiller:foraging:flax', worker: 'scripts/gather-flax.ts', role: 'crafting', goal: 'pick flax at Seers to spin for the Crafting a black dragonhide body asks',
        tier: 'goal', band: HUNT_BAND + 0.2, filler: true, repeats: true, trains: leatherTrain, resources: [AIO_PLACES.flax], yields: () => [],
        needs: { skills: leatherNeeds, holdsUnder: { flax: FLAX_SPIN } },
    };
    const leatherSpin: Template = {
        id: 'army-leather-spin', pilot: true, family: 'aio:skiller:crafting:bowstrings', script: 'scripts/aio.ts',
        args: ['skiller', 'crafting', 'bowstrings', '2500', `MAX_MAKE=${FLAX_SPIN}`, 'RAW_RESERVE=0', 'MAX_TRIPS=8'],
        aio: 'skiller:crafting:bowstrings', worker: 'scripts/spin-bowstrings.ts', role: 'crafting', goal: 'spin flax at Seers to the Crafting a black dragonhide body asks',
        tier: 'goal', band: HUNT_BAND + 0.2, filler: true, repeats: true, trains: leatherTrain, yields: () => [],
        needs: { skills: leatherNeeds, holds: { flax: FLAX_SPIN } },
    };
    const lostCity: Template = {
        id: 'army-quest-lostcity', family: 'aio:quester:mode:chain', script: 'scripts/aio.ts', args: ['quester', 'chain', 'drunkmonk,murder,zanaris'],
        aio: 'quester:mode:chain', worker: 'scripts/quest-chain.ts', pilot: true, role: 'quest',
        goal: "complete Monk's Friend, Murder Mystery and Lost City to wield dragon weapons", tier: 'goal', band: QUEST_BAND,
        quest: { name: 'Lost City', unlocks: [] }, resources: [LOST_CITY], yields: () => [],
        needs: { items: { coins: 5000 }, anyOf: [{ skills: { Prayer: 43, Hitpoints: 90, Defence: 90 }, pieces: { of: LOST_CITY_FOOD, count: LOST_CITY_MEALS } }, LOST_CITY_BUILD] }, kitFirst: true,
    };
    const holyGrail: Template = {
        id: 'army-quest-holygrail', family: 'aio:quester:mode:chain', script: 'scripts/aio.ts', args: ['quester', 'chain', 'merlin,grail'],
        aio: 'quester:mode:chain', worker: 'scripts/quest-chain.ts', pilot: true, role: 'quest',
        goal: "complete Merlin's Crystal and Holy Grail for 275,000 Prayer experience", tier: 'goal', band: GRAIL_BAND,
        quest: { name: 'Holy Grail', unlocks: [] }, resources: [GRAIL_PLACE], yields: () => [],
        needs: { skills: { Prayer: 43, Magic: spellFact('camelot_teleport').level, Attack: 90, Strength: 90, Hitpoints: 90, Defence: 90 }, under: { Prayer: 99 }, items: { coins: 2000, 'rune scimitar': 1, ...GRAIL_RUNES },
            pieces: { of: LOST_CITY_FOOD, count: GRAIL_MEALS } }, kitFirst: true,
    };
    const fremennik: Template = {
        id: 'army-quest-fremennik', family: 'aio:quester:mode:chain', script: 'scripts/aio.ts', args: ['quester', 'chain', 'drunkmonk,murder,viking'],
        aio: 'quester:mode:chain', worker: 'scripts/quest-chain.ts', pilot: true, buildOnly: true, role: 'quest',
        goal: "complete Monk's Friend, Murder Mystery and The Fremennik Trials to wear a Fremennik helm", tier: 'goal', band: FREMENNIK_BAND,
        quest: { name: 'The Fremennik Trials', unlocks: [] }, resources: [FREMENNIK], yields: () => [],
        needs: { skills: { Prayer: 43, Hitpoints: 90, Fletching: 25 }, items: { coins: 6000 }, pieces: { of: LOST_CITY_FOOD, count: FREMENNIK_MEALS },
            anyOf: [{ skills: { Attack: 60, Strength: 60 } }, { skills: { Strength: 99 } }] }, kitFirst: true,
    };
    const fletch: Template = {
        id: 'army-fletch-25', family: 'fletch', script: 'scripts/chain.ts', pilot: true, buildOnly: true, route: 'The Fremennik Trials', role: 'fletching',
        args: [`scripts/walk-to.ts ${ARMY_BANK.x} ${ARMY_BANK.z}`, `scripts/fletch-arrows.ts 3000 headless MAX_MAKE=${FLETCH_MAKE} SHAFT_RESERVE=${FLETCH_KEEP} FEATHER_RESERVE=${FLETCH_KEEP} BANK_PACK=1`],
        env: { ROUNDS: '1' }, goal: 'make headless arrows to the Fletching 25 that The Fremennik Trials ask', tier: 'goal', band: FREMENNIK_BAND - 0.01, repeats: false,
        trains: { skill: 'Fletching', to: FLETCH_TO, unlocks: [fremennik.id] }, yields: () => [],
        needs: { items: { 'arrow shaft': FLETCH_MAKE + FLETCH_KEEP, feather: FLETCH_MAKE + FLETCH_KEEP } },
    };
    const FLETCH_30_MAKE = 540;
    const questFletch30: Template = {
        id: 'army-quest-fletch-30', family: 'fletch', script: 'scripts/chain.ts', pilot: true, noReserve: true, role: 'fletching',
        args: [`scripts/walk-to.ts ${ARMY_BANK.x} ${ARMY_BANK.z}`, `scripts/fletch-arrows.ts 3000 headless MAX_MAKE=${FLETCH_30_MAKE} SHAFT_RESERVE=${FLETCH_KEEP} FEATHER_RESERVE=${FLETCH_KEEP} BANK_PACK=1`],
        env: { ROUNDS: '1' }, goal: 'make headless arrows to reach Fletching 30 for quest board progression', tier: 'goal', band: QUEST_DEMAND_BAND - 0.02, repeats: false,
        trains: { skill: 'Fletching', to: 30, unlocks: questDemand().map(q => q.id) }, yields: () => [],
        needs: { items: { 'arrow shaft': FLETCH_30_MAKE + FLETCH_KEEP, feather: FLETCH_30_MAKE + FLETCH_KEEP } },
    };
    const BOW_KIT = { 'magic shortbow': 1, 'rune arrow': QUEST_BOW_ARROWS };
    const upass: Template = {
        id: 'army-quest-upass', family: 'aio:quester:mode:chain', script: 'scripts/aio.ts', args: ['quester', 'chain', 'elena,biohazard,upass'],
        aio: 'quester:mode:chain', worker: 'scripts/quest-chain.ts', pilot: true, buildOnly: true, role: 'quest', gives: ['Attack'],
        goal: 'complete Plague City, Biohazard and Underground Pass on the way to the dragon halberd', tier: 'goal', band: UPASS_BAND,
        quest: { name: 'Underground Pass', unlocks: [] }, resources: [UPASS], yields: () => [],
        needs: { skills: { Ranged: 99, Prayer: 43, Hitpoints: 90, Thieving: UPASS_THIEVING, Agility: UPASS_AGILITY }, items: { coins: 5000, ...BOW_KIT, 'prayer potion(4)': 2 },
            pieces: { of: LOST_CITY_FOOD, count: UPASS_MEALS } }, kitFirst: true,
    };
    const regicide: Template = {
        id: 'army-quest-regicide', family: 'aio:quester:mode:chain', script: 'scripts/aio.ts', args: ['quester', 'chain', 'murder,regicide'],
        aio: 'quester:mode:chain', worker: 'scripts/quest-chain.ts', pilot: true, buildOnly: true, role: 'quest', gives: ['Magic'],
        goal: 'complete Murder Mystery and Regicide to wield the dragon halberd', tier: 'goal', band: REGICIDE_BAND,
        quest: { name: 'Regicide', unlocks: [] }, resources: [UPASS], yields: () => [],
        needs: { quests: ['Underground Pass'], skills: { Ranged: 99, Magic: spellFact('ardougne_teleport').level, Prayer: 43, Hitpoints: 90, Agility: UPASS_AGILITY }, items: { coins: 2000, ...BOW_KIT, ...REGICIDE_RUNES, ...REGICIDE_PACK },
            pieces: { of: LOST_CITY_FOOD, count: REGICIDE_MEALS } }, kitFirst: true,
    };
    const upassThieve: Template = {
        id: 'army-thieve-50', family: 'thieving60', script: 'scripts/generated/thieving60.ts', env: { TARGET: String(UPASS_THIEVING), CAP: '2500', CLEAN_FOOD: '1' },
        pilot: true, buildOnly: true, route: 'Underground Pass', role: 'thieving', goal: 'train Thieving to the 50 that the cage doors of Underground Pass ask',
        tier: 'goal', band: UPASS_BAND - 0.02, repeats: true, trains: { skill: 'Thieving', to: UPASS_THIEVING, unlocks: [upass.id] }, yields: () => [],
    };
    const upassAgility: Template = {
        id: 'army-agility-68', family: 'aio:skiller:agility:order', script: 'scripts/aio.ts', args: ['skiller', 'agility', 'order', 'gnome', String(UPASS_AGILITY)],
        aio: 'skiller:agility:order', worker: 'scripts/agility-order.ts', pilot: true, buildOnly: true, route: 'Underground Pass', role: 'agility',
        goal: 'run the Gnome Stronghold course to the Agility 68 from which no bridge of Underground Pass fails',
        tier: 'goal', band: UPASS_BAND - 0.01, repeats: true, trains: { skill: 'Agility', to: UPASS_AGILITY, unlocks: [upass.id, regicide.id] }, yields: () => [],
    };
    const prayerField: Template = {
        id: 'army-trooper-prayer-99', family: 'combat-train', script: 'scripts/gather-combat.ts', args: ['1500', 'trooper'],
        env: { TRAIN_SKILL: 'Hitpoints', GIANT_KILLS: '500', GIANT_FOOD: '20', GIANT_BURY: '1', TROOPER_COOK: '1', LOOT_WATCH: '0' }, role: 'combat', goal: 'train Prayer to 99 burying trooper bones on the field',
        tier: 'goal', band: PRAYER_FIELD_BAND, filler: true, repeats: true, trains: { skill: 'Prayer', to: 99, unlocks: [] }, resources: [TROOPER_FIELD], yields: () => [],
        needs: { skills: { Attack: 60, Strength: 60, Defence: 60, Hitpoints: 40 }, anyOf: TROOPER_FED },
        batch: { trout: 100 },
    };
    const ranged: Template = {
        id: 'army-trooper-ranged-99', family: 'combat-train', script: 'scripts/gather-combat.ts', args: ['1500', 'trooper'],
        env: { TRAIN_SKILL: 'Ranged', TARGET_LEVEL: '99', GIANT_FOOD: '20', GIANT_BURY: '1', TROOPER_COOK: '1', LOOT_WATCH: '0' }, role: 'combat', goal: 'train Ranged to 99 on the Khazard troopers',
        tier: 'goal', band: RANGED_BAND, repeats: true, trains: { skill: 'Ranged', to: 99, unlocks: [] }, resources: [TROOPER_FIELD], yields: () => [],
        // RANGED_TROOPER_DEFENCE: the troopers reach an archer and hit it. Live, accounts with Defence 99 trained Ranged
        // 1 to 45-55 in a run with 0 to 1 food eaten and lowest HP 49 to 92; accounts with Defence 9, 10 and 43 ate 26 to
        // 36 food a run and fell to 16, 8 and 14 HP. An account under the floor takes its Defence bands first.
        needs: { skills: { Hitpoints: 40, Defence: RANGED_TROOPER_DEFENCE }, anyOf: RANGED_KIT.flatMap(kit => TROOPER_FED.map(fed => ({ ...kit, ...fed, skills: { ...kit.skills, ...fed.skills } }))) },
        batch: { trout: 100, ...Object.fromEntries(ARROWS.map(([arrow]) => [arrow, 1000])) },
    };
    const NO_ARROWS: Readonly<Record<string, number>> = Object.fromEntries(ARROWS.map(([arrow]) => [arrow, ARROW_LOW]));
    const arrows: Template = {
        id: 'army-arrows-ardy', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['ardy', '400'],
        env: { ITEMS: 'bronze arrow', STOCK_TARGET: String(ARROW_STOCK), STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: '5000', COIN_RESERVE: '500', MAX_SPEND: '4000' },
        role: 'supply', goal: 'buy bronze arrows at Aemad in East Ardougne for the Ranged band',
        tier: 'goal', band: RANGED_BAND, repeats: true, trains: { skill: 'Ranged', to: 99, unlocks: [] }, resources: ['shop:ardy'], yields: () => [],
        needs: { items: { coins: 5000 }, pieces: { of: BOWS.map(([bow]) => bow), count: 1 }, holdsUnder: NO_ARROWS },
    };
    const arrowsCatherby: Template = {
        id: 'army-arrows-catherby', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['catherby_arrows', '600'],
        env: { ITEMS: 'iron arrow|bronze arrow', STOCK_TARGET: String(LOWE_STOCK), STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: '21000', COIN_RESERVE: '500', MAX_SPEND: '20000' },
        role: 'supply', goal: "buy iron and bronze arrows at Hickton's in Catherby for the Ranged band",
        tier: 'goal', band: RANGED_BAND, repeats: true, trains: { skill: 'Ranged', to: 99, unlocks: [] }, resources: ['shop:catherby_arrows'], yields: () => [],
        needs: { items: { coins: 25000 }, pieces: { of: BOWS.map(([bow]) => bow), count: 1 }, holdsUnder: NO_ARROWS },
    };
    const guildRun = (items: string, target: number, spend: number) => ['scripts/shop-buyer.ts', 'dargaud', '800', `ITEMS=${items}`, `STOCK_TARGET=${target}`,
        'STOP_AT_TARGET=1', 'BANK_PACK=1', 'BANK_AT=0', 'NO_BUY_TICKS=25', `FLOAT=${spend + 1000}`, 'COIN_RESERVE=500', `MAX_SPEND=${spend}`].join(' ');
    const arrowsGuild: Template = {
        id: 'army-arrows-guild', family: 'shop-buyer', script: 'scripts/chain.ts',
        args: [guildRun('willow.shortbow', 1, 3000), guildRun('mithril.arrow|steel.arrow|iron.arrow|bronze.arrow', ARROW_STOCK, 50000)],
        env: { ROUNDS: '1' }, role: 'supply', goal: 'buy a willow shortbow and arrows up to mithril at the Ranging Guild for the Ranged band',
        tier: 'goal', band: GUILD_BAND, repeats: true, trains: { skill: 'Ranged', to: 99, unlocks: [] }, resources: ['shop:dargaud'], yields: () => [],
        needs: { skills: { Ranged: 40 }, items: { coins: 60000 }, pieces: { of: BOWS.map(([bow]) => bow), count: 1 }, holdsUnder: NO_ARROWS },
    };
    const arrowsLowe: Template = {
        id: 'army-arrows-lowe', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['lowe', '2500'],
        env: { ITEMS: 'iron arrow|bronze arrow', STOCK_TARGET: String(LOWE_STOCK), STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: '21000', COIN_RESERVE: '500', MAX_SPEND: '20000' },
        role: 'supply', goal: "buy iron and bronze arrows at Lowe's in Varrock for the Ranged band",
        tier: 'goal', band: RANGED_BAND, repeats: true, trains: { skill: 'Ranged', to: 99, unlocks: [] }, resources: ['shop:lowe'], yields: () => [],
        needs: { items: { coins: 25000 }, pieces: { of: BOWS.map(([bow]) => bow), count: 1 }, holdsUnder: NO_ARROWS },
    };
    const holdsUnderKeys = (items: readonly string[]) => Object.fromEntries(items.map(i => [i, 1]));
    const zekeShop = (tier: string, item: string, minAtt: number, maxAtt: number, coins: number, better: readonly string[]): Template => ({
        id: `army-weapon-zeke-${tier}`, family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['zeke', '1200'],
        env: { ITEMS: `^${item}$`, STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: String(coins), COIN_RESERVE: '200', MAX_SPEND: String(Math.max(200, coins - 200)) },
        role: 'supply', goal: `buy ${item} from Zeke in Al Kharid`, tier: 'goal', band: WEAPON_BAND, stock: { item, to: 1 }, repeats: false,
        resources: ['shop:zeke'], yields: () => [],
        needs: { ...(minAtt > 1 ? { skills: { Attack: minAtt } } : {}), under: { Attack: maxAtt }, items: { coins }, holdsUnder: holdsUnderKeys([item, ...better]) },
    });
    const zekeIron = zekeShop('iron', 'iron scimitar', 1, 5, 400, ['steel scimitar', 'mithril scimitar', ...WEAPON_HELD]);
    const zekeSteel = zekeShop('steel', 'steel scimitar', 5, 20, 800, ['mithril scimitar', ...WEAPON_HELD]);
    const zekeMithril = zekeShop('mithril', 'mithril scimitar', 20, 30, 2000, [...WEAPON_HELD]);
    const scavvoArmour: Template = {
        id: 'army-armour-scavvo', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['scavvo', '1500'],
        env: { ITEMS: 'rune platelegs|rune chainbody', STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: '120000', COIN_RESERVE: '5000', MAX_SPEND: '115000' },
        role: 'supply', goal: "buy rune platelegs and rune chainbody from Scavvo in the Champions' Guild",
        tier: 'goal', band: ARMOUR_BAND, stock: { item: 'rune platelegs', to: 1 }, repeats: false, resources: ['shop:scavvo'], yields: () => [],
        needs: { skills: { Defence: 40 }, questPoints: PEN_QUEST_POINTS['3197,3353'], items: { coins: 120_000 }, shortOf: { 'rune platelegs': 1, 'rune chainbody': 1 }, holdsUnder: { 'rune platebody': 1 } },
    };
    const nurmofPickaxes: Template[] = PICKAXE_LADDER.map(([lvl, item, coins], idx) => {
        const better = PICKAXE_LADDER.slice(0, idx + 1).map(([, p]) => p);
        const tier = item.split(' ')[0]!;
        return {
            id: `tool-pickaxe-${tier}`, family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['nurmof', '1200'],
            env: { ITEMS: `^${item}$`, STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: String(coins), COIN_RESERVE: '200', MAX_SPEND: String(Math.max(200, coins - 200)) },
            role: 'mining', goal: `buy ${item} from Nurmof in the Dwarven Mine`, repeats: false,
            resources: ['shop:nurmof'], yields: () => [{ item, perTick: 0.01 }],
            needs: { ...(lvl > 1 ? { skills: { Mining: lvl } } : {}), items: { coins }, holdsUnder: holdsUnderKeys(better) },
        };
    });
    const ardyIronAxe: Template = {
        id: 'tool-axe-iron', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['ardy', '1200'],
        env: { ITEMS: 'iron axe', STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: '300', COIN_RESERVE: '100', MAX_SPEND: '200' },
        role: 'woodcutting', goal: 'buy iron axe from Aemad in East Ardougne', repeats: false,
        resources: ['shop:ardy'], yields: () => [{ item: 'iron axe', perTick: 0.01 }],
        needs: { items: { coins: 300 }, holdsUnder: holdsUnderKeys(['iron axe', 'steel axe', 'black axe', 'mithril axe', 'adamant axe', 'rune axe']) },
    };
    const bobSteelAxe: Template = {
        id: 'tool-axe-steel', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['bob', '1200'],
        env: { ITEMS: 'steel axe', STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: '350', COIN_RESERVE: '100', MAX_SPEND: '220' },
        role: 'woodcutting', goal: "buy steel axe from Bob's Brilliant Axes in Lumbridge", repeats: false,
        resources: ['shop:bob'], yields: () => [{ item: 'steel axe', perTick: 0.01 }],
        provides: { item: 'steel axe', unlocks: ['squad-magic-logs'] },
        needs: { skills: { Woodcutting: 6 }, items: { coins: 350 }, holdsUnder: holdsUnderKeys(['steel axe', 'black axe', 'mithril axe', 'adamant axe', 'rune axe']) },
    };
    return [
        ...goldfarm,
        ...cows,
        ...troopers,
        strike,
        magic,
        splash,
        water,
        waterBetty,
        body,
        staff,
        feathers,
        fireRunes,
        staffGuild,
        natureGuild,
        airGuild,
        magicAir,
        prayer,
        dragonBones,
        bigBones,
        arrows,
        arrowsCatherby,
        arrowsGuild,
        arrowsLowe,
        ranged,
        lostCity,
        ...questDemand(),
        fletch,
        questFletch30,
        fremennik,
        upassThieve,
        upassAgility,
        upass,
        regicide,
        holyGrail,
        dustyKey,
        huntRune,
        hunt,
        huntBronze,
        huntSupplyRune,
        huntSupply,
        jakut,
        zekeIron,
        zekeSteel,
        zekeMithril,
        scavvoArmour,
        ...nurmofPickaxes,
        ardyIronAxe,
        bobSteelAxe,
        dhideSets,
        leatherFlax,
        leatherSpin,
        prayerField,
        { id: 'thieving55', family: 'thieving60', script: 'scripts/generated/thieving60.ts', env: { TARGET: '55', CAP: '2500', CLEAN_FOOD: '1' }, role: 'thieving',
            goal: 'train Thieving to 55 for a knight spot', trains: { skill: 'Thieving', to: 55, unlocks: goldfarm.map(g => g.id) }, yields: () => [] },
        ...CHICKEN_PENS.map((pen): Template => ({
            id: `feathers@${pen}`, family: 'gather-feathers', script: 'scripts/gather-feathers.ts', env: { PEN: pen, TICKS: '3000', TARGET: String(FEATHER_TARGET) }, role: 'helper',
            goal: `feathers at the chicken pen ${pen}`, resources: [`pen:${pen}`], needs: { holdsUnder: { feather: FEATHER_TARGET }, ...(PEN_QUEST_POINTS[pen] ? { questPoints: PEN_QUEST_POINTS[pen] } : {}) },
            // chicken.rs2: 15 feathers 1/4, 5 feathers 1/4 -> 5 a kill; about one kill and pickup per 16 ticks.
            yields: () => [{ item: 'feather', perTick: 0.3 }],
        })),
        { id: 'lobster-chain', family: 'gather-fish', script: 'scripts/chain.ts', args: ['scripts/gather-fish.ts cage 3000', 'scripts/cook-food.ts 3000 lobster'], role: 'fishing',
            goal: 'Catherby lobsters, caught and cooked', needs: { skills: { Fishing: 40, Cooking: 40 }, items: { 'lobster pot': 1 } }, resources: ['catherby:lobster'],
            yields: a => [{ item: 'lobster', perTick: 0.04 + 0.001 * Math.min(59, (a.skills.Fishing ?? 1) - 40) }] },
        { id: 'shop-runes', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['betty'], env: { ITEMS: 'fire rune|air rune|earth rune', STOCK_TARGET: String(SHOP_STOCK), BANK_PACK: '1', NO_BUY_TICKS: '25' }, role: 'bank',
            goal: 'buy elemental runes at Betty', needs: { items: { coins: 3000 }, shortOf: { 'fire rune': SHOP_STOCK, 'air rune': SHOP_STOCK, 'earth rune': SHOP_STOCK } }, resources: ['shop:betty'],
            yields: () => [{ item: 'fire rune', perTick: 0.7 }, { item: 'air rune', perTick: 0.7 }, { item: 'earth rune', perTick: 0.7 }], spends: () => [{ item: 'coins', perTick: 2.1 * 5 }] },
        { id: 'shop-feathers', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['sarim'], env: { ITEMS: 'feather', STOCK_TARGET: String(SHOP_STOCK), BANK_PACK: '1', NO_BUY_TICKS: '25' }, role: 'bank',
            goal: 'buy feathers at Gerrant', needs: { items: { coins: 2000 }, shortOf: { feather: SHOP_STOCK } }, resources: ['shop:sarim'],
            yields: () => [{ item: 'feather', perTick: 3 }], spends: () => [{ item: 'coins', perTick: 3 * 3 }] },
        { id: 'shop-arrowtips', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['catherby'], env: { ITEMS: 'rune arrowtips|adamant arrowtips', STOCK_TARGET: String(SHOP_STOCK), BANK_PACK: '1', NO_BUY_TICKS: '25' }, role: 'bank',
            goal: 'buy rune and adamant arrowtips at Catherby', needs: { items: { coins: 20000 }, shortOf: { 'rune arrowtips': SHOP_STOCK, 'adamant arrowtips': SHOP_STOCK } }, resources: ['shop:catherby'],
            yields: () => [{ item: 'rune arrowtips', perTick: 0.05 }, { item: 'adamant arrowtips', perTick: 0.05 }], spends: () => [{ item: 'coins', perTick: 0.05 * 260 + 0.05 * 104 }] },
        { id: 'fletch-headless', family: 'fletch', script: 'scripts/fletch-arrows.ts', args: ['15000', 'headless'], env: { BANK_PACK: '1', MAX_MAKE: '390' }, role: 'fletching',
            goal: 'headless arrows from owned shafts and feathers', needs: { items: { 'arrow shaft': 215, feather: 215 } },
            yields: () => [{ item: 'headless arrow', perTick: 5 }] },
        { id: 'shop-rune-arrows', pilot: true, family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['dargaud', '800'],
            env: { ITEMS: 'rune arrow', STOCK_TARGET: String(ARROW_LOW), STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: String(RUNE_ARROW_SPEND + 1000), COIN_RESERVE: '500', MAX_SPEND: String(RUNE_ARROW_SPEND) },
            role: 'bank', goal: "buy rune arrows at Dargaud's shop in the Ranging Guild", resources: ['shop:dargaud'],
            needs: { skills: { Ranged: 40 }, items: { coins: RUNE_ARROW_SPEND + 2000 }, holdsUnder: { 'rune arrow': ARROW_LOW } },
            yields: () => [{ item: 'rune arrow', perTick: ARROW_LOW / 800 }], spends: () => [{ item: 'coins', perTick: RUNE_ARROW_COST / 800 }] },
        ...aioTemplates(),
        ...makerChains(),
        ...squadSupplies(),
        ...makerShopSteps(),
    ];
}
