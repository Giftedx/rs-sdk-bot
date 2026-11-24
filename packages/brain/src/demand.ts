// DemandEngine emits validated GoalDemand items across all 5 owner goals (main_supply,
// specialist_prep, quest_board, gear_collection, pk_army) plus squad_supply, coin_fund,
// active Campaigns, and active Missions — all scored in normalized goal value per end-to-end hour.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../../core/src/practice-paths';
import { xpForLevel } from '../../core/src/xp-curve';
import { accountOwnedItemCount, type RateEstimate } from '../../workers/src/contracts';
import { evaluateCampaigns, loadCampaignManifests, type CampaignEvaluation } from './campaigns';
import type { ActivityCatalog } from './catalog';
import {
    validateCampaign,
    validateGoalDemand,
    validateMission,
    type AccountState,
    type ActivityDefinition,
    type Campaign,
    type CampaignState,
    type GoalDemand,
    type GoalKind,
    type Mission,
    type MissionState,
    type OperatorCommand,
    type WorldSnapshot,
} from './contracts';
import { evaluateMissions, loadMissionManifests, type MissionEvaluation } from './missions';
import { hasCompletedQuest } from './preflight';
import type { RateStore } from './rate-store';

export const TICK_MS = 400;
export const TICKS_PER_HOUR = 3_600_000 / TICK_MS;
export const DEFAULT_MIN_DEMAND_HOURS = 1 / 60;
export const DEFAULT_COIN_RESERVE_FLOOR = 500_000;

export const GOAL_BASE_WEIGHTS: Readonly<Record<GoalKind, number>> = {
    main_supply: 1.5,
    specialist_prep: 1.35,
    quest_board: 1.15,
    pk_army: 1.15,
    squad_supply: 1.1,
    gear_collection: 1.0,
    coin_fund: 0.9,
};

export const DEFAULT_ARMY_COMBAT_TARGETS: Readonly<Record<string, number>> = {
    Attack: 90,
    Strength: 90,
    Defence: 90,
    Hitpoints: 90,
    Ranged: 90,
    Magic: 90,
    Prayer: 70,
};

export interface GearCollectionTarget {
    readonly itemId: number;
    readonly itemName: string;
    readonly slot?: string;
    readonly count: number;
    readonly valueWeight?: number;
}

export interface QuestDemandSeed {
    readonly slug: string;
    readonly valueScore: number;
}

export interface SkillDemandTarget {
    readonly account: string;
    readonly skill: string;
    readonly targetLevel: number;
    readonly targetXp?: number;
    readonly goalKind?: GoalKind;
    readonly valueScore?: number;
}

export interface DemandEngineOptions {
    readonly catalog: ActivityCatalog;
    readonly rateStore?: RateStore;
    readonly campaigns?: readonly Campaign[];
    readonly missions?: readonly Mission[];
    readonly root?: string;
    readonly goalWeights?: Readonly<Partial<Record<GoalKind, number>>>;
    readonly coinReserveFloor?: number;
    readonly armyTargets?: Readonly<Record<string, number>>;
    readonly gearTargets?: readonly GearCollectionTarget[];
    readonly questCatalog?: readonly QuestDemandSeed[];
    readonly skillTargets?: readonly SkillDemandTarget[];
}

export interface DemandReport {
    readonly evaluatedAt: number;
    readonly demands: readonly GoalDemand[];
    readonly activeDemands: readonly GoalDemand[];
    readonly campaignEvaluations: readonly CampaignEvaluation[];
    readonly missionEvaluations: readonly MissionEvaluation[];
    readonly totalValuePerHour: number;
}

interface RawGearEntry {
    readonly id?: number;
    readonly name?: string;
    readonly debugname?: string;
    readonly slot?: string;
    readonly cost?: number;
    readonly tradeable?: boolean;
    readonly bonuses?: Record<string, number>;
}

