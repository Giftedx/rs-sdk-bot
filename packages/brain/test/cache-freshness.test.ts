import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveRoot, practiceRoot } from '../../core/src/practice-paths';
import { beginSessionAttempt } from '../../core/src/session-lifecycle';
import { RESERVED_ACCOUNTS } from '../../core/src/specialist-boards';
import { bestHaggisLeg, createHaggisLegCache, haggisTravel } from '../../planner/src/haggis/travel';
import { clearBrainJsonCache, readJsonStatCached } from '../src/json-cache';
import { createActivityCatalog, defaultActivityCatalog } from '../src/catalog';
import { isReservedSpecialistAccount } from '../src/campaigns/specialists';
import { createRateStore } from '../src/rate-store';
import { OutcomeClassifier } from '../src/outcome-classifier';
import { buildPlannerSharedIndex, createAccountPlannerReuse, planAccount, planAccountWithCandidates } from '../src/planner';
import { scheduleFleet } from '../src/scheduler';
import { inspectWorldSnapshot } from '../src/snapshot';
import {
    isProtectedAccountName,
    validateAccountState,
    validateFleetPlan,
    validateFleetState,
    validateOperatorCommand,
    type AccountState,
    type ActivityDefinition,
    type GoalDemand,
    type WorldSnapshot,
} from '../src/contracts';

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

    test('createActivityCatalog caches per root stamp and invalidates on generated quest additions', () => {
        const dir = mkdtempSync(join(tmpdir(), 'brain-cat-cache-'));
        tempDirs.push(dir);
        mkdirSync(join(dir, 'knowledge'), { recursive: true });
        mkdirSync(join(dir, 'scripts', 'generated'), { recursive: true });
        writeFileSync(join(dir, 'knowledge', 'items.json'), '[]', 'utf8');
        writeFileSync(join(dir, 'knowledge', 'skills.json'), '[]', 'utf8');
        writeFileSync(join(dir, 'knowledge', 'rates.json'), '[]', 'utf8');
        writeFileSync(join(dir, 'knowledge', 'quests.json'), '[]', 'utf8');

        const first = createActivityCatalog({ root: dir });
        const second = createActivityCatalog({ root: dir });
        expect(second).toBe(first);
        expect(first.has('quest:freshsynth')).toBe(false);

        writeFileSync(join(dir, 'scripts', 'generated', 'quest-freshsynth.ts'), 'export {};\n', 'utf8');
        const nextDate = new Date(Date.now() + 5000);
        utimesSync(join(dir, 'scripts', 'generated'), nextDate, nextDate);

        const refreshed = createActivityCatalog({ root: dir });
        expect(refreshed).not.toBe(first);
        expect(refreshed.has('quest:freshsynth')).toBe(true);
    });

    test('inspectWorldSnapshot batched stop-file and lifecycle indexes reflect live changes immediately', () => {
        const dir = mkdtempSync(join(tmpdir(), 'brain-snap-idx-'));
        tempDirs.push(dir);
        const server = 'rs-sdk-demo.fly.dev';
        const now = 1_800_000_000_000;
        mkdirSync(join(dir, 'fleet'), { recursive: true });
        writeFileSync(
            join(dir, 'fleet', 'owners.json'),
            JSON.stringify({ accounts: { AlphaBot: { side: 'local', server } } }),
            'utf8',
        );

        const initial = inspectWorldSnapshot({ root: dir, now, side: 'local', server });
        expect(initial.snapshot.accounts.alphabot?.lifecycle).toBe('idle');
        expect(initial.accounts.alphabot?.logoutState).toBe('none');

        // Adding a lifecycle logout receipt updates logoutState immediately.
        const lcRoot = join(liveRoot(dir), 'session-lifecycle');
        const attempt = beginSessionAttempt({ account: 'AlphaBot', server }, { root: lcRoot, now: () => now - 20_000 });
        attempt.record('ready');
        attempt.record('ended', 'logged-out');
        attempt.record('logout', 'logged-out');
        attempt.record('closed');

        const withProof = inspectWorldSnapshot({ root: dir, now, side: 'local', server });
        expect(withProof.accounts.alphabot?.logoutState).toBe('confirmed');

        // Adding an owner stop file transitions account to paused_owner immediately.
        mkdirSync(practiceRoot(dir), { recursive: true });
        writeFileSync(join(practiceRoot(dir), 'stop-AlphaBot'), 'owner manual pause', 'utf8');
        const withStop = inspectWorldSnapshot({ root: dir, now, side: 'local', server });
        expect(withStop.snapshot.accounts.alphabot?.lifecycle).toBe('paused_owner');
    });

    test('scheduleFleet incremental greedy re-evaluation matches full uncached planning across shrinking demands and full spots', () => {
        const now = 1_800_000_000_000;
        const activities: ActivityDefinition[] = [
            {
                id: 'gather:mine-iron',
                workerId: 'gather',
                family: 'gather',
                kind: 'gather',
                label: 'Mine iron ore',
                skill: 'Mining',
                spotId: 'spot:iron-single',
                maxConcurrentAccounts: 1,
                config: { aioCategory: 'skiller', aioRoute: 'mining:ore', skill: 'mining', method: 'ore', requiredLevel: 15 },
                baselineRate: { xpPerTick: 90, unitsPerTick: 0.25, gpPerTick: 10, setupTicks: 15, minBatchUnits: 20, confidence: 'practice', outputsPerUnit: { 440: 1 } },
                outputs: [{ itemId: 440, countPerUnit: 1 }],
                location: { x: 3185, z: 3436, level: 0 },
                trust: 'practice_passed',
            },
            {
                id: 'gather:chop-oak',
                workerId: 'gather',
                family: 'gather',
                kind: 'gather',
                label: 'Chop oak logs',
                skill: 'Woodcutting',
                config: { aioCategory: 'skiller', aioRoute: 'woodcutting:oak', skill: 'woodcutting', method: 'oak', requiredLevel: 15 },
                baselineRate: { xpPerTick: 85, unitsPerTick: 0.2, gpPerTick: 8, setupTicks: 15, minBatchUnits: 20, confidence: 'practice', outputsPerUnit: { 1521: 1 } },
                outputs: [{ itemId: 1521, countPerUnit: 1 }],
                location: { x: 3185, z: 3436, level: 0 },
                trust: 'practice_passed',
            },
            {
                id: 'gather:fish-shrimp',
                workerId: 'gather',
                family: 'gather',
                kind: 'gather',
                label: 'Fish shrimp',
                skill: 'Fishing',
                config: { aioCategory: 'skiller', aioRoute: 'fishing:shrimp', skill: 'fishing', method: 'shrimp', requiredLevel: 1 },
                baselineRate: { xpPerTick: 40, unitsPerTick: 0.2, gpPerTick: 5, setupTicks: 15, minBatchUnits: 20, confidence: 'practice', outputsPerUnit: { 317: 1 } },
                outputs: [{ itemId: 317, countPerUnit: 1 }],
                location: { x: 3222, z: 3218, level: 0 },
                trust: 'practice_passed',
            },
        ];

        const mkAcct = (name: string): AccountState => ({
            name,
            side: 'local',
            role: 'auto',
            protectedClock: false,
            lifecycle: 'idle',
            skills: { Mining: { level: 40, xp: 37_224 }, Woodcutting: { level: 40, xp: 37_224 }, Fishing: { level: 40, xp: 37_224 } },
            quests: {},
            pos: { x: 3185, z: 3436, level: 0 },
            inventory: { 995: 5000, 1265: 1, 1351: 1, 303: 1 },
            equipment: {},
            bank: { items: { 995: 5000 }, observedAt: now - 5_000, trusted: true },
        });
        const world: WorldSnapshot = {
            schemaVersion: 1,
            at: now,
            side: 'local',
            server: 'rs-sdk-demo.fly.dev',
            accounts: { Alpha: mkAcct('Alpha'), Beta: mkAcct('Beta'), Gamma: mkAcct('Gamma') },
        };
        const demands: GoalDemand[] = [
            { id: 'd:iron', goalKind: 'main_supply', valueScore: 500, valuePerHour: 500, target: { kind: 'item', itemId: 440, count: 5000 }, fulfilled: 0, remaining: 5000, priorityWeight: 1, active: true },
            { id: 'd:oak', goalKind: 'main_supply', valueScore: 300, valuePerHour: 300, target: { kind: 'item', itemId: 1521, count: 3000 }, fulfilled: 0, remaining: 3000, priorityWeight: 1, active: true },
            { id: 'd:shrimp', goalKind: 'main_supply', valueScore: 100, valuePerHour: 100, target: { kind: 'item', itemId: 317, count: 1000 }, fulfilled: 0, remaining: 1000, priorityWeight: 1, active: true },
        ];

        const plan = scheduleFleet({ world, activities, demands, maxBots: 3 });
        expect(plan.accountPlans.Alpha?.demandId).toBe('d:iron');
        expect(plan.spotAllocations['spot:iron-single']).toEqual(['Alpha']);
        // Beta takes 2000/3000 oak (shrunk non-zero); Gamma takes remaining 1000 oak.
        expect(plan.accountPlans.Beta?.demandId).toBe('d:oak');
        expect(plan.accountPlans.Gamma?.demandId).toBe('d:oak');
        const gammaWork = plan.accountPlans.Gamma?.steps.find((s) => s.stepKind === 'work');
        expect(gammaWork?.stepKind === 'work' ? gammaWork.batchUnits : 0).toBe(1000);

        // When oak is exhausted by Beta (remaining 1000 <= 2000), Gamma advances to shrimp.
        const exhaustDemands: GoalDemand[] = [
            demands[0]!,
            { ...demands[1]!, target: { kind: 'item', itemId: 1521, count: 1000 }, remaining: 1000 },
            demands[2]!,
        ];
        const exhaustPlan = scheduleFleet({ world, activities, demands: exhaustDemands, maxBots: 3 });
        expect(exhaustPlan.accountPlans.Alpha?.demandId).toBe('d:iron');
        expect(exhaustPlan.accountPlans.Beta?.demandId).toBe('d:oak');
        expect(exhaustPlan.accountPlans.Gamma?.demandId).toBe('d:shrimp');

        // Shared index donor lookup preserves exact hub_banker donor filtering parity.
        const shared = buildPlannerSharedIndex({ world, activities });
        expect(shared.idleDonorsByItemId.get(995)?.map((a) => a.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
        expect(shared.idleDonorsByItemId.get(385)).toBeUndefined();
    });

    test('OutcomeClassifier isQuarantined and applyToSnapshot fast path match full overlay semantics', () => {
        const now = 1_800_000_000_000;
        const classifier = new OutcomeClassifier({ persist: false });
        const acct: AccountState = {
            name: 'SteadyBot',
            side: 'local',
            role: 'auto',
            protectedClock: false,
            lifecycle: 'idle',
            skills: { Attack: { level: 50, xp: 101_333 } },
            quests: {},
            pos: { x: 3222, z: 3218, level: 0 },
            inventory: { 995: 1000 },
            equipment: {},
            bank: { items: {}, observedAt: now - 5_000, trusted: true },
        };
        const world: WorldSnapshot = {
            schemaVersion: 1,
            at: now,
            side: 'local',
            server: 'rs-sdk-demo.fly.dev',
            accounts: { steadybot: acct },
        };

        // Unmodified account fast path returns identical account state cleanly.
        const unchanged = classifier.applyToSnapshot(world, now);
        expect(unchanged.accounts.steadybot).toBe(acct);

        // Quarantined defect lookup detects active defects and expires them after TTL.
        classifier.applyOutcome({
            kind: 'worker_defect',
            activityId: 'gather:mining-ore',
            account: 'SteadyBot',
            ticksElapsed: 10,
            faultSignature: 'test_fault',
        }, { now });
        expect(classifier.isQuarantined('gather:mining-ore', now + 1000)).toBe(true);
        expect(classifier.isQuarantined('gather:mining-ore', now + 25 * 3_600_000)).toBe(false);
    });

    test('contracts fast validators and specialists reserved set parity hold across valid and malformed inputs', () => {
        for (const reserved of RESERVED_ACCOUNTS) {
            expect(isReservedSpecialistAccount(reserved)).toBe(true);
            expect(isReservedSpecialistAccount(reserved.toUpperCase())).toBe(true);
            expect(isProtectedAccountName(reserved)).toBe(true);
        }
        expect(isProtectedAccountName('Haggis')).toBe(true);
        expect(isProtectedAccountName(' haggis ')).toBe(true);
        expect(isReservedSpecialistAccount('Worker01')).toBe(false);
        expect(isProtectedAccountName('Worker01')).toBe(false);

        const now = 1_800_000_000_000;
        const badAcctErrs = validateAccountState({
            name: 'bad!name',
            side: 'local',
            role: 'invalid_role',
            protectedClock: false,
            lifecycle: 'idle',
            skills: { Attack: { level: 0, xp: -1 } },
            quests: {},
            pos: { x: 3200, z: 3200, level: 0 },
            inventory: { '995': -5 },
            equipment: {},
            bank: { items: {}, observedAt: now, trusted: true },
        });
        expect(badAcctErrs.some((e) => e.includes('invalid account name:'))).toBe(true);
        expect(badAcctErrs.some((e) => e.includes('invalid role:'))).toBe(true);
        expect(badAcctErrs.some((e) => e.includes('skills["Attack"]'))).toBe(true);
        expect(badAcctErrs.some((e) => e.includes('inventory[995]'))).toBe(true);

        const validPlan = {
            schemaVersion: 1,
            plannedAt: now,
            side: 'local',
            maxBots: 2,
            retentionMarginRatio: 0.15,
            selectedSlots: 0,
            recoveryQueue: [],
            accountPlans: {},
            transferOrders: [],
            spotAllocations: {},
        };
        expect(validateFleetPlan(validPlan)).toEqual([]);

        expect(validateFleetState({
            schemaVersion: 1,
            emittedAt: now,
            side: 'local',
            server: 'rs-sdk-demo.fly.dev',
            maxBots: 2,
            accounts: {},
            activeChains: {},
            idleReasons: {},
            goals: [],
            campaigns: [],
            missions: [],
            pendingTransfers: [],
            quarantinedDefects: [],
            rateStats: {},
        })).toEqual([]);

        expect(validateOperatorCommand({
            schemaVersion: 1,
            id: 'cmd-1',
            kind: 'override_account',
            issuedAt: now,
            issuedBy: 'owner',
            account: 'Worker01',
            activityId: 'gather:mining-ore',
            expiresAt: now + 60_000,
        })).toEqual([]);
        expect(validateOperatorCommand({
            schemaVersion: 1,
            id: 'bad id!',
            kind: 'override_account',
            issuedAt: now,
            issuedBy: '',
            account: 'Worker01',
            expiresAt: now - 1,
        }).length).toBeGreaterThanOrEqual(3);
    });

    test('planAccount and planAccountWithCandidates with _reuse match uncached results', () => {
        const now = 1_800_000_000_000;
        const acct: AccountState = {
            name: 'ParityBot',
            side: 'local',
            role: 'auto',
            protectedClock: false,
            lifecycle: 'idle',
            skills: { Woodcutting: { level: 15, xp: 2_500 }, Mining: { level: 1, xp: 0 }, Hitpoints: { level: 10, xp: 1154 } },
            quests: {},
            pos: { x: 3200, z: 3200, level: 0 },
            inventory: { 995: 5000, 1351: 1, 1265: 1 },
            equipment: {},
            bank: { items: { 995: 5000 }, observedAt: now - 1_000, trusted: true },
        };
        const world: WorldSnapshot = {
            schemaVersion: 1,
            at: now,
            side: 'local',
            server: 'rs-sdk-demo.fly.dev',
            accounts: { paritybot: acct },
        };
        const activities: ActivityDefinition[] = [
            {
                id: 'wc:oak-a',
                workerId: 'gather',
                family: 'gather',
                kind: 'gather',
                label: 'Oak logs (slow)',
                trust: 'practice_passed',
                skill: 'Woodcutting',
                spotId: 'spot:oak-a',
                config: { action: 'oak-a' },
                baselineRate: { unitsPerTick: 0.08, xpPerTick: 3, gpPerTick: 0, setupTicks: 10, minBatchUnits: 10, confidence: 'practice', skillXpPerTick: { Woodcutting: 3 } },
                outputs: [{ itemId: 1521, countPerUnit: 1 }],
            },
            {
                id: 'wc:oak-b',
                workerId: 'gather',
                family: 'gather',
                kind: 'gather',
                label: 'Oak logs (fast)',
                trust: 'practice_passed',
                skill: 'Woodcutting',
                spotId: 'spot:oak-b',
                config: { action: 'oak-b' },
                baselineRate: { unitsPerTick: 0.16, xpPerTick: 6, gpPerTick: 0, setupTicks: 10, minBatchUnits: 10, confidence: 'practice', skillXpPerTick: { Woodcutting: 6 } },
                outputs: [{ itemId: 1521, countPerUnit: 1 }],
            },
            {
                id: 'mine:copper',
                workerId: 'gather',
                family: 'gather',
                kind: 'gather',
                label: 'Copper ore',
                trust: 'practice_passed',
                skill: 'Mining',
                spotId: 'spot:copper',
                config: { action: 'copper' },
                baselineRate: { unitsPerTick: 0.12, xpPerTick: 2, gpPerTick: 0, setupTicks: 8, minBatchUnits: 10, confidence: 'practice', skillXpPerTick: { Mining: 2 } },
                outputs: [{ itemId: 436, countPerUnit: 1 }],
            },
        ];
        const demands: GoalDemand[] = [
            { id: 'd:oak', goalKind: 'main_supply', target: { kind: 'item', itemId: 1521, count: 50 }, fulfilled: 0, remaining: 50, valueScore: 100, priorityWeight: 1, active: true },
            { id: 'd:copper', goalKind: 'main_supply', target: { kind: 'item', itemId: 436, count: 40 }, fulfilled: 0, remaining: 40, valueScore: 50, priorityWeight: 1, active: true },
        ];
        const shared = buildPlannerSharedIndex({ world, activities });
        const reuse = createAccountPlannerReuse(acct, world);

        const uncached = planAccountWithCandidates(acct, { world, activities, demands, _sharedIndex: shared });
        const reused = planAccountWithCandidates(acct, { world, activities, demands, _sharedIndex: shared, _reuse: reuse });
        expect(reused).toEqual(uncached);

        const excluded = new Set(['spot:oak-b']);
        const uncachedFiltered = planAccount(acct, { world, activities, demands: [demands[0]!], _sharedIndex: shared, excludedSpotIds: excluded });
        const reusedFiltered = planAccount(acct, { world, activities, demands: [demands[0]!], _sharedIndex: shared, excludedSpotIds: excluded, _reuse: reuse });
        expect(reusedFiltered).toEqual(uncachedFiltered);
    });
});
