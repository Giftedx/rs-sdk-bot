// Gathering items no shop sells: a ground spawn (maps OBJ, spawn-index.ts), milk from a cow with an empty bucket
// (npc/scripts/cow_milking.rs2), or a loc that hands the item out. Shared by scripts/quest-sweep.ts (quest packs)
// and scripts/gather-spawn.ts (route supplies).
export {
    ARROWS,
    ARROWS_PER_KILL,
    BOWS,
    BRONZE_PICKAXE,
    BUCKET,
    BURN_SOURCES,
    COMBINE_SOURCES,
    COW,
    KILL_SOURCES,
    LOC_SOURCES,
    LOGS,
    MILK,
    MINE_SOURCES,
    NPC_SOURCES,
    PICK_SOURCES,
    TINDERBOX,
    USE_SOURCES,
    denseSpawns,
    killSpawns,
    type Gather,
    type NpcSource,
} from './gather/sources';
export {
    arrowsFor,
    castsFor,
    castsPerKill,
    killAttempts,
    killStyle,
    magicKit,
    rangedKit,
    sharedDrops,
    type KillStyle,
    type MagicKit,
} from './gather/combat';
export { gatherPlan } from './gather/plan';
export { gatherItems } from './gather/execute';
