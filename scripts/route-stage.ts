// Stages the supplies of one route step at the bank that the route account visits next. For each item line, the
// accounts of this side that hold the item (fleet/snapshots/<side>.json) give it by fleet orders that meet at that
// bank (scripts/coin-courier.ts BANK_MEETS). Accounts with no enabled job give first. An account with an enabled job
// gives only with --allow-busy: the autopilot then takes it off its job while the order is open (scripts/autopilot.ts
// inOpenOrder) and plans it again after the trade. An account whose enabled job the autopilot does not own (no
// `autopilot` mark: a hand or coordinator job) never gives and never receives, because the fleet agent refuses it and the
// autopilot cannot free it. The count that the route account holds already is not ordered.
// Each giver gets one order with all its lines (Order.extra): one trade and one login for the route account per giver.
// Snapshots age: a giver whose bank is short fails its trade with "stock short".
// Each side's fleet agent runs the first open order that names its account (scripts/fleet-trade.ts pickOrder, by
// start). An account in another open order would wait there while its partner waits here, so such a giver is left
// out, and a receiver in an open order refuses (the agent's own choice: pickOrder with its lead window). A held trade
// claim of another order holds the account too: its login fails with "fleet trade claim held" until that claim ends. The orders of one call start 1 ms apart, so both sides of each pair
// take them in the same sequence.
// A hand-held account never gives unless --from names it: an owner stop file, a job with no script (a reservation),
// or a disabled job that the autopilot does not own (a hand job: the mock-run runner, its helpers, an owner hold).
// --from a,b gives only from those accounts.
// Usage: bun scripts/route-stage.ts <account> <bank name> "<count> <item>" ["<count> <item>" ...] [--dry] [--allow-busy] [--from a,b]
//   or:  bun scripts/route-stage.ts <account> --route <route.json> --step <step id> [--dry] [--allow-busy]
// A route file step names its batch as "stage": {"bank": "draynor", "items": [{"item": "oak logs", "count": 125}]}.
// Env: IN (minutes to the first window, default 10), MINUTES (window length, default 90).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FLEET_DIR, loadOwners } from '../packages/core/src/fleet';
import { BANK_MEETS } from './coin-courier';
import { makeOrder, orderMeet } from './fleet-order';
import { pickOrder, swarmBusy, validOrder, type Order } from './fleet-trade';
import { MAX_ORDER_LINES } from './fleet-trade-settlement';
import { swarmWroteStop } from './swarm';
import { readHeldFleetTradeClaims } from '../packages/core/src/fleet-trade-claim';

export interface StageLine { item: string; count: number }
// busy: an enabled autopilot job, which the autopilot frees for an open order. blocked: an enabled job that it does not own.
export interface Holder { name: string; count: number; busy: boolean; blocked?: boolean }
export interface StagePlan { orders: { from: string; item: string; count: number; busy: boolean }[]; held: StageLine[]; short: (StageLine & { blocked: string[] })[] }

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
        const all = holders(line.item).filter(h => h.count > 0);
        const givers = all.filter(h => !h.blocked && (allowBusy || !h.busy))
            .sort((a, b) => Number(a.busy) - Number(b.busy) || b.count - a.count);
        for (const h of givers) {
            if (need <= 0) break;
            const count = Math.min(need, h.count);
            plan.orders.push({ from: h.name, item: line.item, count, busy: h.busy });
            need -= count;
        }
        if (need > 0) plan.short.push({ item: line.item, count: need, blocked: all.filter(h => h.blocked).map(h => h.name) });
    }
    return plan;
}

// One fleet order for each giver: all its lines move in one trade (Order.extra), up to one trade window of lines.
export function groupOrders(orders: StagePlan['orders']): { from: string; lines: StageLine[]; busy: boolean }[] {
    const out: { from: string; lines: StageLine[]; busy: boolean }[] = [];
    for (const o of orders) {
        const group = out.find(g => norm(g.from) === norm(o.from) && g.lines.length < MAX_ORDER_LINES);
        if (group) { group.lines.push({ item: o.item, count: o.count }); group.busy ||= o.busy; }
        else out.push({ from: o.from, lines: [{ item: o.item, count: o.count }], busy: o.busy });
    }
    return out;
}

// The order that holds an account now: one it is trading (a prepared receipt in an open window, which pickOrder
// skips), or the first one its fleet agent would pick.
export function orderInWay(orders: readonly Order[], receipts: readonly any[], name: string, now: number, claims: readonly { account: string; orderId: string }[] = []): string | undefined {
    const end = new Map(orders.map(o => [o.id, o.end]));
    return claims.find(c => norm(c.account) === norm(name))?.orderId ?? receipts.find(r => r?.state === 'prepared' && norm(String(r.account ?? '')) === norm(name) && (end.get(r.id) ?? 0) > now)?.id
        ?? pickOrder(orders, receipts, name, now)?.order.id;
}

