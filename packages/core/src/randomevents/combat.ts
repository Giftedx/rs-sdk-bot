import {
    EAT, FLEE_RANGE, cheb, invOf, meOf, outOfReach, targetsMe, tileOf,
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

/** Pick the nearest safe tile outside `range` from `spawn`, avoiding hunting NPCs. */
function pickFleeTile(ctx: WatcherContext, p: TileLevel, spawn: Tile, range: number, npcAt: Tile): Tile {
    const st = ctx.state();
    const finder = ctx.getPf();
    const dangerMap = ctx.danger();
    const d = range + 2;
    let best: { x: number; z: number; score: number } | null = null;
    for (let dx = -d; dx <= d; dx++) {
        for (let dz = -d; dz <= d; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== d) continue;
            const t = { x: spawn.x + dx, z: spawn.z + dz };
            if (cheb(t, p) > d + 4) continue; // only the near side of the ring
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
    // No path data: straight away from the NPC.
    const sx = Math.sign(p.x - npcAt.x) || 1, sz = Math.sign(p.z - npcAt.z);
    return { x: spawn.x + sx * d, z: spawn.z + sz * d };
}

/**
 * Create a hostile-event flee job that runs outside `maxrange + 1` and returns to origin,
 * or holds in place after invoking `onSafe` when used by the flee guard.
 */
export function createFleeJob(ctx: WatcherContext, idx: number, onSafe?: (detail: string) => void): JobSpec {
    ctx.getPf();
    let dest: Tile | null = null;
    let sentAt = -99;
    let lastPos = '';
    let awaySince = -1;
    let backSince = -1;
    let safeSaid = false;
    const begin = ctx.tick();
    const p0 = meOf(ctx.state());
    const origin = p0 ? { x: p0.x, z: p0.z } : null;

    return {
        name: 'flee', hold: true,
        tick() {
            const st = ctx.state();
            const h = ctx.hostiles.get(idx);
            const p = meOf(st);
            if (!h || !p) return true;
            const now = ctx.tick();
            const npc = (st?.nearbyNpcs ?? []).find((n: any) => n.index === idx);
            const away = outOfReach(p, h.spawn, h.range);
            const engaged = npc ? targetsMe(st, npc) : false;

            // Phase 2: the NPC dropped the target; walk back to where the flight began (or hold if onSafe is set).
            if (backSince >= 0) {
                if (engaged) { backSince = -1; dest = null; ctx.say(h.name, 'flee-again'); }
                else if (onSafe) {
                    if (!safeSaid) { safeSaid = true; onSafe(`${h.name} id=${h.id} at=${p.x},${p.z} ticks=${now - begin}`); }
                    return false;
                } else {
                    if (!origin || cheb(p, origin) <= 1) { ctx.say(h.name, 'returned', `ticks=${now - begin}`); h.done = true; return true; }
                    if (now - backSince > 30) { ctx.say(h.name, 'return-timeout'); h.done = true; return true; }
                    if (ctx.canSend() && now - sentAt >= 4) { ctx.send({ type: 'walkTo', x: origin.x, z: origin.z, running: true }); sentAt = now; }
                    return false;
                }
            }

            const escaped = (why: string) => { ctx.say(h.name, why, `ticks=${now - begin}`); backSince = now; sentAt = -99; return false; };
            if (now - begin > 90) { ctx.say(h.name, 'flee-timeout'); h.done = true; return true; }
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
            const stuck = pos === lastPos && now - sentAt >= 2;
            lastPos = pos;
            if (!dest || !outOfReach(dest, h.spawn, h.range)) dest = pickFleeTile(ctx, p, h.spawn, h.range, npc ? tileOf(npc) : h.spawn);
            if (dest && ctx.canSend() && (now - sentAt >= 3 || stuck || sentAt < begin)) {
                ctx.send({ type: 'walkTo', x: dest.x, z: dest.z, running: true });
                if (sentAt < begin) ctx.log(`EVENT ${h.name} dest t=${now} to=${dest.x},${dest.z} from=${p.x},${p.z}`);
                sentAt = now;
            }
            return false;
        },
    };
}

/** Create the low-HP flee guard scanner and last-seen tracker for non-event attackers. */
export function createFleeGuard(ctx: WatcherContext, fleeOpt: { hp: number; onSafe(detail: string): void }) {
    let fleeing = false;

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
        if (!p || fleeing) return;
        const max = p.maxHp ?? 0, hp = p.hp ?? 0;
        if (max <= 0 || hp <= 0 || hp > max * fleeOpt.hp) return;
        if (invOf(st).some(i => (i.optionsWithIndex ?? []).some((o: any) => EAT.test(o.text ?? '')))) return;
        const n = (st?.nearbyNpcs ?? []).filter((x: any) => targetsMe(st, x)).sort((a: any, b: any) => a.distance - b.distance)[0];
        if (!n) return;
        fleeing = true;
        ctx.hostiles.set(n.index, {
            name: 'flee_guard', id: n.id, range: ctx.danger().get(n.id) ?? FLEE_RANGE,
            spawn: tileOf(n), seen: now, lastSeen: now, ours: true, pre: false, done: false,
        });
        ctx.jobs.set(`flee:${n.index}`, { ...createFleeJob(ctx, n.index, fleeOpt.onSafe), started: now });
        ctx.say('flee_guard', 'flee', `hp=${hp}/${max} npc=${n.name ?? '?'}#${n.id}`);
    };

    return { seeFled, scanFlee };
}
