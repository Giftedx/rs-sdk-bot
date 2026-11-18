// The behaviour record of the dagger gang (Goondelf, Ligma, Sugma): one data file a gang account and one for the group,
// built from world feed traces. Each value is a finding {value, status, n, evidence}: `measured` from a trace with its
// sample size, `reported` from a run whose raw data is not on this PC, or `unknown` with the observation that closes
// it and the range the bench clone takes in its place. research/gang-clones.md describes the files.
//   bun scripts/measure/pk-gang-record.ts build [--data <checkout root>] [--out <dir>] [trace.jsonl ...]
//   bun scripts/measure/pk-gang-record.ts scan [--data <checkout root>]       lists the tick records with a gang account near an account of ours in the
//     Wilderness (<data>/.practice/gang-record/tick-records.txt); `build` reads the records of that list
//   bun scripts/measure/pk-gang-record.ts hiscores [--data <checkout root>]   saves the public hiscore page of each name
// With no trace named it reads <data>/.practice/rival-dds/trace-3.jsonl, trace-long-1.jsonl and every
// <data>/.practice/gang-record/feed-*.jsonl (scripts/measure/pk-gang-collect.ts). Read-only on the traces.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { constants, gunzipSync } from 'node:zlib';
import { decodeAppearance, digest, type Fight } from './pk-rival-feed';

export const GANG = ['goondelf', 'ligma', 'sugma'] as const;
export const POST = { x: 3078, z: 3640 }, ALTAR = { x: 2948, z: 3820 }, MONASTERY = { x: 3052, z: 3490 }, WEST_TILE = { x: 2934, z: 3516 };
// The demo server's tick: 10 ticks between two roster frames take 4,017 ms (samples.jsonl of the collector).
const TICK_MS = 400;
const SEQ = { attack: [376, 377], special: 1062, eat: 829, death: 836 } as const;
const FREEZE_SPOT: Record<number, string> = { 179: 'entangle', 180: 'snare', 181: 'bind' };
const DX = [-1, 0, 1, -1, 1, -1, 0, 1], DZ = [1, 1, 1, 0, 0, -1, -1, -1];
type Tile = { x: number; z: number };
type Style = 'melee' | 'ranged' | 'magic';
type Hist = Record<string, number>;
const cheb = (a: Tile, b: Tile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
const wild = (t: Tile) => (t.x >= 2944 && t.x < 3392 && t.z >= 3520 && t.z < 3968 ? Math.floor((t.z - 3520) / 8) + 1 : 0);
const bump = (h: Hist, key: string | number, n = 1) => { h[key] = (h[key] ?? 0) + n; };
const protect = (head: number) => (head & 8 ? 'melee' : head & 16 ? 'ranged' : head & 32 ? 'magic' : 'off');
const styleOf = (weapon: string): Style => (/bow|knife|dart|javelin|thrownaxe/.test(weapon) ? 'ranged' : /staff|wand/.test(weapon) ? 'magic' : 'melee');
const where = (t: Tile) => (cheb(t, POST) <= 1 ? 'post' : cheb(t, ALTAR) <= 4 ? 'chaos altar' : cheb(t, MONASTERY) <= 12 ? 'monastery' : cheb(t, WEST_TILE) <= 6 ? 'west tile' : wild(t) === 0 ? 'outside' : 'wilderness');
// Lowest, median and highest of a list, with its size.
export const spread = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? { n: s.length, min: s[0]!, median: s[Math.floor(s.length / 2)]!, max: s[s.length - 1]! } : { n: 0 }; };
const total = (h: Hist) => Object.values(h).reduce((a, b) => a + b, 0);

type Entity = { slot: number; name: string; x: number; z: number; combat: number; worn: string[]; weapon: string; cls?: Style; head: number; fe?: number; hp?: number; hpAt?: number; hpStale?: boolean; region?: number; anim?: { k: number; name: string }; gone?: boolean };
type Trip = { k: number; tiles: number; cands: { name: string; d: number }[]; maxD: number; far: Tile; firstAttack?: number; lastAttack?: number; target?: string; targetD?: number };
type Low = { k: number; hp: number; minHp: number; eatsAfter: number; died?: number; lastAttack?: number; out?: number; post?: number };
// What one gang account did, over every trace.
export type Acc = {
    frames: number; place: Hist; stand: Hist; steps: { run: number; walk: number }; maxDist: number; hours: Hist; worn: Hist; wornAfterDeath: string[];
    attacks: number; specials: number; intervals: Hist; intervalsWithEat: Hist; attackDist: Hist; targetStep: Hist; damage: Record<string, Hist>; poisonOnTarget: Hist;
    specTargetHp: Hist; specOwnHp: Hist; eats: number; otherConsumes: { k: number; trace: string; hp?: number; hpAge?: number; ticksSinceAttack?: number; wilderness: number }[]; eatHp: Hist; eatLag: Hist; heal: Hist; comboEats: number;
    prayerOn: Hist; lag: Record<'attacked' | 'waiting', Hist>; lagMiss: Record<'attacked' | 'waiting', number>; holds: { off: number[]; changed: number[] }; splats: Record<string, Hist>; splatsAmbiguous: number; poisonSplats: number; skullOnAfterAttack: Hist; skullHolds: number[];
    switches: Hist; choiceRank: Hist; hitters: Hist; prayedAgainst: Record<string, { attacks: number; prayed: number; players: Set<string> }>; freezes: { k: number; spot: string; trace: string; protect: string; ticksToFirstStep?: number; ticksToNextAttack?: number }[];
    trips: { withAttack: number; noAttack: number; response: number[]; back: number[]; pathOverLine: number[]; duration: number[]; maxDist: number[]; targetDist: number[]; noAttackPlace: Hist; leftWith: Hist };
    deaths: { k: number; trace: string; x: number; z: number; respawn?: [number, number]; backOnPost?: number }[]; lows: (Low & { trace: string })[]; altar: number[]; monastery: number[];
};
export type GroupAcc = {
    hours: Hist; offPost: Hist; perTarget: Hist; pile: { multi: Hist; single: Hist }; kills: { ticks: number; attackers: number; multi: boolean; combat: number; worn: string[]; wild: number }[];
    ignored: Hist; ignoredExamples: string[]; attackedCombat: Hist; attackedWild: Hist; fights: Fight[];
    sources: { path: string; ticks: number; from: string; to: string; frames: number }[];
    sightings: Sighting[];
};
// One tick record of an account of ours with a gang account near it in the Wilderness.
export type Sighting = { record: string; ourCombat: number; ticks: number; from: [number, number]; to: [number, number]; hpLost: number; died: boolean;
    // The ticks in which our account and the gang account both moved with at most 20 tiles between them, the tiles of our account over those ticks, the gap, and the multi-way tiles of the gang account in them.
    chase: Record<string, { ticks: number; ourTiles: number; gap: ReturnType<typeof spread>; gangAccountOnMultiWayTiles: number }> };
