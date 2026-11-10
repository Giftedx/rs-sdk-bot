// Recovers this side's held live sessions through the side's running coordinator, one account per call, so the
// swarm and the other farmers keep running. A cloud watchdog calls it; it never guesses: an account whose end record is
// gone, or a side whose coordinator is not running, is refused with a logged reason.
// Usage: FLEET_SIDE=<side> bun scripts/cloud-recover.ts [--dry] [--root=<checkout>]   (root defaults to this checkout)
// The coordinator it restarts inherits this process's environment without SWARM_PLAN, so the caller's PATH must carry
// the model stub (README "Claude Code cloud fleet side").
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { loadOwners, mySide } from '../packages/core/src/fleet';
import { readFleetAccountClaim } from '../packages/core/src/fleet-trade-claim';
import { readLogoutProof, type LogoutProof } from '../packages/core/src/session-lifecycle';
import { heldRecoveryOwners } from '../packages/core/src/session-recovery-permit';
import { jobAccounts } from '../packages/core/src/coordinator-jobs';
import { clearSwarmStop, loadEnded, swarmWroteStop, type EndRecord } from './swarm';

export const LIVE_SERVER = 'rs-sdk-demo.fly.dev';
// The end reasons the recovery permit accepts (packages/core/src/session-recovery-permit.ts), less a death: a death
// waits for a person, as the swarm's standing retry does.
const RECOVERABLE_END = /^(?:blocked|gave-up|exit|no-progress|stopped)(?:\b| )/;

export type ClaimView = { phase: 'held' | 'released'; kind?: string; pid?: number; host?: string } | null;
export type Eligibility = { eligible: true; endedAt: number } | { eligible: false; reason: string; log: boolean };

// Whether one account needs, and may get, an authenticated recovery now. `log` marks a held session that is refused,
// as opposed to an account with nothing to recover.
export function eligibility(v: { proof: LogoutProof; claim: ClaimView; end: EndRecord | undefined; stopText: string | undefined; pidAlive: (pid: number) => boolean; host: string }): Eligibility {
    if (v.proof.state !== 'held') return { eligible: false, reason: `logout proof ${v.proof.state}`, log: false };
    if (!v.claim || v.claim.phase !== 'held') return { eligible: false, reason: 'no held fleet account claim', log: false };
    if (v.claim.kind !== 'swarm') return { eligible: false, reason: 'claim is held by a trade order', log: true };
    if (v.claim.host === v.host && typeof v.claim.pid === 'number' && v.pidAlive(v.claim.pid)) return { eligible: false, reason: 'worker still alive', log: false };
    if (v.stopText !== undefined && !swarmWroteStop(v.stopText)) return { eligible: false, reason: 'owner stop file holds the account', log: true };
    if (!v.end) return { eligible: false, reason: 'end record gone (standing retry window passed); recover by hand', log: true };
    // The supervisor retries the dropped session before it writes the end; until then the end record is an earlier
    // run's. The attempt id starts with its creation time (packages/core/src/session-lifecycle.ts).
    const started = /^\d{13}-/.test(v.proof.attemptId) ? Number(v.proof.attemptId.slice(0, 13)) : NaN;
    if (v.end.at < started) return { eligible: false, reason: 'waiting: the supervisor has not ended the held attempt', log: false };
    if (/^died\b/.test(v.end.reason)) return { eligible: false, reason: 'death needs a person', log: true };
    if (!RECOVERABLE_END.test(v.end.reason)) return { eligible: false, reason: `end reason not recoverable: ${v.end.reason}`, log: true };
    return { eligible: true, endedAt: v.end.at };
}

// The coordinator refuses a live task for an account that has any stop file (packages/router/src/coordinator-live.ts
// runLiveTask: "live account owner stopped before controller setup"). A recovery target is offline, and its stop file,
// if it has one, is the swarm's own (eligibility refuses an owner's): the swarm leaves it when the account's job leaves
// the plan, as when the planner takes an account off its job for a fleet order. Remove those before the submit, or the
// recovery fails and spends an attempt. While stop-swarm is in force they stay: no recovery runs under it.
export function clearSwarmStops(root: string, accounts: readonly string[]): string[] {
    if (existsSync(join(root, '.practice', 'stop-swarm'))) return [];
    return accounts.filter(a => clearSwarmStop(join(root, '.practice', `stop-${a}`)));
}

