// Pure logistics helpers for couriers, allocation, routing, funding, payout preparation, and fleet orders.
import { randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { COOKED_FOOD_BASE_IDS, foodStock, hasDelivery, hasPayout, selectCookedFoodSource, type DemandNear } from '../../../core/src/bank-demand';
import { countItems, serverFromEnv } from '../../../core/src/bot';
import { cargoAccountServer, exactItem } from '../../../core/src/cargo';
import { depositObserved } from '../../../core/src/deposit';
import { FLEET_DIR } from '../../../core/src/fleet';
import {
    clearPreloginFailure,
    orderLines,
    readPreloginFailure,
    validOrder,
    writePreloginFailure,
    writeTradeReceipt,
    type Order,
    type PreloginFailure,
    type Receipt,
    type TradeLine,
    type TradeReceipt,
    type TradeRole,
} from '../../../core/src/fleet-trade-settlement';
import type { Session } from '../../../core/src/inprocess';
import { laterProcessHolds, processStartTimes } from '../../../core/src/proc';
import { liveLogoutRef } from '../../../core/src/session-admission';
import { fleetStateFile } from '../../../core/src/practice-paths';
import { readLogoutProof } from '../../../core/src/session-lifecycle';
import { pidAlive } from '../../../core/src/session-takeover';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { ownedAccounts } from '../../../core/src/tradeguard';
import type { Tile } from '../../../core/src/world';
import { withExecutionDeadline } from '../../../../vendor/rs-sdk/sdk/execution-context';
import type { TradeItem, TradeResult } from '../../../../vendor/rs-sdk/sdk/types';
import { ACCOUNT_NAME_RE, parseHandoff } from './admission';
import { meetingTiles } from './location';
import { REPO_ROOT } from './types';

export {
    clearPreloginFailure,
    orderLines,
    readPreloginFailure,
    validOrder,
    writePreloginFailure,
    writeTradeReceipt,
    type Order,
    type PreloginFailure,
    type Receipt,
    type TradeLine,
    type TradeReceipt,
    type TradeRole,
};

// --- Coin / Fan-out / Fan-in / Note-Courier Preflight Helpers ---

export function parseCoins(args: string[]) {
    const [from, to, amount, ...options] = args;
    if (!amount || !/^\d+$/.test(amount) || Number(amount) > 2147483647) throw Error('positive exact coin amount required');
    const reserves = options.filter(option => option.split('=')[0] === '--reserve');
    if (reserves.length > 1) throw Error('duplicate coin reserve option');
    const text = reserves[0]?.slice('--reserve='.length) ?? '0', reserve = Number(text);
    if (reserves.length && (!reserves[0]!.startsWith('--reserve=') || !/^\d+$/.test(text)) || !Number.isSafeInteger(reserve) || reserve < 0 || reserve > 2147483647) {
        throw Error('coin donor bank reserve must be an integer from 0 to 2147483647');
    }
    const rest = options.filter(option => option.split('=')[0] !== '--reserve');
    const defaults = ['--bank-x=3185', '--bank-z=3436'].filter(d => !rest.some(o => o.split('=')[0] === d.split('=')[0]));
    const c = parseHandoff([from ?? '', to ?? '', `${amount}:Coins`, ...defaults, ...rest]);
    if (c.notes || c.keep) throw Error('coin courier does not accept notes or keep options');
    return { ...c, amount: Number(amount), reserve };
}

const coinsIn = (items: { id: number; count: number }[]) => items.filter(i => i.id === 995).reduce((n, i) => n + i.count, 0);
export type CoinState = { bank: number; pack: number };

export function exactCoinDelta(before: CoinState[], after: CoinState[], amount: number, reserve = 0): boolean {
    return Number.isSafeInteger(amount) && amount > 0 && before.length === 2 && after.length === 2
        && Number.isSafeInteger(reserve) && reserve >= 0 && reserve <= 2147483647 && after[0]!.bank >= reserve
        && [...before, ...after].every(s => Number.isSafeInteger(s.bank) && s.bank >= 0 && Number.isSafeInteger(s.pack) && s.pack >= 0)
        && before[0]!.bank - after[0]!.bank === amount && after[1]!.bank - before[1]!.bank === amount
        && before.every((s, i) => s.pack === after[i]!.pack);
}

export async function prepareCoinSlot(s: Session, check: () => void) {
    check();
    const pack = s.sdk.getInventory();
    if (coinsIn(pack) || pack.length < 28) return;
    const item = pack.find(i => pack.filter(other => other.id === i.id).length === 1) ?? pack.at(-1)!;
    await depositObserved(s, item);
    if (!await waitUntil(s, () => { check(); return s.sdk.getInventory().length < 28; }, { timeoutTicks: 20 })) {
        throw Error(`coin pack full: ${s.name}`);
    }
}

export function coinTradeObservation(s: Session, partnerName: string) {
    const state = s.sdk.getState(), player = state?.player;
    const partner = s.sdk.findNearbyPlayer(exactItem(partnerName));
    const bank = s.bankObservation?.();
    return {
        account: s.name,
        tick: s.tick(),
        position: player ? { x: player.worldX, z: player.worldZ, level: player.level } : null,
        partner: partner ? { name: partner.name, index: partner.index, x: partner.x, z: partner.z, distance: partner.distance, reachable: partner.reachable ?? null } : null,
        bankOpen: state?.bank?.isOpen ?? null,
        bank: bank ? { generation: bank.generation, coins: coinsIn(bank.items) } : null,
        pack: coinsIn(s.sdk.getInventory()),
        trade: s.sdk.getTradeState(),
    };
}

export function courierRecord(c: { donor: string; receiver: string }, argv: string[], env: Record<string, string | undefined>) {
    const normalizedArgv = argv[0] === 'coin-courier' ? argv : ['coin-courier', ...argv];
    return { script: 'scripts/aio-logistics.ts', argv: normalizedArgv, env: { ...env, COORDINATOR_PARTICIPANTS: JSON.stringify([c.donor, c.receiver]) } };
}

export function parseFanout(args: string[]) {
    const [donor, ...rest] = args, amount = rest.at(-1), receivers = rest.slice(0, -1);
    if (!donor || !amount || !/^\d+$/.test(amount) || !receivers.length) throw Error('usage: coin-fanout <donor> <receiver> [receiver ...] <amount>');
    if (new Set([donor, ...receivers].map(n => n.toLowerCase())).size !== receivers.length + 1) throw Error('each account once');
    return { donor, receivers, pairs: receivers.map(r => parseCoins([donor, r, amount])) };
}

export function parseFanin(args: string[]) {
    const item = args.at(-1), [receiver, ...donors] = args.slice(0, -1);
    if (!receiver || !donors.length || !item || /^\d+$/.test(item)) throw Error('usage: item-fanin <receiver> <donor> [donor ...] <item name>');
    if (new Set([receiver, ...donors].map(n => n.toLowerCase())).size !== donors.length + 1) throw Error('each account once');
    for (const donor of donors) parseHandoff([donor, receiver, '1:' + item]);
    return { receiver, donors, item };
}

export const heldItems = (items: readonly { id: number; count: number }[], id: number) =>
    items.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);

// --- Courier Cargo, Separation, Allocation, Route & Purchase Helpers ---

type CargoItem = { id?: number; name: string; count: number };
type SlotItem = { id: number; name: string; count: number; slot: number };
export interface SeparationDeps {
    inventory(): readonly SlotItem[];
    bank(): readonly SlotItem[] | null;
    openBank(): Promise<boolean>;
    closeBank(): Promise<boolean>;
    deposit(item: SlotItem): Promise<boolean>;
    withdraw(item: SlotItem, count: number): Promise<boolean>;
    tradeNotes(count: number): Promise<{ success: boolean; given: number }>;
    observed(predicate: () => boolean): Promise<boolean>;
}

