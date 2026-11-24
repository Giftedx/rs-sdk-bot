import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import type { Session } from '../../core/src/inprocess';
import type { SessionCore } from '../../core/src/session-types';
import {
    preflightFail,
    preflightOk,
    type WorkerAccountView,
    type WorkerModule,
    type WorkerWorldView,
} from '../../workers/src/contracts';
import {
    ACCOUNT_LIFECYCLES,
    ACCOUNT_ROLES,
    ACQUIRE_SOURCE_ORDER,
    CAMPAIGN_STATES,
    DEFAULT_OPERATING_COIN_FLOAT,
    DEFAULT_RETENTION_MARGIN_RATIO,
    FLEET_STATE_SCHEMA_VERSION,
    GOAL_KINDS,
    HUB_BANKER_LOCATIONS,
    MAX_ACCOUNT_PLAN_STEPS,
    MAX_CAMPAIGN_HISCORE_AGE_MS,
    MISSION_STATES,
    NON_EXPIRING_LIFECYCLES,
    OPERATOR_COMMAND_KINDS,
    RECOVERY_PRIORITY_ORDER,
    accountFrozenValue,
    canAutoClearLifecycle,
    canScheduleTransferOrder,
    compareRecoveryPriority,
    createExpiringHold,
    isAccountPlan,
    isAccountState,
    isActivityDefinition,
    isCampaign,
    isCampaignLaunchReady,
    isCooldownActive,
    isDefectRecord,
    isFleetPlan,
    isFleetState,
    isGoalDemand,
    isHiscoreMarginFresh,
    isHoldActive,
    isMission,
    isOfflineBankTrusted,
    isOperatorCommand,
    isProtectedAccountName,
    isRateSample,
    isTransferOrder,
    isWorldSnapshot,
    lifecycleAutoExpires,
    marketCooldownKey,
    missionEffectiveWeight,
    pruneExpiredCooldowns,
    pruneExpiredHolds,
    reconcileOfflineBankTrust,
    recoveryPriorityRank,
    setCooldown,
    validateAccountPlan,
    validateAccountState,
    validateCampaign,
    validateFleetPlan,
    validateMission,
    validateOperatorCommand,
    validatePlannedStep,
    validateTransferOrder,
    type AccountPlan,
    type AccountState,
    type ActivityDefinition,
    type Campaign,
    type DefectRecord,
    type FleetPlan,
    type FleetState,
    type GoalDemand,
    type Mission,
    type OperatorCommand,
    type RateSample,
    type TransferOrder,
    type WorldSnapshot,
} from '../src';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');

function walkTs(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    const visit = (d: string) => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
            const full = join(d, entry.name);
            if (entry.isDirectory()) visit(full);
            else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
                out.push(relative(repoRoot, full).replaceAll('\\', '/'));
            }
        }
    };
    visit(dir);
    return out.sort();
}

function resolveImportTarget(fromAbs: string, spec: string): string {
    const target = relative(repoRoot, resolve(dirname(fromAbs), spec)).replaceAll('\\', '/');
    if (target.endsWith('.ts')) return target;
    if (existsSync(join(repoRoot, `${target}.ts`))) return `${target}.ts`;
    if (existsSync(join(repoRoot, target, 'index.ts'))) return `${target}/index.ts`;
    return `${target}.ts`;
}

function tarjanSccs(files: readonly string[]): string[][] {
    const graph = new Map<string, string[]>();
    for (const rel of files) {
        const abs = join(repoRoot, rel);
        const info = ts.preProcessFile(readFileSync(abs, 'utf8'), true, true);
        const deps: string[] = [];
        for (const imp of info.importedFiles) {
            if (!imp.fileName.startsWith('.')) continue;
            deps.push(resolveImportTarget(abs, imp.fileName));
        }
        graph.set(rel, deps);
    }
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const sccs: string[][] = [];
    let idx = 0;

    function strong(v: string) {
        index.set(v, idx);
        low.set(v, idx);
        idx++;
        stack.push(v);
        onStack.add(v);
        for (const w of graph.get(v) ?? []) {
            if (!graph.has(w)) continue;
            if (!index.has(w)) {
                strong(w);
                low.set(v, Math.min(low.get(v)!, low.get(w)!));
            } else if (onStack.has(w)) {
                low.set(v, Math.min(low.get(v)!, index.get(w)!));
            }
        }
        if (low.get(v) === index.get(v)) {
            const comp: string[] = [];
            while (true) {
                const w = stack.pop()!;
                onStack.delete(w);
                comp.push(w);
                if (w === v) break;
            }
            if (comp.length > 1 || (graph.get(v) ?? []).includes(v)) sccs.push(comp.sort());
        }
    }

    for (const v of graph.keys()) if (!index.has(v)) strong(v);
    return sccs;
}

