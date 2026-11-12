// Autopilot CLI: writes this fleet side's swarm jobs (packages/planner/src/autopilot.ts) into swarm.json. It replaces
// only jobs marked "autopilot": <this side>, keeps every other job, and never plans an account that an unmarked job
// names or another side owns. Each pass retires a planner job whose log since assignment shows repeated fail RESULTs,
// a death or near-total tick waste, and picks that account's next best template. Other sides' fresh claims
// (fleet/claims/<side>.json, written by scripts/fleet-sync.ts from each side's plan) count as taken, so the sides
// together never put more accounts on a spot than its capacity (CAPACITY in the planner).
// A job that only lacks coins gets them from a free account of this side: the pass writes a fleet order
// (fleet/orders), scripts/fleet-agent.ts runs the trade, and a later pass gives the job.
// An army account that lacks only kit items for a goal band gets them first: a capped Grand Exchange buy with its own
// coins, else an item order from a free account of this side, else of another side (fleet/snapshots and fleet/plans).
// An AIO route proved on practice only (a `pilot` template) is planned only while the plan's `aio` array names its id.
// Usage: bun scripts/autopilot.ts [swarm.json] [--dry] [--daemon]
// --daemon: a pass every 10 minutes, and one within TRAINER_POLL_MS of a planner trainer's ok RESULT (its target level
// is met and its job does not repeat, so the account would otherwise sit ended until the timer).
// Run beside DEMO_OK=1 bun scripts/swarm.ts and bun scripts/fleet-agent.ts --daemon, with FLEET_SIDE set.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { FLEET_DIR, loadOwners, mySide } from '../packages/core/src/fleet';
import { clearSwarmStop, swarmWroteStop } from './swarm';
import { withPlanWrite } from '../packages/core/src/plan-lock';
import { reloadDue, respawnDaemon } from '../packages/core/src/live-reload';
import { controllerNamed, leaseHolder, releaseLease, renewLease, saveLaunch, takeLease } from '../packages/core/src/controllers';
import { matchingJobLines } from '../packages/core/src/job-log';
import { CAPACITY, CLAIM_MAX_AGE_MS, DRAIN_RESULT, SHARED, accountFrom, assess, catalogue, finishedTrainers, freshest, jobResources, mergeJobs, norm, pairKey, plan, plannableAccounts, reservedResources, BUILD_QUESTS, KIT_BUY, KIT_BUY_SCRIPT, KIT_PRICE_CAPS, coinValueFor, type Assignment, type ItemFunding, type Market, type Stock } from '../packages/planner/src/autopilot';
import { jobAccounts, mergeJobs as withCoordinatorJobs, readCoordinatorJobs } from '../packages/core/src/coordinator-jobs';
import { tradeSettlement, validOrder, windowClosures, type Order, type Receipt, type TradeReceipt } from './fleet-trade-settlement';
import { readHeldFleetTradeClaims } from '../packages/core/src/fleet-trade-claim';
import { liveHelperStatuses, overallSupplyDemand, supplyBill, type BillRow } from '../packages/planner/src/supply-bill';
import { tickWaste, wasteShare } from './tick-waste';
import { kitSkills, levelsBeforeRoute } from './pk-kits';

const root = resolve(import.meta.dir, '..'), prac = join(root, '.practice');
const PASS_EVERY_MS = 10 * 60_000, TRAINER_POLL_MS = 30_000;
const PAUSED = 'AUTOPILOT hold: swarm is paused';
// A pass that changes the resources this plan's enabled jobs hold publishes the side's claim at once. Other sides plan
// against origin's claims (newestClaims), and a claim that waits for the fleet agent's next sync (up to 10 minutes)
// lets two sides give the same knight place in that window.
export const CLAIM_CHANGED = 'AUTOPILOT claim changed: publishing it now';
export const heldResources = (jobs: readonly any[]) => jobs.filter(j => j?.enabled !== false).flatMap(j => jobResources(j)).sort().join('|');
const swarmPaused = () => existsSync(join(prac, 'stop-swarm'));
// A retirement records the hash of its template's script; an entry from before that is a bare reason.
type Retirement = string | { reason: string; script: string };
// `kitSeq`: each account's kit-buy count, which names its Grand Exchange order keys (kitBuyTemplate).
type State = { assigned: Record<string, { template: string; offset: number; at: number }>; retired: Record<string, Retirement>; kitSeq?: Record<string, number>;
    // `unsold`: when a kit buy last got none of an item, by item id. The market leaves the item out for UNSOLD_RETRY_MS.
    unsold?: Record<string, number> };
// A retirement holds while its template's script is unchanged, so a fix to the script gives the pair its retries back.
// A death holds until a person clears it, and so does a pair whose template is gone. A bare reason takes the current
// script, so nothing comes back on the pass that first reads it. One whose last RESULT is now a drain (DRAIN_RESULT)
// lapses: it was not the job's failure.
export function liveRetirements(retired: Readonly<Record<string, Retirement>>, scriptOf: (template: string) => string | undefined): { retired: Record<string, Retirement>; lapsed: string[] } {
    const out: Record<string, Retirement> = {}, lapsed: string[] = [];
    for (const [key, r] of Object.entries(retired)) {
        const reason = typeof r === 'string' ? r : r.reason, script = scriptOf(key.slice(key.indexOf(':') + 1));
        const result = reason.indexOf('RESULT ');
        if (!/^death\b/.test(reason) && result >= 0 && DRAIN_RESULT.test(reason.slice(result))) lapsed.push(key);
        else if (/^death\b/.test(reason) || script === undefined) out[key] = r;
        else if (typeof r === 'string') out[key] = { reason, script };
        else if (r.script === script) out[key] = r;
        else lapsed.push(key);
    }
    return { retired: out, lapsed };
}

