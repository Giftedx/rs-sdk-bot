// Unified AcquireItem resolver evaluating:
// Own Bank -> NPC Shop -> GE -> Stationed Hub Banker -> Craft/Gather
// Preserves an operating coin float (~1,000 gp) per active account and respects (item, venue) TTL cooldowns.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { marketQuotes as parseMarketCacheQuotes } from '../../core/src/market-cache';
import { offMap as isEntranaTile } from '../../core/src/shop-index';
import type { Shop } from '../../knowledge/src/shops';
import type { GearSources } from '../../knowledge/src/gear-sources';
import {
    accountOwnedItemCount,
} from '../../workers/src/contracts';
import { derivedProfile } from '../../workers/src/market/shop-profiles';
import { PROFILES } from '../../workers/src/market/preflight';
import {
    ACQUIRE_SOURCE_ORDER,
    DEFAULT_OPERATING_COIN_FLOAT,
    HUB_BANKER_LOCATIONS,
    isCooldownActive,
    isProtectedAccountName,
    marketCooldownKey,
    type AccountState,
    type AcquireSourceKind,
    type AcquireStep,
    type ActivityDefinition,
    type HubBankId,
    type WorldSnapshot,
} from './contracts';
import {
    COINS_ITEM_ID,
    SHOP_GATES,
    activityPreflightFromConfig,
    availableSpendableCoins,
    availableStockAfterReserves,
    cachedAccountSkillLevel,
    cachedAvailableSpendableCoins,
    cachedEffectiveItemReserve,
    cachedHasCompletedQuest,
    evaluateTileReachability,
    loadItemsMap,
    type AccountLookupCache,
    type ItemMeta,
} from './preflight';
import { readJsonStatCached } from './json-cache';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');
const GE_TILE = { x: 3164, z: 3487, level: 0 } as const;
const EMPTY_SHOPS: readonly ShopCatalogEntry[] = [];
const EMPTY_DONORS: readonly AccountState[] = [];
export const DEFAULT_ANTI_PING_PONG_MS = 10 * 60_000;
export const GE_LIMIT_BUFFER = 1.15;
export const DEFAULT_MAX_GE_ASK_FLOOR_GP = 25_000;

export function isValidGeAskQuote(
    quote: MarketQuote | undefined,
    baseCost: number,
    minSell = 1,
): quote is MarketQuote & { ask: number } {
    const requiredSell = Math.max(1, minSell);
    if (!quote || quote.ask === null || quote.ask <= 0 || quote.sell < requiredSell || quote.trades === 0) {
        return false;
    }
    const safeBase = Math.max(1, baseCost);
    const maxAsk = Math.max(DEFAULT_MAX_GE_ASK_FLOOR_GP, safeBase * 10);
    return quote.ask >= 0.2 * safeBase && quote.ask <= maxAsk;
}

export interface MarketQuote {
    readonly ask: number | null;
    readonly sell: number;
    readonly trades?: number;
}

export type MarketQuotesMap = Readonly<Record<number, MarketQuote | undefined>>;

export interface ShopCatalogEntry {
    readonly shop: string;
    readonly itemId: number;
    readonly stock: number;
    readonly restockTicks: number | null;
    readonly cost: number;
    readonly tile?: { readonly x: number; readonly z: number; readonly level: number };
    readonly requiresQuest?: string;
    readonly requiresSkill?: { readonly skill: string; readonly level: number };
    readonly requiresQuestPoints?: number;
}

export interface AcquireRequest {
    readonly itemId: number;
    readonly itemName?: string;
    readonly quantity: number;
    readonly operatingCoinFloat?: number;
    readonly committedCoinSpend?: number;
    readonly questPoints?: number;
    readonly allowOwnBank?: boolean;
    readonly includeInventoryInOwned?: boolean;
    readonly allowedSources?: readonly AcquireSourceKind[];
    readonly maxUnitPrice?: number;
    readonly allowPartial?: boolean;
}

export interface AcquireContext {
    readonly world: WorldSnapshot;
    readonly activities?: readonly ActivityDefinition[];
    readonly marketQuotes?: MarketQuotesMap;
    readonly requireMarketQuote?: boolean;
    readonly customShops?: readonly ShopCatalogEntry[];
    readonly donorDemandItemIds?: ReadonlyMap<string, ReadonlySet<number>>;
    readonly recentReceivedAt?: ReadonlyMap<string, number>;
    readonly antiPingPongWindowMs?: number;
    readonly confirmedLogoutAt?: ReadonlyMap<string, number>;
    readonly requireConfirmedLogoutForTransfer?: boolean;
    readonly stationedHubBankers?: Readonly<Partial<Record<HubBankId, string>>>;
    readonly excludedDonorAccounts?: ReadonlySet<string>;
    readonly excludedSources?: ReadonlySet<AcquireSourceKind>;
    readonly excludedMarketVenues?: ReadonlySet<string>;
    readonly _cachedByOutputItem?: Pick<ReadonlyMap<number, readonly ActivityDefinition[]>, 'get'>;
    readonly _sortedIdleDonors?: readonly AccountState[];
    readonly _idleDonorsByItemId?: ReadonlyMap<number, readonly AccountState[]>;
    readonly _acctCache?: AccountLookupCache;
    readonly _skipDiagnostics?: boolean;
}