const NOW = 1_700_000_000_000;

const makeAccount = (overrides: Partial<AccountState> = {}): AccountState => ({
    name: 'Packhorse',
    side: 'local',
    role: 'helper',
    protectedClock: false,
    lifecycle: 'idle',
    skills: { Attack: { level: 70, xp: 750_000 }, Hitpoints: { level: 72, xp: 900_000 } },
    quests: { cook: 'complete', waterfall: 'not_started' },
    pos: { x: 3185, z: 3436, level: 0 },
    inventory: { 995: 5000 },
    equipment: { 1333: 1 },
    bank: { items: { 995: 50_000, 385: 200 }, observedAt: NOW - 86_400_000, trusted: true },
    ...overrides,
});

const makeWorld = (accounts: Record<string, AccountState>): WorldSnapshot => ({
    schemaVersion: 1,
    at: NOW,
    side: 'local',
    server: 'rs-sdk-demo.fly.dev',
    accounts,
    reserves: { packhorse: { 995: 1000 } },
    geEscrowCoins: { packhorse: 0 },
});

test('AccountState and WorldSnapshot satisfy WorkerModule views structurally without cyclic imports', () => {
    const acct = makeAccount();
    const world = makeWorld({ packhorse: acct });

    // Compile-time structural compatibility assertions.
    const accountAsView: WorkerAccountView = acct;
    const worldAsView: WorkerWorldView = world;
    expect(accountAsView.name).toBe('Packhorse');
    expect(worldAsView.side).toBe('local');

    type TestCfg = { targetLevel: number };
    const worker: WorkerModule<TestCfg> = {
        id: 'combat:melee-sandcrabs',
        family: 'combat',
        kind: 'train',
        trust: 'practice_passed',
        preflight(a, cfg) {
            const lvl = a.skills.Attack?.level ?? 1;
            return lvl >= cfg.targetLevel
                ? preflightOk()
                : preflightFail([{ kind: 'skill_level', skill: 'Attack', required: cfg.targetLevel, current: lvl }]);
        },
        estimate() {
            return {
                xpPerTick: 22,
                unitsPerTick: 1,
                gpPerTick: 0,
                setupTicks: 25,
                minBatchUnits: 50,
                confidence: 'model',
            };
        },
        async run(sess: SessionCore) {
            return { kind: 'target_met', activityId: 'combat:melee-sandcrabs', account: sess.name, ticksElapsed: 100 };
        },
    };

    const brainTypedWorker: WorkerModule<TestCfg, AccountState, WorldSnapshot, Session> = worker;
    expect(brainTypedWorker.preflight(acct, { targetLevel: 70 }, world).ok).toBe(true);
    expect(brainTypedWorker.preflight(acct, { targetLevel: 80 }, world).ok).toBe(false);
    expect(brainTypedWorker.estimate(acct, { targetLevel: 70 }, world).xpPerTick).toBe(22);
});

