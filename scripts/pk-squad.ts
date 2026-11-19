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
//   SQUAD_MAX_DEATHS=1 (the deaths of each account that it recovers from: it respawns at Lumbridge, walks to the bank, wears its starting kit,
//   eats up, restocks and walks back to the post; a death over the limit ends the account's part and the run ends as RESULT fail died)
//   FOLLOW=1 (march to the targets the world feed shows: MAX_WILD=20, FOLLOW_WAIT=30)  MARCH=1 STEP=12 (move together)
//   PULL=1 (attacked on a single-way tile with a multi-way post: walk on into multi-way)
//   RESCUE=1 (a dropped account logs in again at the end and leaves the Wilderness)
// Bench only: SQUAD_GANG=<n> drives the last n accounts as the gang (profile ganker-live against our accounts).
// Live: openBot refuses a non-local server without DEMO_OK=1 and an account of another fleet side. The main account
// is refused. Stop: touch .practice/stop-<account> for one account, or .practice/stop-pk-squad for all.
// First: it sets STALL_TICKS before packages/core/src/bot.ts loads (see the file).
import './pk-squad-stall';
import { existsSync } from 'node:fs';
import type { Session } from '../packages/core/src/inprocess';
import { closeWithin } from '../packages/core/src/bot';
import { killReceiptProof } from '../packages/core/src/kill-receipt';
import { bindActionScope } from '../packages/core/src/action-scope';
import { sessionWalker, walkPath } from '../packages/core/src/walk';
import { attackable, rewearStart, defaultSpec, defaultStunSpec, escapeCastable, fightPlayer, ITEMS, isMulti, nextTick, observePlayer, recordKillLoot, STUNNED_SHOVE_SPOTANIM, wildernessLevel, type FightOptions } from './pk';
import { bankTrip, packOf, pickUp, PICKUP_ITEMS } from './pk-gang';
import { settleKillFeed } from './pk-kill-feed';
import { EDGEVILLE_BANK, eatUp, FOOD_START_FLOOR, maxDeathsOf, rekitAfterDeath } from './pk-hunt';
import { pvpDeathLimits, pvpDeathRefusal, recordPvpDeath } from '../packages/core/src/pvp-deaths';
import { holdProtect, KitSwapper, protectOf, retreatOf, ThreatWatch, threatOptions } from './pk-threat';
import { connectRadar, escapeStep, kitFrom, pickScoutTargetForSquad, Radar, readScoutIntel } from './pk-roam';
import { sparOptions } from './pk-spar';

export const GANG = ['goondelf', 'ligma', 'sugma'];
export const SQUAD_POST = { x: 3067, z: 3640 };
// A member starts the run with at least this share of the food of its pack (live: a member with 20 of 21 sharks is fit
// to fight; one with a few is not). Under it the member stays at the bank and its part of the run ends.
export const SQUAD_FOOD_FLOOR = FOOD_START_FLOOR;
// A member leaves the Wilderness for a bank trip when it stands outside it after it was in it, and once at the start of the
// run (no trip done yet). A member that is still on the first steps of the march, outside the Wilderness, is on its way in:
// a second trip there ran a restock before any fight (live run 2: `"trips":2,"fights":0` for each member; bench of the
// first start fix: `trips=8` in 24 seeds, master `trips=4`).
export const outTripDue = (z: number, enteredWilderness: boolean, tripsDone: number): boolean => wildernessLevel(z) === 0 && (enteredWilderness || tripsDone === 0);
export const squadStartFood = (held: number, packFood: number): { ok: boolean; floor: number } => { const floor = Math.ceil(packFood * SQUAD_FOOD_FLOOR); return { ok: held >= floor, floor }; };
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

// Where a march into a multi-way post enters multi-way: the tile of the multi-way area that is connected to the post (the
// tiles of `multi` that a walk from `to` reaches without leaving them) and nearest `from`. Null when `from` is multi-way
// already or the area has no tile within `radius`. A tile of another multi-way area is no entry: the east zone at
// (3136, 3537) is nearer the Edgeville bank than the post's area (x 3008 to 3071, z 3600 to 3711), and a march that went
// there walked about 170 tiles over single-way ground past the gang's lane (live run 3: one member alone at (3107, 3574)).
export function multiEntry(from: { x: number; z: number }, to: { x: number; z: number }, radius = 150, multi: (x: number, z: number) => boolean = isMulti): { x: number; z: number } | null {
    const fx = Math.round(from.x), fz = Math.round(from.z), tx = Math.round(to.x), tz = Math.round(to.z);
    if (multi(fx, fz) || !multi(tx, tz)) return null;
    const side = 2 * radius + 1, seen = new Uint8Array(side * side), at = (x: number, z: number) => (x - tx + radius) * side + (z - tz + radius);
    const queue: number[] = [tx, tz];
    seen[at(tx, tz)] = 1;
    let best: { x: number; z: number } | null = null, bestD = Infinity;
    for (let i = 0; i < queue.length; i += 2) {
        const x = queue[i]!, z = queue[i + 1]!;
        // Nearest by steps, then the shorter walk across (a tie on steps alone ran along the area's edge).
        const d = Math.max(Math.abs(x - fx), Math.abs(z - fz)) + (Math.abs(x - fx) + Math.abs(z - fz)) / 1000;
        if (d < bestD && wildernessLevel(z) > 0) { best = { x, z }; bestD = d; }
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = x + dx, nz = z + dz;
            if (Math.abs(nx - tx) > radius || Math.abs(nz - tz) > radius || seen[at(nx, nz)] || !multi(nx, nz)) continue;
            seen[at(nx, nz)] = 1; queue.push(nx, nz);
        }
    }
    return best;
}

// The steps of a march from `from` to a multi-way `to`: from outside the Wilderness it goes along the edge to the x of the
// entry first (the last tile with Wilderness level 0), so the single-way ground north of it is crossed straight to the area
// and not on a diagonal past the gang's lane.
export function marchLegs(from: { x: number; z: number }, to: { x: number; z: number }, multi: (x: number, z: number) => boolean = isMulti): { x: number; z: number }[] {
    const entry = multi(Math.round(to.x), Math.round(to.z)) ? multiEntry(from, to, 150, multi) : null;
    if (!entry) return [{ ...to }];
    const edge = wildernessLevel(Math.round(from.z)) === 0 && wildernessLevel(entry.z) > 0 ? { x: entry.x, z: 3519 } : null;
    return [...(edge ? [edge] : []), entry, { ...to }];
}
export function marchPlan(from: { x: number; z: number }, to: { x: number; z: number }, step: number, multi: (x: number, z: number) => boolean = isMulti): { x: number; z: number }[] {
    const route: { x: number; z: number }[] = [];
    let at = from;
    for (const leg of marchLegs(from, to, multi)) { route.push(...marchRoute(at, leg, step)); at = leg; }
    return route;
}

