// Shared preflight() and estimate() contracts for the unified WorkerModule<GatherConfig>.
import {
    type PreflightBlocker,
    type PreflightMissingItem,
    type PreflightResult,
    type RateEstimate,
    type RunOutcome,
    type WorkerAccountView,
    type WorkerWorldView,
    accountEscrowCoins,
    accountOwnedItemCount,
    accountReserveFor,
    availableCoinsAfterReserves,
    preflightFail,
    preflightOk,
    reserveAdjustedStock,
} from '../contracts';
import type { FishMethod } from './fishing';
import {
    bestMiningPickaxe,
    bestWoodcuttingAxe,
} from './tools';
import {
    GATHER_METHOD_MAP,
    type GatherConfig,
    type GatherSessionOutcome,
    type NormalizedGatherConfig,
    VALID_GATHER_SKILLS,
    normalizeGatherConfig,
    resolveSetting,
} from './types';

let cachedFishingMod: typeof import('./fishing') | undefined;
let cachedForagingMod: typeof import('./foraging') | undefined;
let cachedMiningRotationMod: typeof import('./mining-rotation') | undefined;
let cachedMiningMod: typeof import('./mining') | undefined;
let cachedThievingMod: typeof import('./thieving') | undefined;

const loadFishingMod = (): typeof import('./fishing') => (cachedFishingMod ??= require('./fishing'));
const loadForagingMod = (): typeof import('./foraging') => (cachedForagingMod ??= require('./foraging'));
const loadMiningRotationMod = (): typeof import('./mining-rotation') => (cachedMiningRotationMod ??= require('./mining-rotation'));
const loadMiningMod = (): typeof import('./mining') => (cachedMiningMod ??= require('./mining'));
const loadThievingMod = (): typeof import('./thieving') => (cachedThievingMod ??= require('./thieving'));

let cachedMiningProfileMap: Map<string, ReturnType<typeof import('./mining')['miningProfiles']>[number]> | undefined;
let cachedMiningSiteSet: Set<string> | undefined;
let cachedPickpocketMap: Map<string, ReturnType<typeof import('./thieving')['pickpocketProfiles']>[number]> | undefined;
let cachedStallMap: Map<string, ReturnType<typeof import('./thieving')['stallRecipes']>[number]> | undefined;

function miningProfileByName(name: string) {
    if (!cachedMiningProfileMap) {
        cachedMiningProfileMap = new Map(loadMiningMod().miningProfiles().map(p => [p.name, p]));
    }
    return cachedMiningProfileMap.get(name);
}

function hasMiningSite(key: string): boolean {
    if (!cachedMiningSiteSet) {
        cachedMiningSiteSet = new Set(loadMiningRotationMod().MINING_SITES.map(s => s.key));
    }
    return cachedMiningSiteSet.has(key);
}

function pickpocketProfileByName(name: string) {
    if (!cachedPickpocketMap) {
        cachedPickpocketMap = new Map(loadThievingMod().pickpocketProfiles().map(p => [p.name, p]));
    }
    return cachedPickpocketMap.get(name);
}

function stallRecipeByName(name: string) {
    if (!cachedStallMap) {
        cachedStallMap = new Map(loadThievingMod().stallRecipes().map(r => [r.name, r]));
    }
    return cachedStallMap.get(name);
}

function skillLevel(acct: WorkerAccountView, name: string): number {
    const direct = acct.skills[name];
    if (direct !== undefined) return direct.level;
    const lower = name.toLowerCase();
    for (const k in acct.skills) {
        if (k.toLowerCase() === lower) return acct.skills[k]!.level;
    }
    return lower === 'hitpoints' ? 10 : 1;
}

function hasSkillEntry(acct: WorkerAccountView, name: string): boolean {
    if (acct.skills[name] !== undefined) return true;
    const lower = name.toLowerCase();
    for (const k in acct.skills) {
        if (k.toLowerCase() === lower) return true;
    }
    return false;
}

function questComplete(acct: WorkerAccountView, needle: string | RegExp): boolean {
    if (typeof needle === 'string') {
        const direct = acct.quests[needle];
        if (direct !== undefined) return direct === 'complete';
        const lower = needle.toLowerCase();
        for (const k in acct.quests) {
            if (k.toLowerCase() === lower) return acct.quests[k] === 'complete';
        }
        return false;
    }
    for (const k in acct.quests) {
        if (needle.test(k) && acct.quests[k] === 'complete') return true;
    }
    return false;
}

function questStatusOf(acct: WorkerAccountView, needle: string | RegExp) {
    if (typeof needle === 'string') {
        const direct = acct.quests[needle];
        if (direct !== undefined) return direct;
        const lower = needle.toLowerCase();
        for (const k in acct.quests) {
            if (k.toLowerCase() === lower) return acct.quests[k]!;
        }
        return 'not_started' as const;
    }
    for (const k in acct.quests) {
        if (needle.test(k)) return acct.quests[k]!;
    }
    return 'not_started' as const;
}

