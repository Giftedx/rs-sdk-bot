// Fleet agent daemon: syncs fleet-data, invokes live-update, refreshes market caches,
// clears stale swarm stops when accounts are offline, and launches due cross-side trades.
// Usage: bun packages/fleet/src/fleet-agent.ts [--daemon] [--once]
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { controllerNamed, leaseHolder, releaseLease, renewLease, saveLaunch, takeLease } from '../../core/src/controllers';
import { FLEET_DIR, loadOwners, mySide, sideOf } from '../../core/src/fleet';
import { fleetTradeClaimRefusal, isFleetSwarmClaim, readHeldFleetAccountClaims, type FleetAccountClaim, type FleetTradeClaim } from '../../core/src/fleet-trade-claim';
import { validOrder, type Order, type Receipt, type TradeRole } from '../../core/src/fleet-trade-settlement';
import { leanBunEnv } from '../../core/src/lean-bun-env';
import { reloadDue, respawnDaemon } from '../../core/src/live-reload';
import { BIDS_FILE, MARKET_CACHE_MS, MARKET_FILE } from '../../core/src/market-cache';
import { findStopFile, liveRoot, readStopFile, repoRoot, statusReadDirs } from '../../core/src/practice-paths';
import { pidStartedAfter, spawnSyncTimed } from '../../core/src/proc';
import { lastResult } from '../../core/src/run-child';
import { capabilityRevision } from '../../core/src/worker-release';
import type { RawWorkerExitInput } from '../../brain/src/index';
import { queueWorkerOutcome, tradeNoRouteOutcome } from './brain-runtime';
import { brainBusyAccounts } from './fleet-sync';
import { InfraCircuitBreaker, classifyInfraFault } from './infra-circuit-breaker';
import { drainedFiles, readPendingUpdate } from './live-update/pending';
import { clearSwarmStop, SWARM_STOP, swarmWroteStop, writeSwarmStop } from './swarm';
import { buildOrderPicker, readAgentJobs, swarmBusy } from './trade-plan';
import { tradePreflight } from './trade-preflight';
import { askWorkersToLogOut } from './worker-stop';

const root = repoRoot;
export const AGENT_SUBPROCESS_TIMEOUT_MS = 180_000;
const CYCLE = Number(process.env.CYCLE ?? 10) * 60_000, LEAD = Number(process.env.LEAD ?? 15) * 60_000;
type ExpiredOrderStamp = { mtimeMs: number; size: number; end: number };
const expiredOrderCache = new Map<string, ExpiredOrderStamp>();
const activeOrderCache = new Map<string, { mtimeMs: number; size: number; value: unknown }>();
const activeReceiptCache = new Map<string, { mtimeMs: number; size: number; value: unknown }>();

function readCachedJsonFile(
    cache: Map<string, { mtimeMs: number; size: number; value: unknown }>,
    full: string,
    nowWall: number,
): unknown {
    try {
        const st = statSync(full);
        const hit = cache.get(full);
        if (hit && nowWall - st.mtimeMs > 1000 && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
            return hit.value;
        }
        const value = JSON.parse(readFileSync(full, 'utf8'));
        cache.set(full, { mtimeMs: st.mtimeMs, size: st.size, value });
        return value;
    } catch {
        cache.delete(full);
        return undefined;
    }
}

// Keep only unexpired or currently running orders and their receipts parsed in RAM; expired orders hold only a stat stamp.
export function readActiveOrdersAndReceipts(
    dir: string,
    now: number,
    runningOrders: ReadonlyMap<string, string> = new Map(),
): { orders: Order[]; receipts: Receipt[] } {
    const ordersDir = join(dir, 'orders'), receiptsDir = join(dir, 'receipts');
    const orders: Order[] = [];
    const receipts: Receipt[] = [];
    const runningIds = new Set(runningOrders.values());
    const nowWall = Date.now();
    const seenOrders = new Set<string>();
    if (existsSync(ordersDir)) {
        for (const f of readdirSync(ordersDir)) {
            if (!f.endsWith('.json')) continue;
            const full = join(ordersDir, f);
            seenOrders.add(full);
            let st;
            try { st = statSync(full); } catch { continue; }
            const orderId = f.slice(0, -5);
            const expired = expiredOrderCache.get(full);
            if (expired && !runningIds.has(orderId) && expired.mtimeMs === st.mtimeMs && expired.size === st.size && now >= expired.end) {
                continue;
            }
            const raw = readCachedJsonFile(activeOrderCache, full, nowWall);
            if (!validOrder(raw)) {
                expiredOrderCache.set(full, { mtimeMs: st.mtimeMs, size: st.size, end: 0 });
                activeOrderCache.delete(full);
                continue;
            }
            if (now >= raw.end && !runningIds.has(raw.id)) {
                expiredOrderCache.set(full, { mtimeMs: st.mtimeMs, size: st.size, end: raw.end });
                activeOrderCache.delete(full);
                continue;
            }
            expiredOrderCache.delete(full);
            orders.push(raw);
        }
    }
    for (const key of expiredOrderCache.keys()) if (!seenOrders.has(key)) expiredOrderCache.delete(key);
    for (const key of activeOrderCache.keys()) if (!seenOrders.has(key)) activeOrderCache.delete(key);

    const activeIds = new Set(orders.map(o => o.id));
    for (const id of runningIds) activeIds.add(id);
    const seenReceipts = new Set<string>();
    if (activeIds.size > 0 && existsSync(receiptsDir)) {
        for (const f of readdirSync(receiptsDir)) {
            if (!f.endsWith('.json')) continue;
            const dot = f.lastIndexOf('.', f.length - 6);
            if (dot <= 0 || !activeIds.has(f.slice(0, dot))) continue;
            const full = join(receiptsDir, f);
            seenReceipts.add(full);
            const rec = readCachedJsonFile(activeReceiptCache, full, nowWall) as Receipt | undefined;
            if (rec) receipts.push(rec);
        }
    }
    for (const key of activeReceiptCache.keys()) if (!seenReceipts.has(key)) activeReceiptCache.delete(key);
    return { orders, receipts };
}

