// Waterfall Quest from preset quest_waterfall (2522,3494,0 beside Almera; 10 HP, 2 ropes, 6 air/earth/water runes,
// 10 lobsters, 500 coins). Reward at 25x: 343,750 Attack and 343,750 Strength XP.
// Server truth: vendor/rs-sdk/server/content/scripts/quests/quest_waterfall/scripts/*.rs2 (%waterfall_quest 0..10).
// Loc origins come from the maps (m39_53, m39_54, m39_149, m39_153, m40_154 .jm2); ids from pack/loc.pack and obj.pack.
// The SDK state has no varps, so each MILESTONE is printed on the observed effect of the step that sets the varp.
// Route notes (bun research/route-danger.ts, 2026-10-23): the gnome cellar (hobgoblins), Glarial's tomb (skeletons,
// zombies, moss giants) and the falls (shadow spiders, skeletons, fire giants max hit about 7) have aggressive NPCs
// with hunt range 1-2. The bot never fights; it eats a lobster at 7 HP or less.
import { openBot, finish, countItems } from '../../packages/core/src/bot';
import { waitTicks, waitUntil } from '../../packages/core/src/ticks';

const LOC = {
    raft: { id: 1987, x: 2509, z: 3493 },
    bookcase: { id: 1989, x: 2520, z: 3426 },
    golrieCrate: { id: 1990, x: 2548, z: 9565 },
    golrieGate: { id: 1991, x: 2515, z: 9575 },
    tombstone: { id: 1992, x: 2558, z: 3444 },
    coffin: { id: 1993, x: 2542, z: 9811 },
    chestClosed: 1994,
    chestOpen: 1995,
    chest: { x: 2530, z: 9844 },
    rock: { id: 1996, x: 2512, z: 3468 },
    ledgeDoor: { id: 2010, x: 2511, z: 3464 },
    tree: { id: 2020, x: 2512, z: 3465 },
    barrel: { id: 2022, x: 2512, z: 3463 },
    baxCrate: { id: 1999, x: 2589, z: 9888 },
    giantDoor: { id: 2002, x: 2568, z: 9893 },
    puzzleDoor: { id: 2002, x: 2566, z: 9901 },
    pillar: 2004,
    statue: { id: 2006, x: 2565, z: 9916 },
    chalice: { id: 2014, x: 2603, z: 9910 },
};
const ITEM = { book: 292, golrieKey: 293, pebble: 294, amulet: 295, urn: 296, baxKey: 298, rope: 954, lobster: 379, air: 556, earth: 557, water: 555 };
// waterfall_pillars.rs2: one air, earth and water rune on each of these six pillars sets bits 1-18.
const PILLARS: [number, number][] = [[2569, 9910], [2569, 9912], [2569, 9914], [2562, 9910], [2562, 9912], [2562, 9914]];
// Quest-helper path through the Tree Gnome Village maze, used only when one walkTo does not arrive.
const MAZE: [number, number][] = [[2505, 3190], [2512, 3190], [2512, 3188], [2532, 3188], [2532, 3182], [2523, 3181], [2523, 3185], [2521, 3185],
    [2520, 3179], [2514, 3179], [2514, 3177], [2527, 3177], [2527, 3179], [2529, 3179], [2529, 3177], [2531, 3177], [2531, 3179], [2533, 3179],
    [2533, 3177], [2544, 3177], [2544, 3174], [2549, 3174], [2549, 3165], [2545, 3165], [2545, 3159], [2550, 3159], [2550, 3156], [2548, 3156],
    [2548, 3145], [2538, 3145], [2538, 3150], [2541, 3150], [2541, 3148], [2544, 3148], [2544, 3150], [2545, 3150], [2545, 3155], [2533, 3156]];
const LUMBRIDGE = { x: 3222, z: 3218 };
const CAP = 4000;
// Max hits on the route before the fire giants are 3-5 (hobgoblins, zombies, skeletons, moss and giant skeletons,
// shadow spiders). Each lobster can only fill 10 HP, so a low threshold makes the 10 lobsters last.
const EAT_AT = 6;

