// Swarm controller: one place that decides which live account runs what. Reads swarm.json (the owner's jobs) and
// .practice/coordinator/jobs.json (the coordinator's jobs) every 2 s as one plan (edits apply live), starts each
// enabled job under packages/practice/src/supervise.ts, and writes .practice/swarm-state.json for the dashboard. Admission counts managed and fresh external live accounts against maxBots. Each new account
// reserves 1 GiB for 30 s; projected free RAM must retain max(FREE_FLOOR_GB, minFreeGB), and FREE_FLOOR_GB is 4 GiB. It never starts an account whose status file changed in the
// last 30 s and that it did not start itself: a second login kicks the first session.
// Successful jobs restart with "repeat": true or a changed work revision. Death, no-progress and exhausted retries stay blocked.
// A local swarm-repair.json request {account, endedAt, server, proof} clears only that reviewed failure, after a fresh
// read of its exact logout proof. Active accounts, newer ends and unconfirmed logout are refused. A cleared persistent
// failure stays in swarm-script-holds.json: that script stays blocked for the account until same-script qualification.
// Disabling a job, or .practice/stop-swarm, writes the account's stop file; the bot finishes its current step and logs out.
// Host jobs: {"accounts": [...], "script": ..., "host": true} run all accounts in one process
// (packages/core/src/host.ts, about 140 MB per bot instead of about 550 MB, research/bot-host.md) under
// packages/practice/src/supervise-host.ts. The rules apply per account: the external guard and stop files per
// account, and an account whose RESULT says died is never started again. A host counts as its N bots for maxBots.
// "envByAccount": {"<account>": {"KEY": "value"}} gives one hosted account its own variables on top of "env". A host
// job whose script is scripts/chain.ts runs its "args" as chain steps inside the host, one chain per account.
// Usage: DEMO_OK=1 bun scripts/swarm.ts [swarm.json]
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync, createWriteStream } from 'node:fs';
import { spawn as spawnChild } from 'node:child_process';
import { join, resolve } from 'node:path';
import { freemem } from 'node:os';
import { renameRetry } from '../packages/core/src/status';
import { payoutWaiting, type DemandNear } from '../packages/core/src/bank-demand';
import { ownedAccounts } from '../packages/core/src/tradeguard';
import { courierDeliveryWaiting } from './courier-cargo';
import { deliveryResume, foodDeficit, selectFoodSource } from './courier-route';
import {assertWorkerRelease,capabilityRevision,workerEntries} from '../packages/core/src/worker-release';
import {withSessionAdmission,missionSignature as sharedMissionSignature,successfulEnd,BOOTSTRAP_STATUS_AGE_MS} from '../packages/core/src/session-admission';
import {assertNoRecoveryLease,heldRecoveryOwners,releaseExpiredRecoveryLeases} from '../packages/core/src/session-recovery-permit';
import {createRecoveryDispatch} from '../packages/core/src/session-recovery-dispatch';
import { createHash } from 'node:crypto';
import { jobLogStart } from '../packages/core/src/job-log';
import { laterProcessHolds, PID_START_SLACK_MS, processStartTimes } from '../packages/practice/src/proc';
import { readLogoutProof, listAttempts, verifyLegacyLogout, type LegacyLogoutClaim, type LegacyLogoutProof, type LogoutProof } from '../packages/core/src/session-lifecycle';
import { FREE_FLOOR_GB } from '../packages/core/src/memory';
import { mergedPlan, readCoordinatorJobs, emptyCoordinatorJobs } from '../packages/core/src/coordinator-jobs';
import { loadOwners, mySide, sideOf, type Owner } from '../packages/core/src/fleet';
import { acquireFleetLease, FLEET_LEASE_RENEW_MS, FLEET_LEASE_RETRY_MS } from '../packages/core/src/fleet-lease';

export type Job = { autopilot?: string; template?: string; account?: string; accounts?: string[]; host?: boolean; orchestrate?:boolean; args?:string[]; maxRestarts?:number; script: string; role?: string; goal?: string; env?: Record<string, string>; envByAccount?: Record<string, Record<string, string>>; enabled: boolean; repeat?: boolean; note?: string; whenCargoFrom?: string[]; demandNear?: {x:number;z:number;radius:number};whenFoodLowFrom?:string[];foodLowBelow?:number;foodSourceAccount?:string;foodSourceAccounts?:string[];sourceFoodMinimum?:number };
type Plan = { maxBots: number; minFreeGB: number; jobs: Job[] };
// A run is a detached supervisor process: it outlives this controller, and a restarted controller adopts it from
// .practice/swarm-runs.json. Its output goes straight to its log file, which the controller follows from `offset`.
type Run = { pid: number; started: number; accounts: string[]; revision: string; host?: boolean; log: string; offset: number };
export type SavedRun = Run & { key: string };
export type ParsedJob = { key: string; accounts: string[]; host: boolean; job: Job };

// The system gives the process id of an ended supervisor to a later process, so a process that answers the id is the
// run's supervisor only when it started before the run record (laterProcessHolds). The supervisor starts before
// `started` is taken. `starts` is one read of the process table (processStartTimes): null, or an id it does not list,
// proves nothing and leaves the signal check to decide.
export { PID_START_SLACK_MS };
export function adoptedRunAlive(run: { pid: number; started: number }, alive: (pid: number) => boolean, starts: ReadonlyMap<number, number> | null): boolean {
    return alive(run.pid) && !laterProcessHolds(run.pid, run.started, starts);
}

const ACCOUNT = /^[A-Za-z0-9_ -]{1,12}$/;
const START_BUDGET_GB = 1;
const START_RESERVE_MS = 30_000;

// Count evidence of active live sessions across the whole status directory, not
// only accounts already listed in the plan. Managed sessions are counted elsewhere.
export function activeExternalLive(statuses: readonly any[], managed: readonly string[], now: number): string[] {
    const ours = new Set(managed.map(a => a.toLowerCase()));
    const active = new Map<string, string>();
    for (const s of statuses) {
        if (!s || typeof s.name !== 'string' || !ACCOUNT.test(s.name) || s.server !== 'rs-sdk-demo.fly.dev'
            || !Number.isFinite(s.at) || now - s.at < 0 || now - s.at >= 30_000 || s.result) continue;
        const key = s.name.toLowerCase();
        if (!ours.has(key) && !active.has(key)) active.set(key, s.name);
    }
    return [...active.values()];
}

// Incoming cargo keeps its explicit whitelist. Payout recipients are any live,
// authenticated locally owned accounts; hasPayout still checks the exact fresh
// request, identity, server and bank radius before this can wake a banker.
export function ownedPayoutWaiting(statuses: readonly any[], near?: DemandNear,
    owned: ReadonlySet<string> = ownedAccounts('rs-sdk-demo.fly.dev'),
    check: typeof payoutWaiting = payoutWaiting, now = Date.now()): boolean {
    const names = activeExternalLive(statuses, [], now).filter(name => owned.has(name.toLowerCase()));
    return names.length > 0 && check(names, near);
}

