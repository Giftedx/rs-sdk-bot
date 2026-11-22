// Price caps, item food healing, shop value table, unit/job valuation, and pilot admission share.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BillRow } from '../../supply-bill';
import { cowFoodIds, foodTotalHeal } from '../../../../core/src/sustain';
import { QUEST_DEMAND_ROWS, norm, type Acct, type Inputs, type Template } from '../world';
import { billUnits } from './feeds';

// Unit price caps for kit buys, in coins. Estimates: the owner's hand jobs cap a law rune at 1,600 (shop value 40) and
// a shark at 810 to 1,200 (shop value 300), so a rune caps at about 40 times and food at about 4 times its shop value.
// An offer fills at or under its cap, and scripts/buy-owned-ge-item.ts refunds what does not fill. Gap: no measured
// Grand Exchange price for these items.
export const KIT_PRICE_CAPS: Readonly<Record<string, number>> = {
    'mind rune': 120, 'air rune': 160, 'fire rune': 160, 'nature rune': 800, feather: 20,
    // Live claude-cloud read: body runes 1,460 listed from 184 (bids at 38), earth runes 27,408 from 92 (bids at 39).
    'body rune': 200, 'earth rune': 110,
    // Water runes: 310 listed from 78 in the same read, and Aubury's shelf read 0 on three visits, so the kit buy
    // takes what the market lists and the shop job (army-water-aubury) is the way when a buy gets none.
    'water rune': 110,
    'bronze arrow': 20, 'iron arrow': 40, 'steel arrow': 100, 'mithril arrow': 200, 'adamant arrow': 400, 'rune arrow': 1200,
    trout: 100, lobster: 500, swordfish: 700, shark: 1200,
    // Live claude-cloud read: 42 listed at 72,000, bids at 33,068, volume-weighted price 38,089.
    'adamant scimitar': 80_000,
    'rune scimitar': 50_000, 'rune longsword': 45_000, 'dragon dagger': 50_000, 'dragon longsword': 120_000,
    shortbow: 500, 'oak shortbow': 800, 'willow shortbow': 2_500, 'maple shortbow': 5_000, 'yew shortbow': 15_000,
    coif: 1_000, 'studded body': 2_500, 'studded chap': 2_000,
    'dragonhide body': 15_000, 'dragonhide chap': 8_000, 'dragon vambrace': 6_000,
    'adamant full helm': 8_000, 'adamant plateleg': 15_000, 'adamant platebody': 25_000,
    'rune full helm': 45_000, 'rune kiteshield': 65_000, 'rune plateleg': 75_000, 'rune plateskirt': 75_000, 'rune chainbody': 60_000, 'rune platebody': 80_000,
    // Lumber & mining skilling tools (Bob's Axes in Lumbridge lacks mithril+ axes and has no shop profile).
    'steel axe': 1_500, 'mithril axe': 4_000, 'adamant axe': 10_000, 'rune axe': 25_000,
    'adamant pickaxe': 6_000, 'rune pickaxe': 40_000,
    // The hunters' kit (army-hunt-black-dragons). Live claude-cloud: 5 law runes for 5,260 coins and 7 sharks for 7,189;
    // magic shortbows 108 listed from 51,000.
    'law rune': 1_600, 'magic shortbow': 60_000,
    // The Zanaris market door's tax (army-jakut-swords). Live claude-cloud read: 1,219 listed from 145,000.
    diamond: 150_000,
    // Live claude-cloud read: dragon bones 1,009 listed from 9,000 (mean 9,687); big bones 1,686 from 2,399 (mean 2,526).
    'dragon bone': 10_000, 'big bone': 2_600,
    // The two prayer potions of Lost City for a Defence 1 build (LOST_CITY_BUILD). No shop sells them and the bank
    // snapshots of the sides hold none. Live read: 38 listed from 250,000, bids at 25,000.
    'prayer potion(4)': 260_000,
    // The coal of Regicide's still (REGICIDE_PACK). Live read: 17,157 listed from 499, bids at 104, volume-weighted
    // price 586.
    coal: 600,
};

// Only a finite consumer gives an output value. Shop prices compare needed supplies; an unpriced needed item keeps
// a value of one so missing price data cannot turn a route requirement into surplus.
const BILL_PREMIUM = 2;
export const TRAIN_SHARE = 0.25;
// scripts/autopilot.ts plans every ten minutes: 1,000 game ticks at 600 ms per tick. This is an output estimate,
// not a claim that a worker stops at this bound; the next pass reads its actual holdings.
export const VALUE_TICKS = 1000;
// A production pilot that the `aio` list does not name ranks at this share of its worth (Inputs.pilotFallback).
export const PILOT_FALLBACK_SHARE = 0.05;
// A pilot that makes or gathers a bill item for the route or the army kit and needs no quest, band or combat: the AIO skiller
// routes (mining, woodcutting, smelting, smithing, fletching, crafting, runecraft, cooking, fishing) and the maker chains.
export const selfServePilot = (t: Template): boolean => !!t.pilot && !t.tier && !t.quest && !t.once && !t.buildOnly && !t.trains && !t.provides
    && (!!t.production || !!t.aio?.startsWith('skiller:'));

