// Druidic Ritual from preset quest_druid (beside Kaqemeex, Haggis at the qp-filler row: every skill 99, rune set,
// 4 raw meats from a helper). Reward at 25x: 6,250 Herblore XP (quest_druid.rs2:3 stat_advance(herblore, 2500)),
// 4 QP (quest.constant druid_questpoints). Varp %druidquest (80): 0 -> 1 Kaqemeex, 2 Sanfew, 3 meats handed in, 4 done.
// Server truth: areas/area_taverly/scripts/kaqemeex.rs2, sanfew.rs2, dungeon/scripts/prison_doors.rs2,
// quests/quest_druid/scripts/quest_druid.rs2. Locs from maps m45_53, m45_54, m45_153 (.jm2).
// DRUID_FROM=<%druidquest> starts at that stage. On a started journal the quest sweep reads the stage from the journal
// (packages/workers/src/quest/resume.ts druidJournalStage); a direct run with no stage reads the journal itself.
// Kaqemeex at 1-2 says only "speak to my fellow druid Sanfew" (kaqemeex.rs2:6-8), so a restart at step 1 cannot pass.
import { questFlags } from '../../packages/core/src/quest-status';
import { druidJournalStage } from '../../packages/workers/src/quest/resume';
import { openQuest, readQuestJournalStage } from './quest-lib';

const KAQEMEEX = { x: 2924, z: 3486 };
const SANFEW = { x: 2897, z: 3426 };                         // level 1
const STAIRS = { id: 1738, x: 2898, z: 3428 };               // spiralstairs (level 0); top 1740 on level 1
const STAIRS_TOP = { id: 1740, x: 2898, z: 3428 };
const LADDER_DOWN = { id: 1759, x: 2884, z: 3397 };          // ladder_cellar_inside_down, to 2884,9797
const LADDER_UP = { id: 1755, x: 2884, z: 9797 };            // ladder_from_cellar
const DOOR = { id: 2143, x: 2889, z: 9831 };                 // cauldrondoor (2144 cauldrondoor_l at 2889,9830)
const CAULDRON = { id: 2142, x: 2893, z: 9831 };             // cauldron_of_thunder
const RAW = [2132, 2134, 2136, 2138];                        // beef, rat, bear, chicken
const ENCH = [522, 523, 524, 525];

