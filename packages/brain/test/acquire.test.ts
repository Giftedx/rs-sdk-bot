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
import { hubRouteCooldownKey } from '../src/transfer-memory';
import { loadItemsMap } from '../src/preflight';
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

test('hub_banker skips a party whose walk to the hub failed in a recent trade, whatever the item', () => {
    // The worker fails with "route to 3182, 3440: precondition no route to 3182,3440,0" for any item it carries.
    const recip = makeAcct({ inventory: { 995: 1050 }, bank: { items: { 311: 1 }, observedAt: NOW - 10_000, trusted: true } });
    const donor = makeAcct({ name: 'Bigpackage', pos: { x: 3185, z: 3436, level: 0 }, bank: { items: { 383: 300, 995: 5000 }, observedAt: NOW - 10_000, trusted: true } });
    const ask = (r: AccountState, d: AccountState) => resolveAcquireItem(r, { itemId: 383, quantity: 50, operatingCoinFloat: 1000 }, {
        world: { schemaVersion: 1, at: NOW, side: 'local', server: 'rs-sdk-demo.fly.dev', accounts: { Packhorse: r, Bigpackage: d } },
        activities: [CATCH_RAW_SHARK], marketQuotes: { 383: { ask: 400, sell: 380, trades: 20 } },
    });
    expect(ask(recip, donor).step?.source).toBe('hub_banker');
    const blocked = { [hubRouteCooldownKey('varrock_west')]: NOW + 60_000 };
    expect(ask({ ...recip, cooldowns: blocked }, donor).candidates.map((c) => c.source)).not.toContain('hub_banker');
    expect(ask(recip, { ...donor, cooldowns: blocked }).candidates.map((c) => c.source)).not.toContain('hub_banker');
    // An expired backoff holds nothing.
    expect(ask({ ...recip, cooldowns: { [hubRouteCooldownKey('varrock_west')]: NOW - 1 } }, donor).step?.source).toBe('hub_banker');
});

test('hub_banker never picks a party that cannot pay the two boat fares to the hub', () => {
    // Live: "fleet-trade ... failed 0/918: Error: route to 2618, 3333: precondition ferry needs 60 coins and the bank holds 0".
    const RAW_SHARK = 383;
    const req = { itemId: RAW_SHARK, quantity: 50, operatingCoinFloat: 1000 };
    const world = (accounts: Record<string, AccountState>): WorldSnapshot => ({
        schemaVersion: 1, at: NOW, side: 'local', server: 'rs-sdk-demo.fly.dev', accounts,
    });
    const recipient = (coins: number) => makeAcct({
        pos: { x: 3185, z: 3436, level: 0 },
        inventory: coins ? { 995: coins } : {},
        bank: { items: {}, observedAt: NOW - 10_000, trusted: true },
    });
    const donor = (coins: number) => makeAcct({
        name: 'Bigpackage',
        pos: { x: 2619, z: 3332, level: 0 },
        inventory: {},
        bank: { items: coins ? { [RAW_SHARK]: 300, 995: coins } : { [RAW_SHARK]: 300 }, observedAt: NOW - 10_000, trusted: true },
    });
    const resolve = (r: AccountState, d: AccountState) => resolveAcquireItem(r, req, { world: world({ Packhorse: r, Bigpackage: d }), activities: [], marketQuotes: {} });

    // The hub is Varrock West, beside the recipient. The donor crosses from Ardougne.
    const broke = resolve(recipient(0), donor(59));
    expect(broke.step?.source).not.toBe('hub_banker');
    const paid = resolve(recipient(0), donor(60));
    expect(paid.step?.source).toBe('hub_banker');
    expect(paid.step?.donorAccount).toBe('Bigpackage');

    // East of White Wolf Mountain, inside the Kandarin box: with a recorded no-route to Ardougne North the walk east
    // takes no boat (test/ferry-fare.test.ts), so a donor with 0 coins there can still trade at Varrock West.
    const from = { x: 2793, z: 3516, level: 0 };
    const stranded = (noRoute: boolean): AccountState => ({
        ...donor(0),
        pos: from,
        ...(noRoute ? { noRoutes: [{ from, to: { x: 2619, z: 3332, level: 0 }, activityId: 'gather:x', observedAt: NOW - 1000, expiresAt: NOW + 3_600_000 }] } : {}),
    });
    expect(resolve(recipient(0), stranded(false)).step?.source).not.toBe('hub_banker');
    expect(resolve(recipient(0), stranded(true)).step?.source).toBe('hub_banker');
});

