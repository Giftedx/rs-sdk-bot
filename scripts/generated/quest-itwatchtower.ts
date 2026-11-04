// Watch Tower from preset quest_itwatchtower (north of the Yanille watchtower's climbing rocks; every skill 99; the
// tradeable kit from a helper). Reward: 4 QP, 5,000 coins (quests/quest_itwatchtower/scripts/quest_itwatchtower.rs2:513-545).
// Route, regions, stage signals and dialogue answers are adapted from rs-stun-toolkit `q-watch-tower.ts` (MIT,
// research/stun-toolkit-LICENSE.txt). %itwatchtower, %itwatchtower_bits and %gutanoth_gold are varps our SDK does not
// read, so every step gates on items, position and dialogue text.
//  - Wizard (level 2 of the tower): start, fingernails from the bush, the three relic parts, the potion, the crystals.
//  - Og (key, then the stolen gold -> part 1), Grew (Gorad's tooth -> part 2 + crystal 1), Toban (dragon bones -> part 3).
//  - Gu'Tanoth: the relic on the NW gate guard, a rock cake over the battlement, the paid chasm jump, a death rune on the
//    city guard for the skavid map. Caves 5, 4, 3, 2, 1 teach skavid; the gold bar opens the east gate; the mad skavid in
//    cave 6 gives crystal 2 (his line is random(3), skavid.rs2:165-210). Nightshade (caves 2 and 6) on the enclave guard.
//  - The magic ogre potion on 6 shamans (crystal 3), the Rock of Dalgroth (crystal 4, mining 40 + pickaxe), the lever.
//  - Regions (theirs, from the collision map): the hill (tower, Og, caves 1-5, Toban's cave, the enclave exit) is one walk
//    region; the west city, the east pocket, the jump pocket, the city-guard ledge, Toban's plateau and Grew's island are
//    closed pockets reached only by their scripted crossings. The two Gu'Tanoth gates are walls for the walk planner.
import { openQuest } from './quest-lib';
import * as pf from '../../vendor/rs-sdk/sdk/pathfinding';

const N = { wizard: 872, og: 853, grew: 854, toban: 855, gorad: 856, guard1: 858, guard2: 859, guard4: 861, cityGuard: 862,
    scared: 863, mad: 864, talker1: 865, talker2: 866, talker3: 867, talker4: 868, enclaveGuard: 870, shaman: 871, trader2: 875, ogre: 115 };
const O = { nails: 2384, key: 2378, gold: 2393, tooth: 2377, part1: 2373, part2: 2374, part3: 2375, relic: 2372, cake: 2379,
    map: 2376, nightshade: 2398, c1: 2380, c2: 2381, c3: 2382, c4: 2383, guamvial: 91, guamjanger: 2390, potion: 2394, magicPotion: 2395,
    scroll: 2396, rope: 954, bones: 536, goldBar: 2357, death: 560, guam: 249, water: 227, batBones: 2391, berries: 247 };
const LIGHTS = [33, 594, 32];
type L = { id: number; x: number; z: number };
const L = {
    rocks: { id: 2299, x: 2548, z: 3119 }, ladderUp1: { id: 2796, x: 2549, z: 3111 }, ladderDown2: { id: 2797, x: 2549, z: 3111 },
    ladderTop1: { id: 1746, x: 2544, z: 3111 }, lever: { id: 2794, x: 2543, z: 3115 }, bush: { id: 2799, x: 2544, z: 3134 },
    ropeTree: { id: 2326, x: 2499, z: 3087 }, swingOut: { id: 2324, x: 2511, z: 3090 }, tobanCave: { id: 2811, x: 2499, z: 2989 },
    tobanLadder: { id: 2812, x: 2575, z: 3029 }, tobanChest: { id: 2790, x: 2575, z: 3031 }, gate2: { id: 2788, x: 2504, z: 3062 },
    gate1out: { id: 2787, x: 2549, z: 3028 }, counter: { id: 2793, x: 2506, z: 3023 }, battlement: { id: 2832, x: 2507, z: 3011 },
    jump1: { id: 2830, x: 2530, z: 3026 }, jump2: { id: 2831, x: 2531, z: 3029 },
    cave1: { id: 2805, x: 2560, z: 3022 }, cave2: { id: 2806, x: 2522, z: 3068 }, cave3: { id: 2807, x: 2539, z: 3052 },
    cave4: { id: 2808, x: 2552, z: 3052 }, cave5: { id: 2809, x: 2553, z: 3033 }, cave6: { id: 2810, x: 2527, z: 3011 },
    exit1: { id: 2817, x: 2497, z: 9418 }, exit2: { id: 2818, x: 2532, z: 9470 }, exit3: { id: 2819, x: 2518, z: 9456 },
    exit4: { id: 2820, x: 2497, z: 9451 }, exit5: { id: 2821, x: 2504, z: 9442 }, exit6: { id: 2822, x: 2521, z: 9411 },
    enclaveExit: { id: 2813, x: 2598, z: 9468 }, rock: { id: 2816, x: 2590, z: 9449 },
} as const;
// The gate leaves (getDoorAt geometry: the west edge of x2504 z3062-3063, the south edge of x2549-2550 z3028).
const GATES = [[2504, 3062], [2504, 3063], [2549, 3028], [2550, 3028]] as const;

