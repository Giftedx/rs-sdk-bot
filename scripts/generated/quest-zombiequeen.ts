// Shilo Village from preset quest_zombiequeen (beside Mosol Rei, east of the Shilo gates; every skill 99; Jungle Potion
// done; spade, lit candle, rope, chisel, bronze wire, 3 bones and 14 sharks from a helper). Reward: 2 QP, 3,875
// Crafting XP before 25x (quests/quest_zombiequeen/scripts/quest_zombiequeen.rs2:1630-1635).
// Varps: %zombiequeen (116) 1 started, 4 dug, 5 lit, 6 roped, 7 in Ah Za Rhoon, 8 left it, 9 Bervirius' tomb, 10 bone
// door unlocked, 11 beads gate, 12 tomb door, 14 corpse, 15 complete (quest_zombiequeen.constant, quest.constant:62);
// %zq_map_mechanisms (117) bits: 2 dolmen notes, 4 door found, 5 and 6 scrolls read, 7-8 bones in the door, 9-11
// Nazastarool forms.
// Agility rolls here are stat_random(agility, 70-170, 250-253) on 256: at level 99 each still fails about 1 time in 100,
// so every obstacle is retried.
// Server truth: quests/quest_zombiequeen/scripts/*.rs2, areas/area_karamja/scripts/trufitus.rs2.
// ZQ_FROM=<stage> starts at a debug preset (packages/practice/src/presets-long.ts).
import { openQuest } from './quest-lib';

const ITEM = { belt: 625, spade: 952, candle: 33, rope: 954, chisel: 1755, wire: 1794, bones: 526, zbones: 610,
    shard: 604, key: 605, tattered: 607, crumpled: 608, pommel: 623, crystal: 611, notes: 624, ibeads: 618,
    dbeads: 616, corpse: 609 };
const FOOD = [385, 379];
const MOSOL = { x: 2883, z: 2951 };
const TRUFITUS = { x: 2809, z: 3086 };
const MOUND = { x: 2921, z: 2999 };                     // ahzarhoon_entrance 2217 (maps/m45_46.jm2)
const RUBBLE_UP = { x: 2887, z: 9373 };                  // secretrubble 2220: z > 9344 -> 2888,9283 (:826-835)
const RUBBLE_DN = { x: 2886, z: 9283 };                  // secretrubble 2220: -> 2887,9374
const BOOK = { id: 2222, x: 2885, z: 9317 };             // secretrubblebook: the tattered scroll (:837-860)
const SACKS = { id: 2223, x: 2939, z: 9285 };            // zqsacks: the crumpled scroll (:882-892)
const GALLOWS = { id: 2224, x: 2934, z: 9325 };          // zqgallows: Zadimus' remains (:922-943)
const FALLS = { id: 2225, x: 2940, z: 9349 };            // zqwaterfallrocks: out to 2929,2947 (:977-1055)
const CLIMB = { id: 2231, x: 2794, z: 2979 };            // zqclimbingrocks: from the east, 2 tiles west (:519-559)
const CAIRN = { id: 2234, x: 2762, z: 2990 };            // zqrocks: crawl to 2760,9389 (:613-649)
const DOLMEN = { id: 2235, x: 2766, z: 9364 };           // zqdolmen 2x2 (:1079-1143)
const HOLDS = { id: 2236, x: 2765, z: 9376 };            // zqhandholds: out to 2764,2976 (:1313-1332)
const SACRED = { x: 2796, z: 3088 };                     // bury zone 2794-2798, 3087-3090 (:951)
const TREES = { id: 2237, x: 2915, z: 3092 };            // zqquest_hidytree: reveals the doors (:135-146)

const FROM = process.env.ZQ_FROM ?? 'start';
const STAGES = ['start', 'mound', 'azr', 'cairn', 'bury', 'door', 'tomb', 'final'];
const from = (s: string) => STAGES.indexOf(FROM) <= STAGES.indexOf(s);

