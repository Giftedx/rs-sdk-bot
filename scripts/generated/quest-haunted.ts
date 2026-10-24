// Ernest the Chicken from preset quest_haunted (outside the Draynor Manor gate beside Veronica; Haggis at the qp-filler
// row: every skill 99, the combat rune set; fish food, poison and a spade from a helper). Reward: 4 QP, 300 coins
// (quest_haunted.rs2:188-191).
// Varp %haunted (32): 0 -> 1 Veronica, 2 Oddenstein's story, 3 the parts given (queued completion).
// Server truth: areas/area_draynor/scripts/veronica.rs2, professor_oddenstein.rs2, quests/quest_haunted/scripts/
// quest_haunted.rs2 (fountain, compost heap, closet door, bookcase, the basement levers and doors).
// Map: maps/m48_52.jm2 (manor), maps/m48_152.jm2 (basement; the oil can lies at 3092,9755, the tube at 3111,3367).
import { openQuest, type Loc } from './quest-lib';

const VERONICA = { x: 3110, z: 3330 };
const ODDENSTEIN = { x: 3110, z: 3367 };                         // level 2
const ITEM = { fishFood: 272, poison: 273, poisoned: 274, spade: 952, gauge: 271, key: 275, tube: 276, oil: 277 };
const L = {
    fountain: { id: 153, x: 3087, z: 3334 },
    compost: { id: 152, x: 3084, z: 3360 },
    frontDoor: { id: 134, x: 3108, z: 3353 },       // haunteddoorl; opens from the south only (:1-11)
    closet: { id: 131, x: 3107, z: 3367 },          // closet_door, east wall of 3107,3367; the key opens it both ways
    bookcase: { id: 155, x: 3097, z: 3358 },        // hauntedbookcasel; searched from the east (:95-100)
    ladderDown: { id: 133, x: 3092, z: 3362 },      // puzzle_ladder_top -> 3116,9754
    ladderUp: { id: 132, x: 3117, z: 9754 },        // puzzle_ladder -> 3092,3361 (resets the levers)
    leverOut: { id: 160, x: 3096, z: 3357 },        // hauntedleverup: out of the secret room (:102-112)
    stairs0: { id: 1730, x: 3108, z: 3363 },        // spookystairs
    stairs1: { id: 1738, x: 3104, z: 3362 },        // spiralstairs, level 1
};
// Basement levers (shape 4 wall levers; the bot stands on the tile) and doors (quest_haunted.rs2:147-181).
const LEVER: Record<string, Loc> = {
    A: { id: 146, x: 3108, z: 9745 }, B: { id: 147, x: 3118, z: 9752 }, C: { id: 148, x: 3112, z: 9760 },
    D: { id: 149, x: 3108, z: 9767 }, E: { id: 150, x: 3097, z: 9767 }, F: { id: 151, x: 3096, z: 9765 },
};
const DOOR: Record<string, Loc> = {
    '1to2': { id: 137, x: 3105, z: 9765 }, '2to3': { id: 138, x: 3100, z: 9765 }, '4to5': { id: 139, x: 3105, z: 9760 },
    '5to6': { id: 140, x: 3100, z: 9760 }, '8to9': { id: 141, x: 3100, z: 9755 }, '2to5': { id: 142, x: 3102, z: 9763 },
    '3to6': { id: 143, x: 3097, z: 9763 }, '4to7': { id: 144, x: 3108, z: 9758 }, '5to8': { id: 145, x: 3102, z: 9758 },
};
// The basement rooms by wall lines x 3100 / 3105 and z 9758 / 9763 (maps/m48_152.jm2). The door names count 9 rooms,
// but rooms 1 and 4 (x >= 3105) are one room, and so are 7 and 8 (z < 9758, x >= 3100; the ladder, levers A and B).
function room(x: number, z: number): string {
    if (z < 9758) return x >= 3100 ? 'S' : 'R9';
    if (x >= 3105) return 'CA';
    if (z >= 9763) return x >= 3100 ? 'R2' : 'R3';
    return x >= 3100 ? 'R5' : 'R6';
}
// Shortest lever route from the ladder to room 9 (Dijkstra over room x lever bits, 2 tiles a tick plus 2 ticks an
// action; 23 actions). The doors' conditions are quest_haunted.rs2:168-176.
const ROUTE: Array<[string, string]> = [
    ['lever', 'B'], ['lever', 'A'], ['door', '4to7'], ['lever', 'D'], ['door', '4to5'], ['door', '5to8'],
    ['lever', 'A'], ['lever', 'B'], ['door', '5to8'], ['door', '5to6'], ['door', '3to6'], ['lever', 'F'],
    ['lever', 'E'], ['door', '2to3'], ['door', '1to2'], ['lever', 'C'], ['door', '1to2'], ['door', '2to3'],
    ['lever', 'E'], ['door', '2to3'], ['door', '2to5'], ['door', '5to8'], ['door', '8to9'],
];
const SIDES: Record<string, [string, string]> = {
    '1to2': ['CA', 'R2'], '2to3': ['R2', 'R3'], '4to5': ['CA', 'R5'], '5to6': ['R5', 'R6'], '8to9': ['S', 'R9'],
    '2to5': ['R2', 'R5'], '3to6': ['R3', 'R6'], '4to7': ['CA', 'S'], '5to8': ['R5', 'S'],
};

