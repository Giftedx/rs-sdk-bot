// Family Crest from preset quest_crest (beside Dimintheis in south-east Varrock). Ends with the goldsmith
// gauntlets from Avan, which the superheat route needs (smelting.rs2:216).
// Reward: steel gauntlets, 1 QP (quest_crest.rs2 crest_complete). No XP.
// Varp %crestquest (148): 1 Dimintheis, 2 Caleb, 3 Caleb's piece, 4 Caleb "where", 5 gem trader, 6 Avan, 7 Boot,
// 8 Avan's piece, 9 Johnathon, 10 antipoison, then Chronozon (4 blasts) and Dimintheis complete it.
// Server truth: quests/quest_crest/scripts/*.rs2, areas/area_alkharid/scripts/gem_trader.rs2 and border_gate.rs2,
// skill_crafting/scripts/jewellery/jewellery.rs2 (a perfect gold bar makes the 'perfect' ruby ring and necklace),
// skill_combat/scripts/player/player_magic.rs2:223 (a blast that hits Chronozon sets its bit).
// Helper items (preset): 5 cooked fish (Caleb), 2 perfect gold bars (tradeable; a helper mines them in the Witchaven
// dungeon), 2 rubies, ring and necklace moulds, an antipoison, runes for 4 blasts, spare fire blasts and 6 teleports.
// CREST_FROM=<stage> starts later (debug presets with varp 148 set).
import { openQuest } from './quest-lib';
import { componentId } from '../../packages/core/src/logout';

const DIMINTHEIS = { x: 3279, z: 3404 };
const CALEB = { x: 2819, z: 3451 };
const GEM_TRADER = { x: 3288, z: 3212 };
const AVAN = { x: 3295, z: 3285 };
const BOOT = { x: 2965, z: 9811 };
const BOOT_LADDER = { x: 3019, z: 3450 };                 // ladder down to 3019,9850 (maps/m47_153.jm2:5151)
const JOHNATHON = { x: 3279, z: 3503 };                   // level 1, Jolly Boar Inn
const TRAPDOOR = { x: 3097, z: 3468 };                    // Edgeville dungeon, to 3096,9867
const CHRONOZON = { x: 3087, z: 9937 };
const GATE = { x: 3268, z: 3227 };                        // Al Kharid toll gate (border_gate.rs2, 10 coins)
const ITEM = {
    fish: [373, 365, 361, 329, 315], bar: 2365, ruby: 1603, ringMould: 1592, neckMould: 1597, ring: 773, neck: 774,
    anti: [2446, 175, 177, 179], avanPiece: 779, calebPiece: 780, johnPiece: 781, crest: 782, steel: 778, gold: 776,
};
const COM = { rings: 4233, necklaces: 4239 };            // crafting_jewelry:rings_inv / necklaces_inv, slot 3 = ruby
const BLASTS = ['magic:wind_blast', 'magic:water_blast', 'magic:earth_blast', 'magic:fire_blast'];

