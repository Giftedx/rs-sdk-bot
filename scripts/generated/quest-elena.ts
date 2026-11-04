// Plague City from preset quest_elena (in Edmond's house, East Ardougne; every skill 99; dwellberries, 4 buckets of
// water, spade, rope, chocolate dust, bucket of milk and snape grass from a helper). Reward: 1 QP, 2,425 Mining XP
// before 25x, the Ardougne teleport scroll (quests/quest_elena/scripts/quest_elena.rs2:5-15).
// Varp %elenaquest (quest_elena.constant): 1 Edmond, 2 gas mask, 3 Edmond, 4-7 four buckets on the mud patch, 8 the
// spade (into the sewer), 9 rope on the grill, 10 Edmond pulls it, 20 Jethick (picture -> book), 21 the book to Ted at
// the door, 22 Ted, 23 Milli, 24 the plague house mourner, 25 the clerk, 26 Bravek (recipe), 27 the hangover cure,
// then the warrant, the barrel key, Elena (28), Edmond queues the completion.
// Untradeable (quest_elena configs): gas mask, picture, book, key, note, warrant, hangover cure, and chocolaty milk
// (knowledge/items.json), so the bot mixes the cure itself (skill_cooking/.../cakes/cakes.rs2:20-24,50-54,138-145).
import { openQuest } from './quest-lib';

const EDMOND = { x: 2568, z: 3334 };
const ALRENA = { x: 2573, z: 3333 };
const PICTURE = { x: 2576, z: 3334 };                      // obj 1510 (maps/m40_52.jm2 OBJ)
const MUD = { id: 2531, x: 2566, z: 3332 };                // plaguemudpatch1/2 at 2566,3331-3333
const PIPE = { id: 2541, x: 2530, z: 9701 };               // plaguesewerpipe (sewer)
const SEWER_EDMOND = { x: 2535, z: 9719 };
const JETHICK = { x: 2540, z: 3305 };
const REHNISON_DOOR = { x: 2531, z: 3328 };                // rehnisondoorshut 2537, north edge
const TED = { x: 2531, z: 3331 };
const STAIRS = { id: 2539, x: 2527, z: 3332 };             // rehnisonstairs -> 1_39_52_31_3
const MILLI = { x: 2531, z: 3330 };
const PLAGUE_DOOR = { id: 2535, x: 2533, z: 3272 };        // loc_2535, south edge; the mourners stand north
const CLERK = { x: 2528, z: 3317 };
const BRAVEK_DOOR = { x: 2530, z: 3314 };                  // bravekdoorshut 2528
const BRAVEK = { x: 2536, z: 3314 };
const BARREL = { id: 2530, x: 2534, z: 3268 };             // plaguekeybarrel
const DOWN = { id: 2522, x: 2536, z: 3268 };               // plaguehousestairsdown -> 0_39_151_41_6
const UP = { x: 2537, z: 9670 };
const GATE = { id: 2526, x: 2539, z: 9672 };               // elenagateshut, east edge
const ELENA = { x: 2541, z: 9672 };
const MANHOLE = { x: 2529, z: 3303 };                      // plaguemanholeclosed/open 2543/2544
const MUD_PILE = { id: 2533, x: 2561, z: 9738 };           // back to the garden 0_40_52_6_3
const ITEM = { berries: 2126, water: 1929, spade: 952, rope: 954, dust: 1975, milk: 1927, snape: 231, choc: 1977, cure: 1504,
    mask: 1506, picture: 1510, book: 1509, note: 1508, warrant: 1503, key: 1507 };

