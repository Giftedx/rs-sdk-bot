// Writes client-assets/item-list.json for the Supply ledger's Collection log tab: every tradeable item of the pinned
// server as [id, name, category], sorted by category and name. The category is the content folder that defines the
// item (knowledge/items.json `src`), as the log's tabs: skill_smithing is Smithing, quests is Quests.
// Run: bun packages/dashboard/gen-item-list.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LABELS: Record<string, string> = {
    quests: 'Quests', minigames: 'Minigames', areas: 'Areas', 'macro events': 'Random events', general_use: 'General',
    _unpack: 'Other', tutorial: 'Other', holidayevents: 'Other',
};

export function itemCategory(src: string): string {
    const folder = String(src).match(/^scripts\/([^/]+)\//)?.[1] ?? '';
    if (folder.startsWith('skill_')) return folder.slice(6).replace(/^./, c => c.toUpperCase());
    return LABELS[folder] ?? 'Other';
}

export function itemList(items: { id: number; name: string; tradeable: boolean; src: string }[]): [number, string, string][] {
    return items.filter(i => i.tradeable && Number.isInteger(i.id) && i.name).map(i => [i.id, i.name, itemCategory(i.src)] as [number, string, string])
        .sort((a, b) => a[2].localeCompare(b[2]) || a[1].localeCompare(b[1]) || a[0] - b[0]);
}

if (import.meta.main) {
    const root = join(import.meta.dir, '..', '..');
    const list = itemList(JSON.parse(readFileSync(join(root, 'knowledge', 'items.json'), 'utf8')));
    writeFileSync(join(import.meta.dir, 'client-assets', 'item-list.json'), JSON.stringify(list));
    console.log(`item-list.json: ${list.length} tradeable items in ${new Set(list.map(i => i[2])).size} categories`);
}
