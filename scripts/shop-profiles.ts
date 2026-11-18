// Shop-buyer profiles from the content: a shop in knowledge/shops.json gets a profile with no hand entry.
//   shop id and stock   knowledge/shops.json (inv, stock item debugnames, items.json names)
//   NPC and tile        knowledge/gear-sources.json shopNpcs (the NPC debugname and its spawns), name from knowledge/npcs.json
//   bank                the nearest of the known banks (packages/planner/src/haggis-travel.json) on the same level, within DATA_BANK_RANGE tiles
// The key of a profile is `data:<shop id>`. A hand profile in scripts/shop-buyer.ts PROFILES wins where a shop needs a step that the
// content does not say: `jukat` (Zanaris: Dramen staff, a cut diamond for the doorman, the ladder out).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PROFILES } from './shop-buyer';
import { knownBanks } from '../packages/core/src/trip';

export type ShopProfile = (typeof PROFILES)[string];
export const DATA_PROFILE = 'data:';
/** The farthest bank, in tiles, that a derived profile walks to. Farther shops keep to a hand profile. */
export const DATA_BANK_RANGE = 120;
/** The hand profiles that a shop with a special step keeps, by the shop id they serve. */
export const HAND_ONLY_SHOPS: readonly string[] = ['dragonswordshop'];

const root = resolve(import.meta.dir, '..', 'knowledge');
const read = <T>(f: string) => JSON.parse(readFileSync(resolve(root, f), 'utf8')) as T;
let cache: { shops: Map<string, string[]>; npcs: Map<string, string>; items: Map<string, string>; spawns: Map<string, { npc: string; x: number; z: number; level: number }[]> } | undefined;
function load() {
    if (cache) return cache;
    const shops = new Map(read<{ inv: string; stock: { item: string }[] }[]>('shops.json').map(s => [s.inv, s.stock.map(i => i.item)]));
    const npcs = new Map(read<{ name: string; debugname: string }[]>('npcs.json').map(n => [n.debugname, n.name]));
    const items = new Map(read<{ name?: string; debugname?: string }[]>('items.json').flatMap(i => i.debugname && i.name ? [[i.debugname, i.name] as [string, string]] : []));
    const spawns = new Map<string, { npc: string; x: number; z: number; level: number }[]>();
    for (const n of read<{ shopNpcs: { shop: string; npc: string; spawns: { x: number; z: number; level: number }[] }[] }>('gear-sources.json').shopNpcs)
        spawns.set(n.shop, [...(spawns.get(n.shop) ?? []), ...n.spawns.map(s => ({ npc: n.npc, ...s }))]);
    return cache = { shops, npcs, items, spawns };
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cheb = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

/** The profile of a shop id, or undefined when the content names no NPC at ground level, no stock, or no bank in range. */
export function derivedProfile(shop: string): ShopProfile | undefined {
    if (HAND_ONLY_SHOPS.includes(shop)) return undefined;
    const t = load(), stock = t.shops.get(shop), at = t.spawns.get(shop)?.find(s => s.level === 0);
    const name = at && t.npcs.get(at.npc);
    if (!stock?.length || !at || !name) return undefined;
    const bank = knownBanks().filter(b => b.level === 0).map(b => ({ b, d: cheb(b, at) })).sort((x, y) => x.d - y.d)[0];
    if (!bank || bank.d > DATA_BANK_RANGE) return undefined;
    const names = [...new Set(stock.flatMap(i => t.items.get(i) ?? []))];
    if (!names.length) return undefined;
    return { npc: new RegExp(`^${escape(name)}$`, 'i'), npcSpot: { x: at.x, z: at.z }, bankSpot: { x: bank.b.x, z: bank.b.z },
        items: names.map(n => ({ re: new RegExp(`^${escape(n)}$`, 'i'), buyPerTick: 1 })) };
}
/** The profile of a `data:<shop>` key. */
export function dataProfile(key: string): ShopProfile | undefined {
    return key.startsWith(DATA_PROFILE) ? derivedProfile(key.slice(DATA_PROFILE.length)) : undefined;
}
export const dataKey = (shop: string) => DATA_PROFILE + shop;
