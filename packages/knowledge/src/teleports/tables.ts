import type { EssenceWizardSpec, LocTeleportSpec, StagedJewelSpec } from './types';

export const WILD_DB = 'scripts/areas/area_wilderness/configs/wilderness_zones.dbrow';
export const WILD_PROC = 'scripts/areas/area_wilderness/scripts/wilderness_levels.rs2';

export const FS_TYPES: Record<string, 'lineofwalk' | 'lineofsight' | 'none'> = {
    map_findsquare_lineofwalk: 'lineofwalk',
    map_findsquare_lineofsight: 'lineofsight',
    map_findsquare_none: 'none',
};

export const SPELL_RS = 'scripts/skill_magic/scripts/spells/teleport.rs2';
export const MAGIC_RS = 'scripts/skill_magic/scripts/magic.rs2';
export const SPELL_DB = 'scripts/skill_magic/configs/magic_spells.dbrow';
export const STAFF_DB = 'scripts/skill_magic/configs/magic_staff.dbrow';

export const JEWEL_OBJ = 'scripts/skill_magic/configs/enchanted_jewelry.obj';
export const GLORY_RS = 'scripts/general/scripts/enchanted_jewellry/amulet_of_glory.rs2';
export const RING_OF_LIFE_RS = 'scripts/general/scripts/enchanted_jewellry/ring_of_life.rs2';
export const STAGED_JEWEL_SPECS: readonly StagedJewelSpec[] = [
    {
        id: 'jewellery:games_necklace',
        name: 'Games necklace',
        rel: 'scripts/general/scripts/enchanted_jewellry/necklace_of_minigames.rs2',
        header: /^\[opheld4,_necklace_of_minigames\]/,
        category: 'necklace_of_minigames',
        options: [1],
    },
    {
        id: 'jewellery:ring_of_dueling',
        name: 'Ring of dueling',
        rel: 'scripts/general/scripts/enchanted_jewellry/ring_of_dueling.rs2',
        header: /^\[opheld4,_category_136\]/,
        category: 'category_136',
        options: [1, 2],
    },
];

export const LYRE_RS = 'scripts/quests/quest_viking/scripts/viking_olaf.rs2';

const LEVER_RS = 'scripts/areas/area_ardougne_east/scripts/wilderness_lever.rs2';
const KBD_RS = 'scripts/areas/area_wilderness/scripts/king_black_dragon.rs2';
const ZANARIS_RS = 'scripts/quests/quest_zanaris/scripts/quest_zanaris.rs2';
const ENTRANA_RS = 'scripts/areas/area_entrana/scripts/entrana_dungeon.rs2';

export const LOC_TELEPORT_SPECS: readonly LocTeleportSpec[] = [
    { id: 'lever:wildinlever', kind: 'lever', name: 'Ardougne lever to Wilderness', rel: LEVER_RS, locName: 'wildinlever', opt: 'oploc1' },
    { id: 'lever:wildoutlever', kind: 'lever', name: 'Wilderness lever to Ardougne', rel: LEVER_RS, locName: 'wildoutlever', opt: 'oploc1' },
    { id: 'lever:dragonkinginlever', kind: 'lever', name: 'Lever into the King Black Dragon lair', rel: KBD_RS, locName: 'dragonkinginlever', opt: 'oploc1' },
    { id: 'lever:dragonkingoutlever', kind: 'lever', name: 'Lever out of the King Black Dragon lair', rel: KBD_RS, locName: 'dragonkingoutlever', opt: 'oploc1' },
    { id: 'loc:zanarisdoor', kind: 'loc', name: 'Zanaris shed door', rel: ZANARIS_RS, locName: 'zanarisdoor', opt: 'oploc1', zanarisExtra: true },
    { id: 'loc:zanarismagicdoor', kind: 'loc', name: 'Entrana dungeon magic door', rel: ENTRANA_RS, locName: 'zanarismagicdoor', opt: 'oploc1' },
];

export const ESS_RS = 'scripts/skill_runecraft/scripts/essence_mine.rs2';
export const ESS_ENUM = 'scripts/skill_runecraft/configs/essence_mine_teleports.enum';
export const CROMPERTY_RS = 'scripts/areas/area_ardougne_east/scripts/wizard_cromperty.rs2';
export const ESSENCE_WIZARDS: readonly EssenceWizardSpec[] = [
    ['aubury', 'scripts/areas/area_varrock/scripts/aubury.rs2', 'Aubury (Varrock)'],
    ['head_wizard', 'scripts/areas/area_wizard_tower/scripts/sedridor.rs2', "Sedridor (Wizards' Tower)"],
    ['guild_wizard', 'scripts/areas/area_yanille/scripts/wizard_distentor.rs2', 'Wizard Distentor (Magic Guild)'],
    ['gnome_brimstail', 'scripts/areas/area_gnome/scripts/brimstail.rs2', 'Brimstail (Gnome Stronghold)'],
    ['ardounge_wizard', CROMPERTY_RS, 'Wizard Cromperty (East Ardougne)'],
];

export const SPIRIT_TREE_RS = 'scripts/areas/area_gnome/scripts/spirit_tree.rs2';
export const RUNECRAFT_RS = 'scripts/skill_runecraft/scripts/runecraft.rs2';
export const RUNECRAFT_DB = 'scripts/skill_runecraft/configs/runecraft.dbrow';

export const STATIC_ENGINE_RULES: readonly { text: string; src: string }[] = [
    {
        text: 'map_findsquare picks a random standable tile in the square ring min..max (Chebyshev distance) that passes the line-of-walk or line-of-sight test back to the centre; it returns the centre when none passes',
        src: 'engine/src/engine/script/handlers/ServerOps.ts:302-330 (relative to vendor/rs-sdk/server)',
    },
    {
        text: 'stat_advance xp is in tenths and is multiplied by the node xpRate',
        src: 'engine/src/engine/entity/Player.ts:1889 (relative to vendor/rs-sdk/server)',
    },
];