test('hub_banker counts the coins that earlier chain steps spend against the recipient fare', () => {
    const RAW_SHARK = 383;
    // Taverley: the nearest hub is Ardougne North and the walk there takes 60 coins of boat fares.
    const recipient = makeAcct({
        pos: { x: 2900, z: 3500, level: 0 },
        inventory: { 995: 100 },
        bank: { items: {}, observedAt: NOW - 10_000, trusted: true },
    });
    const donor = makeAcct({
        name: 'Bigpackage',
        pos: { x: 2619, z: 3332, level: 0 },
        inventory: {},
        bank: { items: { [RAW_SHARK]: 300 }, observedAt: NOW - 10_000, trusted: true },
    });
    const world: WorldSnapshot = {
        schemaVersion: 1, at: NOW, side: 'local', server: 'rs-sdk-demo.fly.dev', accounts: { Packhorse: recipient, Bigpackage: donor },
    };
    const resolve = (committedCoinSpend: number) => resolveAcquireItem(
        recipient,
        { itemId: RAW_SHARK, quantity: 50, allowedSources: ['hub_banker'], committedCoinSpend },
        { world, activities: [], marketQuotes: {} },
    );
    expect(resolve(0).step?.source).toBe('hub_banker');
    expect(resolve(60).step?.source).not.toBe('hub_banker');
});

