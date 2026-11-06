// PROOF 3/3 on practice: 937, 910, 942 ticks; the dusty key chain is in the run, research/quest-plan.md 1o.
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
const NPC = { a: 385, b: 386, c: 387, jailer: 201 };
const ITEM = { jailKey: 1591, dusty: 1590 };
const JAILER = { x: 2933, z: 9693 };                         // spawn, maps/m45_151.jm2
const JAIL_DOOR = { id: 2631, x: 2931, z: 9690 };            // Velrak's cell door, south wall of the tile
const VELRAK = { x: 2931, z: 9685 };
const GATE = { id: 2623, x: 2924, z: 9803 };                 // deepdungeondoor, west wall of the tile, maps/m45_153.jm2

// The eater takes any edible in the pack: an account without the preset's lobsters carries its own cake or fish, and the
// dungeon's poison and the Jailer bleed it either way.
const q = await openQuest({ cap: 2500, eatAt: 50, lumbridgeOk: false });
try {
    const FROM = Number(process.env.SC_FROM ?? 0);   // 2: debug preset quest_scorpion_s2 (outside the outpost, stage 2, empty cage); 3: quest_scorpion_s3 (Taverley dungeon ladder, cage with B)
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
    // The yard between the gate and the hut door 2551,3569-3570. The land east of the hut is also x >= 2546, and it has no way in.
    const inOutpost = () => { const x = q.pos()?.worldX ?? 0; return x >= 2546 && x <= 2552; };
    if (FROM < 3) {
        if (!inOutpost()) {
            await q.walk('to outpost gate', [{ x: 2544, z: 3569, tol: 1 }]);
            await q.step('outpost gate', () => { const g = q.findLoc(l => /gate/i.test(l.name) && l.x === 2545 && (l.z === 3569 || l.z === 3570) && (l.optionsWithIndex ?? []).length > 0); return g ? q.opLoc(g, 1) : q.waitTicks(1); }, inOutpost, 8, 4);
        }
        await q.openDoor('hut door', 2551, 3570);
        await q.openDoor('hut door 2', 2551, 3569);
        await q.dash('to scorpion b', SCORP_B.x, SCORP_B.z, 3, 12);
        await catchScorp('b', SCORP_B);
        // Out by the same gate: the world router holds it shut (its opening is Barcrawl's, which the client cannot see),
        // so a walk planned from inside the yard finds no way out.
        await q.openDoor('hut door out', 2551, 3570);
        await q.dash('to outpost gate inside', 2546, 3569, 1, 12);
        await q.step('outpost gate out', () => { const g = q.findLoc(l => /gate/i.test(l.name) && l.x === 2545 && (l.z === 3569 || l.z === 3570) && (l.optionsWithIndex ?? []).length > 0); return g ? q.opLoc(g, 1) : q.waitTicks(1); }, () => !inOutpost(), 8, 4);
    }

    // Protect from Melee (sdk PRAYER_INDICES 14): the dungeon's poison scorpions and the black demons (level 172, aggressive
    // to every player) beside the wall corridor all hit with melee.
    const PFM = 14, prayers = (): any => q.st()?.prayers, pfmOn = (): boolean => !!prayers()?.activePrayers?.[PFM], points = (): number => prayers()?.prayerPoints ?? 0;
    const setPfm = async (on: boolean): Promise<void> => {
        if (pfmOn() === on || (on && points() <= 0)) return;
        await q.step(`protect from melee ${on ? 'on' : 'off'}`, () => q.s.direct({ type: 'togglePrayer', prayerIndex: PFM, reason: 'SDK' }), () => pfmOn() === on, 3, 3);
    };
    // A: Falador Teleport, the Taverley dungeon ladder, the dusty key, the secret wall.
    if (FROM < 3) {
        await q.teleport('falador teleport 1', 'magic:falador_teleport', 2965, 3378);
        await q.walk('to taverley ladder', [{ x: TAV_LADDER.x, z: TAV_LADDER.z + 1, tol: 1 }]);
        await q.climb('taverley ladder', ladderAt(TAV_LADDER, /climb-down/i), /climb-down/i, () => (q.pos()?.worldZ ?? 0) > 9000);
    }
    // Poison scorpions roam the dungeon between the ladder and the jail and their sting poisons for hundreds of ticks; the
    // black demons beside the wall corridor hit for most of a ranger's hitpoints. Protect from Melee drains a point every
    // five ticks, so Prayer 74 buys 370 ticks of cover for a dungeon pass of over 700: the prayer is held only while a
    // scorpion or demon stands within seven tiles (released once none is within ten) and the points last.
    let praying = false;
    const threatWithin = (r: number): boolean => (q.st()?.nearbyNpcs ?? []).some((n: any) => /demon|scorpion/i.test(n.name ?? '') && n.distance <= r);
    const releasePrayer = q.s.onTick(() => {
        if (praying || (q.pos()?.worldZ ?? 0) < 9000) return;
        const want = pfmOn() ? threatWithin(10) : threatWithin(7) && points() > 0;
        if (want === pfmOn()) return;
        praying = true;
        q.s.direct({ type: 'togglePrayer', prayerIndex: PFM, reason: 'SDK' }).catch(() => undefined).finally(() => { praying = false; });
    });
    // The corridor north of the secret wall is walled off from the ladder (wall on x 2880/2881); the only way in is
    // the dusty key gate (deepdungeondoor 2623, west wall of 2924,9803). From its east side it gives "This gate is
    // locked." (areas/area_taverly/dungeon/scripts/jail_doors.rs2:31, test run t5) unless the dusty key is used on
    // it. Velrak gives the dusty key (untradeable) once his cell door (dungeonjail 2631, south wall of 2931,9690) is
    // opened with the jail key, which the Jailer always drops (drop tables/scripts/jailer.rs2:10, 100 ticks on the
    // ground). The corridor side of a door is "entering" (doors/scripts/door_procs.rs2:77-88): only that side needs
    // the key; the door moves the player through (open_and_close_doors.rs2:43-62).
    q.blockDoor(0, GATE.x, GATE.z);
    const ground = (id: number): any => (q.st()?.groundItems ?? []).filter((g: any) => g.id === id).sort((a: any, b: any) => a.distance - b.distance)[0];
    const pickup = (g: any) => q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' });
    if (!q.has(ITEM.dusty)) {
        await q.walk('to jailer', [{ x: JAILER.x - 3, z: JAILER.z - 1, tol: 3 }]);
        // The Jailer (level 47) dies to a low-Attack ranger's bow, not to its hands; the sweep brings the bow and QUEST_ARROWS.
        await q.wieldBow();
        for (let t = 0; t < 150 && !q.has(ITEM.jailKey); t++) {
            await q.guard('jailer');
            const g = ground(ITEM.jailKey);
            const n = npcId(NPC.jailer);
            if (g) { if (t % 3 === 0) await pickup(g); }
            else if (n && t % 4 === 0 && q.pos()?.targetIndex !== n.index) await q.s.direct({ type: 'interactNpc', npcIndex: n.index, optionIndex: n.optionsWithIndex?.find((o: any) => /attack/i.test(o.text))?.opIndex ?? 2, reason: 'SDK' });
            await q.waitTicks(1);
        }
        if (!q.has(ITEM.jailKey)) await q.fail('jail key');
        q.milestone('jail key');
        const inCell = () => (q.pos()?.worldZ ?? 9999) < JAIL_DOOR.z;
        await q.step('cell door', () => q.useOnLoc(ITEM.jailKey, JAIL_DOOR), inCell, 15, 4);
        await q.talk('velrak', /^velrak/i, [/know anywhere good to explore/i, /yes please/i], () => q.has(ITEM.dusty), VELRAK, 40);
        q.milestone('dusty key');
        await q.step('leave cell', () => q.opLoc(JAIL_DOOR, 1), () => !inCell(), 15, 4);
    }
    const pastGate = () => (q.pos()?.worldX ?? 0) < GATE.x && Math.abs((q.pos()?.worldZ ?? 0) - GATE.z) < 30;
    await q.walk('to dusty gate', [{ x: GATE.x + 1, z: GATE.z, tol: 1 }]);
    await q.step('dusty gate', () => q.useOnLoc(ITEM.dusty, GATE), pastGate, 15, 4);
    q.milestone('gate');
    // Black Demon spawns near 2860,9776 close the only corridor (x 2877-2879, z 9769-9788) to the danger guard
    // (packages/core/src/danger.ts), so planned walks pace in the dragon room. Client-routed clicks do not use that guard.
    await q.dash('to south cave', 2894, 9776, 2, 30);
    await q.dash('to wall corridor', 2877, 9788, 2, 34);
    await q.dash('to wall', WALL.x, WALL.z, 1, 24);
    await q.step('secret wall', () => q.opLoc(WALL, 1), () => (q.pos()?.worldZ ?? 9999) < WALL.z, 10, 4);
    await catchScorp('a', SCORP_A);
    // Back out the way in: the router holds the dusty gate shut (q.blockDoor), so a Magic 1 account's walk to Falador
    // starts above ground. The gate's west side is the leaving side and opens without the key (door_procs.rs2:77-88).
    await q.step('secret wall back', () => q.opLoc(WALL, 1), () => (q.pos()?.worldZ ?? 0) >= WALL.z, 10, 4);
    await q.dash('to wall corridor back', 2877, 9788, 2, 24);
    await q.dash('to south cave back', 2894, 9776, 2, 34);
    await q.walk('to dusty gate inside', [{ x: GATE.x - 1, z: GATE.z, tol: 1 }]);
    await q.step('dusty gate out', () => q.opLoc(GATE, 1), () => !pastGate(), 15, 4);
    // The way back is the way in, leg by leg: the gate to the jail yard, the yard to the climb-down landing (2885,9797,
    // beside the ladder's dungeon end); the client walk does not find the whole way from the gate in one leg. A poison
    // scorpion on the bot interrupts every walk click, so one in combat within reach is shot first.
    const clearScorpions = async (): Promise<void> => {
        for (let t = 0; t < 60; t++) {
            const foe: any = (q.st()?.nearbyNpcs ?? []).find((n: any) => /scorpion/i.test(n.name) && n.inCombat && n.distance <= 3);
            if (!foe) return;
            if (t % 3 === 0 && q.pos()?.targetIndex !== foe.index) await q.s.direct({ type: 'interactNpc', npcIndex: foe.index, optionIndex: foe.optionsWithIndex?.find((o: any) => /attack/i.test(o.text))?.opIndex ?? 2, reason: 'SDK' });
            await q.waitTicks(1);
        }
    };
    for (const leg of [{ label: 'to jail yard', to: { x: JAILER.x - 3, z: JAILER.z - 1, tol: 3 } }, { label: 'to dungeon ladder', to: { x: TAV_LADDER.x + 1, z: TAV_LADDER.z + 6400, tol: 1 } }]) {
        for (let i = 0; i < 3; i++) {
            await clearScorpions();
            if (await q.walk(leg.label, [leg.to]).then(() => true, () => false)) break;
            if (i === 2) await q.fail(`walk ${leg.label}`);
        }
    }
    await q.climb('dungeon ladder up', ladderAt({ x: TAV_LADDER.x + 1, z: TAV_LADDER.z + 6400 }, /climb-up/i), /climb-up/i, () => (q.pos()?.worldZ ?? 9999) < 9000);
    releasePrayer();
    await setPfm(false);

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
    // Scorpion C is in the bedroom behind a door (loc_1530, north wall of 3058,3485, maps/m47_54.jm2); the client
    // finds no route to it while the door is shut (test run a1).
    await q.openDoor('bedroom door', 3058, 3485);
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