export interface AcquireCandidate {
    readonly step: AcquireStep;
    readonly source: AcquireSourceKind;
}

export interface AcquireResolution {
    readonly ok: boolean;
    readonly step: AcquireStep | null;
    readonly candidates: readonly AcquireCandidate[];
    readonly skippedReasons: readonly { readonly source: AcquireSourceKind; readonly reason: string }[];
}

const PROFILE_GATES: Readonly<Record<string, { readonly requiresQuest?: string; readonly requiresSkill?: { readonly skill: string; readonly level: number }; readonly requiresQuestPoints?: number }>> = {
    oziach: SHOP_GATES.runeplateshop!,
    scavvo: SHOP_GATES.championshop!,
    valaine: SHOP_GATES.championshop!,
    skulgrimen: SHOP_GATES.viking_weapons_shop!,
    siegfried: SHOP_GATES.legendsguildshop!,
    helemos: SHOP_GATES.dragonaxeshop!,
    jukat: SHOP_GATES.dragonswordshop!,
    jukat_dagger: SHOP_GATES.dragonswordshop!,
    tenzing: { requiresQuest: 'Death Plateau' },
};

let cachedShopIndex: Map<number, ShopCatalogEntry[]> | undefined;

export function loadShopCatalogByItem(): ReadonlyMap<number, readonly ShopCatalogEntry[]> {
    if (cachedShopIndex) return cachedShopIndex;
    const items = loadItemsMap();
    const byDebug = new Map<string, ItemMeta>();
    for (const meta of items.values()) {
        byDebug.set(meta.debugname, meta);
    }
    const shops = readJsonStatCached<Shop[]>(resolve(REPO_ROOT, 'knowledge', 'shops.json')) ?? [];
    const sources = readJsonStatCached<GearSources>(resolve(REPO_ROOT, 'knowledge', 'gear-sources.json')) ?? { shopNpcs: [], npc: [], quest: [], clue: [] };
    const shopTiles = new Map<string, { x: number; z: number; level: number }>();
    for (const row of sources.shopNpcs) {
        const nonEntrana = row.spawns.find((t) => !isEntranaTile(t));
        if (nonEntrana && !shopTiles.has(row.shop)) {
            shopTiles.set(row.shop, nonEntrana);
        }
    }

    const out = new Map<number, ShopCatalogEntry[]>();
    const addEntry = (entry: ShopCatalogEntry) => {
        const list = out.get(entry.itemId);
        if (list) list.push(entry);
        else out.set(entry.itemId, [entry]);
    };

    for (const shop of shops) {
        if (/^(skill_guide_|smithing_|crafting_make_)|_free$/.test(shop.inv)) continue;
        if (!derivedProfile(shop.inv)) continue;
        const gate = SHOP_GATES[shop.inv];
        const tile = shopTiles.get(shop.inv);
        for (const row of shop.stock) {
            if (row.count <= 0) continue;
            const meta = byDebug.get(row.item);
            if (!meta) continue;
            addEntry({
                shop: shop.inv,
                itemId: meta.id,
                stock: row.count,
                restockTicks: row.restockTicks,
                cost: Math.max(1, meta.cost),
                ...(tile ? { tile } : {}),
                ...(gate ?? {}),
            });
        }
    }

    // Also index explicit verified PROFILES (e.g. zaff/Staff of air, jiminua/Antipoison(3))
    // whose shops lack gear-sources spawns or exceed DATA_BANK_RANGE in derivedProfile.
    const ordinaryShops = shops.filter((s) => !/^(skill_guide_|smithing_|crafting_make_)|_free$/.test(s.inv));
    for (const [profileKey, profile] of Object.entries(PROFILES)) {
        if (profile.realm || profile.dialogBuy) continue;
        const level = profile.npcSpot.level ?? 0;
        const tile = { x: profile.npcSpot.x, z: profile.npcSpot.z, level };
        // Match profile against shops.json rows whose NPC matches or whose stock covers all profile items.
        const matchingShops = ordinaryShops.filter((s) => {
            const npcs = sources.shopNpcs.filter((n) => n.shop === s.inv).map((n) => n.npc.replace(/_/g, ' '));
            const npcMatch = npcs.some((n) => profile.npc.test(n));
            if (npcMatch) return true;
            return profile.items.every((pi) =>
                s.stock.some((row) => {
                    const meta = byDebug.get(row.item);
                    return meta ? pi.re.test(meta.name) : false;
                }),
            );
        });
        const gate = PROFILE_GATES[profileKey]
            ?? (matchingShops.length === 1 ? SHOP_GATES[matchingShops[0]!.inv] : undefined)
            ?? (profile.need ? { requiresSkill: profile.need } : undefined);
        const mergedGate = gate && profile.need && !gate.requiresSkill ? { ...gate, requiresSkill: profile.need } : gate;

        for (const itemRule of profile.items) {
            let matchedMeta: ItemMeta | undefined;
            let matchedStock = itemRule.shelf ?? 5;
            let matchedRestock: number | null = 100;
            for (const s of matchingShops) {
                const row = s.stock.find((r) => {
                    if (r.count <= 0) return false;
                    const meta = byDebug.get(r.item);
                    return meta ? itemRule.re.test(meta.name) : false;
                });
                if (row) {
                    matchedMeta = byDebug.get(row.item);
                    matchedStock = row.count;
                    matchedRestock = row.restockTicks;
                    break;
                }
            }
            if (!matchedMeta) continue;
            const existing = out.get(matchedMeta.id) ?? [];
            const alreadyAtTile = existing.some(
                (e) =>
                    e.shop === profileKey
                    || (e.tile
                        && e.tile.level === tile.level
                        && Math.max(Math.abs(e.tile.x - tile.x), Math.abs(e.tile.z - tile.z)) <= 2),
            );
            if (alreadyAtTile) continue;
            addEntry({
                shop: profileKey,
                itemId: matchedMeta.id,
                stock: matchedStock,
                restockTicks: matchedRestock,
                cost: Math.max(1, matchedMeta.cost),
                tile,
                ...(mergedGate ?? {}),
            });
        }
    }

    cachedShopIndex = out;
    return out;
}