export async function separateTroutNotes(d: SeparationDeps): Promise<number> {
    const count = (items: readonly SlotItem[], id: number) => items.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const food = count(d.inventory(), 333), notes = count(d.inventory(), 334);
    const fail = (why: string) => new Error(`no delivery progress: need-bank-separation ${why}`);
    if (!food || !notes || d.inventory().some(i => /^trout$/i.test(i.name) && i.id !== 333 && i.id !== 334)) throw fail('identity unknown');
    if (!await d.openBank() || !d.bank()) throw fail('bank readiness unknown');
    const bankBefore = count(d.bank()!, 333);
    let problem: unknown;
    try {
        const item = d.inventory().find(i => i.id === 333);
        if (!item || !await d.deposit(item) || !await d.observed(() => count(d.inventory(), 333) === 0
            && count(d.inventory(), 334) === notes && !!d.bank() && count(d.bank()!, 333) === bankBefore + food)) throw fail('deposit not conserved');
        if (!await d.closeBank()) throw fail('cannot close bank');
        const trade = await d.tradeNotes(notes);
        if (!trade.success || trade.given !== notes || !await d.observed(() => count(d.inventory(), 333) === 0 && count(d.inventory(), 334) === 0)) {
            throw fail('notes transfer not verified');
        }
    } catch (e) {
        problem = e;
    } finally {
        const missing = food - count(d.inventory(), 333);
        if (missing < 0) throw fail('restore inventory changed');
        if (missing > 0) {
            if (!await d.openBank() || !d.bank() || count(d.bank()!, 333) !== bankBefore + missing) throw fail('restore bank delta unknown; food remains banked');
            const item = d.bank()!.find(i => i.id === 333);
            if (!item || !await d.withdraw(item, missing) || !await d.observed(() => count(d.inventory(), 333) === food
                && !!d.bank() && count(d.bank()!, 333) === bankBefore)) throw fail('restore incomplete; inspect banked working food');
        } else if (!d.bank() || count(d.bank()!, 333) !== bankBefore) {
            throw fail('bank conservation unknown');
        }
        if (!await d.closeBank()) throw fail('restore cannot close bank');
    }
    if (problem) throw problem;
    return notes;
}

type DeliveryJob = { account?: string; accounts?: string[]; script?: string; args?: string[]; goal?: string; enabled?: boolean; env?: Record<string, string> };

export function retainedTrout(env: Record<string, string | undefined> = {}): number {
    const raw = env.RETAIN_TROUT ?? '2';
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('invalid RETAIN_TROUT');
    return Number(raw);
}

export function courierCargo(inventory: readonly CargoItem[], reserve: number): { items: { name: string; count: number }[]; blocked: string[] } {
    const valid = inventory.filter(i => i && typeof i.name === 'string' && Number.isSafeInteger(i.count) && i.count > 0 && !/^coins$/i.test(i.name));
    const food = valid.filter(i => /^trout$/i.test(i.name));
    if (reserve > 0 && food.some(i => !Number.isSafeInteger(i.id))) return { items: [], blocked: ['Trout: identity unknown'] };
    const unnoted = food.filter(i => i.id === 333).reduce((n, i) => n + i.count, 0);
    if (reserve > 0 && unnoted > 0 && food.some(i => i.id !== 333)) return { items: [], blocked: ['Trout: need-bank-separation'] };
    const amounts = new Map<string, { name: string; count: number }>();
    let left = reserve;
    for (const i of valid) {
        const kept = i.id === 333 ? Math.min(left, i.count) : 0;
        left -= kept;
        const count = i.count - kept;
        if (count <= 0) continue;
        const key = i.name.toLowerCase(), prior = amounts.get(key);
        amounts.set(key, { name: prior?.name ?? i.name, count: (prior?.count ?? 0) + count });
    }
    return { items: [...amounts.values()], blocked: [] };
}

export function courierDeliveryWaiting(
    names: readonly string[],
    near?: DemandNear,
    jobs?: readonly DeliveryJob[],
    readStatus = (name: string): any => JSON.parse(readFileSync(resolve(REPO_ROOT, '.practice/status', `${name}.json`), 'utf8')),
    now = Date.now(),
): boolean {
    if (!jobs) {
        try {
            const plan = JSON.parse(readFileSync(resolve(REPO_ROOT, 'swarm.json'), 'utf8'));
            if (!Array.isArray(plan.jobs)) throw new Error('missing jobs');
            jobs = plan.jobs;
        } catch {
            console.warn('DELIVERY demand unknown: cannot read swarm plan');
            return false;
        }
    }
    return names.some(name => {
        if (!ACCOUNT_NAME_RE.test(name)) return false;
        try {
            const status = readStatus(name);
            const job = jobs!.find(j => [...(j.accounts ?? []), j.account ?? ''].some(a => a.toLowerCase() === name.toLowerCase()));
            const file = (path: string) => path.replaceAll('\\', '/').split('/').at(-1);
            const script = job?.script && file(job.script);
            const role = script === 'aio-logistics.ts'
                ? job?.args?.find(a => !a.includes('=') && !a.startsWith('-'))?.toLowerCase()
                : undefined;
            const isFoodCourier = script === 'foodcourier.ts' || role === 'food-courier';
            const isNoteCourier = script === 'note-courier.ts' || role === 'note-courier';
            if (isFoodCourier && job?.env?.OUTBOUND_ONLY === '1') return false;
            if (!isNoteCourier) return hasDelivery(status, now, near);
            const goal = typeof status?.goal === 'string' ? status.goal.trim() : '';
            const matchesGoalScript = !!goal && (
                file(goal) === script
                || (script === 'aio-logistics.ts' && file(goal) === 'note-courier.ts')
            );
            if (!goal || !(matchesGoalScript || (!goal.endsWith('.ts') && goal === job?.goal?.trim()))) return false;
            const cargo = courierCargo(status?.inventory ?? [], retainedTrout(job?.env));
            return cargo.blocked.length === 0 && hasDelivery({ ...status, inventory: cargo.items }, now, near);
        } catch {
            return false;
        }
    });
}

export function courierFoodAllocation(counts: readonly number[], need: number, perType = 0, total = 0): number[] {
    if ([need, perType, total, ...counts].some(n => !Number.isSafeInteger(n) || n < 0)) throw Error('Invalid courier food budget');
    let remaining = Math.min(need, total > 0 ? total : Infinity);
    return counts.map(count => {
        const amount = Math.min(remaining, count, perType > 0 ? perType : Infinity);
        remaining -= amount;
        return amount;
    });
}

export function noteCourierPreflight(
    argv: readonly string[],
    env: Record<string, string | undefined> = process.env,
    deps: { serverOf: (name: string) => string; owned: (server: string) => ReadonlySet<string> } = { serverOf: cargoAccountServer, owned: ownedAccounts },
) {
    const courierName = argv[0] ?? 'Bigpackage', bankerName = argv[1] ?? 'Moneyshot';
    if (![courierName, bankerName].every(name => ACCOUNT_NAME_RE.test(name)) || courierName.toLowerCase() === bankerName.toLowerCase()) {
        throw Error('note courier requires distinct valid courier and banker accounts');
    }
    const cap = Number(argv[2] ?? env.CAP ?? 15000), maxDeliveries = env.MAX_DELIVERIES === undefined ? undefined : Number(env.MAX_DELIVERIES);
    if (!Number.isSafeInteger(cap) || cap < 1 || maxDeliveries !== undefined && (!Number.isSafeInteger(maxDeliveries) || maxDeliveries < 1)) {
        throw Error('note courier CAP and MAX_DELIVERIES must be positive safe integers');
    }
    const reserve = retainedTrout(env), server = deps.serverOf(courierName);
    if (deps.serverOf(bankerName).toLowerCase() !== server.toLowerCase()) throw Error('note courier and banker must use the same server');
    if (!deps.owned(server).has(bankerName.toLowerCase())) throw Error('note courier banker must be an authenticated owned account on its server');
    return { courierName, bankerName, cap, maxDeliveries, reserve, server };
}

