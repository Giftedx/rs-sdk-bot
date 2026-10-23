// Shield of Arrav as a pair. Usage: bun scripts/generated/quest-arrav.ts <main> [helper=<main>p]
// Presets: <main> quest_arrav (beside the tramp), <helper> quest_arrav_helper (beside Reldo) or, with
// ARRAV_HELPER_READY=1, quest_arrav_helper_ready (the helper's part done). Every skill 99, rune set worn.
//
// Why two accounts (server truth, quests/quest_blackarmgang/scripts/quest_blackarmgang.rs2): the Phoenix half
// (arravshield1) is in the chest inside the Phoenix HQ, behind a door that opens only at %phoenixgang >= 9 (:14-30,
// :34-41); the Black Arm half (arravshield2) is in the cupboard upstairs in the Black Arm HQ, behind a door that opens
// only at %blackarmgang >= 3 (:99-105, 110-116). Straven and Katrine refuse a member of the other gang (straven.rs2:2-5,
// katrine.rs2:1-7), and the curator needs both halves in one pack (curator.rs2:7-23). The halves, the crossbows and the
// certificates are tradeable (quest_blackarmgang.obj).
//
// Method: the main joins the Black Arm Gang, which is the short side: the tramp (tramp.rs2:26-47), Katrine (katrine.rs2
// :14-78), 2 Phoenix crossbows to Katrine (:90-106). The helper does the Phoenix side once: Reldo, the book, Reldo,
// Baraek (20 coins), Straven, Jonny the Beard's report, Straven (key 759), the chest (shield half 763), the weapon store
// (the weaponsmaster blocks the crossbow pickup while he is within 10 tiles, quest_blackarmgang.rs2:88-97 and
// weaponsmaster.rs2:18-24, so the helper kills him first). The helper hands the main 2 crossbows and the Phoenix half in
// one trade beside the tramp. The main takes the Black Arm half, gets 2 certificates from the curator, claims the reward
// from King Roald (king_roald.rs2:9-28), then gives the second certificate to the helper, who claims too: both accounts
// finish the quest (needed for Heroes' Quest, quest_hero.rs2:1-7). The RESULT `mainTicks` stops at the main's quest
// complete message; the certificate trade comes after it.
import { openQuest } from './quest-lib';

const MAIN = process.argv[2]!;
const HELPER = process.argv[3] ?? `${MAIN}p`;
const READY = process.env.ARRAV_HELPER_READY === '1';

const ITEM = { book: 757, key: 759, report: 761, half1: 763, half2: 765, crossbow: 767, cert: 769 };
const NPC = { reldo: /^reldo$/i, baraek: /^baraek$/i, straven: /^straven$/i, jonny: /^jonny the beard$/i, weaponsmaster: /^weaponsmaster$/i, tramp: /^tramp$/i, katrine: /^katrine$/i, curator: /^curator$/i, king: /^king roald$/i };
const AT = {
    reldo: { x: 3209, z: 3495 }, baraek: { x: 3218, z: 3435 }, straven: { x: 3246, z: 9780 }, jonny: { x: 3223, z: 3395 },
    tramp: { x: 3208, z: 3391 }, katrine: { x: 3186, z: 3385 }, curator: { x: 3255, z: 3445 }, king: { x: 3222, z: 3476 },
    meet: { x: 3208, z: 3390 },
};
const LOC = {
    bookcase: { id: 2402, x: 3212, z: 3493 },          // questbookcase op2 Check (quest_blackarmgang.rs2:1-12)
    cellar: { id: 1754, x: 3244, z: 3383 },            // ladder_cellar down to the Phoenix HQ (z + 6400)
    hqLadder: { id: 2405, x: 3244, z: 9783 },          // phoenixladder up to 3244,3382 (ladders.rs2:124-126)
    hqDoor: { id: 2397, x: 3247, z: 9779 },            // phoenixdoor, north wall; opens at %phoenixgang >= 9
    chest: { id: 2403, x: 3235, z: 9761 },             // phoenixshutchest -> phoenixopenchest 2404 (op1 Search)
    storeDoor: { id: 2398, x: 3251, z: 3385 },         // phoenixdoor2: the key on it from outside, op1 from inside
    storeLadder: { id: 1747, x: 3252, z: 3384 },       // ladder up; laddertop 1746 on level 1
    baDoor: { id: 2399, x: 3185, z: 3388 },            // blackarmdoor, south wall of 3185,3388; opens at %blackarmgang >= 3
    baStairs: { id: 1722, x: 3188, z: 3389 },          // stairs up to 3188,3392,1 (stairs.rs2:10)
    baStairsTop: { id: 1723, x: 3188, z: 3390 },       // stairstop down to 3188,3388,0 (stairs.rs2:55)
    cupboard: { id: 2400, x: 3188, z: 3385 },          // level 1; blackarmcupboardopen 2401 op2 Search
};
const CROSSBOWS = [{ x: 3243, z: 3383 }, { x: 3245, z: 3385 }];  // level 1 obj spawns (maps/m50_52.jm2)
const exact = (n: string) => new RegExp(`^${n}$`, 'i');

