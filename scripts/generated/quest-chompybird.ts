// Big Chompy Bird Hunting from preset quest_chompybird (beside Rantz in the Feldip Hills; every skill 99; a knife, a
// chisel, an achey log, wolf bones, feathers, 6 ogre arrows, the 6 possible seasonings and 50 worn ogre arrows from a
// helper). Reward: 2 QP, the ogre bow, Fletching 262, Cooking 1,470, Ranged 735 XP before 25x
// (quest_chompybird.rs2:39-49).
// %chompybird stages (quest_chompybird.constant:1-13): Rantz starts it (5, rantz.rs2:29-49); 6 ogre arrows that the
// bot made itself (the made_arrows bit, ogre_arrows.rs2:139-142) go to Rantz (10, rantz.rs2:263-283) and his first
// question sets 15 (:288-294); the rock off the chest in his cave (20) and the bellows (ogre_chest.rs2); the bellows
// fill at the swamp bubbles and inflate 3 swamp toads (swamp_toad.rs2:28-56); Rantz sees a bloated toad (25,
// rantz.rs2:62-74); a toad placed in the clearing (30, bloated_toad.rs2:42-77) calls a chompy at random
// (:79-108, 1 in 5 per 25 ticks for 4 rolls); Rantz shoots it and misses (40, chompy_bird.rs2:221-253) and lends the
// bow (45, rantz.rs2:85-109); the bot's kill (50, chompy_bird.rs2:226-231), the pluck, Rantz sees the raw chompy (55)
// and names his seasoning; Bugs and Fycie name theirs (bugs.rs2, fycie.rs2: the seasonings are random, so the bot
// reads them from the dialog); the spit roast with all three seasonings (60) hands the chompy to Rantz when he is
// within 10 tiles (raw_chompy.rs2:36-49) and the queue completes the quest.
import { openQuest } from './quest-lib';

const ITEM = {
    knife: 946, chisel: 1755, log: 2862, bones: 2859, feather: 314, shaft: 2864, headless: 2865, tips: 2861, arrow: 2866,
    bow: 2883, bellows: 2871, bellows3: 2872, bellows2: 2873, bellows1: 2874, toad: 2875, raw: 2876, cooked: 2882,
    potato: 1942, onion: 1957, equa: 2128, cabbage: 1965, tomato: 1982, doogle: 1573,
};
const RANTZ = { x: 2630, z: 2981 };
const SPIT = { id: 3375, x: 2630, z: 2990 };
const CAVE_IN = { id: 3379, x: 2629, z: 2998 };
const CAVE_ARRIVE = { x: 2647, z: 9379 };
const CAVE_OUT = { id: 3380, x: 2646, z: 9377 };
const CHEST = { id: 3377, x: 2637, z: 9398 };
const CHEST_OPEN = 3378;
const BUGS = { x: 2640, z: 9391 };
const FYCIE = { x: 2650, z: 9393 };
const BUBBLES = { x: 2600, z: 2966 };
// The clearing (bloated_toad.rs2:49, zone 0_41_46_7_18 .. 0_41_46_15_27 = 2631-2639, 2962-2971); within 20 tiles of
// Rantz, so he shoots (chompy_bird.rs2:221-224).
const CLEARING = { x: 2635, z: 2967 };
const SEASON: Record<string, number> = { potato: ITEM.potato, onion: ITEM.onion, 'equa leaves': ITEM.equa, cabbage: ITEM.cabbage, tomato: ITEM.tomato, 'doogle leaves': ITEM.doogle };

