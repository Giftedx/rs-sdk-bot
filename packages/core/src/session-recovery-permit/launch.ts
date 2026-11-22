// Recovery child execution, completion verification, state preservation checks, and run confirmation lookup.
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isLocalServer } from '../localserver';
import { statusReadDirs } from '../practice-paths';
import { processMatchesRecent, safeKill } from '../proc';
import { listAttempts, readLogoutProof } from '../session-lifecycle';
import { bindRecoveryChild, current, issueRecoveryPermit } from './authority';
import {
    RECOVERY_SCRIPT, json, recoveryLifecycleRoot, recoveryPermitPaths, repoRoot, same, sha,
    type ControlledRecoveryRequest, type RecoveryPermitChecks,
} from './request';

export function recoveryStatePreserved(before: any, after: any) {
    return !!before && !!after && same(before.player?.name, after.player?.name)
        && before.player.x === after.player.x && before.player.z === after.player.z && before.player.level === after.player.level
        && after.player.hp >= before.player.hp && after.player.hp > 0
        && isDeepStrictEqual(before.inventory, after.inventory) && isDeepStrictEqual(before.equipment, after.equipment) && isDeepStrictEqual(before.skills, after.skills)
        && (before.bank === null || after.bank === null || isDeepStrictEqual(before.bank, after.bank)) && !after.modalOpen;
}

// The existing controller calls this only after its tracked child exits. It reads that child's fixed output,
// then re-reads the producer. No caller-provided success JSON, account-end mutation or script qualification.
export function finishRecoveryPermit(r: ControlledRecoveryRequest, exitCode: number, base: string, options: RecoveryPermitChecks = {}) {
    const p = current(r, base, options, true), paths = recoveryPermitPaths(r, base), child = json(paths.child), used = json(paths.used);
    if (child.pid !== used.pid || used.nonce !== r.nonce || used.permitSha256 !== sha(readFileSync(paths.permit))) throw Error('recovery child consumption not bound');
    const receiptPath = join(paths.output, 'receipt.json'), raw = readFileSync(receiptPath), receipt = JSON.parse(raw.toString('utf8'));
    if (exitCode !== 0 || receipt.state !== 'confirmed' || receipt.logout !== 'logged-out' || receipt.failure || !isDeepStrictEqual(receipt.request, r)
        || receipt.runnerSha256 !== p.runnerSha256 || !Number.isFinite(receipt.startedAt) || receipt.startedAt < p.issuedAt
        || !Number.isFinite(receipt.endedAt) || receipt.endedAt < receipt.startedAt || receipt.endedAt > (options.now ?? Date.now)()
        || receipt.scope?.gameplay !== false || receipt.scope.production !== 0 || receipt.scope.repairsFailure !== false || receipt.scope.qualifiesScript !== false
        || !same(receipt.before?.player?.name, r.account) || !recoveryStatePreserved(receipt.before, receipt.after)) throw Error('recovery child did not confirm preserved cleanup');
    const root = recoveryLifecycleRoot(r.server, base), proof = readLogoutProof(r.account, r.server, { root });
    const attempt = listAttempts(r.account, r.server, { root }).find(a => a.attemptId === receipt.attemptId);
    if (proof.state !== 'confirmed' || proof.attemptId !== receipt.attemptId || proof.receiptSha256 !== receipt.lifecycleSha256 || attempt?.sha256 !== proof.receiptSha256
        || !attempt.receipt || attempt.receipt.createdAt < receipt.startedAt || proof.loggedOutAt < receipt.startedAt
        || attempt.receipt.owner.pid !== child.pid || attempt.receipt.owner.coordinatorRunId !== r.runId || attempt.receipt.owner.workerRelease !== r.source
        || attempt.receipt.owner.script !== RECOVERY_SCRIPT) throw Error('recovery producer result superseded or crossed');
    const completed = { at: (options.now ?? Date.now)(), request: r, childPid: child.pid, receiptPath, receiptSha256: sha(raw), proof, nativeFixture: p.nativeFixture, scope: { repairsFailure: false, qualifiesScript: false, production: 0 } };
    writeFileSync(paths.completed, JSON.stringify(completed), { flag: 'wx' });
    // Both hard links still contain the exact immutable permit. Never remove a different owner's lease.
    if (sha(readFileSync(paths.lease)) !== sha(readFileSync(paths.permit))) throw Error('recovery lease changed before release');
    unlinkSync(paths.lease); return completed;
}

// Issue and binding run in one synchronous controller call, which blocks the controller's heartbeat writer. Each
// PowerShell command-line lookup costs over 1 s under load, so repeating the lookups at binding can age the heartbeat
// past FLEET_HEARTBEAT_MAX_MS. Binding reuses the issue observations of this one call; it still re-reads every file and the
// source stamp, and the child's consumeRecoveryConnection observes both processes again in its own process.
export function launchObservations(options: RecoveryPermitChecks): RecoveryPermitChecks {
    const lookup = options.matches ?? processMatchesRecent, seen = new Map<string, boolean>();
    return { ...options, matches: (pid, marker) => { const key = pid + '\0' + marker; let hit = seen.get(key); if (hit === undefined) { hit = lookup(pid, marker); seen.set(key, hit); } return hit; } };
}

