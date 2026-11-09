// Horror from the Deep from preset quest_horror (beside Larrissa outside the lighthouse; every skill 99; the rune set
// worn; planks, nails, hammer, swamp tar, molten glass, tinderbox, a bronze dagger, a bronze arrow, wave runes and 12
// sharks from a helper). Reward: 2 QP, 4,662 XP each in Magic, Strength and Ranged before 25x
// (quests/quest_horror/scripts/quest_horror.rs2:485-497).
// %horrorquest (varp 351 bits 0-10, quest_horror.constant): Larrissa 1 (horror_girlfriend.rs2:81-85); the door with
// the key and both bridge halves 2 (quest_horror.rs2:21-36); the light repaired 4 (:265-289); the junior Dagannoth
// dead 5 (horror_dagannoth.rs2:15-36); the mother dead completes it (:216-227). Stage 3 is never set.
// Every jump and bridge crossing is stat_random(agility, 5, 255) (basalt_rocks.rs2, quest_horror.rs2:101): at
// Agility 99 the value is 256, above every roll (engine PlayerOps.ts STAT_RANDOM), so no jump fails.
// HD_FROM=<stage> starts at a debug preset (packages/practice/src/presets-long.ts).
import { openQuest } from './quest-lib';
import { componentId } from '../../packages/core/src/logout';

const ITEM = { plank: 960, nails: 1539, key: 3848, tar: 1939, glass: 1775, tinder: 590, dagger: 1205, arrow: 882, fire: 554, water: 555, air: 556, earth: 557 };
const LARRISSA = { x: 2508, z: 3635 };
const GUNNJORN = { x: 2540, z: 3548 };
const PIPE = { id: 2287, x: 2552, z: 3559 };              // barbarian_obstacle_pipe
const DOOR = { id: 4577, x: 2509, z: 3636 };              // horror_lighthouse_doorway (39_56 copy)
const BRIDGE_L = { id: 4615, x: 2596, z: 3608 };
const BRIDGE_R = { id: 4616, x: 2598, z: 3608 };
// Basalt rocks (basalt_rocks.rs2:1-10): [loc id, x, z, landing check]. South from the lighthouse: 10, 8, 6, 4, 2;
// north from the Barbarian Outpost shore: 1, 3, 5, 7, 9.
const SOUTH: Array<[number, number, number, (x: number, z: number) => boolean]> = [
    [4559, 2514, 3619, (_x, z) => z <= 3616], [4557, 2514, 3615, (x, z) => z <= 3612 && x >= 2514],
    [4555, 2516, 3611, (x) => x >= 2518], [4553, 2522, 3602, (_x, z) => z <= 3599], [4551, 2522, 3597, (_x, z) => z <= 3594],
];
const NORTH: Array<[number, number, number, (x: number, z: number) => boolean]> = [
    [4550, 2522, 3595, (_x, z) => z >= 3598], [4552, 2522, 3600, (_x, z) => z >= 3603], [4554, 2518, 3611, (x) => x <= 2515],
    [4556, 2514, 3613, (_x, z) => z >= 3616], [4558, 2514, 3617, (_x, z) => z >= 3620],
];
// Lighthouse, 38_71 copy before the repair (quest_horror.rs2:186-212).
const STAIRS_BASE = { id: 4568, x: 2442, z: 4600 };
const STAIRS_MID = { id: 4569, x: 2442, z: 4600 };
const STAIRS_TOP = { id: 4570, x: 2506, z: 3641 };       // 39_56 copy, where the repair teleports the bot
const COG = { id: 4588, x: 2443, z: 4599 };
const LADDER = { id: 4383, x: 2445, z: 4604 };
// Basement (39_72, level 1) and cavern (level 0).
const WALL_MID = { id: 4543, x: 2514, z: 4627 };
const WALL_OPEN = { id: 4545, x: 2516, z: 4627 };
const LADDER2 = { id: 4485, x: 2515, z: 4630 };
const JOSSIK = { x: 2518, z: 4633 };
const NPC = { junior: 1347, air: 1351, water: 1352, fire: 1353, earth: 1354, ranged: 1355, melee: 1356 };
const WAVE: Record<number, string> = { [NPC.air]: 'magic:wind_wave', [NPC.water]: 'magic:water_wave', [NPC.earth]: 'magic:earth_wave', [NPC.fire]: 'magic:fire_wave' };
const PROTECT_MISSILES = 13;

