import type { BotSDK } from '../../../../vendor/rs-sdk/sdk/index';
import { isPlayerChat } from '../../../../vendor/rs-sdk/sdk/types';
import { ServerProt } from '../../../../vendor/rs-sdk/server/webclient/src/io/ServerProt';
import { assertActionScope } from '../action-scope';
import { setEquipmentObserved } from '../container-observation';
import type { TickRecorder } from '../tick-record';
import { createLockstepClock } from './lockstep';
import type { BankObservation, ClientLike, Shim } from './types';

type Queued = { actionId: string; action: { type: string; ticks?: number } };

function createInventoryTracker(client: ClientLike, isStopped: () => boolean, getTick: () => number) {
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
        if ((id !== 5382 && id !== 1688) || !component || (opcode !== ServerProt.UPDATE_INV_FULL && opcode !== ServerProt.UPDATE_INV_PARTIAL && opcode !== ServerProt.UPDATE_INV_STOP_TRANSMIT)) return component;
        if (id === 1688) {
            // Invalidate immediately; publish only after the handler fills all slots.
            const slots = component as { linkObjType?: unknown; linkObjNumber?: unknown };
            const wasReady = opcode !== ServerProt.UPDATE_INV_STOP_TRANSMIT && !!slots.linkObjType && !!slots.linkObjNumber;
            if (opcode !== ServerProt.UPDATE_INV_PARTIAL) setEquipmentObserved(client, false);
            queueMicrotask(() => {
                if (!isStopped() && opcode !== ServerProt.UPDATE_INV_PARTIAL) setEquipmentObserved(client, wasReady);
            });
            return component;
        }
        pendingBank++;
        // The packet handler fills the component after ifMutable returns. Publish
        // readiness after that synchronous handler, never while it is half filled.
        queueMicrotask(() => {
            pendingBank--;
            if (isStopped()) return;
            if (opcode === ServerProt.UPDATE_INV_STOP_TRANSMIT) { bankReady = false; bankWasOpen = false; return; }
            if (opcode === ServerProt.UPDATE_INV_FULL) bankReady = true;
            if (bankReady) { bankGeneration++; bankAt = Date.now(); }
        });
        return component;
    } : undefined;
    if (trackedMutable) client.ifMutable = trackedMutable;
    return {
        bankObservation(): BankObservation | null {
            if (isStopped()) return null;
            if (client.mainModalId !== 5292) {
                if (bankWasOpen) { bankReady = false; bankWasOpen = false; }
                return null;
            }
            if (!bankReady || pendingBank) return null;
            bankWasOpen = true;
            // Read the client now, not the SDK's previous PLAYER_INFO snapshot.
            const state = client.collectBotState(getTick()) as { bank?: { isOpen?: boolean; items?: BankObservation['items'] } };
            if (!state?.bank?.isOpen || !Array.isArray(state.bank.items)) return null;
            return { generation: bankGeneration, at: bankAt, items: state.bank.items.map(i => ({ id: i.id, name: i.name, count: i.count })) };
        },
        restore() {
            setEquipmentObserved(client, false);
            if (trackedMutable && client.ifMutable === trackedMutable) client.ifMutable = originalMutable;
        },
    };
}

