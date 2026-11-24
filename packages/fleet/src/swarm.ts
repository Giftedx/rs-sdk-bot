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
import { defaultActivityCatalog, createRateStore, OutcomeClassifier, type AccountActiveJob, type PlannedStep } from '../../brain/src/index';
import { COOKED_FOOD_BASE_IDS, COOKED_FOOD_IDS, payoutWaiting, type DemandNear } from '../../core/src/bank-demand';
import { cargoAccountServer } from '../../core/src/cargo';
import { parseStep, tokenizeStep, type Step } from '../../core/src/chain-step';
import { controllerNamed, releaseLease, renewLease, saveLaunch, takeLease } from '../../core/src/controllers';
import { FLEET_DIR, loadOwners, mySide, sideOf, type Owner } from '../../core/src/fleet';
import { acquireFleetLease, FLEET_LEASE_RENEW_MS, FLEET_LEASE_RETRY_MS } from '../../core/src/fleet-lease';
import { jobLogStart } from '../../core/src/job-log';
import { reloadDue, respawnDaemon } from '../../core/src/live-reload';
import { rotateLog } from '../../core/src/log-rotate';
import { FREE_FLOOR_GB } from '../../core/src/memory';
import { atomicJson, ownerPlanPath } from '../../core/src/plan-lock';
import { hasStopFile, lifecycleReadRoots, liveRoot, operatorCommandsDir, practiceRoot, repoRoot, statusReadDirs, stopFilePaths } from '../../core/src/practice-paths';
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
import {
    captureRunBaseline,
    extractWorkerOutcomeInput,
    recordWorkerOutcome,
    runBrainCycle,
    type BrainCycleResult,
    type RunTelemetryBaseline,
} from './brain-runtime';
import type { DispatchedAccountPlan } from './worker-dispatch';
import { courierDeliveryWaiting, deliveryResume, foodDeficit, selectFoodSource } from './courier-admission';
import { InfraCircuitBreaker, classifyInfraFault } from './infra-circuit-breaker';

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
    marketItemId?: number;
    marketVenue?: string;
    demandId?: string;
};

type Plan = { maxBots: number; minFreeGB: number; jobs: Job[]; boundedRecovery?: boolean; boundedInspection?: boolean };

type Run = {
    pid: number;
    started: number;
    accounts: string[];
    revision: string;
    host?: boolean;
    log: string;
    offset: number;
    activityId?: string;
    outcomeActivityId?: string;
    isMultiStepChain?: boolean;
    marketItemId?: number;
    marketVenue?: string;
    demandId?: string;
    workerRelease?: string;
    baseline?: RunTelemetryBaseline;
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
          readonly marketItemId?: number;
          readonly marketVenue?: string;
      };

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
        ...(marketItemId !== undefined ? { marketItemId } : {}),
        ...(marketVenue ? { marketVenue } : {}),
    };
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
export const START_BUDGET_GB = 1;
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

export function pendingStartupCount(runs: readonly { started: number; accounts: readonly string[]; host?: boolean }[], now: number): number {
    let pending = 0;
    const seen = new Set<string>();
    for (const r of runs) {
        if (now - r.started >= 0 && now - r.started < START_RESERVE_MS) {
            if (r.host) pending += 1;
            else for (const a of r.accounts) if (!seen.has(a.toLowerCase())) { seen.add(a.toLowerCase()); pending += 1; }
        }
    }
    return pending;
}

export function startReserve(p: { host: boolean; job: Job }, accounts: number): number {
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
            'bun', 'packages/practice/src/supervise-host.ts', job.script, maxRestarts, ...accounts,
            ...(job.args ?? []).flatMap(a => ['--arg', a]),
            ...accounts.flatMap(a => Object.entries(job.envByAccount?.[a] ?? {}).flatMap(([k, v]) => ['--env', a, `${k}=${v}`])),
        ]
        : ['bun', 'packages/practice/src/supervise.ts', accounts[0]!, job.script, maxRestarts, ...(job.orchestrate ? accounts.slice(1) : []), ...(job.args ?? [])];
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

