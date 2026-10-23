// Dragon Slayer from preset quest_dragon (beside the Guildmaster in the Champions' Guild), at the planner's state for
// the dragon row: every skill 99 (the row runs after the last 99), 32+ QP (varp 101; the guild door and
// dragon_journal.rs2:7). Reward: 466,250 Strength and 466,250 Defence at 25x (quest_dragon.rs2:31-32), 2 QP.
// Varp %dragonquest (176): 1 Guildmaster (guild_master.rs2), 2 Oziach (oziach.rs2; the same talk sets %dragon_shield,
// %dragon_oracle, %dragon_goblin and gives the maze key), 3 ship bought (klarense.rs2, 2,000 coins), 7 ship repaired
// (3 planks, 12 nails, hammer on the hull hole, lady_lumbridge.rs2), 8 map given to Ned (ned.rs2 give_map_to_ned),
// 9 sailed (dragonslayer_ned.rs2); Elvarg's death queues dragon_complete (elvarg.rs2:1-15).
// Map pieces: 1 Melzar's maze chest (melzars_maze.rs2, keys from 6 NPCs), 2 Wormbrain for 10,000 coins
// (wormbrain.rs2), 3 the chest behind the Oracle's magic door (magic_door.rs2: mind bomb, unfired bowl, lobster pot,
// silk). All quest items are untradeable (quest_dragon.obj); the shield is tradeable but only the Duke gives it.
// Combat: Elvarg breath max 70, 10 with the anti-dragon shield worn (elvarg.rs2 elvarg_max_hit); her melee is 0 under
// Protect from Melee. DS_FROM=<milestone> starts later (debug presets); DS_STOP=<milestone> ends early.
import { openQuest } from './quest-lib';

const GUILDMASTER = { x: 3191, z: 3362 };                 // guildmaster 198 (maps/m49_52.jm2 0 55 34)
const OZIACH = { x: 3068, z: 3517 };
const ORACLE = { x: 3014, z: 3501 };
const MINE_LADDER = { x: 3019, z: 3450 };                 // ladder down to 3019,9850 (quest-crest.ts BOOT_LADDER)
const MAGIC_DOOR = { x: 3051, z: 9840 };                  // dragon_slayer_magic_door 2586 (maps/m47_153.jm2 0 43 48)
const ORACLE_CHEST = { x: 3057, z: 9841 };                // oraclechestshut 2587 (m47_153.jm2 0 49 49)
const MAZE_DOOR = { x: 2941, z: 3248 };                   // melzardoor 2595 (m45_50.jm2 0 61 48)
const WORMBRAIN = { x: 3015, z: 3195 };
const KLARENSE = { x: 3044, z: 3203 };
const NED = { x: 3098, z: 3257 };
const DUKE = { x: 3210, z: 3220 };                        // level 1, Lumbridge castle
const CRANDOR_HOLE = { x: 2833, z: 3255 };                // crandor_rock_opening 2609 (m44_50.jm2 0 17 55), to 2833,9658
const ELVARG_GATE = { x: 2847, z: 9636 };                 // elvarg_gate_right 2607 / left 2608 (m44_150.jm2 0 31 36-37)
const ITEM = {
    melzarKey: 1542, red: 1543, orange: 1544, yellow: 1545, blue: 1546, magenta: 1547, green: 1548,
    part1: 1535, part2: 1536, part3: 1537, map: 1538, shield: 1540, plank: 960, nails: 1539, hammer: 2347,
    bomb: 1907, bowl: 1791, pot: 301, silk: 950, coins: 995, food: 379,
};
const NPC = { rat: 748, ghost: 749, skeleton: 750, zombie: 751, demon: 752, melzar: 753, elvarg: 742 };
const PFM = 14;                                            // protect_from_melee (sdk PRAYER_INDICES)