const stamp = (now: number) => new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'z').toLowerCase();

// One qualify task and one recovery run task per held account, all with fresh ids (finished task ids never run
// again). Accounts dropped together recover in one proposal behind one qualify, so a second account does not wait a
// whole call and reach the swarm's 15-minute end-record deletion. Each run also waits for the run before it: the
// controller has one repair slot and a run gives up after 180 s waiting for it (coordinator-live.ts
// requestAuthenticatedRecovery), which four parallel runs overran. A run behind a failed one never starts; it counts
// as a spent attempt and the next call submits its account again.
export type Target = { account: string; endedAt: number };
// The coordinator takes at most 12 tasks in one proposal (packages/router/src/coordinator-planner.ts prepareProposal)
// and one of them is the qualify, so a call recovers at most 11 accounts; the rest wait for the next call. Live
// claude-cloud: a container restart dropped 12 sessions, the 13-task proposal was rejected and nothing recovered for
// 27 minutes.
export const MAX_TARGETS = 11;
export function recoveryBatch(targets: readonly Target[]): { now: Target[]; later: Target[] } {
    return { now: targets.slice(0, MAX_TARGETS), later: targets.slice(MAX_TARGETS) };
}
// A proposal the coordinator rejects never becomes tasks: it renames the request file `.rejected`
// (packages/router/src/coordinator-cli.ts intakeRequests). The request's own name is random, so it is found by the
// qualify id it carries.
export function submitRejected(requests: string, qualifyId: string): boolean {
    if (!existsSync(requests)) return false;
    return readdirSync(requests).filter(f => f.endsWith('.rejected')).some(f => {
        try { return JSON.parse(readFileSync(join(requests, f), 'utf8'))?.tasks?.[0]?.id === qualifyId; } catch { return false; }
    });
}
export function recoveryProposal(side: string, targets: readonly Target[], now: number) {
    const s = stamp(now), qualify = `${side}-recovery-qualified-${s}`, runId = (account: string) => `${side}-recover-${account.toLowerCase()}-${s}`;
    return {
        reason: `Authenticated recovery of ${targets.map(t => t.account).join(', ')} inside the running coordinator`, capabilities: [],
        tasks: [
            { id: qualify, goal: 'wealth', kind: 'qualify', capability: 'session-recovery-only', dependsOn: [] as string[], priority: 90, estimatedMs: 600000, why: 'Qualify authenticated session recovery' },
            ...targets.map(({ account, endedAt }, i) => ({ id: runId(account), goal: 'wealth', kind: 'run', capability: 'session-recovery-only', account,
                dependsOn: i ? [qualify, runId(targets[i - 1]!.account)] : [qualify],
                repairs: [{ account, endedAt }], sessionRecovery: { account, endedAt }, accept: { counters: { sessionChecked: 1 } },
                priority: 90, estimatedMs: 120000, why: `Authenticated recovery of ${account}'s orphaned session` })),
        ],
    };
}

// Session-recovery tasks still pending or running in the coordinator's state: a release waits until they settle, so
// every finished recovery has parked its session check first. A pending task behind a failed or missing dependency
// never starts, so it is settled, not in flight.
// Pending tasks that can never start: a dependency failed, was superseded or is missing, directly or through another
// pending task. Same rule as the coordinator's deadRoots (packages/router/src/coordinator.ts), which a script may not
// import (packages/core/src/worker-release.ts); a run's failed refresh qualify is replaceable, so it does not count.
export function deadTasks(tasks: readonly any[]): Set<string> {
    const byId = new Map(tasks.map(t => [t?.spec?.id, t])), memo = new Map<string, boolean>();
    const dead = (t: any): boolean => {
        if (memo.has(t.spec.id)) return memo.get(t.spec.id)!;
        memo.set(t.spec.id, false);
        const result = (t.spec.dependsOn ?? []).some((id: string) => {
            if (t.spec.kind === 'run' && id.startsWith(`refresh-${t.spec.capability}-`)) return false;
            const d = byId.get(id);
            return !d || d.status === 'failed' || d.status === 'superseded' || d.status === 'pending' && dead(d);
        });
        memo.set(t.spec.id, result);
        return result;
    };
    return new Set(tasks.filter(t => t?.status === 'pending' && t.spec?.id).filter(dead).map(t => t.spec.id));
}
export const recoveriesInFlight = (tasks: readonly any[], dead = deadTasks(tasks)) =>
    tasks.filter(t => t?.spec?.sessionRecovery && (t.status === 'running' || t.status === 'pending' && !dead.has(t.spec.id)));

