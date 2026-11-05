// Sheep Herder from preset quest_sheepherder (East Ardougne beside Councillor Halgrive; Haggis at the qp-filler row:
// every skill 99, the combat rune set, 200 coins). Reward: 4 QP, 3,100 coins (quest_sheepherder.rs2:5-9).
// Varp %sheepherderquest (60): 0 -> 1 Halgrive, 2 Orbon's suit bought, 3 Halgrive (queued completion). Varp 61 holds
// 3 bits per sheep (in pen, poisoned, burned); Halgrive pays at bits 0-12 = 7020 (councillor_halgrive.rs2:68-75).
// Server truth: quests/quest_sheepherder/scripts/npcs/*.rs2, locs/sheepherder_gate.rs2, locs/sheepherder_furnace.rs2,
// configs/sheepherder_area.dbrow (pen 2595-2609,3351-3364; gate zone 2592-2594,3360-3363).
import { openQuest } from './quest-lib';
import { loadPathfinding } from '../../packages/core/src/pathcache';

const HALGRIVE = { x: 2617, z: 3299 };
const ORBON = { x: 2614, z: 3306 };
const GATE = { id: 167, x: 2594, z: 3361 };                // plaguesheep_gater, east wall of 2594,3361
const FURNACE = { id: 165, x: 2605, z: 3360 };
const PROD_AT = { x: 2604, z: 3357 };                       // cattle prod floor spawn inside the pen
const ITEM = { feed: 279, prod: 278, jacket: 284, trousers: 285 };
const BONES: Record<number, number> = { 1: 280, 2: 281, 3: 282, 4: 283 };
const SPAWN: Record<number, { x: number; z: number }> = { 1: { x: 2609, z: 3344 }, 2: { x: 2621, z: 3367 }, 3: { x: 2560, z: 3389 }, 4: { x: 2610, z: 3391 } };
const inPen = (x: number, z: number) => x >= 2595 && x <= 2609 && z >= 3351 && z <= 3364;
const inGateZone = (x: number, z: number) => x >= 2592 && x <= 2594 && z >= 3360 && z <= 3363;

await loadPathfinding();
const rsmod: any = await import('../../vendor/rs-sdk/server/vendor/rsmod-pathfinder/rsmod-pathfinder.js');
const can = (x: number, z: number, dx: number, dz: number): boolean => rsmod.canTravel(0, x, z, dx, dz, 1, 0, rsmod.CollisionType.NORMAL);
// canTravel checks the step, not the start tile: a 2x2 tree (2607,3343) covers 2608,3344, which it passed as a bot tile.
const open = (x: number, z: number): boolean => !rsmod.isFlagged(x, z, 0, rsmod.CollisionFlag.WALK_BLOCKED);
const DIRS: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
// A prod moves the sheep one tile away from the bot (diseased_sheep.rs2:81-89). Shortest push path to the gate zone:
// each step needs the sheep's move and the bot's tile behind it (adjacent, no wall between) to be open.
const key = (x: number, z: number) => x * 10000 + z;
function nextPush(sx: number, sz: number, occ: Set<number>, strict = true): [number, number] | null {
    const first = new Map<number, [number, number] | null>([[key(sx, sz), null]]);
    const q: Array<[number, number]> = [[sx, sz]];
    while (q.length) {
        const [x, z] = q.shift()!;
        if (inGateZone(x, z)) return first.get(key(x, z)) ?? null;
        for (const [dx, dz] of DIRS) {
            const k = key(x + dx, z + dz);
            if (first.has(k) || !can(x, z, dx, dz) || !can(x - dx, z - dz, dx, dz) || (strict && !open(x - dx, z - dz))) continue;
            // Another NPC (the 2 other copies of each sheep stand close by) on the bot's tile or the sheep's next tile.
            if (occ.has(key(x + dx, z + dz)) || occ.has(key(x - dx, z - dz))) continue;
            first.set(k, first.get(key(x, z)) ?? [dx, dz]);
            q.push([x + dx, z + dz]);
        }
    }
    return null;
}