export { readAgentJobs, swarmBusy } from './trade-plan';

export const marketStale = (base: string, now = Date.now()): boolean => [MARKET_FILE, BIDS_FILE].some(file => {
    try { return now - statSync(join(base, file)).mtimeMs > MARKET_CACHE_MS; } catch { return true; }
});

export function stopClearable(status: { result?: string; at?: number } | null | undefined, now = Date.now()): boolean {
    return !status || !!status.result || !(Number.isFinite(status.at) && now - status.at! < 30_000);
}

export function dueTrades(
    orders: readonly Order[],
    receipts: readonly Receipt[],
    side: string,
    owners: ReturnType<typeof loadOwners>,
    busy: ReadonlySet<string>,
    running: ReadonlySet<string>,
    now: number,
    lead = LEAD,
) {
    const names = new Set<string>();
    for (let i = 0; i < orders.length; i++) {
        const o = orders[i]!;
        if (sideOf(o.from, owners) === side) names.add(o.from.toLowerCase());
        if (sideOf(o.to, owners) === side) names.add(o.to.toLowerCase());
    }
    const pick = buildOrderPicker(orders, receipts);
    const due: { account: string; order: Order; busy: boolean }[] = [];
    for (const n of names) {
        if (running.has(n)) continue;
        const p = pick(n, now, lead);
        if (!p) continue;
        const account = p.role === 'from' ? p.order.from : p.order.to;
        due.push({ account, order: p.order, busy: busy.has(n) });
    }
    return due;
}

const TRADE_SCRIPT = resolve(root, 'scripts', 'aio-logistics.ts');

export function tradeEnvironment(
    dir: string,
    env: Record<string, string | undefined> = process.env,
    release = capabilityRevision([TRADE_SCRIPT], root),
) {
    return { ...env, FLEET_DIR: dir, WORKER_RELEASE: release, WORKER_ENTRY: TRADE_SCRIPT, STALL_TICKS: '0', LOOT_WATCH: '0', RANDOM_EVENTS: '0' };
}

// With `clear` false the check removes nothing: a stop file of the swarm that a start would remove does not hold.
export function tradeStop(base: string, account: string, now = Date.now(), clear = true): { held?: string; cleared: boolean } {
    let cleared = false;
    const seen = new Set<string>();
    for (const name of new Set([account, account.toLowerCase()])) {
        const file = findStopFile(name, base);
        if (!file || seen.has(file)) continue;
        seen.add(file);
        let text: string;
        try { text = readFileSync(file, 'utf8'); } catch { return { held: 'stop file unreadable', cleared }; }
        if (!swarmWroteStop(text)) return { held: 'owner stop file', cleared };
        let status: any = null;
        for (const dir of statusReadDirs(base)) {
            let found = false;
            for (const fileName of new Set([`${account}.json`, `${account.toLowerCase()}.json`])) {
                try { status = JSON.parse(readFileSync(join(dir, fileName), 'utf8')); found = true; break; } catch { /* check fallback */ }
            }
            if (found) break;
        }
        if (!stopClearable(status, now)) return { held: 'its last run is still ending', cleared };
        if (clear && clearSwarmStop(file)) cleared = true;
    }
    return { cleared };
}

