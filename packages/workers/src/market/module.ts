import { existsSync, readFileSync } from 'node:fs';
import { accountEscrowCoins, accountOwnedItemCount, accountReserveFor, availableCoinsAfterReserves, preflightFail, preflightOk, reserveAdjustedStock, type PreflightBlocker, type PreflightResult, type RateEstimate, type RunOutcome, type SessionCore, type WorkerAccountView, type WorkerModule, type WorkerTile, type WorkerWorldView } from '../contracts';
import type { Session } from '../../../core/src/inprocess';
import { routeFares, type Account as WorldAccount } from '../../../core/src/world/model';
import {
    GE_VARROCK_BANK,
    getGeCatalogueNameById,
    orderEscrow,
    orderPaths,
    percentagePrice,
    PROFILES,
    profileRefusal,
    resolveShopProfile,
    selectItems,
    SWORD,
    SWORD_PROFILES,
    validateBankSeller,
    validateBuyList,
    validateGEPlan,
    validateGETrip,
    validateRequest,
    validateSale,
} from './preflight';
import type { BankSellerPolicy, BuyListRequest, GEPricePlan, GETripRequest, ItemRequest, MarketConfig, SaleRequest, ShopTripJob } from './types';

void percentagePrice;

const COINS = 995;
const EARTH_RUNE = 557;
const SWORD_SHOP_SPOT: WorkerTile = { x: 3204, z: 3398, level: 0 };

function readJsonFile<T>(path: string, label: string): T {
    if (!path || !existsSync(path)) throw new Error(`${label} file missing: ${path}`);
    return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function activeCooldown(acct: WorkerAccountView, world: WorkerWorldView, keys: readonly string[]): { key: string; expiresAt: number } | null {
    const worldCd = world.marketCooldowns;
    if (worldCd) {
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i]!;
            const expiresAt = worldCd[key];
            if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > world.at) {
                return { key, expiresAt };
            }
        }
    }
    const acctCd = acct.cooldowns;
    if (acctCd) {
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i]!;
            const expiresAt = acctCd[key];
            if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > world.at) {
                return { key, expiresAt };
            }
        }
    }
    return null;
}

function normalizeShopBuyConfig(cfg: Extract<MarketConfig, { mode: 'shop-buy' }>): Extract<MarketConfig, { mode: 'shop-buy' }> {
    const profile = cfg.profile ?? cfg.shopId ?? '';
    const maxItems = cfg.maxItems ?? cfg.quantity;
    let items = cfg.items;
    if (items === undefined && cfg.itemId !== undefined) {
        const name = getGeCatalogueNameById().get(cfg.itemId);
        const conf = profile ? resolveShopProfile(profile) : undefined;
        const matchedByName = name && conf ? conf.items.find(i => i.re.test(name))?.re.source : undefined;
        items = matchedByName ?? name;
    }
    return {
        ...cfg,
        profile,
        ...(maxItems !== undefined ? { maxItems } : {}),
        ...(items !== undefined ? { items } : {}),
    };
}

function cooldownKeysFor(cfg: MarketConfig): string[] {
    const keys = ['market', cfg.mode];
    switch (cfg.mode) {
        case 'shop-buy': {
            const profile = cfg.profile ?? cfg.shopId ?? '';
            if (profile) keys.push(`shop:${profile.toLowerCase()}`);
            return keys;
        }
        case 'earth-shop':
            if (cfg.profile) keys.push(`shop:${cfg.profile.toLowerCase()}`);
            return keys;
        case 'buy-sword':
            keys.push(`shop:varrock_sword:${cfg.itemId ?? SWORD}`);
            return keys;
        case 'shop-trip':
        case 'shop-sell':
            if (cfg.job) {
                keys.push(`shop:${cfg.job.merchant}`, `item:${cfg.job.item}:shop`);
            }
            return keys;
        case 'ge-buy':
        case 'ge-sell': {
            const item = cfg.request?.item ?? cfg.itemId;
            if (item) keys.push(`item:${item}:ge`, `ge:${item}`);
            return keys;
        }
        case 'ge-trip':
            if (cfg.request) keys.push(`item:${cfg.request.item}:ge`, `ge:${cfg.request.item}`);
            return keys;
        case 'ge-plan':
            if (cfg.plan) keys.push(`item:${cfg.plan.item}:ge`, `ge:${cfg.plan.item}`);
            return keys;
        case 'shop-to-bid':
            for (let i = 0; i < cfg.profiles.length; i++) keys.push(`shop:${cfg.profiles[i]!.toLowerCase()}`);
            for (let i = 0; i < cfg.itemIds.length; i++) keys.push(`item:${cfg.itemIds[i]!}:ge`);
            return keys;
        default:
            return keys;
    }
}

function toWorldAccount(acct: WorkerAccountView, availableCoins: number): WorldAccount {
    const names = getGeCatalogueNameById();
    const skills: Record<string, number> = {};
    for (const k in acct.skills) {
        if (Object.prototype.hasOwnProperty.call(acct.skills, k)) skills[k] = acct.skills[k]!.level;
    }
    const counts: Record<string, number> = {};
    const items: string[] = [];
    const addCounts = (bag: Readonly<Record<number, number>>) => {
        for (const idStr in bag) {
            if (!Object.prototype.hasOwnProperty.call(bag, idStr)) continue;
            const count = bag[idStr as unknown as number]!;
            if (count <= 0) continue;
            const name = names.get(Number(idStr));
            if (name) {
                if (counts[name] === undefined) {
                    counts[name] = count;
                    items.push(name);
                } else {
                    counts[name]! += count;
                }
            }
        }
    };
    addCounts(acct.inventory);
    addCounts(acct.equipment);
    if (acct.bank.trusted) addCounts(acct.bank.items);
    const worn: string[] = [];
    for (const idStr in acct.equipment) {
        if (!Object.prototype.hasOwnProperty.call(acct.equipment, idStr)) continue;
        const count = acct.equipment[idStr as unknown as number]!;
        if (count <= 0) continue;
        const name = names.get(Number(idStr));
        if (name) worn.push(name);
    }
    const questStages: Record<string, number> = {};
    for (const quest in acct.quests) {
        if (!Object.prototype.hasOwnProperty.call(acct.quests, quest)) continue;
        const state = acct.quests[quest]!;
        questStages[quest] = state === 'complete' ? 2 : state === 'started' ? 1 : 0;
    }
    return {
        skills,
        varps: {},
        items,
        coins: availableCoins,
        counts,
        worn,
        questStages,
    };
}

