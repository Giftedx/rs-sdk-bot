// AccountPlanner: solves 1-to-3-step dependency chains (recover -> acquire/gear -> unlock -> work),
// evaluates gear upgrades by net XP/tick payback over remaining band vs. acquisition ticks,
// applies comparative advantage across account profiles, and enforces protectedClock isolation.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Gear, Skill } from '../../knowledge/src/gear';
import { canWear } from '../../knowledge/src/gear-query';
import type { PreflightResult, RateEstimate, TrustTier } from '../../workers/src/contracts';
import { trustMeetsMinimum } from '../../workers/src/contracts';
import {
    DEFAULT_OPERATING_COIN_FLOAT,
    HUB_BANKER_LOCATIONS,
    MAX_ACCOUNT_PLAN_STEPS,
    isCampaignLaunchReady,
    isHoldActive,
    isProtectedAccountName,
    type AccountPlan,
    type AccountState,
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
    resolveAcquireItem,
    type AcquireContext,
    type AcquireRequest,
    type AcquireResolution,
    type MarketQuotesMap,
} from './acquire';
import { TICKS_PER_HOUR } from './demand';
import {
    STANDARD_FOOD_IDS,
    accountSkillLevel,
    activityPreflightFromConfig,
    availableStockAfterReserves,
    canWearItem,
    completedQuestSet,
    hasCompletedQuest,
    loadGearMap,
    loadItemsMap,
    loadQuestRows,
    type CombatSurvivabilityFloor,
} from './preflight';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');

const WOODCUTTING_AXES_DESC = [1359, 1357, 1355, 1361, 1353, 1349, 1351] as const;
const MINING_PICKAXES_DESC = [1275, 1271, 1273, 1269, 1267, 1265] as const;

const XP_TABLE: readonly number[] = (() => {
    const t: number[] = [];
    let acc = 0;
    for (let i = 0; i < 99; i++) {
        const level = i + 1;
        acc += Math.floor(level + Math.pow(2.0, level / 10.0) * 300.0);
        t.push((Math.floor(acc / 4) * 10) / 10);
    }
    return t;
})();

export function xpForLevel(level: number): number {
    if (level <= 1) return 0;
    return XP_TABLE[Math.min(level, 99) - 2] ?? 0;
}

export function levelForXp(xp: number): number {
    for (let i = 97; i >= 0; i--) {
        if (xp >= XP_TABLE[i]!) return Math.min(i + 2, 99);
    }
    return 1;
}

interface SkillToolRow {
    readonly id: number;
    readonly wieldAttack?: number | null;
    readonly paramLevelrequire?: number | null;
    readonly woodcuttingLevel?: number | null;
    readonly miningLevel?: number | null;
}

let cachedSkillTools: { axes: SkillToolRow[]; pickaxes: SkillToolRow[] } | undefined;
let cachedTradeableRighthand: Gear[] | undefined;

function loadSkillTools(): { axes: SkillToolRow[]; pickaxes: SkillToolRow[] } {
    if (cachedSkillTools) return cachedSkillTools;
    cachedSkillTools = JSON.parse(
        readFileSync(resolve(REPO_ROOT, 'knowledge', 'skill-tools.json'), 'utf8'),
    ) as { axes: SkillToolRow[]; pickaxes: SkillToolRow[] };
    return cachedSkillTools;
}

function getTradeableRighthandGear(): readonly Gear[] {
    if (cachedTradeableRighthand) return cachedTradeableRighthand;
    cachedTradeableRighthand = [...loadGearMap().values()].filter((g) => g.slot === 'righthand' && g.tradeable);
    return cachedTradeableRighthand;
}

type WeaponStyle = 'melee' | 'ranged' | 'magic';
interface PrecomputedWeaponInfo {
    readonly wearableRighthand: readonly Gear[];
    readonly byStyle: Readonly<Record<WeaponStyle, {
        readonly bestOwnedScore: number;
        readonly candidates: readonly { readonly gear: Gear; readonly score: number }[];
    }>>;
}