export function noteCourierOwned(
    courierName: string,
    bankerName: string,
    server: string,
    actualServer: string | undefined,
    lookup: (server: string) => ReadonlySet<string> = ownedAccounts,
): ReadonlySet<string> {
    if (actualServer?.toLowerCase() !== server.toLowerCase()) throw Error('note courier authenticated endpoint mismatch');
    const owned = lookup(server);
    if (!owned.has(courierName.toLowerCase()) || !owned.has(bankerName.toLowerCase())) {
        throw Error('note courier and banker must be authenticated owned accounts on their server');
    }
    return owned;
}

export type CourierTile = { x: number; z: number };
export const ARDY_BANK: CourierTile = { x: 2654, z: 3283 };
export const NORTH_BANK: CourierTile = { x: 2619, z: 3332 };
export const SARIM: CourierTile = { x: 3029, z: 3217 };
export const NORTH_TO_SOUTH: CourierTile = { x: 2644, z: 3293 };
export const BOAT_FARES_OUT = 60;
export const BOAT_FARES_ROUND = 120;
export const DRAYNOR_BANK: CourierTile = { x: 3092, z: 3243 };
export type OutboundStart = 'boat-south' | 'boat-north' | 'land' | 'refuse';
export type RoutePoint = [number, number, number];
export const LUMBRIDGE_TO_DRAYNOR: RoutePoint[] = [
    [3226, 3250, 2], [3180, 3258, 3], [3100, 3285, 3],
    [3089, 3266, 2], [3092, 3250, 1], [DRAYNOR_BANK.x, DRAYNOR_BANK.z, 2],
];

export function selectFoodSource(names: readonly string[], statuses: readonly any[], owned: ReadonlySet<string>, now: number, minimum = 1, server = 'rs-sdk-demo.fly.dev'): string | undefined {
    if (names.some(n => typeof n !== 'string')) return undefined;
    return selectCookedFoodSource(names, statuses, owned, now, minimum, server);
}

export function featherPurchaseAmount(cap: number, name: string, status: any, now: number, server = 'rs-sdk-demo.fly.dev'): number {
    if (typeof status?.name !== 'string' || status.name.toLowerCase() !== name.toLowerCase() || status.server !== server
        || status.result || !Number.isFinite(status.at) || now - status.at < 0 || now - status.at >= 30000
        || !Array.isArray(status.inventory) || !status.inventory.every((i: any) => Number.isSafeInteger(i?.id) && i.id >= 0 && Number.isSafeInteger(i.count) && i.count > 0)) {
        return cap;
    }
    const stock = status.inventory.filter((i: any) => i.id === 314).reduce((n: number, i: any) => n + i.count, 0);
    return Number.isSafeInteger(stock) ? Math.min(cap, Math.max(0, 1000 - stock)) : cap;
}

export function foodDeficit(name: string, status: any, now: number, buffer = 80, server = 'rs-sdk-demo.fly.dev'): number | undefined {
    const rows = (v: any) => Array.isArray(v) && v.every(i => Number.isSafeInteger(i?.id) && i.id >= 0 && Number.isSafeInteger(i.count) && i.count > 0);
    if (!Number.isSafeInteger(buffer) || buffer < 1 || typeof status?.name !== 'string' || status.name.toLowerCase() !== name.toLowerCase()
        || status.server !== server || status.result || !Number.isFinite(status.at) || now - status.at < 0 || now - status.at >= 30000
        || !Number.isFinite(status.bankAt) || status.bankAt <= 0 || status.bankAt > now || !rows(status.bank) || !rows(status.inventory)) {
        return undefined;
    }
    const food = foodStock(status.bank.filter((i: { id: number }) => COOKED_FOOD_BASE_IDS.has(i.id))) + foodStock(status.inventory);
    return Number.isSafeInteger(food) ? Math.max(0, buffer - food) : undefined;
}

export function foodRestockAmount(name: string, status: any, now: number, server = 'rs-sdk-demo.fly.dev'): number | undefined {
    const deficit = foodDeficit(name, status, now, 80, server);
    return deficit === undefined ? undefined : deficit > 0 ? deficit + 80 : 0;
}

export function deliveryRecipientAtBank(p: { worldX: number; worldZ: number; level: number } | null | undefined, players: readonly { name: string; distance: number }[], name: string, bank: CourierTile): boolean {
    return p?.level === 0 && Math.max(Math.abs(p.worldX - bank.x), Math.abs(p.worldZ - bank.z)) <= 2
        && players.some(other => other.name.toLowerCase() === name.toLowerCase() && Number.isFinite(other.distance) && other.distance >= 0 && other.distance <= 2);
}

export function deliveryResume(p: { worldX: number; worldZ: number; level: number } | null | undefined, notes: number, farmers: number): 'bank' | 'karamja' | null {
    if (!Number.isSafeInteger(notes) || notes < 1 || !Number.isSafeInteger(farmers) || farmers < 1) return null;
    if (onKaramja(p)) return 'karamja';
    if (p?.level === 0 && Math.max(Math.abs(p.worldX - 2653), Math.abs(p.worldZ - 3302)) <= 16) return 'bank';
    const start = outboundStart(p);
    if (start === 'boat-south' || start === 'boat-north') return 'bank';
    return null;
}

export function onKaramja(p: { worldX: number; worldZ: number; level: number } | null | undefined): boolean {
    return !!p && p.level === 0 && p.worldX >= 2760 && p.worldX <= 2965 && p.worldZ >= 3130 && p.worldZ <= 3235;
}

export function draynorApproach(p: { worldX: number; worldZ: number; level: number } | null | undefined): RoutePoint[] {
    if (p && p.level === 0 && p.worldX >= 3110) return LUMBRIDGE_TO_DRAYNOR;
    return [[DRAYNOR_BANK.x, DRAYNOR_BANK.z, 2]];
}

const courierCheb = (a: CourierTile, p: { worldX: number; worldZ: number }) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ));

export function outboundStart(p: { worldX: number; worldZ: number; level: number } | null | undefined): OutboundStart {
    if (!p || p.level !== 0) return 'refuse';
    if (courierCheb(ARDY_BANK, p) <= 10) return 'boat-south';
    if (courierCheb(NORTH_BANK, p) <= 10) return 'boat-north';
    if (p.worldX >= 2950 && courierCheb(SARIM, p) < courierCheb(ARDY_BANK, p)) return 'land';
    return 'refuse';
}

export function courierIslandProblem(combat: number | undefined): string | null {
    return Number.isSafeInteger(combat) && (combat ?? 0) >= 29
        ? null
        : 'Courier prerequisite: combat29 required for the Karamja scorpion crossing';
}

export function featherBatchAmount(coins: number, remaining: number): number {
    if (!Number.isSafeInteger(coins) || coins < 0 || !Number.isSafeInteger(remaining) || remaining < 0) return 0;
    return Math.max(0, Math.min(50, remaining, Math.floor((coins - BOAT_FARES_OUT) / 12)));
}

