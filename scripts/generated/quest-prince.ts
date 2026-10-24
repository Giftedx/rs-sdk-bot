// Prince Ali Rescue from preset quest_prince (in the Al Kharid palace beside Hassan; Haggis at the qp-filler row: every
// skill 99, the combat rune set; wool, dye, skirt, rope, clay, bronze bar, beers, the paste set and 4 Lumbridge
// teleports' runes from a helper). Reward: 3 QP, 700 coins, free passage through the toll gate (quest_prince.rs2:54-58).
// Varp %princequest (273): 0 -> 10 Hassan, 20 Osman, 30 Leela (key and disguise), 40 Joe drunk, 50 Keli tied,
// 100 the prince out, 110 Hassan (queued completion). Varp %prince_keystatus: 1 key made (Osman), 2 claimed (Leela).
// Server truth: areas/area_alkharid/scripts/hassan.rs2, osman.rs2, border_gate.rs2; areas/area_draynor/scripts/
// ned.rs2, aggie.rs2, lady_keli.rs2, leela.rs2, joe_guard.rs2, prince_ali.rs2; quests/quest_prince/scripts/quest_prince.rs2.
import { openQuest } from './quest-lib';

const HASSAN = { x: 3302, z: 3163 };
const OSMAN = { x: 3286, z: 3180 };
const KELI = { x: 3128, z: 3244 };
const JOE = { x: 3123, z: 3245 };
const NED = { x: 3100, z: 3258 };
const AGGIE = { x: 3086, z: 3259 };
const LEELA = { x: 3113, z: 3263 };
const GATE = { x: 3268, z: 3227 };                          // Al Kharid toll gate (border_gate.rs2, 10 coins)
const ALIDOOR = { id: 2881, x: 3123, z: 3243 };            // the cell door, north wall of 3123,3243 (maps/m48_50.jm2)
const ITEM = { wool: 1759, dye: 1765, skirt: 1013, rope: 954, clay: 1761, bar: 2349, beer: 1917, wig: 2421, blond: 2419, paste: 2424, print: 2423, key: 2418 };

