// Autopilot: writes a fleet side's swarm jobs from the route supply bill, account skills and holdings, and tick waste,
// so no person picks jobs, restarts ended ones or spots loops (plan Lanes table, Autopilot).
// Facade entry point re-exporting the public planning API and backwards-compatible test/caller symbols from
// cohesive acyclic submodules under ./autopilot/.
export type {
    Acct, Assignment, Flow, Funding, Inputs, ItemFunding, KitLine, KitStage, Lack, Market, Needs,
    QuestDemandRow, SpecialistStageLine, Spot, Stock, Template,
} from './autopilot/world';

export {
    AIO_PLACES, AMMO_MARKET, ARMOUR_BAND, ARMOUR_MARKET, ARMY_BANK, BLACK_CAVE, BLACK_CAVE_PLACES,
    CAPACITY, CHICKEN_PENS, COW_FIELD, COW_FIELD_CAPACITY, FEATHER_TARGET, FERRY_FARE, FREMENNIK,
    FREMENNIK_BAND, GRAIL_BAND, GRAIL_MEALS, GRAIL_PLACE, KNIGHT_BANK, KNIGHT_SHARE, KNIGHT_SPOTS, LOST_CITY,
    LOST_CITY_MEALS, LOST_CITY_PLACES, PEN_QUEST_POINTS, PLACES, QUEST_BAND, QUEST_DEMAND,
    QUEST_DEMAND_BAND, QUEST_DEMAND_PLACES, QUEST_DEMAND_ROWS, RANGED_ARMOUR_BAND, SHARED, SHOP_STOCK,
    SPLASH_FENCE, SPLASH_PLACES, STRIKE_TILE, TOLL, TROOPER_FIELD, TROOPER_FIELD_CAPACITY, UPASS,
    WEAPON_BAND, WEAPON_MARKET, bandLeft, combatLevel, inWestArdougne, jobResources, meetFor, norm,
    onKaramja, pairKey, placeOf, questResource, questsDoneIn, wayCost,
} from './autopilot/world';

export {
    ARMOUR_IDS, ARROW_LOW, ARROW_STOCK, BOW_IDS, COW_WEAPONS, CURSE_LEVEL, CURSE_XP,
    FOOD_HEAL, FUND_RESERVE, KIT_BUY, KIT_BUY_SCRIPT, KIT_CASH_RESERVE,
    KIT_COIN_MARGIN, KIT_PRICE_CAPS, LOWE_STOCK, OBSERVATION_FRESH_MS,
    PILOT_FALLBACK_SHARE, QUEST_CAP_FACTOR, QUEST_CAP_MIN, RANGED_KIT, RUNE_ARROW_COST,
    RUNE_ARROW_SPEND, SPECIALIST_STAGE_BILLS, SPLASH_KIT, SPLASH_START, SPLASH_TO, SQUAD_UNIT_COST,
    TRAIN_SHARE, WEAPON, WEAPON_HELD, knightCoinsPerTick, priceTable, questKitCaps, selfServePilot,
    specialistStagingNeeds, splashKit, unitValue, usableTool,
} from './autopilot/pricing';

export {
    AIR_STOCK, ARMOUR_SETS, BLOOD_FOOD, BLOOD_MEALS, BONE_KEEP, BONE_PURSE, BONE_SKILL, BONE_START,
    BOUGHT_BONE_XP, BUILD_QUESTS, CANNON_BARS, COW_BANDS, FEATHER_STOCK, FIRE_STOCK, FLAX_SPIN, FLETCH_KEEP, FLETCH_MAKE,
    FRAIL_FOOD_BUY, FRAIL_FOOD_BUY_ID, GEM_RINGS, GOLDFARM_FOOD, GOLDFARM_FRAIL,
    GRAIL_RUNES, HIDE_TARGET, HUNT_ARROWS, HUNT_ARROW_STOCK, HUNT_BAND, HUNT_FOOD, HUNT_KILLS,
    HUNT_RUNE_ARROWS, HUNT_RUNE_SPEND, HUNT_RUNE_STOCK, JAKUT_CAP, JAKUT_COINS, JAKUT_RESERVE,
    JAKUT_SWORDS, JAKUT_WAIT, LEATHER_LEVEL, LOST_CITY_BUILD, MAGIC_BAND, MAKE_BATCH, NATURE_STOCK,
    PRAYER_FIELD_BAND, QUEST_BOW_ARROWS, REGICIDE_MEALS, REGICIDE_PACK, REGICIDE_RUNES, RING_BATCH,
    ROUTE_BEFORE, SET_HIDES, SET_SHOP, STEW_BATCH, SWEEP_MEALS, TAN_COIN, UNF_POTIONS,
    UPASS_AGILITY, UPASS_MEALS, UPASS_THIEVING, aioTemplates, buildBand, catalogue, makerChains,
    questDemand, squadSupplies,
} from './autopilot/catalogue';

export {
    CLAIM_MAX_AGE_MS, DRAIN_RESULT, RETIRE_FAILS, SQUAD_RESTOCK, accountFrom, assess, claimFor,
    finishedTrainers, freshest, jobFor, mergeJobs, plannableAccounts, progressed,
    recoveringOwnerJobs, reservedAccounts, reservedResources,
} from './autopilot/claims';

export {
    AMMO_BATCH, AMMO_LOW, accountStyle, ammoStageFor, bowStageFor, goalNeeds, kitLacks,
    kitReserve, kitStyle, plan, proportionalLines,
} from './autopilot/plan';
