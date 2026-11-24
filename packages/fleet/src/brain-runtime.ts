// Brain runtime bridge for fleet controllers: drains OperatorCommands cleanly,
// loads WorldSnapshot + DemandEngine + AccountPlanner + FleetScheduler,
// applies short-TTL account overrides, and publishes validated FleetState JSON.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mySide } from '../../core/src/fleet';
import { tradeSettlement, validOrder, type Order, type Receipt } from '../../core/src/fleet-trade-settlement';
import { atomicJson } from '../../core/src/plan-lock';
import {
    fleetStateFile,
    liveRoot,
    operatorCommandsDir,
    practiceRoot,
    repoRoot,
    statusReadDirs,
    stopFilePaths,
} from '../../core/src/practice-paths';
import { readLogoutProof, type LogoutProof } from '../../core/src/session-lifecycle';
import { isWorkerTile, type TrustTier, type WorkerTile } from '../../workers/src/contracts';
import {
    DEFAULT_RETENTION_MARGIN_RATIO,
    HUB_BANKER_LOCATIONS,
    OutcomeClassifier,
    buildFleetState,
    canProtectedAccountLaunch,
    createActivityCatalog,
    createDemandEngine,
    createRateStore,
    defaultActivityCatalog,
    inspectWorldSnapshot,
    loadCampaignManifests,
    loadItemsMap,
    loadMarketQuotesFromRoot,
    loadMissionManifests,
    planAccount,
    scheduleFleet,
    validateCampaign,
    validateFleetState,
    validateMission,
    validateOperatorCommand,
    type AccountActiveJob,
    type AccountPlan,
    type AccountRole,
    type ActivityCatalog,
    type ActivityDefinition,
    type Campaign,
    type DemandEngine,
    type FleetPlan,
    type FleetState,
    type HubBankId,
    type InfraCircuitBreakerState,
    type MarketQuotesMap,
    type Mission,
    type OperatorCommand,
    type OutcomeClassificationResult,
    type RateStore,
    type RawWorkerExitInput,
    type TransferOrder,
    type WorldSnapshot,
    type WorldSnapshotDiagnostics,
} from '../../brain/src/index';
import { InfraCircuitBreaker } from './infra-circuit-breaker';
import { dispatchAccountPlan, type DispatchedAccountPlan } from './worker-dispatch';

export interface AccountOverrideRecord {
    readonly account: string;
    readonly activityId?: string | null;
    readonly role?: AccountRole;
    readonly issuedAt: number;
    readonly expiresAt: number;
    readonly reason?: string;
}

export interface OperatorCommandApplyResult {
    readonly id: string;
    readonly file: string;
    readonly kind?: string;
    readonly applied: boolean;
    readonly duplicate?: boolean;
    readonly error?: string;
    readonly at: number;
}

export interface BrainCycleOptions {
    readonly root?: string;
    readonly now?: number;
    readonly side?: string;
    readonly server?: string;
    readonly fleetDir?: string;
    readonly maxBots?: number;
    readonly ignoreSideStop?: boolean;
    readonly minTrust?: TrustTier;
    readonly allowExperimentalFallback?: boolean;
    readonly persist?: boolean;
    readonly consumeCommands?: boolean;
    readonly activeAccounts?: ReadonlySet<string> | ReadonlyMap<string, AccountActiveJob>;
    readonly activeTransfers?: readonly TransferOrder[];
    readonly recentTransfers?: readonly TransferOrder[];
    readonly catalog?: ActivityCatalog;
    readonly rateStore?: RateStore;
    readonly classifier?: OutcomeClassifier;
    readonly infraBreaker?: InfraCircuitBreaker;
    readonly marketQuotes?: MarketQuotesMap;
    readonly stationedHubBankers?: Readonly<Partial<Record<HubBankId, string>>>;
}

export interface BrainCycleResult {
    readonly fleetState: FleetState;
    readonly fleetPlan: FleetPlan;
    readonly world: WorldSnapshot;
    readonly diagnostics: WorldSnapshotDiagnostics;
    readonly appliedCommands: readonly OperatorCommandApplyResult[];
    readonly dispatchedPlans: Readonly<Record<string, DispatchedAccountPlan>>;
    readonly overrides: Readonly<Record<string, AccountOverrideRecord>>;
}

const DEFAULT_LIVE_SERVER = 'rs-sdk-demo.fly.dev';
const SAFE_OPERATOR_COMMAND_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const BLOCKED_OVERRIDE_REASON_RE = /^(?:protected_clock|campaign_|system_hold:|paused_owner|dead|in_trade|all_candidates_quarantined|quarantined)/;
const SWARM_AUTO_STOP_RE =
    /^(?:swarm stopped|swarm plan removed or stopped|swarm recovery stopped|inherited recovery stopped|fleet controller lease unavailable|swarm)$/i;

