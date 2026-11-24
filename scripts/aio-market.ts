// AIO Market ("MK Auto Buyer & GE Trader"): unified CLI dispatcher & shim over packages/workers/src/market/.
// Usage:
//   bun scripts/aio-market.ts <account> <mode> [arg ...] [KEY=value ...]
//   bun scripts/aio-market.ts --list
//   bun scripts/aio-market.ts shop-to-bid --scan [ITEMS=...] [MIN_NET=...]
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MarketClient } from '../vendor/rs-sdk/sdk/market';
import { openBot, serverFromEnv, settle } from '../packages/core/src/bot';
import type { Step } from '../packages/core/src/chain-step';
import type { Session } from '../packages/core/src/inprocess';
import { resolveRouteStep } from './aio-route-step';
import {
    PROFILES,
    SWORD,
    bankSellerCatalogue,
    bankSellerPaths,
    bidPlan,
    buyListPaths,
    buyListStop,
    earthShopFallback,
    fetchMarket,
    fetchQuote,
    gePlanPaths,
    geTripPaths,
    geTripStop,
    loadGeItemCatalogue,
    openOrderSession,
    orderEscrow,
    orderPaths,
    orderQuantity,
    parseBuyList,
    parseItems,
    parseProfiles,
    reclaimGEPlanLock,
    runBankBidSale,
    runBankSeller,
    runBuyList,
    runEarthRefill,
    runGEPlanSession,
    runGETrip,
    runOwnedItem,
    runOwnedSale,
    runOwnedSword,
    runOwnedSwordFromEast,
    runShopBuy,
    runShopToBid,
    runShopTrip,
    saleStopRequested,
    scanProfiles,
    shopFallbackSpent,
    shopFinishOk,
    shopTripStop,
    validateBankSeller,
    validateBuyList,
    validateGEPlan,
    validateGETrip,
    validateRequest,
    validateSale,
    validateShopTrip,
    type BankSellerPolicy,
    type BuyListRequest,
    type GEPricePlan,
    type GETripRequest,
    type ItemOrder,
    type ItemRequest,
    type MarketMode,
    type Quote,
    type RescueControl,
    type SaleJournal,
    type SaleRequest,
    type ShopTripJob,
} from '../packages/workers/src/market';

export * from '../packages/workers/src/market';
export { PROFILES as SHOP_PROFILES };

export interface MarketModeSpec {
    mode: MarketMode;
    script: string;
    defaultArgs?: readonly string[];
    defaultEnv?: Readonly<Record<string, string>>;
    description: string;
}

export const MARKET_MODES: readonly MarketModeSpec[] = [
    { mode: 'shop-buy', script: 'scripts/aio-market.ts', defaultArgs: ['shop-buy'], description: 'Buy items from any mapped NPC shop (Aubury, Betty, Hickton, Harry, Lowe, Zeke, etc.) and bank' },
    { mode: 'shop-trip', script: 'scripts/aio-market.ts', defaultArgs: ['shop-trip'], description: 'Bank-to-merchant surplus sale from an explicit job.json, with exact coin/item reconciliation' },
    { mode: 'shop-sell', script: 'scripts/aio-market.ts', defaultArgs: ['shop-sell'], description: 'Sell banked surplus from an explicit job.json: open the exact native merchant, enforce price/reserve limits and bank proceeds' },
    { mode: 'earth-shop', script: 'scripts/aio-market.ts', defaultArgs: ['earth-shop'], description: 'Refill earth/elemental runes from magic shops' },
    { mode: 'buy-sword', script: 'scripts/aio-market.ts', defaultArgs: ['buy-sword'], description: 'Buy owned training sword from Varrock sword shop' },
    { mode: 'ge-buy', script: 'scripts/aio-market.ts', defaultArgs: ['ge-buy'], description: 'Place, track, collect, and bank a finite Grand Exchange buy order with journal accounting' },
    { mode: 'ge-sell', script: 'scripts/aio-market.ts', defaultArgs: ['ge-sell'], description: 'Place, track, collect, and bank a finite Grand Exchange sell order' },
    { mode: 'ge-buy-list', script: 'scripts/aio-market.ts', defaultArgs: ['ge-buy-list'], description: 'Execute a multi-item Grand Exchange shopping list' },
    { mode: 'ge-trip', script: 'scripts/aio-market.ts', defaultArgs: ['ge-trip'], description: 'Bank-to-GE round trip for buying/selling' },
    { mode: 'ge-plan', script: 'scripts/aio-market.ts', defaultArgs: ['ge-plan'], description: 'Compute Grand Exchange order plan from bank state' },
    { mode: 'shop-to-bid', script: 'scripts/aio-market.ts', defaultArgs: ['shop-to-bid'], description: 'Buy a stackable item from an NPC shop and sell it into an open Grand Exchange bid above the shop price' },
    { mode: 'bank-seller', script: 'scripts/aio-market.ts', defaultArgs: ['bank-seller'], description: 'Withdraw and liquidate banked surplus items' },
];

