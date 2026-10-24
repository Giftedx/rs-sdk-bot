// Demon Slayer from preset quest_demon (Gypsy Aris's tent, Varrock; every skill 99; 25 bones, 1 coin, a law and a fire
// rune, staff of air wielded). Reward: 3 QP, Silverlight (quest_demon/scripts/demon_slayer.rs2:3-7).
// Varp %demonstart (222): 0 -> 1 Aris (gypsy.rs2:159-232), 2 Sir Prysin (sir_prysin.rs2:119-123), 3 Traiborn's
// bones talk (traiborn.rs2:130-147), +1 a bone to 28 (:22-32), 29 Silverlight (sir_prysin.rs2:64-76), then Delrith
// weakened and the incantation Carlem Aber Camerinthum Purchai Gabindo (option 4, delrith.rs2:15-35) queues completion.
// The keys and Silverlight are untradeable (quest_demon/configs/demon.obj).
import { openQuest } from './quest-lib';

const ARIS = { x: 3203, z: 3424 };
const PRYSIN = { x: 3204, z: 3473 };
const ROVIN = { x: 3204, z: 3496 };                        // level 2
const TRAIBORN = { x: 3112, z: 3162 };                     // level 1
const DELRITH = { x: 3229, z: 3369 };
const DRAIN = { id: 2843, x: 3225, z: 3495 };              // questdrain, maps/m50_54.jm2
const SINK = { id: 874, x: 3224, z: 3494 };                // sink2 in the palace kitchen
const KEY3_AT = { x: 3225, z: 9897 };                      // obj_add 0_50_154_25_41 (demon_slayer.rs2:44)
const ITEM = { coin: 995, bones: 526, bucket: 1925, water: 1929, key1: 2399, key2: 2400, key3: 2401, silverlight: 2402 };

