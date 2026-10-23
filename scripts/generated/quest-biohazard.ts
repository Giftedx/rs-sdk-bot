// Biohazard from preset quest_biohazard (in Elena's house, East Ardougne; every skill 99; Plague City done, %elenaquest
// 30 for the Ardougne teleport; priest gown and robe, runes for a Falador, a Varrock and an Ardougne teleport from a
// helper). Reward: 3 QP, 1,250 Thieving XP before 25x (quests/quest_biohazard/scripts/quest_biohazard.rs2:157-162).
// Varp %biohazard (68, quest_biohazard.constant): 1 Elena, 2 Jerico, 3 birdfeed on the watch tower, 4 the pigeons,
// 5 Omart's rope ladder, 6 the rotten apple in the mourners' stew, 7 the distillator, 10 Elena (vials and sample),
// 12 the chemist (touch paper), 14 Guidor, 15 Elena, then King Lathas queues the completion.
// Server truth: areas/area_ardougne_east/scripts/elena.rs2, quests/quest_biohazard/scripts/*.rs2,
// areas/area_ardougne_west/scripts/{omart,kilron,doors,mourner}.rs2, areas/area_ardougne_east/scripts/king_lathas.rs2.
// Untradeable (quest_biohazard.obj): birdfeed, pigeons, key, distillator, the three vials, sample, touch paper,
// doctors' gown, so the bot collects them itself.
import { openQuest } from './quest-lib';

const ELENA = { x: 2592, z: 3336 };
const JERICO = { x: 2612, z: 3324 };
const JERICO_CUPBOARD = { id: 2056, x: 2611, z: 3326 };    // jericoscupboardshut -> 2057 (Search)
const PIGEONS = { x: 2618, z: 3324 };                      // obj 424 at 2618,3323-3325 (maps/m40_51.jm2)
const TOWER = { id: 2067, x: 2562, z: 3301 };              // biowatchtower 2559-2563,3301-3306
const TOWER_SPOT = { x: 2562, z: 3303 };                   // inside inzone(0_39_51_63_35, 0_40_51_5_43)
const OMART = { x: 2559, z: 3266 };
const KILRON = { x: 2556, z: 3266 };
const APPLE = { x: 2535, z: 3333 };                        // obj 1984 (maps/m39_52.jm2)
const CAULDRON = { id: 2043, x: 2543, z: 3332 };
const NURSE_CUPBOARD = { id: 2062, x: 2517, z: 3276 };     // bionursescupboardshut -> 2063 (Search)
const HQ_DOOR = { id: 2036, x: 2551, z: 3320 };            // mournerstewdoor, north edge; outside is south
const HQ_STAIRS = { id: 1738, x: 2542, z: 3324 };
const UP_DOOR = { id: 2034, x: 2547, z: 3325 };            // mournerstewdoorup, level 1, west edge
const GATE = { id: 2060, x: 2551, z: 3325 };               // mournerquaters_gater, level 1, east edge
const CRATE = { id: 2064, x: 2554, z: 3327 };              // mournercrateup, level 1
const CHEMIST = { x: 2934, z: 3210 };
const BOYS = { x: 2933, z: 3218 };                         // Hops 2931,3219; DeVinci 2933,3219; Chancy 2935,3219
const INN = { x: 3271, z: 3390 };                          // Hops 3268,3389; Chancy 3270,3391; DeVinci 3274,3390
const GUIDOR_DOOR = { id: 2032, x: 3282, z: 3382 };        // guidordoor, east edge
const GUIDOR = { x: 3285, z: 3381 };
const LATHAS = { x: 2578, z: 3293 };                       // level 1 of Ardougne castle
const ITEM = { gown: 426, robe: 428, doctor: 430, feed: 422, pigeons: 424, apple: 1984, key: 423, distillator: 420,
    ethenea: 415, honey: 416, broline: 417, sample: 418, paper: 419 };

