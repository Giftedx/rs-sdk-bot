// Full-fleet offline shadow verification CLI (ZERO live logins, read-only over --root).
// Wires directly to Phase 1A (WorldSnapshot, ActivityCatalog, RateStore, Campaigns, Missions, DemandEngine),
// Phase 1B (Preflight, AcquireItem, AccountPlanner, FleetScheduler), and unified worker-routing contracts.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readLogoutProof, type LogoutProof } from '../../core/src/session-lifecycle';
import { WORKER_FAMILIES } from '../../workers/src/contracts';
import { loadCampaignManifests } from './campaigns';
import { createActivityCatalog } from './catalog';
import {
    DEFAULT_RETENTION_MARGIN_RATIO,
    HUB_BANKER_LOCATIONS,
    canScheduleTransferOrder,
    isAccountPlan,
    isCampaign,
    isFleetPlan,
    isFleetState,
    isMission,
    isProtectedAccountName,
    isTransferOrder,
    missionEffectiveWeight,
    validateFleetPlan,
    validateFleetState,
    type AccountLifecycle,
    type AccountRole,
    type AccountState,
    type ActivityDefinition,
    type Campaign,
    type FleetPlan,
    type FleetState,
    type GoalDemand,
    type Mission,
    type TransferOrder,
    type WorldSnapshot,
} from './contracts';
import { loadMarketQuotesFromRoot, type MarketQuotesMap } from './acquire';
import { createDemandEngine } from './demand';
import { loadMissionManifests } from './missions';
import { canProtectedAccountLaunch, planAccount } from './planner';
import { createRateStore, type RateStore } from './rate-store';
import { buildFleetState, scheduleFleet } from './scheduler';
import { inspectWorldSnapshot, type WorldSnapshotDiagnostics } from './snapshot';
import {
    isSupportedWorkerFamily,
    resolveAccountWorkerPlan,
    type ResolvedWorkerPlan,
} from './worker-routing';

const DEFAULT_REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');

export interface ShadowVerificationCheck {
    readonly name: string;
    readonly ok: boolean;
    readonly detail: string;
}

export interface ShadowVerificationSummary {
    readonly totalOwnedAccounts: number;
    readonly sideAccounts: number;
    readonly sideStopped: boolean;
    readonly maxBots: number;
    readonly selectedSlots: number;
    readonly lifecycleCounts: Readonly<Record<AccountLifecycle, number>>;
    readonly roleCounts: Readonly<Record<AccountRole, number>>;
    readonly protectedAccountsCount: number;
    readonly protectedAccountsIdle: number;
    readonly recoveryQueueLength: number;
    readonly activeChainsCount: number;
    readonly transferOrdersCount: number;
    readonly routedPlansCount: number;
    readonly checksPassed: number;
    readonly checksTotal: number;
}

export interface ShadowVerificationReport {
    readonly root: string;
    readonly side: string;
    readonly server: string;
    readonly at: number;
    readonly liveLoginsPerformed: 0;
    readonly summary: ShadowVerificationSummary;
    readonly checks: readonly ShadowVerificationCheck[];
    readonly fleetPlan: FleetPlan;
    readonly fleetState: FleetState;
    readonly routedPlans: Readonly<Record<string, ResolvedWorkerPlan>>;
    readonly sampleAssignments: readonly {
        readonly account: string;
        readonly role: AccountRole;
        readonly lifecycle: AccountLifecycle;
        readonly steps: number;
        readonly demandId?: string;
        readonly scorePerHour: number;
        readonly route?: string;
        readonly idleReason?: string;
    }[];
}

export interface ShadowProvider {
    loadSnapshot(opts: { root: string; now: number; side: string; server: string }): WorldSnapshot;
    loadActivities(opts: { root: string }): readonly ActivityDefinition[];
    loadDemands(opts: { root: string; world: WorldSnapshot; campaigns: readonly Campaign[]; missions: readonly Mission[] }): readonly GoalDemand[];
    loadCampaigns?(opts: { root: string; world: WorldSnapshot }): readonly Campaign[];
    loadMissions?(opts: { root: string; world: WorldSnapshot }): readonly Mission[];
    loadMarketQuotes?(opts: { root: string }): MarketQuotesMap;
}