function evaluateRoute(
    acct: WorkerAccountView,
    world: WorkerWorldView,
    target: WorkerTile,
    availableCoins: number,
    blockers: PreflightBlocker[],
): { travelCoins: number; travelTicks: number } {
    if (!world.world || !acct.pos) return { travelCoins: 0, travelTicks: 0 };
    const route = world.world.route(acct.pos, target, toWorldAccount(acct, availableCoins));
    if (!route.ok) {
        blockers.push({ kind: 'unreachable_tile', target, from: acct.pos, reason: route.reason });
        return { travelCoins: 0, travelTicks: 0 };
    }
    return { travelCoins: routeFares(route.legs), travelTicks: route.cost };
}

function syntheticBuyRequest(acct: WorkerAccountView, cfg: Extract<MarketConfig, { mode: 'ge-buy' }>, world: WorkerWorldView): ItemRequest {
    if (cfg.request) return cfg.request;
    const now = world.at || Date.now();
    const orderMs = cfg.orderMs ?? 60_000;
    return {
        actor: acct.name,
        server: world.server || 'local',
        goal: cfg.goal ?? 'market-ge-buy',
        item: cfg.itemId ?? 0,
        quantity: cfg.quantity ?? 1,
        ...(cfg.expectedOwned !== undefined ? { expectedOwned: cfg.expectedOwned } : {}),
        ...(cfg.rescueMode ? { rescueMode: cfg.rescueMode } : {}),
        limit: cfg.limitPrice ?? 0,
        reserve: cfg.cashReserve ?? 0,
        createdAt: now,
        reviewAt: now,
        deadline: now + Math.max(1000, orderMs),
    };
}

function syntheticSaleRequest(acct: WorkerAccountView, cfg: Extract<MarketConfig, { mode: 'ge-sell' }>, world: WorkerWorldView): SaleRequest {
    if (cfg.request) return cfg.request;
    const now = world.at || Date.now();
    const orderMs = cfg.orderMs ?? 60_000;
    return {
        actor: acct.name,
        server: world.server || 'local',
        goal: cfg.goal ?? 'market-ge-sell',
        item: cfg.itemId ?? 0,
        quantity: cfg.quantity ?? 0,
        price: cfg.sellPrice ?? 0,
        floor: cfg.floorPrice ?? cfg.sellPrice ?? 0,
        reserveItems: cfg.reserveItems ?? 0,
        deadline: now + Math.max(1000, orderMs),
    };
}

function buildConfigError(blockers: PreflightBlocker[], message: string): void {
    blockers.push({ kind: 'invalid_config', message });
}