test('Section 3.1 lifecycles, protected clocks, offline bank trust, and TTL holds uphold invariants', () => {
    expect(ACCOUNT_LIFECYCLES).toEqual([
        'paused_owner',
        'reserved',
        'dead',
        'needs_logout_recovery',
        'needs_location_recovery',
        'running',
        'in_trade',
        'idle',
    ]);
    expect(ACCOUNT_ROLES).toEqual(['auto', 'army', 'helper', 'specialist', 'main']);
    expect(NON_EXPIRING_LIFECYCLES).toEqual(['paused_owner', 'dead']);
    expect(RECOVERY_PRIORITY_ORDER).toEqual(['needs_logout_recovery', 'needs_location_recovery']);

    expect(lifecycleAutoExpires('paused_owner')).toBe(false);
    expect(lifecycleAutoExpires('dead')).toBe(false);
    expect(canAutoClearLifecycle('paused_owner')).toBe(false);
    expect(canAutoClearLifecycle('dead')).toBe(false);
    expect(lifecycleAutoExpires('needs_logout_recovery')).toBe(true);
    expect(lifecycleAutoExpires('idle')).toBe(true);

    // Protected clock invariants.
    expect(isProtectedAccountName('Haggis')).toBe(true);
    expect(isProtectedAccountName('hiltsdeep')).toBe(true);
    expect(isProtectedAccountName('justthetip')).toBe(true);
    expect(isProtectedAccountName('Packhorse')).toBe(false);

    expect(
        validateAccountState(
            makeAccount({ name: 'Haggis', role: 'main', protectedClock: false, lifecycle: 'reserved' }),
        ).length,
    ).toBeGreaterThan(0);
    expect(
        isAccountState(
            makeAccount({ name: 'Haggis', role: 'main', protectedClock: true, lifecycle: 'reserved' }),
        ),
    ).toBe(true);
    expect(
        validateAccountState(
            makeAccount({ name: 'Packhorse', role: 'main', protectedClock: true, lifecycle: 'reserved' }),
        ).length,
    ).toBeGreaterThan(0);

    // Running vs non-running activeJob invariants.
    expect(validateAccountState(makeAccount({ lifecycle: 'running' })).length).toBeGreaterThan(0);
    expect(
        isAccountState(
            makeAccount({
                lifecycle: 'running',
                activeJob: { activityId: 'gather:iron', demandId: 'd1', startedAt: NOW - 10_000 },
            }),
        ),
    ).toBe(true);
    expect(
        validateAccountState(
            makeAccount({
                lifecycle: 'idle',
                activeJob: { activityId: 'gather:iron', demandId: 'd1', startedAt: NOW - 10_000 },
            }),
        ).length,
    ).toBeGreaterThan(0);

    // Trusted offline bank invariants: confirmed offline stays trusted indefinitely until newer login or settled transfer.
    const oldBank = { items: { 995: 50_000 }, observedAt: NOW - 7 * 86_400_000, trusted: true };
    expect(isOfflineBankTrusted(oldBank, { confirmedOffline: true })).toBe(true);
    expect(isOfflineBankTrusted(oldBank, { confirmedOffline: false })).toBe(false);
    expect(
        isOfflineBankTrusted(oldBank, { confirmedOffline: true, lastLoginAttemptAt: oldBank.observedAt + 1000 }),
    ).toBe(false);
    expect(
        isOfflineBankTrusted(oldBank, { confirmedOffline: true, lastSettledTransferAt: oldBank.observedAt + 500 }),
    ).toBe(false);

    const reconciled = reconcileOfflineBankTrust(oldBank, {
        confirmedOffline: true,
        lastSettledTransferAt: oldBank.observedAt + 1,
    });
    expect(reconciled.trusted).toBe(false);

    expect(
        validateAccountState(makeAccount({ bank: { items: {}, observedAt: 0, trusted: true } })).length,
    ).toBeGreaterThan(0);
    expect(
        validateAccountState(
            makeAccount({
                bank: { items: { 995: 1000 }, observedAt: NOW - 5000, trusted: true },
                lastLoginAttemptAt: NOW - 1000,
            }),
        ).length,
    ).toBeGreaterThan(0);

    // Expiring holds & cooldowns require explicit finite positive TTL.
    const hold = createExpiringHold({
        kind: 'market_unavailable',
        key: marketCooldownKey(385, 'GE'),
        reason: 'no sellers at bid',
        now: NOW,
        ttlMs: 120_000,
    });
    expect(hold.key).toBe('385:ge');
    expect(hold.expiresAt).toBe(NOW + 120_000);
    expect(isHoldActive(hold, NOW + 60_000)).toBe(true);
    expect(isHoldActive(hold, NOW + 120_000)).toBe(false);
    expect(pruneExpiredHolds([hold], NOW + 120_000)).toEqual([]);
    expect(() =>
        createExpiringHold({ kind: 'cooldown', key: 'k', reason: 'r', now: NOW, ttlMs: Number.POSITIVE_INFINITY }),
    ).toThrow();
    expect(() =>
        createExpiringHold({ kind: 'cooldown', key: 'k', reason: 'r', now: NOW, ttlMs: 0 }),
    ).toThrow();

    const cd = setCooldown(undefined, '385:ge', NOW, 60_000);
    expect(isCooldownActive(cd, '385:ge', NOW + 1000)).toBe(true);
    expect(isCooldownActive(cd, '385:ge', NOW + 60_000)).toBe(false);
    expect(pruneExpiredCooldowns(cd, NOW + 60_000)).toEqual({});
    expect(
        validateAccountState(makeAccount({ cooldowns: { '385:ge': Number.POSITIVE_INFINITY } })).length,
    ).toBeGreaterThan(0);
});