export interface RunShadowOptions {
    readonly root?: string;
    readonly now?: number;
    readonly side?: string;
    readonly server?: string;
    readonly maxBots?: number;
    readonly ignoreSideStop?: boolean;
    readonly provider?: ShadowProvider;
}

function readJsonSafe<T>(file: string): T | null {
    if (!existsSync(file)) return null;
    try {
        return JSON.parse(readFileSync(file, 'utf8')) as T;
    } catch {
        return null;
    }
}

function findAccountByName(world: WorldSnapshot, accountName: string): AccountState | undefined {
    const direct = world.accounts[accountName] ?? world.accounts[accountName.toLowerCase()];
    if (direct) return direct;
    const lower = accountName.toLowerCase();
    return Object.values(world.accounts).find((a) => a.name.toLowerCase() === lower);
}

function loadConfirmedLogoutProofs(
    diagnostics: WorldSnapshotDiagnostics,
): Map<string, LogoutProof> {
    const out = new Map<string, LogoutProof>();
    const world = diagnostics.snapshot;
    for (const acct of Object.values(world.accounts)) {
        if (acct.side !== world.side || acct.lifecycle !== 'idle') continue;
        if (diagnostics.accounts[acct.name.toLowerCase()]?.logoutState !== 'confirmed') continue;
        for (const lcRoot of diagnostics.readRoots.lifecycleRoots) {
            if (!existsSync(lcRoot)) continue;
            const proof = readLogoutProof(acct.name, world.server, { root: lcRoot });
            if (proof.state === 'confirmed') {
                out.set(acct.name.toLowerCase(), proof);
                break;
            }
        }
    }
    return out;
}

const PROBE_COOK_SHARK: ActivityDefinition = {
    id: 'probe:cook-shark',
    workerId: 'bank-artisan',
    family: 'bank-artisan',
    kind: 'produce',
    label: 'Probe cook raw sharks at Catherby range',
    skill: 'Cooking',
    config: { aioCategory: 'skiller', aioRoute: 'cooking:stock', skill: 'cooking', method: 'stock', defaultArgs: ['shark'], requiredLevel: 80 },
    baselineRate: { xpPerTick: 210, unitsPerTick: 0.25, gpPerTick: 15, setupTicks: 25, minBatchUnits: 50, confidence: 'practice', inputsPerUnit: { 383: 1 }, outputsPerUnit: { 385: 1 } },
    inputs: [{ itemId: 383, countPerUnit: 1 }],
    outputs: [{ itemId: 385, countPerUnit: 1 }],
    location: { x: 2817, z: 3443, level: 0 },
    trust: 'practice_passed',
};

const PROBE_QUEST_LEGENDS: ActivityDefinition = {
    id: 'probe:quest-legends',
    workerId: 'quest',
    family: 'quest',
    kind: 'quest',
    label: 'Probe Legends Quest',
    questSlug: 'legends',
    config: { aioCategory: 'quester', aioRoute: 'legends', questSlug: 'legends', mode: 'sweep', requiredQuests: ['hero', 'upass', 'waterfall'], requiredSkills: { Agility: 50, Crafting: 50, Herblore: 45, Mining: 52, Prayer: 42, Smithing: 50, Strength: 50, Thieving: 50, Woodcutting: 50 } },
    baselineRate: { xpPerTick: 450, unitsPerTick: 0.002, gpPerTick: 0, setupTicks: 40, minBatchUnits: 1, confidence: 'practice' },
    location: { x: 2728, z: 3348, level: 0 },
    trust: 'practice_passed',
};

