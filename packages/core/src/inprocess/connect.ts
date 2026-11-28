import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BotActions } from '../../../../vendor/rs-sdk/sdk/actions';
import type { BotSDK } from '../../../../vendor/rs-sdk/sdk/index';
import { mySide } from '../fleet';
import { fleetLeaseAllowsWorker } from '../fleet-lease';
import { acquireFleetSwarmClaim, acquireFleetTradeClaim } from '../fleet-trade-claim';
import { assertLoginAllowed } from '../haggisgate';
import { shareLocIndex } from '../loc-index-share';
import { isLocalServer } from '../localserver';
import { loadPathfinding, pathfindingSnapshotUsable } from '../pathcache';
import { planLockDir, withPlanWrite } from '../plan-lock';
import { hasStopFile, lifecycleRootForServer } from '../practice-paths';
import { beginSessionAttempt, lifecycleOwner, type SessionAttempt } from '../session-lifecycle';
import { assertSpentRecoveryConnection, waitOutStaleHeartbeat, type RecoveryConnectionAdmission } from '../session-recovery-permit';
import { recordOwnedAccount, tradePartners, tradeRefusal } from '../tradeguard';
import { gameDialAddress, installGameWebSocketProxy } from '../websocket-proxy';
import { assertWorkerRelease } from '../worker-release';
import { createShim } from './shim';
import { connectFailedDetail, inProcessSdkConfig, loginJitterFor, observeFetch, repoRoot, vendor } from './transport';
import type { ClientLike, Session, Shim, StartSession, TradeAdmission } from './types';

let pathfindingReady = false;
const trimmedIfLists = new WeakSet<object>();

// Headless LiteClient sessions never draw 3D models, sprites, or interface layouts. Release the static rendering
// scratch tables and unused per-component layout/background arrays once per unpacked IfType.list baseline.
async function trimHeadlessClientCaches(): Promise<void> {
    if (typeof globalThis.document === 'undefined') return;
    try {
        const [ifMod, modelMod, pixMod] = await Promise.all([
            import(vendor('server/webclient/src/config/IfType.ts')),
            import(vendor('server/webclient/src/dash3d/Model.ts')),
            import(vendor('server/webclient/src/dash3d/Pix3D.ts')),
        ]);
        const IfType = ifMod.default as { list?: any[]; spriteCache?: unknown } | undefined;
        const Model = modelMod.default as { tmpDepthFaces?: unknown[]; tmpPriorityFaces?: unknown[] } | undefined;
        const Pix3D = pixMod.default as { colourTable?: Int32Array } | undefined;
        if (Model) {
            if (Model.tmpDepthFaces?.length) Model.tmpDepthFaces = [];
            if (Model.tmpPriorityFaces?.length) Model.tmpPriorityFaces = [];
        }
        if (Pix3D?.colourTable?.length) Pix3D.colourTable = new Int32Array(0);
        if (IfType) {
            IfType.spriteCache = null;
            const list = IfType.list;
            if (Array.isArray(list) && !trimmedIfLists.has(list)) {
                trimmedIfLists.add(list);
                for (let i = 0; i < list.length; i++) {
                    const com = list[i];
                    if (!com) continue;
                    com.childX = null;
                    com.childY = null;
                    com.invBackgroundX = null;
                    com.invBackgroundY = null;
                    com.invBackground = null;
                }
            }
        }
    } catch { /* optional memory trim when vendor modules are absent in unit doubles */ }
}

// Bots of this process that log in or are logged in. A host job (packages/core/src/host.ts) and a squad job hold
// several. Each Git call of a login claim is synchronous, so a claim that waits stalls each bot of its process.
let botsInProcess = 0;
export const botsInThisProcess = () => botsInProcess;