// Convert a map of item shortfalls ({ [itemId]: deficitCount }) and unit price limits into validated, budget-bounded GE ItemRequests.
export function planGeRestockOrders(options: {
    actor: string;
    server: string;
    goalPrefix: string;
    shortfalls: Readonly<Record<number, { quantity: number; limitPrice: number; expectedOwned?: number }>>;
    coinsAvailable: number;
    coinReserve: number;
    now?: number;
    reviewMs?: number;
    deadlineMs?: number;
}): { funded: ItemRequest[]; unfunded: number[]; totalEscrow: number; remainingCoins: number } {
    const now = options.now ?? Date.now();
    const reviewAt = now + (options.reviewMs ?? 60_000);
    const deadline = now + (options.deadlineMs ?? 900_000);
    let spendable = Math.max(0, options.coinsAvailable - options.coinReserve);
    let totalEscrow = 0;
    const funded: ItemRequest[] = [];
    const unfunded: number[] = [];
    for (const [rawId, spec] of Object.entries(options.shortfalls)) {
        const item = Number(rawId);
        if (!Number.isSafeInteger(spec.quantity) || spec.quantity < 1 || !Number.isSafeInteger(spec.limitPrice) || spec.limitPrice < 1) {
            throw Error(`aio-market: invalid shortfall spec for item ${item}`);
        }
        const escrow = spec.quantity * spec.limitPrice;
        if (escrow > spendable) {
            unfunded.push(item);
            continue;
        }
        const req: ItemRequest = {
            actor: options.actor,
            server: options.server,
            goal: `${options.goalPrefix}-${item}`.slice(0, 64),
            item,
            quantity: spec.quantity,
            ...(spec.expectedOwned !== undefined ? { expectedOwned: spec.expectedOwned } : {}),
            limit: spec.limitPrice,
            reserve: options.coinReserve,
            createdAt: now,
            reviewAt,
            deadline,
        };
        validateRequest(req);
        funded.push(req);
        spendable -= escrow;
        totalEscrow += escrow;
    }
    return { funded, unfunded, totalEscrow, remainingCoins: spendable + options.coinReserve };
}

export function resolveMarketStep(modeInput: string, rest: readonly string[] = []): Step {
    const mode = modeInput.toLowerCase().replace(/^--mode=/, '').replace(/^--type=/, '');
    const spec = MARKET_MODES.find(m => m.mode === mode);
    if (!spec) {
        throw Error(`aio-market: unknown mode "${mode}"; known: ${MARKET_MODES.map(m => m.mode).join(', ')}`);
    }
    const resolved = resolveRouteStep({ ...spec, defaultArgs: [] }, rest);
    return {
        script: 'scripts/aio-market.ts',
        args: [spec.mode, ...resolved.args],
        env: { ...(spec.defaultEnv ?? {}), ...resolved.env },
    };
}

function serverForActor(actor: string): string {
    return serverFromEnv(readFileSync(resolve(import.meta.dir, '../vendor/rs-sdk/bots', actor, 'bot.env'), 'utf8'));
}

function acquirePidLock(lockPath: string, payload: Record<string, unknown>, msgPrefix: string): number {
    mkdirSync(dirname(lockPath), { recursive: true });
    if (existsSync(lockPath)) {
        const owner = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw Error(`${msgPrefix} lock owner unknown`);
        let alive = true;
        try {
            process.kill(owner.pid, 0);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
            else throw e;
        }
        if (alive) throw Error(`${msgPrefix} actor already owned`);
        unlinkSync(lockPath);
    }
    const fd = openSync(lockPath, 'wx');
    writeFileSync(fd, JSON.stringify(payload));
    closeSync(fd);
    return process.pid;
}