function verifySyntheticScenarioProbes(
    activities: readonly ActivityDefinition[],
    now: number,
): ShadowVerificationCheck[] {
    const checks: ShadowVerificationCheck[] = [];
    // Supplement catalog activities with synthetic input-consuming cook-shark & gated-legends probes
    // only inside isolated scenario probes so anti-ping-pong transfers & preflight gates are rigorously tested.
    const probeActivities: ActivityDefinition[] = [
        ...activities.filter((a) => a.id !== 'quest:legends' && a.id !== 'gather:fishing-shark'),
        PROBE_COOK_SHARK,
        PROBE_QUEST_LEGENDS,
    ];

    // 1. Fresh account probe
    const freshAcct: AccountState = {
        name: 'ProbeFresh',
        side: 'local',
        role: 'auto',
        protectedClock: false,
        lifecycle: 'idle',
        skills: { Attack: { level: 1, xp: 0 }, Strength: { level: 1, xp: 0 }, Defence: { level: 1, xp: 0 }, Hitpoints: { level: 10, xp: 1154 } },
        quests: {},
        pos: { x: 3222, z: 3218, level: 0 },
        inventory: { 995: 1500 },
        equipment: {},
        bank: { items: {}, observedAt: now - 10_000, trusted: true },
    };
    const freshWorld: WorldSnapshot = {
        schemaVersion: 1,
        at: now,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: { ProbeFresh: freshAcct },
    };
    const freshPlan = planAccount(freshAcct, {
        world: freshWorld,
        activities,
        demands: [{
            id: 'probe:fresh-bootstrap',
            goalKind: 'pk_army',
            valueScore: 8,
            valuePerHour: 8,
            target: { kind: 'skill', account: 'ProbeFresh', skill: 'Strength', targetLevel: 30 },
            fulfilled: 0,
            remaining: 1,
            priorityWeight: 1,
            assignedAccount: 'ProbeFresh',
            active: true,
        }],
    });
    const freshRouted = resolveAccountWorkerPlan(freshPlan, { activities });
    checks.push({
        name: 'fresh_accounts_planned',
        ok: isAccountPlan(freshPlan)
            && freshPlan.steps.length >= 1
            && freshPlan.steps.length <= 3
            && freshRouted.steps.length === freshPlan.steps.length
            && freshRouted.steps.every((s) => isSupportedWorkerFamily(s.family)),
        detail: `ProbeFresh steps=${freshPlan.steps.length} route=${freshRouted.steps[0] ? `${freshRouted.steps[0].family}:${freshRouted.steps[0].routeKey}` : 'none'}`,
    });

    // 2. Comparative advantage probe: high-quest veteran vs high-artisan veteran vs maxed tribrid
    const questVet: AccountState = {
        ...freshAcct,
        name: 'ProbeQuest',
        quests: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`q${i}`, 'complete' as const])),
        skills: {
            Attack: { level: 60, xp: 280_000 }, Strength: { level: 60, xp: 280_000 }, Defence: { level: 60, xp: 280_000 },
            Hitpoints: { level: 60, xp: 280_000 }, Agility: { level: 60, xp: 280_000 }, Crafting: { level: 55, xp: 170_000 },
            Herblore: { level: 50, xp: 105_000 }, Mining: { level: 55, xp: 170_000 }, Prayer: { level: 45, xp: 65_000 },
            Smithing: { level: 55, xp: 170_000 }, Thieving: { level: 55, xp: 170_000 }, Woodcutting: { level: 55, xp: 170_000 },
        },
        quests_extra: undefined,
    } as AccountState;
    (questVet as any).quests = {
        ...questVet.quests,
        hero: 'complete',
        upass: 'complete',
        waterfall: 'complete',
    };
    const artisanVet: AccountState = {
        ...freshAcct,
        name: 'ProbeArtisan',
        skills: { Cooking: { level: 92, xp: 6_600_000 }, Fishing: { level: 85, xp: 3_300_000 }, Hitpoints: { level: 40, xp: 38_000 } },
        bank: { items: { 383: 500, 995: 50_000 }, observedAt: now - 5000, trusted: true },
    };
    const maxedTribrid: AccountState = {
        ...freshAcct,
        name: 'ProbeTribrid',
        role: 'army',
        skills: {
            Attack: { level: 99, xp: 13_034_431 }, Strength: { level: 99, xp: 13_034_431 }, Defence: { level: 99, xp: 13_034_431 },
            Hitpoints: { level: 99, xp: 13_034_431 }, Ranged: { level: 99, xp: 13_034_431 }, Magic: { level: 99, xp: 13_034_431 },
            Prayer: { level: 70, xp: 737_627 },
        },
        bank: { items: { 385: 100, 995: 250_000 }, observedAt: now - 5000, trusted: true },
    };
    const compDemands: GoalDemand[] = [
        { id: 'd:quest', goalKind: 'quest_board', valueScore: 10, valuePerHour: 10, target: { kind: 'quest', questSlug: 'legends' }, fulfilled: 0, remaining: 1, priorityWeight: 1, active: true },
        { id: 'd:supply', goalKind: 'main_supply', valueScore: 10, valuePerHour: 10, target: { kind: 'item', itemId: 385, count: 200 }, fulfilled: 0, remaining: 200, priorityWeight: 1, active: true },
        { id: 'd:pk', goalKind: 'pk_army', valueScore: 10, valuePerHour: 10, target: { kind: 'combat_readiness', account: 'ProbeTribrid', targets: { Attack: 99, Strength: 99, Defence: 99 } }, fulfilled: 0, remaining: 1, priorityWeight: 1, active: true },
    ];
    const compWorld: WorldSnapshot = {
        schemaVersion: 1,
        at: now,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: { ProbeQuest: questVet, ProbeArtisan: artisanVet, ProbeTribrid: maxedTribrid },
    };
    const qPlan = planAccount(questVet, { world: compWorld, activities: probeActivities, demands: compDemands });
    const aPlan = planAccount(artisanVet, { world: compWorld, activities: probeActivities, demands: compDemands });
    const tPlan = planAccount(maxedTribrid, { world: compWorld, activities: probeActivities, demands: compDemands });
    checks.push({
        name: 'veteran_comparative_advantage',
        ok: qPlan.demandId === 'd:quest' && aPlan.demandId === 'd:supply' && tPlan.demandId === 'd:pk',
        detail: `questVet->${qPlan.demandId}, artisanVet->${aPlan.demandId}, tribrid->${tPlan.demandId}`,
    });

    // 3. Campaign & Mission gating probe
    const camp: Campaign = {
        id: 'camp:haggis',
        account: 'haggis',
        protectedClock: true,
        board: 'Overall',
        requiredSupplies: [{ itemId: 385, itemName: 'Shark', count: 200 }],
        stagingHolder: 'ProbeArtisan',
        rehearsalProof: null,
        hiscoreMargin: null,
        state: 'staging',
    };
    const pausedMission: Mission = {
        id: 'mission:paused-test',
        participants: ['ProbeTribrid'],
        state: 'paused',
        kitTargets: [],
        consumables: [],
        weight: 5,
    };
    const missionDemand: GoalDemand = {
        id: 'd:paused-mission',
        goalKind: 'pk_army',
        sourceId: pausedMission.id,
        valueScore: 100,
        valuePerHour: 100,
        target: { kind: 'combat_readiness', account: 'ProbeTribrid', targets: { Attack: 99 } },
        fulfilled: 0,
        remaining: 1,
        priorityWeight: 5,
        assignedAccount: 'ProbeTribrid',
        active: true,
    };
    const gatedPlan = scheduleFleet({
        world: compWorld,
        activities: probeActivities,
        demands: [missionDemand],
        campaigns: [camp],
        missions: [pausedMission],
        maxBots: 5,
    });
    checks.push({
        name: 'campaign_and_mission_gating',
        ok: isCampaign(camp) && isMission(pausedMission) && missionEffectiveWeight(pausedMission) === 0
            && (gatedPlan.accountPlans.ProbeTribrid?.steps.length ?? 0) === 0,
        detail: `campaign valid=${isCampaign(camp)}, paused mission steps=${gatedPlan.accountPlans.ProbeTribrid?.steps.length ?? 0}`,
    });

    // 4. Anti-ping-pong transfer & recovery ordering probe
    const recWorld: WorldSnapshot = {
        schemaVersion: 1,
        at: now,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: {
            RecLow: { ...freshAcct, name: 'RecLow', lifecycle: 'needs_logout_recovery', inventory: { 995: 100 } },
            RecHigh: { ...freshAcct, name: 'RecHigh', lifecycle: 'needs_logout_recovery', inventory: { 995: 500_000 } },
            RecLoc: { ...freshAcct, name: 'RecLoc', lifecycle: 'needs_location_recovery', inventory: { 995: 900_000 } },
            Donor: { ...freshAcct, name: 'Donor', lifecycle: 'idle', bank: { items: { 383: 500, 995: 5000 }, observedAt: now - 5000, trusted: true } },
            NeedRaw: {
                ...artisanVet,
                name: 'NeedRaw',
                lifecycle: 'idle',
                bank: { items: { 995: 1000 }, observedAt: now - 5000, trusted: true },
            },
        },
        activeTransfers: [{
            id: 'recent-1',
            server: 'rs-sdk-demo.fly.dev',
            from: 'Other',
            to: 'Donor',
            hub: 'varrock_west',
            items: [{ itemId: 383, count: 100 }],
            demandId: 'd:prev',
            reason: 'prior delivery',
            createdAt: now - 60_000,
            expiresAt: now + 600_000,
            state: 'settled',
            bothIdleVerified: true,
            donorLogoutConfirmedAt: now - 70_000,
            recipientLogoutConfirmedAt: now - 65_000,
            antiPingPong: { donorHoldsDemandForItems: false, cooldownWindowMs: 600_000 },
        }],
    };
    const logoutProofs = new Map<string, LogoutProof>([
        ['donor', { state: 'confirmed', account: 'Donor', server: 'rs-sdk-demo.fly.dev', domain: 'live', attemptId: '1700000000000-0000000001-0000000001', loggedOutAt: now - 10_000, ownerRun: null, receiptSha256: 'a'.repeat(64) }],
        ['needraw', { state: 'confirmed', account: 'NeedRaw', server: 'rs-sdk-demo.fly.dev', domain: 'live', attemptId: '1700000000000-0000000001-0000000002', loggedOutAt: now - 10_000, ownerRun: null, receiptSha256: 'b'.repeat(64) }],
    ]);
    const recPlan = scheduleFleet({
        world: recWorld,
        activities: probeActivities,
        demands: [{ id: 'd:cook-need', goalKind: 'main_supply', valueScore: 10, valuePerHour: 10, target: { kind: 'item', itemId: 385, count: 100 }, fulfilled: 0, remaining: 100, priorityWeight: 1, assignedAccount: 'NeedRaw', active: true }],
        logoutProofs,
        requireMarketQuote: true,
        marketQuotes: {},
        maxBots: 5,
    });
    const recOrder = recPlan.recoveryQueue.map((r) => r.account);
    const antiPingPongBlocked = recPlan.transferOrders.length === 0;
    const sampleTransfer: TransferOrder = {
        id: 'probe-xfer',
        server: 'rs-sdk-demo.fly.dev',
        from: 'Donor',
        to: 'NeedRaw',
        hub: 'varrock_west',
        items: [{ itemId: 383, count: 50 }],
        demandId: 'd:cook-need',
        reason: 'probe',
        createdAt: now,
        expiresAt: now + 600_000,
        state: 'planned',
        bothIdleVerified: true,
        donorLogoutConfirmedAt: now - 10_000,
        recipientLogoutConfirmedAt: now - 10_000,
        antiPingPong: { donorRecentReceivedAt: now - 60_000, donorHoldsDemandForItems: false, cooldownWindowMs: 600_000 },
    };
    const pingPongRefused = !canScheduleTransferOrder(sampleTransfer, recWorld.accounts.Donor!, recWorld.accounts.NeedRaw!, {
        now,
        donorLogoutState: 'confirmed',
        recipientLogoutState: 'confirmed',
    }).ok;
    checks.push({
        name: 'recovery_ordering_and_anti_ping_pong',
        ok: recOrder.join(',') === 'RecHigh,RecLow,RecLoc' && antiPingPongBlocked && pingPongRefused,
        detail: `recoveryQueue=[${recOrder.join(',')}], antiPingPongBlocked=${antiPingPongBlocked}, pingPongRefused=${pingPongRefused}`,
    });

    return checks;
}

