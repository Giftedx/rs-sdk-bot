// Unified WorkerModule seam, preflight, rate-estimation, and outcome contracts.
import type { BankObservation, SessionCore } from '../../../core/src/session-types';
import type { World } from '../../../core/src/world';

export type { BankObservation, SessionCore };

export const WORKER_FAMILIES = [
    'gather',
    'bank-artisan',
    'combat',
    'agility',
    'runecraft',
    'quest',
    'market',
    'logistics',
    'pvp',
] as const;
export type WorkerFamily = (typeof WORKER_FAMILIES)[number];

export const TRUST_TIERS = ['experimental', 'practice_passed', 'live_proven'] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

export const TRUST_TIER_RANK: Readonly<Record<TrustTier, number>> = {
    experimental: 0,
    practice_passed: 1,
    live_proven: 2,
};

export const WORKER_KINDS = [
    'train',
    'gather',
    'produce',
    'quest',
    'shop',
    'ge_buy',
    'pk',
    'recover',
] as const;
export type WorkerKind = (typeof WORKER_KINDS)[number];

export const OUTCOME_KINDS = [
    'target_met',
    'missing_supply',
    'location_stranded',
    'market_unavailable',
    'session_unsettled',
    'infra_fault',
    'worker_defect',
    'death',
] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

export const INFRA_FAULT_SOURCES = [
    'claim_authority',
    'server_drain',
    'proxy',
    'network',
    'unknown',
] as const;
export type InfraFaultSource = (typeof INFRA_FAULT_SOURCES)[number];

export const WORKER_QUEST_STATES = ['not_started', 'started', 'complete'] as const;
export type WorkerQuestState = (typeof WORKER_QUEST_STATES)[number];

export const RATE_CONFIDENCE_LEVELS = ['model', 'practice', 'live'] as const;
export type RateEstimateConfidence = (typeof RATE_CONFIDENCE_LEVELS)[number];

export const PREFLIGHT_BLOCKER_KINDS = [
    'skill_level',
    'quest_incomplete',
    'missing_supply',
    'missing_coins',
    'unreachable_tile',
    'combat_survivability',
    'max_level_cap',
    'protected_clock',
    'cooldown_active',
    'capacity_full',
    'invalid_config',
] as const;
export type PreflightBlockerKind = (typeof PREFLIGHT_BLOCKER_KINDS)[number];

export interface WorkerTile {
    readonly x: number;
    readonly z: number;
    readonly level: number;
}

export interface WorkerSkillState {
    readonly level: number;
    readonly xp: number;
}

export interface WorkerBankView {
    readonly items: Readonly<Record<number, number>>;
    readonly observedAt: number;
    readonly trusted: boolean;
}

// Structural minimum account view read by WorkerModule.preflight and WorkerModule.estimate.
// Brain AccountState satisfies this interface without introducing a cyclic package edge.
export interface WorkerAccountView {
    readonly name: string;
    readonly side: string;
    readonly protectedClock: boolean;
    readonly maxLevels?: Readonly<Record<string, number>>;
    readonly skills: Readonly<Record<string, WorkerSkillState>>;
    readonly quests: Readonly<Record<string, WorkerQuestState>>;
    readonly pos: WorkerTile | null;
    readonly inventory: Readonly<Record<number, number>>;
    readonly equipment: Readonly<Record<number, number>>;
    readonly bank: WorkerBankView;
    readonly reserves?: Readonly<Record<number, number>>;
    readonly cooldowns?: Readonly<Record<string, number>>;
}

// Structural minimum world view read by WorkerModule.preflight and WorkerModule.estimate.
// Brain WorldSnapshot satisfies this interface without introducing a cyclic package edge.
export interface WorkerWorldView {
    readonly at: number;
    readonly side: string;
    readonly server: string;
    readonly accounts: Readonly<Record<string, WorkerAccountView>>;
    readonly reserves?: Readonly<Record<string, Readonly<Record<number, number>>>>;
    readonly globalReserves?: Readonly<Record<number, number>>;
    readonly marketCooldowns?: Readonly<Record<string, number>>;
    readonly spotOccupancy?: Readonly<Record<string, number>>;
    readonly geEscrowCoins?: Readonly<Record<string, number>>;
    readonly world?: World;
}

