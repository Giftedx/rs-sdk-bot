// Skilling tool (axe/pickaxe), elemental staff, and tool-shop upgrade recommendation planners.
import type { Gear, Skill } from '../../../knowledge/src/gear';
import { canWear } from '../../../knowledge/src/gear-query';
import type { GearCount } from '../owned-loadout';
import { gearById, gearCatalogBySlot, shopAccessible, shopCatalog } from './catalog';
import {
    ELEMENTAL_STAFF_RUNES,
    MINING_PICKAXES_DESC,
    WOODCUTTING_AXES_DESC,
    normalizeCompletedQuests,
    normalizeSkills,
    stockTotals,
    type GearSkillLevels,
    type QuestInput,
    type ShopSource,
} from './model';
import { isMagicWeapon, scoreGearForStyle } from './scoring';

export interface ToolCandidate {
    item: Gear;
    useSkill: 'woodcutting' | 'mining';
    useLevel: number;
    paramLevel: number;
    wieldAttackLevel: number;
    canUse: boolean;
    canWield: boolean;
    carryMode: 'wield' | 'inventory';
    shops: ShopSource[];
    tradeable: boolean;
}

export interface ToolRecommendation {
    kind: 'woodcutting-axe' | 'mining-pickaxe';
    current: ToolCandidate | null;
    bestUsable: ToolCandidate | null;
    nextAcquirable: ToolCandidate | null;
    nextUnlock: ToolCandidate | null;
}

function buildToolCandidates(
    orderedIdsDesc: readonly number[],
    useSkill: 'woodcutting' | 'mining',
    levels?: GearSkillLevels,
    enforceUseLevel = true,
): ToolCandidate[] {
    const skillMap = normalizeSkills(levels);
    const shops = shopCatalog();
    const useStat = skillMap[useSkill] ?? 1;
    const attackStat = skillMap.attack ?? 1;

    const out: ToolCandidate[] = [];
    for (let i = 0; i < orderedIdsDesc.length; i++) {
        const item = gearById(orderedIdsDesc[i]!);
        if (!item) continue;
        const paramLevel = Math.max(1, item.tier ?? 1);
        // Rev-289 woodcut.rs2:220-240 uses any axe without a Woodcutting level gate;
        // mining pickaxe_checker.rs2 checks stat(mining) >= oc_param(pickaxe, levelrequire).
        const useLevel = enforceUseLevel ? paramLevel : 1;
        const wieldAttackLevel = item.requires.skills.attack ?? 1;
        const canUse = useStat >= useLevel;
        const canWield = attackStat >= wieldAttackLevel;
        const itemShops = shops.get(item.id);
        out.push({
            item,
            useSkill,
            useLevel,
            paramLevel,
            wieldAttackLevel,
            canUse,
            canWield,
            carryMode: canWield ? 'wield' : 'inventory',
            shops: itemShops ? [...itemShops] : [],
            tradeable: item.tradeable,
        });
    }
    return out;
}

function selectTool(
    kind: 'woodcutting-axe' | 'mining-pickaxe',
    orderedIdsDesc: readonly number[],
    useSkill: 'woodcutting' | 'mining',
    stock: readonly GearCount[],
    levels?: GearSkillLevels,
    enforceUseLevel = true,
): ToolRecommendation {
    const owned = stockTotals(stock);
    const candidates = buildToolCandidates(orderedIdsDesc, useSkill, levels, enforceUseLevel);

    let current: ToolCandidate | null = null;
    let bestUsable: ToolCandidate | null = null;
    let nextUnlock: ToolCandidate | null = null;
    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]!;
        if (c.canUse) {
            if (!bestUsable) bestUsable = c;
            if (!current && (owned.get(c.item.id) ?? 0) > 0) current = c;
        } else if (!current) {
            // Track the lowest locked tier strictly better than current usable.
            nextUnlock = c;
        }
    }

    const nextAcquirable = bestUsable && (!current || bestUsable.item.id !== current.item.id)
        ? bestUsable
        : null;

    return { kind, current, bestUsable, nextAcquirable, nextUnlock };
}

export function bestWoodcuttingAxe(
    stock: readonly GearCount[],
    levels?: GearSkillLevels,
    options?: { enforceAxeLevel?: boolean },
): ToolRecommendation {
    // In rev 289 (woodcut.rs2:220-240), axes have no Woodcutting level gate unless caller opts in.
    return selectTool('woodcutting-axe', WOODCUTTING_AXES_DESC, 'woodcutting', stock, levels, options?.enforceAxeLevel ?? false);
}

