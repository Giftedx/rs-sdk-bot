// What the brain remembers about past fleet trades, read from the order and receipt files.
// - A recipient keeps an item it received for RECEIVED_ITEM_HOLD_MS: the scheduler does not plan it as a donor of
//   that item (anti-ping-pong), so the item stays for the job that needed it. A demand that the item satisfied is
//   no longer active, and nothing else protects that stock. Coins are exempt: a coin bank that receives coins
//   keeps paying out, and the operating float rule (packages/brain/src/acquire.ts) protects a donor's own coins.
// - A trade that ended without settling backs off the party that caused it, for that item: the donor's
//   `hub:<hub>:<donor>` venue (every recipient), or the recipient's own `hub_banker` venue. The backoff is
//   TRANSFER_FAILURE_BASE_BACKOFF_MS, doubled for each other failure of that party and item in the lookback,
//   up to TRANSFER_FAILURE_MAX_BACKOFF_MS. A donor that cannot withdraw an item then gets no new order for it
//   in the next cycle.
import { orderLines, type Order, type Receipt } from '../../core/src/fleet-trade-settlement';
import {
    HUB_BANKER_LOCATIONS,
    marketCooldownKey,
    type HubBankId,
    type TransferOrder,
    type TransferOrderLine,
} from './contracts';
import { COINS_ITEM_ID, loadItemsMap } from './preflight';

export const RECEIVED_ITEM_HOLD_MS = 2 * 3_600_000;
export const TRANSFER_FAILURE_LOOKBACK_MS = 24 * 3_600_000;
export const TRANSFER_FAILURE_BASE_BACKOFF_MS = 30 * 60_000;
export const TRANSFER_FAILURE_MAX_BACKOFF_MS = 8 * 3_600_000;

// Receipt details that blame the partner, not the account that wrote the receipt.
const PARTNER_FAULT_RE = /partner failed|order window ended|no matching trade|partner .*before login/i;
// An owner pause ends the trade; it is not a fault of either party.
const OWNER_PAUSE_RE = /stop file/i;
// A party whose own walk to the meet failed ("route to 3182, 3440: precondition no route to 3182,3440,0", "ferry
// needs 60 coins and the bank holds 0") fails the same way with any item. Its backoff covers the hub, not one item:
// Quickhandjob failed four orders in a row to the Varrock meet, each for another item, and each order came 4 s after
// the last one failed, before the worker's no-route fact reached the outcome record.
const ROUTE_FAULT_RE = /\broute to -?\d+, -?\d+: |\bprecondition (?:no route to|(?:(?:westbound|eastbound) )?ferry needs)/;

// The cooldown key that holds a party out of every hub trade at `hub` (acct.cooldowns, acquire.ts hub_banker).
export const hubRouteCooldownKey = (hub: HubBankId): string => `route:hub:${hub}`;

const HUB_IDS = Object.keys(HUB_BANKER_LOCATIONS) as HubBankId[];

export type TransferEvent =
    | { readonly kind: 'received'; readonly at: number; readonly order: Order }
    | {
        readonly kind: 'failed';
        readonly at: number;
        readonly order: Order;
        readonly donorFault: boolean;
        readonly recipientFault: boolean;
        // The parties (lower case) whose own walk to the meet failed.
        readonly routeFault?: readonly string[];
    };

export interface TransferMemory {
    readonly recentTransfers: TransferOrder[];
    readonly marketCooldowns: Record<string, number>;
    readonly accountCooldowns: Record<string, Record<string, number>>;
}

export function inferHubFromOrder(order: Order): HubBankId {
    const meet = order.meet?.[0];
    if (meet) {
        const dArdy = Math.hypot(meet.x - HUB_BANKER_LOCATIONS.ardougne.bankTile.x, meet.z - HUB_BANKER_LOCATIONS.ardougne.bankTile.z);
        const dVarrock = Math.hypot(meet.x - HUB_BANKER_LOCATIONS.varrock_west.bankTile.x, meet.z - HUB_BANKER_LOCATIONS.varrock_west.bankTile.z);
        if (dArdy < dVarrock) return 'ardougne';
    }
    return 'varrock_west';
}

