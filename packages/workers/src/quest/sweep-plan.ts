// Pure planning helpers, tables, item catalogs, routing geometry, and bank/shop/skill-training calculators for quest sweep.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deadlyTo, loadHunters } from '../../../core/src/danger';
import { ARROWS, BOWS, BUCKET, LOC_SOURCES, MILK, NPC_SOURCES, PICK_SOURCES, TINDERBOX, gatherPlan, type Gather } from '../../../core/src/gather';
import { selectGiantArrows, selectGiantBow } from '../../../core/src/ranged-tiers';
import { sellersByDistance, shopSellers } from '../../../core/src/shop-index';
import { crossesSea, locsByDistance, SEA, spawnsByDistance } from '../../../core/src/spawn-index';
import { questFoodDefinitions } from '../../../core/src/sustain';
import { loadTravel, travelAllowed, type Travel } from '../../../core/src/travel';
import { knownBankRecords } from '../../../core/src/trip';
import { rsPathLength, type Account, type Leg, type PathLength, type Tile, type Transport, type World } from '../../../core/src/world';
import { fireRunesFor } from './fire-spells';
import { presetConfig } from './presets';
import { REPO_ROOT, type Pt, type SaveConfig } from './types';

export { BUCKET, gatherPlan, LOC_SOURCES, MILK, SEA, type Gather, type Pt };

type Item = { id: number; count: number };
export type Walked = { ok: boolean; reason?: string; detail?: string; ticks?: number };

export const BANKS: Array<Tile & { site?: string }> = knownBankRecords();

export const countItems = (rows: readonly Item[], id: number) => {
    let n = 0;
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        if (r.id === id) n += r.count;
    }
    return n;
};

export function presetFor(quest: string): SaveConfig & { position: Tile } {
    const p = presetConfig('quest_' + quest);
    if (!p?.position) throw Error(`quest sweep: no preset quest_${quest} with a start tile`);
    const inventory = quest === 'hazeelcult' ? [{ id: 385, count: 4 }] : quest === 'hunt' ? (p.inventory ?? []).filter((i) => i.id !== 1963) : p.inventory;
    return {
        ...p,
        position: { x: p.position.x, z: p.position.z, level: p.position.level ?? 0 },
        ...(inventory ? { inventory } : {}),
        ...(quest === 'totem' ? { coins: 90, inventory: [...(p.inventory ?? []), { id: 1891, count: 8 }, { id: 1893, count: 1 }, { id: 1895, count: 2 }] } : {}),
    };
}

export const FOOD = new Set([329, 333, 361, 365, 373, 379, 385, 1891, 1893, 1895, 2309, 554, 555, 556, 557, 563]);
export const COINS = 995;
// herogloves-owned: the fire and air runes are the Fire Blasts at the Ice Queen, and the law rune with 5 air is the Camelot
// Teleport out of the lair.
export const QUEST_ITEMS_AMONG_FOOD: Record<string, number[]> = { merlin: [2309], 'herogloves-owned': [554, 556, 563] };
export const OPTIONAL = new Set([2446]);
export const QUEST_OPTIONAL: Record<string, number[]> = { druidspirit: [2952] };
// Items of OPTIONAL that a quest's script cannot do without: Family Crest uses an antipoison on Johnathon
// (crest_johnathon.rs2:21; hosted bench extra:sweep-crest-resume-s2 failed "step antipoison" with none staged).
export const QUEST_REQUIRED: Record<string, number[]> = { crest: [2446] };

export function needs(preset: SaveConfig, food = false, quest = ''): Map<number, number> {
    const m = new Map<number, number>();
    const own = new Set(QUEST_ITEMS_AMONG_FOOD[quest] ?? []);
    const optional = new Set(QUEST_OPTIONAL[quest] ?? []);
    const required = new Set(QUEST_REQUIRED[quest] ?? []);
    for (const i of preset.inventory ?? []) {
        if ((!OPTIONAL.has(i.id) || required.has(i.id)) && !optional.has(i.id) && (FOOD.has(i.id) && !own.has(i.id)) === food) {
            m.set(i.id, (m.get(i.id) ?? 0) + i.count);
        }
    }
    if (!food && preset.coins) m.set(COINS, (m.get(COINS) ?? 0) + preset.coins);
    return m;
}

const SCORPION_BARCRAWL = new Map([
    [COINS, 268],
    [563, 3],
    [556, 11],
    [555, 1],
    [554, 1],
]);

export function scorpionBarcrawlNeeds(base: ReadonlyMap<number, number>, barcrawlState: number | undefined): Map<number, number> {
    const staged = new Map(base);
    if (barcrawlState === 2) return staged;
    for (const [id, n] of SCORPION_BARCRAWL) staged.set(id, (staged.get(id) ?? 0) + n);
    return staged;
}

export function scorpionEntryRefusal(journal: string, clientVarp: unknown): string | null {
    if (journal === 'complete' || clientVarp === 6) return 'invalid entry: Scorpion Catcher is complete';
    if (journal === 'unknown') return 'invalid entry: Scorpion Catcher journal state unavailable';
    return null;
}

export const WORN_KIT: Record<string, readonly { id: number; required: boolean }[]> = {
    ball: [
        { id: 1059, required: true },
        { id: 1331, required: false },
    ],
    tree: [{ id: 1387, required: true }],
    grandtree: [{ id: 1387, required: true }],
    ikov: [{ id: 861, required: true }],
    druidspirit: [{ id: 552, required: true }],
    desertrescue: [
        { id: 1833, required: true },
        { id: 1835, required: true },
        { id: 1837, required: true },
        { id: 1333, required: false },
    ],
    troll: [{ id: 3105, required: true }],
    trolllove: [{ id: 3105, required: true }],
    eadgar: [{ id: 3105, required: true }],
    hauntedmine: [{ id: 1387, required: true }],
    arena: [{ id: 1387, required: false }],
    chompybird: [{ id: 2866, required: false }],
};

