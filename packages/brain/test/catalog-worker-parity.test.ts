import { describe, expect, test } from 'bun:test';
import { createActivityCatalog } from '../src/catalog';
import { activityPreflightFromConfig } from '../src/preflight';
import { resolveActivityWorkerRoute } from '../src/worker-routing';
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
});
