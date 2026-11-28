import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { offMap } from '../../../core/src/shop-index';
import { knownBanks } from '../../../core/src/trip';
import type { ShopProfile } from './types';

export type { ShopProfile };

export const DATA_PROFILE = 'data:';
export const DATA_BANK_RANGE = 120;
export const HAND_ONLY_SHOPS: readonly string[] = ['dragonswordshop'];
// Shops whose seller stands behind a skill door (knowledge/doors.json kind "skill"). The derived profile carries the
// door's level as `need`, so shop-buy refuses at entry instead of walking to a door it cannot open.
export const SKILL_DOOR_SHOPS: Readonly<Record<string, { skill: string; level: number }>> = {
    fishingguild: { skill: 'Fishing', level: 68 },
    ranging_guild_bowshop: { skill: 'Ranged', level: 40 },
    ranging_guild_armourshop: { skill: 'Ranged', level: 40 },
    ranging_guild_tribalshop: { skill: 'Ranged', level: 40 },
};

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
    const neededItems = new Set<string>();
    for (const stock of shops.values()) for (const item of stock) neededItems.add(item);
    const spawns = new Map<string, { npc: string; x: number; z: number; level: number }[]>();
    const neededNpcs = new Set<string>();
    for (const n of read<{ shopNpcs: { shop: string; npc: string; spawns: { x: number; z: number; level: number }[] }[] }>('gear-sources.json').shopNpcs) {
        neededNpcs.add(n.npc);
        let list = spawns.get(n.shop);
        if (!list) {
            list = [];
            spawns.set(n.shop, list);
        }
        for (const s of n.spawns) list.push({ npc: n.npc, ...s });
    }
    const npcs = new Map<string, string>();
    for (const n of read<{ name: string; debugname: string }[]>('npcs.json')) {
        if (neededNpcs.has(n.debugname)) npcs.set(n.debugname, n.name);
    }
    const items = new Map<string, string>();
    for (const i of read<{ name?: string; debugname?: string }[]>('items.json')) {
        if (i.debugname && i.name && neededItems.has(i.debugname)) items.set(i.debugname, i.name);
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
    // A seller off the walker's map (Entrana: shop-index offMap) has no route, so it gives no profile; a shop with a
    // seller elsewhere is bought there.
    const at = t.spawns.get(shop)?.find(s => s.level === 0 && !offMap(s));
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
        ...(SKILL_DOOR_SHOPS[shop] ? { need: { ...SKILL_DOOR_SHOPS[shop] } } : {}),
    };
    derivedProfileCache.set(shop, profile);
    return { ...profile, npcSpot: { ...profile.npcSpot }, bankSpot: { ...profile.bankSpot }, items: profile.items.slice() };
}

export function dataProfile(key: string): ShopProfile | undefined {
    return key.startsWith(DATA_PROFILE) ? derivedProfile(key.slice(DATA_PROFILE.length)) : undefined;
}

export const dataKey = (shop: string) => DATA_PROFILE + shop;