const q = await openQuest({ cap: 4000 });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const closeDlg = async () => { if (q.dialogOpen()) await q.converse([], () => !q.dialogOpen(), 12); };
    const worn = (id: number) => (q.st()?.equipment ?? []).some((e: any) => e?.id === id);
    const inCave = () => (q.pos()?.worldZ ?? 0) > 9000;
    const ground = (id: number): any => (q.st()?.groundItems ?? []).filter((g: any) => g.id === id).sort((a: any, b: any) => q.cheb(a.x, a.z) - q.cheb(b.x, b.z))[0];
    const npcs = (re: RegExp): any[] => (q.st()?.nearbyNpcs ?? []).filter((n: any) => re.test(n.name));
    const optOf = (n: any, re: RegExp): number | undefined => n?.optionsWithIndex?.find((o: any) => re.test(o.text))?.opIndex;
    const liveChompy = () => npcs(/^chompy bird$/i).find(n => optOf(n, /attack/i) !== undefined);
    const deadChompy = () => npcs(/^chompy bird$/i).find(n => optOf(n, /pluck/i) !== undefined);
    const placedToad = () => npcs(/^bloated toad$/i)[0];
    const bellows = () => [ITEM.bellows3, ITEM.bellows2, ITEM.bellows1].find(id => q.has(id));
    const combine = async (label: string, a: number, b: number, ok: () => boolean) => {
        for (let i = 0; i < 4 && !ok(); i++) {
            await closeDlg();
            if (!q.has(a) || !q.has(b)) await q.fail(`${label}: missing ${a} or ${b}`);
            await (i % 2 === 0 ? q.useOnItem(a, b) : q.useOnItem(b, a));
            await q.waitUntil(ok, 4);
        }
        if (!ok()) await q.fail(`step ${label}`);
        await closeDlg();
    };
    const toCave = async () => {
        if (inCave()) return;
        await q.walk('to cave', [{ x: CAVE_IN.x, z: CAVE_IN.z - 1, tol: 1 }]);
        await q.climb('cave in', () => q.locAt(CAVE_IN.x, CAVE_IN.z) ?? CAVE_IN, /enter/i, () => inCave());
    };
    const outCave = async () => {
        if (!inCave()) return;
        await q.walk('to cave exit', [{ x: CAVE_ARRIVE.x, z: CAVE_ARRIVE.z, tol: 1 }]);
        await q.climb('cave out', () => q.locAt(CAVE_OUT.x, CAVE_OUT.z) ?? q.findLoc(l => /cave exit/i.test(l.name)) ?? CAVE_OUT, /walk through/i, () => !inCave());
    };
    const rantz = async (label: string, pats: RegExp[], ok: () => boolean, stopOpen = false) => {
        await outCave();
        await q.talk(label, /^rantz$/i, pats, ok, RANTZ, 80, stopOpen);
    };

    // 1. Rantz: "Ok, I'll make you some 'stabbers'." (5).
    await rantz('rantz start', [/ok, i'll make you some 'stabbers'/i], () => q.sawText(/sticksies from achey tree/i));
    q.milestone(5);

    // 2. Ogre arrows made by the bot set the made_arrows bit; Rantz takes 6 (10). His first question sets 15.
    await combine('shafts', ITEM.knife, ITEM.log, () => q.has(ITEM.shaft));
    await combine('tips', ITEM.chisel, ITEM.bones, () => q.has(ITEM.tips));
    await combine('flights', ITEM.feather, ITEM.shaft, () => q.has(ITEM.headless));
    const a0 = q.cnt(ITEM.arrow);
    await combine('ogre arrows', ITEM.tips, ITEM.headless, () => q.cnt(ITEM.arrow) > a0);
    console.log(`MILESTONE made ${q.cnt(ITEM.arrow) - a0} arrows ${q.T()}`);
    await rantz('rantz arrows', [/how do we make the chompys come/i], () => q.sawText(/fussie eaters/i), true);
    await q.converse([/^ok, thanks/i], () => !q.dialogOpen(), 30);
    q.milestone(15);

    // 3. The cave: the rock off the chest (20; a Strength roll, retried), the bellows from the open chest.
    await toCave();
    await q.walk('to chest', [{ x: CHEST.x, z: CHEST.z - 1, tol: 1 }]);
    for (let i = 0; i < 8 && !q.has(ITEM.bellows); i++) {
        await closeDlg();
        const open = q.findLoc(l => l.id === CHEST_OPEN && l.x === CHEST.x && l.z === CHEST.z);
        await q.opLoc(open ?? q.locAt(CHEST.x, CHEST.z) ?? CHEST, 1);
        await q.waitUntil(() => q.has(ITEM.bellows) || q.dialogOpen() || (!open && !!q.findLoc(l => l.id === CHEST_OPEN)), 8);
    }
    if (!q.has(ITEM.bellows)) await q.fail('step bellows');
    await closeDlg();
    q.milestone('bellows');

    // 4. Swamp gas, then 3 bloated toads (3 is the most the bot can hold, swamp_toad.rs2:36-46).
    const fillToads = async () => {
        await outCave();
        await q.walk('to bubbles', [{ x: BUBBLES.x, z: BUBBLES.z, tol: 3 }]);
        while (q.cnt(ITEM.toad) < 3) {
            await q.guard('toads');
            // Some bubbles sit in the swamp out of reach (trial 1: "I can't reach that!"); reachable ones first.
            for (const b of q.locs().filter((l: any) => /swamp bubbles/i.test(l.name)).sort((a: any, b: any) => Number(a.reachable === false) - Number(b.reachable === false) || a.distance - b.distance).slice(0, 4)) {
                if (bellows()) break;
                await closeDlg();
                await q.useOnLoc(ITEM.bellows, b);
                await q.waitUntil(() => !!bellows(), 8);
            }
            if (!bellows()) await q.fail('step fill bellows');
            const t0 = q.cnt(ITEM.toad);
            const toad = npcs(/^swamp toad$/i).sort((a, b) => Number(a.reachable === false) - Number(b.reachable === false) || a.distance - b.distance)[0];
            if (!toad) { await q.walk('toad search', [{ x: BUBBLES.x - 3, z: BUBBLES.z, tol: 2 }]); continue; }
            await q.useOnNpc(bellows()!, toad);
            await q.waitUntil(() => q.cnt(ITEM.toad) > t0, 10);
        }
    };
    await fillToads();
    q.milestone('toads');

    // 5. Rantz sees the toad (25).
    await rantz('rantz toad', [], () => q.sawText(/put da toadies over der/i));
    q.milestone(25);

    // 6. Toads in the clearing until a chompy comes; at stage 30-35 Rantz shoots it and misses (40).
    const bait = async (label: string, done: () => boolean, maxTicks: number) => {
        const t1 = q.T();
        while (!done()) {
            await q.guard(label);
            if (q.T() - t1 > maxTicks) await q.fail(`${label}: no chompy`);
            if (!liveChompy() && !placedToad()) {
                if (!q.has(ITEM.toad)) { await fillToads(); q.milestone(`refill ${q.T()}`); }
                if (!q.near(CLEARING.x, CLEARING.z, 2)) await q.walk('to clearing', [{ x: CLEARING.x, z: CLEARING.z, tol: 1 }]);
                await closeDlg();
                const c0 = q.cnt(ITEM.toad);
                await q.s.direct({ type: 'useInventoryItem', slot: q.slot(ITEM.toad)!, optionIndex: 1, reason: 'SDK' });
                await q.waitUntil(() => q.cnt(ITEM.toad) < c0, 5);
                if (q.cnt(ITEM.toad) < c0) console.log(`MILESTONE toad placed ${q.T()}`);
                else { await q.walk('toad spot', [{ x: CLEARING.x + 2, z: CLEARING.z + 1, tol: 0 }]); continue; }
            }
            await q.waitTicks(1);
        }
    };
    await bait('rantz shot', () => q.msgCount(/rantz keeps missing/i) > 0, 900);
    q.milestone(40);

    // 7. Rantz lends the bow (45); wield it (two-handed, the shield goes to the pack). 50 ogre arrows are worn.
    await rantz('rantz bow', [/come on, let me have a go/i, /i'm actually quite strong/i], () => q.has(ITEM.bow) || worn(ITEM.bow));
    q.milestone(45);
    await q.step('wield bow', () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(ITEM.bow)!, optionIndex: 2, reason: 'SDK' }), () => worn(ITEM.bow), 3, 3);

    // 8. The bot's own chompy: bait, shoot (op5), pluck (op4), pick up the raw chompy (50).
    const t2 = q.T();
    while (!q.has(ITEM.raw)) {
        await q.guard('chompy kill');
        if (q.T() - t2 > 1200) await q.fail('chompy kill: timeout');
        const dead = deadChompy();
        const g = ground(ITEM.raw);
        if (g) { await q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' }); await q.waitUntil(() => q.has(ITEM.raw), 6); continue; }
        if (dead) { await q.s.direct({ type: 'interactNpc', npcIndex: dead.index, optionIndex: optOf(dead, /pluck/i)!, reason: 'SDK' }); await q.waitUntil(() => !!ground(ITEM.raw), 8); continue; }
        const c = liveChompy();
        if (c) {
            if (q.pos()?.targetIndex !== c.index) await q.s.direct({ type: 'interactNpc', npcIndex: c.index, optionIndex: optOf(c, /attack/i)!, reason: 'SDK' });
            await q.waitTicks(2);
            continue;
        }
        await bait('chompy bait', () => !!liveChompy() || !!deadChompy(), 900);
    }
    q.milestone(50);

    // 9. Rantz sees the chompy (55) and names his seasoning; Bugs and Fycie name theirs.
    // Each ogre's pick, read from its line: the two picks of one ogre never match another ogre's (rantz.rs2:149-155,
    // bugs.rs2:57-66, fycie.rs2:50-62).
    const seasoning = (who: string, opts: string[], pat: (k: string) => string): string => {
        const m = opts.find(k => q.sawText(new RegExp(pat(k), 'i')));
        console.log(`MILESTONE ${who} wants ${m ?? '?'} ${q.T()}`);
        if (!m) return q.fail(`${who}: seasoning not read`) as never;
        return m;
    };
    await rantz('rantz chompy', [], () => q.sawText(/go and ask 'em wat dey/i));
    const want = [seasoning('Rantz', ['potato', 'onion'], k => `wants[^a-z]+${k}`)];
    q.milestone(55);
    await toCave();
    const bugsPat = (k: string) => `have[^a-z]+${k}[^a-z]+wiv mine`;
    await q.talk('bugs', /^bugs$/i, [], () => q.sawText(new RegExp(bugsPat('(equa leaves|cabbage)'), 'i')), BUGS, 40);
    want.push(seasoning('Bugs', ['equa leaves', 'cabbage'], bugsPat));
    const fyciePat = (k: string) => `wants[^a-z]+${k}[^a-z]+wiv mine`;
    await q.talk('fycie', /^fycie$/i, [], () => q.sawText(new RegExp(fyciePat('(tomato|doogle leaves)'), 'i')), FYCIE, 40);
    want.push(seasoning('Fycie', ['tomato', 'doogle leaves'], fyciePat));
    for (const w of want) if (!q.has(SEASON[w] ?? -1)) await q.fail(`no seasoning ${w}`);

    // 10. The spit roast (60); Rantz within 10 tiles takes the chompy and the queue completes the quest.
    await outCave();
    await q.walk('to spit', [{ x: SPIT.x, z: SPIT.z - 1, tol: 1 }]);
    const before = Object.fromEntries(Object.entries(SEASON).map(([k, id]) => [k, q.cnt(id)]));
    await q.step('spit roast', () => q.useOnLoc(ITEM.raw, q.locAt(SPIT.x, SPIT.z) ?? SPIT), () => q.has(ITEM.cooked) || !q.has(ITEM.raw), 12, 3);
    await q.converse([], () => questDone, 40);
    const used = Object.entries(SEASON).filter(([k, id]) => q.cnt(id) < before[k]!).map(([k]) => k);
    console.log(`MILESTONE cooked with ${used.join(', ')} (asked ${want.join(', ')}) ${q.T()}`);
    if (used.sort().join() !== [...want].sort().join()) await q.fail(`seasonings used ${used} asked ${want}`);
    if (!questDone && q.has(ITEM.cooked)) await rantz('rantz cooked', [], () => questDone);
    await q.waitUntil(() => questDone, 10);
    q.milestone(100);
    off();
    await q.end(questDone, 'qp=2');
} catch (e) { await q.fail(String(e)); }
