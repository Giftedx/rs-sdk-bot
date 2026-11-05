// Autopilot CLI: writes this fleet side's swarm jobs (packages/planner/src/autopilot.ts) into swarm.json. It replaces
// only jobs marked "autopilot": <this side>, keeps every other job, and never plans an account that an unmarked job
// names or another side owns. Each pass retires a planner job whose log since assignment shows repeated fail RESULTs,
// a death or near-total tick waste, and picks that account's next best template. Other sides' fresh claims
// (fleet/claims/<side>.json, written by scripts/fleet-sync.ts from each side's plan) count as taken, so sides never
// share a spot.
// A job that only lacks coins gets them from a free account of this side: the pass writes a fleet order
// (fleet/orders), scripts/fleet-agent.ts runs the trade, and a later pass gives the job.
// Usage: bun scripts/autopilot.ts [swarm.json] [--dry] [--daemon]
// --daemon: a pass every 10 minutes, and one within TRAINER_POLL_MS of a planner trainer's ok RESULT (its target level
// is met and its job does not repeat, so the account would otherwise sit ended until the timer).
// Run beside DEMO_OK=1 bun scripts/swarm.ts and bun scripts/fleet-agent.ts --daemon, with FLEET_SIDE set.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FLEET_DIR, loadOwners, mySide } from '../packages/core/src/fleet';
import { swarmWroteStop } from './swarm';
import { withPlanWrite } from '../packages/core/src/plan-lock';
import { matchingJobLines } from '../packages/core/src/job-log';
import { CLAIM_MAX_AGE_MS, accountFrom, assess, catalogue, finishedTrainers, freshest, mergeJobs, norm, pairKey, plan, plannableAccounts, reservedResources, type Assignment } from '../packages/planner/src/autopilot';
import { jobAccounts, mergeJobs as withCoordinatorJobs, readCoordinatorJobs } from '../packages/core/src/coordinator-jobs';
import type { Order, Receipt } from './fleet-trade';
import { liveHelperStatuses, supplyBill, type BillRow } from '../packages/planner/src/supply-bill';
import { haggisActivities, haggisTravel, loadSnapshot, overallRequirementsFor, scheduleOverall, TRICKS } from '../packages/planner/src/haggis';
import { tickWaste, wasteShare } from './tick-waste';