export function loadMarketQuotesFromRoot(root: string, now = Date.now()): MarketQuotesMap {
    const candidates = [
        join(root, '.practice', 'live', 'market-all.json'),
        join(root, '.practice', 'market-all.json'),
    ];
    for (const file of candidates) {
        if (!existsSync(file)) continue;
        try {
            const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
                at?: unknown;
                items?: unknown;
                marketQuotes?: MarketQuotesMap;
                quotes?: MarketQuotesMap;
            };
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
            if ('items' in parsed && 'at' in parsed) {
                return parseMarketCacheQuotes(parsed, now);
            }
            const raw = parsed.marketQuotes ?? parsed.quotes ?? (parsed as unknown as MarketQuotesMap);
            if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
        } catch {
            /* ignore unreadable market cache */
        }
    }
    return {};
}

function isVenueOnCooldown(
    acct: AccountState,
    world: WorldSnapshot,
    itemId: number,
    venue1: string,
    venue2?: string,
): boolean {
    if (!acct.cooldowns && !world.marketCooldowns) return false;
    const key1 = marketCooldownKey(itemId, venue1);
    if (isCooldownActive(acct.cooldowns, key1, world.at) || isCooldownActive(world.marketCooldowns, key1, world.at)) {
        return true;
    }
    if (venue2 !== undefined) {
        const key2 = marketCooldownKey(itemId, venue2);
        if (isCooldownActive(acct.cooldowns, key2, world.at) || isCooldownActive(world.marketCooldowns, key2, world.at)) {
            return true;
        }
    }
    return false;
}

function nearestHub(pos: AccountState['pos'], fallback?: HubBankId): HubBankId {
    if (!pos) return fallback ?? 'varrock_west';
    let bestHub: HubBankId = fallback ?? 'varrock_west';
    let bestDist = Infinity;
    for (const [id, spec] of Object.entries(HUB_BANKER_LOCATIONS) as [HubBankId, (typeof HUB_BANKER_LOCATIONS)[HubBankId]][]) {
        const d = Math.max(Math.abs(pos.x - spec.bankTile.x), Math.abs(pos.z - spec.bankTile.z))
            + Math.abs(pos.level - spec.bankTile.level) * 100;
        if (d < bestDist) {
            bestDist = d;
            bestHub = id;
        }
    }
    return bestHub;
}