export function isSafeOperatorCommandId(id: unknown): id is string {
    return typeof id === 'string' && SAFE_OPERATOR_COMMAND_ID_RE.test(id) && !id.includes('..');
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readJsonSafe(file: string): unknown {
    if (!existsSync(file)) return undefined;
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return undefined;
    }
}

export function accountOverridesFile(root = repoRoot): string {
    return join(liveRoot(root), 'account-overrides.json');
}

export function campaignOverridesFile(root = repoRoot): string {
    return join(liveRoot(root), 'campaigns.json');
}

export function missionOverridesFile(root = repoRoot): string {
    return join(liveRoot(root), 'missions.json');
}

export function readAccountOverrides(root = repoRoot, now = Date.now()): Record<string, AccountOverrideRecord> {
    const raw = readJsonSafe(accountOverridesFile(root));
    if (!isPlainRecord(raw)) return {};
    const out: Record<string, AccountOverrideRecord> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (!isPlainRecord(value)) continue;
        if (typeof value.account !== 'string' || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) {
            continue;
        }
        if (value.expiresAt <= now) continue;
        out[key.toLowerCase()] = {
            account: value.account,
            ...(value.activityId !== undefined ? { activityId: value.activityId as string | null } : {}),
            ...(typeof value.role === 'string' ? { role: value.role as AccountRole } : {}),
            issuedAt: typeof value.issuedAt === 'number' && Number.isFinite(value.issuedAt) ? value.issuedAt : now,
            expiresAt: value.expiresAt,
            ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
        };
    }
    return out;
}

export function writeAccountOverrides(
    root: string,
    overrides: Readonly<Record<string, AccountOverrideRecord>>,
): void {
    atomicJson(accountOverridesFile(root), overrides);
}

function upsertManifestOverride<T extends { readonly id: string }>(
    file: string,
    key: 'campaigns' | 'missions',
    validateItem: (v: unknown) => string[],
    entry: T,
): void {
    const raw = readJsonSafe(file);
    const list = Array.isArray(raw)
        ? raw
        : isPlainRecord(raw) && Array.isArray(raw[key])
          ? (raw[key] as unknown[])
          : [];
    const byId = new Map<string, T>();
    for (const item of list) {
        if (isPlainRecord(item) && typeof item.id === 'string' && validateItem(item).length === 0) {
            byId.set(item.id, item as unknown as T);
        }
    }
    byId.set(entry.id, entry);
    atomicJson(file, [...byId.values()]);
}

function writeOperatorStop(flag: string, text: string, root: string): void {
    const target = join(practiceRoot(root), `stop-${flag}`);
    mkdirSync(practiceRoot(root), { recursive: true });
    if (existsSync(target)) {
        const existing = readFileSync(target, 'utf8').trim();
        if (existing && !SWARM_AUTO_STOP_RE.test(existing)) {
            return;
        }
    }
    writeFileSync(target, text, 'utf8');
}

function clearOperatorStops(flag: string, root: string): void {
    const variants = [...new Set([flag, flag.toLowerCase()])];
    for (const v of variants) {
        for (const p of stopFilePaths(v, root)) {
            rmSync(p, { force: true });
        }
    }
}

function applyCommand(
    cmd: OperatorCommand,
    opts: {
        readonly root: string;
        readonly now: number;
        readonly side: string;
        readonly classifier: OutcomeClassifier;
        readonly demandEngine: DemandEngine;
    },
): boolean {
    const { root, now, side, classifier, demandEngine } = opts;
    switch (cmd.kind) {
        case 'pause_account':
            writeOperatorStop(cmd.account, cmd.reason ?? 'dashboard operator pause', root);
            return true;
        case 'resume_account': {
            clearOperatorStops(cmd.account, root);
            const cleared = classifier.applyOperatorCommand(cmd, now);
            return cleared || true;
        }
        case 'pause_side':
            if (cmd.side !== side) return false;
            writeOperatorStop('swarm', cmd.reason ?? `operator pause_side ${cmd.side}`, root);
            return true;
        case 'resume_side':
            if (cmd.side !== side) return false;
            clearOperatorStops('swarm', root);
            return true;
        case 'clear_defect':
            return classifier.applyOperatorCommand(cmd, now);
        case 'override_account': {
            const current = readAccountOverrides(root, now);
            const key = cmd.account.toLowerCase();
            if (cmd.activityId === null && cmd.role === undefined) {
                delete current[key];
            } else {
                current[key] = {
                    account: cmd.account,
                    ...(cmd.activityId !== undefined ? { activityId: cmd.activityId } : {}),
                    ...(cmd.role !== undefined ? { role: cmd.role } : {}),
                    issuedAt: cmd.issuedAt,
                    expiresAt: cmd.expiresAt,
                    ...(cmd.reason ? { reason: cmd.reason } : {}),
                };
            }
            writeAccountOverrides(root, current);
            return true;
        }
        case 'set_campaign_state': {
            const updated = demandEngine.applyOperatorCommand(cmd);
            const target = demandEngine.campaigns().find((c) => c.id === cmd.campaignId);
            if (target) {
                upsertManifestOverride<Campaign>(
                    campaignOverridesFile(root),
                    'campaigns',
                    validateCampaign,
                    target,
                );
            }
            return updated;
        }
        case 'upsert_campaign': {
            const updated = demandEngine.applyOperatorCommand(cmd);
            upsertManifestOverride<Campaign>(
                campaignOverridesFile(root),
                'campaigns',
                validateCampaign,
                cmd.campaign,
            );
            return updated;
        }
        case 'set_mission_state': {
            const updated = demandEngine.applyOperatorCommand(cmd);
            const target = demandEngine.missions().find((m) => m.id === cmd.missionId);
            if (target) {
                upsertManifestOverride<Mission>(
                    missionOverridesFile(root),
                    'missions',
                    validateMission,
                    target,
                );
            }
            return updated;
        }
        case 'upsert_mission': {
            const updated = demandEngine.applyOperatorCommand(cmd);
            upsertManifestOverride<Mission>(
                missionOverridesFile(root),
                'missions',
                validateMission,
                cmd.mission,
            );
            return updated;
        }
    }
}

