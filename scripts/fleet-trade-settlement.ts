import { linkSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Tile = { x: number; z: number; level: number };
export type Order = { id: string; server: string; from: string; to: string; item: string; count: number; start: number; end: number; meet?: [Tile, Tile] };
export type TradeRole = 'from' | 'to';
type LegacyReceipt = { id: string; account: string; role: TradeRole; side: string; ok: boolean; count: number; at: number; detail: string; version?: never };
export type TradeReceipt = Omit<LegacyReceipt, 'version'> & {
    version: 2; state: 'prepared' | 'settled' | 'failed' | 'reconcile';
    server: string; partner: string; item: string; requested: number; claim: string;
    inventory?: { before: number; after: number };
    bank?: { count: number; at: number };
    logout?: { attemptId: string; at: number; sha256: string };
};
export type Receipt = LegacyReceipt | TradeReceipt;

export function validOrder(o: any): o is Order {
    return !!o && typeof o.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(o.id) && typeof o.server === 'string'
        && [o.from, o.to].every(n => typeof n === 'string' && /^[A-Za-z0-9]{1,12}$/.test(n))
        && o.from.toLowerCase() !== o.to.toLowerCase() && typeof o.item === 'string' && o.item.trim().length > 0
        && Number.isSafeInteger(o.count) && o.count > 0 && o.count <= 2147483647
        && Number.isSafeInteger(o.start) && Number.isSafeInteger(o.end) && o.end > o.start
        && (o.meet === undefined || Array.isArray(o.meet) && o.meet.length === 2 && o.meet.every((t: any) => !!t && [t.x, t.z, t.level].every(Number.isSafeInteger)));
}

export function writeTradeReceipt(dir: string, receipt: TradeReceipt) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, receipt.id + '.' + receipt.role + '.json'), tmp = file + '.tmp-' + process.pid;
    writeFileSync(tmp, JSON.stringify(receipt, null, 1) + '\n', { flag: 'wx', flush: true });
    try {
        if (receipt.state === 'prepared') linkSync(tmp, file);
        else renameSync(tmp, file);
    } finally { rmSync(tmp, { force: true }); }
}

const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const quantity = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
export function terminalTradeReceipt(order: Order, role: TradeRole, receipt: Receipt, now: number): receipt is TradeReceipt {
    if (receipt.version !== 2 || receipt.id !== order.id || receipt.role !== role || !same(receipt.account, order[role])
        || !same(receipt.partner, order[role === 'from' ? 'to' : 'from']) || !same(receipt.server, order.server)
        || !same(receipt.item, order.item) || receipt.requested !== order.count
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(receipt.claim)
        || !Number.isSafeInteger(receipt.at) || receipt.at < order.start || receipt.at > now
        || !receipt.logout || !/^\d{13}-\d{1,10}-\d{1,10}$/.test(receipt.logout.attemptId)
        || !/^[a-f0-9]{64}$/.test(receipt.logout.sha256)
        || !Number.isSafeInteger(receipt.logout.at) || receipt.logout.at < order.start || receipt.logout.at > receipt.at) return false;
    if (receipt.bank && (!quantity(receipt.bank.count) || receipt.bank.count <= 0 || receipt.bank.count > order.count
        || !Number.isSafeInteger(receipt.bank.at) || receipt.bank.at < order.start || receipt.bank.at > receipt.logout.at)) return false;
    if (receipt.state === 'failed') return receipt.ok === false && receipt.count === 0
        && (!receipt.inventory || quantity(receipt.inventory.before) && receipt.inventory.before === receipt.inventory.after);
    if (receipt.state !== 'settled' || receipt.ok !== true || receipt.count !== order.count || !receipt.inventory
        || !quantity(receipt.inventory.before) || !quantity(receipt.inventory.after)) return false;
    const delta = receipt.inventory.after - receipt.inventory.before;
    if (role === 'from') return delta === -order.count;
    return delta === order.count && receipt.bank?.count === order.count;
}

