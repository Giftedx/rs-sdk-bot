import { PLAIN_FOOD } from '../eat-guard';
import { npcMaxHitEstimate } from '../hp-floor';
import {
    FLEE_RANGE, cheb, invOf, meOf, outOfReach, targetsMe, tileOf,
    type JobSpec, type PathFinder, type Tile, type TileLevel, type WatcherContext,
} from './model';

function pathLen(finder: PathFinder | null, from: TileLevel, to: Tile): number | null {
    if (!finder) return cheb(from, to);
    const pts = finder.findLongPath(from.level, from.x, from.z, to.x, to.z, 200, []);
    if (pts.length === 0) return cheb(from, to) === 0 ? 0 : null;
    const last = pts[pts.length - 1]!;
    if (last.x !== to.x || last.z !== to.z) return null;
    let len = 0, prev: Tile = from;
    for (const q of pts) { len += cheb(prev, q); prev = q; }
    return len;
}

const tileKey = (t: Tile) => `${t.x},${t.z}`;
const RING_REFUSALS = 3;

/**
 * Pick the nearest safe tile outside `range` from `spawn`, avoiding hunting NPCs and the tiles in `skip` (tiles the
 * client refused or the bot could not reach). Null when every candidate is in `skip`.
 * From RING_REFUSALS refused tiles on, the path data disagrees with the client router at this place (a shut door, for
 * example), so the pick skips the ring search and goes to the eight straight-away directions.
 */
function pickFleeTile(ctx: WatcherContext, p: TileLevel, spawn: Tile, range: number, npcAt: Tile, skip: ReadonlySet<string>): Tile | null {
    const st = ctx.state();
    const finder = ctx.getPf();
    const dangerMap = ctx.danger();
    const d = range + 2;
    const ringOn = skip.size < RING_REFUSALS;
    let best: { x: number; z: number; score: number } | null = null;
    for (let dx = -d; ringOn && dx <= d; dx++) {
        for (let dz = -d; dz <= d; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== d) continue;
            const t = { x: spawn.x + dx, z: spawn.z + dz };
            if (cheb(t, p) > d + 4) continue; // only the near side of the ring
            if (skip.has(tileKey(t))) continue;
            const len = pathLen(finder, p, t);
            if (len === null) continue;
            // Keep away from NPCs that hunt players (aggressive, cowardly, ranged hunt modes).
            const risk = (st?.nearbyNpcs ?? []).some((n: any) => {
                const r = dangerMap.get(n.id);
                return r !== undefined && cheb(tileOf(n), t) <= r;
            });
            const score = len * 10 - cheb(t, npcAt) + (risk ? 10000 : 0);
            if (!best || score < best.score) best = { ...t, score };
        }
    }
    if (best) return { x: best.x, z: best.z };
    // No path data, or every ring tile refused: straight away from the NPC first, then the other seven directions,
    // on the ring and on two wider rings.
    const sx = Math.sign(p.x - npcAt.x) || 1, sz = Math.sign(p.z - npcAt.z);
    const dirs: [number, number][] = [];
    for (let ux = -1; ux <= 1; ux++) for (let uz = -1; uz <= 1; uz++) if ((ux || uz) && !(ux === sx && uz === sz)) dirs.push([ux, uz]);
    dirs.sort((a, b) => (b[0] * sx + b[1] * sz) - (a[0] * sx + a[1] * sz));
    dirs.unshift([sx, sz]);
    for (const ring of [d, d + 2, d + 4]) {
        for (const [ux, uz] of dirs) {
            const t = { x: spawn.x + ux * ring, z: spawn.z + uz * ring };
            if (!skip.has(tileKey(t))) return t;
        }
    }
    return null;
}

/** The hits of margin the flee guard keeps: it flees while it can still take this many hits of the attacker. */
export const FLEE_HITS = 2;

// The flee line and the session HP floor share one NPC max-hit estimate (hp-floor.ts npcMaxHitEstimate).
export { npcMaxHitEstimate };

/** The Hitpoints at or below which the flee guard runs: the larger of the `frac` share of `max` and FLEE_HITS hits. */
export function fleeHpLine(max: number, frac: number, attackerCombat: number | null | undefined): number {
    return Math.max(max * frac, FLEE_HITS * npcMaxHitEstimate(attackerCombat));
}

/** Sends to one destination with no position change before the flee job refuses that tile and picks another. */
const STUCK_SENDS = 3;