// Runs BotSDK + BotActions in the same process as a LiteClient, with no gateway.
// BotSDK only speaks WebSocket (sdk/index.ts:272), so the shim fakes a connected socket and feeds it the
// same messages the gateway would (see research/phase2-recon.md section 1).
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
    let listenersDirty = false;
    let listenerSnapshot: (() => void)[] = [];
    const rawListenerAdd = listeners.add.bind(listeners);
    const rawListenerDelete = listeners.delete.bind(listeners);
    listeners.add = (l: () => void) => { listenersDirty = true; return rawListenerAdd(l); };
    listeners.delete = (l: () => void) => { const deleted = rawListenerDelete(l); if (deleted) listenersDirty = true; return deleted; };
    const inventory = createInventoryTracker(client, () => stopped, () => tick);

    // Real BotSDK instances accept direct in-process delivery, avoiding a full-state JSON.stringify + JSON.parse
    // copy on every game tick and action. Unit doubles with custom handleMessage keep the JSON path.
    const canDeliverDirect = !Object.prototype.hasOwnProperty.call(s, 'handleMessage')
        && typeof s.chatHistory?.record === 'function'
        && s.stateListeners instanceof Set
        && s.pendingActions instanceof Map
        && s.config && typeof s.config === 'object';
    const deliver = (msg: { type: string; state?: any; stateReceivedAt?: number; actionId?: string; result?: unknown; maxMessageLength?: number }) => {
        if (!canDeliverDirect) {
            s.handleMessage(JSON.stringify(msg));
            return;
        }
        if (msg.type === 'sdk_info' && typeof msg.maxMessageLength === 'number' && msg.maxMessageLength > 0) {
            s.serverMaxMessageLength = msg.maxMessageLength;
            return;
        }
        if (msg.type === 'sdk_state' && msg.state) {
            const st = msg.state;
            if (s.config.showChat === false && st.gameMessages) {
                st.gameMessages = st.gameMessages.filter((m: { type: number }) => !isPlayerChat(m.type));
            }
            if (st.gameMessages) s.chatHistory.record(st.gameMessages);
            if (st.nearbyPlayers) {
                for (let i = 0; i < st.nearbyPlayers.length; i++) {
                    const p = st.nearbyPlayers[i];
                    if (p && p.worldX === undefined) { p.worldX = p.x; p.worldZ = p.z; }
                }
            }
            if (st.trade) {
                for (const list of [st.trade.myOffer, st.trade.theirOffer]) {
                    if (!list) continue;
                    for (let i = 0; i < list.length; i++) {
                        const item = list[i];
                        if (item && item.amount === undefined) item.amount = item.count;
                    }
                }
            }
            if (st.skills) {
                const nameMap: Record<string, unknown> = Object.create(null);
                for (let i = 0; i < st.skills.length; i++) {
                    const skill = st.skills[i];
                    if (skill && !/^Stat\d+$/i.test(skill.name)) nameMap[skill.name] = skill;
                }
                st.skills = new Proxy(st.skills, {
                    get(target, prop, receiver) {
                        if (typeof prop === 'string' && prop in nameMap) return nameMap[prop];
                        return Reflect.get(target, prop, receiver);
                    },
                });
            }
            s.state = st;
            s.stateReceivedAt = msg.stateReceivedAt || Date.now();
            for (const listener of s.stateListeners as Set<(state: unknown) => void>) {
                try { listener(st); } catch (e) { console.error('State listener error:', e); }
            }
            return;
        }
        if (msg.type === 'sdk_action_result' && msg.actionId) {
            const pending = (s.pendingActions as Map<string, { resolve(r: unknown): void; reject(e: Error): void; timeout?: ReturnType<typeof setTimeout> }>).get(msg.actionId);
            if (pending) {
                if (pending.timeout) clearTimeout(pending.timeout);
                s.pendingActions.delete(msg.actionId);
                if (msg.result) pending.resolve(msg.result);
                else pending.reject(Object.assign(new Error('No result in action response'), { name: 'ActionDispatchError', reason: 'error' }));
            }
            return;
        }
        s.handleMessage(JSON.stringify(msg));
    };
    const pushState = (kind: 's' | 'p' = 'p') => {
        const state = client.collectBotState(tick);
        recorder?.publish(tick, state, kind);
        deliver({ type: 'sdk_state', state, stateReceivedAt: Date.now() });
    };
    const execute = (action: unknown) => {
        assertActionScope(action);
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
    const lockstep = createLockstepClock(client, listeners, {
        getTick: () => tick,
        isStopped: () => stopped,
        isRunning: () => running,
        getWaitLeft: () => waitLeft,
    });

    const publishTick = () => {
        if (stopped) return;
        lockstep.onTickPublishStart();
        const listenersBefore = listeners.size;
        try {
            tick++;
            const t0 = performance.now();
            pushState('s');
            const t1 = performance.now();
            if (waitLeft > 0 && --waitLeft === 0) waitDone?.();
            // Like SDL_DispatchEventWatchList: freeze this dispatch's membership,
            // but respect removals. A new wait must start on the next game tick.
            if (listenersDirty) {
                listenerSnapshot = [...listeners];
                listenersDirty = false;
            }
            const snap = listenerSnapshot;
            for (let i = 0; i < snap.length; i++) {
                const l = snap[i]!;
                if (listeners.has(l)) l();
            }
            // A one-time tick wait (nextTick, a tick stream's step) leaves the set as it fires.
            lockstep.onTickDispatched(listenersBefore, t1 - t0, performance.now() - t1);
        } catch (e) {
            console.error('[inprocess] tick handler error', e);
        }
        lockstep.afterTickPublish();
    };
    const onGameTick = () => {
        // PLAYER_INFO can precede interface packets in the same socket batch.
        // LiteClient also snaps authoritative positions only after draining it.
        if (pumpingPackets) pendingTicks++;
        else publishTick();
    };
    const drainOnce = originalPacketPump ? async () => {
        pumpingPackets = true;
        const t0 = performance.now();
        lockstep.beforePacketPump();
        try { await originalPacketPump.call(client); }
        catch (error) { pendingTicks = 0; throw error; }
        finally { pumpingPackets = false; lockstep.recordPumpMs(performance.now() - t0); }
        const count = pendingTicks;
        pendingTicks = 0;
        for (let i = 0; i < count && !stopped; i++) publishTick();
    } : undefined;
    // One pump at a time: the session loop and the lockstep socket listener both ask for one.
    let pumpTail: Promise<void> = Promise.resolve();
    const drainPacketBatch = drainOnce ? () => { const run = pumpTail.then(drainOnce); pumpTail = run.catch(() => {}); return run; } : undefined;

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
                    lockstep.setActionPending(true);
                    try { result = await pending; } finally { lockstep.setActionPending(false); }
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
            lockstep.installSdkHooks(s);
            if (drainPacketBatch) client.pumpPackets = drainPacketBatch;
            lockstep.installTickClock();
            client.setOnGameTickCallback(onGameTick);
            lockstep.installEagerRead(!!drainPacketBatch);
        },
        stop(reason: string) {
            if (stopped) return;
            stopped = true;
            lockstep.stop();
            inventory.restore();
            client.setOnGameTickCallback(null);
            lockstep.stopEagerRead();
            pendingTicks = 0;
            if (drainPacketBatch && client.pumpPackets === drainPacketBatch) client.pumpPackets = originalPacketPump;
            lockstep.restoreTickClock();
            queue.length = 0;
            indexes.clear();
            listeners.clear();
            listenerSnapshot = [];
            listenersDirty = false;
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
        bankObservation: () => inventory.bankObservation(),
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
