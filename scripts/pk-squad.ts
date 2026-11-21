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
//   RESCUE=1 (a dropped account logs in again at once and leaves the Wilderness while the others fight on)
// Bench only: SQUAD_GANG=<n> drives the last n accounts as the gang (profile ganker-live against our accounts).
// Live: openBot refuses a non-local server without DEMO_OK=1 and an account of another fleet side. The main account
// is refused. Stop: touch .practice/stop-<account> for one account, or .practice/stop-pk-squad for all.
// First: it sets STALL_TICKS before packages/core/src/bot.ts loads (see the file).
import './pk-squad-stall';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import { FREE_FLOOR_GB, HOST_DEFERRED_EXIT } from '../packages/core/src/memory';
import { isLocalServer } from '../packages/core/src/localserver';
import type { Session } from '../packages/core/src/inprocess';
import { closeWithin } from '../packages/core/src/bot';
import { killReceiptProof } from '../packages/core/src/kill-receipt';
import { RETALIATE_OFF } from '../packages/core/src/combat-end';
import { bindActionScope } from '../packages/core/src/action-scope';
import { sessionWalker, walkPath } from '../packages/core/src/walk';
import { attackable, bestFood, carriedPoison, defaultSpec, defaultStunSpec, escapeCastable, fightPlayer, getObjNames, ITEMS, isMulti, nextTick, observePlayer, ownSkull, poisonSplat, PRAYER, recordKillLoot, rewearStart, STUNNED_SHOVE_SPOTANIM, wildernessLevel, weaponStyle, type FightOptions } from './pk';
import { bankTrip, MIN_TRIP_ARROWS, packOf, pickUp, PICKUP_ITEMS } from './pk-gang';
import { settleKillFeed } from './pk-kill-feed';
import { EDGEVILLE_BANK, eatUp, FOOD_START_FLOOR, maxDeathsOf, rekitAfterDeath } from './pk-hunt';
import { pvpDeathLimits, pvpDeathRefusal, recordPvpDeath } from '../packages/core/src/pvp-deaths';
import { attackStyleOfAnim, holdProtect, KitSwapper, protectOf, retreatOf, ThreatWatch, threatOptions } from './pk-threat';
type CombatStyle = NonNullable<ReturnType<typeof protectOf>>;
import { connectRadar, escapeStep, kitFrom, pickScoutTargetForSquad, Radar, readScoutIntel } from './pk-roam';
import { GOD_LOADOUTS, kitOptions, kitSwitches } from './pk-kits';
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
    for (const leg of marchLegs(from, to, multi)) {
        // Mainland legs to or below the Wilderness ditch use full RS pathfinding instead of straight-line stepping through obstacles.
        if (wildernessLevel(leg.z) === 0) route.push({ ...leg });
        else if (at.z < 3519 && Math.max(Math.abs(leg.x - at.x), Math.abs(leg.z - at.z)) > 40) {
            const edge = { x: Math.max(3040, Math.min(3260, leg.x)), z: 3519 };
            route.push(edge, ...marchRoute(edge, leg, step));
        } else {
            route.push(...marchRoute(at, leg, step));
        }
        at = leg;
    }
    return route;
}

/** Averages positions of active squad members (optionally preferring members already in the Wilderness). */
export function activeCentroid(
    members: readonly { name: string; at?: { x: number; z: number } }[],
    exempt: ReadonlySet<string>,
    preferWilderness = false,
): { x: number; z: number } | null {
    const active = members.filter(m => !exempt.has(m.name) && !!m.at);
    if (!active.length) return null;
    const wild = preferWilderness ? active.filter(m => wildernessLevel(m.at!.z) > 0) : [];
    const pool = wild.length ? wild : active;
    return {
        x: pool.reduce((sum, m) => sum + m.at!.x, 0) / pool.length,
        z: pool.reduce((sum, m) => sum + m.at!.z, 0) / pool.length,
    };
}

