// Core Fleet Brain contracts: AccountState, WorldSnapshot, DemandEngine, Planner/Scheduler, and Dashboard/Operator seams.
import { SIDE_NAME } from '../../core/src/fleet';
import { MAX_ORDER_LINES } from '../../core/src/fleet-trade-settlement';
import { RESERVED_ACCOUNTS } from '../../core/src/specialist-boards';
import type { World } from '../../core/src/world';
import {
    isTrustTier,
    isWorkerFamily,
    isWorkerKind,
    isWorkerQuestState,
    isWorkerTile,
    validateRateEstimate,
    type RateEstimate,
    type TrustTier,
    type WorkerAccountView,
    type WorkerBankView,
    type WorkerFamily,
    type WorkerKind,
    type WorkerQuestState,
    type WorkerSkillState,
    type WorkerTile,
    type WorkerWorldView,
} from '../../workers/src/contracts';

// ============================================================================
// Section 3.1: Account Lifecycle, Roles, AccountState, WorldSnapshot & Holds
// ============================================================================

export const ACCOUNT_LIFECYCLES = [
    'paused_owner',
    'reserved',
    'dead',
    'needs_logout_recovery',
    'needs_location_recovery',
    'running',
    'in_trade',
    'idle',
] as const;
export type AccountLifecycle = (typeof ACCOUNT_LIFECYCLES)[number];

export const NON_EXPIRING_LIFECYCLES = ['paused_owner', 'dead'] as const;

export const RECOVERY_PRIORITY_ORDER = [
    'needs_logout_recovery',
    'needs_location_recovery',
] as const;

export const UNBLOCK_EXECUTION_ORDER = [
    'needs_logout_recovery',
    'needs_location_recovery',
    'idle',
] as const;

export const ACCOUNT_ROLES = ['auto', 'army', 'helper', 'specialist', 'main'] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export const SYSTEM_HOLD_KINDS = [
    'cooldown',
    'retry_backoff',
    'maintenance',
    'market_unavailable',
    'circuit_breaker',
] as const;
export type SystemHoldKind = (typeof SYSTEM_HOLD_KINDS)[number];

export interface SystemHold {
    readonly kind: SystemHoldKind;
    readonly key: string;
    readonly reason: string;
    readonly createdAt: number;
    readonly expiresAt: number;
}

export type AccountSkillState = WorkerSkillState;
export type AccountQuestState = WorkerQuestState;
export type AccountBankState = WorkerBankView;

export interface AccountActiveJob {
    readonly activityId: string;
    readonly demandId: string;
    readonly startedAt: number;
}

export interface AccountState extends WorkerAccountView {
    readonly name: string;
    readonly side: string;
    readonly role: AccountRole;
    readonly protectedClock: boolean;
    readonly maxLevels?: Readonly<Record<string, number>>;
    readonly lifecycle: AccountLifecycle;

    readonly skills: Readonly<Record<string, AccountSkillState>>;
    readonly quests: Readonly<Record<string, AccountQuestState>>;
    readonly pos: WorkerTile | null;

    readonly inventory: Readonly<Record<number, number>>;
    readonly equipment: Readonly<Record<number, number>>;
    readonly bank: AccountBankState;

    readonly activeJob?: AccountActiveJob;
    readonly cooldowns?: Readonly<Record<string, number>>;
    readonly systemHolds?: readonly SystemHold[];
    readonly lastLoginAttemptAt?: number;
    readonly lastSettledTransferAt?: number;
}

export interface FleetSideStatus {
    readonly side: string;
    readonly seenAt: number | null;
    readonly capacity: number;
    readonly stopped: boolean;
}

export interface WorldSnapshot extends WorkerWorldView {
    readonly schemaVersion: 1;
    readonly at: number;
    readonly side: string;
    readonly server: string;
    readonly accounts: Readonly<Record<string, AccountState>>;
    readonly fleetSides?: Readonly<Record<string, FleetSideStatus>>;
    readonly reserves?: Readonly<Record<string, Readonly<Record<number, number>>>>;
    readonly globalReserves?: Readonly<Record<number, number>>;
    readonly marketCooldowns?: Readonly<Record<string, number>>;
    readonly spotOccupancy?: Readonly<Record<string, number>>;
    readonly geEscrowCoins?: Readonly<Record<string, number>>;
    readonly activeTransfers?: readonly TransferOrder[];
    readonly world?: World;
}

// ============================================================================
// Section 3.3: DemandEngine: Goals, Campaign, Mission, Catalog & Rates
// ============================================================================

export const GOAL_KINDS = [
    'main_supply',
    'specialist_prep',
    'quest_board',
    'gear_collection',
    'pk_army',
    'squad_supply',
    'coin_fund',
] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];

export type GoalDemandTarget =
    | {
          readonly kind: 'item';
          readonly itemId: number;
          readonly itemName?: string;
          readonly count: number;
          readonly holder?: string;
      }
    | {
          readonly kind: 'skill';
          readonly account: string;
          readonly skill: string;
          readonly targetLevel: number;
          readonly targetXp?: number;
      }
    | {
          readonly kind: 'quest';
          readonly account?: string;
          readonly questSlug: string;
      }
    | {
          readonly kind: 'coins';
          readonly account?: string;
          readonly amount: number;
      }
    | {
          readonly kind: 'combat_readiness';
          readonly account: string;
          readonly targets: Readonly<Record<string, number>>;
      };

export interface GoalDemand {
    readonly id: string;
    readonly goalKind: GoalKind;
    readonly sourceId?: string;
    readonly valueScore: number;
    readonly valuePerHour?: number;
    readonly target: GoalDemandTarget;
    readonly fulfilled: number;
    readonly remaining: number;
    readonly priorityWeight: number;
    readonly assignedAccount?: string;
    readonly active: boolean;
}

export const CAMPAIGN_STATES = ['staging', 'ready', 'running', 'paused', 'completed'] as const;
export type CampaignState = (typeof CAMPAIGN_STATES)[number];

export interface CampaignSupplyRequirement {
    readonly itemId: number;
    readonly itemName?: string;
    readonly count: number;
    readonly stage?: string;
}

export interface RehearsalProofSummary {
    readonly verified: boolean;
    readonly ticks?: number;
    readonly contextSha256?: string;
    readonly verifiedAt?: number;
    readonly reportPath?: string;
}

export interface HiscoreMarginSummary {
    readonly board: string;
    readonly rivalTicks: number;
    readonly ourTicks: number;
    readonly marginTicks: number;
    readonly marginRatio: number;
    readonly checkedAt: number;
    readonly meetsMargin: boolean;
}

export interface Campaign {
    readonly id: string;
    readonly account: string;
    readonly protectedClock: boolean;
    readonly board: string;
    readonly requiredSupplies: readonly CampaignSupplyRequirement[];
    readonly stagingHolder: string | null;
    readonly rehearsalProof: RehearsalProofSummary | null;
    readonly hiscoreMargin: HiscoreMarginSummary | null;
    readonly state: CampaignState;
    readonly weight?: number;
}

export const MISSION_STATES = ['staging', 'ready', 'running', 'paused'] as const;
export type MissionState = (typeof MISSION_STATES)[number];

export interface MissionKitTarget {
    readonly itemId: number;
    readonly itemName?: string;
    readonly countPerParticipant: number;
    readonly slot?: string;
}

export interface MissionConsumableTarget {
    readonly itemId: number;
    readonly itemName?: string;
    readonly countPerParticipant: number;
    readonly minReservePerParticipant?: number;
}

export interface Mission {
    readonly id: string;
    readonly participants: readonly string[];
    readonly state: MissionState;
    readonly kitTargets: readonly MissionKitTarget[];
    readonly consumables: readonly MissionConsumableTarget[];
    readonly weight: number;
}

export interface ActivityIO {
    readonly itemId: number;
    readonly countPerUnit: number;
}

export interface ActivityDefinition<Cfg = Record<string, unknown>> {
    readonly id: string;
    readonly workerId: string;
    readonly family: WorkerFamily;
    readonly kind: WorkerKind;
    readonly label: string;
    readonly skill?: string;
    readonly skills?: readonly string[];
    readonly questSlug?: string;
    readonly spotId?: string;
    readonly maxConcurrentAccounts?: number;
    readonly config: Cfg;
    readonly baselineRate: RateEstimate;
    readonly inputs?: readonly ActivityIO[];
    readonly outputs?: readonly ActivityIO[];
    readonly location?: WorkerTile;
    readonly trust: TrustTier;
    readonly protectedAllowed?: boolean;
}

export interface RateSample {
    readonly activityId: string;
    readonly account: string;
    readonly domain: 'practice' | 'live';
    readonly observedAt: number;
    readonly ticksElapsed: number;
    readonly unitsCompleted: number;
    readonly xpPerTick: number;
    readonly unitsPerTick: number;
    readonly gpPerTick: number;
    readonly setupTicks?: number;
    readonly died?: boolean;
    readonly sourceRunId?: string;
}

// ============================================================================
// Section 3.4: AccountPlanner, FleetScheduler & Safe Logistics
// ============================================================================

export const ACQUIRE_SOURCE_ORDER = [
    'own_bank',
    'npc_shop',
    'ge',
    'hub_banker',
    'craft_gather',
] as const;
export type AcquireSourceKind = (typeof ACQUIRE_SOURCE_ORDER)[number];

export const DEFAULT_OPERATING_COIN_FLOAT = 1000;
export const DEFAULT_RETENTION_MARGIN_RATIO = 0.15;
export const MAX_ACCOUNT_PLAN_STEPS = 3;