export function runShadowVerification(options: RunShadowOptions = {}): ShadowVerificationReport {
    const root = resolve(options.root ?? DEFAULT_REPO_ROOT);
    const now = options.now ?? Date.now();
    const side = options.side ?? process.env.FLEET_SIDE ?? 'local';
    const server = options.server ?? 'rs-sdk-demo.fly.dev';

    const swarmCfg = readJsonSafe<{ maxBots?: number }>(join(root, 'swarm.json'));
    const maxBots = options.maxBots ?? (Number.isSafeInteger(swarmCfg?.maxBots) && swarmCfg!.maxBots! > 0 ? swarmCfg!.maxBots! : 25);

    const provider = options.provider;
    const catalogRoot = existsSync(join(root, 'knowledge', 'items.json')) ? root : DEFAULT_REPO_ROOT;
    const catalog = provider ? null : createActivityCatalog({ root: catalogRoot });
    const activities = provider
        ? provider.loadActivities({ root })
        : catalog!.list();
    const activitySpotById = new Map<string, string>();
    for (const act of activities) {
        if (act.spotId) activitySpotById.set(act.id, act.spotId);
    }

    const diagnostics = provider ? null : inspectWorldSnapshot({ root, now, side, server, activitySpotById });
    const world = provider
        ? provider.loadSnapshot({ root, now, side, server })
        : diagnostics!.snapshot;

    const rateStore: RateStore | undefined = catalog ? createRateStore({ catalog, root }) : undefined;

    const campaigns = provider?.loadCampaigns
        ? provider.loadCampaigns({ root, world })
        : loadCampaignManifests({ root, now });
    const missions = provider?.loadMissions
        ? provider.loadMissions({ root, world })
        : loadMissionManifests({ root, now });
    const demands = provider
        ? provider.loadDemands({ root, world, campaigns, missions })
        : createDemandEngine({
            catalog: catalog!,
            rateStore,
            campaigns,
            missions,
            root,
        }).activeDemands(world);
    const marketQuotes = provider?.loadMarketQuotes
        ? provider.loadMarketQuotes({ root })
        : loadMarketQuotesFromRoot(root, now);
    const logoutProofs = diagnostics
        ? loadConfirmedLogoutProofs(diagnostics)
        : undefined;

    const fleetPlan = scheduleFleet({
        world,
        activities,
        demands,
        campaigns,
        missions,
        maxBots,
        ignoreSideStop: options.ignoreSideStop ?? true,
        retentionMarginRatio: DEFAULT_RETENTION_MARGIN_RATIO,
        rateStore,
        marketQuotes,
        logoutProofs,
    });

    const fleetState = buildFleetState(fleetPlan, {
        world,
        goals: demands,
        campaigns,
        missions,
        ...(rateStore ? { rateStats: rateStore.summary() } : {}),
    });

    const routedPlans: Record<string, ResolvedWorkerPlan> = {};
    for (const [acctName, plan] of Object.entries(fleetPlan.accountPlans)) {
        if (plan.steps.length > 0) {
            routedPlans[acctName] = resolveAccountWorkerPlan(plan, { activities });
        }
    }

    const lifecycleCounts: Record<AccountLifecycle, number> = {
        paused_owner: 0,
        reserved: 0,
        dead: 0,
        needs_logout_recovery: 0,
        needs_location_recovery: 0,
        running: 0,
        in_trade: 0,
        idle: 0,
    };
    const roleCounts: Record<AccountRole, number> = {
        auto: 0,
        army: 0,
        helper: 0,
        specialist: 0,
        main: 0,
    };

    let sideAccounts = 0;
    let protectedAccountsCount = 0;
    let protectedAccountsIdle = 0;
    let protectedLaunchReady = 0;
    let protectedSafetyViolations = 0;

    for (const acct of Object.values(world.accounts)) {
        lifecycleCounts[acct.lifecycle] += 1;
        roleCounts[acct.role] += 1;
        if (acct.side === world.side) sideAccounts += 1;
        if (acct.protectedClock || isProtectedAccountName(acct.name)) {
            protectedAccountsCount += 1;
            const plan = fleetPlan.accountPlans[acct.name];
            const launchOk = canProtectedAccountLaunch(acct, campaigns, world).allowed;
            if (!launchOk) {
                if (!plan || plan.steps.length === 0) protectedAccountsIdle += 1;
                else protectedSafetyViolations += 1;
            } else {
                protectedLaunchReady += 1;
            }
        }
    }

    const checks: ShadowVerificationCheck[] = [];
    const fpErrors = validateFleetPlan(fleetPlan);
    const fsErrors = validateFleetState(fleetState);
    checks.push({
        name: 'schema_valid',
        ok: isFleetPlan(fleetPlan) && isFleetState(fleetState),
        detail: `fleetPlanErrors=${fpErrors.length}, fleetStateErrors=${fsErrors.length}`,
    });

    checks.push({
        name: 'protected_clock_safety',
        ok: protectedSafetyViolations === 0,
        detail: `protected=${protectedAccountsCount}, heldOffline=${protectedAccountsIdle}, launchReady=${protectedLaunchReady}, violations=${protectedSafetyViolations}`,
    });

    const catalogFamilies = new Set(activities.map((a) => a.family));
    const allFamiliesCovered = WORKER_FAMILIES.every((f) => catalogFamilies.has(f));
    const validRoutes = Object.values(routedPlans).every(
        (r) => r.steps.length > 0 && r.steps.every((s) => isSupportedWorkerFamily(s.family) && s.routeKey.length > 0),
    );
    checks.push({
        name: 'worker_engine_coverage',
        ok: validRoutes && allFamiliesCovered,
        detail: `routedPlans=${Object.keys(routedPlans).length}, allFamilies=${allFamiliesCovered}, validRoutes=${validRoutes}`,
    });

    const validHubs = fleetPlan.transferOrders.every(
        (o) => isTransferOrder(o) && Object.hasOwn(HUB_BANKER_LOCATIONS, o.hub) && o.bothIdleVerified,
    );
    checks.push({
        name: 'fleet_transfer_safety',
        ok: validHubs,
        detail: `transferOrders=${fleetPlan.transferOrders.length}, allValidHubsAndIdle=${validHubs}`,
    });

    checks.push(...verifySyntheticScenarioProbes(activities, now));

    const sampleAssignments = Object.values(fleetPlan.accountPlans)
        .sort((a, b) => b.steps.length - a.steps.length || b.scorePerHour - a.scorePerHour || a.account.localeCompare(b.account))
        .map((plan) => {
            const acct = findAccountByName(world, plan.account);
            const routed = routedPlans[plan.account];
            const routeText = routed?.steps.map((s) => `${s.family}:${s.routeKey}`).join(' -> ');
            return {
                account: plan.account,
                role: acct?.role ?? 'auto',
                lifecycle: acct?.lifecycle ?? 'idle',
                steps: plan.steps.length,
                ...(plan.demandId ? { demandId: plan.demandId } : {}),
                scorePerHour: Number(plan.scorePerHour.toFixed(2)),
                ...(routeText ? { route: routeText } : {}),
                ...(plan.idleReason ? { idleReason: plan.idleReason } : {}),
            };
        });

    const checksPassed = checks.filter((c) => c.ok).length;
    const summary: ShadowVerificationSummary = {
        totalOwnedAccounts: Object.keys(world.accounts).length,
        sideAccounts,
        sideStopped: world.fleetSides?.[world.side]?.stopped === true,
        maxBots: fleetPlan.maxBots,
        selectedSlots: fleetPlan.selectedSlots,
        lifecycleCounts,
        roleCounts,
        protectedAccountsCount,
        protectedAccountsIdle,
        recoveryQueueLength: fleetPlan.recoveryQueue.length,
        activeChainsCount: Object.keys(fleetState.activeChains).length,
        transferOrdersCount: fleetPlan.transferOrders.length,
        routedPlansCount: Object.keys(routedPlans).length,
        checksPassed,
        checksTotal: checks.length,
    };

    return {
        root,
        side: world.side,
        server: world.server,
        at: now,
        liveLoginsPerformed: 0,
        summary,
        checks,
        fleetPlan,
        fleetState,
        routedPlans,
        sampleAssignments,
    };
}

