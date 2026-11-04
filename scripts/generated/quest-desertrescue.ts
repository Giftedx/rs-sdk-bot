// The Tourist Trap from preset quest_desertrescue (beside Irena south of the Shantay Pass; every skill 99; a worn rune
// scimitar and desert clothes; a hammer, 3 bronze bars, 40 feathers, 2 waterskins and 6 sharks from a helper).
// Reward: 2 QP and 2 x 46,500 XP picks (quest_desertrescue/scripts/irena.rs2:77-102, quest_desertrescue.rs2:902-905).
// %desertrescue (varp 197) stages (desertrescue.constant): Irena 1 (irena.rs2:62-66); the Mercenary Captain 3 and his
// death 4 with the metal key (mercenary_captain.rs2:13-27,203-216); the gate 5 (quest_desertrescue.rs2:119-130); the
// slave 6-8 (mining_slave.rs2:79-200); the mine doors 9 (quest_desertrescue.rs2:417-445); the mine guard 10
// (camp_guard.rs2:105-121); Al Shabim's key 11 (al_shabim.rs2:117-141); Captain Siad's chest 12
// (quest_desertrescue.rs2:308-345, captain_siad.rs2:43-81); Al Shabim 13, the anvil 14, the feathers 15, Al Shabim 16
// (al_shabim.rs2:168-186,42-74; quest_desertrescue.rs2:577-672); the pineapple 17 (camp_guard.rs2:149-156); the mine
// cart 18, Ana in a barrel 19-21, the lift 22, the winch 23-24, the cart 25-26 (quest_desertrescue.rs2:708-894,
// ana.rs2:56-89, camp_guard.rs2:177-206, mine_cart_driver.rs2); Irena 27-30.
// Every skill roll here (Thieving lock 20/250, Smithing 61/245, Fletching 61/254, Agility 100/250) can fail at 99 with
// a small chance; the bot repeats the action.
// TT_FROM=<stage> starts at a debug preset (packages/practice/src/presets-long.ts).
import { openQuest } from './quest-lib';

const ITEM = {
    scimitar: 1333, dShirt: 1833, dRobe: 1835, dBoots: 1837, sShirt: 1844, sRobe: 1845, sBoots: 1846, hammer: 2347,
    bar: 2349, feather: 314, metalKey: 1839, bedKey: 1852, plans: 1850, tip: 1853, dart: 1849, pineapple: 1851,
    barrel: 1841, ana: 1842,
};
const IRENA = { x: 3303, z: 3113 };
const CAPTAIN = { x: 3270, z: 3029 };
const GATE = { id: 2673, x: 3273, z: 3029 };            // miningcampgateclosedl; the camp is x >= 3274
const SLAVE = { x: 3302, z: 3030 };
const MINE_IN = { id: 2675, x: 3301, z: 3036 };         // thttmineentrancel -> 3278,9426 underground
const MINE_OUT = { id: 2690, x: 3278, z: 9426 };        // thttmineexitl -> 3301,3036 surface
const CAVE_W = { id: 2699, x: 3281, z: 9415 };          // thminecavel, from the west -> 3286,9415 (pineapple given)
const CAVE_E = { id: 2698, x: 3283, z: 9415 };          // thminecaver, from the east -> 3278,9415
const SHABIM = { x: 3171, z: 3025 };
const BED_GUARD = { x: 3170, z: 3045 };
const ANVIL = { id: 2672, x: 3171, z: 3048 };
const TENT_DOOR = { id: 2700, x: 3169, z: 3046 };
const LADDER = { id: 1747, x: 3290, z: 3036 };
const LADDER_TOP = { id: 1746, x: 3290, z: 3036 };
const BOOKCASE = { id: 2678, x: 3284, z: 3032 };
const CHEST = { id: 2677, x: 3292, z: 3033 };
const LOW_CART = { id: 2684, x: 3303, z: 9417 };        // lower minecart -> 3319,9431 (Ana's side)
const ANA_CART = { id: 2684, x: 3318, z: 9430 };        // -> 3302,9417 (barrel room)
const LOW_BARREL = { id: 2681, x: 3303, z: 9418 };      // empty barrels within 3 of 3303,9417
const LIFT = { id: 2668, x: 3292, z: 9423 };
const WINCH = { id: 2667, x: 3279, z: 3017 };
const UP_BARREL = { id: 2680, x: 3278, z: 3017 };
const CART = { id: 2682, x: 3287, z: 3023 };
const ANA = { x: 3302, z: 9466 };

