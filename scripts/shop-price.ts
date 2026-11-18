// The price rule of an NPC shop from the content, for the budget bound of a shop buy.
// The client state names a shop's price step as `haggle` and falls back to 10 when it cannot read it
// (vendor/rs-sdk/server/webclient/src/bot/StateCollector.ts), so a shop with another step gets a wrong bound from it:
// Jiminua's Jungle Store has shop_delta 20, and its last antipoison costs 483 coins where the client's values give 458.
// The content has the real values: the shop keeper's params `owned_shop`, `shop_sell_multiplier` and `shop_delta`
// (defaults 100 and 10, scripts/shop/configs/shopkeeper.param), or the `~openshop(inv, buy, sell, delta, title)` call
// in the keeper's script for a shop that a dialogue opens, and the normal stock of each item in the shop's .inv
// (knowledge/shops.json). The price of one unit is scripts/shop/scripts/shop.rs2 calc_shop_value with price_mod.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type ShopRule = { inv: string; npc: string; sell: number; delta: number; stock: ReadonlyMap<string, number>; src: string };

// The coins that the shop takes for one unit while its shelf holds `stock` units of an item with normal stock `base`
// (-1: the shop does not stock the item, and the count itself moves the price).
export function shopUnitPrice(cost: number, sell: number, delta: number, stock: number, base: number): number {
    const mod = Math.min(1000, Math.max(-5000, (base === -1 ? stock : stock - base) * delta));
    return Math.max(1, Math.floor(Math.max(100, sell - mod) * cost / 1000));
}
// The most that one unit can cost: the price of the last unit on the shelf.
export const lastUnitPrice = (cost: number, rule: Pick<ShopRule, 'sell' | 'delta'>, base: number): number => shopUnitPrice(cost, rule.sell, rule.delta, 1, base);

const SELL_DEFAULT = 100, DELTA_DEFAULT = 10, KEEPER_RADIUS = 20;
type NpcRow = { name: string; debugname: string; src: string; spawns: { x: number; z: number; level?: number }[] };
type Data = { npcs: NpcRow[]; stock: Map<string, Map<string, number>>; items: Map<string, { debugname: string; cost: number }[]>; scripts: () => { file: string; text: string }[] };
const cache = new Map<string, Data>();
function load(root: string): Data {
    const hit = cache.get(root);
    if (hit) return hit;
    const read = (file: string) => JSON.parse(readFileSync(join(root, 'knowledge', file), 'utf8'));
    // Several items can have one name (a strung and an unstrung bow, a lit and an unlit torch), so a name keeps each row.
    const items = new Map<string, { debugname: string; cost: number }[]>();
    for (const i of read('items.json') as { name?: string; debugname: string; cost?: number }[]) if (typeof i.name === 'string' && (i.cost ?? 0) > 0) items.set(i.name.toLowerCase(), [...(items.get(i.name.toLowerCase()) ?? []), { debugname: i.debugname, cost: i.cost! }]);
    const stock = new Map((read('shops.json') as { inv: string; stock: { item: string; count: number }[] }[]).map(s => [s.inv, new Map(s.stock.map(row => [row.item, row.count]))]));
    // The scripts that open a shop from a dialogue, read once and only when a keeper has no `owned_shop` param.
    let opened: { file: string; text: string }[] | undefined;
    const scripts = () => {
        if (opened) return opened;
        const base = join(root, 'vendor', 'rs-sdk', 'server', 'content', 'scripts'), out: { file: string; text: string }[] = [];
        const walk = (dir: string) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.rs2')) { const text = readFileSync(p, 'utf8'); if (text.includes('~openshop(')) out.push({ file: p.slice(base.length + 1).replace(/\\/g, '/'), text }); } } };
        walk(base);
        return opened = out;
    };
    const data: Data = { npcs: read('npcs.json'), stock, items, scripts };
    cache.set(root, data);
    return data;
}

// The rules of the shop whose keeper has `name` and a spawn within 20 tiles of `spot` on its level: one rule for a
// keeper with an `owned_shop` param, and one for each `~openshop` call of a keeper's script (a keeper can open a
// members shop and a free one). Empty when the content names no shop for that keeper.
export function shopRules(name: RegExp, spot: { x: number; z: number; level?: number }, root = resolve(import.meta.dir, '..')): ShopRule[] {
    const data = load(root), content = join(root, 'vendor', 'rs-sdk', 'server', 'content');
    const near = (n: NpcRow) => n.spawns.some(s => (s.level ?? 0) === (spot.level ?? 0) && Math.max(Math.abs(s.x - spot.x), Math.abs(s.z - spot.z)) <= KEEPER_RADIUS);
    const rules: ShopRule[] = [];
    for (const npc of data.npcs.filter(n => name.test(n.name) && near(n))) {
        const file = npc.src.replace(/:\d+$/, '');
        let block: string | undefined;
        try { block = readFileSync(join(content, file), 'utf8').split(/\r?\n(?=\[)/).find(b => b.startsWith(`[${npc.debugname}]`)); } catch { /* a keeper whose config is gone has no param rule */ }
        const param = (key: string) => block?.match(new RegExp(`^param=${key},(.+)$`, 'm'))?.[1]?.trim();
        const inv = param('owned_shop');
        if (inv) { rules.push({ inv, npc: npc.debugname, sell: Number(param('shop_sell_multiplier') ?? SELL_DEFAULT), delta: Number(param('shop_delta') ?? DELTA_DEFAULT), stock: data.stock.get(inv) ?? new Map(), src: npc.src }); continue; }
        for (const script of data.scripts()) {
            if (!new RegExp(`^\\[opnpc\\d,${npc.debugname}\\]`, 'm').test(script.text)) continue;
            for (const call of script.text.matchAll(/~openshop\((\w+),\s*\d+,\s*(\d+),\s*(\d+),/g))
                rules.push({ inv: call[1]!, npc: npc.debugname, sell: Number(call[2]), delta: Number(call[3]), stock: data.stock.get(call[1]!) ?? new Map(), src: `scripts/${script.file}` });
        }
    }
    return rules;
}

// The most that one unit of the named item can cost in the shop of `rules` (the highest of a keeper's shops), or null
// when no rule is given or the content does not know the item. Of the items with that name, the ones that the shop
// stocks count; when it stocks none of them, the highest bound over all of them counts.
export function contentUnitBound(rules: readonly ShopRule[], itemName: string, root = resolve(import.meta.dir, '..')): number | null {
    const rows = load(root).items.get(itemName.toLowerCase()) ?? [];
    if (!rules.length || !rows.length) return null;
    return Math.max(...rules.map(rule => {
        const stocked = rows.filter(row => rule.stock.has(row.debugname));
        return Math.max(...(stocked.length ? stocked : rows).map(row => lastUnitPrice(row.cost, rule, rule.stock.get(row.debugname) ?? -1)));
    }));
}
