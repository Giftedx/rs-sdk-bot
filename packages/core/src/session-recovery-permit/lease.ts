// Expired recovery lease release sweeps and inherited recovery child ownership checks.
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { commandLine, processMatchesRecent, processStartTimes } from '../proc';
import { listAttempts, readLogoutProof } from '../session-lifecycle';
import { savedProcessAlive, type ProcessStarts } from '../session-takeover';
import {
    RECOVERY_SCHEMA, RECOVERY_SCRIPT, assertNativeFixtureRoot, assertRecoveryNotStopped, json,
    recoveryPermitPaths, same, sha, validateRecoveryRequest, type ControlledRecoveryRequest,
} from './request';

// A child that did not confirm preserved cleanup leaves its lease held (finishRecoveryPermit), and assertNoRecoveryLease
// then refuses every later session and recovery of the account. The controller removes only that exact lease: its
// permit has expired, its bound child is gone, and the newest session attempt of the account has matching producer
// evidence. A confirmed logout (readLogoutProof) must show one of three things:
// - It is the child's own attempt, and the child's receipt names it.
// - `superseded`: a different run made it after the permit was issued. That session got into the account and left it,
//   so the dead child holds nothing.
// - `not-connected`: it is older than the permit, so the account has no attempt from the permit's time. Each session
//   writes its attempt before it connects (openBot), so the child did not connect. The child's receipt, if it wrote
//   one, must say that it did not try to log out.
// A held attempt may instead be the child's exact connect-failed receipt, with matching failed output and no ready,
// end or logout event. Archiving that lease permits another recovery request, never an ordinary repair or success.
// Any other evidence keeps the lease. The release writes released.json and keeps the permit, child, used, output, end,
// assignments and stops. It never writes completed.json, so recoveredSessionForRun still refuses this run. A later
// call completes a release that stopped after it wrote released.json.
export type LeaseReleaseChecks = { now?: () => number; matches?: (pid: number, marker: string) => boolean; childAlive?: (pid: number, nonce: string) => boolean };
const childRunning = (pid: number, nonce: string) => {
    try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false; }
    // A reused PID without the child's nonce on its command line is not the child. An unreadable command line counts as live.
    const line = commandLine(pid); return line === null || line.includes(nonce);
};

