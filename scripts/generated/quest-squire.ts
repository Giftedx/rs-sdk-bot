// The Knight's Sword from preset quest_squire (beside the squire in Falador castle courtyard; every skill 99; a
// redberry pie, 2 iron bars, a rune pickaxe and runes for a Varrock and two Falador teleports from a helper).
// Reward: 1 QP, 12,725 Smithing XP before 25x (quests/quest_squire/scripts/quest_squire.rs2:220-224).
// Varp %squire: 0 -> 1 the squire, 2 Reldo, 3 the pie to Thurgo, 4 "special sword", 5 the squire (portrait), 6 the
// portrait to Thurgo; the blurite and 2 bars give the sword, the sword to the squire queues the completion.
// The portrait, blurite ore and sword are tradeable=no (quest_squire.obj), so the main account mines the blurite
// (Asgarnian Ice Dungeon, bluriterock 2110 at 3049,9566, maps/m47_149.jm2) and searches Sir Vyvin's cupboard
// (2_46_52_40_8, general_use/scripts/cupboards.rs2:22-30). The blurite is mined on the first Thurgo visit, so the
// second visit hands in the portrait and gets the sword.
import { openQuest } from './quest-lib';

const SQUIRE = { x: 2977, z: 3342 };
const RELDO = { x: 3209, z: 3495 };
const THURGO = { x: 3001, z: 3144 };
const CELLAR_DOWN = { x: 3008, z: 3150 };                  // ladder_cellar_inside_down 1759
const CELLAR_UP = { x: 3008, z: 9550 };                    // ladder_from_cellar 1755
const BLURITE = [{ x: 3049, z: 9566 }, { x: 3059, z: 9564 }, { x: 3067, z: 9581 }, { x: 3067, z: 9582 }];
const TOWER_LADDER = { x: 2994, z: 3341 };                 // ladder 1747 (level 0 -> 1)
const VYVIN_STAIRS = { x: 2984, z: 3337 };                 // stairs 1722 on level 1
const CUPBOARD = { x: 2984, z: 3336 };                     // vyvincupboardshut 2271 / vyvincupboardopen on level 2
const ITEM = { pie: 2325, bar: 2351, portrait: 666, sword: 667, blurite: 668 };