export function drainOperatorCommands(opts: {
    readonly root?: string;
    readonly now?: number;
    readonly side?: string;
    readonly classifier: OutcomeClassifier;
    readonly demandEngine: DemandEngine;
}): OperatorCommandApplyResult[] {
    const root = resolve(opts.root ?? repoRoot);
    const now = opts.now ?? Date.now();
    const side = opts.side ?? mySide();
    const dir = operatorCommandsDir(root);
    if (!existsSync(dir)) return [];

    const appliedDir = join(dir, 'applied');
    const rejectedDir = join(dir, 'rejected');
    const entries = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith('.json'))
        .map((d) => d.name)
        .sort();

    const parsedItems: { file: string; path: string; parsed: unknown }[] = [];
    for (const file of entries) {
        const filePath = join(dir, file);
        const parsed = readJsonSafe(filePath);
        if (parsed === undefined) {
            atomicJson(join(rejectedDir, file), { file, error: 'malformed JSON', rejectedAt: now });
            rmSync(filePath, { force: true });
            continue;
        }
        const errors = validateOperatorCommand(parsed);
        if (errors.length === 0 && isPlainRecord(parsed) && !isSafeOperatorCommandId(parsed.id)) {
            errors.push('OperatorCommand.id must match /^[A-Za-z0-9._-]{1,128}$/ without ".."');
        }
        if (errors.length > 0) {
            atomicJson(join(rejectedDir, file), { file, errors, rejectedAt: now, payload: parsed });
            rmSync(filePath, { force: true });
            continue;
        }
        parsedItems.push({ file, path: filePath, parsed });
    }

    parsedItems.sort((a, b) => {
        const ca = a.parsed as OperatorCommand;
        const cb = b.parsed as OperatorCommand;
        return ca.issuedAt - cb.issuedAt || ca.id.localeCompare(cb.id) || a.file.localeCompare(b.file);
    });

    const results: OperatorCommandApplyResult[] = [];
    for (const item of parsedItems) {
        const cmd = item.parsed as OperatorCommand;
        const receiptPath = join(appliedDir, `${cmd.id}.json`);
        if (existsSync(receiptPath)) {
            rmSync(item.path, { force: true });
            results.push({ id: cmd.id, file: item.file, kind: cmd.kind, applied: false, duplicate: true, at: now });
            continue;
        }
        try {
            const applied = applyCommand(cmd, {
                root,
                now,
                side,
                classifier: opts.classifier,
                demandEngine: opts.demandEngine,
            });
            atomicJson(receiptPath, { ...cmd, appliedAt: now, applied });
            rmSync(item.path, { force: true });
            results.push({ id: cmd.id, file: item.file, kind: cmd.kind, applied, at: now });
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            atomicJson(join(rejectedDir, item.file), { file: item.file, command: cmd, error, rejectedAt: now });
            rmSync(item.path, { force: true });
            results.push({ id: cmd.id, file: item.file, kind: cmd.kind, applied: false, error, at: now });
        }
    }
    return results;
}

