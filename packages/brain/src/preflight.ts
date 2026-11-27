// Pure shared preflight evaluator for AccountPlanner and WorkerModules.
// Evaluates tile reachability, ferry fares, wearable skill/quest gates, reserve-adjusted stock,
// GE escrow + operating coin float math, max-level caps, cooldowns, spot capacity, and combat survivability.
import { resolve } from 'node:path';
import { PLAIN_FOOD } from '../../core/src/eat-guard';
import { offMap as isEntranaTile } from '../../core/src/shop-index';
import { carryableFood, combatAdmission, MIN_HITS_ABOVE_RETREAT, type CombatThreat } from '../../core/src/combat-admission';
import {
    questFoodDefinitions,
    totalAvailableHeal,
} from '../../core/src/sustain';
import { xpForLevel } from '../../core/src/xp-curve';
import type { BankObservation } from '../../core/src/session-types';
import { routeFares, type Account as WorldAccount, type Tile, type World } from '../../core/src/world';
import type { Gear, Skill } from '../../knowledge/src/gear';
import { canWear } from '../../knowledge/src/gear-query';
import { npcThreat } from '../../knowledge/src/npc-threat';
import { readJsonStatCached } from './json-cache';
import {
    accountOwnedItemCount,
    availableCoinsAfterReserves,
    preflightFail,
    preflightOk,
    reserveAdjustedStock,
    type PreflightBlocker,
    type PreflightMissingItem,
    type PreflightResult,
    type WorkerAccountView,
    type WorkerQuestState,
    type WorkerTile,
    type WorkerWorldView,
} from '../../workers/src/contracts';
import { questSweepCoins, questSweepNeeds } from '../../workers/src/quest/bank-needs';
import { BREW_STOCK_IDS, brewShortfall } from '../../workers/src/bank-artisan/herblore-recipes';
import { loadTravel } from '../../core/src/travel';
import { isCooldownActive, type NoRouteFact } from './contracts';
import { ferryFallbackFare } from './ferry-fare';
import { noRouteForActivity, noRouteMessage, noRouteTo } from './no-route';

// The no-route facts of a brain AccountState (outcome-classifier.ts). A bare WorkerAccountView has none.
const accountNoRoutes = (acct: WorkerAccountView): readonly NoRouteFact[] | undefined =>
    (acct as { readonly noRoutes?: readonly NoRouteFact[] }).noRoutes;

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');
export const COINS_ITEM_ID = 995;
export const DEFAULT_PREFLIGHT_COIN_FLOAT = 1000;

export const STANDARD_FOOD_IDS: readonly number[] = [
    385,  // Shark (20)
    379,  // Lobster (12)
    373,  // Swordfish (14)
    365,  // Bass (13)
    361,  // Tuna (10)
    333,  // Salmon (9)
    329,  // Trout (7)
    315,  // Shrimps (3)
    1891, // Cake (12)
    1897, // Chocolate cake (15)
    2309, // Bread (5)
];

// The STANDARD_FOOD_IDS that the eat guard eats (PLAIN_FOOD, packages/core/src/eat-guard.ts), in STANDARD_FOOD_IDS order (shark first). A
// worker with the eat guard never eats a cake or bread, so a fight floor of such a worker counts only these.
export const GUARD_FOOD_IDS: readonly number[] = STANDARD_FOOD_IDS.filter((id) => PLAIN_FOOD.includes(id));

const ANTIPOISON_IDS = new Set<number>([
    175, 177, 179, 2446, // Antipoison (1..4)
    181, 183, 185, 2448, // Superantipoison (1..4)
]);
const ANTI_DRAGON_SHIELD_ID = 1540;
const DRAMEN_STAFF_ID = 772;

export interface ItemMeta {
    readonly id: number;
    readonly name: string;
    readonly debugname: string;
    readonly cost: number;
    readonly members: boolean;
    readonly tradeable: boolean;
}

export interface KnowledgeQuestRow {
    readonly varp: string;
    readonly folder: string | null;
    readonly complete: number;
    readonly questPoints: number;
    readonly xp?: readonly { readonly skill: string; readonly xp: number }[];
}

export interface ShopGateRule {
    readonly requiresQuest?: string;
    readonly requiresSkill?: { readonly skill: string; readonly level: number };
    readonly requiresQuestPoints?: number;
}

