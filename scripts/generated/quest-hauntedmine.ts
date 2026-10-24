// Haunted Mine from preset quest_hauntedmine (beside the Zealot outside the Mort Ridge mines; every skill 99; Priest in
// Peril done; a chisel and lobsters). Reward: 2 QP, 22,000 Strength XP (quests/quest_hauntedmine/scripts/
// hauntedmine_crystals.rs2:52-56).
// Varp %hauntedmine (hauntedmine.constant:1-11): 1 the Zealot's history, 3 an entrance crawled, 4 the valve found, 5 the
// lift, 7 the dark stairs with a fungus, 8 the boss key, 9 the boss killed, 10 the reward door, then the crystal.
// The SDK state has no varps (the quest varps are not transmitted), so each MILESTONE prints on the observed effect.
// Map (quest locs in maps/m53_50, m53_150, m43_71, m42_70, m43_70, m42_69, m43_69; walk areas from the SDK collision):
// - The surface: the Zealot's side reaches the secondary entrance only over the cart (hauntedmine_locs.rs2:1-4); the
//   back entrances are on a ledge reached from inside (back_entrance1_inside, hauntedmine_locs.rs2:19-21).
// - Area 1 (53_150 west) -> ladder 3413,9633 -> 43_71 -> ladder 2797,4599 -> 42_70 north -> ladders to the lift area
//   (43_70 east, 2796,4529) and to the cart end (43_70, 2774,4540).
// - Area 2 (53_150, back entrance 2) -> ladder 3422,9625 -> 43_71 -> 2798,4567 -> 42_70 south -> 2725,4486 -> the
//   fungus area (43_70 west): the glowing mushrooms, the cart start, the points controls and the 8 levers.
// A fungus crumbles when its carrier crawls out to the surface (hauntedmine_fungus.rs2:38-52), and the fungus area
// joins the lift side only through the surface, so the fungus goes by cart (the points puzzle) to the cart end.
import { openQuest } from './quest-lib';
import { componentId } from '../../packages/core/src/logout';

