// Unified ActivityCatalog covering all 9 worker families, AIO routes, knowledge/skills.json actions, and all 68 quests.
// Derives baseline XP/item/GP rates and setupTicks from knowledge/ + travel cache with minBatchUnits floors.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { repoRoot } from '../../core/src/practice-paths';
import { questDefinitions } from '../../core/src/quest-status';
import {
    TRUST_TIER_RANK,
    trustMeetsMinimum,
    type TrustTier,
    type WorkerFamily,
    type WorkerKind,
    type WorkerTile,
} from '../../workers/src/contracts';
import { validateActivityDefinition, type ActivityDefinition, type ActivityIO } from './contracts';

const XP_MULTIPLIER = 25;

// Blocked AIO route keys that require external multi-process partners or live GE service (from aio-bench-cases.ts).
export const BLOCKED_AIO_KEYS: ReadonlySet<string> = new Set([
    'skiller:woodcutting:loop',
    'skiller:cooking:ge-cook',
    'skiller:firemaking:ge',
    'logistics:give-to-banker',
    'logistics:take-from-banker',
    'logistics:supply-holder',
    'logistics:gathering-supplier',
    'logistics:specialist-supplier',
    'fighter:attack-specialist',
    'quester:mode:hero-owned',
    'quester:mode:legends-owned',
    'logistics:loadout-import',
    'pvp:pilot',
    'logistics:banker',
    'logistics:food-chain',
    'logistics:supply-chain',
    'logistics:fleet-trade',
    'market:ge-buy-list',
    'market:ge-trip',
    'market:ge-plan',
    'market:bank-seller',
    'market:ge-sell',
    'market:shop-to-bid',
    'market:ge-buy',
]);

// Known non-passing AIO route keys marked experimental until fixed.
export const EXPERIMENTAL_AIO_KEYS: ReadonlySet<string> = new Set([
    'market:shop-buy',
    'skiller:foraging:crystal-chest',
]);

export const HUB_TILES = {
    lumbridge: { x: 3222, z: 3218, level: 0 },
    draynor: { x: 3092, z: 3243, level: 0 },
    varrock_west: { x: 3185, z: 3436, level: 0 },
    varrock_east: { x: 3253, z: 3420, level: 0 },
    alkharid: { x: 3269, z: 3167, level: 0 },
    falador_east: { x: 3013, z: 3355, level: 0 },
    falador_west: { x: 2947, z: 3368, level: 0 },
    edgeville: { x: 3094, z: 3491, level: 0 },
    catherby: { x: 2809, z: 3441, level: 0 },
    seers: { x: 2727, z: 3492, level: 0 },
    ardougne_north: { x: 2618, z: 3332, level: 0 },
    ardougne_south: { x: 2655, z: 3283, level: 0 },
    ardougne_market: { x: 2662, z: 3305, level: 0 },
    wizards_tower: { x: 3110, z: 3170, level: 0 },
    khazard_field: { x: 2567, z: 3199, level: 0 },
    kbd_lair: { x: 2271, z: 4680, level: 0 },
    wildy_ditch: { x: 3094, z: 3520, level: 0 },
} as const satisfies Record<string, WorkerTile>;

export interface ActivityCatalogFilter {
    readonly family?: WorkerFamily;
    readonly workerId?: string;
    readonly kind?: WorkerKind;
    readonly skill?: string;
    readonly questSlug?: string;
    readonly outputItemId?: number;
    readonly minTrust?: TrustTier;
    readonly protectedAllowed?: boolean;
}

export interface ActivityCatalog {
    get(id: string): ActivityDefinition | undefined;
    require(id: string): ActivityDefinition;
    has(id: string): boolean;
    list(filter?: ActivityCatalogFilter): readonly ActivityDefinition[];
    byFamily(family: WorkerFamily): readonly ActivityDefinition[];
    byWorkerKind(kind: WorkerKind): readonly ActivityDefinition[];
    findByOutputItem(itemId: number): readonly ActivityDefinition[];
    findBySkill(skill: string): readonly ActivityDefinition[];
    findByQuest(slug: string): readonly ActivityDefinition[];
    size(): number;
}

export interface ActivityCatalogOptions {
    readonly root?: string;
    readonly benchPassedIds?: ReadonlySet<string>;
    readonly liveProvenIds?: ReadonlySet<string>;
    readonly launchQualifiedIds?: ReadonlySet<string>;
    readonly extraActivities?: readonly ActivityDefinition[];
}

interface KnowledgeItem {
    readonly id: number;
    readonly name: string;
    readonly debugname: string;
    readonly cost: number;
    readonly members: boolean;
    readonly tradeable: boolean;
}

interface KnowledgeSkillRow {
    readonly skill: string;
    readonly table: string;
    readonly row: string;
    readonly level: number;
    readonly xp: number | null;
    readonly inputs: string[];
    readonly outputs: string[];
    readonly at: { locs?: string[]; npcs?: string[] };
}

interface KnowledgeRateRow {
    readonly method: string;
    readonly skill: string;
    readonly level: number;
    readonly xpPerTick: number;
}

interface KnowledgeQuestRow {
    readonly varp: string;
    readonly folder: string | null;
    readonly complete: number;
    readonly questPoints: number;
    readonly xp: { skill: string; xp: number }[];
}

interface TravelCacheData {
    readonly banks?: Record<string, { x: number; z: number; level?: number }>;
    readonly nearestBank?: Record<string, { bank: string; runTicks: number }>;
}

const QUEST_SCRIPT_ALIAS: Readonly<Record<string, string>> = {
    quest_romeojuliet: 'rj',
    quest_scorpcatcher: 'scorpion',
    quest_blackarmgang: 'arrav',
    quest_arthur: 'merlin',
    quest_mcannon: 'dwarfcannon',
    quest_itexam: 'dig',
    quest_waterfall: 'waterfall',
    quest_elemental_workshop: 'elemental',
};

const QUEST_FOLDER_BY_VARP: Readonly<Record<string, string>> = {
    goblinquest: 'quest_gobdip',
    elenaquest: 'quest_elena',
    waterfall_quest: 'quest_waterfall',
    horrorquest: 'quest_horror',
};

const QUEST_ESTIMATE_TICKS: Readonly<Record<string, number>> = {
    cook: 35,
    sheep: 60,
    doric: 75,
    gobdip: 110,
    imp: 140,
    elemental: 240,
    drunkmonk: 250,
    druid: 280,
    murder: 300,
    hunt: 310,
    blackknight: 330,
    fishingcompo: 360,
    seaslug: 420,
    chompybird: 520,
    squire: 540,
    merlin: 640,
    ball: 700,
    scorpion: 900,
    ikov: 950,
    mortton: 980,
    grail: 1050,
    tree: 1020,
    waterfall: 1020,
    crest: 1060,
    dragon: 1180,
    desertrescue: 1380,
    zanaris: 1420,
    troll: 1480,
    tbwt: 1550,
    hero: 1800,
    dwarfcannon: 1980,
    grandtree: 2040,
    dig: 2180,
    runemysteries: 2950,
    legends: 3900,
};

function safeReadJson<T>(path: string, fallback: T): T {
    if (!existsSync(path)) return fallback;
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch {
        return fallback;
    }
}

function estimateTravelTicksFromNearestBank(location: WorkerTile | undefined, travel: TravelCacheData): number {
    if (!location) return 8;
    const banks = Object.values(travel.banks ?? HUB_TILES);
    let minCheb = Number.POSITIVE_INFINITY;
    for (const b of banks) {
        if ((b.level ?? 0) !== location.level) continue;
        const d = Math.max(Math.abs(b.x - location.x), Math.abs(b.z - location.z));
        if (d < minCheb) minCheb = d;
    }
    if (!Number.isFinite(minCheb)) return 24;
    return Math.max(4, Math.ceil(minCheb * 0.6) + 6);
}

