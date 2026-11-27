// AccountPlanner: solves 1-to-3-step dependency chains (recover -> acquire/gear -> unlock -> work),
// evaluates gear upgrades by net XP/tick payback over remaining band vs. acquisition ticks,
// applies comparative advantage across account profiles, and enforces protectedClock isolation.
import { resolve } from 'node:path';
import { levelForXp, xpForLevel } from '../../core/src/xp-curve';
import type { Gear, Skill } from '../../knowledge/src/gear';
import { canWear } from '../../knowledge/src/gear-query';
import type { PreflightResult, RateEstimate, TrustTier } from '../../workers/src/contracts';
import { trustMeetsMinimum } from '../../workers/src/contracts';
import { readJsonStatCached } from './json-cache';
import {
    DEFAULT_OPERATING_COIN_FLOAT,
    MAX_ACCOUNT_PLAN_STEPS,
    isCampaignLaunchReady,
    isHoldActive,
    isProtectedAccountName,
    marketCooldownKey,
    nearestHubBank,
    type AccountPlan,
    type AccountState,
    type AcquireSourceKind,
    type ActivityDefinition,
    type Campaign,
    type DefectRecord,
    type GearUpgradePlannedStep,
    type GoalDemand,
    type HubBankId,
    type PlannedStep,
    type RecoverPlannedStep,
    type TargetWorkPlannedStep,
    type UnlockPlannedStep,
    type WorldSnapshot,
} from './contracts';
import {
    GE_LIMIT_BUFFER,
    isValidGeAskQuote,
    loadShopCatalogByItem,
    resolveAcquireItem,
    type AcquireContext,
    type AcquireRequest,
    type AcquireResolution,
    type MarketQuotesMap,
} from './acquire';
import { TICKS_PER_HOUR } from './demand';
import { campaignShortfalls } from './campaigns';
import { walledInAt } from './snapshot';
import { walledRecoveryReason } from './worker-routing';
import {
    STANDARD_FOOD_IDS,
    accountSkillLevel,
    activityPreflightFromConfig,
    availableStockAfterReserves,
    cachedAccountSkillLevel,
    cachedAccountSkillXp,
    cachedEffectiveItemReserve,
    cachedHasCompletedQuest,
    canWearItem,
    completedQuestSet,
    createAccountLookupCache,
    effectiveItemReserve,
    hasCompletedQuest,
    loadGearMap,
    loadItemsMap,
    loadQuestRows,
    type AccountLookupCache,
    type CombatSurvivabilityFloor,
    type KnowledgeQuestRow,
} from './preflight';
import { accountOwnedItemCount, reserveAdjustedStock } from '../../workers/src/contracts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');
const SERVER_XP_MULTIPLIER = 25;

const WOODCUTTING_AXES_DESC = [1359, 1357, 1355, 1361, 1353, 1349, 1351] as const;
const MINING_PICKAXES_DESC = [1275, 1271, 1273, 1269, 1267, 1265] as const;

const HUB_CONSOLIDATION_ACTIVITY: ActivityDefinition = {
    id: 'logistics:fleet-trade',
    workerId: 'logistics',
    family: 'logistics',
    kind: 'recover',
    label: 'Consolidate fleet surplus via hub banker',
    config: { role: 'fleet-trade' },
    baselineRate: { xpPerTick: 0, unitsPerTick: 1, gpPerTick: 0, setupTicks: 45, minBatchUnits: 1, confidence: 'practice' },
    trust: 'practice_passed',
};

function stepCommittedCoinCost(step: PlannedStep): number {
    if (step.stepKind === 'acquire') {
        if (step.source === 'ge' && step.estimatedCoinCost > 0) {
            return Math.ceil((step.estimatedCoinCost / Math.max(1, step.quantity)) * GE_LIMIT_BUFFER) * step.quantity;
        }
        return Math.max(0, step.estimatedCoinCost);
    }
    if (step.stepKind === 'gear_upgrade') {
        const cost = step.estimatedCoinCost ?? 0;
        if (step.source === 'ge' && cost > 0) {
            return Math.ceil(cost * GE_LIMIT_BUFFER);
        }
        return Math.max(0, cost);
    }
    return 0;
}

export { levelForXp, xpForLevel };

interface SkillToolRow {
    readonly id: number;
    readonly wieldAttack?: number | null;
    readonly paramLevelrequire?: number | null;
    readonly woodcuttingLevel?: number | null;
    readonly miningLevel?: number | null;
}

let cachedSkillTools: { axes: SkillToolRow[]; pickaxes: SkillToolRow[] } | undefined;
let cachedTradeableRighthand: Gear[] | undefined;
type WeaponStyle = 'melee' | 'ranged' | 'magic';
let cachedScoredRighthandByStyle: Record<WeaponStyle, readonly { readonly gear: Gear; readonly score: number }[]> | undefined;

function loadSkillTools(): { axes: SkillToolRow[]; pickaxes: SkillToolRow[] } {
    if (cachedSkillTools) return cachedSkillTools;
    cachedSkillTools = readJsonStatCached<{ axes: SkillToolRow[]; pickaxes: SkillToolRow[] }>(
        resolve(REPO_ROOT, 'knowledge', 'skill-tools.json'),
    ) ?? { axes: [], pickaxes: [] };
    return cachedSkillTools;
}

function getTradeableRighthandGear(): readonly Gear[] {
    if (cachedTradeableRighthand) return cachedTradeableRighthand;
    cachedTradeableRighthand = [...loadGearMap().values()].filter((g) => g.slot === 'righthand' && g.tradeable);
    return cachedTradeableRighthand;
}

function getScoredRighthandByStyle(style: WeaponStyle): readonly { readonly gear: Gear; readonly score: number }[] {
    if (!cachedScoredRighthandByStyle) {
        const righthand = getTradeableRighthandGear();
        cachedScoredRighthandByStyle = {
            melee: righthand.map((gear) => ({ gear, score: scoreCombatWeapon(gear, 'melee') })).sort((a, b) => b.score - a.score),
            ranged: righthand.map((gear) => ({ gear, score: scoreCombatWeapon(gear, 'ranged') })).sort((a, b) => b.score - a.score),
            magic: righthand.map((gear) => ({ gear, score: scoreCombatWeapon(gear, 'magic') })).sort((a, b) => b.score - a.score),
        };
    }
    return cachedScoredRighthandByStyle[style];
}

interface PrecomputedWeaponInfo {
    readonly getStyle: (style: WeaponStyle) => {
        readonly bestOwnedScore: number;
        readonly candidates: readonly { readonly gear: Gear; readonly score: number }[];
    };
}

let cachedQuestRowByKey: Map<string, KnowledgeQuestRow> | undefined;
function getQuestRowBySlug(slugLower: string): KnowledgeQuestRow | undefined {
    if (!cachedQuestRowByKey) {
        const map = new Map<string, KnowledgeQuestRow>();
        for (const q of loadQuestRows()) {
            const v = q.varp.toLowerCase();
            if (!map.has(v)) map.set(v, q);
            if (q.folder) {
                const fl = q.folder.toLowerCase();
                if (!map.has(fl)) map.set(fl, q);
            }
        }
        cachedQuestRowByKey = map;
    }
    const aliasFolder = QUEST_FOLDER_ALIASES[slugLower];
    return cachedQuestRowByKey.get(slugLower)
        ?? cachedQuestRowByKey.get(`quest_${slugLower}`)
        ?? (aliasFolder !== undefined ? cachedQuestRowByKey.get(aliasFolder) : undefined);
}

function buildWearLevels(acct: AccountState, acctCache?: AccountLookupCache): Partial<Record<Skill, number>> {
    return {
        attack: cachedAccountSkillLevel(acct, 'Attack', acctCache),
        strength: cachedAccountSkillLevel(acct, 'Strength', acctCache),
        defence: cachedAccountSkillLevel(acct, 'Defence', acctCache),
        ranged: cachedAccountSkillLevel(acct, 'Ranged', acctCache),
        magic: cachedAccountSkillLevel(acct, 'Magic', acctCache),
    };
}

function precomputeWearableWeapons(acct: AccountState, acctCache?: AccountLookupCache): PrecomputedWeaponInfo {
    const gearMap = loadGearMap();
    const levels = buildWearLevels(acct, acctCache);
    const doneSet = acctCache ? acctCache.completedSet : completedQuestSet(acct);

    const ownedRighthand: Gear[] = [];
    const scanContainer = (container: Readonly<Record<number, number>>) => {
        for (const idStr in container) {
            if (!Object.hasOwn(container, idStr)) continue;
            const cnt = container[idStr as unknown as number]!;
            if (cnt <= 0) continue;
            const g = gearMap.get(Number(idStr));
            if (!g || g.slot !== 'righthand') continue;
            if (!canWear(g, levels, doneSet)) continue;
            ownedRighthand.push(g);
        }
    };
    scanContainer(acct.equipment);
    scanContainer(acct.inventory);
    if (acct.bank.trusted) scanContainer(acct.bank.items);

    const cache: Partial<Record<WeaponStyle, { bestOwnedScore: number; candidates: { gear: Gear; score: number }[] }>> = {};
    const getStyle = (style: WeaponStyle) => {
        const hit = cache[style];
        if (hit) return hit;
        let bestOwnedScore = 50;
        for (const g of ownedRighthand) {
            const sc = scoreCombatWeapon(g, style);
            if (sc > bestOwnedScore) bestOwnedScore = sc;
        }
        const threshold = bestOwnedScore * 1.05;
        const candidates: { gear: Gear; score: number }[] = [];
        for (const entry of getScoredRighthandByStyle(style)) {
            if (entry.score <= threshold) break;
            if (canWear(entry.gear, levels, doneSet)) {
                candidates.push(entry);
                if (candidates.length >= 6) break;
            }
        }
        const out = { bestOwnedScore, candidates };
        cache[style] = out;
        return out;
    };

    return { getStyle };
}

export interface RateEstimator {
    estimate(activity: ActivityDefinition, acct: AccountState, world: WorldSnapshot): RateEstimate;
}

export interface RateStoreLike {
    estimate(activityId: string, acct?: AccountState, world?: WorldSnapshot): RateEstimate;
}

export interface PlannerActivityIndex {
    readonly nonExpByOutputItem: ReadonlyMap<number, readonly ActivityDefinition[]>;
    readonly byOutputItem: ReadonlyMap<number, readonly ActivityDefinition[]>;
    readonly bySkill: ReadonlyMap<string, readonly ActivityDefinition[]>;
    readonly questsBySlug: ReadonlyMap<string, readonly ActivityDefinition[]>;
    readonly gpActivities: readonly ActivityDefinition[];
    readonly combatOrPvpActivities: readonly ActivityDefinition[];
    readonly shopBuyActivity: ActivityDefinition | undefined;
    readonly geBuyActivity: ActivityDefinition | undefined;
}

export interface PlannerSharedIndex extends PlannerActivityIndex {
    readonly eligibleActivities: readonly ActivityDefinition[];
    readonly allIdleDonors: readonly AccountState[];
    readonly idleDonorsByItemId: ReadonlyMap<number, readonly AccountState[]>;
}

function indexEligibleActivities(eligibleActivities: readonly ActivityDefinition[]): PlannerActivityIndex {
    const nonExpByOutputItem = new Map<number, ActivityDefinition[]>();
    const byOutputItem = new Map<number, ActivityDefinition[]>();
    const bySkill = new Map<string, ActivityDefinition[]>();
    const questsBySlug = new Map<string, ActivityDefinition[]>();
    const gpActivities: ActivityDefinition[] = [];
    const combatOrPvpActivities: ActivityDefinition[] = [];
    let shopBuyActivity: ActivityDefinition | undefined;
    let geBuyActivity: ActivityDefinition | undefined;

    const pushMap = <K, V>(map: Map<K, V[]>, key: K, val: V) => {
        const list = map.get(key);
        if (list) {
            if (!list.includes(val)) list.push(val);
        } else {
            map.set(key, [val]);
        }
    };

    for (const act of eligibleActivities) {
        if (act.id === 'market:shop-buy') shopBuyActivity = act;
        else if (act.id === 'market:ge-buy') geBuyActivity = act;

        const isNonExp = act.trust !== 'experimental';
        const seenOut = isNonExp ? new Set<number>() : undefined;
        for (const o of act.outputs ?? []) {
            if (o.countPerUnit > 0) {
                pushMap(byOutputItem, o.itemId, act);
                seenOut?.add(o.itemId);
            }
        }
        for (const [idStr, cnt] of Object.entries(act.baselineRate.outputsPerUnit ?? {})) {
            if (cnt > 0) {
                const itemId = Number(idStr);
                pushMap(byOutputItem, itemId, act);
                seenOut?.add(itemId);
            }
        }
        if (seenOut) {
            for (const itemId of seenOut) pushMap(nonExpByOutputItem, itemId, act);
        }
        if (act.family === 'market' && Number.isFinite(Number(act.config?.itemId))) {
            pushMap(byOutputItem, Number(act.config.itemId), act);
        }
        if (act.family !== 'quest') {
            if (act.skill) pushMap(bySkill, act.skill.toLowerCase(), act);
            for (const sk of act.skills ?? []) pushMap(bySkill, sk.toLowerCase(), act);
            for (const [sk, xp] of Object.entries(act.baselineRate.skillXpPerTick ?? {})) {
                if (xp > 0) pushMap(bySkill, sk.toLowerCase(), act);
            }
        }
        if (act.family === 'quest' && act.questSlug) {
            pushMap(questsBySlug, act.questSlug.toLowerCase(), act);
        }
        // The coin candidates: no PvP work (activityMatchesDemand 'coins' says why).
        if (act.family !== 'pvp' && act.baselineRate.gpPerTick > 0) gpActivities.push(act);
        if (act.family === 'pvp' || act.family === 'combat') combatOrPvpActivities.push(act);
    }

    return {
        nonExpByOutputItem,
        byOutputItem,
        bySkill,
        questsBySlug,
        gpActivities,
        combatOrPvpActivities,
        shopBuyActivity,
        geBuyActivity,
    };
}