type L = { id: number; x: number; z: number };
const ZEALOT = { x: 3444, z: 3258 };
const LOC: Record<string, L> = {
    cartJump: { id: 4918, x: 3445, z: 3236 },     // hauntedmine_obstacle_cart: 2 tiles west
    secondary: { id: 4913, x: 3440, z: 3232 },    // -> 3436,9637 (area 1), varp 3
    back1In: { id: 4921, x: 3404, z: 9631 },      // -> 3429,3233 (the ledge)
    back2: { id: 4915, x: 3429, z: 3225 },        // -> 3409,9623 (area 2)
    back2In: { id: 4922, x: 3408, z: 9623 },      // -> 3428,3225
    back1: { id: 4914, x: 3430, z: 3233 },        // -> 3405,9631 (area 1)
    top1: { id: 4965, x: 3413, z: 9633 },         // area 1 -> 43_71 north (2773,4577)
    top2: { id: 4965, x: 3422, z: 9625 },         // area 2 -> 43_71 south (2782,4569)
    lad2: { id: 4966, x: 2782, z: 4569 },         // 43_71 south -> area 2
    swN: { id: 4969, x: 2797, z: 4599 },          // 43_71 north -> 42_70 north (2733,4535)
    swS: { id: 4969, x: 2798, z: 4567 },          // 43_71 south -> 42_70 south (2734,4503)
    neS: { id: 4970, x: 2734, z: 4503 },          // 42_70 south -> 43_71 south
    eA: { id: 4967, x: 2725, z: 4486 },           // 42_70 south -> the fungus area (2789,4486)
    wA: { id: 4968, x: 2789, z: 4486 },           // the fungus area -> 42_70 south
    eC: { id: 4967, x: 2710, z: 4540 },           // 42_70 north -> the cart end (2774,4540)
    wC: { id: 4968, x: 2774, z: 4540 },           // the cart end -> 42_70 north
    eB: { id: 4967, x: 2732, z: 4529 },           // 42_70 north -> the lift area (2796,4529)
    cartStart: { id: 4974, x: 2778, z: 4506 },
    cartEnd: { id: 4974, x: 2774, z: 4537 },      // ^hauntedmine_endcart_coord 0_43_70_22_57
    info: { id: 4949, x: 2769, z: 4522 },         // hauntedmine_points_info: the controls interface
    valve: { id: 4924, x: 2808, z: 4496 },
    lift: { id: 4937, x: 2807, z: 4494 },         // lift_side_l -> 42_69 2725,4452
    darkE: { id: 4971, x: 2746, z: 4436 },        // with a fungus -> 43_69 2811,4454
    darkW: { id: 4971, x: 2692, z: 4436 },        // -> 43_69 2758,4454
    bossDoor: { id: 4962, x: 2799, z: 4453 },
    lightE: { id: 4973, x: 2812, z: 4452 },       // 43_69 -> 42_69 2750,4437
    rewardL: { id: 4963, x: 2773, z: 4450 },
    rewardR: { id: 4964, x: 2772, z: 4450 },
};
// hauntedmine_point_lever<n> (4949 + n) toggles bit n of %hauntedmine_bits (hauntedmine_points.rs2:130-148).
const LEVER: Record<number, { x: number; z: number }> = {
    1: { x: 2785, z: 4517 }, 2: { x: 2784, z: 4517 }, 3: { x: 2786, z: 4517 }, 4: { x: 2786, z: 4515 },
    5: { x: 2785, z: 4515 }, 6: { x: 2768, z: 4533 }, 7: { x: 2769, z: 4533 }, 8: { x: 2770, z: 4533 },
};
// The cart reaches the end when b=1, d=0, a=1, c=0, j=0 (hauntedmine_points.rs2:18-30); a=bit 2, b=1, c=3, d=4, j=7
// (hauntedmine.constant:14-21). The controls show bit n as model 4914-2n (or 4915-2n mirrored) on its com
// (hauntedmine_points.rs2:6-13).
const WANT: Record<number, number> = { 1: 1, 2: 1, 3: 0, 4: 0, 7: 0 };
const COM: Record<number, [string, boolean]> = {
    1: ['com_209', false], 2: ['com_210', false], 3: ['com_211', true], 4: ['com_212', false],
    5: ['com_213', false], 6: ['com_214', true], 7: ['com_215', true], 8: ['com_216', false],
};
const ITEM = { liftKey: 4078, rewardKey: 4077, fungus: 4075, chisel: 1755, shard: 4082 };

