// Rune Mysteries from preset quest_runemysteries (beside Duke Horacio, level 1 of Lumbridge castle; every skill 99;
// Varrock and Lumbridge teleport runes from a helper). Reward: 1 QP, the air talisman (quest_runemysteries.rs2).
// Varp %runemysteries: 0 -> 1 the Duke (air talisman), 2 talisman to Sedridor, 3 research package, 4 package to
// Aubury, 5 his notes, 6 notes to Sedridor (queued completion).
// Server truth: areas/area_lumbridge/scripts/duke_horacio.rs2:13-39, areas/area_wizard_tower/scripts/sedridor.rs2,
// areas/area_varrock/scripts/aubury.rs2:1-61.
import { openQuest } from './quest-lib';

const DUKE = { x: 3212, z: 3220 };                        // level 1
const SEDRIDOR = { x: 3103, z: 9571 };                    // Wizards' Tower basement
const LADDER_TOP = { id: 2147, x: 3104, z: 3162 };        // wizards_tower_laddertop (maps/m48_49.jm2)
const LADDER_UP = { id: 2148, x: 3103, z: 9576 };
const AUBURY = { x: 3253, z: 3402 };
const ITEM = { talisman: 1438, pack: 290, notes: 291 };   // research_notes is named "Notes"

const q = await openQuest({ cap: 1500, lumbridgeOk: true });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const levelIs = (lv: number) => () => q.lvl() === lv;
    const inBasement = () => (q.pos()?.worldZ ?? 0) > 9000;
    const sed = /^sedridor$/i;

    // 1. The Duke: "Have you any quests for me?", "Sure, no problem." gives the air talisman (duke_horacio.rs2:22-36).
    // Dragon Slayer is done, so the shield option is offered first (:4-5); the pattern skips it.
    await q.talk('duke', /^duke horacio$/i, [/any quests for me/i, /sure, no problem/i], () => q.has(ITEM.talisman), DUKE);
    q.milestone(1);

    // 2. Down the castle: the Duke's door (loc 1536 at 3207,3222, level 1), the stairs at 3204,3207 (dragon row).
    const stairs = (re: RegExp) => () => q.findLoc(l => /stair/i.test(l.name) && Math.max(Math.abs(l.x - 3205), Math.abs(l.z - 3209)) <= 3 && (l.optionsWithIndex ?? []).some((o: any) => re.test(o.text)));
    await q.openDoor('duke door', 3207, 3222);
    await q.walk('to stairs', [{ x: 3206, z: 3210, tol: 1 }]);
    await q.climb('castle stairs down', stairs(/climb-down/i), /climb-down/i, levelIs(0));
    q.milestone('castle');

    // 3. The Wizards' Tower: north door (loc 1536 at 3109,3166), inner door (3107,3162, diagonal), ladder down, the basement door.
    const toSedridor = async (label: string): Promise<void> => {
        await q.walk(`${label} tower`, [{ x: 3109, z: 3167, tol: 1 }]);
        await q.openDoor(`${label} north door`, 3109, 3166);
        await q.dash(`${label} hall`, 3108, 3164, 1);
        await q.openDoor(`${label} inner door`, 3107, 3162);
        await q.climb(`${label} ladder down`, () => q.locAt(LADDER_TOP.x, LADDER_TOP.z) ?? LADDER_TOP, /climb-down/i, inBasement);
        // The basement door: loc_1530 at 3108,9570 (west wall, maps/m48_149.jm2). Shut, the talk click is rejected.
        await q.dash(`${label} corridor`, 3108, 9570, 0);
        await q.openDoor(`${label} basement door`, 3108, 9570);
    };
    await toSedridor('sed 1');
    q.milestone('basement');

    // 4. Sedridor: "I'm looking for the head wizard.", "Ok, here you are.", "Yes, certainly." gives the package (2, 3).
    await q.talk('sedridor 1', sed, [/looking for the head wizard/i, /ok, here you are/i, /yes, certainly/i], () => q.has(ITEM.pack), SEDRIDOR, 120);
    q.milestone(3);

    // 5. Varrock teleport (3212,3424), Aubury's shop (door loc_1531 at 3253,3399).
    await q.teleport('varrock teleport', 'magic:varrock_teleport', 3212, 3424);
    await q.walk('to aubury', [{ x: 3253, z: 3398, tol: 1 }]);
    await q.openDoor('aubury door', 3253, 3399);
    await q.talk('aubury 1', /^aubury$/i, [/sent here with a package/i], () => !q.has(ITEM.pack), AUBURY, 60);
    q.milestone(4);
    await q.talk('aubury 2', /^aubury$/i, [], () => q.has(ITEM.notes), AUBURY, 60);
    q.milestone(5);

    // 6. Lumbridge teleport, the tower again, Sedridor takes the notes and queues the completion.
    await q.teleport('lumbridge teleport', 'magic:lumbridge_teleport', 3221, 3218);
    await toSedridor('sed 2');
    await q.talk('sedridor 2', sed, [], () => questDone, SEDRIDOR, 200, true);
    await q.converse([], () => !q.dialogOpen(), 10);
    q.milestone(6);
    off();
    await q.end(questDone, 'qp=1');
} catch (e) { await q.fail(String(e)); }
