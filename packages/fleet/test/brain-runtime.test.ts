import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateFleetState, type TransferOrder, type WorldSnapshot } from '../../brain/src/contracts';
import { createActivityCatalog } from '../../brain/src/catalog';
import { createRateStore } from '../../brain/src/rate-store';
import { OutcomeClassifier } from '../../brain/src/outcome-classifier';
import { validOrder } from '../../core/src/fleet-trade-settlement';
import { fleetStateFile, liveRoot, liveStatusDir, operatorCommandsDir, practiceRoot } from '../../core/src/practice-paths';
import {
    captureRunBaseline,
    extractWorkerOutcomeInput,
    materializeBrainTransferOrders,
    readAccountOverrides,
    recordWorkerOutcome,
    runBrainCycle,
} from '../src/brain-runtime';

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
});