function availableItem(acct: WorkerAccountView, world: WorkerWorldView, itemId: number): { available: number; reserved: number } {
    const owned = accountOwnedItemCount(acct, itemId, { includeBank: true, requireTrustedBank: false });
    const reserved = accountReserveFor(acct, world, itemId);
    return { available: reserveAdjustedStock(owned, reserved), reserved };
}

function stockRecords(acct: WorkerAccountView, world: WorkerWorldView): { id: number; count: number }[] {
    const ids = new Set<number>();
    for (const k in acct.inventory) ids.add(Number(k));
    for (const k in acct.equipment) ids.add(Number(k));
    for (const k in acct.bank.items) ids.add(Number(k));
    const rows: { id: number; count: number }[] = [];
    for (const id of ids) {
        const { available } = availableItem(acct, world, id);
        if (available > 0) rows.push({ id, count: available });
    }
    return rows;
}

function primarySkillName(cfg: NormalizedGatherConfig): string | null {
    switch (cfg.skill) {
        case 'fishing':
            return 'Fishing';
        case 'woodcutting':
            return 'Woodcutting';
        case 'mining':
            return 'Mining';
        case 'thieving':
            return 'Thieving';
        case 'foraging':
            return null;
    }
}

function woodcuttingTreeRequiredLevel(cfg: NormalizedGatherConfig): number {
    const tree = (cfg.spot ?? resolveSetting(cfg, 'TREE') ?? (cfg.region === 'draynor' || resolveSetting(cfg, 'REGION') === 'draynor' ? 'normal' : 'yew')).toLowerCase();
    if (tree === 'magic') return 75;
    if (tree === 'yew') return 60;
    if (tree === 'maple') return 45;
    if (tree === 'willow') return 30;
    if (tree === 'oak') return 15;
    return 1;
}

