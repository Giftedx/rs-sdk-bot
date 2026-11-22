// OutcomeClassifier and raw worker-exit classifier covering all 8 OutcomeKinds:
// updates RateStore, market (item, venue) TTL cooldowns, location/logout recovery holds,
// global infra circuit breaker (without account penalties), defect quarantine, and non-expiring death.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { liveRoot, repoRoot } from '../../core/src/practice-paths';
import {
    validateRunOutcome,
    type DeathOutcome,
    type InfraFaultOutcome,
    type InfraFaultSource,
    type LocationStrandedOutcome,
    type MarketUnavailableOutcome,
    type MissingSupplyOutcome,
    type RunOutcome,
    type RunOutcomeMissingItem,
    type SessionUnsettledOutcome,
    type TargetMetOutcome,
    type WorkerDefectOutcome,
    type WorkerTile,
} from '../../workers/src/contracts';
import {
    createExpiringHold,
    isHoldActive,
    marketCooldownKey,
    pruneExpiredCooldowns,
    pruneExpiredHolds,
    setCooldown,
    validateAccountState,
    validateDefectRecord,
    validateRateSample,
    validateWorldSnapshot,
    type AccountLifecycle,
    type AccountState,
    type DefectRecord,
    type InfraCircuitBreakerState,
    type OperatorCommand,
    type RateSample,
    type SystemHold,
    type WorldSnapshot,
} from './contracts';
import type { RateStore } from './rate-store';

export const DEFAULT_MARKET_COOLDOWN_MS = 10 * 60_000;
export const DEFAULT_RECOVERY_HOLD_TTL_MS = 30 * 60_000;
export const DEFAULT_DEFECT_TTL_MS = 24 * 3_600_000;
export const DEFAULT_INFRA_BASE_BACKOFF_MS = 30_000;
export const DEFAULT_INFRA_MAX_BACKOFF_MS = 15 * 60_000;
export const DEFAULT_INFRA_BACKOFF_FACTOR = 2;
export const OUTCOME_STATE_SCHEMA_VERSION = 1 as const;

export interface RawWorkerExitInput {
    readonly activityId: string;
    readonly account: string;
    readonly exitCode?: number | null;
    readonly status?: string;
    readonly reason?: string;
    readonly summary?: string;
    readonly detail?: string;
    readonly error?: string;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly ticksElapsed?: number;
    readonly durationMs?: number;
    readonly unitsCompleted?: number;
    readonly xpGained?: Readonly<Record<string, number>>;
    readonly itemsDelta?: Readonly<Record<number, number>>;
    readonly coinsDelta?: number;
    readonly pos?: WorkerTile | null;
    readonly missing?: readonly RunOutcomeMissingItem[];
    readonly marketItemId?: number;
    readonly marketVenue?: string;
    readonly cooldownMs?: number;
    readonly infraSource?: InfraFaultSource;
    readonly retryAfterMs?: number;
    readonly faultSignature?: string;
    readonly logPath?: string;
    readonly tickRecordPath?: string;
    readonly died?: boolean;
    readonly outcome?: RunOutcome;
}

export interface OutcomeClassifierOptions {
    readonly rateStore?: RateStore;
    readonly root?: string;
    readonly filePath?: string;
    readonly persist?: boolean;
    readonly defaultMarketCooldownMs?: number;
    readonly defaultRecoveryHoldTtlMs?: number;
    readonly defaultDefectTtlMs?: number;
    readonly infraBaseBackoffMs?: number;
    readonly infraMaxBackoffMs?: number;
    readonly infraBackoffFactor?: number;
}

export interface AccountOutcomeOverlay {
    readonly lifecycleOverride?: AccountLifecycle;
    readonly lifecycleExpiresAt?: number;
    readonly holds: readonly SystemHold[];
    readonly cooldowns: Readonly<Record<string, number>>;
}

export interface OutcomeClassifierState {
    readonly schemaVersion: typeof OUTCOME_STATE_SCHEMA_VERSION;
    readonly updatedAt: number;
    readonly infraBreaker: InfraCircuitBreakerState;
    readonly marketCooldowns: Readonly<Record<string, number>>;
    readonly defects: readonly DefectRecord[];
    readonly accountOverlays: Readonly<Record<string, AccountOutcomeOverlay>>;
}

