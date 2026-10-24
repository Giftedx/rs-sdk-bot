// The Dig Site from preset quest_dig (in the Exam Centre beside the examiner; Haggis at the dig row, tick 28,294:
// Attack 99, Strength 97, Defence 89, Hitpoints 97, Thieving 99, Agility 76, Herblore 99, Fishing 99, Mining 1).
// Helper items (tradeable): cup of tea, opal, 2 ropes, vial, charcoal, pestle and mortar, tinderbox, Varrock Teleport
// runes. Reward: 2 QP, 15,300 Mining and 2,000 Herblore XP (382,500 and 50,000 at x25), 2 gold bars (quest_itexam.rs2:39-46).
// Varp %itexamlevel (131, bits 0-3, not transmitted): 1 letter, 2-4 exams 1-3, 5 expert, 6 permit, 7 compound on the
// bricks, 8 blast, 9 complete. Errands in %itexam_errands (132), 2 bits a student; flags in %itexam_bits (133).
// Server truth: quests/quest_itexam/scripts/ (examiner.rs2, student1-3.rs2, area_digsite.rs2, digsite_workman.rs2,
// arcaeological_expert.rs2, itexam_chemistry.rs2, panning_guide.rs2, private_dig_worker.rs2, area_exam_centre.rs2),
// areas/area_varrock/scripts/curator.rs2. Map: maps/m52_52.jm2, m52_53.jm2 (surface), m52_153.jm2 (caves before the
// blast), m52_152.jm2 (after).
// DIG_FROM=errands|e2|e3|talisman|cave starts at that stage (debug presets quest_dig_<stage>).
import { openQuest, type Loc } from './quest-lib';

const ITEM = {
    tea: 1978, opal: 1609, rope: 954, vial: 229, charcoal: 973, pestle: 233, tinderbox: 590,
    letter: 682, stamped: 683, jar: 669, brush: 670, s1: 671, s2: 672, s3: 673, trowel: 676, tray: 677, trayMud: 679,
    talisman: 681, cert1: 691, cert2: 692, cert3: 693, invite: 696, tablet: 699, powder: 700, nitrate: 701, liquid: 702,
    nitro: 703, ground: 704, mix1: 705, mix2: 706, compound: 707, root: 708, key: 709,
    law: 563, air: 556, fire: 554, lobster: 379,
};
const NPC = { examiner: 618, s1: 615, s3: 616, s2: 617, workman: 613, workman2: 614, expert: 619, guide: 620, curator: 646 };
const EXAMINER = { x: 3361, z: 3341 };
const EXPERT = { x: 3355, z: 3333 };
const CURATOR = { x: 3255, z: 3445 };
const GUIDE = { x: 3376, z: 3377 };
// Student spawns (maps/m52_53.jm2 NPC section); the students wander.
const SPAWNS: Record<number, Array<{ x: number; z: number }>> = {
    [NPC.s1]: [{ x: 3359, z: 3401 }, { x: 3363, z: 3397 }, { x: 3356, z: 3406 }, { x: 3373, z: 3412 }],
    [NPC.s3]: [{ x: 3360, z: 3409 }, { x: 3349, z: 3410 }, { x: 3370, z: 3416 }, { x: 3373, z: 3432 }],
    [NPC.s2]: [{ x: 3364, z: 3410 }, { x: 3358, z: 3420 }, { x: 3348, z: 3424 }, { x: 3367, z: 3432 }],
    [NPC.workman]: [{ x: 3356, z: 3385 }, { x: 3370, z: 3387 }, { x: 3359, z: 3396 }],
};
const L = {
    cupboard: { id: 0, x: 3354, z: 3332 },         // exam centre cupboard, the specimen jar (cupboards.rs2:36)
    bush: { id: 2358, x: 3357, z: 3372 },          // digsitebushsample, rock sample 3 (area_digsite.rs2:79-91)
    barrel: { id: 2359, x: 3364, z: 3378 },        // digbarrelclosed (:801-828)
    chest: { id: 2361, x: 3374, z: 3378 },         // digchestclosed; digchestopen 2360 (:776-795)
    winch1: { id: 2350, x: 3352, z: 3417 },        // -> 3370,9828 (altar cave) or 3370,9764 after the blast (:583-631)
    winch2: { id: 2351, x: 3370, z: 3428 },        // -> 3353,9818 (private dig) (:637-684)
    ladderPriv: { id: 2352, x: 3353, z: 9817 },    // winchladder1 -> 3370,3427 (:693-696)
    ladderAltar: { id: 2353, x: 3370, z: 9827 },   // winchladder2 -> 3354,3417 (:702-705)
    ladderAltarB: { id: 2353, x: 3370, z: 9763 },  // the same ladder in the cave after the blast (maps/m52_152.jm2)
    bricks: { id: 2362, x: 3379, z: 9825 },        // digblastbrick (:707-767)
};
const PAN = [{ x: 3376, z: 3372 }, { x: 3378, z: 3374 }, { x: 3378, z: 3375 }, { x: 3379, z: 3377 }, { x: 3381, z: 3378 }];
// Level 3 site west: zone 0_52_53_22_12 .. 0_52_53_29_20 (area_digsite.rs2:172).
const L3 = { x0: 3350, x1: 3357, z0: 3404, z1: 3412 };
// Items kept; everything else found by panning, pickpocketing or digging is dropped when space runs low.
const KEEP = new Set<number>([ITEM.tea, ITEM.opal, ITEM.rope, ITEM.vial, ITEM.charcoal, ITEM.pestle, ITEM.tinderbox, ITEM.letter,
    ITEM.stamped, ITEM.jar, ITEM.brush, ITEM.s1, ITEM.s2, ITEM.s3, ITEM.trowel, ITEM.tray, ITEM.trayMud, ITEM.talisman,
    ITEM.invite, ITEM.tablet, ITEM.powder, ITEM.nitrate, ITEM.liquid, ITEM.nitro, ITEM.ground, ITEM.mix1, ITEM.mix2,
    ITEM.compound, ITEM.root, ITEM.key, ITEM.law, ITEM.air, ITEM.fire, ITEM.lobster, 995]);

