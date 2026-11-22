// Recovery authority validation, immutable permit issuance, child PID binding, and consistency checks.
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readMergedPlan } from '../coordinator-jobs';
import { processMatchesRecent } from '../proc';
import { listAttempts, readLogoutProof } from '../session-lifecycle';
import { missionSignature, successfulEnd } from '../session-mission';
import { savedProcessAlive } from '../session-takeover';
import { cachedLaunchRevision, capabilityRevision } from '../worker-release';
import { assertFleetResolved, evidence, verifyNativeRecoveryProof } from './qualification';
import {
    RECOVERY_SCRIPT, assertNativeFixtureRoot, assertNoRecoveryLease, assertRecoveryNotStopped, json,
    recoveryPermitPaths, same, sha, validateRecoveryRequest,
    type ControlledRecoveryRequest, type Permit, type ProducerRef, type RecoveryPermitChecks,
} from './request';

// The current capability release of a delivery task's entry, read as data (runtime core must not import the router).
function capabilityRelease(capability: unknown, base: string): string | undefined {
    try {
        if (typeof capability !== 'string' || !/^[a-z0-9-]+$/.test(capability)) return undefined;
        const definition = json(join(base, 'packages/router/tasks', capability + '.json'));
        return definition.id === capability && typeof definition.entry === 'string' ? capabilityRevision([definition.entry], base) : undefined;
    } catch { return undefined; }
}

