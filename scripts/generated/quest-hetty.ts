// Witch's Potion from preset quest_hetty (in Hetty's house, Rimmington; every skill 99; onion, eye of newt and burnt
// meat from a helper). Reward: 1 QP, 325 Magic XP before 25x (quest_hetty.rs2).
// Varp %hetty: 0 -> 1 start, 2 ingredients given, 3 the cauldron drunk (queued completion).
// Server truth: areas/area_rimmington/scripts/hetty.rs2, quests/quest_hetty/scripts/quest_hetty.rs2,
// drop tables/scripts/rat.rs2 (the rat's tail drops only while %hetty is 1 or 2, with none in the pack or bank).
import { openQuest } from './quest-lib';

const HETTY = { x: 2968, z: 3206 };
const RATS = { x: 2957, z: 3203 };
const CAULDRON = { id: 2024, x: 2967, z: 3205 };
const TAIL = 300;

const q = await openQuest({ cap: 600 });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const hetty = /^hetty$/i;

    // 1. "I am in search of a quest.", "Yes help me become one with my darker side." sets 1 (hetty.rs2:40-83).
    await q.talk('hetty 1', hetty, [/in search of a quest/i, /yes help me become one/i], () => q.sawText(/eye of newt, a rat's tail/i), HETTY);
    q.milestone(1);

    // 2. One rat in the house next door; its tail drops on its tile. Both houses have a shut door (loc_1530): Hetty's in
    // her west wall at 2965,3206, the rat house's in its north wall at 2956,3205 (maps/m46_50.jm2). Shut, the attack
    // click cannot route (opRejected, 96 idle ticks in a trial).
    await q.openDoor('hetty door', 2965, 3206);
    await q.dash('rat house', 2956, 3206, 0);
    await q.openDoor('rat door', 2956, 3205);
    const attack = (n: any) => q.s.direct({ type: 'interactNpc', npcIndex: n.index, optionIndex: n.optionsWithIndex?.find((o: any) => /attack/i.test(o.text))?.opIndex ?? 2, reason: 'SDK' });
    const tailOnGround = (): any => (q.st()?.groundItems ?? []).find((g: any) => g.id === TAIL);
    for (let t = 0; t < 120 && !q.has(TAIL); t++) {
        await q.guard('rat');
        const g = tailOnGround();
        if (g) {
            if (t % 3 === 0) await q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' });
        } else {
            const rat = q.npc(/^rat$/i);
            if (!rat) { if (t % 10 === 0) await q.dash('to rats', RATS.x, RATS.z, 3); }
            else if (t % 4 === 0 && q.pos()?.targetIndex !== rat.index) await attack(rat);
        }
        await q.waitTicks(1);
    }
    if (!q.has(TAIL)) await q.fail('no rat tail');
    q.milestone('tail');

    // 3. The hand-in sets 2 (hetty.rs2:13-26).
    await q.openDoor('rat door out', 2956, 3205);
    await q.openDoor('hetty door in', 2965, 3206);
    await q.talk('hetty 2', hetty, [], () => !q.has(TAIL), HETTY);
    q.milestone(2);

    // 4. Drink from the cauldron (quest_hetty.rs2:1-4).
    await q.step('cauldron', () => q.opLoc(CAULDRON, 1), () => questDone, 10, 4);
    await q.converse([], () => !q.dialogOpen(), 10);
    q.milestone(3);
    off();
    await q.end(questDone, 'qp=1');
} catch (e) { await q.fail(String(e)); }
