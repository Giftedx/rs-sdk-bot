import { describe, expect, test } from 'bun:test';
import { resolveAcquireItem } from '../src/acquire';
import { createActivityCatalog } from '../src/catalog';
import { activityPreflightFromConfig } from '../src/preflight';
import { resolveActivityWorkerRoute, resolvePlannedStepWorkerRoute } from '../src/worker-routing';
import type { AccountState, WorldSnapshot } from '../src/contracts';

const NOW = 1_800_000_000_000;

function makeTestAccount(overrides: Partial<AccountState> = {}): AccountState {
    return {
        name: 'ParityBot',
        side: 'local',
        role: 'helper',
        protectedClock: false,
        lifecycle: 'idle',
        skills: {},
        quests: {},
        pos: { x: 3253, z: 3420, level: 0 },
        inventory: { 995: 5000 },
        equipment: {},
        bank: { items: {}, observedAt: NOW - 5_000, trusted: true },
        ...overrides,
    };
}

describe('catalog-worker parity', () => {
    test('all practice_passed and live_proven catalog entries resolve cleanly without routing warnings', () => {
        const catalog = createActivityCatalog();
        const qualified = catalog.list().filter((a) => a.trust !== 'experimental');
        expect(qualified.length).toBeGreaterThan(100);

        for (const act of qualified) {
            const route = resolveActivityWorkerRoute(act);
            expect(route.warnings).toEqual([]);
            expect(route.routeKey.length).toBeGreaterThan(0);
        }
    });

    test('bank-artisan:magic-earth-production enforces Runecraft 9, Rune Mysteries, talisman, essence, and routes craft mode', () => {
        const catalog = createActivityCatalog();
        const earthAct = catalog.require('bank-artisan:magic-earth-production');
        expect(earthAct.skill).toBe('Runecraft');
        expect(earthAct.spotId).toBe('earth-altar');
        expect(earthAct.maxConcurrentAccounts).toBe(4);

        const world: WorldSnapshot = {
            schemaVersion: 1,
            at: NOW,
            side: 'local',
            server: 'rs-sdk-demo.fly.dev',
            accounts: {},
        };

        // Account with Magic 9 only (missing Runecraft 9, Rune Mysteries, talisman, essence) must fail preflight.
        const magicOnly = makeTestAccount({
            skills: { Magic: { level: 9, xp: 1000 }, Runecraft: { level: 1, xp: 0 } },
        });
        const failPre = activityPreflightFromConfig(magicOnly, earthAct, world, 1);
        expect(failPre.ok).toBe(false);
        const blockerKinds = new Set(failPre.blockers.map((b) => b.kind));
        expect(blockerKinds.has('skill_level')).toBe(true);
        expect(blockerKinds.has('quest_incomplete')).toBe(true);
        expect(blockerKinds.has('missing_supply')).toBe(true);

        // Account with Runecraft 9, Rune Mysteries, Earth talisman (1440), and Rune essence (1436) passes preflight.
        const readyBot = makeTestAccount({
            skills: { Runecraft: { level: 9, xp: 1000 } },
            quests: { runemysteries: 'complete' },
            bank: { items: { 1440: 1, 1436: 50, 995: 5000 }, observedAt: NOW - 5_000, trusted: true },
        });
        const passPre = activityPreflightFromConfig(readyBot, earthAct, world, 27);
        expect(passPre.ok).toBe(true);

        const route = resolveActivityWorkerRoute(earthAct);
        expect(route.family).toBe('bank-artisan');
        expect(route.args.slice(0, 3)).toEqual(['magic', 'earth-production', 'craft']);
    });

    test('quest prerequisites, multi-account quest blocks, specialist isolation, and combat survivability gates', () => {
        const catalog = createActivityCatalog();
        const world: WorldSnapshot = {
            schemaVersion: 1,
            at: NOW,
            side: 'local',
            server: 'rs-sdk-demo.fly.dev',
            accounts: {},
        };
        const fresh = makeTestAccount({
            skills: { Hitpoints: { level: 10, xp: 1154 }, Magic: { level: 1, xp: 0 }, Prayer: { level: 1, xp: 0 } },
        });

        for (const qId of ['quest:viking', 'quest:itwatchtower', 'quest:horror', 'quest:druidspirit', 'quest:magearena']) {
            const act = catalog.require(qId);
            const pre = activityPreflightFromConfig(fresh, act, world, 1);
            expect(pre.ok).toBe(false);
            expect(pre.blockers.some((b) => b.kind === 'skill_level' || b.kind === 'quest_incomplete')).toBe(true);
        }

        for (const blockedId of ['quest:arrav', 'quest:hero', 'quest:legends', 'gather:fishing-specialist', 'combat:ranged-specialist']) {
            expect(catalog.require(blockedId).trust).toBe('experimental');
        }

        for (const combatId of ['combat:boss-kbd', 'combat:fire-giant', 'combat:boss-green-dragon']) {
            const pre = activityPreflightFromConfig(fresh, catalog.require(combatId), world, 1);
            expect(pre.ok).toBe(false);
            expect(pre.blockers.some((b) => b.kind === 'combat_survivability' || b.kind === 'quest_incomplete')).toBe(true);
        }
    });

    test('herblore:meats gives 0 XP, herblore:potions requires druid, and runnable CLI defaults are populated', () => {
        const catalog = createActivityCatalog();
        const meats = catalog.require('bank-artisan:herblore-meats');
        expect(meats.baselineRate.xpPerTick).toBe(0);

        const potions = catalog.require('bank-artisan:herblore-potions');
        expect(potions.config.requiredQuests).toEqual(['druid']);

        expect(catalog.require('gather:mining-progressive').trust).toBe('experimental');
        expect(catalog.require('gather:mining-at-site').config.requiredLevel).toBe(15);

        const miningRoute = resolveActivityWorkerRoute(catalog.require('gather:mining-at-site'));
        expect(miningRoute.args).toEqual(['mining', 'at-site', 'iron_rock_table', '200', '3000']);

        const trooperRoute = resolveActivityWorkerRoute(catalog.require('combat:trooper'));
        expect(trooperRoute.env.TRAIN_SKILL).toBe('Strength');
        expect(trooperRoute.env.TARGET_LEVEL).toBe('90');

        const splashRoute = resolveActivityWorkerRoute(catalog.require('combat:magic-splash'));
        expect(splashRoute.args).toEqual(['magic', 'splash', '55', '3000']);

        const splashCoopRoute = resolveActivityWorkerRoute(catalog.require('combat:magic-splash-coop'));
        expect(splashCoopRoute.args).toEqual(['magic', 'splash-coop', '19', '3000']);
        expect(splashCoopRoute.env.SPLASH_SITE).toBe('coop');

        const magicOrderRoute = resolveActivityWorkerRoute(catalog.require('bank-artisan:magic-order'));
        expect(magicOrderRoute.env.TARGET_LEVEL).toBe('55');

        expect(catalog.require('gather:mining-loot').baselineRate.xpPerTick).toBe(0);
        for (const nonAutonomousId of [
            'gather:mining-lava-maze',
            'gather:mining-at-site',
            'gather:mining-drop',
            'bank-artisan:firemaking-line',
            'gather:thieving-stun-base',
            'gather:thieving-stun-bury',
            'gather:thieving-stun-enchant',
            'gather:thieving-pickpocket-at-site',
            'bank-artisan:magic-orbs-at-site',
            'combat:chompy-at-site',
            'combat:boss-trawler-at-site',
        ]) {
            expect(catalog.require(nonAutonomousId).trust).toBe('experimental');
        }

        const stallsRoute = resolveActivityWorkerRoute(catalog.require('gather:thieving-stalls'));
        expect(stallsRoute.args).toEqual(['thieving', 'stalls', 'stealing_bakery_stall', '28', '600']);

        const agilityOrderRoute = resolveActivityWorkerRoute(catalog.require('agility:agility-order'));
        expect(agilityOrderRoute.env.TARGET_LEVEL).toBe('99');

        expect(catalog.require('combat:trooper').skills ?? []).not.toContain('Prayer');

        const horror = catalog.require('quest:horror');
        expect(horror.config.requiredQuests).toContain('barcrawl');
        expect((horror.config.requiredSkills as Record<string, number>)?.Magic).toBe(75);

        const mm = catalog.require('quest:mm');
        expect(mm.config.requiredQuests).toContain('grandtree');
        expect(mm.config.requiredQuests).toContain('tree');
    });

    test('falls back to craft_gather when GE sell=0 for dueling ring, glory(4), rune 2h, and agility(4)', () => {
        const catalog = createActivityCatalog();
        const activities = catalog.list();
        const world: WorldSnapshot = {
            schemaVersion: 1,
            at: NOW,
            side: 'local',
            server: 'rs-sdk-demo.fly.dev',
            accounts: {},
        };
        const artisanAcct = makeTestAccount({
            name: 'MasterMaker',
            skills: {
                Magic: { level: 70, xp: 800_000 },
                Smithing: { level: 99, xp: 14_000_000 },
                Herblore: { level: 40, xp: 40_000 },
            },
            quests: { hero: 'complete', druid: 'complete' },
            bank: {
                items: {
                    995: 10_000,
                    1639: 2,  // Emerald ring
                    564: 5,   // Cosmic rune
                    556: 10,  // Air rune
                    1704: 2,  // Uncharged Amulet of glory
                    2347: 1,  // Hammer
                    2363: 3,  // Runite bar
                    3034: 2,  // Agility potion(3)
                },
                observedAt: NOW - 5_000,
                trusted: true,
            },
        });
        const zeroGe = {
            2552: { ask: 2000, sell: 0, trades: 0 },
            1712: { ask: 50000, sell: 0, trades: 0 },
            1319: { ask: 40000, sell: 0, trades: 0 },
            3032: { ask: 5000, sell: 0, trades: 0 },
        };

        const cases = [
            { itemId: 2552, activityId: 'bank-artisan:magic-enchant-emerald_ring', routeKey: 'magic:items' },
            { itemId: 1712, activityId: 'logistics:charge-glory', routeKey: 'charge-glory' },
            { itemId: 1319, activityId: 'bank-artisan:skill:smithing:rune_2h_sword', routeKey: 'smithing:anvil' },
            { itemId: 3032, activityId: 'bank-artisan:decant-agility_potion', routeKey: 'crafting:inventory' },
        ] as const;

        for (const c of cases) {
            const res = resolveAcquireItem(
                artisanAcct,
                { itemId: c.itemId, quantity: 1 },
                { world, activities, marketQuotes: zeroGe, requireMarketQuote: true },
            );
            expect(res.ok).toBe(true);
            expect(res.step?.source).toBe('craft_gather');
            expect(res.step?.activityId).toBe(c.activityId);

            const routed = resolvePlannedStepWorkerRoute(artisanAcct.name, res.step!, { catalog });
            expect(routed.warnings).toEqual([]);
            expect(routed.routeKey).toBe(c.routeKey);
        }

        // Smithing Rune 2h rejects if only 1 Runite bar is present (requires 3 bars).
        const shortBars = makeTestAccount({
            ...artisanAcct,
            bank: { items: { 995: 10_000, 2347: 1, 2363: 1 }, observedAt: NOW - 5_000, trusted: true },
        });
        const shortRes = resolveAcquireItem(
            shortBars,
            { itemId: 1319, quantity: 1 },
            { world, activities, marketQuotes: zeroGe, requireMarketQuote: true },
        );
        expect(shortRes.ok).toBe(false);
    });
});