function loadConfirmedLogoutProofs(diagnostics: WorldSnapshotDiagnostics): Map<string, LogoutProof> {
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

function resolveSwarmMaxBots(root: string, explicit?: number): number {
    if (explicit !== undefined && Number.isSafeInteger(explicit) && explicit >= 0) return explicit;
    const planFile = resolve(process.env.SWARM_PLAN ?? join(root, 'swarm.json'));
    const raw = readJsonSafe(planFile);
    if (isPlainRecord(raw) && typeof raw.maxBots === 'number' && Number.isSafeInteger(raw.maxBots) && raw.maxBots >= 0) {
        return raw.maxBots;
    }
    return 25;
}

function combineInfraState(
    classifier: OutcomeClassifier,
    infraBreaker: InfraCircuitBreaker,
    now: number,
): InfraCircuitBreakerState {
    const cls = classifier.canProceedInfra(now);
    const brk = infraBreaker.canProceed();
    const clsOpen = !cls.allowed;
    const brkOpen = !brk.allowed;
    if (!clsOpen && !brkOpen) {
        return {
            open: false,
            consecutiveFaults: Math.max(cls.state.consecutiveFaults, brk.consecutiveFailures),
        };
    }
    const retryCandidates = [clsOpen ? cls.state.retryAt ?? now + cls.waitMs : 0, brkOpen ? brk.openUntil : 0];
    const retryAt = Math.max(...retryCandidates);
    const reasons = [clsOpen ? cls.state.reason : undefined, brkOpen ? brk.reason : undefined].filter(
        (r): r is string => Boolean(r),
    );
    return {
        open: true,
        trippedAt: cls.state.trippedAt ?? now,
        retryAt,
        consecutiveFaults: Math.max(cls.state.consecutiveFaults, brk.consecutiveFailures, 1),
        ...(reasons.length > 0 ? { reason: reasons.join('; ') } : {}),
    };
}

function applyAccountOverridesToWorld(
    world: WorldSnapshot,
    overrides: Readonly<Record<string, AccountOverrideRecord>>,
): WorldSnapshot {
    if (Object.keys(overrides).length === 0) return world;
    const nextAccounts = { ...world.accounts };
    for (const [name, acct] of Object.entries(world.accounts)) {
        const ov = overrides[name.toLowerCase()];
        if (ov?.role && ov.role !== acct.role) {
            nextAccounts[name] = { ...acct, role: ov.role };
        }
    }
    return { ...world, accounts: nextAccounts };
}

function applyActivityOverridesToPlan(
    plan: FleetPlan,
    input: {
        readonly world: WorldSnapshot;
        readonly overrides: Readonly<Record<string, AccountOverrideRecord>>;
        readonly catalog: ActivityCatalog;
        readonly demands: readonly ReturnType<DemandEngine['activeDemands']>[number][];
        readonly campaigns: readonly Campaign[];
        readonly defects: readonly ReturnType<OutcomeClassifier['quarantinedDefects']>[number][];
        readonly rateStore: RateStore;
        readonly marketQuotes: MarketQuotesMap;
        readonly minTrust: TrustTier;
        readonly allowExperimentalFallback: boolean;
        readonly ignoreSideStop?: boolean;
        readonly infraCircuitBreaker?: InfraCircuitBreakerState;
    },
): FleetPlan {
    if (Object.keys(input.overrides).length === 0) return plan;
    const sideStopped = input.world.fleetSides?.[input.world.side]?.stopped === true && !input.ignoreSideStop;
    const infraOpen = input.infraCircuitBreaker?.open === true
        && (input.infraCircuitBreaker.retryAt === undefined || input.world.at < input.infraCircuitBreaker.retryAt);
    if (sideStopped || infraOpen) return plan;

    const nextAccountPlans: Record<string, AccountPlan> = { ...plan.accountPlans };
    let usedSlots = Object.values(nextAccountPlans).filter((p) => p.steps.length > 0).length;
    let changed = false;

    for (const [name, acct] of Object.entries(input.world.accounts)) {
        if (acct.side !== input.world.side) continue;
        const ov = input.overrides[name.toLowerCase()];
        if (!ov || !ov.activityId) continue;
        if (acct.lifecycle === 'paused_owner' || acct.lifecycle === 'dead' || acct.lifecycle === 'in_trade') continue;
        if (acct.lifecycle === 'needs_logout_recovery' || acct.lifecycle === 'needs_location_recovery') continue;
        if (!canProtectedAccountLaunch(acct, input.campaigns, input.world).allowed) continue;

        const alreadySelected = (nextAccountPlans[acct.name]?.steps.length ?? 0) > 0;
        if (!alreadySelected && usedSlots >= plan.maxBots) continue;

        const act = input.catalog.get(ov.activityId);
        if (!act) continue;
        const quarantined = input.defects.some(
            (d) => d.activityId === act.id && d.quarantined && (d.expiresAt === undefined || input.world.at < d.expiresAt),
        );
        if (quarantined) continue;

        const planned = planAccount(acct, {
            world: input.world,
            activities: [act],
            demands: input.demands,
            campaigns: input.campaigns,
            defects: input.defects,
            rateStore: input.rateStore,
            marketQuotes: input.marketQuotes,
            minTrust: 'experimental',
            allowExperimentalFallback: true,
        });
        if (planned.steps.length > 0) {
            nextAccountPlans[acct.name] = planned;
            if (!alreadySelected) usedSlots += 1;
            changed = true;
            continue;
        }
        if (planned.idleReason && BLOCKED_OVERRIDE_REASON_RE.test(planned.idleReason)) {
            continue;
        }
        const syntheticScore = Math.max(1, nextAccountPlans[acct.name]?.scorePerHour ?? 100);
        const synthetic: AccountPlan = {
            account: acct.name,
            demandId: input.demands[0]?.id ?? 'override:operator',
            steps: [
                {
                    stepKind: 'work',
                    activityId: act.id,
                    demandId: input.demands[0]?.id ?? 'override:operator',
                    workerId: act.workerId,
                    batchUnits: 1,
                    estimatedTicks: Math.max(1, act.baselineRate.setupTicks),
                    expectedValuePerHour: syntheticScore,
                    config: act.config,
                },
            ],
            scorePerHour: syntheticScore,
            retentionMarginApplied: true,
        };
        nextAccountPlans[acct.name] = synthetic;
        if (!alreadySelected) usedSlots += 1;
        changed = true;
    }

    if (!changed) return plan;
    const plansWithSteps = Object.values(nextAccountPlans).filter((p) => p.steps.length > 0).length;
    return {
        ...plan,
        accountPlans: nextAccountPlans,
        selectedSlots: Math.min(plan.maxBots, plansWithSteps),
    };
}

export function runBrainCycle(opts: BrainCycleOptions = {}): BrainCycleResult {
    const root = resolve(opts.root ?? repoRoot);
    const now = opts.now ?? Date.now();
    const side = opts.side ?? mySide();
    const server = (opts.server ?? DEFAULT_LIVE_SERVER).toLowerCase();
    const persist = opts.persist !== false;
    const consumeCommands = opts.consumeCommands !== false;

    const knowledgeRoot = existsSync(join(root, 'knowledge', 'items.json')) ? root : repoRoot;
    const catalog = opts.catalog ?? defaultActivityCatalog(knowledgeRoot);
    const activitySpotById = new Map<string, string>();
    for (const act of catalog.list()) {
        if (act.spotId) activitySpotById.set(act.id, act.spotId);
    }
    const rateStore = opts.rateStore ?? createRateStore({ catalog, root, persist });
    const classifier = opts.classifier ?? new OutcomeClassifier({ rateStore, root, persist });
    const infraBreaker =
        opts.infraBreaker ??
        new InfraCircuitBreaker({ stateFile: join(liveRoot(root), 'infra-circuit-breaker.json'), now: () => now });

    const campaigns = loadCampaignManifests({ root, now });
    const missions = loadMissionManifests({ root, now });
    const demandEngine = createDemandEngine({ catalog, rateStore, campaigns, missions, root });

    const appliedCommands = consumeCommands
        ? drainOperatorCommands({ root, now, side, classifier, demandEngine })
        : [];

    const diagnostics = inspectWorldSnapshot({
        root,
        now,
        side,
        server,
        activitySpotById,
        ...(opts.fleetDir !== undefined ? { fleetDir: opts.fleetDir } : {}),
        ...(opts.activeAccounts !== undefined ? { activeAccounts: opts.activeAccounts } : {}),
        ...(opts.activeTransfers !== undefined ? { activeTransfers: opts.activeTransfers } : {}),
        marketCooldowns: classifier.activeMarketCooldowns(now),
    });

    const overrides = readAccountOverrides(root, now);
    const worldWithOutcomes = classifier.applyToSnapshot(diagnostics.snapshot, now);
    const world = applyAccountOverridesToWorld(worldWithOutcomes, overrides);

    const demands = demandEngine.activeDemands(world);
    const defects = classifier.quarantinedDefects(now);
    const infraState = combineInfraState(classifier, infraBreaker, now);
    const marketQuotes = opts.marketQuotes ?? loadMarketQuotesFromRoot(root);
    const logoutProofs = loadConfirmedLogoutProofs(diagnostics);
    const maxBots = resolveSwarmMaxBots(root, opts.maxBots);
    const minTrust: TrustTier = opts.minTrust ?? 'practice_passed';
    const allowExperimentalFallback = opts.allowExperimentalFallback ?? false;

    const scheduledPlan = scheduleFleet({
        world,
        activities: catalog.list(),
        demands,
        campaigns: demandEngine.campaigns(),
        missions: demandEngine.missions(),
        defects,
        maxBots,
        ignoreSideStop: opts.ignoreSideStop,
        retentionMarginRatio: DEFAULT_RETENTION_MARGIN_RATIO,
        rateStore,
        infraCircuitBreaker: infraState,
        marketQuotes,
        logoutProofs,
        recentTransfers: opts.recentTransfers,
        stationedHubBankers: opts.stationedHubBankers,
        minTrust,
        allowExperimentalFallback,
    });

    const fleetPlan = applyActivityOverridesToPlan(scheduledPlan, {
        world,
        overrides,
        catalog,
        demands,
        campaigns: demandEngine.campaigns(),
        defects,
        rateStore,
        marketQuotes,
        minTrust,
        allowExperimentalFallback,
        ignoreSideStop: opts.ignoreSideStop,
        infraCircuitBreaker: infraState,
    });

    const fleetState = buildFleetState(fleetPlan, {
        world,
        goals: demands,
        campaigns: demandEngine.campaigns(),
        missions: demandEngine.missions(),
        defects,
        infraCircuitBreaker: infraState,
        rateStats: rateStore.summary(),
    });

    const stateErrors = validateFleetState(fleetState);
    if (stateErrors.length > 0) {
        throw new Error(`Brain cycle produced invalid FleetState: ${stateErrors.join('; ')}`);
    }

    const dispatchedPlans: Record<string, DispatchedAccountPlan> = {};
    const activities = catalog.list();
    for (const [acctName, plan] of Object.entries(fleetPlan.accountPlans)) {
        if (plan.steps.length > 0) {
            dispatchedPlans[acctName] = dispatchAccountPlan(plan, { activities });
        }
    }

    if (persist) {
        if (fleetPlan.transferOrders.length > 0) {
            materializeBrainTransferOrders(fleetPlan.transferOrders, {
                fleetDir: diagnostics.readRoots.fleetDir,
                side,
                world,
                now,
            });
        }
        atomicJson(fleetStateFile(root), fleetState);
    }

    return {
        fleetState,
        fleetPlan,
        world,
        diagnostics,
        appliedCommands,
        dispatchedPlans,
        overrides,
    };
}

export interface RunTelemetryBaseline {
    readonly observedAt: number;
    readonly skillsXp: Readonly<Record<string, number>>;
    readonly coins: number | null;
    readonly bankTrusted: boolean;
}

const OUTCOME_UNIT_COUNTER_KEYS = [
    'output',
    'units',
    'crafted',
    'cooked',
    'caught',
    'mined',
    'chopped',
    'kills',
    'laps',
    'buried',
    'casts',
    'bought',
    'stole',
    'stolen',
] as const;

function readAccountStatusFile(root: string, account: string, server = DEFAULT_LIVE_SERVER): Record<string, any> | null {
    const lower = account.toLowerCase();
    const serverLower = server.toLowerCase();
    for (const dir of statusReadDirs(root)) {
        if (!existsSync(dir)) continue;
        const exact = join(dir, `${account}.json`);
        const candidates = existsSync(exact)
            ? [exact]
            : (() => {
                  try {
                      const match = readdirSync(dir).find((f) => f.toLowerCase() === `${lower}.json`);
                      return match ? [join(dir, match)] : [];
                  } catch {
                      return [];
              }
              })();
        for (const file of candidates) {
            const parsed = readJsonSafe(file);
            if (
                isPlainRecord(parsed)
                && typeof parsed.name === 'string'
                && parsed.name.toLowerCase() === lower
                && typeof parsed.server === 'string'
                && parsed.server.toLowerCase() === serverLower
            ) {
                return parsed;
            }
        }
    }
    return null;
}

function sumContainerCoins(raw: unknown): number {
    if (!Array.isArray(raw)) return 0;
    let total = 0;
    for (const item of raw) {
        if (!isPlainRecord(item)) continue;
        const id = item.baseId ?? item.id;
        if (id === 995 && typeof item.count === 'number' && Number.isFinite(item.count) && item.count > 0) {
            total += Math.floor(item.count);
        }
    }
    return total;
}

function readStatusSkillsXp(raw: unknown): Record<string, number> {
    const out: Record<string, number> = {};
    if (!Array.isArray(raw)) return out;
    for (const sk of raw) {
        if (!isPlainRecord(sk) || typeof sk.name !== 'string') continue;
        const xp = typeof sk.xp === 'number' && Number.isFinite(sk.xp) && sk.xp >= 0
            ? sk.xp
            : typeof sk.experience === 'number' && Number.isFinite(sk.experience) && sk.experience >= 0
                ? sk.experience
                : undefined;
        if (xp !== undefined) out[sk.name] = xp;
    }
    return out;
}

export function captureRunBaseline(
    root: string,
    account: string,
    server = DEFAULT_LIVE_SERVER,
): RunTelemetryBaseline | null {
    const status = readAccountStatusFile(root, account, server);
    if (!status) return null;
    const hasBank = Array.isArray(status.bank) && typeof status.bankAt === 'number' && Number.isFinite(status.bankAt) && status.bankAt > 0;
    const invCoins = sumContainerCoins(status.inventory);
    const bankCoins = hasBank ? sumContainerCoins(status.bank) : 0;
    return {
        observedAt: typeof status.at === 'number' && Number.isFinite(status.at) ? status.at : Date.now(),
        skillsXp: readStatusSkillsXp(status.skills),
        coins: hasBank ? invCoins + bankCoins : null,
        bankTrusted: hasBank,
    };
}

export function extractWorkerOutcomeInput(params: {
    readonly root: string;
    readonly account: string;
    readonly activityId: string;
    readonly server?: string;
    readonly startedAt: number;
    readonly finishedAt: number;
    readonly exitCode?: number | null;
    readonly endReason: string;
    readonly successful: boolean;
    readonly died?: boolean;
    readonly lastResultLine?: string;
    readonly logPath: string;
    readonly workerRelease?: string;
    readonly baseline?: RunTelemetryBaseline | null;
}): RawWorkerExitInput {
    const server = params.server ?? DEFAULT_LIVE_SERVER;
    const status = readAccountStatusFile(params.root, params.account, server);
    const statusAt = status && typeof status.at === 'number' && Number.isFinite(status.at) ? status.at : 0;
    const statusStarted = status && typeof status.started === 'number' && Number.isFinite(status.started) ? status.started : undefined;
    const matchesThisRun = Boolean(
        status
        && statusAt >= params.startedAt
        && (statusStarted === undefined || statusStarted >= params.startedAt - 15_000),
    );

    let ticksElapsed: number | undefined;
    let xpGained: Record<string, number> | undefined;
    let unitsCompleted: number | undefined;
    let coinsDelta: number | undefined;
    let pos: WorkerTile | undefined;

    if (matchesThisRun && status) {
        if (typeof status.tick === 'number' && Number.isFinite(status.tick) && status.tick > 0) {
            ticksElapsed = Math.round(status.tick);
        }
        if (params.baseline) {
            const postSkills = readStatusSkillsXp(status.skills);
            const deltas: Record<string, number> = {};
            for (const [sk, postXp] of Object.entries(postSkills)) {
                const delta = postXp - (params.baseline.skillsXp[sk] ?? 0);
                if (delta > 0) deltas[sk] = Math.round(delta);
            }
            if (Object.keys(deltas).length > 0) xpGained = deltas;
        }
        if (isPlainRecord(status.counters)) {
            for (const key of OUTCOME_UNIT_COUNTER_KEYS) {
                const v = status.counters[key];
                if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
                    unitsCompleted = v;
                    break;
                }
            }
        }
        const postHasBank = Array.isArray(status.bank)
            && typeof status.bankAt === 'number'
            && Number.isFinite(status.bankAt)
            && status.bankAt >= params.startedAt - 15_000;
        if (params.baseline?.bankTrusted && params.baseline.coins !== null && postHasBank) {
            const postCoins = sumContainerCoins(status.inventory) + sumContainerCoins(status.bank);
            coinsDelta = Math.trunc(postCoins - params.baseline.coins);
        } else if (isPlainRecord(status.counters)) {
            const c = status.counters.coins ?? status.counters.gp ?? status.counters.coinsGained;
            if (typeof c === 'number' && Number.isFinite(c)) {
                coinsDelta = Math.trunc(c);
            }
        }
        if (isWorkerTile(status.pos)) {
            pos = { x: status.pos.x, z: status.pos.z, level: status.pos.level };
        }
    }

    const stdoutParts = [
        params.lastResultLine,
        matchesThisRun && typeof status?.result === 'string' ? status.result : undefined,
    ].filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
    const stdout = stdoutParts.length > 0 ? stdoutParts.join('\n') : undefined;
    const died = params.died === true || /^died\b/i.test(params.endReason);

    return {
        activityId: params.activityId,
        account: params.account,
        exitCode: typeof params.exitCode === 'number' ? params.exitCode : undefined,
        status: params.successful ? 'ok' : 'fail',
        reason: params.endReason,
        durationMs: Math.max(0, params.finishedAt - params.startedAt),
        ...(ticksElapsed !== undefined ? { ticksElapsed } : {}),
        ...(xpGained ? { xpGained } : {}),
        ...(unitsCompleted !== undefined ? { unitsCompleted } : {}),
        ...(coinsDelta !== undefined ? { coinsDelta } : {}),
        ...(pos ? { pos } : {}),
        ...(stdout ? { stdout } : {}),
        ...(died ? { died: true } : {}),
        logPath: params.logPath,
    };
}

