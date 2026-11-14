import {installGameWebSocketProxy} from './websocket-proxy';
import { appendFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BotSDK } from '../../../vendor/rs-sdk/sdk/index';
import type { BotActions } from '../../../vendor/rs-sdk/sdk/actions';
import type { SDKConfig } from '../../../vendor/rs-sdk/sdk/types';
import { loadPathfinding } from './pathcache';
import { assertLoginAllowed } from './haggisgate';
import { fleetLeaseAllowsWorker } from './fleet-lease';
import { acquireFleetSwarmClaim, acquireFleetTradeClaim, type FleetTradeClaim } from './fleet-trade-claim';
import { mySide } from './fleet';
import { planLockDir, withPlanWrite } from './plan-lock';
import { isLocalServer } from './localserver';
import { ownedAccounts, tradePartners, recordOwnedAccount, tradeRefusal } from './tradeguard';
import { ServerProt } from '../../../vendor/rs-sdk/server/webclient/src/io/ServerProt';
import { ClientProt } from '../../../vendor/rs-sdk/server/webclient/src/io/ClientProt';
import { tickWaits } from './tick-stream';
import { executionWait } from '../../../vendor/rs-sdk/sdk/execution-context';
import { setEquipmentObserved } from './container-observation';
import { beginSessionAttempt, lifecycleOwner, type SessionAttempt } from './session-lifecycle';
import { assertSpentRecoveryConnection, type RecoveryConnectionAdmission } from './session-recovery-permit';
import { assertWorkerRelease } from './worker-release';
import type { TickRecorder } from './tick-record';
// The wait checks of every lockstep session of this process (selfWaiting in createShim).
const waitingSessions = new Set<() => boolean>();
// The executors that wait for the server to open a count dialog (a withdraw or deposit of X): the dialog comes in
// the next tick, so a lockstep session in this wait waits for a tick, as a waitTicks does. Without this the running
// action held each such tick for SIM_BUSY_MS (ActionExecutor.ts waitForCountDialogAndSubmit polls the wall clock).
// The prototype of the client's executor (vendor/rs-sdk/server/webclient/src/bot/ActionExecutor.ts) is wrapped once,
// from the first executor a lockstep check sees.
const dialogWaits = new WeakSet<object>(), wrapped = new WeakSet<object>();
function dialogWaiting(executor: object | undefined): boolean {
    if (!executor) return false;
    const proto = Object.getPrototypeOf(executor) as { waitForCountDialogAndSubmit?: (this: object, ...args: unknown[]) => Promise<unknown> } | null;
    if (proto && !wrapped.has(proto) && typeof proto.waitForCountDialogAndSubmit === 'function') {
        wrapped.add(proto);
        const wait = proto.waitForCountDialogAndSubmit;
        proto.waitForCountDialogAndSubmit = async function (...args: unknown[]) { dialogWaits.add(this); try { return await wait.apply(this, args); } finally { dialogWaits.delete(this); } };
    }
    return dialogWaits.has(executor);
}

// Runs BotSDK + BotActions in the same process as a LiteClient, with no gateway.
// BotSDK only speaks WebSocket (sdk/index.ts:272), so the shim fakes a connected socket and feeds it the
// same messages the gateway would (see research/phase2-recon.md section 1).

export interface ClientLike {
    collectBotState(tick: number): unknown;
    executeBotAction(action: unknown): unknown | Promise<unknown>;
    setOnGameTickCallback(cb: (() => void) | null): void;
    pumpPackets?(): Promise<void>;
    flush?(): void;
    writeOpcode?(opcode: number): void;
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
    // Starts the per-tick run record (tick-record.ts) from the next publication; null stops it.
    record(recorder: TickRecorder | null): void;
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
    let recorder: TickRecorder | null = null;
    let commands = 0;
    const indexes = new Map<string, number>();
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
    const pushState = (kind: 's' | 'p' = 'p') => {
        const state = client.collectBotState(tick);
        recorder?.publish(tick, state, kind);
        deliver({ type: 'sdk_state', state, stateReceivedAt: Date.now() });
    };
    const execute = (action: unknown) => {
        const refusal = guard?.(action);
        if (refusal) return { success: false, reason: 'unowned_partner', message: refusal };
        const dispatched = (result: unknown) => {
            const reply = result as { success?: unknown; phase?: unknown } | null;
            // Protocol actions append bytes synchronously. Send them before a
            // promise continuation or a busy packet pump can delay the flush.
            if (!stopped && reply?.success === true && reply.phase === 'dispatch') client.flush?.();
            return result;
        };
        const result = client.executeBotAction(action);
        return result && typeof (result as { then?: unknown }).then === 'function'
            ? Promise.resolve(result).then(dispatched) : dispatched(result);
    };