export type PreflightBlocker =
    | {
          readonly kind: 'skill_level';
          readonly skill: string;
          readonly required: number;
          readonly current: number;
          readonly message?: string;
      }
    | {
          readonly kind: 'quest_incomplete';
          readonly quest: string;
          readonly requiredState?: 'started' | 'complete';
          readonly currentState?: WorkerQuestState;
          readonly message?: string;
      }
    | {
          readonly kind: 'missing_supply';
          readonly itemId: number;
          readonly itemName?: string;
          readonly required: number;
          readonly available: number;
          readonly reserved: number;
          readonly message?: string;
      }
    | {
          readonly kind: 'missing_coins';
          readonly required: number;
          readonly available: number;
          readonly reserved: number;
          readonly escrow?: number;
          readonly ferryFare?: number;
          readonly message?: string;
      }
    | {
          readonly kind: 'unreachable_tile';
          readonly target: WorkerTile;
          readonly from?: WorkerTile | null;
          readonly reason?: 'no_route' | 'budget' | 'unknown_pos' | 'plane_mismatch';
          readonly message?: string;
      }
    | {
          readonly kind: 'combat_survivability';
          readonly reason: 'defence' | 'hitpoints' | 'food' | 'prayer' | 'protection';
          readonly required?: number;
          readonly current?: number;
          readonly message?: string;
      }
    | {
          readonly kind: 'max_level_cap';
          readonly skill: string;
          readonly maxLevel: number;
          readonly current: number;
          readonly message?: string;
      }
    | {
          readonly kind: 'protected_clock';
          readonly message?: string;
      }
    | {
          readonly kind: 'cooldown_active';
          readonly key: string;
          readonly expiresAt: number;
          readonly message?: string;
      }
    | {
          readonly kind: 'capacity_full';
          readonly spotId: string;
          readonly active: number;
          readonly limit: number;
          readonly message?: string;
      }
    | {
          readonly kind: 'invalid_config';
          readonly message: string;
      };

export interface PreflightMissingItem {
    readonly itemId: number;
    readonly count: number;
    readonly itemName?: string;
}

export interface PreflightResult {
    readonly ok: boolean;
    readonly blockers: readonly PreflightBlocker[];
    readonly travelCoins?: number;
    readonly travelTicks?: number;
    readonly missingItems?: readonly PreflightMissingItem[];
}

export interface RateEstimate {
    readonly xpPerTick: number;
    readonly skillXpPerTick?: Readonly<Record<string, number>>;
    readonly unitsPerTick: number;
    readonly gpPerTick: number;
    readonly setupTicks: number;
    readonly minBatchUnits: number;
    readonly riskPerHour?: number;
    readonly confidence: RateEstimateConfidence;
    readonly outputsPerUnit?: Readonly<Record<number, number>>;
    readonly inputsPerUnit?: Readonly<Record<number, number>>;
}

export interface RunOutcomeMissingItem {
    readonly itemId: number;
    readonly required: number;
    readonly available: number;
    readonly itemName?: string;
}

export interface RunOutcomeBase {
    readonly activityId: string;
    readonly account: string;
    readonly ticksElapsed: number;
    readonly durationMs?: number;
    readonly unitsCompleted?: number;
    readonly xpGained?: Readonly<Record<string, number>>;
    readonly itemsDelta?: Readonly<Record<number, number>>;
    readonly coinsDelta?: number;
    readonly summary?: string;
}

export interface TargetMetOutcome extends RunOutcomeBase {
    readonly kind: 'target_met';
}

export interface MissingSupplyOutcome extends RunOutcomeBase {
    readonly kind: 'missing_supply';
    readonly missing: readonly RunOutcomeMissingItem[];
}

export interface LocationStrandedOutcome extends RunOutcomeBase {
    readonly kind: 'location_stranded';
    readonly pos?: WorkerTile | null;
    readonly detail?: string;
}

export interface MarketUnavailableOutcome extends RunOutcomeBase {
    readonly kind: 'market_unavailable';
    readonly itemId: number;
    readonly venue: string;
    readonly cooldownMs?: number;
    readonly detail?: string;
}

export interface SessionUnsettledOutcome extends RunOutcomeBase {
    readonly kind: 'session_unsettled';
    readonly reason?: string;
    readonly detail?: string;
}

export interface InfraFaultOutcome extends RunOutcomeBase {
    readonly kind: 'infra_fault';
    readonly source: InfraFaultSource;
    readonly retryAfterMs?: number;
    readonly detail?: string;
}

export interface WorkerDefectOutcome extends RunOutcomeBase {
    readonly kind: 'worker_defect';
    readonly faultSignature: string;
    readonly logPath?: string;
    readonly tickRecordPath?: string;
    readonly detail?: string;
}

export interface DeathOutcome extends RunOutcomeBase {
    readonly kind: 'death';
    readonly faultSignature?: string;
    readonly pos?: WorkerTile | null;
    readonly logPath?: string;
    readonly tickRecordPath?: string;
    readonly detail?: string;
}

export type RunOutcome =
    | TargetMetOutcome
    | MissingSupplyOutcome
    | LocationStrandedOutcome
    | MarketUnavailableOutcome
    | SessionUnsettledOutcome
    | InfraFaultOutcome
    | WorkerDefectOutcome
    | DeathOutcome;

export interface WorkerModule<
    Cfg = unknown,
    State extends WorkerAccountView = WorkerAccountView,
    WorldView extends WorkerWorldView = WorkerWorldView,
    Sess extends SessionCore = SessionCore,
