import { describe, expect, test } from 'bun:test';
import { COMBAT_FLOOR_EXEMPT_TARGETS, createActivityCatalog } from '../src/catalog';
import type { AccountState, WorldSnapshot } from '../src/contracts';
import { resolveActivityWorkerRoute } from '../src/worker-routing';
import {
    accountCombatLevel,
    activityPreflightFromConfig,
    evaluateCombatSurvivability,
    GUARD_FOOD_IDS,
    type CombatSurvivabilityFloor,
} from '../src/preflight';
import { PLAIN_FOOD } from '../../core/src/eat-guard';

const NOW = 1_800_000_000_000;

function weakAcct(hp: number, overrides: Partial<AccountState> = {}): AccountState {
    return {
        name: 'Rubmyrunes',
        side: 'local',
        role: 'army',
        protectedClock: false,
        lifecycle: 'idle',
        skills: {
            Attack: { level: 1, xp: 0 },
            Strength: { level: 1, xp: 0 },
            Defence: { level: 1, xp: 0 },
            Hitpoints: { level: hp, xp: 1200 },
        },
        quests: {},
        pos: { x: 3185, z: 3436, level: 0 },
        inventory: { 995: 500 },
        equipment: {},
        bank: { items: {}, observedAt: NOW - 5_000, trusted: true },
        ...overrides,
    };
}

const worldOf = (acct: AccountState): WorldSnapshot => ({
    schemaVersion: 1,
    at: NOW,
    side: 'local',
    server: 'rs-sdk-demo.fly.dev',
    accounts: { [acct.name]: acct },
});

const floorOf = (id: string): CombatSurvivabilityFloor => {
    const floor = createActivityCatalog().require(id).config.combatSurvivability as CombatSurvivabilityFloor | undefined;
    expect(floor).toBeDefined();
    return floor!;
};

const reasons = (acct: AccountState, id: string) =>
    evaluateCombatSurvivability(acct, floorOf(id), worldOf(acct)).map((b) => b.reason);

describe('combat survivability floors in the catalog', () => {
    test('every fighter and boss row has a floor unless its target is exempt', () => {
        const missing = createActivityCatalog()
            .list()
            .filter((a) => a.config.aioCategory === 'fighter' || a.config.aioCategory === 'boss')
            .filter((a) => !COMBAT_FLOOR_EXEMPT_TARGETS.has(a.id.replace(/^combat:/, '')))
            .filter((a) => !a.config.combatSurvivability)
            .map((a) => a.id);
        expect(missing).toEqual([]);
        // Each exempt target names a catalog row, so a renamed row cannot keep a stale exemption.
        const ids = new Set(createActivityCatalog().list().map((a) => a.id));
        expect([...COMBAT_FLOOR_EXEMPT_TARGETS].filter((t) => !ids.has(`combat:${t}`))).toEqual([]);
    });

    test('unicorn and wizard refuse a 10-13 HP account with no food', () => {
        for (const id of ['combat:unicorn', 'combat:wizard']) {
            expect(reasons(weakAcct(12), id)).toEqual(['hitpoints', 'food']);
        }
    });

    test('a 60-HP account with 4 sharks is refused at wizards; 5 sharks pass', () => {
        expect(reasons(weakAcct(60, { inventory: { 385: 4 } }), 'combat:wizard')).toEqual(['food']);
        expect(reasons(weakAcct(60, { bank: { items: { 385: 5 }, observedAt: NOW - 5_000, trusted: true } }), 'combat:wizard')).toEqual([]);
    });

    test('only shark and lobster count for the generic combat rows', () => {
        // 5 pieces of a low-heal fish do not keep a weak account alive at unicorns, druids or wizards.
        const trout = weakAcct(30, { bank: { items: { 329: 20 }, observedAt: NOW - 5_000, trusted: true } });
        expect(reasons(trout, 'combat:unicorn')).toEqual(['food']);
        expect(reasons(trout, 'combat:druid')).toEqual(['food']);
        // The Hill Giant runner withdraws only shark.
        const lobster = weakAcct(30, { bank: { items: { 379: 20 }, observedAt: NOW - 5_000, trusted: true } });
        expect(reasons(lobster, 'combat:giant')).toEqual(['food']);
    });

    test('the fight quests refuse weak melee accounts', () => {
        const catalog = createActivityCatalog();
        expect(reasons(weakAcct(18), 'quest:priestperil')).toContain('hitpoints');
        expect(reasons(weakAcct(10), 'quest:dwarfcannon')).toContain('hitpoints');
        const strength1 = weakAcct(31, { bank: { items: { 385: 10 }, observedAt: NOW - 5_000, trusted: true } });
        expect(reasons(strength1, 'quest:biohazard')).toEqual([]);
        expect((catalog.require('quest:biohazard').config.requiredSkills as Record<string, number>).Strength).toBeGreaterThan(1);
        expect((catalog.require('quest:priestperil').config.requiredSkills as Record<string, number>).Attack).toBeGreaterThanOrEqual(20);
    });

    test('a fighter floor with no named food counts only the food that the eat guard eats', () => {
        expect(GUARD_FOOD_IDS.length).toBeGreaterThan(0);
        expect(GUARD_FOOD_IDS.every((id) => PLAIN_FOOD.includes(id))).toBe(true);
        expect(GUARD_FOOD_IDS[0]).toBe(385);
        const strong = { Attack: { level: 40, xp: 0 }, Strength: { level: 40, xp: 0 }, Defence: { level: 30, xp: 0 }, Hitpoints: { level: 50, xp: 0 } };
        // 20 cakes and 20 bread: the guard eats neither, so the trooper fight has no food.
        const cakes = weakAcct(50, { skills: strong, bank: { items: { 1891: 20, 2309: 20 }, observedAt: NOW - 5_000, trusted: true } });
        expect(reasons(cakes, 'combat:trooper')).toEqual(['food']);
        const sharks = weakAcct(50, { skills: strong, bank: { items: { 385: 20 }, observedAt: NOW - 5_000, trusted: true } });
        expect(reasons(sharks, 'combat:trooper')).toEqual([]);
    });

    test('the Dwarf Cannon floor asks for 6 food', () => {
        expect(floorOf('quest:dwarfcannon').minFoodCount).toBe(6);
    });
});

