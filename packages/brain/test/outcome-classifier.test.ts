import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRunOutcome } from '../../workers/src/contracts';
import {
    classifyRawWorkerExit,
    createRateStore,
    defaultActivityCatalog,
    loadWorldSnapshot,
    marketCooldownKey,
    OutcomeClassifier,
    validateDefectRecord,
    validateWorldSnapshot,
    type AccountState,
    type WorldSnapshot,
} from '../src/index';

let tempRoot = '';
const NOW = 1_800_000_000_000;

function makeAccount(name: string, lifecycle: AccountState['lifecycle'] = 'idle'): AccountState {
    return {
        name,
        side: 'local',
        role: 'helper',
        protectedClock: false,
        lifecycle,
        skills: { Attack: { level: 40, xp: 37_224 } },
        quests: {},
        pos: { x: 3185, z: 3436, level: 0 },
        inventory: {},
        equipment: {},
        bank: { items: { 995: 50_000 }, observedAt: NOW - 1000, trusted: true },
    };
}

function makeSnapshot(accounts: Record<string, AccountState>): WorldSnapshot {
    return {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts,
    };
}

beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'brain-outcome-'));
});

afterEach(() => {
    if (tempRoot) {
        rmSync(tempRoot, { recursive: true, force: true });
        tempRoot = '';
    }
});

