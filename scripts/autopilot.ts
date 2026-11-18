// Autopilot CLI: writes this fleet side's swarm jobs (packages/planner/src/autopilot.ts) into swarm.json. It replaces
// only jobs marked "autopilot": <this side>, keeps every other job, and never plans an account that an unmarked job
// names or another side owns. Each pass retires a planner job whose log since assignment shows repeated fail RESULTs,
// a death or near-total tick waste, and picks that account's next best template. Other sides' fresh claims
// (fleet/claims/<side>.json, written by scripts/fleet-sync.ts from each side's plan) count as taken, so the sides
// together never put more accounts on a spot than its capacity (CAPACITY in the planner).
// A job that only lacks coins gets them from a free account of this side: the pass writes a fleet order
// (fleet/orders), scripts/fleet-agent.ts runs the trade, and a later pass gives the job.
// An account gets only a job whose place it has a way to from the tile where it stands offline (the planner's reach
// rule). The ferry fare of that way is a part of the job's coin need, and a coin order for an account in Kandarin
// meets at the Ardougne north bank.
// Missing supplies for useful combat, production and quest jobs use spare owned stock from a free local account
// before purchases. Cross-side transfers retain their sync lead and do not preempt useful local work.
// An AIO route proved on practice only (a `pilot` template) is planned only while the plan's `aio` array names its id.
// Usage: bun scripts/autopilot.ts [swarm.json] [--dry] [--daemon]
// --daemon: a pass every 10 minutes, and one within TRAINER_POLL_MS of a planner trainer's ok RESULT (its target level
// is met and its job does not repeat, so the account would otherwise sit ended until the timer).
// Run beside DEMO_OK=1 bun scripts/swarm.ts and bun scripts/fleet-agent.ts --daemon, with FLEET_SIDE set.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { FLEET_DIR, loadOwners, mySide } from '../packages/core/src/fleet';
import { fleetStatusRows, readSnapshotFiles, type SnapshotFile } from '../packages/core/src/fleet-snapshots';
import { publishedSideHold } from '../packages/core/src/fleet-side-card';
import { clearSwarmStop, swarmWroteStop } from './swarm';
import { withPlanWrite } from '../packages/core/src/plan-lock';
import { reloadDue, respawnDaemon } from '../packages/core/src/live-reload';
import { controllerNamed, leaseHolder, releaseLease, renewLease, saveLaunch, takeLease } from '../packages/core/src/controllers';
import { matchingJobLines } from '../packages/core/src/job-log';
import { ARMOUR_IDS, BOW_IDS, CAPACITY, CLAIM_MAX_AGE_MS, DRAIN_RESULT, SHARED, accountFrom, assess, catalogue, finishedTrainers, jobResources, kitReserve, mergeJobs, norm, pairKey, plan, plannableAccounts, reservedResources, BUILD_QUESTS, KIT_BUY, KIT_BUY_SCRIPT, KIT_PRICE_CAPS, priceTable, type Acct, type Assignment, type Funding, type ItemFunding, type Market, type Stock, type Template } from '../packages/planner/src/autopilot';
import { deadlyTo, loadHunters, type Hunter } from '../packages/core/src/danger';
import { jobAccounts, mergeJobs as withCoordinatorJobs, readCoordinatorJobs } from '../packages/core/src/coordinator-jobs';
import { tradeSettlement, validOrder, windowClosures, type Order, type Receipt, type TradeReceipt } from './fleet-trade-settlement';
import { readHeldFleetTradeClaims } from '../packages/core/src/fleet-trade-claim';
import { readLogoutProof } from '../packages/core/src/session-lifecycle';
import { liveHelperStatuses, overallSupplyDemand, supplyBill, type BillRow } from '../packages/planner/src/supply-bill';
import { gearById } from '../packages/planner/src/gear-progression';
import { MARKET_FILE, marketQuotes } from './market-cache';
import { tickWaste, wasteShare } from './tick-waste';
import { kitSkills, levelsBeforeRoute } from './pk-kits';
import { createAutopilotProgression } from './autopilot-progression';
import { accountFromStatus } from '../packages/planner/src/progression-catalog';
import {boundAccounts,type AccountBindingState} from '../packages/core/src/coordinator-accounts';
import { COORDINATOR_JOBS_FILE } from '../packages/core/src/coordinator-jobs';

const root = resolve(import.meta.dir, '..'), prac = join(root, '.practice');
const PASS_EVERY_MS = 10 * 60_000, TRAINER_POLL_MS = 30_000;
const PAUSED = 'AUTOPILOT hold: swarm is paused';
export const OFFLINE_GUARDED = new Set(['haggis', 'shaftshooter', 'polevaulter']);
// A pass that changes the resources this plan's enabled jobs hold publishes the side's claim at once. Other sides plan
// against origin's claims (newestClaims), and a claim that waits for the fleet agent's next sync (up to 10 minutes)
// lets two sides give the same knight place in that window.
export const CLAIM_CHANGED = 'AUTOPILOT claim changed: publishing it now';
export const heldResources = (jobs: readonly any[]) => jobs.filter(j => j?.enabled !== false).flatMap(j => jobResources(j)).sort().join('|');
const swarmPaused = () => existsSync(join(prac, 'stop-swarm'));
// A retirement records the hash of its template's script; an entry from before that is a bare reason.
type Retirement = string | { reason: string; script: string };
// `kitSeq`: each account's supply episode, used by GE order keys and settled held-bone batch missions.
type State = { assigned: Record<string, { template: string; offset: number; at: number }>; retired: Record<string, Retirement>; kitSeq?: Record<string, number>;
    // `unsold`: when a kit buy last got none of an item, by item id. The market leaves the item out for UNSOLD_RETRY_MS.
    unsold?: Record<string, number>;
    // `kitEnds`: the end record (its `at`) that last raised an account's kitSeq, so one end record raises it once, even
    // while the account stays paused and its job is not planned again.
    kitEnds?: Record<string, number> };