// The swarm declares how many bots the job of a process holds (SWARM_BOTS, scripts/swarm.ts). The count above sees a
// bot only when it logs in: the first bot of a host logs in before its second bot starts. So only a process that is
// declared to hold one bot may wait. A process with no declaration (a manual run, a fleet trade) does not wait.
// A caller whose other bots stand idle while it logs in may ask for the wait (patientClaim): the startup of a squad
// opens its members one at a time before any fight (packages/workers/src/pvp/squad.ts openSquad). A slow Git call then
// stalls the members that stand at the bank for its length.
export const soloProcess = (env: Record<string, string | undefined> = process.env) => env.SWARM_BOTS === '1';

export async function connectInProcess(opts: {
    name: string;
    password: string;
    server?: string;
    members?: boolean;
    lifecycleRoot?: string;
    beforeConnect?: () => void;
    lockPlan?: boolean;
    recoverSwarm?: RecoveryConnectionAdmission;
    trade?: TradeAdmission;
    allowTradePartners?: readonly string[];
    patientClaim?: boolean;
}): Promise<Session> {
    if (opts.lifecycleRoot && !isLocalServer(opts.server ?? 'localhost:8888')) throw Error('lifecycle root override is local-only');
    const server = opts.server ?? 'localhost:8888';
    const live = !isLocalServer(server);
    if (!live && opts.trade) throw Error('fleet trade claim requires a live server');
    const swarm = live && !!process.env.SWARM_LEASE_HOLDER;
    const ticket = assertLoginAllowed(opts.name, Date.now(), process.env, server);
    installGameWebSocketProxy();
    // dom-shim must load before any webclient `#/` module (session.ts:15 does the same).
    await import(vendor('server/webclient/src/lite/dom-shim.ts'));
    const [{ startSession }, { BotSDK }, { BotActions }, { serviceWanted }] = await Promise.all([
        import(vendor('server/webclient/src/lite/session.ts')),
        import(vendor('sdk/index.ts')),
        import(vendor('sdk/actions.ts')),
        import('../route-plan'),
        shareLocIndex(),
    ]);
    const useService = serviceWanted();
    if (!pathfindingReady) {
        // With a saved snapshot of the current source key (a stale one does not count) or an active route service,
        // the local route finder loads on its first use (pathcache.ts restorePathfindingOnFirstUse, or
        // loadPathfinding() from a route call), so a bot that delegates to route-service or stands at one bank never
        // holds the grid. Without either, this login builds and saves the snapshot once for the machine.
        // ROUTE_FINDER=eager always loads it here.
        if (process.env.ROUTE_FINDER === 'eager' || (!useService && !pathfindingSnapshotUsable())) await loadPathfinding();
        pathfindingReady = true;
    }
    const cacheDir = join(repoRoot, '.practice', 'cache');
    mkdirSync(cacheDir, { recursive: true });
    const lifecycle: NonNullable<Parameters<typeof beginSessionAttempt>[1]> = { root: opts.lifecycleRoot ?? lifecycleRootForServer(server, repoRoot) };
    const beforeConnect = () => {
        const currentTicket = assertLoginAllowed(opts.name, Date.now(), process.env, server);
        if (currentTicket !== ticket) throw Error('specialist authorization changed before login');
        if (!isLocalServer(server) && !fleetLeaseAllowsWorker(repoRoot)) throw Error('fleet controller lease unavailable');
        if (live && (hasStopFile(opts.name, repoRoot) || (swarm && hasStopFile('swarm', repoRoot)))) {
            throw Error('live admission paused by stop file');
        }
        const recovery = live ? opts.recoverSwarm : undefined;
        if (recovery) waitOutStaleHeartbeat(() => { assertSpentRecoveryConnection(recovery, opts.name, server, repoRoot); opts.beforeConnect?.(); });
        else opts.beforeConnect?.();
        if (currentTicket) {
            assertWorkerRelease();
            lifecycle.owner = { ...lifecycleOwner(), specialistAuthorization: { ticket: currentTicket, mission: process.env.SWARM_MISSION_HASH! } };
        }
        opts.trade?.check(server);
    };
    const sdk = new BotSDK(inProcessSdkConfig(opts));
    if (useService) {
        const pathMod = await import('../world/pathfinding') as { installRemoteSendFindPath?: (sdk: BotSDK) => void };
        pathMod.installRemoteSendFindPath?.(sdk);
    }
    return startInProcessSession(opts, {
        startSession,
        sdk,
        Actions: BotActions,
        cacheDir,
        beforeConnect,
        planLock: opts.lockPlan || ticket || opts.trade ? planLockDir : undefined,
        lifecycle,
        sharedAccount: live ? { root: repoRoot, side: mySide(), recover: !!opts.recoverSwarm, admission: opts.recoverSwarm, trade: opts.trade } : undefined,
        ...(opts.patientClaim ? { patientClaim: true } : {}),
    });
}

