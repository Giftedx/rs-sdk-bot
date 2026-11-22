// Phase 0 fleet hygiene scanner and cleaner for leaked fixture stops, stale auto-stops, expired holds, and obsolete locks or leases.
// Strictly preserves all owner and specialist pause files, reserved accounts, and live process leases.
// Usage: bun packages/fleet/src/hygiene.ts [--root DIR] [--apply] [--json] [--grace-ms MS]
import {
    existsSync,
    lstatSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { CONTROLLERS, GATE_STALE_MS, LEASE_STALE_MS, leaseHolder, readLease } from '../../core/src/controllers';
import {
    fleetStateFile,
    listStopEntries,
    liveRoot,
    practiceRoot,
    simRoot,
    statusReadDirs,
} from '../../core/src/practice-paths';
import { heldRecoveryOwners } from '../../core/src/session-recovery-permit';
import { RESERVED_ACCOUNTS } from '../../core/src/specialist-boards';

export const PROOF_STOP_TEXT = /^(?:native recovery proof stop |native completed stop |cow-progress-order proof stop )/i;
export const SCRATCH_DIR_PATTERN = /^(?:recovery-permit|session-recovery|recovery-cli-[a-z]+|recovery-stop)-[A-Za-z0-9]{6}$/;
export const FIXTURE_STOP_PREFIX = /^(?:fl|fb|rngex)/i;
export const DEFAULT_HOLD_MAX_AGE_MS = 24 * 3600_000;
export const DEFAULT_FIXTURE_GRACE_MS = 0;

// Canonical and lowercase stop flags that hygiene must never remove.
export const PROTECTED_STOP_FLAGS: ReadonlySet<string> = new Set([
    'coordinator',
    'swarm',
    'dashboard-publish',
    'pk-squad',
    'runite-radar',
    'bravehardon',
    'unloadme',
    'all',
    'session-recovery',
    ...RESERVED_ACCOUNTS.map(a => a.toLowerCase()),
]);

const STALE_AUTO_STOP_FLAGS: ReadonlySet<string> = new Set([
    'planner',
    'cloud-launch',
]);

const STALE_AUTO_STOP_TEXT =
    /^(?:fleet-health auto-paused:|swarm stopped\b|swarm plan removed or stopped\b|swarm recovery stopped\b|inherited recovery stopped\b|fleet controller lease unavailable\b|swarm:\s)/i;

const PROTECTED_LOCK_NAMES: ReadonlySet<string> = new Set([
    'delivery-native.lock',
    'delivery-practice.lock',
]);

export type Phase0FindingKind =
    | 'fixture-stop'
    | 'stale-auto-stop'
    | 'expired-hold'
    | 'obsolete-job-lock'
    | 'expired-lease'
    | 'scratch-dir';

export type Phase0Finding = {
    kind: Phase0FindingKind;
    path: string;
    reason: string;
    detail?: Record<string, unknown>;
};

export type Phase0HoldPruning = {
    file: string;
    removedCount: number;
    keptCount: number;
    removedAccounts: string[];
};

export type Phase0HygieneReport = {
    root: string;
    now: number;
    dry: boolean;
    findings: Phase0Finding[];
    holdUpdates: Phase0HoldPruning[];
    preserved: { path: string; reason: string }[];
    counts: Record<Phase0FindingKind, number>;
    applied: number;
    errors: string[];
};

export type Phase0HygieneOptions = {
    now?: number;
    fixtureGraceMs?: number;
    holdMaxAgeMs?: number;
    leaseStaleMs?: number;
    gateStaleMs?: number;
    alive?: (pid: number) => boolean;
};

const defaultAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
};

function containsOwnerOrSpecialistMarker(text: string): boolean {
    return /\b(?:owner|specialist)\b/i.test(text);
}