const sameName = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

function receiptFor(order: Order, receipts: readonly Receipt[], role: 'from' | 'to'): Receipt | undefined {
    let best: Receipt | undefined;
    for (const r of receipts) {
        if (!r || r.id !== order.id || r.role !== role || !sameName(r.account, order[role])) continue;
        if (!Number.isFinite(r.at)) continue;
        if (!best || r.at > best.at) best = r;
    }
    return best;
}

const isSettled = (r: Receipt | undefined): boolean =>
    !!r && (r.version === 2 ? r.state === 'settled' && r.ok === true : r.ok === true);

const isTerminalFailure = (r: Receipt | undefined): boolean =>
    !!r && (r.version === 2 ? r.state === 'failed' : r.ok === false);

// One event for an order, or null while it can still settle or once it is older than the lookback.
export function transferEvent(order: Order, receipts: readonly Receipt[], now: number): TransferEvent | null {
    const from = receiptFor(order, receipts, 'from');
    const to = receiptFor(order, receipts, 'to');
    if (isSettled(to)) {
        return to!.at <= now ? { kind: 'received', at: to!.at, order } : null;
    }
    if (isSettled(from)) return null;
    const ended = now >= order.end || (isTerminalFailure(from) && isTerminalFailure(to));
    if (!ended) return null;
    const at = Math.min(now, Math.max(from?.at ?? 0, to?.at ?? 0) || order.end);
    if (now - at >= TRANSFER_FAILURE_LOOKBACK_MS) return null;
    if ([from, to].some((r) => r && OWNER_PAUSE_RE.test(String(r.detail ?? '')))) return null;
    const ownFault = (r: Receipt | undefined) => !!r && !PARTNER_FAULT_RE.test(String(r.detail ?? ''));
    const donorOwn = ownFault(from);
    const recipientOwn = ownFault(to);
    // A party that wrote no receipt never reached the trade.
    let donorFault = donorOwn || (!from && !recipientOwn);
    let recipientFault = recipientOwn || (!to && !donorOwn);
    // Both reached the meet and blamed each other: the pair failed.
    if (!donorFault && !recipientFault) donorFault = recipientFault = true;
    const routeFault = ([[from, order.from], [to, order.to]] as const)
        .filter(([r]) => ownFault(r) && ROUTE_FAULT_RE.test(String(r!.detail ?? '')))
        .map(([, name]) => name.toLowerCase());
    return { kind: 'failed', at, order, donorFault, recipientFault, ...(routeFault.length ? { routeFault } : {}) };
}

// scripts/fleet-order.ts makes orders with an item name and no id (scripts/route-stage.ts). A name that exactly one
// tradeable item has gives that id. A name that several tradeable items share (Herb) gives none.
let tradeableIdByName: Map<string, number | null> | undefined;
export function uniqueTradeableItemId(name: string): number | undefined {
    if (!tradeableIdByName) {
        tradeableIdByName = new Map();
        for (const meta of loadItemsMap().values()) {
            if (!meta.tradeable || typeof meta.name !== 'string') continue;
            const key = meta.name.trim().toLowerCase();
            tradeableIdByName.set(key, tradeableIdByName.has(key) ? null : meta.id);
        }
    }
    return tradeableIdByName.get(name.trim().toLowerCase()) ?? undefined;
}

const linesWithIds = (order: Order): TransferOrderLine[] => {
    const out: TransferOrderLine[] = [];
    const seen = new Set<number>();
    for (const line of orderLines(order)) {
        const itemId = line.itemId ?? uniqueTradeableItemId(line.item);
        if (typeof itemId !== 'number' || !Number.isSafeInteger(itemId) || itemId < 0) continue;
        if (!Number.isSafeInteger(line.count) || line.count <= 0 || seen.has(itemId)) continue;
        seen.add(itemId);
        out.push({ itemId, itemName: line.item, count: line.count });
    }
    return out;
};