export const SHOP_GATES: Readonly<Record<string, ShopGateRule>> = {
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
    fishingguild: { requiresSkill: { skill: 'fishing', level: 68 } },
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

const QUEST_ALIASES: Readonly<Record<string, readonly string[]>> = {
    dragon: ['dragon', 'dragon slayer', 'dragonquest', 'quest_dragon'],
    zanaris: ['zanaris', 'lost city', 'quest_zanaris'],
    hero: ['hero', "hero's quest", "heroes' quest", 'heroes quest', 'hero quest', 'heroquest', 'quest_hero'],
    legends: ['legends', 'legends quest', "legends' quest", 'the legends quest', 'legendsquest', 'quest_legends'],
    viking: ['viking', 'the fremennik trials', 'fremennik trials', 'quest_viking'],
    regicide: ['regicide', 'regicide_quest', 'quest_regicide'],
    druid: ['druid', 'druidic ritual', 'quest_druid'],
    priestperil: ['priestperil', 'priest in peril', 'quest_priestperil'],
    priest: ['priest', 'the restless ghost', 'restless ghost', 'quest_priest'],
    prince: ['prince', 'prince ali rescue', 'quest_prince'],
    zombiequeen: ['zombiequeen', 'shilo village', 'quest_zombiequeen'],
    desertrescue: ['desertrescue', 'the tourist trap', 'tourist trap'],
    upass: ['upass', 'underground pass', 'quest_upass'],
    biohazard: ['biohazard', 'quest_biohazard'],
    mm: ['mm', 'monkey madness', 'quest_mm'],
    cook: ['cook', "cook's assistant", 'cooks assistant', 'cookquest'],
    doric: ['doric', "doric's quest", 'dorics quest', 'doricquest'],
    runemysteries: ['runemysteries', 'rune mysteries', 'rune mysteries quest'],
    waterfall: ['waterfall', 'waterfall quest', 'quest_waterfall'],
    dwarfcannon: ['dwarfcannon', 'mcannon', 'dwarf cannon'],
    grandtree: ['grandtree', 'the grand tree', 'grand tree'],
    tree: ['tree', 'tree gnome village'],
    arena: ['arena', 'fight arena'],
    merlin: ['merlin', 'arthur', "merlin's crystal", 'merlins crystal'],
    arrav: ['arrav', 'blackarmgang', 'phoenixgang', 'shield of arrav'],
    elena: ['elena', 'plague city', 'elenaquest', 'quest_elena'],
    death: ['death', 'death plateau', 'death_plateau', 'quest_death'],
    junglepotion: ['junglepotion', 'jungle potion', 'quest_junglepotion'],
    troll: ['troll', 'troll stronghold', 'quest_troll'],
    druidspirit: ['druidspirit', 'nature spirit', 'quest_druidspirit'],
    crest: ['crest', 'family crest', 'quest_crest'],
    barcrawl: ['barcrawl', "alfred grimhand's barcrawl", 'alfred grimhands barcrawl', 'quest_barcrawl'],
    magearena: ['magearena', 'mage arena', 'quest_magearena'],
    itwatchtower: ['itwatchtower', 'watch tower', 'watchtower', 'quest_itwatchtower'],
    horror: ['horror', 'horror from the deep', 'horrorquest', 'quest_horror'],
    imp: ['imp', 'imp catcher', 'impquest', 'quest_imp'],
};

let cachedGearById: Map<number, Gear> | undefined;
let cachedItemsById: Map<number, ItemMeta> | undefined;
let cachedQuests: KnowledgeQuestRow[] | undefined;

export function loadGearMap(): ReadonlyMap<number, Gear> {
    if (cachedGearById) return cachedGearById;
    const raw = readJsonStatCached<Gear[]>(resolve(REPO_ROOT, 'knowledge', 'gear.json')) ?? [];
    const map = new Map<number, Gear>();
    for (const g of raw) {
        if (g.staffOnly) continue;
        const fix = REV289_REQUIREMENT_FIXES[g.id];
        if (!fix) {
            map.set(g.id, g);
        } else {
            map.set(g.id, {
                ...g,
                requires: {
                    ...g.requires,
                    skills: { ...g.requires.skills, ...fix.skills },
                    ...(fix.quest ? { quest: fix.quest } : {}),
                },
            });
        }
    }
    cachedGearById = map;
    return map;
}

export function loadItemsMap(): ReadonlyMap<number, ItemMeta> {
    if (cachedItemsById) return cachedItemsById;
    const rows = readJsonStatCached<ItemMeta[]>(resolve(REPO_ROOT, 'knowledge', 'items.json')) ?? [];
    cachedItemsById = new Map(rows.map((r) => [r.id, r]));
    return cachedItemsById;
}

export function loadQuestRows(): readonly KnowledgeQuestRow[] {
    if (cachedQuests) return cachedQuests;
    cachedQuests = readJsonStatCached<KnowledgeQuestRow[]>(resolve(REPO_ROOT, 'knowledge', 'quests.json')) ?? [];
    return cachedQuests;
}

const QUEST_STRING_CACHE_LIMIT = 4096;
const NORM_QUEST_CACHE = new Map<string, { norm: string; collapsed: string }>();
const QUEST_KEYS_CACHE = new Map<string, ReadonlySet<string>>();

function normalizeQuestParts(raw: string): { norm: string; collapsed: string } {
    let hit = NORM_QUEST_CACHE.get(raw);
    if (hit) return hit;
    const norm = raw.toLowerCase().replace(/['`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const collapsed = norm.replace(/\s+/g, '');
    hit = { norm, collapsed };
    if (NORM_QUEST_CACHE.size >= QUEST_STRING_CACHE_LIMIT) NORM_QUEST_CACHE.clear();
    NORM_QUEST_CACHE.set(raw, hit);
    return hit;
}

const QUEST_ALIAS_SETS = new Map<string, ReadonlySet<string>>();
for (const [slug, aliases] of Object.entries(QUEST_ALIASES)) {
    const set = new Set<string>([slug]);
    for (const a of aliases) {
        const { norm, collapsed } = normalizeQuestParts(a);
        set.add(norm);
        set.add(collapsed);
    }
    for (const token of set) {
        const prev = QUEST_ALIAS_SETS.get(token);
        if (!prev) {
            QUEST_ALIAS_SETS.set(token, set);
        } else {
            const merged = new Set<string>(prev);
            for (const t of set) merged.add(t);
            for (const t of merged) QUEST_ALIAS_SETS.set(t, merged);
        }
    }
}

export function questCandidateKeys(quest: string): ReadonlySet<string> {
    let cached = QUEST_KEYS_CACHE.get(quest);
    if (cached) return cached;
    const { norm, collapsed } = normalizeQuestParts(quest);
    const lower = quest.trim().toLowerCase();
    const aliasSet = QUEST_ALIAS_SETS.get(norm) ?? QUEST_ALIAS_SETS.get(collapsed);
    const keys = aliasSet ? new Set<string>(aliasSet) : new Set<string>();
    keys.add(norm);
    keys.add(collapsed);
    keys.add(lower);
    if (QUEST_KEYS_CACHE.size >= QUEST_STRING_CACHE_LIMIT) QUEST_KEYS_CACHE.clear();
    QUEST_KEYS_CACHE.set(quest, keys);
    return keys;
}

export interface AccountLookupCache {
    readonly skillLevels: ReadonlyMap<string, number>;
    readonly skillXps: ReadonlyMap<string, number>;
    readonly completedQuests: ReadonlySet<string>;
    readonly startedQuests: ReadonlySet<string>;
    readonly completedSet: ReadonlySet<string>;
    readonly questStateByRaw: Map<string, WorkerQuestState>;
    readonly worldAcctReserves: Readonly<Record<number, number>> | undefined;
    readonly geEscrow: number;
    readonly defaultSpendableCoins: ReturnType<typeof availableSpendableCoins>;
    readonly tileReach: Map<string, TileReachabilityResult>;
}

export function createAccountLookupCache(
    acct: WorkerAccountView,
    world: WorkerWorldView,
    operatingFloat = DEFAULT_PREFLIGHT_COIN_FLOAT,
): AccountLookupCache {
    const skillLevels = new Map<string, number>();
    const skillXps = new Map<string, number>();
    for (const [k, stat] of Object.entries(acct.skills)) {
        const lower = k.trim().toLowerCase();
        if (Number.isFinite(stat?.level)) {
            const lvl = Math.max(1, Math.floor(stat.level));
            if (!skillLevels.has(lower)) skillLevels.set(lower, lvl);
            if (!skillXps.has(lower)) skillXps.set(lower, stat.xp ?? xpForLevel(stat.level));
        }
    }

    const completedQuests = new Set<string>();
    const startedQuests = new Set<string>();
    const completedSet = new Set<string>();
    for (const [key, state] of Object.entries(acct.quests)) {
        if (state !== 'complete' && state !== 'started') continue;
        const { norm, collapsed } = normalizeQuestParts(key);
        const lower = key.toLowerCase();
        if (state === 'complete') {
            completedQuests.add(norm);
            completedQuests.add(collapsed);
            completedQuests.add(lower);
            for (const candidate of questCandidateKeys(key)) completedSet.add(candidate);
            completedSet.add(key);
            if (norm === 'dragon' || norm === 'dragon slayer') completedSet.add('Dragon Slayer');
            if (norm === 'zanaris' || norm === 'lost city') completedSet.add('Lost City');
            if (norm === 'hero' || norm === 'heros quest' || norm === 'heroes quest') completedSet.add("Hero's Quest");
            if (norm === 'legends' || norm === 'legends quest' || norm === 'the legends quest') completedSet.add('Legends Quest');
            if (norm === 'viking' || norm === 'fremennik trials' || norm === 'the fremennik trials') completedSet.add('The Fremennik Trials');
            if (norm === 'regicide') completedSet.add('Regicide');
        } else {
            startedQuests.add(norm);
            startedQuests.add(collapsed);
            startedQuests.add(lower);
        }
    }

    let worldAcctReserves: Readonly<Record<number, number>> | undefined;
    if (world.reserves) {
        const lowerName = acct.name.toLowerCase();
        worldAcctReserves = world.reserves[acct.name] ?? world.reserves[lowerName];
        if (worldAcctReserves === undefined) {
            for (const [k, map] of Object.entries(world.reserves)) {
                if (k.toLowerCase() === lowerName) {
                    worldAcctReserves = map;
                    break;
                }
            }
        }
    }

    const geEscrow = accountGeEscrowCoins(acct, world);
    const coinsOwned = accountOwnedItemCount(acct, COINS_ITEM_ID, { includeBank: true, requireTrustedBank: true });
    const coinsRes = Math.max(0, Math.max(acct.reserves?.[COINS_ITEM_ID] ?? 0, worldAcctReserves?.[COINS_ITEM_ID] ?? 0) + (world.globalReserves?.[COINS_ITEM_ID] ?? 0));
    const safeFloat = Math.max(0, operatingFloat);
    const defaultSpendableCoins = {
        owned: coinsOwned,
        reserved: coinsRes,
        escrow: geEscrow,
        float: safeFloat,
        spendable: availableCoinsAfterReserves(coinsOwned, coinsRes, geEscrow, safeFloat),
        totalUnreserved: availableCoinsAfterReserves(coinsOwned, coinsRes, geEscrow, 0),
    };

    return {
        skillLevels,
        skillXps,
        completedQuests,
        startedQuests,
        completedSet,
        questStateByRaw: new Map(),
        worldAcctReserves,
        geEscrow,
        defaultSpendableCoins,
        tileReach: new Map(),
    };
}

export function cachedAccountSkillLevel(
    acct: WorkerAccountView,
    skill: string,
    cache?: AccountLookupCache,
): number {
    if (!cache) return accountSkillLevel(acct, skill);
    const direct = acct.skills[skill];
    if (direct && Number.isFinite(direct.level)) {
        return Math.max(1, Math.floor(direct.level));
    }
    const lower = skill.trim().toLowerCase();
    const hit = cache.skillLevels.get(lower);
    if (hit !== undefined) return hit;
    return lower === 'hitpoints' ? 10 : 1;
}

export function cachedAccountSkillXp(
    acct: WorkerAccountView,
    skill: string,
    cache?: AccountLookupCache,
): number {
    const direct = acct.skills[skill];
    if (direct) return direct.xp ?? xpForLevel(direct.level);
    if (cache) {
        const lower = skill.trim().toLowerCase();
        const hit = cache.skillXps.get(lower);
        if (hit !== undefined) return hit;
        return xpForLevel(lower === 'hitpoints' ? 10 : 1);
    }
    const lower = skill.toLowerCase();
    for (const [k, v] of Object.entries(acct.skills)) {
        if (k.toLowerCase() === lower) return v.xp ?? xpForLevel(v.level);
    }
    return xpForLevel(accountSkillLevel(acct, skill));
}

export function cachedAccountQuestState(
    acct: WorkerAccountView,
    quest: string,
    cache?: AccountLookupCache,
): WorkerQuestState {
    if (!cache) return accountQuestState(acct, quest);
    const hit = cache.questStateByRaw.get(quest);
    if (hit !== undefined) return hit;
    const direct = acct.quests[quest];
    if (direct === 'complete') {
        cache.questStateByRaw.set(quest, 'complete');
        return 'complete';
    }
    let result: WorkerQuestState = direct === 'started' ? 'started' : 'not_started';
    if (cache.completedQuests.size > 0 || cache.startedQuests.size > 0) {
        const want = questCandidateKeys(quest);
        for (const token of want) {
            if (cache.completedQuests.has(token)) {
                result = 'complete';
                break;
            }
            if (result !== 'started' && cache.startedQuests.has(token)) {
                result = 'started';
            }
        }
    }
    cache.questStateByRaw.set(quest, result);
    return result;
}

export function cachedHasCompletedQuest(
    acct: WorkerAccountView,
    quest: string,
    cache?: AccountLookupCache,
): boolean {
    return cachedAccountQuestState(acct, quest, cache) === 'complete';
}

export function cachedEffectiveItemReserve(
    acct: WorkerAccountView,
    world: WorkerWorldView,
    itemId: number,
    cache?: AccountLookupCache,
): number {
    if (!cache) return effectiveItemReserve(acct, world, itemId);
    const acctRes = acct.reserves?.[itemId] ?? 0;
    const worldAcctRes = cache.worldAcctReserves?.[itemId] ?? 0;
    const globalRes = world.globalReserves?.[itemId] ?? 0;
    return Math.max(0, Math.max(acctRes, worldAcctRes) + globalRes);
}

export function cachedAvailableSpendableCoins(
    acct: WorkerAccountView,
    world: WorkerWorldView,
    operatingFloat = DEFAULT_PREFLIGHT_COIN_FLOAT,
    opts: { includeBank?: boolean; requireTrustedBank?: boolean } = {},
    cache?: AccountLookupCache,
): ReturnType<typeof availableSpendableCoins> {
    if (!cache) return availableSpendableCoins(acct, world, operatingFloat, opts);
    const includeBank = opts.includeBank ?? true;
    const requireTrustedBank = opts.requireTrustedBank ?? true;
    const safeFloat = Math.max(0, operatingFloat);
    if (includeBank && requireTrustedBank) {
        const base = cache.defaultSpendableCoins;
        if (safeFloat === base.float) return base;
        return {
            owned: base.owned,
            reserved: base.reserved,
            escrow: base.escrow,
            float: safeFloat,
            spendable: availableCoinsAfterReserves(base.owned, base.reserved, base.escrow, safeFloat),
            totalUnreserved: base.totalUnreserved,
        };
    }
    const owned = accountOwnedItemCount(acct, COINS_ITEM_ID, opts);
    const reserved = cache.defaultSpendableCoins.reserved;
    const escrow = cache.geEscrow;
    return {
        owned,
        reserved,
        escrow,
        float: safeFloat,
        spendable: availableCoinsAfterReserves(owned, reserved, escrow, safeFloat),
        totalUnreserved: availableCoinsAfterReserves(owned, reserved, escrow, 0),
    };
}

export function accountQuestState(acct: WorkerAccountView, quest: string): WorkerQuestState {
    const direct = acct.quests[quest];
    if (direct === 'complete') return 'complete';
    const want = questCandidateKeys(quest);
    let best: WorkerQuestState = direct === 'started' ? 'started' : 'not_started';
    for (const [key, state] of Object.entries(acct.quests)) {
        if (state !== 'complete' && state !== 'started') continue;
        const { norm, collapsed } = normalizeQuestParts(key);
        if (want.has(norm) || want.has(collapsed) || want.has(key.toLowerCase())) {
            if (state === 'complete') return 'complete';
            best = 'started';
        }
    }
    return best;
}

export function hasCompletedQuest(acct: WorkerAccountView, quest: string): boolean {
    return accountQuestState(acct, quest) === 'complete';
}

export function completedQuestSet(acct: WorkerAccountView): Set<string> {
    const done = new Set<string>();
    for (const [key, state] of Object.entries(acct.quests)) {
        if (state !== 'complete') continue;
        for (const candidate of questCandidateKeys(key)) done.add(candidate);
        done.add(key);
        // Preserve original canonical title aliases used by knowledge/gear.json (`Dragon Slayer`, `Hero's Quest`, etc.)
        const norm = normalizeQuestParts(key).norm;
        if (norm === 'dragon' || norm === 'dragon slayer') done.add('Dragon Slayer');
        if (norm === 'zanaris' || norm === 'lost city') done.add('Lost City');
        if (norm === 'hero' || norm === 'heros quest' || norm === 'heroes quest') done.add("Hero's Quest");
        if (norm === 'legends' || norm === 'legends quest' || norm === 'the legends quest') done.add('Legends Quest');
        if (norm === 'viking' || norm === 'fremennik trials' || norm === 'the fremennik trials') done.add('The Fremennik Trials');
        if (norm === 'regicide') done.add('Regicide');
    }
    return done;
}

export function accountSkillLevel(acct: WorkerAccountView, skill: string): number {
    const direct = acct.skills[skill];
    if (direct && Number.isFinite(direct.level)) {
        return Math.max(1, Math.floor(direct.level));
    }
    const target = skill.trim().toLowerCase();
    for (const [k, stat] of Object.entries(acct.skills)) {
        if (k.trim().toLowerCase() === target && Number.isFinite(stat?.level)) {
            return Math.max(1, Math.floor(stat.level));
        }
    }
    return target === 'hitpoints' ? 10 : 1;
}

export function effectiveItemReserve(
    acct: WorkerAccountView,
    world: WorkerWorldView,
    itemId: number,
): number {
    const acctRes = acct.reserves?.[itemId] ?? 0;
    let worldAcctRes = 0;
    if (world.reserves) {
        const lowerName = acct.name.toLowerCase();
        const acctMap = world.reserves[acct.name] ?? world.reserves[lowerName];
        if (acctMap !== undefined) {
            worldAcctRes = acctMap[itemId] ?? 0;
        } else {
            for (const [k, map] of Object.entries(world.reserves)) {
                if (k.toLowerCase() === lowerName) {
                    worldAcctRes = map?.[itemId] ?? 0;
                    break;
                }
            }
        }
    }
    const globalRes = world.globalReserves?.[itemId] ?? 0;
    return Math.max(0, Math.max(acctRes, worldAcctRes) + globalRes);
}

export function availableStockAfterReserves(
    acct: WorkerAccountView,
    world: WorkerWorldView,
    itemId: number,
    opts: { includeBank?: boolean; requireTrustedBank?: boolean } = {},
): { owned: number; reserved: number; available: number } {
    const owned = accountOwnedItemCount(acct, itemId, opts);
    const reserved = effectiveItemReserve(acct, world, itemId);
    const available = reserveAdjustedStock(owned, reserved);
    return { owned, reserved, available };
}

export function accountGeEscrowCoins(acct: WorkerAccountView, world: WorkerWorldView): number {
    const map = world.geEscrowCoins;
    if (!map) return 0;
    if (map[acct.name] !== undefined) return Math.max(0, map[acct.name]!);
    const lower = acct.name.toLowerCase();
    for (const [k, v] of Object.entries(map)) {
        if (k.toLowerCase() === lower) return Math.max(0, v);
    }
    return 0;
}

export function availableSpendableCoins(
    acct: WorkerAccountView,
    world: WorkerWorldView,
    operatingFloat = DEFAULT_PREFLIGHT_COIN_FLOAT,
    opts: { includeBank?: boolean; requireTrustedBank?: boolean } = {},
): {
    owned: number;
    reserved: number;
    escrow: number;
    float: number;
    spendable: number;
    totalUnreserved: number;
} {
    const owned = accountOwnedItemCount(acct, COINS_ITEM_ID, opts);
    const reserved = effectiveItemReserve(acct, world, COINS_ITEM_ID);
    const escrow = accountGeEscrowCoins(acct, world);
    const float = Math.max(0, operatingFloat);
    return {
        owned,
        reserved,
        escrow,
        float,
        spendable: availableCoinsAfterReserves(owned, reserved, escrow, float),
        totalUnreserved: availableCoinsAfterReserves(owned, reserved, escrow, 0),
    };
}

export function canWearItem(
    acct: WorkerAccountView,
    itemId: number,
): { ok: boolean; gear?: Gear; missingSkills: Record<string, number>; missingQuest?: string } {
    const gear = loadGearMap().get(itemId);
    if (!gear) return { ok: true, missingSkills: {} };
    const levels: Partial<Record<Skill, number>> = {};
    for (const sk of Object.keys(gear.requires.skills) as Skill[]) {
        levels[sk] = accountSkillLevel(acct, sk.charAt(0).toUpperCase() + sk.slice(1));
    }
    const done = gear.requires.quest ? completedQuestSet(acct) : null;
    if (canWear(gear, levels, done)) {
        return { ok: true, gear, missingSkills: {} };
    }
    const missingSkills: Record<string, number> = {};
    for (const [sk, req] of Object.entries(gear.requires.skills)) {
        if (req !== undefined && (levels[sk as Skill] ?? 1) < req) {
            missingSkills[sk] = req;
        }
    }
    const missingQuest = gear.requires.quest && !done?.has(gear.requires.quest) && !hasCompletedQuest(acct, gear.requires.quest)
        ? gear.requires.quest
        : undefined;
    return { ok: false, gear, missingSkills, ...(missingQuest ? { missingQuest } : {}) };
}

function isInKaramjaRegion(t: WorkerTile): boolean {
    return t.level === 0 && t.x >= 2680 && t.x <= 2965 && t.z >= 2880 && t.z <= 3200;
}

function isInShiloRegion(t: WorkerTile): boolean {
    return t.level === 0 && t.x >= 2815 && t.x <= 2880 && t.z >= 2945 && t.z <= 3010;
}

function isInAlKharidRegion(t: WorkerTile): boolean {
    return t.level === 0 && t.x >= 3267 && t.x <= 3330 && t.z >= 3140 && t.z <= 3325;
}

function isInZanarisRegion(t: WorkerTile): boolean {
    return t.level === 0 && t.x >= 3130 && t.x <= 3270 && t.z >= 9530 && t.z <= 9600;
}

function toWorldAccount(acct: WorkerAccountView, world: WorkerWorldView, availableCoins: number): WorldAccount {
    const skills: Record<string, number> = {};
    for (const [name, stat] of Object.entries(acct.skills)) {
        skills[name.toLowerCase()] = stat.level;
    }
    const itemsMeta = loadItemsMap();
    const counts: Record<string, number> = {};
    const addContainer = (src: Readonly<Record<number, number>>) => {
        for (const [idStr, cnt] of Object.entries(src)) {
            if (cnt <= 0) continue;
            const meta = itemsMeta.get(Number(idStr));
            if (meta) counts[meta.debugname] = (counts[meta.debugname] ?? 0) + cnt;
        }
    };
    addContainer(acct.inventory);
    addContainer(acct.equipment);
    if (acct.bank.trusted) addContainer(acct.bank.items);
    const worn: string[] = [];
    for (const [idStr, cnt] of Object.entries(acct.equipment)) {
        if (cnt <= 0) continue;
        const meta = itemsMeta.get(Number(idStr));
        if (meta) worn.push(meta.debugname);
    }
    const unlocks: string[] = [];
    const quests = loadQuestRows();
    for (const q of quests) {
        const folderShort = q.folder?.replace(/^quest_/, '') ?? '';
        if (hasCompletedQuest(acct, q.varp) || (folderShort && hasCompletedQuest(acct, folderShort))) {
            unlocks.push(`complete:${q.varp}`);
        }
    }
    return {
        skills,
        varps: {},
        items: Object.keys(counts),
        counts,
        worn,
        unlocks,
        coins: availableCoins,
    };
}

export interface TileReachabilityResult {
    readonly reachable: boolean;
    readonly travelCoins: number;
    readonly travelTicks: number;
    readonly reason?: 'no_route' | 'budget' | 'unknown_pos' | 'plane_mismatch';
    readonly message?: string;
}

export function evaluateTileReachability(
    acct: WorkerAccountView,
    target: WorkerTile,
    world: WorkerWorldView,
    opts: {
        spendableCoins?: number;
        deadlineMs?: number;
        ferryFareHint?: number;
        requireSamePlaneWithoutWorld?: boolean;
        allowUnknownPos?: boolean;
        boatEastFromKandarin?: boolean;
        _acctCache?: AccountLookupCache;
    } = {},
): TileReachabilityResult {
    const cache = opts._acctCache;
    if (cache && !world.world) {
        const key = `${target.x}:${target.z}:${target.level}:${opts.ferryFareHint ?? 0}:${opts.allowUnknownPos ? 1 : 0}:${opts.requireSamePlaneWithoutWorld ? 1 : 0}:${opts.boatEastFromKandarin ? 1 : 0}`;
        const hit = cache.tileReach.get(key);
        if (hit) return hit;
        const res = evaluateTileReachabilityUncached(acct, target, world, opts, cache);
        cache.tileReach.set(key, res);
        return res;
    }
    return evaluateTileReachabilityUncached(acct, target, world, opts, cache);
}

function evaluateTileReachabilityUncached(
    acct: WorkerAccountView,
    target: WorkerTile,
    world: WorkerWorldView,
    opts: {
        spendableCoins?: number;
        deadlineMs?: number;
        ferryFareHint?: number;
        requireSamePlaneWithoutWorld?: boolean;
        allowUnknownPos?: boolean;
        // The worker takes the boats east from Kandarin even with no route to Ardougne North: the quest sweep's
        // crossEast (workers/src/quest/sweep-travel.ts) sails from Brimhaven for each start that eastOfArdougne names.
        boatEastFromKandarin?: boolean;
    },
    cache?: AccountLookupCache,
): TileReachabilityResult {
    if (acct.pos === null) {
        if (opts.allowUnknownPos) {
            return { reachable: true, travelCoins: opts.ferryFareHint ?? 0, travelTicks: 60 };
        }
        return {
            reachable: false,
            travelCoins: 0,
            travelTicks: 0,
            reason: 'unknown_pos',
            message: `${acct.name} has unknown position`,
        };
    }

    if (world.world) {
        const coins = opts.spendableCoins ?? cachedAvailableSpendableCoins(acct, world, 0, {}, cache).totalUnreserved;
        const wAcct = toWorldAccount(acct, world, coins);
        const deadline = opts.deadlineMs !== undefined ? performance.now() + opts.deadlineMs : undefined;
        const res = world.world.route(acct.pos as Tile, target as Tile, wAcct, deadline ? { deadline } : undefined);
        if (!res.ok) {
            return {
                reachable: false,
                travelCoins: 0,
                travelTicks: 0,
                reason: res.reason,
                message: `route to (${target.x},${target.z},${target.level}) failed: ${res.reason}`,
            };
        }
        return {
            reachable: true,
            travelCoins: Math.max(0, routeFares(res.legs), opts.ferryFareHint ?? 0),
            travelTicks: Math.max(1, Math.ceil(res.cost)),
        };
    }

    // Pure offline reachability & ferry fare evaluation when World graph is omitted.
    // The account's own route search found no route to a tile near the target from where it stands (no-route.ts).
    const noRoutes = accountNoRoutes(acct);
    const searched = noRouteTo(noRoutes, acct.pos, target, world.at);
    if (searched) {
        return {
            reachable: false,
            travelCoins: 0,
            travelTicks: 0,
            reason: 'no_route',
            message: `${noRouteMessage(acct.name, searched)}; target ${target.x},${target.z},${target.level} is near it`,
        };
    }

    if (opts.requireSamePlaneWithoutWorld && acct.pos.level !== target.level) {
        return {
            reachable: false,
            travelCoins: 0,
            travelTicks: 0,
            reason: 'plane_mismatch',
            message: `plane mismatch: at level ${acct.pos.level}, target level ${target.level}`,
        };
    }

    if (isEntranaTile(target)) {
        const gearMap = loadGearMap();
        const carriesGear = [...Object.entries(acct.inventory), ...Object.entries(acct.equipment)].some(([idStr, cnt]) => {
            if (cnt <= 0) return false;
            const g = gearMap.get(Number(idStr));
            return g !== undefined && (g.slot === 'righthand' || g.slot === 'torso' || g.slot === 'legs' || g.slot === 'hat' || g.slot === 'lefthand');
        });
        if (carriesGear) {
            return {
                reachable: false,
                travelCoins: 0,
                travelTicks: 0,
                reason: 'no_route',
                message: 'Entrana forbids carried or worn weapons/armour',
            };
        }
    }

    if (isInZanarisRegion(target) && !isInZanarisRegion(acct.pos)) {
        const hasDramen = accountOwnedItemCount(acct, DRAMEN_STAFF_ID, { includeBank: true, requireTrustedBank: true }) > 0;
        if (!cachedHasCompletedQuest(acct, 'Lost City', cache) || !hasDramen) {
            return {
                reachable: false,
                travelCoins: 0,
                travelTicks: 0,
                reason: 'no_route',
                message: 'Zanaris requires Lost City complete and Dramen staff',
            };
        }
    }

    if (isInShiloRegion(target) && !isInShiloRegion(acct.pos) && !cachedHasCompletedQuest(acct, 'Shilo Village', cache)) {
        return {
            reachable: false,
            travelCoins: 0,
            travelTicks: 0,
            reason: 'no_route',
            message: 'Shilo Village requires Shilo Village quest complete',
        };
    }

    let fare = opts.ferryFareHint ?? 0;
    const fromKaramja = isInKaramjaRegion(acct.pos);
    const toKaramja = isInKaramjaRegion(target);
    if (fromKaramja !== toKaramja) {
        fare = Math.max(fare, 30);
    }
    if (isInShiloRegion(target) !== isInShiloRegion(acct.pos)) {
        fare = Math.max(fare, 200);
    }
    if (isInAlKharidRegion(target) !== isInAlKharidRegion(acct.pos) && !cachedHasCompletedQuest(acct, 'Prince Ali Rescue', cache)) {
        fare = Math.max(fare, 10);
    }
    // Between the east mainland and Ardougne the worker's walk needs both boat fares before it moves (./ferry-fare.ts).
    // From Kandarin it walks to Ardougne North first. With no route there, it walks its own route and takes no boat.
    const pos = acct.pos;
    const staged = opts.boatEastFromKandarin ? () => true : (t: Tile) => !noRouteTo(noRoutes, pos, t, world.at);
    fare = Math.max(fare, ferryFallbackFare(pos, target, loadTravel, staged));

    const sameBand = (acct.pos.z >= 6400) === (target.z >= 6400);
    const normZ = (z: number) => (z >= 6400 ? z - 6400 : z);
    const cheb = Math.max(Math.abs(acct.pos.x - target.x), Math.abs(normZ(acct.pos.z) - normZ(target.z)));
    const levelDelta = Math.abs(acct.pos.level - target.level);
    const dungeonPenalty = sameBand ? 0 : 40;
    const travelTicks = Math.max(1, Math.ceil(cheb * 1.15 + levelDelta * 12 + dungeonPenalty + (fare > 0 ? 40 : 0)));
    return {
        reachable: true,
        travelCoins: fare,
        travelTicks,
    };
}

export interface CombatSurvivabilityFloor {
    readonly minDefence?: number;
    readonly minHitpoints?: number;
    readonly minPrayer?: number;
    // The combat level below which the site's monsters attack the account (an aggressive NPC skips a player of more
    // than twice its own level).
    readonly minCombatLevel?: number;
    readonly minFoodHeal?: number;
    readonly minFoodCount?: number;
    readonly foodIds?: readonly number[];
    readonly requireProtectionPrayer?: boolean;
    readonly requiredProtectionLevel?: number;
    readonly requireAntiDragonShield?: boolean;
    readonly requireAntipoison?: boolean;
    readonly includeBankFood?: boolean;
    // The NPCs of the fight. The combat admission (packages/core/src/combat-admission.ts) checks the max hit and
    // accuracy of the worst one against the Hitpoints, Defence and food of the account.
    readonly threatNpcIds?: readonly number[];
    // NPCs that attack the account at the same time at this spot.
    readonly threatAttackers?: number;
}

export type CombatSurvivabilityBlocker = Extract<PreflightBlocker, { kind: 'combat_survivability' }>;

// The account's combat level from its base levels (the same formula as packages/core/src/danger/catalog.ts combatLevel).
export function accountCombatLevel(acct: WorkerAccountView, cache?: AccountLookupCache): number {
    const lv = (skill: string) => cachedAccountSkillLevel(acct, skill, cache);
    const base = (lv('Defence') + lv('Hitpoints') + Math.floor(lv('Prayer') / 2)) / 4;
    const melee = (lv('Attack') + lv('Strength')) * 0.325;
    const range = Math.floor(lv('Ranged') * 1.5) * 0.325;
    const mage = Math.floor(lv('Magic') * 1.5) * 0.325;
    return Math.floor(base + Math.max(melee, range, mage));
}

export function evaluateCombatSurvivability(
    acct: WorkerAccountView,
    floor: CombatSurvivabilityFloor,
    world: WorkerWorldView,
    _acctCache?: AccountLookupCache,
): CombatSurvivabilityBlocker[] {
    const blockers: CombatSurvivabilityBlocker[] = [];
    const def = cachedAccountSkillLevel(acct, 'Defence', _acctCache);
    const hp = cachedAccountSkillLevel(acct, 'Hitpoints', _acctCache);
    const prayer = cachedAccountSkillLevel(acct, 'Prayer', _acctCache);

    if (floor.minDefence !== undefined && def < floor.minDefence) {
        blockers.push({
            kind: 'combat_survivability',
            reason: 'defence',
            required: floor.minDefence,
            current: def,
            message: `Defence ${def}/${floor.minDefence} below floor`,
        });
    }
    if (floor.minHitpoints !== undefined && hp < floor.minHitpoints) {
        blockers.push({
            kind: 'combat_survivability',
            reason: 'hitpoints',
            required: floor.minHitpoints,
            current: hp,
            message: `Hitpoints ${hp}/${floor.minHitpoints} below floor`,
        });
    }
    if (floor.minPrayer !== undefined && prayer < floor.minPrayer) {
        blockers.push({
            kind: 'combat_survivability',
            reason: 'prayer',
            required: floor.minPrayer,
            current: prayer,
            message: `Prayer ${prayer}/${floor.minPrayer} below floor`,
        });
    }
    if (floor.minCombatLevel !== undefined) {
        const combat = accountCombatLevel(acct, _acctCache);
        if (combat < floor.minCombatLevel) {
            blockers.push({
                kind: 'combat_survivability',
                reason: 'protection',
                required: floor.minCombatLevel,
                current: combat,
                message: `Combat level ${combat}/${floor.minCombatLevel} below floor`,
            });
        }
    }
    if (floor.requireProtectionPrayer) {
        const reqPrayer = floor.requiredProtectionLevel ?? 43;
        if (prayer < reqPrayer) {
            blockers.push({
                kind: 'combat_survivability',
                reason: 'protection',
                required: reqPrayer,
                current: prayer,
                message: `Protection prayer requires Prayer ${reqPrayer} (current ${prayer})`,
            });
        }
    }

    const includeBank = floor.includeBankFood ?? true;
    if (floor.requireAntiDragonShield) {
        const { available } = availableStockAfterReserves(acct, world, ANTI_DRAGON_SHIELD_ID, {
            includeBank,
            requireTrustedBank: true,
        });
        if (available < 1) {
            blockers.push({
                kind: 'combat_survivability',
                reason: 'protection',
                required: 1,
                current: available,
                message: 'Anti-dragon shield (1540) required',
            });
        }
    }
    if (floor.requireAntipoison) {
        let antiTotal = 0;
        for (const id of ANTIPOISON_IDS) {
            antiTotal += availableStockAfterReserves(acct, world, id, {
                includeBank,
                requireTrustedBank: true,
            }).available;
        }
        if (antiTotal < 1) {
            blockers.push({
                kind: 'combat_survivability',
                reason: 'protection',
                required: 1,
                current: 0,
                message: 'Antipoison dose required',
            });
        }
    }

    if (floor.minFoodHeal !== undefined || floor.minFoodCount !== undefined) {
        const foodIds = floor.foodIds ?? STANDARD_FOOD_IDS;
        const rows: { id: number; count: number }[] = [];
        const reservedMap: Record<number, number> = {};
        let countAvail = 0;
        for (const id of foodIds) {
            const owned = accountOwnedItemCount(acct, id, { includeBank, requireTrustedBank: true });
            const reserved = cachedEffectiveItemReserve(acct, world, id, _acctCache);
            if (owned > 0) rows.push({ id, count: owned });
            if (reserved > 0) reservedMap[id] = reserved;
            countAvail += reserveAdjustedStock(owned, reserved);
        }
        const totalHeal = totalAvailableHeal(rows, foodIds, reservedMap);
        if (floor.minFoodHeal !== undefined && totalHeal < floor.minFoodHeal) {
            blockers.push({
                kind: 'combat_survivability',
                reason: 'food',
                required: floor.minFoodHeal,
                current: totalHeal,
                message: `Food heal ${totalHeal}/${floor.minFoodHeal} HP below floor`,
            });
        }
        if (floor.minFoodCount !== undefined) {
            if (countAvail < floor.minFoodCount) {
                blockers.push({
                    kind: 'combat_survivability',
                    reason: 'food',
                    required: floor.minFoodCount,
                    current: countAvail,
                    message: `Food count ${countAvail}/${floor.minFoodCount} below floor`,
                });
            }
        }
    }

    if (floor.threatNpcIds?.length) {
        let threat: CombatThreat | undefined;
        for (const id of floor.threatNpcIds) {
            const t = npcThreat(id);
            if (t && (!threat || t.maxHit > threat.maxHit || (t.maxHit === threat.maxHit && t.attackRoll > threat.attackRoll))) threat = t;
        }
        if (threat) {
            const foodIds = floor.foodIds ?? STANDARD_FOOD_IDS;
            const defs = questFoodDefinitions();
            const rows: { count: number; heal: number }[] = [];
            let bestHeal = 0;
            for (const id of foodIds) {
                const owned = accountOwnedItemCount(acct, id, { includeBank, requireTrustedBank: true });
                const h = defs.get(id)?.heal ?? 0;
                rows.push({ count: reserveAdjustedStock(owned, cachedEffectiveItemReserve(acct, world, id, _acctCache)), heal: h });
                bestHeal = Math.max(bestHeal, h);
            }
            // The worker carries the load that it can withdraw (carryableFood), and no other food exists.
            const load = carryableFood(rows);
            const pieces = load.pieces;
            const a = combatAdmission(
                threat,
                { hp, maxHp: hp, defence: def, foodPieces: pieces, healPerPiece: pieces > 0 ? load.heal : bestHeal || 12, bankFoodPieces: 0 },
                { attackers: floor.threatAttackers ?? 1 },
            );
            if (a.verdict !== 'admit') {
                const weak = a.reason.startsWith('too weak');
                const blocker: CombatSurvivabilityBlocker = {
                    kind: 'combat_survivability',
                    reason: weak ? 'hitpoints' : 'food',
                    required: weak ? a.retreatAt + MIN_HITS_ABOVE_RETREAT * threat.maxHit : a.foodNeeded,
                    current: weak ? hp : pieces,
                    message: `admission: ${a.reason}`,
                };
                // One blocker of a reason: the planner stages one food step for each food blocker. The admission
                // takes the place of a smaller food count.
                const same = blockers.findIndex(b => b.reason === blocker.reason);
                if (same < 0) blockers.push(blocker);
                else if (!weak && (blockers[same]!.message ?? '').startsWith('Food count') && (blockers[same]!.required ?? 0) < (blocker.required ?? 0)) blockers[same] = blocker;
            }
        }
    }

    return blockers;
}

export interface RequiredItemSpec {
    readonly itemId: number;
    readonly count: number;
    readonly itemName?: string;
    readonly includeBank?: boolean;
    readonly requireTrustedBank?: boolean;
}

export interface QuestRequirementSpec {
    readonly quest: string;
    readonly requiredState?: 'started' | 'complete';
}

export interface PreflightSpec {
    readonly protectedAllowed?: boolean;
    readonly skillRequirements?: Readonly<Record<string, number>>;
    readonly trainingSkills?: readonly string[];
    readonly questRequirements?: readonly (string | QuestRequirementSpec)[];
    // The quest of a quest activity whose script cannot go on from a started journal (catalog questResumable false):
    // the quest sweep refuses it at entry (packages/workers/src/quest/resume.ts questEntry).
    readonly startedQuestRefused?: string;
    readonly wearableItemIds?: readonly number[];
    readonly requiredItems?: readonly RequiredItemSpec[];
    readonly coinsRequired?: number;
    readonly operatingCoinFloat?: number;
    readonly ferryFareHint?: number;
    readonly targetTile?: WorkerTile | null;
    readonly allowUnknownPos?: boolean;
    readonly requireSamePlaneWithoutWorld?: boolean;
    readonly combatSurvivability?: CombatSurvivabilityFloor;
    readonly cooldownKeys?: readonly string[];
    readonly spotId?: string;
    readonly maxConcurrentAccounts?: number;
    readonly includeBankCoins?: boolean;
    readonly requireTrustedBankCoins?: boolean;
    readonly routeBudgetMs?: number;
    // The activity this preflight is for: refused while the account's search for it found no route (no-route.ts).
    readonly activityId?: string;
    // The worker takes the boats east from Kandarin (quest sweep, evaluateTileReachability).
    readonly boatEastFromKandarin?: boolean;
    // The worker runs only from a start in this area and refuses any other start (a route that cannot walk to its
    // start). The account runs in place, so the target tile is not checked.
    readonly startArea?: StartArea;
    // The worker runs only while the account's xp in the skill is at most this much (a fresh-account route).
    readonly maxSkillXp?: Readonly<Record<string, number>>;
}

// A half-open box of world tiles on one level: x0 <= x < x1, z0 <= z < z1.
export interface StartArea {
    readonly level: number;
    readonly x0: number;
    readonly x1: number;
    readonly z0: number;
    readonly z1: number;
}

export const inStartArea = (pos: WorkerTile | null | undefined, area: StartArea): boolean =>
    !!pos && pos.level === area.level && pos.x >= area.x0 && pos.x < area.x1 && pos.z >= area.z0 && pos.z < area.z1;

const parseStartArea = (raw: unknown): StartArea | undefined => {
    if (!raw || typeof raw !== 'object') return undefined;
    const r = raw as Record<string, unknown>;
    const keys = ['level', 'x0', 'x1', 'z0', 'z1'] as const;
    if (!keys.every((k) => typeof r[k] === 'number' && Number.isSafeInteger(r[k]))) return undefined;
    return { level: r.level as number, x0: r.x0 as number, x1: r.x1 as number, z0: r.z0 as number, z1: r.z1 as number };
};

export function evaluatePreflight(
    acct: WorkerAccountView,
    spec: PreflightSpec,
    world: WorkerWorldView,
    _acctCache?: AccountLookupCache,
): PreflightResult {
    const blockers: PreflightBlocker[] = [];
    const missingItems: PreflightMissingItem[] = [];

    if (acct.protectedClock && spec.protectedAllowed !== true) {
        blockers.push({
            kind: 'protected_clock',
            message: `${acct.name} has protectedClock=true and activity is not launch-authorized`,
        });
    }

    if (spec.cooldownKeys && (acct.cooldowns || world.marketCooldowns)) {
        for (const key of spec.cooldownKeys) {
            const acctExpiry = acct.cooldowns?.[key];
            const worldExpiry = world.marketCooldowns?.[key];
            if (isCooldownActive(acct.cooldowns, key, world.at) && acctExpiry !== undefined) {
                blockers.push({
                    kind: 'cooldown_active',
                    key,
                    expiresAt: acctExpiry,
                    message: `Account cooldown active for ${key}`,
                });
            } else if (isCooldownActive(world.marketCooldowns, key, world.at) && worldExpiry !== undefined) {
                blockers.push({
                    kind: 'cooldown_active',
                    key,
                    expiresAt: worldExpiry,
                    message: `World cooldown active for ${key}`,
                });
            }
        }
    }

    if (spec.spotId && spec.maxConcurrentAccounts !== undefined) {
        if (!Number.isSafeInteger(spec.maxConcurrentAccounts) || spec.maxConcurrentAccounts < 1) {
            blockers.push({ kind: 'invalid_config', message: `invalid maxConcurrentAccounts for ${spec.spotId}` });
        } else {
            const active = world.spotOccupancy?.[spec.spotId] ?? 0;
            if (active >= spec.maxConcurrentAccounts) {
                blockers.push({
                    kind: 'capacity_full',
                    spotId: spec.spotId,
                    active,
                    limit: spec.maxConcurrentAccounts,
                    message: `Spot ${spec.spotId} at capacity (${active}/${spec.maxConcurrentAccounts})`,
                });
            }
        }
    }

    if (spec.trainingSkills && acct.maxLevels) {
        for (const skill of spec.trainingSkills) {
            const cap = acct.maxLevels[skill]
                ?? Object.entries(acct.maxLevels).find(
                    ([k]) => k.toLowerCase() === skill.trim().toLowerCase(),
                )?.[1];
            if (cap !== undefined) {
                const current = cachedAccountSkillLevel(acct, skill, _acctCache);
                if (current >= cap) {
                    blockers.push({
                        kind: 'max_level_cap',
                        skill,
                        maxLevel: cap,
                        current,
                        message: `${skill} ${current} reached maxLevels cap ${cap}`,
                    });
                }
            }
        }
    }

    if (spec.skillRequirements) {
        for (const [skill, required] of Object.entries(spec.skillRequirements)) {
            if (!Number.isSafeInteger(required) || required < 1) {
                blockers.push({ kind: 'invalid_config', message: `invalid skill requirement ${skill}=${required}` });
                continue;
            }
            const current = cachedAccountSkillLevel(acct, skill, _acctCache);
            if (current < required) {
                blockers.push({
                    kind: 'skill_level',
                    skill,
                    required,
                    current,
                    message: `${skill} ${current}/${required}`,
                });
            }
        }
    }

    if (spec.questRequirements && spec.questRequirements.length > 0) {
        for (const raw of spec.questRequirements) {
            const q = typeof raw === 'string' ? { quest: raw, requiredState: 'complete' as const } : { quest: raw.quest, requiredState: raw.requiredState ?? 'complete' as const };
            const currentState = cachedAccountQuestState(acct, q.quest, _acctCache);
            const satisfied = q.requiredState === 'started'
                ? currentState === 'started' || currentState === 'complete'
                : currentState === 'complete';
            if (!satisfied) {
                blockers.push({
                    kind: 'quest_incomplete',
                    quest: q.quest,
                    requiredState: q.requiredState,
                    currentState,
                    message: `Quest ${q.quest} is ${currentState}, requires ${q.requiredState}`,
                });
            }
        }
    }

    if (spec.maxSkillXp) {
        for (const [skill, max] of Object.entries(spec.maxSkillXp)) {
            const xp = cachedAccountSkillXp(acct, skill, _acctCache);
            if (xp > max) {
                blockers.push({
                    kind: 'invalid_config',
                    message: `${skill} xp ${xp} above ${max}: the route runs only for a fresh account`,
                });
            }
        }
    }

    const startsInPlace = spec.startArea !== undefined && inStartArea(acct.pos, spec.startArea);
    if (spec.startArea && !startsInPlace) {
        const p = acct.pos;
        blockers.push({
            kind: 'invalid_config',
            message: `start ${p ? `${p.x},${p.z},${p.level}` : 'unknown'} is outside the route's start area`,
        });
    }

    if (spec.startedQuestRefused && cachedAccountQuestState(acct, spec.startedQuestRefused, _acctCache) === 'started') {
        blockers.push({
            kind: 'invalid_config',
            message: `Quest ${spec.startedQuestRefused} is started and its script has no resume stage`,
        });
    }

    if (spec.wearableItemIds && spec.wearableItemIds.length > 0) {
        for (const itemId of spec.wearableItemIds) {
            const wear = canWearItem(acct, itemId);
            if (!wear.ok) {
                for (const [skill, req] of Object.entries(wear.missingSkills)) {
                    blockers.push({
                        kind: 'skill_level',
                        skill,
                        required: req,
                        current: cachedAccountSkillLevel(acct, skill, _acctCache),
                        message: `Item ${itemId} requires ${skill} ${req}`,
                    });
                }
                if (wear.missingQuest) {
                    blockers.push({
                        kind: 'quest_incomplete',
                        quest: wear.missingQuest,
                        requiredState: 'complete',
                        currentState: cachedAccountQuestState(acct, wear.missingQuest, _acctCache),
                        message: `Item ${itemId} requires quest ${wear.missingQuest}`,
                    });
                }
            }
        }
    }

    let coinsRequired = Math.max(0, spec.coinsRequired ?? 0);
    if (spec.requiredItems && spec.requiredItems.length > 0) {
        for (const req of spec.requiredItems) {
            if (!Number.isSafeInteger(req.itemId) || req.itemId < 0 || !Number.isSafeInteger(req.count) || req.count < 1) {
                blockers.push({ kind: 'invalid_config', message: `invalid required item ${req.itemId}:${req.count}` });
                continue;
            }
            if (req.itemId === COINS_ITEM_ID) {
                coinsRequired = Math.max(coinsRequired, req.count);
                continue;
            }
            const owned = accountOwnedItemCount(acct, req.itemId, {
                includeBank: req.includeBank ?? true,
                requireTrustedBank: req.requireTrustedBank ?? true,
            });
            const reserved = cachedEffectiveItemReserve(acct, world, req.itemId, _acctCache);
            const available = reserveAdjustedStock(owned, reserved);
            if (available < req.count) {
                blockers.push({
                    kind: 'missing_supply',
                    itemId: req.itemId,
                    ...(req.itemName ? { itemName: req.itemName } : {}),
                    required: req.count,
                    available,
                    reserved,
                    owned,
                    message: `Need ${req.count}x item ${req.itemId} (available after reserve: ${available})`,
                });
                missingItems.push({
                    itemId: req.itemId,
                    count: req.count - available,
                    ...(req.itemName ? { itemName: req.itemName } : {}),
                });
            }
        }
    }

    let coinBalance: ReturnType<typeof availableSpendableCoins> | undefined;
    const getCoinBalance = () => coinBalance ??= cachedAvailableSpendableCoins(
        acct,
        world,
        spec.operatingCoinFloat ?? DEFAULT_PREFLIGHT_COIN_FLOAT,
        {
            includeBank: spec.includeBankCoins ?? true,
            requireTrustedBank: spec.requireTrustedBankCoins ?? true,
        },
        _acctCache,
    );

    let travelCoins = Math.max(0, spec.ferryFareHint ?? 0);
    let travelTicks = 0;

    if (spec.targetTile && !spec.startArea) {
        const reach = evaluateTileReachability(acct, spec.targetTile, world, {
            ...(world.world ? { spendableCoins: getCoinBalance().totalUnreserved } : {}),
            deadlineMs: spec.routeBudgetMs,
            ferryFareHint: spec.ferryFareHint,
            requireSamePlaneWithoutWorld: spec.requireSamePlaneWithoutWorld,
            allowUnknownPos: spec.allowUnknownPos,
            boatEastFromKandarin: spec.boatEastFromKandarin,
            _acctCache,
        });
        travelCoins = reach.travelCoins;
        travelTicks = reach.travelTicks;
        if (!reach.reachable) {
            blockers.push({
                kind: 'unreachable_tile',
                target: spec.targetTile,
                from: acct.pos,
                reason: reach.reason,
                message: reach.message,
            });
        }
    }
    const searched = spec.activityId ? noRouteForActivity(accountNoRoutes(acct), acct.pos, spec.activityId, world.at) : undefined;
    if (searched && !blockers.some(b => b.kind === 'unreachable_tile')) {
        blockers.push({
            kind: 'unreachable_tile',
            target: searched.to,
            from: acct.pos,
            reason: 'no_route',
            message: noRouteMessage(acct.name, searched),
        });
    }

    const totalCoinNeed = coinsRequired + travelCoins;
    // Purchases must preserve operating float; ferry fares may use the operating float itself.
    if (coinsRequired > 0) {
        const cb = getCoinBalance();
        if (cb.spendable < coinsRequired) {
            blockers.push({
                kind: 'missing_coins',
                required: totalCoinNeed,
                available: cb.spendable,
                reserved: cb.reserved,
                escrow: cb.escrow,
                ferryFare: travelCoins,
                message: `Coins after reserves/escrow/float ${cb.spendable} < required ${coinsRequired}`,
            });
        } else if (totalCoinNeed > 0 && cb.totalUnreserved < totalCoinNeed) {
            blockers.push({
                kind: 'missing_coins',
                required: totalCoinNeed,
                available: cb.totalUnreserved,
                reserved: cb.reserved,
                escrow: cb.escrow,
                ferryFare: travelCoins,
                message: `Unreserved coins ${cb.totalUnreserved} < required ${totalCoinNeed} (including ${travelCoins} gp fare)`,
            });
        }
    } else if (totalCoinNeed > 0) {
        const cb = getCoinBalance();
        if (cb.totalUnreserved < totalCoinNeed) {
            blockers.push({
                kind: 'missing_coins',
                required: totalCoinNeed,
                available: cb.totalUnreserved,
                reserved: cb.reserved,
                escrow: cb.escrow,
                ferryFare: travelCoins,
                message: `Unreserved coins ${cb.totalUnreserved} < required ${totalCoinNeed} (including ${travelCoins} gp fare)`,
            });
        }
    }

    if (spec.combatSurvivability) {
        blockers.push(...evaluateCombatSurvivability(acct, spec.combatSurvivability, world, _acctCache));
    }

    const extra = {
        ...(travelCoins > 0 ? { travelCoins } : {}),
        ...(travelTicks > 0 ? { travelTicks } : {}),
        ...(missingItems.length > 0 ? { missingItems } : {}),
    };

    return blockers.length === 0 ? preflightOk(extra) : preflightFail(blockers, extra);
}

interface StaticActivityPreflight {
    // The recipe key of a herblore brew run (herblore:potions): the run needs herbs and a secondary for one recipe.
    readonly brewRecipe?: string;
    readonly protectedAllowed: boolean;
    readonly skillRequirements: Readonly<Record<string, number>>;
    readonly trainingSkills: readonly string[];
    readonly questRequirements: readonly (string | QuestRequirementSpec)[];
    readonly startedQuestRefused: string | undefined;
    readonly wearableItemIds: readonly number[];
    readonly staticRequiredItems: readonly RequiredItemSpec[];
    readonly coinsRequired: number | undefined;
    readonly operatingCoinFloat: number;
    readonly ferryFareHint: number | undefined;
    readonly targetTile: WorkerTile | null;
    readonly allowUnknownPos: boolean;
    readonly combatSurvivability: CombatSurvivabilityFloor | undefined;
    readonly spotId: string | undefined;
    readonly maxConcurrentAccounts: number | undefined;
    readonly boatEastFromKandarin: boolean;
    readonly questSweep: { readonly slug: string; readonly name: string } | undefined;
    readonly startArea: StartArea | undefined;
    readonly maxSkillXp: Readonly<Record<string, number>> | undefined;
}

// The items and coins that the quest sweep takes from the bank for an account (packages/workers/src/quest/bank-needs.ts):
// the preset items that no shop sells and no gather plan covers, and the preset coins with the price of the shop items,
// the NPC fees of the gather items that the account lacks and the boat fares from its tile. A complete quest needs none.
export function questSweepRequirements(
    acct: WorkerAccountView,
    quest: { readonly slug: string; readonly name: string },
    cache?: AccountLookupCache,
): { readonly items: readonly RequiredItemSpec[]; readonly coins: number } | null {
    const state = cachedAccountQuestState(acct, quest.name, cache);
    if (state === 'complete') return null;
    const need = questSweepNeeds(quest.slug, (skill) => cachedAccountSkillLevel(acct, skill, cache), state === 'started');
    const owned = (id: number) => accountOwnedItemCount(acct, id, { includeBank: true, requireTrustedBank: true });
    const byId = new Map<number, { count: number; name?: string }>();
    for (const row of need.bank) {
        if (row.for !== row.id && owned(row.for) >= row.forCount) continue;
        const prev = byId.get(row.id);
        byId.set(row.id, { count: (prev?.count ?? 0) + row.count, ...(row.name ? { name: row.name } : {}) });
    }
    const items: RequiredItemSpec[] = [...byId].map(([itemId, r]) => ({ itemId, count: r.count, ...(r.name ? { itemName: r.name } : {}) }));
    const skills = Object.fromEntries(Object.entries(acct.skills).map(([name, s]) => [name.toLowerCase(), s.level]));
    return { items, coins: questSweepCoins(need, owned, acct.pos ?? undefined, skills) };
}

const staticPreflightCache = new WeakMap<object, StaticActivityPreflight>();

function extractStaticActivityPreflight(activity: {
    readonly id?: string;
    readonly workerId?: string;
    readonly skill?: string;
    readonly skills?: readonly string[];
    readonly spotId?: string;
    readonly maxConcurrentAccounts?: number;
    readonly location?: WorkerTile;
    readonly protectedAllowed?: boolean;
    readonly config?: Readonly<Record<string, unknown>>;
}): StaticActivityPreflight {
    const cached = staticPreflightCache.get(activity);
    if (cached) return cached;
    const cfg = activity.config ?? {};
    const skillRequirements: Record<string, number> = {};
    for (const key of ['skillRequirements', 'requiredSkills'] as const) {
        const raw = cfg[key];
        if (raw && typeof raw === 'object') {
            for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
                if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1) {
                    skillRequirements[k] = Math.max(skillRequirements[k] ?? 1, v);
                }
            }
        }
    }
    const minLevelRaw = typeof cfg.requiredLevel === 'number' ? cfg.requiredLevel : cfg.minLevel;
    if (typeof minLevelRaw === 'number' && Number.isSafeInteger(minLevelRaw) && minLevelRaw >= 1 && activity.skill) {
        skillRequirements[activity.skill] = Math.max(skillRequirements[activity.skill] ?? 1, minLevelRaw);
    }
    const rawQuests = Array.isArray(cfg.requiredQuests)
        ? cfg.requiredQuests
        : Array.isArray(cfg.questRequirements)
            ? cfg.questRequirements
            : [];
    const questRequirements: (string | QuestRequirementSpec)[] = rawQuests as (string | QuestRequirementSpec)[];
    const wearableItemIds: number[] = Array.isArray(cfg.wearableItemIds)
        ? (cfg.wearableItemIds as unknown[]).filter((n): n is number => Number.isSafeInteger(n) && (n as number) >= 0)
        : [];
    const staticRequiredItems: RequiredItemSpec[] = [];
    if (Array.isArray(cfg.requiredTools)) {
        for (const id of cfg.requiredTools as unknown[]) {
            if (Number.isSafeInteger(id) && (id as number) >= 0) {
                staticRequiredItems.push({ itemId: id as number, count: 1 });
            }
        }
    }
    if (Array.isArray(cfg.requiredItems)) {
        for (const r of cfg.requiredItems as unknown[]) {
            if (!r || typeof r !== 'object') continue;
            const { itemId, count, includeBank } = r as { itemId?: unknown; count?: unknown; includeBank?: unknown };
            if (Number.isSafeInteger(itemId) && (itemId as number) >= 0 && Number.isSafeInteger(count) && (count as number) >= 1) {
                staticRequiredItems.push({ itemId: itemId as number, count: count as number, ...(typeof includeBank === 'boolean' ? { includeBank } : {}) });
            }
        }
    }
    let maxSkillXp: Record<string, number> | undefined;
    if (cfg.maxSkillXp && typeof cfg.maxSkillXp === 'object') {
        for (const [k, v] of Object.entries(cfg.maxSkillXp as Record<string, unknown>)) {
            if (typeof v === 'number' && Number.isFinite(v) && v >= 0) (maxSkillXp ??= {})[k] = v;
        }
    }
    const trainingSkills = [
        ...(activity.skill ? [activity.skill] : []),
        ...(activity.skills ?? []),
    ];
    const brewArgs = Array.isArray(cfg.defaultArgs) ? cfg.defaultArgs : Array.isArray(cfg.args) ? cfg.args : [];
    const brewEnv = (cfg.defaultEnv && typeof cfg.defaultEnv === 'object' ? cfg.defaultEnv : {}) as Record<string, unknown>;
    const brewRecipe = cfg.skill === 'herblore' && cfg.method === 'potions'
        ? String(brewArgs[1] ?? brewEnv.RECIPE ?? 'auto').toLowerCase()
        : undefined;
    const spec: StaticActivityPreflight = {
        ...(brewRecipe ? { brewRecipe } : {}),
        protectedAllowed: activity.protectedAllowed ?? false,
        skillRequirements,
        trainingSkills,
        questRequirements,
        startedQuestRefused: cfg.questResumable === false && typeof cfg.questSlug === 'string'
            ? (typeof cfg.questName === 'string' ? cfg.questName : cfg.questSlug)
            : undefined,
        wearableItemIds,
        staticRequiredItems,
        coinsRequired: typeof cfg.coinsRequired === 'number' && cfg.coinsRequired > 0 ? Math.ceil(cfg.coinsRequired) : undefined,
        operatingCoinFloat: typeof cfg.operatingCoinFloat === 'number' ? cfg.operatingCoinFloat : DEFAULT_PREFLIGHT_COIN_FLOAT,
        ferryFareHint: typeof cfg.ferryFareHint === 'number' ? cfg.ferryFareHint : undefined,
        targetTile: activity.location ?? null,
        allowUnknownPos: cfg.allowUnknownPos === true,
        combatSurvivability: cfg.combatSurvivability && typeof cfg.combatSurvivability === 'object'
            ? (cfg.combatSurvivability as CombatSurvivabilityFloor)
            : undefined,
        spotId: activity.spotId,
        maxConcurrentAccounts: activity.maxConcurrentAccounts,
        boatEastFromKandarin: activity.workerId === 'quest',
        questSweep: cfg.mode === 'sweep' && typeof cfg.questSlug === 'string'
            ? { slug: cfg.questSlug, name: typeof cfg.questName === 'string' ? cfg.questName : cfg.questSlug }
            : undefined,
        startArea: parseStartArea(cfg.startArea),
        maxSkillXp,
    };
    staticPreflightCache.set(activity, spec);
    return spec;
}

export function activityPreflightFromConfig(
    acct: WorkerAccountView,
    activity: {
        readonly id?: string;
        readonly workerId?: string;
        readonly skill?: string;
        readonly skills?: readonly string[];
        readonly spotId?: string;
        readonly maxConcurrentAccounts?: number;
        readonly location?: WorkerTile;
        readonly protectedAllowed?: boolean;
        readonly inputs?: readonly { readonly itemId: number; readonly countPerUnit: number; readonly reserve?: number; readonly unlessOwned?: readonly number[] }[];
        readonly config?: Readonly<Record<string, unknown>>;
    },
    world: WorkerWorldView,
    batchUnits = 1,
    opts?: { readonly protectedAllowed?: boolean; readonly _acctCache?: AccountLookupCache },
): PreflightResult {
    const base = extractStaticActivityPreflight(activity);
    let requiredItems: readonly RequiredItemSpec[] = base.staticRequiredItems;
    if (activity.inputs && activity.inputs.length > 0) {
        const clampedBatch = Math.max(1, batchUnits);
        const mutableItems: RequiredItemSpec[] = [...base.staticRequiredItems];
        for (const io of activity.inputs) {
            if (io.unlessOwned?.some(id => accountOwnedItemCount(acct, id, { includeBank: true, requireTrustedBank: true }) > 0)) continue;
            const count = Math.max(1, Math.ceil(io.countPerUnit * clampedBatch)) + Math.max(0, io.reserve ?? 0);
            mutableItems.push({ itemId: io.itemId, count });
        }
        requiredItems = mutableItems;
    }
    // A brew run refuses at its first bank visit without herbs and a secondary for one recipe at the account's
    // level (workers/src/bank-artisan/herblore-recipes.ts), so the preflight requires the item that it lacks.
    if (base.brewRecipe) {
        const stock = Object.fromEntries(BREW_STOCK_IDS.map((id) => [id, reserveAdjustedStock(
            accountOwnedItemCount(acct, id, { includeBank: true, requireTrustedBank: true }),
            cachedEffectiveItemReserve(acct, world, id, opts?._acctCache),
        )]));
        const short = brewShortfall(cachedAccountSkillLevel(acct, 'Herblore', opts?._acctCache), stock, base.brewRecipe);
        if (short) requiredItems = [...requiredItems, { itemId: short.itemId, count: 1 }];
    }
    let coinsRequired = base.coinsRequired;
    if (base.questSweep) {
        const sweep = questSweepRequirements(acct, base.questSweep, opts?._acctCache);
        if (sweep) {
            if (sweep.items.length > 0) requiredItems = [...requiredItems, ...sweep.items];
            if (sweep.coins > (coinsRequired ?? 0)) coinsRequired = sweep.coins;
        }
    }
    return evaluatePreflight(
        acct,
        {
            protectedAllowed: opts?.protectedAllowed ?? base.protectedAllowed,
            skillRequirements: base.skillRequirements,
            trainingSkills: base.trainingSkills,
            questRequirements: base.questRequirements,
            startedQuestRefused: base.startedQuestRefused,
            wearableItemIds: base.wearableItemIds,
            requiredItems,
            coinsRequired,
            operatingCoinFloat: base.operatingCoinFloat,
            ferryFareHint: base.ferryFareHint,
            targetTile: base.targetTile,
            allowUnknownPos: base.allowUnknownPos,
            combatSurvivability: base.combatSurvivability,
            spotId: base.spotId,
            maxConcurrentAccounts: base.maxConcurrentAccounts,
            ...(activity.id ? { activityId: activity.id } : {}),
            ...(base.boatEastFromKandarin ? { boatEastFromKandarin: true } : {}),
            ...(base.startArea ? { startArea: base.startArea } : {}),
            ...(base.maxSkillXp ? { maxSkillXp: base.maxSkillXp } : {}),
        },
        world,
        opts?._acctCache,
    );
}
