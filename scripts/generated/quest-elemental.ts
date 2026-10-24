// Elemental Workshop from preset quest_elemental (in the Seers' Village house beside the bookcase; every skill 99;
// knife, needle, leather, thread, hammer, rune pickaxe and 4 coal from a helper). Reward: 1 QP, 5,000 Crafting and
// 5,000 Smithing XP before 25x, the elemental shield (quest_elemental_workshop.rs2:272-278).
// Varp %elemental_workshop_bits (299) holds bits, no NPC talks: book read (1, elemental_workshop_shield_book.rs2:1-10),
// key cut from the spine (2, :12-24), the 2 valves and the water lever (3-5, quest_elemental_workshop.rs2:79-130), the
// bellows (6, :164-183), the lava in the furnace (7, :208-221), the air lever (9, :132-148), the shield at the workbench
// queues completion (:246-268).
import { openQuest } from './quest-lib';

const BOOKCASE = { id: 3389, x: 2716, z: 3481 };
const ODDWALL = { id: 3391, x: 2709, z: 3495 };            // the left half; the battered key opens the double door
const STAIRS_DOWN = { id: 3415, x: 2710, z: 3497 };        // -> 0_42_154_28_32 = 2716,9888
const BOX_BOWL = { id: 3394, x: 2717, z: 9894 };
const VALVE_R = { id: 3404, x: 2726, z: 9908 };            // valve 1 sets the right bit only while the left is off
const VALVE_L = { id: 3405, x: 2713, z: 9908 };
const WATER_LEVER = { id: 3406, x: 2722, z: 9906 };
const BELLOWS = { id: 3410, x: 2734, z: 9882 };
const AIR_LEVER = { id: 3409, x: 2734, z: 9887 };
const TROUGH = { id: 3414, x: 2714, z: 9871 };
const FURNACE = { id: 3413, x: 2724, z: 9874 };
const ROCK = { id: 3403, x: 2708, z: 9905 };
const BENCH = { id: 3402, x: 2717, z: 9887 };
const ITEM = { book: 2886, key: 2887, bowl: 2888, lava: 2889, shield: 2890, ore: 2892, bar: 2893, knife: 946, thread: 1734, leather: 1741, coal: 453 };

