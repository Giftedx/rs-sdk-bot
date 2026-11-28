// Swarm process controller: drains Brain OperatorCommands, runs Brain scheduling cycles
// (publishing .practice/live/fleet-state.json), admits and supervises bounded workers,
// handles session-recovery dispatches, and maintains .practice/swarm-state.json + swarm-owner.json.
// Usage: bun packages/fleet/src/swarm.ts [plan.json] [--nonce=<id>] [--watch-id=<uuid>]
import { createHash, randomUUID } from 'node:crypto';
import {
    appendFileSync, closeSync, existsSync, mkdirSync, openSync,
    readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { spawn as spawnChild } from 'node:child_process';
import { freemem } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultActivityCatalog, createRateStore, OutcomeClassifier, type AccountActiveJob, type AccountPlan, type PlannedStep } from '../../brain/src/index';
import { DEFAULT_MARKET_COOLDOWN_MS, shopRestockCooldownMs, shopStockWaitText } from '../../brain/src/outcome-classifier';
import { fencedInAt, isStrandedPosition } from '../../brain/src/snapshot';
import { noOpRunsFile, NoOpRunGuard, statusFingerprint, type RunFingerprint } from '../../core/src/noop-runs';
import { accountClassLevels, defectBlocksAccount } from '../../brain/src/planner';
import { COOKED_FOOD_BASE_IDS, COOKED_FOOD_IDS, payoutWaiting, type DemandNear } from '../../core/src/bank-demand';
import { cargoAccountServer } from '../../core/src/cargo';
import { leanBunEnv } from '../../core/src/lean-bun-env';
import { parseStep, tokenizeStep, type Step } from '../../core/src/chain-step';
import { controllerNamed, releaseLease, renewLease, saveLaunch, takeLease } from '../../core/src/controllers';
import { FLEET_DIR, loadOwners, mySide, sideOf, type Owner } from '../../core/src/fleet';
import { acquireFleetLease, FLEET_LEASE_RENEW_MS, FLEET_LEASE_RETRY_MS } from '../../core/src/fleet-lease';
import { jobLogStart } from '../../core/src/job-log';
import { reloadDue, respawnDaemon } from '../../core/src/live-reload';
import { rotateLog } from '../../core/src/log-rotate';
import { FREE_FLOOR_GB } from '../../core/src/memory';
import { STABLE_CAUSES, unplacedCause, type RefusalCause } from '../../core/src/order-refusal';
import { atomicJson, ownerPlanPath } from '../../core/src/plan-lock';
import { hasStopFile, lifecycleReadRoots, liveRoot, operatorCommandsDir, practiceRoot, readStopFile, repoRoot, statusReadDirs, stopFilePaths } from '../../core/src/practice-paths';
import { laterProcessHolds, PID_START_SLACK_MS, processStartTimes } from '../../core/src/proc';
import {
    BOOTSTRAP_STATUS_AGE_MS, missionSignature as sharedMissionSignature, successfulEnd, withSessionAdmission,
} from '../../core/src/session-admission';
import {
    listAttempts, readLogoutProof, verifyLegacyLogout,
    type LegacyLogoutClaim, type LegacyLogoutProof, type LogoutProof,
} from '../../core/src/session-lifecycle';
import { createRecoveryDispatch } from '../../core/src/session-recovery-dispatch';
import { assertNoRecoveryLease, heldRecoveryOwners, releaseExpiredRecoveryLeases } from '../../core/src/session-recovery-permit';
import { savedProcessAlive, type ProcessStarts } from '../../core/src/session-takeover';
import { RESERVED_ACCOUNTS, SPECIALIST_BOARDS } from '../../core/src/specialist-boards';
import { renameRetry } from '../../core/src/status';
import { ownedAccounts } from '../../core/src/tradeguard';
import { assertWorkerRelease, cachedLaunchRevision, cachedReleaseFor, workerEntries } from '../../core/src/worker-release';
import { DRAIN_STOP_MS, DRAIN_STOP_TEXT, drainedFiles, pendingUpdateReader, type PendingUpdate } from './live-update/pending';
import {
    captureRunBaseline,
    drainWorkerOutcomeInbox,
    extractWorkerOutcomeInput,
    recordWorkerOutcome,
    gateHeldRunEnd,
    runBrainCycle,
    type BrainCycleResult,
    type RunTelemetryBaseline,
} from './brain-runtime';
import { dispatchAccountPlan, type DispatchedAccountPlan } from './worker-dispatch';
import { courierDeliveryWaiting, deliveryResume, foodDeficit, selectFoodSource } from './courier-admission';
import { InfraCircuitBreaker, classifyInfraFault } from './infra-circuit-breaker';
import { askWorkersToLogOut } from './worker-stop';

export type Job = {
    autopilot?: string;
    template?: string;
    account?: string;
    accounts?: string[];
    host?: boolean;
    orchestrate?: boolean;
    args?: string[];
    maxRestarts?: number;
    standingRetry?: boolean;
    standing?: boolean;
    script: string;
    role?: string;
    goal?: string;
    env?: Record<string, string>;
    envByAccount?: Record<string, Record<string, string>>;
    enabled: boolean;
    repeat?: boolean;
    note?: string;
    whenCargoFrom?: string[];
    demandNear?: { x: number; z: number; radius: number };
    whenFoodLowFrom?: string[];
    foodLowBelow?: number;
    foodSourceAccount?: string;
    foodSourceAccounts?: string[];
    sourceFoodMinimum?: number;
    activityId?: string;
    outcomeActivityId?: string;
    isMultiStepChain?: boolean;
    // The activity of each chain step in order ('' for a step with none), so a failed chain charges the step that failed.
    chainActivityIds?: string[];
    marketItemId?: number;
    marketVenue?: string;
    demandId?: string;
    // The brain plan starts with a location recovery: an ok end at a tile that is not stranded ends its stranded hold.
    locationRecovery?: boolean;
};

type Plan ={ maxBots: number; minFreeGB: number; jobs: Job[]; boundedRecovery?: boolean; boundedInspection?: boolean };

type Run = {
    pid: number;
    started: number;
    accounts: string[];
    revision: string;
    host?: boolean;
    poolId?: string;
    poolStarted?: number;
    poolAttached?: boolean;
    log: string;
    offset: number;
    activityId?: string;
    outcomeActivityId?: string;
    isMultiStepChain?: boolean;
    chainActivityIds?: string[];
    marketItemId?: number;
    marketVenue?: string;
    demandId?: string;
    workerRelease?: string;
    // The worker entry files whose release the run pinned (workerEntries): a repeat-fault hold is lifted when it changes.
    workerEntries?: string[];
    baseline?: RunTelemetryBaseline;
    // The brain plan started this run. `finite` marks a brain job with a restart limit (quest, market, chain, walk).
    brain?: boolean;
    finite?: boolean;
    locationRecovery?: boolean;
    // The account state at the start (noop-runs.ts statusFingerprint) and a short name of the job.
    fingerprint?: RunFingerprint;
    label?: string;
};

export type SavedRun = Run & { key: string };
export type ParsedJob = { key: string; accounts: string[]; host: boolean; job: Job };

export type SelectedBrainDispatch =
    | { readonly mode: 'none' }
    | { readonly mode: 'session_recovery' }
    | { readonly mode: 'fleet_trade' }
    | {
          readonly mode: 'worker';
          readonly step: Step;
          readonly displayActivityId?: string;
          readonly attributedActivityId?: string;
          readonly isMultiStepChain: boolean;
          readonly chainActivityIds?: readonly string[];
          readonly marketItemId?: number;
          readonly marketVenue?: string;
      };

// The result a run log line gives, and the last full worker RESULT line. The supervisor echoes each run's result cut
// to 200 characters ("SUPERVISE run N exit C: <result>"); when the worker printed that result in full, the full line
// keeps its tail (the chain summary, the cause). A crash result exists only in the echo.
export function resultLineOf(line: string, result: string, lastFull: string | undefined): [string, string | undefined] {
    if (!/^SUPERVISE run \d+ exit /.test(line)) return [result, result];
    return [lastFull !== undefined && lastFull.startsWith(result) ? lastFull : result, lastFull];
}

// The activity a finished run is charged to. A one-round chain stops at its first failed step and ends with
// "chain rounds=1 ok=N failed=1" (packages/core/src/chain-step.ts), so step N failed and takes the outcome, not the
// first work step after it. A failed step with no activity (a walk to the spot) charges none.
export function chainOutcomeActivity(chainActivityIds: readonly string[] | undefined, lastResultLine: string | undefined, fallback: string | undefined): string | undefined {
    if (!chainActivityIds?.length || lastResultLine === undefined) return fallback;
    const m = /\bchain rounds=1 ok=(\d+) failed=1\b/.exec(lastResultLine);
    if (!m) return fallback;
    const index = Number(m[1]);
    if (index >= chainActivityIds.length) return fallback;
    return chainActivityIds[index] || undefined;
}

export function selectBrainDispatchStep(
    dispatched: DispatchedAccountPlan,
    accountSteps: readonly PlannedStep[] = [],
): SelectedBrainDispatch {
    const first = dispatched.steps[0];
    if (!first) return { mode: 'none' };
    if (first.executionMode === 'session_recovery') return { mode: 'session_recovery' };

    const firstTradeIdx = dispatched.steps.findIndex((s) => s.executionMode === 'fleet_trade');
    if (firstTradeIdx === 0) return { mode: 'fleet_trade' };

    const execSteps = firstTradeIdx > 0 ? dispatched.steps.slice(0, firstTradeIdx) : dispatched.steps;
    if (execSteps.length === 0) return { mode: 'none' };

    const isMultiStepChain = execSteps.length > 1;
    const step: Step = isMultiStepChain
        ? {
              script: 'scripts/chain.ts',
              args: execSteps.map((s) => s.chainStepText),
              env: { ROUNDS: '1' },
          }
        : execSteps[0]!.step;

    const firstWork = accountSteps.find((s) => s.stepKind === 'work');
    const firstActivityStep = accountSteps.find((s) => 'activityId' in s && typeof s.activityId === 'string');
    const firstStepActivityId = accountSteps[0] && 'activityId' in accountSteps[0] && typeof accountSteps[0].activityId === 'string'
        ? accountSteps[0].activityId
        : undefined;
    const displayActivityId = firstWork?.stepKind === 'work'
        ? firstWork.activityId
        : (firstActivityStep && 'activityId' in firstActivityStep ? firstActivityStep.activityId : firstStepActivityId);
    const attributedActivityId = !isMultiStepChain ? firstStepActivityId : undefined;
    // dispatched.steps maps accountSteps one to one (resolveAccountWorkerPlan), and execSteps is their prefix.
    const chainActivityIds = isMultiStepChain
        ? execSteps.map((_, i) => { const s = accountSteps[i]; return s && 'activityId' in s && typeof s.activityId === 'string' ? s.activityId : ''; })
        : undefined;

    let marketItemId: number | undefined;
    let marketVenue: string | undefined;
    const marketIdx = execSteps.findIndex((s) => s.family === 'market');
    if (marketIdx >= 0) {
        const marketExec = execSteps[marketIdx]!;
        const marketRoute = dispatched.route?.steps?.[marketIdx];
        const rawItemId = marketRoute?.config?.itemId ?? Number(marketExec.step.env?.ITEM_ID);
        if (Number.isSafeInteger(rawItemId)) {
            const mode = marketRoute?.config?.mode ?? marketExec.step.args[0];
            const shopId = marketRoute?.config?.shopId ?? marketExec.step.args[1];
            if (mode === 'shop-buy' && typeof shopId === 'string' && shopId.length > 0) {
                marketItemId = Number(rawItemId);
                marketVenue = `shop:${shopId}`;
            } else if (mode === 'ge-buy') {
                marketItemId = Number(rawItemId);
                marketVenue = 'ge';
            }
        }
    }

    return {
        mode: 'worker',
        step,
        ...(displayActivityId ? { displayActivityId } : {}),
        ...(attributedActivityId ? { attributedActivityId } : {}),
        isMultiStepChain,
        ...(chainActivityIds ? { chainActivityIds } : {}),
        ...(marketItemId !== undefined ? { marketItemId } : {}),
        ...(marketVenue ? { marketVenue } : {}),
    };
}

// The swarm job of one brain plan: the dispatch mode, and for a worker step the job that the tick runs.
export function brainJobFor(
    account: string,
    dispatched: DispatchedAccountPlan,
    accountSteps: readonly PlannedStep[],
    role?: string,
): { selected: SelectedBrainDispatch; job?: Job } {
    const selected = selectBrainDispatchStep(dispatched, accountSteps);
    if (selected.mode !== 'worker') return { selected };
    const isFiniteBrainJob = selected.isMultiStepChain
        || selected.step.script === 'scripts/aio-market.ts'
        || selected.step.script === 'scripts/aio-quester.ts'
        || (selected.step.script === 'scripts/aio-logistics.ts' && selected.step.args[0] === 'walk-to');
    const outcomeActivityId = selected.displayActivityId ?? selected.attributedActivityId;
    return {
        selected,
        job: {
            account,
            script: selected.step.script,
            args: [...selected.step.args],
            env: {
                ...selected.step.env,
                ...(selected.displayActivityId ? { BRAIN_ACTIVITY_ID: selected.displayActivityId } : {}),
                ...(dispatched.demandId ? { BRAIN_DEMAND_ID: dispatched.demandId } : {}),
            },
            enabled: true,
            repeat: true,
            ...(isFiniteBrainJob ? { maxRestarts: 2 } : {}),
            role,
            goal: dispatched.demandId ?? selected.displayActivityId,
            ...(selected.attributedActivityId ? { activityId: selected.attributedActivityId } : {}),
            ...(outcomeActivityId ? { outcomeActivityId } : {}),
            ...(selected.isMultiStepChain ? { isMultiStepChain: true } : {}),
            ...(selected.chainActivityIds ? { chainActivityIds: [...selected.chainActivityIds] } : {}),
            ...(selected.marketItemId !== undefined ? { marketItemId: selected.marketItemId } : {}),
            ...(selected.marketVenue ? { marketVenue: selected.marketVenue } : {}),
            ...(dispatched.demandId ? { demandId: dispatched.demandId } : {}),
            ...(isLocationRecoveryStep(accountSteps[0]) ? { locationRecovery: true } : {}),
        },
    };
}

const isLocationRecoveryStep = (s: PlannedStep | undefined): boolean => s?.stepKind === 'recover' && s.recoveryKind === 'location';

const isPlainTile = (v: unknown): v is { x: number; z: number; level: number } =>
    typeof v === 'object' && v !== null && [(v as any).x, (v as any).z, (v as any).level].every(Number.isFinite);

// The tile where a run ended: the "at=x,z,level" of its RESULT line (logistics walk-to and others).
export function resultEndTile(line: string | undefined): { x: number; z: number; level: number } | undefined {
    const m = line ? /\bat=(\d+),(\d+),(\d+)\b/.exec(line) : null;
    return m ? { x: Number(m[1]), z: Number(m[2]), level: Number(m[3]) } : undefined;
}

// True when a location recovery run ended ok at a tile where the account is not stranded.
export function locationRecoveryArrived(endReason: string, tile: { x: number; z: number; level: number } | undefined): boolean {
    return successfulEnd(endReason) && !!tile && !isStrandedPosition(tile) && !fencedInAt(tile);
}

export const BRAIN_RECOVERY_WAIT = 'waiting: standalone session recovery';

// The reason the swarm will not start the job of a brain plan, or undefined when it will. startable() rules on the
// job that the tick builds from the plan, against the account's end record: the same job as an ended run stays
// ended, and a changed job starts. The standalone recovery queue starts no swarm job. The planner gives such a plan
// no slot (FleetSchedulerInput.heldPlan). The planner recomputes a market order's quantity each pass, so a changed
// signature alone does not start a buy at the venue whose empty stock ended the last run: that plan waits until the
// venue's stock-out hold passes.
export function brainPlanHold(
    built: { selected: SelectedBrainDispatch; job?: Job },
    ended: Map<string, EndRecord>,
    statusAge: (a: string) => number,
    statusStarted?: (a: string) => number | undefined,
    now = Date.now(),
    releaseOf?: (job: Job) => string | undefined,
    noOpHold?: (account: string, signature: string) => string | undefined,
): string | undefined {
    if (built.selected.mode === 'session_recovery') return BRAIN_RECOVERY_WAIT;
    if (!built.job) return undefined;
    const p = parseJob(built.job);
    if ('error' in p || p.accounts.length !== 1) return undefined;
    const why = startable(p.accounts, p.job.repeat, ended, statusAge, statusStarted, missionSignature(p.job), undefined, () => true, releaseOf?.(p.job)).blocked[p.accounts[0]!];
    if (why?.startsWith('ended: ')) return why;
    const noOp = noOpHold?.(p.accounts[0]!, missionSignature(p.job));
    if (noOp) return noOp;
    const { selected } = built;
    if (selected.mode !== 'worker' || selected.marketItemId === undefined || !selected.marketVenue) return undefined;
    const end = endedMapByLower(ended).get(p.accounts[0]!.toLowerCase())?.[1];
    if (!end || end.marketItemId !== selected.marketItemId || end.marketVenue !== selected.marketVenue) return undefined;
    const until = end.at + stockOutHoldMs(selected.marketItemId, selected.marketVenue);
    const cause = end.marketRefusal ? `refused item ${selected.marketItemId} (${end.marketRefusal})` : `out of stock for item ${selected.marketItemId}`;
    return now < until ? `ended: ${selected.marketVenue} ${cause} until ${new Date(until).toISOString()}` : undefined;
}

// A campaign is ready only with a hiscore margin under 1 h old (brain/src/contracts.ts MAX_CAMPAIGN_HISCORE_AGE_MS).
// The swarm starts a board refresh at most each 10 min, and the refresh fetches only when the snapshot is 50 min old.
// It writes the live path, not the one that tools/specialist-launch.ts writes per account.
export const HISCORE_REFRESH_INTERVAL_MS = 10 * 60_000;
export const HISCORE_SNAPSHOT_MAX_AGE_MS = 50 * 60_000;

export function hiscoreRefreshDue(o: { now: number; lastAt: number; running: boolean }): boolean {
    return !o.running && o.now - o.lastAt >= HISCORE_REFRESH_INTERVAL_MS;
}

export function hiscoreRefreshCommand(root: string): { cmd: string[]; out: string; log: string } {
    const dir = join(liveRoot(root), 'specialist-launch');
    const out = join(dir, 'hiscores.json');
    return {
        cmd: [process.execPath, join(root, 'packages', 'planner', 'src', 'scout-cli.ts'), `--out=${out}`, `--max-age-ms=${HISCORE_SNAPSHOT_MAX_AGE_MS}`],
        out,
        log: join(dir, 'scout-refresh.log'),
    };
}