// A stop for the whole fleet side: .practice/stop-fleet-agent, or .practice/stop-swarm with owner text. The swarm stops
// only its own runs, so trades of this agent stop only when this agent asks them.
// A live update that waits on running workers asks for a drain (live-update/pending.ts). The agent then starts no new
// trade whose worker loads a pending file, so the running trades end and the update lands. An order whose other side
// has started (it runs this order here, or it wrote its receipt) is not held: one side must not wait alone for the
// other. A partner busy with another order has not started this one.
// While a live run that is not a trade holds the update (`others`), a held trade does not make it land sooner, and a
// brain order lives 15 minutes (packages/brain/src/scheduler.ts transferOrderTtlMs): the trade starts. The agent
// holds trades once the update waits on trades alone, which end within their order window.
export function tradeDrainHold(
    order: Pick<Order, 'id' | 'from' | 'to'>,
    account: string,
    drained: readonly string[],
    target: string,
    runningOrders: ReadonlyMap<string, string>,
    receipts: readonly Pick<Receipt, 'id' | 'role'>[],
    others: readonly string[] = [],
): string | null {
    if (!drained.length || others.length) return null;
    const role = order.from.toLowerCase() === account.toLowerCase() ? 'from' : 'to';
    const partner = role === 'from' ? order.to : order.from, otherRole = role === 'from' ? 'to' : 'from';
    if (runningOrders.get(partner.toLowerCase()) === order.id || receipts.some(r => r?.id === order.id && r.role === otherRole)) return null;
    return drainText(drained, target);
}

const drainText = (drained: readonly string[], target: string) =>
    `live update to ${target.slice(0, 10)} drains ${drained.slice(0, 2).join(', ')}${drained.length > 2 ? ` and ${drained.length - 2} more` : ''}`;

// The two parties of an order on this side start in the same pass. A side started alone logs in, stands at the meet
// and waits for its partner until the order window ends (performFleetTransfer), and while a live update drains, that
// run holds the update for the whole window. So a side starts only when its partner runs this order, or wrote its
// side of it, or starts it in this pass: its first due order is this one and nothing holds it. Returns why the
// partner cannot join, or null. A partner on another side starts there, and this side cannot see its process. Its
// trade claim is the sign that it started: a giver ('from') starts at once, and with `crossSideClaims` (the held
// claims, as readTradeClaims gives them) a taker waits until its giver holds a claim for this order or wrote its side.
// A taker started without that sign stands at the meet until the order window ends if its giver never starts. The
// giver never waits, so two sides that both apply the rule both start.
export function tradePartnerWait(
    trade: { account: string; order: Pick<Order, 'id' | 'from' | 'to'> },
    side: string,
    owners: ReturnType<typeof loadOwners>,
    due: ReadonlyMap<string, { order: Pick<Order, 'id'> }>,
    waits: ReadonlyMap<string, string>,
    runningOrders: ReadonlyMap<string, string>,
    wrote: (id: string, role: TradeRole) => boolean,
    crossSideClaims?: ReadonlyMap<string, string> | null,
): string | null {
    const { order } = trade, me = trade.account.toLowerCase();
    const role: TradeRole = order.from.toLowerCase() === me ? 'from' : 'to';
    const partner = role === 'from' ? order.to : order.from, key = partner.toLowerCase();
    if (key === me) return null;
    const partnerSide = sideOf(partner, owners);
    if (partnerSide !== side) {
        if (role !== 'to' || !crossSideClaims || crossSideClaims.get(key) === order.id || wrote(order.id, 'from')) return null;
        return `partner ${partner} on side ${partnerSide} holds no claim for this order`;
    }
    if (runningOrders.get(key) === order.id || wrote(order.id, role === 'from' ? 'to' : 'from')) return null;
    const other = runningOrders.get(key);
    if (other) return `partner ${partner} runs order ${other}`;
    const pick = due.get(key);
    if (!pick) return `partner ${partner} has no due pick`;
    if (pick.order.id !== order.id) return `partner ${partner} takes order ${pick.order.id} first`;
    const wait = waits.get(key);
    return wait ? `partner ${partner} waits: ${wait}` : null;
}