> {
    readonly id: string;
    readonly family: WorkerFamily;
    readonly kind: WorkerKind;
    readonly trust: TrustTier;
    readonly protectedAllowed?: boolean;

    preflight(acct: State, cfg: Cfg, world: WorldView): PreflightResult;
    estimate(acct: State, cfg: Cfg, world: WorldView): RateEstimate;
    run(session: Sess, cfg: Cfg): Promise<RunOutcome>;
}

export interface WorkerRegistryFilter {
    readonly family?: WorkerFamily;
    readonly kind?: WorkerKind;
    readonly trust?: TrustTier;
    readonly minTrust?: TrustTier;
    readonly protectedAllowed?: boolean;
}

export interface WorkerRegistry {
    register<Cfg, State extends WorkerAccountView, WorldView extends WorkerWorldView, Sess extends SessionCore>(
        mod: WorkerModule<Cfg, State, WorldView, Sess>,
    ): void;
    get(id: string): WorkerModule<any, any, any, any> | undefined;
    require(id: string): WorkerModule<any, any, any, any>;
    has(id: string): boolean;
    list(filter?: WorkerRegistryFilter): readonly WorkerModule<any, any, any, any>[];
    size(): number;
}

// --- Shared internal & domain primitive checks ---

const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isNonNegInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isPosInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const isFiniteNonNeg = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isFinitePos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

function checkNumericMap(
    raw: unknown,
    label: string,
    keyValid: (key: string) => boolean,
    valValid: (val: unknown) => boolean,
    errors: string[],
): void {
    if (!isPlainRecord(raw)) {
        errors.push(`${label} must be an object`);
        return;
    }
    for (const k in raw) {
        if (!Object.hasOwn(raw, k)) continue;
        const val = raw[k];
        if (!keyValid(k)) errors.push(`${label} has invalid key "${k}"`);
        if (!valValid(val)) errors.push(`${label}["${k}"] has invalid value`);
    }
}

const isItemIdKey = (k: string): boolean => {
    const len = k.length;
    if (len === 0) return false;
    const c0 = k.charCodeAt(0);
    if (c0 === 48) return len === 1;
    if (c0 < 49 || c0 > 57) return false;
    for (let i = 1; i < len; i++) {
        const c = k.charCodeAt(i);
        if (c < 48 || c > 57) return false;
    }
    return true;
};

// --- Type guards for closed vocabularies ---

const WORKER_FAMILY_SET: ReadonlySet<string> = new Set(WORKER_FAMILIES);
const TRUST_TIER_SET: ReadonlySet<string> = new Set(TRUST_TIERS);
const WORKER_KIND_SET: ReadonlySet<string> = new Set(WORKER_KINDS);
const OUTCOME_KIND_SET: ReadonlySet<string> = new Set(OUTCOME_KINDS);
const INFRA_FAULT_SOURCE_SET: ReadonlySet<string> = new Set(INFRA_FAULT_SOURCES);
const WORKER_QUEST_STATE_SET: ReadonlySet<string> = new Set(WORKER_QUEST_STATES);
const RATE_CONFIDENCE_SET: ReadonlySet<string> = new Set(RATE_CONFIDENCE_LEVELS);
const UNREACHABLE_REASONS: ReadonlySet<string> = new Set(['no_route', 'budget', 'unknown_pos', 'plane_mismatch']);
const SURVIVABILITY_REASONS: ReadonlySet<string> = new Set(['defence', 'hitpoints', 'food', 'prayer', 'protection']);

export const isWorkerFamily = (v: unknown): v is WorkerFamily =>
    typeof v === 'string' && WORKER_FAMILY_SET.has(v);

export const isTrustTier = (v: unknown): v is TrustTier =>
    typeof v === 'string' && TRUST_TIER_SET.has(v);

export const isWorkerKind = (v: unknown): v is WorkerKind =>
    typeof v === 'string' && WORKER_KIND_SET.has(v);

export const isOutcomeKind = (v: unknown): v is OutcomeKind =>
    typeof v === 'string' && OUTCOME_KIND_SET.has(v);

export const isInfraFaultSource = (v: unknown): v is InfraFaultSource =>
    typeof v === 'string' && INFRA_FAULT_SOURCE_SET.has(v);

export const isWorkerQuestState = (v: unknown): v is WorkerQuestState =>
    typeof v === 'string' && WORKER_QUEST_STATE_SET.has(v);

export const isRateEstimateConfidence = (v: unknown): v is RateEstimateConfidence =>
    typeof v === 'string' && RATE_CONFIDENCE_SET.has(v);

export function trustMeetsMinimum(actual: TrustTier, minimum: TrustTier): boolean {
    return TRUST_TIER_RANK[actual] >= TRUST_TIER_RANK[minimum];
}