// Starts the refresh child and does not wait for it. onEnd runs once when the child exits or fails to start.
export function startHiscoreRefresh(root: string, onEnd: () => void, spawnFn: typeof spawnChild = spawnChild): void {
    const { cmd, log } = hiscoreRefreshCommand(root);
    mkdirSync(join(log, '..'), { recursive: true });
    rotateLog(log);
    const fd = openSync(log, 'a');
    let ended = false;
    const end = () => { if (!ended) { ended = true; onEnd(); } };
    try {
        const child = spawnFn(cmd[0]!, ['--smol', ...cmd.slice(1)], { cwd: root, env: leanBunEnv(process.env), windowsHide: true, stdio: ['ignore', fd, fd] });
        child.on('exit', end);
        child.on('error', end);
    } catch (error) {
        end();
        throw error;
    } finally { closeSync(fd); }
}

export { PID_START_SLACK_MS };

export function adoptedRunAlive(
    run: { pid: number; started: number },
    alive: (pid: number) => boolean,
    starts: ReadonlyMap<number, number> | null,
): boolean {
    return alive(run.pid) && !laterProcessHolds(run.pid, run.started, starts);
}

const ACCOUNT = /^[A-Za-z0-9_ -]{1,12}$/;
// Measured standalone/pool process base is ~116-130 MB private (~76 MB WS); 0.25 GiB (~256 MB) gives ~2x headroom.
export const START_BUDGET_GB = 0.25;
// Measured marginal live session cost inside a shared host pool is ~1.4 MB private (~0.93 MB WS / ~0.53 MB heap);
// 0.025 GiB (~25.6 MB) leaves >18x headroom while keeping the 4 GiB FREE_FLOOR_GB inviolate.
export const POOL_ATTACH_BUDGET_GB = 0.025;
export const POOL_MAX_BOTS = 16;
export const POOL_MAX_LAUNCHES = 128;
export const POOL_IDLE_EXIT_MS = 30_000;
// Stop attaching new bots halfway through the pool's idle exit window so a start command cannot race pool shutdown.
export const POOL_IDLE_DRAIN_MS = POOL_IDLE_EXIT_MS / 2;
// Bound new bot launches per 2 s swarm tick so cold-start and post-reload bursts ramp smoothly without stampeding pools or Git claims.
export const MAX_STARTS_PER_TICK = 3;
export const burstStartAllowed = (startedThisTick: number, cap = MAX_STARTS_PER_TICK): boolean => startedThisTick < cap;
const START_RESERVE_MS = 30_000;

export function activeExternalLive(statuses: readonly any[], managed: readonly string[], now: number): string[] {
    const ours = new Set(managed.map(a => a.toLowerCase()));
    const active = new Map<string, string>();
    for (const s of statuses) {
        if (
            !s || typeof s.name !== 'string' || !ACCOUNT.test(s.name) || s.server !== 'rs-sdk-demo.fly.dev'
            || !Number.isFinite(s.at) || now - s.at < 0 || now - s.at >= 30_000 || s.result
        ) continue;
        const key = s.name.toLowerCase();
        if (!ours.has(key) && !active.has(key)) active.set(key, s.name);
    }
    return [...active.values()];
}

export function ownedPayoutWaiting(
    statuses: readonly any[],
    near?: DemandNear,
    owned: ReadonlySet<string> = ownedAccounts('rs-sdk-demo.fly.dev'),
    check: typeof payoutWaiting = payoutWaiting,
    now = Date.now(),
): boolean {
    const names = activeExternalLive(statuses, [], now).filter(name => owned.has(name.toLowerCase()));
    return names.length > 0 && check(names, near);
}

function foodCourierRoute(step: { script: string; args?: readonly string[] }, depth = 0): boolean {
    if (depth > 8) return false;
    const script = step.script.replace(/\\/g, '/').replace(/^\.\//, ''), args = step.args ?? [];
    if (script === 'scripts/chain.ts') return args.map(parseStep).some(s => foodCourierRoute(s, depth + 1));
    if (script === 'scripts/aio-logistics.ts') return args[0]?.toLowerCase().replace(/^--role=/, '') === 'food-courier';
    if (script !== 'scripts/aio.ts') return false;
    const category = args[0]?.toLowerCase().replace(/^--category=/, '');
    if (category === 'logistics') return foodCourierRoute({ script: 'scripts/aio-logistics.ts', args: args.slice(1) }, depth + 1);
    if (category !== 'pipeline') return false;
    const steps = args.slice(1).map(text => {
        const [head, ...rest] = tokenizeStep(text);
        return { script: 'scripts/aio.ts', args: [...(head?.split(':') ?? []), ...rest] };
    });
    return steps.some(s => foodCourierRoute(s, depth + 1));
}

export function foodSupplyServer(job: Job, serverFor: (account: string) => string = cargoAccountServer): string | null {
    const parsed = parseJob(job);
    if ('error' in parsed || job.orchestrate) return null;
    try {
        const servers = parsed.accounts.map(serverFor);
        return servers.length && servers.every(s => typeof s === 'string' && s.length > 0 && s === servers[0]) ? servers[0]! : null;
    } catch {
        return null;
    }
}

export function foodSupplyDemand(
    job: Job,
    statuses: readonly any[],
    owned?: ReadonlySet<string>,
    now = Date.now(),
    endpoint?: string | null,
): boolean {
    try { if (!foodCourierRoute(job)) return false; } catch { return false; }
    if (!Array.isArray(job.whenFoodLowFrom) || job.whenFoodLowFrom.length === 0 || job.orchestrate) return false;
    const parsed = parseJob(job);
    if ('error' in parsed) return false;
    const server = endpoint === undefined ? (owned ? 'rs-sdk-demo.fly.dev' : foodSupplyServer(job)) : endpoint;
    if (!server) return false;
    const ownership = owned ?? ownedAccounts(server);
    const below = job.foodLowBelow ?? 80, minimum = job.sourceFoodMinimum ?? 100;
    const sources = job.foodSourceAccounts ?? (job.foodSourceAccount ? [job.foodSourceAccount] : []);
    if (
        !Number.isSafeInteger(below) || below < 1 || !Number.isSafeInteger(minimum) || minimum < 1 || !Array.isArray(sources) || !sources.length
        || sources.some(n => typeof n !== 'string' || !ACCOUNT.test(n) || !ownership.has(n.toLowerCase()))
    ) return false;
    const validRows = (rows: any) => Array.isArray(rows) && rows.every(i => Number.isSafeInteger(i?.id) && i.id >= 0 && Number.isSafeInteger(i.count) && i.count > 0);
    const source = selectFoodSource(sources, statuses, ownership, now, minimum, server);
    const allReady = parsed.accounts.every(account => {
        const courier = ownership.has(account.toLowerCase())
            ? statuses.find(s => typeof s?.name === 'string' && s.name.toLowerCase() === account.toLowerCase() && s.server === server)
            : undefined;
        const held = courier && Number.isFinite(courier.at) && courier.at > 0 && courier.at <= now && validRows(courier.inventory)
            ? courier.inventory.reduce((n: number, i: any) => n + (COOKED_FOOD_IDS.has(i.id) && !COOKED_FOOD_BASE_IDS.has(i.id) ? i.count : 0), 0)
            : 0;
        return !!source || !!deliveryResume(courier?.pos ? { worldX: courier.pos.x, worldZ: courier.pos.z, level: courier.pos.level } : undefined, held, job.whenFoodLowFrom!.length);
    });
    if (!allReady) return false;
    return job.whenFoodLowFrom.some(name => {
        if (typeof name !== 'string' || !ACCOUNT.test(name) || !ownership.has(name.toLowerCase())) return false;
        const farm = statuses.find(s => typeof s?.name === 'string' && s.name.toLowerCase() === name.toLowerCase() && s.server === server);
        const deficit = foodDeficit(name, farm, now, below, server);
        return deficit !== undefined && deficit > 0;
    });
}

export function pendingStartupCount(runs: readonly { started: number; accounts: readonly string[]; host?: boolean; poolAttached?: boolean }[], now: number): number {
    let pending = 0;
    const seen = new Set<string>();
    const attachUnits = POOL_ATTACH_BUDGET_GB / START_BUDGET_GB;
    for (const r of runs) {
        if (now - r.started >= 0 && now - r.started < START_RESERVE_MS) {
            if (r.poolAttached) pending += attachUnits;
            else if (r.host) pending += 1;
            else for (const a of r.accounts) if (!seen.has(a.toLowerCase())) { seen.add(a.toLowerCase()); pending += 1; }
        }
    }
    return pending;
}

export function startReserve(p: { host: boolean; job: Job }, accounts: number, attachingToPool = false): number {
    if (attachingToPool) return POOL_ATTACH_BUDGET_GB / START_BUDGET_GB;
    return p.host || p.job.orchestrate ? 1 : accounts;
}

export function admissionDecision(v: {
    running: number;
    external: number;
    starting: number;
    startingReserve?: number;
    pending: number;
    freeGB: number;
    minFreeGB: number;
    maxBots: number;
}) {
    const floorGB = Math.max(FREE_FLOOR_GB, v.minFreeGB);
    const reserveGB = START_BUDGET_GB * (v.pending + (v.startingReserve ?? v.starting));
    const projectedFreeGB = v.freeGB - reserveGB;
    const reason = Object.values(v).some(n => !Number.isFinite(n) || n < 0) ? 'invalid'
        : v.running + v.external + v.starting > v.maxBots ? 'maxBots'
        : projectedFreeGB < floorGB ? 'memory' : null;
    return { allowed: reason === null, reason, floorGB, reserveGB, projectedFreeGB };
}

export function admitRecovery(
    v: { account: string; active: readonly string[]; running: number; external: number; pending: number; freeGB: number; minFreeGB: number; maxBots: number },
    release: () => void = () => { assertWorkerRelease(); },
) {
    if (v.active.some(a => a.toLowerCase() === v.account.toLowerCase())) throw Error('recovery account still active');
    const decision = admissionDecision({ running: v.running, external: v.external, pending: v.pending, starting: 1, startingReserve: 1, freeGB: v.freeGB, minFreeGB: v.minFreeGB, maxBots: v.maxBots });
    if (!decision.allowed) throw Error('recovery admission waiting: ' + decision.reason);
    release();
}

// The controller's own release pin, which admitRecovery and the inherited recoveries read (assertWorkerRelease): the
// launch source it starts on. A restart from the launch record carries none (LAUNCH_ENV keeps no pin: a saved one goes
// stale), and a live-reload respawn carries the old one, so the controller always pins the source it loaded. A later
// source change still pauses its recovery admissions ('release source changed').
export function pinControllerRelease(env: Record<string, string | undefined>, source: string): void {
    env.WORKER_RELEASE = source;
    delete env.WORKER_ENTRY;
}

export const RECOVERY_SLOT_HOLD_MS = 30_000;
export const RECOVERY_SLOT_WAIT_MS = 600_000;
export const RECOVERY_LEASE_MAX_MS = RECOVERY_SLOT_WAIT_MS + 300_000;
export type RecoverySlot = { until: number; account?: string };

export function recoveryLeaseHeld(
    file: string,
    now: number,
    alive: (pid: number) => boolean = pid => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } },
    starts: ProcessStarts = processStartTimes,
): boolean {
    let mtimeMs: number;
    try { mtimeMs = statSync(file).mtimeMs; } catch { return false; }
    if (now - mtimeMs >= RECOVERY_LEASE_MAX_MS) return false;
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (Number.isSafeInteger(parsed?.pid) && parsed.pid > 0) {
            const at = Number.isFinite(parsed.at) ? parsed.at : mtimeMs;
            return savedProcessAlive(parsed.pid, at, starts, alive);
        }
    } catch {
        // Non-JSON lease content falls back to mtime window.
    }
    return true;
}

export function recoverySlot(slot: RecoverySlot, v: { leaseHeld: boolean; recovering?: string; started: readonly string[]; now: number }): RecoverySlot {
    const prior = v.recovering ?? slot.account;
    const jobStarted = prior !== undefined && !v.recovering && v.started.some(a => a.toLowerCase() === prior.toLowerCase());
    if (v.leaseHeld || v.recovering) return { until: v.now + RECOVERY_SLOT_HOLD_MS, ...(prior !== undefined && !jobStarted ? { account: prior } : {}) };
    return slot.until > v.now && !jobStarted ? slot : { until: 0 };
}

export function recoverySlotReserve(slot: RecoverySlot, v: { recovering: boolean; accounts: readonly string[]; now: number }): number {
    if (v.recovering || slot.until <= v.now) return 0;
    return slot.account !== undefined && v.accounts.some(a => a.toLowerCase() === slot.account!.toLowerCase()) ? 0 : 1;
}

export function isReservation(job: Job): boolean {
    return !!job && typeof job.account === 'string' && !job.accounts && !job.script;
}

export function otherSideAccount(
    accounts: readonly string[],
    side: string,
    owners: ReadonlyMap<string, Owner>,
): { account: string; side: string } | undefined {
    for (const a of accounts) {
        const s = sideOf(a, owners as Map<string, Owner>);
        if (s !== side) return { account: a, side: s };
    }
    return undefined;
}

export function parseJob(job: Job): ParsedJob | { error: string } {
    if (!job || typeof job.script !== 'string' || !job.script) return { error: 'no script' };
    if (job.orchestrate !== undefined && typeof job.orchestrate !== 'boolean') return { error: 'bad orchestrate mode' };
    if (job.args !== undefined && (!Array.isArray(job.args) || job.args.some(a => typeof a !== 'string'))) return { error: 'args must be strings' };
    if (job.maxRestarts !== undefined && (!Number.isSafeInteger(job.maxRestarts) || job.maxRestarts < 0)) return { error: 'bad maxRestarts' };
    if (job.standingRetry !== undefined && typeof job.standingRetry !== 'boolean') return { error: 'bad standingRetry' };
    if (job.orchestrate) {
        if (job.host) return { error: 'orchestrate cannot use host mode' };
        if (job.account !== undefined) return { error: 'orchestrator has both account and accounts' };
        const list = job.accounts;
        if (!Array.isArray(list) || list.length < 2) return { error: 'orchestrator needs at least two accounts' };
        if (list.some(a => typeof a !== 'string' || !ACCOUNT.test(a))) return { error: 'bad account name in accounts' };
        if (new Set(list.map(a => a.toLowerCase())).size !== list.length) return { error: 'account listed twice' };
        return { key: `order:${list.join('+')}`, accounts: [...list], host: false, job };
    }
    if (job.host) {
        const list = job.accounts;
        if (!Array.isArray(list) || list.length === 0) return { error: 'host job needs a non-empty "accounts" list' };
        if (job.account) return { error: 'host job has both "account" and "accounts"' };
        if (list.some(a => typeof a !== 'string' || !ACCOUNT.test(a))) return { error: 'bad account name in "accounts"' };
        if (new Set(list.map(a => a.toLowerCase())).size !== list.length) return { error: 'account listed twice' };
        const per = job.envByAccount;
        if (per !== undefined) {
            if (typeof per !== 'object' || per === null || Array.isArray(per)) return { error: '"envByAccount" must map an account to its env' };
            for (const [a, e] of Object.entries(per)) {
                if (!list.includes(a)) return { error: `envByAccount names ${a}, which is not in "accounts"` };
                if (typeof e !== 'object' || e === null || Array.isArray(e) || Object.values(e).some(v => typeof v !== 'string')) return { error: `envByAccount for ${a} must map KEY to a string` };
            }
        }
        return { key: `host:${list.join('+')}`, accounts: [...list], host: true, job };
    }
    if (job.accounts) return { error: '"accounts" needs "host": true' };
    if (job.envByAccount) return { error: '"envByAccount" needs "host": true' };
    if (typeof job.account !== 'string' || !ACCOUNT.test(job.account)) return { error: 'no account' };
    return { key: job.account, accounts: [job.account], host: false, job };
}

export const botCountEnv = (accounts: readonly string[]) => ({ SWARM_BOTS: String(accounts.length) });

// Delegate pathfinding to the shared route-service for swarm workers unless ROUTE_SERVICE=0 is set explicitly.
export function workerRouteServiceEnv(
    baseEnv: Record<string, string | undefined> = process.env,
    overrideEnv?: Record<string, string | undefined>,
): { ROUTE_SERVICE: '0' | '1' } {
    const raw = overrideEnv?.ROUTE_SERVICE !== undefined ? overrideEnv.ROUTE_SERVICE : baseEnv.ROUTE_SERVICE;
    return { ROUTE_SERVICE: raw === '0' ? '0' : '1' };
}

export function writeStateFile(
    file: string,
    text: string,
    write: (path: string, data: string) => void = writeFileSync,
    rename: (from: string, to: string) => void = renameRetry,
): void {
    const temporary = `${file}.tmp-${process.pid}`;
    try { write(temporary, text); rename(temporary, file); } catch (error) { rmSync(temporary, { force: true }); throw error; }
}

export function supervisorCommand(parsed: ParsedJob, accounts: string[]): string[] {
    const job = parsed.job, maxRestarts = String(job.maxRestarts ?? (job.orchestrate ? 0 : 20));
    return parsed.host
        ? [
            'bun', '--smol', 'packages/practice/src/supervise-host.ts', job.script, maxRestarts, ...accounts,
            ...(job.args ?? []).flatMap(a => ['--arg', a]),
            ...accounts.flatMap(a => Object.entries(job.envByAccount?.[a] ?? {}).flatMap(([k, v]) => ['--env', a, `${k}=${v}`])),
        ]
        : ['bun', '--smol', 'packages/practice/src/supervise.ts', accounts[0]!, job.script, maxRestarts, ...(job.orchestrate ? accounts.slice(1) : []), ...(job.args ?? [])];
}

export function hostPoolEnabled(env: Record<string, string | undefined> = process.env): boolean {
    return env.SWARM_HOST_POOL !== '0';
}

// Single-account non-standing, non-orchestrate, non-PvP, non-reserved jobs share dynamic host pools so the fleet avoids
// per-bot supervise.ts processes and duplicate Bun/WebClient/LocIndex/SDK runtimes.
export function canUseHostPool(parsed: ParsedJob, env: Record<string, string | undefined> = process.env): boolean {
    if (!hostPoolEnabled(env)) return false;
    if (parsed.host || parsed.job.orchestrate || parsed.job.standing || parsed.accounts.length !== 1) return false;
    const account = parsed.accounts[0]!.toLowerCase();
    if (PROTECTED_ACCOUNTS.includes(account) || Object.hasOwn(SPECIALIST_BOARDS, account)) return false;
    if (PVP_DEATH_SCRIPTS.has(scriptKey(parsed.job.script))) return false;
    return true;
}

