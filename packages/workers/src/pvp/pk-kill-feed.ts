// World-feed verification of kill receipts (second observer, read-only).
import { readFileSync } from 'node:fs';
import { amendKillReceipt, type KillFeedMatch } from '../../../core/src/kill-receipt';
import { isLocalServer } from '../../../core/src/localserver';
import { decodeAppearance, digest, SEQ } from '../../../core/src/rival-feed';
import { shutdownTasks } from '../../../core/src/shutdown';
import { gameDialAddress } from '../../../core/src/websocket-proxy';

const feedName = (name: string) => name.trim().toLowerCase().replace(/_/g, ' ');

/** Matches `victim` death in recorded feed lines within `windowMs` of `atMs`. */
export function feedDeath(lines: readonly string[], victim: string, atMs: number, o: { windowMs?: number; tickMs?: number; source?: string } = {}): KillFeedMatch {
    const windowMs = o.windowMs ?? 6000, source = o.source ?? 'world feed';
    const anchors: { k: number; at: number }[] = [];
    let tickMs = o.tickMs;
    for (const raw of lines) {
        let m: any; try { m = JSON.parse(raw); } catch { continue; }
        const k = m?.t === 'tick' ? m.k : m?.t === 'hello' ? m.tick : undefined;
        if (Number.isFinite(k) && Number.isFinite(m.at)) anchors.push({ k, at: m.at });
        if (m?.t === 'hello' && Number.isFinite(m.tickMs) && tickMs === undefined) tickMs = m.tickMs;
    }
    if (!anchors.length) return { matched: false, reason: 'the feed lines carry no time', source };
    const timeOf = (k: number) => {
        const exact = anchors.find(a => a.k === k);
        if (exact) return exact.at;
        const near = anchors.reduce((best, a) => (Math.abs(a.k - k) < Math.abs(best.k - k) ? a : best));
        return tickMs === undefined ? NaN : near.at + (k - near.k) * tickMs;
    };
    const deaths = digest(lines, new Set([feedName(victim)])).deaths.map(d => ({ tick: d.tick, deltaMs: timeOf(d.tick) - atMs }))
        .filter(d => Math.abs(d.deltaMs) <= windowMs).sort((a, b) => Math.abs(a.deltaMs) - Math.abs(b.deltaMs));
    return deaths.length ? { matched: true, feedTick: deaths[0]!.tick, deltaMs: Math.round(deaths[0]!.deltaMs), source }
        : { matched: false, reason: `no death of ${victim} within ${windowMs} ms in the feed`, source };
}