test('recovery priority orders needs_logout_recovery by frozen value, then needs_location_recovery, then idle', () => {
    const lowLogout = makeAccount({
        name: 'Alow',
        lifecycle: 'needs_logout_recovery',
        inventory: { 995: 500 },
        bank: { items: {}, observedAt: NOW - 1000, trusted: true },
    });
    const highLogout = makeAccount({
        name: 'Zhigh',
        lifecycle: 'needs_logout_recovery',
        inventory: { 995: 500_000 },
        bank: { items: { 385: 1000 }, observedAt: NOW - 1000, trusted: true },
    });
    const locRec = makeAccount({ name: 'Mloc', lifecycle: 'needs_location_recovery' });
    const idleAcct = makeAccount({ name: 'Bidle', lifecycle: 'idle' });
    const pausedAcct = makeAccount({ name: 'Cpaused', lifecycle: 'paused_owner' });

    const sorted = [pausedAcct, idleAcct, lowLogout, locRec, highLogout].sort((a, b) =>
        compareRecoveryPriority(a, b, (x) => accountFrozenValue(x, { 385: 900 })),
    );
    expect(sorted.map((a) => a.name)).toEqual(['Zhigh', 'Alow', 'Mloc', 'Bidle', 'Cpaused']);
    expect(recoveryPriorityRank('needs_logout_recovery')).toBe(0);
    expect(recoveryPriorityRank('needs_location_recovery')).toBe(1);
    expect(recoveryPriorityRank('idle')).toBe(2);
    expect(recoveryPriorityRank('dead')).toBe(Number.POSITIVE_INFINITY);
});

