// Fishing Contest from preset quest_fishingcompo (beside the west tunnel dwarf on White Wolf Mountain; every skill 99;
// spade, fishing rod, 2 fishing bait, garlic, 5 coins and Camelot teleport runes from a helper). Reward: 1 QP,
// 2,437 Fishing XP before 25x (quest_fishingcompo.rs2:108-112).
// Varp %fishingcompo: 0 -> 1 the dwarf (pass), Bonzo's fee, 2 places set, 3 garlic in the pipe (the stranger moves),
// 4 won (a giant carp in the catch), then the trophy to the dwarf queues the completion.
// Server truth: areas/area_white_wolf_mountain/scripts/mountain_dwarf.rs2, areas/area_seers/scripts/hemenster/bonzo.rs2,
// areas/area_seers/scripts/mcgrubors_wood.rs2, quests/quest_fishingcompo/scripts/quest_fishingcompo.rs2,
// hemenster_fishing.rs2 (a red vine worm at the pipes spot gives a giant carp, :26-36).
import { openQuest } from './quest-lib';

const DWARF = { x: 2820, z: 3487 };
const RAILING = { id: 51, x: 2662, z: 3500 };              // mcgruborlooserailing (west wall of its tile)
const VINE = { id: 58, x: 2631, z: 3498 };                 // red_worm_vine
const GATE = { id: 47, x: 2642, z: 3442 };                 // fishinggateclosedl (Morris checks the pass)
const BONZO = { x: 2641, z: 3439 };
const PIPE = { id: 41, x: 2638, z: 3446 };                 // garlicpipe (2636-2638; only 2638 is a walkable tile)
const SPOT = { x: 2637, z: 3444 };                         // 0_41_53_sinisterfishspot
const ITEM = { pass: 27, trophy: 26, worm: 25, garlic: 1550, carp: 338 };

