import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listConfigFiles, parseConfigs, type ConfigBlock } from '../config';
import type { Rate } from '../ladders';
import { contentRoot } from '../paths';

export const repoRoot = resolve(import.meta.dir, '..', '..', '..', '..');

// rates.ts:11 and rates.json measure XP per tick at the server's 25x; ladder xpPerAction is base content XP.
export const XP_RATE = 25;
// research/supply-costs.md:20: the live server ticks every 400 ms.
export const LIVE_TICK_SECONDS = 0.4;
// rates.json craft_air_runes_trade_loop evidence: a helper trade of one pack takes 12 ticks (scripts/measure/trade-supply.ts).
export const TRADE_TICKS = 12;
export const PACK_SLOTS = 28;
// The shop buy button takes at most 10 per click (shop.rs2 inv_button4 buys 10); one click per tick is a model.
export const SHOP_UNITS_PER_TICK = 10;
export const DELTA_DEFAULT = 10;
// Wilderness bounds (x 2944-3391, z 3520-3967, level 0): a model of where death drops items to other players.
export const inWilderness = (t: { x: number; z: number }): boolean => t.x >= 2944 && t.x < 3392 && t.z >= 3520 && t.z < 3968;
export const GATHER_KINDS = new Set(['woodcutting_trees', 'mining_table', 'catch', 'pickpocket', 'stealing', 'trapped_chest']);

export type Basis = 'content' | 'model' | 'measured' | 'unknown';
export interface Cost {
    helperTicksPerUnit: number | null; ticksBasis: Basis; ticksNote: string;
    coinsPerUnit: number | null; coinsBasis: Basis; coinsNote: string;
    risk: number | null; riskBasis: Basis; riskNote: string;
    realSecondsPerUnit: number | null; realBasis: Basis; realNote: string;
}
export interface Tile { x: number; z: number; level: number }
// Map pins and nearest-place suggestions need every location, with one pin per tile even when spawns overlap.
export const sourceTiles = (spawns: readonly Tile[]): Tile[] => [...new Map(spawns.map(({ x, z, level }) =>
    [`${x},${z},${level}`, { x, z, level }])).values()];
export interface Place { npc?: string; loc?: string; spawns: number; tiles: Tile[]; src: string | null; wilderness: boolean }
interface Base { kind: string; src: string; blocked: string | null; gate: string | null; cost: Cost }
export interface GatherSource extends Base { kind: 'gather'; rung: string; skill: string; level: number; tools: string[][]; bait: string[]; places: Place[]; yieldPerAction: number | null; respawnTicks: number | null; respawnSrc: string | null; successChance: { low: number; high: number; src: string } | null }
export interface PickupSource extends Base { kind: 'pickup'; spawns: number; countPerSpawn: number; tiles: Tile[]; wilderness: boolean }
export interface ShopSource extends Base { kind: 'shop'; shop: string; owners: Place[]; basePrice: number; priceAtFullStock: number; stock: number; restockTicks: number | null; sellMultiplier: number; sellMultiplierSrc: string; delta: number }
export interface DropSource extends Base { kind: 'drop'; npc: string; combat: number | null; chance: number; countMin: number; countMax: number; conditional: boolean; condition: string | null; via: string | null; places: Place[] }
export interface ActionSource extends Base { kind: 'action'; trigger: string; subject: string; places: Place[] }
export interface MakeSource extends Base { kind: 'make'; rung: string | null; skill: string; level: number; inputs: { item: string; count: number | null }[]; outputs: string[]; tools: string[][] }
export interface GeSource extends Base { kind: 'ge'; at: string; ask: number | null; bid: number | null; sellers: number }
export interface OwnedSource extends Base { kind: 'owned'; at: string | null; total: number; holders: { account: string; count: number; side: string; at: string | null }[] }
export type Source = GatherSource | PickupSource | ShopSource | DropSource | ActionSource | MakeSource | GeSource | OwnedSource;
export interface Substitute { group: string; items: string[]; note: string; src: string }
export interface ItemSources {
    item: string; id: number | null; name: string | null; cost: number | null; members: boolean | null; tradeable: boolean | null; stackable: boolean;
    neededBy: string[]; substitutes: Substitute[];
    delivery: { scoredTicksPerTrade: number; helperTicksPerTrade: number; unitsPerTrade: number | null; basis: Basis; note: string };
    sources: Source[]; usable: number; blocked: boolean;
}
export interface Rung {
    id: string; skill: string; level: number; kind: string; src: string; xpPerAction: number | null; xpPerTick: number | null; ticksPerAction?: number | null; timing?: { basis?: string } | null;
    measuredRate?: Rate;
    inputs: { debugname: string; count: number | null }[]; outputs: { debugname: string; count: number | null }[]; requires: { debugname: string }[];
    where: { locs: string[]; npcs: string[] } | null; quest: { name: string } | null; members: boolean | null;
}
export interface ToolRec { id: string; skill: string; appliesTo: { kinds: string[]; rungs: string[] }; items: { anyOf: string[]; role: string; src: string }[]; option?: { spot: string } }

export interface MarketQuoteInput { ask: number | null; bid: number | null; sell: number }
export type SharedMarketParser = (raw: unknown, now: number) => Record<number, MarketQuoteInput>;
export interface OwnedStatusRow { name: string; side: string; at?: unknown; bankAt?: unknown; inventory?: unknown; equipment?: unknown; bank?: unknown }
export interface OwnedAccountStock { name: string; side: string; items: Map<number, number>; itemAt: Map<number, string | null> }
export interface OwnedStock { at: string | null; accounts: OwnedAccountStock[] }
export interface Market { at: string; file: string; prices: Record<string, { ask: number | null; bid: number | null; sell: number; at?: string; file?: string }> }
export interface Options { market?: Market | null; owned?: OwnedStock | null }

export const read = (rel: string): string => readFileSync(join(contentRoot(), rel), 'utf8');
export const json = (file: string): any => JSON.parse(readFileSync(file, 'utf8'));
export const blocksOf = (ext: string): ConfigBlock[] => listConfigFiles(ext).flatMap(f => parseConfigs(read(f), f));
export const r3 = (n: number): number => Math.round(n * 1000) / 1000;

export const cost = (c: Partial<Cost>): Cost => ({
    helperTicksPerUnit: null, ticksBasis: 'unknown', ticksNote: '', coinsPerUnit: null, coinsBasis: 'unknown', coinsNote: '',
    risk: null, riskBasis: 'unknown', riskNote: '', realSecondsPerUnit: null, realBasis: 'unknown', realNote: '', ...c,
});

export const oldest = (times: readonly (string | null)[]): string | null =>
    times.length && times.every(t => t !== null) ? [...times as string[]].sort()[0]! : null;

// Marginal price of buying one unit at stock `stock` of normal stock `base` (shop.rs2 calc_shop_value, price_mod).
export function shopUnitPrice(objCost: number, sell: number, delta: number, stock: number, base: number): number {
    const mod = Math.min(1000, Math.max(-5000, (stock - base) * delta));
    return Math.max(1, Math.floor((Math.max(100, sell - mod) * objCost) / 1000));
}
