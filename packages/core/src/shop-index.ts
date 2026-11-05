// Which shopkeeper sells an item, and where they stand. A shop is an .inv with stock lines (knowledge/shops.json); an
// NPC owns it through `param=owned_shop,<inv>` in its config block (content scripts/shop/scripts/shop.rs2 opens
// npc_param(owned_shop)); knowledge/npcs.json gives the NPC's spawn tiles and config line.
import { readFileSync } from 'node:fs';
import { LEVEL_STEP } from './spawn-index';
import { join, resolve } from 'node:path';
import type { Tile } from './world';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
const content = join(repoRoot, 'vendor', 'rs-sdk', 'server', 'content');
export type ShopSeller = { shop: string; npc: string; npcId: number; spawns: Tile[]; stock: number };

let index: Map<string, ShopSeller[]> | undefined;
export function shopSellers(): Map<string, ShopSeller[]> {
    if (index) return index;
    const shops = JSON.parse(readFileSync(join(repoRoot, 'knowledge/shops.json'), 'utf8')) as { inv: string; stock: { item: string; count: number }[] }[];
    const npcs = JSON.parse(readFileSync(join(repoRoot, 'knowledge/npcs.json'), 'utf8')) as { id: number; name: string; src: string; spawns?: Tile[] }[];
    const files = new Map<string, string[]>(), owners = new Map<string, { npc: string; npcId: number; spawns: Tile[] }[]>();
    for (const n of npcs) {
        const m = n.src?.match(/^(.*):(\d+)$/);
        if (!m || !n.spawns?.length) continue;
        let lines = files.get(m[1]!);
        if (!lines) { try { lines = readFileSync(join(content, m[1]!), 'utf8').split(/\r?\n/); } catch { lines = []; } files.set(m[1]!, lines); }
        for (let i = Number(m[2]); i < lines.length && !lines[i]!.startsWith('['); i++) {
            const shop = lines[i]!.match(/^param=owned_shop,([a-z0-9_]+)/)?.[1];
            if (shop) owners.set(shop, [...(owners.get(shop) ?? []), { npc: n.name, npcId: n.id, spawns: n.spawns }]);
        }
    }
    index = new Map();
    for (const s of shops) for (const st of s.stock) for (const o of owners.get(s.inv) ?? [])
        index.set(st.item, [...(index.get(st.item) ?? []), { shop: s.inv, npc: o.npc, npcId: o.npcId, spawns: o.spawns, stock: st.count }]);
    return index;
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