const q = await openQuest({ cap: 9000, eatAt: 60 });
try {
    let questDone = false;
    q.s.onTick(() => { if (q.msgCount(/quest complete|finished the watchtower quest/i) > 0) questDone = true; });
    const x = () => q.pos()?.worldX ?? 0;
    const z = () => q.pos()?.worldZ ?? 0;
    const inBox = (x0: number, z0: number, x1: number, z1: number, level = 0) => q.lvl() === level && x() >= x0 && x() <= x1 && z() >= z0 && z() <= z1;
    // Dialogue text with a mark: quest-lib sawText keeps every page, so a later step would match an earlier page.
    const texts: string[] = [];
    let lastText = '';
    q.s.onTick(() => {
        const d: any = q.s.sdk.getDialog();
        const t = d?.isOpen ? [d.text ?? '', ...(d.allComponents ?? []).map((c: any) => c.text ?? '')].filter(Boolean).join(' ') : '';
        if (t && t !== lastText) { texts.push(t); lastText = t; }
        for (const m of (q.st()?.gameMessages ?? []).slice(-3)) { const k = `#${m.tick}:${m.text}`; if (!texts.includes(k)) texts.push(k); }
    });
    const mark = () => texts.length;
    const seen = (re: RegExp, m: number) => texts.slice(m).some(t => re.test(t)) || re.test(lastText);

    // The gates are walls for this session's walk planner; every crossing below is an explicit op.
    for (const [gx, gz] of GATES) if (!q.blockDoor(0, gx, gz)) console.log(`WARN no door at ${gx},${gz}`);
    const gateDoors = GATES.map(([gx, gz]) => pf.getDoorAt(0, gx, gz)).filter(Boolean) as any[];
    // Same walk region as `anchor` (gates walled), cached per tile pair: their rule for pockets with irregular shapes.
    const REG = new Map<string, boolean>();
    const sameRegion = (ax: number, az: number): boolean => {
        if (q.lvl() !== 0) return false;
        const k = `${ax},${az}|${x()},${z()}`;
        const c = REG.get(k); if (c !== undefined) return c;
        const reach = (sx: number, sz: number, tx: number, tz: number) => {
            if (sx === tx && sz === tz) return true;
            let p: Array<{ x: number; z: number }> = [];
            try { p = pf.findLongPath(0, sx, sz, tx, tz, 800, gateDoors); } catch { p = []; }
            const e = p[p.length - 1];
            return !!e && e.x === tx && e.z === tz;
        };
        const r = q.cheb(ax, az) < 40 && (reach(x(), z(), ax, az) || reach(ax, az, x(), z()));
        REG.set(k, r); return r;
    };
    const onIsland = () => inBox(2502, 3077, 2522, 3095);
    const onPlateau = () => sameRegion(2576, 3029);
    const inEnclave = () => inBox(2560, 9390, 2630, 9480);
    const inCaves = () => inBox(2490, 9400, 2545, 9480);
    const wCity = () => inBox(2490, 3005, 2507, 3061) || inBox(2490, 3013, 2525, 3045);
    const ePocket = () => inBox(2520, 3005, 2560, 3027);
    const jumpPocket = () => inBox(2508, 3005, 2535, 3027);
    const ledgeBox = () => inBox(2526, 3028, 2550, 3040);

    const npcOf = (id: number): any => (q.st()?.nearbyNpcs ?? []).filter((n: any) => n.id === id).sort((a: any, b: any) => a.distance - b.distance)[0];
    const locOf = (l: L): any => q.findLoc((k: any) => k.id === l.id && k.x === l.x && k.z === l.z) ?? l;
    const go = async (label: string, tx: number, tz: number, tol = 2) => { if (q.cheb(tx, tz) > tol) await q.walk(label, [{ x: tx, z: tz, tol }]); };
    // A loc op that answers any dialogue it opens, until done().
    const opLocUntil = async (label: string, l: L, done: () => boolean, o: { op?: number; pats?: RegExp[]; tries?: number; ticks?: number } = {}) => {
        for (let i = 0; i < (o.tries ?? 5) && !done(); i++) {
            await q.guard(label);
            if (i > 0) q.stats.retries++;
            if (!q.dialogOpen()) {
                await q.opLoc(locOf(l), o.op ?? 1);
                await q.waitUntil(() => q.dialogOpen() || done(), o.ticks ?? 20);
            }
            let shut = 0;
            await q.converse(o.pats ?? [], () => { shut = q.dialogOpen() ? 0 : shut + 1; return (done() && !q.dialogOpen()) || shut >= 3; }, 60);
        }
        if (!done()) await q.fail(`loc ${label}`);
    };
    // Talk to the nearest npc of an id, answering with pats, until ok().
    const talk = async (label: string, id: number, pats: RegExp[], ok: () => boolean, maxTicks = 80) => {
        for (let i = 0; i < 4 && !ok(); i++) {
            await q.guard(label);
            if (i > 0) q.stats.retries++;
            const n = npcOf(id);
            if (!n) await q.fail(`${label}: no npc ${id}`);
            if (!q.dialogOpen()) { await q.talkTo(n); await q.waitUntil(() => q.dialogOpen() || ok(), 25); }
            let shut = 0;
            await q.converse(pats, () => { shut = q.dialogOpen() ? 0 : shut + 1; return (ok() && !q.dialogOpen()) || shut >= 3; }, maxTicks);
        }
        if (!ok()) await q.fail(`talk ${label}`);
    };
    // Use an item on the nearest npc of an id, answering its dialogue, until ok().
    const give = async (label: string, item: number, id: number, ok: () => boolean, pats: RegExp[] = [], tries = 4) => {
        for (let i = 0; i < tries && !ok(); i++) {
            await q.guard(label);
            if (i > 0) q.stats.retries++;
            if (!q.dialogOpen()) {
                const n = npcOf(id);
                if (!n) await q.fail(`${label}: no npc ${id}`);
                if (!q.has(item)) await q.fail(`${label}: no item ${item}`);
                await q.useOnNpc(item, n);
                await q.waitUntil(() => q.dialogOpen() || ok(), 20);
            }
            let shut = 0;
            await q.converse(pats, () => { shut = q.dialogOpen() ? 0 : shut + 1; return (ok() && !q.dialogOpen()) || shut >= 3; }, 60);
        }
        if (!ok()) await q.fail(`give ${label}`);
    };
    const pickup = async (label: string, id: number) => {
        const g = (q.st()?.groundItems ?? []).filter((i: any) => i.id === id).sort((a: any, b: any) => a.distance - b.distance)[0];
        if (!g) await q.fail(`${label}: no ground item ${id}`);
        const n0 = q.cnt(id);
        await q.step(label, () => q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: id, reason: 'SDK' }), () => q.cnt(id) > n0, 20, 3);
    };
    const drop = async (id: number) => { const it = q.inv().find((e: any) => e.id === id); if (it) { await q.s.direct({ type: 'dropItem', slot: it.slot, reason: 'SDK' }); await q.waitTicks(1); } };

    // Tower: the climbing rocks (agility 18) are the way up before stage 1 and right outside, so the bot always uses them.
    const toTop = async () => {
        if (q.lvl() === 2) return;
        if (q.lvl() === 0) {
            await go('watchtower', 2549, 3121, 3);
            await q.climb('climbing rocks', () => locOf(L.rocks), /climb/i, () => q.lvl() === 1);
        }
        if (q.lvl() === 1) await q.climb('ladder up', () => locOf(L.ladderUp1), /climb-up/i, () => q.lvl() === 2);
    };
    const toGround = async () => {
        if (q.lvl() === 2) await q.climb('ladder down', () => locOf(L.ladderDown2), /climb-down/i, () => q.lvl() === 1);
        if (q.lvl() === 1) await q.climb('ladder top', () => locOf(L.ladderTop1), /climb-down/i, () => q.lvl() === 0);
        if (inBox(2538, 3105, 2556, 3118)) await q.walk('tower door', [{ x: 2549, z: 3121, tol: 1 }]);
    };

    // 1. Wizard: "What's the matter?" -> "So how come the spell doesn't work?" -> "Can I be of help?" (=1).
    await toTop();
    let m = mark();
    await talk('wizard start', N.wizard, [/what's the matter/i, /spell doesn't work/i, /can I be of help/i], () => seen(/try searching the surrounding area/i, m));
    q.milestone(1);
    // 2. The bush north of the tower: fingernails (stage 1 only).
    await toGround();
    await go('nail bush', 2544, 3133, 1);
    await opLocUntil('nail bush', L.bush, () => q.has(O.nails));
    // 3. Wizard with the nails (=2): "What do you suggest I do?" -> "So what do I do?".
    await toTop();
    m = mark();
    await talk('wizard nails', N.wizard, [/what do you suggest I do/i, /so what do I do/i], () => seen(/tribal ogres often dislike/i, m));
    await drop(O.nails);
    q.milestone(2);

    // 4. Og: "I seek entrance to the city of ogres." -> Toban's key.
    await toGround();
    await go('og', 2506, 3114, 2);
    await talk('og key', N.og, [/I seek entrance to the city of ogres/i], () => q.has(O.key));
    // 5. Rope on the tree -> Grew's island; Grew: "Don't eat me; I can help you."; swing off (stand on 2511,3091).
    const islandIn = async () => {
        if (onIsland()) return;
        await go('rope tree', 2500, 3087, 1);
        await q.step('rope swing', () => q.useOnLoc(O.rope, locOf(L.ropeTree)), () => onIsland(), 25, 4);
    };
    const islandOut = async () => {
        await go('swing stand', 2511, 3091, 0);
        await opLocUntil('swing off', L.swingOut, () => !onIsland());
    };
    await islandIn();
    m = mark();
    await go('grew', 2513, 3085, 3);
    await talk('grew 1', N.grew, [/don't eat me/i], () => seen(/knock one of his teeth out/i, m));
    await islandOut();
    q.milestone('grew asks');

    // 6. Toban's plateau: Toban (two menus, then the bones), Gorad's tooth, the chest (gold), the ladder down.
    await go('toban cave', 2499, 2990, 2);
    await opLocUntil("toban's cave", L.tobanCave, () => onPlateau(), { ticks: 30 });
    m = mark();
    await go('toban', 2576, 3027, 3);
    await talk('toban 1', N.toban, [/I seek entrance to the city of ogres/i, /I could do something for you/i], () => seen(/bones of an adult dragon/i, m));
    await give('bones on toban', O.bones, N.toban, () => q.has(O.part3));
    {
        // Gorad (cl68): the tooth comes from his death queue only with a free slot (gorad.rs2:28-34).
        const attackOp = (n: any) => n.optionsWithIndex?.find((o: any) => /^attack$/i.test(o.text))?.opIndex ?? 2;
        for (let k = 0; k < 12 && !q.has(O.tooth); k++) {
            await q.guard('gorad');
            if (q.inv().length >= 28) await q.fail('gorad: no free slot for the tooth');
            let g = npcOf(N.gorad);
            if (!g) { await go('gorad', 2577, 3021, 3); g = npcOf(N.gorad); }
            if (!g) { await q.waitTicks(5); continue; }
            const t0 = q.T(), m0 = mark();
            await q.s.direct({ type: 'interactNpc', npcIndex: g.index, optionIndex: attackOp(g), reason: 'SDK' });
            await q.waitUntil(() => q.has(O.tooth) || seen(/already under attack/i, m0) || !npcOf(N.gorad), 60);
            if (seen(/already under attack/i, m0)) {
                // Single combat: an ogre that hits us first pins us; kill the nearest one, then back to Gorad.
                const o = (q.st()?.nearbyNpcs ?? []).filter((n: any) => n.id === N.ogre && n.distance <= 3).sort((a: any, b: any) => a.distance - b.distance)[0];
                if (o) { console.log(`NOTE an ogre pins us at ${o.x},${o.z}`); await q.s.direct({ type: 'interactNpc', npcIndex: o.index, optionIndex: attackOp(o), reason: 'SDK' }); await q.waitUntil(() => !npcOf(N.ogre) || npcOf(N.ogre).index !== o.index || q.T() - t0 > 80, 80); }
            }
            await q.waitUntil(() => q.has(O.tooth), 4);
        }
        if (!q.has(O.tooth)) await q.fail("Gorad's tooth");
    }
    await go('toban chest', 2575, 3030, 1);
    await opLocUntil("toban's chest", L.tobanChest, () => q.has(O.gold));
    await opLocUntil('plateau ladder', L.tobanLadder, () => !onPlateau(), { ticks: 25 });
    q.milestone('toban');

    // 7. Og: the gold -> relic part 1 (no menu while the gold is held, og.rs2:44-54).
    await go('og 2', 2506, 3114, 2);
    await talk('og gold', N.og, [], () => q.has(O.part1));
    // 8. Grew: the tooth -> part 2 + crystal 1.
    await islandIn();
    await go('grew 2', 2513, 3085, 3);
    await talk('grew tooth', N.grew, [], () => q.has(O.part2) && q.has(O.c1));
    await islandOut();
    // 9. The three parts on the wizard -> the ogre relic (=3).
    await toTop();
    for (const p of [O.part1, O.part2, O.part3]) if (q.has(p)) await give(`part ${p}`, p, N.wizard, () => !q.has(p));
    if (!(await q.waitUntil(() => q.has(O.relic), 20))) await q.fail('ogre relic');
    q.milestone(3);

    // 10. The relic on the NW gate guard -> inside Gu'Tanoth (=4). The gate is reached from the east along z 3062.
    await toGround();
    await go('NW gate', 2509, 3062, 2);
    await give('relic on guard', O.relic, N.guard2, () => x() <= 2503 && z() < 3064);
    await drop(O.relic);
    q.milestone(4);
    // 11. Rock cake (thieving 15; the trader within 3 tiles refuses, ogre_trader.rs2:26-30), then the battlement guard:
    // "But I am a friend to ogres..." sets market 1; the next op with the cake gives it and climbs over.
    {
        const stand = { x: 2506, z: 3024 };
        await q.walk('cake counter', [{ ...stand, tol: 0 }]);
        for (let t = 0; t < 150 && !q.has(O.cake); t++) {
            await q.guard('cake');
            if (x() !== stand.x || z() !== stand.z) { await q.dash('cake stand', stand.x, stand.z, 0, 10); continue; }
            const tr = npcOf(N.trader2);
            if (tr && Math.max(Math.abs(tr.x - stand.x), Math.abs(tr.z - stand.z)) <= 3) { await q.waitTicks(2); continue; }
            await q.opLoc(locOf(L.counter), 1);
            await q.waitUntil(() => q.has(O.cake), 3);
        }
        if (!q.has(O.cake)) await q.fail('rock cake');
    }
    await go('battlement', 2506, 3011, 0);
    await opLocUntil('battlement', L.battlement, () => jumpPocket(), { pats: [/but I am a friend to ogres/i], tries: 8 });
    // 12. The chasm jump (guard4 within 8: "Okay, I'll pay it.", 20 gp) -> the ledge; a death rune on the city guard -> map.
    await go('chasm', 2531, 3026, 0);
    await opLocUntil('chasm jump', L.jump1, () => ledgeBox(), { pats: [/okay, I'll pay it/i], tries: 8 });
    await give('death rune on guard', O.death, N.cityGuard, () => q.has(O.map));
    q.milestone(6);
    // 13. Back: jump2, the battlement west, gate2 out. The death-rune use can leave the bot one row south of the ledge
    // box, so the ledge is also the jump landing's walk region (their fix 180).
    const ledge = () => ledgeBox() || (sameRegion(2530, 3029) && !sameRegion(2549, 3031));
    if (ledge()) await opLocUntil('jump back', L.jump2, () => !ledge());
    if (jumpPocket()) { await go('battlement east', 2508, 3011, 0); await opLocUntil('battlement back', L.battlement, () => x() <= 2506); }
    const gate2Out = async () => {
        await go('gate2 inside', 2503, 3062, 0);
        await opLocUntil('gate2 out', L.gate2, () => x() >= 2504 && z() >= 3060 && z() <= 3070);
    };
    if (wCity()) await gate2Out();

    // 14. Caves (map + a lit light): 5 scared skavid, 4 Cur, 3 Ar, 2 Ig (+ nightshade), 1 Nod.
    if (!q.inv().some((i: any) => LIGHTS.includes(i.id))) await q.fail('no lit light for the caves');
    const cave = async (label: string, entry: L, exit: L, talker: number, pats: RegExp[], done: (m: number) => boolean, pick: number[] = []) => {
        if (!inCaves()) {
            await go(`${label} entry`, entry.x, entry.z, 3);
            await opLocUntil(`${label} in`, entry, () => inCaves(), { ticks: 25 });
        }
        const m0 = mark();
        if (talker) await talk(label, talker, pats, () => done(m0), 120);
        for (const id of pick) if (!q.has(id)) await pickup(`${label} pick ${id}`, id);
        await opLocUntil(`${label} out`, exit, () => !inCaves());
    };
    const understood = (m0: number) => seen(/skavid understood you/i, m0);
    await cave('cave5', L.cave5, L.exit5, N.scared, [/okay, okay, I'm not going to hurt you/i], m0 => seen(/those will gets you started/i, m0));
    await cave('cave4', L.cave4, L.exit4, N.talker3, [/^cur\.$/i], understood);
    await cave('cave3', L.cave3, L.exit3, N.talker2, [/^ar\.$/i], understood);
    await cave('cave2', L.cave2, L.exit2, N.talker1, [/^ig\.$/i], understood, [O.nightshade]);
    await cave('cave1', L.cave1, L.exit1, N.talker4, [/^nod\.$/i], understood);
    q.milestone('skavid');
    // 15. The east gate: the first gold-bar use pushes the bot to the hill (ogre_guard.rs2:21-28), the second lets it in.
    for (let k = 0; k < 3 && !ePocket(); k++) {
        await go('east gate', 2549, 3031, 3);
        const m0 = mark();
        await give('gold to guard1', O.goldBar, N.guard1, () => ePocket() || seen(/pushes you outside/i, m0), [], 3);
        if (!ePocket()) await q.waitTicks(2);
    }
    if (!ePocket()) await q.fail('east gate (gold bar)');
    // 16. Cave 6: the mad skavid's line is random(3); "Ar cur" -> Gor, "Bidith ig" -> Cur, "Cur tanath" -> Bidith. A wrong
    // answer costs nothing: talk again.
    await go('cave6 entry', 2528, 3012, 1);
    await opLocUntil('cave6 in', L.cave6, () => inCaves(), { ticks: 25 });
    for (let k = 0; k < 8 && !q.has(O.c2); k++) {
        await q.guard('mad skavid');
        const m0 = mark();
        const n = npcOf(N.mad);
        if (!n) await q.fail('no mad skavid');
        await q.talkTo(n);
        await q.waitUntil(() => q.dialogOpen(), 25);
        for (let w = 0; w < 40 && !q.has(O.c2); w++) {
            await q.guard('mad skavid');
            const d: any = q.s.sdk.getDialog();
            if (!d?.isOpen) { if (w > 3) break; await q.waitTicks(1); continue; }
            if (d.isWaiting) { await q.waitTicks(1); continue; }
            const opts = (d.options ?? []).filter((o: any) => !/click here to continue/i.test(o.text));
            if (opts.length) {
                const want = seen(/ar cur/i, m0) ? /^gor\.$/i : seen(/bidith ig/i, m0) ? /^cur\.$/i : seen(/cur tanath/i, m0) ? /^bidith\.$/i : /^gor\.$/i;
                const o = opts.find((e: any) => want.test(e.text)) ?? opts[0];
                await q.s.sdk.sendClickDialog(o.index);
            } else await q.s.sdk.sendClickDialog(0);
            await q.waitTicks(1);
        }
        await q.converse([], () => !q.dialogOpen(), 10);
        console.log(`NOTE mad skavid try ${k + 1}: ${q.has(O.c2) ? 'crystal' : 'wrong'}`);
    }
    if (!q.has(O.c2)) await q.fail('mad skavid crystal');
    if (q.cnt(O.nightshade) < 2) await pickup('cave6 nightshade', O.nightshade);
    await opLocUntil('cave6 out', L.exit6, () => !inCaves());
    q.milestone(7);

    // 17. Nightshade on the enclave guard -> the enclave (=8 the first time); out by the enclave cave (-> 2540,3054).
    const enclaveIn = async () => {
        if (inEnclave()) return;
        if (ePocket()) { await go('gate1 inside', 2549, 3027, 0); await opLocUntil('gate1 out', L.gate1out, () => z() >= 3028); }
        if (!q.has(O.nightshade)) await cave('cave2 nightshade', L.cave2, L.exit2, 0, [], () => true, [O.nightshade]);
        if (!wCity()) {
            await toGround();
            await go('gate2 outside', 2504, 3062, 0);
            await opLocUntil('gate2 in', L.gate2, () => x() <= 2503 && z() <= 3063);
        }
        await go('enclave guard', 2508, 3038, 2);
        await give('nightshade on guard', O.nightshade, N.enclaveGuard, () => inEnclave());
    };
    const enclaveOut = async () => { if (inEnclave()) await opLocUntil('enclave exit', L.enclaveExit, () => !inEnclave(), { ticks: 40 }); };
    await enclaveIn();
    await enclaveOut();
    q.milestone(8);

    // 18. Wizard (=9), brew the potion (guam on water, berries on it, the bones used last: ogre_potion.rs2), give it (=10).
    await toTop();
    m = mark();
    await talk('wizard potion', N.wizard, [], () => seen(/brushing up herblore and magic/i, m));
    await q.step('guam vial', () => q.useOnItem(O.guam, O.water), () => q.has(O.guamvial), 6, 3);
    await q.step('janger vial', () => q.useOnItem(O.berries, O.guamvial), () => q.has(O.guamjanger), 6, 3);
    await q.step('ogre potion', () => q.useOnItem(O.batBones, O.guamjanger), () => q.has(O.potion), 6, 3);
    await give('potion on wizard', O.potion, N.wizard, () => q.has(O.magicPotion));
    q.milestone(10);

    // 19. The enclave: the potion on 6 shamans (crystal 3 on the 6th; never talk to one, ogre_shaman.rs2:1-5), the Rock of
    // Dalgroth (op 2, crystal 4), out. Blue dragons share the cave: the anti-dragon shield is worn.
    await toGround();
    await enclaveIn();
    for (let k = 0; k < 40 && !q.has(O.c3); k++) {
        await q.guard('shamans');
        let sh = npcOf(N.shaman);
        if (!sh) { await go('shamans', 2592, 9440, 4); sh = npcOf(N.shaman); }
        if (!sh) { await q.waitTicks(5); continue; }
        if (!q.has(O.magicPotion)) await q.fail('shamans: no magic ogre potion');
        const m0 = mark();
        if (!q.dialogOpen()) await q.useOnNpc(O.magicPotion, sh);
        await q.waitUntil(() => seen(/dissolves/i, m0) || q.has(O.c3), 15);
        await q.converse([], () => !q.dialogOpen(), 15);
        console.log(`NOTE shaman try ${k + 1}: ${seen(/dissolves/i, m0) ? 'dissolved' : 'missed'}`);
    }
    if (!q.has(O.c3)) await q.fail('crystal 3 (6 shamans)');
    await go('rock of dalgroth', 2590, 9448, 2);
    await opLocUntil('rock of dalgroth', L.rock, () => q.has(O.c4), { op: 2, ticks: 15 });
    await enclaveOut();
    q.milestone(11);

    // 20. Wizard (=11: all four crystals), the lever (quest complete), the spell scroll.
    await toTop();
    m = mark();
    await talk('wizard crystals', N.wizard, [], () => seen(/throw the lever|all the crystals|not activated/i, m));
    await opLocUntil('lever', L.lever, () => questDone || q.has(O.scroll), { ticks: 15 });
    await q.waitUntil(() => q.has(O.scroll) && questDone, 15);
    await q.converse([], () => !q.dialogOpen(), 20);
    const sc = q.inv().find((i: any) => i.id === O.scroll);
    if (sc) await q.step('read scroll', async () => {
        const s2 = q.inv().find((i: any) => i.id === O.scroll);
        if (s2) await q.s.direct({ type: 'useInventoryItem', slot: s2.slot, optionIndex: 1, reason: 'SDK' });
        await q.converse([], () => !q.dialogOpen() && !q.has(O.scroll), 10);
    }, () => !q.has(O.scroll) && !q.dialogOpen(), 10, 3);
    q.milestone(14);
    await q.end(questDone, 'qp=4');
} catch (e) {
    await q.fail(`error ${(e as Error).message}`);
}