// The network part of connectInProcess. The lifecycle intent is written first; if it cannot be written, no
// connection starts. Every later event comes from this session's own callbacks. Tests pass a fake startSession.
export async function startInProcessSession(
    opts: { name: string; password: string; server?: string; members?: boolean; allowTradePartners?: readonly string[] },
    deps: {
        startSession: StartSession;
        sdk: BotSDK;
        Actions: new (sdk: BotSDK) => BotActions;
        cacheDir: string;
        lifecycle?: Parameters<typeof beginSessionAttempt>[1];
        recordOwned?: typeof recordOwnedAccount;
        beforeConnect?: () => void;
        planLock?: string;
        sharedAccount?: { root: string; side: string; recover?: boolean; admission?: RecoveryConnectionAdmission; trade?: TradeAdmission };
        claimSwarm?: typeof acquireFleetSwarmClaim;
        soloProcess?: boolean;
        countBots?: () => number;
        patientClaim?: boolean;
    },
): Promise<Session> {
    const { startSession, sdk, Actions, cacheDir } = deps;
    let endResolve!: (v: { reason: string }) => void;
    const ended = new Promise<{ reason: string }>(r => { endResolve = r; });
    // This bot counts from here until its login fails or its session ends.
    botsInProcess++;
    let counted = true;
    const leave = () => { if (counted) { counted = false; botsInProcess--; } };
    void ended.then(leave);
    let shim: Shim | null = null;
    const host = opts.server ?? 'localhost:8888'; // host:port, same as SERVER in bot.env
    let sharedClaim: ReturnType<typeof acquireFleetSwarmClaim> | undefined;
    let tradeClaim: ReturnType<typeof acquireFleetTradeClaim> | undefined;
    const admit = () => {
        // Async imports/pathfinding can outlive an owner stop. Recheck before any intent or network work.
        deps.beforeConnect?.();
        if (deps.sharedAccount) {
            const { root, side, recover, admission, trade } = deps.sharedAccount;
            const target = { account: opts.name, server: host, side };
            if (trade) tradeClaim = acquireFleetTradeClaim(root, { ...target, orderId: trade.orderId, role: trade.role });
            // The one bot of a process, outside the plan lock, waits for a slow Git authority (about 130 s at most), and
            // so does a login that asked for it (patientClaim). A bot of a process with several bots and a login under the
            // lock keep the short window: the wait would stall the other bots or hold the lock.
            else sharedClaim = (deps.claimSwarm ?? acquireFleetSwarmClaim)(root, target, {
                recover,
                admission,
                patient: !deps.planLock && (deps.patientClaim === true || ((deps.soloProcess ?? soloProcess()) && (deps.countBots ?? botsInThisProcess)() === 1)),
            });
            deps.beforeConnect?.(); // A stop or expired permit can land during the Git call.
            if (trade && tradeClaim) trade.prepare(tradeClaim);
        }
        const claim = sharedClaim ?? tradeClaim;
        const lifecycle = claim ? {
            ...deps.lifecycle,
            owner: { ...(deps.lifecycle?.owner ?? lifecycleOwner()), sharedClaimNonce: claim.nonce },
        } : deps.lifecycle;
        const attempt = beginSessionAttempt({ account: opts.name, server: host, members: opts.members, secret: opts.password }, lifecycle);
        claim?.armNetwork();
        return attempt;
    };
    // Plan-locked callers publish intent before another plan writer may proceed.
    let attempt: SessionAttempt;
    try { attempt = deps.planLock ? await withPlanWrite(admit, deps.planLock) : admit(); }
    catch (error) {
        // No call to startSession has run. A failed release leaves the shared hold in place.
        leave();
        try {
            tradeClaim?.release();
            sharedClaim?.abortBeforeNetwork();
        } catch { console.error('fleet account claim retained after admission refusal'); }
        throw error;
    }
    let session: Awaited<ReturnType<StartSession>>;
    let confirmedLogout = false;
    const http = observeFetch();
    const releaseConfirmed = () => {
        if (!sharedClaim || !confirmedLogout) return;
        try { sharedClaim.releaseAfterLogout(attempt.attemptId); }
        catch { console.error('fleet swarm claim retained after logout'); }
    };
    try {
        session = await startSession({
            host: gameDialAddress(host),
            username: opts.name,
            password: opts.password,
            cacheDir,
            quiet: true,
            onClient: (client: ClientLike) => {
                const extraTradePartners = (opts.allowTradePartners ?? []).map(n => n.trim().toLowerCase()).filter(Boolean);
                const created = createShim(client, sdk, action => {
                    const a = action as any;
                    const trading = a.type === 'interactPlayer' && a.optionIndex === 4 || ['clickComponent', 'clickComponentWithOption'].includes(a.type) && [3420, 3546].includes(a.componentId);
                    if (!trading) return null;
                    const allowed = extraTradePartners.length ? new Set([...tradePartners(host), ...extraTradePartners]) : tradePartners(host);
                    return tradeRefusal(a, sdk.getState(), allowed);
                });
                shim = created;
                created.start();
            },
            ...(loginJitterFor(host) !== undefined ? { loginJitterMs: loginJitterFor(host) } : {}),
            ...(opts.members !== undefined ? { members: opts.members } : {}),
            onEnd: (end: { reason: string }) => {
                // The server end reason of this exact attempt; 'logged-out' is the only logout confirmation.
                if (attempt.record('ended', end.reason) && end.reason === 'logged-out') confirmedLogout = true;
                // Publish the lifecycle event before rejected queued actions can
                // be mistaken by their callers for a task prerequisite failure.
                endResolve({ reason: end.reason });
                (shim as Shim | null)?.stop(end.reason);
            },
        });
    } catch (e) {
        (shim as Shim | null)?.stop('connect-failed');
        attempt.record('connect-failed', connectFailedDetail(e, http.rows));
        releaseConfirmed();
        leave();
        throw e;
    } finally { http.restore(); }
    // The bootstrap callback runs before startSession returns.
    const sh = shim as Shim | null;
    if (!sh) {
        attempt.record('connect-failed', 'no packet observer');
        releaseConfirmed();
        leave();
        throw new Error('Session did not install its packet observer');
    }
    attempt.record('connected');
    (deps.recordOwned ?? recordOwnedAccount)(opts.name, host);
    try { tradePartners(host); } catch { /* test doubles may omit filesystem bots dir */ }
    const bot: BotActions = new Actions(sdk);
    const result: Session = {
        name: opts.name,
        sdk,
        bot,
        tick: () => sh.tick(),
        onTick: cb => sh.onTick(cb),
        bankObservation: () => sh.bankObservation(),
        direct: a => sh.direct(a),
        record: r => sh.record(r),
        ended,
        client: session.client,
        lifecycle: attempt,
        async close() {
            sh.stop('stopped');
            session.stop();
            await session.stopped;
            attempt.record('closed');
            releaseConfirmed();
        },
    };
    // Every session gets the HP floor (hp-floor.ts) here, before any script or guard holds it: a script that starts
    // no guard of its own still cannot fight on to a death. Only a local practice server can turn it off (hpFloorOff).
    const floorMod = await import('../hp-floor');
    if (!floorMod.hpFloorOff(process.env, isLocalServer(host), process.argv[1] ?? '')) floorMod.installHpFloor(result);
    await trimHeadlessClientCaches();
    return result;
}