export function formatShadowSummary(report: ShadowVerificationReport): string {
    const s = report.summary;
    const recoverySamples = report.sampleAssignments.filter((a) => a.lifecycle === 'needs_logout_recovery' || a.lifecycle === 'needs_location_recovery');
    const workSamples = report.sampleAssignments.filter((a) => a.steps > 0 && a.lifecycle !== 'needs_logout_recovery' && a.lifecycle !== 'needs_location_recovery');
    const lines: string[] = [
        `Shadow Verification (root=${report.root}, side=${report.side}, sideStopped=${s.sideStopped}, server=${report.server}, liveLogins=${report.liveLoginsPerformed})`,
        `Accounts: ${s.totalOwnedAccounts} total (${s.sideAccounts} on side), maxBots=${s.maxBots}, selectedSlots=${s.selectedSlots}`,
        `Lifecycles: ${Object.entries(s.lifecycleCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`,
        `Roles: ${Object.entries(s.roleCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`,
        `Protected clocks: ${s.protectedAccountsCount} total, ${s.protectedAccountsIdle} held offline`,
        `Plans: activeChains=${s.activeChainsCount}, recoveryQueue=${s.recoveryQueueLength}, transferOrders=${s.transferOrdersCount}`,
        `Checks (${s.checksPassed}/${s.checksTotal} passing):`,
        ...report.checks.map((c) => `  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name}: ${c.detail}`),
        `Recovery queue sample (${recoverySamples.length} total):`,
        ...recoverySamples.slice(0, 6).map((a) =>
            `  - ${a.account} (${a.role}/${a.lifecycle}): ${a.steps} step(s), route=${a.route ?? '-'}`,
        ),
        `Active work sample (${workSamples.length} total):`,
        ...workSamples.slice(0, 10).map((a) =>
            `  - ${a.account} (${a.role}/${a.lifecycle}): ${a.steps} step(s), demand=${a.demandId ?? '-'}, score/hr=${a.scorePerHour}, route=${a.route ?? '-'}`,
        ),
    ];
    return lines.join('\n');
}

