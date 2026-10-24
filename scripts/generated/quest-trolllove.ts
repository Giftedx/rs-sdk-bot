// Troll Romance from preset quest_trolllove (beside Ug, level 1 of the Troll Stronghold; every skill 99; Death
// Plateau, Troll Stronghold and Eadgar's Ruse done; the troll set worn; helper items below). Reward: 2 QP, 8,000
// Agility and 4,000 Strength XP before 25x, 7 uncut gems (quest_troll_love.rs2:296-307).
// %troll_love (varp 385, quest_troll_love.constant): Ug 5 (ug.rs2:29-72), Aga 10 (aga.rs2:20-50), Tenzing 15
// (quest_death/scripts/death_sherpa.rs2:43-66), Dunstan 20 and the sled 22 (death_smithy.rs2:213-255), the waxed sled
// 25 (quest_troll_love.rs2:67-98), the Trollweiss 30 (:47-57), Ug takes it 35 (ug.rs2:76-89), Arrg dead 40
// (arrg.rs2:69-81,119-129); Ug queues the completion (ug.rs2:96-116).
// The sled rides (quest_troll_love.rs2:1-15,138-293): the waxed sled worn (only in zone 0_43_58_0_0..0_43_60_63_63,
// :117-133), the barrier at 2772,3835 rides to 2790,3794 and the barrier at 2785,3771 rides to 2794,3719. The first
// ride crashes 1 time in 250 (:162-196): the bot lands at 2799,3794 and the sled lies on 2799,3795.
// The Trollheim teleport (from Eadgar's Ruse) brings the bot back from the foot of the slope and from Arrg's fight.
// TR_FROM=<stage> starts at a debug preset (packages/practice/src/presets-long.ts).
import { openQuest } from './quest-lib';

const ITEM = { swampTar: 1939, wax: 30, sled: 4083, sledWaxed: 4084, sledWax: 4085, flower: 4086, scimitar: 1333, shield: 1201 };
const UG = { x: 2827, z: 10064 };                           // level 1
const AGA = { x: 2828, z: 10104 };                          // level 1
const ARRG = { x: 2828, z: 10095 };                         // level 1
const TENZING = { x: 2820, z: 3556 };
const DUNSTAN = { x: 2919, z: 3574 };
const PRISON_DOOR = { id: 3780, x: 2848, z: 10107 };        // level 1, west wall
const L1_STAIRS = { id: 3789, x: 2852, z: 10107 };          // level 1 -> 2852,10105 level 0
const BACK_EXIT = { id: 3761, x: 2823, z: 10048 };          // level 0 -> 2827,3646
const ROCKS_BACK = { id: 3748, x: 2833, z: 3628 };          // 3629 -> 3627
const ROCKS_S = { id: 3748, x: 2856, z: 3612 };             // 3613 -> 3611
const STILE = { id: 3730, x: 2817, z: 3562 };
const TENZING_BACK = { id: 3746, x: 2820, z: 3557 };
const TENZING_DOOR = { id: 3745, x: 2822, z: 3555 };
const CAVE_IN = { id: 5007, x: 2820, z: 3743 };             // trollromance_caveentrance -> 2803,10187
const CREVASSE = { id: 5025, x: 2772, z: 10233 };           // trollromance_snow_cavewall_crevis -> 2778,3869
const BARRIER_1 = { id: 5015, x: 2772, z: 3835 };           // first ride -> 2790,3794
const BARRIER_2 = { id: 5015, x: 2785, z: 3771 };           // second ride -> 2794,3719
const FLOWERS = 5006;                                       // trollromance_rareflowers, 2775-2781,3780-3785
const SH_DOOR = { id: 3771, x: 2839, z: 3689 };             // -> 2837,10090 level 2
const L2_STAIRS_N = { id: 3789, x: 2843, z: 10108 };        // level 2 -> 2841,10108 level 1
const TROLLHEIM = { x: 2890, z: 3679 };
const PFM = 14;

const FROM = process.env.TR_FROM ?? 'start';
const STAGES = ['start', 'cave', 'arrg'];
const from = (s: string) => STAGES.indexOf(FROM) <= STAGES.indexOf(s);