export const HUB_BANKER_LOCATIONS = {
    varrock_west: {
        id: 'varrock_west',
        name: 'Varrock West Bank',
        bankTile: { x: 3185, z: 3436, level: 0 },
        meetTiles: [
            { x: 3183, z: 3440, level: 0 },
            { x: 3182, z: 3440, level: 0 },
        ],
    },
    ardougne: {
        id: 'ardougne',
        name: 'Ardougne North Bank',
        bankTile: { x: 2619, z: 3332, level: 0 },
        meetTiles: [
            { x: 2618, z: 3333, level: 0 },
            { x: 2617, z: 3333, level: 0 },
        ],
    },
} as const;
export type HubBankId = keyof typeof HUB_BANKER_LOCATIONS;

export interface AcquireStep {
    readonly stepKind: 'acquire';
    readonly source: AcquireSourceKind;
    readonly itemId: number;
    readonly itemName?: string;
    readonly quantity: number;
    readonly estimatedTicks: number;
    readonly estimatedCoinCost: number;
    readonly coinFloatPreserved: number;
    readonly shopId?: string;
    readonly donorAccount?: string;
    readonly hub?: HubBankId;
    readonly transferOrderId?: string;
    readonly activityId?: string;
    readonly venueKey?: string;
}

export interface RecoverPlannedStep {
    readonly stepKind: 'recover';
    readonly recoveryKind: 'logout' | 'location';
    readonly targetHub?: HubBankId;
    readonly estimatedTicks: number;
    readonly reason: string;
}

export interface GearUpgradePlannedStep {
    readonly stepKind: 'gear_upgrade';
    readonly itemId: number;
    readonly itemName?: string;
    readonly slot: string;
    readonly netXpPerTickGain: number;
    readonly remainingBandTicks: number;
    readonly acquisitionTicks: number;
    readonly paybackNetTicks: number;
    readonly source: AcquireSourceKind;
}

export interface UnlockPlannedStep {
    readonly stepKind: 'unlock';
    readonly unlockKind: 'quest' | 'skill';
    readonly activityId: string;
    readonly questSlug?: string;
    readonly skill?: string;
    readonly targetLevel?: number;
    readonly estimatedTicks: number;
}

export interface TargetWorkPlannedStep {
    readonly stepKind: 'work';
    readonly activityId: string;
    readonly demandId: string;
    readonly workerId: string;
    readonly batchUnits: number;
    readonly estimatedTicks: number;
    readonly expectedValuePerHour: number;
    readonly config: Readonly<Record<string, unknown>>;
}

export type PlannedStep =
    | RecoverPlannedStep
    | AcquireStep
    | GearUpgradePlannedStep
    | UnlockPlannedStep
    | TargetWorkPlannedStep;

export interface AccountPlan {
    readonly account: string;
    readonly steps: readonly PlannedStep[];
    readonly demandId?: string;
    readonly scorePerHour: number;
    readonly retentionMarginApplied?: boolean;
    readonly idleReason?: string;
}

export const TRANSFER_ORDER_STATES = [
    'planned',
    'in_progress',
    'settled',
    'failed',
    'expired',
] as const;
export type TransferOrderState = (typeof TRANSFER_ORDER_STATES)[number];

export interface TransferOrderLine {
    readonly itemId: number;
    readonly itemName?: string;
    readonly count: number;
}

export interface TransferAntiPingPong {
    readonly donorRecentReceivedAt?: number;
    readonly donorHoldsDemandForItems: boolean;
    readonly cooldownWindowMs: number;
}

export interface TransferOrder {
    readonly id: string;
    readonly server: string;
    readonly from: string;
    readonly to: string;
    readonly hub: HubBankId;
    readonly hubBanker?: string;
    readonly items: readonly TransferOrderLine[];
    readonly demandId: string;
    readonly reason: string;
    readonly createdAt: number;
    readonly expiresAt: number;
    readonly state: TransferOrderState;
    readonly bothIdleVerified: boolean;
    readonly donorLogoutConfirmedAt: number;
    readonly recipientLogoutConfirmedAt: number;
    readonly antiPingPong: TransferAntiPingPong;
}

export interface RecoveryQueueEntry {
    readonly account: string;
    readonly lifecycle: (typeof RECOVERY_PRIORITY_ORDER)[number];
    readonly priorityValue: number;
}

export interface FleetPlan {
    readonly schemaVersion: 1;
    readonly plannedAt: number;
    readonly side: string;
    readonly maxBots: number;
    readonly retentionMarginRatio: number;
    readonly recoveryQueue: readonly RecoveryQueueEntry[];
    readonly accountPlans: Readonly<Record<string, AccountPlan>>;
    readonly transferOrders: readonly TransferOrder[];
    readonly spotAllocations: Readonly<Record<string, readonly string[]>>;
    readonly selectedSlots: number;
}

// ============================================================================
// Section 3.5: Dashboard & Operator Control Seam
// ============================================================================

export const FLEET_STATE_SCHEMA_VERSION = 1 as const;

export interface DefectRecord {
    readonly id: string;
    readonly activityId: string;
    readonly faultSignature: string;
    readonly outcomeKind: 'worker_defect' | 'death';
    readonly account: string;
    readonly observedAt: number;
    readonly quarantinedAt: number;
    readonly expiresAt?: number;
    readonly quarantined: boolean;
    readonly workerRelease?: string;
    readonly logPath: string;
    readonly tickRecordPath?: string;
    readonly detail: string;
    readonly count: number;
}

export interface InfraCircuitBreakerState {
    readonly open: boolean;
    readonly trippedAt?: number;
    readonly retryAt?: number;
    readonly consecutiveFaults: number;
    readonly reason?: string;
}

export interface RateSummary {
    readonly samples: number;
    readonly xpPerTick: number;
    readonly unitsPerTick: number;
    readonly gpPerTick: number;
}

export interface FleetState {
    readonly schemaVersion: typeof FLEET_STATE_SCHEMA_VERSION;
    readonly emittedAt: number;
    readonly side: string;
    readonly server: string;
    readonly maxBots: number;
    readonly infraCircuitBreaker?: InfraCircuitBreakerState;
    readonly accounts: Readonly<Record<string, AccountState>>;
    readonly activeChains: Readonly<Record<string, AccountPlan>>;
    readonly idleReasons: Readonly<Record<string, string>>;
    readonly goals: readonly GoalDemand[];
    readonly campaigns: readonly Campaign[];
    readonly missions: readonly Mission[];
    readonly pendingTransfers: readonly TransferOrder[];
    readonly quarantinedDefects: readonly DefectRecord[];
    readonly rateStats?: Readonly<Record<string, RateSummary>>;
}

export const OPERATOR_COMMAND_KINDS = [
    'pause_account',
    'resume_account',
    'pause_side',
    'resume_side',
    'override_account',
    'clear_defect',
    'set_campaign_state',
    'upsert_campaign',
    'set_mission_state',
    'upsert_mission',
] as const;
export type OperatorCommandKind = (typeof OPERATOR_COMMAND_KINDS)[number];

export interface OperatorCommandBase {
    readonly schemaVersion: 1;
    readonly id: string;
    readonly issuedAt: number;
    readonly issuedBy: string;
    readonly reason?: string;
}

export type OperatorCommand =
    | (OperatorCommandBase & {
          readonly kind: 'pause_account';
          readonly account: string;
      })
    | (OperatorCommandBase & {
          readonly kind: 'resume_account';
          readonly account: string;
          readonly clearDead?: boolean;
      })
    | (OperatorCommandBase & {
          readonly kind: 'pause_side';
          readonly side: string;
      })
    | (OperatorCommandBase & {
          readonly kind: 'resume_side';
          readonly side: string;
      })
    | (OperatorCommandBase & {
          readonly kind: 'override_account';
          readonly account: string;
          readonly activityId?: string | null;
          readonly role?: AccountRole;
          readonly expiresAt: number;
      })
    | (OperatorCommandBase & {
          readonly kind: 'clear_defect';
          readonly defectId?: string;
          readonly activityId: string;
          readonly faultSignature?: string;
      })
    | (OperatorCommandBase & {
          readonly kind: 'set_campaign_state';
          readonly campaignId: string;
          readonly state: CampaignState;
      })
    | (OperatorCommandBase & {
          readonly kind: 'upsert_campaign';
          readonly campaign: Campaign;
      })
    | (OperatorCommandBase & {
          readonly kind: 'set_mission_state';
          readonly missionId: string;
          readonly state: MissionState;
      })
    | (OperatorCommandBase & {
          readonly kind: 'upsert_mission';
          readonly mission: Mission;
      });

// ============================================================================
// Shared Internal Validation Primitives
// ============================================================================

const ACCOUNT_NAME = /^[A-Za-z0-9_ -]{1,12}$/;
const ITEM_KEY = /^(0|[1-9]\d*)$/;
const COINS_ITEM_ID = 995;
const PROTECTED_SET = new Set(RESERVED_ACCOUNTS.map((n) => n.toLowerCase()));

const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isAccountName = (v: unknown): v is string => typeof v === 'string' && ACCOUNT_NAME.test(v);
const isSide = (v: unknown): v is string => typeof v === 'string' && SIDE_NAME.test(v);
const isNonNegInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isPosInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const isFiniteNonNeg = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isFinitePos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

function checkItemCountMap(raw: unknown, label: string, errors: string[], allowZero = false): void {
    if (!isPlainRecord(raw)) {
        errors.push(`${label} must be an object`);
        return;
    }
    for (const [k, count] of Object.entries(raw)) {
        if (!ITEM_KEY.test(k)) errors.push(`${label} has invalid itemId key "${k}"`);
        if (allowZero ? !isNonNegInt(count) : !isPosInt(count)) {
            errors.push(`${label}[${k}] count must be a ${allowZero ? 'non-negative' : 'positive'} integer`);
        }
    }
}

function checkCooldownMap(raw: unknown, label: string, errors: string[]): void {
    if (!isPlainRecord(raw)) {
        errors.push(`${label} must be an object`);
        return;
    }
    for (const [k, expiresAt] of Object.entries(raw)) {
        if (!isNonEmptyStr(k)) errors.push(`${label} key must be non-empty`);
        if (!isFinitePos(expiresAt)) errors.push(`${label}["${k}"] must have a finite positive expiry timestamp`);
    }
}