export function releaseExpiredRecoveryLease(account: string, base: string, options: LeaseReleaseChecks = {}) {
    if (!/^[A-Za-z0-9_ -]{1,12}$/.test(account)) throw Error('invalid recovery lease identity');
    const now = (options.now ?? Date.now)(), matches = options.matches ?? processMatchesRecent, alive = options.childAlive ?? childRunning;
    const owner = json(join(base, '.practice/coordinator/swarm-owner.json'));
    if (owner.pid !== process.pid || typeof owner.nonce !== 'string' || !owner.nonce || !matches(owner.pid, owner.nonce)) throw Error('recovery lease release needs the controller');
    const leasePath = join(base, '.practice/coordinator/session-recovery/accounts', account.toLowerCase(), 'lease.json');
    if (!existsSync(leasePath)) throw Error('recovery lease absent');
    const leaseRaw = readFileSync(leasePath), p = JSON.parse(leaseRaw.toString('utf8')), r = p?.request as ControlledRecoveryRequest;
    validateRecoveryRequest(r); if (!same(r.account, account) || r.kind !== 'session-recovery') throw Error('recovery lease crossed');
    const paths = recoveryPermitPaths(r, base), leaseSha256 = sha(leaseRaw);
    if (!existsSync(paths.permit) || sha(readFileSync(paths.permit)) !== leaseSha256 || p.schema !== 'session-recovery-permit/1') throw Error('recovery lease changed');
    if (p.nativeFixture) assertNativeFixtureRoot(base, r.server);
    if (!Number.isFinite(p.issuedAt) || p.expiresAt !== p.issuedAt + 150000 || now < p.expiresAt) throw Error('recovery permit not expired');
    assertRecoveryNotStopped(r.account, base);
    const child = existsSync(paths.child) ? json(paths.child) : null, used = existsSync(paths.used) ? json(paths.used) : null;
    if (!child || !Number.isSafeInteger(child.pid) || child.pid < 1 || child.nonce !== r.nonce || child.runId !== r.runId
        || !used || used.pid !== child.pid || used.nonce !== r.nonce || used.permitSha256 !== leaseSha256) throw Error('recovery lease child not bound');
    if (alive(child.pid, r.nonce)) throw Error('recovery lease child still alive');
    const root = join(base, '.practice/session-lifecycle'), proof = readLogoutProof(r.account, r.server, { root });
    const attempts = listAttempts(r.account, r.server, { root });
    const receiptPath = join(paths.output, 'receipt.json'), receipt = existsSync(receiptPath) ? json(receiptPath) : null;
    let basis: null | 'superseded' | 'not-connected' | 'connect-failed' | undefined, lifecycleSha256: string;
    if (proof.state === 'held') {
        // The newest session is still the one that the child came to recover, and the child began none of its own: the
        // child changed nothing. Only another recovery can end that session, and this lease refuses each one.
        const held = attempts.find(x => x.attemptId === proof.attemptId);
        const heldSha256 = held?.sha256;
        if (!held?.receipt || !heldSha256) throw Error('recovery lease producer logout not confirmed');
        const a = held.receipt;
        const failedConnect = proof.reason === 'connect failed without an observed end' && same(a.account, r.account) && a.server === r.server && a.domain === proof.domain
            && a.owner.pid === child.pid && a.owner.coordinatorRunId === r.runId && a.owner.workerRelease === r.source && a.owner.script === RECOVERY_SCRIPT && a.owner.role === 'recovery'
            && a.events.length === 2 && a.events[0]?.kind === 'connecting' && a.events[0].at === a.createdAt
            && a.events[1]?.kind === 'connect-failed' && a.events[1].at === a.updatedAt && a.updatedAt >= a.createdAt
            && receipt?.schema === RECOVERY_SCHEMA && receipt.state === 'held' && isDeepStrictEqual(receipt.request, r) && receipt.runnerSha256 === p.runnerSha256
            && receipt.attemptId === proof.attemptId && receipt.lifecycleSha256 === heldSha256 && isDeepStrictEqual(receipt.proof, proof)
            && Number.isFinite(receipt.startedAt) && receipt.startedAt >= p.issuedAt && a.createdAt >= receipt.startedAt
            && Number.isFinite(receipt.endedAt) && receipt.endedAt >= a.updatedAt && receipt.endedAt <= now
            && receipt.logout === 'not-attempted' && receipt.failure === 'connect failed or unresolved' && receipt.before === null && receipt.after === null
            && receipt.scope?.gameplay === false && receipt.scope.production === 0 && receipt.scope.repairsFailure === false && receipt.scope.qualifiesScript === false
            && receipt.scope.bankObservation === 'unobserved' && !existsSync(paths.completed);
        if (failedConnect) basis = 'connect-failed';
        else {
            if (a.createdAt >= p.issuedAt || receipt && (receipt.logout !== 'not-attempted' || receipt.attemptId !== null)) throw Error('recovery lease producer logout not confirmed');
            basis = 'not-connected';
        }
        lifecycleSha256 = heldSha256;
    } else {
        if (proof.state !== 'confirmed') throw Error('recovery lease producer logout not confirmed');
        const attempt = attempts.find(x => x.attemptId === proof.attemptId), a = attempt?.receipt;
        if (!a || attempt?.sha256 !== proof.receiptSha256) throw Error('recovery lease producer proof mismatched');
        const own = proof.ownerRun === r.runId && a.owner.pid === child.pid && a.owner.coordinatorRunId === r.runId
            && a.owner.workerRelease === r.source && a.owner.script === RECOVERY_SCRIPT && a.createdAt >= p.issuedAt && proof.loggedOutAt >= p.issuedAt
            && !!receipt && receipt.logout === 'logged-out' && isDeepStrictEqual(receipt.request, r) && receipt.runnerSha256 === p.runnerSha256
            && receipt.attemptId === proof.attemptId && receipt.lifecycleSha256 === proof.receiptSha256 && receipt.scope?.gameplay === false && receipt.scope.production === 0;
        basis = own ? null : a.owner.coordinatorRunId !== r.runId && a.createdAt >= p.issuedAt && proof.loggedOutAt >= p.issuedAt ? 'superseded'
            : a.createdAt < p.issuedAt && proof.loggedOutAt < p.issuedAt && (!receipt || receipt.logout === 'not-attempted') ? 'not-connected' : undefined;
        if (basis === undefined) throw Error('recovery lease producer proof mismatched');
        lifecycleSha256 = proof.receiptSha256;
    }
    const released = {
        schema: 'session-recovery-release/1', at: now, account: r.account, nonce: r.nonce, runId: r.runId, leaseSha256, childPid: child.pid,
        attemptId: proof.attemptId, lifecycleSha256, receiptSha256: receipt ? sha(readFileSync(receiptPath)) : null, ...(basis ? { basis } : {}),
        controller: { pid: owner.pid, nonce: owner.nonce }, scope: { repairsFailure: false, qualifiesScript: false, production: 0 },
    };
    // A release that stopped between the marker and the removal leaves released.json beside the lease. That marker must
    // name this exact lease, child and producer proof; only its time and its controller can differ. Then the removal
    // runs again and the first marker stays. A marker that does not parse or does not match keeps the lease.
    const markerPath = join(dirname(paths.permit), 'released.json'); let marker = released;
    if (existsSync(markerPath)) {
        let prior: any; try { prior = json(markerPath); } catch { prior = null; }
        if (!prior || !Number.isFinite(prior.at) || prior.at < p.expiresAt || !Number.isSafeInteger(prior.controller?.pid) || typeof prior.controller.nonce !== 'string'
            || !isDeepStrictEqual({ ...prior, at: released.at, controller: released.controller }, released)) throw Error('recovery lease release marker mismatched');
        marker = prior;
    } else writeFileSync(markerPath, JSON.stringify(released), { flag: 'wx' });
    if (sha(readFileSync(leasePath)) !== leaseSha256) throw Error('recovery lease changed before release');
    unlinkSync(leasePath); return marker;
}

