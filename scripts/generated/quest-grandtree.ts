// The Grand Tree from preset quest_grandtree (beside King Narnode), at the planner's state for the grandtree row:
// Attack 60, Strength, Defence 1, 10 HP, Magic 43, Prayer 43, Agility 25, Tree Gnome Village done (varp 111 = 9).
// Reward (quest_grandtree.rs2:195-203): 197,500 Agility, 460,000 Attack, 53,750 Magic at 25x, 5 QP.
// Varp %grandtree (150, quest_grandtree.constant): 10 Narnode's bark and book, 20 Hazelmere's scroll, 30 the
// translation, 40 Glough, 50 Narnode, 60 Charlie, 70 Glough's journal, 80 jail and release, 90 the lumber order,
// 100 Charlie, 110 the invasion plans, 120 the twigs, 130 the pillars, 140 the black demon, 150 Narnode underground,
// then a Daconia rock from one of 15 roots and Narnode queues the completion (160).
// Combat: the black demon (157 HP, melee only, quest_grandtree.npc:190-216) under Protect from Melee, Fire Bolt.
// GT_FROM=<varp stage> starts later (debug presets quest_grandtree_s<stage>).
import { openQuest } from './quest-lib';
import { componentId } from '../../packages/core/src/logout';

const ITEM = {
    bark: 783, book: 784, journal: 785, scroll: 786, order: 787, key: 788,
    twigT: 789, twigU: 790, twigZ: 791, twigO: 792, rock: 793, plans: 794,
    prayerPot: [2434, 139, 141, 143], antipoison: [2446, 175, 177, 179], food: 379,
};
const NARNODE = { x: 2466, z: 3497 };                 // ground floor of the Grand Tree (m38_54 npc 670)
const NARNODE_UNDER = { x: 2464, z: 9897 };           // in the roots (m38_154 npc 670)
const TREE_LADDER = { x: 2466, z: 3495 };             // ladder l0, laddermiddle l1, grandtree_laddermiddle l2, top l3
const GLOUGH_LADDER = { x: 2476, z: 3463 };           // Glough's tree house, l0 -> l1 (m38_54 loc 1747)
const CUPBOARD = { x: 2476, z: 3465 };                // l1, loc 2434
const CHEST = { x: 2482, z: 3462 };                   // l1, loc 2436
const CLIMBTREE = { x: 2484, z: 3464 };               // l1, loc 2447, Agility 25 (quest_grandtree.rs2:23-29)
const TRAPDOOR = { x: 2487, z: 3464 };                // l2, loc 2444
const PILLARS: [number, number][] = [[ITEM.twigT, 2485], [ITEM.twigU, 2486], [ITEM.twigZ, 2487], [ITEM.twigO, 2488]]; // z 3467, l2 (quest_grandtree.rs2:35-51)
const GATE = { x: 2459, z: 3383 };                    // gnome_areagate (m38_52 loc 190); north side 2461,3385
const HAZEL_LADDER = { x: 2677, z: 3087 };            // m41_48, Hazelmere on l1 at 2678,3086
const VILLAGE_TREE = { x: 2543, z: 3168 };            // stronghold_ent (m39_49 loc 1294)
const STRONGHOLD_LAND = { x: 2461, z: 3443 };         // ^stronghold_tree
const PILOT = { x: 2464, z: 3501 };                   // l3, gnomepilot (zone 2463-2467,3499-3503)
const CRASH = { x: 2917, z: 3058 };                   // Karamja landing (gnome_glider.rs2:93)
const SHIP_GATE = { x: 2945, z: 3041 };               // grandtree_fencegate_l, guard at 2944,3040
const FOREMAN = { x: 2999, z: 3043 };
const VARROCK_TREE = { x: 3177, z: 3506 };            // young spirit tree (m49_54 loc 1317)
const ANITA_STAIRS = { x: 2389, z: 3512 };            // spiralstairs to l1, Anita at 2390,3514
const DEMON_ARRIVE = { x: 2491, z: 9864 };
// Daconia roots, varp 151 = 1..15 (daconia_coords.enum; index 0 shares 2456,9886 with 1 and Map.set keeps 1).
const ROOTS: [number, number][] = [[2467, 9896], [2473, 9897], [2481, 9904], [2490, 9889], [2485, 9885], [2468, 9890], [2465, 9891],
    [2456, 9886], [2457, 9881], [2455, 9874], [2467, 9872], [2443, 9878], [2439, 9881], [2444, 9893], [2452, 9893]];
