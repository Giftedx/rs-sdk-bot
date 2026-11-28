// Walking facade: route execution, click-ahead path stepper, session adapter, and goTo orchestration
// backed by cohesive acyclic submodules under ./walk/.
export type { WalkOptions, Walker } from './walk/legs';
export { FAR_WALK_TILES, walkRoute } from './walk/legs';
export { DECK_REACH, leaveDeck, travelNpc } from './walk/travel';
export {
    MINE_JAIL_ROCKS, MINE_JAIL_WINDOW, inMineJail, leaveMineJail, mineJailRock, onMineJailCliff,
} from './walk/mine-jail';
export {
    IKOV_SECRET_DOOR, IKOV_SHACK_LADDER_DOWN, IKOV_SHINY_KEY_ID, IKOV_SHINY_KEY_TILE,
    inIkovArmadylPocket, inIkovShack, leaveIkovArmadyl, needsIkovShinyKeyExit,
} from './walk/ikov-exit';
export {
    KARAMJA_BANANA_ID, KARAMJA_CRATE, KARAMJA_GROVE_TILE, KARAMJA_JIMINUA_TILE, KARAMJA_LUTHAS_TILE, KARAMJA_SHIP_FARE,
    earnKaramjaFare, inKaramjaIsland, needsKaramjaFareEscape, pickDispensableKaramjaItems,
} from './walk/karamja-fare';
export {
    DETOUR_MARGIN, TELEPORT_JEWELRY_RE, fareDetour, goTo, unreadJournalQuests, withoutJewelry, withoutSpells, withoutTeleports,
} from './walk/goto';
export { FLOAT_BANK_TILES, FLOAT_WALK_TILES, fareFloatNeed, topUpFareFloat, unpaidFaresNear } from './walk/fare-float';
export type {
    PathDeps, PathLoc, PathOptions, PathPoint, PathResult, PathTile,
} from './walk/path';
export { DEFAULT_RUN_THRESHOLD, expandPath, walkPath } from './walk/path';
export { applyKnownDoorBlocks, sessionWalker } from './walk/session';
export type { RouteHarm } from './walk/harm';
export { eatBeforeWalk, foodToTake, routeDangerText, routeHarm, stageFood } from './walk/harm';
