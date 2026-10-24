// Black Knights' Fortress from preset quest_blackknight (level 2 of Falador castle beside Sir Amik Varze; Haggis at the
// qp-filler row: every skill 99, the combat rune set; iron chainbody, bronze med helm, a cabbage and two Falador
// teleports' runes from a helper). Reward: 3 QP, 2,500 coins (quest_blackknight.rs2:152-157). Needs 12 QP
// (sir_amik_varze.rs2:15).
// Varp %spy (130): 0 -> 1 Sir Amik, 2 the grill, 3 the cabbage in the hole, 4 Sir Amik (queued completion).
// Server truth: areas/area_falador/scripts/sir_amik_varze.rs2, quests/quest_blackknight/scripts/quest_blackknight.rs2.
// Map: maps/m47_54.jm2 (fortress), maps/m46_52.jm2 (castle).
import { openQuest, type Loc } from './quest-lib';

const AMIK = { x: 2960, z: 3336 };                                    // level 2
const ITEM = { chain: 1101, helm: 1139, cabbage: 1965 };
const L = {
    door1: { id: 2337, x: 3016, z: 3514 },          // bkfortressdoor1, the guards' door (uniform worn, :14-22)
    door2: { id: 2338, x: 3020, z: 3515 },          // bkfortressdoor2, the banquet hall door (:56-81)
    secret0: { id: 2341, x: 3016, z: 3517 },        // bksecretdoor, level 0, south wall of 3016,3517
    ladder0: { id: 1750, x: 3015, z: 3519 },        // ladder_directional up, level 0
    ladder1: { id: 1750, x: 3016, z: 3519 },        // ladder_directional up, level 1
    top2w: { id: 1746, x: 3017, z: 3516 },          // laddertop down, level 2
    ladder1w: { id: 1747, x: 3017, z: 3516 },       // ladder up, level 1
    top2n: { id: 1749, x: 3016, z: 3519 },          // laddertop_directional down, level 2
    top1w: { id: 1749, x: 3015, z: 3519 },          // laddertop_directional down, level 1
    ladder1b: { id: 1750, x: 3023, z: 3513 },       // ladder_directional up, level 1
    top2e: { id: 1749, x: 3025, z: 3513 },          // laddertop_directional down, level 2
    ladder1e: { id: 1750, x: 3025, z: 3513 },       // ladder_directional up, level 1
    top2c: { id: 1749, x: 3023, z: 3513 },          // laddertop_directional down, level 2
    door3: { id: 2339, x: 3025, z: 3511 },          // bkfortressdoor3, level 1, east wall of 3025,3511 (:24-31)
    top1: { id: 1746, x: 3021, z: 3510 },           // laddertop down to the grill corridor, level 1
    ladder0b: { id: 1747, x: 3021, z: 3510 },       // ladder up, level 0
    hallLadder: { id: 1750, x: 3022, z: 3518 },     // ladder_directional up, level 0, north-east of the hall
    grill: { id: 2342, x: 3025, z: 3507 },          // witchgrill, level 0 (:132-146)
    secret1: { id: 2341, x: 3030, z: 3510 },        // bksecretdoor, level 1, south wall of 3030,3510
    hole: { id: 2336, x: 3031, z: 3507 },           // blackknighthole, level 1 (:91-117)
    stairs0: { id: 1738, x: 2954, z: 3338 },        // castle spiralstairs, level 0
    stairs1: { id: 1738, x: 2960, z: 3338 },        // castle spiralstairs, level 1
};