export function preflightMarket(acct: WorkerAccountView, cfg: MarketConfig, world: WorkerWorldView): PreflightResult {
    if (!cfg || typeof cfg !== 'object' || !('mode' in cfg)) {
        return preflightFail([{ kind: 'invalid_config', message: 'market config must specify mode' }]);
    }
    const blockers: PreflightBlocker[] = [];
    if (acct.protectedClock) {
        blockers.push({ kind: 'protected_clock', message: 'market worker is disallowed on protected clock accounts without campaign gate' });
    }
    const cd = activeCooldown(acct, world, cooldownKeysFor(cfg));
    if (cd) {
        blockers.push({ kind: 'cooldown_active', key: cd.key, expiresAt: cd.expiresAt });
    }

    const totalCoins = accountOwnedItemCount(acct, COINS, { requireTrustedBank: true });
    const baseCoinReserve = accountReserveFor(acct, world, COINS);
    const escrow = accountEscrowCoins(acct, world);
    const freeCoins = availableCoinsAfterReserves(totalCoins, baseCoinReserve, escrow);
    let travelCoins = 0;
    let travelTicks = 0;

    switch (cfg.mode) {
        case 'shop-buy': {
            const shopCfg = normalizeShopBuyConfig(cfg);
            const coinReserve = Math.max(baseCoinReserve, shopCfg.coinReserve ?? 0);
            const maxSpend = shopCfg.maxSpend ?? Infinity;
            const maxItems = shopCfg.maxItems ?? Infinity;
            const flt = shopCfg.float ?? 20_000;
            const noBuyTicks = shopCfg.noBuyTicks ?? 0;
            if (!Number.isSafeInteger(coinReserve) || coinReserve < 0) buildConfigError(blockers, 'invalid shop budget coinReserve');
            if ((maxSpend !== Infinity && !Number.isSafeInteger(maxSpend)) || maxSpend < 0) buildConfigError(blockers, 'invalid shop budget maxSpend');
            if ((maxItems !== Infinity && !Number.isSafeInteger(maxItems)) || maxItems < 0) buildConfigError(blockers, 'invalid shop budget maxItems');
            if (!Number.isSafeInteger(flt) || flt < 0) buildConfigError(blockers, 'invalid shop budget float');
            if (!Number.isSafeInteger(noBuyTicks) || noBuyTicks < 0) buildConfigError(blockers, 'invalid shop budget noBuyTicks');
            if (flt <= (shopCfg.coinReserve ?? 0) || maxSpend === 0 || maxItems === 0) {
                buildConfigError(blockers, 'shop budget needs float > coinReserve and positive maxSpend/maxItems');
            }
            const conf = shopCfg.profile ? resolveShopProfile(shopCfg.profile) : undefined;
            if (!conf) {
                buildConfigError(blockers, `unknown shop profile: ${shopCfg.profile}`);
                break;
            }
            try {
                const matched = selectItems(conf.items, shopCfg.items);
                if (!matched.length) buildConfigError(blockers, `items filter ${shopCfg.items} matches no ${shopCfg.profile} item`);
            } catch (err) {
                buildConfigError(blockers, String(err));
            }
            if (conf.need) {
                const current = acct.skills[conf.need.skill]?.level ?? 1;
                const refusal = profileRefusal(shopCfg.profile, conf, current);
                if (refusal) {
                    blockers.push({
                        kind: 'skill_level',
                        skill: conf.need.skill,
                        required: conf.need.level,
                        current,
                        message: refusal,
                    });
                }
            }
            if (!conf.realm) {
                const route = evaluateRoute(
                    acct,
                    world,
                    { x: conf.npcSpot.x, z: conf.npcSpot.z, level: conf.npcSpot.level ?? 0 },
                    freeCoins,
                    blockers,
                );
                travelCoins += route.travelCoins;
                travelTicks += route.travelTicks;
            }
            const requiredSpend = conf.dialogBuy ? conf.dialogBuy.cost : 1;
            const minCoinsRequired = coinReserve + travelCoins + requiredSpend;
            const spendable = availableCoinsAfterReserves(totalCoins, coinReserve, escrow);
            if (spendable < travelCoins + requiredSpend) {
                blockers.push({
                    kind: 'missing_coins',
                    required: Math.max(1, minCoinsRequired),
                    available: totalCoins,
                    reserved: coinReserve,
                    escrow,
                    ferryFare: travelCoins,
                });
            }
            break;
        }
        case 'earth-shop': {
            if (!['aubury', 'betty'].includes(cfg.profile)) {
                buildConfigError(blockers, `unsupported earth-shop profile: ${cfg.profile}`);
                break;
            }
            if (![cfg.cap, cfg.target, cfg.maximum, cfg.spend, cfg.reserve].every(Number.isSafeInteger)
                || cfg.cap < 1 || cfg.cap > 16_000 || cfg.target < 1 || cfg.maximum < 0 || cfg.spend < 0 || cfg.reserve < 0) {
                buildConfigError(blockers, 'invalid finite earth-shop refill parameters');
            }
            const conf = PROFILES[cfg.profile]!;
            const route = evaluateRoute(acct, world, { x: conf.npcSpot.x, z: conf.npcSpot.z, level: 0 }, freeCoins, blockers);
            travelCoins = route.travelCoins;
            travelTicks = route.travelTicks;
            const ownedEarth = accountOwnedItemCount(acct, EARTH_RUNE);
            const missingEarth = Math.max(0, cfg.target - ownedEarth);
            const coinReserve = Math.max(baseCoinReserve, cfg.reserve);
            const minNeed = missingEarth > 0 ? 4 + travelCoins : travelCoins;
            if (minNeed > 0 && availableCoinsAfterReserves(totalCoins, coinReserve, escrow) < minNeed) {
                blockers.push({
                    kind: 'missing_coins',
                    required: Math.max(1, coinReserve + minNeed),
                    available: totalCoins,
                    reserved: coinReserve,
                    escrow,
                    ferryFare: travelCoins,
                });
            }
            break;
        }
        case 'buy-sword': {
            const itemId = cfg.itemId ?? SWORD;
            const profile = SWORD_PROFILES[itemId];
            const cap = cfg.cap ?? 900;
            const maximumSpend = cfg.maximumSpend ?? profile?.limit ?? 2500;
            if (!profile || !Number.isSafeInteger(cap) || cap < 1 || !Number.isSafeInteger(maximumSpend) || maximumSpend < 1 || maximumSpend > profile.limit) {
                buildConfigError(blockers, 'requires valid sword itemId, positive cap, and item-specific maximumSpend limit');
                break;
            }
            if (maximumSpend < profile.cost) {
                buildConfigError(blockers, `maximumSpend ${maximumSpend} below shop sword cost ${profile.cost}`);
            }
            const route = evaluateRoute(acct, world, SWORD_SHOP_SPOT, freeCoins, blockers);
            travelCoins = route.travelCoins;
            travelTicks = route.travelTicks;
            const spendable = availableCoinsAfterReserves(totalCoins, baseCoinReserve, escrow);
            if (spendable < profile.cost + travelCoins) {
                blockers.push({
                    kind: 'missing_coins',
                    required: baseCoinReserve + profile.cost + travelCoins,
                    available: totalCoins,
                    reserved: baseCoinReserve,
                    escrow,
                    ferryFare: travelCoins,
                });
            }
            break;
        }
        case 'shop-trip':
        case 'shop-sell': {
            if (!cfg.job && !cfg.jobFile?.trim()) {
                buildConfigError(blockers, `${cfg.mode} requires job or jobFile`);
                break;
            }
            if (cfg.job) {
                let merchant;
                try {
                    const { validateShopTrip } = require('./shop-sell') as typeof import('./shop-sell');
                    merchant = validateShopTrip(cfg.job);
                } catch (err) {
                    buildConfigError(blockers, String(err));
                    break;
                }
                const owned = accountOwnedItemCount(acct, cfg.job.item);
                const reserved = accountReserveFor(acct, world, cfg.job.item);
                if (reserveAdjustedStock(owned, reserved) < 1) {
                    blockers.push({ kind: 'missing_supply', itemId: cfg.job.item, required: 1, available: owned, reserved });
                }
                const route = evaluateRoute(acct, world, { ...merchant.site }, freeCoins, blockers);
                travelCoins = route.travelCoins;
                travelTicks = route.travelTicks;
            }
            break;
        }
        case 'ge-buy': {
            const req = syntheticBuyRequest(acct, cfg, world);
            try {
                validateRequest(req);
            } catch (err) {
                buildConfigError(blockers, String(err));
                break;
            }
            if (req.rescueMode !== 'npc-respawn-once') {
                const route = evaluateRoute(acct, world, { ...GE_VARROCK_BANK, level: 0 }, freeCoins, blockers);
                travelCoins = route.travelCoins;
                travelTicks = route.travelTicks;
            }
            const escrowNeed = orderEscrow(req);
            const coinReserve = Math.max(baseCoinReserve, req.reserve);
            const spendable = availableCoinsAfterReserves(totalCoins, coinReserve, escrow);
            if (spendable < escrowNeed + travelCoins) {
                blockers.push({
                    kind: 'missing_coins',
                    required: Math.max(1, coinReserve + escrowNeed + travelCoins),
                    available: totalCoins,
                    reserved: coinReserve,
                    escrow,
                    ferryFare: travelCoins,
                });
            }
            break;
        }
        case 'ge-sell': {
            const req = syntheticSaleRequest(acct, cfg, world);
            try {
                validateSale(req);
            } catch (err) {
                buildConfigError(blockers, String(err));
                break;
            }
            const route = evaluateRoute(acct, world, { ...GE_VARROCK_BANK, level: 0 }, freeCoins, blockers);
            travelCoins = route.travelCoins;
            travelTicks = route.travelTicks;
            const owned = accountOwnedItemCount(acct, req.item);
            const reserved = Math.max(accountReserveFor(acct, world, req.item), req.reserveItems);
            if (reserveAdjustedStock(owned, reserved) < req.quantity) {
                blockers.push({
                    kind: 'missing_supply',
                    itemId: req.item,
                    required: req.quantity + reserved,
                    available: owned,
                    reserved,
                });
            }
            break;
        }
        case 'ge-buy-list': {
            if (!cfg.request && !cfg.requestFile?.trim()) {
                buildConfigError(blockers, 'ge-buy-list requires request or requestFile');
                break;
            }
            if (cfg.request) {
                try {
                    validateBuyList(cfg.request);
                } catch (err) {
                    buildConfigError(blockers, String(err));
                    break;
                }
                const route = evaluateRoute(acct, world, { ...GE_VARROCK_BANK, level: 0 }, freeCoins, blockers);
                travelCoins = route.travelCoins;
                travelTicks = route.travelTicks;
                const coinReserve = Math.max(baseCoinReserve, cfg.request.reserve);
                const spendable = availableCoinsAfterReserves(totalCoins, coinReserve, escrow);
                if (spendable < cfg.request.budget + travelCoins) {
                    blockers.push({
                        kind: 'missing_coins',
                        required: coinReserve + cfg.request.budget + travelCoins,
                        available: totalCoins,
                        reserved: coinReserve,
                        escrow,
                        ferryFare: travelCoins,
                    });
                }
            }
            break;
        }
        case 'ge-trip': {
            if (!cfg.request && !cfg.requestFile?.trim()) {
                buildConfigError(blockers, 'ge-trip requires request or requestFile');
                break;
            }
            if (cfg.request) {
                try {
                    validateGETrip(cfg.request);
                } catch (err) {
                    buildConfigError(blockers, String(err));
                    break;
                }
                const route = evaluateRoute(acct, world, { ...GE_VARROCK_BANK, level: 0 }, freeCoins, blockers);
                travelCoins = route.travelCoins;
                travelTicks = route.travelTicks;
                const owned = accountOwnedItemCount(acct, cfg.request.item);
                const reserved = Math.max(accountReserveFor(acct, world, cfg.request.item), cfg.request.reserve);
                if (reserveAdjustedStock(owned, reserved) < cfg.request.quantity) {
                    blockers.push({
                        kind: 'missing_supply',
                        itemId: cfg.request.item,
                        required: cfg.request.quantity + reserved,
                        available: owned,
                        reserved,
                    });
                }
            }
            break;
        }
        case 'ge-plan': {
            if (!cfg.plan && !cfg.planFile?.trim()) {
                buildConfigError(blockers, 'ge-plan requires plan or planFile');
                break;
            }
            if (cfg.plan) {
                try {
                    validateGEPlan(cfg.plan);
                } catch (err) {
                    buildConfigError(blockers, String(err));
                    break;
                }
                const route = evaluateRoute(acct, world, { ...GE_VARROCK_BANK, level: 0 }, freeCoins, blockers);
                travelCoins = route.travelCoins;
                travelTicks = route.travelTicks;
                const owned = accountOwnedItemCount(acct, cfg.plan.item);
                const reserved = Math.max(accountReserveFor(acct, world, cfg.plan.item), cfg.plan.reserve);
                if (reserveAdjustedStock(owned, reserved) < cfg.plan.quantity) {
                    blockers.push({
                        kind: 'missing_supply',
                        itemId: cfg.plan.item,
                        required: cfg.plan.quantity + reserved,
                        available: owned,
                        reserved,
                    });
                }
            }
            break;
        }
        case 'bank-seller': {
            if (!cfg.policy && !cfg.policyFile?.trim()) {
                buildConfigError(blockers, 'bank-seller requires policy or policyFile');
                break;
            }
            if (cfg.policy) {
                try {
                    validateBankSeller(cfg.policy);
                } catch (err) {
                    buildConfigError(blockers, String(err));
                    break;
                }
                const route = evaluateRoute(acct, world, { ...GE_VARROCK_BANK, level: 0 }, freeCoins, blockers);
                travelCoins = route.travelCoins;
                travelTicks = route.travelTicks;
            }
            break;
        }
        case 'shop-to-bid': {
            if (!cfg.profiles.length || cfg.profiles.some(p => !PROFILES[p])) {
                buildConfigError(blockers, 'shop-to-bid requires valid PROFILES keys');
                break;
            }
            if (!cfg.itemIds.length || cfg.itemIds.some(id => !Number.isSafeInteger(id) || id < 1 || id === COINS)) {
                buildConfigError(blockers, 'shop-to-bid requires positive non-coin itemIds');
                break;
            }
            const first = PROFILES[cfg.profiles[0]!]!;
            const route = evaluateRoute(acct, world, { x: first.bankSpot.x, z: first.bankSpot.z, level: 0 }, freeCoins, blockers);
            travelCoins = route.travelCoins;
            travelTicks = route.travelTicks;
            const coinReserve = Math.max(baseCoinReserve, cfg.coinReserve ?? 10_000);
            if (availableCoinsAfterReserves(totalCoins, coinReserve, escrow) < travelCoins + 1) {
                blockers.push({
                    kind: 'missing_coins',
                    required: coinReserve + travelCoins + 1,
                    available: totalCoins,
                    reserved: coinReserve,
                    escrow,
                    ferryFare: travelCoins,
                });
            }
            break;
        }
    }

    if (blockers.length > 0) return preflightFail(blockers, { travelCoins, travelTicks });
    return preflightOk({ travelCoins, travelTicks });
}