export function buildPlannerSharedIndex(params: {
    readonly world: WorldSnapshot;
    readonly activities: readonly ActivityDefinition[];
    readonly defects?: readonly DefectRecord[];
    readonly minTrust?: TrustTier;
    readonly allowExperimentalFallback?: boolean;
}): PlannerSharedIndex {
    const now = params.world.at;
    const minTrust: TrustTier = params.minTrust ?? 'practice_passed';
    const defects = params.defects ?? [];
    // The shared index serves every account, so it drops only fleet-wide defects. Each account's own
    // first-failure defects are excluded in planAccountWithCandidates.
    const quarantinedIds = new Set<string>();
    for (const d of defects) {
        if (isDefectActive(d, now) && isFleetWideDefect(d, now)) {
            quarantinedIds.add(d.activityId);
        }
    }
    const candidateActivities = params.activities.filter((act) => {
        if (quarantinedIds.has(act.id)) return false;
        if (!trustMeetsMinimum(act.trust, minTrust) && !params.allowExperimentalFallback) return false;
        return true;
    });
    const eligibleActivities = candidateActivities.some((a) => trustMeetsMinimum(a.trust, minTrust))
        ? candidateActivities.filter((a) => trustMeetsMinimum(a.trust, minTrust))
        : candidateActivities;

    const built = indexEligibleActivities(eligibleActivities);
    const allIdleDonors = Object.values(params.world.accounts)
        .filter((d) =>
            d.lifecycle === 'idle'
            && d.bank.trusted
            && !d.protectedClock
            && !isProtectedAccountName(d.name),
        )
        .sort((a, b) => a.name.localeCompare(b.name));

    const idleDonorsByItemId = new Map<number, AccountState[]>();
    for (const donor of allIdleDonors) {
        const seen = new Set<number>();
        const addItems = (src: Readonly<Record<number, number>>) => {
            for (const idStr in src) {
                if (!Object.hasOwn(src, idStr)) continue;
                const cnt = src[idStr as unknown as number]!;
                if (cnt <= 0) continue;
                const itemId = Number(idStr);
                if (seen.has(itemId)) continue;
                seen.add(itemId);
                let list = idleDonorsByItemId.get(itemId);
                if (!list) {
                    list = [];
                    idleDonorsByItemId.set(itemId, list);
                }
                list.push(donor);
            }
        };
        addItems(donor.inventory);
        addItems(donor.equipment);
        if (donor.bank.trusted) addItems(donor.bank.items);
    }

    return {
        eligibleActivities,
        ...built,
        allIdleDonors,
        idleDonorsByItemId,
    };
}

export interface AccountPlannerInput {
    readonly world: WorldSnapshot;
    readonly activities: readonly ActivityDefinition[];
    readonly demands: readonly GoalDemand[];
    readonly campaigns?: readonly Campaign[];
    readonly defects?: readonly DefectRecord[];
    readonly rateEstimator?: RateEstimator;
    readonly rateStore?: RateStoreLike;
    readonly marketQuotes?: MarketQuotesMap;
    readonly requireMarketQuote?: boolean;
    readonly minTrust?: TrustTier;
    readonly allowExperimentalFallback?: boolean;
    readonly excludedSpotIds?: ReadonlySet<string>;
    readonly excludedActivityIds?: ReadonlySet<string>;
    readonly excludedDonorAccounts?: ReadonlySet<string>;
    readonly excludedAcquireSources?: ReadonlySet<AcquireSourceKind>;
    readonly excludedMarketVenues?: ReadonlySet<string>;
    readonly donorDemandItemIds?: ReadonlyMap<string, ReadonlySet<number>>;
    readonly recentReceivedAt?: ReadonlyMap<string, number>;
    readonly confirmedLogoutAt?: ReadonlyMap<string, number>;
    readonly requireConfirmedLogoutForTransfer?: boolean;
    readonly xpRate?: number;
    readonly ticksPerHour?: number;
    readonly _sharedIndex?: PlannerSharedIndex;
    readonly _reuse?: AccountPlannerReuse;
}

export interface AccountPlannerReuse {
    readonly acctNameLower: string;
    readonly worldAt: number;
    readonly acctRef: AccountState;
    readonly worldRef: WorldSnapshot;
    readonly campaignsRef: readonly Campaign[];
    readonly acctCache: AccountLookupCache;
    readonly profile: AccountProfileSummary;
    readonly protection: ReturnType<typeof canProtectedAccountLaunch>;
    readonly rateCache: Map<string, RateEstimate>;
    readonly preflightCache: Map<string, PreflightResult>;
    readonly getPrecomputedWeapons: () => PrecomputedWeaponInfo;
}

export function createAccountPlannerReuse(
    acct: AccountState,
    world: WorldSnapshot,
    campaigns: readonly Campaign[] = [],
): AccountPlannerReuse {
    const acctCache = createAccountLookupCache(acct, world, DEFAULT_OPERATING_COIN_FLOAT);
    const profile = summarizeAccountProfile(acct, acctCache);
    const protection = canProtectedAccountLaunch(acct, campaigns, world);
    let precomputedWeapons: PrecomputedWeaponInfo | undefined;
    return {
        acctNameLower: acct.name.toLowerCase(),
        worldAt: world.at,
        acctRef: acct,
        worldRef: world,
        campaignsRef: campaigns,
        acctCache,
        profile,
        protection,
        rateCache: new Map<string, RateEstimate>(),
        preflightCache: new Map<string, PreflightResult>(),
        getPrecomputedWeapons: () => {
            if (!precomputedWeapons) precomputedWeapons = precomputeWearableWeapons(acct, acctCache);
            return precomputedWeapons;
        },
    };
}

export interface AccountProfileSummary {
    readonly completedQuests: number;
    readonly artisanMax: number;
    readonly combatMeleeMin: number;
    readonly combatTribridMin: number;
    readonly isHighQuest: boolean;
    readonly isHighArtisan: boolean;
    readonly isMaxedTribrid: boolean;
    readonly isFresh: boolean;
}

const ARTISAN_SKILLS = ['Cooking', 'Smithing', 'Crafting', 'Fletching', 'Herblore', 'Runecraft', 'Magic'] as const;
const TRIBRID_SKILLS = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic'] as const;

export function summarizeAccountProfile(acct: AccountState, _acctCache?: AccountLookupCache): AccountProfileSummary {
    let completedQuests = 0;
    for (const q in acct.quests) {
        if (Object.hasOwn(acct.quests, q) && acct.quests[q] === 'complete') completedQuests += 1;
    }
    let artisanMax = 1;
    for (const sk of ARTISAN_SKILLS) {
        artisanMax = Math.max(artisanMax, cachedAccountSkillLevel(acct, sk, _acctCache));
    }
    const combatMeleeMin = Math.min(
        cachedAccountSkillLevel(acct, 'Attack', _acctCache),
        cachedAccountSkillLevel(acct, 'Strength', _acctCache),
        cachedAccountSkillLevel(acct, 'Defence', _acctCache),
    );
    let combatTribridMin = 99;
    for (const sk of TRIBRID_SKILLS) {
        const lvl = cachedAccountSkillLevel(acct, sk, _acctCache);
        if (lvl < combatTribridMin) combatTribridMin = lvl;
    }
    const prayer = cachedAccountSkillLevel(acct, 'Prayer', _acctCache);

    let totalLevel = 0;
    let skillCount = 0;
    for (const sk in acct.skills) {
        if (!Object.hasOwn(acct.skills, sk)) continue;
        skillCount += 1;
        const st = acct.skills[sk];
        totalLevel += Number.isFinite(st?.level) ? st!.level : sk.toLowerCase() === 'hitpoints' ? 10 : 1;
    }
    if (skillCount === 0) totalLevel = 28;

    return {
        completedQuests,
        artisanMax,
        combatMeleeMin,
        combatTribridMin,
        isHighQuest: completedQuests >= 10,
        isHighArtisan: artisanMax >= 55,
        isMaxedTribrid: combatTribridMin >= 90 && prayer >= 43,
        isFresh: completedQuests === 0 && totalLevel <= 90 && artisanMax < 30 && combatMeleeMin < 30,
    };
}

export function canProtectedAccountLaunch(
    acct: AccountState,
    campaigns: readonly Campaign[] = [],
    world?: WorldSnapshot,
): { allowed: boolean; campaign?: Campaign; reason?: string } {
    const isProtected = acct.protectedClock || isProtectedAccountName(acct.name);
    if (!isProtected) return { allowed: true };
    const campaign = campaigns.find((c) => c.account.toLowerCase() === acct.name.toLowerCase());
    if (!campaign) {
        return { allowed: false, reason: 'protected_clock_no_campaign' };
    }
    if (campaign.state !== 'ready' && campaign.state !== 'running') {
        return { allowed: false, campaign, reason: `campaign_state_${campaign.state}` };
    }
    if (world) {
        const evaluation = campaignShortfalls(campaign, world);
        if (!isCampaignLaunchReady(campaign, { now: world.at, suppliesSatisfied: evaluation.shortfalls.length === 0 })) {
            const reason = evaluation.shortfalls.length > 0
                ? 'campaign_supplies_short'
                : evaluation.missingGates.includes('staleHiscore')
                  ? 'campaign_hiscore_stale'
                  : 'campaign_launch_gate_not_met';
            return { allowed: false, campaign, reason };
        }
        return { allowed: true, campaign };
    }
    if (!isCampaignLaunchReady(campaign)) {
        return { allowed: false, campaign, reason: 'campaign_launch_gate_not_met' };
    }
    return { allowed: true, campaign };
}

const nearestHub = (pos: AccountState['pos']): HubBankId => nearestHubBank(pos);

/** Failures of one fault signature before a worker defect holds the activity for every account. */
export const FLEET_QUARANTINE_MIN_COUNT = 2;

function isDefectActive(d: DefectRecord, now: number): boolean {
    return d.quarantined && (d.expiresAt === undefined || now < d.expiresAt);
}

/** The time a death holds its activity for every account. A death defect with levels holds longer for its class. */
export const FLEET_DEATH_HOLD_MS = 24 * 3_600_000;

/**
 * A death, or a fault signature seen FLEET_QUARANTINE_MIN_COUNT times, holds the activity for every account.
 * A first worker defect holds it only for the account that failed: one account's missing food, bad position
 * or lost session must not idle the fleet for the defect lifetime. A death with the levels of the dead account
 * holds every account for FLEET_DEATH_HOLD_MS and then only its class (deathClassBlocks).
 */
export function isFleetWideDefect(d: DefectRecord, now?: number): boolean {
    if (d.outcomeKind === 'death') return !d.deathLevels || now === undefined || now < d.quarantinedAt + FLEET_DEATH_HOLD_MS;
    return (d.count ?? 1) >= FLEET_QUARANTINE_MIN_COUNT;
}

/** The base levels that a death defect compares (DefectRecord.deathLevels). */
export type AccountClassLevels = { readonly hitpoints: number; readonly defence: number };

/**
 * A death defect holds an account that is no stronger than the account that died: Hitpoints and Defence both at or
 * below its levels. The same target kills such an account the same way.
 */