const s = await openBot(process.argv[2]!);
try {
    await waitTicks(s, 5);
    const st = (): any => s.sdk.getState();
    const pos = (): any => st()?.player;
    const inv = (): any[] => st()?.inventory ?? [];
    const hp = (): number => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const atkXp = (): number => s.sdk.getSkillXp('Attack') ?? 0;
    const strXp = (): number => s.sdk.getSkillXp('Strength') ?? 0;
    const cnt = (id: number): number => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const has = (id: number): boolean => cnt(id) > 0;
    const cheb = (x: number, z: number): number => { const p = pos(); return p ? Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) : 999; };
    const near = (x: number, z: number, r: number): boolean => cheb(x, z) <= r;
    const inBox = (x0: number, z0: number, x1: number, z1: number): boolean => {
        const p = pos();
        return !!p && p.worldX >= x0 && p.worldX <= x1 && p.worldZ >= z0 && p.worldZ <= z1;
    };
    const inBoxXZ = (x: number, z: number, x0: number, z0: number, x1: number, z1: number): boolean => x >= x0 && x <= x1 && z >= z0 && z <= z1;
    const dialogOpen = (): boolean => !!s.sdk.getDialog()?.isOpen;
    const sawText = (re: RegExp): boolean => {
        const d: any = s.sdk.getDialog();
        if (d?.text && re.test(d.text)) return true;
        return (st()?.recentDialogs ?? []).some((e: any) => re.test((e.text ?? []).join(' ')));
    };
    // Counts matching game messages; a step is done when the count rises past a count taken before the send.
    const msgCount = (re: RegExp): number => (st()?.gameMessages ?? []).filter((m: any) => m.type === 0 && re.test(m.text)).length;

    // Auto retaliate off (controls:com_3 = component 151): a hit never turns a walk or a loc click into a fight.
    await s.direct({ type: 'clickComponent', componentId: 151, reason: 'SDK' });
    const atk0 = atkXp();
    const str0 = strXp();
    const p0 = pos();
    const life0 = p0?.lifeId;
    const respawn0 = p0?.respawnCount ?? 0;
    const t0 = s.tick();
    const T = (): number => s.tick() - t0;
    let died = false;
    let hpMin = hp();
    let eats = 0;
    let lastEat = -10;
    let last = p0;
    const jumps: string[] = [];
    const done = new Set<number>();
    const milestone = (step: number): void => {
        if (done.has(step)) return;
        done.add(step);
        console.log(`MILESTONE ${step} ${T()}`);
    };

    // Fire giants max hit 11 (str 65, bonus 31) against 10 HP. While `crossing` their room, eat at any lost HP.
    let crossing = false;
    // The server drops an eat sent during a scripted delay (ladder, coffin, gate) with no message, and every eat
    // clears the pending interaction. So an eat counts only when the lobster count falls; `lastEat` is that tick.
    // An eat that did not land is sent again after 2 ticks.
    let eatSentAt = -99;
    let eatCount0 = 0;
    const eatPending = (): boolean => eatSentAt >= 0;
    const eatNow = (): boolean => {
        const food = inv().find(i => i.id === ITEM.lobster);
        if (!food || eatPending()) return false;
        const op = food.optionsWithIndex?.find((o: any) => /^eat$/i.test(o.text))?.opIndex ?? 1;
        eatSentAt = s.tick();
        eatCount0 = cnt(ITEM.lobster);
        void s.direct({ type: 'useInventoryItem', slot: food.slot, optionIndex: op, reason: 'SDK' });
        return true;
    };
    const eatCheck = (): void => {
        if (!eatPending()) return;
        if (cnt(ITEM.lobster) < eatCount0) { eats++; lastEat = s.tick(); eatSentAt = -99; }
        else if (s.tick() - eatSentAt >= 2) eatSentAt = -99;
    };

    // Every tick: death watch, jump log, and the eat reflex (a direct op, so it never waits behind a bot.* action).
    const off = s.onTick(() => {
        const p = pos();
        const h = hp();
        if (h > 0) hpMin = Math.min(hpMin, h);
        if (p?.isDead || (p && p.respawnCount > respawn0) || (p && life0 !== undefined && p.lifeId !== life0)) died = true;
        if (p && last && Math.max(Math.abs(p.worldX - last.worldX), Math.abs(p.worldZ - last.worldZ)) > 20) {
            jumps.push(`${T()}:${last.worldX},${last.worldZ}->${p.worldX},${p.worldZ},${p.level}`);
            if (Math.max(Math.abs(p.worldX - LUMBRIDGE.x), Math.abs(p.worldZ - LUMBRIDGE.z)) <= 15) died = true;
        }
        if (p) last = p;
        eatCheck();
        if (h > 0 && h <= (crossing ? 9 : EAT_AT)) eatNow();
    });

    const detail = (): string => {
        const p = pos();
        const msgs = (st()?.gameMessages ?? []).filter((m: any) => m.type === 0).slice(-4).map((m: any) => m.text).join(' / ');
        return `at=${p?.worldX},${p?.worldZ},${p?.level} ticks=${T()} hpMin=${hpMin} eats=${eats} lobsters=${cnt(ITEM.lobster)} died=${died} milestones=${[...done].join(',')} jumps=${jumps.join(';')} msgs=${msgs}`;
    };
    const fail = async (why: string): Promise<never> => {
        off();
        console.log(`RATE attack ${atkXp() - atk0} ${T()}`);
        return finish([s], false, `${why} ${detail()}`);
    };
    const guard = async (label: string): Promise<void> => {
        if (died) await fail(`died during ${label}`);
        if (T() > CAP) await fail(`tick cap during ${label}`);
    };

    const opLoc = (l: { id: number; x: number; z: number }, op = 1) =>
        s.direct({ type: 'interactLoc', x: l.x, z: l.z, locId: l.id, optionIndex: op, reason: 'SDK' });
    const useOnLoc = (item: number, l: { id: number; x: number; z: number }) => {
        const it = inv().find(i => i.id === item);
        if (!it) return Promise.resolve(null);
        return s.direct({ type: 'useItemOnLoc', itemSlot: it.slot, x: l.x, z: l.z, locId: l.id, reason: 'SDK' });
    };
    const findLoc = (pred: (l: any) => boolean): any =>
        (st()?.nearbyLocs ?? []).filter(pred).sort((a: any, b: any) => a.distance - b.distance)[0];
    const opIndex = (l: any, re: RegExp): number => l?.optionsWithIndex?.find((o: any) => re.test(o.text))?.opIndex ?? 1;

    // Scripted actions (p_delay) drop eats, so top up first when one hit could leave too little.
    const topUp = async (label: string, at = EAT_AT + 1): Promise<void> => {
        for (let i = 0; i < 6 && hp() > 0 && hp() <= at && has(ITEM.lobster); i++) {
            await guard(label);
            eatNow();
            await waitTicks(s, 1);
        }
    };
    // Sends, then waits up to `ticks` for `ok`; retries. An eat clears the pending interaction, so a landed eat
    // after the send ends the wait early and the send repeats without using a try (2 ticks later, after a re-check,
    // so an action that already ran is not sent twice). A stray dialog page is clicked through between tries.
    const step = async (label: string, send: () => unknown, ok: () => boolean, ticks = 20, tries = 3): Promise<void> => {
        let resends = 0;
        for (let i = 0; i < tries; i++) {
            await guard(label);
            if (ok()) return;
            await topUp(label);
            if (ok()) return;
            const sentAt = s.tick();
            await send();
            await waitUntil(s, () => ok() || died || lastEat > sentAt, { timeoutTicks: ticks });
            if (ok()) return;
            if (lastEat > sentAt && !died && resends < 15) {
                resends++;
                i--;
                await waitTicks(s, 2);
                continue;
            }
            const d: any = s.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) await s.sdk.sendClickDialog(0);
        }
        await guard(label);
        if (!ok()) await fail(`step ${label}`);
    };

    // Clicks through dialog pages: the first option matching a pattern, else "continue". Stops when ok() holds.
    const converse = async (pats: RegExp[], ok: () => boolean, maxTicks: number): Promise<boolean> => {
        for (let i = 0; i < maxTicks && !died; i++) {
            if (ok()) return true;
            const d: any = s.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) {
                const opt = (d.options ?? []).find((o: any) => pats.some(re => re.test(o.text)));
                await s.sdk.sendClickDialog(opt ? opt.index : 0);
            }
            await waitTicks(s, 1);
        }
        return ok();
    };

    // Each waypoint gets up to 4 walkTo tries from wherever the bot is.
    const walkPt = async (x: number, z: number, tol: number): Promise<boolean> => {
        for (let i = 0; i < 4 && !near(x, z, tol + 1); i++) {
            await guard(`walk ${x},${z}`);
            await s.bot.walkTo(x, z, tol, { timeout: 400_000 });
        }
        return near(x, z, tol + 1);
    };
    const walk = async (label: string, pts: [number, number, number][]): Promise<void> => {
        for (const [x, z, tol] of pts) if (!(await walkPt(x, z, tol))) await fail(`walk ${label} ${x},${z}`);
    };
    // One long walkTo; if it stops short, follow the maze waypoints from the nearest one.
    const walkMaze = async (label: string, x: number, z: number, path: [number, number][]): Promise<void> => {
        for (let i = 0; i < 2 && !near(x, z, 2); i++) {
            await guard(label);
            await s.bot.walkTo(x, z, 1, { timeout: 400_000 });
        }
        if (near(x, z, 2)) return;
        let k = 0;
        for (let i = 1; i < path.length; i++) if (cheb(path[i]![0], path[i]![1]) < cheb(path[k]![0], path[k]![1])) k = i;
        for (let i = k; i < path.length; i++) if (!(await walkPt(path[i]![0], path[i]![1], 1))) await fail(`maze ${label} ${path[i]}`);
        await walk(label, [[x, z, 2]]);
    };

    // Ladder or staircase with an option matching `re`, nearest to (x, z); waits for the plane or the z band to change.
    const climb = async (label: string, x: number, z: number, re: RegExp, arrived: () => boolean): Promise<void> => {
        await step(label, async () => {
            const l = findLoc(k => /ladder|stair/i.test(k.name) && Math.max(Math.abs(k.x - x), Math.abs(k.z - z)) <= 3 && k.optionsWithIndex?.some((o: any) => re.test(o.text)));
            if (!l) { await s.bot.walkTo(x, z, 2); return; }
            await opLoc(l, opIndex(l, re));
        }, arrived, 20, 4);
    };

    // 1. Almera: "How can I help?" sets %waterfall_quest = 1 (almera.rs2:14).
    const talk = await s.bot.talkTo(/^almera$/i);
    if (!talk.success) await fail(`talk Almera: ${talk.message}`);
    // Done when her last line is seen, or after the dialog stays shut for 3 ticks. The raft refuses at 0, so it proves 1.
    let shutFor = 0;
    await converse([/how can i help/i], () => {
        shutFor = dialogOpen() ? 0 : shutFor + 1;
        return (sawText(/you are kind|small raft out back/i) && !dialogOpen()) || shutFor >= 3;
    }, 60);
    if (sawText(/you are kind|small raft out back/i)) milestone(1);
    else console.log(`WARN Almera last line not seen at ${T()}`);

    // 2. The raft lands on Hudon's island (2512,3481); Hudon's forced dialogue sets 2 (quest_waterfall.rs2:178).
    const onIsland = () => inBox(2510, 3476, 2514, 3482);
    await walk('raft', [[2511, 3494, 1]]);
    await step('raft 1', () => opLoc(LOC.raft), onIsland, 20);
    milestone(1);
    const hudonDone = () => (sawText(/fine alone/i) || msgCount(/hudon is refusing/i) > 0) && !dialogOpen();
    let seenOpen = false;
    let shutAfter = 0;
    await converse([], () => {
        if (dialogOpen()) { seenOpen = true; shutAfter = 0; } else if (seenOpen) shutAfter++;
        return hudonDone() || shutAfter >= 3;
    }, 20);
    if (seenOpen && !hudonDone()) console.log(`WARN forced dialogue ended without the Hudon line at ${T()}`);
    // No forced dialogue (Hudon wandered more than 5 tiles off): talk to him from the island (hudon.rs2:22).
    for (let i = 0; i < 2 && !hudonDone() && !seenOpen; i++) {
        await guard('talk Hudon');
        const h = s.sdk.findNearbyNpc(/^hudon$/i);
        if (h) await s.direct({ type: 'interactNpc', npcIndex: h.index, optionIndex: h.optionsWithIndex?.find((o: any) => /talk/i.test(o.text))?.opIndex ?? 1, reason: 'SDK' });
        await waitUntil(s, () => dialogOpen() || died, { timeoutTicks: 8 });
        let shut = 0;
        await converse([], () => { shut = dialogOpen() ? 0 : shut + 1; return hudonDone() || shut >= 3; }, 30);
    }
    // The bookcase only gives the book at 2 or more, so the book proves 2 if the dialogue text was missed.
    if (hudonDone()) milestone(2);
    else console.log(`WARN Hudon dialogue not seen at ${T()}`);

    // Off the island: rope on the rock, rope on the dead tree to the ledge, then the barrel washes the bot to 2527,3413.
    const onTreeIsland = () => inBox(2512, 3465, 2513, 3475);
    const onLedge = () => inBox(2510, 3462, 2513, 3464);
    const ropeAcross = async (label: string): Promise<void> => {
        await walkPt(2512, 3477, 0);
        await step(`${label} rope rock`, async () => {
            const roped = findLoc(l => l.id === 1997 && l.x === LOC.rock.x && l.z === LOC.rock.z);
            if (roped) { await waitTicks(s, 3); return; }
            await useOnLoc(ITEM.rope, LOC.rock);
        }, () => near(LOC.rock.x + 1, LOC.rock.z, 0), 15, 5);
        // The rope script ends with two forcemoves to 2513,3468; a click during them can be dropped.
        await waitTicks(s, 1);
        if (!onTreeIsland()) await fail(`${label} not on the tree island after the rope`);
        await step(`${label} rope tree`, () => useOnLoc(ITEM.rope, LOC.tree), onLedge, 15, 4);
    };
    await ropeAcross('trip 1');
    const washed = () => near(2527, 3413, 4);
    await step('barrel', () => opLoc(LOC.barrel), washed, 12, 3);

    // 3. The south-east bookcase upstairs in Hadley's house; reading the book sets 3 (baxtorian_book.rs2:7).
    await walk('Hadley', [[2517, 3427, 2]]);
    await climb('Hadley up', 2517, 3428, /climb-up/i, () => pos()?.level === 1);
    await step('bookcase', () => opLoc(LOC.bookcase), () => has(ITEM.book), 15, 3);
    milestone(2);
    const BOOK_MSG = /book is old/i;
    const read0 = msgCount(BOOK_MSG);
    // A missed message is not fatal here: the Golrie crate only gives its key at 3 or more, which proves it later.
    for (let i = 0; i < 2 && msgCount(BOOK_MSG) <= read0; i++) {
        await guard('read book');
        const b = inv().find(x => x.id === ITEM.book);
        if (b) await s.direct({ type: 'useInventoryItem', slot: b.slot, optionIndex: b.optionsWithIndex?.find((o: any) => /read/i.test(o.text))?.opIndex ?? 1, reason: 'SDK' });
        await waitUntil(s, () => msgCount(BOOK_MSG) > read0 || died, { timeoutTicks: 5 });
    }
    if (msgCount(BOOK_MSG) > read0) milestone(3);
    else console.log(`WARN book message not seen at ${T()}`);
    await s.direct({ type: 'closeModal', reason: 'SDK' });
    await climb('Hadley down', 2518, 3429, /climb-down/i, () => pos()?.level === 0);

    // Golrie under the Tree Gnome Village: key from the east crate (needs 3), key on the gate, pebble from Golrie.
    await walk('gnome village', [[2505, 3190, 2]]);
    await walkMaze('maze in', 2533, 3156, MAZE);
    const inCellar = () => (pos()?.worldZ ?? 0) > 9500 && (pos()?.worldZ ?? 0) < 9600;
    await climb('gnome cellar down', 2533, 3155, /climb-down/i, inCellar);
    await step('golrie crate', () => opLoc(LOC.golrieCrate), () => has(ITEM.golrieKey), 40, 3);
    milestone(3);
    const inGolrieRoom = () => inBox(2502, 9576, 2523, 9593);
    // The key only opens the gate from its own tile row (check_axis: z 9575), so stand south of it first; the key
    // script is p_delay(3) and a door move, about 5 ticks.
    if (!has(ITEM.golrieKey)) await fail('no Golrie key after the crate');
    await walk('golrie gate', [[2515, 9574, 0]]);
    await step('golrie gate', async () => {
        if (!near(2515, 9574, 1)) await s.bot.walkTo(2515, 9574, 0);
        await useOnLoc(ITEM.golrieKey, LOC.golrieGate);
    }, inGolrieRoom, 10, 6);
    // golrie.rs2 closes the dialogue for p_delay(2) when he takes the key, then talks again: wait for his last line,
    // or for 5 shut ticks, so the gate click does not land inside that gap.
    let golrieShut = 0;
    const gotPebble = () => {
        golrieShut = dialogOpen() ? 0 : golrieShut + 1;
        return has(ITEM.pebble) && !has(ITEM.golrieKey) && ((sawText(/take care golrie/i) && !dialogOpen()) || golrieShut >= 5);
    };
    await step('Golrie', async () => {
        const g = s.sdk.findNearbyNpc(/^golrie$/i);
        if (g) await s.direct({ type: 'interactNpc', npcIndex: g.index, optionIndex: g.optionsWithIndex?.find((o: any) => /talk/i.test(o.text))?.opIndex ?? 1, reason: 'SDK' });
        await converse([], gotPebble, 40);
    }, gotPebble, 3, 3);
    await step('gate out', () => opLoc(LOC.golrieGate), () => inCellar() && !inGolrieRoom(), 15, 3);
    await walk('cellar ladder', [[2533, 9556, 2]]);
    await climb('gnome cellar up', 2533, 9555, /climb-up/i, () => (pos()?.worldZ ?? 0) < 4000);

    // 4. Glarial's tombstone: runes are refused in the tomb (quest_waterfall.rs2:70), so they wait on the ground
    // (300-tick drop timer). The pebble opens the tomb and sets 4.
    await walkMaze('maze out', 2538, 3420, [...MAZE].reverse());
    await walk('tombstone', [[2557, 3444, 1]]);
    const RUNES = [ITEM.air, ITEM.earth, ITEM.water];
    for (let i = 0; i < 3 && RUNES.some(has); i++) await s.bot.dropItem(/^(air|earth|water) rune$/i, 'all');
    if (RUNES.some(has)) await fail('could not drop the runes');
    const dropTick = T();
    const inTomb = () => inBox(2520, 9795, 2560, 9850);
    await step('pebble', () => useOnLoc(ITEM.pebble, LOC.tombstone), inTomb, 15, 3);
    milestone(4);
    // The chest can be open or shut (another player); open it if shut, then search the open one in the same try.
    const chestLoc = (id: number) => findLoc(l => l.id === id && l.x === LOC.chest.x && l.z === LOC.chest.z);
    await step('chest', async () => {
        if (!chestLoc(LOC.chestOpen) && !chestLoc(LOC.chestClosed)) { await s.bot.walkTo(LOC.chest.x, LOC.chest.z + 1, 1); return; }
        const shut = chestLoc(LOC.chestClosed);
        if (shut) {
            await opLoc({ id: shut.id, x: shut.x, z: shut.z }, opIndex(shut, /open/i));
            await waitUntil(s, () => !!chestLoc(LOC.chestOpen) || died, { timeoutTicks: 25 });
        }
        const open = chestLoc(LOC.chestOpen);
        if (open) await opLoc({ id: open.id, x: open.x, z: open.z }, opIndex(open, /search/i));
    }, () => has(ITEM.amulet), 10, 5);
    await step('coffin', () => opLoc(LOC.coffin), () => has(ITEM.urn), 30, 3);
    await climb('tomb ladder', 2556, 9844, /climb-up/i, () => (pos()?.worldZ ?? 0) < 4000);
    for (const id of RUNES) {
        await step(`pick rune ${id}`, async () => {
            const g = (st()?.groundItems ?? []).filter((i: any) => i.id === id).sort((a: any, b: any) => a.distance - b.distance)[0];
            if (g) await s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: id, reason: 'SDK' });
        }, () => cnt(id) >= 6, 8, 4);
    }
    console.log(`WARN runes back after ${T() - dropTick} ticks on the ground`);

    // 5. Raft again, rope across, the ledge door with the amulet sets 5 (quest_waterfall.rs2:270).
    await walk('raft 2', [[2511, 3494, 1]]);
    await step('raft 2', () => opLoc(LOC.raft), onIsland, 20);
    await ropeAcross('trip 2');
    const inFalls = () => inBox(2550, 9855, 2610, 9925);
    await step('ledge door', () => opLoc(LOC.ledgeDoor), inFalls, 12, 3);
    milestone(5);

    // 6. Key from the crate in the east room, through the fire giant room, key on the puzzle-room door sets 6.
    await walk('falls crate', [[2589, 9887, 1]]);
    await step('falls crate', () => opLoc(LOC.baxCrate), () => has(ITEM.baxKey), 12, 3);
    // The only way to the door runs 13 tiles through the west room past three fire giant spawns (2562,9886 2565,9887
    // 2568,9889), and their hit can kill from full HP. The bot stops south of the room at full HP, then sends one key
    // use on the door so the server walks it there and opens it without a stop. An eat clears the pending
    // interaction (OpHeldHandler clearPendingAction), so the key use is sent again after each eat.
    await walk('fire giant room', [[2565, 9878, 1]]);
    await topUp('top up', 9);
    const pastGiantDoor = () => inBox(2562, 9894, 2572, 9901);
    crossing = true;
    // Rat shield. npc_check_notcombat (npc_combat.rs2:387) stops any NPC from attacking a player whom another NPC
    // attacked in the last 8 ticks (single-way combat), and a fire giant that tries drops its hunt
    // (npc_default_attack: npc_setmode(null)). A rat has max hit 0 (strengthbonus -53) and 2 HP; auto retaliate is
    // off, so the bot swings once and the rat keeps attacking it. Once the rat has attacked, the bot runs to the door.
    const npcs = (): any[] => st()?.nearbyNpcs ?? [];
    const giantGap = (x: number, z: number): number => {
        let best = 99;
        for (const g of npcs().filter(n => /^fire giant$/i.test(n.name))) {
            const gx = g.tileX ?? g.x, gz = g.tileZ ?? g.z, sz = g.size ?? 2;
            const dx = x < gx ? gx - x : x > gx + sz - 1 ? x - (gx + sz - 1) : 0;
            const dz = z < gz ? gz - z : z > gz + sz - 1 ? z - (gz + sz - 1) : 0;
            best = Math.min(best, Math.max(dx, dz));
        }
        return best;
    };
    const ratHitKeys = (idx: number): Set<string> => new Set((st()?.combatEvents ?? [])
        .filter((e: any) => e.type === 'damage_taken' && e.sourceType === 'npc' && e.sourceIndex === idx)
        .map((e: any) => `${e.tick}:${e.observationId ?? ''}`));
    const ratAttacking = (idx: number, before: Set<string>): boolean => {
        if ([...ratHitKeys(idx)].some(k => !before.has(k))) return true;
        // A 0 hit may not publish a damage event; a rat in combat next to the bot has been hit and retaliates (queue 0).
        const r = npcs().find(n => n.index === idx);
        return !!r && r.inCombat === true && r.distance <= 1;
    };
    const pickRat = (): any => npcs()
        .filter(n => /^rat$/i.test(n.name) && n.reachable !== false && n.distance <= 10)
        .filter(n => inBoxXZ(n.tileX ?? n.x, n.tileZ ?? n.z, 2560, 9873, 2571, 9886) && giantGap(n.tileX ?? n.x, n.tileZ ?? n.z) >= 4)
        .sort((a, b) => a.distance - b.distance)[0];
    let shield = false;
    for (let i = 0; i < 20 && !shield && !died; i++) {
        await guard('rat shield');
        const rat = pickRat();
        if (!rat) { await waitTicks(s, 1); continue; }
        const before = ratHitKeys(rat.index);
        const op = rat.optionsWithIndex?.find((o: any) => /^attack$/i.test(o.text))?.opIndex ?? 2;
        await s.direct({ type: 'interactNpc', npcIndex: rat.index, optionIndex: op, reason: 'SDK' });
        shield = await waitUntil(s, () => ratAttacking(rat.index, before) || died, { timeoutTicks: 10 }) && !died;
        if (shield) await waitTicks(s, 1);
        i += 9;
    }
    console.log(`${shield ? 'INFO' : 'WARN'} rat shield ${shield ? 'on' : 'not seen'} at ${T()} giantGap=${giantGap(pos()?.worldX ?? 0, pos()?.worldZ ?? 0)}`);
    let lastSend = -99;
    let still = 0;
    let prevAt = '';
    for (let i = 0; i < 60 && !pastGiantDoor(); i++) {
        await guard('giant door');
        const at = `${pos()?.worldX},${pos()?.worldZ}`;
        still = at === prevAt ? still + 1 : 0;
        prevAt = at;
        if (lastSend < 0 || lastEat > lastSend || still >= 3) {
            lastSend = s.tick();
            still = 0;
            await useOnLoc(ITEM.baxKey, LOC.giantDoor);
        }
        await waitTicks(s, 1);
    }
    crossing = false;
    await guard('giant door');
    if (!pastGiantDoor()) await fail('step giant door');
    const inPuzzle = () => inBox(2561, 9902, 2570, 9917);
    await step('puzzle door', () => useOnLoc(ITEM.baxKey, LOC.puzzleDoor), inPuzzle, 15, 4);
    milestone(6);

    // 7. One rune of each type on each pillar; every use deletes one rune, a repeat only prints "You remember".
    for (const [px, pz] of PILLARS) {
        for (const id of RUNES) {
            const before = cnt(id);
            const seen0 = msgCount(/remember putting that type/i);
            await step(`pillar ${px},${pz} rune ${id}`, () => useOnLoc(id, { id: LOC.pillar, x: px, z: pz }),
                () => cnt(id) < before || msgCount(/remember putting that type/i) > seen0, 15, 3);
        }
    }
    // A short pillar set makes the statue drop a boulder for 20 damage (quest_waterfall.rs2:435): never risk it.
    if (RUNES.some(has)) await fail(`runes left after the pillars: ${RUNES.map(cnt).join('/')}`);

    // 8. Amulet on Glarial's statue raises the floor (teleport to 2603,9914) and sets 8.
    const raised = () => inBox(2598, 9895, 2610, 9920);
    await step('statue', () => useOnLoc(ITEM.amulet, LOC.statue), raised, 15, 3);
    milestone(8);

    // 10. Urn on the chalice (never op1: that floods the cavern). The reward queue sets 10 and grants the XP.
    if (inv().length > 23) await fail(`needs 5 free slots, has ${28 - inv().length}`);
    await step('chalice', () => useOnLoc(ITEM.urn, LOC.chalice), () => atkXp() > atk0, 15, 3);
    milestone(10);

    off();
    const gained = atkXp() - atk0;
    const strGained = strXp() - str0;
    console.log(`RATE attack ${gained} ${T()}`);
    const ok = gained >= 300_000 && !died;
    await finish([s], ok, `attackXp=${gained} strengthXp=${strGained} ${detail()}`);
} catch (e) { await finish([s], false, String(e)); }
