import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MARKET_CACHE_MS, writeMarketCache } from '../../core/src/market-cache';
import {
    ACQUIRE_SOURCE_ORDER,
    DEFAULT_OPERATING_COIN_FLOAT,
    isAcquireStep,
    marketCooldownKey,
    type AccountState,
    type ActivityDefinition,
    type WorldSnapshot,
} from '../src/contracts';
import {
    GE_LIMIT_BUFFER,
    loadMarketQuotesFromRoot,
    loadShopCatalogByItem,
    resolveAcquireItem,
} from '../src/acquire';
import { derivedProfile } from '../../workers/src/market/shop-profiles';
import { resolveShopProfile } from '../../workers/src/market/preflight';

const NOW = 1_700_000_000_000;

function makeAcct(overrides: Partial<AccountState> = {}): AccountState {
    return {
        name: 'Packhorse',
        side: 'local',
        role: 'helper',
        protectedClock: false,
        lifecycle: 'idle',
        skills: {
            Fishing: { level: 80, xp: 2_000_000 },
            Cooking: { level: 85, xp: 3_300_000 },
            Attack: { level: 50, xp: 105_000 },
        },
        quests: { cook: 'complete' },
        pos: { x: 3092, z: 3243, level: 0 }, // Draynor bank
        inventory: { 995: 5000 },
        equipment: {},
        bank: {
            items: { 995: 10_000, 301: 1, 311: 1 }, // lobster pot, harpoon
            observedAt: NOW - 30_000,
            trusted: true,
        },
        ...overrides,
    };
}

const CATCH_RAW_SHARK: ActivityDefinition = {
    id: 'gather:fishing-shark',
    workerId: 'gather',
    family: 'gather',
    kind: 'gather',
    label: 'Catch raw sharks at Catherby',
    skill: 'Fishing',
    config: { requiredLevel: 76, requiredTools: [311] },
    baselineRate: {
        xpPerTick: 110,
        unitsPerTick: 0.1,
        gpPerTick: 60,
        setupTicks: 30,
        minBatchUnits: 20,
        confidence: 'practice',
        outputsPerUnit: { 383: 1 },
    },
    outputs: [{ itemId: 383, countPerUnit: 1 }],
    location: { x: 2835, z: 3432, level: 0 },
    trust: 'practice_passed',
};

test('AcquireItem evaluates sources in strict Own Bank -> NPC Shop -> GE -> Hub Banker -> Craft/Gather order', () => {
    expect(ACQUIRE_SOURCE_ORDER).toEqual(['own_bank', 'npc_shop', 'ge', 'hub_banker', 'craft_gather']);

    const acct = makeAcct({
        bank: { items: { 995: 10_000, 314: 200, 311: 1 }, observedAt: NOW - 10_000, trusted: true },
    });
    const donor = makeAcct({
        name: 'Moneyshot',
        pos: { x: 3185, z: 3436, level: 0 },
        bank: { items: { 314: 500, 383: 500, 995: 50_000 }, observedAt: NOW - 10_000, trusted: true },
    });
    const world: WorldSnapshot = {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: { Packhorse: acct, Moneyshot: donor },
    };

    // Feather (314) is in own_bank, npc_shop (sarim/Gerrant), ge, hub_banker: own_bank wins first!
    const ownWin = resolveAcquireItem(acct, { itemId: 314, quantity: 100 }, {
        world,
        marketQuotes: { 314: { ask: 5, sell: 500, trades: 10 } },
    });
    expect(ownWin.ok).toBe(true);
    expect(ownWin.step?.source).toBe('own_bank');
    expect(isAcquireStep(ownWin.step)).toBe(true);
    expect(ownWin.candidates.map((c) => c.source)).toEqual(['own_bank', 'npc_shop', 'ge', 'hub_banker']);

    // Without own_bank stock of feathers, npc_shop wins before ge and hub_banker.
    const noOwnFeathers = makeAcct({
        bank: { items: { 995: 10_000 }, observedAt: NOW - 10_000, trusted: true },
    });
    const shopWin = resolveAcquireItem(
        noOwnFeathers,
        { itemId: 314, quantity: 100 },
        {
            world: { ...world, accounts: { Packhorse: noOwnFeathers, Moneyshot: donor } },
            marketQuotes: { 314: { ask: 5, sell: 500, trades: 10 } },
        },
    );
    expect(shopWin.ok).toBe(true);
    expect(shopWin.step?.source).toBe('npc_shop');
    expect(shopWin.step?.shopId).toBeDefined();
    expect(shopWin.step?.coinFloatPreserved).toBe(DEFAULT_OPERATING_COIN_FLOAT);
});