export function launchPermittedRecovery(r: ControlledRecoveryRequest, base: string, options: RecoveryPermitChecks = {}) {
    // Remote issuance requires the current same-capability delivered native proof (authority); a fixture is local-only.
    if (!isLocalServer(r.server) && (options.nativeFixture || resolve(base) !== repoRoot)) throw Error('recovery remote launch outside the repository controller; no lease issued');
    const repo = repoRoot, runner = join(repo, RECOVERY_SCRIPT);
    const launch = launchObservations(options), permit = issueRecoveryPermit(r, base, launch), paths = recoveryPermitPaths(r, base);
    if (sha(readFileSync(runner)) !== permit.runnerSha256) throw Error('recovery runner differs from permit');
    writeFileSync(paths.input, JSON.stringify(r), { flag: 'wx' }); mkdirSync(paths.output, { recursive: true });
    const child = Bun.spawn([process.execPath, runner, paths.input, paths.output, ...(options.nativeFixture ? ['--permit-base=' + base] : [])], {
        cwd: repo,
        env: { ...process.env, WORKER_RELEASE: r.source, WORKER_ENTRY: '' },
        windowsHide: true,
        stdin: 'pipe',
        stdout: Bun.file(join(dirname(paths.input), 'worker.log')),
        stderr: Bun.file(join(dirname(paths.input), 'worker.err')),
    });
    let bindError: unknown; try { bindRecoveryChild(r, child.pid, base, launch); } catch (error) { bindError = error; }
    const completion = (async () => {
        let timedOut = false;
        // Setup spends part of the immutable permit lifetime. Reap at that expiry so a later child session timer cannot
        // lose its valid cleanup window to a second, earlier controller deadline. Admission remains bounded separately.
        const timer = setTimeout(() => { timedOut = true; void safeKill(child.pid, r.nonce); }, Math.max(0, permit.expiresAt - (options.now ?? Date.now)())); timer.unref();
        try {
            try { if (!bindError) await child.stdin.write(JSON.stringify({ pid: child.pid, nonce: r.nonce, runId: r.runId, source: r.source })); }
            catch (error) { bindError ??= error; }
            finally { try { await child.stdin.end(); } catch (error) { bindError ??= error; } }
            const code = await child.exited; if (bindError) throw bindError; if (timedOut) throw Error('recovery child deadline; lease held'); return finishRecoveryPermit(r, code, base, options);
        } finally { clearTimeout(timer); }
    })();
    return { child, completion, paths };
}

export function recoveredSessionForRun(account: string, server: string, runId: string, source: string, base: string): boolean {
    if (!/^[A-Za-z0-9_ -]{1,12}$/.test(account)) return false;
    const root = recoveryLifecycleRoot(server, base), proof = readLogoutProof(account, server, { root });
    if (proof.state !== 'confirmed' || proof.ownerRun !== runId) return false;
    const statusFile = join(base, '.practice/status', account + '.json'), status = existsSync(statusFile) ? json(statusFile) : null;
    if (status?.server === server && !status.result && (!Number.isFinite(status.at) || status.at > proof.loggedOutAt)) return false;
    const dir = join(base, '.practice/coordinator/session-recovery/accounts', account.toLowerCase());
    if (!existsSync(dir) || existsSync(join(dir, 'lease.json'))) return false;
    const attempt = listAttempts(account, server, { root }).find(a => a.attemptId === proof.attemptId);
    if (!attempt?.receipt || attempt.sha256 !== proof.receiptSha256 || attempt.receipt.owner.script !== RECOVERY_SCRIPT || attempt.receipt.owner.workerRelease !== source) return false;
    for (const nonce of readdirSync(dir)) {
        const file = join(dir, nonce, 'completed.json'); if (!existsSync(file)) continue;
        const completed = json(file);
        if (same(completed.request?.account, account) && completed.request.server === server && completed.request.runId === runId && completed.request.source === source
            && completed.proof?.attemptId === proof.attemptId && completed.proof.receiptSha256 === proof.receiptSha256 && completed.childPid === attempt.receipt.owner.pid) {
            const paths = recoveryPermitPaths(completed.request, base), p = json(paths.permit), child = json(paths.child), used = json(paths.used);
            if (resolve(paths.completed) !== resolve(file) || resolve(completed.receiptPath) !== resolve(paths.output, 'receipt.json')) return false;
            const raw = readFileSync(completed.receiptPath), r = JSON.parse(raw.toString('utf8'));
            if (p.nativeFixture && !isLocalServer(server) || !isDeepStrictEqual(p.request, completed.request) || child.pid !== completed.childPid || used.pid !== child.pid
                || used.nonce !== nonce || used.permitSha256 !== sha(readFileSync(paths.permit)) || completed.receiptSha256 !== sha(raw)
                || r.state !== 'confirmed' || r.logout !== 'logged-out' || r.failure || !isDeepStrictEqual(r.request, p.request) || r.lifecycleSha256 !== proof.receiptSha256 || r.attemptId !== proof.attemptId
                || r.runnerSha256 !== p.runnerSha256 || p.runnerSha256 !== sha(readFileSync(join(base, RECOVERY_SCRIPT))) || !recoveryStatePreserved(r.before, r.after)
                || r.scope?.gameplay !== false || r.scope.production !== 0 || r.scope.repairsFailure !== false || r.scope.qualifiesScript !== false) return false;
            return true;
        }
    }
    return false;
}