// The held trade claims of the given accounts, lower-case account to order id. An unreadable claim authority gives no
// claims: the login refuses a held claim in any case (acquireFleetTradeClaim). A claim with a pre-network marker of this
// checkout (.practice/fleet-account-pending/<nonce>.json) is left out: acquireFleetTradeClaim takes over such a claim
// when its process is gone, so a wait on it would hold the account for good.
// A held swarm claim maps to SWARM_HELD when the trade login would refuse it (fleetTradeClaimRefusal): a swarm run
// holds the account. Returns null when the claim authority is unreadable.
export const SWARM_HELD = 'swarm';
export function readTradeClaims(
    base: string,
    accounts: readonly string[],
    read: (base: string, accounts: readonly string[]) => readonly FleetAccountClaim[] = readHeldFleetAccountClaims,
    refusal: (claim: FleetAccountClaim) => string | undefined = claim => fleetTradeClaimRefusal(base, claim, { account: claim.account, server: claim.server, side: mySide() }),
): ReadonlyMap<string, string> | null {
    try {
        const out = new Map<string, string>();
        for (const c of read(base, accounts)) {
            if (isFleetSwarmClaim(c)) {
                // A check that throws throws at the login too: the claim holds.
                let refused: string | undefined;
                try { refused = refusal(c); } catch (error) { refused = String(error); }
                if (refused) out.set(c.account.toLowerCase(), SWARM_HELD);
                continue;
            }
            if (!existsSync(join(base, '.practice', 'fleet-account-pending', `${c.nonce}.json`))) out.set(c.account.toLowerCase(), (c as FleetTradeClaim).orderId);
        }
        return out;
    } catch { return null; }
}
export function heldTradeClaims(base: string, accounts: readonly string[], read: Parameters<typeof readTradeClaims>[2] = readHeldFleetAccountClaims): ReadonlyMap<string, string> {
    return readTradeClaims(base, accounts, read) ?? new Map();
}

export type TradeWait = { account: string; order: Order; kind: 'held' | 'busy'; why: string };
export type TradeEnd = { account: string; order: string; why: string };

// The trade starts of a pass while the agent's own reload is due: only the second party of an order that already runs.
export function reloadStarts<T extends { order: { id: string } }>(starts: readonly T[], runningOrders: ReadonlyMap<string, string>, reloadIsDue: boolean): T[] {
    if (!reloadIsDue) return [...starts];
    const live = new Set(runningOrders.values());
    return starts.filter(t => live.has(t.order.id));
}