const readJson = (f: string, fallback: any) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; } };
const loadState = (side: string): State => ({ assigned: {}, retired: {}, ...readJson(join(prac, 'autopilot', `${side}.json`), {}) });
const writeAtomic = (f: string, text: string) => { writeFileSync(`${f}.tmp`, text); renameSync(`${f}.tmp`, f); };
export function readJobResultLines(file: string, offset: number, job: Parameters<typeof matchingJobLines>[1]): string[] {
    if (!existsSync(file)) return [];
    const size = statSync(file).size, start = offset <= size ? offset : 0, buf = Buffer.alloc(Math.min(size - start, 4_000_000));
    const fd = openSync(file, 'r');
    let read: number;
    try { read = readSync(fd, buf, 0, buf.length, size - buf.length); } finally { closeSync(fd); }
    const lines = buf.subarray(0, read).toString('utf8').split(/\r?\n/);
    lines.pop(); // A supervisor can still be writing the final line.
    return matchingJobLines(lines, job);
}

function routeBill(items: any[]): BillRow[] {
    try {
        const { supplies } = overallSupplyDemand();
        return supplyBill(supplies, items, liveHelperStatuses());
    } catch (e) {
        const bill = readJson(join(prac, 'coordinator/supply-bill.json'), null);
        const scoped = bill?.scope === 'overall' && Array.isArray(bill.rows);
        console.log(`AUTOPILOT ${scoped ? 'uses saved Overall supply bill' : 'has no Overall supply bill'}: ${String(e).slice(0, 120)}`);
        return scoped ? bill.rows : [];
    }
}

