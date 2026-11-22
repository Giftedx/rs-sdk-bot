// Standalone automatic session-recovery orchestration wrapping core recovery primitives without coordinator proposal queues.
// Evaluates held live sessions, honors owner pauses and global infra circuit-breaker backoff, archives stale recovery
// leases, and runs direct session cleanup retries with bounded per-end attempt tracking.
// Usage: bun packages/fleet/src/session-recovery.ts [--dry] [--json] [--root=<dir>]
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadOwners, mySide } from '../../core/src/fleet';
import { readFleetAccountClaim } from '../../core/src/fleet-trade-claim';
import { isLocalServer } from '../../core/src/localserver';
import {
    findStopFile,
    hasStopFile,
    lifecycleRootForRead,
    liveRoot,
    readStopFile,
    statusReadDirs,
} from '../../core/src/practice-paths';
import { BOOTSTRAP_STATUS_AGE_MS } from '../../core/src/session-admission';
import { attemptOutcome, listAttempts, readLogoutProof, type LogoutProof } from '../../core/src/session-lifecycle';
import {
    RECOVERY_SCHEMA,
    RECOVERY_SCRIPT,
    recoverSession,
    recoveryCloseModal,
    recoveryReady,
    validateRecoveryRequest,
    type RecoveryRequest,
} from '../../core/src/session-recovery';
import { heldRecoveryOwners } from '../../core/src/session-recovery-permit';
import { RESERVED_ACCOUNTS } from '../../core/src/specialist-boards';
import { cachedLaunchRevision } from '../../core/src/worker-release';
import { InfraCircuitBreaker, classifyInfraFault } from './infra-circuit-breaker';

export {
    RECOVERY_SCHEMA,
    RECOVERY_SCRIPT,
    recoverSession,
    recoveryCloseModal,
    recoveryReady,
    validateRecoveryRequest,
    type RecoveryRequest,
};

export const LIVE_SERVER = 'rs-sdk-demo.fly.dev';
export const MAX_RECOVERY_ATTEMPTS = 2;
export const NEVER_RECOVERED: readonly string[] = [...RESERVED_ACCOUNTS, 'afknight'];
export const RECOVERABLE_END = /^(?:blocked|gave-up|exit|no-progress|stopped)(?:\b| )/;
export const END_SETTLE_MS = BOOTSTRAP_STATUS_AGE_MS + 5 * 60_000;

export type EndRecord = { at: number; reason: string; revision?: string };
export type ClaimView = { phase: 'held' | 'released'; kind?: string; pid?: number; host?: string } | null;
export type Eligibility = { eligible: true; endedAt: number } | { eligible: false; reason: string; log: boolean };
export type LeaseState = 'none' | 'held' | 'stale';

export type StandaloneRecoveryRecord = {
    at: number;
    account: string;
    endedAt: number;
    ok: boolean;
    infraFault?: boolean;
    reason: string;
};

const stamp = (now: number) => new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'z').toLowerCase();
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
const readJson = (file: string, fallback: any) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };

const SWARM_STOP_REASONS = /^(?:swarm stopped\b|swarm plan removed\b|swarm: |fleet controller lease unavailable|fleet account claim\b)/i;
export function swarmWroteStopText(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (/owner|specialist/i.test(trimmed)) return false;
    return SWARM_STOP_REASONS.test(trimmed);
}

export function clearSwarmStops(root: string, accounts: readonly string[]): string[] {
    if (hasStopFile('swarm', root)) return [];
    const cleared: string[] = [];
    for (const account of accounts) {
        const file = findStopFile(account, root);
        if (!file) continue;
        let text = '';
        try { text = readFileSync(file, 'utf8'); } catch { continue; }
        if (!swarmWroteStopText(text)) continue;
        try { rmSync(file, { force: true }); cleared.push(account); } catch { /* keep if held open */ }
    }
    return cleared;
}

export function endSettled(end: Pick<EndRecord, 'at' | 'reason'>, now: number): boolean {
    return end.reason.startsWith('exit orphaned: attempt ') || now - end.at >= END_SETTLE_MS;
}