// One pass of the agent over the due orders: the trades to start, the trades that wait and why, and the running trades
// to end early. `halt` is a fleet owner stop or the agent's own stop. `stopHeld` checks an account's stop file and
// removes nothing. `wrote` says whether a receipt of that order and role exists; the agent reads the receipt file at
// the time of the check, since a partner run writes its receipt before its process exits.
// While a live update waits on trades alone, a running trade whose partner on this side cannot join it (the partner is
// held, busy, or on another order) ends early: it logs out through its stop file instead of waiting out the order
// window, and its receipt follows the usual rules.
// `claimHeld` returns the held trade claims (lower-case account to order id) of the given accounts. A party whose own
// claim, or whose partner's claim, names another order waits: acquireFleetTradeClaim refuses that party at login, and
// the other party would stand at the meet until the order window ends.
export function planTradePass(o: {
    orders: readonly Order[];
    receipts: readonly Receipt[];
    side: string;
    owners: ReturnType<typeof loadOwners>;
    busy: ReadonlySet<string>;
    running: ReadonlyMap<string, string>;
    runningOrders: ReadonlyMap<string, string>;
    now: number;
    lead?: number;
    halt?: string | null;
    drain?: { drained: readonly string[]; target: string; others?: readonly string[] } | null;
    stopHeld?: (account: string) => string | undefined;
    wrote?: (id: string, role: TradeRole) => boolean;
    claimHeld?: (accounts: readonly string[]) => ReadonlyMap<string, string> | null;
    // Checks before a start that the login and the route of this party would pass (trade-preflight.ts). A refusal
    // holds this party, and through tradePartnerWait its partner on this side.
    admit?: (account: string, order: Order, role: TradeRole) => string | undefined;
}): { starts: { account: string; order: Order }[]; waits: TradeWait[]; ends: TradeEnd[] } {
    const due = dueTrades(o.orders, o.receipts, o.side, o.owners, o.busy, new Set(o.running.keys()), o.now, o.lead);
    const read = !o.halt && due.length && o.claimHeld ? o.claimHeld([...new Set(due.flatMap(t => [t.order.from, t.order.to]))]) : null;
    const claimed = read ?? new Map<string, string>();
    const drained = o.drain?.drained ?? [];
    const wrote = (id: string, role: TradeRole) => o.receipts.some(r => r?.id === id && r.role === role) || (o.wrote?.(id, role) ?? false);
    // A partner that wrote its receipt of this order is done with it: its claim for a later order holds nothing here.
    // A swarm claim that the login refuses holds both parties: the login of that party fails with "fleet account claim
    // held by swarm", and its partner then stops with "partner failed before login".
    const claimWait = (order: Order, account: string) => {
        const me = account.toLowerCase(), mine = order.from.toLowerCase() === me, partner = mine ? order.to : order.from;
        const parties: [string, string][] = [[me, account]];
        if (!wrote(order.id, mine ? 'to' : 'from')) parties.push([partner.toLowerCase(), partner]);
        for (const [who, name] of parties) {
            const held = claimed.get(who);
            const text = held === SWARM_HELD ? 'account claim held by swarm' : `trade claim held for order ${held}`;
            if (held !== undefined && held !== order.id) return who === me ? text : `partner ${name} ${text}`;
        }
        return undefined;
    };
    const own = new Map<string, Omit<TradeWait, 'account' | 'order'>>();
    for (const t of due) {
        const drainHold = o.drain ? tradeDrainHold(t.order, t.account, drained, o.drain.target, o.runningOrders, o.receipts, o.drain.others) : null;
        const stopHeld = o.halt || t.busy || drainHold ? undefined : o.stopHeld?.(t.account);
        const claimHeld = o.halt || t.busy || drainHold || stopHeld ? undefined : claimWait(t.order, t.account);
        const refused = o.halt || t.busy || drainHold || stopHeld || claimHeld || !o.admit ? undefined
            : o.admit(t.account, t.order, t.order.from.toLowerCase() === t.account.toLowerCase() ? 'from' : 'to');
        const wait = o.halt ? { kind: 'held' as const, why: o.halt }
            : t.busy ? { kind: 'busy' as const, why: 'enabled swarm job' }
                : drainHold ? { kind: 'held' as const, why: drainHold }
                    : stopHeld ? { kind: 'held' as const, why: stopHeld }
                        : claimHeld ? { kind: 'held' as const, why: claimHeld }
                            : refused ? { kind: 'held' as const, why: refused } : null;
        if (wait) own.set(t.account.toLowerCase(), wait);
    }
    const dueBy = new Map(due.map(t => [t.account.toLowerCase(), t]));
    const ownWhy = new Map([...own].map(([k, w]) => [k, w.why]));
    const runs = new Map(o.runningOrders);
    const starts: { account: string; order: Order }[] = [], waits: TradeWait[] = [], ends: TradeEnd[] = [];
    for (const t of due) {
        const key = t.account.toLowerCase(), wait = own.get(key);
        if (wait) { waits.push({ account: t.account, order: t.order, ...wait }); continue; }
        const partner = tradePartnerWait(t, o.side, o.owners, dueBy, ownWhy, runs, wrote, read);
        if (partner) { waits.push({ account: t.account, order: t.order, kind: 'held', why: partner }); continue; }
        starts.push({ account: t.account, order: t.order });
        runs.set(key, t.order.id);
    }
    if (o.drain && drained.length && !o.drain.others?.length) {
        const byId = new Map(o.orders.map(order => [order.id, order]));
        for (const [key, account] of o.running) {
            const order = byId.get(o.runningOrders.get(key) ?? '');
            if (!order) continue;
            const partner = tradePartnerWait({ account, order }, o.side, o.owners, dueBy, ownWhy, runs, wrote);
            if (partner) ends.push({ account, order: order.id, why: `${partner}; ${drainText(drained, o.drain.target)}` });
        }
    }
    return { starts, waits, ends };
}
const TRADE_ENTRY_REL = 'scripts/aio-logistics.ts';

export function fleetOwnerStop(base: string): string | null {
    if (findStopFile('fleet-agent', base)) return 'stop-fleet-agent';
    const text = readStopFile('swarm', base);
    return text !== undefined && !swarmWroteStop(text) ? 'owner stop-swarm' : null;
}

const tradeStopFile = (base: string, account: string) => join(base, '.practice', `stop-${account}`);
const writeTradeStop = (base: string, account: string) => writeSwarmStop(tradeStopFile(base, account), SWARM_STOP.all);

// While a fleet owner stop stands, asks each running trade to log out with its stop file, once per account.
// Returns the accounts asked in this call.
export function askTradesToStop(base: string, running: ReadonlyMap<string, string>, asked: Set<string>): string[] {
    if (running.size === 0 || !fleetOwnerStop(base)) return [];
    const now: string[] = [];
    for (const [key, account] of running) {
        if (asked.has(key)) continue;
        writeTradeStop(base, account);
        asked.add(key);
        now.push(account);
    }
    return now;
}

// Ends the agent after its running trades log out, or after the grace. A trade is an attached child, so it dies with
// this process; without the stop file first its session would stay open on the server for 200 s.
export async function stopTradesThenExit(
    base: string,
    running: ReadonlyMap<string, string>,
    why: string,
    o: { graceMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>; exit?: (code: number) => void; log?: (line: string) => void } = {},
): Promise<void> {
    const log = o.log ?? console.log;
    const workers = [...running].map(([key, account]) => ({ account, ended: () => !running.has(key) }));
    if (workers.length > 0) log(`FLEET_AGENT ${why}: asking ${workers.map(w => w.account).join(',')} to log out before exit`);
    const left = await askWorkersToLogOut(workers, { writeStop: a => writeTradeStop(base, a), graceMs: o.graceMs, now: o.now, sleep: o.sleep });
    if (left.length > 0) log(`FLEET_AGENT ${why}: ${left.join(',')} did not end in the grace; they end with this process`);
    (o.exit ?? process.exit)(0);
}