export function bestMiningPickaxe(stock: readonly GearCount[], levels?: GearSkillLevels): ToolRecommendation {
    return selectTool('mining-pickaxe', MINING_PICKAXES_DESC, 'mining', stock, levels, true);
}

export interface ElementalStaffOption {
    item: Gear;
    providedRunes: readonly number[];
    coveredRuneScore: number;
    shops: ShopSource[];
    tradeable: boolean;
}

export interface ElementalStaffRecommendation {
    current: ElementalStaffOption | null;
    bestUsable: ElementalStaffOption | null;
    nextAcquirable: ElementalStaffOption | null;
    nextUnlock: Gear | null;
}

export interface ElementalStaffOptions {
    runeIds?: readonly number[];
    members?: boolean;
    includePlainFallback?: boolean;
    requireWieldable?: boolean;
}

type ScoredStaffOption = ElementalStaffOption & { magicScore: number };
type ScoredLockedStaff = { item: Gear; providedRunes: readonly number[]; coveredRuneScore: number; magicScore: number };

function elementalStaffRankList(
    levels?: GearSkillLevels,
    quests?: QuestInput,
    options: ElementalStaffOptions = {},
): { usable: ScoredStaffOption[]; locked: ScoredLockedStaff[] } {
    const shops = shopCatalog();
    const runeIds = options.runeIds ?? [];
    const runeWeights = runeIds.length > 0 ? new Map<number, number>() : null;
    if (runeWeights) {
        for (let idx = 0; idx < runeIds.length; idx++) {
            const id = runeIds[idx]!;
            // Count rune multiplicity (e.g. Curse: 3 Earth + 2 Water) plus gentle first-listed tie-break.
            runeWeights.set(id, (runeWeights.get(id) ?? 0) + 1 + (runeIds.length - idx) * 1e-4);
        }
    }
    const allowPlain = options.includePlainFallback === true;
    const requireWieldable = options.requireWieldable !== false;
    const allowMembers = options.members !== false;
    const skillMap = requireWieldable ? normalizeSkills(levels) as Partial<Record<Skill, number>> : null;
    const done = requireWieldable ? normalizeCompletedQuests(quests) : null;

    const usable: ScoredStaffOption[] = [];
    const locked: ScoredLockedStaff[] = [];
    const weapons = gearCatalogBySlot('righthand');
    for (let i = 0; i < weapons.length; i++) {
        const item = weapons[i]!;
        if (!isMagicWeapon(item)) continue;
        if (!allowMembers && item.members) continue;
        const providedRunes = ELEMENTAL_STAFF_RUNES[item.id];
        let coveredRuneScore = 0;
        if (providedRunes) {
            if (runeWeights) {
                for (let r = 0; r < providedRunes.length; r++) {
                    coveredRuneScore += runeWeights.get(providedRunes[r]!) ?? 0;
                }
                if (coveredRuneScore === 0) continue;
            } else {
                coveredRuneScore = providedRunes.length;
            }
        } else if (!(allowPlain && (item.id === 1389 || item.id === 1379))) {
            continue;
        }
        const runes = providedRunes ?? [];
        const magicScore = scoreGearForStyle(item, 'magic');
        if (!requireWieldable || canWear(item, skillMap!, done!)) {
            const itemShops = shops.get(item.id);
            usable.push({ item, providedRunes: runes, coveredRuneScore, magicScore, shops: itemShops ? [...itemShops] : [], tradeable: item.tradeable });
        } else {
            locked.push({ item, providedRunes: runes, coveredRuneScore, magicScore });
        }
    }

    const sortFn = (a: { item: Gear; coveredRuneScore: number; magicScore: number }, b: { item: Gear; coveredRuneScore: number; magicScore: number }) =>
        (b.coveredRuneScore - a.coveredRuneScore)
        || (b.magicScore - a.magicScore)
        || (a.item.id - b.item.id);

    usable.sort(sortFn);
    locked.sort(sortFn);
    return { usable, locked };
}

