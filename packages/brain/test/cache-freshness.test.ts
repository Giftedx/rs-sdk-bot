import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bestHaggisLeg, createHaggisLegCache, haggisTravel } from '../../planner/src/haggis/travel';
import { clearBrainJsonCache, readJsonStatCached } from '../src/json-cache';
import { createActivityCatalog, defaultActivityCatalog } from '../src/catalog';
import { createRateStore } from '../src/rate-store';
import { planAccount, planAccountWithCandidates } from '../src/planner';
import type { AccountState, GoalDemand, WorldSnapshot } from '../src/contracts';

const tempDirs: string[] = [];

afterEach(() => {
    clearBrainJsonCache();
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
});

describe('Brain & Planner cache freshness and parity', () => {
    test('readJsonStatCached invalidates when size or mtime changes or file is removed', () => {
        const dir = mkdtempSync(join(tmpdir(), 'brain-json-cache-'));
        tempDirs.push(dir);
        const file = join(dir, 'sample.json');

        writeFileSync(file, JSON.stringify({ version: 1, tag: 'a' }), 'utf8');
        expect(readJsonStatCached<{ version: number; tag: string }>(file)).toEqual({ version: 1, tag: 'a' });

        // Update with different size and bumped mtime to guarantee stat stamp change.
        writeFileSync(file, JSON.stringify({ version: 2, tag: 'updated-tag' }), 'utf8');
        const nextDate = new Date(Date.now() + 5000);
        utimesSync(file, nextDate, nextDate);
        expect(readJsonStatCached<{ version: number; tag: string }>(file)).toEqual({ version: 2, tag: 'updated-tag' });

        rmSync(file);
        expect(readJsonStatCached(file)).toBeNull();
    });

    test('RateStore estimate cache invalidates on recordSample and load', () => {
        const dir = mkdtempSync(join(tmpdir(), 'brain-rate-cache-'));
        tempDirs.push(dir);
        const catalog = defaultActivityCatalog();
        const store = createRateStore({
            catalog,
            root: dir,
            minSamplesToOverride: 2,
            minTicksToOverride: 200,
        });
        const actId = catalog.byFamily('gather')[0]!.id;
        const base = store.estimate(actId);
        expect(store.estimate(actId)).toBe(base);

        store.recordSample({
            activityId: actId,
            account: 'Tester',
            domain: 'live',
            observedAt: 1_800_000_000_000,
            ticksElapsed: 150,
            unitsCompleted: 30,
            xpPerTick: 120,
            unitsPerTick: 0.2,
            gpPerTick: 10,
        });
        store.recordSample({
            activityId: actId,
            account: 'Tester',
            domain: 'live',
            observedAt: 1_800_000_001_000,
            ticksElapsed: 150,
            unitsCompleted: 45,
            xpPerTick: 180,
            unitsPerTick: 0.3,
            gpPerTick: 20,
        });

        const overridden = store.estimate(actId);
        expect(overridden.confidence).toBe('live');
        expect(overridden.xpPerTick).toBeCloseTo(150, 5);

        rmSync(store.filePath, { force: true });
        store.load();
        expect(store.estimate(actId).confidence).toBe('model');
    });

    test('planAccountWithCandidates matches planAccount and ranks feasible demands accurately', () => {
        const catalog = createActivityCatalog();
        const activities = catalog.list();
        const now = 1_800_000_000_000;
        const acct: AccountState = {
            name: 'CandidateCheck',
            side: 'local',
            role: 'auto',
            protectedClock: false,
            lifecycle: 'idle',
            skills: {
                Attack: { level: 40, xp: 37_224 },
                Strength: { level: 40, xp: 37_224 },
                Defence: { level: 40, xp: 37_224 },
                Hitpoints: { level: 40, xp: 37_224 },
                Cooking: { level: 50, xp: 101_333 },
            },
            quests: {},
            pos: { x: 3222, z: 3218, level: 0 },
            inventory: { 995: 5000 },
            equipment: {},
            bank: { items: { 383: 100, 995: 5000 }, observedAt: now - 10_000, trusted: true },
        };
        const world: WorldSnapshot = {
            schemaVersion: 1,
            at: now,
            side: 'local',
            server: 'rs-sdk-demo.fly.dev',
            accounts: { CandidateCheck: acct },
        };
        const demands: GoalDemand[] = [
            {
                id: 'd:cook-quest',
                goalKind: 'quest_board',
                valueScore: 300,
                valuePerHour: 300,
                target: { kind: 'quest', questSlug: 'cook' },
                fulfilled: 0,
                remaining: 1,
                priorityWeight: 1,
                active: true,
            },
            {
                id: 'd:imp-quest',
                goalKind: 'quest_board',
                valueScore: 200,
                valuePerHour: 200,
                target: { kind: 'quest', questSlug: 'imp' },
                fulfilled: 0,
                remaining: 1,
                priorityWeight: 1,
                active: true,
            },
            {
                id: 'd:coins',
                goalKind: 'coin_fund',
                valueScore: 50,
                valuePerHour: 50,
                target: { kind: 'coins', amount: 50_000 },
                fulfilled: 0,
                remaining: 50_000,
                priorityWeight: 1,
                active: true,
            },
        ];

        const single = planAccount(acct, { world, activities, demands });
        const ranked = planAccountWithCandidates(acct, { world, activities, demands });
        expect(ranked.bestPlan).toEqual(single);
        expect(ranked.candidates.length).toBeGreaterThanOrEqual(2);
        expect(ranked.candidates[0]).toEqual(single);
        for (let i = 1; i < ranked.candidates.length; i++) {
            expect(ranked.candidates[i - 1]!.scorePerHour).toBeGreaterThanOrEqual(ranked.candidates[i]!.scorePerHour);
        }

        // Excluding the top demand yields the same plan as the second ranked candidate.
        const secondOnly = planAccount(acct, { world, activities, demands: demands.slice(1) });
        expect(ranked.candidates[1]).toEqual(secondOnly);
    });

    test('bestHaggisLeg with HaggisLegCache matches uncached results across magic tiers and quest unlocks', () => {
        const model = haggisTravel();
        const cache = createHaggisLegCache();
        const pairs: [string, string][] = [
            ['lumbridge-spawn', 'varrock-west-anvil'],
            ['varrock-west-anvil', 'ardougne-market'],
            ['ardougne-market', 'mage-arena-lever'],
            ['mage-arena-lever', 'mortton'],
        ];
        const states: Array<{ magic: number; done: string[]; disable: boolean }> = [
            { magic: 1, done: [], disable: false },
            { magic: 25, done: ['trade-start'], disable: false },
            { magic: 51, done: ['trade-start', 'plague-city', 'tree', 'grandtree'], disable: false },
            { magic: 51, done: ['trade-start', 'plague-city', 'tree', 'grandtree'], disable: true },
        ];

        for (const st of states) {
            const doneMap = new Map(st.done.map((k, idx) => [k, idx + 1]));
            for (const [from, to] of pairs) {
                const uncached = bestHaggisLeg(model, from, to, st.magic, doneMap, st.disable);
                const cached1 = bestHaggisLeg(model, from, to, st.magic, doneMap, st.disable, cache);
                const cached2 = bestHaggisLeg(model, from, to, st.magic, doneMap, st.disable, cache);
                expect(cached1).toEqual(uncached);
                expect(cached2).toEqual(uncached);
            }
        }
    });
});