const q = await openQuest({ cap: 1500 });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const lvlIs = (lv: number) => () => q.lvl() === lv;
    const x = (): number => q.pos()?.worldX ?? 0;
    const z = (): number => q.pos()?.worldZ ?? 0;
    const here = (): string => room(x(), z());
    const climb = (label: string, l: Loc, arrived: () => boolean) => q.climb(label, () => q.locAt(l.x, l.z) ?? l, /climb/i, arrived);

    // 1. Veronica: "Aha, sounds like a quest. I'll help." sets 1 (veronica.rs2:8-19).
    await q.talk('veronica', /^veronica$/i, [/sounds like a quest/i], () => q.sawText(/very grateful/i), VERONICA);
    q.milestone(1);

    // 2. Poison the fish food, pour it into the fountain, search it for the pressure gauge (quest_haunted.rs2:48-93).
    await q.step('poison food', () => q.useOnItem(ITEM.poison, ITEM.fishFood), () => q.has(ITEM.poisoned), 3, 4);
    await q.walk('to fountain', [{ x: 3088, z: 3336, tol: 2 }]);
    const poured = () => q.msgCount(/then die and float/i) > 0;
    await q.step('pour', () => q.useOnLoc(ITEM.poisoned, L.fountain), poured, 10, 4);
    // The gauge is added after the two chatplayer pages (:56-60), so the pages are clicked through.
    await q.step('gauge', () => q.opLoc(L.fountain, 1), () => q.dialogOpen() || q.has(ITEM.gauge), 8, 4);
    await q.converse([], () => q.has(ITEM.gauge) && !q.dialogOpen(), 15);
    if (!q.has(ITEM.gauge)) await q.fail('no pressure gauge');
    q.milestone('gauge');

    // 3. The spade on the compost heap gives the closet key (:16-29).
    await q.step('compost', () => q.useOnLoc(ITEM.spade, L.compost), () => q.has(ITEM.key), 12, 4);
    q.milestone('key');

    // 4. The front door (from the south), the closet with the key, the rubber tube on its floor.
    await q.walk('to front door', [{ x: 3108, z: 3352, tol: 0 }]);
    await q.step('front door', () => q.opLoc(L.frontDoor), () => z() >= 3354, 10, 4);
    q.milestone('house');
    // The hall door north of the entrance (loc_1530 at 3109,3358, south wall) is opened by tile; then the key click
    // routes to the closet door. A walk to 3107,3367 planned through the locked closet door and lost 77 ticks.
    await q.openDoor('hall door', 3109, 3358);
    q.milestone('closet door');
    await q.step('closet in', () => q.useOnLoc(ITEM.key, L.closet), () => x() >= 3108 && z() >= 3365, 15, 4);
    const tube = (): any => (q.st()?.groundItems ?? []).find((g: any) => g.id === ITEM.tube);
    await q.step('tube', () => { const g = tube(); return g ? q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' }) : undefined; }, () => q.has(ITEM.tube), 10, 4);
    await q.step('closet out', () => q.useOnLoc(ITEM.key, L.closet), () => x() <= 3107 && z() >= 3365, 15, 4);
    q.milestone('tube');

    // 5. The bookcase (searched from the east) opens the secret room; its ladder goes down to the basement.
    await q.walk('to bookcase', [{ x: 3098, z: 3358, tol: 0 }]);
    await q.step('bookcase', () => q.opLoc(L.bookcase, 1), () => x() <= 3096, 10, 4);
    await climb('ladder down', L.ladderDown, () => z() > 9000);
    q.milestone('basement');

    // 6. The lever route to room 9 and the oil can.
    const pulls = () => q.msgCount(/you pull lever/i);
    for (const [kind, key] of ROUTE) {
        if (kind === 'lever') {
            const n0 = pulls();
            const lv = LEVER[key]!;
            await q.step(`lever ${key}`, () => q.opLoc(lv, 1), () => pulls() > n0, 15, 4);
        } else {
            const [a, b] = SIDES[key]!;
            const to = here() === a ? b : a;
            const d = DOOR[key]!;
            await q.step(`door ${key} -> ${to}`, () => q.opLoc(d, 1), () => here() === to, 15, 4);
        }
    }
    const oil = (): any => (q.st()?.groundItems ?? []).find((g: any) => g.id === ITEM.oil);
    await q.step('oil can', () => { const g = oil(); return g ? q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' }) : undefined; }, () => q.has(ITEM.oil), 15, 4);
    q.milestone('oil');
    // Room 9 to the ladder: the 8to9 door's condition (E down, F up) still holds.
    await q.step('door 8to9 back', () => q.opLoc(DOOR['8to9']!, 1), () => here() === 'S', 15, 4);
    await climb('ladder up', L.ladderUp, () => z() < 9000);

    // 7. The lever out of the secret room, the stairs to level 2, Oddenstein twice (story sets 2; the parts, 3).
    await q.step('lever out', () => q.opLoc(L.leverOut, 1), () => x() >= 3098, 10, 4);
    await q.walk('to stairs', [{ x: 3108, z: 3362, tol: 1 }]);
    await climb('stairs 0', L.stairs0, lvlIs(1));
    await q.walk('to spiral stairs', [{ x: 3104, z: 3361, tol: 1 }]);
    await climb('stairs 1', L.stairs1, lvlIs(2));
    // The lab door (loc_1530 at 3108,3364, level 2): shut, the talk click cannot route (3 of 3 failed so).
    await q.openDoor('lab door', 3108, 3364);
    const odd = /^professor oddenstein$/i;
    await q.talk('oddenstein 1', odd, [/looking for a guy called ernest/i, /change him back this instant/i], () => q.sawText(/missing the pressure gauge/i), ODDENSTEIN, 60);
    q.milestone(2);
    await q.talk('oddenstein 2', odd, [], () => questDone, ODDENSTEIN, 60, true);
    await q.converse([], () => !q.dialogOpen(), 15);
    q.milestone(3);
    off();
    await q.end(questDone, 'qp=4');
} catch (e) { await q.fail(String(e)); }
