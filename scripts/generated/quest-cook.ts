// Cook's Assistant from preset quest_cook or quest_cook_partner (in the Lumbridge castle kitchen beside the cook; an
// egg, a bucket of milk and a pot of flour from a helper). Reward: 1 QP, 7,500 Cooking XP (quest_cook.rs2:87-91).
// Varp %cookquest (29): 0 -> 1 "What's wrong?", "Yes, I'll help you."; 1 -> 2 the hand-in (queued completion).
// Server truth: areas/area_lumbridge/scripts/cook.rs2, quests/quest_cook/scripts/quest_cook.rs2.
import { openQuest } from './quest-lib';

const COOK = { x: 3209, z: 3215 };
const EGG = 1944, MILK = 1927, FLOUR = 1933;

const q = await openQuest({ cap: 300 });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const cook = /^cook$/i;

    // 1. "What's wrong?", "Yes, I'll help you." sets 1 (quest_cook.rs2:1-36).
    await q.talk('cook 1', cook, [/^what's wrong\?$/i, /yes, i'll help you/i], () => q.sawText(/i need milk, an egg and flour/i), COOK);
    q.milestone(1);

    // 2. With the 3 items in the pack the in-progress talk goes to the hand-in and queues the completion (:42-85).
    await q.talk('cook 2', cook, [], () => questDone, COOK, 40, true);
    await q.converse([], () => !q.dialogOpen(), 10);
    q.milestone(2);
    off();
    await q.end(questDone && !q.has(EGG) && !q.has(MILK) && !q.has(FLOUR), 'qp=1');
} catch (e) { await q.fail(String(e)); }