/**
 * Create a hostile-event flee job that runs outside `maxrange + 1` and returns to origin,
 * or holds in place after invoking `onSafe` when used by the flee guard.
 * A tile the client refuses (walkTo success false), or that the bot stops short of, is never picked again by this job.
 * In guard mode (`onSafe` set) the 90-tick timeout and the loss of every candidate tile also call `onSafe`, with
 * `timeout` or `no-tile` in the detail, so the session stops; the job keeps fleeing and holding the script meanwhile.
 */
export function createFleeJob(ctx: WatcherContext, idx: number, onSafe?: (detail: string) => void): JobSpec {
    ctx.getPf();
    let dest: Tile | null = null;
    let sentAt = -99;
    let lastPos = '';
    let awaySince = -1;
    let backSince = -1;
    let safeSaid = false;
    let stuckSends = 0;
    let loggedDest = '';
    let noTileSaid = false;
    const refused = new Set<string>();
    const begin = ctx.tick();
    const p0 = meOf(ctx.state());
    const origin = p0 ? { x: p0.x, z: p0.z } : null;
    // A refused tile is never picked again; the next tile goes out on the next tick.
    const refuse = (t: Tile) => { refused.add(tileKey(t)); if (dest === t) { dest = null; sentAt = -99; } stuckSends = 0; };

    return {
        name: 'flee', hold: true,
        tick() {
            const st = ctx.state();
            const h = ctx.hostiles.get(idx);
            const p = meOf(st);
            if (!h || !p) return true;
            const now = ctx.tick();
            // A dead player sends no more flee walks: death handling (death-recovery.ts) owns the session from here.
            const me = st?.player;
            if (me?.isDead || (typeof me?.hp === 'number' && me.hp <= 0)) { ctx.say(h.name, 'dead', `ticks=${now - begin}`); h.done = true; return true; }
            const npc = (st?.nearbyNpcs ?? []).find((n: any) => n.index === idx);
            const away = outOfReach(p, h.spawn, h.range);
            const engaged = npc ? targetsMe(st, npc) : false;
            const fail = (why: string) => {
                if (!onSafe || safeSaid) return;
                safeSaid = true;
                onSafe(`${h.name} ${why} id=${h.id} at=${p.x},${p.z} ticks=${now - begin} refused=${refused.size}`);
            };

            // Phase 2: the NPC dropped the target; walk back to where the flight began (or hold if onSafe is set).
            if (backSince >= 0) {
                if (engaged) { backSince = -1; dest = null; ctx.say(h.name, 'flee-again'); }
                else if (onSafe) {
                    if (!safeSaid) { safeSaid = true; onSafe(`${h.name} id=${h.id} at=${p.x},${p.z} ticks=${now - begin}`); }
                    return false;
                } else {
                    if (!origin || cheb(p, origin) <= 1) { ctx.say(h.name, 'returned', `ticks=${now - begin}`); h.done = true; return true; }
                    if (now - backSince > 30) { ctx.say(h.name, 'return-timeout'); h.done = true; return true; }
                    if (ctx.canSend() && now - sentAt >= 4) { void ctx.send({ type: 'walkTo', x: origin.x, z: origin.z, running: true }); sentAt = now; }
                    return false;
                }
            }

            const escaped = (why: string) => { ctx.say(h.name, why, `ticks=${now - begin}`); backSince = now; sentAt = -99; return false; };
            if (now - begin > 90 && !safeSaid) {
                ctx.say(h.name, 'flee-timeout', `at=${p.x},${p.z} refused=${refused.size}`);
                // Guard mode: the session stops; the walk goes on, because the NPC can still hit the bot.
                if (!onSafe) { h.done = true; return true; }
                fail('timeout');
            }
            if (away && !engaged && now - h.seen >= 4) return escaped('escaped');
            // Out of view: wait for a settled client tile while an attack animation plays.
            if (!npc && now - h.lastSeen > 3 && (away || now - h.lastSeen > 15)) return escaped('gone');
            if (away) {
                // Outside reach: wait for target drop; widen ring if spawn was observed late.
                if (awaySince < 0) awaySince = now;
                if (!engaged || now - awaySince <= 6) return false;
                h.range += 3; awaySince = -1; dest = null;
                ctx.say(h.name, 'widen', `need=${h.range + 2}`);
            }
            awaySince = -1;
            const pos = `${p.x},${p.z}`;
            const moved = pos !== lastPos;
            const stuck = !moved && now - sentAt >= 2;
            lastPos = pos;
            if (moved) stuckSends = 0;
            // The bot stands still after the sends, or one tile short of the tile while still in reach: refuse the tile.
            if (dest && stuck && sentAt >= begin && (stuckSends >= STUCK_SENDS || cheb(p, dest) <= 1)) {
                ctx.say(h.name, 'flee-repick', `to=${dest.x},${dest.z} at=${pos}`);
                refuse(dest);
            }
            const npcAt = npc ? tileOf(npc) : h.spawn;
            if (!dest || !outOfReach(dest, h.spawn, h.range)) dest = pickFleeTile(ctx, p, h.spawn, h.range, npcAt, refused);
            if (!dest) {
                // Every candidate refused: stop the session (guard mode) and try all tiles again.
                if (!noTileSaid) { noTileSaid = true; ctx.say(h.name, 'no-tile', `at=${pos} refused=${refused.size}`); }
                fail('no-tile');
                refused.clear();
                dest = pickFleeTile(ctx, p, h.spawn, h.range, npcAt, refused);
            }
            if (dest && ctx.canSend() && (now - sentAt >= 3 || stuck || sentAt < begin)) {
                const to = dest;
                if (stuck && sentAt >= begin) stuckSends++;
                void ctx.send({ type: 'walkTo', x: to.x, z: to.z, running: true }).then(ok => { if (!ok) refuse(to); });
                const k = tileKey(to);
                if (k !== loggedDest) { loggedDest = k; ctx.log(`EVENT ${h.name} dest t=${now} to=${k} from=${pos}`); }
                sentAt = now;
            }
            return false;
        },
    };
}

