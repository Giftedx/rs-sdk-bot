// One side of a cross-machine transfer. An order (fleet/orders/<id>.json, synced through git by scripts/fleet-sync.ts)
// names a donor and a receiver, an item, a count and a time window. Each side runs this for its own account, on its
// own machine: both walk to the meeting tiles (Varrock West, the ones scripts/coin-courier.ts proved live), the donor
// takes the stack out of its bank (noted when it is not a stack) and serves one trade to the receiver only, the
// receiver trades for exactly that offer and banks it. Each side writes its own receipt to fleet/receipts.
// Usage: bun scripts/fleet-trade.ts <account> [order id]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openBot, finish, getWorld, accountOf, countItems } from '../packages/core/src/bot';
import { goTo } from '../packages/core/src/walk';
import { waitUntil } from '../packages/core/src/ticks';
import { depositObserved } from '../packages/core/src/deposit';
import { exactItem } from '../packages/core/src/cargo';
import { FLEET_DIR, mySide } from '../packages/core/src/fleet';
import { tradePartners } from '../packages/core/src/tradeguard';
import { jobAccounts, mergedPlan, readCoordinatorJobs } from '../packages/core/src/coordinator-jobs';
import { liveLogoutRef } from '../packages/core/src/session-admission';
import { readLogoutProof } from '../packages/core/src/session-lifecycle';
import { pidAlive } from '../packages/core/src/session-takeover';
import { meetingTiles } from './coin-courier';

type Tile = { x: number; z: number; level: number };
export type Order = { id: string; server: string; from: string; to: string; item: string; count: number; start: number; end: number; meet?: [Tile, Tile] };
export type Receipt = { id: string; account: string; role: 'from' | 'to'; side: string; ok: boolean; count: number; at: number; detail: string };

