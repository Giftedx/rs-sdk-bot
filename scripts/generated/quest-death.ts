// Death Plateau from preset quest_death (beside Denulth in the Imperial Guard camp, Burthorpe; every skill 99; 10 bread,
// 10 trout, an Asgarnian Ale, a Blurberry Special, an iron bar and 200 coins from a helper). Reward: 1 QP, 30,000
// Attack XP before 25x, steel claws (quest_death.rs2:216-222).
// Two tracks. %death_equiproom: Denulth 10 (death_ig_commander.rs2:91-120, Harold's gold set to 100), Eohric 20
// (death_headservant.rs2:49-55), Harold 30 (death_guard_equiproom.rs2:264-273), Eohric 40 (death_headservant.rs2:10-15),
// the ale 50 (:302-338); the Blurberry Special makes Harold very drunk, so every dice roll wins (:126-146,275-300); a win
// above his 100 gold gives the IOU 55 (:148-185); reading it gives the combination 60 (quest_death.rs2:27-35); the 5
// stone balls on the mechanism 70 (:83-101). The map (%death_map bits 0-3): Saba 1 (death_saba.rs2:32-56), Tenzing 2 and
// his climbing boots (death_sherpa.rs2:150-178), Dunstan 3 (death_smithy.rs2:16-30), Denulth's certificate 4
// (death_ig_commander.rs2:157-184), Dunstan takes it 5 and spikes the boots for the iron bar (death_smithy.rs2:33-48,
// 187-210), Tenzing takes the food and boots 6 and draws the map 7 (death_sherpa.rs2:119-147,181-190), the zone on the
// secret way 8 (quest_death.rs2:130-136). Denulth with the map and the combination completes the quest
// (death_ig_commander.rs2:186-221).
import { openQuest } from './quest-lib';

const DENULTH = { x: 2896, z: 3528 };
const EOHRIC = { x: 2902, z: 3565 };            // castle level 1
const HAROLD = { x: 2905, z: 3539 };            // Toad and Chicken level 1
const HAROLD_DOOR = { id: 3747, x: 2906, z: 3543 };
const INN_STAIRS = { x: 2914, z: 3539 };
const CASTLE_STAIRS = { x: 2898, z: 3566 };
const CAVE_IN = { id: 3735, x: 2857, z: 3578 };
const CAVE_OUT = { id: 3736, x: 2268, z: 4750 };
const SABA = { x: 2270, z: 4759 };
const TENZING = { x: 2820, z: 3556 };
const TENZING_DOOR = { id: 3745, x: 2822, z: 3555 };
const TENZING_BACK = { id: 3746, x: 2820, z: 3557 };
const STILE = { id: 3730, x: 2817, z: 3562 };
const DUNSTAN = { x: 2919, z: 3574 };
const SCOUT = { x: 2864, z: 3609 };             // in zone 0_44_56_48_24 (2864-2871,3608-3615)
const ITEM = { ale: 1905, blurberry: 2064, coins: 995, iou: 3103, combo: 3102, map: 3104, boots: 3105, spiked: 3107, cert: 3114, iron: 2351 };
// Ball, its ground spawn (x 2893) and its mechanism tile: Blue W of Yellow, Red N of Blue, Purple E of Red, Green N of
// Purple (quest_death.rs2:37-44,92-93).
const BALLS = [
    { id: 3110, from: 3564, to: { id: 3676, x: 2894, z: 3562 } },  // blue
    { id: 3111, from: 3561, to: { id: 3676, x: 2895, z: 3562 } },  // yellow
    { id: 3109, from: 3565, to: { id: 3677, x: 2894, z: 3563 } },  // red
    { id: 3112, from: 3563, to: { id: 3677, x: 2895, z: 3563 } },  // purple
    { id: 3113, from: 3562, to: { id: 3676, x: 2895, z: 3564 } },  // green
];
const DICE_ROLL = 8421;      // death_dice:com_28 (pack/interface.pack)
const DICE_PAUSE = 8423;     // death_dice:com_30, buttontype=pause
const RESUME_PAUSEBUTTON = 166;