const PFM = 14;
const BOLT = componentId('magic:fire_bolt');
// Fire Blast (Magic 59, max 16; Fire Bolt max 12, magic_combat_spells.dbrow) while the pack holds death runes (560).
const BLAST = componentId('magic:fire_blast');

const q = await openQuest({ cap: 6000, eatAt: 6, food: [ITEM.food] });
try {
    const FROM = Number(process.env.GT_FROM ?? 0);
    let questDone = false;
    const offDone = q.s.onTick(() => { if (q.msgCount(/quest complete|completed the\s+grand tree/i) > 0) questDone = true; });
    const prayers = (): any => q.st()?.prayers;
    const pfmOn = (): boolean => !!prayers()?.activePrayers?.[PFM];
    const points = (): number => prayers()?.prayerPoints ?? 0;
    let potions = 0;
    const setPfm = async (on: boolean): Promise<void> => {
        if (pfmOn() === on || (on && points() <= 0)) return;
        await q.step(`protect from melee ${on ? 'on' : 'off'}`, () => q.s.direct({ type: 'togglePrayer', prayerIndex: PFM, reason: 'SDK' }), () => pfmOn() === on, 3, 3);
    };
    const keepPrayer = async (): Promise<void> => {
        if (points() > 8) return;
        const pot = ITEM.prayerPot.find(id => q.has(id));
        if (!pot) return;
        const p0 = points();
        potions++;
        await q.step('prayer potion', () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(pot)!, optionIndex: 1, reason: 'SDK' }), () => points() > p0, 3, 2);
    };
    const near3 = (l: any, p: { x: number; z: number }, r: number) => Math.max(Math.abs(l.x - p.x), Math.abs(l.z - p.z)) <= r;
    const locNear = (re: RegExp, p: { x: number; z: number }, r = 2) => q.findLoc(l => re.test(l.name) && near3(l, p, r));
    const level = (): number => q.lvl();
    const z = (): number => q.pos()?.worldZ ?? 0;
    const shutDialog = () => q.converse([], () => !q.dialogOpen(), 10);
    // A page that opens during a walk (a guard, a level-up) is clicked through, so the walk goes on.
    let walking = false;
    const offWalk = q.s.onTick(() => {
        if (!walking) return;
        const d: any = q.s.sdk.getDialog();
        if (d?.isOpen && !d.isWaiting && !(d.options ?? []).some((o: any) => !/click here to continue/i.test(o.text))) void q.s.sdk.sendClickDialog(0);
    });
    // Inside the Grand Tree trunk (l0). walkPath takes the trapdoor (2463,3497) for a shut door and clicked it for
    // 210 ticks ("The trapdoor won't open!") in a test run, so the trunk is left and entered by the tree doors.
    const inTrunk = (x: number, zz: number): boolean => x >= 2463 && x <= 2468 && zz >= 3493 && zz <= 3498;
    const exitTree = async (): Promise<void> => {
        await q.dash('to tree door inside', 2465, 3493, 0, 12);
        await q.step('tree door out', () => { const d = q.findLoc(l => /tree door/i.test(l.name) && near3(l, { x: 2465, z: 3492 }, 2)); return d ? q.opLoc(d, q.opIndex(d, /open/i)) : q.waitTicks(1); }, () => z() <= 3491, 10, 4);
    };
    const walk = async (label: string, pts: { x: number; z: number; tol?: number }[]): Promise<void> => {
        const g = pts[pts.length - 1]!;
        const p0 = q.pos();
        if (level() === 0 && p0 && inTrunk(p0.worldX, p0.worldZ) && !inTrunk(g.x, g.z)) await exitTree();
        walking = true;
        try { await q.walk(label, pts); } finally { walking = false; }
    };
    // GT_STOP=<stage>: end the run (as a pass) at that milestone, for debug runs.
    const STOP = Number(process.env.GT_STOP ?? 999);
    const ms = async (k: number | string): Promise<void> => { q.milestone(k); if (typeof k === 'number' && k >= STOP) await q.end(true, `stopped at ${k}`); };
    // The gameMessages list is capped: a new message is told by its observationId, not by a count (section 1d).
    const lastMsg = (re: RegExp): number => Math.max(-1, ...(q.st()?.gameMessages ?? []).filter((m: any) => m.type === 0 && re.test(m.text)).map((m: any) => m.observationId ?? m.tick));

    // A ladder or stairs click at (p) on the bot's level, retried until the level changes to `to`.
    // A ladder with Climb / Climb-up / Climb-down takes the direct op; a plain Climb opens "Climb Up." / "Climb Down."
    // (ladders.rs2:128-139), answered here.
    const ladder = async (label: string, p: { x: number; z: number }, dir: 'up' | 'down', to: number): Promise<void> => {
        const direct = dir === 'up' ? /^climb[- ]up/i : /^climb[- ]down/i;
        await q.step(label, async () => {
            const k = q.findLoc(l => /ladder|stair|tree/i.test(l.name) && near3(l, p, 1) && (l.optionsWithIndex ?? []).some((o: any) => /climb/i.test(o.text)));
            if (!k) return q.waitTicks(1);
            const op = (k.optionsWithIndex ?? []).find((o: any) => direct.test(o.text)) ?? (k.optionsWithIndex ?? []).find((o: any) => /climb/i.test(o.text));
            await q.opLoc(k, op.opIndex);
            await q.waitUntil(() => level() === to || q.dialogOpen(), 12);
            if (q.dialogOpen()) await q.converse([dir === 'up' ? /^climb up/i : /^climb down/i], () => level() === to, 8);
        }, () => level() === to, 4, 5);
        await shutDialog();
    };
    // The Grand Tree doors (treedoorl/r 2464-2466,3492, shape 10, gnome_gate.rs2:62-76) are solid to the SDK
    // pathfinder: from the south it routed to 2470,3494, outside the trunk, and failed. Op1 moves the player 2 tiles north.
    const enterTree = async (): Promise<void> => {
        if (level() !== 0 || z() >= 3493 || z() > 6400) return;
        await walk('to tree door', [{ x: 2465, z: 3490, tol: 1 }]);
        await q.step('tree door', () => { const d = q.findLoc(l => /tree door/i.test(l.name) && near3(l, { x: 2465, z: 3492 }, 2)); return d ? q.opLoc(d, q.opIndex(d, /open/i)) : q.waitTicks(1); }, () => z() >= 3493, 10, 4);
    };
    // Grand Tree ladders: l0 ladder, l1 laddermiddle, l2 grandtree_laddermiddle (op2 Climb-up spawns Charlie), l3 top.
    const treeTo = async (to: number): Promise<void> => {
        if (level() < 0) return;
        // 2467,3495 is the walkable tile east of the ladder (2466,3496 has no path: walkTo PATHFINDING FAILED).
        if (level() === 0 && to > 0) await enterTree();
        if (level() === 0 && to > 0) await walk('to tree ladder', [{ x: TREE_LADDER.x + 1, z: TREE_LADDER.z, tol: 1 }]);
        while (level() < to) await ladder(`tree up ${level()}`, TREE_LADDER, 'up', level() + 1);
        while (level() > to) await ladder(`tree down ${level()}`, TREE_LADDER, 'down', level() - 1);
    };
    const gloughUp = async (): Promise<void> => {
        if (level() === 0) {
            await walk('to glough ladder', [{ x: GLOUGH_LADDER.x, z: GLOUGH_LADDER.z - 1, tol: 1 }]);
            await ladder('glough ladder up', GLOUGH_LADDER, 'up', 1);
        }
    };
    const gloughDown = async (): Promise<void> => {
        if (level() === 2) await ladder('glough tree down', { x: 2485, z: 3464 }, 'down', 1);
        if (level() === 1) {
            await walk('to glough ladder top', [{ x: GLOUGH_LADDER.x, z: GLOUGH_LADDER.z - 1, tol: 1 }]);
            await ladder('glough ladder down', GLOUGH_LADDER, 'down', 0);
        }
    };
    // One Talk-to, then pages until ok(): for dialogs with if_close + p_delay gaps (Narnode's guard, 7 ticks,
    // king_narnode.rs2:51-56), where q.talk's 3-shut-tick retry sends a new Talk-to and restarts the dialog.
    const talkOnce = async (label: string, re: RegExp, pats: RegExp[], ok: () => boolean, max: number): Promise<void> => {
        for (let i = 0; i < 3 && !ok(); i++) {
            await q.guard(label);
            if (i > 0) q.stats.retries++;
            const n = q.npc(re);
            if (!n) { await q.waitTicks(2); continue; }
            await q.talkTo(n);
            await q.waitUntil(() => q.dialogOpen(), 20);
            await q.converse(pats, ok, max);
        }
        if (!ok()) await q.fail(`talk ${label}`);
    };
    const narnode = async (label: string, pats: RegExp[], ok: () => boolean, max = 150): Promise<void> => {
        if (level() > 0 && z() < 6400) await treeTo(0);
        if (z() < 6400) await enterTree();
        if (z() < 6400) await walk(`to ${label}`, [{ x: TREE_LADDER.x + 1, z: TREE_LADDER.z, tol: 2 }]);
        await q.talk(label, /^king narnode/i, pats, ok, z() > 6400 ? NARNODE_UNDER : NARNODE, max);
    };
    // A spirit tree: op1, then the dialog choices, until the bot lands near `land`.
    const spiritTree = async (label: string, at: { x: number; z: number }, pats: RegExp[], land: { x: number; z: number }, walkTo = true): Promise<void> => {
        if (walkTo) await walk(`to ${label}`, [{ x: at.x, z: at.z - 2, tol: 2 }]);
        for (let i = 0; i < 3 && !q.near(land.x, land.z, 8); i++) {
            await q.guard(label);
            const t = q.findLoc(l => /tree/i.test(l.name) && near3(l, at, 2) && (l.optionsWithIndex ?? []).length > 0 && l.reachable !== false);
            if (!t) { console.log(`WARN no ${label}: ${q.locs().slice(0, 12).map((l: any) => `${l.name}@${l.x},${l.z}`).join(' ')}`); await q.waitTicks(1); continue; }
            await q.opLoc(t, 1);
            await q.waitUntil(() => q.dialogOpen(), 15);
            await q.converse(pats, () => q.near(land.x, land.z, 8), 40);
        }
        if (!q.near(land.x, land.z, 8)) await q.fail(label);
        await shutDialog();
    };
    const usePrayerWalk = async (label: string, pts: { x: number; z: number; tol?: number }[]): Promise<void> => {
        await setPfm(true);
        await walk(label, pts);
        await keepPrayer();
    };

    // 10. Narnode: "You seem worried", "I'd be happy to help!"; he takes the player under the trapdoor and back up.
    if (FROM < 10) {
        await talkOnce('narnode 1', /^king narnode/i, [/you seem worried/i, /happy to help/i], () => q.has(ITEM.bark) && q.has(ITEM.book) && z() < 6400 && !q.dialogOpen(), 200);
        await ms(10);
    }

    // 20. Hazelmere (island east of Yanille, l1): he takes the bark and writes the scroll.
    if (FROM < 20) {
        await walk('to gate', [{ x: GATE.x + 2, z: GATE.z + 3, tol: 1 }]);
        if (z() > GATE.z) {
            await q.step('gate out', () => { const g = q.findLoc(l => /gate/i.test(l.name) && near3(l, GATE, 3) && (l.optionsWithIndex ?? []).some((o: any) => /open/i.test(o.text))); return g ? q.opLoc(g, q.opIndex(g, /open/i)) : q.waitTicks(1); }, () => z() <= GATE.z, 12, 4);
        }
        q.milestone('gate');
        // Jungle spiders (melee, no poison param, _unpack/225/all.npc:1585-1607) cover the island: the prayer goes on
        // west of it (test runs took hits at 2679,3102 and 2683,3116; one died there).
        // The road east passes under the Combat Training Camp gate (2517-2518,3356, locked before Biohazard,
        // combat_training_camp.rs2:36-43). walkPath takes the gate for a door on its path and clicked it for 410 ticks
        // (the guard's page each time); a door block does not change the long path. A client-routed click goes past.
        await walk('to camp road', [{ x: 2509, z: 3355, tol: 1 }]);
        await q.dash('past camp gate', 2526, 3353, 1, 20);
        await walk('to hazelmere island', [{ x: 2638, z: 3089, tol: 4 }]);
        await usePrayerWalk('to hazelmere', [{ x: HAZEL_LADDER.x, z: HAZEL_LADDER.z + 1, tol: 1 }]);
        await ladder('hazelmere ladder up', HAZEL_LADDER, 'up', 1);
        await setPfm(false);
        await q.talk('hazelmere', /^hazelmere/i, [], () => q.has(ITEM.scroll) && !q.dialogOpen(), { x: 2678, z: 3086 }, 60);
        await ms(20);
        await ladder('hazelmere ladder down', HAZEL_LADDER, 'down', 0);
        // The way off is the pier north of the island (2652-2672,3109-3111), as on the way in. With one far goal the bot
        // paced 2670-2673,3089-3091 until the prayer ran out and the spiders killed it.
        await usePrayerWalk('off the island', [{ x: 2678, z: 3099, tol: 2 }, { x: 2674, z: 3109, tol: 2 }, { x: 2660, z: 3111, tol: 2 }, { x: 2652, z: 3103, tol: 2 }, { x: 2638, z: 3089, tol: 4 }]);
        await setPfm(false);
    }

    // The village fence: the loose railing (loc 2186 at 2515,3161, gnomevillage_fence.rs2) from the south side, then
    // the west side of the village to the spirit tree beside King Bolren (route proved in quest-tree.ts).
    // From the east the SDK path runs through the maze, out at 2549,3171 and south past the giants at 2545,3144
    // (one test run: 10 -> 7 HP). Elkoy outside the maze puts the player at 2515,3159 (elkoy.rs2:160-180).
    const villageIn = async (): Promise<void> => {
        await walk('to elkoy', [{ x: 2504, z: 3194, tol: 2 }]);
        await q.talk('elkoy', /^elkoy$/i, [/^yes please/i], () => q.cheb(2515, 3159) <= 4, { x: 2504, z: 3192 }, 40);
        await shutDialog();
        await q.dash('to railing tile', 2515, 3160, 0, 10);
        const rail = () => q.findLoc(l => l.id === 2186 || /loose railing/i.test(l.name));
        await q.step('squeeze railing', () => { const r = rail(); return r ? q.opLoc(r, q.opIndex(r, /squeeze/i)) : q.waitTicks(1); }, () => z() >= 3161, 8, 4);
        await walk('to village tree', [{ x: 2529, z: 3165, tol: 2 }, { x: 2542, z: 3166, tol: 1 }]);
    };

    // 30. Back by the village spirit tree to the stronghold; Narnode and the translation:
    // "None of the above." twice, "A man came to me with the King's seal.", "I gave the man Daconia rocks.",
    // "And Daconia rocks will kill the tree!" (king_narnode.rs2:175-187, 324-413).
    if (FROM < 30) {
        await villageIn();
        await spiritTree('village tree', VILLAGE_TREE, [/where can i go/i, /gnome stronghold/i], STRONGHOLD_LAND, false);
        await narnode('narnode 2', [/i think so/i, /^none of the above/i, /king's seal/i, /gave the man daconia/i, /daconia rocks will kill/i], () => q.sawText(/meet me back here once you've told him|i'll be back soon/i) && !q.dialogOpen());
        await ms(30);
    }

    // 40. Glough in his tree house (l1).
    if (FROM < 40) {
        await gloughUp();
        await q.talk('glough 1', /^glough/i, [], () => q.sawText(/go back to the king/i) && !q.dialogOpen(), { x: 2478, z: 3463 }, 60);
        await ms(40);
    }

    // 50. Narnode: the prisoner is at the top of the tree.
    if (FROM < 50) {
        await gloughDown();
        await narnode('narnode 3', [], () => q.sawText(/top level of the tree|long way down/i) && !q.dialogOpen());
        await ms(50);
    }

    // Charlie is behind the prison door (2465,3495-3496 l3, blockrange=no, _unpack/225/all.loc:15100-15105); his talk is
    // an ap op (charlie.rs2:1), so it needs line of sight. The laddertop (2466,3495) blocks it from the ladder tile.
    // Charlie lives 500 ticks from the Climb-up that adds him (npc_add, quest_grandtree.rs2:17-21); one test run came
    // back at the end of that window and he was gone. No Charlie: down one ladder and up again adds a new one.
    const toBars = async (): Promise<void> => {
        await q.waitUntil(() => !!q.npc(/^charlie/i), 3);
        if (!q.npc(/^charlie/i)) {
            await ladder('respawn charlie down', TREE_LADDER, 'down', 2);
            await ladder('respawn charlie up', TREE_LADDER, 'up', 3);
        }
        await q.dash('to prison bars', 2465, 3495, 0, 12);
    };

    // 60. Charlie at the top (l3); the l2 ladder's Climb-up spawns him (ladders.rs2:141-144).
    if (FROM < 60) {
        await treeTo(3);
        await toBars();
        await q.talk('charlie 1', /^charlie/i, [], () => q.sawText(/search his home|good luck/i) && !q.dialogOpen(), { x: 2464, z: 3495 }, 60);
        await ms(60);
    }

    // 70. Glough's cupboard: open, search, the journal.
    if (FROM < 70) {
        await treeTo(0);
        await gloughUp();
        await walk('to cupboard', [{ x: CUPBOARD.x, z: CUPBOARD.z - 1, tol: 1 }]);
        await q.step('cupboard', async () => {
            const c = locNear(/cupboard/i, CUPBOARD, 1);
            if (!c) return q.waitTicks(1);
            const search = (c.optionsWithIndex ?? []).find((o: any) => /search/i.test(o.text));
            await q.opLoc(c, search ? search.opIndex : q.opIndex(c, /open/i));
            await q.waitTicks(2);
            await shutDialog();
        }, () => q.has(ITEM.journal), 10, 6);
        await ms(70);
    }

    // 80. Glough calls the guards; the jail, Charlie, Narnode lets the player out (l3, 2465,3496).
    if (FROM < 80) {
        // The dialog closes between the guard, Charlie and Narnode pages (glough.rs2:40-68, charlie.rs2:58-83).
        // One Talk-to only: a second one during the guard's p_delay (if_close, then 4 ticks) restarts Glough's dialog.
        for (let i = 0; i < 3 && level() !== 3; i++) {
            await q.guard('glough 2');
            const g = q.npc(/^glough/i);
            if (!g) { await q.waitTicks(1); continue; }
            await q.talkTo(g);
            await q.waitUntil(() => q.dialogOpen(), 15);
            await q.converse([], () => level() === 3, 60);
        }
        if (level() !== 3) await q.fail('glough 2: not jailed');
        await q.converse([], () => q.sawText(/sorry again traveller/i) && !q.dialogOpen(), 80);
        if (!q.sawText(/sorry again traveller/i)) await q.fail('jail: no release');
        await ms(80);
    }

    // 90. The glider to Karamja, the shipyard gate (Glough sent me; Ka, Lu, Min), the foreman (3 answers).
    if (FROM < 90) {
        await treeTo(3);
        await walk('to pilot', [{ x: PILOT.x + 1, z: PILOT.z - 1, tol: 1 }]);
        // A jogre hit the bot for 6 (10 -> 4 HP) on the landing tile in a test run: the prayer goes on before the flight.
        await setPfm(true);
        await talkOnce('pilot', /^gnome pilot/i, [/take me to karamja/i], () => q.near(CRASH.x, CRASH.z, 10) && !q.dialogOpen(), 80);
        q.milestone('karamja');
        // Jogres and jungle spiders stand by the way to the gate (research/route-danger.ts): melee, so the prayer is on.
        await keepPrayer();
        await usePrayerWalk('to shipyard gate', [{ x: SHIP_GATE.x - 2, z: SHIP_GATE.z, tol: 1 }]);
        for (let i = 0; i < 3 && (q.pos()?.worldX ?? 0) < SHIP_GATE.x; i++) {
            await q.guard('shipyard gate');
            const g = q.findLoc(l => /gate/i.test(l.name) && near3(l, SHIP_GATE, 1));
            if (!g) { await q.waitTicks(1); continue; }
            await q.opLoc(g, q.opIndex(g, /open/i));
            await q.waitUntil(() => q.dialogOpen(), 10);
            await q.converse([/glough sent me/i, /^ka\.$/i, /^lu\.$/i, /^min\.$/i], () => (q.pos()?.worldX ?? 0) >= SHIP_GATE.x, 60);
        }
        if ((q.pos()?.worldX ?? 0) < SHIP_GATE.x) await q.fail('shipyard gate');
        await setPfm(false);
        await walk('to foreman', [{ x: FOREMAN.x - 2, z: FOREMAN.z, tol: 3 }]);
        await talkOnce('foreman', /^foreman/i, [/no longer with us/i, /worm holes/i, /^anita\.$/i], () => q.has(ITEM.order) && !q.dialogOpen(), 120);
        await ms(90);
    }

    // 100. Varrock Teleport, the young spirit tree, the village tree to the stronghold (inside the gate); Charlie.
    if (FROM < 100) {
        await q.teleport('varrock teleport', 'magic:varrock_teleport', 3213, 3424);
        await spiritTree('varrock tree', VARROCK_TREE, [/^yes please/i], { x: 2542, z: 3169 });
        await spiritTree('village tree 2', VILLAGE_TREE, [/where can i go/i, /gnome stronghold/i], STRONGHOLD_LAND);
        await treeTo(3);
        await toBars();
        const ok2 = () => q.sawText(/toad swamp|see what i can find/i) && !q.dialogOpen();
        for (let i = 0; i < 3 && !ok2(); i++) {
            if (i > 0) { q.stats.retries++; await toBars(); }
            const c = q.npc(/^charlie/i);
            if (!c) continue;
            await q.talkTo(c);
            await q.waitUntil(() => q.dialogOpen(), 15);
            await q.converse([], ok2, 60);
        }
        if (!ok2()) await q.fail('talk charlie 2');
        await ms(100);
    }

    // 110. Anita's key (west of the toad swamp, l1), Glough's chest: the invasion plans.
    if (FROM < 110) {
        await treeTo(0);
        await walk('to anita', [{ x: ANITA_STAIRS.x, z: ANITA_STAIRS.z - 1, tol: 1 }]);
        await ladder('anita stairs up', ANITA_STAIRS, 'up', 1);
        await q.talk('anita', /^anita/i, [], () => q.has(ITEM.key) && !q.dialogOpen(), { x: 2390, z: 3514 }, 60);
        await ladder('anita stairs down', { x: ANITA_STAIRS.x, z: ANITA_STAIRS.z + 1 }, 'down', 0);
        q.milestone('key');
        await gloughUp();
        await walk('to chest', [{ x: CHEST.x, z: CHEST.z + 1, tol: 1 }]);
        await q.step('key on chest', async () => {
            const c = locNear(/chest/i, CHEST, 1);
            if (!c) return q.waitTicks(1);
            await q.useOnLoc(ITEM.key, c);
            await q.waitTicks(2);
            await shutDialog();
        }, () => q.has(ITEM.plans), 10, 6);
        await ms(110);
    }

    // 120. Narnode takes the plans and gives the 4 twigs.
    if (FROM < 120) {
        await gloughDown();
        await narnode('narnode 4', [], () => [ITEM.twigT, ITEM.twigU, ITEM.twigZ, ITEM.twigO].every(id => q.has(id)) && !q.dialogOpen());
        await ms(120);
    }

    // 130. Up Glough's tree (Agility 25) to l2; twig T, U, Z, O on the pillars from west to east.
    if (FROM < 130) {
        await gloughUp();
        await walk('to climb tree', [{ x: CLIMBTREE.x - 1, z: CLIMBTREE.z, tol: 1 }]);
        await ladder('glough tree up', CLIMBTREE, 'up', 2);
        for (const [twig, x] of PILLARS) {
            await q.step(`twig ${twig}`, async () => {
                const p = q.findLoc(l => /pillar/i.test(l.name) && l.x === x && l.z === 3467);
                if (!p) return q.waitTicks(1);
                await q.useOnLoc(twig, p);
                await q.waitTicks(1);
            }, () => !q.has(twig), 10, 4);
        }
        await q.waitUntil(() => q.sawText(/grinding of an ancient pulley/i), 6);
        if (!q.sawText(/grinding of an ancient pulley/i)) await q.fail('pillars: no pulley');
        await shutDialog();
        await ms(130);
    }

    // 140. The trapdoor, Glough's cutscene, the black demon under Protect from Melee with Fire Bolt.
    if (FROM < 140) {
        await walk('to trapdoor', [{ x: TRAPDOOR.x, z: TRAPDOOR.z + 1, tol: 1 }]);
        // The prayer goes on before the trapdoor: a toggle sent during Glough's cutscene (p_delay) did not take.
        await keepPrayer();
        await setPfm(true);
        await q.step('trapdoor', () => { const t = locNear(/trapdoor/i, TRAPDOOR, 1); return t ? q.opLoc(t, q.opIndex(t, /open|climb/i)) : q.waitTicks(1); }, () => z() > 6400, 10, 4);
        const demon = () => q.npc(/^black demon$/i);
        // Glough's 4 pages, then the demon (glough.rs2:92-126).
        for (let t = 0; t < 60 && !demon(); t++) {
            const d: any = q.s.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) void q.s.sdk.sendClickDialog(0);
            await q.waitTicks(1);
        }
        if (!demon()) await q.fail('no demon');
        q.milestone('demon');
        const runes0 = lastMsg(/do not have enough/i);
        let casts = 0, lastCast = -99, gone = 0;
        for (let t = 0; t < 900 && gone < 3; t++) {
            await q.guard('demon');
            if (q.dialogOpen()) { const d: any = q.s.sdk.getDialog(); if (!d.isWaiting) void q.s.sdk.sendClickDialog(0); }
            await keepPrayer();
            if (!pfmOn() && points() > 0 && t % 2 === 0) void q.s.direct({ type: 'togglePrayer', prayerIndex: PFM, reason: 'SDK' });
            const n = demon();
            gone = n ? 0 : gone + 1;
            if (n && !q.dialogOpen() && q.T() - lastCast >= 5) { casts++; lastCast = q.T(); await q.s.direct({ type: 'spellOnNpc', npcIndex: n.index, spellComponent: (q.s.sdk.getSkill('Magic')?.level ?? 1) >= 59 && q.has(560) ? BLAST : BOLT, reason: 'SDK' }); }
            if (lastMsg(/do not have enough/i) > runes0) await q.fail('out of runes');
            await q.waitTicks(1);
        }
        if (demon()) await q.fail('demon alive');
        console.log(`NOTE demon down at ${q.T()} casts=${casts} prayer=${points()} potions=${potions}`);
        await shutDialog();
        await setPfm(false);
        await ms(140);
    }

    // 150. Narnode in the roots; then the roots, searched in a tour from him, until the Daconia rock.
    if (FROM < 150) {
        await walk('to narnode under', [{ x: NARNODE_UNDER.x, z: NARNODE_UNDER.z - 2, tol: 2 }]);
        await talkOnce('narnode 5', /^king narnode/i, [], () => q.sawText(/little time/i) && !q.dialogOpen(), 120);
        await ms(150);
    }
    let searched = 0;
    for (const [x, rz] of ROOTS) {
        if (q.has(ITEM.rock)) break;
        await q.guard('roots');
        searched++;
        await walk(`to root ${x},${rz}`, [{ x, z: rz, tol: 2 }]);
        const ROOT_MSG = /search the root|anything interesting|turns out to be nothing/i;
        const before = lastMsg(ROOT_MSG);
        await q.step(`root ${x},${rz}`, () => { const r = q.findLoc(l => /^root$/i.test(l.name) && near3(l, { x, z: rz }, 1)); return r ? q.opLoc(r, 1) : q.waitTicks(1); },
            () => q.has(ITEM.rock) || lastMsg(ROOT_MSG) > before, 10, 3);
        await shutDialog();
    }
    if (!q.has(ITEM.rock)) await q.fail('no daconia rock');
    q.milestone('rock');

    // 160. Narnode takes the rock and queues the completion.
    await narnode('narnode 6', [], () => questDone || !q.has(ITEM.rock), 200);
    await q.waitUntil(() => questDone, 20);
    await shutDialog();
    q.milestone('complete');
    offDone();
    offWalk();
    await q.end(questDone, `qp=5 questMsg=${questDone} roots=${searched} potions=${potions} prayerLeft=${points()}`);

} catch (e) { await q.fail(String(e)); }
