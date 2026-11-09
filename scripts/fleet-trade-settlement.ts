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
        && Number.isSafeInteger(o.start) && Number.isSafeInteger(o.end) && o.end > o.start;
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
