// Pirate's Treasure from preset quest_hunt (beside Redbeard Frank on the Port Sarim jetty; every skill 99; 10 bananas,
// white apron, spade, 200 coins, Varrock and Falador teleport runes from a helper). Reward: 2 QP, 450 coins, a gold
// ring and an emerald (quests/quest_hunt/scripts/dig.rs2:16-24).
// Varp %hunt: 0 -> 1 Redbeard ("I'm in search of treasure."), 2 the rum for the chest key, 3 the message read, then
// the dig in Falador park queues the completion.
// The Karamjan rum (431), chest key and message are tradeable=no (quest_hunt.obj), so the main account smuggles the
// rum: a teleport breaks it (skill_magic/scripts/spells/teleport.rs2:88-93), the customs officer takes it from the
// pack (areas/area_karamja/scripts/customs_officer.rs2:13,48-53), so it rides in Luthas's banana crate to Wydin's
// back room (banana_crate.rs2:50-68, luthas.rs2:12-27, food_store.rs2:20-37).
import { openQuest } from './quest-lib';

const REDBEARD = { x: 3053, z: 3250 };
const WYDIN = { x: 3014, z: 3204 };
const WYDIN_DOOR = { id: 2069, x: 3012, z: 3204 };         // wydindoor, west wall of the back room
const GROCERY = { id: 2071, x: 3009, z: 3207 };            // grocerycrate in the back room
const SEAMEN = { x: 3028, z: 3218 };
const MUSA_DECK = { x: 2956, z: 3143 };                    // 1_46_49_12_7 (sailors.rs2:10)
const SARIM_DECK = { x: 3032, z: 3217 };                   // 1_47_50_24_17 (customs_officer.rs2:94)
const ZAMBO = { x: 2925, z: 3143 };
const LUTHAS = { x: 2939, z: 3154 };
const CRATE = { id: 2072, x: 2943, z: 3151 };              // bananacrate (maps/m45_49.jm2)
const CUSTOMS = { x: 2954, z: 3147 };
const INN_STAIRS = { x: 3227, z: 3393 };                   // woodenstairs 1725 (maps/m50_53.jm2)
const CHEST_DOOR = { x: 3222, z: 3395 };                   // loc_1533 on level 1, east wall of Hector's room
const CHEST = { id: 2079, x: 3218, z: 3396 };              // piratechest on level 1
const DIG = { x: 2999, z: 3383 };                          // 0_46_52_55_55 (general_use/scripts/spade.rs2:3)
const ITEM = { rum: 431, key: 432, message: 433, banana: 1963, apron: 1005, spade: 952 };