type Q = Awaited<ReturnType<typeof openQuest>>;
let m: Q | undefined;
const h: Q = await openQuest({ name: HELPER, cap: 6000, others: () => m ? [m.s] : [] });
const done = (q: Q) => { let d = false; q.s.onTick(() => { if (!d && q.msgCount(/quest complete/i) > 0) d = true; }); return () => d; };
const attackOp = (n: any) => n.optionsWithIndex?.find((o: any) => /attack/i.test(o.text))?.opIndex ?? 2;
const ground = (q: Q, id: number): any[] => (q.st()?.groundItems ?? []).filter((g: any) => g.id === id).sort((a: any, b: any) => a.distance - b.distance);
const loc = (q: Q, l: { id: number; x: number; z: number }, re?: RegExp) => q.locAt(l.x, l.z, re) ?? l;
// Kill an NPC with melee, then pick up `drops` (item ids) from the floor.
async function killAndLoot(q: Q, label: string, re: RegExp, home: { x: number; z: number }, want: () => boolean, drop: number, maxTicks = 150): Promise<void> {
    for (let t = 0; t < maxTicks && !want(); t++) {
        await q.guard(label);
        const g = ground(q, drop)[0];
        if (g) { if (t % 3 === 0) await q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' }); }
        else {
            const n = q.npc(re);
            if (!n) { if (t % 10 === 0) await q.dash(`${label} approach`, home.x, home.z, 3); }
            else if (t % 4 === 0 && q.pos()?.targetIndex !== n.index) await q.s.direct({ type: 'interactNpc', npcIndex: n.index, optionIndex: attackOp(n), reason: 'SDK' });
        }
        await q.waitTicks(1);
    }
    if (!want()) await q.fail(`${label}: no drop`);
}

// Open a chest or cupboard (it becomes `openId`), then Search it; the half comes after the message boxes
// (quest_blackarmgang.rs2:34-41, 110-116).
async function searchFor(q: Q, label: string, l: { id: number; x: number; z: number }, openId: number, item: number): Promise<void> {
    for (let i = 0; i < 6 && !q.has(item); i++) {
        await q.guard(label);
        if (i > 0) q.stats.retries++;
        // The open loc is found by its Search option near the tile (by id on the tile, a trial waited 10 ticks).
        const open = () => q.locs().find((o: any) => o.x === l.x && o.z === l.z && (o.id === openId || (o.optionsWithIndex ?? []).some((p: any) => /^search$/i.test(p.text))));
        const c = open();
        await q.opLoc(c ?? q.locAt(l.x, l.z) ?? l, c ? q.opIndex(c, /search/i) : 1);
        // The walk to the loc is part of the click, so the wait covers it (10 ticks was short in a trial).
        await q.waitUntil(() => q.has(item) || q.dialogOpen() || (!c && !!open()), 25);
        if (q.dialogOpen()) await q.converse([], () => q.has(item) && !q.dialogOpen(), 12);
    }
    if (!q.has(item)) await q.fail(`${label}: no item ${item}`);
}

// ---- The helper's Phoenix part (done once, before the main arrives) ----
async function helperPart(q: Q): Promise<void> {
    const under = () => (q.pos()?.worldZ ?? 0) > 6000;
    await q.talk('reldo 1', NPC.reldo, [/in search of a quest/i], () => q.sawText(/a book called 'the shield of arrav'/i), AT.reldo);
    q.milestone('h-reldo');
    // The take is after a chat page and a message box (quest_blackarmgang.rs2:8-12).
    await q.step('bookcase', () => q.opLoc(loc(q, LOC.bookcase), 2), () => q.has(ITEM.book) || q.dialogOpen(), 15, 4);
    await q.converse([], () => q.has(ITEM.book) && !q.dialogOpen(), 15);
    if (!q.has(ITEM.book)) await q.fail('no book');
    // Reading sets %phoenixgang 2 before the book opens (arrav_book.rs2:1-11).
    await q.s.direct({ type: 'useInventoryItem', slot: q.slot(ITEM.book)!, optionIndex: 1, reason: 'SDK' });
    await q.waitTicks(2);
    await q.s.direct({ type: 'closeModal', reason: 'SDK' });
    await q.talk('reldo 2', NPC.reldo, [], () => q.sawText(/baraek, the fur trader/i), AT.reldo);
    q.milestone('h-book');
    await q.walk('to baraek', [{ x: AT.baraek.x, z: AT.baraek.z - 1, tol: 3 }]);
    await q.talk('baraek', NPC.baraek, [/where i can find the phoenix gang/i, /have 20 gold coins/i], () => q.sawText(/vtam corporation/i), AT.baraek);
    q.milestone('h-baraek');
    const downCellar = async (label: string) => {
        await q.walk(`${label} cellar`, [{ x: 3244, z: 3382, tol: 1 }]);
        await q.climb(`${label} down`, () => loc(q, LOC.cellar, /ladder/i), /climb-down/i, under);
    };
    const upLadder = async (label: string) => {
        await q.walk(`${label} hq ladder`, [{ x: 3244, z: 9782, tol: 1 }]);
        await q.climb(`${label} up`, () => loc(q, LOC.hqLadder, /ladder/i), /climb-up/i, () => !under());
    };
    await downCellar('straven 1');
    await q.talk('straven 1', NPC.straven, [/i know who you are/i, /offer you my services/i], () => q.sawText(/jonny the beard/i), AT.straven);
    q.milestone('h-straven');
    await upLadder('jonny');
    await q.walk('to jonny', [{ x: AT.jonny.x, z: AT.jonny.z, tol: 4 }]);
    await killAndLoot(q, 'jonny', NPC.jonny, AT.jonny, () => q.has(ITEM.report), ITEM.report);
    q.milestone('h-report');
    await downCellar('straven 2');
    await q.talk('straven 2', NPC.straven, [], () => q.has(ITEM.key), AT.straven);
    q.milestone('h-joined');
    // The HQ door (joined: it opens and moves the player through, quest_blackarmgang.rs2:14-30, 66-86), the chest.
    await q.walk('hq door', [{ x: LOC.hqDoor.x, z: LOC.hqDoor.z + 1, tol: 1 }]);
    await q.step('hq door in', () => q.opLoc(loc(q, LOC.hqDoor), 1), () => (q.pos()?.worldZ ?? 9999) <= LOC.hqDoor.z, 10, 4);
    await q.walk('to chest', [{ x: LOC.chest.x, z: LOC.chest.z + 1, tol: 0 }]);
    await searchFor(q, 'chest', LOC.chest, 2404, ITEM.half1);
    q.milestone('h-half');
    await q.walk('hq door out', [{ x: LOC.hqDoor.x, z: LOC.hqDoor.z, tol: 0 }]);
    await q.step('hq door out', () => q.opLoc(loc(q, LOC.hqDoor), 1), () => (q.pos()?.worldZ ?? 0) > LOC.hqDoor.z, 10, 4);
    await upLadder('store');
    // The weapon store: the key on the door from the north, the ladder, the weaponsmaster, both crossbows.
    await q.walk('store door', [{ x: LOC.storeDoor.x, z: LOC.storeDoor.z + 1, tol: 0 }]);
    await q.step('store door in', () => q.useOnLoc(ITEM.key, loc(q, LOC.storeDoor)), () => (q.pos()?.worldZ ?? 9999) <= LOC.storeDoor.z, 10, 4);
    await q.climb('store up', () => loc(q, LOC.storeLadder, /ladder/i), /climb-up/i, () => q.lvl() === 1);
    for (let i = 0; i < 100 && q.cnt(ITEM.crossbow) < 2; i++) {
        await q.guard('crossbows');
        const w = q.npc(NPC.weaponsmaster);
        if (w) { if (q.pos()?.targetIndex !== w.index) await q.s.direct({ type: 'interactNpc', npcIndex: w.index, optionIndex: attackOp(w), reason: 'SDK' }); }
        else { const g = ground(q, ITEM.crossbow)[0]; if (g && i % 2 === 0) await q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' }); }
        await q.waitTicks(1);
    }
    if (q.cnt(ITEM.crossbow) < 2) await q.fail(`crossbows ${q.cnt(ITEM.crossbow)}`);
    q.milestone('h-crossbows');
    await q.climb('store down', () => q.findLoc(l => l.x === LOC.storeLadder.x && l.z === LOC.storeLadder.z && (l.optionsWithIndex ?? []).some((o: any) => /climb-down/i.test(o.text))) ?? { ...LOC.storeLadder, id: 1746 }, /climb-down/i, () => q.lvl() === 0);
    await q.walk('store door out', [{ x: LOC.storeDoor.x, z: LOC.storeDoor.z, tol: 0 }]);
    await q.step('store door out', () => q.opLoc(loc(q, LOC.storeDoor), 1), () => (q.pos()?.worldZ ?? 0) > LOC.storeDoor.z, 10, 4);
    await q.walk('to meet', [{ x: AT.meet.x, z: AT.meet.z, tol: 0 }]);
    q.milestone('h-ready');
}

try {
    if (!READY) await helperPart(h);
    const helperPrep = h.T();
    if (!h.has(ITEM.half1) || h.cnt(ITEM.crossbow) < 2) await h.fail('helper not ready');
    console.log(`MILESTONE helper-ready ${helperPrep}`);

    // ---- The pair: the main logs in beside the tramp ----
    m = await openQuest({ name: MAIN, cap: 1500, others: () => [h.s] });
    const q = m;
    const mainDone = done(q), helperDone = done(h);
    let mainTicks = -1;
    const sees = (a: Q, name: string) => (a.st()?.nearbyPlayers ?? []).some((p: any) => p.name.toLowerCase() === name.toLowerCase());
    if (!(await h.waitUntil(() => sees(h, MAIN), 30))) await q.fail('helper does not see the main');
    // 1. The trade: 2 crossbows and the Phoenix half.
    const serve = q.s.bot.serveTrades({ from: exact(HELPER), maxTrades: 1, timeout: 60_000 });
    const give = await h.s.bot.trade(exact(MAIN), { give: [{ item: /^phoenix crossbow$/i, amount: -1 }, { item: /^broken shield$/i, amount: -1 }], timeout: 60_000 });
    await serve;
    if (q.cnt(ITEM.crossbow) < 2 || !q.has(ITEM.half1)) await q.fail(`trade: ${give.success ? 'ok' : (give as any).message} crossbows=${q.cnt(ITEM.crossbow)} half1=${q.has(ITEM.half1)}`);
    q.milestone('trade');

    // The helper waits beside the king for the second certificate (runs beside the main's part).
    const helperTail = (async () => {
        await h.walk('helper to king', [{ x: AT.king.x, z: AT.king.z - 2, tol: 2 }]);
        const r = await h.s.bot.serveTrades({ from: exact(MAIN), maxTrades: 1, timeout: 900_000 });
        if (!h.has(ITEM.cert)) return `no certificate (${JSON.stringify(r).slice(0, 120)})`;
        await h.talk('helper king', NPC.king, [], () => helperDone(), AT.king, 60, true);
        await h.converse([], () => !h.dialogOpen(), 10);
        return 'ok';
    })();

    // 2. The tramp: "Is there anything down this alleyway?", "Do you think they would let me join?" sets 1.
    await q.talk('tramp', NPC.tramp, [/anything down this alleyway/i, /would let me join/i], () => q.sawText(/lady down there called katrine/i), AT.tramp);
    q.milestone(1);
    // 3. Katrine: her room is reached from the east through two shut doors (loc_1530 at 3196,3384 and 3190,3384,
    // maps/m49_52.jm2); the HQ door 3185,3388 stays shut until joined. "Ok, no problem." sets 2.
    (q.s.sdk as any).blockDoorTemporarily?.(0, LOC.baDoor.x, LOC.baDoor.z, 120_000);
    await q.walk('to katrine', [{ x: 3197, z: 3384, tol: 0 }]);
    await q.openDoor('katrine door 1', 3196, 3384);
    await q.dash('katrine room', 3191, 3384, 0, 10);
    await q.openDoor('katrine door 2', 3190, 3384);
    await q.talk('katrine 1', NPC.katrine, [/heard you're the black arm gang/i, /rather not reveal my sources/i, /become a member of your gang/i, /give me a try/i, /ok, no problem/i],
        () => q.sawText(/weapon stash just next to a temple/i), { x: 3190, z: 3384 });
    q.milestone(2);
    // 4. The crossbows: joined (3).
    await q.talk('katrine 2', NPC.katrine, [], () => q.cnt(ITEM.crossbow) === 0, AT.katrine);
    q.milestone(3);
    // 5. The HQ door, the stairs, the cupboard (Open, then Search).
    await q.walk('ba door', [{ x: LOC.baDoor.x, z: LOC.baDoor.z - 1, tol: 0 }]);
    await q.step('ba door in', () => q.opLoc(loc(q, LOC.baDoor), 1), () => (q.pos()?.worldZ ?? 0) >= LOC.baDoor.z, 10, 4);
    await q.climb('ba stairs up', () => loc(q, LOC.baStairs, /stair/i), /climb-up/i, () => q.lvl() === 1);
    await searchFor(q, 'cupboard', LOC.cupboard, 2401, ITEM.half2);
    q.milestone('half2');
    // Varrock teleport from the cupboard (3212,3424, 43 tiles from the museum): the walk from the HQ door was 56 ticks.
    await q.teleport('varrock teleport', 'magic:varrock_teleport', 3212, 3424);
    // 6. The curator: both halves give 2 certificates (curator.rs2:7-23).
    await q.walk('to curator', [{ x: AT.curator.x, z: AT.curator.z - 1, tol: 3 }]);
    await q.talk('curator', NPC.curator, [], () => q.cnt(ITEM.cert) >= 2, AT.curator);
    q.milestone(4);
    // 7. King Roald: one certificate, 600 coins, the quest (king_roald.rs2:9-28).
    await q.walk('to king', [{ x: AT.king.x, z: AT.king.z - 1, tol: 2 }]);
    await q.talk('king', NPC.king, [], () => mainDone(), AT.king, 60, true);
    mainTicks = q.T();
    await q.converse([], () => !q.dialogOpen(), 10);
    q.milestone(5);
    // 8. The second certificate to the helper (after the main's quest).
    if (!(await q.waitUntil(() => sees(q, HELPER), 200))) await q.fail('helper not at the king');
    const g2 = await q.s.bot.trade(exact(HELPER), { give: [{ item: /^certificate$/i, amount: 1 }], timeout: 60_000 });
    if (!g2.success) console.log(`WARN certificate trade ${(g2 as any).message}`);
    const tail = await Promise.race([helperTail, new Promise<string>(r => setTimeout(() => r('helper timeout'), 120_000))]);
    await q.end(mainDone() && tail === 'ok' && helperDone(), `qp=1 mainTicks=${mainTicks} helperPrep=${READY ? 'preset' : helperPrep} helper=${tail} helperDone=${helperDone()} helperTicks=${h.T()}`);
} catch (e) { await (m ?? h).fail(String(e)); }
