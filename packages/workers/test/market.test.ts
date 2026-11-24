import { describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as botCore from '../../core/src/bot';
import * as walking from '../../core/src/walk';
import { MARKET_MODES, planGeRestockOrders, resolveMarketStep } from '../../../scripts/aio-market';
import {
    PROFILES,
    SWORD,
    estimateMarket,
    marketModule,
    preflightMarket,
    resolveShopProfile,
    runMarketWorker,
    selectItems,
    type BankSellerPolicy,
    type BuyListRequest,
    type GEPricePlan,
    type GETripRequest,
    type MarketConfig,
    type ShopTripJob,
} from '../src/market';
import {
    createWorkerRegistry,
    isWorkerModule,
    validatePreflightResult,
    validateRateEstimate,
    validateRunOutcome,
    type SessionCore,
    type WorkerAccountView,
    type WorkerWorldView,
} from '../src/contracts';

function makeAccount(overrides: Partial<WorkerAccountView> = {}): WorkerAccountView {
    return {
        name: 'MarketBot',
        side: 'local',
        protectedClock: false,
        skills: { Hitpoints: { level: 50, xp: 101_333 }, Magic: { level: 70, xp: 737_627 } },
        quests: { lostcity: 'complete' },
        pos: { x: 3185, z: 3436, level: 0 },
        inventory: { 995: 50_000 },
        equipment: {},
        bank: {
            items: { 995: 150_000, 1511: 25, 1205: 20 },
            observedAt: 1_700_000_000_000,
            trusted: true,
        },
        ...overrides,
    };
}

function makeWorld(acct: WorkerAccountView, overrides: Partial<WorkerWorldView> = {}): WorkerWorldView {
    return {
        at: 1_700_000_005_000,
        side: 'local',
        server: 'local',
        accounts: { [acct.name.toLowerCase()]: acct },
        reserves: {},
        globalReserves: {},
        geEscrowCoins: {},
        ...overrides,
    };
}

const sampleShopTripJob = (): ShopTripJob => ({
    merchant: 'alkharid-general',
    item: 1205,
    minimumUnit: 1,
    target: 4,
    batch: 2,
    cap: 1000,
    returnTicks: 200,
    members: false,
    reserve: 2,
});

const sampleBuyList = (now = Date.now()): BuyListRequest => ({
    actor: 'MarketBot',
    server: 'local',
    goal: 'contract-list',
    entries: [{ item: 1511, quantity: 2, basePrice: 10, percent: 10, unitCap: 12 }],
    budget: 24,
    reserve: 50,
    createdAt: now - 100,
    deadline: now + 60_000,
    fillWait: 5,
    cap: 1500,
});

const sampleGeTrip = (now = Date.now()): GETripRequest => ({
    actor: 'MarketBot',
    server: 'local',
    goal: 'contract-ge-trip',
    item: 1511,
    quantity: 5,
    price: 100,
    floor: 90,
    reserve: 2,
    deadline: now + 60_000,
    fillWait: 20,
    cap: 1200,
});

const sampleGePlan = (now = Date.now()): GEPricePlan => ({
    actor: 'MarketBot',
    server: 'local',
    goal: 'contract-ge-plan',
    item: 1511,
    quantity: 5,
    reserve: 2,
    floor: 90,
    deadline: now + 60_000,
    cap: 2000,
    prices: [{ price: 110, fillWait: 5 }],
});

const sampleBankSeller = (now = Date.now()): BankSellerPolicy => ({
    actor: 'MarketBot',
    server: 'local',
    goal: 'contract-bank-seller',
    allTradeable: true,
    protect: [],
    reserves: { 1511: 2 },
    maxItems: 2,
    maxUnits: 10,
    perItem: 5,
    discount: 10,
    floor: 1,
    unitCap: 500,
    fillWait: 5,
    deadline: now + 60_000,
    cap: 3000,
    childCap: 1200,
});

describe('market WorkerModule contract compliance', () => {
    test('marketModule satisfies WorkerModule invariants and registers in WorkerRegistry', () => {
        expect(isWorkerModule(marketModule)).toBe(true);
        expect(marketModule.id).toBe('market');
        expect(marketModule.family).toBe('market');
        expect(marketModule.kind).toBe('shop');
        expect(marketModule.trust).toBe('practice_passed');
        expect(marketModule.protectedAllowed).toBe(false);

        const registry = createWorkerRegistry([marketModule]);
        expect(registry.size()).toBe(1);
        expect(registry.require('market')).toBe(marketModule);
        expect(registry.list({ family: 'market', minTrust: 'practice_passed' })).toEqual([marketModule]);
    });

    test('preflight and estimate succeed with valid contract envelopes across all 12 market modes', () => {
        const acct = makeAccount();
        const world = makeWorld(acct);
        const dir = mkdtempSync(join(tmpdir(), 'market-contract-'));
        try {
            const jobFile = join(dir, 'trip.json');
            writeFileSync(jobFile, JSON.stringify(sampleShopTripJob()));
            const buyListFile = join(dir, 'buylist.json');
            writeFileSync(buyListFile, JSON.stringify(sampleBuyList()));

            const configs: MarketConfig[] = [
                { mode: 'shop-buy', profile: 'catherby', cap: 1500, items: 'rune arrowtips', stockTarget: 100 },
                { mode: 'earth-shop', profile: 'aubury', cap: 1600, target: 53, maximum: 50, spend: 2000, reserve: 30_000 },
                { mode: 'buy-sword', itemId: SWORD, cap: 900, maximumSpend: 2500 },
                { mode: 'shop-trip', job: sampleShopTripJob() },
                { mode: 'shop-sell', jobFile },
                { mode: 'ge-buy', itemId: 1331, quantity: 1, limitPrice: 20_000, cashReserve: 1000, orderMs: 60_000 },
                { mode: 'ge-sell', itemId: 1511, quantity: 5, sellPrice: 120, floorPrice: 100, reserveItems: 2, orderMs: 60_000 },
                { mode: 'ge-buy-list', requestFile: buyListFile },
                { mode: 'ge-trip', request: sampleGeTrip() },
                { mode: 'ge-plan', plan: sampleGePlan() },
                { mode: 'bank-seller', policy: sampleBankSeller() },
                { mode: 'shop-to-bid', profiles: ['sarim'], itemIds: [313], coinReserve: 1000 },
            ];

            for (const cfg of configs) {
                const pre = preflightMarket(acct, cfg, world);
                validatePreflightResult(pre);
                expect(pre.ok).toBe(true);

                const est = estimateMarket(acct, cfg, world);
                validateRateEstimate(est);
                expect(est.unitsPerTick).toBeGreaterThan(0);
                expect(est.minBatchUnits).toBeGreaterThanOrEqual(1);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);

    test('preflight refuses protected_clock, cooldown_active, skill_level, missing_coins with reserves/escrow/fares, missing_supply, invalid_config, and unreachable_tile', () => {
        const baseCfg: MarketConfig = { mode: 'shop-buy', profile: 'catherby' };

        // protected_clock
        const protectedAcct = makeAccount({ protectedClock: true });
        const protectedRes = preflightMarket(protectedAcct, baseCfg, makeWorld(protectedAcct));
        validatePreflightResult(protectedRes);
        expect(protectedRes.ok).toBe(false);
        expect(protectedRes.blockers.map(b => b.kind)).toContain('protected_clock');

        // cooldown_active
        const acct = makeAccount();
        const cooldownWorld = makeWorld(acct, {
            marketCooldowns: { 'shop:catherby': 1_700_000_060_000 },
        });
        const cooldownRes = preflightMarket(acct, baseCfg, cooldownWorld);
        validatePreflightResult(cooldownRes);
        expect(cooldownRes.ok).toBe(false);
        expect(cooldownRes.blockers[0]).toMatchObject({ kind: 'cooldown_active', key: 'shop:catherby' });

        // skill_level (magic_guild needs Magic 66)
        const lowMagic = makeAccount({ skills: { Magic: { level: 60, xp: 273_742 } } });
        const skillRes = preflightMarket(lowMagic, { mode: 'shop-buy', profile: 'magic_guild' }, makeWorld(lowMagic));
        validatePreflightResult(skillRes);
        expect(skillRes.ok).toBe(false);
        expect(skillRes.blockers).toContainEqual(expect.objectContaining({
            kind: 'skill_level',
            skill: 'Magic',
            required: 66,
            current: 60,
        }));

        // missing_coins accounting for reserve + escrow + ferryFare (1480 - 500 - 950 = 30 < 30 + 1)
        const poor = makeAccount({ inventory: { 995: 1480 }, bank: { items: {}, observedAt: 1_700_000_000_000, trusted: true } });
        const ferryWorld = makeWorld(poor, {
            reserves: { marketbot: { 995: 500 } },
            geEscrowCoins: { marketbot: 950 },
            world: {
                route: () => ({
                    ok: true,
                    cost: 80,
                    legs: [{ kind: 'travel', travel: { coins: 30 } as any, at: { x: 3028, z: 3221, level: 0 }, to: { x: 2683, z: 3271, level: 0 } }],
                }),
            } as unknown as WorkerWorldView['world'],
        });
        const coinRes = preflightMarket(poor, { mode: 'shop-buy', profile: 'catherby', coinReserve: 500 }, ferryWorld);
        validatePreflightResult(coinRes);
        expect(coinRes.ok).toBe(false);
        expect(coinRes.blockers).toContainEqual(expect.objectContaining({
            kind: 'missing_coins',
            available: 1480,
            reserved: 500,
            escrow: 950,
            ferryFare: 30,
        }));

        // missing_supply on ge-sell with item reserve
        const lowLogs = makeAccount({ inventory: {}, bank: { items: { 995: 1000, 1511: 6 }, observedAt: 1_700_000_000_000, trusted: true } });
        const supplyRes = preflightMarket(lowLogs, { mode: 'ge-sell', itemId: 1511, quantity: 5, sellPrice: 120, floorPrice: 100, reserveItems: 2, orderMs: 60_000 }, makeWorld(lowLogs));
        validatePreflightResult(supplyRes);
        expect(supplyRes.ok).toBe(false);
        expect(supplyRes.blockers).toContainEqual(expect.objectContaining({
            kind: 'missing_supply',
            itemId: 1511,
            available: 6,
            reserved: 2,
        }));

        // unreachable_tile
        const blockedWorld = makeWorld(acct, {
            world: { route: () => ({ ok: false, reason: 'no_route' }) } as unknown as WorkerWorldView['world'],
        });
        const routeRes = preflightMarket(acct, baseCfg, blockedWorld);
        validatePreflightResult(routeRes);
        expect(routeRes.ok).toBe(false);
        expect(routeRes.blockers).toContainEqual(expect.objectContaining({
            kind: 'unreachable_tile',
            reason: 'no_route',
        }));

        // invalid_config variants
        for (const bad of [
            {} as MarketConfig,
            { mode: 'shop-buy', profile: 'does-not-exist' } as MarketConfig,
            { mode: 'shop-buy', profile: 'catherby', items: 'dragon claws' } as MarketConfig,
            { mode: 'buy-sword', itemId: 1287, maximumSpend: 200 } as MarketConfig,
            { mode: 'shop-trip' } as MarketConfig,
            { mode: 'shop-to-bid', profiles: ['unknown'], itemIds: [313] } as MarketConfig,
            { mode: 'shop-to-bid', profiles: ['sarim'], itemIds: [995] } as MarketConfig,
        ]) {
            const invalidRes = preflightMarket(acct, bad, makeWorld(acct));
            validatePreflightResult(invalidRes);
            expect(invalidRes.ok).toBe(false);
            expect(invalidRes.blockers.some(b => b.kind === 'invalid_config')).toBe(true);
        }
    });

    test('runMarketWorker returns validated RunOutcomes for target_met, coin-reserve, missing_supply, and worker_defect', async () => {
        const makeSession = (options: {
            inv?: { id: number; name: string; count: number; slot: number }[];
            bank?: { id: number; name: string; count: number; slot: number }[];
            shopItems?: { id: number; name: string; count: number; buyPrice: number; baseCost: number; slot: number }[];
        }) => {
            let tick = 0;
            let bankOpen = false;
            let shopOpen = false;
            let gen = 1;
            const listeners = new Set<() => void>();
            const inv = options.inv ?? [];
            const bank = options.bank ?? [];
            const pos = { worldX: PROFILES.catherby!.bankSpot.x, worldZ: PROFILES.catherby!.bankSpot.z, level: 0 };
            const timer = setInterval(() => {
                tick++;
                for (const cb of [...listeners]) cb();
            }, 2);
            const session: SessionCore & { [k: string]: unknown } = {
                name: 'MarketBot',
                lifecycle: { account: 'MarketBot', server: 'local', attemptId: 'test-attempt', domain: 'practice', record: () => true },
                tick: () => tick,
                onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
                ended: new Promise(() => {}),
                direct: async () => ({ success: true }),
                close: async () => {},
                bankObservation: () => bankOpen ? { at: Date.now(), generation: gen, items: bank.map(i => ({ id: i.id, name: i.name, count: i.count })) } : null,
                sdk: {
                    getState: () => ({
                        player: pos,
                        skills: [{ name: 'Hitpoints', level: 50, baseLevel: 50, experience: 101_333 }],
                        inventory: inv,
                        equipment: [],
                        shop: {
                            isOpen: shopOpen,
                            shopItems: options.shopItems ?? [],
                            shopConfig: { sellMultiplier: 1000, haggle: 10 },
                        },
                        bank: { isOpen: bankOpen, items: bank },
                    }),
                    getStateAge: () => 0,
                    getInventory: () => inv,
                    getEquipment: () => [],
                    getSkill: () => ({ level: 50, baseLevel: 50 }),
                } as unknown as SessionCore['sdk'],
                bot: {
                    dismissBlockingUI: async () => {},
                    openBank: async () => { bankOpen = true; shopOpen = false; gen++; return { success: true }; },
                    closeBank: async () => { bankOpen = false; return { success: true }; },
                    closeInterface: async () => { bankOpen = false; shopOpen = false; return { success: true }; },
                    openShop: async () => { shopOpen = true; bankOpen = false; return { success: true }; },
                    closeShop: async () => { shopOpen = false; return { success: true }; },
                    withdrawItem: async () => ({ success: false, message: 'none' }),
                    depositItem: async () => ({ success: true }),
                    buyFromShop: async () => ({ success: false, amountBought: 0 }),
                } as unknown as SessionCore['bot'],
            };
            return { session, pos, stop: () => clearInterval(timer) };
        };

        // 1) Stock target already met in bank -> target_met
        const metFixture = makeSession({
            inv: [{ id: 995, name: 'Coins', count: 50_000, slot: 0 }],
            bank: PROFILES.catherby!.items.map((t, slot) => {
                const name = t.re.source.replace(/^\^|\$$/g, '');
                return { id: 40 + slot, name, count: 500, slot };
            }),
        });
        try {
            const out = await runMarketWorker(metFixture.session, {
                mode: 'shop-buy',
                profile: 'catherby',
                cap: 20,
                stockTarget: 500,
                stopAtTarget: true,
            });
            validateRunOutcome(out);
            expect(out.kind).toBe('target_met');
            expect(out.activityId).toBe('market:shop-buy');
        } finally {
            metFixture.stop();
        }

        // 2) market:shop-buy unguarded coin floor regression: when NO_BUY_TICKS=0, bank coins=0, and remaining wallet (< item.buyPrice yet >= 50)
        // cannot buy any needed item on the shelf, runShopBuy breaks cleanly with coin-reserve instead of spinning to cap=15000.
        const floorFixture = makeSession({
            inv: [{ id: 995, name: 'Coins', count: 80, slot: 0 }],
            bank: [],
            shopItems: [
                { id: 44, name: 'Rune arrowtips', count: 100, buyPrice: 260, baseCost: 260, slot: 0 },
                { id: 43, name: 'Adamant arrowtips', count: 200, buyPrice: 104, baseCost: 104, slot: 1 },
            ],
        });
        const worldSpy = spyOn(botCore, 'getWorld').mockResolvedValue({} as any);
        const walkerSpy = spyOn(walking, 'sessionWalker').mockResolvedValue({} as any);
        const walkPathSpy = spyOn(walking, 'walkPath').mockImplementation(async (_walker, points) => {
            const p = points.at(-1);
            if (p) Object.assign(floorFixture.pos, { worldX: p.x, worldZ: p.z });
            return { ok: true, ticks: 1 } as any;
        });
        const goToSpy = spyOn(walking, 'goTo').mockImplementation(async (_s, _w, to) => {
            Object.assign(floorFixture.pos, { worldX: to.x, worldZ: to.z });
            return { ok: true, ticks: 1 } as any;
        });
        try {
            const out = await runMarketWorker(floorFixture.session, {
                mode: 'shop-buy',
                profile: 'catherby',
                items: 'rune arrowtips|adamant arrowtips',
                cap: 200,
                noBuyTicks: 0,
                stockTarget: 500,
            });
            validateRunOutcome(out);
            expect(out.kind).toBe('missing_supply');
            expect(out.ticksElapsed).toBeLessThan(20);
        } finally {
            worldSpy.mockRestore();
            walkerSpy.mockRestore();
            walkPathSpy.mockRestore();
            goToSpy.mockRestore();
            floorFixture.stop();
        }

        // 3) Missing shop-trip JSON file returns worker_defect (validated)
        const dir = mkdtempSync(join(tmpdir(), 'market-run-'));
        try {
            const out = await runMarketWorker(floorFixture.session, {
                mode: 'shop-trip',
                jobFile: join(dir, 'missing-job.json'),
            });
            validateRunOutcome(out);
            expect(out.kind).toBe('worker_defect');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('scripts/aio-market.ts shim and resolveMarketStep', () => {
    test('all 12 MARKET_MODES resolve via resolveMarketStep to scripts/aio-market.ts with canonical mode arg', () => {
        expect(MARKET_MODES).toHaveLength(12);
        for (const spec of MARKET_MODES) {
            const step = resolveMarketStep(spec.mode, ['FOO=bar']);
            expect(step.script).toBe('scripts/aio-market.ts');
            expect(step.args[0]).toBe(spec.mode);
            expect(step.env.FOO).toBe('bar');
        }
        expect(resolveShopProfile('data:armourshop')).toBeDefined();
        expect(Object.keys(PROFILES).length).toBeGreaterThan(20);
    });

    test('planGeRestockOrders prices unheld demand with positive buffer and respects coinReserve', () => {
        const plan = planGeRestockOrders({
            actor: 'Nat',
            server: 'local',
            goalPrefix: 'restock',
            shortfalls: {
                561: { quantity: 60, limitPrice: 210, expectedOwned: 40 },
                383: { quantity: 10, limitPrice: 1050 },
            },
            coinsAvailable: 20_000,
            coinReserve: 1000,
            now: 1000,
        });
        expect(plan.funded).toHaveLength(1);
        expect(plan.funded[0]).toMatchObject({ item: 383, quantity: 10, limit: 1050, reserve: 1000 });
        expect(plan.unfunded).toEqual([561]);
        expect(plan.totalEscrow).toBe(10_500);
        expect(plan.remainingCoins).toBe(9500);
        expect(existsSync('scripts/aio-market.ts')).toBe(true);
    });

    test('marketModule normalizes brain shopId/itemId/quantity shop-buy configs and honors cfg.stop / session.ended', async () => {
        const acct = makeAccount({ bank: { items: { 995: 50_000 }, observedAt: 1, trusted: true } });
        const world = makeWorld(acct);
        const brainCfg = {
            mode: 'shop-buy',
            shopId: 'aubury',
            itemId: 556, // Air rune
            quantity: 25,
        } as unknown as MarketConfig;
        const pre = preflightMarket(acct, brainCfg, world);
        expect(pre.ok).toBe(true);
        const est = estimateMarket(acct, brainCfg, world);
        expect(est.unitsPerTick).toBeGreaterThan(0);

        const badBrainCfg = { mode: 'shop-buy', shopId: 'unknown-shop', itemId: 556, quantity: 10 } as unknown as MarketConfig;
        const badPre = preflightMarket(acct, badBrainCfg, world);
        expect(badPre.ok).toBe(false);
        if (!badPre.ok) expect(badPre.blockers.some(b => b.kind === 'invalid_config')).toBe(true);

        const endedOut = await marketModule.run(
            {
                name: 'StoppedTrader',
                tick: () => 5,
                ended: Promise.resolve(),
                sdk: {
                    getState: () => ({ player: { worldX: 3164, worldZ: 3487, level: 0 } }),
                    getInventory: () => [],
                    getEquipment: () => [],
                },
            } as any,
            { mode: 'shop-trip', jobFile: '/nonexistent-market-job.json' },
        );
        validateRunOutcome(endedOut);
        expect(endedOut.kind).toBe('session_unsettled');
    });
});
