// Stages the supplies of one route step at the bank that the route account visits next. For each item line, the
// accounts of this side that hold the item (fleet/snapshots/<side>.json) give it by fleet orders that meet at that
// bank (scripts/coin-courier.ts BANK_MEETS). Accounts with no enabled job give first. An account with an enabled job
// gives only with --allow-busy: the autopilot then takes it off its job while the order is open (scripts/autopilot.ts
// inOpenOrder) and plans it again after the trade. The count that the route account holds already is not ordered.
// One order moves one item type (scripts/fleet-trade.ts accepts a one-line offer), so each line from each giver is
// one trade. Snapshots age: a giver whose bank is short fails its trade with "stock short".
// Usage: bun scripts/route-stage.ts <account> <bank name> "<count> <item>" ["<count> <item>" ...] [--dry] [--allow-busy]
//   or:  bun scripts/route-stage.ts <account> --route <route.json> --step <step id> [--dry] [--allow-busy]
// A route file step names its batch as "stage": {"bank": "draynor", "items": [{"item": "oak logs", "count": 125}]}.
// Env: IN (minutes to the first window, default 10), MINUTES (window length, default 90).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLEET_DIR, loadOwners } from '../packages/core/src/fleet';
import { BANK_MEETS } from './coin-courier';
import { makeOrder, orderMeet } from './fleet-order';
import type { Order } from './fleet-trade';

export interface StageLine { item: string; count: number }
export interface Holder { name: string; count: number; busy: boolean }
export interface StagePlan { orders: { from: string; item: string; count: number; busy: boolean }[]; held: StageLine[]; short: StageLine[] }

const norm = (s: string) => s.trim().toLowerCase();
// Item count of one snapshot row (bank and pack), by exact item name, case ignored.
export function heldCount(row: { bank?: any[]; inventory?: any[] } | undefined, item: string): number {
    if (!row) return 0;
    return [...(row.bank ?? []), ...(row.inventory ?? [])].filter(i => typeof i?.name === 'string' && norm(i.name) === norm(item))
        .reduce((n, i) => n + (Number(i.count) || 0), 0);
}

export function parseLine(text: string): StageLine {
    const m = text.trim().match(/^(\d+)\s+(.+)$/);
    if (!m || !Number(m[1])) throw Error(`item line must be "<count> <item>", not ${text}`);
    return { count: Number(m[1]), item: m[2]!.trim() };
}

// Free holders first, then the largest stock first; a line that the holders cannot cover is short.
export function planStage(lines: readonly StageLine[], receiverHeld: (item: string) => number,
    holders: (item: string) => Holder[], allowBusy: boolean): StagePlan {
    const plan: StagePlan = { orders: [], held: [], short: [] };
    for (const line of lines) {
        const have = Math.min(line.count, receiverHeld(line.item));
        if (have) plan.held.push({ item: line.item, count: have });
        let need = line.count - have;
        const givers = holders(line.item).filter(h => h.count > 0 && (allowBusy || !h.busy))
            .sort((a, b) => Number(a.busy) - Number(b.busy) || b.count - a.count);
        for (const h of givers) {
            if (need <= 0) break;
            const count = Math.min(need, h.count);
            plan.orders.push({ from: h.name, item: line.item, count, busy: h.busy });
            need -= count;
        }
        if (need > 0) plan.short.push({ item: line.item, count: need });
    }
    return plan;
}

const readJson = (f: string) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

if (import.meta.main) {
    const argv = process.argv.slice(2), flag = (n: string) => argv.includes(n);
    const value = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
    const account = argv[0];
    if (!account) throw Error('usage: bun scripts/route-stage.ts <account> <bank> "<count> <item>" ... | --route <file> --step <id>');
    let bank: string, lines: StageLine[];
    const route = value('--route');
    if (route) {
        const step = (readJson(route)?.steps ?? []).find((s: any) => s?.id === value('--step'));
        if (!step?.stage) throw Error(`route ${route} has no stage for step ${value('--step')}`);
        bank = step.stage.bank; lines = step.stage.items.map((i: any) => ({ item: String(i.item), count: Number(i.count) }));
    } else {
        bank = argv[1] ?? '';
        lines = argv.slice(2).filter(a => !a.startsWith('--')).map(parseLine);
    }
    const meet = orderMeet(bank);
    if (!meet) throw Error(`unknown bank ${bank}: ${BANK_MEETS.map(r => r.bank).join(', ')}`);
    const owners = loadOwners(), side = owners.get(account.toLowerCase())?.side;
    if (!side) throw Error(`${account} is not in fleet/owners.json`);
    const snapshot = readJson(join(FLEET_DIR(), 'snapshots', `${side}.json`))?.accounts ?? [];
    const plan = readJson(join(FLEET_DIR(), 'plans', `${side}.json`))?.jobs ?? [];
    const busy = new Set(plan.filter((j: any) => j?.enabled).flatMap((j: any) => [j.account, ...(j.accounts ?? [])]).map((n: string) => norm(n)));
    const row = (name: string) => snapshot.find((a: any) => norm(a?.name ?? '') === norm(name));
    const staged = planStage(lines, item => heldCount(row(account), item), item => snapshot
        .filter((a: any) => typeof a?.name === 'string' && norm(a.name) !== norm(account) && norm(a.name) !== 'haggis' && owners.get(norm(a.name))?.side === side)
        .map((a: any) => ({ name: a.name, count: heldCount(a, item), busy: busy.has(norm(a.name)) })), flag('--allow-busy'));
    for (const h of staged.held) console.log(`ROUTE_STAGE held ${account} ${h.count} ${h.item}`);
    for (const s of staged.short) console.log(`ROUTE_STAGE short ${s.count} ${s.item}: no ${flag('--allow-busy') ? '' : 'free '}holder on side ${side}`);
    const now = Date.now(), inMin = Number(process.env.IN ?? 10), minutes = Number(process.env.MINUTES ?? 90);
    for (const o of staged.orders) {
        const base = makeOrder(o.from, account, o.count, o.item, now, inMin, minutes, owners, meet);
        const order: Order = { ...base, id: `${base.id}-${o.item.replace(/[^A-Za-z0-9]+/g, '')}`.toLowerCase().slice(0, 64) };
        if (!flag('--dry')) {
            mkdirSync(join(FLEET_DIR(), 'orders'), { recursive: true });
            writeFileSync(join(FLEET_DIR(), 'orders', `${order.id}.json`), JSON.stringify(order, null, 1) + '\n');
        }
        console.log(`ROUTE_STAGE ${flag('--dry') ? 'would order' : 'order'} ${order.id} ${o.from} -> ${account} ${o.count} ${o.item} at ${bank}${o.busy ? ' (busy: the autopilot frees it)' : ''}`);
    }
    console.log(`RESULT ${staged.short.length ? 'fail' : 'ok'} route-stage orders=${staged.orders.length} short=${staged.short.length}`);
}
