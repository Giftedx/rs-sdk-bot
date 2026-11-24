import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { knownBanks } from '../../../core/src/trip';
import type { ShopProfile } from './types';

export type { ShopProfile };

export const DATA_PROFILE = 'data:';
export const DATA_BANK_RANGE = 120;
export const HAND_ONLY_SHOPS: readonly string[] = ['dragonswordshop'];

const KNOWLEDGE_ROOT = resolve(import.meta.dir, '../../../../knowledge');
const read = <T>(f: string) => JSON.parse(readFileSync(resolve(KNOWLEDGE_ROOT, f), 'utf8')) as T;

let cache:
    | {
          shops: Map<string, string[]>;
          npcs: Map<string, string>;
          items: Map<string, string>;
          spawns: Map<string, { npc: string; x: number; z: number; level: number }[]>;
      }
    | undefined;

function load() {
    if (cache) return cache;
    const shops = new Map(read<{ inv: string; stock: { item: string }[] }[]>('shops.json').map(s => [s.inv, s.stock.map(i => i.item)]));
    const npcs = new Map(read<{ name: string; debugname: string }[]>('npcs.json').map(n => [n.debugname, n.name]));
    const items = new Map<string, string>();
    for (const i of read<{ name?: string; debugname?: string }[]>('items.json')) {
        if (i.debugname && i.name) items.set(i.debugname, i.name);
    }
    const spawns = new Map<string, { npc: string; x: number; z: number; level: number }[]>();
    for (const n of read<{ shopNpcs: { shop: string; npc: string; spawns: { x: number; z: number; level: number }[] }[] }>('gear-sources.json').shopNpcs) {
        let list = spawns.get(n.shop);
        if (!list) {
            list = [];
            spawns.set(n.shop, list);
        }
        for (const s of n.spawns) list.push({ npc: n.npc, ...s });
    }
    return (cache = { shops, npcs, items, spawns });
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cheb = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
const derivedProfileCache = new Map<string, ShopProfile | null>();

export function derivedProfile(shop: string): ShopProfile | undefined {
    const hit = derivedProfileCache.get(shop);
    if (hit !== undefined) {
        return hit
            ? { ...hit, npcSpot: { ...hit.npcSpot }, bankSpot: { ...hit.bankSpot }, items: hit.items.slice() }
            : undefined;
    }
    if (HAND_ONLY_SHOPS.includes(shop)) {
        derivedProfileCache.set(shop, null);
        return undefined;
    }
    const t = load();
    const stock = t.shops.get(shop);
    const at = t.spawns.get(shop)?.find(s => s.level === 0);
    const name = at && t.npcs.get(at.npc);
    if (!stock?.length || !at || !name) {
        derivedProfileCache.set(shop, null);
        return undefined;
    }
    let bestBank: { x: number; z: number } | undefined;
    let bestDist = Infinity;
    for (const b of knownBanks()) {
        if (b.level !== 0) continue;
        const d = cheb(b, at);
        if (d < bestDist) {
            bestDist = d;
            bestBank = b;
        }
    }
    if (!bestBank || bestDist > DATA_BANK_RANGE) {
        derivedProfileCache.set(shop, null);
        return undefined;
    }
    const seen = new Set<string>();
    const items: ShopProfile['items'] = [];
    for (const itemKey of stock) {
        const itemName = t.items.get(itemKey);
        if (itemName && !seen.has(itemName)) {
            seen.add(itemName);
            items.push({ re: new RegExp(`^${escapeRe(itemName)}$`, 'i'), buyPerTick: 1 });
        }
    }
    if (!items.length) {
        derivedProfileCache.set(shop, null);
        return undefined;
    }
    const profile: ShopProfile = {
        npc: new RegExp(`^${escapeRe(name)}$`, 'i'),
        npcSpot: { x: at.x, z: at.z },
        bankSpot: { x: bestBank.x, z: bestBank.z },
        items,
    };
    derivedProfileCache.set(shop, profile);
    return { ...profile, npcSpot: { ...profile.npcSpot }, bankSpot: { ...profile.bankSpot }, items: profile.items.slice() };
}

export function dataProfile(key: string): ShopProfile | undefined {
    return key.startsWith(DATA_PROFILE) ? derivedProfile(key.slice(DATA_PROFILE.length)) : undefined;
}

export const dataKey = (shop: string) => DATA_PROFILE + shop;
