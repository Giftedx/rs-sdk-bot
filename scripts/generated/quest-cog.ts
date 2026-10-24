// Clock Tower from preset quest_cog (beside Brother Kojo, north of the tower south of East Ardougne; every skill 99; a
// bucket of water from a helper). Reward: 1 QP, 500 coins (quest_cog.rs2:3-7).
// Varp %cogquest (10) bits 0-3: 1 after Kojo (brother_kojo.rs2:9-18 in quest_cog), +1 per cog on its spindle, 5 = all
// four, 8 = complete; bit 4 = the rat gate (quest_cog_food_trough.rs2:1-18). %cog_bits (35) holds one bit per cog
// (quest_cog_spindles.rs2). One cog is carried at a time (cogs.rs2:53-56). The cellar parts join only through one-way
// ladders (knowledge/transports.json), so each cog has its own way in and out:
// - black (2613,9639) and red (2583,9613): the tower ladder 2566,3242; black spindle 2570,9642 in the cellar, red
//   spindle 2568,3243 on level 0.
// - white (2577,9655): rat poison 2564,9662, lever 2591,9661 opens gate 2595,9657 (quest_cog_gates_and_levers.rs2:28-42),
//   poison on the trough 2586,9654 sets the gate bit, gate 2579,9656, out by ladder 2575,9655 -> 2575,3255; spindle
//   2567,3241 on level 2.
// - blue (2574,9633): ladder 2621,3261 east of the tower, push the wall 2575,9631 from the east, out by ladder
//   2572,9631 -> 2572,3231; spindle 2569,3240 on level 1.
// The black cog is red hot until a bucket of water is used on it (cogs.rs2:30-40, OPOBJU). The SDK has no
// item-on-ground-item action, so the script writes the OPOBJU packet on the lite client (OpObjUDecoder.ts: x, z, obj,
// useObj, useSlot, useCom). Ice gloves also cool it but are untradeable (knowledge/items.json id 1580).
import { openQuest } from './quest-lib';

const KOJO = { x: 2569, z: 3249 };
const LADDER_TOWER = { id: 1754, x: 2566, z: 3242 };
const LADDER_EAST = { id: 1754, x: 2621, z: 3261 };
const SPINDLE = { red: { id: 29, x: 2568, z: 3243 }, black: { id: 30, x: 2570, z: 9642 }, white: { id: 31, x: 2567, z: 3241 }, blue: { id: 32, x: 2569, z: 3240 } };
const COG_AT = { white: { x: 2577, z: 9655 }, black: { x: 2613, z: 9639 }, blue: { x: 2574, z: 9633 }, red: { x: 2583, z: 9613 } };
const POISON_AT = { x: 2564, z: 9662 };
const LEVER = { id: 33, x: 2591, z: 9661 };
const TROUGH = { id: 40, x: 2586, z: 9654 };
const GATE_C = { id: 39, x: 2579, z: 9656 };
const SECRET = { id: 1586, x: 2575, z: 9631 };
const STAIRS = { x: 2572, z: 3240 };
const ITEM = { white: 20, black: 21, blue: 22, red: 23, poison: 24, water: 1929, bucket: 1925 };
const OPOBJU = 55;      // webclient/src/io/ClientProt.ts
const INV_COM = 3214;