test('Section 3.3 GoalDemand, Campaign, Mission, ActivityDefinition, and RateSample uphold invariants', () => {
    expect(GOAL_KINDS).toEqual([
        'main_supply',
        'specialist_prep',
        'quest_board',
        'gear_collection',
        'pk_army',
        'squad_supply',
        'coin_fund',
    ]);
    expect(CAMPAIGN_STATES).toEqual(['staging', 'ready', 'running', 'paused', 'completed']);
    expect(MISSION_STATES).toEqual(['staging', 'ready', 'running', 'paused']);

    const demand: GoalDemand = {
        id: 'demand:haggis-sharks',
        goalKind: 'main_supply',
        sourceId: 'campaign:haggis-overall',
        valueScore: 10,
        valuePerHour: 8.5,
        target: { kind: 'item', itemId: 385, itemName: 'Shark', count: 500, holder: 'Packhorse' },
        fulfilled: 100,
        remaining: 400,
        priorityWeight: 2,
        active: true,
    };
    expect(isGoalDemand(demand)).toBe(true);

    const stagingCampaign: Campaign = {
        id: 'camp:polevaulter',
        account: 'polevaulter',
        protectedClock: true,
        board: 'Agility',
        requiredSupplies: [{ itemId: 385, itemName: 'Shark', count: 200 }],
        stagingHolder: 'Packhorse',
        rehearsalProof: null,
        hiscoreMargin: null,
        state: 'staging',
    };
    expect(isCampaign(stagingCampaign)).toBe(true);
    expect(isCampaignLaunchReady(stagingCampaign)).toBe(false);

    // Staging directly onto protected account must fail.
    expect(
        validateCampaign({ ...stagingCampaign, stagingHolder: 'polevaulter' }).length,
    ).toBeGreaterThan(0);

    // Protected campaign cannot enter ready/running without verified rehearsal and passing margin.
    expect(validateCampaign({ ...stagingCampaign, state: 'ready' }).length).toBeGreaterThan(0);

    const readyCampaign: Campaign = {
        ...stagingCampaign,
        state: 'ready',
        rehearsalProof: { verified: true, ticks: 520_000, verifiedAt: NOW },
        hiscoreMargin: {
            board: 'Agility',
            rivalTicks: 600_000,
            ourTicks: 520_000,
            marginTicks: 80_000,
            marginRatio: 0.133,
            checkedAt: NOW,
            meetsMargin: true,
        },
    };
    expect(isCampaign(readyCampaign)).toBe(true);
    expect(isCampaignLaunchReady(readyCampaign)).toBe(true);
    expect(isHiscoreMarginFresh(readyCampaign.hiscoreMargin, NOW)).toBe(true);
    expect(isHiscoreMarginFresh(readyCampaign.hiscoreMargin, NOW + MAX_CAMPAIGN_HISCORE_AGE_MS + 1)).toBe(false);
    expect(isCampaignLaunchReady(readyCampaign, { now: NOW, suppliesSatisfied: false })).toBe(false);
    expect(isCampaignLaunchReady(readyCampaign, { now: NOW + MAX_CAMPAIGN_HISCORE_AGE_MS + 1, suppliesSatisfied: true })).toBe(false);
    expect(isCampaignLaunchReady(readyCampaign, { now: NOW, suppliesSatisfied: true })).toBe(true);

    const activeMission: Mission = {
        id: 'mission:wildy-rev-sweep',
        participants: ['BraveHardon', 'TossTheCaber'],
        state: 'running',
        kitTargets: [{ itemId: 1333, itemName: 'Rune scimitar', countPerParticipant: 1, slot: 'weapon' }],
        consumables: [{ itemId: 385, itemName: 'Shark', countPerParticipant: 18, minReservePerParticipant: 36 }],
        weight: 3,
    };
    expect(isMission(activeMission)).toBe(true);
    expect(missionEffectiveWeight(activeMission)).toBe(3);

    const pausedMission: Mission = { ...activeMission, state: 'paused', participants: [] };
    expect(isMission(pausedMission)).toBe(true);
    expect(missionEffectiveWeight(pausedMission)).toBe(0);
    expect(validateMission({ ...activeMission, participants: ['BraveHardon', 'bravehardon'] }).length).toBeGreaterThan(0);

    const activity: ActivityDefinition<{ tree: string }> = {
        id: 'gather:wc-willow-draynor',
        workerId: 'gather',
        family: 'gather',
        kind: 'train',
        label: 'Cut willow trees at Draynor',
        skill: 'Woodcutting',
        spotId: 'draynor-willows',
        maxConcurrentAccounts: 4,
        config: { tree: 'willow' },
        baselineRate: {
            xpPerTick: 18,
            unitsPerTick: 0.25,
            gpPerTick: 0,
            setupTicks: 15,
            minBatchUnits: 28,
            confidence: 'model',
        },
        location: { x: 3088, z: 3234, level: 0 },
        trust: 'practice_passed',
    };
    expect(isActivityDefinition(activity)).toBe(true);

    const sample: RateSample = {
        activityId: activity.id,
        account: 'Woodpecker',
        domain: 'practice',
        observedAt: NOW,
        ticksElapsed: 1000,
        unitsCompleted: 260,
        xpPerTick: 17.6,
        unitsPerTick: 0.26,
        gpPerTick: 0,
        setupTicks: 14,
    };
    expect(isRateSample(sample)).toBe(true);
});

