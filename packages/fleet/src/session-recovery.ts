// Standalone automatic session-recovery orchestration wrapping core recovery primitives without coordinator proposal queues.
// Evaluates held live sessions, honors owner pauses and global infra circuit-breaker backoff, archives stale recovery
// leases, and runs direct session cleanup retries with bounded per-end attempt tracking.
// Usage: bun packages/fleet/src/session-recovery.ts [--dry] [--json] [--root=<dir>]
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { loadOwners, mySide } from '../../core/src/fleet';
import { readFleetAccountClaim } from '../../core/src/fleet-trade-claim';
import { isLocalServer } from '../../core/src/localserver';
import { atomicJson } from '../../core/src/plan-lock';
import {
    findStopFile,
    hasStopFile,
    liveRoot,
    readStopFile,
    statusReadDirs,
} from '../../core/src/practice-paths';
import { processMatchesRecent, processStartTimes } from '../../core/src/proc';
import { BOOTSTRAP_STATUS_AGE_MS } from '../../core/src/session-admission';
import { attemptOutcome, listAttempts, readLogoutProof, resolveLifecycleRoot, type LogoutProof } from '../../core/src/session-lifecycle';
import { savedProcessAlive, type ProcessStarts } from '../../core/src/session-takeover';
import {
    RECOVERY_SCHEMA,
    RECOVERY_SCRIPT,
    recoverSession,
    recoveryCloseModal,
    recoveryReady,
    validateRecoveryRequest,
    type RecoveryRequest,
} from '../../core/src/session-recovery';
import {
    heldRecoveryOwners,
    verifyNativeRecoveryProof,
    type ControlledRecoveryRequest,
} from '../../core/src/session-recovery-permit';
import { RESERVED_ACCOUNTS } from '../../core/src/specialist-boards';
import { cachedLaunchRevision, cachedReleaseFor } from '../../core/src/worker-release';
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
const NEVER_RECOVERED_SET = new Set<string>(NEVER_RECOVERED);
export const RECOVERABLE_END = /^(?:blocked|gave-up|exit|no-progress|stopped)(?:\b| )/;
export const END_SETTLE_MS = BOOTSTRAP_STATUS_AGE_MS + 5 * 60_000;

