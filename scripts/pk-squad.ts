// The gang squad: several of our accounts hold a multi-way post and kill the named targets that come to it, again and
// again. Built for the dagger gang (Goondelf, Ligma, Sugma: research/pvp-fight-loop.md "The cost of a kill"): the gang
// walks to its target, so the squad waits in the multi-way zone 12 tiles west of the gang's single-way post (x
// 3064-3071, z 3624-3663, Wilderness 14-18) and every account hits the same gang account, the one with the lowest
// health bar (on the bench four kill 47 of 48 at 35 HP a kill, nine 24 of 24 at 14 HP). Each account fights with the
// fight loop (profile SQUAD_PROFILE, default gang-hunter, with SQUAD_OPTS), picks up the dearest drops after a kill
// (scripts/pk-gang.ts pickUp: a skulled gang account with no Protect Item drops its dragon dagger(p)), and when its
// fight loop leaves (low HP with no food) it banks at the nearer bank (bankNear: Edgeville, or Varrock West for a
// post east of x 3136; scripts/pk-gang.ts bankTrip: the pack it started with, the boosts drunk at the bank) and walks
// back to the post.
// Usage: bun scripts/pk-squad.ts <account> [<account> ...] [KEY=value ...]
//   TARGETS=goondelf,ligma,sugma  POST=3067,3640  MAX_MINUTES=30  MAX_KILLS=0 (no limit)  SQUAD_PROFILE=gang-hunter
//   SQUAD_OPTS={"cureNow":true,"eatAt":60,"freeze":"flee","focusRunner":0.4,"chaseBelow":0.4,"freezeMagicCap":49,"dropForStrip":null,"specBelow":0.45}
//   PICKUP=1  TRIPS=10 (bank trips an account may make)  ALLOW_SINGLE=1 (a single-way post)
//   FOLLOW=1 (march to the targets the world feed shows: MAX_WILD=20, FOLLOW_WAIT=30)  MARCH=1 STEP=12 (move together)
//   PULL=1 (attacked on a single-way tile with a multi-way post: walk on into multi-way)
//   RESCUE=1 (a dropped account logs in again at the end and leaves the Wilderness)
// Bench only: SQUAD_GANG=<n> drives the last n accounts as the gang (profile ganker-live against our accounts).
// Live: openBot refuses a non-local server without DEMO_OK=1 and an account of another fleet side. The main account
// is refused. Stop: touch .practice/stop-<account> for one account, or .practice/stop-pk-squad for all.
import { existsSync } from 'node:fs';
import type { Session } from '../packages/core/src/inprocess';
import { sessionWalker, walkPath } from '../packages/core/src/walk';
import { attackable, fightPlayer, ITEMS, isMulti, nextTick, observePlayer, wildernessLevel, type FightOptions } from './pk';
import { bankTrip, packOf, pickUp, PICKUP_ITEMS } from './pk-gang';
import { EDGEVILLE_BANK } from './pk-hunt';
import { connectRadar, kitFrom, Radar } from './pk-roam';
import { sparOptions } from './pk-spar';

export const GANG = ['goondelf', 'ligma', 'sugma'];
export const SQUAD_POST = { x: 3067, z: 3640 };
const MAIN = new Set(['haggis']);
// dropForStrip off: the profile's champion base drops a shark before a freeze to free slots for its armour strip.
// specBelow 0.45: the special waits for a gang account at 45% or less (one-on-one in the pilot's kit with Bind: 13 kills
// of 16 at 89 HP a kill, against 12 at 107 with the profile's special at once; the squad case the same within the noise).
export const SQUAD_OPTS = { cureNow: true, eatAt: 60, freeze: 'flee', focusRunner: 0.4, chaseBelow: 0.4, freezeMagicCap: 49, dropForStrip: null, specBelow: 0.45 } as const;

// FOLLOW=1: where the squad goes when the targets stay out of view. The nearest multi-way Wilderness tile, at
// Wilderness level `maxWild` or less, within `radius` tiles of the targets' middle (their own tile when it is multi-way),
// or null. The world feed (scripts/pk-roam.ts Radar) gives the targets' tiles.
export function meetTile(targets: readonly { x: number; z: number }[], maxWild: number, radius = 24, multi: (x: number, z: number) => boolean = isMulti): { x: number; z: number } | null {
    if (!targets.length) return null;
    const cx = Math.round(targets.reduce((n, t) => n + t.x, 0) / targets.length), cz = Math.round(targets.reduce((n, t) => n + t.z, 0) / targets.length);
    let best: { x: number; z: number } | null = null, bestD = Infinity;
    for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
        // Nearest by steps, then straight across: a tie goes to the tile with the smaller sum of both gaps.
        const x = cx + dx, z = cz + dz, level = wildernessLevel(z), d = Math.max(Math.abs(dx), Math.abs(dz)) + (Math.abs(dx) + Math.abs(dz)) / 1000;
        if (level < 1 || level > maxWild || d >= bestD || !multi(x, z)) continue;
        best = { x, z }; bestD = d;
    }
    return best;
}