function safeReadJson(file: string): unknown {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function loadPlanMetadata(root: string): {
    namedAccounts: Set<string>;
    disabledJobs: Set<string>;
    disabledAccounts: Set<string>;
} {
    const namedAccounts = new Set<string>();
    const disabledJobs = new Set<string>();
    const disabledAccounts = new Set<string>();
    const addName = (v: unknown) => {
        if (typeof v === 'string' && v.trim()) namedAccounts.add(v.trim().toLowerCase());
    };
    const walk = (v: any, depth = 0) => {
        if (depth > 6 || !v || typeof v !== 'object') return;
        if (Array.isArray(v)) {
            for (const x of v) walk(x, depth + 1);
            return;
        }
        addName(v.account);
        if (Array.isArray(v.accounts)) v.accounts.forEach(addName);
        for (const k of Object.keys(v)) walk(v[k], depth + 1);
    };
    for (const file of [
        join(root, 'swarm.json'),
        fleetStateFile(root),
        join(root, 'fleet', 'owners.json'),
    ]) {
        const parsed = safeReadJson(file);
        if (!parsed) continue;
        walk(parsed);
        const jobs = Array.isArray((parsed as any).jobs) ? (parsed as any).jobs : [];
        for (const job of jobs) {
            if (!job || typeof job !== 'object' || job.enabled !== false) continue;
            if (typeof job.name === 'string' && job.name.trim()) disabledJobs.add(job.name.trim().toLowerCase());
            if (typeof job.id === 'string' && job.id.trim()) disabledJobs.add(job.id.trim().toLowerCase());
            if (typeof job.script === 'string' && job.script.trim()) disabledJobs.add(job.script.trim().toLowerCase());
            if (typeof job.account === 'string' && job.account.trim()) disabledAccounts.add(job.account.trim().toLowerCase());
            if (Array.isArray(job.accounts)) {
                for (const acct of job.accounts) {
                    if (typeof acct === 'string' && acct.trim()) disabledAccounts.add(acct.trim().toLowerCase());
                }
            }
        }
    }
    return { namedAccounts, disabledJobs, disabledAccounts };
}

function loadActiveSpecialistAccounts(root: string, now: number): Set<string> {
    const active = new Set<string>(RESERVED_ACCOUNTS.map(a => a.toLowerCase()));
    for (const holdsFile of [
        join(practiceRoot(root), 'swarm-script-holds.json'),
        join(liveRoot(root), 'swarm-script-holds.json'),
    ]) {
        const parsed = safeReadJson(holdsFile);
        if (!Array.isArray(parsed)) continue;
        for (const h of parsed) {
            if (!h || typeof h !== 'object') continue;
            const acct = typeof h.account === 'string' ? h.account.trim().toLowerCase() : '';
            if (!acct) continue;
            const exp = Number(h.expiresAt);
            const unexpired = !Number.isFinite(exp) || exp > now;
            if (unexpired && (h.specialist === true || h.owner === true || containsOwnerOrSpecialistMarker(String(h.reason ?? '') + ' ' + String(h.kind ?? '')))) {
                active.add(acct);
            }
        }
    }
    for (const holdsDir of [
        join(practiceRoot(root), 'holds'),
        join(liveRoot(root), 'holds'),
    ]) {
        if (!existsSync(holdsDir)) continue;
        let files: string[] = [];
        try { files = readdirSync(holdsDir); } catch { continue; }
        for (const f of files) {
            if (!f.endsWith('.json')) continue;
            const parsed = safeReadJson(join(holdsDir, f)) as any;
            if (!parsed || typeof parsed !== 'object') continue;
            const acct = typeof parsed.account === 'string' ? parsed.account.trim().toLowerCase() : '';
            if (!acct) continue;
            const exp = Number(parsed.expiresAt);
            const unexpired = !Number.isFinite(exp) || exp > now;
            if (unexpired && (parsed.specialist === true || parsed.owner === true || containsOwnerOrSpecialistMarker(String(parsed.reason ?? '') + ' ' + String(parsed.kind ?? '')))) {
                active.add(acct);
            }
        }
    }
    return active;
}

export function isProtectedStopEntry(
    flag: string,
    text: string,
    activeSpecialists: ReadonlySet<string> = new Set(),
): { protected: boolean; reason?: string } {
    const normalized = flag.trim().toLowerCase();
    if (PROTECTED_STOP_FLAGS.has(normalized)) {
        return { protected: true, reason: `protected stop flag: stop-${flag}` };
    }
    if (activeSpecialists.has(normalized)) {
        return { protected: true, reason: `active specialist or reserved account hold: ${flag}` };
    }
    if (containsOwnerOrSpecialistMarker(text)) {
        return { protected: true, reason: 'stop text contains owner or specialist marker' };
    }
    return { protected: false };
}

function emptyCounts(): Record<Phase0FindingKind, number> {
    return {
        'fixture-stop': 0,
        'stale-auto-stop': 0,
        'expired-hold': 0,
        'obsolete-job-lock': 0,
        'expired-lease': 0,
        'scratch-dir': 0,
    };
}

function hasFreshLiveStatus(root: string, flag: string, now: number): boolean {
    const lower = flag.toLowerCase();
    for (const dir of statusReadDirs(root)) {
        if (!existsSync(dir)) continue;
        const candidate = join(dir, `${flag}.json`);
        const lowerCandidate = join(dir, `${lower}.json`);
        for (const file of candidate === lowerCandidate ? [candidate] : [candidate, lowerCandidate]) {
            const parsed = safeReadJson(file) as any;
            if (!parsed || typeof parsed !== 'object') continue;
            if (!parsed.result && Number.isFinite(parsed.at) && now - parsed.at < 60_000) return true;
        }
    }
    return false;
}

function isHoldPreserved(entry: any, now: number, holdMaxAgeMs: number): { keep: boolean; reason: string } {
    if (!entry || typeof entry !== 'object') return { keep: false, reason: 'malformed hold entry' };
    const acct = typeof entry.account === 'string' ? entry.account.trim().toLowerCase() : '';
    const markerBlob = `${String(entry.reason ?? '')} ${String(entry.kind ?? '')} ${String(entry.source ?? '')}`;
    if (RESERVED_ACCOUNTS.some(a => a.toLowerCase() === acct)) {
        return { keep: true, reason: 'reserved specialist/main account hold' };
    }
    if (entry.owner === true || /\bowner\b/i.test(markerBlob)) {
        return { keep: true, reason: 'owner hold' };
    }
    const exp = Number(entry.expiresAt);
    if (entry.specialist === true || /\bspecialist\b/i.test(markerBlob)) {
        if (!Number.isFinite(exp) || exp > now) {
            return { keep: true, reason: 'active specialist hold' };
        }
        return { keep: false, reason: 'expired specialist hold' };
    }
    if (Number.isFinite(exp)) {
        if (exp <= now) return { keep: false, reason: 'hold expiresAt elapsed' };
        return { keep: true, reason: 'hold expiresAt active' };
    }
    if (entry.expired === true) {
        return { keep: false, reason: 'hold marked expired' };
    }
    const reason = String(entry.reason ?? '');
    if (/^died\b/i.test(reason)) {
        return { keep: true, reason: 'death hold retained' };
    }
    const ts = Number.isFinite(Number(entry.heldAt))
        ? Number(entry.heldAt)
        : Number.isFinite(Number(entry.at))
            ? Number(entry.at)
            : NaN;
    if (Number.isFinite(ts) && now - ts >= holdMaxAgeMs) {
        return { keep: false, reason: 'agent/controller hold exceeded max age' };
    }
    if (!reason.trim() && !Number.isFinite(ts)) {
        return { keep: false, reason: 'unbounded stale hold entry' };
    }
    return { keep: true, reason: 'active hold' };
}

function inspectLockOrLeaseFile(
    file: string,
    opts: {
        now: number;
        leaseStaleMs: number;
        alive: (pid: number) => boolean;
        disabledJobs: ReadonlySet<string>;
        disabledAccounts: ReadonlySet<string>;
    },
): { kind: 'obsolete-job-lock' | 'expired-lease'; reason: string } | null {
    const baseName = basename(file);
    if (PROTECTED_LOCK_NAMES.has(baseName.toLowerCase())) return null;
    try {
        const info = lstatSync(file);
        if (info.isSymbolicLink() || !info.isFile()) return null;
    } catch {
        return null;
    }

    let raw = '';
    try { raw = readFileSync(file, 'utf8'); } catch { return null; }
    let statAt = 0;
    try { statAt = statSync(file).mtimeMs; } catch { statAt = 0; }

    const trimmed = raw.trim();
    const numericPid = Number(trimmed);
    if (trimmed && Number.isSafeInteger(numericPid) && numericPid > 0) {
        if (!opts.alive(numericPid)) return { kind: 'expired-lease', reason: `dead pid ${numericPid}` };
        if (opts.now - statAt >= opts.leaseStaleMs) return { kind: 'expired-lease', reason: `stale lease age >= ${opts.leaseStaleMs}ms` };
        return null;
    }

    const parsed = safeReadJson(file) as any;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const pid = Number(parsed.pid);
        const hasPid = Number.isSafeInteger(pid) && pid > 0;
        const pidLive = hasPid ? opts.alive(pid) : false;
        const exp = Number(parsed.expiresAt);
        if (Number.isFinite(exp) && exp <= opts.now) {
            return { kind: 'expired-lease', reason: 'lease expiresAt elapsed' };
        }
        const jobKey = typeof parsed.job === 'string'
            ? parsed.job.trim().toLowerCase()
            : typeof parsed.script === 'string'
                ? parsed.script.trim().toLowerCase()
                : '';
        const acctKey = typeof parsed.account === 'string' ? parsed.account.trim().toLowerCase() : '';
        const stemKey = baseName.replace(/\.(?:lock|lease|json)$/i, '').toLowerCase();
        const isDisabled = parsed.disabled === true
            || (jobKey !== '' && opts.disabledJobs.has(jobKey))
            || opts.disabledJobs.has(stemKey)
            || (acctKey !== '' && opts.disabledAccounts.has(acctKey));
        if (isDisabled && !pidLive) {
            return { kind: 'obsolete-job-lock', reason: 'disabled job lock with no live owner process' };
        }
        if (hasPid && !pidLive) {
            return { kind: 'expired-lease', reason: `dead pid ${pid}` };
        }
        if (!hasPid && (opts.now - statAt >= opts.leaseStaleMs || parsed.disabled === true)) {
            return { kind: isDisabled ? 'obsolete-job-lock' : 'expired-lease', reason: 'orphaned lock without live pid' };
        }
        if (hasPid && pidLive) return null;
    }

    if (!trimmed && opts.now - statAt >= opts.leaseStaleMs) {
        return { kind: 'expired-lease', reason: 'empty stale lock file' };
    }
    return null;
}

