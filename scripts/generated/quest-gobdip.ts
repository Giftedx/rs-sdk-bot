// Goblin Diplomacy from preset quest_gobdip (beside the Rusty Anchor bartender in Port Sarim; Haggis at the qp-filler
// row: every skill 99, rune set; 3 goblin mail, orange and blue dye, Falador teleport runes from a helper).
// Reward at 25x: 5,000 Crafting XP and a gold bar (quest_gobdip.rs2 stat_advance(crafting, 2000)), 5 QP.
// Varp %goblinquest: 0 -> 1 bartender, 2 orange asked, 3 orange given, 4 blue given, 5 brown given, 6 done.
// Server truth: areas/area_port_sarim/scripts/bartender.rs2, areas/area_falador/scripts/goblin_village/
// general_wartface.rs2, quests/quest_gobdip/scripts/quest_gobdip.rs2 and goblin_mail.rs2 (a dye on a mail, no delay).
import { openQuest } from './quest-lib';

const BARTENDER = { x: 3045, z: 3257 };
const WARTFACE = { x: 2957, z: 3511 };
const ITEM = { mail: 288, orange: 286, blue: 287, orangeDye: 1769, blueDye: 1767 };

const q = await openQuest({ cap: 1500 });
try {
    const craft0 = q.xp('Crafting');

    // 1. Bartender: "Not very busy in here today, is it?" sets 1.
    await q.talk('bartender', /^bartender$/i, [/not very busy/i], () => q.sawText(/knock some sense|full blown war/i), BARTENDER);
    q.milestone(1);

    // 2. Both dyes, one a tick: each turns a plain mail into the dyed one.
    await q.step('orange dye', () => q.useOnItem(ITEM.orangeDye, ITEM.mail), () => q.has(ITEM.orange), 3, 4);
    await q.step('blue dye', () => q.useOnItem(ITEM.blueDye, ITEM.mail), () => q.has(ITEM.blue), 3, 4);
    q.milestone('dyed');

    // 3. Falador teleport (2965,3378), then the run north to the generals.
    await q.teleport('falador teleport', 'magic:falador_teleport', 2965, 3378);
    await q.walk('to generals', [{ x: WARTFACE.x, z: WARTFACE.z - 2, tol: 2 }]);
    // The generals' hut has a shut double door in its south wall (loc 1516 at 2957,3509 and 1519 at 2958,3509,
    // maps/m46_54.jm2). Shut, the client cannot route a talk to Wartface and the click does nothing (3 of 3 talks
    // failed so); the SDK plan treats it as open.
    await q.openDoor('hut door', 2957, 3509);
    await q.openDoor('hut door r', 2958, 3509);
    q.milestone('village');

    // 4. Wartface four times: orange asked (2), orange (3), blue (4), plain mail (5 -> 6, the reward queued).
    const ww = /^general wartface$/i;
    await q.talk('wartface 1', ww, [/pick an armour colour/i], () => q.sawText(/bring us orange armour|orange might be good/i), WARTFACE);
    q.milestone(2);
    await q.talk('wartface 2', ww, [], () => !q.has(ITEM.orange), WARTFACE);
    q.milestone(3);
    await q.talk('wartface 3', ww, [], () => !q.has(ITEM.blue), WARTFACE);
    q.milestone(4);
    const rewarded = () => q.xp('Crafting') - craft0 >= 5_000;
    await q.talk('wartface 4', ww, [], rewarded, WARTFACE, 40, true);
    q.milestone(6);
    await q.end(rewarded(), `craftingXp=${q.xp('Crafting') - craft0}`);
} catch (e) { await q.fail(String(e)); }