// An orphaned kit buy starts a new order key (kitSeq) once for each end record.
export function raiseKitSeq(state: Pick<State, 'kitSeq' | 'kitEnds'>, account: string, endedAt: number | undefined): boolean {
    const key = account.toLowerCase(), at = endedAt ?? 0;
    if (at > 0 && (state.kitEnds?.[key] ?? 0) >= at) return false;
    (state.kitEnds ??= {})[key] = at;
    (state.kitSeq ??= {})[key] = (state.kitSeq[key] ?? 0) + 1;
    return true;
}
// A retirement holds while its template's script is unchanged, so a fix to the script gives the pair its retries back.
// A death holds until a person clears it, and so does a pair whose template is gone. A bare reason takes the current
// script, so nothing comes back on the pass that first reads it. One whose last RESULT is now a drain (DRAIN_RESULT)
// lapses: it was not the job's failure.
export function liveRetirements(retired: Readonly<Record<string, Retirement>>, scriptOf: (template: string) => string | undefined): { retired: Record<string, Retirement>; lapsed: string[] } {
    const out: Record<string, Retirement> = {}, lapsed: string[] = [];
    for (const [key, r] of Object.entries(retired)) {
        const reason = typeof r === 'string' ? r : r.reason, script = scriptOf(key.slice(key.indexOf(':') + 1));
        const result = reason.indexOf('RESULT ');
        // A preparation/acquire retirement embeds the very RESULTs that DRAIN_RESULT admits one at a time: it stays.
        if (!/^death\b/.test(reason) && !/^\d+ preparation\/acquire RESULTs\b/.test(reason) && result >= 0 && DRAIN_RESULT.test(reason.slice(result))) lapsed.push(key);
        else if (/^death\b/.test(reason) || script === undefined) out[key] = r;
        else if (typeof r === 'string') out[key] = { reason, script };
        else if (r.script === script) out[key] = r;
        else lapsed.push(key);
    }
    return { retired: out, lapsed };
}