describe('fresh-account routes refuse an account they cannot run', () => {
    const fresh = (pos: { x: number; z: number; level: number }, rangedXp = 0) =>
        weakAcct(10, { pos, skills: { ...weakAcct(10).skills, Ranged: { level: 1, xp: rangedXp } } });
    const preflight = (acct: AccountState, id: string) =>
        activityPreflightFromConfig(acct, createActivityCatalog().require(id), worldOf(acct));

    test('ranged-starter runs only on Tutorial Island with Ranged xp 0', () => {
        // CoinCock at the Ardougne north hub: the worker refused "fresh tutorial start required" after a login.
        const hub = preflight(fresh({ x: 2618, z: 3332, level: 0 }), 'combat:ranged-starter');
        expect(hub.ok).toBe(false);
        expect(hub.blockers.map((b) => b.kind)).toContain('invalid_config');
        const trained = preflight(fresh({ x: 3094, z: 3107, level: 0 }, 50), 'combat:ranged-starter');
        expect(trained.ok).toBe(false);
        expect(trained.blockers.map((b) => b.kind)).toContain('invalid_config');
        expect(preflight(fresh({ x: 3094, z: 3107, level: 0 }), 'combat:ranged-starter').blockers).toEqual([]);
    });

    test('woodcutting fresh45 runs at Draynor and refuses an account below combat 15', () => {
        const catalog = createActivityCatalog();
        const act = catalog.require('gather:woodcutting-fresh45');
        expect(resolveActivityWorkerRoute(act).env.WC_SITE).toBe('draynor');
        const weak = weakAcct(10);
        expect(accountCombatLevel(weak)).toBe(3);
        expect(reasons(weak, 'gather:woodcutting-fresh45')).toEqual(['protection']);
        const fighter = weakAcct(20, { skills: { ...weak.skills, Attack: { level: 20, xp: 0 }, Strength: { level: 20, xp: 0 }, Defence: { level: 10, xp: 0 }, Hitpoints: { level: 20, xp: 0 } } });
        expect(accountCombatLevel(fighter)).toBeGreaterThanOrEqual(15);
        expect(reasons(fighter, 'gather:woodcutting-fresh45')).toEqual([]);
    });
});
