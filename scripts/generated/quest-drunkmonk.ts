// Monk's Friend from preset quest_drunkmonk (Ardougne monastery beside Brother Omad; every skill 99; jug of water and
// logs from a helper). Reward: 1 QP, 8 law runes, 2,000 Woodcutting XP before 25x (quest_drunkmonk.rs2:84-89).
// Varp %drunkmonkquest: 0 -> 10 Omad (the hidden ladder's timer starts), 20 blanket, 30 "Where should I look?",
// 40 Cedric, 50 water, 60 "Yes, I'd be happy to!", 70 logs, then Omad's party queues the completion.
// Server truth: areas/area_ardougne_east/scripts/brother_omad.rs2, brother_cedric.rs2,
// quests/quest_drunkmonk/scripts/quest_drunkmonk.rs2, ladders+stairs/scripts/ladders.rs2:104-110.
import { openQuest } from './quest-lib';

const OMAD = { x: 2604, z: 3209 };
const CEDRIC = { x: 2614, z: 3259 };
const RING = { x: 2561, z: 3222 };                         // ^blanket_ladder_coord; the ladder appears within 2 tiles
const DEN_LADDER = { id: 1755, x: 2561, z: 9622 };         // ladder_from_cellar in the thieves' den
const BLANKET = { id: 90, x: 2570, z: 9604 };              // obj in maps/m40_150.jm2 (0 10 4)
const ITEM = { blanket: 90, water: 1937, logs: 1511 };

const q = await openQuest({ cap: 1500 });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const inDen = () => (q.pos()?.worldZ ?? 0) > 9000;
    const omad = /^brother omad$/i;
    const cedric = /^brother cedric$/i;

    // 1. Omad: "Why can't you sleep, what's wrong?", "Can I help at all?" sets 10 (brother_omad.rs2:12-38).
    await q.talk('omad 1', omad, [/why can't you sleep/i, /can i help at all/i], () => q.sawText(/ring of stones/i), OMAD);
    q.milestone(10);

    // 2. The ring of stones west of the monastery: the ladder appears (quest_drunkmonk.rs2:1-6); the den; the blanket
    // room behind the door loc_1530 at 2565,9612.
    await q.openDoor('monastery west door', 2602, 3209);
    await q.walk('to ring', [{ x: RING.x + 1, z: RING.z, tol: 1 }]);
    const ringLadder = () => q.findLoc(l => l.x === RING.x && l.z === RING.z && (l.optionsWithIndex ?? []).some((o: any) => /climb-down/i.test(o.text)));
    await q.waitUntil(() => !!ringLadder(), 6);
    await q.climb('ladder down', () => ringLadder(), /climb-down/i, inDen, 6);
    q.milestone('den');
    await q.dash('den door', 2565, 9613, 0);
    await q.openDoor('den door', 2565, 9612);
    await q.walk('to blanket', [{ x: BLANKET.x, z: BLANKET.z, tol: 1 }]);
    const ground = (): any => (q.st()?.groundItems ?? []).find((g: any) => g.id === ITEM.blanket);
    await q.step('take blanket', () => { const g = ground(); return g ? q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' }) : q.waitTicks(1); }, () => q.has(ITEM.blanket), 10, 5);
    q.milestone('blanket');
    await q.openDoor('den door out', 2565, 9612);
    await q.walk('to den ladder', [{ x: DEN_LADDER.x, z: DEN_LADDER.z - 1, tol: 1 }]);
    await q.climb('ladder up', () => q.locAt(DEN_LADDER.x, DEN_LADDER.z) ?? DEN_LADDER, /climb-up/i, () => !inDen());

    // 3. Omad: the blanket (20), then "Who's Brother Cedric?", "Where should I look?" (30) (brother_omad.rs2:40-84).
    await q.walk('back to omad', [{ x: 2601, z: 3209, tol: 1 }]);
    await q.openDoor('monastery west door 2', 2602, 3209);
    await q.talk('omad 2', omad, [], () => !q.has(ITEM.blanket), OMAD);
    q.milestone(20);
    await q.talk('omad 3', omad, [/who's brother cedric/i, /where should i look/i], () => q.sawText(/i'll go and find him/i), OMAD);
    q.milestone(30);

    // 4. Cedric in the forest: 40; the water (50) runs on into the cart: "Yes, I'd be happy to!" (60); the logs (70).
    await q.openDoor('monastery north door', 2606, 3219);
    await q.walk('to cedric', [{ x: CEDRIC.x, z: CEDRIC.z, tol: 3 }]);
    await q.talk('cedric 1', cedric, [], () => q.sawText(/find me a jug of water/i), CEDRIC);
    q.milestone(40);
    await q.talk('cedric 2', cedric, [/yes, i'd be happy to/i], () => !q.has(ITEM.water) && q.sawText(/i just need some wood/i), CEDRIC, 60);
    q.milestone(60);
    await q.talk('cedric 3', cedric, [], () => !q.has(ITEM.logs), CEDRIC);
    q.milestone(70);

    // 5. Omad: the party (about 15 ticks of p_delay) queues the completion (quest_drunkmonk.rs2:14-42).
    await q.walk('to omad', [{ x: 2606, z: 3220, tol: 1 }]);
    await q.openDoor('monastery north door 2', 2606, 3219);
    // The party closes the dialog and runs about 15 ticks of p_delay; a talk click inside it is rejected, so the bot waits.
    await q.talk('omad 4', omad, [], () => questDone || q.sawText(/let's party/i), OMAD, 80, true);
    await q.converse([], () => questDone, 40);
    q.milestone(100);
    off();
    await q.end(questDone, 'qp=1');
} catch (e) { await q.fail(String(e)); }