const newAcc = (): Acc => ({
    frames: 0, place: {}, stand: {}, steps: { run: 0, walk: 0 }, maxDist: 0, hours: {}, worn: {}, wornAfterDeath: [],
    attacks: 0, specials: 0, intervals: {}, intervalsWithEat: {}, attackDist: {}, targetStep: {}, damage: {}, poisonOnTarget: {},
    specTargetHp: {}, specOwnHp: {}, eats: 0, otherConsumes: [], eatHp: {}, eatLag: {}, heal: {}, comboEats: 0,
    prayerOn: {}, lag: { attacked: {}, waiting: {} }, lagMiss: { attacked: 0, waiting: 0 }, holds: { off: [], changed: [] }, splats: {}, splatsAmbiguous: 0, poisonSplats: 0, skullOnAfterAttack: {}, skullHolds: [],
    switches: {}, choiceRank: {}, hitters: {}, prayedAgainst: {}, freezes: [],
    trips: { withAttack: 0, noAttack: 0, response: [], back: [], pathOverLine: [], duration: [], maxDist: [], targetDist: [], noAttackPlace: {}, leftWith: {} },
    deaths: [], lows: [], altar: [], monastery: [],
});

export function newRecord() { return { acc: Object.fromEntries(GANG.map(n => [n, newAcc()])) as Record<string, Acc>, group: { hours: {}, offPost: {}, perTarget: {}, pile: { multi: {}, single: {} }, kills: [], ignored: {}, ignoredExamples: [], attackedCombat: {}, attackedWild: {}, fights: [], sources: [], sightings: [] } as GroupAcc }; }

const inflate = (file: string) => gunzipSync(readFileSync(file), { finishFlush: constants.Z_SYNC_FLUSH }).toString('utf8');
// Adds one tick record (packages/core/src/tick-record.ts) of an account of ours: what the gang accounts near it did.
export function addTickRecord(rec: ReturnType<typeof newRecord>, path: string, text: string, multi: (t: Tile) => boolean) {
    let player: any, near: any[] = [], hp = -1, last: Tile | undefined; const lastG = new Map<string, Tile>(), gaps = new Map<string, number[]>();
    const sight: Sighting = { record: path, ourCombat: 0, ticks: 0, from: [0, 0], to: [0, 0], hpLost: 0, died: false, chase: {} };
    for (const l of text.split('\n')) {
        if (!l) continue; let m: any; try { m = JSON.parse(l); } catch { continue; }
        if (m.k !== 's' && m.k !== 'p') continue;
        if (m.d?.player) player = m.d.player; if (m.d?.nearbyPlayers) near = m.d.nearbyPlayers;
        if (m.k !== 's' || !player) continue;
        const us = { x: player.worldX as number, z: player.worldZ as number }, g = near.filter(p => String(p.name).toLowerCase() in rec.acc);
        if (g.length && wild(us) > 0) {
            if (!sight.ticks) sight.from = [us.x, us.z]; sight.ticks++; sight.to = [us.x, us.z]; sight.ourCombat = player.combatLevel;
            if (hp >= 0 && player.hp < hp) sight.hpLost += hp - player.hp;
            for (const p of g) { const n = String(p.name).toLowerCase(), t = { x: p.x as number, z: p.z as number }, was = lastG.get(n);
                if (last && was && cheb(last, us) > 0 && cheb(was, t) > 0 && cheb(us, t) <= 20) { const c = (sight.chase[n] ??= { ticks: 0, ourTiles: 0, gap: { n: 0 }, gangAccountOnMultiWayTiles: 0 }); c.ticks++; c.ourTiles += cheb(last, us); if (multi(t)) c.gangAccountOnMultiWayTiles++; (gaps.get(n) ?? gaps.set(n, []).get(n)!).push(cheb(us, t)); }
                lastG.set(n, t); }
        }
        if (player.isDead) sight.died = true;
        hp = player.hp; last = us;
    }
    for (const [n, a] of gaps) sight.chase[n]!.gap = spread(a);
    if (sight.ticks) rec.group.sightings.push(sight);
}