export function wornKitPlan(
    quest: string,
    base: ReadOnlyMap<number, number>,
    pack: readonly Item[],
    bank: readonly Item[],
    equipment: readonly Item[],
) {
    const wear = (WORN_KIT[quest] ?? []).filter(
        (i) => i.required || countItems(bank, i.id) > 0 || countItems(pack, i.id) > 0 || countItems(equipment, i.id) > 0,
    );
    const need = new Map(base);
    for (const i of wear) if (!countItems(equipment, i.id)) need.set(i.id, Math.max(1, need.get(i.id) ?? 0));
    return { need, wear };
}
type ReadOnlyMap<K, V> = ReadonlyMap<K, V>;

export function plan(need: ReadonlyMap<number, number>, pack: readonly Item[], bank: readonly Item[]) {
    const withdraw: Item[] = [];
    const missing: Item[] = [];
    for (const [id, n] of need) {
        const lack = n - countItems(pack, id);
        if (lack <= 0) continue;
        const take = Math.min(lack, countItems(bank, id));
        if (take > 0) withdraw.push({ id, count: take });
        if (take < lack) missing.push({ id, count: lack - take });
    }
    return { withdraw, missing };
}

export const MEALS = [385, 373, 379, 365, 361, 333, 329, 1891, 1893, 1895, 2309];
const MEAL_SET = new Set(MEALS);

export function mealPlan(
    food: ReadonlyMap<number, number>,
    pack: readonly Item[],
    bank: readonly Item[],
    questWithdraw: readonly Item[] = [],
    need: ReadonlyMap<number, number> = new Map(),
): Item[] {
    const want = new Map<number, number>();
    const stock: Item[] = [];
    for (const [id, n] of food) {
        want.set(id, n + (need.get(id) ?? 0));
        stock.push({ id, count: Math.max(0, countItems(bank, id) - countItems(questWithdraw, id)) });
    }
    const exact = plan(want, questWithdraw.length ? [...pack, ...questWithdraw] : pack, stock);
    const withdraw = [...exact.withdraw];
    let left = 0;
    for (let i = 0; i < exact.missing.length; i++) {
        const m = exact.missing[i]!;
        if (MEAL_SET.has(m.id)) left += m.count;
    }
    for (let i = 0; i < MEALS.length; i++) {
        const id = MEALS[i]!;
        if (!food.has(id)) {
            const spare = countItems(pack, id) - (need.get(id) ?? 0);
            if (spare > 0) left -= spare;
        }
    }
    for (let i = 0; i < MEALS.length; i++) {
        if (left <= 0) break;
        const id = MEALS[i]!;
        if (food.has(id)) continue;
        const take = Math.min(left, countItems(bank, id) - countItems(questWithdraw, id));
        if (take > 0) {
            withdraw.push({ id, count: take });
            left -= take;
        }
    }
    return withdraw;
}

export function foodShort(
    food: ReadonlyMap<number, number>,
    pack: readonly Item[],
    need: ReadonlyMap<number, number> = new Map(),
): boolean {
    let meals = 0;
    let nonMeals: Map<number, number> | undefined;
    for (const [id, c] of food) {
        if (MEAL_SET.has(id)) {
            meals += c;
        } else {
            nonMeals ??= new Map();
            nonMeals.set(id, c);
        }
    }
    let held = 0;
    for (let i = 0; i < MEALS.length; i++) {
        const id = MEALS[i]!;
        const s = countItems(pack, id) - (need.get(id) ?? 0);
        if (s > 0) held += s;
    }
    return held < meals || (!!nonMeals && plan(nonMeals, pack, []).missing.length > 0);
}

export function toolPlan(
    tools: readonly Item[],
    need: ReadonlyMap<number, number>,
    pack: readonly Item[],
    worn: readonly Item[],
    bank: readonly Item[],
    questWithdraw: readonly Item[],
) {
    const want = new Map(tools.map((t) => [t.id, t.count + (need.get(t.id) ?? 0)]));
    const taken = (id: number) => countItems(questWithdraw, id);
    return plan(
        want,
        [...pack, ...questWithdraw, ...worn],
        bank.map((i) => ({ id: i.id, count: i.count - taken(i.id) })).filter((i) => i.count > 0),
    );
}

// A lit light source and the unlit one that a tinderbox lights: the light_source_unlit objs and their `product` param
// (quest_arthur.obj unlit_candle, unlit_black_candle; firemaking.obj torch_unlit). The tinderbox's opheldu with one
// swaps it for its product (skill_firemaking/scripts/firemaking.rs2:26, light_source.rs2 ignite_light_source), and the
// tinderbox stays. No shop sells a lit one; candle shops sell the unlit candle.
export const LIGHT_SOURCES: Readonly<Record<number, number>> = { 33: 36, 32: 38, 594: 596 };
export type LightStep = { lit: number; unlit: number; count: number };

// The lit light sources that the sweep lights at the bank: the count of each that the quest pack needs beyond the
// pack and the bank, up to the unlit ones that the pack and the bank hold beyond the pack's own need. It needs a
// tinderbox in the pack or the bank. A short light source with no unlit one goes to the gather plan (a lit candle
// lies in the Ardougne monastery, maps/m40_50.jm2, nearer the Ardougne banks than any candle shop).
export function lightPlan(need: ReadonlyMap<number, number>, pack: readonly Item[], bank: readonly Item[]): LightStep[] {
    const owned = (id: number) => countItems(pack, id) + countItems(bank, id);
    if (owned(TINDERBOX) === 0) return [];
    const out: LightStep[] = [];
    for (const [key, unlit] of Object.entries(LIGHT_SOURCES)) {
        const lit = Number(key);
        const short = (need.get(lit) ?? 0) - owned(lit);
        const count = Math.min(short, owned(unlit) - (need.get(unlit) ?? 0));
        if (count > 0) out.push({ lit, unlit, count });
    }
    return out;
}

export const QUEST_KEEP: Record<string, number[]> = {
    runemysteries: [1438, 290, 291],
    totem: [1858, 1857],
    murder: [
        1796, 1797, 1798, 1799, 1800, 1801, 1802, 1803, 1804, 1805, 1806, 1807, 1808, 1809, 1810, 1811, 1812, 1813, 1814,
        1815, 1816, 1817, 1818, 1819, 1820, 1821, 1822,
    ],
    sheepherder: [278, 279, 284, 285, 280, 281, 282, 283],
    hunt: [431, 432, 433],
    druidspirit: [2952],
};

