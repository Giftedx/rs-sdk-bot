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
import { isNoRouteFact, type NoRouteFact } from './no-route';

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

export type { NoRouteFact };

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
    readonly noRoutes?: readonly NoRouteFact[];
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
    // Settled trades inside the received-item hold (packages/brain/src/transfer-memory.ts): each recipient keeps
    // what it received, and the scheduler does not plan it as a donor of those items.
    readonly recentTransfers?: readonly TransferOrder[];
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
    // Inputs only: units the worker leaves in the bank and never uses. Preflight needs this many on top of the batch.
    readonly reserve?: number;
    // Inputs only: items that replace this input, such as a fire staff for fire runes. An account that owns one
    // needs none of this input.
    readonly unlessOwned?: readonly number[];
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

// The map keeps each dungeon 6400 tiles north of the land above it (Taverley Dungeon 2884,9798 under 2884,3398).
export const UNDERGROUND_Z_OFFSET = 6400;
// The hub bank nearest a tile: Chebyshev distance plus 100 a floor. A dungeon tile counts as the land tile above it;
// its raw z is about 6400 from every bank, which would make the bank with the largest z the nearest to every dungeon.
export function nearestHubBank(pos: { x: number; z: number; level: number } | null | undefined, fallback: HubBankId = 'varrock_west'): HubBankId {
    return hubBanksByDistance(pos, fallback)[0]!;
}
// Every hub bank, nearest first by the same distance as nearestHubBank. An unknown tile puts the fallback first.
export function hubBanksByDistance(pos: { x: number; z: number; level: number } | null | undefined, fallback: HubBankId = 'varrock_west'): HubBankId[] {
    const ids = Object.keys(HUB_BANKER_LOCATIONS) as HubBankId[];
    if (!pos) return [fallback, ...ids.filter(id => id !== fallback)];
    const z = pos.z >= UNDERGROUND_Z_OFFSET ? pos.z - UNDERGROUND_Z_OFFSET : pos.z;
    const dist = (id: HubBankId) => {
        const t = HUB_BANKER_LOCATIONS[id].bankTile;
        return Math.max(Math.abs(pos.x - t.x), Math.abs(z - t.z)) + Math.abs(pos.level - t.level) * 100;
    };
    return ids.map(id => ({ id, d: dist(id) })).sort((a, b) => a.d - b.d).map(e => e.id);
}

export interface AcquireStep {
    readonly stepKind: 'acquire';
    readonly source: AcquireSourceKind;
    readonly itemId: number;
    readonly itemName?: string;
    readonly quantity: number;
    // The pack and bank total of the item that meets the consumer's need. A rerun of the
    // chain that finds this total owned buys nothing.
    readonly stockTarget?: number;
    // The pack and bank count of the item when the plan was made.
    readonly ownedBefore?: number;
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
    readonly shopId?: string;
    readonly donorAccount?: string;
    readonly hub?: HubBankId;
    readonly transferOrderId?: string;
    readonly activityId?: string;
    readonly estimatedCoinCost?: number;
    readonly coinFloatPreserved?: number;
}

export interface UnlockPlannedStep {
    readonly stepKind: 'unlock';
    readonly unlockKind: 'quest' | 'skill';
    readonly activityId: string;
    readonly questSlug?: string;
    readonly skill?: string;
    readonly targetLevel?: number;
    // The units of a skill unlock train activity with inputs: enough for the XP to targetLevel.
    // The plan holds the inputs for them, in the bank or bought by an earlier step.
    readonly batchUnits?: number;
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
    // Planned accounts whose job the controller will not start, with its reason. They count in no slot.
    readonly heldAccounts?: Readonly<Record<string, string>>;
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
    // The base Hitpoints and Defence of the account that died (a death defect). After the fleet-wide hold the defect
    // still holds the activity for every account that is no stronger in both (planner.ts deathClassBlocks).
    readonly deathLevels?: DeathLevels;
}

