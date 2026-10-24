// Alfred Grimhand's Barcrawl (miniquest, no QP: not in general/configs/quest.constant) from preset barcrawl (beside the
// Barbarian Outpost gate guards). It opens the outpost gate for Scorpion Catcher's scorpion B
// (areas/area_barbarian_outpost/scripts/outpost_gate.rs2:1-5) and the Barbarian course. Paths below are under
// vendor/rs-sdk/server/content/scripts/. Varp %barcrawl (77): 1 from the guard ("Looks can be deceiving...", the card
// 455, barbarian_outpost_guard.rs2:11-31); bits 3-12 one per bar (quest_barcrawl.constant); the guard with all ten
// bits sets 2 (barbarian_outpost_guard.rs2:48-60). Each bartender has the "Alfred Grimhand's Barcrawl" option while its
// bit is clear and the card is in the pack. Prices: Rising Sun 70, Rusty Anchor 8, Zambo 7, Dead Man's Chest 15,
// Flying Horse 8, Dragon Inn 12, Blue Moon 50, Jolly Boar 10, Foresters Arms 18, Blurberry 10 = 208 coins; two ships
// at 30 (sailors.rs2:14-31, customs_officer.rs2:72-84). Order: the Gnome Stronghold (Blurberry), Falador Teleport,
// Port Sarim, the ship to Musa Point, Brimhaven, the ship to Ardougne, Yanille, Varrock Teleport, Camelot Teleport
// (Foresters Arms), the walk back to the outpost.
import { openQuest } from './quest-lib';

const CARD = 455;
const GUARD = { x: 2544, z: 3569 };
const SIGN = /sign(s|ing)? (your|2) (barcrawl )?cards?|scrawls his signature/i;
const BUY = /^(you buy|the bartender (hands|serves|gives) you)/i;
// Bars: NPC name, a tile near its spawn (knowledge/npcs.json).
const BAR = {
    risingsun: { re: /^barmaid$/i, at: { x: 2957, z: 3370 } },
    rustyanchor: { re: /^bartender$/i, at: { x: 3045, z: 3257 } },
    zambo: { re: /^zambo$/i, at: { x: 2925, z: 3143 } },
    deadman: { re: /^bartender$/i, at: { x: 2797, z: 3155 } },
    // The bar room's east door (loc_1533, west wall of 2576,3320); the SDK route ends outside it (test run t2).
    flyinghorse: { re: /^bartender$/i, at: { x: 2575, z: 3320 }, door: { x: 2576, z: 3320 } },
    dragoninn: { re: /^bartender$/i, at: { x: 2556, z: 3078 } },
    bluemoon: { re: /^bartender$/i, at: { x: 3226, z: 3399 } },
    jollyboar: { re: /^bartender$/i, at: { x: 3277, z: 3488 } },
    foresters: { re: /^bartender$/i, at: { x: 2690, z: 3493 } },
    blurberry: { re: /^blurberry$/i, at: { x: 2480, z: 3490 } },
};
const SARIM_SAILOR = { x: 3028, z: 3221 };    // Seaman Lorris (and the other sailors), sailors.rs2
const MUSA_DECK = { x: 2956, z: 3143 };        // 1_46_49_12_7
const BRIM_CUSTOMS = { x: 2772, z: 3229 };     // customs officers 2772,3225 / 2772,3231 / 2773,3229
const ARDY_DECK = { x: 2683, z: 3268 };        // 1_41_51_59_4
const BLUR_LADDER = { x: 2466, z: 3495 };      // ladder (1747) in the Grand Tree, maps/m38_54.jm2; level 1 reaches Blurberry
const GNOME_GATE = { id: 190, x: 2459, z: 3383 }; // gnome_areagate (areas/area_gnome/scripts/gnome_gate.rs2), entrances z 3382 / 3385

