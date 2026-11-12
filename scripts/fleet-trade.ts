// One side of a cross-machine transfer. An order (fleet/orders/<id>.json, synced through git by scripts/fleet-sync.ts)
// names a donor and a receiver, an item, a count and a time window. Each side runs this for its own account, on its
// own machine: both walk to the meeting tiles (Varrock West, the ones scripts/coin-courier.ts proved live), the donor
// takes the stack out of its bank (noted when it is not a stack) and serves one trade to the receiver only, the
// receiver trades for exactly that offer and banks it. Each side writes its own receipt to fleet/receipts.
// Usage: bun scripts/fleet-trade.ts <account> [order id]
// Run it with STALL_TICKS=0, as scripts/fleet-agent.ts does: the wait for the partner is bounded by the order window,
// and the session's idle guard would end it after 900 ticks.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openBot, finish, countItems } from '../packages/core/src/bot';
import { walkTarget } from './walk-to';
import type { Outcome } from '../packages/core/src/act';
import { waitUntil } from '../packages/core/src/ticks';
import { depositObserved } from '../packages/core/src/deposit';
import { exactItem } from '../packages/core/src/cargo';
import { FLEET_DIR } from '../packages/core/src/fleet';
import { tradePartners } from '../packages/core/src/tradeguard';
import { jobAccounts, mergedPlan, readCoordinatorJobs } from '../packages/core/src/coordinator-jobs';
import { liveLogoutRef } from '../packages/core/src/session-admission';
import { readLogoutProof } from '../packages/core/src/session-lifecycle';
import { pidAlive } from '../packages/core/src/session-takeover';
import { laterProcessHolds, processStartTimes } from '../packages/practice/src/proc';
import { isLocalServer } from '../packages/core/src/localserver';
import { meetingTiles } from './coin-courier';
import type { Session } from '../packages/core/src/inprocess';
import type { TradeResult } from '../vendor/rs-sdk/sdk/types';
import { validOrder, writeTradeReceipt, type Order, type Receipt, type TradeReceipt, type TradeRole } from './fleet-trade-settlement';
export { validOrder, type Order, type Receipt } from './fleet-trade-settlement';

// The open order this account takes part in: in its window (or starting within `lead` ms) and with no receipt from it.
export function pickOrder(orders: readonly Order[], receipts: readonly Receipt[], account: string, now: number, lead = 10 * 60_000): { order: Order; role: 'from' | 'to' } | null {
    const me = account.toLowerCase();
    for (const order of [...orders].sort((a, b) => a.start - b.start)) {
        const role = order.from.toLowerCase() === me ? 'from' : order.to.toLowerCase() === me ? 'to' : null;
        if (!role || now >= order.end || order.start - now > lead) continue;
        if (receipts.some(r => r.id === order.id && r.role === role)) continue;
        return { order, role };
    }
    return null;
}

const readJson = (dir: string) => existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).flatMap(f => { try { return [JSON.parse(readFileSync(join(dir, f), 'utf8'))]; } catch { return []; } }) : [];
const root = resolve(import.meta.dir, '..');
const tradePlanFile = (base: string) => resolve(process.env.SWARM_PLAN ?? join(base, 'swarm.json'));

function readTradePlan(file: string) {
    const plan = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(plan?.jobs)) throw Error('fleet trade: invalid swarm plan');
    return plan;
}

export function readAgentJobs(file = tradePlanFile(root)): readonly any[] {
    return readTradePlan(file).jobs;
}

export function swarmBusy(jobs: readonly any[]): Set<string> {
    return new Set(jobs.filter(j => j?.enabled).flatMap(j => [j.account, ...(j.accounts ?? [])]).filter((n): n is string => typeof n === 'string').map(n => n.toLowerCase()));
}