export type EndRecord = { at: number; reason: string; revision?: string };

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
} as const;

export function swarmWroteStop(text: string | undefined): boolean {
    return text !== undefined && (Object.values(SWARM_STOP) as string[]).includes(text.trim());
}

export function isAutoStopText(text: string | undefined): boolean {
    return swarmWroteStop(text) || /^fleet-health auto-paused:/i.test((text ?? '').trim());
}

export function writeSwarmStop(file: string, reason: string): void {
    try { writeFileSync(file, reason, { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
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
const statusRawCache = new Map<string, { mtimeMs: number; size: number; ino: number; raw: Buffer; data: any }>();

function readCachedStatusData(filePath: string, nowWall: number): { mtimeMs: number; data: any } | null {
    try {
        const st = statSync(filePath);
        const hit = statusDataCache.get(filePath);
        if (hit && nowWall - st.mtimeMs > 1000 && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.ino === st.ino) {
            return { mtimeMs: st.mtimeMs, data: hit.data };
        }
        const data = JSON.parse(readFileSync(filePath, 'utf8'));
        if (statusDataCache.size > 4096) statusDataCache.clear();
        statusDataCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, data });
        return { mtimeMs: st.mtimeMs, data };
    } catch {
        statusDataCache.delete(filePath);
        return null;
    }
}

export function readAccountStatus(
    root: string,
    account: string,
): { file: string; mtimeMs: number; raw: Buffer; data: any } | null {
    const lower = `${account.toLowerCase()}.json`;
    const nowWall = Date.now();
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
        if (!target) continue;
        try {
            const st = statSync(target);
            const hit = statusRawCache.get(target);
            if (hit && nowWall - st.mtimeMs > 1000 && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.ino === st.ino) {
                return { file: target, mtimeMs: hit.mtimeMs, raw: hit.raw, data: hit.data };
            }
            const raw = readFileSync(target);
            const data = JSON.parse(raw.toString('utf8'));
            if (statusRawCache.size > 4096) statusRawCache.clear();
            statusRawCache.set(target, { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, raw, data });
            if (statusDataCache.size > 4096) statusDataCache.clear();
            statusDataCache.set(target, { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, data });
            return { file: target, mtimeMs: st.mtimeMs, raw, data };
        } catch {
            statusRawCache.delete(target);
            /* incomplete record */
        }
    }
    return null;
}

function readAllStatusEntries(root: string): { statuses: unknown[]; byLower: Map<string, { file: string; mtimeMs: number; data: any }> } {
    const statuses: unknown[] = [];
    const byLower = new Map<string, { file: string; mtimeMs: number; data: any }>();
    const seen = new Set<string>();
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
            const hit = readCachedStatusData(filePath, nowWall);
            if (!hit) continue;
            statuses.push(hit.data);
            const stem = key.slice(0, -5);
            const rowKey = typeof hit.data?.name === 'string' && hit.data.name ? hit.data.name.toLowerCase() : stem;
            if (!byLower.has(rowKey)) byLower.set(rowKey, { file: filePath, mtimeMs: hit.mtimeMs, data: hit.data });
            if (!byLower.has(stem)) byLower.set(stem, { file: filePath, mtimeMs: hit.mtimeMs, data: hit.data });
        }
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
        if (prior && !unknown && !(orphan ? receipt.updatedAt > prior[1].at : successfulEnd(prior[1].reason) && receipt.createdAt > prior[1].at)) continue;
        found.push({ end: [prior?.[0] ?? a, `exit orphaned: attempt ${p.attemptId} owner ${receipt.pid} gone`], pid: receipt.pid, createdAt: receipt.createdAt, answers: alive(receipt.pid) });
    }
    const answering = found.filter(f => f.answers).map(f => f.pid), table = answering.length ? starts(answering) : null;
    return found.filter(f => !f.answers || laterProcessHolds(f.pid, f.createdAt, table)).map(f => f.end);
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
    ended: Map<string, { reason: string; at?: number; revision?: string }>,
    statusAge: (a: string) => number,
    statusStarted?: (a: string) => number | undefined,
    revision?: string,
    stopped?: (a: string) => boolean,
    brainManaged?: (a: string) => boolean,
): { start: string[]; blocked: Record<string, string> } {
    const start: string[] = [];
    const blocked: Record<string, string> = {};
    let lowerMap: Map<string, { reason: string; at?: number; revision?: string }> | null = null;
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
        const resumable = !!end && (
            (/^refused\b/.test(end.reason) && !!end.revision && !!revision && end.revision !== revision)
            || /^release-paused\b/.test(end.reason) || /^released\b/.test(end.reason)
            || brainSwitched
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
    atomicJson(ownerFile, {
        pid: process.pid,
        nonce,
        source: cachedLaunchRevision(root),
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
    process.on('SIGINT', () => process.exit(0));
    process.on('SIGTERM', () => process.exit(0));

    const knowledgeRoot = existsSync(join(root, 'knowledge', 'items.json')) ? root : repoRoot;
    const catalog = defaultActivityCatalog(knowledgeRoot);
    const rateStore = createRateStore({ catalog, root, persist: true });
    const classifier = new OutcomeClassifier({ rateStore, root, persist: true });
    const brainCycleMsRaw = Number(process.env.BRAIN_CYCLE_MS);
    const brainCycleMs = Number.isFinite(brainCycleMsRaw) && brainCycleMsRaw >= 1000 ? brainCycleMsRaw : DEFAULT_BRAIN_CYCLE_MS;
    let lastBrainResult: BrainCycleResult | null = null;
    let lastBrainAt = 0;
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
    const holdsFile = join(prac, 'swarm-script-holds.json');
    const holds: ScriptHold[] = [];
    let holdsStamp = syncDeathHolds(holdsFile, holds, { mtimeMs: -1, size: -1 });
    const setEnded = ended.set.bind(ended);
    ended.set = (a, r) => {
        setEnded(a, r);
        persistEnded(deathsFile, ended);
        return ended;
    };
    const stopFile = (a: string) => join(prac, `stop-${a}`);
    let tickStatusByLower: Map<string, { file: string; mtimeMs: number; data: any }> | null = null;
    const statusHit = (a: string) => tickStatusByLower?.get(a.toLowerCase()) ?? readAccountStatus(root, a);
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
    const saveRuns = () => {
        try {
            const tmp = `${runsFile}.tmp-${process.pid}`;
            writeFileSync(tmp, JSON.stringify([...runs].map(([key, r]) => ({ key, ...r })), null, 1));
            renameRetry(tmp, runsFile);
        } catch (e) { console.log(`SWARM runs file not saved: ${String(e)}`); }
    };

    const follow = (key: string, run: Run, child?: { on(e: 'exit', f: (code: number | null) => void): unknown }) => {
        let tail = '', currentEnd: string | undefined, diedNames: string[] | undefined, lastResultLine: string | undefined, exitCode: number | null | undefined, done = false;
        const consume = (line: string) => {
            observeSwarmInfraFault(infraBreaker, line);
            const resMatch = line.match(/(?:^|\s)(RESULT\s+(?:ok|fail)\s+.*)$/);
            if (resMatch) lastResultLine = resMatch[1];
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
            runs.delete(key); adopted.delete(run); saveRuns();
            const code = exitCode === undefined ? 'unknown' : exitCode;
            if (!run.host) {
                const reason = currentEnd ?? `exit ${code}`;
                const ends = endsOfRun(run.accounts, reason, diedNames);
                for (const account of run.accounts) {
                    const own = ends.get(account)!;
                    const diedRun = /^died\b/i.test(own);
                    let keepEnded = true;
                    const outcomeActId = run.activityId ?? run.outcomeActivityId;
                    if (outcomeActId && run.accounts.length === 1) {
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
                                raw,
                            });
                            if (outcomeRes.outcome.kind === 'infra_fault' && !diedRun && !successfulEnd(own)) {
                                try {
                                    if (readLogoutProof(account, LIVE_SERVER, { base: root }).state !== 'held') keepEnded = false;
                                } catch { /* keep ended on unreadable proof */ }
                            }
                        } catch { /* outcome persistence errors never stop controller */ }
                    }
                    if (keepEnded) {
                        ended.set(account, { at: Date.now(), reason: own, revision: run.revision });
                        console.log(`SWARM end ${account} ${own}`);
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
                    ended.set(a, { at: Date.now(), reason: `exit ${code}`, revision: run.revision });
                    console.log(`SWARM end ${a} exit ${code} (host)`);
                }
            }
        };
        const timer = setInterval(() => {
            const before = run.offset;
            read();
            if (run.offset !== before) saveRuns();
            if (!child && !adoptedRunAlive(run, pidAlive, pidStarts)) finish();
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
        const state = !pidAlive(run.pid) ? ' (ended)' : adoptedRunAlive(run, pidAlive, pidStarts) ? '' : ' (ended: a later process holds the pid)';
        console.log(`SWARM adopt ${run.host ? `host ${run.accounts.join(',')}` : run.accounts[0]} pid ${run.pid}${state}`);
        follow(key, run);
    }
    saveRuns();

    const start = (p: ParsedJob, accounts: string[]) => withSessionAdmission(accounts, root, () => {
        const job = p.job;
        const revision = missionSignature(job);
        const logName = p.host ? `host-${accounts[0]}.log` : `${accounts[0]}.log`, logPath = join(logDir, logName);
        const cmd = supervisorCommand(p, accounts);
        rotateLog(logPath);
        const offset = existsSync(logPath) ? statSync(logPath).size : 0, out = openSync(logPath, 'a');
        const baseline = accounts.length === 1 && job.activityId
            ? captureRunBaseline(root, accounts[0]!, LIVE_SERVER) ?? undefined
            : undefined;
        let child: ReturnType<typeof spawnChild>;
        let workRelease: string | undefined;
        try {
            const entries = workerEntries(job.script, job.args ?? [], root);
            workRelease = cachedReleaseFor(entries, root);
            assertLease();
            writeSync(out, jobLogStart(job));
            child = spawnChild(cmd[0]!, cmd.slice(1), {
                cwd: root, detached: true, windowsHide: true, stdio: ['ignore', out, out],
                env: {
                    ...process.env, ...job.env, ...botCountEnv(accounts),
                    SWARM_LEASE_HOLDER: lease.holder,
                    SWARM_MISSION_HASH: createHash('sha256').update(revision).digest('hex'),
                    WORKER_RELEASE: workRelease, WORKER_ENTRY: entries.join(','), DEMO_OK: '1',
                    BOT_ROLE: job.role ?? '', BOT_GOAL: job.goal ?? '',
                    STANDING: job.standing ? '1' : '',
                },
            });
        } finally { closeSync(out); }
        if (!child.pid) throw Error('supervisor did not start');
        child.unref();
        const run: Run = {
            pid: child.pid, started: Date.now(), accounts, revision, host: p.host, log: logPath, offset,
            ...(job.activityId ? { activityId: job.activityId } : {}),
            ...(job.outcomeActivityId ? { outcomeActivityId: job.outcomeActivityId } : {}),
            ...(job.isMultiStepChain ? { isMultiStepChain: true } : {}),
            ...(job.marketItemId !== undefined ? { marketItemId: job.marketItemId } : {}),
            ...(job.marketVenue ? { marketVenue: job.marketVenue } : {}),
            ...(job.demandId ? { demandId: job.demandId } : {}),
            ...(workRelease ? { workerRelease: workRelease } : {}),
            ...(baseline ? { baseline } : {}),
        };
        runs.set(p.key, run); saveRuns();
        console.log(`SWARM start ${p.host ? `host ${accounts.join(',')}` : accounts[0]} ${job.script} ${JSON.stringify(job.env ?? {})}`);
        follow(p.key, run, child);
    });

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
        const brainEnabled = !plan.boundedRecovery && !plan.boundedInspection;
        if (brainEnabled) {
            try {
                const nowMs = Date.now();
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
                    lastBrainResult = runBrainCycle({
                        root, side, server: LIVE_SERVER, maxBots: plan.maxBots,
                        catalog, rateStore, classifier, infraBreaker,
                        activeAccounts: activeMap, persist: true, consumeCommands: true,
                    });
                    lastBrainAt = nowMs;
                    lastBrainPlanMtime = planMtime;
                    brainDirty = false;
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
                        const selected = selectBrainDispatchStep(dispatched, accountSteps);
                        if (selected.mode === 'session_recovery') {
                            brainRecoveryRows.push({
                                account: acctName,
                                script: '',
                                role: acctState?.role,
                                goal: 'session recovery',
                                enabled: false,
                                repeat: false,
                                state: 'waiting: standalone session recovery',
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
                        if (selected.mode !== 'worker') continue;
                        brainDispatchedAccounts.add(acctName.toLowerCase());
                        const isFiniteBrainJob = selected.isMultiStepChain
                            || selected.step.script === 'scripts/aio-market.ts'
                            || selected.step.script === 'scripts/aio-quester.ts'
                            || (selected.step.script === 'scripts/aio-logistics.ts' && selected.step.args[0] === 'walk-to');
                        const outcomeActivityId = selected.displayActivityId ?? selected.attributedActivityId;
                        combinedJobs.push({
                            account: acctName,
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
                            role: acctState?.role,
                            goal: dispatched.demandId ?? selected.displayActivityId,
                            ...(selected.attributedActivityId ? { activityId: selected.attributedActivityId } : {}),
                            ...(outcomeActivityId ? { outcomeActivityId } : {}),
                            ...(selected.isMultiStepChain ? { isMultiStepChain: true } : {}),
                            ...(selected.marketItemId !== undefined ? { marketItemId: selected.marketItemId } : {}),
                            ...(selected.marketVenue ? { marketVenue: selected.marketVenue } : {}),
                            ...(dispatched.demandId ? { demandId: dispatched.demandId } : {}),
                        });
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
        }

        for (const r of runs.values()) {
            if (!overlappingRun(planned, r.accounts) || stopAll) {
                for (const a of r.accounts) {
                    writeSwarmStop(stopFile(a), SWARM_STOP.removed);
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
                    ),
                    job.script, holds,
                ), () =>
                    job.whenFoodLowFrom !== undefined && !foodSupplyDemand(job, statuses)
                        ? 'waiting offline: no fresh low-food farm or dated source food stock'
                        : job.whenCargoFrom && !courierDeliveryWaiting(job.whenCargoFrom, job.demandNear, combinedJobs) && !ownedPayoutWaiting(statuses, job.demandNear)
                          ? 'waiting offline: no nearby owned cargo or payout'
                          : null));
                Object.assign(st, blocked);
                if (go.length > 0) {
                    const infraCheck = infraBreaker.canProceed();
                    if (!infraCheck.allowed) {
                        for (const a of go) st[a] = `waiting: infra circuit backoff (${infraCheck.kind})`;
                    } else {
                        const held = recoverySlotReserve(heldSlot, { recovering: !!recoveryDispatch.active, accounts: p.accounts, now: Date.now() });
                        const admission = admissionDecision({
                            running: botsRunning(), external: externalCount(), starting: go.length + held,
                            startingReserve: startReserve(p, go.length), pending: pendingCount(),
                            freeGB: freemem() / 2 ** 30, minFreeGB: plan.minFreeGB, maxBots: plan.maxBots,
                        });
                        if (!admission.allowed) {
                            for (const a of go) {
                                st[a] = admission.reason === 'maxBots'
                                    ? 'waiting: maxBots'
                                    : `waiting: projected ${admission.projectedFreeGB.toFixed(1)} GB free after ${admission.reserveGB} GB startup reserve < ${admission.floorGB} GB floor`;
                            }
                        } else {
                            try {
                                start(p, go);
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