const q = await openQuest({ cap: 1500 });
try {
    const herb0 = q.xp('Herblore');
    const inDungeon = () => (q.pos()?.worldZ ?? 0) > 9000;
    const inside = () => inDungeon() && (q.pos()?.worldX ?? 0) >= 2889;
    const stage = async (): Promise<number> => {
        if (process.env.DRUID_FROM !== undefined || (q.s as { questFrom?: number }).questFrom !== undefined) return q.stageFrom('DRUID_FROM');
        const flag = () => questFlags((q.s as any).client)?.find(f => f.name === 'Druidic Ritual')?.state ?? 'unknown';
        await q.waitUntil(() => flag() !== 'unknown', 20);
        if (flag() === 'complete') return 4;
        if (flag() !== 'started') return 0;
        return readQuestJournalStage(q, 'druid', /Druidic Ritual/i, druidJournalStage);
    };
    const FROM = await stage();
    console.log(`DRUID_FROM ${FROM}`);
    if (FROM >= 4) await q.fail('refused: Druidic Ritual is complete');
    // Each meat goes in the cauldron raw: a meat that is neither raw nor enchanted in the pack ends the run here, not
    // in the cauldron room (live "fail step dip 2132" after a 290-tick walk with no meats).
    const missing = RAW.filter((id, k) => !q.has(id) && !q.has(ENCH[k]!));
    if (FROM < 3 && missing.length) await q.fail(`missing raw meats ${missing.join(',')}`);
    // The SDK route from the circle runs through the Witch's House front door (witchhousedoor 2861 at 2901,3473), which is locked.
    if (!q.blockDoor(0, 2901, 3473)) console.log('WARN witch house door not blocked');

    // 1. Kaqemeex: "I'm in search of a quest.", "Ok, I will try and help." sets 1 (kaqemeex.rs2 druid_agree_to_help).
    if (FROM < 1) {
        await q.talk('kaqemeex 1', /^kaqemeex$/i, [/search of a quest/i, /will try and help/i], () => q.sawText(/speak to my fellow sanfew|go to the village south/i), KAQEMEEX);
        q.milestone(1);
    }

    // 2. Sanfew upstairs: "I've been sent to help purify...", "Ok, I'll do that then." sets 2 (sanfew.rs2).
    if (FROM < 2) {
        await q.walk('to sanfew stairs', [{ x: STAIRS.x, z: STAIRS.z - 1, tol: 1 }]);
        await q.climb('stairs up', () => q.locAt(STAIRS.x, STAIRS.z), /climb-up/i, () => q.lvl() === 1);
        await q.talk('sanfew 1', /^sanfew$/i, [/sent to help purify/i, /i'll do that then/i], () => q.sawText(/well thank you very much|ok, i'll do that then/i), SANFEW);
        q.milestone(2);
    }

    // 3. Taverley dungeon: the prison door wakes the two suits of armour on the first two opens from the west, the
    // third lets the player through (prison_doors.rs2). Each meat is dipped in the cauldron. A resumed run can start in
    // the dungeon or the cauldron room, and with some meats already enchanted.
    if (FROM < 3) {
        if (q.lvl() === 1) await q.climb('stairs down', () => q.locAt(STAIRS_TOP.x, STAIRS_TOP.z), /climb-down/i, () => q.lvl() === 0);
        if (!inDungeon()) {
            await q.walk('to dungeon ladder', [{ x: LADDER_DOWN.x + 1, z: LADDER_DOWN.z + 1, tol: 1 }]);
            await q.climb('ladder down', () => q.locAt(LADDER_DOWN.x, LADDER_DOWN.z), /climb-down/i, inDungeon);
        }
        q.milestone('dungeon');
        if (!inside()) await q.walk('to prison door', [{ x: DOOR.x - 1, z: DOOR.z, tol: 0 }]);
        for (let i = 0; i < 12 && !inside(); i++) {
            await q.guard('prison door');
            const wakes0 = q.msgCount(/comes to life/i);
            const d = q.findLoc(l => (l.id === 2143 || l.id === 2144) && l.x === DOOR.x);
            await q.opLoc(d ?? DOOR, q.opIndex(d, /open/i));
            await q.waitUntil(() => inside() || q.msgCount(/comes to life/i) > wakes0, 6);
        }
        if (!inside()) await q.fail('prison door');
        q.milestone('door');
        for (let k = 0; k < RAW.length; k++) {
            if (q.has(ENCH[k]!)) continue;
            await q.step(`dip ${RAW[k]}`, () => q.useOnLoc(RAW[k]!, CAULDRON), () => q.has(ENCH[k]!), 6, 5);
        }
        q.milestone('meats');

        // 4. Out through the door (one open from inside), up the ladder, back to Sanfew: the meats set 3.
        for (let i = 0; i < 6 && inside(); i++) {
            await q.guard('door out');
            const d = q.findLoc(l => (l.id === 2143 || l.id === 2144) && l.x === DOOR.x);
            await q.opLoc(d ?? DOOR, q.opIndex(d, /open/i));
            await q.waitUntil(() => !inside(), 6);
        }
        if (inside()) await q.fail('door out');
        await q.walk('to ladder up', [{ x: LADDER_UP.x, z: LADDER_UP.z + 1, tol: 1 }]);
        await q.climb('ladder up', () => q.locAt(LADDER_UP.x, LADDER_UP.z), /climb-up/i, () => !inDungeon());
        await q.walk('back to sanfew stairs', [{ x: STAIRS.x, z: STAIRS.z - 1, tol: 1 }]);
        await q.climb('stairs up 2', () => q.locAt(STAIRS.x, STAIRS.z), /climb-up/i, () => q.lvl() === 1);
        await q.talk('sanfew 2', /^sanfew$/i, [], () => ENCH.every(id => !q.has(id)), SANFEW);
        q.milestone(3);
        await q.climb('stairs down 2', () => q.locAt(STAIRS_TOP.x, STAIRS_TOP.z), /climb-down/i, () => q.lvl() === 0);
    }

    // 5. Kaqemeex: the completion is queued (kaqemeex.rs2 druid_completion, quest_druid.rs2).
    await q.walk('back to kaqemeex', [{ x: KAQEMEEX.x, z: KAQEMEEX.z - 1, tol: 3 }]);
    const rewarded = () => q.xp('Herblore') - herb0 >= 6_250;
    await q.talk('kaqemeex 2', /^kaqemeex$/i, [], () => rewarded(), KAQEMEEX, 30, true);
    q.milestone(4);
    // The queued 14-page Herblore lesson is not needed: close it so the next quest starts clean.
    await q.s.direct({ type: 'closeModal', reason: 'SDK' });
    await q.end(rewarded(), `herbloreXp=${q.xp('Herblore') - herb0}`);
} catch (e) { await q.fail(String(e)); }
