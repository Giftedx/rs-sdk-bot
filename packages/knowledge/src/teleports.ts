import { buildTeleports, runTeleportsCli } from './teleports/build';

// Every teleport the rev 289 content implements: Standard spellbook spells, enchanted jewellery,
// item teleports, levers, NPC teleports, spirit trees, runecraft ruins and portals, magic doors.
// Each value is read from a content line and carries `src` (content-relative path:1-based line).
// The content has no Ancient spellbook, no teleport tablets, no home teleport, no house teleport,
// no Ape Atoll teleport and no teleblock. Random-event teleports are not listed: random events are off.

export type {
    Box,
    Charge,
    Destination,
    Kind,
    Requirement,
    Rune,
    Teleport,
    TeleportsOut,
    Tile,
} from './teleports/types';
export { buildTeleports };

if (import.meta.main) {
    runTeleportsCli();
}
