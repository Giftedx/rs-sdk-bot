// Rune Mysteries runner supporting arbitrary start locations (e.g. Lumbridge courtyard or Varrock).
// Reward: 1 QP, air talisman. Unlocks Aubury teleport for Rune Essence mining.
// Server truth: areas/area_lumbridge/scripts/duke_horacio.rs2, areas/area_wizard_tower/scripts/sedridor.rs2,
// areas/area_varrock/scripts/aubury.rs2.
import { openQuest } from './quest-lib';

const DUKE = { x: 3212, z: 3220 };                        // level 1
const SEDRIDOR = { x: 3103, z: 9571 };                    // Wizards' Tower basement
const LADDER_TOP = { id: 2147, x: 3104, z: 3162 };        // wizards_tower_laddertop (maps/m48_49.jm2)
const LADDER_UP = { id: 2148, x: 3103, z: 9576 };
const AUBURY = { x: 3253, z: 3402 };
const ITEM = { talisman: 1438, pack: 290, notes: 291 };   // research_notes is named "Notes"

const q = await openQuest({ cap: 4000, lumbridgeOk: true });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const levelIs = (lv: number) => () => q.lvl() === lv;
    const inBasement = () => (q.pos()?.worldZ ?? 0) > 9000;
    const sed = /^sedridor$/i;
    const stairs = (re: RegExp) => () => q.findLoc(l => /stair/i.test(l.name) && Math.max(Math.abs(l.x - 3205), Math.abs(l.z - 3209)) <= 4 && (l.optionsWithIndex ?? []).some((o: any) => re.test(o.text)));

    const leaveSedridor = async (label: string): Promise<void> => {
        if (!inBasement()) return;
        await q.openDoor(`${label} basement door exit`, 3108, 9570);
        await q.dash(`${label} to ladder up`, 3104, 9576, 1);
        await q.climb(`${label} ladder up`, () => q.locAt(LADDER_UP.x, LADDER_UP.z) ?? LADDER_UP, /climb-up|climb/i, () => !inBasement());
        await q.openDoor(`${label} inner door exit`, 3107, 3162);
        await q.openDoor(`${label} north door exit`, 3109, 3166);
    };

    const tryTeleport = async (label: string, comp: string, x: number, z: number) => {
        if ((q.s.sdk.getSkill('Magic')?.level ?? 0) >= 25) {
            try {
                await q.teleport(label, comp, x, z);
                return;
            } catch { /* walk fallback */ }
        }
        if (inBasement()) {
            await leaveSedridor(label);
        }
        await q.walk(`walk fallback ${label}`, [{ x, z, tol: 2 }]);
    };

    // 1. The Duke: "Have you any quests for me?", "Sure, no problem." gives the air talisman (duke_horacio.rs2:22-36).
    if (!q.has(ITEM.talisman) && !q.has(ITEM.pack) && !q.has(ITEM.notes)) {
        if (q.lvl() === 0) {
            await q.walk('to castle stairs up', [{ x: 3205, z: 3209, tol: 2 }]);
            await q.climb('castle stairs up', stairs(/climb-up|climb/i), /climb-up|climb/i, levelIs(1));
        }
        if (q.lvl() === 1) {
            await q.walk('to duke door', [{ x: 3207, z: 3221, tol: 1 }]);
            await q.openDoor('duke door enter', 3207, 3222);
            await q.walk('into duke room', [{ x: 3210, z: 3221, tol: 1 }]);
            await q.talk('duke', /^duke horacio$/i, [/any quests for me/i, /sure, no problem/i], () => q.has(ITEM.talisman), DUKE);
            q.milestone(1);
        }
    }

    // 2. Down the castle: the Duke's door (loc 1536 at 3207,3222, level 1), the stairs at 3204,3207 (dragon row).
    if (q.lvl() === 1) {
        await q.openDoor('duke door leave', 3207, 3222);
        await q.walk('to stairs', [{ x: 3206, z: 3210, tol: 1 }]);
        await q.climb('castle stairs down', stairs(/climb-down/i), /climb-down/i, levelIs(0));
        q.milestone('castle');
    }

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

    if (q.has(ITEM.talisman) && !q.has(ITEM.pack) && !q.has(ITEM.notes)) {
        await toSedridor('sed 1');
        q.milestone('basement');

        // 4. Sedridor: "I'm looking for the head wizard.", "Ok, here you are.", "Yes, certainly." gives the package (2, 3).
        await q.talk('sedridor 1', sed, [/looking for the head wizard/i, /ok, here you are/i, /yes, certainly/i], () => q.has(ITEM.pack), SEDRIDOR, 120);
        q.milestone(3);
    }

    if (q.has(ITEM.pack)) {
        // 5. Aubury's shop in Varrock
        await tryTeleport('varrock teleport', 'magic:varrock_teleport', 3212, 3424);
        await q.walk('to aubury', [{ x: 3253, z: 3398, tol: 1 }]);
        await q.openDoor('aubury door', 3253, 3399);
        await q.talk('aubury 1', /^aubury$/i, [/sent here with a package/i], () => !q.has(ITEM.pack), AUBURY, 60);
        q.milestone(4);
        await q.talk('aubury 2', /^aubury$/i, [], () => q.has(ITEM.notes), AUBURY, 60);
        q.milestone(5);
    }

    if (q.has(ITEM.notes)) {
        // 6. Lumbridge teleport/walk, the tower again, Sedridor takes the notes and queues completion.
        await q.openDoor('aubury door exit', 3253, 3399);
        await tryTeleport('lumbridge teleport', 'magic:lumbridge_teleport', 3221, 3218);
        await toSedridor('sed 2');
        await q.talk('sedridor 2', sed, [], () => questDone || q.has(ITEM.talisman), SEDRIDOR, 200, true);
        await q.converse([], () => !q.dialogOpen(), 10);
        q.milestone(6);
    }

    // Leave the basement and head to Varrock East Bank so Shaftsinker is ready for essence mining
    if (inBasement()) {
        await leaveSedridor('finish');
    }
    await tryTeleport('varrock bank finish', 'magic:varrock_teleport', 3253, 3420);

    off();
    await q.end(questDone || q.has(ITEM.talisman), 'qp=1');
} catch (e) { await q.fail(String(e)); }
