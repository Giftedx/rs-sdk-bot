// Memoized rev-289 gear, shop, and skill-tool catalogs plus wearability, training-style, and shop-gate predicates.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Gear, Skill } from '../../../knowledge/src/gear';
import type { Shop } from '../../../knowledge/src/shops';
import { canWear, loadGear } from '../../../knowledge/src/gear-query';
import {
    normalizeCompletedQuests,
    normalizeSkills,
    type GearSkillLevels,
    type GearSkillName,
    type QuestInput,
    type ShopSource,
} from './model';

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
const ROOT = resolve(import.meta.dir, '../../../..');

let cachedGear: Gear[] | undefined;
let cachedGearById: Map<number, Gear> | undefined;
let cachedGearByName: Map<string, number> | undefined;
let cachedShopsById: Map<number, ShopSource[]> | undefined;

export interface SkillToolRow {
    id: number;
    wieldAttack?: number | null;
    paramLevelrequire?: number | null;
    woodcuttingLevel?: number | null;
    miningLevel?: number | null;
}

let cachedSkillTools: { axes: SkillToolRow[]; pickaxes: SkillToolRow[] } | undefined;

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

/** The gear item id of a name ("Bronze sword", "bronze_sword") or numeric id string, or undefined. Not gear: undefined. */
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