const KEY_UNLOCK_QUESTS = new Set([
    'waterfall',
    'hero',
    'legends',
    'zanaris',
    'crest',
    'druid',
    'grandtree',
    'tree',
    'dragon',
    'dwarfcannon',
    'cook',
]);

function isPlainRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function lookupAccount(snapshot: WorldSnapshot | undefined, name: string | undefined): AccountState | undefined {
    if (!snapshot || !name) return undefined;
    const direct = snapshot.accounts[name] ?? snapshot.accounts[name.toLowerCase()];
    if (direct) return direct;
    const lower = name.toLowerCase();
    return Object.values(snapshot.accounts).find((a) => a.name.toLowerCase() === lower);
}

function readJsonSafe(filePath: string): unknown {
    if (!existsSync(filePath)) return undefined;
    try {
        return JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
        return undefined;
    }
}

export function levelToXp(level: number): number {
    return xpForLevel(level);
}

function loadItemGpValues(root: string): Record<number, number> {
    const filePath = existsSync(join(root, 'knowledge', 'items.json'))
        ? join(root, 'knowledge', 'items.json')
        : join(repoRoot, 'knowledge', 'items.json');
    const raw = readJsonSafe(filePath);
    const out: Record<number, number> = {};
    if (Array.isArray(raw)) {
        for (const item of raw) {
            if (!isPlainRecord(item)) continue;
            if (typeof item.id === 'number' && Number.isSafeInteger(item.id) && item.id >= 0) {
                const cost = typeof item.cost === 'number' && Number.isFinite(item.cost) && item.cost >= 0 ? item.cost : 1;
                out[item.id] = Math.max(1, cost);
            }
        }
    }
    return out;
}

