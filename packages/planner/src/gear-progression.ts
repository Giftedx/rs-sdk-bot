// Rev-289 progressive loadout selection, upgrade planning, and skilling tool selection
// backed by knowledge/gear.json (packages/knowledge/src/gear-query.ts canWear/best) and knowledge/shops.json.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Bonus, Gear, Skill } from '../../knowledge/src/gear';
import type { Shop } from '../../knowledge/src/shops';
import { canWear, loadGear, sumBonuses } from '../../knowledge/src/gear-query';
import { gearSources, sourceCost, valueOf, type GearSource, type MarketAsks } from './gear-sources';
import { ownedBestLoadout, ownedLoadout, type GearCount, type GearSlot, type OptionalGearSlot, type OwnedLoadout } from './owned-loadout';

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

const GEAR_KEY_BY_SLOT: Readonly<Record<RangedLoadoutSlotName, string>> = {
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

export function normalizeQuestName(name: string): string {
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

const SHOP_GATES: Readonly<Record<string, Pick<ShopSource, 'requiresQuest' | 'requiresSkill' | 'requiresQuestPoints'>>> = {
    runeplateshop: { requiresQuest: 'Dragon Slayer' },
    dragonswordshop: { requiresQuest: 'Lost City' },
    dragonaxeshop: { requiresQuest: "Hero's Quest" },
    legendsguildshop: { requiresQuest: "Legends Quest" },
    generallegends: { requiresQuest: "Legends Quest" },
    viking_weapons_shop: { requiresQuest: 'The Fremennik Trials' },
    viking_clothes_shop: { requiresQuest: 'The Fremennik Trials' },
    regicide_general_shop: { requiresQuest: 'Regicide' },
    regicide_general_shop_2: { requiresQuest: 'Regicide' },
    ranging_guild_bowshop: { requiresSkill: { skill: 'ranged', level: 40 } },
    ranging_guild_armourshop: { requiresSkill: { skill: 'ranged', level: 40 } },
    ranging_guild_tribalshop: { requiresSkill: { skill: 'ranged', level: 40 } },
    magicguildshop: { requiresSkill: { skill: 'magic', level: 66 } },
    magearena_staffshop: { requiresSkill: { skill: 'magic', level: 60 } },
    magearena_runeshop: { requiresSkill: { skill: 'magic', level: 60 } },
    championshop: { requiresQuestPoints: 32 },
    runiteshop: { requiresQuestPoints: 32 },
    lathastrainingstore: { requiresQuest: 'Biohazard' },
    mm_magic_shop: { requiresQuest: 'Monkey Madness' },
    mm_scimitar_shop: { requiresQuest: 'Monkey Madness' },
};

// Exact rev-289 requirements omitted by scripts/levelrequire parser (multi-line blocks and
// labels without explicit skill tokens in scripts/levelrequire/scripts/{tier30,tier45,tier50}.rs2).
const REV289_REQUIREMENT_FIXES: Readonly<Record<number, { skills?: Partial<Record<Skill, number>>; quest?: string }>> = {
    3749: { skills: { defence: 45 }, quest: 'The Fremennik Trials' },
    3751: { skills: { defence: 45 }, quest: 'The Fremennik Trials' },
    3753: { skills: { defence: 45 }, quest: 'The Fremennik Trials' },
    3755: { skills: { defence: 45 }, quest: 'The Fremennik Trials' },
    3748: { skills: { defence: 30 }, quest: 'The Fremennik Trials' },
    3757: { skills: { attack: 30 }, quest: 'The Fremennik Trials' },
    3758: { skills: { defence: 30 }, quest: 'The Fremennik Trials' },
    3122: { skills: { defence: 50, strength: 50 } },
    1052: { quest: "Legends Quest" },
};

const EXCLUDED_DEBUG_RE = /^macro_|^xmas_yoyoworn$|^ikov_bootsoflightnessworn$|^death_spikedboots$|^flowers_waterfall|^trollromance_rare_flower$/;
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
const STANDARD_ARROW_RE = /^(bronze|iron|steel|mithril|adamant|rune)_arrow(_p)?$/;
const STANDARD_BOW_RE = /^(shortbow|longbow|oak_shortbow|oak_longbow|willow_shortbow|willow_longbow|maple_shortbow|maple_longbow|yew_shortbow|yew_longbow|magic_shortbow|magic_longbow)$/;
const ELEMENTAL_STAFF_RE = /^staff_of_(air|water|earth|fire)$|^(air|water|earth|fire|lava)_battlestaff$|^mystic_(air|water|earth|fire|lava)_staff$/;
const GOD_ALIGN_BY_ID: Readonly<Record<number, 'saradomin' | 'guthix' | 'zamorak'>> = {
    2412: 'saradomin', 2415: 'saradomin',
    2413: 'guthix', 2416: 'guthix',
    2414: 'zamorak', 2417: 'zamorak',
};

const ROOT = resolve(import.meta.dir, '../../..');

let cachedGear: Gear[] | undefined;
let cachedGearById: Map<number, Gear> | undefined;
let cachedShopsById: Map<number, ShopSource[]> | undefined;

export function gearCatalog(): readonly Gear[] {
    if (cachedGear) return cachedGear;
    cachedGear = loadGear()
        .filter(g => !g.staffOnly && !EXCLUDED_DEBUG_RE.test(g.debugname))
        .map(g => {
            const fix = REV289_REQUIREMENT_FIXES[g.id];
            if (!fix) return g;
            return {
                ...g,
                requires: {
                    ...g.requires,
                    skills: { ...g.requires.skills, ...fix.skills },
                    ...(fix.quest ? { quest: fix.quest } : {}),
                },
            };
        });
    cachedGearById = new Map(cachedGear.map(g => [g.id, g]));
    return cachedGear;
}

export function gearById(id: number): Gear | undefined {
    gearCatalog();
    return cachedGearById!.get(id);
}

export function shopCatalog(): ReadonlyMap<number, readonly ShopSource[]> {
    if (cachedShopsById) return cachedShopsById;
    const items = JSON.parse(readFileSync(resolve(ROOT, 'knowledge', 'items.json'), 'utf8')) as { id: number; debugname: string; cost?: number }[];
    const shops = JSON.parse(readFileSync(resolve(ROOT, 'knowledge', 'shops.json'), 'utf8')) as Shop[];
    const byDebug = new Map(items.map(i => [i.debugname, i]));
    const out = new Map<number, ShopSource[]>();
    for (const shop of shops) {
        if (/^(skill_guide_|smithing_|crafting_make_)|_free$/.test(shop.inv)) continue;
        const gate = SHOP_GATES[shop.inv];
        for (const row of shop.stock) {
            if (row.count <= 0) continue;
            const item = byDebug.get(row.item);
            if (!item) continue;
            const entry: ShopSource = {
                shop: shop.inv,
                file: shop.file,
                itemDebugName: row.item,
                itemId: item.id,
                stock: row.count,
                restockTicks: row.restockTicks,
                cost: item.cost ?? 1,
                ...(gate ?? {}),
            };
            const list = out.get(item.id);
            if (list) list.push(entry);
            else out.set(item.id, [entry]);
        }
    }
    cachedShopsById = out;
    return out;
}

export function canWearGear(item: Gear, levels?: GearSkillLevels, quests?: QuestInput): boolean {
    if (item.staffOnly || EXCLUDED_DEBUG_RE.test(item.debugname)) return false;
    const skillMap = normalizeSkills(levels);
    const done = normalizeCompletedQuests(quests);
    return canWear(item, skillMap as Partial<Record<Skill, number>>, done);
}

// Weapon attack-style availability from combat.dbrow:
// - spears (weapon_spear_table) have only controlled and defensive styles.
// - halberds (weapon_polearm_table) have controlled, aggressive, and defensive (no single-skill Attack).
export function weaponSupportsTrainSkill(item: Gear, trainSkill?: string): boolean {
    if (!trainSkill || item.slot !== 'righthand') return true;
    const target = trainSkill.trim().toLowerCase();
    if (target === 'hitpoints' || target === 'defence' || target === 'ranged' || target === 'magic') return true;
    if (/\bspear\b/i.test(item.name)) return target !== 'attack' && target !== 'strength' && target !== 'all-melee';
    if (/\bhalberd\b/i.test(item.name)) return target !== 'attack' && target !== 'all-melee';
    return true;
}

function isRangedWeapon(g: Gear): boolean {
    return g.slot === 'righthand' && (
        (g.attackRange !== undefined && g.attackRange >= 3)
        || g.bonuses.rangeAttack > 0
        || g.bonuses.rangeStrength > 0
        || /bow|dart|knife|javelin|thrown/i.test(g.name)
    );
}

function isMagicWeapon(g: Gear): boolean {
    return g.slot === 'righthand' && /\b(?:staff|battlestaff)\b/i.test(g.name);
}

function isMeleeWeapon(g: Gear): boolean {
    return g.slot === 'righthand'
        && !isRangedWeapon(g)
        && !isMagicWeapon(g)
        && g.bonuses.strength >= 0
        && Math.max(g.bonuses.stabAttack, g.bonuses.slashAttack, g.bonuses.crushAttack) >= 0;
}

function isStandardRangedBow(g: Gear): boolean {
    return g.slot === 'righthand' && STANDARD_BOW_RE.test(g.debugname);
}

function isStandardArrow(g: Gear): boolean {
    return g.slot === 'quiver' && STANDARD_ARROW_RE.test(g.debugname);
}

/** The standard bows by Ranged wear level, the highest first. In a level the faster bow (the shortbow) is first. */
export function standardBowTiers(): { level: number; ids: number[] }[] {
    const byLevel = new Map<number, Gear[]>();
    for (const g of gearCatalog()) {
        if (!isStandardRangedBow(g)) continue;
        const level = g.requires.skills.ranged ?? 1;
        byLevel.set(level, [...(byLevel.get(level) ?? []), g]);
    }
    return [...byLevel].sort((a, b) => b[0] - a[0])
        .map(([level, bows]) => ({ level, ids: bows.sort((a, b) => (a.attackRate ?? 4) - (b.attackRate ?? 4) || a.id - b.id).map(g => g.id) }));
}

/** The standard unpoisoned arrows, the strongest first, each with the Ranged level its levelrequire needs. */
export function standardArrowTiers(): { level: number; id: number; strength: number }[] {
    return gearCatalog()
        .filter(g => isStandardArrow(g) && !g.debugname.endsWith('_p'))
        .sort((a, b) => b.bonuses.rangeStrength - a.bonuses.rangeStrength || a.id - b.id)
        .map(g => ({ level: g.tier ?? 1, id: g.id, strength: g.bonuses.rangeStrength }));
}

// A thrown weapon (knife, dart, javelin, throwing axe) is its own ammunition: the worn stack is spent by the shots.
export function isThrownWeapon(g: Gear): boolean {
    return g.slot === 'righthand' && g.bonuses.rangeStrength > 0 && !/bow/.test(g.debugname);
}

// The rapid style fires one tick sooner than the weapon's attackrate (player_ranged.rs2 ^style_ranged_rapid).
function rapidRate(g: Gear): number {
    return Math.max(1, (g.attackRate ?? 4) - 1);
}

function meleeDefenceMean(b: Record<Bonus, number>): number {
    return (b.stabDefence + b.slashDefence + b.crushDefence) / 3;
}

export function scoreGearForStyle(item: Gear, style: CombatFocus, arrowStrength = 0): number {
    const b = item.bonuses;
    if (item.slot === 'righthand') {
        if (style === 'melee') {
            if (!isMeleeWeapon(item)) return -1e9;
            const maxAtk = Math.max(b.stabAttack, b.slashAttack, b.crushAttack);
            const rate = Math.max(1, item.attackRate ?? 4);
            return ((64 + b.strength) * (64 + maxAtk)) / rate;
        }
        if (style === 'ranged') {
            if (!isRangedWeapon(item)) return -1e9;
            const rate = Math.max(1, item.attackRate ?? 4);
            const str = b.rangeStrength + arrowStrength;
            const base = ((64 + str) * (64 + b.rangeAttack)) / rate;
            return isStandardRangedBow(item) ? base + 1 : base;
        }
        if (!isMagicWeapon(item)) return -1e9;
        const elemental = ELEMENTAL_STAFF_RE.test(item.debugname) ? 5 : 0;
        const god = GOD_ALIGN_BY_ID[item.id] ? 2 : 0;
        return b.magicAttack * 20 + b.magicDefence * 4 + elemental + god + b.strength * 0.1;
    }
    if (item.slot === 'quiver') {
        if (style !== 'ranged') return -1e9;
        return b.rangeStrength * 20 + (isStandardArrow(item) ? 5 : 0);
    }
    if (style === 'melee') {
        const atk = Math.max(b.stabAttack, b.slashAttack, b.crushAttack);
        const def = (meleeDefenceMean(b) * 1.5 + b.rangeDefence * 0.25);
        return b.strength * 20 + atk * 10 + b.prayer * 4 + def;
    }
    if (style === 'ranged') {
        const avgDef = (meleeDefenceMean(b) * 3 + b.magicDefence + b.rangeDefence) / 5;
        return b.rangeAttack * 20 + b.rangeStrength * 15 + b.prayer * 4 + avgDef;
    }
    const avgDef = (meleeDefenceMean(b) * 3 + b.rangeDefence) / 10;
    return b.magicAttack * 20 + b.magicDefence * 4 + b.prayer * 4 + avgDef;
}

function tieOrder(a: Gear, b: Gear, style: CombatFocus): number {
    if (style === 'melee' && a.slot === 'righthand') {
        const oneHandDiff = Number(a.covers.includes('lefthand')) - Number(b.covers.includes('lefthand'));
        if (oneHandDiff !== 0) return oneHandDiff;
        const strDiff = b.bonuses.strength - a.bonuses.strength;
        if (strDiff !== 0) return strDiff;
    }
    // Prefer un-trimmed / standard over trimmed cosmetics when stats tie, and higher glory charge first.
    if (/^Amulet of glory/i.test(a.name) && /^Amulet of glory/i.test(b.name)) {
        return b.id - a.id;
    }
    return a.id - b.id;
}

export function bestGearForSlot(
    style: CombatFocus,
    slot: RangedLoadoutSlotName,
    levels?: GearSkillLevels,
    quests?: QuestInput,
    options?: { trainSkill?: string; arrowStrength?: number; includeNonPositive?: boolean },
): Gear[] {
    const wearSlot = GEAR_KEY_BY_SLOT[slot];
    const arrowStrength = options?.arrowStrength ?? 0;
    const candidates = gearCatalog().filter(g => {
        if (g.slot !== wearSlot) return false;
        if (!canWearGear(g, levels, quests)) return false;
        if (slot === 'weapon' && !weaponSupportsTrainSkill(g, options?.trainSkill)) return false;
        const s = scoreGearForStyle(g, style, arrowStrength);
        if (s <= -1e8) return false;
        if (!options?.includeNonPositive && slot !== 'weapon' && s <= 0) return false;
        return true;
    });
    return candidates.sort((a, b) =>
        scoreGearForStyle(b, style, arrowStrength) - scoreGearForStyle(a, style, arrowStrength)
        || tieOrder(a, b, style));
}

function stockTotals(stock: readonly GearCount[]): Map<number, number> {
    const out = new Map<number, number>();
    for (const row of stock) out.set(row.id, (out.get(row.id) ?? 0) + row.count);
    return out;
}

function unreservedCounts(stock: readonly GearCount[], reserved: readonly GearCount[] = []): Map<number, number> {
    const avail = stockTotals(stock);
    for (const r of reserved) avail.set(r.id, Math.max(0, (avail.get(r.id) ?? 0) - r.count));
    return avail;
}

function arrowCompatibility(bow: Gear | null, arrow: Gear): boolean {
    if (!bow) return isStandardArrow(arrow);
    if (bow.debugname === 'ogre_bow') return arrow.debugname === 'ogre_arrow';
    if (bow.debugname.includes('crossbow')) return /\bbolt/i.test(arrow.name);
    if (isStandardRangedBow(bow)) {
        return isStandardArrow(arrow) && (arrow.tier ?? 1) <= (bow.tier ?? 1);
    }
    return false;
}

function missingRequirements(item: Gear, levels: Partial<Record<GearSkillName, number>>, done: Set<string>) {
    const missingSkills: Partial<Record<Skill, number>> = {};
    for (const [skill, req] of Object.entries(item.requires.skills)) {
        if ((levels[skill as GearSkillName] ?? 1) < req!) missingSkills[skill as Skill] = req!;
    }
    const missingQuests = item.requires.quest && !done.has(item.requires.quest) ? [item.requires.quest] : [];
    return { missingSkills, missingQuests };
}

function unlockRank(item: Gear, missingSkills: Partial<Record<Skill, number>>, missingQuests: string[], isAmmo = false): number {
    const reqLevel = isAmmo
        ? (item.tier ?? 1)
        : Math.max(1, ...Object.values(item.requires.skills).map(v => v ?? 1));
    const missingSkillMax = Math.max(0, ...Object.values(missingSkills).map(v => v ?? 0));
    return Math.max(reqLevel, missingSkillMax) * 100 + missingQuests.length * 10;
}

export interface SlotUpgrade {
    slot: RangedLoadoutSlotName;
    wearpos: number;
    current: Gear | null;
    bestWearable: Gear | null;
    /** The best item the account can obtain now, with all its usable sources and the first (the cheapest) of them. */
    acquirableUpgrade: { item: Gear; shops: ShopSource[]; tradeable: boolean; sources: GearSource[]; source: GearSource } | null;
    /** The best wearable item whatever its source: the long-term target. `sources` is empty when nothing supplies it now. */
    goal: { item: Gear; sources: GearSource[] } | null;
    nextUnlock: {
        item: Gear;
        missingSkills: Partial<Record<Skill, number>>;
        missingQuests: string[];
        shops: ShopSource[];
        tradeable: boolean;
    } | null;
}

export interface ProgressiveLoadout {
    style: CombatFocus;
    worn: Record<LoadoutSlotName, Gear | null>;
    ammo: Gear | null;
    /** True when the weapon is a thrown stack: the weapon slot holds the ammunition. */
    thrown: boolean;
    /** Unreserved owned count of the ammunition: the quiver item, or the thrown weapon. 0 with none. */
    ammoCount: number;
    items: { slot: RangedLoadoutSlotName; wearpos: number; item: Gear }[];
    gearSlots: GearSlot[];
    ownedLoadout: OwnedLoadout;
    upgrades: Partial<Record<RangedLoadoutSlotName, SlotUpgrade>>;
    bonuses: Record<Bonus, number>;
}

export interface ProgressiveLoadoutOptions {
    reserved?: readonly GearCount[];
    trainSkill?: string;
    requireWeapon?: boolean;
    requireShield?: boolean;
    minWeaponStrength?: number;
    minShieldDefence?: number;
    /** Ammunition count that carries a run (default RANGED_RUN_AMMO). A smaller stack is used only with no such stack. */
    arrowMinCount?: number;
    /** False keeps thrown weapons out of the Ranged weapon choice (a worker that counts its shots by arrows). */
    thrown?: boolean;
    /** The account's quest points, for shops behind a quest-point gate. Unknown counts as 0. */
    questPoints?: number;
    /** Market asks (marketQuotes of .practice/market-all.json): the Grand Exchange is a source only for an item with one. */
    market?: MarketAsks;
    /** The account's tile: the nearest shop or NPC among the sources of an item. */
    position?: { x: number; z: number } | null;
    godAlign?: 'saradomin' | 'guthix' | 'zamorak';
    /** When specified, overrides bow/arrow scoring with current Ranged bow+arrow pairing. */
    preferFastShortbow?: boolean;
}

export function selectProgressiveLoadout(
    style: CombatFocus,
    stock: readonly GearCount[],
    levels?: GearSkillLevels,
    quests?: QuestInput,
    options: ProgressiveLoadoutOptions = {},
): ProgressiveLoadout {
    const skillMap = normalizeSkills(levels);
    const done = normalizeCompletedQuests(quests);
    const avail = unreservedCounts(stock, options.reserved);
    const shops = shopCatalog();
    const arrowMin = Math.max(1, options.arrowMinCount ?? RANGED_RUN_AMMO);
    const have = (g: Gear) => avail.get(g.id) ?? 0;

    // The ammunition a weapon fires from the owned stock: the strongest kind with a run's worth (arrowMin), and with
    // no such kind the largest stack. Three rune arrows never displace 300 mithril arrows.
    const ownedAmmo = style === 'ranged'
        ? gearCatalog().filter(g => g.slot === 'quiver' && have(g) > 0)
        : [];
    const ammoFor = (weapon: Gear): Gear | null => {
        const fits = ownedAmmo.filter(a => {
            if (isStandardRangedBow(weapon)) return (a.tier ?? 1) <= (skillMap.ranged ?? 1) && arrowCompatibility(weapon, a);
            return arrowCompatibility(weapon, a);
        });
        const byStrength = (a: Gear, b: Gear) => b.bonuses.rangeStrength - a.bonuses.rangeStrength || a.id - b.id;
        return fits.filter(a => have(a) >= arrowMin).sort(byStrength)[0]
            ?? [...fits].sort((a, b) => have(b) - have(a) || byStrength(a, b))[0]
            ?? null;
    };
    // Owned ammunition count behind a Ranged weapon: the thrown stack itself, or the stack ammoFor picks.
    const ammoCountFor = (weapon: Gear): number => {
        if (isThrownWeapon(weapon)) return have(weapon);
        const ammo = ammoFor(weapon);
        return ammo ? have(ammo) : 0;
    };

    const maxArrowStrengthForTier = (tier: number): number => {
        if (tier >= 40) return 49; // Rune arrow
        if (tier >= 30) return 31; // Adamant arrow
        if (tier >= 20) return 22; // Mithril arrow
        if (tier >= 5) return 16;  // Steel arrow
        return 10;                 // Iron arrow
    };

    // Owned Ranged weapons are compared by the damage they do on rapid with the ammunition the account holds:
    // (64 + ranged strength) * (64 + ranged attack) / rapid rate. A weapon with a run's worth of ammunition outranks
    // one with a smaller stack, and that one outranks a weapon with none. A knife fires every 2 ticks on rapid and a
    // shortbow every 3, so a full knife stack can beat a bow with weak arrows; five knives never do.
    const AMMO_READY = 2_000_000, AMMO_SOME = 1_000_000;
    const ownedRangedScore = (g: Gear): number => {
        if (!isRangedWeapon(g)) return -1e9;
        const ammo = isThrownWeapon(g) ? null : ammoFor(g);
        const count = ammoCountFor(g);
        // With no owned ammunition a bow is ranked as if it fired its tier's arrows, so the best bow is still named.
        const strength = isThrownWeapon(g) ? g.bonuses.rangeStrength
            : ammo ? g.bonuses.rangeStrength + ammo.bonuses.rangeStrength
            : isStandardRangedBow(g) ? maxArrowStrengthForTier(g.tier ?? 1) : g.bonuses.rangeStrength;
        const damage = ((64 + strength) * (64 + g.bonuses.rangeAttack)) / rapidRate(g);
        return damage + (count >= arrowMin ? AMMO_READY : count > 0 ? AMMO_SOME : 0);
    };
    const scoreOf = (g: Gear, useCatalogArrow: boolean) => {
        if (style === 'ranged' && g.slot === 'righthand') {
            if (!useCatalogArrow) return ownedRangedScore(g);
            if (isStandardRangedBow(g)) {
                // The catalog choice (what to acquire) keeps a bow ahead of a thrown weapon: shops sell arrows.
                return scoreGearForStyle(g, style, maxArrowStrengthForTier(Math.min(g.tier ?? 1, skillMap.ranged ?? 1))) + 500;
            }
            return scoreGearForStyle(g, style, 0);
        }
        return scoreGearForStyle(g, style);
    };

    const slotCandidates = (slot: RangedLoadoutSlotName, currentWeapon: Gear | null, useCatalogArrow = true): Gear[] => {
        const wearSlot = GEAR_KEY_BY_SLOT[slot];
        const all = gearCatalog().filter(g => {
            if (g.slot !== wearSlot) return false;
            if (!canWearGear(g, skillMap, done)) return false;
            if (slot === 'weapon') {
                if (!weaponSupportsTrainSkill(g, options.trainSkill)) return false;
                if (options.minWeaponStrength !== undefined && g.bonuses.strength < options.minWeaponStrength) return false;
                if (options.requireShield && g.covers.includes('lefthand')) return false;
                if (style === 'ranged' && options.thrown === false && isThrownWeapon(g)) return false;
            }
            if (slot === 'shield' && options.minShieldDefence !== undefined) {
                if (meleeDefenceMean(g.bonuses) < options.minShieldDefence) return false;
            }
            if (slot === 'cape' && style === 'magic' && currentWeapon) {
                const wGod = GOD_ALIGN_BY_ID[currentWeapon.id];
                const cGod = GOD_ALIGN_BY_ID[g.id];
                if (wGod && cGod && wGod !== cGod) return false;
            }
            if (slot === 'cape' && options.godAlign) {
                const cGod = GOD_ALIGN_BY_ID[g.id];
                if (cGod && cGod !== options.godAlign) return false;
            }
            return true;
        });

        return all
            .filter(g => {
                const sc = scoreOf(g, useCatalogArrow);
                if (sc <= -1e8) return false;
                if (slot !== 'weapon' && sc <= 0) return false;
                return true;
            })
            .sort((a, b) => scoreOf(b, useCatalogArrow) - scoreOf(a, useCatalogArrow) || tieOrder(a, b, style));
    };

    const ownedShields = slotCandidates('shield', null, false).filter(g => (avail.get(g.id) ?? 0) > 0);
    const bestShieldScore = ownedShields.length ? scoreOf(ownedShields[0]!, false) : 0;

    // Compute preference relative to each slot's best owned option so missing an unowned BiS
    // never makes ownedBestLoadout prefer skipping an optional slot over wearing a lower owned tier.
    const toOptions = (list: Gear[], slot: LoadoutSlotName) => {
        const owned = list.filter(g => (avail.get(g.id) ?? 0) > 0);
        if (!owned.length) return [];
        const topOwnedScore = Math.max(0, scoreOf(owned[0]!, false));
        return owned.map(g => ({
            id: g.id,
            count: 1,
            preference: Math.max(0, Math.round((topOwnedScore - scoreOf(g, false)) * 10)),
            equippable: true as const,
            ...(g.covers.includes('lefthand') ? { occupies: ['shield'] } : {}),
        }));
    };

    const solveSlots: OptionalGearSlot[] = [];
    for (const slot of LOADOUT_SLOTS) {
        const list = slotCandidates(slot, null, false);
        const opts = toOptions(list, slot);
        const required = (slot === 'weapon' && options.requireWeapon) || (slot === 'shield' && options.requireShield);
        if (!opts.length && !required) continue;
        solveSlots.push({
            key: slot,
            optional: !required,
            missPreference: slot === 'shield' ? Math.max(1, Math.round(bestShieldScore * 10)) : 1000000,
            options: opts,
        });
    }

    const solved = ownedBestLoadout(solveSlots, stock, options.reserved);
    const worn = Object.fromEntries(LOADOUT_SLOTS.map(s => [s, null])) as Record<LoadoutSlotName, Gear | null>;
    for (const choice of solved.selected) {
        const g = gearById(choice.id) ?? null;
        worn[choice.slot as LoadoutSlotName] = g;
    }

    // Re-check cape against chosen weapon for god-cape / god-staff conflict.
    if (style === 'magic' && worn.weapon && worn.cape) {
        const wGod = GOD_ALIGN_BY_ID[worn.weapon.id];
        const cGod = GOD_ALIGN_BY_ID[worn.cape.id];
        if (wGod && cGod && wGod !== cGod) {
            const safeCape = slotCandidates('cape', worn.weapon).find(g => (avail.get(g.id) ?? 0) > 0) ?? null;
            worn.cape = safeCape;
        }
    }

    const thrown = style === 'ranged' && !!worn.weapon && isThrownWeapon(worn.weapon);
    const ammo: Gear | null = style === 'ranged' && worn.weapon && !thrown ? ammoFor(worn.weapon) : null;
    const ammoCount = style === 'ranged' && worn.weapon ? ammoCountFor(worn.weapon) : 0;

    const items: { slot: RangedLoadoutSlotName; wearpos: number; item: Gear }[] = [];
    for (const slot of LOADOUT_SLOTS) {
        const item = worn[slot];
        if (item) items.push({ slot, wearpos: WEARPOS_BY_SLOT[slot], item });
    }
    if (ammo) items.push({ slot: 'ammo', wearpos: WEARPOS_BY_SLOT.ammo, item: ammo });

    // Compute slot-by-slot bestWearable, acquirableUpgrade, and nextUnlock across all rev-289 items.
    const upgrades: Partial<Record<RangedLoadoutSlotName, SlotUpgrade>> = {};
    const upgradeSlots: RangedLoadoutSlotName[] = style === 'ranged' ? [...LOADOUT_SLOTS, 'ammo'] : [...LOADOUT_SLOTS];
    const upgradeScore = (g: Gear, assumeUnlocked: boolean): number => {
        if (style === 'ranged' && g.slot === 'righthand' && isStandardRangedBow(g)) {
            const tier = assumeUnlocked ? (g.tier ?? 1) : Math.min(g.tier ?? 1, skillMap.ranged ?? 1);
            return scoreGearForStyle(g, style, maxArrowStrengthForTier(tier)) + 500;
        }
        return scoreGearForStyle(g, style);
    };

    for (const slot of upgradeSlots) {
        const current = slot === 'ammo' ? ammo : worn[slot];
        const wearSlot = GEAR_KEY_BY_SLOT[slot];
        const wearableList = slot === 'ammo'
            ? gearCatalog()
                .filter(g => g.slot === 'quiver' && arrowCompatibility(worn.weapon, g) && (g.tier ?? 1) <= (skillMap.ranged ?? 1))
                .sort((a, b) => scoreGearForStyle(b, 'ranged') - scoreGearForStyle(a, 'ranged') || a.id - b.id)
            : slotCandidates(slot, worn.weapon);
        const bestWearable = wearableList[0] ?? null;
        const currentScore = current ? upgradeScore(current, false) : -Infinity;
        const bestScore = bestWearable ? upgradeScore(bestWearable, false) : -Infinity;

        // The item the account can obtain now: wearable, better than the current one, not owned, and with a source
        // (gearSources). Each is valued by its gain, halved for each GEAR_COST_SCALE coins of its cheapest source; the
        // best value is the want. An item with no source (a god cape, the Unholy book, or a market ask over the limit)
        // is never the want. `goal` is the best wearable item whatever its source.
        const openShops = (g: Gear) => (shops.get(g.id) ?? []).filter(sh => shopAccessible(sh, skillMap, done, undefined, options.questPoints));
        const sourcesOf = (g: Gear) => gearSources(g, { skills: skillMap, done, market: options.market, position: options.position, openShops: openShops(g) });
        const gainOf = (g: Gear) => currentScore === -Infinity ? Math.max(upgradeScore(g, false), 1) : upgradeScore(g, false) - currentScore;
        let wanted: Gear | undefined, wantedSources: GearSource[] = [], wantedValue = -Infinity;
        for (const g of wearableList) {
            if (g.id === current?.id || upgradeScore(g, false) <= currentScore || have(g) >= (slot === 'ammo' ? arrowMin : 1)) continue;
            const found = sourcesOf(g);
            if (!found.length) continue;
            const value = valueOf(gainOf(g), sourceCost(g, found[0]!));
            if (value > wantedValue) { wanted = g; wantedSources = found; wantedValue = value; }
        }
        const acquirableUpgrade = wanted
            ? { item: wanted, shops: openShops(wanted), tradeable: wanted.tradeable, sources: wantedSources, source: wantedSources[0]! }
            : null;
        const goal = bestWearable && bestWearable.id !== current?.id && bestScore > currentScore && have(bestWearable) < (slot === 'ammo' ? arrowMin : 1)
            ? { item: bestWearable, sources: sourcesOf(bestWearable) }
            : null;

        // Next unlock: items better than both current and bestWearable that fail at least one skill/quest req.
        const threshold = Math.max(currentScore, bestScore);
        const locked = gearCatalog()
            .filter(g => {
                if (g.slot !== wearSlot) return false;
                if (slot === 'weapon' && !weaponSupportsTrainSkill(g, options.trainSkill)) return false;
                if (slot === 'ammo') {
                    if (!isStandardArrow(g)) return false;
                    return (g.tier ?? 1) > (skillMap.ranged ?? 1) && upgradeScore(g, true) > threshold;
                }
                if (canWearGear(g, skillMap, done)) return false;
                return upgradeScore(g, true) > threshold;
            })
            .map(g => {
                if (slot === 'ammo') {
                    const reqRanged = g.tier ?? 1;
                    const missingSkills: Partial<Record<Skill, number>> = (skillMap.ranged ?? 1) < reqRanged ? { ranged: reqRanged } : {};
                    return { item: g, missingSkills, missingQuests: [] as string[], score: upgradeScore(g, true) };
                }
                const reqs = missingRequirements(g, skillMap, done);
                return { item: g, ...reqs, score: upgradeScore(g, true) };
            })
            .filter(x => Object.keys(x.missingSkills).length > 0 || x.missingQuests.length > 0)
            .sort((a, b) =>
                unlockRank(a.item, a.missingSkills, a.missingQuests, slot === 'ammo')
                - unlockRank(b.item, b.missingSkills, b.missingQuests, slot === 'ammo')
                || b.score - a.score
                || a.item.id - b.item.id);

        const next = locked[0]
            ? {
                item: locked[0].item,
                missingSkills: locked[0].missingSkills,
                missingQuests: locked[0].missingQuests,
                shops: [...(shops.get(locked[0].item.id) ?? [])],
                tradeable: locked[0].item.tradeable,
            }
            : null;

        upgrades[slot] = {
            slot,
            wearpos: WEARPOS_BY_SLOT[slot],
            current,
            bestWearable,
            acquirableUpgrade,
            goal,
            nextUnlock: next,
        };
    }

    const gearSlots: GearSlot[] = items.map(({ slot, item }) => ({
        key: slot,
        options: [{
            id: item.id,
            count: 1,
            preference: 0,
            equippable: true,
            ...(slot === 'weapon' && item.covers.includes('lefthand') ? { occupies: ['shield'] } : {}),
        }],
    }));

    return {
        style,
        worn,
        ammo,
        thrown,
        ammoCount,
        items,
        gearSlots,
        ownedLoadout: solved,
        upgrades,
        bonuses: sumBonuses(items.map(i => i.item)),
    };
}

export interface ToolCandidate {
    item: Gear;
    useSkill: 'woodcutting' | 'mining';
    useLevel: number;
    paramLevel: number;
    wieldAttackLevel: number;
    canUse: boolean;
    canWield: boolean;
    carryMode: 'wield' | 'inventory';
    shops: ShopSource[];
    tradeable: boolean;
}

export interface ToolRecommendation {
    kind: 'woodcutting-axe' | 'mining-pickaxe';
    current: ToolCandidate | null;
    bestUsable: ToolCandidate | null;
    nextAcquirable: ToolCandidate | null;
    nextUnlock: ToolCandidate | null;
}

function buildToolCandidates(
    orderedIdsDesc: readonly number[],
    useSkill: 'woodcutting' | 'mining',
    levels?: GearSkillLevels,
    enforceUseLevel = true,
): ToolCandidate[] {
    const skillMap = normalizeSkills(levels);
    const shops = shopCatalog();
    const useStat = skillMap[useSkill] ?? 1;
    const attackStat = skillMap.attack ?? 1;

    return orderedIdsDesc.flatMap(id => {
        const item = gearById(id);
        if (!item) return [];
        const paramLevel = Math.max(1, item.tier ?? 1);
        // Rev-289 woodcut.rs2:220-240 uses any axe without a Woodcutting level gate;
        // mining pickaxe_checker.rs2 checks stat(mining) >= oc_param(pickaxe, levelrequire).
        const useLevel = enforceUseLevel ? paramLevel : 1;
        const wieldAttackLevel = item.requires.skills.attack ?? 1;
        const canUse = useStat >= useLevel;
        const canWield = attackStat >= wieldAttackLevel;
        return [{
            item,
            useSkill,
            useLevel,
            paramLevel,
            wieldAttackLevel,
            canUse,
            canWield,
            carryMode: canWield ? 'wield' : 'inventory',
            shops: [...(shops.get(item.id) ?? [])],
            tradeable: item.tradeable,
        }];
    });
}

function selectTool(
    kind: 'woodcutting-axe' | 'mining-pickaxe',
    orderedIdsDesc: readonly number[],
    useSkill: 'woodcutting' | 'mining',
    stock: readonly GearCount[],
    levels?: GearSkillLevels,
    enforceUseLevel = true,
): ToolRecommendation {
    const owned = stockTotals(stock);
    const candidates = buildToolCandidates(orderedIdsDesc, useSkill, levels, enforceUseLevel);

    const usable = candidates.filter(c => c.canUse);
    const current = usable.find(c => (owned.get(c.item.id) ?? 0) > 0) ?? null;
    const bestUsable = usable[0] ?? null;
    const currentIdx = current ? candidates.findIndex(c => c.item.id === current.item.id) : candidates.length;

    const nextAcquirable = bestUsable && (!current || bestUsable.item.id !== current.item.id)
        ? bestUsable
        : null;

    // Lowest locked tier strictly better than current usable (or next wield unlock if use-unlimited).
    const betterLocked = candidates.slice(0, currentIdx).filter(c => !c.canUse);
    const nextUnlock = betterLocked.at(-1) ?? null;

    return { kind, current, bestUsable, nextAcquirable, nextUnlock };
}

export function bestWoodcuttingAxe(
    stock: readonly GearCount[],
    levels?: GearSkillLevels,
    options?: { enforceAxeLevel?: boolean },
): ToolRecommendation {
    // In rev 289 (woodcut.rs2:220-240), axes have no Woodcutting level gate unless caller opts in.
    return selectTool('woodcutting-axe', WOODCUTTING_AXES_DESC, 'woodcutting', stock, levels, options?.enforceAxeLevel ?? false);
}

export function bestMiningPickaxe(stock: readonly GearCount[], levels?: GearSkillLevels): ToolRecommendation {
    return selectTool('mining-pickaxe', MINING_PICKAXES_DESC, 'mining', stock, levels, true);
}

export interface ElementalStaffOption {
    item: Gear;
    providedRunes: readonly number[];
    coveredRuneScore: number;
    shops: ShopSource[];
    tradeable: boolean;
}

export interface ElementalStaffRecommendation {
    current: ElementalStaffOption | null;
    bestUsable: ElementalStaffOption | null;
    nextAcquirable: ElementalStaffOption | null;
    nextUnlock: Gear | null;
}

export interface ElementalStaffOptions {
    runeIds?: readonly number[];
    members?: boolean;
    includePlainFallback?: boolean;
    requireWieldable?: boolean;
}

function elementalStaffRankList(
    levels?: GearSkillLevels,
    quests?: QuestInput,
    options: ElementalStaffOptions = {},
): { usable: ElementalStaffOption[]; locked: { item: Gear; providedRunes: readonly number[]; coveredRuneScore: number }[] } {
    const shops = shopCatalog();
    const runeIds = options.runeIds ?? [];
    const runeWeights = new Map<number, number>();
    runeIds.forEach((id, idx) => {
        // Count rune multiplicity (e.g. Curse: 3 Earth + 2 Water) plus gentle first-listed tie-break.
        runeWeights.set(id, (runeWeights.get(id) ?? 0) + 1 + (runeIds.length - idx) * 1e-4);
    });
    const allowPlain = options.includePlainFallback === true;
    const requireWieldable = options.requireWieldable !== false;
    const allowMembers = options.members !== false;

    const scoreCandidate = (g: Gear) => {
        const providedRunes = ELEMENTAL_STAFF_RUNES[g.id] ?? [];
        const coveredRuneScore = runeIds.length > 0
            ? providedRunes.reduce((sum, r) => sum + (runeWeights.get(r) ?? 0), 0)
            : providedRunes.length;
        return { providedRunes, coveredRuneScore };
    };

    const raw = gearCatalog().filter(g => {
        if (!isMagicWeapon(g)) return false;
        if (!allowMembers && g.members) return false;
        const providedRunes = ELEMENTAL_STAFF_RUNES[g.id];
        if (providedRunes) {
            if (runeIds.length === 0) return true;
            return providedRunes.some(r => runeWeights.has(r));
        }
        return allowPlain && (g.id === 1389 || g.id === 1379);
    });

    const sortFn = (a: { item: Gear; coveredRuneScore: number }, b: { item: Gear; coveredRuneScore: number }) =>
        (b.coveredRuneScore - a.coveredRuneScore)
        || (scoreGearForStyle(b.item, 'magic') - scoreGearForStyle(a.item, 'magic'))
        || (a.item.id - b.item.id);

    const usable: ElementalStaffOption[] = [];
    const locked: { item: Gear; providedRunes: readonly number[]; coveredRuneScore: number }[] = [];
    for (const item of raw) {
        const { providedRunes, coveredRuneScore } = scoreCandidate(item);
        if (!requireWieldable || canWearGear(item, levels, quests)) {
            usable.push({ item, providedRunes, coveredRuneScore, shops: [...(shops.get(item.id) ?? [])], tradeable: item.tradeable });
        } else {
            locked.push({ item, providedRunes, coveredRuneScore });
        }
    }

    usable.sort(sortFn);
    locked.sort((a, b) => sortFn(a, b));
    return { usable, locked };
}

/** Pick the best wieldable (or carried) elemental staff matching requested runes (ordered by savings). */
export function bestElementalStaffForRunes(
    stock: readonly GearCount[],
    levels?: GearSkillLevels,
    quests?: QuestInput,
    options: ElementalStaffOptions = {},
): ElementalStaffRecommendation {
    const owned = stockTotals(stock);
    const { usable, locked } = elementalStaffRankList(levels, quests, options);
    const current = usable.find(c => (owned.get(c.item.id) ?? 0) > 0) ?? null;
    const bestUsable = usable[0] ?? null;
    const nextAcquirable = bestUsable && (!current || bestUsable.item.id !== current.item.id)
        ? bestUsable
        : null;
    const minScore = current?.coveredRuneScore ?? 0;
    const nextUnlock = locked
        .filter(c => c.coveredRuneScore > minScore || (c.coveredRuneScore >= minScore && scoreGearForStyle(c.item, 'magic') > (current ? scoreGearForStyle(current.item, 'magic') : -1)))
        .sort((a, b) => Math.max(a.item.requires.skills.magic ?? 1, a.item.requires.skills.attack ?? 1) - Math.max(b.item.requires.skills.magic ?? 1, b.item.requires.skills.attack ?? 1) || a.item.id - b.item.id)[0]?.item ?? null;
    return { current, bestUsable, nextAcquirable, nextUnlock };
}

/** True when the account can buy at the shop: its quest, skill and quest-point gates. Unknown quest points count as 0. */
export function shopAccessible(
    shop: ShopSource,
    skills: Partial<Record<GearSkillName, number>>,
    done: Set<string>,
    allowedShops?: readonly string[],
    questPoints?: number,
): boolean {
    if (allowedShops && !allowedShops.includes(shop.shop)) return false;
    if (shop.requiresQuest && !done.has(shop.requiresQuest)) return false;
    if (shop.requiresSkill && (skills[shop.requiresSkill.skill.toLowerCase() as GearSkillName] ?? 1) < shop.requiresSkill.level) return false;
    if (shop.requiresQuestPoints && (questPoints ?? 0) < shop.requiresQuestPoints) return false;
    return true;
}

export interface ToolShopUpgradePlan {
    kind: 'woodcutting-axe' | 'mining-pickaxe' | 'magic-staff';
    currentId: number | null;
    target: Gear;
    shop: ShopSource;
    price: number;
    coinBudgetNeeded: number;
}

export interface ToolShopUpgradeOptions {
    allowedShops?: readonly string[];
    coinReserve?: number;
    priceBufferRatio?: number;
    onlyWhenStarterOrMissing?: boolean;
    enforceAxeLevel?: boolean;
    runeIds?: readonly number[];
    members?: boolean;
    quests?: QuestInput;
    /** The account's quest points, for shops behind a quest-point gate. Unknown counts as 0. */
    questPoints?: number;
}

/** Plan the best shop-purchasable tool or elemental staff upgrade strictly better than owned usable stock. */
export function planToolShopUpgrade(
    kind: 'woodcutting-axe' | 'mining-pickaxe' | 'magic-staff',
    stock: readonly GearCount[],
    coins: number,
    levels?: GearSkillLevels,
    options: ToolShopUpgradeOptions = {},
): ToolShopUpgradePlan | null {
    const skillMap = normalizeSkills(levels);
    const done = normalizeCompletedQuests(options.quests);
    const owned = stockTotals(stock);
    const reserve = Math.max(0, options.coinReserve ?? 0);
    const ratio = options.priceBufferRatio ?? 1.25;

    let currentId: number | null = null;
    let betterCandidates: { item: Gear; shops: ShopSource[] }[] = [];

    if (kind === 'magic-staff') {
        const { usable } = elementalStaffRankList(levels, options.quests, {
            runeIds: options.runeIds,
            members: options.members,
            includePlainFallback: false,
            requireWieldable: true,
        });
        const curIdx = usable.findIndex(c => (owned.get(c.item.id) ?? 0) > 0);
        const current = curIdx >= 0 ? usable[curIdx]! : null;
        currentId = current?.item.id ?? null;
        if (options.onlyWhenStarterOrMissing && current) return null;
        betterCandidates = curIdx >= 0 ? usable.slice(0, curIdx) : usable;
    } else {
        const ordered = kind === 'woodcutting-axe' ? WOODCUTTING_AXES_DESC : MINING_PICKAXES_DESC;
        const skill = kind === 'woodcutting-axe' ? 'woodcutting' : 'mining';
        const enforce = kind === 'mining-pickaxe' || options.enforceAxeLevel === true;
        const usable = buildToolCandidates(ordered, skill, levels, enforce).filter(c => c.canUse);
        const curIdx = usable.findIndex(c => (owned.get(c.item.id) ?? 0) > 0);
        const current = curIdx >= 0 ? usable[curIdx]! : null;
        currentId = current?.item.id ?? null;
        const starterId = kind === 'woodcutting-axe' ? 1351 : 1265;
        if (options.onlyWhenStarterOrMissing && current && current.item.id !== starterId) return null;
        betterCandidates = curIdx >= 0 ? usable.slice(0, curIdx) : usable;
    }

    for (const candidate of betterCandidates) {
        const accessibleShops = candidate.shops
            .filter(s => shopAccessible(s, skillMap, done, options.allowedShops, options.questPoints))
            .sort((a, b) => a.cost - b.cost);
        for (const shop of accessibleShops) {
            const coinBudgetNeeded = Math.ceil(shop.cost * ratio) + reserve;
            if (coins >= coinBudgetNeeded) {
                return {
                    kind,
                    currentId,
                    target: candidate.item,
                    shop,
                    price: shop.cost,
                    coinBudgetNeeded,
                };
            }
        }
    }
    return null;
}

export interface BankToolSwapPlan {
    targetId: number;
    withdrawFromBank: boolean;
    equipInWeaponSlot: boolean;
    depositInventoryIds: number[];
    alreadyActive: boolean;
}

/** Pure plan for activating `targetId` at an open bank without losing any item in `toolGroupIds`. */
export function planBankToolSwap(params: {
    targetId: number;
    canWield: boolean;
    allowReplaceWeapon?: boolean;
    inventory: readonly GearCount[];
    equipment: readonly { id: number; slot: number }[];
    bank: readonly GearCount[];
    toolGroupIds: readonly number[];
    refusedWields?: ReadonlySet<number>;
}): BankToolSwapPlan {
    const group = new Set(params.toolGroupIds);
    const invCount = (id: number) => params.inventory.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const bankCount = (id: number) => params.bank.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const weapon = params.equipment.find(i => i.slot === 3);
    const wearingTarget = weapon?.id === params.targetId;
    const heldTarget = invCount(params.targetId) > 0;
    const withdrawFromBank = !wearingTarget && !heldTarget && bankCount(params.targetId) > 0;
    const canOccupyWeaponSlot = !weapon || group.has(weapon.id) || params.allowReplaceWeapon === true;
    const equipInWeaponSlot = params.canWield
        && !wearingTarget
        && canOccupyWeaponSlot
        && !params.refusedWields?.has(params.targetId)
        && (heldTarget || withdrawFromBank);

    const willWearTarget = wearingTarget || equipInWeaponSlot;
    const depositSet = new Set<number>();
    for (const row of params.inventory) {
        if (!group.has(row.id) || row.count <= 0) continue;
        if (!willWearTarget && row.id === params.targetId) continue;
        depositSet.add(row.id);
    }

    const alreadyActive = !withdrawFromBank
        && !equipInWeaponSlot
        && depositSet.size === 0
        && (wearingTarget || heldTarget);

    return {
        targetId: params.targetId,
        withdrawFromBank,
        equipInWeaponSlot,
        depositInventoryIds: [...depositSet],
        alreadyActive,
    };
}

export interface ReconcileBankToolHooks {
    openBank: () => Promise<unknown>;
    closeBank: () => Promise<unknown>;
    withdrawItem: (item: { id: number; name: string; count: number; slot?: number }, count: number) => Promise<unknown>;
    depositItem: (item: { id: number; name: string; count: number; slot?: number }, count: number) => Promise<unknown>;
    equipItem?: (item: { id: number; name: string; count: number; slot?: number }) => Promise<unknown>;
    getInventory: () => readonly { id: number; name: string; count: number; slot?: number }[];
    getEquipment: () => readonly { id: number; name?: string; count?: number; slot: number }[];
    getBankState: () => { isOpen: boolean; items: readonly { id: number; name: string; count: number; slot?: number }[] } | undefined;
    getBankGeneration?: () => number | undefined;
    waitUntil: (pred: () => boolean, timeoutTicks: number) => Promise<boolean>;
    stop?: () => boolean;
}

/**
 * Reconcile a chosen tool/staff against an already-open (or openable) bank:
 * deposits redundant tools first when space is tight, withdraws `targetId` if needed,
 * wields when eligible and allowed, and preserves exact item counts across `toolGroupIds`.
 */
export async function reconcileBankTool(
    hooks: ReconcileBankToolHooks,
    params: {
        targetId: number;
        canWield: boolean;
        allowReplaceWeapon?: boolean;
        toolGroupIds: readonly number[];
        refusedWields?: Set<number>;
    },
): Promise<{ activeId: number; worn: boolean; changed: boolean }> {
    const checkStop = (why: string) => {
        if (hooks.stop?.()) throw new Error(why);
    };
    const countIn = (rows: readonly { id: number; count?: number }[], id: number) =>
        rows.filter(r => r.id === id).reduce((n, r) => n + (r.count ?? 1), 0);
    const groupTotals = () => {
        const st = hooks.getBankState();
        if (!st?.isOpen) throw new Error('tool reconcile requires open bank');
        const out = new Map<number, number>();
        for (const id of params.toolGroupIds) {
            out.set(
                id,
                countIn(hooks.getInventory(), id) + countIn(hooks.getEquipment(), id) + countIn(st.items, id),
            );
        }
        return out;
    };

    checkStop('tool reconcile stopped');
    if (!hooks.getBankState()?.isOpen) {
        await hooks.openBank();
        const opened = await hooks.waitUntil(() => !!hooks.stop?.() || !!hooks.getBankState()?.isOpen, 10);
        checkStop('tool reconcile stopped opening bank');
        if (!opened || !hooks.getBankState()?.isOpen) throw new Error('tool reconcile bank open unobserved');
    }

    const before = groupTotals();
    let bankSt = hooks.getBankState()!;
    let plan = planBankToolSwap({
        targetId: params.targetId,
        canWield: params.canWield,
        allowReplaceWeapon: params.allowReplaceWeapon,
        inventory: hooks.getInventory(),
        equipment: hooks.getEquipment(),
        bank: bankSt.items,
        toolGroupIds: params.toolGroupIds,
        refusedWields: params.refusedWields,
    });

    if (plan.alreadyActive) {
        const worn = hooks.getEquipment().some(e => e.slot === 3 && e.id === params.targetId);
        return { activeId: params.targetId, worn, changed: false };
    }

    const depositOneId = async (id: number) => {
        const item = hooks.getInventory().find(i => i.id === id);
        if (!item) return;
        const inv0 = countIn(hooks.getInventory(), id);
        const gen0 = hooks.getBankGeneration?.();
        await hooks.depositItem(item, -1);
        const ok = await hooks.waitUntil(() => {
            if (hooks.stop?.()) return true;
            const gen = hooks.getBankGeneration?.();
            return countIn(hooks.getInventory(), id) < inv0 && (gen0 === undefined || (gen ?? -1) > gen0);
        }, 10);
        checkStop('tool reconcile stopped during deposit');
        if (!ok || countIn(hooks.getInventory(), id) > 0) throw new Error(`tool deposit unconfirmed for ${id}`);
    };

    // Free space first if withdrawing into a full pack and carrying inferior tools.
    if (plan.withdrawFromBank && hooks.getInventory().length >= 28) {
        for (const depId of plan.depositInventoryIds) {
            checkStop('tool reconcile stopped freeing slot');
            await depositOneId(depId);
            if (hooks.getInventory().length < 28) break;
        }
    }

    if (plan.withdrawFromBank) {
        checkStop('tool reconcile stopped before withdraw');
        if (hooks.getInventory().length >= 28) throw new Error(`tool upgrade ${params.targetId} needs one free slot`);
        bankSt = hooks.getBankState()!;
        const bankRow = bankSt.items.find(i => i.id === params.targetId && i.count > 0);
        if (!bankRow) throw new Error(`owned tool ${params.targetId} missing from open bank`);
        const held0 = countIn(hooks.getInventory(), params.targetId);
        const stored0 = countIn(bankSt.items, params.targetId);
        const gen0 = hooks.getBankGeneration?.();
        await hooks.withdrawItem(bankRow, 1);
        const matched = await hooks.waitUntil(() => {
            if (hooks.stop?.()) return true;
            const st = hooks.getBankState();
            const gen = hooks.getBankGeneration?.();
            return !!st?.isOpen
                && countIn(hooks.getInventory(), params.targetId) === held0 + 1
                && countIn(st.items, params.targetId) === stored0 - 1
                && (gen0 === undefined || (gen ?? -1) > gen0);
        }, 10);
        checkStop('tool reconcile stopped after withdraw');
        if (!matched) throw new Error(`tool withdrawal unconfirmed for ${params.targetId}`);
    }

    if (plan.equipInWeaponSlot && hooks.equipItem) {
        checkStop('tool reconcile stopped before equip');
        const invItem = hooks.getInventory().find(i => i.id === params.targetId);
        if (!invItem) throw new Error(`tool ${params.targetId} missing from inventory before equip`);
        const gen0 = hooks.getBankGeneration?.();
        await hooks.closeBank();
        const closed = await hooks.waitUntil(() => !!hooks.stop?.() || !hooks.getBankState()?.isOpen, 8);
        checkStop('tool reconcile stopped closing bank');
        if (!closed || hooks.getBankState()?.isOpen) throw new Error('tool reconcile bank close unobserved');
        try {
            await hooks.equipItem(invItem);
        } catch {
            // Observe actual worn slot rather than retrying an uncertain wield.
        }
        await hooks.waitUntil(() => !!hooks.stop?.() || hooks.getEquipment().some(e => e.slot === 3 && e.id === params.targetId), 3);
        if (!hooks.getEquipment().some(e => e.slot === 3 && e.id === params.targetId)) {
            params.refusedWields?.add(params.targetId);
        }
        checkStop('tool reconcile stopped after equip');
        await hooks.openBank();
        const reopened = await hooks.waitUntil(() => {
            if (hooks.stop?.()) return true;
            const st = hooks.getBankState();
            const gen = hooks.getBankGeneration?.();
            return !!st?.isOpen && (gen0 === undefined || (gen ?? -1) > gen0);
        }, 12);
        checkStop('tool reconcile stopped reopening bank');
        if (!reopened || !hooks.getBankState()?.isOpen) throw new Error('tool reconcile bank reopen unobserved');
    }

    // Recompute deposits after equip (wielded tool may have swapped old weapon into inventory).
    // Keep target tool in inventory if wield did not take place.
    const wornAfterEquip = hooks.getEquipment().some(e => e.slot === 3 && e.id === params.targetId);
    plan = planBankToolSwap({
        targetId: params.targetId,
        canWield: wornAfterEquip,
        allowReplaceWeapon: params.allowReplaceWeapon,
        inventory: hooks.getInventory(),
        equipment: hooks.getEquipment(),
        bank: hooks.getBankState()!.items,
        toolGroupIds: params.toolGroupIds,
        refusedWields: params.refusedWields,
    });
    for (const depId of plan.depositInventoryIds) {
        checkStop('tool reconcile stopped before inferior deposit');
        await depositOneId(depId);
    }

    const after = groupTotals();
    for (const id of params.toolGroupIds) {
        if ((before.get(id) ?? 0) !== (after.get(id) ?? 0)) {
            throw new Error(`tool reconcile asset mismatch for ${id}`);
        }
    }
    const worn = hooks.getEquipment().some(e => e.slot === 3 && e.id === params.targetId);
    const held = hooks.getInventory().some(i => i.id === params.targetId);
    if (!worn && !held) throw new Error(`target tool ${params.targetId} not active after reconcile`);
    return { activeId: params.targetId, worn, changed: true };
}

export const TOOL_SHOP_LOCATIONS = {
    axeshop: { shop: 'axeshop', npc: /^bob$/i, spot: { x: 3231, z: 3203, level: 0 } },
    pickaxeshop: { shop: 'pickaxeshop', npc: /^nurmof$/i, spot: { x: 2998, z: 9844, level: 0 } },
    staffshop: { shop: 'staffshop', npc: /^zaff$/i, spot: { x: 3203, z: 3433, level: 0 } },
    fishingshop2: { shop: 'fishingshop2', npc: /^harry$/i, spot: { x: 2834, z: 3445, level: 0 } },
} as const;

export type KnownToolShop = keyof typeof TOOL_SHOP_LOCATIONS;

export interface ShopToolPurchaseHooks extends ReconcileBankToolHooks {
    walkTo: (spot: { x: number; z: number; level?: number }) => Promise<boolean>;
    openShop: (npc: RegExp) => Promise<{ success: boolean; message?: string }>;
    buyFromShop: (item: { id: number; name: string; count: number; buyPrice?: number; slot?: number } | RegExp, amount: number) => Promise<{ success: boolean; message?: string }>;
    closeShop: () => Promise<unknown>;
    getShopState: () => { isOpen: boolean; shopItems: readonly { id: number; name: string; count: number; buyPrice?: number; slot?: number }[] } | undefined;
}

export const SHOP_RESTOCK_COOLDOWN_TICKS = 700;

export interface ShopRetryGate {
    checkedTier?: number;
    failedAt?: { tier: number; tick: number };
}

/**
 * Per-tier and failed-shop cooldown guard for progressive tool/staff purchases.
 * Skips already-bought tiers until a higher tier unlocks, and backs off failed
 * shelf checks for `cooldownTicks` (default 700 ticks for slow restocks).
 */
export function shouldAttemptShopUpgrade(
    gate: ShopRetryGate,
    tier: number,
    tick: number,
    cooldownTicks: number = SHOP_RESTOCK_COOLDOWN_TICKS,
): boolean {
    if (gate.checkedTier !== undefined && gate.checkedTier >= tier) return false;
    if (gate.failedAt && gate.failedAt.tier >= tier && tick - gate.failedAt.tick < cooldownTicks) return false;
    return true;
}

/** Record whether a shop purchase check succeeded or failed for `tier` at `tick`. */
export function recordShopAttempt(
    gate: ShopRetryGate,
    tier: number,
    tick: number,
    bought: boolean,
): void {
    if (bought) {
        gate.checkedTier = Math.max(gate.checkedTier ?? -Infinity, tier);
        if (gate.failedAt && gate.failedAt.tier <= tier) gate.failedAt = undefined;
        return;
    }
    gate.failedAt = { tier, tick };
}

/** Return or allocate a per-session `ShopRetryGate` stored in `cache` unless `explicit` is supplied. */
export function sessionShopGate(
    cache: WeakMap<object, ShopRetryGate>,
    session: object,
    explicit?: ShopRetryGate,
): ShopRetryGate {
    if (explicit) return explicit;
    let gate = cache.get(session);
    if (!gate) {
        gate = {};
        cache.set(session, gate);
    }
    return gate;
}

/**
 * Buy a single tool/staff from a rev-289 shop with exact coin/item reconciliation:
 * withdraws only missing coin budget when needed, verifies stock/price, buys 1, closes shop,
 * returns to `returnBankSpot` if supplied, and re-deposits withdrawn coins if aborted.
 */
export async function executeShopToolPurchase(
    hooks: ShopToolPurchaseHooks,
    params: {
        targetId: number;
        shop: KnownToolShop;
        maxBudget: number;
        coinReserve?: number;
        returnBankSpot?: { x: number; z: number; level?: number };
    },
): Promise<{ bought: boolean; id: number; coinsSpent: number; reason?: string }> {
    const checkStop = (why: string) => {
        if (hooks.stop?.()) throw new Error(why);
    };
    const countIn = (rows: readonly { id: number; count?: number }[], id: number) =>
        rows.filter(r => r.id === id).reduce((n, r) => n + (r.count ?? 1), 0);
    const COINS = 995;
    const reserve = Math.max(0, params.coinReserve ?? 0);
    const shopDef = TOOL_SHOP_LOCATIONS[params.shop];
    let withdrewCoins = 0;
    let walkedToShop = false;

    const recoverToBank = async () => {
        if (hooks.getShopState()?.isOpen) {
            await hooks.closeShop().catch(() => undefined);
            await hooks.waitUntil(() => !!hooks.stop?.() || !hooks.getShopState()?.isOpen, 6);
            checkStop('shop tool purchase stopped closing shop');
        }
        if (walkedToShop && params.returnBankSpot) {
            const back = await hooks.walkTo(params.returnBankSpot);
            checkStop('shop tool purchase stopped walking back to bank');
            if (!back) throw new Error('shop tool purchase return-to-bank walk failed');
        }
        if (withdrewCoins > 0) {
            if (!hooks.getBankState()?.isOpen) {
                await hooks.openBank();
                const reopened = await hooks.waitUntil(() => !!hooks.stop?.() || !!hooks.getBankState()?.isOpen, 10);
                checkStop('shop tool purchase stopped reopening bank');
                if (!reopened || !hooks.getBankState()?.isOpen) {
                    throw new Error('shop tool purchase bank reopen unobserved');
                }
            }
            const coinRow = hooks.getInventory().find(i => i.id === COINS && i.count > 0);
            if (coinRow) {
                const depositAmt = Math.min(coinRow.count, withdrewCoins);
                const invBefore = countIn(hooks.getInventory(), COINS);
                const bankBefore = countIn(hooks.getBankState()!.items, COINS);
                const gen0 = hooks.getBankGeneration?.();
                await hooks.depositItem(coinRow, depositAmt === coinRow.count ? -1 : depositAmt);
                const deposited = await hooks.waitUntil(() => {
                    if (hooks.stop?.()) return true;
                    const bst = hooks.getBankState();
                    const gen = hooks.getBankGeneration?.();
                    return !!bst?.isOpen
                        && countIn(hooks.getInventory(), COINS) === invBefore - depositAmt
                        && countIn(bst.items, COINS) === bankBefore + depositAmt
                        && (gen0 === undefined || (gen ?? -1) > gen0);
                }, 10);
                checkStop('shop tool purchase stopped depositing withdrawn coins');
                if (!deposited) throw new Error('shop coin return deposit unconfirmed');
            }
        }
    };

    checkStop('shop tool purchase stopped');
    let invCoins = countIn(hooks.getInventory(), COINS);
    if (invCoins < params.maxBudget) {
        if (!hooks.getBankState()?.isOpen) {
            await hooks.openBank();
            const opened = await hooks.waitUntil(() => !!hooks.stop?.() || !!hooks.getBankState()?.isOpen, 10);
            checkStop('shop tool purchase stopped opening bank');
            if (!opened || !hooks.getBankState()?.isOpen) {
                return { bought: false, id: params.targetId, coinsSpent: 0, reason: 'bank unavailable for coins' };
            }
        }
        const st = hooks.getBankState()!;
        const bankCoinRow = st.items.find(i => i.id === COINS);
        const bankCoins = countIn(st.items, COINS);
        if (invCoins + bankCoins < params.maxBudget) {
            await hooks.closeBank();
            return { bought: false, id: params.targetId, coinsSpent: 0, reason: 'insufficient coins' };
        }
        const need = params.maxBudget - invCoins;
        if (need > 0 && bankCoinRow) {
            if (hooks.getInventory().length >= (invCoins === 0 ? 27 : 28)) {
                await hooks.closeBank();
                return { bought: false, id: params.targetId, coinsSpent: 0, reason: 'no free slot for coins and tool' };
            }
            const gen0 = hooks.getBankGeneration?.();
            await hooks.withdrawItem(bankCoinRow, need);
            const ok = await hooks.waitUntil(() => {
                if (hooks.stop?.()) return true;
                const bst = hooks.getBankState();
                const gen = hooks.getBankGeneration?.();
                return !!bst?.isOpen
                    && countIn(hooks.getInventory(), COINS) === invCoins + need
                    && countIn(bst.items, COINS) === bankCoins - need
                    && (gen0 === undefined || (gen ?? -1) > gen0);
            }, 10);
            if (ok) withdrewCoins += need;
            checkStop('shop tool purchase stopped withdrawing coins');
            if (!ok) throw new Error('shop coin withdrawal unconfirmed');
            invCoins = countIn(hooks.getInventory(), COINS);
        }
    }

    if (hooks.getBankState()?.isOpen) {
        await hooks.closeBank();
        await hooks.waitUntil(() => !!hooks.stop?.() || !hooks.getBankState()?.isOpen, 8);
        checkStop('shop tool purchase stopped closing bank');
    }

    if (hooks.getInventory().length >= 28) {
        await recoverToBank();
        return { bought: false, id: params.targetId, coinsSpent: 0, reason: 'inventory full' };
    }

    walkedToShop = true;
    const arrived = await hooks.walkTo(shopDef.spot);
    checkStop('shop tool purchase stopped walking to shop');
    if (!arrived) {
        await recoverToBank();
        return { bought: false, id: params.targetId, coinsSpent: 0, reason: `could not reach ${params.shop}` };
    }

    const openReply = await hooks.openShop(shopDef.npc);
    if (!openReply.success) {
        await recoverToBank();
        return { bought: false, id: params.targetId, coinsSpent: 0, reason: openReply.message ?? 'shop open refused' };
    }
    const shopReady = await hooks.waitUntil(() => !!hooks.stop?.() || !!hooks.getShopState()?.isOpen, 10);
    checkStop('shop tool purchase stopped waiting for shop');
    if (!shopReady || !hooks.getShopState()?.isOpen) {
        await recoverToBank();
        return { bought: false, id: params.targetId, coinsSpent: 0, reason: 'shop observation missing' };
    }

    const row = hooks.getShopState()!.shopItems.find(i => i.id === params.targetId);
    const price = row?.buyPrice ?? 0;
    const cashBefore = countIn(hooks.getInventory(), COINS);
    const heldBefore = countIn(hooks.getInventory(), params.targetId);
    if (!row || row.count <= 0 || cashBefore < price + reserve || price > params.maxBudget - reserve) {
        await recoverToBank();
        return { bought: false, id: params.targetId, coinsSpent: 0, reason: 'stock absent or price over budget' };
    }

    const buyReply = await hooks.buyFromShop(row, 1);
    const confirmed = await hooks.waitUntil(() => {
        if (hooks.stop?.()) return true;
        return countIn(hooks.getInventory(), params.targetId) === heldBefore + 1
            && countIn(hooks.getInventory(), COINS) === cashBefore - price;
    }, 10);
    checkStop('shop tool purchase stopped waiting for purchase');
    await hooks.closeShop().catch(() => undefined);
    await hooks.waitUntil(() => !!hooks.stop?.() || !hooks.getShopState()?.isOpen, 6);

    const spent = cashBefore - countIn(hooks.getInventory(), COINS);
    if (!confirmed || countIn(hooks.getInventory(), params.targetId) < heldBefore + 1 || spent !== price) {
        throw new Error(buyReply.success ? `shop buy reconciliation mismatch for ${params.targetId}` : `shop buy refused: ${buyReply.message ?? params.targetId}`);
    }

    if (params.returnBankSpot) {
        const back = await hooks.walkTo(params.returnBankSpot);
        checkStop('shop tool purchase stopped walking back to bank');
        if (!back) throw new Error('shop tool purchase return-to-bank walk failed');
    }

    return { bought: true, id: params.targetId, coinsSpent: spent };
}

export interface SessionToolLike {
    sdk: {
        getState: () => {
            bank?: { isOpen: boolean; items: readonly { id: number; name: string; count: number; slot?: number }[] };
            shop?: { isOpen: boolean; shopItems: readonly { id: number; name: string; count: number; buyPrice?: number; slot?: number }[] };
            equipment?: readonly { id: number; name?: string; count?: number; slot: number }[];
        } | null | undefined;
        getInventory: () => readonly { id: number; name: string; count: number; slot?: number }[];
        getEquipment?: () => readonly { id: number; name?: string; count?: number; slot: number }[];
    };
    bot: {
        openBank: () => Promise<unknown>;
        closeBank: () => Promise<unknown>;
        withdrawItem: (item: any, count: number, opts?: any) => Promise<unknown>;
        depositItem: (item: any, count: number) => Promise<unknown>;
        equipItem?: (item: any) => Promise<unknown>;
        openShop: (npc: RegExp) => Promise<{ success: boolean; message?: string }>;
        buyFromShop: (item: any, amount: number) => Promise<{ success: boolean; message?: string }>;
        closeShop: () => Promise<unknown>;
    };
    bankObservation?: () => { generation: number; items: readonly { id: number; name: string; count: number; slot?: number }[] } | null | undefined;
}

/** Build tool-reconcile & shop-purchase hooks from a bot Session (zero runtime SDK imports in planner). */
export function sessionToolHooks(
    s: SessionToolLike,
    options: {
        openBank?: () => Promise<unknown>;
        closeBank?: () => Promise<unknown>;
        walkTo?: (spot: { x: number; z: number; level?: number }) => Promise<boolean>;
        waitUntil: (pred: () => boolean, timeoutTicks: number) => Promise<boolean>;
        stop?: () => boolean;
    },
): ShopToolPurchaseHooks {
    return {
        openBank: options.openBank ?? (() => s.bot.openBank()),
        closeBank: options.closeBank ?? (() => s.bot.closeBank()),
        // The SDK takes a bank row with a slot. A row from the bank observation has none: use the open bank's row of
        // the same id (without it the SDK looks the item up by name and throws on an object).
        withdrawItem: (item, n) => {
            const row = item.slot === undefined ? s.sdk.getState()?.bank?.items.find(i => i.id === item.id) ?? item : item;
            return s.bot.withdrawItem(row, n, { asNote: false });
        },
        depositItem: (item, n) => s.bot.depositItem(item, n),
        equipItem: s.bot.equipItem ? item => s.bot.equipItem!(item) : undefined,
        getInventory: () => s.sdk.getInventory(),
        getEquipment: () => s.sdk.getEquipment?.() ?? s.sdk.getState()?.equipment ?? [],
        getBankState: () => {
            const b = s.sdk.getState()?.bank;
            if (!b) return undefined;
            const obs = s.bankObservation?.();
            return { isOpen: b.isOpen, items: obs?.items ?? b.items };
        },
        getBankGeneration: () => s.bankObservation?.()?.generation,
        walkTo: options.walkTo ?? (async () => false),
        openShop: npc => s.bot.openShop(npc),
        buyFromShop: (item, n) => s.bot.buyFromShop(item, n),
        closeShop: () => s.bot.closeShop(),
        getShopState: () => s.sdk.getState()?.shop,
        waitUntil: options.waitUntil,
        stop: options.stop,
    };
}

export type GearUnlockKind = CombatFocus | 'woodcutting-axe' | 'mining-pickaxe';
export type GearUnlockLevels = Readonly<Partial<Record<GearSkillName, readonly number[]>>>;
export const GEAR_UNLOCK_KINDS: readonly GearUnlockKind[] = ['melee', 'ranged', 'magic', 'woodcutting-axe', 'mining-pickaxe'];

interface SkillToolRow { id: number; wieldAttack?: number | null; paramLevelrequire?: number | null; woodcuttingLevel?: number | null; miningLevel?: number | null }
let cachedSkillTools: { axes: SkillToolRow[]; pickaxes: SkillToolRow[] } | undefined;
function skillTools() {
    return cachedSkillTools ??= JSON.parse(readFileSync(resolve(ROOT, 'knowledge', 'skill-tools.json'), 'utf8')) as { axes: SkillToolRow[]; pickaxes: SkillToolRow[] };
}

const unlockCache = new Map<GearUnlockKind | 'all', GearUnlockLevels>();

/**
 * The levels above 1 at which a skill unlocks an item of the kind, ascending, by skill. A combat style reads the
 * wear levels of every item the style scores (knowledge/gear.json, with an arrow's levelrequire as a Ranged level).
 * A tool kind reads knowledge/skill-tools.json: the Attack level to wield, and the skill level to use.
 */
export function gearUnlockLevels(kind: GearUnlockKind): GearUnlockLevels {
    const cached = unlockCache.get(kind);
    if (cached) return cached;
    const sets = new Map<GearSkillName, Set<number>>();
    const add = (skill: GearSkillName, level: number | null | undefined) => {
        if (typeof level !== 'number' || !Number.isSafeInteger(level) || level <= 1 || level > 99) return;
        const set = sets.get(skill) ?? new Set<number>();
        set.add(level);
        sets.set(skill, set);
    };
    if (kind === 'woodcutting-axe' || kind === 'mining-pickaxe') {
        const rows = kind === 'woodcutting-axe' ? skillTools().axes : skillTools().pickaxes;
        const skill: GearSkillName = kind === 'woodcutting-axe' ? 'woodcutting' : 'mining';
        for (const row of rows) {
            add('attack', row.wieldAttack);
            // An axe has no Woodcutting gate in rev 289 (woodcuttingLevel null); its levelrequire param serves a caller
            // that enforces the axe level (bestWoodcuttingAxe enforceAxeLevel).
            add(skill, kind === 'woodcutting-axe' ? row.woodcuttingLevel ?? row.paramLevelrequire : row.miningLevel);
        }
    } else {
        for (const g of gearCatalog()) {
            if (g.slot === 'quiver') {
                if (kind === 'ranged' && isStandardArrow(g)) add('ranged', g.tier);
                continue;
            }
            const score = scoreGearForStyle(g, kind);
            if (g.slot === 'righthand' ? score <= -1e8 : score <= 0) continue;
            for (const [skill, level] of Object.entries(g.requires.skills)) add(skill as GearSkillName, level);
        }
    }
    const out: Partial<Record<GearSkillName, readonly number[]>> = {};
    for (const [skill, set] of sets) out[skill] = [...set].sort((a, b) => a - b);
    unlockCache.set(kind, out);
    return out;
}

function allGearUnlockLevels(): GearUnlockLevels {
    const cached = unlockCache.get('all');
    if (cached) return cached;
    const sets = new Map<GearSkillName, Set<number>>();
    for (const kind of GEAR_UNLOCK_KINDS) {
        for (const [skill, levels] of Object.entries(gearUnlockLevels(kind))) {
            const set = sets.get(skill as GearSkillName) ?? new Set<number>();
            for (const level of levels ?? []) set.add(level);
            sets.set(skill as GearSkillName, set);
        }
    }
    const out: Partial<Record<GearSkillName, readonly number[]>> = {};
    for (const [skill, set] of sets) out[skill] = [...set].sort((a, b) => a - b);
    unlockCache.set('all', out);
    return out;
}

/** The highest boundary of `tiers` at or under the level, or 1. */
export function tierBoundaryOf(level: number, tiers: readonly number[]): number {
    let highest = 1;
    for (const t of tiers) if (level >= t) highest = t;
    return highest;
}

/**
 * True when one of the skills passed an unlock level between the two observations. `tiers` names the item kind whose
 * unlock levels count (gearUnlockLevels), or gives a level list for every skill. Without it, every kind counts.
 */
export function crossedTierBoundary(
    previous: GearSkillLevels,
    current: GearSkillLevels,
    skills: readonly string[] = ['attack', 'strength', 'defence'],
    tiers?: GearUnlockKind | GearUnlockLevels | readonly number[],
): boolean {
    const prev = normalizeSkills(previous);
    const curr = normalizeSkills(current);
    const isList = (t: typeof tiers): t is readonly number[] => Array.isArray(t);
    const bySkill = isList(tiers) ? undefined : tiers === undefined ? allGearUnlockLevels() : typeof tiers === 'string' ? gearUnlockLevels(tiers) : tiers;
    return skills.some(s => {
        const key = s.toLowerCase() as GearSkillName;
        const levels = isList(tiers) ? tiers : bySkill?.[key] ?? [];
        return tierBoundaryOf(curr[key] ?? 1, levels) > tierBoundaryOf(prev[key] ?? 1, levels);
    });
}

let cachedGearByName: Map<string, number> | undefined;
/** The gear item id of a name ("Bronze sword", "bronze_sword") or numeric id string, or undefined. Not gear: undefined. */
export function gearIdByName(name: string | number): number | undefined {
    if (typeof name === 'number') return gearById(name) ? name : undefined;
    const key = name.trim().toLowerCase().replace(/_/g, ' ');
    if (/^\d+$/.test(key)) return gearById(Number(key)) ? Number(key) : undefined;
    if (!cachedGearByName) {
        cachedGearByName = new Map();
        for (const g of gearCatalog()) {
            for (const k of [g.name.toLowerCase(), g.debugname.toLowerCase().replace(/_/g, ' ')]) if (!cachedGearByName.has(k)) cachedGearByName.set(k, g.id);
        }
    }
    return cachedGearByName.get(key);
}

/**
 * True when the owned items hold a melee weapon that the levels and quests let the account wield (spears and
 * halberds count only when `trainSkill` allows them). `owned` maps an item name or id to its count, e.g.
 * { 'bronze sword': 1, 333: 5 }; a key that is not gear is ignored. The planner asks this for a stock of
 * names; the worker side calls selectProgressiveLoadout.
 */
export function ownsWearableMeleeWeapon(
    owned: Readonly<Record<string, number>> | readonly GearCount[],
    levels?: GearSkillLevels,
    quests?: QuestInput,
    trainSkill?: string,
): boolean {
    const rows: GearCount[] = Array.isArray(owned)
        ? [...owned as readonly GearCount[]]
        : Object.entries(owned as Record<string, number>).flatMap(([key, count]) => {
            const id = gearIdByName(key);
            return id === undefined || !(count > 0) ? [] : [{ id, count }];
        });
    return hasOwnedWearableWeapon('melee', rows, levels, quests, trainSkill ?? 'all-melee');
}

export function hasOwnedWearableWeapon(
    style: CombatFocus,
    stock: readonly GearCount[],
    levels?: GearSkillLevels,
    quests?: QuestInput,
    trainSkill?: string,
): boolean {
    const loadout = selectProgressiveLoadout(style, stock, levels, quests, { trainSkill, requireWeapon: true });
    return loadout.worn.weapon !== null;
}

/**
 * Every melee weapon as the weapon option of an owned-loadout slot, the best first (scoreGearForStyle). An option is
 * equippable when the Attack level and the quests meet the weapon's wear rules, and unknown (null) when the Attack
 * level is unknown. `oneHanded` leaves out two-handed weapons (a worker that wears a fixed shield).
 */
export function meleeWeaponSlot(
    attack: number | null,
    options: { oneHanded?: boolean; trainSkill?: string; quests?: QuestInput } = {},
): GearSlot {
    const known = attack !== null && Number.isSafeInteger(attack) && attack >= 1 && attack <= 99;
    const list = gearCatalog()
        .filter(g => g.slot === 'righthand' && scoreGearForStyle(g, 'melee') > -1e8
            && weaponSupportsTrainSkill(g, options.trainSkill ?? 'all-melee')
            && !(options.oneHanded && g.covers.includes('lefthand')))
        .sort((a, b) => scoreGearForStyle(b, 'melee') - scoreGearForStyle(a, 'melee') || tieOrder(a, b, 'melee'));
    return {
        key: 'weapon',
        options: list.map((g, preference) => ({
            id: g.id, count: 1, preference,
            equippable: known ? canWearGear(g, { attack: attack! }, options.quests) : null,
        })),
    };
}

/** The Fire giant pilot's kit: its best one-handed melee weapon (the engine's choice) with the fixed shield, amulet, rope and Salmon. */
export function fireKit(attack: number | null): GearSlot[] {
    const fixed = [{ key: 'shield', id: 1171, count: 1 }, { key: 'amulet', id: 295, count: 1 }, { key: 'rope', id: 954, count: 1 }, { key: 'salmon', id: 329, count: 16 }];
    return [meleeWeaponSlot(attack, { oneHanded: true, trainSkill: 'Attack' }),
        ...fixed.map(x => ({ key: x.key, options: [{ id: x.id, count: x.count, preference: 0, equippable: true }] }))];
}

export { ownedLoadout };