const q = await openQuest({ cap: 4000, eatAt: 50, food: [385] });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const x = () => q.pos()?.worldX ?? 0;
    const z = () => q.pos()?.worldZ ?? 0;
    const lv = () => q.lvl();
    const worn = (id: number) => (q.st()?.equipment ?? []).some((e: any) => e?.id === id);
    const loc = (l: { id: number; x: number; z: number }) => q.locAt(l.x, l.z) ?? q.findLoc((k: any) => k.id === l.id && Math.abs(k.x - l.x) <= 1 && Math.abs(k.z - l.z) <= 1) ?? l;
    const closeDlg = async () => { if (q.dialogOpen()) await q.converse([], () => !q.dialogOpen(), 20); };
    const op = async (label: string, l: { id: number; x: number; z: number }, done: () => boolean, ticks = 15, tries = 5) => {
        await q.step(label, async () => { if (q.dialogOpen()) await closeDlg(); return q.opLoc(loc(l), 1); }, done, ticks, tries);
        await q.waitTicks(1);
    };
    const useItem = async (label: string, a: number, b: number, done: () => boolean) => {
        await q.step(label, async () => { if (q.dialogOpen()) await closeDlg(); return q.useOnItem(a, b); }, done, 8, 4);
        await closeDlg();
    };
    const wield = async (id: number) => {
        if (worn(id) || !q.has(id)) return;
        const opi = (q.inv().find((i: any) => i.id === id)?.optionsWithIndex ?? []).find((o: any) => /wield|wear|ride/i.test(o.text))?.opIndex ?? 2;
        await q.step(`wield ${id}`, () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(id)!, optionIndex: opi, reason: 'SDK' }), () => worn(id), 4, 3);
    };
    const pfm = async (on: boolean) => {
        const p: any = q.st()?.prayers;
        if (!!p?.activePrayers?.[PFM] === on || (on && (p?.prayerPoints ?? 0) <= 0)) return;
        await q.step(`pfm ${on}`, () => q.s.direct({ type: 'togglePrayer', prayerIndex: PFM, reason: 'SDK' }), () => !!(q.st() as any)?.prayers?.activePrayers?.[PFM] === on, 3, 3);
    };
    const trollheim = async () => {
        await closeDlg();
        await q.teleport('trollheim teleport', 'magic:trollheim_teleport', TROLLHEIM.x, TROLLHEIM.z);
    };
    // Trollheim to level 1 of the stronghold by the front door (2837,10090 level 2) and the north stairs.
    const toLevel1 = async () => {
        await q.walk('to stronghold door', [{ x: SH_DOOR.x + 2, z: SH_DOOR.z, tol: 1 }]);
        await op('stronghold door', SH_DOOR, () => z() > 10000 && lv() === 2);
        await q.walk('to l2 stairs', [{ x: L2_STAIRS_N.x, z: L2_STAIRS_N.z - 1, tol: 1 }]);
        await op('l2 stairs', L2_STAIRS_N, () => lv() === 1);
    };
    const ug = async (label: string, pats: RegExp[], ok: () => boolean) => {
        await q.talk(label, /^ug$/i, pats, ok, UG, 80);
        await closeDlg();
    };

    if (from('start')) {
        // 1. Ug: "Awww, you poor troll...", "Don't worry now, I'll see what I can do." (5).
        await ug('ug 1', [/awww, you poor troll/i, /don't worry now/i], () => q.sawText(/maybe ug not eat you/i));
        q.milestone(5);
        // 2. Aga: "So... how's your... um... love life?" (10), then "Errr... I've got to go."
        await q.talk('aga', /^aga$/i, [/love life/i, /i've got to go/i], () => q.sawText(/he will get trollweiss/i), AGA, 80);
        await closeDlg();
        q.milestone(10);
        // 3. Out by the prison stairs, the back exit, the troll rocks, the secret way and the stile to Tenzing's back
        // door (quest-troll.ts, quest-death.ts).
        await q.walk('to prison door', [{ x: PRISON_DOOR.x - 1, z: PRISON_DOOR.z, tol: 0 }]);
        await op('prison door', PRISON_DOOR, () => x() >= PRISON_DOOR.x);
        await op('l1 stairs down', L1_STAIRS, () => lv() === 0);
        await q.walk('to back exit', [{ x: BACK_EXIT.x + 1, z: BACK_EXIT.z + 1, tol: 1 }]);
        await op('back exit', BACK_EXIT, () => z() < 4000);
        await q.walk('to back rocks', [{ x: ROCKS_BACK.x, z: ROCKS_BACK.z + 1, tol: 0 }]);
        await op('back rocks', ROCKS_BACK, () => z() <= 3627);
        await q.walk('to troll rocks top', [{ x: ROCKS_S.x, z: ROCKS_S.z + 1, tol: 0 }]);
        await op('troll rocks down', ROCKS_S, () => z() <= 3611);
        await q.walk('secret way', [{ x: 2843, z: 3606, tol: 2 }, { x: 2830, z: 3594, tol: 2 }, { x: 2817, z: 3584, tol: 2 }, { x: STILE.x, z: STILE.z + 2, tol: 0 }]);
        await op('stile', STILE, () => z() < STILE.z, 12);
        await q.walk('to back door', [{ x: TENZING_BACK.x, z: TENZING_BACK.z + 1, tol: 0 }]);
        await op('back door', TENZING_BACK, () => z() <= TENZING_BACK.z, 10);
        // 4. Tenzing: "Do you know where I can find Trollweiss?", "What would I need to make such a sled?" (15).
        await q.talk('tenzing', /^tenzing$/i, [/where i can find trollweiss/i, /what would i need to make such a sled/i], () => q.sawText(/why don't you ask dunstan/i), TENZING, 100);
        await closeDlg();
        q.milestone(15);
        await q.walk('to tenzing door in', [{ x: TENZING_DOOR.x, z: TENZING_DOOR.z, tol: 0 }]);
        await op('tenzing door out', TENZING_DOOR, () => x() > TENZING_DOOR.x, 10);
        // 5. Dunstan: "I need a sled!!", "Yes." (20); again with the maple logs, iron bar and rope: the sled (22).
        await q.walk('to smithy door', [{ x: 2921, z: 3570, tol: 0 }]);
        await q.openDoor('smithy door', 2921, 3571);
        await q.walk('into smithy', [{ x: 2921, z: 3573, tol: 1 }]);
        await q.talk('dunstan 1', /^dunstan$/i, [/i need a sled/i, /^yes\.?$/i], () => q.sawText(/designs ready/i), DUNSTAN, 80);
        await closeDlg();
        q.milestone(20);
        await q.talk('dunstan 2', /^dunstan$/i, [/where can i get wax from/i, /see you/i], () => q.has(ITEM.sled), DUNSTAN, 80);
        await closeDlg();
        q.milestone(22);
        // 6. Swamp tar on the bucket of wax (with the cake tin) makes the sled wax; the sled on the wax (25).
        await useItem('sled wax', ITEM.swampTar, ITEM.wax, () => q.has(ITEM.sledWax));
        await useItem('wax sled', ITEM.sled, ITEM.sledWax, () => q.has(ITEM.sledWaxed));
        q.milestone(25);
    }
    if (from('cave')) {
        // 7. Trollheim teleport; the ice-troll cave; the crevasse to the top of the slope.
        await trollheim();
        await q.walk('to ice cave', [{ x: CAVE_IN.x + 2, z: CAVE_IN.z, tol: 1 }]);
        await op('ice cave', CAVE_IN, () => z() > 10000);
        await q.walk('to crevasse', [{ x: CREVASSE.x, z: CREVASSE.z - 1, tol: 1 }]);
        await op('crevasse', CREVASSE, () => z() < 4000);
        q.milestone('top');
        // 8. The waxed sled worn, the first ride; the Trollweiss (30); the second ride.
        await q.walk('to barrier 1', [{ x: BARRIER_1.x, z: BARRIER_1.z + 1, tol: 0 }]);
        await wield(ITEM.sledWaxed);
        await op('ride 1', BARRIER_1, () => z() <= 3800, 40, 3);
        await q.waitUntil(() => q.near(2790, 3794, 0) || q.near(2799, 3794, 0), 30);
        if (q.near(2799, 3794, 1)) {
            // The crash: the sled lies on 2799,3795.
            console.log(`WARN sled crash at ${q.T()}`);
            await q.waitTicks(4);
            await closeDlg();
            for (let i = 0; i < 10 && !q.has(ITEM.sledWaxed) && !worn(ITEM.sledWaxed); i++) {
                const g = (q.st()?.groundItems ?? []).find((o: any) => o.id === ITEM.sledWaxed);
                if (g && i % 3 === 0) await q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: ITEM.sledWaxed, reason: 'SDK' });
                await q.waitTicks(1);
            }
        }
        q.milestone('ride1');
        for (let i = 0; i < 6 && !q.has(ITEM.flower); i++) {
            await q.guard('trollweiss');
            const f = q.findLoc((l: any) => l.id === FLOWERS);
            if (!f) { await q.walk('to flowers', [{ x: 2780, z: 3782, tol: 1 }]); continue; }
            await q.opLoc(f, (f.optionsWithIndex ?? []).find((o: any) => /pick/i.test(o.text))?.opIndex ?? 2);
            await q.waitUntil(() => q.has(ITEM.flower), 20);
        }
        if (!q.has(ITEM.flower)) await q.fail('trollweiss');
        q.milestone(30);
        await q.walk('to barrier 2', [{ x: BARRIER_2.x, z: BARRIER_2.z + 1, tol: 0 }]);
        await wield(ITEM.sledWaxed);
        await op('ride 2', BARRIER_2, () => z() <= 3740, 50, 3);
        await q.waitUntil(() => q.near(2794, 3719, 0), 30);
        q.milestone('ride2');
        // 9. Weapon and shield back on; Trollheim teleport; Ug takes the Trollweiss (35).
        await wield(ITEM.scimitar);
        await wield(ITEM.shield);
        await trollheim();
        await toLevel1();
        await ug('ug flower', [], () => !q.has(ITEM.flower) && q.sawText(/ok i'll do it/i));
        q.milestone(35);
    }
    if (from('arrg')) {
        // 10. Arrg: "I am here to kill you!" moves the bot to 2914,3611 with an attackable Arrg 4 tiles west
        // (arrg.rs2:69-81); Arrg (level 113, 140 hp, melee and thrown rocks) dead (40).
        await wield(ITEM.scimitar);
        await wield(ITEM.shield);
        // The server can hold the page after the option for 4 ticks (proof trial 3: 848-851), and q.talk() takes 3
        // shut ticks as the end and clicks Arrg again, which cancels the teleport. So this loop waits 10 shut ticks.
        // The stronghold trolls around Arrg (maps/m44_157.jm2: 7 within 10 tiles) attack, and a hit closes the dialog
        // (proof trials: the page after "Whaaaaaaaat?" or the option shut at once), so the bot kills an attacker first.
        const attacker = () => (q.st()?.nearbyNpcs ?? []).find((n: any) => n.inCombat && n.distance <= 3 && !/^(arrg|ug|aga)$/i.test(n.name) && (n.optionsWithIndex ?? []).some((o: any) => /attack/i.test(o.text)));
        for (let i = 0; i < 8 && z() > 4000; i++) {
            await q.guard('arrg talk');
            for (let k = 0; k < 10 && attacker(); k++) {
                const a = attacker();
                console.log(`WARN arrg talk: attacker ${a.name} at ${a.x},${a.z}`);
                await q.s.bot.attack(a as any);
                await q.waitUntil(() => !attacker(), 6);
            }
            const n = q.npc(/^arrg$/i);
            if (!n) { await q.walk('to arrg', [{ x: ARRG.x, z: ARRG.z - 1, tol: 2 }]); continue; }
            await q.talkTo(n);
            await q.waitUntil(() => q.dialogOpen(), 20);
            let shut = 0;
            await q.converse([/i am here to kill you/i], () => { shut = q.dialogOpen() ? 0 : shut + 1; return z() < 4000 || shut >= 10; }, 80);
        }
        if (z() > 4000) await q.fail('arrg talk');
        await closeDlg();
        await pfm(true);
        let seen = false, gone = 0;
        const t1 = q.T();
        while (gone < 3 && q.T() - t1 < 500) {
            await q.guard('arrg');
            if (q.dialogOpen()) { await closeDlg(); continue; }
            const n = q.npc(/^arrg$/i);
            if (!n) { if (seen) gone++; await q.waitTicks(1); continue; }
            seen = true; gone = 0;
            if (!(n.optionsWithIndex ?? []).some((o: any) => /attack/i.test(o.text)) && n.distance > 6) { await q.waitTicks(1); continue; }
            await q.s.bot.attack(n as any);
            await q.waitUntil(() => !q.npc(/^arrg$/i) || q.dialogOpen(), 6);
        }
        if (gone < 3) await q.fail('arrg');
        q.milestone(40);
        await pfm(false);
        // 11. Trollheim teleport; Ug completes the quest.
        await q.waitTicks(2);
        await trollheim();
        await toLevel1();
        await ug('ug end', [], () => questDone);
        await q.waitUntil(() => questDone, 10);
    }
    off();
    if (!questDone) await q.fail('no quest complete message');
    q.milestone(45);
    await q.end(true, 'qp=2');
} catch (e) {
    await q.fail(`error ${(e as Error).message}`);
}