const q = await openQuest({ cap: 4000, eatAt: 50, food: [379], lumbridgeOk: false });
try {
    let signed = 0;
    const levelIs = (l: number) => () => q.lvl() === l;
    const gangplank = () => q.findLoc(l => /gangplank/i.test(l.name) && (l.optionsWithIndex ?? []).length > 0 && l.distance <= 8);
    const sail = async (label: string, re: RegExp, pats: RegExp[], at: { x: number; z: number }, deck: { x: number; z: number }): Promise<void> => {
        await q.talk(label, re, pats, () => q.near(deck.x, deck.z, 6), at, 60);
        await q.converse([], () => !q.dialogOpen(), 6);
        if (q.lvl() === 1) await q.climb(`${label} disembark`, gangplank, /cross|walk|disembark/i, levelIs(0), 4);
    };
    const bar = async (name: keyof typeof BAR): Promise<void> => {
        const b = BAR[name];
        const before = q.msgCount(SIGN);
        const door = (b as any).door as { x: number; z: number } | undefined;
        if (door) {
            await q.walk(`to ${name} door`, [{ x: door.x + 1, z: door.z, tol: 0 }]);
            await q.openDoor(`${name} door`, door.x, door.z);
        } else if (!q.near(b.at.x, b.at.z, 6)) await q.walk(`to ${name}`, [{ x: b.at.x, z: b.at.z, tol: 4 }]);
        // The drink is paid before the p_delays and the signature (e.g. bartender.rs2 deadman_barcrawl): a talk that
        // waits for the signature alone re-opens the bartender's menu, now without the Barcrawl option (test run t2).
        const buys = q.msgCount(BUY);
        await q.talk(name, b.re, [/alfred grimhand/i], () => q.msgCount(SIGN) > before || q.msgCount(BUY) > buys, b.at, 40);
        await q.waitUntil(() => q.msgCount(SIGN) > before, 15);
        if (q.msgCount(SIGN) <= before) await q.fail(`${name}: no signature`);
        await q.waitUntil(() => !q.dialogOpen(), 6);
        signed++;
        q.milestone(`${signed} ${name}`);
    };
    // The Stronghold gate. Femi (2459,3382) asks for help with boxes while %femi_help is 0 (gnome_gate.rs2:20-22,
    // quests/quest_grandtree/scripts/femi.rs2:75-86): "Sorry, I'm a bit busy." sets it, and the next click opens.
    const gate = async (label: string, inside: boolean): Promise<void> => {
        const through = () => inside ? (q.pos()?.worldZ ?? 0) >= 3385 : (q.pos()?.worldZ ?? 9999) <= 3382;
        await q.walk(`${label} approach`, [{ x: GNOME_GATE.x + 2, z: inside ? 3380 : 3387, tol: 2 }]);
        for (let i = 0; i < 4 && !through(); i++) {
            await q.guard(label);
            const g = q.findLoc(l => l.id === GNOME_GATE.id || (/gate/i.test(l.name) && Math.abs(l.x - GNOME_GATE.x) <= 3 && Math.abs(l.z - GNOME_GATE.z) <= 1 && (l.optionsWithIndex ?? []).some((o: any) => /open/i.test(o.text))));
            if (!g) { await q.waitTicks(1); continue; }
            await q.opLoc(g, 1);
            await q.waitUntil(() => through() || q.dialogOpen(), 10);
            if (q.dialogOpen()) await q.converse([/a bit busy/i], () => !q.dialogOpen(), 20);
            await q.waitUntil(through, 6);
        }
        if (!through()) await q.fail(label);
    };

    // The guard: the card.
    await q.talk('guard start', /^barbarian guard$/i, [/i want to come through this gate/i, /looks can be deceiving/i], () => q.has(CARD), GUARD, 40);
    await q.converse([], () => !q.dialogOpen(), 20);
    q.milestone('card');

    // Blurberry: the Stronghold gate, the Grand Tree ladder, upstairs (2480,3490,1), and out again.
    await gate('gnome gate in', true);
    // The Grand Tree doors (treedoorl 1967 / treedoorr 1968 at 2464-2466,3492) move the bot 2 tiles through
    // (gnome_gate.rs2:63-77).
    const treeDoor = async (label: string, inside: boolean): Promise<void> => {
        const through = () => inside ? (q.pos()?.worldZ ?? 0) >= 3493 : (q.pos()?.worldZ ?? 9999) <= 3491;
        if (!through()) await q.walk(`${label} approach`, [{ x: 2465, z: inside ? 3490 : 3494, tol: 1 }]);
        await q.step(label, () => { const d = q.findLoc(l => (l.id === 1967 || l.id === 1968) && l.z === 3492); return d ? q.opLoc(d, 1) : q.waitTicks(1); }, through, 8, 4);
    };
    await treeDoor('tree door in', true);
    await q.walk('to blurberry ladder', [{ x: BLUR_LADDER.x, z: BLUR_LADDER.z - 1, tol: 1 }]);
    await q.climb('blurberry ladder', () => q.findLoc(l => /ladder/i.test(l.name) && Math.max(Math.abs(l.x - BLUR_LADDER.x), Math.abs(l.z - BLUR_LADDER.z)) <= 1 && (l.optionsWithIndex ?? []).some((o: any) => /climb-up/i.test(o.text))), /climb-up/i, levelIs(1));
    await bar('blurberry');
    await q.walk('to ladder top', [{ x: BLUR_LADDER.x + 1, z: BLUR_LADDER.z - 1, tol: 2 }]);
    await q.climb('blurberry ladder down', () => q.findLoc(l => /ladder/i.test(l.name) && Math.max(Math.abs(l.x - BLUR_LADDER.x), Math.abs(l.z - BLUR_LADDER.z)) <= 1 && (l.optionsWithIndex ?? []).some((o: any) => /climb-down/i.test(o.text))), /climb-down/i, levelIs(0));
    await treeDoor('tree door out', false);
    await gate('gnome gate out', false);

    await q.teleport('falador teleport', 'magic:falador_teleport', 2965, 3378);
    await bar('risingsun');
    await bar('rustyanchor');
    await sail('to karamja', /^(seaman lorris|seaman thresnor|captain tobias)$/i, [/^yes please/i], SARIM_SAILOR, MUSA_DECK);
    await bar('zambo');
    await bar('deadman');
    await sail('to ardougne', /^customs officer$/i, [/can i journey on this ship/i, /search away/i, /^ok\.?$/i], BRIM_CUSTOMS, ARDY_DECK);
    await bar('flyinghorse');
    await bar('dragoninn');
    await q.teleport('varrock teleport', 'magic:varrock_teleport', 3213, 3424);
    await bar('bluemoon');
    await bar('jollyboar');
    await q.teleport('camelot teleport', 'magic:camelot_teleport', 2757, 3478);
    await bar('foresters');

    // The guard with all ten signatures.
    await q.talk('guard end', /^barbarian guard$/i, [], () => q.sawText(/you can come in now/i), GUARD, 40);
    await q.converse([], () => !q.dialogOpen(), 10);
    const done = q.sawText(/you can come in now/i) && !q.has(CARD);
    q.milestone('complete');
    await q.end(done && signed === 10, `bars=${signed} card=${q.has(CARD)}`);
} catch (e) { await q.fail(String(e)); }
