// NOT PROVEN (2026-10-24): needs Alfred Grimhand's Barcrawl first (preset varp 77 = 2), see research/quest-plan.md 1o.
// Scorpion Catcher from preset quest_scorpion (beside Thormac, top of the Sorcerer's Tower), at the planner's state
// for the scorpion row (tick 53,715, every skill 99). Reward: 66,250 Strength (x25: 165,625), 1 QP
// (quest_scorpcatcher.rs2:55-60). Paths below are under vendor/rs-sdk/server/content/scripts/.
// Varp %scorpcatcher (76): 1 Thormac gives the cage (areas/area_seers/scripts/thormac.rs2:47-56); 2 a Seer's looking
// glass (areas/area_seers/scripts/seer.rs2:56-68), which the Taverley dungeon secret wall needs
// (quest_scorpcatcher.rs2:45-53). The three cage catches have no stage check (quest_scorpcatcher.rs2:14-39): scorpion
// A behind the wall (2877,9796), B in the Barbarian Outpost (2552,3570), C upstairs in the Monastery (3058,3488,1),
// whose ladder needs the order (Prayer 31, areas/monastery/scripts/prayer_guild.rs2:5-40). Peksa and the Seer's
// later hints are not needed. Thormac with the full cage queues the completion.
import { openQuest } from './quest-lib';

const THORMAC = { x: 2702, z: 3405 };
const SEER = { x: 2702, z: 3475 };
const SCORP_B = { x: 2552, z: 3570 };
const TAV_LADDER = { x: 2884, z: 3397 };                    // ladder_cellar_inside_down (1759), maps/m45_53.jm2
const WALL = { id: 2117, x: 2875, z: 9799 };                 // scorpionwall, south wall of the tile
const SCORP_A = { x: 2877, z: 9796 };
const ABBOT = { x: 3058, z: 3484 };
const MON_LADDER = { x: 3057, z: 3483 };                     // monasteryladder (2641)
const SCORP_C = { x: 3058, z: 3488 };
// Sorcerer's Tower ladders (maps/m42_53.jm2): 0 -> 1 at 2701,3408; 1 -> 2 at 2704,3403; 2 -> 3 at 2699,3405.
const TOWER = [{ x: 2701, z: 3408 }, { x: 2704, z: 3403 }, { x: 2699, z: 3405 }];
const CAGE = { empty: 456, a: 457, ab: 458, ac: 459, b: 460, bc: 461, c: 462, full: 463 };
const CAGES = Object.values(CAGE);
const NPC = { a: 385, b: 386, c: 387 };