/** Create the low-HP flee guard scanner and last-seen tracker for non-event attackers. */
export function createFleeGuard(ctx: WatcherContext, fleeOpt: { hp: number; onSafe(detail: string): void }) {
    let fleeing = false;
    let fleeKey: string | null = null;

    const seeFled = () => {
        if (!fleeing || ctx.hostiles.size === 0) return;
        const st = ctx.state(), now = ctx.tick();
        for (const n of st?.nearbyNpcs ?? []) {
            const h = ctx.hostiles.get(n.index);
            if (h?.name === 'flee_guard' && h.id === n.id) h.lastSeen = now;
        }
    };

    const scanFlee = () => {
        const st = ctx.state(), p = st?.player, now = ctx.tick();
        // A flee job that has ended (its NPC gone from the hostile list, a timeout) frees the guard for the next attack.
        if (fleeing && fleeKey && !ctx.jobs.has(fleeKey)) { fleeing = false; fleeKey = null; }
        if (!p || fleeing) return;
        const max = p.maxHp ?? 0, hp = p.hp ?? 0;
        if (max <= 0 || hp <= 0) return;
        const attackers = (st?.nearbyNpcs ?? []).filter((x: any) => targetsMe(st, x));
        if (attackers.length === 0) return;
        // The line holds FLEE_HITS hits of the hardest hitter, so a 10-13 Hitpoints account runs before one hit kills it.
        const strongest = Math.max(...attackers.map((x: any) => (typeof x.combatLevel === 'number' ? x.combatLevel : -1)));
        if (hp > fleeHpLine(max, fleeOpt.hp, strongest >= 0 ? strongest : null)) return;
        // Only food that the eat guard eats (PLAIN_FOOD) turns the flee off: the guard never eats cake, bread or a pie.
        if (invOf(st).some(i => i && PLAIN_FOOD.includes(i.id))) return;
        const n = attackers.sort((a: any, b: any) => a.distance - b.distance)[0];
        fleeing = true;
        fleeKey = `flee:${n.index}`;
        ctx.hostiles.set(n.index, {
            name: 'flee_guard', id: n.id, range: ctx.danger().get(n.id) ?? FLEE_RANGE,
            spawn: tileOf(n), seen: now, lastSeen: now, ours: true, pre: false, done: false,
        });
        ctx.jobs.set(fleeKey, { ...createFleeJob(ctx, n.index, fleeOpt.onSafe), started: now });
        ctx.say('flee_guard', 'flee', `hp=${hp}/${max} npc=${n.name ?? '?'}#${n.id}`);
    };

    return { seeFled, scanFlee };
}