const q = await openQuest({ cap: 3000 });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const edmond = /^edmond$/i;
    const inSewer = () => (q.pos()?.worldZ ?? 0) > 9000;

    // 1. Edmond: "What's happened to her?", "Can I help find her?" sets 1 (edmond.rs2:2-8,52-66).
    // Edmond wanders between the garden and the house (door loc_1530 at 2570,3333): with the door shut the talk is
    // rejected (opRejectedCount), so the door is opened before each Edmond talk.
    await q.openDoor('house door 0', 2570, 3333);
    await q.talk('edmond 1', edmond, [/what's happened to her/i, /can i help find her/i], () => q.sawText(/mcgrubor's wood to the north/i), EDMOND, 60);
    q.milestone(1);
    // The picture on the table (obj 1510) in the house east of the garden, behind the door loc_1530 at 2570,3333
    // and the inner door loc_1530 at 2574,3333 (maps/m40_52.jm2): with a door shut the pickup gets "I can't reach that!".
    await q.openDoor('house door', 2570, 3333);
    await q.walk('to inner door', [{ x: 2573, z: 3333, tol: 0 }]);
    await q.openDoor('inner door', 2574, 3333);
    for (let i = 0; i < 12 && !q.has(ITEM.picture); i++) {
        const g = (q.st()?.groundItems ?? []).find((x: any) => x.id === ITEM.picture);
        if (g && i % 3 === 0) await q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' });
        await q.waitTicks(1);
    }
    if (!q.has(ITEM.picture)) await q.fail('no picture');
    // 2. Alrena makes the gas mask from the dwellberries: 2 (alrena.rs2:9-29).
    await q.talk('alrena', /^alrena$/i, [], () => q.has(ITEM.mask), ALRENA, 60);
    q.milestone(2);
    // 3. Edmond: 3 (edmond.rs2:18-22).
    await q.openDoor('inner door out', 2574, 3333);
    await q.openDoor('house door out', 2570, 3333);
    await q.talk('edmond 2', edmond, [], () => q.sawText(/pour on some buckets of water/i), EDMOND, 40);
    // 4. Four buckets on the mud patch (4-7), the spade: into the sewer (8) (mud_patch.rs2:1-46).
    for (let i = 0; i < 16 && q.has(ITEM.water); i++) {
        await q.guard('buckets');
        if (q.dialogOpen()) { await q.converse([], () => !q.dialogOpen(), 4); continue; }
        const n = q.cnt(ITEM.water);
        await q.useOnLoc(ITEM.water, q.findLoc(l => (l.id === 2531 || l.id === 2532) && l.distance <= 10) ?? MUD);
        await q.waitUntil(() => q.cnt(ITEM.water) < n, 8);
    }
    await q.converse([], () => !q.dialogOpen(), 6);
    q.milestone(7);
    await q.step('dig', () => q.useOnLoc(ITEM.spade, q.findLoc(l => (l.id === 2531 || l.id === 2532) && l.distance <= 10) ?? MUD), inSewer, 10, 4);
    await q.converse([], () => !q.dialogOpen(), 10);
    q.milestone(8);
    // 5. The rope on the grill (9), Edmond pulls (10) (sewerpipe.rs2:24-34, edmond.rs2:26-32).
    await q.walk('to pipe', [{ x: PIPE.x, z: PIPE.z + 2, tol: 1 }]);
    await q.step('rope', () => q.useOnLoc(ITEM.rope, q.locAt(PIPE.x, PIPE.z) ?? PIPE), () => !q.has(ITEM.rope), 10, 4);
    await q.converse([], () => !q.dialogOpen(), 6);
    await q.talk('edmond pull', edmond, [], () => q.sawText(/that's done the job/i), SEWER_EDMOND, 40);
    q.milestone(10);
    // 6. The gas mask worn, through the pipe to West Ardougne (sewerpipe.rs2:1-12,36-48).
    const e = await q.s.bot.equipItem(/^gas mask$/i);
    if (!e.success) console.log(`WARN mask ${e.message}`);
    await q.step('pipe', () => q.opLoc(q.locAt(PIPE.x, PIPE.z) ?? PIPE, 1), () => !inSewer(), 15, 4);
    q.milestone('west');
    // 7. Jethick: the picture gives the book (20) (jethick.rs2:1-25).
    await q.talk('jethick', /^jethick$/i, [/looking for a woman from east ardougne/i], () => q.has(ITEM.book), JETHICK, 60);
    q.milestone(20);
    // 8. The Rehnison door with Ted inside takes the book (21, doors.rs2:97-117); Ted (22); Milli upstairs (23)
    // (rehnisons.rs2).
    await q.walk('to rehnisons', [{ x: REHNISON_DOOR.x, z: REHNISON_DOOR.z, tol: 0 }]);
    // The door does nothing unless Ted is within 7 tiles of the player (doors.rs2:101-103), and the book goes only after
    // the dialogue pages (:104-114): a second click would close them, so each try answers the pages first.
    for (let i = 0; i < 15 && q.has(ITEM.book); i++) {
        await q.guard('rehnison door');
        if (i > 0) q.stats.retries++;
        await q.opLoc(q.findLoc(l => l.x === REHNISON_DOOR.x && l.z === REHNISON_DOOR.z && /door/i.test(l.name)) ?? { id: 2537, ...REHNISON_DOOR }, 1);
        await q.waitUntil(() => q.dialogOpen() || !q.has(ITEM.book), 6);
        await q.converse([], () => !q.dialogOpen(), 30);
        if (q.has(ITEM.book)) await q.waitTicks(3);
    }
    if (q.has(ITEM.book)) await q.fail('rehnison door');
    await q.converse([], () => !q.dialogOpen(), 6);
    await q.talk('ted', /^(ted|martha) rehnison$/i, [], () => q.sawText(/milli is upstairs/i) && !q.dialogOpen(), TED, 60);
    await q.climb('stairs up', () => q.locAt(STAIRS.x, STAIRS.z), /walk-up|climb|up/i, () => q.lvl() === 1);
    await q.talk('milli', /^milli rehnison$/i, [], () => q.sawText(/mossy windowless building/i) && !q.dialogOpen(), MILLI, 60);
    q.milestone(23);
    await q.climb('stairs down', () => q.findLoc(l => /stair/i.test(l.name) && l.distance <= 5), /walk-down|climb|down/i, () => q.lvl() === 0);
    // The door shuts behind the bot; from the book stage on it opens for anyone (doors.rs2:97-100).
    await q.walk('to rehnison door', [{ x: REHNISON_DOOR.x, z: REHNISON_DOOR.z + 1, tol: 0 }]);
    await q.step('rehnison door out', () => q.opLoc(q.findLoc(l => l.x === REHNISON_DOOR.x && l.z === REHNISON_DOOR.z && /door/i.test(l.name)) ?? { id: 2537, ...REHNISON_DOOR }, 1),
        () => (q.pos()?.worldZ ?? 9999) <= REHNISON_DOOR.z, 8, 5);
    // 9. The plague house door with a mourner near: "I fear not a mere plague." (24, doors.rs2:11-19,51-67).
    await q.walk('to plague house', [{ x: PLAGUE_DOOR.x, z: PLAGUE_DOOR.z + 1, tol: 1 }]);
    await q.step('plague door 1', () => q.opLoc(q.locAt(PLAGUE_DOOR.x, PLAGUE_DOOR.z) ?? PLAGUE_DOOR, 1), () => q.dialogOpen(), 10, 4);
    await q.converse([/i fear not a mere plague/i], () => !q.dialogOpen() && q.sawText(/clearance|bravek|warrant/i), 40);
    await q.converse([], () => !q.dialogOpen(), 10);
    q.milestone(24);
    // 10. The clerk: "I need permission to enter a plague house.", "This is urgent though!" (25, clerk.rs2:1-60);
    // Bravek: "This is really important though!", "Do you know what is in the cure?" (26, bravek.rs2).
    // Bravek must be within 7 tiles of the player when the clerk's "really needs to" page is continued (clerk.rs2:48-55).
    // He wanders x 2531-2541 behind the wall, so the bot stands at the east end of the office (2529,3317), answers
    // "This is urgent though!", and holds that page until he is within 6 tiles (rs-stun-toolkit `q-plague-city.ts`, MIT,
    // research/stun-toolkit-LICENSE.txt).
    const bravekNear = () => { const b = q.npc(/^bravek$/i); return !!b && q.cheb(b.x, b.z) <= 6; };
    const callPage = () => { const d: any = q.s.sdk.getDialog(); return !!d?.isOpen && /really needs to/i.test([d.text ?? '', ...(d.allComponents ?? []).map((c: any) => c.text ?? '')].join(' ')); };
    for (let tryN = 0; tryN < 4 && !q.sawText(/if they keep it short/i); tryN++) {
        await q.walk('clerk stand', [{ x: 2529, z: 3317, tol: 0 }]);
        await q.talk('clerk', /^clerk$/i, [/need permission to enter a plague house/i, /this is urgent though/i], callPage, CLERK, 60, true);
        await q.waitUntil(bravekNear, 150);
        await q.converse([/i'll try asking them then/i], () => !q.dialogOpen(), 20);
    }
    if (!q.sawText(/if they keep it short/i)) await q.fail('clerk');
    q.milestone(25);
    await q.openDoor('bravek door', BRAVEK_DOOR.x, BRAVEK_DOOR.z);
    await q.talk('bravek 1', /^bravek$/i, [/this is really important though/i, /do you know what is in the cure/i], () => q.has(ITEM.note), BRAVEK, 60);
    q.milestone(26);
    // 11. The hangover cure: chocolate dust into the milk, snape grass into the chocolaty milk; Bravek drinks it (27)
    // and "They won't listen to me!" gives the warrant (bravek.rs2).
    await q.step('choc milk', () => q.useOnItem(ITEM.dust, ITEM.milk), () => q.has(ITEM.choc), 6, 3);
    await q.converse([], () => !q.dialogOpen(), 4);
    await q.step('cure', () => q.useOnItem(ITEM.snape, ITEM.choc), () => q.has(ITEM.cure), 6, 3);
    await q.converse([], () => !q.dialogOpen(), 4);
    await q.talk('bravek 2', /^bravek$/i, [/they won't listen to me/i], () => q.has(ITEM.warrant), BRAVEK, 80);
    q.milestone(27);
    // 12. The warrant opens the plague house door; the barrel gives the key; the stairs down; the key opens Elena's
    // door; Elena (28) (plaguehouse.rs2, elena.rs2).
    await q.openDoor('bravek door out', BRAVEK_DOOR.x, BRAVEK_DOOR.z);
    await q.walk('to plague house 2', [{ x: PLAGUE_DOOR.x, z: PLAGUE_DOOR.z + 1, tol: 1 }]);
    const inHouse = () => (q.pos()?.worldZ ?? 9999) < PLAGUE_DOOR.z && !inSewer();
    // With the warrant the mourner talks for 3 pages, then the door lets the bot in (doors.rs2:23-50).
    for (let i = 0; i < 3 && !inHouse(); i++) {
        await q.guard('plague door 2');
        await q.opLoc(q.locAt(PLAGUE_DOOR.x, PLAGUE_DOOR.z) ?? PLAGUE_DOOR, 1);
        await q.waitUntil(() => q.dialogOpen() || inHouse(), 8);
        await q.converse([], inHouse, 30);
    }
    if (!inHouse()) await q.fail('plague door 2');
    await q.converse([], () => !q.dialogOpen(), 6);
    await q.step('barrel', () => q.opLoc(q.locAt(BARREL.x, BARREL.z) ?? BARREL, 1), () => q.has(ITEM.key), 10, 4);
    await q.converse([], () => !q.dialogOpen(), 6);
    await q.step('cellar', () => q.opLoc(q.locAt(DOWN.x, DOWN.z) ?? DOWN, 1), inSewer, 10, 4);
    await q.step('elena gate', () => q.opLoc(q.locAt(GATE.x, GATE.z) ?? GATE, 1), () => (q.pos()?.worldX ?? 0) > GATE.x, 10, 4);
    await q.converse([], () => !q.dialogOpen(), 6);
    await q.talk('elena', /^elena$/i, [], () => !q.dialogOpen() && q.sawText(/.+/), ELENA, 60);
    q.milestone(28);
    // 13. Back: the gate, the stairs up, the manhole into the sewer, the mud pile to the garden, Edmond queues the
    // completion (edmond.rs2:37-40, manhole.rs2:1-22, mud_pile.rs2:1-5).
    await q.step('elena gate out', () => q.opLoc(q.locAt(GATE.x, GATE.z) ?? GATE, 1), () => (q.pos()?.worldX ?? 9999) <= GATE.x, 10, 4);
    await q.walk('to up stairs', [{ x: UP.x, z: UP.z, tol: 2 }]);
    await q.climb('stairs up 2', () => q.findLoc(l => /stair/i.test(l.name) && l.distance <= 6), /walk-up|climb|up/i, () => !inSewer());
    await q.step('plague door out', () => q.opLoc(q.locAt(PLAGUE_DOOR.x, PLAGUE_DOOR.z) ?? PLAGUE_DOOR, 1), () => !inHouse(), 10, 4);
    await q.walk('to manhole', [{ x: MANHOLE.x, z: MANHOLE.z + 1, tol: 1 }]);
    for (let i = 0; i < 6 && !inSewer(); i++) {
        await q.guard('manhole');
        const m = q.findLoc(l => (l.id === 2543 || l.id === 2544) && l.distance <= 6);
        if (m) await q.opLoc(m, 1);
        await q.waitUntil(inSewer, 6);
    }
    if (!inSewer()) await q.fail('manhole');
    await q.walk('to mud pile', [{ x: MUD_PILE.x - 1, z: MUD_PILE.z, tol: 1 }]);
    await q.step('mud pile', () => q.opLoc(q.locAt(MUD_PILE.x, MUD_PILE.z) ?? MUD_PILE, 1), () => !inSewer(), 10, 4);
    await q.openDoor('house door 3', 2570, 3333);
    await q.openDoor('inner door 3', 2574, 3333);
    await q.talk('edmond 3', edmond, [], () => questDone, EDMOND, 60, true);
    await q.converse([], () => !q.dialogOpen(), 10);
    q.milestone(100);
    off();
    await q.end(questDone, 'qp=1');
} catch (e) { await q.fail(String(e)); }