test('Section 3.4 AcquireItem, AccountPlan, TransferOrder, and FleetPlan uphold safe logistics invariants', () => {
    expect(ACQUIRE_SOURCE_ORDER).toEqual(['own_bank', 'npc_shop', 'ge', 'hub_banker', 'craft_gather']);
    expect(DEFAULT_OPERATING_COIN_FLOAT).toBe(1000);
    expect(DEFAULT_RETENTION_MARGIN_RATIO).toBe(0.15);
    expect(MAX_ACCOUNT_PLAN_STEPS).toBe(3);
    expect(Object.keys(HUB_BANKER_LOCATIONS).sort()).toEqual(['ardougne', 'varrock_west']);

    const plan: AccountPlan = {
        account: 'Packhorse',
        demandId: 'demand:haggis-sharks',
        scorePerHour: 12.4,
        retentionMarginApplied: true,
        steps: [
            {
                stepKind: 'acquire',
                source: 'ge',
                itemId: 383,
                itemName: 'Raw shark',
                quantity: 200,
                estimatedTicks: 60,
                estimatedCoinCost: 140_000,
                coinFloatPreserved: DEFAULT_OPERATING_COIN_FLOAT,
                venueKey: '383:ge',
            },
            {
                stepKind: 'gear_upgrade',
                itemId: 775,
                itemName: 'Cooking gauntlets',
                slot: 'hands',
                netXpPerTickGain: 3.2,
                remainingBandTicks: 5000,
                acquisitionTicks: 200,
                paybackNetTicks: 400,
                source: 'own_bank',
            },
            {
                stepKind: 'work',
                activityId: 'bank-artisan:cook-shark',
                demandId: 'demand:haggis-sharks',
                workerId: 'bank-artisan',
                batchUnits: 200,
                estimatedTicks: 840,
                expectedValuePerHour: 12.4,
                config: { recipe: 'cook_shark' },
            },
        ],
    };
    expect(isAccountPlan(plan)).toBe(true);

    // Max 3 steps enforced; empty steps require idleReason; gear_upgrade requires positive payback.
    expect(validateAccountPlan({ ...plan, steps: [...plan.steps, plan.steps[0]!] }).length).toBeGreaterThan(0);
    expect(validateAccountPlan({ account: 'Packhorse', steps: [], scorePerHour: 0 }).length).toBeGreaterThan(0);
    expect(isAccountPlan({ account: 'Packhorse', steps: [], scorePerHour: 0, idleReason: 'paused_owner' })).toBe(true);
    expect(
        validatePlannedStep({ ...plan.steps[1]!, paybackNetTicks: 0 }).length,
    ).toBeGreaterThan(0);

    const donor = makeAccount({ name: 'Moneyshot', lifecycle: 'idle' });
    const recipient = makeAccount({ name: 'Packhorse', lifecycle: 'idle' });
    const order: TransferOrder = {
        id: 'xfer-001',
        server: 'rs-sdk-demo.fly.dev',
        from: 'Moneyshot',
        to: 'Packhorse',
        hub: 'varrock_west',
        hubBanker: 'Coinpurse',
        items: [{ itemId: 995, itemName: 'Coins', count: 150_000 }],
        demandId: 'demand:haggis-sharks',
        reason: 'fund raw shark buy order',
        createdAt: NOW - 10_000,
        expiresAt: NOW + 300_000,
        state: 'planned',
        bothIdleVerified: true,
        donorLogoutConfirmedAt: NOW - 20_000,
        recipientLogoutConfirmedAt: NOW - 15_000,
        antiPingPong: {
            donorHoldsDemandForItems: false,
            cooldownWindowMs: 600_000,
        },
    };
    expect(isTransferOrder(order)).toBe(true);
    expect(
        canScheduleTransferOrder(order, donor, recipient, {
            now: NOW,
            donorLogoutState: 'confirmed',
            recipientLogoutState: 'confirmed',
        }),
    ).toEqual({ ok: true, reasons: [] });

    // Refuse transfer when not idle, unconfirmed logout, invalid hub, or anti-ping-pong triggered.
    const busyCheck = canScheduleTransferOrder(order, { ...donor, lifecycle: 'running', activeJob: { activityId: 'a', demandId: 'd', startedAt: NOW } }, recipient, {
        now: NOW,
        donorLogoutState: 'held',
        recipientLogoutState: 'confirmed',
    });
    expect(busyCheck.ok).toBe(false);
    expect(busyCheck.reasons.length).toBeGreaterThanOrEqual(2);

    const demandConflict = canScheduleTransferOrder(order, donor, recipient, {
        now: NOW,
        donorLogoutState: 'confirmed',
        recipientLogoutState: 'confirmed',
        donorDemandItemIds: new Set([995]),
    });
    expect(demandConflict.ok).toBe(false);

    const recentPingPong = canScheduleTransferOrder(
        {
            ...order,
            antiPingPong: {
                donorHoldsDemandForItems: false,
                donorRecentReceivedAt: NOW - 60_000,
                cooldownWindowMs: 600_000,
            },
        },
        donor,
        recipient,
        { now: NOW, donorLogoutState: 'confirmed', recipientLogoutState: 'confirmed' },
    );
    expect(recentPingPong.ok).toBe(false);
    expect(validateTransferOrder({ ...order, hub: 'lumbridge' as any }).length).toBeGreaterThan(0);

    const fleetPlan: FleetPlan = {
        schemaVersion: 1,
        plannedAt: NOW,
        side: 'local',
        maxBots: 10,
        retentionMarginRatio: DEFAULT_RETENTION_MARGIN_RATIO,
        recoveryQueue: [{ account: 'UnloadMe', lifecycle: 'needs_logout_recovery', priorityValue: 25_000 }],
        accountPlans: { packhorse: plan },
        transferOrders: [order],
        spotAllocations: { 'ardougne-knights': ['Pocketrocket'] },
        selectedSlots: 1,
    };
    expect(isFleetPlan(fleetPlan)).toBe(true);
    expect(validateFleetPlan({ ...fleetPlan, selectedSlots: 11 }).length).toBeGreaterThan(0);
});