function checkPositiveIntMap(raw: unknown, label: string, errors: string[], maxVal?: number): void {
    if (!isPlainRecord(raw)) {
        errors.push(`${label} must be an object`);
        return;
    }
    for (const [k, val] of Object.entries(raw)) {
        if (!isNonEmptyStr(k)) errors.push(`${label} key must be non-empty`);
        if (!isPosInt(val) || (maxVal !== undefined && (val as number) > maxVal)) {
            errors.push(`${label}["${k}"] is out of range`);
        }
    }
}

// ============================================================================
// Type Guards for Closed Vocabularies
// ============================================================================

export const isAccountLifecycle = (v: unknown): v is AccountLifecycle =>
    typeof v === 'string' && (ACCOUNT_LIFECYCLES as readonly string[]).includes(v);

export const isAccountRole = (v: unknown): v is AccountRole =>
    typeof v === 'string' && (ACCOUNT_ROLES as readonly string[]).includes(v);

export const isSystemHoldKind = (v: unknown): v is SystemHoldKind =>
    typeof v === 'string' && (SYSTEM_HOLD_KINDS as readonly string[]).includes(v);

export const isGoalKind = (v: unknown): v is GoalKind =>
    typeof v === 'string' && (GOAL_KINDS as readonly string[]).includes(v);

export const isCampaignState = (v: unknown): v is CampaignState =>
    typeof v === 'string' && (CAMPAIGN_STATES as readonly string[]).includes(v);

export const isMissionState = (v: unknown): v is MissionState =>
    typeof v === 'string' && (MISSION_STATES as readonly string[]).includes(v);

export const isAcquireSourceKind = (v: unknown): v is AcquireSourceKind =>
    typeof v === 'string' && (ACQUIRE_SOURCE_ORDER as readonly string[]).includes(v);

export const isHubBankId = (v: unknown): v is HubBankId =>
    typeof v === 'string' && Object.hasOwn(HUB_BANKER_LOCATIONS, v);

export const isTransferOrderState = (v: unknown): v is TransferOrderState =>
    typeof v === 'string' && (TRANSFER_ORDER_STATES as readonly string[]).includes(v);

export const isOperatorCommandKind = (v: unknown): v is OperatorCommandKind =>
    typeof v === 'string' && (OPERATOR_COMMAND_KINDS as readonly string[]).includes(v);

// ============================================================================
// Section 3.1 Helpers: Protected Clocks, Offline Bank Trust, TTL Holds, Recovery
// ============================================================================

export function isProtectedAccountName(name: string): boolean {
    return PROTECTED_SET.has(name.trim().toLowerCase());
}

export function lifecycleAutoExpires(lifecycle: AccountLifecycle): boolean {
    return lifecycle !== 'paused_owner' && lifecycle !== 'dead';
}

export const canAutoClearLifecycle = lifecycleAutoExpires;

export function validateSystemHold(v: unknown): string[] {
    if (!isPlainRecord(v)) return ['SystemHold must be an object'];
    const errors: string[] = [];
    if (!isSystemHoldKind(v.kind)) errors.push(`invalid SystemHold kind: ${String(v.kind)}`);
    if (!isNonEmptyStr(v.key)) errors.push('SystemHold.key must be non-empty');
    if (!isNonEmptyStr(v.reason)) errors.push('SystemHold.reason must be non-empty');
    if (!isFinitePos(v.createdAt)) errors.push('SystemHold.createdAt must be a finite positive timestamp');
    if (!isFinitePos(v.expiresAt)) errors.push('SystemHold.expiresAt must be a finite positive timestamp');
    if (isFinitePos(v.createdAt) && isFinitePos(v.expiresAt) && v.expiresAt <= v.createdAt) {
        errors.push('SystemHold.expiresAt must be strictly after createdAt');
    }
    return errors;
}

export const isSystemHold = (v: unknown): v is SystemHold => validateSystemHold(v).length === 0;

export function createExpiringHold(params: {
    kind: SystemHoldKind;
    key: string;
    reason: string;
    now: number;
    ttlMs: number;
}): SystemHold {
    if (!isSystemHoldKind(params.kind)) throw new Error(`Invalid hold kind: ${String(params.kind)}`);
    if (!isNonEmptyStr(params.key)) throw new Error('Hold key must be non-empty');
    if (!isNonEmptyStr(params.reason)) throw new Error('Hold reason must be non-empty');
    if (!isFinitePos(params.now)) throw new Error(`Hold now timestamp must be finite positive (got ${params.now})`);
    if (!isFinitePos(params.ttlMs)) throw new Error(`Hold ttlMs must be finite positive (got ${params.ttlMs})`);
    return {
        kind: params.kind,
        key: params.key.trim(),
        reason: params.reason.trim(),
        createdAt: params.now,
        expiresAt: params.now + params.ttlMs,
    };
}

export function isHoldActive(hold: SystemHold, now: number): boolean {
    return Number.isFinite(hold.expiresAt) && Number.isFinite(now) && now < hold.expiresAt;
}

export function pruneExpiredHolds(holds: readonly SystemHold[], now: number): SystemHold[] {
    return holds.filter((h) => isHoldActive(h, now));
}

export function marketCooldownKey(itemId: number, venue: string): string {
    if (!isNonNegInt(itemId)) throw new Error(`invalid itemId: ${itemId}`);
    if (!isNonEmptyStr(venue)) throw new Error('venue must be non-empty');
    return `${itemId}:${venue.trim().toLowerCase()}`;
}

export function setCooldown(
    cooldowns: Readonly<Record<string, number>> | undefined,
    key: string,
    now: number,
    ttlMs: number,
): Record<string, number> {
    if (!isNonEmptyStr(key)) throw new Error('cooldown key must be non-empty');
    if (!isFinitePos(now)) throw new Error(`cooldown now must be finite positive (got ${now})`);
    if (!isFinitePos(ttlMs)) throw new Error(`cooldown ttlMs must be finite positive (got ${ttlMs})`);
    const next = pruneExpiredCooldowns(cooldowns, now);
    next[key] = now + ttlMs;
    return next;
}

export function isCooldownActive(
    cooldowns: Readonly<Record<string, number>> | undefined,
    key: string,
    now: number,
): boolean {
    if (!cooldowns) return false;
    const expiresAt = cooldowns[key];
    return typeof expiresAt === 'number' && Number.isFinite(expiresAt) && now < expiresAt;
}

export function pruneExpiredCooldowns(
    cooldowns: Readonly<Record<string, number>> | undefined,
    now: number,
): Record<string, number> {
    const next: Record<string, number> = {};
    if (!cooldowns) return next;
    for (const [k, expiresAt] of Object.entries(cooldowns)) {
        if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && now < expiresAt) {
            next[k] = expiresAt;
        }
    }
    return next;
}

export function isOfflineBankTrusted(
    bank: AccountBankState,
    context: {
        confirmedOffline: boolean;
        lastLoginAttemptAt?: number;
        lastSettledTransferAt?: number;
    },
): boolean {
    if (!context.confirmedOffline || !bank.trusted || !isFinitePos(bank.observedAt)) return false;
    if (context.lastLoginAttemptAt !== undefined && context.lastLoginAttemptAt > bank.observedAt) return false;
    if (context.lastSettledTransferAt !== undefined && context.lastSettledTransferAt > bank.observedAt) return false;
    return true;
}

export function reconcileOfflineBankTrust(
    bank: AccountBankState,
    context: {
        confirmedOffline: boolean;
        lastLoginAttemptAt?: number;
        lastSettledTransferAt?: number;
    },
): AccountBankState {
    const trusted = isOfflineBankTrusted(bank, context);
    return trusted === bank.trusted ? bank : { ...bank, trusted };
}

export function recoveryPriorityRank(lifecycle: AccountLifecycle): number {
    if (lifecycle === 'needs_logout_recovery') return 0;
    if (lifecycle === 'needs_location_recovery') return 1;
    if (lifecycle === 'idle') return 2;
    return Number.POSITIVE_INFINITY;
}

export function accountFrozenValue(
    acct: AccountState,
    itemPrices: Readonly<Record<number, number>> = {},
): number {
    const sumContainer = (items: Readonly<Record<number, number>>): number => {
        let total = 0;
        for (const [idStr, count] of Object.entries(items)) {
            const id = Number(idStr);
            if (!Number.isFinite(count) || count <= 0) continue;
            if (id === COINS_ITEM_ID) total += count;
            else if (itemPrices[id] && Number.isFinite(itemPrices[id])) total += count * itemPrices[id]!;
        }
        return total;
    };
    let value = sumContainer(acct.inventory) + sumContainer(acct.equipment);
    if (acct.bank.observedAt > 0) value += sumContainer(acct.bank.items);
    return value;
}

export function compareRecoveryPriority(
    a: AccountState,
    b: AccountState,
    frozenValueOf: (acct: AccountState) => number = accountFrozenValue,
): number {
    const rankDiff = recoveryPriorityRank(a.lifecycle) - recoveryPriorityRank(b.lifecycle);
    if (rankDiff !== 0) {
        if (!Number.isFinite(rankDiff)) return Number.isFinite(recoveryPriorityRank(a.lifecycle)) ? -1 : 1;
        return rankDiff;
    }
    if (a.lifecycle === 'needs_logout_recovery' || a.lifecycle === 'needs_location_recovery') {
        const valueDiff = frozenValueOf(b) - frozenValueOf(a);
        if (valueDiff !== 0) return valueDiff;
    }
    return a.name.localeCompare(b.name);
}

// ============================================================================
// AccountState & WorldSnapshot Validators
// ============================================================================

