// Shared preflight(), estimate(), and RunOutcome adapters for the unified WorkerModule<ArtisanConfig>.
import {
    accountEscrowCoins,
    accountOwnedItemCount,
    accountReserveFor,
    availableCoinsAfterReserves,
    preflightFail,
    preflightOk,
    reserveAdjustedStock,
    type PreflightBlocker,
    type PreflightMissingItem,
    type PreflightResult,
    type RateEstimate,
    type RunOutcome,
    type WorkerAccountView,
    type WorkerWorldView,
} from '../contracts';
import { levelForXp, xpForLevel } from './catalog';
import type { JewelleryOrder, ProgressiveProduction } from './crafting';
import type { ArrowMetal } from './fletching';
import type { OrbKind } from './magic';
import {
    ARTISAN_METHOD_MAP,
    normalizeArtisanConfig,
    resolveArtisanSetting,
    VALID_ARTISAN_SKILLS,
    type ArtisanConfig,
    type ArtisanSessionOutcome,
    type NormalizedArtisanConfig,
} from './types';

let cachedCatalogMod: typeof import('./catalog') | undefined;
let cachedCookingMod: typeof import('./cooking') | undefined;
let cachedCraftingMod: typeof import('./crafting') | undefined;
let cachedFiremakingMod: typeof import('./firemaking') | undefined;
let cachedFletchingMod: typeof import('./fletching') | undefined;
let cachedHerbloreMod: typeof import('./herblore') | undefined;
let cachedMagicMod: typeof import('./magic') | undefined;
let cachedPrayerMod: typeof import('./prayer') | undefined;
let cachedSmithingMod: typeof import('./smithing') | undefined;

const loadCatalogMod = (): typeof import('./catalog') => (cachedCatalogMod ??= require('./catalog'));
const loadCookingMod = (): typeof import('./cooking') => (cachedCookingMod ??= require('./cooking'));
const loadCraftingMod = (): typeof import('./crafting') => (cachedCraftingMod ??= require('./crafting'));
const loadFiremakingMod = (): typeof import('./firemaking') => (cachedFiremakingMod ??= require('./firemaking'));
const loadFletchingMod = (): typeof import('./fletching') => (cachedFletchingMod ??= require('./fletching'));
const loadHerbloreMod = (): typeof import('./herblore') => (cachedHerbloreMod ??= require('./herblore'));
const loadMagicMod = (): typeof import('./magic') => (cachedMagicMod ??= require('./magic'));
const loadPrayerMod = (): typeof import('./prayer') => (cachedPrayerMod ??= require('./prayer'));
const loadSmithingMod = (): typeof import('./smithing') => (cachedSmithingMod ??= require('./smithing'));

let cachedCookingByName: Map<string, ReturnType<typeof import('./cooking')['cookingRecipes']>['recipes'][number]> | undefined;
let cachedJewelleryByName: Map<string, ReturnType<typeof import('./crafting')['jewelleryRecipes']>[number]> | undefined;
let cachedInventoryByName: Map<string, ReturnType<typeof import('./crafting')['inventoryRecipes']>[number]> | undefined;

function cookingRecipeByName(name: string) {
    if (!cachedCookingByName) {
        cachedCookingByName = new Map(loadCookingMod().cookingRecipes().recipes.map(r => [r.name, r]));
    }
    return cachedCookingByName.get(name);
}

function jewelleryRecipeByName(name: string) {
    if (!cachedJewelleryByName) {
        cachedJewelleryByName = new Map(loadCraftingMod().jewelleryRecipes().map(r => [r.name, r]));
    }
    return cachedJewelleryByName.get(name);
}