// Whether the march may take its next step: every member is within 4 tiles of the step, or is exempt: a dropped member, one on a
// later bank trip, and one whose hold has ended (it stays at the bank or in Lumbridge and the march would wait for it at every step).
export function marchClose(members: readonly { name: string; at?: { x: number; z: number } }[], post: { x: number; z: number }, exempt: ReadonlySet<string>): boolean {
    return members.every(m => !m.at || exempt.has(m.name) || Math.max(Math.abs(m.at.x - post.x), Math.abs(m.at.z - post.z)) <= 4);
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

// Work can stop locally even when a broken transport never confirms its end. Logout keeps the raw session.
const workSessions = new WeakMap<Session, { session: Session; cancel(reason: string): void }>();
export function squadWorkSession(raw: Session): Session {
    let work = workSessions.get(raw);
    if (!work) {
        let cancel!: (end: { reason: string }) => void;
        const stopped = new Promise<{ reason: string }>(resolve => { cancel = resolve; });
        work = { session: { ...raw, ended: Promise.race([raw.ended, stopped]) }, cancel: reason => cancel({ reason }) };
        workSessions.set(raw, work);
    }
    return work.session;
}
const cancelSquadWork = (raw: Session, reason: string) => { squadWorkSession(raw); workSessions.get(raw)!.cancel(reason); };

export async function stopSquadSession(raw: Session, reason: string, halt: (reason: string) => void, closeMs = 1000, ended?: (raw: Session, reason: string) => unknown): Promise<void> {
    if (reason === 'died') return;
    // A member with no progress for the stall limit (no xp, items, dialog or journey: one whose bank trip failed stands
    // idle at the bank) ends its own session only. The others go on. The session is closed with a stop already asked
    // for, so openBot reports no session end (packages/core/src/bot.ts watchUnexpectedEnd): `ended` records the member
    // as dropped, and the rescue at the end takes it out of the Wilderness. Live: one idle member halted a squad of
    // four that was killing.
    if (/^no progress:/.test(reason)) {
        cancelSquadWork(raw, reason);
        await closeWithin([raw], closeMs);
        await ended?.(raw, reason);
        return;
    }
    halt(reason);
    if (/^tick stream stalled:/.test(reason)) {
        cancelSquadWork(raw, reason);
        await closeWithin([raw], closeMs);
    }
}
// The stop handlers of a squad: a member whose session ends with no logout of ours (a dropped connection, or a stall
// that ends its own session) goes into `dropped`, and the rescue at the end takes it out of the Wilderness.
export function squadStopHandlers(halt: (detail: string) => void, dropped: Map<string, string>, log: (line: string) => void = line => console.log(line)) {
    const onSessionEnd = async (s: Session, detail: string) => { if (!dropped.has(s.name)) { dropped.set(s.name, detail); log(`[${s.name}] SQUAD session ended: ${detail}`); } };
    const onStop = (s: Session, reason: string) => stopSquadSession(s, reason, halt, 1000, onSessionEnd);
    return { onStop, onSessionEnd };
}
// A kill line of the fight loop, not its proof lines (`PK kill receipt ...`, `PK kill feed ...`).
export const isKillLine = (line: string) => /PK kill (?!receipt |feed )\S+ after \d+ ticks/.test(line);
export const squadPaused = (name: string, exists: (path: string) => boolean = existsSync) => exists('.practice/stop-pk-squad') || exists(`.practice/stop-${name}`);

// Connected members share one monotonic coordination clock after a member disconnects.
export function watchSquadTicks(squad: readonly Session[], dropped: (name: string) => boolean, onTick: (tick: number) => void): () => void {
    let last = -1;
    const off = squad.map(s => s.onTick(() => {
        if (dropped(s.name)) return;
        const tick = s.tick();
        if (tick <= last) return;
        last = tick;
        onTick(tick);
    }));
    return () => { for (const stop of off) stop(); };
}
// Best teleport escape below Wilderness 20: Camelot Teleport (1174), else Varrock Teleport (1164), counting worn staves.
export function squadEscapeSpell(z: number, carried: readonly { id: number; count: number }[], wornIds: readonly number[], magic: number): number | null {
    if (wildernessLevel(z) > 20) return null;
    for (const spell of [1174, 1164]) if (escapeCastable(spell, carried, wornIds, magic)) return spell;
    return null;
}

// The pull (hold): the distance to the march's goal within which an attacked account on single-way ground walks on into multi-way,
// and the ticks that a stretch of it may take.
export const PULL_RANGE = 100, PULL_MAX_TICKS = 60;
export const pullDistance = (p: { worldX: number; worldZ: number }, aim: { x: number; z: number }) => Math.max(Math.abs(p.worldX - aim.x), Math.abs(p.worldZ - aim.z));
export const pullTicks = (distance: number) => Math.min(PULL_MAX_TICKS, 20 + Math.ceil(distance / 2));

// A dropped account logged in again: eat to near full, then teleport where it can (Camelot or Varrock below Wilderness
// 20, counting worn staves), else walk to the nearer bank (bankNear). The session when it ends out of the Wilderness, else null.
export async function rescue(s: Session, log: (l: string) => void, stopped: () => boolean = () => false): Promise<Session | null> {
    const me = () => s.sdk.getState()?.player;
    const tick = async () => !stopped() && await nextTick(s) && !stopped();
    for (let i = 0; i < 3; i++) if (!await tick()) return null;
    const start = me();
    if (!start) return null;
    log(`[${s.name}] SQUAD rescue at ${start.worldX},${start.worldZ} wild ${wildernessLevel(start.worldZ)} hp ${start.hp}`);
    if (wildernessLevel(start.worldZ) > 0) {
        for (let i = 0; i < 6; i++) {
            const q = me(), food = s.sdk.getInventory().find(f => f.optionsWithIndex.some(op => /^eat$/i.test(op.text))), op = food?.optionsWithIndex.find(x => /^eat$/i.test(x.text));
            if (stopped()) return null;
            if (!q || !food || !op || q.hp >= q.maxHp - 20) break;
            await s.direct({ type: 'useInventoryItem', slot: food.slot, optionIndex: op.opIndex, reason: 'SDK' });
            for (let t = 0; t < 3; t++) if (!await tick()) return null;
        }
        const st = s.sdk.getState(), magic = st?.skills.find(k => k.name === 'Magic')?.level ?? 1;
        const escapeSpell = st ? squadEscapeSpell(start.worldZ, st.inventory ?? [], s.sdk.getEquipment().map(e => e.id), magic) : null;
        if (escapeSpell !== null)
            for (let i = 0; i < 3 && wildernessLevel(me()?.worldZ ?? 0) > 0; i++) { if (stopped()) return null; await s.direct({ type: 'clickComponent', componentId: escapeSpell, reason: 'SDK' }); for (let t = 0; t < 6; t++) if (!await tick()) return null; }
        if (stopped()) return null;
        if (wildernessLevel(me()?.worldZ ?? 0) > 0) await walkPath(await sessionWalker(s), [{ ...bankNear(me()?.worldX ?? start.worldX), tol: 2 }], { maxTicks: 500, idleMs: 9000, stop: stopped });
    }
    const end = me();
    log(`[${s.name}] SQUAD rescue ends at ${end?.worldX},${end?.worldZ} wild ${wildernessLevel(end?.worldZ ?? 0)}`);
    return !stopped() && end && wildernessLevel(end.worldZ) === 0 ? s : null;
}

// A rescue login belongs to final logout even when its retreat fails or throws.
export async function rescueDropped(names: Iterable<string>, sessions: Session[], open: (name: string, onStop: (s: Session, reason: string) => Promise<void>) => Promise<Session>, log: (line: string) => void,
    retreat: typeof rescue = rescue, paused: (name: string) => boolean = squadPaused): Promise<string[]> {
    const stranded: string[] = [];
    for (const name of names) {
        if (paused(name)) { log(`[${name}] SQUAD rescue paused`); stranded.push(name); continue; }
        let interrupted = false, watch: ReturnType<typeof setInterval> | undefined;
        const stopped = () => interrupted || paused(name);
        try {
            const session = await open(name, async (s, reason) => {
                interrupted = true;
                cancelSquadWork(s, reason);
                await stopSquadSession(s, reason, () => {});
            });
            sessions.push(session);
            const work = squadWorkSession(session);
            watch = setInterval(() => { if (stopped()) cancelSquadWork(session, 'squad rescue stopped'); }, 25);
            const guarded: Session = { ...work, direct: action => {
                const check = () => { if (stopped()) throw Error('squad rescue stopped'); };
                check(); bindActionScope(action, check);
                return session.direct(action);
            } };
            if (stopped() || !await retreat(guarded, log, stopped)) stranded.push(name);
        } catch (error) { log(`[${name}] SQUAD rescue failed: ${String(error)}`); stranded.push(name); }
        finally { clearInterval(watch); }
    }
    return stranded;
}

// A later login refusal still settles every earlier login before the failed result.
export async function openSquad(names: readonly string[], open: (name: string) => Promise<Session>,
    fail: (sessions: Session[], detail: string) => Promise<never>): Promise<Session[]> {
    const sessions: Session[] = [];
    let opening = '';
    try {
        for (const name of names) { opening = name; sessions.push(await open(name)); }
    } catch (error) { return fail(sessions, `squad startup ${opening}: ${String(error)}`); }
    return sessions;
}

export type SquadStats = { name: string; fights: number; pulls: number; kills: number; trips: number; died: boolean; picked: Record<string, number>; taken: number; receipts: string[];
    // The kills of the account that were interlopers (players that the squad did not come for, the threat radar), counted when the watch is on.
    interlopers?: number;
    // The deaths of the account in the run, and the ones that it recovered from (re-kit, restock and the walk back to the post).
    // `died` is true for a death that it did not recover from.
    deaths: number; rekits: number };

// The target of the squad: the target account in view with the lowest health bar, the nearest on a tie; one the game
// refused ("I'm already under attack.", "Someone else is already fighting your opponent.") leaves the pick for 8 ticks.
// `me`: the squad account; a target is taken only where the game lets it attack (both in the Wilderness, the combat gap
// within the shallower level: pk.ts attackable). A target that walked out of the Wilderness held the squad at its edge.
export function squadTarget<P extends { name: string; index: number; distance: number; z?: number; combatLevel?: number }>(view: readonly P[], targets: ReadonlySet<string>, health: (p: P) => number, skip: ReadonlySet<string> = new Set(), me?: { z: number; combatLevel: number }): P | undefined {
    return view.filter(p => targets.has(p.name.toLowerCase()) && !skip.has(p.name.toLowerCase()) && (!me || p.z === undefined || attackable(me, { z: p.z, combatLevel: p.combatLevel ?? me.combatLevel })))
        .sort((a, b) => health(a) - health(b) || a.distance - b.distance)[0];
}

// Multi-way pile & anti-PJ target focus: prioritizes stunned targets, then lowest HP%, scouted priority target, and filters out busy single-way fights.
export function pickSquadFocus<P extends { name: string; index: number; distance: number; x?: number; z?: number; combatLevel?: number; inCombat?: boolean }>(opts: {
    view: readonly P[];
    targets: ReadonlySet<string>;
    health: (p: P) => number;
    skip?: ReadonlySet<string>;
    me?: { x: number; z: number; combatLevel: number };
    inMulti?: boolean;
    stunned?: ReadonlySet<string>;
    // Players that come first (the interlopers of the threat radar: they attack us or close in).
    priority?: ReadonlySet<string>;
    activeFocus?: string;
    scoutTarget?: string;
}): P | undefined {
    const { view, targets, health, skip = new Set(), me, inMulti, stunned = new Set(), priority = new Set<string>(), activeFocus, scoutTarget } = opts;
    const active = activeFocus?.toLowerCase();
    const scout = scoutTarget?.toLowerCase();
    const eligible = view.filter(p => {
        const key = p.name.toLowerCase();
        if (!targets.has(key) || skip.has(key)) return false;
        if (me && p.z !== undefined && !attackable(me, { z: p.z, combatLevel: p.combatLevel ?? me.combatLevel })) return false;
        // Anti-PJ in single-way: avoid hopping onto someone already actively engaged by another attacker unless it's our own active focus.
        const multiTile = inMulti !== undefined ? inMulti : (p.x !== undefined && p.z !== undefined ? isMulti(p.x, p.z) : true);
        if (!multiTile && p.inCombat && key !== active) return false;
        return true;
    });
    return eligible.sort((a, b) => {
        const ak = a.name.toLowerCase(), bk = b.name.toLowerCase();
        return Number(priority.has(bk)) - Number(priority.has(ak))
            || Number(stunned.has(bk)) - Number(stunned.has(ak))
            || health(a) - health(b)
            || Number(bk === scout) - Number(ak === scout)
            || a.distance - b.distance;
    })[0];
}

// Coordinated squad escape fallback when outnumbered in multi-combat or out of food below threshold.
export function squadFallbackPlan(opts: {
    z: number;
    hp: number;
    maxHp: number;
    foodCount: number;
    enemyCount: number;
    allyCount: number;
    inMulti: boolean;
    hasGlory: boolean;
    hasTeleport: boolean;
}): 'hold' | 'out' | 'glory' | 'teleport' | 'run' {
    const wild = wildernessLevel(opts.z);
    if (wild === 0) return 'out';
    const outnumbered = opts.inMulti && opts.enemyCount - opts.allyCount >= 2 && opts.hp <= opts.maxHp * 0.55;
    const dry = opts.foodCount <= 0 && opts.hp <= opts.maxHp * 0.6;
    if (!outnumbered && !dry) return 'hold';
    return escapeStep(wild, { glory: opts.hasGlory, teleport: opts.hasTeleport });
}

// SQUAD_FREEZE_ARMOUR=strip|torso|keep: what a freeze takes off (pk.ts freezeArmour), and SQUAD_PROTECT_ITEM=on|off|skulled: Protect Item (pk.ts protectItem, 'skulled' is on
// only while our own skull shows). They win over the profile and SQUAD_OPTS. A value that is not listed throws.
export function squadFightOverrides(get: (name: string, fallback: string) => string): Partial<FightOptions> {
    const out: Partial<FightOptions> = {};
    const armour = get('SQUAD_FREEZE_ARMOUR', '');
    if (armour) { if (!['strip', 'torso', 'keep'].includes(armour)) throw new Error(`SQUAD_FREEZE_ARMOUR is strip, torso or keep, got ${armour}`); out.freezeArmour = armour as 'strip' | 'torso' | 'keep'; }
    const item = get('SQUAD_PROTECT_ITEM', '');
    if (item) { if (!['on', 'off', 'skulled'].includes(item)) throw new Error(`SQUAD_PROTECT_ITEM is on, off or skulled, got ${item}`); out.protectItem = item === 'skulled' ? 'skulled' : item === 'on'; }
    return out;
}

// The end of a squad run: its ok and the detail of its RESULT line. A squad with a death is not a finished squad: the supervisor reads
// `RESULT fail died` as a death and does not start the squad again with an account that holds no kit (packages/practice/src/supervise.ts and
// supervise-host.ts classify), and scripts/squad-watch.ts reads it as a death. `diedAccounts=A,B` names the accounts that died, early in the line
// (the supervisor logs 200 characters of it): scripts/swarm.ts gives the died end to those accounts only.
export function squadEnd(o: { accounts: number; kills: number; gangDied?: number; deaths: number; taken: number; trips: number; fights: number; picked: Record<string, number>; dropped: readonly string[]; stranded: readonly string[]; halted?: string; receiptProof?: string; rekits?: number; interlopers?: number; diedAccounts?: readonly string[] }): { ok: boolean; detail: string } {
    const ok = o.halted === undefined && o.stranded.length === 0 && o.fights > 0 && o.deaths === 0;
    return { ok, detail: `${o.deaths > 0 ? 'died ' : ''}squad accounts=${o.accounts}${o.deaths > 0 && o.diedAccounts?.length ? ` diedAccounts=${o.diedAccounts.map(n => n.replace(/ /g, '_')).join(',')}` : ''} kills=${o.kills}${o.receiptProof ? ` ${o.receiptProof}` : ''}${o.gangDied !== undefined ? ` gangDied=${o.gangDied}` : ''} died=${o.deaths}${o.rekits ? ` rekits=${o.rekits}` : ''}${o.interlopers !== undefined ? ` attackerKills=${o.interlopers}` : ''} taken=${o.taken} trips=${o.trips} picked=${JSON.stringify(o.picked)}${o.dropped.length ? ` dropped=${o.dropped.join(',')}` : ''}${o.stranded.length ? ` stranded=${o.stranded.join(',')}` : ''}${o.halted ? ` halted=${o.halted}` : ''}` };
}
// One account of the squad: hold the post, fight the squad's target, pick up, bank and come back.
export async function hold(s: Session, o: { targets: ReadonlySet<string>; post: { x: number; z: number }; aim?: { x: number; z: number }; options: FightOptions; allies: readonly string[]; pickup: boolean; pull?: boolean; tripping?: Set<string>;
    stunShareFor?: (target: string) => FightOptions['stunShare'];
    // The freeze of each target is shared by the squad: the members stagger their casts (SQUAD_FREEZE_SHARE=1; pk.ts freezeShare).
    freezeShareFor?: (target: string) => FightOptions['freezeShare']; burstOnStun?: boolean; stunSpec?: FightOptions['stunSpec'];
    trips: number; deadline: number; stopped: () => boolean; killsLeft: () => boolean; log: (l: string) => void;
    // Deaths that the account recovers from in the run (default 0: a death ends the account's part).
    // `onDeath` is called for each death of the account, at its tile (the death ledger of packages/core/src/pvp-deaths.ts).
    // `run`: the deaths of all the members in the run. The death that brings `deaths` to `limit` is not recovered (PVP_DEATH_LIMITS.perRun).
    maxDeaths?: number; onDeath?: (near: { x: number; z: number } | null) => void; run?: { deaths: number; limit: number };
    // The threat radar of the squad (scripts/pk-threat.ts): a protect prayer for the style of a threat, and a retreat when it outclasses the squad.
    threats?: ThreatWatch }): Promise<SquadStats> {
    const stats: SquadStats = { name: s.name, fights: 0, pulls: 0, kills: 0, trips: 0, died: false, picked: {}, taken: 0, receipts: [], deaths: 0, rekits: 0 };
    const st = s.sdk.getState(), me = () => s.sdk.getState()?.player;
    let life0 = st?.player?.lifeId, lastTile: { x: number; z: number } | null = null;
    // A death: a new life, or the tile of the Lumbridge respawn.
    const diedNow = (q: { lifeId?: number; worldX: number; worldZ: number }) => (life0 !== undefined && q.lifeId !== life0) || Math.max(Math.abs(q.worldX - 3222), Math.abs(q.worldZ - 3218)) <= 40;
    // A retreat that ends with no session is a death only when the account died: a stop or a walk that did not get out leaves it alive.
    const retreatEnded = () => { const q = me(); if (q && diedNow(q)) stats.died = true; else o.log(`[${s.name}] SQUAD retreat ended with the account alive${q ? ` at ${q.worldX},${q.worldZ}` : ''}`); };
    const wornAtStart = (st?.equipment ?? []).map(e => ({ id: e.id, count: e.count ?? 1 }));
    const pack = packOf(st?.inventory ?? [], st?.equipment ?? []), kit = kitFrom(st?.equipment ?? [], st?.inventory ?? []);
    const ammo = (st?.equipment ?? []).find(e => /arrow|bolt/i.test(e.name))?.id;
    const wanted = new Set([...PICKUP_ITEMS, ...(ammo ? [ammo] : [])]);
    const going = () => !o.stopped() && s.tick() < o.deadline && o.killsLeft();
    const bankRun = bankTrip(bankNear(o.post.x), o.post, pack, kit, () => !going());
    // A member on a later trip does not hold the march (it is out of the Wilderness on purpose); one on the first trip does,
    // so the squad leaves the bank together.
    const trip = async (a: Session, fresh = false) => {
        if (!fresh) o.tripping?.add(s.name);
        try { return await bankRun(a, fresh); } finally { o.tripping?.delete(s.name); }
    };
    const walker = await sessionWalker(s);
    // A death: with deaths left (SQUAD_MAX_DEATHS, `maxDeaths`) the account respawns, walks to the bank, wears its starting kit and eats up
    // (rekitAfterDeath), restocks its pack and walks back to the post. It returns false when it is over the limit or the re-kit stopped.
    const recover = async (): Promise<boolean> => {
        stats.deaths++;
        try { o.onDeath?.(lastTile); } catch (error) { o.log(`[${s.name}] SQUAD death ledger write failed: ${String(error)}`); }
        if (o.run && ++o.run.deaths >= o.run.limit) { o.log(`[${s.name}] SQUAD death ${o.run.deaths} of the run reaches the run limit of ${o.run.limit}`); return false; }
        if (stats.deaths > (o.maxDeaths ?? 0)) { o.log(`[${s.name}] SQUAD death ${stats.deaths}: over the limit of ${o.maxDeaths ?? 0}`); return false; }
        const rec = await rekitAfterDeath(s, { lifeBefore: life0, diedNear: lastTile, wornAtStart, stop: () => !going(), log: l => o.log(`[${s.name}] ${l}`), bank: bankNear(o.post.x) });
        if (rec.rekit !== 'ok') { o.log(`[${s.name}] SQUAD no re-kit: ${rec.rekit}`); return false; }
        life0 = rec.lifeAfter ?? life0;
        const fault = await trip(s);
        if (fault) { o.log(`[${s.name}] SQUAD re-kit trip: ${fault}`); return false; }
        stats.rekits++;
        o.log(`[${s.name}] SQUAD re-kitted after a death (${stats.rekits})`);
        return true;
    };
    let lastHp = me()?.hp ?? 0, seenMessage = 0, refusedAt = -100, pullSince = -1;
    // The threat radar's armour swap (the worn items that it took off, to wear again) and its single-way hold (no pull and no walk back to the
    // multi-way post until this tick).
    const swapper = new KitSwapper(), tickOf = () => nextTick(s);
    // A fight stops when the radar decides a retreat or a single-way move: a member inside a fight does not read the decision, and against a team the squad's
    // fights are the whole run, so without this stop a decision would not reach a member that is fighting.
    const radarMove = () => !!o.threats?.act && o.threats.step(s.tick()).actions.some(a => a.kind === 'retreat' || a.kind === 'single-way');
    let singleUntil = -1;
    const skip = new Map<string, number>();
    let enteredWilderness = false;
    const unwatch = s.onTick(() => {
        const hp = me()?.hp; if (hp !== undefined) { if (hp < lastHp) stats.taken += lastHp - hp; lastHp = hp; }
        for (const m of s.sdk.getState()?.gameMessages ?? []) { const id = m.observationId ?? m.tick; if (id <= seenMessage) continue; seenMessage = id; if (/already under attack|already fighting your opponent/i.test(m.text)) refusedAt = s.tick(); }
    });
    try {
        while (going()) {
            const p = me();
            if (!p) { if (!await nextTick(s)) break; continue; }
            if (diedNow(p)) {
                o.log(`[${s.name}] SQUAD died`);
                if (await recover()) continue;
                stats.died = true; break;
            }
            lastTile = { x: p.worldX, z: p.worldZ };
            // Out of the Wilderness (a walk out, a teleport): to the bank and back to the post.
            if (wildernessLevel(p.worldZ) > 0) enteredWilderness = true;
            if (outTripDue(p.worldZ, enteredWilderness, stats.trips)) {
                enteredWilderness = false;
                if (stats.trips >= o.trips) { o.log(`[${s.name}] SQUAD no trips left`); break; }
                stats.trips++;
                // The first visit, before any fight, is at the pack that the account logged in with: nothing is banked, so
                // no shark of the pack has to come back from the bank (`fresh`). A restock there asked for the whole pack
                // again after one meal of the eat-up. The member eats to full first (`eatUp`), and the fresh trip fills
                // the slots of the meals from the bank.
                const first = stats.fights === 0 && stats.trips === 1;
                if (first) await eatUp(s, () => o.stopped());
                // Eat up first: a teleport out (Camelot) leaves a long walk, and the gang's daggers poison.
                else for (let i = 0; i < 12 && !o.stopped(); i++) {
                    const q = me(), food = s.sdk.getInventory().find(f => f.optionsWithIndex.some(op => /^eat$/i.test(op.text)));
                    const op = food?.optionsWithIndex.find(x => /^eat$/i.test(x.text));
                    if (!q || !food || !op || q.hp >= q.maxHp - 20) break;
                    await s.sdk.sendUseItem(food.slot, op.opIndex);
                    for (let t = 0; t < 3; t++) if (!await nextTick(s)) break;
                }
                const fault = await trip(s, first);
                const after = me();
                if (after && ((life0 !== undefined && after.lifeId !== life0) || Math.max(Math.abs(after.worldX - 3222), Math.abs(after.worldZ - 3218)) <= 40)) { o.log(`[${s.name}] SQUAD died on a bank trip`); if (await recover()) continue; stats.died = true; break; }
                if (fault) { o.log(`[${s.name}] SQUAD bank trip: ${fault}`); break; }
                if (first) {
                    // A member one meal short starts with what it holds; one under the floor stays out of the Wilderness.
                    const held = s.sdk.getInventory().filter(f => f.optionsWithIndex.some(op => /^eat$/i.test(op.text))).length, start = squadStartFood(held, pack.food);
                    if (!start.ok) { o.log(`[${s.name}] SQUAD start: ${held} food held, under the floor of ${start.floor} of ${pack.food}`); break; }
                }
                continue;
            }
            const now = s.tick();
            for (const [k, until] of skip) if (until <= now) skip.delete(k);
            // The threat radar: each decision is logged with the record of the player that caused it (ThreatWatch). With `act` off it only logs.
            const threat = o.threats?.step(now);
            const protect = threat && o.threats!.act ? protectOf(threat.actions, s.name) : null;
            const threatRetreat = threat && o.threats!.act ? retreatOf(threat.actions) : null;
            if (threatRetreat) {
                o.threats!.acted(now);
                o.log(`[${s.name}] SQUAD threat retreat: ${threatRetreat}`);
                const retreated = await rescue(s, o.log, o.stopped);
                if (!retreated) { retreatEnded(); break; }
                continue;
            }
            if (threat && o.threats!.act) {
                // A team on a multi-way tile: to the nearest single-way tile (a walk that fails is the retreat), and stay there while it lasts.
                const single = threat.actions.find(a => a.kind === 'single-way') as Extract<typeof threat.actions[number], { kind: 'single-way' }> | undefined;
                if (single) {
                    singleUntil = now + 120;
                    if (Math.max(Math.abs(p.worldX - single.to.x), Math.abs(p.worldZ - single.to.z)) > 2) {
                        o.threats!.acted(now);
                        o.log(`[${s.name}] SQUAD threat single-way: ${single.reason}, to ${single.to.x},${single.to.z}`);
                        const walked = await walkPath(walker, [{ ...single.to, tol: 2 }], { maxTicks: 40, idleMs: 9000, stop: () => !going() });
                        if (!walked.ok) { o.log(`[${s.name}] SQUAD threat single-way walk failed, retreat`); if (!await rescue(s, o.log, o.stopped)) { stats.died = true; break; } }
                        continue;
                    }
                }
                // The armour that defends better against the threat's style, from the pack: worn before the next fight, and put back after the threat has been gone for 60 ticks.
                if (await swapper.step(s, threat.actions, now, tickOf, o.log)) continue;
            }
            const view = s.sdk.getState()?.nearbyPlayers ?? [];
            const health = (q: { index: number }) => { const seen = observePlayer(s.client, q.index); return seen && seen.totalHealth > 0 ? seen.health / seen.totalHealth : 1; };
            const stunned = new Set(view.filter(q => observePlayer(s.client, q.index)?.spotanim === STUNNED_SHOVE_SPOTANIM).map(q => q.name.toLowerCase()));
            const self = { x: p.worldX, z: p.worldZ, combatLevel: p.combatLevel };
            const alliesSet = new Set(o.allies.map(a => a.toLowerCase()));
            const enemyCount = view.filter(q => !alliesSet.has(q.name.toLowerCase()) && q.distance <= 10 && attackable(self, { z: q.z, combatLevel: q.combatLevel })).length;
            const allyCount = view.filter(q => alliesSet.has(q.name.toLowerCase()) && q.distance <= 10).length;
            const inv = s.sdk.getInventory();
            const fallback = squadFallbackPlan({
                z: p.worldZ, hp: p.hp, maxHp: p.maxHp,
                foodCount: inv.filter(f => f.optionsWithIndex.some(op => /^eat$/i.test(op.text))).length,
                enemyCount, allyCount, inMulti: isMulti(p.worldX, p.worldZ),
                hasGlory: [...inv, ...s.sdk.getEquipment()].some(i => /^amulet of glory\([1-4]\)$/i.test(i.name)),
                hasTeleport: !!squadEscapeSpell(p.worldZ, inv, s.sdk.getEquipment().map(e => e.id), s.sdk.getSkill('Magic')?.level ?? 1),
            });
            if (fallback !== 'hold' && fallback !== 'out') {
                o.log(`[${s.name}] SQUAD coordinated fallback (${fallback}) hp=${p.hp} enemies=${enemyCount} allies=${allyCount}`);
                const retreated = await rescue(s, o.log, o.stopped);
                if (!retreated) { retreatEnded(); break; }
                continue;
            }
            // Interlopers (dangerous players that are not the squad's targets) become targets, first: lowest health first among them. When they are dead or gone
            // the squad goes back to its own targets.
            const interlopers = new Set((threat && o.threats!.act ? threat.interlopers : []).map(n => n.toLowerCase()));
            const target = pickSquadFocus({ view, targets: interlopers.size ? new Set([...o.targets, ...interlopers]) : o.targets, priority: interlopers, health, skip: new Set(skip.keys()), me: self, inMulti: isMulti(p.worldX, p.worldZ), stunned });
            if (!target) {
                // No prayer while it waits: an active prayer drains with no fight loop to flick it (in one live meeting
                // our prayer ran out at about tick 730), and the fight loop puts them on again. One input each 3 ticks.
                // A threat that can hit us keeps the protect prayer of its style on (holdProtect), at the cost of the drain.
                if (protect) holdProtect(s, protect, s.tick());
                else if (s.tick() % 3 === 0) for (const [i, on] of (s.sdk.getState()?.prayers.activePrayers ?? []).entries()) if (on) void s.sdk.sendTogglePrayer(i);
                // Back to the post between fights.
                // At least a tick each pass: a walk to a step that cannot be reached fails at once.
                if (now >= singleUntil && Math.max(Math.abs(p.worldX - o.post.x), Math.abs(p.worldZ - o.post.z)) > 2) await walkPath(walker, [{ ...o.post, tol: 2 }], { maxTicks: 60, idleMs: 9000, stop: () => !going() || !!squadTarget(s.sdk.getState()?.nearbyPlayers ?? [], o.targets, health, new Set(), self) });
                if (!await nextTick(s)) break;
                continue;
            }
            // Pull: on a single-way tile with the post multi-way (and within PULL_RANGE tiles), walk on into multi-way and eat on the
            // way instead of fighting there; on a single-way tile the game lets one attacker at a time on each account,
            // so the squad cannot concentrate.
            // The pull aims at the march's goal (`aim`), not its current step, which can be a single-way tile.
            const aim = o.aim ?? o.post;
            // A stretch of pull is 20 ticks and half a tick a tile of the distance at most, and 60 ticks at the most: an account that cannot get into multi-way
            // (stood on, blocked) fights where it is; one stuck pulling took hits without an answer for hundreds of ticks.
            if (isMulti(p.worldX, p.worldZ)) pullSince = -1;
            if (o.pull && now >= singleUntil && !isMulti(p.worldX, p.worldZ) && isMulti(aim.x, aim.z) && pullDistance(p, aim) <= PULL_RANGE
                && (pullSince < 0 || s.tick() - pullSince < pullTicks(pullDistance(p, aim)))) {
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
            const stunShare = o.stunShareFor?.(target.name.toLowerCase());
            const freezeShare = o.freezeShareFor?.(target.name.toLowerCase());
            const r = await fightPlayer(s, target.name, {
                ...o.options,
                ...(o.threats?.act ? { threatPrayer: () => protectOf(o.threats!.step(s.tick()).actions, s.name) } : {}),
                ...(stunShare ? { stunShare } : {}),
                ...(freezeShare ? { freezeShare } : {}),
                ...(o.burstOnStun !== undefined ? { burstOnStun: o.burstOnStun } : {}),
                ...(o.stunSpec ? { stunSpec: o.stunSpec } : {}),
                allies: o.allies, cap: Math.max(1, o.deadline - s.tick()), stop: () => !going() || refusedAt > began || radarMove(),
                log: l => o.log(`[${s.name}] ${l}`),
            });
            // The armour that a freeze stripped goes back on (pk.ts rewearStart).
            if (going() && r.outcome !== 'session ended') await rewearStart(s, wornAtStart.map(w => w.id), l => o.log(`[${s.name}] ${l}`));
            if (refusedAt > began) skip.set(target.name.toLowerCase(), s.tick() + 8);
            const gone = !(s.sdk.getState()?.nearbyPlayers ?? []).some(q => q.name.toLowerCase() === target.name.toLowerCase());
            if (r.outcome === 'kill') { stats.kills++; if (interlopers.has(target.name.toLowerCase())) stats.interlopers = (stats.interlopers ?? 0) + 1; }
            if (r.receipt) stats.receipts.push(r.receipt);
            if (o.pickup && (r.outcome === 'kill' || gone)) {
                const got = await pickUp(s, wanted, { radius: 3, maxTicks: 30, wait: 6, stop: o.stopped });
                recordKillLoot(r, got);
                for (const [id, n] of Object.entries(got)) stats.picked[id] = (stats.picked[id] ?? 0) + n;
            }
            if (r.outcome === 'died') { if (await recover()) continue; stats.died = true; break; }
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
    if (!p) return { died: false, why: 'player state unavailable at squad exit' };
    if (diedBefore || wildernessLevel(p.worldZ) === 0) return { died: false, why: null };
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
    // The general loot watcher (packages/core/src/bot.ts) walked members up to 11 tiles out of the narrow multi-way strip for one arrow:
    // the squad picks up by its own rule (PICKUP). LOOT_WATCH=1 in the environment turns it back on.
    env.LOOT_WATCH ??= '0';
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
    // The death ledger: a squad whose account or members died too often in the last 24 h on a live server does not start. The
    // supervisor reads `RESULT fail died` as a death, so the swarm holds it until a person clears the ledger.
    // The server comes from bot.env, which openBot restores from the vault later: the ledger restores it first. An unreadable bot.env is a fail line.
    const { accountServerBeforeLogin } = await import('./pk-roam');
    let squadServer = '';
    try { squadServer = accountServerBeforeLogin(ours[0]!); } catch (e) { console.log(`RESULT fail no server for ${ours[0]}: ${String(e).replace(/\s+/g, ' ').slice(0, 160)}`); process.exit(2); }
    const runDeaths = { deaths: 0, limit: pvpDeathLimits().perRun };
    const ledgerRefusal = pvpDeathRefusal({ accounts: ours, server: squadServer });
    if (ledgerRefusal) { console.log(`RESULT fail died ${ledgerRefusal}`); process.exit(1); }
    const paused = ours.filter(n => existsSync(`.practice/stop-${n}`));
    if (existsSync('.practice/stop-pk-squad') || paused.length) { console.log(`RESULT fail stop file present: ${existsSync('.practice/stop-pk-squad') ? 'stop-pk-squad' : paused.map(n => `stop-${n}`).join(' ')}`); process.exit(2); }
    // The settings are checked before any account logs in: a bad one is a fail line with nobody in the Wilderness (squadFightOverrides: the plain settings for the
    // options that a hosted bench A/B changes; threatOptions: SQUAD_THREAT_OPTS and the SQUAD_THREAT_* settings).
    let fightOverrides: Partial<FightOptions>, threatConfig: ReturnType<typeof threatOptions> | undefined;
    try {
        fightOverrides = squadFightOverrides(get);
        threatConfig = get('SQUAD_THREAT', '0') === '1' ? threatOptions(get('SQUAD_THREAT_OPTS', ''), get) : undefined;
    } catch (e) { console.log(`RESULT fail ${e instanceof Error ? e.message : e}`); process.exit(2); }
    const { openBot, finish } = await import('../packages/core/src/bot');
    let halted: string | undefined;
    // A session that ends with no logout of ours (a dropped connection) stops that account only. openBot's default
    // finishes the process, and in the third live pilot one account's drop logged the other three out in the Wilderness.
    const dropped = new Map<string, string>();
    const { onStop, onSessionEnd } = squadStopHandlers(detail => { halted ??= detail; }, dropped);
    const all = await openSquad(names, name => openBot(name, { onStop, onSessionEnd, continueAfterDeath: true }), (sessions, detail) => finish(sessions, false, detail));
    const squad = all.slice(0, ours.length).map(squadWorkSession), gang = all.slice(ours.length).map(squadWorkSession);
    // Bench: a gang account is out when it died (a new life, or at the Lumbridge spawn) or left the Wilderness.
    const gangLife = new Map(gang.map(g => [g, g.sdk.getState()?.player?.lifeId] as const));
    const gangDead = (g: Session) => { const p = g.sdk.getState()?.player; return !!p && ((gangLife.get(g) !== undefined && p.lifeId !== gangLife.get(g)) || Math.max(Math.abs(p.worldX - 3222), Math.abs(p.worldZ - 3218)) <= 40); };
    const gangOut = () => gang.length > 0 && gang.every(g => { const p = g.sdk.getState()?.player; return !p || gangDead(g) || wildernessLevel(p.worldZ) === 0; });
    let squadDone = false;
    const stopped = () => squadDone || halted !== undefined || existsSync('.practice/stop-pk-squad') || gangOut();
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
    const step = Number(get('STEP', '12')), aim = { ...post }, tripping = new Set<string>(), finished = new Set<string>();
    let route: { x: number; z: number }[] = [], stepAt = 0;
    const centroid = () => { const ps = squad.map(q => q.sdk.getState()?.player).filter((q): q is NonNullable<typeof q> => !!q); return { x: ps.reduce((n, q) => n + q.worldX, 0) / Math.max(1, ps.length), z: ps.reduce((n, q) => n + q.worldZ, 0) / Math.max(1, ps.length) }; };
    const march = (to: { x: number; z: number }) => {
        aim.x = to.x; aim.z = to.z;
        route = marchPlan(centroid(), to, step);
        const next = route.shift() ?? to;
        post.x = next.x; post.z = next.z; stepAt = Math.max(...squad.map(s => s.tick()));
        log(`SQUAD march to ${to.x},${to.z} in ${route.length + 1} steps: ${[next, ...route].map(r => `${r.x},${r.z}`).join(' ')}`);
    };
    const unwatchMarch = watchSquadTicks(squad, name => dropped.has(name), tick => {
        if (!route.length) return;
        // Every member within 4 tiles of the step, but a dropped one and one on a later trip: a member still at the bank outside the
        // Wilderness counted as close, and the first walkers went in alone.
        const close = marchClose(squad.map(q => { const p = q.sdk.getState()?.player; return { name: q.name, at: p ? { x: p.worldX, z: p.worldZ } : undefined }; }), post,
            new Set([...dropped.keys(), ...tripping, ...finished]));
        if (!close && tick - stepAt < 60) return;
        const next = route.shift()!;
        post.x = next.x; post.z = next.z; stepAt = tick;
        log(`SQUAD march step ${next.x},${next.z} at tick ${tick}${close ? '' : ' (waited 60 ticks)'}`);
    });
    // FOLLOW=1: with no target in view of any of ours for FOLLOW_WAIT ticks (default 30), the squad marches to the
    // meeting tile by the targets that the world feed shows (meetTile), at Wilderness level MAX_WILD or less (default 20).
    let closeRadar: (() => void) | undefined, unwatchRadar: (() => void) | undefined, unwatchFollow: (() => void) | undefined;
    if (get('FOLLOW', '0') === '1') {
        const radar = new Radar(), maxWild = Number(get('MAX_WILD', '20')), wait = Number(get('FOLLOW_WAIT', '30'));
        const { accountServer } = await import('./pk-roam');
        // Bench: the practice engine serves no world feed, so the bench gang's own tiles fill the radar as roster frames.
        if (gang.length) unwatchRadar = watchSquadTicks(squad, name => dropped.has(name), tick => radar.accept({ t: 'roster', k: tick, p: gang.flatMap((g, i) => { const q = g.sdk.getState()?.player; return q ? [[i, g.name, q.worldX, q.worldZ, 0, q.combatLevel] as [number, string, number, number, number, number]] : []; }) }));
        else closeRadar = connectRadar(accountServer(squad[0]!.name), radar);
        let unseen = 0, goal: { x: number; z: number } | null = null;
        unwatchFollow = watchSquadTicks(squad, name => dropped.has(name), tick => {
            const seen = squad.some(s => (s.sdk.getState()?.nearbyPlayers ?? []).some(q => targets.has(q.name.toLowerCase())));
            unseen = seen ? 0 : unseen + 1;
            if (process.env.FOLLOW_TRACE === '1' && tick % 100 === 0) log(`SQUAD follow trace unseen=${unseen} fresh=${radar.fresh()} tracks=${radar.tracks.size}`);
            if (unseen < wait || tick % 10 !== 0) return;
            const where = radar.fresh() ? [...radar.tracks.values()].filter(t => targets.has(t.name.toLowerCase()) && wildernessLevel(t.z) > 0) : [];
            let tile = meetTile(where, maxWild);
            if (!tile && get('SCOUT_INTEL', '1') === '1') {
                const lead = squad.find(q => !dropped.has(q.name) && q.sdk.getState()?.player)?.sdk.getState()?.player;
                const intelPick = lead ? pickScoutTargetForSquad({ me: { x: lead.worldX, z: lead.worldZ, combat: lead.combatLevel }, intel: readScoutIntel(), maxWild, friends: new Set(ours.map(n => n.toLowerCase())) }) : null;
                if (intelPick) {
                    targets.add(intelPick.target.toLowerCase());
                    tile = { x: intelPick.x, z: intelPick.z };
                    log(`SQUAD follow scout intel: ${intelPick.target} at ${intelPick.x},${intelPick.z} (multi=${intelPick.multi}) from ${intelPick.scout}`);
                }
            }
            if (!tile || (goal && Math.max(Math.abs(goal.x - tile.x), Math.abs(goal.z - tile.z)) <= 4)) return;
            goal = tile;
            if (where.length) log(`SQUAD follow: targets at ${where.map(t => `${t.name} ${t.x},${t.z}`).join(' ')}`);
            march(tile);
        });
    }
    // Bench: SQUAD_DROP_AT=<ticks> closes the first account's session at that tick, as a dropped connection.
    const dropAt = Number(env.SQUAD_DROP_AT ?? 0);
    if (dropAt > 0) { const first = squad[0]!, start = first.tick(); let done = false; squad[1 % squad.length]!.onTick(() => { if (!done && first.tick() - start >= dropAt) { done = true; void first.close(); } }); }
    // Our accounts walk to the post first.
    // Far from the post (MARCH=1, the default): march there; hold() walks each account to the post's current step.
    { const c = centroid(); if (get('MARCH', '1') === '1' && Math.max(Math.abs(c.x - post.x), Math.abs(c.z - post.z)) > step) march({ ...post }); }
    const squadHasSpear = squad.some(s => [...(s.sdk.getState()?.equipment ?? []), ...(s.sdk.getState()?.inventory ?? [])].some(i => /^dragon spear/i.test(i.name)));
    const spearLock = get('SPEAR_LOCK', squadHasSpear ? '1' : '0') === '1';
    const freezeShares = new Map<string, NonNullable<FightOptions['freezeShare']>>();
    // SQUAD_FREEZE_SHARE=1: the squad shares one freeze clock for each target (the same stagger of 3 ticks that the bench of the freeze share used), so that 2 to 4
    // members do not cast Bind on the same tick (run 3).
    const freezeShareFor = (t: string) => {
        const key = t.toLowerCase();
        let share = freezeShares.get(key);
        if (!share) { share = { clock: () => squad[0]!.tick(), until: -1, stagger: Number(get('SQUAD_FREEZE_STAGGER', '3')) }; freezeShares.set(key, share); }
        return share;
    };
    const stunShares = new Map<string, NonNullable<FightOptions['stunShare']>>();
    const stunShareFor = (t: string) => {
        const key = t.toLowerCase();
        let share = stunShares.get(key);
        if (!share) { share = { clock: () => squad[0]!.tick(), until: -1, stunnedUntil: -1, overlap: 1 }; stunShares.set(key, share); }
        return share;
    };
    // SQUAD_THREAT=1: the threat radar (scripts/pk-threat.ts) reads every member's view and the world feed, logs each threat and decision,
    // and records each attacker. SQUAD_THREAT_ACT=0 only logs and records. The targets of the squad are expected: they get a protect prayer but no retreat (SQUAD_THREAT_EXPECTED=0: a target is a stranger too, for a bench whose attackers are also the targets).
    let closeThreatRadar: (() => void) | undefined, threats: ThreatWatch | undefined;
    if (get('SQUAD_THREAT', '0') === '1') {
        const radar = new Radar();
        if (!gang.length) closeThreatRadar = connectRadar(squadServer, radar);
        const to = threatConfig!;
        threats = new ThreatWatch({ sessions: () => squad, server: squadServer, friends: new Set(ours.map(n => n.toLowerCase())), radar, log, act: to.act, cooldown: to.cooldown, odds: to.odds,
            decide: { expected: to.expectedTargets ? targets : new Set<string>() } });
    }
    const results = await Promise.all(squad.map(s => {
        const kit = kitFrom(s.sdk.getState()?.equipment ?? [], s.sdk.getState()?.inventory ?? []);
        const stunSpec = defaultStunSpec(kit);
        return hold(s, {
            targets, post, threats,
            options: { ...sparOptions(get('SQUAD_PROFILE', 'gang-hunter'), optsJson, kit, 1200), ...fightOverrides },
            ...(get('SQUAD_FREEZE_SHARE', '0') === '1' ? { freezeShareFor } : {}),
            ...(spearLock ? { stunShareFor, burstOnStun: true, ...(stunSpec && !defaultSpec(kit)?.stun ? { stunSpec } : {}) } : {}),
            allies: ours.filter(n => n !== s.name).map(n => n.toLowerCase()), pickup: get('PICKUP', '1') === '1', pull: get('PULL', '1') === '1', tripping, aim, trips: Number(get('TRIPS', '10')), maxDeaths: maxDeathsOf(get('SQUAD_MAX_DEATHS', '1'), 1), run: runDeaths,
            onDeath: near => { recordPvpDeath({ account: s.name, server: squadServer, at: Date.now(), script: 'scripts/pk-squad.ts', near }); }, deadline,
            stopped: () => stopped() || dropped.has(s.name) || existsSync(`.practice/stop-${s.name}`), killsLeft: () => !maxKills || kills < maxKills, log: l => { if (isKillLine(l)) kills++; log(l); },
        }).finally(() => { finished.add(s.name); });
    }));
    squadDone = true;
    await Promise.all(gangRuns);
    unwatchMarch(); unwatchRadar?.(); unwatchFollow?.();
    closeRadar?.(); closeThreatRadar?.();
    // Live: no account logs out in the Wilderness. The deadline or a stop can end an account's hold mid-fight with
    // its food gone, and a later login on that tile met a PKer: live, KnightRider logged out at the post with 4 HP and
    // died 31 ticks into its next session, skulled, with its whole kit.
    // A dropped account has no session to walk; the rescue below logs it in again.
    const stranded: string[] = [];
    if (!gang.length) await Promise.all(squad.map(async (s, i) => { if (dropped.has(s.name)) return; const out = await leaveWilderness(s, results[i]!.died); if (out.died) results[i]!.died = true; if (out.why) { log(`[${s.name}] SQUAD ${out.why}`); stranded.push(s.name); } }));
    for (const r of results) console.log(`SQUAD ${JSON.stringify(r)}`);
    const picked: Record<string, number> = {};
    for (const r of results) for (const [id, n] of Object.entries(r.picked)) picked[id] = (picked[id] ?? 0) + n;
    const sum = (f: (r: SquadStats) => number) => results.reduce((n, r) => n + f(r), 0);
    // RESCUE=1 (default): each dropped account logs in again, eats, and leaves the Wilderness by Camelot Teleport
    // (Wilderness 20 or less, runes held) or a walk to the Edgeville bank; one it cannot get out the RESULT names.
    if (get('RESCUE', '1') === '1') stranded.push(...await rescueDropped(dropped.keys(), all, (name, onStop) => openBot(name, { onStop, onSessionEnd: (s, detail) => onStop(s, detail) }), log));
    else stranded.push(...dropped.keys());
    const end = squadEnd({ accounts: results.length, kills: sum(r => r.kills), gangDied: gang.length ? gang.filter(gangDead).length : undefined, deaths: results.filter(r => r.died).length,
        taken: sum(r => r.taken), trips: sum(r => r.trips), fights: sum(r => r.fights), picked, dropped: [...dropped.keys()], stranded, halted, rekits: results.reduce((n, r) => n + r.rekits, 0), ...(threats ? { interlopers: results.reduce((n, r) => n + (r.interlopers ?? 0), 0) } : {}), receiptProof: killReceiptProof(results.flatMap(r => r.receipts)), diedAccounts: results.filter(r => r.died).map(r => r.name) });
    await settleKillFeed();
    await finish(all, end.ok, end.detail);
}