const q = await openQuest({ cap: 5000 });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const x = () => q.pos()?.worldX ?? 0;
    const z = () => q.pos()?.worldZ ?? 0;
    const sawMsg = (re: RegExp) => q.msgCount(re) > 0;
    const cross = async (label: string, l: { id: number; x: number; z: number }, op: RegExp, through: () => boolean): Promise<void> => {
        await q.step(label, () => { const k = q.locAt(l.x, l.z) ?? l; return q.opLoc(k, q.opIndex(k, op)); }, through, 12, 5);
        await q.converse([], () => !q.dialogOpen(), 6);
    };
    const pickup = async (label: string, id: number): Promise<void> => {
        for (let i = 0; i < 15 && !q.has(id); i++) {
            await q.guard(label);
            const g = (q.st()?.groundItems ?? []).filter((x: any) => x.id === id).sort((a: any, b: any) => a.distance - b.distance)[0];
            if (g && i % 3 === 0) await q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' });
            await q.waitTicks(1);
        }
        if (!q.has(id)) await q.fail(`pickup ${label}`);
    };
    const search = async (label: string, shut: { id: number; x: number; z: number }, got: () => boolean): Promise<void> => {
        await q.step(label, () => {
            const k = q.locAt(shut.x, shut.z) ?? shut;
            return q.opLoc(k, q.opIndex(k, /^search$|^open$/i));
        }, got, 10, 6);
        await q.converse([], () => !q.dialogOpen(), 6);
    };
    const wear = async (label: string, id: number): Promise<void> => {
        await q.step(label, () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(id)!, optionIndex: 2, reason: 'SDK' }), () => !q.has(id), 3, 3);
    };

    // 1. Elena: "I'll try to retrieve it for you." sets 1 (elena.rs2:118-134).
    await q.talk('elena 1', /^elena$/i, [/i'll try to retrieve it for you/i], () => q.sawText(/he lives next to the chapel/i), ELENA, 80);
    q.milestone(1);
    // 2. Jerico: 2 (jerico.rs2:34-44). His cupboard gives the birdfeed; the pigeons behind his house.
    await q.talk('jerico', /^jerico$/i, [], () => q.sawText(/omart is waiting for you/i), JERICO, 60);
    q.milestone(2);
    await search('cupboard', JERICO_CUPBOARD, () => q.has(ITEM.feed));
    await q.walk('to pigeons', [{ x: PIGEONS.x - 1, z: PIGEONS.z, tol: 1 }]);
    await pickup('pigeons', ITEM.pigeons);
    // 3-4. The birdfeed on the watch tower (3), the pigeons opened in its zone (4) (quest_biohazard.rs2:24-52).
    await q.walk('to tower', [{ x: TOWER_SPOT.x, z: TOWER_SPOT.z, tol: 1 }]);
    await q.step('birdfeed', () => q.useOnLoc(ITEM.feed, q.findLoc(l => l.id === TOWER.id && l.distance <= 8) ?? TOWER), () => !q.has(ITEM.feed), 10, 4);
    await q.step('pigeons', () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(ITEM.pigeons)!, optionIndex: 1, reason: 'SDK' }), () => !q.has(ITEM.pigeons), 8, 4);
    q.milestone(4);
    // 5. Omart: "Ok, lets do it." over the wall (omart.rs2:10-37, quest_biohazard.rs2:54-68).
    await q.talk('omart', /^omart$/i, [/ok, lets do it/i], () => x() <= 2556 && z() < 3280, OMART, 60);
    q.milestone(5);
    // 6. The rotten apple in the mourners' stew (6) (quest_biohazard.rs2:70-81).
    await q.walk('to apple', [{ x: APPLE.x, z: APPLE.z, tol: 1 }]);
    await pickup('apple', ITEM.apple);
    await q.walk('to cauldron', [{ x: CAULDRON.x, z: CAULDRON.z + 1, tol: 1 }]);
    await q.step('apple', () => q.useOnLoc(ITEM.apple, q.locAt(CAULDRON.x, CAULDRON.z) ?? CAULDRON), () => !q.has(ITEM.apple), 10, 4);
    await q.waitUntil(() => sawMsg(/quickly dissolves/i), 10);
    q.milestone(6);
    // 7. The nurse's cupboard gives the doctors' gown (quest_biohazard.rs2:83-90); worn, it opens the HQ doors
    // (doors.rs2:1-13,56-66). Upstairs a sick mourner (mournerstew2) dies with the key (mourner.rs2:68-79); the key
    // opens the gate; the crate gives the distillator (7) (quest_biohazard.rs2:92-128).
    await q.walk('to nurse', [{ x: NURSE_CUPBOARD.x + 1, z: NURSE_CUPBOARD.z, tol: 1 }]);
    await search('nurse cupboard', NURSE_CUPBOARD, () => q.has(ITEM.doctor));
    await wear('doctor gown', ITEM.doctor);
    await q.walk('to hq', [{ x: HQ_DOOR.x, z: HQ_DOOR.z, tol: 0 }]);
    await cross('hq door', HQ_DOOR, /^open$/i, () => z() > HQ_DOOR.z);
    await q.climb('hq stairs', () => q.findLoc(l => l.id === HQ_STAIRS.id && l.distance <= 15) ?? HQ_STAIRS, /climb-up|^climb$/i, () => q.lvl() === 1);
    await q.walk('to up door', [{ x: UP_DOOR.x - 1, z: UP_DOOR.z, tol: 0 }]);
    await cross('up door', UP_DOOR, /^open$/i, () => x() >= UP_DOOR.x);
    for (let i = 0; i < 6 && !q.has(ITEM.key); i++) {
        await q.guard('sick mourner');
        const m = (q.st()?.nearbyNpcs ?? []).filter((n: any) => /^mourner$/i.test(n.name) && n.combatLevel === 13).sort((a: any, b: any) => a.distance - b.distance)[0];
        if (!m) { await q.waitTicks(2); continue; }
        await q.s.bot.attack(m as any);
        await q.waitUntil(() => q.has(ITEM.key) || !(q.st()?.nearbyNpcs ?? []).some((n: any) => n.index === m.index), 60);
        await q.waitUntil(() => q.has(ITEM.key), 4);
    }
    if (!q.has(ITEM.key)) await q.fail('no mourner key');
    q.milestone('key');
    await q.step('gate key', () => q.useOnLoc(ITEM.key, q.locAt(GATE.x, GATE.z) ?? GATE), () => x() > GATE.x, 12, 5);
    await q.step('crate', () => q.opLoc(q.locAt(CRATE.x, CRATE.z) ?? CRATE, 1), () => q.has(ITEM.distillator), 12, 4);
    q.milestone(7);
    // Out: the gate, the door, the stairs, the HQ door; Kilron: "Yes I do." back over the wall (kilron.rs2:1-12).
    await cross('gate out', GATE, /^open$/i, () => x() <= GATE.x);
    await cross('up door out', UP_DOOR, /^open$/i, () => x() < UP_DOOR.x);
    await q.climb('hq stairs down', () => q.findLoc(l => /stair/i.test(l.name) && l.distance <= 10), /climb-down|^climb$/i, () => q.lvl() === 0);
    await q.walk('to hq door out', [{ x: HQ_DOOR.x, z: HQ_DOOR.z + 1, tol: 0 }]);
    await cross('hq door out', HQ_DOOR, /^open$/i, () => z() <= HQ_DOOR.z);
    await q.talk('kilron', /^kilron$/i, [/^yes i do/i], () => x() >= 2559 && z() < 3280, KILRON, 60);
    // 8. Elena: the distillator gives three vials and the sample (10) (elena.rs2:61-99).
    await q.talk('elena 2', /^elena$/i, [], () => q.has(ITEM.sample) && q.has(ITEM.ethenea), ELENA, 120);
    q.milestone(10);
    // 9. Falador teleport, Rimmington: the chemist: "It's ok, I'm Elena's friend.", "I just need some touch paper for a
    // guy called Guidor." (12, chemist.rs2:50-62,76-91). The errand boys: Hops the broline, Chancy the honey, DeVinci the
    // ethenea (hops.rs2, chancy.rs2:32-43, devinci.rs2:21-33).
    await q.teleport('falador teleport', 'magic:falador_teleport', 2965, 3378);
    await q.talk('chemist', /^chemist$/i, [/i'm elena's friend/i, /touch paper for a guy called guidor/i], () => q.has(ITEM.paper), CHEMIST, 120);
    q.milestone(12);
    const give = async (label: string, re: RegExp, opt: RegExp, item: number): Promise<void> => {
        await q.talk(label, re, [opt], () => !q.has(item), BOYS, 60);
    };
    await give('hops', /^hops$/i, /vial of sulphuric broline/i, ITEM.broline);
    await give('chancy', /^chancy$/i, /vial of liquid honey/i, ITEM.honey);
    await give('devinci', /^devinci$/i, /vial of ethenea/i, ITEM.ethenea);
    q.milestone('errands');
    // 10. Varrock teleport; the three vials back at the Dancing Donkey Inn; the priest gown and robe worn open Guidor's
    // door (quest_biohazard.rs2:1-15); Guidor (14, guidor.rs2:15-72).
    await q.teleport('varrock teleport', 'magic:varrock_teleport', 3212, 3424);
    await q.talk('hops 2', /^hops$/i, [], () => q.has(ITEM.broline), INN, 60);
    await q.talk('chancy 2', /^chancy$/i, [], () => q.has(ITEM.honey), INN, 60);
    await q.talk('devinci 2', /^devinci$/i, [], () => q.has(ITEM.ethenea), INN, 60);
    q.milestone('vials');
    await wear('priest gown', ITEM.gown);
    await wear('priest robe', ITEM.robe);
    await q.walk('to guidor', [{ x: GUIDOR_DOOR.x, z: GUIDOR_DOOR.z, tol: 0 }]);
    await cross('guidor door', GUIDOR_DOOR, /^open$/i, () => x() > GUIDOR_DOOR.x);
    await q.talk('guidor', /^guidor$/i, [/assistance in stopping a plague/i, /sent by your old pupil elena/i, /that's why elena wanted you/i], () => q.sawText(/the only question is/i), GUIDOR, 120);
    q.milestone(14);
    // 11. Ardougne teleport; Elena (15, elena.rs2:18-28); King Lathas: "I don't understand..." queues the completion
    // (king_lathas.rs2:41-68).
    await q.teleport('ardougne teleport', 'magic:ardougne_teleport', 2661, 3301);
    await q.talk('elena 3', /^elena$/i, [], () => q.sawText(/see the king of east ardougne/i), ELENA, 60);
    q.milestone(15);
    await q.walk('to castle', [{ x: LATHAS.x, z: LATHAS.z, tol: 4 }]);
    if (q.lvl() !== 1) await q.climb('castle stairs', () => q.findLoc(l => /stair/i.test(l.name) && l.distance <= 15), /climb-up|^climb$|walk-up/i, () => q.lvl() === 1);
    await q.talk('lathas', /^king lathas$/i, [/^i don't understand/i], () => questDone, LATHAS, 120, true);
    await q.converse([], () => !q.dialogOpen(), 10);
    q.milestone(100);
    off();
    await q.end(questDone, 'qp=3');
} catch (e) { await q.fail(String(e)); }
