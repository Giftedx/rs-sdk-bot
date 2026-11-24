// Places a cross-machine transfer order in fleet/orders for scripts/aio-logistics.ts (fleet-trade). Both accounts must be listed in
// fleet/owners.json on the same server; the window opens IN minutes from now and lasts MINUTES. The order is written
// with a FLEET_ORDER_WARN line for each party the sides' published plans (fleet/plans) show in an enabled job, since
// that side's fleet agent skips such an account until the job is off, and for a coin donor whose published snapshot
// holds fewer coins than the order: an order that no agent can run lapses at the end of its window unnoticed.
// Usage: bun scripts/fleet-order.ts <from> <to> <count> <item name...> [--id <itemId>] [--with "<count> <item name>"]... [--with-id <itemId> "<count> <item name>"]...
// Env: IN (default 15), MINUTES (default 40). Each --with adds a line that moves in the same trade (up to 28 lines).
// TAKER_WAITS=1 keeps the receiver offline until the giver is at the meet (both accounts on one side).
// MEET=<bank x>,<bank z> or MEET=<bank name> meets at that bank's tile pair (BANK_MEETS) instead
// of Varrock West: MEET=2619,3332 is the Ardougne north bank, where the PK army's accounts already stand; MEET=draynor.
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { FLEET_DIR, loadOwners } from '../packages/core/src/fleet';
import { BANK_MEETS, meetingTiles, orderLines, validOrder, type Order, type OrderLine } from '../packages/workers/src/logistics';

export function orderMeet(text: string | undefined): Order['meet'] {
    if (text === undefined || text === '') return undefined;
    const m = text.match(/^(\d+),(\d+)$/), named = BANK_MEETS.find(r => r.bank === text.toLowerCase());
    const pair = m ? meetingTiles({ x: Number(m[1]), z: Number(m[2]) }) : named ? meetingTiles({ x: named.tiles[0]![0], z: named.tiles[0]![1] }) : null;
    if (!pair) throw Error(`MEET must be a bank tile with a known meeting pair (3185,3436 or 2619,3332) or a bank name (${BANK_MEETS.map(r => r.bank).join(', ')}), not ${text}`);
    return pair;
}

// The item names that the server never lets a player trade: every item of that name has tradeable:false in
// knowledge/items.json (the ammo mould among them). A trade of one ends `reconcile 0/1` on both sides after both
// accounts walked to the meet. A name that one tradeable item shares stays allowed.
let untradeableNames: Set<string> | undefined;
let itemRows: { id: number; name?: string; tradeable?: boolean }[] | undefined;
const loadItemRows = (): { id: number; name?: string; tradeable?: boolean }[] => itemRows ??= JSON.parse(readFileSync(join(import.meta.dir, '..', 'knowledge', 'items.json'), 'utf8'));
export function untradeable(item: string): boolean {
    if (!untradeableNames) {
        const rows = loadItemRows();
        const tradeable = new Set(rows.filter(i => i.tradeable !== false && typeof i.name === 'string').map(i => i.name!.toLowerCase()));
        untradeableNames = new Set(rows.filter(i => i.tradeable === false && typeof i.name === 'string').map(i => i.name!.toLowerCase()).filter(n => !tradeable.has(n)));
    }
    return untradeableNames.has(item.toLowerCase());
}
export function untradeableId(itemId: number): boolean {
    const row = loadItemRows().find(r => r.id === itemId);
    return !!row && row.tradeable === false;
}

export function makeOrder(from: string, to: string, count: number, item: string, now: number, inMin: number, minutes: number, owners = loadOwners(), meet?: Order['meet'], extra?: OrderLine[], itemId?: number): Order {
    if (itemId !== undefined && (!Number.isSafeInteger(itemId) || itemId < 0)) throw Error(`invalid itemId: ${itemId}`);
    const refused = [
        ...(itemId !== undefined ? (untradeableId(itemId) ? [`${item}#${itemId}`] : []) : untradeable(item) ? [item] : []),
        ...(extra ?? []).flatMap(l => l.itemId !== undefined ? (untradeableId(l.itemId) ? [`${l.item}#${l.itemId}`] : []) : untradeable(l.item) ? [l.item] : []),
    ];
    if (refused.length) throw Error(`not tradeable: ${refused.join(', ')}`);
    const a = owners.get(from.toLowerCase()), b = owners.get(to.toLowerCase());
    if (!a || !b) throw Error(`both accounts must be listed in fleet/owners.json: ${!a ? from : to}`);
    if (a.server !== b.server) throw Error('both accounts must use one server');
    const start = now + inMin * 60_000, order: Order = { id: `${start}-${from}-${to}-${randomBytes(8).toString('hex')}`.toLowerCase(), server: a.server, from, to, item, count,
        ...(itemId !== undefined ? { itemId } : {}), start, end: start + minutes * 60_000,
        ...(meet ? { meet } : {}), ...(extra?.length ? { extra } : {}) };
    if (!validOrder(order)) throw Error('invalid order');
    return order;
}

