// Fleet control helper: constrain bounded recovery and bank inspection to explicitly selected owned accounts.
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertBoundedRecoveryAssignments, validateBoundedRecovery, type RecoveryTarget } from '../../core/src/bounded-recovery';
import { readFleetAccountClaim } from '../../core/src/fleet-trade-claim';
import { liveRoot } from '../../core/src/practice-paths';
import { missionSignature, successfulEnd } from '../../core/src/session-admission';
import { listAttempts, readLogoutProof } from '../../core/src/session-lifecycle';
import { capabilityRevision } from '../../core/src/worker-release';
import { assessRecoveryEligibility, clearSwarmStops, LIVE_SERVER } from './session-recovery';
import { failedScript, loadEnded, persistentEnd, startable } from './swarm';
import { jobAccounts } from './trade-plan';

export { clearSwarmStops };

export function boundedRecoveryPlan(plan: any, targets: RecoveryTarget[], owned: readonly string[], now = Date.now()) {
    const scope = validateBoundedRecovery({
        targets,
    });
    const names = new Set(owned.map(n => n.toLowerCase())), selected = new Set(targets.map(t => t.account.toLowerCase()));
    if (targets.some(t => !names.has(t.account.toLowerCase())) || plan.maxBots !== 4 || plan.minFreeGB !== 4
        || !Array.isArray(plan.jobs) || plan.jobs.length !== owned.length) {
        throw Error('bounded recovery owner plan or limits changed');
    }
    const seen = new Set<string>();
    for (const job of plan.jobs) {
        const accounts = jobAccounts(job), key = accounts[0]?.toLowerCase() ?? '';
        if (accounts.length !== 1 || !names.has(key) || seen.has(key) || job.autopilot || job.standing || job.host || job.orchestrate || job.repeat !== false) {
            throw Error('bounded recovery assignment changed');
        }
        seen.add(key);
        if (selected.has(key)) {
            if (job.script !== 'scripts/aio-logistics.ts' || job.args?.[0] !== 'inspect' || job.maxRestarts !== 0 || job.standingRetry !== false || job.env?.LOOT_WATCH !== '0' || job.env?.RANDOM_EVENTS !== '0') {
                throw Error('bounded recovery inspector changed');
            }
        } else if (job.enabled !== false || job.script || job.role !== 'reserved') {
            throw Error('bounded recovery reservation changed');
        }
    }
    return {
        ...plan,
        jobs: plan.jobs.map((j: any) => selected.has(j.account.toLowerCase()) ? { ...j, enabled: false } : j),
        boundedRecovery: { ...scope, at: now },
    };
}

export function prepareBoundedRecovery(base: string, plan: any, targets: RecoveryTarget[], owned: readonly string[], side: string, now = Date.now()) {
    const next = boundedRecoveryPlan(plan, targets, owned, now);
    assertBoundedRecoveryAssignments(next.boundedRecovery, next.jobs);
    if (existsSync(join(liveRoot(base), 'build-lock.json'))) throw Error('bounded recovery refuses an active build lock');
    const ended = loadEnded(join(base, '.practice/swarm-deaths.json'));
    for (const target of targets) {
        const proof = readLogoutProof(target.account, LIVE_SERVER, { root: join(base, '.practice/session-lifecycle') });
        if (proof.state !== 'held' || proof.attemptId !== target.attemptId) throw Error('bounded recovery exact producer changed');
        const end = ended.get(target.account);
        if (!end || end.at !== target.endedAt) throw Error('bounded recovery exact failure changed');
        const file = join(base, '.practice', 'stop-' + target.account), stopText = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
        const claim = readFleetAccountClaim(base, { account: target.account, server: LIVE_SERVER });
        if (!claim || claim.side !== side) throw Error('bounded recovery claim ownership changed');
        const e = assessRecoveryEligibility({
            proof,
            claim,
            end,
            stopText,
            host: hostname(),
            pidAlive: pid => { try { process.kill(pid, 0); return true; } catch { return false; } },
        });
        if (!e.eligible) throw Error('bounded recovery ineligible: ' + e.reason);
    }
    return next;
}