describe('OutcomeClassifier & classifyRawWorkerExit', () => {
    test('classifyRawWorkerExit maps raw process exits to all 8 valid RunOutcome kinds', () => {
        const cases: Array<Parameters<typeof classifyRawWorkerExit>[0]> = [
            { activityId: 'a:1', account: 'Bot1', exitCode: 0, status: 'done', ticksElapsed: 100, unitsCompleted: 20, xpGained: { Woodcutting: 500 } },
            { activityId: 'a:2', account: 'Bot1', exitCode: 1, reason: 'missing_supply: insufficient coins need 5000', ticksElapsed: 5 },
            { activityId: 'a:3', account: 'Bot1', exitCode: 1, reason: 'location_stranded upstairs unreachable bank', pos: { x: 3208, z: 3214, level: 2 }, ticksElapsed: 20 },
            { activityId: 'a:4', account: 'Bot1', exitCode: 1, reason: 'market_unavailable out of stock item=1333 shop empty', ticksElapsed: 10 },
            { activityId: 'a:5', account: 'Bot1', exitCode: 1, reason: 'session_unsettled: missing logout proof', ticksElapsed: 0 },
            { activityId: 'a:6', account: 'Bot1', exitCode: 1, stderr: 'ECONNREFUSED socks proxy tunnel 502', ticksElapsed: 0 },
            { activityId: 'a:7', account: 'Bot1', exitCode: 1, error: 'TypeError: undefined is not an object at tick 42', logPath: 'run.log', ticksElapsed: 42 },
            { activityId: 'a:8', account: 'Bot1', exitCode: 1, reason: 'Oh dear, you are dead! died in wilderness', ticksElapsed: 85 },
        ];

        const kinds = cases.map((c) => {
            const out = classifyRawWorkerExit(c);
            expect(validateRunOutcome(out)).toEqual([]);
            return out.kind;
        });

        expect(kinds).toEqual([
            'target_met',
            'missing_supply',
            'location_stranded',
            'market_unavailable',
            'session_unsettled',
            'infra_fault',
            'worker_defect',
            'death',
        ]);
    });

    test('applies all 8 OutcomeKind state transitions accurately with persistence', () => {
        const catalog = defaultActivityCatalog();
        const rateStore = createRateStore({
            catalog,
            root: tempRoot,
            minSamplesToOverride: 1,
            minTicksToOverride: 50,
        });
        const classifier = new OutcomeClassifier({
            rateStore,
            root: tempRoot,
            defaultMarketCooldownMs: 60_000,
            defaultRecoveryHoldTtlMs: 120_000,
            defaultDefectTtlMs: 600_000,
            infraBaseBackoffMs: 10_000,
            infraBackoffFactor: 2,
            infraMaxBackoffMs: 40_000,
        });

        const baseActId = catalog.byFamily('gather')[0]!.id;

        // 1. target_met -> updates RateStore, clears transient holds, unlocks follow-up
        const resMet = classifier.applyOutcome(
            {
                kind: 'target_met',
                activityId: baseActId,
                account: 'HelperA',
                ticksElapsed: 100,
                unitsCompleted: 40,
                xpGained: { Woodcutting: 2500 },
                coinsDelta: 1200,
            },
            { now: NOW, domain: 'live' },
        );
        expect(resMet.unlockFollowUp).toBe(true);
        expect(resMet.accountPenalized).toBe(false);
        expect(resMet.recordedRateSample).toBeDefined();
        expect(rateStore.hasOverride(baseActId)).toBe(true);

        // 2. missing_supply -> does NOT penalize account or quarantine activity
        const resMissing = classifier.applyOutcome(
            {
                kind: 'missing_supply',
                activityId: baseActId,
                account: 'HelperA',
                ticksElapsed: 10,
                missing: [{ itemId: 995, required: 10000, available: 500, itemName: 'Coins' }],
            },
            { now: NOW + 1000 },
        );
        expect(resMissing.accountPenalized).toBe(false);
        expect(resMissing.missingSupplies).toHaveLength(1);
        expect(classifier.isQuarantined(baseActId, NOW + 1000)).toBe(false);

        // 3. location_stranded -> sets needs_location_recovery + maintenance TTL hold, does not retire activity
        const resStranded = classifier.applyOutcome(
            {
                kind: 'location_stranded',
                activityId: baseActId,
                account: 'HelperB',
                ticksElapsed: 15,
                pos: { x: 3208, z: 3214, level: 2 },
                detail: 'trapped upstairs',
            },
            { now: NOW + 2000 },
        );
        expect(resStranded.accountLifecycle).toBe('needs_location_recovery');
        expect(resStranded.addedHold?.kind).toBe('maintenance');
        expect(classifier.isQuarantined(baseActId, NOW + 2000)).toBe(false);

        // 4. market_unavailable -> adds bounded (item, venue) TTL cooldown on both world and account
        const resMarket = classifier.applyOutcome(
            {
                kind: 'market_unavailable',
                activityId: 'market:shop-buy',
                account: 'HelperA',
                ticksElapsed: 12,
                itemId: 1333,
                venue: 'Varrock_Sword_Shop',
                cooldownMs: 30_000,
            },
            { now: NOW + 3000 },
        );
        const cdKey = marketCooldownKey(1333, 'Varrock_Sword_Shop');
        expect(resMarket.addedCooldownKey).toBe(cdKey);
        expect(resMarket.accountPenalized).toBe(false);
        expect(classifier.activeMarketCooldowns(NOW + 10_000)[cdKey]).toBe(NOW + 33_000);
        expect(classifier.activeMarketCooldowns(NOW + 40_000)[cdKey]).toBeUndefined();

        // 5. session_unsettled -> schedules needs_logout_recovery + retry_backoff hold
        const resSession = classifier.applyOutcome(
            {
                kind: 'session_unsettled',
                activityId: baseActId,
                account: 'HelperC',
                ticksElapsed: 0,
                reason: 'missing server logged-out end',
            },
            { now: NOW + 4000 },
        );
        expect(resSession.accountLifecycle).toBe('needs_logout_recovery');
        expect(resSession.addedHold?.kind).toBe('retry_backoff');

        // 6. infra_fault -> trips global circuit breaker with exponential backoff WITHOUT penalizing account
        const resInfra1 = classifier.applyOutcome(
            {
                kind: 'infra_fault',
                activityId: baseActId,
                account: 'HelperA',
                ticksElapsed: 0,
                source: 'proxy',
                detail: '502 bad gateway',
            },
            { now: NOW + 5000 },
        );
        expect(resInfra1.accountPenalized).toBe(false);
        expect(resInfra1.infraBreaker?.open).toBe(true);
        expect(classifier.canProceedInfra(NOW + 6000).allowed).toBe(false);
        expect(classifier.canProceedInfra(NOW + 15_000).allowed).toBe(true);

        const resInfra2 = classifier.applyOutcome(
            {
                kind: 'infra_fault',
                activityId: baseActId,
                account: 'HelperA',
                ticksElapsed: 0,
                source: 'server_drain',
            },
            { now: NOW + 16_000 },
        );
        expect(resInfra2.infraBreaker?.consecutiveFaults).toBe(2);
        expect(classifier.canProceedInfra(NOW + 25_000).allowed).toBe(false); // 20_000ms backoff -> retryAt +36_000
        classifier.recordInfraSuccess(NOW + 37_000);
        expect(classifier.canProceedInfra(NOW + 37_000).allowed).toBe(true);

        // 7. worker_defect -> quarantines (activityId, faultSignature) without blaming account; clearable explicitly
        const defectAct = 'quest:waterfall_quest';
        const d1 = classifier.applyOutcome(
            {
                kind: 'worker_defect',
                activityId: defectAct,
                account: 'HelperA',
                ticksElapsed: 50,
                faultSignature: 'NullPointerAtDoor',
                logPath: '.practice/live/logs/helpera.log',
                detail: 'door interact failed',
            },
            { now: NOW + 38_000, workerRelease: 'sha-abc' },
        );
        expect(d1.accountPenalized).toBe(false);
        expect(d1.defect).toBeDefined();
        expect(validateDefectRecord(d1.defect)).toEqual([]);
        expect(classifier.isQuarantined(defectAct, NOW + 39_000)).toBe(true);

        // Repeated identical signature increments count rather than duplicating records
        const d2 = classifier.applyOutcome(
            {
                kind: 'worker_defect',
                activityId: defectAct,
                account: 'HelperB',
                ticksElapsed: 30,
                faultSignature: 'NullPointerAtDoor',
            },
            { now: NOW + 40_000 },
        );
        expect(d2.defect?.count).toBe(2);
        expect(classifier.quarantinedDefects(NOW + 41_000).filter((d) => d.activityId === defectAct)).toHaveLength(1);

        // 8. death -> marks account dead (non-expiring!) and quarantines activity with outcomeKind='death'
        const deathAct = 'combat:hill-giants';
        const resDeath = classifier.applyOutcome(
            {
                kind: 'death',
                activityId: deathAct,
                account: 'HelperD',
                ticksElapsed: 200,
                faultSignature: 'PoisonedWithoutAntipoison',
                pos: { x: 3115, z: 9850, level: 0 },
                logPath: '.practice/live/logs/helperd.log',
            },
            { now: NOW + 42_000 },
        );
        expect(resDeath.accountLifecycle).toBe('dead');
        expect(resDeath.defect?.outcomeKind).toBe('death');
        expect(classifier.isQuarantined(deathAct, NOW + 43_000)).toBe(true);

        // Snapshot overlay transitions accounts cleanly; death NEVER expires even days later
        const snap = makeSnapshot({
            HelperA: makeAccount('HelperA'),
            HelperB: makeAccount('HelperB'),
            HelperC: makeAccount('HelperC'),
            HelperD: makeAccount('HelperD', 'running'),
        });
        const farFuture = NOW + 10 * 86_400_000;
        // Inject an activeJob so HelperD starts validly as 'running' before death overlay clears it
        const snapWithJob: WorldSnapshot = {
            ...snap,
            accounts: {
                ...snap.accounts,
                HelperD: {
                    ...snap.accounts.HelperD!,
                    activeJob: { activityId: deathAct, demandId: 'd1', startedAt: NOW },
                },
            },
        };
        const updatedNear = classifier.applyToSnapshot(snapWithJob, NOW + 43_000);
        expect(validateWorldSnapshot(updatedNear)).toEqual([]);
        expect(updatedNear.accounts.HelperB!.lifecycle).toBe('needs_location_recovery');
        expect(updatedNear.accounts.HelperC!.lifecycle).toBe('needs_logout_recovery');
        expect(updatedNear.accounts.HelperD!.lifecycle).toBe('dead');
        expect(updatedNear.accounts.HelperD!.activeJob).toBeUndefined();

        const updatedFar = classifier.applyToSnapshot(snapWithJob, farFuture);
        expect(updatedFar.accounts.HelperB!.lifecycle).toBe('idle'); // expired recovery hold
        expect(updatedFar.accounts.HelperC!.lifecycle).toBe('idle'); // expired recovery hold
        expect(updatedFar.accounts.HelperD!.lifecycle).toBe('dead'); // death never expires

        // Reload from disk verifies persistence + OperatorCommand defect clearing
        const reloaded = new OutcomeClassifier({ root: tempRoot });
        expect(reloaded.isQuarantined(defectAct, NOW + 43_000)).toBe(true);
        const cleared = reloaded.applyOperatorCommand(
            {
                schemaVersion: 1,
                id: 'cmd-1',
                issuedAt: NOW + 50_000,
                issuedBy: 'owner',
                kind: 'clear_defect',
                activityId: defectAct,
            },
            NOW + 50_000,
        );
        expect(cleared).toBe(true);
        expect(reloaded.isQuarantined(defectAct, NOW + 50_000)).toBe(false);

        // Disk overlay also integrates seamlessly into loadWorldSnapshot
        const diskSnap = loadWorldSnapshot({ root: tempRoot, now: NOW + 45_000 });
        expect(validateWorldSnapshot(diskSnap)).toEqual([]);
    });

    test('classifies shop-buy boughtTotal=0 stop=stock-wait as market_unavailable and honors skipRateSample', () => {
        const catalog = defaultActivityCatalog();
        const rateStore = createRateStore({
            catalog,
            root: tempRoot,
            minSamplesToOverride: 1,
            minTicksToOverride: 10,
        });
        const classifier = new OutcomeClassifier({ rateStore, root: tempRoot });
        const actId = catalog.byFamily('gather')[0]!.id;

        const shopOut = classifier.classifyAndApplyRaw(
            {
                activityId: 'market:shop-buy',
                account: 'HelperA',
                exitCode: 1,
                status: 'fail',
                marketItemId: 1317,
                marketVenue: 'shop:taverley2hand',
                stdout: 'RESULT fail ticks=40 boughtTotal=0 stop=stock-wait targetMet=0',
                ticksElapsed: 40,
            },
            { now: NOW },
        );
        expect(shopOut.outcome.kind).toBe('market_unavailable');
        expect(shopOut.addedCooldownKey).toBe('1317:shop:taverley2hand');
        expect(classifier.activeMarketCooldowns(NOW + 1_000)['1317:shop:taverley2hand']).toBeGreaterThan(NOW);

        // Multi-step chain outcome with skipRateSample=true must NOT pollute RateStore on target_met or death.
        const chainOk = classifier.classifyAndApplyRaw(
            {
                activityId: actId,
                account: 'HelperA',
                exitCode: 0,
                status: 'ok',
                ticksElapsed: 120,
                unitsCompleted: 30,
                xpGained: { Woodcutting: 1500 },
                skipRateSample: true,
            },
            { now: NOW + 2_000 },
        );
        expect(chainOk.outcome.kind).toBe('target_met');
        expect(chainOk.recordedRateSample).toBeUndefined();
        expect(rateStore.hasOverride(actId)).toBe(false);

        const chainDeath = classifier.classifyAndApplyRaw(
            {
                activityId: actId,
                account: 'HelperB',
                exitCode: 1,
                died: true,
                reason: 'died after 1 runs',
                ticksElapsed: 50,
                skipRateSample: true,
            },
            { now: NOW + 3_000 },
        );
        expect(chainDeath.outcome.kind).toBe('death');
        expect(chainDeath.accountLifecycle).toBe('dead');
        expect(chainDeath.recordedRateSample).toBeUndefined();
        expect(rateStore.hasOverride(actId)).toBe(false);
    });
});
