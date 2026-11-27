// Random event handler for every bot (research/random-events.md has the server facts behind each rule).
// watchRandomEvents(s) checks every tick, handles each event with the cheapest response that never causes a
// fail teleport, and prints `EVENT <name> <action> t=<tick>`. While it handles an event that needs the player
// (flee, talk, pick up, solve), busy() is true and the gate holds the script's actions until it is done.
// With `loot` set, the same watcher picks up a valuable ground item near the player (rules in loot.ts), keeps it
// from the script's drops and sales, and puts it in the bank when the script next opens one: `EVENT loot <action>`.
// With `guard` set, the gate also refuses a drop or a sale of any held stack worth guard.minValue: `EVENT guard <action>`.
//
// Facade entry point re-exporting public random-event types, loaders, solvers, and watcher lifecycle
// from cohesive acyclic submodules under ./randomevents/.
export type {
    IfReader,
    LootWatchOptions,
    PathFinder,
    RandomEventOptions,
    RandomEventWatch,
} from './randomevents/model';

export { outOfReach, targetsMe } from './randomevents/model';
export { loadDanger, mazeDoorId, mazeWalls } from './randomevents/data';
export { solveCube } from './randomevents/puzzles';
export { watchRandomEvents } from './randomevents/watcher';