/** Per-server read-only `/worldfeed` listener buffering recent death animations. */
export class KillFeed {
    private socket: WebSocket | undefined;
    private names = new Map<number, string>();
    private deaths: { name: string; k: number; at: number }[] = [];
    private rect: { x: number; z: number } | null = null;
    private beat: ReturnType<typeof setInterval> | undefined;
    private records = 0;
    state: 'connecting' | 'open' | 'closed' = 'connecting';
    readonly source: string;
    constructor(readonly server: string) {
        this.source = `${isLocalServer(server) ? 'ws' : 'wss'}://${server}/worldfeed`;
        try {
            const socket = new WebSocket(gameDialAddress(this.source));
            this.socket = socket;
            socket.addEventListener('open', () => {
                this.state = 'open';
                if (this.rect) socket.send(JSON.stringify({ t: 'sub', ...this.rect, w: 384, h: 384 }));
                this.beat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send('{"t":"ping"}'); }, 30_000);
                (this.beat as { unref?: () => void }).unref?.();
            });
            socket.addEventListener('message', ({ data }) => this.accept(String(data)));
            socket.addEventListener('close', () => { this.state = 'closed'; if (this.beat) clearInterval(this.beat); });
            socket.addEventListener('error', () => {});
        } catch { this.state = 'closed'; }
    }
    accept(raw: string, now = Date.now()): void {
        let m: any; try { m = JSON.parse(raw); } catch { return; }
        if (m?.t === 'hello') { this.names.clear(); return; }
        if (m?.t !== 'tick') return;
        this.records++;
        for (const r of m.p ?? []) {
            const name = typeof r.ap === 'string' ? decodeAppearance(r.ap)?.name : undefined;
            if (name) this.names.set(r.i, name);
            if (r.an?.[0] === SEQ.death && this.names.has(r.i)) this.deaths.push({ name: this.names.get(r.i)!, k: m.k, at: now });
        }
        for (const slot of m.rp ?? []) this.names.delete(slot);
        if (this.deaths.length > 200) this.deaths.splice(0, this.deaths.length - 200);
    }
    aim(x: number, z: number): void {
        const r = this.rect;
        if (r && x >= r.x + 64 && x < r.x + 320 && z >= r.z + 64 && z < r.z + 320) return;
        this.rect = { x: x - 192, z: z - 192 };
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ t: 'sub', ...this.rect, w: 384, h: 384 }));
    }
    match(victim: string, atMs: number, windowMs = 6000): KillFeedMatch {
        if (!this.records) return { matched: false, reason: this.state === 'open' ? 'the feed sent no record' : 'the feed is not available', source: this.source };
        const near = this.deaths.filter(d => d.name === feedName(victim) && Math.abs(d.at - atMs) <= windowMs).sort((a, b) => Math.abs(a.at - atMs) - Math.abs(b.at - atMs))[0];
        return near ? { matched: true, feedTick: near.k, deltaMs: near.at - atMs, source: this.source }
            : { matched: false, reason: `no death of ${victim} within ${windowMs} ms in the feed`, source: this.source };
    }
    close(): void { if (this.beat) clearInterval(this.beat); try { this.socket?.close(); } catch {} this.state = 'closed'; }
}

const feeds = new Map<string, KillFeed>();

/** Opens or reuses the world-feed observer for `server` when active. */
export function killFeed(server: string | undefined, env: Record<string, string | undefined> = process.env): KillFeed | null {
    if (!server || env.KILL_FEED === '0' || (env.KILL_FEED !== '1' && isLocalServer(server))) return null;
    let feed = feeds.get(server);
    if (!feed || feed.state === 'closed') { feed = new KillFeed(server); feeds.set(server, feed); }
    shutdownTasks.add(settleKillFeed);
    return feed;
}

const pending = new Set<Promise<void>>();

/** Polls the feed for `victim` death and amends the kill receipt once settled. */
export function checkKillFeed(feed: KillFeed, victim: string, atMs: number, done: (match: KillFeedMatch) => void, tries = 4): void {
    const job = (async () => {
        let match = feed.match(victim, atMs);
        for (let i = 0; i < tries && !match.matched; i++) { await new Promise(r => setTimeout(r, 1000)); match = feed.match(victim, atMs); }
        try { done(match); } catch (e) { console.error('[kill-feed] receipt update failed', String(e)); }
    })();
    pending.add(job);
    void job.finally(() => pending.delete(job));
}

/** Flushes pending kill-feed checks and closes open feed sockets. */
export async function settleKillFeed(): Promise<void> {
    await Promise.all([...pending]);
    for (const feed of feeds.values()) feed.close();
    feeds.clear();
}

/** CLI runner to attach feed verification to an existing kill receipt file. */
export async function runKillFeedCli(args: readonly string[]): Promise<number> {
    const [file, ...traces] = args;
    if (!file || !traces.length) {
        console.log('usage: bun scripts/aio-pvp.ts kill-feed <receipt.json> <trace.jsonl> [<trace.jsonl> ...]');
        return 2;
    }
    const receipt = JSON.parse(readFileSync(file, 'utf8'));
    const match = feedDeath(traces.flatMap(t => readFileSync(t, 'utf8').split('\n')), String(receipt.victim), Number(receipt.at), { source: traces.join(',') });
    amendKillReceipt(file, { feed: match });
    console.log(`RESULT ${match.matched ? 'ok' : 'fail'} kill feed ${JSON.stringify(match)}`);
    return match.matched ? 0 : 1;
}
