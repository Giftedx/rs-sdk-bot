// Shared preflight(), estimate(), and RunOutcome adapters for the unified WorkerModule<ArtisanConfig>.
import {
    accountOwnedItemCount,
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
import { artisanDbtablesCatalog, alchCasts, levelForXp, xpForLevel } from './catalog';
import { cookingRecipes, foodRule } from './cooking';
import { inventoryRecipes, jewelleryRecipes, tanningRecipes, type JewelleryOrder, validateJewelleryOrder, validateProgressiveProduction, type ProgressiveProduction } from './crafting';
import { LOGS } from './firemaking';
import { nativeArrowProfile, type ArrowMetal } from './fletching';
import { RECIPES as HERBLORE_RECIPES } from './herblore';
import { itemMagicRecipe, nativeTeleport, orbRecipes, type OrbKind } from './magic';
import { HAMMER, smeltRecipe, smithRecipe } from './smithing';
import {
    ARTISAN_METHOD_MAP,
    normalizeArtisanConfig,
    resolveArtisanSetting,
    VALID_ARTISAN_SKILLS,
    type ArtisanConfig,
    type ArtisanSessionOutcome,
    type NormalizedArtisanConfig,
} from './types';

function skillLevel(acct: WorkerAccountView, name: string): number {
    for (const [k, v] of Object.entries(acct.skills)) {
        if (k.toLowerCase() === name.toLowerCase()) return v.level;
    }
    return name.toLowerCase() === 'hitpoints' ? 10 : 1;
}

function skillXp(acct: WorkerAccountView, name: string): number {
    for (const [k, v] of Object.entries(acct.skills)) {
        if (k.toLowerCase() === name.toLowerCase()) return v.xp;
    }
    return 0;
}

function questComplete(acct: WorkerAccountView, needle: string | RegExp): boolean {
    for (const [k, st] of Object.entries(acct.quests)) {
        const matched = typeof needle === 'string' ? k.toLowerCase() === needle.toLowerCase() : needle.test(k);
        if (matched && st === 'complete') return true;
    }
    return false;
}

function questStatusOf(acct: WorkerAccountView, needle: string | RegExp) {
    for (const [k, st] of Object.entries(acct.quests)) {
        const matched = typeof needle === 'string' ? k.toLowerCase() === needle.toLowerCase() : needle.test(k);
        if (matched) return st;
    }
    return 'not_started' as const;
}

function reservedOf(acct: WorkerAccountView, world: WorkerWorldView, itemId: number): number {
    return world.reserves?.[acct.name.toLowerCase()]?.[itemId] ?? world.reserves?.[acct.name]?.[itemId] ?? acct.reserves?.[itemId] ?? 0;
}

function usableStock(acct: WorkerAccountView, world: WorkerWorldView, itemId: number): { available: number; reserved: number; usable: number } {
    const available = accountOwnedItemCount(acct, itemId, { requireTrustedBank: false });
    const reserved = reservedOf(acct, world, itemId);
    return { available, reserved, usable: reserveAdjustedStock(available, reserved) };
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
    const reserve = reservedOf(acct, world, 995);
    const escrow = world.geEscrowCoins?.[acct.name.toLowerCase()] ?? world.geEscrowCoins?.[acct.name] ?? 0;
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
                    const rule = foodRule(foodType);
                    checkSkill(acct, 'Cooking', rule.level, blockers);
                    const rawId = FOOD_RAW_ID[foodType];
                    if (rawId !== undefined) checkSupply(acct, world, rawId, 1, `Raw ${foodType}`, blockers, missingItems);
                } else if (cfg.method === 'stock') {
                    const reserve = Number(resolveArtisanSetting(cfg, 'RAW_RESERVE', '50'));
                    if (!Number.isSafeInteger(reserve) || reserve < 50) {
                        blockers.push({ kind: 'invalid_config', message: 'cooking:stock requires RAW_RESERVE >= 50' });
                    }
                    const stockIds = [335, 331, 377, 371, 383];
                    const hasAny = stockIds.some(id => usableStock(acct, world, id).usable > reserve);
                    if (!hasAny) {
                        checkSupply(acct, world, 335, reserve + 1, 'Raw trout/salmon stock', blockers, missingItems);
                    }
                } else if (cfg.method === 'wine' || cfg.method === 'mixed-wine') {
                    checkSkill(acct, 'Cooking', 35, blockers);
                    const reserve = Number(resolveArtisanSetting(cfg, 'RAW_RESERVE', '0'));
                    const max = Number(resolveArtisanSetting(cfg, 'MAX_MAKE', cfg.args[0] ?? '1'));
                    checkSupply(acct, world, 1987, max + reserve, 'Grapes', blockers, missingItems);
                    checkSupply(acct, world, 1937, max + reserve, 'Jug of water', blockers, missingItems);
                } else if (cfg.method === 'batch') {
                    const recipeName = resolveArtisanSetting(cfg, 'RECIPE', cfg.args[0]) ?? 'cooking_generic_trout';
                    const recipe = cookingRecipes().recipes.find(r => r.name === recipeName);
                    if (!recipe) {
                        blockers.push({ kind: 'invalid_config', message: `unknown cooking recipe: ${recipeName}` });
                    } else {
                        checkSkill(acct, 'Cooking', recipe.level, blockers);
                        checkSupply(acct, world, recipe.raw, 1, recipe.name, blockers, missingItems);
                    }
                } else if (cfg.method === 'ge-cook') {
                    const recipeName = resolveArtisanSetting(cfg, 'RECIPE', cfg.args[0]) ?? 'cooking_generic_trout';
                    const recipe = cookingRecipes().recipes.find(r => r.name === recipeName);
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
                const log = (resolveArtisanSetting(cfg, 'LOG', cfg.args[1]) ?? 'normal').toLowerCase() as keyof typeof LOGS;
                if (!Object.hasOwn(LOGS, log)) {
                    blockers.push({ kind: 'invalid_config', message: `unknown firemaking log: ${log}` });
                } else {
                    const info = LOGS[log];
                    const reserve = Number(resolveArtisanSetting(cfg, 'LOG_RESERVE', '0'));
                    checkSkill(acct, 'Firemaking', info.level, blockers);
                    checkSupply(acct, world, info.id, reserve + 1, `${log} logs`, blockers, missingItems);
                    const tinder = usableStock(acct, world, 590);
                    const toolBudget = Number(resolveArtisanSetting(cfg, 'TOOL_BUDGET', '0'));
                    if (tinder.usable < 1 && (cfg.method !== 'order' || toolBudget < 1)) {
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
                    const res = Number(resolveArtisanSetting(cfg, 'LOG_RESERVE', '0'));
                    checkSupply(acct, world, 1511, res + 1, 'Logs', blockers, missingItems);
                } else {
                    const mode = (resolveArtisanSetting(cfg, 'MODE', cfg.args[1]) ?? 'arrows').toLowerCase();
                    if (mode === 'shafts') {
                        checkSupply(acct, world, 946, 1, 'Knife', blockers, missingItems);
                        checkSupply(acct, world, 1511, Number(resolveArtisanSetting(cfg, 'LOG_RESERVE', '0')) + 1, 'Logs', blockers, missingItems);
                    } else if (mode === 'headless') {
                        const sr = Number(resolveArtisanSetting(cfg, 'SHAFT_RESERVE', '200'));
                        const fr = Number(resolveArtisanSetting(cfg, 'FEATHER_RESERVE', '100'));
                        checkSupply(acct, world, 52, sr + 15, 'Arrow shafts', blockers, missingItems);
                        checkSupply(acct, world, 314, fr + 15, 'Feathers', blockers, missingItems);
                    } else if (mode === 'oak-bows') {
                        checkSkill(acct, 'Fletching', 25, blockers);
                        checkSupply(acct, world, 946, 1, 'Knife', blockers, missingItems);
                        checkSupply(acct, world, 1521, Number(resolveArtisanSetting(cfg, 'LOG_RESERVE', '0')) + 1, 'Oak logs', blockers, missingItems);
                        checkSupply(acct, world, 1777, Number(resolveArtisanSetting(cfg, 'STRING_RESERVE', '0')) + 1, 'Bow string', blockers, missingItems);
                    } else if (['iron', 'steel', 'native-arrows'].includes(mode)) {
                        const metal = (mode === 'native-arrows' ? (resolveArtisanSetting(cfg, 'TIP_TYPE', cfg.args[2]) ?? 'steel') : mode) as ArrowMetal;
                        const prof = nativeArrowProfile(metal);
                        checkSkill(acct, 'Fletching', prof.level, blockers);
                        const hr = Number(resolveArtisanSetting(cfg, 'HEADLESS_RESERVE', '200'));
                        const tr = Number(resolveArtisanSetting(cfg, 'TIP_RESERVE', mode === 'iron' ? '0' : '5'));
                        checkSupply(acct, world, 53, hr + 15, 'Headless arrow', blockers, missingItems);
                        checkSupply(acct, world, prof.tip, tr + 15, prof.tipName, blockers, missingItems);
                    }
                }
                break;
            }
            case 'smithing': {
                checkMaxCap(acct, 'Smithing', blockers);
                if (cfg.method === 'cannonballs' || (cfg.method === 'smelt' && (resolveArtisanSetting(cfg, 'BAR_TYPE', cfg.args[1]) ?? '').toLowerCase() === 'cannonballs')) {
                    const bars = Number(cfg.args[0] ?? resolveArtisanSetting(cfg, 'MAX_MAKE', '1'));
                    const reserve = Number(resolveArtisanSetting(cfg, 'CANNON_RESERVE', resolveArtisanSetting(cfg, 'ORE_RESERVE', '0')));
                    checkSkill(acct, 'Smithing', 35, blockers);
                    checkSupply(acct, world, 4, 1, 'Ammo mould', blockers, missingItems);
                    checkSupply(acct, world, 2353, (Number.isSafeInteger(bars) && bars > 0 ? bars : 1) + reserve, 'Steel bar', blockers, missingItems);
                } else if (cfg.method === 'anvil' || (cfg.method === 'smelt' && resolveArtisanSetting(cfg, 'ORDER_ACTION') === 'smith')) {
                    const pid = Number(resolveArtisanSetting(cfg, 'PRODUCT_ID', cfg.args[1]));
                    const max = Number(resolveArtisanSetting(cfg, 'MAX_MAKE', '1'));
                    const res = Number(resolveArtisanSetting(cfg, 'BAR_RESERVE', '0'));
                    if (!Number.isSafeInteger(pid) || pid < 0) {
                        blockers.push({ kind: 'invalid_config', message: 'smithing anvil requires integer PRODUCT_ID' });
                    } else {
                        const r = smithRecipe(pid);
                        checkSkill(acct, 'Smithing', r.level, blockers);
                        if (r.quest && !questComplete(acct, r.quest)) {
                            blockers.push({ kind: 'quest_incomplete', quest: r.quest, requiredState: 'complete', currentState: questStatusOf(acct, r.quest) });
                        }
                        checkSupply(acct, world, HAMMER, 1, 'Hammer', blockers, missingItems);
                        checkSupply(acct, world, r.bar, (Number.isSafeInteger(max) && max > 0 ? max : 1) * r.bars + (Number.isSafeInteger(res) ? res : 0), `Bar #${r.bar}`, blockers, missingItems);
                        travelTicks = 60;
                    }
                } else {
                    const bar = (resolveArtisanSetting(cfg, 'BAR_TYPE', cfg.args[1]) ?? 'iron').toLowerCase();
                    const r = smeltRecipe(bar);
                    const reserve = Number(resolveArtisanSetting(cfg, 'ORE_RESERVE', '1'));
                    checkSkill(acct, 'Smithing', r.level, blockers);
                    for (const ing of r.ingredients) {
                        checkSupply(acct, world, ing.id, ing.units + (Number.isSafeInteger(reserve) ? reserve : 0), `Ore #${ing.id}`, blockers, missingItems);
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
                    const res = Number(resolveArtisanSetting(cfg, 'RAW_RESERVE', '50'));
                    checkSupply(acct, world, 1779, res + 1, 'Flax', blockers, missingItems);
                    travelTicks = 30;
                } else if (cfg.method === 'jewellery') {
                    checkMaxCap(acct, 'Crafting', blockers);
                    const rName = cfg.args[0] ?? resolveArtisanSetting(cfg, 'RECIPE', 'sapphire_ring')!;
                    const r = jewelleryRecipes().find(x => x.name === rName);
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
                        const r = validateJewelleryOrder({
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
                    const levels: Record<string, number> = { sapphire: 20, emerald: 27, ruby: 34, diamond: 43, dragonstone: 55 };
                    if (levels[tier]) checkSkill(acct, 'Crafting', levels[tier]!, blockers);
                } else if (cfg.method === 'glass') {
                    checkMaxCap(acct, 'Crafting', blockers);
                    if (resolveArtisanSetting(cfg, 'SUPPLY_MODE') !== '1') {
                        checkSupply(acct, world, 1783, 1, 'Bucket of sand', blockers, missingItems);
                        checkSupply(acct, world, 1781, 1, 'Soda ash', blockers, missingItems);
                    }
                } else if (cfg.method === 'tanning') {
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
                    const res = Number(resolveArtisanSetting(cfg, 'RAW_RESERVE', '0'));
                    checkSupply(acct, world, 434, res + 1, 'Clay', blockers, missingItems);
                    if (usableStock(acct, world, 1925).usable < 1 && usableStock(acct, world, 1929).usable < 1) {
                        checkSupply(acct, world, 1925, 1, 'Bucket', blockers, missingItems);
                    }
                } else if (cfg.method === 'inventory') {
                    const rName = cfg.args[0];
                    const r = inventoryRecipes().find(x => x.name === rName);
                    if (!r) {
                        blockers.push({ kind: 'invalid_config', message: `unknown inventory production recipe: ${String(rName)}` });
                    } else {
                        checkSkill(acct, r.skill, r.level, blockers);
                        for (const t of r.tools) checkSupply(acct, world, t, 1, `Tool #${t}`, blockers, missingItems);
                        for (const i of r.inputs) checkSupply(acct, world, i.id, i.units, `Input #${i.id}`, blockers, missingItems);
                    }
                } else if (cfg.method === 'progressive') {
                    const mode = resolveArtisanSetting(cfg, 'MODE', 'fletch') as ProgressiveProduction['mode'];
                    validateProgressiveProduction({
                        mode,
                        targetLevel: Number(resolveArtisanSetting(cfg, 'TARGET_LEVEL', '50')),
                        maximum: Number(resolveArtisanSetting(cfg, 'MAX_MAKE', '10')),
                        batch: Number(resolveArtisanSetting(cfg, 'BATCH', '10')),
                        reserve: Number(resolveArtisanSetting(cfg, 'RAW_RESERVE', '0')),
                        cap: Number(resolveArtisanSetting(cfg, 'CAP', '1500')),
                        members: resolveArtisanSetting(cfg, 'MEMBERS') === '1',
                        bank: { x: 3185, z: 3436, level: 0 },
                        ...(['cooking-prepared', 'burn-bake'].includes(mode) ? { site: { x: 3212, z: 3414, level: 0 } } : {}),
                    });
                }
                break;
            }
            case 'herblore': {
                if (cfg.method === 'potions') {
                    checkMaxCap(acct, 'Herblore', blockers);
                    const key = (cfg.args[1] ?? resolveArtisanSetting(cfg, 'RECIPE', 'auto'))!.toLowerCase();
                    if (!['auto', 'unf', ...Object.keys(HERBLORE_RECIPES)].includes(key)) {
                        blockers.push({ kind: 'invalid_config', message: `unknown herblore recipe: ${key}` });
                    } else if (key !== 'auto' && key !== 'unf') {
                        const rec = HERBLORE_RECIPES[key]!;
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
                const bone = Number(resolveArtisanSetting(cfg, 'BONE', '526'));
                const reserve = Number(resolveArtisanSetting(cfg, 'BONE_RESERVE', '0'));
                if (!Number.isSafeInteger(bone) || bone < 0) {
                    blockers.push({ kind: 'invalid_config', message: 'invalid bone ID' });
                } else {
                    checkSupply(acct, world, bone, reserve + 1, `Bone #${bone}`, blockers, missingItems);
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
                        const r = itemMagicRecipe(mode, targetName === '-' ? undefined : targetName);
                        checkSkill(acct, 'Magic', r.level, blockers);
                        if (r.smithing > 0) checkSkill(acct, 'Smithing', r.smithing, blockers);
                        checkSupply(acct, world, r.target, 1, `Target #${r.target}`, blockers, missingItems);
                    }
                } else if (cfg.method === 'teleport') {
                    const dest = cfg.args[0] ?? 'varrock';
                    const t = nativeTeleport(dest);
                    checkSkill(acct, 'Magic', t.level, blockers);
                    for (const [idStr, n] of Object.entries(t.runes)) {
                        checkSupply(acct, world, Number(idStr), n, `Rune #${idStr}`, blockers, missingItems);
                    }
                } else if (cfg.method === 'orbs' || cfg.method === 'orbs-at-site') {
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
                    const target = Number(cfg.args[0] ?? resolveArtisanSetting(cfg, 'TARGET_LEVEL', '55'));
                    const itemName = resolveArtisanSetting(cfg, 'ALCH_ITEM', 'feather')!;
                    const recipe = itemMagicRecipe('high-alch', itemName);
                    const casts = alchCasts(skillXp(acct, 'Magic'), Number.isSafeInteger(target) ? target : 55);
                    if (casts.low + casts.high > 0) {
                        checkSupply(acct, world, 561, 1, 'Nature rune', blockers, missingItems);
                        checkSupply(acct, world, recipe.target, 1, itemName, blockers, missingItems);
                    }
                } else if (cfg.method === 'earth-production') {
                    const mode = cfg.args[0] ?? 'craft';
                    if (!['talismans', 'craft'].includes(mode)) {
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
    const catalog = artisanDbtablesCatalog();
    switch (cfg.skill) {
        case 'cooking': {
            if (cfg.method === 'wine' || cfg.method === 'mixed-wine') {
                return {
                    xpPerTick: 66.0,
                    skillXpPerTick: { Cooking: 66.0 },
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
            const food = (resolveArtisanSetting(cfg, 'FOOD_TYPE', cfg.args[1]) ?? 'trout').toLowerCase();
            const entry = catalog.cooking.find(c => c.uncooked.includes(food));
            const xpPer = (entry?.xp ?? 70) / 10;
            const xpPerTick = Number((xpPer * 0.25).toFixed(2));
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
            const log = (resolveArtisanSetting(cfg, 'LOG', cfg.args[1]) ?? 'normal').toLowerCase() as keyof typeof LOGS;
            const xpPerTick = log === 'magic' ? 75.0 : log === 'yew' ? 50.0 : log === 'maple' ? 33.7 : log === 'willow' ? 22.5 : log === 'oak' ? 15.0 : 10.0;
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
                return {
                    xpPerTick: 2.5,
                    skillXpPerTick: { Fletching: 2.5 },
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
            return {
                xpPerTick: 25.0,
                skillXpPerTick: { Fletching: 25.0 },
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
                return {
                    xpPerTick: 12.5,
                    skillXpPerTick: { Smithing: 12.5 },
                    unitsPerTick: 0.25,
                    gpPerTick: 5,
                    setupTicks: 40,
                    minBatchUnits: 1,
                    riskPerHour: 0,
                    confidence: 'practice',
                };
            }
            if (cfg.method === 'cannonballs') {
                return {
                    xpPerTick: 3.2,
                    skillXpPerTick: { Smithing: 3.2 },
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
            return {
                xpPerTick: 8.5,
                skillXpPerTick: { Smithing: 8.5 },
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
                return {
                    xpPerTick: 4.5,
                    skillXpPerTick: { Crafting: 4.5 },
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
            return {
                xpPerTick: 20.0,
                skillXpPerTick: { Crafting: 20.0 },
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
                return {
                    xpPerTick: 1.5,
                    skillXpPerTick: { Strength: 1.5 },
                    unitsPerTick: 0.01,
                    gpPerTick: 0,
                    setupTicks: 100,
                    minBatchUnits: 1,
                    riskPerHour: 0.05,
                    confidence: 'practice',
                    outputsPerUnit: { 2132: 1, 2134: 1, 2136: 1, 2138: 1 },
                };
            }
            return {
                xpPerTick: 18.0,
                skillXpPerTick: { Herblore: 18.0 },
                unitsPerTick: 0.25,
                gpPerTick: -10,
                setupTicks: 30,
                minBatchUnits: 9,
                riskPerHour: 0,
                confidence: 'practice',
                inputsPerUnit: { 227: 1 },
            };
        }
        case 'prayer':
            return {
                xpPerTick: 2.2,
                skillXpPerTick: { Prayer: 2.2 },
                unitsPerTick: 0.5,
                gpPerTick: -5,
                setupTicks: 15,
                minBatchUnits: 28,
                riskPerHour: 0,
                confidence: 'practice',
                inputsPerUnit: { [Number(resolveArtisanSetting(cfg, 'BONE', '526')) || 526]: 1 },
            };
        case 'magic': {
            const lvl = skillLevel(acct, 'Magic');
            const high = lvl >= 55;
            if (cfg.method === 'alch-train' || cfg.method === 'items') {
                const xp = high ? 16.25 : 7.75;
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
                return {
                    xpPerTick: 15.0,
                    skillXpPerTick: { Magic: 15.0 },
                    unitsPerTick: 0.2,
                    gpPerTick: 25,
                    setupTicks: 90,
                    minBatchUnits: 26,
                    riskPerHour: 0.04,
                    confidence: 'practice',
                };
            }
            return {
                xpPerTick: 8.0,
                skillXpPerTick: { Magic: 8.0 },
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
                xpPerTick: 15.0,
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
