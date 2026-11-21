// Core gear progression domain types, slot/tool/rune/quest constants, skill/quest normalization, and stock counting.
import type { Skill } from '../../../knowledge/src/gear';
import type { GearCount } from '../owned-loadout';

export type CombatFocus = 'melee' | 'ranged' | 'magic';
export type LoadoutSlotName = 'weapon' | 'shield' | 'helm' | 'body' | 'legs' | 'amulet' | 'cape' | 'hands' | 'feet';
export type RangedLoadoutSlotName = LoadoutSlotName | 'ammo';
export type GearSkillName = Skill | 'woodcutting' | 'mining' | 'fishing' | 'hitpoints' | 'prayer';
export type GearSkillLevels = Partial<Record<string, number | { level: number; baseLevel?: number } | null | undefined>> | null | undefined;
export type QuestInput =
    | ReadonlySet<string>
    | readonly string[]
    | readonly { name: string; state: string }[]
    | Record<string, boolean | null | undefined>
    | null
    | undefined;

export interface ShopSource {
    shop: string;
    file: string;
    itemDebugName: string;
    itemId: number;
    stock: number;
    restockTicks: number | null;
    cost: number;
    requiresQuest?: string;
    requiresSkill?: { skill: string; level: number };
    requiresQuestPoints?: number;
}

export type GearUnlockKind = CombatFocus | 'woodcutting-axe' | 'mining-pickaxe';
export type GearUnlockLevels = Readonly<Partial<Record<GearSkillName, readonly number[]>>>;
export const GEAR_UNLOCK_KINDS: readonly GearUnlockKind[] = ['melee', 'ranged', 'magic', 'woodcutting-axe', 'mining-pickaxe'];

export const GEAR_QUESTS = [
    'Dragon Slayer',
    'Lost City',
    "Hero's Quest",
    "Legends Quest",
    'The Fremennik Trials',
    'Regicide',
] as const;

// A run's worth of ammunition: a stack under this count does not carry a combat trip.
export const RANGED_RUN_AMMO = 50;

export const WEARPOS_BY_SLOT: Readonly<Record<RangedLoadoutSlotName, number>> = {
    helm: 0,
    cape: 1,
    amulet: 2,
    weapon: 3,
    body: 4,
    shield: 5,
    legs: 7,
    hands: 9,
    feet: 10,
    ammo: 13,
};

export const GEAR_KEY_BY_SLOT: Readonly<Record<RangedLoadoutSlotName, string>> = {
    weapon: 'righthand',
    shield: 'lefthand',
    helm: 'hat',
    body: 'torso',
    legs: 'legs',
    amulet: 'front',
    cape: 'back',
    hands: 'hands',
    feet: 'feet',
    ammo: 'quiver',
};

export const LOADOUT_SLOTS: readonly LoadoutSlotName[] = [
    'weapon', 'shield', 'helm', 'body', 'legs', 'amulet', 'cape', 'hands', 'feet',
];

export const WOODCUTTING_AXES_DESC = [1359, 1357, 1355, 1361, 1353, 1349, 1351] as const;
export const MINING_PICKAXES_DESC = [1275, 1271, 1273, 1269, 1267, 1265] as const;
export const ELEMENTAL_RUNES = {
    fire: 554,
    water: 555,
    air: 556,
    earth: 557,
} as const;
export const ELEMENTAL_STAFF_RUNES: Readonly<Record<number, readonly number[]>> = {
    1381: [556], // Staff of air
    1383: [555], // Staff of water
    1385: [557], // Staff of earth
    1387: [554], // Staff of fire
    1393: [554], // Fire battlestaff
    1395: [555], // Water battlestaff
    1397: [556], // Air battlestaff
    1399: [557], // Earth battlestaff
    1401: [554], // Mystic fire staff
    1403: [555], // Mystic water staff
    1405: [556], // Mystic air staff
    1407: [557], // Mystic earth staff
    3053: [554, 557], // Lava battlestaff
    3054: [554, 557], // Mystic lava staff
};
export const GOD_ALIGN_BY_ID: Readonly<Record<number, 'saradomin' | 'guthix' | 'zamorak'>> = {
    2412: 'saradomin', 2415: 'saradomin',
    2413: 'guthix', 2416: 'guthix',
    2414: 'zamorak', 2417: 'zamorak',
};