export function featherPurchaseEffect(beforeCoins: number, beforeFeathers: number, afterCoins: number, afterFeathers: number, requested: number) {
    if ([beforeCoins, beforeFeathers, afterCoins, afterFeathers, requested].some(n => !Number.isSafeInteger(n) || n < 0) || requested < 1 || requested > 50) {
        throw Error('Feather purchase observation unavailable');
    }
    const bought = afterFeathers - beforeFeathers, cost = beforeCoins - afterCoins;
    if (bought < 0 || bought > requested || cost < 0 || (bought === 0 ? cost !== 0 : cost < 1 || cost > bought * 12) || afterCoins < BOAT_FARES_OUT) {
        throw Error('Feather purchase debit/credit or return fares unconfirmed');
    }
    return { bought, cost };
}

// --- Banker Payout Helpers ---

export type PayoutItem = { name: string; count: number };

export function payoutItems(raw: unknown): PayoutItem[] {
    if (!Array.isArray(raw) || !raw.length) throw new Error('no payout progress: invalid empty payout');
    const items = new Map<string, PayoutItem>();
    for (const w of raw) {
        if (!w || typeof w.name !== 'string' || !w.name.trim() || !Number.isSafeInteger(w.count) || w.count <= 0) {
            throw new Error('no payout progress: invalid requested item/count');
        }
        const key = w.name.toLowerCase(), prior = items.get(key);
        const count = (prior?.count ?? 0) + w.count;
        if (!Number.isSafeInteger(count)) throw new Error('no payout progress: requested count overflow');
        items.set(key, { name: prior?.name ?? w.name, count });
    }
    return [...items.values()];
}

export async function preparePayout(s: Session, raw: unknown, notes = false, keep: RegExp | null = null) {
    const want = payoutItems(raw);
    if (want.some(w => { if (!keep) return false; keep.lastIndex = 0; return keep.test(w.name); })) {
        throw new Error('no payout progress: requested item overlaps protected KEEP kit');
    }
    const inv = () => s.sdk.getInventory();
    const count = (name: string) => inv().filter(i => i.name.toLowerCase() === name.toLowerCase()).reduce((n, i) => n + i.count, 0);
    const original = new Map<number, number>();
    for (const i of inv()) original.set(i.id, (original.get(i.id) ?? 0) + i.count);
    const opened = await s.bot.openBank();
    if (!opened.success) throw new Error(`no payout progress: bank open failed ${opened.message}`);
    try {
        for (const w of want) {
            const before = count(w.name);
            if (notes) await s.bot.withdrawItem(exactItem(w.name), w.count, { asNote: true });
            else await s.bot.withdrawItem(exactItem(w.name), w.count);
            const actual = count(w.name) - before;
            if (actual !== w.count) throw new Error(`no payout progress: withdrawal incomplete ${w.name} requested=${w.count} actual=${actual}`);
        }
        return { want, notes, withdrawn: want.reduce((n, w) => n + w.count, 0) };
    } catch (error) {
        for (const id of new Set(inv().map(i => i.id))) {
            const actual = inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
            const surplus = actual - (original.get(id) ?? 0);
            if (surplus > 0) {
                await s.bot.depositItem(inv().find(i => i.id === id)!, surplus);
                const left = inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
                if (left !== (original.get(id) ?? 0)) throw new Error(`no payout progress: partial withdrawal cleanup failed id=${id}; ${String(error)}`);
            }
        }
        throw error;
    } finally {
        await s.bot.closeBank();
    }
}

export function ourAccounts(server = 'rs-sdk-demo.fly.dev', lookup: (server: string) => ReadonlySet<string> = ownedAccounts): string[] {
    return [...lookup(server)];
}

// --- Courier Funding Helpers ---

const TOKEN_RE = /^[a-f0-9-]{36}$/i;
const FUND_BANK = { x: 2654, z: 3283, radius: 6 };
export const FUND_AMOUNT = 5000;
export const FUND_BELOW = 1500;
export const FUND_RESERVE = 10000;
const defaultFundingDir = join(REPO_ROOT, '.practice/courier-funding');
type FundingOptions = { dir?: string; owned?: ReadonlySet<string>; readStatus?: (name: string) => any };
type FundingRequest = { token: string; funder: string; items: { name: string; count: number }[] };
type FundingReceipt = { token: string; from: string; to: string; amount: number; state: 'prepared' | 'paid' | 'failed' | 'declined' | 'unknown'; at: number; detail?: string };
const coinCount = (s: Session) => s.sdk.getInventory().filter(i => i.id === 995).reduce((n, i) => n + i.count, 0);
const readFundingJSON = (file: string, limit = 4096) => {
    if (statSync(file).size > limit) throw Error('funding record too large');
    return JSON.parse(readFileSync(file, 'utf8'));
};
const fundingStatus = (name: string, o: FundingOptions) =>
    o.readStatus ? o.readStatus(name) : readFundingJSON(join(REPO_ROOT, '.practice/status', `${name}.json`), 256 * 1024);
const fundingPaths = (courier: string, o: FundingOptions) => {
    if (!ACCOUNT_NAME_RE.test(courier)) throw Error('invalid funding courier');
    const dir = o.dir ?? defaultFundingDir;
    return { dir, request: join(dir, `${courier}.json`), claim: join(dir, `${courier}.claimed.json`) };
};
const fundingReceiptPath = (dir: string, token: string) => {
    if (!TOKEN_RE.test(token)) throw Error('invalid funding token');
    return join(dir, `${token}.result.json`);
};
function writeFundingReceipt(dir: string, r: FundingReceipt) {
    mkdirSync(dir, { recursive: true });
    const file = fundingReceiptPath(dir, r.token), temp = `${file}.tmp-${process.pid}`;
    writeFileSync(temp, JSON.stringify({ ...r, detail: r.detail?.slice(0, 500) }));
    renameSync(temp, file);
    console.log('FUNDING ' + JSON.stringify(r));
}

export function fundingRequestValid(funder: string, courier: string, s: any, r: any, at: number, server: string, owned: ReadonlySet<string>, now = Date.now()): boolean {
    return ACCOUNT_NAME_RE.test(funder) && ACCOUNT_NAME_RE.test(courier) && owned.has(funder.toLowerCase()) && owned.has(courier.toLowerCase())
        && typeof r?.funder === 'string' && r.funder.toLowerCase() === funder.toLowerCase() && typeof r.token === 'string' && TOKEN_RE.test(r.token)
        && r.items?.length === 1 && r.items[0]?.name === 'Coins' && r.items[0]?.count === FUND_AMOUNT
        && hasPayout(courier, s, r, at, now, FUND_BANK, server) && Array.isArray(s.inventory)
        && s.inventory.every((i: any) => Number.isSafeInteger(i?.id) && i.id >= 0 && Number.isSafeInteger(i.count) && i.count > 0)
        && s.inventory.filter((i: any) => i.id === 995).reduce((n: number, i: any) => n + i.count, 0) < FUND_BELOW;
}

