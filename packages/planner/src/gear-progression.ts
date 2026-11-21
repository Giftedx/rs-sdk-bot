// Rev-289 progressive loadout selection, upgrade planning, and skilling tool selection
// backed by knowledge/gear.json (packages/knowledge/src/gear-query.ts canWear/best) and knowledge/shops.json.
// Facade entry point re-exporting public types, catalogs, scoring, loadout selection, and tool reconciliation
// from cohesive acyclic submodules under ./gear-progression/.
export type {
    CombatFocus, GearSkillLevels, GearSkillName, GearUnlockKind, GearUnlockLevels, LoadoutSlotName, QuestInput,
    RangedLoadoutSlotName, ShopSource,
} from './gear-progression/model';

export {
    ELEMENTAL_RUNES, ELEMENTAL_STAFF_RUNES, MINING_PICKAXES_DESC, WEARPOS_BY_SLOT, WOODCUTTING_AXES_DESC,
    normalizeCompletedQuests, readSkillLevels,
} from './gear-progression/model';

export {
    canWearGear, gearById, gearIdByName, shopCatalog, weaponSupportsTrainSkill,
} from './gear-progression/catalog';

export {
    bestGearForSlot, crossedTierBoundary, gearUnlockLevels, scoreGearForStyle, standardArrowTiers,
    standardBowTiers, tierBoundaryOf,
} from './gear-progression/scoring';

export type {
    ElementalStaffOption, ElementalStaffOptions, ElementalStaffRecommendation, ToolCandidate, ToolRecommendation,
    ToolShopUpgradeOptions, ToolShopUpgradePlan,
} from './gear-progression/tools';

export {
    bestElementalStaffForRunes, bestMiningPickaxe, bestWoodcuttingAxe, planToolShopUpgrade,
} from './gear-progression/tools';

export type {
    BankToolSwapPlan, KnownToolShop, ReconcileBankToolHooks, SessionToolLike, ShopRetryGate, ShopToolPurchaseHooks,
} from './gear-progression/reconcile';

export {
    SHOP_RESTOCK_COOLDOWN_TICKS, executeShopToolPurchase, planBankToolSwap, reconcileBankTool, recordShopAttempt,
    sessionShopGate, sessionToolHooks, shouldAttemptShopUpgrade,
} from './gear-progression/reconcile';

export type {
    ProgressiveLoadout, ProgressiveLoadoutOptions, SlotUpgrade,
} from './gear-progression/loadout';

export {
    fireKit, meleeWeaponSlot, ownsWearableMeleeWeapon, selectProgressiveLoadout,
} from './gear-progression/loadout';
