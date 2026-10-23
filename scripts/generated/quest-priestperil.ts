// Priest in Peril from preset quest_priestperil (Varrock palace beside King Roald; every skill 99; a bucket, two Varrock
// teleports, 23 rune essence in the pack and 27 in the bank). Reward: 1 QP, 1,406 Prayer XP before 25x, the wolfbane
// dagger (quests/quest_priestperil/scripts/priestperil.rs2:7-11).
// Varp %priestperil (302, priestperil.constant): 1 Roald, 2 the temple door knock, 3 the temple guardian killed,
// 4 Roald again (the temple doors open), 5 Drezel through the cell door, 6 the iron key on the cell door, 7 the
// blessed water on the coffin, 8 Drezel, 10 Drezel in the mausoleum, 10-60 one per rune essence, then the completion.
// Server truth: areas/area_varrock/scripts/king_roald.rs2:39-81, quests/quest_priestperil/scripts/temple_doors.rs2,
// trapped_drezel.rs2, evil_monks.rs2:52-56 (the golden key drop), vampire_coffin.rs2, areas/area_mausoleum/scripts/
// temple_guardian.rs2, gates.rs2, monuments.rs2, well.rs2, drezel.rs2.
import { openQuest } from './quest-lib';

const ROALD = { x: 3218, z: 3475 };                        // he stands west of the throne room wall (spawn 3222,3476)
const TEMPLE_DOOR = { id: 3489, x: 3408, z: 3489 };        // priestperiltempledoorl (r: 3490 at 3408,3488), east edge
const NORTH_TRAPDOOR = { id: 1568, x: 3405, z: 3507 };     // trapdoor north of the temple -> dog corridor
const DOG = { x: 3405, z: 9902 };
const CELLAR_LADDER = { id: 1755, x: 3405, z: 9907 };
const GATE1 = { id: 3444, x: 3405, z: 9895 };              // pip_underground_door1, opens at 5 (gates.rs2:1-2)
const GATE2 = { id: 3445, x: 3431, z: 9897 };              // pip_underground_door2, opens at 8 (gates.rs2:4-5)
const WELL = { id: 3485, x: 3423, z: 9890 };
const DREZEL2 = { x: 3440, z: 9895 };
const STAIRS_UP = { id: 1738, x: 3417, z: 3484 };          // spiralstairs, level 0 -> 1
const LADDER_UP = { id: 1747, x: 3410, z: 3485 };          // level 1 -> 2
const CELL = { id: 3463, x: 3415, z: 3489 };               // pip_prisondoor, level 2, east edge; Drezel inside
const DREZEL = { x: 3417, z: 3489 };
const COFFIN = { id: 3480, x: 3413, z: 3486 };
const BANK = { x: 3253, z: 3420 };                         // Varrock east bank booths 2213 at 3252-3256,3419
// Monuments priestperil_grave_base1..7 (3493-3499), nearest first from gate 1. The iron key lies in one of them (a
// random layout, monuments.rs2:31-33); the golden key swaps only there (monuments.rs2:52-66).
const MONUMENTS = [
    { id: 3493, x: 3416, z: 9890 }, { id: 3499, x: 3418, z: 9894 }, { id: 3494, x: 3423, z: 9895 }, { id: 3496, x: 3423, z: 9884 },
    { id: 3497, x: 3427, z: 9894 }, { id: 3495, x: 3428, z: 9890 }, { id: 3498, x: 3427, z: 9885 },
];
const ITEM = { bucket: 1925, ess: 1436, goldKey: 2944, ironKey: 2945, murky: 2953, blessed: 2954, dagger: 2952 };

