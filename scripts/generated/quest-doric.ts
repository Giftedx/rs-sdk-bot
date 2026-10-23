// Doric's Quest from preset quest_doric (inside Doric's house north of Falador; every skill 99; 6 clay, 4 copper ore,
// 2 iron ore from a helper). Reward: 1 QP, 180 coins, 1,300 Mining XP before 25x (quest_doric.rs2:97-101).
// Varp %doricquest: 0 -> 10 "Yes, I will get you materials.", 10 -> 100 the hand-in (queued completion).
// Server truth: quests/quest_doric/scripts/quest_doric.rs2.
import { openQuest } from './quest-lib';

const DORIC = { x: 2952, z: 3451 };

const q = await openQuest({ cap: 400 });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const doric = /^doric$/i;

    // 1. "I wanted to use your anvils.", "Yes, I will get you materials." sets 10 (quest_doric.rs2:36-62).
    await q.talk('doric 1', doric, [/wanted to use your anvils/i, /yes, i will get you materials/i], () => q.sawText(/certainly, i will get them|6 clay, and 4 copper/i), DORIC);
    q.milestone(10);

    // 2. The hand-in removes the ores and queues the completion (quest_doric.rs2:68-84).
    await q.talk('doric 2', doric, [], () => questDone, DORIC, 40, true);
    await q.converse([], () => !q.dialogOpen(), 10);
    q.milestone(100);
    off();
    await q.end(questDone && !q.has(434), 'qp=1');
} catch (e) { await q.fail(String(e)); }