type KnowledgeItemRow = { id: number; name: string; debugname?: string; cost: number; tradeable?: boolean };
const itemsJson = JSON.parse(readFileSync(resolve(import.meta.dir, '../../../../../knowledge/items.json'), 'utf8')) as KnowledgeItemRow[];
// HP one held item heals over all its bites, by item name. The content gives it (consume_normal.dbrow heal of each
// bite, cooking_inv next_obj_stage for the bites), for the cow farm's food of core/sustain.ts cowFoodIds.
const itemNames = new Map(itemsJson.map(i => [i.id, i.name]));
export const FOOD_HEAL: Readonly<Record<string, number>> = Object.fromEntries(cowFoodIds().map(id => [norm(itemNames.get(id)!), foodTotalHeal(id)!]));
export const foodHeal = (a: Acct) => Object.entries(FOOD_HEAL).reduce((n, [item, hp]) => n + (a.items[item] ?? 0) * hp, 0);

// The price caps of the quest packs' items that the Grand Exchange can sell and KIT_PRICE_CAPS does not list: four times the item's base
// value (knowledge/items.json `cost`), at least QUEST_CAP_MIN coins. The cap bounds each buy; the market read (packages/planner kitMarket,
// scripts/autopilot.ts) drops an item whose lowest ask is over it. Added to KIT_PRICE_CAPS once, here, after the table that names the items.
export const QUEST_CAP_FACTOR = 4, QUEST_CAP_MIN = 25;
const coinItem = (item: string) => item === 'coin';
export function questKitCaps(rows: readonly { items: Readonly<Record<string, number>> }[] = QUEST_DEMAND_ROWS): Record<string, number> {
    const content = new Map(itemsJson.filter(i => !/^cert_/.test(i.debugname ?? '')).map(i => [norm(i.name), i] as const).reverse());
    const out: Record<string, number> = {};
    for (const row of rows) for (const item of Object.keys(row.items)) {
        const found = content.get(norm(item));
        if (found?.tradeable && found.cost > 0 && !(norm(item) in KIT_PRICE_CAPS) && coinItem(norm(item)) === false) out[norm(item)] = Math.max(QUEST_CAP_MIN, QUEST_CAP_FACTOR * found.cost);
    }
    return out;
}
for (const [item, cap] of Object.entries(questKitCaps())) (KIT_PRICE_CAPS as Record<string, number>)[item] ??= cap;

export function unitValue(item: string, bill: readonly BillRow[], prices: Readonly<Record<string, number>>, coin = 1): number {
    const k = norm(item);
    if (billUnits(k, bill) <= 0) return 0;
    return k === 'coin' ? coin : Math.max(1, prices[k] ?? 0) * BILL_PREMIUM;
}
// The shop values that unitValue reads, by norm() name: the cost of the first item with each name. A bill line whose
// name is no item's name takes the highest cost of the item ids of the line (supply-bill.ts idsFor): every unfinished
// potion is the item "Unfinished potion", and the line "mort myre fungus" is the item "Mort myre fungi". Without the
// entry a maker of such a line has no value.
const PRICE_EXACT_ALIAS_IDS: readonly (readonly [number, string])[] = [
    [1747, 'dragonhide_black'],
    [2509, 'dragon_leather_black'],
    [2503, 'black_dragonhide_body'],
    [2497, 'black_dragonhide_chaps'],
    [2491, 'black_dragon_vambraces'],
    [985, 'keyhalf1'],
    [987, 'keyhalf2'],
    [1683, 'unstrung dragonstone amulet'],
    [1702, 'strung dragonstone amulet'],
];
export function priceTable(items: readonly { id: number; name?: string; debugname?: string; cost?: number }[], bill: readonly BillRow[]): Record<string, number> {
    const prices: Record<string, number> = {}, cost = new Map(items.map(i => [i.id, i.cost ?? 0]));
    for (const i of items) if (typeof i.name === 'string' && !/^cert_/.test(i.debugname ?? '') && !(norm(i.name) in prices)) prices[norm(i.name)] = i.cost ?? 0;
    for (const [id, alias] of PRICE_EXACT_ALIAS_IDS) if (cost.has(id)) {
        const c = cost.get(id)!;
        if (!(alias in prices)) prices[alias] = c;
        if (!(norm(alias) in prices)) prices[norm(alias)] = c;
    }
    for (const r of bill) for (const name of [r.item, ...(r.aliases ?? [])])
        if (r.ids.length && !(norm(name) in prices)) prices[norm(name)] = Math.max(...r.ids.map(id => cost.get(id) ?? 0));
    if ('crystal key' in prices) prices['crystal key'] = Math.max(prices['crystal key']!, 500);
    if ('keyhalf1' in prices) prices.keyhalf1 = Math.max(prices.keyhalf1!, 250);
    if ('keyhalf2' in prices) prices.keyhalf2 = Math.max(prices.keyhalf2!, 250);
    return prices;
}

export function jobValue(t: Template, a: Acct, inp: Pick<Inputs, 'bill' | 'prices' | 'waste' | 'coinValue'>,
    needed: (item: string) => number = item => billUnits(norm(item), inp.bill)): number {
    const coin = inp.coinValue ?? 1;
    const flows = t.yields(a).filter(f => f.perTick > 0);
    const work = Math.min(VALUE_TICKS, Math.max(0, ...flows.map(f => needed(norm(f.item)) / f.perTick)));
    const gross = flows.reduce((v, f) => v + Math.min(f.perTick * work, needed(norm(f.item))) * unitValue(f.item, inp.bill, inp.prices, coin), 0) / VALUE_TICKS;
    const cost = (t.spends?.(a) ?? []).reduce((v, f) => v + f.perTick * (norm(f.item) === 'coin' ? coin : (inp.prices[norm(f.item)] ?? 0)), 0);
    return (gross - cost * work / VALUE_TICKS) * Math.max(0.1, 1 - (inp.waste?.[t.family] ?? 0));
}