// Food-courier admission only. Unknown bank snapshots are not an empty food buffer.
export function foodSupplyDemand(job:Job,statuses:readonly any[],owned:ReadonlySet<string>=ownedAccounts('rs-sdk-demo.fly.dev'),now=Date.now()):boolean{
    if(job.script.replace(/\\/g,'/').replace(/^\.\//,'')!=='scripts/foodcourier.ts'||!Array.isArray(job.whenFoodLowFrom)||job.whenFoodLowFrom.length===0)return false;
    const below=job.foodLowBelow??80,minimum=job.sourceFoodMinimum??100;
    const sources=job.foodSourceAccounts??(job.foodSourceAccount?[job.foodSourceAccount]:[]);
    if(!Number.isSafeInteger(below)||below<1||!Number.isSafeInteger(minimum)||minimum<1||!Array.isArray(sources)||!sources.length
        ||sources.some(n=>typeof n!=='string'||!ACCOUNT.test(n)||!owned.has(n.toLowerCase())))return false;
    const validRows=(rows:any)=>Array.isArray(rows)&&rows.every(i=>Number.isSafeInteger(i?.id)&&i.id>=0&&Number.isSafeInteger(i.count)&&i.count>0);
    const courier=typeof job.account==='string'&&owned.has(job.account.toLowerCase())?statuses.find(s=>typeof s?.name==='string'&&s.name.toLowerCase()===job.account!.toLowerCase()&&s.server==='rs-sdk-demo.fly.dev'):undefined;
    const held=courier&&Number.isFinite(courier.at)&&courier.at>0&&courier.at<=now&&validRows(courier.inventory)
        ?courier.inventory.reduce((n:number,i:any)=>n+([330,334,380].includes(i.id)?i.count:0),0):0;
    const resume=!!deliveryResume(courier?.pos?{worldX:courier.pos.x,worldZ:courier.pos.z,level:courier.pos.level}:undefined,held,job.whenFoodLowFrom.length);
    if(!resume&&!selectFoodSource(sources,statuses,owned,now,minimum))return false;
    return job.whenFoodLowFrom.some(name=>{
        if(typeof name!=='string'||!ACCOUNT.test(name)||!owned.has(name.toLowerCase()))return false;
        const farm=statuses.find(s=>typeof s?.name==='string'&&s.name.toLowerCase()===name.toLowerCase()&&s.server==='rs-sdk-demo.fly.dev');
        const deficit = foodDeficit(name, farm, now, below);
        return deficit !== undefined && deficit > 0;
    });
}

export function pendingStartupCount(runs: readonly { started: number; accounts: readonly string[]; host?: boolean }[], now: number): number {
    let pending = 0;
    const seen = new Set<string>();
    for (const r of runs) {
        if (now - r.started >= 0 && now - r.started < START_RESERVE_MS) {
            if (r.host) pending += 1;
            else for (const a of r.accounts) if (!seen.has(a.toLowerCase())) { seen.add(a.toLowerCase()); pending += 1; }
        }
    }
    return pending;
}

// A host or an orchestrate job is one process, whatever number of accounts it holds: it needs one startup heap.
export function startReserve(p: { host: boolean; job: Job }, accounts: number): number { return p.host || p.job.orchestrate ? 1 : accounts; }

export function admissionDecision(v: { running: number; external: number; starting: number; startingReserve?: number; pending: number; freeGB: number; minFreeGB: number; maxBots: number }) {
    const floorGB = Math.max(FREE_FLOOR_GB, v.minFreeGB);
    const reserveGB = START_BUDGET_GB * (v.pending + (v.startingReserve ?? v.starting));
    const projectedFreeGB = v.freeGB - reserveGB;
    const reason = Object.values(v).some(n => !Number.isFinite(n) || n < 0) ? 'invalid'
        : v.running + v.external + v.starting > v.maxBots ? 'maxBots'
        : projectedFreeGB < floorGB ? 'memory' : null;
    return { allowed: reason === null, reason, floorGB, reserveGB, projectedFreeGB };
}
export function admitRecovery(v:{account:string;active:readonly string[];running:number;external:number;pending:number;freeGB:number;minFreeGB:number;maxBots:number},release:()=>void=()=>{assertWorkerRelease();}){
 if(v.active.some(a=>a.toLowerCase()===v.account.toLowerCase()))throw Error('recovery account still active');
 const decision=admissionDecision({running:v.running,external:v.external,pending:v.pending,starting:1,startingReserve:1,freeGB:v.freeGB,minFreeGB:v.minFreeGB,maxBots:v.maxBots});
 if(!decision.allowed)throw Error('recovery admission waiting: '+decision.reason);
 release();
}

// An open recovery keeps one bot slot. Jobs get a free slot in plan order, the owner's jobs first, and a recovery is
// in no job until its cleanup is done, so without the hold a waiting job takes each slot that frees. The recovery is
// open while the coordinator holds the repair lease (.practice/swarm-repair.json.lease: from before its admission
// check to the report of the session cleanup, and for the end repair) and while the cleanup child runs. The hold
// stays RECOVERY_SLOT_HOLD_MS after the last of those, which covers the install of the recovered account's job, and
// it ends when that job starts. The cleanup child counts in the running bots, so it uses the slot while it runs. The
// job of the recovered account takes the slot. Each other job counts one more starting bot against maxBots; the
// memory reserve does not change. RECOVERY_SLOT_WAIT_MS is the longest time the coordinator waits for the slot. A
// controller rollout holds the same lease, so a new controller holds one slot for its first RECOVERY_SLOT_HOLD_MS.
export const RECOVERY_SLOT_HOLD_MS = 30_000;
export const RECOVERY_SLOT_WAIT_MS = 600_000;
// A lease file older than the longest recovery request is one that a dead process left: it holds no slot.
export const RECOVERY_LEASE_MAX_MS = RECOVERY_SLOT_WAIT_MS + 300_000;
export type RecoverySlot = { until: number; account?: string };
export function recoveryLeaseHeld(file: string, now: number): boolean {
    try { return now - statSync(file).mtimeMs < RECOVERY_LEASE_MAX_MS; } catch { return false; }
}
export function recoverySlot(slot: RecoverySlot, v: { leaseHeld: boolean; recovering?: string; started: readonly string[]; now: number }): RecoverySlot {
    const prior = v.recovering ?? slot.account;
    const jobStarted = prior !== undefined && !v.recovering && v.started.some(a => a.toLowerCase() === prior.toLowerCase());
    if (v.leaseHeld || v.recovering) return { until: v.now + RECOVERY_SLOT_HOLD_MS, ...(prior !== undefined && !jobStarted ? { account: prior } : {}) };
    return slot.until > v.now && !jobStarted ? slot : { until: 0 };
}
export function recoverySlotReserve(slot: RecoverySlot, v: { recovering: boolean; accounts: readonly string[]; now: number }): number {
    if (v.recovering || slot.until <= v.now) return 0;
    return slot.account !== undefined && v.accounts.some(a => a.toLowerCase() === slot.account!.toLowerCase()) ? 0 : 1;
}

// An entry with an account and no script is a reservation (the main account waits for its own run): the swarm never
// starts it and reports it as "reserved", not as a bad job.
export function isReservation(job: Job): boolean {
    return !!job && typeof job.account === 'string' && !job.accounts && !job.script;
}

// The first account of a job that another fleet side owns (fleet/owners.json): this controller never starts it, so one
// swarm.json can carry every side's jobs.
export function otherSideAccount(accounts: readonly string[], side: string, owners: ReadonlyMap<string, Owner>): { account: string; side: string } | undefined {
    for (const a of accounts) { const s = sideOf(a, owners as Map<string, Owner>); if (s !== side) return { account: a, side: s }; }
    return undefined;
}

// A host job lists its accounts; a single job names one. Returns an error string for a job the swarm must skip.
export function parseJob(job: Job): ParsedJob | { error: string } {
    if (!job || typeof job.script !== 'string' || !job.script) return { error: 'no script' };
    if(job.orchestrate!==undefined&&typeof job.orchestrate!=='boolean')return {error:'bad orchestrate mode'};
    if(job.args!==undefined&&(!Array.isArray(job.args)||job.args.some(a=>typeof a!=='string')))return {error:'args must be strings'};
    if(job.maxRestarts!==undefined&&(!Number.isSafeInteger(job.maxRestarts)||job.maxRestarts<0))return {error:'bad maxRestarts'};
    if(job.orchestrate){
        if(job.host)return {error:'orchestrate cannot use host mode'};
        if(job.account!==undefined)return {error:'orchestrator has both account and accounts'};
        const list=job.accounts;
        if(!Array.isArray(list)||list.length<2)return {error:'orchestrator needs at least two accounts'};
        if(list.some(a=>typeof a!=='string'||!ACCOUNT.test(a)))return {error:'bad account name in accounts'};
        if(new Set(list.map(a=>a.toLowerCase())).size!==list.length)return {error:'account listed twice'};
        return {key:`order:${list.join('+')}`,accounts:[...list],host:false,job};
    }
    if (job.host) {
        const list = job.accounts;
        if (!Array.isArray(list) || list.length === 0) return { error: 'host job needs a non-empty "accounts" list' };
        if (job.account) return { error: 'host job has both "account" and "accounts"' };
        if (list.some(a => typeof a !== 'string' || !ACCOUNT.test(a))) return { error: 'bad account name in "accounts"' };
        if (new Set(list.map(a => a.toLowerCase())).size !== list.length) return { error: 'account listed twice' };
        // envByAccount: one env map per listed account, on top of the job's env (host.ts --env).
        const per = job.envByAccount;
        if (per !== undefined) {
            if (typeof per !== 'object' || per === null || Array.isArray(per)) return { error: '"envByAccount" must map an account to its env' };
            for (const [a, e] of Object.entries(per)) {
                if (!list.includes(a)) return { error: `envByAccount names ${a}, which is not in "accounts"` };
                if (typeof e !== 'object' || e === null || Array.isArray(e) || Object.values(e).some(v => typeof v !== 'string')) return { error: `envByAccount for ${a} must map KEY to a string` };
            }
        }
        return { key: `host:${list.join('+')}`, accounts: [...list], host: true, job };
    }
    if (job.accounts) return { error: '"accounts" needs "host": true' };
    if (job.envByAccount) return { error: '"envByAccount" needs "host": true' };
    if (typeof job.account !== 'string' || !ACCOUNT.test(job.account)) return { error: 'no account' };
    return { key: job.account, accounts: [job.account], host: false, job };
}

export function supervisorCommand(parsed:ParsedJob,accounts:string[]):string[]{
    const job=parsed.job,maxRestarts=String(job.maxRestarts??(job.orchestrate?0:20));
    // A host job: one --arg per script argument (values may hold commas) and one --env per account variable.
    return parsed.host?['bun','packages/practice/src/supervise-host.ts',job.script,maxRestarts,...accounts,...(job.args??[]).flatMap(a=>['--arg',a]),
            ...accounts.flatMap(a=>Object.entries(job.envByAccount?.[a]??{}).flatMap(([k,v])=>['--env',a,`${k}=${v}`]))]
        :['bun','packages/practice/src/supervise.ts',accounts[0]!,job.script,maxRestarts,...(job.orchestrate?accounts.slice(1):[]),...(job.args??[])];
}

// A shared orchestrator cannot log in a ready subset while another participant is paused or active elsewhere.
export function completeJobCandidates(parsed:ParsedJob,selection:{start:string[];blocked:Record<string,string>}):{start:string[];blocked:Record<string,string>}{
    if(!parsed.job.orchestrate||selection.start.length===parsed.accounts.length)return selection;
    const blocked={...selection.blocked};
    for(const name of selection.start)blocked[name]='waiting: all orchestrator participants required';
    return {start:[],blocked};
}

// Host account order is part of the invocation (the first account may lead).
// Display edits, enabling and repeat policy do not turn completed work into new work.
export function missionSignature(job:Job):string{return sharedMissionSignature(job);}

// A run that another planned job of the same account started (its mission signature is the run's revision). A job that
// is off, or whose mission changed, must not stop or re-plan a run it does not own: a coordinator job left off beside a
// standing job would otherwise stop that standing bot on every tick.
export function foreignRun(planned: readonly ParsedJob[], p: ParsedJob, run: { revision: string }): boolean {
    if (run.revision === missionSignature(p.job)) return false;
    return planned.some(q => q !== p && missionSignature(q.job) === run.revision);
}
export function overlappingRun<T extends { accounts: readonly string[] }>(runs: Iterable<T>, accounts: readonly string[]): T | undefined {
    const names = new Set(accounts.map(a => a.toLowerCase()));
    return [...runs].find(r => r.accounts.some(a => names.has(a.toLowerCase())));
}

export type EndRecord = { at: number; reason: string; revision?: string };
// These failures need a fix before another login. "repeat" does not clear them.
export function persistentEnd(reason: string): boolean {
    return /^(?:died|blocked|gave-up)(?:\b|$)/.test(reason);
}
// The stop files this controller writes itself: a run whose job left the plan, stop-swarm, a job turned off, a lost
// controller lease. They are not an owner's pause: the planner (scripts/autopilot.ts) plans such an account again and
// removes the file with the job that replaces it. A stop file with any other text is the owner's and holds the account.
// `lease` logs the runs out when a renewal fails; the lease fence, not the file, keeps them out until a controller
// holds the lease again (live claude-cloud: five accounts stayed down behind the file after the next swarm took it).
export const SWARM_STOP = { removed: 'swarm plan removed or stopped', all: 'swarm stopped', job: 'swarm', recovery: 'swarm recovery stopped', inherited: 'inherited recovery stopped',
    lease: 'fleet controller lease unavailable' } as const;
export function swarmWroteStop(text: string | undefined): boolean {
    return text !== undefined && (Object.values(SWARM_STOP) as string[]).includes(text.trim());
}
export function writeSwarmStop(file: string, reason: string): void {
    try { writeFileSync(file, reason, { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}
export function clearSwarmStop(file: string): boolean {
    let text: string;
    try { text = readFileSync(file, 'utf8'); } catch { return false; }
    if (!swarmWroteStop(text)) return false;
    rmSync(file, { force: true });
    return true;
}
// The ends a standing job retries by itself once the account is offline: a block or give-up, a stop that a stop file
// caused (an owner's file still blocks the start, the controller's own is gone), or a process the controller lost
// track of (its own restart). A supervisor ends `stopped` for a stop file or for `RESULT fail no food`
// (packages/practice/src/supervise.ts). Only a resupply repairs no food, so that stop is not retried; every other
// stopped end with a result is the stop file's. A worker words its stop its own way (trooper and cow mode end
// `fail mode=giant ... stop=stop-file`), so the rule does not look for one wording: live claude-cloud, five accounts
// vacated for a fleet order stood 24 to 72 minutes with an enabled job. A death waits for a person; done is not a pause.
export function standingRetryable(reason: string, result?: string): boolean {
    if (/^stopped after \d+ runs$/.test(reason)) return typeof result === 'string' && !/^(?:RESULT )?fail no food\b/.test(result);
    return /^(?:blocked|gave-up)\b|^exit unknown$/.test(reason);
}
export function endedForGood(end: { reason: string } | undefined, repeat: boolean | undefined): boolean {
    return !!end && (!repeat || !successfulEnd(end.reason));
}
export function loadEnded(file: string): Map<string, EndRecord> {
    if (!existsSync(file)) return new Map();
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid swarm end-state object');
    const entries = Object.entries(raw) as [string, EndRecord][];
    const seen = new Set<string>();
    for (const [name, end] of entries) {
        if (!ACCOUNT.test(name) || seen.has(name.toLowerCase()) || !end || !Number.isFinite(end.at) || end.at < 0
            || typeof end.reason !== 'string' || !end.reason.trim() || (end.revision !== undefined && typeof end.revision !== 'string'))
            throw new Error('invalid swarm end-state record');
        seen.add(name.toLowerCase());
    }
    return new Map(entries);
}
// Repair request contract (the router integrator writes this to .practice/swarm-repair.json):
//   {account, endedAt, server:'rs-sdk-demo.fly.dev', proof:{kind:'producer', attemptId}}
//   {account, endedAt, server, proof:LegacyLogoutClaim}   labelled legacy bootstrap, only while no producer attempt exists
//   {kind:'script-qualified', account, script, holdAt, server, proof, qualification:{receiptPath, receiptSha256, at}}
// The proof is re-read from session-lifecycle.ts immediately before any mutation. Unknown, crossed, stale or
// superseded evidence refuses. Clearing a persistent failure keeps its script as a durable failed-script hold.
export const LIVE_SERVER = 'rs-sdk-demo.fly.dev';
export type ProducerProofRef = { kind: 'producer'; attemptId: string };
export type EndRepairRequest = { account: string; endedAt: number; server: string; proof: ProducerProofRef | LegacyLogoutClaim };
export type ScriptQualificationRequest = { kind: 'script-qualified'; account: string; script: string; holdAt: number; server: string; proof: ProducerProofRef | LegacyLogoutClaim;
    qualification: { receiptPath: string; receiptSha256: string; at: number } };
export type ScriptHold = { account: string; script: string; at: number; reason: string; revision?: string; heldAt: number;
    qualified?: { at: number; receiptPath: string; receiptSha256: string; recordedAt: number } };
export type RepairProofs = { readProof: (account: string, server: string) => LogoutProof; verifyLegacy: (claim: unknown) => LegacyLogoutProof; now?: () => number;
    // The account's current status file, if any. A session it shows after the logout, outside the receipts, refuses.
    status?: (account: string) => { server?: unknown; started?: unknown; sessionAttemptId?: unknown } | undefined };
export const defaultRepairProofs: RepairProofs = { readProof: (a, s) => {if(ACCOUNT.test(a))assertNoRecoveryLease(a,resolve(import.meta.dir,'..'));return readLogoutProof(a,s);}, verifyLegacy: c => verifyLegacyLogout(c) };

export const scriptKey = (script: string) => script.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
export function failedScript(end: EndRecord): string | null {
    try { const r = JSON.parse(end.revision ?? ''); return Array.isArray(r) && typeof r[0] === 'string' && r[0].trim() ? scriptKey(r[0]) : null; } catch { return null; }
}
// The exact current logout proof for one account and server, or the refusal reason.
export function currentLogout(request: any, proofs: RepairProofs): { ok: true; label: string; attemptId?: string } | { ok: false; reason: string } {
    if (request.server !== LIVE_SERVER) return { ok: false, reason: 'repair server is not the live server' };
    const p = request.proof;
    if (p?.kind === 'producer') {
        if (typeof p.attemptId !== 'string') return { ok: false, reason: 'invalid producer proof' };
        let now:LogoutProof;try{now=proofs.readProof(request.account, request.server);}catch{return {ok:false,reason:'logout proof unavailable or recovery lease held'};}
        if (now.state === 'none') return { ok: false, reason: 'no producer logout proof' };
        if (now.state === 'invalid') return { ok: false, reason: `invalid logout proof: ${now.reason}` };
        if (now.attemptId !== p.attemptId) return { ok: false, reason: 'logout proof superseded by a newer attempt' };
        if (now.state !== 'confirmed') return { ok: false, reason: `logout not confirmed: ${now.reason}` };
        if (now.account.toLowerCase() !== request.account.toLowerCase() || now.server !== request.server) return { ok: false, reason: 'logout proof identity mismatch' };
        let st: ReturnType<NonNullable<RepairProofs['status']>>;
        try { st = proofs.status?.(request.account); } catch { return { ok: false, reason: 'status unreadable' }; }
        if (st && st.server === request.server && ((Number.isFinite(st.started) && (st.started as number) > now.loggedOutAt)
            || (typeof st.sessionAttemptId === 'string' && st.sessionAttemptId !== now.attemptId && !(Number.isFinite(st.started) && (st.started as number) <= now.loggedOutAt))))
            return { ok: false, reason: 'status shows a session the logout proof does not cover' };
        return { ok: true, label: `producer ${now.attemptId}`, attemptId: now.attemptId };
    }
    if (p?.kind === 'legacy-logout') {
        if (typeof p.account !== 'string' || p.account.toLowerCase() !== request.account.toLowerCase() || p.server !== request.server) return { ok: false, reason: 'legacy proof identity mismatch' };
        const legacy = proofs.verifyLegacy(p);
        return legacy.state === 'legacy-confirmed' ? { ok: true, label: `legacy ${legacy.statusSha256}` } : { ok: false, reason: `legacy proof refused: ${legacy.reason}` };
    }
    // An end from before producer receipts: the session admission bootstrap rule (session-admission.ts) — a finished
    // status on the live server, unchanged for BOOTSTRAP_STATUS_AGE_MS — shows the account is offline.
    if (p?.kind === 'settled-status') {
        let st: any;
        try { st = proofs.status?.(request.account); } catch { return { ok: false, reason: 'status unreadable' }; }
        const now = proofs.now?.() ?? Date.now();
        if (!st || st.server !== request.server || typeof st.result !== 'string' || !st.result) return { ok: false, reason: 'status shows no finished session' };
        if (!Number.isFinite(st.at) || now - st.at < BOOTSTRAP_STATUS_AGE_MS) return { ok: false, reason: 'status changed in the last 15 minutes' };
        return { ok: true, label: `settled status at ${st.at}` };
    }
    return { ok: false, reason: 'missing logout proof' };
}
// The controller remains the only end-state writer. An explicit repair names one exact old failure and its
// current logout proof. A persistent failure moves into the failed-script history; it is not deleted.
export function applyEndRepair(request: any, ended: Map<string, EndRecord>, active: readonly string[], proofs: RepairProofs, holds: ScriptHold[] = []) {
    if (!request || typeof request.account !== 'string' || !ACCOUNT.test(request.account)
        || !Number.isFinite(request.endedAt) || request.endedAt < 0) return { changed: false, reason: 'invalid repair request' };
    const key = request.account.toLowerCase();
    if (active.some(a => a.toLowerCase() === key)) return { changed: false, reason: 'account still active' };
    const entry = [...ended].find(([name]) => name.toLowerCase() === key);
    if (!entry) return { changed: false, reason: 'already clear' };
    if (entry[1].at !== request.endedAt) return { changed: false, reason: 'end record changed' };
    if (successfulEnd(entry[1].reason)) return { changed: false, reason: 'completed work needs a new mission' };
    const script = failedScript(entry[1]);
    // Only a death keeps its script held: gave-up and blocked mean no progress, and the repair is the fix.
    const dead = /^died\b/.test(entry[1].reason);
    if (dead && !script) return { changed: false, reason: 'failed script unknown; hold cannot be kept' };
    const logout = currentLogout(request, proofs);
    if (!logout.ok) return { changed: false, reason: logout.reason };
    if (dead) holds.push({ account: entry[0], script: script!, at: entry[1].at, reason: entry[1].reason,
        ...(entry[1].revision !== undefined ? { revision: entry[1].revision } : {}), heldAt: (proofs.now ?? Date.now)() });
    ended.delete(entry[0]);
    return { changed: true, reason: `repaired failure cleared (${logout.label})` };
}
// The main and fresh-clock accounts stay offline; the swarm never records an end for them.
const PROTECTED_ACCOUNTS = ['haggis', 'shaftshooter', 'polevaulter', 'afknight'];
// Account names (as their latest attempt spells them) of every live lifecycle folder, so an account that has no
// plan job is still found. An unreadable folder is skipped.
export function lifecycleAccounts(dir: string): string[] {
    let names: string[]; try { names = readdirSync(dir); } catch { return []; }
    return names.flatMap(n => { try { const a = JSON.parse(readFileSync(join(dir, n, 'latest.json'), 'utf8')).account; return typeof a === 'string' && ACCOUNT.test(a) ? [a] : []; } catch { return []; } });
}
// A session whose owner died with no end line (a killed worker, or a swarm that died with its children) leaves a
// held attempt, so no repair can name it until the owner is gone and its end is recorded.
// The owner wrote the receipt, so a process that holds the owner id and started after `createdAt` is a later process
// and the owner is gone (laterProcessHolds). `starts` is called one time at most, with the owner ids that answer a
// signal and whose end this scan can record.
export function orphanedSessionEnds(accounts: readonly string[], ended: ReadonlyMap<string, EndRecord>, busy: readonly string[],
    proof: (a: string) => LogoutProof, producer: (a: string, attemptId: string) => { pid: number; createdAt: number; updatedAt: number } | undefined, alive: (pid: number) => boolean,
    starts: (pids: readonly number[]) => ReadonlyMap<number, number> | null = () => null): [string, string][] {
    const found: { end: [string, string]; pid: number; createdAt: number; answers: boolean }[] = [], seen = new Set<string>();
    for (const a of accounts) {
        const key = a.toLowerCase();
        if (PROTECTED_ACCOUNTS.includes(key)) continue;
        if (seen.has(key) || busy.some(b => b.toLowerCase() === key)) continue;
        seen.add(key);
        let p: LogoutProof; try { p = proof(a); } catch { continue; }
        if (p.state !== 'held') continue;
        const receipt = producer(a, p.attemptId);
        if (!receipt || !Number.isSafeInteger(receipt.pid) || receipt.pid < 1 || !Number.isFinite(receipt.createdAt) || !Number.isFinite(receipt.updatedAt)) continue;
        const prior = [...ended].find(([name]) => name.toLowerCase() === key);
        // An older orphan end yields to a later update. A successful end yields to an attempt that started after it: that
        // end cannot describe the attempt and holds nothing. Every other end stays, because a repair reads its reason.
        const orphan = prior?.[1].reason.startsWith('exit orphaned: attempt ');
        if (prior && !(orphan ? receipt.updatedAt > prior[1].at : successfulEnd(prior[1].reason) && receipt.createdAt > prior[1].at)) continue;
        found.push({ end: [prior?.[0] ?? a, `exit orphaned: attempt ${p.attemptId} owner ${receipt.pid} gone`], pid: receipt.pid, createdAt: receipt.createdAt, answers: alive(receipt.pid) });
    }
    const answering = found.filter(f => f.answers).map(f => f.pid), table = answering.length ? starts(answering) : null;
    return found.filter(f => !f.answers || laterProcessHolds(f.pid, f.createdAt, table)).map(f => f.end);
}
// Retained caller-receipt format is diagnostic only. There is no producer-bound work-result
// contract yet, so a fishing/recovery logout cannot qualify an old combat script.
export function applyScriptQualification(request: any, holds: ScriptHold[], active: readonly string[], proofs: RepairProofs) {
    if (!request || request.kind !== 'script-qualified' || typeof request.account !== 'string' || !ACCOUNT.test(request.account)
        || typeof request.script !== 'string' || !Number.isFinite(request.holdAt) || !request.qualification) return { changed: false, reason: 'invalid qualification request' };
    const key = request.account.toLowerCase(), script = scriptKey(request.script), q = request.qualification;
    if (active.some(a => a.toLowerCase() === key)) return { changed: false, reason: 'account still active' };
    const hold = holds.find(h => h.account.toLowerCase() === key && scriptKey(h.script) === script && h.at === request.holdAt);
    if (!hold) return { changed: false, reason: 'no matching open hold' };
    if (typeof q.receiptPath !== 'string' || !/^[0-9a-f]{64}$/.test(q.receiptSha256 ?? '') || !Number.isFinite(q.at) || q.at <= hold.at) return { changed: false, reason: 'qualification is not newer than the failure' };
    let receipt: any;
    try {
        const raw = readFileSync(q.receiptPath);
        if (createHash('sha256').update(raw).digest('hex') !== q.receiptSha256) return { changed: false, reason: 'qualification receipt hash changed' };
        receipt = JSON.parse(raw.toString('utf8'));
    } catch { return { changed: false, reason: 'qualification receipt missing or malformed' }; }
    if (receipt?.ok !== true || typeof receipt.script !== 'string' || scriptKey(receipt.script) !== script || receipt.at !== q.at
        || typeof receipt.account !== 'string' || receipt.account.toLowerCase() !== key) return { changed: false, reason: 'qualification receipt is not a same-script success for this account' };
    // The qualifying run must be the live producer session whose logout is the current proof.
    if (request.proof?.kind !== 'producer' || receipt.attemptId !== request.proof.attemptId) return { changed: false, reason: 'qualification is not bound to the current producer logout' };
    const logout = currentLogout(request, proofs);
    if (!logout.ok) return { changed: false, reason: logout.reason };
    return { changed:false,reason:'script qualification unsupported: caller receipt has no producer-bound work result' };
}
export function openHold(holds: readonly ScriptHold[], account: string, script: string): ScriptHold | undefined {
    const key = account.toLowerCase(), s = scriptKey(script);
    // Old optional qualified fields are preserved as history, but cannot close a hold:
    // the former caller-receipt contract never proved work by this script.
    return holds.find(h => h.account.toLowerCase() === key && scriptKey(h.script) === s);
}
// Admission keeps a failed script blocked for its account after a role transition, until same-script qualification.
export function holdCandidates(selection: { start: string[]; blocked: Record<string, string> }, script: string, holds: readonly ScriptHold[]) {
    const start: string[] = [], blocked = { ...selection.blocked };
    for (const a of selection.start) {
        const h = openHold(holds, a, script);
        if (h) blocked[a] = `held: failed ${h.script} (${h.reason} at ${h.at}) needs same-script qualification`; else start.push(a);
    }
    return { start, blocked };
}
export function loadHolds(file: string): ScriptHold[] {
    if (!existsSync(file)) return [];
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(raw) || !raw.every(h => h && typeof h.account === 'string' && ACCOUNT.test(h.account) && typeof h.script === 'string' && h.script
        && Number.isFinite(h.at) && typeof h.reason === 'string' && Number.isFinite(h.heldAt))) throw new Error('invalid swarm script-hold history');
    return raw;
}
export function persistHolds(file: string, holds: readonly ScriptHold[]): void {
    const temporary = `${file}.tmp-${process.pid}`;
    try { writeFileSync(temporary, JSON.stringify(holds, null, 1)); renameRetry(temporary, file); }
    catch (e) { try { rmSync(temporary, { force: true }); } catch { /* retain the original error */ } throw e; }
}
export function persistEnded(file: string, ended: ReadonlyMap<string, EndRecord>): void {
    // Keep success and its launched revision too: a bounded job must not run
    // again merely because the controller restarted. Admission still permits
    // explicit repeat or genuinely changed work, with the usual session guard.
    const temporary = `${file}.tmp-${process.pid}`;
    try {
        writeFileSync(temporary, JSON.stringify(Object.fromEntries(ended), null, 1));
        // A reader holding the file open makes Windows refuse the rename (EPERM); the controller crashed on it.
        renameRetry(temporary, file);
    } catch (e) {
        try { rmSync(temporary, { force: true }); } catch { /* retain the original error */ }
        throw e;
    }
}

// An account is enabled when any job that names it is enabled. Every job of an account reads the same flag for it, so
// an account named by one job that is off and one that is on is on, with no change to observe between the two.
export function enabledByAccount(planned: readonly ParsedJob[]): Map<string, boolean> {
    const out = new Map<string, boolean>();
    for (const p of planned) for (const a of p.accounts) { const k = a.toLowerCase(); out.set(k, (out.get(k) ?? false) || p.job.enabled === true); }
    return out;
}
export function observeEnabled(accounts: readonly string[], enabled: boolean, previous: Map<string, boolean>, pending: Set<string>): void {
    for (const a of accounts) {
        const key=a.toLowerCase();
        if (enabled && previous.get(key) === false) pending.add(key);
        if (!enabled) pending.delete(key);
        previous.set(key, enabled);
    }
}

// Consume a deliberate resume only after the old process and its output settle.
// A persistent failure needs a separate repair, and done is not a pause to clear.
export function applyResume(accounts: readonly string[], active: boolean, ended: Map<string, EndRecord>, pending: Set<string>, clearStop: (a: string) => void): boolean {
    if (active) return false;
    let changed=false;
    for (const a of accounts) {
        const key=a.toLowerCase();
        if (!pending.delete(key)) continue;
        const entry=[...ended].find(([name])=>name.toLowerCase()===key);
        if (entry && (persistentEnd(entry[1].reason) || successfulEnd(entry[1].reason))) continue;
        clearStop(a);
        if (entry) ended.delete(entry[0]);
        changed=true;
    }
    return changed;
}
export function supervisorEndLine(line: string): string | undefined {
    return line.match(/^SUPERVISE end ([\w-]+ after \d+ runs)\s*$/)?.[1];
}

// Which accounts of a job may start now, and the state of each one that may not.
export function startable(accounts: string[], repeat: boolean | undefined, ended: Map<string, { reason: string; at?: number; revision?: string }>, statusAge: (a: string) => number, statusStarted?: (a: string) => number | undefined, revision?: string, stopped?: (a: string) => boolean): { start: string[]; blocked: Record<string, string> } {
    const start: string[] = [];
    const blocked: Record<string, string> = {};
    for (const a of accounts) {
        const end = ended.get(a) ?? [...ended].find(([name]) => name.toLowerCase() === a.toLowerCase())?.[1];
        // Release only a known success from different actual work. Retain the
        // end epoch so a newer external/manual session still wins admission.
        const newMission = !!end?.revision && !!revision && end.revision !== revision
            && /^done(?: after \d+ runs)?$/.test(end.reason);
        // A refusal before any game tick (supervise isEntryRefusal) changed nothing, so a changed job may start again.
        // A release pause clears itself: a non-standing start checks the pin again, and a standing job has no pin.
        const resumable = !!end && (/^refused\b/.test(end.reason) && !!end.revision && !!revision && end.revision !== revision
            || /^release-paused\b/.test(end.reason));
        if (stopped?.(a)) blocked[a] = 'paused: stop file';
        else if (endedForGood(end, repeat) && !newMission && !resumable) blocked[a] = /^release-paused\b/.test(end!.reason) ? 'paused: worker release' : `ended: ${end!.reason}`;
        else if (statusAge(a) < 30_000) {
            // The controller records done only after its supervisor has exited.
            // Its old status need not impose a second 30 s wait, but a newer
            // manual session (or an unknown epoch) still owns the account.
            let started: number | undefined;
            try { started = statusStarted?.(a); } catch { /* unknown remains external */ }
            if (end && /^done(?: after \d+ runs)?$/.test(end.reason) && Number.isFinite(end.at)
                && Number.isFinite(started) && started! > 0 && started! <= end.at!) start.push(a);
            else blocked[a] = 'external (status fresh, not started by swarm)';
        }
        else start.push(a);
    }
    return { start, blocked };
}

// Demand may defer eligible work, never conceal a pause, failure or owner.
export function demandCandidates(selection:ReturnType<typeof startable>,waiting:()=>string|null):ReturnType<typeof startable>{
    if(!selection.start.length)return selection;
    const reason=waiting();
    return reason?{start:[],blocked:{...selection.blocked,...Object.fromEntries(selection.start.map(a=>[a,reason]))}}:selection;
}
// standing: an owner-assigned job of a script with useful live results; it runs beside coordinator tasks on an
// account no coordinator task names (the coordinator checks swarm.json before it installs a job).
export function coordinatedAdmission(job:Job,scoped:boolean):boolean{
    const j=job as Job & {coordinatorOwner?:string;standing?:boolean};
    return !scoped||j.coordinatorOwner==='coordinator'||j.standing===true;
}

if (import.meta.main) {
    const root = resolve(import.meta.dir, '..');
    const planFile = resolve(process.argv[2] ?? join(root, 'swarm.json'));
    // Windows paths compare without case: the drive letter differs between a shell's cwd and import.meta.dir.
    const rootPlan = process.platform === 'win32' ? planFile.toLowerCase() === resolve(root, 'swarm.json').toLowerCase() : planFile === resolve(root, 'swarm.json');
    const coordinatorOwner=process.argv.find(a=>a.startsWith('--coordinator='))?.slice('--coordinator='.length);
    const prac = join(root, '.practice');
    const side = mySide();
    const logDir = join(prac, 'swarm-logs');
    mkdirSync(logDir, { recursive: true });
    if (process.env.DEMO_OK !== '1') { console.log('swarm: set DEMO_OK=1 (live server)'); process.exit(2); }
    if (coordinatorOwner) {
        try { assertWorkerRelease({ ...process.env, WORKER_ENTRY: '' }, root); }
        catch (error) { console.log('swarm: ' + String(error)); process.exit(2); }
    }
    // Acquire before adopting or writing controller state. A cached fleet-data heartbeat cannot grant admission.
    let lease: ReturnType<typeof acquireFleetLease>;
    try { lease = acquireFleetLease(root, side); }
    catch (error) { console.log('SWARM ' + String(error)); process.exit(2); }
    process.env.SWARM_LEASE_HOLDER = lease.holder;
    let renewAt = performance.now() + FLEET_LEASE_RENEW_MS;
    const assertLease = () => { if (!lease.allows()) throw Error('fleet controller lease unavailable'); };

    const runs = new Map<string, Run>();
    const recoveryDispatch=createRecoveryDispatch({base:root,server:LIVE_SERVER});
    let inheritedRecoveries: ReturnType<typeof heldRecoveryOwners> = [];
    let heldSlot: RecoverySlot = { until: 0 };
    let orphanScanAt = 0;
    const leaseRefusals = new Map<string, string>();
    const previousEnabled = new Map<string, boolean>();
    const pendingResume = new Set<string>();
    // Legacy filename retains success/revision, paused/unknown and hard ends.
    // A plan disable-enable resumes only pauses; hard failures need repair.
    const deathsFile = join(prac, 'swarm-deaths.json');
    const repairFile = join(prac, 'swarm-repair.json');
    const ended = loadEnded(deathsFile);
    const holdsFile = join(prac, 'swarm-script-holds.json');
    // Holds from a gave-up or blocked end are dropped: only a death holds its script (applyEndRepair).
    const holds = loadHolds(holdsFile).filter(h => /^died\b/.test(h.reason));
    let holdsMtime = existsSync(holdsFile) ? statSync(holdsFile).mtimeMs : 0;
    const setEnded = ended.set.bind(ended);
    ended.set = (a, r) => {
        setEnded(a, r);
        persistEnded(deathsFile, ended);
        return ended;
    };
    const stopFile = (a: string) => join(prac, `stop-${a}`);
    const statusAge = (a: string) => { try { return Date.now() - statSync(join(prac, 'status', `${a}.json`)).mtimeMs; } catch { return Infinity; } };
    const statusStarted = (a: string): number | undefined => {
        try {
            const s = JSON.parse(readFileSync(join(prac, 'status', `${a}.json`), 'utf8'));
            return typeof s.name === 'string' && s.name.toLowerCase() === a.toLowerCase()
                && s.server === 'rs-sdk-demo.fly.dev' && Number.isFinite(s.started) ? s.started : undefined;
        } catch { return undefined; }
    };
    const botsRunning = () => [...runs.values()].reduce((n, r) => n + r.accounts.length, 0)+(recoveryDispatch.active?1:0)+inheritedRecoveries.length;
    const pendingCount = () => pendingStartupCount([...runs.values()], Date.now())+(recoveryDispatch.active&&Date.now()-recoveryDispatch.active.started<30000?1:0)+inheritedRecoveries.filter(r=>Date.now()-r.started<30000).length;

    const runsFile = join(prac, 'swarm-runs.json');
    // The runs with no child handle, and the start time of the process that holds each of their ids. The read starts a
    // process, so it runs at adopt time and then once a minute, never in the 2 s follow timer.
    const adopted = new Set<Run>();
    let pidStarts: ReturnType<typeof processStartTimes> = null, pidStartsAt = 0;
    const readPidStarts = () => { pidStartsAt = Date.now(); pidStarts = adopted.size ? processStartTimes([...adopted].map(r => r.pid)) : null; };
    const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } };
    const saveRuns = () => { try { const tmp = `${runsFile}.tmp-${process.pid}`; writeFileSync(tmp, JSON.stringify([...runs].map(([key, r]) => ({ key, ...r })), null, 1)); renameRetry(tmp, runsFile); } catch (e) { console.log(`SWARM runs file not saved: ${String(e)}`); } };
    // Follow a run's log from its saved offset: end lines become end records, and when the process is gone the
    // run ends with its last end line (or `exit <code>`).
    const follow = (key: string, run: Run, child?: { on(e: 'exit', f: (code: number | null) => void): unknown }) => {
        let tail = '', currentEnd: string | undefined, exitCode: number | null | undefined, done = false;
        const consume = (line: string) => {
            if (!run.host) { currentEnd = supervisorEndLine(line) ?? currentEnd; return; }
            const m = line.match(/^SUPERVISE-HOST account (.+?) ([\w-]+) after \d+ runs/);
            if (m) { ended.set(m[1]!, { at: Date.now(), reason: m[2]!, revision: run.revision }); console.log(`SWARM end ${m[1]} ${m[2]} (host)`); }
        };
        const read = () => {
            let size = 0;
            try { size = statSync(run.log).size; } catch { return; }
            if (size <= run.offset) return;
            const fd = openSync(run.log, 'r');
            try {
                const buf = Buffer.alloc(size - run.offset);
                readSync(fd, buf, 0, buf.length, run.offset);
                run.offset = size;
                tail += buf.toString('utf8');
                const lines = tail.split(/\r?\n/);
                tail = lines.pop() ?? '';
                for (const line of lines) consume(line);
            } finally { closeSync(fd); }
        };
        const finish = () => {
            if (done) return;
            done = true; clearInterval(timer);
            read(); if (tail) consume(tail);
            runs.delete(key); adopted.delete(run); saveRuns();
            const code = exitCode === undefined ? 'unknown' : exitCode;
            if (!run.host) {
                const reason = currentEnd ?? `exit ${code}`;
                for (const account of run.accounts) { ended.set(account, { at: Date.now(), reason, revision: run.revision }); console.log(`SWARM end ${account} ${reason}`); }
            } else {
                // An account with no end line (the supervisor itself crashed) ends with the exit code.
                for (const a of run.accounts) {
                    if ((ended.get(a)?.at ?? 0) >= run.started) continue;
                    ended.set(a, { at: Date.now(), reason: `exit ${code}`, revision: run.revision });
                    console.log(`SWARM end ${a} exit ${code} (host)`);
                }
            }
        };
        const timer = setInterval(() => { const before = run.offset; read(); if (run.offset !== before) saveRuns(); if (!child && !adoptedRunAlive(run, pidAlive, pidStarts)) finish(); }, 2000);
        child?.on('exit', code => { exitCode = code; finish(); });
    };
    // Adopt the runs a previous controller started: a live one is followed on, a finished one gets its end now.
    for (const saved of (() => { try { return JSON.parse(readFileSync(runsFile, 'utf8')) as SavedRun[]; } catch { return []; } })()) {
        if (!saved?.key || !Number.isSafeInteger(saved.pid) || !Array.isArray(saved.accounts) || runs.has(saved.key)) continue;
        const { key, ...run } = saved;
        runs.set(key, run); adopted.add(run);
    }
    readPidStarts();
    for (const [key, run] of runs) {
        const state = !pidAlive(run.pid) ? ' (ended)' : adoptedRunAlive(run, pidAlive, pidStarts) ? '' : ' (ended: a later process holds the pid)';
        console.log(`SWARM adopt ${run.host ? `host ${run.accounts.join(',')}` : run.accounts[0]} pid ${run.pid}${state}`);
        follow(key, run);
    }
    saveRuns();

    const start = (p: ParsedJob, accounts: string[]) => withSessionAdmission(accounts,root,()=>{
        const job = p.job;
        const revision = missionSignature(job);
        const logName = p.host ? `host-${accounts[0]}.log` : `${accounts[0]}.log`, logPath = join(logDir, logName);
        const cmd = supervisorCommand(p,accounts);
        // Detached, so a controller restart (a rollout) leaves the run going; its output appends to its log.
        const offset = existsSync(logPath) ? statSync(logPath).size : 0, out = openSync(logPath, 'a');
        let child: ReturnType<typeof spawnChild>;
        try {
            // Each worker carries the release of the files its entries can run (docs/script-contract.md, Release
            // scope), so a runtime change needs no swarm restart and an edit outside those files leaves it unchanged.
            const entries = workerEntries(job.script, job.args ?? [], root);
            const workRelease = capabilityRevision(entries, root);
            assertLease();
            writeSync(out, jobLogStart(job));
            child = spawnChild(cmd[0]!, cmd.slice(1), {
                cwd: root, detached: true, windowsHide: true, stdio: ['ignore', out, out],
                env: { ...process.env, ...job.env, SWARM_LEASE_HOLDER: lease.holder, SWARM_MISSION_HASH: createHash('sha256').update(revision).digest('hex'), WORKER_RELEASE: workRelease, WORKER_ENTRY: entries.join(','), DEMO_OK: '1', BOT_ROLE: job.role ?? '', BOT_GOAL: job.goal ?? '', STANDING: (job as Job & {standing?:boolean}).standing ? '1' : '',COORDINATOR_PARTICIPANTS:job.orchestrate?JSON.stringify(accounts):'' },
            });
        } finally { closeSync(out); }
        if (!child.pid) throw Error('supervisor did not start');
        child.unref();
        const run: Run = { pid: child.pid, started: Date.now(), accounts, revision, host: p.host, log: logPath, offset };
        runs.set(p.key, run); saveRuns();
        console.log(`SWARM start ${p.host ? `host ${accounts.join(',')}` : accounts[0]} ${job.script} ${JSON.stringify(job.env ?? {})}`);
        follow(p.key, run, child);
    });

    const tick = () => {
        if (adopted.size && Date.now() - pidStartsAt >= 60_000) readPidStarts();
        if (performance.now() >= renewAt && lease.allows()) {
            // A renewal that did not land leaves the lease standing: it is tried again soon, not in three minutes.
            let landed = true;
            try { lease.renew(); }
            catch (error) { landed = false; console.log('SWARM ' + String(error)); }
            renewAt = performance.now() + (landed || !lease.allows() ? FLEET_LEASE_RENEW_MS : FLEET_LEASE_RETRY_MS);
        }
        if (!lease.allows()) {
            // Also stop adopted runs from code that predates the worker fence. Preserve owner stop files.
            const accounts = new Set([...runs.values()].flatMap(r => r.accounts));
            if (recoveryDispatch.active) accounts.add(recoveryDispatch.active.account);
            for (const held of heldRecoveryOwners(root)) accounts.add(held.account);
            for (const account of accounts) {
                try { writeSwarmStop(stopFile(account), SWARM_STOP.lease); }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') console.log('SWARM could not request lease-loss logout for ' + account);
                }
            }
            if (!accounts.size) { console.log('SWARM stopped (fleet controller lease unavailable)'); process.exit(2); }
            return;
        }
        let plan: Plan;
        // The coordinator's jobs join the root plan only; a practice plan file given on the command line runs alone.
        try { plan = mergedPlan(JSON.parse(readFileSync(planFile, 'utf8')), rootPlan ? readCoordinatorJobs(root) : emptyCoordinatorJobs()); } catch (e) { console.log(`SWARM bad plan: ${String(e)}`); return; }
        // An owner edit of the hold file applies live, like swarm.json.
        try { const m = statSync(holdsFile).mtimeMs; if (m !== holdsMtime) { holds.splice(0, holds.length, ...loadHolds(holdsFile).filter(h => /^died\b/.test(h.reason))); holdsMtime = m; } } catch { /* no hold file yet */ }
        if(!Array.isArray(plan.jobs)||!Number.isFinite(plan.maxBots)||plan.maxBots<1||!Number.isFinite(plan.minFreeGB)) { console.log('SWARM bad plan shape'); return; }
        const stopAll = existsSync(join(prac, 'stop-swarm'));
        inheritedRecoveries=heldRecoveryOwners(root,recoveryDispatch.active?[recoveryDispatch.active.account]:[]);
        if(stopAll&&recoveryDispatch.active)writeSwarmStop(stopFile(recoveryDispatch.active.account),SWARM_STOP.recovery);
        if(stopAll)for(const held of inheritedRecoveries)writeSwarmStop(stopFile(held.account),SWARM_STOP.inherited);
        const planned=plan.jobs.flatMap(j=>{ const p=parseJob(j); return 'error' in p?[]:[p]; });
        const accountEnabled = enabledByAccount(planned);
        if (Date.now() - orphanScanAt >= 60_000) {
            orphanScanAt = Date.now();
            for (const r of releaseExpiredRecoveryLeases(root, recoveryDispatch.active ? [recoveryDispatch.active.account] : [])) {
                if (leaseRefusals.get(r.account) !== r.reason) console.log(`SWARM recovery lease ${r.account}: ${r.reason}`);
                if (r.released) leaseRefusals.delete(r.account); else leaseRefusals.set(r.account, r.reason);
            }
            const busy = [...runs.values()].flatMap(r => r.accounts).concat(inheritedRecoveries.map(r => r.account), recoveryDispatch.active ? [recoveryDispatch.active.account] : []);
            const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } };
            const producer = (a: string, id: string) => {
                const receipt = listAttempts(a, LIVE_SERVER).find(x => x.attemptId === id)?.receipt;
                return receipt ? { pid: receipt.owner.pid, createdAt: receipt.createdAt, updatedAt: receipt.updatedAt } : undefined;
            };
            const accounts = planned.flatMap(p => p.accounts).concat(lifecycleAccounts(join(prac, 'session-lifecycle/live', LIVE_SERVER)));
            for (const [a, reason] of orphanedSessionEnds(accounts, ended, busy, a => readLogoutProof(a, LIVE_SERVER), producer, alive, processStartTimes)) {
                ended.set(a, { at: Date.now(), reason });
                console.log(`SWARM end ${a} ${reason}`);
            }
        }
        // A replacement host/account configuration waits for its current owner;
        // changing the run key must neither stop it nor permit a second login.
        for(const r of runs.values()) if(!overlappingRun(planned,r.accounts)||stopAll)
            for(const a of r.accounts) writeSwarmStop(stopFile(a),SWARM_STOP.removed);
        const statuses: unknown[] = [];
        try {
            for (const file of readdirSync(join(prac, 'status'))) if (file.endsWith('.json')) {
                try { statuses.push(JSON.parse(readFileSync(join(prac, 'status', file), 'utf8'))); } catch { /* incomplete record */ }
            }
        } catch { /* no status directory yet */ }
        let endStateOk = inheritedRecoveries.every(r=>r.source===process.env.WORKER_RELEASE);
        const claimedRepair = `${repairFile}.processing`;
        try {
            if (!existsSync(claimedRepair) && existsSync(repairFile)) renameSync(repairFile, claimedRepair);
            if (existsSync(claimedRepair)) {
                const raw = readFileSync(claimedRepair, 'utf8');
                let request: any, result = { changed: false, reason: 'invalid repair JSON' };
                try { request = JSON.parse(raw); } catch { /* retained in the receipt */ }
                if(!recoveryDispatch.handle(raw,request=>{
                    assertLease();
                    const active=[...runs.values()].flatMap(r=>r.accounts).concat(activeExternalLive(statuses,[],Date.now()));
                    admitRecovery({account:request.account,active,running:botsRunning(),external:activeExternalLive(statuses,[...runs.values()].flatMap(r=>r.accounts).concat(inheritedRecoveries.map(r=>r.account)),Date.now()).length,
                        pending:pendingCount(),freeGB:freemem()/2**30,minFreeGB:plan.minFreeGB,maxBots:plan.maxBots});
                })){
                const before = new Map(ended), holdsBefore = structuredClone(holds);
                const active = [...runs.values()].flatMap(r => r.accounts).concat(activeExternalLive(statuses, [], Date.now()));
                const proofs: RepairProofs = { ...defaultRepairProofs, status: a => {
                    const file = join(prac, 'status', `${a}.json`);
                    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
                } };
                if (request) result = request.kind === 'script-qualified' ? applyScriptQualification(request, holds, active, proofs)
                    : applyEndRepair(request, ended, active, proofs, holds);
                // History first: a lost end-state write then leaves an extra hold, never a silent unban.
                if (result.changed) try { persistHolds(holdsFile, holds); persistEnded(deathsFile, ended); } catch (e) {
                    Map.prototype.clear.call(ended);
                    for (const [name, end] of before) Map.prototype.set.call(ended, name, end);
                    holds.splice(0, holds.length, ...holdsBefore);
                    try { persistHolds(holdsFile, holds); } catch { /* the original error pauses starts */ }
                    throw e;
                }
                appendFileSync(`${repairFile}.results.jsonl`, JSON.stringify({ at: Date.now(), raw, result }) + '\n');
                rmSync(claimedRepair);
                console.log(`SWARM repair ${request?.account ?? '?'}: ${result.reason}`);
                }
            }
        } catch (e) { endStateOk = false; console.log(`SWARM repair unavailable; new starts paused: ${String(e)}`); }
        const externalCount = () => activeExternalLive(statuses, [...runs.values()].flatMap(r => r.accounts).concat(recoveryDispatch.active?[recoveryDispatch.active.account]:[],inheritedRecoveries.map(r=>r.account)), Date.now()).length;
        heldSlot = recoverySlot(heldSlot, { leaseHeld: recoveryLeaseHeld(`${repairFile}.lease`, Date.now()), recovering: recoveryDispatch.active?.account,
            started: [...runs.values()].flatMap(r => r.accounts), now: Date.now() });
        const state: Record<string, unknown>[] = [];
        let owners: Map<string, Owner>;
        try { owners = loadOwners(); } catch (e) { console.log(`SWARM owners unreadable; new starts paused: ${String(e)}`); return; }
        for (const raw of plan.jobs) {
            if(!coordinatedAdmission(raw,!!coordinatorOwner)){
                state.push({account:raw.account,accounts:raw.accounts,script:raw.script,state:'existing assignment; awaiting coordinator qualification'});
                continue;
            }
            if (isReservation(raw)) {
                state.push({ account: raw.account, script: '', role: raw.role, goal: raw.goal, enabled: false, repeat: false, note: raw.note, state: 'reserved', since: null });
                continue;
            }
            const p = parseJob(raw);
            if ('error' in p) {
                state.push({ account: raw.account ?? (raw.accounts ?? []).join('+'), script: raw.script, enabled: raw.enabled, state: `bad job: ${p.error}` });
                continue;
            }
            const job = p.job;
            const foreign = otherSideAccount(p.accounts, side, owners);
            if (foreign) {
                state.push({ account: raw.account ?? p.accounts.join('+'), script: raw.script, enabled: raw.enabled, state: `other side: ${foreign.account} belongs to ${foreign.side}` });
                continue;
            }
            // A standing job runs the current source, so a publish or rollout lock does not hold it.
            if(!(job as Job & {standing?:boolean}).standing&&existsSync(join(prac,'coordinator/build-lock.json'))){
                state.push({account:raw.account,accounts:raw.accounts,script:raw.script,standing:false,state:'waiting: coordinator owns runtime build'});
                continue;
            }
            for (const a of p.accounts) observeEnabled([a], accountEnabled.get(a.toLowerCase()) === true, previousEnabled, pendingResume);
            if(stopAll) for(const a of p.accounts) writeSwarmStop(stopFile(a),SWARM_STOP.all);
            const r = overlappingRun(runs.values(), p.accounts);
            if (!stopAll && endStateOk && applyResume(p.accounts, !!r, ended, pendingResume, a => clearSwarmStop(stopFile(a))))
                persistEnded(deathsFile, ended);
            const st: Record<string, string> = {};
            if (r && foreignRun(planned, p, r) && !stopAll) {
                for (const a of p.accounts) st[a] = 'waiting: another job of this account is running';
            } else if (r) {
                const stop = !job.enabled || stopAll;
                for (const a of p.accounts) {
                    if (!r.accounts.some(name => name.toLowerCase() === a.toLowerCase())) st[a] = 'waiting: current mission still running';
                    else if (ended.has(a) && ended.get(a)!.at >= r.started) st[a] = `ended: ${ended.get(a)!.reason}`;
                    else if (stop) { writeFileSync(stopFile(a), SWARM_STOP.job); st[a] = 'stopping'; }
                    else st[a] = pendingResume.has(a.toLowerCase()) ? 'stopping; resume queued'
                        : r.revision !== missionSignature(job) ? 'running; updated mission queued' : 'running';
                }
            } else if (!job.enabled || stopAll) for (const a of p.accounts) st[a] = 'disabled';
            else if (!endStateOk) for (const a of p.accounts) st[a] = 'paused: repair or source ownership unresolved';
            else {
                // A standing owner job retries a blocked, gave-up, stopped or lost end (standingRetryable) by itself once the
                // account's live status shows a finished session unchanged for BOOTSTRAP_STATUS_AGE_MS. A death still waits
                // for a person; an owner's stop file still blocks the start below.
                if ((job as Job & {standing?:boolean}).standing) for (const a of p.accounts) {
                    const key = [...ended.keys()].find(n => n.toLowerCase() === a.toLowerCase()), end = key ? ended.get(key) : undefined;
                    if (!end) continue;
                    let s: any; try { s = JSON.parse(readFileSync(join(prac, 'status', `${a}.json`), 'utf8')); } catch { continue; }
                    if (!standingRetryable(end.reason, s?.result)) continue;
                    // A host-run account writes no status result; its confirmed producer logout (2 min old) shows it offline.
                    let settled = false;
                    try { const lp = readLogoutProof(a, LIVE_SERVER); settled = lp.state === 'confirmed' && Date.now() - lp.loggedOutAt >= 120_000; } catch { /* unreadable: use the status rule */ }
                    if (s?.server !== LIVE_SERVER || (!settled && (!s.result || !Number.isFinite(s.at) || Date.now() - s.at < BOOTSTRAP_STATUS_AGE_MS))) continue;
                    ended.delete(key!);
                    for (let i = holds.length - 1; i >= 0; i--) if (holds[i]!.account.toLowerCase() === a.toLowerCase()) holds.splice(i, 1);
                    persistEnded(deathsFile, ended); persistHolds(holdsFile, holds);
                    console.log(`SWARM standing retry ${a} after ${end.reason}`);
                }
                const { start: go, blocked } = completeJobCandidates(p,demandCandidates(holdCandidates(startable(p.accounts, job.repeat, ended, statusAge, statusStarted, missionSignature(job), a => existsSync(stopFile(a))),job.script,holds),()=>
                    job.whenFoodLowFrom!==undefined&&!foodSupplyDemand(job,statuses)?'waiting offline: no fresh low-food farm or dated source food stock'
                    :job.whenCargoFrom&&!courierDeliveryWaiting(job.whenCargoFrom,job.demandNear,plan.jobs)&&!ownedPayoutWaiting(statuses,job.demandNear)?'waiting offline: no nearby owned cargo or payout':null));
                Object.assign(st, blocked);
                if (go.length > 0) {
                    const held = recoverySlotReserve(heldSlot, { recovering: !!recoveryDispatch.active, accounts: p.accounts, now: Date.now() });
                    const admission = admissionDecision({ running: botsRunning(), external: externalCount(), starting: go.length + held, startingReserve: startReserve(p, go.length),
                        pending: pendingCount(), freeGB: freemem() / 2 ** 30, minFreeGB: plan.minFreeGB, maxBots: plan.maxBots });
                    if (!admission.allowed) for (const a of go) st[a] = admission.reason === 'maxBots' ? 'waiting: maxBots'
                        : `waiting: projected ${admission.projectedFreeGB.toFixed(1)} GB free after ${admission.reserveGB} GB startup reserve < ${admission.floorGB} GB floor`;
                    else {
                        try { start(p, go); for (const a of go) st[a] = 'starting'; }
                        catch(e) { for(const a of go) st[a]=`paused: ${String(e)}`; }
                    }
                }
            }
            const run = runs.get(p.key);
            for (const a of p.accounts) {
                state.push({
                    account: a, script: job.script, role: job.role, goal: job.goal, enabled: job.enabled, repeat: !!job.repeat, note: job.note,
                    ...(p.host ? { host: p.key } : {}), state: st[a],
                    since: (run && run.accounts.includes(a) ? run.started : undefined) ?? ended.get(a)?.at ?? null,
                });
            }
        }
        const pendingStartup = pendingCount();
        writeFileSync(join(prac, 'swarm-state.json'), JSON.stringify({ at: Date.now(), controllerPid:process.pid,coordinatorOwner,release:process.env.WORKER_RELEASE,freeGB: freemem() / 2 ** 30,
            running: botsRunning(), recovery:recoveryDispatch.active??null,recoverySlot:heldSlot.until>Date.now()?heldSlot:null,inheritedRecoveries, externalRunning: externalCount(), pendingStartup, pendingReserveGB: pendingStartup * START_BUDGET_GB,
            minFreeGB: Math.max(FREE_FLOOR_GB, plan.minFreeGB), maxBots: plan.maxBots, jobs: state }));
        if (stopAll && runs.size === 0&&!recoveryDispatch.active&&!inheritedRecoveries.length) { console.log('SWARM stopped (stop-swarm)'); process.exit(0); }
    };

    console.log(`SWARM plan ${planFile}`);
    tick();
    setInterval(tick, 2000);
}