export function scanPhase0Hygiene(root: string, opts: Phase0HygieneOptions = {}): Phase0HygieneReport {
    const now = opts.now ?? Date.now();
    const fixtureGraceMs = opts.fixtureGraceMs ?? DEFAULT_FIXTURE_GRACE_MS;
    const holdMaxAgeMs = opts.holdMaxAgeMs ?? DEFAULT_HOLD_MAX_AGE_MS;
    const leaseStaleMs = opts.leaseStaleMs ?? LEASE_STALE_MS;
    const gateStaleMs = opts.gateStaleMs ?? GATE_STALE_MS;
    const alive = opts.alive ?? defaultAlive;

    const resolvedRoot = resolve(root);
    const { namedAccounts, disabledJobs, disabledAccounts } = loadPlanMetadata(resolvedRoot);
    const activeSpecialists = loadActiveSpecialistAccounts(resolvedRoot, now);
    const findings: Phase0Finding[] = [];
    const holdUpdates: Phase0HoldPruning[] = [];
    const preserved: { path: string; reason: string }[] = [];
    const seenPaths = new Set<string>();
    const addFinding = (f: Phase0Finding) => {
        const key = process.platform === 'win32' ? f.path.toLowerCase() : f.path;
        if (seenPaths.has(key)) return;
        seenPaths.add(key);
        findings.push(f);
    };

    // 1. Stop files across .practice/, .practice/live/, and .practice/sim/stops/
    for (const entry of listStopEntries(resolvedRoot)) {
        let info;
        try { info = lstatSync(entry.path); } catch { continue; }
        if (info.isSymbolicLink() || !info.isFile()) continue;

        const guard = isProtectedStopEntry(entry.flag, entry.text, activeSpecialists);
        if (guard.protected) {
            preserved.push({ path: entry.path, reason: guard.reason! });
            continue;
        }

        const withinGrace = fixtureGraceMs > 0 && now - info.mtimeMs < fixtureGraceMs;
        const lowerFlag = entry.flag.toLowerCase();
        const trimmedText = entry.text.trim();
        const isProofMarker = PROOF_STOP_TEXT.test(trimmedText);
        const isFixturePrefix = FIXTURE_STOP_PREFIX.test(lowerFlag) && (!namedAccounts.has(lowerFlag) || isProofMarker || entry.location === 'sim');

        if (isProofMarker || isFixturePrefix || entry.location === 'sim') {
            if (withinGrace && entry.location !== 'sim') {
                preserved.push({ path: entry.path, reason: 'within fixture grace window' });
            } else {
                addFinding({
                    kind: 'fixture-stop',
                    path: entry.path,
                    reason: isProofMarker ? 'proof stop marker' : entry.location === 'sim' ? 'sim stop file' : 'leaked fixture stop prefix',
                });
            }
            continue;
        }

        if (STALE_AUTO_STOP_FLAGS.has(lowerFlag) || STALE_AUTO_STOP_TEXT.test(trimmedText)) {
            if (!STALE_AUTO_STOP_FLAGS.has(lowerFlag) && hasFreshLiveStatus(resolvedRoot, entry.flag, now)) {
                preserved.push({ path: entry.path, reason: 'account has active live status row' });
            } else {
                addFinding({
                    kind: 'stale-auto-stop',
                    path: entry.path,
                    reason: STALE_AUTO_STOP_FLAGS.has(lowerFlag) ? `stale auto-stop: stop-${lowerFlag}` : 'stale controller auto-stop marker',
                });
            }
            continue;
        }

        preserved.push({ path: entry.path, reason: 'unclassified or manual pause file preserved' });
    }

    // 2. Scratch mkdtemp directories left in .practice/ or .practice/sim/
    for (const baseDir of [practiceRoot(resolvedRoot), simRoot(resolvedRoot)]) {
        if (!existsSync(baseDir)) continue;
        let names: string[] = [];
        try { names = readdirSync(baseDir); } catch { continue; }
        for (const name of names) {
            if (!SCRATCH_DIR_PATTERN.test(name)) continue;
            const full = join(baseDir, name);
            try {
                const info = lstatSync(full);
                if (info.isSymbolicLink() || !info.isDirectory()) continue;
                if (fixtureGraceMs > 0 && now - info.mtimeMs < fixtureGraceMs) continue;
                addFinding({ kind: 'scratch-dir', path: full, reason: 'leaked test scratch directory' });
            } catch { /* unreadable */ }
        }
    }

    // 3. Expired agent/controller holds in swarm-script-holds.json and holds/*.json
    for (const holdsFile of [
        join(practiceRoot(resolvedRoot), 'swarm-script-holds.json'),
        join(liveRoot(resolvedRoot), 'swarm-script-holds.json'),
    ]) {
        const parsed = safeReadJson(holdsFile);
        if (!Array.isArray(parsed)) continue;
        const removedAccounts: string[] = [];
        let keptCount = 0;
        for (const entry of parsed) {
            const verdict = isHoldPreserved(entry, now, holdMaxAgeMs);
            if (verdict.keep) {
                keptCount++;
            } else {
                const acct = typeof entry?.account === 'string' ? entry.account : '<unknown>';
                removedAccounts.push(acct);
                addFinding({
                    kind: 'expired-hold',
                    path: `${holdsFile}#${acct}:${String(entry?.script ?? '')}`,
                    reason: verdict.reason,
                    detail: { file: holdsFile, account: acct },
                });
            }
        }
        if (removedAccounts.length > 0) {
            holdUpdates.push({ file: holdsFile, removedCount: removedAccounts.length, keptCount, removedAccounts });
        }
    }

    for (const holdsDir of [
        join(practiceRoot(resolvedRoot), 'holds'),
        join(liveRoot(resolvedRoot), 'holds'),
    ]) {
        if (!existsSync(holdsDir)) continue;
        let files: string[] = [];
        try { files = readdirSync(holdsDir); } catch { continue; }
        for (const f of files) {
            if (!f.endsWith('.json')) continue;
            const full = join(holdsDir, f);
            const parsed = safeReadJson(full) as any;
            const verdict = isHoldPreserved(parsed, now, holdMaxAgeMs);
            if (verdict.keep) {
                preserved.push({ path: full, reason: verdict.reason });
            } else {
                addFinding({ kind: 'expired-hold', path: full, reason: verdict.reason });
            }
        }
    }

    // 4. Expired controller leases, stale gate tickets, obsolete disabled job locks, and stale recovery leases
    for (const ctrl of CONTROLLERS) {
        for (const leasePath of [join(resolvedRoot, ctrl.lease), join(liveRoot(resolvedRoot), `${ctrl.name}.lock`)]) {
            if (existsSync(leasePath)) {
                const holder = leaseHolder(leasePath, { now, alive, staleMs: leaseStaleMs });
                if (holder === null) {
                    const saved = readLease(leasePath);
                    addFinding({
                        kind: 'expired-lease',
                        path: leasePath,
                        reason: saved ? `expired ${ctrl.name} lease (pid ${saved.pid})` : `malformed ${ctrl.name} lease`,
                    });
                } else {
                    preserved.push({ path: leasePath, reason: `live ${ctrl.name} lease pid ${holder}` });
                }
            }
            const gateDir = `${leasePath}.gate`;
            if (existsSync(gateDir)) {
                let tickets: string[] = [];
                try { tickets = readdirSync(gateDir); } catch { tickets = []; }
                for (const t of tickets) {
                    const tPath = join(gateDir, t);
                    try {
                        const info = lstatSync(tPath);
                        if (info.isSymbolicLink() || !info.isFile()) continue;
                        const ownerPid = Number(t.split('.')[0]);
                        const pidLive = Number.isSafeInteger(ownerPid) && ownerPid > 0 && alive(ownerPid);
                        if (!pidLive || now - info.mtimeMs >= gateStaleMs) {
                            addFinding({ kind: 'expired-lease', path: tPath, reason: 'stale controller gate ticket' });
                        }
                    } catch { /* ignore */ }
                }
            }
        }
    }

    const extraLeaseFiles = [
        join(practiceRoot(resolvedRoot), 'dashboard-publish.lock'),
        join(liveRoot(resolvedRoot), 'dashboard-publish.lock'),
        join(practiceRoot(resolvedRoot), 'swarm-repair.json.lease'),
    ];
    for (const file of extraLeaseFiles) {
        if (!existsSync(file)) continue;
        const found = inspectLockOrLeaseFile(file, { now, leaseStaleMs, alive, disabledJobs, disabledAccounts });
        if (found) addFinding({ kind: found.kind, path: file, reason: found.reason });
        else preserved.push({ path: file, reason: 'active lock or lease' });
    }

    for (const lockDir of [
        join(practiceRoot(resolvedRoot), 'job-locks'),
        join(liveRoot(resolvedRoot), 'job-locks'),
        join(practiceRoot(resolvedRoot), 'account-leases'),
        join(liveRoot(resolvedRoot), 'account-leases'),
        join(practiceRoot(resolvedRoot), 'locks'),
        join(liveRoot(resolvedRoot), 'locks'),
    ]) {
        if (!existsSync(lockDir)) continue;
        let files: string[] = [];
        try { files = readdirSync(lockDir); } catch { continue; }
        for (const f of files) {
            if (!/\.(?:lock|lease|json)$/i.test(f)) continue;
            const full = join(lockDir, f);
            const found = inspectLockOrLeaseFile(full, { now, leaseStaleMs, alive, disabledJobs, disabledAccounts });
            if (found) addFinding({ kind: found.kind, path: full, reason: found.reason });
            else preserved.push({ path: full, reason: 'active job lock or lease' });
        }
    }

    for (const recoveryBase of [
        join(practiceRoot(resolvedRoot), 'session-recovery'),
        join(liveRoot(resolvedRoot), 'session-recovery'),
    ]) {
        const accountsDir = join(recoveryBase, 'accounts');
        if (!existsSync(accountsDir)) continue;
        const heldAccounts = new Set(
            heldRecoveryOwners(resolvedRoot, [], alive, now).map(h => h.account.toLowerCase()),
        );
        let accountDirs: string[] = [];
        try { accountDirs = readdirSync(accountsDir); } catch { continue; }
        for (const acct of accountDirs) {
            const leaseFile = join(accountsDir, acct, 'lease.json');
            if (!existsSync(leaseFile)) continue;
            const parsed = safeReadJson(leaseFile) as any;
            const pid = Number(parsed?.pid);
            const pidLive = Number.isSafeInteger(pid) && pid > 0 && alive(pid);
            if (!pidLive && !heldAccounts.has(acct.toLowerCase())) {
                addFinding({
                    kind: 'expired-lease',
                    path: leaseFile,
                    reason: `expired session-recovery lease for ${acct}`,
                });
            } else {
                preserved.push({ path: leaseFile, reason: `active session-recovery lease for ${acct}` });
            }
        }
    }

    const counts = emptyCounts();
    for (const f of findings) counts[f.kind]++;

    return {
        root: resolvedRoot,
        now,
        dry: true,
        findings,
        holdUpdates,
        preserved,
        counts,
        applied: 0,
        errors: [],
    };
}

