// Eadgar's Ruse from preset quest_eadgar (beside Parroty Pete at the Ardougne zoo; every skill 99; Druidic Ritual,
// Death Plateau and Troll Stronghold done, Eadgar freed; the troll preset's worn set with climbing boots; helper items
// below). Reward: 1 QP, 110,000 Herblore XP before 25x, the Trollheim teleport (quest_eadgar.rs2:590-598).
// %eadgar_quest (varp 335, quest_eadgar.constant): Sanfew 10 (area_taverly/scripts/sanfew.rs2:127-136), Burntmeat
// first 20 (eadgar_troll_chief_cook.rs2:59-71), Eadgar 30 and with the parrot 50 (quest_eadgar.rs2:35-66,68-96), the
// parrot under the rack 60 (:214-222), Eadgar 70 with the logs, grain, chickens (:224-357), the dirty robe 80 (:365-383),
// the troll potion 85 (:386-406), the parrot back 86 (:197-211), the fake man 87 (:408-440), Burntmeat 90
// (eadgar_troll_chief_cook.rs2:24-40), the storeroom door with the drawer key 100 (quest_eadgar.rs2:473-509), the
// goutweed to Sanfew (sanfew.rs2:6-7,158-160).
// The parrot: Pete's two talks set %eadgar_bits 0 and 11, pineapple chunks on vodka make alco-chunks, the chunks on the
// aviary hatch catch it; this works before the quest starts (eadgar_zoo_keeper_aviary.rs2:21-90), so the run starts here.
// Tegid gives the dirty robe only at stage 70 (eadgar_druid_washing.rs2:7-16), so Taverley is visited twice more.
// EA_FROM=<stage> starts at a debug preset (packages/practice/src/presets-long.ts).
import { openQuest } from './quest-lib';

const ITEM = { chunks: 2116, vodka: 2015, alco: 3270, parrot: 3266, logs: 1511, grain: 1947, chicken: 2138,
    tinderbox: 590, pestle: 233, ranarr: 99, thistle: 3262, dried: 3263, ground: 3264, potion: 3265, robe: 3267,
    fakeMan: 3268, key: 3269, goutweed: 3261, burnt: 2146 };
const PETE = { x: 2611, z: 3285 };
const HATCH = { id: 4043, x: 2611, z: 3287 };
const SANFEW = { x: 2897, z: 3426 };                         // level 1
const SANFEW_STAIRS = { id: 1738, x: 2898, z: 3428 };        // spiralstairs, level 0
const TEGID = { x: 2913, z: 3417 };
const DEATH_ROCKS_BOTTOM = { id: 3723, x: 2880, z: 3594 };
const ROCKS_S = { id: 3748, x: 2856, z: 3612 };
const ROCKS_BACK = { id: 3748, x: 2833, z: 3628 };
const SECRET = { id: 3762, x: 2827, z: 3647 };              // troll_stronghold_entrance -> 2823,10050 level 0
const L0_STAIRS = { id: 3788, x: 2852, z: 10106 };          // level 0 -> 2852,10109 level 1 (prison side)
const PRISON_DOOR = { id: 3780, x: 2848, z: 10107 };        // level 1
const L1_STAIRS_TOP = { id: 3789, x: 2852, z: 10107 };      // level 1 -> 2852,10105 level 0
const L1_STAIRS_S = { id: 3788, x: 2842, z: 10051 };        // level 1 -> 2845,10051 level 2
const L2_STAIRS_N = { id: 3789, x: 2843, z: 10108 };        // level 2 -> 2841,10108 level 1
const L1_KITCHEN_DOWN = { id: 3789, x: 2852, z: 10061 };    // level 1 -> 2852,10064 level 0 (storeroom side)
const TOP_EXIT = { id: 3774, x: 2838, z: 10090 };           // level 2 -> 2840,3690
const SH_DOOR = { id: 3771, x: 2839, z: 3689 };             // -> 2837,10090 level 2
const CAVE_IN = { id: 3759, x: 2892, z: 3672 };             // -> 2893,10074 level 2 (Eadgar freed)
const CAVE_OUT = { id: 3760, x: 2892, z: 10072 };           // level 2 -> 2893,3671
const EADGAR = { x: 2890, z: 10086 };                       // level 2
const BURNTMEAT = { x: 2844, z: 10057 };                    // level 1
const DRAWERS = { id: 3816, x: 2852, z: 10049 };            // level 1
const RACK = { id: 3821, x: 2828, z: 10096 };               // level 0
const STORE_DOOR = { id: 3810, x: 2869, z: 10085 };         // level 0, south wall
const CRATE = { id: 3822, x: 2856, z: 10074 };              // level 0

