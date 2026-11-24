// Which shopkeeper sells an item, and where they stand. A shop is an .inv with stock lines (knowledge/shops.json); an
// NPC owns it through `param=owned_shop,<inv>` in its config block (content scripts/shop/scripts/shop.rs2 opens
// npc_param(owned_shop)); knowledge/npcs.json gives the NPC's spawn tiles and config line.
import { readFileSync, statSync } from 'node:fs';
import { LEVEL_STEP } from './spawn-index';
import { join, resolve } from 'node:path';
import { writeAtomicFile } from './atomic-file';
import type { Tile } from './world';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
const content = join(repoRoot, 'vendor', 'rs-sdk', 'server', 'content');
export const DEFAULT_SHOP_CACHE = join(repoRoot, '.practice', 'cache', 'shop-sellers.json');
export type ShopSeller = { shop: string; npc: string; npcId: number; spawns: Tile[]; stock: number };

// Entrana's sellers (Frincos's herblore shop, 2808,3342) are off the sweep's map: the monks' boat from Port Sarim takes
// no weapons or armour, and the sweep's accounts carry theirs. From Ardougne Frincos was the nearest eye of newt seller
// by distance and the walk found no route.
export const ENTRANA = { minX: 2798, maxX: 2878, minZ: 3326, maxZ: 3394 };
export const offMap = (t: Tile) => t.level === 0 && t.x >= ENTRANA.minX && t.x <= ENTRANA.maxX && t.z >= ENTRANA.minZ && t.z <= ENTRANA.maxZ;
type ShopCache = { v: 1; stamps: [string, string][]; entries: [string, ShopSeller[]][] };
const fileStamp = (file: string): string => {
    try { const st = statSync(file); return `${st.size}:${st.mtimeMs}`; } catch { return 'missing'; }
};
let index: Map<string, ShopSeller[]> | undefined;
export function shopSellers(cacheFile = DEFAULT_SHOP_CACHE, shopsFile = join(repoRoot, 'knowledge/shops.json'), npcsFile = join(repoRoot, 'knowledge/npcs.json'), contentDir = content): Map<string, ShopSeller[]> {
    const isDefault = cacheFile === DEFAULT_SHOP_CACHE && shopsFile === join(repoRoot, 'knowledge/shops.json') && npcsFile === join(repoRoot, 'knowledge/npcs.json') && contentDir === content;
    if (isDefault && index) return index;
    const shopsStamp = fileStamp(shopsFile), npcsStamp = fileStamp(npcsFile);
    if (cacheFile) {
        try {
            const parsed = JSON.parse(readFileSync(cacheFile, 'utf8')) as ShopCache;
            if (parsed?.v === 1 && Array.isArray(parsed.stamps) && Array.isArray(parsed.entries)
                && parsed.stamps.length >= 2 && parsed.stamps[0]![0] === 'shops' && parsed.stamps[0]![1] === shopsStamp
                && parsed.stamps[1]![0] === 'npcs' && parsed.stamps[1]![1] === npcsStamp) {
                let fresh = true;
                for (let i = 2; i < parsed.stamps.length; i++) {
                    const [rel, stamp] = parsed.stamps[i]!;
                    if (fileStamp(join(contentDir, rel)) !== stamp) { fresh = false; break; }
                }
                if (fresh) {
                    const loaded = new Map<string, ShopSeller[]>(parsed.entries);
                    if (isDefault) index = loaded;
                    return loaded;
                }
            }
        } catch { /* cache miss */ }
    }
    const shops = JSON.parse(readFileSync(shopsFile, 'utf8')) as { inv: string; stock: { item: string; count: number }[] }[];
    const npcs = JSON.parse(readFileSync(npcsFile, 'utf8')) as { id: number; name: string; src: string; spawns?: Tile[] }[];
    const files = new Map<string, string[] | null>(), owners = new Map<string, { npc: string; npcId: number; spawns: Tile[] }[]>();
    const stamps: [string, string][] = [['shops', shopsStamp], ['npcs', npcsStamp]];
    for (const n of npcs) {
        if (!n.spawns?.length || !n.src) continue;
        const colon = n.src.lastIndexOf(':');
        if (colon < 0) continue;
        const rel = n.src.slice(0, colon), lineIdx = Number(n.src.slice(colon + 1));
        if (!Number.isInteger(lineIdx)) continue;
        let lines = files.get(rel);
        if (lines === undefined) {
            const fullPath = join(contentDir, rel);
            stamps.push([rel, fileStamp(fullPath)]);
            try {
                const raw = readFileSync(fullPath, 'utf8');
                lines = raw.includes('owned_shop') ? raw.split(/\r?\n/) : null;
            } catch {
                lines = null;
            }
            files.set(rel, lines);
        }
        if (!lines) continue;
        for (let i = lineIdx; i < lines.length; i++) {
            const line = lines[i]!;
            if (line.startsWith('[')) break;
            if (!line.startsWith('param=owned_shop,')) continue;
            const m = line.slice(17).match(/^[a-z0-9_]+/);
            if (m) {
                const shop = m[0];
                let list = owners.get(shop);
                if (!list) { list = []; owners.set(shop, list); }
                list.push({ npc: n.name, npcId: n.id, spawns: n.spawns });
            }
        }
    }
    const built = new Map<string, ShopSeller[]>();
    for (const s of shops) for (const o of owners.get(s.inv) ?? []) {
        if (o.spawns.every(offMap)) continue;
        for (const st of s.stock) {
            let list = built.get(st.item);
            if (!list) { list = []; built.set(st.item, list); }
            list.push({ shop: s.inv, npc: o.npc, npcId: o.npcId, spawns: o.spawns, stock: st.count });
        }
    }
    if (cacheFile) {
        try { writeAtomicFile(cacheFile, JSON.stringify({ v: 1, stamps, entries: [...built.entries()] }), { ensureDir: true }); }
        catch { /* optional cache */ }
    }
    if (isDefault) index = built;
    return built;
}

// Sellers nearest first by straight-line distance, a floor between counting LEVEL_STEP tiles (the route search judges
// the real walk, and the far walk takes the hubs toward the ground beneath an upstairs seller): Hudo's onions are on
// the Grand Tree's first floor.
const distance = (t: Tile, at: Tile) => Math.max(Math.abs(t.x - at.x), Math.abs(t.z - at.z)) + LEVEL_STEP * Math.abs(t.level - at.level);
export function sellersByDistance(item: string, at: Tile): (ShopSeller & { tile: Tile })[] {
    const out: (ShopSeller & { tile: Tile; d: number })[] = [];
    for (const s of shopSellers().get(item) ?? []) for (const t of s.spawns)
        if (s.stock >= 1) out.push({ ...s, tile: t, d: distance(t, at) });
    return out.sort((a, b) => a.d - b.d).map(({ d: _d, ...s }) => s);
}

// The seller nearest `at` by the same measure.
export function nearestSeller(item: string, at: Tile): (ShopSeller & { tile: Tile }) | null {
    let best: (ShopSeller & { tile: Tile }) | null = null, d = Infinity;
    for (const s of shopSellers().get(item) ?? []) for (const t of s.spawns) {
        if (s.stock < 1) continue;
        const k = distance(t, at);
        if (k < d) { d = k; best = { ...s, tile: t }; }
    }
    return best;
}