const q = await openQuest({ cap: 3000 });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const lv = () => q.lvl();
    const z = () => q.pos()?.worldZ ?? 0;
    const ground = (id: number): any => (q.st()?.groundItems ?? []).filter((g: any) => g.id === id).sort((a: any, b: any) => q.cheb(a.x, a.z) - q.cheb(b.x, b.z))[0];
    const pickup = (label: string, id: number, ticks = 15, tries = 4) => q.step(label, () => { const g = ground(id); return g ? q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' }) : q.waitTicks(1); }, () => q.has(id), ticks, tries);
    const worn = (id: number) => (q.st()?.equipment ?? []).some((e: any) => e.id === id);
    const stairs = (x: number, zz: number, re: RegExp) => () => q.findLoc(l => Math.abs(l.x - x) <= 1 && Math.abs(l.z - zz) <= 1 && (l.optionsWithIndex ?? []).some((o: any) => re.test(o.text)));

    // 1. Aris: 1 coin for the fortune; "Who's Delrith?", "Okay, where is he?" sets 1; the incantation (gypsy.rs2:150-246).
    await q.talk('aris', /^gypsy$/i, [/^ok, here you go/i, /very interesting/i, /who's delrith/i, /okay, where is he/i, /what is the magical incantation/i, /okay, thanks/i],
        () => q.sawText(/rituals to summon delrith/i), ARIS, 120);
    q.milestone(1);

    // 2. Sir Prysin in the south-west room of the palace: the 3 keys (sir_prysin.rs2:17-123) set 2.
    await q.walk('to prysin', [{ x: 3211, z: 3460, tol: 2 }, { x: 3207, z: 3472, tol: 1 }]);
    await q.openDoor('prysin door', 3206, 3472);
    await q.talk('prysin 1', /^sir prysin$/i, [/gypsy aris said/i, /i need to find silverlight/i, /he's back/i, /so give me the keys/i, /where can i find captain rovin/i, /better go key hunting/i],
        () => q.sawText(/gave the other to the wizard traiborn/i), PRYSIN, 80);
    q.milestone(2);

    // 3. Traiborn on level 1 of the Wizards' Tower: the key talk sets 3, then the 25 bones (one per p_delay) give key 1.
    await q.openDoor('prysin door out', 3206, 3472);
    // The tower doors are named by tile: the SDK walker took the bot round the outside of the west wall (trial 1).
    await q.walk('to wizards tower', [{ x: 3109, z: 3168, tol: 1 }]);
    await q.openDoor('tower door', 3109, 3166);
    await q.dash('tower hall', 3108, 3164, 1);
    await q.openDoor('stair room door', 3107, 3162);
    await q.dash('tower stairs', 3105, 3161, 1);
    await q.climb('tower stairs up', stairs(3103, 3159, /climb-up/i), /climb-up/i, () => lv() === 1);
    await q.openDoor('traiborn door', 3109, 3162);
    await q.talk('traiborn 1', /^traiborn$/i, [/key given to you by sir prysin/i, /got any keys knocking around/i, /get the bones for you/i],
        () => q.sawText(/when i've got some bones/i), TRAIBORN, 80);
    q.milestone(3);
    // Each bone closes the dialog for a p_delay(1) (traiborn.rs2:22-32), so the talk stops at "Give 'em here" and the
    // bot only clicks through the incantation pages until the key arrives (trial 2 re-clicked Traiborn in the delays).
    await q.talk('traiborn bones', /^traiborn$/i, [], () => q.sawText(/give 'em here/i), TRAIBORN, 20, true);
    await q.converse([], () => q.has(ITEM.key1), 150);
    if (!q.has(ITEM.key1)) await q.fail('no key 1');
    q.milestone(28);

    // 4. Varrock Teleport (staff of air); Captain Rovin on level 2 of the palace (captain_rovin.rs2:27-45) gives key 2.
    await q.teleport('varrock teleport', 'magic:varrock_teleport', 3212, 3424);
    await q.walk('to west stairs', [{ x: 3211, z: 3460, tol: 2 }, { x: 3203, z: 3495, tol: 1 }]);
    await q.climb('west stairs 1', stairs(3202, 3497, /climb-up/i), /climb-up/i, () => lv() === 1);
    await q.climb('west stairs 2', stairs(3202, 3497, /climb-up/i), /climb-up/i, () => lv() === 2);
    await q.talk('rovin', /^captain rovin$/i, [/yes,? i know,? but this is important/i, /demon who wants to invade/i], () => q.has(ITEM.key2), ROVIN, 80);
    q.milestone('key2');
    await q.climb('west stairs down 2', stairs(3202, 3497, /climb-down/i), /climb-down/i, () => lv() === 1);
    await q.climb('west stairs down 1', stairs(3202, 3497, /climb-down/i), /climb-down/i, () => lv() === 0);

    // 5. The bucket on level 1 above the kitchen (east stairs), filled at the kitchen sink and poured down the drain:
    // key 3 drops in the sewer (demon_slayer.rs2:31-47).
    // The east stairs stand in the kitchen (walls x 3217 / 3225, maps/m50_54.jm2); its door 3223,3491 opens from the hall.
    await q.walk('to kitchen door', [{ x: 3223, z: 3490, tol: 0 }]);
    await q.openDoor('kitchen door', 3223, 3491);
    await q.dash('to east stairs', 3220, 3495, 1);
    await q.climb('east stairs up', stairs(3218, 3496, /climb-up/i), /climb-up/i, () => lv() === 1);
    await q.openDoor('bucket room door', 3221, 3496);      // loc_1530, level 1 (trial 4: "I can't reach that!")
    await q.waitUntil(() => !!ground(ITEM.bucket), 100);
    await pickup('bucket', ITEM.bucket);
    await q.openDoor('bucket room door out', 3221, 3496);
    await q.climb('east stairs down', stairs(3219, 3496, /climb-down/i), /climb-down/i, () => lv() === 0);
    await q.dash('to sink', 3223, 3494, 1);
    await q.openDoor('sink door', 3224, 3493);
    await q.step('fill bucket', () => q.useOnLoc(ITEM.bucket, q.locAt(SINK.x, SINK.z) ?? SINK), () => q.has(ITEM.water), 10, 4);
    await q.step('pour drain', () => q.useOnLoc(ITEM.water, q.locAt(DRAIN.x, DRAIN.z) ?? DRAIN), () => !q.has(ITEM.water), 10, 4);
    q.milestone('drain');

    // 6. The manhole east of the palace (3237,3458; manholes.rs2:1-10 opens it, then a jump of +6400 z); key 3 at
    // 3225,9897; out by the ladder 3237,9858. The ladder 3230,3504 north-east of the palace stands inside a walled ruin
    // that the bot could not reach (trial 5).
    const MANHOLE = { x: 3237, z: 3458 };
    await q.walk('to manhole', [{ x: MANHOLE.x, z: MANHOLE.z + 1, tol: 1 }]);
    const manholeOpen = () => !!q.findLoc(l => l.x === MANHOLE.x && l.z === MANHOLE.z && (l.optionsWithIndex ?? []).some((o: any) => /climb-down/i.test(o.text)));
    await q.step('open manhole', () => q.opLoc(q.locAt(MANHOLE.x, MANHOLE.z) ?? { id: 881, ...MANHOLE }, 1), () => manholeOpen() || z() > 9000, 8, 4);
    await q.climb('sewer down', stairs(MANHOLE.x, MANHOLE.z, /climb-down/i), /climb-down/i, () => z() > 9000);
    await q.walk('to key 3', [{ x: KEY3_AT.x, z: KEY3_AT.z, tol: 1 }]);
    await pickup('key 3', ITEM.key3, 15, 5);
    q.milestone('key3');
    await q.walk('to sewer ladder up', [{ x: 3237, z: 9859, tol: 1 }]);
    await q.climb('sewer up', stairs(3237, 9858, /climb-up/i), /climb-up/i, () => z() < 9000);

    // 7. Sir Prysin takes the 3 keys and gives Silverlight (29); wield it.
    await q.walk('to prysin 2', [{ x: 3211, z: 3460, tol: 2 }, { x: 3207, z: 3472, tol: 1 }]);
    await q.openDoor('prysin door 2', 3206, 3472);
    await q.talk('prysin 2', /^sir prysin$/i, [], () => q.has(ITEM.silverlight), PRYSIN, 60);
    q.milestone(29);
    await q.step('wield silverlight', () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(ITEM.silverlight)!, optionIndex: 2, reason: 'SDK' }), () => worn(ITEM.silverlight), 3, 3);
    await q.openDoor('prysin door out 2', 3206, 3472);

    // 8. Delrith in the stone circle south of Varrock: at 0 HP he weakens (delrith.rs2:4-15) and the incantation
    // choice opens; option 4 sends him back and queues the completion.
    await q.walk('to delrith', [{ x: 3211, z: 3420, tol: 3 }, { x: DELRITH.x, z: DELRITH.z + 4, tol: 2 }]);
    const attack = (n: any) => q.s.direct({ type: 'interactNpc', npcIndex: n.index, optionIndex: n.optionsWithIndex?.find((o: any) => /attack/i.test(o.text))?.opIndex ?? 2, reason: 'SDK' });
    for (let t = 0; t < 400 && !questDone; t++) {
        await q.guard('delrith');
        const d: any = q.s.sdk.getDialog();
        if (d?.isOpen && !d.isWaiting) {
            const opt = (d.options ?? []).find((o: any) => /carlem aber camerinthum purchai gabindo/i.test(o.text));
            void q.s.sdk.sendClickDialog(opt ? opt.index : 0);
        } else if (!d?.isOpen) {
            const n = q.npc(/^delrith$/i);
            if (n && t % 4 === 0) await attack(n);
        }
        await q.waitTicks(1);
    }
    q.milestone(100);
    off();
    await q.end(questDone, 'qp=3');
} catch (e) { await q.fail(String(e)); }