function authority(r: ControlledRecoveryRequest, base: string, options: RecoveryPermitChecks, issuing = false, ownedChild = false) {
    validateRecoveryRequest(r); if (r.kind !== 'session-recovery') throw Error('not a controlled recovery request');
    if (options.nativeFixture) assertNativeFixtureRoot(base, r.server);
    // Observation of the owners, not kill authorization: the cached lookup is allowed here (see proc.ts).
    const now = (options.now ?? Date.now)(), matches = options.matches ?? processMatchesRecent;
    const owner = json(join(base, '.practice/coordinator/swarm-owner.json'));
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.nonce !== 'string' || !owner.nonce
        || owner.source !== r.source || !matches(owner.pid, owner.nonce) || (issuing && owner.pid !== process.pid)) throw Error('recovery controller owner changed');
    if ((options.source ?? (() => cachedLaunchRevision(base)))() !== r.source) throw Error('recovery source changed');
    assertRecoveryNotStopped(r.account, base);
    const record = json(join(base, '.practice/coordinator/state.json')).tasks?.find((t: any) => t.status === 'running' && t.runId === r.runId);
    const spec = record?.spec, authorization = spec?.sessionRecovery;
    if (spec?.kind !== 'run' || !same(spec.account, r.account) || !same(authorization?.account, r.account) || authorization?.endedAt !== r.endedAt
        || !spec.repairs?.some((p: any) => same(p.account, r.account) && p.endedAt === r.endedAt)) throw Error('recovery task authorization missing');
    const taskOwner = json(join(base, '.practice/coordinator/runs', r.runId, 'owner.json'));
    if (taskOwner.runId !== r.runId || taskOwner.pid !== record.pid || !matches(taskOwner.pid, r.runId)) throw Error('recovery task owner changed');
    const requestLease = json(join(base, '.practice/swarm-repair.json.lease'));
    if (requestLease.pid !== taskOwner.pid || requestLease.runId !== r.runId || requestLease.nonce !== r.nonce) throw Error('recovery request lease changed');
    const end = Object.entries(json(join(base, '.practice/swarm-deaths.json'))).find(([a]) => same(a, r.account))?.[1] as any;
    const completed = successfulEnd(end?.reason ?? '');
    if (end?.at !== r.endedAt || !completed && !/^(?:blocked|died|gave-up|exit|no-progress|stopped)(?:\b| )/.test(end.reason ?? '')) throw Error('recovery exact failure changed');
    const assignments = readMergedPlan(base).jobs.filter((j: any) => (j.accounts ?? [j.account]).some((a: any) => same(a, r.account)));
    if (assignments.some((j: any) => j.enabled || !j.script || /fresh.clock|24 boards|main simultaneous/i.test(j.goal ?? ''))) throw Error('recovery assignment is active or reserved');
    let missionRevision: string | undefined;
    if (completed) {
        // Only an ordinary retired assignment may bootstrap a new mission. Cleanup never clears its successful end.
        if (assignments.length !== 1 || assignments[0].enabled !== false || assignments[0].host || assignments[0].orchestrate || assignments[0].accounts
            || spec.participants?.length || spec.launch) throw Error('recovery completed assignment is not ordinary retired work');
        const holdsPath = join(base, '.practice/swarm-script-holds.json'), holds = existsSync(holdsPath) ? json(holdsPath) : [];
        if (!Array.isArray(holds) || holds.some((h: any) => !h || typeof h.account !== 'string' || same(h.account, r.account))) throw Error('recovery completed account has an open hold');
        if (!/^[a-z0-9-]+$/.test(spec.capability ?? '')) throw Error('recovery completed mission unavailable');
        // Read the existing definition as data; runtime core must not import the router.
        const definition = json(join(base, 'packages/router/tasks', spec.capability + '.json'));
        if (definition.id !== spec.capability || typeof definition.entry !== 'string' || !/^scripts\/[A-Za-z0-9_/-]+\.ts$/.test(definition.entry)) throw Error('recovery completed mission unavailable');
        missionRevision = missionSignature({ account: r.account, script: definition.entry, args: spec.args ?? [], env: { ...spec.env, CAP: spec.env?.CAP ?? '1600', COORDINATOR_RUN_ID: r.runId } });
        if (typeof end.revision !== 'string' || !end.revision || end.revision === missionRevision) throw Error('recovery completed work needs a different mission');
    }
    assertFleetResolved(join(base, '.practice/swarm-state.json'), r.account, owner.pid, options.now ?? Date.now);
    const statusFile = join(base, '.practice/status', r.account + '.json'), status = existsSync(statusFile) ? json(statusFile) : null;
    if (status && status.server === r.server && !status.result && (!Number.isFinite(status.at) || now - status.at < 30000)) throw Error('recovery account has an active external observation');
    const lifecycleRoot = join(base, '.practice/session-lifecycle'), latest = readLogoutProof(r.account, r.server, { root: lifecycleRoot });
    if (latest.state === 'invalid') throw Error('recovery lifecycle ownership malformed');
    if (latest.state === 'none' && status?.server === r.server && !status.result) throw Error('recovery orphan owner unknown');
    if (latest.state === 'held') {
        const attempt = listAttempts(r.account, r.server, { root: lifecycleRoot }).find(a => a.attemptId === latest.attemptId)?.receipt;
        if (!Number.isSafeInteger(attempt?.owner.pid) || attempt!.owner.pid < 1) throw Error('recovery orphan owner unknown');
        const own = ownedChild && attempt!.owner.pid === process.pid && attempt!.owner.coordinatorRunId === r.runId && attempt!.owner.workerRelease === r.source && attempt!.owner.script === RECOVERY_SCRIPT;
        // A live id proves an owner only when its process started before the attempt (savedProcessAlive): the system
        // gives the id of an ended worker to a later process, and that process is not the owner.
        if (!own && savedProcessAlive(attempt!.owner.pid, attempt!.createdAt, options.processStarts, options.pidAlive)) throw Error('recovery previous session owner still alive');
    }
    const runnerSha256 = sha(readFileSync(join(base, RECOVERY_SCRIPT)));
    if (!options.nativeFixture) {
        const delivery = evidence(r.qualification?.delivery, base), proof = evidence(r.qualification?.proof, base);
        const gate = delivery.checks?.find((c: any) => c.id === 'native-session-recovery' && c.phase === 'practice');
        // The delivery records its capability release (delivery-cli.ts); the native proof and r.source are the launch release.
        if (delivery.ok !== true || delivery.stage !== 'delivered' || delivery.id !== spec.capability || typeof delivery.runtimeRevision !== 'string' || delivery.runtimeRevision !== (options.capability ?? (c => capabilityRelease(c, base)))(spec.capability)
            || !Number.isFinite(delivery.at) || delivery.at <= r.endedAt || delivery.at > now
            || !gate || delivery.checks.some((c: any) => c.exitCode !== 0 || c.timedOut)
            || proof.ok !== true) throw Error('recovery lacks current controller-native qualification');
        verifyNativeRecoveryProof(proof, dirname(realpathSync(resolve(base, r.qualification.proof.path))), { runtimeRevision: r.source, runnerSha256 });
        const logPath = realpathSync(JSON.parse(gate.detail).stdout), deliveryDir = dirname(realpathSync(resolve(base, r.qualification.delivery.path))) + sep;
        if (!logPath.startsWith(deliveryDir)) throw Error('recovery native output outside delivery');
        const markers = readFileSync(logPath, 'utf8').split(/\r?\n/).filter(l => l.startsWith('RECOVERY_NATIVE_PROOF '));
        if (markers.length !== 1) throw Error('recovery native proof is not linked to its gate');
        const emitted = JSON.parse(markers[0]!.slice('RECOVERY_NATIVE_PROOF '.length));
        if (emitted.sha256 !== r.qualification.proof.sha256 || realpathSync(resolve(base, emitted.path)) !== realpathSync(resolve(base, r.qualification.proof.path))) throw Error('recovery native proof gate binding changed');
    }
    return { owner: { pid: owner.pid, nonce: owner.nonce, source: owner.source }, now, runnerSha256, completedEnd: completed ? end : undefined, missionRevision, latest };
}

