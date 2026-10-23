// Imp Catcher from preset quest_imp (top floor of the Wizards' Tower beside Wizard Mizgog; every skill 99; the four
// beads from a helper). Reward: 1 QP, amulet of accuracy, 875 Magic XP before 25x (quest_imp.rs2).
// Varp %imp: 0 -> 1 "Give me a quest!", "Give me a quest please.", 1 -> 2 the hand-in (queued completion).
// Server truth: areas/area_wizard_tower/scripts/wizard_mizgog.rs2, quests/quest_imp/scripts/quest_imp.rs2.
import { openQuest } from './quest-lib';

const MIZGOG = { x: 3103, z: 3163 };
const BEADS = [1470, 1472, 1474, 1476];

const q = await openQuest({ cap: 400 });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const miz = /^wizard mizgog$/i;

    // 1. Start (wizard_mizgog.rs2:39-52).
    await q.talk('mizgog 1', miz, [/^give me a quest!$/i, /give me a quest please/i], () => q.sawText(/get my beads back/i), MIZGOG);
    q.milestone(1);

    // 2. The hand-in (wizard_mizgog.rs2:6-19) queues the completion.
    await q.talk('mizgog 2', miz, [], () => questDone, MIZGOG, 40, true);
    await q.converse([], () => !q.dialogOpen(), 10);
    q.milestone(2);
    off();
    await q.end(questDone && BEADS.every(b => !q.has(b)), 'qp=1');
} catch (e) { await q.fail(String(e)); }