export function validateAccountState(v: unknown): string[] {
    if (!isPlainRecord(v)) return ['AccountState must be an object'];
    const errors: string[] = [];
    if (!isAccountName(v.name)) errors.push(`invalid account name: ${String(v.name)}`);
    if (!isSide(v.side)) errors.push(`invalid side: ${String(v.side)}`);
    if (!isAccountRole(v.role)) errors.push(`invalid role: ${String(v.role)}`);
    if (typeof v.protectedClock !== 'boolean') errors.push('protectedClock must be a boolean');
    if (typeof v.name === 'string' && typeof v.protectedClock === 'boolean') {
        if ((v.role === 'main' || v.role === 'specialist' || isProtectedAccountName(v.name)) && !v.protectedClock) {
            errors.push('protected/reserved accounts must set protectedClock=true');
        }
        if (v.role === 'main' && v.name.toLowerCase() !== 'haggis') {
            errors.push('role "main" is reserved for Haggis');
        }
    }
    if (v.maxLevels !== undefined) checkPositiveIntMap(v.maxLevels, 'maxLevels', errors, 99);
    if (!isAccountLifecycle(v.lifecycle)) errors.push(`invalid lifecycle: ${String(v.lifecycle)}`);

    if (!isPlainRecord(v.skills)) {
        errors.push('skills must be an object');
    } else {
        for (const [skill, stat] of Object.entries(v.skills)) {
            if (!isNonEmptyStr(skill)) errors.push('skills key must be non-empty');
            if (!isPlainRecord(stat) || !isPosInt(stat.level) || !isFiniteNonNeg(stat.xp)) {
                errors.push(`skills["${skill}"] must have positive integer level and non-negative xp`);
            }
        }
    }

    if (!isPlainRecord(v.quests)) {
        errors.push('quests must be an object');
    } else {
        for (const [slug, qState] of Object.entries(v.quests)) {
            if (!isNonEmptyStr(slug)) errors.push('quests key must be non-empty');
            if (!isWorkerQuestState(qState)) errors.push(`quests["${slug}"] invalid state: ${String(qState)}`);
        }
    }

    if (v.pos !== null && !isWorkerTile(v.pos)) errors.push('pos must be a valid tile or null');
    checkItemCountMap(v.inventory, 'inventory', errors);
    checkItemCountMap(v.equipment, 'equipment', errors);

    if (!isPlainRecord(v.bank)) {
        errors.push('bank must be an object');
    } else {
        checkItemCountMap(v.bank.items, 'bank.items', errors);
        if (!isFiniteNonNeg(v.bank.observedAt)) errors.push('bank.observedAt must be finite non-negative');
        if (typeof v.bank.trusted !== 'boolean') errors.push('bank.trusted must be a boolean');
        if (v.bank.observedAt === 0 && v.bank.trusted === true) {
            errors.push('unobserved bank (observedAt=0) cannot have trusted=true');
        }
        if (v.lastLoginAttemptAt !== undefined) {
            if (!isFinitePos(v.lastLoginAttemptAt)) errors.push('lastLoginAttemptAt must be finite positive');
            else if (isFiniteNonNeg(v.bank.observedAt) && v.lastLoginAttemptAt > v.bank.observedAt && v.bank.trusted === true) {
                errors.push('bank.trusted must be false after a newer login attempt');
            }
        }
        if (v.lastSettledTransferAt !== undefined) {
            if (!isFinitePos(v.lastSettledTransferAt)) errors.push('lastSettledTransferAt must be finite positive');
            else if (isFiniteNonNeg(v.bank.observedAt) && v.lastSettledTransferAt > v.bank.observedAt && v.bank.trusted === true) {
                errors.push('bank.trusted must be false after a newer settled transfer');
            }
        }
    }

    if (v.reserves !== undefined) checkItemCountMap(v.reserves, 'reserves', errors, true);
    if (v.cooldowns !== undefined) checkCooldownMap(v.cooldowns, 'cooldowns', errors);
    if (v.systemHolds !== undefined) {
        if (!Array.isArray(v.systemHolds)) errors.push('systemHolds must be an array');
        else v.systemHolds.forEach((h, i) => {
            for (const err of validateSystemHold(h)) errors.push(`systemHolds[${i}]: ${err}`);
        });
    }

    if (v.lifecycle === 'running') {
        if (!isPlainRecord(v.activeJob) || !isNonEmptyStr(v.activeJob.activityId)
            || !isNonEmptyStr(v.activeJob.demandId) || !isFinitePos(v.activeJob.startedAt)) {
            errors.push('running account requires valid activeJob');
        }
    } else if (v.activeJob !== undefined) {
        errors.push(`non-running lifecycle "${String(v.lifecycle)}" must not hold activeJob`);
    }

    return errors;
}

export const isAccountState = (v: unknown): v is AccountState => validateAccountState(v).length === 0;

export function validateWorldSnapshot(v: unknown): string[] {
    if (!isPlainRecord(v)) return ['WorldSnapshot must be an object'];
    const errors: string[] = [];
    if (v.schemaVersion !== 1) errors.push('WorldSnapshot.schemaVersion must be 1');
    if (!isFinitePos(v.at)) errors.push('WorldSnapshot.at must be finite positive');
    if (!isSide(v.side)) errors.push(`invalid WorldSnapshot.side: ${String(v.side)}`);
    if (!isNonEmptyStr(v.server)) errors.push('WorldSnapshot.server must be non-empty');

    if (!isPlainRecord(v.accounts)) {
        errors.push('WorldSnapshot.accounts must be an object');
    } else {
        for (const [key, acct] of Object.entries(v.accounts)) {
            for (const err of validateAccountState(acct)) errors.push(`accounts["${key}"]: ${err}`);
            if (isPlainRecord(acct) && typeof acct.name === 'string' && key.toLowerCase() !== acct.name.toLowerCase()) {
                errors.push(`accounts["${key}"] key mismatch with name "${acct.name}"`);
            }
        }
    }

    if (v.fleetSides !== undefined) {
        if (!isPlainRecord(v.fleetSides)) errors.push('fleetSides must be an object');
        else for (const [k, s] of Object.entries(v.fleetSides)) {
            if (!isSide(k) || !isPlainRecord(s) || !isSide(s.side)
                || (s.seenAt !== null && !isFinitePos(s.seenAt))
                || !isNonNegInt(s.capacity) || typeof s.stopped !== 'boolean') {
                errors.push(`fleetSides["${k}"] is invalid`);
            }
        }
    }
    if (v.reserves !== undefined) {
        if (!isPlainRecord(v.reserves)) errors.push('reserves must be an object');
        else for (const [acctKey, map] of Object.entries(v.reserves)) {
            if (!isAccountName(acctKey)) errors.push(`reserves key "${acctKey}" invalid`);
            checkItemCountMap(map, `reserves["${acctKey}"]`, errors, true);
        }
    }
    if (v.globalReserves !== undefined) checkItemCountMap(v.globalReserves, 'globalReserves', errors, true);
    if (v.marketCooldowns !== undefined) checkCooldownMap(v.marketCooldowns, 'marketCooldowns', errors);
    if (v.spotOccupancy !== undefined) {
        if (!isPlainRecord(v.spotOccupancy)) errors.push('spotOccupancy must be an object');
        else for (const [spotId, cnt] of Object.entries(v.spotOccupancy)) {
            if (!isNonEmptyStr(spotId) || !isNonNegInt(cnt)) errors.push(`spotOccupancy["${spotId}"] must be a non-negative integer`);
        }
    }
    if (v.geEscrowCoins !== undefined) {
        if (!isPlainRecord(v.geEscrowCoins)) errors.push('geEscrowCoins must be an object');
        else for (const [acctKey, coins] of Object.entries(v.geEscrowCoins)) {
            if (!isAccountName(acctKey) || !isNonNegInt(coins)) errors.push(`geEscrowCoins["${acctKey}"] must be a non-negative integer`);
        }
    }
    if (v.activeTransfers !== undefined) {
        if (!Array.isArray(v.activeTransfers)) errors.push('activeTransfers must be an array');
        else v.activeTransfers.forEach((t, i) => {
            for (const err of validateTransferOrder(t)) errors.push(`activeTransfers[${i}]: ${err}`);
        });
    }
    return errors;
}

export const isWorldSnapshot = (v: unknown): v is WorldSnapshot => validateWorldSnapshot(v).length === 0;

// ============================================================================
// Section 3.3 Validators & Helpers: Demand, Campaign, Mission, Activity, Rate
// ============================================================================

