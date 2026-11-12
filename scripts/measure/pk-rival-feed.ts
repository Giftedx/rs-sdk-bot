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
import { decodeAppearance } from '../../packages/dashboard/appearance';
import { RosterFeed } from '../../packages/core/src/roster-feed';

const DEFAULT_NAMES = 'goondelf,ligma,sugma';
// Animations (content pack/seq.pack): the dagger's lunge and hack, its special, an eat, a death.
const SEQ = { lunge: 376, hack: 377, puncture: 1062, eat: 829, death: 836 } as const;
// Head icon bits (player/configs/headicon.constant).
const HEAD = { skull: 1, melee: 8, ranged: 16, magic: 32 } as const;
const DX = [-1, 0, 1, -1, 1, -1, 0, 1], DZ = [1, 1, 1, 0, 0, -1, -1, -1];
const wild = (z: number) => (z >= 3520 && z < 3968 ? Math.floor((z - 3520) / 8) + 1 : 0);

export type Fight = {
    by: string; target: string; targetCombat?: number; wild: number; start: number; end: number;
    // One letter for each action in order: L an attack, S a special, E an eat.
    order: string;
    // Damage of each splat on the target in a tick of an attack, by whether the target showed Protect from Melee.
    open: number[]; prayed: number[];
    // Hitpoints of the attacker before each eat, and its lowest Hitpoints in the fight.
    eatAt: number[]; hpLow: number;
    targetWorn: string[]; ended: 'target died' | 'attacker died' | 'target left' | 'stopped';
};
export type Digest = {
    fights: Fight[]; intervals: Record<string, number>;
    // Each change of a protect prayer of a name: the tick, the prayer that came on (or 'off'), and the weapon of the
    // player that the name faced or that faced it.
    prayers: { tick: number; name: string; on: 'melee' | 'ranged' | 'magic' | 'off'; near?: string }[];
    deaths: { tick: number; name: string }[];
};
type Seen = { name: string; x: number; z: number; combat?: number; worn: string[]; head: number; fe?: number; hp?: number; lastAttack?: number };