/** Prevents FOLLOW=1 from replanning before initial rally completes or thrashing mid-march on minor target shifts. */
export function shouldFollowReplan(o: {
    rallied: boolean;
    routePending: boolean;
    currentAim: { x: number; z: number };
    nextTile: { x: number; z: number };
    tick: number;
    lastReplanTick: number;
}): boolean {
    if (!o.rallied) return false;
    const shift = Math.max(Math.abs(o.currentAim.x - o.nextTile.x), Math.abs(o.currentAim.z - o.nextTile.z));
    const minShift = o.routePending ? 12 : 5;
    const cooldown = o.routePending ? 30 : 15;
    return shift >= minShift && (o.lastReplanTick < 0 || o.tick - o.lastReplanTick >= cooldown);
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
    // as dropped, and its rescue (at once, `startRescue`) takes it out of the Wilderness. Live: one idle member halted a squad of
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
// that ends its own session) goes into `dropped`, and its rescue (`onDrop`) takes it out of the Wilderness at once.
export function squadStopHandlers(halt: (detail: string) => void, dropped: Map<string, string>, log: (line: string) => void = line => console.log(line), onDrop: (name: string) => void = () => {}) {
    const onSessionEnd = async (s: Session, detail: string) => { if (!dropped.has(s.name)) { dropped.set(s.name, detail); log(`[${s.name}] SQUAD session ended: ${detail}`); onDrop(s.name); } };
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

// Whether an idle member keeps its prayers on: a target of the squad within 12 tiles, or Hitpoints lost in the last 10 ticks, and only while
// its Prayer points are above the start floor of scripts/squad-ready.ts (70 percent of the base level): under it the prayers go off so that
// a gang member that stands near and cannot be attacked does not drain them to nothing (a live run: the points ran out at about tick 730).
export const KEEP_PRAYER_RANGE = 12, KEEP_PRAYER_TICKS = 10, KEEP_PRAYER_FLOOR = 0.7;
export function keepPrayer(o: { view: readonly { name: string; distance: number }[]; targets: ReadonlySet<string>; now: number; damagedAt: number; points?: number; base?: number }): boolean {
    if (o.points !== undefined && o.base !== undefined && o.points <= Math.ceil(o.base * KEEP_PRAYER_FLOOR)) return false;
    return o.now - o.damagedAt <= KEEP_PRAYER_TICKS || o.view.some(q => o.targets.has(q.name.toLowerCase()) && q.distance <= KEEP_PRAYER_RANGE);
}

// The memory gate of a live squad start: the fleet's floor and one GiB for each squad bot (the swarm admits a bot the same way,
// scripts/swarm.ts START_BUDGET_GB).
export const SQUAD_BOT_GB = 1;
export function squadMemoryGate(freeGB: number, bots: number, floorGB: number = FREE_FLOOR_GB): { ok: boolean; needGB: number } {
    const needGB = floorGB + SQUAD_BOT_GB * bots;
    return { ok: freeGB >= needGB, needGB };
}

// The pull (hold): the distance to the march's goal within which an attacked account on single-way ground walks on into multi-way,
// and the ticks that a stretch of it may take.
export const PULL_RANGE = 100, PULL_MAX_TICKS = 60;
export const pullDistance = (p: { worldX: number; worldZ: number }, aim: { x: number; z: number }) => Math.max(Math.abs(p.worldX - aim.x), Math.abs(p.worldZ - aim.z));
export const pullTicks = (distance: number) => Math.min(PULL_MAX_TICKS, 20 + Math.ceil(distance / 2));

// Keeps a squad member alive in Wilderness outside `fightPlayer` (retreat, bank return, pickup, pulling, idle walks)
// by keeping protect overhead prayers and food/karambwan healing active every tick.
function createWildSurvival(
    s: Session,
    opts: {
        protect?: () => CombatStyle | null;
        eatBelow?: number;
        comboBelow?: number;
        useDirect?: boolean;
        protectItem?: () => boolean;
        canEat?: () => boolean;
    } = {},
): { step: (now: number) => boolean } {
    let foodReady = -10, karamReady = -10, prayAt = -10, itemAt = -10, seenEvent = 0, hitStyle: CombatStyle | null = null, hitAt = -100;
    const sendEat = (slot: number, opIndex: number) => {
        if (opts.useDirect && typeof s.direct === 'function') void s.direct({ type: 'useInventoryItem', slot, optionIndex: opIndex, reason: 'SDK' });
        else if (typeof s.sdk.sendUseItem === 'function') void s.sdk.sendUseItem(slot, opIndex);
    };
    return {
        step: (now: number) => {
            let acted = false;
            const st = s.sdk.getState(), me = st?.player;
            if (!st || !me || me.isDead || me.hp <= 0 || wildernessLevel(me.worldZ) === 0) return false;
            for (const e of st.combatEvents ?? []) {
                const id = e.observationId ?? e.tick;
                if (id <= seenEvent) continue;
                seenEvent = id;
                if (e.type === 'damage_taken' && e.sourceType === 'other_player') {
                    hitAt = now;
                    const players = (s.client as { players?: ({ primaryAnim?: number } | null)[] } | undefined)?.players;
                    const inferred = e.sourceIndex >= 0 ? attackStyleOfAnim(players?.[e.sourceIndex]?.primaryAnim ?? -1) : null;
                    if (inferred) hitStyle = inferred;
                }
            }
            const prayers = st.prayers;
            if (prayers && prayers.prayerPoints > 0) {
                const style = opts.protect?.() ?? (now - hitAt <= 8 ? hitStyle : null);
                if (style && now - prayAt >= 3) {
                    holdProtect(s, style, 0);
                    prayAt = now;
                    acted = true;
                }
                const active = prayers.activePrayers ?? [];
                if (opts.protectItem?.() && (s.sdk.getSkill?.('Prayer')?.baseLevel ?? 1) >= 25 && !active[PRAYER.item] && now - itemAt >= 3 && typeof s.sdk.sendTogglePrayer === 'function') {
                    void s.sdk.sendTogglePrayer(PRAYER.item);
                    itemAt = now;
                    acted = true;
                }
            }
            if (opts.canEat && !opts.canEat()) return acted;
            const eatAt = opts.eatBelow ?? Math.max(65, me.maxHp - 24);
            const comboAt = opts.comboBelow ?? 55;
            if (now >= foodReady && me.hp <= eatAt) {
                const inv = s.sdk.getInventory?.() ?? [];
                const food = bestFood(inv);
                const op = food?.optionsWithIndex?.find(x => /^eat$/i.test(x.text));
                if (food && op) {
                    sendEat(food.slot, op.opIndex);
                    acted = true;
                    foodReady = now + 3;
                    if (food.id === ITEMS.karambwan) karamReady = now + 3;
                    else if (me.hp <= comboAt && now >= karamReady) {
                        const karam = inv.find(i => i.id === ITEMS.karambwan && i.optionsWithIndex?.some(x => /^eat$/i.test(x.text)));
                        const kOp = karam?.optionsWithIndex?.find(x => /^eat$/i.test(x.text));
                        if (karam && kOp) {
                            sendEat(karam.slot, kOp.opIndex);
                            karamReady = now + 3;
                        }
                    }
                }
            }
            return acted;
        },
    };
}

// Cures lingering poison and eats above fatal poison ticks once safe out of the Wilderness.
export async function curePoisonAndEat(s: Session, stop: () => boolean = () => false, always = false): Promise<void> {
    const me = () => s.sdk.getState()?.player;
    const p0 = me();
    if (!p0 || wildernessLevel(p0.worldZ) > 0) return;
    const poisoned = carriedPoison(s.client, s.tick()) || poisonSplat(s.client) > 0;
    const hpLow = p0.hp <= Math.min(20, p0.maxHp - 30);
    if (!always && !poisoned && !hpLow) return;
    const inv0 = s.sdk.getInventory?.() ?? [];
    const anti = inv0.find(i => (ITEMS.antipoison as readonly number[]).includes(i.id));
    const antiOp = anti?.optionsWithIndex?.find(x => /^drink$/i.test(x.text));
    if (anti && antiOp && (poisoned || always) && !stop()) {
        if (typeof s.direct === 'function') await s.direct({ type: 'useInventoryItem', slot: anti.slot, optionIndex: antiOp.opIndex, reason: 'SDK' });
        else if (typeof s.sdk.sendUseItem === 'function') await s.sdk.sendUseItem(anti.slot, antiOp.opIndex);
        await nextTick(s);
    }
    const eatUntil = always ? p0.maxHp - 15 : Math.min(p0.maxHp - 15, 72);
    for (let i = 0; i < 6 && !stop(); i++) {
        const q = me();
        if (!q || q.hp >= eatUntil) break;
        const invBefore = s.sdk.getInventory?.() ?? [];
        const food = bestFood(invBefore);
        const op = food?.optionsWithIndex?.find(x => /^eat$/i.test(x.text));
        if (!food || !op) break;
        if (typeof s.direct === 'function') await s.direct({ type: 'useInventoryItem', slot: food.slot, optionIndex: op.opIndex, reason: 'SDK' });
        else if (typeof s.sdk.sendUseItem === 'function') await s.sdk.sendUseItem(food.slot, op.opIndex);
        for (let t = 0; t < 3 && !stop(); t++) if (!await nextTick(s)) break;
        const qAfter = me();
        const invAfter = s.sdk.getInventory?.() ?? [];
        if (qAfter && qAfter.hp <= q.hp && invAfter.length >= invBefore.length && invAfter.find(x => x.slot === food.slot)?.id === food.id) break;
    }
}

// Turning auto-retaliate off stops server-side [queue,pvp_retaliate] from walking an escaped or finished
// member back out of Edgeville bank into the Wilderness when hit during teleport windup.
export async function disableAutoRetaliate(s: Session): Promise<void> {
    const state = s.sdk.getState?.() as { autoRetaliateEnabled?: boolean } | undefined;
    if (!state || state.autoRetaliateEnabled !== true || typeof s.direct !== 'function') return;
    await s.direct({ type: 'clickComponent', componentId: RETALIATE_OFF, reason: 'squad auto-retaliate off' });
    for (let t = 0; t < 3 && (s.sdk.getState?.() as { autoRetaliateEnabled?: boolean } | undefined)?.autoRetaliateEnabled === true; t++) {
        if (!await nextTick(s)) break;
    }
}

// A dropped account logged in again: settle on fresh login, cast an available escape teleport or rub a glory (wild <= 30)
// immediately, else eat and walk to the nearer bank (bankNear) while protecting prayer and healing every tick.
export async function rescue(
    s: Session,
    log: (l: string) => void,
    stopped: () => boolean = () => false,
    settleStart = true,
    opts: { protect?: () => CombatStyle | null; protectItem?: () => boolean } = {},
): Promise<Session | null> {
    const me = () => s.sdk.getState()?.player;
    const tick = async () => !stopped() && await nextTick(s) && !stopped();
    for (let i = 0; i < 3 && (settleStart || !me()); i++) if (!await tick()) return null;
    const start = me();
    if (!start) return null;
    log(`[${s.name}] SQUAD rescue at ${start.worldX},${start.worldZ} wild ${wildernessLevel(start.worldZ)} hp ${start.hp}`);
    if (wildernessLevel(start.worldZ) > 0) {
        let suppressEat = false;
        const survival = createWildSurvival(s, {
            protect: opts.protect,
            protectItem: opts.protectItem,
            eatBelow: Math.max(85, start.maxHp - 8),
            comboBelow: Math.max(76, start.maxHp - 18),
            useDirect: true,
            canEat: () => !s.sdk.getState()?.dialog?.isOpen && (!suppressEat || (me()?.hp ?? start.maxHp) <= 52),
        });
        const hasChargedGlory = () => {
            const st = s.sdk.getState(), inv = s.sdk.getInventory?.() ?? [], eq = (typeof s.sdk.getEquipment === 'function' ? s.sdk.getEquipment() : st?.equipment) ?? [];
            return [...inv, ...eq].some(i => (ITEMS.glory as readonly number[]).includes(i.id));
        };
        const useItemAction = async (slot: number, opIndex: number) => {
            if (typeof s.direct === 'function') await s.direct({ type: 'useInventoryItem', slot, optionIndex: opIndex, reason: 'SDK' });
            else if (typeof s.sdk.sendUseItem === 'function') await s.sdk.sendUseItem(slot, opIndex);
        };
        const clickEdgeville = async () => {
            const dlg = s.sdk.getState()?.dialog as { isOpen?: boolean; isWaiting?: boolean; pageId?: string; options?: { text: string; index?: number; componentId?: number }[] } | undefined;
            if (!dlg?.isOpen || dlg.isWaiting) return false;
            const edgeOpt = Array.isArray(dlg.options) ? dlg.options.find(op => /^Edgeville/i.test(op.text)) : undefined;
            if (Array.isArray(dlg.options) && !edgeOpt) return false;
            if (typeof s.direct === 'function' && edgeOpt?.index !== undefined && edgeOpt.componentId !== undefined && dlg.pageId) {
                const res = await s.direct({
                    type: 'clickDialogOption',
                    optionIndex: edgeOpt.index,
                    guard: { pageId: dlg.pageId, componentId: edgeOpt.componentId },
                    reason: 'SDK',
                }) as { success?: boolean } | undefined;
                return res?.success !== false;
            }
            if (typeof s.sdk.clickDialogByText !== 'function') return false;
            const res = await s.sdk.clickDialogByText(/^Edgeville/i) as { success?: boolean } | undefined;
            return res?.success !== false;
        };
        const st = s.sdk.getState(), magic = st?.skills?.find(k => k.name === 'Magic')?.level ?? 1;
        const wornIds = ((typeof s.sdk.getEquipment === 'function' ? s.sdk.getEquipment() : st?.equipment) ?? []).map(e => e.id);
        const escapeSpell = st ? squadEscapeSpell(start.worldZ, st.inventory ?? [], wornIds, magic) : null;
        // Eat and cast an available escape teleport on the same tick to buffer delayed hits during teleport windup.
        if (escapeSpell !== null) {
            for (let i = 0; i < 3 && wildernessLevel(me()?.worldZ ?? 0) > 0; i++) {
                if (stopped()) return null;
                const q = me();
                if (q && q.hp <= q.maxHp - 20) {
                    const food = (s.sdk.getInventory?.() ?? []).find(f => f.optionsWithIndex.some(op => /^eat$/i.test(op.text)));
                    const op = food?.optionsWithIndex.find(x => /^eat$/i.test(x.text));
                    if (food && op) await useItemAction(food.slot, op.opIndex);
                }
                if (stopped()) return null;
                await s.direct({ type: 'clickComponent', componentId: escapeSpell, reason: 'SDK' });
                for (let t = 0; t < 6 && wildernessLevel(me()?.worldZ ?? 0) > 0; t++) {
                    survival.step(s.tick());
                    if (!await tick()) return null;
                }
            }
        }
        const tryGloryEscape = async (): Promise<boolean> => {
            const waitTeleport = async () => {
                suppressEat = true;
                try {
                    for (let d = 0; d < 4 && wildernessLevel(me()?.worldZ ?? 0) > 0; d++) {
                        survival.step(s.tick());
                        if (!await tick()) return false;
                    }
                } finally {
                    suppressEat = false;
                }
                return true;
            };
            const unequipGlory = async (slot: number) => {
                const hasClientUnequip = typeof (s.client as { clickEquipmentSlot?: unknown } | undefined)?.clickEquipmentSlot === 'function';
                if (hasClientUnequip && typeof s.direct === 'function') {
                    await s.direct({ type: 'useEquipmentItem', slot, optionIndex: 1, reason: 'SDK' });
                    return;
                }
                if (typeof s.sdk.sendUseEquipmentItem === 'function') await s.sdk.sendUseEquipmentItem(slot, 1);
            };
            for (let attempt = 0; attempt < 60 && wildernessLevel(me()?.worldZ ?? 0) > 0 && wildernessLevel(me()?.worldZ ?? 0) <= 30 && hasChargedGlory(); attempt++) {
                if (stopped()) return false;
                if (await clickEdgeville()) {
                    if (!await waitTeleport()) return false;
                    continue;
                }
                const stNow = s.sdk.getState(), inv = s.sdk.getInventory?.() ?? [];
                const eq = (typeof s.sdk.getEquipment === 'function' ? s.sdk.getEquipment() : stNow?.equipment) ?? [];
                const curHp = me()?.hp ?? start.maxHp;
                const invGlory = inv.find(i => (ITEMS.glory as readonly number[]).includes(i.id));
                const rubOp = invGlory?.optionsWithIndex?.find(x => /^Rub$/i.test(x.text));
                if (invGlory && rubOp) {
                    if (curHp <= 70 && survival.step(s.tick())) {
                        if (!await tick()) return false;
                        continue;
                    }
                    if (!stopped()) await useItemAction(invGlory.slot, rubOp.opIndex);
                    // Dialog opens 1 tick later unless an enemy hit (.if_close) closed it on the rub tick; retry immediately instead of idling.
                    let opened = false;
                    for (let t = 0; t < 2 && wildernessLevel(me()?.worldZ ?? 0) > 0; t++) {
                        if (await clickEdgeville()) {
                            opened = true;
                            if (!await waitTeleport()) return false;
                            break;
                        }
                        if (t === 0 && !await tick()) return false;
                    }
                    if (!opened && wildernessLevel(me()?.worldZ ?? 0) > 0 && (me()?.hp ?? start.maxHp) <= 76 && survival.step(s.tick())) {
                        if (!await tick()) return false;
                    }
                    continue;
                }
                const wornGlory = eq.find(e => (ITEMS.glory as readonly number[]).includes(e.id));
                if (wornGlory) {
                    const acted = curHp <= 70 ? survival.step(s.tick()) : false;
                    if (inv.length < 28 && (typeof s.sdk.sendUseEquipmentItem === 'function' || typeof s.direct === 'function')) {
                        if (acted) {
                            if (!await tick()) return false;
                            continue;
                        }
                        await unequipGlory(wornGlory.slot);
                        if (!await tick()) return false;
                        continue;
                    }
                    const vial = inv.find(i => i.id === 229);
                    const dropOp = vial?.optionsWithIndex?.find(x => /^Drop$/i.test(x.text));
                    const food = bestFood(inv);
                    const eatOp = food?.optionsWithIndex?.find(x => /^eat$/i.test(x.text));
                    const spareDrop = inv.find(i => !(ITEMS.glory as readonly number[]).includes(i.id) && i.optionsWithIndex?.some(x => /^Drop$/i.test(x.text)));
                    const spareOp = spareDrop?.optionsWithIndex?.find(x => /^Drop$/i.test(x.text));
                    if (vial && dropOp) await useItemAction(vial.slot, dropOp.opIndex);
                    else if (!acted && food && eatOp) await useItemAction(food.slot, eatOp.opIndex);
                    else if (spareDrop && spareOp) await useItemAction(spareDrop.slot, spareOp.opIndex);
                    else if (!acted) break;
                    if (!await tick()) return false;
                    continue;
                }
                break;
            }
            return true;
        };
        if (wildernessLevel(me()?.worldZ ?? 0) > 0 && wildernessLevel(me()?.worldZ ?? 0) <= 30 && hasChargedGlory()) {
            if (!await tryGloryEscape()) return null;
        }
        const unwatch = typeof s.onTick === 'function' ? s.onTick(() => survival.step(s.tick())) : () => {};
        try {
            if (wildernessLevel(me()?.worldZ ?? 0) > 30 && hasChargedGlory()) {
                const pos = me() ?? start;
                await walkPath(await sessionWalker(s), [{ ...bankNear(pos.worldX), tol: 2 }], { maxTicks: 160, idleMs: 9000, stop: () => stopped() || wildernessLevel(me()?.worldZ ?? 0) <= 30 });
                if (stopped()) return null;
                if (wildernessLevel(me()?.worldZ ?? 0) > 0 && wildernessLevel(me()?.worldZ ?? 0) <= 30) {
                    if (!await tryGloryEscape()) return null;
                }
            }
            if (wildernessLevel(me()?.worldZ ?? 0) > 0) {
                for (let i = 0; i < 6; i++) {
                    const q = me(), food = bestFood(s.sdk.getInventory?.() ?? []), op = food?.optionsWithIndex?.find(x => /^eat$/i.test(x.text));
                    if (stopped()) return null;
                    if (!q || !food || !op || q.hp >= q.maxHp - 18) break;
                    await useItemAction(food.slot, op.opIndex);
                    for (let t = 0; t < 3 && wildernessLevel(me()?.worldZ ?? 0) > 0; t++) {
                        survival.step(s.tick());
                        if (!await tick()) return null;
                    }
                }
            }
            if (stopped()) return null;
            if (wildernessLevel(me()?.worldZ ?? 0) > 0) await walkPath(await sessionWalker(s), [{ ...bankNear(me()?.worldX ?? start.worldX), tol: 2 }], { maxTicks: 500, idleMs: 9000, stop: stopped });
        } finally {
            unwatch();
        }
    }
    const end = me();
    if (!stopped() && end && wildernessLevel(end.worldZ) === 0) {
        const retaliating = (s.sdk.getState?.() as { autoRetaliateEnabled?: boolean } | undefined)?.autoRetaliateEnabled === true;
        if (retaliating) {
            await disableAutoRetaliate(s);
            if (typeof s.sdk.sendWalk === 'function') void s.sdk.sendWalk(end.worldX, end.worldZ);
        }
        await curePoisonAndEat(s, stopped, false);
    }
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
    deaths: number; rekits: number;
    killTicks?: number; minHp?: number; sharksEaten?: number; karamEaten?: number; freezesCast?: number; freezesLanded?: number; escapes?: number };

export type SquadMetrics = {
    accounts: number; kills: number; deaths: number; taken: number; trips: number;
    avgKillTicks: number | null; minHp: number | null; sharksEaten: number; karamEaten: number;
    freezesCast: number; freezesLanded: number; escapes: number;
};

/** Aggregates per-member SquadStats into one structured run summary for SQUAD_METRICS logging. */
export function squadMetrics(results: readonly SquadStats[]): SquadMetrics {
    const sum = (f: (r: SquadStats) => number) => results.reduce((n, r) => n + f(r), 0);
    const kills = sum(r => r.kills), killTicks = sum(r => r.killTicks ?? 0);
    const hps = results.map(r => r.minHp).filter((v): v is number => v !== undefined);
    return {
        accounts: results.length,
        kills,
        deaths: results.filter(r => r.died).length,
        taken: sum(r => r.taken),
        trips: sum(r => r.trips),
        avgKillTicks: kills > 0 ? Math.round((killTicks / kills) * 10) / 10 : null,
        minHp: hps.length ? Math.min(...hps) : null,
        sharksEaten: sum(r => r.sharksEaten ?? 0),
        karamEaten: sum(r => r.karamEaten ?? 0),
        freezesCast: sum(r => r.freezesCast ?? 0),
        freezesLanded: sum(r => r.freezesLanded ?? 0),
        escapes: sum(r => r.escapes ?? 0),
    };
}

export type BenchLocController = {
    withLocs: <T>(fn: () => Promise<T>) => Promise<T>;
    withoutLocs: <T>(fn: () => Promise<T>) => Promise<T>;
};

const PASSTHROUGH_LOCS: BenchLocController = { withLocs: fn => fn(), withoutLocs: fn => fn() };

/**
 * Applies lockstep-bench client optimizations (never used on live): disables reachability flood-fill,
 * stubs nearby-loc scans outside walk/bank windows, and stubs ground-item scans on gang or non-pickup sessions.
 */
export function configureBenchSession(s: Session, opts: { isGang: boolean; pickup: boolean }): BenchLocController {
    (s.client as { setReachabilityEnabled?: (on: boolean) => void } | undefined)?.setReachabilityEnabled?.(false);
    const collector = (s.client as { collector?: Record<string, unknown> } | undefined)?.collector;
    if (!collector) return PASSTHROUGH_LOCS;
    if ((opts.isGang || !opts.pickup) && typeof collector.collectGroundItems === 'function') {
        collector.collectGroundItems = () => [];
    }
    if (typeof collector.collectNearbyLocs !== 'function') return PASSTHROUGH_LOCS;
    const origLocs = collector.collectNearbyLocs as () => unknown;
    const stubLocs = () => [];
    collector.collectNearbyLocs = stubLocs;
    if (opts.isGang) return PASSTHROUGH_LOCS;
    let depth = 0, paused = 0;
    const sync = () => { collector.collectNearbyLocs = depth > 0 && paused === 0 ? origLocs : stubLocs; };
    return {
        withLocs: async fn => { depth++; sync(); try { return await fn(); } finally { depth--; sync(); } },
        withoutLocs: async fn => { paused++; sync(); try { return await fn(); } finally { paused--; sync(); } },
    };
}

// The target of the squad: the target account in view with the lowest health bar, the nearest on a tie; one the game
// refused ("I'm already under attack.", "Someone else is already fighting your opponent.") leaves the pick for 8 ticks.
// `me`: the squad account; a target is taken only where the game lets it attack (both in the Wilderness, the combat gap
// within the shallower level: pk.ts attackable). A target that walked out of the Wilderness held the squad at its edge.
export function squadTarget<P extends { name: string; index: number; distance: number; z?: number; combatLevel?: number }>(view: readonly P[], targets: ReadonlySet<string>, health: (p: P) => number, skip: ReadonlySet<string> = new Set(), me?: { z: number; combatLevel: number }): P | undefined {
    return view.filter(p => targets.has(p.name.toLowerCase()) && !skip.has(p.name.toLowerCase()) && (!me || p.z === undefined || attackable(me, { z: p.z, combatLevel: p.combatLevel ?? me.combatLevel })))
        .sort((a, b) => health(a) - health(b) || a.distance - b.distance)[0];
}

// Multi-way pile & anti-PJ target focus: prioritizes multi-way targets when preferMulti is set, then priority interlopers, stunned targets, lowest HP%, scouted target, and skips busy single-way fights.
export function pickSquadFocus<P extends { name: string; index: number; distance: number; x?: number; z?: number; combatLevel?: number; inCombat?: boolean }>(opts: {
    view: readonly P[];
    targets: ReadonlySet<string>;
    health: (p: P) => number;
    skip?: ReadonlySet<string>;
    me?: { x: number; z: number; combatLevel: number };
    inMulti?: boolean;
    preferMulti?: boolean;
    stunned?: ReadonlySet<string>;
    // Players that come first (the interlopers of the threat radar: they attack us or close in).
    priority?: ReadonlySet<string>;
    activeFocus?: string;
    scoutTarget?: string;
}): P | undefined {
    const { view, targets, health, skip = new Set(), me, inMulti, preferMulti, stunned = new Set(), priority = new Set<string>(), activeFocus, scoutTarget } = opts;
    const active = activeFocus?.toLowerCase();
    const scout = scoutTarget?.toLowerCase();
    const selfMulti = inMulti ?? true;
    const isTargetMulti = (p: { x?: number; z?: number }) => (p.x !== undefined && p.z !== undefined ? isMulti(p.x, p.z) : selfMulti);
    const eligible = view.filter(p => {
        const key = p.name.toLowerCase();
        if (!targets.has(key) || skip.has(key)) return false;
        if (me && p.z !== undefined && !attackable(me, { z: p.z, combatLevel: p.combatLevel ?? me.combatLevel })) return false;
        // Anti-PJ in single-way: avoid hopping onto someone already actively engaged by another attacker unless it's our own active focus.
        const targetMulti = isTargetMulti(p);
        if ((!selfMulti || !targetMulti) && p.inCombat && key !== active) return false;
        return true;
    });
    return eligible.sort((a, b) => {
        if (preferMulti) {
            const ma = Number(isTargetMulti(a)), mb = Number(isTargetMulti(b));
            if (ma !== mb) return mb - ma;
        }
        const ak = a.name.toLowerCase(), bk = b.name.toLowerCase();
        const pa = Number(priority.has(ak)), pb = Number(priority.has(bk));
        if (pa !== pb) return pb - pa;
        const sa = Number(stunned.has(ak)), sb = Number(stunned.has(bk));
        if (sa !== sb) return sb - sa;
        const ha = health(a), hb = health(b);
        const aa = ak === active, ab = bk === active;
        if (aa !== ab && Math.abs(ha - hb) < 0.08) return aa ? -1 : 1;
        if (ha !== hb) return ha - hb;
        return Number(bk === scout) - Number(ak === scout) || a.distance - b.distance;
    })[0];
}

export interface SquadFocusEntry {
    readonly target: string;
    readonly hp: number;
    readonly inMulti: boolean;
    readonly priority: boolean;
    readonly stunned: boolean;
    readonly updatedAt: number;
}

/** Decides when a multi-way attacker should break off its current target to pile a higher-priority or dying focus. */
export function shouldSwitchFocus(o: {
    inMulti: boolean;
    currentName: string;
    currentHp: number;
    currentInMulti?: boolean;
    focusName: string | null | undefined;
    focusHp: number;
    focusInMulti?: boolean;
    focusStunned: boolean;
    elapsedTicks: number;
    minFightTicks?: number;
}): boolean {
    if (!o.focusName) return false;
    const cur = o.currentName.toLowerCase(), next = o.focusName.toLowerCase();
    if (cur === next) return false;
    if (o.currentInMulti === false && o.focusInMulti === true) return o.elapsedTicks >= (o.minFightTicks ?? 1);
    if (!o.inMulti) return false;
    if (o.elapsedTicks < (o.minFightTicks ?? 4)) return false;
    if (o.currentHp <= 0.30) return false;
    if (o.focusStunned) return true;
    return o.focusHp <= 0.50 && o.currentHp - o.focusHp >= 0.25;
}

/** Synchronizes target selection across all active squad members so full-HP targets are piled together. */
export function createSquadFocus(ttlTicks = 12) {
    let current: SquadFocusEntry | null = null;
    const stale = (now: number) => !current || now - current.updatedAt > ttlTicks;
    const ranksHigher = (cand: SquadFocusEntry, cur: SquadFocusEntry) =>
        (cand.inMulti !== cur.inMulti ? cand.inMulti : (
            (cand.priority && !cur.priority)
            || (cand.priority === cur.priority && cand.stunned && !cur.stunned)
            || (cand.priority === cur.priority && cand.stunned === cur.stunned && cand.hp <= cur.hp - 0.08)
        ));
    return {
        active(now: number): string | undefined {
            return stale(now) ? undefined : current!.target;
        },
        snapshot(now: number): SquadFocusEntry | null {
            return stale(now) ? null : current;
        },
        pick<P extends { name: string; index: number; distance: number; x?: number; z?: number; combatLevel?: number; inCombat?: boolean }>(opts: {
            view: readonly P[];
            targets: ReadonlySet<string>;
            health: (p: P) => number;
            skip?: ReadonlySet<string>;
            me?: { x: number; z: number; combatLevel: number };
            inMulti?: boolean;
            preferMulti?: boolean;
            stunned?: ReadonlySet<string>;
            priority?: ReadonlySet<string>;
            scoutTarget?: string;
            now: number;
        }): P | undefined {
            const activeFocus = stale(opts.now) ? undefined : current!.target;
            const picked = pickSquadFocus({ ...opts, activeFocus });
            if (!picked) return undefined;
            const targetMulti = picked.x !== undefined && picked.z !== undefined ? isMulti(picked.x, picked.z) : opts.inMulti !== false;
            if (opts.inMulti !== false || targetMulti) {
                const key = picked.name.toLowerCase();
                const cand: SquadFocusEntry = {
                    target: key,
                    hp: opts.health(picked),
                    inMulti: targetMulti,
                    priority: !!opts.priority?.has(key),
                    stunned: !!opts.stunned?.has(key),
                    updatedAt: opts.now,
                };
                const sameTarget = !stale(opts.now) && current!.target === key;
                const lostCurrent = !sameTarget && !stale(opts.now)
                    && opts.view.every(v => v.name.toLowerCase() !== current!.target || opts.skip?.has(v.name.toLowerCase()));
                if (stale(opts.now) || sameTarget || lostCurrent || ranksHigher(cand, current!)) {
                    current = cand;
                }
            }
            return picked;
        },
        clear(target?: string): void {
            if (!target || current?.target === target.toLowerCase()) current = null;
        },
    };
}

export const SINGLE_WAY_CHASE_LEASH = 16;

export interface SquadMemberState {
    readonly x: number;
    readonly z: number;
    readonly inMulti: boolean;
    readonly hasMultiTarget: boolean;
    readonly tick: number;
}

/** Tracks live multi-way positions and multi-target presence across active squad members. */
export function createSquadCohesion(staleTicks = 8) {
    const members = new Map<string, SquadMemberState>();
    return {
        update(name: string, state: SquadMemberState): void {
            members.set(name.toLowerCase(), state);
        },
        remove(name: string): void {
            members.delete(name.toLowerCase());
        },
        snapshot(now: number, exclude?: string) {
            const others: SquadMemberState[] = [];
            for (const [name, st] of members) {
                if (name === exclude || now - st.tick > staleTicks) continue;
                others.push(st);
            }
            const multiAllies = others.filter(m => m.inMulti);
            const multiAnchor = multiAllies.length
                ? {
                    x: Math.round(multiAllies.reduce((s, m) => s + m.x, 0) / multiAllies.length),
                    z: Math.round(multiAllies.reduce((s, m) => s + m.z, 0) / multiAllies.length),
                }
                : null;
            return {
                allyCount: others.length,
                multiAllyCount: multiAllies.length,
                anyMultiTarget: others.some(m => m.hasMultiTarget),
                multiAnchor,
            };
        },
    };
}

/** Breaks off or refuses a single-way chase when the squad belongs in multi-way combat. */
export function shouldBreakSingleWayChase(o: {
    now: number;
    singleUntil: number;
    aimInMulti: boolean;
    self: { x: number; z: number; inMulti: boolean };
    target: { x?: number; z?: number };
    hasMultiTargetInView: boolean;
    focusInMulti?: boolean;
    multiAllyCount: number;
    anyAllyHasMultiTarget: boolean;
    anchor?: { x: number; z: number } | null;
    leash?: number;
    isInterloper?: boolean;
}): boolean {
    if (!o.aimInMulti || o.now < o.singleUntil) return false;
    const targetMulti = o.target.x !== undefined && o.target.z !== undefined ? isMulti(o.target.x, o.target.z) : o.self.inMulti;
    if (targetMulti) return false;
    const selfCloseDist = o.target.x !== undefined && o.target.z !== undefined
        ? Math.max(Math.abs(o.self.x - o.target.x), Math.abs(o.self.z - o.target.z))
        : Infinity;
    // Standing in multi-way within bow/spell reach of a nearby single-way target (interloper or no multi-way target left)
    // lets `singleHold` return fire from multi-way without splitting or turning our back.
    if (o.self.inMulti && selfCloseDist <= 10 && (o.isInterloper || (!o.hasMultiTargetInView && !o.focusInMulti && !o.anyAllyHasMultiTarget))) return false;
    if (o.hasMultiTargetInView || o.focusInMulti || o.anyAllyHasMultiTarget) return true;
    if (o.multiAllyCount > 0 && !o.self.inMulti) return true;
    if (!o.anchor || o.target.x === undefined || o.target.z === undefined) return false;
    const leash = o.leash ?? SINGLE_WAY_CHASE_LEASH;
    const targetDist = Math.max(Math.abs(o.target.x - o.anchor.x), Math.abs(o.target.z - o.anchor.z));
    const selfDist = Math.max(Math.abs(o.self.x - o.anchor.x), Math.abs(o.self.z - o.anchor.z));
    return targetDist > leash || (!o.self.inMulti && selfDist > leash);
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
    packFood?: number;
    targetingMe?: number;
}): 'hold' | 'out' | 'glory' | 'teleport' | 'run' {
    const wild = wildernessLevel(opts.z);
    if (wild === 0) return 'out';
    const isolatedPile = opts.inMulti && opts.allyCount === 0 && opts.enemyCount >= 3 && (opts.hp <= opts.maxHp * 0.85 || opts.foodCount <= 6 || opts.enemyCount >= 5);
    const outnumbered = opts.inMulti && opts.enemyCount - opts.allyCount >= 2 && opts.hp <= opts.maxHp * 0.78;
    const focusPile = opts.inMulti && (opts.targetingMe ?? 0) >= 3 && opts.hp <= opts.maxHp * 0.86;
    const instantEscape = !!opts.hasTeleport && wild <= 20;
    const heavyFocus = opts.inMulti && (opts.targetingMe ?? 0) >= 2 && opts.hp <= opts.maxHp * (instantEscape ? 0.76 : 0.72);
    const emergencyMulti = opts.inMulti && ((instantEscape && opts.enemyCount >= 6 && opts.hp <= opts.maxHp * 0.76) || (opts.enemyCount >= 4 && opts.hp <= opts.maxHp * 0.62));
    const lowSupplyPile = opts.inMulti && (opts.targetingMe ?? 0) >= 2 && opts.foodCount <= 3 && opts.hp <= opts.maxHp * 0.88;
    const dry = opts.foodCount <= 0 && ((opts.packFood ?? 0) >= 6 || opts.hp <= opts.maxHp * 0.75);
    if (!isolatedPile && !outnumbered && !focusPile && !heavyFocus && !emergencyMulti && !lowSupplyPile && !dry) return 'hold';
    return escapeStep(wild, { glory: opts.hasGlory, teleport: opts.hasTeleport });
}

/** Whether a member must still move to reach single-way safety for a radar action. */
export function needsSingleWayMove(pos: { worldX: number; worldZ: number }, to: { x: number; z: number }): boolean {
    if (pos.worldX === to.x && pos.worldZ === to.z) return false;
    if (!isMulti(pos.worldX, pos.worldZ)) return false;
    return true;
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

/** Derive safe per-member FightOptions defaults from carried/worn kit (comboFood, God spells + Charge, staff-only freezeWear). */
export function squadKitFightDefaults(
    equipment: readonly { id: number }[],
    inventory: readonly { id: number; count: number }[],
    base: FightOptions,
    names = getObjNames(),
    explicitRotation = false,
): Partial<FightOptions> {
    const out: Partial<FightOptions> = {};
    if (base.comboFood === undefined && inventory.some(i => i.id === ITEMS.karambwan)) out.comboFood = true;
    const all = [...equipment, ...inventory];
    const countOf = (id: number) => inventory.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const god = Object.values(GOD_LOADOUTS).find(g => all.some(i => i.id === g.staffId) && all.some(i => i.id === g.capeId));
    const canGod = !!god && countOf(ITEMS.fireRune) >= god.runes.fire && countOf(ITEMS.bloodRune) >= god.runes.blood && countOf(ITEMS.airRune) >= god.runes.air;
    if (canGod) {
        if (base.damageSpell === undefined) out.damageSpell = god.spell;
        if (base.charge === undefined && countOf(ITEMS.fireRune) >= 3 && countOf(ITEMS.bloodRune) >= 3 && countOf(ITEMS.airRune) >= 3) out.charge = true;
        if (!explicitRotation) out.rotation = ['magic', 'ranged', 'melee'];
        out.castArmour = 'strip';
        return out;
    }
    const staff = all.find(i => weaponStyle(i.id, names) === 'magic');
    const hasDamageRunes = countOf(ITEMS.bloodRune) > 0 || countOf(ITEMS.deathRune) > 0 || countOf(ITEMS.chaosRune) > 0;
    if (staff && !hasDamageRunes && base.damageSpell === undefined && !explicitRotation) {
        const filtered = (base.rotation ?? ['ranged', 'melee']).filter(s => s !== 'magic');
        if (filtered.length) out.rotation = filtered;
    }
    if (base.freezeWear === undefined) {
        const capes = Object.values(GOD_LOADOUTS).filter(g => inventory.some(i => i.id === g.capeId)).map(g => g.cape);
        const staffName = staff && inventory.some(i => i.id === staff.id) ? names.get(staff.id) : undefined;
        const wear = [...new Set([...(staffName ? [staffName] : []), ...capes])];
        if (wear.length) out.freezeWear = wear;
    }
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
    freezeShareFor?: (target: string) => FightOptions['freezeShare']; burstOnHold?: boolean; burstOnStun?: boolean; stunSpec?: FightOptions['stunSpec'];
    focus?: ReturnType<typeof createSquadFocus>;
    cohesion?: ReturnType<typeof createSquadCohesion>;
    useRally?: boolean; onRallyReady?: (name: string) => void; waitForRally?: (s: Session, stopped: () => boolean) => Promise<void>;
    trips: number; deadline: number; stopped: () => boolean; exitStopped?: () => boolean; killsLeft: () => boolean; log: (l: string) => void;
    // Deaths that the account recovers from in the run (default 0: a death ends the account's part).
    // `onDeath` is called for each death of the account, at its tile (the death ledger of packages/core/src/pvp-deaths.ts).
    // `run`: the deaths of all the members in the run. The death that brings `deaths` to `limit` is not recovered (PVP_DEATH_LIMITS.perRun).
    maxDeaths?: number; onDeath?: (near: { x: number; z: number } | null) => void; run?: { deaths: number; limit: number };
    // The threat radar of the squad (scripts/pk-threat.ts): a protect prayer for the style of a threat, and a retreat when it outclasses the squad.
    threats?: ThreatWatch;
    locs?: BenchLocController }): Promise<SquadStats> {
    const stats: SquadStats = { name: s.name, fights: 0, pulls: 0, kills: 0, trips: 0, died: false, picked: {}, taken: 0, receipts: [], deaths: 0, rekits: 0 };
    const st = s.sdk.getState(), me = () => s.sdk.getState()?.player;
    const locs = o.locs ?? PASSTHROUGH_LOCS;
    let life0 = st?.player?.lifeId, lastTile: { x: number; z: number } | null = null, prevHp = 0, damagedAt = -100;
    let killTicks = 0, minHp: number | undefined = st?.player?.hp, sharksEaten = 0, karamEaten = 0, freezesCast = 0, freezesLanded = 0, escapes = 0;
    const countEat = (slot: number, opIndex: number) => {
        const item = s.sdk.getInventory?.().find(i => i.slot === slot);
        if (!item) return;
        const op = item.optionsWithIndex?.find(x => x.opIndex === opIndex);
        if (!op || !/^eat$/i.test(op.text)) return;
        if (item.id === ITEMS.shark) sharksEaten++;
        else if (item.id === ITEMS.karambwan) karamEaten++;
    };
    const origSendUseItem = typeof s.sdk?.sendUseItem === 'function' ? s.sdk.sendUseItem : null;
    const origDirect = typeof s.direct === 'function' ? s.direct : null;
    if (origSendUseItem) {
        s.sdk.sendUseItem = (slot: number, opIndex: number, ...rest: unknown[]) => {
            countEat(slot, opIndex);
            return (origSendUseItem as (...a: unknown[]) => Promise<unknown>).call(s.sdk, slot, opIndex, ...rest) as ReturnType<Session['sdk']['sendUseItem']>;
        };
    }
    if (origDirect) {
        s.direct = action => {
            if (action.type === 'useInventoryItem' && typeof action.slot === 'number' && typeof action.optionIndex === 'number') {
                countEat(action.slot, action.optionIndex);
            }
            return origDirect.call(s, action);
        };
    }
    // A death: a new life, or the tile of the Lumbridge respawn.
    const diedNow = (q: { lifeId?: number; worldX: number; worldZ: number }) => (life0 !== undefined && q.lifeId !== life0) || Math.max(Math.abs(q.worldX - 3222), Math.abs(q.worldZ - 3218)) <= 40;
    // A retreat that ends with no session is a death only when the account died: a stop or a walk that did not get out leaves it alive.
    const retreatEnded = () => { const q = me(); if (q && diedNow(q)) stats.died = true; else o.log(`[${s.name}] SQUAD retreat ended with the account alive${q ? ` at ${q.worldX},${q.worldZ}` : ''}`); };
    const wornAtStart = (st?.equipment ?? []).map(e => ({ id: e.id, count: e.count ?? 1 }));
    const pack = packOf(st?.inventory ?? [], st?.equipment ?? [], { minArrows: MIN_TRIP_ARROWS, minRunes: true }), kit = kitFrom(st?.equipment ?? [], st?.inventory ?? []);
    const startInv = st?.inventory ?? [], startEq = st?.equipment ?? [];
    const startWornGlory = startEq.some(e => (ITEMS.glory as readonly number[]).includes(e.id));
    const startMagic = s.sdk.getSkill?.('Magic')?.level ?? st?.skills?.find(k => k.name === 'Magic')?.level ?? 1;
    const startHasEscape = [...startInv, ...startEq].some(i => (ITEMS.glory as readonly number[]).includes(i.id))
        || [1174, 1164].some(sp => escapeCastable(sp, startInv, startEq.map(e => e.id), startMagic));
    const ammo = (st?.equipment ?? []).find(e => /arrow|bolt/i.test(e.name))?.id;
    const wanted = new Set([...PICKUP_ITEMS, ...(ammo ? [ammo] : [])]);
    const going = () => !o.stopped() && s.tick() < o.deadline && o.killsLeft();
    const bankEaten = { eaten: 0 };
    // Resolve bank and march-back legs from current aim on each trip, and synchronize initial mainland bank prep at the rally barrier.
    const trip = async (a: Session, fresh = false) => {
        if (!fresh) o.tripping?.add(s.name);
        try {
            return await locs.withLocs(async () => {
                const targetAim = { ...(o.aim ?? o.post) };
                const eqNow = typeof a.sdk.getEquipment === 'function' ? a.sdk.getEquipment() : a.sdk.getState()?.equipment ?? [];
                const invNow = a.sdk.getInventory();
                const needsReplacementGlory = !fresh && startWornGlory
                    && !pack.items.some(r => (ITEMS.glory as readonly number[]).includes(r.id))
                    && ![...eqNow, ...invNow].some(i => (ITEMS.glory as readonly number[]).includes(i.id));
                const tripPack = needsReplacementGlory
                    ? { ...pack, items: [...pack.items, { id: ITEMS.glory[0], count: 1, minCharges: 1, maxSlots: 1 }] }
                    : pack;
                const bankRun = bankTrip(bankNear(targetAim.x), targetAim, tripPack, kit, () => !going(), bankEaten, {
                    altar: process.env.SQUAD_TRIP_ALTAR === '1',
                    prayerFloor: Number(process.env.SQUAD_TRIP_PRAYER_FLOOR ?? '0.7'),
                    minFood: squadStartFood(0, pack.food).floor,
                    requireEscape: startHasEscape,
                    log: l => o.log(`[${s.name}] SQUAD ${l}`),
                    route: from => marchLegs(from, targetAim),
                    beforeReturn: async isFresh => {
                        if (!isFresh && startWornGlory && !(typeof a.sdk.getEquipment === 'function' ? a.sdk.getEquipment() : a.sdk.getState()?.equipment ?? []).some(e => (ITEMS.glory as readonly number[]).includes(e.id))) {
                            const invGlory = a.sdk.getInventory().find(i => (ITEMS.glory as readonly number[]).includes(i.id));
                            const wearOp = invGlory?.optionsWithIndex?.find(x => /^(Wield|Wear)$/i.test(x.text));
                            if (invGlory && wearOp) { await a.sdk.sendUseItem(invGlory.slot, wearOp.opIndex); await nextTick(a); }
                        }
                        if (isFresh && o.useRally) {
                            o.onRallyReady?.(a.name);
                            await locs.withoutLocs(() => o.waitForRally?.(a, () => !going()) ?? Promise.resolve());
                        }
                    },
                    skipReturn: isFresh => isFresh && !!o.useRally,
                });
                return await bankRun(a, fresh);
            });
        } finally {
            o.tripping?.delete(s.name);
        }
    };
    const walker = await sessionWalker(s);
    // A death: with deaths left (SQUAD_MAX_DEATHS, `maxDeaths`) the account respawns, walks to the bank, wears its starting kit and eats up
    // (rekitAfterDeath), restocks its pack and walks back to the post. It returns false when it is over the limit or the re-kit stopped.
    const recover = async (): Promise<boolean> => {
        stats.deaths++;
        try { o.onDeath?.(lastTile); } catch (error) { o.log(`[${s.name}] SQUAD death ledger write failed: ${String(error)}`); }
        if (o.run && ++o.run.deaths >= o.run.limit) { o.log(`[${s.name}] SQUAD death ${o.run.deaths} of the run reaches the run limit of ${o.run.limit}`); return false; }
        if (stats.deaths > (o.maxDeaths ?? 0)) { o.log(`[${s.name}] SQUAD death ${stats.deaths}: over the limit of ${o.maxDeaths ?? 0}`); return false; }
        const rec = await locs.withLocs(() => rekitAfterDeath(s, { lifeBefore: life0, diedNear: lastTile, wornAtStart, stop: () => !going(), log: l => o.log(`[${s.name}] ${l}`), bank: bankNear(o.post.x) }));
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
    const radarMove = () => {
        if (!o.threats?.act) return false;
        const pos = me();
        return o.threats.step(s.tick()).actions.some(a =>
            a.kind === 'retreat'
            || (a.kind === 'single-way' && (!pos || needsSingleWayMove(pos, a.to))),
        );
    };
    const alliesSet = new Set(o.allies.map(a => a.toLowerCase()));
    const recentHitters = new Map<number, number>();
    let seenCombatEv = 0;
    const fallbackAction = () => {
        const pos = me();
        if (!pos) return { plan: 'out' as const, enemyCount: 0, allyCount: 0 };
        const nowTick = s.tick();
        for (const [idx, t] of recentHitters) if (nowTick - t > 8) recentHitters.delete(idx);
        const curView = s.sdk.getState()?.nearbyPlayers ?? [];
        const curSelf = { x: pos.worldX, z: pos.worldZ, combatLevel: pos.combatLevel };
        const clientView = s.client as { localPlayer?: unknown; players?: unknown[]; selfSlot?: number } | undefined;
        const selfIndex = typeof clientView?.selfSlot === 'number' && Number.isSafeInteger(clientView.selfSlot) && clientView.selfSlot >= 0
            ? clientView.selfSlot
            : (clientView?.players && clientView.localPlayer ? clientView.players.indexOf(clientView.localPlayer) : -1);
        const enemies = curView.filter(q => !alliesSet.has(q.name.toLowerCase()) && q.distance <= 10 && attackable(curSelf, { z: q.z, combatLevel: q.combatLevel }));
        const enemyCount = enemies.length;
        const targetingMe = enemies.filter(q =>
            (selfIndex >= 0 && q.combatTargetType === 'player' && q.combatTargetIndex === selfIndex)
            || ((recentHitters.get(q.index) ?? -999) >= nowTick - 8)
        ).length;
        const allyCount = curView.filter(q => alliesSet.has(q.name.toLowerCase()) && q.distance <= 10).length;
        const invNow = s.sdk.getInventory();
        const plan = squadFallbackPlan({
            z: pos.worldZ, hp: pos.hp, maxHp: pos.maxHp,
            foodCount: invNow.filter(f => f.optionsWithIndex.some(op => /^eat$/i.test(op.text))).length,
            packFood: pack.food,
            enemyCount, allyCount, targetingMe, inMulti: isMulti(pos.worldX, pos.worldZ),
            hasGlory: [...invNow, ...s.sdk.getEquipment()].some(i => /^amulet of glory\([1-4]\)$/i.test(i.name)),
            hasTeleport: !!squadEscapeSpell(pos.worldZ, invNow, s.sdk.getEquipment().map(e => e.id), s.sdk.getSkill('Magic')?.level ?? 1),
        });
        return { plan, enemyCount, allyCount };
    };
    const fallbackDue = () => {
        const { plan } = fallbackAction();
        return plan !== 'hold' && plan !== 'out';
    };
    let singleUntil = -1;
    const skip = new Map<string, number>();
    let enteredWilderness = false;
    let curInterlopers = new Set<string>();
    let inFight = false, inRescue = false;
    const rescueOpts = {
        protect: () => (o.threats?.act ? protectOf(o.threats.step(s.tick()).actions, s.name) : null),
        protectItem: () => o.options.protectItem !== false && ownSkull(s.client) === true,
    };
    const wildSurvival = createWildSurvival(s, {
        protect: rescueOpts.protect,
        protectItem: rescueOpts.protectItem,
        eatBelow: 76,
        comboBelow: 55,
    });
    const runRescue = async () => {
        inRescue = true;
        try { return await locs.withLocs(() => rescue(s, o.log, o.stopped, false, rescueOpts)); }
        finally { inRescue = false; }
    };
    const splitFor = (
        pos: { worldX: number; worldZ: number; combatLevel: number },
        curView: readonly { name: string; x?: number; z?: number; combatLevel?: number }[],
        cand: { name?: string; x?: number; z?: number },
        activeTargetsSet: ReadonlySet<string>,
    ): boolean => {
        const aimTile = o.aim ?? o.post;
        const curSelf = { x: pos.worldX, z: pos.worldZ, combatLevel: pos.combatLevel };
        const hasMultiTargetInView = curView.some(q =>
            activeTargetsSet.has(q.name.toLowerCase())
            && q.x !== undefined && q.z !== undefined && isMulti(q.x, q.z)
            && attackable(curSelf, { z: q.z, combatLevel: q.combatLevel ?? pos.combatLevel }),
        );
        const nowTick = s.tick();
        const coh = o.cohesion?.snapshot(nowTick, s.name.toLowerCase());
        const focusSnap = o.focus?.snapshot(nowTick);
        return shouldBreakSingleWayChase({
            now: nowTick,
            singleUntil,
            aimInMulti: isMulti(aimTile.x, aimTile.z),
            self: { x: pos.worldX, z: pos.worldZ, inMulti: isMulti(pos.worldX, pos.worldZ) },
            target: cand,
            hasMultiTargetInView,
            focusInMulti: focusSnap?.inMulti,
            multiAllyCount: coh?.multiAllyCount ?? 0,
            anyAllyHasMultiTarget: coh?.anyMultiTarget ?? false,
            anchor: coh?.multiAnchor ?? aimTile,
            isInterloper: !!cand.name && curInterlopers.has(cand.name.toLowerCase()),
        });
    };
    const unwatch = s.onTick(() => {
        const stTick = s.sdk.getState();
        const pos = stTick?.player;
        const hp = pos?.hp; if (hp !== undefined) { if (hp < lastHp) { stats.taken += lastHp - hp; damagedAt = s.tick(); } lastHp = hp; minHp = minHp === undefined ? hp : Math.min(minHp, hp); }
        for (const e of stTick?.combatEvents ?? []) {
            const id = e.observationId ?? e.tick;
            if (id <= seenCombatEv) continue;
            seenCombatEv = id;
            if (e.type === 'damage_taken' && e.sourceType === 'other_player' && typeof e.sourceIndex === 'number' && e.sourceIndex >= 0) {
                recentHitters.set(e.sourceIndex, s.tick());
            }
        }
        if (!inFight && !inRescue && going()) wildSurvival.step(s.tick());
        if (pos && o.cohesion) {
            const stNow = s.sdk.getState();
            const curSelf = { x: pos.worldX, z: pos.worldZ, combatLevel: pos.combatLevel };
            const activeTargetsSet = curInterlopers.size ? new Set([...o.targets, ...curInterlopers]) : o.targets;
            const hasMultiTarget = (stNow?.nearbyPlayers ?? []).some(q =>
                activeTargetsSet.has(q.name.toLowerCase())
                && q.x !== undefined && q.z !== undefined && isMulti(q.x, q.z)
                && attackable(curSelf, { z: q.z, combatLevel: q.combatLevel }),
            );
            o.cohesion.update(s.name, { x: pos.worldX, z: pos.worldZ, inMulti: isMulti(pos.worldX, pos.worldZ), hasMultiTarget, tick: s.tick() });
        }
        for (const m of s.sdk.getState()?.gameMessages ?? []) { const id = m.observationId ?? m.tick; if (id <= seenMessage) continue; seenMessage = id; if (/already under attack|already fighting your opponent/i.test(m.text)) refusedAt = s.tick(); }
    });
    try {
        await disableAutoRetaliate(s);
        while (going()) {
            const p = me();
            if (!p) { if (!await nextTick(s)) break; continue; }
            if (diedNow(p)) {
                o.log(`[${s.name}] SQUAD died`);
                if (await recover()) continue;
                stats.died = true; break;
            }
            lastTile = { x: p.worldX, z: p.worldZ };
            if (p.hp < prevHp) damagedAt = s.tick();
            prevHp = p.hp;
            // Out of the Wilderness (a walk out, a teleport): to the bank and back to the post.
            if (wildernessLevel(p.worldZ) > 0) enteredWilderness = true;
            if (outTripDue(p.worldZ, enteredWilderness, stats.trips)) {
                enteredWilderness = false;
                if (stats.trips >= o.trips) {
                    await disableAutoRetaliate(s);
                    await curePoisonAndEat(s, () => o.exitStopped?.() ?? false, true);
                    if (typeof s.sdk.sendWalk === 'function') void s.sdk.sendWalk(p.worldX, p.worldZ);
                    o.log(`[${s.name}] SQUAD no trips left`);
                    break;
                }
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
                const retreated = await runRescue();
                if (!retreated) { retreatEnded(); break; }
                escapes++;
                continue;
            }
            if (threat && o.threats!.act) {
                // A team on a multi-way tile: to the nearest single-way tile (a walk that fails is the retreat), and stay there while it lasts.
                const single = threat.actions.find(a => a.kind === 'single-way') as Extract<typeof threat.actions[number], { kind: 'single-way' }> | undefined;
                if (single) {
                    singleUntil = now + 120;
                    if (needsSingleWayMove(p, single.to) && !fallbackDue()) {
                        o.threats!.acted(now);
                        if (protect) holdProtect(s, protect, now);
                        o.log(`[${s.name}] SQUAD threat single-way: ${single.reason}, to ${single.to.x},${single.to.z}`);
                        let stuckTicks = 0, lastX = p.worldX, lastZ = p.worldZ, checkedTick = s.tick();
                        const walkDist = Math.max(Math.abs(p.worldX - single.to.x), Math.abs(p.worldZ - single.to.z));
                        const walked = await locs.withLocs(() => walkPath(walker, [{ ...single.to, tol: 0 }], {
                            maxTicks: Math.min(20, Math.max(8, walkDist * 2 + 4)),
                            idleMs: 9000,
                            stop: () => {
                                if (!going()) return true;
                                const q = me();
                                if (!q || !isMulti(q.worldX, q.worldZ)) return true;
                                if (fallbackDue() || !!retreatOf(o.threats!.step(s.tick()).actions)) return true;
                                const tNow = s.tick();
                                if (tNow > checkedTick) {
                                    stuckTicks = q.worldX === lastX && q.worldZ === lastZ ? stuckTicks + (tNow - checkedTick) : 0;
                                    lastX = q.worldX; lastZ = q.worldZ; checkedTick = tNow;
                                }
                                return stuckTicks >= 3;
                            },
                        }));
                        const afterWalk = me();
                        if (!walked.ok && (!afterWalk || needsSingleWayMove(afterWalk, single.to))) {
                            o.log(`[${s.name}] SQUAD threat single-way walk failed, retreat`);
                            if (!await runRescue()) { retreatEnded(); break; }
                            escapes++;
                        }
                        continue;
                    }
                }
                // The armour that defends better against the threat's style, from the pack: worn before the next fight, and put back after the threat has been gone for 60 ticks.
            }
            const { plan: fallback, enemyCount, allyCount } = fallbackAction();
            if (fallback !== 'hold' && fallback !== 'out') {
                o.log(`[${s.name}] SQUAD coordinated fallback (${fallback}) hp=${p.hp} enemies=${enemyCount} allies=${allyCount}`);
                const retreated = await runRescue();
                if (!retreated) { retreatEnded(); break; }
                escapes++;
                continue;
            }
            if (threat && o.threats!.act) {
                if (await swapper.step(s, threat.actions, now, tickOf, o.log)) continue;
            }
            const view = s.sdk.getState()?.nearbyPlayers ?? [];
            const health = (q: { index: number }) => { const seen = observePlayer(s.client, q.index); return seen && seen.totalHealth > 0 ? seen.health / seen.totalHealth : 1; };
            const stunned = new Set(view.filter(q => observePlayer(s.client, q.index)?.spotanim === STUNNED_SHOVE_SPOTANIM).map(q => q.name.toLowerCase()));
            const self = { x: p.worldX, z: p.worldZ, combatLevel: p.combatLevel };
            // Interlopers (dangerous players that are not the squad's targets) become targets, first: lowest health first among them. When they are dead or gone
            // the squad goes back to its own targets.
            const interlopers = new Set((threat && o.threats!.act ? threat.interlopers : []).map(n => n.toLowerCase()));
            if (singleUntil >= 0 && interlopers.size > 0) singleUntil = Math.max(singleUntil, now + 120);
            curInterlopers = interlopers;
            const allTargets = interlopers.size ? new Set([...o.targets, ...interlopers]) : o.targets;
            const aim = o.aim ?? o.post;
            const aimInMulti = isMulti(aim.x, aim.z);
            const filteredView = o.pull !== false && aimInMulti && now >= singleUntil
                ? view.filter(q => !allTargets.has(q.name.toLowerCase()) || !splitFor(p, view, q, allTargets))
                : view;
            const focusArgs = { view: filteredView, targets: allTargets, priority: interlopers, health, skip: new Set(skip.keys()), me: self, inMulti: isMulti(p.worldX, p.worldZ), preferMulti: aimInMulti && now >= singleUntil, stunned };
            const target = o.focus ? o.focus.pick({ ...focusArgs, now }) : pickSquadFocus(focusArgs);
            if (!target) {
                // No prayer while it waits: an active prayer drains with no fight loop to flick it (in one live meeting
                // our prayer ran out at about tick 730), and the fight loop puts them on again. One input each 3 ticks.
                // A threat that can hit us keeps the protect prayer of its style on (holdProtect), at the cost of the drain.
                // The protect prayer stays on while a target of the squad stands within reach (a skipped gang member next to us) or we took damage
                // in the last 10 ticks (`keepPrayer`).
                if (protect) holdProtect(s, protect, s.tick());
                else if (!keepPrayer({ view, targets: o.targets, now: s.tick(), damagedAt, points: s.sdk.getSkill('Prayer')?.level, base: s.sdk.getSkill('Prayer')?.baseLevel }) && s.tick() % 3 === 0) for (const [i, on] of (s.sdk.getState()?.prayers.activePrayers ?? []).entries()) if (on) void s.sdk.sendTogglePrayer(i);
                // Back to the post between fights.
                // At least a tick each pass: a walk to a step that cannot be reached fails at once.
                if (now >= singleUntil && Math.max(Math.abs(p.worldX - o.post.x), Math.abs(p.worldZ - o.post.z)) > 2) {
                    const stepTarget = { ...o.post };
                    await locs.withLocs(() => walkPath(walker, [{ ...stepTarget, tol: 2 }], { maxTicks: 60, idleMs: 9000, stop: () => {
                        if (!going() || stepTarget.x !== o.post.x || stepTarget.z !== o.post.z || fallbackDue() || radarMove()) return true;
                        const q = me(), curView = s.sdk.getState()?.nearbyPlayers ?? [];
                        if (!q) return false;
                        const curSelf = { x: q.worldX, z: q.worldZ, combatLevel: q.combatLevel };
                        const tNow = s.tick();
                        const cand = pickSquadFocus({ view: curView, targets: allTargets, priority: interlopers, health, skip: new Set(skip.keys()), me: curSelf, inMulti: isMulti(q.worldX, q.worldZ), preferMulti: aimInMulti && tNow >= singleUntil, stunned });
                        if (!cand) return false;
                        if (o.pull !== false && splitFor(q, curView, cand, allTargets)) return false;
                        if (o.pull !== false && aimInMulti && tNow >= singleUntil && !isMulti(q.worldX, q.worldZ)) return false;
                        return true;
                    } }));
                }
                if (!await nextTick(s)) break;
                continue;
            }
            // Pull: on a single-way tile with the post multi-way (and within PULL_RANGE tiles), walk on into multi-way and eat on the
            // way instead of fighting there; on a single-way tile the game lets one attacker at a time on each account,
            // so the squad cannot concentrate.
            // The pull aims at the march's goal (`aim`), not its current step, which can be a single-way tile.
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
                await locs.withLocs(() => walkPath(walker, [{ ...aim, tol: 2 }], { maxTicks: 30, idleMs: 9000, stop: () => !going() || low() || fallbackDue() || radarMove() || (() => { const q = me(); return !!q && isMulti(q.worldX, q.worldZ); })() }));
                // At least a tick each pass: a walk that stops at once (low HP with no food) must not spin the loop.
                if (!await nextTick(s)) break;
                continue;
            }
            const began = s.tick();
            stats.fights++;
            const stunShare = o.stunShareFor?.(target.name.toLowerCase());
            const freezeShare = o.freezeShareFor?.(target.name.toLowerCase());
            const focusYield = () => {
                const stNow = s.sdk.getState(), pos = stNow?.player;
                if (!pos) return false;
                const curView = stNow?.nearbyPlayers ?? [];
                const curTarget = curView.find(q => q.name.toLowerCase() === target.name.toLowerCase());
                if (!curTarget) return false;
                if (o.pull !== false && s.tick() > began && splitFor(pos, curView, curTarget, allTargets)) return true;
                if (!o.focus) return false;
                const snap = o.focus.snapshot(s.tick());
                if (!snap || snap.target === target.name.toLowerCase()) return false;
                const snapTarget = curView.find(q => q.name.toLowerCase() === snap.target);
                if (!snapTarget || !attackable({ z: pos.worldZ, combatLevel: pos.combatLevel }, { z: snapTarget.z, combatLevel: snapTarget.combatLevel })) return false;
                const stunNow = new Set(curView.filter(q => observePlayer(s.client, q.index)?.spotanim === STUNNED_SHOVE_SPOTANIM).map(q => q.name.toLowerCase()));
                return shouldSwitchFocus({
                    inMulti: isMulti(pos.worldX, pos.worldZ),
                    currentName: target.name,
                    currentHp: health(curTarget),
                    currentInMulti: curTarget.x !== undefined && curTarget.z !== undefined ? isMulti(curTarget.x, curTarget.z) : isMulti(pos.worldX, pos.worldZ),
                    focusName: snap.target,
                    focusHp: health(snapTarget),
                    focusInMulti: snap.inMulti,
                    focusStunned: stunNow.has(snap.target) || snap.stunned,
                    elapsedTicks: s.tick() - began,
                });
            };
            const targetInSingle = target.x !== undefined && target.z !== undefined && !isMulti(target.x, target.z);
            const singleHold = (now < singleUntil && !isMulti(p.worldX, p.worldZ) && target.x !== undefined && target.z !== undefined && isMulti(target.x, target.z))
                || (o.pull !== false && aimInMulti && now >= singleUntil && isMulti(p.worldX, p.worldZ) && targetInSingle);
            const singleStyles = singleHold ? (['ranged', 'magic'] as const).filter(stName => (o.options.kit[stName]?.length ?? 0) > 0) : [];
            let lastFreezeCastTick = -100, freezePending = false;
            inFight = true;
            const r = await fightPlayer(s, target.name, {
                ...o.options,
                ...(singleStyles.length ? {
                    rotation: [...singleStyles],
                    chase: false,
                    ...(o.options.spec && o.options.spec.style !== 'ranged' && o.options.spec.style !== 'magic' ? { spec: undefined } : {}),
                } : {}),
                ...(o.threats?.act ? { threatPrayer: () => protectOf(o.threats!.step(s.tick()).actions, s.name) } : {}),
                ...(stunShare ? { stunShare } : {}),
                ...(freezeShare ? { freezeShare } : {}),
                ...(o.burstOnHold !== undefined ? { burstOnHold: o.burstOnHold } : {}),
                ...(o.burstOnStun !== undefined ? { burstOnStun: o.burstOnStun } : {}),
                ...(o.stunSpec ? { stunSpec: o.stunSpec } : {}),
                allies: o.allies, cap: Math.max(1, o.deadline - s.tick()), stop: () => !going() || refusedAt > began || radarMove() || fallbackDue() || focusYield(),
                log: l => {
                    if (/^PK freeze cast\b/.test(l)) { lastFreezeCastTick = s.tick(); freezePending = true; }
                    else if (/^PK freeze held\b/.test(l)) { if (freezePending && s.tick() - lastFreezeCastTick <= 4) freezesLanded++; freezePending = false; }
                    else if (/^PK freeze missed\b/.test(l)) { freezePending = false; }
                    o.log(`[${s.name}] ${l}`);
                },
            }).finally(() => { inFight = false; });
            freezesCast += r.freezes ?? 0;
            if (r.outcome === 'escaped') escapes++;
            const urgentEscape = radarMove() || fallbackDue();
            // The armour that a freeze stripped goes back on (pk.ts rewearStart).
            if (going() && r.outcome !== 'session ended' && !urgentEscape) await rewearStart(s, wornAtStart.map(w => w.id), l => o.log(`[${s.name}] ${l}`));
            if (refusedAt > began) skip.set(target.name.toLowerCase(), s.tick() + 8);
            const gone = !(s.sdk.getState()?.nearbyPlayers ?? []).some(q => q.name.toLowerCase() === target.name.toLowerCase());
            if (r.outcome === 'kill' || gone) o.focus?.clear(target.name);
            if (r.outcome === 'kill') { stats.kills++; killTicks += r.ticks ?? 0; if (interlopers.has(target.name.toLowerCase())) stats.interlopers = (stats.interlopers ?? 0) + 1; }
            if (r.receipt) stats.receipts.push(r.receipt);
            const activeInterlopers = o.threats?.act ? o.threats.step(s.tick()).interlopers.length : 0;
            if (o.pickup && !urgentEscape && s.tick() >= singleUntil && activeInterlopers === 0 && (r.outcome === 'kill' || gone)) {
                const got = await pickUp(s, wanted, { radius: 3, maxTicks: 30, wait: 6, stop: () => o.stopped() || fallbackDue() || radarMove() || (me()?.hp ?? 99) <= 65 });
                recordKillLoot(r, got);
                for (const [id, n] of Object.entries(got)) stats.picked[id] = (stats.picked[id] ?? 0) + n;
            }
            if (r.outcome === 'died') { if (await recover()) continue; stats.died = true; break; }
            const qAfter = me();
            if (qAfter && diedNow(qAfter)) { if (await recover()) continue; stats.died = true; break; }
            if (urgentEscape && (s.tick() > began || r.outcome !== 'timeout')) continue;
            if (!await nextTick(s)) break;
        }
        const endTile = me();
        if (!stats.died && endTile && wildernessLevel(endTile.worldZ) > 0 && !(o.exitStopped?.() ?? o.stopped())) {
            inRescue = true;
            try {
                const escaped = await locs.withLocs(() => rescue(s, o.log, o.exitStopped ?? o.stopped, false, rescueOpts));
                if (!escaped) retreatEnded();
            } finally {
                inRescue = false;
            }
        }
    } finally {
        const qEnd = me();
        if (!stats.died && qEnd && diedNow(qEnd)) stats.died = true;
        unwatch();
        o.cohesion?.remove(s.name);
        if (origSendUseItem) s.sdk.sendUseItem = origSendUseItem;
        if (origDirect) s.direct = origDirect;
    }
    stats.killTicks = killTicks;
    if (minHp !== undefined) stats.minHp = minHp;
    stats.sharksEaten = sharksEaten;
    stats.karamEaten = karamEaten;
    stats.freezesCast = freezesCast;
    stats.freezesLanded = freezesLanded;
    stats.escapes = escapes;
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
    const exitSurvival = createWildSurvival(s, { eatBelow: 76, comboBelow: 55 });
    const unwatchExit = typeof s.onTick === 'function' ? s.onTick(() => { if (!died()) exitSurvival.step(s.tick()); }) : () => {};
    let r: Awaited<ReturnType<typeof walkPath>> | null = null;
    try {
        r = died() ? null : await walkPath(await sessionWalker(s), [{ ...bankNear(me()?.worldX ?? p.worldX), tol: 2 }], { maxTicks: 400, idleMs: 9000, stop: died });
    } finally {
        unwatchExit();
    }
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
    // SQUAD_TARGET_COUNT=<n>: only the first n gang accounts are the squad's targets (the clones of the gang); the others are a third party
    // that the squad does not expect (an attacker that arrives in the middle of the fight): the threat radar treats it as a threat.
    const targetCount = Number(get('SQUAD_TARGET_COUNT', '-1'));
    const targets = new Set((gangSize ? (targetCount >= 0 ? gangNames.slice(0, targetCount) : gangNames) : get('TARGETS', GANG.join(',')).split(',')).map(t => t.trim().toLowerCase()).filter(Boolean));
    // A pause holds before any login: a stop file present at the start logs no account in (openBot checks stop files
    // only after its login, and a login puts an account parked in the Wilderness back in the world).
    // The death ledger: a squad whose account or members died too often in the last 24 h on a live server does not start. The
    // supervisor reads `RESULT fail died` as a death, so the swarm holds it until a person clears the ledger.
    // The server comes from bot.env, which openBot restores from the vault later: the ledger restores it first. An unreadable bot.env is a fail line.
    const { accountServerBeforeLogin } = await import('./pk-roam');
    let squadServer = '';
    try { squadServer = accountServerBeforeLogin(ours[0]!); } catch (e) { console.log(`RESULT fail no server for ${ours[0]}: ${String(e).replace(/\s+/g, ' ').slice(0, 160)}`); process.exit(2); }
    const runDeaths = { deaths: 0, limit: pvpDeathLimits().perRun };
    // A live start needs the floor plus one GiB for each bot of ours (the bench on a local server does not).
    if (!isLocalServer(squadServer)) {
        const gate = squadMemoryGate(os.freemem() / 2 ** 30, ours.length);
        if (!gate.ok) { console.log(`RESULT fail host memory: ${(os.freemem() / 2 ** 30).toFixed(1)} GiB free, ${gate.needGB} needed (floor ${FREE_FLOOR_GB} + ${SQUAD_BOT_GB} for each of ${ours.length} accounts)`); process.exit(HOST_DEFERRED_EXIT); }
    }
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
        // The profile and the extra options of the members: sparOptions throws on an unknown profile and on bad JSON. The kit comes from each member's state after login, so this
        // call uses an empty one; it only checks the settings.
        sparOptions(get('SQUAD_PROFILE', 'gang-hunter'), get('SQUAD_OPTS', JSON.stringify(SQUAD_OPTS)), {}, 1200);
    } catch (e) { console.log(`RESULT fail ${e instanceof Error ? e.message : e}`); process.exit(2); }
    const { openBot, finish } = await import('../packages/core/src/bot');
    let halted: string | undefined;
    // A session that ends with no logout of ours (a dropped connection) stops that account only. openBot's default
    // finishes the process, and in the third live pilot one account's drop logged the other three out in the Wilderness.
    const dropped = new Map<string, string>();
    // RESCUE=1 (default): a member that drops is logged in again at once (`startRescue`), not at the end of the run: the others
    // fight on while it is in the Wilderness without a session.
    let startRescue: (name: string) => void = () => {};
    const { onStop, onSessionEnd } = squadStopHandlers(detail => { halted ??= detail; }, dropped, line => console.log(line), name => startRescue(name));
    let all: Session[];
    if (gangSize > 0) {
        const { tickWaits } = await import('../packages/core/src/tick-stream');
        tickWaits.active++;
        try {
            all = await openSquad(names, name => openBot(name, { onStop, onSessionEnd, continueAfterDeath: true }), (sessions, detail) => finish(sessions, false, detail));
        } finally {
            tickWaits.active--;
        }
    } else {
        all = await openSquad(names, name => openBot(name, { onStop, onSessionEnd, continueAfterDeath: true }), (sessions, detail) => finish(sessions, false, detail));
    }
    const squad = all.slice(0, ours.length).map(squadWorkSession), gang = all.slice(ours.length).map(squadWorkSession);
    const pickup = get('PICKUP', '1') === '1';
    const squadLocs = new Map<Session, BenchLocController>();
    if (gang.length > 0) {
        for (const s of squad) squadLocs.set(s, configureBenchSession(s, { isGang: false, pickup }));
        for (const g of gang) configureBenchSession(g, { isGang: true, pickup: false });
    }
    const rescuing = new Set<string>(), rescues: Promise<string[]>[] = [];
    startRescue = name => {
        // Only a member of ours: a gang account of the bench that ends its session is no one to rescue.
        if (get('RESCUE', '1') !== '1' || rescuing.has(name) || !ours.includes(name)) return;
        rescuing.add(name);
        rescues.push(rescueDropped([name], all, (n, onStopRescue) => openBot(n, { onStop: onStopRescue, onSessionEnd: (s, detail) => onStopRescue(s, detail) }), line => console.log(line)));
    };
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
    // SQUAD_GANG_PREY=<member index>,...: gang account i takes the member that the list names for it (list[i mod its length]),
    // so a bench gang can pick the members that the live gang picked (in the first live squad run it attacked only the two
    // members in dragonhide). It implies the split.
    const preyList = (env.SQUAD_GANG_PREY ?? '').split(',').filter(x => /^\d+$/.test(x)).map(Number);
    const split = env.SQUAD_GANG_SPLIT === '1' || preyList.length > 0;
    const gangRuns = gang.map(async (g, gi) => {
        const preyAt = preyList.length ? preyList[gi % preyList.length]! % squad.length : gi % squad.length;
        const mine = squad[preyAt]!.name.toLowerCase();
        // SQUAD_GANG_KIT=<kit>+<kit>+...: the kit (scripts/pk-kits.ts) of gang account i is list[i mod its length], and
        // SQUAD_GANG_PROFILE the fight profile of the gang (default ganker-live, the dagger gang). Both turn the gang accounts into
        // the attacker of a bench threat: a mage, a ranger, a pure or a team (research/gang-clones.md, "The attackers").
        const gangKit = (env.SQUAD_GANG_KIT ?? '').split('+').filter(Boolean), kitName = gangKit.length ? gangKit[gi % gangKit.length]! : undefined;
        // SQUAD_GANG_PROFILES=<profile>+<profile>+...: the profile of gang account i, in place of SQUAD_GANG_PROFILE (the three clones
        // take clone-goondelf, clone-ligma and clone-sugma, each from its own record, and an attacker takes attacker-fight).
        const gangProfiles = (env.SQUAD_GANG_PROFILES ?? '').split('+').filter(Boolean);
        const opts = sparOptions(gangProfiles.length ? gangProfiles[gi % gangProfiles.length]! : env.SQUAD_GANG_PROFILE ?? 'ganker-live', env.SPAR_B_OPTS, kitName ? kitSwitches(kitName) : kitFrom(g.sdk.getState()?.equipment ?? [], g.sdk.getState()?.inventory ?? []), 1200, kitName ? kitOptions(kitName) : {});
        while (!stopped() && g.tick() < deadline) {
            const me = g.sdk.getState()?.player;
            if (!me || wildernessLevel(me.worldZ) === 0) break;
            const seenOurs = (g.sdk.getState()?.nearbyPlayers ?? []).filter(q => ours.some(n => n.toLowerCase() === q.name.toLowerCase())).sort((a, b) => a.distance - b.distance);
            const prey = split ? seenOurs.find(q => q.name.toLowerCase() === mine) ?? seenOurs[0] : seenOurs[0];
            if (!prey) {
                // SQUAD_GANG_HUNT=1: like the live gang, which the world feed takes to its target (it met the first live
                // pilot 30 tiles from the post), it walks toward the nearest of ours in the Wilderness.
                if (env.SQUAD_GANG_HUNT === '1' && g.tick() % 4 === 0) {
                    const far = (split ? [squad[preyAt]!] : squad).map(q => q.sdk.getState()?.player).filter((q): q is NonNullable<typeof q> => !!q && wildernessLevel(q.worldZ) > 0)
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
    const initialOutside = squad.filter(q => wildernessLevel(q.sdk.getState()?.player?.worldZ ?? 0) === 0);
    const useRally = get('MARCH', '1') === '1' && get('RALLY', '1') === '1' && initialOutside.length > 0;
    const bankAtStart = bankNear(aim.x);
    const rallyWaiters = new Set(initialOutside.map(q => q.name));
    const ralliedSet = new Set<string>();
    const rallyMaxDist = initialOutside.reduce((mx, q) => {
        const p = q.sdk.getState()?.player;
        return p ? Math.max(mx, Math.max(Math.abs(p.worldX - bankAtStart.x), Math.abs(p.worldZ - bankAtStart.z))) : mx;
    }, 0);
    const rallyTimeoutTicks = Math.min(1200, Math.max(120, Math.round(rallyMaxDist * 1.6) + 80));
    let rallied = !useRally, rallyWaitStart = -1;
    let route: { x: number; z: number }[] = [], stepAt = 0;
    const centroid = (preferWilderness = false, customExempt?: ReadonlySet<string>) => {
        const exempt = customExempt ?? new Set([...dropped.keys(), ...tripping, ...finished]);
        return activeCentroid(
            squad.map(q => { const p = q.sdk.getState()?.player; return { name: q.name, at: p ? { x: p.worldX, z: p.worldZ } : undefined }; }),
            exempt,
            preferWilderness,
        ) ?? bankAtStart;
    };
    const march = (to: { x: number; z: number }, fromRallied = false) => {
        aim.x = to.x; aim.z = to.z;
        const from = fromRallied && ralliedSet.size
            ? centroid(false, new Set(squad.map(q => q.name).filter(n => !ralliedSet.has(n))))
            : centroid(wildernessLevel(to.z) > 0 && squad.some(q => !dropped.has(q.name) && !finished.has(q.name) && wildernessLevel(q.sdk.getState()?.player?.worldZ ?? 0) > 0));
        route = marchPlan(from, to, step);
        const next = route.shift() ?? to;
        post.x = next.x; post.z = next.z; stepAt = Math.max(...squad.map(s => s.tick()));
        log(`SQUAD march to ${to.x},${to.z} in ${route.length + 1} steps: ${[next, ...route].map(r => `${r.x},${r.z}`).join(' ')}`);
    };
    const tryReleaseRally = (tick: number): boolean => {
        if (rallied) return true;
        const missing = [...rallyWaiters].filter(n => !ralliedSet.has(n) && !dropped.has(n) && !finished.has(n));
        const timedOut = rallyWaitStart >= 0 && tick - rallyWaitStart >= rallyTimeoutTicks;
        if (missing.length > 0 && !timedOut) return false;
        rallied = true;
        const readyNames = [...ralliedSet];
        log(`SQUAD rallied ${readyNames.length}/${rallyWaiters.size} (${readyNames.join(',')})${timedOut && missing.length ? ` timeout waiting for ${missing.join(',')}` : ''}`);
        const c = centroid(false, ralliedSet.size ? new Set(squad.map(q => q.name).filter(n => !ralliedSet.has(n))) : undefined);
        if (Math.max(Math.abs(c.x - aim.x), Math.abs(c.z - aim.z)) > step) march({ ...aim }, true);
        return true;
    };
    const unwatchMarch = watchSquadTicks(squad, name => dropped.has(name), tick => {
        tryReleaseRally(tick);
        if (!route.length) return;
        // Every member within 4 tiles of the step, but a dropped one and one on a later trip: a member still at the bank outside the
        // Wilderness counted as close, and the first walkers went in alone.
        const close = marchClose(squad.map(q => { const p = q.sdk.getState()?.player; return { name: q.name, at: p ? { x: p.worldX, z: p.worldZ } : undefined }; }), post,
            new Set([...dropped.keys(), ...tripping, ...finished]));
        const stepLimit = post.z <= 3519 ? 180 : 60;
        if (!close && tick - stepAt < stepLimit) return;
        const next = route.shift()!;
        post.x = next.x; post.z = next.z; stepAt = tick;
        log(`SQUAD march step ${next.x},${next.z} at tick ${tick}${close ? '' : ` (waited ${stepLimit} ticks)`}`);
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
        let unseen = 0, lastFollowReplan = -1;
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
            if (!tile || !shouldFollowReplan({ rallied, routePending: route.length > 0, currentAim: aim, nextTile: tile, tick, lastReplanTick: lastFollowReplan })) return;
            lastFollowReplan = tick;
            if (where.length) log(`SQUAD follow: targets at ${where.map(t => `${t.name} ${t.x},${t.z}`).join(' ')}`);
            march(tile);
        });
    }
    // Bench: SQUAD_DROP_AT=<ticks> closes the first account's session at that tick, as a dropped connection.
    const dropAt = Number(env.SQUAD_DROP_AT ?? 0);
    if (dropAt > 0) { const first = squad[0]!, start = first.tick(); let done = false; squad[1 % squad.length]!.onTick(() => { if (!done && first.tick() - start >= dropAt) { done = true; void first.close(); } }); }
    // Our accounts walk to the post first once any mainland rally finishes.
    if (rallied && get('MARCH', '1') === '1') {
        const c = centroid();
        if (Math.max(Math.abs(c.x - post.x), Math.abs(c.z - post.z)) > step) march({ ...post });
    }
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
    const tankList = (env.SQUAD_TANK ?? '').split(',').filter(x => /^[0-9]+$/.test(x)).map(Number);
    const sharedFocus = createSquadFocus();
    const sharedCohesion = createSquadCohesion();
    const useFreezeShare = get('SQUAD_FREEZE_SHARE', ours.length >= 2 ? '1' : '0') === '1';
    const useBurstHold = get('SQUAD_BURST_HOLD', '0') === '1';
    const waitForRally = async (member: Session, holdStopped: () => boolean) => {
        if (rallyWaitStart < 0) rallyWaitStart = member.tick();
        while (!tryReleaseRally(member.tick()) && !holdStopped() && !stopped() && !dropped.has(member.name)) {
            if (!await nextTick(member)) break;
        }
    };
    const explicitRotation = Object.prototype.hasOwnProperty.call(JSON.parse(optsJson) as object, 'rotation');
    const results = await Promise.all(squad.map(s => {
        const stNow = s.sdk.getState();
        const kit = kitFrom(stNow?.equipment ?? [], stNow?.inventory ?? []);
        const stunSpec = defaultStunSpec(kit);
        const baseOpts = sparOptions(get('SQUAD_PROFILE', 'gang-hunter'), optsJson, kit, 1200);
        return hold(s, {
            targets, post, threats, focus: sharedFocus, cohesion: sharedCohesion, useRally, onRallyReady: name => { ralliedSet.add(name); }, waitForRally,
            // SQUAD_TANK=<member index>,...: the tank lock (bench only): the listed members hold melee and every other member holds
            // ranged. A gang account prays against the weapon of the member it faces (live run 3), so the faced member's melee turns
            // draw Protect from Melee and the bow shots of the others meet no overhead.
            options: { ...baseOpts, ...squadKitFightDefaults(stNow?.equipment ?? [], stNow?.inventory ?? [], baseOpts, undefined, explicitRotation), ...fightOverrides, ...(tankList.length ? { rotation: [tankList.includes(squad.indexOf(s)) ? 'melee' as const : 'ranged' as const] } : {}) },
            ...(useFreezeShare ? { freezeShareFor, burstOnHold: useBurstHold } : {}),
            ...(spearLock ? { stunShareFor, burstOnStun: true, ...(stunSpec && !defaultSpec(kit)?.stun ? { stunSpec } : {}) } : {}),
            allies: ours.filter(n => n !== s.name).map(n => n.toLowerCase()), pickup, pull: get('PULL', '1') === '1', tripping, aim, trips: Number(get('TRIPS', '10')), maxDeaths: maxDeathsOf(get('SQUAD_MAX_DEATHS', '1'), 1), run: runDeaths,
            locs: squadLocs.get(s),
            onDeath: near => { recordPvpDeath({ account: s.name, server: squadServer, at: Date.now(), script: 'scripts/pk-squad.ts', near }); }, deadline,
            stopped: () => stopped() || dropped.has(s.name) || existsSync(`.practice/stop-${s.name}`), exitStopped: () => halted !== undefined || dropped.has(s.name) || existsSync('.practice/stop-pk-squad') || existsSync(`.practice/stop-${s.name}`), killsLeft: () => !maxKills || kills < maxKills, log: l => { if (isKillLine(l)) kills++; log(l); },
        }).finally(() => { finished.add(s.name); });
    }));
    squadDone = true;
    await Promise.all(gangRuns);
    unwatchMarch(); unwatchRadar?.(); unwatchFollow?.();
    closeRadar?.(); closeThreatRadar?.();
    // Live: no account logs out in the Wilderness. The deadline or a stop can end an account's hold mid-fight with
    // its food gone, and a later login on that tile met a PKer: live, KnightRider logged out at the post with 4 HP and
    // died 31 ticks into its next session, skulled, with its whole kit.
    // A dropped account has no session to walk; its rescue (started when it dropped) logs it in again.
    const stranded: string[] = [];
    if (!gang.length) await Promise.all(squad.map(async (s, i) => { if (dropped.has(s.name)) return; const out = await leaveWilderness(s, results[i]!.died); if (out.died) results[i]!.died = true; if (out.why) { log(`[${s.name}] SQUAD ${out.why}`); stranded.push(s.name); } }));
    for (const r of results) console.log(`SQUAD ${JSON.stringify(r)}`);
    console.log(`SQUAD_METRICS ${JSON.stringify(squadMetrics(results))}`);
    const picked: Record<string, number> = {};
    for (const r of results) for (const [id, n] of Object.entries(r.picked)) picked[id] = (picked[id] ?? 0) + n;
    const sum = (f: (r: SquadStats) => number) => results.reduce((n, r) => n + f(r), 0);
    // RESCUE=1 (default): each dropped account logs in again, eats, and leaves the Wilderness by Camelot Teleport
    // (Wilderness 20 or less, runes held) or a walk to the Edgeville bank; one it cannot get out the RESULT names.
    if (get('RESCUE', '1') === '1') { for (const name of dropped.keys()) startRescue(name); stranded.push(...(await Promise.all(rescues)).flat()); }
    else stranded.push(...dropped.keys());
    const end = squadEnd({ accounts: results.length, kills: sum(r => r.kills), gangDied: gang.length ? gang.filter(gangDead).length : undefined, deaths: results.filter(r => r.died).length,
        taken: sum(r => r.taken), trips: sum(r => r.trips), fights: sum(r => r.fights), picked, dropped: [...dropped.keys()], stranded, halted, rekits: results.reduce((n, r) => n + r.rekits, 0), ...(threats ? { interlopers: results.reduce((n, r) => n + (r.interlopers ?? 0), 0) } : {}), receiptProof: killReceiptProof(results.flatMap(r => r.receipts)), diedAccounts: results.filter(r => r.died).map(r => r.name) });
    await settleKillFeed();
    await finish(all, end.ok, end.detail);
}