const q = await openQuest({ cap: 4000 });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const under = () => (q.pos()?.worldZ ?? 0) > 9000;
    const x = () => q.pos()?.worldX ?? 0;
    const z = () => q.pos()?.worldZ ?? 0;
    const roald = /^king roald$/i;
    // East of Varrock the SDK plans past lockeddoor1 at 3268,3435 (maps/m51_53.jm2); the server does not let the bot
    // through there, and the walk stalled for 251 ticks in two trials (the walker clicks the locked door). These
    // waypoints take the planner's other way out, east of the castle-side fence (3275-3285,3428).
    const EAST = [{ x: 3272, z: 3421, tol: 2 }, { x: 3282, z: 3428, tol: 2 }, { x: 3285, z: 3442, tol: 2 }];

    // A door or gate that walks the bot through when opened (open_and_close_metal_gate, double_door2).
    const cross = async (label: string, l: { id: number; x: number; z: number }, op: RegExp, through: () => boolean): Promise<void> => {
        await q.step(label, () => { const k = q.locAt(l.x, l.z) ?? l; return q.opLoc(k, q.opIndex(k, op)); }, through, 12, 5);
    };
    const kill = async (label: string, pick: () => any, done: () => boolean, ticks = 80): Promise<void> => {
        for (let i = 0; i < 6 && !done(); i++) {
            await q.guard(label);
            const n = pick();
            if (!n) { await q.waitTicks(2); continue; }
            await q.s.bot.attack(n as any);
            await q.waitUntil(() => done() || !(q.st()?.nearbyNpcs ?? []).some((m: any) => m.index === n.index), ticks);
        }
        if (!done()) await q.fail(`kill ${label}`);
    };
    const toTrapdoor = async (label: string): Promise<void> => {
        await q.walk(`${label} to trapdoor`, [...(x() < 3290 ? EAST : []), { x: NORTH_TRAPDOOR.x, z: NORTH_TRAPDOOR.z - 1, tol: 1 }]);
        await q.climb(`${label} trapdoor`, () => q.locAt(NORTH_TRAPDOOR.x, NORTH_TRAPDOOR.z) ?? NORTH_TRAPDOOR, /climb-down|^open$/i, under, 6);
    };
    const upCellar = async (label: string): Promise<void> => {
        await q.walk(`${label} to cellar ladder`, [{ x: CELLAR_LADDER.x, z: CELLAR_LADDER.z - 1, tol: 1 }]);
        await q.climb(`${label} cellar ladder`, () => q.locAt(CELLAR_LADDER.x, CELLAR_LADDER.z) ?? CELLAR_LADDER, /climb-up/i, () => !under());
    };
    const intoTemple = async (label: string): Promise<void> => {
        await q.walk(`${label} to temple`, [...(x() < 3290 ? EAST : []), { x: TEMPLE_DOOR.x - 1, z: TEMPLE_DOOR.z, tol: 1 }]);
        await cross(`${label} temple door`, TEMPLE_DOOR, /^open$/i, () => x() >= TEMPLE_DOOR.x + 1 && !under());
    };
    const upToDrezel = async (label: string): Promise<void> => {
        await q.climb(`${label} stairs up`, () => q.findLoc(l => l.id === STAIRS_UP.id && l.distance <= 12) ?? STAIRS_UP, /climb-up|^climb$/i, () => q.lvl() === 1);
        await q.climb(`${label} ladder up`, () => q.findLoc(l => l.id === LADDER_UP.id && l.distance <= 12) ?? LADDER_UP, /climb-up/i, () => q.lvl() === 2);
    };
    const downFromDrezel = async (label: string): Promise<void> => {
        await q.climb(`${label} ladder down`, () => q.findLoc(l => /ladder/i.test(l.name) && l.distance <= 12), /climb-down/i, () => q.lvl() === 1);
        await q.climb(`${label} stairs down`, () => q.findLoc(l => /stair/i.test(l.name) && l.distance <= 12), /climb-down|^climb$/i, () => q.lvl() === 0);
    };

    // 1. King Roald: "Sure." sets 1 (king_roald.rs2:46-55, priestperil.rs2:1-5).
    await q.talk('roald 1', roald, [/^sure\.?$/i], () => q.sawText(/many thanks adventurer/i), ROALD, 60);
    q.milestone(1);
    // 2. The temple door, Knock-at: "Roald sent me to check on Drezel.", "Sure." sets 2 (temple_doors.rs2:22-31,63-82).
    await q.walk('to temple', [...EAST, { x: TEMPLE_DOOR.x - 1, z: TEMPLE_DOOR.z, tol: 1 }]);
    await q.step('knock', () => { const k = q.locAt(TEMPLE_DOOR.x, TEMPLE_DOOR.z) ?? TEMPLE_DOOR; return q.opLoc(k, q.opIndex(k, /knock/i)); }, () => q.dialogOpen(), 12, 4);
    await q.converse([/roald sent me to check on drezel/i, /^sure\.?$/i], () => q.sawText(/one dead dog coming up/i), 60);
    await q.converse([], () => !q.dialogOpen(), 6);
    q.milestone(2);
    // 3. The trapdoor north of the temple; the temple guardian (temple_guardian.rs2:1-11 sets 3 on its death).
    await toTrapdoor('dog');
    await q.waitUntil(() => !!q.npc(/^temple guardian$/i), 10);
    if (!q.npc(/^temple guardian$/i)) await q.walk('to dog', [{ x: DOG.x, z: DOG.z + 2, tol: 2 }]);
    await kill('dog', () => q.npc(/^temple guardian$/i), () => !q.npc(/^temple guardian$/i), 60);
    q.milestone(3);
    // 4. Varrock teleport, King Roald: 4 (king_roald.rs2:69-81).
    await q.teleport('varrock teleport 1', 'magic:varrock_teleport', 3212, 3424);
    await q.walk('to roald', [{ x: ROALD.x, z: ROALD.z, tol: 1 }]);
    await q.talk('roald 2', roald, [], () => q.sawText(/see you beheaded for high treason/i), ROALD, 80);
    q.milestone(4);
    // 5. The temple doors open now; a level 30 monk (priestperilevilmonk3) drops the golden key while %priestperil < 6
    // (evil_monks.rs2:52-56). Up to Drezel; through the cell door: "Tell me anyway.", "Yes." sets 5.
    await intoTemple('drezel');
    await kill('monk', () => (q.st()?.nearbyNpcs ?? []).filter((n: any) => /^monk of zamorak$/i.test(n.name) && n.combatLevel === 30).sort((a: any, b: any) => a.distance - b.distance)[0],
        () => q.has(ITEM.goldKey) || (q.st()?.groundItems ?? []).some((g: any) => g.id === ITEM.goldKey), 60);
    for (let i = 0; i < 10 && !q.has(ITEM.goldKey); i++) {
        const g = (q.st()?.groundItems ?? []).find((x: any) => x.id === ITEM.goldKey);
        if (g && i % 3 === 0) await q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' });
        await q.waitTicks(1);
    }
    if (!q.has(ITEM.goldKey)) await q.fail('no golden key');
    q.milestone('key');
    await upToDrezel('drezel 1');
    await q.walk('to cell', [{ x: CELL.x, z: CELL.z, tol: 1 }]);
    await q.step('talk-through', () => { const k = q.locAt(CELL.x, CELL.z) ?? CELL; return q.opLoc(k, q.opIndex(k, /talk/i)); }, () => q.dialogOpen(), 12, 4);
    await q.converse([/^tell me anyway/i, /^yes\.?$/i], () => q.sawText(/let's get you out of here/i), 120);
    await q.converse([], () => !q.dialogOpen(), 6);
    q.milestone(5);
    // 6. Down, out, the north trapdoor, gate 1 (open at 5); the golden key on each monument until it swaps for the
    // iron key; the bucket on the well (murky water).
    await downFromDrezel('key');
    await toTrapdoor('key');
    await q.walk('to gate 1', [{ x: GATE1.x, z: GATE1.z, tol: 0 }]);
    await cross('gate 1', GATE1, /^open$/i, () => z() < GATE1.z);
    for (const m of MONUMENTS) {
        if (q.has(ITEM.ironKey)) break;
        await q.guard('monuments');
        const n0 = q.msgCount(/nothing interesting|you swap/i);
        await q.useOnLoc(ITEM.goldKey, q.locAt(m.x, m.z) ?? m);
        await q.waitUntil(() => q.has(ITEM.ironKey) || q.msgCount(/nothing interesting|you swap/i) > n0, 25);
    }
    if (!q.has(ITEM.ironKey)) await q.fail('no iron key');
    q.milestone('iron');
    await q.step('well', () => q.useOnLoc(ITEM.bucket, q.locAt(WELL.x, WELL.z) ?? WELL), () => q.has(ITEM.murky), 20, 4);
    // 7. Back up: gate 1, the cellar ladder, the temple, the iron key on the cell door (6); Drezel blesses the murky
    // water; the blessed water on the coffin (7); Drezel (8) (trapped_drezel.rs2:1-21,54-67, vampire_coffin.rs2:8-17).
    await q.walk('to gate 1 back', [{ x: GATE1.x, z: GATE1.z - 1, tol: 0 }]);
    await cross('gate 1 back', GATE1, /^open$/i, () => z() >= GATE1.z);
    await upCellar('key');
    await intoTemple('drezel 2');
    await upToDrezel('drezel 2');
    await q.walk('to cell 2', [{ x: CELL.x, z: CELL.z, tol: 1 }]);
    await q.step('iron key', () => q.useOnLoc(ITEM.ironKey, q.locAt(CELL.x, CELL.z) ?? CELL), () => !q.has(ITEM.ironKey), 12, 4);
    await q.converse([], () => !q.dialogOpen(), 8);
    q.milestone(6);
    await cross('cell door', CELL, /^open$/i, () => x() > CELL.x);
    await q.talk('drezel bless', /^drezel$/i, [], () => q.has(ITEM.blessed), DREZEL, 60);
    await cross('cell door out', CELL, /^open$/i, () => x() <= CELL.x);
    await q.step('coffin', () => q.useOnLoc(ITEM.blessed, q.locAt(COFFIN.x, COFFIN.z) ?? COFFIN), () => !q.has(ITEM.blessed), 12, 4);
    q.milestone(7);
    await cross('cell door 2', CELL, /^open$/i, () => x() > CELL.x);
    await q.talk('drezel free', /^drezel$/i, [], () => q.sawText(/meet you down by the monument/i), DREZEL, 60);
    q.milestone(8);
    // 8. Down to the mausoleum: gates 1 and 2, Drezel (10); the essence (10 + n, drezel.rs2:30-56,85-113).
    await cross('cell door out 2', CELL, /^open$/i, () => x() <= CELL.x);
    await downFromDrezel('mausoleum');
    await toTrapdoor('mausoleum');
    await q.walk('to gate 1 c', [{ x: GATE1.x, z: GATE1.z, tol: 0 }]);
    await cross('gate 1 c', GATE1, /^open$/i, () => z() < GATE1.z);
    await q.walk('to gate 2', [{ x: GATE2.x, z: GATE2.z, tol: 0 }]);
    await cross('gate 2', GATE2, /^open$/i, () => x() > GATE2.x);
    await q.talk('drezel 10', /^drezel$/i, [], () => q.sawText(/fifty should be sufficient/i), DREZEL2, 80);
    q.milestone(10);
    const giveEss = async (label: string): Promise<void> => {
        await q.step(label, () => { const d = q.npc(/^drezel$/i); return d ? q.useOnNpc(ITEM.ess, d) : q.waitTicks(1); }, () => !q.has(ITEM.ess) || questDone, 20, 4);
        await q.converse([], () => !q.dialogOpen() || questDone, 10);
    };
    await giveEss('essence 1');
    q.milestone(32);
    // 9. Varrock teleport, the east bank (27 essence), the walk back to Drezel; the rest completes the quest.
    await q.teleport('varrock teleport 2', 'magic:varrock_teleport', 3212, 3424);
    await q.walk('to bank', [{ x: BANK.x, z: BANK.z, tol: 1 }]);
    const o = await q.s.bot.openBank();
    if (!o.success) await q.fail(`openBank ${o.message}`);
    await q.waitTicks(1);
    const w = await q.s.bot.withdrawItem(/^rune essence$/i, 27);
    if (!w.success) console.log(`WARN withdraw ${w.message}`);
    await q.s.bot.closeBank();
    if (!q.has(ITEM.ess)) await q.fail('no essence from bank');
    await toTrapdoor('essence');
    await q.walk('to gate 1 d', [{ x: GATE1.x, z: GATE1.z, tol: 0 }]);
    await cross('gate 1 d', GATE1, /^open$/i, () => z() < GATE1.z);
    await q.walk('to gate 2 d', [{ x: GATE2.x, z: GATE2.z, tol: 0 }]);
    await cross('gate 2 d', GATE2, /^open$/i, () => x() > GATE2.x);
    if (!q.npc(/^drezel$/i)) await q.walk('to drezel', [{ x: DREZEL2.x, z: DREZEL2.z, tol: 3 }]);
    await giveEss('essence 2');
    await q.waitUntil(() => questDone, 20);
    await q.converse([], () => !q.dialogOpen(), 10);
    q.milestone(100);
    off();
    await q.end(questDone, 'qp=1');
} catch (e) { await q.fail(String(e)); }