const q = await openQuest({ cap: 2500, lumbridgeOk: false });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const lvl0 = () => q.lvl() === 0;
    const disembark = async (label: string) => {
        for (let i = 0; i < 6 && !lvl0(); i++) {
            await q.guard(label);
            if (q.dialogOpen()) { await q.converse([], () => !q.dialogOpen(), 4); continue; }
            const plank = q.findLoc(l => /^gangplank$/i.test(l.name));
            if (!plank) { await q.waitTicks(2); continue; }
            await q.opLoc(plank, q.opIndex(plank, /cross/i));
            await q.waitUntil(lvl0, 10);
        }
        if (!lvl0()) await q.fail(label);
    };
    const onDeck = (d: { x: number; z: number }) => () => q.lvl() === 1 && q.near(d.x, d.z, 8);

    // 1. Redbeard Frank: "I'm in search of treasure." sets 1 (redbeard_frank.rs2:57-66).
    await q.talk('redbeard 1', /^redbeard frank$/i, [/in search of treasure/i], () => q.sawText(/no rum like karamja rum/i), REDBEARD, 40);
    q.milestone(1);

    // 2. Wydin hires a player with a white apron while %hunt is 1 (wydin.rs2:8-10,40-50).
    await q.talk('wydin job', /^wydin$/i, [/can i get a job here/i], () => q.sawText(/you're hired/i), WYDIN, 40);
    q.milestone('job');

    // 3. A seaman to Musa Point (30 coins, sailors.rs2:10-30), Zambo's rum (shop stock karamja_rum).
    await q.walk('to seamen', [{ x: SEAMEN.x + 1, z: SEAMEN.z + 2, tol: 2 }]);
    await q.talk('seaman', /^(seaman (lorris|thresnor)|captain tobias)$/i, [/^yes please/i], onDeck(MUSA_DECK), SEAMEN, 40, true);
    await q.converse([], () => !q.dialogOpen(), 10);
    await disembark('musa gangplank');
    q.milestone('karamja');
    await q.walk('to zambo', [{ x: ZAMBO.x + 1, z: ZAMBO.z, tol: 2 }]);
    for (let i = 0; i < 3 && !q.has(ITEM.rum); i++) {
        await q.guard('rum');
        const o = await q.s.bot.openShop(/^zambo$/i);
        if (!o.success) { console.log(`WARN openShop ${o.message}`); await q.waitTicks(2); continue; }
        const b = await q.s.bot.buyFromShop(/karamjan rum/i, 1);
        if (!b.success) console.log(`WARN buy rum ${b.message}`);
    }
    await q.s.bot.closeShop();
    if (!q.has(ITEM.rum)) await q.fail('no rum');
    q.milestone('rum');

    // 4. Luthas's job, the rum and 10 bananas in his crate, paid: %crate_rum 1 -> 2 (luthas.rs2:1-27,29-33,
    // banana_crate.rs2:21-68).
    await q.talk('luthas job', /^luthas$/i, [/offer me employment/i], () => q.sawText(/i'll pay you 30 gold/i), LUTHAS, 40);
    // Bananas short of ten come off the plantation's trees (banana_tree.rs2: Search gives one and steps the tree down a
    // stage, five a tree, back to full after 500 ticks). A tree that gives nothing is empty and is left for the next;
    // Wydin's shelf holds three with one back every 100 ticks, so the sweep does not buy them.
    const trees = () => (q.st()?.nearbyLocs ?? []).filter((l: any) => /^banana tree$/i.test(l.name) && !empty.has(`${l.x},${l.z}`)).sort((a: any, b: any) => a.distance - b.distance);
    const empty = new Set<string>();
    for (let i = 0; i < 60 && q.cnt(ITEM.banana) < 10; i++) {
        await q.guard('bananas');
        const t = trees()[0];
        if (!t) { if (empty.size) { empty.clear(); await q.waitTicks(20); } else await q.walk('to trees', [{ x: 2925, z: 3160, tol: 3 }]); continue; }
        const n = q.cnt(ITEM.banana);
        if ((q.st()?.inventory?.length ?? 0) >= 28) await q.fail(`bananas: pack full at ${n} of 10`);
        await q.opLoc(t, 1);
        if (!await q.waitUntil(() => q.cnt(ITEM.banana) > n, 6)) empty.add(`${t.x},${t.z}`);
    }
    if (q.cnt(ITEM.banana) < 10) await q.fail(`bananas: ${q.cnt(ITEM.banana)} of 10 from the plantation`);
    q.milestone('bananas');
    await q.walk('to crate', [{ x: CRATE.x - 1, z: CRATE.z, tol: 1 }]);
    await q.step('rum in crate', () => q.useOnLoc(ITEM.rum, q.locAt(CRATE.x, CRATE.z) ?? CRATE), () => !q.has(ITEM.rum), 8, 4);
    await q.converse([], () => !q.dialogOpen(), 6);
    for (let i = 0; i < 40 && q.has(ITEM.banana); i++) {
        await q.guard('bananas');
        if (q.dialogOpen()) { const d: any = q.s.sdk.getDialog(); if (!d.isWaiting) void q.s.sdk.sendClickDialog(0); await q.waitTicks(1); continue; }
        const n = q.cnt(ITEM.banana);
        await q.useOnLoc(ITEM.banana, q.locAt(CRATE.x, CRATE.z) ?? CRATE);
        await q.waitUntil(() => q.cnt(ITEM.banana) < n, 4);
    }
    await q.converse([], () => !q.dialogOpen(), 6);
    if (q.has(ITEM.banana)) await q.fail('bananas left');
    await q.talk('luthas paid', /^luthas$/i, [/i'll be on my way/i], () => q.sawText(/here's your payment/i), LUTHAS, 40);
    q.milestone('shipped');

    // 5. The customs officer: searched with no rum, 30 coins to Port Sarim (customs_officer.rs2:21-95).
    await q.walk('to customs', [{ x: CUSTOMS.x - 1, z: CUSTOMS.z, tol: 2 }]);
    await q.talk('customs', /^customs officer$/i, [/journey on this ship/i, /search away/i, /^ok\.?$/i], onDeck(SARIM_DECK), CUSTOMS, 60, true);
    await q.converse([], () => !q.dialogOpen(), 10);
    await disembark('sarim gangplank');
    q.milestone('sarim');

    // 6. Wydin's back room: the apron worn (wydin_apron_required, food_store.rs2:1-14), the crate gives the rum
    // (food_store.rs2:20-37); "No" to the banana.
    const e = await q.s.bot.equipItem(/^white apron$/i);
    if (!e.success) console.log(`WARN apron ${e.message}`);
    await q.walk('to back door', [{ x: WYDIN_DOOR.x, z: WYDIN_DOOR.z, tol: 0 }]);
    const inBack = () => (q.pos()?.worldX ?? 9999) < WYDIN_DOOR.x;
    await q.step('back door', () => q.opLoc(q.locAt(WYDIN_DOOR.x, WYDIN_DOOR.z) ?? WYDIN_DOOR, 1), inBack, 8, 4);
    await q.step('grocery crate', () => q.opLoc(q.locAt(GROCERY.x, GROCERY.z) ?? GROCERY, 1), () => q.has(ITEM.rum), 12, 3);
    await q.converse([/^no$/i], () => !q.dialogOpen(), 10);
    q.milestone('rum back');
    await q.step('out door', () => q.opLoc(q.locAt(WYDIN_DOOR.x, WYDIN_DOOR.z) ?? WYDIN_DOOR, 1), () => !inBack(), 8, 4);

    // 7. Redbeard takes the rum and gives the chest key: 2 (redbeard_frank.rs2:32-55).
    await q.talk('redbeard 2', /^redbeard frank$/i, [/ok thanks, i'll go and get it/i], () => q.has(ITEM.key) && q.sawText(/with any luck his treasure/i), REDBEARD, 60);
    q.milestone(2);

    // 8. Varrock teleport, the Blue Moon Inn upstairs, the key on Hector's chest gives the message; read it: 3
    // (pirate_message.rs2:1-24).
    await q.teleport('varrock teleport', 'magic:varrock_teleport', 3212, 3424);
    await q.walk('to inn stairs', [{ x: INN_STAIRS.x, z: INN_STAIRS.z + 2, tol: 1 }]);
    await q.climb('inn stairs', () => q.findLoc(l => l.x === INN_STAIRS.x && l.z === INN_STAIRS.z), /climb-up|climb up/i, () => q.lvl() === 1);
    await q.openDoor('chest door', CHEST_DOOR.x, CHEST_DOOR.z);
    await q.step('key on chest', () => q.useOnLoc(ITEM.key, q.locAt(CHEST.x, CHEST.z) ?? CHEST), () => q.has(ITEM.message), 20, 3);
    await q.step('read message', () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(ITEM.message)!, optionIndex: 1, reason: 'SDK' }), () => q.sawText(/white knights/i) || (q.st()?.interface?.isOpen ?? false), 4, 3);
    await q.waitTicks(1);
    q.milestone(3);

    // 9. Falador teleport, the park; a gardener within 10 tiles stops the dig and attacks (dig.rs2:6-8,26-28), so
    // he is killed first; the spade at the X queues the completion (dig.rs2:10-24).
    await q.teleport('falador teleport', 'magic:falador_teleport', 2965, 3378);
    await q.walk('to park', [{ x: DIG.x, z: DIG.z, tol: 0 }]);
    // A bare-handed account at Attack 6 needs many blows for the gardener (a bow account one or two), and a dig while
    // he fights is stopped: the fight is waited out before the spade, over up to twelve rounds.
    for (let i = 0; i < 12 && !questDone; i++) {
        await q.guard('dig');
        const g = q.npc(/^gardener$/i);
        if (g && q.cheb(g.x, g.z) <= 11) {
            await q.s.bot.attack(g as any);
            await q.waitUntil(() => !q.npc(/^gardener$/i) || q.cheb(q.npc(/^gardener$/i).x, q.npc(/^gardener$/i).z) > 11, 40);
            await q.waitUntil(() => !(q.pos() as any)?.combat?.inCombat, 20);
            if (!q.near(DIG.x, DIG.z, 0)) await q.dash('back to x', DIG.x, DIG.z, 0);
        }
        await q.s.direct({ type: 'useInventoryItem', slot: q.slot(ITEM.spade)!, optionIndex: 1, reason: 'SDK' });
        await q.waitUntil(() => questDone, 10);
    }
    await q.converse([], () => !q.dialogOpen(), 10);
    q.milestone(100);
    off();
    await q.end(questDone, 'qp=2');
} catch (e) { await q.fail(String(e)); }