const root = resolve(import.meta.dir, '..'), prac = join(root, '.practice');
const PASS_EVERY_MS = 10 * 60_000, TRAINER_POLL_MS = 30_000;
type State = { assigned: Record<string, { template: string; offset: number; at: number }>; retired: Record<string, string> };

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
        const activities = haggisActivities(), boards = loadSnapshot(join(root, 'research/hiscores-live.json'));
        const options = { mode: 'realistic' as const, tricks: new Set(TRICKS), travel: haggisTravel() };
        const { supplies } = overallRequirementsFor(activities, options, scheduleOverall(boards, activities, options));
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
// Accounts with an enabled job, as scripts/fleet-agent.ts swarmBusy counts them: the agent trades for no other account.
const enabledAccounts = (jobs: readonly any[]) => new Set(jobs.filter(j => j?.enabled).flatMap(j => [j.account, ...(j.accounts ?? [])]).filter((n): n is string => typeof n === 'string').map(n => n.toLowerCase()));
// Accounts in a fleet order that is still open: its window has not ended and a party has no receipt yet.
export function inOpenOrder(orders: readonly Order[], receipts: readonly Receipt[], now: number): Set<string> {
    const open = orders.filter(o => o.end > now && !(['from', 'to'] as const).every(role => receipts.some(r => r.id === o.id && r.role === role)));
    return new Set(open.flatMap(o => [o.from, o.to]).map(n => n.toLowerCase()));
}
// A funded assignment becomes a coin order now and the job on a later pass, once the coins are in the account. Until
// then the account is vacant, so the fleet agent can log it in for the trade. Every party to an open order, donor or
// recipient, stays vacant until the order closes: the fleet agent trades only for accounts with no enabled job.
export function fundOrders(out: readonly Assignment[], open: ReadonlySet<string>, order: (from: string, to: string, coins: number) => Order) {
    const orders: Order[] = [], log: string[] = [];
    const assignments = out.map(x => {
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

export function pass(planFile: string, dry: boolean): string[] {
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

    // Retire planner jobs whose own log lines show no progress.
    const log: string[] = [];
    for (const j of swarm.jobs.filter(mineMarked)) {
        if (jobAccounts(j).some(account => held.has(account.toLowerCase()))) {
            log.push(`AUTOPILOT hold ${jobAccounts(j).join(',')}: coordinator owns the assignment`);
            continue;
        }
        const a = state.assigned[j.account];
        if (!a || a.template !== j.template) continue;
        const r = assess(readJobResultLines(join(prac, 'swarm-logs', `${j.account}.log`), a.offset, j));
        if (r.retire) { state.retired[pairKey(j.account, j.template)] = r.reason; log.push(`AUTOPILOT retire ${j.account} ${j.template}: ${r.reason}`); }
    }

    const taken = reservedResources(swarm.jobs, side, keep);
    const claimDir = join(FLEET_DIR(), 'claims');
    if (existsSync(claimDir)) for (const f of readdirSync(claimDir).filter(f => f.endsWith('.json'))) {
        const c = readJson(join(claimDir, f), null);
        if (!c || c.side === side || !Array.isArray(c.resources) || !(Date.now() - c.at < CLAIM_MAX_AGE_MS)) continue;
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
    const orders: Order[] = existsSync(join(fleetDir, 'orders')) ? readdirSync(join(fleetDir, 'orders')).filter(f => f.endsWith('.json')).map(f => readJson(join(fleetDir, 'orders', f), null)).filter(o => typeof o?.id === 'string' && Number.isSafeInteger(o?.end)) : [];
    const receipts: Receipt[] = existsSync(join(fleetDir, 'receipts')) ? readdirSync(join(fleetDir, 'receipts')).filter(f => f.endsWith('.json')).map(f => readJson(join(fleetDir, 'receipts', f), null)).filter(Boolean) : [];
    const open = inOpenOrder(orders, receipts, now);
    const donors = listed.filter(n => owners.get(n.toLowerCase())?.side === side && n.toLowerCase() !== 'haggis' && ![busy, keep, open].some(s => s.has(n.toLowerCase())))
        .map(n => ({ name: n, coins: accountFrom(n, side, observed(n), id => byId.get(id)).items.coin ?? 0 })).filter(d => d.coins > 0);
    const planned = plan({ side, accounts, owners, bill: routeBill(items), templates: catalogue(), prices, waste: wasteShare(tickWaste(join(prac, 'swarm-logs'))), taken, retired: new Set(Object.keys(state.retired)), capacity: { 'catherby:lobster': 3 }, unfundable: busy, donors, current: new Map(Object.entries(state.assigned).map(([a, s]) => [a.toLowerCase(), s.template])) });
    const funding = fundOrders(planned, open, (from, to, coins) => coinOrder(from, to, coins, owners.get(to.toLowerCase())?.server ?? 'rs-sdk-demo.fly.dev', now));
    const out = funding.assignments;
    log.push(...funding.log);

    const { jobs, fresh } = mergeJobs(swarm.jobs, side, out, keep);
    for (const x of out) {
        if (!x.template) { log.push(`AUTOPILOT vacant ${x.account}: ${x.reason}`); delete state.assigned[x.account]; continue; }
        if (fresh.includes(x.account) || state.assigned[x.account]?.template !== x.template.id) {
            const lf = join(prac, 'swarm-logs', `${x.account}.log`);
            state.assigned[x.account] = { template: x.template.id, offset: existsSync(lf) ? statSync(lf).size : 0, at: Date.now() };
        }
        log.push(`AUTOPILOT ${fresh.includes(x.account) ? 'assign' : 'keep'} ${x.account} ${x.template.id} ${x.value.toFixed(2)}/tick ${x.reason}`);
    }
    if (dry) return [...log, 'AUTOPILOT dry run: nothing written'];
    writeAtomic(planFile, JSON.stringify({ ...swarm, jobs }, null, 2) + '\n');
    // The controller's own stop file goes once this pass hands the account work (a job, or a coin order the fleet agent
    // will log it in for) and the account is offline: a run still ending on that file must find it.
    const handed = new Set([...fresh, ...funding.orders.flatMap(o => [o.from, o.to])].map(a => a.toLowerCase()));
    for (const n of listedNames) if (handed.has(n.toLowerCase()) && swarmStopped.has(n.toLowerCase())) {
        const f = statusFiles.find(f => f.toLowerCase() === `${n.toLowerCase()}.json`);
        if (!stopClearable(f ? readJson(join(statusDir, f), null) : null, now)) { log.push(`AUTOPILOT hold ${n}: its last run is still ending on the controller's stop file`); continue; }
        rmSync(join(prac, `stop-${n}`), { force: true });
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
    return finishedTrainers(effectiveJobs, side, state.assigned, catalogue(), (a, offset, job) => readJobResultLines(join(prac, 'swarm-logs', `${a}.log`), offset, job))
        .map(a => `${a}:${state.assigned[a]!.template}:${state.assigned[a]!.offset}`);
}

if (import.meta.main) {
    const args = process.argv.slice(2), planFile = resolve(args.find(a => !a.startsWith('--')) ?? join(root, 'swarm.json'));
    // The whole pass runs under the account-plan lock: the coordinator installs jobs into its overlay under the same lock.
    // The timer and the trainer check share one pass at a time: a second call joins the pass in flight.
    let inFlight: Promise<boolean> | null = null;
    const once = () => inFlight ??= (async () => { try { const l = await withPlanWrite(() => pass(planFile, args.includes('--dry')), join(prac, 'coordinator')); console.log(l.join('\n')); console.log(`RESULT ok autopilot jobs=${l.filter(x => / (assign|keep) /.test(x)).length} retired=${l.filter(x => / retire /.test(x)).length}`); return true; }
        catch (e) { console.log(`RESULT fail autopilot ${String(e)}`); return false; } finally { inFlight = null; } })();
    if (!args.includes('--daemon')) process.exit(await once() ? 0 : 1);
    await once(); setInterval(once, PASS_EVERY_MS);
    const seen = new Set<string>();
    setInterval(() => {
        const due = trainersDone(planFile).filter(k => !seen.has(k));
        if (!due.length) return;
        for (const k of due) seen.add(k);
        console.log(`AUTOPILOT trainer at target, passing now: ${due.map(k => k.split(':')[0]).join(' ')}`);
        void once();
    }, TRAINER_POLL_MS);
}