// Publish a complete order once. Its id binds trade claims and receipts, so replacing its contents would change an
// existing attempt. A hard link exposes the flushed file atomically and refuses a destination that already exists.
export function writeFleetOrder(directory: string, order: Order): string {
    if (!validOrder(order)) throw Error('invalid order');
    mkdirSync(directory, { recursive: true });
    const file = join(directory, `${order.id}.json`), temporary = join(directory, `.${order.id}-${randomUUID()}.tmp`);
    const descriptor = openSync(temporary, 'wx');
    try {
        try { writeFileSync(descriptor, JSON.stringify(order, null, 1) + '\n'); fsyncSync(descriptor); }
        finally { closeSync(descriptor); }
        linkSync(temporary, file);
        return file;
    } finally { rmSync(temporary, { force: true }); }
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
    const { rest, extra } = parseOrderArgs(args);
    return { rest, extra };
}
export function parseOrderArgs(args: readonly string[]): { rest: string[]; extra: OrderLine[]; itemId?: number } {
    const rest: string[] = [], extra: OrderLine[] = [];
    let itemId: number | undefined;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--id') {
            const raw = (args[++i] ?? '').trim();
            const parsed = Number(raw);
            if (!raw || !Number.isSafeInteger(parsed) || parsed < 0) throw Error(`--id takes a nonnegative integer, not ${args[i] ?? 'nothing'}`);
            itemId = parsed;
            continue;
        }
        if (args[i] === '--with-id') {
            const idRaw = (args[++i] ?? '').trim(), specRaw = (args[++i] ?? '').trim();
            const lineId = Number(idRaw), m = specRaw.match(/^(\d+)\s+(.+)$/);
            if (!idRaw || !Number.isSafeInteger(lineId) || lineId < 0 || !m) throw Error(`--with-id takes <itemId> "<count> <item name>", not ${args[i - 1] ?? ''} ${args[i] ?? ''}`);
            extra.push({ item: m[2]!.trim(), count: Number(m[1]), itemId: lineId });
            continue;
        }
        if (args[i] !== '--with') { rest.push(args[i]!); continue; }
        const m = (args[++i] ?? '').trim().match(/^(\d+)\s+(.+)$/);
        if (!m) throw Error(`--with takes "<count> <item name>", not ${args[i] ?? 'nothing'}`);
        extra.push({ item: m[2]!.trim(), count: Number(m[1]) });
    }
    return { rest, extra, ...(itemId !== undefined ? { itemId } : {}) };
}
const readJson = (f: string) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

if (import.meta.main) {
    const { rest, extra, itemId } = parseOrderArgs(process.argv.slice(2));
    const [from, to, countText, ...name] = rest;
    if (!from || !to || !countText || name.length === 0) {
        console.error('usage: bun scripts/fleet-order.ts <from> <to> <count> <item name...> [--id <itemId>] [--with "<count> <item name>"]... [--with-id <itemId> "<count> <item name>"]...');
        process.exit(2);
    }
    const inMin = Number(process.env.IN ?? 15);
    const minutes = Number(process.env.MINUTES ?? 40);
    if (!Number.isFinite(inMin) || inMin < 0 || !Number.isFinite(minutes) || minutes <= 0) {
        console.error('fleet-order: IN must be finite >= 0 and MINUTES must be finite > 0');
        process.exit(2);
    }
    const made = makeOrder(from, to, Number(countText), name.join(' '), Date.now(), inMin, minutes, undefined, orderMeet(process.env.MEET), extra, itemId);
    // TAKER_WAITS=1: the receiver stays offline until the giver is at the meet. The giver marks that on its own machine.
    const partySides = new Set([made.from, made.to].map(n => loadOwners().get(n.toLowerCase())?.side ?? 'local'));
    if (process.env.TAKER_WAITS === '1' && partySides.size !== 1) throw Error('TAKER_WAITS needs both accounts on one side');
    const order: Order = process.env.TAKER_WAITS === '1' ? { ...made, takerWaits: true } : made;
    writeFleetOrder(join(FLEET_DIR(), 'orders'), order);
    console.log(`FLEET_ORDER ${JSON.stringify(order)}`);
    const owners = loadOwners(), sides = [...new Set([order.from, order.to].map(n => owners.get(n.toLowerCase())?.side ?? 'local'))];
    const plans = Object.fromEntries(sides.map(s => [s, readJson(join(FLEET_DIR(), 'plans', `${s}.json`))])), snapshots = Object.fromEntries(sides.map(s => [s, readJson(join(FLEET_DIR(), 'snapshots', `${s}.json`))]));
    for (const w of orderWarnings(order, plans, snapshots, owners)) console.log(`FLEET_ORDER_WARN ${w}`);
}
