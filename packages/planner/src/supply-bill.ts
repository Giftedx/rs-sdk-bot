// The Overall route's supply bill against owned stock: what Haggis's realistic route consumes (suppliesFor), what the
// live helper accounts hold (their status inventory, worn and last seen bank), and the shortfall to make or buy.
// Usage: bun packages/planner/src/supply-bill.ts [hiscores snapshot]   writes .practice/coordinator/supply-bill.json
//        bun packages/planner/src/supply-bill.ts [hiscores snapshot] --board <skill>   prints the bill of one specialist board, writes nothing
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { FLEET_DIR, mySide } from '../../core/src/fleet';
import { fleetStatusRows, ownerOfIn, readSnapshotFiles } from '../../core/src/fleet-snapshots';
import { dirname, join, resolve } from 'node:path';
import { boardsFromSnapshot, haggisActivities, haggisTravel, overallRequirementsFor, schedule, scheduleOverall, SCENARIOS, TRICKS } from './haggis';

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

// Live status and published snapshots across every side, including this side's observations from another container.
// Each account counts once under the shared ownership/freshness rule. Holdings still need reservation and staging.
export function liveHelperStatuses(base = root, fleetDir = join(FLEET_DIR(), 'snapshots'), side = mySide()): any[] {
    const read = (dir: string) => existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).flatMap(f => { try { return [JSON.parse(readFileSync(join(dir, f), 'utf8'))]; } catch { return []; } }) : [];
    return fleetStatusRows(read(join(base, '.practice/status')), readSnapshotFiles(fleetDir), ownerOfIn(dirname(fleetDir)), side)
        .filter(s => s.name.toLowerCase() !== 'haggis');
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

// The supplies that a fresh account consumes to win one skill board alone: the board goes first, every other board is
// relaxed (scenario c, realistic), and the rows that start before its 99 count. Returns null when the board has no finish.
export function boardSupplyDemand(snapshot = join(root, 'research/hiscores-live.json'), board: string) {
    const target = JSON.parse(readFileSync(snapshot, 'utf8')) as Parameters<typeof boardsFromSnapshot>[0];
    const activities = haggisActivities(), boards = boardsFromSnapshot(target);
    if (!boards.some(b => b.id === board && b.rule.kind === 'clock' && b.id !== 'overall')) throw new Error(`no clock board named ${board}`);
// Solo specialist skill boards run without the 5-tank Deserted Keep PvP relog route.
    const options = { mode: 'realistic' as const, tricks: new Set(SCENARIOS[2]!.tricks), travel: haggisTravel(), disable: new Set(['pvp-relog-combat']) };
    const plan = schedule(boards, activities, { ...options, sacrificed: new Set(boards.filter(b => b.id !== board).map(b => b.id)) });
    const finish = plan.boards.find(b => b.id === board)?.finish ?? null;
    if (finish === null) return null;
    const { supplies } = overallRequirementsFor(activities, options, { overallFinish: finish, order: plan.order, route: plan.route });
    return { finish, supplies };
}

// Non-Wilderness supply demand for the value special boards ('equipment' = 1,366,450 worn set; 'bank' = wealth stores).
export function specialBoardSupplyDemand(snapshot = join(root, 'research/hiscores-live.json'), board: 'equipment' | 'bank') {
    const target = JSON.parse(readFileSync(snapshot, 'utf8')) as Parameters<typeof boardsFromSnapshot>[0];
    const activities = haggisActivities(), boards = boardsFromSnapshot(target);
    const meta = boards.find(b => b.id === board && b.rule.kind === 'value');
    if (!meta) throw new Error(`no value board named ${board}`);
    const row = activities.find(a => a.serves.includes(board));
    if (!row) throw new Error(`no activity serving special board ${board}`);
    const options = { mode: 'realistic' as const, tricks: new Set(SCENARIOS[2]!.tricks), travel: haggisTravel(), disable: new Set(['pvp-relog-combat']) };
    const plan = schedule(boards, activities, options);
    const finish = plan.boards.find(b => b.id === board)?.finish ?? null;
    const supplies = (row.supplies ?? []).map(s => ({ ...s }));
    return { board, label: meta.label, finish, supplies };
}

if (import.meta.main) {
    const args = process.argv.slice(2), at = args.indexOf('--board');
    const board = at >= 0 ? args[at + 1] : undefined;
    if (at >= 0 && !board) throw new Error('--board needs a skill name');
    const snapshot = args.find((a, i) => !a.startsWith('--') && i !== at + 1) ?? join(root, 'research/hiscores-live.json');
    if (board) {
        const key = board.toLowerCase();
        const demand = key === 'equipment' || key === 'bank'
            ? specialBoardSupplyDemand(snapshot, key)
            : boardSupplyDemand(snapshot, key);
        if (!demand) throw new Error(`board ${board} has no modelled finish`);
        const items = JSON.parse(readFileSync(join(root, 'knowledge/items.json'), 'utf8'));
        const bill = supplyBill(demand.supplies, items, liveHelperStatuses());
        console.log(`${board} alone: realistic finish ${demand.finish} ticks; ${bill.length} supplies, ${bill.filter(r => r.short > 0).length} short`);
        console.log('');
        console.log('| Supply | Need | Owned | Short | Top holders |');
        console.log('|---|---|---|---|---|');
        for (const r of [...bill].sort((a, b) => b.short - a.short))
            console.log(`| ${r.item} | ${r.need} | ${r.owned} | ${r.short} | ${r.holders.slice(0, 3).map(h => `${h.account} ${h.count}`).join(', ') || (r.ids.length ? '-' : 'no item id')} |`);
        process.exit(0);
    }
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
