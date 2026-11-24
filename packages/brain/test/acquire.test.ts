import { expect, test } from 'bun:test';
import {
    ACQUIRE_SOURCE_ORDER,
    DEFAULT_OPERATING_COIN_FLOAT,
    isAcquireStep,
    marketCooldownKey,
    type AccountState,
    type ActivityDefinition,
    type WorldSnapshot,
} from '../src/contracts';
import { loadShopCatalogByItem, resolveAcquireItem } from '../src/acquire';
import { derivedProfile } from '../../workers/src/market/shop-profiles';

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
        marketQuotes: { 314: { ask: 5, sell: 4, trades: 10 } },
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
            marketQuotes: { 314: { ask: 5, sell: 4, trades: 10 } },
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

test('loadShopCatalogByItem only emits runnable derivedProfile shops and excludes unreachable shops', () => {
    const catalog = loadShopCatalogByItem();
    expect(catalog.size).toBeGreaterThan(0);
    const allShops = new Set<string>();
    for (const entries of catalog.values()) {
        for (const entry of entries) {
            allShops.add(entry.shop);
            expect(Boolean(derivedProfile(entry.shop))).toBe(true);
        }
    }
    expect(allShops.has('cheapringshop')).toBe(false);
    expect(allShops.has('gnomeshop_gulluck')).toBe(false);
});
