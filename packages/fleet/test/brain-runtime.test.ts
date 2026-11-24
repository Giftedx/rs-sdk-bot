import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    HUB_BANKER_LOCATIONS,
    validateFleetPlan,
    validateFleetState,
    type ActivityDefinition,
    type FleetPlan,
    type TransferOrder,
    type WorldSnapshot,
} from '../../brain/src/contracts';
import { createActivityCatalog, defaultActivityCatalog, type ActivityCatalog } from '../../brain/src/catalog';
import { createRateStore } from '../../brain/src/rate-store';
import { OutcomeClassifier } from '../../brain/src/outcome-classifier';
import { validOrder } from '../../core/src/fleet-trade-settlement';
import { MARKET_CACHE_MS, writeMarketCache } from '../../core/src/market-cache';
import { fleetStateFile, liveRoot, liveStatusDir, operatorCommandsDir, practiceRoot } from '../../core/src/practice-paths';
import {
    applyActivityOverridesToPlan,
    captureRunBaseline,
    extractWorkerOutcomeInput,
    isSafeOperatorCommandId,
    materializeBrainTransferOrders,
    readAccountOverrides,
    recordWorkerOutcome,
    runBrainCycle,
    writeAccountOverrides,
} from '../src/brain-runtime';
import { InfraCircuitBreaker } from '../src/infra-circuit-breaker';

const tempRoots: string[] = [];

function makeTempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'brain-runtime-'));
    tempRoots.push(dir);
    mkdirSync(join(dir, 'fleet'), { recursive: true });
    writeFileSync(
        join(dir, 'fleet', 'owners.json'),
        JSON.stringify({ accounts: { AlphaBot: { side: 'local', server: 'rs-sdk-demo.fly.dev' } } }, null, 2),
    );
    writeFileSync(
        join(dir, 'swarm.json'),
        JSON.stringify({ maxBots: 4, minFreeGB: 4, jobs: [] }, null, 2),
    );
    return dir;
}

