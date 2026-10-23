// Sheep Shearer from preset quest_sheep (inside Fred's farmhouse; every skill 99; 20 balls of wool from a helper).
// Reward: 1 QP, 60 coins, 1,500 Crafting XP before 25x (quest_sheep.rs2). Varp %sheep: 0 -> 1 started, +1 per ball
// given, 20 -> 21 done (queued completion).
// Server truth: areas/area_lumbridge/scripts/fred_the_farmer.rs2 (fred_give_wool gives one ball per p_delay(1),
// with if_close each time), quests/quest_sheep/scripts/quest_sheep.rs2.
import { openQuest } from './quest-lib';

const FRED = { x: 3189, z: 3273 };
const WOOL = 1759;

const q = await openQuest({ cap: 400 });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const fred = /^fred the farmer$/i;

    // 1. "I'm looking for a quest.", "Yes okay. I can do that." sets 1 (fred_yes_okay).
    await q.talk('fred 1', fred, [/looking for a quest/i, /yes okay/i], () => q.sawText(/see you when you have some wool/i), FRED);
    q.milestone(1);

    // 2. The second talk gives the balls one a tick; the dialog closes between them, so the script only clicks pages
    // until the completion message (a new talk inside the loop could break the chain).
    await q.talk('fred 2', fred, [], () => q.cnt(WOOL) < 20 || questDone, FRED, 30, true);
    q.milestone('giving');
    await q.converse([], () => questDone, 60);
    q.milestone(21);
    off();
    await q.waitUntil(() => !q.has(WOOL), 3);
    await q.end(questDone, `qp=1 woolLeft=${q.cnt(WOOL)}`);
} catch (e) { await q.fail(String(e)); }