// Adds the lines of one trace to the record. `multi` says whether a tile is multi-way; `seq` and `obj` name an
// animation and an object.
export function addTrace(rec: ReturnType<typeof newRecord>, path: string, lines: string[], multi: (t: Tile) => boolean, seq: (id: number) => string, obj: (id: number) => string) {
    const { acc, group } = rec, isGang = (n: string) => n in acc;
    const bySlot = new Map<number, Entity>();
    const st = Object.fromEntries(GANG.map(n => [n, {} as { lastAttack?: number; lastEat?: number; lowSince?: number; heal?: { k: number; hp: number }; prayAt?: number; skullAt?: number; pend?: { k: number; cls: Style; role: 'attacked' | 'waiting' };
        atPost?: boolean; trip?: Trip; low?: Low; dead?: { i: number }; altarAt?: number; monAt?: number; lastT?: { name: string; x: number; z: number; k: number }; lastTile?: Tile; frozen?: Acc['freezes'][number] }]));
    const gangEntity = (n: string) => [...bySlot.values()].find(e => e.name === n && !e.gone);
    const hits: { k: number; by: string; target: string; multi: boolean }[] = [], attacked = new Set<string>(), near = new Map<string, { frames: number; combat: number; minD: number }>();
    let anchor: { at: number; tick: number } | undefined, k0 = 0, k1 = 0, frames = 0;
    const wall = (k: number) => (anchor ? anchor.at + (k - anchor.tick) * TICK_MS : undefined);
    for (const raw of lines) {
        if (!raw) continue;
        let m: any; try { m = JSON.parse(raw); } catch { continue; }
        if (m.t === 'hello') { if (typeof m.at === 'number' && typeof m.tick === 'number') anchor = { at: m.at, tick: m.tick }; for (const [slot, e] of bySlot) if (e.region === (m.r ?? 0)) bySlot.delete(slot); continue; }
        const k: number = m.k;
        if (m.t === 'roster') {
            frames++; k0 ||= k; k1 = k;
            const at = wall(k), hour = at === undefined ? undefined : new Date(at).getUTCHours();
            if (hour !== undefined) bump(group.hours, hour);
            const rows = (m.p ?? []) as [number, string, number, number, number, number][];
            for (const p of rows) { const name = String(p[1]).toLowerCase(), e = bySlot.get(p[0]); if (!e || e.name !== name) bySlot.set(p[0], { slot: p[0], name, x: p[2], z: p[3], combat: p[5], worn: [], weapon: '', head: 0 }); else { e.x = p[2]; e.z = p[3]; e.combat = p[5]; e.gone = false; } }
            // A player that the game lets a combat 126 account attack where that player stands.
            const cands = rows.filter(p => !isGang(String(p[1]).toLowerCase()) && wild({ x: p[2], z: p[3] }) > 0 && Math.abs(126 - p[5]) <= wild({ x: p[2], z: p[3] })).map(p => ({ name: String(p[1]).toLowerCase(), combat: p[5], d: cheb({ x: p[2], z: p[3] }, POST) }));
            const gangRows = rows.filter(p => isGang(String(p[1]).toLowerCase())), onPost = gangRows.filter(p => cheb({ x: p[2], z: p[3] }, POST) <= 1).length;
            if (onPost) for (const c of cands) if (c.d <= 30) { const n = near.get(c.name) ?? { frames: 0, combat: c.combat, minD: c.d }; n.frames++; n.minD = Math.min(n.minD, c.d); near.set(c.name, n); }
            if (gangRows.length === GANG.length) bump(group.offPost, GANG.length - onPost);
            const leaving = gangRows.filter(p => st[String(p[1]).toLowerCase()]!.atPost && cheb({ x: p[2], z: p[3] }, POST) > 1).length;
            for (const p of gangRows) {
                const name = String(p[1]).toLowerCase(), g = acc[name]!, s = st[name]!, t = { x: p[2], z: p[3] }, d = cheb(t, POST), here = d <= 1;
                g.frames++; bump(g.place, where(t)); g.maxDist = Math.max(g.maxDist, d); if (hour !== undefined) bump(g.hours, hour);
                if (!here && s.lastTile && cheb(s.lastTile, t) === 0 && (s.lastAttack === undefined || k - s.lastAttack > 20)) bump(g.stand, `${t.x},${t.z}`);
                s.lastTile = t;
                if (s.atPost && !here) { s.trip = { k, tiles: 0, cands: cands.map(c => ({ name: c.name, d: c.d })), maxD: d, far: t }; bump(g.trips.leftWith, leaving); }
                if (s.trip) { if (d > s.trip.maxD) { s.trip.maxD = d; s.trip.far = t; }
                    if (here) { const tr = s.trip, T = g.trips; s.trip = undefined; T.duration.push(k - tr.k); T.maxDist.push(tr.maxD);
                        if (tr.firstAttack !== undefined) { T.withAttack++; T.response.push(tr.firstAttack - tr.k); T.back.push(k - tr.lastAttack!); if (tr.targetD !== undefined) T.targetDist.push(tr.targetD); } else { T.noAttack++; bump(T.noAttackPlace, where(tr.far)); } } }
                s.atPost = here;
                if (s.dead) { const dth = g.deaths[s.dead.i]!; if (!dth.respawn && k > dth.k + 3) dth.respawn = [t.x, t.z]; if (here) { dth.backOnPost = k - dth.k; s.dead = undefined; } }
                if (cheb(t, ALTAR) <= 4) { if (s.altarAt === undefined || k - s.altarAt > 200) g.altar.push(at ?? k); s.altarAt = k; }
                if (cheb(t, MONASTERY) <= 12) { if (s.monAt === undefined || k - s.monAt > 200) g.monastery.push(at ?? k); s.monAt = k; }
                if (s.low) { if (s.low.out === undefined && wild(t) === 0) s.low.out = k - s.low.k; if (d <= 3 && s.low.out !== undefined) { s.low.post = k - s.low.k; g.lows.push({ ...s.low, trace: path }); s.low = undefined; } }
            }
            continue;
        }
        if (m.t !== 'tick') continue;
        for (const slot of m.rp ?? []) { const e = bySlot.get(slot); if (e) e.gone = true; }
        const recs = (m.p ?? []) as any[];
        // First every tile, appearance and faced player of the tick, then what each player did.
        const seen: { e: Entity; r: any; head0: number }[] = [];
        for (const r of recs) {
            let e = bySlot.get(r.i);
            const a = typeof r.ap === 'string' ? decodeAppearance(r.ap) : null;
            if (r.f || !e) { e = { slot: r.i, name: a?.name ?? e?.name ?? `slot${r.i}`, x: r.x ?? e?.x ?? 0, z: r.z ?? e?.z ?? 0, combat: a?.combat ?? e?.combat ?? 0, worn: e?.worn ?? [], weapon: e?.weapon ?? '', cls: r.f ? undefined : e?.cls, head: e?.head ?? 0 }; bySlot.set(r.i, e); }
            if (r.x !== undefined) { e.x = r.x; e.z = r.z; } else for (const d of r.m ?? []) { e.x += DX[d] ?? 0; e.z += DZ[d] ?? 0; }
            e.region = m.r ?? 0; e.gone = false;
            if (r.fe !== undefined) e.fe = r.fe;
            const head0 = e.head;
            if (a) { if (a.name) e.name = a.name; e.combat = a.combat; e.head = Uint8Array.from(atob(r.ap), c => c.charCodeAt(0))[1] ?? 0; e.worn = a.worn.map(w => obj(w.obj)); e.weapon = obj(a.worn.find(w => w.slot === 3)?.obj ?? -1); }
            if (r.hp && !isGang(e.name)) e.hp = r.hp[0];
            seen.push({ e, r, head0 });
        }
        const faces = (a: Entity, b: Entity) => a.fe === 32768 + b.slot;
        for (const { e, r, head0 } of seen) {
            if (!isGang(e.name)) {
                if (r.ap) { const cls = styleOf(e.weapon), first = e.cls === undefined; e.cls = e.cls ?? cls;
                    // A change of the weapon of a player in a fight with a gang account: the gang account has 8 ticks to turn its prayer.
                    if (!first && cls !== e.cls) { e.cls = cls; for (const n of GANG) { const ge = gangEntity(n); if (ge && (faces(ge, e) || faces(e, ge)) && cheb(ge, e) <= 16) { const s = st[n]!; if (s.pend) acc[n]!.lagMiss[s.pend.role]++; s.pend = protect(ge.head) === cls ? undefined : { k, cls, role: faces(e, ge) ? 'attacked' : 'waiting' }; } } } }
                if (r.an && r.an[0] >= 0) { const name = seq(r.an[0]); e.anim = { k, name };
                    if (e.fe !== undefined && e.fe >= 32768 && !/eat|block|death|ready|walk/.test(name)) { const t = bySlot.get(e.fe - 32768); if (t && isGang(t.name)) { bump(acc[t.name]!.hitters, e.name); const cls = /cast|spell/.test(name) ? 'magic' : styleOf(e.weapon), row = (acc[t.name]!.prayedAgainst[`${cls}: ${e.weapon || 'no weapon'}`] ??= { attacks: 0, prayed: 0, players: new Set() }); row.attacks++; row.players.add(e.name); if (protect(t.head) === cls) row.prayed++; } } }
                if (r.an?.[0] === SEQ.death) {
                    // The gang attacks on this player with no gap over 40 ticks before its death are one kill.
                    const on = hits.filter(h => h.target === e.name && k - h.k <= 400); let i = on.length - 1; while (i > 0 && on[i]!.k - on[i - 1]!.k <= 40) i--;
                    if (on.length && k - on[on.length - 1]!.k <= 12) group.kills.push({ ticks: k - on[i]!.k, attackers: new Set(on.slice(i).map(h => h.by)).size, multi: multi(e), combat: e.combat, worn: [...e.worn], wild: wild(e) });
                }
                continue;
            }
            const g = acc[e.name]!, s = st[e.name]!;
            if (r.m) { if (r.m.length > 1) g.steps.run++; else g.steps.walk++; if (s.frozen && s.frozen.ticksToFirstStep === undefined && k - s.frozen.k <= 60) s.frozen.ticksToFirstStep = k - s.frozen.k; if (s.trip && s.trip.firstAttack === undefined) s.trip.tiles += r.m.length; }
            if (r.ap) {
                bump(g.worn, e.worn.join(',') || '(nothing)');
                if (s.dead && g.deaths[s.dead.i] && !g.wornAfterDeath.includes(e.worn.join(','))) g.wornAfterDeath.push(e.worn.join(','));
                const p0 = protect(head0), p1 = protect(e.head);
                if (p1 !== p0) {
                    if (p0 !== 'off' && s.prayAt !== undefined) (p1 === 'off' ? g.holds.off : g.holds.changed).push(k - s.prayAt);
                    s.prayAt = p1 === 'off' ? undefined : k;
                    if (p1 !== 'off') {
                        const opp = (e.fe !== undefined && e.fe >= 32768 ? bySlot.get(e.fe - 32768) : undefined) ?? [...bySlot.values()].find(o => !o.gone && faces(o, e) && !isGang(o.name));
                        bump(g.prayerOn, `${p1} | opponent weapon ${opp?.cls ?? 'none'} | opponent animation ${opp?.anim && k - opp.anim.k <= 6 ? opp.anim.name : '-'}`);
                        if (s.pend && s.pend.cls === p1 && k - s.pend.k <= 8) { bump(g.lag[s.pend.role], k - s.pend.k); s.pend = undefined; }
                    }
                }
                if ((e.head & 1) !== (head0 & 1)) { if (e.head & 1) { s.skullAt = k; if (s.lastAttack !== undefined && k - s.lastAttack <= 10) bump(g.skullOnAfterAttack, k - s.lastAttack); } else if (s.skullAt !== undefined) { g.skullHolds.push(k - s.skullAt); s.skullAt = undefined; } }
            }
            if (s.pend && k - s.pend.k > 8) { g.lagMiss[s.pend.role]++; s.pend = undefined; }
            if (r.sp && FREEZE_SPOT[r.sp[0]]) { s.frozen = { k, spot: FREEZE_SPOT[r.sp[0]]!, trace: path, protect: protect(e.head) }; g.freezes.push(s.frozen); }
            const an: number | undefined = r.an?.[0];
            if (an === SEQ.eat) {
                // A reading is fresh for 20 ticks. An eat at 90 or more, or with an old reading, is not an eat for Hitpoints: a drink plays the same animation (anti_poison.rs2).
                const fresh = e.hp !== undefined && !e.hpStale && e.hpAt !== undefined && k - e.hpAt <= 20;
                if (fresh && e.hp! < 90) { g.eats++; bump(g.eatHp, e.hp!); if (s.lowSince !== undefined) bump(g.eatLag, k - s.lowSince); if (s.lastEat !== undefined && k - s.lastEat <= 3) g.comboEats++; s.heal = { k, hp: e.hp! }; if (s.low) s.low.eatsAfter++; }
                else if (s.lastEat !== undefined && k - s.lastEat <= 60 && e.hpStale) { g.eats++; bump(g.eatHp, 'not known'); if (s.low) s.low.eatsAfter++; }
                else g.otherConsumes.push({ k, trace: path, hp: e.hp, hpAge: e.hpAt === undefined ? undefined : k - e.hpAt, ticksSinceAttack: s.lastAttack === undefined ? undefined : k - s.lastAttack, wilderness: wild(e) });
                s.lastEat = k; s.lowSince = undefined; e.hpStale = true;
            } else if (an === SEQ.death) { g.deaths.push({ k, trace: path, x: e.x, z: e.z }); s.dead = { i: g.deaths.length - 1 }; if (s.low) g.lows.push({ ...s.low, minHp: 0, died: k - s.low.k, trace: path }); s.low = undefined; e.hp = undefined;
            } else if (an !== undefined && (an === SEQ.special || (SEQ.attack as readonly number[]).includes(an))) attack: {
                const spec = an === SEQ.special, target = e.fe !== undefined && e.fe >= 32768 ? bySlot.get(e.fe - 32768) : undefined;
                if (s.lastAttack !== undefined && k - s.lastAttack <= 12) { bump(g.intervals, k - s.lastAttack); if (s.lastEat !== undefined && s.lastEat > s.lastAttack) bump(g.intervalsWithEat, k - s.lastAttack); }
                s.lastAttack = k; if (s.frozen && s.frozen.ticksToNextAttack === undefined && k - s.frozen.k <= 60) s.frozen.ticksToNextAttack = k - s.frozen.k; if (s.low) s.low.lastAttack = k - s.low.k;
                if (!target) break attack;
                g.attacks++; if (spec) g.specials++; attacked.add(target.name);
                bump(g.attackDist, cheb(e, target));
                // The Hitpoints of the player before the splats of this tick.
                const tnow = seen.find(o => o.e === target)?.r, thp = target.hp === undefined ? undefined : tnow?.hp ? tnow.hp[0] + (tnow.hm as number[][] ?? []).reduce((a, h) => a + h[0]!, 0) : target.hp;
                if (spec) { bump(g.specTargetHp, thp === undefined ? 'not known' : `${Math.floor(thp / 10) * 10}-${Math.floor(thp / 10) * 10 + 9}`); bump(g.specOwnHp, e.hp === undefined || e.hpStale ? 'not known' : `${Math.floor(e.hp / 10) * 10}-${Math.floor(e.hp / 10) * 10 + 9}`); }
                if (s.lastT && s.lastT.name === target.name && k - s.lastT.k <= 8) bump(g.targetStep, Math.min(10, cheb(s.lastT, target)));
                else if (s.lastT && s.lastT.name !== target.name && k - s.lastT.k <= 40) { const old = [...bySlot.values()].find(o => o.name === s.lastT!.name); bump(g.switches, old && !old.gone ? 'the old player was in view' : 'the old player was gone'); }
                s.lastT = { name: target.name, x: target.x, z: target.z, k };
                const same = seen.filter(o => o.e !== e && isGang(o.e.name) && o.e.fe === e.fe && (o.r.an?.[0] === SEQ.special || (SEQ.attack as readonly number[]).includes(o.r.an?.[0]))).length;
                const trec = seen.find(o => o.e === target)?.r;
                if (trec?.hm) { const own = (trec.hm as number[][]).filter(h => h[1] !== 2); for (const h of trec.hm as number[][]) if (h[1] === 2) bump(g.poisonOnTarget, h[0]!);
                    if (own.length && !same && own.length <= (spec ? 2 : 1)) for (const h of own) bump((g.damage[`${spec ? 'special' : 'attack'} on a player ${target.head & 8 ? 'with' : 'without'} Protect from Melee`] ??= {}), h[0]!); else if (own.length) g.splatsAmbiguous++; }
                hits.push({ k, by: e.name, target: target.name, multi: multi(target) });
                bump(multi(target) ? group.pile.multi : group.pile.single, 1 + new Set(hits.filter(h => h.target === target.name && h.by !== e.name && k - h.k <= 4).map(h => h.by)).size);
                const tr = s.trip; if (tr) { tr.lastAttack = k; if (tr.firstAttack === undefined) { tr.firstAttack = k; tr.target = target.name; tr.targetD = cheb(target, POST); if (cheb(e, POST) >= 20) g.trips.pathOverLine.push(Math.round((100 * tr.tiles) / cheb(e, POST)) / 100);
                    const order = [...tr.cands].sort((a, b) => a.d - b.d).map(c => c.name), rank = order.indexOf(target.name); bump(g.choiceRank, rank < 0 ? 'not in range at the leave' : `${rank + 1} of ${order.length}`); } }
            }
            if (r.hm) {
                let dmg = 0; for (const h of r.hm as number[][]) { dmg += h[0]!; if (h[1] === 2) g.poisonSplats++; else bump((g.splats[protect(e.head)] ??= {}), h[0]!); }
                const hp: number | undefined = r.hp?.[0];
                if (hp !== undefined) {
                    if (s.heal && k - s.heal.k <= 12) { const heal = hp + dmg - s.heal.hp; if (heal > 0 && heal <= 30) bump(g.heal, heal); }
                    s.heal = undefined; e.hp = hp; e.hpAt = k; e.hpStale = false;
                    if (hp > 74) s.lowSince = undefined; else s.lowSince ??= k;
                    if (hp <= 40 && hp > 0 && !s.low && !s.dead) s.low = { k, hp, minHp: hp, eatsAfter: 0 };
                    if (s.low) s.low.minHp = Math.min(s.low.minHp, hp);
                }
            }
        }
    }
    for (const n of GANG) { const s = st[n]!; if (s.low) acc[n]!.lows.push({ ...s.low, trace: path }); }
    for (const [name, n] of near) if (n.frames >= 5 && !attacked.has(name)) { bump(group.ignored, n.combat); if (group.ignoredExamples.length < 12) group.ignoredExamples.push(`${name} combat ${n.combat}, ${n.frames} frames, ${n.minD} tiles at the least`); }
    const d = digest(lines, new Set<string>(GANG), obj);
    for (const f of d.fights) bump(group.perTarget, new Set(d.fights.filter(o => o.target === f.target && o.start <= f.end + 40 && o.end >= f.start - 40).map(o => o.by)).size);
    for (const f of d.fights) { group.fights.push(f); if (f.targetCombat !== undefined) bump(group.attackedCombat, f.targetCombat); bump(group.attackedWild, f.wild); }
    const iso = (k: number) => { const w = wall(k); return w === undefined ? `tick ${k}` : new Date(w).toISOString(); };
    group.sources.push({ path, ticks: k1 - k0, from: iso(k0), to: iso(k1), frames });
}