const q = await openQuest({ cap: 2000 });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const z = () => q.pos()?.worldZ ?? 0;
    const msg = (re: RegExp) => q.msgCount(re) > 0;
    const loc = (l: { id: number; x: number; z: number }) => q.locAt(l.x, l.z) ?? l;
    const near = async (label: string, l: { x: number; z: number }) => { if (!q.near(l.x, l.z, 2)) await q.walk(label, [{ x: l.x, z: l.z, tol: 2 }]); };

    // 1. The bookcase gives the book; read it (bit 1), close it; the knife on the book gives the key (bit 2).
    await q.step('bookcase', () => q.opLoc(loc(BOOKCASE), 1), () => q.has(ITEM.book), 10, 4);
    await q.step('read book', () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(ITEM.book)!, optionIndex: 1, reason: 'SDK' }), () => msg(/flip the book open/i), 4, 3);
    await q.s.direct({ type: 'closeModal', reason: 'SDK' });
    await q.step('cut book', () => q.useOnItem(ITEM.knife, ITEM.book), () => q.has(ITEM.key), 4, 3);
    q.milestone(2);

    // 2. Out of the house (door 2713,3483), the key on the odd wall north, the stairs down.
    await q.openDoor('house door', 2713, 3483);
    await q.walk('to odd wall', [{ x: 2713, z: 3482, tol: 0 }, { x: 2709, z: 3494, tol: 0 }]);
    // The key p_teleports the bot through the double door (open_and_close_double_doors.rs2:63-116); trial 1 stopped on
    // the door tile 2709,3495, so the step repeats until the bot is north of the wall.
    await q.step('key on wall', () => q.useOnLoc(ITEM.key, loc(ODDWALL)), () => z() >= 3496, 8, 5);
    await q.step('stairs down', () => q.opLoc(loc(STAIRS_DOWN), 1), () => z() > 9000, 10, 4);
    q.milestone(13);

    // 3. The stone bowl from the box; the right valve, then the left, then the water lever (bit 5).
    await near('to bowl box', BOX_BOWL);
    await q.step('bowl box', () => q.opLoc(loc(BOX_BOWL), 1), () => q.has(ITEM.bowl), 8, 4);
    await near('to right valve', VALVE_R);
    await q.step('right valve', () => q.opLoc(loc(VALVE_R), 1), () => q.msgCount(/you turn the handle/i) >= 1, 8, 4);
    await near('to left valve', VALVE_L);
    await q.step('left valve', () => q.opLoc(loc(VALVE_L), 1), () => q.msgCount(/you turn the handle/i) >= 2, 8, 4);
    await near('to water lever', WATER_LEVER);
    await q.step('water lever', () => q.opLoc(loc(WATER_LEVER), 1), () => msg(/water wheel starting up/i), 8, 3);
    q.milestone(5);

    // 4. The bellows (needle, leather, thread; bit 6) and the air lever (bit 9).
    await near('to bellows', BELLOWS);
    await q.step('fix bellows', () => q.opLoc(loc(BELLOWS), 1), () => !q.has(ITEM.leather), 8, 4);
    await near('to air lever', AIR_LEVER);
    await q.step('air lever', () => q.opLoc(loc(AIR_LEVER), 1), () => msg(/bellows pump air/i), 8, 3);
    q.milestone(9);

    // 5. Lava from the trough into the furnace lights it (bit 7; p_delay 4).
    await near('to trough', TROUGH);
    await q.step('fill bowl', () => q.useOnLoc(ITEM.bowl, loc(TROUGH)), () => q.has(ITEM.lava), 8, 4);
    await near('to furnace', FURNACE);
    await q.step('lava in furnace', () => q.useOnLoc(ITEM.lava, loc(FURNACE)), () => msg(/bursts in to life/i), 10, 4);
    q.milestone(7);

    // 6. Mining an elemental rock wakes an earth elemental (:185-206); its death drops the ore (elemental_earth.rs2:1-7).
    await near('to rock', ROCK);
    // Earth elementals also roam the mine and drop no ore (elemental_earth.rs2:9-27, trial 2 got 28,100 Attack XP and no ore), so the
    // bot attacks only the elemental that appears after its own Mine click.
    const elems = (): any[] => (q.st()?.nearbyNpcs ?? []).filter((n: any) => /^earth elemental$/i.test(n.name));
    const attack = (n: any) => q.s.direct({ type: 'interactNpc', npcIndex: n.index, optionIndex: n.optionsWithIndex?.find((o: any) => /attack/i.test(o.text))?.opIndex ?? 2, reason: 'SDK' });
    const ground = (): any => (q.st()?.groundItems ?? []).find((g: any) => g.id === ITEM.ore);
    let seen = new Set<number>(elems().map(n => n.index));
    let mine: number | undefined;
    for (let t = 0; t < 240 && !q.has(ITEM.ore); t++) {
        await q.guard('ore');
        const g = ground();
        const e = mine !== undefined ? elems().find(n => n.index === mine) : undefined;
        if (g) { if (t % 3 === 0) await q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' }); }
        else if (e) { if (t % 4 === 0) await attack(e); }
        else {
            const fresh = elems().find(n => !seen.has(n.index) && n.distance <= 2);
            if (fresh) { mine = fresh.index; console.log(`MILESTONE spawn ${q.T()}`); await attack(fresh); }
            else if (t % 5 === 0) { seen = new Set(elems().map(n => n.index)); mine = undefined; await q.opLoc(q.findLoc(l => l.id === ROCK.id) ?? ROCK, 1); }
        }
        await q.waitTicks(1);
    }
    if (!q.has(ITEM.ore)) await q.fail('no elemental ore');
    q.milestone('ore');

    // 7. The ore and 4 coal in the hot furnace give the bar; the bar on the workbench with the book and a hammer.
    await near('to furnace 2', FURNACE);
    await q.step('smelt', () => q.useOnLoc(ITEM.ore, loc(FURNACE)), () => q.has(ITEM.bar), 10, 4);
    await near('to bench', BENCH);
    await q.step('shield', () => q.useOnLoc(ITEM.bar, loc(BENCH)), () => q.has(ITEM.shield), 10, 4);
    await q.waitUntil(() => questDone, 10);
    q.milestone(100);
    off();
    await q.end(questDone, 'qp=1');
} catch (e) { await q.fail(String(e)); }