export function validateGoalDemand(v: unknown): string[] {
    if (!isPlainRecord(v)) return ['GoalDemand must be an object'];
    const errors: string[] = [];
    if (!isNonEmptyStr(v.id)) errors.push('GoalDemand.id must be non-empty');
    if (!isGoalKind(v.goalKind)) errors.push(`invalid GoalDemand.goalKind: ${String(v.goalKind)}`);
    if (v.sourceId !== undefined && !isNonEmptyStr(v.sourceId)) errors.push('GoalDemand.sourceId must be non-empty');
    if (!isFiniteNonNeg(v.valueScore)) errors.push('GoalDemand.valueScore must be finite non-negative');
    if (v.valuePerHour !== undefined && !isFiniteNonNeg(v.valuePerHour)) errors.push('GoalDemand.valuePerHour must be finite non-negative');
    if (!isFiniteNonNeg(v.fulfilled)) errors.push('GoalDemand.fulfilled must be finite non-negative');
    if (!isFiniteNonNeg(v.remaining)) errors.push('GoalDemand.remaining must be finite non-negative');
    if (!isFiniteNonNeg(v.priorityWeight)) errors.push('GoalDemand.priorityWeight must be finite non-negative');
    if (v.assignedAccount !== undefined && !isAccountName(v.assignedAccount)) errors.push('GoalDemand.assignedAccount invalid');
    if (typeof v.active !== 'boolean') errors.push('GoalDemand.active must be a boolean');

    if (!isPlainRecord(v.target)) {
        errors.push('GoalDemand.target must be an object');
    } else {
        switch (v.target.kind) {
            case 'item':
                if (!isNonNegInt(v.target.itemId) || !isPosInt(v.target.count)) errors.push('target(item) invalid itemId or count');
                if (v.target.itemName !== undefined && !isNonEmptyStr(v.target.itemName)) errors.push('target(item).itemName invalid');
                if (v.target.holder !== undefined && !isAccountName(v.target.holder)) errors.push('target(item).holder invalid');
                break;
            case 'skill':
                if (!isAccountName(v.target.account) || !isNonEmptyStr(v.target.skill) || !isPosInt(v.target.targetLevel) || (v.target.targetLevel as number) > 99) {
                    errors.push('target(skill) invalid');
                }
                if (v.target.targetXp !== undefined && !isFiniteNonNeg(v.target.targetXp)) errors.push('target(skill).targetXp invalid');
                break;
            case 'quest':
                if (!isNonEmptyStr(v.target.questSlug)) errors.push('target(quest).questSlug must be non-empty');
                if (v.target.account !== undefined && !isAccountName(v.target.account)) errors.push('target(quest).account invalid');
                break;
            case 'coins':
                if (!isPosInt(v.target.amount)) errors.push('target(coins).amount must be positive integer');
                if (v.target.account !== undefined && !isAccountName(v.target.account)) errors.push('target(coins).account invalid');
                break;
            case 'combat_readiness':
                if (!isAccountName(v.target.account)) errors.push('target(combat_readiness).account invalid');
                checkPositiveIntMap(v.target.targets, 'target(combat_readiness).targets', errors, 99);
                break;
            default:
                errors.push(`unknown GoalDemand.target kind: ${String(v.target.kind)}`);
        }
    }
    return errors;
}

export const isGoalDemand = (v: unknown): v is GoalDemand => validateGoalDemand(v).length === 0;

export const MAX_CAMPAIGN_HISCORE_AGE_MS = 3_600_000;

export interface CampaignLaunchReadyOptions {
    readonly now?: number;
    readonly maxHiscoreAgeMs?: number;
    readonly suppliesSatisfied?: boolean;
}

export function isHiscoreMarginFresh(
    margin: HiscoreMarginSummary | null | undefined,
    now: number,
    maxAgeMs = MAX_CAMPAIGN_HISCORE_AGE_MS,
): boolean {
    if (!margin || !Number.isFinite(margin.checkedAt) || !Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
        return false;
    }
    const age = now - margin.checkedAt;
    return age >= -60_000 && age <= maxAgeMs;
}

export function isCampaignLaunchReady(
    campaign: Campaign,
    opts?: CampaignLaunchReadyOptions,
): boolean {
    if (campaign.state === 'paused' || campaign.state === 'completed') return false;
    if (opts?.suppliesSatisfied === false) return false;
    if (!campaign.protectedClock) return campaign.state === 'ready' || campaign.state === 'running';
    if (campaign.rehearsalProof?.verified !== true) return false;
    if (campaign.hiscoreMargin?.meetsMargin !== true || campaign.hiscoreMargin.board !== campaign.board) {
        return false;
    }
    if (opts?.now !== undefined && !isHiscoreMarginFresh(campaign.hiscoreMargin, opts.now, opts.maxHiscoreAgeMs)) {
        return false;
    }
    return true;
}

export function validateCampaign(v: unknown): string[] {
    if (!isPlainRecord(v)) return ['Campaign must be an object'];
    const errors: string[] = [];
    if (!isNonEmptyStr(v.id)) errors.push('Campaign.id must be non-empty');
    if (!isAccountName(v.account)) errors.push('Campaign.account invalid');
    if (typeof v.protectedClock !== 'boolean') errors.push('Campaign.protectedClock must be boolean');
    if (typeof v.account === 'string' && isProtectedAccountName(v.account) && v.protectedClock !== true) {
        errors.push('reserved account campaign must have protectedClock=true');
    }
    if (!isNonEmptyStr(v.board)) errors.push('Campaign.board must be non-empty');
    if (!isCampaignState(v.state)) errors.push(`invalid Campaign.state: ${String(v.state)}`);
    if (v.weight !== undefined && !isFiniteNonNeg(v.weight)) errors.push('Campaign.weight must be finite non-negative');

    if (!Array.isArray(v.requiredSupplies)) {
        errors.push('Campaign.requiredSupplies must be an array');
    } else {
        v.requiredSupplies.forEach((s, idx) => {
            if (!isPlainRecord(s) || !isNonNegInt(s.itemId) || !isPosInt(s.count)
                || (s.itemName !== undefined && !isNonEmptyStr(s.itemName))
                || (s.stage !== undefined && !isNonEmptyStr(s.stage))) {
                errors.push(`Campaign.requiredSupplies[${idx}] invalid`);
            }
        });
    }

    if (v.stagingHolder !== null) {
        if (!isAccountName(v.stagingHolder)) errors.push('Campaign.stagingHolder must be an account name or null');
        else if (v.protectedClock === true && typeof v.account === 'string'
            && v.stagingHolder.toLowerCase() === v.account.toLowerCase()) {
            errors.push('protectedClock campaign cannot stage supplies directly on the protected account');
        }
    }

    if (v.rehearsalProof !== null) {
        if (!isPlainRecord(v.rehearsalProof) || typeof v.rehearsalProof.verified !== 'boolean') {
            errors.push('Campaign.rehearsalProof invalid');
        }
    }
    if (v.hiscoreMargin !== null) {
        if (!isPlainRecord(v.hiscoreMargin) || !isNonEmptyStr(v.hiscoreMargin.board)
            || !isPosInt(v.hiscoreMargin.rivalTicks) || !isPosInt(v.hiscoreMargin.ourTicks)
            || !Number.isSafeInteger(v.hiscoreMargin.marginTicks)
            || typeof v.hiscoreMargin.marginRatio !== 'number' || !Number.isFinite(v.hiscoreMargin.marginRatio)
            || !isFinitePos(v.hiscoreMargin.checkedAt) || typeof v.hiscoreMargin.meetsMargin !== 'boolean') {
            errors.push('Campaign.hiscoreMargin invalid');
        }
    }

    if (v.protectedClock === true && (v.state === 'ready' || v.state === 'running')) {
        if (!isPlainRecord(v.rehearsalProof) || v.rehearsalProof.verified !== true) {
            errors.push('protectedClock campaign requires verified rehearsalProof before ready/running');
        }
        if (!isPlainRecord(v.hiscoreMargin) || v.hiscoreMargin.meetsMargin !== true || v.hiscoreMargin.board !== v.board) {
            errors.push('protectedClock campaign requires passing hiscoreMargin on the campaign board before ready/running');
        }
    }
    return errors;
}

export const isCampaign = (v: unknown): v is Campaign => validateCampaign(v).length === 0;

export function missionEffectiveWeight(mission: Mission): number {
    return mission.state === 'paused' ? 0 : mission.weight;
}

export function validateMission(v: unknown): string[] {
    if (!isPlainRecord(v)) return ['Mission must be an object'];
    const errors: string[] = [];
    if (!isNonEmptyStr(v.id)) errors.push('Mission.id must be non-empty');
    if (!isMissionState(v.state)) errors.push(`invalid Mission.state: ${String(v.state)}`);
    if (!isFiniteNonNeg(v.weight)) errors.push('Mission.weight must be finite non-negative');

    if (!Array.isArray(v.participants)) {
        errors.push('Mission.participants must be an array');
    } else {
        const seen = new Set<string>();
        for (const p of v.participants) {
            if (!isAccountName(p)) { errors.push(`Mission.participants invalid account: ${String(p)}`); continue; }
            const lower = p.toLowerCase();
            if (seen.has(lower)) errors.push(`Mission.participants duplicate: ${p}`);
            seen.add(lower);
        }
        if (v.state !== 'paused' && v.participants.length === 0) {
            errors.push('active Mission requires at least one participant');
        }
    }

    if (!Array.isArray(v.kitTargets)) {
        errors.push('Mission.kitTargets must be an array');
    } else {
        v.kitTargets.forEach((k, idx) => {
            if (!isPlainRecord(k) || !isNonNegInt(k.itemId) || !isPosInt(k.countPerParticipant)
                || (k.itemName !== undefined && !isNonEmptyStr(k.itemName))
                || (k.slot !== undefined && !isNonEmptyStr(k.slot))) {
                errors.push(`Mission.kitTargets[${idx}] invalid`);
            }
        });
    }

    if (!Array.isArray(v.consumables)) {
        errors.push('Mission.consumables must be an array');
    } else {
        v.consumables.forEach((c, idx) => {
            if (!isPlainRecord(c) || !isNonNegInt(c.itemId) || !isPosInt(c.countPerParticipant)
                || (c.minReservePerParticipant !== undefined && !isNonNegInt(c.minReservePerParticipant))
                || (c.itemName !== undefined && !isNonEmptyStr(c.itemName))) {
                errors.push(`Mission.consumables[${idx}] invalid`);
            }
        });
    }

    return errors;
}

export const isMission = (v: unknown): v is Mission => validateMission(v).length === 0;