export function assertTradeAdmission(order: Order, account: string, server: string, {
    base = root, planFile = tradePlanFile(base), receipts = join(FLEET_DIR(), 'receipts'), now = Date.now(),
    starts = processStartTimes as (pids: readonly number[]) => ReadonlyMap<number, number> | null,
} = {}): void {
    const name = account.toLowerCase();
    const role = order.from.toLowerCase() === name ? 'from' : order.to.toLowerCase() === name ? 'to' : null;
    if (!role) throw Error('fleet trade: account is outside the order');
    if (server.toLowerCase() !== order.server.toLowerCase()) throw Error('fleet trade: account server differs from order server');
    if (now < order.start || now >= order.end) throw Error('fleet trade: outside order window');
    const practice = join(base, '.practice');
    const stopFiles = new Set(readdirSync(practice).map(file => file.toLowerCase()));
    if (stopFiles.has('stop-swarm')) throw Error('fleet trade: swarm is paused');
    if (stopFiles.has('stop-' + name)) throw Error('fleet trade: account has an owner stop file');
    const plan = readTradePlan(planFile), overlay = readCoordinatorJobs(base);
    if (overlay.paused?.some(n => n.toLowerCase() === name)) throw Error('fleet trade: account is paused for controller rollout');
    const includesAccount = (job: any) => jobAccounts(job).some(n => n.toLowerCase() === name);
    if (plan.jobs.some((job: any) => includesAccount(job) && (!job.script || /fresh.clock|24 boards|main simultaneous/i.test(job.goal ?? '')))) {
        throw Error('fleet trade: reserved account');
    }
    if (swarmBusy(mergedPlan(plan, overlay).jobs).has(name)) throw Error('fleet trade: account has an enabled swarm job');
    const runsFile = join(practice, 'swarm-runs.json');
    if (existsSync(runsFile)) {
        const runs = JSON.parse(readFileSync(runsFile, 'utf8'));
        // A run whose id answers a signal is unsettled, unless the process that holds the id started after the run
        // record (laterProcessHolds). One read of the process table, and only when such a run names this account.
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

type Progress = Pick<TradeReceipt, 'count' | 'inventory' | 'bank' | 'screen'> & { uncertain: boolean };
// Records in `progress.screen` whether a trade screen is ever open in this session (TradeReceipt.screen). Call it
// once, as soon as the session is open.
export function watchTradeScreen(s: { onTick(cb: () => void): () => void; sdk: { getState(): { trade?: { isOpen: boolean } } | null } }, progress: Progress) {
    const look = () => { const trade = s.sdk.getState()?.trade; if (trade) progress.screen = !!progress.screen || trade.isOpen; };
    look();
    return s.onTick(look);
}
const requestRefusal = (result: TradeResult) => !result.success && !result.partner
    && ['player_not_found', 'no_response', 'busy'].includes(result.reason ?? '')
    && !result.gave.length && !result.received.length && !result.possiblyDropped?.length;

// The partner's own receipt says its side failed: it will not come to the meet. Live: a taker that could not pay its
// ferry fare failed at once, and its giver stood at the meet to the end of a 50-minute window; two such sessions,
// started on the release before a rollout, also held back every new trade login until they ended. A receipt of this
// machine's side is on disk at once, another side's after its next sync.
export function partnerFailed(dir: string, order: Order, role: TradeRole): boolean {
    try {
        const receipt = JSON.parse(readFileSync(join(dir, `${order.id}.${role === 'from' ? 'to' : 'from'}.json`), 'utf8'));
        return receipt?.version === 2 && receipt.id === order.id && receipt.state === 'failed';
    } catch { return false; }
}

export async function performFleetTransfer(s: Session, order: Order, role: TradeRole, progress: Progress, {
    now = Date.now, wait = waitUntil, deposit = depositObserved, gone = () => false,
}: { now?: () => number; wait?: typeof waitUntil; deposit?: typeof depositObserved; gone?: () => boolean } = {}) {
    const item = exactItem(order.item), held = () => countItems(s, item), left = () => order.end - now();
    const partner = role === 'from' ? order.to : order.from, peer = exactItem(partner);
    const pack = () => s.sdk.getInventory().filter(i => item.test(i.name));
    const beforeById = new Map<number, number>();
    for (const row of pack()) beforeById.set(row.id, (beforeById.get(row.id) ?? 0) + row.count);
    const before = held(), diff = () => role === 'from' ? before - held() : held() - before;
    let result: TradeResult | undefined;
    if (left() <= 0) throw Error('order window ended before trade');
    if (role === 'from') {
        progress.uncertain = true;
        const served = await s.bot.serveTrades({
            from: peer, give: [{ item, amount: order.count }], accept: offer => offer.length === 0,
            maxTrades: 1, timeout: left(), onTrade: trade => { result = trade; }, until: () => result !== undefined || gone(),
        });
        if (!result && (served.reason === 'timeout' || served.reason === 'until') && !served.trades.length && diff() === 0) progress.uncertain = false;
        if (!result && gone() && !progress.uncertain) throw Error('partner failed: no trade');
    } else {
        let ended = false;
        void s.ended.then(() => { ended = true; });
        for (let round = 0; !ended && left() > 0; round++) {
            if (gone()) throw Error('partner failed: no trade');
            progress.uncertain = true;
            result = await s.bot.trade(peer, {
                accept: offer => offer.length === 1 && item.test(offer[0]!.name) && offer[0]!.count === order.count,
                requestTimeout: Math.min(30_000, left()), timeout: Math.min(60_000, left()),
            });
            if (!requestRefusal(result) || diff() !== 0) break;
            progress.uncertain = false;
            const tile = (order.meet ?? meetingTiles({ x: 3185, z: 3436 })!)[1];
            if (!ended && left() > 0) await s.bot.walkTo(tile.x + (round % 2 === 0 ? 1 : 0), tile.z, 0);
        }
    }
    if (result?.success) await wait(s, () => diff() === order.count, { timeoutTicks: 10 });
    const after = held(), count = diff();
    progress.inventory = { before, after };
    progress.count = Math.max(0, count);
    const transferred = role === 'from' ? result?.gave : result?.received;
    const opposite = role === 'from' ? result?.received : result?.gave;
    if (!result?.success || !result.partner || !peer.test(result.partner) || result.possiblyDropped?.length
        || count !== order.count || opposite?.length || !transferred?.length || !transferred.every(i => item.test(i.name))
        || transferred.reduce((n, i) => n + i.count, 0) !== order.count) {
        throw Error(progress.uncertain ? 'transfer requires reconciliation' : 'no matching trade completed');
    }
    if (role === 'from') return;
    if (!(await s.bot.openBank()).success || !await wait(s, () => !!s.bankObservation?.(), { timeoutTicks: 20 }))
        throw Error('receiver bank observation unavailable');
    let credited = 0, bankAt = 0;
    for (const id of new Set(transferred.map(i => i.id))) {
        const rows = pack().filter(i => i.id === id), stack = rows[0];
        const incoming = transferred.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
        const amount = rows.reduce((n, i) => n + i.count, 0);
        if (!stack || amount - (beforeById.get(id) ?? 0) !== incoming) throw Error('receiver item delta differs from trade');
        if (await deposit(s, stack) !== amount) throw Error('receiver bank credit was not confirmed');
        const observation = s.bankObservation?.();
        if (!observation) throw Error('receiver bank credit observation unavailable');
        bankAt = Math.max(bankAt, observation.at);
        credited += incoming;
    }
    progress.bank = { count: credited, at: bankAt };
    await s.bot.closeBank();
}

export function fleetTradeOutcome(prepared: TradeReceipt, progress: Progress, ok: boolean, logout: ReturnType<typeof readLogoutProof>,
    attemptId: string | undefined, at: number, detail: string): TradeReceipt {
    const proof = logout.state === 'confirmed' && logout.attemptId === attemptId && logout.loggedOutAt >= prepared.at
        && logout.account.toLowerCase() === prepared.account.toLowerCase() && logout.server.toLowerCase() === prepared.server.toLowerCase()
        ? { attemptId: logout.attemptId, at: logout.loggedOutAt, sha256: logout.receiptSha256 } : undefined;
    const exactBank = prepared.role === 'from' || progress.bank?.count === prepared.requested;
    const state = proof && ok && progress.count === prepared.requested && exactBank ? 'settled'
        : proof && !progress.uncertain && progress.count === 0 ? 'failed' : 'reconcile';
    return { ...prepared, state, ok: state === 'settled', count: progress.count, inventory: progress.inventory, bank: progress.bank, logout: proof, at, detail,
        ...(progress.screen === undefined ? {} : { screen: progress.screen }) };
}

if (import.meta.main) {
    const [account, onlyId] = process.argv.slice(2);
    if (!account) { console.log('RESULT fail usage: fleet-trade.ts <account> [order id]'); process.exit(2); }
    const dir = FLEET_DIR(), receipts = join(dir, 'receipts');
    const orders = readJson(join(dir, 'orders')).filter(validOrder).filter(o => !onlyId || o.id === onlyId);
    const picked = pickOrder(orders, readJson(receipts), account, Date.now());
    if (!picked) { console.log(`RESULT ok fleet-trade no open order for ${account}`); process.exit(0); }
    const { order, role } = picked, partner = role === 'from' ? order.to : order.from;
    if (isLocalServer(order.server)) {
        console.log('RESULT fail fleet-trade shared orders require a live server'); process.exit(2);
    }
    if (!tradePartners(order.server).has(partner.toLowerCase())) {
        console.log(`RESULT fail fleet-trade ${order.id}: ${partner} is not a listed fleet account`); process.exit(1);
    }
    let prepared: TradeReceipt | undefined;
    const progress: Progress = { uncertain: false, count: 0 };
    const complete = (s: Session, ok: boolean, detail: string) => finish([s], ok, settled => {
        if (!prepared) throw Error('trade claim journal unavailable');
        const receipt = fleetTradeOutcome(prepared, progress, settled, readLogoutProof(account, order.server), s.lifecycle?.attemptId, Date.now(), detail);
        writeTradeReceipt(receipts, receipt);
        console.log('FLEET_RECEIPT ' + JSON.stringify(receipt));
        if (settled && !receipt.ok) throw Error('trade requires reconciliation');
        return `fleet-trade ${order.id} ${receipt.state} ${receipt.count}/${order.count}: ${detail}`;
    });
    while (Date.now() < order.start) await Bun.sleep(Math.min(5000, order.start - Date.now()));
    const s = await openBot(account, {
        trade: {
            orderId: order.id, role,
            check: server => assertTradeAdmission(order, account, server, { receipts }),
            prepare: claim => {
                prepared = { version: 2, state: 'prepared', id: order.id, account, partner, role, side: claim.side, server: order.server,
                    item: order.item, requested: order.count, claim: claim.nonce, count: 0, ok: false, at: Date.now(), detail: 'trade claimed' };
                writeTradeReceipt(receipts, prepared);
            },
        },
        onStop: (session, detail) => complete(session, false, detail),
        onSessionEnd: (session, detail) => complete(session, false, detail),
    }).catch(e => finish([], false, `login: ${String(e)}`));
    let ok = false, detail: string;
    watchTradeScreen(s, progress);
    try {
        const meet = order.meet ?? meetingTiles({ x: 3185, z: 3436 })!, tile = role === 'from' ? meet[0] : meet[1];
        // The planner has no land route between Ardougne and the east; walkTarget takes the ferries then (60 coins in the
        // pack). Live: a taker in Ardougne failed "no route to 3182,3440" for a Varrock West meet.
        const there = await walkTarget(s, tile, false) as Outcome;
        if (!there.ok) throw Error(`route to ${tile.x}, ${tile.z}: ${there.reason} ${there.detail}`);
        await s.bot.walkTo(tile.x, tile.z, 0);
        const item = exactItem(order.item), held = () => countItems(s, item);
        if (role === 'from' && held() < order.count) {
            if (!(await s.bot.openBank()).success || !await waitUntil(s, () => !!s.bankObservation?.(), { timeoutTicks: 20 })) throw Error('bank did not open');
            const bankBefore = s.bankObservation?.(), row = bankBefore?.items.find(i => item.test(i.name));
            const amount = order.count - held(), bankCount = row?.count ?? 0;
            if (!bankBefore || !row || bankCount < amount) throw Error(`stock short: ${bankCount} banked + ${held()} held < ${order.count}`);
            const target = s.sdk.getState()?.bank.items.find(i => i.id === row.id);
            if (!target) throw Error('sender bank item is unavailable');
            const stack = s.sdk.getInventory().find(i => item.test(i.name));
            const asNote = amount > 1 && !/^coins$/i.test(order.item) && !(stack && stack.count > 1);
            progress.uncertain = true;
            await s.bot.withdrawItem(target, amount, { asNote });
            const confirmed = () => {
                const after = s.bankObservation?.();
                const remaining = after?.items.filter(i => i.id === row.id).reduce((n, i) => n + i.count, 0);
                return after && after.generation > bankBefore.generation && remaining === bankCount - amount && held() === order.count ? after : null;
            };
            if (!await waitUntil(s, () => !!confirmed(), { timeoutTicks: 10 })) throw Error('sender withdrawal debit or pack credit not confirmed');
            const bankAfter = confirmed();
            if (!bankAfter) throw Error('sender withdrawal observation changed');
            progress.bank = { count: amount, at: bankAfter.at };
            await s.bot.closeBank();
            progress.uncertain = false;
        }
        await performFleetTransfer(s, order, role, progress, { gone: () => partnerFailed(receipts, order, role) });
        ok = true;
        detail = 'transfer observed';
    } catch (error) { detail = String(error); }
    await complete(s, ok, detail);
}
