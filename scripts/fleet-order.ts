// Places a cross-machine transfer order in fleet/orders for scripts/fleet-trade.ts. Both accounts must be listed in
// fleet/owners.json on the same server; the window opens IN minutes from now and lasts MINUTES. The order is written
// with a FLEET_ORDER_WARN line for each party the sides' published plans (fleet/plans) show in an enabled job, since
// that side's fleet agent skips such an account until the job is off, and for a coin donor whose published snapshot
// holds fewer coins than the order: an order that no agent can run lapses at the end of its window unnoticed.
// Usage: bun scripts/fleet-order.ts <from> <to> <count> <item name...>   Env: IN (default 15), MINUTES (default 40)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLEET_DIR, loadOwners } from '../packages/core/src/fleet';
import { validOrder, type Order } from './fleet-trade';

export function makeOrder(from: string, to: string, count: number, item: string, now: number, inMin: number, minutes: number, owners = loadOwners()): Order {
    const a = owners.get(from.toLowerCase()), b = owners.get(to.toLowerCase());
    if (!a || !b) throw Error(`both accounts must be listed in fleet/owners.json: ${!a ? from : to}`);
    if (a.server !== b.server) throw Error('both accounts must use one server');
    const start = now + inMin * 60_000, order = { id: `${start}-${from}-${to}`.toLowerCase(), server: a.server, from, to, item, count, start, end: start + minutes * 60_000 };
    if (!validOrder(order)) throw Error('invalid order');
    return order;
}

// Why the sides' fleet agents may not run this order, from their published plans and snapshots. Plans change, so these
// warn and never refuse. `plans` and `snapshots` are keyed by side.
export function orderWarnings(order: Order, plans: Readonly<Record<string, { jobs?: any[] } | null | undefined>>,
    snapshots: Readonly<Record<string, { accounts?: any[] } | null | undefined>>, owners = loadOwners()): string[] {
    const out: string[] = [], sideOf = (name: string) => owners.get(name.toLowerCase())?.side ?? 'local';
    for (const name of [order.from, order.to]) {
        const job = (plans[sideOf(name)]?.jobs ?? []).find((j: any) => j?.enabled && [j.account, ...(j.accounts ?? [])].some((a: unknown) => typeof a === 'string' && a.toLowerCase() === name.toLowerCase()));
        if (job) out.push(`${name} has an enabled job on the ${sideOf(name)} side (${job.script}): its fleet agent waits until that job is off`);
    }
    if (/^coins?$/i.test(order.item)) {
        const row = (snapshots[sideOf(order.from)]?.accounts ?? []).find((a: any) => typeof a?.name === 'string' && a.name.toLowerCase() === order.from.toLowerCase());
        const coins = row ? [...(row.bank ?? []), ...(row.inventory ?? [])].filter((i: any) => /^coins$/i.test(i?.name ?? '')).reduce((n: number, i: any) => n + (Number(i?.count) || 0), 0) : null;
        if (coins !== null && coins < order.count) out.push(`${order.from} held ${coins} coins at its last snapshot, fewer than the ${order.count} ordered`);
    }
    return out;
}
const readJson = (f: string) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

if (import.meta.main) {
    const [from, to, countText, ...name] = process.argv.slice(2);
    const order = makeOrder(from ?? '', to ?? '', Number(countText), name.join(' '), Date.now(), Number(process.env.IN ?? 15), Number(process.env.MINUTES ?? 40));
    mkdirSync(join(FLEET_DIR(), 'orders'), { recursive: true });
    writeFileSync(join(FLEET_DIR(), 'orders', `${order.id}.json`), JSON.stringify(order, null, 1) + '\n');
    console.log(`FLEET_ORDER ${JSON.stringify(order)}`);
    const owners = loadOwners(), sides = [...new Set([order.from, order.to].map(n => owners.get(n.toLowerCase())?.side ?? 'local'))];
    const plans = Object.fromEntries(sides.map(s => [s, readJson(join(FLEET_DIR(), 'plans', `${s}.json`))])), snapshots = Object.fromEntries(sides.map(s => [s, readJson(join(FLEET_DIR(), 'snapshots', `${s}.json`))]));
    for (const w of orderWarnings(order, plans, snapshots, owners)) console.log(`FLEET_ORDER_WARN ${w}`);
}