test('AcquireItem preserves operating coin float (~1,000 gp) and falls through when spendable budget is exhausted', () => {
    const lowCoinAcct = makeAcct({
        inventory: { 995: 1050 },
        bank: { items: { 311: 1 }, observedAt: NOW - 10_000, trusted: true },
    });
    const donor = makeAcct({
        name: 'Bigpackage',
        pos: { x: 3185, z: 3436, level: 0 },
        bank: { items: { 383: 300, 995: 5000 }, observedAt: NOW - 10_000, trusted: true },
    });
    const world: WorldSnapshot = {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: { Packhorse: lowCoinAcct, Bigpackage: donor },
    };

    // Raw shark (383) at 400 gp on GE for 50x = 20,000 gp exceeds spendable (50 gp after 1,000 gp float).
    // Must reject GE and fall through to hub_banker (and craft_gather).
    const res = resolveAcquireItem(
        lowCoinAcct,
        { itemId: 383, quantity: 50, operatingCoinFloat: 1000 },
        {
            world,
            activities: [CATCH_RAW_SHARK],
            marketQuotes: { 383: { ask: 400, sell: 380, trades: 20 } },
        },
    );
    expect(res.ok).toBe(true);
    expect(res.step?.source).toBe('hub_banker');
    expect(res.step?.donorAccount).toBe('Bigpackage');
    expect(res.step?.coinFloatPreserved).toBe(1000);
    expect(res.candidates.map((c) => c.source)).toEqual(['hub_banker', 'craft_gather']);
});

test('AcquireItem respects (item, venue) TTL cooldowns across account and world cooldown maps', () => {
    const acct = makeAcct({
        cooldowns: {
            [marketCooldownKey(383, 'ge')]: NOW + 120_000,
            [marketCooldownKey(383, 'npc_shop')]: NOW + 120_000,
        },
    });
    const donor = makeAcct({
        name: 'Bigpackage',
        bank: { items: { 383: 200 }, observedAt: NOW - 10_000, trusted: true },
    });
    const world: WorldSnapshot = {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: { Packhorse: acct, Bigpackage: donor },
        marketCooldowns: { [marketCooldownKey(383, 'hub_banker')]: NOW + 60_000 },
    };

    const customShops = [
        {
            shop: 'fish_test_shop',
            itemId: 383,
            stock: 50,
            restockTicks: 10,
            cost: 250,
            tile: { x: 3013, z: 3225, level: 0 },
        },
    ];

    // With npc_shop, ge, and hub_banker all cooled down, must fall through to craft_gather.
    const cooled = resolveAcquireItem(
        acct,
        { itemId: 383, quantity: 30 },
        {
            world,
            activities: [CATCH_RAW_SHARK],
            customShops,
            marketQuotes: { 383: { ask: 400, sell: 380, trades: 15 } },
        },
    );
    expect(cooled.ok).toBe(true);
    expect(cooled.step?.source).toBe('craft_gather');
    expect(cooled.step?.activityId).toBe('gather:fishing-shark');

    // Once TTL expires at NOW + 120_000, npc_shop becomes eligible again (and before ge).
    const expiredWorld: WorldSnapshot = { ...world, at: NOW + 120_000 };
    const uncooled = resolveAcquireItem(
        acct,
        { itemId: 383, quantity: 30 },
        {
            world: expiredWorld,
            activities: [CATCH_RAW_SHARK],
            customShops,
            marketQuotes: { 383: { ask: 400, sell: 380, trades: 15 } },
        },
    );
    expect(uncooled.ok).toBe(true);
    expect(uncooled.step?.source).toBe('npc_shop');
});