export function deathClassBlocks(d: DefectRecord, levels: AccountClassLevels | undefined, now: number): boolean {
    if (!isDefectActive(d, now) || d.outcomeKind !== 'death' || !d.deathLevels || !levels) return false;
    return levels.hitpoints <= d.deathLevels.hitpoints && levels.defence <= d.deathLevels.defence;
}

export function defectBlocksAccount(d: DefectRecord, account: string, now: number, levels?: AccountClassLevels): boolean {
    if (!isDefectActive(d, now)) return false;
    return isFleetWideDefect(d, now) || d.account.toLowerCase() === account.toLowerCase() || deathClassBlocks(d, levels, now);
}

function isActivityQuarantined(
    activityId: string,
    defects: readonly DefectRecord[],
    now: number,
    account: string,
    levels?: AccountClassLevels,
): boolean {
    return defects.some((d) => d.activityId === activityId && defectBlocksAccount(d, account, now, levels));
}

function accountOnlyQuarantinedIds(
    defects: readonly DefectRecord[],
    account: string,
    now: number,
    levels?: AccountClassLevels,
): ReadonlySet<string> {
    const ids = new Set<string>();
    const lower = account.toLowerCase();
    for (const d of defects) {
        if (!isDefectActive(d, now) || isFleetWideDefect(d, now)) continue;
        if (d.account.toLowerCase() === lower || deathClassBlocks(d, levels, now)) ids.add(d.activityId);
    }
    return ids;
}

/** The base Hitpoints and Defence of an account, for the death class of a defect. */
export function accountClassLevels(acct: { readonly skills?: Readonly<Record<string, { readonly level?: number } | number | undefined>> }): AccountClassLevels | undefined {
    const level = (name: string): number | undefined => {
        const v = acct.skills?.[name];
        const n = typeof v === 'number' ? v : v?.level;
        return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
    };
    const hitpoints = level('Hitpoints'), defence = level('Defence');
    return hitpoints === undefined ? undefined : { hitpoints, defence: defence ?? 1 };
}

function hasBlockingSystemHold(acct: AccountState, now: number): string | null {
    if (!acct.systemHolds?.length) return null;
    for (const h of acct.systemHolds) {
        if (!isHoldActive(h, now)) continue;
        // Recovery lifecycles are resolved directly by planAccount() recovery steps.
        if (
            (h.kind === 'maintenance' && h.key === 'location_stranded' && acct.lifecycle === 'needs_location_recovery')
            || (h.kind === 'retry_backoff' && h.key === 'session_unsettled' && acct.lifecycle === 'needs_logout_recovery')
        ) {
            continue;
        }
        if (h.kind === 'circuit_breaker' || h.kind === 'maintenance' || h.kind === 'retry_backoff') {
            return `system_hold:${h.kind}:${h.key}`;
        }
    }
    return null;
}

function scoreCombatWeapon(g: Gear, style: 'melee' | 'ranged' | 'magic'): number {
    const b = g.bonuses;
    if (style === 'melee') {
        const maxAtk = Math.max(b.stabAttack, b.slashAttack, b.crushAttack);
        const rate = Math.max(1, g.attackRate ?? 4);
        return ((64 + b.strength) * (64 + maxAtk)) / rate;
    }
    if (style === 'ranged') {
        const rate = Math.max(1, g.attackRate ?? 4);
        return ((64 + b.rangeStrength) * (64 + b.rangeAttack)) / rate;
    }
    return b.magicAttack * 20 + b.magicDefence * 4 + 10;
}

function toolSpeedMultiplier(itemId: number, kind: 'woodcutting' | 'mining'): number {
    // Tick cadence improvement relative to bronze tool baseline (8 ticks).
    const miningOrder: Readonly<Record<number, number>> = {
        1275: 2.66, // Rune pickaxe (3t)
        1271: 2.0,  // Adamant (4t)
        1273: 1.6,  // Mithril (5t)
        1269: 1.33, // Steel (6t)
        1267: 1.14, // Iron (7t)
        1265: 1.0,  // Bronze (8t)
    };
    const wcOrder: Readonly<Record<number, number>> = {
        1359: 2.2,  // Rune axe
        1357: 1.85, // Adamant axe
        1355: 1.6,  // Mithril axe
        1361: 1.4,  // Black axe
        1353: 1.25, // Steel axe
        1349: 1.12, // Iron axe
        1351: 1.0,  // Bronze axe
    };
    return kind === 'mining' ? (miningOrder[itemId] ?? 1) : (wcOrder[itemId] ?? 1);
}

export interface GearUpgradeCandidateResult {
    readonly step: GearUpgradePlannedStep;
    readonly improvedXpPerTick: number;
}

interface ResolvedGearUpgradeCandidate {
    readonly itemId: number;
    readonly itemName?: string;
    readonly slot: string;
    readonly multiplier: number;
    readonly acq: AcquireResolution;
}

export function evaluateBestGearUpgrade(params: {
    readonly acct: AccountState;
    readonly activity: ActivityDefinition;
    readonly rate: RateEstimate;
    readonly remainingXp: number;
    readonly acquireCtx: AcquireContext;
    readonly trainingSkill?: string;
    readonly precomputedWeapons?: PrecomputedWeaponInfo;
    readonly resolveAcquire?: (req: AcquireRequest) => AcquireResolution;
    readonly committedCoinSpend?: number;
    readonly _acctCache?: AccountLookupCache;
    readonly _upgradeCandidatesCache?: Map<string, readonly ResolvedGearUpgradeCandidate[]>;
}): GearUpgradeCandidateResult | null {
    const { acct, activity, rate, remainingXp, acquireCtx } = params;
    if (rate.xpPerTick <= 0 || !Number.isFinite(remainingXp) || remainingXp <= 0) return null;

    const skill = (params.trainingSkill ?? activity.skill)?.toLowerCase();
    const isWoodcutting = skill === 'woodcutting';
    const isMining = skill === 'mining';
    // A weapon changes XP only where the spell hits a target: enchanting, alchemy, superheat,
    // teleports and bones (bank-artisan magic) gain nothing from a staff.
    const isCombat = activity.family === 'combat'
        || skill === 'attack' || skill === 'strength' || skill === 'defence'
        || skill === 'ranged' || (skill === 'magic' && activity.family === 'pvp');

    if (!isWoodcutting && !isMining && !isCombat) return null;

    const style: WeaponStyle = skill === 'ranged' ? 'ranged' : skill === 'magic' ? 'magic' : 'melee';
    const bucketKey = isMining
        ? `mining:${params.committedCoinSpend ?? 0}`
        : isWoodcutting
            ? `wc:${params.committedCoinSpend ?? 0}`
            : `combat:${style}:${params.committedCoinSpend ?? 0}`;

    let resolvedList = params._upgradeCandidatesCache?.get(bucketKey);
    if (!resolvedList) {
        const gearMap = loadGearMap();
        const itemsMap = loadItemsMap();
        const doAcquire = params.resolveAcquire
            ?? ((req: AcquireRequest) => resolveAcquireItem(acct, req, acquireCtx));
        const acctCache = params._acctCache;
        const built: ResolvedGearUpgradeCandidate[] = [];

        const pushCandidate = (itemId: number, slot: string, multiplier: number) => {
            if (multiplier <= 1.02) return;
            const ownedRaw = accountOwnedItemCount(acct, itemId, {
                includeBank: true,
                requireTrustedBank: true,
            });
            const reserved = cachedEffectiveItemReserve(acct, acquireCtx.world, itemId, acctCache);
            if (reserveAdjustedStock(ownedRaw, reserved) > 0) return;

            const itemName = itemsMap.get(itemId)?.name ?? gearMap.get(itemId)?.name;
            const acq = doAcquire({
                itemId,
                itemName,
                quantity: 1,
                allowOwnBank: true,
                ...(params.committedCoinSpend !== undefined ? { committedCoinSpend: params.committedCoinSpend } : {}),
            });
            if (!acq.ok || !acq.step) return;
            built.push({ itemId, itemName, slot, multiplier, acq });
        };

        if (isMining || isWoodcutting) {
            const list = isMining ? MINING_PICKAXES_DESC : WOODCUTTING_AXES_DESC;
            const toolRows = loadSkillTools();
            const rows = isMining ? toolRows.pickaxes : toolRows.axes;
            const useLvl = cachedAccountSkillLevel(acct, isMining ? 'Mining' : 'Woodcutting', acctCache);
            let currentMult = 1.0;
            for (const id of list) {
                const ownedRaw = accountOwnedItemCount(acct, id);
                const reserved = cachedEffectiveItemReserve(acct, acquireCtx.world, id, acctCache);
                if (reserveAdjustedStock(ownedRaw, reserved) > 0) {
                    const row = rows.find((r) => r.id === id);
                    const reqLvl = isMining ? (row?.miningLevel ?? 1) : 1;
                    if (useLvl >= reqLvl) {
                        currentMult = Math.max(currentMult, toolSpeedMultiplier(id, isMining ? 'mining' : 'woodcutting'));
                    }
                }
            }
            for (const id of list) {
                const row = rows.find((r) => r.id === id);
                const reqLvl = isMining ? (row?.miningLevel ?? 1) : (row?.woodcuttingLevel ?? row?.paramLevelrequire ?? 1);
                if (isMining && useLvl < reqLvl) continue;
                const wear = canWearItem(acct, id);
                if (!isMining && !wear.ok && useLvl < reqLvl) continue;
                const mult = toolSpeedMultiplier(id, isMining ? 'mining' : 'woodcutting');
                if (mult > currentMult) {
                    pushCandidate(id, 'weapon', mult / currentMult);
                }
            }
        } else {
            const precomputed = params.precomputedWeapons ?? precomputeWearableWeapons(acct, acctCache);
            const { bestOwnedScore: bestOwnedWeaponScore, candidates: weaponCandidates } = precomputed.getStyle(style);
            for (const cand of weaponCandidates) {
                const ratio = Math.min(2.2, Math.sqrt(cand.score / bestOwnedWeaponScore));
                pushCandidate(cand.gear.id, 'weapon', ratio);
            }
        }
        resolvedList = built;
        params._upgradeCandidatesCache?.set(bucketKey, resolvedList);
    }

    if (resolvedList.length === 0) return null;

    const baseRemainingTicks = remainingXp / rate.xpPerTick;
    let best: GearUpgradeCandidateResult | null = null;
    for (const entry of resolvedList) {
        const improvedXpPerTick = rate.xpPerTick * entry.multiplier;
        const netXpPerTickGain = improvedXpPerTick - rate.xpPerTick;
        const newBandTicks = remainingXp / improvedXpPerTick;
        let bestStep: GearUpgradePlannedStep | null = null;
        for (const cand of entry.acq.candidates) {
            const paybackNetTicks = (baseRemainingTicks - newBandTicks) - cand.step.estimatedTicks;
            if (paybackNetTicks <= 0 || !Number.isFinite(paybackNetTicks)) continue;
            if (!bestStep || paybackNetTicks > bestStep.paybackNetTicks) {
                bestStep = {
                    stepKind: 'gear_upgrade',
                    itemId: entry.itemId,
                    ...(entry.itemName ? { itemName: entry.itemName } : {}),
                    slot: entry.slot,
                    netXpPerTickGain,
                    remainingBandTicks: baseRemainingTicks,
                    acquisitionTicks: cand.step.estimatedTicks,
                    paybackNetTicks,
                    source: cand.step.source,
                    ...(cand.step.shopId ? { shopId: cand.step.shopId } : {}),
                    ...(cand.step.donorAccount ? { donorAccount: cand.step.donorAccount } : {}),
                    ...(cand.step.hub ? { hub: cand.step.hub } : {}),
                    ...(cand.step.activityId ? { activityId: cand.step.activityId } : {}),
                    ...(Number.isFinite(cand.step.estimatedCoinCost) ? { estimatedCoinCost: cand.step.estimatedCoinCost } : {}),
                    ...(Number.isFinite(cand.step.coinFloatPreserved) ? { coinFloatPreserved: cand.step.coinFloatPreserved } : {}),
                };
            }
        }
        if (bestStep && (!best || bestStep.paybackNetTicks > best.step.paybackNetTicks)) {
            best = { step: bestStep, improvedXpPerTick };
        }
    }
    return best;
}