const q = await openQuest({ cap: 9000, eatAt: 45, food: FOOD });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete|completed the shilo village/i) > 0) questDone = true; });
    const x = () => q.pos()?.worldX ?? 0;
    const z = () => q.pos()?.worldZ ?? 0;
    // A game message of type 0 at or after tick t (the buffer is capped, so counts can stay flat).
    const msgSince = (re: RegExp, t: number) => (q.st()?.gameMessages ?? []).some((m: any) => m.type === 0 && m.tick >= t && re.test(m.text));
    const invOp = (id: number, re: RegExp) => {
        const it = q.inv().find((i: any) => i.id === id);
        const op = (it?.optionsWithIndex ?? []).find((o: any) => re.test(o.text))?.opIndex ?? 1;
        return q.s.direct({ type: 'useInventoryItem', slot: it?.slot ?? 0, optionIndex: op, reason: 'SDK' });
    };
    const wield = async (label: string, id: number) => {
        await q.step(label, () => invOp(id, /wield|wear/i), () => !q.has(id), 4, 3);
    };
    const loc = (l: { id: number; x: number; z: number }) => q.locAt(l.x, l.z) ?? q.findLoc((k: any) => k.id === l.id && Math.abs(k.x - l.x) <= 2 && Math.abs(k.z - l.z) <= 2) ?? l;
    // One dialog page per tick; pats in priority order (the first pattern that matches any option wins: Mosol's
    // menus offer "What can we do?" again beside the next step, mosol_rei.rs2:57).
    const answer = async (pats: RegExp[], ok: () => boolean, maxTicks: number) => {
        for (let i = 0; i < maxTicks && !q.stats.died; i++) {
            if (ok()) return true;
            const d: any = q.s.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) {
                const opts: any[] = d.options ?? [];
                let opt: any;
                for (const re of pats) { opt = opts.find((o: any) => re.test(o.text)); if (opt) break; }
                if (opts.some((o: any) => !/click here to continue/i.test(o.text)) && !opt) console.log(`WARN no option match: ${opts.map((o: any) => o.text).join(' | ')}`);
                void q.s.sdk.sendClickDialog(opt ? opt.index : 0);
            }
            await q.waitTicks(1);
        }
        return ok();
    };
    // The Undead Ones (level 61) underground attack on sight; a hit during a mesbox drops the click that resumes it
    // (trial t6: 4 rubble searches, the choice never opened), so the bot kills any within 5 tiles that has a target first.
    const clearUndead = async (label: string) => {
        for (let k = 0; k < 6; k++) {
            const n = (q.st()?.nearbyNpcs ?? []).filter((m: any) => /^undead one$/i.test(m.name) && m.distance <= 5 && (m.targetIndex ?? -1) >= 0).sort((a: any, b: any) => a.distance - b.distance)[0];
            if (!n) return;
            for (let j = 0; j < 8 && (q.st()?.nearbyNpcs ?? []).some((m: any) => m.index === n.index); j++) {
                await q.guard(label);
                await q.s.bot.attack(n as any);
                await q.waitUntil(() => !(q.st()?.nearbyNpcs ?? []).some((m: any) => m.index === n.index), 6);
            }
            await q.waitTicks(1);
        }
    };
    // Sends an action, then answers its dialog with pats until ok(); retried.
    const act = async (label: string, send: () => unknown, pats: RegExp[], ok: () => boolean, ticks = 25, tries = 5) => {
        for (let i = 0; i < tries && !ok(); i++) {
            await q.guard(label);
            if (z() > 9000) await clearUndead(label);
            if (i > 0) q.stats.retries++;
            await send();
            await answer(pats, ok, ticks);
        }
        await answer([], () => !q.dialogOpen(), 8);
        if (!ok()) await q.fail(label);
    };
    const drop = async (label: string, ids: number[]) => {
        for (let i = 0; i < 6 && ids.some(id => q.has(id)); i++) {
            const it = q.inv().find((e: any) => ids.includes(e.id));
            if (it) await q.s.direct({ type: 'dropItem', slot: it.slot, reason: 'SDK' });
            await q.waitTicks(1);
        }
        if (ids.some(id => q.has(id))) console.log(`WARN drop ${label}`);
    };
    const PFM = 14;
    const pfm = async (on: boolean) => {
        const pr: any = q.st()?.prayers;
        if (!!pr?.activePrayers?.[PFM] === on || (on && (pr?.prayerPoints ?? 0) <= 0)) return;
        await q.step(`pfm ${on}`, () => q.s.direct({ type: 'togglePrayer', prayerIndex: PFM, reason: 'SDK' }), () => !!(q.st() as any)?.prayers?.activePrayers?.[PFM] === on, 3, 3);
    };
    const topUp = async (hpTo: number) => {
        for (let i = 0; i < 8 && q.hp() < hpTo; i++) {
            const f = q.inv().find((e: any) => FOOD.includes(e.id));
            if (!f) break;
            await q.s.direct({ type: 'useInventoryItem', slot: f.slot, optionIndex: 1, reason: 'SDK' });
            await q.waitTicks(3);
        }
    };
    const worn = (id: number) => (q.st()?.equipment ?? []).some((e: any) => e.id === id);
    // The jungle north-east of Shilo (the mound, the waterfall's north exit, Rashiliyia's doors) is cut off by vines
    // and trees; the stepping stones (zqrockjump 2333-2335 at 2925,2948-2950) cross the river, 1 tile per Cross
    // (skill_agility/scripts/shortcuts.rs2:228-271; a slip washes the bot back to the bank, so it tries again).
    const stones = async (north: boolean) => {
        let started = false;
        const done = () => started && (north ? z() >= 2951 : z() <= 2947);
        await q.walk(`to stones ${north ? 'n' : 's'}`, [{ x: 2925, z: north ? 2947 : 2951, tol: 0 }]);
        started = true;
        for (let i = 0; i < 16 && !done(); i++) {
            await q.guard('stones');
            if (x() !== 2925 || (north ? z() < 2947 : z() > 2951)) {
                // A slip swims the bot about 6 ticks and leaves it on the far bank at x 2931 (shortcuts.rs2:245-268).
                await q.waitTicks(8);
                if (done()) break;
                await q.walk('stones bank', [{ x: 2925, z: north ? 2947 : 2951, tol: 0 }]);
                continue;
            }
            const nz = z() + (north ? 1 : -1);
            const st = q.findLoc((l: any) => l.id >= 2333 && l.id <= 2335 && l.x === 2925 && l.z === nz);
            const z0 = z();
            if (st) await q.opLoc(st, 1);
            else await q.s.direct({ type: 'walkTo', x: 2925, z: nz, running: false, reason: 'SDK' });
            await q.waitUntil(() => z() !== z0 && !q.pos()?.isMoving, 8);
            await q.waitTicks(1);
        }
        if (!done()) await q.fail('stones');
    };
    // Cairn Isle: the climbing rocks from the east (2 columns, x 2794 and 2792), the log bridge west along z 2979
    // (a timer rolls Agility every 20 ticks on it, :561-608), the stacked rocks; "Yes Please" crawls to 2760,9389.
    // A fall (:563-605) drags the bot to the east bank near 2782,2971, on the far side of the climbing rocks, so a walk
    // to the bridge's far end has no route: false means it fell and is on that bank.
    const crossBridge = async (tx: number, tz: number, tol: number): Promise<boolean> => {
        const t0 = q.s.tick();
        for (let i = 0; i < 40 && !q.near(tx, tz, tol); i++) {
            await q.guard('cairn bridge');
            if (msgSince(/^you fall!/i, t0)) {
                await q.waitUntil(() => msgSince(/nearly drowned/i, t0), 30);
                await q.waitTicks(2);
                return false;
            }
            if (i % 5 === 0) await q.s.direct({ type: 'walkTo', x: tx, z: tz, running: true, reason: 'SDK' });
            await q.waitTicks(1);
        }
        if (!q.near(tx, tz, tol + 1)) await q.fail('cairn bridge');
        return true;
    };
    const toBervirius = async () => {
        for (let crossed = false, k = 0; !crossed; k++) {
            if (k >= 5) await q.fail('cairn bridge falls');
            await q.walk('to cairn rocks', [{ x: CLIMB.x + 2, z: CLIMB.z, tol: 0 }]);
            for (let i = 0; i < 8 && x() > 2791; i++) {
                await q.guard('cairn climb');
                const t0 = q.s.tick();
                const lx = x() > 2794 ? 2794 : 2792;
                const r = q.findLoc((l: any) => l.id === CLIMB.id && l.x === lx && l.z === z()) ?? q.findLoc((l: any) => l.id === CLIMB.id && l.x === lx) ?? { id: CLIMB.id, x: lx, z: CLIMB.z };
                await q.opLoc(r, 1);
                await q.waitUntil(() => x() <= lx - 1 || msgSince(/fall and hurt/i, t0), 12);
                await q.waitTicks(1);
            }
            if (x() > 2791) await q.fail('cairn climb');
            crossed = await crossBridge(2770, 2979, 1);
        }
        await q.walk('to stacked rocks', [{ x: 2762, z: 2989, tol: 1 }]);
        await act('crawl', () => q.opLoc(loc(CAIRN), 2), [/yes please/i], () => z() > 9000, 25, 6);
    };

    // Off Cairn Isle: the bridge east, then the climbing rocks from the west side jump 4 tiles east (:544-558).
    const fromCairn = async () => {
        await q.walk('cairn bridge back', [{ x: 2770, z: 2979, tol: 1 }]);
        if (!await crossBridge(2791, 2979, 0)) return;   // the bank is already east of the rocks
        for (let i = 0; i < 6 && x() < 2795; i++) {
            await q.guard('cairn climb back');
            if (x() !== 2791 || z() !== 2979) await q.walk('cairn rocks west', [{ x: 2791, z: 2979, tol: 0 }]);
            const r = q.findLoc((l: any) => l.id === CLIMB.id && l.x === 2792 && l.z === 2979) ?? { id: CLIMB.id, x: 2792, z: 2979 };
            await q.opLoc(r, 1);
            await q.waitUntil(() => x() >= 2795, 12);
            await q.waitTicks(1);
        }
        if (x() < 2795) await q.fail('cairn climb back');
    };
    if (from('start')) {
        // 1. Mosol Rei: "Why do I need to run?" > "Rashiliyia? Who is she?" > "What can we do?" > "I'll go to see the
        // Shaman." > "Yes, I'm sure..." gives the Wampum belt (mosol_rei.rs2:21-107).
        await q.walk('to mosol', [{ x: MOSOL.x + 1, z: MOSOL.z, tol: 3 }]);
        await act('mosol', () => { const n = q.npc(/^mosol rei$/i); return n ? q.talkTo(n) : q.waitTicks(1); },
            [/yes, i.m sure/i, /go to see the shaman/i, /what can we do/i, /rashiliyia\? who is she/i, /why do i need to run/i], () => q.has(ITEM.belt), 120, 3);
        q.milestone('belt');
        // 2. Trufitus: the belt on him > "Mosol Rei said something about a legend?" > "Why was it called Ah Za
        // Rhoon?" > "I am going to search for Ah Za Rhoon!" > "Yes, I will seriously look..." sets 1 and takes the
        // belt (trufitus.rs2:85-89, 500-543).
        await q.walk('to trufitus', [{ x: TRUFITUS.x + 1, z: TRUFITUS.z, tol: 3 }]);
        await act('trufitus', () => { const n = q.npc(/^trufitus$/i); return n ? q.useOnNpc(ITEM.belt, n) : q.waitTicks(1); },
            [/yes, i will seriously look/i, /going to search for ah za rhoon/i, /why was it called ah za rhoon/i, /mosol rei said something about a legend/i],
            () => !q.has(ITEM.belt), 120, 3);
        q.milestone(1);
    }
    if (from('mound')) {
        // 3. The mound: Search sets 3; the spade digs it to the fissure (4); the lit candle into the fissure (5); the
        // rope on the fissure (6); Search > "Yes, I'll give it a go!" lowers the bot into Ah Za Rhoon (7; Agility
        // 32), 2898,9401 (quest_zombiequeen.rs2:329-483).
        if (from('start')) await stones(true);
        await q.walk('to mound', [{ x: MOUND.x, z: MOUND.z - 2, tol: 2 }]);
        const mound = () => q.findLoc((l: any) => l.id >= 2217 && l.id <= 2219 && Math.abs(l.x - MOUND.x) <= 1 && Math.abs(l.z - MOUND.z) <= 1) ?? { id: 2217, x: MOUND.x, z: MOUND.z };
        let t0 = q.s.tick();
        await act('search mound', () => q.opLoc(mound(), 2), [], () => q.sawText(/may need some tools/i) || msgSince(/start digging/i, t0), 10, 3);
        t0 = q.s.tick();
        await act('dig', () => q.useOnLoc(ITEM.spade, mound()), [], () => msgSince(/might just be able to crawl/i, t0) || q.sawText(/already excavated/i), 15, 3);
        await act('candle', () => q.useOnLoc(ITEM.candle, mound()), [], () => !q.has(ITEM.candle), 15, 3);
        await act('rope', () => q.useOnLoc(ITEM.rope, mound()), [], () => !q.has(ITEM.rope), 15, 3);
        q.milestone(6);
        await act('fissure', () => q.opLoc(mound(), 2), [/give it a go/i], () => z() > 9000, 25, 4);
        q.milestone(7);
        await drop('spade', [ITEM.spade]);
    }
    if (from('azr')) {
        // 4. Ah Za Rhoon: the rubble (2887,9373) to the lower cave; the hidden bookcase gives the tattered scroll, the
        // sacks the crumpled scroll, the gallows Zadimus' remains; both scrolls read (bits 5 and 6); the rubble back
        // up; the waterfall path out to the jungle (8 on leaving, :1057-1064).
        await q.walk('to rubble', [{ x: RUBBLE_UP.x + 2, z: RUBBLE_UP.z, tol: 0 }]);
        const rubble = () => q.findLoc((l: any) => l.id === 2220) ?? { id: 2220, ...RUBBLE_UP };
        await act('rubble down', () => { const r = rubble(); console.log(`DBG rubble ${JSON.stringify({ x: r.x, z: r.z, ops: r.optionsWithIndex })} fb=${JSON.stringify(q.st()?.opFeedback ?? {})}`); return q.opLoc(r, q.opIndex(r, /search/i)); }, [/wriggle through/i], () => z() < 9300, 20, 4);
        await q.walk('to book', [{ x: BOOK.x + 1, z: BOOK.z, tol: 1 }]);
        await act('book', () => q.opLoc(loc(BOOK), 2), [/quite sure/i], () => q.has(ITEM.tattered), 25, 6);
        await act('read tattered', () => invOp(ITEM.tattered, /read/i), [/yes please/i], () => q.sawText(/bervirius/i) && !q.dialogOpen(), 15, 3);
        await q.s.direct({ type: 'closeModal', reason: 'SDK' });
        await q.walk('to gallows', [{ x: GALLOWS.x - 1, z: GALLOWS.z, tol: 2 }]);
        await act('gallows', () => q.opLoc(loc(GALLOWS), 2), [/yes, i may find something/i], () => q.has(ITEM.zbones), 25, 4);
        await q.walk('to sacks', [{ x: SACKS.x - 1, z: SACKS.z, tol: 2 }]);
        await act('sacks', () => q.opLoc(loc(SACKS), 2), [], () => q.has(ITEM.crumpled), 15, 4);
        await act('read crumpled', () => invOp(ITEM.crumpled, /read/i), [/yes please/i], () => !q.dialogOpen() && q.sawText(/scroll about rashiliyia/i), 15, 3);
        await q.s.direct({ type: 'closeModal', reason: 'SDK' });
        q.milestone('scrolls');
        await q.walk('to rubble up', [{ x: RUBBLE_DN.x + 1, z: RUBBLE_DN.z, tol: 1 }]);
        await act('rubble up', () => { const r = rubble(); return q.opLoc(r, q.opIndex(r, /search/i)); }, [/wriggle through/i], () => z() > 9340, 20, 4);
        await q.walk('to falls', [{ x: FALLS.x - 2, z: FALLS.z, tol: 2 }]);
        await act('falls', () => q.opLoc(loc(FALLS), 2), [/follow the path/i], () => z() < 4000, 25, 4);
        // A fall from this ledge throws the bot to 2928,2950, and the water carries it to the north bank at 2932,2953
        // (quest_zombiequeen.rs2 oploc2 zqwaterfallrocks), which no walk leaves for Cairn Isle except the stones.
        if (z() > 2947) await q.waitTicks(8);
        if (z() >= 2951) await stones(false);
        q.milestone(8);
    }
    if (from('cairn')) {
        // 5. Bervirius' tomb (9): the dolmen gives the ivory pommel, the crystal and the notes (bit 2); the chisel on
        // the pommel makes the beads, the bronze wire on them the Beads of the Dead (crumpled scroll read,
        // :1246-1280); the hand holds out to 2764,2976.
        await toBervirius();
        q.milestone(9);
        await q.walk('to dolmen', [{ x: DOLMEN.x - 1, z: DOLMEN.z + 2, tol: 2 }]);
        await act('dolmen', () => q.opLoc(loc(DOLMEN), 2), [], () => q.has(ITEM.pommel) && q.has(ITEM.notes), 25, 3);
        await act('ivory beads', () => q.useOnItem(ITEM.chisel, ITEM.pommel), [], () => q.has(ITEM.ibeads), 10, 3);
        await act('dead beads', () => q.useOnItem(ITEM.wire, ITEM.ibeads), [], () => q.has(ITEM.dbeads), 10, 3);
        await drop('tomb leftovers', [ITEM.notes]);
        q.milestone('beads');
        await q.walk('to holds', [{ x: HOLDS.x - 1, z: HOLDS.z, tol: 1 }]);
        for (let i = 0; i < 6 && z() > 9000; i++) {
            await q.guard('holds');
            await q.opLoc(loc(HOLDS), 1);
            await q.waitUntil(() => z() < 9000, 12);
        }
        if (z() > 9000) await q.fail('holds');
    }
    if (from('bury')) {
        // 6. Zadimus' remains buried in Tai Bwo Wannai (2794-2798, 3087-3090) give the bone shard (:948-972).
        if (from('cairn')) await fromCairn();
        await q.walk('to sacred ground', [{ x: SACRED.x, z: SACRED.z, tol: 1 }]);
        await act('bury', () => invOp(ITEM.zbones, /bury|^drop/i), [], () => q.has(ITEM.shard), 20, 4);
        q.milestone('shard');
    }
    if (from('door')) {
        // 7. The palm trees (2915,3092) reveal the doors; Search on the doors sets bit 4 (:161-166); the chisel on the
        // shard makes the bone key (:1283-1299); the key on the doors sets 10 and opens them (:168-199); Open walks
        // into the tomb, 2929,9525 (:180-192).
        if (from('bury')) await stones(true);
        await q.walk('to trees', [{ x: TREES.x + 1, z: TREES.z + 1, tol: 2 }]);
        const door = () => q.findLoc((l: any) => [2240, 2241, 2238, 2239].includes(l.id));
        await act('trees', () => q.opLoc(loc(TREES), 2), [], () => !!door(), 10, 4);
        await act('search door', () => { const d = door(); return d ? q.opLoc(d, 2) : q.waitTicks(1); }, [], () => q.sawText(/made out of bone/i), 12, 4);
        await act('bone key', () => q.useOnItem(ITEM.chisel, ITEM.shard), [], () => q.has(ITEM.key), 10, 3);
        await act('key on door', () => { const d = door(); return d ? q.useOnLoc(ITEM.key, d) : q.opLoc(loc(TREES), 2); }, [], () => !!q.findLoc((l: any) => [2238, 2239].includes(l.id)), 12, 4);
        await wield('beads', ITEM.dbeads);
        await drop('chisel', [ITEM.chisel, ITEM.wire]);
        await act('enter tomb', () => { const d = q.findLoc((l: any) => [2238, 2239].includes(l.id)); return d ? q.opLoc(d, 1) : q.waitTicks(1); }, [], () => z() > 9000, 12, 4);
        q.milestone(10);
    }
    if (from('tomb')) {
        // 8. Beads worn: the gate (2928,9516) lets the bot by (11) and Rashiliyia stays away (:255-312); the rocks
        // (2928,9512) down; the 3 bones in the tomb door (2892,9480) open it (12, :1399-1447); the dolmen (2892,9487)
        // raises Nazastarool 3 times (level 91, 68, 93, :1526-1577); the remains appear on the dolmen.
        if (!worn(ITEM.dbeads) && q.has(ITEM.dbeads)) await wield('beads', ITEM.dbeads);
        const gate = () => q.findLoc((l: any) => (l.id === 2255 || l.id === 2256) && l.z === 9516);
        await q.walk('to gate', [{ x: 2929, z: 9518, tol: 1 }]);
        await act('gate', () => { const g = gate(); return g ? q.opLoc(g, 1) : q.waitTicks(1); }, [], () => z() <= 9515, 12, 4);
        await act('rocks down', () => { const r = q.findLoc((l: any) => l.id === 2257); return r ? q.opLoc(r, 1) : q.waitTicks(1); }, [], () => z() <= 9511, 12, 4);
        q.milestone(11);
        await q.walk('to tomb door', [{ x: 2892, z: 9479, tol: 1 }]);
        const tdoor = () => q.findLoc((l: any) => l.id >= 2246 && l.id <= 2250 && l.z === 9480);
        // After the third bone the doors move the bot in (:1359-1364); a dialog page can leave it on the door tile
        // (2892,9480, trial t10), where Open walks it in.
        for (let i = 0; i < 8 && z() <= 9480; i++) {
            await q.guard('tomb door');
            const n0 = q.cnt(ITEM.bones);
            const d = tdoor();
            if (d && n0 > 0) await q.useOnLoc(ITEM.bones, d);
            else if (d) await q.opLoc(d, 1);
            await q.converse([], () => (n0 > 0 && q.cnt(ITEM.bones) < n0) || z() > 9480, 10);
            await q.converse([], () => !q.dialogOpen() || z() > 9480, 10);
        }
        if (z() <= 9480) await q.fail('tomb door');
        q.milestone(12);
        await topUp(90);
        await pfm(true);
        const dol = () => q.findLoc((l: any) => l.id === 2258 && l.z === 9487) ?? { id: 2258, x: 2892, z: 9487 };
        await act('dolmen', () => q.opLoc(dol(), 2), [], () => !!q.npc(/^nazastarool$/i), 20, 3);
        const kill = async (label: string) => {
            for (let i = 0; i < 40; i++) {
                await q.guard(label);
                const n = q.npc(/^nazastarool$/i);
                if (!n) return;
                await q.s.bot.attack(n as any);
                await q.waitUntil(() => !(q.st()?.nearbyNpcs ?? []).some((m: any) => m.index === n.index), 6);
                if (q.dialogOpen()) await q.converse([], () => !q.dialogOpen(), 6);
            }
        };
        for (let f = 1; f <= 3; f++) {
            await kill(`nazastarool ${f}`);
            await q.converse([], () => !!q.npc(/^nazastarool$/i) || q.sawText(/something appear on the dolmen/i) || msgSince(/something appear on the dolmen/i, 0), 20);
            q.milestone(`naza${f}`);
            if (q.sawText(/something appear on the dolmen/i) || msgSince(/something appear on the dolmen/i, 0)) break;
        }
        await q.converse([], () => !q.dialogOpen(), 10);
        // After the fight the bot can stand outside the door on 2893,9480 (2 of 3 runs), where the dolmen answers "I can't
        // reach that!": the door moves it back in (:1359-1364). No undead chase here: that is a way out of the room.
        for (let i = 0; i < 8 && !q.has(ITEM.corpse); i++) {
            await q.guard('remains');
            if (z() <= 9480) {
                const d = q.findLoc((l: any) => l.id >= 2246 && l.id <= 2251 && l.z === 9480);
                if (d) await q.opLoc(d, 1);
                await q.waitUntil(() => z() > 9480, 6);
                continue;
            }
            await q.opLoc(dol(), 2);
            await answer([], () => q.has(ITEM.corpse), 15);
        }
        if (!q.has(ITEM.corpse)) await q.fail('remains');
        await answer([], () => !q.dialogOpen(), 8);
        await pfm(false);
        q.milestone(14);
        // 9. Out: the rocks up, the gate from the south, the bone key on the exit doors (2928,9527) to 2916,3093
        // (:201-240).
        // The room has one way out: the tomb door moves the player from inside onto its south tile 2892,9480 (:1359-1364).
        // The planner takes the door for shut and stops at 2896,9489, inside the room.
        await q.walk('to tomb door inside', [{ x: 2892, z: 9481, tol: 1 }]);
        await act('tomb door out', () => { const d = q.findLoc((l: any) => l.id >= 2246 && l.id <= 2251 && l.z === 9480); return d ? q.opLoc(d, 1) : q.waitTicks(1); }, [], () => z() <= 9480, 12, 4);
        await q.walk('to rocks up', [{ x: 2928, z: 9510, tol: 1 }]);
        // A climb passes 2928,9513, and a fall goes on from there back to 2928,9511 (:1486-1501): only 2929,9515 is the top.
        await act('rocks up', () => { const r = q.findLoc((l: any) => l.id === 2257); return r ? q.opLoc(r, 1) : q.waitTicks(1); }, [], () => z() >= 9515, 12, 6);
        await act('gate out', () => { const g = gate(); return g ? q.opLoc(g, 1) : q.waitTicks(1); }, [], () => z() >= 9517, 12, 4);
        await q.walk('to exit', [{ x: 2929, z: 9525, tol: 1 }]);
        await act('exit', () => { const d = q.findLoc((l: any) => l.id === 2242 || l.id === 2243); return d ? q.useOnLoc(ITEM.key, d) : q.waitTicks(1); }, [], () => z() < 4000, 12, 4);
    }
    if (from('final')) {
        // 10. Back in Bervirius' tomb, the remains on the dolmen queue the completion (:1120-1143, 1630-1635).
        if (from('tomb')) await stones(false);
        await toBervirius();
        await q.walk('to dolmen 2', [{ x: DOLMEN.x - 1, z: DOLMEN.z + 2, tol: 2 }]);
        await act('remains on dolmen', () => q.useOnLoc(ITEM.corpse, loc(DOLMEN)), [], () => questDone, 25, 4);
        await q.converse([], () => !q.dialogOpen(), 10);
        q.milestone(15);
        off();
        await q.end(questDone, 'qp=2');
    }
    off();
    await q.end(false, 'stage end');
} catch (e) { await q.fail(String(e)); }