export const STURDY = 90;
export const STURDY_MEALS = 10;
export const STURDY_OPTIONAL: Record<string, number[]> = { zanaris: [2434] };
export const PRAYER_USED: Record<string, number> = { tree: 64, grandtree: 47, arena: 7 };
export const PRAYER_MARGIN = 15;
export const PRAYER_POTIONS = [2434, 139, 141, 143];
export const ANTIPOISONS = [2448, 181, 183, 185, 175, 177, 179];

export function scorpionAntipoisonNeeds(
    base: ReadonlyMap<number, number>,
    pack: readonly Item[],
    bank: readonly Item[],
): Map<number, number> {
    const need = new Map(base);
    const doses = [...ANTIPOISONS, 2446];
    for (const id of doses) need.delete(id);
    const owned = (rows: readonly Item[]) => doses.find((id) => countItems(rows, id) > 0);
    need.set(owned(pack) ?? owned(bank) ?? 175, 1);
    return need;
}

export const QUEST_FINDS: Record<string, readonly number[]> = { mm: [3183], druidspirit: [2952] };
export const prayerCovers = (quest: string, prayer: number) =>
    PRAYER_USED[quest] !== undefined && prayer >= PRAYER_USED[quest]! + PRAYER_MARGIN;
// The prayer potions a quest's sweep stages for an account at this base Prayer level: the preset's count, or 0 when the
// level covers the fights (prayerCovers). No shop sells them, so a planner gives the quest to an account that holds
// this many in its bank, or supplies them first; the sweep otherwise fails at the bank with "missing 2434:<n>".
export const prayerPotionDemand = (quest: string, prayer: number): number => {
    if (PRAYER_USED[quest] === undefined || prayerCovers(quest, prayer)) return 0;
    const need = needs(presetFor(quest));
    return PRAYER_POTIONS.reduce((n, id) => n + (need.get(id) ?? 0), 0);
};
// The hitpoints that a quest script's own fight costs a live account (the presets are all 99 in rune armour and carry
// 0 to 2 meals): Biohazard's sick mourner took 54 from a 31-hitpoint account in melee, the Paterdomus Temple guardian
// killed an 18-hitpoint account. The sweep stages the meals that cover the cost beyond half the base hitpoints, and
// fails at the bank when the bank and the pack hold fewer.
export const QUEST_FIGHT_DAMAGE: Record<string, number> = { biohazard: 80, priestperil: 60 };
export const MEAL_HEAL = 12;
export const LOBSTER = 379;
export const fightMeals = (quest: string, maxHp: number): number => {
    const damage = QUEST_FIGHT_DAMAGE[quest];
    return damage === undefined ? 0 : Math.max(0, Math.ceil((damage - Math.floor(maxHp / 2)) / MEAL_HEAL));
};
// The runes of a quest's teleport exit from a walled area, required from the bank (the FOOD set otherwise makes runes
// optional) for an account that can cast the spell. Biohazard: the Mourner HQ is in West Ardougne, whose city doors
// stay shut until the quest is complete, so without an Ardougne Teleport (Magic 51, 2 law, 2 water) the only exit is
// Kilron's ladder on foot; a failed walk there left accounts at 2546,3325 with no route out.
export const QUEST_EXIT_RUNES: Record<string, { magic: number; items: readonly Item[] }> = {
    biohazard: { magic: 51, items: [{ id: 563, count: 2 }, { id: 555, count: 2 }] },
};
// Moves the exit runes from the optional food plan to the required base plan when the Magic level casts the exit. A rune
// in neither plan (a resume past the exit spent it) stays out.
export function withExitRunes(base: ReadonlyMap<number, number>, food: ReadonlyMap<number, number>, quest: string, magic: number): { base: Map<number, number>; food: Map<number, number> } {
    const b = new Map(base);
    const f = new Map(food);
    const exit = QUEST_EXIT_RUNES[quest];
    if (!exit || magic < exit.magic) return { base: b, food: f };
    for (const i of exit.items) {
        const have = b.get(i.id) ?? 0;
        if (have >= i.count || (!b.has(i.id) && !f.has(i.id))) continue;
        const add = i.count - have;
        b.set(i.id, i.count);
        const left = (f.get(i.id) ?? 0) - add;
        if (left > 0) f.set(i.id, left);
        else f.delete(i.id);
    }
    return { base: b, food: f };
}
// The food plan with the fight's meals: the preset's meal raised to fightMeals, or lobsters for a preset with none
// (mealPlan withdraws other meals for a short one).
export function withFightMeals(food: ReadonlyMap<number, number>, quest: string, maxHp: number): Map<number, number> {
    const out = new Map(food);
    const meals = fightMeals(quest, maxHp);
    if (!meals) return out;
    const meal = [...out.keys()].find((id) => MEAL_SET.has(id)) ?? LOBSTER;
    out.set(meal, Math.max(out.get(meal) ?? 0, meals));
    return out;
}
// The meals that the pack and the planned withdrawals hold beyond the quest items, short of the fight's meals.
export function fightMealsShort(meals: number, pack: readonly Item[], withdraw: readonly Item[], need: ReadonlyMap<number, number> = new Map()): number {
    let held = 0;
    for (let i = 0; i < MEALS.length; i++) {
        const id = MEALS[i]!;
        const s = countItems(pack, id) + countItems(withdraw, id) - (need.get(id) ?? 0);
        if (s > 0) held += s;
    }
    return Math.max(0, meals - held);
}
export const FIRE_QUESTS = new Set(['tree', 'grandtree', 'arena']);
export const BUILD_PACK: Record<string, Item[]> = {
    upass: [
        { id: 861, count: 1 },
        { id: 892, count: 600 },
        { id: 2434, count: 2 },
    ],
    regicide: [
        { id: 861, count: 1 },
        { id: 892, count: 600 },
    ],
};
export const BUILD_MEALS: Record<string, number> = { upass: 12, regicide: 8 };
export const buildPack = (quest: string, level: (skill: string) => number): Item[] =>
    level('Defence') < 40 && level('Ranged') >= 50 && level('Ranged') > level('Attack') ? BUILD_PACK[quest] ?? [] : [];