const QUEST_ALIASES: Readonly<Record<string, string>> = {
    'dragon slayer': 'Dragon Slayer',
    dragon: 'Dragon Slayer',
    dragonquest: 'Dragon Slayer',
    quest_dragon: 'Dragon Slayer',
    'lost city': 'Lost City',
    zanaris: 'Lost City',
    quest_zanaris: 'Lost City',
    "heroes' quest": "Hero's Quest",
    "hero's quest": "Hero's Quest",
    'heroes quest': "Hero's Quest",
    'hero quest': "Hero's Quest",
    hero: "Hero's Quest",
    heroquest: "Hero's Quest",
    quest_hero: "Hero's Quest",
    "legends' quest": "Legends Quest",
    'legends quest': "Legends Quest",
    'the legends quest': "Legends Quest",
    legends: "Legends Quest",
    legendsquest: "Legends Quest",
    quest_legends: "Legends Quest",
    'the fremennik trials': 'The Fremennik Trials',
    'fremennik trials': 'The Fremennik Trials',
    viking: 'The Fremennik Trials',
    quest_viking: 'The Fremennik Trials',
    regicide: 'Regicide',
    regicide_quest: 'Regicide',
    quest_regicide: 'Regicide',
};

function normalizeQuestName(name: string): string {
    const cleaned = name.toLowerCase().replace(/\s+/g, ' ').trim();
    return QUEST_ALIASES[cleaned] ?? QUEST_ALIASES[cleaned.replace(/'/g, '')] ?? name.trim();
}

export function normalizeCompletedQuests(quests: QuestInput): Set<string> {
    const out = new Set<string>();
    if (!quests) return out;
    if (quests instanceof Set) {
        for (const q of quests) if (typeof q === 'string' && q.trim()) out.add(normalizeQuestName(q));
        return out;
    }
    if (Array.isArray(quests)) {
        for (const q of quests) {
            if (typeof q === 'string' && q.trim()) {
                out.add(normalizeQuestName(q));
            } else if (q && typeof q === 'object' && 'state' in q && 'name' in q && q.state === 'complete' && typeof q.name === 'string') {
                out.add(normalizeQuestName(q.name));
            }
        }
        return out;
    }
    for (const [q, done] of Object.entries(quests)) {
        if (done === true) out.add(normalizeQuestName(q));
    }
    return out;
}

export function normalizeSkills(levels: GearSkillLevels): Partial<Record<GearSkillName, number>> {
    const out: Partial<Record<GearSkillName, number>> = {
        attack: 1,
        strength: 1,
        defence: 1,
        ranged: 1,
        magic: 1,
        woodcutting: 1,
        mining: 1,
        fishing: 1,
        hitpoints: 10,
        prayer: 1,
    };
    if (!levels) return out;
    for (const [rawKey, rawVal] of Object.entries(levels)) {
        const key = rawKey.toLowerCase() as GearSkillName;
        const val = typeof rawVal === 'number'
            ? rawVal
            : rawVal && typeof rawVal === 'object'
                ? (rawVal.baseLevel ?? rawVal.level)
                : undefined;
        if (typeof val === 'number' && Number.isSafeInteger(val) && val >= 1) {
            out[key] = val;
        }
    }
    return out;
}

const READ_SKILL_NAMES = ['Attack', 'Strength', 'Defence', 'Ranged', 'Magic', 'Hitpoints', 'Prayer', 'Woodcutting', 'Mining', 'Fishing'] as const;

/** Read base skill levels (falling back to current level, minimum 1) from a session SDK object or getter callback. */
export function readSkillLevels(
    source?:
        | { getSkill?: (name: string) => { level: number; baseLevel?: number } | null | undefined }
        | ((name: string) => { level: number; baseLevel?: number } | null | undefined),
): Record<string, number> {
    const out: Record<string, number> = {};
    for (const name of READ_SKILL_NAMES) {
        const sk = typeof source === 'function' ? source(name) : source?.getSkill?.(name);
        const val = sk?.baseLevel ?? sk?.level;
        out[name] = typeof val === 'number' && Number.isSafeInteger(val) && val >= 1 ? val : name === 'Hitpoints' ? 10 : 1;
    }
    return out;
}

export function stockTotals(stock: readonly GearCount[]): Map<number, number> {
    const out = new Map<number, number>();
    for (const row of stock) out.set(row.id, (out.get(row.id) ?? 0) + row.count);
    return out;
}