export function poolCommand(poolId: string, source: string, opts: { maxBots?: number; maxLaunches?: number; idleExitMs?: number } = {}): string[] {
    return [
        'bun', '--smol', 'packages/practice/src/supervise-host.ts',
        '--pool', poolId,
        '--max-bots', String(opts.maxBots ?? POOL_MAX_BOTS),
        '--max-launches', String(opts.maxLaunches ?? POOL_MAX_LAUNCHES),
        '--idle-exit-ms', String(opts.idleExitMs ?? POOL_IDLE_EXIT_MS),
        ...(source ? ['--source', source] : []),
    ];
}

export type HostPoolSlot = {
    id: string;
    pid: number;
    started: number;
    source: string;
    launches: number;
    draining: boolean;
    idleSince?: number;
};

// Tracks how long a pool has held zero active bots and returns true once it enters the pre-exit drain margin.
export function poolIdleExpired(pool: HostPoolSlot, active: number, now: number, drainMs = POOL_IDLE_DRAIN_MS): boolean {
    if (active > 0) {
        pool.idleSince = undefined;
        return false;
    }
    if (pool.idleSince === undefined) {
        pool.idleSince = now;
        return false;
    }
    return now - pool.idleSince >= drainMs;
}

// Picks the fullest eligible live pool matching `source` so active bots pack into fewer processes and idle pools drain out.
export function selectHostPool(
    pools: Iterable<HostPoolSlot>,
    activeCount: (poolId: string) => number,
    alive: (pool: HostPoolSlot) => boolean,
    source: string,
    maxBots = POOL_MAX_BOTS,
    maxLaunches = POOL_MAX_LAUNCHES,
    now = Date.now(),
    idleDrainMs = POOL_IDLE_DRAIN_MS,
): HostPoolSlot | null {
    let best: HostPoolSlot | null = null;
    let bestActive = -1;
    for (const pool of pools) {
        if (pool.draining || pool.source !== source || pool.launches >= maxLaunches || !alive(pool)) continue;
        const n = activeCount(pool.id);
        if (n >= maxBots) continue;
        if (n === 0 && pool.idleSince !== undefined && now - pool.idleSince >= idleDrainMs) continue;
        if (n > bestActive) {
            best = pool;
            bestActive = n;
        }
    }
    return best;
}

function swarmPoolDir(root: string, poolId: string): string {
    return join(root, '.practice', 'host-pools', poolId);
}

function sendPoolCommand(root: string, poolId: string, cmd: Record<string, unknown>): void {
    const inbox = join(swarmPoolDir(root, poolId), 'inbox');
    mkdirSync(inbox, { recursive: true });
    const id = String(cmd.id ?? randomUUID()).replace(/[^A-Za-z0-9_.-]/g, '_');
    const file = join(inbox, `${String(Date.now()).padStart(13, '0')}-${id}.json`);
    writeStateFile(file, JSON.stringify(cmd));
}

export function completeJobCandidates(
    parsed: ParsedJob,
    selection: { start: string[]; blocked: Record<string, string> },
): { start: string[]; blocked: Record<string, string> } {
    if (!parsed.job.orchestrate || selection.start.length === parsed.accounts.length) return selection;
    const blocked = { ...selection.blocked };
    for (const name of selection.start) blocked[name] = 'waiting: all orchestrator participants required';
    return { start: [], blocked };
}

export function missionSignature(job: Job): string {
    return sharedMissionSignature(job);
}

function endedMapByLower(ended: ReadonlyMap<string, EndRecord>): Map<string, [string, EndRecord]> {
    const byLower = new Map<string, [string, EndRecord]>();
    for (const [name, end] of ended) byLower.set(name.toLowerCase(), [name, end]);
    return byLower;
}

export function foreignRun(
    planned: readonly ParsedJob[],
    p: ParsedJob,
    run: { revision: string },
    signatures?: ReadonlyMap<ParsedJob, string>,
): boolean {
    const sigOf = (item: ParsedJob) => signatures?.get(item) ?? missionSignature(item.job);
    if (run.revision === sigOf(p)) return false;
    return planned.some(q => q !== p && sigOf(q) === run.revision);
}

export function overlappingRun<T extends { accounts: readonly string[] }>(runs: Iterable<T>, accounts: readonly string[]): T | undefined {
    const names = new Set<string>();
    for (let i = 0; i < accounts.length; i++) names.add(accounts[i]!.toLowerCase());
    for (const r of runs) {
        for (let i = 0; i < r.accounts.length; i++) {
            if (names.has(r.accounts[i]!.toLowerCase())) return r;
        }
    }
    return undefined;
}

// marketItemId and marketVenue name the shop or GE item of a run that ended because the venue had no stock, or because
// the buy refused to start for a cause that the next login meets again (marketRefusal).
// `release`: the worker release of the run that ended (cachedReleaseFor of its entries). startable() retries a held
// end once after the job's release changes.
export type EndRecord = { at: number; reason: string; revision?: string; release?: string; marketItemId?: number; marketVenue?: string; marketRefusal?: RefusalCause };

// The same out-of-stock text that sets a venue cooldown (brain/src/outcome-classifier.ts MARKET_UNAVAILABLE_RE and
// SHOP_STOCK_WAIT_RE, brain-runtime.ts extractWorkerOutcomeInput).
const STOCK_OUT_RE = /market.?unavailable|out of stock|no ge offers|ge.*unavailable|shop.*empty|buy limit|no sellers|not sold here|\bboughtTotal=0\b[\s\S]*\bstop=stock-wait\b|\bstop=stock-wait\b[\s\S]*\bboughtTotal=0\b/i;

// The market venue of a failed run that the venue's empty stock ended, or that a stable buy refusal ended, or of a
// shop run that ended "done" with nothing bought, for its end record.
export function stockOutEnd(
    run: { marketItemId?: number; marketVenue?: string },
    reason: string,
    lastResultLine: string | undefined,
): { marketItemId: number; marketVenue: string; marketRefusal?: RefusalCause } | undefined {
    if (run.marketItemId === undefined || !run.marketVenue || /^died\b/.test(reason)) return undefined;
    // A shop run that bought nothing ends "done": its venue still failed.
    if (successfulEnd(reason)) {
        return lastResultLine !== undefined && shopStockWaitText(lastResultLine) ? { marketItemId: run.marketItemId, marketVenue: run.marketVenue } : undefined;
    }
    const refusal = lastResultLine !== undefined ? unplacedCause(lastResultLine) : undefined;
    if (refusal !== undefined && STABLE_CAUSES.includes(refusal)) return { marketItemId: run.marketItemId, marketVenue: run.marketVenue, marketRefusal: refusal };
    return STOCK_OUT_RE.test(`${reason}\n${lastResultLine ?? ''}`) ? { marketItemId: run.marketItemId, marketVenue: run.marketVenue } : undefined;
}

// How long a venue stays empty after a stock-out end: the venue cooldown, or the shop's restock time when longer.
export function stockOutHoldMs(itemId: number, venue: string): number {
    return Math.max(DEFAULT_MARKET_COOLDOWN_MS, shopRestockCooldownMs(itemId, venue));
}

export function persistentEnd(reason: string): boolean {
    return /^(?:died|blocked|gave-up)(?:\b|$)/.test(reason);
}

export const SWARM_STOP = {
    removed: 'swarm plan removed or stopped',
    all: 'swarm stopped',
    job: 'swarm',
    recovery: 'swarm recovery stopped',
    inherited: 'inherited recovery stopped',
    lease: 'fleet controller lease unavailable',
    drain: DRAIN_STOP_TEXT,
} as const;

export const BRAIN_RUN_MIN_MS = 10 * 60_000;
export const BRAIN_DROP_CYCLES = 2;

// The reason the swarm keeps a brain-started run that the current brain plan gives no worker job, or undefined when
// the swarm stops it. A brain cycle can empty a running account's plan for one cycle (slot pressure, saturated demand,
// a spot cap, a re-plan with other acquire sources); a stop then throws away the work done. A finite job runs to its
// end. A repeating job is stopped only after it ran BRAIN_RUN_MIN_MS and BRAIN_DROP_CYCLES brain cycles in a row
// dropped it. A stop of all runs, a disabled brain, a hand job, an open hold, an end record, a session recovery or a
// fleet trade for the account, or an idle reason that brainSoftIdle refuses (death, owner pause, trade, protection, a
// system hold) stops the run as before.
export const BRAIN_SOFT_IDLE: ReadonlySet<string> = new Set([
    'max_bots_limit', 'spot_capacity_full', 'demand_saturated', 'idle', 'no_matching_demand_or_activity', 'missing_food_supply',
]);
// Planner blocker reasons: the re-plan of a running account excludes hub_banker supply, so it can fail to rebuild the
// plan that started the run. These reasons say nothing about the safety of the running worker. A combat floor
// (combat_survivability:*) is the blocker of the last candidate the re-plan tried, often a fight the account does not
// run; the running worker keeps its own eat and flee guards. A location recovery run is never rebuilt (a running
// account is no longer in needs_location_recovery), so its re-plan always ends at such a blocker.
const BRAIN_BLOCKER_PREFIXES = [
    'unresolvable_supply:', 'missing_coins:', 'missing_quest_unlock:', 'quest_unlock_blocked:', 'combat_survivability:',
    'missing_skill_unlock:', 'unlock_inputs_unavailable:', 'unreachable_tile:',
] as const;
// A planner blocker: the re-plan found no candidate for the account. The planner names the blocker that stopped the
// most candidates (planner.ts dominantBlocker), often a goal that the running job does not serve.
export function brainPlannerBlocker(reason: string | undefined): boolean {
    return reason === 'no_matching_demand_or_activity' || reason === 'missing_food_supply'
        || (reason !== undefined && (BRAIN_BLOCKER_PREFIXES.some(p => reason.startsWith(p)) || /:exceeds_(?:\d+_|max_)steps$/.test(reason)));
}
export function brainSoftIdle(reason: string | undefined): boolean {
    return reason === undefined || BRAIN_SOFT_IDLE.has(reason) || brainPlannerBlocker(reason);
}
// A repeating run whose re-plan ends at a planner blocker keeps running while its own demand is open and its activity
// holds no defect for the account (ownJobOpen): a stop gives the slot to no work. The blocker is often a supply of
// another goal.
export function brainDropKeep(o: {
    run: Pick<Run, 'accounts' | 'started' | 'brain' | 'finite'>;
    ownJobOpen?: (account: string) => boolean;
    now: number;
    dropCycles: number;
    stopAll: boolean;
    brainActive: boolean;
    handAccount: (account: string) => boolean;
    held: (account: string) => boolean;
    ended: (account: string) => boolean;
    replacement: (account: string) => SelectedBrainDispatch['mode'] | undefined;
    idleReason: (account: string) => string | undefined;
}): string | undefined {
    if (!o.run.brain || o.stopAll || !o.brainActive) return undefined;
    for (const a of o.run.accounts) {
        if (o.handAccount(a) || o.held(a) || o.ended(a)) return undefined;
        const mode = o.replacement(a);
        if (mode === 'session_recovery' || mode === 'fleet_trade') return undefined;
        if (!brainSoftIdle(o.idleReason(a))) return undefined;
    }
    if (o.run.finite) return 'finite job runs to its end';
    if (o.ownJobOpen && o.run.accounts.every(a => brainPlannerBlocker(o.idleReason(a)) && o.ownJobOpen!(a))) {
        return 'its demand is open and the plan has no other work';
    }
    if (o.now - o.run.started < BRAIN_RUN_MIN_MS) return `run younger than ${BRAIN_RUN_MIN_MS / 60_000} min`;
    if (o.dropCycles < BRAIN_DROP_CYCLES) return `dropped for ${o.dropCycles} of ${BRAIN_DROP_CYCLES} brain cycles`;
    return undefined;
}

// The demand of a brain run is active with work left in the brain goals, and no defect holds its activity for the account.
export function brainJobOpen(
    brain: {
        readonly fleetState: {
            readonly goals: readonly { readonly id: string; readonly active: boolean; readonly remaining: number }[];
            readonly quarantinedDefects: BrainCycleResult['fleetState']['quarantinedDefects'];
        };
        readonly world: { readonly accounts: Readonly<Record<string, Pick<BrainCycleResult['world']['accounts'][string], 'skills'>>> };
    },
    run: Pick<Run, 'activityId' | 'demandId'>,
    account: string,
    now: number,
): boolean {
    if (!run.activityId || !run.demandId) return false;
    const goal = brain.fleetState.goals.find(g => g.id === run.demandId);
    if (!goal || !goal.active || goal.remaining <= 0) return false;
    const acct = brain.world.accounts[account.toLowerCase()];
    const levels = acct ? accountClassLevels(acct) : undefined;
    return !brain.fleetState.quarantinedDefects.some(d => d.activityId === run.activityId && defectBlocksAccount(d, account, now, levels));
}

// Counts the brain cycles in a row that dropped each run. A run that the plan holds again, or that ended, leaves the map.
export function countBrainDrops(
    drops: Map<string, { cycles: number; cycleAt: number }>,
    droppedKeys: ReadonlySet<string>,
    cycleAt: number,
): void {
    for (const key of [...drops.keys()]) if (!droppedKeys.has(key)) drops.delete(key);
    for (const key of droppedKeys) {
        const d = drops.get(key);
        if (!d) drops.set(key, { cycles: 1, cycleAt });
        else if (d.cycleAt !== cycleAt) { d.cycles++; d.cycleAt = cycleAt; }
    }
}

export function swarmWroteStop(text: string | undefined): boolean {
    return text !== undefined && (Object.values(SWARM_STOP) as string[]).includes(text.trim());
}

// The end of a brain run that a stop file ended. When the swarm wrote that stop (it dropped the run from the plan, or a
// live-update drain), or the stop is gone, the end is `released`: startable resumes it, so the next plan of the same job
// starts. A plain `stopped` end with the same revision held the account for good. An owner's stop file keeps `stopped`,
// and so do the stops that need a resupply or a heal first (no food, a flee), which do not print "stop file".
export function brainStopEnd(own: string, lastResultLine: string | undefined, stopText: string | undefined): string {
    if (!/^stopped\b/.test(own) || !/\bstop file\b|\bcargo stopped\b/i.test(lastResultLine ?? '')) return own;
    return stopText === undefined || swarmWroteStop(stopText) ? `released: ${own}` : own;
}

export function isAutoStopText(text: string | undefined): boolean {
    return swarmWroteStop(text) || /^fleet-health auto-paused:/i.test((text ?? '').trim());
}