export function applyPhase0Hygiene(
    root: string,
    opts: Phase0HygieneOptions & { dry?: boolean } = {},
): Phase0HygieneReport {
    const dry = opts.dry ?? true;
    const report = scanPhase0Hygiene(root, opts);
    report.dry = dry;
    if (dry) return report;

    const now = report.now;
    const holdMaxAgeMs = opts.holdMaxAgeMs ?? DEFAULT_HOLD_MAX_AGE_MS;
    const activeSpecialists = loadActiveSpecialistAccounts(report.root, now);

    // Group hold prunings by file so array JSON files are updated atomically once.
    const holdFilesToRewrite = new Set(report.holdUpdates.map(h => h.file));
    for (const holdsFile of holdFilesToRewrite) {
        try {
            const parsed = safeReadJson(holdsFile);
            if (!Array.isArray(parsed)) continue;
            const filtered = parsed.filter(entry => isHoldPreserved(entry, now, holdMaxAgeMs).keep);
            const removed = parsed.length - filtered.length;
            if (removed > 0) {
                const tmp = `${holdsFile}.hygiene-${process.pid}.tmp`;
                writeFileSync(tmp, JSON.stringify(filtered, null, 2));
                renameSync(tmp, holdsFile);
                report.applied += removed;
            }
        } catch (err) {
            report.errors.push(`hold update ${holdsFile}: ${String(err)}`);
        }
    }

    for (const finding of report.findings) {
        if (finding.kind === 'expired-hold' && finding.detail?.file) {
            // Already handled in the swarm-script-holds.json rewrite loop above.
            continue;
        }
        try {
            if (!existsSync(finding.path)) continue;
            const info = lstatSync(finding.path);
            if (info.isSymbolicLink()) continue;

            // Defense in depth: re-check stop protection right before deletion.
            if (finding.kind === 'fixture-stop' || finding.kind === 'stale-auto-stop') {
                const fileName = basename(finding.path);
                if (!fileName.startsWith('stop-')) continue;
                const flag = fileName.slice('stop-'.length);
                const text = info.isFile() ? readFileSync(finding.path, 'utf8') : '';
                if (isProtectedStopEntry(flag, text, activeSpecialists).protected) continue;
            }

            rmSync(finding.path, { recursive: info.isDirectory(), force: true });
            report.applied++;
        } catch (err) {
            report.errors.push(`remove ${finding.path}: ${String(err)}`);
        }
    }

    return report;
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const argValue = (flag: string): string | undefined => {
        const eq = args.find(a => a.startsWith(`${flag}=`));
        if (eq) return eq.slice(flag.length + 1);
        const idx = args.indexOf(flag);
        return idx >= 0 ? args[idx + 1] : undefined;
    };
    const root = resolve(argValue('--root') ?? join(import.meta.dir, '..', '..', '..'));
    const apply = args.includes('--apply');
    const jsonOut = args.includes('--json');
    const graceRaw = argValue('--grace-ms');
    const graceMs = graceRaw !== undefined && Number.isFinite(Number(graceRaw)) ? Number(graceRaw) : DEFAULT_FIXTURE_GRACE_MS;

    const result = applyPhase0Hygiene(root, { dry: !apply, fixtureGraceMs: graceMs });
    if (jsonOut) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        console.log(JSON.stringify({
            root: result.root,
            dry: result.dry,
            totalFindings: result.findings.length,
            counts: result.counts,
            applied: result.applied,
            preserved: result.preserved.length,
            errors: result.errors.length,
        }));
        console.log(
            `RESULT ${result.errors.length ? 'fail' : 'ok'} phase0-hygiene ` +
            `${result.dry ? 'would clear' : 'cleared'} ${result.dry ? result.findings.length : result.applied} items ` +
            `(preserved ${result.preserved.length})`,
        );
    }
    if (result.errors.length > 0) process.exit(1);
}