export function estimateMarket(acct: WorkerAccountView, cfg: MarketConfig, world: WorkerWorldView): RateEstimate {
    const baseSetup = (() => {
        if (!world.world || !acct.pos) return 35;
        let target: WorkerTile | null = null;
        if (cfg.mode === 'shop-buy') {
            const shopCfg = normalizeShopBuyConfig(cfg);
            const p = shopCfg.profile ? resolveShopProfile(shopCfg.profile) : undefined;
            if (p) target = { x: p.npcSpot.x, z: p.npcSpot.z, level: p.npcSpot.level ?? 0 };
        } else if (cfg.mode === 'earth-shop') {
            const p = cfg.profile ? resolveShopProfile(cfg.profile) : undefined;
            if (p) target = { x: p.npcSpot.x, z: p.npcSpot.z, level: p.npcSpot.level ?? 0 };
        } else if (cfg.mode === 'buy-sword') {
            target = SWORD_SHOP_SPOT;
        } else if (cfg.mode === 'shop-to-bid') {
            const p = PROFILES[cfg.profiles[0] ?? ''];
            if (p) target = { x: p.bankSpot.x, z: p.bankSpot.z, level: 0 };
        } else {
            target = { ...GE_VARROCK_BANK, level: 0 };
        }
        if (!target) return 35;
        const route = world.world.route(acct.pos, target, toWorldAccount(acct, accountOwnedItemCount(acct, COINS)));
        return route.ok ? route.cost : 45;
    })();

    switch (cfg.mode) {
        case 'shop-buy': {
            const shopCfg = normalizeShopBuyConfig(cfg);
            const conf = shopCfg.profile ? resolveShopProfile(shopCfg.profile) : undefined;
            const matched = conf ? selectItems(conf.items, shopCfg.items) : [];
            const batchRate = Math.max(1, matched[0]?.buyPerTick ?? 2);
            return {
                xpPerTick: 0,
                unitsPerTick: Number(Math.min(20, Math.max(0.5, batchRate / 3)).toFixed(2)),
                gpPerTick: -10,
                setupTicks: baseSetup,
                minBatchUnits: 1,
                confidence: 'practice',
            };
        }
        case 'earth-shop':
            return {
                xpPerTick: 0,
                unitsPerTick: 10,
                gpPerTick: -40,
                setupTicks: baseSetup,
                minBatchUnits: Math.max(1, Math.min(50, cfg.target)),
                outputsPerUnit: { [EARTH_RUNE]: 1 },
                inputsPerUnit: { [COINS]: 4 },
                confidence: 'practice',
            };
        case 'buy-sword': {
            const id = cfg.itemId ?? SWORD;
            const cost = SWORD_PROFILES[id]?.cost ?? 2080;
            return {
                xpPerTick: 0,
                unitsPerTick: 0.02,
                gpPerTick: -Math.round(cost / 60),
                setupTicks: Math.max(20, baseSetup),
                minBatchUnits: 1,
                outputsPerUnit: { [id]: 1 },
                inputsPerUnit: { [COINS]: cost },
                confidence: 'practice',
            };
        }
        case 'shop-trip':
        case 'shop-sell':
            return {
                xpPerTick: 0,
                unitsPerTick: 0.4,
                gpPerTick: cfg.job ? cfg.job.minimumUnit * 0.4 : 20,
                setupTicks: Math.max(25, baseSetup),
                minBatchUnits: Math.max(1, cfg.job?.batch ?? 1),
                ...(cfg.job ? { inputsPerUnit: { [cfg.job.item]: 1 }, outputsPerUnit: { [COINS]: cfg.job.minimumUnit } } : {}),
                confidence: 'practice',
            };
        case 'ge-buy': {
            const qty = Math.max(1, cfg.request?.quantity ?? cfg.quantity ?? 1);
            const item = cfg.request?.item ?? cfg.itemId ?? 0;
            const limit = cfg.request?.limit ?? cfg.limitPrice ?? 0;
            return {
                xpPerTick: 0,
                unitsPerTick: Number(Math.min(20, Math.max(0.05, qty / 60)).toFixed(2)),
                gpPerTick: limit > 0 ? -Math.round((limit * Math.min(qty, 20)) / 60) : 0,
                setupTicks: baseSetup,
                minBatchUnits: 1,
                ...(item > 0 && limit > 0 ? { outputsPerUnit: { [item]: 1 }, inputsPerUnit: { [COINS]: limit } } : {}),
                confidence: 'practice',
            };
        }
        case 'ge-sell':
        case 'ge-trip':
        case 'ge-plan': {
            const qty = cfg.mode === 'ge-sell'
                ? Math.max(1, cfg.request?.quantity ?? cfg.quantity ?? 1)
                : cfg.mode === 'ge-trip'
                    ? Math.max(1, cfg.request?.quantity ?? 1)
                    : Math.max(1, cfg.plan?.quantity ?? 1);
            return {
                xpPerTick: 0,
                unitsPerTick: Number(Math.min(20, Math.max(0.05, qty / 60)).toFixed(2)),
                gpPerTick: 25,
                setupTicks: baseSetup,
                minBatchUnits: 1,
                confidence: 'practice',
            };
        }
        case 'ge-buy-list':
            return {
                xpPerTick: 0,
                unitsPerTick: 1,
                gpPerTick: 0,
                setupTicks: baseSetup,
                minBatchUnits: 1,
                confidence: 'practice',
            };
        case 'bank-seller':
            return {
                xpPerTick: 0,
                unitsPerTick: 1,
                gpPerTick: 50,
                setupTicks: baseSetup,
                minBatchUnits: 1,
                confidence: 'practice',
            };
        case 'shop-to-bid':
            return {
                xpPerTick: 0,
                unitsPerTick: 2,
                gpPerTick: 400,
                setupTicks: baseSetup,
                minBatchUnits: Math.max(1, Math.min(100, cfg.units ?? 100)),
                confidence: 'practice',
            };
    }
}