// The fights of `names` in the lines of one or more traces. `objName` gives the name of a worn object id.
export function digest(lines: Iterable<string>, names: ReadonlySet<string>, objName: (id: number) => string = id => String(id)): Digest {
    const bySlot = new Map<number, Seen>(), open = new Map<string, Fight>();
    const out: Digest = { fights: [], intervals: {}, prayers: [], deaths: [] };
    const protect = (head: number) => (head & HEAD.melee ? 'melee' : head & HEAD.ranged ? 'ranged' : head & HEAD.magic ? 'magic' : 'off');
    const close = (name: string, ended: Fight['ended']) => { const f = open.get(name); if (f) { f.ended = ended; out.fights.push(f); open.delete(name); } };
    for (const raw of lines) {
        if (!raw) continue;
        let m: any; try { m = JSON.parse(raw); } catch { continue; }
        if (m.t === 'hello') { bySlot.clear(); continue; }
        if (m.t === 'roster') {
            for (const p of m.p ?? []) { const e = bySlot.get(p[0]), name = String(p[1]).toLowerCase();
                if (!e || e.name !== name) bySlot.set(p[0], { name, x: p[2], z: p[3], combat: p[5], worn: [], head: 0 }); else { e.x = p[2]; e.z = p[3]; e.combat = p[5]; } }
            continue;
        }
        if (m.t !== 'tick') continue;
        const attacks: { by: Seen; spec: boolean }[] = [];
        for (const r of m.p ?? []) {
            let e = bySlot.get(r.i);
            const a = typeof r.ap === 'string' ? decodeAppearance(r.ap) : null;
            if (r.f || !e) { e = { name: a?.name ?? e?.name ?? `slot${r.i}`, x: r.x ?? e?.x ?? 0, z: r.z ?? e?.z ?? 0, combat: a?.combat ?? e?.combat, worn: e?.worn ?? [], head: e?.head ?? 0 }; bySlot.set(r.i, e); }
            if (r.x !== undefined) { e.x = r.x; e.z = r.z; } else for (const d of r.m ?? []) { e.x += DX[d] ?? 0; e.z += DZ[d] ?? 0; }
            if (r.fe !== undefined) e.fe = r.fe;
            if (a) {
                const head = Uint8Array.from(atob(r.ap), c => c.charCodeAt(0))[1] ?? 0;
                if (a.name) e.name = a.name;
                if (names.has(e.name) && protect(head) !== protect(e.head)) {
                    // The player this name faces, else a player that faces it.
                    const other = e.fe !== undefined && e.fe >= 32768 ? bySlot.get(e.fe - 32768) : [...bySlot.values()].find(o => o.fe !== undefined && o.fe >= 32768 && bySlot.get(o.fe - 32768) === e);
                    out.prayers.push({ tick: m.k, name: e.name, on: protect(head), ...(other?.worn.length ? { near: `${other.name}: ${other.worn.join(',')}` } : other ? { near: other.name } : {}) });
                }
                e.worn = a.worn.map(w => objName(w.obj)); e.head = head; e.combat = a.combat;
            }
            if (r.hp) e.hp = r.hp[0];
            if (!r.an) continue;
            if (r.an[0] === SEQ.death) {
                if (names.has(e.name)) { out.deaths.push({ tick: m.k, name: e.name }); close(e.name, 'attacker died'); }
                for (const [name, f] of open) if (f.target === e.name) close(name, 'target died');
            }
            if (!names.has(e.name)) continue;
            const f = open.get(e.name);
            if (r.an[0] === SEQ.eat && f) { f.order += 'E'; f.eatAt.push(e.hp ?? -1); }
            if (r.an[0] === SEQ.lunge || r.an[0] === SEQ.hack || r.an[0] === SEQ.puncture) attacks.push({ by: e, spec: r.an[0] === SEQ.puncture });
        }
        for (const { by, spec } of attacks) {
            const target = by.fe !== undefined && by.fe >= 32768 ? bySlot.get(by.fe - 32768) : undefined;
            if (by.lastAttack !== undefined && m.k - by.lastAttack <= 12) out.intervals[m.k - by.lastAttack] = (out.intervals[m.k - by.lastAttack] ?? 0) + 1;
            by.lastAttack = m.k;
            // The animation of an attack on an NPC has no faced player: it is no part of a fight.
            if (!target) continue;
            let f = open.get(by.name);
            if (f && (f.target !== target.name || m.k - f.end > 40)) { close(by.name, 'stopped'); f = undefined; }
            if (!f) { f = { by: by.name, target: target.name, targetCombat: target.combat, wild: wild(target.z), start: m.k, end: m.k, order: '', open: [], prayed: [], eatAt: [], hpLow: by.hp ?? 99, targetWorn: [...target.worn], ended: 'stopped' }; open.set(by.name, f); }
            f.end = m.k; f.order += spec ? 'S' : 'L';
            const rec = (m.p ?? []).find((r: any) => bySlot.get(r.i) === target);
            for (const h of rec?.hm ?? []) if (h[1] !== 2) (target.head & HEAD.melee ? f.prayed : f.open).push(h[0]);
        }
        for (const [name, f] of open) {
            const e = [...bySlot.values()].find(s => s.name === name);
            if (e?.hp !== undefined) f.hpLow = Math.min(f.hpLow, e.hp);
            if (m.k - f.end > 40) close(name, 'stopped');
        }
        // A target that the feed drops from view while its fight is open got away (a teleport or a logout).
        for (const slot of m.rp ?? []) { const gone = bySlot.get(slot); if (gone) for (const [name, f] of open) if (f.target === gone.name) close(name, 'target left'); }
    }
    for (const name of [...open.keys()]) close(name, 'stopped');
    return out;
}
// The numbers that the bench profile of a rival copies.
export function model(d: Digest) {
    const all = (pick: (f: Fight) => number[]) => d.fights.flatMap(pick), max = (a: number[]) => (a.length ? Math.max(...a) : null);
    const firstSpecial = d.fights.map(f => f.order.replace(/E/g, '').indexOf('S')).filter(i => i >= 0);
    return {
        fights: d.fights.length, attacks: d.fights.reduce((n, f) => n + f.order.replace(/E/g, '').length, 0), intervals: d.intervals,
        specials: d.fights.reduce((n, f) => n + (f.order.match(/S/g)?.length ?? 0), 0), firstSpecialAfterAttacks: firstSpecial,
        eatAt: all(f => f.eatAt), hpLow: max(d.fights.map(f => -f.hpLow)) === null ? null : -max(d.fights.map(f => -f.hpLow))!,
        maxHitOpen: max(all(f => f.open)), hitsOpen: all(f => f.open).length, maxHitPrayed: max(all(f => f.prayed)), hitsPrayed: all(f => f.prayed).length,
        prayers: d.prayers.filter(p => p.on !== 'off').length, deaths: d.deaths.length,
        ends: d.fights.reduce((n, f) => ({ ...n, [f.ended]: (n[f.ended] ?? 0) + 1 }), {} as Record<string, number>),
    };
}

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
            const ws = new WebSocket(process.env.FEED_URL ?? 'wss://rs-sdk-demo.fly.dev/worldfeed'), feed = new RosterFeed();
            sockets[r] = ws;
            ws.onopen = () => { ws.send(JSON.stringify({ t: 'sub', ...rects[r] })); if (r === 0) ws.send(JSON.stringify({ t: 'roster', on: true })); };
            ws.onmessage = e => {
                const m = feed.expand(JSON.parse(String(e.data)));
                // A new socket sends every player again, so the reader starts its slots again at each hello.
                if (m.t === 'hello') line({ t: 'hello', r, at: Date.now(), tick: m.tick });
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
