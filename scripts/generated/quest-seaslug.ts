// NOT PROVEN (2026-10-24): stops at the broken glass, see research/quest-plan.md section 1n.
// Sea Slug from preset quest_seaslug (beside Caroline), at the planner's state for the rival-seaslug row (tick
// 24,985; Firemaking 99, Fishing 1). Reward: 71,750 Fishing (x25: 179,375), 1 QP (caroline.rs2:33-48).
// Varp %seaslugquest (159, quest_seaslug.constant): 1 Caroline; 2 Holgart wants swamp paste; 3 the paste (helper item
// 1941), Holgart rows to the platform (holgart_ardougne.rs2:93-117); 4 Kennith, shouted to across the wall upstairs
// (kennith.rs2, quest_seaslug.rs2 kennithwall); 5 Holgart rows to the island (holgart_platform.rs2:83-89); 6 Kent
// (kent.rs2), then Holgart back to the platform; 7 the dry sticks rubbed with the torch in the pack (Firemaking 30,
// quest_seaslug.rs2:42-63); 8 Kennith; 9 kick the loose panel; 10 Kennith; 11 rotate the crane; Holgart to the shore;
// Caroline. The ladder up needs a lit torch from stage 6 (quest_seaslug.rs2:65-79). The boat from Ardougne (and from
// the island) puts a lit torch out (holgart_ardougne.rs2:152-167), so the torch is lit after the island.
// Paths below are under vendor/rs-sdk/server/content/scripts/.
import { openQuest } from './quest-lib';
import { componentId } from '../../packages/core/src/logout';

const CAROLINE = { x: 2716, z: 3302 };
const HOLGART_LAND = { x: 2720, z: 3306 };
const PLATFORM = { x: 2782, z: 3273 };                     // ^seaslug_platform_coord
const ISLAND = { x: 2800, z: 3320 };                       // ^seaslug_island_coord
const SHORE = { x: 2722, z: 3305 };                        // ^seaslug_shore_coord
const LADDER = { x: 2784, z: 3286 };                       // slugladder (2517), maps/m43_51.jm2
const WALL = { x: 2764, z: 3287 };                         // kennithwall (2519)
const PANEL = { x: 2765, z: 3288 };                        // loosepanel (2518)
const CRANE = { x: 2768, z: 3286 };                        // fishingcrane (2520), 4x4; used from z >= 3289
const STICKS = { x: 2784, z: 3289 };                       // damp sticks (1467) spawn
const GLASS = [{ x: 2765, z: 3278 }, { x: 2765, z: 3289 }]; // broken glass (1469) spawns
const ITEM = { paste: 1941, torch: 596, lit: 594, damp: 1467, glass: 1469, dry: 1468, food: 379 };