type Finding = { value?: unknown; status: 'measured' | 'reported' | 'unknown'; n?: number; evidence?: string; closes?: string; cloneRange?: unknown; note?: string };
const M = (value: unknown, n: number, evidence: string, note?: string): Finding => ({ value, status: 'measured', n, evidence, ...(note ? { note } : {}) });
const R = (value: unknown, n: number, evidence: string, note?: string): Finding => ({ value, status: 'reported', n, evidence, ...(note ? { note } : {}) });
const U = (closes: string, cloneRange?: unknown, note?: string): Finding => ({ status: 'unknown', closes, ...(cloneRange !== undefined ? { cloneRange } : {}), ...(note ? { note } : {}) });
const FEED = 'a longer run of scripts/measure/pk-gang-collect.ts', TICKS = 'the tick record of a bounded squad run (packages/core/src/tick-record.ts)';
const PILOTS = 'research/pvp-fight-loop.md "The cost of a kill" (two squad pilots of side claude-cloud; their logs are not on this PC)';

// The data file of one gang account. `levels` is its hiscore row.
export function targetFile(name: string, g: Acc, group: GroupAcc, levels: Record<string, string> | undefined, levelSource: string) {
    const src = 'the traces of `sources`', fights = group.fights.filter(f => f.by === name), noEat = (f: Fight) => f.order.replace(/E/g, '');
    const specs = fights.map(f => (f.order.match(/S/g) ?? []).length), firstSpec = fights.map(f => noEat(f).indexOf('S')).filter(i => i >= 0);
    const eatsBy: Hist = {}; for (const x of fights) { const e = (x.order.match(/E/g) ?? []).length; if (e) bump(eatsBy, x.target, e); }
    const mostEats = Math.max(0, ...Object.values(eatsBy)), ranDry = g.lows.some(l => l.eatsAfter === 0);
    const hist = (a: number[]) => { const h: Hist = {}; for (const v of a) bump(h, v); return h; };
    const share = (h: Hist) => { const t = total(h); return Object.fromEntries(Object.entries(h).map(([key, v]) => [key, Math.round((1000 * v) / (t || 1)) / 10])); };
    const online = Object.fromEntries(Object.keys(group.hours).sort((a, b) => Number(a) - Number(b)).map(h => [h, Math.round((100 * (g.hours[h] ?? 0)) / group.hours[h]!)]));
    return {
        name, built: 'bun scripts/measure/pk-gang-record.ts build', sources: group.sources,
        levels: { skills: levels ? M(levels, 1, levelSource) : U('the hiscore page of the name'), combat: M(name === 'goondelf' ? 126 : 125, g.frames, `${src}: the roster rows`) },
        kit: {
            worn: M(g.worn, total(g.worn), `${src}: each appearance block, by its worn objects`),
            weaponPoison: M(Object.keys(g.poisonOnTarget).length ? { poisonSplatsOnPlayers: g.poisonOnTarget } : 'no poison splat on a player', total(g.poisonOnTarget), `${src}: type 2 splats on a player in a tick of an attack`, 'the worn name says which dagger; the splat sizes say how strong the poison is'),
            food: M({ eats: g.eats, healOfOneEat: g.heal }, g.eats, `${src}: animation 829 (human_eat), and the Hitpoints of the splats before and after it`, 'a heal of 20 is a shark (consume_normal.dbrow)'),
            foodCount: ranDry ? M({ sharks: mostEats, eatsByOpponent: eatsBy }, 1, `${src}: the eat animations in the fights against one opponent, in a meeting that the name ended at 40 Hitpoints or less with no eat after it`, 'the food ran out in that meeting, so its eats are the pack; a refill at the bank between two fights would add to the count')
                : U(`${TICKS} against the name, to its retreat: the eats of one fight are its pack`, { sharks: [6, 23] }, `the most eats against one opponent: ${mostEats}; the food did not run out`),
            consumesNotForHitpoints: M(g.otherConsumes, g.otherConsumes.length, `${src}: animation 829 at 90 Hitpoints or more, or with no splat in the 20 ticks before`, 'a drink and an eat play the same animation (anti_poison.rs2:3); which item it was is not known'),
            potions: U('a splat over 22 with no Protect from Melee (a Strength boost), or a drink that restores no Hitpoints, in ' + FEED, { boosts: [false, true], prayerPotions: [0, 2] }, 'Herblore has no level on any of the three; a drink and an eat share animation 829'),
            runes: U(`a cast animation of the name in ${FEED}`, { casts: false }, 'no cast animation of a gang account is in any trace'),
        },
        attack: {
            ticksBetweenAttacks: M(g.intervals, total(g.intervals), `${src}: animations 376, 377 and 1062`),
            ticksBetweenAttacksWithAnEat: M(g.intervalsWithEat, total(g.intervalsWithEat), `${src}: the same, with an eat between the two attacks`),
            tilesToTarget: M(g.attackDist, total(g.attackDist), `${src}: the tiles of both at each attack`),
            damage: M(g.damage, Object.values(g.damage).reduce((a, h) => a + total(h), 0), `${src}: the splats on the player in the tick of the attack, when no second gang account attacked it in that tick`, `each splat alone; ${g.splatsAmbiguous} ticks with a splat of a second attacker are left out`),
            specials: M({ attacks: g.attacks, specials: g.specials, perFight: hist(specs), attacksBeforeTheFirst: hist(firstSpec) }, fights.length, `${src}: the order of each fight (pk-rival-feed.ts digest)`),
            specialAtTargetHp: M(g.specTargetHp, g.specials, `${src}: the Hitpoints of the player before the splats of the tick of the special`),
            specialAtOwnHp: M(g.specOwnHp, g.specials, `${src}: the last Hitpoints of the name that a splat showed`),
        },
        prayer: {
            protectOn: M(g.prayerOn, total(g.prayerOn), `${src}: each change of the head icon, with the weapon class and the last animation of the player in the fight`),
            ticksFromWeaponChangeToPrayer: M({ whenTheOpponentFacesIt: g.lag.attacked, whenItWaits: g.lag.waiting, noChangeIn8Ticks: { whenTheOpponentFacesIt: g.lagMiss.attacked, whenItWaits: g.lagMiss.waiting } }, total(g.lag.attacked) + total(g.lag.waiting), `${src}: the appearance block of the opponent, then that of the name`),
            ticksAProtectPrayerStaysOn: M({ toOff: spread(g.holds.off), toAnotherProtectPrayer: spread(g.holds.changed), twoTicksOrLess: [...g.holds.off, ...g.holds.changed].filter(h => h <= 2).length }, g.holds.off.length + g.holds.changed.length, `${src}: head icon on to head icon off or changed`, 'a flick would show as many holds of 1 or 2 ticks'),
            splatsTaken: M({ byHeadIcon: Object.fromEntries(Object.entries(g.splats).map(([p, h]) => [p, { splats: total(h), damage: Object.entries(h).reduce((a, [d, c]) => a + Number(d) * c, 0), highest: Math.max(0, ...Object.keys(h).map(Number)) }])), poison: g.poisonSplats }, Object.values(g.splats).reduce((a, h) => a + total(h), 0), `${src}: splats on the name, by its protect prayer in that tick`),
            prayerPoints: U(`${TICKS}: no feed field holds prayer points; the tick at which the head icon goes off for good under attack is the sign`, { protectFor: ['the whole fight', '400 ticks'] }),
            otherPrayers: U('none: a prayer with no head icon (Protect Item, the Strength, Attack and Defence prayers) is in no public data; the damage ceiling is the only sign', { strengthPrayer: true, protectItem: [false, true] }),
            chaosAltarVisits: M(g.altar.map(t => (t > 1e12 ? new Date(t).toISOString() : `tick ${t}`)), g.altar.length, `${src}: roster frames within 4 tiles of (2948, 3820)`),
            monasteryVisits: M(g.monastery.map(t => (t > 1e12 ? new Date(t).toISOString() : `tick ${t}`)), g.monastery.length, `${src}: roster frames within 12 tiles of (3052, 3490)`),
        },
        eating: {
            hpAtEat: M(g.eatHp, g.eats, `${src}: the Hitpoints of the last splat in the 20 ticks before animation 829`, '"not known": an eat within 60 ticks of an eat with no splat between'),
            ticksFrom74HpOrLessToTheEat: M(g.eatLag, total(g.eatLag), `${src}: the first splat that left 74 or less, then the eat`),
            eatsWithin3TicksOfAnEat: M(g.comboEats, g.eats, `${src}: two animations 829 at most 3 ticks apart`),
        },
        movement: {
            place: M(share(g.place), g.frames, `${src}: the tile of each roster frame (each 10 ticks)`),
            standsOffThePost: M(Object.fromEntries(Object.entries(g.stand).sort((a, b) => b[1] - a[1]).slice(0, 12)), total(g.stand), `${src}: roster frames on the tile of the frame before, off the post, no attack for 20 ticks`),
            steps: M(g.steps, g.steps.run + g.steps.walk, `${src}: the step records of each tick`),
            farthestFromPost: M(g.maxDist, g.frames, `${src}: roster frames`),
            trips: M({ withAnAttack: g.trips.withAttack, withNoAttack: g.trips.noAttack, farthestPlaceOfATripWithNoAttack: g.trips.noAttackPlace, accountsThatLeftInTheSameFrame: g.trips.leftWith,
                ticksFromLeaveToFirstAttack: spread(g.trips.response), tilesWalkedOverStraightLineToTheFirstAttack: spread(g.trips.pathOverLine), ticksFromLastAttackToPost: spread(g.trips.back), ticksAway: spread(g.trips.duration), tilesFromPostAtTheFarthest: spread(g.trips.maxDist), tilesFromPostToTheTargetAtTheFirstAttack: spread(g.trips.targetDist) },
                g.trips.withAttack + g.trips.noAttack, `${src}: from the roster frame off the post to the next one on it`),
        },
        targets: {
            rankByDistanceFromPostOfTheFirstTarget: M(g.choiceRank, total(g.choiceRank), `${src}: the players the game lets the name attack at the frame of the leave, nearest to the post first`),
            targetChange: M(g.switches, total(g.switches), `${src}: an attack on a new player within 40 ticks of the last one on the old player`),
            targetTilesMovedBetweenTwoAttacks: M(g.targetStep, total(g.targetStep), `${src}: the tile of the player at two attacks at most 8 ticks apart`, 'a player that moves is still attacked'),
            frozen: g.freezes.length ? M(g.freezes.map(f => ({ spot: f.spot, protect: f.protect, ticksToFirstStep: f.ticksToFirstStep ?? 'none in 60', ticksToNextAttack: f.ticksToNextAttack ?? 'none in 60', trace: f.trace, tick: f.k })), g.freezes.length, `${src}: spot animations 179 to 181 (the impact of Entangle, Snare, Bind) on the name`) : U(`a Bind, Snare or Entangle on the name in ${FEED}, or ${TICKS} with Bind runes`, { whenFrozen: ['attacks a player beside it', 'stands'] }),
        },
        retreat: {
            at40HpOrLess: g.lows.length ? M(g.lows.map(l => ({ hp: l.hp, lowestHp: l.minHp, eatsAfter: l.eatsAfter, ticksToLastAttack: l.lastAttack, ticksToOutOfTheWilderness: l.out, ticksToBackOnPost: l.post, ticksToDeath: l.died, trace: l.trace })), g.lows.length, `${src}: from the first splat that left 40 or less`) : U(`${TICKS} that takes the name to 40 Hitpoints or less`, { walkOutAtHp: [20, 40] }),
            prayedAgainst: M(Object.fromEntries(Object.entries(g.prayedAgainst).sort((a, b) => b[1].attacks - a[1].attacks).slice(0, 14).map(([w, r]) => [w, { attackAnimations: r.attacks, withTheProtectPrayerForItOn: r.prayed, players: r.players.size }])), Object.values(g.prayedAgainst).reduce((a, r) => a + r.attacks, 0), `${src}: attack animations of players that face the name, by the weapon of the player`, 'the rule that turns a protect prayer on is not known; this table is its evidence'),
            hitBy: M({ players: Object.keys(g.hitters).length, attackAnimations: total(g.hitters) }, total(g.hitters), `${src}: attack animations of players that face the name`),
        },
        death: g.deaths.length ? M(g.deaths.map(d => ({ at: [d.x, d.z], firstTileAfter: d.respawn, ticksToBackOnPost: d.backOnPost, trace: d.trace })).concat(g.wornAfterDeath.length ? [{ wornAfter: g.wornAfterDeath } as any] : []), g.deaths.length, `${src}: animation 836 of the name, then its roster frames`) : U(`a death of the name in ${FEED}`, { ticksToBackOnPost: [1000, 1500] }),
        skull: M({ ticksFromAttackToSkull: g.skullOnAfterAttack, ticksASkullStays: spread(g.skullHolds) }, total(g.skullOnAfterAttack), `${src}: head icon bit 1`),
        schedule: M({ percentOfRosterFramesOnlineByUtcHour: online }, g.frames, `${src}: roster frames with the name, of all roster frames of that hour`),
    };
}