function buildWearLevels(acct: AccountState): Partial<Record<Skill, number>> {
    return {
        attack: accountSkillLevel(acct, 'Attack'),
        strength: accountSkillLevel(acct, 'Strength'),
        defence: accountSkillLevel(acct, 'Defence'),
        ranged: accountSkillLevel(acct, 'Ranged'),
        magic: accountSkillLevel(acct, 'Magic'),
    };
}

function precomputeWearableWeapons(acct: AccountState): PrecomputedWeaponInfo {
    const gearMap = loadGearMap();
    const levels = buildWearLevels(acct);
    const doneSet = completedQuestSet(acct);
    const wearableRighthand = getTradeableRighthandGear().filter((g) => canWear(g, levels, doneSet));

    const ownedRighthand: Gear[] = [];
    for (const [idStr, cnt] of [
        ...Object.entries(acct.equipment),
        ...Object.entries(acct.inventory),
        ...(acct.bank.trusted ? Object.entries(acct.bank.items) : []),
    ]) {
        if (cnt <= 0) continue;
        const g = gearMap.get(Number(idStr));
        if (!g || g.slot !== 'righthand') continue;
        if (!canWear(g, levels, doneSet)) continue;
        ownedRighthand.push(g);
    }

    const styles: WeaponStyle[] = ['melee', 'ranged', 'magic'];
    const byStyle = {} as Record<WeaponStyle, { bestOwnedScore: number; candidates: { gear: Gear; score: number }[] }>;
    for (const style of styles) {
        let bestOwnedScore = 50;
        for (const g of ownedRighthand) {
            const sc = scoreCombatWeapon(g, style);
            if (sc > bestOwnedScore) bestOwnedScore = sc;
        }
        const candidates = wearableRighthand
            .map((g) => ({ gear: g, score: scoreCombatWeapon(g, style) }))
            .filter((x) => x.score > bestOwnedScore * 1.05)
            .sort((a, b) => b.score - a.score)
            .slice(0, 6);
        byStyle[style] = { bestOwnedScore, candidates };
    }

    return { wearableRighthand, byStyle };
}

export interface RateEstimator {
    estimate(activity: ActivityDefinition, acct: AccountState, world: WorldSnapshot): RateEstimate;
}