export function materializeBrainTransferOrders(
    orders: readonly TransferOrder[],
    opts: {
        readonly fleetDir: string;
        readonly side: string;
        readonly world: WorldSnapshot;
        readonly now: number;
    },
): { written: string[]; skipped: string[] } {
    const written: string[] = [];
    const skipped: string[] = [];
    if (orders.length === 0) return { written, skipped };

    const ordersDir = join(opts.fleetDir, 'orders');
    const receiptsDir = join(opts.fleetDir, 'receipts');
    const receiptsByOrderId = new Map<string, Receipt[]>();
    if (existsSync(receiptsDir)) {
        try {
            for (const f of readdirSync(receiptsDir)) {
                if (!f.endsWith('.json')) continue;
                const rec = readJsonSafe(join(receiptsDir, f)) as Receipt | undefined;
                if (!rec || typeof rec.id !== 'string') continue;
                const list = receiptsByOrderId.get(rec.id) ?? [];
                list.push(rec);
                receiptsByOrderId.set(rec.id, list);
            }
        } catch { /* unreadable receipts */ }
    }

    const activePairItemKeys = new Set<string>();
    if (existsSync(ordersDir)) {
        try {
            for (const f of readdirSync(ordersDir)) {
                if (!f.endsWith('.json')) continue;
                const ord = readJsonSafe(join(ordersDir, f)) as Order | undefined;
                if (!validOrder(ord) || opts.now >= ord.end) continue;
                const orderReceipts = receiptsByOrderId.get(ord.id) ?? [];
                const settlement = tradeSettlement(ord, orderReceipts, opts.now);
                if (settlement.state === 'pending' || (settlement.state === 'legacy' && orderReceipts.length === 0)) {
                    const itemKey = ord.itemId !== undefined ? String(ord.itemId) : ord.item.toLowerCase();
                    activePairItemKeys.add(`${ord.from.toLowerCase()}|${ord.to.toLowerCase()}|${itemKey}`);
                }
            }
        } catch { /* unreadable orders */ }
    }

    const itemsMap = loadItemsMap();
    for (const order of orders) {
        if (order.items.length === 0 || opts.now >= order.expiresAt) {
            skipped.push(order.id);
            continue;
        }
        const first = order.items[0]!;
        const firstItemName = first.itemName ?? itemsMap.get(first.itemId)?.name ?? `item:${first.itemId}`;
        const dedupKey = `${order.from.toLowerCase()}|${order.to.toLowerCase()}|${first.itemId}`;
        const orderFile = join(ordersDir, `${order.id}.json`);
        if (activePairItemKeys.has(dedupKey) || existsSync(orderFile)) {
            skipped.push(order.id);
            continue;
        }

        const hubSpec = HUB_BANKER_LOCATIONS[order.hub];
        const [meetFrom, meetTo] = hubSpec.meetTiles;
        const lookupSide = (name: string): string => {
            const direct = opts.world.accounts[name] ?? opts.world.accounts[name.toLowerCase()];
            if (direct) return direct.side;
            const lower = name.toLowerCase();
            return Object.values(opts.world.accounts).find((a) => a.name.toLowerCase() === lower)?.side ?? opts.side;
        };
        const fromSide = lookupSide(order.from);
        const toSide = lookupSide(order.to);
        const bothLocal = fromSide === opts.side && toSide === opts.side;
        const extra = order.items.slice(1).map((line) => ({
            item: line.itemName ?? itemsMap.get(line.itemId)?.name ?? `item:${line.itemId}`,
            count: line.count,
            itemId: line.itemId,
        }));

        const built: Order = {
            id: order.id,
            server: order.server,
            from: order.from,
            to: order.to,
            item: firstItemName,
            count: first.count,
            itemId: first.itemId,
            ...(extra.length > 0 ? { extra } : {}),
            start: opts.now,
            end: order.expiresAt,
            meet: [
                { x: meetFrom.x, z: meetFrom.z, level: meetFrom.level },
                { x: meetTo.x, z: meetTo.z, level: meetTo.level },
            ],
            ...(bothLocal ? { takerWaits: true } : {}),
        };
        if (!validOrder(built)) {
            skipped.push(order.id);
            continue;
        }
        mkdirSync(ordersDir, { recursive: true });
        atomicJson(orderFile, built);
        activePairItemKeys.add(dedupKey);
        written.push(order.id);
    }

    return { written, skipped };
}

export function recordWorkerOutcome(opts: {
    readonly root?: string;
    readonly classifier?: OutcomeClassifier;
    readonly rateStore?: RateStore;
    readonly catalog?: ActivityCatalog;
    readonly raw: RawWorkerExitInput;
    readonly now?: number;
    readonly domain?: 'practice' | 'live';
    readonly workerRelease?: string;
    readonly persist?: boolean;
}): OutcomeClassificationResult {
    const root = resolve(opts.root ?? repoRoot);
    const persist = opts.persist !== false;
    const knowledgeRoot = existsSync(join(root, 'knowledge', 'items.json')) ? root : repoRoot;
    const catalog = opts.catalog ?? defaultActivityCatalog(knowledgeRoot);
    const rateStore = opts.rateStore ?? createRateStore({ catalog, root, persist });
    const classifier = opts.classifier ?? new OutcomeClassifier({ rateStore, root, persist });
    return classifier.classifyAndApplyRaw(opts.raw, {
        now: opts.now ?? Date.now(),
        domain: opts.domain ?? 'live',
        ...(opts.workerRelease ? { workerRelease: opts.workerRelease } : {}),
    });
}
