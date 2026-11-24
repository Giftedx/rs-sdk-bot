// Recovers this side's held live sessions via standalone bounded recovery in packages/fleet/src/session-recovery.ts.
// A held session is one whose logout the server did not confirm: a logout that timed out, a dropped
// socket, a killed worker. Its fleet claim stays held and each later login fails `fleet account claim held by swarm`.
// The side's watchdog calls this script; it never guesses: an account whose end record is gone or whose safety/circuit
// checks refuse is skipped with a logged reason.
// Usage: FLEET_SIDE=<side> bun scripts/cloud-recover.ts [--dry] [--root=<checkout>]   (root defaults to this checkout)
import { RESERVED_ACCOUNTS } from '../packages/core/src/specialist-boards';
import { lifecycleRootForRead, liveLifecycleRoot, liveRoot } from '../packages/core/src/practice-paths';
import { InfraCircuitBreaker } from '../packages/fleet/src/infra-circuit-breaker';
import { runStandaloneRecoveryPass } from '../packages/fleet/src/session-recovery';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadOwners, mySide } from '../packages/core/src/fleet';
import { BOOTSTRAP_STATUS_AGE_MS } from '../packages/core/src/session-admission';
import { readFleetAccountClaim } from '../packages/core/src/fleet-trade-claim';
import { attemptOutcome, listAttempts, readLogoutProof, type LogoutProof } from '../packages/core/src/session-lifecycle';
import { heldRecoveryOwners, RECOVERY_SCRIPT } from '../packages/core/src/session-recovery-permit';
import { jobAccounts } from '../packages/fleet/src/trade-plan';
import { clearSwarmStop, loadEnded, swarmWroteStop, type EndRecord } from './swarm';

export const LIVE_SERVER = 'rs-sdk-demo.fly.dev';
// The end reasons the recovery permit accepts (packages/core/src/session-recovery-permit.ts), less a death. A death
// needs planner diagnosis without a recovery login.
const RECOVERABLE_END = /^(?:blocked|gave-up|exit|no-progress|stopped)(?:\b| )/;

export type ClaimView = { phase: 'held' | 'released'; kind?: string; pid?: number; host?: string } | null;
export type Eligibility = { eligible: true; endedAt: number } | { eligible: false; reason: string; log: boolean; diagnose?: true };