const q = await openQuest({ cap: 4000, eatAt: 65, food: [385, 379], lumbridgeOk: true });
try {
    const FROM = Number(process.env.CREST_FROM ?? 0);
    let questDone = false;
    const offDone = q.s.onTick(() => { if (q.msgCount(/quest complete|completed the\s+family crest/i) > 0) questDone = true; });
    const tele = (label: string, comp: string, x: number, z: number) => q.teleport(label, comp, x, z);
    const named = (re: RegExp, near?: { x: number; z: number }, r = 6) => q.findLoc(l => re.test(l.name) && (!near || Math.max(Math.abs(l.x - near.x), Math.abs(l.z - near.z)) <= r));

    // Al Kharid toll gate from the Lumbridge side: the guard's dialog, "Yes, ok." pays 10 coins (border_gate.rs2).
    const tollGate = async (): Promise<void> => {
        if ((q.pos()?.worldX ?? 0) >= GATE.x + 1) return;
        await q.walk('to toll gate', [{ x: GATE.x - 1, z: GATE.z, tol: 1 }]);
        for (let i = 0; i < 4 && (q.pos()?.worldX ?? 0) < GATE.x; i++) {
            await q.guard('toll gate');
            const g = q.findLoc(l => /gate/i.test(l.name) && l.x === GATE.x && Math.abs(l.z - GATE.z) <= 1);
            if (!g) { console.log('WARN no toll gate loc'); await q.waitTicks(1); continue; }
            await q.opLoc(g, q.opIndex(g, /open|pay/i));
            await q.converse([/^yes, ok/i], () => (q.pos()?.worldX ?? 0) >= GATE.x, 30);
        }
        if ((q.pos()?.worldX ?? 0) < GATE.x) await q.fail('toll gate');
    };

    // 1. Dimintheis: "dump", "So where is this crest?", "Ok, I will help you." sets 1.
    if (FROM < 1) {
        await q.talk('dimintheis 1', /^dimintheis$/i, [/dump like this/i, /so where is this crest/i, /ok, i will help you/i], () => q.sawText(/i thank you greatly|still loves him/i), DIMINTHEIS);
        q.milestone(1);
    }

    // 2-4. Caleb in Catherby: the bit (2), the fish for his piece (3), "what happened to the rest" (4).
    if (FROM < 4) {
        await tele('camelot teleport', 'magic:camelot_teleport', 2757, 3478);
        await q.walk('to caleb', [{ x: CALEB.x, z: CALEB.z, tol: 3 }]);
        if (FROM < 2) {
            await q.talk('caleb 1', /^caleb$/i, [/are you caleb/i, /so can i have your bit/i, /ok, i will get those/i], () => q.sawText(/it would help me a lot/i), CALEB);
            q.milestone(2);
        }
        await q.talk('caleb 2', /^caleb$/i, [/what happened to the rest/i], () => q.has(ITEM.avanPiece) && q.sawText(/ask around there for him|not prepared to hand over/i), CALEB, 60);
        q.milestone(4);
    }

    // 5. The gem trader in Al Kharid, then the two 'perfect' pieces at the Al Kharid furnace.
    if (FROM < 5) {
        await tele('lumbridge teleport', 'magic:lumbridge_teleport', 3221, 3218);
        await tollGate();
        await q.walk('to gem trader', [{ x: GEM_TRADER.x - 1, z: GEM_TRADER.z, tol: 2 }]);
        await q.talk('gem trader', /^gem trader$/i, [/search of a man named avan/i], () => q.sawText(/scorpions will deal with him/i), GEM_TRADER);
        q.milestone(5);
    }
    if (FROM < 8 && (!q.has(ITEM.ring) || !q.has(ITEM.neck))) {
        await q.walk('to furnace', [{ x: 3275, z: 3186, tol: 3 }]);
        const furnace = () => named(/^furnace$/i);
        if (!furnace()) console.log(`WARN no furnace: ${q.locs().slice(0, 12).map((l: any) => `${l.name}@${l.x},${l.z}`).join(' ')}`);
        const craftOne = async (label: string, com: number, product: number): Promise<void> => {
            await q.step(label, async () => {
                const f = furnace();
                if (!f) return q.waitTicks(1);
                await q.useOnLoc(ITEM.bar, f);
                await q.waitUntil(() => q.cheb(f.x, f.z) <= 3, 15);
                await q.waitTicks(2);
                return q.s.direct({ type: 'clickComponentWithOption', componentId: com, optionIndex: 1, slot: 3, reason: 'SDK' });
            }, () => q.has(product), 12, 4);
        };
        await craftOne('ruby ring', COM.rings, ITEM.ring);
        await craftOne('ruby necklace', COM.necklaces, ITEM.neck);
        await q.s.direct({ type: 'closeModal', reason: 'SDK' });
        q.milestone('jewellery');
    }

    // 6. Avan in the scorpion pit north of Al Kharid (npc name "Man", debugname avan).
    const avan = /^man$/i;
    if (FROM < 6) {
        await q.walk('to avan', [{ x: AVAN.x, z: AVAN.z - 2, tol: 2 }]);
        await q.talk('avan 1', avan, [/looking for a man named avan/i], () => q.sawText(/must first do something for me|perfect gold/i), AVAN, 60);
        q.milestone(6);
    }

    // 7. Boot under the mountains: Falador teleport, the ladder north of Falador, the tunnel west.
    if (FROM < 7) {
        await tele('falador teleport', 'magic:falador_teleport', 2965, 3378);
        await q.walk('to boot ladder', [{ x: BOOT_LADDER.x, z: BOOT_LADDER.z + 1, tol: 1 }]);
        await q.climb('boot ladder down', () => named(/ladder|trapdoor/i, BOOT_LADDER, 2), /climb-down/i, () => (q.pos()?.worldZ ?? 0) > 9000);
        await q.walk('to boot', [{ x: BOOT.x + 1, z: BOOT.z, tol: 2 }]);
        await q.talk('boot', /^boot$/i, [/very high quality gold/i], () => q.sawText(/east of the large city ardougne|exactly easy to get to/i), BOOT);
        q.milestone(7);
    }

    // 8. Avan takes the ring and necklace and gives his piece.
    if (FROM < 8) {
        await tele('lumbridge teleport 2', 'magic:lumbridge_teleport', 3221, 3218);
        await tollGate();
        await q.walk('to avan 2', [{ x: AVAN.x, z: AVAN.z - 2, tol: 2 }]);
        await q.talk('avan 2', avan, [], () => q.has(ITEM.calebPiece), AVAN, 60);
        q.milestone(8);
    }

    // 9-10. Johnathon upstairs in the Jolly Boar Inn: talk (9), an antipoison on him (10).
    if (FROM < 10) {
        await tele('varrock teleport', 'magic:varrock_teleport', 3213, 3424);
        await q.walk('to jolly boar', [{ x: JOHNATHON.x, z: JOHNATHON.z - 6, tol: 4 }]);
        const up = () => q.findLoc(l => /stair/i.test(l.name) && (l.optionsWithIndex ?? []).some((o: any) => /climb-up/i.test(o.text)));
        if (!up()) console.log(`WARN no inn stairs: ${q.locs().slice(0, 15).map((l: any) => `${l.name}@${l.x},${l.z}`).join(' ')}`);
        await q.climb('inn stairs up', up, /climb-up/i, () => q.lvl() === 1);
        if (FROM < 9) {
            await q.talk('johnathon 1', /^johnathon$/i, [], () => q.sawText(/sweat is pouring/i), JOHNATHON);
            q.milestone(9);
        }
        const anti = () => ITEM.anti.find(id => q.has(id));
        await q.step('antipoison', async () => { const n = q.npc(/^johnathon$/i); const a = anti(); if (n && a) await q.useOnNpc(a, n); }, () => q.sawText(/chronozon/i) || q.dialogOpen(), 15, 4);
        await q.converse([/i will be on my way now/i, /wish me luck/i, /where can i find chronozon/i], () => !q.dialogOpen() && q.sawText(/chronozon/i), 60);
        q.milestone(10);
        const down = () => q.findLoc(l => /stair/i.test(l.name) && (l.optionsWithIndex ?? []).some((o: any) => /climb-down/i.test(o.text)));
        await q.climb('inn stairs down', down, /climb-down/i, () => q.lvl() === 0);
    }

    // 11. Chronozon in the Edgeville dungeon: one hit of each blast sets its 4 bits; then any kill drops Johnathon's
    // piece. The trapdoor route comes from the south and stays clear of the 3 black demons north of him.
    if (!q.has(ITEM.johnPiece)) {
        await q.walk('to trapdoor', [{ x: TRAPDOOR.x, z: TRAPDOOR.z + 1, tol: 1 }]);
        const trap = () => named(/trapdoor/i, TRAPDOOR, 2);
        for (let i = 0; i < 4 && (q.pos()?.worldZ ?? 0) < 9000; i++) {
            await q.guard('trapdoor');
            const t = trap();
            if (!t) { console.log('WARN no trapdoor'); await q.waitTicks(1); continue; }
            const op = (t.optionsWithIndex ?? []).find((o: any) => /climb-down|open/i.test(o.text));
            await q.opLoc(t, op?.opIndex ?? 1);
            await q.waitUntil(() => (q.pos()?.worldZ ?? 0) > 9000, 8);
        }
        if ((q.pos()?.worldZ ?? 0) < 9000) await q.fail('trapdoor');
        q.milestone('dungeon');
        // His lair gate (chronodoorl 2432 at 3089,9945): the planner treats it as open, and one op from the north tile
        // lands on the gate tile, inside (rs-stun-toolkit `q-family-crest.ts`, MIT, research/stun-toolkit-LICENSE.txt).
        // A double gate (1557 at 3105,9944) on the way is also planned as open.
        await q.walk('to wild gate', [{ x: 3105, z: 9943, tol: 0 }]);
        await q.step('wild gate', () => { const g = q.findLoc((l: any) => l.x === 3105 && l.z === 9944) ?? { id: 1557, x: 3105, z: 9944 }; return q.opLoc(g, q.opIndex(g, /open/i)); },
            () => (q.pos()?.worldZ ?? 0) >= 9944 || !q.shutAt(3105, 9944), 6, 5);
        await q.dash('past wild gate', 3105, 9946, 1, 8);
        // Short client-routed legs north and west round the rock: the long walk paced at z 9946-9950 under attack.
        await q.dash('north of gate', 3104, 9952, 2, 12);
        await q.dash('west passage', 3092, 9950, 2, 20);
        await q.dash('to chronozon gate', 3089, 9946, 0, 12);
        await q.step('chronozon gate', () => { const g = q.findLoc((l: any) => l.x === 3089 && l.z === 9945) ?? { id: 2432, x: 3089, z: 9945 }; return q.opLoc(g, q.opIndex(g, /open/i)); },
            () => (q.pos()?.worldZ ?? 0) <= 9945, 6, 5);
        await q.walk('to chronozon', [{ x: CHRONOZON.x, z: CHRONOZON.z - 4, tol: 3 }]);
        const chz = () => q.npc(/^chronozon$/i);
        if (!chz()) await q.waitUntil(() => !!chz(), 30);
        // Game messages are a capped list, so a message counts as new by its observation id, not by a count.
        const lastMsg = (re: RegExp): number => Math.max(-1, ...(q.st()?.gameMessages ?? []).filter((m: any) => m.type === 0 && re.test(m.text)).map((m: any) => m.observationId ?? m.tick));
        const attack = (n: any) => q.s.direct({ type: 'interactNpc', npcIndex: n.index, optionIndex: n.optionsWithIndex?.find((o: any) => /attack/i.test(o.text))?.opIndex ?? 2, reason: 'SDK' });
        // Single-way combat: a poison spider (3088-3090,9943-9945) that attacks first blocks every cast on Chronozon
        // ("I'm already under attack!"). Kill the attacker with the scimitar, then go on.
        let blocked = lastMsg(/already under attack/i);
        const clearAttackers = async (): Promise<void> => {
            const b = lastMsg(/already under attack/i);
            if (b <= blocked) return;
            blocked = b;
            const npcs: any[] = (q.st()?.nearbyNpcs ?? []).filter((n: any) => !/chronozon/i.test(n.name));
            const foe = npcs.filter(n => n.distance <= 6 && n.targetIndex >= 32768).sort((x, y) => x.distance - y.distance)[0]
                ?? npcs.filter(n => n.distance <= 1 && /poison spider/i.test(n.name)).sort((x, y) => x.distance - y.distance)[0];
            if (!foe) { console.log(`WARN under attack, no attacker found: ${npcs.slice(0, 4).map(n => `${n.name} d=${n.distance} c=${n.inCombat} t=${n.targetIndex}`).join('; ')}`); return; }
            console.log(`NOTE attacker ${foe.name} (${foe.combatLevel}) d=${foe.distance} t=${foe.targetIndex} at ${q.T()}`);
            for (let t = 0; t < 120; t++) {
                await q.guard(`fight ${foe.name}`);
                const n = (q.st()?.nearbyNpcs ?? []).find((x: any) => x.index === foe.index);
                if (!n || n.hp === 0) break;
                if (t % 4 === 0) await attack(n);
                await q.waitTicks(1);
            }
            await q.waitTicks(2);
        };
        // A blast that splashes sets no bit (pvm_spell_success only). In the rune set (magic bonus about -50) 3 of 6
        // proof runs splashed until the runes ran out; Chronozon has no magic level, so with the helm, body, shield and
        // legs off the hit chance is about 90%. Each blast is cast until "Chronozon weakens".
        // The second antipoison first: the poison spiders poison, and in one run (p7) the poison killed the bot after
        // the teleport out.
        const anti2 = ITEM.anti.find(id => q.has(id));
        if (anti2) await q.step('drink antipoison', () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(anti2)!, optionIndex: 1, reason: 'SDK' }), () => !q.has(anti2), 3, 2);
        const ARMOUR = [0, 4, 5, 7];                     // helm, body, shield, legs (equipment slots)
        for (const slot of ARMOUR) {
            await q.step(`remove ${slot}`, () => q.s.direct({ type: 'useEquipmentItem', slot, optionIndex: 1, reason: 'SDK' }), () => !(q.st()?.equipment ?? []).some((e: any) => e.slot === slot && e.id > 0), 3, 3);
        }
        for (let b = 0; b < BLASTS.length; b++) {
            let ok = false;
            for (let t = 0; t < 12 && !ok; t++) {
                await q.guard(`blast ${b}`);
                const n = chz();
                if (!n) { await q.waitTicks(1); continue; }
                const w0 = lastMsg(/chronozon weakens/i);
                await q.s.direct({ type: 'spellOnNpc', npcIndex: n.index, spellComponent: componentId(BLASTS[b]!), reason: 'SDK' });
                await q.waitUntil(() => lastMsg(/chronozon weakens/i) > w0 || lastMsg(/already under attack|do not have enough/i) > blocked, 8);
                if (lastMsg(/do not have enough/i) > blocked) await q.fail(`blast ${b}: out of runes`);
                ok = lastMsg(/chronozon weakens/i) > w0;
                if (!ok) { console.log(`WARN blast ${b} no weaken at ${q.T()}`); await clearAttackers(); }
            }
            if (!ok) await q.fail(`blast ${b}`);
        }
        q.milestone('blasts');
        // Kill: fire blasts while the runes last (Fire Blast is the strongest hit here), then the scimitar.
        // "Chronozon regenerates" means a bit is missing.
        const regen0 = lastMsg(/chronozon regenerates/i);
        const pieceOnGround = () => (q.st()?.groundItems ?? []).find((g: any) => g.id === ITEM.johnPiece);
        for (let t = 0; t < 300 && !pieceOnGround() && !q.has(ITEM.johnPiece); t++) {
            await q.guard('kill chronozon');
            const n = chz();
            const fireLeft = q.cnt(554) >= 5 && q.cnt(556) >= 4 && q.cnt(560) >= 1;
            if (n && t % 5 === 0) await (fireLeft ? q.s.direct({ type: 'spellOnNpc', npcIndex: n.index, spellComponent: componentId('magic:fire_blast'), reason: 'SDK' }) : attack(n));
            await q.waitTicks(1);
            await clearAttackers();
            if (lastMsg(/chronozon regenerates/i) > regen0) await q.fail('chronozon regenerates');
        }
        await q.step('take piece', () => { const g = pieceOnGround(); return g ? q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' }) : q.waitTicks(1); }, () => q.has(ITEM.johnPiece), 12, 5);
        q.milestone('piece');
    }

    // 12. Join the three pieces; Dimintheis takes the crest (queued completion, steel gauntlets).
    await q.step('join crest', () => q.useOnItem(ITEM.avanPiece, ITEM.calebPiece), () => q.has(ITEM.crest), 4, 4);
    await tele('varrock teleport 2', 'magic:varrock_teleport', 3213, 3424);
    // His house is reached only through Varrock's east gate (guidorgatelclosed 2050 at 3264,3405, a teleport gate the walker
    // does not open; area_varrock/scripts/east_gate.rs2). One op from the west tile lands at x 3264 (rs-stun-toolkit
    // `q-family-crest.ts`, MIT, research/stun-toolkit-LICENSE.txt).
    const VGATE = { id: 2050, x: 3264, z: 3405 };
    const gx = () => q.pos()?.worldX ?? 0;
    const crossGate = async (label: string, through: () => boolean) => {
        for (let i = 0; i < 5 && !through(); i++) {
            await q.guard(label);
            if (q.dialogOpen()) { await q.converse([/.*/], () => !q.dialogOpen(), 10); continue; }
            await q.opLoc(q.locAt(VGATE.x, VGATE.z) ?? VGATE, 1);
            await q.waitUntil(() => through() || q.dialogOpen(), 8);
        }
        await q.converse([/.*/], () => !q.dialogOpen(), 10);
        if (!through()) await q.fail(label);
    };
    await q.walk('to varrock gate', [{ x: VGATE.x - 1, z: VGATE.z, tol: 0 }]);
    await crossGate('varrock gate in', () => gx() >= VGATE.x);
    await q.walk('back to dimintheis', [{ x: 3279, z: 3403, tol: 2 }]);
    await q.talk('dimintheis 2', /^dimintheis$/i, [], () => !q.has(ITEM.crest), DIMINTHEIS, 60);
    await q.waitUntil(() => q.has(ITEM.steel), 5);
    q.milestone('complete');

    // 13. Avan pounds the steel gauntlets into goldsmith gauntlets.
    await q.walk('to gate inside', [{ x: VGATE.x, z: VGATE.z, tol: 0 }]);
    await crossGate('varrock gate out', () => gx() < VGATE.x);
    await q.walk('to avan 3', [{ x: AVAN.x, z: AVAN.z - 2, tol: 2 }]);
    await q.talk('avan 3', avan, [/improve them for me/i], () => q.has(ITEM.gold), AVAN, 60);
    q.milestone('gauntlets');
    offDone();
    await q.end(q.has(ITEM.gold) && questDone, `qp=1 gauntlets=${q.has(ITEM.gold)} questMsg=${questDone}`);

} catch (e) { await q.fail(String(e)); }