export function validateActivityDefinition(v: unknown): string[] {
    if (!isPlainRecord(v)) return ['ActivityDefinition must be an object'];
    const errors: string[] = [];
    if (!isNonEmptyStr(v.id)) errors.push('ActivityDefinition.id must be non-empty');
    if (!isNonEmptyStr(v.workerId)) errors.push('ActivityDefinition.workerId must be non-empty');
    if (!isWorkerFamily(v.family)) errors.push(`invalid ActivityDefinition.family: ${String(v.family)}`);
    if (!isWorkerKind(v.kind)) errors.push(`invalid ActivityDefinition.kind: ${String(v.kind)}`);
    if (!isNonEmptyStr(v.label)) errors.push('ActivityDefinition.label must be non-empty');
    if (!isTrustTier(v.trust)) errors.push(`invalid ActivityDefinition.trust: ${String(v.trust)}`);
    if (v.skill !== undefined && !isNonEmptyStr(v.skill)) errors.push('ActivityDefinition.skill must be non-empty');
    if (v.skills !== undefined && (!Array.isArray(v.skills) || !v.skills.every(isNonEmptyStr))) {
        errors.push('ActivityDefinition.skills must be an array of non-empty strings');
    }
    if (v.questSlug !== undefined && !isNonEmptyStr(v.questSlug)) errors.push('ActivityDefinition.questSlug must be non-empty');
    if (v.spotId !== undefined && !isNonEmptyStr(v.spotId)) errors.push('ActivityDefinition.spotId must be non-empty');
    if (v.maxConcurrentAccounts !== undefined && !isPosInt(v.maxConcurrentAccounts)) {
        errors.push('ActivityDefinition.maxConcurrentAccounts must be a positive integer');
    }
    if (!isPlainRecord(v.config)) errors.push('ActivityDefinition.config must be an object');
    for (const err of validateRateEstimate(v.baselineRate)) errors.push(`baselineRate: ${err}`);
    for (const field of ['inputs', 'outputs'] as const) {
        const list = v[field];
        if (list !== undefined) {
            if (!Array.isArray(list)) errors.push(`${field} must be an array`);
            else list.forEach((io, i) => {
                if (!isPlainRecord(io) || !isNonNegInt(io.itemId) || !isFinitePos(io.countPerUnit)) {
                    errors.push(`${field}[${i}] invalid`);
                }
            });
        }
    }
    if (v.location !== undefined && !isWorkerTile(v.location)) errors.push('ActivityDefinition.location invalid');
    if (v.protectedAllowed !== undefined && typeof v.protectedAllowed !== 'boolean') {
        errors.push('ActivityDefinition.protectedAllowed must be boolean');
    }
    return errors;
}

export const isActivityDefinition = (v: unknown): v is ActivityDefinition => validateActivityDefinition(v).length === 0;

export function validateRateSample(v: unknown): string[] {
    if (!isPlainRecord(v)) return ['RateSample must be an object'];
    const errors: string[] = [];
    if (!isNonEmptyStr(v.activityId)) errors.push('RateSample.activityId must be non-empty');
    if (!isAccountName(v.account)) errors.push('RateSample.account invalid');
    if (v.domain !== 'practice' && v.domain !== 'live') errors.push('RateSample.domain must be practice or live');
    if (!isFinitePos(v.observedAt)) errors.push('RateSample.observedAt must be finite positive');
    if (!isPosInt(v.ticksElapsed)) errors.push('RateSample.ticksElapsed must be a positive integer');
    if (!isFiniteNonNeg(v.unitsCompleted)) errors.push('RateSample.unitsCompleted must be finite non-negative');
    if (!isFiniteNonNeg(v.xpPerTick)) errors.push('RateSample.xpPerTick must be finite non-negative');
    if (!isFiniteNonNeg(v.unitsPerTick)) errors.push('RateSample.unitsPerTick must be finite non-negative');
    if (typeof v.gpPerTick !== 'number' || !Number.isFinite(v.gpPerTick)) errors.push('RateSample.gpPerTick must be finite');
    if (v.setupTicks !== undefined && !isFiniteNonNeg(v.setupTicks)) errors.push('RateSample.setupTicks must be finite non-negative');
    if (v.died !== undefined && typeof v.died !== 'boolean') errors.push('RateSample.died must be boolean');
    if (v.sourceRunId !== undefined && !isNonEmptyStr(v.sourceRunId)) errors.push('RateSample.sourceRunId must be non-empty');
    return errors;
}

export const isRateSample = (v: unknown): v is RateSample => validateRateSample(v).length === 0;

// ============================================================================
// Section 3.4 Validators & Helpers: Planner, Scheduler, Transfers
// ============================================================================

export function validateAcquireStep(v: unknown): string[] {
    if (!isPlainRecord(v)) return ['AcquireStep must be an object'];
    const errors: string[] = [];
    if (v.stepKind !== 'acquire') errors.push('AcquireStep.stepKind must be "acquire"');
    if (!isAcquireSourceKind(v.source)) errors.push(`invalid AcquireStep.source: ${String(v.source)}`);
    if (!isNonNegInt(v.itemId)) errors.push('AcquireStep.itemId must be non-negative integer');
    if (v.itemName !== undefined && !isNonEmptyStr(v.itemName)) errors.push('AcquireStep.itemName must be non-empty');
    if (!isPosInt(v.quantity)) errors.push('AcquireStep.quantity must be positive integer');
    if (!isFiniteNonNeg(v.estimatedTicks)) errors.push('AcquireStep.estimatedTicks must be finite non-negative');
    if (!isFiniteNonNeg(v.estimatedCoinCost)) errors.push('AcquireStep.estimatedCoinCost must be finite non-negative');
    if (!isNonNegInt(v.coinFloatPreserved)) errors.push('AcquireStep.coinFloatPreserved must be non-negative integer');
    if (v.source === 'npc_shop' && v.shopId !== undefined && !isNonEmptyStr(v.shopId)) errors.push('shopId must be non-empty');
    if (v.source === 'hub_banker') {
        if (v.donorAccount !== undefined && !isAccountName(v.donorAccount)) errors.push('donorAccount invalid');
        if (v.hub !== undefined && !isHubBankId(v.hub)) errors.push('hub invalid');
    }
    return errors;
}

export const isAcquireStep = (v: unknown): v is AcquireStep => validateAcquireStep(v).length === 0;

export function validatePlannedStep(v: unknown): string[] {
    if (!isPlainRecord(v)) return ['PlannedStep must be an object'];
    switch (v.stepKind) {
        case 'recover': {
            const errors: string[] = [];
            if (v.recoveryKind !== 'logout' && v.recoveryKind !== 'location') errors.push('recover.recoveryKind invalid');
            if (v.targetHub !== undefined && !isHubBankId(v.targetHub)) errors.push('recover.targetHub invalid');
            if (!isFiniteNonNeg(v.estimatedTicks)) errors.push('recover.estimatedTicks must be finite non-negative');
            if (!isNonEmptyStr(v.reason)) errors.push('recover.reason must be non-empty');
            return errors;
        }
        case 'acquire':
            return validateAcquireStep(v);
        case 'gear_upgrade': {
            const errors: string[] = [];
            if (!isNonNegInt(v.itemId)) errors.push('gear_upgrade.itemId invalid');
            if (v.itemName !== undefined && !isNonEmptyStr(v.itemName)) errors.push('gear_upgrade.itemName invalid');
            if (!isNonEmptyStr(v.slot)) errors.push('gear_upgrade.slot must be non-empty');
            if (!isFinitePos(v.netXpPerTickGain)) errors.push('gear_upgrade.netXpPerTickGain must be finite positive');
            if (!isFinitePos(v.remainingBandTicks)) errors.push('gear_upgrade.remainingBandTicks must be finite positive');
            if (!isFiniteNonNeg(v.acquisitionTicks)) errors.push('gear_upgrade.acquisitionTicks must be finite non-negative');
            if (!isFinitePos(v.paybackNetTicks)) errors.push('gear_upgrade.paybackNetTicks must be finite positive');
            if (!isAcquireSourceKind(v.source)) errors.push('gear_upgrade.source invalid');
            return errors;
        }
        case 'unlock': {
            const errors: string[] = [];
            if (v.unlockKind !== 'quest' && v.unlockKind !== 'skill') errors.push('unlock.unlockKind invalid');
            if (!isNonEmptyStr(v.activityId)) errors.push('unlock.activityId must be non-empty');
            if (v.questSlug !== undefined && !isNonEmptyStr(v.questSlug)) errors.push('unlock.questSlug invalid');
            if (v.skill !== undefined && !isNonEmptyStr(v.skill)) errors.push('unlock.skill invalid');
            if (v.targetLevel !== undefined && (!isPosInt(v.targetLevel) || (v.targetLevel as number) > 99)) errors.push('unlock.targetLevel invalid');
            if (!isFiniteNonNeg(v.estimatedTicks)) errors.push('unlock.estimatedTicks invalid');
            return errors;
        }
        case 'work': {
            const errors: string[] = [];
            if (!isNonEmptyStr(v.activityId)) errors.push('work.activityId must be non-empty');
            if (!isNonEmptyStr(v.demandId)) errors.push('work.demandId must be non-empty');
            if (!isNonEmptyStr(v.workerId)) errors.push('work.workerId must be non-empty');
            if (!isPosInt(v.batchUnits)) errors.push('work.batchUnits must be positive integer');
            if (!isFiniteNonNeg(v.estimatedTicks)) errors.push('work.estimatedTicks must be finite non-negative');
            if (!isFiniteNonNeg(v.expectedValuePerHour)) errors.push('work.expectedValuePerHour must be finite non-negative');
            if (!isPlainRecord(v.config)) errors.push('work.config must be an object');
            return errors;
        }
        default:
            return [`unknown PlannedStep.stepKind: ${String(v.stepKind)}`];
    }
}

export const isPlannedStep = (v: unknown): v is PlannedStep => validatePlannedStep(v).length === 0;

