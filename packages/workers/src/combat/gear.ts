import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Bonus, Gear, Skill } from '../../../knowledge/src/gear';
import { canWear, loadGear, sumBonuses } from '../../../knowledge/src/gear-query';
import type { Shop } from '../../../knowledge/src/shops';
import type { SessionCore as Session } from '../contracts';
import { questFlags } from '../../../core/src/quest-status';
import { waitUntil } from '../../../core/src/ticks';
import { countPackItems } from './xp';

export type CombatFocus = 'melee' | 'ranged' | 'magic';
export type LoadoutSlotName = 'weapon' | 'shield' | 'helm' | 'body' | 'legs' | 'amulet' | 'cape' | 'hands' | 'feet';
export type RangedLoadoutSlotName = LoadoutSlotName | 'ammo';
export type GearUnlockKind = CombatFocus | 'woodcutting-axe' | 'mining-pickaxe';
export type GearSkillName = Skill | 'woodcutting' | 'mining' | 'fishing' | 'hitpoints' | 'prayer';
export type GearSkillLevels = Partial<Record<string, number | { level: number; baseLevel?: number } | null | undefined>> | null | undefined;
export type QuestInput =
    | ReadonlySet<string>
    | readonly string[]
    | readonly { name: string; state: string }[]
    | Record<string, boolean | null | undefined>
    | null
    | undefined;

export interface GearCount {
    id: number;
    count: number;
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

export const RANGED_RUN_AMMO = 50;
export const GIANT_RANGED_RELEASE = 40;
export const GIANT_AMMO_RUN = 50;
export const MIN_TRIP_ARROWS = 3;

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
    'weapon',
    'shield',
    'helm',
    'body',
    'legs',
    'amulet',
    'cape',
    'hands',
    'feet',
];

export const ELEMENTAL_STAFF_RUNES: Readonly<Record<number, readonly number[]>> = {
    1381: [556],
    1383: [555],
    1385: [557],
    1387: [554],
    1393: [554],
    1395: [555],
    1397: [556],
    1399: [557],
    1401: [554],
    1403: [555],
    1405: [556],
    1407: [557],
    3053: [554, 557],
    3054: [554, 557],
};

const GOD_ALIGN_BY_ID: Readonly<Record<number, 'saradomin' | 'zamorak' | 'guthix'>> = {
    2412: 'saradomin',
    2413: 'guthix',
    2414: 'zamorak',
    2415: 'saradomin',
    2416: 'guthix',
    2417: 'zamorak',
};

