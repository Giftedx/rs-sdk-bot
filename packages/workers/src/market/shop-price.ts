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
type Data = {
    npcs: NpcRow[];
    stock: Map<string, Map<string, number>>;
    items: Map<string, { debugname: string; cost: number }[]>;
    scripts: () => { file: string; text: string }[];
};
const cache = new Map<string, Data>();

function load(root: string): Data {
    const hit = cache.get(root);
    if (hit) return hit;
    const read = (file: string) => JSON.parse(readFileSync(join(root, 'knowledge', file), 'utf8'));
    const items = new Map<string, { debugname: string; cost: number }[]>();
    for (const i of read('items.json') as { name?: string; debugname: string; cost?: number }[]) {
        if (typeof i.name === 'string' && (i.cost ?? 0) > 0) {
            items.set(i.name.toLowerCase(), [...(items.get(i.name.toLowerCase()) ?? []), { debugname: i.debugname, cost: i.cost! }]);
        }
    }
    const stock = new Map(
        (read('shops.json') as { inv: string; stock: { item: string; count: number }[] }[]).map(s => [
            s.inv,
            new Map(s.stock.map(row => [row.item, row.count])),
        ]),
    );
    let opened: { file: string; text: string }[] | undefined;
    const scripts = () => {
        if (opened) return opened;
        const base = join(root, 'vendor', 'rs-sdk', 'server', 'content', 'scripts');
        const out: { file: string; text: string }[] = [];
        const walk = (dir: string) => {
            for (const e of readdirSync(dir, { withFileTypes: true })) {
                const p = join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else if (e.name.endsWith('.rs2')) {
                    const text = readFileSync(p, 'utf8');
                    if (text.includes('~openshop(')) out.push({ file: p.slice(base.length + 1).replace(/\\/g, '/'), text });
                }
            }
        };
        walk(base);
        return (opened = out);
    };
    const data: Data = { npcs: read('npcs.json'), stock, items, scripts };
    cache.set(root, data);
    return data;
}

export function shopRules(name: RegExp, spot: { x: number; z: number; level?: number }, root = REPO_ROOT): ShopRule[] {
    const data = load(root);
    const content = join(root, 'vendor', 'rs-sdk', 'server', 'content');
    const near = (n: NpcRow) =>
        n.spawns.some(s => (s.level ?? 0) === (spot.level ?? 0) && Math.max(Math.abs(s.x - spot.x), Math.abs(s.z - spot.z)) <= KEEPER_RADIUS);
    const rules: ShopRule[] = [];
    for (const npc of data.npcs.filter(n => name.test(n.name) && near(n))) {
        const file = npc.src.replace(/:\d+$/, '');
        let block: string | undefined;
        try {
            block = readFileSync(join(content, file), 'utf8').split(/\r?\n(?=\[)/).find(b => b.startsWith(`[${npc.debugname}]`));
        } catch {
            /* a keeper whose config is gone has no param rule */
        }
        const param = (key: string) => block?.match(new RegExp(`^param=${key},(.+)$`, 'm'))?.[1]?.trim();
        const inv = param('owned_shop');
        if (inv) {
            rules.push({
                inv,
                npc: npc.debugname,
                sell: Number(param('shop_sell_multiplier') ?? SELL_DEFAULT),
                delta: Number(param('shop_delta') ?? DELTA_DEFAULT),
                stock: data.stock.get(inv) ?? new Map(),
                src: npc.src,
            });
            continue;
        }
        for (const script of data.scripts()) {
            if (!new RegExp(`^\\[opnpc\\d,${npc.debugname}\\]`, 'm').test(script.text)) continue;
            for (const call of script.text.matchAll(/~openshop\((\w+),\s*\d+,\s*(\d+),\s*(\d+),/g)) {
                rules.push({
                    inv: call[1]!,
                    npc: npc.debugname,
                    sell: Number(call[2]),
                    delta: Number(call[3]),
                    stock: data.stock.get(call[1]!) ?? new Map(),
                    src: `scripts/${script.file}`,
                });
            }
        }
    }
    return rules;
}

export function contentUnitBound(rules: readonly ShopRule[], itemName: string, root = REPO_ROOT): number | null {
    const rows = load(root).items.get(itemName.toLowerCase()) ?? [];
    if (!rules.length || !rows.length) return null;
    return Math.max(
        ...rules.map(rule => {
            const stocked = rows.filter(row => rule.stock.has(row.debugname));
            return Math.max(...(stocked.length ? stocked : rows).map(row => lastUnitPrice(row.cost, rule, rule.stock.get(row.debugname) ?? -1)));
        }),
    );
}