export function validateAccountPlan(v: unknown): string[] {
    if (!isPlainRecord(v)) return ['AccountPlan must be an object'];
    const errors: string[] = [];
    if (!isAccountName(v.account)) errors.push('AccountPlan.account invalid');
    if (!isFiniteNonNeg(v.scorePerHour)) errors.push('AccountPlan.scorePerHour must be finite non-negative');
    if (v.demandId !== undefined && !isNonEmptyStr(v.demandId)) errors.push('AccountPlan.demandId must be non-empty');
    if (v.retentionMarginApplied !== undefined && typeof v.retentionMarginApplied !== 'boolean') {
        errors.push('AccountPlan.retentionMarginApplied must be boolean');
    }
    if (!Array.isArray(v.steps)) {
        errors.push('AccountPlan.steps must be an array');
    } else {
        if (v.steps.length > MAX_ACCOUNT_PLAN_STEPS) {
            errors.push(`AccountPlan.steps exceeds MAX_ACCOUNT_PLAN_STEPS (${MAX_ACCOUNT_PLAN_STEPS})`);
        }
        if (v.steps.length === 0 && !isNonEmptyStr(v.idleReason)) {
            errors.push('AccountPlan with empty steps requires non-empty idleReason');
        }
        v.steps.forEach((step, idx) => {
            for (const err of validatePlannedStep(step)) errors.push(`steps[${idx}]: ${err}`);
        });
    }
    return errors;
}

export const isAccountPlan = (v: unknown): v is AccountPlan => validateAccountPlan(v).length === 0;

export function validateTransferOrder(v: unknown): string[] {
    if (!isPlainRecord(v)) return ['TransferOrder must be an object'];
    const errors: string[] = [];
    if (!isNonEmptyStr(v.id)) errors.push('TransferOrder.id must be non-empty');
    if (!isNonEmptyStr(v.server)) errors.push('TransferOrder.server must be non-empty');
    if (!isAccountName(v.from)) errors.push('TransferOrder.from invalid');
    if (!isAccountName(v.to)) errors.push('TransferOrder.to invalid');
    if (typeof v.from === 'string' && typeof v.to === 'string' && v.from.toLowerCase() === v.to.toLowerCase()) {
        errors.push('TransferOrder cannot self-transfer (from === to)');
    }
    if (!isHubBankId(v.hub)) errors.push(`TransferOrder.hub must be varrock_west or ardougne (got ${String(v.hub)})`);
    if (v.hubBanker !== undefined && !isAccountName(v.hubBanker)) errors.push('TransferOrder.hubBanker invalid');
    if (!isNonEmptyStr(v.demandId)) errors.push('TransferOrder.demandId must be non-empty');
    if (!isNonEmptyStr(v.reason)) errors.push('TransferOrder.reason must be non-empty');
    if (!isFinitePos(v.createdAt)) errors.push('TransferOrder.createdAt must be finite positive');
    if (!isFinitePos(v.expiresAt)) errors.push('TransferOrder.expiresAt must be finite positive');
    if (isFinitePos(v.createdAt) && isFinitePos(v.expiresAt) && v.expiresAt <= v.createdAt) {
        errors.push('TransferOrder.expiresAt must be strictly after createdAt');
    }
    if (!isTransferOrderState(v.state)) errors.push(`invalid TransferOrder.state: ${String(v.state)}`);
    if (typeof v.bothIdleVerified !== 'boolean') errors.push('TransferOrder.bothIdleVerified must be boolean');
    if (!isFiniteNonNeg(v.donorLogoutConfirmedAt)) errors.push('TransferOrder.donorLogoutConfirmedAt must be finite non-negative');
    if (!isFiniteNonNeg(v.recipientLogoutConfirmedAt)) errors.push('TransferOrder.recipientLogoutConfirmedAt must be finite non-negative');

    if (!Array.isArray(v.items) || v.items.length === 0 || v.items.length > MAX_ORDER_LINES) {
        errors.push(`TransferOrder.items must contain 1..${MAX_ORDER_LINES} lines`);
    } else {
        const seen = new Set<number>();
        v.items.forEach((line, idx) => {
            if (!isPlainRecord(line) || !isNonNegInt(line.itemId) || !isPosInt(line.count)
                || (line.itemName !== undefined && !isNonEmptyStr(line.itemName))) {
                errors.push(`TransferOrder.items[${idx}] invalid`);
            } else {
                if (seen.has(line.itemId)) errors.push(`TransferOrder.items duplicate itemId ${line.itemId}`);
                seen.add(line.itemId);
            }
        });
    }

    if (!isPlainRecord(v.antiPingPong)) {
        errors.push('TransferOrder.antiPingPong must be an object');
    } else {
        if (typeof v.antiPingPong.donorHoldsDemandForItems !== 'boolean') {
            errors.push('antiPingPong.donorHoldsDemandForItems must be boolean');
        }
        if (!isFiniteNonNeg(v.antiPingPong.cooldownWindowMs)) {
            errors.push('antiPingPong.cooldownWindowMs must be finite non-negative');
        }
        if (v.antiPingPong.donorRecentReceivedAt !== undefined && !isFinitePos(v.antiPingPong.donorRecentReceivedAt)) {
            errors.push('antiPingPong.donorRecentReceivedAt must be finite positive');
        }
    }
    return errors;
}

export const isTransferOrder = (v: unknown): v is TransferOrder => validateTransferOrder(v).length === 0;

export function canScheduleTransferOrder(
    order: TransferOrder,
    donor: AccountState,
    recipient: AccountState,
    opts: {
        now: number;
        donorLogoutState?: 'confirmed' | 'none' | 'held' | 'invalid';
        recipientLogoutState?: 'confirmed' | 'none' | 'held' | 'invalid';
        donorDemandItemIds?: ReadonlySet<number>;
    },
): { ok: boolean; reasons: string[] } {
    const reasons = validateTransferOrder(order);
    if (donor.name.toLowerCase() !== order.from.toLowerCase()) reasons.push('donor account mismatch');
    if (recipient.name.toLowerCase() !== order.to.toLowerCase()) reasons.push('recipient account mismatch');
    if (donor.lifecycle !== 'idle') reasons.push(`donor must be idle (is ${donor.lifecycle})`);
    if (recipient.lifecycle !== 'idle') reasons.push(`recipient must be idle (is ${recipient.lifecycle})`);
    if (donor.protectedClock) reasons.push('protectedClock donor cannot participate in automated fleet trade');
    if (recipient.protectedClock) reasons.push('protectedClock recipient cannot participate in automated fleet trade');
    if (!order.bothIdleVerified) reasons.push('bothIdleVerified must be true');
    if (order.donorLogoutConfirmedAt <= 0 || (opts.donorLogoutState !== undefined && opts.donorLogoutState !== 'confirmed')) {
        reasons.push('donor logout proof is not confirmed');
    }
    if (order.recipientLogoutConfirmedAt <= 0 || (opts.recipientLogoutState !== undefined && opts.recipientLogoutState !== 'confirmed')) {
        reasons.push('recipient logout proof is not confirmed');
    }
    if (order.antiPingPong.donorHoldsDemandForItems) {
        reasons.push('anti-ping-pong: donor holds demand for transferred item(s)');
    }
    if (opts.donorDemandItemIds) {
        for (const line of order.items) {
            if (opts.donorDemandItemIds.has(line.itemId)) {
                reasons.push(`anti-ping-pong: donor holds demand for itemId ${line.itemId}`);
            }
        }
    }
    if (order.antiPingPong.donorRecentReceivedAt !== undefined
        && opts.now - order.antiPingPong.donorRecentReceivedAt < order.antiPingPong.cooldownWindowMs) {
        reasons.push('anti-ping-pong: donor recently received item(s) inside cooldown window');
    }
    if (!Number.isFinite(opts.now) || opts.now >= order.expiresAt) {
        reasons.push('transfer order expired');
    }
    return { ok: reasons.length === 0, reasons };
}

export function validateFleetPlan(v: unknown): string[] {
    if (!isPlainRecord(v)) return ['FleetPlan must be an object'];
    const errors: string[] = [];
    if (v.schemaVersion !== 1) errors.push('FleetPlan.schemaVersion must be 1');
    if (!isFinitePos(v.plannedAt)) errors.push('FleetPlan.plannedAt must be finite positive');
    if (!isSide(v.side)) errors.push('FleetPlan.side invalid');
    if (!isNonNegInt(v.maxBots)) errors.push('FleetPlan.maxBots must be non-negative integer');
    if (!isFiniteNonNeg(v.retentionMarginRatio)) errors.push('FleetPlan.retentionMarginRatio must be finite non-negative');
    if (!isNonNegInt(v.selectedSlots)) errors.push('FleetPlan.selectedSlots must be non-negative integer');
    if (isNonNegInt(v.selectedSlots) && isNonNegInt(v.maxBots) && v.selectedSlots > v.maxBots) {
        errors.push('FleetPlan.selectedSlots cannot exceed maxBots');
    }

    if (!Array.isArray(v.recoveryQueue)) {
        errors.push('FleetPlan.recoveryQueue must be an array');
    } else {
        v.recoveryQueue.forEach((entry, i) => {
            if (!isPlainRecord(entry) || !isAccountName(entry.account)
                || (entry.lifecycle !== 'needs_logout_recovery' && entry.lifecycle !== 'needs_location_recovery')
                || !isFiniteNonNeg(entry.priorityValue)) {
                errors.push(`recoveryQueue[${i}] invalid`);
            }
        });
    }

    if (!isPlainRecord(v.accountPlans)) {
        errors.push('FleetPlan.accountPlans must be an object');
    } else {
        for (const [k, plan] of Object.entries(v.accountPlans)) {
            for (const err of validateAccountPlan(plan)) errors.push(`accountPlans["${k}"]: ${err}`);
        }
    }

    if (!Array.isArray(v.transferOrders)) {
        errors.push('FleetPlan.transferOrders must be an array');
    } else {
        v.transferOrders.forEach((o, i) => {
            for (const err of validateTransferOrder(o)) errors.push(`transferOrders[${i}]: ${err}`);
        });
    }

    if (!isPlainRecord(v.spotAllocations)) {
        errors.push('FleetPlan.spotAllocations must be an object');
    } else {
        for (const [spotId, list] of Object.entries(v.spotAllocations)) {
            if (!isNonEmptyStr(spotId) || !Array.isArray(list) || !list.every(isAccountName)) {
                errors.push(`spotAllocations["${spotId}"] invalid`);
            }
        }
    }
    return errors;
}