export function validOrder(o: any): o is Order {
    return !!o && /^[A-Za-z0-9_-]{1,64}$/.test(o.id) && typeof o.server === 'string' && [o.from, o.to].every(n => /^[A-Za-z0-9]{1,12}$/.test(n))
        && o.from.toLowerCase() !== o.to.toLowerCase() && typeof o.item === 'string' && o.item.length > 0
        && Number.isSafeInteger(o.count) && o.count > 0 && o.count <= 2147483647 && Number.isSafeInteger(o.start) && Number.isSafeInteger(o.end) && o.end > o.start;
}
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
        if (!Array.isArray(runs) || runs.some(run => includesAccount(run) && pidAlive(run.pid))) {
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

if (import.meta.main) {
    const [account, onlyId] = process.argv.slice(2);
    if (!account) { console.log('RESULT fail usage: fleet-trade.ts <account> [order id]'); process.exit(2); }
    const dir = FLEET_DIR(), orders = readJson(join(dir, 'orders')).filter(validOrder).filter(o => !onlyId || o.id === onlyId);
    const picked = pickOrder(orders, readJson(join(dir, 'receipts')), account, Date.now());
    if (!picked) { console.log(`RESULT ok fleet-trade no open order for ${account}`); process.exit(0); }
    const { order, role } = picked, partner = role === 'from' ? order.to : order.from;
    // The partner must be one this machine proved or the owners file lists: never trade with a stranger.
    if (!tradePartners(order.server).has(partner.toLowerCase())) {
        console.log(`RESULT fail fleet-trade ${order.id}: ${partner} is not a listed fleet account`); process.exit(1);
    }
    const receipt = (ok: boolean, count: number, detail: string) => {
        mkdirSync(join(dir, 'receipts'), { recursive: true });
        const r: Receipt = { id: order.id, account, role, side: mySide(), ok, count, at: Date.now(), detail };
        writeFileSync(join(dir, 'receipts', `${order.id}.${role}.json`), JSON.stringify(r, null, 1) + '\n');
        console.log('FLEET_RECEIPT ' + JSON.stringify(r));
    };
    while (Date.now() < order.start) await Bun.sleep(Math.min(5000, order.start - Date.now()));
    const s = await openBot(account, {
        admitWithPlanLock: server => assertTradeAdmission(order, account, server, { receipts: join(dir, 'receipts') }),
    }).catch(e => finish([], false, `login: ${String(e)}`));
    const item = exactItem(order.item), held = () => countItems(s, item), left = () => order.end - Date.now();
    try {
        const meet = order.meet ?? meetingTiles({ x: 3185, z: 3436 })!, tile = role === 'from' ? meet[0] : meet[1];
        const there = await goTo(s, await getWorld(), tile, accountOf(s), { legTimeoutTicks: 100 });
        if (!there.ok) throw Error(`route to ${tile.x},${tile.z}: ${there.reason} ${there.detail}`);
        await s.bot.walkTo(tile.x, tile.z, 0);
        if (role === 'from' && held() < order.count) {
            if (!(await s.bot.openBank()).success || !await waitUntil(s, () => !!s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 20 })) throw Error('bank did not open');
            const row = s.sdk.getState()!.bank.items.find(i => item.test(i.name));
            if (!row || row.count + held() < order.count) throw Error(`stock short: ${row?.count ?? 0} banked + ${held()} held < ${order.count}`);
            const stack = s.sdk.getInventory().find(i => item.test(i.name));
            // A count of a non-stacking item comes out as notes; coins and runes already stack.
            const asNote = order.count - held() > 1 && !/^coins$/i.test(order.item) && !(stack && stack.count > 1);
            await s.bot.withdrawItem(row, order.count - held(), { asNote });
            await waitUntil(s, () => held() >= order.count, { timeoutTicks: 10 });
            await s.bot.closeBank();
            if (held() < order.count) throw Error(`withdraw short: ${held()} of ${order.count}`);
        }
        const before = held();
        if (role === 'from') {
            await s.bot.serveTrades({ from: exactItem(partner), give: [{ item, amount: order.count }], accept: offer => offer.length === 0, maxTrades: 1, timeout: Math.max(1000, left()) });
            await waitUntil(s, () => held() <= before - order.count, { timeoutTicks: 10 });
            const gave = before - held();
            receipt(gave === order.count, gave, `${account} gave ${gave} ${order.item} to ${partner}`);
            await finish([s], gave === order.count, `fleet-trade ${order.id} gave=${gave}/${order.count}`);
        } else {
            // The donor may arrive late. Trade requests are not player input, so step one tile off the meeting tile and
            // back each round to beat the idle logout (about 900 ticks), and stop once the session ends.
            let ended = false;
            void s.ended.then(() => { ended = true; });
            for (let round = 0; !ended && left() > 0 && held() < before + order.count; round++) {
                await s.bot.trade(exactItem(partner), { accept: offer => offer.length === 1 && item.test(offer[0]!.name) && offer[0]!.count === order.count, requestTimeout: 30_000, timeout: 60_000 });
                await waitUntil(s, () => held() >= before + order.count || ended, { timeoutTicks: 10 });
                if (!ended && held() < before + order.count) await s.bot.walkTo(tile.x + (round % 2 === 0 ? 1 : 0), tile.z, 0);
            }
            if (ended && held() < before + order.count) throw Error(`session ended while waiting for ${partner}`);
            const got = held() - before;
            if (got > 0) {
                if ((await s.bot.openBank()).success && await waitUntil(s, () => !!s.bankObservation?.(), { timeoutTicks: 20 })) {
                    const stack = s.sdk.getInventory().find(i => item.test(i.name));
                    if (stack) await depositObserved(s, stack);
                }
                await s.bot.closeBank();
            }
            receipt(got === order.count, got, `${account} received ${got} ${order.item} from ${partner}`);
            await finish([s], got === order.count, `fleet-trade ${order.id} received=${got}/${order.count}`);
        }
    } catch (e) { receipt(false, 0, String(e)); await finish([s], false, `fleet-trade ${order.id}: ${String(e)}`); }
}