// Recovery runs already spent on one exact end: the run failed, or its qualify did. A run that never started behind a
// failed earlier run of its chain is no attempt. A failure is retried once; a second stops the retries for that end.
export const MAX_ATTEMPTS = 2;
export function spentAttempts(tasks: readonly any[], target: Target): number {
    const byId = new Map(tasks.map(t => [t?.spec?.id, t]));
    const qualifyFailed = (id: string) => { const d = byId.get(id); return d?.spec?.kind === 'qualify' && (d.status === 'failed' || d.status === 'superseded'); };
    return tasks.filter(t => {
        const r = t?.spec?.sessionRecovery;
        return r?.account?.toLowerCase() === target.account.toLowerCase() && r.endedAt === target.endedAt
            && (t.status === 'failed' || t.status === 'pending' && (t.spec.dependsOn ?? []).some(qualifyFailed));
    }).length;
}

// The folder that receives the coordinator's parked jobs and stop file after a release.
// The session-lifecycle root that readLogoutProof reads (packages/core/src/session-lifecycle.ts DEFAULT_LIFECYCLE_ROOT).
export const lifecycleRoot = (root: string) => join(root, '.practice', 'session-lifecycle');

export function archiveDir(root: string, account: string, now: number): string {
    return join(root, '.practice', 'coordinator', 'release-archive', `${stamp(now)}-${account.toLowerCase()}`);
}

// The jobs in the coordinator's file that a release may archive. A finished recovery parks a session check. A recovery
// that parked the account's owner job (a disabled copy without coordinatorOwner, coordinator-live.ts
// prepareLiveRecovery) and then failed leaves that copy. The copy goes only when, for every account in it, the owner job
// in swarm.json still names the account, its logout proof is confirmed (none or invalid still block) and no recovery
// of it is pending or running; the copy then only keeps the account from its owner job (the coordinator's settledOwnerJob).
export type ReleaseView = { ownerJob: (account: string) => boolean; confirmed: (account: string) => boolean; recovering: (account: string) => boolean };
const releasable = (j: any, v: ReleaseView) => j?.enabled === false && (
    j.coordinatorOwner === 'coordinator' ? typeof j.account === 'string' && j.script === 'scripts/session-check.ts'
        : jobAccounts(j).length > 0 && jobAccounts(j).every(a => v.ownerJob(a) && v.confirmed(a) && !v.recovering(a)));
// Jobs that may not be archived yet.
export const releaseBlockers = (jobs: readonly any[], v: ReleaseView) => jobs.filter(j => !releasable(j, v));
// A blocker that only waits for its own account: a parked owner-job copy whose owner job is in swarm.json and that has
// no recovery open, but whose logout is not confirmed yet. It stays in the file and no longer holds the others: live
// claude-cloud, one such copy (Fingersmith) kept seven recovered accounts parked for 30 minutes.
const waits = (j: any, v: ReleaseView) => j?.enabled === false && j.coordinatorOwner !== 'coordinator'
    && jobAccounts(j).length > 0 && jobAccounts(j).every(a => v.ownerJob(a) && !v.recovering(a));