export type EndRecord = { at: number; reason: string; revision?: string };
export type ClaimView = { phase: 'held' | 'released'; kind?: string; orderId?: string; pid?: number; host?: string; at?: number } | null;
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
    const isReleasedTrade = v.claim?.phase === 'released'
        && (typeof v.claim.orderId === 'string' || (typeof v.claim.kind === 'string' && v.claim.kind !== 'swarm'))
        && v.proof.reason !== 'session active or outcome unknown';
    if (!v.claim || v.claim.phase !== 'held') {
        if (!v.end) return { eligible: false, reason: 'end record gone; manual diagnosis required', log: true };
        if (isReleasedTrade) {
            if (v.claim!.host === v.host && typeof v.claim!.pid === 'number' && v.pidAlive(v.claim!.pid)) {
                return { eligible: false, reason: 'worker still alive', log: false };
            }
        } else if (!v.end.reason.startsWith(`exit orphaned: attempt ${v.proof.attemptId} `)) {
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
    if (!isReleasedTrade && v.end.at < started && !v.retried) return { eligible: false, reason: 'waiting: supervisor has not ended the held attempt', log: false };
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
    const file = leaseFile(root, account);
    const dir = resolve(file, '..');
    const baseName = `lease-stale-${stamp(now)}`;
    let to = join(dir, `${baseName}.json`);
    if (existsSync(to)) {
        to = join(dir, `${baseName}-${randomUUID().slice(0, 6)}.json`);
    }
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
    let count = 0;
    for (let i = 0; i < history.length; i++) {
        const r = history[i]!;
        if (!r.ok && !r.infraFault && r.endedAt === endedAt && r.account.toLowerCase() === key) count++;
    }
    return count;
}

export function findAccountStatus(root: string, account: string, server?: string): any {
    const target = `${account.toLowerCase()}.json`;
    const serverLower = server?.toLowerCase();
    for (const dir of statusReadDirs(root)) {
        if (!existsSync(dir)) continue;
        const exact = join(dir, `${account}.json`);
        const lowerFile = join(dir, target);
        let matchPath: string | null = existsSync(exact) ? exact : (exact !== lowerFile && existsSync(lowerFile) ? lowerFile : null);
        if (!matchPath) {
            try {
                const match = readdirSync(dir).find(f => f.toLowerCase() === target);
                if (match) matchPath = join(dir, match);
            } catch { continue; }
        }
        if (!matchPath) continue;
        const row = readJson(matchPath, null);
        if (row && (!serverLower || (typeof row.server === 'string' && row.server.toLowerCase() === serverLower))) return row;
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
    account?: string;
    dry?: boolean;
    now?: () => number;
    pidAlive?: (pid: number) => boolean;
    host?: string;
    breaker?: InfraCircuitBreaker;
    owners?: ReadonlyMap<string, { side: string; server: string }>;
    readClaim?: (account: string) => ClaimView;
    executeRecovery?: (target: { account: string; endedAt: number; server: string }) => Promise<{ ok: boolean; detail: string; deferred?: boolean }>;
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
    const cloud = side !== 'local';
    const readClaim = opts.readClaim ?? ((account: string) => readFleetAccountClaim(root, { account, server }) as ClaimView);

    const targets: { account: string; endedAt: number }[] = [];
    const skipped: { account: string; reason: string }[] = [];

    const accountFilter = opts.account?.trim().toLowerCase();
    const serverLower = server.toLowerCase();
    const spentAttemptCounts = new Map<string, number>();
    for (let i = 0; i < history.length; i++) {
        const r = history[i]!;
        if (r.ok || r.infraFault) continue;
        const k = `${r.account.toLowerCase()}|${r.endedAt}`;
        spentAttemptCounts.set(k, (spentAttemptCounts.get(k) ?? 0) + 1);
    }
    let heldRecoverySet: Set<string> | null = null;
    const isRecoveryLeaseHeld = (account: string): boolean => {
        if (!existsSync(leaseFile(root, account))) return false;
        heldRecoverySet ??= new Set(heldRecoveryOwners(root, [], alive, now).map(h => h.account.toLowerCase()));
        return heldRecoverySet.has(account.toLowerCase());
    };

    for (const [lower, owner] of owners) {
        if (accountFilter && lower !== accountFilter) continue;
        if (owner.side !== side || owner.server.toLowerCase() !== serverLower) continue;
        if (NEVER_RECOVERED_SET.has(lower)) continue;

        const proof = readLogoutProof(lower, server, { root: resolveLifecycleRoot(lower, server, root) });
        if (proof.state !== 'held') continue;

        const status = findAccountStatus(root, lower, server);
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
        const attempts = end ? (spentAttemptCounts.get(`${lower}|${end.at}`) ?? 0) : 0;
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
        if (isRecoveryLeaseHeld(lower)) {
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
    const runner = opts.executeRecovery ?? (async (target: { account: string; endedAt: number; server: string }) => {
        if (!isLocalServer(target.server)) {
            return executeControlledLiveRecovery(target, { root, now: nowFn, pidAlive: alive });
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
            if (res.deferred) {
                skipped.push({ account: target.account, reason: res.detail });
                log(`${target.account}: deferred without burning budget (${res.detail})`);
                continue;
            }
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

export type RecoveryQualificationRef = {
    delivery: { path: string; sha256: string };
    proof: { path: string; sha256: string };
};

const sha256Buf = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');

export function findCurrentNativeRecoveryQualification(
    root: string,
    source?: string,
    endedAt = 0,
    now = Date.now(),
    expectedCapRev?: string,
): RecoveryQualificationRef | null {
    const resolvedRoot = resolve(root);
    const deliveriesRoot = join(resolvedRoot, '.practice', 'deliveries');
    if (!existsSync(deliveriesRoot)) return null;
    const runnerPath = join(resolvedRoot, RECOVERY_SCRIPT);
    if (!existsSync(runnerPath)) return null;
    let resolvedSource: string;
    let expectedCapabilityRev: string;
    try {
        resolvedSource = source ?? cachedLaunchRevision(resolvedRoot);
        expectedCapabilityRev = expectedCapRev ?? cachedReleaseFor(['scripts/session-check.ts'], resolvedRoot);
    } catch {
        return null;
    }
    let runnerSha256: string | null = null;
    const getRunnerSha256 = () => (runnerSha256 ??= sha256Buf(readFileSync(runnerPath)));

    let best: { at: number; ref: RecoveryQualificationRef } | null = null;
    let entries: string[] = [];
    try { entries = readdirSync(deliveriesRoot); } catch { return null; }
    let realDeliveriesAllowed: string | null = null;

    for (const dirName of entries) {
        const deliveryDir = join(deliveriesRoot, dirName);
        const reportPath = join(deliveryDir, 'report.json');
        let reportBytes: Buffer;
        let report: any;
        try {
            reportBytes = readFileSync(reportPath);
            report = JSON.parse(reportBytes.toString('utf8'));
        } catch { continue; }
        if (
            report?.ok !== true
            || report.stage !== 'delivered'
            || report.id !== 'session-recovery-only'
            || report.runtimeRevision !== expectedCapabilityRev
            || !Number.isFinite(report.at)
            || report.at <= endedAt
            || report.at > now
            || !Array.isArray(report.checks)
            || report.checks.some((c: any) => c?.exitCode !== 0 || c?.timedOut)
        ) continue;

        const gate = report.checks.find((c: any) => c?.id === 'native-session-recovery' && c?.phase === 'practice');
        if (!gate) continue;
        let stdoutPath: string;
        try {
            const detail = JSON.parse(gate.detail);
            if (typeof detail?.stdout !== 'string') continue;
            stdoutPath = realpathSync(resolve(resolvedRoot, detail.stdout));
        } catch { continue; }
        let realDeliveryDir: string;
        try { realDeliveryDir = realpathSync(deliveryDir); } catch { continue; }
        if (!stdoutPath.startsWith(realDeliveryDir + sep)) continue;

        let markers: string[];
        try {
            markers = readFileSync(stdoutPath, 'utf8').split(/\r?\n/).filter(l => l.startsWith('RECOVERY_NATIVE_PROOF '));
        } catch { continue; }
        if (markers.length !== 1) continue;

        let proofRef: { path?: unknown; sha256?: unknown };
        try { proofRef = JSON.parse(markers[0]!.slice('RECOVERY_NATIVE_PROOF '.length)); } catch { continue; }
        if (typeof proofRef?.path !== 'string' || !/^[a-f0-9]{64}$/.test(String(proofRef.sha256 ?? ''))) continue;

        let realProofPath: string;
        try {
            realProofPath = realpathSync(resolve(resolvedRoot, proofRef.path));
            if (realDeliveriesAllowed === null) realDeliveriesAllowed = realpathSync(deliveriesRoot) + sep;
        } catch { continue; }
        if (!realProofPath.startsWith(realDeliveriesAllowed)) continue;

        let proofBytes: Buffer;
        let proof: any;
        try {
            proofBytes = readFileSync(realProofPath);
            if (sha256Buf(proofBytes) !== proofRef.sha256) continue;
            proof = JSON.parse(proofBytes.toString('utf8'));
            verifyNativeRecoveryProof(proof, dirname(realProofPath), { runtimeRevision: resolvedSource, runnerSha256: getRunnerSha256() });
        } catch { continue; }

        if (!best || report.at > best.at) {
            best = {
                at: report.at,
                ref: {
                    delivery: { path: relative(resolvedRoot, reportPath).replaceAll('\\', '/'), sha256: sha256Buf(reportBytes) },
                    proof: { path: relative(resolvedRoot, realProofPath).replaceAll('\\', '/'), sha256: String(proofRef.sha256) },
                },
            };
        }
    }
    return best?.ref ?? null;
}

export const REPAIR_LEASE_MAX_MS = 900_000;

export function acquireRepairLease(
    leaseFile: string,
    payload: { pid: number; runId: string; nonce: string; at: number },
    opts: {
        now?: number;
        pidAlive?: (pid: number) => boolean;
        processStarts?: ProcessStarts;
        maxAgeMs?: number;
    } = {},
): void {
    const serialized = JSON.stringify(payload);
    try {
        writeFileSync(leaseFile, serialized, { flag: 'wx' });
        return;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    const now = opts.now ?? payload.at;
    const alive = opts.pidAlive ?? pidAlive;
    const starts = opts.processStarts ?? processStartTimes;
    const maxAgeMs = opts.maxAgeMs ?? REPAIR_LEASE_MAX_MS;

    let raw: string;
    let mtimeMs: number;
    try {
        raw = readFileSync(leaseFile, 'utf8');
        mtimeMs = statSync(leaseFile).mtimeMs;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            writeFileSync(leaseFile, serialized, { flag: 'wx' });
            return;
        }
        throw err;
    }

    let parsed: { pid?: unknown; at?: unknown } | null = null;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    const ownerPid = Number(parsed?.pid);
    const ownerAt = Number.isFinite(parsed?.at) ? Number(parsed!.at) : mtimeMs;
    const expired = now - ownerAt >= maxAgeMs && now - mtimeMs >= maxAgeMs;
    const ownerLive = Number.isSafeInteger(ownerPid) && ownerPid > 0 && savedProcessAlive(ownerPid, ownerAt, starts, alive);
    if (ownerLive && !expired) {
        throw Error(`repair lease held by active pid ${ownerPid}`);
    }

    const moved = `${leaseFile}.${process.pid}.${randomUUID()}.stale`;
    try {
        renameSync(leaseFile, moved);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            writeFileSync(leaseFile, serialized, { flag: 'wx' });
            return;
        }
        throw err;
    }
    try {
        const movedRaw = readFileSync(moved, 'utf8');
        if (movedRaw !== raw) {
            try { linkSync(moved, leaseFile); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
            throw Error('repair lease changed during reclamation');
        }
    } finally {
        rmSync(moved, { force: true });
    }

    writeFileSync(leaseFile, serialized, { flag: 'wx' });
}

export type ControlledDispatchOneOptions = {
    root: string;
    account: string;
    endedAt: number;
    server: string;
    runId: string;
    nonce: string;
    source: string;
    qualification: RecoveryQualificationRef;
    timeoutMs?: number;
    pollMs?: number;
    now?: () => number;
    pidAlive?: (pid: number) => boolean;
    processStarts?: ProcessStarts;
    ownerPid?: number;
};

const DISPATCH_WAIT_CAUSES = new Set([
    'recovery admission waiting: memory',
    'recovery admission waiting: maxBots',
    'recovery waits for runtime source owner',
]);

export type ControlledDispatchResult = { ok: boolean; detail: string; deferred?: boolean };

export async function runControlledDispatchOne(
    opts: ControlledDispatchOneOptions,
): Promise<ControlledDispatchResult> {
    const resolvedRoot = resolve(opts.root);
    const nowFn = opts.now ?? Date.now;
    const timeoutMs = opts.timeoutMs ?? 180_000;
    const pollMs = opts.pollMs ?? 500;
    const liveDir = liveRoot(resolvedRoot);
    const runDir = join(liveDir, 'fleet-runs', opts.runId);
    mkdirSync(runDir, { recursive: true });

    const holderProc = typeof opts.ownerPid === 'number'
        ? null
        : Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 60_000)', opts.runId], {
            cwd: resolvedRoot,
            windowsHide: true,
            stdin: 'ignore',
            stdout: 'ignore',
            stderr: 'ignore',
        });
    const ownerPid = opts.ownerPid ?? holderProc?.pid ?? process.pid;

    const recoveryRecord = {
        status: 'running',
        runId: opts.runId,
        pid: ownerPid,
        spec: {
            kind: 'run',
            capability: 'session-recovery-only',
            account: opts.account,
            script: 'scripts/session-check.ts',
            sessionRecovery: { account: opts.account, endedAt: opts.endedAt },
            repairs: [{ account: opts.account, endedAt: opts.endedAt }],
        },
    };
    atomicJson(join(runDir, 'recovery.json'), recoveryRecord);
    atomicJson(join(runDir, 'owner.json'), { runId: opts.runId, pid: ownerPid });

    const request: ControlledRecoveryRequest = {
        schema: RECOVERY_SCHEMA,
        kind: 'session-recovery',
        account: opts.account,
        server: opts.server,
        runId: opts.runId,
        nonce: opts.nonce,
        endedAt: opts.endedAt,
        source: opts.source,
        qualification: opts.qualification,
    };
    validateRecoveryRequest(request);

    const repairFile = join(resolvedRoot, '.practice', 'swarm-repair.json');
    const leaseFile = `${repairFile}.lease`;
    const resultsFile = `${repairFile}.results.jsonl`;

    try {
        acquireRepairLease(
            leaseFile,
            { pid: ownerPid, runId: opts.runId, nonce: opts.nonce, at: nowFn() },
            {
                now: nowFn(),
                pidAlive: opts.pidAlive,
                processStarts: opts.processStarts,
            },
        );
    } catch (err) {
        try { holderProc?.kill(); } catch { /* ignore */ }
        atomicJson(join(runDir, 'recovery.json'), { ...recoveryRecord, status: 'failed' });
        return { ok: false, detail: `repair lease busy: ${String(err).slice(0, 120)}` };
    }

    let finalStatus: 'succeeded' | 'failed' = 'failed';
    try {
        atomicJson(repairFile, request);
        const deadline = Date.now() + timeoutMs;
        let matchedResult: any = null;
        let readOffset = 0;
        let lastSize = -1;
        let lineTail = '';

        while (Date.now() < deadline) {
            if (existsSync(resultsFile)) {
                let size = 0;
                try { size = statSync(resultsFile).size; } catch { size = 0; }
                if (size !== lastSize) {
                    lastSize = size;
                    if (size < readOffset) {
                        readOffset = 0;
                        lineTail = '';
                    }
                    if (size > readOffset) {
                        const fd = openSync(resultsFile, 'r');
                        try {
                            const delta = size - readOffset;
                            const buf = Buffer.allocUnsafe(delta);
                            const nRead = readSync(fd, buf, 0, delta, readOffset);
                            readOffset += nRead;
                            const chunk = lineTail + buf.subarray(0, nRead).toString('utf8');
                            const lines = chunk.split(/\r?\n/);
                            lineTail = lines.pop() ?? '';
                            for (let i = lines.length - 1; i >= 0; i--) {
                                const line = lines[i]?.trim();
                                if (!line) continue;
                                try {
                                    const row = JSON.parse(line);
                                    const rawReq = typeof row?.raw === 'string' ? JSON.parse(row.raw) : null;
                                    if (rawReq?.runId === opts.runId && rawReq?.nonce === opts.nonce) {
                                        matchedResult = row.result;
                                        break;
                                    }
                                } catch { /* ignore partial line */ }
                            }
                            if (!matchedResult && lineTail.trim()) {
                                try {
                                    const row = JSON.parse(lineTail.trim());
                                    const rawReq = typeof row?.raw === 'string' ? JSON.parse(row.raw) : null;
                                    if (rawReq?.runId === opts.runId && rawReq?.nonce === opts.nonce) {
                                        matchedResult = row.result;
                                    }
                                } catch { /* partial trailing line */ }
                            }
                        } finally {
                            closeSync(fd);
                        }
                    }
                }
                if (matchedResult) break;
            }
            await Bun.sleep(pollMs);
        }

        if (!matchedResult) {
            return { ok: false, detail: `controlled recovery timed out after ${timeoutMs}ms` };
        }
        if (matchedResult.sessionRecovered !== true) {
            const reason = String(matchedResult.reason ?? 'controlled recovery did not confirm sessionRecovered');
            const cause = typeof matchedResult.setup?.cause === 'string' ? matchedResult.setup.cause : '';
            const isWait = (reason === 'recovery setup refused; no lease issued; no retry' && DISPATCH_WAIT_CAUSES.has(cause))
                || reason.startsWith('existing recovery lease held;');
            if (isWait) {
                return { ok: false, deferred: true, detail: cause ? `${reason}: ${cause}` : reason };
            }
            return { ok: false, detail: reason };
        }
        const proof = readLogoutProof(opts.account, opts.server, { root: resolveLifecycleRoot(opts.account, opts.server, resolvedRoot) });
        if (proof.state !== 'confirmed') {
            return { ok: false, detail: `logout proof after recovery is ${proof.state}` };
        }
        finalStatus = 'succeeded';
        return { ok: true, detail: `controlled recovery confirmed (${proof.attemptId})` };
    } finally {
        try {
            const cur = readJson(leaseFile, null);
            if (cur?.pid === ownerPid && cur?.runId === opts.runId && cur?.nonce === opts.nonce) {
                rmSync(leaseFile, { force: true });
            }
        } catch { /* ignore */ }
        try { holderProc?.kill(); } catch { /* ignore */ }
        atomicJson(join(runDir, 'recovery.json'), { ...recoveryRecord, status: finalStatus });
    }
}

export async function executeControlledLiveRecovery(
    target: { account: string; endedAt: number; server: string },
    opts: { root: string; now?: () => number; pidAlive?: (pid: number) => boolean },
): Promise<{ ok: boolean; detail: string; deferred?: boolean }> {
    const resolvedRoot = resolve(opts.root);
    const nowFn = opts.now ?? Date.now;
    const alive = opts.pidAlive ?? pidAlive;
    const ownerFile = join(liveRoot(resolvedRoot), 'swarm-owner.json');
    const owner = readJson(ownerFile, null);

    if (
        !owner
        || !Number.isSafeInteger(owner.pid)
        || owner.pid < 1
        || typeof owner.nonce !== 'string'
        || !owner.nonce
        || !alive(owner.pid)
        || !processMatchesRecent(owner.pid, owner.nonce)
    ) {
        return { ok: false, deferred: true, detail: 'swarm controller unavailable or source mismatch for controlled recovery' };
    }

    let source: string;
    try {
        source = cachedLaunchRevision(resolvedRoot);
    } catch {
        return { ok: false, deferred: true, detail: 'swarm controller unavailable or source revision unreadable for controlled recovery' };
    }

    if (owner.source !== source) {
        return { ok: false, deferred: true, detail: 'swarm controller unavailable or source mismatch for controlled recovery' };
    }

    const qualification = findCurrentNativeRecoveryQualification(resolvedRoot, source, target.endedAt, nowFn());
    if (!qualification) {
        return {
            ok: false,
            deferred: true,
            detail: `current native recovery qualification missing for source ${source.slice(0, 12)}; run packages/practice/src/session-recovery-proof.ts`,
        };
    }

    const runId = `fleet-recovery-${nowFn()}-${randomUUID().slice(0, 8)}`;
    const nonce = randomUUID();
    const childArgs = [
        join(resolvedRoot, 'packages', 'fleet', 'src', 'session-recovery.ts'),
        '--dispatch-one',
        `--root=${resolvedRoot}`,
        `--account=${target.account}`,
        `--ended-at=${target.endedAt}`,
        `--server=${target.server}`,
        `--run-id=${runId}`,
        `--nonce=${nonce}`,
        `--source=${source}`,
        `--qualification=${Buffer.from(JSON.stringify(qualification), 'utf8').toString('base64url')}`,
    ];

    return new Promise((resolvePromise) => {
        const child = spawn(process.execPath, childArgs, {
            cwd: resolvedRoot,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: process.env,
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', chunk => { stdout += String(chunk); });
        child.stderr?.on('data', chunk => { stderr += String(chunk); });
        child.on('error', err => resolvePromise({ ok: false, detail: `dispatch child spawn failed: ${String(err).slice(0, 160)}` }));
        child.on('close', code => {
            const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            const marker = [...lines].reverse().find(l => l.startsWith('FLEET_DISPATCH_RESULT '));
            if (marker) {
                try {
                    const parsed = JSON.parse(marker.slice('FLEET_DISPATCH_RESULT '.length));
                    if (typeof parsed?.ok === 'boolean' && typeof parsed?.detail === 'string') {
                        resolvePromise({
                            ok: parsed.ok,
                            detail: parsed.detail,
                            ...(parsed.deferred === true ? { deferred: true } : {}),
                        });
                        return;
                    }
                } catch { /* fall through */ }
            }
            resolvePromise({
                ok: code === 0,
                detail: `${stdout} ${stderr}`.trim().slice(-200) || `dispatch child exited ${code}`,
            });
        });
    });
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
    const argVal = (prefix: string) => argv.find(a => a.startsWith(prefix))?.slice(prefix.length);
    if (argv.includes('--dispatch-one')) {
        try {
            const root = resolve(argVal('--root=') ?? resolve(import.meta.dir, '../../..'));
            const account = argVal('--account=') ?? '';
            const endedAt = Number(argVal('--ended-at=') ?? 'NaN');
            const server = argVal('--server=') ?? LIVE_SERVER;
            const runId = argVal('--run-id=') ?? '';
            const nonce = argVal('--nonce=') ?? '';
            const source = argVal('--source=') ?? cachedLaunchRevision(root);
            const qualB64 = argVal('--qualification=') ?? '';
            if (!account || !Number.isFinite(endedAt) || endedAt < 0 || !runId || !nonce || !qualB64) {
                throw Error('missing or invalid --dispatch-one arguments');
            }
            const qualification = JSON.parse(Buffer.from(qualB64, 'base64url').toString('utf8')) as RecoveryQualificationRef;
            const res = await runControlledDispatchOne({ root, account, endedAt, server, runId, nonce, source, qualification });
            console.log(`FLEET_DISPATCH_RESULT ${JSON.stringify(res)}`);
            process.exit(res.ok ? 0 : 1);
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            console.log(`FLEET_DISPATCH_RESULT ${JSON.stringify({ ok: false, detail })}`);
            process.exit(1);
        }
    }
    const unknown = argv.find(a => a !== '--dry' && a !== '--json' && !a.startsWith('--root=') && !a.startsWith('--account='));
    if (unknown) {
        console.error(`usage: bun packages/fleet/src/session-recovery.ts [--dry] [--json] [--root=<dir>] [--account=<name>] (unexpected ${unknown})`);
        process.exit(2);
    }
    const dry = argv.includes('--dry');
    const jsonOut = argv.includes('--json');
    const root = resolve(argVal('--root=') ?? resolve(import.meta.dir, '../../..'));
    const hasAccountFlag = argv.some(a => a.startsWith('--account='));
    const account = argVal('--account=')?.trim();
    if (hasAccountFlag && !account) {
        console.error('session-recovery: --account= requires a non-empty account name');
        process.exit(2);
    }
    const res = await runStandaloneRecoveryPass({ root, dry, ...(account ? { account } : {}) });
    if (jsonOut) console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
}