const q = await openQuest({ cap: 4500 });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/completed a quest|quest complete/i) > 0) questDone = true; });
    const x = () => q.pos()?.worldX ?? 0;
    const z = () => q.pos()?.worldZ ?? 0;
    const sq = () => `${x() >> 6}_${z() >> 6}`;
    const client: any = (q.s as any).client;
    const shut = () => q.converse([], () => !q.dialogOpen(), 12);
    const at = (l: L) => q.findLoc(k => k.id === l.id && k.x === l.x && k.z === l.z) ?? l;
    const go = async (label: string, l: L, arrived: () => boolean, stand?: { x: number; z: number }) => {
        if (stand) await q.walk(`to ${label}`, [{ x: stand.x, z: stand.z, tol: 1 }]);
        await q.climb(label, () => at(l), /./, arrived, 5);
        await shut();
    };
    // The haunted carts (hauntedmine_cart1-4, hauntedmine.npc:300-355) patrol one-tile lanes, wait 3 ticks at each
    // end, and push a player on the tile ahead of them back one tile (hauntedmine_cart.rs2:1-13). The lane tiles with a
    // side step (SDK collision): cart 1 (x 2727, z 4491-4509) at 2728,4503, 2726,4502, 2726,4496; cart 4 (x 2739, z
    // 4528-4531) at 2740,4531 and 2738,4529. The bot waits beside a lane until the cart has passed, then runs.
    const carts: Record<string, { z: number; dir: number; seen: number; moved: number }> = { c1: { z: 0, dir: 0, seen: -1, moved: -1 }, c4: { z: 0, dir: 0, seen: -1, moved: -1 } };
    const offCart = q.s.onTick(() => {
        for (const n of (q.st()?.nearbyNpcs ?? []) as any[]) {
            if (!/^mine cart$/i.test(n.name)) continue;
            const nx = n.tileX ?? n.x, nz = n.tileZ ?? n.z;
            const k = nx === 2727 && nz >= 4489 && nz <= 4511 ? 'c1' : nx === 2739 && nz >= 4526 && nz <= 4533 ? 'c4' : '';
            if (!k) continue;
            const c = carts[k]!;
            if (c.seen >= 0 && nz !== c.z) { c.dir = Math.sign(nz - c.z); c.moved = q.T(); }
            c.z = nz; c.seen = q.T();
        }
    });
    const fresh = (k: string) => carts[k]!.seen === q.T();
    const waitCart = async (label: string, ok: () => boolean, ticks = 80) => {
        for (let i = 0; i < ticks; i++) { await q.guard(label); if (ok()) return; await q.waitTicks(1); }
        await q.fail(`cart wait ${label} ${JSON.stringify(carts)}`);
    };
    const run = (x0: number, z0: number) => q.s.direct({ type: 'walkTo', x: x0, z: z0, running: true, reason: 'SDK' });
    const runTo = async (label: string, x0: number, z0: number, ticks: number) => {
        await run(x0, z0);
        for (let i = 0; i < ticks && !q.near(x0, z0, 0); i++) { await q.waitTicks(1); if (i % 4 === 3 && !q.near(x0, z0, 0)) await run(x0, z0); }
        return q.near(x0, z0, 0);
    };
    // Cart 1 lane, north to south (to the fungus-area ladder) or south to north.
    const lane1 = async (south: boolean) => {
        for (let a = 0; a < 5; a++) {
            await q.guard('lane 1');
            if (a > 0) q.stats.retries++;
            if (south) {
                await q.walk('lane 1 north end', [{ x: 2728, z: 4510, tol: 0 }]);
                await waitCart('lane 1 south a', () => fresh('c1') && carts.c1!.dir === -1 && carts.c1!.z <= 4500);
                if (!await runTo('lane 1 niche', 2726, 4496, 12)) continue;
                await waitCart('lane 1 south b', () => fresh('c1') && carts.c1!.dir === 1 && carts.c1!.z >= 4497);
                if (await runTo('lane 1 out', 2725, 4487, 10)) return;
            } else {
                await q.walk('lane 1 south end', [{ x: 2726, z: 4488, tol: 0 }]);
                await waitCart('lane 1 north a', () => fresh('c1') && carts.c1!.dir === 1 && carts.c1!.z >= 4497);
                if (!await runTo('lane 1 niche', 2728, 4503, 12)) continue;
                await waitCart('lane 1 north b', () => fresh('c1') && carts.c1!.dir === -1 && carts.c1!.z <= 4501);
                if (await runTo('lane 1 out', 2729, 4510, 10)) return;
            }
            console.log(`WARN lane 1 try ${a} at ${q.pos()?.worldX},${q.pos()?.worldZ} cart ${JSON.stringify(carts.c1)}`);
        }
        await q.fail('lane 1');
    };
    // Cart 4 lane, north to south only: from the side step 2740,4531, go when the cart is one tile from its south stop
    // or has just reached it (the cart is processed before the player, so a later start meets it leaving).
    const lane4 = async () => {
        for (let a = 0; a < 5; a++) {
            await q.guard('lane 4');
            if (a > 0) q.stats.retries++;
            await q.walk('lane 4 north', [{ x: 2740, z: 4532, tol: 0 }]);
            await runTo('lane 4 side', 2740, 4531, 6);
            await waitCart('lane 4', () => fresh('c4') && carts.c4!.dir === -1 && (carts.c4!.z === 4529 || (carts.c4!.z === 4528 && q.T() - carts.c4!.moved <= 1)));
            const t1 = q.T();
            const dbg = q.s.onTick(() => { if (q.T() - t1 <= 8) console.log(`LANE4 ${q.T() - t1} me ${q.pos()?.worldX},${q.pos()?.worldZ} cart ${carts.c4!.z}/${carts.c4!.dir}`); });
            await runTo('lane 4 step', 2738, 4529, 5);
            const ok4 = await runTo('lane 4 out', 2737, 4526, 8);
            dbg();
            if (ok4) return;
            console.log(`WARN lane 4 try ${a} at ${q.pos()?.worldX},${q.pos()?.worldZ} cart ${JSON.stringify(carts.c4)}`);
        }
        await q.fail('lane 4');
    };

    // HM_FROM=lift starts at step 6 (debug preset quest_hauntedmine_lift: 42_70 north, the key and a fungus, varp 3).
    const FROM = process.env.HM_FROM ?? '';
    if (FROM !== 'lift') {
    // 1. The Zealot: Saradomin, challenges, "What quest is that then?" (1, zealot.rs2:18-26,86-90,185-200); "Is there
    // any other way into the mines?" sets the heard-about-key bit (zealot.rs2:97-102); then out by "I must be going now".
    await q.talk('zealot', /^zealot$/i, [/path of saradomin/i, /challenges and quests/i, /what quest is that/i, /any other way into the mines/i,
        /where is the second entrance/i, /i must be going now/i], () => q.sawText(/believe not in luck/i), ZEALOT, 160);
    q.milestone(1);
    // Pickpocket (op3) gives the lift key once the bit is set (zealot.rs2:287-304).
    await q.step('pickpocket', () => { const n = q.npc(/^zealot$/i); return n ? q.s.direct({ type: 'interactNpc', npcIndex: n.index, optionIndex: n.optionsWithIndex?.find((o: any) => /pickpocket/i.test(o.text))?.opIndex ?? 3, reason: 'SDK' }) : q.waitTicks(1); },
        () => q.has(ITEM.liftKey), 15, 4);
    q.milestone('key');

    // 2. Over the cart to the secondary entrance (3); area 1 to the ledge by back entrance 1; back entrance 2 to area 2.
    await go('cart jump', LOC.cartJump!, () => x() <= 3444 && z() < 3240, { x: 3446, z: 3236 });
    await go('secondary entrance', LOC.secondary!, () => z() > 9000, { x: 3441, z: 3232 });
    q.milestone(3);
    await go('back 1 out', LOC.back1In!, () => z() < 4000, { x: 3405, z: 9631 });
    await go('back 2 in', LOC.back2!, () => z() > 9000, { x: 3428, z: 3225 });
    await go('ladder area 2', LOC.top2!, () => sq() === '43_71', { x: 3421, z: 9625 });
    await go('ladder 43_71 south', LOC.swS!, () => sq() === '42_70', { x: 2798, z: 4568 });
    await lane1(true);
    await go('ladder fungus area', LOC.eA!, () => sq() === '43_70');
    q.milestone('fungus area');

    // 3. A glowing fungus (hauntedmine_fungus.rs2:1-12) into the cart (:54-69).
    const mush = () => q.findLoc(l => (l.id === 4932 || l.id === 4933));
    await q.step('fungus', () => { const m = mush(); return m ? q.opLoc(m, q.opIndex(m, /pick/i)) : q.waitTicks(1); }, () => q.has(ITEM.fungus), 25, 5);
    await q.walk('to cart start', [{ x: 2779, z: 4505, tol: 1 }]);
    await q.step('fungus in cart', () => q.useOnLoc(ITEM.fungus, at(LOC.cartStart!)), () => !q.has(ITEM.fungus), 15, 4);
    q.milestone('cart loaded');

    // 4. The points: the controls show the 8 bits (randomized on first use); the levers set b, a, c, d, j; the
    // controls' button sends the cart (hauntedmine_points.rs2:1-30).
    const IFACE = componentId('hauntedmine_controls');
    const readBits = (): Record<number, number> => {
        const b: Record<number, number> = {};
        for (const [n, [com, mirrored]] of Object.entries(COM)) {
            const m = client.ifMutable(componentId(`hauntedmine_controls:${com}`))?.model1Id;
            b[Number(n)] = ((mirrored ? 4915 : 4914) - m) / 2;
        }
        return b;
    };
    const openControls = async () => {
        await q.walk('to controls', [{ x: LOC.info!.x, z: LOC.info!.z - 1, tol: 1 }]);
        await q.step('controls', () => q.opLoc(at(LOC.info!)), () => q.st()?.modalInterface === IFACE, 15, 4);
        await q.waitTicks(1);
    };
    await openControls();
    const bits = readBits();
    console.log(`BITS ${JSON.stringify(bits)} modal=${q.st()?.modalInterface}`);
    if (Object.values(bits).some(v => v !== 0 && v !== 1)) await q.fail(`bits unread ${JSON.stringify(bits)}`);
    await q.s.sdk.sendCloseModal();
    await q.waitTicks(1);
    const pulls = Object.keys(WANT).map(Number).filter(n => bits[n] !== WANT[n]);
    // Lever 7 is in the west row, levers 1-4 in the east cluster; the controls are between them.
    pulls.sort((a, b) => (a === 7 ? -1 : 0) - (b === 7 ? -1 : 0));
    for (const n of pulls) {
        const p = LEVER[n]!;
        const k0 = q.msgCount(/you pull the lever/i);
        await q.step(`lever ${n}`, () => q.opLoc({ id: 4949 + n, x: p.x, z: p.z }), () => q.msgCount(/you pull the lever/i) > k0, 30, 4);
        bits[n] ^= 1;
    }
    console.log(`PULLS ${pulls.join(',')} at ${q.T()}`);
    await openControls();
    const now = readBits();
    if (Object.keys(WANT).some(n => now[Number(n)] !== WANT[Number(n)])) await q.fail(`points wrong ${JSON.stringify(now)}`);
    await q.step('send cart', () => q.s.direct({ type: 'clickComponent', componentId: componentId('hauntedmine_controls:com_222'), reason: 'SDK' }),
        () => q.sawText(/anywhere useful now/i) || q.msgCount(/sunk|right back to where/i) > 0, 25, 2);
    if (!q.sawText(/anywhere useful now/i)) await q.fail('cart not at the end');
    await shut();
    await q.s.sdk.sendCloseModal();
    q.milestone('cart sent');

    // 5. Out the way the bot came (area 2, back entrance 2 to the ledge), in by back entrance 1 to area 1, to the cart
    // end for the fungus (hauntedmine_fungus.rs2:71-82).
    await go('ladder out of fungus area', LOC.wA!, () => sq() === '42_70', { x: 2789, z: 4487 });
    await lane1(false);
    await go('ladder 42_70 south', LOC.neS!, () => sq() === '43_71', { x: 2734, z: 4504 });
    await go('ladder to area 2', LOC.lad2!, () => z() > 9000, { x: 2782, z: 4570 });
    await go('back 2 out', LOC.back2In!, () => z() < 4000, { x: 3409, z: 9623 });
    await go('back 1 in', LOC.back1!, () => z() > 9000, { x: 3430, z: 3232 });
    await go('ladder area 1', LOC.top1!, () => sq() === '43_71', { x: 3414, z: 9633 });
    await go('ladder 43_71 north', LOC.swN!, () => sq() === '42_70', { x: 2797, z: 4598 });
    await go('ladder cart end', LOC.eC!, () => sq() === '43_70', { x: 2710, z: 4539 });
    await q.step('cart end', () => q.opLoc(at(LOC.cartEnd!)), () => q.dialogOpen() || q.has(ITEM.fungus), 20, 4);
    await q.converse([/^take it/i], () => q.has(ITEM.fungus) && !q.dialogOpen(), 15);
    if (!q.has(ITEM.fungus)) await q.fail('fungus from cart');
    q.milestone('fungus');
    await go('ladder from cart end', LOC.wC!, () => sq() === '42_70', { x: 2774, z: 4539 });
    }

    // 6. The lift area: the key on the valve (4, then powered, hauntedmine_lift.rs2:63-91); the lift (5) to the flooded
    // level (:8-27). The ghost that shuts the valve starts only north of the lift (:94-111).
    await lane4();
    await go('ladder lift area', LOC.eB!, () => sq() === '43_70', { x: 2732, z: 4530 });
    await q.walk('to valve', [{ x: 2807, z: 4496, tol: 1 }]);
    await q.step('valve', () => q.useOnLoc(ITEM.liftKey, at(LOC.valve!)), () => q.msgCount(/you open the valve|already open/i) > 0, 20, 4);
    q.milestone(4);
    await q.step('lift', () => q.opLoc(at(LOC.lift!)), () => sq() === '42_69', 15, 4);
    await q.waitUntil(() => z() <= 4452, 6);
    q.milestone(5);

    // 7. The east dark stairs with the fungus (7) to the boss level (hauntedmine_darkstairs.rs2:34-47).
    await go('dark stairs east', LOC.darkE!, () => sq() === '43_69' || sq() === '42_71', { x: 2745, z: 4437 });
    if (sq() !== '43_69') await q.fail('dark stairs went to the dark level');
    q.milestone(7);

    // 8. The boss door; the key wakes Treus Dayth (8, hauntedmine_boss_ghost.rs2:18-92).
    await go('boss door in', LOC.bossDoor!, () => x() < 2799, { x: 2800, z: 4453 });
    const keyNpc = () => q.npc(/^innocent looking key$/i);
    const boss = () => q.npc(/^treus dayth$/i);
    const killed = () => q.sawText(/killing strike/i);
    await q.step('boss key', () => { const k = keyNpc(); return k ? q.s.direct({ type: 'interactNpc', npcIndex: k.index, optionIndex: q.opIndex(k, /take/i), reason: 'SDK' }) : q.waitTicks(1); },
        () => q.dialogOpen() || !!boss(), 20, 4);
    await q.converse([], () => !!boss() && !q.dialogOpen(), 40);
    q.milestone(8);
    // 9. The fight: the ghost moves after hits (ai_queue1, :244-245) and fades (no Attack op) on the way; it hits with
    // the carts, cranes or pickaxes every 5 ticks (:112-147, 0-15). Fire Wave from range (magic defence -5,
    // hauntedmine.npc:205): no walk to a ghost that stands where melee cannot reach.
    const WAVE = componentId('magic:fire_wave');
    // A cast with no Magic XP 6 ticks later had no line of sight (a crane between): the bot runs at the ghost first.
    let lastCast = -99, casts = 0, mxp = q.xp('Magic'), closer = 0, seen = q.T();
    for (let i = 0; i < 900 && !killed(); i++) {
        await q.guard('boss');
        const b = boss();
        // Out of the NPC view (15 tiles) from a far corner: back to the room's middle, where every spot is in view.
        const anyGhost = (q.st()?.nearbyNpcs ?? []).some((n: any) => /treus dayth|^ghost$/i.test(n.name));
        if (anyGhost) seen = q.T();
        else if (q.T() - seen >= 3 && !q.near(2788, 4451, 1)) { await q.s.direct({ type: 'walkTo', x: 2788, z: 4451, running: true, reason: 'SDK' }); seen = q.T(); }
        if (b && !q.dialogOpen() && q.T() - lastCast >= 5) {
            const bx = b.tileX ?? b.x, bz = b.tileZ ?? b.z;
            if ((lastCast > 0 && q.xp('Magic') === mxp) || q.cheb(bx, bz) > 8) {
                closer++;
                // The south spot (move index 5, 2787,4443-4445, hauntedmine_boss_ghost.rs2:335-341) has no line of sight
                // from the room's middle; 2788,4448 has (a clear column).
                const [tx, tz] = bz <= 4446 ? [2788, 4448] : [bx, bz];
                const wr: any = await q.s.direct({ type: 'walkTo', x: tx, z: tz, running: true, reason: 'SDK' });
                await q.waitUntil(() => { const g = boss(); return !g || q.near(tx, tz, bz <= 4446 ? 0 : 3); }, 8);
                if (closer % 4 === 1) console.log(`CLOSER ${q.T()} to ${tx},${tz} now ${q.pos()?.worldX},${q.pos()?.worldZ} r=${JSON.stringify(wr).slice(0, 160)}`);
            }
            const b2 = boss();
            if (b2) {
                casts++; lastCast = q.T(); mxp = q.xp('Magic');
                await q.s.direct({ type: 'spellOnNpc', npcIndex: b2.index, spellComponent: WAVE, reason: 'SDK' });
            }
        }
        if (i % 20 === 0) {
            const g: any = (q.st()?.nearbyNpcs ?? []).find((n: any) => /treus dayth|^ghost$/i.test(n.name));
            console.log(`BOSS ${q.T()} me ${q.pos()?.worldX},${q.pos()?.worldZ} npc ${g?.name}@${g?.tileX ?? g?.x},${g?.tileZ ?? g?.z} hp=${g?.hp}/${g?.maxHp} casts=${casts} closer=${closer} myhp=${q.hp()}`);
        }
        await q.waitTicks(1);
    }
    if (!killed()) await q.fail('boss');
    await shut();
    q.milestone(9);
    await q.step('reward key', () => { const k = keyNpc(); return k ? q.s.direct({ type: 'interactNpc', npcIndex: k.index, optionIndex: q.opIndex(k, /take/i), reason: 'SDK' }) : q.waitTicks(1); },
        () => q.has(ITEM.rewardKey), 20, 4);
    await shut();
    q.milestone('reward key');

    // 10. Out of the boss room, down the light stairs, up the west stairs (light now, :36) to the reward door (10,
    // hauntedmine_crystals.rs2:1-29) and a crystal cut with the chisel (complete, :39-56).
    await go('boss door out', LOC.bossDoor!, () => x() > 2799, { x: 2798, z: 4453 });
    await go('light stairs', LOC.lightE!, () => sq() === '42_69', { x: 2811, z: 4453 });
    await go('dark stairs west', LOC.darkW!, () => sq() === '43_69', { x: 2693, z: 4438 });
    await q.walk('to reward door', [{ x: 2772, z: 4451, tol: 0 }]);
    await q.climb('reward door', () => at(LOC.rewardR!), /open/i, () => z() < 4450, 5);
    q.milestone(10);
    const crystal = () => q.findLoc(l => l.id === 4928);
    await q.step('crystal', () => { const c = crystal(); return c ? q.opLoc(c, q.opIndex(c, /cut|chip|mine/i)) : q.walk('to crystals', [{ x: 2789, z: 4430, tol: 2 }]); },
        () => questDone || q.has(ITEM.shard), 40, 4);
    await q.waitUntil(() => questDone, 5);
    await shut();
    q.milestone(11);
    off(); offCart();
    await q.end(questDone, `qp=2 shard=${q.has(ITEM.shard)}`);
} catch (e) { await q.fail(String(e)); }