export function comparativeAdvantageMultiplier(
    acct: AccountState,
    demand: GoalDemand,
    activity: ActivityDefinition,
    profile: AccountProfileSummary = summarizeAccountProfile(acct),
    _acctCache?: AccountLookupCache,
): number {
    let mult = 1.0;

    if (demand.assignedAccount) {
        if (demand.assignedAccount.toLowerCase() === acct.name.toLowerCase()) {
            mult *= 2.0;
        } else {
            return 0;
        }
    }

    // Comparative advantage by goal kind and account specialization:
    if (demand.goalKind === 'quest_board') {
        if (profile.isHighQuest) {
            mult *= 1.65 + Math.min(0.5, profile.completedQuests * 0.01);
        } else if (profile.isFresh) {
            mult *= 0.85;
        }
    } else if (
        demand.goalKind === 'main_supply'
        || demand.goalKind === 'specialist_prep'
        || demand.goalKind === 'squad_supply'
        || demand.goalKind === 'gear_collection'
    ) {
        const actSkill = activity.skill;
        const lvl = actSkill ? cachedAccountSkillLevel(acct, actSkill, _acctCache) : profile.artisanMax;
        if (activity.family === 'bank-artisan' && lvl >= 55) {
            mult *= 1.55 + Math.min(0.45, (lvl - 55) / 100);
        } else if (profile.isHighArtisan && (activity.family === 'bank-artisan' || activity.family === 'gather')) {
            mult *= 1.35;
        }
    } else if (demand.goalKind === 'pk_army') {
        if (profile.isMaxedTribrid) {
            mult *= 1.85;
        } else if (acct.role === 'army') {
            mult *= 1.4;
        } else if (profile.isFresh && (activity.family === 'pvp' || activity.id.includes('kbd') || activity.id.includes('dragon'))) {
            mult *= 0.5;
        }
    }

    // Endgame / Boss / PK prioritization for maxed tribrids vs starter bootstrap.
    const isEndgameOrPk = activity.family === 'pvp'
        || /kbd|dragon|lava-maze|trooper|fire-giant/i.test(activity.id);
    const isLowStarter = /chicken|cow|coop|shrimp/i.test(activity.id);
    if (profile.isMaxedTribrid) {
        if (isEndgameOrPk) mult *= 1.5;
        else if (isLowStarter) mult *= 0.35;
    }

    // Explicit role affinity (auto picks highest raw/advantage value across all goals).
    if (acct.role === 'army') {
        if (demand.goalKind === 'pk_army' || demand.goalKind === 'squad_supply' || activity.family === 'combat' || activity.family === 'pvp') {
            mult *= 1.45;
        } else if (demand.goalKind === 'quest_board') {
            mult *= 0.7;
        }
    } else if (acct.role === 'helper') {
        if (
            demand.goalKind === 'main_supply'
            || demand.goalKind === 'specialist_prep'
            || demand.goalKind === 'squad_supply'
            || demand.goalKind === 'coin_fund'
            || demand.goalKind === 'gear_collection'
        ) {
            mult *= 1.35;
        }
    }

    return mult;
}

// The largest batch whose need for one input fits the stock: the preflight asks for
// ceil(countPerUnit * batch) + reserve of each input row.
export function batchUnitsForStock(
    activity: Pick<ActivityDefinition, 'inputs'>,
    itemId: number,
    stock: number,
    batchUnits: number,
    required: number,
): number {
    let perUnit = 0;
    let fixed = 0;
    for (const io of activity.inputs ?? []) {
        if (io.itemId !== itemId) continue;
        perUnit += io.countPerUnit;
        fixed += Math.max(0, io.reserve ?? 0);
    }
    if (!(perUnit > 0)) {
        perUnit = required / Math.max(1, batchUnits);
        fixed = 0;
    }
    return Math.max(0, Math.floor(Math.max(0, stock - fixed) / Math.max(1e-6, perUnit)));
}

const QUEST_FOLDER_ALIASES: Readonly<Record<string, string>> = {
    dwarfcannon: 'quest_mcannon',
    dig: 'quest_itexam',
    merlin: 'quest_arthur',
    rj: 'quest_romeojuliet',
    scorpion: 'quest_scorpcatcher',
    elemental: 'quest_elemental_workshop',
    arrav: 'quest_blackarmgang',
};

function activityXpForSkill(activity: ActivityDefinition, rate: RateEstimate, skill: string): number {
    const lower = skill.toLowerCase();
    if (rate.skillXpPerTick) {
        const direct = rate.skillXpPerTick[skill];
        if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
        for (const [k, v] of Object.entries(rate.skillXpPerTick)) {
            if (k.toLowerCase() === lower && Number.isFinite(v)) return v;
        }
    }
    if (activity.skill?.toLowerCase() === lower || activity.skills?.some((s) => s.toLowerCase() === lower)) {
        return rate.xpPerTick;
    }
    return 0;
}

// The skill XP of one unit. A catalog row that reads the server data gives it exactly (config.xpPerUnit);
// other rows give it as XP per tick over units per tick.
function activityXpPerUnit(activity: ActivityDefinition, rate: RateEstimate, skill: string): number {
    const exact = activity.config?.xpPerUnit;
    if (typeof exact === 'number' && Number.isFinite(exact) && exact > 0 && activity.skill?.toLowerCase() === skill.toLowerCase()) {
        return exact;
    }
    return rate.unitsPerTick > 0 ? activityXpForSkill(activity, rate, skill) / rate.unitsPerTick : 0;
}

function activityMatchesDemand(
    acct: AccountState,
    demand: GoalDemand,
    activity: ActivityDefinition,
    acctCache?: AccountLookupCache,
): boolean {
    if (!demand.active || demand.remaining <= 0) return false;
    if (demand.assignedAccount && demand.assignedAccount.toLowerCase() !== acct.name.toLowerCase()) return false;

    const t = demand.target;
    switch (t.kind) {
        case 'item': {
            const outputsItem = activity.outputs?.some((o) => o.itemId === t.itemId && o.countPerUnit > 0)
                || (activity.baselineRate.outputsPerUnit?.[t.itemId] ?? 0) > 0;
            if (outputsItem) return true;
            if (activity.family === 'market' && Number(activity.config?.itemId) === t.itemId) return true;
            return false;
        }
        case 'skill': {
            if (activity.family === 'quest') return false;
            if (t.account.toLowerCase() !== acct.name.toLowerCase()) return false;
            const curLvl = cachedAccountSkillLevel(acct, t.skill, acctCache);
            if (curLvl >= t.targetLevel) return false;
            return activityXpForSkill(activity, activity.baselineRate, t.skill) > 0;
        }
        case 'quest': {
            if (t.account && t.account.toLowerCase() !== acct.name.toLowerCase()) return false;
            if (cachedHasCompletedQuest(acct, t.questSlug, acctCache)) return false;
            return activity.family === 'quest'
                && activity.questSlug?.toLowerCase() === t.questSlug.toLowerCase();
        }
        case 'coins': {
            if (t.account && t.account.toLowerCase() !== acct.name.toLowerCase()) return false;
            // PvP gold is a model guess in the Wilderness, where each run risks the account's kit and life: the PK
            // army goals (pk_army, squad_supply) send PvP work, never a coin demand.
            return activity.family !== 'pvp' && activity.baselineRate.gpPerTick > 0;
        }
        case 'combat_readiness': {
            if (activity.family === 'quest') return false;
            if (t.account.toLowerCase() !== acct.name.toLowerCase()) return false;
            let combatTargetsMet = true;
            for (const [skill, targetLvl] of Object.entries(t.targets)) {
                if (cachedAccountSkillLevel(acct, skill, acctCache) < targetLvl) {
                    combatTargetsMet = false;
                    if (activityXpForSkill(activity, activity.baselineRate, skill) > 0) {
                        return true;
                    }
                }
            }
            return combatTargetsMet && (activity.family === 'pvp' || activity.family === 'combat');
        }
    }
}

function selectWorkTrainingTarget(
    acct: AccountState,
    demand: GoalDemand,
    activity: ActivityDefinition,
    rate: RateEstimate,
    acctCache?: AccountLookupCache,
): { trainSkill?: string; targetLevel?: number } {
    if (demand.target.kind === 'skill') {
        return { trainSkill: demand.target.skill, targetLevel: demand.target.targetLevel };
    }
    if (demand.target.kind === 'combat_readiness') {
        let bestSkill: string | undefined;
        let bestTarget = 0;
        let bestLevel = Infinity;
        for (const [sk, tgt] of Object.entries(demand.target.targets)) {
            const curLvl = cachedAccountSkillLevel(acct, sk, acctCache);
            if (curLvl < tgt && activityXpForSkill(activity, rate, sk) > 0) {
                if (curLvl < bestLevel || (curLvl === bestLevel && bestSkill !== undefined && sk.localeCompare(bestSkill) < 0)) {
                    bestSkill = sk;
                    bestTarget = tgt;
                    bestLevel = curLvl;
                }
            }
        }
        if (bestSkill !== undefined) {
            return { trainSkill: bestSkill, targetLevel: bestTarget };
        }
    }
    return {};
}

function accountSkillXp(acct: AccountState, skill: string, acctCache?: AccountLookupCache): number {
    return cachedAccountSkillXp(acct, skill, acctCache);
}

function lookupSkillTarget(targets: Readonly<Record<string, number>>, skill: string): number | undefined {
    const direct = targets[skill];
    if (typeof direct === 'number') return direct;
    const lower = skill.toLowerCase();
    for (const [k, v] of Object.entries(targets)) {
        if (k.toLowerCase() === lower) return v;
    }
    return undefined;
}

function resolveBatchUnits(
    acct: AccountState,
    demand: GoalDemand,
    activity: ActivityDefinition,
    rate: RateEstimate,
    xpRate: number,
    acctCache?: AccountLookupCache,
): number {
    const minUnits = Math.max(1, rate.minBatchUnits);
    const t = demand.target;
    if (t.kind === 'quest') return 1;
    if (t.kind === 'item') {
        const outPerUnit = activity.outputs?.find((o) => o.itemId === t.itemId)?.countPerUnit
            ?? activity.baselineRate.outputsPerUnit?.[t.itemId]
            ?? 1;
        const needed = Math.ceil(demand.remaining / Math.max(0.01, outPerUnit));
        return Math.max(minUnits, Math.min(needed, 2000));
    }
    if (t.kind === 'coins') {
        const gpPerUnit = rate.unitsPerTick > 0 ? rate.gpPerTick / rate.unitsPerTick : 100;
        const needed = gpPerUnit > 0 ? Math.ceil(demand.remaining / gpPerUnit) : minUnits;
        return Math.max(minUnits, Math.min(needed, 2000));
    }
    if (t.kind === 'skill') {
        const curXp = accountSkillXp(acct, t.skill, acctCache);
        const remXp = Math.max(1, (t.targetXp ?? xpForLevel(t.targetLevel)) - curXp);
        const xpPerUnit = rate.unitsPerTick > 0 ? (rate.xpPerTick * xpRate) / rate.unitsPerTick : 25;
        const needed = Math.ceil(remXp / Math.max(1, xpPerUnit));
        return Math.max(minUnits, Math.min(needed, 5000));
    }
    return Math.max(minUnits, 250);
}

function estimateRemainingBandXp(
    acct: AccountState,
    demand: GoalDemand,
    activity: ActivityDefinition,
    trainSkill?: string,
    targetLevel?: number,
    acctCache?: AccountLookupCache,
): number {
    if (demand.target.kind === 'skill') {
        const curXp = accountSkillXp(acct, demand.target.skill, acctCache);
        const targetXp = demand.target.targetXp ?? xpForLevel(demand.target.targetLevel);
        return Math.max(0, targetXp - curXp);
    }
    if (demand.target.kind === 'combat_readiness') {
        const sk = trainSkill ?? activity.skill;
        if (sk) {
            const targetLvl = targetLevel ?? lookupSkillTarget(demand.target.targets, sk) ?? 99;
            const curXp = accountSkillXp(acct, sk, acctCache);
            return Math.max(0, xpForLevel(targetLvl) - curXp);
        }
        return 0;
    }
    const sk = trainSkill ?? activity.skill;
    if (sk) {
        const cur = cachedAccountSkillLevel(acct, sk, acctCache);
        if (cur >= 99) return 0;
        const nextBand = Math.min(99, cur + 10);
        const curXp = accountSkillXp(acct, sk, acctCache);
        return Math.max(0, xpForLevel(nextBand) - curXp);
    }
    return 0;
}

function activityDemandThroughput(
    activity: ActivityDefinition,
    demand: GoalDemand,
    rate: RateEstimate,
): number {
    const t = demand.target;
    switch (t.kind) {
        case 'item': {
            const outPerUnit = activity.outputs?.find((o) => o.itemId === t.itemId)?.countPerUnit
                ?? rate.outputsPerUnit?.[t.itemId]
                ?? 1;
            return Math.max(0, rate.unitsPerTick * outPerUnit);
        }
        case 'skill': {
            const xp = activityXpForSkill(activity, rate, t.skill);
            return Math.max(0, xp);
        }
        case 'combat_readiness':
            return rate.xpPerTick > 0 ? rate.xpPerTick : Math.max(0, rate.gpPerTick);
        case 'coins':
            return Math.max(0, rate.gpPerTick);
        case 'quest':
            return Math.max(0, rate.unitsPerTick);
    }
}

