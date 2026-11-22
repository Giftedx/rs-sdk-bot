// Monster hunt-range danger zones, melee-protection exceptions, packed tile sets, and synchronous route/walk guards.
export type { Hunter, Roamer } from './danger/catalog';
export { CAGED, combatLevel, loadHunters, loadRoamers, parseHunter, parseRoamer } from './danger/catalog';
export type { LiveHunter } from './danger/threat';
export { PROTECT_MELEE_LEVEL, deadly, deadlyTo, hunts, liveHunters, meleeOnly, protectedFromMelee } from './danger/threat';
export { activeDanger, pack, unpack, withDanger } from './danger/tiles';
export { dangerSet, dangerTiles, escapeTiles, guardRoute, guardWalk } from './danger/guard';
