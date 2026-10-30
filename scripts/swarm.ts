// Swarm controller: one place that decides which live account runs what. Reads swarm.json every 2 s (edits apply
// live), starts each enabled job under packages/practice/src/supervise.ts, and writes .practice/swarm-state.json for
// the dashboard. Admission counts managed and fresh external live accounts against maxBots. Each new account
// reserves 1 GiB for 30 s; projected free RAM must retain max(8 GiB, minFreeGB). It never starts an account whose status file changed in the
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
// Usage: DEMO_OK=1 bun scripts/swarm.ts [swarm.json]
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { freemem } from 'node:os';
import { payoutWaiting, type DemandNear } from '../packages/core/src/bank-demand';
import { ownedAccounts } from '../packages/core/src/tradeguard';
import { courierDeliveryWaiting } from './courier-cargo';
import { deliveryResume, foodDeficit, selectFoodSource } from './courier-route';
import {assertWorkerRelease} from '../packages/core/src/worker-release';
import {withSessionAdmission,missionSignature as sharedMissionSignature,successfulEnd,BOOTSTRAP_STATUS_AGE_MS} from '../packages/core/src/session-admission';
import {assertNoRecoveryLease,heldRecoveryOwners} from '../packages/core/src/session-recovery-permit';
import {createRecoveryDispatch} from '../packages/core/src/session-recovery-dispatch';
import { createHash } from 'node:crypto';
import { readLogoutProof, verifyLegacyLogout, type LegacyLogoutClaim, type LegacyLogoutProof, type LogoutProof } from '../packages/core/src/session-lifecycle';
import { FREE_FLOOR_GB } from '../packages/core/src/memory';

export type Job = { account?: string; accounts?: string[]; host?: boolean; orchestrate?:boolean; args?:string[]; maxRestarts?:number; script: string; role?: string; goal?: string; env?: Record<string, string>; enabled: boolean; repeat?: boolean; note?: string; whenCargoFrom?: string[]; demandNear?: {x:number;z:number;radius:number};whenFoodLowFrom?:string[];foodLowBelow?:number;foodSourceAccount?:string;foodSourceAccounts?:string[];sourceFoodMinimum?:number };
type Plan = { maxBots: number; minFreeGB: number; jobs: Job[] };
type Run = { proc: ReturnType<typeof Bun.spawn>; started: number; accounts: string[]; revision: string; host?: boolean };
export type ParsedJob = { key: string; accounts: string[]; host: boolean; job: Job };

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

// An entry with an account and no script is a reservation (the main account waits for its own run): the swarm never
// starts it and reports it as "reserved", not as a bad job.
export function isReservation(job: Job): boolean {
    return !!job && typeof job.account === 'string' && !job.accounts && !job.script;
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
        return { key: `host:${list.join('+')}`, accounts: [...list], host: true, job };
    }
    if (job.accounts) return { error: '"accounts" needs "host": true' };
    if (typeof job.account !== 'string' || !ACCOUNT.test(job.account)) return { error: 'no account' };
    return { key: job.account, accounts: [job.account], host: false, job };
}