const FROM = process.env.TT_FROM ?? 'start';
const STAGES = ['start', 'shabim', 'ana'];
const from = (s: string) => STAGES.indexOf(FROM) <= STAGES.indexOf(s);

const q = await openQuest({ cap: 6000, eatAt: 50, food: [385] });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const x = () => q.pos()?.worldX ?? 0;
    const z = () => q.pos()?.worldZ ?? 0;
    const msgSince = (re: RegExp, t: number) => (q.st()?.gameMessages ?? []).some((m: any) => m.type === 0 && m.tick >= t && re.test(m.text));
    const closeDlg = async () => { if (q.dialogOpen()) await q.converse([], () => !q.dialogOpen(), 12); };
    const worn = (id: number) => (q.st()?.equipment ?? []).some((e: any) => e?.id === id);
    const use = (id: number, op: number) => q.s.direct({ type: 'useInventoryItem', slot: q.slot(id)!, optionIndex: op, reason: 'SDK' });
    const wear = async (id: number) => {
        if (worn(id)) return;
        const op = (q.inv().find((i: any) => i.id === id)?.optionsWithIndex ?? []).find((o: any) => /wield|wear/i.test(o.text))?.opIndex ?? 2;
        await q.step(`wear ${id}`, () => use(id, op), () => worn(id), 4, 3);
    };
    const remove = async (id: number) => {
        const e = (q.st()?.equipment ?? []).find((k: any) => k?.id === id);
        if (!e) return;
        await q.step(`remove ${id}`, () => q.s.direct({ type: 'useEquipmentItem', slot: e.slot, optionIndex: 1, reason: 'SDK' }), () => !worn(id), 4, 3);
    };
    const loc = (l: { id: number; x: number; z: number }) => q.locAt(l.x, l.z) ?? l;
    // A loc op that opens a dialog: sends the op, then talks through it with pats until ok().
    const locTalk = async (label: string, send: () => unknown, pats: RegExp[], ok: () => boolean, tries = 4, ticks = 40) => {
        for (let i = 0; i < tries && !ok(); i++) {
            await q.guard(label);
            await closeDlg();
            await send();
            await q.waitUntil(() => q.dialogOpen() || ok(), 15);
            let shut = 0;
            await q.converse(pats, () => { shut = q.dialogOpen() ? 0 : shut + 1; return (ok() && !q.dialogOpen()) || shut >= 3; }, ticks);
        }
        if (!ok()) await q.fail(`step ${label}`);
    };
    const inCamp = () => x() >= 3274 && x() <= 3306 && z() >= 3011 && z() <= 3043;
    // The metal key opens the camp gate both ways (quest_desertrescue.rs2:68-131). Out of the camp, a guard within 4 of
    // a player in any slave clothes jails him (:110-118), so the slave clothes come off first.
    const gateIn = async () => {
        if (inCamp()) return;
        await q.walk('to gate', [{ x: 3272, z: 3029, tol: 0 }]);
        await q.step('gate in', () => q.opLoc(loc(GATE), 1), () => x() >= 3274, 12, 4);
        await q.waitTicks(2);
    };
    const gateOut = async () => {
        for (const id of [ITEM.sShirt, ITEM.sRobe, ITEM.sBoots]) await remove(id);
        if (!inCamp()) return;
        await q.walk('to gate inside', [{ x: 3274, z: 3029, tol: 0 }]);
        await q.step('gate out', () => q.opLoc(loc(GATE), 1), () => x() <= 3273, 12, 4);
        await q.waitTicks(2);
    };
    const slaveClothes = async () => { for (const id of [ITEM.sShirt, ITEM.sRobe, ITEM.sBoots]) await wear(id); };
    const mineIn = async () => {
        await slaveClothes();
        await q.walk('to mine doors', [{ x: MINE_IN.x, z: MINE_IN.z - 1, tol: 0 }]);
        await q.step('mine doors', () => q.opLoc(loc(MINE_IN), 1), () => z() > 9000, 12, 4);
        await q.waitTicks(2);
        await closeDlg();
    };
    // The exit door op from anywhere near: the server routes to it. (Trial 1: a walkPath to the tile south of the door
    // opened the door itself, landed on the surface and then walked off toward the underground goal.)
    const mineOut = async () => {
        await q.step('mine exit', () => q.opLoc(loc(MINE_OUT), 1), () => z() < 4000, 25, 4);
        await q.waitTicks(2);
    };
    const shabim = (label: string, pats: RegExp[], ok: () => boolean) => q.talk(label, /^al shabim$/i, pats, ok, SHABIM, 80);

    if (from('start')) {
        // 1. Irena: "Is there a reward if I get her back?", then "Okay Irena, calm down." sets 1 (irena.rs2:1-66).
        await q.talk('irena', /^irena$/i, [/what's the matter/i, /is there a reward/i, /okay irena, calm down/i], () => q.sawText(/red silk scarf/i), IRENA, 80);
        q.milestone(1);
        // 2. The Mercenary Captain: the talk sets 3; "It's a funny captain who can't fight his own battles!" starts a
        // duel (npc_retaliate, mercenary_captain.rs2:62-67). An attack before he hits first asks "Are you sure" and
        // sends the guards (:218-241), so the bot waits for his first swing; his death sets 4 and adds the key (:193-216).
        await q.walk('to captain', [{ x: CAPTAIN.x + 2, z: CAPTAIN.z, tol: 2 }]);
        await q.talk('captain', /^mercenary captain$/i, [/wow! a real captain/i, /love to work for a tough guy/i, /can't i do something for a strong captain/i, /sorry sir, i don't think/i, /funny captain who can't fight/i],
            () => q.sawText(/guards gather around to watch the fight/i), CAPTAIN, 80);
        const hp0 = q.hp();
        await q.waitUntil(() => q.hp() < hp0, 8);
        for (let k = 0; k < 30 && !q.has(ITEM.metalKey); k++) {
            await q.guard('captain fight');
            if (q.dialogOpen()) {
                const d: any = q.s.sdk.getDialog();
                const no = (d?.options ?? []).find((o: any) => /no thanks, i've had second/i.test(o.text));
                if (no) { console.log('WARN captain asked "are you sure"; declined'); await q.s.sdk.sendClickDialog(no.index); await q.waitTicks(4); continue; }
                await closeDlg();
            }
            const n = q.npc(/^mercenary captain$/i);
            if (!n) { await q.waitTicks(2); continue; }
            await q.s.bot.attack(n as any);
            await q.waitUntil(() => q.has(ITEM.metalKey) || q.dialogOpen(), 6);
        }
        if (!q.has(ITEM.metalKey)) await q.fail('no metal key');
        await q.waitTicks(2);
        await closeDlg();
        q.milestone(4);
        // 3. The scimitar off (the camp guards jail a player with a weapon); the gate sets 5.
        await remove(ITEM.scimitar);
        await gateIn();
        q.milestone(5);
        // 4. A male slave on the surface: the lock (Thieving) sets 7; the trade swaps the worn desert clothes for his
        // (8, mining_slave.rs2:145-200).
        await q.walk('to slave', [{ x: SLAVE.x - 1, z: SLAVE.z, tol: 1 }]);
        await q.talk('slave', /^male slave$/i, [/i've just arrived/i, /oh yes, that sounds interesting/i, /what's that then/i, /i can try to undo them/i, /funny you should say that/i, /let's give it a go/i, /give it another go/i, /yes, i'll trade/i],
            () => worn(ITEM.sShirt) && worn(ITEM.sRobe) && worn(ITEM.sBoots), SLAVE, 120);
        q.milestone(8);
        // 5. The mine doors (9); the mine guard by the caves names the pineapple (10, camp_guard.rs2:3-17,105-121; the
        // player must stand in 0_51_147_10_5..20_15).
        await mineIn();
        q.milestone(9);
        await q.walk('to cave guard', [{ x: 3280, z: 9415, tol: 1 }]);
        await q.talk('cave guard', /^mercenary$/i, [/mine in a different area/i, /you're quite right sir/i, /we understand each other perfectly/i], () => q.sawText(/winks at you knowingly/i), { x: 3280, z: 9415 }, 60);
        q.milestone(10);
        await mineOut();
        await gateOut();
    }
    if (from('shabim')) {
        // 6. Al Shabim: "I am looking for a pineapple." gives the Bedabin key (11, al_shabim.rs2:117-141).
        await shabim('shabim key', [/looking for a pineapple/i, /yes, i'm interested/i], () => q.has(ITEM.bedKey));
        q.milestone(11);
        // 7. Captain Siad (level 1 of the camp office): the bookcase's sailing books open "So, you're interested in
        // sailing?"; "the cut of your jib" distracts him; the chest opens with the key while he is distracted
        // (captain_siad.rs2:43-81, quest_desertrescue.rs2:308-351) (12).
        await gateIn();
        // The curtain (loc_1528 at 3291,3031) closes Siad's building and the planner treats it as open (rs-stun-toolkit
        // `q-the-tourist-trap.ts`, MIT, research/stun-toolkit-LICENSE.txt).
        const curtain = async () => {
            if (!q.findLoc((l: any) => l.id === 1528 && l.x === 3291 && l.z === 3031)) return;
            await q.step('curtain', () => { const c = q.findLoc((l: any) => l.id === 1528 && l.x === 3291 && l.z === 3031); return c ? q.opLoc(c, 1) : q.waitTicks(1); },
                () => !q.findLoc((l: any) => l.id === 1528 && l.x === 3291 && l.z === 3031), 12, 4);
        };
        await q.walk('to curtain', [{ x: 3291, z: 3030, tol: 0 }]);   // the curtain is on the south edge of its tile (maps/m51_47.jm2 `0 27 23: 1528 0 3`)
        await curtain();
        await q.dash('through curtain', 3291, 3032, 0, 8);
        await q.dash('to ladder', LADDER.x, LADDER.z - 1, 1, 12);
        await q.climb('ladder up', () => q.locAt(LADDER.x, LADDER.z) ?? LADDER, /climb-up|^climb/i, () => q.lvl() === 1);
        await q.walk('to bookcase', [{ x: 3285, z: 3032, tol: 0 }]);
        await locTalk('bookcase', () => { const b = loc(BOOKCASE); return q.opLoc(b, q.opIndex(b, /search/i) === 1 ? 2 : q.opIndex(b, /search/i)); }, [], () => q.sawText(/subject of sailing/i));
        for (let i = 0; i < 4 && !q.has(ITEM.plans); i++) {
            await q.talk('siad', /^captain siad$/i, [/wanted to have a chat/i, /you seem to have a lot of books/i, /interested in sailing/i, /cut of your jib/i], () => q.sawText(/looks quite distracted/i), { x: 3291, z: 3032 }, 80);
            await locTalk('chest', () => { const c = loc(CHEST); return q.opLoc(c, q.opIndex(c, /open/i)); }, [], () => q.has(ITEM.plans) || q.sawText(/spots you before you manage/i), 2);
        }
        if (!q.has(ITEM.plans)) await q.fail('no plans');
        q.milestone(12);
        await q.walk('to ladder top', [{ x: LADDER_TOP.x, z: LADDER_TOP.z - 1, tol: 0 }]);
        await q.climb('ladder down', () => q.locAt(LADDER_TOP.x, LADDER_TOP.z) ?? LADDER_TOP, /climb-down|^climb/i, () => q.lvl() === 0);
        await q.dash('to curtain inside', 3291, 3031, 0, 14);
        await curtain();
        await q.dash('out of curtain', 3291, 3029, 1, 8);
        await gateOut();
        // 8. Al Shabim sees the plans; the bar and 10 feathers in the pack lead to "Yes, I'm kind of curious." (13).
        await shabim('shabim plans', [/yes, i'm very interested/i, /kind of curious/i], () => q.sawText(/anvil in the other tent/i));
        q.milestone(13);
        // 9. The Bedabin guard lets a player with the plans into the anvil tent (bedabin_nomad_guard.rs2:187-226).
        await q.talk('bedabin guard', /^bedabin nomad guard$/i, [], () => z() >= 3046, BED_GUARD, 30);
        // 10. A bar on the anvil (14; a failed roll wastes the bar), 10 feathers on the tip (15; a failed roll wastes them).
        // The bar goes first and the roll lands about 8 ticks after "Yes" (quest_desertrescue.rs2:608-623), so each try waits
        // for the tip or the waste message: a click sent while the forge runs burns another bar.
        for (let i = 0; i < 5 && !q.has(ITEM.tip) && q.has(ITEM.bar); i++) {
            const t0 = q.s.tick();
            const rolled = () => q.has(ITEM.tip) || msgSince(/waste the bronze bar/i, t0);
            await q.guard('anvil');
            await closeDlg();
            await q.useOnLoc(ITEM.bar, loc(ANVIL));
            await q.waitUntil(() => q.dialogOpen() || rolled(), 15);
            await q.converse([/yes, i'd like to try/i], () => !q.dialogOpen(), 20);
            await q.waitUntil(rolled, 16);
            await q.converse([], () => !q.dialogOpen(), 6);
            console.log(`NOTE anvil try ${i + 1}: tip=${q.has(ITEM.tip)} bars=${q.cnt(ITEM.bar)}`);
        }
        if (!q.has(ITEM.tip)) await q.fail('no dart tip');
        q.milestone(14);
        // Trial 3: feather-on-tip did nothing in 15 ticks, so the use alternates source and target (as quest-chompybird.ts).
        for (let i = 0; i < 8 && !q.has(ITEM.dart); i++) {
            await q.guard('feathers');
            await closeDlg();
            const f0 = q.cnt(ITEM.feather);
            await (i % 2 === 0 ? q.useOnItem(ITEM.feather, ITEM.tip) : q.useOnItem(ITEM.tip, ITEM.feather));
            await q.waitUntil(() => q.dialogOpen() || q.has(ITEM.dart), 6);
            await q.converse([], () => q.has(ITEM.dart) || q.cnt(ITEM.feather) < f0 || !q.dialogOpen(), 30);
            await q.waitTicks(2);
        }
        if (!q.has(ITEM.dart)) await q.fail('no dart');
        await closeDlg();
        q.milestone(15);
        await q.step('tent out', () => q.opLoc(loc(TENT_DOOR), 1), () => z() <= 3045, 10, 4);
        // 11. Al Shabim takes the dart and plans and gives the Tenti pineapple (16, al_shabim.rs2:42-74).
        await shabim('shabim dart', [], () => q.has(ITEM.pineapple));
        q.milestone(16);
        // 12. Back in: the mine guard takes the pineapple (17, camp_guard.rs2:149-156).
        await gateIn();
        await mineIn();
        await q.walk('to cave guard', [{ x: 3280, z: 9415, tol: 1 }]);
        await q.talk('pineapple', /^mercenary$/i, [], () => !q.has(ITEM.pineapple) && q.sawText(/a deal's a deal/i), { x: 3280, z: 9415 }, 60);
        q.milestone(17);
        // 13. The cave east (quest_desertrescue.rs2:471-489).
        await q.walk('to cave', [{ x: CAVE_W.x - 1, z: CAVE_W.z, tol: 0 }]);
        await q.step('cave east', () => q.opLoc(loc(CAVE_W), 1), () => x() >= 3285, 12, 4);
        await q.waitTicks(2);
    }
    if (from('ana')) {
        // 14. An empty barrel by the lower cart; the cart to Ana's side (18, quest_desertrescue.rs2:741-778,808-835).
        await q.walk('to barrels', [{ x: 3302, z: 9418, tol: 1 }]);
        await locTalk('empty barrel', () => { const b = q.findLoc((l: any) => l.id === 2681 && Math.abs(l.x - 3303) <= 3 && Math.abs(l.z - 9417) <= 3) ?? LOW_BARREL; return q.opLoc(b, q.opIndex(b, /search|take/i) === 1 ? 2 : q.opIndex(b, /search|take/i)); }, [/yeah, cool/i], () => q.has(ITEM.barrel));
        await locTalk('low cart', () => { const c = loc(LOW_CART); return q.opLoc(c, q.opIndex(c, /search/i) === 1 ? 2 : q.opIndex(c, /search/i)); }, [/yes, of course/i], () => z() >= 9428 && x() >= 3310, 5);
        q.milestone(18);
        // 15. The barrel on Ana (19, ana.rs2:56-89).
        await q.walk('to ana', [{ x: ANA.x, z: ANA.z - 1, tol: 3 }]);
        await q.step('ana barrel', () => { const n = q.npc(/^ana$/i); return n ? q.useOnNpc(ITEM.barrel, n) : q.waitTicks(1); }, () => q.has(ITEM.ana), 20, 4);
        await closeDlg();
        q.milestone(19);
        // 16. Ana in the cart (20); the cart back; the barrel by the lower cart (21).
        await q.walk('to ana cart', [{ x: 3319, z: 9431, tol: 1 }]);
        await q.step('ana in cart', () => q.useOnLoc(ITEM.ana, loc(ANA_CART)), () => !q.has(ITEM.ana), 12, 3);
        await q.waitTicks(4);
        await locTalk('cart back', () => { const c = loc(ANA_CART); return q.opLoc(c, q.opIndex(c, /search/i) === 1 ? 2 : q.opIndex(c, /search/i)); }, [/yes, of course/i], () => z() <= 9420, 5);
        await locTalk('ana barrel 2', () => { const b = q.findLoc((l: any) => l.id === 2681 && Math.abs(l.x - 3303) <= 3 && Math.abs(l.z - 9417) <= 3) ?? LOW_BARREL; return q.opLoc(b, q.opIndex(b, /search|take/i) === 1 ? 2 : q.opIndex(b, /search|take/i)); }, [], () => q.has(ITEM.ana));
        q.milestone(21);
        // 17. The barrel on the lift; the guard helps (22, camp_guard.rs2:177-206).
        await q.walk('to lift', [{ x: LIFT.x, z: LIFT.z - 1, tol: 1 }]);
        await locTalk('lift', () => q.useOnLoc(ITEM.ana, loc(LIFT)), [/yes please/i, /very gregarious/i], () => !q.has(ITEM.ana) && q.sawText(/no one operating the lift/i));
        q.milestone(22);
        // 18. The cave west, the mine exit; the winch (23) and the barrel up top (24).
        await q.walk('to cave back', [{ x: CAVE_E.x + 1, z: CAVE_E.z, tol: 0 }]);
        await q.step('cave west', () => q.opLoc(loc(CAVE_E), 1), () => x() <= 3279, 12, 4);
        await q.waitTicks(2);
        await mineOut();
        await q.walk('to winch', [{ x: 3280, z: 3018, tol: 0 }]);
        await locTalk('winch', () => { const w = loc(WINCH); return q.opLoc(w, q.opIndex(w, /operate|pull|use/i) === 1 ? 2 : q.opIndex(w, /operate|pull|use/i)); }, [], () => q.sawText(/get me out of here/i));
        await locTalk('up barrel', () => { const b = loc(UP_BARREL); return q.opLoc(b, q.opIndex(b, /search/i) === 1 ? 2 : q.opIndex(b, /search/i)); }, [], () => q.has(ITEM.ana));
        q.milestone(24);
        // 19. Ana on the cart (25); the driver's riot story (mine_cart_driver.rs2:258-332); the ride out (26).
        await q.walk('to cart', [{ x: CART.x - 1, z: CART.z, tol: 1 }]);
        await locTalk('ana on cart', () => q.useOnLoc(ITEM.ana, loc(CART)), [], () => !q.has(ITEM.ana));
        q.milestone(25);
        await q.talk('driver', /^mine cart driver$/i, [/^nice cart/i, /one wagon wheel/i, /one good turn/i, /fired\.\.\. no, shot/i, /in for a penny/i, /it's like this/i, /prison riot/i, /you can't leave me here/i],
            () => q.sawText(/jump in the cart then/i), { x: 3287, z: 3022 }, 80);
        await locTalk('ride out', () => { const c = loc(CART); return q.opLoc(c, q.opIndex(c, /search/i) === 1 ? 2 : q.opIndex(c, /search/i)); }, [/yes, i'll get on/i], () => q.has(ITEM.ana) && x() < 3270);
        q.milestone(26);
        // 20. Irena (27); Ana gives the wrought iron key; two XP picks complete it (irena.rs2:17-24,77-102; ana.rs2:1-17).
        await q.walk('to irena', [{ x: IRENA.x, z: IRENA.z - 1, tol: 2 }]);
        await q.talk('irena end', /^irena$/i, [/^agility/i], () => questDone, IRENA, 80);
        await q.converse([/^agility/i], () => questDone, 20);
    }
    await q.waitUntil(() => questDone, 10);
    q.milestone(100);
    off();
    await q.end(questDone, 'qp=2');
} catch (e) { await q.fail(String(e)); }