const q = await openQuest({ cap: 3000 });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const lv = () => q.lvl();
    const z = () => q.pos()?.worldZ ?? 0;
    const x = () => q.pos()?.worldX ?? 0;
    const ground = (id: number): any => (q.st()?.groundItems ?? []).filter((g: any) => g.id === id).sort((a: any, b: any) => q.cheb(a.x, a.z) - q.cheb(b.x, b.z))[0];
    const pickup = (label: string, id: number, ticks = 15, tries = 5) => q.step(label, () => { const g = ground(id); return g ? q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' }) : q.waitTicks(1); }, () => q.has(id), ticks, tries);
    const loc = (l: { id: number; x: number; z: number }) => q.locAt(l.x, l.z) ?? l;
    const near = async (label: string, p: { x: number; z: number }, tol = 1) => { if (!q.near(p.x, p.z, tol)) await q.walk(label, [{ x: p.x, z: p.z, tol }]); };
    const ladderAt = (lx: number, lz: number, re: RegExp) => () => q.findLoc(l => l.x === lx && l.z === lz && (l.optionsWithIndex ?? []).some((o: any) => re.test(o.text)));
    const stairs = (re: RegExp) => () => q.findLoc(l => Math.abs(l.x - STAIRS.x) <= 1 && Math.abs(l.z - STAIRS.z) <= 1 && (l.optionsWithIndex ?? []).some((o: any) => re.test(o.text)));
    const place = (label: string, cog: number, sp: { id: number; x: number; z: number }) => q.step(label, () => q.useOnLoc(cog, loc(sp)), () => !q.has(cog), 12, 4);
    // The tower's boarded-up closet door (2566,3237) never opens; the SDK plan treats it as open.
    q.blockDoor(0, 2566, 3237);
    // Tower doors (loc 1530, maps/m40_50.jm2): the entrance 2574,3250 (west wall) into Kojo's room, 2567,3245 (north
    // wall) from his room into the middle room with the ladder, the stairs and the spindles.
    const inTower = async (label: string) => {
        if (q.near(2575, 3250, 3) || x() >= 2575) { await near(`${label} entrance`, { x: 2575, z: 3250 }, 0); await q.openDoor(`${label} entrance door`, 2574, 3250); }
        await near(`${label} kojo room`, { x: 2567, z: 3246 }, 0);
        await q.openDoor(`${label} middle door`, 2567, 3245);
    };
    const outTower = async (label: string) => {
        await near(`${label} middle`, { x: 2567, z: 3245 }, 0);
        await q.openDoor(`${label} middle door`, 2567, 3245);
        await near(`${label} kojo room`, { x: 2573, z: 3250 }, 0);
        await q.openDoor(`${label} entrance door`, 2574, 3250);
    };

    // 1. Brother Kojo: "OK old monk, what can I do?" sets 1.
    await q.talk('kojo', /^brother kojo$/i, [/ok old monk/i], () => q.sawText(/remember to be careful/i), KOJO, 60);
    q.milestone(1);
    await inTower('start');

    // 2. Tower ladder down; the black cog: water on it, take it, the black spindle beside the ladder.
    await q.climb('tower ladder down', ladderAt(LADDER_TOWER.x, LADDER_TOWER.z, /climb-down/i), /climb-down/i, () => z() > 9000);
    await q.walk('to black cog', [{ x: 2578, z: 9642, tol: 2 }, { x: 2594, z: 9645, tol: 2 }, { x: 2609, z: 9638, tol: 2 }, { x: COG_AT.black.x - 1, z: COG_AT.black.z, tol: 1 }]);
    const c: any = (q.s as any).client;
    await q.step('water on cog', () => {
        const slot = q.slot(ITEM.water);
        if (slot === undefined || !c?.writeOpcode) return q.waitTicks(1);
        c.writeOpcode(OPOBJU);
        c.out.p2(COG_AT.black.x); c.out.p2(COG_AT.black.z); c.out.p2(ITEM.black);
        c.out.p2(ITEM.water); c.out.p2(slot); c.out.p2(INV_COM);
        return undefined;
    }, () => q.has(ITEM.bucket) || q.sawText(/pour water over the cog/i), 8, 4);
    if (q.dialogOpen()) await q.converse([], () => !q.dialogOpen(), 6);
    await pickup('black cog', ITEM.black);
    await q.walk('black back', [{ x: 2601, z: 9638, tol: 2 }, { x: 2594, z: 9645, tol: 2 }, { x: 2578, z: 9642, tol: 2 }, { x: 2571, z: 9643, tol: 1 }]);
    await place('black spindle', ITEM.black, SPINDLE.black);
    q.milestone('black');

    // 3. The red cog far south, then up the ladder to the red spindle on level 0.
    await q.walk('to red cog', [{ x: 2578, z: 9646, tol: 2 }, { x: 2584, z: 9640, tol: 2 }, { x: 2584, z: 9625, tol: 2 }, { x: 2593, z: 9617, tol: 2 }, { x: 2590, z: 9609, tol: 2 }, { x: 2584, z: 9612, tol: 1 }]);
    await pickup('red cog', ITEM.red);
    await q.walk('red back', [{ x: 2590, z: 9609, tol: 2 }, { x: 2593, z: 9617, tol: 2 }, { x: 2584, z: 9625, tol: 2 }, { x: 2584, z: 9640, tol: 2 }, { x: 2578, z: 9646, tol: 2 }, { x: 2567, z: 9643, tol: 1 }]);
    await q.climb('ladder up red', ladderAt(LADDER_TOWER.x, LADDER_TOWER.z + 6400, /climb-up/i), /climb-up/i, () => z() < 9000);
    await place('red spindle', ITEM.red, SPINDLE.red);
    q.milestone('red');

    // 4. Down again: rat poison, the lever, poison on the trough, the gate, the white cog, the north ladder out.
    await q.climb('tower ladder down 2', ladderAt(LADDER_TOWER.x, LADDER_TOWER.z, /climb-down/i), /climb-down/i, () => z() > 9000);
    await q.walk('to poison', [{ x: 2578, z: 9648, tol: 2 }, { x: 2573, z: 9651, tol: 2 }, { x: 2565, z: 9653, tol: 2 }, { x: 2562, z: 9659, tol: 2 }, { x: POISON_AT.x, z: POISON_AT.z, tol: 1 }]);
    await pickup('poison', ITEM.poison);
    await q.walk('to lever', [{ x: 2566, z: 9659, tol: 2 }, { x: 2577, z: 9659, tol: 2 }, { x: LEVER.x, z: LEVER.z, tol: 1 }]);
    await q.step('lever', () => q.opLoc(loc(LEVER), 1), () => !!q.findLoc(l => l.x === LEVER.x && l.z === LEVER.z && l.id === 35), 8, 4);
    await q.walk('to trough', [{ x: 2596, z: 9660, tol: 1 }, { x: 2596, z: 9657, tol: 1 }, { x: 2588, z: 9656, tol: 1 }]);
    await q.step('poison trough', () => q.useOnLoc(ITEM.poison, loc(TROUGH)), () => !q.has(ITEM.poison), 10, 4);
    q.milestone('trough');
    await near('to rat gate', { x: GATE_C.x, z: GATE_C.z }, 0);
    await q.step('rat gate', async () => { if (q.dialogOpen()) return q.converse([], () => !q.dialogOpen(), 4); return q.opLoc(loc(GATE_C), 1); }, () => x() <= GATE_C.x - 1, 8, 6);
    if (q.dialogOpen()) await q.converse([], () => !q.dialogOpen(), 6);
    await pickup('white cog', ITEM.white);
    await q.climb('north ladder up', ladderAt(2575, 9655, /climb-up/i), /climb-up/i, () => z() < 9000);
    await q.walk('to tower', [{ x: 2575, z: 3251, tol: 1 }]);
    await inTower('white');
    await q.walk('to stairs', [{ x: 2570, z: 3243, tol: 1 }, { x: 2571, z: 3241, tol: 1 }]);
    await q.climb('stairs 0-1', stairs(/climb-up/i), /climb-up/i, () => lv() === 1);
    await q.climb('stairs 1-2', stairs(/climb-up/i), /climb-up/i, () => lv() === 2);
    await place('white spindle', ITEM.white, SPINDLE.white);
    q.milestone('white');

    // 5. Down, east to the ladder 2621,3261, the tunnel to the secret wall, the blue cog, out by 2572,9631.
    await q.climb('stairs 2-1', stairs(/climb-down/i), /climb-down/i, () => lv() === 1);
    await q.climb('stairs 1-0', stairs(/climb-down/i), /climb-down/i, () => lv() === 0);
    await outTower('blue');
    await q.walk('to east ladder', [{ x: 2576, z: 3250, tol: 1 }, { x: 2587, z: 3249, tol: 2 }, { x: 2600, z: 3247, tol: 2 }, { x: 2611, z: 3256, tol: 2 }, { x: 2621, z: 3257, tol: 2 }, { x: LADDER_EAST.x, z: LADDER_EAST.z - 1, tol: 1 }]);
    await q.climb('east ladder down', ladderAt(LADDER_EAST.x, LADDER_EAST.z, /climb-down/i), /climb-down/i, () => z() > 9000);
    await q.walk('blue tunnel', [{ x: 2613, z: 9655, tol: 2 }, { x: 2616, z: 9640, tol: 2 }, { x: 2610, z: 9631, tol: 2 }, { x: 2608, z: 9618, tol: 2 }, { x: 2606, z: 9609, tol: 2 },
        { x: 2600, z: 9606, tol: 2 }, { x: 2590, z: 9601, tol: 2 }, { x: 2580, z: 9601, tol: 2 }, { x: 2580, z: 9615, tol: 2 }, { x: 2580, z: 9628, tol: 2 }, { x: 2576, z: 9631, tol: 0 }]);
    await q.step('push wall', () => q.opLoc(loc(SECRET), q.opIndex(q.locAt(SECRET.x, SECRET.z), /push/i)), () => x() <= SECRET.x, 8, 5);
    await pickup('blue cog', ITEM.blue);
    await q.climb('blue ladder up', ladderAt(2572, 9631, /climb-up/i), /climb-up/i, () => z() < 9000);
    await q.walk('to tower 2', [{ x: 2577, z: 3231, tol: 1 }, { x: 2577, z: 3248, tol: 1 }, { x: 2575, z: 3250, tol: 0 }]);
    await inTower('blue');
    await q.walk('to stairs 2', [{ x: 2570, z: 3243, tol: 1 }, { x: 2571, z: 3241, tol: 1 }]);
    await q.climb('stairs 0-1 b', stairs(/climb-up/i), /climb-up/i, () => lv() === 1);
    await place('blue spindle', ITEM.blue, SPINDLE.blue);
    q.milestone('blue');

    // 6. Down and back to Kojo for the reward.
    await q.climb('stairs 1-0 b', stairs(/climb-down/i), /climb-down/i, () => lv() === 0);
    await near('to middle door', { x: 2567, z: 3244 }, 0);
    await q.openDoor('middle door end', 2567, 3245);
    await q.talk('kojo end', /^brother kojo$/i, [], () => questDone, KOJO, 40);
    await q.waitUntil(() => questDone, 10);
    q.milestone(100);
    off();
    await q.end(questDone, 'qp=1');
} catch (e) { await q.fail(String(e)); }
