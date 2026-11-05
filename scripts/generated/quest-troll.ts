// Troll Stronghold from preset quest_troll (beside Denulth, Burthorpe; every skill 99; Death Plateau done; the rune set,
// a rune kiteshield and climbing boots worn; 20 sharks). Reward: 1 QP and the law talisman, no XP (quest_troll.rs2:
// 364-369; general/scripts/quests.rs2:269-271).
// %troll_quest (varp 317, quest_troll.constant): Denulth 10 (death_ig_commander.rs2:62-86), Dad below 20 hp 20
// (troll_champion.rs2:114-140), the prison door with the general's key 30 (quest_troll.rs2:222-233), Godric's cell 40
// (:303-308); Dunstan completes it (death_smithy.rs2:1-8). Eadgar's cell sets %troll_varbit bit 0 (:332-337), which
// Eadgar's Ruse needs to reach Eadgar's cave top (:129-131), so the bot frees him too (about 10 ticks).
// Every Agility roll here is stat_random(agility, >=160, >=253) on 256 and the pickpocket roll stat_random(thieving, 60,
// 300), so at level 99 a climb fails at most 1 time in 256 and a pickpocket never fails.
// Server truth: quests/quest_troll/scripts/*.rs2, quests/quest_death/scripts/death_ig_commander.rs2, death_smithy.rs2.
// TS_FROM=<stage> starts at a debug preset (packages/practice/src/presets-long.ts).
import { openQuest } from './quest-lib';

const ITEM = { keyPrison: 3135, keyGodric: 3136, keyEadgar: 3137, talisman: 1458 };
const DENULTH = { x: 2896, z: 3528 };
const DUNSTAN = { x: 2919, z: 3574 };
const DEATH_ROCKS_BOTTOM = { id: 3723, x: 2880, z: 3594 };  // death_climbingrocks_bottom: 2880,3593 -> 2880,3596
const DEATH_ROCKS_TOP = { id: 3722, x: 2880, z: 3595 };     // death_climbingrocks_top: 2880,3596 -> 2880,3593
const ROCKS_S = { id: 3748, x: 2856, z: 3612 };             // troll_climbingrocks (rockslide): 3611 <-> 3613
const ROCKS_TOP = { id: 3790, x: 2859, z: 3626 };           // troll_climbingrocks_top: 2858 -> 2861 (x)
const ROCKS_BOTTOM = { id: 3791, x: 2878, z: 3622 };        // troll_climbingrocks_bottom: 2877 -> 2880 (x)
const ROCKS_BACK = { id: 3748, x: 2833, z: 3628 };          // troll_climbingrocks: 3629 -> 3627
const ARENA_IN = { id: 3782, x: 2897, z: 3618 };            // troll_stronghold_arena_entrance_left (west wall)
const ARENA_OUT = { id: 3785, x: 2916, z: 3629 };           // troll_stronghold_arena_exit_left (north wall)
const PASS_IN = { id: 3757, x: 2903, z: 3644 };             // troll_pass_entrance -> 2907,10019
const PASS_OUT = { id: 3758, x: 2906, z: 10036 };           // troll_pass_exit -> 2908,3654
const SH_DOOR = { id: 3771, x: 2839, z: 3689 };             // troll_stronghold_door -> 2837,10090 level 2
const STAIRS_L2 = { id: 3789, x: 2843, z: 10108 };          // stairstop, level 2 -> 2841,10108 level 1
const PRISON_DOOR = { id: 3780, x: 2848, z: 10107 };        // level 1, west wall
const STAIRS_L1 = { id: 3789, x: 2852, z: 10107 };          // stairstop, level 1 -> 2852,10105 level 0
const GENERAL_HALL = { x: 2826, z: 10086 };                 // level 2 west hall; generals spawn at 2831,10086 2822,10073 2829,10100
const CELL_GODRIC = { id: 3767, x: 2832, z: 10078 };
const CELL_EADGAR = { id: 3765, x: 2832, z: 10082 };
const BACK_EXIT = { id: 3761, x: 2823, z: 10048 };          // troll_stronghold_exit -> 2827,3646

