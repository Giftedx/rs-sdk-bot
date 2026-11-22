// Per-action model of each ladder rung, read from the pinned game content: base XP per action, ticks per action
// (script timing and success rolls), items per action and tools. Every value carries a content file:line.
// modelXpPerTick is derived (25x, no banking, walking, resupply or level-up dialogs). It is never a measured rate:
// measured rates live only in knowledge/rates.json.
export type {
    Band,
    Content,
    Facts,
    Hit,
    ModelInput,
    Roll,
    Row,
    Timing,
} from './method-model/types';
export {
    ACTIONS_PER_TICK,
    ACTIONS_PER_TICK_SRC,
    P_DELAY_SRC,
    STAT_RANDOM_SRC,
    WEAKQUEUE_SRC,
    XP_RATE,
    XP_RATE_SRC,
    bestRoll,
    coordTile,
    modelBands,
    modelXpPerTickAt,
    pDelayTicks,
    statRandomChance,
    ticksPerSuccess,
} from './method-model/rates';
export {
    MODEL_FILES,
    block,
    find,
    findAll,
    loadContent,
    param,
    prop,
} from './method-model/content';
export { modelRung } from './method-model/model';
