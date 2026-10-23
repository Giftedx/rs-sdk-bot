import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BotSDK } from '../../../vendor/rs-sdk/sdk/index';
import type { BotActions } from '../../../vendor/rs-sdk/sdk/actions';
import { loadPathfinding } from './pathcache';
import { assertLoginAllowed } from './haggisgate';

// Runs BotSDK + BotActions in the same process as a LiteClient, with no gateway.
// BotSDK only speaks WebSocket (sdk/index.ts:272), so the shim fakes a connected socket and feeds it the
// same messages the gateway would (see research/phase2-recon.md section 1).

export interface ClientLike {
    collectBotState(tick: number): unknown;
    executeBotAction(action: unknown): unknown | Promise<unknown>;
    setOnGameTickCallback(cb: (() => void) | null): void;
    getMaxMessageLength?(): number;
}

export interface Shim {
    start(): void;
    stop(reason: string): void;
    tick(): number;
    onTick(cb: () => void): () => void;
    // Sends one action straight to the client, skipping the queue (used for logout, which must not wait
    // behind a slow or stuck action).
    direct(action: { type: string; [k: string]: unknown }): Promise<unknown>;
}

type Queued = { actionId: string; action: { type: string; ticks?: number } };

export function createShim(client: ClientLike, sdk: BotSDK): Shim {
    const s = sdk as any;
    let tick = 0;
    let stopped = false;
    let running = false;
    let waitLeft = 0;
    let waitDone: (() => void) | null = null;
    const queue: Queued[] = [];
    const listeners = new Set<() => void>();

    const deliver = (msg: object) => s.handleMessage(JSON.stringify(msg));
    const pushState = () => deliver({ type: 'sdk_state', state: client.collectBotState(tick), stateReceivedAt: Date.now() });

    const onGameTick = () => {
        if (stopped) return;
        try {
            tick++;
            pushState();
            if (waitLeft > 0 && --waitLeft === 0) waitDone?.();
            for (const l of listeners) l();
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
                result = await client.executeBotAction(next.action);
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
        onTick(cb) {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        async direct(action) {
            if (stopped) return { success: false, message: 'session stopped' };
            return client.executeBotAction(action);
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
}

// The lite session spreads logins with a random jitter on remote servers (session.ts:122, 5 s default) to spare the
// login server. Skip it only for our own local practice server.
export function loginJitterFor(host: string): number | undefined {
    return /^(localhost|127\.)/.test(host) ? 0 : undefined;
}

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
const vendor = (p: string) => join(repoRoot, 'vendor', 'rs-sdk', p);
let pathfindingReady = false;

export async function connectInProcess(opts: { name: string; password: string; server?: string; members?: boolean }): Promise<Session> {
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

    let endResolve!: (v: { reason: string }) => void;
    const ended = new Promise<{ reason: string }>(r => { endResolve = r; });
    let shim: Shim | null = null;
    const host = opts.server ?? 'localhost:8888'; // host:port, same as SERVER in bot.env
    const session = await startSession({
        host,
        username: opts.name,
        password: opts.password,
        cacheDir,
        quiet: true,
        ...(loginJitterFor(host) !== undefined ? { loginJitterMs: loginJitterFor(host) } : {}),
        ...(opts.members !== undefined ? { members: opts.members } : {}),
        onEnd: (end: { reason: string }) => {
            shim?.stop(end.reason);
            endResolve({ reason: end.reason });
        },
    });
    const sdk: BotSDK = new BotSDK({ botUsername: opts.name, password: opts.password, autoLaunchBrowser: false, autoReconnect: false } as any);
    shim = createShim(session.client as unknown as ClientLike, sdk);
    shim.start();
    const bot: BotActions = new BotActions(sdk);
    const sh = shim;
    return {
        name: opts.name,
        sdk,
        bot,
        tick: () => sh.tick(),
        onTick: cb => sh.onTick(cb),
        direct: a => sh.direct(a),
        ended,
        async close() {
            sh.stop('stopped');
            session.stop();
            await session.stopped;
        },
    };
}
