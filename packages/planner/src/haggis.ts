// Haggis 24-board schedule model.
//
// Every skill board ranks by level, then by the account's total playtime at the tick the level was reached
// (Player.ts:1904-1905 levelPlaytime, LoginServer.ts:155-181). Overall ranks by total level, then by the playtime
// of the last level-up (LoginServer.ts:120-125). So each clock board is a deadline on ONE shared playtime clock:
// Haggis must reach 99 before its total playtime reaches the #1's time. Quest Points ranks by points, then by the
// playtime the total was reached (hiscores.ts:313). Equipment, Bank and Lava Maze Runite have no playtime clock
// (hiscores.ts:620, 799-801, 981).
//
// Facade entry point re-exporting public schedule types, constants, loaders, EDF/Moore-Hodgson schedulers,
// and route supply helpers from cohesive acyclic submodules under ./haggis/.
export type {
    Activity, Board, BoardId, BoardKind, BoardResult, Evidence, LeverPatch, Mode,
    Placed, Range, ScheduleOptions, ScheduleResult, Skill, Supply, Trick,
} from './haggis/model';

export type { Tier, Unsourceable } from './haggis/boards';

export {
    BOARDS_FILE, LEVERS, SCENARIOS, SKILLS, TRICKS, XP99, applyLevers,
} from './haggis/model';

export {
    FIREMAKING_TIERS, HERBLORE_TIERS, SMITHING_TIERS,
    boardsFromSnapshot, haggisActivities, haggisUnsourceable, loadSnapshot,
} from './haggis/boards';

export { haggisTravel } from './haggis/travel';

export {
    bestSet, schedule, scheduleOverall, scheduleQpSpecialist,
} from './haggis/schedule';

export {
    goalRequirementsFor, overallRequirementsFor, suppliesFor,
} from './haggis/supplies';