const FROM = process.env.HD_FROM ?? 'start';
const STAGES = ['start', 'in', 'cave', 'fight'];
const from = (s: string) => STAGES.indexOf(FROM) <= STAGES.indexOf(s);

const q = await openQuest({ cap: 6000, eatAt: 50, food: [385] });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const x = () => q.pos()?.worldX ?? 0;
    const z = () => q.pos()?.worldZ ?? 0;
    const lvl = () => q.pos()?.level ?? 0;
    const closeDlg = async () => { if (q.dialogOpen()) await q.converse([], () => !q.dialogOpen(), 12); };
    const loc = (l: { id: number; x: number; z: number }) => q.findLoc((k: any) => k.id === l.id && k.x === l.x && k.z === l.z) ?? l;
    // The capped message buffer: compare ticks, not counts.
    const msgSince = (re: RegExp, t0: number) => (q.st()?.gameMessages ?? []).some((m: any) => m.tick >= t0 && re.test(m.text));
    // A click sent while the last jump's forcemove still runs is lost (trial 6: 13 idle ticks at 2518,3610 with a 14-tick
    // retry), so the jump and stair steps retry every 6 ticks.
    const jump = async (label: string, list: typeof SOUTH) => {
        for (const [id, lx, lz, landed] of list) {
            await q.step(`${label} ${lx},${lz}`, () => q.opLoc(loc({ id, x: lx, z: lz }), 1), () => landed(x(), z()), 6, 8);
        }
    };
    const useOn = async (label: string, item: number, l: { id: number; x: number; z: number }, ok: () => boolean) => {
        await q.step(label, () => q.useOnLoc(item, loc(l)), ok, 10, 3);
        await closeDlg();
    };
    // Debug trial f2: 3 toggles 3 ticks apart while the junior arrived (its spawn queue holds p_delay) changed nothing.
    const prayer = async (on: boolean) => {
        const active = () => !!(q.st() as any)?.prayers?.activePrayers?.[PROTECT_MISSILES];
        if (active() === on) return;
        await q.waitUntil(() => !q.dialogOpen(), 6);
        await q.step(`protect missiles ${on}`, () => q.s.direct({ type: 'togglePrayer', prayerIndex: PROTECT_MISSILES, reason: 'SDK' }), () => active() === on, 6, 4);
    };

    if (from('start')) {
        // 1. Larrissa: "With what?", "But how can I help?", "Okay, I'll help!" sets 1 (horror_girlfriend.rs2:81-123).
        await q.talk('larrissa', /^larrissa$/i, [/^with what/i, /but how can i help/i, /okay, i'll help/i, /i'll see what i can do/i], () => q.sawText(/thank you so much! i know my darling/i), LARRISSA, 60);
        q.milestone(1);
        // 2. South over the rocks to Gunnjorn, inside the Barbarian agility course: he gives the key
        // (areas/area_barbarian_outpost/scripts/gunnjorn.rs2:1-28). The obstacle pipe (2552,3559) is the only way in
        // (trial 2: no path to him); a squeeze moves 3 tiles each way (skill_agility/scripts/barbarian_course.rs2:125-147).
        // Proof attempt 2 went to the bridge first, then round by the Rellekka shore: about 350 ticks from the bridge to the key.
        await jump('rocks south', SOUTH);
        // The planned walk ends east of the pipe; a client-routed click reaches the north stand (barbarian_course.rs2:125-147).
        // The pipe's north stand is in the yard east of the outpost gate (2545,3569), so the bot goes out through the gate.
        const gate = async (label: string, through: () => boolean) => {
            await q.step(label, () => { const g = q.findLoc((l: any) => l.x === 2545 && l.z === 3569) ?? { id: 2116, x: 2545, z: 3569 }; return q.opLoc(g, 1); }, through, 8, 5);
        };
        await q.walk('to outpost gate', [{ x: 2544, z: 3569, tol: 1 }]);
        await gate('gate out', () => (q.pos()?.worldX ?? 0) >= 2546);
        await q.dash('pipe stand', PIPE.x, PIPE.z + 2, 0, 16);
        await q.step('pipe in', () => q.opLoc(loc(PIPE), 1), () => z() <= PIPE.z - 1, 14, 4);
        await q.talk('gunnjorn', /^gunnjorn$/i, [], () => q.has(ITEM.key), GUNNJORN, 40);
        await q.walk('to pipe back', [{ x: PIPE.x, z: PIPE.z - 1, tol: 1 }]);
        await q.step('pipe out', () => q.opLoc(loc(PIPE), 1), () => z() >= PIPE.z + 2, 14, 4);
        await q.dash('gate yard', 2546, 3569, 1, 16);
        await gate('gate in', () => (q.pos()?.worldX ?? 9999) <= 2545);
        q.milestone('key');
        await q.walk('to rocks', [{ x: 2522, z: 3594, tol: 1 }]);
        await jump('rocks north', NORTH);
        // 3. East along the causeway to the bridge (the lighthouse side reaches its west half only, the shore its east
        // half only; trial 1): a plank, 4 nails and the hammer on each half. Cross jumps the gap to 2599; with both
        // halves fixed Cross walks back over it (quest_horror.rs2:62-167).
        await q.walk('to bridge', [{ x: BRIDGE_L.x - 1, z: BRIDGE_L.z, tol: 0 }]);
        await useOn('plank west', ITEM.plank, BRIDGE_L, () => q.cnt(ITEM.plank) === 1 || q.sawText(/half a makeshift walkway/i));
        await q.step('cross gap', () => q.opLoc(loc(BRIDGE_L), 1), () => x() >= 2599, 14, 3);
        await q.waitTicks(1);
        await useOn('plank east', ITEM.plank, BRIDGE_R, () => !q.has(ITEM.plank) || q.sawText(/now made a makeshift walkway/i));
        await q.step('bridge back', () => q.opLoc(loc(BRIDGE_R), 1), () => x() <= 2595, 14, 3);
        q.milestone('bridge');
        // 4. The key unlocks the door; the next click enters the 38_71 copy (2, quest_horror.rs2:1-58).
        await q.walk('to door', [{ x: DOOR.x, z: DOOR.z - 1, tol: 0 }]);
        await q.step('unlock door', () => q.opLoc(loc(DOOR), 1), () => !q.has(ITEM.key), 10, 3);
        await q.step('enter lighthouse', () => q.opLoc(loc(DOOR), 1), () => z() > 4500, 10, 4);
        q.milestone(2);
    }
    if (from('in')) {
        // 5. Up the spiral stairs to the light: swamp tar, tinderbox, molten glass on the mechanism sets 4 and moves
        // the bot to the 39_56 copy (quest_horror.rs2:186-212, 245-289).
        await q.step('stairs up 1', () => q.opLoc(loc(STAIRS_BASE), 1), () => lvl() === 1, 6, 6);
        await q.step('stairs up 2', () => q.opLoc(loc(STAIRS_MID), 2), () => lvl() === 2, 6, 6);
        const t2 = q.s.tick();
        await useOn('tar', ITEM.tar, COG, () => !q.has(ITEM.tar));
        await useOn('light', ITEM.tinder, COG, () => msgSince(/light the torch|already lit/i, t2));
        await useOn('glass', ITEM.glass, COG, () => !q.has(ITEM.glass) && z() < 4000);
        q.milestone(4);
        // 6. Down: the top stairs go back to the 38_71 copy (level 1), then down and the iron ladder to the basement.
        await q.step('stairs down 1', () => q.opLoc(loc(STAIRS_TOP), 1), () => lvl() === 1 && z() > 4500, 6, 6);
        await q.step('stairs down 2', () => q.opLoc(loc(STAIRS_MID), 3), () => lvl() === 0, 6, 6);
        await q.step('basement ladder', () => q.opLoc(loc(LADDER), 1), () => lvl() === 1 && x() > 2500, 12, 4);
    }
    if (from('cave')) {
        // 7. The strange wall: a fire, water, earth and air rune, a dagger and an arrow, each confirmed with "Yes"
        // (quest_horror.rs2:332-427); the east part then opens from the south (:307-320); the ladder down.
        await q.walk('to wall', [{ x: WALL_MID.x, z: WALL_MID.z - 1, tol: 0 }]);
        for (const [name, id] of [['fire', ITEM.fire], ['water', ITEM.water], ['earth', ITEM.earth], ['air', ITEM.air], ['dagger', ITEM.dagger], ['arrow', ITEM.arrow]] as const) {
            const t3 = q.s.tick();
            // Count the item: the previous item's message can land on this tick, and it would skip this slot.
            const n0 = q.cnt(id);
            const placed = () => q.cnt(id) < n0 || msgSince(/no space to put/i, t3 + 1);
            for (let i = 0; i < 3 && !placed(); i++) {
                await q.guard(`wall ${name}`);
                await q.useOnLoc(id, loc(WALL_MID));
                await q.converse([/yes/i], placed, 12);
            }
            if (!placed()) await q.fail(`wall ${name}`);
            await q.waitUntil(() => !q.dialogOpen(), 3);
        }
        q.milestone('wall');
        await q.walk('to open wall', [{ x: WALL_OPEN.x, z: WALL_OPEN.z - 1, tol: 0 }]);
        await q.step('open wall', () => q.opLoc(loc(WALL_OPEN), 1), () => z() >= WALL_OPEN.z, 10, 4);
        await q.step('cavern ladder', () => q.opLoc(loc(LADDER2), 1), () => lvl() === 0, 12, 4);
    }
    if (from('fight')) {
        // 8. Jossik's talk at 4 ends by calling a junior Dagannoth (horror_lighthousekeeper.rs2:1-18, 258-301); its death
        // sets 5 and calls the mother (horror_dagannoth.rs2:15-36, 230-256).
        const npcId = (ids: number[]) => (q.st()?.nearbyNpcs ?? []).find((n: any) => ids.includes(n.id));
        await q.talk('jossik', /^jossik$/i, [], () => q.sawText(/back any minute now/i), JOSSIK, 80);
        await q.waitUntil(() => !!npcId([NPC.junior, 1344, 1345, 1346]), 12);
        if (!npcId([NPC.junior, 1344, 1345, 1346])) { console.log(`NPCS ${JSON.stringify((q.st()?.nearbyNpcs ?? []).map((n: any) => [n.id, n.name, n.x, n.z]))}`); await q.fail('no junior'); }
        await prayer(true);
        for (let k = 0; k < 60 && npcId([NPC.junior, 1344, 1345, 1346]); k++) {
            await q.guard('junior');
            const n = npcId([NPC.junior]);
            if (n && !q.dialogOpen()) await q.s.bot.attack(n as any);
            await q.waitUntil(() => !npcId([NPC.junior, 1344, 1345, 1346]), 6);
        }
        if (npcId([NPC.junior])) await q.fail('junior alive');
        q.milestone(5);
        // 9. The mother changes form every 30 ticks (air, water, melee, earth, fire, ranged); each form takes only its
        // own style (npc_combat.rs2:402-437). The bot casts the matching wave on the 4 element forms and uses the
        // scimitar on the melee form. Protect from Missiles stops her spines; she then closes to melee.
        const MOTHER = [NPC.air, NPC.water, NPC.fire, NPC.earth, NPC.ranged, NPC.melee, 1348, 1349, 1350];
        // She arrives a few ticks after the junior's death dialog (spawn_dagmother: p_delay 0, 1, 1, 1). Proof attempt 1
        // run 1 left the loop when she was not yet listed and cast nothing. Jossik's talk at 5 calls her again
        // (horror_lighthousekeeper.rs2:3-8); a form change deletes her when the bot is more than 17 tiles away.
        await q.converse([], () => !!npcId(MOTHER) && !q.dialogOpen(), 60);
        let lastCast = -10, meleeOn = -1, casts = 0, absent = 0, recalls = 0;
        for (let k = 0; k < 900 && !questDone; k++) {
            await q.guard('mother');
            if (q.dialogOpen()) { await closeDlg(); continue; }
            const n: any = npcId(MOTHER);
            if (!n) {
                await q.waitTicks(1);
                if (++absent < 15 || questDone) continue;
                if (++recalls > 3) break;
                console.log(`WARN mother absent; Jossik again at ${q.T()}`);
                const j = q.npc(/^jossik$/i);
                if (j) await q.talkTo(j);
                await q.waitUntil(() => q.dialogOpen(), 10);
                await q.converse([], () => !q.dialogOpen(), 40);
                absent = 0;
                continue;
            }
            absent = 0;
            const spell = WAVE[n.id];
            if (spell && q.T() - lastCast >= 5) {
                lastCast = q.T(); casts++; meleeOn = -1;
                await q.s.direct({ type: 'spellOnNpc', npcIndex: n.index, spellComponent: componentId(spell), reason: 'SDK' });
            } else if (n.id === NPC.melee && meleeOn !== n.index) {
                meleeOn = n.index;
                await q.s.bot.attack(n as any);
            }
            await q.waitTicks(1);
        }
        console.log(`MOTHER casts=${casts} ${q.T()}`);
        await prayer(false);
        await q.converse([], () => questDone, 20);
    }
    await q.waitUntil(() => questDone, 10);
    q.milestone(100);
    off();
    await q.end(questDone, 'qp=2');
} catch (e) { await q.fail(String(e)); }