export function assessRecoveryEligibility(v: {
    proof: LogoutProof;
    claim: ClaimView;
    end: EndRecord | undefined;
    stopText: string | undefined;
    pidAlive: (pid: number) => boolean;
    host: string;
    retried?: boolean;
}): Eligibility {
    if (v.proof.state !== 'held') return { eligible: false, reason: `logout proof ${v.proof.state}`, log: false };
    if (v.stopText !== undefined && !swarmWroteStopText(v.stopText)) {
        return { eligible: false, reason: 'owner stop file holds the account', log: true };
    }
    if (!v.claim || v.claim.phase !== 'held') {
        if (!v.end) return { eligible: false, reason: 'end record gone; manual diagnosis required', log: true };
        if (!v.end.reason.startsWith(`exit orphaned: attempt ${v.proof.attemptId} `)) {
            return { eligible: false, reason: 'no held fleet account claim', log: false };
        }
    } else {
        if (v.claim.kind !== 'swarm') return { eligible: false, reason: 'claim is held by a trade order', log: true };
        if (v.claim.host === v.host && typeof v.claim.pid === 'number' && v.pidAlive(v.claim.pid)) {
            return { eligible: false, reason: 'worker still alive', log: false };
        }
    }
    if (!v.end) return { eligible: false, reason: 'end record gone; manual diagnosis required', log: true };
    const started = /^\d{13}-/.test(v.proof.attemptId) ? Number(v.proof.attemptId.slice(0, 13)) : NaN;
    if (v.end.at < started && !v.retried) return { eligible: false, reason: 'waiting: supervisor has not ended the held attempt', log: false };
    if (/^died\b/.test(v.end.reason)) return { eligible: false, reason: 'death requires diagnosis before recovery', log: true };
    if (!RECOVERABLE_END.test(v.end.reason)) return { eligible: false, reason: `end reason not recoverable: ${v.end.reason}`, log: true };
    return { eligible: true, endedAt: v.end.at };
}

const leaseFile = (root: string, account: string) =>
    join(root, '.practice', 'coordinator', 'session-recovery', 'accounts', account.toLowerCase(), 'lease.json');

export function recoveryLeaseState(root: string, account: string, alive: (pid: number) => boolean = pidAlive, now = Date.now()): LeaseState {
    if (!existsSync(leaseFile(root, account))) return 'none';
    return heldRecoveryOwners(root, [], alive, now).some(h => h.account.toLowerCase() === account.toLowerCase()) ? 'held' : 'stale';
}

export function archiveStaleLease(root: string, account: string, now: number): string {
    const file = leaseFile(root, account), to = join(resolve(file, '..'), `lease-stale-${stamp(now)}.json`);
    renameSync(file, to);
    return to;
}

export function standaloneHistoryFile(root: string): string {
    return join(liveRoot(root), 'session-recovery', 'history.jsonl');
}

export function readStandaloneHistory(root: string): StandaloneRecoveryRecord[] {
    const file = standaloneHistoryFile(root);
    if (!existsSync(file)) return [];
    const out: StandaloneRecoveryRecord[] = [];
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
            const parsed = JSON.parse(line);
            if (typeof parsed?.account === 'string' && Number.isFinite(parsed?.endedAt) && typeof parsed?.ok === 'boolean') {
                out.push(parsed as StandaloneRecoveryRecord);
            }
        } catch { /* ignore truncated line */ }
    }
    return out;
}

export function recordStandaloneAttempt(root: string, entry: StandaloneRecoveryRecord): void {
    const file = standaloneHistoryFile(root);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(entry) + '\n');
}

export function spentStandaloneAttempts(history: readonly StandaloneRecoveryRecord[], account: string, endedAt: number): number {
    const key = account.toLowerCase();
    return history.filter(r => r.account.toLowerCase() === key && r.endedAt === endedAt && !r.ok && !r.infraFault).length;
}

export function findAccountStatus(root: string, account: string): any {
    const target = `${account.toLowerCase()}.json`;
    for (const dir of statusReadDirs(root)) {
        if (!existsSync(dir)) continue;
        let files: string[] = [];
        try { files = readdirSync(dir); } catch { continue; }
        const match = files.find(f => f.toLowerCase() === target);
        if (!match) continue;
        const row = readJson(join(dir, match), null);
        if (row) return row;
    }
    return null;
}

export function loadEndedRecords(file: string): Map<string, EndRecord> {
    const raw = readJson(file, {});
    const map = new Map<string, EndRecord>();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return map;
    for (const [k, v] of Object.entries(raw as Record<string, any>)) {
        if (typeof k === 'string' && Number.isFinite(v?.at) && typeof v?.reason === 'string') {
            map.set(k.toLowerCase(), { at: v.at, reason: v.reason, ...(typeof v.revision === 'string' ? { revision: v.revision } : {}) });
        }
    }
    return map;
}

export type StandaloneRecoveryPassOptions = {
    root?: string;
    side?: string;
    server?: string;
    dry?: boolean;
    now?: () => number;
    pidAlive?: (pid: number) => boolean;
    host?: string;
    breaker?: InfraCircuitBreaker;
    owners?: ReadonlyMap<string, { side: string; server: string }>;
    readClaim?: (account: string) => ClaimView;
    executeRecovery?: (target: { account: string; endedAt: number; server: string }) => Promise<{ ok: boolean; detail: string }>;
    log?: (line: string) => void;
};

