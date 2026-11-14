// Writes client-assets/item-alch.json: the base cost of each tradeable item of the pinned server, by name. The page
// takes the alchemy values from it as the server does (skill_magic/scripts/spells/alchemy.rs2): high alchemy pays
// max(scale(6, 10, cost), 1) coins, low alchemy max(scale(4, 10, cost), 1). Two items with one name keep the higher cost.
// Run: bun packages/dashboard/gen-item-alch.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function itemAlch(items: { name: string; cost?: number; tradeable: boolean }[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const i of items) {
        if (!i.tradeable || !i.name || !Number.isFinite(i.cost) || (i.cost as number) <= 0) continue;
        out[i.name] = Math.max(out[i.name] ?? 0, i.cost as number);
    }
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export const highAlch = (cost: number) => Math.max(Math.floor(cost * 6 / 10), 1);

if (import.meta.main) {
    const root = join(import.meta.dir, '..', '..');
    const out = itemAlch(JSON.parse(readFileSync(join(root, 'knowledge', 'items.json'), 'utf8')));
    writeFileSync(join(import.meta.dir, 'client-assets', 'item-alch.json'), JSON.stringify(out));
    console.log(`item-alch.json: ${Object.keys(out).length} items`);
}
