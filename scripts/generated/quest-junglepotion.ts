// Jungle Potion from preset quest_junglepotion (Trufitus's hut, Tai Bwo Wannai; every skill 99; Druidic Ritual done).
// Reward: 1 QP, 775 Herblore XP before 25x (quest_junglepotion.rs2:79-84).
// Varp %junglepotion (175): Trufitus sets 1 (trufitus.rs2:273-283); each herb is found only at its own stage
// (get 1/3/5/7/9 -> found 2/4/6/8/10, quest_junglepotion.rs2:51-75), identified (Herblore), and given to Trufitus
// (trufitus.rs2:361-397), which sets the next get stage; 11 after the Rogues purse; the last talk queues completion
// (:421-423). The herbs cannot come from a helper: a herb picked before its stage leaves the stage unchanged.
import { openQuest } from './quest-lib';

const TRUFITUS = { x: 2809, z: 3086 };
const POTHOLE = { id: 2584, x: 2824, z: 3118 };            // pothole_cave_entrance, jump to 2830,9520
const ROCKS_OUT = { id: 2585, x: 2830, z: 9522 };          // jp_caverocksout, jump to 2823,3120
// [label, full loc id, a spot, unidentified id, clean id, Trufitus's "Greetings" line]
const HERBS: Array<[string, number, { x: number; z: number }, number, number]> = [
    ['snake weed', 2575, { x: 2760, z: 3014 }, 1525, 1526],   // marshy jungle vine (maps/m43_47.jm2)
    ['ardrigal', 2577, { x: 2870, z: 3115 }, 1527, 1528],     // palm tree (m44_48)
    ['sito foil', 2579, { x: 2789, z: 3047 }, 1529, 1530],    // scorched earth (m43_47)
    ['volencia moss', 2581, { x: 2851, z: 3035 }, 1531, 1532], // rock (m44_47)
    ['rogues purse', 2583, { x: 2869, z: 9517 }, 1533, 1534], // fungus covered cavern wall (m44_148)
];

const q = await openQuest({ cap: 3000 });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const z = () => q.pos()?.worldZ ?? 0;
    const truf = /^trufitus$/i;

    // 1. Trufitus: "It's a nice village, where is everyone?", "Me? How can I help?", "It sounds like just the challenge"
    // sets 1 (trufitus.rs2:233-309).
    await q.talk('trufitus start', truf, [/where is everyone/i, /me\? how can i help/i, /just the challenge for me/i],
        () => q.sawText(/snake weed/i), TRUFITUS, 120);
    q.milestone(1);

    for (const [i, [label, locId, spot, unid, clean]] of HERBS.entries()) {
        const cave = locId === 2583;
        if (cave) {
            // The caverns to the north: Search the rocks, "Yes, I'll enter the cave." (quest_junglepotion.rs2:43-52).
            await q.walk('to pothole', [{ x: POTHOLE.x, z: POTHOLE.z + 2, tol: 2 }]);
            await q.step('enter cave', () => q.opLoc(POTHOLE, 2), () => q.dialogOpen() || z() > 9000, 8, 4);
            await q.converse([/yes, i'll enter the cave/i], () => z() > 9000, 20);
            if (z() < 9000) await q.fail('enter cave');
        }
        await q.walk(`to ${label}`, [{ x: spot.x, z: spot.z, tol: 3 }]);
        // Search the nearest full loc (the picked one turns empty for 100 ticks, :67-72).
        const full = () => q.findLoc(l => l.id === locId);
        await q.step(`search ${label}`, () => { const l = full(); return l ? q.opLoc(l, 2) : q.waitTicks(1); }, () => q.has(unid), 12, 5);
        await q.converse([], () => !q.dialogOpen(), 4);
        await q.step(`identify ${label}`, () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(unid)!, optionIndex: 1, reason: 'SDK' }), () => q.has(clean), 4, 4);
        q.milestone(2 * i + 2);
        if (cave) {
            await q.walk('to cave exit', [{ x: ROCKS_OUT.x + 1, z: ROCKS_OUT.z, tol: 1 }]);
            await q.step('leave cave', () => q.opLoc(ROCKS_OUT, 1), () => z() < 9000, 10, 4);
        }
        // Trufitus: "Of course!" takes the clean herb and names the next one (trufitus.rs2:311-397).
        await q.talk(`give ${label}`, truf, [/^of course/i], () => !q.has(clean), TRUFITUS, 80);
        q.milestone(2 * i + 3);
    }

    // 2. All 5 herbs given (11): the last talk queues the completion (trufitus.rs2:421-423).
    await q.talk('trufitus end', truf, [], () => questDone, TRUFITUS, 40);
    q.milestone(100);
    off();
    await q.end(questDone, 'qp=1');
} catch (e) { await q.fail(String(e)); }