function parseCliArgs(argv: readonly string[]): { root?: string; side?: string; server?: string; maxBots?: number; json: boolean } {
    let root: string | undefined;
    let side: string | undefined;
    let server: string | undefined;
    let maxBots: number | undefined;
    let json = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === '--json') json = true;
        else if (arg === '--root' && argv[i + 1]) root = argv[++i]!;
        else if (arg.startsWith('--root=')) root = arg.slice('--root='.length);
        else if (arg === '--side' && argv[i + 1]) side = argv[++i]!;
        else if (arg.startsWith('--side=')) side = arg.slice('--side='.length);
        else if (arg === '--server' && argv[i + 1]) server = argv[++i]!;
        else if (arg.startsWith('--server=')) server = arg.slice('--server='.length);
        else if (arg === '--max-bots' && argv[i + 1]) maxBots = Number(argv[++i]!);
        else if (arg.startsWith('--max-bots=')) maxBots = Number(arg.slice('--max-bots='.length));
    }
    return { root, side, server, maxBots, json };
}

if (import.meta.main) {
    const cli = parseCliArgs(process.argv.slice(2));
    const report = runShadowVerification({
        root: cli.root,
        side: cli.side,
        server: cli.server,
        maxBots: cli.maxBots,
    });
    if (cli.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        console.log(formatShadowSummary(report));
    }
    const allPassed = report.summary.checksPassed === report.summary.checksTotal;
    process.exit(allPassed ? 0 : 1);
}
