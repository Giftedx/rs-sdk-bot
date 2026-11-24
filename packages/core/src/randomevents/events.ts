import { createFleeJob } from './combat';
import {
    AXE_HANDLE, AXE_HEADS, BIG_FISH, CUBE, ENT, FISH_TOOLS, FRIENDLY, GAS_CHEST, GAS_ROCK, HOSTILE, JUNK, LAMP,
    MAZE_REGION, MIME_REGION, PICK_HANDLE, PICK_HEADS, TRIFFID_FRUIT, TRIFFID_SEED, WHIRLPOOL,
    cheb, continueDialog, eqOf, freeSlots, inRange, inRegion, invOf, meOf, optIndex, otherNear, outOfReach,
    targetsMe, tileOf,
    type Act, type JobSpec, type Tile, type WatcherContext,
} from './model';
import { createCubeJob, createLampJob, createMazeJob, createMimeJob, lampTarget } from './puzzles';

function createTalkJob(ctx: WatcherContext, idx: number): JobSpec {
    let talkedAt = -99, tries = 0, dialogSeen = false;
    return {
        name: 'talk', hold: true,
        tick() {
            const st = ctx.state(), now = ctx.tick();
            const f = ctx.friends.get(idx);
            if (!f) return true;
            const npc = (st?.nearbyNpcs ?? []).find((n: any) => n.index === idx);
            if (st?.dialog?.isOpen) {
                dialogSeen = true;
                const text = `${st.dialog.text ?? ''} ${(st.dialog.allComponents ?? []).map((c: any) => c.text).join(' ')}`;
                if (/trying to talk to|not my matey/i.test(text)) { f.ours = false; ctx.say(f.name, 'not-ours'); }
                continueDialog(st, ctx.canSend, ctx.send);
                return false;
            }
            if (!npc) { ctx.say(f.name, dialogSeen ? 'done' : 'gone'); return true; }
            if (f.ours === false) return true;
            if (dialogSeen && now - talkedAt > 2) { ctx.say(f.name, 'done'); return true; }
            if (ctx.canSend() && now - talkedAt >= 8) {
                if (++tries > 4) { ctx.say(f.name, 'talk-failed'); return true; }
                ctx.send({ type: 'interactNpc', npcIndex: idx, optionIndex: optIndex(npc.optionsWithIndex, /talk/i, 1) });
                if (tries === 1) ctx.say(f.name, 'talk');
                talkedAt = now;
            }
            return false;
        },
    };
}