/** Pick the best wieldable (or carried) elemental staff matching requested runes (ordered by savings). */
export function bestElementalStaffForRunes(
    stock: readonly GearCount[],
    levels?: GearSkillLevels,
    quests?: QuestInput,
    options: ElementalStaffOptions = {},
): ElementalStaffRecommendation {
    const owned = stockTotals(stock);
    const { usable, locked } = elementalStaffRankList(levels, quests, options);
    const current = usable.find(c => (owned.get(c.item.id) ?? 0) > 0) ?? null;
    const bestUsable = usable[0] ?? null;
    const nextAcquirable = bestUsable && (!current || bestUsable.item.id !== current.item.id)
        ? bestUsable
        : null;
    const minScore = current?.coveredRuneScore ?? 0;
    const curMagicScore = current ? current.magicScore : -1;
    let nextUnlock: Gear | null = null;
    let bestUnlockReq = Infinity;
    for (let i = 0; i < locked.length; i++) {
        const c = locked[i]!;
        if (!(c.coveredRuneScore > minScore || (c.coveredRuneScore >= minScore && c.magicScore > curMagicScore))) continue;
        const req = Math.max(c.item.requires.skills.magic ?? 1, c.item.requires.skills.attack ?? 1);
        if (req < bestUnlockReq || (req === bestUnlockReq && nextUnlock && c.item.id < nextUnlock.id)) {
            bestUnlockReq = req;
            nextUnlock = c.item;
        }
    }
    return { current, bestUsable, nextAcquirable, nextUnlock };
}

export interface ToolShopUpgradePlan {
    kind: 'woodcutting-axe' | 'mining-pickaxe' | 'magic-staff';
    currentId: number | null;
    target: Gear;
    shop: ShopSource;
    price: number;
    coinBudgetNeeded: number;
}

export interface ToolShopUpgradeOptions {
    allowedShops?: readonly string[];
    coinReserve?: number;
    priceBufferRatio?: number;
    onlyWhenStarterOrMissing?: boolean;
    enforceAxeLevel?: boolean;
    runeIds?: readonly number[];
    members?: boolean;
    quests?: QuestInput;
    /** The account's quest points, for shops behind a quest-point gate. Unknown counts as 0. */
    questPoints?: number;
}

/** Plan the best shop-purchasable tool or elemental staff upgrade strictly better than owned usable stock. */
export function planToolShopUpgrade(
    kind: 'woodcutting-axe' | 'mining-pickaxe' | 'magic-staff',
    stock: readonly GearCount[],
    coins: number,
    levels?: GearSkillLevels,
    options: ToolShopUpgradeOptions = {},
): ToolShopUpgradePlan | null {
    const skillMap = normalizeSkills(levels);
    const done = normalizeCompletedQuests(options.quests);
    const owned = stockTotals(stock);
    const reserve = Math.max(0, options.coinReserve ?? 0);
    const ratio = options.priceBufferRatio ?? 1.25;

    let currentId: number | null = null;
    let betterCandidates: { item: Gear; shops: ShopSource[] }[] = [];

    if (kind === 'magic-staff') {
        const { usable } = elementalStaffRankList(levels, options.quests, {
            runeIds: options.runeIds,
            members: options.members,
            includePlainFallback: false,
            requireWieldable: true,
        });
        const curIdx = usable.findIndex(c => (owned.get(c.item.id) ?? 0) > 0);
        const current = curIdx >= 0 ? usable[curIdx]! : null;
        currentId = current?.item.id ?? null;
        if (options.onlyWhenStarterOrMissing && current) return null;
        betterCandidates = curIdx >= 0 ? usable.slice(0, curIdx) : usable;
    } else {
        const ordered = kind === 'woodcutting-axe' ? WOODCUTTING_AXES_DESC : MINING_PICKAXES_DESC;
        const skill = kind === 'woodcutting-axe' ? 'woodcutting' : 'mining';
        const enforce = kind === 'mining-pickaxe' || options.enforceAxeLevel === true;
        const usable = buildToolCandidates(ordered, skill, levels, enforce).filter(c => c.canUse);
        const curIdx = usable.findIndex(c => (owned.get(c.item.id) ?? 0) > 0);
        const current = curIdx >= 0 ? usable[curIdx]! : null;
        currentId = current?.item.id ?? null;
        const starterId = kind === 'woodcutting-axe' ? 1351 : 1265;
        if (options.onlyWhenStarterOrMissing && current && current.item.id !== starterId) return null;
        betterCandidates = curIdx >= 0 ? usable.slice(0, curIdx) : usable;
    }

    for (const candidate of betterCandidates) {
        const accessibleShops = candidate.shops
            .filter(s => shopAccessible(s, skillMap, done, options.allowedShops, options.questPoints))
            .sort((a, b) => a.cost - b.cost);
        for (const shop of accessibleShops) {
            const coinBudgetNeeded = Math.ceil(shop.cost * ratio) + reserve;
            if (coins >= coinBudgetNeeded) {
                return {
                    kind,
                    currentId,
                    target: candidate.item,
                    shop,
                    price: shop.cost,
                    coinBudgetNeeded,
                };
            }
        }
    }
    return null;
}
