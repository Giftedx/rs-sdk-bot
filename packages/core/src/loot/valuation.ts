import { MAIN_ACCOUNT } from '../haggisgate';
import { SPECIALIST_BOARDS } from '../specialist-launch';

export type Ground = { id: number; name?: string; count: number; x: number; z: number; distance: number; reachable?: boolean };
export type Held = { slot: number; id: number; name?: string; count: number };
export type ItemInfo = { name: string; debugname: string; cost: number; tradeable: boolean };
export interface LootTables {
    info(id: number): ItemInfo | undefined;
    // The GE bid for one item, 0 when the price file has none.
    bid(id: number): number;
    // True when the supply bill is short of the item: a route needs it, whatever its price.
    wanted(id: number): boolean;
}
export interface LootRules {
    // Coins of value for each tick of detour. A guess, not a measurement: about 100 times the goldfarm rate.
    perTick: number;
    // The farthest pile (Chebyshev tiles) the job walks to.
    maxDistance: number;
    // The job does not start below this share of the maximum Hitpoints.
    minHp: number;
}
export const LOOT_RULES: LootRules = { perTick: 1000, maxDistance: 15, minHp: 0.5 };

const COINS = 995;
// High alchemy pays 60% of the item cost: the value floor of a tradeable item that the GE file does not price.
const ALCH_SHARE = 0.6;
// A pile the supply bill is short of needs a tenth of the value, and an untradeable one counts at its item cost.
// A wanted pile still needs some value: a cheap bill item (feathers) would pull every bot near a chicken pen off its
// work for each feather.
const WANTED_SHARE = 10;

// The value guard (randomevents.ts `guard`): a held stack worth this much is kept from a drop or a sale.
export const GUARD_VALUE = 10_000;
// Scripts that sell, alch, trade or hand items over on purpose get no value guard.
export const sellsItems = (script: string) => /sell|alch|merchant|market|trade|banker|courier|fan(out|in)|shop|aio-logistics/i.test(script.split(/[\\/]/).at(-1) ?? '');

// A record run: the main account, a specialist board account, or any run with HAGGIS_RUN=1.
export const recordRun = (name: string, env: Record<string, string | undefined> = process.env): boolean =>
    name.toLowerCase() === MAIN_ACCOUNT || Object.hasOwn(SPECIALIST_BOARDS, name.toLowerCase()) || env.HAGGIS_RUN === '1';

// The value of one item. Coins are worth 1. Others take the GE bid or the alchemy floor, whichever is higher.
// An item that cannot be traded is worth 0: the bill (`wanted`) is its only reason to be taken.
export function unitValue(id: number, t: LootTables): number {
    if (id === COINS) return 1;
    const i = t.info(id);
    if (!i?.tradeable) return 0;
    return Math.max(t.bid(id), Math.floor(i.cost * ALCH_SHARE));
}

export const pileValue = (g: Pick<Ground, 'id' | 'count'>, t: LootTables) => unitValue(g.id, t) * g.count;

// Ticks the pickup costs the script: running there and back takes about the distance, plus a pickup and a start.
export const detourTicks = (distance: number) => distance + 2;

export function worthIt(g: Ground, t: LootTables, r: LootRules = LOOT_RULES): boolean {
    if (g.distance > r.maxDistance) return false;
    const need = r.perTick * detourTicks(g.distance);
    if (!t.wanted(g.id)) return pileValue(g, t) >= need;
    return Math.max(pileValue(g, t), (t.info(g.id)?.cost ?? 0) * g.count) * WANTED_SHARE >= need;
}
