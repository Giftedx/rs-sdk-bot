import { mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BotSDK } from '../../../vendor/rs-sdk/sdk/index';
import type { BotActions } from '../../../vendor/rs-sdk/sdk/actions';
import type { SDKConfig } from '../../../vendor/rs-sdk/sdk/types';
import { loadPathfinding } from './pathcache';
import { assertLoginAllowed } from './haggisgate';
import { isLocalServer } from './localserver';
import { ownedAccounts, tradePartners, recordOwnedAccount, tradeRefusal } from './tradeguard';
import { ServerProt } from '../../../vendor/rs-sdk/server/webclient/src/io/ServerProt';
import { setEquipmentObserved } from './container-observation';
import { beginSessionAttempt, type SessionAttempt } from './session-lifecycle';

// Runs BotSDK + BotActions in the same process as a LiteClient, with no gateway.
// BotSDK only speaks WebSocket (sdk/index.ts:272), so the shim fakes a connected socket and feeds it the
// same messages the gateway would (see research/phase2-recon.md section 1).

export interface ClientLike {
    collectBotState(tick: number): unknown;
    executeBotAction(action: unknown): unknown | Promise<unknown>;
    setOnGameTickCallback(cb: (() => void) | null): void;
    getMaxMessageLength?(): number;
    ifMutable?(id: number): unknown;
    ptype0?: number;
    packetsReceived?: number;
    mainModalId?: number;
}

export interface BankObservation {
    generation: number;
    at: number;
    items: { id: number; name: string; count: number }[];
}

export interface Shim {
    start(): void;
    stop(reason: string): void;
    tick(): number;
    onTick(cb: () => void): () => void;
    bankObservation(): BankObservation | null;
    // Sends one action straight to the client, skipping the queue (used for logout, which must not wait
    // behind a slow or stuck action).
    direct(action: { type: string; [k: string]: unknown }): Promise<unknown>;
}

type Queued = { actionId: string; action: { type: string; ticks?: number } };

