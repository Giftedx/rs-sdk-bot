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
    HUB_BANKER_LOCATIONS,
    MAX_ACCOUNT_PLAN_STEPS,
    isCampaignLaunchReady,
    isHoldActive,
    isProtectedAccountName,
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
        for (const [idStr, cnt] of Object.entries(container)) {
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
        if (act.baselineRate.gpPerTick > 0) gpActivities.push(act);
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
    const quarantinedIds = new Set<string>();
    for (const d of defects) {
        if (d.quarantined && (d.expiresAt === undefined || now < d.expiresAt)) {
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
            for (const [idStr, cnt] of Object.entries(src)) {
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
    readonly donorDemandItemIds?: ReadonlyMap<string, ReadonlySet<number>>;
    readonly recentReceivedAt?: ReadonlyMap<string, number>;
    readonly confirmedLogoutAt?: ReadonlyMap<string, number>;
    readonly requireConfirmedLogoutForTransfer?: boolean;
    readonly xpRate?: number;
    readonly ticksPerHour?: number;
    readonly _sharedIndex?: PlannerSharedIndex;
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
    for (const st of Object.values(acct.quests)) {
        if (st === 'complete') completedQuests += 1;
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
    for (const [sk, st] of Object.entries(acct.skills)) {
        totalLevel += Number.isFinite(st?.level) ? st.level : sk.toLowerCase() === 'hitpoints' ? 10 : 1;
    }
    if (Object.keys(acct.skills).length === 0) totalLevel = 28;

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

function nearestHub(pos: AccountState['pos']): HubBankId {
    if (!pos) return 'varrock_west';
    let best: HubBankId = 'varrock_west';
    let bestDist = Infinity;
    for (const [id, spec] of Object.entries(HUB_BANKER_LOCATIONS) as [HubBankId, (typeof HUB_BANKER_LOCATIONS)[HubBankId]][]) {
        const d = Math.max(Math.abs(pos.x - spec.bankTile.x), Math.abs(pos.z - spec.bankTile.z));
        if (d < bestDist) {
            bestDist = d;
            best = id;
        }
    }
    return best;
}

function isActivityQuarantined(
    activityId: string,
    defects: readonly DefectRecord[],
    now: number,
): boolean {
    return defects.some(
        (d) => d.activityId === activityId
            && d.quarantined
            && (d.expiresAt === undefined || now < d.expiresAt),
    );
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
    const isCombat = activity.family === 'combat'
        || skill === 'attack' || skill === 'strength' || skill === 'defence'
        || skill === 'ranged' || skill === 'magic';

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
            return activity.baselineRate.gpPerTick > 0;
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

    const protection = canProtectedAccountLaunch(acct, campaigns, world);
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
        const recStep: RecoverPlannedStep = {
            stepKind: 'recover',
            recoveryKind: 'location',
            targetHub: nearestHub(acct.pos),
            estimatedTicks: 60,
            reason: 'stranded off-hub or non-ground plane',
        };
        const p: AccountPlan = {
            account: acct.name,
            steps: [recStep],
            scorePerHour: 5e5,
        };
        return { bestPlan: p, candidates: [p] };
    }

    const minTrust: TrustTier = input.minTrust ?? 'practice_passed';
    const acctCache = createAccountLookupCache(acct, world, DEFAULT_OPERATING_COIN_FLOAT);
    const profile = summarizeAccountProfile(acct, acctCache);
    const isProtected = Boolean(acct.protectedClock || isProtectedAccountName(acct.name));
    const hasActExclusions = Boolean(input.excludedActivityIds?.size || input.excludedSpotIds?.size);
    const isActAllowed = (act: ActivityDefinition): boolean =>
        (!input.excludedActivityIds || !input.excludedActivityIds.has(act.id))
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
            if (isActivityQuarantined(act.id, defects, now)) return false;
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
        _cachedByOutputItem: nonExpByOutputItem,
        _sortedIdleDonors: sortedIdleDonors,
        _idleDonorsByItemId: shared?.idleDonorsByItemId,
        _acctCache: acctCache,
        _skipDiagnostics: true,
    };

    const acctLower = acct.name.toLowerCase();

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
                for (const [sk, targetLvl] of Object.entries(t.targets)) {
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
    const rateCache = new Map<string, RateEstimate>();
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

    const preflightCache = new Map<string, PreflightResult>();
    const getPreflight = (activity: ActivityDefinition, batchUnits: number): PreflightResult => {
        const key = `${activity.id}:${batchUnits}`;
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
        const key = `${req.itemId}:${req.itemName ?? ''}:${req.quantity}:${req.allowOwnBank ?? true}:${req.includeInventoryInOwned ?? true}:${req.operatingCoinFloat ?? DEFAULT_OPERATING_COIN_FLOAT}:${req.committedCoinSpend ?? 0}:${req.allowedSources?.join(',') ?? ''}:${req.maxUnitPrice ?? ''}:${req.questPoints ?? 0}`;
        let res = acquireCache.get(key);
        if (!res) {
            res = resolveAcquireItem(acct, req, acquireCtx);
            acquireCache.set(key, res);
        }
        return res;
    };

    let precomputedWeapons: PrecomputedWeaponInfo | undefined;
    const getPrecomputedWeapons = (): PrecomputedWeaponInfo => {
        if (!precomputedWeapons) precomputedWeapons = precomputeWearableWeapons(acct, acctCache);
        return precomputedWeapons;
    };
    const upgradeCache = new Map<string, GearUpgradeCandidateResult | null>();
    const upgradeCandidatesCache = new Map<string, readonly ResolvedGearUpgradeCandidate[]>();
    const skillUnlockCache = new Map<string, { activity: ActivityDefinition; rate: RateEstimate } | null>();

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

        const rawCandidates = candidateListForDemand(demand);
        const needsMatchCheck = demand.target.kind === 'skill' || demand.target.kind === 'combat_readiness';
        const needFilter = (shared && hasActExclusions) || needsMatchCheck;
        const matching = needFilter
            ? rawCandidates.filter(
                  (a) => (!shared || !hasActExclusions || isActAllowed(a))
                      && (!needsMatchCheck || activityMatchesDemand(acct, demand, a, acctCache)),
              )
            : rawCandidates;
        let bestThroughput = 0;
        for (const act of matching) {
            const tp = activityDemandThroughput(act, demand, getRate(act));
            if (tp > bestThroughput) bestThroughput = tp;
        }

        let demandBest: AccountPlan | null = null;

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
            demand.target.kind === 'item'
            && defaultSpendableCoins > 0
            && (shopBuyActivity || directGeBuyActivity)
        ) {
            const targetItemId = demand.target.itemId;
            const hasShop = Boolean(shopBuyActivity && (shopCatalog.has(targetItemId) || acquireCtx.customShops?.some((s) => s.itemId === targetItemId)));
            const itemMetaForGe = directGeBuyActivity ? itemsMap.get(targetItemId) : undefined;
            const hasGe = Boolean(
                directGeBuyActivity
                && (!itemMetaForGe || itemMetaForGe.tradeable)
                && isValidGeAskQuote(input.marketQuotes?.[targetItemId], itemMetaForGe?.cost ?? 1),
            );
            if (hasShop || hasGe) {
                const allowedExternal: AcquireSourceKind[] = [];
                if (shopBuyActivity) allowedExternal.push('npc_shop');
                if (directGeBuyActivity) allowedExternal.push('ge');
                const maxQty = Math.max(1, Math.min(Math.round(demand.remaining), 250));
                let acq = resolveAcquireCached({
                    itemId: targetItemId,
                    itemName: demand.target.itemName,
                    quantity: maxQty,
                    allowOwnBank: false,
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
                                if (shop.requiresQuest && !cachedHasCompletedQuest(acct, shop.requiresQuest, acctCache)) continue;
                                if (shop.requiresSkill && cachedAccountSkillLevel(acct, shop.requiresSkill.skill, acctCache) < shop.requiresSkill.level) continue;
                                if (shop.requiresQuestPoints) continue;
                                if (shop.cost > 0 && shop.cost < minUnitPrice) minUnitPrice = shop.cost;
                            }
                        }
                        if (hasGe) {
                            const quote = input.marketQuotes?.[targetItemId]!;
                            minUnitPrice = Math.min(minUnitPrice, Math.ceil(Math.ceil(quote.ask!) * GE_LIMIT_BUFFER));
                        }
                        if (Number.isFinite(minUnitPrice) && minUnitPrice > 0) {
                            const affordableQty = Math.min(maxQty, Math.floor(spendable / minUnitPrice));
                            if (affordableQty >= 1 && affordableQty < maxQty) {
                                acq = resolveAcquireCached({
                                    itemId: targetItemId,
                                    itemName: demand.target.itemName,
                                    quantity: affordableQty,
                                    allowOwnBank: false,
                                    allowedSources: allowedExternal,
                                    operatingCoinFloat: DEFAULT_OPERATING_COIN_FLOAT,
                                });
                            }
                        }
                    }
                }
                for (const cand of acq.candidates) {
                    if (cand.source !== 'npc_shop' && cand.source !== 'ge') continue;
                    const marketAct = cand.source === 'npc_shop' ? shopBuyActivity : directGeBuyActivity;
                    if (!marketAct) continue;
                    const advMult = comparativeAdvantageMultiplier(acct, demand, marketAct, profile, acctCache);
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
            const baseVph = demand.valuePerHour ?? (demand.valueScore * demand.priorityWeight);
            const throughputRatio = bestThroughput > 0
                ? Math.max(0.25, Math.min(1.0, mc.throughput / bestThroughput))
                : 1.0;
            const scorePerHour = Math.max(0, baseVph * mc.advMult * throughputRatio);
            const targetItemId = (demand.target as { kind: 'item'; itemId: number }).itemId;
            const workStep: TargetWorkPlannedStep = {
                stepKind: 'work',
                activityId: mc.marketAct.id,
                demandId: demand.id,
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
                demandId: demand.id,
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
            const advMult = comparativeAdvantageMultiplier(acct, demand, activity, profile, acctCache);
            if (advMult <= 0) continue;

            const rate = getRate(activity);
            const batchUnits = resolveBatchUnits(acct, demand, activity, rate, xpRate, acctCache);
            const preflight = getPreflight(activity, batchUnits);

            const prepSteps: PlannedStep[] = [];
            let committedCoins = 0;
            let chainFeasible = true;

            if (!preflight.ok) {
                // Resolve quest unlocks before skill requirements so quest XP rewards (e.g. Druidic Ritual -> Herblore 3)
                // can satisfy downstream skill gates in the same 2-step chain.
                const orderedBlockers = [...preflight.blockers].sort((a, b) => {
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
                        const curXp = accountSkillXp(acct, blocker.skill);
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
                                const curHerbXp = accountSkillXp(acct, blocker.skill);
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

                        let unlockEntry = skillUnlockCache.get(skLower);
                        if (unlockEntry === undefined) {
                            const candidates = (bySkill.get(skLower) ?? [])
                                .filter((a) =>
                                    (!shared || !hasActExclusions || isActAllowed(a))
                                    && a.family !== 'quest'
                                    && a.skill?.toLowerCase() === skLower
                                    && activityXpForSkill(a, getRate(a), blocker.skill) > 0
                                    && getPreflight(a, 1).ok,
                                )
                                .sort((a, b) => {
                                    const xpDiff = activityXpForSkill(b, getRate(b), blocker.skill) - activityXpForSkill(a, getRate(a), blocker.skill);
                                    if (xpDiff !== 0) return xpDiff;
                                    return getRate(a).setupTicks - getRate(b).setupTicks || a.id.localeCompare(b.id);
                                });
                            const found = candidates[0];
                            unlockEntry = found ? { activity: found, rate: getRate(found) } : null;
                            skillUnlockCache.set(skLower, unlockEntry);
                        }
                        if (!unlockEntry) {
                            lastBlockerReason = `missing_skill_unlock:${blocker.skill}`;
                            chainFeasible = false;
                            break;
                        }
                        const trainAct = unlockEntry.activity;
                        const trainRate = unlockEntry.rate;
                        const curXp = accountSkillXp(acct, blocker.skill);
                        const bonusXp = grantedQuestXp[skLower] ?? 0;
                        const needXp = Math.max(1, xpForLevel(blocker.required) - (curXp + bonusXp));
                        const trainTicks = Math.max(
                            10,
                            Math.ceil(trainRate.setupTicks + needXp / Math.max(1e-3, activityXpForSkill(trainAct, trainRate, blocker.skill) * xpRate)),
                        );
                        const unlockStep: UnlockPlannedStep = {
                            stepKind: 'unlock',
                            unlockKind: 'skill',
                            activityId: trainAct.id,
                            skill: blocker.skill,
                            targetLevel: blocker.required,
                            estimatedTicks: trainTicks,
                        };
                        prepSteps.push(unlockStep);
                    } else if (blocker.kind === 'missing_supply') {
                        const shortfall = Math.max(1, blocker.required - blocker.available);
                        const acq = resolveAcquireCached({
                            itemId: blocker.itemId,
                            itemName: blocker.itemName,
                            quantity: shortfall,
                            operatingCoinFloat: DEFAULT_OPERATING_COIN_FLOAT,
                            committedCoinSpend: committedCoins,
                        });
                        if (!acq.ok || !acq.step) {
                            lastBlockerReason = `unresolvable_supply:${blocker.itemId}`;
                            chainFeasible = false;
                            break;
                        }
                        prepSteps.push(acq.step);
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
                            const countNeed = Math.max(10, floor?.minFoodCount ?? 15);
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

            if (!chainFeasible) continue;

            // Evaluate optional net XP/tick payback gear upgrade if step budget permits.
            let effectiveRate = rate;
            let upgrade: GearUpgradeCandidateResult | null | undefined;
            const preTrainTarget = selectWorkTrainingTarget(acct, demand, activity, rate, acctCache);
            if (prepSteps.length < MAX_ACCOUNT_PLAN_STEPS - 1 && rate.xpPerTick > 0) {
                const remXp = estimateRemainingBandXp(acct, demand, activity, preTrainTarget.trainSkill, preTrainTarget.targetLevel, acctCache);
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
                        const scaledSkillXp = rate.skillXpPerTick
                            ? Object.fromEntries(Object.entries(rate.skillXpPerTick).map(([k, v]) => [k, v * upgScale]))
                            : undefined;
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
            const prepTicks = prepSteps.reduce(
                (sum, st) => sum + (st.stepKind === 'gear_upgrade' ? st.acquisitionTicks : st.estimatedTicks),
                0,
            );
            const totalTicks = workTicks + prepTicks;
            const baseVph = demand.valuePerHour ?? (demand.valueScore * demand.priorityWeight);
            const speedEfficiency = baseWorkTicks / Math.max(1, totalTicks);
            const actThroughput = activityDemandThroughput(activity, demand, effectiveRate);
            const throughputRatio = bestThroughput > 0
                ? Math.max(0.25, Math.min(1.0, actThroughput / bestThroughput))
                : 1.0;
            const scorePerHour = Math.max(0, baseVph * advMult * speedEfficiency * throughputRatio);

            const trainTarget = selectWorkTrainingTarget(acct, demand, activity, effectiveRate, acctCache);
            const workStep: TargetWorkPlannedStep = {
                stepKind: 'work',
                activityId: activity.id,
                demandId: demand.id,
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
            if (!demandBest || scorePerHour > demandBest.scorePerHour) {
                demandBest = candidatePlan;
            }
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