export function isWorkerTile(v: unknown): v is WorkerTile {
    return isPlainRecord(v) && Number.isSafeInteger(v.x) && Number.isSafeInteger(v.z)
        && Number.isSafeInteger(v.level) && (v.level as number) >= 0 && (v.level as number) <= 3;
}

// --- Shared preflight math helpers ---

export function reserveAdjustedStock(owned: number, reserved: number): number {
    if (!Number.isFinite(owned) || owned < 0 || !Number.isFinite(reserved) || reserved < 0) {
        throw new Error(`reserveAdjustedStock requires finite non-negative numbers (owned=${owned}, reserved=${reserved})`);
    }
    return Math.max(0, owned - reserved);
}

export function availableCoinsAfterReserves(
    totalCoins: number,
    reservedCoins: number,
    geEscrowCoins = 0,
    operatingFloat = 0,
): number {
    if (!Number.isFinite(totalCoins) || totalCoins < 0) {
        throw new Error(`availableCoinsAfterReserves requires finite non-negative totalCoins (got ${totalCoins})`);
    }
    if (!Number.isFinite(reservedCoins) || reservedCoins < 0) {
        throw new Error(`availableCoinsAfterReserves requires finite non-negative reservedCoins (got ${reservedCoins})`);
    }
    if (!Number.isFinite(geEscrowCoins) || geEscrowCoins < 0) {
        throw new Error(`availableCoinsAfterReserves requires finite non-negative geEscrowCoins (got ${geEscrowCoins})`);
    }
    if (!Number.isFinite(operatingFloat) || operatingFloat < 0) {
        throw new Error(`availableCoinsAfterReserves requires finite non-negative operatingFloat (got ${operatingFloat})`);
    }
    return Math.max(0, totalCoins - reservedCoins - geEscrowCoins - operatingFloat);
}

export function accountOwnedItemCount(
    acct: WorkerAccountView,
    itemId: number,
    opts?: { includeBank?: boolean; requireTrustedBank?: boolean },
): number {
    if (!isNonNegInt(itemId)) throw new Error(`invalid itemId: ${itemId}`);
    const includeBank = opts?.includeBank ?? true;
    const requireTrustedBank = opts?.requireTrustedBank ?? true;
    const inv = acct.inventory[itemId] ?? 0;
    const eq = acct.equipment[itemId] ?? 0;
    const bankOk = includeBank && (!requireTrustedBank || acct.bank.trusted);
    const bank = bankOk ? (acct.bank.items[itemId] ?? 0) : 0;
    return inv + eq + bank;
}

export function accountReserveFor(
    acct: WorkerAccountView,
    world: WorkerWorldView,
    itemId: number,
): number {
    const acctRes = acct.reserves?.[itemId] ?? 0;
    let worldRes = 0;
    const worldReserves = world.reserves;
    if (worldReserves) {
        const byLower = worldReserves[acct.name.toLowerCase()];
        worldRes = byLower !== undefined ? (byLower[itemId] ?? 0) : (worldReserves[acct.name]?.[itemId] ?? 0);
    }
    const globalRes = world.globalReserves?.[itemId] ?? 0;
    return (acctRes >= worldRes ? acctRes : worldRes) + globalRes;
}

export function accountEscrowCoins(
    acct: WorkerAccountView,
    world: WorkerWorldView,
): number {
    const escrow = world.geEscrowCoins;
    if (!escrow) return 0;
    return escrow[acct.name.toLowerCase()] ?? escrow[acct.name] ?? 0;
}

// --- Preflight validators & constructors ---