export interface DeathLevels {
    readonly hitpoints: number;
    readonly defence: number;
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
    // Active chains whose job the controller will not start (FleetPlan.heldAccounts).
    readonly heldAccounts?: Readonly<Record<string, string>>;
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
const COINS_ITEM_ID = 995;
const PROTECTED_SET = new Set(RESERVED_ACCOUNTS.map((n) => n.toLowerCase()));

const ACCOUNT_LIFECYCLE_SET: ReadonlySet<string> = new Set(ACCOUNT_LIFECYCLES);
const ACCOUNT_ROLE_SET: ReadonlySet<string> = new Set(ACCOUNT_ROLES);
const SYSTEM_HOLD_KIND_SET: ReadonlySet<string> = new Set(SYSTEM_HOLD_KINDS);
const GOAL_KIND_SET: ReadonlySet<string> = new Set(GOAL_KINDS);
const CAMPAIGN_STATE_SET: ReadonlySet<string> = new Set(CAMPAIGN_STATES);
const MISSION_STATE_SET: ReadonlySet<string> = new Set(MISSION_STATES);
const ACQUIRE_SOURCE_SET: ReadonlySet<string> = new Set(ACQUIRE_SOURCE_ORDER);
const TRANSFER_ORDER_STATE_SET: ReadonlySet<string> = new Set(TRANSFER_ORDER_STATES);
const OPERATOR_COMMAND_KIND_SET: ReadonlySet<string> = new Set(OPERATOR_COMMAND_KINDS);

const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyStr = (v: unknown): v is string => {
    if (typeof v !== 'string') return false;
    const len = v.length;
    if (len === 0) return false;
    if (v.charCodeAt(0) > 32 && v.charCodeAt(len - 1) > 32) return true;
    return v.trim().length > 0;
};
const isItemKey = (k: string): boolean => {
    const len = k.length;
    if (len === 0) return false;
    const c0 = k.charCodeAt(0);
    if (len === 1) return c0 >= 48 && c0 <= 57;
    if (c0 < 49 || c0 > 57) return false;
    for (let i = 1; i < len; i++) {
        const c = k.charCodeAt(i);
        if (c < 48 || c > 57) return false;
    }
    return true;
};
const isAccountName = (v: unknown): v is string => {
    if (typeof v !== 'string') return false;
    const len = v.length;
    if (len === 0 || len > 12) return false;
    for (let i = 0; i < len; i++) {
        const c = v.charCodeAt(i);
        if (
            (c >= 65 && c <= 90)
            || (c >= 97 && c <= 122)
            || (c >= 48 && c <= 57)
            || c === 95
            || c === 32
            || c === 45
        ) {
            continue;
        }
        return false;
    }
    return true;
};
const isSide = (v: unknown): v is string => typeof v === 'string' && SIDE_NAME.test(v);
const isNonNegInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isPosInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const isFiniteNonNeg = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isFinitePos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

function checkItemCountMap(raw: unknown, label: string, errors: string[], allowZero = false, prefix = ''): void {
    if (!isPlainRecord(raw)) {
        errors.push(`${prefix}${label} must be an object`);
        return;
    }
    for (const k in raw) {
        if (!Object.hasOwn(raw, k)) continue;
        const count = raw[k];
        if (!isItemKey(k)) errors.push(`${prefix}${label} has invalid itemId key "${k}"`);
        if (allowZero ? !isNonNegInt(count) : !isPosInt(count)) {
            errors.push(`${prefix}${label}[${k}] count must be a ${allowZero ? 'non-negative' : 'positive'} integer`);
        }
    }
}

function checkCooldownMap(raw: unknown, label: string, errors: string[], prefix = ''): void {
    if (!isPlainRecord(raw)) {
        errors.push(`${prefix}${label} must be an object`);
        return;
    }
    for (const k in raw) {
        if (!Object.hasOwn(raw, k)) continue;
        const expiresAt = raw[k];
        if (!isNonEmptyStr(k)) errors.push(`${prefix}${label} key must be non-empty`);
        if (!isFinitePos(expiresAt)) errors.push(`${prefix}${label}["${k}"] must have a finite positive expiry timestamp`);
    }
}

function checkPositiveIntMap(raw: unknown, label: string, errors: string[], maxVal?: number, prefix = ''): void {
    if (!isPlainRecord(raw)) {
        errors.push(`${prefix}${label} must be an object`);
        return;
    }
    for (const k in raw) {
        if (!Object.hasOwn(raw, k)) continue;
        const val = raw[k];
        if (!isNonEmptyStr(k)) errors.push(`${prefix}${label} key must be non-empty`);
        if (!isPosInt(val) || (maxVal !== undefined && (val as number) > maxVal)) {
            errors.push(`${prefix}${label}["${k}"] is out of range`);
        }
    }
}

// ============================================================================
// Type Guards for Closed Vocabularies
// ============================================================================

export const isAccountLifecycle = (v: unknown): v is AccountLifecycle =>
    typeof v === 'string' && ACCOUNT_LIFECYCLE_SET.has(v);

export const isAccountRole = (v: unknown): v is AccountRole =>
    typeof v === 'string' && ACCOUNT_ROLE_SET.has(v);

export const isSystemHoldKind = (v: unknown): v is SystemHoldKind =>
    typeof v === 'string' && SYSTEM_HOLD_KIND_SET.has(v);

export const isGoalKind = (v: unknown): v is GoalKind =>
    typeof v === 'string' && GOAL_KIND_SET.has(v);

export const isCampaignState = (v: unknown): v is CampaignState =>
    typeof v === 'string' && CAMPAIGN_STATE_SET.has(v);

export const isMissionState = (v: unknown): v is MissionState =>
    typeof v === 'string' && MISSION_STATE_SET.has(v);

export const isAcquireSourceKind = (v: unknown): v is AcquireSourceKind =>
    typeof v === 'string' && ACQUIRE_SOURCE_SET.has(v);

export const isHubBankId = (v: unknown): v is HubBankId =>
    typeof v === 'string' && Object.hasOwn(HUB_BANKER_LOCATIONS, v);

export const isTransferOrderState = (v: unknown): v is TransferOrderState =>
    typeof v === 'string' && TRANSFER_ORDER_STATE_SET.has(v);

export const isOperatorCommandKind = (v: unknown): v is OperatorCommandKind =>
    typeof v === 'string' && OPERATOR_COMMAND_KIND_SET.has(v);

// ============================================================================
// Section 3.1 Helpers: Protected Clocks, Offline Bank Trust, TTL Holds, Recovery
// ============================================================================

export function isProtectedAccountName(name: string): boolean {
    const len = name.length;
    if (len > 0 && name.charCodeAt(0) > 32 && name.charCodeAt(len - 1) > 32) {
        return PROTECTED_SET.has(name.toLowerCase());
    }
    return PROTECTED_SET.has(name.trim().toLowerCase());
}

export function lifecycleAutoExpires(lifecycle: AccountLifecycle): boolean {
    return lifecycle !== 'paused_owner' && lifecycle !== 'dead';
}

export const canAutoClearLifecycle = lifecycleAutoExpires;

function pushSystemHoldErrors(v: unknown, errors: string[], prefix = ''): void {
    if (!isPlainRecord(v)) {
        errors.push(`${prefix}SystemHold must be an object`);
        return;
    }
    if (!isSystemHoldKind(v.kind)) errors.push(`${prefix}invalid SystemHold kind: ${String(v.kind)}`);
    if (!isNonEmptyStr(v.key)) errors.push(`${prefix}SystemHold.key must be non-empty`);
    if (!isNonEmptyStr(v.reason)) errors.push(`${prefix}SystemHold.reason must be non-empty`);
    if (!isFinitePos(v.createdAt)) errors.push(`${prefix}SystemHold.createdAt must be a finite positive timestamp`);
    if (!isFinitePos(v.expiresAt)) errors.push(`${prefix}SystemHold.expiresAt must be a finite positive timestamp`);
    if (isFinitePos(v.createdAt) && isFinitePos(v.expiresAt) && v.expiresAt <= v.createdAt) {
        errors.push(`${prefix}SystemHold.expiresAt must be strictly after createdAt`);
    }
}

export function validateSystemHold(v: unknown): string[] {
    const errors: string[] = [];
    pushSystemHoldErrors(v, errors);
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
    for (const k in cooldowns) {
        if (!Object.hasOwn(cooldowns, k)) continue;
        const expiresAt = cooldowns[k];
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
        for (const idStr in items) {
            if (!Object.hasOwn(items, idStr)) continue;
            const count = items[idStr as unknown as number]!;
            if (!Number.isFinite(count) || count <= 0) continue;
            const id = Number(idStr);
            if (id === COINS_ITEM_ID) total += count;
            else {
                const price = itemPrices[id];
                if (price && Number.isFinite(price)) total += count * price;
            }
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

function pushAccountStateErrors(v: unknown, errors: string[], prefix = ''): void {
    if (!isPlainRecord(v)) {
        errors.push(`${prefix}AccountState must be an object`);
        return;
    }
    if (!isAccountName(v.name)) errors.push(`${prefix}invalid account name: ${String(v.name)}`);
    if (!isSide(v.side)) errors.push(`${prefix}invalid side: ${String(v.side)}`);
    if (!isAccountRole(v.role)) errors.push(`${prefix}invalid role: ${String(v.role)}`);
    if (typeof v.protectedClock !== 'boolean') errors.push(`${prefix}protectedClock must be a boolean`);
    if (typeof v.name === 'string' && typeof v.protectedClock === 'boolean') {
        if ((v.role === 'main' || v.role === 'specialist' || isProtectedAccountName(v.name)) && !v.protectedClock) {
            errors.push(`${prefix}protected/reserved accounts must set protectedClock=true`);
        }
        if (v.role === 'main' && v.name !== 'Haggis' && v.name !== 'haggis' && v.name.toLowerCase() !== 'haggis') {
            errors.push(`${prefix}role "main" is reserved for Haggis`);
        }
    }
    if (v.maxLevels !== undefined) checkPositiveIntMap(v.maxLevels, 'maxLevels', errors, 99, prefix);
    if (!isAccountLifecycle(v.lifecycle)) errors.push(`${prefix}invalid lifecycle: ${String(v.lifecycle)}`);

    if (!isPlainRecord(v.skills)) {
        errors.push(`${prefix}skills must be an object`);
    } else {
        for (const skill in v.skills) {
            if (!Object.hasOwn(v.skills, skill)) continue;
            const stat = v.skills[skill];
            if (!isNonEmptyStr(skill)) errors.push(`${prefix}skills key must be non-empty`);
            if (!isPlainRecord(stat) || !isPosInt(stat.level) || !isFiniteNonNeg(stat.xp)) {
                errors.push(`${prefix}skills["${skill}"] must have positive integer level and non-negative xp`);
            }
        }
    }

    if (!isPlainRecord(v.quests)) {
        errors.push(`${prefix}quests must be an object`);
    } else {
        for (const slug in v.quests) {
            if (!Object.hasOwn(v.quests, slug)) continue;
            const qState = v.quests[slug];
            if (!isNonEmptyStr(slug)) errors.push(`${prefix}quests key must be non-empty`);
            if (!isWorkerQuestState(qState)) errors.push(`${prefix}quests["${slug}"] invalid state: ${String(qState)}`);
        }
    }

    if (v.pos !== null && !isWorkerTile(v.pos)) errors.push(`${prefix}pos must be a valid tile or null`);
    checkItemCountMap(v.inventory, 'inventory', errors, false, prefix);
    checkItemCountMap(v.equipment, 'equipment', errors, false, prefix);

    if (!isPlainRecord(v.bank)) {
        errors.push(`${prefix}bank must be an object`);
    } else {
        checkItemCountMap(v.bank.items, 'bank.items', errors, false, prefix);
        if (!isFiniteNonNeg(v.bank.observedAt)) errors.push(`${prefix}bank.observedAt must be finite non-negative`);
        if (typeof v.bank.trusted !== 'boolean') errors.push(`${prefix}bank.trusted must be a boolean`);
        if (v.bank.observedAt === 0 && v.bank.trusted === true) {
            errors.push(`${prefix}unobserved bank (observedAt=0) cannot have trusted=true`);
        }
        if (v.lastLoginAttemptAt !== undefined) {
            if (!isFinitePos(v.lastLoginAttemptAt)) errors.push(`${prefix}lastLoginAttemptAt must be finite positive`);
            else if (isFiniteNonNeg(v.bank.observedAt) && v.lastLoginAttemptAt > v.bank.observedAt && v.bank.trusted === true) {
                errors.push(`${prefix}bank.trusted must be false after a newer login attempt`);
            }
        }
        if (v.lastSettledTransferAt !== undefined) {
            if (!isFinitePos(v.lastSettledTransferAt)) errors.push(`${prefix}lastSettledTransferAt must be finite positive`);
            else if (isFiniteNonNeg(v.bank.observedAt) && v.lastSettledTransferAt > v.bank.observedAt && v.bank.trusted === true) {
                errors.push(`${prefix}bank.trusted must be false after a newer settled transfer`);
            }
        }
    }

    if (v.reserves !== undefined) checkItemCountMap(v.reserves, 'reserves', errors, true, prefix);
    if (v.cooldowns !== undefined) checkCooldownMap(v.cooldowns, 'cooldowns', errors, prefix);
    if (v.systemHolds !== undefined) {
        if (!Array.isArray(v.systemHolds)) errors.push(`${prefix}systemHolds must be an array`);
        else {
            const holds = v.systemHolds;
            for (let i = 0; i < holds.length; i++) {
                pushSystemHoldErrors(holds[i], errors, `${prefix}systemHolds[${i}]: `);
            }
        }
    }
    if (v.noRoutes !== undefined) {
        if (!Array.isArray(v.noRoutes)) errors.push(`${prefix}noRoutes must be an array`);
        else {
            for (let i = 0; i < v.noRoutes.length; i++) {
                if (!isNoRouteFact(v.noRoutes[i])) {
                    errors.push(`${prefix}noRoutes[${i}] must hold from, to, activityId, observedAt and expiresAt`);
                }
            }
        }
    }

    if (v.lifecycle === 'running') {
        if (!isPlainRecord(v.activeJob) || !isNonEmptyStr(v.activeJob.activityId)
            || !isNonEmptyStr(v.activeJob.demandId) || !isFinitePos(v.activeJob.startedAt)) {
            errors.push(`${prefix}running account requires valid activeJob`);
        }
    } else if (v.activeJob !== undefined) {
        errors.push(`${prefix}non-running lifecycle "${String(v.lifecycle)}" must not hold activeJob`);
    }
}

export function validateAccountState(v: unknown): string[] {
    const errors: string[] = [];
    pushAccountStateErrors(v, errors);
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
        for (const key in v.accounts) {
            if (!Object.hasOwn(v.accounts, key)) continue;
            const acct = v.accounts[key];
            pushAccountStateErrors(acct, errors, `accounts["${key}"]: `);
            if (isPlainRecord(acct) && typeof acct.name === 'string' && key !== acct.name && key.toLowerCase() !== acct.name.toLowerCase()) {
                errors.push(`accounts["${key}"] key mismatch with name "${acct.name}"`);
            }
        }
    }

    if (v.fleetSides !== undefined) {
        if (!isPlainRecord(v.fleetSides)) errors.push('fleetSides must be an object');
        else for (const k in v.fleetSides) {
            if (!Object.hasOwn(v.fleetSides, k)) continue;
            const s = v.fleetSides[k];
            if (!isSide(k) || !isPlainRecord(s) || !isSide(s.side)
                || (s.seenAt !== null && !isFinitePos(s.seenAt))
                || !isNonNegInt(s.capacity) || typeof s.stopped !== 'boolean') {
                errors.push(`fleetSides["${k}"] is invalid`);
            }
        }
    }
    if (v.reserves !== undefined) {
        if (!isPlainRecord(v.reserves)) errors.push('reserves must be an object');
        else for (const acctKey in v.reserves) {
            if (!Object.hasOwn(v.reserves, acctKey)) continue;
            const map = v.reserves[acctKey];
            if (!isAccountName(acctKey)) errors.push(`reserves key "${acctKey}" invalid`);
            checkItemCountMap(map, `reserves["${acctKey}"]`, errors, true);
        }
    }
    if (v.globalReserves !== undefined) checkItemCountMap(v.globalReserves, 'globalReserves', errors, true);
    if (v.marketCooldowns !== undefined) checkCooldownMap(v.marketCooldowns, 'marketCooldowns', errors);
    if (v.spotOccupancy !== undefined) {
        if (!isPlainRecord(v.spotOccupancy)) errors.push('spotOccupancy must be an object');
        else for (const spotId in v.spotOccupancy) {
            if (!Object.hasOwn(v.spotOccupancy, spotId)) continue;
            const cnt = v.spotOccupancy[spotId];
            if (!isNonEmptyStr(spotId) || !isNonNegInt(cnt)) errors.push(`spotOccupancy["${spotId}"] must be a non-negative integer`);
        }
    }
    if (v.geEscrowCoins !== undefined) {
        if (!isPlainRecord(v.geEscrowCoins)) errors.push('geEscrowCoins must be an object');
        else for (const acctKey in v.geEscrowCoins) {
            if (!Object.hasOwn(v.geEscrowCoins, acctKey)) continue;
            const coins = v.geEscrowCoins[acctKey];
            if (!isAccountName(acctKey) || !isNonNegInt(coins)) errors.push(`geEscrowCoins["${acctKey}"] must be a non-negative integer`);
        }
    }
    if (v.activeTransfers !== undefined) {
        if (!Array.isArray(v.activeTransfers)) errors.push('activeTransfers must be an array');
        else {
            const list = v.activeTransfers;
            for (let i = 0; i < list.length; i++) {
                pushTransferOrderErrors(list[i], errors, `activeTransfers[${i}]: `);
            }
        }
    }
    if (v.recentTransfers !== undefined) {
        if (!Array.isArray(v.recentTransfers)) errors.push('recentTransfers must be an array');
        else {
            const list = v.recentTransfers;
            for (let i = 0; i < list.length; i++) {
                pushTransferOrderErrors(list[i], errors, `recentTransfers[${i}]: `);
            }
        }
    }
    return errors;
}

export const isWorldSnapshot = (v: unknown): v is WorldSnapshot => validateWorldSnapshot(v).length === 0;

// ============================================================================
// Section 3.3 Validators & Helpers: Demand, Campaign, Mission, Activity, Rate
// ============================================================================

function pushGoalDemandErrors(v: unknown, errors: string[], prefix = ''): void {
    if (!isPlainRecord(v)) {
        errors.push(`${prefix}GoalDemand must be an object`);
        return;
    }
    if (!isNonEmptyStr(v.id)) errors.push(`${prefix}GoalDemand.id must be non-empty`);
    if (!isGoalKind(v.goalKind)) errors.push(`${prefix}invalid GoalDemand.goalKind: ${String(v.goalKind)}`);
    if (v.sourceId !== undefined && !isNonEmptyStr(v.sourceId)) errors.push(`${prefix}GoalDemand.sourceId must be non-empty`);
    if (!isFiniteNonNeg(v.valueScore)) errors.push(`${prefix}GoalDemand.valueScore must be finite non-negative`);
    if (v.valuePerHour !== undefined && !isFiniteNonNeg(v.valuePerHour)) errors.push(`${prefix}GoalDemand.valuePerHour must be finite non-negative`);
    if (!isFiniteNonNeg(v.fulfilled)) errors.push(`${prefix}GoalDemand.fulfilled must be finite non-negative`);
    if (!isFiniteNonNeg(v.remaining)) errors.push(`${prefix}GoalDemand.remaining must be finite non-negative`);
    if (!isFiniteNonNeg(v.priorityWeight)) errors.push(`${prefix}GoalDemand.priorityWeight must be finite non-negative`);
    if (v.assignedAccount !== undefined && !isAccountName(v.assignedAccount)) errors.push(`${prefix}GoalDemand.assignedAccount invalid`);
    if (typeof v.active !== 'boolean') errors.push(`${prefix}GoalDemand.active must be a boolean`);

    if (!isPlainRecord(v.target)) {
        errors.push(`${prefix}GoalDemand.target must be an object`);
    } else {
        switch (v.target.kind) {
            case 'item':
                if (!isNonNegInt(v.target.itemId) || !isPosInt(v.target.count)) errors.push(`${prefix}target(item) invalid itemId or count`);
                if (v.target.itemName !== undefined && !isNonEmptyStr(v.target.itemName)) errors.push(`${prefix}target(item).itemName invalid`);
                if (v.target.holder !== undefined && !isAccountName(v.target.holder)) errors.push(`${prefix}target(item).holder invalid`);
                break;
            case 'skill':
                if (!isAccountName(v.target.account) || !isNonEmptyStr(v.target.skill) || !isPosInt(v.target.targetLevel) || (v.target.targetLevel as number) > 99) {
                    errors.push(`${prefix}target(skill) invalid`);
                }
                if (v.target.targetXp !== undefined && !isFiniteNonNeg(v.target.targetXp)) errors.push(`${prefix}target(skill).targetXp invalid`);
                break;
            case 'quest':
                if (!isNonEmptyStr(v.target.questSlug)) errors.push(`${prefix}target(quest).questSlug must be non-empty`);
                if (v.target.account !== undefined && !isAccountName(v.target.account)) errors.push(`${prefix}target(quest).account invalid`);
                break;
            case 'coins':
                if (!isPosInt(v.target.amount)) errors.push(`${prefix}target(coins).amount must be positive integer`);
                if (v.target.account !== undefined && !isAccountName(v.target.account)) errors.push(`${prefix}target(coins).account invalid`);
                break;
            case 'combat_readiness':
                if (!isAccountName(v.target.account)) errors.push(`${prefix}target(combat_readiness).account invalid`);
                checkPositiveIntMap(v.target.targets, 'target(combat_readiness).targets', errors, 99, prefix);
                break;
            default:
                errors.push(`${prefix}unknown GoalDemand.target kind: ${String(v.target.kind)}`);
        }
    }
}

export function validateGoalDemand(v: unknown): string[] {
    const errors: string[] = [];
    pushGoalDemandErrors(v, errors);
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
    if (campaign.state !== 'ready' && campaign.state !== 'running') return false;
    if (opts?.suppliesSatisfied === false) return false;
    if (!campaign.protectedClock) return true;
    if (campaign.rehearsalProof?.verified !== true) return false;
    if (campaign.hiscoreMargin?.meetsMargin !== true || campaign.hiscoreMargin.board !== campaign.board) {
        return false;
    }
    if (opts?.now !== undefined && !isHiscoreMarginFresh(campaign.hiscoreMargin, opts.now, opts.maxHiscoreAgeMs)) {
        return false;
    }
    return true;
}

function pushCampaignErrors(v: unknown, errors: string[], prefix = ''): void {
    if (!isPlainRecord(v)) {
        errors.push(`${prefix}Campaign must be an object`);
        return;
    }
    if (!isNonEmptyStr(v.id)) errors.push(`${prefix}Campaign.id must be non-empty`);
    if (!isAccountName(v.account)) errors.push(`${prefix}Campaign.account invalid`);
    if (typeof v.protectedClock !== 'boolean') errors.push(`${prefix}Campaign.protectedClock must be boolean`);
    if (typeof v.account === 'string' && isProtectedAccountName(v.account) && v.protectedClock !== true) {
        errors.push(`${prefix}reserved account campaign must have protectedClock=true`);
    }
    if (!isNonEmptyStr(v.board)) errors.push(`${prefix}Campaign.board must be non-empty`);
    if (!isCampaignState(v.state)) errors.push(`${prefix}invalid Campaign.state: ${String(v.state)}`);
    if (v.weight !== undefined && !isFiniteNonNeg(v.weight)) errors.push(`${prefix}Campaign.weight must be finite non-negative`);

    if (!Array.isArray(v.requiredSupplies)) {
        errors.push(`${prefix}Campaign.requiredSupplies must be an array`);
    } else {
        const list = v.requiredSupplies;
        for (let idx = 0; idx < list.length; idx++) {
            const s = list[idx];
            if (!isPlainRecord(s) || !isNonNegInt(s.itemId) || !isPosInt(s.count)
                || (s.itemName !== undefined && !isNonEmptyStr(s.itemName))
                || (s.stage !== undefined && !isNonEmptyStr(s.stage))) {
                errors.push(`${prefix}Campaign.requiredSupplies[${idx}] invalid`);
            }
        }
    }

    if (v.stagingHolder !== null) {
        if (!isAccountName(v.stagingHolder)) errors.push(`${prefix}Campaign.stagingHolder must be an account name or null`);
        else if (v.protectedClock === true && typeof v.account === 'string'
            && v.stagingHolder.toLowerCase() === v.account.toLowerCase()) {
            errors.push(`${prefix}protectedClock campaign cannot stage supplies directly on the protected account`);
        }
    }

    if (v.rehearsalProof !== null) {
        if (!isPlainRecord(v.rehearsalProof) || typeof v.rehearsalProof.verified !== 'boolean') {
            errors.push(`${prefix}Campaign.rehearsalProof invalid`);
        }
    }
    if (v.hiscoreMargin !== null) {
        if (!isPlainRecord(v.hiscoreMargin) || !isNonEmptyStr(v.hiscoreMargin.board)
            || !isPosInt(v.hiscoreMargin.rivalTicks) || !isPosInt(v.hiscoreMargin.ourTicks)
            || !Number.isSafeInteger(v.hiscoreMargin.marginTicks)
            || typeof v.hiscoreMargin.marginRatio !== 'number' || !Number.isFinite(v.hiscoreMargin.marginRatio)
            || !isFinitePos(v.hiscoreMargin.checkedAt) || typeof v.hiscoreMargin.meetsMargin !== 'boolean') {
            errors.push(`${prefix}Campaign.hiscoreMargin invalid`);
        }
    }

    if (v.protectedClock === true && (v.state === 'ready' || v.state === 'running')) {
        if (!isPlainRecord(v.rehearsalProof) || v.rehearsalProof.verified !== true) {
            errors.push(`${prefix}protectedClock campaign requires verified rehearsalProof before ready/running`);
        }
        if (!isPlainRecord(v.hiscoreMargin) || v.hiscoreMargin.meetsMargin !== true || v.hiscoreMargin.board !== v.board) {
            errors.push(`${prefix}protectedClock campaign requires passing hiscoreMargin on the campaign board before ready/running`);
        }
    }
}

export function validateCampaign(v: unknown): string[] {
    const errors: string[] = [];
    pushCampaignErrors(v, errors);
    return errors;
}

export const isCampaign = (v: unknown): v is Campaign => validateCampaign(v).length === 0;

export function missionEffectiveWeight(mission: Mission): number {
    return mission.state === 'paused' ? 0 : mission.weight;
}

function pushMissionErrors(v: unknown, errors: string[], prefix = ''): void {
    if (!isPlainRecord(v)) {
        errors.push(`${prefix}Mission must be an object`);
        return;
    }
    if (!isNonEmptyStr(v.id)) errors.push(`${prefix}Mission.id must be non-empty`);
    if (!isMissionState(v.state)) errors.push(`${prefix}invalid Mission.state: ${String(v.state)}`);
    if (!isFiniteNonNeg(v.weight)) errors.push(`${prefix}Mission.weight must be finite non-negative`);

    if (!Array.isArray(v.participants)) {
        errors.push(`${prefix}Mission.participants must be an array`);
    } else {
        const seen = new Set<string>();
        const parts = v.participants;
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            if (!isAccountName(p)) { errors.push(`${prefix}Mission.participants invalid account: ${String(p)}`); continue; }
            const lower = p.toLowerCase();
            if (seen.has(lower)) errors.push(`${prefix}Mission.participants duplicate: ${p}`);
            seen.add(lower);
        }
        if (v.state !== 'paused' && parts.length === 0) {
            errors.push(`${prefix}active Mission requires at least one participant`);
        }
    }

    if (!Array.isArray(v.kitTargets)) {
        errors.push(`${prefix}Mission.kitTargets must be an array`);
    } else {
        const list = v.kitTargets;
        for (let idx = 0; idx < list.length; idx++) {
            const k = list[idx];
            if (!isPlainRecord(k) || !isNonNegInt(k.itemId) || !isPosInt(k.countPerParticipant)
                || (k.itemName !== undefined && !isNonEmptyStr(k.itemName))
                || (k.slot !== undefined && !isNonEmptyStr(k.slot))) {
                errors.push(`${prefix}Mission.kitTargets[${idx}] invalid`);
            }
        }
    }

    if (!Array.isArray(v.consumables)) {
        errors.push(`${prefix}Mission.consumables must be an array`);
    } else {
        const list = v.consumables;
        for (let idx = 0; idx < list.length; idx++) {
            const c = list[idx];
            if (!isPlainRecord(c) || !isNonNegInt(c.itemId) || !isPosInt(c.countPerParticipant)
                || (c.minReservePerParticipant !== undefined && !isNonNegInt(c.minReservePerParticipant))
                || (c.itemName !== undefined && !isNonEmptyStr(c.itemName))) {
                errors.push(`${prefix}Mission.consumables[${idx}] invalid`);
            }
        }
    }
}

export function validateMission(v: unknown): string[] {
    const errors: string[] = [];
    pushMissionErrors(v, errors);
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
                if (
                    !isPlainRecord(io) || !isNonNegInt(io.itemId) || !isFinitePos(io.countPerUnit)
                    || (io.reserve !== undefined && (field === 'outputs' || !isNonNegInt(io.reserve)))
                ) {
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

function pushAcquireStepErrors(v: unknown, errors: string[], prefix = ''): void {
    if (!isPlainRecord(v)) {
        errors.push(`${prefix}AcquireStep must be an object`);
        return;
    }
    if (v.stepKind !== 'acquire') errors.push(`${prefix}AcquireStep.stepKind must be "acquire"`);
    if (!isAcquireSourceKind(v.source)) errors.push(`${prefix}invalid AcquireStep.source: ${String(v.source)}`);
    if (!isNonNegInt(v.itemId)) errors.push(`${prefix}AcquireStep.itemId must be non-negative integer`);
    if (v.itemName !== undefined && !isNonEmptyStr(v.itemName)) errors.push(`${prefix}AcquireStep.itemName must be non-empty`);
    if (!isPosInt(v.quantity)) errors.push(`${prefix}AcquireStep.quantity must be positive integer`);
    if (v.stockTarget !== undefined && !isPosInt(v.stockTarget)) errors.push(`${prefix}AcquireStep.stockTarget must be positive integer`);
    if (v.ownedBefore !== undefined && !isNonNegInt(v.ownedBefore)) errors.push(`${prefix}AcquireStep.ownedBefore must be non-negative integer`);
    if (!isFiniteNonNeg(v.estimatedTicks)) errors.push(`${prefix}AcquireStep.estimatedTicks must be finite non-negative`);
    if (!isFiniteNonNeg(v.estimatedCoinCost)) errors.push(`${prefix}AcquireStep.estimatedCoinCost must be finite non-negative`);
    if (!isNonNegInt(v.coinFloatPreserved)) errors.push(`${prefix}AcquireStep.coinFloatPreserved must be non-negative integer`);
    if (v.source === 'npc_shop' && v.shopId !== undefined && !isNonEmptyStr(v.shopId)) errors.push(`${prefix}shopId must be non-empty`);
    if (v.source === 'hub_banker') {
        if (v.donorAccount !== undefined && !isAccountName(v.donorAccount)) errors.push(`${prefix}donorAccount invalid`);
        if (v.hub !== undefined && !isHubBankId(v.hub)) errors.push(`${prefix}hub invalid`);
    }
}

export function validateAcquireStep(v: unknown): string[] {
    const errors: string[] = [];
    pushAcquireStepErrors(v, errors);
    return errors;
}

export const isAcquireStep = (v: unknown): v is AcquireStep => validateAcquireStep(v).length === 0;

function pushPlannedStepErrors(v: unknown, errors: string[], prefix = ''): void {
    if (!isPlainRecord(v)) {
        errors.push(`${prefix}PlannedStep must be an object`);
        return;
    }
    switch (v.stepKind) {
        case 'recover':
            if (v.recoveryKind !== 'logout' && v.recoveryKind !== 'location') errors.push(`${prefix}recover.recoveryKind invalid`);
            if (v.targetHub !== undefined && !isHubBankId(v.targetHub)) errors.push(`${prefix}recover.targetHub invalid`);
            if (!isFiniteNonNeg(v.estimatedTicks)) errors.push(`${prefix}recover.estimatedTicks must be finite non-negative`);
            if (!isNonEmptyStr(v.reason)) errors.push(`${prefix}recover.reason must be non-empty`);
            return;
        case 'acquire':
            pushAcquireStepErrors(v, errors, prefix);
            return;
        case 'gear_upgrade':
            if (!isNonNegInt(v.itemId)) errors.push(`${prefix}gear_upgrade.itemId invalid`);
            if (v.itemName !== undefined && !isNonEmptyStr(v.itemName)) errors.push(`${prefix}gear_upgrade.itemName invalid`);
            if (!isNonEmptyStr(v.slot)) errors.push(`${prefix}gear_upgrade.slot must be non-empty`);
            if (!isFinitePos(v.netXpPerTickGain)) errors.push(`${prefix}gear_upgrade.netXpPerTickGain must be finite positive`);
            if (!isFinitePos(v.remainingBandTicks)) errors.push(`${prefix}gear_upgrade.remainingBandTicks must be finite positive`);
            if (!isFiniteNonNeg(v.acquisitionTicks)) errors.push(`${prefix}gear_upgrade.acquisitionTicks must be finite non-negative`);
            if (!isFinitePos(v.paybackNetTicks)) errors.push(`${prefix}gear_upgrade.paybackNetTicks must be finite positive`);
            if (!isAcquireSourceKind(v.source)) errors.push(`${prefix}gear_upgrade.source invalid`);
            if (v.shopId !== undefined && !isNonEmptyStr(v.shopId)) errors.push(`${prefix}gear_upgrade.shopId invalid`);
            if (v.donorAccount !== undefined && !isAccountName(v.donorAccount)) errors.push(`${prefix}gear_upgrade.donorAccount invalid`);
            if (v.hub !== undefined && !isHubBankId(v.hub)) errors.push(`${prefix}gear_upgrade.hub invalid`);
            if (v.transferOrderId !== undefined && !isNonEmptyStr(v.transferOrderId)) errors.push(`${prefix}gear_upgrade.transferOrderId invalid`);
            if (v.activityId !== undefined && !isNonEmptyStr(v.activityId)) errors.push(`${prefix}gear_upgrade.activityId invalid`);
            if (v.estimatedCoinCost !== undefined && !isFiniteNonNeg(v.estimatedCoinCost)) errors.push(`${prefix}gear_upgrade.estimatedCoinCost invalid`);
            if (v.coinFloatPreserved !== undefined && !isFiniteNonNeg(v.coinFloatPreserved)) errors.push(`${prefix}gear_upgrade.coinFloatPreserved invalid`);
            return;
        case 'unlock':
            if (v.unlockKind !== 'quest' && v.unlockKind !== 'skill') errors.push(`${prefix}unlock.unlockKind invalid`);
            if (!isNonEmptyStr(v.activityId)) errors.push(`${prefix}unlock.activityId must be non-empty`);
            if (v.questSlug !== undefined && !isNonEmptyStr(v.questSlug)) errors.push(`${prefix}unlock.questSlug invalid`);
            if (v.skill !== undefined && !isNonEmptyStr(v.skill)) errors.push(`${prefix}unlock.skill invalid`);
            if (v.targetLevel !== undefined && (!isPosInt(v.targetLevel) || (v.targetLevel as number) > 99)) errors.push(`${prefix}unlock.targetLevel invalid`);
            if (v.batchUnits !== undefined && !isPosInt(v.batchUnits)) errors.push(`${prefix}unlock.batchUnits invalid`);
            if (!isFiniteNonNeg(v.estimatedTicks)) errors.push(`${prefix}unlock.estimatedTicks invalid`);
            return;
        case 'work':
            if (!isNonEmptyStr(v.activityId)) errors.push(`${prefix}work.activityId must be non-empty`);
            if (!isNonEmptyStr(v.demandId)) errors.push(`${prefix}work.demandId must be non-empty`);
            if (!isNonEmptyStr(v.workerId)) errors.push(`${prefix}work.workerId must be non-empty`);
            if (!isPosInt(v.batchUnits)) errors.push(`${prefix}work.batchUnits must be positive integer`);
            if (!isFiniteNonNeg(v.estimatedTicks)) errors.push(`${prefix}work.estimatedTicks must be finite non-negative`);
            if (!isFiniteNonNeg(v.expectedValuePerHour)) errors.push(`${prefix}work.expectedValuePerHour must be finite non-negative`);
            if (!isPlainRecord(v.config)) errors.push(`${prefix}work.config must be an object`);
            return;
        default:
            errors.push(`${prefix}unknown PlannedStep.stepKind: ${String(v.stepKind)}`);
    }
}

export function validatePlannedStep(v: unknown): string[] {
    const errors: string[] = [];
    pushPlannedStepErrors(v, errors);
    return errors;
}

export const isPlannedStep = (v: unknown): v is PlannedStep => validatePlannedStep(v).length === 0;

function pushAccountPlanErrors(v: unknown, errors: string[], prefix = ''): void {
    if (!isPlainRecord(v)) {
        errors.push(`${prefix}AccountPlan must be an object`);
        return;
    }
    if (!isAccountName(v.account)) errors.push(`${prefix}AccountPlan.account invalid`);
    if (!isFiniteNonNeg(v.scorePerHour)) errors.push(`${prefix}AccountPlan.scorePerHour must be finite non-negative`);
    if (v.demandId !== undefined && !isNonEmptyStr(v.demandId)) errors.push(`${prefix}AccountPlan.demandId must be non-empty`);
    if (v.retentionMarginApplied !== undefined && typeof v.retentionMarginApplied !== 'boolean') {
        errors.push(`${prefix}AccountPlan.retentionMarginApplied must be boolean`);
    }
    if (!Array.isArray(v.steps)) {
        errors.push(`${prefix}AccountPlan.steps must be an array`);
    } else {
        const steps = v.steps;
        if (steps.length > MAX_ACCOUNT_PLAN_STEPS) {
            errors.push(`${prefix}AccountPlan.steps exceeds MAX_ACCOUNT_PLAN_STEPS (${MAX_ACCOUNT_PLAN_STEPS})`);
        }
        if (steps.length === 0 && !isNonEmptyStr(v.idleReason)) {
            errors.push(`${prefix}AccountPlan with empty steps requires non-empty idleReason`);
        }
        for (let idx = 0; idx < steps.length; idx++) {
            pushPlannedStepErrors(steps[idx], errors, `${prefix}steps[${idx}]: `);
        }
    }
}

export function validateAccountPlan(v: unknown): string[] {
    const errors: string[] = [];
    pushAccountPlanErrors(v, errors);
    return errors;
}

export const isAccountPlan = (v: unknown): v is AccountPlan => validateAccountPlan(v).length === 0;

function pushTransferOrderErrors(v: unknown, errors: string[], prefix = ''): void {
    if (!isPlainRecord(v)) {
        errors.push(`${prefix}TransferOrder must be an object`);
        return;
    }
    if (!isNonEmptyStr(v.id)) errors.push(`${prefix}TransferOrder.id must be non-empty`);
    if (!isNonEmptyStr(v.server)) errors.push(`${prefix}TransferOrder.server must be non-empty`);
    if (!isAccountName(v.from)) errors.push(`${prefix}TransferOrder.from invalid`);
    if (!isAccountName(v.to)) errors.push(`${prefix}TransferOrder.to invalid`);
    if (typeof v.from === 'string' && typeof v.to === 'string' && v.from.toLowerCase() === v.to.toLowerCase()) {
        errors.push(`${prefix}TransferOrder cannot self-transfer (from === to)`);
    }
    if (!isHubBankId(v.hub)) errors.push(`${prefix}TransferOrder.hub must be varrock_west or ardougne (got ${String(v.hub)})`);
    if (v.hubBanker !== undefined && !isAccountName(v.hubBanker)) errors.push(`${prefix}TransferOrder.hubBanker invalid`);
    if (!isNonEmptyStr(v.demandId)) errors.push(`${prefix}TransferOrder.demandId must be non-empty`);
    if (!isNonEmptyStr(v.reason)) errors.push(`${prefix}TransferOrder.reason must be non-empty`);
    if (!isFinitePos(v.createdAt)) errors.push(`${prefix}TransferOrder.createdAt must be finite positive`);
    if (!isFinitePos(v.expiresAt)) errors.push(`${prefix}TransferOrder.expiresAt must be finite positive`);
    if (isFinitePos(v.createdAt) && isFinitePos(v.expiresAt) && v.expiresAt <= v.createdAt) {
        errors.push(`${prefix}TransferOrder.expiresAt must be strictly after createdAt`);
    }
    if (!isTransferOrderState(v.state)) errors.push(`${prefix}invalid TransferOrder.state: ${String(v.state)}`);
    if (typeof v.bothIdleVerified !== 'boolean') errors.push(`${prefix}TransferOrder.bothIdleVerified must be boolean`);
    if (!isFiniteNonNeg(v.donorLogoutConfirmedAt)) errors.push(`${prefix}TransferOrder.donorLogoutConfirmedAt must be finite non-negative`);
    if (!isFiniteNonNeg(v.recipientLogoutConfirmedAt)) errors.push(`${prefix}TransferOrder.recipientLogoutConfirmedAt must be finite non-negative`);

    if (!Array.isArray(v.items) || v.items.length === 0 || v.items.length > MAX_ORDER_LINES) {
        errors.push(`${prefix}TransferOrder.items must contain 1..${MAX_ORDER_LINES} lines`);
    } else {
        const seen = new Set<number>();
        const items = v.items;
        for (let idx = 0; idx < items.length; idx++) {
            const line = items[idx];
            if (!isPlainRecord(line) || !isNonNegInt(line.itemId) || !isPosInt(line.count)
                || (line.itemName !== undefined && !isNonEmptyStr(line.itemName))) {
                errors.push(`${prefix}TransferOrder.items[${idx}] invalid`);
            } else {
                if (seen.has(line.itemId)) errors.push(`${prefix}TransferOrder.items duplicate itemId ${line.itemId}`);
                seen.add(line.itemId);
            }
        }
    }

    if (!isPlainRecord(v.antiPingPong)) {
        errors.push(`${prefix}TransferOrder.antiPingPong must be an object`);
    } else {
        if (typeof v.antiPingPong.donorHoldsDemandForItems !== 'boolean') {
            errors.push(`${prefix}antiPingPong.donorHoldsDemandForItems must be boolean`);
        }
        if (!isFiniteNonNeg(v.antiPingPong.cooldownWindowMs)) {
            errors.push(`${prefix}antiPingPong.cooldownWindowMs must be finite non-negative`);
        }
        if (v.antiPingPong.donorRecentReceivedAt !== undefined && !isFinitePos(v.antiPingPong.donorRecentReceivedAt)) {
            errors.push(`${prefix}antiPingPong.donorRecentReceivedAt must be finite positive`);
        }
    }
}

export function validateTransferOrder(v: unknown): string[] {
    const errors: string[] = [];
    pushTransferOrderErrors(v, errors);
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
        const rq = v.recoveryQueue;
        for (let i = 0; i < rq.length; i++) {
            const entry = rq[i];
            if (!isPlainRecord(entry) || !isAccountName(entry.account)
                || (entry.lifecycle !== 'needs_logout_recovery' && entry.lifecycle !== 'needs_location_recovery')
                || !isFiniteNonNeg(entry.priorityValue)) {
                errors.push(`recoveryQueue[${i}] invalid`);
            }
        }
    }

    if (!isPlainRecord(v.accountPlans)) {
        errors.push('FleetPlan.accountPlans must be an object');
    } else {
        for (const k in v.accountPlans) {
            if (!Object.hasOwn(v.accountPlans, k)) continue;
            pushAccountPlanErrors(v.accountPlans[k], errors, `accountPlans["${k}"]: `);
        }
    }

    if (!Array.isArray(v.transferOrders)) {
        errors.push('FleetPlan.transferOrders must be an array');
    } else {
        const orders = v.transferOrders;
        for (let i = 0; i < orders.length; i++) {
            pushTransferOrderErrors(orders[i], errors, `transferOrders[${i}]: `);
        }
    }

    if (!isPlainRecord(v.spotAllocations)) {
        errors.push('FleetPlan.spotAllocations must be an object');
    } else {
        for (const spotId in v.spotAllocations) {
            if (!Object.hasOwn(v.spotAllocations, spotId)) continue;
            const list = v.spotAllocations[spotId];
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

function pushDefectRecordErrors(v: unknown, errors: string[], prefix = ''): void {
    if (!isPlainRecord(v)) {
        errors.push(`${prefix}DefectRecord must be an object`);
        return;
    }
    if (!isNonEmptyStr(v.id)) errors.push(`${prefix}DefectRecord.id must be non-empty`);
    if (!isNonEmptyStr(v.activityId)) errors.push(`${prefix}DefectRecord.activityId must be non-empty`);
    if (!isNonEmptyStr(v.faultSignature)) errors.push(`${prefix}DefectRecord.faultSignature must be non-empty`);
    if (v.outcomeKind !== 'worker_defect' && v.outcomeKind !== 'death') errors.push(`${prefix}DefectRecord.outcomeKind invalid`);
    if (!isAccountName(v.account)) errors.push(`${prefix}DefectRecord.account invalid`);
    if (!isFinitePos(v.observedAt)) errors.push(`${prefix}DefectRecord.observedAt must be finite positive`);
    if (!isFinitePos(v.quarantinedAt)) errors.push(`${prefix}DefectRecord.quarantinedAt must be finite positive`);
    if (v.expiresAt !== undefined && (!isFinitePos(v.expiresAt) || (isFinitePos(v.quarantinedAt) && v.expiresAt <= v.quarantinedAt))) {
        errors.push(`${prefix}DefectRecord.expiresAt must be strictly after quarantinedAt`);
    }
    if (typeof v.quarantined !== 'boolean') errors.push(`${prefix}DefectRecord.quarantined must be boolean`);
    if (v.workerRelease !== undefined && !isNonEmptyStr(v.workerRelease)) errors.push(`${prefix}DefectRecord.workerRelease must be non-empty`);
    if (!isNonEmptyStr(v.logPath)) errors.push(`${prefix}DefectRecord.logPath must be non-empty`);
    if (v.tickRecordPath !== undefined && !isNonEmptyStr(v.tickRecordPath)) errors.push(`${prefix}DefectRecord.tickRecordPath must be non-empty`);
    if (!isNonEmptyStr(v.detail)) errors.push(`${prefix}DefectRecord.detail must be non-empty`);
    if (!isPosInt(v.count)) errors.push(`${prefix}DefectRecord.count must be a positive integer`);
    if (v.deathLevels !== undefined && (!isPlainRecord(v.deathLevels) || !isPosInt(v.deathLevels.hitpoints) || !isPosInt(v.deathLevels.defence))) {
        errors.push(`${prefix}DefectRecord.deathLevels must hold positive integer hitpoints and defence`);
    }
}

export function validateDefectRecord(v: unknown): string[] {
    const errors: string[] = [];
    pushDefectRecordErrors(v, errors);
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
    else for (const k in v.accounts) {
        if (!Object.hasOwn(v.accounts, k)) continue;
        pushAccountStateErrors(v.accounts[k], errors, `accounts["${k}"]: `);
    }

    if (!isPlainRecord(v.activeChains)) errors.push('FleetState.activeChains must be an object');
    else for (const k in v.activeChains) {
        if (!Object.hasOwn(v.activeChains, k)) continue;
        pushAccountPlanErrors(v.activeChains[k], errors, `activeChains["${k}"]: `);
    }

    if (!isPlainRecord(v.idleReasons)) errors.push('FleetState.idleReasons must be an object');
    else for (const k in v.idleReasons) {
        if (!Object.hasOwn(v.idleReasons, k)) continue;
        const reason = v.idleReasons[k];
        if (!isAccountName(k) || !isNonEmptyStr(reason)) errors.push(`idleReasons["${k}"] must map account to non-empty reason`);
    }

    if (!Array.isArray(v.goals)) errors.push('FleetState.goals must be an array');
    else {
        const goals = v.goals;
        for (let i = 0; i < goals.length; i++) pushGoalDemandErrors(goals[i], errors, `goals[${i}]: `);
    }

    if (!Array.isArray(v.campaigns)) errors.push('FleetState.campaigns must be an array');
    else {
        const campaigns = v.campaigns;
        for (let i = 0; i < campaigns.length; i++) pushCampaignErrors(campaigns[i], errors, `campaigns[${i}]: `);
    }

    if (!Array.isArray(v.missions)) errors.push('FleetState.missions must be an array');
    else {
        const missions = v.missions;
        for (let i = 0; i < missions.length; i++) pushMissionErrors(missions[i], errors, `missions[${i}]: `);
    }

    if (!Array.isArray(v.pendingTransfers)) errors.push('FleetState.pendingTransfers must be an array');
    else {
        const pending = v.pendingTransfers;
        for (let i = 0; i < pending.length; i++) pushTransferOrderErrors(pending[i], errors, `pendingTransfers[${i}]: `);
    }

    if (!Array.isArray(v.quarantinedDefects)) errors.push('FleetState.quarantinedDefects must be an array');
    else {
        const defects = v.quarantinedDefects;
        for (let i = 0; i < defects.length; i++) pushDefectRecordErrors(defects[i], errors, `quarantinedDefects[${i}]: `);
    }

    if (v.rateStats !== undefined) {
        if (!isPlainRecord(v.rateStats)) errors.push('FleetState.rateStats must be an object');
        else for (const id in v.rateStats) {
            if (!Object.hasOwn(v.rateStats, id)) continue;
            const r = v.rateStats[id];
            if (!isNonEmptyStr(id) || !isPlainRecord(r) || !isPosInt(r.samples) || !isFiniteNonNeg(r.xpPerTick)
                || !isFiniteNonNeg(r.unitsPerTick) || typeof r.gpPerTick !== 'number' || !Number.isFinite(r.gpPerTick)) {
                errors.push(`rateStats["${id}"] invalid`);
            }
        }
    }
    return errors;
}

export const isFleetState = (v: unknown): v is FleetState => validateFleetState(v).length === 0;

const OPERATOR_CMD_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function validateOperatorCommand(v: unknown): string[] {
    if (!isPlainRecord(v)) return ['OperatorCommand must be an object'];
    const errors: string[] = [];
    if (v.schemaVersion !== 1) errors.push('OperatorCommand.schemaVersion must be 1');
    if (typeof v.id !== 'string' || !OPERATOR_CMD_ID.test(v.id)) {
        errors.push('OperatorCommand.id must match /^[A-Za-z0-9._-]{1,128}$/');
    }
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
            pushCampaignErrors(v.campaign, errors, 'upsert_campaign.campaign: ');
            break;
        case 'set_mission_state':
            if (!isNonEmptyStr(v.missionId)) errors.push('set_mission_state.missionId must be non-empty');
            if (!isMissionState(v.state)) errors.push('set_mission_state.state invalid');
            break;
        case 'upsert_mission':
            pushMissionErrors(v.mission, errors, 'upsert_mission.mission: ');
            break;
        default:
            errors.push(`unknown OperatorCommand.kind: ${String(v.kind)}`);
    }
    return errors;
}

export const isOperatorCommand = (v: unknown): v is OperatorCommand => validateOperatorCommand(v).length === 0;