const q = await openQuest({ cap: 2500, eatAt: 50, food: [379], lumbridgeOk: false });
try {
    const FROM = Number(process.env.SC_FROM ?? 0);   // 2: debug preset quest_scorpion_s2 (outside the outpost, stage 2, empty cage)
    let questDone = false;
    const offDone = q.s.onTick(() => { if (q.msgCount(/quest complete|completed the\s+scorpion catcher/i) > 0) questDone = true; });
    const cage = (): number | undefined => CAGES.find(id => q.has(id));
    const caught = (k: 'a' | 'b' | 'c'): boolean => {
        const c = cage();
        if (c === CAGE.full) return true;
        if (k === 'a') return c === CAGE.a || c === CAGE.ab || c === CAGE.ac;
        if (k === 'b') return c === CAGE.b || c === CAGE.ab || c === CAGE.bc;
        return c === CAGE.c || c === CAGE.ac || c === CAGE.bc;
    };
    const npcId = (id: number): any => (q.st()?.nearbyNpcs ?? []).filter((n: any) => n.id === id).sort((a: any, b: any) => a.distance - b.distance)[0];
    const catchScorp = async (k: 'a' | 'b' | 'c', at: { x: number; z: number }): Promise<void> => {
        if (!npcId(NPC[k])) await q.waitUntil(() => !!npcId(NPC[k]), 10);
        if (!npcId(NPC[k])) await q.walk(`to scorpion ${k}`, [{ x: at.x, z: at.z, tol: 3 }]);
        await q.step(`catch ${k}`, () => { const n = npcId(NPC[k]); const c = cage(); return n && c ? q.useOnNpc(c, n) : q.waitTicks(1); }, () => caught(k), 15, 5);
        q.milestone(`scorpion ${k}`);
    };
    const ladderAt = (at: { x: number; z: number }, re: RegExp) => () => q.findLoc(l => /ladder/i.test(l.name) && Math.max(Math.abs(l.x - at.x), Math.abs(l.z - at.z)) <= 1 && (l.optionsWithIndex ?? []).some((o: any) => re.test(o.text)));

    if (FROM < 2) {
        // 1. Thormac: "What do you need assistance with?", "What's in it for me?", "Ok, I will do it then." (the cage
        // comes with the start; the "how would I catch them" branch adds a 4-tick delay, thormac.rs2:29-38).
        await q.talk('thormac 1', /^thormac$/i, [/what do you need assistance/i, /what's in it for me/i, /ok, i will do it/i], () => q.has(CAGE.empty), THORMAC, 40);
        q.milestone(1);

        // Down the tower.
        for (let lv = 3; lv >= 1; lv--) {
            const at = TOWER[lv - 1]!;
            await q.climb(`tower down ${lv}`, ladderAt(at, /climb-down/i), /climb-down/i, () => q.lvl() === lv - 1);
        }

        // 2. A Seer: "I need to locate some scorpions."; the looking glass sets stage 2.
        // Four Seers spawn (2702,3475; 2714,3471; 2716,3485; 2705,3473 upstairs). The nearest can be the upstairs one, which
        // a Talk-to cannot reach (first test run), so the bot talks to the nearest with reachable set.
        await q.walk('to seer', [{ x: SEER.x, z: SEER.z - 2, tol: 4 }]);
        const seers = (): any[] => (q.st()?.nearbyNpcs ?? []).filter((n: any) => /^seer$/i.test(n.name)).sort((a: any, b: any) => a.distance - b.distance);
        console.log(`NOTE seers: ${seers().map((n: any) => `${n.x},${n.z} d=${n.distance} r=${n.reachable}`).join('; ')}`);
        for (let i = 0; i < 3 && !q.sawText(/try and get you some information on the others/i); i++) {
            await q.guard('seer');
            let n = seers().find((x: any) => x.reachable !== false);
            // All in shut houses: walkPath to the nearest one opens its door.
            if (!n && seers()[0]) { const t = seers()[0]; await q.walk('to seer house', [{ x: t.x, z: t.z, tol: 1 }]); n = seers()[0]; }
            if (!n) await q.fail('no seer');
            await q.talkTo(n);
            await q.waitUntil(() => q.dialogOpen(), 25);
            await q.converse([/i need to locate some scorpions/i], () => q.sawText(/try and get you some information on the others/i) && !q.dialogOpen(), 60);
        }
        if (!q.sawText(/try and get you some information on the others/i)) await q.fail('seer');
        q.milestone(2);
    }

    // B: the Barbarian Outpost. The gate (barbariangater/l, east wall of 2545,3569-3570, maps/m39_55.jm2) opens once
    // %barcrawl (77) is 2, Alfred Grimhand's Barcrawl (scripts/generated/quest-barcrawl.ts, the barcrawl row); before
    // that a Barbarian guard within 5 tiles talks instead (areas/area_barbarian_outpost/scripts/outpost_gate.rs2:1-5).
    // The gate moves the bot through (outpost_gate.rs2:7-11).
    const inOutpost = () => (q.pos()?.worldX ?? 0) >= 2546;
    if (!inOutpost()) {
        await q.walk('to outpost gate', [{ x: 2544, z: 3569, tol: 1 }]);
        await q.step('outpost gate', () => { const g = q.findLoc(l => /gate/i.test(l.name) && l.x === 2545 && (l.z === 3569 || l.z === 3570) && (l.optionsWithIndex ?? []).length > 0); return g ? q.opLoc(g, 1) : q.waitTicks(1); }, inOutpost, 8, 4);
    }
    await q.walk('to scorpion b', [{ x: SCORP_B.x + 1, z: SCORP_B.z, tol: 2 }]);
    await catchScorp('b', SCORP_B);

    // A: Falador Teleport, the Taverley dungeon ladder, the secret wall.
    await q.teleport('falador teleport 1', 'magic:falador_teleport', 2965, 3378);
    await q.walk('to taverley ladder', [{ x: TAV_LADDER.x, z: TAV_LADDER.z + 1, tol: 1 }]);
    await q.climb('taverley ladder', ladderAt(TAV_LADDER, /climb-down/i), /climb-down/i, () => (q.pos()?.worldZ ?? 0) > 9000);
    await q.walk('to wall', [{ x: WALL.x, z: WALL.z + 1, tol: 1 }]);
    await q.step('secret wall', () => q.opLoc(WALL, 1), () => (q.pos()?.worldZ ?? 9999) < WALL.z, 10, 4);
    await catchScorp('a', SCORP_A);

    // C: Falador Teleport, the Monastery; the ladder asks to join the order, then climbs.
    await q.teleport('falador teleport 2', 'magic:falador_teleport', 2965, 3378);
    await q.walk('to monastery', [{ x: MON_LADDER.x, z: MON_LADDER.z + 1, tol: 1 }]);
    for (let i = 0; i < 3 && q.lvl() !== 1; i++) {
        await q.guard('monastery ladder');
        const l = ladderAt(MON_LADDER, /climb-up/i)();
        if (l) await q.opLoc(l, q.opIndex(l, /climb-up/i));
        await q.waitUntil(() => q.dialogOpen() || q.lvl() === 1, 12);
        await q.converse([/well can i join your order/i], () => q.lvl() === 1 || (!q.dialogOpen() && q.sawText(/you may join/i)), 30);
    }
    if (q.lvl() !== 1) await q.fail('monastery upstairs');
    await catchScorp('c', SCORP_C);
    if (!q.has(CAGE.full)) await q.fail('cage not full');

    // Camelot Teleport, up the tower, Thormac.
    await q.teleport('camelot teleport', 'magic:camelot_teleport', 2757, 3478);
    await q.walk('to tower', [{ x: TOWER[0]!.x, z: TOWER[0]!.z - 1, tol: 1 }]);
    for (let lv = 0; lv <= 2; lv++) {
        const at = TOWER[lv]!;
        if (lv > 0) await q.walk(`tower ${lv}`, [{ x: at.x, z: at.z, tol: 1 }]);
        await q.climb(`tower up ${lv}`, ladderAt(at, /climb-up/i), /climb-up/i, () => q.lvl() === lv + 1);
    }
    await q.talk('thormac 2', /^thormac$/i, [], () => questDone, THORMAC, 40);
    await q.waitUntil(() => questDone, 10);
    q.milestone('complete');
    offDone();
    await q.end(questDone, `qp=1 questMsg=${questDone}`);

} catch (e) { await q.fail(String(e)); }