const SHOP_GATES: Readonly<Record<string, Pick<ShopSource, 'requiresQuest' | 'requiresSkill' | 'requiresQuestPoints'>>> = {
    runeplateshop: { requiresQuest: 'Dragon Slayer' },
    dragonswordshop: { requiresQuest: 'Lost City' },
    dragonaxeshop: { requiresQuest: "Hero's Quest" },
    legendsguildshop: { requiresQuest: 'Legends Quest' },
    generallegends: { requiresQuest: 'Legends Quest' },
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

const REV289_REQUIREMENT_FIXES: Readonly<Record<number, { skills?: Partial<Record<Skill, number>>; quest?: string }>> = {
    3749: { skills: { defence: 45 }, quest: 'The Fremennik Trials' },
    3751: { skills: { defence: 45 }, quest: 'The Fremennik Trials' },
    3753: { skills: { defence: 45 }, quest: 'The Fremennik Trials' },
    3755: { skills: { defence: 45 }, quest: 'The Fremennik Trials' },
    3748: { skills: { defence: 30 }, quest: 'The Fremennik Trials' },
    3757: { skills: { attack: 30 }, quest: 'The Fremennik Trials' },
    3758: { skills: { defence: 30 }, quest: 'The Fremennik Trials' },
    3122: { skills: { defence: 50, strength: 50 } },
    1052: { quest: 'Legends Quest' },
};

const EXCLUDED_DEBUG_RE = /^macro_|^xmas_yoyoworn$|^ikov_bootsoflightnessworn$|^death_spikedboots$|^flowers_waterfall|^trollromance_rare_flower$/;
const STANDARD_ARROW_RE = /^(bronze|iron|steel|mithril|adamant|rune)_arrow(_p)?$/;
const STANDARD_BOW_RE = /^(shortbow|longbow|oak_shortbow|oak_longbow|willow_shortbow|willow_longbow|maple_shortbow|maple_longbow|yew_shortbow|yew_longbow|magic_shortbow|magic_longbow)$/;
const ELEMENTAL_STAFF_RE = /^staff_of_(air|water|earth|fire)$|^(air|water|earth|fire|lava)_battlestaff$|^mystic_(air|water|earth|fire|lava)_staff$/;
const ROOT = resolve(import.meta.dir, '../../../..');

interface SkillToolRow {
    id: number;
    wieldAttack?: number | null;
    paramLevelrequire?: number | null;
    woodcuttingLevel?: number | null;
    miningLevel?: number | null;
}

let cachedGear: Gear[] | undefined;
let cachedGearById: Map<number, Gear> | undefined;
let cachedGearByName: Map<string, number> | undefined;
let cachedShopsById: Map<number, ShopSource[]> | undefined;
let cachedSkillTools: { axes: SkillToolRow[]; pickaxes: SkillToolRow[] } | undefined;
const unlockCache = new Map<GearUnlockKind | 'all', Readonly<Partial<Record<GearSkillName, readonly number[]>>>>();

export function skillTools(): { axes: SkillToolRow[]; pickaxes: SkillToolRow[] } {
    return cachedSkillTools ??= JSON.parse(readFileSync(resolve(ROOT, 'knowledge', 'skill-tools.json'), 'utf8')) as {
        axes: SkillToolRow[];
        pickaxes: SkillToolRow[];
    };
}

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

export function gearIdByName(name: string | number): number | undefined {
    if (typeof name === 'number') return gearById(name) ? name : undefined;
    const key = name.trim().toLowerCase().replace(/_/g, ' ');
    if (/^\d+$/.test(key)) return gearById(Number(key)) ? Number(key) : undefined;
    if (!cachedGearByName) {
        cachedGearByName = new Map();
        for (const g of gearCatalog()) {
            for (const k of [g.name.toLowerCase(), g.debugname.toLowerCase().replace(/_/g, ' ')]) {
                if (!cachedGearByName.has(k)) cachedGearByName.set(k, g.id);
            }
        }
    }
    return cachedGearByName.get(key);
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

export function normalizeSkills(levels?: GearSkillLevels): Partial<Record<GearSkillName, number>> {
    const out: Partial<Record<GearSkillName, number>> = {};
    if (!levels) return out;
    for (const [rawKey, rawVal] of Object.entries(levels)) {
        const key = rawKey.toLowerCase() as GearSkillName;
        const n = typeof rawVal === 'number' ? rawVal : rawVal?.baseLevel ?? rawVal?.level;
        if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= 99) {
            out[key] = n;
        }
    }
    return out;
}

function normalizeQuestName(name: string): string {
    const compact = name.toLowerCase().replace(/[_\s']+/g, '');
    if (compact === 'dragonslayer' || compact === 'dragon' || compact === 'dragonquest' || compact === 'questdragon') return 'Dragon Slayer';
    if (compact === 'lostcity' || compact === 'zanaris' || compact === 'questzanaris') return 'Lost City';
    if (compact === 'heroesquest' || compact === 'heroquest' || compact === 'hero' || compact === 'questhero') return "Hero's Quest";
    if (compact === 'legendsquest' || compact === 'thelegendsquest' || compact === 'legends' || compact === 'questlegends') return 'Legends Quest';
    if (compact === 'thefremenniktrials' || compact === 'fremenniktrials' || compact === 'viking' || compact === 'questviking') return 'The Fremennik Trials';
    if (compact === 'regicide' || compact === 'regicidequest' || compact === 'questregicide') return 'Regicide';
    return name.trim();
}

export function normalizeCompletedQuests(quests?: QuestInput): Set<string> {
    const out = new Set<string>();
    if (!quests) return out;
    if (quests instanceof Set) {
        for (const q of quests) if (typeof q === 'string' && q.trim()) out.add(normalizeQuestName(q));
        return out;
    }
    if (Array.isArray(quests)) {
        for (const row of quests) {
            if (typeof row === 'string' && row.trim()) out.add(normalizeQuestName(row));
            else if (row && typeof row === 'object' && row.state === 'complete' && typeof row.name === 'string') {
                out.add(normalizeQuestName(row.name));
            }
        }
        return out;
    }
    for (const [k, v] of Object.entries(quests)) {
        if (v) out.add(normalizeQuestName(k));
    }
    return out;
}

export function readSkillLevels(
    getSkill: (name: string) => { level?: number; baseLevel?: number } | null | undefined,
    names: readonly string[] = ['Attack', 'Strength', 'Defence', 'Ranged', 'Magic', 'Hitpoints', 'Prayer'],
): Record<string, number> {
    const out: Record<string, number> = {};
    for (const n of names) {
        const s = getSkill(n);
        out[n.toLowerCase()] = s?.baseLevel ?? s?.level ?? (n === 'Hitpoints' ? 10 : 1);
    }
    return out;
}

export function canWearGear(item: Gear, levels?: GearSkillLevels, quests?: QuestInput): boolean {
    if (item.staffOnly || EXCLUDED_DEBUG_RE.test(item.debugname)) return false;
    return canWear(item, normalizeSkills(levels) as Partial<Record<Skill, number>>, normalizeCompletedQuests(quests));
}

export function weaponSupportsTrainSkill(item: Gear, trainSkill?: string): boolean {
    if (!trainSkill || item.slot !== 'righthand') return true;
    const target = trainSkill.trim().toLowerCase();
    if (target === 'hitpoints' || target === 'defence' || target === 'ranged' || target === 'magic') return true;
    if (/\bspear\b/i.test(item.name)) return target !== 'attack' && target !== 'strength' && target !== 'all-melee';
    if (/\bhalberd\b/i.test(item.name)) return target !== 'attack' && target !== 'all-melee';
    return true;
}

export function isRangedWeapon(g: Gear): boolean {
    return g.slot === 'righthand' && (
        (g.attackRange !== undefined && g.attackRange >= 3)
        || g.bonuses.rangeAttack > 0
        || g.bonuses.rangeStrength > 0
        || /bow|dart|knife|javelin|thrown/i.test(g.name)
    );
}

export function isMagicWeapon(g: Gear): boolean {
    return g.slot === 'righthand' && /\b(?:staff|battlestaff)\b/i.test(g.name);
}

export function isMeleeWeapon(g: Gear): boolean {
    return g.slot === 'righthand'
        && !isRangedWeapon(g)
        && !isMagicWeapon(g)
        && g.bonuses.strength >= 0
        && Math.max(g.bonuses.stabAttack, g.bonuses.slashAttack, g.bonuses.crushAttack) >= 0;
}

export function isStandardRangedBow(g: Gear): boolean {
    return g.slot === 'righthand' && STANDARD_BOW_RE.test(g.debugname);
}

export function isStandardArrow(g: Gear): boolean {
    return g.slot === 'quiver' && STANDARD_ARROW_RE.test(g.debugname);
}

export function isThrownWeapon(g: Gear): boolean {
    return g.slot === 'righthand' && g.bonuses.rangeStrength > 0 && !/bow/.test(g.debugname);
}

export function meleeDefenceMean(b: Record<Bonus, number>): number {
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
        const def = meleeDefenceMean(b) * 1.5 + b.rangeDefence * 0.25;
        return b.strength * 20 + atk * 10 + b.prayer * 4 + def;
    }
    if (style === 'ranged') {
        const avgDef = (meleeDefenceMean(b) * 3 + b.magicDefence + b.rangeDefence) / 5;
        return b.rangeAttack * 20 + b.rangeStrength * 15 + b.prayer * 4 + avgDef;
    }
    const avgDef = (meleeDefenceMean(b) * 3 + b.rangeDefence) / 10;
    return b.magicAttack * 20 + b.magicDefence * 4 + b.prayer * 4 + avgDef;
}

export function tieOrder(a: Gear, b: Gear, style: CombatFocus): number {
    if (style === 'melee' && a.slot === 'righthand') {
        const oneHandDiff = Number(a.covers.includes('lefthand')) - Number(b.covers.includes('lefthand'));
        if (oneHandDiff !== 0) return oneHandDiff;
        const strDiff = b.bonuses.strength - a.bonuses.strength;
        if (strDiff !== 0) return strDiff;
    }
    if (/^Amulet of glory/i.test(a.name) && /^Amulet of glory/i.test(b.name)) {
        return b.id - a.id;
    }
    return a.id - b.id;
}

export function standardBowTiers(): { level: number; ids: number[] }[] {
    const byLevel = new Map<number, Gear[]>();
    for (const g of gearCatalog()) {
        if (!isStandardRangedBow(g)) continue;
        const level = g.requires.skills.ranged ?? 1;
        byLevel.set(level, [...(byLevel.get(level) ?? []), g]);
    }
    return [...byLevel]
        .sort((a, b) => b[0] - a[0])
        .map(([level, bows]) => ({
            level,
            ids: bows.sort((a, b) => (a.attackRate ?? 4) - (b.attackRate ?? 4) || a.id - b.id).map(g => g.id),
        }));
}

export function standardArrowTiers(): { level: number; id: number; strength: number }[] {
    return gearCatalog()
        .filter(g => isStandardArrow(g) && !g.debugname.endsWith('_p'))
        .sort((a, b) => b.bonuses.rangeStrength - a.bonuses.rangeStrength || a.id - b.id)
        .map(g => ({ level: g.tier ?? 1, id: g.id, strength: g.bonuses.rangeStrength }));
}

function unreservedCounts(stock: readonly GearCount[], reserved: readonly GearCount[] = []): Map<number, number> {
    const avail = new Map<number, number>();
    for (const row of stock) {
        if (row.count > 0) avail.set(row.id, (avail.get(row.id) ?? 0) + row.count);
    }
    for (const r of reserved) avail.set(r.id, Math.max(0, (avail.get(r.id) ?? 0) - r.count));
    return avail;
}

function arrowCompatibility(bow: Gear | null, arrow: Gear): boolean {
    if (!bow) return isStandardArrow(arrow);
    if (bow.debugname === 'ogre_bow') return arrow.debugname === 'ogre_arrow';
    if (bow.debugname.includes('crossbow')) return /\bbolt/i.test(arrow.name);
    if (isStandardRangedBow(bow)) return isStandardArrow(arrow) && (arrow.tier ?? 1) <= (bow.tier ?? 1);
    return false;
}

export interface CombatLoadout {
    style: CombatFocus;
    worn: Record<LoadoutSlotName, Gear | null>;
    ammo: Gear | null;
    thrown: boolean;
    ammoCount: number;
    items: { slot: RangedLoadoutSlotName; wearpos: number; item: Gear }[];
    bonuses: Record<Bonus, number>;
}

export interface CombatLoadoutOptions {
    reserved?: readonly GearCount[];
    trainSkill?: string;
    requireWeapon?: boolean;
    requireShield?: boolean;
    oneHanded?: boolean;
    minWeaponStrength?: number;
    minShieldDefence?: number;
    arrowMinCount?: number;
    thrown?: boolean;
    godAlign?: 'saradomin' | 'zamorak' | 'guthix';
}

export function selectCombatLoadout(
    style: CombatFocus,
    stock: readonly GearCount[],
    levels?: GearSkillLevels,
    quests?: QuestInput,
    options: CombatLoadoutOptions = {},
): CombatLoadout {
    const avail = unreservedCounts(stock, options.reserved);
    const skillMap = normalizeSkills(levels);
    const done = normalizeCompletedQuests(quests);
    const arrowMin = options.arrowMinCount ?? RANGED_RUN_AMMO;
    const have = (g: Gear) => avail.get(g.id) ?? 0;

    const ammoCandidates = (bow: Gear | null): { arrow: Gear; count: number }[] => {
        if (style !== 'ranged') return [];
        const usable = gearCatalog()
            .filter(g => g.slot === 'quiver' && arrowCompatibility(bow, g) && (g.tier ?? 1) <= (skillMap.ranged ?? 1) && have(g) > 0)
            .map(arrow => ({ arrow, count: have(arrow) }))
            .sort((a, b) => scoreGearForStyle(b.arrow, 'ranged') - scoreGearForStyle(a.arrow, 'ranged') || a.arrow.id - b.arrow.id);
        return usable;
    };

    const ammoFor = (bow: Gear | null): Gear | null => {
        const list = ammoCandidates(bow);
        return (list.find(a => a.count >= arrowMin) ?? [...list].sort((a, b) => b.count - a.count)[0])?.arrow ?? null;
    };

    const slotCandidates = (slot: LoadoutSlotName): Gear[] => {
        const wearSlot = GEAR_KEY_BY_SLOT[slot];
        return gearCatalog()
            .filter(g => {
                if (g.slot !== wearSlot) return false;
                if (!canWearGear(g, skillMap, done)) return false;
                if (slot === 'weapon') {
                    if (!weaponSupportsTrainSkill(g, options.trainSkill)) return false;
                    if (options.oneHanded && g.covers.includes('lefthand')) return false;
                    if (style === 'ranged' && options.thrown === false && isThrownWeapon(g)) return false;
                    if (options.minWeaponStrength !== undefined && g.bonuses.strength < options.minWeaponStrength) return false;
                }
                if (slot === 'shield' && options.minShieldDefence !== undefined && meleeDefenceMean(g.bonuses) < options.minShieldDefence) {
                    return false;
                }
                if (slot === 'cape' && options.godAlign) {
                    const cg = GOD_ALIGN_BY_ID[g.id];
                    if (cg && cg !== options.godAlign) return false;
                }
                const sc = scoreGearForStyle(g, style, style === 'ranged' && g.slot === 'righthand' ? (ammoFor(g)?.bonuses.rangeStrength ?? 0) : 0);
                if (sc <= -1e8) return false;
                if (slot !== 'weapon' && sc <= 0) return false;
                return have(g) > 0;
            })
            .sort((a, b) => {
                const as = scoreGearForStyle(a, style, style === 'ranged' && a.slot === 'righthand' ? (ammoFor(a)?.bonuses.rangeStrength ?? 0) : 0);
                const bs = scoreGearForStyle(b, style, style === 'ranged' && b.slot === 'righthand' ? (ammoFor(b)?.bonuses.rangeStrength ?? 0) : 0);
                return bs - as || tieOrder(a, b, style);
            });
    };

    const weapons = slotCandidates('weapon');
    const shields = slotCandidates('shield');
    const oneHandedWeapon = weapons.find(w => !w.covers.includes('lefthand')) ?? null;
    const twoHandedWeapon = options.requireShield ? null : (weapons.find(w => w.covers.includes('lefthand')) ?? null);
    const topShield = shields[0] ?? null;

    const scoreW = (w: Gear | null) =>
        w ? scoreGearForStyle(w, style, style === 'ranged' ? (ammoFor(w)?.bonuses.rangeStrength ?? 0) : 0) : -1e9;
    const scoreS = (s: Gear | null) => (s ? scoreGearForStyle(s, style) : 0);

    let chosenWeapon: Gear | null = null;
    let chosenShield: Gear | null = null;

    const pair1hScore = oneHandedWeapon ? scoreW(oneHandedWeapon) + scoreS(topShield) : -Infinity;
    const solo2hScore = twoHandedWeapon ? scoreW(twoHandedWeapon) : -Infinity;
    if (pair1hScore >= solo2hScore && oneHandedWeapon) {
        chosenWeapon = oneHandedWeapon;
        chosenShield = topShield;
    } else if (twoHandedWeapon) {
        chosenWeapon = twoHandedWeapon;
        chosenShield = null;
    } else if (!options.requireWeapon) {
        chosenShield = topShield;
    }

    const worn = Object.fromEntries(LOADOUT_SLOTS.map(s => [s, null])) as Record<LoadoutSlotName, Gear | null>;
    worn.weapon = chosenWeapon;
    worn.shield = chosenShield;
    for (const slot of LOADOUT_SLOTS) {
        if (slot === 'weapon' || slot === 'shield') continue;
        const cands = slotCandidates(slot);
        if (slot === 'cape' && style === 'magic' && chosenWeapon) {
            const wGod = GOD_ALIGN_BY_ID[chosenWeapon.id];
            worn[slot] = cands.find(c => !wGod || !GOD_ALIGN_BY_ID[c.id] || GOD_ALIGN_BY_ID[c.id] === wGod) ?? null;
        } else {
            worn[slot] = cands[0] ?? null;
        }
    }

    const thrown = style === 'ranged' && !!worn.weapon && isThrownWeapon(worn.weapon);
    const ammo = style === 'ranged' && worn.weapon && !thrown ? ammoFor(worn.weapon) : null;
    const ammoCount = style === 'ranged' && worn.weapon ? (thrown ? have(worn.weapon) : ammo ? have(ammo) : 0) : 0;

    const items: { slot: RangedLoadoutSlotName; wearpos: number; item: Gear }[] = [];
    for (const slot of LOADOUT_SLOTS) {
        const item = worn[slot];
        if (item) items.push({ slot, wearpos: WEARPOS_BY_SLOT[slot], item });
    }
    if (ammo) items.push({ slot: 'ammo', wearpos: WEARPOS_BY_SLOT.ammo, item: ammo });

    return {
        style,
        worn,
        ammo,
        thrown,
        ammoCount,
        items,
        bonuses: sumBonuses(items.map(i => i.item)),
    };
}

function rankedElementalStaves(
    levels?: GearSkillLevels,
    quests?: QuestInput,
    runeIds: readonly number[] = [],
    members = true,
) {
    const runeWeights = new Map<number, number>();
    runeIds.forEach((id, idx) => {
        runeWeights.set(id, (runeWeights.get(id) ?? 0) + 1 + (runeIds.length - idx) * 1e-4);
    });
    const score = (id: number) => {
        const provided = ELEMENTAL_STAFF_RUNES[id] ?? [];
        return runeIds.length > 0 ? provided.reduce((sum, r) => sum + (runeWeights.get(r) ?? 0), 0) : provided.length;
    };
    return gearCatalog()
        .filter(g => {
            const provided = ELEMENTAL_STAFF_RUNES[g.id];
            if (g.slot !== 'righthand' || !provided || (!members && g.members) || !canWearGear(g, levels, quests)) return false;
            return runeIds.length === 0 || provided.some(r => runeWeights.has(r));
        })
        .sort((a, b) => score(b.id) - score(a.id) || scoreGearForStyle(b, 'magic') - scoreGearForStyle(a, 'magic') || a.id - b.id);
}

export function bestElementalStaffForRunes(
    stock: readonly GearCount[],
    levels?: GearSkillLevels,
    quests?: QuestInput,
    runeIds: readonly number[] = [],
    members = true,
): Gear | null {
    const owned = new Set(stock.filter(s => s.count > 0).map(s => s.id));
    return rankedElementalStaves(levels, quests, runeIds, members).find(g => owned.has(g.id)) ?? null;
}

export function planMagicStaffShopUpgrade(
    stock: readonly GearCount[],
    coins: number,
    levels?: GearSkillLevels,
    options: { runeIds?: readonly number[]; members?: boolean; allowedShops?: readonly string[]; priceBufferRatio?: number; coinReserve?: number } = {},
): { target: Gear; shop: ShopSource; price: number; coinBudgetNeeded: number } | null {
    const owned = new Set(stock.filter(s => s.count > 0).map(s => s.id));
    const usable = rankedElementalStaves(levels, [], options.runeIds ?? [], options.members ?? true);
    if (usable.some(g => owned.has(g.id))) return null;
    const shops = shopCatalog();
    const allowed = options.allowedShops ? new Set(options.allowedShops) : null;
    const ratio = options.priceBufferRatio ?? 1.25;
    const reserve = Math.max(0, options.coinReserve ?? 0);
    for (const candidate of usable) {
        const entries = (shops.get(candidate.id) ?? [])
            .filter(s => !allowed || allowed.has(s.shop))
            .sort((a, b) => a.cost - b.cost);
        for (const shop of entries) {
            const coinBudgetNeeded = Math.ceil(shop.cost * ratio) + reserve;
            if (coins >= coinBudgetNeeded) {
                return { target: candidate, shop, price: shop.cost, coinBudgetNeeded };
            }
        }
    }
    return null;
}

export function ownsWearableMeleeWeapon(
    owned: Readonly<Record<string, number>> | readonly GearCount[],
    levels?: GearSkillLevels,
    quests?: QuestInput,
    trainSkill?: string,
): boolean {
    const rows: GearCount[] = Array.isArray(owned)
        ? [...(owned as readonly GearCount[])]
        : Object.entries(owned as Record<string, number>).flatMap(([key, count]) => {
            const id = gearIdByName(key);
            return id === undefined || !(count > 0) ? [] : [{ id, count }];
        });
    const loadout = selectCombatLoadout('melee', rows, levels, quests, {
        trainSkill: trainSkill ?? 'all-melee',
        requireWeapon: true,
    });
    return loadout.worn.weapon !== null;
}

export function selectFireWeapon(
    stock: ReadonlyMap<number, number>,
    attack: number | null = 99,
    reserved: ReadonlyMap<number, number> = new Map(),
): number {
    if (attack === null || !Number.isSafeInteger(attack) || attack < 1 || attack > 99) return 0;
    const rows: GearCount[] = [...stock].map(([id, count]) => ({ id, count }));
    const res: GearCount[] = [...reserved].map(([id, count]) => ({ id, count }));
    const loadout = selectCombatLoadout(
        'melee',
        rows,
        { Attack: attack },
        null,
        { reserved: res, oneHanded: true, trainSkill: 'Attack', requireWeapon: true },
    );
    return loadout.worn.weapon?.id ?? 0;
}

const GIANT_ARMOUR_SLOT_ORDER = [2, 10, 0, 4, 7, 5, 1, 9] as const;

export function selectGiantWeapon(
    stock: readonly GearCount[],
    attack: number | null,
    completedQuests: QuestInput = null,
    strength?: number,
    trainSkill?: string,
): number {
    if (attack === null || !Number.isSafeInteger(attack) || attack < 1 || attack > 99) return 0;
    const loadout = selectCombatLoadout(
        'melee',
        stock,
        { Attack: attack, Strength: strength ?? attack },
        completedQuests,
        { trainSkill: trainSkill ?? 'all-melee' },
    );
    return loadout.worn.weapon?.id ?? 0;
}

export function selectGiantArmour(
    stock: readonly GearCount[],
    defence: number,
    completedQuests: QuestInput = null,
    levels?: GearSkillLevels,
): { slot: number; id: number }[] {
    if (!Number.isSafeInteger(defence) || defence < 1 || defence > 99) return [];
    const armourStock = stock.filter(row => gearById(row.id)?.slot !== 'righthand');
    const skillMap: Record<string, number> = { Attack: 1, Strength: 1, Defence: defence, ...normalizeSkills(levels) };
    skillMap.defence = defence;
    const loadout = selectCombatLoadout('melee', armourStock, skillMap, completedQuests);
    const order = new Map<number, number>(GIANT_ARMOUR_SLOT_ORDER.map((slot, idx) => [slot, idx]));
    return loadout.items
        .filter(entry => entry.slot !== 'weapon')
        .map(entry => ({ slot: entry.wearpos, id: entry.item.id }))
        .sort((a, b) => (order.get(a.slot) ?? 99) - (order.get(b.slot) ?? 99));
}

export const GIANT_BOWS: readonly { level: number; ids: readonly number[] }[] = standardBowTiers();
export const GIANT_ARROWS: readonly { level: number; id: number }[] = standardArrowTiers().map(({ level, id }) => ({ level, id }));

export function selectGiantBow(stock: readonly GearCount[], ranged: number) {
    for (const tier of GIANT_BOWS) {
        if (tier.level <= ranged) {
            for (const id of tier.ids) {
                if (countPackItems(stock, id) > 0) return { id, level: tier.level };
            }
        }
    }
    return undefined;
}

export function selectGiantArrows(stock: readonly GearCount[], ranged: number, bowLevel: number): number | undefined {
    const fires = GIANT_ARROWS.filter(a => a.level <= Math.min(ranged, bowLevel) && countPackItems(stock, a.id) > 0);
    return (
        fires.find(a => countPackItems(stock, a.id) >= GIANT_AMMO_RUN)
        ?? [...fires].sort((a, b) => countPackItems(stock, b.id) - countPackItems(stock, a.id))[0]
    )?.id;
}

export function selectedGiantRangedKit(
    stock: readonly GearCount[],
    ranged: number,
    selected?: { bow: number; arrow: number },
) {
    if (!selected) {
        const bow = selectGiantBow(stock, ranged);
        return bow ? { bow, arrow: selectGiantArrows(stock, ranged, bow.level) } : undefined;
    }
    const tier = GIANT_BOWS.find(t => (t.ids as readonly number[]).includes(selected.bow));
    const arrow = GIANT_ARROWS.find(a => a.id === selected.arrow);
    if (
        !Number.isSafeInteger(ranged) || ranged < 1 || ranged > 99
        || !tier || tier.level > ranged || countPackItems(stock, selected.bow) < 1
        || !arrow || arrow.level > Math.min(ranged, tier.level) || countPackItems(stock, selected.arrow) < 1
    ) {
        throw Error('giant prerequisite: selected Ranged kit is not owned, usable and compatible');
    }
    return { bow: { id: selected.bow, level: tier.level }, arrow: selected.arrow };
}

export const BOWS = [...standardBowTiers()].reverse().flatMap(t =>
    t.ids.map(id => ({ id, req: t.level, name: gearById(id)?.name ?? String(id) })),
);
export const ARROWS: readonly { id: number; req: number; name: string }[] = standardArrowTiers()
    .sort((x, y) => x.id - y.id)
    .map(t => ({ id: t.id, req: t.level, name: gearById(t.id)?.name ?? String(t.id) }));
export const LOWE_ARROWS: readonly number[] = ARROWS.filter(a => shopCatalog().get(a.id)?.some(s => s.shop === 'archeryshop')).map(a => a.id);

export function bestBow(owned: readonly GearCount[], ranged: number) {
    return BOWS
        .filter(b => b.req <= ranged && countPackItems(owned, b.id) > 0)
        .reduce<(typeof BOWS)[number] | undefined>((best, b) => (!best || b.req > best.req ? b : best), undefined);
}

export const usableArrows = (bowReq: number, ranged: number): number[] =>
    ARROWS.filter(a => a.req <= bowReq && a.req <= ranged).map(a => a.id);

export function chooseArrow(owned: readonly GearCount[], bowReq: number, ranged: number, min = MIN_TRIP_ARROWS) {
    return usableArrows(bowReq, ranged)
        .map(id => ({ id, count: countPackItems(owned, id) }))
        .filter(a => a.count >= min)
        .sort((a, b) => b.id - a.id)[0];
}

export function gearUnlockLevels(kind: CombatFocus): Readonly<Partial<Record<GearSkillName, readonly number[]>>> {
    const cached = unlockCache.get(kind);
    if (cached) return cached;
    const sets = new Map<GearSkillName, Set<number>>();
    const add = (skill: GearSkillName, level: number | null | undefined) => {
        if (typeof level !== 'number' || !Number.isSafeInteger(level) || level <= 1 || level > 99) return;
        const set = sets.get(skill) ?? new Set<number>();
        set.add(level);
        sets.set(skill, set);
    };
    for (const g of gearCatalog()) {
        if (g.slot === 'quiver') {
            if (kind === 'ranged' && isStandardArrow(g)) add('ranged', g.tier);
            continue;
        }
        const sc = scoreGearForStyle(g, kind);
        if (g.slot === 'righthand' ? sc <= -1e8 : sc <= 0) continue;
        for (const [skill, level] of Object.entries(g.requires.skills)) add(skill as GearSkillName, level);
    }
    const out: Partial<Record<GearSkillName, readonly number[]>> = {};
    for (const [skill, set] of sets) out[skill] = [...set].sort((a, b) => a - b);
    unlockCache.set(kind, out);
    return out;
}

export function tierBoundaryOf(level: number, tiers: readonly number[]): number {
    let highest = 1;
    for (const t of tiers) if (level >= t) highest = t;
    return highest;
}

export function crossedTierBoundary(
    previous: GearSkillLevels,
    current: GearSkillLevels,
    skills: readonly string[] = ['attack', 'strength', 'defence'],
    kind: CombatFocus = 'melee',
): boolean {
    const prev = normalizeSkills(previous);
    const curr = normalizeSkills(current);
    const bySkill = gearUnlockLevels(kind);
    return skills.some(s => {
        const key = s.toLowerCase() as GearSkillName;
        const levels = bySkill[key] ?? [];
        return tierBoundaryOf(curr[key] ?? 1, levels) > tierBoundaryOf(prev[key] ?? 1, levels);
    });
}

const STYLE_SKILLS: Readonly<Record<CombatFocus, readonly string[]>> = {
    melee: ['attack', 'defence'],
    ranged: ['ranged', 'defence'],
    magic: ['magic', 'defence'],
};

export function gearLevelWatch(s: Pick<Session, 'sdk'>, kind: CombatFocus, skills: readonly string[] = STYLE_SKILLS[kind]) {
    const read = () => readSkillLevels(n => s.sdk.getSkill(n));
    const synced = () => skills.every(n => !!s.sdk.getSkill(n.charAt(0).toUpperCase() + n.slice(1)));
    let previous = synced() ? read() : undefined;
    return {
        crossed() {
            if (!synced()) return false;
            const now = read();
            if (!previous) {
                previous = now;
                return false;
            }
            const hit = crossedTierBoundary(previous, now, skills, kind);
            previous = now;
            return hit;
        },
    };
}

export type GearTarget = { slot: RangedLoadoutSlotName; wearpos: number; id: number; stack: boolean };

export interface ReconcileCombatOptions {
    style: CombatFocus;
    trainSkill?: string;
    bankOpen?: boolean;
    stop?: () => boolean;
    ammo?: number;
    ammoMin?: number;
    thrown?: boolean;
    pin?: { weapon?: number; ammo?: number };
    only?: readonly RangedLoadoutSlotName[];
    runeIds?: readonly number[];
    levels?: GearSkillLevels;
    quests?: QuestInput;
    loadout?: Pick<CombatLoadoutOptions, 'requireWeapon' | 'requireShield' | 'minWeaponStrength' | 'minShieldDefence' | 'reserved' | 'godAlign'>;
    strict?: boolean;
    label?: string;
    leaveBankOpen?: boolean;
    openBank?: () => Promise<void>;
    closeBank?: () => Promise<unknown>;
    bankItems?: readonly GearCount[];
}

export interface ReconcileCombatResult {
    loadout: CombatLoadout;
    targets: GearTarget[];
    worn: number[];
    displaced: number[];
    deposited: number[];
    pending: number[];
    weaponChanged: boolean;
    ammo: { id: number; wearpos: number } | null;
    bankBetter: boolean;
}

export async function reconcileCombatLoadout(s: Session, o: ReconcileCombatOptions): Promise<ReconcileCombatResult> {
    const label = o.label ?? 'gear';
    const stop = () => !!o.stop?.();
    const state = () => s.sdk.getState();
    const inv = () => s.sdk.getInventory();
    const eq = () => s.sdk.getEquipment();
    const held = (id: number) => countPackItems(inv(), id);
    const kit = (): GearCount[] => [...inv(), ...eq()].map(i => ({ id: i.id, count: i.count }));
    const bankNow = (): GearCount[] | undefined => {
        const open = state()?.bank?.isOpen ? (s.bankObservation?.()?.items ?? state()?.bank?.items) : undefined;
        return open?.map((i: { id: number; count: number }) => ({ id: i.id, count: i.count }));
    };
    const fail = (text: string) => {
        if (o.strict) throw Error(text);
        return false;
    };
    const levels = () => o.levels ?? readSkillLevels(n => s.sdk.getSkill(n));
    const quests = () => o.quests ?? (s.client ? questFlags(s.client) : null);

    const choose = (stock: readonly GearCount[]) => {
        const loadout = selectCombatLoadout(o.style, stock, levels(), quests(), {
            ...o.loadout,
            trainSkill: o.trainSkill,
            thrown: o.thrown,
            ...(o.ammoMin === undefined ? {} : { arrowMinCount: o.ammoMin }),
        });
        const pin = { ...o.pin };
        if (o.style === 'magic' && o.runeIds?.length && pin.weapon === undefined) {
            const staff = bestElementalStaffForRunes(stock, levels(), quests(), o.runeIds);
            if (staff) pin.weapon = staff.id;
        }
        const rawTargets: GearTarget[] = loadout.items
            .map(entry => ({
                slot: entry.slot,
                wearpos: entry.wearpos,
                id: entry.item.id,
                stack: entry.slot === 'ammo' || (entry.slot === 'weapon' && loadout.thrown),
            }))
            .filter(t => !o.only || o.only.includes(t.slot));
        if (pin.weapon !== undefined) {
            const existing = rawTargets.find(t => t.slot === 'weapon');
            if (existing) existing.id = pin.weapon;
            else if (!o.only || o.only.includes('weapon')) {
                rawTargets.push({ slot: 'weapon', wearpos: WEARPOS_BY_SLOT.weapon, id: pin.weapon, stack: false });
            }
        }
        if (pin.ammo !== undefined) {
            const existing = rawTargets.find(t => t.slot === 'ammo');
            if (existing) existing.id = pin.ammo;
            else if (!o.only || o.only.includes('ammo')) {
                rawTargets.push({ slot: 'ammo', wearpos: WEARPOS_BY_SLOT.ammo, id: pin.ammo, stack: true });
            }
        }
        return { loadout, targets: rawTargets };
    };

    const wornCount = (t: GearTarget) => countPackItems(eq(), t.id);
    const owns = (t: GearTarget) => wornCount(t) > 0 || held(t.id) > 0;
    const worn: number[] = [];
    const deposited: number[] = [];

    const equip = async (t: GearTarget) => {
        const item = inv().find(i => i.id === t.id);
        if (!item) return wornCount(t) > 0 || fail(`${label} equip failed ${t.id}: no held item and not equipped`);
        const before = wornCount(t);
        const result = await s.bot.equipItem(item);
        const seen = await waitUntil(s, () => wornCount(t) > before || stop(), { timeoutTicks: 10 });
        if (!seen || wornCount(t) <= before) {
            return fail(`${label} equip failed ${t.id}: ${result.message ?? 'no SDK message'}; equipped item not observed`);
        }
        worn.push(t.id);
        return true;
    };

    const wear = async (targets: readonly GearTarget[], later = false) => {
        for (const t of targets) {
            if (stop()) return;
            if (later && wornCount(t) < 1 && held(t.id) < 1) continue;
            if (t.stack ? held(t.id) < 1 : wornCount(t) > 0) continue;
            await equip(t);
        }
    };

    const openBank = o.openBank ?? (async () => {
        if (state()?.bank?.isOpen && s.bankObservation?.()) return;
        const generation = s.bankObservation?.()?.generation ?? 0;
        if (!(await s.bot.openBank()).success || !(await waitUntil(s, () => !!state()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > generation, { timeoutTicks: 20 }))) {
            throw Error(`${label}: bank readiness unknown`);
        }
    });
    const closeBank = o.closeBank ?? (() => s.bot.closeBank());
    const bankCount = (id: number) => countPackItems(bankNow() ?? [], id);
    const withdraw = async (id: number, amount: number) => {
        const row = state()?.bank?.items.find((i: { id: number }) => i.id === id);
        const before = held(id);
        if (
            !row
            || !(await s.bot.withdrawItem(row, amount, { asNote: false })).success
            || !(await waitUntil(s, () => held(id) >= before + amount || stop(), { timeoutTicks: 10 }))
            || held(id) < before + amount
        ) {
            return fail(`${label} withdraw failed ${id}`);
        }
        return true;
    };

    const weaponBefore = eq().find(i => i.slot === 3)?.id;
    const wornBefore = eq().map(i => ({ id: i.id, count: i.count, slot: i.slot }));
    let chosen = choose(o.bankOpen ? [...(bankNow() ?? []), ...kit()] : kit());

    if (o.bankOpen) {
        for (let pass = 0; pass < 3 && !stop(); pass++) {
            if (!state()?.bank?.isOpen) await openBank();
            chosen = choose([...(bankNow() ?? []), ...kit()]);
            let more = false;
            for (const t of chosen.targets) {
                if (stop()) break;
                if (t.stack) {
                    const take = Math.min((o.ammo ?? 0) - wornCount(t) - held(t.id), bankCount(t.id));
                    if (take > 0 && (inv().length < 28 || held(t.id) > 0)) await withdraw(t.id, take);
                    continue;
                }
                if (owns(t)) continue;
                if (inv().length >= 28) {
                    more = true;
                    continue;
                }
                await withdraw(t.id, 1);
            }
            const before = eq().map(i => i.id);
            const needWear = chosen.targets.some(t => (t.stack ? held(t.id) > 0 : wornCount(t) < 1 && held(t.id) > 0));
            if (!needWear && !more) break;
            await closeBank();
            if (stop()) break;
            await wear(chosen.targets, more);
            const replaced = [...new Set(before)].filter(id => !eq().some(i => i.id === id) && held(id) > 0);
            if (!replaced.length && !more) break;
            await openBank();
            for (const id of replaced) {
                const item = inv().find(i => i.id === id);
                if (!item) continue;
                const stored = bankCount(id);
                const stack = wornBefore.some(i => i.id === id && (i.slot === 13 || i.count > 1));
                const amount = stack ? held(id) : 1;
                if (!(await s.bot.depositItem(item, stack ? -1 : 1)).success || !(await waitUntil(s, () => bankCount(id) >= stored + amount || stop(), { timeoutTicks: 10 }))) {
                    fail(`${label}: replaced gear deposit failed (${id})`);
                    continue;
                }
                deposited.push(id);
            }
            if (!more) break;
        }
        for (const t of chosen.targets) if (!t.stack && !stop() && !owns(t)) fail(`${label} equip failed ${t.id}: no held item and not equipped`);
        if (state()?.bank?.isOpen && !o.leaveBankOpen) await closeBank();
        else if (!state()?.bank?.isOpen && o.leaveBankOpen && !stop()) await openBank();
    } else {
        await wear(chosen.targets);
    }

    const known = o.bankOpen ? undefined : o.bankItems;
    const full = known ? choose([...known, ...kit()]) : chosen;
    const bankBetter = !!known && full.targets.some(t => !t.stack && !owns(t) && countPackItems(known, t.id) > 0);
    const ammoTarget = chosen.targets.find(t => t.stack);
    return {
        loadout: chosen.loadout,
        targets: chosen.targets,
        worn,
        displaced: [...new Set(wornBefore.map(i => i.id))].filter(id => !eq().some(i => i.id === id) && held(id) > 0),
        deposited,
        pending: chosen.targets.filter(t => wornCount(t) < 1).map(t => t.id),
        weaponChanged: eq().find(i => i.slot === 3)?.id !== weaponBefore,
        ammo: ammoTarget ? { id: ammoTarget.id, wearpos: ammoTarget.wearpos } : null,
        bankBetter,
    };
}