function settlePriorClaim(funder: string, courier: string, o: FundingOptions): void {
    const p = fundingPaths(courier, o);
    if (!existsSync(p.claim)) return;
    let claim: any;
    try { claim = readFundingJSON(p.claim); } catch { throw Error('no courier progress: unreadable funding claim'); }
    if (typeof claim?.funder !== 'string' || claim.funder.toLowerCase() !== funder.toLowerCase()) throw Error('no courier progress: funding claim has another owner');
    let r: FundingReceipt | undefined;
    try { r = readFundingJSON(fundingReceiptPath(p.dir, claim.token)); } catch { /* ignore */ }
    if (!r || r.token !== claim.token || typeof r.from !== 'string' || typeof r.to !== 'string' || r.from.toLowerCase() !== funder.toLowerCase() || r.to.toLowerCase() !== courier.toLowerCase()
        || r.amount !== FUND_AMOUNT || !['paid', 'failed', 'declined'].includes(r.state)) {
        throw Error('no courier progress: unresolved funding claim');
    }
    if (existsSync(p.request) && readFundingJSON(p.request).token === claim.token) rmSync(p.request);
    rmSync(p.claim);
}

function pendingRecord(funder: string, courier: string, server: string, o: FundingOptions) {
    settlePriorClaim(funder, courier, o);
    try {
        const p = fundingPaths(courier, o), request: FundingRequest = readFundingJSON(p.request), client = fundingStatus(courier, o), at = statSync(p.request).mtimeMs;
        return fundingRequestValid(funder, courier, client, request, at, server, o.owned ?? ownedAccounts(server))
            && !existsSync(fundingReceiptPath(p.dir, request.token))
            ? { request, client, at }
            : null;
    } catch {
        return null;
    }
}

export function pendingCourierFunding(funder: string, courier: string, server: string, o: FundingOptions = {}): boolean {
    return !!pendingRecord(funder, courier, server, o);
}

export async function serviceCourierFunding(s: Session, courier: string, server: string, o: FundingOptions = {}): Promise<FundingReceipt | null> {
    const pending = pendingRecord(s.name, courier, server, o);
    if (!pending) return null;
    const p = fundingPaths(courier, o);
    try {
        copyFileSync(p.request, p.claim, constants.COPYFILE_EXCL);
    } catch (e) {
        if (['ENOENT', 'EEXIST'].includes((e as NodeJS.ErrnoException).code ?? '')) return null;
        throw Error(`no courier progress: funding claim failed: ${String(e)}`);
    }
    let request: FundingRequest;
    try { request = readFundingJSON(p.claim); } catch { rmSync(p.claim); return null; }
    if (request.token !== pending.request.token || !fundingRequestValid(s.name, courier, pending.client, request, pending.at, server, o.owned ?? ownedAccounts(server))) {
        rmSync(p.claim);
        return null;
    }
    if (existsSync(fundingReceiptPath(p.dir, request.token))) {
        settlePriorClaim(s.name, courier, o);
        return null;
    }
    try {
        if (readFundingJSON(p.request).token === request.token) rmSync(p.request, { force: true });
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw Error(`no courier progress: funding claim cleanup failed: ${String(e)}`);
    }
    const base = { token: request.token, from: s.name, to: courier, amount: FUND_AMOUNT };
    let withdrawn = false, dispatched = false;
    const original = coinCount(s);
    const done = (state: FundingReceipt['state'], detail?: string) => {
        const r = { ...base, state, detail, at: Date.now() };
        writeFundingReceipt(p.dir, r);
        if (state !== 'unknown' && state !== 'prepared') rmSync(p.claim);
        return r;
    };
    try {
        if (!(await s.bot.openBank()).success) return done('declined', 'bank unavailable');
        await waitTicks(s, 1);
        const bank = s.sdk.getState()?.bank.items.find(i => i.id === 995)?.count ?? 0;
        if (!Number.isSafeInteger(bank) || bank < FUND_RESERVE + FUND_AMOUNT) {
            await s.bot.closeBank();
            return done('declined', 'bank reserve');
        }
        await preparePayout(s, request.items);
        withdrawn = true;
        if (!(await s.bot.openBank()).success) return done('unknown', 'reserve bank unavailable');
        await waitTicks(s, 1);
        if ((s.sdk.getState()?.bank.items.find(i => i.id === 995)?.count ?? 0) < FUND_RESERVE) {
            await s.bot.openBank();
            await s.bot.depositItem(/^coins$/i, FUND_AMOUNT);
            await waitTicks(s, 1);
            await s.bot.closeBank();
            if (coinCount(s) !== original) return done('unknown', 'reserve refund not confirmed');
            withdrawn = false;
            return done('declined', 'bank reserve after withdrawal');
        }
        await s.bot.closeBank();
        writeFundingReceipt(p.dir, { ...base, state: 'prepared', at: Date.now() });
        const before = coinCount(s);
        dispatched = true;
        const result = await s.bot.serveTrades({ from: new RegExp(`^${courier}$`, 'i'), give: [{ item: /^coins$/i, amount: FUND_AMOUNT }], maxTrades: 1, timeout: 60000 });
        const confirmed = result.trades.some(t => t.success && t.gave.filter(i => /^coins$/i.test(i.name)).reduce((n, i) => n + i.count, 0) === FUND_AMOUNT);
        if (confirmed) await waitUntil(s, () => coinCount(s) === before - FUND_AMOUNT, { timeoutTicks: 8 });
        const debit = before - coinCount(s);
        if (confirmed && debit === FUND_AMOUNT) return done('paid');
        if (debit !== 0 || confirmed) return done('unknown', 'trade and wallet do not agree');
        if (!(await s.bot.openBank()).success) return done('unknown', 'refund bank unavailable');
        await s.bot.depositItem(/^coins$/i, FUND_AMOUNT);
        await waitTicks(s, 1);
        await s.bot.closeBank();
        if (coinCount(s) !== original) return done('unknown', 'refund not confirmed');
        withdrawn = false;
        return done('failed', result.message);
    } catch (e) {
        if (withdrawn || dispatched) {
            try { writeFundingReceipt(p.dir, { ...base, state: 'unknown', at: Date.now(), detail: String(e) }); } catch { /* ignore */ }
            throw Error(`no courier progress: funding settlement uncertain: ${String(e)}`);
        }
        await s.bot.closeBank();
        return done('failed', String(e));
    }
}

