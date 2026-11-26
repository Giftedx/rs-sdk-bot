import { describe, expect, test } from 'bun:test';
import { COMBAT_FLOOR_EXEMPT_TARGETS, createActivityCatalog } from '../src/catalog';
import type { AccountState, WorldSnapshot } from '../src/contracts';
import { evaluateCombatSurvivability, type CombatSurvivabilityFloor } from '../src/preflight';

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
});
