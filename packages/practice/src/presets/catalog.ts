import type { SaveConfig } from '../preset-types';
import { DRAGON_PRESETS } from '../presets-dragon';
import { FILLER_PRESETS } from '../presets-filler';
import { GANG_PRESETS } from '../presets-gang';
import { LEGENDS_PRESETS } from '../presets-legends';
import { LONG_PRESETS } from '../presets-long';
import { MEDIUM_PRESETS } from '../presets-medium';
import { MM_PRESETS } from '../presets-mm';
import { PARTNER_PRESETS } from '../presets-partner';
import { PATH_PRESETS } from '../presets-path';
import { REST_PRESETS } from '../presets-rest';
import { SHORT_PRESETS } from '../presets-short';
import { COMBAT_PRESETS } from './combat';
import { FLOOR_PRESETS } from './floors';
import { MEASURE_PRESETS } from './measure';
import { QUEST_PRESETS } from './quests';
import { SKILLING_PRESETS } from './skilling';

export type { SaveConfig } from '../preset-types';

export const PRESETS: Record<string, SaveConfig> = {
    ...SKILLING_PRESETS,
    ...MEASURE_PRESETS,
    ...QUEST_PRESETS,
    ...COMBAT_PRESETS,
    ...FLOOR_PRESETS,
    // Monkey Madness (scripts/generated/quest-mm.ts): packages/practice/src/presets-mm.ts.
    ...MM_PRESETS,
    // Dragon Slayer, Merlin's Crystal, Holy Grail: packages/practice/src/presets-dragon.ts.
    ...DRAGON_PRESETS,
    // Short quests of the quests-rest row: packages/practice/src/presets-short.ts.
    ...SHORT_PRESETS,
    // Shield of Arrav as a pair (main Black Arm, helper Phoenix): packages/practice/src/presets-gang.ts.
    ...GANG_PRESETS,
    // Medium quests of the quests-rest row: packages/practice/src/presets-medium.ts.
    ...MEDIUM_PRESETS,
    // Cook's Assistant, Witch's House, Lost City (main and Heroes' partner): packages/practice/src/presets-partner.ts.
    ...PARTNER_PRESETS,
    // Quests on the main account's path before quests-rest (Fight Arena, Sea Slug, The Dig Site, Scorpion Catcher):
    // packages/practice/src/presets-path.ts.
    ...PATH_PRESETS,
    // Other quests of the quests-rest row: packages/practice/src/presets-rest.ts.
    ...REST_PRESETS,
    // Long and very long quests of the quests-rest row: packages/practice/src/presets-long.ts.
    ...LONG_PRESETS,
    // Legends' Quest and its segment presets: packages/practice/src/presets-legends.ts.
    ...LEGENDS_PRESETS,
    // The 4 quests of the qp-filler row: packages/practice/src/presets-filler.ts.
    ...FILLER_PRESETS,
};
