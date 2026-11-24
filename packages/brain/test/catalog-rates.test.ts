import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKER_FAMILIES } from '../../workers/src/contracts';
import {
    createActivityCatalog,
    createDemandEngine,
    createRateStore,
    defaultActivityCatalog,
    validateActivityDefinition,
    type AccountState,
    type RateSample,
    type WorldSnapshot,
} from '../src/index';

let tempRoot = '';
const NOW = 1_800_000_000_000;

beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'brain-catalog-rates-'));
});

afterEach(() => {
    if (tempRoot) {
        rmSync(tempRoot, { recursive: true, force: true });
        tempRoot = '';
    }
});

describe('ActivityCatalog & RateStore', () => {
    test('covers all 9 worker families with valid baselines, minBatchUnits floors, and protectedAllowed=false', () => {
        const catalog = defaultActivityCatalog();
        const all = catalog.list();
        expect(all.length).toBeGreaterThan(200);

        for (const family of WORKER_FAMILIES) {
            const list = catalog.byFamily(family);
            expect(list.length).toBeGreaterThan(0);
        }

        const practicePassed = all.filter((a) => a.trust === 'practice_passed');
        const experimental = all.filter((a) => a.trust === 'experimental');
        expect(practicePassed.length).toBeGreaterThan(0);
        expect(experimental.length).toBeGreaterThan(0);

        // No covered AIO method dropped; every activity validates cleanly
        for (const act of all) {
            expect(validateActivityDefinition(act)).toEqual([]);
            expect(act.baselineRate.minBatchUnits).toBeGreaterThanOrEqual(1);
            expect(act.baselineRate.setupTicks).toBeGreaterThanOrEqual(0);
            expect(act.protectedAllowed).toBe(false);
        }
    });

    test('supports benchPassedIds / liveProvenIds / launchQualifiedIds overrides and output/skill/quest lookups', () => {
        const baselineCatalog = createActivityCatalog();
        expect(baselineCatalog.require('market:shop-buy').trust).toBe('practice_passed');
        expect(baselineCatalog.require('gather:foraging-crystal-chest').trust).toBe('experimental');

        const catalog = createActivityCatalog({
            benchPassedIds: new Set(['gather:foraging-crystal-chest']),
            liveProvenIds: new Set(['gather:woodcutting-fresh45']),
            launchQualifiedIds: new Set(['gather:woodcutting-fresh45']),
        });

        const crystalChest = catalog.require('gather:foraging-crystal-chest');
        expect(crystalChest.trust).toBe('practice_passed');
        expect(crystalChest.protectedAllowed).toBe(false);

        const willow = catalog.require('gather:woodcutting-fresh45');
        expect(willow.trust).toBe('live_proven');
        expect(willow.protectedAllowed).toBe(true);

        expect(catalog.findBySkill('Woodcutting').length).toBeGreaterThan(0);
        expect(catalog.findByQuest('cook').length).toBeGreaterThan(0);
        expect(catalog.findByQuest('cooks_assistant').length).toBeGreaterThan(0);
        expect(catalog.findByQuest('waterfall_quest').length).toBeGreaterThan(0);
        expect(catalog.findByOutputItem(1519).length).toBeGreaterThan(0); // Willow logs
    });

    test('RateStore overrides modeled estimates automatically once sample count and ticks accumulate and persists to disk', () => {
        const catalog = defaultActivityCatalog();
        const store = createRateStore({
            catalog,
            root: tempRoot,
            minSamplesToOverride: 3,
            minTicksToOverride: 300,
        });

        const activityId = catalog.byFamily('gather')[0]!.id;
        const baseEst = store.estimate(activityId);
        expect(baseEst.confidence).toBe('model');
        expect(store.hasOverride(activityId)).toBe(false);

        const makeSample = (idx: number, xpPerTick: number, unitsPerTick: number, gpPerTick: number): RateSample => ({
            activityId,
            account: 'HelperOne',
            domain: 'live',
            observedAt: NOW + idx * 1000,
            ticksElapsed: 100,
            unitsCompleted: Math.round(unitsPerTick * 100),
            xpPerTick,
            unitsPerTick,
            gpPerTick,
            setupTicks: 18,
        });

        // Two samples (200 ticks < 300, count 2 < 3) should NOT override yet
        store.recordSample(makeSample(1, 50, 0.2, 25));
        store.recordSample(makeSample(2, 50, 0.2, 25));
        expect(store.hasOverride(activityId)).toBe(false);
        expect(store.estimate(activityId).confidence).toBe('model');

        // Third sample (total 300 ticks, count 3) triggers override
        store.recordSample(makeSample(3, 80, 0.5, 40));
        expect(store.hasOverride(activityId)).toBe(true);

        const overridden = store.estimate(activityId);
        expect(overridden.confidence).toBe('live');
        expect(overridden.xpPerTick).toBeCloseTo(60, 5);
        expect(overridden.unitsPerTick).toBeCloseTo(0.3, 5);
        expect(overridden.gpPerTick).toBeCloseTo(30, 5);
        expect(overridden.setupTicks).toBe(18);

        // Reload from persisted JSON under tempRoot/.practice/live/rate-store.json
        const reloaded = createRateStore({
            catalog,
            root: tempRoot,
            minSamplesToOverride: 3,
            minTicksToOverride: 300,
        });
        expect(reloaded.hasOverride(activityId)).toBe(true);
        expect(reloaded.estimate(activityId).xpPerTick).toBeCloseTo(60, 5);
        expect(reloaded.summaryFor(activityId)?.samples).toBe(3);
    });

    test('RateStore keeps setupTicks travel-free and clamps short-session death riskPerHour to [0, 1]', () => {
        const catalog = defaultActivityCatalog();
        const located = catalog.list().find((a) => a.location !== undefined);
        expect(located).toBeDefined();
        const store = createRateStore({ catalog });

        const makeAccount = (pos: { x: number; z: number; level: number }): AccountState => ({
            name: 'Mover',
            side: 'local',
            role: 'helper',
            protectedClock: false,
            lifecycle: 'idle',
            skills: {},
            quests: {},
            pos,
            inventory: {},
            equipment: {},
            bank: { items: {}, observedAt: 0, trusted: false },
        });

        const nearAcct = makeAccount(located!.location!);
        const farAcct = makeAccount({ x: located!.location!.x + 400, z: located!.location!.z + 400, level: located!.location!.level });
        const nearEst = store.estimate(located!.id, nearAcct);
        const farEst = store.estimate(located!.id, farAcct);
        expect(farEst.setupTicks).toBe(nearEst.setupTicks);
        expect(farEst.setupTicks).toBe(located!.baselineRate.setupTicks);

        // Short-session death (20 ticks) must clamp riskPerHour <= 1 and never throw in RateStore or DemandEngine.
        store.recordSample({
            activityId: located!.id,
            account: 'Mover',
            domain: 'live',
            observedAt: NOW,
            ticksElapsed: 20,
            unitsCompleted: 0,
            xpPerTick: 0,
            unitsPerTick: 0,
            gpPerTick: 0,
            died: true,
        });
        const afterDeath = store.estimate(located!.id, farAcct);
        expect(afterDeath.riskPerHour).toBeGreaterThan(0);
        expect(afterDeath.riskPerHour).toBeLessThanOrEqual(1);

        const snap: WorldSnapshot = {
            schemaVersion: 1,
            at: NOW,
            side: 'local',
            server: 'rs-sdk-demo.fly.dev',
            accounts: { Mover: nearAcct },
        };
        const engine = createDemandEngine({ catalog, rateStore: store });
        expect(() => engine.activeDemands(snap)).not.toThrow();
    });
});
