// Merlin's Crystal from preset quest_merlin (beside King Arthur in Camelot), at the planner's state for the merlin
// row: every skill 99 (after the last 99; haggis-cli --order row 48), Dragon Slayer done. Reward: Excalibur, 6 QP
// (quest_arthur.rs2 arthur_quest_complete). No XP.
// Varp %arthur (14): 1 King Arthur (king_arthur.rs2), 2 Gawain "how Merlin got trapped" (sir_gawain.rs2), 3 Lancelot
// "into Morgan Le Faye's stronghold" (sir_lancelot.rs2), 4 Morgan Le Faye after Sir Mordred falls (sir_mordred.rs2
// lefaye_spare_son), 5 Thrantax bound (quest_arthur.rs2 opheld5 bat_bones), 6 Excalibur on the crystal, then Arthur
// queues the completion. %excalibur_components_progress (bits, quest_arthur.constant): 0 chaos altar words,
// 1 black candle asked, 2 Excalibur started (lady_of_the_lake.rs2), 3-4 the beggar (beggar.rs2).
// Route: Camelot knights; the Catherby crate (merlincrate_empty 63 at 2801,3442) carries the player into Keep Le Faye
// (2778,3401); Sir Mordred on level 2; the keep crate (merlincrate_empty2 64 at 2779,3401,1) goes back to Catherby;
// the candle maker; Falador teleport, the Lady of the Lake (Taverley); the jeweller's door in Port Sarim (59 at
// 3016,3246) and the beggar; Varrock teleport, the chaos altar (thrantaxaltar 61 at 3239,3608, Wilderness);
// Camelot teleport, bat bones dropped on the magic symbol (2780,3515) with the lit black candle; Excalibur on the
// crystal (62 at 2767,3493, level 2); King Arthur.
// Helper items (tradeable): bucket of wax (30), bat bones (530), bread (2309), tinderbox (590), runes.
// MC_FROM=<milestone> starts later (debug presets); MC_STOP=<milestone> ends early.
import { openQuest } from './quest-lib';

const ARTHUR = { x: 2764, z: 3515 };
const GAWAIN = { x: 2763, z: 3506 };
const LANCELOT = { x: 2759, z: 3515 };                    // level 1 (maps/m43_54.jm2 1 7 59)
const CATHERBY_CRATE = { x: 2801, z: 3442 };
const KEEP_CRATE = { x: 2779, z: 3401 };                  // level 1
const MORDRED = { x: 2769, z: 3403 };                     // level 2
const CANDLE_MAKER = { x: 2800, z: 3439 };
const LADY = { x: 2924, z: 3405 };
const JEWELLER_DOOR = { x: 3016, z: 3246 };
const ALTAR = { x: 3239, z: 3608 };
const SYMBOL = { x: 2780, z: 3515 };
const CRYSTAL = { x: 2767, z: 3493 };                     // level 2
const ITEM = { wax: 30, unlit: 38, lit: 32, excalibur: 35, bones: 530, bread: 2309, tinderbox: 590, food: 379 };
const NPC = { mordred: 247 };
const PFM = 14;