// Why an account is held back from giving, or undefined: its stop file (owner text) and its jobs in the plan.
export function heldBack(name: string, jobs: readonly any[], stopText: string | undefined): string | undefined {
    if (stopText !== undefined && !swarmWroteStop(stopText)) return 'owner stop file';
    const mine = jobs.filter(j => [j?.account, ...(j?.accounts ?? [])].some((n: unknown) => typeof n === 'string' && norm(n) === norm(name)));
    if (mine.some(j => !j.script)) return 'reserved (a job with no script)';
    if (mine.some(j => !j.enabled && typeof j.autopilot !== 'string')) return 'hand job (disabled, not an autopilot job)';
    return undefined;
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
        lines = argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--from').map(parseLine);
    }
    const meet = orderMeet(bank);
    if (!meet) throw Error(`unknown bank ${bank}: ${BANK_MEETS.map(r => r.bank).join(', ')}`);
    const owners = loadOwners(), side = owners.get(account.toLowerCase())?.side;
    if (!side) throw Error(`${account} is not in fleet/owners.json`);
    const snapshot = readJson(join(FLEET_DIR(), 'snapshots', `${side}.json`))?.accounts ?? [];
    const plan = readJson(join(FLEET_DIR(), 'plans', `${side}.json`))?.jobs ?? [];
    const busy = swarmBusy(plan), owned = swarmBusy(plan.filter((j: any) => typeof j?.autopilot === 'string'));
    const fromList = value('--from'), from = fromList ? new Set(fromList.split(',').map(norm)) : undefined;
    const stopText = (name: string) => { for (const n of [name, name.toLowerCase()]) { try { return readFileSync(join('.practice', `stop-${n}`), 'utf8'); } catch { /* none */ } } return undefined; };
    const row = (name: string) => snapshot.find((a: any) => norm(a?.name ?? '') === norm(name));
    const files = (dir: string) => { try { return readdirSync(join(FLEET_DIR(), dir)).filter(f => f.endsWith('.json')).flatMap(f => { const j = readJson(join(FLEET_DIR(), dir, f)); return j ? [j] : []; }); } catch { return []; } };
    // The order that the fleet agent would run first for an account (its lead window included), as the agent picks it.
    const orders = files('orders').filter(validOrder), receipts = files('receipts');
    const claims = readHeldFleetTradeClaims(resolve(import.meta.dir, '..'));
    const now0 = Date.now(), waiting = (name: string) => orderInWay(orders, receipts, name, now0, claims);
    const mine = waiting(account);
    if (mine) throw Error(`${account} has open fleet order ${mine}: its agent takes that order first`);
    // The fleet agent skips an account with an enabled job, and the autopilot frees only its own jobs: givers would wait
    // at the bank until their orders end.
    if (busy.has(norm(account)) && !owned.has(norm(account))) throw Error(`${account} has an enabled job that the autopilot does not own: its fleet agent takes no order`);
    const staged = planStage(lines, item => heldCount(row(account), item), item => snapshot
        .filter((a: any) => typeof a?.name === 'string' && norm(a.name) !== norm(account) && norm(a.name) !== 'haggis' && owners.get(norm(a.name))?.side === side && !waiting(a.name)
            && (from ? from.has(norm(a.name)) : !heldBack(a.name, plan, stopText(a.name))))
        .map((a: any) => {
            const name = norm(a.name);
            return { name: a.name, count: heldCount(a, item), busy: busy.has(name), blocked: busy.has(name) && !owned.has(name) };
        }), flag('--allow-busy'));
    for (const h of staged.held) console.log(`ROUTE_STAGE held ${account} ${h.count} ${h.item}`);
    for (const s of staged.short) console.log(`ROUTE_STAGE short ${s.count} ${s.item}: no ${flag('--allow-busy') ? '' : 'free '}holder on side ${side}`
        + (s.blocked.length ? `; held by ${s.blocked.join(', ')} in a job that the autopilot does not own` : ''));
    const now = Date.now(), inMin = Number(process.env.IN ?? 10), minutes = Number(process.env.MINUTES ?? 90);
    const grouped = groupOrders(staged.orders);
    for (const [i, o] of grouped.entries()) {
        const [first, ...extra] = o.lines;
        const base = makeOrder(o.from, account, first!.count, first!.item, now + i, inMin, minutes, owners, meet, extra);
        // Givers are accounts of this side, so the route account stays offline until its giver is at the meet.
        const order: Order = { ...base, id: `${base.id}-${first!.item.replace(/[^A-Za-z0-9]+/g, '')}`.toLowerCase().slice(0, 64), takerWaits: true };
        if (!flag('--dry')) {
            mkdirSync(join(FLEET_DIR(), 'orders'), { recursive: true });
            writeFileSync(join(FLEET_DIR(), 'orders', `${order.id}.json`), JSON.stringify(order, null, 1) + '\n');
        }
        const what = o.lines.map(l => `${l.count} ${l.item}`).join(', ');
        console.log(`ROUTE_STAGE ${flag('--dry') ? 'would order' : 'order'} ${order.id} ${o.from} -> ${account} ${what} at ${bank}${o.busy ? ' (busy: the autopilot frees it)' : ''}`);
    }
    console.log(`RESULT ${staged.short.length ? 'fail' : 'ok'} route-stage orders=${grouped.length} lines=${staged.orders.length} short=${staged.short.length}`);
}