const q = await openQuest({ cap: 6000, eatAt: 60, food: [ITEM.food], lumbridgeOk: true });
try {
    const FROM = Number(process.env.DS_FROM || 0);
    const STOP = Number(process.env.DS_STOP || 99);
    let questDone = false;
    const offDone = q.s.onTick(() => { if (q.msgCount(/quest complete|completed the\s+dragon slayer/i) > 0) questDone = true; });
    const ms = async (k: number): Promise<void> => { q.milestone(k); if (k >= STOP) await q.end(true, `stopped at ${k}`); };
    const tele = (label: string, comp: string, x: number, z: number) => q.teleport(label, comp, x, z);
    const named = (re: RegExp, near?: { x: number; z: number }, r = 6) => q.findLoc(l => re.test(l.name) && (!near || Math.max(Math.abs(l.x - near.x), Math.abs(l.z - near.z)) <= r));
    const prayers = (): any => q.st()?.prayers;
    const pfmOn = (): boolean => !!prayers()?.activePrayers?.[PFM];
    const setPfm = async (on: boolean): Promise<void> => {
        if (pfmOn() === on) return;
        await q.step(`protect from melee ${on ? 'on' : 'off'}`, () => q.s.direct({ type: 'togglePrayer', prayerIndex: PFM, reason: 'SDK' }), () => pfmOn() === on, 3, 3);
    };
    // A dialog option chooser: each pattern is chosen once, highest priority first among the options shown.
    const picker = (prio: RegExp[]): RegExp => {
        // The same page can show for more than one tick after a click, so a page keeps its first choice.
        const asked = new Set<number>();
        let lastSig = '', lastPick = -1;
        return { test(t: string): boolean {
            const opts: string[] = (q.s.sdk.getDialog()?.options ?? []).map((o: any) => o.text);
            const sig = opts.join('|');
            if (sig !== lastSig && !opts.some(o => /click here to continue/i.test(o))) {
                let best = prio.findIndex((re, i) => !asked.has(i) && opts.some(o => re.test(o)));
                if (best < 0) { asked.clear(); best = prio.findIndex(re => opts.some(o => re.test(o))); }
                if (best >= 0) asked.add(best);
                lastSig = sig;
                lastPick = best;
            }
            return lastPick >= 0 && prio[lastPick]!.test(t);
        } } as unknown as RegExp;
    };
    const attack = (n: any) => q.s.direct({ type: 'interactNpc', npcIndex: n.index, optionIndex: n.optionsWithIndex?.find((o: any) => /attack/i.test(o.text))?.opIndex ?? 2, reason: 'SDK' });
    const npcId = (id: number): any => (q.st()?.nearbyNpcs ?? []).filter((n: any) => n.id === id).sort((a: any, b: any) => a.distance - b.distance)[0];
    const ground = (id: number): any => (q.st()?.groundItems ?? []).find((g: any) => g.id === id);
    const pickUp = async (label: string, id: number): Promise<void> => {
        await q.step(label, () => { const g = ground(id); return g ? q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' }) : q.waitTicks(1); }, () => q.has(id), 10, 5);
    };
    // Melee kill of the NPC with this config id; then its drop `drop` is picked up.
    const kill = async (label: string, id: number, drop?: number, ticks = 200): Promise<void> => {
        if (drop && q.has(drop)) return;
        if (!npcId(id)) await q.waitUntil(() => !!npcId(id), 20);
        const n0 = npcId(id);
        if (!n0) await q.fail(`${label}: no npc ${id}`);
        for (let t = 0; t < ticks; t++) {
            await q.guard(label);
            if (drop && ground(drop)) break;
            const n = (q.st()?.nearbyNpcs ?? []).find((x: any) => x.index === n0.index);
            if (!n) break;
            if (t % 4 === 0 && !(q.pos()?.targetIndex >= 0 && q.pos()?.targetIndex === n.index)) await attack(n);
            await q.waitTicks(1);
        }
        if (drop) {
            await q.waitUntil(() => !!ground(drop), 6);
            await pickUp(`${label} drop`, drop);
        }
    };
    // A shut chest opens on op 1 (loc_change to the open chest), and the open chest's "Search" gives the item.
    const searchChest = async (label: string, at: { x: number; z: number }, item: number): Promise<void> => {
        const chest = () => q.findLoc(l => /chest/i.test(l.name) && l.x === at.x && l.z === at.z);
        const isOpen = () => (chest()?.optionsWithIndex ?? []).some((o: any) => /search/i.test(o.text));
        for (let i = 0; i < 4 && !q.has(item); i++) {
            await q.guard(label);
            if (!isOpen()) await q.step(`${label} open`, () => { const c = chest(); return c ? q.opLoc(c, q.opIndex(c, /open/i)) : q.waitTicks(1); }, isOpen, 8, 3);
            const c = chest();
            if (c) await q.opLoc(c, q.opIndex(c, /search/i));
            // The mesbox "You find a map piece" comes before inv_add, so the page is clicked through first.
            await q.waitUntil(() => q.has(item) || q.dialogOpen(), 8);
            await q.converse([], () => q.has(item) && !q.dialogOpen(), 6);
            if (!q.has(item)) console.log(`WARN ${label}: ${JSON.stringify(chest()?.optionsWithIndex)} id=${chest()?.id} msgs=${(q.st()?.gameMessages ?? []).slice(-3).map((m: any) => m.text).join(' / ')}`);
        }
        if (!q.has(item)) await q.fail(label);
        if (q.dialogOpen()) await q.converse([], () => !q.dialogOpen(), 5);
    };
    const levelIs = (lv: number) => () => q.lvl() === lv;
    const ladder = (re: RegExp, at: { x: number; z: number }, r = 3) => () => q.findLoc(l => /ladder/i.test(l.name) && Math.max(Math.abs(l.x - at.x), Math.abs(l.z - at.z)) <= r && (l.optionsWithIndex ?? []).some((o: any) => re.test(o.text)));

    // 1. Guildmaster: "Do you know where I could get a Rune Plate mail body?" sets 1.
    if (FROM < 1) {
        await q.talk('guildmaster', /^guild ?master$/i, [/rune plate mail body/i], () => q.sawText(/oziach lives in a hut/i), GUILDMASTER, 40);
        await ms(1);
    }

    // 2. Oziach: the rune plate talk sets 2; the shield, map pieces 1-3 (the maze key) set the side varps.
    if (FROM < 2) {
        // The hut door (loc 1530 at 3070,3515, maps/m47_54.jm2 0 62 59) is on the south wall.
        // Oziach wanders out through the open door. The open door leaf then walls him into the pocket south of the hut
        // ("I can't reach that!" from 1 tile away in 2 of 5 proof runs), so the door is shut when he is outside and
        // open when he is inside.
        await q.walk('to oziach', [{ x: 3070, z: 3514, tol: 0 }]);
        const pick = picker([/sell me some rune plate/i, /guildmaster of the champions/i, /how am i meant to prove/i, /dragon, that sounds like fun/i,
            /antidragon shield/i, /where can i find this dragon/i, /first piece/i, /second piece/i, /third piece/i, /try and get everything together/i]);
        const oz = () => q.npc(/^oziach$/i);
        const openLeaf = () => q.findLoc(l => /door/i.test(l.name) && Math.max(Math.abs(l.x - 3070), Math.abs(l.z - 3515)) <= 1 && (l.optionsWithIndex ?? []).some((o: any) => /^close$/i.test(o.text)));
        const done2 = () => q.has(ITEM.melzarKey) && q.sawText(/fare ye well/i);
        for (let i = 0; i < 6 && !done2(); i++) {
            await q.guard('oziach');
            const n = oz();
            const inside = ((n?.tileZ ?? n?.z) ?? 3517) >= 3515;
            if (inside) await q.openDoor('oziach door', 3070, 3515);
            else if (openLeaf()) await q.step('close oziach door', () => { const d = openLeaf(); return d ? q.opLoc(d, q.opIndex(d, /^close$/i)) : undefined; }, () => !openLeaf(), 6, 2);
            const m = oz();
            if (m) await q.talkTo(m);
            await q.waitUntil(() => q.dialogOpen(), 8);
            if (q.dialogOpen()) { let shut = 0; await q.converse([pick], () => { shut = q.dialogOpen() ? 0 : shut + 1; return (done2() && !q.dialogOpen()) || shut >= 3; }, 120); }
            else console.log(`WARN oziach no dialog: npc ${m?.tileX ?? m?.x},${m?.tileZ ?? m?.z} inside=${inside} leaf=${!!openLeaf()}`);
        }
        if (!done2()) await q.fail('oziach');
        await ms(2);
    }

    // 3. The Oracle on Ice Mountain: "I seek a piece of the map" sets %dragon_oracle 2.
    if (FROM < 3) {
        await q.walk('to oracle', [{ x: ORACLE.x, z: ORACLE.z - 1, tol: 2 }]);
        await q.talk('oracle', /^oracle$/i, [/seek a piece of the map/i], () => q.sawText(/bowl that's not seen heat/i), ORACLE, 40);
        await ms(3);
    }

    // 4. Dwarven mine: the magic door takes the four items (from the west side), the chest gives map piece 3.
    if (FROM < 4) {
        if ((q.pos()?.worldZ ?? 0) < 9000) {
            await q.walk('to mine ladder', [{ x: MINE_LADDER.x, z: MINE_LADDER.z + 1, tol: 1 }]);
            const down = () => q.findLoc(l => /ladder|trapdoor/i.test(l.name) && Math.max(Math.abs(l.x - MINE_LADDER.x), Math.abs(l.z - MINE_LADDER.z)) <= 2);
            await q.climb('mine ladder down', down, /climb-down|open/i, () => (q.pos()?.worldZ ?? 0) > 9000, 5);
        }
        if ((q.pos()?.worldX ?? 0) < MAGIC_DOOR.x) {
            await q.walk('to magic door', [{ x: MAGIC_DOOR.x - 1, z: MAGIC_DOOR.z, tol: 0 }]);
            const door = () => q.findLoc(l => l.id === 2586 || (/door/i.test(l.name) && l.x === MAGIC_DOOR.x && l.z === MAGIC_DOOR.z));
            await q.step('magic door', () => { const d = door(); return d ? q.opLoc(d, 1) : q.waitTicks(1); }, () => !q.has(ITEM.silk) && (q.pos()?.worldX ?? 0) >= MAGIC_DOOR.x, 10, 4);
        }
        await searchChest('oracle chest', ORACLE_CHEST, ITEM.part3);
        await ms(4);
    }

    // 5-9. Melzar's maze (melzars_maze.rs2; rooms from vendor/quest-helper DragonSlayer.java zones). Each key NPC
    // drops its key; a key on its door disintegrates and open_and_close_door moves the player through.
    // Ground floor: rat (red key, door 2926,3253), ladder 2928,3256 up. Level 1: ghost (orange, door 2931,3253),
    // ladder 2934,3254 up. Level 2: skeleton (yellow, door 2924,3249), ladders down 2940,3240 and 2937,3240, then
    // funladdertop 2932,3240 to the basement. Basement: zombie (blue, door 2931,9643), Melzar (magenta, door
    // 2929,9652), lesser demon (green, door 2936,9655), chest 2935,9657.
    const doorAt = (x: number, z: number) => () => q.findLoc(l => l.x === x && l.z === z && /door/i.test(l.name));
    const keyDoor = async (label: string, key: number, x: number, z: number, from: { x: number; z: number }, through: () => boolean): Promise<void> => {
        await q.dash(`${label} approach`, from.x, from.z, 0, 25);
        if (!q.has(key) || !doorAt(x, z)()) console.log(`WARN ${label}: key=${q.has(key)} door=${JSON.stringify(doorAt(x, z)())} near=${q.locs().filter((l: any) => l.distance <= 3).map((l: any) => `${l.name}@${l.x},${l.z}`).join(' ')}`);
        await q.step(label, () => { const d = doorAt(x, z)(); return d ? q.useOnLoc(key, d) : q.waitTicks(1); }, through, 8, 4);
    };
    if (FROM < 5) {
        await tele('falador teleport', 'magic:falador_teleport', 2965, 3378);
        await q.walk('to maze', [{ x: MAZE_DOOR.x + 1, z: MAZE_DOOR.z, tol: 0 }]);
        await keyDoor('maze door', ITEM.melzarKey, MAZE_DOOR.x, MAZE_DOOR.z, { x: MAZE_DOOR.x + 1, z: MAZE_DOOR.z }, () => (q.pos()?.worldX ?? 99999) <= MAZE_DOOR.x - 1);
        await ms(5);
    }
    if (FROM < 6) {
        await kill('rat', NPC.rat, ITEM.red);
        await keyDoor('red door', ITEM.red, 2926, 3253, { x: 2927, z: 3253 }, () => (q.pos()?.worldX ?? 99999) <= 2925);
        await q.dash('to rat ladder', 2928, 3255, 1, 25);
        await q.climb('rat ladder up', ladder(/climb-up/i, { x: 2928, z: 3256 }), /climb-up/i, levelIs(1));
        await ms(6);
    }
    if (FROM < 7) {
        await kill('ghost', NPC.ghost, ITEM.orange);
        await keyDoor('orange door', ITEM.orange, 2931, 3253, { x: 2930, z: 3253 }, () => (q.pos()?.worldX ?? 0) >= 2931);
        await q.climb('ghost ladder up', ladder(/climb-up/i, { x: 2934, z: 3254 }), /climb-up/i, levelIs(2));
        await ms(7);
    }
    if (FROM < 8) {
        await kill('skeleton', NPC.skeleton, ITEM.yellow);
        await keyDoor('yellow door', ITEM.yellow, 2924, 3249, { x: 2924, z: 3250 }, () => (q.pos()?.worldZ ?? 99999) <= 3249);
        await q.dash('to ladder room', 2939, 3240, 1, 40);
        await q.climb('ladder down 2', ladder(/climb-down/i, { x: 2940, z: 3240 }), /climb-down/i, levelIs(1));
        await q.climb('ladder down 1', ladder(/climb-down/i, { x: 2937, z: 3240 }), /climb-down/i, levelIs(0));
        await q.climb('basement ladder', ladder(/climb-down/i, { x: 2932, z: 3240 }, 5), /climb-down/i, () => (q.pos()?.worldZ ?? 0) > 9000);
        await ms(8);
    }
    if (FROM < 9) {
        await setPfm(true);
        await kill('zombie', NPC.zombie, ITEM.blue);
        await keyDoor('blue door', ITEM.blue, 2931, 9643, { x: 2931, z: 9643 }, () => (q.pos()?.worldX ?? 99999) <= 2930);
        await kill('melzar', NPC.melzar, ITEM.magenta);
        await keyDoor('magenta door', ITEM.magenta, 2929, 9652, { x: 2929, z: 9651 }, () => (q.pos()?.worldZ ?? 0) >= 9652);
        await kill('demon', NPC.demon, ITEM.green);
        await keyDoor('green door', ITEM.green, 2936, 9655, { x: 2936, z: 9655 }, () => (q.pos()?.worldZ ?? 0) >= 9656);
        await searchChest('maze chest', { x: 2935, z: 9657 }, ITEM.part1);
        await setPfm(false);
        await ms(9);
    }

    // 10. The Duke on level 1 of Lumbridge castle gives the shield (%dragon_shield 1, duke_horacio.rs2:4-5, 59-64).
    const wear = async (label: string, id: number, slot: number): Promise<void> => {
        const worn = () => (q.st()?.equipment ?? []).some((e: any) => e.slot === slot && e.id === id);
        await q.step(label, () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(id)!, optionIndex: 2, reason: 'SDK' }), worn, 3, 3);
    };
    const stairs = (re: RegExp) => () => q.findLoc(l => /stair/i.test(l.name) && Math.max(Math.abs(l.x - 3205), Math.abs(l.z - 3209)) <= 3 && (l.optionsWithIndex ?? []).some((o: any) => re.test(o.text)));
    if (FROM < 10) {
        await tele('lumbridge teleport', 'magic:lumbridge_teleport', 3221, 3218);
        await q.walk('to castle stairs', [{ x: 3206, z: 3210, tol: 1 }]);
        await q.climb('castle stairs up', stairs(/climb-up/i), /climb-up/i, levelIs(1));
        // The Duke's door: loc 1536 at 3207,3222 level 1, east wall (maps/m50_50.jm2 1 7 22).
        await q.dash('to duke door', 3207, 3222, 0, 15);
        await q.openDoor('duke door', 3207, 3222);
        await q.dash('to duke', 3209, 3221, 1, 15);
        await q.talk('duke', /^duke horacio$/i, [/seek a shield/i], () => q.has(ITEM.shield), DUKE, 40);
        await wear('wear shield', ITEM.shield, 5);
        await q.climb('castle stairs down', stairs(/climb-down/i), /climb-down/i, levelIs(0));
        await ms(10);
    }

    // 11-12. Klarense sells the Lady Lumbridge (2,000 coins, stage 3); 3 planks with 4 nails each on the hull hole
    // (stage 7, lady_lumbridge.rs2 add_plank_to_ship_hole), which lifts the player one level.
    const gangplank = () => q.findLoc(l => /gangplank/i.test(l.name) && (l.optionsWithIndex ?? []).length > 0 && l.distance <= 8);
    const board = async (label: string): Promise<void> => {
        await q.walk(`${label} walk`, [{ x: 3047, z: 3204, tol: 1 }]);
        // The deck is level 1: from the dock the way up is the ship's ladder (loc 272 at 3049,3208); the quest's
        // gangplank (2593) is on level 1 (maps/m47_50.jm2 1 39 5) and is not shown from the dock.
        // The SDK loc list does not show it, so the click names the loc by id and tile.
        await q.step(label, () => q.opLoc({ id: 2593, x: 3047, z: 3205 }, 1), () => q.lvl() >= 1, 6, 4);
    };
    if (FROM < 11) {
        await q.walk('to klarense', [{ x: KLARENSE.x, z: KLARENSE.z, tol: 2 }]);
        const c0 = q.cnt(ITEM.coins);
        await q.talk('klarense', /^klarense$/i, [/could buy it/i, /yep, sounds good/i], () => q.cnt(ITEM.coins) <= c0 - 2000, KLARENSE, 40);
        await ms(11);
    }
    if (FROM < 12) {
        await board('board ship');
        await q.climb('ship ladder down', () => q.findLoc(l => /ladder/i.test(l.name) && l.distance <= 6 && (l.optionsWithIndex ?? []).some((o: any) => /climb-down/i.test(o.text))), /climb-down/i, () => (q.pos()?.worldZ ?? 0) > 9000);
        const hole = () => q.findLoc(l => /hole/i.test(l.name) && l.distance <= 6);
        for (let i = 0; i < 6 && q.has(ITEM.plank); i++) {
            const n0 = q.cnt(ITEM.plank);
            await q.step(`plank ${i}`, () => { const h = hole(); return h ? q.useOnLoc(ITEM.plank, h) : q.waitTicks(1); }, () => q.cnt(ITEM.plank) < n0, 6, 3);
            await q.converse([], () => !q.dialogOpen(), 4);
        }
        await q.waitUntil(() => q.lvl() === 2, 4);
        await q.climb('hull ladder up', () => q.findLoc(l => /ladder/i.test(l.name) && l.distance <= 6 && (l.optionsWithIndex ?? []).some((o: any) => /climb-up/i.test(o.text))), /climb-up/i, () => (q.pos()?.worldZ ?? 0) < 9000);
        await q.climb('disembark', gangplank, /cross|walk|disembark/i, () => q.lvl() === 0, 4);
        await ms(12);
    }

    // 13. Wormbrain in the Port Sarim jail sells piece 2 for 10,000 coins; the three pieces join into the map.
    if (FROM < 13) {
        // Jail door: loc 1530 at 3011,3197, south wall (maps/m47_49.jm2 0 3 61); the cells are east of the corridor.
        await q.walk('to jail', [{ x: 3011, z: 3197, tol: 0 }]);
        await q.openDoor('jail door', 3011, 3197);
        await q.dash('jail corridor', 3011, 3187, 1, 20);
        await q.talk('wormbrain', /^wormbrain$/i, [/piece of map that i need/i, /could pay you/i, /10,000 it is/i], () => q.has(ITEM.part2), WORMBRAIN, 50);
        await q.step('join map', () => q.useOnItem(ITEM.part1, ITEM.part2), () => q.has(ITEM.map), 4, 4);
        await q.converse([], () => !q.dialogOpen(), 4);
        await ms(13);
    }

    // 14. Ned in Draynor: the Crandor talk hires him; the map on him sets stage 8 (ned.rs2 give_map_to_ned).
    if (FROM < 14) {
        // Ned's door: loc 1530 at 3101,3258, east wall (maps/m48_50.jm2 0 29 58).
        await q.walk('to ned', [{ x: 3102, z: 3258, tol: 0 }]);
        await q.openDoor('ned door', 3101, 3258);
        await q.dash('into ned house', 3100, 3258, 1, 10);
        await q.talk('ned hire', /^ned$/i, [/could you take me to the island of crandor/i], () => q.sawText(/just show me the map/i), NED, 40);
        await q.step('map to ned', async () => { const n = q.npc(/^ned$/i); if (n) await q.useOnNpc(ITEM.map, n); }, () => !q.has(ITEM.map), 15, 3);
        await q.converse([], () => !q.dialogOpen(), 10);
        await ms(14);
    }

    // 15. The ship: with the map given and Ned hired the hull ladder goes to level 3, where Ned sails to Crandor.
    if (FROM < 15) {
        await board('board ship 2');
        await q.climb('ship ladder down 2', () => q.findLoc(l => /ladder/i.test(l.name) && l.distance <= 6 && (l.optionsWithIndex ?? []).some((o: any) => /climb-down/i.test(o.text))), /climb-down/i, () => (q.pos()?.worldZ ?? 0) > 9000);
        await q.talk('ned sail', /^ned$/i, [/yep lets go/i], () => q.near(2851, 3235, 8), { x: 3047, z: 9640 }, 60);
        // p_delay(11), then the crash mesbox and two chat pages (dragonslayer_ned.rs2:20-30).
        await q.converse([], () => q.sawText(/gee\.* you think/i) && !q.dialogOpen(), 30);
        await ms(15);
    }

    // 16. Crandor: down the hole, through the gate, Elvarg. Her melee is 0 under the prayer; the shield caps the
    // breath at 10. The quest completes on her death (last hit by the player, elvarg.rs2:1-15).
    if (FROM < 16) {
        if (!(q.st()?.equipment ?? []).some((e: any) => e.id === ITEM.shield) && q.has(ITEM.shield)) await wear('wear shield 2', ITEM.shield, 5);
        await setPfm(true);
        await q.walk('to crandor hole', [{ x: CRANDOR_HOLE.x + 1, z: CRANDOR_HOLE.z, tol: 1 }]);
        await q.climb('crandor hole', () => q.findLoc(l => l.id === 2609 || (/opening|hole|rock/i.test(l.name) && l.x === CRANDOR_HOLE.x && l.z === CRANDOR_HOLE.z)), /enter|climb|go/i, () => (q.pos()?.worldZ ?? 0) > 9000);
        await q.walk('to elvarg gate', [{ x: ELVARG_GATE.x - 1, z: ELVARG_GATE.z, tol: 0 }]);
        const gate = () => q.findLoc(l => /gate/i.test(l.name) && l.x === ELVARG_GATE.x && Math.abs(l.z - ELVARG_GATE.z) <= 1 && (l.optionsWithIndex ?? []).some((o: any) => /open/i.test(o.text)));
        await q.step('elvarg gate', () => { const g = gate(); return g ? q.opLoc(g, q.opIndex(g, /open/i)) : q.waitTicks(1); }, () => (q.pos()?.worldX ?? 0) >= ELVARG_GATE.x, 8, 4);
        await kill('elvarg', NPC.elvarg, undefined, 400);
        await q.waitUntil(() => questDone, 10);
        await setPfm(false);
        await ms(16);
    }

    offDone();
    await q.end(questDone, `qp=2 questMsg=${questDone}`);
} catch (e) { await q.fail(String(e)); }