export function planAccount(
    acct: AccountState,
    input: AccountPlannerInput,
): AccountPlan {
    return planAccountCore(acct, input, false).bestPlan;
}

export function planAccountWithCandidates(
    acct: AccountState,
    input: AccountPlannerInput,
): { readonly bestPlan: AccountPlan; readonly candidates: readonly AccountPlan[] } {
    return planAccountCore(acct, input, true);
}

function planAccountCore(
    acct: AccountState,
    input: AccountPlannerInput,
    collectCandidates: boolean,
): { readonly bestPlan: AccountPlan; readonly candidates: readonly AccountPlan[] } {
    const { world } = input;
    const now = world.at;
    const campaigns = input.campaigns ?? [];
    const defects = input.defects ?? [];
    const ticksPerHour = input.ticksPerHour ?? TICKS_PER_HOUR;
    const xpRate = input.xpRate ?? 1;

    if (acct.lifecycle === 'paused_owner') {
        return { bestPlan: { account: acct.name, steps: [], scorePerHour: 0, idleReason: 'paused_owner' }, candidates: [] };
    }
    if (acct.lifecycle === 'dead') {
        return { bestPlan: { account: acct.name, steps: [], scorePerHour: 0, idleReason: 'dead' }, candidates: [] };
    }
    if (acct.lifecycle === 'in_trade') {
        return { bestPlan: { account: acct.name, steps: [], scorePerHour: 0, idleReason: 'in_trade' }, candidates: [] };
    }

    const holdReason = hasBlockingSystemHold(acct, now);
    if (holdReason) {
        return { bestPlan: { account: acct.name, steps: [], scorePerHour: 0, idleReason: holdReason }, candidates: [] };
    }

    const acctLower = acct.name.toLowerCase();
    const reuse = input._reuse
        && input._reuse.acctNameLower === acctLower
        && input._reuse.worldAt === now
        && input._reuse.acctRef === acct
        && input._reuse.worldRef === world
        && (!input.campaigns || input._reuse.campaignsRef === input.campaigns)
        ? input._reuse
        : undefined;

    const protection = reuse ? reuse.protection : canProtectedAccountLaunch(acct, campaigns, world);
    if (!protection.allowed) {
        return {
            bestPlan: {
                account: acct.name,
                steps: [],
                scorePerHour: 0,
                idleReason: protection.reason ?? 'protected_clock_reserved',
            },
            candidates: [],
        };
    }

    // Recovery lifecycles always emit a recovery chain first.
    if (acct.lifecycle === 'needs_logout_recovery') {
        const recStep: RecoverPlannedStep = {
            stepKind: 'recover',
            recoveryKind: 'logout',
            estimatedTicks: 20,
            reason: 'unsettled session logout proof',
        };
        const p: AccountPlan = {
            account: acct.name,
            steps: [recStep],
            scorePerHour: 1e6,
        };
        return { bestPlan: p, candidates: [p] };
    }

    if (acct.lifecycle === 'needs_location_recovery') {
        // Inside a walled place no walk reaches a hub: the reason names the quest exit, which worker-routing.ts
        // dispatches to the quest worker in place of the hub walk.
        const walled = walledInAt(acct.pos ?? null, acct.quests);
        const recStep: RecoverPlannedStep = {
            stepKind: 'recover',
            recoveryKind: 'location',
            targetHub: nearestHub(acct.pos),
            estimatedTicks: 60,
            reason: walled ? walledRecoveryReason(walled) : 'stranded off-hub or non-ground plane',
        };
        const p: AccountPlan = {
            account: acct.name,
            steps: [recStep],
            scorePerHour: 5e5,
        };
        return { bestPlan: p, candidates: [p] };
    }

    const minTrust: TrustTier = input.minTrust ?? 'practice_passed';
    const acctCache = reuse ? reuse.acctCache : createAccountLookupCache(acct, world, DEFAULT_OPERATING_COIN_FLOAT);
    const profile = reuse ? reuse.profile : summarizeAccountProfile(acct, acctCache);
    const isProtected = Boolean(acct.protectedClock || isProtectedAccountName(acct.name));
    const ownQuarantinedIds = accountOnlyQuarantinedIds(defects, acct.name, now, accountClassLevels(acct));
    const excludedActivityIds: ReadonlySet<string> | undefined = ownQuarantinedIds.size === 0
        ? input.excludedActivityIds
        : new Set([...(input.excludedActivityIds ?? []), ...ownQuarantinedIds]);
    const hasActExclusions = Boolean(excludedActivityIds?.size || input.excludedSpotIds?.size);
    const isActAllowed = (act: ActivityDefinition): boolean =>
        (!excludedActivityIds || !excludedActivityIds.has(act.id))
        && (!act.spotId || !input.excludedSpotIds || !input.excludedSpotIds.has(act.spotId));

    const shared = input._sharedIndex && !isProtected && (!input.allowExperimentalFallback || !hasActExclusions)
        ? input._sharedIndex
        : undefined;

    let eligibleActivities: readonly ActivityDefinition[];
    let nonExpByOutputItem: Pick<ReadonlyMap<number, readonly ActivityDefinition[]>, 'get'>;
    let byOutputItem: ReadonlyMap<number, readonly ActivityDefinition[]>;
    let bySkill: ReadonlyMap<string, readonly ActivityDefinition[]>;
    let questsBySlug: ReadonlyMap<string, readonly ActivityDefinition[]>;
    let gpActivities: readonly ActivityDefinition[];
    let combatOrPvpActivities: readonly ActivityDefinition[];
    let shopBuyActivity: ActivityDefinition | undefined;
    let geBuyActivity: ActivityDefinition | undefined;
    let sortedIdleDonors: readonly AccountState[];

    if (shared) {
        eligibleActivities = hasActExclusions ? shared.eligibleActivities.filter(isActAllowed) : shared.eligibleActivities;
        nonExpByOutputItem = hasActExclusions
            ? {
                  get: (id: number) => {
                      const list = shared.nonExpByOutputItem.get(id);
                      return list ? list.filter(isActAllowed) : undefined;
                  },
              }
            : shared.nonExpByOutputItem;
        byOutputItem = shared.byOutputItem;
        bySkill = shared.bySkill;
        questsBySlug = shared.questsBySlug;
        gpActivities = shared.gpActivities;
        combatOrPvpActivities = shared.combatOrPvpActivities;
        shopBuyActivity = shared.shopBuyActivity && (!hasActExclusions || isActAllowed(shared.shopBuyActivity))
            ? shared.shopBuyActivity
            : undefined;
        geBuyActivity = shared.geBuyActivity && (!hasActExclusions || isActAllowed(shared.geBuyActivity))
            ? shared.geBuyActivity
            : undefined;
        sortedIdleDonors = input.excludedDonorAccounts?.size
            ? shared.allIdleDonors.filter((d) => !input.excludedDonorAccounts!.has(d.name.toLowerCase()))
            : shared.allIdleDonors;
    } else {
        const candidateActivities = input.activities.filter((act) => {
            if (!isActAllowed(act)) return false;
            if (isActivityQuarantined(act.id, defects, now, acct.name, accountClassLevels(acct))) return false;
            if (!trustMeetsMinimum(act.trust, minTrust)) {
                if (!input.allowExperimentalFallback) return false;
            }
            if (isProtected && act.protectedAllowed !== true) {
                return false;
            }
            return true;
        });

        eligibleActivities = candidateActivities.some((a) => trustMeetsMinimum(a.trust, minTrust))
            ? candidateActivities.filter((a) => trustMeetsMinimum(a.trust, minTrust))
            : candidateActivities;

        const built = indexEligibleActivities(eligibleActivities);
        nonExpByOutputItem = built.nonExpByOutputItem;
        byOutputItem = built.byOutputItem;
        bySkill = built.bySkill;
        questsBySlug = built.questsBySlug;
        gpActivities = built.gpActivities;
        combatOrPvpActivities = built.combatOrPvpActivities;
        shopBuyActivity = built.shopBuyActivity;
        geBuyActivity = built.geBuyActivity;
        sortedIdleDonors = Object.values(world.accounts)
            .filter((d) =>
                d.lifecycle === 'idle'
                && d.bank.trusted
                && !d.protectedClock
                && !isProtectedAccountName(d.name)
                && !input.excludedDonorAccounts?.has(d.name.toLowerCase()),
            )
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    const acquireCtx: AcquireContext = {
        world,
        activities: eligibleActivities,
        marketQuotes: input.marketQuotes,
        requireMarketQuote: input.requireMarketQuote,
        donorDemandItemIds: input.donorDemandItemIds,
        recentReceivedAt: input.recentReceivedAt,
        confirmedLogoutAt: input.confirmedLogoutAt,
        requireConfirmedLogoutForTransfer: input.requireConfirmedLogoutForTransfer,
        excludedDonorAccounts: input.excludedDonorAccounts,
        excludedSources: input.excludedAcquireSources,
        excludedMarketVenues: input.excludedMarketVenues,
        _cachedByOutputItem: nonExpByOutputItem,
        _sortedIdleDonors: sortedIdleDonors,
        _idleDonorsByItemId: shared?.idleDonorsByItemId,
        _acctCache: acctCache,
        _skipDiagnostics: true,
    };

    const candidateListForDemand = (demand: GoalDemand): readonly ActivityDefinition[] => {
        if (demand.assignedAccount && demand.assignedAccount.toLowerCase() !== acctLower) {
            return [];
        }
        const t = demand.target;
        switch (t.kind) {
            case 'item':
                return byOutputItem.get(t.itemId) ?? [];
            case 'quest':
                if (t.account && t.account.toLowerCase() !== acctLower) return [];
                if (cachedHasCompletedQuest(acct, t.questSlug, acctCache)) return [];
                return questsBySlug.get(t.questSlug.toLowerCase()) ?? [];
            case 'skill': {
                if (t.account.toLowerCase() !== acctLower) return [];
                if (cachedAccountSkillLevel(acct, t.skill, acctCache) >= t.targetLevel) return [];
                return bySkill.get(t.skill.toLowerCase()) ?? [];
            }
            case 'coins':
                if (t.account && t.account.toLowerCase() !== acctLower) return [];
                return gpActivities;
            case 'combat_readiness': {
                if (t.account.toLowerCase() !== acctLower) return [];
                const set = new Set<ActivityDefinition>();
                let allMet = true;
                for (const sk in t.targets) {
                    if (!Object.hasOwn(t.targets, sk)) continue;
                    const targetLvl = t.targets[sk]!;
                    if (cachedAccountSkillLevel(acct, sk, acctCache) < targetLvl) {
                        allMet = false;
                        for (const act of bySkill.get(sk.toLowerCase()) ?? []) set.add(act);
                    }
                }
                if (allMet) {
                    for (const act of combatOrPvpActivities) set.add(act);
                }
                return [...set];
            }
        }
    };

    const acctProtectedAllowed = protection.allowed;
    const rateCache = reuse ? reuse.rateCache : new Map<string, RateEstimate>();
    const getRate = (activity: ActivityDefinition): RateEstimate => {
        let r = rateCache.get(activity.id);
        if (!r) {
            r = input.rateStore
                ? input.rateStore.estimate(activity.id, acct, world)
                : input.rateEstimator
                    ? input.rateEstimator.estimate(activity, acct, world)
                    : activity.baselineRate;
            rateCache.set(activity.id, r);
        }
        return r;
    };

    const preflightCache = reuse ? reuse.preflightCache : new Map<string, PreflightResult>();
    const getPreflight = (activity: ActivityDefinition, batchUnits: number): PreflightResult => {
        const key = activity.inputs && activity.inputs.length > 0 ? `${activity.id}:${batchUnits}` : activity.id;
        let p = preflightCache.get(key);
        if (!p) {
            p = activityPreflightFromConfig(
                acct,
                activity,
                world,
                batchUnits,
                {
                    protectedAllowed: acctProtectedAllowed && (activity.protectedAllowed || !acct.protectedClock),
                    _acctCache: acctCache,
                },
            );
            preflightCache.set(key, p);
        }
        return p;
    };

    const acquireCache = new Map<string, AcquireResolution>();
    const resolveAcquireCached = (req: AcquireRequest): AcquireResolution => {
        const key = `${req.itemId}:${req.itemName ?? ''}:${req.quantity}:${req.allowOwnBank ?? true}:${req.includeInventoryInOwned ?? true}:${req.operatingCoinFloat ?? DEFAULT_OPERATING_COIN_FLOAT}:${req.committedCoinSpend ?? 0}:${req.allowedSources?.join(',') ?? ''}:${req.maxUnitPrice ?? ''}:${req.questPoints ?? 0}:${req.allowPartial ?? false}`;
        let res = acquireCache.get(key);
        if (!res) {
            res = resolveAcquireItem(acct, req, acquireCtx);
            acquireCache.set(key, res);
        }
        return res;
    };

    const nonHolderSurplusCache = new Map<string, number>();
    const getFleetNonHolderSurplus = (itemId: number, holderLower: string): number => {
        const key = `${itemId}:${holderLower}`;
        const hit = nonHolderSurplusCache.get(key);
        if (hit !== undefined) return hit;
        let total = 0;
        for (const a of Object.values(world.accounts)) {
            if (a.protectedClock || isProtectedAccountName(a.name)) continue;
            if (a.lifecycle === 'paused_owner' || a.lifecycle === 'dead') continue;
            const aLower = a.name.toLowerCase();
            if (aLower === holderLower) continue;
            const owned = accountOwnedItemCount(a, itemId, { includeBank: true, requireTrustedBank: true });
            if (owned <= 0) continue;
            const reserved = aLower === acctLower
                ? cachedEffectiveItemReserve(acct, world, itemId, acctCache)
                : effectiveItemReserve(a, world, itemId);
            if (owned > reserved) total += owned - reserved;
        }
        nonHolderSurplusCache.set(key, total);
        return total;
    };

    let localWeapons: PrecomputedWeaponInfo | undefined;
    const getPrecomputedWeapons = reuse
        ? reuse.getPrecomputedWeapons
        : (): PrecomputedWeaponInfo => {
            if (!localWeapons) localWeapons = precomputeWearableWeapons(acct, acctCache);
            return localWeapons;
        };
    const upgradeCache = new Map<string, GearUpgradeCandidateResult | null>();
    const upgradeCandidatesCache = new Map<string, readonly ResolvedGearUpgradeCandidate[]>();
    // Train activities for a skill unlock, most XP per tick first. An activity whose only blocker for one
    // unit is a missing input stays a candidate: the unlock can buy its inputs.
    const skillUnlockCache = new Map<string, readonly { activity: ActivityDefinition; rate: RateEstimate }[]>();
    const skillUnlockCandidates = (skill: string): readonly { activity: ActivityDefinition; rate: RateEstimate }[] => {
        const skLower = skill.toLowerCase();
        let candidates = skillUnlockCache.get(skLower);
        if (candidates === undefined) {
            candidates = [...new Set(bySkill.get(skLower) ?? [])]
                .filter((a) => {
                    if ((shared && hasActExclusions && !isActAllowed(a)) || a.family === 'quest') return false;
                    if (activityXpForSkill(a, getRate(a), skill) <= 0) return false;
                    const one = getPreflight(a, 1);
                    return one.ok || ((a.inputs?.length ?? 0) > 0 && one.blockers.every((b) => b.kind === 'missing_supply'));
                })
                .sort((a, b) => {
                    const xpDiff = activityXpForSkill(b, getRate(b), skill) - activityXpForSkill(a, getRate(a), skill);
                    if (xpDiff !== 0) return xpDiff;
                    return getRate(a).setupTicks - getRate(b).setupTicks || a.id.localeCompare(b.id);
                })
                .map((a) => ({ activity: a, rate: getRate(a) }));
            skillUnlockCache.set(skLower, candidates);
        }
        return candidates;
    };
    type SkillUnlockChoice = {
        readonly activity: ActivityDefinition;
        readonly rate: RateEstimate;
        readonly batchUnits?: number;
        readonly prep: readonly PlannedStep[];
        readonly prepCoins: number;
    };
    const skillUnlockChoiceCache = new Map<string, SkillUnlockChoice | null>();
    // An unlock that trains on inputs makes the units for the XP that it needs, so the plan must hold
    // those inputs. The first pass takes a candidate that the bank (or no input) covers; the second buys
    // the shortfall, in at most acquireRoom steps. A candidate that it cannot supply is skipped, and so is
    // one that uses an input of the work activity.
    const chooseSkillUnlock = (
        skill: string,
        needXp: number,
        work: ActivityDefinition,
        acquireRoom: number,
        committed: number,
    ): SkillUnlockChoice | null => {
        const workInputs = new Set((work.inputs ?? []).map((io) => io.itemId));
        const key = `${skill.toLowerCase()}:${Math.ceil(needXp)}:${acquireRoom}:${committed}:${[...workInputs].sort((a, b) => a - b).join(',')}`;
        const hit = skillUnlockChoiceCache.get(key);
        if (hit !== undefined) return hit;
        let choice: SkillUnlockChoice | null = null;
        const candidates = skillUnlockCandidates(skill);
        for (const pass of ['stock', 'buy'] as const) {
            for (const { activity: a, rate: r } of candidates) {
                const inputs = (a.inputs ?? []).filter((io) => io.countPerUnit > 0);
                if (inputs.length === 0) {
                    if (pass === 'stock' && getPreflight(a, 1).ok) choice = { activity: a, rate: r, prep: [], prepCoins: 0 };
                    if (choice) break;
                    continue;
                }
                if (inputs.some((io) => workInputs.has(io.itemId))) continue;
                const xpPerUnit = activityXpPerUnit(a, r, skill) * xpRate;
                if (!(xpPerUnit > 0)) continue;
                const units = Math.max(1, r.minBatchUnits, Math.ceil(needXp / xpPerUnit));
                const pre = getPreflight(a, units);
                if (pass === 'stock') {
                    if (pre.ok) choice = { activity: a, rate: r, batchUnits: units, prep: [], prepCoins: 0 };
                    if (choice) break;
                    continue;
                }
                if (pre.ok || pre.blockers.length > acquireRoom) continue;
                const prep: PlannedStep[] = [];
                let coins = 0;
                for (const b of pre.blockers) {
                    if (b.kind !== 'missing_supply') break;
                    const acq = resolveAcquireCached({
                        itemId: b.itemId,
                        itemName: b.itemName,
                        quantity: Math.max(1, b.required - b.available),
                        allowOwnBank: false,
                        operatingCoinFloat: DEFAULT_OPERATING_COIN_FLOAT,
                        committedCoinSpend: committed + coins,
                    });
                    if (!acq.ok || !acq.step) break;
                    // The owned total after the purchase: a chain rerun that finds it buys nothing.
                    prep.push({ ...acq.step, stockTarget: Math.max(1, b.required + b.reserved), ...(b.owned !== undefined ? { ownedBefore: b.owned } : {}) });
                    coins += stepCommittedCoinCost(acq.step);
                }
                if (prep.length === pre.blockers.length) {
                    choice = { activity: a, rate: r, batchUnits: units, prep, prepCoins: coins };
                    break;
                }
            }
            if (choice) break;
        }
        skillUnlockChoiceCache.set(key, choice);
        return choice;
    };

    const hasLiveMarketQuotes = Boolean(input.marketQuotes && Object.keys(input.marketQuotes).length > 0);
    const directGeBuyActivity = hasLiveMarketQuotes ? geBuyActivity : undefined;
    const shopCatalog = loadShopCatalogByItem();
    const itemsMap = loadItemsMap();
    const defaultSpendableCoins = acctCache.defaultSpendableCoins.spendable;

    let bestPlan: AccountPlan | null = null;
    const demandCandidates: AccountPlan[] = [];
    let lastBlockerReason = 'no_matching_demand_or_activity';

    for (const demand of input.demands) {
        if (!demand.active || demand.remaining <= 0) continue;
        if (demand.assignedAccount && demand.assignedAccount.toLowerCase() !== acctLower) continue;

        let effectiveDemand = demand;
        let consolidateCandidate: AccountPlan | null = null;
        if (demand.target.kind === 'item' && demand.target.holder) {
            const holderLower = demand.target.holder.toLowerCase();
            const targetItemId = demand.target.itemId;
            if (acctLower !== holderLower) {
                const fleetNonHolderSurplus = getFleetNonHolderSurplus(targetItemId, holderLower);
                const unownedShortfall = Math.max(0, demand.remaining - fleetNonHolderSurplus);
                if (unownedShortfall <= 0) {
                    continue;
                }
                if (unownedShortfall < demand.remaining) {
                    effectiveDemand = { ...demand, remaining: unownedShortfall };
                }
            } else if (
                !input.excludedAcquireSources?.has('hub_banker')
                && !acct.protectedClock
                && !isProtectedAccountName(acct.name)
            ) {
                const hubAcq = resolveAcquireCached({
                    itemId: targetItemId,
                    itemName: demand.target.itemName,
                    quantity: Math.max(1, Math.round(demand.remaining)),
                    allowOwnBank: false,
                    allowedSources: ['hub_banker'],
                    allowPartial: true,
                    operatingCoinFloat: DEFAULT_OPERATING_COIN_FLOAT,
                });
                if (hubAcq.ok && hubAcq.step && hubAcq.step.source === 'hub_banker') {
                    const hubStep = hubAcq.step;
                    const advMult = comparativeAdvantageMultiplier(acct, demand, HUB_CONSOLIDATION_ACTIVITY, profile, acctCache);
                    if (advMult > 0) {
                        const baseVph = demand.valuePerHour ?? (demand.valueScore * demand.priorityWeight);
                        const baselineMarketTicks = Math.max(120, Math.min(3_000, hubStep.quantity * 0.25 + 120));
                        const speedEff = Math.min(1.25, baselineMarketTicks / Math.max(60, hubStep.estimatedTicks));
                        const scorePerHour = Math.max(0, baseVph * advMult * speedEff * 1.25);
                        consolidateCandidate = {
                            account: acct.name,
                            demandId: demand.id,
                            steps: [hubStep],
                            scorePerHour,
                        };
                    }
                }
            }
        }

        const rawCandidates = candidateListForDemand(effectiveDemand);
        const needsMatchCheck = effectiveDemand.target.kind === 'skill' || effectiveDemand.target.kind === 'combat_readiness';
        const needFilter = (shared && hasActExclusions) || needsMatchCheck;
        const matching = needFilter
            ? rawCandidates.filter(
                  (a) => (!shared || !hasActExclusions || isActAllowed(a))
                      && (!needsMatchCheck || activityMatchesDemand(acct, effectiveDemand, a, acctCache)),
              )
            : rawCandidates;
        const canMarketBuy = effectiveDemand.target.kind === 'item'
            && defaultSpendableCoins > 0
            && Boolean(shopBuyActivity || directGeBuyActivity);
        if (matching.length === 0 && !canMarketBuy && !consolidateCandidate) continue;

        let bestThroughput = 0;
        for (const act of matching) {
            const tp = activityDemandThroughput(act, effectiveDemand, getRate(act));
            if (tp > bestThroughput) bestThroughput = tp;
        }

        let demandBest: AccountPlan | null = consolidateCandidate;
        if (consolidateCandidate && (!bestPlan || consolidateCandidate.scorePerHour > bestPlan.scorePerHour)) {
            bestPlan = consolidateCandidate;
        }

        const marketCandidates: {
            readonly marketAct: ActivityDefinition;
            readonly source: 'npc_shop' | 'ge';
            readonly advMult: number;
            readonly quantity: number;
            readonly workTicks: number;
            readonly throughput: number;
            readonly shopId?: string;
            readonly itemName?: string;
            readonly estimatedCoinCost: number;
            readonly coinFloatPreserved: number;
        }[] = [];

        if (
            effectiveDemand.target.kind === 'item'
            && defaultSpendableCoins > 0
            && (shopBuyActivity || directGeBuyActivity)
        ) {
            const targetItemId = effectiveDemand.target.itemId;
            const hasShop = Boolean(shopBuyActivity && (shopCatalog.has(targetItemId) || acquireCtx.customShops?.some((s) => s.itemId === targetItemId)));
            const itemMetaForGe = directGeBuyActivity ? itemsMap.get(targetItemId) : undefined;
            const geQuote = input.marketQuotes?.[targetItemId];
            const hasGe = Boolean(
                directGeBuyActivity
                && (!itemMetaForGe || itemMetaForGe.tradeable)
                && isValidGeAskQuote(geQuote, itemMetaForGe?.cost ?? 1, 1),
            );
            if (hasShop || hasGe) {
                const allowedExternal: AcquireSourceKind[] = [];
                if (shopBuyActivity) allowedExternal.push('npc_shop');
                if (directGeBuyActivity) allowedExternal.push('ge');
                const demandQty = Math.max(1, Math.min(Math.round(effectiveDemand.remaining), 2000));
                const maxQty = !hasShop && hasGe && geQuote
                    ? Math.max(1, Math.min(demandQty, Math.floor(geQuote.sell)))
                    : demandQty;
                let acq = resolveAcquireCached({
                    itemId: targetItemId,
                    itemName: effectiveDemand.target.itemName,
                    quantity: maxQty,
                    allowOwnBank: false,
                    allowPartial: true,
                    allowedSources: allowedExternal,
                    operatingCoinFloat: DEFAULT_OPERATING_COIN_FLOAT,
                });
                if (!acq.ok && maxQty > 1) {
                    const spendable = defaultSpendableCoins;
                    if (spendable > 0) {
                        let minUnitPrice = Number.POSITIVE_INFINITY;
                        if (hasShop) {
                            const shops = [
                                ...(acquireCtx.customShops ?? []).filter((s) => s.itemId === targetItemId),
                                ...(shopCatalog.get(targetItemId) ?? []),
                            ];
                            for (const shop of shops) {
                                if (input.excludedMarketVenues?.has(marketCooldownKey(targetItemId, `shop:${shop.shop}`))) continue;
                                if (shop.requiresQuest && !cachedHasCompletedQuest(acct, shop.requiresQuest, acctCache)) continue;
                                if (shop.requiresSkill && cachedAccountSkillLevel(acct, shop.requiresSkill.skill, acctCache) < shop.requiresSkill.level) continue;
                                if (shop.requiresQuestPoints) continue;
                                if (shop.cost > 0 && shop.cost < minUnitPrice) minUnitPrice = shop.cost;
                            }
                        }
                        if (hasGe && !input.excludedMarketVenues?.has(marketCooldownKey(targetItemId, 'ge'))) {
                            minUnitPrice = Math.min(minUnitPrice, Math.ceil(Math.ceil(geQuote!.ask!) * GE_LIMIT_BUFFER));
                        }
                        if (Number.isFinite(minUnitPrice) && minUnitPrice > 0) {
                            const affordableQty = Math.min(maxQty, Math.floor(spendable / minUnitPrice));
                            if (affordableQty >= 1 && affordableQty < maxQty) {
                                acq = resolveAcquireCached({
                                    itemId: targetItemId,
                                    itemName: effectiveDemand.target.itemName,
                                    quantity: affordableQty,
                                    allowOwnBank: false,
                                    allowPartial: true,
                                    allowedSources: allowedExternal,
                                    operatingCoinFloat: DEFAULT_OPERATING_COIN_FLOAT,
                                });
                            }
                        }
                    }
                }
                const npcCand = acq.candidates.find((c) => c.source === 'npc_shop');
                const geCand = acq.candidates.find((c) => c.source === 'ge');
                const npcUnitCost = npcCand ? npcCand.step.estimatedCoinCost / Math.max(1, npcCand.step.quantity) : Infinity;
                const geUnitCost = geCand ? geCand.step.estimatedCoinCost / Math.max(1, geCand.step.quantity) : Infinity;
                for (const cand of acq.candidates) {
                    if (cand.source !== 'npc_shop' && cand.source !== 'ge') continue;
                    // Prefer deterministic NPC shop over speculative GE when shop unit cost is <= GE unit cost.
                    if (cand.source === 'ge' && npcCand && npcUnitCost <= geUnitCost) continue;
                    const marketAct = cand.source === 'npc_shop' ? shopBuyActivity : directGeBuyActivity;
                    if (!marketAct) continue;
                    const advMult = comparativeAdvantageMultiplier(acct, effectiveDemand, marketAct, profile, acctCache);
                    if (advMult <= 0) continue;
                    const workTicks = Math.max(1, Math.ceil(cand.step.estimatedTicks));
                    const throughput = cand.step.quantity / workTicks;
                    if (throughput > bestThroughput) bestThroughput = throughput;
                    marketCandidates.push({
                        marketAct,
                        source: cand.source,
                        advMult,
                        quantity: cand.step.quantity,
                        workTicks,
                        throughput,
                        ...(cand.step.shopId ? { shopId: cand.step.shopId } : {}),
                        ...(cand.step.itemName ? { itemName: cand.step.itemName } : {}),
                        estimatedCoinCost: cand.step.estimatedCoinCost,
                        coinFloatPreserved: cand.step.coinFloatPreserved,
                    });
                }
            }
        }

        for (const mc of marketCandidates) {
            const baseVph = effectiveDemand.valuePerHour ?? (effectiveDemand.valueScore * effectiveDemand.priorityWeight);
            const throughputRatio = bestThroughput > 0
                ? Math.max(0.25, Math.min(1.0, mc.throughput / bestThroughput))
                : 1.0;
            const baselineMarketTicks = Math.max(120, Math.min(3_000, mc.quantity * 0.25 + 120));
            const speedEfficiency = Math.min(1.25, baselineMarketTicks / Math.max(60, mc.workTicks));
            const coverageFactor = effectiveDemand.remaining > 0
                ? Math.max(0.25, Math.min(1.0, mc.quantity / Math.min(effectiveDemand.remaining, 250)))
                : 1.0;
            const scorePerHour = Math.max(0, baseVph * mc.advMult * speedEfficiency * throughputRatio * coverageFactor);
            if (demandBest && scorePerHour <= demandBest.scorePerHour) continue;
            const targetItemId = (effectiveDemand.target as { kind: 'item'; itemId: number }).itemId;
            const workStep: TargetWorkPlannedStep = {
                stepKind: 'work',
                activityId: mc.marketAct.id,
                demandId: effectiveDemand.id,
                workerId: mc.marketAct.workerId,
                batchUnits: mc.quantity,
                estimatedTicks: mc.workTicks,
                expectedValuePerHour: scorePerHour,
                config: {
                    ...mc.marketAct.config,
                    mode: mc.source === 'npc_shop' ? 'shop-buy' : 'ge-buy',
                    itemId: targetItemId,
                    ...(mc.itemName ? { itemName: mc.itemName } : {}),
                    quantity: mc.quantity,
                    ...(mc.shopId ? { shopId: mc.shopId } : {}),
                    estimatedCoinCost: mc.estimatedCoinCost,
                    coinFloatPreserved: mc.coinFloatPreserved,
                    batchUnits: mc.quantity,
                },
            };
            const candidatePlan: AccountPlan = {
                account: acct.name,
                demandId: effectiveDemand.id,
                steps: [workStep],
                scorePerHour,
            };
            if (!demandBest || scorePerHour > demandBest.scorePerHour) {
                demandBest = candidatePlan;
            }
            if (!bestPlan || scorePerHour > bestPlan.scorePerHour) {
                bestPlan = candidatePlan;
            }
        }

        for (const activity of matching) {
            const advMult = comparativeAdvantageMultiplier(acct, effectiveDemand, activity, profile, acctCache);
            if (advMult <= 0) continue;

            const rate = getRate(activity);
            let batchUnits = resolveBatchUnits(acct, effectiveDemand, activity, rate, xpRate, acctCache);
            let preflight = getPreflight(activity, batchUnits);

            let prepSteps: PlannedStep[] = [];
            let committedCoins = 0;
            let chainFeasible = true;
            for (let batchPass = 0; batchPass < 2; batchPass++) {
                prepSteps = [];
                committedCoins = 0;
                chainFeasible = true;
                let shrinkBatchTo: number | undefined;

                if (!preflight.ok) {
                // Resolve quest unlocks before skill requirements so quest XP rewards (e.g. Druidic Ritual -> Herblore 3)
                // can satisfy downstream skill gates in the same 2-step chain.
                const orderedBlockers = preflight.blockers.length <= 1
                    ? preflight.blockers
                    : [...preflight.blockers].sort((a, b) => {
                        const rank = (k: string) => (k === 'quest_incomplete' ? 0 : k === 'skill_level' ? 1 : 2);
                        return rank(a.kind) - rank(b.kind);
                    });
                const grantedQuestXp: Record<string, number> = {};
                for (const blocker of orderedBlockers) {
                    if (
                        blocker.kind === 'protected_clock'
                        || blocker.kind === 'max_level_cap'
                        || blocker.kind === 'cooldown_active'
                        || blocker.kind === 'capacity_full'
                        || blocker.kind === 'invalid_config'
                    ) {
                        lastBlockerReason = `${activity.id}:${blocker.kind}`;
                        chainFeasible = false;
                        break;
                    }

                    if (blocker.kind === 'skill_level') {
                        const curXp = cachedAccountSkillXp(acct, blocker.skill, acctCache);
                        const bonusXp = grantedQuestXp[blocker.skill.toLowerCase()] ?? 0;
                        if (levelForXp(curXp + bonusXp) >= blocker.required) {
                            continue;
                        }
                    }

                    if (prepSteps.length >= MAX_ACCOUNT_PLAN_STEPS - 1) {
                        lastBlockerReason = `${activity.id}:exceeds_${MAX_ACCOUNT_PLAN_STEPS}_steps`;
                        chainFeasible = false;
                        break;
                    }

                    if (blocker.kind === 'quest_incomplete') {
                        const unlockAct = (questsBySlug.get(blocker.quest.toLowerCase()) ?? []).find(
                            (a) => !shared || !hasActExclusions || isActAllowed(a),
                        );
                        if (!unlockAct) {
                            lastBlockerReason = `missing_quest_unlock:${blocker.quest}`;
                            chainFeasible = false;
                            break;
                        }
                        const unlockPre = getPreflight(unlockAct, 1);
                        if (!unlockPre.ok) {
                            lastBlockerReason = `quest_unlock_blocked:${blocker.quest}`;
                            chainFeasible = false;
                            break;
                        }
                        const qSlug = blocker.quest.toLowerCase();
                        const qRow = getQuestRowBySlug(qSlug);
                        if (qRow?.xp) {
                            for (const reward of qRow.xp) {
                                const sk = reward.skill.toLowerCase();
                                grantedQuestXp[sk] = (grantedQuestXp[sk] ?? 0) + reward.xp * SERVER_XP_MULTIPLIER * xpRate;
                            }
                        }
                        const unlockStep: UnlockPlannedStep = {
                            stepKind: 'unlock',
                            unlockKind: 'quest',
                            activityId: unlockAct.id,
                            questSlug: blocker.quest,
                            estimatedTicks: Math.max(
                                10,
                                Math.ceil(unlockAct.baselineRate.setupTicks + (unlockPre.travelTicks ?? 0) + 1 / Math.max(1e-4, unlockAct.baselineRate.unitsPerTick)),
                            ),
                        };
                        prepSteps.push(unlockStep);
                    } else if (blocker.kind === 'skill_level') {
                        const skLower = blocker.skill.toLowerCase();
                        if (skLower === 'herblore' && !cachedHasCompletedQuest(acct, 'druid', acctCache)) {
                            const druidAct = (questsBySlug.get('druid') ?? []).find(
                                (a) => !shared || !hasActExclusions || isActAllowed(a),
                            );
                            if (druidAct && getPreflight(druidAct, 1).ok && !prepSteps.some((s) => s.stepKind === 'unlock' && s.questSlug?.toLowerCase() === 'druid')) {
                                const druidPre = getPreflight(druidAct, 1);
                                const druidRow = getQuestRowBySlug('druid');
                                if (druidRow?.xp) {
                                    for (const reward of druidRow.xp) {
                                        const sk = reward.skill.toLowerCase();
                                        grantedQuestXp[sk] = (grantedQuestXp[sk] ?? 0) + reward.xp * SERVER_XP_MULTIPLIER * xpRate;
                                    }
                                }
                                prepSteps.push({
                                    stepKind: 'unlock',
                                    unlockKind: 'quest',
                                    activityId: druidAct.id,
                                    questSlug: 'druid',
                                    estimatedTicks: Math.max(
                                        10,
                                        Math.ceil(druidAct.baselineRate.setupTicks + (druidPre.travelTicks ?? 0) + 1 / Math.max(1e-4, druidAct.baselineRate.unitsPerTick)),
                                    ),
                                });
                                const curHerbXp = cachedAccountSkillXp(acct, blocker.skill, acctCache);
                                if (levelForXp(curHerbXp + (grantedQuestXp[skLower] ?? 0)) >= blocker.required) {
                                    continue;
                                }
                                if (prepSteps.length >= MAX_ACCOUNT_PLAN_STEPS - 1) {
                                    lastBlockerReason = `${activity.id}:exceeds_${MAX_ACCOUNT_PLAN_STEPS}_steps`;
                                    chainFeasible = false;
                                    break;
                                }
                            }
                        }

                        const curXp = cachedAccountSkillXp(acct, blocker.skill, acctCache);
                        const bonusXp = grantedQuestXp[skLower] ?? 0;
                        const needXp = Math.max(1, xpForLevel(blocker.required) - (curXp + bonusXp));
                        // One step stays for the unlock and one for the work.
                        const acquireRoom = MAX_ACCOUNT_PLAN_STEPS - 2 - prepSteps.length;
                        const choice = chooseSkillUnlock(blocker.skill, needXp, activity, acquireRoom, committedCoins);
                        if (!choice) {
                            lastBlockerReason = skillUnlockCandidates(blocker.skill).length > 0
                                ? `unlock_inputs_unavailable:${blocker.skill}`
                                : `missing_skill_unlock:${blocker.skill}`;
                            chainFeasible = false;
                            break;
                        }
                        const trainAct = choice.activity;
                        const trainRate = choice.rate;
                        const trainTicks = Math.max(
                            10,
                            Math.ceil(
                                choice.batchUnits !== undefined
                                    ? trainRate.setupTicks + choice.batchUnits / Math.max(1e-4, trainRate.unitsPerTick)
                                    : trainRate.setupTicks + needXp / Math.max(1e-3, activityXpForSkill(trainAct, trainRate, blocker.skill) * xpRate),
                            ),
                        );
                        for (const st of choice.prep) prepSteps.push(st);
                        committedCoins += choice.prepCoins;
                        const unlockStep: UnlockPlannedStep = {
                            stepKind: 'unlock',
                            unlockKind: 'skill',
                            activityId: trainAct.id,
                            skill: blocker.skill,
                            targetLevel: blocker.required,
                            ...(choice.batchUnits !== undefined ? { batchUnits: choice.batchUnits } : {}),
                            estimatedTicks: trainTicks,
                        };
                        prepSteps.push(unlockStep);
                    } else if (blocker.kind === 'missing_supply') {
                        // The preflight count already holds the pack and the own bank, so the own bank cannot
                        // supply the shortfall: a loadout of it only moves the same stock into a 28-slot pack.
                        const shortfall = Math.max(1, blocker.required - blocker.available);
                        const acq = resolveAcquireCached({
                            itemId: blocker.itemId,
                            itemName: blocker.itemName,
                            quantity: shortfall,
                            allowOwnBank: false,
                            operatingCoinFloat: DEFAULT_OPERATING_COIN_FLOAT,
                            committedCoinSpend: committedCoins,
                        });
                        if (!acq.ok || !acq.step) {
                            if (batchPass === 0 && batchUnits > rate.minBatchUnits) {
                                const partialAcq = resolveAcquireCached({
                                    itemId: blocker.itemId,
                                    itemName: blocker.itemName,
                                    quantity: shortfall,
                                    allowOwnBank: false,
                                    allowPartial: true,
                                    operatingCoinFloat: DEFAULT_OPERATING_COIN_FLOAT,
                                    committedCoinSpend: committedCoins,
                                });
                                const bought = partialAcq.ok && partialAcq.step && partialAcq.step.quantity < shortfall ? partialAcq.step.quantity : 0;
                                const capped = batchUnitsForStock(activity, blocker.itemId, blocker.available + bought, batchUnits, blocker.required);
                                if (capped >= rate.minBatchUnits && capped < batchUnits) {
                                    shrinkBatchTo = capped;
                                    chainFeasible = false;
                                    break;
                                }
                            }
                            lastBlockerReason = `unresolvable_supply:${blocker.itemId}`;
                            chainFeasible = false;
                            break;
                        }
                        // The owned total after the purchase: a rerun of the chain that finds it buys nothing.
                        prepSteps.push({ ...acq.step, stockTarget: Math.max(1, blocker.required + blocker.reserved), ...(blocker.owned !== undefined ? { ownedBefore: blocker.owned } : {}) });
                        committedCoins += stepCommittedCoinCost(acq.step);
                    } else if (blocker.kind === 'missing_coins') {
                        const shortfall = Math.max(1, blocker.required - blocker.available);
                        const acq = resolveAcquireCached({
                            itemId: 995,
                            itemName: 'Coins',
                            quantity: shortfall,
                            allowOwnBank: false,
                            operatingCoinFloat: DEFAULT_OPERATING_COIN_FLOAT,
                            committedCoinSpend: committedCoins,
                        });
                        if (!acq.ok || !acq.step) {
                            lastBlockerReason = `missing_coins:${shortfall}`;
                            chainFeasible = false;
                            break;
                        }
                        prepSteps.push(acq.step);
                        committedCoins += stepCommittedCoinCost(acq.step);
                    } else if (blocker.kind === 'combat_survivability') {
                        if (blocker.reason === 'food') {
                            const floor = activity.config?.combatSurvivability as CombatSurvivabilityFloor | undefined;
                            // An admission blocker (preflight.ts threatNpcIds) names the pieces that the fight needs.
                            const countNeed = Math.max(10, floor?.minFoodCount ?? 15, (blocker.message ?? '').startsWith('admission:') ? blocker.required ?? 0 : 0);
                            let foodStep: PlannedStep | null = null;
                            for (const fid of floor?.foodIds ?? STANDARD_FOOD_IDS) {
                                const acq = resolveAcquireCached({
                                    itemId: fid,
                                    quantity: countNeed,
                                    operatingCoinFloat: DEFAULT_OPERATING_COIN_FLOAT,
                                    committedCoinSpend: committedCoins,
                                });
                                if (acq.ok && acq.step) {
                                    foodStep = acq.step;
                                    break;
                                }
                            }
                            if (!foodStep) {
                                lastBlockerReason = 'missing_food_supply';
                                chainFeasible = false;
                                break;
                            }
                            prepSteps.push(foodStep);
                            committedCoins += stepCommittedCoinCost(foodStep);
                        } else {
                            lastBlockerReason = `combat_survivability:${blocker.reason}`;
                            chainFeasible = false;
                            break;
                        }
                    } else if (blocker.kind === 'unreachable_tile') {
                        if (blocker.reason === 'unknown_pos' || blocker.reason === 'plane_mismatch') {
                            const recStep: RecoverPlannedStep = {
                                stepKind: 'recover',
                                recoveryKind: 'location',
                                targetHub: nearestHub(acct.pos),
                                estimatedTicks: 60,
                                reason: blocker.message ?? `recover from ${blocker.reason}`,
                            };
                            prepSteps.push(recStep);
                        } else {
                            lastBlockerReason = `unreachable_tile:${blocker.reason ?? 'no_route'}`;
                            chainFeasible = false;
                            break;
                        }
                    }
                }
            }
                if (shrinkBatchTo !== undefined) {
                    batchUnits = shrinkBatchTo;
                    preflight = getPreflight(activity, batchUnits);
                    continue;
                }
                break;
            }

            if (!chainFeasible) continue;

            // Evaluate optional net XP/tick payback gear upgrade if step budget permits.
            let effectiveRate = rate;
            let upgrade: GearUpgradeCandidateResult | null | undefined;
            const preTrainTarget = selectWorkTrainingTarget(acct, effectiveDemand, activity, rate, acctCache);
            if (prepSteps.length < MAX_ACCOUNT_PLAN_STEPS - 1 && rate.xpPerTick > 0) {
                const remXp = estimateRemainingBandXp(acct, effectiveDemand, activity, preTrainTarget.trainSkill, preTrainTarget.targetLevel, acctCache);
                if (remXp > 0) {
                    const evalSkill = preTrainTarget.trainSkill ?? activity.skill ?? '';
                    const upgKey = `${activity.family}:${evalSkill}:${rate.xpPerTick}:${Math.round(remXp)}:${committedCoins}`;
                    upgrade = upgradeCache.get(upgKey);
                    if (upgrade === undefined) {
                        upgrade = evaluateBestGearUpgrade({
                            acct,
                            activity,
                            rate,
                            remainingXp: remXp,
                            acquireCtx,
                            trainingSkill: preTrainTarget.trainSkill,
                            precomputedWeapons: getPrecomputedWeapons(),
                            resolveAcquire: resolveAcquireCached,
                            committedCoinSpend: committedCoins,
                            _acctCache: acctCache,
                            _upgradeCandidatesCache: upgradeCandidatesCache,
                        });
                        upgradeCache.set(upgKey, upgrade);
                    }
                    if (upgrade) {
                        prepSteps.push(upgrade.step);
                        committedCoins += stepCommittedCoinCost(upgrade.step);
                        const upgScale = rate.xpPerTick > 0 ? upgrade.improvedXpPerTick / rate.xpPerTick : 1;
                        let scaledSkillXp: Record<string, number> | undefined;
                        if (rate.skillXpPerTick) {
                            scaledSkillXp = {};
                            for (const k in rate.skillXpPerTick) {
                                if (!Object.hasOwn(rate.skillXpPerTick, k)) continue;
                                scaledSkillXp[k] = rate.skillXpPerTick[k]! * upgScale;
                            }
                        }
                        effectiveRate = {
                            ...rate,
                            xpPerTick: upgrade.improvedXpPerTick,
                            ...(scaledSkillXp ? { skillXpPerTick: scaledSkillXp } : {}),
                        };
                    }
                }
            }

            if (prepSteps.length >= MAX_ACCOUNT_PLAN_STEPS) {
                lastBlockerReason = `${activity.id}:exceeds_max_steps`;
                continue;
            }

            const baseExecTicks = batchUnits / Math.max(1e-4, rate.unitsPerTick);
            const baseWorkTicks = Math.max(
                1,
                Math.ceil(rate.setupTicks + (preflight.travelTicks ?? 0) + baseExecTicks),
            );
            const speedScale = upgrade && rate.xpPerTick > 0 && effectiveRate.xpPerTick > rate.xpPerTick
                ? rate.xpPerTick / effectiveRate.xpPerTick
                : 1;
            const workTicks = Math.max(
                1,
                Math.ceil(
                    effectiveRate.setupTicks
                    + (preflight.travelTicks ?? 0)
                    + baseExecTicks * speedScale,
                ),
            );
            let prepTicks = 0;
            for (let pi = 0; pi < prepSteps.length; pi++) {
                const st = prepSteps[pi]!;
                prepTicks += st.stepKind === 'gear_upgrade' ? st.acquisitionTicks : st.estimatedTicks;
            }
            const totalTicks = workTicks + prepTicks;
            const baseVph = effectiveDemand.valuePerHour ?? (effectiveDemand.valueScore * effectiveDemand.priorityWeight);
            const speedEfficiency = baseWorkTicks / Math.max(1, totalTicks);
            const actThroughput = activityDemandThroughput(activity, effectiveDemand, effectiveRate);
            const throughputRatio = bestThroughput > 0
                ? Math.max(0.25, Math.min(1.0, actThroughput / bestThroughput))
                : 1.0;
            const scorePerHour = Math.max(0, baseVph * advMult * speedEfficiency * throughputRatio);
            if (demandBest && scorePerHour <= demandBest.scorePerHour) {
                continue;
            }

            const trainTarget = upgrade
                ? selectWorkTrainingTarget(acct, effectiveDemand, activity, effectiveRate, acctCache)
                : preTrainTarget;
            const workStep: TargetWorkPlannedStep = {
                stepKind: 'work',
                activityId: activity.id,
                demandId: effectiveDemand.id,
                workerId: activity.workerId,
                batchUnits,
                estimatedTicks: workTicks,
                expectedValuePerHour: scorePerHour,
                config: {
                    ...activity.config,
                    batchUnits,
                    ...(trainTarget.trainSkill ? { trainSkill: trainTarget.trainSkill } : {}),
                    ...(trainTarget.targetLevel !== undefined ? { targetLevel: trainTarget.targetLevel } : {}),
                },
            };

            const steps: PlannedStep[] = [...prepSteps, workStep];
            const candidatePlan: AccountPlan = {
                account: acct.name,
                demandId: demand.id,
                steps,
                scorePerHour,
            };
            demandBest = candidatePlan;
            if (!bestPlan || scorePerHour > bestPlan.scorePerHour) {
                bestPlan = candidatePlan;
            }
        }

        if (collectCandidates && demandBest) {
            demandCandidates.push(demandBest);
        }
    }

    if (bestPlan) {
        if (collectCandidates) {
            demandCandidates.sort((a, b) => b.scorePerHour - a.scorePerHour);
        }
        return { bestPlan, candidates: demandCandidates };
    }
    const emptyPlan: AccountPlan = {
        account: acct.name,
        steps: [],
        scorePerHour: 0,
        idleReason: lastBlockerReason,
    };
    return { bestPlan: emptyPlan, candidates: [] };
}