export function supervisorCommand(parsed:ParsedJob,accounts:string[]):string[]{
    const job=parsed.job,maxRestarts=String(job.maxRestarts??(job.orchestrate?0:20));
    return parsed.host?['bun','packages/practice/src/supervise-host.ts',job.script,maxRestarts,...accounts,...(job.args?.length?['--args',job.args.join(',')]:[])]
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

export function overlappingRun<T extends { accounts: readonly string[] }>(runs: Iterable<T>, accounts: readonly string[]): T | undefined {
    const names = new Set(accounts.map(a => a.toLowerCase()));
    return [...runs].find(r => r.accounts.some(a => names.has(a.toLowerCase())));
}

export type EndRecord = { at: number; reason: string; revision?: string };
// These failures need a fix before another login. "repeat" does not clear them.
export function persistentEnd(reason: string): boolean {
    return /^(?:died|blocked|gave-up)(?:\b|$)/.test(reason);
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
    if (persistentEnd(entry[1].reason) && !script) return { changed: false, reason: 'failed script unknown; hold cannot be kept' };
    const logout = currentLogout(request, proofs);
    if (!logout.ok) return { changed: false, reason: logout.reason };
    if (persistentEnd(entry[1].reason)) holds.push({ account: entry[0], script: script!, at: entry[1].at, reason: entry[1].reason,
        ...(entry[1].revision !== undefined ? { revision: entry[1].revision } : {}), heldAt: (proofs.now ?? Date.now)() });
    ended.delete(entry[0]);
    return { changed: true, reason: `repaired failure cleared (${logout.label})` };
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
    try { writeFileSync(temporary, JSON.stringify(holds, null, 1)); renameSync(temporary, file); }
    catch (e) { try { rmSync(temporary, { force: true }); } catch { /* retain the original error */ } throw e; }
}
export function persistEnded(file: string, ended: ReadonlyMap<string, EndRecord>): void {
    // Keep success and its launched revision too: a bounded job must not run
    // again merely because the controller restarted. Admission still permits
    // explicit repeat or genuinely changed work, with the usual session guard.
    const temporary = `${file}.tmp-${process.pid}`;
    try {
        writeFileSync(temporary, JSON.stringify(Object.fromEntries(ended), null, 1));
        renameSync(temporary, file);
    } catch (e) {
        try { rmSync(temporary, { force: true }); } catch { /* retain the original error */ }
        throw e;
    }
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
    const coordinatorOwner=process.argv.find(a=>a.startsWith('--coordinator='))?.slice('--coordinator='.length);
    const prac = join(root, '.practice');
    const logDir = join(prac, 'swarm-logs');
    mkdirSync(logDir, { recursive: true });
    if (process.env.DEMO_OK !== '1') { console.log('swarm: set DEMO_OK=1 (live server)'); process.exit(2); }

    const runs = new Map<string, Run>();
    const recoveryDispatch=createRecoveryDispatch({base:root,server:LIVE_SERVER});
    let inheritedRecoveries: ReturnType<typeof heldRecoveryOwners> = [];
    const previousEnabled = new Map<string, boolean>();
    const pendingResume = new Set<string>();
    // Legacy filename retains success/revision, paused/unknown and hard ends.
    // A plan disable-enable resumes only pauses; hard failures need repair.
    const deathsFile = join(prac, 'swarm-deaths.json');
    const repairFile = join(prac, 'swarm-repair.json');
    const ended = loadEnded(deathsFile);
    const holdsFile = join(prac, 'swarm-script-holds.json');
    const holds = loadHolds(holdsFile);
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

    const start = (p: ParsedJob, accounts: string[]) => withSessionAdmission(accounts,root,()=>{
        const job = p.job;
        const revision = missionSignature(job);
        const logName = p.host ? `host-${accounts[0]}.log` : `${accounts[0]}.log`;
        const log = createWriteStream(join(logDir, logName), { flags: 'a' });
        const cmd = supervisorCommand(p,accounts);
        const proc = Bun.spawn(cmd, {
            cwd: root, stdout: 'pipe', stderr: 'pipe',
            env: { ...process.env, ...job.env, DEMO_OK: '1', BOT_ROLE: job.role ?? '', BOT_GOAL: job.goal ?? '', STANDING: (job as Job & {standing?:boolean}).standing ? '1' : '',COORDINATOR_PARTICIPANTS:job.orchestrate?JSON.stringify(accounts):'' },
        windowsHide:true});
        let currentEnd: string | undefined;
        const consume = (line: string) => {
            if (!p.host) { currentEnd = supervisorEndLine(line) ?? currentEnd; return; }
            const m = line.match(/^SUPERVISE-HOST account (.+?) ([\w-]+) after \d+ runs/);
            if (m) { ended.set(m[1]!, { at: Date.now(), reason: m[2]!, revision }); console.log(`SWARM end ${m[1]} ${m[2]} (host)`); }
        };
        const pumps = [proc.stdout, proc.stderr].map(async stream => {
            let tail = '';
            const decoder = new TextDecoder();
            for await (const c of stream as ReadableStream<Uint8Array>) {
                log.write(c);
                tail += decoder.decode(c, { stream: true });
                const lines = tail.split(/\r?\n/);
                tail = lines.pop() ?? '';
                for (const line of lines) consume(line);
            }
            consume(tail + decoder.decode());
        });
        const startedAt = Date.now();
        runs.set(p.key, { proc, started: startedAt, accounts, revision, host: p.host });
        console.log(`SWARM start ${p.host ? `host ${accounts.join(',')}` : accounts[0]} ${job.script} ${JSON.stringify(job.env ?? {})}`);
        void proc.exited.then(async code => {
            // Wait for the current process's final end line. An append log may still hold an older run's end.
            await Promise.all(pumps);
            runs.delete(p.key);
            if (!p.host) {
                const reason = currentEnd ?? `exit ${code}`;
                for(const account of accounts){
                    ended.set(account, { at: Date.now(), reason, revision });
                    console.log(`SWARM end ${account} ${reason}`);
                }
            } else {
                // An account with no end line (the supervisor itself crashed) ends with the exit code.
                for (const a of accounts) {
                    if ((ended.get(a)?.at ?? 0) >= startedAt) continue;
                    ended.set(a, { at: Date.now(), reason: `exit ${code}`, revision });
                    console.log(`SWARM end ${a} exit ${code} (host)`);
                }
            }
            log.end();
        });
    });

    const tick = () => {
        let plan: Plan;
        try { plan = JSON.parse(readFileSync(planFile, 'utf8')); } catch (e) { console.log(`SWARM bad plan: ${String(e)}`); return; }
        // An owner edit of the hold file applies live, like swarm.json.
        try { const m = statSync(holdsFile).mtimeMs; if (m !== holdsMtime) { holds.splice(0, holds.length, ...loadHolds(holdsFile)); holdsMtime = m; } } catch { /* no hold file yet */ }
        if(!Array.isArray(plan.jobs)||!Number.isFinite(plan.maxBots)||plan.maxBots<1||!Number.isFinite(plan.minFreeGB)) { console.log('SWARM bad plan shape'); return; }
        const stopAll = existsSync(join(prac, 'stop-swarm'));
        inheritedRecoveries=heldRecoveryOwners(root,recoveryDispatch.active?[recoveryDispatch.active.account]:[]);
        if(stopAll&&recoveryDispatch.active)writeFileSync(stopFile(recoveryDispatch.active.account),'swarm recovery stopped');
        if(stopAll)for(const held of inheritedRecoveries)writeFileSync(stopFile(held.account),'inherited recovery stopped');
        const planned=plan.jobs.flatMap(j=>{ const p=parseJob(j); return 'error' in p?[]:[p]; });
        // A replacement host/account configuration waits for its current owner;
        // changing the run key must neither stop it nor permit a second login.
        for(const r of runs.values()) if(!overlappingRun(planned,r.accounts)||stopAll)
            for(const a of r.accounts) writeFileSync(stopFile(a),'swarm plan removed or stopped');
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
        const state: Record<string, unknown>[] = [];
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
            // A standing job runs the current source, so a publish or rollout lock does not hold it.
            if(!(job as Job & {standing?:boolean}).standing&&existsSync(join(prac,'coordinator/build-lock.json'))){
                state.push({account:raw.account,accounts:raw.accounts,script:raw.script,standing:false,state:'waiting: coordinator owns runtime build'});
                continue;
            }
            observeEnabled(p.accounts, job.enabled, previousEnabled, pendingResume);
            if(stopAll) for(const a of p.accounts) writeFileSync(stopFile(a),'swarm stopped');
            const r = overlappingRun(runs.values(), p.accounts);
            if (!stopAll && endStateOk && applyResume(p.accounts, !!r, ended, pendingResume, a => rmSync(stopFile(a), {force:true})))
                persistEnded(deathsFile, ended);
            const st: Record<string, string> = {};
            if (r) {
                const stop = !job.enabled || stopAll;
                for (const a of p.accounts) {
                    if (!r.accounts.some(name => name.toLowerCase() === a.toLowerCase())) st[a] = 'waiting: current mission still running';
                    else if (ended.has(a) && ended.get(a)!.at >= r.started) st[a] = `ended: ${ended.get(a)!.reason}`;
                    else if (stop) { writeFileSync(stopFile(a), 'swarm'); st[a] = 'stopping'; }
                    else st[a] = pendingResume.has(a.toLowerCase()) ? 'stopping; resume queued'
                        : r.revision !== missionSignature(job) ? 'running; updated mission queued' : 'running';
                }
            } else if (!job.enabled || stopAll) for (const a of p.accounts) st[a] = 'disabled';
            else if (!endStateOk) for (const a of p.accounts) st[a] = 'paused: repair or source ownership unresolved';
            else {
                // A standing owner job retries a blocked or gave-up end by itself once the account's live status shows
                // a finished session unchanged for BOOTSTRAP_STATUS_AGE_MS. A death still waits for a person.
                if ((job as Job & {standing?:boolean}).standing) for (const a of p.accounts) {
                    const key = [...ended.keys()].find(n => n.toLowerCase() === a.toLowerCase()), end = key ? ended.get(key) : undefined;
                    if (!end || !/^(?:blocked|gave-up)\b/.test(end.reason)) continue;
                    let s: any; try { s = JSON.parse(readFileSync(join(prac, 'status', `${a}.json`), 'utf8')); } catch { continue; }
                    if (s?.server !== LIVE_SERVER || !s.result || !Number.isFinite(s.at) || Date.now() - s.at < BOOTSTRAP_STATUS_AGE_MS) continue;
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
                    const admission = admissionDecision({ running: botsRunning(), external: externalCount(), starting: go.length, startingReserve: p.host ? 1 : go.length,
                        pending: pendingCount(), freeGB: freemem() / 2 ** 30, minFreeGB: plan.minFreeGB, maxBots: plan.maxBots });
                    if (!admission.allowed) for (const a of go) st[a] = admission.reason === 'maxBots' ? 'waiting: maxBots'
                        : `waiting: projected ${admission.projectedFreeGB.toFixed(1)} GB free after ${admission.reserveGB} GB startup reserve < ${admission.floorGB} GB floor`;
                    else {
                        try { if (!(job as Job & {standing?:boolean}).standing) assertWorkerRelease();start(p, go); for (const a of go) st[a] = 'starting'; }
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
            running: botsRunning(), recovery:recoveryDispatch.active??null,inheritedRecoveries, externalRunning: externalCount(), pendingStartup, pendingReserveGB: pendingStartup * START_BUDGET_GB,
            minFreeGB: Math.max(FREE_FLOOR_GB, plan.minFreeGB), maxBots: plan.maxBots, jobs: state }));
        if (stopAll && runs.size === 0&&!recoveryDispatch.active&&!inheritedRecoveries.length) { console.log('SWARM stopped (stop-swarm)'); process.exit(0); }
    };

    console.log(`SWARM plan ${planFile}`);
    tick();
    setInterval(tick, 2000);
}