function collectPreflightBlockerErrors(v: unknown, errors: string[], prefix: string): void {
    const push = (msg: string) => errors.push(prefix ? `${prefix}${msg}` : msg);
    if (!isPlainRecord(v)) {
        push('blocker must be an object');
        return;
    }
    if (v.message !== undefined && typeof v.message !== 'string') push('blocker.message must be a string');
    switch (v.kind) {
        case 'skill_level':
            if (!isNonEmptyStr(v.skill)) push('skill_level.skill must be non-empty');
            if (!isPosInt(v.required)) push('skill_level.required must be a positive integer');
            if (!isNonNegInt(v.current)) push('skill_level.current must be a non-negative integer');
            break;
        case 'quest_incomplete':
            if (!isNonEmptyStr(v.quest)) push('quest_incomplete.quest must be non-empty');
            if (v.requiredState !== undefined && v.requiredState !== 'started' && v.requiredState !== 'complete') {
                push('quest_incomplete.requiredState must be started or complete');
            }
            if (v.currentState !== undefined && !isWorkerQuestState(v.currentState)) {
                push('quest_incomplete.currentState invalid');
            }
            break;
        case 'missing_supply':
            if (!isNonNegInt(v.itemId)) push('missing_supply.itemId must be a non-negative integer');
            if (v.itemName !== undefined && !isNonEmptyStr(v.itemName)) push('missing_supply.itemName must be non-empty');
            if (!isPosInt(v.required)) push('missing_supply.required must be a positive integer');
            if (!isNonNegInt(v.available)) push('missing_supply.available must be a non-negative integer');
            if (!isNonNegInt(v.reserved)) push('missing_supply.reserved must be a non-negative integer');
            break;
        case 'missing_coins':
            if (!isPosInt(v.required)) push('missing_coins.required must be a positive integer');
            if (!isNonNegInt(v.available)) push('missing_coins.available must be a non-negative integer');
            if (!isNonNegInt(v.reserved)) push('missing_coins.reserved must be a non-negative integer');
            if (v.escrow !== undefined && !isNonNegInt(v.escrow)) push('missing_coins.escrow must be a non-negative integer');
            if (v.ferryFare !== undefined && !isNonNegInt(v.ferryFare)) push('missing_coins.ferryFare must be a non-negative integer');
            break;
        case 'unreachable_tile':
            if (!isWorkerTile(v.target)) push('unreachable_tile.target must be a valid tile');
            if (v.from !== undefined && v.from !== null && !isWorkerTile(v.from)) push('unreachable_tile.from must be a valid tile or null');
            if (v.reason !== undefined && (typeof v.reason !== 'string' || !UNREACHABLE_REASONS.has(v.reason))) {
                push('unreachable_tile.reason invalid');
            }
            break;
        case 'combat_survivability':
            if (typeof v.reason !== 'string' || !SURVIVABILITY_REASONS.has(v.reason)) {
                push('combat_survivability.reason invalid');
            }
            if (v.required !== undefined && !isFiniteNonNeg(v.required)) push('combat_survivability.required must be finite non-negative');
            if (v.current !== undefined && !isFiniteNonNeg(v.current)) push('combat_survivability.current must be finite non-negative');
            break;
        case 'max_level_cap':
            if (!isNonEmptyStr(v.skill)) push('max_level_cap.skill must be non-empty');
            if (!isPosInt(v.maxLevel)) push('max_level_cap.maxLevel must be a positive integer');
            if (!isNonNegInt(v.current)) push('max_level_cap.current must be a non-negative integer');
            break;
        case 'protected_clock':
            break;
        case 'cooldown_active':
            if (!isNonEmptyStr(v.key)) push('cooldown_active.key must be non-empty');
            if (!isFinitePos(v.expiresAt)) push('cooldown_active.expiresAt must be a positive timestamp');
            break;
        case 'capacity_full':
            if (!isNonEmptyStr(v.spotId)) push('capacity_full.spotId must be non-empty');
            if (!isNonNegInt(v.active)) push('capacity_full.active must be a non-negative integer');
            if (!isPosInt(v.limit)) push('capacity_full.limit must be a positive integer');
            break;
        case 'invalid_config':
            if (!isNonEmptyStr(v.message)) push('invalid_config.message must be non-empty');
            break;
        default:
            push(`unknown preflight blocker kind: ${String(v.kind)}`);
    }
}

export function validatePreflightBlocker(v: unknown): string[] {
    const errors: string[] = [];
    collectPreflightBlockerErrors(v, errors, '');
    return errors;
}

export const isPreflightBlocker = (v: unknown): v is PreflightBlocker => validatePreflightBlocker(v).length === 0;

export function validatePreflightResult(v: unknown): string[] {
    if (!isPlainRecord(v)) return ['PreflightResult must be an object'];
    const errors: string[] = [];
    if (typeof v.ok !== 'boolean') errors.push('ok must be a boolean');
    if (!Array.isArray(v.blockers)) {
        errors.push('blockers must be an array');
    } else {
        for (let idx = 0; idx < v.blockers.length; idx++) {
            collectPreflightBlockerErrors(v.blockers[idx], errors, `blockers[${idx}]: `);
        }
        if (v.ok === true && v.blockers.length > 0) errors.push('ok=true requires blockers to be empty');
        if (v.ok === false && v.blockers.length === 0) errors.push('ok=false requires at least one blocker');
    }
    if (v.travelCoins !== undefined && !isNonNegInt(v.travelCoins)) errors.push('travelCoins must be a non-negative integer');
    if (v.travelTicks !== undefined && !isFiniteNonNeg(v.travelTicks)) errors.push('travelTicks must be finite non-negative');
    if (v.missingItems !== undefined) {
        if (!Array.isArray(v.missingItems)) errors.push('missingItems must be an array');
        else {
            for (let idx = 0; idx < v.missingItems.length; idx++) {
                const item = v.missingItems[idx];
                if (!isPlainRecord(item) || !isNonNegInt(item.itemId) || !isPosInt(item.count)
                    || (item.itemName !== undefined && !isNonEmptyStr(item.itemName))) {
                    errors.push(`missingItems[${idx}] is invalid`);
                }
            }
        }
    }
    return errors;
}

export const isPreflightResult = (v: unknown): v is PreflightResult => validatePreflightResult(v).length === 0;