function createSeedJob(ctx: WatcherContext, idx: number): JobSpec {
    let at = -99, tries = 0;
    return {
        name: 'pick', hold: true,
        tick() {
            const st = ctx.state(), now = ctx.tick();
            const sd = ctx.seeds.get(idx);
            const npc = (st?.nearbyNpcs ?? []).find((n: any) => n.index === idx && n.id === TRIFFID_SEED);
            if (!sd || !npc) {
                if (invOf(st).some(i => i.id === TRIFFID_FRUIT)) ctx.say('triffid', 'picked');
                return true;
            }
            if (ctx.newMessages.any(/not here for you/i)) { sd.mine = false; ctx.say('triffid', 'not-ours'); return true; }
            if (st?.dialog?.isOpen) { continueDialog(st, ctx.canSend, ctx.send); return false; }
            if (ctx.newMessages.any(/isn't ready/i)) { at = now; return true; } // retried by the scan 4 ticks later
            if (ctx.canSend() && now - at >= 4) {
                if (++tries > 5) return true;
                ctx.send({ type: 'interactNpc', npcIndex: idx, optionIndex: optIndex(npc.optionsWithIndex, /pick/i, 1) });
                if (tries === 1) ctx.say('triffid', 'pick');
                at = now;
            }
            return false;
        },
    };
}

// Lost axe / pickaxe: unequip the handle if worn, pick the head up, use one on the other, wield again.
function createLostToolJob(ctx: WatcherContext, kind: 'axe' | 'pickaxe'): JobSpec {
    const handle = kind === 'axe' ? AXE_HANDLE : PICK_HANDLE;
    const heads = kind === 'axe' ? AXE_HEADS : PICK_HEADS;
    const name = kind === 'axe' ? 'lost_axe' : 'lost_pickaxe';
    const wasWorn = eqOf(ctx.state()).some(i => i?.id === handle);
    const begin = ctx.tick();
    let at = -99, kind0 = '', step = 'start', rewield = false;
    const due = (k: string, every: number) => {
        const now = ctx.tick();
        if (k === kind0 && now - at < every) return false;
        kind0 = k; at = now; return true;
    };

    return {
        name, hold: true,
        tick() {
            const st = ctx.state(), now = ctx.tick(), inv = invOf(st), eq = eqOf(st);
            if (st?.dialog?.isOpen) { continueDialog(st, ctx.canSend, ctx.send); return false; }
            const worn = eq.find(i => i?.id === handle);
            const hInv = inv.find(i => i.id === handle);
            const head = inv.find(i => heads.includes(i.id));
            if (!worn && !hInv) {
                if (wasWorn && !rewield) {
                    const tool = inv.find(i => new RegExp(kind === 'axe' ? ' axe$' : ' pickaxe$', 'i').test(i.name) && i.optionsWithIndex?.some((o: any) => /wield/i.test(o.text)));
                    if (tool && ctx.canSend()) {
                        ctx.send({ type: 'useInventoryItem', slot: tool.slot, optionIndex: optIndex(tool.optionsWithIndex, /wield/i, 2) });
                        rewield = true;
                        return false;
                    }
                }
                ctx.say(name, 'fixed', `ticks=${now - begin}`);
                return true;
            }
            if (!ctx.canSend()) return false;
            if (head && hInv) {
                if (due('join', 3)) {
                    ctx.send({ type: 'useItemOnItem', sourceSlot: hInv.slot, targetSlot: head.slot });
                    if (step !== 'join') { step = 'join'; ctx.say(name, 'reattach'); }
                }
                return false;
            }
            const need = (worn ? 1 : 0) + (head ? 0 : 1);
            if (freeSlots(st) < need) {
                const junk = [...inv].reverse().find(i => JUNK.test(i.name));
                if (!junk) { if (step !== 'nospace') { step = 'nospace'; ctx.say(name, 'no-free-slot'); } return now - begin > 30; }
                if (due('drop', 2)) ctx.send({ type: 'dropItem', slot: junk.slot });
                return false;
            }
            if (worn) {
                if (due('unequip', 3)) ctx.send({ type: 'useEquipmentItem', slot: worn.slot, optionIndex: 1 });
                return false;
            }
            const g = (st?.groundItems ?? []).filter((x: any) => heads.includes(x.id)).sort((a: any, b: any) => a.distance - b.distance)[0];
            if (!g) { if (now - begin > 15) { ctx.say(name, 'head-missing'); return true; } return false; }
            if (due('pickup', 5)) {
                ctx.send({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id });
                if (step !== 'pickup') { step = 'pickup'; ctx.say(name, 'pickup'); }
            }
            return false;
        },
    };
}

// Big fish: the tool left the pack and lies within 7 tiles. Pick it up again.
function createToolPickupJob(ctx: WatcherContext, id: number): JobSpec {
    let at = -99;
    const begin = ctx.tick();
    return {
        name: 'big_fish', hold: true,
        tick() {
            const st = ctx.state(), now = ctx.tick(), inv = invOf(st);
            if (st?.trade?.isOpen) return true;
            if (inv.some(i => i.id === id)) { ctx.say('big_fish', 'recovered', `ticks=${now - begin}`); return true; }
            if (now - begin > 30) { ctx.say('big_fish', 'lost-tool'); return true; }
            const g = (st?.groundItems ?? []).filter((x: any) => x.id === id && x.distance <= 10).sort((a: any, b: any) => a.distance - b.distance)[0];
            if (!g || !ctx.canSend()) return false;
            if (freeSlots(st) < 1) {
                const junk = [...inv].reverse().find(i => JUNK.test(i.name));
                if (junk) { ctx.send({ type: 'dropItem', slot: junk.slot }); at = now; }
                return false;
            }
            if (now - at >= 5) { ctx.send({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id }); at = now; }
            return false;
        },
    };
}

/** Create the per-tick random event scanner covering NPCs, locs, broken/dropped tools, and puzzle items/regions. */
const EMPTY_LIST: any[] = [];
const HOSTILE_BY_ID = new Map<number, (typeof HOSTILE)[number]>();
for (const h of HOSTILE) for (let id = h.lo; id <= h.hi; id++) HOSTILE_BY_ID.set(id, h);
const FISH_TOOL_INDEX = new Map<number, number>(FISH_TOOLS.map((id, i) => [id, i]));

export function createEventScanner(ctx: WatcherContext) {
    const redirected = new Map<string, number>();
    const toolCounts = new Map<number, number>();
    const toolGone = new Map<number, number>();
    const curToolCounts = new Int32Array(FISH_TOOLS.length);

    const redirect = (key: string, name: string, target: Act | null, away: Tile | null) => {
        const now = ctx.tick();
        if ((redirected.get(key) ?? -99) > now - 4 || !ctx.canSend()) return;
        redirected.set(key, now);
        const p = meOf(ctx.state())!;
        if (target) { ctx.send(target); ctx.say(name, 'redirect'); return; }
        if (away) {
            const sx = Math.sign(p.x - away.x) || 1, sz = Math.sign(p.z - away.z);
            ctx.send({ type: 'walkTo', x: p.x + sx * 2, z: p.z + sz * 2, running: true });
            ctx.say(name, 'step-away');
        }
    };

    const nearestLoc = (st: any, re: RegExp, op: RegExp, not: (l: any) => boolean) =>
        (st?.nearbyLocs ?? [])
            .filter((l: any) => re.test(l.name) && l.options?.some((o: string) => op.test(o)) && !not(l) && l.reachable !== false)
            .sort((a: any, b: any) => a.distance - b.distance)[0];

    const scanEvents = () => {
        const st = ctx.state(), p = meOf(st);
        if (!p) return;
        const now = ctx.tick();
        const inv: any[] = st?.inventory ?? EMPTY_LIST, eq: any[] = st?.equipment ?? EMPTY_LIST;
        const npcs: any[] = st?.nearbyNpcs ?? EMPTY_LIST;
        const locs: any[] = st?.nearbyLocs ?? EMPTY_LIST;
        ctx.avoidNpcs.clear();
        ctx.avoidLocs.clear();

        for (let ni = 0; ni < npcs.length; ni++) {
            const n = npcs[ni];
            const h = HOSTILE_BY_ID.get(n.id);
            if (h) {
                let m = ctx.hostiles.get(n.index);
                if (!m || m.id !== n.id) {
                    m = { name: h.name, id: n.id, range: h.range, spawn: tileOf(n), seen: now, lastSeen: now, ours: null, pre: false, done: false };
                    const seed = ctx.seeds.get(n.index);
                    if (n.id === 408 && seed) { m.seen = seed.seen; m.ours = seed.mine ? true : null; }
                    ctx.hostiles.set(n.index, m);
                    ctx.say(h.name, 'seen', `at=${m.spawn.x},${m.spawn.z} d=${cheb(m.spawn, p)}`);
                }
                m.lastSeen = now;
                if (n.targetIndex >= 32768) m.ours = targetsMe(st, n);
                else if (m.ours === null && now - m.seen <= 1) {
                    const t = tileOf(n);
                    if (cheb(t, p) <= 2 && !otherNear(st, t, 3)) { m.ours = true; m.pre = true; }
                }
                const engaged = targetsMe(st, n) || (m.pre && now - m.seen < 6);
                if (m.ours && engaged && !outOfReach(p, m.spawn, m.range) && !ctx.jobs.has(`flee:${n.index}`)) {
                    m.done = false;
                    ctx.jobs.set(`flee:${n.index}`, { ...createFleeJob(ctx, n.index), started: now });
                    ctx.say(h.name, 'flee', `need=${m.range + 2}`);
                }
                continue;
            }
            const fname = FRIENDLY[n.id];
            if (fname) {
                let f = ctx.friends.get(n.index);
                if (!f || f.id !== n.id) { f = { name: fname, id: n.id, seen: now, lastSeen: now, ours: null }; ctx.friends.set(n.index, f); ctx.say(fname, 'seen'); }
                f.lastSeen = now;
                if (n.targetIndex >= 32768) f.ours = targetsMe(st, n);
                else if (f.ours === null) {
                    const t = tileOf(n);
                    if (cheb(t, p) <= 2 && !otherNear(st, t, 3)) f.ours = true;
                }
                // The old man's mime, maze and box variants vanish after 1-2 ticks: talk only to one that stays.
                const settled = fname !== 'old_man' || now - f.seen >= 3;
                if (f.ours && settled && !ctx.handledNpc.has(n.index) && !ctx.jobs.has(`talk:${n.index}`)) {
                    ctx.handledNpc.add(n.index);
                    ctx.want(`talk:${n.index}`, createTalkJob(ctx, n.index));
                }
                continue;
            }
            if (n.id === TRIFFID_SEED) {
                let sd = ctx.seeds.get(n.index);
                if (!sd) { sd = { seen: now, lastSeen: now, mine: cheb(tileOf(n), p) <= 2 }; ctx.seeds.set(n.index, sd); ctx.say('triffid', 'seen'); }
                sd.lastSeen = now;
                if (sd.mine && freeSlots(st) > 0 && now - sd.seen >= 47 && now - sd.seen <= 86 && !ctx.jobs.has(`seed:${n.index}`) && (redirected.get(`seed:${n.index}`) ?? -99) < now - 4) {
                    redirected.set(`seed:${n.index}`, now);
                    ctx.want(`seed:${n.index}`, createSeedJob(ctx, n.index));
                }
                continue;
            }
            if (inRange(n.id, ENT)) {
                ctx.avoidNpcs.add(n.index);
                const size = n.size ?? 2, tx = n.tileX ?? n.x, tz = n.tileZ ?? n.z;
                const touching = p.x >= tx - 1 && p.x <= tx + size && p.z >= tz - 1 && p.z <= tz + size;
                if (touching && (st.player.animId ?? -1) !== -1) {
                    const tree = nearestLoc(st, new RegExp(`^${n.name}$`, 'i'), /chop/i, (l: any) => l.x >= tx && l.x < tx + size && l.z >= tz && l.z < tz + size);
                    redirect(`ent:${n.index}`, 'ent', tree ? { type: 'interactLoc', x: tree.x, z: tree.z, locId: tree.id, optionIndex: optIndex(tree.optionsWithIndex, /chop/i, 1) } : null, { x: tx, z: tz });
                }
                continue;
            }
            if (inRange(n.id, WHIRLPOOL)) {
                ctx.avoidNpcs.add(n.index);
                const tx = n.tileX ?? n.x, tz = n.tileZ ?? n.z;
                if (Math.max(Math.abs(tx - p.x), Math.abs(tz - p.z)) <= 1 && (st.player.animId ?? -1) !== -1) {
                    const spot = npcs.filter(o => o.name === n.name && !inRange(o.id, WHIRLPOOL) && o.reachable !== false).sort((a, b) => a.distance - b.distance)[0];
                    const op = spot?.optionsWithIndex?.find((o: any) => n.options?.includes(o.text));
                    redirect(`whirl:${n.index}`, 'whirlpool', spot && op ? { type: 'interactNpc', npcIndex: spot.index, optionIndex: op.opIndex } : null, { x: tx, z: tz });
                }
                continue;
            }
            if (n.id === BIG_FISH && !ctx.handledNpc.has(n.index)) { ctx.handledNpc.add(n.index); ctx.say('big_fish', 'seen'); }
        }

        for (let li = 0; li < locs.length; li++) {
            const l = locs[li];
            if (inRange(l.id, GAS_ROCK)) {
                ctx.avoidLocs.add(`${l.x},${l.z}`);
                if (cheb(l, p) <= 1 && (st.player.animId ?? -1) !== -1) {
                    const rock = nearestLoc(st, /^rocks?$/i, /mine/i, (o: any) => inRange(o.id, GAS_ROCK) || (o.x === l.x && o.z === l.z));
                    redirect(`gas:${l.x},${l.z}`, 'gas_rock', rock ? { type: 'interactLoc', x: rock.x, z: rock.z, locId: rock.id, optionIndex: optIndex(rock.optionsWithIndex, /mine/i, 1) } : null, l);
                }
            } else if (l.id === GAS_CHEST) {
                ctx.avoidLocs.add(`${l.x},${l.z}`);
                if (cheb(l, p) <= 1) redirect(`chest:${l.x},${l.z}`, 'poison_gas', null, l);
            }
        }

        let hasAxeHandle = false, hasPickHandle = false, hasCube = false, hasLamp = false;
        curToolCounts.fill(0);
        for (let i = 0; i < inv.length; i++) {
            const item = inv[i];
            if (!item) continue;
            const id = item.id;
            if (id === AXE_HANDLE) hasAxeHandle = true;
            else if (id === PICK_HANDLE) hasPickHandle = true;
            else if (id === CUBE) hasCube = true;
            else if (id === LAMP) hasLamp = true;
            else {
                const ti = FISH_TOOL_INDEX.get(id);
                if (ti !== undefined) curToolCounts[ti]!++;
            }
        }
        if (!hasAxeHandle || !hasPickHandle) {
            for (let i = 0; i < eq.length; i++) {
                const item = eq[i];
                if (!item) continue;
                if (item.id === AXE_HANDLE) hasAxeHandle = true;
                else if (item.id === PICK_HANDLE) hasPickHandle = true;
            }
        }
        if (hasAxeHandle && !ctx.jobs.has('lost_axe')) ctx.want('lost_axe', createLostToolJob(ctx, 'axe'));
        if (hasPickHandle && !ctx.jobs.has('lost_pickaxe')) ctx.want('lost_pickaxe', createLostToolJob(ctx, 'pickaxe'));

        // Trade offers remove tools from the pack without dropping them.
        const tradeOpen = !!st?.trade?.isOpen;
        const bankOpen = !!st?.bank?.isOpen;
        const groundItems: any[] = st?.groundItems ?? EMPTY_LIST;
        for (let ti = 0; ti < FISH_TOOLS.length; ti++) {
            const id = FISH_TOOLS[ti]!;
            const c = curToolCounts[ti]!;
            const prev = toolCounts.get(id) ?? c;
            toolCounts.set(id, c);
            if (tradeOpen) {
                toolGone.delete(id);
                ctx.scriptToolDrops.delete(id);
                ctx.clearJob(`tool:${id}`);
                continue;
            }
            if (c < prev && !bankOpen) {
                const lost = prev - c;
                const drop = ctx.scriptToolDrops.get(id);
                if (drop && now - drop.at <= 6 && drop.left > 0) {
                    const explained = Math.min(drop.left, lost);
                    const left = drop.left - explained;
                    if (left > 0) ctx.scriptToolDrops.set(id, { at: drop.at, left });
                    else ctx.scriptToolDrops.delete(id);
                    if (lost > explained) toolGone.set(id, now);
                    else toolGone.delete(id);
                } else {
                    ctx.scriptToolDrops.delete(id);
                    toolGone.set(id, now);
                }
            }
            const gone = toolGone.get(id);
            if (gone !== undefined && now - gone <= 12 && !ctx.jobs.has(`tool:${id}`) && groundItems.some((g: any) => g.id === id && g.distance <= 10)) {
                toolGone.delete(id);
                ctx.say('big_fish', 'tool-dropped', `id=${id}`);
                ctx.want(`tool:${id}`, createToolPickupJob(ctx, id));
            }
        }

        if (hasCube && !ctx.jobs.has('strange_box')) ctx.want('strange_box', createCubeJob(ctx));
        const kept = ctx.jobs.get('lamp-kept');
        if (kept && now - kept.started >= 100 && ctx.lampSkill === 'auto') ctx.jobs.delete('lamp-kept');
        if (hasLamp && !ctx.jobs.has('lamp') && !ctx.jobs.has('lamp-kept')) {
            const skill = lampTarget(st, ctx.lampSkill, ctx.xpStart);
            if (skill) ctx.want('lamp', createLampJob(ctx, skill));
            else {
                if (!kept) ctx.say('genie', 'lamp-kept');
                ctx.jobs.set('lamp-kept', { name: 'noop', hold: false, started: now, tick: () => false });
            }
        }
        if (inRegion(p, MIME_REGION) && !ctx.jobs.has('mime')) ctx.want('mime', createMimeJob(ctx));
        if (inRegion(p, MAZE_REGION) && !ctx.jobs.has('maze')) ctx.want('maze', createMazeJob(ctx));

        for (const [k, m] of ctx.hostiles) if (now - m.lastSeen > 50) ctx.hostiles.delete(k);
        for (const [k, f] of ctx.friends) if (now - f.lastSeen > 50) ctx.friends.delete(k);
        for (const [k, sd] of ctx.seeds) if (now - sd.lastSeen > 50) ctx.seeds.delete(k);
    };

    return { scanEvents };
}