function shopIsAccessible(
    acct: AccountState,
    shop: ShopCatalogEntry,
    questPoints = 0,
    acctCache?: AccountLookupCache,
): boolean {
    if (shop.requiresQuest && !cachedHasCompletedQuest(acct, shop.requiresQuest, acctCache)) return false;
    if (shop.requiresSkill && cachedAccountSkillLevel(acct, shop.requiresSkill.skill, acctCache) < shop.requiresSkill.level) return false;
    if (shop.requiresQuestPoints && questPoints < shop.requiresQuestPoints) return false;
    return true;
}

export function resolveAcquireItem(
    acct: AccountState,
    req: AcquireRequest,
    ctx: AcquireContext,
): AcquireResolution {
    if (!Number.isSafeInteger(req.itemId) || req.itemId < 0 || !Number.isSafeInteger(req.quantity) || req.quantity < 1) {
        return {
            ok: false,
            step: null,
            candidates: [],
            skippedReasons: [{ source: 'own_bank', reason: 'invalid acquire itemId or quantity' }],
        };
    }

    const { world } = ctx;
    const acctCache = ctx._acctCache;
    const skipDiag = ctx._skipDiagnostics === true;
    const itemMeta = loadItemsMap().get(req.itemId);
    const itemName = req.itemName ?? itemMeta?.name;
    const operatingFloat = Math.max(0, req.operatingCoinFloat ?? DEFAULT_OPERATING_COIN_FLOAT);
    const committedSpend = Math.max(0, req.committedCoinSpend ?? 0);
    const coinBalance = cachedAvailableSpendableCoins(
        acct,
        world,
        operatingFloat + committedSpend,
        { includeBank: true, requireTrustedBank: true },
        acctCache,
    );
    const effectiveTotalUnreserved = Math.max(0, coinBalance.totalUnreserved - committedSpend);
    const coinFloatPreserved = Math.min(effectiveTotalUnreserved, operatingFloat);
    const allowedSources = req.allowedSources;
    const candidates: AcquireCandidate[] = [];
    const skippedReasons: { source: AcquireSourceKind; reason: string }[] = [];

    for (const source of ACQUIRE_SOURCE_ORDER) {
        if (allowedSources !== undefined && !allowedSources.includes(source)) {
            if (!skipDiag) skippedReasons.push({ source, reason: 'source excluded by request' });
            continue;
        }
        if (ctx.excludedSources?.has(source)) {
            if (!skipDiag) skippedReasons.push({ source, reason: 'source excluded by context' });
            continue;
        }

        if (source === 'own_bank') {
            if (req.allowOwnBank === false) {
                if (!skipDiag) skippedReasons.push({ source, reason: 'own_bank disabled by caller' });
                continue;
            }
            if (isVenueOnCooldown(acct, world, req.itemId, 'own_bank')) {
                if (!skipDiag) skippedReasons.push({ source, reason: 'own_bank cooldown active' });
                continue;
            }
            const includeInv = req.includeInventoryInOwned ?? true;
            let ownedUnreserved: number;
            let invEqAvailable = 0;
            let reserve = 0;
            if (req.itemId === COINS_ITEM_ID) {
                const excludedInv = includeInv ? 0 : accountOwnedItemCount(acct, COINS_ITEM_ID, { includeBank: false });
                ownedUnreserved = Math.max(0, coinBalance.spendable - excludedInv);
            } else {
                const bankAvailable = acct.bank.trusted ? (acct.bank.items[req.itemId] ?? 0) : 0;
                invEqAvailable = includeInv
                    ? accountOwnedItemCount(acct, req.itemId, { includeBank: false })
                    : 0;
                reserve = cachedEffectiveItemReserve(acct, world, req.itemId, acctCache);
                ownedUnreserved = Math.max(0, invEqAvailable + bankAvailable - reserve);
            }
            if (ownedUnreserved < req.quantity) {
                if (!skipDiag) {
                    const reason = !acct.bank.trusted
                        ? req.itemId === COINS_ITEM_ID
                            ? `own bank untrusted (spendable=${ownedUnreserved}, need=${req.quantity})`
                            : `own bank untrusted (inv/eq unreserved=${Math.max(0, invEqAvailable - reserve)}, need=${req.quantity})`
                        : `own unreserved stock ${ownedUnreserved} < needed ${req.quantity}`;
                    skippedReasons.push({ source, reason });
                }
                continue;
            }
            const step: AcquireStep = {
                stepKind: 'acquire',
                source: 'own_bank',
                itemId: req.itemId,
                ...(itemName ? { itemName } : {}),
                quantity: req.quantity,
                estimatedTicks: 15,
                estimatedCoinCost: 0,
                coinFloatPreserved,
                venueKey: marketCooldownKey(req.itemId, 'own_bank'),
            };
            candidates.push({ step, source });
            continue;
        }

        if (source === 'npc_shop') {
            if (req.itemId === COINS_ITEM_ID) {
                if (!skipDiag) skippedReasons.push({ source, reason: 'coins cannot be bought from npc_shop' });
                continue;
            }
            if (isVenueOnCooldown(acct, world, req.itemId, 'npc_shop', 'shop')) {
                if (!skipDiag) skippedReasons.push({ source, reason: 'npc_shop cooldown active' });
                continue;
            }
            const catalogShops = loadShopCatalogByItem().get(req.itemId) ?? EMPTY_SHOPS;
            let shops: readonly ShopCatalogEntry[];
            if (ctx.customShops && ctx.customShops.length > 0) {
                const custom = ctx.customShops.filter((s) => s.itemId === req.itemId);
                shops = custom.length > 0 ? [...custom, ...catalogShops] : catalogShops;
            } else {
                shops = catalogShops;
            }
            if (shops.length === 0) {
                if (!skipDiag) skippedReasons.push({ source, reason: 'no NPC shop stocks item' });
                continue;
            }

            let bestShopStep: AcquireStep | null = null;
            let shopRejectReason = 'no accessible NPC shop';
            const hasCooldownMaps = Boolean(acct.cooldowns || world.marketCooldowns);
            for (const shop of shops) {
                const shopVenueKey = marketCooldownKey(req.itemId, `shop:${shop.shop}`);
                if (ctx.excludedMarketVenues?.has(shopVenueKey)) {
                    if (!skipDiag) shopRejectReason = `shop:${shop.shop} already allocated`;
                    continue;
                }
                if (hasCooldownMaps && isVenueOnCooldown(acct, world, req.itemId, `shop:${shop.shop}`, shop.shop)) {
                    if (!skipDiag) shopRejectReason = `shop:${shop.shop} on cooldown`;
                    continue;
                }
                if (!shopIsAccessible(acct, shop, req.questPoints ?? 0, acctCache)) {
                    if (!skipDiag) shopRejectReason = `shop ${shop.shop} locked by quest/skill gate`;
                    continue;
                }
                if (req.maxUnitPrice !== undefined && shop.cost > req.maxUnitPrice) {
                    if (!skipDiag) shopRejectReason = `shop ${shop.shop} price ${shop.cost} > maxUnitPrice ${req.maxUnitPrice}`;
                    continue;
                }
                const totalCost = Math.ceil(shop.cost * req.quantity);
                // Early reject when base spendable coins cannot cover shop cost before reachability.
                if (coinBalance.spendable < totalCost) {
                    if (!skipDiag) shopRejectReason = `insufficient spendable coins ${coinBalance.spendable} (after ${operatingFloat} gp float) for cost ${totalCost}`;
                    continue;
                }
                let travelTicks = 40;
                let travelCoins = 0;
                if (shop.tile) {
                    const reach = evaluateTileReachability(acct, shop.tile, world, {
                        spendableCoins: effectiveTotalUnreserved,
                        allowUnknownPos: true,
                        _acctCache: acctCache,
                    });
                    if (!reach.reachable) {
                        if (!skipDiag) shopRejectReason = reach.message ?? `shop ${shop.shop} unreachable`;
                        continue;
                    }
                    travelTicks = reach.travelTicks;
                    travelCoins = reach.travelCoins;
                }
                // Spending must preserve the operating coin float (~1,000 gp) for ferry fares.
                if (effectiveTotalUnreserved < totalCost + travelCoins) {
                    if (!skipDiag) shopRejectReason = `insufficient spendable coins ${coinBalance.spendable} (after ${operatingFloat} gp float) for cost ${totalCost}`;
                    continue;
                }
                const restockCycles = Math.max(0, Math.ceil(req.quantity / Math.max(1, shop.stock)) - 1);
                const restockWait = restockCycles * Math.max(5, shop.restockTicks ?? 30);
                const buyTicks = Math.max(10, travelTicks + Math.ceil(req.quantity / 10) + restockWait + 15);
                if (!bestShopStep || totalCost < bestShopStep.estimatedCoinCost
                    || (totalCost === bestShopStep.estimatedCoinCost && buyTicks < bestShopStep.estimatedTicks)) {
                    bestShopStep = {
                        stepKind: 'acquire',
                        source: 'npc_shop',
                        itemId: req.itemId,
                        ...(itemName ? { itemName } : {}),
                        quantity: req.quantity,
                        estimatedTicks: buyTicks,
                        estimatedCoinCost: totalCost,
                        coinFloatPreserved: operatingFloat,
                        shopId: shop.shop,
                        venueKey: marketCooldownKey(req.itemId, `shop:${shop.shop}`),
                    };
                }
            }
            if (bestShopStep) candidates.push({ step: bestShopStep, source });
            else if (!skipDiag) skippedReasons.push({ source, reason: shopRejectReason });
            continue;
        }

        if (source === 'ge') {
            if (req.itemId === COINS_ITEM_ID) {
                if (!skipDiag) skippedReasons.push({ source, reason: 'coins cannot be bought on GE' });
                continue;
            }
            if (itemMeta && !itemMeta.tradeable) {
                if (!skipDiag) skippedReasons.push({ source, reason: 'item is untradeable' });
                continue;
            }
            if (ctx.excludedMarketVenues?.has(marketCooldownKey(req.itemId, 'ge'))) {
                if (!skipDiag) skippedReasons.push({ source, reason: 'ge venue already allocated' });
                continue;
            }
            if (isVenueOnCooldown(acct, world, req.itemId, 'ge')) {
                if (!skipDiag) skippedReasons.push({ source, reason: 'ge venue cooldown active' });
                continue;
            }
            let unitPrice: number | null = null;
            let geQty = req.quantity;
            if (ctx.marketQuotes) {
                const quote = ctx.marketQuotes[req.itemId];
                const baseCost = itemMeta?.cost ?? 1;
                const minSell = req.allowPartial === true ? 1 : req.quantity;
                if (isValidGeAskQuote(quote, baseCost, minSell)) {
                    unitPrice = Math.ceil(quote.ask);
                    if (req.allowPartial === true) {
                        geQty = Math.min(req.quantity, Math.floor(quote.sell));
                    }
                } else {
                    if (!skipDiag) skippedReasons.push({ source, reason: 'no valid GE ask quote in market cache' });
                    continue;
                }
            } else if (ctx.requireMarketQuote) {
                if (!skipDiag) skippedReasons.push({ source, reason: 'market quotes required but unavailable' });
                continue;
            } else {
                unitPrice = Math.max(1, itemMeta?.cost ?? 10);
            }

            if (req.maxUnitPrice !== undefined && unitPrice > req.maxUnitPrice) {
                if (!skipDiag) skippedReasons.push({ source, reason: `GE ask ${unitPrice} > maxUnitPrice ${req.maxUnitPrice}` });
                continue;
            }

            const totalCost = unitPrice * geQty;
            const bufferedCost = Math.ceil(unitPrice * GE_LIMIT_BUFFER) * geQty;
            if (coinBalance.spendable < bufferedCost) {
                if (!skipDiag) {
                    skippedReasons.push({
                        source,
                        reason: `insufficient spendable coins ${coinBalance.spendable} (preserving ${operatingFloat} gp float) for GE limit cost ${bufferedCost}`,
                    });
                }
                continue;
            }

            const reach = evaluateTileReachability(acct, GE_TILE, world, {
                spendableCoins: effectiveTotalUnreserved,
                allowUnknownPos: true,
                _acctCache: acctCache,
            });
            if (!reach.reachable) {
                if (!skipDiag) skippedReasons.push({ source, reason: reach.message ?? 'GE unreachable' });
                continue;
            }
            if (effectiveTotalUnreserved < bufferedCost + reach.travelCoins) {
                if (!skipDiag) skippedReasons.push({ source, reason: 'insufficient coins for GE limit cost plus travel fare' });
                continue;
            }
            candidates.push({
                step: {
                    stepKind: 'acquire',
                    source: 'ge',
                    itemId: req.itemId,
                    ...(itemName ? { itemName } : {}),
                    quantity: geQty,
                    estimatedTicks: Math.max(25, reach.travelTicks + 30),
                    estimatedCoinCost: totalCost,
                    coinFloatPreserved: operatingFloat,
                    venueKey: marketCooldownKey(req.itemId, 'ge'),
                },
                source,
            });
            continue;
        }

        if (source === 'hub_banker') {
            if (itemMeta && !itemMeta.tradeable && req.itemId !== COINS_ITEM_ID) {
                if (!skipDiag) skippedReasons.push({ source, reason: 'untradeable item cannot transfer via hub_banker' });
                continue;
            }
            if (acct.protectedClock || isProtectedAccountName(acct.name)) {
                if (!skipDiag) skippedReasons.push({ source, reason: 'protectedClock account cannot participate in automated hub_banker trade' });
                continue;
            }
            if (isVenueOnCooldown(acct, world, req.itemId, 'hub_banker', 'hub')) {
                if (!skipDiag) skippedReasons.push({ source, reason: 'hub_banker cooldown active' });
                continue;
            }
            const antiWindow = ctx.antiPingPongWindowMs ?? DEFAULT_ANTI_PING_PONG_MS;
            const acctLower = acct.name.toLowerCase();
            if (ctx.requireConfirmedLogoutForTransfer && (ctx.confirmedLogoutAt?.get(acctLower) ?? 0) <= 0) {
                if (!skipDiag) skippedReasons.push({ source, reason: 'both parties require confirmed logout proof' });
                continue;
            }
            let bestDonorStep: AcquireStep | null = null;
            let rejectReason = 'no eligible idle donor with surplus stock';
            const donors = ctx._idleDonorsByItemId
                ? (ctx._idleDonorsByItemId.get(req.itemId) ?? EMPTY_DONORS)
                : (ctx._sortedIdleDonors ?? Object.values(world.accounts).sort((a, b) => a.name.localeCompare(b.name)));
            const hasCooldownMaps = Boolean(acct.cooldowns || world.marketCooldowns);
            let reachRecipByHub: Map<HubBankId, ReturnType<typeof evaluateTileReachability>> | undefined;
            for (const donor of donors) {
                const donorLower = donor.name.toLowerCase();
                if (donorLower === acctLower) continue;
                if (ctx.excludedDonorAccounts?.has(donorLower)) {
                    if (!skipDiag) rejectReason = `donor ${donor.name} already assigned this cycle`;
                    continue;
                }
                if (donor.protectedClock || isProtectedAccountName(donor.name)) continue;
                if (donor.lifecycle !== 'idle') {
                    if (!skipDiag) rejectReason = `donor ${donor.name} lifecycle=${donor.lifecycle}`;
                    continue;
                }
                if (!donor.bank.trusted) {
                    if (!skipDiag) rejectReason = `donor ${donor.name} bank untrusted`;
                    continue;
                }
                if (ctx.requireConfirmedLogoutForTransfer) {
                    const donorLogout = ctx.confirmedLogoutAt?.get(donorLower) ?? 0;
                    if (donorLogout <= 0) {
                        if (!skipDiag) rejectReason = 'both parties require confirmed logout proof';
                        continue;
                    }
                }
                if (ctx.donorDemandItemIds?.get(donorLower)?.has(req.itemId)) {
                    if (!skipDiag) rejectReason = `anti-ping-pong: donor ${donor.name} holds demand for item ${req.itemId}`;
                    continue;
                }
                const recentAt = ctx.recentReceivedAt?.get(`${donorLower}:${req.itemId}`);
                if (recentAt !== undefined && world.at - recentAt < antiWindow) {
                    if (!skipDiag) rejectReason = `anti-ping-pong: donor ${donor.name} recently received item ${req.itemId}`;
                    continue;
                }
                const stock = availableStockAfterReserves(donor, world, req.itemId, {
                    includeBank: true,
                    requireTrustedBank: true,
                });
                // Preserve operating coin float on the donor when transferring coins.
                const donorSurplus = req.itemId === COINS_ITEM_ID
                    ? availableSpendableCoins(donor, world, operatingFloat, { includeBank: true, requireTrustedBank: true }).spendable
                    : stock.available;
                const transferQty = req.allowPartial === true
                    ? Math.min(req.quantity, Math.floor(donorSurplus))
                    : req.quantity;
                if (transferQty <= 0 || (!req.allowPartial && donorSurplus < req.quantity)) {
                    continue;
                }
                const hub = nearestHub(acct.pos, donor.pos ? nearestHub(donor.pos) : 'varrock_west');
                if (hasCooldownMaps && isVenueOnCooldown(acct, world, req.itemId, `hub:${hub}:${donorLower}`, `hub:${hub}`)) {
                    if (!skipDiag) rejectReason = `hub:${hub}:${donorLower} on cooldown`;
                    continue;
                }
                const hubTile = HUB_BANKER_LOCATIONS[hub].bankTile;
                reachRecipByHub ??= new Map();
                let reachRecip = reachRecipByHub.get(hub);
                if (!reachRecip) {
                    reachRecip = evaluateTileReachability(acct, hubTile, world, {
                        spendableCoins: coinBalance.totalUnreserved,
                        allowUnknownPos: true,
                        _acctCache: acctCache,
                    });
                    reachRecipByHub.set(hub, reachRecip);
                }
                if (!reachRecip.reachable) {
                    if (!skipDiag) rejectReason = reachRecip.message ?? `recipient cannot reach ${hub}`;
                    continue;
                }
                const donorTotalUnreserved = world.world
                    ? availableSpendableCoins(donor, world, 0, { includeBank: true, requireTrustedBank: true }).totalUnreserved
                    : 0;
                const reachDonor = evaluateTileReachability(donor, hubTile, world, {
                    spendableCoins: donorTotalUnreserved,
                    allowUnknownPos: true,
                });
                if (!reachDonor.reachable) {
                    if (!skipDiag) rejectReason = reachDonor.message ?? `donor ${donor.name} cannot reach ${hub}`;
                    continue;
                }
                const sameSideBonus = donor.side === acct.side ? 0 : 120;
                const ticks = Math.max(45, reachRecip.travelTicks + reachDonor.travelTicks + 35 + sameSideBonus);
                const betterDonor = !bestDonorStep
                    || (req.allowPartial === true
                        ? transferQty > bestDonorStep.quantity
                            || (transferQty === bestDonorStep.quantity && ticks < bestDonorStep.estimatedTicks)
                        : ticks < bestDonorStep.estimatedTicks);
                if (betterDonor) {
                    bestDonorStep = {
                        stepKind: 'acquire',
                        source: 'hub_banker',
                        itemId: req.itemId,
                        ...(itemName ? { itemName } : {}),
                        quantity: transferQty,
                        estimatedTicks: ticks,
                        estimatedCoinCost: 0,
                        coinFloatPreserved,
                        donorAccount: donor.name,
                        hub,
                        venueKey: marketCooldownKey(req.itemId, `hub:${hub}:${donorLower}`),
                    };
                }
            }
            if (bestDonorStep) candidates.push({ step: bestDonorStep, source });
            else if (!skipDiag) skippedReasons.push({ source, reason: rejectReason });
            continue;
        }

        if (source === 'craft_gather') {
            if (isVenueOnCooldown(acct, world, req.itemId, 'craft_gather')) {
                if (!skipDiag) skippedReasons.push({ source, reason: 'craft_gather cooldown active' });
                continue;
            }
            const matching = ctx._cachedByOutputItem
                ? (ctx._cachedByOutputItem.get(req.itemId) ?? [])
                : (ctx.activities ?? []).filter((act) => {
                    if (act.trust === 'experimental') return false;
                    if (act.outputs?.some((o) => o.itemId === req.itemId && o.countPerUnit > 0)) return true;
                    const outPerUnit = act.baselineRate.outputsPerUnit?.[req.itemId] ?? 0;
                    return outPerUnit > 0;
                });
            if (matching.length === 0) {
                if (!skipDiag) skippedReasons.push({ source, reason: 'no non-experimental catalog activity produces item' });
                continue;
            }

            let bestActStep: AcquireStep | null = null;
            let rejectReason = 'no craft/gather activity passed preflight';
            const hasCooldownMaps = Boolean(acct.cooldowns || world.marketCooldowns);
            for (const act of matching) {
                if (act.trust === 'experimental') continue;
                if (hasCooldownMaps && isVenueOnCooldown(acct, world, req.itemId, `activity:${act.id}`)) {
                    if (!skipDiag) rejectReason = `activity ${act.id} on cooldown`;
                    continue;
                }
                const outSpec = act.outputs?.find((o) => o.itemId === req.itemId);
                const outPerUnit = outSpec?.countPerUnit ?? act.baselineRate.outputsPerUnit?.[req.itemId] ?? 1;
                const unitsNeeded = Math.max(act.baselineRate.minBatchUnits, Math.ceil(req.quantity / Math.max(0.01, outPerUnit)));
                const pre = activityPreflightFromConfig(acct, act, world, unitsNeeded, { _acctCache: acctCache });
                if (!pre.ok) {
                    if (!skipDiag) rejectReason = `${act.id} blocked: ${pre.blockers.map((b) => b.kind).join(',')}`;
                    continue;
                }
                const upt = Math.max(1e-4, act.baselineRate.unitsPerTick);
                const ticks = Math.max(
                    1,
                    Math.ceil(act.baselineRate.setupTicks + (pre.travelTicks ?? 0) + unitsNeeded / upt),
                );
                if (!bestActStep || ticks < bestActStep.estimatedTicks) {
                    bestActStep = {
                        stepKind: 'acquire',
                        source: 'craft_gather',
                        itemId: req.itemId,
                        ...(itemName ? { itemName } : {}),
                        quantity: req.quantity,
                        estimatedTicks: ticks,
                        estimatedCoinCost: pre.travelCoins ?? 0,
                        coinFloatPreserved,
                        activityId: act.id,
                        venueKey: marketCooldownKey(req.itemId, `activity:${act.id}`),
                    };
                }
            }
            if (bestActStep) candidates.push({ step: bestActStep, source });
            else if (!skipDiag) skippedReasons.push({ source, reason: rejectReason });
        }
    }

    const chosen = candidates[0]?.step ?? null;
    return {
        ok: chosen !== null,
        step: chosen,
        candidates,
        skippedReasons,
    };
}
