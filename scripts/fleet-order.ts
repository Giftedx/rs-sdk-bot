// Places a cross-machine transfer order in fleet/orders for scripts/fleet-trade.ts. Both accounts must be listed in
// fleet/owners.json on the same server; the window opens IN minutes from now and lasts MINUTES.
// Usage: bun scripts/fleet-order.ts <from> <to> <count> <item name...>   Env: IN (default 15), MINUTES (default 40)
import { mkdirSync, writeFileSync } from 'node:fs';
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

if (import.meta.main) {
    const [from, to, countText, ...name] = process.argv.slice(2);
    const order = makeOrder(from ?? '', to ?? '', Number(countText), name.join(' '), Date.now(), Number(process.env.IN ?? 15), Number(process.env.MINUTES ?? 40));
    mkdirSync(join(FLEET_DIR(), 'orders'), { recursive: true });
    writeFileSync(join(FLEET_DIR(), 'orders', `${order.id}.json`), JSON.stringify(order, null, 1) + '\n');
    console.log(`FLEET_ORDER ${JSON.stringify(order)}`);
}
