// The world feed as a record of how named players fight: the source for the bench copy of a rival
// (research/pvp-fight-loop.md, "Rivals: the dagger gang"). Read-only: it opens the public feed and sends no game input.
//   bun scripts/measure/pk-rival-feed.ts record <minutes> <out.jsonl> [name,name,...]
//     writes every player record of every tick in the Wilderness, and the roster rows of the names and of the players
//     in the Wilderness.
//   bun scripts/measure/pk-rival-feed.ts digest <name,name,...> <trace.jsonl> [<trace.jsonl> ...]
//     prints one FIGHT line for each fight of a name and one MODEL line with the numbers that the bench profile copies.
// Feed records (vendor/rs-sdk/server/engine/src/web/worldfeed.ts): `an` animation, `sp` spot animation, `fe` faced
// entity (32768 + player slot), `hm` hit splats with `hp`, `ap` appearance (worn items and head icons), `m` steps.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RosterFeed } from '../../packages/core/src/roster-feed';
import { gameDialAddress } from '../../packages/core/src/websocket-proxy';

import { decodeAppearance, digest, model, SEQ, type Digest, type Fight } from '../../packages/core/src/rival-feed';
export { decodeAppearance, digest, model, SEQ, type Digest, type Fight };
const DEFAULT_NAMES = 'goondelf,ligma,sugma';
const wild = (z: number) => (z >= 3520 && z < 3968 ? Math.floor((z - 3520) / 8) + 1 : 0);

if (import.meta.main) {
    const [mode, ...rest] = process.argv.slice(2);
    if (mode === 'record') {
        const minutes = Number(rest[0] ?? 10), file = rest[1] ?? 'trace.jsonl', watch = new Set((rest[2] ?? DEFAULT_NAMES).toLowerCase().split(','));
        // The Wilderness is x 2944-3391, z 3520-3967; a subscription is 384 tiles a side at most.
        const rects = [{ x: 2944, z: 3520, w: 384, h: 384 }, { x: 2944, z: 3904, w: 384, h: 64 }, { x: 3328, z: 3520, w: 64, h: 384 }, { x: 3328, z: 3904, w: 64, h: 64 }];
        writeFileSync(file, '');
        const line = (o: unknown) => appendFileSync(file, JSON.stringify(o) + '\n');
        const sockets: (WebSocket | undefined)[] = [];
        let done = false, ticks = 0;
        const connect = (r: number) => {
            const ws = new WebSocket(process.env.FEED_URL ?? gameDialAddress('wss://rs-sdk-demo.fly.dev/worldfeed')), feed = new RosterFeed();
            sockets[r] = ws;
            ws.onopen = () => { ws.send(JSON.stringify({ t: 'sub', ...rects[r] })); if (r === 0) ws.send(JSON.stringify({ t: 'roster', on: true })); };
            ws.onmessage = e => {
                const m = feed.expand(JSON.parse(String(e.data)));
                // A new socket sends every player again, so the reader starts its slots again at each hello.
                if (m.t === 'hello') line({ t: 'hello', r, at: Date.now(), tick: m.tick, tickMs: m.tickMs });
                else if (m.t === 'roster') line({ t: 'roster', k: m.k, p: (m.p ?? []).filter((p: any) => watch.has(String(p[1]).toLowerCase()) || wild(p[3]) > 0) });
                else if (m.t === 'tick') { if (r === 0) ticks++; if (m.p?.length || m.rp?.length) line({ t: 'tick', r, k: m.k, p: m.p, rp: m.rp }); }
            };
            // The server closes a socket that sends nothing for its idle time; a closed socket connects again.
            ws.onclose = () => { if (!done && sockets[r] === ws) setTimeout(() => connect(r), 2000); };
            ws.onerror = () => { /* the close handler connects again */ };
        };
        rects.forEach((_, r) => connect(r));
        setInterval(() => { for (const ws of sockets) if (ws?.readyState === WebSocket.OPEN) ws.send('{"t":"ping"}'); }, 30_000);
        setTimeout(() => { done = true; for (const ws of sockets) try { ws?.close(); } catch { /* closed */ } console.log(`RESULT ok feed record minutes=${minutes} ticks=${ticks} out=${file}`); process.exit(0); }, minutes * 60_000);
    } else if (mode === 'digest' && rest.length >= 2) {
        const pack = new Map(readFileSync(join(resolve(import.meta.dir, '..', '..'), 'vendor/rs-sdk/server/content/pack/obj.pack'), 'utf8').split(/\r?\n/).flatMap(l => { const m = l.match(/^(\d+)=(.+)$/); return m ? [[Number(m[1]), m[2]!] as const] : []; }));
        const d = digest(rest.slice(1).flatMap(f => readFileSync(f, 'utf8').split('\n')), new Set(rest[0]!.toLowerCase().split(',')), id => pack.get(id) ?? `obj${id}`);
        for (const f of d.fights) console.log(`FIGHT ${JSON.stringify(f)}`);
        for (const p of d.prayers) console.log(`PRAYER ${JSON.stringify(p)}`);
        for (const x of d.deaths) console.log(`DEATH ${JSON.stringify(x)}`);
        console.log(`MODEL ${JSON.stringify(model(d))}`);
    } else {
        console.log('usage: bun scripts/measure/pk-rival-feed.ts record <minutes> <out.jsonl> [names] | digest <names> <trace.jsonl> [...]');
        process.exit(2);
    }
}
