// Account status/snapshot parsing, job creation, log assessment/retirement, fleet resource claims, and swarm job merging.
import { missionSignature } from '../../../core/src/session-admission';
import { REFUSAL_ANY_SOURCE } from '../../../core/src/order-refusal';
import { jobResources, norm, type Acct, type Assignment, type Template } from './world';
import { BOW_IDS, bowStockNames } from './pricing';

// The pseudo template of an item order that restocks a gang squad member (the order is the whole job).
export const SQUAD_RESTOCK: Template = { id: 'squad-restock', family: 'kit-buy', script: 'scripts/aio-market.ts', role: 'supply', goal: 'restock the gang squad', yields: () => [] };

// The freshest of an account's observations by `at`: its status file and its row in the side's fleet snapshot. A fresh
// cloud container has no status files, so without the snapshot every account would plan as a level-1 start.
export function freshest(...observations: readonly any[]): any {
    return observations.filter(o => o && typeof o === 'object').reduce((best, o) => (Number(o.at) || 0) > (Number(best?.at) || 0) ? o : best, null);
}

// An account as the planner sees it, from its status file (.practice/status/<name>.json) or a fleet snapshot row:
// base levels, pack, bank and worn counts by item name, and its complete quests (a status lists every quest with a
// state, a snapshot row the complete ones by name), and the tile it stands on (a status only). No status: a fresh
// account at level 1 (Hitpoints 10).
const EXACT_ITEM_ALIASES: ReadonlyMap<number, string> = new Map([
    [1747, 'dragonhide_black'],
    [2509, 'dragon_leather_black'],
    [2503, 'black_dragonhide_body'],
    [2497, 'black_dragonhide_chaps'],
    [2491, 'black_dragon_vambraces'],
    [985, 'keyhalf1'],
    [987, 'keyhalf2'],
    [1683, 'unstrung dragonstone amulet'],
    [1702, 'strung dragonstone amulet'],
    [3146, 'poorly cooked karambwan'],
    [91, 'guam potion (unf)'],
    [93, 'marrentill potion (unf)'],
    [95, 'tarromin potion (unf)'],
    [97, 'harralander potion (unf)'],
    [99, 'ranarr potion (unf)'],
    [101, 'irit potion (unf)'],
    [103, 'avantoe potion (unf)'],
    [105, 'kwuarm potion (unf)'],
    [107, 'cadantine potion (unf)'],
    [109, 'dwarf weed potion (unf)'],
    [111, 'torstol potion (unf)'],
    [2483, 'lantadyme potion (unf)'],
    [3002, 'toadflax potion (unf)'],
    [3004, 'snapdragon potion (unf)'],
    [199, 'unidentified guam'],
    [201, 'unidentified marentill'],
    [203, 'unidentified tarromin'],
    [205, 'unidentified harralander'],
    [207, 'unidentified ranarr'],
    [209, 'unidentified irit'],
    [211, 'unidentified avantoe'],
    [213, 'unidentified kwuarm'],
    [215, 'unidentified cadantine'],
    [217, 'unidentified dwarf weed'],
    [219, 'unidentified torstol'],
    [2485, 'unidentified lantadyme'],
    [3049, 'unidentified toadflax'],
    [3051, 'unidentified snapdragon'],
]);
let exactItemIdCache: ReadonlyMap<string, number> | undefined;
export function exactItemIds(): ReadonlyMap<string, number> {
    return exactItemIdCache ??= new Map([
        ...Array.from(bowStockNames, ([id, name]) => [name, id] as const),
        ...Array.from(EXACT_ITEM_ALIASES, ([id, name]) => [name, id] as const),
    ]);
}
export function accountFrom(name: string, side: string, status: any, itemName: (id: number) => string | undefined): Acct {
    const skills: Record<string, number> = { Hitpoints: 10 }, items: Record<string, number> = {}, exact: Record<string, number> = {};
    for (const k of Array.isArray(status?.skills) ? status.skills : []) if (typeof k?.name === 'string' && Number.isFinite(k.level)) skills[k.name] = k.level;
    const validHP = (hp: unknown): hp is number => Number.isSafeInteger(hp) && (hp as number) >= 0;
    const sharedHP = (Array.isArray(status?.skills) ? status.skills : []).find((k: any) => k?.name === 'Hitpoints')?.currentLevel;
    const currentHP = validHP(status?.hp?.now) ? status.hp.now : validHP(sharedHP) ? sharedHP : undefined;
    for (const r of [status?.inventory, status?.bank, status?.equipment].flatMap(x => Array.isArray(x) ? x : [])) {
        const n = typeof r?.name === 'string' ? r.name : itemName(r?.baseId ?? r?.id);
        const itemId = r?.baseId ?? r?.id;
        const alias = bowStockNames.get(itemId) ?? EXACT_ITEM_ALIASES.get(itemId);
        const key = alias ?? (n && !(norm(n) in BOW_IDS) ? norm(n) : undefined);
        if (key && Number.isFinite(r.count)) items[key] = (items[key] ?? 0) + r.count;
        if (key && Number.isFinite(r.count) && (r?.baseId === undefined || r.baseId === r.id)) exact[key] = (exact[key] ?? 0) + r.count;
        // The held-bones Prayer worker deposits and buries only id526. Keep notes in generic stock for trades and
        // other consumers, while this availability key admits only the exact normal bones that worker can use.
        if (r?.id === 526 && Number.isFinite(r.count)) items['bone (unnoted)'] = (items['bone (unnoted)'] ?? 0) + r.count;
    }
    const quests = Array.isArray(status?.quests)
        ? new Set<string>(status.quests.flatMap((q: any) => typeof q === 'string' ? [norm(q)] : typeof q?.name === 'string' && q.state === 'complete' ? [norm(q.name)] : [])) : undefined;
    const questPoints = status?.guildFacts?.varps?.qp, p = status?.pos;
    return { name, side, skills, items, ...(status ? { exact } : {}), ...(Number.isFinite(status?.at) && status.at > 0 ? { observedAt: status.at } : {}), ...(currentHP !== undefined ? { currentHP } : {}), ...(Number.isFinite(status?.combat) ? { combat: status.combat } : {}), ...(quests ? { quests } : {}), ...(Number.isFinite(questPoints) ? { questPoints } : {}),
        ...(Number.isFinite(p?.x) && Number.isFinite(p?.z) ? { pos: { x: p.x, z: p.z, level: Number.isFinite(p.level) ? p.level : 0 } } : {}) };
}