function extraPreflightFieldsValid(extra: Omit<PreflightResult, 'ok' | 'blockers'>): boolean {
    if (extra.travelCoins !== undefined && !isNonNegInt(extra.travelCoins)) return false;
    if (extra.travelTicks !== undefined && !isFiniteNonNeg(extra.travelTicks)) return false;
    if (extra.missingItems !== undefined) {
        if (!Array.isArray(extra.missingItems)) return false;
        for (let i = 0; i < extra.missingItems.length; i++) {
            const item = extra.missingItems[i];
            if (!isPlainRecord(item) || !isNonNegInt(item.itemId) || !isPosInt(item.count)
                || (item.itemName !== undefined && !isNonEmptyStr(item.itemName))) {
                return false;
            }
        }
    }
    return true;
}

function fastBlockerValid(b: PreflightBlocker): boolean {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return false;
    if (b.message !== undefined && typeof b.message !== 'string') return false;
    switch (b.kind) {
        case 'skill_level':
            return isNonEmptyStr(b.skill) && isPosInt(b.required) && isNonNegInt(b.current);
        case 'quest_incomplete':
            return isNonEmptyStr(b.quest)
                && (b.requiredState === undefined || b.requiredState === 'started' || b.requiredState === 'complete')
                && (b.currentState === undefined || isWorkerQuestState(b.currentState));
        case 'missing_supply':
            return isNonNegInt(b.itemId)
                && (b.itemName === undefined || isNonEmptyStr(b.itemName))
                && isPosInt(b.required) && isNonNegInt(b.available) && isNonNegInt(b.reserved);
        case 'missing_coins':
            return isPosInt(b.required) && isNonNegInt(b.available) && isNonNegInt(b.reserved)
                && (b.escrow === undefined || isNonNegInt(b.escrow))
                && (b.ferryFare === undefined || isNonNegInt(b.ferryFare));
        case 'unreachable_tile':
            return isWorkerTile(b.target)
                && (b.from === undefined || b.from === null || isWorkerTile(b.from))
                && (b.reason === undefined || (typeof b.reason === 'string' && UNREACHABLE_REASONS.has(b.reason)));
        case 'combat_survivability':
            return typeof b.reason === 'string' && SURVIVABILITY_REASONS.has(b.reason)
                && (b.required === undefined || isFiniteNonNeg(b.required))
                && (b.current === undefined || isFiniteNonNeg(b.current));
        case 'max_level_cap':
            return isNonEmptyStr(b.skill) && isPosInt(b.maxLevel) && isNonNegInt(b.current);
        case 'protected_clock':
            return true;
        case 'cooldown_active':
            return isNonEmptyStr(b.key) && isFinitePos(b.expiresAt);
        case 'capacity_full':
            return isNonEmptyStr(b.spotId) && isNonNegInt(b.active) && isPosInt(b.limit);
        case 'invalid_config':
            return isNonEmptyStr(b.message);
        default:
            return false;
    }
}

const EMPTY_BLOCKERS: readonly PreflightBlocker[] = [];

export function preflightOk(
    extra?: Omit<PreflightResult, 'ok' | 'blockers'>,
): PreflightResult {
    if (extra === undefined) return { ok: true, blockers: EMPTY_BLOCKERS };
    const result: PreflightResult = { ok: true, blockers: EMPTY_BLOCKERS, ...extra };
    if (!extraPreflightFieldsValid(result) || (result as unknown as { ok: unknown }).ok !== true || result.blockers.length > 0) {
        const errs = validatePreflightResult(result);
        if (errs.length) throw new Error(`Invalid preflightOk: ${errs.join('; ')}`);
    }
    return result;
}

export function preflightFail(
    blockers: readonly PreflightBlocker[],
    extra?: Omit<PreflightResult, 'ok' | 'blockers'>,
): PreflightResult {
    const copied = Array.isArray(blockers) ? blockers.slice() : blockers;
    const result: PreflightResult = extra === undefined
        ? { ok: false, blockers: copied }
        : { ok: false, blockers: copied, ...extra };
    let valid = Array.isArray(copied) && copied.length > 0 && (extra === undefined || extraPreflightFieldsValid(result));
    if (valid) {
        for (let i = 0; i < copied.length; i++) {
            if (!fastBlockerValid(copied[i]!)) { valid = false; break; }
        }
    }
    if (!valid || (result as unknown as { ok: unknown }).ok !== false) {
        const errs = validatePreflightResult(result);
        if (errs.length) throw new Error(`Invalid preflightFail: ${errs.join('; ')}`);
    }
    return result;
}

// --- RateEstimate validators ---