export function assertCompletedInspectionMission(v: {
    account: string; proof: any; producer: any; end: any; prior: any; bound: any; target: RecoveryTarget; job: any; source: string;
}) {
    const { account, proof, producer, end, prior, bound, target, job, source } = v;
    const receipt = producer?.receipt, status = prior?.receipt?.output?.status ?? {};
    if (
        proof.state !== 'confirmed' || producer?.sha256 !== proof.receiptSha256 || !receipt || !prior || prior.status !== 'succeeded' || prior.receipt?.ok !== true
        || prior.spec?.account !== account || prior.spec?.sessionRecovery?.endedAt !== target.endedAt || prior.runId !== proof.ownerRun
        || (status.sessionAttemptId && status.sessionAttemptId !== proof.attemptId)
        || (status.workRevision && status.workRevision !== source)
        || receipt.owner.script !== 'scripts/session-check.ts' || receipt.owner.workerRelease !== source || !successfulEnd(end.reason)
        || !bound?.targets?.some((t: RecoveryTarget) => t.account === account && t.attemptId === target.attemptId && t.endedAt === target.endedAt)
        || failedScript(end) !== 'scripts/session-check.ts' || receipt.updatedAt > end.at || job.script !== 'scripts/aio-logistics.ts' || job.args?.[0] !== 'inspect'
    ) throw Error('bounded inspection completed recovery identity changed');
    const revision = missionSignature({ ...job, env: { ...job.env, REQUIRE_BANK: '1' } });
    if (!startable([account], false, new Map([[account, end]]), () => Infinity, undefined, revision).start.includes(account)) {
        throw Error('bounded inspection needs a different completed mission');
    }
}

export function prepareBoundedInspection(base: string, plan: any, targets: RecoveryTarget[], owned: readonly string[], side: string) {
    const staged = boundedRecoveryPlan(plan, targets, owned), accounts = targets.map(t => t.account);
    const ends = loadEnded(join(base, '.practice/swarm-deaths.json'));
    const boundPath = join(base, '.practice/cloud-side', side, 'recovery-plan.json');
    const bound = existsSync(boundPath) ? JSON.parse(readFileSync(boundPath, 'utf8')).boundedRecovery : { targets };
    for (const account of accounts) {
        const proof = readLogoutProof(account, LIVE_SERVER, { root: join(base, '.practice/session-lifecycle') });
        const claim = readFleetAccountClaim(base, { account, server: LIVE_SERVER });
        if (proof.state !== 'confirmed' || !claim || claim.side !== side || claim.phase !== 'released') {
            throw Error('bounded inspection needs current confirmed logout and released claim');
        }
        const end = ends.get(account);
        if (!end || persistentEnd(end.reason) || !successfulEnd(end.reason)) {
            throw Error('bounded inspection end still requires controller repair or completed recovery');
        }
        const producer = listAttempts(account, LIVE_SERVER, { root: join(base, '.practice/session-lifecycle') }).find(a => a.attemptId === proof.attemptId);
        const target = targets.find(t => t.account === account)!;
        const job = staged.jobs.find((j: any) => j.account === account);
        const source = capabilityRevision(['scripts/session-check.ts'], base);
        const prior = {
            status: 'succeeded',
            runId: proof.ownerRun ?? null,
            spec: { id: `recover-${account.toLowerCase()}`, account, sessionRecovery: { endedAt: target.endedAt } },
            receipt: { ok: true, output: { status: { sessionAttemptId: proof.attemptId, workRevision: source } } },
        };
        assertCompletedInspectionMission({ account, proof, producer, end, prior, bound, target, job, source });
    }
    return {
        ...staged,
        jobs: staged.jobs.map((j: any) => accounts.includes(j.account) ? { ...j, env: { ...j.env, REQUIRE_BANK: '1' } } : j),
        boundedInspection: accounts,
    };
}

export async function releaseForBoundedInspection(
    base: string,
    plan: any,
    targets: RecoveryTarget[],
    owned: readonly string[],
    side: string,
    release?: () => boolean | Promise<boolean>,
) {
    if (release) {
        if (!await release()) throw Error('bounded inspection assignments still held');
    }
    return prepareBoundedInspection(base, plan, targets, owned, side);
}