// The swarm job for an assignment. `autopilot` marks it as this side's planner job; the CLI replaces only marked jobs.
// A training job or a quest job does not repeat: its ok RESULT means the target level is met (or the quest is done), and a rerun would log in, find the level
// met and log out (a scored login for nothing). The swarm keeps the account's `done` end until the next pass hands it
// a job with a different mission, which the met level unlocks. A run that ends short of the target is a fail RESULT,
// which the supervisor retries and the swarm's standing retry resumes, with or without repeat. Declared finite
// makers take one attempt: success needs a fresh stock observation, and a failed end needs the supported repair path.
// finishedTrainers() brings that next pass forward.
export function jobFor(x: Assignment, side: string) {
    const t = x.template!;
    return { account: x.account, script: t.script, args: t.args ?? [], env: t.env ?? {}, role: t.role, goal: t.goal, enabled: true, repeat: t.repeats ?? !(t.trains || t.quest), standing: true, ...(t.production ? { standingRetry: false, maxRestarts: 0 } : {}),
        autopilot: side, template: t.id, resources: x.resources, note: `autopilot ${t.id}: ${x.reason}, ${x.value.toFixed(2)} coins/tick (estimate)` };
}

// A trainer or quest that succeeded, or a finite maker that ended: the current assignment and job fingerprint must
// match the complete result. The daemon reobserves these accounts at once through its existing planning pass.
export function finishedTrainers(jobs: readonly any[], side: string, assigned: Readonly<Record<string, { template: string; offset: number }>>, templates: readonly Template[],
    linesSince: (account: string, offset: number, job: any) => readonly string[]): string[] {
    // A quest job ends as a trainer does: its ok RESULT frees the account for the job the quest unlocks.
    const watched = new Map(templates.filter(t => t.trains || t.quest || t.production).map(t => [t.id, t]));
    return jobs.filter(j => {
        if (j?.autopilot !== side || typeof j.account !== 'string' || !watched.has(j.template) || assigned[j.account]?.template !== j.template) return false;
        const lines = linesSince(j.account, assigned[j.account]!.offset, j);
        // runChild indents chain steps; only the outer job's column-zero RESULT settles a finite maker.
        const result = assess(watched.get(j.template)!.production ? lines.filter(l => l.startsWith('RESULT ')) : lines);
        return watched.get(j.template)!.production ? result.ok + result.fail + result.drains > 0 : result.ok > 0;
    }).map(j => j.account);
}