// The controller publishes a complete immutable permit, then atomically claims the account.
// A crash, malformed marker or failed child leaves its lease held. This module never clears an end or retries.
export function issueRecoveryPermit(r: ControlledRecoveryRequest, base: string, options: RecoveryPermitChecks = {}): Permit {
    const checked = authority(r, base, options, true), paths = recoveryPermitPaths(r, base);
    let producerHistory: ProducerRef[] | undefined;
    if (checked.completedEnd) {
        const attempts = listAttempts(r.account, r.server, { root: join(base, '.practice/session-lifecycle') }), last = attempts.at(-1), a = last?.receipt;
        // A retired producer that reached START but disconnected needs cleanup, not a new owner for its history.
        // authority already checks that its owner is gone. Partial intents and confirmed histories stay refused.
        const held = checked.latest.state === 'held' && checked.latest.attemptId === last?.attemptId && a
            && attempts.every(t => t.receipt && same(t.receipt.account, r.account) && t.receipt.server === r.server && t.receipt.attemptId === t.attemptId)
            && a.createdAt <= a.updatedAt && a.updatedAt <= r.endedAt
            && a.events.some(e => e.kind === 'ready') && a.events.find(e => e.kind === 'ended')?.detail === 'disconnected'
            && a.events.filter(e => e.kind === 'logout').at(-1)?.detail === 'disconnected';
        if (!(checked.latest.state === 'none' && attempts.length === 0) && !held) throw Error('recovery completed account already has producer history');
        producerHistory = attempts.map(({ attemptId, sha256 }) => ({ attemptId, sha256 }));
    }
    assertNoRecoveryLease(r.account, base);
    const permit: Permit = {
        schema: 'session-recovery-permit/1',
        request: r,
        controller: checked.owner,
        issuedAt: checked.now,
        expiresAt: checked.now + 150000,
        runnerSha256: checked.runnerSha256,
        nativeFixture: !!options.nativeFixture,
        ...(checked.completedEnd ? { completedEnd: checked.completedEnd, missionRevision: checked.missionRevision, producerHistory } : {}),
    };
    mkdirSync(dirname(paths.permit), { recursive: true });
    writeFileSync(paths.permit, JSON.stringify(permit), { flag: 'wx' });
    linkSync(paths.permit, paths.lease);
    return permit;
}

export function current(r: ControlledRecoveryRequest, base: string, options: RecoveryPermitChecks, controller = false, ownedChild = false): Permit {
    const checked = authority(r, base, options, controller, ownedChild), paths = recoveryPermitPaths(r, base), p = json(paths.permit);
    if (!isDeepStrictEqual(p.completedEnd, checked.completedEnd) || p.missionRevision !== checked.missionRevision) throw Error('recovery completed end or mission changed');
    if (p.completedEnd) {
        const attempts = listAttempts(r.account, r.server, { root: join(base, '.practice/session-lifecycle') });
        const history: ProducerRef[] = p.producerHistory ?? [], retained = attempts.slice(0, history.length).map(({ attemptId, sha256 }) => ({ attemptId, sha256 }));
        if (!isDeepStrictEqual(history, retained)) throw Error('recovery completed producer ownership changed');
        const fresh = attempts.slice(history.length);
        if (fresh.length) {
            const child = existsSync(paths.child) ? json(paths.child) : null, used = existsSync(paths.used) ? json(paths.used) : null, a = fresh[0]?.receipt;
            if (fresh.length !== 1 || !a || child?.pid !== used?.pid || used?.nonce !== r.nonce || a.createdAt < p.issuedAt
                || !('attemptId' in checked.latest) || checked.latest.attemptId !== fresh[0]?.attemptId
                || a.owner.pid !== child.pid || a.owner.coordinatorRunId !== r.runId || a.owner.workerRelease !== r.source || a.owner.script !== RECOVERY_SCRIPT)
                throw Error('recovery completed producer ownership changed');
        } else if (history.length ? checked.latest.state !== 'held' || checked.latest.attemptId !== history.at(-1)?.attemptId : checked.latest.state !== 'none') throw Error('recovery completed producer ownership changed');
    }
    if (p.schema !== 'session-recovery-permit/1' || p.nativeFixture !== !!options.nativeFixture || !isDeepStrictEqual(p.request, r) || !isDeepStrictEqual(p.controller, checked.owner)
        || p.runnerSha256 !== checked.runnerSha256 || !Number.isFinite(p.issuedAt) || p.issuedAt > checked.now || p.expiresAt !== p.issuedAt + 150000 || checked.now >= p.expiresAt
        || sha(readFileSync(paths.lease)) !== sha(readFileSync(paths.permit))) throw Error('recovery permit expired or changed');
    return p;
}

export function bindRecoveryChild(r: ControlledRecoveryRequest, pid: number, base: string, options: RecoveryPermitChecks = {}) {
    current(r, base, options, true); if (!Number.isSafeInteger(pid) || pid < 1) throw Error('invalid recovery child');
    writeFileSync(recoveryPermitPaths(r, base).child, JSON.stringify({ pid, nonce: r.nonce, runId: r.runId }), { flag: 'wx' });
}