export function writeSwarmStop(file: string, reason: string): void {
    try { writeFileSync(file, reason, { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}

// The swarm's exit on a signal. An active session-recovery child is attached and dies with the swarm, so it is asked to
// log out and given the grace to end first (worker-stop.ts).
export async function recoveryLogOutThenExit(
    active: { readonly account: string; readonly pid: number } | undefined,
    alive: (pid: number) => boolean,
    writeStop: (account: string) => void,
    o: { graceMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>; exit?: (code: number) => void; log?: (line: string) => void } = {},
): Promise<void> {
    const log = o.log ?? console.log;
    if (active) {
        log(`SWARM signal: asking recovery ${active.account} to log out before exit`);
        const left = await askWorkersToLogOut([{ account: active.account, ended: () => !alive(active.pid) }], { writeStop, graceMs: o.graceMs, now: o.now, sleep: o.sleep });
        if (left.length > 0) log(`SWARM signal: recovery ${active.account} did not end in the grace; it ends with this process`);
    }
    (o.exit ?? process.exit)(0);
}

// The swarm's signal stop. `stopping` is true from the first signal, before the recovery logout wait, so the tick starts
// nothing during the wait. Runs that already run are detached and stay as they are. A second signal exits at once.
export function swarmSignalStop(o: {
    active: () => { readonly account: string; readonly pid: number } | undefined;
    alive: (pid: number) => boolean;
    writeStop: (account: string) => void;
    graceMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>; exit?: (code: number) => void; log?: (line: string) => void;
}): { readonly stopping: boolean; onSignal: () => void } {
    let stopping = false;
    return {
        get stopping() { return stopping; },
        onSignal: () => {
            if (stopping) { (o.exit ?? process.exit)(0); return; }
            stopping = true;
            void recoveryLogOutThenExit(o.active(), o.alive, o.writeStop, o);
        },
    };
}

export function clearSwarmStop(file: string): boolean {
    let text: string;
    try { text = readFileSync(file, 'utf8'); } catch { return false; }
    if (!swarmWroteStop(text)) return false;
    rmSync(file, { force: true });
    return true;
}

export function clearAutoStop(file: string): boolean {
    let text: string;
    try { text = readFileSync(file, 'utf8'); } catch { return false; }
    if (!isAutoStopText(text)) return false;
    rmSync(file, { force: true });
    return true;
}

export function clearAccountSwarmStops(account: string, root: string): boolean {
    let cleared = false;
    for (const file of stopFilePaths(account, root)) {
        if (clearSwarmStop(file)) cleared = true;
    }
    return cleared;
}

export function clearAccountAutoStops(account: string, root: string): boolean {
    let cleared = false;
    for (const file of stopFilePaths(account, root)) {
        if (clearAutoStop(file)) cleared = true;
    }
    return cleared;
}

const statusDataCache = new Map<string, { mtimeMs: number; size: number; ino: number; data: any }>();

function readCachedStatusData(filePath: string, nowWall: number): { mtimeMs: number; data: any } | null {
    try {
        const st = statSync(filePath);
        const hit = statusDataCache.get(filePath);
        if (hit && nowWall - st.mtimeMs > 1000 && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.ino === st.ino) {
            return { mtimeMs: st.mtimeMs, data: hit.data };
        }
        const data = JSON.parse(readFileSync(filePath, 'utf8'));
        if (statusDataCache.size >= 512) statusDataCache.clear();
        statusDataCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, data });
        return { mtimeMs: st.mtimeMs, data };
    } catch {
        statusDataCache.delete(filePath);
        return null;
    }
}

function findAccountStatusFile(root: string, account: string): string | null {
    const lower = `${account.toLowerCase()}.json`;
    for (const dir of statusReadDirs(root)) {
        if (!existsSync(dir)) continue;
        const exact = join(dir, `${account}.json`);
        const lowerPath = join(dir, lower);
        let target: string | null = existsSync(exact) ? exact : (exact !== lowerPath && existsSync(lowerPath) ? lowerPath : null);
        if (!target) {
            try {
                const match = readdirSync(dir).find(f => f.toLowerCase() === lower);
                if (match) target = join(dir, match);
            } catch { /* unreadable status dir */ }
        }
        if (target) return target;
    }
    return null;
}

function readAccountStatusData(
    root: string,
    account: string,
): { file: string; mtimeMs: number; data: any } | null {
    const target = findAccountStatusFile(root, account);
    if (!target) return null;
    const hit = readCachedStatusData(target, Date.now());
    return hit ? { file: target, mtimeMs: hit.mtimeMs, data: hit.data } : null;
}

export function readAccountStatus(
    root: string,
    account: string,
): { file: string; mtimeMs: number; raw: Buffer; data: any } | null {
    const target = findAccountStatusFile(root, account);
    if (!target) return null;
    try {
        const st = statSync(target);
        const raw = readFileSync(target);
        const data = JSON.parse(raw.toString('utf8'));
        if (statusDataCache.size >= 512) statusDataCache.clear();
        statusDataCache.set(target, { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, data });
        return { file: target, mtimeMs: st.mtimeMs, raw, data };
    } catch {
        statusDataCache.delete(target);
        return null;
    }
}

function readAllStatusEntries(root: string): { statuses: unknown[]; byLower: Map<string, { file: string; mtimeMs: number; data: any }> } {
    const statuses: unknown[] = [];
    const byLower = new Map<string, { file: string; mtimeMs: number; data: any }>();
    const seen = new Set<string>();
    const seenPaths = new Set<string>();
    const nowWall = Date.now();
    for (const dir of statusReadDirs(root)) {
        if (!existsSync(dir)) continue;
        let files: string[] = [];
        try { files = readdirSync(dir); } catch { continue; }
        for (const file of files) {
            const key = file.toLowerCase();
            if (!key.endsWith('.json') || seen.has(key)) continue;
            seen.add(key);
            const filePath = join(dir, file);
            seenPaths.add(filePath);
            const hit = readCachedStatusData(filePath, nowWall);
            if (!hit) continue;
            statuses.push(hit.data);
            const stem = key.slice(0, -5);
            const rowKey = typeof hit.data?.name === 'string' && hit.data.name ? hit.data.name.toLowerCase() : stem;
            if (!byLower.has(rowKey)) byLower.set(rowKey, { file: filePath, mtimeMs: hit.mtimeMs, data: hit.data });
            if (!byLower.has(stem)) byLower.set(stem, { file: filePath, mtimeMs: hit.mtimeMs, data: hit.data });
        }
    }
    for (const cachedPath of statusDataCache.keys()) {
        if (!seenPaths.has(cachedPath)) statusDataCache.delete(cachedPath);
    }
    return { statuses, byLower };
}

export function readAllStatuses(root: string): unknown[] {
    return readAllStatusEntries(root).statuses;
}

export function shouldSwarmReload(opts: {
    root: string;
    startedAt: number;
    recoveryActive: boolean;
    stopAll: boolean;
    check?: (root: string, name: string, startedAt: number) => boolean;
}): boolean {
    if (opts.recoveryActive || opts.stopAll) return false;
    return (opts.check ?? reloadDue)(opts.root, 'swarm', opts.startedAt);
}

export function swarmReloadArgs(root: string, planFile: string, watchId?: string, nonce = randomUUID()): string[] {
    return [
        join(root, 'scripts', 'swarm.ts'),
        planFile,
        `--nonce=${nonce}`,
        ...(watchId ? [`--watch-id=${watchId}`] : []),
    ];
}

export const DEFAULT_BRAIN_CYCLE_MS = 6_000;

export function brainCycleDue(v: {
    hasCached: boolean;
    dirty: boolean;
    now: number;
    lastAt: number;
    intervalMs: number;
    hasPendingCommands: boolean;
    planMtime: number;
    lastPlanMtime: number;
}): boolean {
    if (!v.hasCached || v.dirty || v.hasPendingCommands) return true;
    if (v.planMtime !== v.lastPlanMtime) return true;
    return v.now - v.lastAt >= v.intervalMs;
}

export function runningJobState(
    parsed: ParsedJob,
    run: Pick<Run, 'accounts' | 'started' | 'revision'>,
    ended: ReadonlyMap<string, EndRecord>,
    pendingResume: ReadonlySet<string>,
    stopAll: boolean,
    stopFile: (account: string) => string,
): Record<string, string> {
    const state: Record<string, string> = {}, stop = !parsed.job.enabled || stopAll;
    for (const account of parsed.accounts) {
        if (!run.accounts.some(name => name.toLowerCase() === account.toLowerCase())) state[account] = 'waiting: current mission still running';
        else if (ended.has(account) && ended.get(account)!.at >= run.started) state[account] = `ended: ${ended.get(account)!.reason}`;
        else if (stop) { writeSwarmStop(stopFile(account), SWARM_STOP.job); state[account] = 'stopping'; }
        else state[account] = pendingResume.has(account.toLowerCase()) ? 'stopping; resume queued'
            : run.revision !== missionSignature(parsed.job) ? 'running; updated mission queued' : 'running';
    }
    return state;
}

export function supplyExhaustedResult(result?: string, env?: Record<string, string>): boolean {
    if (typeof result !== 'string') return false;
    if (/^(?:RESULT )?fail no food\b/.test(result) || /\bstop"?[=:]"?(?:supplies|input-insufficient)\b/.test(result)) return true;
    const reserve = env?.BONE_RESERVE;
    if (reserve !== undefined && /^\d+$/.test(reserve)) {
        const match = result.match(/^(?:RESULT )?fail mode=prayer\b.*\bok=false\b.*\bburied=0\b.*\battempts=0\b.*\bboneBank=(\d+)\b.*\bheldBones=0\b/);
        if (match && Number(match[1]) <= Number(reserve)) return true;
    }
    return false;
}

export function standingRetryable(reason: string, result?: string, retry?: boolean, env?: Record<string, string>): boolean {
    if (retry === false) return false;
    if (/^stopped after \d+ runs$/.test(reason)) return typeof result === 'string' && !supplyExhaustedResult(result, env);
    return /^(?:blocked|gave-up)\b|^exit unknown$/.test(reason) && !supplyExhaustedResult(result, env);
}

export function standingEndRetryable(
    end: Pick<EndRecord, 'reason' | 'revision'>,
    job: Pick<Job, 'standingRetry' | 'env'>,
    revision: string,
    result?: string,
): boolean {
    const sameMission = !end.revision || end.revision === revision;
    const retry = !sameMission && /^stopped after \d+ runs$/.test(end.reason) ? undefined : job.standingRetry;
    return standingRetryable(end.reason, result, retry, job.env);
}

export function standingRetryDue(status: { server?: string; result?: string; at?: number } | undefined, settled: boolean, now: number): boolean {
    if (!status) return settled;
    return status.server === LIVE_SERVER && (settled || (!!status.result && Number.isFinite(status.at) && now - status.at! >= BOOTSTRAP_STATUS_AGE_MS));
}

export function endedForGood(end: { reason: string } | undefined, repeat: boolean | undefined): boolean {
    return !!end && (!repeat || !successfulEnd(end.reason));
}

export function loadEnded(file: string): Map<string, EndRecord> {
    if (!existsSync(file)) return new Map();
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid swarm end-state object');
    const entries = Object.entries(raw) as [string, EndRecord][];
    const seen = new Set<string>();
    for (const [name, end] of entries) {
        if (
            !ACCOUNT.test(name) || seen.has(name.toLowerCase()) || !end || !Number.isFinite(end.at) || end.at < 0
            || typeof end.reason !== 'string' || !end.reason.trim() || (end.revision !== undefined && typeof end.revision !== 'string')
        ) throw new Error('invalid swarm end-state record');
        seen.add(name.toLowerCase());
    }
    return new Map(entries);
}

export const LIVE_SERVER = 'rs-sdk-demo.fly.dev';
export type ProducerProofRef = { kind: 'producer'; attemptId: string };
export type EndRepairRequest = { account: string; endedAt: number; server: string; proof: ProducerProofRef | LegacyLogoutClaim };
export type ScriptQualificationRequest = {
    kind: 'script-qualified'; account: string; script: string; holdAt: number; server: string; proof: ProducerProofRef | LegacyLogoutClaim;
    qualification: { receiptPath: string; receiptSha256: string; at: number };
};
export type ScriptHold = {
    account: string; script: string; at: number; reason: string; revision?: string; heldAt: number;
    qualified?: { at: number; receiptPath: string; receiptSha256: string; recordedAt: number };
    restored?: { at: number; receiptPath: string; receiptSha256: string; recordedAt: number };
};
export type RepairProofs = {
    readProof: (account: string, server: string) => LogoutProof;
    verifyLegacy: (claim: unknown) => LegacyLogoutProof;
    now?: () => number;
    status?: (account: string) => { server?: unknown; started?: unknown; sessionAttemptId?: unknown } | undefined;
    statusSha256?: (account: string) => string | undefined;
};

export const defaultRepairProofs: RepairProofs = {
    readProof: (a, s) => {
        if (ACCOUNT.test(a)) assertNoRecoveryLease(a, repoRoot);
        return readLogoutProof(a, s);
    },
    verifyLegacy: c => verifyLegacyLogout(c),
};

export const scriptKey = (script: string) => script.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();

export function failedScript(end: EndRecord): string | null {
    try {
        const r = JSON.parse(end.revision ?? '');
        return Array.isArray(r) && typeof r[0] === 'string' && r[0].trim() ? scriptKey(r[0]) : null;
    } catch { return null; }
}

export function currentLogout(request: any, proofs: RepairProofs): { ok: true; label: string; attemptId?: string } | { ok: false; reason: string } {
    if (request.server !== LIVE_SERVER) return { ok: false, reason: 'repair server is not the live server' };
    const p = request.proof;
    if (p?.kind === 'producer') {
        if (typeof p.attemptId !== 'string') return { ok: false, reason: 'invalid producer proof' };
        let now: LogoutProof;
        try { now = proofs.readProof(request.account, request.server); } catch { return { ok: false, reason: 'logout proof unavailable or recovery lease held' }; }
        if (now.state === 'none') return { ok: false, reason: 'no producer logout proof' };
        if (now.state === 'invalid') return { ok: false, reason: `invalid logout proof: ${now.reason}` };
        if (now.attemptId !== p.attemptId) return { ok: false, reason: 'logout proof superseded by a newer attempt' };
        if (now.state !== 'confirmed') return { ok: false, reason: `logout not confirmed: ${now.reason}` };
        if (now.account.toLowerCase() !== request.account.toLowerCase() || now.server !== request.server) return { ok: false, reason: 'logout proof identity mismatch' };
        let st: ReturnType<NonNullable<RepairProofs['status']>>;
        try { st = proofs.status?.(request.account); } catch { return { ok: false, reason: 'status unreadable' }; }
        if (st && st.server === request.server && (
            (Number.isFinite(st.started) && (st.started as number) > now.loggedOutAt)
            || (typeof st.sessionAttemptId === 'string' && st.sessionAttemptId !== now.attemptId && !(Number.isFinite(st.started) && (st.started as number) <= now.loggedOutAt))
        )) return { ok: false, reason: 'status shows a session the logout proof does not cover' };
        return { ok: true, label: `producer ${now.attemptId}`, attemptId: now.attemptId };
    }
    if (p?.kind === 'legacy-logout') {
        if (typeof p.account !== 'string' || p.account.toLowerCase() !== request.account.toLowerCase() || p.server !== request.server) {
            return { ok: false, reason: 'legacy proof identity mismatch' };
        }
        const legacy = proofs.verifyLegacy(p);
        return legacy.state === 'legacy-confirmed' ? { ok: true, label: `legacy ${legacy.statusSha256}` } : { ok: false, reason: `legacy proof refused: ${legacy.reason}` };
    }
    if (p?.kind === 'settled-status') {
        let st: any;
        try { st = proofs.status?.(request.account); } catch { return { ok: false, reason: 'status unreadable' }; }
        const now = proofs.now?.() ?? Date.now();
        if (!st || st.server !== request.server || typeof st.result !== 'string' || !st.result) return { ok: false, reason: 'status shows no finished session' };
        if (!Number.isFinite(st.at) || now - st.at < BOOTSTRAP_STATUS_AGE_MS) return { ok: false, reason: 'status changed in the last 15 minutes' };
        return { ok: true, label: `settled status at ${st.at}` };
    }
    if (p?.kind === 'unregistered-specialist') {
        const key = request.account.toLowerCase();
        if (!Object.hasOwn(SPECIALIST_BOARDS, key)) return { ok: false, reason: 'unregistered-specialist proof is reserved for specialist accounts' };
        if (
            p.account !== key || typeof p.snapshotPath !== 'string' || !/^[a-f0-9]{64}$/.test(p.snapshotSha256 ?? '')
            || !Number.isFinite(p.profileAt) || p.profileAt < request.endedAt
        ) return { ok: false, reason: 'invalid unregistered-specialist proof' };
        let current: LogoutProof;
        try { current = proofs.readProof(request.account, request.server); } catch { return { ok: false, reason: 'logout proof unavailable or recovery lease held' }; }
        if (current.state !== 'none') return { ok: false, reason: `producer logout state is ${current.state}` };
        let st: ReturnType<NonNullable<RepairProofs['status']>>;
        try { st = proofs.status?.(request.account) ?? (key !== request.account ? proofs.status?.(key) : undefined); }
        catch { return { ok: false, reason: 'status unreadable' }; }
        if (st !== undefined) return { ok: false, reason: 'status file exists for specialist account' };
        let raw: Buffer, snap: any;
        try { raw = readFileSync(p.snapshotPath); snap = JSON.parse(raw.toString('utf8')); }
        catch { return { ok: false, reason: 'specialist snapshot missing or malformed' }; }
        if (createHash('sha256').update(raw).digest('hex') !== p.snapshotSha256) return { ok: false, reason: 'specialist snapshot hash changed' };
        const profiles = Array.isArray(snap?.profiles) ? snap.profiles.filter((x: any) => x?.name === key) : [];
        const profile = profiles[0], now = proofs.now?.() ?? Date.now();
        if (
            snap?.base !== 'https://rs-sdk-demo.fly.dev' || snap?.tickMs !== 400 || profiles.length !== 1 || profile?.status !== 404
            || profile.at !== p.profileAt || profile.at > now || now - profile.at >= 3_600_000
        ) return { ok: false, reason: 'specialist snapshot lacks fresh 404 profile' };
        return { ok: true, label: `unregistered specialist 404 at ${profile.at}` };
    }
    return { ok: false, reason: 'missing logout proof' };
}

export function applyEndRepair(request: any, ended: Map<string, EndRecord>, active: readonly string[], proofs: RepairProofs, holds: ScriptHold[] = []) {
    if (!request || typeof request.account !== 'string' || !ACCOUNT.test(request.account) || !Number.isFinite(request.endedAt) || request.endedAt < 0) {
        return { changed: false, reason: 'invalid repair request' };
    }
    const key = request.account.toLowerCase();
    if (active.some(a => a.toLowerCase() === key)) return { changed: false, reason: 'account still active' };
    const entry = [...ended].find(([name]) => name.toLowerCase() === key);
    if (!entry) return { changed: false, reason: 'already clear' };
    if (entry[1].at !== request.endedAt) return { changed: false, reason: 'end record changed' };
    if (successfulEnd(entry[1].reason)) return { changed: false, reason: 'completed work needs a new mission' };
    const script = failedScript(entry[1]);
    const dead = /^died\b/.test(entry[1].reason);
    if (dead && !script) return { changed: false, reason: 'failed script unknown; hold cannot be kept' };
    const logout = currentLogout(request, proofs);
    if (!logout.ok) return { changed: false, reason: logout.reason };
    if (dead) {
        holds.push({
            account: entry[0], script: script!, at: entry[1].at, reason: entry[1].reason,
            ...(entry[1].revision !== undefined ? { revision: entry[1].revision } : {}), heldAt: (proofs.now ?? Date.now)(),
        });
    }
    ended.delete(entry[0]);
    return { changed: true, reason: `repaired failure cleared (${logout.label})` };
}

const PROTECTED_ACCOUNTS = [...RESERVED_ACCOUNTS, 'afknight'];

export function lifecycleAccounts(dir: string): string[] {
    let names: string[];
    try { names = readdirSync(dir); } catch { return []; }
    return names.flatMap(n => {
        try {
            const a = JSON.parse(readFileSync(join(dir, n, 'latest.json'), 'utf8')).account;
            return typeof a === 'string' && ACCOUNT.test(a) ? [a] : [];
        } catch { return []; }
    });
}

const replaceablePriorEnd = (reason: string) =>
    successfulEnd(reason)
    || (reason !== 'stopped by owner' && /^(?:stopped|blocked|gave-up|release-paused)(?:\b|$)/.test(reason));

export function orphanedSessionEnds(
    accounts: readonly string[],
    ended: ReadonlyMap<string, EndRecord>,
    busy: readonly string[],
    proof: (a: string) => LogoutProof,
    producer: (a: string, attemptId: string) => { pid: number; createdAt: number; updatedAt: number } | undefined,
    alive: (pid: number) => boolean,
    starts: (pids: readonly number[]) => ReadonlyMap<number, number> | null = () => null,
): [string, string][] {
    const found: { end: [string, string]; pid: number; createdAt: number; answers: boolean }[] = [], seen = new Set<string>();
    for (const a of accounts) {
        const key = a.toLowerCase();
        if (PROTECTED_ACCOUNTS.includes(key) || seen.has(key) || busy.some(b => b.toLowerCase() === key)) continue;
        seen.add(key);
        let p: LogoutProof;
        try { p = proof(a); } catch { continue; }
        if (p.state !== 'held') continue;
        const receipt = producer(a, p.attemptId);
        if (!receipt || !Number.isSafeInteger(receipt.pid) || receipt.pid < 1 || !Number.isFinite(receipt.createdAt) || !Number.isFinite(receipt.updatedAt)) continue;
        const prior = [...ended].find(([name]) => name.toLowerCase() === key);
        const orphan = prior?.[1].reason.startsWith('exit orphaned: attempt '), unknown = prior?.[1].reason === 'exit unknown';
        if (prior && !unknown && !(orphan ? receipt.updatedAt > prior[1].at : replaceablePriorEnd(prior[1].reason) && receipt.createdAt > prior[1].at)) continue;
        found.push({ end: [prior?.[0] ?? a, `exit orphaned: attempt ${p.attemptId} owner ${receipt.pid} gone`], pid: receipt.pid, createdAt: receipt.createdAt, answers: alive(receipt.pid) });
    }
    const answering = found.filter(f => f.answers).map(f => f.pid), table = answering.length ? starts(answering) : null;
    return found.filter(f => !f.answers || laterProcessHolds(f.pid, f.createdAt, table)).map(f => f.end);
}

// An `exit orphaned` end waits for proof that the orphaned session ended. Session recovery runs only while the proof
// is held (session-recovery.ts assessRecoveryEligibility). A later session that logs in and out cleanly, such as a
// fleet-agent trade, leaves a confirmed proof, so recovery refuses the account and nothing else clears the end: the
// swarm never starts its job again (endedForGood), and the brain keeps the account's plan slot (scheduler.ts
// max_bots_limit). The server holds one session for each account, so a logout confirmed after the orphaned attempt
// started shows that no session is open. ORPHAN_SETTLE_MS leaves the logout time to settle, as a standing retry does.
// Returns each such end with the attempt whose logout is confirmed.
export const ORPHAN_SETTLE_MS = 120_000;
export function resolvedOrphanEnds(
    ended: ReadonlyMap<string, EndRecord>,
    busy: readonly string[],
    proof: (a: string) => LogoutProof,
    now: number,
): { account: string; reason: string; confirmed: string }[] {
    const out: { account: string; reason: string; confirmed: string }[] = [], busyKeys = new Set(busy.map(b => b.toLowerCase()));
    for (const [account, end] of ended) {
        const named = /^exit orphaned: attempt (\S+) /.exec(end.reason)?.[1], key = account.toLowerCase();
        if (!named || PROTECTED_ACCOUNTS.includes(key) || busyKeys.has(key)) continue;
        let p: LogoutProof;
        try { p = proof(account); } catch { continue; }
        if (p.state !== 'confirmed' || !Number.isFinite(p.loggedOutAt) || now - p.loggedOutAt < ORPHAN_SETTLE_MS) continue;
        const started = /^\d{13}-/.test(named) ? Number(named.slice(0, 13)) : end.at;
        if (p.loggedOutAt <= started) continue;
        out.push({ account, reason: end.reason, confirmed: p.attemptId });
    }
    return out;
}

// A live update lands only when no live run loads its files, and a new live login refuses while a peer runs an older
// release (worker-release/peers.ts assertCompatibleWorkers), so the update cannot land under a long run either. A
// drain that has waited DRAIN_STOP_MS (from the mark's `since`) asks the swarm's own runs that hold it to log out
// with DRAIN_STOP_TEXT. The supervisor ends such a job as release-paused, and the swarm starts it again on the new
// code. Trades end within their order window, a host run ends per account, a standing job is not drained, and a
// recovery or a protected account is never stopped here. Runs of other controllers and manual runs are not the
// swarm's, so they are left as they are.
export type DrainRun = { accounts: readonly string[]; host: boolean; standing: boolean; trade: boolean; drained: readonly string[] };
export function drainStopAccounts(pending: PendingUpdate | null, now: number, runs: readonly DrainRun[], busy: readonly string[]): string[] {
    if (!pending || now - (pending.since ?? pending.at) < DRAIN_STOP_MS) return [];
    const skip = new Set(busy.map(b => b.toLowerCase())), out: string[] = [];
    for (const r of runs) {
        if (r.host || r.standing || r.trade || !r.drained.length) continue;
        if (r.accounts.some(a => PROTECTED_ACCOUNTS.includes(a.toLowerCase()) || skip.has(a.toLowerCase()))) continue;
        out.push(...r.accounts);
    }
    return out;
}

// Removes each drain stop (DRAIN_STOP_TEXT) whose account no run holds. Other stop texts stay.
export function clearDrainStops(dirs: readonly string[], running: ReadonlySet<string>): string[] {
    const cleared: string[] = [];
    for (const dir of dirs) {
        let names: string[];
        try { names = readdirSync(dir); } catch { continue; }
        for (const name of names) {
            if (!name.toLowerCase().startsWith('stop-')) continue;
            const account = name.slice(5), file = join(dir, name);
            if (running.has(account.toLowerCase())) continue;
            let text: string;
            try { text = readFileSync(file, 'utf8'); } catch { continue; }
            if (text.trim() !== DRAIN_STOP_TEXT) continue;
            try { rmSync(file, { force: true }); cleared.push(account); } catch { /* kept until the next tick */ }
        }
    }
    return cleared;
}

export function applyScriptQualification(request: any, holds: ScriptHold[], active: readonly string[], proofs: RepairProofs) {
    if (
        !request || request.kind !== 'script-qualified' || typeof request.account !== 'string' || !ACCOUNT.test(request.account)
        || typeof request.script !== 'string' || !Number.isFinite(request.holdAt) || !request.qualification
    ) return { changed: false, reason: 'invalid qualification request' };
    const key = request.account.toLowerCase(), script = scriptKey(request.script), q = request.qualification;
    if (active.some(a => a.toLowerCase() === key)) return { changed: false, reason: 'account still active' };
    const hold = holds.find(h => h.account.toLowerCase() === key && scriptKey(h.script) === script && h.at === request.holdAt);
    if (!hold) return { changed: false, reason: 'no matching open hold' };
    if (typeof q.receiptPath !== 'string' || !/^[0-9a-f]{64}$/.test(q.receiptSha256 ?? '') || !Number.isFinite(q.at) || q.at <= hold.at) {
        return { changed: false, reason: 'qualification is not newer than the failure' };
    }
    let receipt: any;
    try {
        const raw = readFileSync(q.receiptPath);
        if (createHash('sha256').update(raw).digest('hex') !== q.receiptSha256) return { changed: false, reason: 'qualification receipt hash changed' };
        receipt = JSON.parse(raw.toString('utf8'));
    } catch { return { changed: false, reason: 'qualification receipt missing or malformed' }; }
    if (
        receipt?.ok !== true || typeof receipt.script !== 'string' || scriptKey(receipt.script) !== script || receipt.at !== q.at
        || typeof receipt.account !== 'string' || receipt.account.toLowerCase() !== key
    ) return { changed: false, reason: 'qualification receipt is not a same-script success for this account' };
    if (request.proof?.kind !== 'producer' || receipt.attemptId !== request.proof.attemptId) return { changed: false, reason: 'qualification is not bound to the current producer logout' };
    const logout = currentLogout(request, proofs);
    if (!logout.ok) return { changed: false, reason: logout.reason };
    return { changed: false, reason: 'script qualification unsupported: caller receipt has no producer-bound work result' };
}

export const PVP_DEATH_SCRIPTS: ReadonlySet<string> = new Set([
    'scripts/aio-pvp.ts', 'scripts/pk-squad.ts', 'scripts/pk-hunt.ts', 'scripts/pk-roam.ts', 'scripts/pk-army.ts',
]);
export const KIT_RECEIPT_MAX_AGE_MS = 15 * 60_000;

export function applyKitRestored(request: any, holds: ScriptHold[], active: readonly string[], proofs: RepairProofs) {
    const q = request?.kit;
    if (
        !request || request.kind !== 'kit-restored' || typeof request.account !== 'string' || !ACCOUNT.test(request.account)
        || typeof request.script !== 'string' || !Number.isFinite(request.holdAt) || !q || typeof q.receiptPath !== 'string'
        || !/^[0-9a-f]{64}$/.test(q.receiptSha256 ?? '') || !Number.isFinite(q.at)
    ) return { changed: false, reason: 'invalid kit-restored request' };
    const key = request.account.toLowerCase(), script = scriptKey(request.script);
    if (active.some(a => a.toLowerCase() === key)) return { changed: false, reason: 'account still active' };
    const hold = holds.find(h => h.account.toLowerCase() === key && scriptKey(h.script) === script && h.at === request.holdAt);
    if (!hold) return { changed: false, reason: 'no matching open hold' };
    if (hold.restored) return { changed: false, reason: 'hold already restored' };
    if (!PVP_DEATH_SCRIPTS.has(script) || !/^died\b/.test(hold.reason)) return { changed: false, reason: 'not the hold of a PvP death' };
    const now = (proofs.now ?? Date.now)();
    if (q.at <= hold.at) return { changed: false, reason: 'kit receipt is not newer than the death' };
    if (now - q.at > KIT_RECEIPT_MAX_AGE_MS || q.at > now) return { changed: false, reason: 'kit receipt is stale' };
    let receipt: any;
    try {
        const raw = readFileSync(q.receiptPath);
        if (createHash('sha256').update(raw).digest('hex') !== q.receiptSha256) return { changed: false, reason: 'kit receipt hash changed' };
        receipt = JSON.parse(raw.toString('utf8'));
    } catch { return { changed: false, reason: 'kit receipt missing or malformed' }; }
    if (
        receipt?.schema !== 'squad-ready/1' || receipt.ok !== true || receipt.at !== q.at
        || typeof receipt.account !== 'string' || receipt.account.toLowerCase() !== key
        || typeof receipt.rule !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.statusSha256 ?? '')
    ) return { changed: false, reason: 'kit receipt is not a passing squad-ready check of this account' };
    const snapshot = proofs.statusSha256?.(request.account);
    if (snapshot === undefined || snapshot !== receipt.statusSha256) return { changed: false, reason: 'kit receipt does not match the current status snapshot' };
    const logout = currentLogout(request, proofs);
    if (!logout.ok) return { changed: false, reason: logout.reason };
    hold.restored = { at: q.at, receiptPath: q.receiptPath, receiptSha256: q.receiptSha256, recordedAt: now };
    return { changed: true, reason: `PvP death hold cleared, kit restored (${logout.label})` };
}