const readJson = (f: string, fallback: any) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; } };
// A filename binds its local observation to the requested account. Shared observations use the same live server
// and ownership rule as supply planning, so a newer practice status cannot hide an account's published skills or stock.
export function observedAccount(name: string, local: any, files: readonly SnapshotFile[], owners: ReturnType<typeof loadOwners>, side: string): any {
    const key = name.toLowerCase(), owner = owners.get(key);
    if (!owner) return null;
    const bound = typeof local?.name === 'string' && local.name.toLowerCase() === key ? [local] : [];
    return fleetStatusRows(bound, files, n => owners.get(n.toLowerCase())?.side, side, owner.server)
        .find(row => row.name.toLowerCase() === key) ?? null;
}
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
// `meet`: the tile pair of the meeting place (absent: Varrock West, the default of scripts/fleet-trade.ts).
export function coinOrder(from: string, to: string, coins: number, server: string, now: number, meet?: Order['meet'], leadMs=15*60_000): Order {
    if(!Number.isSafeInteger(leadMs)||leadMs<0||leadMs>15*60_000)throw Error('invalid coin order lead');
    const start = now + leadMs;
    return { id: `${start}-${from}-${to}`.toLowerCase(), server, from, to, item: 'coins', count: coins, start, end: start + 40 * 60_000, ...(meet ? { meet } : {}) };
}
// The tile pair at the Ardougne north bank, the army's home bank: scripts/coin-courier.ts meetingTiles for the bank
// tile 2619,3332 (scripts/autopilot.test.ts checks the two agree). A kit item order meets there.
export const ARMY_MEET: NonNullable<Order['meet']> = [{ x: 2618, z: 3333, level: 0 }, { x: 2617, z: 3333, level: 0 }];
// A kit item order: the same window as a coin order, at the army's home bank. The id carries the item, so two orders
// for one pair in one pass differ.
export function itemOrder(from: string, to: string, item: string, count: number, server: string, now: number, leadMs=15 * 60_000): Order {
    if(!Number.isSafeInteger(leadMs)||leadMs<0||leadMs>15*60_000)throw Error('invalid item order lead');
    const start = now + leadMs;
    return { id: `${start}-${from}-${to}-${item.replace(/[^A-Za-z0-9]+/g, '')}`.toLowerCase().slice(0, 64), server, from, to, item, count, start, end: start + 40 * 60_000, meet: ARMY_MEET };
}
// A side's free accounts as kit donors, from its published snapshot and plan (fleet/snapshots, fleet/plans): the side
// published a plan within `maxAgeMs` (SIDE_STOCK_MAX_AGE_MS: its fleet agent syncs every 10 minutes, so it runs and
// will trade), and the account has no enabled job, open order or published owner hold. Registered and observed
// servers must match the live recipient's server. That side's planner keeps an open order's parties vacant.
export const SIDE_STOCK_MAX_AGE_MS = 30 * 60_000;
// Transfer stock is observed pack or bank stock, never worn kit. A retained bank observation can describe the same
// units before a withdrawal, so the two observations contribute their maximum rather than their sum.
export function donorStock(name:string,side:string,status:any,now:number,maxAgeMs:number,itemName:(id:number)=>string|undefined,server='rs-sdk-demo.fly.dev'):Stock|undefined {
    const recent=(at:unknown)=>typeof at==='number'&&Number.isFinite(at)&&at>0&&at<=now&&now-at<maxAgeMs;
    if(!status||typeof status.name!=='string'||status.name.toLowerCase()!==name.toLowerCase()||status.practice||typeof status.server!=='string'||status.server.toLowerCase()!==server.toLowerCase()||!recent(status.at))return;
    const valid=(rows:unknown)=>Array.isArray(rows)&&rows.every(r=>r&&Number.isSafeInteger(r.count)&&r.count>0&&(typeof r.name==='string'||Number.isSafeInteger(r.baseId??r.id)));
    const inventory=valid(status.inventory)?status.inventory:[];
    const bank=recent(status.bankAt)&&status.bankAt<=status.at&&valid(status.bank)?status.bank:[];
    const held=accountFrom(name,side,{inventory},itemName).items,stored=accountFrom(name,side,{bank},itemName).items;
    const items:Record<string,number>={};
    for(const key of new Set([...Object.keys(held),...Object.keys(stored)])){
        const count=Math.max(held[key]??0,stored[key]??0);
        if(Number.isSafeInteger(count)&&count>0)items[key]=count;
    }
    return Object.keys(items).length?{name,side,items}:undefined;
}
export function sideStock(side: string, snapshot: any, plan: any, open: ReadonlySet<string>, now: number, maxAgeMs: number, itemName: (id: number) => string | undefined,
    context: { owners: ReturnType<typeof loadOwners>; server: string; card?: unknown }): Stock[] {
    if (!Array.isArray(snapshot?.accounts) || !Array.isArray(plan?.jobs) || !Number.isFinite(plan.at) || plan.at > now || !(now - plan.at < maxAgeMs)) return [];
    const busy = enabledAccounts(plan.jobs);
    const server = context.server.toLowerCase();
    return snapshot.accounts.filter((r: any) => {
        if (typeof r?.name !== 'string' || !/^[A-Za-z0-9]{1,12}$/.test(r.name) || typeof r.server !== 'string' || r.server.toLowerCase() !== server || r.practice) return false;
        const name = r.name.toLowerCase(), owner = context.owners.get(name);
        return owner?.side === side && owner.server.toLowerCase() === server && !publishedSideHold(context.card, side, name)
            && !busy.has(name) && !open.has(name) && !OFFLINE_GUARDED.has(name);
    })
        .flatMap((r:any)=>{const stock=donorStock(r.name,side,r,now,maxAgeMs,itemName,server);return stock?[stock]:[];});
}
// Donor and recipient pairs whose item order failed or needs reconciliation in the last `windowMs`, as `from>to` in lower
// case. The same donor would fail the same way (an unpublished pause or a tile it cannot reach), so the planner asks another donor.
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
// A weapon, an armour piece or a tool is bought once and worn on every later tick, and a hand cap under every seller
// leaves it unbought (live: rune platelegs asked 105,375 against a cap of 75,000, the buy ended "unsold" and the
// account kept its kit; the rune chainbody asked 210,367 against 60,000). The limit of such an item follows the lowest ask of the market cache
// (scripts/market-cache.ts, sellers observed), GEAR_ASK_MARGIN over it, while the ask is at most GEAR_ASK_LIMIT times
// the item's shop value in the content (knowledge/gear.json `cost`). Over that bound the hand cap stands, and a shop,
// a quest or a smith is the source. Arrows, runes and food keep their hand caps: they are bought in stacks, and their
// caps bound a whole batch.
export const GEAR_ASK_MARGIN = 1.05, GEAR_ASK_LIMIT = 5, FOLLOWED_RETRY_MS = 3600_000;
export type Asks = Readonly<Record<number, { ask: number | null; sell: number }>>;
export function gearLimit(id: number, cap: number, quote: Asks[number] | undefined): number {
    const gear = gearById(id), ask = quote && quote.sell > 0 ? quote.ask : null;
    if (!gear || gear.slot === 'quiver' || !ask || ask <= cap || ask > GEAR_ASK_LIMIT * gear.cost) return cap;
    return Math.ceil(ask * GEAR_ASK_MARGIN);
}
// An item whose limit follows a seller comes back FOLLOWED_RETRY_MS after a buy that got none: the failed offer was
// at the hand cap, or the seller left, and the next read of the market shows which.
export function kitMarket(items: readonly { id: number; name?: string; debugname?: string }[], unsold: Readonly<Record<string, number>> = {}, now = Date.now(), asks: Asks = {}): Market {
    const market: Record<string, { id: number; name: string; limit: number }> = {};
    // The first item of a name is the one a buy orders. When the market read leaves it out, a later item of the same
    // name (a trimmed or quest copy with no read) must not take its place.
    const decided = new Set<string>();
    for (const i of items) if (typeof i.name === 'string' && Number.isSafeInteger(i.id) && !/^cert_/.test(i.debugname ?? '') && norm(i.name) in KIT_PRICE_CAPS && !decided.has(norm(i.name))
        && (!(norm(i.name) in BOW_IDS) || BOW_IDS[norm(i.name)] === i.id)
        && (!(norm(i.name) in ARMOUR_IDS) || ARMOUR_IDS[norm(i.name)] === i.id)) {
        decided.add(norm(i.name));
        const cap = KIT_PRICE_CAPS[norm(i.name)]!, quote = asks[i.id], limit = gearLimit(i.id, cap, quote);
        // A market read that shows no seller, or a lowest ask over the limit: an offer would get none, so no buy is
        // planned and the account takes the next source at once (owned stock, a shop job, the next weapon stage).
        // With no read of the item the buy is planned as before.
        if (quote && (quote.sell <= 0 || quote.ask === null || quote.ask > limit)) continue;
        if (now - (unsold[i.id] ?? -Infinity) < (limit > cap ? FOLLOWED_RETRY_MS : UNSOLD_RETRY_MS)) continue;
        market[norm(i.name)] = { id: i.id, name: i.name, limit };
    }
    return market;
}
export function unfilledItems(lines: readonly string[]): number[] {
    const out = new Set<number>();
    for (const l of lines) {
        if (!/RESULT fail \{/.test(l) || !/"acquired":0\b/.test(l)) continue;
        const id = l.match(/"itemId":(\d+)/);
        if (id) out.add(Number(id[1]));
    }
    return [...out];
}
export type EndedRecord = { at?: number; reason?: string };
export type JobRunStatus = { active?: boolean; ended?: EndedRecord };
export function readSwarmActiveAccounts(file: string): Set<string> {
    const runs = readJson(file, null);
    if (!Array.isArray(runs)) return new Set();
    const out = new Set<string>();
    for (const r of runs) {
        if (Array.isArray(r?.accounts)) for (const a of r.accounts) if (typeof a === 'string') out.add(a.toLowerCase());
        if (typeof r?.account === 'string') out.add(r.account.toLowerCase());
    }
    return out;
}
export function readSwarmEnded(file: string): Map<string, EndedRecord> {
    const raw = readJson(file, null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return new Map();
    const out = new Map<string, EndedRecord>();
    for (const [name, val] of Object.entries(raw)) {
        if (val && typeof val === 'object') out.set(name.toLowerCase(), val as EndedRecord);
    }
    return out;
}
export function isJobEnded(assigned: { at?: number } | undefined, status?: JobRunStatus): boolean {
    if (!status || status.active || !status.ended) return false;
    const reason = status.ended.reason ?? '';
    // The swarm writes `<word> after N runs` from the supervisor and a bare `exit <code>` for a process that ended with
    // no end line (scripts/swarm.ts), so a code matches whole: exit 4294967295 is not exit 4.
    const terminal = /^(?:exit (?:4|unknown)$|exit orphaned\b|died\b|blocked\b|gave-up\b|done\b|stopped\b)/.test(reason);
    const afterAssign = typeof assigned?.at === 'number' && typeof status.ended.at === 'number' ? status.ended.at >= assigned.at : true;
    return terminal && afterAssign;
}
// A kit buy that has started and printed no RESULT yet holds an open Grand Exchange offer: its coins are in the
// exchange, so the account's live status shows them gone. A declared finite maker also keeps its exact pending
// quantity and observed-stock fingerprint until its terminal result. If the supervisor ended the attempt (e.g.
// orphaned or fatal exit without printing RESULT), release the job so the account and resource lock are freed.
export function kitBuyRunning(job: any, assigned: { template: string; offset: number; at?: number } | undefined, linesSince: (offset: number) => readonly string[], finiteMaker = false,
    ctx?: JobRunStatus): boolean {
    if (!job?.enabled || typeof job.template !== 'string' || (!job.template.startsWith(KIT_BUY) && !finiteMaker) || !assigned || assigned.template !== job.template) return false;
    const lines=linesSince(assigned.offset);
    const r = assess(finiteMaker?lines.filter(l=>l.startsWith('RESULT ')):lines);
    if (r.ok + r.fail + r.drains > 0) return false;
    return !isJobEnded(assigned, ctx);
}

export function completedHeldOrderSeq(jobs:readonly any[],side:string,assigned:Readonly<Record<string,{template:string;offset:number}>>,templates:readonly Template[],
    sequence:Readonly<Record<string,number>>,linesSince:Parameters<typeof finishedTrainers>[4]):Record<string,number>{
    const held=jobs.filter(j=>j?.enabled&&j.script==='scripts/train-prayer.ts'&&j.env?.BURY_HELD==='1');
    const finished=new Set(finishedTrainers(held,side,assigned,templates,linesSince)),next={...sequence};
    for(const j of held)if(finished.delete(j.account)){
        const terminal=linesSince(j.account,assigned[j.account]!.offset,j).filter(l=>l.startsWith('RESULT ')).at(-1);
        // A met level stays settled even if a delayed observation still shows the old level. Only a useful partial
        // held-stock batch needs a new episode; mergeJobs advances its result offset with the changed mission.
        if(terminal&&/^RESULT ok\b/.test(terminal)&&/\btargetMet=false\b/.test(terminal)){
            const name=j.account.toLowerCase();next[name]=(next[name]??0)+1;
        }
    }
    return next;
}
// The accounts whose last session has no confirmed logout (session-lifecycle `held`), in lower case. Such an account
// cannot take a trade claim until a recovery confirms the logout, so it is no donor.
export function strandedAccounts(names: readonly string[], proof: (name: string) => string): Set<string> {
    const out = new Set<string>();
    for (const n of names) { try { if (proof(n) === 'held') out.add(n.toLowerCase()); } catch { /* unreadable proof: as before */ } }
    return out;
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
export function fundOrders(out: readonly Assignment[], open: ReadonlySet<string>, order: (from: string, to: string, coins: number, meet?: Funding['meet']) => Order, itemOrderFor?: (send: ItemFunding) => Order) {
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
        if (!busy) orders.push(order(f.from, f.to, f.coins, f.meet));
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

// Recent session telemetry may keep an existing job through consumed kit. It grants no new launch authority.
export function runningAssignments(jobs:readonly any[],observed:(account:string)=>any,now:number):Set<string>{
    return new Set(jobs.flatMap(job=>{
        if(job?.enabled===false||typeof job?.account!=='string'||typeof job?.script!=='string'||!job.template)return[];
        const status=observed(job.account);
        if(status?.name?.toLowerCase()!==job.account.toLowerCase()||status.practice||status.server!=='rs-sdk-demo.fly.dev'
            ||!Number.isFinite(status.at)||status.at<=0||status.at>now||stopClearable(status,now)
            ||typeof status.sessionAttemptId!=='string'||!status.sessionAttemptId
            ||typeof status.workEntry!=='string'||!status.workEntry.split(',').includes(job.script))return[];
        return[job.account.toLowerCase()];
    }));
}

// The planner's reach rule reads where an account stands. That place is known only while the account is offline: a
// live session (stopClearable) is on its way, so its account goes to the planner with no place and keeps its job.
export function offlinePlace(a: Acct, status: any, now: number): Acct {
    if (stopClearable(status, now)) return a;
    const { pos: _live, ...rest } = a;
    return rest;
}
// Whether the shared walker lets an account walk over White Wolf Mountain, between Taverley and Catherby: no hunter
// with a spawn on the mountain is deadly to it (packages/core/src/danger.ts, the walker's own rule). An account with
// 10 Hitpoints has no route over it.
export const MOUNTAIN = { minX: 2790, maxX: 2880, minZ: 3420, maxZ: 3530 } as const;
export function mountainWalk(hunters: readonly Hunter[] = loadHunters()): (a: Acct) => boolean {
    const pass = hunters.filter(h => h.spawns.some(s => s.level === 0 && s.x >= MOUNTAIN.minX && s.x <= MOUNTAIN.maxX && s.z >= MOUNTAIN.minZ && s.z <= MOUNTAIN.maxZ));
    return a => {
        const skills = Object.fromEntries(Object.entries(a.skills).map(([k, v]) => [k.toLowerCase(), v]));
        return !pass.some(h => deadlyTo(h, skills));
    };
}

export function planningOwnership(ownerJobs: readonly any[], coordinatorJobs: readonly any[], paused: ReadonlySet<string>,queue?:AccountBindingState) {
    // A parked coordinator job still shadows its owner job until the coordinator releases it.
    const held = new Set(coordinatorJobs.flatMap(jobAccounts).map(account => account.toLowerCase()));
    for(const record of queue?.tasks??[])if(record.status==='pending'||record.status==='running')for(const account of boundAccounts(record.spec,queue!)??[])held.add(account.toLowerCase());
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

// What a log line says of a job's worth: coins per tick for a supply job; a goal band has no coin value (its worth is
// the army level it trains), so it prints its band, and a kit buy prints its kind.
export function jobRate(x: Pick<Assignment, 'template' | 'value'>): string {
    const t = x.template;
    return t?.tier === 'goal' ? `band ${t.band ?? 0}` : t?.family === 'kit-buy' ? 'kit buy' : `${x.value.toFixed(2)}/tick`;
}

// The write step of a pass: `unchanged` is true while the files that the plan came from hold the text that the plan read.
export interface PassWrite { unchanged(): boolean; write(): string[] }
// With `defer`, a pass that has something to write does not write: it gives its write step to `defer` (lockedPass).
export function pass(planFile: string, dry: boolean, isPaused = swarmPaused, defer?: (step: PassWrite) => void): string[] {
    if (!dry && isPaused()) return [PAUSED];
    // The files that other writers change under the plan lock, and this side's planner state, as text before the plan reads them.
    const inputFiles = [planFile, join(root, COORDINATOR_JOBS_FILE), join(prac, 'autopilot', `${mySide()}.json`)];
    const inputText = (f: string) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
    const inputBefore = inputFiles.map(inputText);
    const side = mySide(), owners = loadOwners(), swarm = readJson(planFile, null);
    if (!swarm || !Array.isArray(swarm.jobs)) throw Error(`autopilot: ${planFile} has no jobs list`);
    const stateFile = join(prac, 'autopilot', `${side}.json`), state = loadState(side);
    const items: any[] = readJson(join(root, 'knowledge/items.json'), []), byId = new Map(items.map(i => [i.id, i.name]));
    const mineMarked = (j: any) => j?.autopilot === side;

    // Resources other jobs hold: this file's other jobs (paused planner jobs included), and other sides' fresh claims.
    const listedNames = Object.keys(readJson(join(FLEET_DIR(), 'owners.json'), { accounts: {} }).accounts ?? {});
    // An owner's stop file pauses its account. One the controller wrote itself (a job that left the plan, stop-swarm)
    // does not: that account is planned again, and the file goes with the job that replaces it (below).
    const stopText = (n: string): string | undefined => { try { return readFileSync(join(prac, `stop-${n}`), 'utf8'); } catch { return undefined; } };
    const fleetDir = FLEET_DIR(), now = Date.now();
    const activeAccounts = readSwarmActiveAccounts(join(prac, 'swarm-runs.json'));
    const endedAccounts = readSwarmEnded(join(prac, 'swarm-deaths.json'));
    const ctxFor = (acct: string): JobRunStatus => ({ active: activeAccounts.has(acct.toLowerCase()), ended: endedAccounts.get(acct.toLowerCase()) });
    const diedAccounts = new Set<string>();
    for (const [acctLower, rec] of endedAccounts) {
        if (!activeAccounts.has(acctLower) && /^died\b/.test(rec.reason ?? '')) diedAccounts.add(acctLower);
    }
    const { paused, swarmStopped } = pauses(new Map(listedNames.flatMap(n => { const t = stopText(n); return t === undefined ? [] : [[n, t] as const]; })));
    const queue=readJson(join(prac,'coordinator/state.json'),null);
    if(swarm.coordination?.enabled&&(!queue||queue.version!==1||!Array.isArray(queue.tasks)))return['AUTOPILOT hold: owning coordinator queue is unavailable'];
    const { held, keep, busy } = planningOwnership(swarm.jobs, readCoordinatorJobs(root).jobs, paused,queue?.version===1&&Array.isArray(queue.tasks)?queue:undefined);
    const templates=catalogue(),finiteMakers=new Set(templates.filter(t=>t.production).map(t=>t.id));
    for (const j of swarm.jobs.filter(mineMarked)) if (typeof j.account === 'string'
        && !diedAccounts.has(j.account.toLowerCase())
        && kitBuyRunning(j, state.assigned[j.account], offset => readJobResultLines(join(prac, 'swarm-logs', `${j.account}.log`), offset, j), finiteMakers.has(j.template), ctxFor(j.account))) keep.add(j.account.toLowerCase());

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
        if (r.retire) { const script = scriptOf(j.template); state.retired[pairKey(j.account, j.template)] = script === undefined ? r.reason : { reason: r.reason, script }; log.push(`AUTOPILOT retire ${j.account} ${j.template}: ${r.reason}`); continue; }
        const ctx = ctxFor(j.account);
        if (isJobEnded(a, ctx)) {
            const endedReason = ctx.ended?.reason ?? '';
            if (/^died\b/.test(endedReason)) {
                state.retired[pairKey(j.account, j.template)] = `death: ${endedReason}`;
                log.push(`AUTOPILOT retire ${j.account} ${j.template}: death: ${endedReason}`);
            } else if (/^exit 4$/.test(endedReason)) {
                const script = scriptOf(j.template);
                const reason = `script-error: ${endedReason}`;
                state.retired[pairKey(j.account, j.template)] = script === undefined ? reason : { reason, script };
                log.push(`AUTOPILOT retire ${j.account} ${j.template}: ${reason}`);
            } else if (String(j.template).startsWith(KIT_BUY) && /^exit orphaned\b/.test(endedReason)) {
                raiseKitSeq(state, j.account, ctx.ended?.at);
            }
        }
    }

    const leaseAt = (sideName: string): number | undefined => {
        const lease = readJson(join(fleetDir, 'leases', `${sideName}.json`), null);
        return Number.isFinite(lease?.at) ? lease.at : undefined;
    };
    const leaseStale = (sideName: string): boolean => {
        const at = leaseAt(sideName);
        return at !== undefined && !(now - at < CLAIM_MAX_AGE_MS);
    };
    const taken = reservedResources(swarm.jobs, side, keep);
    const claimDir = join(fleetDir, 'claims');
    const synced = existsSync(claimDir) ? readdirSync(claimDir).filter(f => f.endsWith('.json')).map(f => readJson(join(claimDir, f), null)) : [];
    for (const c of newestClaims(synced, originClaims(fleetDir))) {
        if (c.side === side || leaseStale(c.side) || !Array.isArray(c.resources) || !(now - c.at < CLAIM_MAX_AGE_MS)) continue;
        for (const r of c.resources) if (typeof r === 'string') taken[r] = (taken[r] ?? 0) + 1;
    }

    const listed = listedNames;
    // An account's freshest observation: its status file, or its canonical row in the fleet snapshots (a fresh cloud
    // container has no status files, an account adopted from another side has its last row there, and a Thieving 99
    // account must not plan as a level-1 start).
    const statusDir = join(prac, 'status'), statusFiles = existsSync(statusDir) ? readdirSync(statusDir) : [];
    const published = readSnapshotFiles(join(fleetDir, 'snapshots'));
    const observed = (n: string) => {
        const f = statusFiles.find(f => f.toLowerCase() === `${n.toLowerCase()}.json`);
        return observedAccount(n, f ? readJson(join(statusDir, f), null) : null, published, owners, side);
    };
    const accounts = plannableAccounts(swarm.jobs, side, listed.filter(n => {
        const lower = n.toLowerCase();
        return owners.get(lower)?.side === side && !OFFLINE_GUARDED.has(lower) && !diedAccounts.has(lower);
    }), keep).map(n => offlinePlace(accountFrom(n, side, observed(n), id => byId.get(id)), observed(n), now));
    // Coin donors: this side's accounts with no enabled swarm or coordinator job, no stop file and no open order, as
    // their last status reports them. The fleet agent runs a trade only for such accounts.
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
    // An account whose last session has no confirmed logout cannot log in for a trade: its held swarm claim refuses the
    // trade claim ("fleet account claim held by swarm"), so its partner waits for nothing and the order fails. It gives
    // nothing until a recovery confirms its logout.
    const stranded = strandedAccounts(listed, n => readLogoutProof(n, owners.get(n.toLowerCase())?.server ?? 'rs-sdk-demo.fly.dev').state);
    const donors = listed.filter(n => {
        const lower = n.toLowerCase();
        return owners.get(lower)?.side === side && !OFFLINE_GUARDED.has(lower) && !diedAccounts.has(lower) && ![busy, keep, open, stranded].some(s => s.has(lower));
    }).map(n => ({ name: n, coins: accountFrom(n, side, observed(n), id => byId.get(id)).items.coin ?? 0 })).filter(d => d.coins > 0);
    // Kit donors: this side's free accounts (the coin donors' rule), then each other side's, on the same server.
    const free = (n: string) => {
        const lower = n.toLowerCase();
        return owners.get(lower)?.side === side && !OFFLINE_GUARDED.has(lower) && !diedAccounts.has(lower) && ![busy, keep, open, stranded].some(s => s.has(lower));
    };
    const stock: Stock[] = listed.filter(free).flatMap(n => {const row=donorStock(n,side,observed(n),now,SIDE_STOCK_MAX_AGE_MS,id=>byId.get(id),owners.get(n.toLowerCase())?.server);return row?[row]:[];});
    const snapshotDir = join(fleetDir, 'snapshots'), silent = silentSides(orders, receipts, n => owners.get(n.toLowerCase())?.side, now);
    for (const f of existsSync(snapshotDir) ? readdirSync(snapshotDir).filter(f => f.endsWith('.json')) : []) {
        const other = f.slice(0, -'.json'.length);
        if (other !== side && !silent.has(other) && !leaseStale(other)) stock.push(...sideStock(other, readJson(join(snapshotDir, f), null), readJson(join(fleetDir, 'plans', f), null), open, now, SIDE_STOCK_MAX_AGE_MS, id => byId.get(id),
            { owners, server: 'rs-sdk-demo.fly.dev', card: readJson(join(fleetDir, 'sides', f), null) }));
    }
    const market = kitMarket(items, state.unsold, now, marketQuotes(readJson(join(root, MARKET_FILE), null), now));
    // Finite funding uses each recipient's own coins and accessible donor surplus.
    // Protected, paused and busy accounts do not supply a shared cash budget.
    // Coins fund finite route and army acquisition demand.
    log.push('AUTOPILOT finite route and army demand');
    const bill = routeBill(items);
    state.kitSeq=completedHeldOrderSeq(swarm.jobs.filter((j:any)=>mineMarked(j)&&!keep.has(String(j.account).toLowerCase())),side,state.assigned,templates,state.kitSeq??{},
        (name,offset,job)=>readJobResultLines(join(prac,'swarm-logs',`${name}.log`),offset,job));
    const idsByName=new Map<string,number[]>();
    for(const item of items)if(typeof item.name==='string'&&!/^cert_/.test(item.debugname??'')){const name=norm(item.name),ids=idsByName.get(name)??[];if(!ids.includes(item.id))ids.push(item.id);idsByName.set(name,ids);}
    const itemId=(name:string)=>{const ids=idsByName.get(norm(name));return ids?.length===1?ids[0]:undefined;};
    const retained=kitReserve(templates),progressionStocks=stock.flatMap(s=>{
        try{const a=accountFromStatus(s.name,observed(s.name),now),owned:Record<number,number>={};
            for(const container of [a.inventory,a.equipment,a.bank])if(container&&container.at>0&&container.at<=now&&now-container.at<=300000)for(const[id,count]of Object.entries(container.value))owned[Number(id)]=(owned[Number(id)]??0)+count;
            const quantities:Record<number,number>={};for(const[id,count]of Object.entries(owned)){const name=norm(byId.get(Number(id))??'');if(!name)continue;quantities[Number(id)]=Math.max(0,Math.min(count,(s.items[name]??0))-(retained[name]??0)-(a.reservations?.[Number(id)]??0));}
            return[{holder:s.name,at:a.at,items:quantities}];
        }catch{return[];}
    });
    const sourceAllowed=new Set(stock.map(s=>s.name.toLowerCase())),newlyWorking=new Set<string>();
    const progression=createAutopilotProgression({now,observed,itemId,itemName:id=>byId.get(id),builds:buildCaps(swarm),jobs:swarm.jobs,
        assignedAt:new Map(Object.entries(state.assigned).map(([name,s])=>[name.toLowerCase(),s.at])),taken,capacity:CAPACITY,
        busy:new Set([...keep,...open,...stranded,...diedAccounts,...swarm.jobs.filter((j:any)=>!mineMarked(j)&&j?.enabled!==false).flatMap(jobAccounts).map((n:string)=>n.toLowerCase())]),paused,protected:new Set(OFFLINE_GUARDED),
        stocks:progressionStocks,sourcesFor:(account,_method,_item)=>[account,...stock.filter(s=>!newlyWorking.has(s.name.toLowerCase())&&owners.get(s.name.toLowerCase())?.server===owners.get(account.toLowerCase())?.server).map(s=>s.name)],
        canTransfer:(from,to)=>sourceAllowed.has(from.toLowerCase())&&!newlyWorking.has(from.toLowerCase())&&free(from)&&free(to)&&owners.get(from.toLowerCase())?.server===owners.get(to.toLowerCase())?.server});
    const planned = plan({ side, accounts, owners, running: runningAssignments(swarm.jobs.filter(mineMarked), observed, now), bill, templates,templateFor:progression.templateFor, prices: priceTable(items, bill), waste: wasteShare(tickWaste(join(prac, 'swarm-logs'), { latest: true })), taken, retired: new Set(Object.keys(state.retired)), capacity: CAPACITY, shared: SHARED, unfundable: busy, donors, current: new Map(Object.entries(state.assigned).map(([a, s]) => [a.toLowerCase(), s.template])), army: armyRoster(swarm), builds: buildCaps(swarm), buildQuests: buildQuests(swarm), buildBefore: buildBefore(swarm), pilots: aioPilots(swarm), stock, market: market as Market, mountain: mountainWalk(),
        kitSeq: new Map(Object.entries(state.kitSeq ?? {}).map(([a, n]) => [a.toLowerCase(), n])), noSend: failedSends(orders, receipts, now) });
    for(const assignment of planned)if(assignment.template||assignment.fund||assignment.send)newlyWorking.add(assignment.account.toLowerCase());
    const refined=progression.refine(planned);
    log.push(`AUTOPILOT progression ${refined.changes.filter(c=>c.ready).length} measured changes, ${refined.requests.length} evidence/supply requests`);
    const serverOf = (to: string) => owners.get(to.toLowerCase())?.server ?? 'rs-sdk-demo.fly.dev';
    const lead=(from:string,to:string)=>owners.get(from.toLowerCase())?.side===side&&owners.get(to.toLowerCase())?.side===side?0:15*60_000;
    const funding = fundOrders(refined.assignments, open, (from, to, coins, meet) => coinOrder(from, to, coins, serverOf(to), now, meet === 'ardougne' ? ARMY_MEET : undefined,lead(from,to)),
        s => itemOrder(s.from, s.to, market[s.item]?.name ?? items.find(i => typeof i.name === 'string' && norm(i.name) === s.item && !/^cert_/.test(i.debugname ?? ''))?.name ?? s.item, s.count, serverOf(s.to), now,
            lead(s.from,s.to)));
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
        log.push(`AUTOPILOT ${fresh.includes(x.account) ? 'assign' : 'keep'} ${x.account} ${x.template.id} ${jobRate(x)} ${x.reason}`);
    }
    if (dry) return [...log, 'AUTOPILOT dry run: nothing written'];
    const write = (): string[] => {
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
        mkdirSync(join(prac,'progression-system'),{recursive:true});
        writeAtomic(join(prac,'progression-system',`fleet-${side}.json`),JSON.stringify({version:1,side,at:now,decisions:progression.decisions(),requests:refined.requests,gaps:refined.gaps,reservations:refined.reservations,search:refined.search},null,1)+'\n');
        if (funding.orders.length) mkdirSync(join(fleetDir, 'orders'), { recursive: true });
        for (const o of funding.orders) writeAtomic(join(fleetDir, 'orders', `${o.id}.json`), JSON.stringify(o, null, 1) + '\n');
        return log;
    };
    if (!defer) return write();
    defer({ unchanged: () => inputFiles.every((f, i) => inputText(f) === inputBefore[i]), write });
    return log;
}

// One planning pass. The plan is made with no lock. On the live state a plan takes longer than the 15 s that another
// writer waits for the plan lock (packages/core/src/plan-lock.ts), and a coordinator start ended on that wait. The lock
// is held only to compare the files that the plan read with the files on disk, and to write. A changed file means that
// another writer got the lock after the plan read it, so the pass plans again from the new files.
export const PLAN_ATTEMPTS = 3;
export async function lockedPass(planFile: string, dry: boolean, lock: <T>(action: () => T) => Promise<T>, isPaused = swarmPaused): Promise<string[]> {
    for (let attempt = 1; ; attempt++) {
        let step: PassWrite | undefined;
        const lines = pass(planFile, dry, isPaused, s => { step = s; });
        if (!step) return lines;
        const write = step;
        const written = await lock(() => write.unchanged() ? write.write() : null);
        if (written) return written;
        if (attempt >= PLAN_ATTEMPTS) return [`AUTOPILOT hold: another writer changed the account plan during each of ${PLAN_ATTEMPTS} plans`];
    }
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
    const activeAccounts = readSwarmActiveAccounts(join(prac, 'swarm-runs.json'));
    const endedAccounts = readSwarmEnded(join(prac, 'swarm-deaths.json'));
    // A kit buy with a RESULT, ok or fail, or an ended/orphaned run, also wants its next pass now: the band waits for
    // the kit, and a failed buy must not be restarted by the controller until the 10-minute timer.
    const buys = effectiveJobs.filter(j => j?.autopilot === side && typeof j.account === 'string' && typeof j.template === 'string' && j.template.startsWith(KIT_BUY)
        && j.enabled && state.assigned[j.account]?.template === j.template && !kitBuyRunning(j, state.assigned[j.account], offset => since(j.account, offset, j), false, {
            active: activeAccounts.has(j.account.toLowerCase()),
            ended: endedAccounts.get(j.account.toLowerCase()),
        })).map(j => j.account as string);
    return [...finishedTrainers(effectiveJobs, side, state.assigned, catalogue(), since), ...buys]
        .map(a => `${a}:${state.assigned[a]!.template}:${state.assigned[a]!.offset}`);
}

if (import.meta.main) {
    const args = process.argv.slice(2), planFile = resolve(args.find(a => !a.startsWith('--')) ?? join(root, 'swarm.json'));
    // The write step of a pass runs under the account-plan lock (lockedPass): the coordinator installs jobs into its
    // overlay under the same lock. The timer and the trainer check share one pass at a time: a second call joins the
    // pass in flight.
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
                const lines = await lockedPass(planFile, dry, action => withPlanWrite(action, join(prac, 'coordinator')));
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
        console.log(`AUTOPILOT finite job ended, passing now: ${due.map(k => k.split(':')[0]).join(' ')}`);
        void once().then(outcome => {
            if (outcome === 'applied') for (const k of due) seen.add(k);
        });
    }, TRAINER_POLL_MS);
}
