// Places a cross-machine transfer order in fleet/orders for scripts/fleet-trade.ts. Both accounts must be listed in
// fleet/owners.json on the same server; the window opens IN minutes from now and lasts MINUTES. The order is written
// with a FLEET_ORDER_WARN line for each party the sides' published plans (fleet/plans) show in an enabled job, since
// that side's fleet agent skips such an account until the job is off, and for a coin donor whose published snapshot
// holds fewer coins than the order: an order that no agent can run lapses at the end of its window unnoticed.
// Usage: bun scripts/fleet-order.ts <from> <to> <count> <item name...> [--with "<count> <item name>"]...
// Env: IN (default 15), MINUTES (default 40). Each --with adds a line that moves in the same trade (up to 28 lines).
// TAKER_WAITS=1 keeps the receiver offline until the giver is at the meet (both accounts on one side).
// MEET=<bank x>,<bank z> or MEET=<bank name> meets at that bank's tile pair (scripts/coin-courier.ts BANK_MEETS) instead
// of Varrock West: MEET=2619,3332 is the Ardougne north bank, where the PK army's accounts already stand; MEET=draynor.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLEET_DIR, loadOwners } from '../packages/core/src/fleet';
import { orderLines, validOrder, type Order } from './fleet-trade';
import type { OrderLine } from './fleet-trade-settlement';
import { BANK_MEETS, meetingTiles } from './coin-courier';

export function orderMeet(text: string | undefined): Order['meet'] {
    if (text === undefined || text === '') return undefined;
    const m = text.match(/^(\d+),(\d+)$/), named = BANK_MEETS.find(r => r.bank === text.toLowerCase());
    const pair = m ? meetingTiles({ x: Number(m[1]), z: Number(m[2]) }) : named ? meetingTiles({ x: named.tiles[0]![0], z: named.tiles[0]![1] }) : null;
    if (!pair) throw Error(`MEET must be a bank tile with a known meeting pair (3185,3436 or 2619,3332) or a bank name (${BANK_MEETS.map(r => r.bank).join(', ')}), not ${text}`);
    return pair;
}

export function makeOrder(from: string, to: string, count: number, item: string, now: number, inMin: number, minutes: number, owners = loadOwners(), meet?: Order['meet'], extra?: OrderLine[]): Order {
    const a = owners.get(from.toLowerCase()), b = owners.get(to.toLowerCase());
    if (!a || !b) throw Error(`both accounts must be listed in fleet/owners.json: ${!a ? from : to}`);
    if (a.server !== b.server) throw Error('both accounts must use one server');
    const start = now + inMin * 60_000, order: Order = { id: `${start}-${from}-${to}`.toLowerCase(), server: a.server, from, to, item, count, start, end: start + minutes * 60_000,
        ...(meet ? { meet } : {}), ...(extra?.length ? { extra } : {}) };
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
    const coinLine = orderLines(order).find(l => /^coins?$/i.test(l.item));
    if (coinLine) {
        const row = (snapshots[sideOf(order.from)]?.accounts ?? []).find((a: any) => typeof a?.name === 'string' && a.name.toLowerCase() === order.from.toLowerCase());
        const coins = row ? [...(row.bank ?? []), ...(row.inventory ?? [])].filter((i: any) => /^coins$/i.test(i?.name ?? '')).reduce((n: number, i: any) => n + (Number(i?.count) || 0), 0) : null;
        if (coins !== null && coins < coinLine.count) out.push(`${order.from} held ${coins} coins at its last snapshot, fewer than the ${coinLine.count} ordered`);
    }
    return out;
}

// `--with "<count> <item name>"`, once for each extra line. Returns the other arguments and the lines.
export function parseWith(args: readonly string[]): { rest: string[]; extra: OrderLine[] } {
    const rest: string[] = [], extra: OrderLine[] = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] !== '--with') { rest.push(args[i]!); continue; }
        const m = (args[++i] ?? '').trim().match(/^(\d+)\s+(.+)$/);
        if (!m) throw Error(`--with takes "<count> <item name>", not ${args[i] ?? 'nothing'}`);
        extra.push({ item: m[2]!.trim(), count: Number(m[1]) });
    }
    return { rest, extra };
}
const readJson = (f: string) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

if (import.meta.main) {
    const { rest, extra } = parseWith(process.argv.slice(2));
    const [from, to, countText, ...name] = rest;
    const made = makeOrder(from ?? '', to ?? '', Number(countText), name.join(' '), Date.now(), Number(process.env.IN ?? 15), Number(process.env.MINUTES ?? 40), undefined, orderMeet(process.env.MEET), extra);
    // TAKER_WAITS=1: the receiver stays offline until the giver is at the meet. The giver marks that on its own machine.
    const partySides = new Set([made.from, made.to].map(n => loadOwners().get(n.toLowerCase())?.side ?? 'local'));
    if (process.env.TAKER_WAITS === '1' && partySides.size !== 1) throw Error('TAKER_WAITS needs both accounts on one side');
    const order: Order = process.env.TAKER_WAITS === '1' ? { ...made, takerWaits: true } : made;
    mkdirSync(join(FLEET_DIR(), 'orders'), { recursive: true });
    writeFileSync(join(FLEET_DIR(), 'orders', `${order.id}.json`), JSON.stringify(order, null, 1) + '\n');
    console.log(`FLEET_ORDER ${JSON.stringify(order)}`);
    const owners = loadOwners(), sides = [...new Set([order.from, order.to].map(n => owners.get(n.toLowerCase())?.side ?? 'local'))];
    const plans = Object.fromEntries(sides.map(s => [s, readJson(join(FLEET_DIR(), 'plans', `${s}.json`))])), snapshots = Object.fromEntries(sides.map(s => [s, readJson(join(FLEET_DIR(), 'snapshots', `${s}.json`))]));
    for (const w of orderWarnings(order, plans, snapshots, owners)) console.log(`FLEET_ORDER_WARN ${w}`);
}