// Where a march into a multi-way post enters multi-way: the multi-way tile nearest `from` that is no farther from `to`
// than `from` is (null when `from` is multi-way already or none is within `radius`). Single-way tiles on the way split a
// squad into one fight a pair (the first live pilot met the gang at (3072, 3610), one tile east of the zone).
export function multiEntry(from: { x: number; z: number }, to: { x: number; z: number }, radius = 150, multi: (x: number, z: number) => boolean = isMulti): { x: number; z: number } | null {
    const fx = Math.round(from.x), fz = Math.round(from.z);
    if (multi(fx, fz)) return null;
    const far = Math.max(Math.abs(to.x - fx), Math.abs(to.z - fz));
    for (let d = 1; d <= radius; d++) {
        let best: { x: number; z: number } | null = null, bestTo = Infinity;
        for (let dx = -d; dx <= d; dx++) for (const dz of Math.abs(dx) === d ? Array.from({ length: 2 * d + 1 }, (_, i) => i - d) : [-d, d]) {
            // Closest to the post, then the shortest walk from `from` (a tie on steps alone ran along the zone's edge).
            const x = fx + dx, z = fz + dz, toGap = Math.max(Math.abs(to.x - x), Math.abs(to.z - z)) + (Math.abs(dx) + Math.abs(dz)) / 1000;
            if (toGap <= far + 1 && toGap < bestTo && wildernessLevel(z) > 0 && multi(x, z)) { best = { x, z }; bestTo = toGap; }
        }
        if (best) return best;
    }
    return null;
}

// The steps of a march from `from` to `to`: a tile each `step` tiles on the straight line, `to` last.
export function marchRoute(from: { x: number; z: number }, to: { x: number; z: number }, step: number): { x: number; z: number }[] {
    const span = Math.max(Math.abs(to.x - from.x), Math.abs(to.z - from.z)), n = Math.max(1, Math.ceil(span / Math.max(1, step)));
    return Array.from({ length: n }, (_, i) => i === n - 1 ? { ...to } : { x: Math.round(from.x + (to.x - from.x) * (i + 1) / n), z: Math.round(from.z + (to.z - from.z) * (i + 1) / n) });
}

// The bank of a squad account at x: Varrock West east of x 3136, where the east multi-way zone runs from the ditch
// north of Varrock to x 3327, so the walk between it and the bank keeps to multi-way tiles; Edgeville west of it.
export const VARROCK_WEST_BANK = { x: 3185, z: 3436 };
export const bankNear = (x: number) => (x >= 3136 ? VARROCK_WEST_BANK : EDGEVILLE_BANK);
// A dropped account logged in again: eat to near full, then Camelot Teleport where it can (Magic 45, a law rune and
// 5 air runes, Wilderness 20 or less), else walk to the nearer bank (bankNear). The session when it ends out of the Wilderness, else null.
export async function rescue(s: Session, log: (l: string) => void): Promise<Session | null> {
    const me = () => s.sdk.getState()?.player;
    for (let i = 0; i < 3; i++) if (!await nextTick(s)) return null;
    const start = me();
    if (!start) return null;
    log(`[${s.name}] SQUAD rescue at ${start.worldX},${start.worldZ} wild ${wildernessLevel(start.worldZ)} hp ${start.hp}`);
    if (wildernessLevel(start.worldZ) > 0) {
        for (let i = 0; i < 6; i++) {
            const q = me(), food = s.sdk.getInventory().find(f => f.optionsWithIndex.some(op => /^eat$/i.test(op.text))), op = food?.optionsWithIndex.find(x => /^eat$/i.test(x.text));
            if (!q || !food || !op || q.hp >= q.maxHp - 20) break;
            await s.sdk.sendUseItem(food.slot, op.opIndex);
            for (let t = 0; t < 3; t++) if (!await nextTick(s)) return null;
        }
        const st = s.sdk.getState(), magic = st?.skills.find(k => k.name === 'Magic')?.level ?? 1;
        const held = (id: number) => (st?.inventory ?? []).filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
        if (st && wildernessLevel(start.worldZ) <= 20 && magic >= 45 && held(ITEMS.lawRune) >= 1 && held(ITEMS.airRune) >= 5)
            for (let i = 0; i < 3 && wildernessLevel(me()?.worldZ ?? 0) > 0; i++) { await s.sdk.sendClickComponent(1174); for (let t = 0; t < 6; t++) if (!await nextTick(s)) return null; }
        if (wildernessLevel(me()?.worldZ ?? 0) > 0) await walkPath(await sessionWalker(s), [{ ...bankNear(me()?.worldX ?? start.worldX), tol: 2 }], { maxTicks: 500, idleMs: 9000 });
    }
    const end = me();
    log(`[${s.name}] SQUAD rescue ends at ${end?.worldX},${end?.worldZ} wild ${wildernessLevel(end?.worldZ ?? 0)}`);
    return end && wildernessLevel(end.worldZ) === 0 ? s : null;
}