// herogloves-owned: the Ice Queen falls to Fire Blast, and worn melee armour lowers Magic attack (a rune full helm,
// platebody, platelegs and kiteshield total -65, knowledge/gear.json).
export const BARE = new Set(['zanaris', 'grail', 'viking', 'ikov', 'herogloves-owned']);

export function ikovExcessMeals(
    pack: readonly Item[],
    food: ReadonlyMap<number, number>,
): { id: number; deposit: number }[] {
    let allowance = 0;
    for (const [id, c] of food) {
        if (MEAL_SET.has(id)) allowance += c;
    }
    const deposits: { id: number; deposit: number }[] = [];
    for (let i = 0; i < MEALS.length; i++) {
        const id = MEALS[i]!;
        const held = countItems(pack, id);
        if (!held) continue;
        const keep = Math.min(held, allowance);
        allowance -= keep;
        if (held > keep) deposits.push({ id, deposit: held - keep });
    }
    return deposits;
}

export const shopCoinTake = (shopCoins: number, packCoins: number, plannedCoins: number, questCoins: number) =>
    Math.max(0, shopCoins - Math.max(0, packCoins + plannedCoins - questCoins));

export function bareDeposits(
    quest: string,
    pack: readonly Item[],
    need: ReadonlyMap<number, number>,
    food: ReadonlyMap<number, number>,
    tradeable: (id: number) => boolean | undefined,
): number[] {
    const seen = new Set<number>();
    const out: number[] = [];
    for (let i = 0; i < pack.length; i++) {
        const id = pack[i]!.id;
        if (seen.has(id)) continue;
        seen.add(id);
        if (id !== COINS && !need.has(id) && !food.has(id) && !MEAL_SET.has(id) && !keepsItem(quest, id, tradeable)) {
            out.push(id);
        }
    }
    return out;
}

export function keepsItem(quest: string, id: number, tradeable: (id: number) => boolean | undefined): boolean {
    return (QUEST_KEEP[quest] ?? []).includes(id) || tradeable(id) === false;
}

export const STACKS = new Set([COINS, 554, 555, 556, 557, 558, 559, 560, 561, 562, 563, 564, 565, 566, ...ARROWS]);

export function slotsFor(withdraw: readonly Item[], pack: readonly Item[]): number {
    const stack = (id: number) => STACKS.has(id) || pack.some((i) => i.id === id && i.count > 1);
    return withdraw.reduce((n, w) => n + (stack(w.id) ? (pack.some((i) => i.id === w.id) ? 0 : 1) : w.count), 0);
}

export const KEEP_FOOD = 8;
let edible: Set<number> | undefined;
export const isEdible = (id: number) => FOOD.has(id) || (edible ??= new Set(questFoodDefinitions().keys())).has(id);
export const reservedEdible = (need: ReadonlyMap<number, number>): Record<number, number> =>
    Object.fromEntries([...need].filter(([id]) => isEdible(id)));

export const QUEST_PICKUP_SLOTS = 8;
export const MIN_PICKUP_SLOTS = 2;
export const QUEST_PICKUPS: Record<string, Item[]> = {
    hunt: [
        { id: 1963, count: 10 },
        { id: 431, count: 1 },
    ],
};
export const QUEST_ARROWS: Record<string, number> = { merlin: 40, prince: 30, hazeelcult: 20, scorpion: 40, biohazard: 20 };
export const QUEST_CASTS: Record<string, number> = { hazeelcult: 12, prince: 15, scorpion: 30, biohazard: 12 };

export function jailerBowKit(
    quest: string,
    owned: readonly Item[],
    ranged: number,
    attack: number,
    coreKit: boolean,
): { bow: number; arrows: number } | null {
    if (quest !== 'scorpion' || coreKit || ranged <= attack || !QUEST_ARROWS[quest]) return null;
    const bow = selectGiantBow(owned, ranged);
    const arrows = bow && selectGiantArrows(owned, ranged, bow.level);
    return bow && arrows !== undefined ? { bow: bow.id, arrows } : null;
}

export const NET = 303;
export const RAW_SHRIMPS = 317;
export const RAW_ANCHOVIES = 321;
export const CATHERBY_BEACH: Tile = { x: 2838, z: 3431, level: 0 };
export const TRAIN_TICKS = 900;
export const questSkillTraining = (
    quest: string,
    level: (skill: string) => number,
): { skill: 'Fishing'; level: number; tools: Item[]; pickups: Item[] } | null =>
    quest === 'fishingcompo' && level('Fishing') < 10
        ? { skill: 'Fishing', level: 10, tools: [{ id: NET, count: 1 }], pickups: [{ id: RAW_SHRIMPS, count: 6 }] }
        : null;

export const staysCount = (pack: readonly Item[], keep: (id: number) => boolean) =>
    pack.filter((i) => i.id === COINS || keep(i.id) || (STACKS.has(i.id) && isEdible(i.id))).length;

export function slotNeed(supplies: number, stays: number): number {
    const room = 28 - supplies - stays;
    const reserve = Math.max(MIN_PICKUP_SLOTS, Math.min(QUEST_PICKUP_SLOTS, room - KEEP_FOOD));
    return Math.min(28 - stays, supplies + reserve);
}

export function depositPlan(
    pack: readonly Item[],
    need: number,
    keep: (id: number) => boolean,
    spare: (id: number) => boolean = () => false,
): Item[] {
    let free = 28 - pack.length;
    const out: Item[] = [];
    const slotCounts = new Map<number, number>();
    for (let i = 0; i < pack.length; i++) {
        const id = pack[i]!.id;
        slotCounts.set(id, (slotCounts.get(id) ?? 0) + 1);
    }
    for (const [id, slots] of slotCounts) {
        if (free >= need) break;
        if (id === COINS || isEdible(id) || keep(id)) continue;
        out.push({ id, count: -1 });
        free += slots;
    }
    let allowance = Math.max(0, Math.min(KEEP_FOOD, 28 - need - staysCount(pack, keep)));
    for (const [id, held] of slotCounts) {
        if (free >= need) break;
        if (!isEdible(id) || STACKS.has(id) || keep(id)) continue;
        const kept = Math.min(held, allowance);
        allowance -= kept;
        const bank = Math.min(held - kept, need - free);
        if (bank > 0) {
            out.push({ id, count: bank });
            free += bank;
        }
    }
    for (const [id, slots] of slotCounts) {
        if (free >= need) break;
        if (!spare(id)) continue;
        out.push({ id, count: -1 });
        free += slots;
    }
    return out;
}

