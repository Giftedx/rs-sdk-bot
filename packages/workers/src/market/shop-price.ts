import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ShopRule } from './types';

export type { ShopRule };

const REPO_ROOT = resolve(import.meta.dir, '../../../..');

export function shopUnitPrice(cost: number, sell: number, delta: number, stock: number, base: number): number {
    const mod = Math.min(1000, Math.max(-5000, (base === -1 ? stock : stock - base) * delta));
    return Math.max(1, Math.floor(Math.max(100, sell - mod) * cost / 1000));
}

export const lastUnitPrice = (cost: number, rule: Pick<ShopRule, 'sell' | 'delta'>, base: number): number =>
    shopUnitPrice(cost, rule.sell, rule.delta, 1, base);

const SELL_DEFAULT = 100;
const DELTA_DEFAULT = 10;
const KEEPER_RADIUS = 20;

type NpcRow = { name: string; debugname: string; src: string; spawns: { x: number; z: number; level?: number }[] };
type ScriptShopCall = { inv: string; sell: number; delta: number; src: string };
type Data = {
    npcs: NpcRow[];
    stock: Map<string, Map<string, number>>;
    items: Map<string, { debugname: string; cost: number }[]>;
    npcBlocks: Map<string, Map<string, string>>;
    scriptsByNpc: () => Map<string, ScriptShopCall[]>;
};
const cache = new Map<string, Data>();

function load(root: string): Data {
    const hit = cache.get(root);
    if (hit) return hit;
    const read = (file: string) => JSON.parse(readFileSync(join(root, 'knowledge', file), 'utf8'));
    const items = new Map<string, { debugname: string; cost: number }[]>();
    for (const i of read('items.json') as { name?: string; debugname: string; cost?: number }[]) {
        if (typeof i.name === 'string' && (i.cost ?? 0) > 0) {
            const key = i.name.toLowerCase();
            let list = items.get(key);
            if (!list) {
                list = [];
                items.set(key, list);
            }
            list.push({ debugname: i.debugname, cost: i.cost! });
        }
    }
    const stock = new Map(
        (read('shops.json') as { inv: string; stock: { item: string; count: number }[] }[]).map(s => [
            s.inv,
            new Map(s.stock.map(row => [row.item, row.count])),
        ]),
    );
    let indexedScripts: Map<string, ScriptShopCall[]> | undefined;
    const scriptsByNpc = () => {
        if (indexedScripts) return indexedScripts;
        const base = join(root, 'vendor', 'rs-sdk', 'server', 'content', 'scripts');
        const byNpc = new Map<string, ScriptShopCall[]>();
        const walk = (dir: string) => {
            for (const e of readdirSync(dir, { withFileTypes: true })) {
                const p = join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else if (e.name.endsWith('.rs2')) {
                    const text = readFileSync(p, 'utf8');
                    if (!text.includes('~openshop(')) continue;
                    const src = `scripts/${p.slice(base.length + 1).replace(/\\/g, '/')}`;
                    const calls: ScriptShopCall[] = [];
                    for (const call of text.matchAll(/~openshop\((\w+),\s*\d+,\s*(\d+),\s*(\d+),/g)) {
                        calls.push({ inv: call[1]!, sell: Number(call[2]), delta: Number(call[3]), src });
                    }
                    if (!calls.length) continue;
                    const seenNpcs = new Set<string>();
                    for (const m of text.matchAll(/^\[opnpc\d,([^\]]+)\]/gm)) {
                        const npc = m[1]!;
                        if (seenNpcs.has(npc)) continue;
                        seenNpcs.add(npc);
                        let list = byNpc.get(npc);
                        if (!list) {
                            list = [];
                            byNpc.set(npc, list);
                        }
                        for (const c of calls) list.push(c);
                    }
                }
            }
        };
        walk(base);
        return (indexedScripts = byNpc);
    };
    const data: Data = { npcs: read('npcs.json'), stock, items, npcBlocks: new Map(), scriptsByNpc };
    cache.set(root, data);
    return data;
}

function getNpcBlock(data: Data, content: string, file: string, debugname: string): string | undefined {
    let blocks = data.npcBlocks.get(file);
    if (!blocks) {
        blocks = new Map();
        try {
            const text = readFileSync(join(content, file), 'utf8');
            for (const chunk of text.split(/\r?\n(?=\[)/)) {
                if (!chunk.startsWith('[')) continue;
                const end = chunk.indexOf(']');
                if (end > 1) {
                    const key = chunk.slice(1, end);
                    if (!blocks.has(key)) blocks.set(key, chunk);
                }
            }
        } catch {
            /* a keeper whose config is gone has no param rule */
        }
        data.npcBlocks.set(file, blocks);
    }
    return blocks.get(debugname);
}

const OWNED_SHOP_RE = /^param=owned_shop,(.+)$/m;
const SHOP_SELL_RE = /^param=shop_sell_multiplier,(.+)$/m;
const SHOP_DELTA_RE = /^param=shop_delta,(.+)$/m;

export function shopRules(name: RegExp, spot: { x: number; z: number; level?: number }, root = REPO_ROOT): ShopRule[] {
    const data = load(root);
    const content = join(root, 'vendor', 'rs-sdk', 'server', 'content');
    const spotLevel = spot.level ?? 0;
    const rules: ShopRule[] = [];
    for (let i = 0; i < data.npcs.length; i++) {
        const npc = data.npcs[i]!;
        if (!name.test(npc.name)) continue;
        let isNear = false;
        for (let si = 0; si < npc.spawns.length; si++) {
            const s = npc.spawns[si]!;
            if ((s.level ?? 0) === spotLevel && Math.abs(s.x - spot.x) <= KEEPER_RADIUS && Math.abs(s.z - spot.z) <= KEEPER_RADIUS) {
                isNear = true;
                break;
            }
        }
        if (!isNear) continue;
        const file = npc.src.replace(/:\d+$/, '');
        const block = getNpcBlock(data, content, file, npc.debugname);
        const inv = block?.match(OWNED_SHOP_RE)?.[1]?.trim();
        if (inv) {
            rules.push({
                inv,
                npc: npc.debugname,
                sell: Number(block!.match(SHOP_SELL_RE)?.[1]?.trim() ?? SELL_DEFAULT),
                delta: Number(block!.match(SHOP_DELTA_RE)?.[1]?.trim() ?? DELTA_DEFAULT),
                stock: data.stock.get(inv) ?? new Map(),
                src: npc.src,
            });
            continue;
        }
        const calls = data.scriptsByNpc().get(npc.debugname);
        if (calls) {
            for (const call of calls) {
                rules.push({
                    inv: call.inv,
                    npc: npc.debugname,
                    sell: call.sell,
                    delta: call.delta,
                    stock: data.stock.get(call.inv) ?? new Map(),
                    src: call.src,
                });
            }
        }
    }
    return rules;
}

export function contentUnitBound(rules: readonly ShopRule[], itemName: string, root = REPO_ROOT): number | null {
    const rows = load(root).items.get(itemName.toLowerCase()) ?? [];
    if (!rules.length || !rows.length) return null;
    let best = -Infinity;
    for (let r = 0; r < rules.length; r++) {
        const rule = rules[r]!;
        let hasStocked = false;
        for (let i = 0; i < rows.length; i++) {
            if (rule.stock.has(rows[i]!.debugname)) {
                hasStocked = true;
                break;
            }
        }
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i]!;
            const base = rule.stock.get(row.debugname);
            if (hasStocked && base === undefined) continue;
            const price = lastUnitPrice(row.cost, rule, base ?? -1);
            if (price > best) best = price;
        }
    }
    return best;
}
