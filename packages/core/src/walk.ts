// Walking facade: route execution, click-ahead path stepper, session adapter, and goTo orchestration
// backed by cohesive acyclic submodules under ./walk/.
export type { WalkOptions, Walker } from './walk/legs';
export { FAR_WALK_TILES, walkRoute } from './walk/legs';
export { DECK_REACH, leaveDeck, travelNpc } from './walk/travel';
export {
    MINE_JAIL_ROCKS, MINE_JAIL_WINDOW, inMineJail, leaveMineJail, mineJailRock, onMineJailCliff,
} from './walk/mine-jail';
export {
    DETOUR_MARGIN, TELEPORT_JEWELRY_RE, fareDetour, goTo, unpaidFaresNear, withoutJewelry, withoutSpells, withoutTeleports,
} from './walk/goto';
export type {
    PathDeps, PathLoc, PathOptions, PathPoint, PathResult, PathTile,
} from './walk/path';
export { expandPath, walkPath } from './walk/path';
export { applyKnownDoorBlocks, sessionWalker } from './walk/session';