export type SquadStats = { name: string; fights: number; pulls: number; kills: number; trips: number; died: boolean; picked: Record<string, number>; taken: number };

// The target of the squad: the target account in view with the lowest health bar, the nearest on a tie; one the game
// refused ("I'm already under attack.", "Someone else is already fighting your opponent.") leaves the pick for 8 ticks.
// `me`: the squad account; a target is taken only where the game lets it attack (both in the Wilderness, the combat gap
// within the shallower level: pk.ts attackable). A target that walked out of the Wilderness held the squad at its edge.
export function squadTarget<P extends { name: string; index: number; distance: number; z?: number; combatLevel?: number }>(view: readonly P[], targets: ReadonlySet<string>, health: (p: P) => number, skip: ReadonlySet<string> = new Set(), me?: { z: number; combatLevel: number }): P | undefined {
    return view.filter(p => targets.has(p.name.toLowerCase()) && !skip.has(p.name.toLowerCase()) && (!me || p.z === undefined || attackable(me, { z: p.z, combatLevel: p.combatLevel ?? me.combatLevel })))
        .sort((a, b) => health(a) - health(b) || a.distance - b.distance)[0];
}

// One account of the squad: hold the post, fight the squad's target, pick up, bank and come back.
export async function hold(s: Session, o: { targets: ReadonlySet<string>; post: { x: number; z: number }; aim?: { x: number; z: number }; options: FightOptions; allies: readonly string[]; pickup: boolean; pull?: boolean;
    trips: number; deadline: number; stopped: () => boolean; killsLeft: () => boolean; log: (l: string) => void }): Promise<SquadStats> {
    const stats: SquadStats = { name: s.name, fights: 0, pulls: 0, kills: 0, trips: 0, died: false, picked: {}, taken: 0 };
    const st = s.sdk.getState(), me = () => s.sdk.getState()?.player, life0 = st?.player?.lifeId;
    const pack = packOf(st?.inventory ?? [], st?.equipment ?? []), kit = kitFrom(st?.equipment ?? [], st?.inventory ?? []);
    const ammo = (st?.equipment ?? []).find(e => /arrow|bolt/i.test(e.name))?.id;
    const wanted = new Set([...PICKUP_ITEMS, ...(ammo ? [ammo] : [])]);
    const trip = bankTrip(bankNear(o.post.x), o.post, pack, kit, o.stopped);
    const walker = await sessionWalker(s);
    const going = () => !o.stopped() && s.tick() < o.deadline && o.killsLeft();
    let lastHp = me()?.hp ?? 0, seenMessage = 0, refusedAt = -100, pullSince = -1;
    const skip = new Map<string, number>();
    const unwatch = s.onTick(() => {
        const hp = me()?.hp; if (hp !== undefined) { if (hp < lastHp) stats.taken += lastHp - hp; lastHp = hp; }
        for (const m of s.sdk.getState()?.gameMessages ?? []) { const id = m.observationId ?? m.tick; if (id <= seenMessage) continue; seenMessage = id; if (/already under attack|already fighting your opponent/i.test(m.text)) refusedAt = s.tick(); }
    });
    try {
        while (going()) {
            const p = me();
            if (!p) { if (!await nextTick(s)) break; continue; }
            if ((life0 !== undefined && p.lifeId !== life0) || Math.max(Math.abs(p.worldX - 3222), Math.abs(p.worldZ - 3218)) <= 40) { stats.died = true; o.log(`[${s.name}] SQUAD died`); break; }
            // Out of the Wilderness (a walk out, a teleport): to the bank and back to the post.
            if (wildernessLevel(p.worldZ) === 0) {
                if (stats.trips >= o.trips) { o.log(`[${s.name}] SQUAD no trips left`); break; }
                stats.trips++;
                // Eat up first: a teleport out (Camelot) leaves a long walk, and the gang's daggers poison.
                for (let i = 0; i < 12 && !o.stopped(); i++) {
                    const q = me(), food = s.sdk.getInventory().find(f => f.optionsWithIndex.some(op => /^eat$/i.test(op.text)));
                    const op = food?.optionsWithIndex.find(x => /^eat$/i.test(x.text));
                    if (!q || !food || !op || q.hp >= q.maxHp - 20) break;
                    await s.sdk.sendUseItem(food.slot, op.opIndex);
                    for (let t = 0; t < 3; t++) if (!await nextTick(s)) break;
                }
                const fault = await trip(s);
                const after = me();
                if (after && ((life0 !== undefined && after.lifeId !== life0) || Math.max(Math.abs(after.worldX - 3222), Math.abs(after.worldZ - 3218)) <= 40)) { stats.died = true; o.log(`[${s.name}] SQUAD died on a bank trip`); break; }
                if (fault) { o.log(`[${s.name}] SQUAD bank trip: ${fault}`); break; }
                continue;
            }
            const now = s.tick();
            for (const [k, until] of skip) if (until <= now) skip.delete(k);
            const view = s.sdk.getState()?.nearbyPlayers ?? [];
            const health = (q: { index: number }) => { const seen = observePlayer(s.client, q.index); return seen && seen.totalHealth > 0 ? seen.health / seen.totalHealth : 1; };
            const self = { z: p.worldZ, combatLevel: p.combatLevel };
            const target = squadTarget(view, o.targets, health, new Set(skip.keys()), self);
            if (!target) {
                // No prayer while it waits: an active prayer drains with no fight loop to flick it (in one live meeting
                // our prayer ran out at about tick 730), and the fight loop puts them on again. One input each 3 ticks.
                if (s.tick() % 3 === 0) for (const [i, on] of (s.sdk.getState()?.prayers.activePrayers ?? []).entries()) if (on) void s.sdk.sendTogglePrayer(i);
                // Back to the post between fights.
                // At least a tick each pass: a walk to a step that cannot be reached fails at once.
                if (Math.max(Math.abs(p.worldX - o.post.x), Math.abs(p.worldZ - o.post.z)) > 2) await walkPath(walker, [{ ...o.post, tol: 2 }], { maxTicks: 60, idleMs: 9000, stop: () => !going() || !!squadTarget(s.sdk.getState()?.nearbyPlayers ?? [], o.targets, health, new Set(), self) });
                if (!await nextTick(s)) break;
                continue;
            }
            // Pull: on a single-way tile with the post multi-way (and within 40 tiles), walk on into multi-way and eat on the
            // way instead of fighting there; on a single-way tile the game lets one attacker at a time on each account,
            // so the squad cannot concentrate.
            // The pull aims at the march's goal (`aim`), not its current step, which can be a single-way tile.
            const aim = o.aim ?? o.post;
            // At most 20 ticks of pull at a stretch: an account that cannot get into multi-way (stood on, blocked) fights
            // where it is; one stuck pulling took hits without an answer for hundreds of ticks.
            if (isMulti(p.worldX, p.worldZ)) pullSince = -1;
            if (o.pull && !isMulti(p.worldX, p.worldZ) && isMulti(aim.x, aim.z) && Math.max(Math.abs(p.worldX - aim.x), Math.abs(p.worldZ - aim.z)) <= 40
                && (pullSince < 0 || s.tick() - pullSince < 20)) {
                if (pullSince < 0) pullSince = s.tick();
                const low = () => { const q = me(); return !!q && q.hp < q.maxHp * 0.6; };
                if (low()) {
                    const food = s.sdk.getInventory().find(f => f.optionsWithIndex.some(op => /^eat$/i.test(op.text))), op = food?.optionsWithIndex.find(x => /^eat$/i.test(x.text));
                    if (food && op) { await s.sdk.sendUseItem(food.slot, op.opIndex); if (!await nextTick(s)) break; }
                }
                stats.pulls++;
                await walkPath(walker, [{ ...aim, tol: 2 }], { maxTicks: 30, idleMs: 9000, stop: () => !going() || low() || (() => { const q = me(); return !!q && isMulti(q.worldX, q.worldZ); })() });
                // At least a tick each pass: a walk that stops at once (low HP with no food) must not spin the loop.
                if (!await nextTick(s)) break;
                continue;
            }
            const began = s.tick();
            stats.fights++;
            const r = await fightPlayer(s, target.name, { ...o.options, allies: o.allies, cap: Math.max(1, o.deadline - s.tick()), stop: () => !going() || refusedAt > began,
                log: l => o.log(`[${s.name}] ${l}`) });
            if (refusedAt > began) skip.set(target.name.toLowerCase(), s.tick() + 8);
            const gone = !(s.sdk.getState()?.nearbyPlayers ?? []).some(q => q.name.toLowerCase() === target.name.toLowerCase());
            if (r.outcome === 'kill') stats.kills++;
            if (o.pickup && (r.outcome === 'kill' || gone)) for (const [id, n] of Object.entries(await pickUp(s, wanted, { radius: 3, maxTicks: 30, wait: 6, stop: o.stopped }))) stats.picked[id] = (stats.picked[id] ?? 0) + n;
            if (r.outcome === 'died') { stats.died = true; break; }
            if (!await nextTick(s)) break;
        }
    } finally { unwatch(); }
    return stats;
}