// Whether one account needs, and may get, an authenticated recovery now. `log` marks a held session that is refused,
// as opposed to an account with nothing to recover.
// `retried`: a recovery of this exact end has already failed. The supervisor wrote that end before the recovery was
// submitted, so a held attempt newer than it is the recovery child's own session, and no supervisor will write
// another end for it. Live claude-cloud: Fingerblastr's failed recovery left such an attempt, the account waited in
// silence and the retry MAX_ATTEMPTS allows was never submitted.
export function eligibility(v: { proof: LogoutProof; claim: ClaimView; end: EndRecord | undefined; stopText: string | undefined; pidAlive: (pid: number) => boolean; host: string; retried?: boolean }): Eligibility {
    if (v.proof.state !== 'held') return { eligible: false, reason: `logout proof ${v.proof.state}`, log: false };
    if (v.stopText !== undefined && !swarmWroteStop(v.stopText)) return { eligible: false, reason: 'owner stop file holds the account', log: true };
    if (!v.claim || v.claim.phase !== 'held') {
        // No claim holds the account, and its logout is still unproved: a trade worker dropped and fleet sync released
        // its claim (scripts/fleet-sync.ts droppedTradeClaims). The swarm's orphan end names the held attempt and its
        // dead owner (scripts/swarm.ts orphanedSessionEnds), which is what a recovery needs. Live claude-cloud:
        // TrouserSnake and UnderMyKilt stood with no job after such a release until a recovery was submitted by hand.
        if (!v.end) return { eligible: false, reason: 'end record gone; planner diagnosis required', log: true, diagnose: true };
        if (!v.end.reason.startsWith(`exit orphaned: attempt ${v.proof.attemptId} `)) return { eligible: false, reason: 'no held fleet account claim', log: false };
    } else {
        if (v.claim.kind !== 'swarm') return { eligible: false, reason: 'claim is held by a trade order', log: true };
        if (v.claim.host === v.host && typeof v.claim.pid === 'number' && v.pidAlive(v.claim.pid)) return { eligible: false, reason: 'worker still alive', log: false };
    }
    if (!v.end) return { eligible: false, reason: 'end record gone (standing retry window passed); planner diagnosis required', log: true, diagnose: true };
    // The supervisor retries the dropped session before it writes the end; until then the end record is an earlier
    // run's. The attempt id starts with its creation time (packages/core/src/session-lifecycle.ts).
    const started = /^\d{13}-/.test(v.proof.attemptId) ? Number(v.proof.attemptId.slice(0, 13)) : NaN;
    if (v.end.at < started && !v.retried) return { eligible: false, reason: 'waiting: the supervisor has not ended the held attempt', log: false };
    if (/^died\b/.test(v.end.reason)) return { eligible: false, reason: 'death requires diagnosis before recovery', log: true, diagnose: true };
    if (!RECOVERABLE_END.test(v.end.reason)) return { eligible: false, reason: `end reason not recoverable: ${v.end.reason}`, log: true, diagnose: true };
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
// requestAuthenticatedRecovery), which four parallel runs overran. An unstarted run spends no account login attempt.
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

// Only a failed recovery run can spend an account login attempt. A qualification failure touches no live session.
// A run that the controller refused while it waited for memory, a bot slot or the source owner issued no lease and
// touched no session (packages/core/src/session-recovery-dispatch.ts phase `source-owner` or `admission`;
// packages/router/src/coordinator-live.ts awaitBotSlot). It spends no attempt. MAX_WAITS keeps those retries finite.
// A refused setup keeps its own finite wait budget before the planner diagnoses it.
export const MAX_ATTEMPTS = 2, MAX_WAITS = 6;
// The dispatcher's cause names (session-recovery-dispatch.ts setupCauses) of a refusal that only waited.
const WAIT_CAUSES = new Set(['recovery admission waiting: memory', 'recovery admission waiting: maxBots', 'recovery waits for runtime source owner']);
// The coordinator's receipt of a run that preflight refused before it wrote the request (coordinator-live.ts preflight).
// A qualification of an older release has no current native delivery (recoveryQualification, called in the preflight
// before installJob), and the worker refuses a run with no qualification of the current source before runLiveTask
// (coordinator-worker.ts): the release moved after the qualification, and no lease or session was touched.
const WAIT_ERROR = /^Error: (?:live admission waiting: (?:memory|maxBots)|authenticated recovery requires its current native delivery|fresh same-capability native qualification required)$/;
// The run ids that the dispatcher refused while it waited, from the lines of `.practice/swarm-repair.json.results.jsonl`.
// The coordinator receipt keeps only the dispatcher's reason, not its cause. A line that cannot be read is skipped.
export function waitRefusedRuns(results: string): Set<string> {
    const runs = new Set<string>();
    for (const line of results.split('\n')) {
        try {
            const row = JSON.parse(line), r = row?.result;
            if (r?.sessionRecovered !== false || r.reason !== 'recovery setup refused; no lease issued; no retry' || !WAIT_CAUSES.has(r.setup?.cause)) continue;
            const runId = JSON.parse(row.raw)?.runId;
            if (typeof runId === 'string') runs.add(runId);
        } catch { /* not a result line */ }
    }
    return runs;
}
// prepareLiveRecovery throws this exact refusal in beforeRequest, before the controller request is written.
// It holds an existing lease, not a new authenticated attempt. Crossed accounts and other lease failures still count.
const leaseWaitRefused = (t: any) => {
    const r = t.spec?.sessionRecovery;
    return t.spec?.kind === 'run' && t.spec.capability === 'session-recovery-only' && typeof r?.account === 'string'
        && t.spec.account === r.account && t.spec.repairs?.some((p: any) => p.account === r.account && p.endedAt === r.endedAt)
        && t.receipt?.ok === false && t.receipt.output == null
        && t.receipt.error === `Error: account has an unresolved recovery lease: ${r.account}`;
};
const waitRefused = (t: any, waits: ReadonlySet<string>) => t.status === 'failed' && (waits.has(t.runId) || WAIT_ERROR.test(t.receipt?.error ?? '') || leaseWaitRefused(t));
function endRuns(tasks: readonly any[], target: Target) {
    return tasks.filter(t => {
        const r = t?.spec?.sessionRecovery;
        return r?.account?.toLowerCase() === target.account.toLowerCase() && r.endedAt === target.endedAt
            && t.status === 'failed';
    });
}
export function spentAttempts(tasks: readonly any[], target: Target, waits: ReadonlySet<string> = new Set()): number {
    return endRuns(tasks, target).filter(t => !waitRefused(t, waits)).length;
}
export function waitedAttempts(tasks: readonly any[], target: Target, waits: ReadonlySet<string> = new Set()): number {
    return endRuns(tasks, target).filter(t => waitRefused(t, waits)).length;
}

// Compaction moves complete task records to this append-only archive. Replayed rows and the overlap before a state
// save name the same task/run and count once. An unreadable or conflicting outcome cannot grant a fresh budget.
export function retainedRecoveryTasks(root: string, tasks: readonly any[]): any[] {
    const archive = join(root, '.practice/coordinator/archive/tasks.jsonl'), retained: any[] = [];
    try {
        for (const line of readFileSync(archive, 'utf8').split(/\r?\n/)) if (line.trim()) retained.push(JSON.parse(line));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('recovery outcome archive unreadable');
    }
    const outcomes = new Map<string, any>();
    const terminal = (t: any) => ['succeeded', 'failed', 'superseded'].includes(t.status);
    const binding = (t: any) => [t.spec.id, t.spec.kind, t.spec.capability, t.spec.account, t.spec.sessionRecovery, t.spec.repairs];
    for (const t of [...retained, ...tasks]) {
        if (typeof t?.spec?.id !== 'string' || !t.spec.id || !['pending', 'running', 'succeeded', 'failed', 'superseded'].includes(t.status))
            throw Error('recovery outcome archive record invalid');
        if (t.runId !== undefined && (typeof t.runId !== 'string' || !t.runId)) throw Error('recovery outcome archive run invalid');
        // A compacted task id can be submitted again. Its distinct runs each spent their own budget. Tasks that
        // never launched have no run id, so their creation time distinguishes separate submissions.
        const key = t.runId ? `run:${t.runId}` : JSON.stringify(['task', t.spec.id, t.createdAt ?? null]), prior = outcomes.get(key);
        if (prior) {
            if (!isDeepStrictEqual(binding(prior), binding(t))
                || terminal(prior) && terminal(t) && (prior.status !== t.status || prior.receipt?.error !== t.receipt?.error
                    || prior.receipt?.ok !== t.receipt?.ok || !isDeepStrictEqual(prior.receipt?.output ?? null, t.receipt?.output ?? null)))
                throw Error('recovery outcome archive conflict');
        }
        // Preserve the terminal outcome while keeping current records last for dependency lookup by task id.
        outcomes.delete(key); outcomes.set(key, prior && terminal(prior) ? prior : t);
    }
    return [...outcomes.values()];
}

// One unresolved recovery lineage: a failed recovery child stays held, the swarm writes a new orphan end for it with a
// new time (scripts/swarm.ts orphanedSessionEnds), and the next recovery names that new time. The budget of each end
// is then the budget of its whole lineage, or the retries never stop: a per-end count restarts at zero on each new
// orphan end of the same held child.
// An end is child-generated when the attempt that it names (an orphan end) or, for an earlier end, the latest attempt
// at its time is a recovery child: its producer receipt names RECOVERY_SCRIPT, role `recovery` and the coordinator run
// id of a retained recovery request of the same account. The link goes back to the end that this request named. A
// confirmed logout or an ordinary session between that end and the child proves a new lineage, and so does an end
// whose attempt is an ordinary session. A link that cannot be read is unknown, and an unknown link gets no budget.
export type LineageAttempt = { attemptId: string; runId: string | null; script: string; role: string | null; confirmed: boolean } | { attemptId: string; unreadable: true };
export type RecoveryRecord = { runId: string; endedAt: number };
export type Lineage = { ends: number[] } | { unknown: string };
export const MAX_LINEAGE = 64;
const attemptTime = (id: string) => /^\d{13}-/.test(id) ? Number(id.slice(0, 13)) : NaN;
const recoveryChild = (a: Exclude<LineageAttempt, { unreadable: true }>) => a.script === RECOVERY_SCRIPT && a.role === 'recovery';
export function recoveryLineage(end: Pick<EndRecord, 'at' | 'reason'>, attempts: readonly LineageAttempt[], records: readonly RecoveryRecord[]): Lineage {
    const sorted = [...attempts].sort((a, b) => a.attemptId < b.attemptId ? -1 : a.attemptId > b.attemptId ? 1 : 0), ends = [end.at];
    let at = end.at, named = /^exit orphaned: attempt (\S+) /.exec(end.reason)?.[1];
    for (let step = 0; step < MAX_LINEAGE; step++) {
        const attempt = named ? sorted.find(a => a.attemptId === named) : sorted.filter(a => attemptTime(a.attemptId) <= at).at(-1);
        if (!attempt) return named ? { unknown: `attempt ${named} of end ${at} has no lifecycle receipt` } : { ends };
        if ('unreadable' in attempt) return { unknown: `lifecycle receipt ${attempt.attemptId} of end ${at} is unreadable` };
        if (!recoveryChild(attempt)) return { ends };
        const parents = new Set(records.filter(r => r.runId === attempt.runId).map(r => r.endedAt));
        if (parents.size !== 1) return { unknown: `recovery child ${attempt.attemptId} names run ${attempt.runId}, which ${parents.size ? 'retained requests give different ends' : 'no retained recovery request names'}` };
        const parent = [...parents][0]!, created = attemptTime(attempt.attemptId);
        if (!(parent < created) || !(parent < at)) return { unknown: `recovery child ${attempt.attemptId} does not follow its end ${parent}` };
        for (const a of sorted.filter(x => attemptTime(x.attemptId) > parent && attemptTime(x.attemptId) < created)) {
            if ('unreadable' in a) return { unknown: `lifecycle receipt ${a.attemptId} after end ${parent} is unreadable` };
            if (a.confirmed || !recoveryChild(a)) return { ends };
        }
        ends.push(parent); at = parent; named = undefined;
    }
    return { unknown: `lineage of end ${end.at} is longer than ${MAX_LINEAGE} ends` };
}

// The retained recovery requests of one account: the coordinator's run tasks, and every permit and output request
// under the account's recovery folder, also those of a lease moved aside (archiveStaleLease).
export function recoveryRecords(root: string, account: string, tasks: readonly any[]): RecoveryRecord[] {
    const key = account.toLowerCase(), out: RecoveryRecord[] = [];
    const add = (r: any) => { if (typeof r?.runId === 'string' && Number.isFinite(r.endedAt) && typeof r.account === 'string' && r.account.toLowerCase() === key) out.push({ runId: r.runId, endedAt: r.endedAt }); };
    for (const t of tasks) if (t?.spec?.sessionRecovery) add({ runId: t.runId, ...t.spec.sessionRecovery });
    const dir = join(root, '.practice', 'coordinator', 'session-recovery', 'accounts', key);
    let entries: string[] = []; try { entries = readdirSync(dir); } catch { /* no recovery yet */ }
    for (const e of entries) {
        if (/^lease(?:-stale-.*)?\.json$/.test(e)) { add(readJson(join(dir, e), null)?.request); continue; }
        add(readJson(join(dir, e, 'permit.json'), null)?.request);
        add(readJson(join(dir, e, 'output', 'request.json'), null));
        add(readJson(join(dir, e, 'output', 'receipt.json'), null)?.request);
    }
    return out;
}

export function lineageAttempts(root: string, account: string): LineageAttempt[] {
    return listAttempts(account, LIVE_SERVER, { root: lifecycleRootForRead(LIVE_SERVER, root) }).map(({ attemptId, receipt }) => receipt
        ? { attemptId, runId: receipt.owner.coordinatorRunId ?? null, script: receipt.owner.script, role: receipt.owner.role ?? null, confirmed: attemptOutcome(receipt).confirmed }
        : { attemptId, unreadable: true as const });
}

// Why the end may not get another automatic recovery, or undefined. The proposal still names the exact current end;
// only the count runs over the lineage. Waits keep their own budget.
export function budgetRefusal(root: string, account: string, end: Pick<EndRecord, 'at' | 'reason'>, tasks: readonly any[], waits: ReadonlySet<string> = new Set()): string | undefined {
    let lineage: Lineage;
    try { tasks = retainedRecoveryTasks(root, tasks); lineage = recoveryLineage(end, lineageAttempts(root, account), recoveryRecords(root, account, tasks)); }
    catch (e) { lineage = { unknown: `history or lifecycle unreadable: ${String(e).slice(0, 120)}` }; }
    if ('unknown' in lineage) return `recovery lineage of end ${end.at} unknown (${lineage.unknown}); planner diagnosis required`;
    const sum = (f: typeof spentAttempts) => lineage.ends.reduce((n, endedAt) => n + f(tasks, { account, endedAt }, waits), 0);
    const of = lineage.ends.length > 1 ? `end ${end.at} and the ${lineage.ends.length - 1} earlier ends of its lineage (first ${lineage.ends.at(-1)})` : `end ${end.at}`;
    if (sum(spentAttempts) >= MAX_ATTEMPTS) return `${MAX_ATTEMPTS} recoveries of ${of} failed; planner diagnosis required`;
    if (sum(waitedAttempts) >= MAX_WAITS) return `${MAX_WAITS} recoveries of ${of} waited on memory, a bot slot, the source owner or an unresolved recovery lease; planner diagnosis required`;
    return undefined;
}

export interface RecoveryPlanningFailure {
    taskId: string; runId?: string; kind: string; source?: string; failedCheck?: string; error?: string; deliveryDirectory?: string; settledAt?: number;
}
export interface RecoveryPlanningProblem {
    schema: 'recovery-planning/1'; account: string; server: string; endedAt: number | null; lineage: Lineage; reason: string;
    failures: RecoveryPlanningFailure[]; pendingTaskIds: string[];
}
const boundedText = (value: unknown, limit: number): string | undefined => typeof value === 'string' ? value.slice(0, limit) : undefined;

// A failed source needs diagnosis before another automatic qualification or session. The planner owns any changed
// repair, its practice proof and the finite retry. A newer accepted delivery can support that retry without deleting
// the failed receipt or granting another login budget.
export function recoveryPlanningProblem(root: string, account: string, end: Pick<EndRecord, 'at' | 'reason'> | undefined, tasks: readonly any[], refusal?: string, waits: ReadonlySet<string> = new Set()): RecoveryPlanningProblem | undefined {
    let lineage: Lineage;
    try { lineage = end ? recoveryLineage(end, lineageAttempts(root, account), recoveryRecords(root, account, tasks)) : { unknown: 'end record unavailable' }; }
    catch (error) { lineage = { unknown: `history or lifecycle unreadable: ${String(error).slice(0, 120)}` }; }
    const ends = new Set('ends' in lineage ? lineage.ends : end ? [end.at] : []), records = new Map(tasks.map(t => [t.spec.id, t]));
    const runs = tasks.filter(t => t.spec?.sessionRecovery?.account?.toLowerCase() === account.toLowerCase() && ends.has(t.spec.sessionRecovery.endedAt));
    const relevant = new Map<string, any>();
    for (const run of runs) {
        if (run.status === 'failed' && !waitRefused(run, waits)) relevant.set(run.spec.id, run);
        const seen = new Set<string>(), visit = [...(run.spec.dependsOn ?? [])];
        while (visit.length) {
            const id = visit.pop()!; if (seen.has(id)) continue; seen.add(id);
            const dep = records.get(id); if (!dep) continue;
            if (dep.spec.capability === 'session-recovery-only' && ['qualify', 'build'].includes(dep.spec.kind) && dep.status === 'failed') relevant.set(id, dep);
            visit.push(...(dep.spec.dependsOn ?? []));
        }
    }
    const newerDelivery = (failure: any) => tasks.some(t => t.status === 'succeeded' && t.spec?.capability === 'session-recovery-only'
        && t.receipt?.output?.delivery?.ok === true && t.receipt.at > (failure.receipt?.at ?? Infinity));
    const failures = [...relevant.values()].filter(t => !newerDelivery(t)).sort((a, b) => (b.receipt?.at ?? 0) - (a.receipt?.at ?? 0) || a.spec.id.localeCompare(b.spec.id)).slice(0, 8).map(t => {
        const delivery = t.receipt?.output?.delivery;
        const failure: RecoveryPlanningFailure = { taskId: t.spec.id, kind: t.spec.kind };
        if (Number.isFinite(t.receipt?.at) && t.receipt.at > 0) failure.settledAt = t.receipt.at;
        if (typeof t.runId === 'string') failure.runId = t.runId;
        if (typeof delivery?.source === 'string') failure.source = delivery.source.slice(0, 64);
        const failedCheck = boundedText(delivery?.failedCheck, 160), error = boundedText(t.receipt?.error ?? t.receipt?.output?.error ?? delivery?.reason, 600), directory = boundedText(delivery?.directory, 1000);
        if (failedCheck !== undefined) failure.failedCheck = failedCheck;
        if (error !== undefined) failure.error = error;
        if (directory !== undefined) failure.deliveryDirectory = directory;
        return failure;
    });
    if (!refusal && !failures.length) return undefined;
    return { schema: 'recovery-planning/1', account, server: LIVE_SERVER, endedAt: end?.at ?? null,
        lineage: 'unknown' in lineage ? { unknown: lineage.unknown.slice(0, 600) } : lineage,
        reason: (refusal ?? 'A recovery prerequisite or session failed.').slice(0, 600),
        failures, pendingTaskIds: runs.filter(t => t.status === 'pending').map(t => t.spec.id).sort().slice(0, 24) };
}

// Immutable facts are a planner input, not a second queue. Equivalent failures have one identity even when another
// task, run or random delivery directory names them. The current end stays in the key because the planner matches
// that exact actionable end. A new immutable receipt settlement identifies a fresh occurrence of the same fault.
export function requestRecoveryPlanning(root: string, problem: RecoveryPlanningProblem): boolean {
    const lineageRoot = 'ends' in problem.lineage ? Math.min(...problem.lineage.ends) : problem.endedAt;
    const evidence = [...new Set(problem.failures.map(f => JSON.stringify([f.kind, f.source ?? null, f.failedCheck ?? null, f.error ?? null,
        typeof f.settledAt === 'number' && Number.isFinite(f.settledAt) && f.settledAt > 0 ? f.settledAt : null])))].sort();
    const key = createHash('sha256').update(JSON.stringify([problem.account.toLowerCase(), problem.server, lineageRoot, problem.endedAt, evidence,
        'unknown' in problem.lineage ? problem.lineage.unknown : null])).digest('hex');
    const dir = join(root, '.practice', 'cloud-recover', 'planning'); mkdirSync(dir, { recursive: true });
    const file = join(dir, key + '.json');
    try { writeFileSync(file, JSON.stringify(problem, null, 1) + '\n', { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
    const coord = join(root, '.practice', 'coordinator'); mkdirSync(coord, { recursive: true });
    writeFileSync(join(coord, 'plan-request'), 'Diagnose recovery facts in ' + file);
    return true;
}

// The folder that receives the coordinator's parked jobs and stop file after a release.
// The session-lifecycle root that readLogoutProof reads (packages/core/src/session-lifecycle.ts DEFAULT_LIFECYCLE_ROOT).
export const lifecycleRoot = (root: string) => liveLifecycleRoot(root);

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

// The local side's coordinator owns real work in its jobs.json; only a cloud side waits for the runs and restarts its
// coordinator to release the parked jobs.
export const cloudSide = (side: string) => side !== 'local';

// The accounts that stay offline (scripts/swarm.ts PROTECTED_ACCOUNTS; the coordinator refuses a recovery of the
// first three, packages/router/src/coordinator.ts). The swarm records no end for them, so eligibility refuses them
// already; this list keeps them out of a proposal even with an end record written by hand.
export const NEVER_RECOVERED = [...RESERVED_ACCOUNTS, 'afknight'];

// A recovery run names the exact time of its end record, and its qualify takes about 9 minutes. The local swarm's
// standing retry deletes a blocked, gave-up or stopped end once the account's status is BOOTSTRAP_STATUS_AGE_MS old
// (scripts/swarm.ts standingRetryDue); the retry fails on the held claim and a later end gets a new time, so a run
// that names the deleted end fails `exact failure changed`. The retry never takes an orphan end, so that time holds.
// Any other end is taken once the retry window is over.
export const END_SETTLE_MS = BOOTSTRAP_STATUS_AGE_MS + 5 * 60_000;
export function endSettled(end: Pick<EndRecord, 'at' | 'reason'>, now: number): boolean {
    return end.reason.startsWith('exit orphaned: attempt ') || now - end.at >= END_SETTLE_MS;
}

// A submitted proposal is a `.request.json` file until the coordinator takes it into its state (coordinator-cli.ts
// intakeRequests). Until then state.json shows no recovery in flight, and a second call would submit the same
// accounts again. A file that cannot be read counts as waiting.
export function recoveryRequestWaiting(requests: string): boolean {
    let files: string[]; try { files = readdirSync(requests); } catch { return false; }
    return files.filter(f => f.endsWith('.request.json')).some(f => {
        try { return (JSON.parse(readFileSync(join(requests, f), 'utf8'))?.tasks ?? []).some((t: any) => t?.sessionRecovery); } catch { return true; }
    });
}

const readJson = (file: string, fallback: any) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
const log = (line: string) => console.log(`CLOUD_RECOVER ${line}`);

async function main(root: string, dry: boolean, account?: string): Promise<number> {
    const res = await runStandaloneRecoveryPass({ root, dry, ...(account ? { account } : {}), log });
    return res.ok ? 0 : 1;
}

if (import.meta.main) {
    const rootArg = process.argv.find(a => a.startsWith('--root='))?.slice(7);
    const accountArg = process.argv.find(a => a.startsWith('--account='))?.slice(10);
    process.exit(await main(resolve(rootArg ?? join(import.meta.dir, '..')), process.argv.includes('--dry'), accountArg));
}