afterEach(() => {
    for (const dir of tempRoots.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe('packages/fleet/src/brain-runtime', () => {
    test('runs an offline Brain cycle and publishes a valid FleetState file', () => {
        const root = makeTempRoot();
        const now = 1_700_000_100_000;
        const result = runBrainCycle({
            root,
            fleetDir: join(root, 'fleet'),
            now,
            side: 'local',
            maxBots: 4,
            marketQuotes: {},
        });

        expect(validateFleetState(result.fleetState)).toEqual([]);
        expect(existsSync(fleetStateFile(root))).toBe(true);
        const persisted = JSON.parse(readFileSync(fleetStateFile(root), 'utf8'));
        expect(persisted.schemaVersion).toBe(1);
        expect(persisted.side).toBe('local');
        expect(persisted.emittedAt).toBe(now);
        expect(persisted.accounts.alphabot).toBeDefined();
        expect(persisted.accounts.alphabot.name).toBe('AlphaBot');
    });

    test('applies pause/resume, override_account, set_campaign_state, clear_defect, and idempotent replay', () => {
        const root = makeTempRoot();
        const now = 1_700_000_200_000;
        const cmdDir = operatorCommandsDir(root);
        mkdirSync(cmdDir, { recursive: true });

        // First pause AlphaBot via operator command.
        const pauseCmd = {
            schemaVersion: 1,
            id: 'cmd-pause-1',
            issuedAt: now,
            issuedBy: 'operator',
            kind: 'pause_account',
            account: 'AlphaBot',
            reason: 'manual audit',
        };
        writeFileSync(join(cmdDir, '001-pause.json'), JSON.stringify(pauseCmd));

        // Seed a quarantined worker_defect so clear_defect has a real defect to clear.
        recordWorkerOutcome({
            root,
            now: now - 1000,
            raw: {
                activityId: 'skiller:fishing:cage',
                account: 'AlphaBot',
                status: 'fail',
                error: 'boom',
            },
        });

        // Add clear_defect + override_account + set_campaign_state commands.
        writeFileSync(
            join(cmdDir, '002-clear-defect.json'),
            JSON.stringify({
                schemaVersion: 1,
                id: 'cmd-clear-defect-1',
                issuedAt: now + 1,
                issuedBy: 'operator',
                kind: 'clear_defect',
                activityId: 'skiller:fishing:cage',
            }),
        );
        writeFileSync(
            join(cmdDir, '003-override.json'),
            JSON.stringify({
                schemaVersion: 1,
                id: 'cmd-override-1',
                issuedAt: now + 2,
                issuedBy: 'operator',
                kind: 'override_account',
                account: 'AlphaBot',
                activityId: 'skiller:woodcutting:yews',
                role: 'helper',
                expiresAt: now + 3_600_000,
            }),
        );
        writeFileSync(
            join(cmdDir, '004-campaign.json'),
            JSON.stringify({
                schemaVersion: 1,
                id: 'cmd-campaign-1',
                issuedAt: now + 3,
                issuedBy: 'operator',
                kind: 'set_campaign_state',
                campaignId: 'campaign:haggis',
                state: 'paused',
            }),
        );

        const firstRun = runBrainCycle({
            root,
            fleetDir: join(root, 'fleet'),
            now: now + 10,
            side: 'local',
            marketQuotes: {},
        });

        expect(firstRun.fleetState.accounts.alphabot?.lifecycle).toBe('paused_owner');
        expect(firstRun.fleetState.accounts.alphabot?.role).toBe('helper');
        expect(existsSync(join(practiceRoot(root), 'stop-AlphaBot'))).toBe(true);
        expect(existsSync(join(cmdDir, 'applied', 'cmd-pause-1.json'))).toBe(true);
        expect(firstRun.fleetState.quarantinedDefects).toEqual([]);
        const campaignHaggis = firstRun.fleetState.campaigns.find((c) => c.id === 'campaign:haggis');
        expect(campaignHaggis?.state).toBe('paused');
        expect(readAccountOverrides(root, now + 10).alphabot?.activityId).toBe('skiller:woodcutting:yews');

        // Duplicate command replay with same id must be ignored cleanly, while resume_account unpauses.
        writeFileSync(join(cmdDir, '005-dup-pause.json'), JSON.stringify(pauseCmd));
        writeFileSync(
            join(cmdDir, '006-resume.json'),
            JSON.stringify({
                schemaVersion: 1,
                id: 'cmd-resume-1',
                issuedAt: now + 20,
                issuedBy: 'operator',
                kind: 'resume_account',
                account: 'AlphaBot',
            }),
        );

        const secondRun = runBrainCycle({
            root,
            fleetDir: join(root, 'fleet'),
            now: now + 30,
            side: 'local',
            marketQuotes: {},
        });

        expect(secondRun.appliedCommands.find((c) => c.id === 'cmd-pause-1')?.duplicate).toBe(true);
        expect(existsSync(join(practiceRoot(root), 'stop-AlphaBot'))).toBe(false);
        expect(secondRun.fleetState.accounts.alphabot?.lifecycle).not.toBe('paused_owner');
        expect(existsSync(join(liveRoot(root), 'fleet-state.json'))).toBe(true);
    });

    test('extractWorkerOutcomeInput captures live ticks/xp/units/coins for RateStore and avoids false defect quarantine', () => {
        const root = makeTempRoot();
        const statusDir = liveStatusDir(root);
        mkdirSync(statusDir, { recursive: true });
        const startedAt = 1_700_000_500_000;

        // Pre-run status
        writeFileSync(
            join(statusDir, 'AlphaBot.json'),
            JSON.stringify({
                name: 'AlphaBot',
                server: 'rs-sdk-demo.fly.dev',
                at: startedAt - 10_000,
                started: startedAt - 60_000,
                tick: 100,
                skills: [{ name: 'Thieving', level: 55, xp: 170_000 }],
                inventory: [{ id: 995, count: 1000 }],
                bank: [{ id: 995, count: 5000 }],
                bankAt: startedAt - 12_000,
                result: 'ok done',
            }),
        );

        const baseline = captureRunBaseline(root, 'AlphaBot', 'rs-sdk-demo.fly.dev');
        expect(baseline).not.toBeNull();
        expect(baseline!.coins).toBe(6000);

        // Post-run status with real XP, units, coins, and missing_supply RESULT
        writeFileSync(
            join(statusDir, 'AlphaBot.json'),
            JSON.stringify({
                name: 'AlphaBot',
                server: 'rs-sdk-demo.fly.dev',
                at: startedAt + 30_000,
                started: startedAt,
                tick: 400,
                pos: { x: 2662, z: 3305, level: 0 },
                skills: [{ name: 'Thieving', level: 56, xp: 190_000 }],
                inventory: [{ id: 995, count: 8000 }],
                bank: [{ id: 995, count: 5000 }],
                bankAt: startedAt + 25_000,
                counters: { output: 140 },
                result: 'fail missing_supply item=385 required=20',
            }),
        );

        const raw = extractWorkerOutcomeInput({
            root,
            account: 'AlphaBot',
            activityId: 'gather:thieving-knights',
            server: 'rs-sdk-demo.fly.dev',
            startedAt,
            finishedAt: startedAt + 31_000,
            exitCode: 1,
            endReason: 'fail missing_supply',
            successful: false,
            lastResultLine: 'RESULT fail missing_supply item=385 required=20',
            logPath: join(practiceRoot(root), 'logs', 'AlphaBot.log'),
            baseline,
        });

        expect(raw.ticksElapsed).toBe(400);
        expect(raw.xpGained).toEqual({ Thieving: 20_000 });
        expect(raw.unitsCompleted).toBe(140);
        expect(raw.coinsDelta).toBe(7000);
        expect(raw.pos).toEqual({ x: 2662, z: 3305, level: 0 });
        expect(raw.stdout).toContain('missing_supply');
        expect(raw.logPath).toContain('AlphaBot.log');

        const catalog = createActivityCatalog();
        const rateStore = createRateStore({ catalog, root, minSamplesToOverride: 1, minTicksToOverride: 300 });
        const classifier = new OutcomeClassifier({ rateStore, root });

        // First classify a successful run so RateStore records a live sample
        const okRaw = { ...raw, exitCode: 0, status: 'ok', reason: 'done', stdout: 'RESULT ok done' };
        const okRes = classifier.classifyAndApplyRaw(okRaw, { now: startedAt + 31_000, domain: 'live' });
        expect(okRes.outcome.kind).toBe('target_met');
        expect(okRes.recordedRateSample?.ticksElapsed).toBe(400);
        expect(rateStore.hasOverride('gather:thieving-knights')).toBe(true);
        expect(rateStore.estimate('gather:thieving-knights').confidence).toBe('live');

        // Missing-supply result classifies as missing_supply, NOT quarantined worker_defect
        const supplyRes = classifier.classifyAndApplyRaw(raw, { now: startedAt + 32_000, domain: 'live' });
        expect(supplyRes.outcome.kind).toBe('missing_supply');
        expect(classifier.quarantinedDefects(startedAt + 32_000)).toEqual([]);
    });

    test('materializeBrainTransferOrders writes validOrder JSONs and deduplicates active pair+item transfers', () => {
        const root = makeTempRoot();
        const fleetDir = join(root, 'fleet');
        const now = 1_700_000_600_000;
        const world: WorldSnapshot = {
            schemaVersion: 1,
            at: now,
            side: 'local',
            server: 'rs-sdk-demo.fly.dev',
            accounts: {
                alphabot: {
                    name: 'AlphaBot',
                    side: 'local',
                    role: 'helper',
                    protectedClock: false,
                    lifecycle: 'idle',
                    skills: {},
                    quests: {},
                    pos: { x: 3185, z: 3436, level: 0 },
                    inventory: {},
                    equipment: {},
                    bank: { items: { 385: 100 }, observedAt: now - 1000, trusted: true },
                },
                betabot: {
                    name: 'BetaBot',
                    side: 'local',
                    role: 'army',
                    protectedClock: false,
                    lifecycle: 'idle',
                    skills: {},
                    quests: {},
                    pos: { x: 3185, z: 3436, level: 0 },
                    inventory: {},
                    equipment: {},
                    bank: { items: {}, observedAt: now - 1000, trusted: true },
                },
            },
        };
        const order1: TransferOrder = {
            id: 'xfer-brain-1',
            server: 'rs-sdk-demo.fly.dev',
            from: 'AlphaBot',
            to: 'BetaBot',
            hub: 'varrock_west',
            items: [{ itemId: 385, itemName: 'Shark', count: 50 }],
            demandId: 'd:shark',
            reason: 'supply sharks',
            createdAt: now,
            expiresAt: now + 600_000,
            state: 'planned',
            bothIdleVerified: true,
            donorLogoutConfirmedAt: now - 5_000,
            recipientLogoutConfirmedAt: now - 5_000,
            antiPingPong: { donorHoldsDemandForItems: false, cooldownWindowMs: 600_000 },
        };
        const orderDup: TransferOrder = { ...order1, id: 'xfer-brain-2' };

        const first = materializeBrainTransferOrders([order1, orderDup], { fleetDir, side: 'local', world, now });
        expect(first.written).toEqual(['xfer-brain-1']);
        expect(first.skipped).toEqual(['xfer-brain-2']);

        const writtenFile = join(fleetDir, 'orders', 'xfer-brain-1.json');
        expect(existsSync(writtenFile)).toBe(true);
        const parsed = JSON.parse(readFileSync(writtenFile, 'utf8'));
        expect(validOrder(parsed)).toBe(true);
        expect(parsed.takerWaits).toBe(true);
        expect(parsed.itemId).toBe(385);
        expect(parsed.count).toBe(50);
        expect(parsed.meet).toEqual([
            HUB_BANKER_LOCATIONS.varrock_west.meetTiles[0],
            HUB_BANKER_LOCATIONS.varrock_west.meetTiles[1],
        ]);
        expect(parsed.meet[0]).not.toEqual(parsed.meet[1]);

        const second = materializeBrainTransferOrders([{ ...order1, id: 'xfer-brain-3' }], {
            fleetDir,
            side: 'local',
            world,
            now: now + 1000,
        });
        expect(second.written).toEqual([]);
        expect(second.skipped).toEqual(['xfer-brain-3']);

        // MixedCase world.accounts keys still detect bothLocal -> takerWaits=true
        const mixedWorld: WorldSnapshot = {
            ...world,
            accounts: {
                AlphaBot: world.accounts.alphabot!,
                BetaBot: world.accounts.betabot!,
            },
        };
        const mixedRes = materializeBrainTransferOrders(
            [{ ...order1, id: 'xfer-brain-mixed', items: [{ itemId: 536, itemName: 'Dragon bones', count: 10 }] }],
            { fleetDir, side: 'local', world: mixedWorld, now: now + 2000 },
        );
        expect(mixedRes.written).toEqual(['xfer-brain-mixed']);
        const mixedParsed = JSON.parse(readFileSync(join(fleetDir, 'orders', 'xfer-brain-mixed.json'), 'utf8'));
        expect(mixedParsed.takerWaits).toBe(true);
    });

    test('applyActivityOverridesToPlan enforces protectedClock, stop-swarm, open circuit breaker, quarantine, and maxBots', () => {
        const root = makeTempRoot();
        writeFileSync(
            join(root, 'fleet', 'owners.json'),
            JSON.stringify({
                accounts: {
                    haggis: { side: 'local', server: 'rs-sdk-demo.fly.dev' },
                    AlphaBot: { side: 'local', server: 'rs-sdk-demo.fly.dev' },
                    BetaBot: { side: 'local', server: 'rs-sdk-demo.fly.dev' },
                },
            }, null, 2),
        );
        const now = 1_700_000_700_000;
        writeAccountOverrides(root, {
            haggis: {
                account: 'haggis',
                activityId: 'gather:woodcutting-loop',
                issuedAt: now - 1000,
                expiresAt: now + 3_600_000,
            },
            alphabot: {
                account: 'AlphaBot',
                activityId: 'gather:woodcutting-loop',
                issuedAt: now - 1000,
                expiresAt: now + 3_600_000,
            },
            betabot: {
                account: 'BetaBot',
                activityId: 'gather:mining-ore',
                issuedAt: now - 1000,
                expiresAt: now + 3_600_000,
            },
        });

        // 1. Protected account (haggis) stays blocked even with override_account; maxBots bounds selected slots.
        const zeroSlots = runBrainCycle({
            root,
            fleetDir: join(root, 'fleet'),
            now,
            side: 'local',
            maxBots: 0,
            marketQuotes: {},
        });
        expect(zeroSlots.fleetPlan.accountPlans.haggis?.steps ?? []).toEqual([]);
        expect(zeroSlots.fleetPlan.accountPlans.AlphaBot?.steps ?? []).toEqual([]);
        expect(zeroSlots.fleetPlan.accountPlans.BetaBot?.steps ?? []).toEqual([]);

        const oneSlot = runBrainCycle({
            root,
            fleetDir: join(root, 'fleet'),
            now: now + 50,
            side: 'local',
            maxBots: 1,
            marketQuotes: {},
        });
        expect(oneSlot.fleetPlan.accountPlans.haggis?.steps ?? []).toEqual([]);
        const oneSlotActive = Object.values(oneSlot.fleetPlan.accountPlans).filter(p => p.steps.length > 0).length;
        expect(oneSlotActive).toBeLessThanOrEqual(1);

        const normal = runBrainCycle({
            root,
            fleetDir: join(root, 'fleet'),
            now: now + 100,
            side: 'local',
            maxBots: 4,
            marketQuotes: {},
        });
        expect(normal.fleetPlan.accountPlans.haggis?.steps ?? []).toEqual([]);
        const normalSteps = normal.fleetPlan.accountPlans.AlphaBot?.steps ?? [];
        expect(normalSteps.some(s => 'activityId' in s && s.activityId === 'gather:woodcutting-loop')).toBe(true);

        // 2. Quarantined activity is never synthesized via override_account.
        recordWorkerOutcome({
            root,
            now: now + 200,
            raw: {
                activityId: 'gather:woodcutting-loop',
                account: 'AlphaBot',
                status: 'fail',
                error: 'boom',
            },
        });
        const quarantinedRun = runBrainCycle({
            root,
            fleetDir: join(root, 'fleet'),
            now: now + 300,
            side: 'local',
            maxBots: 4,
            marketQuotes: {},
        });
        const quarantinedSteps = quarantinedRun.fleetPlan.accountPlans.AlphaBot?.steps ?? [];
        expect(quarantinedSteps.some(s => 'activityId' in s && s.activityId === 'gather:woodcutting-loop')).toBe(false);

        const wcActivity = defaultActivityCatalog().get('gather:woodcutting-loop')!;
        expect(wcActivity).toBeDefined();
        const singleCatalog: ActivityCatalog = {
            get: id => (id === wcActivity.id ? wcActivity : undefined),
            require: id => {
                if (id === wcActivity.id) return wcActivity;
                throw new Error(`Missing ${id}`);
            },
            has: id => id === wcActivity.id,
            list: () => [wcActivity],
            byFamily: f => (wcActivity.family === f ? [wcActivity] : []),
            byWorkerKind: k => (wcActivity.kind === k ? [wcActivity] : []),
            findByOutputItem: () => [],
            findBySkill: s => (wcActivity.skill?.toLowerCase() === s.toLowerCase() ? [wcActivity] : []),
            findByQuest: () => [],
            size: () => 1,
        };
        const quarantinedOnlyRun = runBrainCycle({
            root,
            fleetDir: join(root, 'fleet'),
            now: now + 350,
            side: 'local',
            maxBots: 4,
            catalog: singleCatalog,
            marketQuotes: {},
        });
        expect(quarantinedOnlyRun.fleetPlan.accountPlans.AlphaBot?.steps ?? []).toEqual([]);

        // 3. stop-swarm and open InfraCircuitBreaker both block overrides.
        writeAccountOverrides(root, {
            alphabot: {
                account: 'AlphaBot',
                activityId: 'gather:mining-ore',
                issuedAt: now,
                expiresAt: now + 3_600_000,
            },
        });
        const breaker = new InfraCircuitBreaker({ baseMs: 60_000, jitterRatio: 0, now: () => now + 400 });
        breaker.recordFailure('ERR_PROXY_CONNECTION_FAILED', 'proxy');
        const breakerOpenRun = runBrainCycle({
            root,
            fleetDir: join(root, 'fleet'),
            now: now + 400,
            side: 'local',
            maxBots: 4,
            infraBreaker: breaker,
            marketQuotes: {},
        });
        expect(breakerOpenRun.fleetPlan.accountPlans.AlphaBot?.steps ?? []).toEqual([]);

        writeFileSync(join(practiceRoot(root), 'stop-swarm'), 'owner pause');
        const stoppedRun = runBrainCycle({
            root,
            fleetDir: join(root, 'fleet'),
            now: now + 500,
            side: 'local',
            maxBots: 4,
            marketQuotes: {},
        });
        expect(stoppedRun.fleetPlan.accountPlans.AlphaBot?.steps ?? []).toEqual([]);
    });

    test('drainOperatorCommands rejects path-traversal OperatorCommand ids without escaping applied/', () => {
        const root = makeTempRoot();
        const now = 1_700_000_800_000;
        const cmdDir = operatorCommandsDir(root);
        mkdirSync(cmdDir, { recursive: true });

        expect(isSafeOperatorCommandId('cmd-valid_1.2')).toBe(true);
        expect(isSafeOperatorCommandId('../escape')).toBe(false);
        expect(isSafeOperatorCommandId('a/b')).toBe(false);
        expect(isSafeOperatorCommandId('a\\b')).toBe(false);
        expect(isSafeOperatorCommandId('..')).toBe(false);

        writeFileSync(
            join(cmdDir, '001-traversal.json'),
            JSON.stringify({
                schemaVersion: 1,
                id: '../escaped-receipt',
                issuedAt: now,
                issuedBy: 'operator',
                kind: 'pause_account',
                account: 'AlphaBot',
            }),
        );

        runBrainCycle({
            root,
            fleetDir: join(root, 'fleet'),
            now: now + 10,
            side: 'local',
            marketQuotes: {},
        });

        expect(existsSync(join(cmdDir, 'escaped-receipt.json'))).toBe(false);
        expect(existsSync(join(cmdDir, 'rejected', '001-traversal.json'))).toBe(true);
        expect(existsSync(join(practiceRoot(root), 'stop-AlphaBot'))).toBe(false);
    });

    test('pause/resume commands preserve empty owner stops, gate dead resumes on clearDead, and write id-keyed rejection receipts', () => {
        const root = makeTempRoot();
        const now = 1_700_000_900_000;
        const cmdDir = operatorCommandsDir(root);
        mkdirSync(cmdDir, { recursive: true });
        mkdirSync(liveRoot(root), { recursive: true });

        // Empty stop-AlphaBot in .practice/live/ is a manual owner pause and must not be overwritten.
        writeFileSync(join(liveRoot(root), 'stop-AlphaBot'), '');
        writeFileSync(
            join(cmdDir, '001-pause.json'),
            JSON.stringify({
                schemaVersion: 1,
                id: 'cmd-pause-owner-preserve',
                issuedAt: now,
                issuedBy: 'dashboard',
                kind: 'pause_account',
                account: 'AlphaBot',
                reason: 'dashboard operator pause',
            }),
        );

        // Seed a death overlay on AlphaBot; resume_account without clearDead must refuse (applied: false) and keep stop file.
        recordWorkerOutcome({
            root,
            now: now - 500,
            raw: {
                activityId: 'combat:fire-giant',
                account: 'AlphaBot',
                died: true,
                status: 'fail',
                reason: 'died',
            },
        });
        writeFileSync(
            join(cmdDir, '002-resume-no-cleardead.json'),
            JSON.stringify({
                schemaVersion: 1,
                id: 'cmd-resume-dead-refused',
                issuedAt: now + 1,
                issuedBy: 'dashboard',
                kind: 'resume_account',
                account: 'AlphaBot',
            }),
        );
        // Campaign transition lacking rehearsalProof throws inside applyCommand -> rejected/<cmd.id>.json.
        writeFileSync(
            join(cmdDir, '003-bad-campaign.json'),
            JSON.stringify({
                schemaVersion: 1,
                id: 'cmd-invalid-campaign-err',
                issuedAt: now + 2,
                issuedBy: 'dashboard',
                kind: 'set_campaign_state',
                campaignId: 'campaign:haggis',
                state: 'running',
            }),
        );

        const first = runBrainCycle({
            root,
            fleetDir: join(root, 'fleet'),
            now: now + 10,
            side: 'local',
            marketQuotes: {},
        });

        expect(readFileSync(join(liveRoot(root), 'stop-AlphaBot'), 'utf8')).toBe('');
        const resumeRefused = first.appliedCommands.find(c => c.id === 'cmd-resume-dead-refused');
        expect(resumeRefused?.applied).toBe(false);
        expect(first.fleetState.accounts.alphabot?.lifecycle).toBe('paused_owner');
        expect(existsSync(join(cmdDir, 'rejected', 'cmd-invalid-campaign-err.json'))).toBe(true);

        // Replaying the rejected command id must be treated as duplicate.
        writeFileSync(
            join(cmdDir, '004-replay-rejected.json'),
            JSON.stringify({
                schemaVersion: 1,
                id: 'cmd-invalid-campaign-err',
                issuedAt: now + 15,
                issuedBy: 'dashboard',
                kind: 'set_campaign_state',
                campaignId: 'campaign:haggis',
                state: 'running',
            }),
        );
        // resume_account with clearDead: true clears both the death overlay and stop file.
        writeFileSync(
            join(cmdDir, '005-resume-cleardead.json'),
            JSON.stringify({
                schemaVersion: 1,
                id: 'cmd-resume-cleardead',
                issuedAt: now + 20,
                issuedBy: 'dashboard',
                kind: 'resume_account',
                account: 'AlphaBot',
                clearDead: true,
            }),
        );

        const second = runBrainCycle({
            root,
            fleetDir: join(root, 'fleet'),
            now: now + 30,
            side: 'local',
            marketQuotes: {},
        });

        expect(second.appliedCommands.find(c => c.id === 'cmd-invalid-campaign-err')?.duplicate).toBe(true);
        expect(second.appliedCommands.find(c => c.id === 'cmd-resume-cleardead')?.applied).toBe(true);
        expect(existsSync(join(liveRoot(root), 'stop-AlphaBot'))).toBe(false);
        expect(second.fleetState.accounts.alphabot?.lifecycle).toBe('idle');
    });

    test('overrides cannot promote roles to main, mutate protectedClock roles, or double-book single-account spots', () => {
        const root = makeTempRoot();
        writeFileSync(
            join(root, 'fleet', 'owners.json'),
            JSON.stringify({
                accounts: {
                    haggis: { side: 'local', server: 'rs-sdk-demo.fly.dev' },
                    AlphaBot: { side: 'local', server: 'rs-sdk-demo.fly.dev' },
                    BetaBot: { side: 'local', server: 'rs-sdk-demo.fly.dev' },
                },
            }, null, 2),
        );
        const now = 1_700_001_000_000;
        const baseAct = defaultActivityCatalog().get('gather:woodcutting-loop')!;
        const exclusiveAct: ActivityDefinition = {
            ...baseAct,
            id: 'gather:exclusive-spot',
            spotId: 'spot:single',
            maxConcurrentAccounts: 1,
        };
        const singleCatalog: ActivityCatalog = {
            get: id => (id === exclusiveAct.id ? exclusiveAct : undefined),
            require: id => {
                if (id === exclusiveAct.id) return exclusiveAct;
                throw new Error(`Missing ${id}`);
            },
            has: id => id === exclusiveAct.id,
            list: () => [exclusiveAct],
            byFamily: f => (exclusiveAct.family === f ? [exclusiveAct] : []),
            byWorkerKind: k => (exclusiveAct.kind === k ? [exclusiveAct] : []),
            findByOutputItem: () => [],
            findBySkill: s => (exclusiveAct.skill?.toLowerCase() === s.toLowerCase() ? [exclusiveAct] : []),
            findByQuest: () => [],
            size: () => 1,
        };

        writeAccountOverrides(root, {
            haggis: { account: 'haggis', role: 'helper', issuedAt: now - 100, expiresAt: now + 60_000 },
            alphabot: { account: 'AlphaBot', activityId: exclusiveAct.id, role: 'main', issuedAt: now - 100, expiresAt: now + 60_000 },
            betabot: { account: 'BetaBot', activityId: exclusiveAct.id, role: 'helper', issuedAt: now - 100, expiresAt: now + 60_000 },
        }, now);

        const cycle = runBrainCycle({
            root,
            fleetDir: join(root, 'fleet'),
            now,
            side: 'local',
            maxBots: 4,
            catalog: singleCatalog,
            marketQuotes: {},
        });

        expect(cycle.world.accounts.haggis?.role).toBe('main');
        expect(cycle.world.accounts.alphabot?.role).not.toBe('main');
        expect(cycle.fleetPlan.spotAllocations['spot:single']?.length ?? 0).toBeLessThanOrEqual(1);
        const assignedToSpot = Object.values(cycle.fleetPlan.accountPlans).filter(p => p.steps.length > 0);
        expect(assignedToSpot.length).toBe(1);
    });

    test('applyActivityOverridesToPlan counts in_trade accounts and assignedIdleDonors toward slot caps and skips reserved donors', () => {
        const root = makeTempRoot();
        const now = 1_700_001_100_000;
        const catalog = createActivityCatalog();
        const rateStore = createRateStore({ catalog, root, persist: false });
        const act = catalog.get('gather:woodcutting-loop')!;
        const emptyAcct = (name: string, lifecycle: 'idle' | 'in_trade') => ({
            name,
            side: 'local',
            server: 'rs-sdk-demo.fly.dev',
            role: 'helper' as const,
            lifecycle,
            protectedClock: false,
            skills: {},
            quests: {},
            combatLevel: 3,
            questPoints: 0,
            totalLevel: 32,
            totalXp: 1000,
            pos: { x: 3185, z: 3436, level: 0 },
            coins: 1000,
            inventory: {},
            equipment: {},
            bank: { items: {}, observedAt: now - 1000, trusted: true },
            holds: [],
            cooldowns: {},
            recentLossCount: 0,
        });
        const world: WorldSnapshot = {
            schemaVersion: 1,
            at: now,
            side: 'local',
            server: 'rs-sdk-demo.fly.dev',
            accounts: {
                traderbot: emptyAcct('TraderBot', 'in_trade'),
                donorbot: emptyAcct('DonorBot', 'idle'),
                recipbot: emptyAcct('RecipBot', 'idle'),
                extrabot: emptyAcct('ExtraBot', 'idle'),
            },
            fleetSides: { local: { side: 'local', seenAt: now, capacity: 3, stopped: false } },
            activeTransfers: [],
            marketCooldowns: {},
            spotOccupancy: {},
        };

        const basePlan: FleetPlan = {
            schemaVersion: 1,
            plannedAt: now,
            side: 'local',
            maxBots: 3,
            retentionMarginRatio: 0.15,
            recoveryQueue: [],
            accountPlans: {
                TraderBot: { account: 'TraderBot', steps: [], scorePerHour: 0, idleReason: 'in_trade' },
                DonorBot: { account: 'DonorBot', steps: [], scorePerHour: 0, idleReason: 'reserved_for_transfer' },
                RecipBot: {
                    account: 'RecipBot',
                    demandId: 'd1',
                    steps: [
                        {
                            stepKind: 'work',
                            activityId: act.id,
                            demandId: 'd1',
                            workerId: act.workerId,
                            batchUnits: 1,
                            estimatedTicks: 10,
                            expectedValuePerHour: 100,
                            config: act.config,
                        },
                    ],
                    scorePerHour: 100,
                },
                ExtraBot: { account: 'ExtraBot', steps: [], scorePerHour: 0, idleReason: 'max_bots_limit' },
            },
            transferOrders: [
                {
                    id: 'xfer-1',
                    server: 'rs-sdk-demo.fly.dev',
                    from: 'DonorBot',
                    to: 'RecipBot',
                    hub: 'varrock_west',
                    items: [{ itemId: 995, count: 500 }],
                    demandId: 'd1',
                    reason: 'fund',
                    createdAt: now - 1000,
                    expiresAt: now + 60_000,
                    state: 'planned',
                    bothIdleVerified: true,
                    donorLogoutConfirmedAt: now - 5_000,
                    recipientLogoutConfirmedAt: now - 5_000,
                    antiPingPong: { donorHoldsDemandForItems: false, cooldownWindowMs: 600_000 },
                },
            ],
            spotAllocations: {},
            selectedSlots: 2,
        };

        // 1 in_trade + 1 assignedIdleDonor + 1 planned = 3 === maxBots -> neither DonorBot nor ExtraBot can be added.
        const blocked = applyActivityOverridesToPlan(basePlan, {
            world,
            overrides: {
                donorbot: { account: 'DonorBot', activityId: act.id, issuedAt: now - 50, expiresAt: now + 60_000 },
                extrabot: { account: 'ExtraBot', activityId: act.id, issuedAt: now - 50, expiresAt: now + 60_000 },
            },
            catalog,
            demands: [],
            campaigns: [],
            defects: [],
            rateStore,
            marketQuotes: {},
            minTrust: 'experimental',
            allowExperimentalFallback: true,
        });
        expect(blocked.accountPlans.DonorBot?.steps).toEqual([]);
        expect(blocked.accountPlans.ExtraBot?.steps).toEqual([]);
        expect(blocked.selectedSlots).toBe(2);

        // With maxBots = 4, ExtraBot can launch while DonorBot stays skipped; selectedSlots counts all 4 reserved/planned slots.
        const expanded = applyActivityOverridesToPlan(
            { ...basePlan, maxBots: 4 },
            {
                world: { ...world, fleetSides: { local: { side: 'local', seenAt: now, capacity: 4, stopped: false } } },
                overrides: {
                    donorbot: { account: 'DonorBot', activityId: act.id, issuedAt: now - 50, expiresAt: now + 60_000 },
                    extrabot: { account: 'ExtraBot', activityId: act.id, issuedAt: now - 50, expiresAt: now + 60_000 },
                },
                catalog,
                demands: [],
                campaigns: [],
                defects: [],
                rateStore,
                marketQuotes: {},
                minTrust: 'experimental',
                allowExperimentalFallback: true,
            },
        );
        expect(expanded.accountPlans.DonorBot?.steps).toEqual([]);
        expect(expanded.accountPlans.ExtraBot?.steps.length).toBeGreaterThan(0);
        expect(expanded.selectedSlots).toBe(4);
        expect(validateFleetPlan(expanded)).toEqual([]);
    });

    test('runBrainCycle forwards simulated now to loadMarketQuotesFromRoot so market-all.json freshness uses opts.now', () => {
        const root = makeTempRoot();
        const now = 1_700_001_200_000;
        const statusDir = liveStatusDir(root);
        mkdirSync(statusDir, { recursive: true });
        writeFileSync(
            join(statusDir, 'AlphaBot.json'),
            JSON.stringify({
                name: 'AlphaBot',
                server: 'rs-sdk-demo.fly.dev',
                at: now - 1_200_000,
                pos: { x: 3185, z: 3436, level: 0 },
                skills: [{ name: 'Prayer', level: 1, xp: 0 }],
                inventory: [{ id: 995, count: 50_000 }],
                bank: [],
                bankAt: now - 1_200_000,
                result: 'ok done',
            }),
        );
        // Historical market cache valid at `now` (2023), expired relative to Date.now().
        writeMarketCache(
            root,
            { 1511: { name: 'Logs', price: 4, bid: 4, ask: 4, trades: 10, sell: 100 } },
            now - 60_000,
        );

        const baseAct = defaultActivityCatalog().get('bank-artisan:prayer-bury')!;
        const geCraftAct: ActivityDefinition = {
            ...baseAct,
            id: 'craft:test-logs-ge',
            inputs: [{ itemId: 1511, countPerUnit: 1 }],
            baselineRate: {
                ...baseAct.baselineRate,
                gpPerTick: 10,
            },
        };
        const geCatalog: ActivityCatalog = {
            get: id => (id === geCraftAct.id ? geCraftAct : undefined),
            require: id => {
                if (id === geCraftAct.id) return geCraftAct;
                throw new Error(`Missing ${id}`);
            },
            has: id => id === geCraftAct.id,
            list: () => [geCraftAct],
            byFamily: f => (geCraftAct.family === f ? [geCraftAct] : []),
            byWorkerKind: k => (geCraftAct.kind === k ? [geCraftAct] : []),
            findByOutputItem: () => [],
            findBySkill: s => (geCraftAct.skill?.toLowerCase() === s.toLowerCase() ? [geCraftAct] : []),
            findByQuest: () => [],
            size: () => 1,
        };

        const freshRun = runBrainCycle({
            root,
            fleetDir: join(root, 'fleet'),
            now,
            side: 'local',
            maxBots: 2,
            catalog: geCatalog,
            minTrust: 'experimental',
            allowExperimentalFallback: true,
        });
        const freshPlan = freshRun.fleetPlan.accountPlans.AlphaBot;
        expect(freshPlan).toEqual(
            expect.objectContaining({
                steps: expect.arrayContaining([
                    expect.objectContaining({ stepKind: 'acquire', source: 'ge' }),
                ]),
            }),
        );

        // Once simulated `now` passes MARKET_CACHE_MS, the same cache expires and GE acquire stops planning.
        const staleRun = runBrainCycle({
            root,
            fleetDir: join(root, 'fleet'),
            now: now + MARKET_CACHE_MS + 60_000,
            side: 'local',
            maxBots: 2,
            catalog: geCatalog,
            minTrust: 'experimental',
            allowExperimentalFallback: true,
        });
        const stalePlan = staleRun.fleetPlan.accountPlans.AlphaBot;
        expect(stalePlan?.steps.some(s => s.stepKind === 'acquire' && s.source === 'ge')).toBe(false);
    });

    test('persist: false leaves operator commands untouched, pause normalizes auto-stop markers, death records gate resume, and invalid transfer hubs skip cleanly', () => {
        const root = makeTempRoot();
        const now = 1_700_002_000_000;
        const cmdDir = operatorCommandsDir(root);
        mkdirSync(cmdDir, { recursive: true });

        // 1. persist: false must not drain operator-commands/ or mutate stop files by default.
        writeFileSync(
            join(cmdDir, '001-pause.json'),
            JSON.stringify({
                schemaVersion: 1,
                id: 'cmd-non-persist',
                issuedAt: now,
                issuedBy: 'operator',
                kind: 'pause_account',
                account: 'AlphaBot',
                reason: 'swarm stopped',
            }),
        );
        const dryRes = runBrainCycle({
            root,
            fleetDir: join(root, 'fleet'),
            now: now + 10,
            side: 'local',
            persist: false,
            marketQuotes: {},
        });
        expect(dryRes.appliedCommands).toEqual([]);
        expect(existsSync(join(cmdDir, '001-pause.json'))).toBe(true);
        expect(existsSync(join(practiceRoot(root), 'stop-AlphaBot'))).toBe(false);

        // 2. Draining pause_account with reason "swarm stopped" normalizes it so it stays an owner pause.
        const appliedRes = runBrainCycle({
            root,
            fleetDir: join(root, 'fleet'),
            now: now + 20,
            side: 'local',
            persist: true,
            marketQuotes: {},
        });
        expect(appliedRes.appliedCommands.find(c => c.id === 'cmd-non-persist')?.applied).toBe(true);
        expect(readFileSync(join(practiceRoot(root), 'stop-AlphaBot'), 'utf8')).toBe('operator pause: swarm stopped');
        expect(appliedRes.fleetState.accounts.alphabot?.lifecycle).toBe('paused_owner');

        // 3. A persisted death record in swarm-deaths.json gates resume_account unless clearDead: true.
        writeFileSync(
            join(liveRoot(root), 'swarm-deaths.json'),
            JSON.stringify({ AlphaBot: { at: now + 25, reason: 'died after 1 runs' } }),
        );
        writeFileSync(
            join(cmdDir, '002-resume-dead.json'),
            JSON.stringify({
                schemaVersion: 1,
                id: 'cmd-resume-swarm-dead',
                issuedAt: now + 30,
                issuedBy: 'operator',
                kind: 'resume_account',
                account: 'AlphaBot',
            }),
        );
        const blockedResume = runBrainCycle({
            root,
            fleetDir: join(root, 'fleet'),
            now: now + 40,
            side: 'local',
            persist: true,
            marketQuotes: {},
        });
        expect(blockedResume.appliedCommands.find(c => c.id === 'cmd-resume-swarm-dead')?.applied).toBe(false);
        expect(existsSync(join(practiceRoot(root), 'stop-AlphaBot'))).toBe(true);

        // 4. Invalid hub in materializeBrainTransferOrders skips cleanly without throwing.
        const badHubRes = materializeBrainTransferOrders(
            [{
                id: 'xfer-bad-hub',
                server: 'rs-sdk-demo.fly.dev',
                from: 'AlphaBot',
                to: 'BetaBot',
                hub: 'unknown_hub' as any,
                items: [{ itemId: 385, itemName: 'Shark', count: 5 }],
                demandId: 'd:shark',
                reason: 'test',
                createdAt: now,
                expiresAt: now + 60_000,
                state: 'planned',
                bothIdleVerified: true,
                donorLogoutConfirmedAt: now - 1000,
                recipientLogoutConfirmedAt: now - 1000,
                antiPingPong: { donorHoldsDemandForItems: false, cooldownWindowMs: 600_000 },
            }],
            { fleetDir: join(root, 'fleet'), side: 'local', world: blockedResume.world, now },
        );
        expect(badHubRes).toEqual({ written: [], skipped: ['xfer-bad-hub'] });
    });

    test('extractWorkerOutcomeInput attaches marketItemId/marketVenue only on failed market-unavailable runs and forwards skipRateSample', () => {
        const root = makeTempRoot();
        const now = 1_700_003_000_000;

        const failedShop = extractWorkerOutcomeInput({
            root,
            account: 'AlphaBot',
            activityId: 'market:shop-buy',
            startedAt: now - 10_000,
            finishedAt: now,
            exitCode: 1,
            endReason: 'blocked after 1 runs',
            successful: false,
            lastResultLine: 'RESULT fail ticks=30 boughtTotal=0 stop=stock-wait targetMet=0',
            logPath: 'alpha.log',
            marketItemId: 1317,
            marketVenue: 'shop:taverley2hand',
        });
        expect(failedShop.marketItemId).toBe(1317);
        expect(failedShop.marketVenue).toBe('shop:taverley2hand');

        const okShop = extractWorkerOutcomeInput({
            root,
            account: 'AlphaBot',
            activityId: 'market:shop-buy',
            startedAt: now - 10_000,
            finishedAt: now,
            exitCode: 0,
            endReason: 'done after 1 runs',
            successful: true,
            lastResultLine: 'RESULT ok boughtTotal=5 stop=item-cap',
            logPath: 'alpha.log',
            marketItemId: 1317,
            marketVenue: 'shop:taverley2hand',
        });
        expect(okShop.marketItemId).toBeUndefined();
        expect(okShop.marketVenue).toBeUndefined();

        mkdirSync(liveStatusDir(root), { recursive: true });
        writeFileSync(
            join(liveStatusDir(root), 'AlphaBot.json'),
            JSON.stringify({
                name: 'AlphaBot',
                server: 'rs-sdk-demo.fly.dev',
                started: now - 10_000,
                at: now - 1_000,
                tick: 100,
                counters: { units: 20 },
                result: 'ok done',
            }),
        );
        const chainRaw = extractWorkerOutcomeInput({
            root,
            account: 'AlphaBot',
            activityId: 'gather:woodcutting-fresh45',
            startedAt: now - 10_000,
            finishedAt: now,
            exitCode: 0,
            endReason: 'done after 1 runs',
            successful: true,
            logPath: 'alpha.log',
            skipRateSample: true,
        });
        expect(chainRaw.skipRateSample).toBe(true);
        expect(chainRaw.ticksElapsed).toBe(100);
        expect(chainRaw.unitsCompleted).toBe(20);
        const rateStore = createRateStore({ catalog: defaultActivityCatalog(), root, minSamplesToOverride: 1, minTicksToOverride: 10 });
        const classifier = new OutcomeClassifier({ rateStore, root });
        const out = recordWorkerOutcome({ root, catalog: defaultActivityCatalog(), rateStore, classifier, raw: chainRaw, now });
        expect(out.outcome.kind).toBe('target_met');
        expect(out.recordedRateSample).toBeUndefined();
    });
});