const q = await openQuest({ cap: 1500 });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const from = process.env.BKF_FROM ?? '';
    const lvlIs = (lv: number) => () => q.lvl() === lv;
    const z = (): number => q.pos()?.worldZ ?? 0;
    const x = (): number => q.pos()?.worldX ?? 0;
    const where = (): string => `${x()},${z()},${q.lvl()}`;
    const dump = (): void => { if (process.env.BKF_DUMP) console.log('LOCS ' + q.locs().filter((l: any) => l.distance <= 9 && (l.optionsWithIndex ?? []).length).map((l: any) => `${l.name}@${l.x},${l.z}[${(l.optionsWithIndex ?? []).map((o: any) => o.text).join('/')}]`).join(' ')); };
    const climb = (label: string, l: Loc, arrived: () => boolean) => q.climb(label, () => q.locAt(l.x, l.z) ?? l, /climb/i, arrived);
    const wear = async (id: number, slot: number): Promise<void> => {
        const worn = () => (q.st()?.equipment ?? []).some((e: any) => e.slot === slot && e.id === id);
        await q.step(`wear ${id}`, () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(id)!, optionIndex: 2, reason: 'SDK' }), worn, 3, 3);
    };
    const amik = /^sir amik varze$/i;

    if (from !== 'fort') {
        // 1. Sir Amik: "I seek a quest!", "I laugh in the face of danger!" sets 1 (sir_amik_varze.rs2:8-57).
        await q.talk('amik 1', amik, [/i seek a quest/i, /laugh in the face of danger/i], () => q.sawText(/give it a try/i), AMIK);
        q.milestone(1);

        // 2. Falador teleport (2965,3378), the uniform on, the run north to the fortress door.
        await q.teleport('falador teleport 1', 'magic:falador_teleport', 2965, 3378);
        await wear(ITEM.chain, 4);
        await wear(ITEM.helm, 0);
        await q.walk('to fortress', [{ x: 3016, z: 3512, tol: 1 }]);
        q.milestone('fortress');
    }

    // 3. The guards' door: with the uniform on it opens (quest_blackknight.rs2:14-22).
    await q.step('door1', () => q.opLoc(L.door1), () => z() >= 3515, 12, 4);
    // 4. The way to the grill (only the ladder at 3021,3510 reaches its corridor): the secret wall north of the
    // entrance (pushed from 3016,3516), ladders up 3015,3519 and 3016,3519, down 3017,3516, the two level 1 doors,
    // the sturdy door west (the knights there attack, :24-31), the ladder down.
    await q.dash('secret wall tile', 3016, 3516, 0);
    await q.step('secret wall in', () => q.opLoc(L.secret0), () => z() >= 3517, 12, 4);
    await climb('ladder0 up', L.ladder0, lvlIs(1));
    await climb('ladder1 up', L.ladder1, lvlIs(2));
    await climb('top2w down', L.top2w, lvlIs(1));
    // Two shut doors on level 1 (3019,3515 and 3021,3515); shut, the next click gets "I can't reach that!".
    await q.openDoor('L1 door a', 3019, 3515);
    await q.openDoor('L1 door b', 3021, 3515);
    // The doors lead to the ladder at 3023,3513 only; the sturdy door's room is reached over level 2 (3025,3513).
    await climb('ladder 3023,3513 up', L.ladder1b, lvlIs(2));
    await climb('top2 3025,3513 down', L.top2e, lvlIs(1));
    await q.step('door3 west', () => q.opLoc(L.door3), () => x() <= 3025 && z() <= 3511, 12, 4);
    await climb('top1 down', L.top1, lvlIs(0));
    console.log(`NOTE grill corridor ${where()} ${q.T()}`); dump();
    // 5. Listen at the grill: the witch's talk sets 2.
    await q.step('grill', () => q.opLoc(L.grill), () => q.dialogOpen(), 20, 4);
    await q.converse([], () => q.sawText(/yes mithreth/i) && !q.dialogOpen(), 40);
    q.milestone(2);
    // 6. Back the same way to the entrance room, then the banquet hall door east (bkfortressdoor2): the guard warns;
    // "I don't care. I'm going in anyway." opens it and sets the Black Knights on the bot (:56-81; level 33).
    await climb('grill ladder up', L.ladder0b, lvlIs(1));
    await q.step('door3 east', () => q.opLoc(L.door3), () => x() >= 3026, 12, 4);
    await climb('ladder 3025,3513 up', L.ladder1e, lvlIs(2));
    await climb('top2 3023,3513 down', L.top2c, lvlIs(1));
    await q.walk('to ladder 3017,3516', [{ x: 3016, z: 3516, tol: 0 }]);
    await climb('ladder 3017,3516 up', L.ladder1w, lvlIs(2));
    await climb('top2 3016,3519 down', L.top2n, lvlIs(1));
    await climb('top1 3015,3519 down', L.top1w, lvlIs(0));
    await q.step('secret wall out', () => q.opLoc(L.secret0), () => z() <= 3516, 12, 4);
    await q.step('door2', () => q.opLoc(L.door2), () => q.dialogOpen() || x() >= 3020, 12, 4);
    await q.converse([/going in anyway/i], () => x() >= 3020 && !q.dialogOpen(), 20);
    if (x() < 3020) await q.fail('door2: still west of the banquet hall');
    console.log(`NOTE hall ${where()} ${q.T()}`);
    // 7. The hall's north-east ladder up to the level 1 corridor (3022-3029,3517), round to the secret wall at
    // 3030,3510 (pushed from the north), the cabbage into the hole sets 3.
    await q.dash('hall ladder', 3022, 3517, 0);
    await climb('hall ladder up', L.hallLadder, lvlIs(1));
    console.log(`NOTE corridor ${where()} ${q.T()}`); dump();
    await q.walk('to secret wall', [{ x: 3029, z: 3517, tol: 0 }, { x: 3030, z: 3516, tol: 0 }, { x: 3030, z: 3510, tol: 0 }]);
    await q.step('secret wall', () => q.opLoc(L.secret1), () => z() <= 3509, 12, 4);
    console.log(`NOTE hole room ${where()} ${q.T()}`);
    await q.step('cabbage', () => q.useOnLoc(ITEM.cabbage, L.hole), () => !q.has(ITEM.cabbage), 6, 4);
    await q.converse([], () => q.sawText(/successfully sabotaged/i) && !q.dialogOpen(), 30);
    q.milestone(3);

    // 8. Falador teleport, the castle stairs to level 2, Sir Amik queues the completion (sir_amik_varze.rs2:67-74).
    await q.teleport('falador teleport 2', 'magic:falador_teleport', 2965, 3378);
    await q.walk('to castle stairs', [{ x: 2955, z: 3337, tol: 1 }]);
    await climb('castle stairs 0', L.stairs0, lvlIs(1));
    await q.walk('castle level 1', [{ x: 2959, z: 3338, tol: 1 }]);
    await climb('castle stairs 1', L.stairs1, lvlIs(2));
    await q.talk('amik 2', amik, [], () => questDone, AMIK, 60, true);
    await q.converse([], () => !q.dialogOpen(), 10);
    q.milestone(4);
    off();
    await q.end(questDone, 'qp=3');
} catch (e) { await q.fail(String(e)); }