test('AcquireItem enforces untrusted bank, protectedClock, and anti-ping-pong exclusions for hub_banker', () => {
    const recip = makeAcct({
        inventory: { 995: 1000 },
        bank: { items: {}, observedAt: NOW - 5000, trusted: false },
    });
    const protectedDonor = makeAcct({
        name: 'Haggis',
        role: 'main',
        protectedClock: true,
        bank: { items: { 383: 500 }, observedAt: NOW - 5000, trusted: true },
    });
    const demandedDonor = makeAcct({
        name: 'Demander',
        bank: { items: { 383: 500 }, observedAt: NOW - 5000, trusted: true },
    });
    const recentDonor = makeAcct({
        name: 'PingPong',
        bank: { items: { 383: 500 }, observedAt: NOW - 5000, trusted: true },
    });
    const world: WorldSnapshot = {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: {
            Packhorse: recip,
            Haggis: protectedDonor,
            Demander: demandedDonor,
            PingPong: recentDonor,
        },
    };

    const res = resolveAcquireItem(
        recip,
        { itemId: 383, quantity: 100, allowedSources: ['hub_banker'] },
        {
            world,
            donorDemandItemIds: new Map([['demander', new Set([383])]]),
            recentReceivedAt: new Map([['pingpong:383', NOW - 30_000]]),
            antiPingPongWindowMs: 600_000,
        },
    );
    expect(res.ok).toBe(false);
    expect(res.step).toBeNull();
});

test('loadShopCatalogByItem emits runnable derivedProfile and PROFILES shops while excluding unreachable shops', () => {
    const catalog = loadShopCatalogByItem();
    expect(catalog.size).toBeGreaterThan(0);
    const allShops = new Set<string>();
    for (const entries of catalog.values()) {
        for (const entry of entries) {
            allShops.add(entry.shop);
            expect(Boolean(resolveShopProfile(entry.shop))).toBe(true);
        }
    }
    expect(allShops.has('zaff')).toBe(true);
    expect(allShops.has('jiminua')).toBe(true);
    expect(catalog.get(1381)?.some((e) => e.shop === 'zaff' && e.cost === 1500)).toBe(true);
    expect(catalog.get(175)?.some((e) => e.shop === 'jiminua' && e.cost === 288)).toBe(true);
    expect(allShops.has('cheapringshop')).toBe(false);
    expect(allShops.has('gnomeshop_gulluck')).toBe(false);
    expect(Boolean(derivedProfile('2handedshop'))).toBe(true);
});

