// Biohazard from preset quest_biohazard (in Elena's house, East Ardougne; every skill 99; Plague City done, %elenaquest
// 30 for the Ardougne teleport; priest gown and robe, runes for two Ardougne teleports from a helper). Reward: 3 QP,
// 1,250 Thieving XP before 25x (quests/quest_biohazard/scripts/quest_biohazard.rs2:157-162).
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
const CASTLE_STAIRS = { id: 1722, x: 2571, z: 3295 };      // stairs -> stairstop 1723 (maps/m40_51.jm2)
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
    // Open, then Search; the find comes after an objbox and a chat page (quest_biohazard.rs2:15-31).
    const search = async (label: string, shut: { id: number; x: number; z: number }, got: () => boolean): Promise<void> => {
        for (let i = 0; i < 8 && !got(); i++) {
            await q.guard(label);
            if (q.dialogOpen()) { await q.converse([], () => got() || !q.dialogOpen(), 10); continue; }
            const k = q.locAt(shut.x, shut.z) ?? shut;
            await q.opLoc(k, q.opIndex(k, /^search$|^open$/i));
            await q.waitUntil(() => got() || q.dialogOpen(), 8);
        }
        if (!got()) await q.fail(`search ${label}`);
        await q.converse([], () => !q.dialogOpen(), 6);
    };
    const wear = async (label: string, id: number): Promise<void> => {
        await q.step(label, () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(id)!, optionIndex: 2, reason: 'SDK' }), () => !q.has(id), 3, 3);
    };

    // 1. Elena: "I'll try to retrieve it for you." sets 1 (elena.rs2:118-134).
    await q.talk('elena 1', /^elena$/i, [/i'll try to retrieve it for you/i], () => q.sawText(/he lives next to the chapel/i), ELENA, 80);
    q.milestone(1);
    // Elena's door (elenadoor2 2054 at 2592,3339, south edge) walks the bot through and shuts behind it
    // (areas/area_ardougne_east/scripts/doors.rs2:1-5); the walker stalled 150 ticks at it in two trials.
    const ELENA_DOOR = { id: 2054, x: 2592, z: 3339 };
    const outOfElena = async (label: string) => { await q.walk(`${label} to door`, [{ x: ELENA_DOOR.x, z: ELENA_DOOR.z - 1, tol: 0 }]); await cross(label, ELENA_DOOR, /^open$/i, () => z() >= ELENA_DOOR.z); };
    const intoElena = async (label: string) => { await q.walk(`${label} to door`, [{ x: ELENA_DOOR.x, z: ELENA_DOOR.z, tol: 0 }]); await cross(label, ELENA_DOOR, /^open$/i, () => z() < ELENA_DOOR.z); };
    await outOfElena('elena door out');
    // 2. Jerico: 2 (jerico.rs2:34-44). His cupboard gives the birdfeed; the pigeons behind his house.
    // His house door (loc_1530 at 2610,3324, east edge, maps/m40_51.jm2): shut, the talk is rejected.
    await q.walk('to jerico', [{ x: JERICO.x, z: JERICO.z, tol: 5 }]);
    await q.openDoor('jerico door', 2610, 3324);
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
    const ladders = () => q.msgCount(/climb up the rope ladder/i);
    await q.talk('omart', /^omart$/i, [/ok, lets do it/i], () => ladders() >= 1, OMART, 60);
    await q.waitUntil(() => x() <= 2556, 10);
    if (x() > 2556) await q.fail('omart ladder');
    q.milestone(5);
    // 6. The rotten apple in the mourners' stew (6) (quest_biohazard.rs2:70-81).
    await q.walk('to apple', [{ x: APPLE.x, z: APPLE.z, tol: 1 }]);
    await pickup('apple', ITEM.apple);
    // The cauldron stands in a railed yard; the fence (mournerstewfence 2068 at 2541,3331, east edge) is climbed over
    // (general_use/scripts/fence.rs2:1-27). From outside the rail the apple gets "I can't reach that!".
    const FENCE = { id: 2068, x: 2541, z: 3331 };
    await q.walk('to fence', [{ x: FENCE.x, z: FENCE.z, tol: 0 }]);
    await cross('fence in', FENCE, /climb-over/i, () => x() > FENCE.x);
    await q.step('apple', () => q.useOnLoc(ITEM.apple, q.locAt(CAULDRON.x, CAULDRON.z) ?? CAULDRON), () => !q.has(ITEM.apple), 10, 4);
    await q.waitUntil(() => sawMsg(/quickly dissolves/i), 10);
    await cross('fence out', FENCE, /climb-over/i, () => x() <= FENCE.x);
    q.milestone(6);
    // 7. The nurse's cupboard gives the doctors' gown (quest_biohazard.rs2:83-90); worn, it opens the HQ doors
    // (doors.rs2:1-13,56-66). Upstairs a sick mourner (mournerstew2) dies with the key (mourner.rs2:68-79); the key
    // opens the gate; the crate gives the distillator (7) (quest_biohazard.rs2:92-128).
    // The hut door (loc_1530 at 2519,3275, west edge, maps/m39_51.jm2); from a diagonal tile the cupboard gets
    // "I can't reach that!".
    await q.walk('to nurse hut', [{ x: 2520, z: 3275, tol: 1 }]);
    await q.openDoor('nurse door', 2519, 3275);
    for (let i = 0; i < 4 && !q.near(2518, 3275, 0); i++) {
        await q.openDoor(`nurse door ${i}`, 2519, 3275);
        await q.s.direct({ type: 'walkTo', x: 2518, z: 3275, running: true, reason: 'SDK' });
        await q.waitUntil(() => q.near(2518, 3275, 0), 6);
    }
    await search('nurse cupboard', NURSE_CUPBOARD, () => q.has(ITEM.doctor));
    await wear('doctor gown', ITEM.doctor);
    await q.walk('to hq', [{ x: HQ_DOOR.x, z: HQ_DOOR.z, tol: 0 }]);
    await cross('hq door', HQ_DOOR, /^open$/i, () => z() > HQ_DOOR.z);
    // The stairs room door (loc_1530 at 2546,3325, east edge, maps/m39_51.jm2): shut, the stairs click gets
    // "I can't reach that!".
    await q.walk('to stairs door', [{ x: 2547, z: 3325, tol: 0 }]);
    await q.openDoor('stairs door', 2546, 3325);
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
    // Out: Ardougne teleport from the HQ upstairs (East Ardougne, 2661,3301; skillmagic dbrow tele_coord 0_41_51_37_37).
    // In two trials the walk out stalled in the stairs room (92 and 272 ticks) with five mourners round the door, and
    // the teleport also skips Kilron's ladder (kilron.rs2:1-12).
    await q.teleport('ardougne teleport 1', 'magic:ardougne_teleport', 2661, 3301);
    // 8. Elena: the distillator gives three vials and the sample (10) (elena.rs2:61-99).
    await intoElena('elena door in');
    // Her script closes the dialog twice with p_delay(2) before it gives the items (elena.rs2:70-99); a new click in
    // that gap cancels it (a trial handed the distillator twice), so the bot clicks once and waits.
    await q.step('elena 2', () => { const e = q.npc(/^elena$/i); return e ? q.talkTo(e) : q.waitTicks(1); }, () => q.dialogOpen(), 15, 4);
    for (let i = 0; i < 80 && !(q.has(ITEM.sample) && !q.dialogOpen()); i++) {
        await q.converse([], () => !q.dialogOpen(), 1);
        await q.waitTicks(1);
    }
    if (!q.has(ITEM.sample)) await q.fail('elena: no sample');
    q.milestone(10);
    // 9. The walk to Rimmington: a teleport destroys the plague sample (skill_magic/scripts/spells/teleport.rs2:94-97),
    // and the chemist and Guidor both need it (chemist.rs2:52-54, guidor.rs2:47-50). The chemist's door (loc_1533 at
    // 2932,3213, north edge, maps/m45_50.jm2); "It's ok, I'm Elena's friend.", "I just need some touch paper for a guy
    // called Guidor." (12, chemist.rs2:50-62,76-91). The errand boys: Hops the broline, Chancy the honey, DeVinci the
    // ethenea (hops.rs2, chancy.rs2:32-43, devinci.rs2:21-33).
    await q.walk('to rimmington', [{ x: 2932, z: 3214, tol: 1 }]);
    await q.openDoor('chemist door', 2932, 3213);
    await q.talk('chemist', /^chemist$/i, [/i'm elena's friend/i, /touch paper for a guy called guidor/i], () => q.has(ITEM.paper), CHEMIST, 120);
    q.milestone(12);
    const give = async (label: string, re: RegExp, opt: RegExp, item: number): Promise<void> => {
        await q.talk(label, re, [opt], () => !q.has(item), BOYS, 60);
    };
    await give('hops', /^hops$/i, /vial of sulphuric broline/i, ITEM.broline);
    await give('chancy', /^chancy$/i, /vial of liquid honey/i, ITEM.honey);
    await give('devinci', /^devinci$/i, /vial of ethenea/i, ITEM.ethenea);
    q.milestone('errands');
    // 10. The walk to Varrock (the sample again); the three vials back at the Dancing Donkey Inn; the priest gown and
    // robe worn open Guidor's door (quest_biohazard.rs2:1-15); Guidor (14, guidor.rs2:15-72).
    // The inn is outside the east gate (guidorgatelclosed 2050 at 3264,3405, west edge); the walk reaches it only
    // through the gate, and the gate guard searches the bot first (areas/area_varrock/scripts/east_gate.rs2:9-37).
    // In a trial the walker clicked the gate again after the search and went back in, three times, to the tick cap;
    // the bot clicks it once and waits.
    const VGATE = { id: 2050, x: 3264, z: 3405 };
    await q.walk('to varrock gate', [{ x: VGATE.x - 1, z: VGATE.z, tol: 0 }]);
    for (let i = 0; i < 3 && x() < VGATE.x; i++) {
        await q.guard('varrock gate');
        if (!q.dialogOpen()) { const g = q.locAt(VGATE.x, VGATE.z) ?? VGATE; await q.opLoc(g, q.opIndex(g, /^open$/i)); }
        for (let k = 0; k < 30 && x() < VGATE.x; k++) { await q.converse([], () => !q.dialogOpen(), 1); await q.waitTicks(1); }
    }
    if (x() < VGATE.x) await q.fail('varrock gate');
    await q.converse([], () => !q.dialogOpen(), 6);
    await q.dash('to inn', INN.x, INN.z, 3, 30);
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
    await q.teleport('ardougne teleport 2', 'magic:ardougne_teleport', 2661, 3301);
    await intoElena('elena door in 2');
    await q.talk('elena 3', /^elena$/i, [], () => q.sawText(/see the king of east ardougne/i), ELENA, 60);
    await outOfElena('elena door out 2');
    q.milestone(15);
    await q.walk('to castle stairs', [{ x: CASTLE_STAIRS.x + 1, z: CASTLE_STAIRS.z, tol: 1 }]);
    await q.climb('castle stairs', () => q.locAt(CASTLE_STAIRS.x, CASTLE_STAIRS.z) ?? CASTLE_STAIRS, /climb-up|^climb$|walk-up/i, () => q.lvl() === 1);
    // His room door (loc_1536 at 2575,3293, west edge, level 1): shut, the talk is rejected.
    await q.walk('to lathas door', [{ x: 2574, z: 3293, tol: 0 }]);
    await q.openDoor('lathas door', 2575, 3293);
    await q.talk('lathas', /^king lathas$/i, [/^i don't understand/i], () => questDone, LATHAS, 120, true);
    await q.converse([], () => !q.dialogOpen(), 10);
    q.milestone(100);
    off();
    await q.end(questDone, 'qp=3');
} catch (e) { await q.fail(String(e)); }