function titleCase(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function questSlugFromFolder(folder: string): string {
    if (QUEST_SCRIPT_ALIAS[folder]) return QUEST_SCRIPT_ALIAS[folder]!;
    return folder.replace(/^quest_/, '').replace(/_/g, '');
}

function tableActionTicks(table: string): number {
    switch (table) {
        case 'woodcutting_trees': return 6;
        case 'mining_table': return 5;
        case 'cooking_generic': return 4;
        case 'smithing': return 5;
        case 'smelting.struct': return 5;
        case 'fletching_table': return 2;
        case 'craft_leather_table': return 3;
        case 'gem_cutting_table': return 2;
        case 'runecraft_table': return 3;
        case 'magic_spell_table': return 4;
        case 'pickpocket': return 4;
        case 'stealing': return 5;
        case 'trapped_chest': return 6;
        case 'firemaking.obj': return 4;
        case 'brew_potion.struct': return 3;
        default: return 4;
    }
}

function tableFamily(table: string): WorkerFamily {
    if (table === 'runecraft_table') return 'runecraft';
    if (['woodcutting_trees', 'mining_table', 'pickpocket', 'stealing', 'trapped_chest'].includes(table)) {
        return 'gather';
    }
    return 'bank-artisan';
}

function tableKind(table: string): WorkerKind {
    if (['woodcutting_trees', 'mining_table', 'pickpocket', 'stealing', 'trapped_chest'].includes(table)) {
        return 'gather';
    }
    if (['cooking_generic', 'smithing', 'smelting.struct', 'fletching_table', 'craft_leather_table', 'gem_cutting_table', 'brew_potion.struct', 'runecraft_table'].includes(table)) {
        return 'produce';
    }
    return 'train';
}

function skillerFamily(skill: string, method: string): { family: WorkerFamily; kind: WorkerKind } {
    if (skill === 'agility') return { family: 'agility', kind: 'train' };
    if (skill === 'runecraft') return { family: 'runecraft', kind: 'produce' };
    if (skill === 'magic' && ['npc', 'splash', 'splash-coop'].includes(method)) {
        return { family: 'combat', kind: 'train' };
    }
    if (['fishing', 'woodcutting', 'mining', 'thieving', 'foraging'].includes(skill)) {
        return { family: 'gather', kind: method === 'specialist' || method === 'bootstrap55' || method === 'fresh45' || method === 'fly30' ? 'train' : 'gather' };
    }
    return { family: 'bank-artisan', kind: ['cooking', 'smithing', 'fletching', 'crafting', 'herblore'].includes(skill) && method !== 'specialist' && method !== 'order' ? 'produce' : 'train' };
}

function makeIOList(
    debugNames: readonly string[],
    byDebug: ReadonlyMap<string, KnowledgeItem>,
    perUnit = 1,
): { io: ActivityIO[]; map: Record<number, number> } {
    const counts = new Map<number, number>();
    for (const raw of debugNames) {
        const clean = raw.replace(/^cert_/, '');
        const item = byDebug.get(clean);
        if (!item) continue;
        counts.set(item.id, (counts.get(item.id) ?? 0) + perUnit);
    }
    const io: ActivityIO[] = [];
    const map: Record<number, number> = {};
    for (const [itemId, countPerUnit] of counts) {
        io.push({ itemId, countPerUnit });
        map[itemId] = countPerUnit;
    }
    return { io, map };
}

interface SkillerSeed {
    readonly skill: string;
    readonly method: string;
    readonly script: string;
    readonly label: string;
    readonly location?: WorkerTile;
    readonly spotId?: string;
    readonly maxConcurrentAccounts?: number;
    readonly xpPerTick?: number;
    readonly unitsPerTick?: number;
    readonly gpPerTick?: number;
    readonly minBatchUnits?: number;
    readonly requiredLevel?: number;
    readonly outputs?: readonly { itemId: number; countPerUnit: number }[];
    readonly inputs?: readonly { itemId: number; countPerUnit: number }[];
    readonly defaultArgs?: readonly string[];
    readonly defaultEnv?: Readonly<Record<string, string>>;
}

const SKILLER_SPECS: readonly SkillerSeed[] = [
    // Fishing
    { skill: 'fishing', method: 'shark', script: 'scripts/shark-supply.ts', label: 'Harpoon and cook sharks at Catherby', location: HUB_TILES.catherby, spotId: 'catherby-sharks', maxConcurrentAccounts: 6, xpPerTick: 28, unitsPerTick: 0.08, gpPerTick: 4, minBatchUnits: 26, requiredLevel: 76, outputs: [{ itemId: 385, countPerUnit: 1 }] },
    { skill: 'fishing', method: 'cage', script: 'scripts/gather-fish.ts', label: 'Cage lobsters at Catherby', location: HUB_TILES.catherby, spotId: 'catherby-lobsters', maxConcurrentAccounts: 6, xpPerTick: 45, unitsPerTick: 0.14, gpPerTick: 2.5, minBatchUnits: 27, requiredLevel: 40, outputs: [{ itemId: 377, countPerUnit: 1 }], defaultArgs: ['cage'], defaultEnv: { CAP: '3000' } },
    { skill: 'fishing', method: 'harpoon', script: 'scripts/gather-fish.ts', label: 'Harpoon tuna/swordfish at Catherby', location: HUB_TILES.catherby, spotId: 'catherby-harpoon', maxConcurrentAccounts: 6, xpPerTick: 42, unitsPerTick: 0.12, gpPerTick: 2, minBatchUnits: 27, requiredLevel: 35, outputs: [{ itemId: 371, countPerUnit: 1 }], defaultArgs: ['harpoon'], defaultEnv: { CAP: '3000' } },
    { skill: 'fishing', method: 'fishcook', script: 'scripts/fishcook.ts', label: 'Lumbridge 3-tick fly fishing and cooking', location: HUB_TILES.lumbridge, spotId: 'lumbridge-fly-fish', maxConcurrentAccounts: 6, xpPerTick: 75, unitsPerTick: 0.25, gpPerTick: 0.5, minBatchUnits: 26, requiredLevel: 20, outputs: [{ itemId: 333, countPerUnit: 1 }] },
    { skill: 'fishing', method: 'village', script: 'scripts/microbot-village-fishing.ts', label: 'Barbarian Village fly/bait fishing', location: { x: 3106, z: 3433, level: 0 }, spotId: 'barbarian-fishing', maxConcurrentAccounts: 6, xpPerTick: 65, unitsPerTick: 0.22, gpPerTick: 0, minBatchUnits: 27, requiredLevel: 1 },
    { skill: 'fishing', method: 'staged', script: 'scripts/microbot-b-fishing.ts', label: 'Staged native fishing profiles', location: HUB_TILES.lumbridge, xpPerTick: 55, unitsPerTick: 0.18, gpPerTick: 0, minBatchUnits: 27, requiredLevel: 1 },
    { skill: 'fishing', method: 'fly30', script: 'scripts/generated/fishing30.ts', label: 'Fresh account fly fishing to 30', location: HUB_TILES.lumbridge, xpPerTick: 45, unitsPerTick: 0.2, gpPerTick: 0, minBatchUnits: 25, requiredLevel: 1 },
    { skill: 'fishing', method: 'specialist', script: 'scripts/fishing-specialist.ts', label: 'Fishing 1-99 specialist route', location: HUB_TILES.lumbridge, xpPerTick: 165, unitsPerTick: 0.35, gpPerTick: 0, minBatchUnits: 28, requiredLevel: 1 },
    // Cooking
    { skill: 'cooking', method: 'food', script: 'scripts/cook-food.ts', label: 'Cook raw fish at Catherby range', location: HUB_TILES.catherby, xpPerTick: 320, unitsPerTick: 0.22, gpPerTick: 0.5, minBatchUnits: 28, requiredLevel: 1, outputs: [{ itemId: 379, countPerUnit: 1 }], inputs: [{ itemId: 377, countPerUnit: 1 }] },
    { skill: 'cooking', method: 'stock', script: 'scripts/cook-stock.ts', label: 'Cook banked raw stock with burn reconciliation', location: HUB_TILES.draynor, xpPerTick: 280, unitsPerTick: 0.2, gpPerTick: 0, minBatchUnits: 28, requiredLevel: 1 },
    { skill: 'cooking', method: 'wine', script: 'scripts/cook-wine.ts', label: 'Ferment jugs of wine', location: HUB_TILES.draynor, xpPerTick: 1800, unitsPerTick: 0.4, gpPerTick: -2, minBatchUnits: 14, requiredLevel: 35, outputs: [{ itemId: 1993, countPerUnit: 1 }], inputs: [{ itemId: 1987, countPerUnit: 1 }, { itemId: 1937, countPerUnit: 1 }] },
    { skill: 'cooking', method: 'mixed-wine', script: 'scripts/microbot-wine.ts', label: 'Bank-staged wine fermentation', location: HUB_TILES.draynor, xpPerTick: 1800, unitsPerTick: 0.4, gpPerTick: -2, minBatchUnits: 14, requiredLevel: 35, outputs: [{ itemId: 1993, countPerUnit: 1 }], inputs: [{ itemId: 1987, countPerUnit: 1 }, { itemId: 1937, countPerUnit: 1 }] },
    { skill: 'cooking', method: 'batch', script: 'scripts/microbot-b-cooking.ts', label: 'Staged range/fire cooking batch', location: HUB_TILES.catherby, xpPerTick: 300, unitsPerTick: 0.22, gpPerTick: 0, minBatchUnits: 28, requiredLevel: 1 },
    { skill: 'cooking', method: 'ge-cook', script: 'scripts/microbot-ge-cooking.ts', label: 'GE-restocked cooking batch', location: HUB_TILES.varrock_west, xpPerTick: 300, unitsPerTick: 0.22, gpPerTick: -1, minBatchUnits: 28, requiredLevel: 1 },
    { skill: 'cooking', method: 'specialist', script: 'scripts/cooking-specialist.ts', label: 'Cooking 1-99 specialist route', location: HUB_TILES.draynor, xpPerTick: 2400, unitsPerTick: 0.45, gpPerTick: 0, minBatchUnits: 14, requiredLevel: 1 },
    // Woodcutting
    { skill: 'woodcutting', method: 'edgeville', script: 'scripts/edgeville-woodcut-order.ts', label: 'Edgeville tree/oak/yew woodcutting', location: HUB_TILES.edgeville, spotId: 'edgeville-yews', maxConcurrentAccounts: 4, xpPerTick: 95, unitsPerTick: 0.14, gpPerTick: 2, minBatchUnits: 28, requiredLevel: 1, outputs: [{ itemId: 1521, countPerUnit: 1 }] },
    { skill: 'woodcutting', method: 'yews', script: 'scripts/gather-yews.ts', label: 'Chop and bank yew logs', location: HUB_TILES.edgeville, spotId: 'edgeville-yews', maxConcurrentAccounts: 4, xpPerTick: 110, unitsPerTick: 0.04, gpPerTick: 6, minBatchUnits: 28, requiredLevel: 60, outputs: [{ itemId: 1515, countPerUnit: 1 }] },
    { skill: 'woodcutting', method: 'fresh45', script: 'scripts/generated/woodcutting.ts', label: 'Fresh woodcutting 1-45 at Draynor', location: HUB_TILES.draynor, spotId: 'draynor-willows', maxConcurrentAccounts: 6, xpPerTick: 140, unitsPerTick: 0.22, gpPerTick: 0.5, minBatchUnits: 28, requiredLevel: 1, outputs: [{ itemId: 1519, countPerUnit: 1 }] },
    { skill: 'woodcutting', method: 'loop', script: 'scripts/wc-loop.ts', label: 'Continuous woodcutting loop', location: HUB_TILES.draynor, xpPerTick: 100, unitsPerTick: 0.16, gpPerTick: 0, minBatchUnits: 28, requiredLevel: 1 },
    { skill: 'woodcutting', method: 'specialist', script: 'scripts/woodcutting-specialist.ts', label: 'Woodcutting 1-99 specialist route', location: HUB_TILES.draynor, xpPerTick: 320, unitsPerTick: 0.3, gpPerTick: 0, minBatchUnits: 28, requiredLevel: 1 },
    // Firemaking
    { skill: 'firemaking', method: 'order', script: 'scripts/firemaking-order.ts', label: 'Line firemaking from banked logs', location: HUB_TILES.draynor, xpPerTick: 500, unitsPerTick: 0.22, gpPerTick: -2, minBatchUnits: 27, requiredLevel: 1, inputs: [{ itemId: 1511, countPerUnit: 1 }] },
    { skill: 'firemaking', method: 'line', script: 'scripts/firemaking-line.ts', label: 'Runner line firemaking with helpers', location: HUB_TILES.draynor, xpPerTick: 750, unitsPerTick: 0.25, gpPerTick: 0, minBatchUnits: 27, requiredLevel: 1 },
    { skill: 'firemaking', method: 'ge', script: 'scripts/microbot-ge-firemaking.ts', label: 'GE-supplied firemaking batch', location: HUB_TILES.varrock_west, xpPerTick: 500, unitsPerTick: 0.22, gpPerTick: -2, minBatchUnits: 27, requiredLevel: 1 },
    { skill: 'firemaking', method: 'specialist', script: 'scripts/firemaking-specialist.ts', label: 'Firemaking 1-99 specialist route', location: HUB_TILES.lumbridge, xpPerTick: 1200, unitsPerTick: 0.25, gpPerTick: 0, minBatchUnits: 27, requiredLevel: 1 },
    // Fletching
    { skill: 'fletching', method: 'arrows', script: 'scripts/fletch-arrows.ts', label: 'Fletch shafts, headless and tipped arrows', location: HUB_TILES.draynor, xpPerTick: 950, unitsPerTick: 1.5, gpPerTick: -1, minBatchUnits: 150, requiredLevel: 1, outputs: [{ itemId: 53, countPerUnit: 1 }], inputs: [{ itemId: 52, countPerUnit: 1 }, { itemId: 314, countPerUnit: 1 }] },
    { skill: 'fletching', method: 'shafts', script: 'scripts/fletch-arrows.ts', label: 'Fletch arrow shafts from banked logs', location: HUB_TILES.draynor, xpPerTick: 120, unitsPerTick: 3.5, gpPerTick: 0, minBatchUnits: 27, requiredLevel: 1, outputs: [{ itemId: 52, countPerUnit: 15 }], inputs: [{ itemId: 1511, countPerUnit: 1 }], defaultEnv: { MODE: 'shafts' } },
    { skill: 'fletching', method: 'worker', script: 'scripts/fletch-worker.ts', label: 'Fletch shortbows and longbows', location: HUB_TILES.draynor, xpPerTick: 480, unitsPerTick: 0.25, gpPerTick: 1, minBatchUnits: 27, requiredLevel: 5 },
    { skill: 'fletching', method: 'specialist', script: 'scripts/fletching-specialist.ts', label: 'Fletching 1-99 specialist route', location: HUB_TILES.lumbridge, xpPerTick: 1800, unitsPerTick: 2.5, gpPerTick: 0, minBatchUnits: 150, requiredLevel: 1 },
    // Mining
    { skill: 'mining', method: 'ore', script: 'scripts/gather-ore.ts', label: 'Mine and bank ores at Varrock mine', location: { x: 3286, z: 3368, level: 0 }, spotId: 'varrock-se-mine', maxConcurrentAccounts: 4, xpPerTick: 65, unitsPerTick: 0.14, gpPerTick: 3, minBatchUnits: 27, requiredLevel: 1, outputs: [{ itemId: 440, countPerUnit: 1 }] },
    { skill: 'mining', method: 'essence', script: 'scripts/gather-essence.ts', label: 'Mine and bank Rune essence at Varrock', location: HUB_TILES.varrock_east, spotId: 'essence-mine', maxConcurrentAccounts: 8, xpPerTick: 35, unitsPerTick: 0.28, gpPerTick: 3, minBatchUnits: 27, requiredLevel: 1, outputs: [{ itemId: 1436, countPerUnit: 1 }] },
    { skill: 'mining', method: 'at-site', script: 'scripts/microbot-b-mining.ts', label: 'Staged at-site rock mining', location: { x: 3286, z: 3368, level: 0 }, xpPerTick: 95, unitsPerTick: 0.18, gpPerTick: 0, minBatchUnits: 28, requiredLevel: 1 },
    { skill: 'mining', method: 'drop', script: 'scripts/microbot-mining-drop.ts', label: 'Power-mine and drop ore', location: { x: 3286, z: 3368, level: 0 }, spotId: 'varrock-se-mine', maxConcurrentAccounts: 4, xpPerTick: 140, unitsPerTick: 0.2, gpPerTick: 0, minBatchUnits: 28, requiredLevel: 15 },
    { skill: 'mining', method: 'progressive', script: 'scripts/microbot-mining-progressive.ts', label: 'Progressive level-unlocked mining', location: { x: 3286, z: 3368, level: 0 }, xpPerTick: 110, unitsPerTick: 0.16, gpPerTick: 0, minBatchUnits: 28, requiredLevel: 1 },
    { skill: 'mining', method: 'loot', script: 'scripts/microbot-b-mining-loot.ts', label: 'Mine and bank with gem/loot retention', location: { x: 3286, z: 3368, level: 0 }, xpPerTick: 65, unitsPerTick: 0.14, gpPerTick: 3, minBatchUnits: 27, requiredLevel: 1 },
    { skill: 'mining', method: 'lava-maze', script: 'scripts/lava-maze-escorted-ore.ts', label: 'Wilderness Lava Maze runite ore mining', location: HUB_TILES.edgeville, spotId: 'lava-maze-runite', maxConcurrentAccounts: 2, xpPerTick: 45, unitsPerTick: 0.015, gpPerTick: 18, minBatchUnits: 5, requiredLevel: 85, outputs: [{ itemId: 451, countPerUnit: 1 }] },
    { skill: 'mining', method: 'specialist', script: 'scripts/mining-specialist.ts', label: 'Mining 1-99 specialist route', location: HUB_TILES.ardougne_south, xpPerTick: 240, unitsPerTick: 0.3, gpPerTick: 0, minBatchUnits: 28, requiredLevel: 1 },
    // Smithing
    { skill: 'smithing', method: 'smelt', script: 'scripts/smelt-bars.ts', label: 'Smelt bars at Al Kharid furnace', location: HUB_TILES.alkharid, xpPerTick: 120, unitsPerTick: 0.16, gpPerTick: 2, minBatchUnits: 14, requiredLevel: 1, outputs: [{ itemId: 2353, countPerUnit: 1 }], inputs: [{ itemId: 440, countPerUnit: 1 }, { itemId: 453, countPerUnit: 2 }] },
    { skill: 'smithing', method: 'anvil', script: 'scripts/smelt-bars.ts', label: 'Smith bars on Varrock West anvil', location: HUB_TILES.varrock_west, xpPerTick: 350, unitsPerTick: 0.2, gpPerTick: 1, minBatchUnits: 25, requiredLevel: 1, inputs: [{ itemId: 2351, countPerUnit: 1 }], defaultEnv: { ORDER_ACTION: 'smith' } },
    { skill: 'smithing', method: 'cannonballs', script: 'scripts/microbot-a-cannonballs.ts', label: 'Smelt steel bars into cannonballs', location: HUB_TILES.alkharid, xpPerTick: 75, unitsPerTick: 0.4, gpPerTick: 4, minBatchUnits: 27, requiredLevel: 35, outputs: [{ itemId: 2, countPerUnit: 4 }], inputs: [{ itemId: 2353, countPerUnit: 1 }] },
    { skill: 'smithing', method: 'specialist', script: 'scripts/smithing-specialist.ts', label: 'Smithing 1-99 specialist route', location: HUB_TILES.varrock_west, xpPerTick: 950, unitsPerTick: 0.28, gpPerTick: 0, minBatchUnits: 27, requiredLevel: 1 },
    // Crafting
    { skill: 'crafting', method: 'bowstrings', script: 'scripts/spin-bowstrings.ts', label: 'Spin flax into bowstrings at Seers wheel', location: HUB_TILES.seers, xpPerTick: 65, unitsPerTick: 0.18, gpPerTick: 4, minBatchUnits: 28, requiredLevel: 10, outputs: [{ itemId: 1777, countPerUnit: 1 }], inputs: [{ itemId: 1779, countPerUnit: 1 }] },
    { skill: 'crafting', method: 'jewellery', script: 'scripts/microbot-b-jewellery.ts', label: 'Craft jewellery at furnace', location: HUB_TILES.alkharid, xpPerTick: 160, unitsPerTick: 0.2, gpPerTick: 2, minBatchUnits: 14, requiredLevel: 5 },
    { skill: 'crafting', method: 'jewellery-trip', script: 'scripts/microbot-jewellery-trip.ts', label: 'Bank-to-furnace jewellery crafting trip', location: HUB_TILES.alkharid, xpPerTick: 160, unitsPerTick: 0.2, gpPerTick: 2, minBatchUnits: 14, requiredLevel: 5 },
    { skill: 'crafting', method: 'legacy-jewelry', script: 'scripts/craft-jewelry.ts', label: 'Gem cutting at Al Kharid bank', location: HUB_TILES.alkharid, xpPerTick: 450, unitsPerTick: 0.35, gpPerTick: 0, minBatchUnits: 27, requiredLevel: 20 },
    { skill: 'crafting', method: 'glass', script: 'scripts/microbot-glass.ts', label: 'Smelt and blow molten glass', location: HUB_TILES.varrock_west, xpPerTick: 240, unitsPerTick: 0.18, gpPerTick: 1, minBatchUnits: 14, requiredLevel: 46 },
    { skill: 'crafting', method: 'tanning', script: 'scripts/microbot-c-tanner.ts', label: 'Tan cowhides and dragonhides at Al Kharid', location: HUB_TILES.alkharid, xpPerTick: 0, unitsPerTick: 0.28, gpPerTick: 3, minBatchUnits: 27, requiredLevel: 1, outputs: [{ itemId: 1741, countPerUnit: 1 }], inputs: [{ itemId: 1739, countPerUnit: 1 }] },
    { skill: 'crafting', method: 'black-dhide-sets', script: 'scripts/black-dhide-sets.ts', label: 'Tan black dhide and craft full sets', location: HUB_TILES.alkharid, xpPerTick: 520, unitsPerTick: 0.04, gpPerTick: 5, minBatchUnits: 5, requiredLevel: 84, inputs: [{ itemId: 1747, countPerUnit: 6 }] },
    { skill: 'crafting', method: 'soften-clay', script: 'scripts/soften-clay.ts', label: 'Soften clay with water sources', location: HUB_TILES.varrock_west, xpPerTick: 0, unitsPerTick: 0.3, gpPerTick: 2, minBatchUnits: 14, requiredLevel: 1, outputs: [{ itemId: 1761, countPerUnit: 1 }], inputs: [{ itemId: 434, countPerUnit: 1 }] },
    { skill: 'crafting', method: 'inventory', script: 'scripts/microbot-production.ts', label: 'Bank-staged inventory crafting (gems/leather/staves)', location: HUB_TILES.draynor, xpPerTick: 650, unitsPerTick: 0.35, gpPerTick: -2, minBatchUnits: 27, requiredLevel: 1 },
    { skill: 'crafting', method: 'progressive', script: 'scripts/microbot-production-progressive.ts', label: 'Progressive inventory crafting', location: HUB_TILES.draynor, xpPerTick: 320, unitsPerTick: 0.28, gpPerTick: 0, minBatchUnits: 27, requiredLevel: 1 },
    { skill: 'crafting', method: 'specialist', script: 'scripts/crafting-specialist.ts', label: 'Crafting 1-99 specialist route', location: HUB_TILES.draynor, xpPerTick: 2400, unitsPerTick: 0.8, gpPerTick: 0, minBatchUnits: 27, requiredLevel: 1 },
    // Herblore
    { skill: 'herblore', method: 'potions', script: 'scripts/brew-potions.ts', label: 'Clean herbs and brew finished potions', location: HUB_TILES.draynor, xpPerTick: 550, unitsPerTick: 0.28, gpPerTick: 0, minBatchUnits: 14, requiredLevel: 3 },
    { skill: 'herblore', method: 'meats', script: 'scripts/druid-meats.ts', label: 'Prepare meats for Druidic Ritual', location: HUB_TILES.draynor, xpPerTick: 120, unitsPerTick: 0.02, gpPerTick: 0, minBatchUnits: 1, requiredLevel: 1 },
    { skill: 'herblore', method: 'specialist', script: 'scripts/herblore-specialist.ts', label: 'Herblore 1-99 specialist route', location: HUB_TILES.edgeville, xpPerTick: 1500, unitsPerTick: 0.5, gpPerTick: 0, minBatchUnits: 14, requiredLevel: 1 },
    // Runecraft
    { skill: 'runecraft', method: 'bank-craft', script: 'scripts/rune-bank-craft.ts', label: 'Craft banked essence at best unlocked altar', location: HUB_TILES.falador_east, xpPerTick: 48, unitsPerTick: 0.16, gpPerTick: 4, minBatchUnits: 27, requiredLevel: 1, inputs: [{ itemId: 1436, countPerUnit: 1 }] },
    { skill: 'runecraft', method: 'nature', script: 'scripts/microbot-rune-trip.ts', label: 'Shilo Village Nature altar trips', location: { x: 2852, z: 2955, level: 0 }, xpPerTick: 55, unitsPerTick: 0.12, gpPerTick: 12, minBatchUnits: 27, requiredLevel: 44, outputs: [{ itemId: 561, countPerUnit: 1 }], inputs: [{ itemId: 1436, countPerUnit: 1 }] },
    { skill: 'runecraft', method: 'supply', script: 'scripts/rune-supply.ts', label: 'Fresh Rune Mysteries + essence + air craft', location: HUB_TILES.varrock_east, xpPerTick: 30, unitsPerTick: 0.15, gpPerTick: 3, minBatchUnits: 27, requiredLevel: 1, outputs: [{ itemId: 556, countPerUnit: 1 }] },
    { skill: 'runecraft', method: 'air', script: 'scripts/generated/rcair.ts', label: 'Direct Air altar runecrafting', location: { x: 2983, z: 3291, level: 0 }, xpPerTick: 177.6, unitsPerTick: 1.4, gpPerTick: 5, minBatchUnits: 27, requiredLevel: 1, outputs: [{ itemId: 556, countPerUnit: 1 }], inputs: [{ itemId: 1436, countPerUnit: 1 }] },
    { skill: 'runecraft', method: 'specialist', script: 'scripts/runecraft-specialist.ts', label: 'Runecraft 1-99 specialist route', location: HUB_TILES.falador_east, xpPerTick: 900, unitsPerTick: 4.5, gpPerTick: 0, minBatchUnits: 27, requiredLevel: 1 },
    // Magic
    { skill: 'magic', method: 'order', script: 'scripts/magic-order.ts', label: 'Magic teleport and enchantment training order', location: HUB_TILES.varrock_west, xpPerTick: 280, unitsPerTick: 0.25, gpPerTick: -4, minBatchUnits: 25, requiredLevel: 1 },
    { skill: 'magic', method: 'items', script: 'scripts/microbot-magic-items.ts', label: 'Alch, Superheat, and Jewellery Enchanting', location: HUB_TILES.draynor, xpPerTick: 325, unitsPerTick: 0.25, gpPerTick: -2, minBatchUnits: 25, requiredLevel: 7 },
    { skill: 'magic', method: 'npc', script: 'scripts/aio-skiller.ts', label: 'Combat/curse spell casting on NPCs', location: HUB_TILES.lumbridge, xpPerTick: 75, unitsPerTick: 0.25, gpPerTick: -1, minBatchUnits: 25, requiredLevel: 1 },
    { skill: 'magic', method: 'teleport', script: 'scripts/microbot-magic-teleport.ts', label: 'Repeated teleport spell training', location: HUB_TILES.varrock_west, xpPerTick: 310, unitsPerTick: 0.25, gpPerTick: -5, minBatchUnits: 25, requiredLevel: 25 },
    { skill: 'magic', method: 'trip', script: 'scripts/microbot-magic-trip.ts', label: 'Bank-staged magic training trip', location: HUB_TILES.varrock_west, xpPerTick: 290, unitsPerTick: 0.22, gpPerTick: -4, minBatchUnits: 25, requiredLevel: 25 },
    { skill: 'magic', method: 'orbs', script: 'scripts/microbot-c-orbs.ts', label: 'Bank-to-obelisk orb charging trip', location: HUB_TILES.varrock_west, xpPerTick: 160, unitsPerTick: 0.08, gpPerTick: 8, minBatchUnits: 27, requiredLevel: 56, defaultEnv: { ORB_TRIP: '1' } },
    { skill: 'magic', method: 'orbs-at-site', script: 'scripts/microbot-c-orbs.ts', label: 'At-obelisk orb charging batch', location: HUB_TILES.catherby, xpPerTick: 250, unitsPerTick: 0.22, gpPerTick: 10, minBatchUnits: 27, requiredLevel: 56 },
    { skill: 'magic', method: 'bones', script: 'scripts/microbot-bones.ts', label: 'Bones to Bananas conversion', location: HUB_TILES.draynor, xpPerTick: 150, unitsPerTick: 0.25, gpPerTick: -1, minBatchUnits: 25, requiredLevel: 15 },
    { skill: 'magic', method: 'earth-production', script: 'scripts/earth-production.ts', label: 'Earth rune production for magic/superheat', location: HUB_TILES.varrock_east, xpPerTick: 32, unitsPerTick: 0.2, gpPerTick: 2, minBatchUnits: 27, requiredLevel: 9, outputs: [{ itemId: 557, countPerUnit: 1 }] },
    { skill: 'magic', method: 'alch-train', script: 'scripts/alch-train.ts', label: 'Low/High Alchemy bank training at Ardougne', location: HUB_TILES.ardougne_north, xpPerTick: 325, unitsPerTick: 0.2, gpPerTick: -2, minBatchUnits: 50, requiredLevel: 21 },
    { skill: 'magic', method: 'splash', script: 'scripts/aio-skiller.ts', label: 'Curse splash over Ardougne cow fence', location: HUB_TILES.ardougne_south, spotId: 'ardougne-cows', maxConcurrentAccounts: 6, xpPerTick: 145, unitsPerTick: 0.2, gpPerTick: -1, minBatchUnits: 50, requiredLevel: 19 },
    { skill: 'magic', method: 'splash-coop', script: 'scripts/aio-skiller.ts', label: 'Lumbridge chicken coop Wind Strike/Confuse splash', location: HUB_TILES.lumbridge, spotId: 'lumbridge-coop', maxConcurrentAccounts: 4, xpPerTick: 110, unitsPerTick: 0.2, gpPerTick: -1, minBatchUnits: 50, requiredLevel: 1, defaultEnv: { SPLASH_SITE: 'coop' } },
    { skill: 'magic', method: 'specialist', script: 'scripts/magic-specialist.ts', label: 'Magic 1-99 specialist route', location: HUB_TILES.varrock_west, xpPerTick: 1400, unitsPerTick: 0.6, gpPerTick: 0, minBatchUnits: 50, requiredLevel: 1 },
    // Prayer
    { skill: 'prayer', method: 'bury', script: 'scripts/train-prayer.ts', label: 'Bury banked bones for Prayer XP', location: HUB_TILES.varrock_west, xpPerTick: 600, unitsPerTick: 0.45, gpPerTick: -10, minBatchUnits: 28, requiredLevel: 1, inputs: [{ itemId: 536, countPerUnit: 1 }] },
    { skill: 'prayer', method: 'flick', script: 'scripts/aio-skiller.ts', label: '1-tick prayer flicking upkeep', location: HUB_TILES.ardougne_south, xpPerTick: 0, unitsPerTick: 0.5, gpPerTick: 0, minBatchUnits: 10, requiredLevel: 43 },
    { skill: 'prayer', method: 'specialist', script: 'scripts/prayer-specialist.ts', label: 'Prayer 1-99 specialist route', location: HUB_TILES.draynor, xpPerTick: 1800, unitsPerTick: 0.5, gpPerTick: 0, minBatchUnits: 28, requiredLevel: 1 },
    // Agility
    { skill: 'agility', method: 'order', script: 'scripts/agility-order.ts', label: 'Gnome/Barbarian/Wilderness agility courses', location: { x: 2474, z: 3438, level: 0 }, spotId: 'agility-courses', maxConcurrentAccounts: 10, xpPerTick: 48, unitsPerTick: 0.015, gpPerTick: 0, minBatchUnits: 10, requiredLevel: 1 },
    { skill: 'agility', method: 'specialist', script: 'scripts/agility-specialist.ts', label: 'Agility 1-99 specialist route', location: HUB_TILES.alkharid, xpPerTick: 195, unitsPerTick: 0.016, gpPerTick: 0, minBatchUnits: 10, requiredLevel: 1 },
    // Thieving
    { skill: 'thieving', method: 'knights', script: 'scripts/goldfarm.ts', label: 'Pickpocket Knights of Ardougne for coins', location: HUB_TILES.ardougne_market, spotId: 'ardougne-knights', maxConcurrentAccounts: 6, xpPerTick: 206.9, unitsPerTick: 0.14, gpPerTick: 17.5, minBatchUnits: 50, requiredLevel: 55, outputs: [{ itemId: 995, countPerUnit: 50 }] },
    { skill: 'thieving', method: 'knights-stable', script: 'scripts/goldfarm-stable.ts', label: 'Bounded Ardougne knight pickpocketing', location: HUB_TILES.ardougne_market, spotId: 'ardougne-knights', maxConcurrentAccounts: 6, xpPerTick: 200, unitsPerTick: 0.14, gpPerTick: 15, minBatchUnits: 50, requiredLevel: 55, outputs: [{ itemId: 995, countPerUnit: 50 }] },
    { skill: 'thieving', method: 'stun-base', script: 'scripts/measure/stun-guest.ts', label: 'Ardougne knights baseline', location: HUB_TILES.ardougne_market, spotId: 'ardougne-knights', maxConcurrentAccounts: 6, xpPerTick: 206.9, unitsPerTick: 0.14, gpPerTick: 17, minBatchUnits: 50, requiredLevel: 55 },
    { skill: 'thieving', method: 'stun-bury', script: 'scripts/measure/stun-guest.ts', label: 'Ardougne knights + bone bury in stun', location: HUB_TILES.ardougne_market, spotId: 'ardougne-knights', maxConcurrentAccounts: 6, xpPerTick: 215, unitsPerTick: 0.14, gpPerTick: 16, minBatchUnits: 50, requiredLevel: 55 },
    { skill: 'thieving', method: 'stun-enchant', script: 'scripts/measure/stun-guest.ts', label: 'Ardougne knights + enchant in stun', location: HUB_TILES.ardougne_market, spotId: 'ardougne-knights', maxConcurrentAccounts: 6, xpPerTick: 230, unitsPerTick: 0.14, gpPerTick: 15, minBatchUnits: 50, requiredLevel: 55 },
    { skill: 'thieving', method: 'bootstrap55', script: 'scripts/generated/thieving60.ts', label: 'Fresh Thieving Men->Cake->Guards->Knights to 55/60', location: HUB_TILES.ardougne_market, xpPerTick: 75, unitsPerTick: 0.16, gpPerTick: 4, minBatchUnits: 40, requiredLevel: 1 },
    { skill: 'thieving', method: 'pickpocket', script: 'scripts/microbot-pickpocket-trip.ts', label: 'Bank-staged NPC pickpocket trip', location: HUB_TILES.edgeville, xpPerTick: 35, unitsPerTick: 0.18, gpPerTick: 1, minBatchUnits: 30, requiredLevel: 1 },
    { skill: 'thieving', method: 'pickpocket-at-site', script: 'scripts/microbot-a-pickpocket.ts', label: 'At-site NPC pickpocketing', location: HUB_TILES.lumbridge, xpPerTick: 25, unitsPerTick: 0.2, gpPerTick: 0.8, minBatchUnits: 30, requiredLevel: 1 },
    { skill: 'thieving', method: 'stalls', script: 'scripts/microbot-c-stalls.ts', label: 'Steal from Baker/Silk/Fur/Silver/Spice/Gem stalls', location: HUB_TILES.ardougne_market, spotId: 'ardougne-stalls', maxConcurrentAccounts: 4, xpPerTick: 45, unitsPerTick: 0.16, gpPerTick: 2, minBatchUnits: 28, requiredLevel: 5, outputs: [{ itemId: 1891, countPerUnit: 1 }] },
    { skill: 'thieving', method: 'blood-chest', script: 'scripts/blood-chest.ts', label: 'Ardougne Chaos Druid Tower blood rune chest', location: { x: 2584, z: 3337, level: 0 }, spotId: 'blood-chest', maxConcurrentAccounts: 2, xpPerTick: 25, unitsPerTick: 0.02, gpPerTick: 12, minBatchUnits: 6, requiredLevel: 59, outputs: [{ itemId: 565, countPerUnit: 2 }] },
    { skill: 'thieving', method: 'nature-chest', script: 'scripts/microbot-b-nature-chest.ts', label: 'East Ardougne nature rune chest', location: { x: 2671, z: 3301, level: 1 }, spotId: 'nature-chest', maxConcurrentAccounts: 2, xpPerTick: 15, unitsPerTick: 0.04, gpPerTick: 6, minBatchUnits: 10, requiredLevel: 28, outputs: [{ itemId: 561, countPerUnit: 1 }] },
    { skill: 'thieving', method: 'specialist', script: 'scripts/thieving-specialist.ts', label: 'Thieving 1-99 specialist route', location: HUB_TILES.ardougne_market, xpPerTick: 680, unitsPerTick: 0.35, gpPerTick: 12, minBatchUnits: 50, requiredLevel: 1 },
    // Foraging
    { skill: 'foraging', method: 'flax', script: 'scripts/gather-flax.ts', label: 'Pick and bank flax at Seers Village', location: HUB_TILES.seers, spotId: 'seers-flax', maxConcurrentAccounts: 6, xpPerTick: 0, unitsPerTick: 0.25, gpPerTick: 3, minBatchUnits: 28, requiredLevel: 1, outputs: [{ itemId: 1779, countPerUnit: 1 }] },
    { skill: 'foraging', method: 'wool', script: 'scripts/collect-wool.ts', label: 'Shear sheep and spin wool at Lumbridge', location: HUB_TILES.lumbridge, xpPerTick: 15, unitsPerTick: 0.12, gpPerTick: 2, minBatchUnits: 27, requiredLevel: 1, outputs: [{ itemId: 1759, countPerUnit: 1 }] },
    { skill: 'foraging', method: 'feathers', script: 'scripts/gather-feathers.ts', label: 'Collect feathers at chicken pens', location: HUB_TILES.lumbridge, xpPerTick: 0, unitsPerTick: 0.4, gpPerTick: 1, minBatchUnits: 50, requiredLevel: 1, outputs: [{ itemId: 314, countPerUnit: 1 }] },
    { skill: 'foraging', method: 'spawn', script: 'scripts/gather-spawn.ts', label: 'Collect ground item spawns and bank', location: HUB_TILES.edgeville, xpPerTick: 0, unitsPerTick: 0.08, gpPerTick: 2, minBatchUnits: 10, requiredLevel: 1 },
    { skill: 'foraging', method: 'grapes', script: 'scripts/grapes.ts', label: 'Collect grapes for wine making', location: HUB_TILES.varrock_west, xpPerTick: 0, unitsPerTick: 0.08, gpPerTick: 4, minBatchUnits: 20, requiredLevel: 1, outputs: [{ itemId: 1987, countPerUnit: 1 }] },
    { skill: 'foraging', method: 'care', script: 'scripts/microbot-c-care.ts', label: 'Kitten care / Miscellania / Druid pouch', location: HUB_TILES.lumbridge, xpPerTick: 0, unitsPerTick: 0.05, gpPerTick: 0, minBatchUnits: 1, requiredLevel: 1 },
    { skill: 'foraging', method: 'miscellania-coffer', script: 'scripts/microbot-misc-coffer.ts', label: 'Manage Miscellania coffer and approval', location: { x: 2500, z: 3857, level: 1 }, xpPerTick: 0, unitsPerTick: 0.02, gpPerTick: 0, minBatchUnits: 1, requiredLevel: 1 },
    { skill: 'foraging', method: 'qol', script: 'scripts/microbot-c-qol.ts', label: 'Cannon refill / prayer hold / drop helper', location: HUB_TILES.lumbridge, xpPerTick: 0, unitsPerTick: 0.2, gpPerTick: 0, minBatchUnits: 1, requiredLevel: 1 },
    { skill: 'foraging', method: 'crystal-chest', script: 'scripts/crystal-chest.ts', label: 'Open Taverley crystal chests from Falador West', location: HUB_TILES.falador_west, xpPerTick: 0, unitsPerTick: 0.02, gpPerTick: 10, minBatchUnits: 1, requiredLevel: 1, outputs: [{ itemId: 1631, countPerUnit: 1 }], inputs: [{ itemId: 989, countPerUnit: 1 }] },
];

interface FighterSeed {
    readonly target: string;
    readonly script: string;
    readonly label: string;
    readonly location: WorkerTile;
    readonly spotId?: string;
    readonly maxConcurrentAccounts?: number;
    readonly skill: string;
    readonly skills: readonly string[];
    readonly xpPerTick: number;
    readonly unitsPerTick: number;
    readonly gpPerTick: number;
    readonly minBatchUnits: number;
    readonly riskPerHour?: number;
    readonly outputs?: readonly { itemId: number; countPerUnit: number }[];
    readonly defaultEnv?: Readonly<Record<string, string>>;
}

const FIGHTER_SPECS: readonly FighterSeed[] = [
    { target: 'chicken', script: 'scripts/aio-fighter.ts', label: 'Train melee on Lumbridge/Ardougne chickens', location: HUB_TILES.draynor, spotId: 'chickens', maxConcurrentAccounts: 6, skill: 'Strength', skills: ['Attack', 'Strength', 'Defence', 'Hitpoints'], xpPerTick: 38, unitsPerTick: 0.14, gpPerTick: 0.5, minBatchUnits: 20, outputs: [{ itemId: 314, countPerUnit: 10 }, { itemId: 526, countPerUnit: 1 }] },
    { target: 'cow', script: 'scripts/aio-fighter.ts', label: 'Fight Ardougne cows for melee XP and cowhides', location: HUB_TILES.ardougne_south, spotId: 'ardougne-cows', maxConcurrentAccounts: 6, skill: 'Strength', skills: ['Attack', 'Strength', 'Defence', 'Hitpoints'], xpPerTick: 52, unitsPerTick: 0.12, gpPerTick: 2.5, minBatchUnits: 25, outputs: [{ itemId: 1739, countPerUnit: 1 }, { itemId: 2132, countPerUnit: 1 }, { itemId: 526, countPerUnit: 1 }] },
    { target: 'druid', script: 'scripts/aio-fighter.ts', label: 'Fight Chaos Druids for herbs, runes, and vials', location: HUB_TILES.edgeville, spotId: 'chaos-druids', maxConcurrentAccounts: 4, skill: 'Attack', skills: ['Attack', 'Strength', 'Defence', 'Hitpoints'], xpPerTick: 68, unitsPerTick: 0.08, gpPerTick: 7, minBatchUnits: 20, riskPerHour: 0.05, outputs: [{ itemId: 207, countPerUnit: 1 }, { itemId: 563, countPerUnit: 2 }, { itemId: 561, countPerUnit: 1 }] },
    { target: 'unicorn', script: 'scripts/aio-fighter.ts', label: 'Kill Edgeville unicorns for unicorn horns', location: HUB_TILES.edgeville, spotId: 'edgeville-unicorns', maxConcurrentAccounts: 2, skill: 'Attack', skills: ['Attack', 'Strength', 'Defence', 'Hitpoints'], xpPerTick: 45, unitsPerTick: 0.06, gpPerTick: 3, minBatchUnits: 10, outputs: [{ itemId: 237, countPerUnit: 1 }] },
    { target: 'wizard', script: 'scripts/aio-fighter.ts', label: 'Kill Wizards Tower wizards for water talismans', location: HUB_TILES.wizards_tower, spotId: 'wizards-tower', maxConcurrentAccounts: 3, skill: 'Attack', skills: ['Attack', 'Strength', 'Defence', 'Hitpoints'], xpPerTick: 55, unitsPerTick: 0.09, gpPerTick: 2, minBatchUnits: 15, outputs: [{ itemId: 1444, countPerUnit: 0.05 }] },
    { target: 'giant', script: 'scripts/aio-fighter.ts', label: 'Fight Hill Giants for big bones, limpwurts, and runes', location: HUB_TILES.edgeville, spotId: 'hill-giants', maxConcurrentAccounts: 4, skill: 'Strength', skills: ['Attack', 'Strength', 'Defence', 'Hitpoints'], xpPerTick: 95, unitsPerTick: 0.06, gpPerTick: 6, minBatchUnits: 20, outputs: [{ itemId: 532, countPerUnit: 1 }, { itemId: 225, countPerUnit: 0.3 }, { itemId: 561, countPerUnit: 0.5 }, { itemId: 564, countPerUnit: 0.3 }] },
    { target: 'trooper', script: 'scripts/aio-fighter.ts', label: 'Train melee/Ranged/HP/Prayer on Khazard troopers', location: HUB_TILES.khazard_field, spotId: 'khazard-troopers', maxConcurrentAccounts: 6, skill: 'Strength', skills: ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer'], xpPerTick: 165, unitsPerTick: 0.05, gpPerTick: 1, minBatchUnits: 20 },
    { target: 'fire-giant', script: 'scripts/aio-fighter.ts', label: 'Fight Fire Giants in Waterfall Dungeon', location: HUB_TILES.ardougne_north, spotId: 'fire-giants', maxConcurrentAccounts: 3, skill: 'Strength', skills: ['Attack', 'Strength', 'Defence', 'Hitpoints'], xpPerTick: 210, unitsPerTick: 0.03, gpPerTick: 12, minBatchUnits: 15, riskPerHour: 0.08, outputs: [{ itemId: 532, countPerUnit: 1 }, { itemId: 1333, countPerUnit: 0.02 }] },
    { target: 'fire-combat', script: 'scripts/aio-fighter.ts', label: 'Fire Giant safespot/melee trip', location: HUB_TILES.ardougne_north, spotId: 'fire-giants', maxConcurrentAccounts: 3, skill: 'Ranged', skills: ['Ranged', 'Attack', 'Strength', 'Defence', 'Hitpoints'], xpPerTick: 190, unitsPerTick: 0.03, gpPerTick: 10, minBatchUnits: 15, riskPerHour: 0.05 },
    { target: 'imp', script: 'scripts/aio-fighter.ts', label: 'Hunt imps for Imp Catcher beads', location: HUB_TILES.ardougne_south, spotId: 'ardougne-imps', maxConcurrentAccounts: 3, skill: 'Attack', skills: ['Attack', 'Strength', 'Defence', 'Hitpoints'], xpPerTick: 25, unitsPerTick: 0.08, gpPerTick: 1, minBatchUnits: 10, outputs: [{ itemId: 1470, countPerUnit: 0.08 }, { itemId: 1472, countPerUnit: 0.08 }, { itemId: 1474, countPerUnit: 0.08 }, { itemId: 1476, countPerUnit: 0.08 }] },
    { target: 'shade', script: 'scripts/aio-fighter.ts', label: 'Fight shades in Mortton for shade remains', location: { x: 3510, z: 3480, level: 0 }, skill: 'Attack', skills: ['Attack', 'Strength', 'Defence', 'Hitpoints'], xpPerTick: 120, unitsPerTick: 0.04, gpPerTick: 8, minBatchUnits: 10, riskPerHour: 0.06 },
    { target: 'chompy', script: 'scripts/aio-fighter.ts', label: 'Chompy bird hunting trip', location: { x: 2614, z: 3093, level: 0 }, skill: 'Ranged', skills: ['Ranged', 'Hitpoints'], xpPerTick: 85, unitsPerTick: 0.03, gpPerTick: 0, minBatchUnits: 5 },
    { target: 'chompy-at-site', script: 'scripts/aio-fighter.ts', label: 'At-site Chompy bird hunting', location: { x: 2547, z: 2982, level: 0 }, skill: 'Ranged', skills: ['Ranged', 'Hitpoints'], xpPerTick: 95, unitsPerTick: 0.035, gpPerTick: 0, minBatchUnits: 5 },
    { target: 'ranged', script: 'scripts/ranged-train.ts', label: 'Progressive Ranged bow/arrow training', location: HUB_TILES.varrock_east, skill: 'Ranged', skills: ['Ranged', 'Hitpoints'], xpPerTick: 140, unitsPerTick: 0.09, gpPerTick: -1, minBatchUnits: 30 },
    { target: 'ranged-starter', script: 'scripts/aio-fighter.ts', label: 'Fresh Ranged starter bootstrap', location: HUB_TILES.lumbridge, skill: 'Ranged', skills: ['Ranged', 'Hitpoints'], xpPerTick: 65, unitsPerTick: 0.12, gpPerTick: 0, minBatchUnits: 20 },
    { target: 'ranged-gather', script: 'scripts/aio-fighter.ts', label: 'Safespot Ranged monster farm with arrow pickup', location: HUB_TILES.varrock_east, skill: 'Ranged', skills: ['Ranged', 'Hitpoints'], xpPerTick: 125, unitsPerTick: 0.08, gpPerTick: 2, minBatchUnits: 25 },
    { target: 'ranged-camp', script: 'scripts/aio-fighter.ts', label: 'Safespot Ranged camp', location: HUB_TILES.falador_west, skill: 'Ranged', skills: ['Ranged', 'Hitpoints'], xpPerTick: 155, unitsPerTick: 0.05, gpPerTick: 5, minBatchUnits: 20 },
    { target: 'cannon', script: 'scripts/aio-fighter.ts', label: 'Dwarf multicannon Ranged training', location: HUB_TILES.edgeville, spotId: 'cannon-spiders', maxConcurrentAccounts: 2, skill: 'Ranged', skills: ['Ranged', 'Hitpoints'], xpPerTick: 480, unitsPerTick: 0.15, gpPerTick: -25, minBatchUnits: 50, riskPerHour: 0.15, defaultEnv: { SPOT: 'spiders' } },
    { target: 'ranged-specialist', script: 'scripts/ranged-specialist.ts', label: 'Ranged 1-99 specialist route', location: HUB_TILES.lumbridge, skill: 'Ranged', skills: ['Ranged'], xpPerTick: 420, unitsPerTick: 0.12, gpPerTick: 0, minBatchUnits: 50 },
    { target: 'loot-trip', script: 'scripts/aio-fighter.ts', label: 'Dedicated ground-item loot and bank trip', location: HUB_TILES.varrock_west, skill: 'Hitpoints', skills: ['Hitpoints'], xpPerTick: 0, unitsPerTick: 0.15, gpPerTick: 8, minBatchUnits: 10 },
    { target: 'attack-specialist', script: 'scripts/attack-specialist.ts', label: 'Attack 1-99 specialist route', location: HUB_TILES.lumbridge, skill: 'Attack', skills: ['Attack'], xpPerTick: 280, unitsPerTick: 0.05, gpPerTick: 0, minBatchUnits: 20 },
    { target: 'specialist-hp', script: 'scripts/hp-specialist.ts', label: 'Hitpoints 1-99 specialist route', location: HUB_TILES.lumbridge, skill: 'Hitpoints', skills: ['Hitpoints'], xpPerTick: 240, unitsPerTick: 0.05, gpPerTick: 0, minBatchUnits: 20 },
    { target: 'specialist-strength', script: 'scripts/strength-specialist.ts', label: 'Strength 1-99 specialist route', location: HUB_TILES.lumbridge, skill: 'Strength', skills: ['Strength'], xpPerTick: 260, unitsPerTick: 0.05, gpPerTick: 0, minBatchUnits: 20 },
    { target: 'specialist-defence', script: 'scripts/defence-specialist.ts', label: 'Defence 1-99 specialist route', location: HUB_TILES.lumbridge, skill: 'Defence', skills: ['Defence'], xpPerTick: 250, unitsPerTick: 0.05, gpPerTick: 0, minBatchUnits: 20 },
];

const BOSS_SPECS: readonly {
    boss: string;
    script: string;
    label: string;
    location: WorkerTile;
    spotId?: string;
    maxConcurrentAccounts?: number;
    skill: string;
    skills: readonly string[];
    xpPerTick: number;
    unitsPerTick: number;
    gpPerTick: number;
    minBatchUnits: number;
    riskPerHour: number;
    outputs?: readonly { itemId: number; countPerUnit: number }[];
}[] = [
    { boss: 'kbd', script: 'scripts/aio-boss.ts', label: 'King Black Dragon boss trip', location: HUB_TILES.edgeville, spotId: 'kbd-lair', maxConcurrentAccounts: 2, skill: 'Attack', skills: ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Prayer'], xpPerTick: 240, unitsPerTick: 0.015, gpPerTick: 35, minBatchUnits: 1, riskPerHour: 0.12, outputs: [{ itemId: 536, countPerUnit: 1 }, { itemId: 1747, countPerUnit: 2 }] },
    { boss: 'black-dragon', script: 'scripts/aio-boss.ts', label: 'Taverley Black Dragons safespot camp', location: HUB_TILES.falador_west, spotId: 'taverley-black-dragons', maxConcurrentAccounts: 2, skill: 'Ranged', skills: ['Ranged', 'Hitpoints', 'Defence'], xpPerTick: 210, unitsPerTick: 0.018, gpPerTick: 30, minBatchUnits: 1, riskPerHour: 0.04, outputs: [{ itemId: 536, countPerUnit: 1 }, { itemId: 1747, countPerUnit: 1 }] },
    { boss: 'green-dragon', script: 'scripts/aio-boss.ts', label: 'Wilderness Green Dragons bones & hides trip', location: HUB_TILES.edgeville, spotId: 'wild-green-dragons', maxConcurrentAccounts: 3, skill: 'Strength', skills: ['Attack', 'Strength', 'Defence', 'Hitpoints'], xpPerTick: 185, unitsPerTick: 0.03, gpPerTick: 28, minBatchUnits: 5, riskPerHour: 0.18, outputs: [{ itemId: 536, countPerUnit: 1 }, { itemId: 1753, countPerUnit: 1 }] },
    { boss: 'trawler', script: 'scripts/aio-boss.ts', label: 'Port Khazard Fishing Trawler trip', location: { x: 2675, z: 3170, level: 0 }, skill: 'Fishing', skills: ['Fishing', 'Crafting'], xpPerTick: 65, unitsPerTick: 0.004, gpPerTick: 5, minBatchUnits: 1, riskPerHour: 0.02 },
    { boss: 'trawler-at-site', script: 'scripts/aio-boss.ts', label: 'At-dock Fishing Trawler loop', location: { x: 2675, z: 3170, level: 0 }, skill: 'Fishing', skills: ['Fishing', 'Crafting'], xpPerTick: 65, unitsPerTick: 0.004, gpPerTick: 5, minBatchUnits: 1, riskPerHour: 0.02 },
];

const MARKET_SPECS: readonly { mode: string; script: string; kind: WorkerKind; label: string; location: WorkerTile; gpPerTick: number }[] = [
    { mode: 'shop-buy', script: 'scripts/shop-buyer.ts', kind: 'shop', label: 'Buy item from mapped NPC shop and bank', location: HUB_TILES.varrock_east, gpPerTick: -5 },
    { mode: 'shop-trip', script: 'scripts/microbot-shop-trip.ts', kind: 'shop', label: 'Bank-to-merchant shop trade trip', location: HUB_TILES.alkharid, gpPerTick: 5 },
    { mode: 'shop-sell', script: 'scripts/microbot-shop-trip.ts', kind: 'shop', label: 'Sell banked surplus at NPC shop', location: HUB_TILES.alkharid, gpPerTick: 8 },
    { mode: 'earth-shop', script: 'scripts/earth-shop.ts', kind: 'shop', label: 'Buy elemental runes from Aubury/Betty', location: HUB_TILES.varrock_east, gpPerTick: -4 },
    { mode: 'buy-sword', script: 'scripts/buy-owned-sword.ts', kind: 'shop', label: 'Buy training sword from Varrock sword shop', location: HUB_TILES.varrock_west, gpPerTick: -2 },
    { mode: 'ge-buy', script: 'scripts/buy-owned-ge-item.ts', kind: 'ge_buy', label: 'Place, collect, and bank Grand Exchange buy order', location: HUB_TILES.varrock_west, gpPerTick: -10 },
    { mode: 'ge-sell', script: 'scripts/sell-owned-ge-item.ts', kind: 'shop', label: 'Sell banked item on Grand Exchange', location: HUB_TILES.varrock_west, gpPerTick: 20 },
    { mode: 'ge-buy-list', script: 'scripts/microbot-ge-buy-list.ts', kind: 'ge_buy', label: 'Execute multi-item GE shopping list', location: HUB_TILES.varrock_west, gpPerTick: -10 },
    { mode: 'ge-trip', script: 'scripts/microbot-ge-trip.ts', kind: 'ge_buy', label: 'Bank-to-GE round trip', location: HUB_TILES.varrock_west, gpPerTick: 0 },
    { mode: 'ge-plan', script: 'scripts/microbot-ge-plan.ts', kind: 'ge_buy', label: 'Compute GE order plan from bank state', location: HUB_TILES.varrock_west, gpPerTick: 0 },
    { mode: 'shop-to-bid', script: 'scripts/shop-to-bid.ts', kind: 'shop', label: 'Buy shop stock and sell into open GE bid', location: HUB_TILES.varrock_west, gpPerTick: 15 },
    { mode: 'bank-seller', script: 'scripts/microbot-bank-seller.ts', kind: 'shop', label: 'Liquidate banked surplus items on GE', location: HUB_TILES.varrock_west, gpPerTick: 18 },
];

const LOGISTICS_SPECS: readonly { role: string; script: string; kind: WorkerKind; label: string; location?: WorkerTile; minBatchUnits?: number }[] = [
    { role: 'coin-courier', script: 'scripts/coin-courier.ts', kind: 'recover', label: 'Deliver coins between owned accounts', location: HUB_TILES.varrock_west },
    { role: 'coin-fanout', script: 'scripts/coin-fanout.ts', kind: 'recover', label: 'Distribute coin floats from treasury account', location: HUB_TILES.varrock_west },
    { role: 'item-fanin', script: 'scripts/item-fanin.ts', kind: 'recover', label: 'Consolidate produced items into holder bank', location: HUB_TILES.varrock_west },
    { role: 'note-courier', script: 'scripts/note-courier.ts', kind: 'recover', label: 'Deliver noted supplies between accounts', location: HUB_TILES.ardougne_south },
    { role: 'food-courier', script: 'scripts/foodcourier.ts', kind: 'recover', label: 'Deliver cooked food to skilling/combat workers', location: HUB_TILES.ardougne_south },
    { role: 'food-chain', script: 'scripts/foodchain.ts', kind: 'recover', label: 'Coordinate fish-cook-deliver chain', location: HUB_TILES.catherby },
    { role: 'banker', script: 'scripts/banker.ts', kind: 'recover', label: 'Standing hub banker receiving/serving supplies', location: HUB_TILES.varrock_west },
    { role: 'give-to-banker', script: 'scripts/give-to-banker.ts', kind: 'recover', label: 'Trade produced items to standing banker', location: HUB_TILES.varrock_west },
    { role: 'take-from-banker', script: 'scripts/take-from-banker.ts', kind: 'recover', label: 'Receive staged items from standing banker', location: HUB_TILES.varrock_west },
    { role: 'supply-chain', script: 'scripts/supply-chain.ts', kind: 'recover', label: 'Multi-actor supply-chain transfer', location: HUB_TILES.varrock_west },
    { role: 'supply-holder', script: 'scripts/supply-holder.ts', kind: 'recover', label: 'Hold and serve staged route supplies', location: HUB_TILES.varrock_west },
    { role: 'specialist-supplier', script: 'scripts/specialist-supplier.ts', kind: 'recover', label: 'Stage and hand off specialist supply kit', location: HUB_TILES.varrock_west },
    { role: 'gathering-supplier', script: 'scripts/gathering-supplier.ts', kind: 'recover', label: 'Hand gathering kit to fresh specialist at Lumbridge', location: HUB_TILES.lumbridge },
    { role: 'wine-stock', script: 'scripts/make-wine-order.ts', kind: 'produce', label: 'Preserve wine-note order from grapes and jugs', location: HUB_TILES.draynor, minBatchUnits: 12 },
    { role: 'supply-bootstrap', script: 'scripts/supply-bootstrap.ts', kind: 'recover', label: 'Discard tutorial gifts before initial staging', location: HUB_TILES.lumbridge },
    { role: 'fleet-trade', script: 'scripts/fleet-trade.ts', kind: 'recover', label: 'Execute cross-side fleet trade settlement', location: HUB_TILES.varrock_west },
    { role: 'loadout', script: 'scripts/microbot-owned-loadout.ts', kind: 'recover', label: 'Equip kit and withdraw exact inventory setup', location: HUB_TILES.draynor },
    { role: 'loadout-import', script: 'scripts/microbot-loadout-import.ts', kind: 'recover', label: 'Compile offline inventory/equipment setup' },
    { role: 'bank-sort', script: 'scripts/microbot-bank-sort.ts', kind: 'recover', label: 'Sort and audit bank tabs/slots', location: HUB_TILES.draynor },
    { role: 'walk-to', script: 'scripts/walk-to.ts', kind: 'recover', label: 'Walk account to target world coordinate', location: HUB_TILES.varrock_west },
    { role: 'walk-edge', script: 'scripts/pk-live/walk-edge.ts', kind: 'recover', label: 'Walk to Edgeville bank safely', location: HUB_TILES.edgeville },
    { role: 'restore-prayer', script: 'scripts/pray-at-altar.ts', kind: 'recover', label: 'Restore drained Prayer at nearby altar', location: HUB_TILES.lumbridge },
    { role: 'cure-poison', script: 'scripts/cure-poison.ts', kind: 'recover', label: 'Drink antipoison from pack or nearest bank', location: HUB_TILES.varrock_west },
    { role: 'charge-glory', script: 'scripts/charge-glory.ts', kind: 'recover', label: 'Recharge amulets of glory at Fountain of Heroes', location: HUB_TILES.falador_west },
    { role: 'relocate-bank', script: 'scripts/relocate-bank.ts', kind: 'recover', label: 'Relocate account safely to nearest bank hub', location: HUB_TILES.varrock_west },
    { role: 'relocate-knight', script: 'scripts/relocate-knight.ts', kind: 'recover', label: 'Relocate thieving account to Ardougne market', location: HUB_TILES.ardougne_north },
    { role: 'arrive-draynor', script: 'scripts/arrive-draynor.ts', kind: 'recover', label: 'Walk fresh account from Lumbridge to Draynor bank', location: HUB_TILES.draynor },
    { role: 'recover-location', script: 'scripts/relocate-bank.ts', kind: 'recover', label: 'Recover stranded account back to a safe hub bank', location: HUB_TILES.varrock_west },
    { role: 'inspect', script: 'scripts/fleet-inspect.ts', kind: 'recover', label: 'Inspect live account bank, inventory, and quests', location: HUB_TILES.draynor },
];

const PVP_SPECS: readonly { mode: string; script: string; label: string; location: WorkerTile; riskPerHour: number }[] = [
    { mode: 'fight', script: 'scripts/pk.ts', label: '1v1 tribrid PK fight loop', location: HUB_TILES.edgeville, riskPerHour: 0.25 },
    { mode: 'spar', script: 'scripts/aio-pvp.ts', label: 'Practice PK mirror spar', location: HUB_TILES.wildy_ditch, riskPerHour: 0.1 },
    { mode: 'gang', script: 'scripts/aio-pvp.ts', label: 'Multi-way gang PK encounter', location: HUB_TILES.wildy_ditch, riskPerHour: 0.2 },
    { mode: 'army', script: 'scripts/aio-pvp.ts', label: 'Roaming PK army leader and followers', location: HUB_TILES.edgeville, riskPerHour: 0.22 },
    { mode: 'squad', script: 'scripts/pk-squad.ts', label: 'Multi-way PK gang squad post', location: HUB_TILES.edgeville, riskPerHour: 0.22 },
    { mode: 'team', script: 'scripts/aio-pvp.ts', label: 'Team vs team PK practice match', location: HUB_TILES.wildy_ditch, riskPerHour: 0.15 },
    { mode: 'hunt', script: 'scripts/aio-pvp.ts', label: 'Wilderness hotspot PK hunter trip', location: HUB_TILES.edgeville, riskPerHour: 0.25 },
    { mode: 'roam', script: 'scripts/aio-pvp.ts', label: 'Wilderness multi-zone roam and target scout', location: HUB_TILES.edgeville, riskPerHour: 0.2 },
    { mode: 'pilot', script: 'scripts/pk-live/live-pilot.ts', label: 'Bounded live Wilderness PK pilot', location: HUB_TILES.edgeville, riskPerHour: 0.25 },
    { mode: 'standby', script: 'scripts/aio-pvp.ts', label: 'Staged Wilderness standby readiness', location: HUB_TILES.varrock_east, riskPerHour: 0.02 },
    { mode: 'stage-kit', script: 'scripts/aio-pvp.ts', label: 'Stage starter PvP kit at Varrock East', location: HUB_TILES.varrock_east, riskPerHour: 0 },
    { mode: 'escort-ore', script: 'scripts/lava-maze-escorted-ore.ts', label: 'Escorted Lava Maze runite mining trip', location: HUB_TILES.edgeville, riskPerHour: 0.2 },
    { mode: 'microbot-pvp', script: 'scripts/aio-pvp.ts', label: 'Microbot PvP combat helper', location: HUB_TILES.lumbridge, riskPerHour: 0.05 },
    { mode: 'special-swap', script: 'scripts/aio-pvp.ts', label: '1-tick special-attack weapon swap', location: HUB_TILES.lumbridge, riskPerHour: 0 },
    { mode: 'monitor', script: 'scripts/aio-pvp.ts', label: 'Wilderness nearby-player threat monitor', location: HUB_TILES.edgeville, riskPerHour: 0 },
];

const QUEST_MODE_SPECS: readonly { mode: string; script: string; label: string; location?: WorkerTile }[] = [
    { mode: 'sweep', script: 'scripts/aio-quester.ts', label: 'Stage bank items and sweep quest to completion', location: HUB_TILES.lumbridge },
    { mode: 'order', script: 'scripts/aio-quester.ts', label: 'Save-verified finite quest order', location: HUB_TILES.lumbridge },
    { mode: 'chain', script: 'scripts/aio-quester.ts', label: 'Run sequence of quests in order', location: HUB_TILES.lumbridge },
    { mode: 'items', script: 'scripts/aio-quester.ts', label: 'Acquire and bank quest prerequisite items', location: HUB_TILES.varrock_west },
    { mode: 'cook-job', script: 'scripts/aio-quester.ts', label: "Self-contained Cook's Assistant completion", location: HUB_TILES.lumbridge },
    { mode: 'seaslug-leave', script: 'scripts/aio-quester.ts', label: 'Return from Fishing Platform after Sea Slug', location: HUB_TILES.ardougne_south },
    { mode: 'dusty-key', script: 'scripts/aio-quester.ts', label: 'Acquire dusty key in Taverley Dungeon', location: HUB_TILES.falador_west },
    { mode: 'hero-owned', script: 'scripts/generated/quest-hero-owned.ts', label: "Two-account owned Heroes' Quest", location: HUB_TILES.falador_west },
    { mode: 'legends-owned', script: 'scripts/generated/quest-legends-owned.ts', label: "Owned Legends' Quest runner", location: HUB_TILES.ardougne_south },
    { mode: 'tbwt-owned', script: 'scripts/generated/quest-tbwt-owned.ts', label: 'Owned Tai Bwo Wannai Trio runner', location: HUB_TILES.ardougne_south },
    { mode: 'watchtower-owned', script: 'scripts/generated/quest-itwatchtower-owned.ts', label: 'Owned Watchtower runner', location: HUB_TILES.ardougne_south },
    { mode: 'clue', script: 'scripts/aio-quester.ts', label: 'Solve coordinate/anagram/map clue steps', location: HUB_TILES.varrock_west },
    { mode: 'clue-puzzle', script: 'scripts/aio-quester.ts', label: 'Solve clue scroll sliding puzzle boxes' },
    { mode: 'clue-guardian', script: 'scripts/aio-quester.ts', label: 'Defeat clue scroll wizard guardians', location: HUB_TILES.varrock_west },
];

export function createActivityCatalog(opts: ActivityCatalogOptions = {}): ActivityCatalog {
    const root = resolve(opts.root ?? repoRoot);
    const items = safeReadJson<KnowledgeItem[]>(join(root, 'knowledge', 'items.json'), []);
    const skills = safeReadJson<KnowledgeSkillRow[]>(join(root, 'knowledge', 'skills.json'), []);
    const rates = safeReadJson<KnowledgeRateRow[]>(join(root, 'knowledge', 'rates.json'), []);
    const questsJson = safeReadJson<KnowledgeQuestRow[]>(join(root, 'knowledge', 'quests.json'), []);
    const travelData = safeReadJson<TravelCacheData>(join(root, 'packages', 'planner', 'src', 'haggis-travel.json'), {});

    const itemByDebug = new Map<string, KnowledgeItem>();
    for (const it of items) itemByDebug.set(it.debugname, it);

    const measuredBySkill = new Map<string, number>();
    for (const r of rates) {
        const s = r.skill.toLowerCase();
        if (!measuredBySkill.has(s) || r.xpPerTick > measuredBySkill.get(s)!) {
            measuredBySkill.set(s, r.xpPerTick);
        }
    }

    const activities = new Map<string, ActivityDefinition>();
    const trustFor = (id: string, aioKey: string | null): TrustTier => {
        if (opts.liveProvenIds?.has(id)) return 'live_proven';
        if (opts.benchPassedIds?.has(id)) return 'practice_passed';
        if (aioKey && !BLOCKED_AIO_KEYS.has(aioKey) && !EXPERIMENTAL_AIO_KEYS.has(aioKey)) {
            return 'practice_passed';
        }
        return 'experimental';
    };

    const register = (def: ActivityDefinition) => {
        const errs = validateActivityDefinition(def);
        if (errs.length > 0) {
            throw new Error(`Catalog activity "${def.id}" invalid: ${errs.join('; ')}`);
        }
        activities.set(def.id, def);
    };

    // 1. Skiller routes (gather, bank-artisan, agility, runecraft, combat-magic).
    for (const spec of SKILLER_SPECS) {
        const { family, kind } = skillerFamily(spec.skill, spec.method);
        const aioKey = `skiller:${spec.skill}:${spec.method}`;
        const id = `${family}:${spec.skill}-${spec.method}`;
        const setupTicks = estimateTravelTicksFromNearestBank(spec.location, travelData) + 6;
        const outputsMap: Record<number, number> = {};
        if (spec.outputs) {
            for (const o of spec.outputs) outputsMap[o.itemId] = o.countPerUnit;
        }
        const inputsMap: Record<number, number> = {};
        if (spec.inputs) {
            for (const i of spec.inputs) inputsMap[i.itemId] = i.countPerUnit;
        }
        const skillCap = titleCase(spec.skill);
        const xpPerTick = spec.xpPerTick ?? measuredBySkill.get(spec.skill) ?? 50;

        register({
            id,
            workerId: family,
            family,
            kind,
            label: spec.label,
            ...(spec.skill !== 'foraging' ? { skill: skillCap, skills: [skillCap] } : {}),
            ...(spec.spotId ? { spotId: spec.spotId } : {}),
            ...(spec.maxConcurrentAccounts ? { maxConcurrentAccounts: spec.maxConcurrentAccounts } : {}),
            config: {
                aioCategory: 'skiller',
                aioRoute: `${spec.skill}:${spec.method}`,
                script: spec.script,
                skill: spec.skill,
                method: spec.method,
                requiredLevel: spec.requiredLevel ?? 1,
                ...(spec.defaultArgs ? { defaultArgs: spec.defaultArgs } : {}),
                ...(spec.defaultEnv ? { defaultEnv: spec.defaultEnv } : {}),
            },
            baselineRate: {
                xpPerTick,
                ...(spec.skill !== 'foraging' ? { skillXpPerTick: { [skillCap]: xpPerTick } } : {}),
                unitsPerTick: spec.unitsPerTick ?? 0.2,
                gpPerTick: spec.gpPerTick ?? 0,
                setupTicks,
                minBatchUnits: spec.minBatchUnits ?? 25,
                confidence: spec.skill === 'thieving' && spec.method === 'knights' ? 'practice' : 'model',
                ...(Object.keys(outputsMap).length > 0 ? { outputsPerUnit: outputsMap } : {}),
                ...(Object.keys(inputsMap).length > 0 ? { inputsPerUnit: inputsMap } : {}),
            },
            ...(spec.inputs ? { inputs: spec.inputs } : {}),
            ...(spec.outputs ? { outputs: spec.outputs } : {}),
            ...(spec.location ? { location: spec.location } : {}),
            trust: trustFor(id, aioKey),
            protectedAllowed: opts.launchQualifiedIds?.has(id) ?? false,
        });
    }

    // 2. Knowledge skill actions (every row in knowledge/skills.json: zero dropped methods).
    for (const row of skills) {
        const family = tableFamily(row.table);
        const kind = tableKind(row.table);
        const id = `${family}:skill:${row.table}:${row.row}`;
        if (activities.has(id)) continue;
        const skillCap = titleCase(row.skill);
        const actionTicks = tableActionTicks(row.table);
        const xpPerTick = row.xp !== null && row.xp > 0
            ? Math.round(((row.xp * XP_MULTIPLIER) / actionTicks) * 100) / 100
            : 0;
        const unitsPerTick = Math.round((1 / actionTicks) * 1000) / 1000;
        const { io: inputs, map: inputsMap } = makeIOList(row.inputs, itemByDebug);
        const { io: outputs, map: outputsMap } = makeIOList(row.outputs, itemByDebug);
        const minBatchUnits = row.table === 'fletching_table' ? 100 : row.table === 'gem_cutting_table' ? 27 : 14;

        register({
            id,
            workerId: family,
            family,
            kind,
            label: `${skillCap}: ${row.row.replace(/_/g, ' ')}`,
            skill: skillCap,
            skills: [skillCap],
            config: {
                aioCategory: 'skiller',
                aioRoute: `${row.skill}:skill-action`,
                table: row.table,
                row: row.row,
                requiredLevel: Math.max(1, row.level),
            },
            baselineRate: {
                xpPerTick,
                skillXpPerTick: { [skillCap]: xpPerTick },
                unitsPerTick,
                gpPerTick: 0,
                setupTicks: 12,
                minBatchUnits,
                confidence: 'model',
                ...(Object.keys(outputsMap).length > 0 ? { outputsPerUnit: outputsMap } : {}),
                ...(Object.keys(inputsMap).length > 0 ? { inputsPerUnit: inputsMap } : {}),
            },
            ...(inputs.length > 0 ? { inputs } : {}),
            ...(outputs.length > 0 ? { outputs } : {}),
            trust: trustFor(id, null),
            protectedAllowed: opts.launchQualifiedIds?.has(id) ?? false,
        });
    }

    // 3. Fighter profiles.
    for (const spec of FIGHTER_SPECS) {
        const aioKey = `fighter:${spec.target}`;
        const id = `combat:${spec.target}`;
        const setupTicks = estimateTravelTicksFromNearestBank(spec.location, travelData) + 10;
        const outputsMap: Record<number, number> = {};
        if (spec.outputs) {
            for (const o of spec.outputs) outputsMap[o.itemId] = o.countPerUnit;
        }
        register({
            id,
            workerId: 'combat',
            family: 'combat',
            kind: 'train',
            label: spec.label,
            skill: spec.skill,
            skills: spec.skills,
            ...(spec.spotId ? { spotId: spec.spotId } : {}),
            ...(spec.maxConcurrentAccounts ? { maxConcurrentAccounts: spec.maxConcurrentAccounts } : {}),
            config: {
                aioCategory: 'fighter',
                aioRoute: spec.target,
                target: spec.target,
                script: spec.script,
                ...(spec.defaultEnv ? { defaultEnv: spec.defaultEnv } : {}),
            },
            baselineRate: {
                xpPerTick: spec.xpPerTick,
                skillXpPerTick: { [spec.skill]: spec.xpPerTick },
                unitsPerTick: spec.unitsPerTick,
                gpPerTick: spec.gpPerTick,
                setupTicks,
                minBatchUnits: spec.minBatchUnits,
                confidence: 'model',
                ...(spec.riskPerHour !== undefined ? { riskPerHour: spec.riskPerHour } : {}),
                ...(Object.keys(outputsMap).length > 0 ? { outputsPerUnit: outputsMap } : {}),
            },
            ...(spec.outputs ? { outputs: spec.outputs } : {}),
            location: spec.location,
            trust: trustFor(id, aioKey),
            protectedAllowed: opts.launchQualifiedIds?.has(id) ?? false,
        });
    }

    // 4. Boss encounters (mapped to combat family).
    for (const spec of BOSS_SPECS) {
        const aioKey = `boss:${spec.boss}`;
        const id = `combat:boss-${spec.boss}`;
        const setupTicks = estimateTravelTicksFromNearestBank(spec.location, travelData) + 18;
        const outputsMap: Record<number, number> = {};
        if (spec.outputs) {
            for (const o of spec.outputs) outputsMap[o.itemId] = o.countPerUnit;
        }
        register({
            id,
            workerId: 'combat',
            family: 'combat',
            kind: spec.boss.includes('trawler') ? 'gather' : 'train',
            label: spec.label,
            skill: spec.skill,
            skills: spec.skills,
            ...(spec.spotId ? { spotId: spec.spotId } : {}),
            ...(spec.maxConcurrentAccounts ? { maxConcurrentAccounts: spec.maxConcurrentAccounts } : {}),
            config: {
                aioCategory: 'boss',
                aioRoute: spec.boss,
                boss: spec.boss,
                script: spec.script,
            },
            baselineRate: {
                xpPerTick: spec.xpPerTick,
                skillXpPerTick: { [spec.skill]: spec.xpPerTick },
                unitsPerTick: spec.unitsPerTick,
                gpPerTick: spec.gpPerTick,
                setupTicks,
                minBatchUnits: spec.minBatchUnits,
                confidence: 'model',
                riskPerHour: spec.riskPerHour,
                ...(Object.keys(outputsMap).length > 0 ? { outputsPerUnit: outputsMap } : {}),
            },
            ...(spec.outputs ? { outputs: spec.outputs } : {}),
            location: spec.location,
            trust: trustFor(id, aioKey),
            protectedAllowed: opts.launchQualifiedIds?.has(id) ?? false,
        });
    }

    // 5. Quest modes + all generated quests.
    for (const spec of QUEST_MODE_SPECS) {
        const aioKey = `quester:mode:${spec.mode}`;
        const id = `quest:mode-${spec.mode}`;
        const setupTicks = estimateTravelTicksFromNearestBank(spec.location, travelData) + 8;
        register({
            id,
            workerId: 'quest',
            family: 'quest',
            kind: 'quest',
            label: spec.label,
            config: {
                aioCategory: 'quester',
                aioRoute: `mode:${spec.mode}`,
                mode: spec.mode,
                script: spec.script,
            },
            baselineRate: {
                xpPerTick: 50,
                unitsPerTick: 0.003,
                gpPerTick: 0,
                setupTicks,
                minBatchUnits: 1,
                confidence: 'model',
            },
            ...(spec.location ? { location: spec.location } : {}),
            trust: trustFor(id, aioKey),
            protectedAllowed: opts.launchQualifiedIds?.has(id) ?? false,
        });
    }

    const questDefByFolder = new Map<string, { id: number; name: string; key: string }>();
    try {
        for (const qd of questDefinitions()) {
            const folder = qd.key === 'fortress' ? 'quest_blackknight' : `quest_${qd.key}`;
            questDefByFolder.set(folder, qd);
        }
    } catch { /* fallback if quest interface file absent in synthetic test root */ }

    const questBySlug = new Map<string, { label: string; qp: number; xpTotal: number; skills: string[]; folder: string }>();
    for (const q of questsJson) {
        const folder = q.folder ?? QUEST_FOLDER_BY_VARP[q.varp] ?? `quest_${q.varp}`;
        const slug = questSlugFromFolder(folder);
        const def = questDefByFolder.get(folder);
        const xpTotal = q.xp.reduce((sum, x) => sum + x.xp * XP_MULTIPLIER, 0);
        const qSkills = [...new Set(q.xp.map((x) => titleCase(x.skill)))];
        questBySlug.set(slug, {
            label: def?.name ?? slug,
            qp: q.questPoints,
            xpTotal,
            skills: qSkills,
            folder,
        });
    }

    const genDir = join(root, 'scripts', 'generated');
    if (existsSync(genDir)) {
        try {
            for (const f of readdirSync(genDir)) {
                if (!f.endsWith('.ts') || f.endsWith('.test.ts') || f === 'quest-lib.ts') continue;
                if (!f.startsWith('quest-') && f !== 'dwarfcannon.ts' && f !== 'waterfall.ts') continue;
                const slug = f.replace(/^quest-/, '').replace(/\.ts$/, '');
                if (slug.endsWith('-owned') || questBySlug.has(slug)) continue;
                questBySlug.set(slug, { label: slug, qp: 1, xpTotal: 0, skills: [], folder: `quest_${slug}` });
            }
        } catch { /* unreadable scripts/generated */ }
    }

    for (const [slug, meta] of [...questBySlug.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const aioKey = `quester:quest:${slug}`;
        const id = `quest:${slug}`;
        const estTicks = QUEST_ESTIMATE_TICKS[slug] ?? 450;
        const xpPerTick = Math.round((meta.xpTotal / estTicks) * 100) / 100;
        const unitsPerTick = Math.round((1 / estTicks) * 100000) / 100000;
        register({
            id,
            workerId: 'quest',
            family: 'quest',
            kind: 'quest',
            label: `Quest: ${meta.label}`,
            questSlug: slug,
            ...(meta.skills.length > 0 ? { skills: meta.skills } : {}),
            config: {
                aioCategory: 'quester',
                aioRoute: `quest:${slug}`,
                questSlug: slug,
                questName: meta.label,
                questPoints: meta.qp,
                script: `scripts/generated/${meta.folder === 'quest_mcannon' ? 'dwarfcannon.ts' : meta.folder === 'quest_waterfall' ? 'waterfall.ts' : `quest-${slug}.ts`}`,
            },
            baselineRate: {
                xpPerTick,
                unitsPerTick,
                gpPerTick: 0,
                setupTicks: 24,
                minBatchUnits: 1,
                confidence: 'model',
            },
            location: HUB_TILES.lumbridge,
            trust: trustFor(id, aioKey),
            protectedAllowed: opts.launchQualifiedIds?.has(id) ?? false,
        });
    }

    // 6. Market modes.
    for (const spec of MARKET_SPECS) {
        const aioKey = `market:${spec.mode}`;
        const id = `market:${spec.mode}`;
        const setupTicks = estimateTravelTicksFromNearestBank(spec.location, travelData) + 6;
        register({
            id,
            workerId: 'market',
            family: 'market',
            kind: spec.kind,
            label: spec.label,
            config: {
                aioCategory: 'market',
                aioRoute: spec.mode,
                mode: spec.mode,
                script: spec.script,
            },
            baselineRate: {
                xpPerTick: 0,
                unitsPerTick: 0.4,
                gpPerTick: spec.gpPerTick,
                setupTicks,
                minBatchUnits: 1,
                confidence: 'model',
            },
            location: spec.location,
            trust: trustFor(id, aioKey),
            protectedAllowed: opts.launchQualifiedIds?.has(id) ?? false,
        });
    }

    // 7. Logistics roles (+ explicit recovery & inspect).
    for (const spec of LOGISTICS_SPECS) {
        const aioKey = spec.role === 'recover-location' || spec.role === 'inspect' ? null : `logistics:${spec.role}`;
        const id = `logistics:${spec.role}`;
        const setupTicks = estimateTravelTicksFromNearestBank(spec.location, travelData) + 6;
        register({
            id,
            workerId: 'logistics',
            family: 'logistics',
            kind: spec.kind,
            label: spec.label,
            config: {
                aioCategory: 'logistics',
                aioRoute: spec.role,
                role: spec.role,
                script: spec.script,
            },
            baselineRate: {
                xpPerTick: 0,
                unitsPerTick: 0.2,
                gpPerTick: 0,
                setupTicks,
                minBatchUnits: spec.minBatchUnits ?? 1,
                confidence: 'model',
            },
            ...(spec.location ? { location: spec.location } : {}),
            trust: spec.role === 'recover-location' ? 'practice_passed' : trustFor(id, aioKey),
            protectedAllowed: opts.launchQualifiedIds?.has(id) ?? false,
        });
    }

    // 8. PvP modes.
    for (const spec of PVP_SPECS) {
        const aioKey = `pvp:${spec.mode}`;
        const id = `pvp:${spec.mode}`;
        const setupTicks = estimateTravelTicksFromNearestBank(spec.location, travelData) + 12;
        register({
            id,
            workerId: 'pvp',
            family: 'pvp',
            kind: 'pk',
            label: spec.label,
            skills: ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic', 'Prayer'],
            config: {
                aioCategory: 'pvp',
                aioRoute: spec.mode,
                mode: spec.mode,
                script: spec.script,
            },
            baselineRate: {
                xpPerTick: 0,
                unitsPerTick: 0.01,
                gpPerTick: 25,
                setupTicks,
                minBatchUnits: 1,
                riskPerHour: spec.riskPerHour,
                confidence: 'model',
            },
            location: spec.location,
            trust: trustFor(id, aioKey),
            protectedAllowed: opts.launchQualifiedIds?.has(id) ?? false,
        });
    }

    if (opts.extraActivities) {
        for (const extra of opts.extraActivities) register(extra);
    }

    // Build lookup indexes for fast O(1)/O(k) planner and demand queries.
    const byFamilyMap = new Map<WorkerFamily, ActivityDefinition[]>();
    const byKindMap = new Map<WorkerKind, ActivityDefinition[]>();
    const byOutputItemMap = new Map<number, ActivityDefinition[]>();
    const bySkillMap = new Map<string, ActivityDefinition[]>();
    const byQuestMap = new Map<string, ActivityDefinition[]>();

    for (const act of activities.values()) {
        const fList = byFamilyMap.get(act.family) ?? [];
        fList.push(act);
        byFamilyMap.set(act.family, fList);

        const kList = byKindMap.get(act.kind) ?? [];
        kList.push(act);
        byKindMap.set(act.kind, kList);

        const outIds = new Set<number>();
        for (const o of act.outputs ?? []) outIds.add(o.itemId);
        for (const k of Object.keys(act.baselineRate.outputsPerUnit ?? {})) outIds.add(Number(k));
        for (const itemId of outIds) {
            const list = byOutputItemMap.get(itemId) ?? [];
            list.push(act);
            byOutputItemMap.set(itemId, list);
        }

        const skillKeys = new Set<string>();
        if (act.skill) skillKeys.add(act.skill.toLowerCase());
        for (const s of act.skills ?? []) skillKeys.add(s.toLowerCase());
        for (const sk of skillKeys) {
            const list = bySkillMap.get(sk) ?? [];
            list.push(act);
            bySkillMap.set(sk, list);
        }

        if (act.questSlug) {
            const addQuestKey = (rawKey: unknown) => {
                if (typeof rawKey !== 'string' || !rawKey.trim()) return;
                for (const key of [rawKey.toLowerCase(), rawKey.toLowerCase().replace(/[^a-z0-9]/g, '')]) {
                    if (!key) continue;
                    const list = byQuestMap.get(key) ?? [];
                    if (!list.includes(act)) list.push(act);
                    byQuestMap.set(key, list);
                }
            };
            addQuestKey(act.questSlug);
            const cfg = act.config as Record<string, unknown> | undefined;
            addQuestKey(cfg?.questName);
        }
    }

    const sortedAll = [...activities.values()].sort((a, b) => a.id.localeCompare(b.id));

    return {
        get: (id) => activities.get(id),
        require: (id) => {
            const act = activities.get(id);
            if (!act) throw new Error(`Unknown ActivityDefinition: ${id}`);
            return act;
        },
        has: (id) => activities.has(id),
        list: (filter) => {
            if (!filter) return sortedAll;
            return sortedAll.filter((act) => {
                if (filter.family !== undefined && act.family !== filter.family) return false;
                if (filter.workerId !== undefined && act.workerId !== filter.workerId) return false;
                if (filter.kind !== undefined && act.kind !== filter.kind) return false;
                if (filter.minTrust !== undefined && !trustMeetsMinimum(act.trust, filter.minTrust)) return false;
                if (filter.protectedAllowed !== undefined && Boolean(act.protectedAllowed) !== filter.protectedAllowed) {
                    return false;
                }
                if (filter.skill !== undefined) {
                    const sk = filter.skill.toLowerCase();
                    const hasSkill = act.skill?.toLowerCase() === sk
                        || act.skills?.some((s) => s.toLowerCase() === sk);
                    if (!hasSkill) return false;
                }
                if (filter.questSlug !== undefined && act.questSlug?.toLowerCase() !== filter.questSlug.toLowerCase()) {
                    return false;
                }
                if (filter.outputItemId !== undefined) {
                    const matchesOut = act.outputs?.some((o) => o.itemId === filter.outputItemId)
                        || act.baselineRate.outputsPerUnit?.[filter.outputItemId] !== undefined;
                    if (!matchesOut) return false;
                }
                return true;
            });
        },
        byFamily: (family) => byFamilyMap.get(family) ?? [],
        byWorkerKind: (kind) => byKindMap.get(kind) ?? [],
        findByOutputItem: (itemId) => byOutputItemMap.get(itemId) ?? [],
        findBySkill: (skill) => bySkillMap.get(skill.toLowerCase()) ?? [],
        findByQuest: (slug) => {
            const lower = slug.toLowerCase();
            return byQuestMap.get(lower) ?? byQuestMap.get(lower.replace(/[^a-z0-9]/g, '')) ?? [];
        },
        size: () => activities.size,
    };
}

let cachedDefaultCatalog: { root: string; catalog: ActivityCatalog } | null = null;
export function defaultActivityCatalog(root = repoRoot): ActivityCatalog {
    const resolved = resolve(root);
    if (!cachedDefaultCatalog || cachedDefaultCatalog.root !== resolved) {
        cachedDefaultCatalog = { root: resolved, catalog: createActivityCatalog({ root: resolved }) };
    }
    return cachedDefaultCatalog.catalog;
}

export { TRUST_TIER_RANK };