function classifyFailureOutcome(
    activityId: string,
    account: string,
    ticksElapsed: number,
    durationMs: number,
    message: string,
    pos: WorkerTile | null,
    defaultVenue: string,
    itemId = COINS,
): RunOutcome {
    const lower = message.toLowerCase();
    if (lower.includes('died') || lower.includes('death')) {
        return {
            kind: 'death',
            activityId,
            account,
            ticksElapsed,
            durationMs,
            pos,
            faultSignature: `${activityId}:death`,
            detail: message,
        };
    }
    if (lower.includes('stranded')) {
        return { kind: 'location_stranded', activityId, account, ticksElapsed, durationMs, pos, detail: message };
    }
    if (lower.includes('file missing')) {
        return {
            kind: 'worker_defect',
            activityId,
            account,
            ticksElapsed,
            durationMs,
            faultSignature: `${activityId}:missing_config_file`,
            detail: message,
        };
    }
    if (lower.includes('reserve') || lower.includes('funding') || lower.includes('surplus') || lower.includes('missing') || lower.includes('short')) {
        return {
            kind: 'missing_supply',
            activityId,
            account,
            ticksElapsed,
            durationMs,
            missing: [{ itemId, required: 1, available: 0 }],
            summary: message,
        };
    }
    if (lower.includes('unresolved') || lower.includes('uncertain') || lower.includes('escrow') || lower.includes('settle')) {
        return { kind: 'session_unsettled', activityId, account, ticksElapsed, durationMs, reason: 'market_unsettled', detail: message };
    }
    if (lower.includes('market') || lower.includes('quote') || lower.includes('bid') || lower.includes('stock')) {
        return { kind: 'market_unavailable', activityId, account, ticksElapsed, durationMs, itemId, venue: defaultVenue, detail: message };
    }
    return {
        kind: 'worker_defect',
        activityId,
        account,
        ticksElapsed,
        durationMs,
        faultSignature: `${activityId}:error`,
        detail: message,
    };
}