function releaseLock(lockPath: string) {
    if (existsSync(lockPath)) unlinkSync(lockPath);
}

async function withEnv<T>(overrides: Record<string, string | undefined>, fn: (env: Record<string, string | undefined>) => Promise<T>): Promise<T> {
    const prev = new Map<string, string | undefined>();
    const merged: Record<string, string | undefined> = { ...process.env, ...overrides };
    for (const [k, v] of Object.entries(overrides)) {
        prev.set(k, process.env[k]);
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        return await fn(merged);
    } finally {
        for (const [k, v] of prev) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

async function settleResult(sessions: Session[], ok: boolean, detail: string): Promise<string> {
    const settled = await settle(sessions, ok, detail);
    return `${settled ? 'RESULT ok' : 'RESULT fail'} ${detail}`;
}

const optInt = (raw: string | undefined) => (raw !== undefined && raw !== '' ? Number(raw) : undefined);

export async function runAioMarket(account: string, args: readonly string[], env: Record<string, string | undefined> = process.env): Promise<string> {
    if (!account) throw Error('aio-market requires account');
    const [modeInput, ...rest] = args;
    if (!modeInput) throw Error('aio-market requires <mode>');
    const step = resolveMarketStep(modeInput, rest);
    const mode = step.args[0] as MarketMode;
    const pos = step.args.slice(1);

    return withEnv({ ...env, ...step.env }, async merged => {
        switch (mode) {
            case 'shop-buy': {
                let stopped = false;
                let s: Session | undefined;
                try {
                    s = await openBot(account, {
                        onStop: async () => { stopped = true; },
                        onSessionEnd: async () => { stopped = true; },
                    });
                    const itemIdFilter = merged.ITEM_ID ? Number(merged.ITEM_ID) : NaN;
                    const resolvedItems = merged.ITEMS
                        ?? (Number.isSafeInteger(itemIdFilter)
                            ? loadGeItemCatalogue().find(r => r.id === itemIdFilter)?.name
                            : undefined);
                    const res = await runShopBuy(s, {
                        mode: 'shop-buy',
                        profile: pos[0] || merged.PROFILE || 'catherby',
                        cap: Number(pos[1] ?? merged.CAP ?? 15000),
                        bankAt: optInt(merged.BANK_AT),
                        items: resolvedItems,
                        stockTarget: optInt(merged.STOCK_TARGET),
                        maxItems: merged.MAX_ITEMS ? Number(merged.MAX_ITEMS) : undefined,
                        maxSpend: merged.MAX_SPEND ? Number(merged.MAX_SPEND) : undefined,
                        coinReserve: optInt(merged.COIN_RESERVE),
                        float: optInt(merged.FLOAT),
                        noBuyTicks: optInt(merged.NO_BUY_TICKS),
                        blindBuy: merged.BLIND_BUY === '1',
                        stopAtTarget: merged.STOP_AT_TARGET === '1',
                        bankPack: merged.BANK_PACK === '1',
                        stockPollTicks: optInt(merged.STOCK_POLL_TICKS),
                    }, () => stopped);
                    return settleResult([s], res.ok, res.summary);
                } catch (e) {
                    return settleResult(s ? [s] : [], false, String(e));
                }
            }
            case 'earth-shop': {
                let stopped = false;
                let s: Session | undefined;
                try {
                    s = await openBot(account, { onStop: async () => { stopped = true; } });
                    const r = await runEarthRefill(s, {
                        profile: pos[0]!,
                        cap: Number(pos[1] ?? merged.CAP),
                        target: Number(merged.STOCK_TARGET),
                        maximum: Number(merged.MAX_ITEMS),
                        spend: Number(merged.MAX_SPEND),
                        reserve: Number(merged.COIN_RESERVE),
                        seedUsed: Number(merged.EARTH_SEED_USED ?? 0),
                        stop: () => stopped,
                    });
                    const quiescent = r.safeOffline && shopFinishOk(0, false, r.stop);
                    console.log('EARTH_REFILL ' + JSON.stringify(r));
                    const detail = Object.entries(r).map(([k, v]) => `${k}=${v}`).join(' ');
                    return settleResult([s], r.ok || quiescent, detail);
                } catch (e) {
                    return settleResult(s ? [s] : [], false, String(e));
                }
            }
            case 'buy-sword': {
                let stopped = false;
                let s: Session | undefined;
                try {
                    s = await openBot(account, { onStop: async () => { stopped = true; } });
                    const run = merged.PREPARE_EAST === '1' ? runOwnedSwordFromEast : runOwnedSword;
                    const r = await run(s, {
                        itemId: Number(merged.SWORD_ITEM ?? SWORD),
                        cap: Number(merged.CAP ?? 900),
                        maximumSpend: Number(merged.MAX_SPEND ?? 2500),
                        stop: () => stopped,
                    });
                    console.log('OWNED_SWORD_BANK ' + JSON.stringify(r));
                    const detail = Object.entries(r).map(([k, v]) => `${k}=${v}`).join(' ');
                    return settleResult([s], r.ok, detail);
                } catch (e) {
                    return settleResult(s ? [s] : [], false, String(e));
                }
            }
            case 'shop-trip':
            case 'shop-sell': {
                const jobPath = pos[0];
                if (!jobPath) throw Error(`usage: bun scripts/aio-market.ts <account> ${mode} <job.json>`);
                let s: Session | undefined;
                try {
                    const j = JSON.parse(readFileSync(jobPath, 'utf8')) as ShopTripJob;
                    validateShopTrip(j);
                    let stopped = false;
                    const onSig = () => { stopped = true; };
                    process.once('SIGINT', onSig);
                    process.once('SIGTERM', onSig);
                    try {
                        s = await openBot(account, { onStop: async () => { stopped = true; } });
                        const result = await runShopTrip(s, j, () => shopTripStop(account, stopped));
                        console.log('SHOP_TRIP ' + JSON.stringify(result));
                        return settleResult([s], result.ok, JSON.stringify(result));
                    } finally {
                        process.off('SIGINT', onSig);
                        process.off('SIGTERM', onSig);
                    }
                } catch (error) {
                    return settleResult(s ? [s] : [], false, String(error));
                }
            }
            case 'ge-buy': {
                const goal = merged.ORDER_KEY ?? 'combat-sword';
                if (!/^[a-z0-9]{1,12}$/i.test(account) || !/^[a-z0-9_-]{1,64}$/i.test(goal)) {
                    throw Error('explicit owned actor/order key required');
                }
                const fillWaitTicks = Number(merged.FILL_WAIT_TICKS ?? 10);
                if (!Number.isSafeInteger(fillWaitTicks) || fillWaitTicks < 0 || fillWaitTicks > 200) {
                    throw Error('FILL_WAIT_TICKS must be 0-200 game ticks');
                }
                const server = serverForActor(account);
                const { base, lock, journal: journalPath } = orderPaths(server, account, goal);
                mkdirSync(base, { recursive: true });
                acquirePidLock(lock, { pid: process.pid, actor: account, server, goal, at: Date.now() }, 'market');
                let s: Session | undefined;
                let stopped = false;
                try {
                    const old = existsSync(journalPath) ? (JSON.parse(readFileSync(journalPath, 'utf8')) as ItemOrder) : undefined;
                    const now = Date.now();
                    const period = Number(merged.ORDER_MS ?? 900_000);
                    const request: ItemRequest = old?.request ?? {
                        actor: account,
                        server,
                        goal,
                        item: Number(merged.ITEM_ID ?? 1331),
                        quantity: Number(merged.QUANTITY ?? 1),
                        ...(merged.EXPECTED_OWNED ? { expectedOwned: Number(merged.EXPECTED_OWNED) } : {}),
                        ...(merged.RESCUE_MODE ? { rescueMode: merged.RESCUE_MODE as ItemRequest['rescueMode'] } : {}),
                        limit: Number(merged.LIMIT_PRICE ?? 45_000),
                        reserve: Number(merged.CASH_RESERVE ?? 5000),
                        createdAt: now,
                        reviewAt: now + Math.min(300_000, Math.max(1, Math.floor(period / 3))),
                        deadline: now + period,
                    };
                    if (merged.RESCUE_MODE && merged.RESCUE_MODE !== request.rescueMode) throw Error('existing rescue mode mismatch');
                    if (
                        request.actor.toLowerCase() !== account.toLowerCase()
                        || request.server !== server
                        || request.goal !== goal
                        || (merged.ITEM_ID && Number(merged.ITEM_ID) !== request.item)
                        || (merged.QUANTITY && Number(merged.QUANTITY) !== orderQuantity(request))
                        || (merged.EXPECTED_OWNED && Number(merged.EXPECTED_OWNED) !== request.expectedOwned)
                        || (merged.LIMIT_PRICE && Number(merged.LIMIT_PRICE) !== request.limit)
                        || (merged.CASH_RESERVE && Number(merged.CASH_RESERVE) !== request.reserve)
                        || (merged.ORDER_MS && Number(merged.ORDER_MS) !== request.deadline - request.createdAt)
                    ) {
                        throw Error('existing request identity/budget mismatch');
                    }
                    validateRequest(request);
                    if (merged.SHOP_PROFILE) {
                        if (merged.CANCEL === '1') throw Error('shop fallback cannot cancel an order');
                        const fallbackPath = journalPath + '.shop.json';
                        const fallback = existsSync(fallbackPath) ? JSON.parse(readFileSync(fallbackPath, 'utf8')) : undefined;
                        const saveFallback = (value: unknown) => {
                            writeFileSync(fallbackPath + '.tmp', JSON.stringify(value, null, 2));
                            renameSync(fallbackPath + '.tmp', fallbackPath);
                        };
                        const spent = shopFallbackSpent(fallback, request);
                        const plan = earthShopFallback(request, old, Number(merged.CAP ?? 1600), spent, merged.SHOP_PROFILE);
                        const seedUsed = fallback?.seeded ?? 0;
                        if (![0, 1].includes(seedUsed)) throw Error('earth fallback seed history unknown');
                        console.log('SHOP_FALLBACK ' + JSON.stringify({
                            method: merged.SHOP_PROFILE,
                            originalOfferId: old!.offerId,
                            originalJournalPreserved: true,
                            item: request.item,
                            quantity: orderQuantity(request),
                            target: request.expectedOwned! + orderQuantity(request),
                            maxSpend: orderEscrow(request) - spent,
                            reserve: request.reserve,
                        }));
                        saveFallback({ request, phase: 'running', spent, seeded: seedUsed, at: Date.now() });
                        const spawnArgs = [plan.entry, account, ...plan.args];
                        const child = Bun.spawn([process.execPath, ...spawnArgs], {
                            windowsHide: true,
                            stdout: 'pipe',
                            stderr: 'pipe',
                            env: { ...merged, ...plan.env, EARTH_SEED_USED: String(seedUsed), SHOP_PROFILE: '' },
                        });
                        const [out, err, code] = await Promise.all([
                            new Response(child.stdout).text(),
                            new Response(child.stderr).text(),
                            child.exited,
                        ]);
                        process.stdout.write(out);
                        process.stderr.write(err);
                        const resultLine = out.split(/\r?\n/).filter(l => l.startsWith('RESULT ')).at(-1) ?? '';
                        const debit = Number(resultLine.match(/\bspentTotal=(\d+)/)?.[1] ?? NaN);
                        if (!Number.isSafeInteger(debit) || debit < 0 || debit > orderEscrow(request) - spent) {
                            throw Error('shop fallback spend unconfirmed; retained running intent refuses retry');
                        }
                        const seeds = plan.mode === 'earth-shop' ? Number(resultLine.match(/\bseeded=(\d+)/)?.[1] ?? NaN) : 0;
                        if (![0, 1].includes(seeds) || seedUsed + seeds > 1) {
                            throw Error('earth fallback seed count unconfirmed; retained running intent refuses retry');
                        }
                        saveFallback({ request, phase: 'settled', spent: spent + debit, seeded: seedUsed + seeds, at: Date.now() });
                        releaseLock(lock);
                        return resultLine || `${code === 0 ? 'RESULT ok' : 'RESULT fail'} shop-fallback`;
                    }
                    const rescue: RescueControl = { active: false, start: 0, lifeId: 0, respawnCount: 0 };
                    s = await openOrderSession(account, request, rescue, () => { stopped = true; });
                    const stop = () => stopped || existsSync(resolve('.practice', `stop-${account}`));
                    const result = await runOwnedItem(s, request, journalPath, stop, merged.CANCEL === '1', fillWaitTicks, rescue);
                    console.log('OWNED_GE_ITEM ' + JSON.stringify(result));
                    return await settleResult([s], result.ok, JSON.stringify(result));
                } catch (error) {
                    if (s) return await settleResult([s], false, String(error));
                    throw error;
                } finally {
                    releaseLock(lock);
                }
            }
            case 'ge-sell': {
                const goal = merged.ORDER_KEY ?? 'owned-surplus-sale';
                const server = serverForActor(account);
                const paths = orderPaths(server, account, 'sell-' + goal);
                acquirePidLock(paths.lock, { pid: process.pid, actor: account, goal }, 'market');
                let s: Session | undefined;
                try {
                    const old: SaleJournal | undefined = existsSync(paths.journal) ? JSON.parse(readFileSync(paths.journal, 'utf8')) : undefined;
                    const r: SaleRequest = old?.request ?? {
                        actor: account,
                        server,
                        goal,
                        item: Number(merged.ITEM_ID),
                        quantity: Number(merged.QUANTITY),
                        price: Number(merged.SELL_PRICE),
                        floor: Number(merged.FLOOR_PRICE),
                        reserveItems: Number(merged.RESERVE_ITEMS ?? 0),
                        deadline: Date.now() + Number(merged.ORDER_MS ?? 60_000),
                    };
                    if (r.actor !== account || r.server !== server || r.goal !== goal) throw Error('sale CLI identity mismatch');
                    for (const [key, field] of [['ITEM_ID', 'item'], ['QUANTITY', 'quantity'], ['SELL_PRICE', 'price'], ['FLOOR_PRICE', 'floor'], ['RESERVE_ITEMS', 'reserveItems']] as const) {
                        if (merged[key] !== undefined && Number(merged[key]) !== r[field]) throw Error('sale CLI budget mismatch');
                    }
                    validateSale(r);
                    s = await openBot(account);
                    const waitTicks = Number(merged.FILL_WAIT_TICKS ?? 40);
                    const cancel = merged.CANCEL === '1';
                    const result = merged.FROM_BANK === '1'
                        ? await runBankBidSale(s, r, paths.journal, () => saleStopRequested(account), waitTicks, cancel, { bankCoins: merged.BANK_COINS !== '0' })
                        : await runOwnedSale(s, r, paths.journal, () => saleStopRequested(account), waitTicks, cancel);
                    console.log('OWNED_GE_SALE ' + JSON.stringify(result));
                    return await settleResult([s], result.ok, JSON.stringify(result));
                } catch (e) {
                    if (s) return await settleResult([s], false, String(e));
                    throw e;
                } finally {
                    releaseLock(paths.lock);
                }
            }
            case 'ge-buy-list': {
                const listPath = pos[0];
                if (!listPath) throw Error('usage: bun scripts/aio-market.ts <account> ge-buy-list <plan.json>');
                const input = JSON.parse(readFileSync(listPath, 'utf8'));
                const server = serverForActor(account);
                let r = input as BuyListRequest;
                if (r.actor !== account || r.server !== server) throw Error('buy-list CLI actor/server mismatch');
                if (input.list) {
                    const pPath = buyListPaths({ ...r, entries: [] } as BuyListRequest).parent;
                    const withoutEntries = (x: Record<string, unknown>) => {
                        const { entries: _e, ...keep } = x;
                        return keep;
                    };
                    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
                    if (existsSync(pPath)) {
                        const old = JSON.parse(readFileSync(pPath, 'utf8')).request;
                        if (!same(withoutEntries(old), withoutEntries(input))) throw Error('persisted buy-list source/config changed');
                        r = old;
                    } else {
                        const parsed = parseBuyList(input.list);
                        const market = new MarketClient(server.includes('://') ? server : `http://${server}`);
                        r.entries = [];
                        for (const e of parsed) {
                            const q = await market.item(e.item);
                            r.entries.push({ ...e, basePrice: q.lastPrice ?? Math.max(1, q.basePrice), percent: input.percent, unitCap: input.unitCaps?.[e.item] });
                        }
                    }
                }
                validateBuyList(r);
                const paths = buyListPaths(r);
                acquirePidLock(paths.lock, { pid: process.pid, actor: account, goal: r.goal }, 'buy-list');
                let s: Session | undefined;
                let stopped = false;
                const onSig = () => { stopped = true; };
                process.once('SIGINT', onSig);
                process.once('SIGTERM', onSig);
                try {
                    s = await openBot(account, {
                        onStop: async () => { stopped = true; },
                        onSessionEnd: async () => { stopped = true; },
                    });
                    const result = await runBuyList(s, r, () => buyListStop(account, stopped));
                    console.log('GE_BUY_LIST ' + JSON.stringify(result));
                    return await settleResult([s], result.ok, JSON.stringify(result));
                } catch (error) {
                    if (s) return await settleResult([s], false, String(error));
                    throw error;
                } finally {
                    process.off('SIGINT', onSig);
                    process.off('SIGTERM', onSig);
                    releaseLock(paths.lock);
                }
            }
            case 'ge-trip': {
                const tripPath = pos[0];
                if (!tripPath) throw Error('usage: bun scripts/aio-market.ts <account> ge-trip <lot.json>');
                const r = JSON.parse(readFileSync(tripPath, 'utf8')) as GETripRequest;
                const server = serverForActor(account);
                if (r.actor !== account || r.server !== server) throw Error('GE CLI actor/server mismatch');
                validateGETrip(r);
                const paths = geTripPaths(r);
                acquirePidLock(paths.lock, { pid: process.pid, actor: account, goal: r.goal }, 'GE actor');
                let s: Session | undefined;
                let stopped = false;
                const onSig = () => { stopped = true; };
                process.once('SIGINT', onSig);
                process.once('SIGTERM', onSig);
                try {
                    s = await openBot(account);
                    const result = await runGETrip(s, r, () => geTripStop(account, stopped));
                    console.log('GE_TRIP ' + JSON.stringify(result));
                    return await settleResult([s], result.ok, JSON.stringify(result));
                } catch (error) {
                    if (s) return await settleResult([s], false, String(error));
                    throw error;
                } finally {
                    process.off('SIGINT', onSig);
                    process.off('SIGTERM', onSig);
                    releaseLock(paths.lock);
                }
            }
            case 'ge-plan': {
                const file = pos.find(a => a !== '--finish');
                if (!file) throw Error('usage: bun scripts/aio-market.ts <account> ge-plan <explicit-plan.json> [--finish]');
                const request = JSON.parse(readFileSync(file, 'utf8')) as GEPricePlan;
                validateGEPlan(request);
                if (serverForActor(account) !== request.server) throw Error('GE plan server mismatch');
                const p = gePlanPaths(request);
                mkdirSync(p.base, { recursive: true });
                reclaimGEPlanLock(p.lock);
                const lock = openSync(p.lock, 'wx');
                writeFileSync(lock, JSON.stringify({ pid: process.pid, goal: request.goal }));
                let s: Session | undefined;
                let stopped = false;
                const onSig = () => { stopped = true; };
                process.once('SIGINT', onSig);
                process.once('SIGTERM', onSig);
                try {
                    s = await openBot(account);
                    const code = await runGEPlanSession(s, request, () => stopped, {}, pos.includes('--finish'), settle);
                    return code === 0 ? 'RESULT ok finite explicit GE price plan' : 'RESULT fail finite explicit GE price plan';
                } finally {
                    process.off('SIGINT', onSig);
                    process.off('SIGTERM', onSig);
                    closeSync(lock);
                    releaseLock(p.lock);
                }
            }
            case 'bank-seller': {
                const file = pos[0];
                if (!file) throw Error('usage: bun scripts/aio-market.ts <account> bank-seller <finite-bank-policy.json>');
                const r = JSON.parse(readFileSync(file, 'utf8')) as BankSellerPolicy;
                validateBankSeller(r);
                bankSellerCatalogue();
                if (account !== r.actor || serverForActor(account) !== r.server) throw Error('bank-seller CLI actor/server mismatch');
                const p = bankSellerPaths(r);
                mkdirSync(p.base, { recursive: true });
                reclaimGEPlanLock(p.lock);
                const fd = openSync(p.lock, 'wx');
                writeFileSync(fd, JSON.stringify({ pid: process.pid, goal: r.goal }));
                let s: Session | undefined;
                let stopped = false;
                const onSig = () => { stopped = true; };
                process.once('SIGINT', onSig);
                process.once('SIGTERM', onSig);
                try {
                    s = await openBot(account);
                    const result = await runBankSeller(s, r, () => stopped);
                    console.log('BANK_SELLER ' + JSON.stringify(result));
                    return await settleResult([s], result.ok, JSON.stringify(result));
                } catch (error) {
                    if (s) return await settleResult([s], false, String(error));
                    throw error;
                } finally {
                    process.off('SIGINT', onSig);
                    process.off('SIGTERM', onSig);
                    closeSync(fd);
                    releaseLock(p.lock);
                }
            }
            case 'shop-to-bid': {
                const num = (key: string, d: number) => {
                    const v = Number(merged[key] ?? d);
                    if (!Number.isSafeInteger(v) || v < 0) throw Error(`${key} must be a whole number`);
                    return v;
                };
                const maxUnits = num('UNITS', 5000);
                const minNet = num('MIN_NET', 50);
                const reserve = num('COIN_RESERVE', 10_000);
                const maxSpend = num('MAX_SPEND', 200_000);
                const waitTicks = num('WAIT_TICKS', 0);
                const minLot = num('MIN_LOT', 20_000);
                const lots = Math.max(1, num('LOTS', 1));
                const [profileArg = '', itemArg = ''] = pos;
                const profiles = parseProfiles(profileArg, Object.keys(PROFILES));
                const itemIds = parseItems(itemArg);
                if (!profiles || !itemIds) {
                    throw Error(`shop-to-bid usage: bun scripts/aio-market.ts <bot> shop-to-bid <profile[,profile...]> <itemId[,itemId...]> (profiles: ${Object.keys(PROFILES).join(' | ')})`);
                }
                const quotes: Quote[] = [];
                for (const id of itemIds) {
                    const q = await fetchQuote(id);
                    const pre = bidPlan({ quote: q, unitCost: q.basePrice, coins: Number.MAX_SAFE_INTEGER, reserve: 0, maxUnits, minNet });
                    console.log(`QUOTE ${id} ${q.name} bid=${q.bid} want=${q.buyQuantity} base=${q.basePrice}${pre.units ? '' : ` skip: ${pre.refusal}`}`);
                    if (pre.units) quotes.push(q);
                }
                if (!quotes.length) {
                    return 'RESULT fail shop-to-bid refused before login: no item clears MIN_NET';
                }
                const server = serverForActor(account);
                const s = await openBot(account);
                try {
                    const r = await runShopToBid(s, server, {
                        mode: 'shop-to-bid',
                        profiles,
                        itemIds,
                        units: maxUnits,
                        minNet,
                        coinReserve: reserve,
                        maxSpend,
                        waitTicks,
                        minLot,
                        lots,
                    }, () => saleStopRequested(account), quotes);
                    return await settleResult([s], r.ok, r.summary);
                } catch (e) {
                    return await settleResult([s], false, String(e));
                }
            }
        }
    });
}

async function runScan(args: readonly string[]): Promise<number> {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const token of args) {
        const m = token.match(/^([A-Z][A-Z0-9_]*)=([\s\S]*)$/);
        if (m) env[m[1]!] = m[2]!;
    }
    const minNet = Number(env.MIN_NET ?? 50);
    if (!Number.isSafeInteger(minNet) || minNet < 0) throw Error('MIN_NET must be a whole number');
    const rows = scanProfiles(PROFILES, await fetchMarket(), minNet);
    for (const r of rows) {
        console.log(`${r.profile.padEnd(14)} ${String(r.id).padStart(5)} ${r.name.padEnd(20)} bid ${r.bid} want ${r.want} margin ${r.margin}`);
    }
    console.log(`RESULT ok shop-to-bid scan: ${rows.length} items clear MIN_NET ${minNet}`);
    return 0;
}

if (import.meta.main) {
    const [account, ...rest] = process.argv.slice(2);
    if (account === '--list') {
        console.log(JSON.stringify(MARKET_MODES, null, 2));
        process.exit(0);
    }
    if (account === '--scan' || (account === 'shop-to-bid' && rest[0] === '--scan')) {
        process.exit(await runScan(account === '--scan' ? rest : rest.slice(1)));
    }
    if (!account || !rest.length) {
        console.log('RESULT fail usage: bun scripts/aio-market.ts <account> <shop-buy|shop-trip|shop-sell|earth-shop|buy-sword|ge-buy|ge-sell|ge-buy-list|ge-trip|ge-plan|shop-to-bid|bank-seller> [args...]');
        process.exit(2);
    }
    const result = await runAioMarket(account, rest);
    process.exit(/^RESULT ok(?: |$)/.test(result) ? 0 : 1);
}
