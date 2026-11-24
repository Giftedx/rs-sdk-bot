import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { brainPlannedJobs } from '../src/fleet-sync';
import { brainCycleDue, clearAutoStop, DEFAULT_BRAIN_CYCLE_MS, isAutoStopText, selectBrainDispatchStep } from '../src/swarm';
import { dispatchAccountPlan } from '../src/worker-dispatch';
import { FLEET_STATE_SCHEMA_VERSION, type AccountPlan, type FleetState } from '../../brain/src/contracts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');

describe('root swarm.json validity and Brain throttle helpers', () => {
    test('root swarm.json has no legacy coordination block, no deleted script refs, and keeps protected reservations', () => {
        const raw = JSON.parse(readFileSync(join(REPO_ROOT, 'swarm.json'), 'utf8')) as {
            maxBots: number;
            minFreeGB: number;
            coordination?: unknown;
            jobs: Array<{ account?: string; accounts?: string[]; script?: string; args?: string[]; enabled?: boolean }>;
        };

        expect(raw.coordination).toBeUndefined();
        expect(raw.maxBots).toBeGreaterThan(0);
        expect(raw.minFreeGB).toBeGreaterThanOrEqual(4);
        expect(Array.isArray(raw.jobs)).toBe(true);

        const byAccount = new Map(raw.jobs.map((j) => [j.account?.toLowerCase(), j]));
        for (const reserved of ['haggis', 'shaftshooter', 'polevaulter', 'mightyrod']) {
            const job = byAccount.get(reserved);
            expect(job).toBeDefined();
            expect(job!.enabled).toBe(false);
            expect(job!.script).toBe('');
        }

        for (const job of raw.jobs) {
            if (job.script) {
                expect(existsSync(join(REPO_ROOT, job.script))).toBe(true);
            }
            if (job.script === 'scripts/chain.ts' && Array.isArray(job.args)) {
                for (const arg of job.args) {
                    const first = arg.trim().split(/\s+/)[0];
                    if (first?.startsWith('scripts/')) {
                        expect(existsSync(join(REPO_ROOT, first))).toBe(true);
                    }
                }
            }
        }
    });

    test('brainCycleDue refreshes on first tick, worker exit, pending commands, plan mtime change, or interval expiry', () => {
        const base = {
            hasCached: true,
            dirty: false,
            now: 100_000,
            lastAt: 95_000,
            intervalMs: DEFAULT_BRAIN_CYCLE_MS,
            hasPendingCommands: false,
            planMtime: 500,
            lastPlanMtime: 500,
        };
        expect(brainCycleDue(base)).toBe(false);
        expect(brainCycleDue({ ...base, hasCached: false })).toBe(true);
        expect(brainCycleDue({ ...base, dirty: true })).toBe(true);
        expect(brainCycleDue({ ...base, hasPendingCommands: true })).toBe(true);
        expect(brainCycleDue({ ...base, planMtime: 501 })).toBe(true);
        expect(brainCycleDue({ ...base, now: 95_000 + DEFAULT_BRAIN_CYCLE_MS })).toBe(true);
    });

    test('isAutoStopText and clearAutoStop clear stale auto-stops while preserving owner pauses', () => {
        expect(isAutoStopText('swarm stopped')).toBe(true);
        expect(isAutoStopText('fleet-health auto-paused: fail Error: combat travel original owner/life/stop')).toBe(true);
        expect(isAutoStopText('owner pause 2026-11-22')).toBe(false);
        expect(isAutoStopText('')).toBe(false);

        const dir = mkdtempSync(join(tmpdir(), 'swarm-autostop-'));
        try {
            const autoFile = join(dir, 'stop-BotA');
            const ownerFile = join(dir, 'stop-BotB');
            writeFileSync(autoFile, 'fleet-health auto-paused: fail Error: owner/life/stop');
            writeFileSync(ownerFile, 'owner stop: manual pause');
            expect(clearAutoStop(autoFile)).toBe(true);
            expect(existsSync(autoFile)).toBe(false);
            expect(clearAutoStop(ownerFile)).toBe(false);
            expect(existsSync(ownerFile)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('selectBrainDispatchStep truncates multi-step chains before fleet_trade and skips multi-step work attribution', () => {
        const planWithLateTrade: AccountPlan = {
            account: 'TradeBot',
            demandId: 'd:fire',
            scorePerHour: 120,
            steps: [
                {
                    stepKind: 'unlock',
                    unlockKind: 'quest',
                    activityId: 'quest:waterfall',
                    questSlug: 'waterfall',
                    estimatedTicks: 400,
                },
                {
                    stepKind: 'acquire',
                    source: 'hub_banker',
                    itemId: 385,
                    quantity: 10,
                    estimatedTicks: 40,
                    estimatedCoinCost: 0,
                    coinFloatPreserved: 1000,
                    donorAccount: 'BankAlt',
                    hub: 'varrock_west',
                    transferOrderId: 'xfer-1',
                },
                {
                    stepKind: 'work',
                    activityId: 'combat:fire-giant',
                    demandId: 'd:fire',
                    workerId: 'combat',
                    batchUnits: 15,
                    estimatedTicks: 500,
                    expectedValuePerHour: 120,
                    config: {},
                },
            ],
        };
        const dispatched = dispatchAccountPlan(planWithLateTrade);
        const sel = selectBrainDispatchStep(dispatched, planWithLateTrade.steps);
        expect(sel.mode).toBe('worker');
        if (sel.mode === 'worker') {
            expect(sel.step.script).toBe('scripts/aio-quester.ts');
            expect(sel.isMultiStepChain).toBe(false);
            expect(sel.attributedActivityId).toBe('quest:waterfall');
        }

        const multiNoTrade: AccountPlan = {
            account: 'ChainBot',
            demandId: 'd:cook',
            scorePerHour: 100,
            steps: [
                {
                    stepKind: 'acquire',
                    source: 'ge',
                    itemId: 383,
                    quantity: 50,
                    estimatedTicks: 50,
                    estimatedCoinCost: 20_000,
                    coinFloatPreserved: 1000,
                },
                {
                    stepKind: 'work',
                    activityId: 'bank-artisan:cooking-food',
                    demandId: 'd:cook',
                    workerId: 'bank-artisan',
                    batchUnits: 50,
                    estimatedTicks: 200,
                    expectedValuePerHour: 100,
                    config: {},
                },
            ],
        };
        const multiSel = selectBrainDispatchStep(dispatchAccountPlan(multiNoTrade), multiNoTrade.steps);
        expect(multiSel.mode).toBe('worker');
        if (multiSel.mode === 'worker') {
            expect(multiSel.step.script).toBe('scripts/chain.ts');
            expect(multiSel.isMultiStepChain).toBe(true);
            expect(multiSel.attributedActivityId).toBeUndefined();
            expect(multiSel.displayActivityId).toBe('bank-artisan:cooking-food');
        }
    });

    test('brainPlannedJobs truncates multi-step chains before fleet_trade and resolves MixedCase role', () => {
        const root = mkdtempSync(join(tmpdir(), 'fleet-sync-brain-'));
        try {
            const liveDir = join(root, '.practice', 'live');
            mkdirSync(liveDir, { recursive: true });
            const now = Date.now();
            const state: FleetState = {
                schemaVersion: FLEET_STATE_SCHEMA_VERSION,
                emittedAt: now,
                side: 'local',
                server: 'rs-sdk-demo.fly.dev',
                maxBots: 5,
                accounts: {
                    mixedcasebot: {
                        name: 'MixedCaseBot',
                        side: 'local',
                        role: 'army',
                        protectedClock: false,
                        lifecycle: 'idle',
                        pos: { x: 3222, z: 3218, level: 0 },
                        skills: {},
                        quests: {},
                        inventory: {},
                        equipment: {},
                        bank: { items: {}, observedAt: now, trusted: true },
                    },
                },
                activeChains: {
                    MixedCaseBot: {
                        account: 'MixedCaseBot',
                        demandId: 'd:fire',
                        scorePerHour: 150,
                        steps: [
                            {
                                stepKind: 'unlock',
                                unlockKind: 'quest',
                                activityId: 'quest:waterfall',
                                questSlug: 'waterfall',
                                estimatedTicks: 400,
                            },
                            {
                                stepKind: 'acquire',
                                source: 'hub_banker',
                                itemId: 385,
                                quantity: 10,
                                estimatedTicks: 40,
                                estimatedCoinCost: 0,
                                coinFloatPreserved: 1000,
                                donorAccount: 'BankAlt',
                                hub: 'varrock_west',
                                transferOrderId: 'xfer-1',
                            },
                            {
                                stepKind: 'work',
                                activityId: 'combat:fire-giant',
                                demandId: 'd:fire',
                                workerId: 'combat',
                                batchUnits: 15,
                                estimatedTicks: 500,
                                expectedValuePerHour: 150,
                                config: {},
                            },
                        ],
                    },
                },
                idleReasons: {},
                goals: [],
                campaigns: [],
                missions: [],
                pendingTransfers: [],
                quarantinedDefects: [],
            };
            writeFileSync(join(liveDir, 'fleet-state.json'), JSON.stringify(state));
            const jobs = brainPlannedJobs(root, [], now + 1000);
            expect(jobs).toHaveLength(1);
            expect(jobs[0].account).toBe('MixedCaseBot');
            expect(jobs[0].script).toBe('scripts/generated/waterfall.ts');
            expect(jobs[0].role).toBe('army');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