const q = await openQuest({ cap: 4000 });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const x = (): number => q.pos()?.worldX ?? 0;
    const z = (): number => q.pos()?.worldZ ?? 0;
    const worn = (id: number) => (q.st()?.equipment ?? []).some((e: any) => e.id === id);
    const wear = async (id: number): Promise<void> => {
        await q.step(`wear ${id}`, () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(id)!, optionIndex: 2, reason: 'SDK' }), () => worn(id), 3, 3);
    };
    const ground = (id: number): any => (q.st()?.groundItems ?? []).filter((g: any) => g.id === id).sort((a: any, b: any) => q.cheb(a.x, a.z) - q.cheb(b.x, b.z))[0];
    const pickup = (label: string, id: number) => q.step(label, () => { const g = ground(id); return g ? q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' }) : q.waitTicks(1); }, () => q.has(id), 15, 4);
    // The gate teleports the bot across (sheepherder_gate.rs2:1-21); in from the west needs the suit worn.
    const gateIn = () => q.step('gate in', () => q.opLoc(GATE, 1), () => x() >= 2595, 12, 4);
    const gateOut = () => q.step('gate out', () => q.opLoc(GATE, 1), () => x() <= 2594, 12, 4);
    const banned = new Set<number>();
    const sheep = (n: number): any => (q.st()?.nearbyNpcs ?? []).filter((m: any) => m.name === `Diseased sheep ${n}` && !banned.has(m.index)).sort((a: any, b: any) => a.distance - b.distance)[0];
    const prod = (m: any) => q.s.direct({ type: 'interactNpc', npcIndex: m.index, optionIndex: m.optionsWithIndex?.find((o: any) => /prod/i.test(o.text))?.opIndex ?? 1, reason: 'SDK' });

    if (process.env.SH_FROM !== 'herd') {
        // 1. Halgrive: "What's wrong?", "I can do that for you." gives the poisoned feed and sets 1.
        await q.talk('halgrive 1', /^councillor halgrive$/i, [/what's wrong/i, /i can do that for you/i], () => q.has(ITEM.feed) && q.sawText(/discoloured wool/i), HALGRIVE, 80);
        q.milestone(1);
        // 2. Orbon: "Ok, I'll take it." sells the suit for 100 coins and sets 2; both pieces worn.
        await q.walk('to orbon', [{ x: ORBON.x, z: ORBON.z - 1, tol: 2 }]);
        await q.talk('orbon', /^doctor orbon$/i, [/i'll take it/i], () => q.has(ITEM.jacket) && q.has(ITEM.trousers), ORBON, 40);
        await wear(ITEM.jacket);
        await wear(ITEM.trousers);
        q.milestone(2);

        // 3. The cattle prod lies inside the pen: in, pick it up, out, wield it.
        await q.walk('to pen gate', [{ x: 2593, z: 3361, tol: 0 }]);
        await gateIn();
        await pickup('cattle prod', ITEM.prod);
        await gateOut();
        await wear(ITEM.prod);
        q.milestone('prod');
    }

    // 4. Herd the 4 sheep into the gate zone, nearest first; one more prod there makes the sheep jump the gate.
    const jumps = () => q.msgCount(/obligingly jumps over the gate/i);
    const left = new Set([1, 2, 3, 4]);
    while (left.size) {
        const n = [...left].sort((a, b) => q.cheb(SPAWN[a]!.x, SPAWN[a]!.z) - q.cheb(SPAWN[b]!.x, SPAWN[b]!.z))[0]!;
        // Sheep 1 grazes south of the pen; the walk round the pen's east side is given as waypoints.
        // The walks are client-routed dashes: walkPath "opens" the pen gate as a door, and the gate teleports the
        // suited bot into the pen (one trial stood 224 ticks inside it).
        const via = n === 1 ? [[2611, 3366], [2613, 3353]] : [];
        if (!sheep(n) || n === 1) for (const [wx, wz] of [...via, [SPAWN[n]!.x, SPAWN[n]!.z]]) await q.dash(`to sheep ${n}`, wx!, wz!, 3, 40);
        const j0 = jumps();
        let pushes = 0, stuck = 0, lastAt = '', noPath = 0, noSheep = 0;
        while (jumps() === j0) {
            await q.guard(`sheep ${n}`);
            const m = sheep(n);
            // No copy of the sheep in reach after five searches at its spawn (every copy banned as boxed in, or none in
            // sight) ends the quest rather than searching for ever.
            if (!m) { if (++noSheep >= 5) await q.fail(`sheep ${n}: no copy in reach after ${noSheep} searches (${banned.size} banned)`); await q.dash(`find sheep ${n}`, SPAWN[n]!.x, SPAWN[n]!.z, 3, 40); continue; }
            noSheep = 0;
            const at = `${m.x},${m.z}`;
            stuck = at === lastAt ? stuck + 1 : 0;
            lastAt = at;
            if (stuck > 60) await q.fail(`sheep ${n} stuck at ${at}`);
            if (inGateZone(m.x, m.z)) {
                await prod(m);
                await q.waitUntil(() => jumps() !== j0, 6);
                continue;
            }
            const occ = new Set<number>((q.st()?.nearbyNpcs ?? []).filter((o: any) => o.index !== m.index).map((o: any) => key(o.x, o.z)));
            const d = nextPush(m.x, m.z, occ) ?? nextPush(m.x, m.z, new Set());
            // A sheep that wandered into a pocket (2594,3357: the pen fence east, a blocked tile south) has no push;
            // its own wander takes it out, so the bot waits.
            if (!d) {
                // 10 tries without a push: another copy of the same sheep (each has 3 spawns) is taken instead.
                if (++noPath >= 10) { console.log(`NOTE sheep ${n} copy ${m.index} boxed in at ${at}; next copy`); banned.add(m.index); noPath = 0; }
                await q.waitTicks(3);
                continue;
            }
            noPath = 0;
            const px = m.x - d![0], pz = m.z - d![1];
            // On a straight run the bot is 2 tiles behind and the prod's own approach step lands on the push tile.
            const behind2 = x() === m.x - 2 * d![0] && z() === m.z - 2 * d![1];
            if (!(x() === px && z() === pz) && !behind2) {
                await q.s.direct({ type: 'walkTo', x: px, z: pz, running: true, reason: 'SDK' });
                await q.waitUntil(() => x() === px && z() === pz, 6);
                if (!(x() === px && z() === pz)) { console.log(`WARN sheep ${n} at ${at}: push tile ${px},${pz} not reached, bot ${x()},${z()} t=${q.T()}`); continue; }
            }
            // The sheep wanders (its ai_timer resets the mode every 10-30 ticks, :103-113); a prod after it moved pushes it
            // the wrong way, so the side is planned again.
            const m2 = sheep(n);
            if (!m2 || m2.x !== m.x || m2.z !== m.z) continue;
            await prod(m);
            pushes++;
            await q.waitUntil(() => { const k = sheep(n); return !k || k.x !== m.x || k.z !== m.z || jumps() !== j0; }, 3);
        }
        console.log(`NOTE sheep ${n} in the pen after ${pushes} prods at ${q.T()}`);
        left.delete(n);
        q.milestone(`sheep${n}`);
        // The jumped sheep is a new NPC that lasts 150 ticks (npc_add(..., 150), diseased_sheep.rs2:95), so it is
        // fed at once: in, the feed (it drops its bones, :139-164), the bones into the furnace, out.
        await gateIn();
        const bones = BONES[n]!;
        await q.step(`feed ${n}`, () => { const k = (q.st()?.nearbyNpcs ?? []).filter((o: any) => o.name === `Diseased sheep ${n}` && inPen(o.x, o.z))[0]; return k ? q.useOnNpc(ITEM.feed, k) : q.waitTicks(1); }, () => q.dialogOpen() || !!ground(bones), 10, 4);
        await q.converse([], () => !q.dialogOpen(), 6);
        await q.waitUntil(() => !!ground(bones), 6);
        await pickup(`bones ${n}`, bones);
        await q.step(`furnace ${n}`, () => q.useOnLoc(bones, FURNACE), () => !q.has(bones), 10, 4);
        await q.waitTicks(3);   // p_delay(3) before the bits are set (sheepherder_furnace.rs2:16-23)
        await gateOut();
        q.milestone(`burned${n}`);
    }

    // 6. Out, back to Halgrive, who queues the completion.
    await gateOut();
    await q.walk('to halgrive', [{ x: HALGRIVE.x, z: HALGRIVE.z + 1, tol: 2 }]);
    await q.talk('halgrive 2', /^councillor halgrive$/i, [], () => questDone, HALGRIVE, 60, true);
    await q.converse([], () => !q.dialogOpen(), 10);
    q.milestone(3);
    off();
    await q.end(questDone, 'qp=4');
} catch (e) { await q.fail(String(e)); }