const q = await openQuest({ cap: 3000, reservedFood: { [ITEM.pie]: 1 } });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const squire = /^squire$/i, thurgo = /^thurgo$/i;

    // 1. The squire: "Ok, I'll give it a go." sets 1 (quest_squire.rs2:1-60).
    await q.talk('squire 1', squire, [/how is life as a squire/i, /i can make a new sword/i, /would these dwarves make another/i, /i'll give it a go/i], () => q.sawText(/best place to start should be with reldo/i), SQUIRE, 60);
    q.milestone(1);

    // 2. Varrock teleport, Reldo in the palace library: 2 (reldo.rs2:6-9, quest_squire.rs2:113-123).
    await q.teleport('varrock teleport', 'magic:varrock_teleport', 3212, 3424);
    await q.walk('to reldo', [{ x: 3211, z: 3470, tol: 2 }, { x: RELDO.x + 1, z: RELDO.z, tol: 2 }]);
    await q.talk('reldo', /^reldo$/i, [/imcando dwarves/i], () => q.sawText(/really like redberry pie/i), RELDO, 60);
    q.milestone(2);

    // 3. Falador teleport, the walk to Thurgo's hut on the peninsula: the pie (3), then "special sword" (4)
    // (thurgo.rs2:1-6, quest_squire.rs2:125-161).
    await q.teleport('falador teleport', 'magic:falador_teleport', 2965, 3378);
    await q.walk('to thurgo', [{ x: 3007, z: 3320, tol: 3 }, { x: 3007, z: 3220, tol: 3 }, { x: 3002, z: 3160, tol: 3 }, { x: THURGO.x + 1, z: THURGO.z + 1, tol: 2 }]);
    await q.talk('thurgo pie', thurgo, [/would you like (a|some) redberry pie/i], () => !q.has(ITEM.pie) && q.sawText(/that was good pie/i), THURGO, 40);
    await q.talk('thurgo sword', thurgo, [], () => q.sawText(/bring me a picture or something/i), THURGO, 40);
    q.milestone(4);

    // 4. The ice dungeon under the cliff: one blurite ore (Mining 10, skill_mining/configs/mine.dbrow:164-173).
    await q.walk('to cellar', [{ x: CELLAR_DOWN.x, z: CELLAR_DOWN.z + 1, tol: 1 }]);
    await q.climb('cellar down', () => q.findLoc(l => l.x === CELLAR_DOWN.x && l.z === CELLAR_DOWN.z), /climb-down|climb down/i, () => (q.pos()?.worldZ ?? 0) > 9000);
    await q.walk('to blurite', [{ x: 3030, z: 9560, tol: 3 }, { x: BLURITE[0]!.x + 1, z: BLURITE[0]!.z, tol: 2 }]);
    for (let i = 0; i < 30 && !q.has(ITEM.blurite); i++) {
        await q.guard('blurite');
        const r = q.findLoc(l => l.id === 2110 && l.distance <= 20);
        if (!r) { console.log('WARN no blurite rock'); await q.waitTicks(3); continue; }
        await q.opLoc(r, q.opIndex(r, /mine/i));
        await q.waitUntil(() => q.has(ITEM.blurite), 8);
    }
    if (!q.has(ITEM.blurite)) await q.fail('no blurite');
    q.milestone('blurite');
    await q.walk('to cellar up', [{ x: 3030, z: 9560, tol: 3 }, { x: CELLAR_UP.x + 1, z: CELLAR_UP.z, tol: 1 }]);
    await q.climb('cellar up', () => q.findLoc(l => l.x === CELLAR_UP.x && l.z === CELLAR_UP.z), /climb-up|climb up/i, () => (q.pos()?.worldZ ?? 9999) < 9000);

    // 5. Back to the squire: the portrait is in Vyvin's cupboard (5, quest_squire.rs2:75-78).
    await q.walk('to squire', [{ x: 3007, z: 3220, tol: 3 }, { x: 3007, z: 3320, tol: 3 }, { x: SQUIRE.x + 1, z: SQUIRE.z, tol: 2 }]);
    await q.talk('squire 2', squire, [], () => q.sawText(/keeps it in a cupboard in his room/i), SQUIRE, 40);
    q.milestone(5);

    // 6. Vyvin's room: the tower ladder to level 1, the stairs to level 2, the cupboard. Vyvin within 1 tile stops
    // the search (quest_squire.rs2:209-217), so the bot searches only when he stands further off.
    await q.walk('to tower ladder', [{ x: TOWER_LADDER.x, z: TOWER_LADDER.z - 1, tol: 1 }]);
    await q.climb('tower ladder', () => q.findLoc(l => l.x === TOWER_LADDER.x && l.z === TOWER_LADDER.z), /climb-up|climb up/i, () => q.lvl() === 1);
    await q.walk('to vyvin stairs', [{ x: VYVIN_STAIRS.x + 1, z: VYVIN_STAIRS.z, tol: 1 }]);
    await q.climb('vyvin stairs', () => q.findLoc(l => l.x === VYVIN_STAIRS.x && l.z === VYVIN_STAIRS.z), /climb-up|climb up|^climb$/i, () => q.lvl() === 2);
    // Vyvin's room is south of the stairs behind the door loc_1530 at 2982,3337 (maps/m46_52.jm2); shut, the search gets
    // "I can't reach that!".
    await q.openDoor('vyvin door', 2982, 3337);
    for (let i = 0; i < 40 && !q.has(ITEM.portrait); i++) {
        await q.guard('cupboard');
        if (q.dialogOpen()) { await q.converse([], () => !q.dialogOpen(), 6); continue; }
        const v = q.npc(/^sir vyvin$/i);
        if (v && q.cheb(v.x, v.z) <= 2) { await q.waitTicks(1); continue; }
        const c = q.findLoc(l => l.x === CUPBOARD.x && l.z === CUPBOARD.z && /cupboard/i.test(l.name));
        if (!c) { await q.waitTicks(1); continue; }
        const search = (c.optionsWithIndex ?? []).some((o: any) => /search/i.test(o.text));
        await q.opLoc(c, q.opIndex(c, search ? /search/i : /open/i));
        await q.waitUntil(() => q.has(ITEM.portrait) || q.dialogOpen(), 6);
    }
    await q.converse([], () => !q.dialogOpen(), 6);
    if (!q.has(ITEM.portrait)) await q.fail('no portrait');
    q.milestone('portrait');
    await q.openDoor('vyvin door out', 2982, 3337);
    await q.climb('vyvin stairs down', () => q.findLoc(l => /stair/i.test(l.name) && l.distance <= 6), /climb-down|climb down|^climb$/i, () => q.lvl() === 1);
    await q.walk('to tower ladder 1', [{ x: TOWER_LADDER.x, z: TOWER_LADDER.z - 1, tol: 1 }]);
    await q.climb('tower ladder down', () => q.findLoc(l => l.x === TOWER_LADDER.x && l.z === TOWER_LADDER.z), /climb-down|climb down/i, () => q.lvl() === 0);

    // 7. Thurgo: the portrait (6), then the blurite and 2 iron bars give the sword (quest_squire.rs2:163-207).
    await q.walk('to thurgo 2', [{ x: 3007, z: 3320, tol: 3 }, { x: 3007, z: 3220, tol: 3 }, { x: 3002, z: 3160, tol: 3 }, { x: THURGO.x + 1, z: THURGO.z + 1, tol: 2 }]);
    await q.talk('thurgo portrait', thurgo, [], () => !q.has(ITEM.portrait), THURGO, 60);
    await q.talk('thurgo make', thurgo, [], () => q.has(ITEM.sword), THURGO, 40);
    q.milestone(6);

    // 8. Falador teleport, the sword to the squire queues the completion (quest_squire.rs2:94-104).
    await q.teleport('falador teleport 2', 'magic:falador_teleport', 2965, 3378);
    await q.walk('to squire 3', [{ x: SQUIRE.x + 1, z: SQUIRE.z, tol: 2 }]);
    await q.talk('squire 3', squire, [], () => questDone, SQUIRE, 40, true);
    await q.converse([], () => !q.dialogOpen(), 10);
    q.milestone(100);
    off();
    await q.end(questDone, 'qp=1');
} catch (e) { await q.fail(String(e)); }