export const isFleetPlan = (v: unknown): v is FleetPlan => validateFleetPlan(v).length === 0;

// ============================================================================
// Section 3.5 Validators: DefectRecord, FleetState, OperatorCommand
// ============================================================================

export function validateDefectRecord(v: unknown): string[] {
    if (!isPlainRecord(v)) return ['DefectRecord must be an object'];
    const errors: string[] = [];
    if (!isNonEmptyStr(v.id)) errors.push('DefectRecord.id must be non-empty');
    if (!isNonEmptyStr(v.activityId)) errors.push('DefectRecord.activityId must be non-empty');
    if (!isNonEmptyStr(v.faultSignature)) errors.push('DefectRecord.faultSignature must be non-empty');
    if (v.outcomeKind !== 'worker_defect' && v.outcomeKind !== 'death') errors.push('DefectRecord.outcomeKind invalid');
    if (!isAccountName(v.account)) errors.push('DefectRecord.account invalid');
    if (!isFinitePos(v.observedAt)) errors.push('DefectRecord.observedAt must be finite positive');
    if (!isFinitePos(v.quarantinedAt)) errors.push('DefectRecord.quarantinedAt must be finite positive');
    if (v.expiresAt !== undefined && (!isFinitePos(v.expiresAt) || (isFinitePos(v.quarantinedAt) && v.expiresAt <= v.quarantinedAt))) {
        errors.push('DefectRecord.expiresAt must be strictly after quarantinedAt');
    }
    if (typeof v.quarantined !== 'boolean') errors.push('DefectRecord.quarantined must be boolean');
    if (v.workerRelease !== undefined && !isNonEmptyStr(v.workerRelease)) errors.push('DefectRecord.workerRelease must be non-empty');
    if (!isNonEmptyStr(v.logPath)) errors.push('DefectRecord.logPath must be non-empty');
    if (v.tickRecordPath !== undefined && !isNonEmptyStr(v.tickRecordPath)) errors.push('DefectRecord.tickRecordPath must be non-empty');
    if (!isNonEmptyStr(v.detail)) errors.push('DefectRecord.detail must be non-empty');
    if (!isPosInt(v.count)) errors.push('DefectRecord.count must be a positive integer');
    return errors;
}

export const isDefectRecord = (v: unknown): v is DefectRecord => validateDefectRecord(v).length === 0;

export function validateFleetState(v: unknown): string[] {
    if (!isPlainRecord(v)) return ['FleetState must be an object'];
    const errors: string[] = [];
    if (v.schemaVersion !== FLEET_STATE_SCHEMA_VERSION) errors.push(`FleetState.schemaVersion must be ${FLEET_STATE_SCHEMA_VERSION}`);
    if (!isFinitePos(v.emittedAt)) errors.push('FleetState.emittedAt must be finite positive');
    if (!isSide(v.side)) errors.push('FleetState.side invalid');
    if (!isNonEmptyStr(v.server)) errors.push('FleetState.server must be non-empty');
    if (!isNonNegInt(v.maxBots)) errors.push('FleetState.maxBots must be non-negative integer');

    if (v.infraCircuitBreaker !== undefined) {
        const b = v.infraCircuitBreaker;
        if (!isPlainRecord(b) || typeof b.open !== 'boolean' || !isNonNegInt(b.consecutiveFaults)
            || (b.trippedAt !== undefined && !isFinitePos(b.trippedAt))
            || (b.retryAt !== undefined && !isFinitePos(b.retryAt))
            || (b.reason !== undefined && !isNonEmptyStr(b.reason))) {
            errors.push('FleetState.infraCircuitBreaker invalid');
        }
    }

    if (!isPlainRecord(v.accounts)) errors.push('FleetState.accounts must be an object');
    else for (const [k, a] of Object.entries(v.accounts)) {
        for (const err of validateAccountState(a)) errors.push(`accounts["${k}"]: ${err}`);
    }

    if (!isPlainRecord(v.activeChains)) errors.push('FleetState.activeChains must be an object');
    else for (const [k, plan] of Object.entries(v.activeChains)) {
        for (const err of validateAccountPlan(plan)) errors.push(`activeChains["${k}"]: ${err}`);
    }

    if (!isPlainRecord(v.idleReasons)) errors.push('FleetState.idleReasons must be an object');
    else for (const [k, reason] of Object.entries(v.idleReasons)) {
        if (!isAccountName(k) || !isNonEmptyStr(reason)) errors.push(`idleReasons["${k}"] must map account to non-empty reason`);
    }

    if (!Array.isArray(v.goals)) errors.push('FleetState.goals must be an array');
    else v.goals.forEach((g, i) => { for (const err of validateGoalDemand(g)) errors.push(`goals[${i}]: ${err}`); });

    if (!Array.isArray(v.campaigns)) errors.push('FleetState.campaigns must be an array');
    else v.campaigns.forEach((c, i) => { for (const err of validateCampaign(c)) errors.push(`campaigns[${i}]: ${err}`); });

    if (!Array.isArray(v.missions)) errors.push('FleetState.missions must be an array');
    else v.missions.forEach((m, i) => { for (const err of validateMission(m)) errors.push(`missions[${i}]: ${err}`); });

    if (!Array.isArray(v.pendingTransfers)) errors.push('FleetState.pendingTransfers must be an array');
    else v.pendingTransfers.forEach((t, i) => { for (const err of validateTransferOrder(t)) errors.push(`pendingTransfers[${i}]: ${err}`); });

    if (!Array.isArray(v.quarantinedDefects)) errors.push('FleetState.quarantinedDefects must be an array');
    else v.quarantinedDefects.forEach((d, i) => { for (const err of validateDefectRecord(d)) errors.push(`quarantinedDefects[${i}]: ${err}`); });

    if (v.rateStats !== undefined) {
        if (!isPlainRecord(v.rateStats)) errors.push('FleetState.rateStats must be an object');
        else for (const [id, r] of Object.entries(v.rateStats)) {
            if (!isNonEmptyStr(id) || !isPlainRecord(r) || !isPosInt(r.samples) || !isFiniteNonNeg(r.xpPerTick)
                || !isFiniteNonNeg(r.unitsPerTick) || typeof r.gpPerTick !== 'number' || !Number.isFinite(r.gpPerTick)) {
                errors.push(`rateStats["${id}"] invalid`);
            }
        }
    }
    return errors;
}

export const isFleetState = (v: unknown): v is FleetState => validateFleetState(v).length === 0;

export function validateOperatorCommand(v: unknown): string[] {
    if (!isPlainRecord(v)) return ['OperatorCommand must be an object'];
    const errors: string[] = [];
    if (v.schemaVersion !== 1) errors.push('OperatorCommand.schemaVersion must be 1');
    if (!isNonEmptyStr(v.id)) errors.push('OperatorCommand.id must be non-empty');
    if (!isFinitePos(v.issuedAt)) errors.push('OperatorCommand.issuedAt must be finite positive');
    if (!isNonEmptyStr(v.issuedBy)) errors.push('OperatorCommand.issuedBy must be non-empty');
    if (v.reason !== undefined && typeof v.reason !== 'string') errors.push('OperatorCommand.reason must be a string');

    switch (v.kind) {
        case 'pause_account':
            if (!isAccountName(v.account)) errors.push('pause_account.account invalid');
            break;
        case 'resume_account':
            if (!isAccountName(v.account)) errors.push('resume_account.account invalid');
            if (v.clearDead !== undefined && typeof v.clearDead !== 'boolean') errors.push('resume_account.clearDead must be boolean');
            break;
        case 'pause_side':
        case 'resume_side':
            if (!isSide(v.side)) errors.push(`${v.kind}.side invalid`);
            break;
        case 'override_account':
            if (!isAccountName(v.account)) errors.push('override_account.account invalid');
            if (v.activityId !== undefined && v.activityId !== null && !isNonEmptyStr(v.activityId)) {
                errors.push('override_account.activityId must be non-empty or null');
            }
            if (v.role !== undefined && !isAccountRole(v.role)) errors.push('override_account.role invalid');
            if (!isFinitePos(v.expiresAt) || (isFinitePos(v.issuedAt) && v.expiresAt <= v.issuedAt)) {
                errors.push('override_account.expiresAt must be strictly after issuedAt');
            }
            break;
        case 'clear_defect':
            if (v.defectId !== undefined && !isNonEmptyStr(v.defectId)) errors.push('clear_defect.defectId invalid');
            if (!isNonEmptyStr(v.activityId)) errors.push('clear_defect.activityId must be non-empty');
            if (v.faultSignature !== undefined && !isNonEmptyStr(v.faultSignature)) errors.push('clear_defect.faultSignature invalid');
            break;
        case 'set_campaign_state':
            if (!isNonEmptyStr(v.campaignId)) errors.push('set_campaign_state.campaignId must be non-empty');
            if (!isCampaignState(v.state)) errors.push('set_campaign_state.state invalid');
            break;
        case 'upsert_campaign':
            for (const err of validateCampaign(v.campaign)) errors.push(`upsert_campaign.campaign: ${err}`);
            break;
        case 'set_mission_state':
            if (!isNonEmptyStr(v.missionId)) errors.push('set_mission_state.missionId must be non-empty');
            if (!isMissionState(v.state)) errors.push('set_mission_state.state invalid');
            break;
        case 'upsert_mission':
            for (const err of validateMission(v.mission)) errors.push(`upsert_mission.mission: ${err}`);
            break;
        default:
            errors.push(`unknown OperatorCommand.kind: ${String(v.kind)}`);
    }
    return errors;
}

export const isOperatorCommand = (v: unknown): v is OperatorCommand => validateOperatorCommand(v).length === 0;
