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
    const items = new Map(
        read<{ name?: string; debugname?: string }[]>('items.json').flatMap(i => (i.debugname && i.name ? [[i.debugname, i.name] as [string, string]] : [])),
    );
    const spawns = new Map<string, { npc: string; x: number; z: number; level: number }[]>();
    for (const n of read<{ shopNpcs: { shop: string; npc: string; spawns: { x: number; z: number; level: number }[] }[] }>('gear-sources.json').shopNpcs) {
        spawns.set(n.shop, [...(spawns.get(n.shop) ?? []), ...n.spawns.map(s => ({ npc: n.npc, ...s }))]);
    }
    return (cache = { shops, npcs, items, spawns });
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cheb = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

export function derivedProfile(shop: string): ShopProfile | undefined {
    if (HAND_ONLY_SHOPS.includes(shop)) return undefined;
    const t = load();
    const stock = t.shops.get(shop);
    const at = t.spawns.get(shop)?.find(s => s.level === 0);
    const name = at && t.npcs.get(at.npc);
    if (!stock?.length || !at || !name) return undefined;
    const bank = knownBanks().filter(b => b.level === 0).map(b => ({ b, d: cheb(b, at) })).sort((x, y) => x.d - y.d)[0];
    if (!bank || bank.d > DATA_BANK_RANGE) return undefined;
    const names = [...new Set(stock.flatMap(i => t.items.get(i) ?? []))];
    if (!names.length) return undefined;
    return {
        npc: new RegExp(`^${escapeRe(name)}$`, 'i'),
        npcSpot: { x: at.x, z: at.z },
        bankSpot: { x: bank.b.x, z: bank.b.z },
        items: names.map(n => ({ re: new RegExp(`^${escapeRe(n)}$`, 'i'), buyPerTick: 1 })),
    };
}

export function dataProfile(key: string): ShopProfile | undefined {
    return key.startsWith(DATA_PROFILE) ? derivedProfile(key.slice(DATA_PROFILE.length)) : undefined;
}

export const dataKey = (shop: string) => DATA_PROFILE + shop;