const q = await openQuest({ cap: 2000, eatAt: 40, food: [ITEM.food] });
try {
    let questDone = false;
    const offDone = q.s.onTick(() => { if (q.msgCount(/quest complete|completed the\s+sea slug/i) > 0) questDone = true; });
    const ground = (id: number): any => (q.st()?.groundItems ?? []).filter((g: any) => g.id === id).sort((a: any, b: any) => (a.distance ?? 0) - (b.distance ?? 0))[0];
    const pickUp = async (label: string, id: number): Promise<void> => {
        if (q.has(id)) return;
        await q.step(label, () => { const g = ground(id); return g ? q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' }) : q.waitTicks(1); }, () => q.has(id), 15, 5);
    };
    const listLocs = (r = 6) => q.locs().filter((l: any) => l.distance <= r).map((l: any) => `${l.name}#${l.id}@${l.x},${l.z}:${(l.optionsWithIndex ?? []).map((o: any) => o.text).join('/')}`).join(' ');
    const ladder = (re: RegExp) => () => q.findLoc(l => /ladder/i.test(l.name) && l.distance <= 12 && (l.optionsWithIndex ?? []).some((o: any) => re.test(o.text)));
    const locOp = async (label: string, id: number, at: { x: number; z: number }, ok: () => boolean, ticks = 12): Promise<void> => {
        await q.step(label, () => {
            const l = q.findLoc(l => l.id === id || (l.x === at.x && l.z === at.z && (l.optionsWithIndex ?? []).length > 0));
            if (!l) { console.log(`WARN ${label}: no loc; ${listLocs()}`); return q.waitTicks(1); }
            return q.opLoc(l, 1);
        }, ok, ticks, 4);
    };
    const shout = async (label: string, ok: () => boolean): Promise<void> => {
        await q.walk(`to wall ${label}`, [{ x: WALL.x, z: WALL.z + 2, tol: 1 }]);
        await locOp(`shout ${label}`, 2519, WALL, () => q.dialogOpen() || ok(), 10);
        await q.converse([], () => ok() && !q.dialogOpen(), 30);
        if (!ok()) await q.fail(`shout ${label}`);
    };

    // 1-3. Caroline; Holgart twice (the paste); the row boat to the platform.
    await q.talk('caroline 1', /^caroline$/i, [/i suppose so/i], () => q.sawText(/i'll reward you for your time/i), CAROLINE, 40);
    q.milestone(1);
    await q.talk('holgart 1', /^holgart$/i, [], () => q.sawText(/i'll give you a ride in my boat/i), HOLGART_LAND, 40);
    q.milestone(2);
    await q.talk('holgart 2', /^holgart$/i, [/okay, lets do it/i], () => q.near(PLATFORM.x, PLATFORM.z, 6), HOLGART_LAND, 40);
    await q.converse([], () => !q.dialogOpen(), 10);
    q.milestone(3);

    // The damp sticks and the broken glass on the platform; dried at once (no stage check, quest_seaslug.rs2:29-40).
    await q.walk('to sticks', [{ x: STICKS.x, z: STICKS.z, tol: 1 }]);
    await pickUp('damp sticks', ITEM.damp);
    // Broken glass: both spawns (2765,3278 in the kitchen, 2765,3289 under Kennith's room) are "I can't reach that!"
    // for a walk-up pickup, also with the room doors (loc_1533 2765,3277 and 2765,3287) open (test runs t1-t10:
    // the server leaves the bot on 2766,3287), and the groundItems entries say reachable=false. Telekinetic Grab
    // (Magic 33, 1 air + 1 law, skill_magic/scripts/spells/telegrab.rs2) takes it from the pier outside.
    await q.walk('to glass window', [{ x: 2766, z: 3289, tol: 0 }]);
    const TELEGRAB = componentId('magic:telekinetic_grab');
    for (let i = 0; i < 4 && !q.has(ITEM.glass); i++) {
        await q.guard('telegrab');
        const g = (q.st()?.groundItems ?? []).filter((g: any) => g.id === ITEM.glass).sort((a: any, b: any) => a.distance - b.distance)[0];
        if (!g) { await q.waitTicks(1); continue; }
        const r: any = await q.s.direct({ type: 'spellOnGroundItem', x: g.x, z: g.z, itemId: g.id, spellComponent: TELEGRAB, reason: 'SDK' });
        await q.waitUntil(() => q.has(ITEM.glass), 8);
        if (!q.has(ITEM.glass)) console.log(`WARN telegrab ${i}: ${JSON.stringify(r)?.slice(0, 160)} msgs=${(q.st()?.gameMessages ?? []).slice(-2).map((m: any) => m.text).join(' / ')}`);
    }
    await pickUp('broken glass', ITEM.glass);
    await q.step('dry sticks', () => q.useOnItem(ITEM.glass, ITEM.damp), () => q.has(ITEM.dry), 6, 3);
    q.milestone('sticks');

    // 4. Up the ladder (free before stage 6), shout across to Kennith, down again.
    await q.walk('to ladder', [{ x: LADDER.x, z: LADDER.z - 1, tol: 1 }]);
    await q.climb('ladder up 1', ladder(/climb-up/i), /climb-up/i, () => q.lvl() === 1);
    await shout('1', () => q.sawText(/try and find your father/i));
    q.milestone(4);
    await q.climb('ladder down 1', ladder(/climb-down/i), /climb-down/i, () => q.lvl() === 0);

    // 5-6. Holgart to the island; Kent; Holgart back.
    await q.talk('holgart platform', /^holgart$/i, [], () => q.near(ISLAND.x, ISLAND.z, 8), PLATFORM, 40);
    await q.converse([], () => !q.dialogOpen(), 10);
    q.milestone(5);
    await q.talk('kent', /^kent$/i, [], () => q.sawText(/thanks kent/i), { x: 2793, z: 3321 }, 60);
    q.milestone(6);
    await q.talk('holgart island', /^holgart$/i, [], () => q.near(PLATFORM.x, PLATFORM.z, 6), ISLAND, 40);
    await q.converse([], () => !q.dialogOpen(), 10);

    // 7. Rub the dry sticks with the torch in the pack (stat_random(firemaking, 64, 512): at 99 it rarely fails).
    for (let i = 0; i < 6 && !q.has(ITEM.lit); i++) {
        await q.guard('light torch');
        if (!q.has(ITEM.dry)) await q.fail('no dry sticks');
        await q.s.direct({ type: 'useInventoryItem', slot: q.slot(ITEM.dry)!, optionIndex: 1, reason: 'SDK' });
        await q.waitUntil(() => q.has(ITEM.lit) || q.msgCount(/smoke momentarily then die out\.$/i) > i, 6);
    }
    if (!q.has(ITEM.lit)) await q.fail('torch not lit');
    q.milestone(7);

    // 8-11. Upstairs: Kennith, the panel, Kennith, the crane.
    await q.walk('to ladder 2', [{ x: LADDER.x, z: LADDER.z - 1, tol: 1 }]);
    await q.climb('ladder up 2', ladder(/climb-up/i), /climb-up/i, () => q.lvl() === 1);
    await shout('2', () => q.sawText(/figure another way to get you out/i));
    q.milestone(8);
    await q.walk('to panel', [{ x: PANEL.x + 1, z: PANEL.z, tol: 1 }]);
    await locOp('kick panel', 2518, PANEL, () => q.msgCount(/crumbles away/i) > 0, 12);
    q.milestone(9);
    await shout('3', () => q.sawText(/when you have i'll come out/i));
    q.milestone(10);
    await q.walk('to crane', [{ x: CRANE.x + 1, z: CRANE.z + 3, tol: 1 }]);
    await locOp('crane', 2520, CRANE, () => q.msgCount(/lower kennith to the row boat/i) > 0, 15);
    q.milestone(11);
    await q.climb('ladder down 2', ladder(/climb-down/i), /climb-down/i, () => q.lvl() === 0);

    // Holgart to the shore; Caroline.
    await q.talk('holgart home', /^holgart$/i, [], () => q.near(SHORE.x, SHORE.z, 6), PLATFORM, 40);
    await q.converse([], () => !q.dialogOpen(), 10);
    await q.talk('caroline 2', /^caroline$/i, [], () => questDone, CAROLINE, 60);
    await q.waitUntil(() => questDone, 10);
    q.milestone('complete');
    offDone();
    await q.end(questDone, `qp=1 questMsg=${questDone}`);

} catch (e) { await q.fail(String(e)); }