export function validateRateEstimate(v: unknown): string[] {
    if (!isPlainRecord(v)) return ['RateEstimate must be an object'];
    const errors: string[] = [];
    if (!isFiniteNonNeg(v.xpPerTick)) errors.push('xpPerTick must be finite non-negative');
    if (!isFiniteNonNeg(v.unitsPerTick)) errors.push('unitsPerTick must be finite non-negative');
    if (typeof v.gpPerTick !== 'number' || !Number.isFinite(v.gpPerTick)) errors.push('gpPerTick must be a finite number');
    if (!isFiniteNonNeg(v.setupTicks)) errors.push('setupTicks must be finite non-negative');
    if (!isPosInt(v.minBatchUnits)) errors.push('minBatchUnits must be a positive integer');
    if (!isRateEstimateConfidence(v.confidence)) errors.push('confidence must be model, practice, or live');
    if (v.riskPerHour !== undefined && (typeof v.riskPerHour !== 'number' || !Number.isFinite(v.riskPerHour) || v.riskPerHour < 0 || v.riskPerHour > 1)) {
        errors.push('riskPerHour must be a finite number in [0, 1]');
    }
    if (v.skillXpPerTick !== undefined) checkNumericMap(v.skillXpPerTick, 'skillXpPerTick', isNonEmptyStr, isFiniteNonNeg, errors);
    if (v.outputsPerUnit !== undefined) checkNumericMap(v.outputsPerUnit, 'outputsPerUnit', isItemIdKey, isFinitePos, errors);
    if (v.inputsPerUnit !== undefined) checkNumericMap(v.inputsPerUnit, 'inputsPerUnit', isItemIdKey, isFinitePos, errors);
    return errors;
}

export const isRateEstimate = (v: unknown): v is RateEstimate => validateRateEstimate(v).length === 0;

export function effectiveTicksForBatch(est: RateEstimate, batchUnits: number): number {
    if (!Number.isFinite(batchUnits) || batchUnits <= 0) throw new Error(`batchUnits must be positive (got ${batchUnits})`);
    if (est.unitsPerTick <= 0) return Number.POSITIVE_INFINITY;
    return est.setupTicks + batchUnits / est.unitsPerTick;
}

// --- RunOutcome validators ---

export function validateRunOutcome(v: unknown): string[] {
    if (!isPlainRecord(v)) return ['RunOutcome must be an object'];
    const errors: string[] = [];
    if (!isOutcomeKind(v.kind)) errors.push(`invalid outcome kind: ${String(v.kind)}`);
    if (!isNonEmptyStr(v.activityId)) errors.push('activityId must be non-empty');
    if (!isNonEmptyStr(v.account)) errors.push('account must be non-empty');
    if (!isNonNegInt(v.ticksElapsed)) errors.push('ticksElapsed must be a non-negative integer');
    if (v.durationMs !== undefined && !isFiniteNonNeg(v.durationMs)) errors.push('durationMs must be finite non-negative');
    if (v.unitsCompleted !== undefined && !isFiniteNonNeg(v.unitsCompleted)) errors.push('unitsCompleted must be finite non-negative');
    if (v.xpGained !== undefined) checkNumericMap(v.xpGained, 'xpGained', isNonEmptyStr, isFiniteNonNeg, errors);
    if (v.itemsDelta !== undefined) checkNumericMap(v.itemsDelta, 'itemsDelta', isItemIdKey, Number.isSafeInteger, errors);
    if (v.coinsDelta !== undefined && !Number.isSafeInteger(v.coinsDelta)) errors.push('coinsDelta must be a safe integer');
    if (v.summary !== undefined && typeof v.summary !== 'string') errors.push('summary must be a string');

    switch (v.kind) {
        case 'target_met':
            break;
        case 'missing_supply':
            if (!Array.isArray(v.missing) || v.missing.length === 0) {
                errors.push('missing_supply.missing must be a non-empty array');
            } else {
                for (let idx = 0; idx < v.missing.length; idx++) {
                    const m = v.missing[idx];
                    if (!isPlainRecord(m) || !isNonNegInt(m.itemId) || !isPosInt(m.required) || !isNonNegInt(m.available)
                        || (m.itemName !== undefined && !isNonEmptyStr(m.itemName))) {
                        errors.push(`missing_supply.missing[${idx}] is invalid`);
                    }
                }
            }
            break;
        case 'location_stranded':
            if (v.pos !== undefined && v.pos !== null && !isWorkerTile(v.pos)) errors.push('location_stranded.pos must be a valid tile or null');
            if (v.detail !== undefined && typeof v.detail !== 'string') errors.push('location_stranded.detail must be a string');
            break;
        case 'market_unavailable':
            if (!isNonNegInt(v.itemId)) errors.push('market_unavailable.itemId must be a non-negative integer');
            if (!isNonEmptyStr(v.venue)) errors.push('market_unavailable.venue must be non-empty');
            if (v.cooldownMs !== undefined && !isFinitePos(v.cooldownMs)) errors.push('market_unavailable.cooldownMs must be finite positive');
            if (v.detail !== undefined && typeof v.detail !== 'string') errors.push('market_unavailable.detail must be a string');
            break;
        case 'session_unsettled':
            if (v.reason !== undefined && typeof v.reason !== 'string') errors.push('session_unsettled.reason must be a string');
            if (v.detail !== undefined && typeof v.detail !== 'string') errors.push('session_unsettled.detail must be a string');
            break;
        case 'infra_fault':
            if (!isInfraFaultSource(v.source)) errors.push('infra_fault.source is invalid');
            if (v.retryAfterMs !== undefined && !isFinitePos(v.retryAfterMs)) errors.push('infra_fault.retryAfterMs must be finite positive');
            if (v.detail !== undefined && typeof v.detail !== 'string') errors.push('infra_fault.detail must be a string');
            break;
        case 'worker_defect':
            if (!isNonEmptyStr(v.faultSignature)) errors.push('worker_defect.faultSignature must be non-empty');
            if (v.logPath !== undefined && !isNonEmptyStr(v.logPath)) errors.push('worker_defect.logPath must be non-empty');
            if (v.tickRecordPath !== undefined && !isNonEmptyStr(v.tickRecordPath)) errors.push('worker_defect.tickRecordPath must be non-empty');
            if (v.detail !== undefined && typeof v.detail !== 'string') errors.push('worker_defect.detail must be a string');
            break;
        case 'death':
            if (v.faultSignature !== undefined && !isNonEmptyStr(v.faultSignature)) errors.push('death.faultSignature must be non-empty');
            if (v.pos !== undefined && v.pos !== null && !isWorkerTile(v.pos)) errors.push('death.pos must be a valid tile or null');
            if (v.logPath !== undefined && !isNonEmptyStr(v.logPath)) errors.push('death.logPath must be non-empty');
            if (v.tickRecordPath !== undefined && !isNonEmptyStr(v.tickRecordPath)) errors.push('death.tickRecordPath must be non-empty');
            if (v.detail !== undefined && typeof v.detail !== 'string') errors.push('death.detail must be a string');
            break;
    }
    return errors;
}