test('loadMarketQuotesFromRoot unwraps writeMarketCache { at, items } envelope and enforces MARKET_CACHE_MS freshness', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-market-cache-'));
    try {
        writeMarketCache(dir, {
            383: { name: 'Raw shark', price: 320, bid: 300, ask: 350, trades: 12, base: 100, sell: 500 },
        }, NOW - 60_000);

        const fresh = loadMarketQuotesFromRoot(dir, NOW);
        expect(fresh[383]).toMatchObject({ ask: 350, sell: 500, trades: 12 });

        const stale = loadMarketQuotesFromRoot(dir, NOW + MARKET_CACHE_MS);
        expect(stale).toEqual({});
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('AcquireItem GE source checks spendable coins against GE_LIMIT_BUFFER (1.15x) limit cost', () => {
    // 100 units at 100 gp ask = 10,000 gp nominal, 11,500 gp buffered limit.
    const nominalOnly = makeAcct({
        inventory: { 995: 1_000 },
        bank: { items: { 995: 10_000 }, observedAt: NOW - 5000, trusted: true },
    });
    const bufferedReady = makeAcct({
        inventory: { 995: 1_000 },
        bank: { items: { 995: Math.ceil(100 * GE_LIMIT_BUFFER) * 100 }, observedAt: NOW - 5000, trusted: true },
    });
    const quotes = { 383: { ask: 100, sell: 500, trades: 10 } };

    const failRes = resolveAcquireItem(
        nominalOnly,
        { itemId: 383, quantity: 100, allowedSources: ['ge'] },
        {
            world: {
                schemaVersion: 1,
                at: NOW,
                side: 'local',
                server: 'rs-sdk-demo.fly.dev',
                accounts: { Packhorse: nominalOnly },
            },
            marketQuotes: quotes,
        },
    );
    expect(failRes.ok).toBe(false);

    const okRes = resolveAcquireItem(
        bufferedReady,
        { itemId: 383, quantity: 100, allowedSources: ['ge'] },
        {
            world: {
                schemaVersion: 1,
                at: NOW,
                side: 'local',
                server: 'rs-sdk-demo.fly.dev',
                accounts: { Packhorse: bufferedReady },
            },
            marketQuotes: quotes,
        },
    );
    expect(okRes.ok).toBe(true);
    expect(okRes.step?.source).toBe('ge');
    expect(okRes.step?.estimatedCoinCost).toBe(10_000);
});

test('AcquireItem accepts market-priced low-cost staples (Dragon bones, Prayer potion) and rejects inflated outliers', () => {
    const richAcct = makeAcct({
        bank: { items: { 995: 500_000 }, observedAt: NOW - 5000, trusted: true },
    });
    const world: WorldSnapshot = {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: { Packhorse: richAcct },
    };

    // Dragon bones (536) have shop cost=1 in items.json, real market ask ~2400 gp.
    const dboneRes = resolveAcquireItem(
        richAcct,
        { itemId: 536, quantity: 10, allowedSources: ['ge'] },
        { world, marketQuotes: { 536: { ask: 2400, sell: 2200, trades: 20 } } },
    );
    expect(dboneRes.ok).toBe(true);
    expect(dboneRes.step?.source).toBe('ge');
    expect(dboneRes.step?.estimatedCoinCost).toBe(24_000);

    // Prayer potion(4) (2434) has shop cost=190, real market ask ~8500 gp.
    const ppotRes = resolveAcquireItem(
        richAcct,
        { itemId: 2434, quantity: 5, allowedSources: ['ge'] },
        { world, marketQuotes: { 2434: { ask: 8500, sell: 8000, trades: 15 } } },
    );
    expect(ppotRes.ok).toBe(true);
    expect(ppotRes.step?.estimatedCoinCost).toBe(42_500);

    // Garbage ask above max(25_000, 10 * cost) is still rejected.
    const outlierRes = resolveAcquireItem(
        richAcct,
        { itemId: 536, quantity: 1, allowedSources: ['ge'] },
        { world, marketQuotes: { 536: { ask: 50_000, sell: 40_000, trades: 2 } } },
    );
    expect(outlierRes.ok).toBe(false);
});

test('own_bank for coins (995) preserves operating float, GE escrow, and prior committed coin spend', () => {
    const acct = makeAcct({
        inventory: {},
        bank: { items: { 995: 2_500 }, observedAt: NOW - 5_000, trusted: true },
    });
    const world: WorldSnapshot = {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: { Packhorse: acct },
        geEscrowCoins: { Packhorse: 1_000 },
    };

    // 2500 banked - 1000 GE escrow - 1000 operating float = 500 spendable; requesting 600 must fail own_bank.
    const overSpend = resolveAcquireItem(
        acct,
        { itemId: 995, quantity: 600, allowedSources: ['own_bank'] },
        { world },
    );
    expect(overSpend.ok).toBe(false);

    // Requesting 500 fits, unless committedCoinSpend already reserved 200.
    const exactOk = resolveAcquireItem(
        acct,
        { itemId: 995, quantity: 500, allowedSources: ['own_bank'] },
        { world },
    );
    expect(exactOk.ok).toBe(true);
    expect(exactOk.step?.coinFloatPreserved).toBe(1_000);

    const committedFail = resolveAcquireItem(
        acct,
        { itemId: 995, quantity: 500, allowedSources: ['own_bank'], committedCoinSpend: 200 },
        { world },
    );
    expect(committedFail.ok).toBe(false);
});

test('excludedMarketVenues skips allocated NPC shop and GE venues per item', () => {
    const rich = makeAcct({
        bank: { items: { 995: 50_000 }, observedAt: NOW - 5_000, trusted: true },
    });
    const world: WorldSnapshot = {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: { Packhorse: rich },
    };
    const quotes = { 1317: { ask: 4000, sell: 3500, trades: 12 } };

    const shopFirst = resolveAcquireItem(
        rich,
        { itemId: 1317, quantity: 1, allowOwnBank: false, allowedSources: ['npc_shop', 'ge'] },
        { world, marketQuotes: quotes },
    );
    expect(shopFirst.ok).toBe(true);
    expect(shopFirst.step?.source).toBe('npc_shop');
    const shopVenue = shopFirst.step!.venueKey!;

    const fallbackGe = resolveAcquireItem(
        rich,
        { itemId: 1317, quantity: 1, allowOwnBank: false, allowedSources: ['npc_shop', 'ge'] },
        { world, marketQuotes: quotes, excludedMarketVenues: new Set([shopVenue]) },
    );
    expect(fallbackGe.ok).toBe(true);
    expect(fallbackGe.step?.source).toBe('ge');

    const bothExcluded = resolveAcquireItem(
        rich,
        { itemId: 1317, quantity: 1, allowOwnBank: false, allowedSources: ['npc_shop', 'ge'] },
        {
            world,
            marketQuotes: quotes,
            excludedMarketVenues: new Set([shopVenue, marketCooldownKey(1317, 'ge')]),
        },
    );
    expect(bothExcluded.ok).toBe(false);
});

test('AcquireItem hub_banker allowPartial consolidates largest partial surplus while default still requires full quantity', () => {
    const recip = makeAcct({
        name: 'HolderBot',
        bank: { items: { 995: 1_000 }, observedAt: NOW - 5_000, trusted: true },
    });
    const donorSmall = makeAcct({
        name: 'DonorSmall',
        bank: { items: { 385: 30, 995: 1_000 }, observedAt: NOW - 5_000, trusted: true },
    });
    const donorLarge = makeAcct({
        name: 'DonorLarge',
        bank: { items: { 385: 75, 995: 1_000 }, observedAt: NOW - 5_000, trusted: true },
    });
    const world: WorldSnapshot = {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: { HolderBot: recip, DonorSmall: donorSmall, DonorLarge: donorLarge },
    };

    const strictRes = resolveAcquireItem(
        recip,
        { itemId: 385, quantity: 200, allowOwnBank: false, allowedSources: ['hub_banker'] },
        { world },
    );
    expect(strictRes.ok).toBe(false);

    const partialRes = resolveAcquireItem(
        recip,
        { itemId: 385, quantity: 200, allowOwnBank: false, allowedSources: ['hub_banker'], allowPartial: true },
        { world },
    );
    expect(partialRes.ok).toBe(true);
    expect(partialRes.step?.source).toBe('hub_banker');
    expect(partialRes.step?.donorAccount).toBe('DonorLarge');
    expect(partialRes.step?.quantity).toBe(75);
});

test('AcquireItem rejects shallow GE sell depth for full requests and caps allowPartial GE buys to quote.sell', () => {
    const richAcct = makeAcct({
        bank: { items: { 995: 500_000 }, observedAt: NOW - 5000, trusted: true },
    });
    const world: WorldSnapshot = {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: { Packhorse: richAcct },
    };

    const shallowFail = resolveAcquireItem(
        richAcct,
        { itemId: 536, quantity: 10, allowOwnBank: false, allowedSources: ['ge'] },
        { world, marketQuotes: { 536: { ask: 6000, sell: 3, trades: 20 } } },
    );
    expect(shallowFail.ok).toBe(false);

    const partialGe = resolveAcquireItem(
        richAcct,
        { itemId: 536, quantity: 10, allowOwnBank: false, allowPartial: true, allowedSources: ['ge'] },
        { world, marketQuotes: { 536: { ask: 6000, sell: 3, trades: 20 } } },
    );
    expect(partialGe.ok).toBe(true);
    expect(partialGe.step?.source).toBe('ge');
    expect(partialGe.step?.quantity).toBe(3);
    expect(partialGe.step?.estimatedCoinCost).toBe(18_000);
});
