// Writes client-assets/item-alch.json: the base cost of each tradeable item of the pinned server, by item ID. The page
// takes the alchemy values from it as the server does (skill_magic/scripts/spells/alchemy.rs2): high alchemy pays
// max(scale(6, 10, cost), 1) coins, low alchemy max(scale(4, 10, cost), 1). A legacy name alias is present only when costs agree.
// Run: bun packages/dashboard/gen-item-alch.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function itemAlch(items: readonly { id: number; name: string; cost?: number; tradeable: boolean }[]): Record<string, number> {
    const out: Record<string, number> = {}, aliases = new Map<string, number | null>();
    for (const i of items) {
        if (!i.tradeable || !i.name || !Number.isSafeInteger(i.id) || i.id < 0 || !Number.isFinite(i.cost) || (i.cost as number) <= 0) continue;
        const cost = i.cost as number;
        out[i.id] = cost;
        if (!aliases.has(i.name)) aliases.set(i.name, cost);
        else if (aliases.get(i.name) !== cost) aliases.set(i.name, null);
    }
    for (const [name, cost] of aliases) if (cost !== null) out[name] = cost;
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export const highAlch = (cost: number) => Math.max(Math.floor(cost * 6 / 10), 1);

if (import.meta.main) {
    const root = join(import.meta.dir, '..', '..');
    const out = itemAlch(JSON.parse(readFileSync(join(root, 'knowledge', 'items.json'), 'utf8')));
    writeFileSync(join(import.meta.dir, 'client-assets', 'item-alch.json'), JSON.stringify(out));
    console.log(`item-alch.json: ${Object.keys(out).length} ID/name entries`);
}
