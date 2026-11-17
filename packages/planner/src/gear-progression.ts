// Rev-289 progressive loadout selection, upgrade planning, and skilling tool selection
// backed by knowledge/gear.json (scripts/gear.ts canWear/best) and knowledge/shops.json.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Bonus, Gear, Skill } from '../../knowledge/src/gear';
import type { Shop } from '../../knowledge/src/shops';
import { canWear, loadGear, sumBonuses } from '../../../scripts/gear';
import { ownedBestLoadout, ownedLoadout, type GearCount, type GearSlot, type OptionalGearSlot, type OwnedLoadout } from './owned-loadout';

export type CombatFocus = 'melee' | 'ranged' | 'magic';
export type LoadoutSlotName = 'weapon' | 'shield' | 'helm' | 'body' | 'legs' | 'amulet' | 'cape' | 'hands' | 'feet';
export type RangedLoadoutSlotName = LoadoutSlotName | 'ammo';
export type GearSkillName = Skill | 'woodcutting' | 'mining' | 'hitpoints' | 'prayer';
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
    "Heroes' Quest",
    "Legends' Quest",
    'The Fremennik Trials',
    'Regicide',
] as const;

export const TIER_BOUNDARIES = [5, 10, 20, 30, 40, 60] as const;

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
    "heroes' quest": "Heroes' Quest",
    "hero's quest": "Heroes' Quest",
    'heroes quest': "Heroes' Quest",
    'hero quest': "Heroes' Quest",
    hero: "Heroes' Quest",
    heroquest: "Heroes' Quest",
    quest_hero: "Heroes' Quest",
    "legends' quest": "Legends' Quest",
    'legends quest': "Legends' Quest",
    'the legends quest': "Legends' Quest",
    legends: "Legends' Quest",
    legendsquest: "Legends' Quest",
    quest_legends: "Legends' Quest",
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

const READ_SKILL_NAMES = ['Attack', 'Strength', 'Defence', 'Ranged', 'Magic', 'Hitpoints', 'Prayer', 'Woodcutting', 'Mining'] as const;

/** Read base skill levels (falling back to current level, minimum 1) from a session SDK getter. */
export function readSkillLevels(
    getSkill?: (name: string) => { level: number; baseLevel?: number } | null | undefined,
): Record<string, number> {
    const out: Record<string, number> = {};
    for (const name of READ_SKILL_NAMES) {
        const sk = getSkill?.(name);
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
    dragonaxeshop: { requiresQuest: "Heroes' Quest" },
    legendsguildshop: { requiresQuest: "Legends' Quest" },
    generallegends: { requiresQuest: "Legends' Quest" },
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
    1052: { quest: "Legends' Quest" },
};

const EXCLUDED_DEBUG_RE = /^macro_|^xmas_yoyoworn$|^ikov_bootsoflightnessworn$|^death_spikedboots$|^flowers_waterfall|^trollromance_rare_flower$/;
const WOODCUTTING_AXES_DESC = [1359, 1357, 1355, 1361, 1353, 1349, 1351] as const;
const MINING_PICKAXES_DESC = [1275, 1271, 1273, 1269, 1267, 1265] as const;
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
    return g.slot === 'righthand' && /\bstaff\b/i.test(g.name);
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
    acquirableUpgrade: { item: Gear; shops: ShopSource[]; tradeable: boolean } | null;
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
    arrowMinCount?: number;
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
    const arrowMin = options.arrowMinCount ?? 1;

    // For ranged, determine compatible ammo strength so bows outrank un-ammunitioned weapons cleanly.
    const ownedArrows = style === 'ranged'
        ? gearCatalog()
            .filter(g => isStandardArrow(g) && (avail.get(g.id) ?? 0) >= arrowMin && (g.tier ?? 1) <= (skillMap.ranged ?? 1))
            .sort((a, b) => b.bonuses.rangeStrength - a.bonuses.rangeStrength || a.id - b.id)
        : [];
    const maxOwnedArrowForBow = (bow: Gear): Gear | null =>
        ownedArrows.find(a => arrowCompatibility(bow, a)) ?? null;

    const maxArrowStrengthForTier = (tier: number): number => {
        if (tier >= 40) return 49; // Rune arrow
        if (tier >= 30) return 31; // Adamant arrow
        if (tier >= 20) return 22; // Mithril arrow
        if (tier >= 5) return 16;  // Steel arrow
        return 10;                 // Iron arrow
    };

    const scoreOf = (g: Gear, useCatalogArrow: boolean) => {
        if (style === 'ranged' && g.slot === 'righthand') {
            if (isStandardRangedBow(g)) {
                const aStr = useCatalogArrow
                    ? maxArrowStrengthForTier(Math.min(g.tier ?? 1, skillMap.ranged ?? 1))
                    : (maxOwnedArrowForBow(g)?.bonuses.rangeStrength ?? maxArrowStrengthForTier(g.tier ?? 1));
                // Bows have long attack range and sustainable arrow ammo (preferred over short-range thrown consumables unless thrown is owned without a bow).
                return scoreGearForStyle(g, style, aStr) + (useCatalogArrow ? 500 : 300);
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

    let ammo: Gear | null = null;
    if (style === 'ranged') {
        const weapon = worn.weapon;
        if (weapon && isStandardRangedBow(weapon)) {
            ammo = maxOwnedArrowForBow(weapon);
        } else if (weapon && weapon.debugname === 'ogre_bow') {
            ammo = gearCatalog().find(g => g.debugname === 'ogre_arrow' && (avail.get(g.id) ?? 0) >= arrowMin) ?? null;
        } else if (weapon && weapon.debugname.includes('crossbow')) {
            ammo = gearCatalog()
                .filter(g => g.slot === 'quiver' && /\bbolt/i.test(g.name) && (avail.get(g.id) ?? 0) >= arrowMin)
                .sort((a, b) => b.bonuses.rangeStrength - a.bonuses.rangeStrength || a.id - b.id)[0] ?? null;
        }
    }

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

        const acquirableUpgrade = bestWearable && (!current || (bestWearable.id !== current.id && bestScore > currentScore))
            ? { item: bestWearable, shops: [...(shops.get(bestWearable.id) ?? [])], tradeable: bestWearable.tradeable }
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

function selectTool(
    kind: 'woodcutting-axe' | 'mining-pickaxe',
    orderedIdsDesc: readonly number[],
    useSkill: 'woodcutting' | 'mining',
    stock: readonly GearCount[],
    levels?: GearSkillLevels,
    enforceUseLevel = true,
): ToolRecommendation {
    const skillMap = normalizeSkills(levels);
    const owned = stockTotals(stock);
    const shops = shopCatalog();
    const useStat = skillMap[useSkill] ?? 1;
    const attackStat = skillMap.attack ?? 1;

    const candidates: ToolCandidate[] = orderedIdsDesc.flatMap(id => {
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

export function tierBoundaryOf(level: number, tiers: readonly number[] = TIER_BOUNDARIES): number {
    let highest = 1;
    for (const t of tiers) if (level >= t) highest = t;
    return highest;
}

export function crossedTierBoundary(
    previous: GearSkillLevels,
    current: GearSkillLevels,
    skills: readonly string[] = ['attack', 'strength', 'defence'],
    tiers: readonly number[] = TIER_BOUNDARIES,
): boolean {
    const prev = normalizeSkills(previous);
    const curr = normalizeSkills(current);
    return skills.some(s => {
        const key = s.toLowerCase() as GearSkillName;
        return tierBoundaryOf(curr[key] ?? 1, tiers) > tierBoundaryOf(prev[key] ?? 1, tiers);
    });
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

export { ownedLoadout };
