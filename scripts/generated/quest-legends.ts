// Legends' Quest. Usage: bun scripts/generated/quest-legends.ts <main> [kitB=<main>b] [kitC=<main>c]
// Presets: <main> quest_legends (outside the guild gate), <kitB> quest_legends_kit_b, <kitC> quest_legends_kit_c (helpers
// that wait at the meeting tile 2816,2947 with the tradeable kits; each logs in when the main arrives). Every skill 99.
// LEG_FROM=B|C|D|E and LEG_TO=A|B|C|D|E run a slice: presets quest_legends_b, _c, _d, _e hold the state before that segment.
// Reward: 4 QP, 4 x 7,650 XP of the LEG_TRAIN skills (quests/quest_legends/scripts/radimus_erkle.rs2).
// Route, stages and dialogue answers are adapted from rs-stun-toolkit `legs/legends/seg-a.ts` to `seg-d.ts` (MIT,
// research/stun-toolkit-LICENSE.txt), which ran only in their lockstep sim, with rs2b0t `defs/legends/` (MIT) as a cross-check.
// Our SDK reads no varps, so every step gates on items, position and dialogue text.
//  A  0->5   Guard, Radimus, machete, ship and cart to Shilo, hack into the Kharazi jungle, map it, forester, Gujuo.
//  B  5->12  Cave, Ungadulu, golden bowl, blessing, pure water, trials, rune wall, 7 gems, Book of Binding, Nezikchened.
//  C 12->20  Seeds, the pool dries, bravery potion, winch, ledges, 3 heroes, crystal heart, boulder, Echned's dagger.
//  D 20->45  Viyeldi stabbed, Nezikchened again, sacred water, out, yommi tree, totem, heroes, final Nezikchened, gilded totem.
//  E 45->end Camelot teleport, Radimus, the training, quest complete.
import { openQuest } from './quest-lib';
import { componentId } from '../../packages/core/src/logout';
import { ClientProt } from '../../vendor/rs-sdk/server/webclient/src/io/ClientProt';

const MAIN = process.argv[2]!;
const KIT = { B: process.argv[3] ?? `${MAIN}b`, C: process.argv[4] ?? `${MAIN}c` };
const ORDER = ['A', 'B', 'C', 'D', 'E'];
const FROM = ORDER.indexOf(process.env.LEG_FROM ?? 'A');
const TO = ORDER.indexOf(process.env.LEG_TO ?? 'E');
const TRAIN = (process.env.LEG_TRAIN ?? 'Attack,Defence,Strength,Hitpoints').split(',').map(k => k.trim());

const ITEM = {
    map: 714, comp: 715, machete: 975, axe: 1359, bull: 716, scim: 1333, shark: 385, papyrus: 970, charcoal: 973, coins: 995, logs: 1511, rock: 1480,
    bar: 2357, hammer: 2347, lockpick: 1523, pick: 1275, soul: 566, mind: 558, earth: 557, law: 563, air: 556, water: 555, cosmic: 564,
    bowl: 721, bowlBless: 722, bowlPure: 726, reed: 727, book: 730, seeds: 735, seedsGerm: 736, weedU: 1525, weed: 1526, ardrigalU: 1527, ardrigal: 1528,
    vialWater: 227, vial: 229, weedSol: 737, ardrigalSol: 738, bravery: 739, rope: 954, orb: 567, crystalA: 741, crystalB: 742, crystalC: 743, heart: 744, heartGlow: 745,
    dagger: 746, daggerDone: 747, hat: 740, totem: 749, gift: 750,
};
const GEMS: Array<[number, number, number]> = [[1611, 2771, 9303], [1609, 2764, 9309], [1605, 2757, 9297], [1603, 2767, 9289], [1601, 2774, 9287], [1607, 2781, 9291], [1613, 2772, 9295]];
const PRAYER_POT = [143, 141, 139, 2434];
const SUPER_ATT = [149, 147, 145, 2436];
const SUPER_STR = [161, 159, 157, 2440];
const NPC = { guards: [398, 399], radimus: 400, foresters: [401, 402], barnaby: 381, hajedy: 510, gujuo: 928, ungadulu: 929, nez: 934, viyeldi: 935, san: 936, irvig: 937, ranalph: 938, boulder: 939, deathwing: 79 };
const ANIMALS = [48, 143, 931];
const JUNGLE = [2887, 2889, 2890, 2892, 2893];
const PFM = 14;
type Tile = { x: number; z: number };
type L = { id: number; x: number; z: number };
const loc = (id: number, x: number, z: number): L => ({ id, x, z });
const LOC = {
    gate: loc(2391, 2728, 3349), door: loc(2896, 2728, 3373), cupboard: loc(2885, 2724, 3370),
    shiloWood: loc(2262, 2867, 2952), shiloMetal: loc(2259, 2875, 2952), shiloCart: loc(2216, 2877, 2951),
    caveRock: loc(2902, 2782, 2935), caveExit: loc(2903, 2773, 9342), fireWall: loc(2908, 2788, 9326), fireWallN: loc(2908, 2795, 9333),
    bookcase: loc(2911, 2795, 9339), crevice: loc(2918, 2799, 9341), lockGate: loc(2913, 2809, 9332), lockGateL: loc(2912, 2810, 9332),
    boulder1: loc(2919, 2809, 9327), boulder2: loc(2920, 2809, 9323), boulder3: loc(2921, 2809, 9319), strGate: loc(2923, 2809, 9314), strGateL: loc(2922, 2810, 9314),
    jagged: loc(2926, 2789, 9295), markIn: loc(2927, 2779, 9305), markOut: loc(2927, 2776, 9303), magicGate: loc(2930, 2762, 9313), magicGateN: loc(2930, 2762, 9317),
    reeds: loc(2944, 2836, 2916), pool: loc(2942, 2837, 2915), anvil: loc(2783, 2790, 3101), vine: loc(2575, 2760, 3014), palm: loc(2577, 2870, 3115),
    winch: loc(2934, 2759, 9329), winchRope: loc(2935, 2759, 9329), rope: loc(2958, 2377, 4711), furnace: loc(2966, 2426, 4726), eyeRock: loc(2965, 2410, 4715),
    recess: loc(2969, 2422, 4691), barrier: loc(2971, 2421, 4690), pole: loc(2936, 2793, 2908),
};
const EXIT = /^(Ok,? thanks?|Thanks|Goodbye|Bye|No,? thanks|Nothing|Never ?mind|No, I'm having second thoughts|I'll be going)/i;
const MEET = { x: 2816, z: 2947 };
const GUJUO_SPOT = { x: 2815, z: 2935 };                     // inside kharazi_jungle, usually no animal within 10 tiles
const exact = (n: string) => new RegExp(`^${n}$`, 'i');
const SOIL = { x: 2778, z: 2916 };