export interface OutcomeClassificationResult {
    readonly outcome: RunOutcome;
    readonly account: string;
    readonly activityId: string;
    readonly recordedRateSample?: RateSample;
    readonly accountLifecycle?: AccountLifecycle;
    readonly addedHold?: SystemHold;
    readonly addedCooldownKey?: string;
    readonly cooldownExpiresAt?: number;
    readonly missingSupplies?: readonly RunOutcomeMissingItem[];
    readonly defect?: DefectRecord;
    readonly infraBreaker?: InfraCircuitBreakerState;
    readonly accountPenalized: boolean;
    readonly unlockFollowUp: boolean;
    readonly clearedTransientRecovery: boolean;
    readonly summary: string;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmpty(v: unknown): string | undefined {
    return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf8');
    renameSync(tmpPath, filePath);
}

function normalizeFaultSignature(raw: string): string {
    const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() ?? '';
    const scrubbed = firstLine
        .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '<ts>')
        .replace(/\b(?:x|z|level|tick|id|pid|port)[=:\s]*-?\d+\b/gi, (m) => m.replace(/-?\d+/, '<n>'))
        .replace(/\b-?\d+\b/g, '<n>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
    return scrubbed.length > 0 ? scrubbed : 'worker_defect';
}

function defectKey(activityId: string, faultSignature: string): string {
    return `${activityId}::${faultSignature}`;
}

function sanitizeXpGained(raw?: Readonly<Record<string, number>>): Record<string, number> | undefined {
    if (!raw) return undefined;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) {
        if (nonEmpty(k) && typeof v === 'number' && Number.isFinite(v) && v >= 0) {
            out[k.trim()] = v;
        }
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeItemsDelta(raw?: Readonly<Record<number, number>>): Record<number, number> | undefined {
    if (!raw) return undefined;
    const out: Record<number, number> = {};
    for (const [k, v] of Object.entries(raw)) {
        if (/^(0|[1-9]\d*)$/.test(k) && typeof v === 'number' && Number.isFinite(v)) {
            out[Number(k)] = Math.trunc(v);
        }
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

function detectInfraSource(text: string): InfraFaultSource | undefined {
    if (/(?:proxy|socks|econnrefused|ehostunreach|enetunreach|gateway.*502|\b502\b|\b503\b|\b429\b|tunnel)/i.test(text)) {
        return 'proxy';
    }
    if (/(?:server.?drain|world.?update|restarting|maintenance|engine.?shutdown|eaddrinuse|localserver)/i.test(text)) {
        return 'server_drain';
    }
    if (/(?:remote.?git|push.*rejected|non-fast-forward|git.*lock|fleet-data.*sync|claim.?authority)/i.test(text)) {
        return 'claim_authority';
    }
    if (/(?:websocket|gateway|connect|network|socket).*(?:timeout|timed out|etimedout)/i.test(text)) {
        return 'network';
    }
    if (/(?:\binfra.?fault\b|circuit.?breaker|rate.?limit)/i.test(text)) {
        return 'unknown';
    }
    return undefined;
}

function inferMissingItems(text: string): RunOutcomeMissingItem[] {
    const idMatch = /\bitem(?:id)?[=: #]*(\d+)\b/i.exec(text);
    const qtyMatch = /\b(?:need|required|missing)[=: ]*(\d+)\b/i.exec(text);
    const required = qtyMatch ? Math.max(1, Number(qtyMatch[1])) : 1;
    if (idMatch) {
        return [{ itemId: Number(idMatch[1]), required, available: 0 }];
    }
    if (/\b(?:coins|gp|gold)\b/i.test(text)) {
        return [{ itemId: 995, required, available: 0, itemName: 'Coins' }];
    }
    return [{ itemId: 995, required, available: 0 }];
}

function inferMarketDetails(input: RawWorkerExitInput, text: string): { itemId: number; venue: string } {
    if (input.marketItemId !== undefined || input.marketVenue !== undefined) {
        return {
            itemId: Math.max(0, Math.trunc(input.marketItemId ?? 0)),
            venue: nonEmpty(input.marketVenue) ?? (/shop/i.test(text) ? 'npc_shop' : 'ge'),
        };
    }
    const idMatch = /\bitem(?:id)?[=: #]*(\d+)\b/i.exec(text);
    const venue = /\bshop\b/i.test(text) ? 'npc_shop' : 'ge';
    return {
        itemId: idMatch ? Math.max(0, Math.trunc(Number(idMatch[1]))) : 0,
        venue,
    };
}

export function classifyRawWorkerExit(input: RawWorkerExitInput): RunOutcome {
    if (input.outcome && validateRunOutcome(input.outcome).length === 0) {
        return input.outcome;
    }

    const ticksElapsed = Math.max(0, Math.round(input.ticksElapsed ?? 0));
    const xpGained = sanitizeXpGained(input.xpGained);
    const itemsDelta = sanitizeItemsDelta(input.itemsDelta);
    const coinsDelta =
        typeof input.coinsDelta === 'number' && Number.isFinite(input.coinsDelta)
            ? Math.trunc(input.coinsDelta)
            : undefined;
    const summary = nonEmpty(input.summary) ?? nonEmpty(input.reason) ?? nonEmpty(input.status);
    const detail = nonEmpty(input.detail) ?? nonEmpty(input.error) ?? nonEmpty(input.reason);
    const text = [input.status, input.reason, input.summary, input.detail, input.error, input.stderr, input.stdout]
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .join('\n');

    const base = {
        activityId: input.activityId.trim(),
        account: input.account.trim(),
        ticksElapsed,
        ...(typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) && input.durationMs >= 0
            ? { durationMs: input.durationMs }
            : {}),
        ...(typeof input.unitsCompleted === 'number' && Number.isFinite(input.unitsCompleted) && input.unitsCompleted >= 0
            ? { unitsCompleted: input.unitsCompleted }
            : {}),
        ...(xpGained ? { xpGained } : {}),
        ...(itemsDelta ? { itemsDelta } : {}),
        ...(coinsDelta !== undefined ? { coinsDelta } : {}),
        ...(summary ? { summary } : {}),
    };

    if (input.died === true || /\bdied\b|\bdeath\b|you are dead|oh dear/i.test(text)) {
        const out: DeathOutcome = {
            kind: 'death',
            ...base,
            ...(nonEmpty(input.faultSignature) ? { faultSignature: nonEmpty(input.faultSignature) } : {}),
            ...(input.pos !== undefined ? { pos: input.pos } : {}),
            ...(nonEmpty(input.logPath) ? { logPath: nonEmpty(input.logPath) } : {}),
            ...(nonEmpty(input.tickRecordPath) ? { tickRecordPath: nonEmpty(input.tickRecordPath) } : {}),
            ...(detail ? { detail } : {}),
        };
        return out;
    }

    const infraSource = input.infraSource ?? detectInfraSource(text);
    if (infraSource) {
        const out: InfraFaultOutcome = {
            kind: 'infra_fault',
            ...base,
            source: infraSource,
            ...(typeof input.retryAfterMs === 'number' && Number.isFinite(input.retryAfterMs) && input.retryAfterMs > 0
                ? { retryAfterMs: input.retryAfterMs }
                : {}),
            ...(detail ? { detail } : {}),
        };
        return out;
    }

    if (
        /session.?unsettled|logout.?proof|still.?logged.?in|already logged in|session.?held|world.?switch.?failed|not logged out/i.test(
            text,
        )
    ) {
        const out: SessionUnsettledOutcome = {
            kind: 'session_unsettled',
            ...base,
            ...(nonEmpty(input.reason) ? { reason: nonEmpty(input.reason) } : {}),
            ...(detail ? { detail } : {}),
        };
        return out;
    }

    if (/location.?stranded|stranded|no path to|cannot reach|unreachable bank|stuck.*(?:upstairs|basement|dungeon|island)/i.test(text)) {
        const out: LocationStrandedOutcome = {
            kind: 'location_stranded',
            ...base,
            ...(input.pos !== undefined ? { pos: input.pos } : {}),
            ...(detail ? { detail } : {}),
        };
        return out;
    }

    if (
        input.marketItemId !== undefined ||
        input.marketVenue !== undefined ||
        /market.?unavailable|out of stock|no ge offers|ge.*unavailable|shop.*empty|buy limit|no sellers|not sold here/i.test(text)
    ) {
        const market = inferMarketDetails(input, text);
        const out: MarketUnavailableOutcome = {
            kind: 'market_unavailable',
            ...base,
            itemId: market.itemId,
            venue: market.venue,
            ...(typeof input.cooldownMs === 'number' && Number.isFinite(input.cooldownMs) && input.cooldownMs > 0
                ? { cooldownMs: input.cooldownMs }
                : {}),
            ...(detail ? { detail } : {}),
        };
        return out;
    }

    if (
        (input.missing && input.missing.length > 0) ||
        /missing.?supply|insufficient.*(?:coins|gp|supply|supplies|food|runes|logs|ore|bars|arrows|tools|item)|out of supplies|no .* in bank/i.test(
            text,
        )
    ) {
        const missing = input.missing && input.missing.length > 0 ? input.missing : inferMissingItems(text);
        const out: MissingSupplyOutcome = {
            kind: 'missing_supply',
            ...base,
            missing,
        };
        return out;
    }

    const headText = [input.status, input.reason, input.error].filter(Boolean).join(' ');
    const hasFailureMarker = /\b(?:fail|failed|error|exception|crash|abort|defect|timeout|timed out)\b/i.test(headText);
    const hasSuccessStatus =
        input.exitCode === 0 ||
        input.status === 'done' ||
        input.status === 'ok' ||
        input.status === 'target_met' ||
        /\b(?:target.?met|completed?|done)\b/i.test(headText);

    if (hasSuccessStatus && !hasFailureMarker && (input.exitCode === undefined || input.exitCode === 0)) {
        const out: TargetMetOutcome = {
            kind: 'target_met',
            ...base,
        };
        return out;
    }

    const faultSignature =
        nonEmpty(input.faultSignature) ??
        normalizeFaultSignature(detail ?? summary ?? `exit_${input.exitCode ?? 'unknown'}`);
    const out: WorkerDefectOutcome = {
        kind: 'worker_defect',
        ...base,
        faultSignature,
        ...(nonEmpty(input.logPath) ? { logPath: nonEmpty(input.logPath) } : {}),
        ...(nonEmpty(input.tickRecordPath) ? { tickRecordPath: nonEmpty(input.tickRecordPath) } : {}),
        ...(detail ? { detail } : {}),
    };
    return out;
}

export class OutcomeClassifier {
    readonly filePath: string;
    private readonly rateStore?: RateStore;
    private readonly persist: boolean;
    private readonly defaultMarketCooldownMs: number;
    private readonly defaultRecoveryHoldTtlMs: number;
    private readonly defaultDefectTtlMs: number;
    private readonly infraBaseBackoffMs: number;
    private readonly infraMaxBackoffMs: number;
    private readonly infraBackoffFactor: number;

    private infraBreaker: InfraCircuitBreakerState = { open: false, consecutiveFaults: 0 };
    private marketCooldowns: Record<string, number> = {};
    private readonly defects = new Map<string, DefectRecord>();
    private readonly accountOverlays = new Map<string, AccountOutcomeOverlay>();

    constructor(opts: OutcomeClassifierOptions = {}) {
        this.rateStore = opts.rateStore;
        const root = opts.root ?? repoRoot;
        this.filePath = opts.filePath ?? join(liveRoot(root), 'outcome-state.json');
        this.persist = opts.persist ?? (opts.filePath !== undefined || opts.root !== undefined);
        this.defaultMarketCooldownMs = opts.defaultMarketCooldownMs ?? DEFAULT_MARKET_COOLDOWN_MS;
        this.defaultRecoveryHoldTtlMs = opts.defaultRecoveryHoldTtlMs ?? DEFAULT_RECOVERY_HOLD_TTL_MS;
        this.defaultDefectTtlMs = opts.defaultDefectTtlMs ?? DEFAULT_DEFECT_TTL_MS;
        this.infraBaseBackoffMs = opts.infraBaseBackoffMs ?? DEFAULT_INFRA_BASE_BACKOFF_MS;
        this.infraMaxBackoffMs = opts.infraMaxBackoffMs ?? DEFAULT_INFRA_MAX_BACKOFF_MS;
        this.infraBackoffFactor = Math.max(1, opts.infraBackoffFactor ?? DEFAULT_INFRA_BACKOFF_FACTOR);
        if (this.persist && existsSync(this.filePath)) {
            this.load();
        }
    }

    load(): void {
        this.infraBreaker = { open: false, consecutiveFaults: 0 };
        this.marketCooldowns = {};
        this.defects.clear();
        this.accountOverlays.clear();
        if (!existsSync(this.filePath)) return;

        let parsed: unknown;
        try {
            parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
        } catch {
            return;
        }
        if (!isPlainRecord(parsed)) return;

        if (isPlainRecord(parsed.infraBreaker) && typeof parsed.infraBreaker.open === 'boolean') {
            this.infraBreaker = {
                open: parsed.infraBreaker.open,
                consecutiveFaults:
                    typeof parsed.infraBreaker.consecutiveFaults === 'number' && parsed.infraBreaker.consecutiveFaults >= 0
                        ? Math.trunc(parsed.infraBreaker.consecutiveFaults)
                        : 0,
                ...(typeof parsed.infraBreaker.trippedAt === 'number' ? { trippedAt: parsed.infraBreaker.trippedAt } : {}),
                ...(typeof parsed.infraBreaker.retryAt === 'number' ? { retryAt: parsed.infraBreaker.retryAt } : {}),
                ...(nonEmpty(parsed.infraBreaker.reason) ? { reason: nonEmpty(parsed.infraBreaker.reason) } : {}),
            };
        }

        if (isPlainRecord(parsed.marketCooldowns)) {
            for (const [k, exp] of Object.entries(parsed.marketCooldowns)) {
                if (nonEmpty(k) && typeof exp === 'number' && Number.isFinite(exp) && exp > 0) {
                    this.marketCooldowns[k] = exp;
                }
            }
        }

        if (Array.isArray(parsed.defects)) {
            for (const item of parsed.defects) {
                if (validateDefectRecord(item).length === 0) {
                    this.defects.set(defectKey(item.activityId, item.faultSignature), item);
                }
            }
        }

        if (isPlainRecord(parsed.accountOverlays)) {
            for (const [account, overlay] of Object.entries(parsed.accountOverlays)) {
                if (!nonEmpty(account) || !isPlainRecord(overlay)) continue;
                const holds = Array.isArray(overlay.holds) ? (overlay.holds as SystemHold[]) : [];
                const cooldowns: Record<string, number> = {};
                if (isPlainRecord(overlay.cooldowns)) {
                    for (const [k, exp] of Object.entries(overlay.cooldowns)) {
                        if (nonEmpty(k) && typeof exp === 'number' && Number.isFinite(exp) && exp > 0) {
                            cooldowns[k] = exp;
                        }
                    }
                }
                this.accountOverlays.set(account.toLowerCase(), {
                    ...(typeof overlay.lifecycleOverride === 'string'
                        ? { lifecycleOverride: overlay.lifecycleOverride as AccountLifecycle }
                        : {}),
                    ...(typeof overlay.lifecycleExpiresAt === 'number'
                        ? { lifecycleExpiresAt: overlay.lifecycleExpiresAt }
                        : {}),
                    holds,
                    cooldowns,
                });
            }
        }
    }

    save(now = Date.now()): void {
        writeJsonAtomic(this.filePath, this.snapshotState(now));
    }

    private saveIfEnabled(now: number): void {
        if (this.persist) this.save(now);
    }

    private pruneAccountOverlay(account: string, now: number): AccountOutcomeOverlay {
        const key = account.toLowerCase();
        const current = this.accountOverlays.get(key) ?? { holds: [], cooldowns: {} };
        const holds = pruneExpiredHolds(current.holds, now);
        const cooldowns = pruneExpiredCooldowns(current.cooldowns, now);
        let lifecycleOverride = current.lifecycleOverride;
        let lifecycleExpiresAt = current.lifecycleExpiresAt;
        if (lifecycleOverride && lifecycleOverride !== 'dead' && lifecycleOverride !== 'paused_owner') {
            if (lifecycleExpiresAt !== undefined && now >= lifecycleExpiresAt) {
                lifecycleOverride = undefined;
                lifecycleExpiresAt = undefined;
            }
        }
        const cleaned: AccountOutcomeOverlay = {
            ...(lifecycleOverride ? { lifecycleOverride } : {}),
            ...(lifecycleExpiresAt !== undefined ? { lifecycleExpiresAt } : {}),
            holds,
            cooldowns,
        };
        if (!cleaned.lifecycleOverride && cleaned.holds.length === 0 && Object.keys(cleaned.cooldowns).length === 0) {
            this.accountOverlays.delete(key);
        } else {
            this.accountOverlays.set(key, cleaned);
        }
        return cleaned;
    }

    private upsertDefect(params: {
        readonly activityId: string;
        readonly faultSignature: string;
        readonly outcomeKind: 'worker_defect' | 'death';
        readonly account: string;
        readonly now: number;
        readonly workerRelease?: string;
        readonly logPath?: string;
        readonly tickRecordPath?: string;
        readonly detail?: string;
    }): DefectRecord {
        const key = defectKey(params.activityId, params.faultSignature);
        const existing = this.defects.get(key);
        const logPath =
            nonEmpty(params.logPath) ??
            existing?.logPath ??
            `.practice/live/defects/${params.account}/${params.activityId}.log`;
        const detail = nonEmpty(params.detail) ?? existing?.detail ?? params.faultSignature;
        const tickRecordPath = nonEmpty(params.tickRecordPath) ?? existing?.tickRecordPath;
        const workerRelease = nonEmpty(params.workerRelease) ?? existing?.workerRelease;
        const idSlug = params.faultSignature.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'defect';

        const next: DefectRecord = {
            id: existing?.id ?? `defect:${params.activityId}:${idSlug}`,
            activityId: params.activityId,
            faultSignature: params.faultSignature,
            outcomeKind: params.outcomeKind,
            account: params.account,
            observedAt: params.now,
            quarantinedAt: params.now,
            expiresAt: params.now + this.defaultDefectTtlMs,
            quarantined: true,
            ...(workerRelease ? { workerRelease } : {}),
            logPath,
            ...(tickRecordPath ? { tickRecordPath } : {}),
            detail,
            count: (existing?.count ?? 0) + 1,
        };

        const errors = validateDefectRecord(next);
        if (errors.length > 0) {
            throw new Error(`Invalid DefectRecord: ${errors.join('; ')}`);
        }
        this.defects.set(key, next);
        return next;
    }

    private buildRateSample(
        outcome: RunOutcome,
        now: number,
        domain: 'practice' | 'live',
        died: boolean,
    ): RateSample | undefined {
        if (outcome.ticksElapsed <= 0) return undefined;
        let totalXp = 0;
        if (outcome.xpGained) {
            for (const xp of Object.values(outcome.xpGained)) {
                if (typeof xp === 'number' && Number.isFinite(xp) && xp >= 0) totalXp += xp;
            }
        }
        const unitsCompleted =
            typeof outcome.unitsCompleted === 'number' && Number.isFinite(outcome.unitsCompleted) && outcome.unitsCompleted >= 0
                ? outcome.unitsCompleted
                : 0;
        const gp = typeof outcome.coinsDelta === 'number' && Number.isFinite(outcome.coinsDelta) ? outcome.coinsDelta : 0;

        const sample: RateSample = {
            activityId: outcome.activityId,
            account: outcome.account,
            domain,
            observedAt: now,
            ticksElapsed: outcome.ticksElapsed,
            unitsCompleted,
            xpPerTick: totalXp / outcome.ticksElapsed,
            unitsPerTick: unitsCompleted / outcome.ticksElapsed,
            gpPerTick: gp / outcome.ticksElapsed,
            ...(died ? { died: true } : {}),
        };
        if (validateRateSample(sample).length > 0) return undefined;
        return sample;
    }

    classifyAndApplyRaw(
        input: RawWorkerExitInput,
        ctx?: {
            readonly now?: number;
            readonly domain?: 'practice' | 'live';
            readonly accountState?: AccountState;
            readonly workerRelease?: string;
        },
    ): OutcomeClassificationResult {
        const outcome = classifyRawWorkerExit(input);
        return this.applyOutcome(outcome, ctx);
    }

    applyOutcome(
        outcome: RunOutcome,
        ctx?: {
            readonly now?: number;
            readonly domain?: 'practice' | 'live';
            readonly accountState?: AccountState;
            readonly workerRelease?: string;
        },
    ): OutcomeClassificationResult {
        const errors = validateRunOutcome(outcome);
        if (errors.length > 0) {
            throw new Error(`Invalid RunOutcome: ${errors.join('; ')}`);
        }

        const now = ctx?.now ?? Date.now();
        const domain = ctx?.domain ?? 'live';
        this.marketCooldowns = pruneExpiredCooldowns(this.marketCooldowns, now);

        switch (outcome.kind) {
            case 'target_met': {
                const overlay = this.pruneAccountOverlay(outcome.account, now);
                const isDead = overlay.lifecycleOverride === 'dead';
                const remainingHolds = overlay.holds.filter(
                    (h) => h.key !== 'location_stranded' && h.key !== 'session_unsettled',
                );
                const nextOverlay: AccountOutcomeOverlay = {
                    ...(isDead ? { lifecycleOverride: 'dead' } : {}),
                    holds: remainingHolds,
                    cooldowns: overlay.cooldowns,
                };
                if (!nextOverlay.lifecycleOverride && remainingHolds.length === 0 && Object.keys(overlay.cooldowns).length === 0) {
                    this.accountOverlays.delete(outcome.account.toLowerCase());
                } else {
                    this.accountOverlays.set(outcome.account.toLowerCase(), nextOverlay);
                }

                let recordedRateSample: RateSample | undefined;
                if (this.rateStore) {
                    const candidate = this.buildRateSample(outcome, now, domain, false);
                    if (candidate) {
                        recordedRateSample = this.rateStore.recordSample(candidate);
                    }
                }
                this.saveIfEnabled(now);
                return {
                    outcome,
                    account: outcome.account,
                    activityId: outcome.activityId,
                    ...(recordedRateSample ? { recordedRateSample } : {}),
                    accountLifecycle: isDead ? 'dead' : 'idle',
                    accountPenalized: false,
                    unlockFollowUp: true,
                    clearedTransientRecovery: true,
                    summary: outcome.summary ?? `${outcome.activityId} target_met`,
                };
            }

            case 'missing_supply': {
                const overlay = this.pruneAccountOverlay(outcome.account, now);
                this.saveIfEnabled(now);
                return {
                    outcome,
                    account: outcome.account,
                    activityId: outcome.activityId,
                    accountLifecycle: overlay.lifecycleOverride === 'dead' ? 'dead' : 'idle',
                    missingSupplies: outcome.missing,
                    accountPenalized: false,
                    unlockFollowUp: false,
                    clearedTransientRecovery: false,
                    summary: outcome.summary ?? `${outcome.activityId} missing_supply (${outcome.missing.length} item(s))`,
                };
            }

            case 'location_stranded': {
                const overlay = this.pruneAccountOverlay(outcome.account, now);
                const hold = createExpiringHold({
                    kind: 'maintenance',
                    key: 'location_stranded',
                    reason: nonEmpty(outcome.detail) ?? nonEmpty(outcome.summary) ?? 'account stranded outside safe hub',
                    now,
                    ttlMs: this.defaultRecoveryHoldTtlMs,
                });
                const isDead = overlay.lifecycleOverride === 'dead';
                const lifecycle: AccountLifecycle = isDead ? 'dead' : 'needs_location_recovery';
                const nextOverlay: AccountOutcomeOverlay = {
                    lifecycleOverride: lifecycle,
                    ...(isDead ? {} : { lifecycleExpiresAt: hold.expiresAt }),
                    holds: [...overlay.holds.filter((h) => h.key !== 'location_stranded'), hold],
                    cooldowns: overlay.cooldowns,
                };
                this.accountOverlays.set(outcome.account.toLowerCase(), nextOverlay);
                this.saveIfEnabled(now);
                return {
                    outcome,
                    account: outcome.account,
                    activityId: outcome.activityId,
                    accountLifecycle: lifecycle,
                    addedHold: hold,
                    accountPenalized: true,
                    unlockFollowUp: false,
                    clearedTransientRecovery: false,
                    summary: hold.reason,
                };
            }

            case 'market_unavailable': {
                const overlay = this.pruneAccountOverlay(outcome.account, now);
                const ttlMs = outcome.cooldownMs ?? this.defaultMarketCooldownMs;
                const key = marketCooldownKey(outcome.itemId, outcome.venue);
                this.marketCooldowns = setCooldown(this.marketCooldowns, key, now, ttlMs);
                const accountCooldowns = setCooldown(overlay.cooldowns, key, now, ttlMs);
                const hold = createExpiringHold({
                    kind: 'market_unavailable',
                    key,
                    reason: nonEmpty(outcome.detail) ?? nonEmpty(outcome.summary) ?? `market unavailable for ${key}`,
                    now,
                    ttlMs,
                });
                this.accountOverlays.set(outcome.account.toLowerCase(), {
                    ...(overlay.lifecycleOverride ? { lifecycleOverride: overlay.lifecycleOverride } : {}),
                    ...(overlay.lifecycleExpiresAt !== undefined ? { lifecycleExpiresAt: overlay.lifecycleExpiresAt } : {}),
                    holds: [...overlay.holds.filter((h) => h.key !== key), hold],
                    cooldowns: accountCooldowns,
                });
                this.saveIfEnabled(now);
                return {
                    outcome,
                    account: outcome.account,
                    activityId: outcome.activityId,
                    accountLifecycle: overlay.lifecycleOverride === 'dead' ? 'dead' : 'idle',
                    addedHold: hold,
                    addedCooldownKey: key,
                    cooldownExpiresAt: now + ttlMs,
                    accountPenalized: false,
                    unlockFollowUp: false,
                    clearedTransientRecovery: false,
                    summary: hold.reason,
                };
            }

            case 'session_unsettled': {
                const overlay = this.pruneAccountOverlay(outcome.account, now);
                const hold = createExpiringHold({
                    kind: 'retry_backoff',
                    key: 'session_unsettled',
                    reason: nonEmpty(outcome.reason) ?? nonEmpty(outcome.detail) ?? 'session unsettled / missing logout proof',
                    now,
                    ttlMs: this.defaultRecoveryHoldTtlMs,
                });
                const isDead = overlay.lifecycleOverride === 'dead';
                const lifecycle: AccountLifecycle = isDead ? 'dead' : 'needs_logout_recovery';
                this.accountOverlays.set(outcome.account.toLowerCase(), {
                    lifecycleOverride: lifecycle,
                    ...(isDead ? {} : { lifecycleExpiresAt: hold.expiresAt }),
                    holds: [...overlay.holds.filter((h) => h.key !== 'session_unsettled'), hold],
                    cooldowns: overlay.cooldowns,
                });
                this.saveIfEnabled(now);
                return {
                    outcome,
                    account: outcome.account,
                    activityId: outcome.activityId,
                    accountLifecycle: lifecycle,
                    addedHold: hold,
                    accountPenalized: true,
                    unlockFollowUp: false,
                    clearedTransientRecovery: false,
                    summary: hold.reason,
                };
            }

            case 'infra_fault': {
                const nextFaults = this.infraBreaker.consecutiveFaults + 1;
                const expMs = Math.min(
                    this.infraMaxBackoffMs,
                    Math.round(this.infraBaseBackoffMs * Math.pow(this.infraBackoffFactor, nextFaults - 1)),
                );
                const waitMs = Math.max(expMs, outcome.retryAfterMs ?? 0);
                const reason = nonEmpty(outcome.detail) ?? nonEmpty(outcome.summary) ?? `infra fault (${outcome.source})`;
                this.infraBreaker = {
                    open: true,
                    trippedAt: now,
                    retryAt: now + waitMs,
                    consecutiveFaults: nextFaults,
                    reason: `${outcome.source}: ${reason}`,
                };
                this.saveIfEnabled(now);
                return {
                    outcome,
                    account: outcome.account,
                    activityId: outcome.activityId,
                    infraBreaker: { ...this.infraBreaker },
                    accountPenalized: false,
                    unlockFollowUp: false,
                    clearedTransientRecovery: false,
                    summary: this.infraBreaker.reason ?? reason,
                };
            }

            case 'worker_defect': {
                const overlay = this.pruneAccountOverlay(outcome.account, now);
                const defect = this.upsertDefect({
                    activityId: outcome.activityId,
                    faultSignature: outcome.faultSignature,
                    outcomeKind: 'worker_defect',
                    account: outcome.account,
                    now,
                    workerRelease: ctx?.workerRelease,
                    logPath: outcome.logPath,
                    tickRecordPath: outcome.tickRecordPath,
                    detail: outcome.detail ?? outcome.summary,
                });
                this.saveIfEnabled(now);
                return {
                    outcome,
                    account: outcome.account,
                    activityId: outcome.activityId,
                    accountLifecycle: overlay.lifecycleOverride === 'dead' ? 'dead' : 'idle',
                    defect,
                    accountPenalized: false,
                    unlockFollowUp: false,
                    clearedTransientRecovery: false,
                    summary: `quarantined ${outcome.activityId} (${outcome.faultSignature})`,
                };
            }

            case 'death': {
                const overlay = this.pruneAccountOverlay(outcome.account, now);
                this.accountOverlays.set(outcome.account.toLowerCase(), {
                    lifecycleOverride: 'dead',
                    holds: overlay.holds,
                    cooldowns: overlay.cooldowns,
                });
                const faultSignature = nonEmpty(outcome.faultSignature) ?? 'death';
                const defect = this.upsertDefect({
                    activityId: outcome.activityId,
                    faultSignature,
                    outcomeKind: 'death',
                    account: outcome.account,
                    now,
                    workerRelease: ctx?.workerRelease,
                    logPath: outcome.logPath,
                    tickRecordPath: outcome.tickRecordPath,
                    detail: outcome.detail ?? outcome.summary ?? `${outcome.account} died in ${outcome.activityId}`,
                });

                let recordedRateSample: RateSample | undefined;
                if (this.rateStore) {
                    const candidate = this.buildRateSample(outcome, now, domain, true);
                    if (candidate) {
                        recordedRateSample = this.rateStore.recordSample(candidate);
                    }
                }
                this.saveIfEnabled(now);
                return {
                    outcome,
                    account: outcome.account,
                    activityId: outcome.activityId,
                    ...(recordedRateSample ? { recordedRateSample } : {}),
                    accountLifecycle: 'dead',
                    defect,
                    accountPenalized: true,
                    unlockFollowUp: false,
                    clearedTransientRecovery: false,
                    summary: defect.detail,
                };
            }
        }
    }

    isQuarantined(activityId: string, now = Date.now()): boolean {
        return this.quarantinedDefects(now).some((d) => d.activityId === activityId);
    }

    quarantinedDefects(now = Date.now()): DefectRecord[] {
        const out: DefectRecord[] = [];
        for (const [key, d] of this.defects.entries()) {
            if (!d.quarantined) continue;
            if (d.expiresAt !== undefined && now >= d.expiresAt) {
                this.defects.set(key, { ...d, quarantined: false });
                continue;
            }
            out.push(d);
        }
        out.sort((a, b) => b.observedAt - a.observedAt);
        return out;
    }

    clearDefect(params: {
        readonly defectId?: string;
        readonly activityId: string;
        readonly faultSignature?: string;
    }): number {
        let cleared = 0;
        for (const [key, d] of this.defects.entries()) {
            if (!d.quarantined) continue;
            if (d.activityId !== params.activityId) continue;
            if (params.defectId !== undefined && d.id !== params.defectId) continue;
            if (params.faultSignature !== undefined && d.faultSignature !== params.faultSignature) continue;
            this.defects.set(key, { ...d, quarantined: false });
            cleared += 1;
        }
        if (cleared > 0) this.saveIfEnabled(Date.now());
        return cleared;
    }

    canProceedInfra(now = Date.now()): {
        readonly allowed: boolean;
        readonly waitMs: number;
        readonly state: InfraCircuitBreakerState;
    } {
        if (!this.infraBreaker.open) {
            return { allowed: true, waitMs: 0, state: { ...this.infraBreaker } };
        }
        const retryAt = this.infraBreaker.retryAt ?? now;
        if (now >= retryAt) {
            return { allowed: true, waitMs: 0, state: { ...this.infraBreaker } };
        }
        return {
            allowed: false,
            waitMs: retryAt - now,
            state: { ...this.infraBreaker },
        };
    }

    recordInfraSuccess(now = Date.now()): void {
        this.infraBreaker = { open: false, consecutiveFaults: 0 };
        this.saveIfEnabled(now);
    }

    activeMarketCooldowns(now = Date.now()): Record<string, number> {
        this.marketCooldowns = pruneExpiredCooldowns(this.marketCooldowns, now);
        return { ...this.marketCooldowns };
    }

    applyToAccount(acct: AccountState, now = Date.now()): AccountState {
        const overlay = this.pruneAccountOverlay(acct.name, now);
        const mergedCooldowns = {
            ...pruneExpiredCooldowns(acct.cooldowns, now),
            ...overlay.cooldowns,
        };
        const baseHolds = pruneExpiredHolds(acct.systemHolds ?? [], now);
        const holdMap = new Map<string, SystemHold>();
        for (const h of baseHolds) {
            if (isHoldActive(h, now)) holdMap.set(`${h.kind}:${h.key}`, h);
        }
        for (const h of overlay.holds) {
            if (isHoldActive(h, now)) holdMap.set(`${h.kind}:${h.key}`, h);
        }
        const mergedHolds = [...holdMap.values()];

        let nextLifecycle: AccountLifecycle = acct.lifecycle;
        if (acct.lifecycle !== 'paused_owner' && acct.lifecycle !== 'reserved') {
            if (overlay.lifecycleOverride === 'dead') {
                nextLifecycle = 'dead';
            } else if (acct.lifecycle !== 'dead' && overlay.lifecycleOverride) {
                if (overlay.lifecycleOverride === 'needs_logout_recovery') {
                    nextLifecycle = 'needs_logout_recovery';
                } else if (
                    overlay.lifecycleOverride === 'needs_location_recovery' &&
                    acct.lifecycle !== 'needs_logout_recovery'
                ) {
                    nextLifecycle = 'needs_location_recovery';
                }
            }
        }

        const { activeJob, ...rest } = acct;
        const updated: AccountState = {
            ...rest,
            lifecycle: nextLifecycle,
            ...(nextLifecycle === 'running' && activeJob ? { activeJob } : {}),
            ...(Object.keys(mergedCooldowns).length > 0 ? { cooldowns: mergedCooldowns } : { cooldowns: undefined }),
            ...(mergedHolds.length > 0 ? { systemHolds: mergedHolds } : { systemHolds: undefined }),
        };
        const errors = validateAccountState(updated);
        if (errors.length > 0) {
            throw new Error(`OutcomeClassifier.applyToAccount produced invalid AccountState for ${acct.name}: ${errors.join('; ')}`);
        }
        return updated;
    }

    applyToSnapshot(snapshot: WorldSnapshot, now = Date.now()): WorldSnapshot {
        const nextAccounts: Record<string, AccountState> = {};
        for (const [name, acct] of Object.entries(snapshot.accounts)) {
            nextAccounts[name] = this.applyToAccount(acct, now);
        }
        const mergedMarketCooldowns = {
            ...pruneExpiredCooldowns(snapshot.marketCooldowns, now),
            ...this.activeMarketCooldowns(now),
        };
        const nextSnapshot: WorldSnapshot = {
            ...snapshot,
            accounts: nextAccounts,
            ...(Object.keys(mergedMarketCooldowns).length > 0 ? { marketCooldowns: mergedMarketCooldowns } : {}),
        };
        const errors = validateWorldSnapshot(nextSnapshot);
        if (errors.length > 0) {
            throw new Error(`OutcomeClassifier.applyToSnapshot produced invalid WorldSnapshot: ${errors.join('; ')}`);
        }
        return nextSnapshot;
    }

    applyOperatorCommand(cmd: OperatorCommand, now = Date.now()): boolean {
        switch (cmd.kind) {
            case 'clear_defect': {
                const count = this.clearDefect({
                    defectId: cmd.defectId,
                    activityId: cmd.activityId,
                    faultSignature: cmd.faultSignature,
                });
                return count > 0;
            }
            case 'resume_account': {
                const acctKey = cmd.account.toLowerCase();
                const overlay = this.accountOverlays.get(acctKey);
                if (!overlay) return false;
                if (overlay.lifecycleOverride === 'dead' && cmd.clearDead !== true) {
                    return false;
                }
                const nextHolds = overlay.holds.filter(
                    (h) => h.key !== 'location_stranded' && h.key !== 'session_unsettled',
                );
                if (nextHolds.length === 0 && Object.keys(overlay.cooldowns).length === 0) {
                    this.accountOverlays.delete(acctKey);
                } else {
                    this.accountOverlays.set(acctKey, {
                        holds: nextHolds,
                        cooldowns: overlay.cooldowns,
                    });
                }
                this.saveIfEnabled(now);
                return true;
            }
            default:
                return false;
        }
    }

    snapshotState(now = Date.now()): OutcomeClassifierState {
        const marketCooldowns = this.activeMarketCooldowns(now);
        const overlays: Record<string, AccountOutcomeOverlay> = {};
        for (const account of [...this.accountOverlays.keys()]) {
            const cleaned = this.pruneAccountOverlay(account, now);
            if (
                cleaned.lifecycleOverride ||
                cleaned.holds.length > 0 ||
                Object.keys(cleaned.cooldowns).length > 0
            ) {
                overlays[account] = cleaned;
            }
        }
        return {
            schemaVersion: OUTCOME_STATE_SCHEMA_VERSION,
            updatedAt: now,
            infraBreaker: { ...this.infraBreaker },
            marketCooldowns,
            defects: [...this.defects.values()],
            accountOverlays: overlays,
        };
    }
}