export async function requestCourierFunding(s: Session, funder: string, server: string, o: FundingOptions = {}): Promise<{ received: number; reason: string }> {
    if (coinCount(s) >= FUND_BELOW) return { received: 0, reason: 'sufficient' };
    const owned = o.owned ?? ownedAccounts(server), p0 = s.sdk.getState()?.player;
    if (!ACCOUNT_NAME_RE.test(funder) || !owned.has(funder.toLowerCase()) || !owned.has(s.name.toLowerCase())) throw Error('no courier progress: funding identity is not owned');
    if (!p0 || p0.level !== 0 || Math.max(Math.abs(p0.worldX - FUND_BANK.x), Math.abs(p0.worldZ - FUND_BANK.z)) > FUND_BANK.radius) return { received: 0, reason: 'away from funding bank' };
    let donor: any;
    try { donor = fundingStatus(funder, o); } catch { return { received: 0, reason: 'funder unavailable' }; }
    if (typeof donor?.name !== 'string' || donor.name.toLowerCase() !== funder.toLowerCase() || donor.server !== server || donor.result || !Number.isFinite(donor.at)
        || Date.now() - donor.at < 0 || Date.now() - donor.at >= 30000 || donor.pos?.level !== 0
        || Math.max(Math.abs(donor.pos.x - FUND_BANK.x), Math.abs(donor.pos.z - FUND_BANK.z)) > 45) return { received: 0, reason: 'funder unavailable' };
    const p = fundingPaths(s.name, o);
    mkdirSync(p.dir, { recursive: true });
    if (existsSync(p.request) || existsSync(p.claim)) return { received: 0, reason: 'funding request already owned' };
    const token = randomUUID(), request: FundingRequest = { token, funder, items: [{ name: 'Coins', count: FUND_AMOUNT }] }, before = coinCount(s);
    writeFileSync(p.request, JSON.stringify(request), { flag: 'wx' });
    console.log(`MILESTONE funding-request ${funder} token=${token}`);
    try {
        const near = () => s.sdk.getState()?.nearbyPlayers.some(p => p.name.toLowerCase() === funder.toLowerCase() && p.distance <= 6
            && Math.max(Math.abs(p.x - FUND_BANK.x), Math.abs(p.z - FUND_BANK.z)) <= 6);
        const progress = () => { try { return readFundingJSON(fundingReceiptPath(p.dir, token)) as FundingReceipt; } catch { return undefined; } };
        const terminal = () => ['paid', 'declined', 'failed', 'unknown'].includes(progress()?.state ?? '');
        await waitUntil(s, () => !!near() && progress()?.state === 'prepared' || terminal(), { timeoutTicks: 150 });
        let r: FundingReceipt | undefined;
        try { r = readFundingJSON(fundingReceiptPath(p.dir, token)); } catch { /* ignore */ }
        if (r && ['declined', 'failed', 'unknown'].includes(r.state)) return { received: 0, reason: r.state };
        if (!near() || r?.state !== 'prepared') return { received: 0, reason: 'funder not ready' };
        const trade = await s.bot.trade(new RegExp(`^${funder}$`, 'i'), { want: [{ item: /^coins$/i, amount: FUND_AMOUNT }], timeout: 60000, requestTimeout: 30000, retryOnBusy: true });
        if (trade.success) await waitUntil(s, () => coinCount(s) - before === FUND_AMOUNT, { timeoutTicks: 8 });
        const got = coinCount(s) - before;
        if (trade.success && got === FUND_AMOUNT) {
            console.log(`MILESTONE funding-received ${got} from=${funder} token=${token}`);
            return { received: got, reason: 'paid' };
        }
        if (got !== 0) throw Error('no courier progress: funding receipt uncertain');
        return { received: 0, reason: trade.message };
    } finally {
        try { if (!existsSync(p.claim) && readFundingJSON(p.request).token === token && !existsSync(p.claim)) rmSync(p.request, { force: true }); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && existsSync(p.request)) throw e; }
    }
}

// --- Cross-Side Fleet Trade Helpers ---

export async function runOrderWork<T>(order: Pick<Order, 'end'>, work: () => Promise<T>, now = Date.now): Promise<T> {
    const remaining = order.end - now();
    if (!Number.isFinite(remaining) || remaining > 2147483647) {
        throw Error('unsupported order window: remaining time must be finite and at most 2147483647 ms');
    }
    if (remaining <= 0) throw Error('order window ended before work');
    return withExecutionDeadline(remaining, work, () => { throw Error('order window ended during work'); });
}

export function pickOrder(orders: readonly Order[], receipts: readonly Receipt[], account: string, now: number, lead = 10 * 60_000): { order: Order; role: 'from' | 'to' } | null {
    const me = account.toLowerCase();
    for (const order of [...orders].sort((a, b) => a.start - b.start)) {
        const role = order.from.toLowerCase() === me ? 'from' : order.to.toLowerCase() === me ? 'to' : null;
        if (!role || now >= order.end || order.start - now > lead) continue;
        const other: TradeRole = role === 'from' ? 'to' : 'from';
        if (receipts.some(r => r.id === order.id && (r.role === role || (r.role === other && r.version === 2 && r.state === 'failed')))) continue;
        return { order, role };
    }
    return null;
}

const tradePlanFile = (base: string) => resolve(process.env.SWARM_PLAN ?? join(base, 'swarm.json'));

function readTradePlan(file: string) {
    const plan = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(plan?.jobs)) throw Error('fleet trade: invalid swarm plan');
    return plan;
}

export function readAgentJobs(file = tradePlanFile(REPO_ROOT)): readonly any[] {
    return readTradePlan(file).jobs;
}

export function swarmBusy(jobs: readonly any[]): Set<string> {
    return new Set(jobs.filter(j => j?.enabled).flatMap(j => [j.account, ...(j.accounts ?? [])]).filter((n): n is string => typeof n === 'string').map(n => n.toLowerCase()));
}

export function assertTradeAdmission(order: Order, account: string, server: string, {
    base = REPO_ROOT, planFile = tradePlanFile(base), receipts = join(FLEET_DIR(), 'receipts'), now = Date.now(),
    starts = processStartTimes as (pids: readonly number[]) => ReadonlyMap<number, number> | null,
}: { base?: string; planFile?: string; receipts?: string; now?: number; starts?: (pids: readonly number[]) => ReadonlyMap<number, number> | null } = {}): void {
    const name = account.toLowerCase();
    const role = order.from.toLowerCase() === name ? 'from' : order.to.toLowerCase() === name ? 'to' : null;
    if (!role) throw Error('fleet trade: account is outside the order');
    if (server.toLowerCase() !== order.server.toLowerCase()) throw Error('fleet trade: account server differs from order server');
    if (now < order.start || now >= order.end) throw Error('fleet trade: outside order window');
    const practice = join(base, '.practice');
    const stopFiles = new Set(existsSync(practice) ? readdirSync(practice).map(file => file.toLowerCase()) : []);
    if (stopFiles.has('stop-swarm')) throw Error('fleet trade: swarm is paused');
    if (stopFiles.has('stop-' + name)) throw Error('fleet trade: account has an owner stop file');
    const plan = readTradePlan(planFile);
    const statePath = fleetStateFile(base);
    const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
    if (state?.accounts?.[name]?.paused === true) throw Error('fleet trade: account is paused for controller rollout');
    const includesAccount = (job: any) => [job?.account, ...(Array.isArray(job?.accounts) ? job.accounts : [])].some((n: unknown) => typeof n === 'string' && n.toLowerCase() === name);
    const reservation = (job: any) => (!job.script && job.trades !== true) || /fresh.clock|24 boards|main simultaneous/i.test(job.goal ?? '');
    if (plan.jobs.some((job: any) => includesAccount(job) && reservation(job))) throw Error('fleet trade: reserved account');
    if (swarmBusy(plan.jobs).has(name) || state?.accounts?.[name]?.activeJob != null) throw Error('fleet trade: account has an enabled swarm job');
    const runsFile = join(practice, 'swarm-runs.json');
    if (existsSync(runsFile)) {
        const runs = JSON.parse(readFileSync(runsFile, 'utf8'));
        const answering = Array.isArray(runs) ? runs.filter(run => includesAccount(run) && pidAlive(run.pid)) : [];
        const table = answering.length ? starts(answering.map(run => run.pid)) : null;
        if (!Array.isArray(runs) || answering.some(run => !laterProcessHolds(run.pid, run.started, table))) {
            throw Error('fleet trade: account has an unsettled swarm worker');
        }
    }
    if (existsSync(join(receipts, `${order.id}.${role}.json`))) throw Error('fleet trade: order receipt already exists');
    if (server === 'rs-sdk-demo.fly.dev') liveLogoutRef(account, base, false, now);
    else {
        const proof = readLogoutProof(account, server, { root: join(practice, 'session-lifecycle') });
        if (proof.state !== 'none' && proof.state !== 'confirmed') throw Error('fleet trade: account logout is not confirmed');
    }
}

export type FleetTradeProgress = Pick<TradeReceipt, 'count' | 'inventory' | 'bank' | 'screen'> & { uncertain: boolean; lines?: Pick<TradeLine, 'count' | 'inventory' | 'bank'>[] };