export function tradeSettlement(order: Order, receipts: readonly Receipt[], now: number):
    { state: 'settled' | 'failed'; receipts: [TradeReceipt, TradeReceipt] }
    | { state: 'pending' | 'reconcile' | 'legacy'; receipts: Receipt[] } {
    const matching = receipts.filter(r => r?.id === order.id);
    if (matching.some(r => r.version !== undefined && r.version !== 2)) return {state: 'reconcile', receipts: matching};
    const from = matching.filter(r => terminalTradeReceipt(order, 'from', r, now));
    const to = matching.filter(r => terminalTradeReceipt(order, 'to', r, now));
    if (matching.length === 2 && from.length === 1 && to.length === 1 && from[0]!.state === to[0]!.state) {
        return { state: from[0]!.ok ? 'settled' : 'failed', receipts: [from[0]!, to[0]!] };
    }
    const current = matching.filter(r => r.version === 2);
    if (!current.length) return { state: 'legacy', receipts: matching };
    const reconcile = now >= order.end || current.some(r => r.state !== 'prepared' && !terminalTradeReceipt(order, r.role, r, now))
        || from.length > 0 && to.length > 0 || matching.length > 2;
    return { state: reconcile ? 'reconcile' : 'pending', receipts: matching };
}

// Orders that close after their window without a matched pair of receipts, because the receipts they have prove what
// moved. tradeSettlement leaves both in `reconcile`, and the planner then holds their accounts with no job.
// - One party failed with nothing moved and the other has no receipt: nothing moved, and the window is over. A party
//   that started and went silent still holds its trade claim, which holds the order for the planner.
// - A retry overlapped the first order (README: a retry takes a new order id). Of two orders with the same parties,
//   item and count, one has the giver's settled receipt and the taker's failed one, the other the reverse. Together
//   they are one transfer: the giver gave once and the taker took once. `receipts` are the two settled ones.
// A receipt that is not terminal (`prepared`, or `reconcile`) keeps its trade claim held. Fleet sync releases a claim
// for a terminal receipt, and for a dropped session whose partner's failed receipt proves nothing moved
// (scripts/fleet-sync.ts droppedTradeClaims); any other is released by the hand procedure in the README, after
// someone reconciled the account. Such a receipt whose claim is no longer held counts as no receipt here.
// `claimHeld` takes the receipt's claim nonce; without it every such receipt counts as still claimed.
export type WindowClosure = { state: 'failed'; receipts: [] } | { state: 'settled'; receipts: [TradeReceipt, TradeReceipt] };
export function windowClosures(orders: readonly Order[], receipts: readonly Receipt[], now: number,
    claimHeld: (nonce: string) => boolean = () => true): Map<string, WindowClosure> {
    const closed = new Map<string, WindowClosure>(), halves: { order: Order; giver: boolean; receipt: TradeReceipt }[] = [];
    for (const order of orders) {
        if (now < order.end || tradeSettlement(order, receipts, now).state !== 'reconcile') continue;
        const matching = receipts.filter(r => r?.id === order.id && !(r.version === 2 && (r.state === 'prepared' || r.state === 'reconcile') && !claimHeld(r.claim)));
        const terminal = (role: TradeRole) => matching.filter(r => terminalTradeReceipt(order, role, r, now)) as TradeReceipt[];
        const from = terminal('from'), to = terminal('to');
        if (!matching.length || matching.length === 1 && from.length + to.length === 1 && [...from, ...to][0]!.state === 'failed') closed.set(order.id, { state: 'failed', receipts: [] });
        else if (matching.length === 2 && from.length === 1 && to.length === 1 && from[0]!.state !== to[0]!.state)
            halves.push(from[0]!.state === 'settled' ? { order, giver: true, receipt: from[0]! } : { order, giver: false, receipt: to[0]! });
    }
    const same = (a: Order, b: Order) => a.server === b.server && a.from.toLowerCase() === b.from.toLowerCase() && a.to.toLowerCase() === b.to.toLowerCase()
        && a.item.toLowerCase() === b.item.toLowerCase() && a.count === b.count;
    for (const gave of halves.filter(h => h.giver)) {
        const took = halves.find(h => !h.giver && !closed.has(h.order.id) && same(h.order, gave.order));
        if (!took) continue;
        const closure: WindowClosure = { state: 'settled', receipts: [gave.receipt, took.receipt] };
        closed.set(gave.order.id, closure); closed.set(took.order.id, closure);
    }
    return closed;
}