test('Section 3.5 DefectRecord, FleetState, and OperatorCommand validate dashboard and operator seams', () => {
    expect(FLEET_STATE_SCHEMA_VERSION).toBe(1);
    expect(OPERATOR_COMMAND_KINDS.length).toBe(10);

    const acct = makeAccount();
    const defect: DefectRecord = {
        id: 'def-001',
        activityId: 'quest:underground-pass',
        faultSignature: 'obstacle_loop:rope_swing',
        outcomeKind: 'worker_defect',
        account: 'Packhorse',
        observedAt: NOW - 5000,
        quarantinedAt: NOW - 4000,
        expiresAt: NOW + 3_600_000,
        quarantined: true,
        workerRelease: '75f8fcc9c7',
        logPath: '.practice/live/logs/underground-pass.log',
        tickRecordPath: '.practice/live/ticks/underground-pass.jsonl',
        detail: 'repeated rope swing failure',
        count: 2,
    };
    expect(isDefectRecord(defect)).toBe(true);

    const fleetState: FleetState = {
        schemaVersion: FLEET_STATE_SCHEMA_VERSION,
        emittedAt: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        maxBots: 12,
        infraCircuitBreaker: { open: false, consecutiveFaults: 0 },
        accounts: { packhorse: acct },
        activeChains: {},
        idleReasons: { packhorse: 'awaiting demand' },
        goals: [],
        campaigns: [],
        missions: [],
        pendingTransfers: [],
        quarantinedDefects: [defect],
        rateStats: {
            'bank-artisan:cook-shark': { samples: 4, xpPerTick: 18.2, unitsPerTick: 0.24, gpPerTick: -10 },
        },
    };
    expect(isFleetState(fleetState)).toBe(true);

    const world = makeWorld({ packhorse: acct });
    expect(isWorldSnapshot(world)).toBe(true);

    const commands: OperatorCommand[] = [
        { schemaVersion: 1, id: 'cmd-1', issuedAt: NOW, issuedBy: 'operator', kind: 'pause_account', account: 'Packhorse' },
        { schemaVersion: 1, id: 'cmd-2', issuedAt: NOW, issuedBy: 'operator', kind: 'resume_account', account: 'Packhorse', clearDead: true },
        { schemaVersion: 1, id: 'cmd-3', issuedAt: NOW, issuedBy: 'operator', kind: 'pause_side', side: 'local' },
        { schemaVersion: 1, id: 'cmd-4', issuedAt: NOW, issuedBy: 'operator', kind: 'resume_side', side: 'local' },
        {
            schemaVersion: 1,
            id: 'cmd-5',
            issuedAt: NOW,
            issuedBy: 'operator',
            kind: 'override_account',
            account: 'Packhorse',
            activityId: 'gather:fishing-harpoon',
            expiresAt: NOW + 3_600_000,
        },
        { schemaVersion: 1, id: 'cmd-6', issuedAt: NOW, issuedBy: 'operator', kind: 'clear_defect', activityId: 'quest:underground-pass' },
        { schemaVersion: 1, id: 'cmd-7', issuedAt: NOW, issuedBy: 'operator', kind: 'set_campaign_state', campaignId: 'camp:haggis', state: 'paused' },
        {
            schemaVersion: 1,
            id: 'cmd-8',
            issuedAt: NOW,
            issuedBy: 'operator',
            kind: 'upsert_campaign',
            campaign: {
                id: 'camp:haggis',
                account: 'haggis',
                protectedClock: true,
                board: 'Overall',
                requiredSupplies: [],
                stagingHolder: null,
                rehearsalProof: null,
                hiscoreMargin: null,
                state: 'staging',
            },
        },
        { schemaVersion: 1, id: 'cmd-9', issuedAt: NOW, issuedBy: 'operator', kind: 'set_mission_state', missionId: 'mission:pk', state: 'ready' },
        {
            schemaVersion: 1,
            id: 'cmd-10',
            issuedAt: NOW,
            issuedBy: 'operator',
            kind: 'upsert_mission',
            mission: {
                id: 'mission:pk',
                participants: ['BraveHardon'],
                state: 'staging',
                kitTargets: [],
                consumables: [],
                weight: 1,
            },
        },
    ];
    for (const cmd of commands) {
        expect(isOperatorCommand(cmd)).toBe(true);
    }

    expect(
        validateOperatorCommand({
            schemaVersion: 1,
            id: 'cmd-bad',
            issuedAt: NOW,
            issuedBy: 'operator',
            kind: 'override_account',
            account: 'Packhorse',
            expiresAt: NOW,
        }).length,
    ).toBeGreaterThan(0);

    // OperatorCommand.id must match safe filename pattern /^[A-Za-z0-9._-]{1,128}$/.
    expect(
        isOperatorCommand({
            schemaVersion: 1,
            id: 'cmd-ok_1.2',
            issuedAt: NOW,
            issuedBy: 'operator',
            kind: 'pause_side',
            side: 'local',
        }),
    ).toBe(true);
    for (const badId of ['../escape', 'dir/cmd', 'dir\\cmd', 'cmd space', '', 'x'.repeat(129)]) {
        expect(
            validateOperatorCommand({
                schemaVersion: 1,
                id: badId,
                issuedAt: NOW,
                issuedBy: 'operator',
                kind: 'pause_side',
                side: 'local',
            }).length,
        ).toBeGreaterThan(0);
    }
});