export function openHold(holds: readonly ScriptHold[], account: string, script: string): ScriptHold | undefined {
    const key = account.toLowerCase(), s = scriptKey(script);
    return holds.find(h => h.account.toLowerCase() === key && scriptKey(h.script) === s && !h.restored);
}

export function holdCandidates(selection: { start: string[]; blocked: Record<string, string> }, script: string, holds: readonly ScriptHold[]) {
    const start: string[] = [], blocked = { ...selection.blocked };
    for (const a of selection.start) {
        const h = openHold(holds, a, script);
        if (h) blocked[a] = `held: failed ${h.script} (${h.reason} at ${h.at}) needs same-script qualification`;
        else start.push(a);
    }
    return { start, blocked };
}

export function loadHolds(file: string): ScriptHold[] {
    if (!existsSync(file)) return [];
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (
        !Array.isArray(raw) || !raw.every(h => h && typeof h.account === 'string' && ACCOUNT.test(h.account)
        && typeof h.script === 'string' && h.script && Number.isFinite(h.at) && typeof h.reason === 'string' && Number.isFinite(h.heldAt))
    ) throw new Error('invalid swarm script-hold history');
    return raw;
}

export function syncDeathHolds(
    holdsFile: string,
    holds: ScriptHold[],
    prev: { mtimeMs: number; size: number },
    nowWall = Date.now(),
): { mtimeMs: number; size: number } {
    try {
        const st = statSync(holdsFile);
        if (nowWall - st.mtimeMs > 1000 && st.mtimeMs === prev.mtimeMs && st.size === prev.size) {
            return prev;
        }
        holds.splice(0, holds.length, ...loadHolds(holdsFile).filter(h => /^died\b/.test(h.reason)));
        return { mtimeMs: st.mtimeMs, size: st.size };
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            holds.length = 0;
            return { mtimeMs: 0, size: 0 };
        }
        return prev;
    }
}

export function persistHolds(file: string, holds: readonly ScriptHold[]): void {
    const temporary = `${file}.tmp-${process.pid}`;
    try { writeFileSync(temporary, JSON.stringify(holds, null, 1)); renameRetry(temporary, file); }
    catch (e) { try { rmSync(temporary, { force: true }); } catch { /* retain the original error */ } throw e; }
}

export function persistEnded(file: string, ended: ReadonlyMap<string, EndRecord>): void {
    const temporary = `${file}.tmp-${process.pid}`;
    try { writeFileSync(temporary, JSON.stringify(Object.fromEntries(ended), null, 1)); renameRetry(temporary, file); }
    catch (e) { try { rmSync(temporary, { force: true }); } catch { /* retain the original error */ } throw e; }
}

export function enabledByAccount(planned: readonly ParsedJob[]): Map<string, boolean> {
    const out = new Map<string, boolean>();
    for (const p of planned) for (const a of p.accounts) { const k = a.toLowerCase(); out.set(k, (out.get(k) ?? false) || p.job.enabled === true); }
    return out;
}

export function observeEnabled(accounts: readonly string[], enabled: boolean, previous: Map<string, boolean>, pending: Set<string>): void {
    for (const a of accounts) {
        const key = a.toLowerCase();
        if (enabled && previous.get(key) === false) pending.add(key);
        if (!enabled) pending.delete(key);
        previous.set(key, enabled);
    }
}

export function applyResume(
    accounts: readonly string[],
    active: boolean,
    ended: Map<string, EndRecord>,
    pending: Set<string>,
    clearStop: (a: string) => void,
    endedByLower?: ReadonlyMap<string, [string, EndRecord]>,
): boolean {
    if (active) return false;
    let changed = false;
    let lowerMap = endedByLower;
    for (const a of accounts) {
        const key = a.toLowerCase();
        if (!pending.delete(key)) continue;
        lowerMap ??= endedMapByLower(ended);
        const entry = lowerMap.get(key);
        if (entry && (persistentEnd(entry[1].reason) || successfulEnd(entry[1].reason))) continue;
        clearStop(a);
        if (entry) ended.delete(entry[0]);
        changed = true;
    }
    return changed;
}

export function supervisorEndLine(line: string): string | undefined {
    return line.match(/^SUPERVISE end ([\w-]+ after \d+ runs)\s*$/)?.[1];
}

export function diedAccountsOf(line: string): string[] | undefined {
    const m = line.match(/\bRESULT fail died .*?\bdiedAccounts=([A-Za-z0-9_,-]+)(?= \w+=)/);
    return m ? m[1]!.split(',').filter(Boolean) : undefined;
}

const accountKey = (a: string) => a.toLowerCase().replace(/ /g, '_');

export function endsOfRun(accounts: readonly string[], reason: string, died: readonly string[] | undefined): Map<string, string> {
    const named = new Set((died ?? []).map(accountKey));
    const split = /^died\b/.test(reason) && accounts.some(a => named.has(accountKey(a)));
    const released = `released${reason.slice('died'.length)}`;
    return new Map(accounts.map(a => [a, split && !named.has(accountKey(a)) ? released : reason]));
}

export function startable(
    accounts: string[],
    repeat: boolean | undefined,
    ended: Map<string, { reason: string; at?: number; revision?: string; release?: string }>,
    statusAge: (a: string) => number,
    statusStarted?: (a: string) => number | undefined,
    revision?: string,
    stopped?: (a: string) => boolean,
    brainManaged?: (a: string) => boolean,
    release?: string,
): { start: string[]; blocked: Record<string, string> } {
    const start: string[] = [];
    const blocked: Record<string, string> = {};
    let lowerMap: Map<string, { reason: string; at?: number; revision?: string; release?: string }> | null = null;
    for (const a of accounts) {
        let end = ended.get(a);
        if (end === undefined && ended.size > 0) {
            if (!lowerMap) {
                lowerMap = new Map();
                for (const [name, rec] of ended) lowerMap.set(name.toLowerCase(), rec);
            }
            end = lowerMap.get(a.toLowerCase());
        }
        const newMission = !!end?.revision && !!revision && end.revision !== revision && /^done(?: after \d+ runs)?$/.test(end.reason);
        const brainSwitched = !!brainManaged?.(a) && !!end?.revision && !!revision && end.revision !== revision && !/^died\b/.test(end.reason);
        // A run that a release since then may fix (a refused, blocked or stopped end) runs once more on the new
        // release. Its new end records that release, so a second failure holds again. A death stays held, and a
        // completed job needs a new mission, not a new release.
        const releaseChanged = !!end?.release && !!release && end.release !== release && !/^died\b/.test(end.reason) && !successfulEnd(end.reason);
        const resumable = !!end && (
            (/^refused\b/.test(end.reason) && !!end.revision && !!revision && end.revision !== revision)
            || /^release-paused\b/.test(end.reason) || /^released\b/.test(end.reason)
            || brainSwitched || releaseChanged
        );
        if (stopped?.(a)) blocked[a] = 'paused: stop file';
        else if (endedForGood(end, repeat) && !newMission && !resumable) {
            blocked[a] = /^release-paused\b/.test(end!.reason) ? 'paused: worker release' : `ended: ${end!.reason}`;
        } else if (statusAge(a) < 30_000) {
            let started: number | undefined;
            try { started = statusStarted?.(a); } catch { /* unknown remains external */ }
            if (end && /^done(?: after \d+ runs)?$/.test(end.reason) && Number.isFinite(end.at) && Number.isFinite(started) && started! > 0 && started! <= end.at!) {
                start.push(a);
            } else {
                blocked[a] = 'external (status fresh, not started by swarm)';
            }
        } else start.push(a);
    }
    return { start, blocked };
}

export function demandCandidates(
    selection: ReturnType<typeof startable>,
    waiting: () => string | null,
): ReturnType<typeof startable> {
    if (!selection.start.length) return selection;
    const reason = waiting();
    return reason ? { start: [], blocked: { ...selection.blocked, ...Object.fromEntries(selection.start.map(a => [a, reason])) } } : selection;
}

export function observeSwarmInfraFault(breaker: InfraCircuitBreaker, errorOrText: unknown): boolean {
    const kind = classifyInfraFault(errorOrText);
    if (!kind) return false;
    breaker.recordFailure(errorOrText, kind);
    return true;
}