// Retirement from a job's own log lines (since the autopilot assigned it): the last RETIRE_FAILS RESULTs all fail with
// no progress, a RESULT reports a death, or the last LEDGER spent WASTE_LIMIT or more of its ticks idle or walking.
// The ledger counts the ticks between two hits of a fight as idle and the walk to the next target as move, so a
// fighter on a shared field passes WASTE_LIMIT while it gains XP: a ledger whose own run ended ok with progress (the
// RESULT printed after it) does not retire. Live claude-cloud, 12 accounts on the trooper field: ok trooper and cow
// runs at 91-93% idle+move were retired and their accounts sent back to a lower band.
// A trainer that hits its tick cap short of the target ends fail with the XP it gained (scripts/generated/thieving60.ts
// prints xp=<gain>), so the supervisor runs it again; such a fail is progress and does not count toward retirement.
// A run the server or the relayed gateway dropped says nothing about the job, so it is counted as a drain, never as a
// failure: a dropped session (`RESULT fail session ended: disconnected`; the cloud proxy's 1012 `server_draining`
// closes), a game socket that errors at login (`RESULT fail login: [object WebSocket]`), and a server that stops
// ticking (`RESULT fail TickStallError`). Its supervisor logs the account back in and the next run banks the carried
// pack. Counting these as failures retired every knight spot of every account in one server outage. A login refused
// because a dropped session still holds the account's fleet claim (the worker logs `RESULT fail login: Error: fleet
// account claim held by swarm` until an authenticated recovery confirms the logout) is a drain too: the job never ran,
// and the recovered account resumes it. So is a world planner `precondition no route to`: it says where the account
// stands, not whether the job works, and a routing fix makes the same job run. And so is a market buy that did not
// reach the market bank (`market bank travel failed`, scripts/buy-owned-ge-item.ts): no order was placed, and the
// account stands nearer the bank for its next try (live claude-cloud: after the second ferry a relayed session's
// state went stale at Port Sarim, the route was planned from it, and two such trips retired an account's rune buy;
// the same walk from that tile takes 249 ticks on practice). And so is a market buy refused at the bank because the
// account owns another count of the item than the planner read (`owned item baseline N differs from EXPECTED_OWNED
// M`): no order was placed, the run's bank visit gives the planner the count, and the next pass sizes the buy from it
// (live: three accounts' rune buys retired on a count 36 to 124 over the bank's).
export const RETIRE_FAILS = 2, WASTE_LIMIT = 0.9;
// The ledger length under which a stop file's end exempts a run from the tick-waste retirement: the shortest job caps
// (a shop trip, a kit buy) are 1,200 to 1,500 ticks, so a ledger under 1,000 ticks is the walk to the work.
export const STOP_LEDGER_TICKS = 1000;
// Cow mode reports its progress as selectedXp, damageXp and creditedKills.
// A shop run reports what it bought as boughtTotal (scripts/shop-buyer.ts), and a Grand Exchange buy as "acquired" in
// its JSON result (scripts/buy-owned-ge-item.ts). Without the second, a kit buy that ended ok after its long trip read
// as tick waste and its pair was retired, so the account's next buy for that band never came (live claude-cloud: the
// alchemy kit buys of KnightRider, Deeppockets and Fatstack, one of them after 1,000 nature runes bought).
// A blood chest run reports "loots" in its JSON result (scripts/blood-chest.ts): it waits on the surface for the
// chests to come back, so most of its ticks are idle.
export const progressed = (result: string) => /\b(?:xp|gained|coinsGained|banked|selectedXp|damageXp|creditedKills|boughtTotal|hides)=[1-9]\d*\b|"(?:acquired|loots)":[1-9]/.test(result);
// A run that ended on a stop file is a drain as well: the owner paused the account or the controller removed the job,
// which says nothing about whether the job works (live claude-cloud: a quest chain stopped for an open fleet order
// logged two such fails, and the account's Lost City band was retired).
// An offline login server or an unavailable swarm claim authority refuses the session before the worker runs.
// Supervisor retry bounds and claim recovery still apply; neither refusal establishes a broken worker.
const DRAIN_BASE = /^RESULT fail (?:session ended: disconnected\b|login: \[object WebSocket\]|login: LoginError: Login server offline\b|TickStallError\b|(?:login: )?(?:Error: )?fleet account claim held\b|(?:login: )?(?:Error: )?fleet swarm claim authority (?:unavailable or changed|timed out)\b|.*\bprecondition no route to\b|.*\bmarket bank travel failed\b|.*\bowned item baseline \d+ differs from EXPECTED_OWNED \d+|.*\bstop"?[=:]"?preparation\b|.*\bprogression requires acquire\b|stop file\b|.*\bworker finished: stop file\b)/;
// A buy that ends before it places an offer, on any refusal of packages/core/src/order-refusal.ts, is no failure of its job.
export const DRAIN_RESULT = new RegExp(DRAIN_BASE.source.replace('^RESULT fail (?:', `^RESULT fail (?:.*"phase":"unplaced",.*"escrow":0,.*"failure":"Error: (?:${REFUSAL_ANY_SOURCE})|`));
export function assess(lines: readonly string[]): { retire: boolean; reason: string; ok: number; fail: number; drains: number } {
    const clean = lines.map(l => l.replace(/^\s*(\|\s*)?(\[[^\]]+\]\s*)?/, ''));
    const drains = clean.filter(l => DRAIN_RESULT.test(l)).length;
    const results = clean.filter(l => /^RESULT (ok|fail)\b/.test(l) && !DRAIN_RESULT.test(l));
    const ok = results.filter(l => l.startsWith('RESULT ok')).length, fail = results.length - ok;
    // goldfarm and thieving60 print died=false on a healthy run, and scripts/buy-owned-ge-item.ts prints "died":false in
    // its JSON: only a bare word or a field that is not false counts.
    const died = results.find(l => /\b(?:died|death)\b(?!=|"\s*:\s*false\b)|\b(?:died|death)=(?!false\b)/i.test(l));
    if (died) return { retire: true, reason: `death: ${died.slice(0, 120)}`, ok, fail, drains };
    const tail = results.slice(-RETIRE_FAILS);
    if (tail.length === RETIRE_FAILS && tail.every(l => l.startsWith('RESULT fail') && !progressed(l))) return { retire: true, reason: `${RETIRE_FAILS} fail RESULTs: ${tail.at(-1)!.slice(0, 120)}`, ok, fail, drains };
    // A single preparation/acquire block is a drain, but RETIRE_FAILS consecutive blocks with no progress is a fast-fail loop.
    const allResults = clean.filter(l => /^RESULT (ok|fail)\b/.test(l));
    const prepTail = allResults.slice(-RETIRE_FAILS);
    if (prepTail.length === RETIRE_FAILS && prepTail.every(l => l.startsWith('RESULT fail') && /\b(?:stop"?[=:]"?preparation\b|progression requires acquire\b)/.test(l) && !progressed(l)))
        return { retire: true, reason: `${RETIRE_FAILS} preparation/acquire RESULTs: ${prepTail.at(-1)!.slice(0, 120)}`, ok, fail, drains };
    const at = clean.reduce((last, l, i) => l.startsWith('LEDGER ') ? i : last, -1);
    const ledger = clean[at]?.match(/^LEDGER ticks=(\d+).* move=(\d+).* idle=(\d+)/), ended = clean.slice(at + 1).find(l => /^RESULT (ok|fail)\b/.test(l));
    // A run that an owner or controller stop file cut while its ledger was still short says nothing about the waste of
    // its job: the ledger is the walk to the work. A long ledger (STOP_LEDGER_TICKS or more) has shown its waste, and any
    // other drain ending leaves the rule as it was.
    const stopCut = !!ended && /^RESULT fail (?:.*\bworker finished: )?stop file\b/.test(ended) && !!ledger && +ledger[1]! < STOP_LEDGER_TICKS;
    if (ledger && +ledger[1]! >= 300 && (+ledger[2]! + +ledger[3]!) / +ledger[1]! >= WASTE_LIMIT && !(ended?.startsWith('RESULT ok') && progressed(ended)) && !stopCut)
        return { retire: true, reason: `tick waste ${(100 * (+ledger[2]! + +ledger[3]!) / +ledger[1]!).toFixed(0)}% idle+move`, ok, fail, drains };
    return { retire: false, reason: '', ok, fail, drains };
}

// This side's new swarm job list: every job without this side's marker stays as it is; a planner job whose account
// keeps its template stays unchanged (its swarm revision and run go on); a changed or new assignment gets a fresh job.
// The accounts this side's planner may give a job: those a marked job names (handed over), or those no job names at all
// (a fresh account). An enabled unmarked job (a hand job or a coordinator run) keeps its account, a reservation (no
// script) keeps its account, and an owner pause (a stop file) keeps its account. An unmarked job that is off holds an
// account only when no marked job names it: a finished coordinator run does not block a handover, but by itself it
// frees nothing, since the coordinator may plan that account next.
// The accounts that a swarm.json reservation holds: a job that is no planner job of `side` and has no script (the main and
// specialist accounts, the gang squad). A reservation gives no job to its account (plannableAccounts) and no stock or coins to
// another account (the donor filters of scripts/autopilot.ts); an order that gives TO it still runs.
export function reservedAccounts(jobs: readonly any[], side: string): Set<string> {
    return new Set(jobs.filter(j => j?.autopilot !== side && !j?.script).flatMap(j => [j?.account, ...(j?.accounts ?? [])]).filter((n): n is string => typeof n === 'string').map(n => n.toLowerCase()));
}
export function plannableAccounts(jobs: readonly any[], side: string, listed: readonly string[], paused: ReadonlySet<string>): string[] {
    const names = (j: any) => [j?.account, ...(j?.accounts ?? [])].filter(Boolean).map((a: string) => a.toLowerCase());
    const mine = (j: any) => j?.autopilot === side;
    const hard = new Set(jobs.filter(j => !mine(j) && (j?.enabled !== false || !j?.script)).flatMap(names));
    const optIn = new Set(jobs.filter(mine).flatMap(names)), named = new Set(jobs.flatMap(names));
    return listed.filter(n => { const k = n.toLowerCase(); return !hard.has(k) && !paused.has(k) && (optIn.has(k) || !named.has(k)); });
}

const jobNames = (j: any) => [j?.account, ...(j?.accounts ?? [])].filter(Boolean) as string[];

// Resources the jobs in the file hold against this side's planning: every enabled unmarked job, and every enabled
// marked job whose account is paused (a stop file; mergeJobs keeps that job as it is, so its pen or spot stays its own).
export function reservedResources(jobs: readonly any[], side: string, paused: ReadonlySet<string>): Record<string, number> {
    const taken: Record<string, number> = {};
    const holds = (j: any) => j?.enabled !== false && (j?.autopilot !== side || jobNames(j).some(a => paused.has(a.toLowerCase())));
    for (const j of jobs) if (holds(j)) for (const r of jobResources(j)) taken[r] = (taken[r] ?? 0) + 1;
    return taken;
}

// This side's fleet claim (fleet/claims/<side>.json on the fleet-data branch): every exclusive resource an enabled job
// of this side's own accounts holds, planner-made or hand-made, from the plan the swarm runs, when one of the job's
// accounts is `active` (scripts/fleet-sync.ts: seen in the world within CLAIM_MAX_AGE_MS). A plan with more enabled
// jobs than the swarm admits parks some for days; a parked job's spot is free for the other sides, and when the job
// does start, the planner that took the spot sees this side's claim on its next pass and moves its account. fleet-sync
// writes the claim on every sync, so it never depends on the planner running; scripts/autopilot.ts on every side
// ignores a claim older than CLAIM_MAX_AGE_MS, so a side that stops syncing releases its spots. A resource is listed
// once for each active worker that holds it, so a host's farmers each count at a shared spot.
export const CLAIM_MAX_AGE_MS = 2 * 3600_000;
export function claimFor(jobs: readonly any[], side: string, sideOf: (account: string) => string, now = Date.now(), active: (account: string) => boolean = () => true): { side: string; at: number; resources: string[] } {
    const held = jobs.filter(j => j?.enabled !== false && jobNames(j).length > 0 && jobNames(j).every(a => sideOf(a) === side) && jobNames(j).some(active))
        .flatMap(j => jobResources(j.host && !j.orchestrate ? { ...j, accounts: jobNames(j).filter(active) } : j));
    return { side, at: now, resources: held.sort() };
}

// A recovery the coordinator runs for an account (scripts/session-check.ts, coordinatorOwner "coordinator") shadows that
// account's own job in the merged plan (packages/core/src/coordinator-jobs.ts mergeJobs). The account returns to its own
// job, so the side's claim keeps that job's places while the recovery runs; without them the other sides see the places
// free and fill them. Other coordinator work keeps the merged plan's claim.
export const RECOVERY_JOB_SCRIPT = 'scripts/session-check.ts';
export function recoveringOwnerJobs(ownerJobs: readonly any[], coordinatorJobs: readonly any[]): any[] {
    const script = (j: any) => String(j?.script ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
    const recovering = new Set(coordinatorJobs.filter(j => j?.coordinatorOwner === 'coordinator' && script(j) === RECOVERY_JOB_SCRIPT)
        .flatMap(jobNames).map(a => a.toLowerCase()));
    return ownerJobs.filter(j => j?.enabled !== false && jobNames(j).length > 0 && jobNames(j).every(a => recovering.has(a.toLowerCase())));
}

// A marked job whose account is in `keep` (an owner pause: a stop file) stays as it is, with its enabled and repeat
// settings, so lifting the pause later resumes that job instead of handing the account a fresh enabled one.
// `finished`: the accounts (lower case) whose planner job has a RESULT ok since its assignment (finishedTrainers). A planner job that a
// coordinator hold or a running buy keeps cannot be replaced by this pass; if it repeats and has finished, it stops repeating, so the
// swarm does not log the account in again every few seconds for a result that is already in (live: Pocketpython, 146 results of
// ticks=10 from `stop=stock-target targetMet=1`). The job stays as a record, and the pass that frees the account replaces it.
export function mergeJobs(jobs: readonly any[], side: string, out: readonly Assignment[], keep: ReadonlySet<string> = new Set(), finished: ReadonlySet<string> = new Set()): { jobs: any[]; fresh: string[] } {
    const mine = (j: any) => j?.autopilot === side, kept = (j: any) => [j?.account, ...(j?.accounts ?? [])].some((a: string) => a && keep.has(a.toLowerCase()));
    const done = (j: any) => mine(j) && j.enabled !== false && j.repeat === true && typeof j.account === 'string' && finished.has(j.account.toLowerCase());
    const next = jobs.filter(j => !mine(j) || kept(j)).map(j => done(j) ? { ...j, repeat: false } : j), fresh: string[] = [];
    for (const x of out) {
        if (!x.template) continue;
        // A job keeps its run only while it still runs its template (script, args and env, as the swarm signs a mission):
        // a hand edit, or a template changed in code, gets a fresh job.
        const prior = jobs.find(j => mine(j) && j.account === x.account && j.template === x.template!.id);
        if (prior && missionSignature(prior) === missionSignature(jobFor(x, side))) { next.push(prior); continue; }
        fresh.push(x.account);
        // An owner pause belongs to the account: a new template keeps it disabled and keeps its repeat policy.
        const paused = jobs.find(j => mine(j) && j.account === x.account && j.enabled === false);
        next.push(paused ? { ...jobFor(x, side), enabled: false, repeat: paused.repeat } : jobFor(x, side));
    }
    return { jobs: next, fresh };
}