export interface RateStoreLike {
    estimate(activityId: string, acct?: AccountState, world?: WorldSnapshot): RateEstimate;
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
    readonly donorDemandItemIds?: ReadonlyMap<string, ReadonlySet<number>>;
    readonly recentReceivedAt?: ReadonlyMap<string, number>;
    readonly confirmedLogoutAt?: ReadonlyMap<string, number>;
    readonly requireConfirmedLogoutForTransfer?: boolean;
    readonly xpRate?: number;
    readonly ticksPerHour?: number;
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

export function summarizeAccountProfile(acct: AccountState): AccountProfileSummary {
    let completedQuests = 0;
    for (const st of Object.values(acct.quests)) {
        if (st === 'complete') completedQuests += 1;
    }
    let artisanMax = 1;
    for (const sk of ARTISAN_SKILLS) {
        artisanMax = Math.max(artisanMax, accountSkillLevel(acct, sk));
    }
    const meleeLevels = [
        accountSkillLevel(acct, 'Attack'),
        accountSkillLevel(acct, 'Strength'),
        accountSkillLevel(acct, 'Defence'),
    ];
    const combatMeleeMin = Math.min(...meleeLevels);
    const tribridLevels = TRIBRID_SKILLS.map((sk) => accountSkillLevel(acct, sk));
    const combatTribridMin = Math.min(...tribridLevels);
    const prayer = accountSkillLevel(acct, 'Prayer');

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

export function evaluateBestGearUpgrade(params: {
    readonly acct: AccountState;
    readonly activity: ActivityDefinition;
    readonly rate: RateEstimate;
    readonly remainingXp: number;
    readonly acquireCtx: AcquireContext;
    readonly precomputedWeapons?: PrecomputedWeaponInfo;
    readonly resolveAcquire?: (req: AcquireRequest) => AcquireResolution;
}): GearUpgradeCandidateResult | null {
    const { acct, activity, rate, remainingXp, acquireCtx } = params;
    if (rate.xpPerTick <= 0 || !Number.isFinite(remainingXp) || remainingXp <= 0) return null;

    const skill = activity.skill?.toLowerCase();
    const isWoodcutting = skill === 'woodcutting';
    const isMining = skill === 'mining';
    const isCombat = activity.family === 'combat'
        || skill === 'attack' || skill === 'strength' || skill === 'defence'
        || skill === 'ranged' || skill === 'magic';

    if (!isWoodcutting && !isMining && !isCombat) return null;

    const baseRemainingTicks = remainingXp / rate.xpPerTick;
    let best: GearUpgradeCandidateResult | null = null;
    const gearMap = loadGearMap();
    const itemsMap = loadItemsMap();
    const doAcquire = params.resolveAcquire
        ?? ((req: AcquireRequest) => resolveAcquireItem(acct, req, acquireCtx));

    const tryCandidate = (itemId: number, slot: string, multiplier: number): GearUpgradeCandidateResult | null => {
        if (multiplier <= 1.02) return null;
        const owned = availableStockAfterReserves(acct, acquireCtx.world, itemId, {
            includeBank: true,
            requireTrustedBank: true,
        }).available;
        if (owned > 0) return null;

        const acq = doAcquire({
            itemId,
            itemName: itemsMap.get(itemId)?.name ?? gearMap.get(itemId)?.name,
            quantity: 1,
            allowOwnBank: true,
        });
        if (!acq.ok || !acq.step) return null;

        const improvedXpPerTick = rate.xpPerTick * multiplier;
        const netXpPerTickGain = improvedXpPerTick - rate.xpPerTick;
        const newBandTicks = remainingXp / improvedXpPerTick;
        let bestStep: GearUpgradePlannedStep | null = null;
        for (const cand of acq.candidates) {
            const paybackNetTicks = (baseRemainingTicks - newBandTicks) - cand.step.estimatedTicks;
            if (paybackNetTicks <= 0 || !Number.isFinite(paybackNetTicks)) continue;
            if (!bestStep || paybackNetTicks > bestStep.paybackNetTicks) {
                bestStep = {
                    stepKind: 'gear_upgrade',
                    itemId,
                    ...(itemsMap.get(itemId)?.name || gearMap.get(itemId)?.name
                        ? { itemName: itemsMap.get(itemId)?.name ?? gearMap.get(itemId)?.name }
                        : {}),
                    slot,
                    netXpPerTickGain,
                    remainingBandTicks: baseRemainingTicks,
                    acquisitionTicks: cand.step.estimatedTicks,
                    paybackNetTicks,
                    source: cand.step.source,
                };
            }
        }
        if (!bestStep) return null;
        return { step: bestStep, improvedXpPerTick };
    };

    const pickBetter = (cand: GearUpgradeCandidateResult | null) => {
        if (cand && (!best || cand.step.paybackNetTicks > best.step.paybackNetTicks)) {
            best = cand;
        }
    };

    if (isMining || isWoodcutting) {
        const list = isMining ? MINING_PICKAXES_DESC : WOODCUTTING_AXES_DESC;
        const toolRows = loadSkillTools();
        const rows = isMining ? toolRows.pickaxes : toolRows.axes;
        const useLvl = accountSkillLevel(acct, isMining ? 'Mining' : 'Woodcutting');
        let currentMult = 1.0;
        for (const id of list) {
            if (availableStockAfterReserves(acct, acquireCtx.world, id).available > 0) {
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
                pickBetter(tryCandidate(id, 'weapon', mult / currentMult));
            }
        }
        return best;
    }

    // Combat weapon upgrade check.
    const style: WeaponStyle = skill === 'ranged' ? 'ranged' : skill === 'magic' ? 'magic' : 'melee';
    const precomputed = params.precomputedWeapons ?? precomputeWearableWeapons(acct);
    const { bestOwnedScore: bestOwnedWeaponScore, candidates: weaponCandidates } = precomputed.byStyle[style];

    for (const cand of weaponCandidates) {
        // Bound DPS ratio conservatively to avoid exaggerating upgrades on low-HP mobs.
        const ratio = Math.min(2.2, Math.sqrt(cand.score / bestOwnedWeaponScore));
        pickBetter(tryCandidate(cand.gear.id, 'weapon', ratio));
    }

    return best;
}

export function comparativeAdvantageMultiplier(
    acct: AccountState,
    demand: GoalDemand,
    activity: ActivityDefinition,
    profile: AccountProfileSummary = summarizeAccountProfile(acct),
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
        const lvl = actSkill ? accountSkillLevel(acct, actSkill) : profile.artisanMax;
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

function activityMatchesDemand(
    acct: AccountState,
    demand: GoalDemand,
    activity: ActivityDefinition,
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
            if (t.account.toLowerCase() !== acct.name.toLowerCase()) return false;
            const curLvl = accountSkillLevel(acct, t.skill);
            if (curLvl >= t.targetLevel) return false;
            const targetNorm = t.skill.toLowerCase();
            if (activity.skill?.toLowerCase() === targetNorm) return true;
            if (activity.skills?.some((s) => s.toLowerCase() === targetNorm)) return true;
            return (activity.baselineRate.skillXpPerTick?.[t.skill] ?? activity.baselineRate.skillXpPerTick?.[targetNorm] ?? 0) > 0;
        }
        case 'quest': {
            if (t.account && t.account.toLowerCase() !== acct.name.toLowerCase()) return false;
            if (hasCompletedQuest(acct, t.questSlug)) return false;
            return activity.family === 'quest'
                && activity.questSlug?.toLowerCase() === t.questSlug.toLowerCase();
        }
        case 'coins': {
            if (t.account && t.account.toLowerCase() !== acct.name.toLowerCase()) return false;
            return activity.baselineRate.gpPerTick > 0;
        }
        case 'combat_readiness': {
            if (t.account.toLowerCase() !== acct.name.toLowerCase()) return false;
            for (const [skill, targetLvl] of Object.entries(t.targets)) {
                if (accountSkillLevel(acct, skill) < targetLvl) {
                    const norm = skill.toLowerCase();
                    if (activity.skill?.toLowerCase() === norm || activity.skills?.some((s) => s.toLowerCase() === norm)) {
                        return true;
                    }
                }
            }
            const combatTargetsMet = Object.entries(t.targets).every(
                ([skill, targetLvl]) => accountSkillLevel(acct, skill) >= targetLvl,
            );
            return combatTargetsMet && (activity.family === 'pvp' || activity.family === 'combat');
        }
    }
}

function resolveBatchUnits(
    acct: AccountState,
    demand: GoalDemand,
    activity: ActivityDefinition,
    rate: RateEstimate,
    xpRate: number,
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
        const curXp = acct.skills[t.skill]?.xp ?? xpForLevel(accountSkillLevel(acct, t.skill));
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
): number {
    if (demand.target.kind === 'skill') {
        const curXp = acct.skills[demand.target.skill]?.xp ?? xpForLevel(accountSkillLevel(acct, demand.target.skill));
        const targetXp = demand.target.targetXp ?? xpForLevel(demand.target.targetLevel);
        return Math.max(0, targetXp - curXp);
    }
    if (demand.target.kind === 'combat_readiness' && activity.skill) {
        const targetLvl = demand.target.targets[activity.skill] ?? 99;
        const curXp = acct.skills[activity.skill]?.xp ?? xpForLevel(accountSkillLevel(acct, activity.skill));
        return Math.max(0, xpForLevel(targetLvl) - curXp);
    }
    if (activity.skill) {
        const cur = accountSkillLevel(acct, activity.skill);
        if (cur >= 99) return 0;
        const nextBand = Math.min(99, cur + 10);
        const curXp = acct.skills[activity.skill]?.xp ?? xpForLevel(cur);
        return Math.max(0, xpForLevel(nextBand) - curXp);
    }
    return 0;
}

export function planAccount(
    acct: AccountState,
    input: AccountPlannerInput,
): AccountPlan {
    const { world } = input;
    const now = world.at;
    const campaigns = input.campaigns ?? [];
    const defects = input.defects ?? [];
    const ticksPerHour = input.ticksPerHour ?? TICKS_PER_HOUR;
    const xpRate = input.xpRate ?? 1;

    if (acct.lifecycle === 'paused_owner') {
        return { account: acct.name, steps: [], scorePerHour: 0, idleReason: 'paused_owner' };
    }
    if (acct.lifecycle === 'dead') {
        return { account: acct.name, steps: [], scorePerHour: 0, idleReason: 'dead' };
    }
    if (acct.lifecycle === 'in_trade') {
        return { account: acct.name, steps: [], scorePerHour: 0, idleReason: 'in_trade' };
    }

    const holdReason = hasBlockingSystemHold(acct, now);
    if (holdReason) {
        return { account: acct.name, steps: [], scorePerHour: 0, idleReason: holdReason };
    }

    const protection = canProtectedAccountLaunch(acct, campaigns);
    if (!protection.allowed) {
        return {
            account: acct.name,
            steps: [],
            scorePerHour: 0,
            idleReason: protection.reason ?? 'protected_clock_reserved',
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
        return {
            account: acct.name,
            steps: [recStep],
            scorePerHour: 1e6,
        };
    }

    if (acct.lifecycle === 'needs_location_recovery') {
        const recStep: RecoverPlannedStep = {
            stepKind: 'recover',
            recoveryKind: 'location',
            targetHub: nearestHub(acct.pos),
            estimatedTicks: 60,
            reason: 'stranded off-hub or non-ground plane',
        };
        return {
            account: acct.name,
            steps: [recStep],
            scorePerHour: 5e5,
        };
    }

    const minTrust: TrustTier = input.minTrust ?? 'practice_passed';
    const profile = summarizeAccountProfile(acct);

    const candidateActivities = input.activities.filter((act) => {
        if (input.excludedActivityIds?.has(act.id)) return false;
        if (act.spotId && input.excludedSpotIds?.has(act.spotId)) return false;
        if (isActivityQuarantined(act.id, defects, now)) return false;
        if (!trustMeetsMinimum(act.trust, minTrust)) {
            if (!input.allowExperimentalFallback) return false;
        }
        if ((acct.protectedClock || isProtectedAccountName(acct.name)) && act.protectedAllowed !== true) {
            return false;
        }
        return true;
    });

    const eligibleActivities = candidateActivities.some((a) => trustMeetsMinimum(a.trust, minTrust))
        ? candidateActivities.filter((a) => trustMeetsMinimum(a.trust, minTrust))
        : candidateActivities;

    // Pre-index activities and per-account caches so O(D * A) collapses to O(D * matching).
    const nonExpByOutputItem = new Map<number, ActivityDefinition[]>();
    for (const act of input.activities) {
        if (act.trust === 'experimental') continue;
        const seenOut = new Set<number>();
        for (const o of act.outputs ?? []) {
            if (o.countPerUnit > 0) seenOut.add(o.itemId);
        }
        for (const [idStr, cnt] of Object.entries(act.baselineRate.outputsPerUnit ?? {})) {
            if (cnt > 0) seenOut.add(Number(idStr));
        }
        for (const itemId of seenOut) {
            const list = nonExpByOutputItem.get(itemId);
            if (list) list.push(act);
            else nonExpByOutputItem.set(itemId, [act]);
        }
    }
    const sortedIdleDonors = Object.values(world.accounts)
        .filter((d) => d.lifecycle === 'idle' && d.bank.trusted && !d.protectedClock && !isProtectedAccountName(d.name))
        .sort((a, b) => a.name.localeCompare(b.name));

    const acquireCtx: AcquireContext = {
        world,
        activities: input.activities,
        marketQuotes: input.marketQuotes,
        requireMarketQuote: input.requireMarketQuote,
        donorDemandItemIds: input.donorDemandItemIds,
        recentReceivedAt: input.recentReceivedAt,
        confirmedLogoutAt: input.confirmedLogoutAt,
        requireConfirmedLogoutForTransfer: input.requireConfirmedLogoutForTransfer,
        _cachedByOutputItem: nonExpByOutputItem,
        _sortedIdleDonors: sortedIdleDonors,
    };

    const byOutputItem = new Map<number, ActivityDefinition[]>();
    const bySkill = new Map<string, ActivityDefinition[]>();
    const questsBySlug = new Map<string, ActivityDefinition[]>();
    const gpActivities: ActivityDefinition[] = [];
    const combatOrPvpActivities: ActivityDefinition[] = [];
    const pushMap = <K, V>(map: Map<K, V[]>, key: K, val: V) => {
        const list = map.get(key);
        if (list) {
            if (!list.includes(val)) list.push(val);
        } else {
            map.set(key, [val]);
        }
    };

    for (const act of eligibleActivities) {
        for (const o of act.outputs ?? []) {
            if (o.countPerUnit > 0) pushMap(byOutputItem, o.itemId, act);
        }
        for (const [idStr, cnt] of Object.entries(act.baselineRate.outputsPerUnit ?? {})) {
            if (cnt > 0) pushMap(byOutputItem, Number(idStr), act);
        }
        if (act.family === 'market' && Number.isFinite(Number(act.config?.itemId))) {
            pushMap(byOutputItem, Number(act.config.itemId), act);
        }
        if (act.skill) pushMap(bySkill, act.skill.toLowerCase(), act);
        for (const sk of act.skills ?? []) pushMap(bySkill, sk.toLowerCase(), act);
        for (const [sk, xp] of Object.entries(act.baselineRate.skillXpPerTick ?? {})) {
            if (xp > 0) pushMap(bySkill, sk.toLowerCase(), act);
        }
        if (act.family === 'quest' && act.questSlug) {
            pushMap(questsBySlug, act.questSlug.toLowerCase(), act);
        }
        if (act.baselineRate.gpPerTick > 0) gpActivities.push(act);
        if (act.family === 'pvp' || act.family === 'combat') combatOrPvpActivities.push(act);
    }

    const candidateListForDemand = (demand: GoalDemand): readonly ActivityDefinition[] => {
        if (demand.assignedAccount && demand.assignedAccount.toLowerCase() !== acct.name.toLowerCase()) {
            return [];
        }
        const t = demand.target;
        switch (t.kind) {
            case 'item':
                return byOutputItem.get(t.itemId) ?? [];
            case 'quest':
                if (t.account && t.account.toLowerCase() !== acct.name.toLowerCase()) return [];
                if (hasCompletedQuest(acct, t.questSlug)) return [];
                return questsBySlug.get(t.questSlug.toLowerCase()) ?? [];
            case 'skill': {
                if (t.account.toLowerCase() !== acct.name.toLowerCase()) return [];
                if (accountSkillLevel(acct, t.skill) >= t.targetLevel) return [];
                return bySkill.get(t.skill.toLowerCase()) ?? [];
            }
            case 'coins':
                if (t.account && t.account.toLowerCase() !== acct.name.toLowerCase()) return [];
                return gpActivities;
            case 'combat_readiness': {
                if (t.account.toLowerCase() !== acct.name.toLowerCase()) return [];
                const set = new Set<ActivityDefinition>();
                let allMet = true;
                for (const [sk, targetLvl] of Object.entries(t.targets)) {
                    if (accountSkillLevel(acct, sk) < targetLvl) {
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
                {
                    ...activity,
                    protectedAllowed: acctProtectedAllowed && (activity.protectedAllowed || !acct.protectedClock),
                },
                world,
                batchUnits,
            );
            preflightCache.set(key, p);
        }
        return p;
    };

    const acquireCache = new Map<string, AcquireResolution>();
    const resolveAcquireCached = (req: AcquireRequest): AcquireResolution => {
        const key = `${req.itemId}:${req.quantity}:${req.allowOwnBank ?? true}:${req.includeInventoryInOwned ?? true}`;
        let res = acquireCache.get(key);
        if (!res) {
            res = resolveAcquireItem(acct, req, acquireCtx);
            acquireCache.set(key, res);
        }
        return res;
    };

    let precomputedWeapons: PrecomputedWeaponInfo | undefined;
    const getPrecomputedWeapons = (): PrecomputedWeaponInfo => {
        if (!precomputedWeapons) precomputedWeapons = precomputeWearableWeapons(acct);
        return precomputedWeapons;
    };
    const upgradeCache = new Map<string, GearUpgradeCandidateResult | null>();
    const skillUnlockCache = new Map<string, { activity: ActivityDefinition; rate: RateEstimate } | null>();
    const questRows = loadQuestRows();

    let bestPlan: AccountPlan | null = null;
    let lastBlockerReason = 'no_matching_demand_or_activity';

    for (const demand of input.demands) {
        if (!demand.active || demand.remaining <= 0) continue;

        for (const activity of candidateListForDemand(demand)) {
            if (!activityMatchesDemand(acct, demand, activity)) continue;
            const advMult = comparativeAdvantageMultiplier(acct, demand, activity, profile);
            if (advMult <= 0) continue;

            const rate = getRate(activity);
            const batchUnits = resolveBatchUnits(acct, demand, activity, rate, xpRate);
            const preflight = getPreflight(activity, batchUnits);

            const prepSteps: PlannedStep[] = [];
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
                        const curXp = acct.skills[blocker.skill]?.xp ?? xpForLevel(accountSkillLevel(acct, blocker.skill));
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
                        const unlockAct = (questsBySlug.get(blocker.quest.toLowerCase()) ?? [])[0];
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
                        const qRow = questRows.find(
                            (q) => q.varp.toLowerCase() === qSlug || q.folder?.toLowerCase() === `quest_${qSlug}`,
                        );
                        if (qRow?.xp) {
                            for (const reward of qRow.xp) {
                                const sk = reward.skill.toLowerCase();
                                grantedQuestXp[sk] = (grantedQuestXp[sk] ?? 0) + reward.xp * xpRate;
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
                        let unlockEntry = skillUnlockCache.get(skLower);
                        if (unlockEntry === undefined) {
                            const candidates = bySkill.get(skLower) ?? [];
                            const found = candidates.find(
                                (a) => a.skill?.toLowerCase() === skLower && getPreflight(a, 1).ok,
                            );
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
                        const curXp = acct.skills[blocker.skill]?.xp ?? xpForLevel(accountSkillLevel(acct, blocker.skill));
                        const needXp = Math.max(1, xpForLevel(blocker.required) - curXp);
                        const trainTicks = Math.max(
                            10,
                            Math.ceil(trainRate.setupTicks + needXp / Math.max(1e-3, trainRate.xpPerTick * xpRate)),
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
                        });
                        if (!acq.ok || !acq.step) {
                            lastBlockerReason = `unresolvable_supply:${blocker.itemId}`;
                            chainFeasible = false;
                            break;
                        }
                        prepSteps.push(acq.step);
                    } else if (blocker.kind === 'missing_coins') {
                        const shortfall = Math.max(1, blocker.required - blocker.available);
                        const acq = resolveAcquireCached({
                            itemId: 995,
                            itemName: 'Coins',
                            quantity: shortfall,
                            allowOwnBank: false,
                            operatingCoinFloat: DEFAULT_OPERATING_COIN_FLOAT,
                        });
                        if (!acq.ok || !acq.step) {
                            lastBlockerReason = `missing_coins:${shortfall}`;
                            chainFeasible = false;
                            break;
                        }
                        prepSteps.push(acq.step);
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
            if (prepSteps.length < MAX_ACCOUNT_PLAN_STEPS - 1 && rate.xpPerTick > 0) {
                const remXp = estimateRemainingBandXp(acct, demand, activity);
                if (remXp > 0) {
                    const upgKey = `${activity.family}:${activity.skill ?? ''}:${rate.xpPerTick}:${Math.round(remXp)}`;
                    let upgrade = upgradeCache.get(upgKey);
                    if (upgrade === undefined) {
                        upgrade = evaluateBestGearUpgrade({
                            acct,
                            activity,
                            rate,
                            remainingXp: remXp,
                            acquireCtx,
                            precomputedWeapons: getPrecomputedWeapons(),
                            resolveAcquire: resolveAcquireCached,
                        });
                        upgradeCache.set(upgKey, upgrade);
                    }
                    if (upgrade) {
                        prepSteps.push(upgrade.step);
                        effectiveRate = {
                            ...rate,
                            xpPerTick: upgrade.improvedXpPerTick,
                        };
                    }
                }
            }

            if (prepSteps.length >= MAX_ACCOUNT_PLAN_STEPS) {
                lastBlockerReason = `${activity.id}:exceeds_max_steps`;
                continue;
            }

            const workTicks = Math.max(
                1,
                Math.ceil(
                    effectiveRate.setupTicks
                    + (preflight.travelTicks ?? 0)
                    + batchUnits / Math.max(1e-4, effectiveRate.unitsPerTick),
                ),
            );
            const prepTicks = prepSteps.reduce(
                (sum, st) => sum + (st.stepKind === 'gear_upgrade' ? st.acquisitionTicks : st.estimatedTicks),
                0,
            );
            const totalTicks = workTicks + prepTicks;
            const totalHours = totalTicks / ticksPerHour;
            const rawGoalValue = (demand.valuePerHour ?? demand.valueScore) * Math.max(0.05, totalHours) * demand.priorityWeight;
            const valuePerHour = (rawGoalValue / Math.max(1e-4, totalHours)) * advMult;

            // Penalize multi-step chains slightly on total end-to-end ticks via dilution.
            const effectiveEfficiency = workTicks / Math.max(1, totalTicks);
            const scorePerHour = Math.max(0, valuePerHour * effectiveEfficiency);

            const workStep: TargetWorkPlannedStep = {
                stepKind: 'work',
                activityId: activity.id,
                demandId: demand.id,
                workerId: activity.workerId,
                batchUnits,
                estimatedTicks: workTicks,
                expectedValuePerHour: scorePerHour,
                config: { ...activity.config, batchUnits },
            };

            const steps: PlannedStep[] = [...prepSteps, workStep];
            if (!bestPlan || scorePerHour > bestPlan.scorePerHour) {
                bestPlan = {
                    account: acct.name,
                    demandId: demand.id,
                    steps,
                    scorePerHour,
                };
            }
        }
    }

    if (bestPlan) return bestPlan;
    return {
        account: acct.name,
        steps: [],
        scorePerHour: 0,
        idleReason: lastBlockerReason,
    };
}
