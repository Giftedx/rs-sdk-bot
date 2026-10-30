// Romeo & Juliet from preset quest_rj (beside Romeo in Varrock Square; Haggis at the qp-filler row: every skill 99,
// rune set; cadava berries and Varrock teleport runes from a helper). Reward: 5 QP, no XP (quest_romeojuliet.rs2).
// Varp %rjquest: 0 -> 20 Juliet ("I guess I could find him." gives the message at once, juliet.rs2), 30 Romeo,
// 40 Father Lawrence, 50 Apothecary, potion on a second talk, 60 Juliet, 100 Romeo (queued completion).
// Server truth: areas/area_varrock/scripts/juliet.rs2, romeo.rs2, father_lawrence.rs2, apothecary.rs2.
import { openQuest } from './quest-lib';
import { questFlags } from '../../packages/core/src/quest-status';

const ROMEO = { x: 3211, z: 3425 };
const JULIET = { x: 3158, z: 3425 };                       // level 1
const STAIRS = { id: 1722, x: 3156, z: 3435 };             // level 0; stairstop 1723 on level 1
const LAWRENCE = { x: 3254, z: 3475 };
const APOTHECARY = { x: 3195, z: 3404 };
const ITEM = { message: 755, berries: 753, potion: 756 };

const q = await openQuest({ cap: 1500 });
try {
    const msgItem = () => q.inv().some(i => /message/i.test(i.name));
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });

    // Juliet's room. Her house's doors are loc_1533 / loc_1530 (maps/m49_53.jm2): the north door (3160,3440) into the
    // stairs room, the stairs (3156,3435), then two doors upstairs (3156,3431 and 3159,3427). The SDK plan finds no
    // way into the stairs room, so each door is opened by tile and the stairs are clicked from outside them.
    const toJuliet = async (label: string): Promise<void> => {
        await q.walk(`${label} house`, [{ x: 3161, z: 3441, tol: 1 }]);
        await q.openDoor(`${label} north door`, 3160, 3440);
        await q.climb(`${label} stairs up`, () => q.locAt(STAIRS.x, STAIRS.z), /climb-up/i, () => q.lvl() === 1);
        await q.openDoor(`${label} door up 1`, 3156, 3431);
        await q.openDoor(`${label} door up 2`, 3159, 3427);
    };
    const downstairs = async (label: string): Promise<void> => {
        await q.openDoor(`${label} door up 2`, 3159, 3427);
        await q.openDoor(`${label} door up 1`, 3156, 3431);
        await q.climb(`${label} stairs down`, () => q.locAt(STAIRS.x, STAIRS.z), /climb-down/i, () => q.lvl() === 0);
        await q.openDoor(`${label} north door`, 3160, 3440);
        await q.dash(`${label} out`, 3161, 3441, 1);
    };

    // Resume: quest varps are not sent to the client (core/src/quest-status.ts). A started quest with no message and
    // no potion in the pack may stand at 60, where Romeo completes it; at other stages he only repeats a line.
    if (questFlags(q.s.client)?.find(f => f.name === 'Romeo & Juliet')?.state === 'started' && !msgItem() && !q.has(ITEM.potion)) {
        if (q.lvl() === 1) await downstairs('romeo resume');
        await q.walk('to romeo (resume)', [{ x: ROMEO.x, z: ROMEO.z, tol: 4 }]);
        await q.talk('romeo resume', /^romeo$/i, [], () => questDone || !q.dialogOpen(), ROMEO, 40, true);
        await q.waitUntil(() => questDone, 5);
        if (questDone) { off(); await q.end(true, 'qp=5 resumed at 60'); }
    }

    // 1. Juliet: "I guess I could find him." gives her message (0 -> 20).
    await toJuliet('juliet 1');
    await q.talk('juliet 1', /^juliet$/i, [/i guess i could find him/i, /certainly, i will do so/i], msgItem, JULIET);
    q.milestone(20);

    // 2. Romeo takes the message (20 -> 30).
    await downstairs('romeo 1');
    await q.walk('to romeo', [{ x: ROMEO.x, z: ROMEO.z, tol: 4 }]);
    await q.talk('romeo 1', /^romeo$/i, [], () => !msgItem(), ROMEO);
    q.milestone(30);

    // 3. Father Lawrence in the church (30 -> 40).
    await q.walk('to lawrence', [{ x: LAWRENCE.x, z: LAWRENCE.z - 2, tol: 3 }]);
    await q.talk('lawrence', /^father lawrence$/i, [], () => q.sawText(/tell him i sent you|need a cadava potion/i), LAWRENCE);
    q.milestone(40);

    // 4. The Apothecary: the first talk asks for the berries (40 -> 50), the second brews the potion.
    await q.walk('to apothecary', [{ x: APOTHECARY.x, z: APOTHECARY.z + 1, tol: 2 }]);
    await q.talk('apothecary 1', /^apothecary$/i, [], () => q.sawText(/bring them here when you have them/i), APOTHECARY);
    q.milestone(50);
    await q.talk('apothecary 2', /^apothecary$/i, [], () => q.has(ITEM.potion), APOTHECARY);
    q.milestone('potion');

    // 5. Juliet takes the potion (50 -> 60).
    await toJuliet('juliet 2');
    await q.talk('juliet 2', /^juliet$/i, [], () => !q.has(ITEM.potion), JULIET);
    q.milestone(60);

    // 6. Varrock teleport to the square (3212,3424), Romeo: the completion is queued (60 -> 100).
    await q.teleport('varrock teleport', 'magic:varrock_teleport', 3212, 3424);
    await q.talk('romeo 2', /^romeo$/i, [], () => questDone, ROMEO, 40, true);
    await q.waitUntil(() => questDone, 5);
    q.milestone(100);
    off();
    await q.end(questDone, `qp=5`);
} catch (e) { await q.fail(String(e)); }