// An account in the Wilderness at the end eats up and walks to the nearer bank (bankNear). `died`: it died on the way (a new
// life, or at the Lumbridge spawn), which the hold's stats did not see; `why`: why a living account is not out.
export async function leaveWilderness(s: Session, diedBefore: boolean): Promise<{ died: boolean; why: string | null }> {
    const me = () => s.sdk.getState()?.player;
    const p = me();
    if (!p || diedBefore || wildernessLevel(p.worldZ) === 0) return { died: false, why: null };
    const life0 = p.lifeId;
    const died = () => { const q = me(); return !!q && ((life0 !== undefined && q.lifeId !== life0) || Math.max(Math.abs(q.worldX - 3222), Math.abs(q.worldZ - 3218)) <= 40); };
    for (let i = 0; i < 12 && !died(); i++) {
        const q = me(), food = s.sdk.getInventory().find(f => f.optionsWithIndex.some(op => /^eat$/i.test(op.text)));
        const op = food?.optionsWithIndex.find(x => /^eat$/i.test(x.text));
        if (!q || !food || !op || q.hp >= q.maxHp - 20) break;
        await s.sdk.sendUseItem(food.slot, op.opIndex);
        for (let t = 0; t < 3; t++) if (!await nextTick(s)) break;
    }
    const r = died() ? null : await walkPath(await sessionWalker(s), [{ ...bankNear(me()?.worldX ?? p.worldX), tol: 2 }], { maxTicks: 400, idleMs: 9000, stop: died });
    if (died()) return { died: true, why: 'died walking out of the Wilderness' };
    const q = me();
    return { died: false, why: q && wildernessLevel(q.worldZ) === 0 ? null : `still in the Wilderness at the end: ${r?.detail ?? 'walk stopped'}` };
}

