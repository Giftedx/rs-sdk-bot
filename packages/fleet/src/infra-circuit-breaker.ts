// Global controller-level exponential backoff circuit breaker for remote Git claim authority, proxy, and server-drain faults.
// Never records per-account deaths, holds, stop files, or retirements.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { renameRetry } from '../../core/src/status';

export type InfraFaultKind = 'remote_git_claim' | 'proxy' | 'server_drain';

export interface InfraBreakerBucket {
    consecutiveFailures: number;
    openUntil: number;
    lastFailureAt: number;
    lastBackoffMs: number;
    lastError: string;
}

export interface InfraCircuitSnapshot {
    schema: 'infra-circuit-breaker/1';
    updatedAt: number;
    faults: Record<InfraFaultKind, InfraBreakerBucket>;
}

export interface InfraCircuitBreakerOptions {
    baseMs?: number;
    maxMs?: number;
    factor?: number;
    jitterRatio?: number;
    threshold?: number;
    stateFile?: string;
    now?: () => number;
    random?: () => number;
    rename?: (from: string, to: string) => void;
}

export interface InfraProceedCheck {
    allowed: boolean;
    waitMs: number;
    openUntil: number;
    kind?: InfraFaultKind;
    consecutiveFailures: number;
    reason?: string;
}

export interface InfraFailureOutcome {
    tripped: boolean;
    kind: InfraFaultKind | null;
    consecutiveFailures: number;
    backoffMs: number;
    openUntil: number;
}

const KINDS: readonly InfraFaultKind[] = ['remote_git_claim', 'proxy', 'server_drain'];

const PROXY_FAULT_PATTERNS: readonly RegExp[] = [
    /ERR_PROXY_CONNECTION_FAILED/i,
    /proxy\s+(?:connect(?:ion)?|tunnel|error|refused|timed?\s*out|unavailable|failed|auth)/i,
    /\bHTTP\s*407\b|407 Proxy Authentication Required/i,
    /\bCONNECT\s+(?:502|503|504|failed)\b/i,
    /\bsocks(?:5|4)?\b.*(?:refused|timed?\s*out|failed|unreachable|closed)/i,
    /HTTPS_PROXY|HTTP_PROXY|websocket proxy/i,
];

const SERVER_DRAIN_PATTERNS: readonly RegExp[] = [
    /server\s+(?:is\s+)?(?:draining|drain(?:ed)?|shutting down|being updated|offline|closed)/i,
    /world\s+(?:is\s+)?(?:full|offline|updating|draining|restarting)/i,
    /too many login attempts/i,
    /login server(?:\s+is)?\s+(?:offline|busy|unavailable)/i,
    /\b503 Service Unavailable\b/i,
    /error connecting to (?:game\s+)?server/i,
    /connecting to update server/i,
];