test('hub_banker never picks a donor whose only copy is worn', () => {
    // The trade worker gives from the bank and the pack only (`stock short: <item> 0 banked + 0 held`).
    const RUNE_SCIMITAR = 1333;
    const recipient = makeAcct({
        inventory: { 995: 1050 },
        bank: { items: {}, observedAt: NOW - 10_000, trusted: true },
    });
    const wearer = makeAcct({
        name: 'Awearer',
        pos: { x: 3185, z: 3436, level: 0 },
        equipment: { [RUNE_SCIMITAR]: 1 },
        bank: { items: { 995: 5000 }, observedAt: NOW - 10_000, trusted: true },
    });
    const banker = makeAcct({
        name: 'Bbanker',
        pos: { x: 3185, z: 3436, level: 0 },
        bank: { items: { [RUNE_SCIMITAR]: 1, 995: 5000 }, observedAt: NOW - 10_000, trusted: true },
    });
    const req = { itemId: RUNE_SCIMITAR, quantity: 1, operatingCoinFloat: 1000 };
    const quotes = { [RUNE_SCIMITAR]: { ask: 20_000, sell: 19_000, trades: 20 } };
    const world = (accounts: Record<string, AccountState>): WorldSnapshot => ({
        schemaVersion: 1, at: NOW, side: 'local', server: 'rs-sdk-demo.fly.dev', accounts,
    });

    const both = resolveAcquireItem(recipient, req, {
        world: world({ Packhorse: recipient, Awearer: wearer, Bbanker: banker }),
        marketQuotes: quotes,
    });
    expect(both.step?.source).toBe('hub_banker');
    expect(both.step?.donorAccount).toBe('Bbanker');

    const wearerOnly = resolveAcquireItem(recipient, req, {
        world: world({ Packhorse: recipient, Awearer: wearer }),
        marketQuotes: quotes,
    });
    expect(wearerOnly.candidates.map((c) => c.source)).not.toContain('hub_banker');

    // A worn copy plus a banked copy leaves the banked one to give.
    const both2 = makeAcct({ ...wearer, bank: { items: { [RUNE_SCIMITAR]: 1, 995: 5000 }, observedAt: NOW - 10_000, trusted: true } });
    const spare = resolveAcquireItem(recipient, req, {
        world: world({ Packhorse: recipient, Awearer: both2 }),
        marketQuotes: quotes,
    });
    expect(spare.step?.donorAccount).toBe('Awearer');
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

test('no shop source is on Entrana, where the walker has no route', async () => {
    const { offMap } = await import('../../core/src/shop-index');
    // Frincos (herbloreshop2, 2808,3342) is the only seller of his shop and stands on Entrana.
    expect(derivedProfile('herbloreshop2')).toBeUndefined();
    expect(derivedProfile('herbloreshop')?.npcSpot).toEqual({ x: 2899, z: 3427 });
    for (const list of loadShopCatalogByItem().values()) {
        for (const e of list) {
            expect(e.tile).toBeDefined();
            expect(offMap(e.tile!)).toBe(false);
        }
    }
    expect((loadShopCatalogByItem().get(233) ?? []).map((e) => e.shop)).not.toContain('herbloreshop2');
});

test('a pestle and mortar buy from Ardougne goes to a mainland seller', () => {
    const acct = makeAcct({ name: 'Fingerblastr', pos: { x: 2619, z: 3332, level: 0 }, inventory: { 995: 20_000 }, bank: { items: { 995: 20_000 }, observedAt: NOW - 10_000, trusted: true } });
    const world: WorldSnapshot = { schemaVersion: 1, at: NOW, side: 'local', server: 'rs-sdk-demo.fly.dev', accounts: { Fingerblastr: acct } };
    const r = resolveAcquireItem(acct, { itemId: 233, quantity: 1, allowedSources: ['npc_shop'] }, { world });
    expect(r.ok).toBe(true);
    expect(r.step?.source).toBe('npc_shop');
    expect(r.step?.shopId).not.toBe('herbloreshop2');
});

test('a feather buy below Fishing 68 skips the Fishing Guild shop, whose seller stands behind the guild door', () => {
    const guild = (loadShopCatalogByItem().get(314) ?? []).find((e) => e.shop === 'fishingguild');
    expect(guild?.requiresSkill).toEqual({ skill: 'fishing', level: 68 });
    const acct = makeAcct({
        name: 'Featherless',
        skills: { Fishing: { level: 1, xp: 0 }, Magic: { level: 39, xp: 15_000 } },
        pos: { x: 2618, z: 3332, level: 0 },
        inventory: { 995: 1516 },
        bank: { items: { 995: 5000 }, observedAt: NOW - 10_000, trusted: true },
    });
    const world: WorldSnapshot = { schemaVersion: 1, at: NOW, side: 'local', server: 'rs-sdk-demo.fly.dev', accounts: { Featherless: acct } };
    const r = resolveAcquireItem(acct, { itemId: 314, quantity: 250, allowedSources: ['npc_shop'] }, { world });
    expect(r.step?.shopId).not.toBe('fishingguild');
});

test('a shop with no seller tile is no source', () => {
    const acct = makeAcct();
    const world: WorldSnapshot = { schemaVersion: 1, at: NOW, side: 'local', server: 'rs-sdk-demo.fly.dev', accounts: { Packhorse: acct } };
    const shop = { shop: 'tileless_test_shop', itemId: 1931, stock: 30, restockTicks: 10, cost: 1 };
    const r = resolveAcquireItem(acct, { itemId: 1931, quantity: 1, allowedSources: ['npc_shop'] }, { world, customShops: [shop] });
    expect(r.step?.shopId).not.toBe('tileless_test_shop');
    const tiled = resolveAcquireItem(acct, { itemId: 1931, quantity: 1, allowedSources: ['npc_shop'] }, { world, customShops: [{ ...shop, tile: { x: 3093, z: 3245, level: 0 } }] });
    expect(tiled.step?.shopId).toBe('tileless_test_shop');
});

test('a market acquire step names its market activity, so a failed chain buy reaches the outcome classifier', () => {
    const acct = makeAcct();
    const world: WorldSnapshot = { schemaVersion: 1, at: NOW, side: 'local', server: 'rs-sdk-demo.fly.dev', accounts: { Packhorse: acct } };
    const shop = { shop: 'fish_test_shop', itemId: 383, stock: 50, restockTicks: 10, cost: 250, tile: { x: 3093, z: 3245, level: 0 } };
    const viaShop = resolveAcquireItem(acct, { itemId: 383, quantity: 5, allowedSources: ['npc_shop'] }, { world, customShops: [shop] });
    expect(viaShop.step?.source).toBe('npc_shop');
    expect(viaShop.step?.activityId).toBe('market:shop-buy');
    const viaGe = resolveAcquireItem(acct, { itemId: 383, quantity: 5, allowedSources: ['ge'] }, { world, marketQuotes: { 383: { ask: 400, sell: 380, trades: 15 } } });
    expect(viaGe.step?.source).toBe('ge');
    expect(viaGe.step?.activityId).toBe('market:ge-buy');
});

test('a shop whose restock wait exceeds one shop-buy run is no source for a full order, and caps a partial order', () => {
    const acct = makeAcct();
    const world: WorldSnapshot = { schemaVersion: 1, at: NOW, side: 'local', server: 'rs-sdk-demo.fly.dev', accounts: { Packhorse: acct } };
    // The Ardougne gem stall shape: 2 on the shelf, a restock each 15000 ticks.
    const stall = { shop: 'slow_test_stall', itemId: 383, stock: 2, restockTicks: 15_000, cost: 250, tile: { x: 3093, z: 3245, level: 0 } };
    const full = resolveAcquireItem(acct, { itemId: 383, quantity: 10, allowedSources: ['npc_shop'] }, { world, customShops: [stall] });
    expect(full.ok).toBe(false);
    expect(full.skippedReasons.some((r) => r.source === 'npc_shop' && /restock wait 60000 .* > cap 3000/.test(r.reason))).toBe(true);
    const partial = resolveAcquireItem(acct, { itemId: 383, quantity: 10, allowPartial: true, allowedSources: ['npc_shop'] }, { world, customShops: [stall] });
    expect(partial.step?.shopId).toBe('slow_test_stall');
    expect(partial.step?.quantity).toBe(2);
    expect(partial.step?.estimatedCoinCost).toBe(500);
    const shelf = resolveAcquireItem(acct, { itemId: 383, quantity: 2, allowedSources: ['npc_shop'] }, { world, customShops: [stall] });
    expect(shelf.step?.shopId).toBe('slow_test_stall');
    expect(shelf.step?.quantity).toBe(2);
});

test('an empty seller shelf sends the order to the GE unless the next seller is cheaper in ticks and coins', () => {
    const acct = makeAcct({ bank: { items: { 995: 10_000 }, observedAt: NOW - 10_000, trusted: true } });
    const base: WorldSnapshot = { schemaVersion: 1, at: NOW, side: 'local', server: 'rs-sdk-demo.fly.dev', accounts: { Packhorse: acct } };
    const tile = { x: 3093, z: 3245, level: 0 };
    const emptied = { shop: 'stall_a', itemId: 383, stock: 5, restockTicks: 100, cost: 250, tile };
    const next = (cost: number) => ({ shop: 'stall_b', itemId: 383, stock: 5, restockTicks: 100, cost, tile });
    const quotes = { 383: { ask: 300, sell: 500, trades: 20 } };
    const req = () => ({ itemId: 383, quantity: 1, allowedSources: ['npc_shop' as const, 'ge' as const] });
    // Another account saw stall_a empty a minute ago (core/src/shop-shelf.ts).
    const seenEmpty: WorldSnapshot = { ...base, shopShelves: { '383:shop:stall_a': { count: 0, at: NOW - 60_000 } } };

    const pricier = resolveAcquireItem(acct, req(), { world: seenEmpty, marketQuotes: quotes, customShops: [emptied, next(400)] });
    expect(pricier.step?.source).toBe('ge');
    expect(pricier.skippedReasons.map((r) => r.reason)).toContainEqual(expect.stringMatching(/shop:stall_b is not cheaper than the GE/));
    // A cheaper and quicker seller next to the account keeps the order.
    const cheaper = resolveAcquireItem(acct, req(), { world: seenEmpty, marketQuotes: quotes, customShops: [emptied, next(200)] });
    expect(cheaper.step).toMatchObject({ source: 'npc_shop', shopId: 'stall_b' });
    // A stock-out cooldown on stall_a is the same signal.
    const cooled = resolveAcquireItem(acct, req(), {
        world: { ...base, marketCooldowns: { [marketCooldownKey(383, 'shop:stall_a')]: NOW + 600_000 } }, marketQuotes: quotes, customShops: [emptied, next(400)],
    });
    expect(cooled.step?.source).toBe('ge');
    // With no empty shelf known, the shop order keeps its source order.
    const fresh = resolveAcquireItem(acct, req(), { world: base, marketQuotes: quotes, customShops: [next(400)] });
    expect(fresh.step).toMatchObject({ source: 'npc_shop', shopId: 'stall_b' });
    // An empty shelf seen longer ago than the stock-out window is no signal.
    const old = resolveAcquireItem(acct, req(), {
        world: { ...base, shopShelves: { '383:shop:stall_a': { count: 0, at: NOW - 20 * 60_000 } } }, marketQuotes: quotes, customShops: [emptied],
    });
    expect(old.step).toMatchObject({ source: 'npc_shop', shopId: 'stall_a' });

    // A fresh part shelf adds the restock wait for the rest of the order.
    const full = resolveAcquireItem(acct, { itemId: 383, quantity: 5, allowedSources: ['npc_shop'] }, { world: base, customShops: [next(200)] });
    const part = resolveAcquireItem(acct, { itemId: 383, quantity: 5, allowedSources: ['npc_shop'] }, {
        world: { ...base, shopShelves: { '383:shop:stall_b': { count: 2, at: NOW - 60_000 } } }, customShops: [next(200)],
    });
    expect(part.step!.estimatedTicks - full.step!.estimatedTicks).toBe(100);
});

test('a GE buy whose pack would hold over 26 items after banking coins and the item is refused before login', () => {
    const slots = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [1000 + i, 1]));
    const world = (a: AccountState): WorldSnapshot => ({ schemaVersion: 1, at: NOW, side: 'local', server: 'rs-sdk-demo.fly.dev', accounts: { Packhorse: a } });
    const quotes = { 314: { ask: 5, sell: 500, trades: 10 } };
    const geOnly = { itemId: 314, quantity: 100, allowedSources: ['ge' as const] };
    const full = makeAcct({ packSlots: slots(27) });
    const refused = resolveAcquireItem(full, geOnly, { world: world(full), marketQuotes: quotes });
    expect(refused.ok).toBe(false);
    expect(refused.skippedReasons).toContainEqual({ source: 'ge', reason: 'pack holds 27 items after banking coins and the item, over 26: two collection slots unavailable' });
    // The buy banks coins and the item itself, so their slots do not count.
    const banked = makeAcct({ packSlots: { ...slots(25), 995: 1, 314: 2 } });
    expect(resolveAcquireItem(banked, geOnly, { world: world(banked), marketQuotes: quotes }).step?.source).toBe('ge');
    // A status with no pack rows leaves the check to the worker.
    expect(resolveAcquireItem(makeAcct(), geOnly, { world: world(makeAcct()), marketQuotes: quotes }).step?.source).toBe('ge');
});