// The data file of the group.
export function groupFile(rec: ReturnType<typeof newRecord>) {
    const { acc, group } = rec, src = 'the traces of `sources`';
    const ends: Hist = {}, len: number[] = []; for (const f of group.fights) { bump(ends, f.ended); len.push(f.end - f.start); }
    const kills = (multi: boolean) => group.kills.filter(x => x.multi === multi).map(x => ({ ticks: x.ticks, attackers: x.attackers, combat: x.combat, wilderness: x.wild, worn: x.worn.join(',') || '(nothing)' }));
    return {
        names: GANG, built: 'bun scripts/measure/pk-gang-record.ts build', sources: group.sources,
        post: M({ tile: [POST.x, POST.z], wilderness: wild(POST), percentOfFramesOnIt: Object.fromEntries(GANG.map(n => [n, Math.round((1000 * (acc[n]!.place.post ?? 0)) / (acc[n]!.frames || 1)) / 10])) }, Math.min(...GANG.map(n => acc[n]!.frames)), `${src}: roster frames within 1 tile of the post`),
        accountsOffThePostInOneFrame: M(group.offPost, total(group.offPost), `${src}: roster frames with all three online`),
        accountsOnOneTarget: M(group.perTarget, group.fights.length, `${src}: for each fight, the gang accounts with a fight on that player within 40 ticks`),
        fights: M({ count: group.fights.length, ticks: spread(len), ended: ends }, group.fights.length, `${src}: pk-rival-feed.ts digest`),
        targets: {
            combatOfAttacked: M(group.attackedCombat, total(group.attackedCombat), `${src}: the first attack of each fight`),
            wildernessLevelOfAttacked: M(group.attackedWild, total(group.attackedWild), `${src}: the tile of the player at the first attack`),
            attackableAndNotAttacked: M({ byCombat: group.ignored, examples: group.ignoredExamples }, total(group.ignored), `${src}: players the game lets a combat 126 account attack, 5 roster frames or more within 30 tiles of the post with a gang account on it, with no attack in that trace`),
            combatRule: M('the game allows an attack only within as many combat levels as the Wilderness level of the tile', 1, 'vendor/rs-sdk/server/content: the Wilderness level rule, research/pvp-fight-loop.md "The least build that can fight the gang is combat 110"', 'a player of combat 26 to 64 near the post (level 16) is not a target the game allows'),
        },
        pileOn: M({ accountsOnOneTargetWithin4Ticks: { multiWayTile: group.pile.multi, singleWayTile: group.pile.single }, kills: { multiWayTile: kills(true), singleWayTile: kills(false) } }, total(group.pile.multi) + total(group.pile.single), `${src}: attacks on one target, by vendor/rs-sdk/server/content/maps/multiway.csv`),
        nearOurAccounts: M(group.sightings, group.sightings.length, 'the tick records of <data>/.practice/gang-record/tick-records.txt (`scan` mode): the state of our account and its nearby players each tick', 'a chase is the ticks in which our account and the gang account both moved, at most 20 tiles apart'),
        walkIn: R({ meetingTile: [3072, 3610], split: 'each gang account took one of ours on single-way tiles', hpLostAKill: [249, 260], kills: [4, 6], oneOnOneFightTicks: [114, 386], ourDeaths: [0, 1] }, 2, PILOTS),
        followsIntoMultiWay: (() => { const on = group.sightings.filter(x => Object.values(x.chase).some(c => c.gangAccountOnMultiWayTiles > 0));
            return on.length ? M({ records: on.map(x => x.record), ticksOfAGangAccountOnAMultiWayTileInAChase: on.reduce((a, x) => a + Object.values(x.chase).reduce((b, c) => b + c.gangAccountOnMultiWayTiles, 0), 0) }, on.length, '`nearOurAccounts`: a gang account ran after one of ours across multi-way tiles', 'a chase across multi-way tiles; a fight on one against a squad is not in a record on this PC')
                : U(`${TICKS} with the squad on the multi-way tiles west of the post`, { followsIntoMultiWay: [true, false] }); })(),
        fightsOnMultiWayAgainstASquad: U(`${TICKS} with the squad on the multi-way tiles west of the post: whether a gang account attacks one of ours there while others of ours stand beside it`, { attacksASquadOnMultiWay: [true, false] }, 'in the second pilot the gang stood at (3192, 3679) and (3136, 3583), both multi-way tiles (' + PILOTS + ')'),
        againstAGroup: R({ fourOfOurs: 'the three came to the squad and each fought one of ours; none stayed away' }, 2, PILOTS),
        againstBind: U(`${TICKS} with Bind runes, or a freeze spot animation on a gang account in ${FEED}`, { whenFrozen: ['attacks a player beside it', 'stands'] }, 'the second pilot carried Bind runes; its log is not on this PC'),
        againstABowAtRange: M(Object.fromEntries(GANG.map(n => [n, Object.fromEntries(Object.entries(acc[n]!.prayerOn).filter(([key]) => key.startsWith('ranged')))])), GANG.reduce((a, n) => a + total(Object.fromEntries(Object.entries(acc[n]!.prayerOn).filter(([key]) => key.startsWith('ranged')))), 0), `${src}: Protect from Missiles on, by the weapon of the opponent`, 'the gang accounts run to a bow user and attack with the dagger; they turn Protect from Missiles on'),
        unknowns: [
            'the pack of a gang account: the number of sharks, potions, runes (not in the feed)',
            'prayers with no head icon, and the prayer points',
            'whether a gang account attacks one of ours on a multi-way tile with others of ours beside it',
            'what a frozen gang account does',
            'the rule that picks one of several players in range (a rank by distance is measured; the rule is not known)',
            'the hours of a week (the traces cover parts of single days)',
        ],
    };
}