const FROM = process.env.EA_FROM ?? 'start';
const STAGES = ['start', 'sanfew', 'leg1', 'rack1', 'items', 'robe', 'potion', 'rack2', 'fakeman', 'store'];
const from = (s: string) => STAGES.indexOf(FROM) <= STAGES.indexOf(s);

const q = await openQuest({ cap: 7000, eatAt: 40, food: [385] });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const x = () => q.pos()?.worldX ?? 0;
    const z = () => q.pos()?.worldZ ?? 0;
    const lv = () => q.lvl();
    const loc = (l: { id: number; x: number; z: number }) => q.locAt(l.x, l.z) ?? q.findLoc((k: any) => k.id === l.id && Math.abs(k.x - l.x) <= 1 && Math.abs(k.z - l.z) <= 1) ?? l;
    const msgSince = (re: RegExp, t: number) => (q.st()?.gameMessages ?? []).some((m: any) => m.type === 0 && m.tick >= t && re.test(m.text));
    const closeDlg = async () => { if (q.dialogOpen()) await q.converse([], () => !q.dialogOpen(), 20); };
    const op = async (label: string, l: { id: number; x: number; z: number }, done: () => boolean, ticks = 15, tries = 5, opi = 1) => {
        await q.step(label, async () => { if (q.dialogOpen()) await closeDlg(); return q.opLoc(loc(l), opi); }, done, ticks, tries);
        await q.waitTicks(1);
    };
    const useLoc = async (label: string, item: number, l: { id: number; x: number; z: number }, done: () => boolean, ticks = 12) => {
        await q.step(label, async () => { if (q.dialogOpen()) await closeDlg(); return q.useOnLoc(item, loc(l)); }, done, ticks, 4);
        await closeDlg();
    };
    const useItem = async (label: string, a: number, b: number, done: () => boolean) => {
        await q.step(label, async () => { if (q.dialogOpen()) await closeDlg(); return q.useOnItem(a, b); }, done, 8, 4);
        await closeDlg();
    };
    const falador = async () => {
        await closeDlg();
        await q.teleport('falador teleport', 'magic:falador_teleport', 2965, 3378);
    };

    // ---- Moves between the hubs ----
    // Taverley (or Falador) to the stronghold's back door (level 0, 2823,10050): the Death Plateau rocks, the troll
    // rocks south and north of the plateau path, the secret door (open after Troll Stronghold, quest_troll.rs2:105-110).
    const toStronghold = async () => {
        await q.walk('to death rocks', [{ x: DEATH_ROCKS_BOTTOM.x, z: DEATH_ROCKS_BOTTOM.z - 1, tol: 0 }]);
        await op('death rocks up', DEATH_ROCKS_BOTTOM, () => z() >= 3596);
        await q.walk('to troll rocks', [{ x: ROCKS_S.x, z: ROCKS_S.z - 1, tol: 0 }]);
        await op('troll rocks', ROCKS_S, () => z() >= 3613);
        await q.walk('to back rocks', [{ x: ROCKS_BACK.x, z: ROCKS_BACK.z - 1, tol: 0 }]);
        await op('back rocks', ROCKS_BACK, () => z() >= 3629);
        await q.walk('to secret door', [{ x: SECRET.x, z: SECRET.z - 1, tol: 1 }]);
        await op('secret door', SECRET, () => z() > 10000);
    };
    // Level 0 (back part) to level 1 west of the prison door.
    const l0ToL1 = async () => {
        await q.walk('to l0 stairs', [{ x: L0_STAIRS.x, z: L0_STAIRS.z - 1, tol: 1 }]);
        await op('l0 stairs', L0_STAIRS, () => lv() === 1);
        await q.walk('to prison door in', [{ x: PRISON_DOOR.x, z: PRISON_DOOR.z, tol: 0 }]);
        await op('prison door out', PRISON_DOOR, () => x() < PRISON_DOOR.x);
    };
    // Level 1 (west part) to level 0 by the cells.
    const l1ToL0 = async () => {
        await q.walk('to prison door', [{ x: PRISON_DOOR.x - 1, z: PRISON_DOOR.z, tol: 0 }]);
        await op('prison door', PRISON_DOOR, () => x() >= PRISON_DOOR.x);
        await op('l1 stairs down', L1_STAIRS_TOP, () => lv() === 0);
    };
    // Level 1 to the top exit on level 2 and out (2840,3690).
    const l1Out = async () => {
        await q.walk('to l1 stairs', [{ x: L1_STAIRS_S.x - 1, z: L1_STAIRS_S.z, tol: 1 }]);
        await op('l1 stairs up', L1_STAIRS_S, () => lv() === 2);
        await q.walk('to top exit', [{ x: TOP_EXIT.x - 1, z: TOP_EXIT.z, tol: 0 }]);
        await op('top exit', TOP_EXIT, () => z() < 4000);
    };
    // Outside (north of the stronghold) to Eadgar's cave, level 2.
    const toEadgar = async () => {
        await q.walk('to eadgar cave', [{ x: CAVE_IN.x, z: CAVE_IN.z - 1, tol: 1 }]);
        await op('eadgar cave', CAVE_IN, () => z() > 10000 && lv() === 2);
    };
    // Eadgar's cave to level 1 of the stronghold (2841,10108).
    const eadgarToL1 = async () => {
        await q.walk('to cave exit', [{ x: CAVE_OUT.x + 1, z: CAVE_OUT.z + 1, tol: 1 }]);
        await op('cave exit', CAVE_OUT, () => z() < 4000);
        await q.walk('to stronghold door', [{ x: SH_DOOR.x + 2, z: SH_DOOR.z, tol: 1 }]);
        await op('stronghold door', SH_DOOR, () => z() > 10000 && lv() === 2);
        await q.walk('to l2 stairs', [{ x: L2_STAIRS_N.x, z: L2_STAIRS_N.z - 1, tol: 1 }]);
        await op('l2 stairs', L2_STAIRS_N, () => lv() === 1);
    };
    const eadgar = async (label: string, pats: RegExp[], ok: () => boolean) => {
        await q.talk(label, /^eadgar$/i, [...pats, /no thanks, eadgar/i], ok, EADGAR, 100);
        await closeDlg();
    };
    const toRack = async () => {
        await q.walk('to rack', [{ x: RACK.x, z: RACK.z - 1, tol: 1 }]);
    };
    // Picks the thistle by Eadgar's cave, dries it on a new fire, grinds it (eadgar_troll_thistle.rs2:1-35,
    // skill_cooking/configs/cooking_source/cooking_generic.dbrow:679-688).
    const thistle = async () => {
        for (let i = 0; i < 6 && !q.has(ITEM.thistle); i++) {
            const n = q.npc(/^thistle$/i);
            if (!n) { await q.walk('to thistle', [{ x: 2891, z: 3675, tol: 3 }]); await q.waitTicks(1); continue; }
            await q.s.direct({ type: 'interactNpc', npcIndex: n.index, optionIndex: (n.optionsWithIndex ?? [])[0]?.opIndex ?? 1, reason: 'SDK' });
            await q.waitUntil(() => q.has(ITEM.thistle), 12);
        }
        if (!q.has(ITEM.thistle)) await q.fail('thistle');
        const t0 = q.s.tick();
        await useItem('fire', ITEM.tinderbox, ITEM.logs, () => msgSince(/fire catches|logs begin to burn/i, t0));
        await q.waitTicks(2);
        const fire = () => q.findLoc((l: any) => /^fire$/i.test(l.name) && l.distance <= 3);
        await q.step('dry thistle', async () => { const f = fire(); if (f) await q.useOnLoc(ITEM.thistle, f); }, () => q.has(ITEM.dried), 10, 4);
        await closeDlg();
        await useItem('grind', ITEM.pestle, ITEM.dried, () => q.has(ITEM.ground));
    };

    if (from('start')) {
        // 1. Pete: "When did you add it?" (bit 0), "What do you feed them?" (bit 11); the chunks on the vodka; the
        // alco-chunks on the hatch catch the drunk parrot (queued).
        await q.talk('pete 1', /^parroty pete$/i, [/when did you add it/i], () => q.sawText(/vet had to nurse/i), PETE, 40);
        await q.talk('pete 2', /^parroty pete$/i, [/what do you feed them/i], () => q.sawText(/pineapple chunks/i), PETE, 40);
        await useItem('alco chunks', ITEM.chunks, ITEM.vodka, () => q.has(ITEM.alco));
        await q.walk('to hatch', [{ x: HATCH.x - 1, z: HATCH.z, tol: 1 }]);
        await useLoc('hatch', ITEM.alco, HATCH, () => q.has(ITEM.parrot), 15);
        await q.waitUntil(() => q.has(ITEM.parrot), 10);
        if (!q.has(ITEM.parrot)) await q.fail('no parrot');
        q.milestone('parrot');
        await falador();
    }
    if (from('sanfew')) {
        // 2. Sanfew (level 1 of his house): "Have you any more work for me...", "I'll do it." (10).
        await q.walk('to sanfew stairs', [{ x: SANFEW_STAIRS.x + 1, z: SANFEW_STAIRS.z + 1, tol: 1 }]);
        await q.climb('sanfew up', () => q.findLoc((l: any) => /stair/i.test(l.name) && l.distance <= 4), /climb-up|^climb$/i, () => lv() === 1);
        await q.talk('sanfew', /^sanfew$/i, [/any more work for me/i, /i'll do it/i], () => q.sawText(/thank you, adventurer/i), SANFEW, 60);
        q.milestone(10);
        await q.climb('sanfew down', () => q.findLoc((l: any) => /stair/i.test(l.name) && l.distance <= 4), /climb-down|^climb$/i, () => lv() === 0);
        await toStronghold();
    }
    if (from('leg1')) {
        // 3. Burntmeat first (20), out of the top exit, Eadgar twice (30, then the parrot: 50).
        await l0ToL1();
        await q.talk('burntmeat 1', /^burntmeat$/i, [], () => q.sawText(/go fetch that for you then/i), BURNTMEAT, 60);
        q.milestone(20);
        await l1Out();
        await thistle();
        await toEadgar();
        await eadgar('eadgar 1', [], () => q.sawText(/first of all, i will need a parrot/i));
        q.milestone(30);
        await eadgar('eadgar 2', [], () => q.sawText(/that's the plan/i));
        q.milestone(50);
    }
    if (from('rack1')) {
        // 4. The parrot under the rack in the prison (60).
        await eadgarToL1();
        await l1ToL0();
        await toRack();
        let t0 = q.s.tick();
        await useLoc('hide parrot', ITEM.parrot, RACK, () => msgSince(/hide the parrot/i, t0));
        q.milestone(60);
        await l0ToL1();
        await l1Out();
        await toEadgar();
    }
    if (from('items')) {
        // 5. Eadgar takes the logs, 10 grain and 5 chickens (70); the robe is still missing.
        await eadgar('eadgar items', [], () => q.cnt(ITEM.grain) === 0 && q.sawText(/you now need/i));
        q.milestone(70);
        await falador();
    }
    if (from('robe')) {
        // 6. Tegid: "Sanfew won't be happy..." gives the robe (queued).
        await q.talk('tegid', /^tegid$/i, [/sanfew won't be happy/i], () => q.has(ITEM.robe), TEGID, 60);
        q.milestone('robe');
        await toStronghold();
        await l0ToL1();
        await l1Out();
        await toEadgar();
    }
    if (from('potion')) {
        // 7. The robe (80), the ground thistle into the ranarr potion, the potion (85).
        await eadgar('eadgar robe', [], () => q.sawText(/back with that soon/i));
        q.milestone(80);
        await useItem('troll potion', ITEM.ground, ITEM.ranarr, () => q.has(ITEM.potion));
        await eadgar('eadgar potion', [], () => !q.has(ITEM.potion));
        q.milestone(85);
    }
    if (from('rack2')) {
        // 8. The parrot back from the rack (86), Eadgar's fake man (87, queued).
        await eadgarToL1();
        await l1ToL0();
        await toRack();
        await op('rack', RACK, () => q.has(ITEM.parrot), 10);
        await closeDlg();
        q.milestone(86);
        await l0ToL1();
        await l1Out();
        await toEadgar();
        await eadgar('eadgar parrot', [], () => q.has(ITEM.fakeMan));
        q.milestone(87);
    }
    if (from('fakeman')) {
        // 9. Burntmeat takes the fake man (90); the drawer's fake bottom holds the storeroom key.
        await eadgarToL1();
        await q.walk('to burntmeat', [{ x: BURNTMEAT.x, z: BURNTMEAT.z + 1, tol: 2 }]);
        await q.talk('burntmeat 2', /^burntmeat$/i, [/i'll be going now/i], () => q.has(ITEM.burnt), BURNTMEAT, 60);
        q.milestone(90);
        await q.walk('to drawers', [{ x: DRAWERS.x, z: DRAWERS.z + 1, tol: 1 }]);
        for (let i = 0; i < 4 && !q.has(ITEM.key); i++) {
            const d = q.findLoc((l: any) => /drawers/i.test(l.name) && Math.abs(l.x - DRAWERS.x) <= 2 && Math.abs(l.z - DRAWERS.z) <= 1);
            if (!d) { await q.waitTicks(1); continue; }
            await q.opLoc(d, q.opIndex(d, /search/i) === 1 && !(d.optionsWithIndex ?? []).some((o: any) => /search/i.test(o.text)) ? q.opIndex(d, /open/i) : q.opIndex(d, /search/i));
            await q.waitUntil(() => q.has(ITEM.key), 6);
        }
        if (!q.has(ITEM.key)) await q.fail('storeroom key');
        q.milestone('key');
    }
    if (from('store')) {
        // 10. Down the kitchen stairs, the storeroom door (100), the goutweed crate (the sleeping guard's club only
        // knocks the bot out after the goutweed is in the pack, quest_eadgar.rs2:557-575).
        await q.walk('to kitchen stairs', [{ x: L1_KITCHEN_DOWN.x, z: L1_KITCHEN_DOWN.z - 1, tol: 1 }]);
        await op('kitchen stairs', L1_KITCHEN_DOWN, () => lv() === 0);
        await q.walk('to store door', [{ x: STORE_DOOR.x, z: STORE_DOOR.z - 1, tol: 0 }]);
        const t0 = q.s.tick();
        await op('store door', STORE_DOOR, () => msgSince(/you unlock the door/i, t0) || z() >= STORE_DOOR.z);
        q.milestone(100);
        for (let i = 0; i < 4 && !q.has(ITEM.goutweed); i++) {
            await q.walk('to crate', [{ x: CRATE.x, z: CRATE.z + 1, tol: 0 }]);
            await op('crate', CRATE, () => q.has(ITEM.goutweed), 8, 2);
        }
        if (!q.has(ITEM.goutweed)) await q.fail('goutweed');
        q.milestone('goutweed');
        await q.waitTicks(4);
        await falador();
        await q.walk('to sanfew stairs 2', [{ x: SANFEW_STAIRS.x + 1, z: SANFEW_STAIRS.z + 1, tol: 1 }]);
        await q.climb('sanfew up 2', () => q.findLoc((l: any) => /stair/i.test(l.name) && l.distance <= 4), /climb-up|^climb$/i, () => lv() === 1);
        await q.talk('sanfew end', /^sanfew$/i, [], () => questDone, SANFEW, 60);
        await q.waitUntil(() => questDone, 10);
    }
    off();
    if (!questDone) await q.fail('no quest complete message');
    q.milestone(110);
    await q.end(true, 'qp=1');
} catch (e) {
    await q.fail(`error ${(e as Error).message}`);
}