test('packages/brain/src obeys acyclic DAG and relative-only import boundaries', () => {
    const brainFiles = walkTs(join(repoRoot, 'packages', 'brain', 'src'));
    expect(brainFiles.length).toBeGreaterThanOrEqual(2);
    const bannedRoots = [
        'packages/fleet/',
        'packages/practice/',
        'packages/router/',
        'packages/dashboard/',
        'scripts/',
        'tools/',
    ];
    const violations: string[] = [];

    for (const rel of brainFiles) {
        const abs = join(repoRoot, rel);
        const info = ts.preProcessFile(readFileSync(abs, 'utf8'), true, true);
        for (const imp of info.importedFiles) {
            const spec = imp.fileName;
            if (spec.startsWith('@rsbot/')) {
                violations.push(`${rel} -> workspace import forbidden: ${spec}`);
                continue;
            }
            if (!spec.startsWith('.')) continue;
            const target = resolveImportTarget(abs, spec);
            if (bannedRoots.some((r) => target.startsWith(r))) {
                violations.push(`${rel} -> ${target}`);
            }
        }
    }
    expect(violations).toEqual([]);

    const dagFiles = [
        ...walkTs(join(repoRoot, 'packages', 'knowledge', 'src')),
        ...walkTs(join(repoRoot, 'packages', 'core', 'src')),
        ...walkTs(join(repoRoot, 'packages', 'planner', 'src')),
        ...walkTs(join(repoRoot, 'packages', 'workers', 'src')),
        ...brainFiles,
    ];
    expect(tarjanSccs(dagFiles)).toEqual([]);
});