const q = await openQuest({ cap: 2000 });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const dwarf = /^mountain dwarf$/i;

    // 1. The dwarf: the friend chain gives the pass and sets 1 (mountain_dwarf.rs2:8-71).
    await q.talk('dwarf 1', dwarf, [/wondering what was down those stairs/i, /^why not\?$/i, /if you were my friend/i, /let's be friends/i, /how am i meant to do that/i, /fortunately i'm alright at fishing/i], () => q.has(ITEM.pass), DWARF, 80);
    q.milestone(1);

    // 2. McGrubor's Wood: in through the loose railing from its west side (2661,3500 is outside, 2662 inside), one red
    // vine worm (mcgrubors_wood.rs2:12-48), out again. The SDK plan treats the forester's gate (52/53 at 2649-2650,3469)
    // as open; the forester stops the player there (mcgrubors_wood.rs2:1-8): a trial stood 1,900 ticks in his dialog.
    // The legs outside the wood are walked by waypoints that keep off the gate.
    if (!q.blockDoor(0, 2649, 3469) || !q.blockDoor(0, 2650, 3469)) console.log('WARN mcgrubor gate not blocked');
    await q.walk('to railing', [{ x: 2731, z: 3484, tol: 3 }, { x: 2690, z: 3499, tol: 3 }, { x: 2681, z: 3508, tol: 2 }, { x: 2660, z: 3505, tol: 1 }, { x: RAILING.x - 1, z: RAILING.z, tol: 0 }]);
    const inWood = () => (q.pos()?.worldX ?? 0) >= RAILING.x;
    await q.step('railing in', () => q.opLoc(q.locAt(RAILING.x, RAILING.z) ?? RAILING, 1), inWood, 8, 4);
    await q.walk('to vine', [{ x: 2667, z: 3485, tol: 2 }, { x: 2650, z: 3488, tol: 2 }, { x: VINE.x + 1, z: VINE.z, tol: 1 }]);
    await q.step('dig worm', () => q.opLoc(q.findLoc(l => [58, 2989, 2990].includes(l.id) && l.distance <= 6) ?? VINE, 1), () => q.has(ITEM.worm), 8, 4);
    q.milestone('worm');
    await q.walk('back to railing', [{ x: 2650, z: 3488, tol: 2 }, { x: 2667, z: 3485, tol: 2 }, { x: RAILING.x, z: RAILING.z, tol: 0 }]);
    await q.step('railing out', () => q.opLoc(q.locAt(RAILING.x, RAILING.z) ?? RAILING, 1), () => !inWood(), 8, 4);

    // 3. Hemenster: Morris lets the pass through the gate (quest_fishingcompo.rs2:22-44); Bonzo's fee (stage 1, then 2).
    await q.walk('to gate', [{ x: 2660, z: 3505, tol: 2 }, { x: 2683, z: 3502, tol: 2 }, { x: 2679, z: 3472, tol: 2 }, { x: 2666, z: 3462, tol: 2 }, { x: 2645, z: 3459, tol: 2 }, { x: GATE.x + 1, z: GATE.z, tol: 0 }]);
    const inComp = () => (q.pos()?.worldX ?? 9999) <= GATE.x;
    // Morris's pages (pass shown, "Move on through.") must be clicked through before the teleport through the gate.
    for (let i = 0; i < 4 && !inComp(); i++) {
        await q.guard('gate');
        await q.opLoc(q.findLoc(l => (l.id === 47 || l.id === 48) && l.x === GATE.x) ?? GATE, 1);
        await q.waitUntil(() => q.dialogOpen(), 8);
        await q.converse([], inComp, 20);
    }
    if (!inComp()) await q.fail('gate');
    await q.converse([], () => !q.dialogOpen(), 10);
    q.milestone('gate');
    await q.talk('bonzo', /^bonzo$/i, [/i'll enter the competition please/i], () => q.sawText(/spot is beside the willow|spot is now beside the pipes/i), BONZO, 60);
    q.milestone(2);

    // 4. Garlic in the pipe moves the stranger off the pipes spot (quest_fishingcompo.rs2:85-106).
    // The pipe is a wall decoration on the north edge of 2636-2638,3446; from 3445 the use gets "I can't reach that!" and 2636-2637 are blocked, so
    // the bot stands on the pipe's own tile.
    await q.dash('to pipe', PIPE.x, PIPE.z, 0);
    await q.step('garlic', () => q.useOnLoc(ITEM.garlic, q.locAt(PIPE.x, PIPE.z) ?? PIPE), () => !q.has(ITEM.garlic), 8, 4);
    await q.converse([], () => !q.dialogOpen(), 15);
    q.milestone(3);

    // 5. Three catches at the pipes spot: the worm first (a giant carp), then the bait; the third ends the contest
    // and Bonzo hands over the trophy (hemenster_fishing.rs2:46-53, bonzo.rs2:56-64).
    const spot = () => (q.st()?.nearbyNpcs ?? []).find((n: any) => /fishing spot/i.test(n.name) && n.x === SPOT.x && n.z === SPOT.z);
    for (let t = 0; t < 120 && !q.has(ITEM.trophy); t++) {
        await q.guard('fishing');
        const d: any = q.s.sdk.getDialog();
        if (d?.isOpen && !d.isWaiting) { void q.s.sdk.sendClickDialog(0); await q.waitTicks(1); continue; }
        const s = spot();
        if (s && t % 6 === 0) await q.s.direct({ type: 'interactNpc', npcIndex: s.index, optionIndex: s.optionsWithIndex?.find((o: any) => /fish/i.test(o.text))?.opIndex ?? 1, reason: 'SDK' });
        await q.waitTicks(1);
    }
    if (!q.has(ITEM.trophy)) await q.fail('no trophy');
    await q.converse([], () => !q.dialogOpen(), 15);
    q.milestone(4);

    // 6. Camelot teleport, the dwarf takes the trophy and queues the completion (mountain_dwarf.rs2:91-101).
    await q.teleport('camelot teleport', 'magic:camelot_teleport', 2757, 3477);
    await q.walk('to dwarf', [{ x: DWARF.x + 2, z: DWARF.z + 2, tol: 2 }]);
    await q.talk('dwarf 2', dwarf, [], () => questDone, DWARF, 60, true);
    await q.converse([], () => !q.dialogOpen(), 10);
    q.milestone(100);
    off();
    await q.end(questDone, 'qp=1');
} catch (e) { await q.fail(String(e)); }