// The controller's sweep: each unmanaged lease either releases or keeps its fixed refusal reason.
export function releaseExpiredRecoveryLeases(base: string, managed: readonly string[] = [], options: LeaseReleaseChecks = {}) {
    const root = join(base, '.practice/coordinator/session-recovery/accounts'), results: { account: string; released: boolean; reason: string }[] = [];
    if (!existsSync(root)) return results;
    for (const account of readdirSync(root)) {
        if (managed.some(a => same(a, account)) || !existsSync(join(root, account, 'lease.json'))) continue;
        try { releaseExpiredRecoveryLease(account, base, options); results.push({ account, released: true, reason: 'released' }); }
        catch (error) { results.push({ account, released: false, reason: error instanceof Error && /^recovery |^invalid /.test(error.message) ? error.message : 'unclassified release error' }); }
    }
    return results;
}

// The start time of each process, from one process table read for each id at most once a minute: the swarm calls
// heldRecoveryOwners in each loop, and each read starts PowerShell. A failed read is kept for the minute too.
const START_CACHE_MS = 60_000, startCache = new Map<number, { at: number; start: number | undefined; known: boolean }>();
export function cachedProcessStarts(pids: readonly number[], read: ProcessStarts = processStartTimes, now = Date.now()): ReadonlyMap<number, number> | null {
    const stale = pids.filter(p => { const c = startCache.get(p); return !c || now - c.at >= START_CACHE_MS; });
    if (stale.length) { const table = read(stale); for (const p of stale) startCache.set(p, { at: now, start: table?.get(p), known: table !== null }); }
    const out = new Map<number, number>();
    for (const p of pids) { const c = startCache.get(p)!; if (!c.known) return null; if (c.start !== undefined) out.set(p, c.start); }
    return out;
}

// A controller restart must still count an inherited child's resource ownership. It may observe that child,
// but cannot replay its nonce, take over its permit or turn a lost completion into a success.
// The system gives the id of an ended child to a later process, so a live id proves the child only when its process
// started before the child record was written (savedProcessAlive). A swarm that holds the id of a dead child must
// not count the child as held, or it pauses every new start.
export function heldRecoveryOwners(base: string, managed: readonly string[] = [], alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } }, now = Date.now(), starts: ProcessStarts = pids => cachedProcessStarts(pids)) {
    const root = join(base, '.practice/coordinator/session-recovery/accounts'), held: { account: string; pid: number | null; started: number; source: string | null }[] = [];
    if (!existsSync(root)) return held;
    for (const account of readdirSync(root)) {
        if (managed.some(a => same(a, account)) || !existsSync(join(root, account, 'lease.json'))) continue;
        try {
            const permit = json(join(root, account, 'lease.json')), r = permit.request as ControlledRecoveryRequest; validateRecoveryRequest(r);
            if (!same(r.account, account)) throw Error('crossed lease'); const paths = recoveryPermitPaths(r, base);
            const child = existsSync(paths.child) ? json(paths.child) : null;
            if (child && (!Number.isSafeInteger(child.pid) || child.pid < 1 || child.nonce !== r.nonce || child.runId !== r.runId)) throw Error('unbound child');
            if (child ? savedProcessAlive(child.pid, statSync(paths.child).mtimeMs, starts, alive) : !Number.isFinite(permit.expiresAt) || permit.expiresAt > now)
                held.push({ account: r.account, pid: child?.pid ?? null, started: permit.issuedAt, source: r.source });
        } catch { held.push({ account, pid: null, started: now, source: null }); }
    }
    return held;
}