const q = await openQuest({ cap: 4000 });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const lv = () => q.lvl();
    const z = () => q.pos()?.worldZ ?? 0;
    const loc = (l: { id: number; x: number; z: number }) => q.locAt(l.x, l.z) ?? l;
    const closeDlg = async () => { if (q.dialogOpen()) await q.converse([], () => !q.dialogOpen(), 12); };
    const ground = (id: number): any => (q.st()?.groundItems ?? []).filter((g: any) => g.id === id).sort((a: any, b: any) => q.cheb(a.x, a.z) - q.cheb(b.x, b.z))[0];
    const climbNear = (x: number, zz: number, re: RegExp) => () => q.findLoc(l => Math.abs(l.x - x) <= 2 && Math.abs(l.z - zz) <= 2 && (l.optionsWithIndex ?? []).some((o: any) => re.test(o.text)));
    const npcTalk = (label: string, re: RegExp, pats: RegExp[], ok: () => boolean, home: { x: number; z: number }, ticks = 80) => q.talk(label, re, pats, ok, home, ticks);
    const c: any = (q.s as any).client;

    const toCastleUp = async () => {
        if (lv() === 1) return;
        await q.walk('to castle stairs', [{ x: 2898, z: 3547, tol: 2 }, { x: 2898, z: 3563, tol: 2 }, { x: CASTLE_STAIRS.x, z: CASTLE_STAIRS.z - 1, tol: 1 }]);
        await q.climb('castle stairs up', climbNear(CASTLE_STAIRS.x, CASTLE_STAIRS.z, /climb-up/i), /climb-up/i, () => lv() === 1);
    };
    const castleDown = async () => { if (lv() === 0) return; await q.walk('to castle stairs top', [{ x: 2897, z: 3568, tol: 2 }]); await q.climb('castle stairs down', climbNear(2897, 3567, /climb-down/i), /climb-down/i, () => lv() === 0); };
    const inHaroldRoom = () => (q.pos()?.worldX ?? 9999) <= 2908 && z() < HAROLD_DOOR.z;
    const toHarold = async () => {
        if (lv() !== 1) {
            await q.walk('to inn stairs', [{ x: INN_STAIRS.x, z: INN_STAIRS.z - 1, tol: 1 }]);
            await q.climb('inn stairs up', climbNear(INN_STAIRS.x, INN_STAIRS.z, /climb-up/i), /climb-up/i, () => lv() === 1);
        }
        // The stairs top (2914,3540) is east of Harold's room, which lies west of x 2909 and south of the door row.
        if (!inHaroldRoom()) {
            await q.walk('to harold door', [{ x: 2914, z: 3543, tol: 1 }, { x: HAROLD_DOOR.x, z: HAROLD_DOOR.z, tol: 0 }]);
            await q.step('harold door', async () => { if (q.dialogOpen()) return q.converse([], () => !q.dialogOpen(), 6); return q.opLoc(loc(HAROLD_DOOR), 1); }, () => z() < HAROLD_DOOR.z, 10, 6);
        }
    };
    const innDown = async () => {
        if (lv() === 0) return;
        if (inHaroldRoom()) {
            await q.walk('to harold door in', [{ x: HAROLD_DOOR.x, z: HAROLD_DOOR.z - 1, tol: 0 }]);
            await q.step('harold door out', () => q.opLoc(loc(HAROLD_DOOR), 1), () => z() >= HAROLD_DOOR.z, 10, 6);
        }
        await q.walk('to inn stairs top', [{ x: 2914, z: 3541, tol: 1 }]);
        await q.climb('inn stairs down', climbNear(2914, 3540, /climb-down/i), /climb-down/i, () => lv() === 0);
    };
    // Dunstan's smithy door (loc 1530, north wall of 2921,3571); trial 4 stood outside the wall: no dialog.
    const toDunstan = async () => {
        if (q.near(2920, 3574, 2) && z() >= 3572) return;
        await q.walk('to smithy door', [{ x: 2921, z: 3570, tol: 0 }]);
        await q.openDoor('smithy door', 2921, 3571);
        await q.walk('into smithy', [{ x: 2921, z: 3573, tol: 1 }]);
    };
    const toTenzing = async () => {
        await q.walk('to tenzing door', [{ x: TENZING_DOOR.x + 1, z: TENZING_DOOR.z, tol: 0 }]);
        await q.step('tenzing door', async () => { if (q.dialogOpen()) return q.converse([/i'm not the milkman/i], () => !q.dialogOpen(), 8); return q.opLoc(loc(TENZING_DOOR), 1); }, () => (q.pos()?.worldX ?? 9999) <= TENZING_DOOR.x, 10, 6);
        await closeDlg();
    };
    const outTenzing = async () => {
        await q.walk('to tenzing door in', [{ x: TENZING_DOOR.x, z: TENZING_DOOR.z, tol: 0 }]);
        await q.step('tenzing door out', () => q.opLoc(loc(TENZING_DOOR), 1), () => (q.pos()?.worldX ?? 0) > TENZING_DOOR.x, 10, 6);
    };

    // 1. Denulth: "Do you have any quests for me?", "No but perhaps I could try and find one?" (10).
    await npcTalk('denulth', /^denulth$/i, [/do you have any quests/i, /perhaps i could try and find one/i], () => q.sawText(/get on it right away/i), DENULTH);
    q.milestone(10);

    // 2. Eohric in the castle (20), Harold at the inn (30), Eohric again (40).
    await toCastleUp();
    await npcTalk('eohric 1', /^eohric$/i, [/looking for the guard that was on last night/i], () => q.sawText(/staying at the toad and chicken/i), EOHRIC);
    await castleDown();
    await toHarold();
    await npcTalk('harold 1', /^harold$/i, [/you're the guard that was on duty/i], () => q.sawText(/don't want to talk about it/i), HAROLD);
    await innDown();
    await toCastleUp();
    await npcTalk('eohric 2', /^eohric$/i, [], () => q.sawText(/open up after a drink/i), EOHRIC);
    await castleDown();
    q.milestone(40);

    // 3. Harold: the ale (50), then the Blurberry Special (very drunk); the dice: bet 101, roll, win, the IOU (55).
    await toHarold();
    await npcTalk('harold ale', /^harold$/i, [/can i buy you a drink/i], () => !q.has(ITEM.blurberry) && q.sawText(/now that hit the spot/i), HAROLD, 120);
    q.milestone(50);
    for (let round = 0; round < 4 && !q.has(ITEM.iou); round++) {
        console.log(`MILESTONE round${round} ${q.T()}`);
        await npcTalk(`harold gamble ${round}`, /^harold$/i, [/would you like to gamble/i], () => !q.dialogOpen() && q.sawText(/place your betsh/i), HAROLD, 40);
        await q.s.direct({ type: 'submitCountDialog', value: 101, reason: 'SDK' });
        // "Right...er...here goes..." (a chat page), then harold_roll opens the dice and rolls for 6 ticks (:70-100).
        await q.waitUntil(() => q.dialogOpen(), 4);
        await q.converse([], () => !q.dialogOpen() && q.sawText(/here goes/i), 8);
        // harold_roll holds the player in 3 p_delay(2) for about 9 ticks; a click inside them gets no protected access
        // (Player.ts runScript), so trial 2 lost its roll at 7 ticks.
        await q.waitTicks(12);
        // One roll click: a second one would start player_roll again. The win sets harold_lostall (:134-138); the
        // pause button closes the dice and the queued haroldgamble_end writes the IOU (:148-185).
        await q.s.direct({ type: 'clickComponent', componentId: DICE_ROLL, reason: 'SDK' });
        await q.waitTicks(6);
        if (c?.writeOpcode) { c.writeOpcode(RESUME_PAUSEBUTTON); c.out.p2(DICE_PAUSE); }
        await q.waitUntil(() => q.has(ITEM.iou) || q.dialogOpen(), 8);
        await q.converse([], () => q.has(ITEM.iou) && !q.dialogOpen(), 20);
    }
    if (!q.has(ITEM.iou)) await q.fail('no IOU');
    q.milestone(55);
    for (let i = 0; i < 5 && !q.has(ITEM.combo); i++) {
        await closeDlg();
        await q.s.direct({ type: 'closeModal', reason: 'SDK' });
        await q.waitTicks(1);
        const r: any = await q.s.direct({ type: 'useInventoryItem', slot: q.slot(ITEM.iou)!, optionIndex: 1, reason: 'SDK' });
        await q.waitUntil(() => q.has(ITEM.combo) || q.dialogOpen(), 4);
        const d: any = q.s.sdk.getDialog();
        console.log(`DEBUG read iou ${i} r=${JSON.stringify(r)} dlg=${d?.isOpen}/${d?.isWaiting} txt=${(d?.text ?? '').slice(0, 60)} op=${JSON.stringify(q.st()?.opFeedback ?? {})}`);
        await q.converse([], () => q.has(ITEM.combo) && !q.dialogOpen(), 12);
    }
    if (!q.has(ITEM.combo)) await q.fail('step read iou');
    await q.s.direct({ type: 'closeModal', reason: 'SDK' });
    await closeDlg();
    q.milestone(60);

    // 4. The stone balls from the ground at x 2893 onto the mechanism (70).
    await innDown();
    await q.walk('to balls', [{ x: 2898, z: 3547, tol: 2 }, { x: 2896, z: 3561, tol: 2 }, { x: 2893, z: 3561, tol: 1 }]);
    for (const b of BALLS) {
        await q.step(`take ball ${b.id}`, () => { const g = ground(b.id); return g ? q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' }) : q.waitTicks(1); }, () => q.has(b.id), 8, 4);
    }
    for (const b of BALLS) {
        await q.step(`place ball ${b.id}`, () => q.useOnLoc(b.id, loc(b.to)), () => !q.has(b.id), 8, 4);
    }
    await q.waitUntil(() => q.msgCount(/equipment room door has unlocked/i) > 0, 4);
    if (q.msgCount(/equipment room door has unlocked/i) === 0) await q.fail('door not unlocked');
    q.milestone(70);

    // 5. Saba in the hermit cave (map 1).
    await q.walk('to cave', [{ x: CAVE_IN.x, z: CAVE_IN.z - 1, tol: 1 }]);
    await q.step('cave in', () => q.opLoc(loc(CAVE_IN), 1), () => z() > 4000, 10, 4);
    await npcTalk('saba', /^saba$/i, [/another way up death plateau/i], () => q.sawText(/where does this sherpa live/i), SABA);
    await closeDlg();
    await q.step('cave out', () => q.opLoc(loc(CAVE_OUT), 1), () => z() < 4000, 10, 4);

    // 6. Tenzing (2, climbing boots), Dunstan (3), Denulth's certificate (4), Dunstan: certificate and spikes (5).
    await toTenzing();
    await npcTalk('tenzing 1', /^tenzing$/i, [/ok, i'll get those for you/i], () => q.has(ITEM.boots), TENZING);
    await closeDlg();
    await outTenzing();
    await toDunstan();
    await npcTalk('dunstan 1', /^dunstan$/i, [], () => q.sawText(/bring an iron bar for the spikes/i), DUNSTAN);
    await npcTalk('denulth cert', /^denulth$/i, [], () => q.has(ITEM.cert), DENULTH);
    await closeDlg();
    await toDunstan();
    await npcTalk('dunstan 2', /^dunstan$/i, [], () => q.has(ITEM.spiked), DUNSTAN);
    await closeDlg();
    q.milestone(5);

    // 7. Tenzing takes the food and the spiked boots and draws the map (7); out the back door, the stile, the zone (8).
    await toTenzing();
    await npcTalk('tenzing 2', /^tenzing$/i, [], () => q.has(ITEM.map), TENZING);
    await closeDlg();
    await q.walk('to back door', [{ x: TENZING_BACK.x, z: TENZING_BACK.z, tol: 0 }]);
    await q.step('back door', () => q.opLoc(loc(TENZING_BACK), 1), () => z() > TENZING_BACK.z, 10, 5);
    await q.walk('to stile', [{ x: STILE.x, z: STILE.z - 1, tol: 0 }]);
    await q.step('stile', () => q.opLoc(loc(STILE), 1), () => z() > STILE.z, 12, 5);
    await q.walk('secret way', [{ x: 2817, z: 3586, tol: 2 }, { x: 2830, z: 3595, tol: 2 }, { x: 2843, z: 3606, tol: 2 }, { x: SCOUT.x, z: SCOUT.z, tol: 1 }]);
    await q.waitUntil(() => q.msgCount(/no trolls on the secret path/i) > 0, 6);
    if (q.msgCount(/no trolls on the secret path/i) === 0) await q.fail('secret way not scouted');
    await closeDlg();
    q.milestone(8);

    // The secret way has no other way down (the SDK plan to Denulth ends at 2881,3596; trial 5): back over the stile and
    // through Tenzing's hut.
    await q.walk('secret way back', [{ x: 2843, z: 3606, tol: 2 }, { x: 2830, z: 3594, tol: 2 }, { x: 2817, z: 3584, tol: 2 }, { x: STILE.x, z: STILE.z + 2, tol: 0 }]);
    await q.step('stile back', () => q.opLoc(loc(STILE), 1), () => z() < STILE.z, 12, 5);
    await q.walk('to back door out', [{ x: TENZING_BACK.x, z: TENZING_BACK.z + 1, tol: 0 }]);
    await q.step('back door in', () => q.opLoc(loc(TENZING_BACK), 1), () => z() <= TENZING_BACK.z, 10, 5);
    await outTenzing();

    // 8. Denulth: the map and the combination.
    await npcTalk('denulth end', /^denulth$/i, [], () => questDone, DENULTH, 80);
    await q.waitUntil(() => questDone, 10);
    q.milestone(100);
    off();
    await q.end(questDone, 'qp=1');
} catch (e) { await q.fail(String(e)); }
