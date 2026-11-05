// The Overall route's supply bill against owned stock: what Haggis's realistic route consumes (suppliesFor), what the
// live helper accounts hold (their status inventory, worn and last seen bank), and the shortfall to make or buy.
// Usage: bun packages/planner/src/supply-bill.ts [hiscores snapshot]   writes .practice/coordinator/supply-bill.json
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { FLEET_DIR, mySide } from '../../core/src/fleet';
import { join, resolve } from 'node:path';
import { haggisActivities, haggisTravel, loadSnapshot, overallRequirementsFor, schedule, TRICKS } from './haggis';

const root = resolve(import.meta.dir, '../../..');
export type BillRow = { item: string; need: number; owned: number; short: number; ids: number[]; holders: { account: string; count: number }[] };

// Item ids whose name matches a bill line: exact name, or the singular of a plural line ("dragon bones" -> "Dragon bones").
// The pinned names differ for two families: every unfinished potion is "Unfinished potion" (debugname <herb>vial), and
// the bill's "mort myre fungus" is the item "Mort myre fungi".
export function idsFor(item: string, items: readonly { id: number; name: string; debugname?: string }[]): number[] {
    const want = item.toLowerCase().replace(/\s*\((?:noted|quest)\)$/, '').trim();
    const unf = want.match(/^(.+) potion \(unf\)$/);
    if (unf) return items.filter(i => i.debugname === unf[1]!.replace(/\s+/g, '') + 'vial').map(i => i.id);
    const forms = new Set([want, want.replace(/s$/, ''), want.replace(/ies$/, 'y'), want.replace(/us$/, 'i')]);
    return items.filter(i => forms.has(String(i.name).toLowerCase())).map(i => i.id);
}

export function supplyBill(supplies: readonly { item: string; count: number }[], items: readonly { id: number; name: string }[], statuses: readonly any[]): BillRow[] {
    return supplies.map(({ item, count }) => {
        const ids = idsFor(item, items), holders: { account: string; count: number }[] = [];
        for (const s of statuses) {
            let n = 0;
            for (const r of [...(s.inventory ?? []), ...(s.equipment ?? []), ...(s.bank ?? [])]) if (ids.includes(r.baseId ?? r.id)) n += r.count ?? 0;
            if (n > 0) holders.push({ account: s.name, count: n });
        }
        const owned = holders.reduce((a, h) => a + h.count, 0);
        return { item, need: count, owned, short: ids.length ? Math.max(0, count - owned) : count, ids, holders: holders.sort((a, b) => b.count - a.count) };
    });
}

// This machine's live statuses, plus the accounts the other fleet side published in fleet/snapshots (scripts/fleet-sync.ts),
// so the bill counts every published side. These holdings are owned observations, not reserved or staged stock.
export function liveHelperStatuses(base = root, fleetDir = join(FLEET_DIR(), 'snapshots'), side = mySide()): any[] {
    const read = (dir: string) => existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).flatMap(f => { try { return [JSON.parse(readFileSync(join(dir, f), 'utf8'))]; } catch { return []; } }) : [];
    const mine = read(join(base, '.practice/status')), theirs = read(fleetDir).filter(x => x?.side && x.side !== side).flatMap(x => x.accounts ?? []);
    const names = new Set(mine.map(s => String(s?.name).toLowerCase()));
    return [...mine, ...theirs.filter(a => !names.has(String(a?.name).toLowerCase()))]
        .filter(s => s?.server === 'rs-sdk-demo.fly.dev' && typeof s.name === 'string' && s.name.toLowerCase() !== 'haggis');
}

if (import.meta.main) {
    const snapshot = process.argv[2] ?? join(root, 'research/hiscores-live.json');
    const activities = haggisActivities(), boards = loadSnapshot(snapshot);
    const options = { mode: 'realistic' as const, tricks: new Set(TRICKS), travel: haggisTravel() };
    const plan = schedule(boards, activities, options);
    const { supplies } = overallRequirementsFor(activities, options, plan);
    const items = JSON.parse(readFileSync(join(root, 'knowledge/items.json'), 'utf8'));
    const bill = supplyBill(supplies, items, liveHelperStatuses());
    const dir = join(root, '.practice/coordinator'); if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'supply-bill.json'), JSON.stringify({ at: Date.now(), snapshot, scope: 'overall', overallFinish: plan.overallFinish, rows: bill }, null, 1) + '\n');
    const covered = bill.filter(r => r.short === 0).length, unmapped = bill.filter(r => !r.ids.length).length;
    console.log(`Route supplies ${bill.length}: covered ${covered}, short ${bill.length - covered} (${unmapped} not matched to an item id)\n`);
    console.log('| Supply | Need | Owned | Short | Top holders |\n|---|---|---|---|---|');
    for (const r of [...bill].sort((a, b) => b.short - a.short))
        console.log(`| ${r.item} | ${r.need} | ${r.owned} | ${r.short} | ${r.holders.slice(0, 3).map(h => `${h.account} ${h.count}`).join(', ') || (r.ids.length ? '-' : 'no item id')} |`);
}