export function backoffUntil(failureTimes: readonly number[]): number {
    if (failureTimes.length === 0) return 0;
    const last = Math.max(...failureTimes);
    const ms = Math.min(TRANSFER_FAILURE_MAX_BACKOFF_MS, TRANSFER_FAILURE_BASE_BACKOFF_MS * 2 ** (failureTimes.length - 1));
    return last + ms;
}

export function transferMemory(events: readonly TransferEvent[], now: number): TransferMemory {
    const recentTransfers: TransferOrder[] = [];
    const donorFailures = new Map<string, { itemId: number; donor: string; times: number[] }>();
    const recipientFailures = new Map<string, { itemId: number; recipient: string; times: number[] }>();
    const routeFailures = new Map<string, { party: string; hub: HubBankId; times: number[] }>();

    for (const ev of events) {
        if (ev.at > now) continue;
        const lines = linesWithIds(ev.order);
        if (lines.length === 0) continue;
        if (ev.kind === 'received') {
            if (now - ev.at >= RECEIVED_ITEM_HOLD_MS) continue;
            const held = lines.filter((l) => l.itemId !== COINS_ITEM_ID);
            if (held.length === 0) continue;
            recentTransfers.push({
                id: ev.order.id,
                server: ev.order.server,
                from: ev.order.from,
                to: ev.order.to,
                hub: inferHubFromOrder(ev.order),
                items: held,
                demandId: `fleet-order:${ev.order.id}`,
                reason: `settled fleet order ${ev.order.item}`,
                createdAt: ev.order.start,
                expiresAt: Math.max(ev.order.end, ev.order.start + 1),
                state: 'settled',
                bothIdleVerified: true,
                donorLogoutConfirmedAt: 0,
                recipientLogoutConfirmedAt: ev.at,
                antiPingPong: { donorHoldsDemandForItems: false, cooldownWindowMs: RECEIVED_ITEM_HOLD_MS },
            });
            continue;
        }
        if (now - ev.at >= TRANSFER_FAILURE_LOOKBACK_MS) continue;
        for (const party of ev.routeFault ?? []) {
            const hub = inferHubFromOrder(ev.order), key = `${party}|${hub}`;
            const rec = routeFailures.get(key) ?? { party, hub, times: [] };
            rec.times.push(ev.at);
            routeFailures.set(key, rec);
        }
        for (const line of lines) {
            if (ev.donorFault) {
                const donor = ev.order.from.toLowerCase();
                const key = `${line.itemId}|${donor}`;
                const rec = donorFailures.get(key) ?? { itemId: line.itemId, donor, times: [] };
                rec.times.push(ev.at);
                donorFailures.set(key, rec);
            }
            if (ev.recipientFault) {
                const recipient = ev.order.to.toLowerCase();
                const key = `${line.itemId}|${recipient}`;
                const rec = recipientFailures.get(key) ?? { itemId: line.itemId, recipient, times: [] };
                rec.times.push(ev.at);
                recipientFailures.set(key, rec);
            }
        }
    }

    const marketCooldowns: Record<string, number> = {};
    for (const { itemId, donor, times } of donorFailures.values()) {
        const until = backoffUntil(times);
        if (until <= now) continue;
        for (const hub of HUB_IDS) {
            const key = marketCooldownKey(itemId, `hub:${hub}:${donor}`);
            marketCooldowns[key] = Math.max(marketCooldowns[key] ?? 0, until);
        }
    }
    const accountCooldowns: Record<string, Record<string, number>> = {};
    for (const { itemId, recipient, times } of recipientFailures.values()) {
        const until = backoffUntil(times);
        if (until <= now) continue;
        const key = marketCooldownKey(itemId, 'hub_banker');
        const acct = (accountCooldowns[recipient] ??= {});
        acct[key] = Math.max(acct[key] ?? 0, until);
    }
    for (const { party, hub, times } of routeFailures.values()) {
        const until = backoffUntil(times);
        if (until <= now) continue;
        const key = hubRouteCooldownKey(hub);
        const acct = (accountCooldowns[party] ??= {});
        acct[key] = Math.max(acct[key] ?? 0, until);
    }
    return { recentTransfers, marketCooldowns, accountCooldowns };
}