export function gatherPreflight(
    acct: WorkerAccountView,
    rawCfg: GatherConfig,
    world: WorkerWorldView,
): PreflightResult {
    const blockers: PreflightBlocker[] = [];
    const missingItems: PreflightMissingItem[] = [];

    if (!rawCfg || typeof rawCfg.skill !== 'string' || typeof rawCfg.method !== 'string') {
        return preflightFail([{ kind: 'invalid_config', message: 'gather config requires skill and method' }]);
    }
    const cfg = normalizeGatherConfig(rawCfg);

    if (!VALID_GATHER_SKILLS.includes(cfg.skill)) {
        return preflightFail([{ kind: 'invalid_config', message: `unsupported gather skill: ${cfg.skill}` }]);
    }
    if (!GATHER_METHOD_MAP[cfg.skill].includes(cfg.method)) {
        return preflightFail([{ kind: 'invalid_config', message: `unsupported ${cfg.skill} method: ${cfg.method}` }]);
    }

    if (acct.protectedClock) {
        blockers.push({ kind: 'protected_clock', message: 'protected account clock restricts ordinary gather module' });
    }

    const pSkill = primarySkillName(cfg);
    if (pSkill && acct.maxLevels?.[pSkill] !== undefined) {
        const current = skillLevel(acct, pSkill);
        const cap = acct.maxLevels[pSkill]!;
        if (current >= cap) {
            blockers.push({ kind: 'max_level_cap', skill: pSkill, maxLevel: cap, current });
        }
    }

    const totalCoins = accountOwnedItemCount(acct, 995, { includeBank: true, requireTrustedBank: false });
    const reservedCoins = accountReserveFor(acct, world, 995);
    const escrowCoins = accountEscrowCoins(acct, world);
    const spendableCoins = availableCoinsAfterReserves(totalCoins, reservedCoins, escrowCoins, 0);
    let cachedStock: { id: number; count: number }[] | undefined;
    const stock = () => (cachedStock ??= stockRecords(acct, world));

    const requireItem = (itemId: number, required: number, itemName?: string) => {
        const { available, reserved } = availableItem(acct, world, itemId);
        if (available < required) {
            blockers.push({ kind: 'missing_supply', itemId, itemName, required, available, reserved });
            missingItems.push({ itemId, count: required - available, ...(itemName ? { itemName } : {}) });
        }
        return available;
    };

    const requireSkill = (skill: string, required: number) => {
        const current = skillLevel(acct, skill);
        if (current < required) {
            blockers.push({ kind: 'skill_level', skill, required, current });
        }
        return current;
    };

    if (acct.pos && acct.pos.level !== 0 && cfg.method !== 'nature-chest') {
        blockers.push({
            kind: 'unreachable_tile',
            target: { x: acct.pos.x, z: acct.pos.z, level: 0 },
            from: acct.pos,
            reason: 'plane_mismatch',
            message: 'ground-floor entry expected',
        });
    }

    switch (cfg.skill) {
        case 'fishing': {
            if (cfg.method === 'shark') {
                requireSkill('Fishing', 76);
                requireSkill('Cooking', 80);
                if (hasSkillEntry(acct, 'Hitpoints') && skillLevel(acct, 'Hitpoints') < 40) {
                    blockers.push({
                        kind: 'combat_survivability',
                        reason: 'hitpoints',
                        required: 40,
                        current: skillLevel(acct, 'Hitpoints'),
                    });
                }
                const harpoons = availableItem(acct, world, 311);
                if (harpoons.available < 1 && spendableCoins < 1200) {
                    blockers.push({
                        kind: 'missing_coins',
                        required: 1200,
                        available: totalCoins,
                        reserved: reservedCoins + escrowCoins,
                        message: 'harpoon (311) missing and coins < 1200 for Harry purchase + reserve',
                    });
                }
                const foodSum = [333, 329, 379].reduce((sum, id) => sum + availableItem(acct, world, id).available, 0);
                if (foodSum < 2) {
                    requireItem(329, 2, 'Salmon');
                }
            } else if (cfg.method === 'cage') {
                requireSkill('Fishing', 40);
                const pots = availableItem(acct, world, 301);
                if (pots.available < 1 && spendableCoins < 50) {
                    requireItem(301, 1, 'Lobster pot');
                }
            } else if (cfg.method === 'harpoon') {
                requireSkill('Fishing', 35);
                const harpoons = availableItem(acct, world, 311);
                if (harpoons.available < 1 && spendableCoins < 50) {
                    requireItem(311, 1, 'Harpoon');
                }
            } else if (cfg.method === 'village') {
                const sub = cfg.spot ?? resolveSetting(cfg, 'VILLAGE_METHOD') ?? 'fly';
                if (sub !== 'fly' && sub !== 'riverBait') {
                    blockers.push({ kind: 'invalid_config', message: `invalid village fishing method: ${sub}` });
                } else {
                    const prof = loadFishingMod().FISH_PROFILES[sub];
                    requireSkill('Fishing', prof.level);
                    requireItem(prof.tool, 1);
                    if (prof.bait) requireItem(prof.bait, 1);
                }
            } else if (cfg.method === 'fishcook') {
                const foodTarget = resolveSetting(cfg, 'FOOD_TARGET') ?? (cfg.target?.count ? String(cfg.target.count) : undefined);
                if (foodTarget !== undefined) {
                    const n = Number(foodTarget);
                    if (!Number.isSafeInteger(n) || n < 1 || n > 28) {
                        blockers.push({ kind: 'invalid_config', message: 'invalid FOOD_TARGET' });
                    } else {
                        requireSkill('Cooking', 25);
                        if (hasSkillEntry(acct, 'Hitpoints') && skillLevel(acct, 'Hitpoints') < 27) {
                            blockers.push({
                                kind: 'combat_survivability',
                                reason: 'hitpoints',
                                required: 27,
                                current: skillLevel(acct, 'Hitpoints'),
                            });
                        }
                    }
                }
            } else if (cfg.method === 'staged') {
                const methodKey = cfg.spot ?? cfg.args[0] ?? resolveSetting(cfg, 'METHOD') ?? 'fly';
                const { FISH_PROFILES } = loadFishingMod();
                if (methodKey === 'shark') {
                    requireSkill('Fishing', 76);
                    requireItem(311, 1, 'Harpoon');
                } else if (!(methodKey in FISH_PROFILES)) {
                    blockers.push({ kind: 'invalid_config', message: `unknown fishing profile: ${methodKey}` });
                } else {
                    const prof = FISH_PROFILES[methodKey as FishMethod];
                    requireSkill('Fishing', prof.level);
                    if (methodKey === 'karambwan') {
                        const vessel = availableItem(acct, world, 3157).available + availableItem(acct, world, 3159).available;
                        if (vessel < 1) requireItem(3157, 1, 'Karambwan vessel');
                        if (availableItem(acct, world, 3159).available < 1) requireItem(3150, 1, 'Raw karambwanji');
                    } else {
                        requireItem(prof.tool, 1);
                        if (prof.bait) requireItem(prof.bait, 1);
                    }
                }
            }
            break;
        }
        case 'woodcutting': {
            const wcLevel = skillLevel(acct, 'Woodcutting');
            const atkLevel = skillLevel(acct, 'Attack');
            const rec = bestWoodcuttingAxe(stock(), { woodcutting: wcLevel, attack: atkLevel }).current;
            if (cfg.method === 'edgeville') {
                requireSkill('Woodcutting', 15);
                if (wcLevel >= 36) {
                    blockers.push({ kind: 'max_level_cap', skill: 'Woodcutting', maxLevel: 36, current: wcLevel });
                }
                if (!rec) requireItem(1351, 1, 'Bronze axe');
            } else if (cfg.method === 'woodcut-supply') {
                const logs = Number(resolveSetting(cfg, 'SUPPLY_LOGS') ?? cfg.target?.count ?? 1);
                if (!Number.isSafeInteger(logs) || logs < 1 || logs > 25) {
                    blockers.push({ kind: 'invalid_config', message: 'woodcut-supply requires 1..25 logs' });
                }
                if (!rec && spendableCoins < 20) {
                    requireItem(1351, 1, 'Bronze axe');
                }
            } else if (cfg.method === 'yews') {
                const normGrove = resolveSetting(cfg, 'NORMAL_GROVE');
                const oakGroveName = resolveSetting(cfg, 'OAK_GROVE');
                const woodGrove = resolveSetting(cfg, 'WOOD_GROVE');
                const reg = cfg.region ?? resolveSetting(cfg, 'REGION');
                const tree = (cfg.spot ?? resolveSetting(cfg, 'TREE') ?? (reg === 'draynor' ? 'normal' : 'yew')).toLowerCase();
                if (normGrove && normGrove !== 'south' && normGrove !== 'north') {
                    blockers.push({ kind: 'invalid_config', message: `invalid NORMAL_GROVE: ${normGrove}` });
                }
                if (oakGroveName && oakGroveName !== 'north' && oakGroveName !== 'west') {
                    blockers.push({ kind: 'invalid_config', message: `invalid OAK_GROVE: ${oakGroveName}` });
                }
                if (woodGrove !== undefined && (woodGrove !== 'native-processing' || reg === 'lumbridge' || reg === 'draynor')) {
                    blockers.push({ kind: 'invalid_config', message: `invalid WOOD_GROVE: ${woodGrove}` });
                }
                if (normGrove && (reg !== 'draynor' || tree !== 'normal')) {
                    blockers.push({ kind: 'invalid_config', message: 'NORMAL_GROVE requires Draynor normal trees' });
                }
                const reqLvl = woodcuttingTreeRequiredLevel(cfg);
                requireSkill('Woodcutting', reqLvl);
                const allowShop = reg === 'lumbridge' || reg === 'draynor';
                if (!rec && (!allowShop || spendableCoins < 16)) {
                    requireItem(1351, 1, 'Bronze axe');
                }
            } else if (cfg.method === 'loop') {
                if (!rec) requireItem(1351, 1, 'Bronze axe');
            }
            break;
        }
        case 'mining': {
            const mLevel = skillLevel(acct, 'Mining');
            const atkLevel = skillLevel(acct, 'Attack');
            const rec = bestMiningPickaxe(stock(), { mining: mLevel, attack: atkLevel }).current;
            if (cfg.method === 'ore') {
                const profile = cfg.spot ?? resolveSetting(cfg, 'ORE_PROFILE') ?? 'mixed';
                if (profile !== 'mixed' && profile !== 'clay') {
                    blockers.push({ kind: 'invalid_config', message: `invalid ORE_PROFILE: ${profile}` });
                }
            } else if (cfg.method === 'essence') {
                if (!questComplete(acct, 'Rune Mysteries')) {
                    blockers.push({
                        kind: 'quest_incomplete',
                        quest: 'Rune Mysteries',
                        requiredState: 'complete',
                        currentState: questStatusOf(acct, 'Rune Mysteries'),
                    });
                }
                const allowShop = resolveSetting(cfg, 'ALLOW_SHOP_UPGRADE') !== '0';
                if (!rec && (!allowShop || spendableCoins < 1)) {
                    requireItem(1265, 1, 'Bronze pickaxe');
                }
            } else if (cfg.method === 'at-site' || cfg.method === 'drop') {
                const profName = cfg.spot ?? cfg.args[0] ?? resolveSetting(cfg, 'PROFILE') ?? 'iron_rock_table';
                const prof = miningProfileByName(profName);
                if (!prof || prof.essence) {
                    blockers.push({ kind: 'invalid_config', message: `invalid mining profile: ${profName}` });
                } else {
                    requireSkill('Mining', prof.level);
                }
                const siteKey = resolveSetting(cfg, 'MINING_SITE');
                if (siteKey && !hasMiningSite(siteKey)) {
                    blockers.push({ kind: 'invalid_config', message: `unknown MINING_SITE: ${siteKey}` });
                }
                if (!rec) requireItem(1265, 1, 'Bronze pickaxe');
            } else if (cfg.method === 'progressive') {
                if (!rec) requireItem(1265, 1, 'Bronze pickaxe');
            } else if (cfg.method === 'lava-maze') {
                requireSkill('Mining', 85);
                if (hasSkillEntry(acct, 'Hitpoints') && skillLevel(acct, 'Hitpoints') < 30) {
                    blockers.push({
                        kind: 'combat_survivability',
                        reason: 'hitpoints',
                        required: 30,
                        current: skillLevel(acct, 'Hitpoints'),
                    });
                }
                requireItem(1275, 1, 'Rune pickaxe');
                requireItem(385, 4, 'Shark');
            }
            break;
        }
        case 'thieving': {
            if (cfg.method === 'knights' || cfg.method === 'knights-stable') {
                requireSkill('Thieving', 55);
                if (cfg.method === 'knights-stable') {
                    if (acct.pos) {
                        const nearBank = Math.max(Math.abs(acct.pos.x - 2654), Math.abs(acct.pos.z - 3283)) <= 40;
                        const nearSpot = Math.max(Math.abs(acct.pos.x - 2653), Math.abs(acct.pos.z - 3302)) <= 40;
                        if (acct.pos.level !== 0 || (!nearBank && !nearSpot)) {
                            blockers.push({
                                kind: 'unreachable_tile',
                                target: { x: 2654, z: 3283, level: 0 },
                                from: acct.pos,
                                reason: 'no_route',
                                message: 'knights-stable requires start in Ardougne market',
                            });
                        }
                    }
                    const foodSum = [333, 329, 379, 385, 1891, 2309, 1901].reduce(
                        (sum, id) => sum + availableItem(acct, world, id).available,
                        0,
                    );
                    if (foodSum < 2 && !resolveSetting(cfg, 'FOOD_FROM')) {
                        blockers.push({
                            kind: 'combat_survivability',
                            reason: 'food',
                            required: 2,
                            current: foodSum,
                            message: 'knights-stable requires owned food or FOOD_FROM courier',
                        });
                    }
                }
            } else if (cfg.method === 'pickpocket-at-site') {
                const name = cfg.spot ?? cfg.args[0] ?? resolveSetting(cfg, 'PROFILE') ?? '';
                const prof = pickpocketProfileByName(name);
                if (!prof) {
                    blockers.push({ kind: 'invalid_config', message: `unknown pickpocket profile: ${name || '-'}` });
                } else {
                    requireSkill('Thieving', prof.level);
                    if (prof.name === 'viking' && !questComplete(acct, /fremennik/i)) {
                        blockers.push({
                            kind: 'quest_incomplete',
                            quest: 'The Fremennik Trials',
                            requiredState: 'complete',
                            currentState: questStatusOf(acct, /fremennik/i),
                        });
                    }
                }
            } else if (cfg.method === 'pickpocket') {
                const name = cfg.spot ?? resolveSetting(cfg, 'PROFILE');
                if (name) {
                    const prof = pickpocketProfileByName(name);
                    if (!prof) blockers.push({ kind: 'invalid_config', message: `unknown pickpocket profile: ${name}` });
                    else requireSkill('Thieving', prof.level);
                }
            } else if (cfg.method === 'stalls') {
                const stall = cfg.spot ?? cfg.args[0] ?? resolveSetting(cfg, 'STALL') ?? '';
                const rec = stallRecipeByName(stall);
                if (!rec) {
                    blockers.push({ kind: 'invalid_config', message: `unknown stall recipe: ${stall || '-'}` });
                } else {
                    requireSkill('Thieving', rec.level);
                    if (rec.questGate && !questComplete(acct, /fremennik/i)) {
                        blockers.push({
                            kind: 'quest_incomplete',
                            quest: 'The Fremennik Trials',
                            requiredState: 'complete',
                            currentState: questStatusOf(acct, /fremennik/i),
                        });
                    }
                }
            } else if (cfg.method === 'blood-chest') {
                requireSkill('Thieving', 59);
            } else if (cfg.method === 'nature-chest') {
                requireSkill('Thieving', 28);
            }
            break;
        }
        case 'foraging': {
            if (cfg.method === 'wool') {
                requireItem(1735, 1, 'Shears');
            } else if (cfg.method === 'spawn') {
                const rawId = cfg.spot ?? cfg.args[0];
                const id = Number(rawId);
                if (!Number.isSafeInteger(id) || id < 0) {
                    blockers.push({ kind: 'invalid_config', message: `invalid spawn item id: ${String(rawId)}` });
                }
            } else if (cfg.method === 'crystal-chest') {
                if (cfg.members === false) {
                    blockers.push({ kind: 'invalid_config', message: 'foraging:crystal-chest requires members access' });
                }
                const { CRYSTAL_KEY, KEY_LOOP, KEY_TOOTH } = loadForagingMod();
                const full = availableItem(acct, world, CRYSTAL_KEY).available;
                const tooth = availableItem(acct, world, KEY_TOOTH).available;
                const loop = availableItem(acct, world, KEY_LOOP).available;
                if (full < 1 && Math.min(tooth, loop) < 1) {
                    requireItem(CRYSTAL_KEY, 1, 'Crystal key');
                }
            }
            break;
        }
    }

    if (cfg.spot && world.spotOccupancy) {
        const occ = world.spotOccupancy[cfg.spot];
        if (occ !== undefined && occ >= 4) {
            blockers.push({ kind: 'capacity_full', spotId: cfg.spot, active: occ, limit: 4 });
        }
    }

    return blockers.length === 0
        ? preflightOk()
        : preflightFail(blockers, missingItems.length > 0 ? { missingItems } : {});
}

