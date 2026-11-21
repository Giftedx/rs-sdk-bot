import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SDKConfig } from '../../../../vendor/rs-sdk/sdk/types';
import { isLocalServer } from '../localserver';
import { gameDialAddress } from '../websocket-proxy';
import type { FetchRow } from './types';

export const repoRoot = resolve(import.meta.dir, '..', '..', '..', '..');
export const vendor = (p: string) => join(repoRoot, 'vendor', 'rs-sdk', p);

// Read-only transport observation of one LiteClient: LiteClient.conn -> GameConnection.out/stream ->
// ClientStream.socket (vendor lite/net/GameConnection.ts, io/ClientStream.ts). Lengths, times and socket state
// only; never packet bytes, credentials or exception text.
type TransportSocket = { send?: (...a: unknown[]) => unknown; readyState?: unknown; bufferedAmount?: unknown; extensions?: unknown; protocol?: unknown };
const safeInt = (v: unknown) => Number.isSafeInteger(v) ? v as number : null;

export function transportParts(client: unknown) {
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
export function inProcessSdkConfig(opts: { name: string; password: string; server?: string }): SDKConfig {
    const host = gameDialAddress(opts.server ?? 'localhost:8888');
    return { botUsername: opts.name, password: opts.password, autoLaunchBrowser: false, autoReconnect: false,
        browserLaunchUrl: `${isLocalServer(host) ? 'http' : 'https'}://${host}/bot` };
}

// Read-only observation of the lite bootstrap HTTP calls (session.ts /api/version, cache.ts /crc and archives,
// LocIndex.ts versionlist and ondemand.zip). Rows hold host, path, status or error and elapsed time; never headers or bodies.
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