// The fleet order format of scripts/fleet-order.ts, built here so the planner does not load the bot client that
// scripts/fleet-trade.ts imports. scripts/fleet-agent.ts checks every order with validOrder before it trades.
export function coinOrder(from: string, to: string, coins: number, server: string, now: number): Order {
    const start = now + 15 * 60_000;
    return { id: `${start}-${from}-${to}`.toLowerCase(), server, from, to, item: 'coins', count: coins, start, end: start + 40 * 60_000 };
}
// The tile pair at the Ardougne north bank, the army's home bank: scripts/coin-courier.ts meetingTiles for the bank
// tile 2619,3332 (scripts/autopilot.test.ts checks the two agree). A kit item order meets there.
export const ARMY_MEET: NonNullable<Order['meet']> = [{ x: 2618, z: 3333, level: 0 }, { x: 2617, z: 3333, level: 0 }];
// A kit item order: the same window as a coin order, at the army's home bank. The id carries the item, so two orders
// for one pair in one pass differ.
export function itemOrder(from: string, to: string, item: string, count: number, server: string, now: number): Order {
    const start = now + 15 * 60_000;
    return { id: `${start}-${from}-${to}-${item.replace(/[^A-Za-z0-9]+/g, '')}`.toLowerCase().slice(0, 64), server, from, to, item, count, start, end: start + 40 * 60_000, meet: ARMY_MEET };
}
// A side's free accounts as kit donors, from its published snapshot and plan (fleet/snapshots, fleet/plans): the side
// published a plan within `maxAgeMs` (SIDE_STOCK_MAX_AGE_MS: its fleet agent syncs every 10 minutes, so it runs and
// will trade), and the account has no enabled job in that
// plan and is in no open order. That side's planner keeps a party to an open order vacant until the order closes.
export const SIDE_STOCK_MAX_AGE_MS = 30 * 60_000;
export function sideStock(side: string, snapshot: any, plan: any, open: ReadonlySet<string>, now: number, maxAgeMs: number, itemName: (id: number) => string | undefined): Stock[] {
    if (!Array.isArray(snapshot?.accounts) || !Array.isArray(plan?.jobs) || !(now - plan.at < maxAgeMs)) return [];
    const busy = enabledAccounts(plan.jobs);
    return snapshot.accounts.filter((r: any) => typeof r?.name === 'string' && !busy.has(r.name.toLowerCase()) && !open.has(r.name.toLowerCase()) && r.name.toLowerCase() !== 'haggis')
        .map((r: any) => { const a = accountFrom(r.name, side, r, itemName); return { name: a.name, side, items: a.items }; });
}
// Donor and recipient pairs whose item order failed or needs reconciliation in the last `windowMs`, as `from>to` in lower
// case. The same donor would fail the same way (an owner pause the published plan does not show, a tile it cannot
// reach), so the planner asks another donor.
export const SEND_RETRY_MS = 24 * 3600_000;
export function failedSends(orders: readonly Order[], receipts: readonly Receipt[], now: number, windowMs = SEND_RETRY_MS): Set<string> {
    const out = new Set<string>();
    for (const o of orders) {
        if (o.item.toLowerCase() === 'coins' || now - o.start > windowMs) continue;
        const state = tradeSettlement(o, receipts, now).state;
        if (state === 'failed' || state === 'reconcile') out.add(`${o.from}>${o.to}`.toLowerCase());
    }
    return out;
}
// Sides that answer no orders: the giver of the side's latest closed order (window over, in the last `windowMs`) wrote
// no receipt. A giver writes one when it takes its trade claim (scripts/fleet-trade.ts), so none means the side's
// fleet agent ran no trade for it: its plan may be fresh while its trades do not run. The planner asks such a side for
// nothing: a taker waits out the order's lead and window with no job for each ask (live claude-cloud: two army
// accounts each stood with no job for a local giver that never logged in). An order the side later answers brings it
// back.
export function silentSides(orders: readonly Order[], receipts: readonly Receipt[], sideOf: (account: string) => string | undefined, now: number, windowMs = SEND_RETRY_MS): Set<string> {
    const latest = new Map<string, Order>();
    for (const o of orders) {
        const side = sideOf(o.from);
        if (!side || now < o.end || now - o.end > windowMs) continue;
        if (!latest.has(side) || latest.get(side)!.end < o.end) latest.set(side, o);
    }
    return new Set([...latest].filter(([, o]) => !receipts.some(r => r?.id === o.id && r.role === 'from')).map(([side]) => side));
}
// Item ids a kit buy offered for and got none of: its failed RESULT holds "acquired":0 and the offer's "itemId"
// (scripts/buy-owned-ge-item.ts refunds the whole offer). That says the Grand Exchange has no seller under the price
// cap, not that the buy job is broken: the pair is not retired, and the item leaves the market for a day, so the next
// pass buys the other lines and asks a donor for this one.
export const UNSOLD_RETRY_MS = 24 * 3600_000;
export function unfilledItems(lines: readonly string[]): number[] {
    const out = new Set<number>();
    for (const l of lines) {
        if (!/RESULT fail \{/.test(l) || !/"acquired":0\b/.test(l)) continue;
        const id = l.match(/"itemId":(\d+)/);
        if (id) out.add(Number(id[1]));
    }
    return [...out];
}
// A kit buy that has started and printed no RESULT yet holds an open Grand Exchange offer: its coins are in the
// exchange, so the account's live status shows them gone. The pass leaves such a job as it is.
export function kitBuyRunning(job: any, assigned: { template: string; offset: number } | undefined, linesSince: (offset: number) => readonly string[]): boolean {
    if (!job?.enabled || typeof job.template !== 'string' || !job.template.startsWith(KIT_BUY) || !assigned || assigned.template !== job.template) return false;
    const r = assess(linesSince(assigned.offset));
    return r.ok + r.fail + r.drains === 0;
}
// Accounts with an enabled job, as scripts/fleet-agent.ts swarmBusy counts them: the agent trades for no other account.
const enabledAccounts = (jobs: readonly any[]) => new Set(jobs.filter(j => j?.enabled).flatMap(j => [j.account, ...(j.accounts ?? [])]).filter((n): n is string => typeof n === 'string').map(n => n.toLowerCase()));
// New receipts hold both parties through a matched settlement or explicit reconciliation, even after the window. An
// order the receipts close after its window (scripts/fleet-trade-settlement.ts windowClosures) holds no one, beyond
// the stock check on a settled transfer: live, two such orders kept TrouserSnake and Deeppockets jobless for hours.
export function inOpenOrder(orders: readonly Order[], receipts: readonly Receipt[], now: number,
    stockReady: (receipt: TradeReceipt) => boolean = () => true, claimHeld: (nonce: string) => boolean = () => true): Set<string> {
    const held = new Set<string>(), closed = windowClosures(orders, receipts, now, claimHeld);
    for (const order of orders) {
        const settlement = closed.get(order.id) ?? tradeSettlement(order, receipts, now);
        if (settlement.state !== 'settled' && settlement.state !== 'failed') {
            if (order.end > now || settlement.state !== 'legacy') {
                held.add(order.from.toLowerCase());
                held.add(order.to.toLowerCase());
            }
            continue;
        }
        for (const receipt of settlement.receipts as TradeReceipt[]) {
            if (!stockReady(receipt)) held.add(receipt.account.toLowerCase());
        }
    }
    return held;
}

export function tradeStockReady(receipt: TradeReceipt, status: any): boolean {
    return typeof status?.name === 'string' && status.name.toLowerCase() === receipt.account.toLowerCase() && status.server === receipt.server
        && !!receipt.logout && Array.isArray(status.inventory) && Number.isFinite(status.at) && status.at >= receipt.logout.at
        && (!receipt.bank || Array.isArray(status.bank) && Number.isFinite(status.bankAt)
            && status.bankAt >= receipt.bank.at && status.bankAt <= status.at);
}
// A funded assignment becomes a coin order now and the job on a later pass, once the coins are in the account. Until
// then the account is vacant, so the fleet agent can log it in for the trade. Every party to an open order, donor or
// recipient, stays vacant until the order closes: the fleet agent trades only for accounts with no enabled job.
export function fundOrders(out: readonly Assignment[], open: ReadonlySet<string>, order: (from: string, to: string, coins: number) => Order, itemOrderFor?: (send: ItemFunding) => Order) {
    const orders: Order[] = [], log: string[] = [];
    const assignments = out.map(x => {
        if (x.send && itemOrderFor) {
            // A kit item order works as a coin order does: both parties stay vacant until it closes.
            const s = x.send, busy = [s.from, s.to].some(n => open.has(n.toLowerCase()));
            if (!busy) orders.push(itemOrderFor(s));
            log.push(`AUTOPILOT send ${s.to} ${s.count} ${s.item} from ${s.from} for ${s.template}${busy ? ': waits for an open order' : ''}`);
            return { account: x.account, value: 0, resources: [], reason: `vacant: awaits ${s.count} ${s.item} from ${s.from} for ${s.template}` };
        }
        if (!x.fund) return open.has(x.account.toLowerCase()) ? { account: x.account, value: 0, resources: [], reason: 'vacant: in an open fleet order' } : x;
        const f = x.fund, busy = [f.from, f.to].some(n => open.has(n.toLowerCase()));
        if (!busy) orders.push(order(f.from, f.to, f.coins));
        log.push(`AUTOPILOT fund ${f.to} ${f.coins} coins from ${f.from} for ${f.template}${busy ? ': waits for an open order' : ''}`);
        return { account: x.account, value: 0, resources: [], reason: `vacant: awaits ${f.coins} coins from ${f.from} for ${f.template}` };
    });
    return { assignments, orders, log };
}

// Stop files by account name: the owner's pause the account; the controller's own (scripts/swarm.ts SWARM_STOP) only
// mark a job that left the plan, so the planner may give that account a job and remove the file.
export function pauses(stops: ReadonlyMap<string, string>): { paused: Set<string>; swarmStopped: Set<string> } {
    const paused = new Set<string>(), swarmStopped = new Set<string>();
    for (const [n, t] of stops) (swarmWroteStop(t) ? swarmStopped : paused).add(n.toLowerCase());
    return { paused, swarmStopped };
}
// An account is offline, so the controller's stop file may go: no status row, a RESULT in it, or a row older than the
// 30 s a live session refreshes within (scripts/swarm.ts statusAge). A live row without a result is a run still ending.
export const OFFLINE_STATUS_MS = 30_000;
// The accounts a pass hands work: every assignment with a job, and both sides of each coin order.
export function handedAccounts(out: readonly { account: string; template?: unknown }[], orders: readonly { from: string; to: string }[]): Set<string> {
    return new Set([...out.filter(x => x.template).map(x => x.account), ...orders.flatMap(o => [o.from, o.to])].map(a => a.toLowerCase()));
}
export function stopClearable(status: any, now: number): boolean {
    return !status || !!status.result || !(Number.isFinite(status.at) && now - status.at < OFFLINE_STATUS_MS);
}

export function planningOwnership(ownerJobs: readonly any[], coordinatorJobs: readonly any[], paused: ReadonlySet<string>) {
    // A parked coordinator job still shadows its owner job until the coordinator releases it.
    const held = new Set(coordinatorJobs.flatMap(jobAccounts).map(account => account.toLowerCase()));
    const keep = new Set([...paused, ...held]);
    const busy = enabledAccounts(withCoordinatorJobs(ownerJobs, coordinatorJobs));
    for (const account of held) busy.add(account);
    return { held, keep, busy };
}

// Each side's newest claim. The fleet-data worktree holds the last sync, up to PASS_EVERY_MS old, and a pass that reads
// a stale claim can give a place another side already holds. So a pass fetches origin and takes origin's claim for a
// side where it is newer.
export function newestClaims(synced: readonly any[], origin: readonly any[]): any[] {
    const bySide = new Map<string, any>();
    for (const c of [...synced, ...origin]) {
        if (!c || typeof c.side !== 'string' || !Number.isFinite(c.at)) continue;
        if (!(bySide.get(c.side)?.at >= c.at)) bySide.set(c.side, c);
    }
    return [...bySide.values()];
}
// The claims on origin's fleet-data branch, or none when the fetch or a read fails (the synced claims then stand).
function originClaims(fleetDir: string): any[] {
    if (!existsSync(fleetDir)) return [];
    const git = (...args: string[]) => Bun.spawnSync(['git', '-C', fleetDir, ...args], { stdout: 'pipe', stderr: 'ignore', timeout: 30_000, windowsHide: true });
    if (git('fetch', '-q', 'origin', 'fleet-data').exitCode !== 0) return [];
    const files = git('ls-tree', '--full-tree', '--name-only', 'origin/fleet-data', 'fleet/claims/');
    if (files.exitCode !== 0) return [];
    return files.stdout.toString().split(/\r?\n/).filter(f => f.endsWith('.json')).flatMap(f => {
        const shown = git('show', `origin/fleet-data:${f}`);
        try { return shown.exitCode === 0 ? [JSON.parse(shown.stdout.toString())] : []; } catch { return []; }
    });
}

// The side's army roster: the plan's `army` array of account names (README "Claude Code cloud fleet side"). Only these
// accounts take the planner's goal bands (combat training toward the PK army); Haggis never does.
export function armyRoster(plan: any): Set<string> {
    const names = Array.isArray(plan?.army) ? plan.army.filter((n: unknown): n is string => typeof n === 'string') : [];
    return new Set(names.map((n: string) => n.toLowerCase()).filter((n: string) => n !== 'haggis'));
}

// The PK builds of the side's army accounts: the plan's `builds` object, account name -> kit name of
// scripts/pk-kits.ts. Such an account trains to the levels of the kit and no further (the planner's buildBand). A
// name with an unknown kit gets level 1 in every combat skill, so it trains nothing until the plan names a real kit.
export function buildCaps(plan: any, skillsOf: (kit: string) => Record<string, number> = kitSkills): Map<string, Record<string, number>> {
    const none = { Attack: 1, Strength: 1, Defence: 1, Ranged: 1, Magic: 1, Prayer: 1 };
    return new Map(Object.entries(plan?.builds && typeof plan.builds === 'object' && !Array.isArray(plan.builds) ? plan.builds as Record<string, unknown> : {}).map(([name, kit]) => {
        try { return [name.toLowerCase(), skillsOf(String(kit))] as const; } catch { return [name.toLowerCase(), none] as const; }
    }));
}

// Account -> the quests on the route of its build (BUILD_QUESTS). A kit with no route gives none.
export function buildQuests(plan: any): Map<string, readonly string[]> {
    return new Map(Object.entries(plan?.builds && typeof plan.builds === 'object' && !Array.isArray(plan.builds) ? plan.builds as Record<string, unknown> : {})
        .map(([name, kit]) => [name.toLowerCase(), BUILD_QUESTS[String(kit)] ?? []] as const));
}

// Account -> the levels its build may have before the quests of its route. An unknown kit gives no entry.
export function buildBefore(plan: any): Map<string, Record<string, number>> {
    return new Map(Object.entries(plan?.builds && typeof plan.builds === 'object' && !Array.isArray(plan.builds) ? plan.builds as Record<string, unknown> : {})
        .flatMap(([name, kit]) => { try { return [[name.toLowerCase(), levelsBeforeRoute(String(kit))] as const]; } catch { return []; } }));
}

// The practice-proved templates this plan admits: the plan's `aio` array of template ids (the `pilot` templates of the
// planner's catalogue). The owner adds an id to start that route's live pilot and removes it to end the route.
export function aioPilots(plan: any): Set<string> {
    return new Set(Array.isArray(plan?.aio) ? plan.aio.filter((id: unknown): id is string => typeof id === 'string') : []);
}

export function pass(planFile: string, dry: boolean, isPaused = swarmPaused): string[] {
    if (!dry && isPaused()) return [PAUSED];
    const side = mySide(), owners = loadOwners(), swarm = readJson(planFile, null);
    if (!swarm || !Array.isArray(swarm.jobs)) throw Error(`autopilot: ${planFile} has no jobs list`);
    const stateFile = join(prac, 'autopilot', `${side}.json`), state = loadState(side);
    const items: any[] = readJson(join(root, 'knowledge/items.json'), []), byId = new Map(items.map(i => [i.id, i.name]));
    const prices: Record<string, number> = {};
    for (const i of items) if (typeof i.name === 'string' && !/^cert_/.test(i.debugname ?? '') && !(norm(i.name) in prices)) prices[norm(i.name)] = i.cost ?? 0;
    const mineMarked = (j: any) => j?.autopilot === side;

    // Resources other jobs hold: this file's other jobs (paused planner jobs included), and other sides' fresh claims.
    const listedNames = Object.keys(readJson(join(FLEET_DIR(), 'owners.json'), { accounts: {} }).accounts ?? {});
    // An owner's stop file pauses its account. One the controller wrote itself (a job that left the plan, stop-swarm)
    // does not: that account is planned again, and the file goes with the job that replaces it (below).
    const stopText = (n: string): string | undefined => { try { return readFileSync(join(prac, `stop-${n}`), 'utf8'); } catch { return undefined; } };
    const { paused, swarmStopped } = pauses(new Map(listedNames.flatMap(n => { const t = stopText(n); return t === undefined ? [] : [[n, t] as const]; })));
    const { held, keep, busy } = planningOwnership(swarm.jobs, readCoordinatorJobs(root).jobs, paused);
    for (const j of swarm.jobs.filter(mineMarked)) if (typeof j.account === 'string'
        && kitBuyRunning(j, state.assigned[j.account], offset => readJobResultLines(join(prac, 'swarm-logs', `${j.account}.log`), offset, j))) keep.add(j.account.toLowerCase());

    // Retire planner jobs whose own log lines show no progress.
    const log: string[] = [];
    const scripts = new Map(catalogue().map(t => [t.id, t.worker ?? t.script])), hashes = new Map<string, string>();
    const scriptOf = (template: string) => {
        const file = template.startsWith(KIT_BUY) ? KIT_BUY_SCRIPT : scripts.get(template);
        if (file && !hashes.has(file)) try { hashes.set(file, createHash('sha1').update(readFileSync(join(root, file))).digest('hex')); } catch { /* missing: no hash */ }
        return file ? hashes.get(file) : undefined;
    };
    const live = liveRetirements(state.retired, scriptOf);
    state.retired = live.retired;
    for (const key of live.lapsed) log.push(`AUTOPILOT unretire ${key}: its script changed, or its fails were drains`);
    for (const j of swarm.jobs.filter(mineMarked)) {
        if (jobAccounts(j).some(account => held.has(account.toLowerCase()))) {
            log.push(`AUTOPILOT hold ${jobAccounts(j).join(',')}: coordinator owns the assignment`);
            continue;
        }
        const a = state.assigned[j.account];
        if (!a || a.template !== j.template) continue;
        const jobLines = readJobResultLines(join(prac, 'swarm-logs', `${j.account}.log`), a.offset, j), r = assess(jobLines);
        const none = String(j.template).startsWith(KIT_BUY) ? unfilledItems(jobLines) : [];
        if (none.length) {
            for (const id of none) (state.unsold ??= {})[id] = Date.now();
            log.push(`AUTOPILOT unsold ${j.account} ${j.template}: no seller under the cap for ${none.map(id => byId.get(id) ?? id).join(', ')}`);
            continue;
        }
        if (r.retire) { const script = scriptOf(j.template); state.retired[pairKey(j.account, j.template)] = script === undefined ? r.reason : { reason: r.reason, script }; log.push(`AUTOPILOT retire ${j.account} ${j.template}: ${r.reason}`); }
    }

    const taken = reservedResources(swarm.jobs, side, keep);
    const claimDir = join(FLEET_DIR(), 'claims');
    const synced = existsSync(claimDir) ? readdirSync(claimDir).filter(f => f.endsWith('.json')).map(f => readJson(join(claimDir, f), null)) : [];
    for (const c of newestClaims(synced, originClaims(FLEET_DIR()))) {
        if (c.side === side || !Array.isArray(c.resources) || !(Date.now() - c.at < CLAIM_MAX_AGE_MS)) continue;
        for (const r of c.resources) if (typeof r === 'string') taken[r] = (taken[r] ?? 0) + 1;
    }

    const listed = listedNames;
    // An account's freshest observation: its status file, or its row in this side's published fleet snapshot (a fresh
    // cloud container has no status files, and a Thieving 99 account must not plan as a level-1 start).
    const statusDir = join(prac, 'status'), statusFiles = existsSync(statusDir) ? readdirSync(statusDir) : [];
    const published: any[] = readJson(join(FLEET_DIR(), 'snapshots', `${side}.json`), { accounts: [] }).accounts ?? [];
    const observed = (n: string) => {
        const f = statusFiles.find(f => f.toLowerCase() === `${n.toLowerCase()}.json`);
        return freshest(f ? readJson(join(statusDir, f), null) : null, published.find(r => String(r?.name).toLowerCase() === n.toLowerCase()));
    };
    const accounts = plannableAccounts(swarm.jobs, side, listed.filter(n => owners.get(n.toLowerCase())?.side === side), keep).map(n => accountFrom(n, side, observed(n), id => byId.get(id)));
    // Coin donors: this side's accounts with no enabled swarm or coordinator job, no stop file and no open order, as
    // their last status reports them. The fleet agent runs a trade only for such accounts.
    const fleetDir = FLEET_DIR(), now = Date.now();
    const orders: Order[] = existsSync(join(fleetDir, 'orders')) ? readdirSync(join(fleetDir, 'orders')).filter(f => f.endsWith('.json')).map(f => readJson(join(fleetDir, 'orders', f), null)).filter(validOrder) : [];
    const receipts: Receipt[] = existsSync(join(fleetDir, 'receipts')) ? readdirSync(join(fleetDir, 'receipts')).filter(f => f.endsWith('.json')).map(f => readJson(join(fleetDir, 'receipts', f), null)).filter(Boolean) : [];
    // The shared intent precedes the local journal. A crashed host may never publish that journal.
    // Keep the claimed account and both known participants held even after the order window.
    const claimedAccounts = [...new Set([...listed, ...orders.flatMap(o => [o.from, o.to])])];
    const heldClaims = claimedAccounts.length ? readHeldFleetTradeClaims(root, claimedAccounts) : [];
    const heldNonces = new Set(heldClaims.map(c => c.nonce));
    const open = inOpenOrder(orders, receipts, now, r =>
        owners.get(r.account.toLowerCase())?.side !== side || tradeStockReady(r, observed(r.account)), nonce => heldNonces.has(nonce));
    for (const claim of heldClaims) {
        open.add(claim.account);
        const order = orders.find(o => o.id === claim.orderId);
        if (order) for (const name of [order.from, order.to]) open.add(name.toLowerCase());
    }
    const donors = listed.filter(n => owners.get(n.toLowerCase())?.side === side && n.toLowerCase() !== 'haggis' && ![busy, keep, open].some(s => s.has(n.toLowerCase())))
        .map(n => ({ name: n, coins: accountFrom(n, side, observed(n), id => byId.get(id)).items.coin ?? 0 })).filter(d => d.coins > 0);
    // Kit donors: this side's free accounts (the coin donors' rule), then each other side's, on the same server.
    const free = (n: string) => owners.get(n.toLowerCase())?.side === side && n.toLowerCase() !== 'haggis' && ![busy, keep, open].some(s => s.has(n.toLowerCase()));
    const stock: Stock[] = listed.filter(free).map(n => { const a = accountFrom(n, side, observed(n), id => byId.get(id)); return { name: a.name, side, items: a.items }; });
    const snapshotDir = join(fleetDir, 'snapshots'), silent = silentSides(orders, receipts, n => owners.get(n.toLowerCase())?.side, now);
    for (const f of existsSync(snapshotDir) ? readdirSync(snapshotDir).filter(f => f.endsWith('.json')) : []) {
        const other = f.slice(0, -'.json'.length);
        if (other !== side && !silent.has(other)) stock.push(...sideStock(other, readJson(join(snapshotDir, f), null), readJson(join(fleetDir, 'plans', f), null), open, now, SIDE_STOCK_MAX_AGE_MS, id => byId.get(id))
            .filter(s => owners.get(s.name.toLowerCase())?.side === other));
    }
    const market: Record<string, { id: number; name: string; limit: number }> = {};
    for (const i of items) if (typeof i.name === 'string' && Number.isSafeInteger(i.id) && !/^cert_/.test(i.debugname ?? '') && norm(i.name) in KIT_PRICE_CAPS && !(norm(i.name) in market)
        && !(now - (state.unsold?.[i.id] ?? -Infinity) < UNSOLD_RETRY_MS))
        market[norm(i.name)] = { id: i.id, name: i.name, limit: KIT_PRICE_CAPS[norm(i.name)]! };
    // This side's banked coins, over every account it owns: above the glut level a coin job ranks last.
    const sideCoins = listed.filter(n => owners.get(n.toLowerCase())?.side === side).reduce((n, name) => n + (accountFrom(name, side, observed(name), id => byId.get(id)).items.coin ?? 0), 0);
    const coinValue = coinValueFor(sideCoins);
    if (coinValue !== 1) log.push(`AUTOPILOT coins: this side holds ${sideCoins}, so a coin counts as ${coinValue}`);
    const planned = plan({ side, accounts, owners, coinValue, bill: routeBill(items), templates: catalogue(), prices, waste: wasteShare(tickWaste(join(prac, 'swarm-logs'))), taken, retired: new Set(Object.keys(state.retired)), capacity: CAPACITY, shared: SHARED, unfundable: busy, donors, current: new Map(Object.entries(state.assigned).map(([a, s]) => [a.toLowerCase(), s.template])), army: armyRoster(swarm), builds: buildCaps(swarm), buildQuests: buildQuests(swarm), buildBefore: buildBefore(swarm), pilots: aioPilots(swarm), stock, market: market as Market,
        kitSeq: new Map(Object.entries(state.kitSeq ?? {}).map(([a, n]) => [a.toLowerCase(), n])), noSend: failedSends(orders, receipts, now) });
    const serverOf = (to: string) => owners.get(to.toLowerCase())?.server ?? 'rs-sdk-demo.fly.dev';
    const funding = fundOrders(planned, open, (from, to, coins) => coinOrder(from, to, coins, serverOf(to), now),
        s => itemOrder(s.from, s.to, market[s.item]?.name ?? items.find(i => typeof i.name === 'string' && norm(i.name) === s.item && !/^cert_/.test(i.debugname ?? ''))?.name ?? s.item, s.count, serverOf(s.to), now));
    const out = funding.assignments;
    log.push(...funding.log);

    const { jobs, fresh } = mergeJobs(swarm.jobs, side, out, keep);
    for (const x of out) {
        // An account that leaves a kit buy (for its band, another job or none) starts a new order key next time.
        const was = state.assigned[x.account]?.template;
        if (was?.startsWith(KIT_BUY) && was !== x.template?.id) (state.kitSeq ??= {})[x.account.toLowerCase()] = (state.kitSeq?.[x.account.toLowerCase()] ?? 0) + 1;
        if (!x.template) { log.push(`AUTOPILOT vacant ${x.account}: ${x.reason}`); delete state.assigned[x.account]; continue; }
        if (fresh.includes(x.account) || state.assigned[x.account]?.template !== x.template.id) {
            const lf = join(prac, 'swarm-logs', `${x.account}.log`);
            state.assigned[x.account] = { template: x.template.id, offset: existsSync(lf) ? statSync(lf).size : 0, at: Date.now() };
        }
        log.push(`AUTOPILOT ${fresh.includes(x.account) ? 'assign' : 'keep'} ${x.account} ${x.template.id} ${x.value.toFixed(2)}/tick ${x.reason}`);
    }
    if (dry) return [...log, 'AUTOPILOT dry run: nothing written'];
    if (isPaused()) return [PAUSED];
    writeAtomic(planFile, JSON.stringify({ ...swarm, jobs }, null, 2) + '\n');
    if (heldResources(swarm.jobs) !== heldResources(jobs)) log.push(CLAIM_CHANGED);
    // The controller's own stop file goes once this pass hands the account work (a job, new or kept, or a coin order
    // the fleet agent will log it in for) and the account is offline: a run still ending on that file must find it. A
    // kept job counts: the pass that assigns a job may find the last run still ending, and every later pass keeps it
    // (live: an account stood 40 minutes behind such a file, its job enabled and never started).
    const handed = handedAccounts(out, funding.orders);
    for (const n of listedNames) if (handed.has(n.toLowerCase()) && swarmStopped.has(n.toLowerCase())) {
        const f = statusFiles.find(f => f.toLowerCase() === `${n.toLowerCase()}.json`);
        if (!stopClearable(f ? readJson(join(statusDir, f), null) : null, now)) { log.push(`AUTOPILOT hold ${n}: its last run is still ending on the controller's stop file`); continue; }
        if (!clearSwarmStop(join(prac, 'stop-'+n))) continue;
        log.push(`AUTOPILOT clear ${n}: the controller's stop file from its removed job`);
    }
    mkdirSync(join(prac, 'autopilot'), { recursive: true });
    writeAtomic(stateFile, JSON.stringify(state, null, 1) + '\n');
    if (funding.orders.length) mkdirSync(join(fleetDir, 'orders'), { recursive: true });
    for (const o of funding.orders) writeAtomic(join(fleetDir, 'orders', `${o.id}.json`), JSON.stringify(o, null, 1) + '\n');
    return log;
}

// The assignments (account, template and log offset) whose trainer reached its target. A pass that re-plans the account
// changes its assignment, so each finish is one key; the daemon passes once per key.
export function trainersDone(planFile: string): string[] {
    const side = mySide(), swarm = readJson(planFile, null), state = loadState(side);
    if (!swarm || !Array.isArray(swarm.jobs)) return [];
    let effectiveJobs: any[];
    try { effectiveJobs = withCoordinatorJobs(swarm.jobs, readCoordinatorJobs(root).jobs); }
    catch { return []; } // An unreadable overlay cannot establish which trainer owns the account.
    const since = (a: string, offset: number, job: any) => readJobResultLines(join(prac, 'swarm-logs', `${a}.log`), offset, job);
    // A kit buy with a RESULT, ok or fail, also wants its next pass now: the band waits for the kit, and a failed buy
    // must not be restarted by the controller until the 10-minute timer.
    const buys = effectiveJobs.filter(j => j?.autopilot === side && typeof j.account === 'string' && typeof j.template === 'string' && j.template.startsWith(KIT_BUY)
        && j.enabled && state.assigned[j.account]?.template === j.template && !kitBuyRunning(j, state.assigned[j.account], offset => since(j.account, offset, j))).map(j => j.account as string);
    return [...finishedTrainers(effectiveJobs, side, state.assigned, catalogue(), since), ...buys]
        .map(a => `${a}:${state.assigned[a]!.template}:${state.assigned[a]!.offset}`);
}

if (import.meta.main) {
    const args = process.argv.slice(2), planFile = resolve(args.find(a => !a.startsWith('--')) ?? join(root, 'swarm.json'));
    // The whole pass runs under the account-plan lock: the coordinator installs jobs into its overlay under the same lock.
    // The timer and the trainer check share one pass at a time: a second call joins the pass in flight.
    const dry = args.includes('--dry');
    let inFlight: Promise<'applied' | 'held' | 'failed'> | null = null;
    const hold = () => {
        console.log(PAUSED);
        console.log('RESULT ok autopilot held: swarm is paused');
        return 'held' as const;
    };
    const once = () => {
        if (!dry && swarmPaused()) return Promise.resolve(hold());
        return inFlight ??= (async () => {
            try {
                const lines = await withPlanWrite(() => pass(planFile, dry), join(prac, 'coordinator'));
                if (lines[0] === PAUSED) return hold();
                console.log(lines.join('\n'));
                // Outside the plan lock: fleet-sync takes the fleet-data write lock, so it queues behind the agent's sync.
                // A sync that fails to start leaves the claim to the agent's next sync.
                if (lines.includes(CLAIM_CHANGED)) try {
                    Bun.spawn([process.execPath, 'scripts/fleet-sync.ts'], { cwd: root, env: process.env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', windowsHide: true }).unref();
                } catch { /* the fleet agent's next sync publishes it */ }
                console.log(`RESULT ok autopilot jobs=${lines.filter(x => / (assign|keep) /.test(x)).length} retired=${lines.filter(x => / retire /.test(x)).length}`);
                return 'applied';
            } catch (e) {
                console.log(`RESULT fail autopilot ${String(e)}`);
                return 'failed';
            } finally { inFlight = null; }
        })();
    };
    if (!args.includes('--daemon')) process.exit(await once() === 'failed' ? 1 : 0);
    // One planning daemon for each machine. Its lease (packages/core/src/controllers.ts) is written again on each
    // trainer poll, and the watchdog starts a daemon when no live process holds it. A dry daemon writes no plan and
    // takes no lease.
    const lease = join(prac, 'autopilot.lock');
    if (!dry) {
        if (!takeLease(lease)) { console.log(`AUTOPILOT already running pid ${leaseHolder(lease)}`); process.exit(0); }
        // The record of a daemon start: its plan file and its fleet side. The watchdog starts a daemon again only
        // from it. A one-shot pass writes none.
        saveLaunch(join(root, controllerNamed('autopilot').launch), [planFile]);
        process.on('exit', () => releaseLease(lease)); process.on('SIGINT', () => process.exit(0)); process.on('SIGTERM', () => process.exit(0));
    }
    const startedAt = Date.now();
    // A daemon whose lease names a different daemon starts no pass. It ends, after a pass that is in flight.
    const lostLease = () => {
        if (dry || renewLease(lease)) return false;
        if (!inFlight) { console.log('AUTOPILOT lost its lease to another daemon'); process.exit(0); }
        return true;
    };
    await once(); setInterval(() => { if (!lostLease()) void once(); }, PASS_EVERY_MS);
    const seen = new Set<string>();
    setInterval(() => {
        if (lostLease()) return;
        // A live update that changed this daemon's code (packages/router/src/live-update.ts): a copy on the current code takes over.
        if (!inFlight && reloadDue(root, 'autopilot', startedAt)) {
            if (!dry) releaseLease(lease);
            const pid = respawnDaemon(root, [join(root, 'scripts', 'autopilot.ts'), ...args], join(prac, 'autopilot', `daemon-${Date.now()}.out.log`));
            console.log(`AUTOPILOT reload after a live update: successor pid ${pid}`);
            process.exit(0);
        }
        if ((!dry && swarmPaused()) || inFlight) return;
        const due = trainersDone(planFile).filter(k => !seen.has(k));
        if (!due.length) return;
        console.log(`AUTOPILOT trainer at target, passing now: ${due.map(k => k.split(':')[0]).join(' ')}`);
        void once().then(outcome => {
            if (outcome === 'applied') for (const k of due) seen.add(k);
        });
    }, TRAINER_POLL_MS);
}