export function recordAgentInfraResult(breaker: InfraCircuitBreaker, output: string, exitCode: number | null): boolean {
    const kind = classifyInfraFault(output);
    if (kind) {
        breaker.recordFailure(output, kind);
        return true;
    }
    if (exitCode === 0) breaker.recordSuccess('remote_git_claim');
    return false;
}

// A failed trade whose route search found no route from where the account stands goes to the swarm's outcome
// inbox, so the planner records a no-route fact and stops sending the account to that hub. Returns the queued file.
export function queueTradeNoRoute(o: {
    base: string;
    account: string;
    result: string | undefined;
    startedAt: number;
    logPath: string;
    now?: number;
    queue?: (root: string, raw: RawWorkerExitInput) => string;
}): string | null {
    if (!o.result?.startsWith('RESULT fail')) return null;
    try {
        const raw = tradeNoRouteOutcome({ root: o.base, account: o.account, resultLine: o.result, startedAt: o.startedAt, finishedAt: o.now ?? Date.now(), logPath: o.logPath });
        return raw ? (o.queue ?? queueWorkerOutcome)(o.base, raw) : null;
    } catch {
        return null;
    }
}

export function syncResult(out: string, exitCode: number | null): string {
    const line = lastResult(out);
    return line === 'RESULT fail no result' ? `RESULT fail fleet-sync exit ${exitCode}` : line;
}

const procCmdline = (pid: number): string | undefined => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { return undefined; } };
export function agentAlive(pid: number, cmdline: (pid: number) => string | undefined = procCmdline): boolean {
    try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false; }
    const c = cmdline(pid);
    return c === undefined || c.includes('fleet-agent');
}

// A daemon child has this set to 1. Its stdout and stderr are the log file, but output inherited through a detached
// child's stdout can stop reaching the file when a watchdog pass started the daemon.
export const AGENT_LOG_DIRECT = 'FLEET_AGENT_LOG_DIRECT';

export type AgentLog = (line: string, stream?: 'out' | 'err') => void;

// With direct set, each line goes to the log file through appendFileSync and not also to stdout, which is the same
// file. A foreground run, or a line the file refuses, goes to the console stream.
export function agentLog(
    file: string,
    direct: boolean,
    io: { append?: (file: string, text: string) => void; out?: (line: string) => void; err?: (text: string) => void } = {},
): AgentLog {
    const append = io.append ?? appendFileSync, out = io.out ?? console.log, err = io.err ?? (text => { process.stderr.write(text); });
    return (line, stream = 'out') => {
        if (direct) { try { append(file, `${line}\n`); return; } catch { /* the console stream below */ } }
        if (stream === 'err') err(`${line}\n`); else out(line);
    };
}

// The environment of a detached agent: the daemon child and each reload successor write their own log lines.
export const agentDaemonEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...env, [AGENT_LOG_DIRECT]: '1' });

