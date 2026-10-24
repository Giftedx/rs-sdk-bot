// Alfred Grimhand's Barcrawl (miniquest, no QP: not in general/configs/quest.constant) from preset barcrawl (beside the
// Barbarian Outpost gate guards). It opens the outpost gate for Scorpion Catcher's scorpion B
// (areas/area_barbarian_outpost/scripts/outpost_gate.rs2:1-5) and the Barbarian course. Paths below are under
// vendor/rs-sdk/server/content/scripts/. Varp %barcrawl (77): 1 from the guard ("Looks can be deceiving...", the card
// 455, barbarian_outpost_guard.rs2:11-31); bits 3-12 one per bar (quest_barcrawl.constant); the guard with all ten
// bits sets 2 (barbarian_outpost_guard.rs2:48-60). Each bartender has the "Alfred Grimhand's Barcrawl" option while its
// bit is clear and the card is in the pack. Prices: Rising Sun 70, Rusty Anchor 8, Zambo 7, Dead Man's Chest 15,
// Flying Horse 8, Dragon Inn 12, Blue Moon 50, Jolly Boar 10, Foresters Arms 18, Blurberry 10 = 208 coins; two ships
// at 30 (sailors.rs2:14-31, customs_officer.rs2:72-84). Order: Falador Teleport, Port Sarim, the ship to Musa Point,
// Brimhaven, the ship to Ardougne, Yanille, Varrock Teleport, Camelot Teleport, the Gnome Stronghold, the outpost.
import { openQuest } from './quest-lib';

const CARD = 455;
const GUARD = { x: 2544, z: 3569 };
const SIGN = /sign(s|ing)? (your|2) (barcrawl )?cards?|scrawls his signature/i;
// Bars: NPC name, a tile near its spawn (knowledge/npcs.json).
const BAR = {
    risingsun: { re: /^barmaid$/i, at: { x: 2957, z: 3370 } },
    rustyanchor: { re: /^bartender$/i, at: { x: 3045, z: 3257 } },
    zambo: { re: /^zambo$/i, at: { x: 2925, z: 3143 } },
    deadman: { re: /^bartender$/i, at: { x: 2797, z: 3155 } },
    flyinghorse: { re: /^bartender$/i, at: { x: 2575, z: 3320 } },
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
const BLUR_LADDER = { x: 2466, z: 3495 };      // ladder (1747), maps/m38_54.jm2

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
        if (!q.near(b.at.x, b.at.z, 6)) await q.walk(`to ${name}`, [{ x: b.at.x, z: b.at.z, tol: 4 }]);
        await q.talk(name, b.re, [/alfred grimhand/i], () => q.msgCount(SIGN) > before, b.at, 40);
        await q.waitUntil(() => !q.dialogOpen(), 6);
        signed++;
        q.milestone(`${signed} ${name}`);
    };

    // The guard: the card.
    await q.talk('guard start', /^barbarian guard$/i, [/i want to come through this gate/i, /looks can be deceiving/i], () => q.has(CARD), GUARD, 40);
    await q.converse([], () => !q.dialogOpen(), 20);
    q.milestone('card');

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
    // Blurberry is upstairs (2480,3490,1).
    await q.walk('to blurberry ladder', [{ x: BLUR_LADDER.x, z: BLUR_LADDER.z - 1, tol: 2 }]);
    await q.climb('blurberry ladder', () => q.findLoc(l => /ladder/i.test(l.name) && Math.max(Math.abs(l.x - BLUR_LADDER.x), Math.abs(l.z - BLUR_LADDER.z)) <= 1 && (l.optionsWithIndex ?? []).some((o: any) => /climb-up/i.test(o.text))), /climb-up/i, levelIs(1));
    await bar('blurberry');
    await q.climb('blurberry ladder down', () => q.findLoc(l => /ladder/i.test(l.name) && l.distance <= 15 && (l.optionsWithIndex ?? []).some((o: any) => /climb-down/i.test(o.text))), /climb-down/i, levelIs(0));

    // The guard with all ten signatures.
    await q.talk('guard end', /^barbarian guard$/i, [], () => q.sawText(/you can come in now/i), GUARD, 40);
    await q.converse([], () => !q.dialogOpen(), 10);
    const done = q.sawText(/you can come in now/i) && !q.has(CARD);
    q.milestone('complete');
    await q.end(done && signed === 10, `bars=${signed} card=${q.has(CARD)}`);
} catch (e) { await q.fail(String(e)); }