export function gatherEstimate(
    acct: WorkerAccountView,
    rawCfg: GatherConfig,
    _world: WorkerWorldView,
): RateEstimate {
    const cfg = normalizeGatherConfig(rawCfg);
    const level = primarySkillName(cfg) ? skillLevel(acct, primarySkillName(cfg)!) : 1;
    const rawRate = Number(resolveSetting(cfg, 'XP_RATE') ?? 25);
    const xpRate = Number.isFinite(rawRate) && rawRate > 0 ? rawRate : 25;
    const scaleXp = (base: number) => Number((base * xpRate).toFixed(2));

    switch (cfg.skill) {
        case 'fishing': {
            if (cfg.method === 'shark') {
                const fish = scaleXp(4.0);
                const cook = scaleXp(2.5);
                return {
                    xpPerTick: scaleXp(6.5),
                    skillXpPerTick: { Fishing: fish, Cooking: cook },
                    unitsPerTick: 0.036,
                    gpPerTick: 28,
                    setupTicks: 180,
                    minBatchUnits: 10,
                    riskPerHour: 0.02,
                    confidence: 'practice',
                    outputsPerUnit: { 385: 1 },
                };
            }
            if (cfg.method === 'cage') {
                const xp = scaleXp(5.2);
                return {
                    xpPerTick: xp,
                    skillXpPerTick: { Fishing: xp },
                    unitsPerTick: 0.058,
                    gpPerTick: 12,
                    setupTicks: 80,
                    minBatchUnits: 10,
                    riskPerHour: 0.01,
                    confidence: 'practice',
                    outputsPerUnit: { 377: 1 },
                };
            }
            if (cfg.method === 'harpoon') {
                const xp = scaleXp(6.0);
                return {
                    xpPerTick: xp,
                    skillXpPerTick: { Fishing: xp },
                    unitsPerTick: 0.065,
                    gpPerTick: 18,
                    setupTicks: 80,
                    minBatchUnits: 10,
                    riskPerHour: 0.01,
                    confidence: 'practice',
                    outputsPerUnit: { 359: 0.6, 371: 0.4 },
                };
            }
            if (cfg.method === 'fishcook' || cfg.method === 'village') {
                const fish = scaleXp(10.5);
                const cook = scaleXp(7.5);
                return {
                    xpPerTick: scaleXp(18.0),
                    skillXpPerTick: { Fishing: fish, Cooking: cook },
                    unitsPerTick: 0.052,
                    gpPerTick: 2,
                    setupTicks: 120,
                    minBatchUnits: 10,
                    riskPerHour: 0.02,
                    confidence: 'practice',
                    outputsPerUnit: { 333: 0.6, 329: 0.4 },
                    inputsPerUnit: { 314: 1 },
                };
            }
            const methodKey = (cfg.spot ?? cfg.args[0] ?? 'fly') as FishMethod;
            const { FISH_PROFILES } = loadFishingMod();
            const prof = FISH_PROFILES[methodKey] ?? FISH_PROFILES.fly;
            const xp = scaleXp(Math.max(2, prof.level * 0.4 + 4));
            return {
                xpPerTick: xp,
                skillXpPerTick: { Fishing: xp },
                unitsPerTick: 0.25,
                gpPerTick: 4,
                setupTicks: 20,
                minBatchUnits: 5,
                riskPerHour: 0.01,
                confidence: 'practice',
                outputsPerUnit: { [prof.products[0]]: 1 },
                ...(prof.bait ? { inputsPerUnit: { [prof.bait]: 1 } } : {}),
            };
        }
        case 'woodcutting': {
            if (cfg.method === 'edgeville') {
                const xp = scaleXp(8.5);
                return {
                    xpPerTick: xp,
                    skillXpPerTick: { Woodcutting: xp },
                    unitsPerTick: 0.14,
                    gpPerTick: 3,
                    setupTicks: 60,
                    minBatchUnits: 10,
                    riskPerHour: 0.01,
                    confidence: 'practice',
                    outputsPerUnit: { 1521: 1 },
                };
            }
            if (cfg.method === 'woodcut-supply') {
                const wc = scaleXp(4.5);
                const fletch = scaleXp(1.5);
                return {
                    xpPerTick: scaleXp(6.0),
                    skillXpPerTick: { Woodcutting: wc, Fletching: fletch },
                    unitsPerTick: 0.1,
                    gpPerTick: 2,
                    setupTicks: 90,
                    minBatchUnits: 1,
                    riskPerHour: 0.02,
                    confidence: 'practice',
                    outputsPerUnit: { 52: 15 },
                };
            }
            const reqLvl = woodcuttingTreeRequiredLevel(cfg);
            const rateScale = Math.min(2, 0.7 + level / 80);
            const unitRate = reqLvl >= 60 ? 0.03 * rateScale : reqLvl >= 15 ? 0.14 * rateScale : 0.22 * rateScale;
            const outId = reqLvl >= 75 ? 1513 : reqLvl >= 60 ? 1515 : reqLvl >= 45 ? 1517 : reqLvl >= 30 ? 1519 : reqLvl >= 15 ? 1521 : 1511;
            const xpPerLog = reqLvl >= 75 ? 250 : reqLvl >= 60 ? 175 : reqLvl >= 45 ? 100 : reqLvl >= 30 ? 67.5 : reqLvl >= 15 ? 37.5 : 25;
            const xp = scaleXp(unitRate * xpPerLog);
            return {
                xpPerTick: xp,
                skillXpPerTick: { Woodcutting: xp },
                unitsPerTick: unitRate,
                gpPerTick: reqLvl >= 60 ? 10 : 3,
                setupTicks: 60,
                minBatchUnits: 10,
                riskPerHour: 0.01,
                confidence: 'practice',
                outputsPerUnit: { [outId]: 1 },
            };
        }
        case 'mining': {
            if (cfg.method === 'essence') {
                const xp = scaleXp(1.4);
                return {
                    xpPerTick: xp,
                    skillXpPerTick: { Mining: xp },
                    unitsPerTick: 0.28,
                    gpPerTick: 6,
                    setupTicks: 80,
                    minBatchUnits: 28,
                    riskPerHour: 0.01,
                    confidence: 'practice',
                    outputsPerUnit: { 1436: 1 },
                };
            }
            if (cfg.method === 'lava-maze') {
                const xp = scaleXp(1.2);
                return {
                    xpPerTick: xp,
                    skillXpPerTick: { Mining: xp },
                    unitsPerTick: 0.004,
                    gpPerTick: 45,
                    setupTicks: 300,
                    minBatchUnits: 1,
                    riskPerHour: 0.25,
                    confidence: 'practice',
                    outputsPerUnit: { 451: 1 },
                };
            }
            if (cfg.method === 'loot') {
                return {
                    xpPerTick: 0,
                    unitsPerTick: 0.1,
                    gpPerTick: 10,
                    setupTicks: 10,
                    minBatchUnits: 1,
                    riskPerHour: 0.01,
                    confidence: 'model',
                };
            }
            const profName = cfg.spot ?? cfg.args[0] ?? 'iron_rock_table';
            const prof = miningProfileByName(profName);
            const unitsPerTick = cfg.method === 'ore' ? 0.12 : prof && prof.level >= 55 ? 0.06 : 0.25;
            const outId = prof?.products[0] ?? 440;
            const xpPerOre = prof && prof.level >= 40 ? 65 : 35;
            const xp = scaleXp(unitsPerTick * xpPerOre);
            return {
                xpPerTick: xp,
                skillXpPerTick: { Mining: xp },
                unitsPerTick,
                gpPerTick: 8,
                setupTicks: cfg.method === 'at-site' || cfg.method === 'drop' ? 10 : 70,
                minBatchUnits: 10,
                riskPerHour: 0.01,
                confidence: 'practice',
                outputsPerUnit: { [outId]: 1 },
            };
        }
        case 'thieving': {
            if (cfg.method === 'knights' || cfg.method === 'knights-stable') {
                const successRate = Math.min(0.94, Math.max(0.45, 0.35 + level * 0.006));
                const unitsPerTick = 0.4 * successRate;
                const xp = scaleXp(unitsPerTick * 84.3);
                return {
                    xpPerTick: xp,
                    skillXpPerTick: { Thieving: xp },
                    unitsPerTick,
                    gpPerTick: unitsPerTick * 50,
                    setupTicks: 40,
                    minBatchUnits: 20,
                    riskPerHour: 0.03,
                    confidence: 'practice',
                    outputsPerUnit: { 995: 50 },
                };
            }
            if (cfg.method === 'blood-chest') {
                const xp = scaleXp(0.4);
                return {
                    xpPerTick: xp,
                    skillXpPerTick: { Thieving: xp },
                    unitsPerTick: 0.005,
                    gpPerTick: 4.5,
                    setupTicks: 200,
                    minBatchUnits: 1,
                    riskPerHour: 0.05,
                    confidence: 'practice',
                    outputsPerUnit: { 565: 2, 995: 500 },
                };
            }
            if (cfg.method === 'nature-chest') {
                const xp = scaleXp(1.5);
                return {
                    xpPerTick: xp,
                    skillXpPerTick: { Thieving: xp },
                    unitsPerTick: 0.06,
                    gpPerTick: 12,
                    setupTicks: 10,
                    minBatchUnits: 5,
                    riskPerHour: 0.01,
                    confidence: 'practice',
                    outputsPerUnit: { 561: 1, 995: 3 },
                };
            }
            if (cfg.method === 'stalls') {
                const xp = scaleXp(6.0);
                return {
                    xpPerTick: xp,
                    skillXpPerTick: { Thieving: xp },
                    unitsPerTick: 0.12,
                    gpPerTick: 8,
                    setupTicks: 15,
                    minBatchUnits: 5,
                    riskPerHour: 0.02,
                    confidence: 'practice',
                };
            }
            const xp = scaleXp(4.0);
            return {
                xpPerTick: xp,
                skillXpPerTick: { Thieving: xp },
                unitsPerTick: 0.25,
                gpPerTick: 5,
                setupTicks: 20,
                minBatchUnits: 5,
                riskPerHour: 0.02,
                confidence: 'practice',
            };
        }
        case 'foraging': {
            if (cfg.method === 'crystal-chest') {
                return {
                    xpPerTick: 0,
                    unitsPerTick: 0.025,
                    gpPerTick: 250,
                    setupTicks: 120,
                    minBatchUnits: 1,
                    riskPerHour: 0.01,
                    confidence: 'practice',
                    outputsPerUnit: { 1631: 1 },
                    inputsPerUnit: { 989: 1 },
                };
            }
            const outId =
                cfg.method === 'flax'
                    ? 1779
                    : cfg.method === 'wool'
                      ? 1759
                      : cfg.method === 'feathers'
                        ? 314
                        : cfg.method === 'grapes'
                          ? 1987
                          : Math.max(1, Number(cfg.spot ?? cfg.args[0] ?? 1));
            const baseXp = cfg.method === 'wool' ? 2.5 : cfg.method === 'feathers' ? 4.0 : 0;
            return {
                xpPerTick: scaleXp(baseXp),
                unitsPerTick: cfg.method === 'feathers' ? 0.5 : 0.18,
                gpPerTick: cfg.method === 'flax' ? 12 : 4,
                setupTicks: 60,
                minBatchUnits: 10,
                riskPerHour: 0.01,
                confidence: 'practice',
                outputsPerUnit: { [outId]: 1 },
            };
        }
    }
}