test('a venue that failed is not planned again and the plan reaches the GE; a GE buy that cannot be placed is no source', () => {
    const acct = makeAcct({ bank: { items: { 995: 10_000 }, observedAt: NOW - 10_000, trusted: true } });
    const world: WorldSnapshot = { schemaVersion: 1, at: NOW, side: 'local', server: 'rs-sdk-demo.fly.dev', accounts: { Packhorse: acct } };
    const quotes = { 314: { ask: 5, sell: 500, trades: 10 } };
    const req = () => ({ itemId: 314, quantity: 100, allowedSources: ['npc_shop' as const, 'ge' as const] });
    const shops = new Set((loadShopCatalogByItem().get(314) ?? []).map((s) => s.shop));
    // Each empty shop cools down its own venue key (outcome-classifier market_unavailable); the next plan takes another.
    const cooled: Record<string, number> = {};
    const seen: string[] = [];
    let step = resolveAcquireItem(acct, req(), { world, marketQuotes: quotes }).step;
    expect(step?.source).toBe('npc_shop');
    while (step?.source === 'npc_shop') {
        expect(seen).not.toContain(step.shopId!);
        seen.push(step.shopId!);
        expect(seen.length).toBeLessThanOrEqual(shops.size);
        cooled[marketCooldownKey(314, `shop:${step.shopId}`)] = NOW + 600_000;
        step = resolveAcquireItem(acct, req(), { world: { ...world, marketCooldowns: { ...cooled } }, marketQuotes: quotes }).step;
    }
    expect(step?.source).toBe('ge');

    // No GE offers in the market cache, an item that does not trade, or an ask over the price cap: the plan refuses
    // the GE before any login.
    const geOnly = () => ({ itemId: 314, quantity: 100, allowedSources: ['ge' as const] });
    const noQuote = resolveAcquireItem(acct, geOnly(), { world, marketQuotes: {} });
    expect(noQuote.ok).toBe(false);
    expect(noQuote.skippedReasons).toContainEqual({ source: 'ge', reason: 'no valid GE ask quote in market cache' });
    const capped = resolveAcquireItem(acct, { ...geOnly(), maxUnitPrice: 4 }, { world, marketQuotes: quotes });
    expect(capped.ok).toBe(false);
    expect(capped.skippedReasons).toContainEqual({ source: 'ge', reason: 'GE ask 5 > maxUnitPrice 4' });
    const untradeable = [...loadItemsMap().values()].find((i) => !i.tradeable && i.id !== 995)!;
    const bound = resolveAcquireItem(acct, { itemId: untradeable.id, quantity: 1, allowedSources: ['ge'] }, {
        world, marketQuotes: { [untradeable.id]: { ask: 5, sell: 500, trades: 10 } },
    });
    expect(bound.ok).toBe(false);
    expect(bound.skippedReasons).toContainEqual({ source: 'ge', reason: 'item is untradeable' });
});