const FROM = process.env.TS_FROM ?? 'start';
const STAGES = ['start', 'arena', 'inside', 'back'];
const from = (s: string) => STAGES.indexOf(FROM) <= STAGES.indexOf(s);

const q = await openQuest({ cap: 4000, eatAt: 50, food: [385] });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const x = () => q.pos()?.worldX ?? 0;
    const z = () => q.pos()?.worldZ ?? 0;
    const loc = (l: { id: number; x: number; z: number }) => q.locAt(l.x, l.z) ?? q.findLoc((k: any) => k.id === l.id && Math.abs(k.x - l.x) <= 1 && Math.abs(k.z - l.z) <= 1) ?? l;
    // A game message at or after tick t (the buffer is capped, so a count of matches can stay flat).
    const msgSince = (re: RegExp, t: number) => (q.st()?.gameMessages ?? []).some((m: any) => m.type === 0 && m.tick >= t && re.test(m.text));
    const closeDlg = async () => { if (q.dialogOpen()) await q.converse([], () => !q.dialogOpen(), 12); };
    const op = async (label: string, l: { id: number; x: number; z: number }, done: () => boolean, ticks = 15, tries = 5) => {
        await q.step(label, async () => { if (q.dialogOpen()) await closeDlg(); return q.opLoc(loc(l), 1); }, done, ticks, tries);
        await q.waitTicks(1);
    };
    const PFM = 14;
    const pfm = async (on: boolean) => {
        const p: any = q.st()?.prayers;
        if (!!p?.activePrayers?.[PFM] === on || (on && (p?.prayerPoints ?? 0) <= 0)) return;
        await q.step(`pfm ${on}`, () => q.s.direct({ type: 'togglePrayer', prayerIndex: PFM, reason: 'SDK' }), () => !!(q.st() as any)?.prayers?.activePrayers?.[PFM] === on, 3, 3);
    };
    const pickup = async (label: string, id: number) => {
        for (let i = 0; i < 20 && !q.has(id); i++) {
            await q.guard(label);
            const g = (q.st()?.groundItems ?? []).filter((o: any) => o.id === id).sort((a: any, b: any) => a.distance - b.distance)[0];
            if (g && i % 3 === 0) await q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: id, reason: 'SDK' });
            await q.waitTicks(1);
        }
        if (!q.has(id)) await q.fail(`pickup ${label}`);
    };
    // Attacks the NPC (re) until done(); the attack is sent again every 6 ticks (auto retaliate is off, a meal or Dad's
    // knock-back stops it, troll_champion.rs2:42-82).
    // The NPC list covers about 15 tiles: a route that leaves it (the stronghold door to the west hall goes south by
    // 2839,10057, 29 tiles from the generals) ends with no target, so the bot walks back to `home`.
    const fight = async (label: string, re: RegExp, done: () => boolean, maxTicks: number, home?: { x: number; z: number }) => {
        const t1 = q.T();
        while (!done() && q.T() - t1 < maxTicks) {
            await q.guard(label);
            if (q.dialogOpen()) { await closeDlg(); continue; }
            const n = q.npc(re);
            if (!n) { if (home) await q.walk(`${label} home`, [{ ...home, tol: 4 }]); else await q.waitTicks(2); continue; }
            await q.s.bot.attack(n as any);
            await q.waitUntil(() => done() || q.dialogOpen(), 6);
        }
        if (!done()) await q.fail(`fight ${label}`);
    };
    const pickpocket = async (label: string, re: RegExp, key: number) => {
        for (let i = 0; i < 6 && !q.has(key); i++) {
            await q.guard(label);
            const n = q.npc(re);
            if (!n) { await q.waitTicks(2); continue; }
            const opi = (n.optionsWithIndex ?? []).find((o: any) => /pickpocket/i.test(o.text))?.opIndex ?? 3;
            await q.s.direct({ type: 'interactNpc', npcIndex: n.index, optionIndex: opi, reason: 'SDK' });
            await q.waitUntil(() => q.has(key), 8);
        }
        if (!q.has(key)) await q.fail(`pickpocket ${label}`);
    };

    if (from('start')) {
        // 1. Denulth: "How goes your fight with the trolls?", "Is there anything I can do to help?", "I'll get Godric
        // back!" sets 10 (death_ig_commander.rs2:62-86).
        await q.talk('denulth', /^denulth$/i, [/how goes your fight with the trolls/i, /anything i can do to help/i, /i'll get godric back/i], () => q.sawText(/god speed friend/i), DENULTH, 80);
        q.milestone(10);
        // 2. North: the Death Plateau rocks (boots worn), west to the troll rocks, then the two climbs east to the
        // arena's west side.
        await q.walk('to death rocks', [{ x: DEATH_ROCKS_BOTTOM.x, z: DEATH_ROCKS_BOTTOM.z - 1, tol: 0 }]);
        await op('death rocks up', DEATH_ROCKS_BOTTOM, () => z() >= 3596);
        await q.walk('to troll rocks', [{ x: ROCKS_S.x, z: ROCKS_S.z - 1, tol: 0 }]);
        await op('troll rocks', ROCKS_S, () => z() >= 3613);
        await q.walk('to rocks top', [{ x: ROCKS_TOP.x - 1, z: ROCKS_TOP.z, tol: 0 }]);
        await op('rocks top', ROCKS_TOP, () => x() >= 2861);
        await q.walk('to rocks bottom', [{ x: ROCKS_BOTTOM.x - 1, z: ROCKS_BOTTOM.z, tol: 0 }]);
        await op('rocks bottom', ROCKS_BOTTOM, () => x() >= 2880);
        q.milestone('climbs');
    }
    if (from('arena')) {
        // 3. The arena door, then Dad (level 101): below 20 hp he gives up and "I'll be going now." (20).
        await q.walk('to arena door', [{ x: ARENA_IN.x - 1, z: ARENA_IN.z, tol: 0 }]);
        await op('arena door', ARENA_IN, () => x() >= ARENA_IN.x);
        await closeDlg();
        await pfm(true);
        await fight('dad', /^dad$/i, () => q.sawText(/stop! you win/i), 400);
        await q.converse([/i'll be going now/i], () => !q.dialogOpen(), 12);
        await pfm(false);
        q.milestone(20);
        // 4. The arena's north door, the troll pass under the mountain, the stronghold door.
        await q.walk('to arena exit', [{ x: ARENA_OUT.x, z: ARENA_OUT.z - 1, tol: 0 }]);
        await op('arena exit', ARENA_OUT, () => z() >= ARENA_OUT.z);
        await q.walk('to pass', [{ x: PASS_IN.x, z: PASS_IN.z - 1, tol: 1 }]);
        await op('pass in', PASS_IN, () => z() > 9000);
        await q.walk('through pass', [{ x: PASS_OUT.x, z: PASS_OUT.z - 1, tol: 1 }]);
        await op('pass out', PASS_OUT, () => z() > 3600 && z() < 4000);
        await q.walk('to stronghold door', [{ x: SH_DOOR.x + 2, z: SH_DOOR.z, tol: 1 }]);
        await op('stronghold door', SH_DOOR, () => z() > 10000 && q.lvl() === 2);
        q.milestone('inside');
    }
    if (from('inside')) {
        // 5. A Troll General (level 113) drops the prison key while %troll_quest < 30 (drop tables/scripts/
        // troll_commander.rs2:1-7); Protect from Melee for the fight.
        await q.walk('to general hall', [{ ...GENERAL_HALL, tol: 4 }]);
        await pfm(true);
        await fight('general', /^troll general$/i, () => (q.st()?.groundItems ?? []).some((g: any) => g.id === ITEM.keyPrison) || q.has(ITEM.keyPrison), 500, GENERAL_HALL);
        await pickup('prison key', ITEM.keyPrison);
        await q.walk('to stairs l2', [{ x: STAIRS_L2.x, z: STAIRS_L2.z - 1, tol: 1 }]);
        await op('stairs l2', STAIRS_L2, () => q.lvl() === 1);
        await q.walk('to prison door', [{ x: PRISON_DOOR.x - 1, z: PRISON_DOOR.z, tol: 0 }]);
        await op('prison door', PRISON_DOOR, () => x() >= PRISON_DOOR.x + 1 || x() === PRISON_DOOR.x);
        q.milestone(30);
        await op('stairs l1', STAIRS_L1, () => q.lvl() === 0);
        // 6. Twig and Berry hold the cell keys (troll_stronghold_camp_guard.rs2:41-75); Godric's cell (40), Eadgar's.
        await q.walk('to cells', [{ x: 2833, z: 10080, tol: 2 }]);
        await pickpocket('twig', /^twig$/i, ITEM.keyGodric);
        await pickpocket('berry', /^berry$/i, ITEM.keyEadgar);
        await pfm(false);
        let t0 = q.s.tick();
        await q.walk('to godric cell', [{ x: CELL_GODRIC.x + 1, z: CELL_GODRIC.z, tol: 0 }]);
        await op('godric cell', CELL_GODRIC, () => !q.has(ITEM.keyGodric) || msgSince(/you unlock the cell door/i, t0));
        q.milestone(40);
        await closeDlg();
        t0 = q.s.tick();
        await q.walk('to eadgar cell', [{ x: CELL_EADGAR.x + 1, z: CELL_EADGAR.z, tol: 0 }]);
        await op('eadgar cell', CELL_EADGAR, () => !q.has(ITEM.keyEadgar) || msgSince(/you unlock the cell door/i, t0));
        q.milestone('eadgar');
        await closeDlg();
        // 7. The back exit (sets %troll_opened_back_exit) to the mountain west of the stronghold.
        await q.walk('to back exit', [{ x: BACK_EXIT.x + 1, z: BACK_EXIT.z + 1, tol: 1 }]);
        await op('back exit', BACK_EXIT, () => z() < 4000);
    }
    if (from('back')) {
        // 8. Down the troll rocks to the Death Plateau rocks and Burthorpe; Dunstan completes the quest.
        await q.walk('to back rocks', [{ x: ROCKS_BACK.x, z: ROCKS_BACK.z + 1, tol: 0 }]);
        await op('back rocks', ROCKS_BACK, () => z() <= 3627);
        await q.walk('to troll rocks top', [{ x: ROCKS_S.x, z: ROCKS_S.z + 1, tol: 0 }]);
        await op('troll rocks down', ROCKS_S, () => z() <= 3611);
        await q.walk('to death rocks top', [{ x: DEATH_ROCKS_TOP.x, z: DEATH_ROCKS_TOP.z + 1, tol: 0 }]);
        await op('death rocks down', DEATH_ROCKS_TOP, () => z() <= 3593);
        q.milestone('down');
        // Dunstan's smithy door (loc 1530, north wall of 2921,3571), as in quest-death.ts.
        await q.walk('to smithy door', [{ x: 2921, z: 3570, tol: 0 }]);
        await q.openDoor('smithy door', 2921, 3571);
        await q.walk('into smithy', [{ x: 2921, z: 3573, tol: 1 }]);
        await q.talk('dunstan', /^dunstan$/i, [], () => questDone || q.has(ITEM.talisman), DUNSTAN, 60);
        await q.waitUntil(() => questDone, 10);
    }
    off();
    if (!questDone) await q.fail('no quest complete message');
    q.milestone(50);
    await q.end(true, 'qp=1');
} catch (e) {
    await q.fail(`error ${(e as Error).message}`);
}