const q = await openQuest({ cap: 2000, lumbridgeOk: true });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const x = (): number => q.pos()?.worldX ?? 0;
    const z = (): number => q.pos()?.worldZ ?? 0;
    const lumbridge = (label: string) => q.teleport(label, 'magic:lumbridge_teleport', 3221, 3218);
    // The toll gate from the Lumbridge side: the guard's talk; "Yes, ok." pays 10 coins, free once the prince is out.
    const tollGate = async (): Promise<void> => {
        if (x() >= GATE.x) return;
        await q.walk('to toll gate', [{ x: GATE.x - 1, z: GATE.z, tol: 1 }]);
        for (let i = 0; i < 4 && x() < GATE.x; i++) {
            await q.guard('toll gate');
            const g = q.findLoc(l => /gate/i.test(l.name) && l.x === GATE.x && Math.abs(l.z - GATE.z) <= 1);
            if (!g) { console.log('WARN no toll gate loc'); await q.waitTicks(1); continue; }
            await q.opLoc(g, q.opIndex(g, /open|pay/i));
            await q.converse([/^yes, ok/i], () => x() >= GATE.x && !q.dialogOpen(), 30);
        }
        if (x() < GATE.x) await q.fail('toll gate');
    };
    // Jail guards (vislevel 26) are huntmode=aggressive_melee (area_draynor configs); a guard's hit closes the talk.
    // One trial lost 4 Keli talks so (hpMin 94). The bot kills a guard that is in combat within 3 tiles first.
    const clearGuards = async (): Promise<void> => {
        for (let t = 0; t < 40; t++) {
            const g: any = (q.st()?.nearbyNpcs ?? []).find((n: any) => /^jail guard$/i.test(n.name) && n.inCombat && n.distance <= 3);
            if (!g) return;
            if (t % 3 === 0) await q.s.direct({ type: 'interactNpc', npcIndex: g.index, optionIndex: g.optionsWithIndex?.find((o: any) => /attack/i.test(o.text))?.opIndex ?? 2, reason: 'SDK' });
            await q.waitTicks(1);
        }
    };
    // A talk that waits for the dialog to open (up to 12 ticks) before it counts shut ticks. quest-lib's talk() gives
    // up on a stationary bot after 3 ticks and clicks again; with Keli walking in the jail one trial lost 3 talks so.
    const talkWait = async (label: string, re: RegExp, pats: RegExp[], ok: () => boolean, home: { x: number; z: number }, maxTicks = 80): Promise<void> => {
        for (let i = 0; i < 4 && !ok(); i++) {
            await q.guard(label);
            if (i > 0) q.stats.retries++;
            await clearGuards();
            let n = q.npc(re);
            if (!n) { await q.walk(`${label} approach`, [{ x: home.x, z: home.z, tol: 4 }]); n = q.npc(re); }
            if (!n) continue;
            const tr: any = await q.talkTo(n);
            if (tr && tr.success === false) console.log(`WARN talk ${label}: ${tr.reason ?? ''} ${tr.message ?? ''}`);
            // Wait for the NPC's own dialog: open, and the bot beside the NPC. A dialog seen open while the bot was
            // still 2+ tiles away was clicked through and the approach never ended (3 of 3 untraced trials).
            const close = () => { const m: any = q.npc(re); return !!m && q.cheb(m.x, m.z) <= 1; };
            await q.waitUntil(() => q.dialogOpen() && close(), 15);
            if (q.dialogOpen() && !close()) { const d: any = q.s.sdk.getDialog(); console.log(`WARN ${label} far dialog: ${(d?.text ?? '').slice(0, 60)} opts=${(d?.options ?? []).map((o: any) => o.text).join('|').slice(0, 80)}`); }
            if (!q.dialogOpen()) { const m: any = q.npc(re); console.log(`WARN ${label} no dialog: npc ${m?.x},${m?.z} me ${x()},${z()} t=${q.T()} op=${JSON.stringify(q.st()?.opFeedback ?? {})}`); continue; }
            let shut = 0;
            await q.converse(pats, () => { shut = q.dialogOpen() ? 0 : shut + 1; return ok() || shut >= 3; }, maxTicks);
            if (!ok()) console.log(`WARN ${label} talk ended t=${q.T()} last pages: ${q.st()?.recentDialogs?.slice(-2).map((d: any) => (d.text ?? []).join(' ').slice(0, 60)).join(' | ')}`);
        }
        if (!ok()) await q.fail(`talk ${label}`);
    };
    // The jail's front door (loc_1536 at 3128,3246, north wall): opened by tile before a talk inside.
    const jailDoor = () => q.openDoor('jail door', 3128, 3246);

    // 1. Hassan: "Can I help you? You must need some help here in the desert." sets 10 (hassan.rs2:1-10).
    await q.talk('hassan 1', /^hassan$/i, [/can i help you/i], () => q.sawText(/see the spymaster, osman/i), HASSAN);
    q.milestone(10);

    // 2. Osman: the first thing, then "Okay, I better go find some things." sets 20 (osman.rs2:56-105).
    await q.walk('to osman', [{ x: OSMAN.x + 1, z: OSMAN.z - 1, tol: 2 }]);
    await q.talk('osman 1', /^osman$/i, [/first thing i must do/i, /better go find some things/i], () => q.sawText(/don't forget to find leela/i), OSMAN, 80);
    q.milestone(20);

    // 3. Draynor: Keli shows the key and the soft clay takes its print (lady_keli.rs2:209-311).
    await lumbridge('lumbridge teleport 1');
    await q.walk('to jail', [{ x: 3128, z: 3247, tol: 1 }]);
    await jailDoor();
    await talkWait('keli', /^lady keli$/i, [/you are famous in runescape/i, /latest plan/i, /will not try to get him out/i, /could i see the key/i, /touch the key/i], () => q.has(ITEM.print), KELI, 80);
    q.milestone('print');
    // 4. Ned makes the wig from 3 balls of wool (ned.rs2:104-121); the yellow dye on it (quest_prince.rs2:1-12).
    await q.walk('to ned', [{ x: NED.x + 1, z: NED.z - 1, tol: 1 }]);
    await q.openDoor('ned door', 3101, 3258);
    await q.talk('ned', /^ned$/i, [/other things from wool/i, /some sort of wig/i, /please, make me a wig/i], () => q.has(ITEM.wig), NED, 60);
    await q.step('dye wig', () => q.useOnItem(ITEM.dye, ITEM.wig), () => q.has(ITEM.blond), 3, 4);
    q.milestone('wig');
    // 5. Aggie mixes the skin paste (aggie.rs2:25-33, 140-154).
    await q.walk('to aggie', [{ x: AGGIE.x + 1, z: AGGIE.z - 1, tol: 1 }]);
    await q.openDoor('aggie door', 3088, 3258);
    await q.talk('aggie', /^aggie$/i, [/make skin paste/i, /mix me some skin paste/i], () => q.has(ITEM.paste), AGGIE, 60);
    q.milestone('paste');

    // 6. Al Kharid: Osman takes the print and the bar; the key is made (osman.rs2:107-126).
    await lumbridge('lumbridge teleport 2');
    await tollGate();
    await q.walk('to osman 2', [{ x: OSMAN.x + 1, z: OSMAN.z - 1, tol: 2 }]);
    await q.talk('osman 2', /^osman$/i, [/try to find the other items/i], () => !q.has(ITEM.print), OSMAN, 60);
    q.milestone('keymade');

    // 7. Draynor: Leela gives the key and, with the disguise in the pack, sets 30 (leela.rs2:10-37).
    await lumbridge('lumbridge teleport 3');
    await q.walk('to leela', [{ x: LEELA.x + 1, z: LEELA.z - 1, tol: 2 }]);
    await talkWait('leela', /^leela$/i, [], () => q.has(ITEM.key) && q.sawText(/deal with the guard on the door/i) && !q.dialogOpen(), LEELA, 40);
    q.milestone(30);
    // 8. Joe takes the 3 beers (40, joe_guard.rs2:128-155); the rope on Keli (50, quest_prince.rs2:14-32); the key on
    // the cell door from the north (:34-44); the prince takes the disguise and the key (100, prince_ali.rs2:312-335).
    await q.walk('to jail 2', [{ x: 3128, z: 3247, tol: 1 }]);
    await jailDoor();
    await talkWait('joe', /^joe$/i, [/i have some beer here/i], () => q.cnt(ITEM.beer) === 0 && q.sawText(/no longer a problem/i), JOE, 60);
    q.milestone(40);
    for (let i = 0; i < 6 && q.has(ITEM.rope); i++) {
        await clearGuards();
        const k = q.npc(/^lady keli$/i);
        if (!k) { console.log('WARN no keli in view'); await q.walk('keli approach', [{ x: KELI.x, z: KELI.z, tol: 2 }]); continue; }
        if (i > 0) q.stats.retries++;
        const r0 = q.st()?.opFeedback?.opRejectedCount ?? 0;
        await q.useOnNpc(ITEM.rope, k);
        // The mesbox comes before the rope leaves the pack (quest_prince.rs2:27-32), so its page is clicked.
        await q.waitUntil(() => q.dialogOpen() || !q.has(ITEM.rope), 12);
        await q.converse([], () => !q.has(ITEM.rope), 6);
        if (q.has(ITEM.rope)) console.log(`WARN rope ${i}: keli ${k.x},${k.z} d=${k.distance} me ${x()},${z()} rejected+${(q.st()?.opFeedback?.opRejectedCount ?? 0) - r0} msgs=${(q.st()?.gameMessages ?? []).slice(-2).map((m: any) => m.text).join(' / ')}`);
    }
    if (q.has(ITEM.rope)) await q.fail('rope keli');
    await q.converse([], () => !q.dialogOpen(), 10);
    q.milestone(50);
    // The cell is x <= 3125, z <= 3243; the bot ends on 3123,3243 (3126,3243 is the corridor east of it).
    await q.step('cell door', () => q.useOnLoc(ITEM.key, ALIDOOR), () => x() <= 3125 && z() <= 3243, 12, 4);
    await q.talk('prince', /^prince ali$/i, [], () => !q.has(ITEM.skirt) && !q.dialogOpen(), { x: 3123, z: 3242 }, 60);
    q.milestone(100);

    // 9. Al Kharid: Hassan queues the completion (hassan.rs2:24-26). The toll gate is free now.
    await lumbridge('lumbridge teleport 4');
    await tollGate();
    await q.walk('to hassan', [{ x: HASSAN.x - 1, z: HASSAN.z, tol: 1 }]);
    await q.talk('hassan 2', /^hassan$/i, [], () => questDone, HASSAN, 40, true);
    await q.converse([], () => !q.dialogOpen(), 10);
    q.milestone(110);
    off();
    await q.end(questDone, 'qp=3');
} catch (e) { await q.fail(String(e)); }