if (import.meta.main) {
    const argv = process.argv.slice(2), root = resolve(import.meta.dir, '..', '..');
    const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
    const mode = argv.shift();
    if (mode === 'hiscores') {
        // The public hiscore page of each name, one request each 3 seconds, saved by date.
        const dir = join(resolve(flag('--data') ?? root), '.practice', 'gang-record'); mkdirSync(dir, { recursive: true });
        for (const n of GANG) { const r = await fetch(`https://rs-sdk-demo.fly.dev/hiscores/player/${n}?profile=main`, { signal: AbortSignal.timeout(15_000) }); if (r.ok) writeFileSync(join(dir, `hs-${n}-${new Date().toISOString().slice(0, 10)}.html`), await r.text()); console.log(`${n} http=${r.status}`); await new Promise(done => setTimeout(done, 3_000)); }
        process.exit(0);
    }
    if (mode !== 'build' && mode !== 'scan') { console.log('usage: bun scripts/measure/pk-gang-record.ts build [--data <checkout root>] [--out <dir>] [trace.jsonl ...]'); process.exit(2); }
    const data = resolve(flag('--data') ?? root), out = resolve(flag('--out') ?? join(root, 'scripts', 'pk-gang-record'));
    const feedDir = join(data, '.practice', 'gang-record');
    const traces = argv.length ? argv.map(f => resolve(f)) : [join(data, '.practice', 'rival-dds', 'trace-3.jsonl'), join(data, '.practice', 'rival-dds', 'trace-long-1.jsonl'), ...(existsSync(feedDir) ? readdirSync(feedDir).filter(f => /^feed-\d+\.jsonl$/.test(f)).sort().map(f => join(feedDir, f)) : [])].filter(existsSync);
    const pack = (file: string) => new Map(readFileSync(join(root, 'vendor/rs-sdk/server/content/pack', file), 'utf8').split(/\r?\n/).flatMap(l => { const m = l.match(/^(\d+)=(.+)$/); return m ? [[Number(m[1]), m[2]!] as const] : []; }));
    const objs = pack('obj.pack'), seqs = pack('seq.pack');
    const zones = new Set(readFileSync(join(root, 'vendor/rs-sdk/server/content/maps/multiway.csv'), 'utf8').split(/\r?\n/));
    const multi = (t: Tile) => zones.has([0, t.x >> 6, t.z >> 6, t.x & 56, t.z & 56].join('_'));
    const rec = newRecord(), listFile = join(feedDir, 'tick-records.txt');
    if (mode === 'scan') {
        // Every tick record that names a gang account while the account is in the Wilderness. A record over 40 MB is skipped.
        const dir = join(data, '.practice', 'ticks'), found: string[] = []; let files = 0;
        for (const script of readdirSync(dir)) { let names: string[] = []; try { names = readdirSync(join(dir, script)); } catch { continue; }
            for (const n of names) { if (!n.endsWith('.ticks.ndjson.gz')) continue; files++; const file = join(dir, script, n); let text = ''; try { if (statSync(file).size > 40 * 2 ** 20) continue; text = inflate(file); } catch { continue; }
                if (!/goondelf|ligma|sugma/i.test(text)) continue; const probe = newRecord(); addTickRecord(probe, n, text, multi); if (probe.group.sightings.length) found.push(`.practice/ticks/${script}/${n}`); } }
        mkdirSync(feedDir, { recursive: true }); writeFileSync(listFile, found.join('\n') + '\n');
        console.log(`RESULT ok gang scan files=${files} records=${found.length} out=${relative(data, listFile).replace(/\\/g, '/')}`); process.exit(0);
    }
    for (const t of traces) addTrace(rec, relative(data, t).replace(/\\/g, '/'), readFileSync(t, 'utf8').split('\n'), multi, id => seqs.get(id) ?? `seq${id}`, id => objs.get(id) ?? (id < 0 ? '' : `obj${id}`));
    if (existsSync(listFile)) for (const p of readFileSync(listFile, 'utf8').split(/\r?\n/).filter(Boolean)) if (existsSync(join(data, p))) addTickRecord(rec, p, inflate(join(data, p)), multi);
    // The hiscore row of a name: the newest page of the `hiscores` mode, else the page saved by .practice/rival-dds/hs.ts.
    const levelFile = (name: string) => { const newer = existsSync(feedDir) ? readdirSync(feedDir).filter(x => x.startsWith(`hs-${name}-`)).sort().pop() : undefined; return newer ? join(feedDir, newer) : join(data, '.practice', 'rival-dds', `hs-${name}.html`); };
    const levels = (name: string) => { const file = levelFile(name); if (!existsSync(file)) return undefined;
        const t = readFileSync(file, 'utf8').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]*>/g, '\n').split('\n').map(s => s.trim()).filter(Boolean), i = t.indexOf('Time'), rows: Record<string, string> = {};
        for (let k = i + 1; k + 3 < t.length; k += 4) rows[t[k]!] = t[k + 2]!; return rows; };
    mkdirSync(out, { recursive: true });
    for (const n of GANG) writeFileSync(join(out, `${n}.json`), JSON.stringify(targetFile(n, rec.acc[n]!, rec.group, levels(n), relative(data, levelFile(n)).replace(/\\/g, '/')), null, 1) + '\n');
    writeFileSync(join(out, 'group.json'), JSON.stringify(groupFile(rec), null, 1) + '\n');
    console.log(`RESULT ok gang record traces=${traces.length} fights=${rec.group.fights.length} attacks=${GANG.map(n => rec.acc[n]!.attacks).join('/')} eats=${GANG.map(n => rec.acc[n]!.eats).join('/')} deaths=${GANG.map(n => rec.acc[n]!.deaths.length).join('/')} tickRecords=${rec.group.sightings.length} out=${relative(root, out).replace(/\\/g, '/')}`);
}
