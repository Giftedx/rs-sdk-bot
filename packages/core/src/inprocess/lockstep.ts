import { appendFileSync } from 'node:fs';
import { executionWait } from '../../../../vendor/rs-sdk/sdk/execution-context';
import { ClientProt } from '../../../../vendor/rs-sdk/server/webclient/src/io/ClientProt';
import { pendingRouteWork } from '../route-plan';
import { tickWaits } from '../tick-stream';
import { fineTimers } from '../timer-resolution';
import { transportParts } from './transport';
import type { ClientLike } from './types';

// The longest single hold of a lockstep tick for a route search, under the 60 s idle limit of the client session.
export const ROUTE_HOLD_MS = 45_000;
export const routeHold = (routeMs: number): number => Math.min(routeMs, ROUTE_HOLD_MS);

// The wait checks of every lockstep session of this process (selfWaiting in createLockstepClock).
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

export interface LockstepClockState {
    getTick(): number;
    isStopped(): boolean;
    isRunning(): boolean;
    getWaitLeft(): number;
}

export function createLockstepClock(client: ClientLike, listeners: Set<() => void>, state: LockstepClockState) {
    // Lockstep practice engine (SIM_LOCKSTEP=1): the engine runs its next tick when every client has sent bytes after
    // this one, so any byte is an acknowledgement. From the first game tick the client's flush is held: the actions of
    // one tick and a closing NO_TIMEOUT leave in one write. That write goes out on a macrotask once the script waits
    // for a tick again: a pending waitTicks or waitUntil, a pending wait action, or an SDK state waiter above the
    // lowest listener count seen. A script that works off the tick clock (a world load, a route search) has none of
    // these, so it holds the tick until it waits. SIM_BUSY_MS (default 2000) bounds the hold, for a script that ends
    // without a wait. SIM_ACK_FILE receives one line per held tick and a total at the end.
    const lockstep = process.env.SIM_LOCKSTEP === '1';
    // SIM_FINE_TIMERS=1: the acknowledgement below polls with 1 ms timers; on Windows they take 15 ms each without it.
    if (lockstep) fineTimers();
    const busyMs = Number(process.env.SIM_BUSY_MS ?? 2000);
    const scriptMs = Math.min(busyMs, Number(process.env.SIM_SCRIPT_MS ?? 500));
    // A route search off the game thread (route-plan.ts) holds the tick until it ends: no game tick passes in a search,
    // so a case gives the same ticks with empty and with full route caches. A tick that runs on a wall-clock bound
    // during a search makes the tick count of a case follow the wall time of its searches.
    // SIM_ROUTE_MS bounds the hold for a search that never answers: a search older than the bound holds no tick.
    const routeMs = Math.max(busyMs, Number(process.env.SIM_ROUTE_MS || 180_000));
    // One hold is ROUTE_HOLD_MS at most: the client ends a session as idle after 60 s with no packet (IDLE_CYCLES of
    // the lite session), and a held tick sends none. A longer search lets one tick pass each ROUTE_HOLD_MS and holds
    // the next one.
    const routeHoldMs = routeHold(routeMs);
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
    const selfWaiting = () => state.getWaitLeft() > 0 || sdkWaits > 0 || serverWaiting() || stateWaiters > stateWaitersLow || inDialogWait();
    const holdFlush = () => { if (!flushHeld && sendNow) { flushHeld = true; client.flush = () => {}; } };
    const releaseFlush = () => { if (flushHeld) { flushHeld = false; delete (client as { flush?: unknown }).flush; sendNow?.(); } };

    const anySessionWaiting = () => {
        for (const f of waitingSessions) if (f()) return true;
        return false;
    };

    const acknowledgeTick = () => {
        const generation = ++ackGeneration, since = performance.now();
        let turns = 0;
        const check = () => {
            if (state.isStopped() || generation !== ackGeneration) return;
            stateWaitersLow = Math.min(stateWaitersLow, stateWaiters);
            // Any session of the process that waits counts, as `tickWaits` counts for the whole process: a session
            // with no script of its own (a gang account between two fights, one whose part has ended) answers as soon
            // as another session waits, in place of holding each tick for SIM_BUSY_MS.
            // A session whose own script waited on its ticks when this tick came (a tick listener above the lowest
            // count seen) answers only once that script waits again: the actions of the tick then go out with this
            // acknowledgement and not, as the machine's speed decides, with the next.
            // A pending action waits for the server until its count dialog is open; then the executor submits within
            // its 50 ms poll and the tick waits for that, as before, so the submit stays in the same tick.
            const dialogOpen = (actionPending || state.isRunning() || inDialogWait())
                ? !!(client as { isChatBackInputOpen?(): boolean }).isChatBackInputOpen?.()
                : false;
            const serverWait = actionPending && !dialogOpen;
            const waitLeft = state.getWaitLeft();
            const waiting = scriptTick ? listeners.size > listenersLow || selfWaiting()
                : tickWaits.active > 0 || selfWaiting() || anySessionWaiting();
            // The count-dialog wait counts as a wait only until the dialog is open; then the tick holds for the submit,
            // so the submit lands in the same tick on every run, whatever the executor's 50 ms poll meets.
            const routes = pendingRouteWork(routeMs);
            // Persistent state listeners do not make an off-tick route a game-input wait.
            // Actual tick/actions/dialog waits still advance; SIM_ROUTE_MS bounds this hold.
            const routeBusy = routes > 0 && waitLeft === 0 && !serverWait && !inDialogWait();
            const busy = routeBusy || (state.isRunning() && waitLeft === 0 && !serverWait && !(inDialogWait() && !dialogOpen)) || !waiting;
            // A script that ended after its last tick wait leaves no wait: SIM_SCRIPT_MS (500) bounds that hold.
            if (busy && performance.now() - since < (routeBusy ? routeHoldMs : scriptTick ? scriptMs : busyMs)) { if (turns++ < 20) setImmediate(check); else setTimeout(check, 1); return; }
            const held = performance.now() - since;
            ackStat.ticks++; if (busy) ackStat.capped++; if (held > 2) { ackStat.held++; ackStat.heldMs += held; }
            if (ackFile && held > 2) appendFileSync(ackFile, `ACK tick=${state.getTick()} bot=${(client as { loginUser?: string }).loginUser ?? "?"} waits=${tickWaits.active} state=${stateWaiters}/${stateWaitersLow} running=${state.isRunning()} pending=${actionPending} serverWait=${serverWait} routes=${routes} sdk=${[...inFlight].map(([k, n]) => `${k}${n > 1 ? `x${n}` : ''}`).join(',') || '-'} held=${held.toFixed(0)}ms${busy ? ' CAPPED' : ''}\n`);
            client.writeOpcode?.(ClientProt.NO_TIMEOUT);
            sendNow?.();
        };
        setImmediate(check);
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
        const stream = (client as { conn?: { stream?: { available?: number } } }).conn?.stream;
        if (!(Number(stream?.available) > 0)) return;
        for (let i = 0; i < owedCycles; i++) liteCycle();
        owedCycles = 0;
    };

    // Lockstep: the session loop reads the socket every 20 ms, so with 16 clients each tick waits about 60 ms for the
    // slowest read. A read as soon as bytes arrive takes that wait out. SIM_EAGER_READ=0 turns it off.
    const eagerRead = () => { if (!state.isStopped()) void client.pumpPackets?.().catch(() => {}); };
    let eagerSocket: { removeEventListener?(type: string, l: () => void): void } | undefined;

    return {
        installSdkHooks(s: any) {
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
                    const off = s.onStateUpdate((st: unknown) => { try { if (predicate(st)) resolve(st); } catch (error) { reject(error); } });
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
        },
        installTickClock() {
            if (animTick && liteCycle) {
                // The session loop's pass no longer ages; the speed is the one of a SIM_TICK_MS server (LiteClient ageEntityAnim).
                (client as { tickCycle?: () => void }).tickCycle = () => {};
                wallSpeed = (client as { tickSpeedMultiplier?: number }).tickSpeedMultiplier;
                Object.defineProperty(client, 'tickSpeedMultiplier', { configurable: true, get: () => Math.max(1, 420 / animTickMs), set: () => {} });
            }
        },
        installEagerRead(hasPump: boolean) {
            if (lockstep && hasPump && process.env.SIM_EAGER_READ !== '0') {
                const socket = transportParts(client).socket as { addEventListener?(type: string, l: () => void): void; removeEventListener?(type: string, l: () => void): void } | undefined;
                if (typeof socket?.addEventListener === 'function') { socket.addEventListener('message', eagerRead); eagerSocket = socket; }
            }
        },
        stop() {
            waitingSessions.delete(selfWaiting);
            if (lockstep && ackFile) appendFileSync(ackFile, `ACK_STAT ${JSON.stringify(ackStat)}\n`);
            releaseFlush();
        },
        stopEagerRead() {
            eagerSocket?.removeEventListener?.('message', eagerRead);
        },
        restoreTickClock() {
            if (animTick && liteCycle) { delete (client as { tickCycle?: unknown }).tickCycle; Object.defineProperty(client, 'tickSpeedMultiplier', { configurable: true, writable: true, value: wallSpeed ?? 1 }); }
        },
        beforePacketPump() {
            if (animTick) ageOwed();
        },
        recordPumpMs(ms: number) {
            ackStat.pumpMs += ms;
        },
        onTickPublishStart() {
            if (animTick) owedCycles += cyclesPerTick;
        },
        onTickDispatched(listenersBefore: number, stateMs: number, scriptElapsedMs: number) {
            listenersLow = Math.min(listenersLow, listeners.size);
            scriptTick = lockstep && listenersBefore > listenersLow;
            ackStat.stateMs += stateMs; ackStat.scriptMs += scriptElapsedMs;
        },
        afterTickPublish() {
            if (lockstep) { holdFlush(); acknowledgeTick(); }
        },
        setActionPending(pending: boolean) {
            actionPending = pending;
        },
    };
}
