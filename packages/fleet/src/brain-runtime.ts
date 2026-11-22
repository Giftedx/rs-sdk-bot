// Brain runtime bridge for fleet controllers: drains OperatorCommands cleanly,
// loads WorldSnapshot + DemandEngine + AccountPlanner + FleetScheduler,
// applies short-TTL account overrides, and publishes validated FleetState JSON.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mySide } from '../../core/src/fleet';
import { atomicJson } from '../../core/src/plan-lock';
import {
    fleetStateFile,
    liveRoot,
    operatorCommandsDir,
    practiceRoot,
    repoRoot,
    stopFilePaths,
} from '../../core/src/practice-paths';
import { readLogoutProof, type LogoutProof } from '../../core/src/session-lifecycle';
import type { TrustTier } from '../../workers/src/contracts';
import {
    DEFAULT_RETENTION_MARGIN_RATIO,
    OutcomeClassifier,
    adaptAccountPlan,
    buildFleetState,
    createActivityCatalog,
    createDemandEngine,
    createRateStore,
    defaultActivityCatalog,
    inspectWorldSnapshot,
    loadCampaignManifests,
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
    type AdaptedAccountPlan,
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
    readonly adaptedPlans: Readonly<Record<string, AdaptedAccountPlan>>;
    readonly overrides: Readonly<Record<string, AccountOverrideRecord>>;
}

const DEFAULT_LIVE_SERVER = 'rs-sdk-demo.fly.dev';
const SWARM_AUTO_STOP_RE =
    /^(?:swarm stopped|swarm plan removed or stopped|swarm recovery stopped|inherited recovery stopped|fleet controller lease unavailable|swarm)$/i;

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
    },
): FleetPlan {
    if (Object.keys(input.overrides).length === 0) return plan;
    const nextAccountPlans: Record<string, AccountPlan> = { ...plan.accountPlans };
    let changed = false;

    for (const [name, acct] of Object.entries(input.world.accounts)) {
        if (acct.side !== input.world.side) continue;
        const ov = input.overrides[name.toLowerCase()];
        if (!ov || !ov.activityId) continue;
        if (acct.lifecycle === 'paused_owner' || acct.lifecycle === 'dead' || acct.lifecycle === 'in_trade') continue;
        if (acct.lifecycle === 'needs_logout_recovery' || acct.lifecycle === 'needs_location_recovery') continue;
        const act = input.catalog.get(ov.activityId);
        if (!act) continue;
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
            changed = true;
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

    const adaptedPlans: Record<string, AdaptedAccountPlan> = {};
    const activities = catalog.list();
    for (const [acctName, plan] of Object.entries(fleetPlan.accountPlans)) {
        if (plan.steps.length > 0) {
            adaptedPlans[acctName] = adaptAccountPlan(plan, { activities });
        }
    }

    if (persist) {
        atomicJson(fleetStateFile(root), fleetState);
    }

    return {
        fleetState,
        fleetPlan,
        world,
        diagnostics,
        appliedCommands,
        adaptedPlans,
        overrides,
    };
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
