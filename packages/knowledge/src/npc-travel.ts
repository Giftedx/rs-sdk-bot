// NPC-operated travel: boats, gliders, carts, toll gates and NPC teleports that this server's
// content implements. Each fact (coordinate, fare, dialogue string, requirement) is read from a
// cited content line; the spec below names the file and a unique needle for that line, and the
// build fails if the needle is missing. Spawns come from knowledge/npcs.json.
import { buildNpcTravel, runNpcTravelCli } from './npc-travel/build';
import { find, parseCoord } from './npc-travel/lookup';
import { SPECS } from './npc-travel/specs';

export type {
    ExcludedRecord,
    Requirement,
    SrcTile,
    Tile,
    TravelKind,
    TravelRecord,
} from './npc-travel/types';
export { SPECS, buildNpcTravel, find, parseCoord };

if (import.meta.main) {
    runNpcTravelCli();
}