export const isRunOutcome = (v: unknown): v is RunOutcome => validateRunOutcome(v).length === 0;

// --- WorkerModule & WorkerRegistry ---

export function validateWorkerModule(v: unknown): string[] {
    if (!isPlainRecord(v)) return ['WorkerModule must be an object'];
    const errors: string[] = [];
    if (!isNonEmptyStr(v.id)) errors.push('id must be non-empty');
    if (!isWorkerFamily(v.family)) errors.push(`invalid family: ${String(v.family)}`);
    if (!isWorkerKind(v.kind)) errors.push(`invalid kind: ${String(v.kind)}`);
    if (!isTrustTier(v.trust)) errors.push(`invalid trust: ${String(v.trust)}`);
    if (v.protectedAllowed !== undefined && typeof v.protectedAllowed !== 'boolean') {
        errors.push('protectedAllowed must be a boolean');
    }
    if (typeof v.preflight !== 'function') errors.push('preflight must be a function');
    if (typeof v.estimate !== 'function') errors.push('estimate must be a function');
    if (typeof v.run !== 'function') errors.push('run must be a function');
    return errors;
}

export const isWorkerModule = (v: unknown): v is WorkerModule<any, any, any, any> =>
    validateWorkerModule(v).length === 0;

export function createWorkerRegistry(
    initialModules: readonly WorkerModule<any, any, any, any>[] = [],
): WorkerRegistry {
    const modules = new Map<string, WorkerModule<any, any, any, any>>();
    const register: WorkerRegistry['register'] = (mod) => {
        const errors = validateWorkerModule(mod);
        if (errors.length) throw new Error(`Invalid WorkerModule: ${errors.join('; ')}`);
        if (modules.has(mod.id)) throw new Error(`Duplicate WorkerModule id: ${mod.id}`);
        modules.set(mod.id, mod);
    };
    for (const mod of initialModules) register(mod);
    return {
        register,
        get: (id) => modules.get(id),
        require: (id) => {
            const mod = modules.get(id);
            if (!mod) throw new Error(`Unknown WorkerModule: ${id}`);
            return mod;
        },
        has: (id) => modules.has(id),
        list: (filter) => {
            const out: WorkerModule<any, any, any, any>[] = [];
            for (const mod of modules.values()) {
                if (filter) {
                    if (filter.family !== undefined && mod.family !== filter.family) continue;
                    if (filter.kind !== undefined && mod.kind !== filter.kind) continue;
                    if (filter.trust !== undefined && mod.trust !== filter.trust) continue;
                    if (filter.minTrust !== undefined && !trustMeetsMinimum(mod.trust, filter.minTrust)) continue;
                    if (filter.protectedAllowed !== undefined && Boolean(mod.protectedAllowed) !== filter.protectedAllowed) continue;
                }
                out.push(mod);
            }
            return out.sort((a, b) => a.id.localeCompare(b.id));
        },
        size: () => modules.size,
    };
}