function loadDefaultGearTargets(root: string): GearCollectionTarget[] {
    const filePath = existsSync(join(root, 'knowledge', 'gear.json'))
        ? join(root, 'knowledge', 'gear.json')
        : join(repoRoot, 'knowledge', 'gear.json');
    const raw = readJsonSafe(filePath);
    if (!Array.isArray(raw)) return [];

    const bestBySlot = new Map<string, Array<{ entry: GearCollectionTarget; score: number }>>();
    for (const item of raw) {
        if (!isPlainRecord(item)) continue;
        const g = item as RawGearEntry;
        if (
            typeof g.id !== 'number' ||
            !Number.isSafeInteger(g.id) ||
            g.id < 0 ||
            typeof g.name !== 'string' ||
            g.name.trim().length === 0 ||
            typeof g.slot !== 'string' ||
            g.slot.trim().length === 0
        ) {
            continue;
        }
        const b = isPlainRecord(g.bonuses) ? g.bonuses : {};
        const offenceScore =
            Math.max(Number(b.stabAttack ?? 0), Number(b.slashAttack ?? 0), Number(b.crushAttack ?? 0)) +
            Number(b.strength ?? 0) * 1.4 +
            Number(b.magicAttack ?? 0) * 1.1 +
            Number(b.rangeAttack ?? 0) * 1.1 +
            Number(b.rangeStrength ?? 0) * 1.3 +
            Number(b.prayer ?? 0) * 1.5;
        const defenceScore =
            (Number(b.stabDefence ?? 0) +
                Number(b.slashDefence ?? 0) +
                Number(b.crushDefence ?? 0) +
                Number(b.rangeDefence ?? 0) +
                Number(b.magicDefence ?? 0)) *
            0.2;
        const score = offenceScore + defenceScore;
        if (score <= 5) continue;
        if (/^dragon_|^abyssal_|^rune_|^mystic_|^black_dhide|^amulet_of_glory|^amulet_of_fury|^barrows_|^berserker_|^helm_of_neitiznot|^fire_cape/i.test(g.debugname ?? '') || score >= 25) {
            const list = bestBySlot.get(g.slot) ?? [];
            list.push({
                entry: {
                    itemId: g.id,
                    itemName: g.name.trim(),
                    slot: g.slot,
                    count: 1,
                    valueWeight: Math.max(25, Math.round(score * 3)),
                },
                score,
            });
            bestBySlot.set(g.slot, list);
        }
    }

    const targets: GearCollectionTarget[] = [];
    for (const [, list] of [...bestBySlot.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        list.sort((a, b) => b.score - a.score || a.entry.itemId - b.entry.itemId);
        for (const top of list.slice(0, 2)) {
            targets.push(top.entry);
        }
    }
    return targets.slice(0, 20);
}

export class DemandEngine {
    readonly catalog: ActivityCatalog;
    readonly rateStore?: RateStore;
    readonly root: string;
    private readonly goalWeights: Record<GoalKind, number>;
    private readonly coinReserveFloor: number;
    private readonly armyTargets: Readonly<Record<string, number>>;
    private readonly itemValuesGp: Readonly<Record<number, number>>;
    private readonly defaultGearTargets: readonly GearCollectionTarget[];
    private readonly customGearTargets?: readonly GearCollectionTarget[];
    private readonly customQuestCatalog?: readonly QuestDemandSeed[];
    private readonly customSkillTargets?: readonly SkillDemandTarget[];

    private campaignMap = new Map<string, Campaign>();
    private missionMap = new Map<string, Mission>();

    constructor(opts: DemandEngineOptions) {
        this.catalog = opts.catalog;
        this.rateStore = opts.rateStore;
        this.root = opts.root ?? repoRoot;
        this.goalWeights = { ...GOAL_BASE_WEIGHTS, ...(opts.goalWeights ?? {}) };
        this.coinReserveFloor = Math.max(1, Math.round(opts.coinReserveFloor ?? DEFAULT_COIN_RESERVE_FLOOR));
        this.armyTargets = opts.armyTargets ?? DEFAULT_ARMY_COMBAT_TARGETS;
        this.itemValuesGp = loadItemGpValues(this.root);
        this.defaultGearTargets = opts.gearTargets ?? loadDefaultGearTargets(this.root);
        this.customGearTargets = opts.gearTargets;
        this.customQuestCatalog = opts.questCatalog;
        this.customSkillTargets = opts.skillTargets;

        const initialCampaigns = opts.campaigns ?? loadCampaignManifests({ root: this.root });
        this.setCampaigns(initialCampaigns);
        const initialMissions = opts.missions ?? loadMissionManifests({ root: this.root });
        this.setMissions(initialMissions);
    }

    campaigns(): readonly Campaign[] {
        return [...this.campaignMap.values()];
    }

    missions(): readonly Mission[] {
        return [...this.missionMap.values()];
    }

    setCampaigns(campaigns: readonly Campaign[]): void {
        this.campaignMap.clear();
        for (const c of campaigns) this.upsertCampaign(c);
    }

    upsertCampaign(campaign: Campaign): void {
        const errors = validateCampaign(campaign);
        if (errors.length > 0) {
            throw new Error(`Invalid Campaign "${String((campaign as Campaign)?.id)}": ${errors.join('; ')}`);
        }
        this.campaignMap.set(campaign.id, campaign);
    }

    setCampaignState(campaignId: string, state: CampaignState): boolean {
        const existing = this.campaignMap.get(campaignId);
        if (!existing) return false;
        const next: Campaign = { ...existing, state };
        const errors = validateCampaign(next);
        if (errors.length > 0) {
            throw new Error(`Cannot transition campaign "${campaignId}" to "${state}": ${errors.join('; ')}`);
        }
        this.campaignMap.set(campaignId, next);
        return true;
    }

    setMissions(missions: readonly Mission[]): void {
        this.missionMap.clear();
        for (const m of missions) this.upsertMission(m);
    }

    upsertMission(mission: Mission): void {
        const errors = validateMission(mission);
        if (errors.length > 0) {
            throw new Error(`Invalid Mission "${String((mission as Mission)?.id)}": ${errors.join('; ')}`);
        }
        this.missionMap.set(mission.id, mission);
    }

    setMissionState(missionId: string, state: MissionState): boolean {
        const existing = this.missionMap.get(missionId);
        if (!existing) return false;
        const next: Mission = { ...existing, state };
        const errors = validateMission(next);
        if (errors.length > 0) {
            throw new Error(`Cannot transition mission "${missionId}" to "${state}": ${errors.join('; ')}`);
        }
        this.missionMap.set(missionId, next);
        return true;
    }

    applyOperatorCommand(cmd: OperatorCommand): boolean {
        switch (cmd.kind) {
            case 'set_campaign_state':
                return this.setCampaignState(cmd.campaignId, cmd.state);
            case 'upsert_campaign':
                this.upsertCampaign(cmd.campaign);
                return true;
            case 'set_mission_state':
                return this.setMissionState(cmd.missionId, cmd.state);
            case 'upsert_mission':
                this.upsertMission(cmd.mission);
                return true;
            default:
                return false;
        }
    }

    private rateFor(def: ActivityDefinition, acct?: AccountState, snapshot?: WorldSnapshot): RateEstimate {
        return this.rateStore ? this.rateStore.estimate(def.id, acct, snapshot) : def.baselineRate;
    }

    private bestSkillHours(
        skill: string,
        currentLevel: number,
        targetLevel: number,
        currentXp: number | undefined,
        targetXp: number | undefined,
        acct?: AccountState,
        snapshot?: WorldSnapshot,
    ): number {
        const rawTargetXp = targetXp ?? levelToXp(targetLevel);
        const rawCurrentXp = currentXp !== undefined && currentXp < rawTargetXp
            ? currentXp
            : levelToXp(currentLevel);
        const needXp = Math.max(1, rawTargetXp - rawCurrentXp);
        const allCandidates = this.catalog.findBySkill(skill).filter((act) => act.family !== 'quest');
        const trusted = allCandidates.filter((act) => act.trust !== 'experimental');
        const pool = trusted.length > 0 ? trusted : allCandidates;
        const candidates = pool.filter((act) => {
            const reqLvl = typeof act.config?.requiredLevel === 'number' ? act.config.requiredLevel : 1;
            return reqLvl <= targetLevel;
        });
        const effectiveCandidates = candidates.length > 0 ? candidates : pool;
        if (effectiveCandidates.length === 0) {
            return Math.max(DEFAULT_MIN_DEMAND_HOURS, needXp / 50_000);
        }
        let bestHours = Number.POSITIVE_INFINITY;
        for (const act of effectiveCandidates) {
            const rate = this.rateFor(act, acct, snapshot);
            const xpPerTick = rate.skillXpPerTick?.[skill] ?? rate.xpPerTick;
            if (xpPerTick <= 0) continue;
            const ticks = rate.setupTicks + needXp / xpPerTick;
            const hours = ticks / TICKS_PER_HOUR;
            if (hours < bestHours) bestHours = hours;
        }
        return Number.isFinite(bestHours) ? Math.max(DEFAULT_MIN_DEMAND_HOURS, bestHours) : 1.0;
    }

    estimateEndToEndHours(demand: GoalDemand, snapshot?: WorldSnapshot): number {
        const acct = lookupAccount(snapshot, demand.assignedAccount);
        const target = demand.target;

        switch (target.kind) {
            case 'item': {
                const remaining = Math.max(1, demand.remaining || target.count);
                const candidates = this.catalog.findByOutputItem(target.itemId);
                let bestHours = Number.POSITIVE_INFINITY;
                for (const act of candidates) {
                    const rate = this.rateFor(act, acct, snapshot);
                    if (rate.unitsPerTick <= 0) continue;
                    const outPerUnit = rate.outputsPerUnit?.[target.itemId] ?? 1;
                    const neededUnits = remaining / Math.max(0.01, outPerUnit);
                    const batchSize = Math.max(rate.minBatchUnits, 50);
                    const trips = Math.max(1, Math.ceil(neededUnits / batchSize));
                    const ticks = trips * rate.setupTicks + neededUnits / rate.unitsPerTick;
                    const hours = ticks / TICKS_PER_HOUR;
                    if (hours < bestHours) bestHours = hours;
                }
                if (Number.isFinite(bestHours)) {
                    return Math.max(DEFAULT_MIN_DEMAND_HOURS, bestHours);
                }
                // Market/shop fallback: setup trip + acquisition ticks scaled modestly by quantity.
                const fallbackTicks = 120 + Math.min(3_000, remaining * 0.25);
                return Math.max(DEFAULT_MIN_DEMAND_HOURS, fallbackTicks / TICKS_PER_HOUR);
            }

            case 'quest': {
                const qAcct = lookupAccount(snapshot, target.account) ?? acct;
                const candidates = this.catalog.findByQuest(target.questSlug);
                let bestHours = Number.POSITIVE_INFINITY;
                for (const act of candidates) {
                    const rate = this.rateFor(act, qAcct, snapshot);
                    if (rate.unitsPerTick <= 0) continue;
                    const ticks = rate.setupTicks + 1 / rate.unitsPerTick;
                    const hours = ticks / TICKS_PER_HOUR;
                    if (hours < bestHours) bestHours = hours;
                }
                return Number.isFinite(bestHours) ? Math.max(DEFAULT_MIN_DEMAND_HOURS, bestHours) : 0.4;
            }

            case 'skill': {
                const sAcct = lookupAccount(snapshot, target.account) ?? acct;
                const curSkill = sAcct?.skills[target.skill] ?? sAcct?.skills[target.skill.toLowerCase()];
                return this.bestSkillHours(
                    target.skill,
                    curSkill?.level ?? 1,
                    target.targetLevel,
                    curSkill?.xp,
                    target.targetXp,
                    sAcct,
                    snapshot,
                );
            }

            case 'combat_readiness': {
                const cAcct = lookupAccount(snapshot, target.account) ?? acct;
                let totalHours = 0;
                for (const [skill, targetLvl] of Object.entries(target.targets)) {
                    const cur = cAcct?.skills[skill] ?? cAcct?.skills[skill.toLowerCase()];
                    const curLvl = cur?.level ?? 1;
                    if (curLvl >= targetLvl) continue;
                    totalHours += this.bestSkillHours(skill, curLvl, targetLvl, cur?.xp, undefined, cAcct, snapshot);
                }
                return Math.max(DEFAULT_MIN_DEMAND_HOURS, totalHours);
            }

            case 'coins': {
                const remainingGp = Math.max(1, demand.remaining || target.amount);
                let bestHours = Number.POSITIVE_INFINITY;
                for (const act of this.catalog.list()) {
                    const rate = this.rateFor(act, acct, snapshot);
                    if (rate.gpPerTick <= 0) continue;
                    const ticks = rate.setupTicks + remainingGp / rate.gpPerTick;
                    const hours = ticks / TICKS_PER_HOUR;
                    if (hours < bestHours) bestHours = hours;
                }
                if (Number.isFinite(bestHours)) {
                    return Math.max(DEFAULT_MIN_DEMAND_HOURS, bestHours);
                }
                return Math.max(DEFAULT_MIN_DEMAND_HOURS, remainingGp / 400_000);
            }
        }
    }

    scoreDemandPerHour(demand: GoalDemand, snapshot?: WorldSnapshot): number {
        if (!demand.active || demand.remaining <= 0 || demand.valueScore <= 0) return 0;
        const hours = this.estimateEndToEndHours(demand, snapshot);
        return demand.valueScore / Math.max(DEFAULT_MIN_DEMAND_HOURS, hours);
    }

    private emitQuestDemands(snapshot: WorldSnapshot): GoalDemand[] {
        const w = this.goalWeights.quest_board;
        if (w <= 0) return [];
        const activeAccounts = Object.values(snapshot.accounts).filter(
            (a) => !a.protectedClock && a.lifecycle !== 'paused_owner' && a.lifecycle !== 'dead',
        );
        const completedSlugs = new Set<string>();
        for (const acct of activeAccounts) {
            for (const [slug, qState] of Object.entries(acct.quests)) {
                if (qState === 'complete') {
                    completedSlugs.add(slug.toLowerCase());
                    completedSlugs.add(slug.toLowerCase().replace(/[^a-z0-9]/g, ''));
                }
            }
        }

        const seeds: QuestDemandSeed[] =
            this.customQuestCatalog !== undefined
                ? [...this.customQuestCatalog]
                : this.catalog
                      .byFamily('quest')
                      .filter((act) => Boolean(act.questSlug) && act.trust !== 'experimental')
                      .map((act) => {
                          const slug = act.questSlug!;
                          const unlockBonus = KEY_UNLOCK_QUESTS.has(slug.toLowerCase()) ? 250 : 120;
                          const trustMult = act.trust === 'live_proven' ? 1.25 : act.trust === 'practice_passed' ? 1.15 : 0.85;
                          return {
                              slug,
                              valueScore: Math.round(unlockBonus * trustMult),
                          };
                      });

        const seen = new Set<string>();
        const out: GoalDemand[] = [];
        for (const seed of seeds) {
            const slug = seed.slug.trim();
            if (!slug || seen.has(slug.toLowerCase())) continue;
            seen.add(slug.toLowerCase());
            const norm = slug.toLowerCase().replace(/[^a-z0-9]/g, '');
            const matchedActs = this.catalog.findByQuest(slug);
            const questNameNorm = typeof (matchedActs[0]?.config as Record<string, unknown> | undefined)?.questName === 'string'
                ? String((matchedActs[0]!.config as Record<string, unknown>).questName).toLowerCase().replace(/[^a-z0-9]/g, '')
                : undefined;
            const done =
                completedSlugs.has(slug.toLowerCase()) ||
                completedSlugs.has(norm) ||
                (questNameNorm !== undefined && completedSlugs.has(questNameNorm)) ||
                activeAccounts.some((acct) => hasCompletedQuest(acct, slug));
            if (done) continue;
            out.push({
                id: `goal:quest_board:${slug}`,
                goalKind: 'quest_board',
                sourceId: 'owner:quest_board',
                valueScore: seed.valueScore * w,
                target: { kind: 'quest', questSlug: slug },
                fulfilled: 0,
                remaining: 1,
                priorityWeight: w,
                active: true,
            });
        }
        return out;
    }

    private emitGearDemands(snapshot: WorldSnapshot): GoalDemand[] {
        const w = this.goalWeights.gear_collection;
        if (w <= 0) return [];
        const targets = this.customGearTargets ?? this.defaultGearTargets;
        const activeAccounts = Object.values(snapshot.accounts).filter(
            (a) => a.lifecycle !== 'dead' && !a.protectedClock,
        );
        const out: GoalDemand[] = [];
        for (const gear of targets) {
            let ownedTotal = 0;
            for (const acct of activeAccounts) {
                ownedTotal += accountOwnedItemCount(acct, gear.itemId);
            }
            const fulfilled = Math.min(gear.count, ownedTotal);
            const remaining = gear.count - fulfilled;
            if (remaining <= 0) continue;
            const unitWeight = gear.valueWeight ?? 80;
            out.push({
                id: `goal:gear_collection:${gear.itemId}`,
                goalKind: 'gear_collection',
                sourceId: 'owner:gear_collection',
                valueScore: remaining * unitWeight * w,
                target: {
                    kind: 'item',
                    itemId: gear.itemId,
                    itemName: gear.itemName,
                    count: gear.count,
                },
                fulfilled,
                remaining,
                priorityWeight: w,
                active: true,
            });
        }
        return out;
    }

    private emitPkArmyDemands(snapshot: WorldSnapshot): GoalDemand[] {
        const w = this.goalWeights.pk_army;
        if (w <= 0) return [];
        const out: GoalDemand[] = [];
        const candidates = Object.values(snapshot.accounts)
            .filter(
                (a) =>
                    !a.protectedClock &&
                    a.lifecycle !== 'paused_owner' &&
                    a.lifecycle !== 'dead' &&
                    (a.role === 'army' || a.role === 'auto'),
            )
            .sort((a, b) => a.name.localeCompare(b.name));

        for (const acct of candidates) {
            const effectiveTargets: Record<string, number> = {};
            let totalTarget = 0;
            let totalFulfilled = 0;
            for (const [skill, desiredRaw] of Object.entries(this.armyTargets)) {
                const cap = acct.maxLevels?.[skill] ?? acct.maxLevels?.[skill.toLowerCase()];
                const targetLvl = Math.max(1, Math.min(99, cap !== undefined ? Math.min(desiredRaw, cap) : desiredRaw));
                effectiveTargets[skill] = targetLvl;
                const curLvl = Math.max(1, Math.min(targetLvl, acct.skills[skill]?.level ?? acct.skills[skill.toLowerCase()]?.level ?? 1));
                totalTarget += targetLvl;
                totalFulfilled += curLvl;
            }
            const remaining = Math.max(0, totalTarget - totalFulfilled);
            if (remaining <= 0) continue;
            out.push({
                id: `goal:pk_army:${acct.name}`,
                goalKind: 'pk_army',
                sourceId: 'owner:pk_army',
                valueScore: remaining * 8 * w,
                target: {
                    kind: 'combat_readiness',
                    account: acct.name,
                    targets: effectiveTargets,
                },
                fulfilled: totalFulfilled,
                remaining,
                priorityWeight: w,
                assignedAccount: acct.name,
                active: true,
            });
        }
        return out;
    }

    private emitSkillDemands(snapshot: WorldSnapshot): GoalDemand[] {
        if (!this.customSkillTargets || this.customSkillTargets.length === 0) return [];
        const out: GoalDemand[] = [];
        for (const spec of this.customSkillTargets) {
            const acct = lookupAccount(snapshot, spec.account);
            if (acct && (acct.protectedClock || acct.lifecycle === 'paused_owner' || acct.lifecycle === 'dead')) {
                continue;
            }
            const cur = acct?.skills[spec.skill] ?? acct?.skills[spec.skill.toLowerCase()];
            const curLvl = cur?.level ?? 1;
            const remaining = Math.max(0, spec.targetLevel - curLvl);
            if (remaining <= 0) continue;
            const kind = spec.goalKind ?? 'pk_army';
            const w = this.goalWeights[kind];
            if (w <= 0) continue;
            out.push({
                id: `goal:${kind}:skill:${spec.account}:${spec.skill}`,
                goalKind: kind,
                sourceId: `owner:${kind}`,
                valueScore: (spec.valueScore ?? remaining * 12) * w,
                target: {
                    kind: 'skill',
                    account: spec.account,
                    skill: spec.skill,
                    targetLevel: spec.targetLevel,
                    ...(spec.targetXp !== undefined ? { targetXp: spec.targetXp } : {}),
                },
                fulfilled: curLvl,
                remaining,
                priorityWeight: w,
                assignedAccount: spec.account,
                active: true,
            });
        }
        return out;
    }

    private emitCoinFundDemands(snapshot: WorldSnapshot): GoalDemand[] {
        const w = this.goalWeights.coin_fund;
        if (w <= 0) return [];
        let liquidCoins = 0;
        for (const acct of Object.values(snapshot.accounts)) {
            if (acct.protectedClock || acct.lifecycle === 'paused_owner' || acct.lifecycle === 'dead') continue;
            liquidCoins += accountOwnedItemCount(acct, 995);
        }
        if (snapshot.geEscrowCoins) {
            for (const coins of Object.values(snapshot.geEscrowCoins)) {
                if (typeof coins === 'number' && Number.isFinite(coins) && coins > 0) liquidCoins += Math.floor(coins);
            }
        }
        const fulfilled = Math.min(this.coinReserveFloor, liquidCoins);
        const remaining = this.coinReserveFloor - fulfilled;
        if (remaining <= 0) return [];
        return [
            {
                id: 'goal:coin_fund:fleet',
                goalKind: 'coin_fund',
                sourceId: 'owner:coin_fund',
                valueScore: Math.max(50, Math.sqrt(remaining)) * w,
                target: { kind: 'coins', amount: this.coinReserveFloor },
                fulfilled,
                remaining,
                priorityWeight: w,
                active: true,
            },
        ];
    }

    evaluate(
        snapshot: WorldSnapshot,
        opts: { readonly includeInactive?: boolean } = {},
    ): DemandReport {
        const includeInactive = opts.includeInactive === true;
        const campaignEvaluations = evaluateCampaigns(this.campaigns(), snapshot, {
            includeCompletedOrPaused: includeInactive,
            itemValuesGp: this.itemValuesGp,
        });
        const missionEvaluations = evaluateMissions(this.missions(), snapshot, {
            includePaused: includeInactive,
            itemValuesGp: this.itemValuesGp,
        });

        const rawDemands: GoalDemand[] = [];
        for (const ce of campaignEvaluations) {
            for (const s of ce.shortfalls) {
                const gw = this.goalWeights[s.goalKind];
                rawDemands.push({
                    ...s,
                    valueScore: s.valueScore * gw,
                    priorityWeight: s.priorityWeight * gw,
                });
            }
        }
        for (const me of missionEvaluations) {
            for (const s of me.shortfalls) {
                const gw = this.goalWeights[s.goalKind];
                rawDemands.push({
                    ...s,
                    valueScore: s.valueScore * gw,
                    priorityWeight: s.priorityWeight * gw,
                });
            }
        }

        rawDemands.push(...this.emitQuestDemands(snapshot));
        rawDemands.push(...this.emitGearDemands(snapshot));
        rawDemands.push(...this.emitPkArmyDemands(snapshot));
        rawDemands.push(...this.emitSkillDemands(snapshot));
        rawDemands.push(...this.emitCoinFundDemands(snapshot));

        const scored: GoalDemand[] = [];
        for (const item of rawDemands) {
            if (!includeInactive && (!item.active || item.remaining <= 0)) continue;
            const valuePerHour = this.scoreDemandPerHour(item, snapshot);
            const enriched: GoalDemand = {
                ...item,
                valuePerHour,
            };
            const errors = validateGoalDemand(enriched);
            if (errors.length > 0) {
                throw new Error(`DemandEngine produced invalid GoalDemand "${item.id}": ${errors.join('; ')}`);
            }
            scored.push(enriched);
        }

        scored.sort(
            (a, b) =>
                (b.valuePerHour ?? 0) - (a.valuePerHour ?? 0) ||
                b.priorityWeight - a.priorityWeight ||
                b.valueScore - a.valueScore ||
                a.id.localeCompare(b.id),
        );

        const activeDemands = scored.filter((d) => d.active && d.remaining > 0);
        const totalValuePerHour = activeDemands.reduce((acc, d) => acc + (d.valuePerHour ?? 0), 0);

        return {
            evaluatedAt: snapshot.at,
            demands: scored,
            activeDemands,
            campaignEvaluations,
            missionEvaluations,
            totalValuePerHour,
        };
    }

    activeDemands(snapshot: WorldSnapshot): readonly GoalDemand[] {
        return this.evaluate(snapshot, { includeInactive: false }).activeDemands;
    }

    allDemands(snapshot: WorldSnapshot): readonly GoalDemand[] {
        return this.evaluate(snapshot, { includeInactive: true }).demands;
    }
}

export function createDemandEngine(opts: DemandEngineOptions): DemandEngine {
    return new DemandEngine(opts);
}