const REMOTE_GIT_CLAIM_PATTERNS: readonly RegExp[] = [
    /fleet\s+(?:trade|account|controller|swarm)\s+(?:claim|lease)\s+authority/i,
    /fleet controller lease unavailable/i,
    /refs\/heads\/fleet-(?:lease|trade-claim)/i,
    /unable to access ['"]?https?:\/\//i,
    /could not resolve host/i,
    /temporary failure in name resolution/i,
    /failed to connect to .* port \d+/i,
    /connection (?:timed out|reset by peer|refused)/i,
    /\b(?:fetch|push) failed\b.*(?:origin|git|http|ssh)/i,
    /git-(?:upload|receive)-pack|remote hung up unexpectedly|early EOF/i,
    /cannot lock ref .*fleet-(?:lease|trade-claim)/i,
    /error:\s*(?:50[0234]|429)\b/i,
    /HTTP\s+(?:50[0234]|429)\b/i,
];

export function classifyInfraFault(errorOrMessage: unknown): InfraFaultKind | null {
    const text = errorOrMessage instanceof Error ? `${errorOrMessage.name}: ${errorOrMessage.message}` : String(errorOrMessage ?? '');
    if (!text.trim()) return null;
    if (PROXY_FAULT_PATTERNS.some(re => re.test(text))) return 'proxy';
    if (SERVER_DRAIN_PATTERNS.some(re => re.test(text))) return 'server_drain';
    if (REMOTE_GIT_CLAIM_PATTERNS.some(re => re.test(text))) return 'remote_git_claim';
    return null;
}

function emptyBucket(): InfraBreakerBucket {
    return { consecutiveFailures: 0, openUntil: 0, lastFailureAt: 0, lastBackoffMs: 0, lastError: '' };
}

function sanitizeErrorText(errorOrMessage: unknown): string {
    const raw = errorOrMessage instanceof Error ? errorOrMessage.message : String(errorOrMessage ?? '');
    return raw.replace(/PASSWORD=[^\s"']+/gi, 'PASSWORD=[redacted]')
        .replace(/https?:\/\/[^@\s]+@/gi, 'https://[redacted]@')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);
}

export class InfraCircuitBreaker {
    private readonly baseMs: number;
    private readonly maxMs: number;
    private readonly factor: number;
    private readonly jitterRatio: number;
    private readonly threshold: number;
    private readonly stateFile?: string;
    private readonly now: () => number;
    private readonly random: () => number;
    private readonly rename?: (from: string, to: string) => void;
    private state: InfraCircuitSnapshot;

    constructor(opts: InfraCircuitBreakerOptions = {}) {
        this.baseMs = Math.max(100, opts.baseMs ?? 5_000);
        this.maxMs = Math.max(this.baseMs, opts.maxMs ?? 15 * 60_000);
        this.factor = Math.max(1.5, opts.factor ?? 2);
        this.jitterRatio = Math.min(0.5, Math.max(0, opts.jitterRatio ?? 0.2));
        this.threshold = Math.max(1, Math.trunc(opts.threshold ?? 1));
        this.stateFile = opts.stateFile;
        this.now = opts.now ?? Date.now;
        this.random = opts.random ?? Math.random;
        this.rename = opts.rename;
        this.state = this.load();
    }

    private emptyState(): InfraCircuitSnapshot {
        return {
            schema: 'infra-circuit-breaker/1',
            updatedAt: this.now(),
            faults: {
                remote_git_claim: emptyBucket(),
                proxy: emptyBucket(),
                server_drain: emptyBucket(),
            },
        };
    }

    private load(): InfraCircuitSnapshot {
        if (!this.stateFile) return this.emptyState();
        try {
            const parsed = JSON.parse(readFileSync(this.stateFile, 'utf8'));
            if (parsed?.schema !== 'infra-circuit-breaker/1' || typeof parsed.faults !== 'object') return this.emptyState();
            const base = this.emptyState();
            for (const kind of KINDS) {
                const raw = parsed.faults[kind];
                if (!raw || typeof raw !== 'object') continue;
                base.faults[kind] = {
                    consecutiveFailures: Number.isSafeInteger(raw.consecutiveFailures) && raw.consecutiveFailures >= 0 ? raw.consecutiveFailures : 0,
                    openUntil: Number.isFinite(raw.openUntil) && raw.openUntil >= 0 ? raw.openUntil : 0,
                    lastFailureAt: Number.isFinite(raw.lastFailureAt) && raw.lastFailureAt >= 0 ? raw.lastFailureAt : 0,
                    lastBackoffMs: Number.isFinite(raw.lastBackoffMs) && raw.lastBackoffMs >= 0 ? raw.lastBackoffMs : 0,
                    lastError: typeof raw.lastError === 'string' ? raw.lastError.slice(0, 240) : '',
                };
            }
            return base;
        } catch {
            return this.emptyState();
        }
    }

    private persist(): void {
        if (!this.stateFile) return;
        const tmp = `${this.stateFile}.${process.pid}.tmp`;
        try {
            mkdirSync(dirname(this.stateFile), { recursive: true });
            writeFileSync(tmp, JSON.stringify(this.state, null, 2));
            renameRetry(tmp, this.stateFile, this.rename);
        } catch {
            try { rmSync(tmp, { force: true }); } catch { /* ignore cleanup error */ }
            // Persistence must not break controller execution.
        }
    }

    private computeBackoffMs(consecutiveFailures: number): number {
        const exponent = Math.max(0, consecutiveFailures - this.threshold);
        const raw = Math.min(this.maxMs, this.baseMs * Math.pow(this.factor, exponent));
        const r = Math.min(1, Math.max(0, this.random()));
        const jitter = 1 + (r * 2 - 1) * this.jitterRatio;
        return Math.min(this.maxMs, Math.max(this.baseMs, Math.round(raw * jitter)));
    }

    recordFailure(errorOrMessage: unknown, kindOverride?: InfraFaultKind): InfraFailureOutcome {
        const kind = kindOverride ?? classifyInfraFault(errorOrMessage);
        if (!kind) {
            return { tripped: false, kind: null, consecutiveFailures: 0, backoffMs: 0, openUntil: 0 };
        }
        const at = this.now();
        const bucket = this.state.faults[kind];
        bucket.consecutiveFailures += 1;
        bucket.lastFailureAt = at;
        bucket.lastError = sanitizeErrorText(errorOrMessage);
        const tripped = bucket.consecutiveFailures >= this.threshold;
        const backoffMs = tripped ? this.computeBackoffMs(bucket.consecutiveFailures) : 0;
        bucket.lastBackoffMs = backoffMs;
        bucket.openUntil = tripped ? at + backoffMs : 0;
        this.state.updatedAt = at;
        this.persist();
        return {
            tripped,
            kind,
            consecutiveFailures: bucket.consecutiveFailures,
            backoffMs,
            openUntil: bucket.openUntil,
        };
    }

    recordSuccess(kind?: InfraFaultKind): void {
        const at = this.now();
        let changed = false;
        const targets = kind ? [kind] : KINDS;
        for (const k of targets) {
            const b = this.state.faults[k];
            if (b.consecutiveFailures > 0 || b.openUntil > 0 || b.lastError) {
                this.state.faults[k] = emptyBucket();
                changed = true;
            }
        }
        if (changed) {
            this.state.updatedAt = at;
            this.persist();
        }
    }

    canProceed(kind?: InfraFaultKind): InfraProceedCheck {
        const at = this.now();
        const checkKinds = kind ? [kind] : KINDS;
        let worstKind: InfraFaultKind | undefined;
        let maxOpenUntil = 0;
        let maxFailures = 0;
        let worstError = '';
        for (const k of checkKinds) {
            const b = this.state.faults[k];
            if (b.openUntil > at && b.openUntil > maxOpenUntil) {
                maxOpenUntil = b.openUntil;
                worstKind = k;
                maxFailures = b.consecutiveFailures;
                worstError = b.lastError;
            }
        }
        if (worstKind && maxOpenUntil > at) {
            const waitMs = maxOpenUntil - at;
            return {
                allowed: false,
                waitMs,
                openUntil: maxOpenUntil,
                kind: worstKind,
                consecutiveFailures: maxFailures,
                reason: `${worstKind} backoff active (${Math.ceil(waitMs / 1000)}s remaining${worstError ? `: ${worstError}` : ''})`,
            };
        }
        return {
            allowed: true,
            waitMs: 0,
            openUntil: 0,
            consecutiveFailures: kind ? this.state.faults[kind].consecutiveFailures : Math.max(...checkKinds.map(k => this.state.faults[k].consecutiveFailures)),
        };
    }

    snapshot(): InfraCircuitSnapshot {
        return structuredClone(this.state);
    }

    async guard<T>(fn: () => T | Promise<T>, kind?: InfraFaultKind): Promise<T> {
        const status = this.canProceed(kind);
        if (!status.allowed) {
            throw new Error(`infra circuit breaker open: ${status.reason}`);
        }
        try {
            const res = await fn();
            this.recordSuccess(kind);
            return res;
        } catch (err) {
            this.recordFailure(err, kind);
            throw err;
        }
    }
}