type Q = Awaited<ReturnType<typeof openQuest>>;
const helpers: Q[] = [];
const q: Q = await openQuest({ cap: 12000, eatAt: 55, food: [ITEM.shark], others: () => helpers.map(h => h.s) });
try {
    const x = () => q.pos()?.worldX ?? 0;
    const z = () => q.pos()?.worldZ ?? 0;
    const tick = () => q.s.tick();
    const open = () => q.dialogOpen();
    const worn = (id: number) => (q.st()?.equipment ?? []).some((e: any) => e?.id === id);
    const free = () => 28 - q.inv().length;
    const hpMax = () => q.s.sdk.getSkill('Hitpoints')?.baseLevel ?? 99;
    const prayer = () => q.st()?.prayers?.prayerPoints ?? 0;
    const pfmOn = () => !!q.st()?.prayers?.activePrayers?.[PFM];
    // Page text and game messages with a mark: a later step must not match an earlier page.
    const texts: string[] = [];
    let lastText = '', lastHit = -100, hp0 = q.hp(), questDone = false;
    q.s.onTick(() => {
        const d: any = q.s.sdk.getDialog();
        const t = d?.isOpen ? [d.text ?? '', ...(d.allComponents ?? []).map((c: any) => c.text ?? '')].filter(Boolean).join(' ') : '';
        if (t && t !== lastText) { texts.push(t); lastText = t; }
        for (const m of (q.st()?.gameMessages ?? []).slice(-4)) { const k = `#${m.tick}:${m.text}`; if (!texts.slice(-40).includes(k)) texts.push(k); }
        const h = q.hp(); if (h < hp0) lastHit = tick(); hp0 = h;
        if (q.msgCount(/quest complete|completed the.*legends/i) > 0) questDone = true;
    });
    const mark = () => texts.length;
    const seen = (re: RegExp, m: number) => texts.slice(m).some(t => re.test(t));
    const npcsOf = (ids: number[]): any[] => (q.st()?.nearbyNpcs ?? []).filter((n: any) => ids.includes(n.id)).sort((a: any, b: any) => a.distance - b.distance);
    const ground = (id: number): any => (q.st()?.groundItems ?? []).filter((g: any) => g.id === id).sort((a: any, b: any) => a.distance - b.distance)[0];
    const live = (l: L, ids = [l.id]) => q.findLoc((k: any) => k.x === l.x && k.z === l.z && ids.includes(k.id)) ?? l;
    const attack = (n: any) => q.s.direct({ type: 'interactNpc', npcIndex: n.index, optionIndex: n.optionsWithIndex?.find((o: any) => /attack/i.test(o.text))?.opIndex ?? 2, reason: 'SDK' });
    const talkTo = (n: any) => q.talkTo(n);
    const held1 = (id: number) => q.s.direct({ type: 'useInventoryItem', slot: q.slot(id)!, optionIndex: 1, reason: 'SDK' });
    const dropIds = async (ids: number[]) => {
        for (let i = 0; i < 16; i++) {
            const it = q.inv().find((e: any) => ids.includes(e.id));
            if (!it) return;
            await q.guard('drop');
            await q.s.direct({ type: 'dropItem', slot: it.slot, reason: 'SDK' });
            await q.waitTicks(1);
        }
    };
    const pots = () => PRAYER_POT.filter(id => q.has(id)).length;
    const drinkPrayer = async () => { const p = PRAYER_POT.find(id => q.has(id)); if (p) { await held1(p); await q.waitTicks(2); } };
    const pfm = async (on: boolean) => { if (pfmOn() !== on && (!on || prayer() > 0)) await q.s.direct({ type: 'togglePrayer', prayerIndex: PFM, reason: 'SDK' }); };
    // A slot for the next item: rocks, logs and coins go first, then a shark.
    const room = async (n: number) => {
        await dropIds([ITEM.logs, ITEM.rock]);
        for (let k = 0; k < 6 && free() < n; k++) {
            if (q.has(ITEM.coins)) await dropIds([ITEM.coins]);
            else if (q.cnt(ITEM.shark) > 1) { await held1(ITEM.shark); await q.waitTicks(3); }
        }
        if (free() < n) await q.fail(`room ${n}: ${free()} free`);
    };
    const topUp = async (hpFrac: number, prFrac: number) => {
        for (let k = 0; k < 10; k++) {
            if (q.hp() < hpMax() * hpFrac && q.has(ITEM.shark)) await held1(ITEM.shark);
            else if (prayer() < 99 * prFrac && pots()) await drinkPrayer();
            else return;
            await q.waitTicks(3);
        }
    };
    // Answers pages until ok(): the first pattern in list order wins, an unplanned menu takes its exit. `start` is sent every
    // `every` ticks while no page is open. A page that stays open for 8 ticks with no change is closed.
    const drive = async (label: string, pats: RegExp[] | (() => RegExp[]), ok: () => boolean, ticks: number, start?: () => unknown, every = 6): Promise<boolean> => {
        const end = tick() + ticks;
        let last = -99, sig = '', click = -99, page = '', since = tick();
        while (tick() < end) {
            await q.guard(label);
            if (ok()) return true;
            const d: any = q.s.sdk.getDialog();
            if (d?.isOpen) {
                const now = `${d.pageId ?? ''}|${d.text ?? ''}`;
                if (now !== page) { page = now; since = tick(); }
                if (tick() - since >= 8) { await q.s.direct({ type: 'closeModal', reason: 'SDK' }); since = tick(); last = -99; await q.waitTicks(1); continue; }
                if (!d.isWaiting) {
                    const opts = (d.options ?? []).filter((o: any) => !/click here to continue/i.test(o.text));
                    if (opts.length) {
                        const s = opts.map((o: any) => o.text).join('|');
                        if (s !== sig || tick() - click >= 4) {
                            let pick: any;
                            for (const re of typeof pats === 'function' ? pats() : pats) { pick = opts.find((o: any) => re.test(o.text)); if (pick) break; }
                            if (!pick) { console.log(`WARN ${label}: unplanned menu ${s}`); pick = opts.find((o: any) => EXIT.test(o.text)); }
                            if (pick) await q.s.sdk.sendClickDialog(pick.index); else await q.s.direct({ type: 'closeModal', reason: 'SDK' });
                            sig = s; click = tick();
                        }
                    } else await q.s.sdk.sendClickDialog(0);
                }
            } else if (start && tick() - last >= every) { last = tick(); await start(); }
            await q.waitTicks(1);
        }
        return ok();
    };
    const must = async (label: string, r: boolean | Promise<boolean>) => { if (!(await r)) await q.fail(label); };
    const shut = () => drive('pages', [], () => !open(), 15);
    const walk = (label: string, t: Tile, tol = 0) => q.walk(label, [{ ...t, tol }]);
    const opL = (l: L, op = 1, ids?: number[]) => q.opLoc(live(l, ids), op);
    const useL = (item: number, l: L, ids?: number[]) => q.useOnLoc(item, live(l, ids));
    const opUntil = (label: string, l: L, op: number, ok: () => boolean, pats: RegExp[] = [], ticks = 60, every = 6, ids?: number[]) =>
        must(label, drive(label, pats, ok, ticks, () => opL(l, op, ids), every));
    const useUntil = (label: string, item: number, l: L, ok: () => boolean, pats: RegExp[] = [], ticks = 40, every = 6, ids?: number[]) =>
        must(label, drive(label, pats, ok, ticks, () => q.has(item) ? useL(item, l, ids) : undefined, every));
    const useItems = (label: string, a: number, b: number, ok: () => boolean, ticks = 20) => must(label, drive(label, [], ok, ticks, () => q.useOnItem(a, b), 4));

    // ---- Survival ----
    const attackers = () => npcsOf(ANIMALS).filter(n => n.distance <= 1 && !ignored.has(n.index) && (n.targetIndex !== -1 || tick() - lastHit < 6));
    const ignored = new Set<number>();
    const fightOff = async (label: string) => {
        let last = -100, xp0 = q.xp('Hitpoints'), progress = tick();
        for (let j = 0; j < 200 && !open(); j++) {
            await q.guard(label);
            const a = attackers()[0];
            if (!a && tick() - lastHit >= 6) break;
            if (q.xp('Hitpoints') !== xp0 || lastHit === tick()) { xp0 = q.xp('Hitpoints'); progress = tick(); }
            if (a && tick() - progress >= 20) { ignored.add(a.index); console.log(`NOTE ${label}: stalemate with npc ${a.index}, ignored`); break; }
            if (a && tick() - last >= 4) { last = tick(); await attack(a); }
            await q.waitTicks(1);
        }
    };
    // Melee until done(): nearest of ids, or one locked instance; Protect from Melee, prayer and boost upkeep.
    const fight = async (label: string, ids: number[], done: () => boolean, ticks: number, o: { home?: Tile; boost?: boolean } = {}) => {
        let target = -1, last = -100, sip = -100;
        for (let t = 0; t < ticks && !done(); t++) {
            await q.guard(label);
            const d: any = q.s.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) { await q.s.sdk.sendClickDialog(0); await q.waitTicks(1); continue; }
            if (prayer() < 20 && tick() - sip >= 3 && pots()) { sip = tick(); await drinkPrayer(); }
            if (!pfmOn() && prayer() > 0) await pfm(true);
            if (o.boost && tick() - sip >= 3) {
                const boost = (k: string, pots2: number[]) => { const s: any = q.s.sdk.getSkill(k); return s && s.level - s.baseLevel < 8 ? pots2.find(id => q.has(id)) : undefined; };
                const b = boost('Attack', SUPER_ATT) ?? boost('Strength', SUPER_STR);
                if (b) { sip = tick(); await held1(b); }
            }
            const all = npcsOf(ids);
            let n = all.find(k => k.index === target);
            if (!n) { n = all[0]; if (n) { target = n.index; last = -100; } }
            if (!n) { if (o.home && !q.near(o.home.x, o.home.z, 3) && t % 10 === 0) await walk(`${label} home`, o.home, 2); await q.waitTicks(1); continue; }
            if (tick() - last >= (n.distance > 1 ? 4 : 10)) { last = tick(); await attack(n); }
            await q.waitTicks(1);
        }
        await pfm(false);
        if (!done()) await q.fail(`${label}: fight not done`);
    };

    // ---- Jungle ----
    const jungleAt = (cx: number, cz: number) => q.findLoc((l: any) => JUNGLE.includes(l.id) && l.x === cx && l.z === cz);
    // A jungle tree or bush on the next tile is chopped: success moves the bot 2 tiles on. A free tile is walked.
    const hack = async (label: string, cx: number, dir: -1 | 1, untilZ: number) => {
        for (let g = 0; g < 16; g++) {
            await q.guard(label);
            if (dir < 0 ? z() <= untilZ : z() >= untilZ) return;
            if (x() !== cx) await q.dash(`${label} column`, cx, z(), 0, 20);
            const z0 = z(), nz = z0 + dir, l = jungleAt(cx, nz);
            if (!l) { await q.dash(`${label} step`, cx, nz, 0, 8); continue; }
            if (attackers().length) await fightOff(label);
            await q.waitTicks(1);
            let moved = false;
            for (let k = 0; k < 8 && !moved; k++) {
                if (open()) await shut();
                const m = mark();
                await q.opLoc(l, 1);
                await q.waitUntil(() => Math.abs(z() - z0) >= 2 || seen(/blocked off|need an axe|need a machete|lost in this jungle/i, m), 12);
                if (seen(/need an axe|need a machete|lost in this jungle/i, m)) await q.fail(`${label}: axe, machete or notes missing`);
                if (seen(/blocked off/i, m)) await q.waitTicks(4 + 2 * k);
                moved = Math.abs(z() - z0) >= 2;
            }
            if (!moved) await q.fail(`${label}: chop ${cx},${nz}`);
        }
        await q.fail(`${label}: too many steps`);
    };
    const beltNorth = async (label: string) => { await walk(`${label} belt`, { x: 2816, z: 2936 }); await hack(label, 2816, 1, 2940); await dropIds([ITEM.logs]); };
    const beltSouth = async (label: string) => { await walk(`${label} belt`, { x: 2816, z: 2940 }); await hack(label, 2816, -1, 2936); await dropIds([ITEM.logs]); };
    // The swing: every oomlie bird, savage and wolf within 10 tiles rolls 1/6 to take a dislike, then 5/6 Gujuo. A swing within 8
    // ticks of a hit or an eat is "too busy". Gujuo walks up and opens the talk himself; a click during his walk sets both walking.
    let lastSwing = -100, gujuoAt = -1;
    const gujuo = async (label: string, spot: Tile, pats: RegExp[], ok: () => boolean, ticks: number) => {
        await walk(`${label} spot`, spot, 0);
        const start = async () => {
            const a = attackers()[0];
            if (a) return attack(a);
            if (tick() - lastHit < 13) return;
            const g = npcsOf([NPC.gujuo])[0];
            if (!g) gujuoAt = -1; else if (gujuoAt < 0) gujuoAt = tick();
            if (g && (g.distance <= 2 || tick() - gujuoAt >= 9)) return talkTo(g);
            if (g) return;
            if (!q.near(spot.x, spot.z, 1) || z() > 2935) return q.s.direct({ type: 'walkTo', x: spot.x, z: spot.z, running: true, reason: 'SDK' });
            if (tick() - lastSwing >= 10) { lastSwing = tick(); return held1(ITEM.bull); }
        };
        await must(label, drive(label, pats, ok, ticks, start, 3));
    };
    const meet = async (who: 'B' | 'C') => {
        await walk(`meet ${who}`, MEET, 1);
        const name = KIT[who];
        const h = await openQuest({ name, cap: 2000, others: () => [q.s] });
        helpers.push(h);
        if (!(await h.waitUntil(() => (h.st()?.nearbyPlayers ?? []).some((p: any) => p.name.toLowerCase() === MAIN.toLowerCase()), 20))) await q.fail(`kit ${who}: helper does not see the main`);
        const names = [...new Set(h.inv().map((i: any) => i.name as string))];
        console.log(`NOTE kit ${who}: free ${free()}, helper gives ${names.join(', ')}`);
        const want = h.inv().length;
        const serve = q.s.bot.serveTrades({ from: exact(name), maxTrades: 1, timeout: 60_000 });
        const give = await h.s.bot.trade(exact(MAIN), { give: names.map(n => ({ item: exact(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), amount: -1 })), timeout: 60_000 });
        await serve;
        if (!give.success || h.inv().length > 0) await q.fail(`kit ${who}: trade ${JSON.stringify(give).slice(0, 200)} left ${h.inv().length}/${want}`);
        q.milestone(`kit ${who}`);
    };

    // ---- A: guild, map, Gujuo ----
    const segA = async () => {
        if (z() < 3350) await must('guard', drive('guard', [/^What is this place\?$/, /^Can I go on the quest\?$/, /^Yes, I'd like to talk to Grand Vizier Erkle\.$/],
            () => z() >= 3350 && !open(), 120, () => { const n = npcsOf(NPC.guards)[0]; return n ? talkTo(n) : undefined; }));
        q.milestone('gate');
        await walk('study', { x: 2725, z: 3369 }, 1);
        await must('radimus', drive('radimus', [/^Yes actually, what's involved\?$/, /^Yes, it sounds great!$/], () => q.has(ITEM.map) && !open(), 120, () => { const n = npcsOf([NPC.radimus])[0]; return n ? talkTo(n) : undefined; }));
        q.milestone('notes');
        for (let k = 0; k < 8 && !q.has(ITEM.machete); k++) {
            await q.guard('cupboard');
            const openC = q.findLoc((l: any) => l.x === LOC.cupboard.x && l.z === LOC.cupboard.z && l.id === 2886);
            await q.s.direct({ type: 'walkTo', x: 2725, z: k % 2 ? 3371 : 3370, running: true, reason: 'SDK' });
            await q.waitTicks(3);
            await q.opLoc(openC ?? live(LOC.cupboard), openC ? 2 : 1);
            await q.waitUntil(() => q.has(ITEM.machete) || open() || (!openC && !!q.findLoc((l: any) => l.id === 2886)), 8);
            if (open()) await shut();
        }
        if (!q.has(ITEM.machete)) await q.fail('no machete');
        q.milestone('machete');
        await walk('gate inside', { x: 2728, z: 3350 }, 0);
        await opUntil('gate out', LOC.gate, 1, () => z() <= 3349, [], 40, 6);
        await walk('to barnaby', { x: 2681, z: 3275 }, 3);
        await must('barnaby', drive('barnaby', [/^yes please/i], () => q.lvl() === 1 && q.near(2775, 3234, 8), 60, () => { const n = npcsOf([NPC.barnaby])[0]; return n ? talkTo(n) : undefined; }));
        for (let i = 0; i < 8 && q.lvl() !== 0; i++) {
            await q.guard('plank');
            if (open()) { await shut(); continue; }
            const p = q.findLoc((l: any) => /^gangplank$/i.test(l.name));
            if (!p) { await q.waitTicks(2); continue; }
            await q.opLoc(p, q.opIndex(p, /cross/i));
            await q.waitUntil(() => q.lvl() === 0, 10);
        }
        await walk('to hajedy', { x: 2779, z: 3213 }, 3);
        await must('hajedy', drive('hajedy', [/^Yes please, I'd like to go to Shilo Village\.$/], () => q.near(2834, 2951, 4), 60, () => { const n = npcsOf([NPC.hajedy])[0]; return n ? talkTo(n) : undefined; }));
        q.milestone('shilo');
        await walk('shilo gate', { x: 2866, z: 2952 }, 1);
        await opUntil('wood gate', LOC.shiloWood, 1, () => x() >= 2868, [], 40);
        await walk('metal gate', { x: 2874, z: 2952 }, 0);
        await opUntil('metal gate', LOC.shiloMetal, 1, () => x() >= 2875, [], 40);
        await walk('cart', { x: 2876, z: 2952 }, 0);
        await opUntil('cart', LOC.shiloCart, 2, () => x() >= 2880, [], 40);
        await walk('jungle edge', { x: 2866, z: 2941 }, 0);
        q.milestone('edge');
        await hack('in 2866', 2866, -1, 2934);
        const mapHere = async (label: string) => {
            for (let k = 0; k < 8; k++) {
                if (q.has(ITEM.comp)) break;
                if (attackers().length) await fightOff(label);
                if (open()) await shut();
                const m = mark();
                await q.s.direct({ type: 'useInventoryItem', slot: q.slot(ITEM.map)!, optionIndex: 2, reason: 'SDK' });
                await drive(label, [], () => q.has(ITEM.comp) || seen(/still have some sections|already completed this part/i, m), 25);
                if (q.has(ITEM.comp) || seen(/still have some sections|already completed this part/i, m)) { await shut(); return; }
            }
            if (!q.has(ITEM.comp) && label === 'west') await q.fail(`${label}: mapping failed`);
        };
        await mapHere('middle');
        await walk('east', { x: 2882, z: 2932 });
        await mapHere('east');
        await walk('west', { x: 2812, z: 2932 });
        await mapHere('west');
        if (!q.has(ITEM.comp)) await q.fail('map not complete');
        q.milestone('map');
        await walk('exit column', { x: 2819, z: 2936 });
        await hack('out 2819', 2819, 1, 2940);
        await dropIds([ITEM.logs, ITEM.papyrus, ITEM.charcoal, ITEM.coins]);
        await must('forester', drive('forester', [/^Yes, go ahead make a copy!$/], () => q.has(ITEM.bull) && !open(), 160, () => {
            const n = npcsOf(NPC.foresters)[0]; return n ? q.useOnNpc(ITEM.comp, n) : undefined;
        }, 8));
        q.milestone('bullroarer');
        await walk('entry column', { x: 2819, z: 2940 });
        await hack('in 2819', 2819, -1, 2936);
        await dropIds([ITEM.logs]);
        const m = mark();
        await gujuo('gujuo rescue', { x: 2840, z: 2925 }, [/^I was hoping to attract the attention of a native\.$/, /^I want to develop friendly relations with your people\.$/,
            /^Can you get your people together\?$/, /^What can we do instead then\?$/, /^How do we make the totem pole\?$/, /^I will release Ungadulu\.\.\.$/],
            () => seen(/Gujuo disappears into the Kharazi Jungle/i, m) && !open(), 600);
        q.milestone('A');
    };

    // ---- B: Ungadulu, bowl, trials, book, Nezikchened ----
    const inCave = () => z() > 9000;
    const enterCave = async (label: string) => {
        await walk(`${label} rocks`, { x: 2781, z: 2933 }, 1);
        if (attackers().length) await fightOff(label);
        await opUntil(`${label} crawl`, LOC.caveRock, 1, inCave, [/^Yes, I'll crawl through/], 90, 6);
    };
    const leaveCave = async () => { await walk('cave exit', { x: 2773, z: 9341 }, 1); await opUntil('cave exit', LOC.caveExit, 1, () => !inCave(), [], 40, 6); };
    const trialsIn = async () => {
        await opUntil('bookcase', LOC.bookcase, 2, () => x() >= 2799, [/^Yes please!$/], 90, 6);
        await walk('lock gate', { x: 2809, z: 9333 }, 1);
        await opUntil('lock gate', LOC.lockGate, 2, () => z() <= 9331 && !open(), [], 200, 8);
        for (const [b, zz] of [[LOC.boulder1, 9326], [LOC.boulder2, 9322], [LOC.boulder3, 9318]] as Array<[L, number]>) await opUntil('boulder', b, 1, () => z() <= zz, [], 60, 6);
        await opUntil('strength gate', LOC.strGate, 1, () => z() <= 9313 && !open(), [/^Yes, I'm very strong, I'll force them open\.$/, /^Yes, I'll try to push through\.$/], 120, 8);
        await walk('jagged wall', { x: 2790, z: 9295 }, 0);
        await opUntil('jagged wall', LOC.jagged, 2, () => z() >= 9296, [], 40, 8);
    };
    const pureWater = async () => {
        await room(1);
        await walk('reeds', { x: 2836, z: 2917 }, 2);
        await useUntil('reed', ITEM.machete, LOC.reeds, () => q.has(ITEM.reed), [], 60);
        await useUntil('pool', ITEM.reed, LOC.pool, () => q.has(ITEM.bowlPure), [], 30);
        await shut();
    };
    const segB = async () => {
        await enterCave('cave 1');
        await walk('fire wall', { x: 2787, z: 9326 }, 0);
        await opUntil('ungadulu', LOC.fireWall, 2, () => (q.s.sdk.getDialog()?.options ?? []).some((o: any) => /^Where do I get pure water from\?$/.test(o.text)) && !(q.s.sdk.getDialog()?.options ?? []).some((o: any) => /^Who are you\?$/.test(o.text)), [/^Who are you\?$/], 90, 6);
        await q.s.direct({ type: 'closeModal', reason: 'SDK' });
        await q.waitTicks(1);
        q.milestone('ungadulu');
        await leaveCave();
        let m = mark();
        await gujuo('gujuo water', GUJUO_SPOT, [/^I need some pure water to douse some magic flames\.$/, /^Ok, thanks\.\.\. Goodbye\.$/, /^Ok thanks for your help\.$/], () => seen(/Gujuo disappears/i, m) && !open(), 500);
        q.milestone('water asked');
        await beltNorth('out B');
        await meet('B');
        await walk('anvil', { x: 2790, z: 3100 }, 1);
        for (let k = 0; k < 4 && !q.has(ITEM.bowl); k++) {
            const m2 = mark();
            await drive('bowl', [/^Yes$/], () => q.has(ITEM.bowl) || (!open() && seen(/make a mistake/i, m2)), 40, () => useL(ITEM.bar, LOC.anvil), 6);
            if (!q.has(ITEM.bowl) && q.cnt(ITEM.bar) < 2) await q.fail('out of gold bars');
        }
        if (!q.has(ITEM.bowl)) await q.fail('no golden bowl');
        await shut();
        await dropIds([ITEM.hammer, ITEM.bar]);
        q.milestone('bowl');
        await beltSouth('in B');
        await walk('bless spot', GUJUO_SPOT, 1);
        for (let k = 0; k < 20 && !q.has(ITEM.bowlBless); k++) {
            await q.guard('bless');
            if (prayer() < 42) await drinkPrayer();
            if (prayer() < 42) await q.fail('prayer below 42 and no potion for the blessing');
            await gujuo('bless', GUJUO_SPOT, [/^Yes, I'd like (you )?to bless my gold bowl\.$/, /^Ok thanks for your help\.$/, /^Ok, thanks\.\.\. Goodbye\.$/], () => (q.has(ITEM.bowlBless) && !open()) || (prayer() < 42 && !open()), 300);
        }
        if (!q.has(ITEM.bowlBless)) await q.fail('bowl not blessed');
        q.milestone('blessed');
        await pureWater();
        q.milestone('pure water');
        await enterCave('cave 2');
        await walk('bookcase', { x: 2795, z: 9338 }, 2);
        await trialsIn();
        const m3 = mark();
        for (const r of [ITEM.soul, ITEM.mind, ITEM.earth, ITEM.law, ITEM.law]) {
            const n0 = q.cnt(r);
            await must(`rune ${r}`, drive(`rune ${r}`, [], () => q.cnt(r) < n0, 40, () => useL(r, LOC.markIn), 6));
            if (seen(/burns red hot/i, m3)) await q.fail('rune wall refused a rune');
            await drive('rune pages', [], () => !open() || (q.s.sdk.getDialog()?.options ?? []).length > 1, 10);
        }
        await must('wall in', drive('wall in', [/^Yes, I'll go through!$/], () => x() <= 2775 && z() <= 9302, 30));
        await shut();
        q.milestone('gem room');
        for (const [g, gx, gz] of GEMS) {
            await walk(`gem ${g}`, { x: gx, z: gz }, 2);
            await must(`gem ${g}`, drive(`gem ${g}`, [], () => !q.has(g), 60, () => useL(g, loc(2928, gx, gz)), 6));
        }
        await q.waitUntil(() => !!ground(ITEM.book), 45);
        await must('book', drive('book', [], () => q.has(ITEM.book), 40, () => { const g = ground(ITEM.book); return g ? q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' }) : undefined; }, 4));
        q.milestone('book');
        await walk('wall out', { x: 2775, z: 9303 }, 1);
        await opUntil('wall out', LOC.markOut, 1, () => x() >= 2780 && z() >= 9305, [], 60, 6);
        await walk('jagged back', { x: 2789, z: 9296 }, 0);
        await opUntil('jagged back', LOC.jagged, 2, () => z() <= 9295, [], 40, 8);
        await trialsBack();
        await walk('fire wall 2', { x: 2787, z: 9326 }, 0);
        await useUntil('octagram', ITEM.bowlPure, LOC.fireWall, () => x() >= 2789, [], 30);
        await topUp(0.85, 0);
        const m4 = mark();
        await must('summon', drive('summon', [], () => npcsOf([NPC.nez]).length > 0 && !open(), 60, () => { const n = npcsOf([NPC.ungadulu])[0]; return n ? q.useOnNpc(ITEM.book, n) : undefined; }, 5));
        await fight('nezikchened', [NPC.nez], () => seen(/pile of ashes/i, m4), 600);
        await shut();
        await topUp(0.8, 0);
        q.milestone('B');
    };
    const trialsBack = async () => {
        // A death wing hit closes every gate page, and each leaf answers only from its own tile.
        for (let k = 0; k < 8 && z() < 9314; k++) {
            await q.guard('str gate back');
            const near = () => npcsOf([NPC.deathwing]).filter(w => w.distance <= 3 && w.z < 9314);
            if (near().length) await fight('death wing', [NPC.deathwing], () => !near().length, 60);
            const [leaf, tile] = k % 2 ? [LOC.strGate, { x: 2809, z: 9313 }] : [LOC.strGateL, { x: 2810, z: 9313 }];
            await walk('str gate back', tile, 0);
            await drive('str gate back', [/^Yes, I'm very strong, I'll force them open\.$/], () => z() >= 9314 && !open(), 50, () => opL(leaf, 1), 8);
        }
        if (z() < 9314) await q.fail('str gate back');
        for (const [b, zz] of [[LOC.boulder3, 9321], [LOC.boulder2, 9325], [LOC.boulder1, 9329]] as Array<[L, number]>) await opUntil('boulder back', b, 1, () => z() >= zz, [/^Yes, I'll try to climb out\.$/], 60, 6);
        await walk('lock back', { x: 2810, z: 9331 }, 1);
        await opUntil('lock back', LOC.lockGateL, 1, () => z() >= 9332 && !open(), [], 60, 8);
        await walk('crevice', { x: 2800, z: 9340 }, 1);
        await opUntil('crevice', LOC.crevice, 2, () => x() <= 2798, [/^Yes please!$/], 60, 6);
    };

    // ---- C: seeds, dried pool, potion, winch, heroes, heart, dagger ----
    const chain = async (obstacles: Array<[L, Tile | undefined, () => boolean]>) => {
        for (const [l, stand, ok] of obstacles) {
            if (stand) await walk(`to ${l.id}`, stand, 0);
            await opUntil(`obstacle ${l.id}`, l, 1, ok, [/nothing more exciting/i, /want to climb over/i], 60, 8);
        }
    };
    const segC = async () => {
        if (process.env.LEG_C2 !== '1') {
        await dropIds([ITEM.book, ITEM.hammer, ITEM.bar, ITEM.rock, ITEM.logs]);
        await room(1);
        await must('seeds', drive('seeds', [/Yommi tree seeds for Gujuo/i], () => q.has(ITEM.seeds) && !open(), 60, () => { const n = npcsOf([NPC.ungadulu])[0]; return n ? talkTo(n) : undefined; }));
        await q.s.direct({ type: 'closeModal', reason: 'SDK' });
        await must('germinate', drive('germinate', [], () => q.has(ITEM.seedsGerm) && !open(), 30, () => q.useOnItem(ITEM.seeds, ITEM.bowlPure), 4));
        q.milestone('seeds');
        await opUntil('octagram out', LOC.fireWallN, 1, () => z() >= 9334, [], 30, 4);
        await leaveCave();
        await room(1);
        await walk('reeds', { x: 2836, z: 2917 }, 2);
        await useUntil('reed', ITEM.machete, LOC.reeds, () => q.has(ITEM.reed), [], 40, 4);
        const m = mark();
        await useUntil('dry pool', ITEM.reed, LOC.pool, () => seen(/pool has dried up/i, m), [], 30, 4);
        await shut();
        q.milestone('pool dry');
        }
        await gujuo('gujuo recipe', GUJUO_SPOT, [/water pool has dried up/i, /Where is the source of the spring/i, /If I went, could you help me/i],
            () => (q.s.sdk.getDialog()?.options ?? []).some((o: any) => /Where can I find Snake weed/i.test(o.text)), 400);
        await q.s.direct({ type: 'closeModal', reason: 'SDK' });
        await q.waitTicks(1);
        q.milestone('recipe');
        await beltNorth('out C');
        await dropIds([ITEM.bull, ITEM.reed, ITEM.logs]);
        await meet('C');
        await room(1);
        await walk('vine', { x: 2761, z: 3013 }, 3);
        await opUntil('vine', LOC.vine, 2, () => q.has(ITEM.weedU) || q.has(ITEM.weed), [], 40, 5);
        await must('weed id', drive('weed id', [], () => q.has(ITEM.weed), 15, () => held1(ITEM.weedU), 3));
        await useItems('weed mix', ITEM.weed, ITEM.vialWater, () => q.has(ITEM.weedSol));
        await room(1);
        await walk('palm', { x: 2869, z: 3115 }, 3);
        await opUntil('palm', LOC.palm, 2, () => q.has(ITEM.ardrigalU) || q.has(ITEM.ardrigal), [], 40, 5);
        await must('ardrigal id', drive('ardrigal id', [], () => q.has(ITEM.ardrigal), 15, () => held1(ITEM.ardrigalU), 3));
        await useItems('bravery', ITEM.ardrigal, ITEM.weedSol, () => q.has(ITEM.bravery));
        await must('drink', drive('drink', [/bravely drink/i], () => !q.has(ITEM.bravery) && !open(), 30, () => held1(ITEM.bravery), 6));
        q.milestone('brave');
        await beltSouth('in C');
        await walk('cave rocks', { x: 2781, z: 2933 }, 1);
        await opUntil('crawl', LOC.caveRock, 1, inCave, [/crawl through/i], 90, 6);
        await walk('bookcase', { x: 2795, z: 9338 }, 2);
        await trialsIn();
        await walk('rune door', { x: 2780, z: 9305 }, 2);
        await opUntil('rune door', LOC.markIn, 1, () => q.near(2774, 9301, 1), [], 40, 8);
        await walk('magic gate', { x: 2763, z: 9312 }, 0);
        await must('magic gate', drive('magic gate', [], () => z() >= 9320 && !open(), 40, () => {
            // The SDK has no spell-on-loc action: OPLOCT is x, z, loc id, spell component (Client.ts TGT_LOC).
            const c: any = (q.s as any).client, g = LOC.magicGate;
            c.writeOpcode(ClientProt.OPLOCT); c.out.p2(g.x); c.out.p2(g.z); c.out.p2(g.id); c.out.p2(componentId('magic:water_orb')); c.flush?.();
        }, 6));
        q.milestone('magic gate');
        await walk('winch', { x: 2760, z: 9328 }, 2);
        await useUntil('rope', ITEM.rope, LOC.winch, () => !q.has(ITEM.rope), [], 20, 4);
        await opUntil('winch', LOC.winchRope, 1, () => x() < 2500, [/shimmy down/i], 40, 8, [2934, 2935]);
        await shut();
        q.milestone('caves');
        await chain([
            [loc(2959, 2377, 4717), undefined, () => x() <= 2376],
            [loc(2960, 2377, 4728), { x: 2377, z: 4727 }, () => x() >= 2378 && z() >= 4728],
            [loc(2961, 2382, 4729), { x: 2382, z: 4730 }, () => z() <= 4728 && x() >= 2382],
            [loc(2962, 2387, 4728), undefined, () => x() >= 2388],
            [loc(2963, 2390, 4724), undefined, () => z() <= 4723],
            [loc(2964, 2390, 4718), undefined, () => z() <= 4717],
        ]);
        for (const [id, crystal, home] of [[NPC.san, ITEM.crystalA, { x: 2386, z: 4707 }], [NPC.irvig, ITEM.crystalB, { x: 2402, z: 4706 }], [NPC.ranalph, ITEM.crystalC, { x: 2409, z: 4699 }]] as Array<[number, number, Tile]>) {
            await room(1);
            await topUp(0.8, 0.6);
            await walk(`hero ${id}`, home, 3);
            await fight(`hero ${id}`, [id], () => q.has(crystal), 400, { home });
            await shut();
        }
        q.milestone('crystals');
        await walk('furnace', { x: 2425, z: 4725 }, 3);
        for (const c of [ITEM.crystalA, ITEM.crystalB, ITEM.crystalC]) await useUntil(`furnace ${c}`, c, LOC.furnace, () => !q.has(c), [], 30, 5);
        await must('heart', drive('heart', [], () => (q.has(ITEM.heart) || q.has(ITEM.heartGlow)) && !open(), 25));
        await walk('eye rock', { x: 2409, z: 4716 }, 2);
        await useUntil('eye rock', ITEM.heart, LOC.eyeRock, () => q.has(ITEM.heartGlow) && !open(), [], 30, 5);
        await walk('recess', { x: 2421, z: 4692 }, 2);
        await useUntil('recess', ITEM.heartGlow, LOC.recess, () => !q.has(ITEM.heartGlow) && !open(), [], 30, 5);
        await opUntil('barrier', LOC.barrier, 1, () => z() <= 4690, [], 20, 5);
        q.milestone('barrier');
        await room(1);
        await walk('boulder', { x: 2388, z: 4690 }, 3);
        await must('echned', drive('echned', [/^Er\.\.\. me/i, /need it for my quest/i, /What can I do about that/i, /do what I must/i, /^Ok, I'll do it/i], () => q.has(ITEM.dagger) && !open(), 120, () => {
            const b = npcsOf([NPC.boulder]).filter(n => n.z <= 4692)[0];
            return b ? q.s.direct({ type: 'interactNpc', npcIndex: b.index, optionIndex: 1, reason: 'SDK' }) : undefined;
        }, 10));
        q.milestone('C');
    };

    // ---- D: Viyeldi, water, tree, totem, final fight ----
    const pocket = (): string => {
        const px = x(), pz = z();
        if (px < 2368 || px > 2431 || pz < 4702 || pz > 4740) return 'C';
        if (px >= 2378 && px <= 2380 && pz >= 4711 && pz <= 4717) return 'A';
        if (px >= 2375 && px <= 2377 && pz >= 4717 && pz <= 4727) return 'K';
        if ((px === 2378 && pz >= 4728 && pz <= 4730) || (px >= 2379 && px <= 2382 && pz >= 4729 && pz <= 4730)) return 'E';
        if ((px >= 2382 && px <= 2384 && pz === 4728) || (px >= 2384 && px <= 2387 && pz >= 4726 && pz <= 4727)) return 'F';
        if (px >= 2388 && px <= 2391 && pz >= 4725 && pz <= 4730) return 'H';
        if (px >= 2390 && px <= 2391 && pz >= 4719 && pz <= 4723) return 'I';
        return 'C';
    };
    const toLanding: Record<string, [L, Tile, string]> = {
        C: [loc(2964, 2390, 4718), { x: 2390, z: 4717 }, 'I'], I: [loc(2963, 2390, 4724), { x: 2390, z: 4723 }, 'H'], H: [loc(2962, 2387, 4728), { x: 2388, z: 4728 }, 'F'],
        F: [loc(2961, 2382, 4729), { x: 2382, z: 4728 }, 'E'], E: [loc(2960, 2377, 4728), { x: 2378, z: 4728 }, 'K'], K: [loc(2959, 2377, 4717), { x: 2376, z: 4717 }, 'A'],
    };
    const toCave: Record<string, [L, Tile, string]> = {
        A: [loc(2959, 2377, 4717), { x: 2378, z: 4717 }, 'K'], K: [loc(2960, 2377, 4728), { x: 2377, z: 4727 }, 'E'], E: [loc(2961, 2382, 4729), { x: 2382, z: 4730 }, 'F'],
        F: [loc(2962, 2387, 4728), { x: 2387, z: 4727 }, 'H'], H: [loc(2963, 2390, 4724), { x: 2390, z: 4725 }, 'I'], I: [loc(2964, 2390, 4718), { x: 2390, z: 4719 }, 'C'],
    };
    const traverse = async (table: Record<string, [L, Tile, string]>, goal: string) => {
        for (let k = 0; k < 10 && pocket() !== goal; k++) {
            const from = pocket(), step = table[from];
            if (!step) await q.fail(`no way from pocket ${from}`);
            const [l, stand, next] = step!;
            await walk(`pocket ${from}`, stand, 0);
            // A fall lands in the main cave; a tile on the climb itself reads as no pocket, so only a still bot counts.
            let at = '', still = 0;
            const arrived = () => { const here = `${x()},${z()}`; still = here === at ? still + 1 : 0; at = here; return !open() && (pocket() === next || (pocket() !== from && still >= 4)); };
            await opUntil(`pocket ${from} to ${next}`, l, 1, arrived, [/nothing more exciting/i, /want to climb over/i], 60, 10);
        }
        if (pocket() !== goal) await q.fail(`pocket ${pocket()}, wanted ${goal}`);
    };
    const north = () => z() >= 4691;                          // north of the barrier, in the caves
    const toRope = async () => {
        if (!north()) { await walk('barrier', { x: 2421, z: 4690 }, 0); await opUntil('barrier north', LOC.barrier, 1, north, [], 30, 6); }
        await traverse(toLanding, 'A');
    };
    const segD = async () => {
        const boulderAt = [{ x: 2373, z: 4692 }, { x: 2386, z: 4689 }, { x: 2392, z: 4678 }].sort((a, b) => q.cheb(a.x, a.z) - q.cheb(b.x, b.z))[0]!;
        const pushStand = { x: boulderAt.x + 2, z: boulderAt.z };
        await toRope();
        q.milestone('landing');
        let stab = -100, take = -100;
        for (let t = 0; t < 120 && !q.has(ITEM.daggerDone); t++) {
            await q.guard('viyeldi');
            const v = npcsOf([NPC.viyeldi])[0];
            if (v && q.has(ITEM.dagger) && tick() - stab >= 3) { stab = tick(); await q.useOnNpc(ITEM.dagger, v); }
            else if (!v && open()) await q.s.sdk.sendClickDialog(0);
            else if (!v && tick() - take >= 6) { take = tick(); await q.s.direct({ type: 'pickupItem', x: 2379, z: 4712, itemId: ITEM.hat, reason: 'SDK' }); }
            await q.waitTicks(1);
        }
        if (!q.has(ITEM.daggerDone)) await q.fail('viyeldi not stabbed');
        await q.waitUntil(() => !npcsOf([NPC.viyeldi]).length, 14);
        await shut();
        q.milestone('viyeldi');
        await traverse(toCave, 'C');
        await walk('barrier south', { x: 2421, z: 4691 }, 0);
        await opUntil('barrier south', LOC.barrier, 1, () => !north(), [], 30, 6);
        await walk('push stand', pushStand, 0);
        await topUp(0.7, 0.5);
        const m = mark();
        const pushBoulder = () => { const b = npcsOf([NPC.boulder]).filter(n => q.cheb(n.x, n.z) <= 4)[0]; return b ? q.s.direct({ type: 'interactNpc', npcIndex: b.index, optionIndex: 1, reason: 'SDK' }) : undefined; };
        await must('reveal', drive('reveal', [], () => npcsOf([NPC.nez]).length > 0, 60, pushBoulder, 8));
        await fight('nezikchened water', [NPC.nez], () => seen(/falls to the floor in a pile of ashes/i, m), 900, { boost: true });
        await shut();
        q.milestone('nez water');
        for (let k = 0; k < 6 && !q.has(ITEM.bowlPure); k++) {
            await q.guard('sacred water');
            await walk('push stand 2', pushStand, 0);
            const m2 = mark();
            await drive('push', [], () => seen(/^(#\d+:)?You push the boulder|already/i, m2), 16, pushBoulder, 6);
            await shut();
            await drive('fill', [], () => q.has(ITEM.bowlPure), 14, () => { const p = q.findLoc((l: any) => l.id === 2941); return p ? q.useOnLoc(ITEM.bowlBless, p) : undefined; }, 4);
        }
        if (!q.has(ITEM.bowlPure)) await q.fail('no sacred water');
        await shut();
        q.milestone('sacred water');
        await toRope();
        await walk('rope', { x: 2378, z: 4712 }, 1);
        await opUntil('rope up', LOC.rope, 1, () => z() > 9000, [], 30, 6);
        await walk('magic gate back', { x: 2762, z: 9319 }, 1);
        await opUntil('magic gate back', LOC.magicGateN, 1, () => z() <= 9313, [], 30, 8);
        await walk('wall back', { x: 2775, z: 9303 }, 1);
        await opUntil('wall back', LOC.markOut, 1, () => x() >= 2778, [], 40, 8);
        await walk('jagged back', { x: 2789, z: 9296 }, 0);
        await opUntil('jagged back', LOC.jagged, 2, () => z() <= 9295, [], 40, 10);
        const wing = npcsOf([NPC.deathwing]).filter(n => n.distance <= 3)[0];
        if (wing) await fight('death wing', [NPC.deathwing], () => !npcsOf([NPC.deathwing]).some(n => n.distance <= 3), 60);
        await trialsBack();
        await walk('cave exit', { x: 2773, z: 9341 }, 0);
        await opUntil('cave exit', LOC.caveExit, 1, () => z() < 4000, [], 40, 8);
        q.milestone('surface');
        await walk('soil', { x: 2779, z: 2919 }, 1);
        const soil = (id: number) => loc(id, SOIL.x, SOIL.z);
        let planted = false;
        for (let k = 0; k < 6 && !planted; k++) {
            if (!q.has(ITEM.seedsGerm)) await q.fail('every seed withered');
            const m3 = mark();
            await drive('plant', [], () => seen(/plant the Yommi tree seed|withers and dies/i, m3), 30, () => useL(ITEM.seedsGerm, soil(2956)), 8);
            await q.waitTicks(3);
            planted = seen(/plant the Yommi tree seed/i, m3) && !seen(/withers and dies/i, m3);
            await shut();
        }
        if (!planted) await q.fail('not planted');
        for (const [id, item, a, b] of [[2946, ITEM.bowlPure, /water the Yommi tree/i, /tall enough now/i], [2948, ITEM.axe, /prepare to chop/i, /chop the Yommi tree down/i], [2950, ITEM.axe, /professionally wield/i, /trim the branches/i], [2952, ITEM.axe, /professionally wield/i, /carve a wonderful totem pole/i]] as Array<[number, number, RegExp, RegExp]>) {
            const m4 = mark();
            await drive(`tree ${id}`, [], () => seen(a, m4), 40, () => { const l = q.findLoc((k: any) => k.id === id); return l ? q.useOnLoc(item, l) : undefined; }, 8);
            await drive(`tree ${id} end`, [], () => seen(b, m4), 12);
            if (!seen(b, m4)) await q.fail(`tree stage ${id}`);
        }
        await shut();
        if (!free()) await dropIds([ITEM.seedsGerm]);
        await must('totem', drive('totem', [], () => q.has(ITEM.totem), 40, () => { const l = q.findLoc((k: any) => k.id === 2954); return l ? q.opLoc(l, 1) : undefined; }, 5));
        q.milestone('totem');
        await topUp(0.8, 0.7);
        await walk('pole', { x: 2792, z: 2909 }, 2);
        const m5 = mark();
        await useUntil('evil pole', ITEM.totem, LOC.pole, () => seen(/defile my sanctuary/i, m5), [], 120, 8);
        await fight('final', [NPC.nez, NPC.san, NPC.irvig, NPC.ranalph], () => seen(/Heard it all before|final killing blow/i, m5), 1500, { boost: true });
        await q.waitTicks(8);
        await useUntil('pole', ITEM.totem, LOC.pole, () => !q.has(ITEM.totem), [], 40, 8);
        await must('gift', drive('gift', [], () => q.has(ITEM.gift), 150, () => { const n = npcsOf([NPC.gujuo])[0]; return n ? talkTo(n) : undefined; }, 10));
        await shut();
        q.milestone('D');
    };

    // ---- E: Radimus ----
    const segE = async () => {
        if (!q.has(ITEM.gift) || !q.has(ITEM.comp)) await q.fail('E needs the gilded totem and the map');
        if (attackers().length) await fightOff('E');
        const x0 = x(), z0 = z();
        await q.step('camelot teleport', () => q.s.direct({ type: 'clickComponent', componentId: componentId('magic:camelot_teleport'), reason: 'SDK' }), () => q.cheb(x0, z0) > 40, 8, 4);
        await walk('guild gate', { x: 2728, z: 3348 }, 0);
        await opUntil('guild gate', LOC.gate, 1, () => z() >= 3350 && !open(), [], 40, 6);
        await walk('study', { x: 2725, z: 3369 }, 1);
        await must('hand in', drive('hand in', [], () => !q.has(ITEM.gift) && !q.has(ITEM.comp) && !open(), 80, () => { const n = npcsOf([NPC.radimus])[0]; return n ? talkTo(n) : undefined; }));
        q.milestone('hand in');
        await walk('main doors', { x: 2728, z: 3372 }, 1);
        await opUntil('main doors', LOC.door, 1, () => z() >= 3374, [], 40, 6);
        const xp0 = new Map(TRAIN.map(k => [k, q.xp(k)]));
        const pick = () => { const left = TRAIN.filter(k => q.xp(k) === xp0.get(k)); return [/^Yes, I'll train now\.$/, ...left.map(k => new RegExp(`^\\* ${k} \\*$`)), /Go to Skill Menu/]; };
        await must('training', drive('training', pick, () => questDone, 240, () => { const n = npcsOf([NPC.radimus]).filter(k => k.z >= 3373)[0]; return n ? talkTo(n) : undefined; }, 8));
        await q.s.direct({ type: 'closeModal', reason: 'SDK' });
        q.milestone('E');
    };

    const segs = [segA, segB, segC, segD, segE];
    for (let i = FROM; i <= TO; i++) await segs[i]!();
    await q.end(TO < 4 || questDone, `qp=4 from=${ORDER[FROM]} to=${ORDER[TO]} questDone=${questDone}`);
} catch (e) {
    await q.fail(`error ${(e as Error).message}`);
}