export function createShim(client: ClientLike, sdk: BotSDK, guard?: (action: unknown) => string | null): Shim {
    const s = sdk as any;
    let tick = 0;
    let stopped = false;
    let running = false;
    let waitLeft = 0;
    let waitDone: (() => void) | null = null;
    const queue: Queued[] = [];
    const listeners = new Set<() => void>();
    // ifMutable is used by text/model packets too. Only inventory packets for the
    // bank component establish data readiness. ptype0 + packetsReceived identify
    // the current dispatch (incoming.ts records both before calling ifMutable).
    const originalMutable = client.ifMutable;
    setEquipmentObserved(client, false);
    let seenPacket = -1, bankGeneration = 0, bankAt = 0, bankReady = false, pendingBank = 0, bankWasOpen = false;
    const trackedMutable = originalMutable ? function (id: number) {
        const component = originalMutable.call(client, id);
        const packet = client.packetsReceived, opcode = client.ptype0;
        if (packet == null || packet === seenPacket) return component;
        seenPacket = packet;
        if (![5382, 1688].includes(id) || !component || ![ServerProt.UPDATE_INV_FULL, ServerProt.UPDATE_INV_PARTIAL, ServerProt.UPDATE_INV_STOP_TRANSMIT].includes(opcode!)) return component;
        if (id === 1688) {
            // Invalidate immediately; publish only after the handler fills all slots.
            const slots = component as {linkObjType?: unknown;linkObjNumber?: unknown};
            const wasReady = opcode !== ServerProt.UPDATE_INV_STOP_TRANSMIT && !!slots.linkObjType && !!slots.linkObjNumber;
            if (opcode !== ServerProt.UPDATE_INV_PARTIAL) setEquipmentObserved(client, false);
            queueMicrotask(() => {
                if (!stopped && opcode !== ServerProt.UPDATE_INV_PARTIAL) setEquipmentObserved(client, wasReady);
            });
            return component;
        }
        pendingBank++;
        // The packet handler fills the component after ifMutable returns. Publish
        // readiness after that synchronous handler, never while it is half filled.
        queueMicrotask(() => {
            pendingBank--;
            if (stopped) return;
            if (opcode === ServerProt.UPDATE_INV_STOP_TRANSMIT) { bankReady = false; bankWasOpen = false; return; }
            if (opcode === ServerProt.UPDATE_INV_FULL) bankReady = true;
            if (bankReady) { bankGeneration++; bankAt = Date.now(); }
        });
        return component;
    } : undefined;
    if (trackedMutable) client.ifMutable = trackedMutable;

    const deliver = (msg: object) => s.handleMessage(JSON.stringify(msg));
    const pushState = () => deliver({ type: 'sdk_state', state: client.collectBotState(tick), stateReceivedAt: Date.now() });
    const execute = (action: unknown) => {
        const refusal = guard?.(action);
        return refusal ? { success: false, reason: 'unowned_partner', message: refusal } : client.executeBotAction(action);
    };

    const onGameTick = () => {
        if (stopped) return;
        try {
            tick++;
            pushState();
            if (waitLeft > 0 && --waitLeft === 0) waitDone?.();
            // Like SDL_DispatchEventWatchList: freeze this dispatch's membership,
            // but respect removals. A new wait must start on the next game tick.
            for (const l of [...listeners]) if (listeners.has(l)) l();
        } catch (e) {
            console.error('[inprocess] tick handler error', e);
        }
    };

    const pump = async () => {
        if (running || stopped) return;
        const next = queue.shift();
        if (!next) return;
        running = true;
        let result: unknown;
        try {
            if (next.action.type === 'wait') {
                // The executor does not time waits (ActionExecutor.ts:48); the runner counts ticks.
                waitLeft = Math.max(1, next.action.ticks ?? 1);
                await new Promise<void>(r => { waitDone = r; });
                waitDone = null;
                result = { success: true, message: 'waited' };
            } else {
                result = await execute(next.action);
            }
        } catch (e) {
            result = { success: false, reason: 'error', message: String(e) };
        }
        running = false;
        if (stopped) return;
        deliver({ type: 'sdk_action_result', actionId: next.actionId, result });
        pushState();
        void pump();
    };

    return {
        start() {
            s.ws = { readyState: WebSocket.OPEN, close() {} };
            s.connectionState = 'connected';
            s.authenticated = true;
            s.send = (msg: { type: string; actionId?: string; action?: Queued['action'] }) => {
                if (msg.type === 'sdk_action' && msg.actionId && msg.action) {
                    queue.push({ actionId: msg.actionId, action: msg.action });
                    void pump();
                }
            };
            const max = client.getMaxMessageLength?.();
            if (max) deliver({ type: 'sdk_info', maxMessageLength: max });
            client.setOnGameTickCallback(onGameTick);
        },
        stop(reason: string) {
            if (stopped) return;
            stopped = true;
            setEquipmentObserved(client, false);
            if (trackedMutable && client.ifMutable === trackedMutable) client.ifMutable = originalMutable;
            client.setOnGameTickCallback(null);
            queue.length = 0;
            waitDone?.();
            s.connectionState = 'disconnected';
            s.ws = null;
            // Same as the SDK's own socket-close path (sdk/index.ts:315-319).
            for (const [, pending] of s.pendingActions as Map<string, { reject(e: Error): void; timeout?: ReturnType<typeof setTimeout> }>) {
                if (pending.timeout) clearTimeout(pending.timeout);
                pending.reject(Object.assign(new Error(`Session ended: ${reason}`), { reason: 'disconnected' }));
            }
            s.pendingActions.clear();
        },
        tick: () => tick,
        bankObservation() {
            if (stopped) return null;
            if (client.mainModalId !== 5292) {
                if (bankWasOpen) { bankReady = false; bankWasOpen = false; }
                return null;
            }
            if (!bankReady || pendingBank) return null;
            bankWasOpen = true;
            // Read the client now, not the SDK's previous PLAYER_INFO snapshot.
            const state = client.collectBotState(tick) as { bank?: { isOpen?: boolean; items?: BankObservation['items'] } };
            if (!state?.bank?.isOpen || !Array.isArray(state.bank.items)) return null;
            return { generation: bankGeneration, at: bankAt, items: state.bank.items.map(i => ({ id: i.id, name: i.name, count: i.count })) };
        },
        onTick(cb) {
            // Identity belongs to the subscription, even when a callback is
            // removed and re-added during the same dispatch.
            const listener = () => cb();
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        async direct(action) {
            if (stopped) return { success: false, message: 'session stopped' };
            return execute(action);
        },
    };
}

export interface Session {
    name: string;
    sdk: BotSDK;
    bot: BotActions;
    tick(): number;
    onTick(cb: () => void): () => void;
    direct(action: { type: string; [k: string]: unknown }): Promise<unknown>;
    close(): Promise<void>;
    ended: Promise<{ reason: string }>;
    // The LiteClient itself, for packets the action layer has no action for (quest-mm.ts: OPHELD5 on a puzzle
    // component). Absent on sessions that are not in-process.
    client?: unknown;
    // Local readiness contract; does not change the vendored SDK's state schema.
    bankObservation?(): BankObservation | null;
    // This session's own lifecycle attempt (session-lifecycle.ts). Absent on test doubles.
    lifecycle?: SessionAttempt;
}

// Read-only transport observation of one LiteClient: LiteClient.conn -> GameConnection.out/stream ->
// ClientStream.socket (vendor lite/net/GameConnection.ts, io/ClientStream.ts). Lengths, times and socket state
// only; never packet bytes, credentials or exception text.
type TransportSocket = { send?: (...a: unknown[]) => unknown; readyState?: unknown; bufferedAmount?: unknown; extensions?: unknown; protocol?: unknown };
const safeInt = (v: unknown) => Number.isSafeInteger(v) ? v as number : null;
function transportParts(client: unknown) {
    const conn = (client as { conn?: { out?: { pos?: unknown }; closed?: unknown; stream?: { socket?: TransportSocket } } } | undefined)?.conn;
    return { conn, socket: conn?.stream?.socket };
}
export function clientTransportState(client: unknown) {
    try {
        const { conn, socket } = transportParts(client);
        if (!conn) return null;
        return { outPos: safeInt(conn.out?.pos), closed: typeof conn.closed === 'boolean' ? conn.closed : null,
            readyState: safeInt(socket?.readyState), bufferedAmount: safeInt(socket?.bufferedAmount),
            extensions: typeof socket?.extensions === 'string' ? socket.extensions.slice(0, 128) : null };
    } catch { return null; }
}
export function observeClientTransport(client: unknown, write: (row: object) => void,
    opts: { now?: () => number; tick?: () => number; limit?: number } = {}) {
    const now = opts.now ?? Date.now, limit = opts.limit ?? 512;
    const emit = (row: object) => { try { write(row); } catch { /* Observation cannot change transport. */ } };
    const tick = () => { try { return safeInt(opts.tick?.()); } catch { return null; } };
    const { socket } = transportParts(client);
    const original = socket?.send;
    if (!socket || typeof original !== 'function') { emit({ kind: 'unavailable', at: now() }); return { restore() {} }; }
    const own = Object.prototype.hasOwnProperty.call(socket, 'send');
    let seq = 0;
    emit({ kind: 'attached', at: now(), tick: tick(), ...clientTransportState(client),
        protocol: typeof socket.protocol === 'string' ? socket.protocol.slice(0, 32) : null });
    socket.send = function (this: unknown, ...args: unknown[]) {
        const at = now(), before = safeInt(socket.bufferedAmount);
        const data = args[0] as { byteLength?: unknown; length?: unknown } | undefined;
        let outcome = 'threw';
        try { const result = Reflect.apply(original, this, args); outcome = 'returned'; return result; }
        finally {
            if (seq < limit) emit({ kind: 'write', seq: ++seq, at, tick: tick(), length: safeInt(data?.byteLength) ?? safeInt(data?.length),
                readyState: safeInt(socket.readyState), bufferedBefore: before, bufferedAfter: safeInt(socket.bufferedAmount), outcome });
            else if (seq++ === limit) emit({ kind: 'record-limit', at: now() });
        }
    };
    return { restore() { if (socket.send === original) return; if (own) socket.send = original; else delete socket.send; } };
}
export function inProcessRuntimePaths() {
    const real = (p: string) => { try { return realpathSync(p); } catch { return null; } };
    const session = vendor('server/webclient/src/lite/session.ts'), stream = vendor('server/webclient/src/io/ClientStream.ts');
    return { cwd: process.cwd(), execPath: process.execPath, adapter: import.meta.path, repoRoot, repoReal: real(repoRoot),
        liteSession: session, liteSessionReal: real(session), clientStream: stream, clientStreamReal: real(stream) };
}

// The lite session spreads logins with a random jitter on remote servers (session.ts:122, 5 s default) to spare the
// login server. Skip it only for our own local practice server.
export function loginJitterFor(host: string): number | undefined {
    return isLocalServer(host) ? 0 : undefined;
}

// The shim has no gateway connection, but SDK market reads still need the game HTTP origin.
export function inProcessSdkConfig(opts: {name:string;password:string;server?:string}): SDKConfig {
    const host=opts.server??'localhost:8888';
    return {botUsername:opts.name,password:opts.password,autoLaunchBrowser:false,autoReconnect:false,
        browserLaunchUrl:`${isLocalServer(host)?'http':'https'}://${host}/bot`};
}

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
const vendor = (p: string) => join(repoRoot, 'vendor', 'rs-sdk', p);
let pathfindingReady = false;

export async function connectInProcess(opts: { name: string; password: string; server?: string; members?: boolean; lifecycleRoot?:string; beforeConnect?:()=>void }): Promise<Session> {
    if(opts.lifecycleRoot&&!isLocalServer(opts.server??'localhost:8888'))throw Error('lifecycle root override is local-only');
    assertLoginAllowed(opts.name);
    // dom-shim must load before any webclient `#/` module (session.ts:15 does the same).
    await import(vendor('server/webclient/src/lite/dom-shim.ts'));
    const { startSession } = await import(vendor('server/webclient/src/lite/session.ts'));
    const { BotSDK } = await import(vendor('sdk/index.ts'));
    const { BotActions } = await import(vendor('sdk/actions.ts'));
    if (!pathfindingReady) {
        // Restores a saved rsmod memory snapshot when one matches (1.6 s instead of about 14 s).
        await loadPathfinding();
        pathfindingReady = true;
    }
    const cacheDir = join(repoRoot, '.practice', 'cache');
    mkdirSync(cacheDir, { recursive: true });
    return startInProcessSession(opts, { startSession, sdk: new BotSDK(inProcessSdkConfig(opts)), Actions: BotActions, cacheDir,
        beforeConnect:opts.beforeConnect,...(opts.lifecycleRoot?{lifecycle:{root:opts.lifecycleRoot}}:{}) });
}

export type StartSession = (o: any) => Promise<{ client: unknown; stop(): void; stopped: Promise<unknown> }>;
// The network part of connectInProcess. The lifecycle intent is written first; if it cannot be written, no
// connection starts. Every later event comes from this session's own callbacks. Tests pass a fake startSession.
export async function startInProcessSession(opts: { name: string; password: string; server?: string; members?: boolean },
    deps: { startSession: StartSession; sdk: BotSDK; Actions: new (sdk: BotSDK) => BotActions; cacheDir: string; lifecycle?: Parameters<typeof beginSessionAttempt>[1]; recordOwned?: typeof recordOwnedAccount;beforeConnect?:()=>void }): Promise<Session> {
    const { startSession, sdk, Actions, cacheDir } = deps;
    let endResolve!: (v: { reason: string }) => void;
    const ended = new Promise<{ reason: string }>(r => { endResolve = r; });
    let shim: Shim | null = null;
    const host = opts.server ?? 'localhost:8888'; // host:port, same as SERVER in bot.env
    // Async imports/pathfinding can outlive an owner stop. Recheck before any intent or network work.
    deps.beforeConnect?.();
    const attempt = beginSessionAttempt({ account: opts.name, server: host, members: opts.members, secret: opts.password }, deps.lifecycle);
    let session: Awaited<ReturnType<StartSession>>;
    try {
        session = await startSession({
        host,
        username: opts.name,
        password: opts.password,
        cacheDir,
        quiet: true,
        onClient: (client: ClientLike) => {
            const created = createShim(client, sdk, action => {
                const a=action as any;
                const trading=a.type==='interactPlayer'&&a.optionIndex===4 || ['clickComponent','clickComponentWithOption'].includes(a.type)&&[3420,3546].includes(a.componentId);
                return trading ? tradeRefusal(a,sdk.getState(),tradePartners(host)) : null;
            });
            shim = created;
            created.start();
        },
        ...(loginJitterFor(host) !== undefined ? { loginJitterMs: loginJitterFor(host) } : {}),
        ...(opts.members !== undefined ? { members: opts.members } : {}),
        onEnd: (end: { reason: string }) => {
            // The server end reason of this exact attempt; 'logged-out' is the only logout confirmation.
            attempt.record('ended', end.reason);
            // Publish the lifecycle event before rejected queued actions can
            // be mistaken by their callers for a task prerequisite failure.
            endResolve({ reason: end.reason });
            (shim as Shim | null)?.stop(end.reason);
        },
        });
    } catch (e) {
        attempt.record('connect-failed', String(e));
        throw e;
    }
    // The bootstrap callback runs before startSession returns.
    const sh = shim as Shim | null;
    if (!sh) { attempt.record('connect-failed', 'no packet observer'); throw new Error('Session did not install its packet observer'); }
    attempt.record('connected');
    (deps.recordOwned ?? recordOwnedAccount)(opts.name,host);
    const bot: BotActions = new Actions(sdk);
    return {
        name: opts.name,
        sdk,
        bot,
        tick: () => sh.tick(),
        onTick: cb => sh.onTick(cb),
        bankObservation: () => sh.bankObservation(),
        direct: a => sh.direct(a),
        ended,
        client: session.client,
        lifecycle: attempt,
        async close() {
            sh.stop('stopped');
            session.stop();
            await session.stopped;
            attempt.record('closed');
        },
    };
}