function currentPos(session: SessionCore): WorkerTile | null {
    const p = session.sdk.getState()?.player;
    return p ? { x: p.worldX, z: p.worldZ, level: p.level } : null;
}

export async function runMarketWorker(session: SessionCore, cfg: MarketConfig): Promise<RunOutcome> {
    const { watchWorkerStop } = await import('../stop');
    const startedMs = Date.now();
    const t0 = session.tick();
    const elapsed = () => Math.max(0, session.tick() - t0);
    const ms = () => Math.max(0, Date.now() - startedMs);
    const activityId = `market:${cfg.mode}`;
    const s = session as unknown as Session;
    const server = s.lifecycle?.server ?? process.env.BOT_SERVER ?? 'local';
    const { isStopped } = watchWorkerStop(session, cfg.stop);
    await Promise.resolve();
    if (isStopped()) {
        return {
            kind: 'session_unsettled',
            activityId,
            account: session.name,
            ticksElapsed: 0,
            durationMs: ms(),
            reason: 'stopped',
            detail: 'stop or session end observed before start',
        };
    }

    try {
        switch (cfg.mode) {
            case 'shop-buy': {
                const { runShopBuy } = await import('./shop-buy');
                const shopCfg = normalizeShopBuyConfig(cfg);
                const r = await runShopBuy(s, shopCfg, isStopped);
                const ticksElapsed = Math.max(0, r.ticks);
                if (r.strandedOnDeck) {
                    return { kind: 'location_stranded', activityId, account: session.name, ticksElapsed, durationMs: ms(), pos: currentPos(session), detail: r.summary };
                }
                if (r.ok) {
                    return {
                        kind: 'target_met',
                        activityId,
                        account: session.name,
                        ticksElapsed,
                        durationMs: ms(),
                        unitsCompleted: r.boughtTotal,
                        coinsDelta: -r.spentTotal,
                        summary: r.summary,
                    };
                }
                if (r.stop === 'coin-reserve' || r.stop === 'no-fare') {
                    return {
                        kind: 'missing_supply',
                        activityId,
                        account: session.name,
                        ticksElapsed,
                        durationMs: ms(),
                        missing: [{ itemId: COINS, required: Math.max(1, r.coinReserve + 1), available: r.coinsLeft }],
                        summary: r.summary,
                    };
                }
                if (r.refused) {
                    return { kind: 'worker_defect', activityId, account: session.name, ticksElapsed, durationMs: ms(), faultSignature: `${activityId}:refused`, detail: r.refused };
                }
                if (isStopped() || r.stop === 'stopped' || r.stop === 'interrupted') {
                    return { kind: 'session_unsettled', activityId, account: session.name, ticksElapsed, durationMs: ms(), reason: r.stop ?? 'stopped', detail: r.summary };
                }
                return {
                    kind: 'market_unavailable',
                    activityId,
                    account: session.name,
                    ticksElapsed,
                    durationMs: ms(),
                    itemId: 0,
                    venue: `shop:${shopCfg.profile}`,
                    detail: r.summary,
                };
            }
            case 'earth-shop': {
                const { runEarthShopSession } = await import('./shop-buy');
                const r = await runEarthShopSession(s, cfg, isStopped);
                const ticksElapsed = Math.max(0, r.ticks);
                if (r.ok) {
                    return {
                        kind: 'target_met',
                        activityId,
                        account: session.name,
                        ticksElapsed,
                        durationMs: ms(),
                        unitsCompleted: r.boughtTotal,
                        coinsDelta: r.seedCredit - r.spentTotal,
                        itemsDelta: { [EARTH_RUNE]: r.boughtTotal - r.seeded },
                    };
                }
                if (!r.conserved || !r.quiescent) {
                    return { kind: 'session_unsettled', activityId, account: session.name, ticksElapsed, durationMs: ms(), reason: r.stop, detail: r.failure };
                }
                if (r.stop === 'coins') {
                    return {
                        kind: 'missing_supply',
                        activityId,
                        account: session.name,
                        ticksElapsed,
                        durationMs: ms(),
                        missing: [{ itemId: COINS, required: Math.max(1, cfg.reserve + 1), available: r.finalCoins }],
                        summary: r.failure,
                    };
                }
                if (isStopped()) {
                    return { kind: 'session_unsettled', activityId, account: session.name, ticksElapsed, durationMs: ms(), reason: r.stop || 'stopped', detail: r.failure || r.stop };
                }
                return {
                    kind: 'market_unavailable',
                    activityId,
                    account: session.name,
                    ticksElapsed,
                    durationMs: ms(),
                    itemId: EARTH_RUNE,
                    venue: `shop:${cfg.profile}`,
                    detail: r.failure || r.stop,
                };
            }
            case 'buy-sword': {
                const { runBuySwordSession } = await import('./shop-buy');
                const r = await runBuySwordSession(s, cfg, isStopped);
                const ticksElapsed = Math.max(0, r.ticks);
                const itemId = cfg.itemId ?? SWORD;
                if (r.ok) {
                    return {
                        kind: 'target_met',
                        activityId,
                        account: session.name,
                        ticksElapsed,
                        durationMs: ms(),
                        unitsCompleted: r.bought,
                        coinsDelta: -r.spent,
                        itemsDelta: { [itemId]: r.bought },
                    };
                }
                if (r.died) {
                    return { kind: 'death', activityId, account: session.name, ticksElapsed, durationMs: ms(), pos: currentPos(session), faultSignature: `${activityId}:death`, detail: r.failure };
                }
                if (isStopped() && !r.preserved) {
                    return { kind: 'session_unsettled', activityId, account: session.name, ticksElapsed, durationMs: ms(), reason: 'stopped', detail: r.failure };
                }
                if (isStopped()) {
                    return { kind: 'session_unsettled', activityId, account: session.name, ticksElapsed, durationMs: ms(), reason: 'stopped', detail: r.failure };
                }
                return classifyFailureOutcome(activityId, session.name, ticksElapsed, ms(), r.failure, currentPos(session), 'shop:varrock_sword', itemId);
            }
            case 'shop-trip':
            case 'shop-sell': {
                const { runShopTrip } = await import('./shop-sell');
                const job = cfg.job ?? readJsonFile<ShopTripJob>(cfg.jobFile ?? '', `${cfg.mode} job`);
                const r = await runShopTrip(s, job, isStopped);
                const ticksElapsed = Math.max(0, r.ticks ?? elapsed());
                if (r.ok) {
                    return {
                        kind: 'target_met',
                        activityId,
                        account: session.name,
                        ticksElapsed,
                        durationMs: ms(),
                        unitsCompleted: r.completed,
                    };
                }
                if (r.recoveryDeferred || isStopped()) {
                    return { kind: 'session_unsettled', activityId, account: session.name, ticksElapsed, durationMs: ms(), reason: r.recoveryDeferred ? 'recovery_deferred' : 'stopped', detail: r.failure };
                }
                return classifyFailureOutcome(activityId, session.name, ticksElapsed, ms(), r.failure || 'shop-trip failed', currentPos(session), `shop:${job.merchant}`, job.item);
            }
            case 'ge-buy': {
                const { runOwnedItem } = await import('./ge-buy');
                const now = Date.now();
                const request: ItemRequest = cfg.request ?? {
                    actor: session.name,
                    server,
                    goal: cfg.goal ?? 'market-ge-buy',
                    item: cfg.itemId ?? 0,
                    quantity: cfg.quantity ?? 1,
                    ...(cfg.expectedOwned !== undefined ? { expectedOwned: cfg.expectedOwned } : {}),
                    ...(cfg.rescueMode ? { rescueMode: cfg.rescueMode } : {}),
                    limit: cfg.limitPrice ?? 0,
                    reserve: cfg.cashReserve ?? 0,
                    createdAt: now,
                    reviewAt: now,
                    deadline: now + (cfg.orderMs ?? 60_000),
                };
                const paths = orderPaths(request.server, request.actor, request.goal);
                const r = await runOwnedItem(s, request, paths.journal, isStopped, cfg.cancel === true, cfg.fillWaitTicks ?? 40);
                const ticksElapsed = Math.max(0, r.ticks);
                if (r.ok) {
                    return {
                        kind: 'target_met',
                        activityId,
                        account: session.name,
                        ticksElapsed,
                        durationMs: ms(),
                        unitsCompleted: r.acquired,
                        coinsDelta: r.cashDeltaThisSession,
                        itemsDelta: { [request.item]: r.newItemsThisSession },
                    };
                }
                if (r.died) {
                    return { kind: 'death', activityId, account: session.name, ticksElapsed, durationMs: ms(), pos: currentPos(session), faultSignature: `${activityId}:death`, detail: r.failure };
                }
                if (r.outcomeUnresolved || isStopped()) {
                    return { kind: 'session_unsettled', activityId, account: session.name, ticksElapsed, durationMs: ms(), reason: r.outcomeUnresolved ? r.phase : 'stopped', detail: r.failure };
                }
                if (r.pending || !r.targetMet) {
                    return { kind: 'market_unavailable', activityId, account: session.name, ticksElapsed, durationMs: ms(), itemId: request.item, venue: 'ge', detail: r.failure };
                }
                return classifyFailureOutcome(activityId, session.name, ticksElapsed, ms(), r.failure, currentPos(session), 'ge', request.item);
            }
            case 'ge-sell': {
                const { runBankBidSale, runOwnedSale } = await import('./ge-sell');
                const request: SaleRequest = cfg.request ?? {
                    actor: session.name,
                    server,
                    goal: cfg.goal ?? 'market-ge-sell',
                    item: cfg.itemId ?? 0,
                    quantity: cfg.quantity ?? 0,
                    price: cfg.sellPrice ?? 0,
                    floor: cfg.floorPrice ?? cfg.sellPrice ?? 0,
                    reserveItems: cfg.reserveItems ?? 0,
                    deadline: Date.now() + (cfg.orderMs ?? 60_000),
                };
                const paths = orderPaths(request.server, request.actor, 'sell-' + request.goal);
                const run = cfg.fromBank ? runBankBidSale : runOwnedSale;
                const r = await run(
                    s,
                    request,
                    paths.journal,
                    isStopped,
                    cfg.fillWaitTicks ?? 40,
                    cfg.cancel === true,
                    cfg.fromBank ? { bankCoins: cfg.bankCoins } : {},
                );
                if (r.ok) {
                    return {
                        kind: 'target_met',
                        activityId,
                        account: session.name,
                        ticksElapsed: elapsed(),
                        durationMs: ms(),
                        unitsCompleted: r.journal?.progress?.filled ?? 0,
                    };
                }
                if (isStopped()) {
                    return { kind: 'session_unsettled', activityId, account: session.name, ticksElapsed: elapsed(), durationMs: ms(), reason: 'stopped', detail: r.error ?? 'ge-sell stopped' };
                }
                return classifyFailureOutcome(activityId, session.name, elapsed(), ms(), r.error ?? 'ge-sell incomplete', currentPos(session), 'ge', request.item);
            }
            case 'ge-buy-list': {
                const { runBuyList } = await import('./ge-bulk');
                const request = cfg.request ?? readJsonFile<BuyListRequest>(cfg.requestFile ?? '', 'ge-buy-list request');
                const r = await runBuyList(s, request, isStopped);
                if (r.ok) {
                    const bought = (r.outcomes ?? []).reduce((n, o) => n + (o?.acquired ?? 0), 0);
                    return { kind: 'target_met', activityId, account: session.name, ticksElapsed: elapsed(), durationMs: ms(), unitsCompleted: bought };
                }
                if (isStopped()) {
                    return { kind: 'session_unsettled', activityId, account: session.name, ticksElapsed: elapsed(), durationMs: ms(), reason: 'stopped', detail: r.failure || 'ge-buy-list stopped' };
                }
                return classifyFailureOutcome(activityId, session.name, elapsed(), ms(), r.failure || 'ge-buy-list failed', currentPos(session), 'ge');
            }
            case 'ge-trip': {
                const { runGETrip } = await import('./ge-bulk');
                const request = cfg.request ?? readJsonFile<GETripRequest>(cfg.requestFile ?? '', 'ge-trip request');
                const r = await runGETrip(s, request, isStopped);
                if (r.ok) {
                    return {
                        kind: 'target_met',
                        activityId,
                        account: session.name,
                        ticksElapsed: elapsed(),
                        durationMs: ms(),
                        unitsCompleted: r.filled ?? 0,
                        coinsDelta: r.net ?? 0,
                    };
                }
                if (isStopped()) {
                    return { kind: 'session_unsettled', activityId, account: session.name, ticksElapsed: elapsed(), durationMs: ms(), reason: 'stopped', detail: r.failure || 'ge-trip stopped' };
                }
                return classifyFailureOutcome(activityId, session.name, elapsed(), ms(), r.failure || 'ge-trip failed', currentPos(session), 'ge', request.item);
            }
            case 'ge-plan': {
                const { runGEPlan } = await import('./ge-bulk');
                const plan = cfg.plan ?? readJsonFile<GEPricePlan>(cfg.planFile ?? '', 'ge-plan');
                const r = await runGEPlan(s, plan, isStopped, {}, cfg.finish === true);
                if (r.ok) {
                    return {
                        kind: 'target_met',
                        activityId,
                        account: session.name,
                        ticksElapsed: elapsed(),
                        durationMs: ms(),
                    };
                }
                if (isStopped()) {
                    return { kind: 'session_unsettled', activityId, account: session.name, ticksElapsed: elapsed(), durationMs: ms(), reason: 'stopped', detail: r.failure || 'ge-plan stopped' };
                }
                return classifyFailureOutcome(activityId, session.name, elapsed(), ms(), r.failure || 'ge-plan resting or failed', currentPos(session), 'ge', plan.item);
            }
            case 'bank-seller': {
                const { runBankSeller } = await import('./ge-bulk');
                const policy = cfg.policy ?? readJsonFile<BankSellerPolicy>(cfg.policyFile ?? '', 'bank-seller policy');
                const r = await runBankSeller(s, policy, isStopped);
                if (r.ok) {
                    return {
                        kind: 'target_met',
                        activityId,
                        account: session.name,
                        ticksElapsed: elapsed(),
                        durationMs: ms(),
                        unitsCompleted: r.journal?.outcomes.reduce((n, o) => n + o.filled, 0) ?? 0,
                    };
                }
                if (isStopped()) {
                    return { kind: 'session_unsettled', activityId, account: session.name, ticksElapsed: elapsed(), durationMs: ms(), reason: 'stopped', detail: r.failure || 'bank-seller stopped' };
                }
                return classifyFailureOutcome(activityId, session.name, elapsed(), ms(), r.failure || 'bank-seller failed', currentPos(session), 'ge');
            }
            case 'shop-to-bid': {
                const { runShopToBid } = await import('./ge-bulk');
                const r = await runShopToBid(s, server, cfg, isStopped);
                if (r.ok) {
                    return {
                        kind: 'target_met',
                        activityId,
                        account: session.name,
                        ticksElapsed: elapsed(),
                        durationMs: ms(),
                        unitsCompleted: r.done,
                        coinsDelta: r.total,
                        summary: r.summary,
                    };
                }
                if (isStopped()) {
                    return { kind: 'session_unsettled', activityId, account: session.name, ticksElapsed: elapsed(), durationMs: ms(), reason: 'stopped', detail: r.summary };
                }
                return { kind: 'market_unavailable', activityId, account: session.name, ticksElapsed: elapsed(), durationMs: ms(), itemId: cfg.itemIds[0] ?? 0, venue: `shop:${cfg.profiles[0] ?? ''}`, detail: r.summary };
            }
        }
    } catch (error) {
        await Promise.resolve();
        if (isStopped()) {
            return { kind: 'session_unsettled', activityId, account: session.name, ticksElapsed: elapsed(), durationMs: ms(), reason: 'stopped', detail: String(error) };
        }
        return classifyFailureOutcome(activityId, session.name, elapsed(), ms(), String(error), currentPos(session), 'market');
    }
}

export const marketModule: WorkerModule<MarketConfig> = {
    id: 'market',
    family: 'market',
    kind: 'shop',
    trust: 'practice_passed',
    protectedAllowed: false,
    preflight: preflightMarket,
    estimate: estimateMarket,
    run: runMarketWorker,
};