function inventoryRecipeByName(name: string) {
    if (!cachedInventoryByName) {
        cachedInventoryByName = new Map(loadCraftingMod().inventoryRecipes().map(r => [r.name, r]));
    }
    return cachedInventoryByName.get(name);
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

function skillXp(acct: WorkerAccountView, name: string): number {
    const direct = acct.skills[name];
    if (direct !== undefined) return direct.xp;
    const lower = name.toLowerCase();
    for (const k in acct.skills) {
        if (k.toLowerCase() === lower) return acct.skills[k]!.xp;
    }
    return 0;
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

function usableStock(acct: WorkerAccountView, world: WorkerWorldView, itemId: number): { available: number; reserved: number; usable: number } {
    const available = accountOwnedItemCount(acct, itemId, { requireTrustedBank: false });
    const reserved = accountReserveFor(acct, world, itemId);
    return { available, reserved, usable: reserveAdjustedStock(available, reserved) };
}

function parseIntSetting(
    raw: string | undefined,
    fallback: number,
    opts: { min: number; max?: number; label: string },
    blockers: PreflightBlocker[],
): number | null {
    const val = raw === undefined || raw === '' ? fallback : Number(raw);
    if (!Number.isSafeInteger(val) || val < opts.min || (opts.max !== undefined && val > opts.max)) {
        const range = opts.max !== undefined ? `${opts.min}..${opts.max}` : `>= ${opts.min}`;
        blockers.push({ kind: 'invalid_config', message: `${opts.label} must be an integer ${range} (got ${String(raw)})` });
        return null;
    }
    return val;
}

function checkMaxCap(acct: WorkerAccountView, skill: string, blockers: PreflightBlocker[]) {
    const cap = acct.maxLevels?.[skill];
    if (cap !== undefined) {
        const current = skillLevel(acct, skill);
        if (current >= cap) {
            blockers.push({ kind: 'max_level_cap', skill, maxLevel: cap, current });
        }
    }
}

function checkSkill(acct: WorkerAccountView, skill: string, required: number, blockers: PreflightBlocker[]) {
    const current = skillLevel(acct, skill);
    if (current < required) {
        blockers.push({ kind: 'skill_level', skill, required, current });
    }
}

function checkSupply(
    acct: WorkerAccountView,
    world: WorkerWorldView,
    itemId: number,
    required: number,
    itemName: string,
    blockers: PreflightBlocker[],
    missingItems: PreflightMissingItem[],
) {
    const { available, reserved, usable } = usableStock(acct, world, itemId);
    if (usable < required) {
        blockers.push({ kind: 'missing_supply', itemId, itemName, required, available, reserved });
        missingItems.push({ itemId, count: required - usable, itemName });
    }
}

function checkCoins(acct: WorkerAccountView, world: WorkerWorldView, required: number, blockers: PreflightBlocker[], ferryFare?: number) {
    const coins = accountOwnedItemCount(acct, 995, { requireTrustedBank: false });
    const reserve = accountReserveFor(acct, world, 995);
    const escrow = accountEscrowCoins(acct, world);
    if (availableCoinsAfterReserves(coins, reserve, escrow, 0) < required) {
        blockers.push({ kind: 'missing_coins', required, available: coins, reserved: reserve, escrow, ...(ferryFare !== undefined ? { ferryFare } : {}) });
    }
}

const FOOD_RAW_ID: Record<string, number> = {
    shrimps: 317,
    trout: 335,
    salmon: 331,
    lobster: 377,
    swordfish: 371,
    shark: 383,
};

export function artisanPreflight(acct: WorkerAccountView, rawCfg: ArtisanConfig, world: WorkerWorldView): PreflightResult {
    const cfg = normalizeArtisanConfig(rawCfg);
    if (!VALID_ARTISAN_SKILLS.includes(cfg.skill)) {
        return preflightFail([{ kind: 'invalid_config', message: `unknown artisan skill: ${String(rawCfg.skill)}` }]);
    }
    const validMethods = ARTISAN_METHOD_MAP[cfg.skill] as readonly string[];
    if (!validMethods.includes(cfg.method)) {
        return preflightFail([{ kind: 'invalid_config', message: `unknown ${cfg.skill} method: ${String(rawCfg.method)}` }]);
    }
    if (acct.protectedClock) {
        return preflightFail([{ kind: 'protected_clock', message: 'account clock is protected' }]);
    }

    const blockers: PreflightBlocker[] = [];
    const missingItems: PreflightMissingItem[] = [];
    let travelCoins = 0;
    let travelTicks = 20;

    try {
        switch (cfg.skill) {
            case 'cooking': {
                checkMaxCap(acct, 'Cooking', blockers);
                if (cfg.method === 'food') {
                    const foodType = (resolveArtisanSetting(cfg, 'FOOD_TYPE', cfg.args[1]) ?? 'lobster').toLowerCase();
                    const rule = loadCookingMod().foodRule(foodType);
                    checkSkill(acct, 'Cooking', rule.level, blockers);
                    const rawId = FOOD_RAW_ID[foodType];
                    if (rawId !== undefined) checkSupply(acct, world, rawId, 1, `Raw ${foodType}`, blockers, missingItems);
                } else if (cfg.method === 'stock') {
                    const reserve = parseIntSetting(resolveArtisanSetting(cfg, 'RAW_RESERVE'), 50, { min: 50, label: 'RAW_RESERVE' }, blockers);
                    if (reserve !== null) {
                        const stockIds = [335, 331, 377, 371, 383];
                        const hasAny = stockIds.some(id => usableStock(acct, world, id).usable > reserve);
                        if (!hasAny) {
                            checkSupply(acct, world, 335, reserve + 1, 'Raw trout/salmon stock', blockers, missingItems);
                        }
                    }
                } else if (cfg.method === 'wine' || cfg.method === 'mixed-wine') {
                    checkSkill(acct, 'Cooking', 35, blockers);
                    const reserve = parseIntSetting(resolveArtisanSetting(cfg, 'RAW_RESERVE'), 0, { min: 0, label: 'RAW_RESERVE' }, blockers);
                    const max = parseIntSetting(resolveArtisanSetting(cfg, 'MAX_MAKE', cfg.args[0]), 1, { min: 1, label: 'MAX_MAKE' }, blockers);
                    if (reserve !== null && max !== null) {
                        checkSupply(acct, world, 1987, max + reserve, 'Grapes', blockers, missingItems);
                        checkSupply(acct, world, 1937, max + reserve, 'Jug of water', blockers, missingItems);
                    }
                } else if (cfg.method === 'batch') {
                    const recipeName = resolveArtisanSetting(cfg, 'RECIPE', cfg.args[0]) ?? 'cooking_generic_trout';
                    const recipe = cookingRecipeByName(recipeName);
                    if (!recipe) {
                        blockers.push({ kind: 'invalid_config', message: `unknown cooking recipe: ${recipeName}` });
                    } else {
                        checkSkill(acct, 'Cooking', recipe.level, blockers);
                        checkSupply(acct, world, recipe.raw, 1, recipe.name, blockers, missingItems);
                    }
                } else if (cfg.method === 'ge-cook') {
                    const recipeName = resolveArtisanSetting(cfg, 'RECIPE', cfg.args[0]) ?? 'cooking_generic_trout';
                    const recipe = cookingRecipeByName(recipeName);
                    const { LOGS } = loadFiremakingMod();
                    const log = (resolveArtisanSetting(cfg, 'LOG', cfg.args[1]) ?? 'normal') as keyof typeof LOGS;
                    if (!recipe || !Object.hasOwn(LOGS, log)) {
                        blockers.push({ kind: 'invalid_config', message: `invalid ge-cook recipe/log: ${recipeName}/${log}` });
                    } else {
                        checkSkill(acct, 'Cooking', recipe.level, blockers);
                        checkSkill(acct, 'Firemaking', LOGS[log].level, blockers);
                        checkSupply(acct, world, 590, 1, 'Tinderbox', blockers, missingItems);
                        checkSupply(acct, world, LOGS[log].id, 1, `${log} logs`, blockers, missingItems);
                        checkSupply(acct, world, recipe.raw, 1, recipe.name, blockers, missingItems);
                    }
                }
                break;
            }
            case 'firemaking': {
                checkMaxCap(acct, 'Firemaking', blockers);
                const { LOGS } = loadFiremakingMod();
                const log = (resolveArtisanSetting(cfg, 'LOG', cfg.args[1]) ?? 'normal').toLowerCase() as keyof typeof LOGS;
                if (!Object.hasOwn(LOGS, log)) {
                    blockers.push({ kind: 'invalid_config', message: `unknown firemaking log: ${log}` });
                } else {
                    const info = LOGS[log];
                    const reserve = parseIntSetting(resolveArtisanSetting(cfg, 'LOG_RESERVE'), 0, { min: 0, label: 'LOG_RESERVE' }, blockers);
                    const toolBudget = parseIntSetting(resolveArtisanSetting(cfg, 'TOOL_BUDGET'), 0, { min: 0, label: 'TOOL_BUDGET' }, blockers);
                    checkSkill(acct, 'Firemaking', info.level, blockers);
                    if (reserve !== null) {
                        checkSupply(acct, world, info.id, reserve + 1, `${log} logs`, blockers, missingItems);
                    }
                    const tinder = usableStock(acct, world, 590);
                    if (tinder.usable < 1 && (cfg.method !== 'order' || (toolBudget ?? 0) < 1)) {
                        checkSupply(acct, world, 590, 1, 'Tinderbox', blockers, missingItems);
                    }
                }
                break;
            }
            case 'fletching': {
                checkMaxCap(acct, 'Fletching', blockers);
                if (cfg.method === 'worker') {
                    checkSkill(acct, 'Hitpoints', 10, blockers);
                } else if (cfg.method === 'shafts') {
                    checkSupply(acct, world, 946, 1, 'Knife', blockers, missingItems);
                    const res = parseIntSetting(resolveArtisanSetting(cfg, 'LOG_RESERVE'), 0, { min: 0, label: 'LOG_RESERVE' }, blockers);
                    if (res !== null) checkSupply(acct, world, 1511, res + 1, 'Logs', blockers, missingItems);
                } else {
                    const mode = (resolveArtisanSetting(cfg, 'MODE', cfg.args[1]) ?? 'arrows').toLowerCase();
                    if (mode === 'shafts') {
                        checkSupply(acct, world, 946, 1, 'Knife', blockers, missingItems);
                        const res = parseIntSetting(resolveArtisanSetting(cfg, 'LOG_RESERVE'), 0, { min: 0, label: 'LOG_RESERVE' }, blockers);
                        if (res !== null) checkSupply(acct, world, 1511, res + 1, 'Logs', blockers, missingItems);
                    } else if (mode === 'headless') {
                        const sr = parseIntSetting(resolveArtisanSetting(cfg, 'SHAFT_RESERVE'), 200, { min: 0, label: 'SHAFT_RESERVE' }, blockers);
                        const fr = parseIntSetting(resolveArtisanSetting(cfg, 'FEATHER_RESERVE'), 100, { min: 0, label: 'FEATHER_RESERVE' }, blockers);
                        if (sr !== null) checkSupply(acct, world, 52, sr + 15, 'Arrow shafts', blockers, missingItems);
                        if (fr !== null) checkSupply(acct, world, 314, fr + 15, 'Feathers', blockers, missingItems);
                    } else if (mode === 'oak-bows') {
                        checkSkill(acct, 'Fletching', 25, blockers);
                        checkSupply(acct, world, 946, 1, 'Knife', blockers, missingItems);
                        const lr = parseIntSetting(resolveArtisanSetting(cfg, 'LOG_RESERVE'), 0, { min: 0, label: 'LOG_RESERVE' }, blockers);
                        const strR = parseIntSetting(resolveArtisanSetting(cfg, 'STRING_RESERVE'), 0, { min: 0, label: 'STRING_RESERVE' }, blockers);
                        if (lr !== null) checkSupply(acct, world, 1521, lr + 1, 'Oak logs', blockers, missingItems);
                        if (strR !== null) checkSupply(acct, world, 1777, strR + 1, 'Bow string', blockers, missingItems);
                    } else if (mode === 'iron' || mode === 'steel' || mode === 'native-arrows') {
                        const metal = (mode === 'native-arrows' ? (resolveArtisanSetting(cfg, 'TIP_TYPE', cfg.args[2]) ?? 'steel') : mode) as ArrowMetal;
                        const prof = loadFletchingMod().nativeArrowProfile(metal);
                        checkSkill(acct, 'Fletching', prof.level, blockers);
                        const hr = parseIntSetting(resolveArtisanSetting(cfg, 'HEADLESS_RESERVE'), 200, { min: 0, label: 'HEADLESS_RESERVE' }, blockers);
                        const tr = parseIntSetting(resolveArtisanSetting(cfg, 'TIP_RESERVE'), mode === 'iron' ? 0 : 5, { min: 0, label: 'TIP_RESERVE' }, blockers);
                        if (hr !== null) checkSupply(acct, world, 53, hr + 15, 'Headless arrow', blockers, missingItems);
                        if (tr !== null) checkSupply(acct, world, prof.tip, tr + 15, prof.tipName, blockers, missingItems);
                    }
                }
                break;
            }
            case 'smithing': {
                checkMaxCap(acct, 'Smithing', blockers);
                if (cfg.method === 'cannonballs' || (cfg.method === 'smelt' && (resolveArtisanSetting(cfg, 'BAR_TYPE', cfg.args[1]) ?? '').toLowerCase() === 'cannonballs')) {
                    const bars = parseIntSetting(cfg.args[0] ?? resolveArtisanSetting(cfg, 'MAX_MAKE'), 1, { min: 1, label: 'MAX_MAKE' }, blockers);
                    const reserve = parseIntSetting(resolveArtisanSetting(cfg, 'CANNON_RESERVE', resolveArtisanSetting(cfg, 'ORE_RESERVE')), 0, { min: 0, label: 'CANNON_RESERVE' }, blockers);
                    checkSkill(acct, 'Smithing', 35, blockers);
                    checkSupply(acct, world, 4, 1, 'Ammo mould', blockers, missingItems);
                    if (bars !== null && reserve !== null) {
                        checkSupply(acct, world, 2353, bars + reserve, 'Steel bar', blockers, missingItems);
                    }
                } else if (cfg.method === 'anvil' || (cfg.method === 'smelt' && resolveArtisanSetting(cfg, 'ORDER_ACTION') === 'smith')) {
                    const pidRaw = resolveArtisanSetting(cfg, 'PRODUCT_ID', cfg.args[1]);
                    const pid = pidRaw !== undefined && pidRaw !== '' ? Number(pidRaw) : NaN;
                    const max = parseIntSetting(resolveArtisanSetting(cfg, 'MAX_MAKE'), 1, { min: 1, label: 'MAX_MAKE' }, blockers);
                    const res = parseIntSetting(resolveArtisanSetting(cfg, 'BAR_RESERVE'), 0, { min: 0, label: 'BAR_RESERVE' }, blockers);
                    if (!Number.isSafeInteger(pid) || pid < 0) {
                        blockers.push({ kind: 'invalid_config', message: 'smithing anvil requires integer PRODUCT_ID' });
                    } else {
                        const { HAMMER, smithRecipe } = loadSmithingMod();
                        const r = smithRecipe(pid);
                        checkSkill(acct, 'Smithing', r.level, blockers);
                        if (r.quest && !questComplete(acct, r.quest)) {
                            blockers.push({ kind: 'quest_incomplete', quest: r.quest, requiredState: 'complete', currentState: questStatusOf(acct, r.quest) });
                        }
                        checkSupply(acct, world, HAMMER, 1, 'Hammer', blockers, missingItems);
                        if (max !== null && res !== null) {
                            checkSupply(acct, world, r.bar, max * r.bars + res, `Bar #${r.bar}`, blockers, missingItems);
                        }
                        travelTicks = 60;
                    }
                } else {
                    const bar = (resolveArtisanSetting(cfg, 'BAR_TYPE', cfg.args[1]) ?? 'iron').toLowerCase();
                    const r = loadSmithingMod().smeltRecipe(bar);
                    const reserve = parseIntSetting(resolveArtisanSetting(cfg, 'ORE_RESERVE'), 1, { min: 0, label: 'ORE_RESERVE' }, blockers);
                    checkSkill(acct, 'Smithing', r.level, blockers);
                    if (reserve !== null) {
                        for (const ing of r.ingredients) {
                            checkSupply(acct, world, ing.id, ing.units + reserve, `Ore #${ing.id}`, blockers, missingItems);
                        }
                    }
                    if (acct.pos && Math.max(Math.abs(acct.pos.x - 3253), Math.abs(acct.pos.z - 3420)) <= 5) {
                        travelCoins = 10;
                        travelTicks = 120;
                        checkCoins(acct, world, 10, blockers, 10);
                    }
                }
                break;
            }
            case 'crafting': {
                if (cfg.method === 'bowstrings') {
                    checkMaxCap(acct, 'Crafting', blockers);
                    checkSkill(acct, 'Crafting', 10, blockers);
                    const res = parseIntSetting(resolveArtisanSetting(cfg, 'RAW_RESERVE'), 50, { min: 0, label: 'RAW_RESERVE' }, blockers);
                    if (res !== null) checkSupply(acct, world, 1779, res + 1, 'Flax', blockers, missingItems);
                    travelTicks = 30;
                } else if (cfg.method === 'jewellery') {
                    checkMaxCap(acct, 'Crafting', blockers);
                    const rName = cfg.args[0] ?? resolveArtisanSetting(cfg, 'RECIPE', 'sapphire_ring')!;
                    const r = jewelleryRecipeByName(rName);
                    if (!r) {
                        blockers.push({ kind: 'invalid_config', message: `unknown jewellery recipe: ${rName}` });
                    } else {
                        checkSkill(acct, 'Crafting', r.level, blockers);
                        for (const t of r.tools) checkSupply(acct, world, t, 1, `Mould #${t}`, blockers, missingItems);
                        for (const i of r.inputs) checkSupply(acct, world, i.id, i.units, `Input #${i.id}`, blockers, missingItems);
                    }
                } else if (cfg.method === 'jewellery-trip') {
                    checkMaxCap(acct, 'Crafting', blockers);
                    const rName = resolveArtisanSetting(cfg, 'RECIPE', '');
                    if (rName) {
                        const target = Number(resolveArtisanSetting(cfg, 'TARGET', '13'));
                        const r = loadCraftingMod().validateJewelleryOrder({
                            recipe: rName,
                            target,
                            batch: Number(resolveArtisanSetting(cfg, 'BATCH', '13')),
                            cap: Number(resolveArtisanSetting(cfg, 'CAP', '1500')),
                            returnTicks: Number(resolveArtisanSetting(cfg, 'RETURN_TICKS', '100')),
                            reserve: Number(resolveArtisanSetting(cfg, 'RESERVE', '0')),
                            members: resolveArtisanSetting(cfg, 'MEMBERS') === '1',
                            stringAmulet: resolveArtisanSetting(cfg, 'STRING_AMULET') === '1',
                            bank: { x: 3269, z: 3167, level: 0 },
                            furnace: { x: 3275, z: 3186, level: 0 },
                        } satisfies JewelleryOrder);
                        checkSkill(acct, 'Crafting', r.level, blockers);
                    }
                } else if (cfg.method === 'legacy-jewelry') {
                    checkMaxCap(acct, 'Crafting', blockers);
                    const tier = (cfg.args[2] ?? resolveArtisanSetting(cfg, 'TIER', 'sapphire'))!.toLowerCase();
                    const level = tier === 'sapphire' ? 20 : tier === 'emerald' ? 27 : tier === 'ruby' ? 34 : tier === 'diamond' ? 43 : tier === 'dragonstone' ? 55 : 0;
                    if (level) checkSkill(acct, 'Crafting', level, blockers);
                } else if (cfg.method === 'glass') {
                    checkMaxCap(acct, 'Crafting', blockers);
                    if (resolveArtisanSetting(cfg, 'SUPPLY_MODE') !== '1') {
                        checkSupply(acct, world, 1783, 1, 'Bucket of sand', blockers, missingItems);
                        checkSupply(acct, world, 1781, 1, 'Soda ash', blockers, missingItems);
                    }
                } else if (cfg.method === 'tanning') {
                    const { tanningRecipes } = loadCraftingMod();
                    const kind = (cfg.args[0] ?? 'soft') as keyof typeof tanningRecipes;
                    const qty = Number(cfg.args[1] ?? 1);
                    if (!Object.hasOwn(tanningRecipes, kind) || !Number.isSafeInteger(qty) || qty < 1) {
                        blockers.push({ kind: 'invalid_config', message: `invalid tanning kind/quantity: ${String(kind)}/${qty}` });
                    } else {
                        const r = tanningRecipes[kind];
                        checkSupply(acct, world, r.input, qty, `Hide #${r.input}`, blockers, missingItems);
                        checkCoins(acct, world, qty * r.cost, blockers);
                    }
                } else if (cfg.method === 'black-dhide-sets') {
                    checkMaxCap(acct, 'Crafting', blockers);
                    const piece = resolveArtisanSetting(cfg, 'PIECE');
                    const level = piece === 'vambraces' ? 79 : piece === 'chaps' ? 82 : 84;
                    checkSkill(acct, 'Crafting', level, blockers);
                } else if (cfg.method === 'soften-clay') {
                    const res = parseIntSetting(resolveArtisanSetting(cfg, 'RAW_RESERVE'), 0, { min: 0, label: 'RAW_RESERVE' }, blockers);
                    if (res !== null) checkSupply(acct, world, 434, res + 1, 'Clay', blockers, missingItems);
                    if (usableStock(acct, world, 1925).usable < 1 && usableStock(acct, world, 1929).usable < 1) {
                        checkSupply(acct, world, 1925, 1, 'Bucket', blockers, missingItems);
                    }
                } else if (cfg.method === 'inventory') {
                    const rName = cfg.args[0];
                    const r = rName !== undefined ? inventoryRecipeByName(rName) : undefined;
                    if (!r) {
                        blockers.push({ kind: 'invalid_config', message: `unknown inventory production recipe: ${String(rName)}` });
                    } else {
                        checkSkill(acct, r.skill, r.level, blockers);
                        for (const t of r.tools) checkSupply(acct, world, t, 1, `Tool #${t}`, blockers, missingItems);
                        for (const i of r.inputs) checkSupply(acct, world, i.id, i.units, `Input #${i.id}`, blockers, missingItems);
                    }
                } else if (cfg.method === 'progressive') {
                    const mode = resolveArtisanSetting(cfg, 'MODE', 'fletch') as ProgressiveProduction['mode'];
                    loadCraftingMod().validateProgressiveProduction({
                        mode,
                        targetLevel: Number(resolveArtisanSetting(cfg, 'TARGET_LEVEL', '50')),
                        maximum: Number(resolveArtisanSetting(cfg, 'MAX_MAKE', '10')),
                        batch: Number(resolveArtisanSetting(cfg, 'BATCH', '10')),
                        reserve: Number(resolveArtisanSetting(cfg, 'RAW_RESERVE', '0')),
                        cap: Number(resolveArtisanSetting(cfg, 'CAP', '1500')),
                        members: resolveArtisanSetting(cfg, 'MEMBERS') === '1',
                        bank: { x: 3185, z: 3436, level: 0 },
                        ...(mode === 'cooking-prepared' || mode === 'burn-bake' ? { site: { x: 3212, z: 3414, level: 0 } } : {}),
                    });
                }
                break;
            }
            case 'herblore': {
                if (cfg.method === 'potions') {
                    checkMaxCap(acct, 'Herblore', blockers);
                    const { RECIPES } = loadHerbloreMod();
                    const key = (cfg.args[1] ?? resolveArtisanSetting(cfg, 'RECIPE', 'auto'))!.toLowerCase();
                    if (key !== 'auto' && key !== 'unf' && !Object.hasOwn(RECIPES, key)) {
                        blockers.push({ kind: 'invalid_config', message: `unknown herblore recipe: ${key}` });
                    } else if (key !== 'auto' && key !== 'unf') {
                        const rec = RECIPES[key]!;
                        checkSkill(acct, 'Herblore', rec.level, blockers);
                    }
                } else {
                    const hp = skillLevel(acct, 'Hitpoints');
                    const att = skillLevel(acct, 'Attack');
                    const str = skillLevel(acct, 'Strength');
                    const def = skillLevel(acct, 'Defence');
                    const needsBear = usableStock(acct, world, 2136).available < 1;
                    if (needsBear && (hp < 60 || att < 40 || str < 40 || def < 40)) {
                        blockers.push({ kind: 'combat_survivability', reason: 'defence', required: 40, current: Math.min(hp, att, str, def), message: 'bear meat hunt requires HP 60 / Att 40 / Str 40 / Def 40' });
                    }
                }
                break;
            }
            case 'prayer': {
                checkMaxCap(acct, 'Prayer', blockers);
                const boneRaw = resolveArtisanSetting(cfg, 'BONE_ID') ?? resolveArtisanSetting(cfg, 'BONE');
                const bone = parseIntSetting(boneRaw, 526, { min: 0, label: 'BONE_ID' }, blockers);
                const reserve = parseIntSetting(resolveArtisanSetting(cfg, 'BONE_RESERVE'), 6, { min: 6, label: 'BONE_RESERVE' }, blockers);
                parseIntSetting(cfg.args[0] ?? resolveArtisanSetting(cfg, 'TARGET_LEVEL'), 43, { min: 43, max: 99, label: 'TARGET_LEVEL' }, blockers);
                if (bone !== null) {
                    const { BONE_XP } = loadPrayerMod();
                    if (BONE_XP[bone] === undefined) {
                        blockers.push({ kind: 'invalid_config', message: `unsupported prayer bone ID: ${bone}` });
                    } else if (reserve !== null) {
                        checkSupply(acct, world, bone, reserve + 1, `Bone #${bone}`, blockers, missingItems);
                    }
                }
                break;
            }
            case 'magic': {
                checkMaxCap(acct, 'Magic', blockers);
                if (cfg.method === 'items') {
                    const mode = cfg.args[0] ?? resolveArtisanSetting(cfg, 'MODE', '');
                    const targetName = cfg.args[1] ?? resolveArtisanSetting(cfg, 'ALCH_ITEM');
                    if (!mode) {
                        blockers.push({ kind: 'invalid_config', message: 'magic:items requires mode argument' });
                    } else {
                        const r = loadMagicMod().itemMagicRecipe(mode, targetName === '-' ? undefined : targetName);
                        checkSkill(acct, 'Magic', r.level, blockers);
                        if (r.smithing > 0) checkSkill(acct, 'Smithing', r.smithing, blockers);
                        checkSupply(acct, world, r.target, 1, `Target #${r.target}`, blockers, missingItems);
                    }
                } else if (cfg.method === 'teleport') {
                    const dest = cfg.args[0] ?? 'varrock';
                    const t = loadMagicMod().nativeTeleport(dest);
                    checkSkill(acct, 'Magic', t.level, blockers);
                    for (const idStr in t.runes) {
                        const n = t.runes[Number(idStr)]!;
                        checkSupply(acct, world, Number(idStr), n, `Rune #${idStr}`, blockers, missingItems);
                    }
                } else if (cfg.method === 'orbs' || cfg.method === 'orbs-at-site') {
                    const { orbRecipes } = loadMagicMod();
                    const kind = (cfg.args[0] ?? 'air') as OrbKind;
                    if (!Object.hasOwn(orbRecipes, kind)) {
                        blockers.push({ kind: 'invalid_config', message: `unknown orb kind: ${String(kind)}` });
                    } else {
                        const r = orbRecipes[kind];
                        checkSkill(acct, 'Magic', r.level, blockers);
                        if (resolveArtisanSetting(cfg, 'ORB_TRIP') === '1') {
                            checkSkill(acct, 'Hitpoints', 70, blockers);
                            checkSkill(acct, 'Prayer', 43, blockers);
                        }
                        checkSupply(acct, world, 567, 1, 'Unpowered orb', blockers, missingItems);
                        checkSupply(acct, world, 564, 3, 'Cosmic rune', blockers, missingItems);
                    }
                } else if (cfg.method === 'bones') {
                    checkSkill(acct, 'Magic', 15, blockers);
                    checkSupply(acct, world, 526, 1, 'Bones', blockers, missingItems);
                    checkSupply(acct, world, 561, 1, 'Nature rune', blockers, missingItems);
                } else if (cfg.method === 'alch-train') {
                    const target = parseIntSetting(cfg.args[0] ?? resolveArtisanSetting(cfg, 'TARGET_LEVEL'), 55, { min: 1, max: 99, label: 'TARGET_LEVEL' }, blockers);
                    const itemName = resolveArtisanSetting(cfg, 'ALCH_ITEM', 'feather')!;
                    const { itemMagicRecipe, alchCasts } = loadMagicMod();
                    const recipe = itemMagicRecipe('high-alch', itemName);
                    if (target !== null) {
                        const casts = alchCasts(skillXp(acct, 'Magic'), target);
                        if (casts.low + casts.high > 0) {
                            checkSupply(acct, world, 561, 1, 'Nature rune', blockers, missingItems);
                            checkSupply(acct, world, recipe.target, 1, itemName, blockers, missingItems);
                        }
                    }
                } else if (cfg.method === 'earth-production') {
                    const mode = cfg.args[0] ?? 'craft';
                    if (mode !== 'talismans' && mode !== 'craft') {
                        blockers.push({ kind: 'invalid_config', message: `invalid earth-production mode: ${mode}` });
                    } else if (mode === 'talismans') {
                        checkSkill(acct, 'Attack', 30, blockers);
                        checkSkill(acct, 'Defence', 10, blockers);
                        checkSkill(acct, 'Hitpoints', 13, blockers);
                    } else {
                        checkSupply(acct, world, 1436, 1, 'Rune essence', blockers, missingItems);
                    }
                }
                break;
            }
            case 'foraging': {
                if (cfg.method === 'miscellania-coffer') {
                    if (!questComplete(acct, /^Throne of Miscellania$/i)) {
                        blockers.push({ kind: 'quest_incomplete', quest: 'Throne of Miscellania', requiredState: 'complete', currentState: questStatusOf(acct, /^Throne of Miscellania$/i) });
                    }
                    const amount = Number(cfg.args[0] ?? 1);
                    if (Number.isSafeInteger(amount) && amount > 0) checkCoins(acct, world, amount, blockers);
                } else if (cfg.method === 'care') {
                    const mode = cfg.args[0] ?? 'feed';
                    if (mode === 'miscellania') checkSkill(acct, 'Herblore', 35, blockers);
                    if (mode === 'pouch' && !questComplete(acct, 'Nature Spirit')) {
                        blockers.push({ kind: 'quest_incomplete', quest: 'Nature Spirit', requiredState: 'complete', currentState: questStatusOf(acct, 'Nature Spirit') });
                    }
                }
                break;
            }
            case 'bank-job': {
                if (!cfg.args.length) {
                    blockers.push({ kind: 'invalid_config', message: 'bank-job requires at least one job path or --job= argument' });
                }
                break;
            }
        }
    } catch (error) {
        blockers.push({ kind: 'invalid_config', message: error instanceof Error ? error.message : String(error) });
    }

    if (blockers.length > 0) {
        return preflightFail(blockers, {
            ...(travelCoins > 0 ? { travelCoins } : {}),
            ...(travelTicks > 0 ? { travelTicks } : {}),
            ...(missingItems.length > 0 ? { missingItems } : {}),
        });
    }
    return preflightOk({
        ...(travelCoins > 0 ? { travelCoins } : {}),
        ...(travelTicks > 0 ? { travelTicks } : {}),
    });
}

export function artisanEstimate(acct: WorkerAccountView, rawCfg: ArtisanConfig, _world: WorkerWorldView): RateEstimate {
    const cfg = normalizeArtisanConfig(rawCfg);
    const rawRate = Number(resolveArtisanSetting(cfg, 'XP_RATE') ?? 25);
    const xpRate = Number.isFinite(rawRate) && rawRate > 0 ? rawRate : 25;
    const scaleXp = (baseXpPerTick: number) => Number((baseXpPerTick * xpRate).toFixed(2));
    switch (cfg.skill) {
        case 'cooking': {
            if (cfg.method === 'wine' || cfg.method === 'mixed-wine') {
                const xp = scaleXp(66.0);
                return {
                    xpPerTick: xp,
                    skillXpPerTick: { Cooking: xp },
                    unitsPerTick: 0.33,
                    gpPerTick: -4,
                    setupTicks: 22,
                    minBatchUnits: 14,
                    riskPerHour: 0,
                    confidence: 'practice',
                    inputsPerUnit: { 1987: 1, 1937: 1 },
                    outputsPerUnit: { 1993: 1 },
                };
            }
            const catalog = loadCatalogMod().artisanDbtablesCatalog();
            const food = (resolveArtisanSetting(cfg, 'FOOD_TYPE', cfg.args[1]) ?? 'trout').toLowerCase();
            const entry = catalog.cooking.find(c => c.uncooked.includes(food));
            const xpPer = entry ? entry.xp / 10 : 70;
            const xpPerTick = scaleXp(xpPer * 0.25);
            return {
                xpPerTick,
                skillXpPerTick: { Cooking: xpPerTick },
                unitsPerTick: 0.25,
                gpPerTick: 5,
                setupTicks: 25,
                minBatchUnits: 28,
                riskPerHour: 0,
                confidence: 'practice',
                inputsPerUnit: { [FOOD_RAW_ID[food] ?? 335]: 1 },
            };
        }
        case 'firemaking': {
            const { LOGS } = loadFiremakingMod();
            const log = (resolveArtisanSetting(cfg, 'LOG', cfg.args[1]) ?? 'normal').toLowerCase() as keyof typeof LOGS;
            const baseXp = log === 'magic' ? 75.0 : log === 'yew' ? 50.0 : log === 'maple' ? 33.7 : log === 'willow' ? 22.5 : log === 'oak' ? 15.0 : 10.0;
            const xpPerTick = scaleXp(baseXp);
            return {
                xpPerTick,
                skillXpPerTick: { Firemaking: xpPerTick },
                unitsPerTick: 0.25,
                gpPerTick: -5,
                setupTicks: 20,
                minBatchUnits: 27,
                riskPerHour: 0,
                confidence: 'practice',
                inputsPerUnit: { [LOGS[log]?.id ?? 1511]: 1 },
            };
        }
        case 'fletching': {
            if (cfg.method === 'shafts' || resolveArtisanSetting(cfg, 'MODE', cfg.args[1]) === 'shafts') {
                const xp = scaleXp(2.5);
                return {
                    xpPerTick: xp,
                    skillXpPerTick: { Fletching: xp },
                    unitsPerTick: 7.5,
                    gpPerTick: 10,
                    setupTicks: 15,
                    minBatchUnits: 15,
                    riskPerHour: 0,
                    confidence: 'practice',
                    inputsPerUnit: { 1511: 1 },
                    outputsPerUnit: { 52: 15 },
                };
            }
            const xp = scaleXp(25.0);
            return {
                xpPerTick: xp,
                skillXpPerTick: { Fletching: xp },
                unitsPerTick: 3.0,
                gpPerTick: 2,
                setupTicks: 15,
                minBatchUnits: 15,
                riskPerHour: 0,
                confidence: 'practice',
                inputsPerUnit: { 53: 1 },
            };
        }
        case 'smithing': {
            if (cfg.method === 'anvil') {
                const xp = scaleXp(12.5);
                return {
                    xpPerTick: xp,
                    skillXpPerTick: { Smithing: xp },
                    unitsPerTick: 0.25,
                    gpPerTick: 5,
                    setupTicks: 40,
                    minBatchUnits: 1,
                    riskPerHour: 0,
                    confidence: 'practice',
                };
            }
            if (cfg.method === 'cannonballs') {
                const xp = scaleXp(3.2);
                return {
                    xpPerTick: xp,
                    skillXpPerTick: { Smithing: xp },
                    unitsPerTick: 0.5,
                    gpPerTick: 40,
                    setupTicks: 30,
                    minBatchUnits: 4,
                    riskPerHour: 0,
                    confidence: 'practice',
                    inputsPerUnit: { 2353: 1 },
                    outputsPerUnit: { 2: 4 },
                };
            }
            const xp = scaleXp(8.5);
            return {
                xpPerTick: xp,
                skillXpPerTick: { Smithing: xp },
                unitsPerTick: 0.16,
                gpPerTick: 10,
                setupTicks: 45,
                minBatchUnits: 14,
                riskPerHour: 0,
                confidence: 'practice',
            };
        }
        case 'crafting': {
            if (cfg.method === 'bowstrings') {
                const xp = scaleXp(4.5);
                return {
                    xpPerTick: xp,
                    skillXpPerTick: { Crafting: xp },
                    unitsPerTick: 0.3,
                    gpPerTick: 30,
                    setupTicks: 35,
                    minBatchUnits: 28,
                    riskPerHour: 0,
                    confidence: 'practice',
                    inputsPerUnit: { 1779: 1 },
                    outputsPerUnit: { 1777: 1 },
                };
            }
            const xp = scaleXp(20.0);
            return {
                xpPerTick: xp,
                skillXpPerTick: { Crafting: xp },
                unitsPerTick: 0.3,
                gpPerTick: 4,
                setupTicks: 20,
                minBatchUnits: 13,
                riskPerHour: 0,
                confidence: 'practice',
            };
        }
        case 'herblore': {
            if (cfg.method === 'meats') {
                const xp = scaleXp(1.5);
                return {
                    xpPerTick: xp,
                    skillXpPerTick: { Strength: xp },
                    unitsPerTick: 0.01,
                    gpPerTick: 0,
                    setupTicks: 100,
                    minBatchUnits: 1,
                    riskPerHour: 0.05,
                    confidence: 'practice',
                    outputsPerUnit: { 2132: 1, 2134: 1, 2136: 1, 2138: 1 },
                };
            }
            const xp = scaleXp(18.0);
            return {
                xpPerTick: xp,
                skillXpPerTick: { Herblore: xp },
                unitsPerTick: 0.25,
                gpPerTick: -10,
                setupTicks: 30,
                minBatchUnits: 9,
                riskPerHour: 0,
                confidence: 'practice',
                inputsPerUnit: { 227: 1 },
            };
        }
        case 'prayer': {
            const boneId = Number(resolveArtisanSetting(cfg, 'BONE_ID') ?? resolveArtisanSetting(cfg, 'BONE', '526')) || 526;
            const xp = scaleXp(2.2);
            return {
                xpPerTick: xp,
                skillXpPerTick: { Prayer: xp },
                unitsPerTick: 0.5,
                gpPerTick: -5,
                setupTicks: 15,
                minBatchUnits: 28,
                riskPerHour: 0,
                confidence: 'practice',
                inputsPerUnit: { [boneId]: 1 },
            };
        }
        case 'magic': {
            const lvl = skillLevel(acct, 'Magic');
            const high = lvl >= 55;
            if (cfg.method === 'alch-train' || cfg.method === 'items') {
                const xp = scaleXp(high ? 16.25 : 7.75);
                return {
                    xpPerTick: xp,
                    skillXpPerTick: { Magic: xp },
                    unitsPerTick: 0.25,
                    gpPerTick: -10,
                    setupTicks: 20,
                    minBatchUnits: 10,
                    riskPerHour: 0,
                    confidence: 'practice',
                };
            }
            if (cfg.method === 'orbs' || cfg.method === 'orbs-at-site') {
                const xp = scaleXp(15.0);
                return {
                    xpPerTick: xp,
                    skillXpPerTick: { Magic: xp },
                    unitsPerTick: 0.2,
                    gpPerTick: 25,
                    setupTicks: 90,
                    minBatchUnits: 26,
                    riskPerHour: 0.04,
                    confidence: 'practice',
                };
            }
            const xp = scaleXp(8.0);
            return {
                xpPerTick: xp,
                skillXpPerTick: { Magic: xp },
                unitsPerTick: 0.15,
                gpPerTick: 0,
                setupTicks: 25,
                minBatchUnits: 1,
                riskPerHour: 0,
                confidence: 'practice',
            };
        }
        case 'foraging':
            return {
                xpPerTick: 0,
                unitsPerTick: 0.2,
                gpPerTick: 0,
                setupTicks: 10,
                minBatchUnits: 1,
                riskPerHour: 0,
                confidence: 'model',
            };
        case 'bank-job':
            return {
                xpPerTick: scaleXp(15.0),
                unitsPerTick: 0.25,
                gpPerTick: 0,
                setupTicks: 30,
                minBatchUnits: 1,
                riskPerHour: 0,
                confidence: 'practice',
            };
    }
}

export function toArtisanWorkerOutcome(
    outcome: ArtisanSessionOutcome,
    account: string,
    cfg: NormalizedArtisanConfig,
    fallbackTicks: number,
    opts: { stopped?: boolean } = {},
): RunOutcome {
    const activityId = cfg.skill === 'bank-job' ? 'bank-artisan:bank-job' : `bank-artisan:${cfg.skill}:${cfg.method}`;
    const ticksElapsed = Math.max(0, Math.trunc(outcome.ticks || fallbackTicks));
    const base = {
        activityId,
        account,
        ticksElapsed,
        ...(outcome.produced !== undefined ? { unitsCompleted: Math.max(0, outcome.produced) } : {}),
        summary: outcome.summary,
    };

    if (outcome.ok) {
        return { kind: 'target_met', ...base };
    }
    const text = (outcome.failure ?? outcome.summary ?? '').toLowerCase();
    if (/\bdied\b|life-lost|life lost/.test(text)) {
        return { kind: 'death', ...base, faultSignature: `${activityId}:death` };
    }
    if (opts.stopped || /\b(stop|stopped|interrupt|interrupted|session ended|ended)\b/.test(text)) {
        return {
            kind: 'session_unsettled',
            ...base,
            reason: outcome.failure ?? outcome.summary ?? 'stopped',
            detail: outcome.failure ?? outcome.summary,
        };
    }
    if (/missing|short|exhausted|unavailable|reserve|supplies|insufficient|required|unowned/.test(text)) {
        return {
            kind: 'missing_supply',
            ...base,
            missing: [{ itemId: 0, required: 1, available: 0, itemName: (outcome.failure ?? outcome.summary).slice(0, 80) }],
        };
    }
    if (/route|walk|travel|unreachable|stair|door|corridor|approach|position/.test(text)) {
        return { kind: 'location_stranded', ...base, detail: outcome.failure ?? outcome.summary };
    }
    return {
        kind: 'worker_defect',
        ...base,
        faultSignature: `${activityId}:failed`,
    };
}

export { levelForXp, xpForLevel };