export function toWorkerOutcome(
    outcome: GatherSessionOutcome,
    account: string,
    cfg: NormalizedGatherConfig,
    fallbackTicks: number,
    opts: { stopped?: boolean } = {},
): RunOutcome {
    const activityId = `gather:${cfg.skill}:${cfg.method}`;
    const ticksElapsed = Math.max(0, Math.trunc(outcome.delta?.elapsedTicks ?? fallbackTicks));
    const itemsDelta = outcome.delta?.items;
    const xpGained = outcome.delta?.xp;
    const coinsDelta = outcome.delta?.coins;
    const summary = outcome.summary as Record<string, unknown> | undefined;
    const unitsCompleted =
        typeof summary?.banked === 'number'
            ? Math.max(0, summary.banked)
            : typeof summary?.made === 'number'
              ? Math.max(0, summary.made)
              : typeof summary?.opened === 'number'
                ? Math.max(0, summary.opened)
                : undefined;
    const base = {
        activityId,
        account,
        ticksElapsed,
        ...(unitsCompleted !== undefined ? { unitsCompleted } : {}),
        ...(xpGained ? { xpGained } : {}),
        ...(itemsDelta ? { itemsDelta } : {}),
        ...(coinsDelta !== undefined ? { coinsDelta } : {}),
        summary: outcome.resultLine ?? outcome.detail,
    };

    if (outcome.ok) {
        return { kind: 'target_met', ...base };
    }
    const lower = (outcome.detail ?? '').toLowerCase();
    if (outcome.kind === 'died' || /\bdied\b/.test(lower)) {
        return { kind: 'death', ...base, faultSignature: 'gather_death', detail: outcome.detail };
    }
    if (opts.stopped || outcome.kind === 'aborted' || /\b(stop|stopped|interrupt|interrupted|session ended|ended)\b/i.test(outcome.detail ?? '')) {
        return {
            kind: 'session_unsettled',
            ...base,
            reason: outcome.detail || 'stopped',
            detail: outcome.detail,
        };
    }
    if (/missing|exhausted|requires owned|no (crystal_key|fly fishing rod|small fishing net|owned)/i.test(outcome.detail)) {
        return {
            kind: 'missing_supply',
            ...base,
            missing: [{ itemId: 0, required: 1, available: 0, itemName: outcome.detail.slice(0, 80) }],
        };
    }
    if (/route|walk|travel|unreachable|lost|stair|door|bank unavailable/i.test(outcome.detail)) {
        return { kind: 'location_stranded', ...base, detail: outcome.detail };
    }
    return {
        kind: 'worker_defect',
        ...base,
        faultSignature: `${activityId}:failed`,
        detail: outcome.detail,
    };
}
