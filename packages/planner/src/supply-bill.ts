// The Overall route's supply bill against owned stock: what Haggis's realistic route consumes (suppliesFor), what the
// live helper accounts hold (their status inventory, worn and last seen bank), and the shortfall to make or buy.
// Usage: bun packages/planner/src/supply-bill.ts [hiscores snapshot]   writes .practice/coordinator/supply-bill.json
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { FLEET_DIR, mySide } from '../../core/src/fleet';
import { join, resolve } from 'node:path';
import { boardsFromSnapshot, haggisActivities, haggisTravel, overallRequirementsFor, scheduleOverall, TRICKS } from './haggis';

const root = resolve(import.meta.dir, '../../..');
export type BillRow = { item: string; itemId?: number; need: number; owned: number; short: number; ids: number[]; holders: { account: string; count: number }[]; aliases?: string[] };

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

type StockRow = { id: number; baseId?: number; count?: number };
// Pack and equipment come from one status. The last bank snapshot can contain the same units before a withdrawal.
export function observedStock(status: { inventory?: StockRow[]; equipment?: StockRow[]; bank?: StockRow[] }): Map<number, number> {
    const counts = (items: readonly StockRow[]) => {
        const totals = new Map<number, number>();
        for (const item of items) {
            const id = item.baseId ?? item.id;
            totals.set(id, (totals.get(id) ?? 0) + (item.count ?? 0));
        }
        return totals;
    };
    const held = counts([...(status.inventory ?? []), ...(status.equipment ?? [])]);
    for (const [id, count] of counts(status.bank ?? [])) held.set(id, Math.max(held.get(id) ?? 0, count));
    return held;
}

export function supplyBill(
    supplies: readonly { item: string; count: number; itemId?: number; aliases?: readonly string[] }[],
    items: readonly { id: number; name: string; debugname?: string }[],
    statuses: readonly any[],
): BillRow[] {
    const pools = new Map<string, BillRow>();
    for (const {item, count, itemId, aliases} of supplies) {
        const ids = itemId === undefined
            ? [...new Set(idsFor(item, items))].sort((a, b) => a - b)
            : items.some(i => i.id === itemId) ? [itemId] : [];
        const key = ids.length ? ids.join(',') : 'unmapped:' + item;
        const row: BillRow = pools.get(key) ?? {item, need: 0, owned: 0, short: 0, ids, holders: []};
        if (itemId !== undefined) row.itemId = itemId;
        row.need += count;
        const otherNames = [...new Set([...(row.aliases ?? []), item, ...(aliases ?? [])])].filter(name => name !== row.item);
        if (otherNames.length) row.aliases = otherNames;
        pools.set(key, row);
    }

    // Partly overlapping matches are not interchangeable. Keep those demands visible until exact IDs are available.
    const byId = new Map<number, BillRow>();
    const ambiguous = new Set<BillRow>();
    for (const row of pools.values()) {
        for (const id of row.ids) {
            const other = byId.get(id);
            if (other) {
                ambiguous.add(other);
                ambiguous.add(row);
            } else byId.set(id, row);
        }
    }
    for (const row of ambiguous) {
        for (const id of row.ids) byId.delete(id);
        row.ids = [];
    }

    for (const status of statuses) {
        const holdings = new Map<BillRow, number>();
        for (const [id, count] of observedStock(status)) {
            const row = byId.get(id);
            if (row) holdings.set(row, (holdings.get(row) ?? 0) + count);
        }
        for (const [row, count] of holdings) {
            if (count <= 0) continue;
            row.owned += count;
            row.holders.push({account: status.name, count});
        }
    }
    for (const row of pools.values()) {
        row.short = Math.max(0, row.need - row.owned);
        row.holders.sort((a, b) => b.count - a.count);
    }
    return [...pools.values()];
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

export function overallSupplyDemand(snapshot = join(root, 'research/hiscores-live.json')) {
    const target = JSON.parse(readFileSync(snapshot, 'utf8')) as Parameters<typeof boardsFromSnapshot>[0];
    const activities = haggisActivities(), boards = boardsFromSnapshot(target);
    const options = { mode: 'realistic' as const, tricks: new Set(TRICKS), travel: haggisTravel() };
    const plan = scheduleOverall(boards, activities, options);
    const { supplies } = overallRequirementsFor(activities, options, plan);
    const snapshotAt = Number.isFinite(Date.parse(target.takenAt)) ? target.takenAt : null;
    return { overallFinish: plan.overallFinish, supplies, snapshotAt };
}

if (import.meta.main) {
    const snapshot = process.argv[2] ?? join(root, 'research/hiscores-live.json');
    const { overallFinish, supplies, snapshotAt } = overallSupplyDemand(snapshot);
    const items = JSON.parse(readFileSync(join(root, 'knowledge/items.json'), 'utf8'));
    const bill = supplyBill(supplies, items, liveHelperStatuses());
    const dir = join(root, '.practice/coordinator'); if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'supply-bill.json'), JSON.stringify({ at: Date.now(), snapshot, snapshotAt, scope: 'overall', overallFinish, rows: bill }, null, 1) + '\n');
    const covered = bill.filter(r => r.short === 0).length, unmapped = bill.filter(r => !r.ids.length).length;
    console.log(`Route supplies ${bill.length}: covered ${covered}, short ${bill.length - covered} (${unmapped} not matched to an item id)\n`);
    console.log('| Supply | Need | Owned | Short | Top holders |\n|---|---|---|---|---|');
    for (const r of [...bill].sort((a, b) => b.short - a.short))
        console.log(`| ${r.item} | ${r.need} | ${r.owned} | ${r.short} | ${r.holders.slice(0, 3).map(h => `${h.account} ${h.count}`).join(', ') || (r.ids.length ? '-' : 'no item id')} |`);
}