const q = await openQuest({ cap: 5000, eatAt: 60, food: [ITEM.food], lumbridgeOk: false });
try {
    const FROM = Number(process.env.MC_FROM || 0);
    const STOP = Number(process.env.MC_STOP || 99);
    let questDone = false;
    const offDone = q.s.onTick(() => { if (q.msgCount(/quest complete|completed the\s+merlin/i) > 0) questDone = true; });
    const ms = async (k: number): Promise<void> => { q.milestone(k); if (k >= STOP) await q.end(true, `stopped at ${k}`); };
    const tele = (label: string, comp: string, x: number, z: number) => q.teleport(label, comp, x, z);
    const pfmOn = (): boolean => !!q.st()?.prayers?.activePrayers?.[PFM];
    const setPfm = async (on: boolean): Promise<void> => {
        if (pfmOn() === on) return;
        await q.step(`protect from melee ${on ? 'on' : 'off'}`, () => q.s.direct({ type: 'togglePrayer', prayerIndex: PFM, reason: 'SDK' }), () => pfmOn() === on, 3, 3);
    };
    const levelIs = (lv: number) => () => q.lvl() === lv;
    const stairs = (re: RegExp, at: { x: number; z: number }, r = 8) => () => q.findLoc(l => /stair|ladder/i.test(l.name) && Math.max(Math.abs(l.x - at.x), Math.abs(l.z - at.z)) <= r && (l.optionsWithIndex ?? []).some((o: any) => re.test(o.text)));
    const listLocs = (r = 6) => q.locs().filter((l: any) => l.distance <= r).map((l: any) => `${l.name}#${l.id}@${l.x},${l.z}:${(l.optionsWithIndex ?? []).map((o: any) => o.text).join('/')}`).join(' ');
    // A crate ride: op 2 ("Search") on the crate, "Yes." to hide, the mesbox pages, "Yes." to get out.
    const crate = async (label: string, locId: number, at: { x: number; z: number }, arrived: () => boolean): Promise<void> => {
        for (let i = 0; i < 3 && !arrived(); i++) {
            await q.guard(label);
            const c = q.findLoc(l => l.id === locId && l.x === at.x && l.z === at.z) ?? { id: locId, x: at.x, z: at.z };
            await q.opLoc(c, 2);
            await q.waitUntil(() => q.dialogOpen(), 15);
            await q.converse([/^yes\.?$/i], () => arrived() && !q.dialogOpen(), 80);
        }
        if (!arrived()) await q.fail(`${label}: ${listLocs()}`);
    };

    // 1-3. King Arthur, Gawain, Lancelot (upstairs).
    if (FROM < 1) {
        await q.talk('arthur', /^king arthur$/i, [/knight of the round table/i], () => q.sawText(/talk to my knights if you need any help/i), ARTHUR, 40);
        await ms(1);
    }
    if (FROM < 2) {
        await q.talk('gawain', /^sir gawain$/i, [/how merlin got trapped/i], () => q.sawText(/renegade knights led by sir mordred/i), GAWAIN, 40);
        await ms(2);
    }
    if (FROM < 3) {
        if (q.lvl() === 0) {
            if (!stairs(/climb-up/i, LANCELOT, 12)()) console.log(`WARN no camelot stairs: ${listLocs(12)}`);
            await q.climb('camelot stairs up', stairs(/climb-up/i, LANCELOT, 12), /climb-up/i, levelIs(1));
        }
        await q.talk('lancelot', /^sir lancelot$/i, [/into morgan le faye's stronghold/i], () => q.sawText(/delivery|impenetrable|candles/i), LANCELOT, 60);
        await q.climb('camelot stairs down', stairs(/climb-down/i, LANCELOT, 12), /climb-down/i, levelIs(0));
        await ms(3);
    }

    // 4. The Catherby crate into Keep Le Faye; Sir Mordred (38 HP, max hit 4) on level 2; Morgan Le Faye.
    if (FROM < 4) {
        await q.walk('to catherby crate', [{ x: CATHERBY_CRATE.x, z: CATHERBY_CRATE.z - 1, tol: 1 }]);
        await crate('catherby crate', 63, CATHERBY_CRATE, () => q.near(2778, 3401, 3) && q.lvl() === 0);
        await setPfm(true);
        if (!stairs(/climb-up/i, { x: 2778, z: 3401 }, 15)()) console.log(`WARN no keep stairs: ${listLocs(15)}`);
        await q.climb('keep stairs 1', stairs(/climb-up/i, { x: 2778, z: 3401 }, 15), /climb-up/i, levelIs(1));
        await q.climb('keep stairs 2', stairs(/climb-up/i, { x: 2775, z: 3403 }, 15), /climb-up/i, levelIs(2));
        const mordred = () => (q.st()?.nearbyNpcs ?? []).find((n: any) => n.id === NPC.mordred);
        if (!mordred()) await q.waitUntil(() => !!mordred(), 10);
        for (let t = 0; t < 200 && !q.dialogOpen(); t++) {
            await q.guard('mordred');
            const n = mordred();
            if (n && t % 4 === 0) await q.s.direct({ type: 'interactNpc', npcIndex: n.index, optionIndex: n.optionsWithIndex?.find((o: any) => /attack/i.test(o.text))?.opIndex ?? 2, reason: 'SDK' });
            await q.waitTicks(1);
        }
        await q.converse([/tell me how to untrap merlin/i, /ok i will go do all that/i], () => q.sawText(/morgan le faye vanishes/i) && !q.dialogOpen(), 60);
        if (!q.sawText(/morgan le faye vanishes/i)) await q.fail('morgan le faye');
        await ms(4);
    }

    // 5. The keep crate back to Catherby; the candle maker: "black candles" sets bit 1, then the wax for the candle.
    if (FROM < 5) {
        if (q.lvl() === 2) await q.climb('keep stairs down', stairs(/climb-down/i, MORDRED, 15), /climb-down/i, levelIs(1));
        await q.dash('to keep crate', KEEP_CRATE.x - 1, KEEP_CRATE.z, 1, 25);
        await crate('keep crate', 64, KEEP_CRATE, () => q.near(2802, 3441, 3) && q.lvl() === 0);
        await setPfm(false);
        await q.talk('candle maker 1', /^candle maker$/i, [/any black candles/i], () => q.sawText(/supply you with a black candle/i), CANDLE_MAKER, 40);
        await q.talk('candle maker 2', /^candle maker$/i, [], () => q.has(ITEM.unlit), CANDLE_MAKER, 30);
        await q.step('light candle', () => q.useOnItem(ITEM.tinderbox, ITEM.unlit), () => q.has(ITEM.lit), 4, 4);
        await ms(5);
    }

    // 6. Excalibur: the Lady of the Lake sets bit 2; the jeweller's door in Port Sarim spawns the beggar; bread.
    if (FROM < 6) {
        await tele('falador teleport', 'magic:falador_teleport', 2965, 3378);
        await q.walk('to lady', [{ x: LADY.x, z: LADY.z - 1, tol: 2 }]);
        await q.talk('lady', /^lady of the lake$/i, [/seek the sword excalibur/i], () => q.sawText(/that seems easy enough/i), LADY, 40);
        await tele('falador teleport 2', 'magic:falador_teleport', 2965, 3378);
        await q.walk('to jeweller', [{ x: JEWELLER_DOOR.x, z: JEWELLER_DOOR.z - 1, tol: 0 }]);
        const door = () => q.findLoc(l => l.id === 59 && l.x === JEWELLER_DOOR.x && l.z === JEWELLER_DOOR.z) ?? { id: 59, x: JEWELLER_DOOR.x, z: JEWELLER_DOOR.z };
        await q.opLoc(door(), 1);
        await q.waitUntil(() => q.dialogOpen(), 10);
        await q.converse([/^yes,? certainly/i], () => q.has(ITEM.excalibur) && !q.dialogOpen(), 60);
        if (!q.has(ITEM.excalibur)) await q.fail(`excalibur: ${listLocs()}`);
        await ms(6);
    }

    // 7. The chaos altar north of Varrock: op 2 gives the words (bit 0).
    if (FROM < 7) {
        await tele('varrock teleport', 'magic:varrock_teleport', 3213, 3424);
        await setPfm(true);
        await q.walk('to chaos altar', [{ x: ALTAR.x, z: ALTAR.z - 2, tol: 2 }]);
        const altar = () => q.findLoc(l => l.id === 61) ?? { id: 61, x: ALTAR.x, z: ALTAR.z };
        await q.opLoc(altar(), 2);
        await q.waitUntil(() => q.sawText(/snarthon candtrick termanto/i), 15);
        await q.converse([], () => !q.dialogOpen(), 5);
        if (!q.sawText(/snarthon candtrick termanto/i)) await q.fail(`chaos altar: ${listLocs()}`);
        await setPfm(false);
        await ms(7);
    }

    // 8. Camelot teleport; bat bones dropped on the magic symbol with the lit candle summon Thrantax.
    if (FROM < 8) {
        await tele('camelot teleport', 'magic:camelot_teleport', 2757, 3478);
        await q.walk('to symbol', [{ x: SYMBOL.x, z: SYMBOL.z, tol: 0 }]);
        await q.step('drop bat bones', () => q.s.sdk.sendDropItem(q.slot(ITEM.bones)!), () => q.dialogOpen() || !q.has(ITEM.bones), 6, 3);
        await q.converse([/^snarthon candtrick termanto$/i], () => q.sawText(/the deed is done/i) && !q.dialogOpen(), 60);
        if (!q.sawText(/the deed is done/i)) await q.fail('thrantax');
        await ms(8);
    }

    // 9. Excalibur on the crystal (level 2), then King Arthur.
    if (FROM < 9) {
        await q.walk('to crystal tower', [{ x: CRYSTAL.x, z: CRYSTAL.z + 3, tol: 4 }]);
        if (!stairs(/climb-up/i, CRYSTAL, 10)()) console.log(`WARN no tower stairs: ${listLocs(10)}`);
        await q.climb('tower up 1', stairs(/climb-up/i, CRYSTAL, 10), /climb-up/i, levelIs(1));
        await q.climb('tower up 2', stairs(/climb-up/i, CRYSTAL, 10), /climb-up/i, levelIs(2));
        const crystal = () => q.findLoc(l => l.id === 62) ?? { id: 62, x: CRYSTAL.x, z: CRYSTAL.z };
        await q.step('excalibur on crystal', () => q.useOnLoc(ITEM.excalibur, crystal()), () => q.sawText(/set merlin free/i) || q.msgCount(/shatters under the force/i) > 0, 10, 3);
        await q.converse([], () => q.sawText(/set merlin free/i) && !q.dialogOpen(), 20);
        await q.climb('tower down 1', stairs(/climb-down/i, CRYSTAL, 10), /climb-down/i, levelIs(1));
        await q.climb('tower down 2', stairs(/climb-down/i, CRYSTAL, 10), /climb-down/i, levelIs(0));
        await q.talk('arthur 2', /^king arthur$/i, [], () => questDone, ARTHUR, 40);
        await ms(9);
    }

    offDone();
    await q.end(questDone, `qp=6 excalibur=${q.has(ITEM.excalibur)} questMsg=${questDone}`);
} catch (e) { await q.fail(String(e)); }