export function watchTradeScreen(s: { onTick(cb: () => void): () => void; sdk: { getState(): { trade?: { isOpen: boolean } } | null } }, progress: FleetTradeProgress) {
    const look = () => { const trade = s.sdk.getState()?.trade; if (trade) progress.screen = !!progress.screen || trade.isOpen; };
    look();
    return s.onTick(look);
}

const requestRefusal = (result: TradeResult) => !result.success && !result.partner
    && ['player_not_found', 'no_response', 'busy'].includes(result.reason ?? '')
    && !result.gave.length && !result.received.length && !result.possiblyDropped?.length;

export function partnerFailed(dir: string, order: Order, role: TradeRole, preloginDir = join(dirname(dir), 'prelogin-failed')): boolean {
    const other: TradeRole = role === 'from' ? 'to' : 'from';
    try {
        const receipt = JSON.parse(readFileSync(join(dir, `${order.id}.${other}.json`), 'utf8'));
        if (receipt?.version === 2 && receipt.id === order.id && receipt.state === 'failed') return true;
    } catch { /* absent or unreadable */ }
    return readPreloginFailure(preloginDir, order, other) !== null;
}

export const giverReadyFile = (base: string, id: string) => join(base, '.practice', 'fleet-ready', `${id}.ready`);
export function markGiverReady(base: string, id: string) {
    mkdirSync(join(base, '.practice', 'fleet-ready'), { recursive: true });
    writeFileSync(giverReadyFile(base, id), String(Date.now()));
}

export function releaseWatch(read: () => string, pin: string | undefined, { now = Date.now, everyMs = 20_000 } = {}): () => boolean {
    let checked = -Infinity, moved = false;
    return () => {
        if (!pin || moved || now() - checked < everyMs) return moved;
        checked = now();
        try { moved = read() !== pin; } catch { moved = false; }
        return moved;
    };
}

export async function waitForGiver(
    order: Order,
    { ready, failed, now = Date.now, sleep = (ms: number) => Bun.sleep(ms), maxMs = Number(process.env.TAKER_WAIT_MS ?? 30 * 60_000) }:
    { ready: () => boolean; failed: () => boolean; now?: () => number; sleep?: (ms: number) => Promise<unknown>; maxMs?: number },
): Promise<'ready' | 'failed' | 'deadline'> {
    const deadline = Math.min(now() + maxMs, order.end - 5 * 60_000);
    for (;;) {
        if (ready()) return 'ready';
        if (failed()) return 'failed';
        if (now() >= deadline) return 'deadline';
        await sleep(2000);
    }
}

export const itemDefinition = (s: Session, id: number) =>
    (s.client as { objType?: (id: number) => { stackable: boolean; certtemplate?: number; certlink?: number } } | undefined)?.objType?.(id);

export const matchesLineId = (s: Session, id: number | undefined, itemId: number | undefined): boolean => {
    if (itemId === undefined) return true;
    if (id === undefined) return false;
    const def = itemDefinition(s, id);
    if (def && typeof def.certtemplate === 'number') {
        const base = def.certtemplate !== -1 && typeof def.certlink === 'number' && def.certlink >= 0 ? def.certlink : id;
        return base === itemId;
    }
    return id === itemId;
};

export const countLineItems = (s: Session, re: RegExp, itemId?: number) =>
    itemId === undefined
        ? countItems(s, re)
        : s.sdk.getInventory().filter(i => re.test(i.name) && matchesLineId(s, i.id, itemId)).reduce((n, i) => n + i.count, 0);

let tradeItems: { id: number; name: string; tradeable: boolean }[] | undefined;

function receiverReservation(s: Session, order: Order): number {
    tradeItems ??= JSON.parse(readFileSync(join(REPO_ROOT, 'knowledge/items.json'), 'utf8'));
    const pack = s.sdk.getInventory();
    return Math.min(28, orderLines(order).reduce((slots, line) => {
        const ids = tradeItems!.filter(i => i.tradeable && (line.itemId !== undefined ? i.id === line.itemId : i.name.toLowerCase() === line.item.toLowerCase())).map(i => i.id);
        if (ids.length && ids.every(id => itemDefinition(s, id)?.stackable === true)) {
            return slots + (ids.every(id => pack.some(i => i.id === id)) ? 0 : 1);
        }
        return slots + (line.count > 28 ? 1 : line.count);
    }, 0));
}

function receiverSpace(s: Session, offer: readonly Pick<TradeItem, 'id' | 'count'>[]) {
    const pack = s.sdk.getInventory(), totals = new Map<number, number>();
    for (const item of offer) {
        if (!Number.isSafeInteger(item.id) || item.id < 0 || !Number.isSafeInteger(item.count) || item.count < 1) throw Error('receiver offer item shape is invalid');
        totals.set(item.id, (totals.get(item.id) ?? 0) + item.count);
    }
    let required = 0;
    for (const [id, count] of totals) {
        const definition = itemDefinition(s, id);
        if (typeof definition?.stackable !== 'boolean') throw Error(`receiver item metadata unavailable: ${id}`);
        if (definition.stackable) {
            const held = pack.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
            if (held + count > 2147483647) throw Error(`receiver stack limit exceeded: ${id}`);
            if (!held) required++;
        } else required += count;
    }
    return { required, free: 28 - pack.length };
}

