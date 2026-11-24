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
    accountSkillLevel,
    activityPreflightFromConfig,
    availableSpendableCoins,
    availableStockAfterReserves,
    evaluateTileReachability,
    hasCompletedQuest,
    loadItemsMap,
    type ItemMeta,
} from './preflight';
import { readJsonStatCached } from './json-cache';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');
export const DEFAULT_ANTI_PING_PONG_MS = 10 * 60_000;
export const GE_LIMIT_BUFFER = 1.15;
export const DEFAULT_MAX_GE_ASK_FLOOR_GP = 25_000;

export function isValidGeAskQuote(
    quote: MarketQuote | undefined,
    baseCost: number,
): quote is MarketQuote & { ask: number } {
    if (!quote || quote.ask === null || quote.ask <= 0 || quote.sell <= 0 || quote.trades === 0) {
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
    readonly _cachedByOutputItem?: Pick<ReadonlyMap<number, readonly ActivityDefinition[]>, 'get'>;
    readonly _sortedIdleDonors?: readonly AccountState[];
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
    for (const shop of shops) {
        if (/^(skill_guide_|smithing_|crafting_make_)|_free$/.test(shop.inv)) continue;
        if (!derivedProfile(shop.inv)) continue;
        const gate = SHOP_GATES[shop.inv];
        const tile = shopTiles.get(shop.inv);
        for (const row of shop.stock) {
            if (row.count <= 0) continue;
            const meta = byDebug.get(row.item);
            if (!meta) continue;
            const entry: ShopCatalogEntry = {
                shop: shop.inv,
                itemId: meta.id,
                stock: row.count,
                restockTicks: row.restockTicks,
                cost: Math.max(1, meta.cost),
                ...(tile ? { tile } : {}),
                ...(gate ?? {}),
            };
            const list = out.get(meta.id);
            if (list) list.push(entry);
            else out.set(meta.id, [entry]);
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
    venues: readonly string[],
): boolean {
    for (const venue of venues) {
        const key = marketCooldownKey(itemId, venue);
        if (isCooldownActive(acct.cooldowns, key, world.at) || isCooldownActive(world.marketCooldowns, key, world.at)) {
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
): boolean {
    if (shop.requiresQuest && !hasCompletedQuest(acct, shop.requiresQuest)) return false;
    if (shop.requiresSkill && accountSkillLevel(acct, shop.requiresSkill.skill) < shop.requiresSkill.level) return false;
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
    const itemMeta = loadItemsMap().get(req.itemId);
    const itemName = req.itemName ?? itemMeta?.name;
    const operatingFloat = Math.max(0, req.operatingCoinFloat ?? DEFAULT_OPERATING_COIN_FLOAT);
    const committedSpend = Math.max(0, req.committedCoinSpend ?? 0);
    const coinBalance = availableSpendableCoins(acct, world, operatingFloat + committedSpend, {
        includeBank: true,
        requireTrustedBank: true,
    });
    const effectiveTotalUnreserved = Math.max(0, coinBalance.totalUnreserved - committedSpend);
    const coinFloatPreserved = Math.min(effectiveTotalUnreserved, operatingFloat);
    const allowedSet = new Set(req.allowedSources ?? ACQUIRE_SOURCE_ORDER);
    const candidates: AcquireCandidate[] = [];
    const skippedReasons: { source: AcquireSourceKind; reason: string }[] = [];

    for (const source of ACQUIRE_SOURCE_ORDER) {
        if (!allowedSet.has(source)) {
            skippedReasons.push({ source, reason: 'source excluded by request' });
            continue;
        }
        if (ctx.excludedSources?.has(source)) {
            skippedReasons.push({ source, reason: 'source excluded by context' });
            continue;
        }

        if (source === 'own_bank') {
            if (req.allowOwnBank === false) {
                skippedReasons.push({ source, reason: 'own_bank disabled by caller' });
                continue;
            }
            if (isVenueOnCooldown(acct, world, req.itemId, ['own_bank'])) {
                skippedReasons.push({ source, reason: 'own_bank cooldown active' });
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
                reserve = availableStockAfterReserves(acct, world, req.itemId, {
                    includeBank: true,
                    requireTrustedBank: true,
                }).reserved;
                ownedUnreserved = Math.max(0, invEqAvailable + bankAvailable - reserve);
            }
            if (ownedUnreserved < req.quantity) {
                const reason = !acct.bank.trusted
                    ? req.itemId === COINS_ITEM_ID
                        ? `own bank untrusted (spendable=${ownedUnreserved}, need=${req.quantity})`
                        : `own bank untrusted (inv/eq unreserved=${Math.max(0, invEqAvailable - reserve)}, need=${req.quantity})`
                    : `own unreserved stock ${ownedUnreserved} < needed ${req.quantity}`;
                skippedReasons.push({ source, reason });
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
                skippedReasons.push({ source, reason: 'coins cannot be bought from npc_shop' });
                continue;
            }
            if (isVenueOnCooldown(acct, world, req.itemId, ['npc_shop', 'shop'])) {
                skippedReasons.push({ source, reason: 'npc_shop cooldown active' });
                continue;
            }
            const shops = [
                ...(ctx.customShops ?? []).filter((s) => s.itemId === req.itemId),
                ...(loadShopCatalogByItem().get(req.itemId) ?? []),
            ];
            if (shops.length === 0) {
                skippedReasons.push({ source, reason: 'no NPC shop stocks item' });
                continue;
            }

            let bestShopStep: AcquireStep | null = null;
            let shopRejectReason = 'no accessible NPC shop';
            for (const shop of shops) {
                if (isVenueOnCooldown(acct, world, req.itemId, [`shop:${shop.shop}`, shop.shop])) {
                    shopRejectReason = `shop:${shop.shop} on cooldown`;
                    continue;
                }
                if (!shopIsAccessible(acct, shop, req.questPoints ?? 0)) {
                    shopRejectReason = `shop ${shop.shop} locked by quest/skill gate`;
                    continue;
                }
                if (req.maxUnitPrice !== undefined && shop.cost > req.maxUnitPrice) {
                    shopRejectReason = `shop ${shop.shop} price ${shop.cost} > maxUnitPrice ${req.maxUnitPrice}`;
                    continue;
                }
                let travelTicks = 40;
                let travelCoins = 0;
                if (shop.tile) {
                    const reach = evaluateTileReachability(acct, shop.tile, world, {
                        spendableCoins: effectiveTotalUnreserved,
                        allowUnknownPos: true,
                    });
                    if (!reach.reachable) {
                        shopRejectReason = reach.message ?? `shop ${shop.shop} unreachable`;
                        continue;
                    }
                    travelTicks = reach.travelTicks;
                    travelCoins = reach.travelCoins;
                }
                const totalCost = Math.ceil(shop.cost * req.quantity);
                // Spending must preserve the operating coin float (~1,000 gp) for ferry fares.
                if (coinBalance.spendable < totalCost || effectiveTotalUnreserved < totalCost + travelCoins) {
                    shopRejectReason = `insufficient spendable coins ${coinBalance.spendable} (after ${operatingFloat} gp float) for cost ${totalCost}`;
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
            else skippedReasons.push({ source, reason: shopRejectReason });
            continue;
        }

        if (source === 'ge') {
            if (req.itemId === COINS_ITEM_ID) {
                skippedReasons.push({ source, reason: 'coins cannot be bought on GE' });
                continue;
            }
            if (itemMeta && !itemMeta.tradeable) {
                skippedReasons.push({ source, reason: 'item is untradeable' });
                continue;
            }
            if (isVenueOnCooldown(acct, world, req.itemId, ['ge'])) {
                skippedReasons.push({ source, reason: 'ge venue cooldown active' });
                continue;
            }
            let unitPrice: number | null = null;
            if (ctx.marketQuotes) {
                const quote = ctx.marketQuotes[req.itemId];
                const baseCost = itemMeta?.cost ?? 1;
                if (isValidGeAskQuote(quote, baseCost)) {
                    unitPrice = Math.ceil(quote.ask);
                } else {
                    skippedReasons.push({ source, reason: 'no valid GE ask quote in market cache' });
                    continue;
                }
            } else if (ctx.requireMarketQuote) {
                skippedReasons.push({ source, reason: 'market quotes required but unavailable' });
                continue;
            } else {
                unitPrice = Math.max(1, itemMeta?.cost ?? 10);
            }

            if (req.maxUnitPrice !== undefined && unitPrice > req.maxUnitPrice) {
                skippedReasons.push({ source, reason: `GE ask ${unitPrice} > maxUnitPrice ${req.maxUnitPrice}` });
                continue;
            }

            const totalCost = unitPrice * req.quantity;
            const bufferedCost = Math.ceil(unitPrice * GE_LIMIT_BUFFER) * req.quantity;
            if (coinBalance.spendable < bufferedCost) {
                skippedReasons.push({
                    source,
                    reason: `insufficient spendable coins ${coinBalance.spendable} (preserving ${operatingFloat} gp float) for GE limit cost ${bufferedCost}`,
                });
                continue;
            }

            const geTile = { x: 3164, z: 3487, level: 0 };
            const reach = evaluateTileReachability(acct, geTile, world, {
                spendableCoins: effectiveTotalUnreserved,
                allowUnknownPos: true,
            });
            if (!reach.reachable) {
                skippedReasons.push({ source, reason: reach.message ?? 'GE unreachable' });
                continue;
            }
            if (effectiveTotalUnreserved < bufferedCost + reach.travelCoins) {
                skippedReasons.push({ source, reason: 'insufficient coins for GE limit cost plus travel fare' });
                continue;
            }
            candidates.push({
                step: {
                    stepKind: 'acquire',
                    source: 'ge',
                    itemId: req.itemId,
                    ...(itemName ? { itemName } : {}),
                    quantity: req.quantity,
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
                skippedReasons.push({ source, reason: 'untradeable item cannot transfer via hub_banker' });
                continue;
            }
            if (acct.protectedClock || isProtectedAccountName(acct.name)) {
                skippedReasons.push({ source, reason: 'protectedClock account cannot participate in automated hub_banker trade' });
                continue;
            }
            if (isVenueOnCooldown(acct, world, req.itemId, ['hub_banker', 'hub'])) {
                skippedReasons.push({ source, reason: 'hub_banker cooldown active' });
                continue;
            }
            const antiWindow = ctx.antiPingPongWindowMs ?? DEFAULT_ANTI_PING_PONG_MS;
            const acctLower = acct.name.toLowerCase();
            if (ctx.requireConfirmedLogoutForTransfer && (ctx.confirmedLogoutAt?.get(acctLower) ?? 0) <= 0) {
                skippedReasons.push({ source, reason: 'both parties require confirmed logout proof' });
                continue;
            }
            let bestDonorStep: AcquireStep | null = null;
            let rejectReason = 'no eligible idle donor with surplus stock';
            const donors = ctx._sortedIdleDonors ?? Object.values(world.accounts).sort((a, b) => a.name.localeCompare(b.name));
            const reachRecipByHub = new Map<HubBankId, ReturnType<typeof evaluateTileReachability>>();
            for (const donor of donors) {
                const donorLower = donor.name.toLowerCase();
                if (donorLower === acctLower) continue;
                if (ctx.excludedDonorAccounts?.has(donorLower)) {
                    rejectReason = `donor ${donor.name} already assigned this cycle`;
                    continue;
                }
                if (donor.protectedClock || isProtectedAccountName(donor.name)) continue;
                if (donor.lifecycle !== 'idle') {
                    rejectReason = `donor ${donor.name} lifecycle=${donor.lifecycle}`;
                    continue;
                }
                if (!donor.bank.trusted) {
                    rejectReason = `donor ${donor.name} bank untrusted`;
                    continue;
                }
                if (ctx.requireConfirmedLogoutForTransfer) {
                    const donorLogout = ctx.confirmedLogoutAt?.get(donorLower) ?? 0;
                    if (donorLogout <= 0) {
                        rejectReason = 'both parties require confirmed logout proof';
                        continue;
                    }
                }
                if (ctx.donorDemandItemIds?.get(donorLower)?.has(req.itemId)) {
                    rejectReason = `anti-ping-pong: donor ${donor.name} holds demand for item ${req.itemId}`;
                    continue;
                }
                const recentAt = ctx.recentReceivedAt?.get(`${donorLower}:${req.itemId}`);
                if (recentAt !== undefined && world.at - recentAt < antiWindow) {
                    rejectReason = `anti-ping-pong: donor ${donor.name} recently received item ${req.itemId}`;
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
                if (donorSurplus < req.quantity) {
                    continue;
                }
                const hub = nearestHub(acct.pos, donor.pos ? nearestHub(donor.pos) : 'varrock_west');
                if (isVenueOnCooldown(acct, world, req.itemId, [`hub:${hub}:${donorLower}`, `hub:${hub}`])) {
                    rejectReason = `hub:${hub}:${donorLower} on cooldown`;
                    continue;
                }
                const hubTile = HUB_BANKER_LOCATIONS[hub].bankTile;
                let reachRecip = reachRecipByHub.get(hub);
                if (!reachRecip) {
                    reachRecip = evaluateTileReachability(acct, hubTile, world, {
                        spendableCoins: coinBalance.totalUnreserved,
                        allowUnknownPos: true,
                    });
                    reachRecipByHub.set(hub, reachRecip);
                }
                if (!reachRecip.reachable) {
                    rejectReason = reachRecip.message ?? `recipient cannot reach ${hub}`;
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
                    rejectReason = reachDonor.message ?? `donor ${donor.name} cannot reach ${hub}`;
                    continue;
                }
                const sameSideBonus = donor.side === acct.side ? 0 : 120;
                const ticks = Math.max(45, reachRecip.travelTicks + reachDonor.travelTicks + 35 + sameSideBonus);
                if (!bestDonorStep || ticks < bestDonorStep.estimatedTicks) {
                    bestDonorStep = {
                        stepKind: 'acquire',
                        source: 'hub_banker',
                        itemId: req.itemId,
                        ...(itemName ? { itemName } : {}),
                        quantity: req.quantity,
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
            else skippedReasons.push({ source, reason: rejectReason });
            continue;
        }

        if (source === 'craft_gather') {
            if (isVenueOnCooldown(acct, world, req.itemId, ['craft_gather'])) {
                skippedReasons.push({ source, reason: 'craft_gather cooldown active' });
                continue;
            }
            const matching = ctx._cachedByOutputItem
                ? (ctx._cachedByOutputItem.get(req.itemId) ?? []).filter((act) => act.trust !== 'experimental')
                : (ctx.activities ?? []).filter((act) => {
                    if (act.trust === 'experimental') return false;
                    if (act.outputs?.some((o) => o.itemId === req.itemId && o.countPerUnit > 0)) return true;
                    const outPerUnit = act.baselineRate.outputsPerUnit?.[req.itemId] ?? 0;
                    return outPerUnit > 0;
                });
            if (matching.length === 0) {
                skippedReasons.push({ source, reason: 'no non-experimental catalog activity produces item' });
                continue;
            }

            let bestActStep: AcquireStep | null = null;
            let rejectReason = 'no craft/gather activity passed preflight';
            for (const act of matching) {
                if (isVenueOnCooldown(acct, world, req.itemId, [`activity:${act.id}`])) {
                    rejectReason = `activity ${act.id} on cooldown`;
                    continue;
                }
                const outSpec = act.outputs?.find((o) => o.itemId === req.itemId);
                const outPerUnit = outSpec?.countPerUnit ?? act.baselineRate.outputsPerUnit?.[req.itemId] ?? 1;
                const unitsNeeded = Math.max(act.baselineRate.minBatchUnits, Math.ceil(req.quantity / Math.max(0.01, outPerUnit)));
                const pre = activityPreflightFromConfig(acct, act, world, unitsNeeded);
                if (!pre.ok) {
                    rejectReason = `${act.id} blocked: ${pre.blockers.map((b) => b.kind).join(',')}`;
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
            else skippedReasons.push({ source, reason: rejectReason });
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