// What a release does with the coordinator's file: the jobs it archives and the jobs it leaves in place. Any other
// blocker (an enabled job, a coordinator job that is not a parked session check, a copy with no owner job) is work
// this script does not understand, and nothing is released around it.
export function releasePlan(jobs: readonly any[], v: ReleaseView): { free: any[]; keep: any[] } {
    const keep = releaseBlockers(jobs, v);
    return keep.every(j => waits(j, v)) ? { free: jobs.filter(j => !keep.includes(j)), keep } : { free: [], keep: [...jobs] };
}
// The accounts a release frees.
export function releasableAccounts(jobs: readonly any[], v: ReleaseView): string[] {
    return releasePlan(jobs, v).free.flatMap(jobAccounts);
}

// The account's recovery lease (packages/core/src/session-recovery-permit.ts recoveryPermitPaths). A recovery whose
// child is held keeps it (session-recovery-dispatch.ts "recovery child held"), and while the file is there the swarm
// refuses every later recovery of the account ("existing recovery lease held") and the account's own logins
// (assertNoRecoveryLease). Live claude-cloud: one such lease (Fingersmith) made the retry of its end fail unseen.
// A lease is stale when heldRecoveryOwners no longer counts it: its child's process is gone, or it recorded no child
// and its permit has expired. A lease it cannot read, and one whose child still runs, are held.
export type LeaseState = 'none' | 'held' | 'stale';
const leaseFile = (root: string, account: string) => join(root, '.practice', 'coordinator', 'session-recovery', 'accounts', account.toLowerCase(), 'lease.json');
export function recoveryLeaseState(root: string, account: string, alive?: (pid: number) => boolean, now = Date.now()): LeaseState {
    if (!existsSync(leaseFile(root, account))) return 'none';
    return heldRecoveryOwners(root, [], alive, now).some(h => h.account.toLowerCase() === account.toLowerCase()) ? 'held' : 'stale';
}
// Moves a stale lease aside in its own folder, so the retry that MAX_ATTEMPTS allows is a real recovery. The attempt
// folder beside it keeps the held child's permit and output.
export function archiveStaleLease(root: string, account: string, now: number): string {
    const file = leaseFile(root, account), to = join(resolve(file, '..'), `lease-stale-${stamp(now)}.json`);
    renameSync(file, to);
    return to;
}

// The local side's coordinator owns real work in its jobs.json; only a cloud side runs this script.
export const cloudSide = (side: string) => side !== 'local';

const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
const readJson = (file: string, fallback: any) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
const log = (line: string) => console.log(`CLOUD_RECOVER ${line}`);