    const originalPacketPump = client.pumpPackets;
    let pumpingPackets = false, pendingTicks = 0;
    // Lockstep practice engine (SIM_LOCKSTEP=1): the engine runs its next tick when every client has sent bytes after
    // this one, so any byte is an acknowledgement. From the first game tick the client's flush is held: the actions of
    // one tick and a closing NO_TIMEOUT leave in one write. That write goes out on a macrotask once the script waits
    // for a tick again: a pending waitTicks or waitUntil, a pending wait action, or an SDK state waiter above the
    // lowest listener count seen. A script that works off the tick clock (a world load, a route search) has none of
    // these, so it holds the tick until it waits. SIM_BUSY_MS (default 2000) bounds the hold, for a script that ends
    // without a wait. SIM_ACK_FILE receives one line per held tick and a total at the end.
    const lockstep = process.env.SIM_LOCKSTEP === '1';
    const busyMs = Number(process.env.SIM_BUSY_MS ?? 2000);
    const scriptMs = Math.min(busyMs, Number(process.env.SIM_SCRIPT_MS ?? 500));
    const ackFile = process.env.SIM_ACK_FILE;
    // pumpMs: the packet reads of the client; stateMs: the state of a tick; scriptMs: the tick listeners (the script).
    const ackStat = { ticks: 0, held: 0, heldMs: 0, capped: 0, pumpMs: 0, stateMs: 0, scriptMs: 0 };
    const sendNow = client.flush?.bind(client);
    let flushHeld = false, ackGeneration = 0, stateWaiters = 0, stateWaitersLow = Infinity, listenersLow = Infinity, scriptTick = false;
    // An executor action whose result is a promise waits for the server (a count dialog: ActionExecutor
    // waitForCountDialogAndSubmit). Its bytes go out only with the tick's acknowledgement, so holding the tick for it
    // held the dialog back until SIM_BUSY_MS: each bank deposit or withdraw of a count other than 1, 5, 10 or all cost
    // 2 s of wall time and no tick (bench --profile, skiller:magic:splash and skiller:firemaking:order). Once the
    // dialog is open, the tick waits for the submit as before, so the tick count does not change.
    let actionPending = false;
    // SIM_ACK_FILE only: the SDK calls in flight, named on each held tick, to find a wait that the ack does not see.
    const inFlight = new Map<string, number>();
    // SDK waits in progress (waitForObservation and the waits that subscribe by themselves). The listener count above
    // its lowest value missed them: when a script's first wait was open at the first check, the lowest value was that
    // wait, and each later single wait held its tick to SIM_BUSY_MS. Bench --profile, extra:firemaking-stock-low: 18
    // held ticks, each with sdk=waitForObservation,waitForCondition and state=1/1.
    let sdkWaits = 0;
    const serverWaiting = () => actionPending && !(client as { isChatBackInputOpen?(): boolean }).isChatBackInputOpen?.();
    // This session waits for a tick: a pending wait action, an SDK wait, an action that waits for the server, or an SDK
    // state waiter above the lowest listener count seen.
    const inDialogWait = () => dialogWaiting((client as { executor?: object }).executor);
    const selfWaiting = () => waitLeft > 0 || sdkWaits > 0 || serverWaiting() || stateWaiters > stateWaitersLow || inDialogWait();
    const holdFlush = () => { if (!flushHeld && sendNow) { flushHeld = true; client.flush = () => {}; } };
    const releaseFlush = () => { if (flushHeld) { flushHeld = false; delete (client as { flush?: unknown }).flush; sendNow?.(); } };
    const acknowledgeTick = () => {
        const generation = ++ackGeneration, since = performance.now();
        let turns = 0;
        const check = () => {
            if (stopped || generation !== ackGeneration) return;
            stateWaitersLow = Math.min(stateWaitersLow, stateWaiters);
            // Any session of the process that waits counts, as `tickWaits` counts for the whole process: a session
            // with no script of its own (a gang account between two fights, one whose part has ended) answers as soon
            // as another session waits, in place of holding each tick for SIM_BUSY_MS.
            // A session whose own script waited on its ticks when this tick came (a tick listener above the lowest
            // count seen) answers only once that script waits again: the actions of the tick then go out with this
            // acknowledgement and not, as the machine's speed decides, with the next.
            // A pending action waits for the server until its count dialog is open; then the executor submits within
            // its 50 ms poll and the tick waits for that, as before, so the submit stays in the same tick.
            const serverWait = serverWaiting();
            const waiting = scriptTick ? listeners.size > listenersLow || selfWaiting()
                : tickWaits.active > 0 || selfWaiting() || [...waitingSessions].some(f => f());
            // The count-dialog wait counts as a wait only until the dialog is open; then the tick holds for the submit,
            // so the submit lands in the same tick on every run, whatever the executor's 50 ms poll meets.
            const dialogOpen = !!(client as { isChatBackInputOpen?(): boolean }).isChatBackInputOpen?.();
            const busy = (running && waitLeft === 0 && !serverWait && !(inDialogWait() && !dialogOpen)) || !waiting;
            // A script that ended after its last tick wait leaves no wait: SIM_SCRIPT_MS (500) bounds that hold.
            if (busy && performance.now() - since < (scriptTick ? scriptMs : busyMs)) { if (turns++ < 20) setImmediate(check); else setTimeout(check, 1); return; }
            const held = performance.now() - since;
            ackStat.ticks++; if (busy) ackStat.capped++; if (held > 2) { ackStat.held++; ackStat.heldMs += held; }
            if (ackFile && held > 2) appendFileSync(ackFile, `ACK tick=${tick} bot=${(client as { loginUser?: string }).loginUser ?? "?"} waits=${tickWaits.active} state=${stateWaiters}/${stateWaitersLow} running=${running} pending=${actionPending} serverWait=${serverWait} sdk=${[...inFlight].map(([k, n]) => `${k}${n > 1 ? `x${n}` : ''}`).join(',') || '-'} held=${held.toFixed(0)}ms${busy ? ' CAPPED' : ''}\n`);
            client.writeOpcode?.(ClientProt.NO_TIMEOUT);
            sendNow?.();
        };
        setImmediate(check);
    };
    const publishTick = () => {
        if (stopped) return;
        if (animTick) owedCycles += cyclesPerTick;
        const listenersBefore = listeners.size;
        try {
            tick++;
            const t0 = performance.now();
            pushState('s');
            const t1 = performance.now();
            if (waitLeft > 0 && --waitLeft === 0) waitDone?.();
            // Like SDL_DispatchEventWatchList: freeze this dispatch's membership,
            // but respect removals. A new wait must start on the next game tick.
            for (const l of [...listeners]) if (listeners.has(l)) l();
            // A one-time tick wait (nextTick, a tick stream's step) leaves the set as it fires.
            listenersLow = Math.min(listenersLow, listeners.size);
            scriptTick = lockstep && listenersBefore > listenersLow;
            ackStat.stateMs += t1 - t0; ackStat.scriptMs += performance.now() - t1;
        } catch (e) {
            console.error('[inprocess] tick handler error', e);
        }
        if (lockstep) { holdFlush(); acknowledgeTick(); }
    };
    const onGameTick = () => {
        // PLAYER_INFO can precede interface packets in the same socket batch.
        // LiteClient also snaps authoritative positions only after draining it.
        if (pumpingPackets) pendingTicks++;
        else publishTick();
    };
    // Lockstep: the lite client ages animations once for each 20 ms pass of its session loop (LiteClient.tickCycle), at
    // a speed taken from the measured tick length (notifyGameTick). Both run on the wall clock, so on a lockstep engine an
    // animation lasted a number of ticks that changed with the machine's load, and a spar batch did not repeat on one
    // seed. With the tick clock each game tick gives SIM_TICK_MS / 20 cycles at the speed of a SIM_TICK_MS server
    // (default 300, the live server's tick), aged just before the packets of the next tick are read: the engine sends
    // a tick's packets in one message (simBatchAll), so bytes waiting mean a new tick. SIM_ANIM_CLOCK=wall keeps the
    // wall clock.
    const animTick = lockstep && process.env.SIM_ANIM_CLOCK !== 'wall';
    const animTickMs = Number(process.env.SIM_TICK_MS ?? 300);
    const cyclesPerTick = Math.max(1, Math.round(animTickMs / 20));
    const liteCycle = (client as { tickCycle?: () => void }).tickCycle?.bind(client);
    let owedCycles = 0, wallSpeed: number | undefined;
    const ageOwed = () => {
        if (!owedCycles || !liteCycle) return;
        const stream = (transportParts(client).conn as { stream?: { available?: number } } | undefined)?.stream;
        if (!(Number(stream?.available) > 0)) return;
        for (let i = 0; i < owedCycles; i++) liteCycle();
        owedCycles = 0;
    };
    const drainOnce = originalPacketPump ? async () => {
        pumpingPackets = true;
        const t0 = performance.now();
        if (animTick) ageOwed();
        try { await originalPacketPump.call(client); }
        catch (error) { pendingTicks = 0; throw error; }
        finally { pumpingPackets = false; ackStat.pumpMs += performance.now() - t0; }
        const count = pendingTicks;
        pendingTicks = 0;
        for (let i = 0; i < count && !stopped; i++) publishTick();
    } : undefined;
    // One pump at a time: the session loop and the lockstep socket listener both ask for one.
    let pumpTail: Promise<void> = Promise.resolve();
    const drainPacketBatch = drainOnce ? () => { const run = pumpTail.then(drainOnce); pumpTail = run.catch(() => {}); return run; } : undefined;
    // Lockstep: the session loop reads the socket every 20 ms, so with 16 clients each tick waits about 60 ms for the
    // slowest read. A read as soon as bytes arrive takes that wait out. SIM_EAGER_READ=0 turns it off.
    const eagerRead = () => { if (!stopped) void client.pumpPackets?.().catch(() => {}); };
    let eagerSocket: { removeEventListener?(type: string, l: () => void): void } | undefined;

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
                const pending = execute(next.action);
                if (pending && typeof (pending as { then?: unknown }).then === 'function') {
                    actionPending = true;
                    try { result = await pending; } finally { actionPending = false; }
                } else result = pending;
            }
        } catch (e) {
            result = { success: false, reason: 'error', message: String(e) };
        }
        running = false;
        if (stopped) return;
        const index = indexes.get(next.actionId);
        if (index !== undefined) { indexes.delete(next.actionId); recorder?.result(tick, index, result); }
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
                    if (recorder) { const index = commands++; indexes.set(msg.actionId, index); recorder.action(tick, index, msg.action, false); }
                    queue.push({ actionId: msg.actionId, action: msg.action });
                    void pump();
                }
            };
            const max = client.getMaxMessageLength?.();
            if (max) deliver({ type: 'sdk_info', maxMessageLength: max });
            // Lockstep: an SDK wait (waitForCondition, waitForStateChange, the waits of every BotActions call) times out
            // after its timeout in game ticks of SIM_WAIT_TICK_MS (default 400, the live tick), not in wall time. On
            // wall time a wait that never comes true held the engine for its whole timeout (a bank call of a gang
            // account: 40 s), and the ticks it cost hung on the speed of the machine.
            if (lockstep && typeof s.waitForObservation === 'function') {
                const tickMs = Math.max(1, Number(process.env.SIM_WAIT_TICK_MS ?? 400));
                s.waitForObservation = (predicate: (state: unknown) => boolean, timeout: number, message: string) => executionWait<unknown>((resolve, reject) => {
                    let left = Math.max(1, Math.ceil(timeout / tickMs));
                    const countdown = () => { if (--left <= 0) reject(new Error(message)); };
                    listeners.add(countdown);
                    const off = s.onStateUpdate((state: unknown) => { try { if (predicate(state)) resolve(state); } catch (error) { reject(error); } });
                    return () => { listeners.delete(countdown); off(); };
                });
            }
            if (lockstep) for (const name of ['waitForObservation', 'waitForStateUpdate', 'waitForChat', 'waitForTradeRequest', 'waitForReady'] as const) {
                const sdk = s as unknown as Record<string, unknown>, wait = sdk[name];
                if (typeof wait !== 'function') continue;
                sdk[name] = function (this: unknown, ...args: unknown[]) {
                    sdkWaits++;
                    let out: unknown;
                    try { out = (wait as (...a: unknown[]) => unknown).apply(this, args); } catch (e) { sdkWaits--; throw e; }
                    return Promise.resolve(out).finally(() => { sdkWaits--; });
                };
            }
            if (lockstep && ackFile) {
                const sdk = s as unknown as Record<string, unknown>;
                for (let proto = Object.getPrototypeOf(sdk); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
                    for (const name of Object.getOwnPropertyNames(proto)) {
                        const fn = proto[name];
                        if (name === 'constructor' || typeof fn !== 'function' || Object.prototype.hasOwnProperty.call(sdk, name)) continue;
                        sdk[name] = function (this: unknown, ...args: unknown[]) {
                            const out = (fn as (...a: unknown[]) => unknown).apply(this, args);
                            if (!out || typeof (out as { then?: unknown }).then !== 'function') return out;
                            inFlight.set(name, (inFlight.get(name) ?? 0) + 1);
                            return Promise.resolve(out).finally(() => { const n = (inFlight.get(name) ?? 1) - 1; if (n) inFlight.set(name, n); else inFlight.delete(name); });
                        };
                    }
                }
            }
            if (lockstep && typeof s.onStateUpdate === 'function') {
                const subscribe = s.onStateUpdate.bind(s);
                s.onStateUpdate = (listener: unknown) => { stateWaiters++; const off = subscribe(listener); let live = true; return () => { if (live) { live = false; stateWaiters--; } return off(); }; };
            }
            if (lockstep) waitingSessions.add(selfWaiting);
            if (drainPacketBatch) client.pumpPackets = drainPacketBatch;
            if (animTick && liteCycle) {
                // The session loop's pass no longer ages; the speed is the one of a SIM_TICK_MS server (LiteClient ageEntityAnim).
                (client as { tickCycle?: () => void }).tickCycle = () => {};
                wallSpeed = (client as { tickSpeedMultiplier?: number }).tickSpeedMultiplier;
                Object.defineProperty(client, 'tickSpeedMultiplier', { configurable: true, get: () => Math.max(1, 420 / animTickMs), set: () => {} });
            }
            client.setOnGameTickCallback(onGameTick);
            if (lockstep && drainPacketBatch && process.env.SIM_EAGER_READ !== '0') {
                const socket = transportParts(client).socket as { addEventListener?(type: string, l: () => void): void; removeEventListener?(type: string, l: () => void): void } | undefined;
                if (typeof socket?.addEventListener === 'function') { socket.addEventListener('message', eagerRead); eagerSocket = socket; }
            }
        },
        stop(reason: string) {
            if (stopped) return;
            stopped = true;
            waitingSessions.delete(selfWaiting);
            if (lockstep && ackFile) appendFileSync(ackFile, `ACK_STAT ${JSON.stringify(ackStat)}
`);
            releaseFlush();
            setEquipmentObserved(client, false);
            if (trackedMutable && client.ifMutable === trackedMutable) client.ifMutable = originalMutable;
            client.setOnGameTickCallback(null);
            eagerSocket?.removeEventListener?.('message', eagerRead);
            pendingTicks = 0;
            if (drainPacketBatch && client.pumpPackets === drainPacketBatch) client.pumpPackets = originalPacketPump;
            if (animTick && liteCycle) { delete (client as { tickCycle?: unknown }).tickCycle; Object.defineProperty(client, 'tickSpeedMultiplier', { configurable: true, writable: true, value: wallSpeed ?? 1 }); }
            queue.length = 0;
            recorder?.end(tick, reason);
            recorder = null;
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
            if (!recorder) return execute(action);
            const index = commands++, own = recorder;
            own.action(tick, index, action, true);
            const result = await execute(action);
            own.result(tick, index, result);
            return result;
        },
        record(next) {
            if (recorder && recorder !== next) recorder.end(tick, 'record replaced');
            recorder = stopped ? null : next;
            if (recorder) recorder.publish(tick, client.collectBotState(tick), 'p');
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
    // Per-tick run record (tick-record.ts). Absent on test doubles.
    record?(recorder: TickRecorder | null): void;
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

export type TradeAdmission = {
    orderId: string;
    role: FleetTradeClaim['role'];
    check(server: string): void;
    prepare(claim: FleetTradeClaim): void;
};

export async function connectInProcess(opts: { name: string; password: string; server?: string; members?: boolean; lifecycleRoot?:string; beforeConnect?:()=>void; lockPlan?: boolean; recoverSwarm?: RecoveryConnectionAdmission; trade?: TradeAdmission }): Promise<Session> {
    if(opts.lifecycleRoot&&!isLocalServer(opts.server??'localhost:8888'))throw Error('lifecycle root override is local-only');
    const server = opts.server ?? 'localhost:8888';
    const live = !isLocalServer(server);
    if (!live && opts.trade) throw Error('fleet trade claim requires a live server');
    const swarm = live && !!process.env.SWARM_LEASE_HOLDER;
    const ticket = assertLoginAllowed(opts.name, Date.now(), process.env, server);
    installGameWebSocketProxy();
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
    const lifecycle: NonNullable<Parameters<typeof beginSessionAttempt>[1]> = {root: opts.lifecycleRoot};
    const beforeConnect = () => {
        const currentTicket = assertLoginAllowed(opts.name, Date.now(), process.env, server);
        if (currentTicket !== ticket) throw Error('specialist authorization changed before login');
        if (!isLocalServer(server) && !fleetLeaseAllowsWorker(repoRoot)) throw Error('fleet controller lease unavailable');
        const stopped = (file: string) => existsSync(join(repoRoot, '.practice', file));
        if (live && (stopped('stop-' + opts.name) || stopped('stop-' + opts.name.toLowerCase()) || swarm && stopped('stop-swarm'))) {
            throw Error('live admission paused by stop file');
        }
        if (live && opts.recoverSwarm) assertSpentRecoveryConnection(opts.recoverSwarm, opts.name, server);
        opts.beforeConnect?.();
        if (currentTicket) {
            assertWorkerRelease();
            lifecycle.owner = {...lifecycleOwner(), specialistAuthorization: {ticket: currentTicket, mission: process.env.SWARM_MISSION_HASH!}};
        }
        opts.trade?.check(server);
    };
    return startInProcessSession(opts, { startSession, sdk: new BotSDK(inProcessSdkConfig(opts)), Actions: BotActions, cacheDir,
        beforeConnect,planLock:opts.lockPlan||ticket||opts.trade?planLockDir:undefined,lifecycle,
        sharedAccount:live?{root:repoRoot,side:mySide(),recover:!!opts.recoverSwarm,trade:opts.trade}:undefined });
}

// Read-only observation of the lite bootstrap HTTP calls (session.ts /api/version, cache.ts /crc and archives,
// LocIndex.ts versionlist and ondemand.zip). Rows hold host, path, status or error and elapsed time; never headers or bodies.
export type FetchRow = { url: string | null; status?: number; length?: string | null; error?: string; ms: number };
export function observeFetch(target: { fetch: typeof fetch } = globalThis, now: () => number = Date.now) {
    const original = target.fetch, rows: FetchRow[] = [];
    const wrapped = async function (this: unknown, ...args: Parameters<typeof fetch>) {
        const at = now(), input = args[0] as unknown;
        let url: string | null = null;
        try { const u = new URL(typeof input === 'string' || input instanceof URL ? input : (input as Request).url); url = u.host + u.pathname; } catch { /* unparsed */ }
        try {
            const res = await Reflect.apply(original, this, args) as Response;
            if (rows.length < 32) rows.push({ url, status: res.status, length: res.headers.get('content-length'), ms: now() - at });
            return res;
        } catch (error) {
            if (rows.length < 32) rows.push({ url, error: String(error).slice(0, 160), ms: now() - at });
            throw error;
        }
    };
    target.fetch = Object.assign(wrapped, original) as typeof fetch;
    return { rows, restore() { if (target.fetch === wrapped) target.fetch = original; } };
}
// The lifecycle receipt keeps 300 characters of detail. Bun's socket errors carry a long second sentence, so keep
// the first sentence of each error and drop the oldest rows first: the request that threw is the last row.
export function connectFailedDetail(error: unknown, rows: FetchRow[], max = 300): string {
    if (!rows.length) return String(error);
    const brief = (text: string) => text.split('. ')[0]!.slice(0, 100);
    const kept = rows.map(r => r.error === undefined ? r : { ...r, error: brief(r.error) });
    const text = () => brief(String(error)) + ' http=' + JSON.stringify(kept);
    while (kept.length > 1 && text().length > max) kept.shift();
    return text();
}

export type StartSession = (o: any) => Promise<{ client: unknown; stop(): void; stopped: Promise<unknown> }>;
// The network part of connectInProcess. The lifecycle intent is written first; if it cannot be written, no
// connection starts. Every later event comes from this session's own callbacks. Tests pass a fake startSession.
export async function startInProcessSession(opts: { name: string; password: string; server?: string; members?: boolean },
    deps: { startSession: StartSession; sdk: BotSDK; Actions: new (sdk: BotSDK) => BotActions; cacheDir: string; lifecycle?: Parameters<typeof beginSessionAttempt>[1]; recordOwned?: typeof recordOwnedAccount;beforeConnect?:()=>void; planLock?: string; sharedAccount?:{root:string;side:string;recover?:boolean;trade?:TradeAdmission} }): Promise<Session> {
    const { startSession, sdk, Actions, cacheDir } = deps;
    let endResolve!: (v: { reason: string }) => void;
    const ended = new Promise<{ reason: string }>(r => { endResolve = r; });
    let shim: Shim | null = null;
    const host = opts.server ?? 'localhost:8888'; // host:port, same as SERVER in bot.env
    let sharedClaim: ReturnType<typeof acquireFleetSwarmClaim> | undefined;
    let tradeClaim: ReturnType<typeof acquireFleetTradeClaim> | undefined;
    const admit = () => {
        // Async imports/pathfinding can outlive an owner stop. Recheck before any intent or network work.
        deps.beforeConnect?.();
        if (deps.sharedAccount) {
            const { root, side, recover, trade } = deps.sharedAccount;
            const target = { account: opts.name, server: host, side };
            if (trade) tradeClaim = acquireFleetTradeClaim(root, {...target, orderId: trade.orderId, role: trade.role});
            else sharedClaim = acquireFleetSwarmClaim(root, target, { recover });
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
            if (attempt.record('ended', end.reason) && end.reason === 'logged-out') confirmedLogout = true;
            // Publish the lifecycle event before rejected queued actions can
            // be mistaken by their callers for a task prerequisite failure.
            endResolve({ reason: end.reason });
            (shim as Shim | null)?.stop(end.reason);
        },
        });
    } catch (e) {
        attempt.record('connect-failed', connectFailedDetail(e, http.rows));
        releaseConfirmed();
        throw e;
    } finally { http.restore(); }
    // The bootstrap callback runs before startSession returns.
    const sh = shim as Shim | null;
    if (!sh) {
        attempt.record('connect-failed', 'no packet observer');
        releaseConfirmed();
        throw new Error('Session did not install its packet observer');
    }
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
}