export type StandaloneRecoveryPassResult = {
    ok: boolean;
    dry: boolean;
    blockedByStop?: string;
    blockedByCircuit?: string;
    targets: { account: string; endedAt: number }[];
    recovered: string[];
    failed: string[];
    skipped: { account: string; reason: string }[];
};

export async function runStandaloneRecoveryPass(opts: StandaloneRecoveryPassOptions = {}): Promise<StandaloneRecoveryPassResult> {
    const root = resolve(opts.root ?? resolve(import.meta.dir, '../../..'));
    const dry = opts.dry === true;
    const nowFn = opts.now ?? Date.now;
    const now = nowFn();
    const alive = opts.pidAlive ?? pidAlive;
    const host = opts.host ?? hostname();
    const server = opts.server ?? LIVE_SERVER;
    const side = opts.side ?? mySide();
    const log = opts.log ?? ((line: string) => console.log(`FLEET_RECOVERY ${line}`));
    const breaker = opts.breaker ?? new InfraCircuitBreaker({
        stateFile: join(liveRoot(root), 'infra-circuit-breaker.json'),
        now: nowFn,
    });

    for (const flag of ['coordinator', 'swarm', 'session-recovery']) {
        if (hasStopFile(flag, root)) {
            const msg = `refused: stop-${flag} active`;
            log(msg);
            return { ok: true, dry, blockedByStop: flag, targets: [], recovered: [], failed: [], skipped: [] };
        }
    }

    const circuit = breaker.canProceed();
    if (!circuit.allowed) {
        log(`deferred by infra circuit breaker (${circuit.reason})`);
        return { ok: true, dry, blockedByCircuit: circuit.reason, targets: [], recovered: [], failed: [], skipped: [] };
    }

    const owners = opts.owners ?? loadOwners();
    const ended = loadEndedRecords(join(root, '.practice', 'swarm-deaths.json'));
    const history = readStandaloneHistory(root);
    const lRoot = lifecycleRootForRead(server, root);
    const cloud = side !== 'local';
    const readClaim = opts.readClaim ?? ((account: string) => readFleetAccountClaim(root, { account, server }) as ClaimView);

    const targets: { account: string; endedAt: number }[] = [];
    const skipped: { account: string; reason: string }[] = [];

    for (const [lower, owner] of owners) {
        if (owner.side !== side || owner.server.toLowerCase() !== server.toLowerCase()) continue;
        if (NEVER_RECOVERED.includes(lower)) continue;

        const proof = readLogoutProof(lower, server, { root: lRoot });
        if (proof.state !== 'held') continue;

        const status = findAccountStatus(root, lower);
        if (status && !status.result && Number.isFinite(status.at) && now - status.at < 60_000) continue;

        let claim: ClaimView = null;
        try {
            claim = readClaim(lower);
            breaker.recordSuccess('remote_git_claim');
        } catch (err) {
            const tripped = breaker.recordFailure(err);
            const reason = `claim unreadable: ${String(err).slice(0, 140)}`;
            skipped.push({ account: lower, reason });
            log(`${lower}: ${reason}`);
            if (tripped.tripped) {
                const statusNow = breaker.canProceed();
                log(`infra circuit breaker tripped (${tripped.kind}); halting remaining claim checks`);
                return { ok: true, dry, blockedByCircuit: statusNow.reason, targets, recovered: [], failed: [], skipped };
            }
            continue;
        }

        const stopText = readStopFile(lower, root);
        const end = ended.get(lower);
        const attempts = end ? spentStandaloneAttempts(history, lower, end.at) : 0;
        const e = assessRecoveryEligibility({
            proof,
            claim,
            end,
            stopText,
            pidAlive: alive,
            host,
            retried: attempts > 0,
        });
        if (!e.eligible) {
            if (e.log) {
                skipped.push({ account: lower, reason: e.reason });
                log(`${lower}: refused: ${e.reason}`);
            }
            continue;
        }
        if (attempts >= MAX_RECOVERY_ATTEMPTS) {
            const reason = `attempt budget reached (${attempts}/${MAX_RECOVERY_ATTEMPTS})`;
            skipped.push({ account: lower, reason });
            log(`${lower}: refused: ${reason}`);
            continue;
        }
        if (!cloud && !endSettled(end!, now)) {
            continue;
        }
        const leaseState = recoveryLeaseState(root, lower, alive, now);
        if (leaseState === 'held') {
            const reason = 'active recovery child lease held';
            skipped.push({ account: lower, reason });
            log(`${lower}: refused: ${reason}`);
            continue;
        }
        targets.push({ account: lower, endedAt: e.endedAt });
    }

    if (!targets.length) {
        return { ok: true, dry, targets: [], recovered: [], failed: [], skipped };
    }

    if (dry) {
        for (const t of targets) log(`${t.account}: would recover standalone (endedAt=${t.endedAt})`);
        return { ok: true, dry: true, targets, recovered: [], failed: [], skipped };
    }

    const recovered: string[] = [];
    const failed: string[] = [];
    const runner = opts.executeRecovery ?? (async target => {
        if (!isLocalServer(target.server)) {
            return { ok: false, detail: 'direct live recovery runner unavailable without live session transport' };
        }
        return { ok: false, detail: 'direct recovery session runner required for local execution' };
    });

    for (const target of targets) {
        const gate = breaker.canProceed();
        if (!gate.allowed) {
            log(`paused before ${target.account}: ${gate.reason}`);
            return { ok: true, dry, blockedByCircuit: gate.reason, targets, recovered, failed, skipped };
        }
        if (recoveryLeaseState(root, target.account, alive, nowFn()) === 'stale') {
            const archived = archiveStaleLease(root, target.account, nowFn());
            log(`${target.account}: archived stale recovery lease at ${archived}`);
        }
        clearSwarmStops(root, [target.account]);
        try {
            const res = await runner({ account: target.account, endedAt: target.endedAt, server });
            const faultKind = res.ok ? null : classifyInfraFault(res.detail);
            if (faultKind) {
                breaker.recordFailure(res.detail, faultKind);
                recordStandaloneAttempt(root, {
                    at: nowFn(),
                    account: target.account,
                    endedAt: target.endedAt,
                    ok: false,
                    infraFault: true,
                    reason: res.detail.slice(0, 200),
                });
                skipped.push({ account: target.account, reason: `infra fault (${faultKind}): ${res.detail}` });
                log(`${target.account}: deferred on ${faultKind} without burning budget`);
                break;
            }
            if (res.ok) {
                breaker.recordSuccess();
                recovered.push(target.account);
                recordStandaloneAttempt(root, {
                    at: nowFn(),
                    account: target.account,
                    endedAt: target.endedAt,
                    ok: true,
                    reason: res.detail.slice(0, 200),
                });
                log(`${target.account}: recovered (${res.detail})`);
            } else {
                failed.push(target.account);
                recordStandaloneAttempt(root, {
                    at: nowFn(),
                    account: target.account,
                    endedAt: target.endedAt,
                    ok: false,
                    reason: res.detail.slice(0, 200),
                });
                log(`${target.account}: recovery failed (${res.detail})`);
            }
        } catch (err) {
            const faultKind = classifyInfraFault(err);
            const detail = String(err).slice(0, 200);
            if (faultKind) {
                breaker.recordFailure(err, faultKind);
                recordStandaloneAttempt(root, {
                    at: nowFn(),
                    account: target.account,
                    endedAt: target.endedAt,
                    ok: false,
                    infraFault: true,
                    reason: detail,
                });
                skipped.push({ account: target.account, reason: `infra fault (${faultKind}): ${detail}` });
                log(`${target.account}: deferred on ${faultKind}: ${detail}`);
                break;
            }
            failed.push(target.account);
            recordStandaloneAttempt(root, {
                at: nowFn(),
                account: target.account,
                endedAt: target.endedAt,
                ok: false,
                reason: detail,
            });
            log(`${target.account}: recovery threw (${detail})`);
        }
    }

    return { ok: failed.length === 0, dry, targets, recovered, failed, skipped };
}

export async function runLocalRecoveryDirect(
    account: string,
    server: string,
    deps: Parameters<typeof recoverSession>[1],
    root = resolve(import.meta.dir, '../../..'),
    source?: string,
): Promise<ReturnType<typeof recoverSession>> {
    if (!isLocalServer(server)) {
        throw new Error('live authenticated recovery requires explicit authorized live transport');
    }
    const request: RecoveryRequest = {
        schema: RECOVERY_SCHEMA,
        account,
        server,
        runId: `fleet-recovery-${Date.now()}`,
        nonce: crypto.randomUUID(),
        endedAt: Date.now(),
        source: source ?? cachedLaunchRevision(root),
    };
    validateRecoveryRequest(request);
    return recoverSession(request, deps);
}

if (import.meta.main) {
    const argv = process.argv.slice(2);
    const dry = argv.includes('--dry');
    const jsonOut = argv.includes('--json');
    const rootArg = argv.find(a => a.startsWith('--root='))?.slice('--root='.length);
    const root = resolve(rootArg ?? resolve(import.meta.dir, '../../..'));
    const res = await runStandaloneRecoveryPass({ root, dry });
    if (jsonOut) console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
}