async function main(root: string, dry: boolean): Promise<number> {
    const side = mySide(), coord = join(root, '.practice', 'coordinator'), stopCoordinator = join(root, '.practice', 'stop-coordinator');
    if (!cloudSide(side)) { log('refused: cloud sides only (FLEET_SIDE unset or local); the local coordinator owns its jobs.json'); return 1; }
    const coordinatorRunning = () => { const o = readJson(join(coord, 'owner.json'), null); return !!o && Number.isSafeInteger(o.pid) && pidAlive(o.pid) && !existsSync(stopCoordinator); };
    if (!coordinatorRunning()) { log('refused: coordinator is not running'); return 1; }
    const tasksNow = () => readJson(join(coord, 'state.json'), { tasks: [] }).tasks ?? [];
    const before = tasksNow(), dead = deadTasks(before), inFlight = recoveriesInFlight(before, dead);
    if (inFlight.length) { log(`recovery in flight for ${inFlight.map((t: any) => t.spec.sessionRecovery.account).join(', ')}; waiting`); return 0; }
    const ended = loadEnded(join(root, '.practice', 'swarm-deaths.json'));
    const accounts = [...loadOwners()].filter(([, o]) => o.side === side && o.server === LIVE_SERVER).map(([n]) => n);
    const targets: Target[] = [];
    for (const lower of accounts) {
        const name = [...ended.keys()].find(n => n.toLowerCase() === lower) ?? lower;
        const proof = readLogoutProof(name, LIVE_SERVER, { root: lifecycleRoot(root) });
        if (proof.state !== 'held') continue;
        // A live worker refreshes its status every few seconds; skip it before reading the claim ref from origin.
        const status = readJson(join(root, '.practice', 'status', `${name}.json`), null);
        if (status && !status.result && Date.now() - status.at < 60_000) continue;
        let claim: ClaimView = null;
        try { claim = readFleetAccountClaim(root, { account: name, server: LIVE_SERVER }) as ClaimView; } catch (e) { log(`${name}: refused: claim unreadable: ${String(e).slice(0, 120)}`); continue; }
        const stopFile = join(root, '.practice', `stop-${name}`), stopText = existsSync(stopFile) ? readFileSync(stopFile, 'utf8') : undefined;
        const e = eligibility({ proof, claim, end: ended.get(name), stopText, pidAlive, host: hostname() });
        if (!e.eligible) { if (e.log) log(`${name}: refused: ${e.reason}`); continue; }
        const target = { account: name, endedAt: e.endedAt };
        if (spentAttempts(before, target) >= MAX_ATTEMPTS) { log(`${name}: refused: ${MAX_ATTEMPTS} recoveries of end ${e.endedAt} failed; recover by hand`); continue; }
        if (recoveryLeaseState(root, name) === 'held') { log(`${name}: refused: a recovery child still holds the account's lease, or the lease is unreadable`); continue; }
        targets.push(target);
    }
    let failed = false;
    if (targets.length) {
        const { now: batch, later } = recoveryBatch(targets);
        if (later.length) log(`${later.length} more held accounts wait for the next call: ${later.map(t => t.account).join(', ')}`);
        const proposal = recoveryProposal(side, batch, Date.now()), runs = proposal.tasks.slice(1) as { id: string; account: string }[];
        log(`submitting ${proposal.tasks.map(t => t.id).join(', ')} (${batch.map(t => `${t.account} endedAt ${t.endedAt}`).join('; ')})`);
        const stale = batch.map(t => t.account).filter(a => recoveryLeaseState(root, a) === 'stale');
        if (dry) { if (stale.length) log(`would move aside the stale recovery lease of ${stale.join(', ')}`); return 0; }
        for (const a of stale) log(`${a}: moved its stale recovery lease to ${archiveStaleLease(root, a, Date.now())}`);
        const cleared = clearSwarmStops(root, batch.map(t => t.account));
        if (cleared.length) log(`removed the swarm's own stop file for ${cleared.join(', ')}`);
        const file = join(root, '.practice', 'cloud-recover', `${proposal.tasks[0]!.id}.json`);
        mkdirSync(resolve(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify(proposal, null, 1) + '\n');
        if (!(await run(root, ['--submit', file]))) { log('submit failed'); return 1; }
        // One qualify, then about a minute per recovery run.
        const deadline = Date.now() + (15 + 2 * runs.length) * 60_000;
        for (;;) {
            const tasks = tasksNow(), status = (id: string) => tasks.find((t: any) => t.spec?.id === id)?.status, open = new Set(recoveriesInFlight(tasks).map((t: any) => t.spec.id));
            if (runs.every(r => status(r.id) && !open.has(r.id))) break;
            if (submitRejected(join(coord, 'requests'), proposal.tasks[0]!.id)) { log(`submit rejected by the coordinator (queue-submit-failed in its events): ${proposal.tasks[0]!.id}`); return 1; }
            if (Date.now() > deadline) { log(`recovery timed out (${runs.map(r => `${r.id} ${status(r.id) ?? 'unseen'}`).join(', ')}); no retry`); return 1; }
            await Bun.sleep(5000);
        }
        const tasks = tasksNow();
        for (const r of runs) {
            const status = tasks.find((t: any) => t.spec?.id === r.id)?.status, ok = status === 'succeeded', proof = readLogoutProof(r.account, LIVE_SERVER, { root: lifecycleRoot(root) });
            log(`${r.account}: recovery ${ok ? 'succeeded' : status === 'pending' ? 'not started: a dependency failed' : 'failed'} (${r.id}); logout proof ${proof.state}`);
            if (!ok || proof.state !== 'confirmed') failed = true;
        }
    }
    // A finished recovery leaves a parked coordinator job that keeps the account from its owner job; release them all
    // once no recovery is still in flight, so each has parked its session check first.
    const flying = recoveriesInFlight(tasksNow());
    if (flying.length) return failed ? 1 : 0;
    const jobs = readJson(join(coord, 'jobs.json'), { jobs: [] }).jobs ?? [];
    const owned = new Set((readJson(join(root, 'swarm.json'), { jobs: [] }).jobs ?? []).flatMap(jobAccounts).map((n: string) => n.toLowerCase()));
    const view: ReleaseView = { ownerJob: a => owned.has(a.toLowerCase()), confirmed: a => readLogoutProof(a, LIVE_SERVER, { root: lifecycleRoot(root) }).state === 'confirmed',
        recovering: a => flying.some((t: any) => t.spec.sessionRecovery.account.toLowerCase() === a.toLowerCase()) };
    const { free, keep } = releasePlan(jobs, view), parked = free.flatMap(jobAccounts), blockers = releaseBlockers(jobs, view);
    const named = (js: readonly any[]) => js.map((j: any) => `${jobAccounts(j).join('+')} ${j.script}${j.enabled === false ? '' : ' (enabled)'}`).join(', ');
    if (!parked.length && blockers.length && blockers.length < jobs.length) log(`release skipped: jobs.json also holds ${named(blockers)}`);
    if (!parked.length) return failed ? 1 : 0;
    if (dry) { log(`would release parked jobs for ${parked.join(', ')}${keep.length ? `; would leave ${named(keep)}` : ''}`); return 0; }
    return (await release(root, parked, keep)) && !failed ? 0 : 1;
}

async function run(root: string, args: string[]): Promise<boolean> {
    const p = Bun.spawn(['bun', 'packages/router/src/coordinator-cli.ts', ...args], { cwd: root, stdout: 'inherit', stderr: 'inherit', windowsHide: true });
    return (await p.exited) === 0;
}

// Stop the coordinator (its swarm and workers are detached and keep running), move its parked jobs and stop file into
// an archive folder, then start it again; it adopts the running swarm. Jobs in `keep` go back into a new jobs.json.
async function release(root: string, parked: string[], keep: readonly any[] = []): Promise<boolean> {
    const coord = join(root, '.practice', 'coordinator'), owner = readJson(join(coord, 'owner.json'), null);
    if (!(await run(root, ['--stop']))) { log('release: coordinator stop failed'); return false; }
    const deadline = Date.now() + 120_000;
    while (owner && pidAlive(owner.pid)) { if (Date.now() > deadline) { log('release: coordinator did not exit; jobs.json left in place'); return false; } await Bun.sleep(2000); }
    const dir = archiveDir(root, parked[0]!, Date.now()); mkdirSync(dir, { recursive: true });
    const file = join(coord, 'jobs.json'), whole = readJson(file, { jobs: [] });
    for (const f of [file, join(root, '.practice', 'stop-coordinator')]) if (existsSync(f)) renameSync(f, join(dir, f.split('/').pop()!));
    if (keep.length) { writeFileSync(file, JSON.stringify({ ...whole, jobs: keep }, null, 1) + '\n'); log(`release left in jobs.json: ${keep.map((j: any) => `${jobAccounts(j).join('+')} ${j.script}`).join(', ')}`); }
    const env = { ...process.env }; delete env.SWARM_PLAN;
    mkdirSync(join(root, '.practice', 'swarm-logs'), { recursive: true });
    const out = openSync(join(root, '.practice', 'swarm-logs', 'coordinator.log'), 'a');
    spawn('bun', ['packages/router/src/coordinator-cli.ts', '--run'], { cwd: root, env, detached: true, stdio: ['ignore', out, out], windowsHide: true }).unref();
    log(`released ${parked.join(', ')}; parked jobs archived in ${dir}; coordinator restarted`);
    return true;
}

if (import.meta.main) {
    const rootArg = process.argv.find(a => a.startsWith('--root='))?.slice(7);
    process.exit(await main(resolve(rootArg ?? join(import.meta.dir, '..')), process.argv.includes('--dry')));
}