export async function performFleetTransfer(s: Session, order: Order, role: TradeRole, progress: FleetTradeProgress, {
    now = Date.now, wait = waitUntil, deposit = depositObserved, gone = () => false,
}: { now?: () => number; wait?: typeof waitUntil; deposit?: typeof depositObserved; gone?: () => boolean } = {}) {
    const left = () => order.end - now();
    const partner = role === 'from' ? order.to : order.from, peer = exactItem(partner);
    if (left() <= 0) throw Error('order window ended before trade');
    if (role === 'to' && 28 - s.sdk.getInventory().length < receiverReservation(s, order)) {
        if (!(await s.bot.openBank()).success || !await wait(s, () => !!s.bankObservation?.(), { timeoutTicks: 20 })) {
            throw Error('receiver capacity bank observation unavailable');
        }
        const incoming = orderLines(order).map(line => exactItem(line.item));
        const rank = (item: { id: number; name: string }) => item.id === 995 ? 3 : incoming.some(re => re.test(item.name)) ? 2
            : s.sdk.getInventory().filter(i => i.id === item.id).length === 1 ? 0 : 1;
        const candidates = [...s.sdk.getInventory()].sort((a, b) => rank(a) - rank(b));
        for (const id of new Set(candidates.map(i => i.id))) {
            if (28 - s.sdk.getInventory().length >= receiverReservation(s, order)) break;
            if (left() <= 0 || gone()) throw Error('receiver capacity preparation ended before trade');
            const rows = s.sdk.getInventory().filter(i => i.id === id), item = rows[0];
            if (!item) continue;
            progress.uncertain = true;
            if (await deposit(s, item) !== rows.reduce((n, i) => n + i.count, 0) || s.sdk.getInventory().some(i => i.id === id)) {
                throw Error('receiver capacity deposit was not confirmed');
            }
            progress.uncertain = false;
        }
        if (!(await s.bot.closeBank()).success) throw Error('receiver capacity bank did not close');
        if (28 - s.sdk.getInventory().length < receiverReservation(s, order)) throw Error('receiver capacity unavailable before trade');
    }
    const lines = orderLines(order).map(line => {
        const re = exactItem(line.item), before = countLineItems(s, re, line.itemId);
        return { re, itemId: line.itemId, count: line.count, before, diff: () => role === 'from' ? before - countLineItems(s, re, line.itemId) : countLineItems(s, re, line.itemId) - before };
    });
    const matchesLine = (item: { id?: number; name: string }, l: { re: RegExp; itemId?: number }) => l.re.test(item.name) && matchesLineId(s, item.id, l.itemId);
    const lineOf = (item: { id?: number; name: string }) => lines.findIndex(l => matchesLine(item, l));
    const pack = () => s.sdk.getInventory().filter(i => lineOf(i) >= 0);
    const beforeById = new Map<number, number>();
    for (const row of pack()) beforeById.set(row.id, (beforeById.get(row.id) ?? 0) + row.count);
    const moved = () => lines.every(l => l.diff() === l.count), still = () => lines.every(l => l.diff() === 0);
    const exactOffer = (offer: readonly { id?: number; name: string; count: number }[]) => offer.every(o => lineOf(o) >= 0)
        && lines.every(l => offer.filter(o => matchesLine(o, l)).reduce((n, o) => n + o.count, 0) === l.count);
    let result: TradeResult | undefined, capacityDetail: string | undefined;
    if (left() <= 0) throw Error('order window ended before trade');
    if (role === 'from') {
        progress.uncertain = true;
        const served = await s.bot.serveTrades({
            from: peer, give: lines.map(l => ({ item: l.re, amount: l.count })), accept: offer => offer.length === 0,
            maxTrades: 1, timeout: left(), onTrade: trade => { result = trade; }, until: () => result !== undefined || gone(),
        });
        if (!result && (served.reason === 'timeout' || served.reason === 'until') && !served.trades.length && still()) progress.uncertain = false;
        if (!result && gone() && !progress.uncertain) throw Error('partner failed: no trade');
    } else {
        let ended = false;
        void s.ended.then(() => { ended = true; });
        for (let round = 0; !ended && left() > 0; round++) {
            if (gone()) throw Error('partner failed: no trade');
            progress.uncertain = true;
            result = await s.bot.trade(peer, {
                accept: offer => {
                    capacityDetail = undefined;
                    if (!offer.length || !exactOffer(offer)) return false;
                    try {
                        const { required, free } = receiverSpace(s, offer);
                        if (free >= required) return true;
                        capacityDetail = `receiver capacity: ${free} free, ${required} required`;
                    } catch (error) { capacityDetail = String(error); }
                    return false;
                },
                requestTimeout: Math.min(30_000, left()), timeout: Math.min(60_000, left()),
            });
            if (!requestRefusal(result) || !still()) break;
            progress.uncertain = false;
            const tile = (order.meet ?? meetingTiles({ x: 3185, z: 3436 })!)[1];
            if (!ended && left() > 0) await s.bot.walkTo(tile.x + (round % 2 === 0 ? 1 : 0), tile.z, 0);
        }
    }
    if (result?.success) await wait(s, moved, { timeoutTicks: 10 });
    const counts = lines.map(l => l.diff());
    lines.forEach((l, i) => {
        const line = { inventory: { before: l.before, after: l.before + (role === 'from' ? -counts[i]! : counts[i]!) }, count: Math.max(0, counts[i]!) };
        if (i === 0) Object.assign(progress, line);
        else (progress.lines ??= [])[i - 1] = { ...progress.lines?.[i - 1], ...line };
    });
    const transferred = role === 'from' ? result?.gave : result?.received;
    const opposite = role === 'from' ? result?.received : result?.gave;
    if (!result?.success || !result.partner || !peer.test(result.partner) || result.possiblyDropped?.length
        || lines.some((l, i) => counts[i] !== l.count) || opposite?.length || !transferred?.length || !exactOffer(transferred)) {
        const detail = [!result?.success && result?.reason, !result?.success && result?.message, capacityDetail].filter(Boolean).join(': ');
        throw Error((progress.uncertain ? 'transfer requires reconciliation' : 'no matching trade completed') + (detail ? ': ' + detail : ''));
    }
    if (role === 'from') return;
    if (!(await s.bot.openBank()).success || !await wait(s, () => !!s.bankObservation?.(), { timeoutTicks: 20 })) {
        throw Error('receiver bank observation unavailable');
    }
    const credited = lines.map(() => 0), bankAt = lines.map(() => 0);
    for (const id of new Set(transferred.map(i => i.id))) {
        const rows = s.sdk.getInventory().filter(i => i.id === id), stack = rows[0];
        const incoming = transferred.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
        const amount = rows.reduce((n, i) => n + i.count, 0), line = lineOf(transferred.find(i => i.id === id)!);
        if (!stack || amount - (beforeById.get(id) ?? 0) !== incoming) throw Error('receiver item delta differs from trade');
        if (await deposit(s, stack) !== amount) throw Error('receiver bank credit was not confirmed');
        const observation = s.bankObservation?.();
        if (!observation) throw Error('receiver bank credit observation unavailable');
        bankAt[line] = Math.max(bankAt[line]!, observation.at);
        credited[line]! += incoming;
    }
    lines.forEach((_, i) => {
        const bank = { count: credited[i]!, at: bankAt[i]! };
        if (i === 0) progress.bank = bank;
        else progress.lines![i - 1]!.bank = bank;
    });
    await s.bot.closeBank();
}

export function fleetTradeOutcome(
    prepared: TradeReceipt,
    progress: FleetTradeProgress,
    ok: boolean,
    logout: ReturnType<typeof readLogoutProof>,
    attemptId: string | undefined,
    at: number,
    detail: string,
): TradeReceipt {
    const proof = logout.state === 'confirmed' && logout.attemptId === attemptId && logout.loggedOutAt >= prepared.at
        && logout.account.toLowerCase() === prepared.account.toLowerCase() && logout.server.toLowerCase() === prepared.server.toLowerCase()
        ? { attemptId: logout.attemptId, at: logout.loggedOutAt, sha256: logout.receiptSha256 }
        : undefined;
    const lines = prepared.lines?.map((line, i) => {
        const p = progress.lines?.[i];
        return {
            item: line.item,
            requested: line.requested,
            count: p?.count ?? 0,
            ...(p?.inventory ? { inventory: p.inventory } : {}),
            ...(p?.bank ? { bank: p.bank } : {}),
        };
    });
    const all = [{ requested: prepared.requested, count: progress.count, bank: progress.bank }, ...(lines ?? [])];
    const exactBank = prepared.role === 'from' || all.every(l => l.bank?.count === l.requested);
    const state = proof && ok && all.every(l => l.count === l.requested) && exactBank
        ? 'settled'
        : proof && !progress.uncertain && all.every(l => l.count === 0)
            ? 'failed'
            : 'reconcile';
    return {
        ...prepared,
        state,
        ok: state === 'settled',
        count: progress.count,
        inventory: progress.inventory,
        bank: progress.bank,
        logout: proof,
        at,
        detail,
        ...(progress.screen === undefined ? {} : { screen: progress.screen }),
        ...(lines ? { lines } : {}),
    };
}

export function fleetTradeRecord(
    dir: string,
    order: Order,
    account: string,
    argv: string[] = process.argv.slice(2),
    env: Record<string, string | undefined> = process.env,
) {
    if (![order.from, order.to].some(n => n.toLowerCase() === account.toLowerCase())) throw Error(`fleet trade record: ${account} is not in order ${order.id}`);
    const file = join(dir, 'orders', order.id + '.json');
    if (!existsSync(file)) throw Error('fleet trade record: no order file ' + file);
    const normalizedArgv = argv[0] === 'fleet-trade' ? argv : ['fleet-trade', ...argv];
    return { script: 'scripts/aio-logistics.ts', argv: normalizedArgv, workArgs: ['fleet-trade', file], env: { ...env, COORDINATOR_PARTICIPANTS: JSON.stringify([order.from, order.to]) } };
}