export async function runSwarmCli(argv: readonly string[] = process.argv.slice(2), root = repoRoot): Promise<void> {
    const infraBreaker = new InfraCircuitBreaker({ stateFile: join(liveRoot(root), 'infra-circuit-breaker.json') });
    const positional = argv.filter(a => !a.startsWith('--'));
    const planFile = resolve(positional[0] ?? process.env.SWARM_PLAN ?? join(root, 'swarm.json'));
    const nonce = argv.find(a => a.startsWith('--nonce='))?.slice('--nonce='.length) || process.env.SWARM_OWNER_NONCE || randomUUID();
    const watchId = argv.find(a => a.startsWith('--watch-id='))?.slice('--watch-id='.length) || process.env.CLOUD_WATCH_ID;
    const prac = join(root, '.practice');
    const liveDir = liveRoot(root);
    const side = mySide();
    const startedAt = Date.now();
    const logDir = join(prac, 'swarm-logs');
    mkdirSync(logDir, { recursive: true });
    mkdirSync(liveDir, { recursive: true });
    if (process.env.DEMO_OK !== '1') { console.log('swarm: set DEMO_OK=1 (live server)'); process.exit(2); }

    const lockFile = join(root, controllerNamed('swarm').lease);
    const skipLock = process.env.SWARM_NO_LOCK === '1';
    if (!skipLock && !takeLease(lockFile, process.pid)) {
        console.log('swarm: another swarm controller holds ' + lockFile);
        process.exit(2);
    }
    const releaseSwarmLock = () => { if (!skipLock) releaseLease(lockFile); };

    let lease: ReturnType<typeof acquireFleetLease>;
    try { lease = acquireFleetLease(root, side); infraBreaker.recordSuccess('remote_git_claim'); }
    catch (error) { releaseSwarmLock(); observeSwarmInfraFault(infraBreaker, error); console.log('SWARM ' + String(error)); process.exit(2); }
    process.env.SWARM_LEASE_HOLDER = lease.holder;
    let renewAt = performance.now() + FLEET_LEASE_RENEW_MS;
    const assertLease = () => { if (!lease.allows()) throw Error('fleet controller lease unavailable'); };

    if (!skipLock) {
        saveLaunch(join(root, controllerNamed('swarm').launch), [planFile]);
    }
    const ownerFile = join(liveDir, 'swarm-owner.json');
    const startSource = cachedLaunchRevision(root);
    pinControllerRelease(process.env, startSource);
    atomicJson(ownerFile, {
        pid: process.pid,
        nonce,
        source: startSource,
        plan: planFile,
        side,
        at: Date.now(),
        ...(watchId ? { watchId } : {}),
    });

    const cleanupOwner = () => {
        releaseSwarmLock();
        try {
            const cur = JSON.parse(readFileSync(ownerFile, 'utf8'));
            if (cur?.pid === process.pid && cur?.nonce === nonce) rmSync(ownerFile, { force: true });
        } catch { /* ignore */ }
    };
    process.on('exit', cleanupOwner);

    const knowledgeRoot = existsSync(join(root, 'knowledge', 'items.json')) ? root : repoRoot;
    const catalog = defaultActivityCatalog(knowledgeRoot);
    const rateStore = createRateStore({ catalog, root, persist: true });
    const classifier = new OutcomeClassifier({ rateStore, root, persist: true });
    const brainCycleMsRaw = Number(process.env.BRAIN_CYCLE_MS);
    const brainCycleMs = Number.isFinite(brainCycleMsRaw) && brainCycleMsRaw >= 1000 ? brainCycleMsRaw : DEFAULT_BRAIN_CYCLE_MS;
    type RetainedBrainResult = {
        readonly dispatchedPlans: BrainCycleResult['dispatchedPlans'];
        readonly world: { readonly accounts: Record<string, Pick<BrainCycleResult['world']['accounts'][string], 'name' | 'role' | 'skills'>> };
        readonly fleetPlan: { readonly accountPlans: Record<string, Pick<BrainCycleResult['fleetPlan']['accountPlans'][string], 'steps' | 'idleReason'>> };
        readonly fleetState: {
            readonly goals: readonly Pick<BrainCycleResult['fleetState']['goals'][number], 'id' | 'active' | 'remaining'>[];
            readonly quarantinedDefects: BrainCycleResult['fleetState']['quarantinedDefects'];
        };
    };
    let lastBrainResult: RetainedBrainResult | null = null;
    let lastBrainAt = 0;
    // Accounts whose brain run this swarm stopped, and when. For two brain cycles such an account is no hub-trade
    // party, unless the stop was the planned fleet_trade handoff: a trade that names a just-stopped account is the
    // plan flapping, and its partner then waits the whole trade window for "partner failed: no trade".
    const brainDropAt = new Map<string, number>();
    const transferPartyHold = (account: string): string | undefined => {
        const at = brainDropAt.get(account.toLowerCase());
        return at !== undefined && Date.now() - at < 2 * brainCycleMs ? `swarm stopped its run ${Math.round((Date.now() - at) / 1000)}s ago` : undefined;
    };
    let hiscoreRefreshAt = 0, hiscoreRefreshRunning = false;
    // The accounts of the current tick's brain jobs (start() marks their runs) and the drop count of each brain run.
    let brainDispatchedNow: ReadonlySet<string> = new Set();
    const brainDrops = new Map<string, { cycles: number; cycleAt: number }>();
    let lastBrainPlanMtime = -1;
    let brainDirty = true;

    const runs = new Map<string, Run>();
    const recoveryDispatch = createRecoveryDispatch({ base: root, server: LIVE_SERVER });
    let inheritedRecoveries: ReturnType<typeof heldRecoveryOwners> = [];
    let heldSlot: RecoverySlot = { until: 0 };
    let orphanScanAt = 0;
    const leaseRefusals = new Map<string, string>();
    const previousEnabled = new Map<string, boolean>();
    const pendingResume = new Set<string>();
    const deathsFile = join(prac, 'swarm-deaths.json');
    const repairFile = join(prac, 'swarm-repair.json');
    const ended = loadEnded(deathsFile);
    const noOpGuard = new NoOpRunGuard(noOpRunsFile(liveRoot(root)));
    const noOpHold = (account: string, signature: string): string | undefined =>
        noOpGuard.hold(account, signature, statusFingerprint(statusHit(account)?.data));
    const holdsFile = join(prac, 'swarm-script-holds.json');
    const holds: ScriptHold[] = [];
    let holdsStamp = syncDeathHolds(holdsFile, holds, { mtimeMs: -1, size: -1 });
    const setEnded = ended.set.bind(ended);
    ended.set = (a, r) => {
        setEnded(a, r);
        persistEnded(deathsFile, ended);
        return ended;
    };
    // An operator resume_account removes the account's end record here, in the map that each persist writes back
    // (brain-runtime.ts applyCommand): an end that is not a death always, and a death only with clearDead.
    const clearDeath = (account: string, death = true): number => {
        const key = account.toLowerCase();
        const gone = [...ended].filter(([name, r]) => name.toLowerCase() === key && (death || !/^died\b/i.test(r.reason.trim())));
        for (const [name] of gone) ended.delete(name);
        if (gone.length) persistEnded(deathsFile, ended);
        return gone.length;
    };
    const stopFile = (a: string) => join(prac, `stop-${a}`);
    let tickStatusByLower: Map<string, { file: string; mtimeMs: number; data: any }> | null = null;
    const statusHit = (a: string) => tickStatusByLower?.get(a.toLowerCase()) ?? readAccountStatusData(root, a);
    const statusAge = (a: string) => {
        const hit = statusHit(a);
        if (!hit || hit.data?.server !== LIVE_SERVER) return Infinity;
        return Date.now() - hit.mtimeMs;
    };
    const statusStarted = (a: string): number | undefined => {
        const s = statusHit(a)?.data;
        return s && typeof s.name === 'string' && s.name.toLowerCase() === a.toLowerCase()
            && s.server === LIVE_SERVER && Number.isFinite(s.started) ? s.started : undefined;
    };
    const botsRunning = () => [...runs.values()].reduce((n, r) => n + r.accounts.length, 0) + (recoveryDispatch.active ? 1 : 0) + inheritedRecoveries.length;
    const pendingCount = () => pendingStartupCount([...runs.values()], Date.now())
        + (recoveryDispatch.active && Date.now() - recoveryDispatch.active.started < 30_000 ? 1 : 0)
        + inheritedRecoveries.filter(r => Date.now() - r.started < 30_000).length;

    const runsFile = join(prac, 'swarm-runs.json');
    const adopted = new Set<Run>();
    let pidStarts: ReturnType<typeof processStartTimes> = null, pidStartsAt = 0;
    const readPidStarts = () => { pidStartsAt = Date.now(); pidStarts = adopted.size ? processStartTimes([...adopted].map(r => r.pid)) : null; };
    const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } };
    // Runs are detached and outlive this process. The session-recovery child is attached and dies with it, so a signal
    // asks it to log out first (worker-stop.ts).
    const signalStop = swarmSignalStop({
        active: () => recoveryDispatch.active,
        alive: pidAlive,
        writeStop: a => writeSwarmStop(stopFile(a), SWARM_STOP.recovery),
    });
    process.on('SIGINT', signalStop.onSignal);
    process.on('SIGTERM', signalStop.onSignal);
    const saveRuns = () => {
        try {
            const tmp = `${runsFile}.tmp-${process.pid}`;
            writeFileSync(tmp, JSON.stringify([...runs].map(([key, r]) => ({ key, ...r })), null, 1));
            renameRetry(tmp, runsFile);
        } catch (e) { console.log(`SWARM runs file not saved: ${String(e)}`); }
    };

    const pools = new Map<string, HostPoolSlot>();
    const poolExited = new Set<string>();
    const canceledPooled = new Set<string>();
    const poolActiveCount = (poolId: string): number => {
        let count = 0;
        for (const r of runs.values()) if (r.poolId === poolId) count += r.accounts.length;
        return count;
    };
    const poolSlotAlive = (pool: HostPoolSlot): boolean =>
        !poolExited.has(pool.id) && adoptedRunAlive({ pid: pool.pid, started: pool.started }, pidAlive, pidStarts);
    const drainPool = (pool: HostPoolSlot) => {
        if (pool.draining) return;
        pool.draining = true;
        try { sendPoolCommand(root, pool.id, { op: 'drain', id: `drain-${randomUUID().slice(0, 8)}` }); } catch { /* pool may already be gone */ }
    };
    const cancelPooledBot = (run: Run, account: string) => {
        if (!run.poolId) return;
        const token = `${run.poolId}:${account.toLowerCase()}`;
        if (canceledPooled.has(token)) return;
        canceledPooled.add(token);
        try { sendPoolCommand(root, run.poolId, { op: 'cancel', id: `cancel-${account}-${randomUUID().slice(0, 6)}`, bot: account, reason: 'stop file' }); }
        catch { /* stop file still ends the bot */ }
    };
    const spawnHostPool = (source: string): HostPoolSlot => {
        const poolId = `pool-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
        const poolLogPath = join(logDir, `${poolId}.log`);
        rotateLog(poolLogPath);
        const out = openSync(poolLogPath, 'a');
        let child: ReturnType<typeof spawnChild>;
        try {
            const cmd = poolCommand(poolId, source);
            child = spawnChild(cmd[0]!, cmd.slice(1), {
                cwd: root, detached: true, windowsHide: true, stdio: ['ignore', out, out],
                env: leanBunEnv({
                    ...process.env,
                    ...workerRouteServiceEnv(process.env),
                    SWARM_BOTS: String(POOL_MAX_BOTS),
                    SWARM_LEASE_HOLDER: lease.holder,
                    WORKER_RELEASE: source,
                    DEMO_OK: '1',
                }),
            });
        } finally { closeSync(out); }
        if (!child.pid) throw Error('host pool did not start');
        child.unref();
        const slot: HostPoolSlot = { id: poolId, pid: child.pid, started: Date.now(), source, launches: 0, draining: false };
        pools.set(poolId, slot);
        child.on('exit', () => { poolExited.add(poolId); pools.delete(poolId); });
        console.log(`SWARM start host-pool ${poolId} pid=${child.pid} maxBots=${POOL_MAX_BOTS}`);
        return slot;
    };

    const follow = (key: string, run: Run, child?: { on(e: 'exit', f: (code: number | null) => void): unknown }) => {
        let tail = '', currentEnd: string | undefined, diedNames: string[] | undefined, lastResultLine: string | undefined, exitCode: number | null | undefined, done = false;
        let lastFullResult: string | undefined;
        const consume = (line: string) => {
            observeSwarmInfraFault(infraBreaker, line);
            const resMatch = line.match(/(?:^|\s)(RESULT\s+(?:ok|fail)\s+.*)$/);
            if (resMatch) [lastResultLine, lastFullResult] = resultLineOf(line, resMatch[1]!, lastFullResult);
            if (!run.host) { currentEnd = supervisorEndLine(line) ?? currentEnd; diedNames = diedAccountsOf(line) ?? diedNames; return; }
            const m = line.match(/^SUPERVISE-HOST account (.+?) ([\w-]+) after \d+ runs/);
            if (m) { ended.set(m[1]!, { at: Date.now(), reason: m[2]!, revision: run.revision }); console.log(`SWARM end ${m[1]} ${m[2]} (host)`); }
        };
        const read = () => {
            let size = 0;
            try { size = statSync(run.log).size; } catch { return; }
            if (size <= run.offset) return;
            const fd = openSync(run.log, 'r');
            try {
                const buf = Buffer.alloc(size - run.offset);
                run.offset += readSync(fd, buf, 0, buf.length, run.offset);
                const lines = (tail + buf.toString('utf8')).split(/\r?\n/);
                tail = lines.pop() ?? '';
                for (const line of lines) consume(line);
            } finally { closeSync(fd); }
        };
        const finish = () => {
            if (done) return;
            done = true; clearInterval(timer);
            brainDirty = true;
            read(); if (tail) consume(tail);
            runs.delete(key); adopted.delete(run);
            if (run.poolId) for (const a of run.accounts) canceledPooled.delete(`${run.poolId}:${a.toLowerCase()}`);
            saveRuns();
            const code = exitCode === undefined ? 'unknown' : exitCode;
            if (!run.host) {
                const reason = currentEnd ?? `exit ${code}`;
                const ends = endsOfRun(run.accounts, reason, diedNames);
                for (const account of run.accounts) {
                    const own = ends.get(account)!;
                    const diedRun = /^died\b/i.test(own);
                    let keepEnded = true;
                    const outcomeActId = chainOutcomeActivity(run.chainActivityIds, lastResultLine, run.activityId ?? run.outcomeActivityId);
                    if (outcomeActId && run.accounts.length === 1 && !gateHeldRunEnd(own, lastResultLine)) {
                        try {
                            const raw = extractWorkerOutcomeInput({
                                root,
                                account,
                                activityId: outcomeActId,
                                server: LIVE_SERVER,
                                startedAt: run.started,
                                finishedAt: Date.now(),
                                exitCode: typeof exitCode === 'number' ? exitCode : undefined,
                                endReason: own,
                                successful: successfulEnd(own),
                                died: diedRun,
                                lastResultLine,
                                logPath: run.log,
                                workerRelease: run.workerRelease,
                                baseline: run.baseline,
                                ...(run.isMultiStepChain ? { skipRateSample: true } : {}),
                                ...(run.marketItemId !== undefined ? { marketItemId: run.marketItemId } : {}),
                                ...(run.marketVenue ? { marketVenue: run.marketVenue } : {}),
                            });
                            const outcomeRes = recordWorkerOutcome({
                                root, catalog, rateStore, classifier, domain: 'live',
                                ...(run.workerRelease ? { workerRelease: run.workerRelease } : {}),
                                ...(run.workerEntries?.length ? { workerEntries: run.workerEntries } : {}),
                                raw,
                            });
                            if (outcomeRes.outcome.kind === 'infra_fault' && !diedRun && !successfulEnd(own)) {
                                try {
                                    if (readLogoutProof(account, LIVE_SERVER, { base: root }).state !== 'held') keepEnded = false;
                                } catch { /* keep ended on unreadable proof */ }
                            }
                        } catch { /* outcome persistence errors never stop controller */ }
                    }
                    if (run.accounts.length === 1) {
                        try {
                            const endStatus = readAccountStatusData(root, account)?.data;
                            // A recovery run has no activity, so no outcome above ends its stranded hold. The end tile
                            // of its RESULT line is where it stands now; the status file is the fallback.
                            const endTile = resultEndTile(lastResultLine) ?? (isPlainTile(endStatus?.pos) ? endStatus.pos : undefined);
                            if (run.locationRecovery && locationRecoveryArrived(own, endTile) && classifier.clearLocationRecovery(account)) {
                                console.log(`SWARM recovery done ${account} at ${endTile!.x},${endTile!.z},${endTile!.level}: stranded hold cleared`);
                            }
                            const held = noOpGuard.note({
                                account, signature: run.revision, job: run.label ?? run.revision.slice(0, 120), ok: successfulEnd(own),
                                before: run.fingerprint, after: statusFingerprint(endStatus), now: Date.now(),
                            });
                            if (held) console.log(`SWARM no-op hold ${account} after ${held.runs} ok runs with no change at ${held.fingerprint.pos}: ${held.job}`);
                        } catch { /* a no-op note never stops the controller */ }
                    }
                    if (keepEnded) {
                        const endReason = run.brain ? brainStopEnd(own, lastResultLine, readStopFile(account, root)) : own;
                        ended.set(account, { at: Date.now(), reason: endReason, revision: run.revision, ...(run.workerRelease ? { release: run.workerRelease } : {}), ...stockOutEnd(run, own, lastResultLine) });
                        console.log(`SWARM end ${account} ${endReason}`);
                    } else {
                        const existingKey = [...ended.keys()].find(n => n.toLowerCase() === account.toLowerCase());
                        if (existingKey) {
                            ended.delete(existingKey);
                            persistEnded(deathsFile, ended);
                        }
                        console.log(`SWARM infra-fault exit ${account} ${own} (logout clean; retry allowed after backoff)`);
                    }
                }
            } else {
                for (const a of run.accounts) {
                    if ((ended.get(a)?.at ?? 0) >= run.started) continue;
                    ended.set(a, { at: Date.now(), reason: `exit ${code}`, revision: run.revision, ...(run.workerRelease ? { release: run.workerRelease } : {}) });
                    console.log(`SWARM end ${a} exit ${code} (host)`);
                }
            }
        };
        const timer = setInterval(() => {
            const before = run.offset;
            read();
            if (run.offset !== before) saveRuns();
            if (run.poolId && currentEnd) {
                exitCode = /^done\b/.test(currentEnd) ? 0 : 1;
                finish();
                return;
            }
            const livenessRun = run.poolId ? { pid: run.pid, started: run.poolStarted ?? run.started } : run;
            if (!child && ((run.poolId && poolExited.has(run.poolId)) || !adoptedRunAlive(livenessRun, pidAlive, pidStarts))) finish();
        }, 2000);
        child?.on('exit', code => { exitCode = code; finish(); });
    };

    for (const saved of (() => { try { return JSON.parse(readFileSync(runsFile, 'utf8')) as SavedRun[]; } catch { return []; } })()) {
        if (!saved?.key || !Number.isSafeInteger(saved.pid) || !Array.isArray(saved.accounts) || runs.has(saved.key)) continue;
        const { key, ...run } = saved;
        runs.set(key, run); adopted.add(run);
    }
    readPidStarts();
    for (const [key, run] of runs) {
        const livenessRun = run.poolId ? { pid: run.pid, started: run.poolStarted ?? run.started } : run;
        const aliveNow = adoptedRunAlive(livenessRun, pidAlive, pidStarts);
        const state = !pidAlive(run.pid) ? ' (ended)' : aliveNow ? '' : ' (ended: a later process holds the pid)';
        console.log(`SWARM adopt ${run.poolId ? `pooled ${run.accounts[0]} (${run.poolId})` : run.host ? `host ${run.accounts.join(',')}` : run.accounts[0]} pid ${run.pid}${state}`);
        if (run.poolId && aliveNow && !pools.has(run.poolId)) {
            let metaSource = '', metaStarted = run.poolStarted ?? run.started;
            try {
                const meta = JSON.parse(readFileSync(join(swarmPoolDir(root, run.poolId), 'meta.json'), 'utf8'));
                if (typeof meta?.source === 'string') metaSource = meta.source;
                if (Number.isFinite(meta?.startedAt)) metaStarted = meta.startedAt;
            } catch { /* missing meta drains safely */ }
            const slot: HostPoolSlot = {
                id: run.poolId,
                pid: run.pid,
                started: metaStarted,
                source: metaSource,
                launches: poolActiveCount(run.poolId),
                draining: !metaSource || metaSource !== startSource,
            };
            pools.set(run.poolId, slot);
            if (slot.draining) {
                try { sendPoolCommand(root, slot.id, { op: 'drain', id: `drain-adopt-${randomUUID().slice(0, 6)}` }); } catch { /* ignore */ }
            }
        }
        follow(key, run);
    }
    saveRuns();

    const start = (p: ParsedJob, accounts: string[]) => withSessionAdmission(accounts, root, () => {
        const job = p.job;
        const revision = missionSignature(job);
        const logName = p.host ? `host-${accounts[0]}.log` : `${accounts[0]}.log`, logPath = join(logDir, logName);
        rotateLog(logPath);
        const offset = existsSync(logPath) ? statSync(logPath).size : 0, out = openSync(logPath, 'a');
        const fingerprint = accounts.length === 1 && !p.host ? statusFingerprint(readAccountStatusData(root, accounts[0]!)?.data) : undefined;
        const baseline = accounts.length === 1 && job.activityId
            ? captureRunBaseline(root, accounts[0]!, LIVE_SERVER) ?? undefined
            : undefined;
        const usePool = canUseHostPool(p) && accounts.length === 1;
        let child: ReturnType<typeof spawnChild> | undefined;
        let poolSlot: HostPoolSlot | undefined;
        let poolAttached = false;
        let workRelease: string | undefined;
        let workEntries: string[] = [];
        try {
            const entries = workerEntries(job.script, job.args ?? [], root);
            workEntries = entries;
            workRelease = cachedReleaseFor(entries, root);
            assertLease();
            writeSync(out, jobLogStart(job));
            const sharedBotEnv: Record<string, string> = {
                ...(job.env ?? {}),
                ...workerRouteServiceEnv(process.env, job.env),
                SWARM_LEASE_HOLDER: lease.holder,
                SWARM_MISSION_HASH: createHash('sha256').update(revision).digest('hex'),
                WORKER_RELEASE: workRelease,
                WORKER_ENTRY: entries.join(','),
                DEMO_OK: '1',
                BOT_ROLE: job.role ?? '',
                BOT_GOAL: job.goal ?? '',
                STANDING: job.standing ? '1' : '',
            };
            if (usePool) {
                const existing = selectHostPool(pools.values(), poolActiveCount, poolSlotAlive, startSource);
                poolSlot = existing ?? spawnHostPool(startSource);
                poolAttached = existing !== null;
                poolSlot.idleSince = undefined;
                poolSlot.launches++;
                sendPoolCommand(root, poolSlot.id, {
                    op: 'start',
                    id: `start-${accounts[0]}-${randomUUID().slice(0, 6)}`,
                    bot: accounts[0]!,
                    script: job.script,
                    args: job.args ?? [],
                    maxRestarts: job.maxRestarts ?? 20,
                    env: { ...sharedBotEnv, SWARM_BOTS: String(POOL_MAX_BOTS) },
                    logPath,
                });
            } else {
                const cmd = supervisorCommand(p, accounts);
                child = spawnChild(cmd[0]!, cmd.slice(1), {
                    cwd: root, detached: true, windowsHide: true, stdio: ['ignore', out, out],
                    env: leanBunEnv({
                        ...process.env, ...sharedBotEnv, ...botCountEnv(accounts),
                    }),
                });
            }
        } finally { closeSync(out); }
        const pid = poolSlot ? poolSlot.pid : child?.pid;
        if (!pid) throw Error('supervisor did not start');
        child?.unref();
        const run: Run = {
            pid, started: Date.now(), accounts, revision, host: p.host, log: logPath, offset,
            ...(poolSlot ? { poolId: poolSlot.id, poolStarted: poolSlot.started, poolAttached } : {}),
            ...(job.activityId ? { activityId: job.activityId } : {}),
            ...(job.outcomeActivityId ? { outcomeActivityId: job.outcomeActivityId } : {}),
            ...(job.isMultiStepChain ? { isMultiStepChain: true } : {}),
            ...(job.chainActivityIds ? { chainActivityIds: job.chainActivityIds } : {}),
            ...(job.marketItemId !== undefined ? { marketItemId: job.marketItemId } : {}),
            ...(job.marketVenue ? { marketVenue: job.marketVenue } : {}),
            ...(job.demandId ? { demandId: job.demandId } : {}),
            ...(workRelease ? { workerRelease: workRelease } : {}),
            ...(workEntries.length ? { workerEntries: workEntries } : {}),
            ...(baseline ? { baseline } : {}),
            ...(fingerprint ? { fingerprint } : {}),
            ...(job.locationRecovery ? { locationRecovery: true } : {}),
            label: job.outcomeActivityId ?? job.activityId ?? [job.script, ...(job.args ?? [])].join(' ').slice(0, 120),
            ...(brainDispatchedNow.has(accounts[0]!.toLowerCase())
                ? { brain: true, ...(job.maxRestarts !== undefined ? { finite: true } : {}) }
                : {}),
        };
        runs.set(p.key, run); saveRuns();
        console.log(`SWARM start ${poolSlot ? `pooled ${accounts[0]} (${poolSlot.id})` : p.host ? `host ${accounts.join(',')}` : accounts[0]} ${job.script} ${JSON.stringify(job.env ?? {})}`);
        follow(p.key, run, child);
    });

    // The release a start of the job would pin (the run start's workRelease); undefined when its entries do not resolve.
    const jobReleaseOf = (job: Job): string | undefined => {
        try { return cachedReleaseFor(workerEntries(job.script, job.args ?? [], root), root); } catch { return undefined; }
    };
    const readPendingUpdateMark = pendingUpdateReader(root);
    const updateDrainOf = (pending: PendingUpdate | null, job: Job): string[] => {
        if (!pending) return [];
        try { return drainedFiles(pending, workerEntries(job.script, job.args ?? [], root), root); } catch { return []; }
    };
    let cachedPlan: { mtimeMs: number; size: number; data: Plan } | null = null;
    let cachedOwners: { file: string; mtimeMs: number; size: number; owners: Map<string, Owner> } | null = null;

    const tick = () => {
        if (!skipLock && !renewLease(lockFile)) {
            console.log('SWARM lost local controller lease; exiting to avoid split-brain');
            process.exit(2);
        }
        if (adopted.size && Date.now() - pidStartsAt >= 60_000) readPidStarts();
        if (performance.now() >= renewAt && lease.allows()) {
            let landed = true;
            try { lease.renew(); infraBreaker.recordSuccess('remote_git_claim'); }
            catch (error) { landed = false; observeSwarmInfraFault(infraBreaker, error); console.log('SWARM ' + String(error)); }
            renewAt = performance.now() + (landed || !lease.allows() ? FLEET_LEASE_RENEW_MS : FLEET_LEASE_RETRY_MS);
        }
        // While a signal waits for the recovery logout, the swarm keeps its leases and starts nothing.
        if (signalStop.stopping) return;
        if (!lease.allows()) {
            const accounts = new Set([...runs.values()].flatMap(r => r.accounts));
            if (recoveryDispatch.active) accounts.add(recoveryDispatch.active.account);
            for (const held of heldRecoveryOwners(root)) accounts.add(held.account);
            for (const account of accounts) {
                try { writeSwarmStop(stopFile(account), SWARM_STOP.lease); }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') console.log('SWARM could not request lease-loss logout for ' + account);
                }
            }
            if (!accounts.size) { console.log('SWARM stopped (fleet controller lease unavailable)'); process.exit(2); }
            return;
        }
        const nowWall = Date.now();
        let plan: Plan;
        let planMtime = 0;
        try {
            const pst = statSync(planFile);
            planMtime = pst.mtimeMs;
            if (cachedPlan && nowWall - pst.mtimeMs > 1000 && cachedPlan.mtimeMs === pst.mtimeMs && cachedPlan.size === pst.size) {
                plan = cachedPlan.data;
            } else {
                plan = JSON.parse(readFileSync(planFile, 'utf8'));
                cachedPlan = { mtimeMs: pst.mtimeMs, size: pst.size, data: plan };
            }
        } catch (e) { console.log(`SWARM bad plan: ${String(e)}`); return; }
        holdsStamp = syncDeathHolds(holdsFile, holds, holdsStamp, nowWall);
        if (!Array.isArray(plan.jobs) || !Number.isFinite(plan.maxBots) || plan.maxBots < 1 || !Number.isFinite(plan.minFreeGB)) {
            console.log('SWARM bad plan shape'); return;
        }

        // Run Brain cycle on normal swarm controllers (local and cloud sides) to drain OperatorCommands,
        // publish FleetState, and plan autonomous jobs for accounts not governed by explicit hand jobs.
        const combinedJobs: Job[] = [...plan.jobs];
        const brainRecoveryRows: Record<string, unknown>[] = [];
        const brainDispatchedAccounts = new Set<string>();
        brainDispatchedNow = brainDispatchedAccounts;
        const brainModes = new Map<string, SelectedBrainDispatch['mode']>();
        const brainEnabled = !plan.boundedRecovery && !plan.boundedInspection;
        if (brainEnabled && hiscoreRefreshDue({ now: Date.now(), lastAt: hiscoreRefreshAt, running: hiscoreRefreshRunning })) {
            hiscoreRefreshAt = Date.now();
            hiscoreRefreshRunning = true;
            try {
                startHiscoreRefresh(root, () => { hiscoreRefreshRunning = false; });
            } catch (error) {
                // A log or spawn error before the child exists gives no exit event; the next interval tries again.
                hiscoreRefreshRunning = false;
                console.log(`SWARM hiscore refresh did not start: ${String(error).slice(0, 160)}`);
            }
        }
        if (brainEnabled) {
            try {
                const nowMs = Date.now();
                // Outcomes that the fleet agent queued (a trade with no route) go into this controller's classifier,
                // which owns outcome-state.json.
                const queued = drainWorkerOutcomeInbox(root, raw => {
                    recordWorkerOutcome({ root, catalog, rateStore, classifier, domain: 'live', raw });
                });
                if (queued > 0) brainDirty = true;
                const cmdDir = operatorCommandsDir(root);
                let hasPendingCommands = false;
                try {
                    hasPendingCommands = existsSync(cmdDir) && readdirSync(cmdDir).some(f => f.endsWith('.json'));
                } catch { /* ignore */ }

                if (brainCycleDue({
                    hasCached: lastBrainResult !== null,
                    dirty: brainDirty,
                    now: nowMs,
                    lastAt: lastBrainAt,
                    intervalMs: brainCycleMs,
                    hasPendingCommands,
                    planMtime,
                    lastPlanMtime: lastBrainPlanMtime,
                })) {
                    const activeMap = new Map<string, AccountActiveJob>();
                    for (const run of runs.values()) {
                        for (const acct of run.accounts) {
                            activeMap.set(acct.toLowerCase(), {
                                activityId: run.activityId ?? run.outcomeActivityId ?? 'hand:swarm',
                                demandId: run.demandId ?? 'hand:swarm',
                                startedAt: run.started,
                            });
                        }
                    }
                    // Only an account with an end record, or a plan that starts with a recovery, can be held.
                    const endedLower = endedMapByLower(ended);
                    const heldPlan = (account: string, accountPlan: AccountPlan): string | undefined =>
                        endedLower.has(account.toLowerCase()) || accountPlan.steps[0]?.stepKind === 'recover'
                            ? brainPlanHold(brainJobFor(account, dispatchAccountPlan(accountPlan, { catalog }), accountPlan.steps), ended, statusAge, statusStarted, Date.now(), jobReleaseOf, noOpHold)
                            : undefined;
                    // A cycle that throws keeps the last result: without brain jobs in the plan, the stop pass
                    // below would write SWARM_STOP.removed for every brain-dispatched worker.
                    try {
                        const rawBrain = runBrainCycle({
                            root, side, server: LIVE_SERVER, maxBots: plan.maxBots,
                            catalog, rateStore, classifier, infraBreaker,
                            activeAccounts: activeMap, persist: true, consumeCommands: true,
                            heldPlan, clearDeath, transferPartyHold,
                        });
                        // Retain only the slim fields swarm.ts reads between ticks (drops banks/inventories/quests/diagnostics).
                        const slimAccounts: Record<string, Pick<BrainCycleResult['world']['accounts'][string], 'name' | 'role' | 'skills'>> = {};
                        for (const [k, a] of Object.entries(rawBrain.world.accounts)) {
                            slimAccounts[k] = { name: a.name, role: a.role, skills: a.skills };
                        }
                        const slimPlans: Record<string, Pick<BrainCycleResult['fleetPlan']['accountPlans'][string], 'steps' | 'idleReason'>> = {};
                        for (const [k, p] of Object.entries(rawBrain.fleetPlan.accountPlans)) {
                            slimPlans[k] = { steps: p.steps, ...(p.idleReason !== undefined ? { idleReason: p.idleReason } : {}) };
                        }
                        lastBrainResult = {
                            dispatchedPlans: rawBrain.dispatchedPlans,
                            world: { accounts: slimAccounts },
                            fleetPlan: { accountPlans: slimPlans },
                            fleetState: {
                                goals: rawBrain.fleetState.goals.map(g => ({ id: g.id, active: g.active, remaining: g.remaining })),
                                quarantinedDefects: rawBrain.fleetState.quarantinedDefects,
                            },
                        };
                        lastBrainAt = nowMs;
                        lastBrainPlanMtime = planMtime;
                        brainDirty = false;
                        for (const [k, at] of brainDropAt) if (nowMs - at >= 2 * brainCycleMs) brainDropAt.delete(k);
                    } catch (error) {
                        console.log(`SWARM brain cycle failed, last plan kept: ${String(error)}`);
                    }
                }

                const brainResult = lastBrainResult;
                if (brainResult) {
                    const handAccountSet = new Set(
                        plan.jobs.flatMap(j => j.accounts ?? (j.account ? [j.account] : [])).map(a => a.toLowerCase()),
                    );
                    for (const [acctName, dispatched] of Object.entries(brainResult.dispatchedPlans)) {
                        if (handAccountSet.has(acctName.toLowerCase())) continue;
                        const acctState = brainResult.world.accounts[acctName.toLowerCase()];
                        const accountSteps = brainResult.fleetPlan.accountPlans[acctName]?.steps ?? [];
                        const { selected, job: brainJob } = brainJobFor(acctName, dispatched, accountSteps, acctState?.role);
                        brainModes.set(acctName.toLowerCase(), selected.mode);
                        if (selected.mode === 'session_recovery') {
                            brainRecoveryRows.push({
                                account: acctName,
                                script: '',
                                role: acctState?.role,
                                goal: 'session recovery',
                                enabled: false,
                                repeat: false,
                                state: BRAIN_RECOVERY_WAIT,
                                since: null,
                            });
                            continue;
                        }
                        if (selected.mode === 'fleet_trade') {
                            brainRecoveryRows.push({
                                account: acctName,
                                script: '',
                                role: acctState?.role,
                                goal: dispatched.demandId ?? 'fleet trade',
                                enabled: false,
                                repeat: false,
                                state: 'waiting: fleet-agent trade',
                                since: null,
                            });
                            continue;
                        }
                        if (!brainJob) continue;
                        brainDispatchedAccounts.add(acctName.toLowerCase());
                        combinedJobs.push(brainJob);
                    }
                }
            } catch (error) {
                console.log(`SWARM brain cycle skipped: ${String(error)}`);
            }
        }

        const stopFlagsPresent = new Set<string>();
        for (const dir of [liveDir, prac]) {
            if (!existsSync(dir)) continue;
            try {
                for (const f of readdirSync(dir)) {
                    if (f.length > 5 && f.slice(0, 5).toLowerCase() === 'stop-') {
                        stopFlagsPresent.add(f.slice(5).toLowerCase());
                    }
                }
            } catch { /* unreadable */ }
        }
        const stopAll = stopFlagsPresent.has('swarm');
        inheritedRecoveries = heldRecoveryOwners(root, recoveryDispatch.active ? [recoveryDispatch.active.account] : []);
        if (shouldSwarmReload({
            root,
            startedAt,
            recoveryActive: !!recoveryDispatch.active || inheritedRecoveries.length > 0,
            stopAll: stopAll || stopFlagsPresent.has('coordinator'),
        })) {
            saveRuns();
            cleanupOwner();
            try {
                const pid = respawnDaemon(root, swarmReloadArgs(root, planFile, watchId), join(logDir, `daemon-${Date.now()}.out.log`));
                if (!pid) throw Error('successor pid unavailable');
                console.log(`SWARM reload after live-update: successor pid ${pid}`);
                process.exit(0);
            } catch (err) {
                console.log(`SWARM reload respawn failed: ${String(err)}`);
                process.exit(2);
            }
        }
        if (stopAll && recoveryDispatch.active) {
            writeSwarmStop(stopFile(recoveryDispatch.active.account), SWARM_STOP.recovery);
            stopFlagsPresent.add(recoveryDispatch.active.account.toLowerCase());
        }
        if (stopAll) {
            for (const held of inheritedRecoveries) {
                writeSwarmStop(stopFile(held.account), SWARM_STOP.inherited);
                stopFlagsPresent.add(held.account.toLowerCase());
            }
        }
        const planned: ParsedJob[] = [];
        const parsedByRow: (ParsedJob | { error: string })[] = new Array(combinedJobs.length);
        for (let i = 0; i < combinedJobs.length; i++) {
            const j = combinedJobs[i]!;
            if (isReservation(j)) {
                parsedByRow[i] = { error: '' };
                continue;
            }
            const p = parseJob(j);
            parsedByRow[i] = p;
            if (!('error' in p)) planned.push(p);
        }
        const jobSignatures = new Map<ParsedJob, string>();
        for (const p of planned) jobSignatures.set(p, missionSignature(p.job));
        const accountEnabled = enabledByAccount(planned);

        if (Date.now() - orphanScanAt >= 60_000) {
            orphanScanAt = Date.now();
            for (const r of releaseExpiredRecoveryLeases(root, recoveryDispatch.active ? [recoveryDispatch.active.account] : [])) {
                if (leaseRefusals.get(r.account) !== r.reason) console.log(`SWARM recovery lease ${r.account}: ${r.reason}`);
                if (r.released) leaseRefusals.delete(r.account); else leaseRefusals.set(r.account, r.reason);
            }
            const busy = [...runs.values()].flatMap(r => r.accounts).concat(inheritedRecoveries.map(r => r.account), recoveryDispatch.active ? [recoveryDispatch.active.account] : []);
            const producer = (a: string, id: string) => {
                const receipt = listAttempts(a, LIVE_SERVER, { base: root }).find(x => x.attemptId === id)?.receipt;
                return receipt ? { pid: receipt.owner.pid, createdAt: receipt.createdAt, updatedAt: receipt.updatedAt } : undefined;
            };
            const accounts = planned.flatMap(p => p.accounts).concat(
                lifecycleReadRoots(root).flatMap(lcRoot => lifecycleAccounts(join(lcRoot, 'live', LIVE_SERVER))),
            );
            for (const [a, reason] of orphanedSessionEnds(accounts, ended, busy, a => readLogoutProof(a, LIVE_SERVER, { base: root }), producer, pidAlive, processStartTimes)) {
                ended.set(a, { at: Date.now(), reason });
                console.log(`SWARM end ${a} ${reason}`);
            }
            const resolved = resolvedOrphanEnds(ended, busy, a => readLogoutProof(a, LIVE_SERVER, { base: root }), Date.now());
            for (const r of resolved) {
                ended.delete(r.account);
                console.log(`SWARM end ${r.account} cleared: ${r.reason}; logout confirmed for attempt ${r.confirmed}`);
            }
            if (resolved.length) persistEnded(deathsFile, ended);
        }

        const droppedRuns = new Set<string>();
        for (const [key, r] of runs) if (r.brain && !overlappingRun(planned, r.accounts)) droppedRuns.add(key);
        countBrainDrops(brainDrops, droppedRuns, lastBrainAt);
        const handAccounts = new Set(plan.jobs.flatMap(j => j.accounts ?? (j.account ? [j.account] : [])).map(a => a.toLowerCase()));
        const brainIdle = (a: string): string | undefined => {
            const plans = lastBrainResult?.fleetPlan.accountPlans ?? {}, lower = a.toLowerCase();
            return (plans[a] ?? Object.entries(plans).find(([n]) => n.toLowerCase() === lower)?.[1])?.idleReason;
        };
        for (const [key, r] of runs) {
            if (!overlappingRun(planned, r.accounts) || stopAll) {
                const kept = stopAll ? undefined : brainDropKeep({
                    run: r, now: Date.now(), dropCycles: brainDrops.get(key)?.cycles ?? 0, stopAll,
                    brainActive: brainEnabled && lastBrainResult !== null,
                    handAccount: a => handAccounts.has(a.toLowerCase()),
                    held: a => holds.some(h => h.account.toLowerCase() === a.toLowerCase() && !h.restored),
                    ended: a => { const end = endedMapByLower(ended).get(a.toLowerCase())?.[1]; return !!end && end.at >= r.started; },
                    replacement: a => brainModes.get(a.toLowerCase()),
                    idleReason: brainIdle,
                    ...(lastBrainResult ? { ownJobOpen: (a: string) => brainJobOpen(lastBrainResult!, r, a, Date.now()) } : {}),
                });
                if (kept) {
                    for (const a of r.accounts) {
                        brainRecoveryRows.push({
                            account: a, script: '', goal: r.demandId ?? r.activityId, enabled: true, repeat: !r.finite,
                            state: `running; brain plan dropped it, kept: ${kept}`, since: r.started,
                        });
                    }
                    continue;
                }
                for (const a of r.accounts) {
                    if (r.brain && !stopAll && !existsSync(stopFile(a))) {
                        const mode = brainModes.get(a.toLowerCase());
                        console.log(`SWARM drop ${a} ${mode && mode !== 'none' ? mode : brainIdle(a) ?? 'no brain plan'} after ${Math.round((Date.now() - r.started) / 1000)}s`);
                        if (mode !== 'fleet_trade') brainDropAt.set(a.toLowerCase(), Date.now());
                    }
                    writeSwarmStop(stopFile(a), SWARM_STOP.removed);
                    cancelPooledBot(r, a);
                    stopFlagsPresent.add(a.toLowerCase());
                }
            }
        }
        const statusEntries = readAllStatusEntries(root);
        const statuses = statusEntries.statuses;
        tickStatusByLower = statusEntries.byLower;
        try {
        let endStateOk = inheritedRecoveries.every(r => r.source === process.env.WORKER_RELEASE);
        const claimedRepair = `${repairFile}.processing`;
        try {
            if (!existsSync(claimedRepair) && existsSync(repairFile)) renameSync(repairFile, claimedRepair);
            if (existsSync(claimedRepair)) {
                const raw = readFileSync(claimedRepair, 'utf8');
                let request: any, result = { changed: false, reason: 'invalid repair JSON' };
                try { request = JSON.parse(raw); } catch { /* retained in the receipt */ }
                if (!recoveryDispatch.handle(raw, _req => {
                    assertLease();
                    const active = [...runs.values()].flatMap(r => r.accounts).concat(activeExternalLive(statuses, [], Date.now()));
                    admitRecovery({
                        account: request.account, active, running: botsRunning(),
                        external: activeExternalLive(statuses, [...runs.values()].flatMap(r => r.accounts).concat(inheritedRecoveries.map(r => r.account)), Date.now()).length,
                        pending: pendingCount(), freeGB: freemem() / 2 ** 30, minFreeGB: plan.minFreeGB, maxBots: plan.maxBots,
                    });
                })) {
                    const before = new Map(ended), holdsBefore = structuredClone(holds);
                    const active = [...runs.values()].flatMap(r => r.accounts).concat(activeExternalLive(statuses, [], Date.now()));
                    const proofs: RepairProofs = {
                        ...defaultRepairProofs,
                        status: a => statusHit(a)?.data,
                        statusSha256: a => {
                            const hit = readAccountStatus(root, a);
                            return hit ? createHash('sha256').update(hit.raw).digest('hex') : undefined;
                        },
                    };
                    if (request) {
                        result = request.kind === 'script-qualified' ? applyScriptQualification(request, holds, active, proofs)
                            : request.kind === 'kit-restored' ? applyKitRestored(request, holds, active, proofs)
                            : applyEndRepair(request, ended, active, proofs, holds);
                    }
                    if (result.changed) {
                        try { persistHolds(holdsFile, holds); persistEnded(deathsFile, ended); }
                        catch (e) {
                            Map.prototype.clear.call(ended);
                            for (const [name, end] of before) Map.prototype.set.call(ended, name, end);
                            holds.splice(0, holds.length, ...holdsBefore);
                            try { persistHolds(holdsFile, holds); } catch { /* retain original */ }
                            throw e;
                        }
                    }
                    appendFileSync(`${repairFile}.results.jsonl`, JSON.stringify({ at: Date.now(), raw, result }) + '\n');
                    rmSync(claimedRepair);
                    console.log(`SWARM repair ${request?.account ?? '?'}: ${result.reason}`);
                }
            }
        } catch (e) { endStateOk = false; console.log(`SWARM repair unavailable; new starts paused: ${String(e)}`); }

        let cachedExternalCount: number | null = null;
        const externalCount = () => {
            if (cachedExternalCount === null) {
                const known: string[] = [];
                for (const r of runs.values()) for (const a of r.accounts) known.push(a);
                if (recoveryDispatch.active) known.push(recoveryDispatch.active.account);
                for (const r of inheritedRecoveries) known.push(r.account);
                cachedExternalCount = activeExternalLive(statuses, known, Date.now()).length;
            }
            return cachedExternalCount;
        };
        const startedAccounts: string[] = [];
        for (const r of runs.values()) for (const a of r.accounts) startedAccounts.push(a);
        heldSlot = recoverySlot(heldSlot, {
            leaseHeld: recoveryLeaseHeld(`${repairFile}.lease`, Date.now()),
            recovering: recoveryDispatch.active?.account,
            started: startedAccounts,
            now: Date.now(),
        });
        const state: Record<string, unknown>[] = [...brainRecoveryRows];
        let owners: Map<string, Owner>;
        try {
            const ownersPath = join(FLEET_DIR(), 'owners.json');
            if (existsSync(ownersPath)) {
                const ost = statSync(ownersPath);
                if (cachedOwners && cachedOwners.file === ownersPath && Date.now() - ost.mtimeMs > 1000 && cachedOwners.mtimeMs === ost.mtimeMs && cachedOwners.size === ost.size) {
                    owners = cachedOwners.owners;
                } else {
                    owners = loadOwners(ownersPath);
                    cachedOwners = { file: ownersPath, mtimeMs: ost.mtimeMs, size: ost.size, owners };
                }
            } else {
                owners = new Map();
            }
        } catch (e) { console.log(`SWARM owners unreadable; new starts paused: ${String(e)}`); return; }

        let endedByLower = endedMapByLower(ended);
        const buildLocked = existsSync(join(liveDir, 'build-lock.json'));
        const pendingUpdate = readPendingUpdateMark();
        // Prune dead pools and drain pools on live update, stop-swarm, launch cap, or halfway through idle timeout.
        for (const [id, pool] of [...pools]) {
            if (!poolSlotAlive(pool)) { pools.delete(id); continue; }
            const idleExpired = poolIdleExpired(pool, poolActiveCount(id), nowWall);
            if (pendingUpdate || stopAll || pool.launches >= POOL_MAX_LAUNCHES || idleExpired) drainPool(pool);
        }
        if (poolExited.size > 0) {
            for (const id of [...poolExited]) {
                if (!pools.has(id) && poolActiveCount(id) === 0) poolExited.delete(id);
            }
        }
        if (pendingUpdate) {
            const drainRuns: DrainRun[] = [...runs].map(([key, run]) => {
                const p = planned.find(x => x.key === key);
                return {
                    accounts: run.accounts, host: !!run.host, standing: !!p?.job.standing,
                    trade: !!p && /(?:^|\/)aio-logistics\.ts$/.test(p.job.script), drained: p ? updateDrainOf(pendingUpdate, p.job) : [],
                };
            });
            const busyRecovery = [...(recoveryDispatch.active ? [recoveryDispatch.active.account] : []), ...inheritedRecoveries.map(r => r.account)];
            for (const a of drainStopAccounts(pendingUpdate, Date.now(), drainRuns, busyRecovery)) {
                if (hasStopFile(a, root)) continue;
                writeSwarmStop(stopFile(a), SWARM_STOP.drain);
                const ownerRun = overlappingRun(runs.values(), [a]);
                if (ownerRun) cancelPooledBot(ownerRun, a);
                console.log(`SWARM drain stop ${a}: the live update to ${pendingUpdate.target.slice(0, 10)} has waited ${Math.round((Date.now() - (pendingUpdate.since ?? pendingUpdate.at)) / 60_000)} min`);
            }
        }
        for (const a of clearDrainStops([liveDir, prac], new Set([...runs.values()].flatMap(r => r.accounts.map(n => n.toLowerCase()))))) {
            console.log(`SWARM drain stop cleared ${a}: its run has ended`);
        }
        let startsThisTick = 0;
        for (let rowIdx = 0; rowIdx < combinedJobs.length; rowIdx++) {
            const raw = combinedJobs[rowIdx]!;
            if (isReservation(raw)) {
                state.push({ account: raw.account, script: '', role: raw.role, goal: raw.goal, enabled: false, repeat: false, note: raw.note, state: 'reserved', since: null });
                continue;
            }
            const p = parsedByRow[rowIdx]!;
            if ('error' in p) {
                state.push({ account: raw.account ?? (raw.accounts ?? []).join('+'), script: raw.script, enabled: raw.enabled, state: `bad job: ${p.error}` });
                continue;
            }
            const job = p.job;
            const jobSig = jobSignatures.get(p) ?? missionSignature(job);
            const foreign = otherSideAccount(p.accounts, side, owners);
            if (foreign) {
                state.push({ account: raw.account ?? p.accounts.join('+'), script: raw.script, enabled: raw.enabled, state: `other side: ${foreign.account} belongs to ${foreign.side}` });
                continue;
            }
            if (!job.standing && buildLocked) {
                state.push({ account: raw.account, accounts: raw.accounts, script: raw.script, standing: false, state: 'waiting: release build owns runtime build' });
                continue;
            }
            for (const a of p.accounts) observeEnabled([a], accountEnabled.get(a.toLowerCase()) === true, previousEnabled, pendingResume);
            if (stopAll) {
                for (const a of p.accounts) {
                    writeSwarmStop(stopFile(a), SWARM_STOP.all);
                    stopFlagsPresent.add(a.toLowerCase());
                }
            }
            const r = overlappingRun(runs.values(), p.accounts);
            if (!stopAll && endStateOk && applyResume(p.accounts, !!r, ended, pendingResume, a => {
                if (clearAccountSwarmStops(a, root) && !hasStopFile(a, root)) stopFlagsPresent.delete(a.toLowerCase());
            }, endedByLower)) {
                endedByLower = endedMapByLower(ended);
                persistEnded(deathsFile, ended);
            }
            const st: Record<string, string> = {};
            if (r && foreignRun(planned, p, r, jobSignatures) && !stopAll) {
                for (const a of p.accounts) st[a] = 'waiting: another job of this account is running';
            } else if (r) {
                Object.assign(st, runningJobState(p, r, ended, pendingResume, stopAll, stopFile));
                if (r.poolId && (!p.job.enabled || stopAll)) {
                    for (const a of p.accounts) if (st[a] === 'stopping') cancelPooledBot(r, a);
                }
            } else if (!job.enabled || stopAll) {
                for (const a of p.accounts) st[a] = 'disabled';
            } else if (!endStateOk) {
                for (const a of p.accounts) st[a] = 'paused: repair or source ownership unresolved';
            } else {
                if (job.standing) {
                    for (const a of p.accounts) {
                        const hit = endedByLower.get(a.toLowerCase()), key = hit?.[0], end = hit?.[1];
                        if (!end) continue;
                        const s = statusHit(a)?.data;
                        if (!standingEndRetryable(end, job, jobSig, s?.result)) continue;
                        let settled = false;
                        try { const lp = readLogoutProof(a, LIVE_SERVER, { base: root }); settled = lp.state === 'confirmed' && Date.now() - lp.loggedOutAt >= 120_000; } catch { /* ignore */ }
                        if (!standingRetryDue(s, settled, Date.now())) continue;
                        ended.delete(key!);
                        endedByLower.delete(a.toLowerCase());
                        for (let i = holds.length - 1; i >= 0; i--) if (holds[i]!.account.toLowerCase() === a.toLowerCase()) holds.splice(i, 1);
                        persistEnded(deathsFile, ended); persistHolds(holdsFile, holds);
                        console.log(`SWARM standing retry ${a} after ${end.reason}`);
                    }
                }
                if (!stopAll) {
                    for (const a of p.accounts) {
                        const lower = a.toLowerCase();
                        if (brainDispatchedAccounts.has(lower) && stopFlagsPresent.has(lower)) {
                            if (clearAccountAutoStops(a, root) && !hasStopFile(a, root)) stopFlagsPresent.delete(lower);
                        }
                    }
                }
                const { start: go, blocked } = completeJobCandidates(p, demandCandidates(holdCandidates(
                    startable(
                        p.accounts,
                        job.repeat,
                        ended,
                        statusAge,
                        statusStarted,
                        jobSig,
                        a => stopFlagsPresent.has(a.toLowerCase()),
                        a => brainDispatchedAccounts.has(a.toLowerCase()),
                        jobReleaseOf(job),
                    ),
                    job.script, holds,
                ), () =>
                    job.whenFoodLowFrom !== undefined && !foodSupplyDemand(job, statuses)
                        ? 'waiting offline: no fresh low-food farm or dated source food stock'
                        : job.whenCargoFrom && !courierDeliveryWaiting(job.whenCargoFrom, job.demandNear, combinedJobs) && !ownedPayoutWaiting(statuses, job.demandNear)
                          ? 'waiting offline: no nearby owned cargo or payout'
                          : null));
                Object.assign(st, blocked);
                const drained = go.length > 0 && !job.standing ? updateDrainOf(pendingUpdate, job) : [];
                if (drained.length > 0) {
                    for (const a of go) st[a] = `waiting: live update to ${pendingUpdate!.target.slice(0, 10)} drains ${drained.slice(0, 2).join(', ')}${drained.length > 2 ? ` and ${drained.length - 2} more` : ''}`;
                } else if (go.length > 0) {
                    const infraCheck = infraBreaker.canProceed();
                    if (!infraCheck.allowed) {
                        for (const a of go) st[a] = `waiting: infra circuit backoff (${infraCheck.kind})`;
                    } else {
                        const held = recoverySlotReserve(heldSlot, { recovering: !!recoveryDispatch.active, accounts: p.accounts, now: Date.now() });
                        const attachingToPool = canUseHostPool(p) && go.length === 1
                            && selectHostPool(pools.values(), poolActiveCount, poolSlotAlive, startSource) !== null;
                        const admission = admissionDecision({
                            running: botsRunning(), external: externalCount(), starting: go.length + held,
                            startingReserve: startReserve(p, go.length, attachingToPool), pending: pendingCount(),
                            freeGB: freemem() / 2 ** 30, minFreeGB: plan.minFreeGB, maxBots: plan.maxBots,
                        });
                        if (!admission.allowed) {
                            for (const a of go) {
                                st[a] = admission.reason === 'maxBots'
                                    ? 'waiting: maxBots'
                                    : `waiting: projected ${admission.projectedFreeGB.toFixed(1)} GB free after ${admission.reserveGB} GB startup reserve < ${admission.floorGB} GB floor`;
                            }
                        } else if (!burstStartAllowed(startsThisTick)) {
                            for (const a of go) st[a] = 'waiting: start stagger';
                        } else {
                            try {
                                start(p, go);
                                startsThisTick += go.length;
                                cachedExternalCount = null;
                                infraBreaker.recordSuccess('proxy');
                                infraBreaker.recordSuccess('server_drain');
                                for (const a of go) st[a] = 'starting';
                            } catch (e) {
                                observeSwarmInfraFault(infraBreaker, e);
                                for (const a of go) st[a] = `paused: ${String(e)}`;
                            }
                        }
                    }
                }
            }
            const run = runs.get(p.key);
            for (const a of p.accounts) {
                const endedEntry = endedByLower.get(a.toLowerCase())?.[1];
                state.push({
                    account: a, script: job.script, role: job.role, goal: job.goal, enabled: job.enabled, repeat: !!job.repeat, note: job.note,
                    ...(p.host ? { host: p.key } : {}), state: st[a],
                    since: (run && run.accounts.some(n => n.toLowerCase() === a.toLowerCase()) ? run.started : undefined) ?? endedEntry?.at ?? null,
                });
            }
        }
        const pendingStartup = pendingCount();
        const infraStatus = infraBreaker.canProceed();
        writeStateFile(join(prac, 'swarm-state.json'), JSON.stringify({
            at: Date.now(), controllerPid: process.pid, release: process.env.WORKER_RELEASE, freeGB: freemem() / 2 ** 30,
            running: botsRunning(), recovery: recoveryDispatch.active ?? null, recoverySlot: heldSlot.until > Date.now() ? heldSlot : null,
            inheritedRecoveries, externalRunning: externalCount(), pendingStartup, pendingReserveGB: pendingStartup * START_BUDGET_GB,
            minFreeGB: Math.max(FREE_FLOOR_GB, plan.minFreeGB), maxBots: plan.maxBots,
            infraBreaker: infraStatus,
            jobs: state,
        }));
        if (stopAll && runs.size === 0 && !recoveryDispatch.active && !inheritedRecoveries.length) {
            console.log('SWARM stopped (stop-swarm)');
            process.exit(0);
        }
        } finally {
            tickStatusByLower = null;
        }
    };

    console.log(`SWARM plan ${planFile}`);
    tick();
    setInterval(tick, 2000);
}

if (import.meta.main) {
    await runSwarmCli(process.argv.slice(2));
}
