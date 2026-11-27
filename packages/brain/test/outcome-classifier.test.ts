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
    REPEAT_DEFECT_TTL_MS,
    REPEAT_WINDOW_MS,
    defectBlocksAccount,
    isFleetWideDefect,
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
    test('a died=false or "died":false field is not a death; a true flag or a death in words is', () => {
        const run = (stdout: string, status = 'fail', exitCode = 1) => classifyRawWorkerExit({ activityId: 'quest:dragon', account: 'Bot1', exitCode, status, reason: 'blocked after 3 runs', stdout }).kind;
        expect(run('RESULT fail walk guildmaster approach: quest corridor exhausted bounded retries  xp= at=3047,9757,0 ticks=9 hpMin=99 eats=0 walkTicks=6 retries=2 died=false milestones= jumps=')).toBe('worker_defect');
        expect(run('RESULT ok {"ok":true,"conserved":true,"hpMin":76,"died":false,"damaged":false}', 'ok', 0)).toBe('target_met');
        expect(run('RESULT ok {"totalBanked":27,"held":0,"trips":1,"died": false,"failure":"-"}', 'ok', 0)).toBe('target_met');
        expect(run('RESULT fail level=60 xp=273000 totalTicks=900 relogs=2 stop=died')).toBe('death');
        expect(run('RESULT fail died at 3094,3488 after 2 eats')).toBe('death');
        expect(run('RESULT fail quest-sweep travel died=true at=3070,3650,0')).toBe('death');
        expect(run('RESULT fail {"ok":false,"died":true}')).toBe('death');
        expect(run('DEATH at=2934,9826,0 wild=0 hp=1/84 by=Black_Knight#179')).toBe('death');
        expect(run('RESULT fail Oh dear, you are dead!')).toBe('death');
    });

    test('a quest sweep that could not stage an item names each item and count it misses', () => {
        const out = classifyRawWorkerExit({ activityId: 'quest:squire', account: 'Bot1', exitCode: 1, status: 'RESULT fail quest-sweep squire missing 2325:1,2351:2 (unsold; others in shops)', ticksElapsed: 60 });
        expect(out.kind).toBe('missing_supply');
        expect(out.kind === 'missing_supply' && out.missing).toEqual([
            { itemId: 2325, required: 1, available: 0 },
            { itemId: 2351, required: 2, available: 0 },
        ]);
        const short = classifyRawWorkerExit({ activityId: 'quest:ball', account: 'Bot1', exitCode: 1, status: 'RESULT fail quest-sweep ball withdraw short 1985:1', ticksElapsed: 40 });
        expect(short.kind === 'missing_supply' && short.missing).toEqual([{ itemId: 1985, required: 1, available: 0 }]);
    });

    test('the Death Plateau slug "death" names a quest, not a death', () => {
        // The supervisor end line and the RESULT text of a supervised quest sweep.
        const plateau = classifyRawWorkerExit({
            activityId: 'quest:death', account: 'Stirmypot', exitCode: 1, status: 'fail', reason: 'blocked after 2 runs',
            detail: 'RESULT fail quest-sweep death missing 2064:1,2351:1 (unsold; others in shops)',
            stdout: 'RESULT fail quest-sweep death missing 2064:1,2351:1 (unsold; others in shops)',
        });
        expect(plateau.kind).toBe('missing_supply');
        expect(plateau.kind === 'missing_supply' && plateau.missing.map((m) => m.itemId)).toEqual([2064, 2351]);
        const named = (text: string) => classifyRawWorkerExit({ activityId: 'quest:death', account: 'Bot1', exitCode: 1, status: 'fail', reason: 'stopped after 1 runs', stdout: text }).kind;
        expect(named('RESULT fail walk denulth approach: quest corridor exhausted bounded retries script=scripts/generated/quest-death.ts')).toBe('worker_defect');
        expect(named('RESULT fail Death Plateau journal stage unknown')).toBe('worker_defect');
        expect(named('RESULT fail quest-sweep death died=true at=2860,3590,0')).toBe('death');
        expect(named('RESULT fail quest-sweep death: you are dead')).toBe('death');
    });

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

    test('a saved defect whose text is a gate line (release hold, held claim, stop) does not quarantine after a load', () => {
        const dir = mkdtempSync(join(tmpdir(), 'outcome-gate-held-'));
        try {
            const first = new OutcomeClassifier({ root: dir });
            const gate = [
                'RESULT fail login: Error: no worker progress: release peer state unknown; verify offline before rollout chain rounds=1 ok=0 failed=1',
                'RESULT fail Error: fleet account claim held by swarm',
                'RESULT fail login: Error: fleet trade claim held for order xfer-1795716345453-2',
                'RESULT fail magic-order stop requested level=15 target=56 casts=11 spent=0 chain rounds=1 ok=0 failed=1',
            ];
            // A lost session writes this text too, and a saved record has no supervisor end reason: it stays.
            first.applyOutcome(
                { kind: 'worker_defect', activityId: 'real:1', account: 'HelperA', ticksElapsed: 1, faultSignature: 'SessionLost', detail: 'RESULT fail {"ok":false,"failure":"production session stopped"}', logPath: 'x.log' },
                { now: NOW },
            );
            gate.forEach((detail, i) => first.applyOutcome(
                { kind: 'worker_defect', activityId: `gate:${i}`, account: 'HelperA', ticksElapsed: 1, faultSignature: detail, detail, logPath: 'x.log' },
                { now: NOW },
            ));
            first.applyOutcome(
                { kind: 'worker_defect', activityId: 'real:0', account: 'HelperA', ticksElapsed: 1, faultSignature: 'DoorStuck', detail: 'RESULT fail door stayed closed', logPath: 'x.log' },
                { now: NOW },
            );
            expect(first.quarantinedDefects(NOW + 1).length).toBe(6);
            const reloaded = new OutcomeClassifier({ root: dir });
            expect(reloaded.quarantinedDefects(NOW + 1).map((d) => d.activityId).sort()).toEqual(['real:0', 'real:1']);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('a defect whose hold expired or was cleared counts its next failure as a first one', () => {
        const classifier = new OutcomeClassifier({ persist: false, defaultDefectTtlMs: 600_000 });
        const fail = (account: string, now: number) => classifier.applyOutcome(
            { kind: 'worker_defect', activityId: 'gather:x', account, ticksElapsed: 10, faultSignature: 'DoorStuck' },
            { now },
        ).defect?.count;
        expect(fail('A', NOW)).toBe(1);
        expect(fail('B', NOW + 1_000)).toBe(2);
        // The hold expires: the next failure starts a new count.
        expect(fail('C', NOW + 1_000 + 600_000)).toBe(1);
        // The owner clears the hold: the next failure starts a new count.
        expect(classifier.clearDefect({ activityId: 'gather:x' })).toBe(1);
        expect(fail('D', NOW + 700_000)).toBe(1);
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

test('a short planned shop order cools its venue only when the shelf was empty', () => {
    const kind = (status: string) => classifyRawWorkerExit({ activityId: 'market:shop-buy', account: 'Bot1', exitCode: 1, status }).kind;
    expect(kind('RESULT fail order short bought=0/2: shop out of stock ticks=281 boughtTotal=0 stop=stock-wait')).toBe('market_unavailable');
    const capped = classifyRawWorkerExit({ activityId: 'market:shop-buy', account: 'Bot1', exitCode: 1, status: 'RESULT fail order short itemId=314 need=1565 bought=435/2000: missing supply after stop=cap ticks=3085 boughtTotal=435 stop=cap' });
    // A capped order with stock on the shelf is a supply shortfall: no venue cooldown, no worker quarantine.
    expect(capped.kind).toBe('missing_supply');
    if (capped.kind === 'missing_supply') expect(capped.missing).toEqual([{ itemId: 314, required: 1565, available: 0 }]);
    expect(kind('RESULT fail order short bought=0/1: insufficient coins ticks=99 boughtTotal=0 stop=coin-reserve')).toBe('missing_supply');
});

test('an empty shop shelf cools the shop until it restocks, never for less than the default cooldown', () => {
    const root = mkdtempSync(join(tmpdir(), 'brain-outcome-restock-'));
    try {
        const classifier = new OutcomeClassifier({ root });
        const stall = classifier.classifyAndApplyRaw(
            {
                activityId: 'market:shop-buy',
                account: 'OreElse',
                exitCode: 1,
                status: 'fail',
                marketItemId: 1607,
                marketVenue: 'shop:ardougnegemstall',
                detail: 'RESULT fail order short bought=0/10: shop out of stock ticks=162 boughtTotal=0 stop=stock-wait chain rounds=1 ok=0 failed=1',
            },
            { now: NOW },
        );
        expect(stall.outcome.kind).toBe('market_unavailable');
        expect(stall.addedCooldownKey).toBe('1607:shop:ardougnegemstall');
        // knowledge/shops.json: the Ardougne gem stall restocks its sapphires each 15000 ticks of 400 ms.
        expect(stall.cooldownExpiresAt).toBe(NOW + 15_000 * 400);
        const unknown = classifier.classifyAndApplyRaw(
            { activityId: 'market:shop-buy', account: 'OreElse', exitCode: 1, status: 'fail', marketItemId: 383, marketVenue: 'shop:no_such_shop', detail: 'RESULT fail order short bought=0/1: shop out of stock stop=stock-wait' },
            { now: NOW },
        );
        expect(unknown.cooldownExpiresAt).toBe(NOW + 10 * 60_000);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('infra breaker: faults in one wait do not grow it, and a non-infra run end after the wait resets the count', () => {
    const c = new OutcomeClassifier({ persist: false, infraBaseBackoffMs: 30_000, infraBackoffFactor: 2, infraMaxBackoffMs: 900_000 });
    const fault = (now: number) => c.applyOutcome(
        { kind: 'infra_fault', activityId: 'quest:x', account: 'HelperA', ticksElapsed: 0, source: 'claim_authority', detail: 'Could not resolve host: github.com' },
        { now },
    );
    // Six runs fail in one network drop, all inside the first 30 s wait.
    for (let i = 0; i < 6; i++) fault(NOW + i * 1000);
    expect(c.canProceedInfra(NOW).state.consecutiveFaults).toBe(1);
    expect(c.canProceedInfra(NOW + 29_000).allowed).toBe(false);
    expect(c.canProceedInfra(NOW + 30_000).allowed).toBe(true);
    // A failed retry after the wait doubles it.
    expect(fault(NOW + 31_000).infraBreaker?.consecutiveFaults).toBe(2);
    expect(c.canProceedInfra(NOW + 90_000).allowed).toBe(false);
    // A run that ends before the retry time does not close the breaker.
    c.applyOutcome({ kind: 'target_met', activityId: 'quest:x', account: 'HelperB', ticksElapsed: 10, durationMs: 1000 }, { now: NOW + 40_000 });
    expect(c.canProceedInfra(NOW + 40_000).allowed).toBe(false);
    // A run that started before the fault and ends after the retry time made no new claim: the count stays.
    c.applyOutcome({ kind: 'target_met', activityId: 'quest:x', account: 'HelperB', ticksElapsed: 10, durationMs: 90_000 }, { now: NOW + 100_000 });
    expect(c.canProceedInfra(NOW + 100_000).state.consecutiveFaults).toBe(2);
    // An outcome without its duration does not reset either.
    c.applyOutcome({ kind: 'target_met', activityId: 'quest:x', account: 'HelperB', ticksElapsed: 10 }, { now: NOW + 100_000 });
    expect(c.canProceedInfra(NOW + 100_000).state.consecutiveFaults).toBe(2);
    // A run that started after the fault and ends after the retry time closes it and resets the count, so the
    // next drop waits 30 s again.
    c.applyOutcome({ kind: 'target_met', activityId: 'quest:x', account: 'HelperB', ticksElapsed: 10, durationMs: 10_000 }, { now: NOW + 100_000 });
    expect(c.canProceedInfra(NOW + 100_000).state).toEqual({ open: false, consecutiveFaults: 0 });
    expect(fault(NOW + 200_000).infraBreaker?.retryAt).toBe(NOW + 230_000);
});

describe('repeat faults', () => {
    const TREE = 'RESULT fail quest-sweep tree missing 2434:2 (unsold; others in shops)';
    const raw = (account: string, detail: string, durationMs: number, activityId = 'quest:tree') =>
        ({ activityId, account, exitCode: 1, status: 'fail', reason: 'gave-up after 1 runs', detail, durationMs });

    test('a fast missing-supply fault that repeats holds the activity for its account, then for every account', () => {
        const c = new OutcomeClassifier({ persist: false });
        const fail = (account: string, at: number, durationMs = 20_000) => c.classifyAndApplyRaw(raw(account, TREE, durationMs), { now: at });
        expect(fail('Fatstack', NOW).defect).toBeUndefined();
        // A long run worked for a while: it does not count.
        expect(fail('Fatstack', NOW + 1_000, 600_000).defect).toBeUndefined();
        const own = fail('Fatstack', NOW + 2_000).defect;
        expect(own?.quarantined).toBe(true);
        expect(isFleetWideDefect(own!)).toBe(false);
        expect(defectBlocksAccount(own!, 'Fatstack', NOW + 3_000)).toBe(true);
        expect(defectBlocksAccount(own!, 'Earlyshooter', NOW + 3_000)).toBe(false);
        expect(own!.expiresAt).toBe(NOW + 2_000 + REPEAT_DEFECT_TTL_MS);

        expect(fail('Earlyshooter', NOW + 4_000).defect).toBeUndefined();
        const fleet = fail('Fingerblastr', NOW + 5_000).defect;
        expect(isFleetWideDefect(fleet!)).toBe(true);
        expect(defectBlocksAccount(fleet!, 'Billionaire', NOW + 6_000)).toBe(true);
    });

    test('the missing item ids name the fault, not the supervisor end', () => {
        const c = new OutcomeClassifier({ persist: false });
        // Each run has the same end reason; two different missing items are two faults.
        c.classifyAndApplyRaw(raw('Fatstack', 'RESULT fail quest-sweep tree missing 2434:2', 20_000), { now: NOW });
        expect(c.classifyAndApplyRaw(raw('Fatstack', 'RESULT fail quest-sweep tree missing 1925:1', 20_000), { now: NOW + 1_000 }).defect).toBeUndefined();
        c.classifyAndApplyRaw(raw('Earlyshooter', 'RESULT fail quest-sweep tree missing 1925:1', 20_000), { now: NOW + 2_000 });
        expect(c.classifyAndApplyRaw(raw('Fingerblastr', 'RESULT fail quest-sweep tree missing 2434:2', 20_000), { now: NOW + 3_000 }).defect).toBeUndefined();
        // A count change of the same item is the same fault.
        const same = c.classifyAndApplyRaw(raw('Fatstack', 'RESULT fail quest-sweep tree missing 2434:3', 20_000), { now: NOW + 4_000 }).defect;
        expect(same?.faultSignature).toBe('repeat missing_supply: missing 2434 [fatstack]');
        expect(same?.detail).toContain('gave-up after 1 runs: missing 2434');
    });

    test('two accounts that each fail twice hold the activity only for themselves', () => {
        const c = new OutcomeClassifier({ persist: false });
        const fail = (account: string, at: number) => c.classifyAndApplyRaw(raw(account, TREE, 20_000), { now: at }).defect;
        fail('Fatstack', NOW);
        const a = fail('Fatstack', NOW + 1_000)!;
        fail('Earlyshooter', NOW + 2_000);
        const b = fail('Earlyshooter', NOW + 3_000)!;
        for (const d of [a, b]) expect(isFleetWideDefect(d)).toBe(false);
        const held = c.quarantinedDefects(NOW + 4_000);
        expect(held.some(d => defectBlocksAccount(d, 'Fatstack', NOW + 4_000))).toBe(true);
        expect(held.some(d => defectBlocksAccount(d, 'Earlyshooter', NOW + 4_000))).toBe(true);
        expect(held.some(d => defectBlocksAccount(d, 'Billionaire', NOW + 4_000))).toBe(false);
        expect(isFleetWideDefect(fail('Fingerblastr', NOW + 5_000)!)).toBe(true);
    });

    test('a run that meets its target ends the count, and old faults leave the window', () => {
        const c = new OutcomeClassifier({ persist: false });
        const arena = 'RESULT fail quest-sweep arena missing 2434:3';
        const fail = (at: number) => c.classifyAndApplyRaw(raw('Bigpackage', arena, 7_000, 'quest:arena'), { now: at });
        expect(fail(NOW).defect).toBeUndefined();
        c.applyOutcome({ kind: 'target_met', activityId: 'quest:arena', account: 'Fatstack', ticksElapsed: 900, durationMs: 400_000 }, { now: NOW + 1_000 });
        expect(fail(NOW + 2_000).defect).toBeUndefined();
        expect(fail(NOW + 2_000 + REPEAT_WINDOW_MS).defect).toBeUndefined();
    });

    test('repeat faults survive a classifier reload', () => {
        const dir = mkdtempSync(join(tmpdir(), 'repeat-faults-'));
        const file = join(dir, 'outcome-state.json');
        try {
            new OutcomeClassifier({ filePath: file }).classifyAndApplyRaw(raw('Fatstack', TREE, 20_000), { now: NOW });
            expect(new OutcomeClassifier({ filePath: file }).classifyAndApplyRaw(raw('Fatstack', TREE, 20_000), { now: NOW + 1_000 }).defect?.quarantined).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
