// Monster hunt-range danger zones, melee-protection exceptions, packed tile sets, synchronous route/walk guards, and
// walk exposure (the expected damage of a path, and the walk round harm ground).
export type { Hunter, Roamer } from './danger/catalog';
export { CAGED, combatLevel, loadHunters, loadRoamers, parseHunter, parseRoamer } from './danger/catalog';
export type { LiveHunter } from './danger/threat';
export { PROTECT_MELEE_LEVEL, deadly, deadlyTo, hunts, liveHunters, meleeOnly, protectedFromMelee } from './danger/threat';
export type { DangerScope } from './danger/tiles';
export { activeDanger, closedOf, pack, unpack, withDanger, withOpened } from './danger/tiles';
export { DISTANT_HIT_RANGE, WIDE_DANGER_SQUARE, dangerSet, dangerTiles, escapeTiles, guardRoute, guardWalk, setDangerDoorAt } from './danger/guard';
export type { ExposureOptions, NpcReach, RouteDanger, RouteLegLike, WalkExposure, WalkProfile, WalkThreat, WalkVerdict } from './danger/exposure';
export {
    cornerTiles, cornersOf, dangerSummary, foodHealOf, harmSet, huntersNear, isMulti, npcReach, planAroundHarm, routeDanger, routeExposure,
    routeHarmKeep, routeHarmSet, runTiles, stateWalkProfile, walkExposure, walkFloorLine, walkProfile, walkThreats, walkVerdict,
} from './danger/exposure';