export async function runFleetAgentCli(argv: readonly string[] = process.argv.slice(2), base = root): Promise<void> {
    const lock = join(base, '.practice', 'fleet-agent.lock'), logFile = join(base, '.practice', 'fleet-agent.log');
    if (argv.includes('--daemon')) {
        const out = openSync(logFile, 'a');
        const child = spawn(process.execPath, ['--smol', join(base, 'scripts', 'fleet-agent.ts')], { cwd: base, detached: true, windowsHide: true, stdio: ['ignore', out, out], env: leanBunEnv(agentDaemonEnv(process.env)) });
        closeSync(out); child.unref();
        console.log(`FLEET_AGENT started pid ${child.pid} (log .practice/fleet-agent.log)`);
        process.exit(0);
    }
    const log = agentLog(logFile, process.env[AGENT_LOG_DIRECT] === '1');
    // Windows has no /proc command line, so a start time later than the lease's heartbeat marks a reused id.
    const held = { alive: (pid: number) => agentAlive(pid), reused: pidStartedAfter, ...(procCmdline(process.pid) === undefined ? {} : { staleMs: Infinity }) };
    if (!takeLease(lock, process.pid, held)) { log(`FLEET_AGENT already running pid ${leaseHolder(lock, held)}`); process.exit(0); }
    const release = () => releaseLease(lock);
    // Running trades by lower-case account, with the account name as the order spells it.
    const running = new Map<string, string>(), runningOrders = new Map<string, string>(), once = argv.includes('--once');
    let stopping = false;
    const onSignal = (why: string) => {
        if (stopping) process.exit(0); // a second signal does not wait
        stopping = true;
        void stopTradesThenExit(base, running, why, { log });
    };
    process.on('exit', release); process.on('SIGINT', () => onSignal('SIGINT')); process.on('SIGTERM', () => onSignal('SIGTERM'));
    setInterval(() => { renewLease(lock); }, 60_000).unref();
    const askedToStop = new Set<string>(), endAsked = new Set<string>();
    setInterval(() => {
        for (const a of askTradesToStop(base, running, askedToStop)) log(`FLEET_AGENT owner stop: asked ${a} to log out`);
    }, 2_000).unref();
    if (!once) saveLaunch(join(base, controllerNamed('fleet-agent').launch), []);
    const infraBreaker = new InfraCircuitBreaker({ stateFile: join(liveRoot(base), 'infra-circuit-breaker.json') });
    const sync = () => {
        const p = spawnSyncTimed([process.execPath, '--smol', 'scripts/fleet-sync.ts'], {
            cwd: base,
            windowsHide: true,
            env: leanBunEnv({ ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }),
            stdout: 'pipe',
            stderr: 'pipe',
            timeout: AGENT_SUBPROCESS_TIMEOUT_MS,
        });
        const combined = `${p.stdout.toString()}${p.stderr.toString()}`;
        recordAgentInfraResult(infraBreaker, combined, p.exitCode);
        log(`FLEET_AGENT sync ${syncResult(combined, p.exitCode)} at ${new Date().toISOString()}`);
    };
    const startedAt = Date.now();
    let marketRefresh: ReturnType<typeof spawn> | null = null;
    for (;;) {
        // While a signal stop waits for the trades, the agent starts nothing, and it does not update or respawn itself.
        if (stopping) { await Bun.sleep(1_000); continue; }
        if (!renewLease(lock)) {
            log(`FLEET_AGENT lost its lease to another agent${running.size ? ': it ends when its trade ends' : ''} at ${new Date().toISOString()}`);
            if (!running.size) process.exit(0);
            await Bun.sleep(60_000);
            continue;
        }
        const infraGate = infraBreaker.canProceed();
        if (!infraGate.allowed) {
            log(`FLEET_AGENT infra circuit open (${infraGate.reason}); backing off at ${new Date().toISOString()}`);
            if (once && !running.size) break;
            await Bun.sleep(Math.min(CYCLE, Math.max(5_000, infraGate.waitMs)));
            continue;
        }
        const update = spawnSyncTimed([process.execPath, '--smol', 'packages/fleet/src/live-update.ts'], {
            cwd: base,
            windowsHide: true,
            env: leanBunEnv({ ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }),
            stdout: 'pipe',
            stderr: 'pipe',
            timeout: AGENT_SUBPROCESS_TIMEOUT_MS,
        });
        const updateOut = `${update.stdout.toString()}${update.stderr.toString()}`;
        const updateLine = lastResult(updateOut);
        if (update.exitCode !== 0) recordAgentInfraResult(infraBreaker, updateOut, update.exitCode);
        if (!/ live-update (?:none|off|paused)/.test(updateLine)) log(`FLEET_AGENT ${updateLine} at ${new Date().toISOString()}`);
        if (!renewLease(lock)) continue;
        if (!once && !marketRefresh && marketStale(base)) {
            marketRefresh = spawn(process.execPath, ['--smol', join(base, 'scripts', 'market-cache.ts')], { cwd: base, env: leanBunEnv(process.env), windowsHide: true, stdio: 'ignore' });
            marketRefresh.on('exit', () => { marketRefresh = null; });
            marketRefresh.on('error', () => { marketRefresh = null; });
        }
        if (!once && !running.size && reloadDue(base, 'fleet-agent', startedAt)) {
            release();
            // respawnDaemon passes process.env on, so a successor of a foreground run writes its own lines too.
            process.env[AGENT_LOG_DIRECT] = '1';
            const pid = respawnDaemon(base, [join(base, 'scripts', 'fleet-agent.ts')], logFile);
            log(`FLEET_AGENT reload after a live update: successor pid ${pid}`);
            process.exit(0);
        }
        sync();
        if (!renewLease(lock)) continue;
        const dir = FLEET_DIR(), now = Date.now(), side = mySide(), owners = loadOwners();
        const { orders, receipts } = readActiveOrdersAndReceipts(dir, now, runningOrders);
        const handJobs = readAgentJobs();
        const busy = swarmBusy(handJobs);
        for (const acct of brainBusyAccounts(base, handJobs, now)) busy.add(acct.toLowerCase());
        const ownerStop = fleetOwnerStop(base);
        const pending = readPendingUpdate(base, now);
        const tradeDrained = pending ? drainedFiles(pending, [TRADE_ENTRY_REL], base) : [];
        const pass = planTradePass({
            orders, receipts, side, owners, busy, running, runningOrders, now,
            halt: ownerStop ?? (stopping ? 'agent stopping' : null),
            drain: pending ? { drained: tradeDrained, target: pending.target, others: pending.others } : null,
            stopHeld: account => tradeStop(base, account, now, false).held,
            wrote: (id, role) => existsSync(join(dir, 'receipts', `${id}.${role}.json`)),
            claimHeld: accounts => readTradeClaims(base, accounts),
            admit: tradePreflight({ base, dir, now, env: () => tradeEnvironment(dir) }),
        });
        for (const w of pass.waits) log(`FLEET_AGENT ${w.kind} ${w.account}: order ${w.order.id} waits (${w.why})`);
        // A due reload waits for the running trades, and new trades keep it waiting: each new trade runs the old
        // source, and its release holds every new-release start in the fleet. While the reload is due only the second
        // party of an order that already runs starts, so the running trades end and the agent reloads.
        const starts = reloadStarts(pass.starts, runningOrders, !once && reloadDue(base, 'fleet-agent', startedAt));
        if (starts.length < pass.starts.length) {
            log(`FLEET_AGENT reload waits: ${pass.starts.length - starts.length} new trade(s) held until ${running.size} running trade(s) end`);
        }
        for (const e of pass.ends) {
            const key = e.account.toLowerCase();
            if (endAsked.has(key)) continue;
            endAsked.add(key);
            writeTradeStop(base, e.account);
            log(`FLEET_AGENT end ${e.account}: order ${e.order} ends early (${e.why})`);
        }
        for (const t of starts) {
            const stop = tradeStop(base, t.account, now);
            if (stop.cleared) log(`FLEET_AGENT removed the swarm's own stop file for ${t.account}`);
            if (stop.held) { log(`FLEET_AGENT held ${t.account}: order ${t.order.id} waits (${stop.held})`); continue; }
            const accountKey = t.account.toLowerCase();
            running.set(accountKey, t.account);
            runningOrders.set(accountKey, t.order.id);
            askedToStop.delete(accountKey);
            endAsked.delete(accountKey);
            log(`FLEET_AGENT start ${t.account} order ${t.order.id}`);
            const tradeStartedAt = Date.now();
            try {
                const p = Bun.spawn([process.execPath, '--smol', TRADE_SCRIPT, t.account, 'fleet-trade', t.order.id], {
                    cwd: base, stdout: 'pipe', stderr: 'pipe', windowsHide: true, env: leanBunEnv(tradeEnvironment(dir)),
                });
                void (async () => {
                    try {
                        const [out, errOut, exitCode] = await Promise.all([
                            new Response(p.stdout).text(),
                            new Response(p.stderr).text(),
                            p.exited,
                        ]);
                        if (errOut.trim()) log(errOut.trimEnd(), 'err');
                        const combined = `${out}\n${errOut}`;
                        if (exitCode !== 0) recordAgentInfraResult(infraBreaker, combined, exitCode);
                        const result = out.split(/\r?\n/).filter(l => l.startsWith('RESULT')).at(-1);
                        log(`FLEET_AGENT done ${t.account} ${result ?? 'no result'}`);
                        const noRoute = queueTradeNoRoute({ base, account: t.account, result, startedAt: tradeStartedAt, logPath: logFile });
                        if (noRoute) log(`FLEET_AGENT no-route ${t.account}: queued for the swarm's outcome record (${noRoute})`);
                    } catch (err) {
                        log(`FLEET_AGENT error ${t.account} ${String(err).slice(0, 160)}`);
                    } finally {
                        running.delete(accountKey);
                        runningOrders.delete(accountKey);
                        // The stop file of an early end served this run only.
                        if (endAsked.delete(accountKey)) clearSwarmStop(tradeStopFile(base, t.account));
                        if (renewLease(lock)) sync();
                    }
                })();
            } catch (err) {
                running.delete(accountKey);
                runningOrders.delete(accountKey);
                log(`FLEET_AGENT spawn failed ${t.account}: ${String(err).slice(0, 160)}`);
            }
        }
        if (once && !running.size) break;
        const soon = orders.some(o => o.end > now && o.start - now < LEAD && (sideOf(o.from, owners) === side || sideOf(o.to, owners) === side));
        await Bun.sleep(soon || running.size ? 60_000 : CYCLE);
    }
}

if (import.meta.main) {
    await runFleetAgentCli(process.argv.slice(2));
}
