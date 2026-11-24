import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BONUSES, type Bonus, type Gear, type Skill } from '../../../knowledge/src/gear';
import { canWear, loadGear } from '../../../knowledge/src/gear-query';
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
const DIGITS_ONLY_RE = /^\d+$/;
const SPEAR_RE = /\bspear\b/i;
const HALBERD_RE = /\bhalberd\b/i;
const RANGED_NAME_RE = /bow|dart|knife|javelin|thrown/i;
const STAFF_NAME_RE = /\b(?:staff|battlestaff)\b/i;
const GLORY_NAME_RE = /^Amulet of glory/i;
const BOLT_NAME_RE = /\bbolt/i;
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
let cachedElementalStaves: Gear[] | undefined;
let cachedShopsById: Map<number, ShopSource[]> | undefined;
let cachedSkillTools: { axes: SkillToolRow[]; pickaxes: SkillToolRow[] } | undefined;
const unlockCache = new Map<GearUnlockKind | 'all', Readonly<Partial<Record<GearSkillName, readonly number[]>>>>();

function lazyArray<T>(build: () => readonly T[]): readonly T[] {
    let resolved: readonly T[] | undefined;
    const ensure = () => (resolved ??= build());
    return new Proxy([] as T[], {
        get(_t, prop, receiver) {
            const arr = ensure();
            const val = Reflect.get(arr, prop, arr);
            return typeof val === 'function' ? val.bind(arr) : val;
        },
        has(_t, prop) {
            return prop in ensure();
        },
        ownKeys() {
            return Reflect.ownKeys(ensure());
        },
        getOwnPropertyDescriptor(_t, prop) {
            const desc = Reflect.getOwnPropertyDescriptor(ensure(), prop);
            if (!desc) return undefined;
            if (prop === 'length') return desc;
            return { ...desc, configurable: true };
        },
    });
}

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
    const trimmed = name.trim().toLowerCase();
    const key = trimmed.includes('_') ? trimmed.replace(/_/g, ' ') : trimmed;
    if (DIGITS_ONLY_RE.test(key)) {
        const id = Number(key);
        return gearById(id) ? id : undefined;
    }
    if (!cachedGearByName) {
        cachedGearByName = new Map();
        for (const g of gearCatalog()) {
            const lowerName = g.name.toLowerCase();
            if (!cachedGearByName.has(lowerName)) cachedGearByName.set(lowerName, g.id);
            const lowerDebug = g.debugname.toLowerCase().replace(/_/g, ' ');
            if (!cachedGearByName.has(lowerDebug)) cachedGearByName.set(lowerDebug, g.id);
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

function canWearPrepared(item: Gear, levels: Partial<Record<Skill, number>>, quests: ReadonlySet<string>): boolean {
    return !item.staffOnly && !EXCLUDED_DEBUG_RE.test(item.debugname) && canWear(item, levels, quests);
}

export function canWearGear(item: Gear, levels?: GearSkillLevels, quests?: QuestInput): boolean {
    if (item.staffOnly || EXCLUDED_DEBUG_RE.test(item.debugname)) return false;
    return canWear(item, normalizeSkills(levels) as Partial<Record<Skill, number>>, normalizeCompletedQuests(quests));
}

export function weaponSupportsTrainSkill(item: Gear, trainSkill?: string): boolean {
    if (!trainSkill || item.slot !== 'righthand') return true;
    const target = trainSkill.trim().toLowerCase();
    if (target === 'hitpoints' || target === 'defence' || target === 'ranged' || target === 'magic') return true;
    if (SPEAR_RE.test(item.name)) return target !== 'attack' && target !== 'strength' && target !== 'all-melee';
    if (HALBERD_RE.test(item.name)) return target !== 'attack' && target !== 'all-melee';
    return true;
}

export function isRangedWeapon(g: Gear): boolean {
    return g.slot === 'righthand' && (
        (g.attackRange !== undefined && g.attackRange >= 3)
        || g.bonuses.rangeAttack > 0
        || g.bonuses.rangeStrength > 0
        || RANGED_NAME_RE.test(g.name)
    );
}

export function isMagicWeapon(g: Gear): boolean {
    return g.slot === 'righthand' && STAFF_NAME_RE.test(g.name);
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
    if (GLORY_NAME_RE.test(a.name) && GLORY_NAME_RE.test(b.name)) {
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
    if (bow.debugname.includes('crossbow')) return BOLT_NAME_RE.test(arrow.name);
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
    gearCatalog();
    const byId = cachedGearById!;
    const canWearLevels = skillMap as Partial<Record<Skill, number>>;
    const rangedSkill = skillMap.ranged ?? 1;

    // Bucket owned positive-count gear by wear slot once instead of rescanning the full catalog per slot.
    const ownedBySlot = new Map<string, Gear[]>();
    const ownedQuivers: { arrow: Gear; count: number; score: number }[] = [];
    for (const [id, count] of avail) {
        if (count <= 0) continue;
        const g = byId.get(id);
        if (!g || g.staffOnly || EXCLUDED_DEBUG_RE.test(g.debugname)) continue;
        if (g.slot === 'quiver') {
            if (style === 'ranged' && (g.tier ?? 1) <= rangedSkill) {
                ownedQuivers.push({ arrow: g, count, score: scoreGearForStyle(g, 'ranged') });
            }
            continue;
        }
        if (!canWear(g, canWearLevels, done)) continue;
        const list = ownedBySlot.get(g.slot);
        if (list) list.push(g);
        else ownedBySlot.set(g.slot, [g]);
    }
    if (ownedQuivers.length > 1) {
        ownedQuivers.sort((a, b) => b.score - a.score || a.arrow.id - b.arrow.id);
    }

    const ammoCache = new Map<number, Gear | null>();
    const ammoFor = (bow: Gear | null): Gear | null => {
        if (style !== 'ranged') return null;
        const key = bow ? bow.id : -1;
        if (ammoCache.has(key)) return ammoCache.get(key)!;
        let firstOverMin: Gear | null = null;
        let bestCount = -1;
        let bestFallback: Gear | null = null;
        for (let i = 0; i < ownedQuivers.length; i++) {
            const entry = ownedQuivers[i]!;
            if (!arrowCompatibility(bow, entry.arrow)) continue;
            if (entry.count >= arrowMin) {
                firstOverMin = entry.arrow;
                break;
            }
            if (entry.count > bestCount) {
                bestCount = entry.count;
                bestFallback = entry.arrow;
            }
        }
        const picked = firstOverMin ?? bestFallback;
        ammoCache.set(key, picked);
        return picked;
    };

    const slotCandidates = (slot: LoadoutSlotName): { item: Gear; score: number }[] => {
        const list = ownedBySlot.get(GEAR_KEY_BY_SLOT[slot]);
        if (!list) return [];
        const scored: { item: Gear; score: number }[] = [];
        for (let i = 0; i < list.length; i++) {
            const g = list[i]!;
            if (slot === 'weapon') {
                if (!weaponSupportsTrainSkill(g, options.trainSkill)) continue;
                if (options.oneHanded && g.covers.includes('lefthand')) continue;
                if (style === 'ranged' && options.thrown === false && isThrownWeapon(g)) continue;
                if (options.minWeaponStrength !== undefined && g.bonuses.strength < options.minWeaponStrength) continue;
            } else if (slot === 'shield') {
                if (options.minShieldDefence !== undefined && meleeDefenceMean(g.bonuses) < options.minShieldDefence) continue;
            } else if (slot === 'cape' && options.godAlign) {
                const cg = GOD_ALIGN_BY_ID[g.id];
                if (cg && cg !== options.godAlign) continue;
            }
            const arrowStr = style === 'ranged' && g.slot === 'righthand' ? (ammoFor(g)?.bonuses.rangeStrength ?? 0) : 0;
            const sc = scoreGearForStyle(g, style, arrowStr);
            if (sc <= -1e8) continue;
            if (slot !== 'weapon' && sc <= 0) continue;
            scored.push({ item: g, score: sc });
        }
        if (scored.length > 1) {
            scored.sort((a, b) => b.score - a.score || tieOrder(a.item, b.item, style));
        }
        return scored;
    };

    const weapons = slotCandidates('weapon');
    const shields = slotCandidates('shield');
    const oneHandedEntry = weapons.find(w => !w.item.covers.includes('lefthand')) ?? null;
    const twoHandedEntry = options.requireShield ? null : (weapons.find(w => w.item.covers.includes('lefthand')) ?? null);
    const topShieldEntry = shields[0] ?? null;

    let chosenWeapon: Gear | null = null;
    let chosenShield: Gear | null = null;

    const pair1hScore = oneHandedEntry ? oneHandedEntry.score + (topShieldEntry ? topShieldEntry.score : 0) : -Infinity;
    const solo2hScore = twoHandedEntry ? twoHandedEntry.score : -Infinity;
    if (pair1hScore >= solo2hScore && oneHandedEntry) {
        chosenWeapon = oneHandedEntry.item;
        chosenShield = topShieldEntry?.item ?? null;
    } else if (twoHandedEntry) {
        chosenWeapon = twoHandedEntry.item;
        chosenShield = null;
    } else if (!options.requireWeapon) {
        chosenShield = topShieldEntry?.item ?? null;
    }

    const worn: Record<LoadoutSlotName, Gear | null> = {
        weapon: chosenWeapon,
        shield: chosenShield,
        helm: null,
        body: null,
        legs: null,
        amulet: null,
        cape: null,
        hands: null,
        feet: null,
    };
    for (let i = 0; i < LOADOUT_SLOTS.length; i++) {
        const slot = LOADOUT_SLOTS[i]!;
        if (slot === 'weapon' || slot === 'shield') continue;
        const cands = slotCandidates(slot);
        if (slot === 'cape' && style === 'magic' && chosenWeapon) {
            const wGod = GOD_ALIGN_BY_ID[chosenWeapon.id];
            const picked = wGod ? cands.find(c => !GOD_ALIGN_BY_ID[c.item.id] || GOD_ALIGN_BY_ID[c.item.id] === wGod) : cands[0];
            worn[slot] = picked?.item ?? null;
        } else {
            worn[slot] = cands[0]?.item ?? null;
        }
    }

    const thrown = style === 'ranged' && !!worn.weapon && isThrownWeapon(worn.weapon);
    const ammo = style === 'ranged' && worn.weapon && !thrown ? ammoFor(worn.weapon) : null;
    const ammoCount = style === 'ranged' && worn.weapon ? (thrown ? (avail.get(worn.weapon.id) ?? 0) : ammo ? (avail.get(ammo.id) ?? 0) : 0) : 0;

    const items: { slot: RangedLoadoutSlotName; wearpos: number; item: Gear }[] = [];
    for (let i = 0; i < LOADOUT_SLOTS.length; i++) {
        const slot = LOADOUT_SLOTS[i]!;
        const item = worn[slot];
        if (item) items.push({ slot, wearpos: WEARPOS_BY_SLOT[slot], item });
    }
    if (ammo) items.push({ slot: 'ammo', wearpos: WEARPOS_BY_SLOT.ammo, item: ammo });

    const bonuses = {
        stabAttack: 0,
        slashAttack: 0,
        crushAttack: 0,
        magicAttack: 0,
        rangeAttack: 0,
        stabDefence: 0,
        slashDefence: 0,
        crushDefence: 0,
        magicDefence: 0,
        rangeDefence: 0,
        strength: 0,
        rangeStrength: 0,
        magicDamage: 0,
        prayer: 0,
    } as Record<Bonus, number>;
    for (let i = 0; i < items.length; i++) {
        const b = items[i]!.item.bonuses;
        for (let j = 0; j < BONUSES.length; j++) {
            const k = BONUSES[j]!;
            bonuses[k] += b[k];
        }
    }

    return {
        style,
        worn,
        ammo,
        thrown,
        ammoCount,
        items,
        bonuses,
    };
}

function elementalStavesCatalog(): readonly Gear[] {
    if (cachedElementalStaves) return cachedElementalStaves;
    gearCatalog();
    const byId = cachedGearById!;
    const out: Gear[] = [];
    for (const idStr in ELEMENTAL_STAFF_RUNES) {
        const g = byId.get(Number(idStr));
        if (g && g.slot === 'righthand') out.push(g);
    }
    cachedElementalStaves = out;
    return out;
}

function rankedElementalStaves(
    levels?: GearSkillLevels,
    quests?: QuestInput,
    runeIds: readonly number[] = [],
    members = true,
) {
    const skillMap = normalizeSkills(levels) as Partial<Record<Skill, number>>;
    const done = normalizeCompletedQuests(quests);
    const runeWeights = new Map<number, number>();
    for (let idx = 0; idx < runeIds.length; idx++) {
        const id = runeIds[idx]!;
        runeWeights.set(id, (runeWeights.get(id) ?? 0) + 1 + (runeIds.length - idx) * 1e-4);
    }
    const staves = elementalStavesCatalog();
    const scored: { gear: Gear; runeScore: number; styleScore: number }[] = [];
    for (let i = 0; i < staves.length; i++) {
        const g = staves[i]!;
        if ((!members && g.members) || !canWearPrepared(g, skillMap, done)) continue;
        const provided = ELEMENTAL_STAFF_RUNES[g.id]!;
        let runeScore = 0;
        if (runeIds.length === 0) {
            runeScore = provided.length;
        } else {
            for (let j = 0; j < provided.length; j++) {
                runeScore += runeWeights.get(provided[j]!) ?? 0;
            }
            if (runeScore <= 0) continue;
        }
        scored.push({ gear: g, runeScore, styleScore: scoreGearForStyle(g, 'magic') });
    }
    if (scored.length > 1) {
        scored.sort((a, b) => b.runeScore - a.runeScore || b.styleScore - a.styleScore || a.gear.id - b.gear.id);
    }
    return scored.map(s => s.gear);
}

export function bestElementalStaffForRunes(
    stock: readonly GearCount[],
    levels?: GearSkillLevels,
    quests?: QuestInput,
    runeIds: readonly number[] = [],
    members = true,
): Gear | null {
    const owned = new Set<number>();
    for (let i = 0; i < stock.length; i++) {
        const s = stock[i]!;
        if (s.count > 0) owned.add(s.id);
    }
    if (owned.size === 0) return null;
    const ranked = rankedElementalStaves(levels, quests, runeIds, members);
    for (let i = 0; i < ranked.length; i++) {
        if (owned.has(ranked[i]!.id)) return ranked[i]!;
    }
    return null;
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
const GIANT_ARMOUR_SLOT_RANK = new Map<number, number>(GIANT_ARMOUR_SLOT_ORDER.map((slot, idx) => [slot, idx]));

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
    const armourStock: GearCount[] = [];
    for (let i = 0; i < stock.length; i++) {
        const row = stock[i]!;
        if (gearById(row.id)?.slot !== 'righthand') armourStock.push(row);
    }
    const skillMap: Record<string, number> = { Attack: 1, Strength: 1, Defence: defence, ...normalizeSkills(levels) };
    skillMap.defence = defence;
    const loadout = selectCombatLoadout('melee', armourStock, skillMap, completedQuests);
    const out: { slot: number; id: number }[] = [];
    for (let i = 0; i < loadout.items.length; i++) {
        const entry = loadout.items[i]!;
        if (entry.slot !== 'weapon') out.push({ slot: entry.wearpos, id: entry.item.id });
    }
    out.sort((a, b) => (GIANT_ARMOUR_SLOT_RANK.get(a.slot) ?? 99) - (GIANT_ARMOUR_SLOT_RANK.get(b.slot) ?? 99));
    return out;
}

export const GIANT_BOWS: readonly { level: number; ids: readonly number[] }[] = lazyArray(() => standardBowTiers());
export const GIANT_ARROWS: readonly { level: number; id: number }[] = lazyArray(() =>
    standardArrowTiers().map(({ level, id }) => ({ level, id })),
);

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

export const BOWS: readonly { id: number; req: number; name: string }[] = lazyArray(() =>
    [...standardBowTiers()].reverse().flatMap(t =>
        t.ids.map(id => ({ id, req: t.level, name: gearById(id)?.name ?? String(id) })),
    ),
);
export const ARROWS: readonly { id: number; req: number; name: string }[] = lazyArray(() =>
    standardArrowTiers()
        .sort((x, y) => x.id - y.id)
        .map(t => ({ id: t.id, req: t.level, name: gearById(t.id)?.name ?? String(t.id) })),
);
export const LOWE_ARROWS: readonly number[] = lazyArray(() =>
    ARROWS.filter(a => shopCatalog().get(a.id)?.some(s => s.shop === 'archeryshop')).map(a => a.id),
);

export function bestBow(owned: readonly GearCount[], ranged: number) {
    const bows = BOWS;
    let best: (typeof BOWS)[number] | undefined;
    for (let i = 0; i < bows.length; i++) {
        const b = bows[i]!;
        if (b.req <= ranged && countPackItems(owned, b.id) > 0 && (!best || b.req > best.req)) {
            best = b;
        }
    }
    return best;
}

export const usableArrows = (bowReq: number, ranged: number): number[] => {
    const limit = Math.min(bowReq, ranged);
    const arrows = ARROWS;
    const out: number[] = [];
    for (let i = 0; i < arrows.length; i++) {
        const a = arrows[i]!;
        if (a.req <= limit) out.push(a.id);
    }
    return out;
};

export function chooseArrow(owned: readonly GearCount[], bowReq: number, ranged: number, min = MIN_TRIP_ARROWS) {
    const limit = Math.min(bowReq, ranged);
    const arrows = ARROWS;
    let best: { id: number; count: number } | undefined;
    for (let i = 0; i < arrows.length; i++) {
        const a = arrows[i]!;
        if (a.req > limit) continue;
        const count = countPackItems(owned, a.id);
        if (count >= min && (!best || a.id > best.id)) {
            best = { id: a.id, count };
        }
    }
    return best;
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