const q = await openQuest({ cap: 6000 });
try {
    let questDone = false;
    // Every game message once, with the script tick it was seen (gameMessages is a short rolling list).
    const seen = new Set<string>();
    const mlog: Array<{ t: number; text: string }> = [];
    const off = q.s.onTick(() => {
        for (const m of (q.st()?.gameMessages ?? []) as any[]) {
            if (m.type !== 0) continue;
            const k = `${m.tick}|${m.observationId ?? ''}|${m.text}`;
            if (seen.has(k)) continue;
            seen.add(k);
            mlog.push({ t: q.T(), text: m.text });
            if (/quest complete/i.test(m.text)) questDone = true;
        }
        // A level-up page blocks the next pan, pickpocket or dig until it is clicked (trial t3 lost 8 ticks a page;
        // Mining goes from 1 to about 30 here). It is clicked the tick it shows.
        const d: any = q.s.sdk.getDialog();
        if (d?.isOpen && !d.isWaiting && /just advanced/i.test([d.text ?? '', ...(d.allComponents ?? []).map((c: any) => c.text ?? '')].join(' '))) void q.s.sdk.sendClickDialog(0);
    });
    // Seen after tick t0 (a message seen in the tick an action was sent belongs to the action before it).
    const msgSince = (re: RegExp, t0: number): boolean => mlog.some(e => e.t > t0 && re.test(e.text));
    const tally = (re: RegExp): string => { const c: Record<string, number> = {}; for (const e of mlog) if (re.test(e.text)) c[e.text] = (c[e.text] ?? 0) + 1; return Object.entries(c).map(([k, v]) => `${k.replace(/^You (find|steal) /, '')}=${v}`).join('; '); };
    const x = (): number => q.pos()?.worldX ?? 0;
    const z = (): number => q.pos()?.worldZ ?? 0;
    const npcs = (id: number): any[] => (q.st()?.nearbyNpcs ?? []).filter((n: any) => n.id === id).sort((a: any, b: any) => a.distance - b.distance);
    const ground = (id: number): any[] => (q.st()?.groundItems ?? []).filter((g: any) => g.id === id).sort((a: any, b: any) => a.distance - b.distance);
    const free = (): number => 28 - q.inv().length;
    const closeDialog = () => q.converse([], () => !q.dialogOpen(), 10);
    const dropJunk = async (keepFree = 4): Promise<void> => {
        if (free() >= keepFree) return;
        for (const it of q.inv().filter(i => !KEEP.has(i.id))) void q.s.direct({ type: 'dropItem', slot: it.slot, reason: 'SDK' });
        await q.waitTicks(1);
    };
    const nearestSpawn = (id: number) => [...(SPAWNS[id] ?? [])].sort((a, b) => q.cheb(a.x, a.z) - q.cheb(b.x, b.z))[0]!;
    // Finds an NPC by type id: the nearest in view, else walks to its spawns in turn.
    const findNpc = async (label: string, id: number, home?: { x: number; z: number }): Promise<any> => {
        if (!npcs(id)[0]) await q.waitUntil(() => !!npcs(id)[0], 3);
        if (npcs(id)[0]) return npcs(id)[0];
        const spots = home ? [home] : [...(SPAWNS[id] ?? [])].sort((a, b) => q.cheb(a.x, a.z) - q.cheb(b.x, b.z));
        for (const sp of spots) {
            await q.walk(`${label} approach`, [{ x: sp.x, z: sp.z, tol: 4 }]);
            if (npcs(id)[0]) return npcs(id)[0];
        }
        if (!npcs(id)[0]) console.log(`WARN ${label}: npcs in view ${(q.st()?.nearbyNpcs ?? []).map((n: any) => `${n.id}:${n.name}@${n.x},${n.z}`).join(' ')}`);
        return npcs(id)[0] ?? q.fail(`${label}: no npc ${id}`);
    };
    // Talk to an NPC by type id (the three students are all "Student"); waits for the dialog, then pages. It returns
    // as soon as ok() holds, with the dialog maybe still open: the next walk or click closes it, and every state change
    // that ok() tests comes before the last pages. A check that needs the last page clicked tests !dialogOpen() itself.
    const talkId = async (label: string, id: number, pats: RegExp[], ok: () => boolean, home?: { x: number; z: number }, maxTicks = 60): Promise<void> => {
        for (let i = 0; i < 4 && !ok(); i++) {
            await q.guard(label);
            if (i > 0) q.stats.retries++;
            const n = await findNpc(label, id, home);
            await q.s.direct({ type: 'interactNpc', npcIndex: n.index, optionIndex: n.optionsWithIndex?.find((o: any) => /talk/i.test(o.text))?.opIndex ?? 1, reason: 'SDK' });
            await q.waitUntil(() => q.dialogOpen(), 20);
            if (!q.dialogOpen()) { console.log(`WARN ${label} no dialog: npc ${n.x},${n.z} me ${x()},${z()} t=${q.T()}`); continue; }
            let shut = 0;
            await q.converse(pats, () => { shut = q.dialogOpen() ? 0 : shut + 1; return ok() || shut >= 2; }, maxTicks);
        }
        if (!ok()) await q.fail(`talk ${label}`);
    };
    // Use an item on an NPC by type id until ok(); the dialog pages are clicked through.
    const useOnId = async (label: string, item: number, id: number, ok: () => boolean, home?: { x: number; z: number }, maxTicks = 40): Promise<void> => {
        for (let i = 0; i < 4 && !ok(); i++) {
            await q.guard(label);
            if (i > 0) q.stats.retries++;
            const n = await findNpc(label, id, home);
            if (!q.has(item)) await q.fail(`${label}: no item ${item}`);
            await q.useOnNpc(item, n);
            await q.waitUntil(() => q.dialogOpen() || ok(), 20);
            let shut = 0;
            await q.converse([], () => { shut = q.dialogOpen() ? 0 : shut + 1; return ok() || shut >= 2; }, maxTicks);
        }
        if (!ok()) await q.fail(`use ${label}`);
    };
    const useLoc = async (label: string, item: number, l: Loc, ok: () => boolean, ticks = 25): Promise<void> => {
        await q.step(label, () => q.useOnLoc(item, l), ok, ticks, 4);
        await closeDialog();
    };
    const pickup = async (label: string, id: number): Promise<void> => {
        await q.step(label, () => { const g = ground(id)[0]; return g ? q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' }) : q.waitTicks(1); }, () => q.has(id), 25, 4);
    };
    const toExaminer = () => q.walk('to examiner', [{ x: EXAMINER.x, z: EXAMINER.z, tol: 3 }]);

    const FROM = process.env.DIG_FROM ?? '';
    const ORDER = ['', 'errands', 'e2', 'e3', 'talisman', 'cave'];
    const at = (stage: string): boolean => ORDER.indexOf(FROM) <= ORDER.indexOf(stage);

    // 1. Letter, stamp, forced first exam (progress 1, 2).
    if (at('')) {
        // The specimen jar from the cupboard beside the expert (no stage check, area_exam_centre.rs2:22-28).
        await q.walk('to cupboard', [{ x: 3355, z: 3333, tol: 1 }]);
        for (let i = 0; i < 6 && !q.has(ITEM.jar); i++) {
            const c = q.findLoc(l => l.x === L.cupboard.x && l.z === L.cupboard.z && /cupboard/i.test(l.name));
            if (!c) { console.log(`WARN no cupboard; locs ${q.locs().filter((l: any) => l.distance < 4).map((l: any) => `${l.name}@${l.x},${l.z}`).join(' ')}`); break; }
            await q.opLoc(c, q.opIndex(c, /search|open/i));
            await q.waitUntil(() => q.has(ITEM.jar) || q.dialogOpen(), 6);
            await closeDialog();
        }
        if (!q.has(ITEM.jar)) await q.fail('specimen jar');
        q.milestone('jar');
        await talkId('examiner 1', NPC.examiner, [/can i take an exam/i], () => q.has(ITEM.letter), EXAMINER, 60);
        q.milestone(1);
        await q.teleport('varrock teleport', 'magic:varrock_teleport', 3212, 3424);
        await q.walk('to curator', [{ x: CURATOR.x, z: CURATOR.z - 2, tol: 2 }]);
        await talkId('curator', NPC.curator, [], () => q.has(ITEM.stamped), CURATOR, 40);
        q.milestone('stamped');
        // Out by the museum's west door and the Varrock street to the east gate: lockeddoor1 (1591 at 3268,3435,
        // maps/m51_53.jm2) is on the SDK's shortest path and stays shut ("The door is locked tight"; trial t1 lost 241
        // ticks there).
        await q.walk('museum to exam centre', [{ x: 3244, z: 3439, tol: 2 }, { x: 3241, z: 3431, tol: 2 }, { x: 3272, z: 3430, tol: 2 },
            { x: 3289, z: 3400, tol: 3 }, { x: 3308, z: 3346, tol: 3 }, { x: EXAMINER.x, z: EXAMINER.z, tol: 3 }]);
        // The stamped letter starts exam 1 at once; with no errands done it cannot pass (examiner.rs2:68-77, 256-270).
        // The stage is set before the questions, so the bot walks away from them.
        await talkId('examiner 2', NPC.examiner, [/vegetarianism/i, /small pink fish/i, /rubber chickens/i], () => !q.has(ITEM.stamped), EXAMINER, 80);
        q.milestone(2);
    }

    // 2. Exam 1 errands: rock sample 3 (bush), 2 (panning), 1 (pickpocket); the brush too.
    if (at('errands')) {
        if (!q.has(ITEM.s3)) {
            await q.walk('to bush', [{ x: L.bush.x, z: L.bush.z + 1, tol: 1 }]);
            await q.step('bush', () => q.opLoc(L.bush, 1), () => q.has(ITEM.s3) || q.dialogOpen(), 12, 4);
            await q.converse([], () => q.has(ITEM.s3), 8);
        }
        q.milestone('s3');
        // The panning guide takes the tea (panning_guide.rs2:166-181); the tray lies at 3369,3378 (maps/m52_52.jm2 OBJ).
        await q.walk('to guide', [{ x: GUIDE.x - 2, z: GUIDE.z, tol: 2 }]);
        if (q.has(ITEM.tea)) await talkId('panning guide', NPC.guide, [/how do i become invited/i], () => !q.has(ITEM.tea), GUIDE, 40);
        if (!q.has(ITEM.tray) && !q.has(ITEM.trayMud)) await pickup('tray', ITEM.tray);
        q.milestone('tea');
        // Pan and search until rock sample 2: 3 in 40 a search (area_digsite.rs2:40-69).
        // The next action is sent as soon as the tray changes; the objbox is clicked only when that action is dropped.
        let pans = 0, dropped = 0;
        // The panning point's only op is op1 "Look" (all.loc), which runs [oploc1,panning_point].
        const pan = () => q.findLoc(l => PAN.some(t => t.x === l.x && t.z === l.z) && /panning point/i.test(l.name)) ?? q.findLoc(l => /panning point/i.test(l.name));
        for (let i = 0; i < 400 && !q.has(ITEM.s2); i++) {
            await q.guard('panning');
            await dropJunk(3);
            if (q.has(ITEM.trayMud)) {
                await q.s.direct({ type: 'useInventoryItem', slot: q.slot(ITEM.trayMud)!, optionIndex: 2, reason: 'SDK' });
                await q.waitUntil(() => q.has(ITEM.tray), 4);
                if (!q.has(ITEM.tray)) { dropped++; await closeDialog(); }
                continue;
            }
            const p = pan();
            if (!p) { console.log(`WARN no panning point near ${x()},${z()}`); await q.walk('to pan', [{ x: 3377, z: 3374, tol: 1 }]); continue; }
            pans++;
            await q.opLoc(p, 1);
            await q.waitUntil(() => q.has(ITEM.trayMud), 10);
            if (!q.has(ITEM.trayMud)) { dropped++; await closeDialog(); }
        }
        if (!q.has(ITEM.s2)) await q.fail('rock sample 2');
        console.log(`PANS ${pans} dropped=${dropped} FINDS ${tally(/within the mud|rock sample|plain mud/i)}`);
        q.milestone('s2');
        // Pickpocket a workman until rock sample 1 and a specimen brush (digsite_workman.rs2:48-116).
        let picks = 0;
        for (let i = 0; i < 60 && !(q.has(ITEM.s1) && q.has(ITEM.brush)); i++) {
            await q.guard('pickpocket');
            await dropJunk(3);
            const n = await findNpc('workman', NPC.workman);
            picks++;
            const t0 = q.T(), had = q.has(ITEM.s1);
            await q.s.direct({ type: 'interactNpc', npcIndex: n.index, optionIndex: n.optionsWithIndex?.find((o: any) => /pickpocket/i.test(o.text))?.opIndex ?? 3, reason: 'SDK' });
            // The rock sample comes with an objbox and no game message; the other results are messages.
            await q.waitUntil(() => msgSince(/^you (steal|find a specimen|fail)/i, t0) || (!had && q.has(ITEM.s1)), 10);
            if (q.dialogOpen()) await closeDialog();
            // A failed pick stuns for 8 ticks (:67-81).
            if (msgSince(/fail to pick/i, t0)) await q.waitTicks(7);
        }
        if (!(q.has(ITEM.s1) && q.has(ITEM.brush))) await q.fail('pickpocket');
        console.log(`PICKS ${picks} FINDS ${tally(/^you (steal|find a specimen|fail)/i)}`);
        q.milestone('s1');
        // Each sample used on its student finishes the errand with no stage check (student1-3.rs2 opnpcu).
        await useOnId('student 1 sample', ITEM.s1, NPC.s1, () => !q.has(ITEM.s1));
        await useOnId('student 3 sample', ITEM.s2, NPC.s3, () => !q.has(ITEM.s2));
        await useOnId('student 2 sample', ITEM.s3, NPC.s2, () => !q.has(ITEM.s3));
        q.milestone('errands');
        await toExaminer();
        await talkId('exam 1', NPC.examiner, [/yes, i certainly am/i, /study of the earth, its contents/i, /all that have passed the appropriate/i, /gloves and boots to be worn/i],
            () => q.has(ITEM.trowel) && q.has(ITEM.cert1), EXAMINER, 80);
        q.milestone(3);
    }

    // 3. Exam 2: one talk with each student (the tips set the errands, student1-3.rs2); the barrel's liquid on the way.
    if (at('e2')) {
        if (!q.has(ITEM.liquid) && !q.has(ITEM.nitro) && !q.has(ITEM.mix1) && !q.has(ITEM.mix2) && !q.has(ITEM.compound)) {
            await q.walk('to barrel', [{ x: L.barrel.x, z: L.barrel.z - 1, tol: 1 }]);
            await useLoc('barrel open', ITEM.trowel, L.barrel, () => q.sawText(/it's opened it/i), 20);
            await useLoc('barrel vial', ITEM.vial, L.barrel, () => q.has(ITEM.liquid), 20);
            q.milestone('liquid');
        }
        await talkId('student 1 tip 2', NPC.s1, [], () => q.sawText(/correct rockpick usage/i));
        await talkId('student 3 tip 2', NPC.s3, [], () => q.sawText(/correct sample transportation/i));
        await talkId('student 2 tip 2', NPC.s2, [], () => q.sawText(/finds handling/i));
        await toExaminer();
        await talkId('exam 2', NPC.examiner, [/ready for the next exam/i, /rough form; kept only in sealed/i, /carefully handled, and gloves worn/i, /strike cleanly on its cleaving point/i],
            () => q.has(ITEM.cert2), EXAMINER, 80);
        q.milestone(4);
        // The expert names the liquid: nitroglycerin (arcaeological_expert.rs2:176-182).
        if (q.has(ITEM.liquid)) await useOnId('expert liquid', ITEM.liquid, NPC.expert, () => q.has(ITEM.nitro), EXPERT);
        if (q.has(ITEM.charcoal) && q.has(ITEM.pestle)) await q.step('grind charcoal', () => q.useOnItem(ITEM.pestle, ITEM.charcoal), () => q.has(ITEM.ground), 4, 4);
    }

    // 4. Exam 3: student 2 wants an opal (student2.rs2:253-283).
    if (at('e3')) {
        await talkId('student 2 opal ask', NPC.s2, [], () => (q.sawText(/turn up for you/i) || q.sawText(/did you bring me the opal/i)) && !q.dialogOpen());
        await talkId('student 2 opal', NPC.s2, [], () => !q.has(ITEM.opal) && q.sawText(/samples cleaned and carried only in specimen jars/i));
        await talkId('student 1 tip 3', NPC.s1, [], () => q.sawText(/specimen brush use:/i));
        await talkId('student 3 tip 3', NPC.s3, [], () => q.sawText(/technique for handling bones is/i));
        await toExaminer();
        await talkId('exam 3', NPC.examiner, [/ready for the last exam/i, /cleaned, and carried only in specimen jars/i, /carefully and slowly using short strokes/i, /handle bones very carefully/i],
            () => q.has(ITEM.cert3), EXAMINER, 80);
        q.milestone(5);
    }

    // 5. The talisman: a trowel on level 3 soil, with the jar and the brush; 1 in 20 a dig (area_digsite.rs2:400-454).
    if (at('talisman')) {
        await q.walk('to level 3 site', [{ x: 3354, z: 3403, tol: 1 }]);
        let digs = 0;
        for (let i = 0; i < 300 && !q.has(ITEM.talisman); i++) {
            await q.guard('dig');
            await dropJunk(3);
            const soil = q.findLoc(l => /soil/i.test(l.name) && l.x >= L3.x0 && l.x <= L3.x1 && l.z >= L3.z0 && l.z <= L3.z1);
            if (!soil) { console.log(`WARN no soil near ${x()},${z()}`); await q.walk('to soil', [{ x: 3353, z: 3406, tol: 1 }]); continue; }
            digs++;
            if (digs % 20 === 0) console.log(`DIGS ${digs} t=${q.T()} inv=${q.inv().map(i => i.id).join(',')} FINDS ${tally(/^you find|strange talisman/i)}`);
            // The next dig is sent the tick the find shows; a level-up page there is clicked by the tick hook. A dig that
            // gets no "You dig through the earth..." in 3 ticks was dropped (trial d2: 4 ticks lost a level-up) and is sent again.
            const t0 = q.T();
            await q.useOnLoc(ITEM.trowel, soil);
            await q.waitUntil(() => msgSince(/you dig through the earth/i, t0), 3);
            if (!msgSince(/you dig through the earth/i, t0)) {
                q.stats.retries++;
                const d: any = q.s.sdk.getDialog();
                if (d?.isOpen && !d.isWaiting) await q.s.sdk.sendClickDialog(0);
                await q.useOnLoc(ITEM.trowel, soil);
                await q.waitUntil(() => msgSince(/you dig through the earth/i, t0), 8);
            }
            await q.waitUntil(() => msgSince(/^you find|clean your find/i, t0) || q.has(ITEM.talisman), 10);
            if (q.has(ITEM.talisman)) await closeDialog();
        }
        if (!q.has(ITEM.talisman)) await q.fail('talisman');
        console.log(`DIGS ${digs} FINDS ${tally(/^you find|strange talisman/i)}`);
        q.milestone('talisman');
        await useOnId('expert talisman', ITEM.talisman, NPC.expert, () => q.has(ITEM.invite), EXPERT, 60);
        // Any surface workman takes the letter and gives the permit (digsite_workman.rs2:118-126).
        await useOnId('workman permit', ITEM.invite, NPC.workman, () => !q.has(ITEM.invite));
        q.milestone(6);
    }

    // 6. The private dig: the chest key and an arcenia root; the chest's powder; the expert; the compound.
    if (at('cave')) {
        await q.walk('to winch 2', [{ x: L.winch2.x, z: L.winch2.z - 1, tol: 1 }]);
        await useLoc('rope winch 2', ITEM.rope, L.winch2, () => q.sawText(/tie the rope/i) || q.msgCount(/tie the rope/i) > 0, 20);
        await q.step('winch 2 down', () => q.opLoc(L.winch2, 1), () => z() > 9000, 15, 4);
        q.milestone('private');
        await talkId('workman 2 key', NPC.workman2, [/invited to research here/i, /find a chest key/i, /don't suppose i could use it/i, /^please\?$/i, /aww\.\.\. go on/i, /^pretty please!$/i, /sugar on top/i],
            () => q.has(ITEM.key), { x: 3352, z: 9820 }, 80);
        if (!q.has(ITEM.root)) {
            const r = ground(ITEM.root)[0];
            console.log(`ROOTS ${ground(ITEM.root).map((g: any) => `${g.x},${g.z} r=${g.reachable}`).join(' ')} TABLETS ${ground(ITEM.tablet).map((g: any) => `${g.x},${g.z} r=${g.reachable}`).join(' ')}`);
            if (r) await pickup('root', ITEM.root);
        }
        await q.climb('private ladder up', () => q.locAt(L.ladderPriv.x, L.ladderPriv.z), /climb/i, () => z() < 9000);
        q.milestone('key');
        await q.walk('to chest', [{ x: L.chest.x - 1, z: L.chest.z, tol: 1 }]);
        await useLoc('chest key', ITEM.key, L.chest, () => !q.has(ITEM.key), 20);
        await q.step('chest search', () => { const c = q.locAt(L.chest.x, L.chest.z) ?? { id: 2360, x: L.chest.x, z: L.chest.z }; return q.opLoc(c, q.opIndex(c, /search/i)); }, () => q.has(ITEM.powder), 15, 4);
        await closeDialog();
        q.milestone('powder');
        if (!q.has(ITEM.nitro) && q.has(ITEM.liquid)) await useOnId('expert liquid', ITEM.liquid, NPC.expert, () => q.has(ITEM.nitro), EXPERT);
        await useOnId('expert powder', ITEM.powder, NPC.expert, () => q.has(ITEM.nitrate), EXPERT);
        // The compound (itexam_chemistry.rs2): nitroglycerin into the nitrate, ground charcoal, the root.
        if (!q.has(ITEM.ground)) await q.step('grind charcoal', () => q.useOnItem(ITEM.pestle, ITEM.charcoal), () => q.has(ITEM.ground), 4, 4);
        await q.step('mix 1', () => q.useOnItem(ITEM.nitro, ITEM.nitrate), () => q.has(ITEM.mix1), 4, 4);
        await q.step('mix 2', () => q.useOnItem(ITEM.ground, ITEM.mix1), () => q.has(ITEM.mix2), 4, 4);
        if (!q.has(ITEM.root)) await q.fail('no arcenia root');
        await q.step('mix 3', () => q.useOnItem(ITEM.root, ITEM.mix2), () => q.has(ITEM.compound), 4, 4);
        await closeDialog();
        q.milestone('compound');
        // 7. The altar cave: the compound on the bricks, the tinderbox from 3379,9826 (area_digsite.rs2:714-767).
        await q.walk('to winch 1', [{ x: L.winch1.x + 1, z: L.winch1.z, tol: 1 }]);
        await useLoc('rope winch 1', ITEM.rope, L.winch1, () => q.msgCount(/tie the rope/i) >= 2 || q.cnt(ITEM.rope) === 0, 20);
        await q.step('winch 1 down', () => q.opLoc(L.winch1, 1), () => z() > 9000, 15, 4);
        q.milestone('altar');
        console.log(`TABLETS ${ground(ITEM.tablet).map((g: any) => `${g.x},${g.z} r=${g.reachable}`).join(' ')}`);
        await q.walk('to bricks', [{ x: L.bricks.x, z: L.bricks.z + 1, tol: 0 }]);
        await useLoc('compound', ITEM.compound, L.bricks, () => !q.has(ITEM.compound), 20);
        q.milestone(7);
        if (!(x() === L.bricks.x && z() === L.bricks.z + 1)) await q.dash('blast tile', L.bricks.x, L.bricks.z + 1, 0, 15);
        await q.step('tinderbox', () => q.useOnLoc(ITEM.tinderbox, L.bricks), () => z() < 9792 && z() > 9000, 30, 3);
        await closeDialog();
        q.milestone(8);
        // The stone tablet lies at 3374,9747 (maps/m52_152.jm2 OBJ), past the blown bricks (3379,9761).
        await q.walk('to tablet', [{ x: 3379, z: 9758, tol: 1 }, { x: 3374, z: 9748, tol: 1 }]);
        await pickup('tablet', ITEM.tablet);
        q.milestone('tablet');
        await q.walk('to ladder', [{ x: 3379, z: 9758, tol: 1 }, { x: L.ladderAltarB.x, z: L.ladderAltarB.z + 1, tol: 1 }]);
        await q.climb('altar ladder up', () => q.locAt(L.ladderAltarB.x, L.ladderAltarB.z) ?? L.ladderAltarB, /climb/i, () => z() < 9000);
        await useOnId('expert tablet', ITEM.tablet, NPC.expert, () => questDone || !q.has(ITEM.tablet), EXPERT, 60);
        await q.waitUntil(() => questDone, 10);
        await closeDialog();
        q.milestone(9);
    }
    off();
    await q.end(questDone, 'qp=2');
} catch (e) { await q.fail(String(e)); }