if (import.meta.main) {
    const env = process.env, args = process.argv.slice(2);
    const kv = Object.fromEntries(args.filter(a => /^[A-Z_]+=/.test(a)).map(a => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
    const get = (k: string, d: string) => kv[k] ?? env[k] ?? d;
    const names = args.filter(a => !/^[A-Z_]+=/.test(a) && !/^\d+$/.test(a));
    const gangSize = Number(get('SQUAD_GANG', '0'));
    const ours = names.slice(0, names.length - gangSize), gangNames = names.slice(names.length - gangSize);
    if (!ours.length) { console.log('RESULT fail usage: bun scripts/pk-squad.ts <account> [<account> ...] [KEY=value ...]'); process.exit(2); }
    if (ours.some(n => MAIN.has(n.toLowerCase()))) { console.log('RESULT fail the main account is not a squad account'); process.exit(2); }
    const [px, pz] = get('POST', `${SQUAD_POST.x},${SQUAD_POST.z}`).split(',').map(Number);
    const post = { x: px!, z: pz! };
    // ALLOW_SINGLE=1 holds a single-way post (the gang's own, when it does not follow into multi-way): one fight a
    // pair there, the refused accounts take the others (bench 3v3 at the post: 39 kills of 48, 80 HP a kill).
    if (wildernessLevel(post.z) === 0 || (!isMulti(post.x, post.z) && get('ALLOW_SINGLE', '0') !== '1')) { console.log(`RESULT fail post ${post.x},${post.z} is not a multi-way Wilderness tile (ALLOW_SINGLE=1 for a single-way one)`); process.exit(2); }
    const targets = new Set((gangSize ? gangNames : get('TARGETS', GANG.join(',')).split(',')).map(t => t.trim().toLowerCase()).filter(Boolean));
    // A pause holds before any login: a stop file present at the start logs no account in (openBot checks stop files
    // only after its login, and a login puts an account parked in the Wilderness back in the world).
    const paused = ours.filter(n => existsSync(`.practice/stop-${n}`));
    if (existsSync('.practice/stop-pk-squad') || paused.length) { console.log(`RESULT fail stop file present: ${existsSync('.practice/stop-pk-squad') ? 'stop-pk-squad' : paused.map(n => `stop-${n}`).join(' ')}`); process.exit(2); }
    const { openBot, finish } = await import('../packages/core/src/bot');
    let halted: string | undefined;
    const onStop = async (_s: unknown, reason: string) => { if (reason !== 'died') halted ??= reason; };
    // A session that ends with no logout of ours (a dropped connection) stops that account only. openBot's default
    // finishes the process, and in the third live pilot one account's drop logged the other three out in the Wilderness.
    const dropped = new Map<string, string>();
    const onSessionEnd = async (s: Session, detail: string) => { if (!dropped.has(s.name)) { dropped.set(s.name, detail); console.log(`[${s.name}] SQUAD session ended: ${detail}`); } };
    const all: Session[] = [];
    for (const n of names) all.push(await openBot(n, { onStop, onSessionEnd }));
    const squad = all.slice(0, ours.length), gang = all.slice(ours.length);
    // Bench: a gang account is out when it died (a new life, or at the Lumbridge spawn) or left the Wilderness.
    const gangLife = new Map(gang.map(g => [g, g.sdk.getState()?.player?.lifeId] as const));
    const gangDead = (g: Session) => { const p = g.sdk.getState()?.player; return !!p && ((gangLife.get(g) !== undefined && p.lifeId !== gangLife.get(g)) || Math.max(Math.abs(p.worldX - 3222), Math.abs(p.worldZ - 3218)) <= 40); };
    const gangOut = () => gang.length > 0 && gang.every(g => { const p = g.sdk.getState()?.player; return !p || gangDead(g) || wildernessLevel(p.worldZ) === 0; });
    const stopped = () => halted !== undefined || existsSync('.practice/stop-pk-squad') || gangOut();
    const deadline = squad[0]!.tick() + Math.round(Number(get('MAX_MINUTES', '30')) * 100);
    const maxKills = Number(get('MAX_KILLS', '0'));
    let kills = 0;
    const optsJson = get('SQUAD_OPTS', JSON.stringify(SQUAD_OPTS));
    const log = (l: string) => console.log(l);
    // Bench: the gang accounts each fight the nearest of ours in view until they walk out (profile ganker-live).
    // SQUAD_GANG_SPLIT=1: gang account i takes our account i (i mod the squad), as the live gang split on the first
    // pilot's walk-in, in place of the nearest of ours.
    const split = env.SQUAD_GANG_SPLIT === '1';
    const gangRuns = gang.map(async (g, gi) => {
        const mine = squad[gi % squad.length]!.name.toLowerCase();
        const opts = sparOptions('ganker-live', env.SPAR_B_OPTS, kitFrom(g.sdk.getState()?.equipment ?? [], g.sdk.getState()?.inventory ?? []), 1200);
        while (!stopped() && g.tick() < deadline) {
            const me = g.sdk.getState()?.player;
            if (!me || wildernessLevel(me.worldZ) === 0) break;
            const seenOurs = (g.sdk.getState()?.nearbyPlayers ?? []).filter(q => ours.some(n => n.toLowerCase() === q.name.toLowerCase())).sort((a, b) => a.distance - b.distance);
            const prey = split ? seenOurs.find(q => q.name.toLowerCase() === mine) ?? seenOurs[0] : seenOurs[0];
            if (!prey) {
                // SQUAD_GANG_HUNT=1: like the live gang, which the world feed takes to its target (it met the first live
                // pilot 30 tiles from the post), it walks toward the nearest of ours in the Wilderness.
                if (env.SQUAD_GANG_HUNT === '1' && g.tick() % 4 === 0) {
                    const far = (split ? [squad[gi % squad.length]!] : squad).map(q => q.sdk.getState()?.player).filter((q): q is NonNullable<typeof q> => !!q && wildernessLevel(q.worldZ) > 0)
                        .sort((a, b) => Math.max(Math.abs(a.worldX - me.worldX), Math.abs(a.worldZ - me.worldZ)) - Math.max(Math.abs(b.worldX - me.worldX), Math.abs(b.worldZ - me.worldZ)))[0];
                    if (far) void g.sdk.sendWalk(far.worldX, far.worldZ);
                }
                if (!await nextTick(g)) break; continue;
            }
            const r = await fightPlayer(g, prey.name, { ...opts, allies: gangNames.filter(n => n !== g.name).map(n => n.toLowerCase()), cap: Math.max(1, deadline - g.tick()), stop: stopped });
            if (r.outcome === 'died' || r.outcome === 'escaped') break;
            if (!await nextTick(g)) break;
        }
    });
    // The march: the post moves in steps of STEP tiles (default 12) toward its goal, and on to the next step only when
    // every account stands within 4 tiles of the step's tile, or after 60 ticks there. The squad then meets an attacker
    // together: in the first live pilot the gang met the accounts strung out on the walk from Edgeville (about 250 HP
    // lost a kill), and on the bench a squad that went straight to the gang lost about 81 HP a kill, 48 marching.
    const step = Number(get('STEP', '12')), aim = { ...post };
    let route: { x: number; z: number }[] = [], stepAt = 0;
    const centroid = () => { const ps = squad.map(q => q.sdk.getState()?.player).filter((q): q is NonNullable<typeof q> => !!q); return { x: ps.reduce((n, q) => n + q.worldX, 0) / Math.max(1, ps.length), z: ps.reduce((n, q) => n + q.worldZ, 0) / Math.max(1, ps.length) }; };
    const march = (to: { x: number; z: number }) => {
        aim.x = to.x; aim.z = to.z;
        const from = centroid(), entry = isMulti(to.x, to.z) ? multiEntry(from, to) : null;
        route = entry ? [...marchRoute(from, entry, step), ...marchRoute(entry, to, step)] : marchRoute(from, to, step);
        const next = route.shift() ?? to;
        post.x = next.x; post.z = next.z; stepAt = squad[0]!.tick();
        log(`SQUAD march to ${to.x},${to.z} in ${route.length + 1} steps`);
    };
    squad[0]!.onTick(() => {
        if (!route.length) return;
        const close = squad.every(q => { const p = q.sdk.getState()?.player; return !p || wildernessLevel(p.worldZ) === 0 && wildernessLevel(post.z) > 0 ? true : !p || Math.max(Math.abs(p.worldX - post.x), Math.abs(p.worldZ - post.z)) <= 4; });
        if (!close && squad[0]!.tick() - stepAt < 60) return;
        const next = route.shift()!;
        post.x = next.x; post.z = next.z; stepAt = squad[0]!.tick();
    });
    // FOLLOW=1: with no target in view of any of ours for FOLLOW_WAIT ticks (default 30), the squad marches to the
    // meeting tile by the targets that the world feed shows (meetTile), at Wilderness level MAX_WILD or less (default 20).
    let closeRadar: (() => void) | undefined;
    if (get('FOLLOW', '0') === '1') {
        const radar = new Radar(), maxWild = Number(get('MAX_WILD', '20')), wait = Number(get('FOLLOW_WAIT', '30'));
        const { accountServer } = await import('./pk-roam');
        // Bench: the practice engine serves no world feed, so the bench gang's own tiles fill the radar as roster frames.
        if (gang.length) squad[0]!.onTick(() => radar.accept({ t: 'roster', k: squad[0]!.tick(), p: gang.flatMap((g, i) => { const q = g.sdk.getState()?.player; return q ? [[i, g.name, q.worldX, q.worldZ, 0, q.combatLevel] as [number, string, number, number, number, number]] : []; }) }));
        else closeRadar = connectRadar(accountServer(squad[0]!.name), radar);
        let unseen = 0, goal: { x: number; z: number } | null = null;
        squad[0]!.onTick(() => {
            const seen = squad.some(s => (s.sdk.getState()?.nearbyPlayers ?? []).some(q => targets.has(q.name.toLowerCase())));
            unseen = seen ? 0 : unseen + 1;
            if (process.env.FOLLOW_TRACE === '1' && squad[0]!.tick() % 100 === 0) log(`SQUAD follow trace unseen=${unseen} fresh=${radar.fresh()} tracks=${radar.tracks.size}`);
            if (unseen < wait || !radar.fresh() || squad[0]!.tick() % 10 !== 0) return;
            const where = [...radar.tracks.values()].filter(t => targets.has(t.name.toLowerCase()) && wildernessLevel(t.z) > 0);
            const tile = meetTile(where, maxWild);
            if (!tile || (goal && Math.max(Math.abs(goal.x - tile.x), Math.abs(goal.z - tile.z)) <= 4)) return;
            goal = tile;
            log(`SQUAD follow: targets at ${where.map(t => `${t.name} ${t.x},${t.z}`).join(' ')}`);
            march(tile);
        });
    }
    // Bench: SQUAD_DROP_AT=<ticks> closes the first account's session at that tick, as a dropped connection.
    const dropAt = Number(env.SQUAD_DROP_AT ?? 0);
    if (dropAt > 0) { const first = squad[0]!, start = first.tick(); let done = false; squad[1 % squad.length]!.onTick(() => { if (!done && first.tick() - start >= dropAt) { done = true; void first.close(); } }); }
    // Our accounts walk to the post first.
    // Far from the post (MARCH=1, the default): march there; hold() walks each account to the post's current step.
    { const c = centroid(); if (get('MARCH', '1') === '1' && Math.max(Math.abs(c.x - post.x), Math.abs(c.z - post.z)) > step) march({ ...post }); }
    const results = await Promise.all(squad.map(s => hold(s, { targets, post, options: sparOptions(get('SQUAD_PROFILE', 'gang-hunter'), optsJson, kitFrom(s.sdk.getState()?.equipment ?? [], s.sdk.getState()?.inventory ?? []), 1200),
        allies: ours.filter(n => n !== s.name).map(n => n.toLowerCase()), pickup: get('PICKUP', '1') === '1', pull: get('PULL', '1') === '1', aim, trips: Number(get('TRIPS', '10')), deadline,
        stopped: () => stopped() || dropped.has(s.name) || existsSync(`.practice/stop-${s.name}`), killsLeft: () => !maxKills || kills < maxKills, log: l => { if (/PK kill /.test(l)) kills++; log(l); } })));
    await Promise.all(gangRuns);
    closeRadar?.();
    // Live: no account logs out in the Wilderness. The deadline or a stop can end an account's hold mid-fight with
    // its food gone, and a later login on that tile met a PKer: live, KnightRider logged out at the post with 4 HP and
    // died 31 ticks into its next session, skulled, with its whole kit.
    // A dropped account has no session to walk; the rescue below logs it in again.
    if (!gang.length) await Promise.all(squad.map(async (s, i) => { if (dropped.has(s.name)) return; const out = await leaveWilderness(s, results[i]!.died); if (out.died) results[i]!.died = true; if (out.why) log(`[${s.name}] SQUAD ${out.why}`); }));
    for (const r of results) console.log(`SQUAD ${JSON.stringify(r)}`);
    const picked: Record<string, number> = {};
    for (const r of results) for (const [id, n] of Object.entries(r.picked)) picked[id] = (picked[id] ?? 0) + n;
    const sum = (f: (r: SquadStats) => number) => results.reduce((n, r) => n + f(r), 0);
    // RESCUE=1 (default): each dropped account logs in again, eats, and leaves the Wilderness by Camelot Teleport
    // (Wilderness 20 or less, runes held) or a walk to the Edgeville bank; one it cannot get out the RESULT names.
    const stranded: string[] = [];
    if (get('RESCUE', '1') === '1') for (const name of dropped.keys()) {
        try { const r = await rescue(await openBot(name, { onStop: async () => {}, onSessionEnd: async () => {} }), log); if (!r) stranded.push(name); else all.push(r); }
        catch (e) { log(`[${name}] SQUAD rescue failed: ${String(e)}`); stranded.push(name); }
    } else stranded.push(...dropped.keys());
    const ok = halted === undefined && sum(r => r.fights) > 0;
    await finish(all, ok, `squad accounts=${results.length} kills=${sum(r => r.kills)}${gang.length ? ` gangDied=${gang.filter(gangDead).length}` : ''} died=${results.filter(r => r.died).length} taken=${sum(r => r.taken)} trips=${sum(r => r.trips)} picked=${JSON.stringify(picked)}${dropped.size ? ` dropped=${[...dropped.keys()].join(',')}` : ''}${stranded.length ? ` stranded=${stranded.join(',')}` : ''}${halted ? ` halted=${halted}` : ''}`);
}
