// Loc-operated movement that transports.json (ladders and stairs) and doors.json (Open doors and gates) do not hold:
// agility shortcuts, course obstacles, trapdoors, manholes, caves, portals, gangplanks, carts and quest passages.
// Run: bun packages/knowledge/src/shortcuts.ts -> knowledge/shortcuts.json.
//
// Method: a small RuneScript interpreter runs each movement trigger once per placed loc. The loc tile, angle,
// shape, config params and constants are known; the player tile is the loc tile (approximate) until a script
// line moves the player to an absolute or loc-relative coord. Every condition the interpreter cannot decide
// (player side, skill level, item, quest varp, dialogue choice, success roll, world state) forks the run.
// A run that ends after a movement gives one edge; its forks become requirements, sides and conditions.
// Runs that the interpreter does not understand become `gaps` records, never guessed edges.
import { buildShortcuts, loadInput, movingScripts, runShortcutsCli } from './shortcuts/build';
import { parseCoord, parseScripts, stripComments } from './shortcuts/parser';

export type {
    BuildInput,
    BuildOutput,
    Coord,
    Ctx,
    Failure,
    ItemNeed,
    Line,
    Requirements,
    Script,
    ShortcutEdge,
    ShortcutGap,
    ShortcutKind,
    SkillNeed,
    VarpNeed,
} from './shortcuts/types';
export { buildShortcuts, loadInput, movingScripts, parseCoord, parseScripts, stripComments };

if (import.meta.main) {
    runShortcutsCli();
}