export const MAX_HOP = 180;
export const HOP_GAIN = 50;
export const cheb = (a: Tile, b: Tile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

export function hopsTo(from: Tile, to: Tile, hubs: readonly Tile[] = [...BANKS, { x: 3222, z: 3218, level: 0 }]): Tile[] {
    const out: Tile[] = [];
    let at = from;
    for (let i = 0; i < 12; i++) {
        const curDist = cheb(at, to);
        if (curDist <= MAX_HOP) break;
        const maxToDist = curDist - HOP_GAIN;
        let next: Tile | undefined;
        let bestScore = Infinity;
        for (let hIdx = 0; hIdx < hubs.length; hIdx++) {
            const h = hubs[hIdx]!;
            if (h.level !== to.level) continue;
            const dFrom = cheb(at, h);
            if (dFrom > MAX_HOP) continue;
            const dTo = cheb(h, to);
            if (dTo > maxToDist) continue;
            const score = dFrom + dTo;
            if (score < bestScore) {
                bestScore = score;
                next = h;
            }
        }
        if (!next) break;
        out.push(next);
        at = next;
    }
    return out;
}

export const UNDERGROUND = 6400;
export const surfaceOf = (t: Tile): Tile => (t.z >= UNDERGROUND ? { ...t, z: t.z - UNDERGROUND } : t);

export function nearestBanks(at: Tile, actor?: Account, edges?: readonly Travel[]): Tile[] {
    const a = surfaceOf(at);
    const landings = actor ? (edges ?? loadTravel()).filter((t) => t.from === null && t.to.level === a.level && travelAllowed(t, actor)) : [];
    const score = (bank: Tile) => Math.min(cheb(a, bank), ...landings.map((t) => t.cost + cheb(t.to, bank)));
    return BANKS.filter((b) => b.level === a.level).sort((x, y) => score(x) - score(y));
}

export function eatAtFor(maxHp: number): number {
    return Math.max(10, Math.floor(maxHp * 0.6));
}

export const FAR_SELLER = 800;

export function travelDistance(from: Tile, to: Tile): number {
    return cheb(from, to) + (crossesSea(from, to) ? SEA : 0);
}

// The Kharidian Desert south of the Shantay Pass. Each southbound crossing of the gate consumes a Shantay pass
// (knowledge/npc-travel.json shantay_guard_still); the northbound way is free.
export const SHANTAY_PASS = 1854;
export const inKharidDesert = (t: Tile) => t.level === 0 && t.x >= 3130 && t.x <= 3520 && t.z >= 2880 && t.z <= 3115;

// Items a quest start behind an item gate needs when the account is outside the gate. The preset starts inside, so its
// inventory does not hold them.
export const QUEST_TRAVEL_ITEMS: Record<string, readonly { id: number; inside: (t: Tile) => boolean }[]> = {
    desertrescue: [{ id: SHANTAY_PASS, inside: inKharidDesert }],
};
export function questTravelItems(quest: string, at: Tile, start: Tile): Item[] {
    return (QUEST_TRAVEL_ITEMS[quest] ?? []).filter((g) => g.inside(start) && !g.inside(at)).map((g) => ({ id: g.id, count: 1 }));
}

export function sellersByTravel<S extends { tile: Tile }>(
    sellers: readonly S[],
    at: Tile,
    dest?: Tile,
    acct?: Pick<Account, 'skills'>,
): S[] {
    const boats = (a: Tile, b: Tile) => (eastOfArdougne(a, b, acct) ? 1 : 0);
    // A seller across the Shantay Pass costs a pass that the quest start needs.
    const gate = (t: Tile) => (inKharidDesert(t) !== inKharidDesert(at) ? SEA : 0);
    const cost = (t: Tile) =>
        gate(t) +
        (dest
            ? detour([at, dest], t) + SEA * Math.max(0, boats(at, t) + boats(t, dest) - boats(at, dest))
            : travelDistance(at, t) + SEA * boats(at, t));
    return [...sellers].sort((a, b) => cost(a.tile) - cost(b.tile));
}

export function nearestBank(at: Tile): Tile {
    let best: Tile | undefined;
    let bestDist = Infinity;
    for (let i = 0; i < BANKS.length; i++) {
        const b = BANKS[i]!;
        if (b.level !== at.level) continue;
        const d = Math.max(Math.abs(b.x - at.x), Math.abs(b.z - at.z));
        if (d < bestDist) {
            bestDist = d;
            best = b;
        }
    }
    return best ?? BANKS[0]!;
}

export const WEST_ARDOUGNE = {
    hqDoor: { id: 2036, x: 2551, z: 3320 },
    upDoor: { id: 2034, x: 2547, z: 3325 },
    gate: { id: 2060, x: 2551, z: 3325 },
    stairsTop: { id: 1740, x: 2543, z: 3325 },
    stairsDoor: { x: 2546, z: 3325 },
    kilron: { id: 349, x: 2556, z: 3266 },
    landing: { x: 2559, z: 3267 },
    teleport: { comp: 'magic:ardougne_teleport', x: 2661, z: 3301 },
} as const;
export const inWestArdougne = (p: { x: number; z: number }) => p.x >= 2496 && p.x <= 2557 && p.z >= 3264 && p.z <= 3335;

export const ELENA_HOUSE = { door: { id: 2054, x: 2592, z: 3339 }, outside: { x: 2592, z: 3339, level: 0 } } as const;
export const inElenaHouse = (p: { x: number; z: number; level: number }) =>
    p.level === 0 && p.x >= 2589 && p.x <= 2594 && p.z >= 3334 && p.z <= 3338;

export const MANOR_FOOD = { id: 272, x: 3108, z: 3356, level: 1 };
export const MANOR_POISON = { id: 273, x: 3097, z: 3366, level: 0 };
export const manorFoodNeed = (quest: string, missing: readonly Item[]) =>
    quest === 'haunted' && missing.some((m) => m.id === MANOR_FOOD.id && m.count === 1);
export const manorPoisonNeed = (quest: string, missing: readonly Item[]) =>
    quest === 'haunted' && missing.some((m) => m.id === MANOR_POISON.id && m.count === 1);
export const leaveToManorTrip = <G extends { id: number }>(gathers: readonly G[], manorFood: boolean, manorPoison = false): G[] =>
    gathers.filter((g) => !(manorFood && g.id === MANOR_FOOD.id) && !(manorPoison && g.id === MANOR_POISON.id));

export const HECKEL_DUST = { id: 1975, coins: 106, ground: { x: 2493, z: 3488, level: 0 }, ladder: { x: 2466, z: 3495 } };
export const heckelDustNeed = (quest: string, missing: readonly Item[]) =>
    quest === 'elena' && missing.some((m) => m.id === 1975 && m.count === 1);
export const groundShopNeeds = (quest: string, missing: readonly Item[]) =>
    missing.filter((m) => !(heckelDustNeed(quest, missing) && m.id === 1975));

export const JIMINUA: Tile = { x: 2767, z: 3122, level: 0 };
export const KARAMJA: Pt[] = [
    [2774, 3228, 3],
    [2800, 3200, 5],
    [2850, 3175, 5],
    [2920, 3160, 5],
    [2956, 3146, 3],
];
export const JIMINUA_FROM_BRIMHAVEN: Pt[] = [
    [2774, 3228, 2],
    [2800, 3200, 3],
    [2790, 3160, 3],
    [JIMINUA.x, JIMINUA.z, 2],
];
export const SARIM_NORTH: Pt[] = [
    [3047, 3237, 3],
    [3060, 3265, 3],
    [3089, 3266, 2],
    [3100, 3285, 3],
    [3180, 3258, 3],
];
export const SWEEP_PLAN_BUDGET_MS = 15_000;
export const SEERS_ALTAR = { id: 409, x: 2694, z: 3462, level: 0, stand: { x: 2695, z: 3462, level: 0 } } as const;
export const PRAYER_QUESTS: Record<string, number> = {
    merlin: 30,
    grail: 60,
    ikov: 37,
    hauntedmine: 40,
    horror: 40,
    eadgar: 40,
    troll: 43,
    trolllove: 43,
};
export const prayerShort = (points: number, level: number, wanted: number) => points < Math.min(level, wanted);
// The prayer points that the sweep restores at the Seers' Village altar before a quest: PRAYER_QUESTS, or for a fight
// quest whose Prayer level covers its fights (prayerCovers on the base level) the points that the fights use with the
// margin. The sweep then stages no prayer potion, and the brain preflight (packages/workers/src/quest/bank-needs.ts),
// which sees only the base level, asks for none.
export const prayerWanted = (quest: string, level: number): number | undefined =>
    PRAYER_QUESTS[quest] ?? (prayerCovers(quest, level) ? PRAYER_USED[quest]! + PRAYER_MARGIN : undefined);

let grid: Promise<PathLength> | undefined;
export const sameArea = async (a: Tile, b: Tile, load = () => rsPathLength()) => {
    if (a.level !== b.level) return false;
    const area = (await (grid ??= load())).areaOf;
    if (!area) return true;
    const x = area(a);
    const y = area(b);
    return x < 0 || y < 0 || x === y;
};

export function wayDown(transports: readonly Transport[], at: Tile): Tile {
    const downs = transports
        .filter((t) => t.from.level === at.level && t.to.level < at.level && cheb(t.from, at) <= 80)
        .sort((a, b) => cheb(a.from, at) - cheb(b.from, at));
    return downs[0]?.to ?? { x: at.x, z: at.z, level: 0 };
}

export function wayUp(transports: readonly Transport[], to: Tile, depth = 3): Tile {
    if (to.level === 0 || depth === 0) return { x: to.x, z: to.z, level: 0 };
    const up = transports
        .filter((t) => t.to.level === to.level && t.from.level < to.level && cheb(t.to, to) <= 80)
        .sort((a, b) => cheb(a.to, to) - cheb(b.to, to))[0];
    if (!up) return { x: to.x, z: to.z, level: 0 };
    return up.from.level === 0 ? up.from : wayUp(transports, up.from, depth - 1);
}

export function approachOf(transports: readonly Transport[], to: Tile): Tile {
    if (to.z < UNDERGROUND) return wayUp(transports, to);
    const down = transports
        .filter((t) => t.from.level === 0 && t.from.z < UNDERGROUND && t.to.z >= UNDERGROUND && t.to.level === to.level && cheb(t.to, to) <= 80)
        .sort((a, b) => cheb(a.to, to) - cheb(b.to, to))[0];
    return down ? { ...down.from } : { ...surfaceOf(to), level: 0 };
}

export const TAVERLEY_SIDE = (to: Tile) => to.level === 0 && to.x >= 2880 && to.x < 2960 && to.z >= 3400;
const BIG_WOLF: Tile = { x: 2840, z: 3497, level: 0 };
export const mountainClosed = (acct: Pick<Account, 'skills'>, hunters = loadHunters()) =>
    hunters.filter((h) => h.spawns.some((s) => s.x === BIG_WOLF.x && s.z === BIG_WOLF.z && s.level === BIG_WOLF.level)).some((h) => deadlyTo(h, acct.skills));
export const eastOfArdougne = (from: Tile, to: Tile, acct?: Pick<Account, 'skills'>) =>
    from.level === 0 &&
    from.z >= 3270 &&
    (from.x < 2800 || (from.x < 2860 && !!acct && mountainClosed(acct))) &&
    (to.x >= 2950 || (!!acct && TAVERLEY_SIDE(to) && mountainClosed(acct)));
export const BOAT_FARES = 60;

export type Buy = {
    id: number;
    count: number;
    name: string;
    npcId: number;
    npc: string;
    tile: Tile;
    alts?: { npc: string; npcId: number; tile: Tile }[];
    atLeast?: number;
};

export function scorpionCureJourney(from: Tile, b: Pick<Buy, 'id' | 'count' | 'npcId' | 'tile'>): 'sarim' | 'ardougne' | null {
    if (b.id !== 175 || b.count !== 1 || b.npcId !== 560 || b.tile.level !== 0 || b.tile.x !== JIMINUA.x || b.tile.z !== JIMINUA.z || from.level !== 0) {
        return null;
    }
    if (from.x >= 3150 && from.x <= 3260 && from.z >= 3380 && from.z <= 3500) return 'sarim';
    if (from.x >= 2540 && from.x <= 2630 && from.z >= 3070 && from.z <= 3110) return 'ardougne';
    if (from.x === 2655 && from.z === 3283) return 'ardougne';
    return null;
}

export const fares = (from: Tile, targets: readonly Tile[], acct?: Pick<Account, 'skills'>, scorpionBuys: readonly Buy[] = []) =>
    (targets.some((t) => eastOfArdougne(from, t, acct)) ? BOAT_FARES : 0) +
    (scorpionBuys.some((b) => scorpionCureJourney(from, b)) ? BOAT_FARES : 0);

export const SARIM_LANDING: Tile = { x: 3029, z: 3217, level: 0 };
export const SHOP_TALK: Record<number, RegExp[]> = { 874: [/^yes i do/i] };
export const eastOfPass = (at: Tile, acct: Pick<Account, 'skills'>) =>
    at.level === 0 && at.z < 4000 && (at.z >= 3270 ? at.x >= 2880 || (at.x >= 2780 && at.z >= 3470) : at.x >= 2950) && mountainClosed(acct);

export const OBSERVATORY_FROM_ARDOUGNE: Pt[] = [
    [2657, 3275, 2],
    [2626, 3260, 2],
    [2588, 3243, 2],
    [2549, 3230, 2],
    [2527, 3240, 2],
    [2501, 3228, 2],
    [2481, 3204, 2],
    [2466, 3180, 2],
    [2456, 3167, 2],
];

export function shopPlan(
    missing: readonly Item[],
    at: Tile,
    item: (id: number) => { debugname: string; name: string; cost: number } | undefined,
    seller: (debugname: string, at: Tile) => { npc: string; npcId: number; tile: Tile } | null,
    alts: (debugname: string, at: Tile) => { npc: string; npcId: number; tile: Tile }[] = () => [],
) {
    const buys: Buy[] = [];
    const unsold: Item[] = [];
    let coins = 0;
    for (const m of missing) {
        const it = item(m.id);
        const s = it && m.id !== COINS ? seller(it.debugname, at) : null;
        if (!it || !s) {
            unsold.push(m);
            continue;
        }
        buys.push({
            id: m.id,
            count: m.count,
            name: it.name,
            npcId: s.npcId,
            npc: s.npc,
            tile: s.tile,
            alts: alts(it.debugname, at)
                .filter((a) => a.npcId !== s.npcId || a.tile.x !== s.tile.x || a.tile.z !== s.tile.z)
                .slice(0, 8),
        });
        coins += 3 * Math.max(1, it.cost) * m.count;
    }
    return { buys, unsold, coins: buys.length ? coins + 100 : 0 };
}

export function detour(stops: readonly Tile[], t: Tile): number {
    if (stops.length < 2) return stops.length ? travelDistance(stops[0]!, t) : 0;
    let best = Infinity;
    for (let i = 1; i < stops.length; i++) {
        best = Math.min(best, travelDistance(stops[i - 1]!, t) + travelDistance(t, stops[i]!) - travelDistance(stops[i - 1]!, stops[i]!));
    }
    return best;
}

export function tourOrder(from: Tile, stops: readonly Tile[]): Tile[] {
    const out: Tile[] = [];
    const left = stops.slice();
    let at = from;
    while (left.length) {
        let bestIdx = 0;
        let bestDist = travelDistance(at, left[0]!);
        for (let i = 1; i < left.length; i++) {
            const d = travelDistance(at, left[i]!);
            if (d < bestDist) {
                bestDist = d;
                bestIdx = i;
            }
        }
        const next = left[bestIdx]!;
        left[bestIdx] = left[left.length - 1]!;
        left.pop();
        out.push(next);
        at = next;
    }
    return out;
}

export function pickInstead(
    buys: readonly Buy[],
    from: Tile,
    end: Tile,
    fields: (id: number, at: Tile) => Tile[] = (id, at) => locsByDistance(PICK_SOURCES[id]!.loc, at),
): { buys: Buy[]; picks: { id: number; count: number; field: Tile; detours: { field: number; seller: number } }[] } {
    const picks: { id: number; count: number; field: Tile; detours: { field: number; seller: number } }[] = [];
    let left = [...buys];
    for (const b of buys) {
        if (!PICK_SOURCES[b.id]) continue;
        const stops = [
            from,
            ...tourOrder(
                from,
                left.filter((o) => o !== b).map((o) => o.tile),
            ),
            end,
        ];
        const field = stops
            .map((a) => fields(b.id, a)[0])
            .filter((t): t is Tile => !!t)
            .sort((a, c) => detour(stops, a) - detour(stops, c))[0];
        if (!field) continue;
        const detours = { field: detour(stops, field), seller: detour(stops, b.tile) };
        if (detours.field < detours.seller) {
            picks.push({ id: b.id, count: b.count, field, detours });
            left = left.filter((o) => o !== b);
        }
    }
    return { buys: left, picks };
}

export function runeInventoryAccount(
    acct: Account,
    bank: readonly Item[],
    nameOf: (id: number) => string | undefined,
): Account | null {
    const counts: Record<string, number> = { ...(acct.counts ?? {}) };
    const items = new Set(acct.items);
    for (const b of bank) {
        const n = nameOf(b.id);
        if (!n || !/rune$/.test(n) || b.count <= 0) continue;
        counts[n] = (counts[n] ?? 0) + b.count;
        items.add(n);
    }
    return (counts.lawrune ?? 0) > 0 ? { ...acct, items: [...items], counts } : null;
}

export function extractSpellRunes(legs: readonly Leg[], idOf: (name: string) => number | undefined): Item[] {
    const out: Item[] = [];
    for (const l of legs) {
        if (l.kind === 'travel' && l.travel.kind === 'spell') {
            for (const r of l.travel.runes) {
                const id = idOf(r.item);
                if (id === undefined) continue;
                const o = out.find((x) => x.id === id);
                if (o) o.count += r.count;
                else out.push({ id, count: r.count });
            }
        }
    }
    return out;
}

export function teleportRunes(
    route: (acct: Account) => ReturnType<World['route']>,
    acct: Account,
    bank: readonly Item[],
    nameOf: (id: number) => string | undefined,
    idOf: (name: string) => number | undefined,
): Item[] {
    const withRunes = runeInventoryAccount(acct, bank, nameOf);
    if (!withRunes) return [];
    const plan = route(withRunes);
    return plan.ok ? extractSpellRunes(plan.legs, idOf) : [];
}

type CatalogItem = { id: number; debugname: string; name: string; cost: number; tradeable?: boolean };
let itemsCache: { byDebug: Map<string, number>; byId: Map<number, CatalogItem> } | undefined;

function loadItems() {
    if (itemsCache) return itemsCache;
    const rows = JSON.parse(readFileSync(resolve(REPO_ROOT, 'knowledge/items.json'), 'utf8')) as CatalogItem[];
    const byDebug = new Map<string, number>();
    const byId = new Map<number, CatalogItem>();
    for (const i of rows) {
        byDebug.set(i.debugname, i.id);
        byId.set(i.id, i);
    }
    return (itemsCache = { byDebug, byId });
}

export const itemIdOf = (debugname: string) => loadItems().byDebug.get(debugname);
export const catalogItem = (id: number) => loadItems().byId.get(id);

type GatherArgs = Parameters<typeof gatherPlan>;
export function questGatherPlan(
    quest: string,
    missing: readonly Item[],
    at: Tile,
    seller: (id: number) => number,
    ...rest: [GatherArgs[4]?, GatherArgs[5]?, GatherArgs[6]?, GatherArgs[7]?, GatherArgs[8]?, GatherArgs[9]?]
) {
    return gatherPlan(
        missing,
        at,
        (id, tile) => ((quest === 'hunt' && id === 1005) || WORN_KIT[quest]?.some((i) => i.required && i.id === id) ? [] : spawnsByDistance(id, tile)),
        seller,
        ...rest,
    );
}

export const MAGIC_GUILD = {
    magic: 66,
    doors: [
        { x: 2584, z: 3087, level: 0 },
        { x: 2597, z: 3087, level: 0 },
    ] as Tile[],
    locs: [1600, 1601],
} as const;

export const inMagicGuild = (t: Tile) => t.x >= 2585 && t.x <= 2596 && t.z >= 3082 && t.z <= 3093;

export function magicGuildApproach(to: Tile, at: Tile, magic: number): { door?: Tile; refused?: string } {
    if (!inMagicGuild(to) || inMagicGuild(at)) return {};
    if (magic < MAGIC_GUILD.magic) return { refused: `Magic Guild entry needs Magic ${MAGIC_GUILD.magic}, have ${magic}` };
    return { door: [...MAGIC_GUILD.doors].sort((a, b) => cheb(at, a) - cheb(at, b))[0]! };
}

export function generalStores(
    at: Tile,
    sellers = shopSellers(),
): { npcId: number; npc: string; tile: Tile }[] {
    const seen = new Map<string, { npcId: number; npc: string; tile: Tile }>();
    for (const list of sellers.values()) {
        for (const s of list) {
            if (s.shop.startsWith('general')) {
                for (const t of s.spawns) {
                    if (t.level === at.level) seen.set(`${s.npcId}@${t.x},${t.z}`, { npcId: s.npcId, npc: s.npc, tile: t });
                }
            }
        }
    }
    const d = (t: Tile) => Math.max(Math.abs(t.x - at.x), Math.abs(t.z - at.z));
    return [...seen.values()].sort((a, b) => d(a.tile) - d(b.tile));
}

export const questScriptId = (script: string) => String(script).replace(/^.*[\\/]/, '').replace(/\.ts$/, '');
export const returnToAmik = (quest: string, state: string) => quest === 'blackknight' && state === 'started';

const DOWN = /(climb|walk)-down/i;
type DownLoc = { distance: number; optionsWithIndex?: { text: string; opIndex: number }[] };
export function downward<L extends DownLoc>(locs: readonly L[]): { loc: L; opIndex: number } | undefined {
    let bestLoc: L | undefined;
    let bestOp: number | undefined;
    let bestDist = Infinity;
    for (let i = 0; i < locs.length; i++) {
        const l = locs[i]!;
        if (l.distance >= bestDist || !l.optionsWithIndex) continue;
        for (let o = 0; o < l.optionsWithIndex.length; o++) {
            const opt = l.optionsWithIndex[o]!;
            if (DOWN.test(opt.text)) {
                bestDist = l.distance;
                bestLoc = l;
                bestOp = opt.opIndex;
                break;
            }
        }
    }
    return bestLoc && bestOp !== undefined ? { loc: bestLoc, opIndex: bestOp } : undefined;
}

export const FLUFFS_FENCE = { id: 2618, x: 3305, z: 3493 };
type YardPos = { worldX: number; worldZ: number; level: number };
export const inLumberYard = (p?: YardPos | null) =>
    !!p && p.level >= 0 && p.level <= 1 && p.worldX >= 3293 && p.worldX <= 3313 && p.worldZ >= FLUFFS_FENCE.z && p.worldZ <= 3517;
export const fluffsKittenGiven = (journal: string | undefined, pack: readonly { id: number }[], p?: YardPos | null) =>
    journal === 'started' && inLumberYard(p) && !pack.some((i) => i.id === 1927 || i.id === 1552 || i.id === 1554);
export const fluffsExit = (castable: boolean, p?: YardPos | null): 'teleport' | 'fence' =>
    !castable && inLumberYard(p) ? 'fence' : 'teleport';

export { rSellersByDistance };
function rSellersByDistance() {
    return sellersByDistance;
}
