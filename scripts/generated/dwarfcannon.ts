// Dwarf Cannon from preset quest_dwarfcannon (2572,3464,0 beside the Dwarf Commander; Haggis levels after Waterfall:
// Crafting and Smithing 99, Magic 99, Hitpoints 97; 8 lobsters, 2 law + 8 air + 1 water runes). Reward at 25x: 18,750
// Crafting XP and 1 QP (quest_mcannon.rs2:24-26), plus 30 Crafting XP per cannon part.
// Server truth: vendor/rs-sdk/server/content/scripts/quests/quest_mcannon/scripts/*.rs2 (%mcannon 0..11).
// Loc spots come from the maps (m39_54, m40_53, m40_54, m40_153, m47_53 .jm2); ids from pack/loc.pack, obj.pack.
// The SDK state has no varps, so each MILESTONE is printed on the observed effect of the step that sets the varp.
// Random parts (handled): a railing fix rolls stat_random(crafting, 60, 150) and a fail cuts for stat_base(hp)/10, max 3
// (railings.rs2:72-91); a cannon inspect or repair rolls stat_random(smithing, 80, 300) | stat_random(crafting, 80, 350)
// (mcannon_broken_cannon.rs2:89-96). Each roll is retried until it lands.
// Travel: Falador teleport to Nulodion (154 tiles) and Camelot teleport back (265 tiles), instead of 741 tiles each way.
import { openBot, finish } from '../../packages/core/src/bot';
import { waitTicks, waitUntil } from '../../packages/core/src/ticks';
import { sessionWalker, walkPath, type PathPoint } from '../../packages/core/src/walk';
import { componentId } from '../../packages/core/src/logout';

const LOC = {
    towerLadder: { id: 1747, x: 2570, z: 3441 },     // ladders.rs2:52, 0_40_53_10_49 (needs %mcannon >= 2)
    towerLadder1: { id: 1747, x: 2570, z: 3443 },    // level 1 -> 2
    towerTop2: { id: 1746, x: 2570, z: 3443 },       // level 2 -> 1
    towerTop1: { id: 1746, x: 2570, z: 3441 },       // level 1 -> 0
    cave: { id: 2, x: 2622, z: 3392 },               // mcannoncave: teleport to 2620,9797
    crate: { id: 1, x: 2571, z: 9850 },              // mcannoncrateboy
    mud: { id: 13, x: 2621, z: 9796 },               // mcanmudpile: back to 2623,3391
    shedDoor: { id: 4, x: 2576, z: 3461 },           // mcannondoor1 (needs %mcannon >= 6)
    nulodionDoor: { id: 3, x: 3015, z: 3453 },       // mcannondoor (needs %mcannon >= 9), west wall of the porch
    cannon: { id: 5, x: 2577, z: 3461 },             // broken_multicannon
};
// The six broken railings, mcannonrailing1-6 (loc 15-20), far end first, so the last one is beside the commander.
const RAILINGS = [
    { id: 15, x: 2556, z: 3475 }, { id: 16, x: 2558, z: 3472 }, { id: 17, x: 2557, z: 3464 },
    { id: 18, x: 2559, z: 3462 }, { id: 19, x: 2564, z: 3460 }, { id: 20, x: 2572, z: 3460 },
];
const ITEM = { remains: 0, toolkit: 1, notes: 3, mould: 4, railing: 14, lobster: 379 };
const PARTS = ['Pipe', 'Barrel', 'Axle', 'Shaft'];
const LAWGOF = { x: 2571, z: 3463 };
const NULODION = { x: 3011, z: 3453 };
const LUMBRIDGE = { x: 3222, z: 3218 };
const CAP = 3000;
const EAT_AT = 40;
const TRACE = process.env.DC_TRACE === '1';

const s = await openBot(process.argv[2]!);
try {
    await waitTicks(s, 3);
    const st = (): any => s.sdk.getState();
    const pos = (): any => st()?.player;
    const inv = (): any[] => st()?.inventory ?? [];
    const hp = (): number => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const xp = (k: string): number => s.sdk.getSkillXp(k) ?? 0;
    const cnt = (id: number): number => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const has = (id: number): boolean => cnt(id) > 0;
    const cheb = (x: number, z: number): number => { const p = pos(); return p ? Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) : 999; };
    const near = (x: number, z: number, r: number): boolean => cheb(x, z) <= r;
    const lvl = (): number => pos()?.level ?? -1;
    const dialogOpen = (): boolean => !!s.sdk.getDialog()?.isOpen;
    const sawText = (re: RegExp): boolean => {
        const d: any = s.sdk.getDialog();
        if (d?.text && re.test(d.text)) return true;
        return (st()?.recentDialogs ?? []).some((e: any) => re.test((e.text ?? []).join(' ')));
    };
    const msgCount = (re: RegExp): number => (st()?.gameMessages ?? []).filter((m: any) => m.type === 0 && re.test(m.text)).length;

    // Auto retaliate off (controls:com_3): a goblin hit never turns a walk or a loc click into a fight.
    await s.direct({ type: 'clickComponent', componentId: 151, reason: 'SDK' });
    const craft0 = xp('Crafting');
    const SK = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Crafting', 'Smithing'];
    const xp0: Record<string, number> = Object.fromEntries(SK.map(k => [k, xp(k)]));
    const p0 = pos();
    const life0 = p0?.lifeId;
    const respawn0 = p0?.respawnCount ?? 0;
    const t0 = s.tick();
    const T = (): number => s.tick() - t0;
    let died = false;
    let hpMin = hp();
    let eats = 0;
    let last = p0;
    let railTries = 0, railFails = 0, inspectFails = 0, repairFails = 0, walkTicks = 0;
    const jumps: string[] = [];
    let lastTrace = '';
    const done = new Set<string>();
    const milestone = (step: string | number): void => {
        const k = String(step);
        if (done.has(k)) return;
        done.add(k);
        console.log(`MILESTONE ${k} ${T()}`);
    };

    const off = s.onTick(() => {
        const p = pos();
        const h = hp();
        if (h > 0 && h < hpMin) {
            hpMin = h;
            if (h <= 50) console.log(`WARN hp ${h} at ${T()} ${p?.worldX},${p?.worldZ},${p?.level}`);
        }
        if (p?.isDead || (p && p.respawnCount > respawn0) || (p && life0 !== undefined && p.lifeId !== life0)) died = true;
        if (p && last && Math.max(Math.abs(p.worldX - last.worldX), Math.abs(p.worldZ - last.worldZ)) > 20) {
            jumps.push(`${T()}:${last.worldX},${last.worldZ}->${p.worldX},${p.worldZ},${p.level}`);
            if (Math.max(Math.abs(p.worldX - LUMBRIDGE.x), Math.abs(p.worldZ - LUMBRIDGE.z)) <= 15) died = true;
        }
        if (p) last = p;
        if (TRACE) {
            const d: any = s.sdk.getDialog();
            const m = (st()?.gameMessages ?? []).filter((x: any) => x.type === 0).slice(-1)[0]?.text ?? '';
            const line = `${p?.worldX},${p?.worldZ},${p?.level} dlg=${d?.isOpen ? (d.isWaiting ? 'wait' : 'open') : '-'} opts=${(d?.options ?? []).map((o: any) => o.text).join('|')} anim=${p?.animId ?? ''} msg=${m}`;
            if (line !== lastTrace) { console.log(`TRACE ${T()} ${line}`); lastTrace = line; }
        }
        if (h > 0 && h <= EAT_AT) {
            const food = inv().find(i => i.id === ITEM.lobster);
            if (food) { eats++; void s.direct({ type: 'useInventoryItem', slot: food.slot, optionIndex: 1, reason: 'SDK' }); }
        }
    });

    const detail = (): string => {
        const p = pos();
        const msgs = (st()?.gameMessages ?? []).filter((m: any) => m.type === 0).slice(-4).map((m: any) => m.text).join(' / ');
        return `at=${p?.worldX},${p?.worldZ},${p?.level} ticks=${T()} hpMin=${hpMin} eats=${eats} railTries=${railTries} railFails=${railFails} inspectFails=${inspectFails} repairFails=${repairFails} walkTicks=${walkTicks} died=${died} milestones=${[...done].join(',')} jumps=${jumps.join(';')} msgs=${msgs}`;
    };
    const fail = async (why: string): Promise<never> => {
        off();
        return finish([s], false, `${why} ${detail()}`);
    };
    const guard = async (label: string): Promise<void> => {
        if (died) await fail(`died during ${label}`);
        if (T() > CAP) await fail(`tick cap during ${label}`);
    };

    const opLoc = (l: { id: number; x: number; z: number }, op = 1) =>
        s.direct({ type: 'interactLoc', x: l.x, z: l.z, locId: l.id, optionIndex: op, reason: 'SDK' });
    const findLoc = (pred: (l: any) => boolean): any =>
        (st()?.nearbyLocs ?? []).filter(pred).sort((a: any, b: any) => a.distance - b.distance)[0];
    const opIndex = (l: any, re: RegExp): number => l?.optionsWithIndex?.find((o: any) => re.test(o.text))?.opIndex ?? 1;
    const npc = (re: RegExp): any => (st()?.nearbyNpcs ?? []).filter((n: any) => re.test(n.name)).sort((a: any, b: any) => a.distance - b.distance)[0];
    const talkTo = (n: any) => s.direct({ type: 'interactNpc', npcIndex: n.index, optionIndex: n.optionsWithIndex?.find((o: any) => /talk/i.test(o.text))?.opIndex ?? 1, reason: 'SDK' });

    // Sends, then waits up to `ticks` for `ok`; retries. A stray dialog page is clicked through between tries.
    const step = async (label: string, send: () => unknown, ok: () => boolean, ticks = 20, tries = 3): Promise<void> => {
        for (let i = 0; i < tries; i++) {
            await guard(label);
            if (ok()) return;
            await send();
            await waitUntil(s, () => ok() || died, { timeoutTicks: ticks });
            if (ok()) return;
            const d: any = s.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) await s.sdk.sendClickDialog(0);
        }
        await guard(label);
        if (!ok()) await fail(`step ${label}`);
    };

    // Clicks one dialog page per tick: the first option matching a pattern, else "continue". Stops when ok() holds.
    const converse = async (pats: RegExp[], ok: () => boolean, maxTicks: number): Promise<boolean> => {
        for (let i = 0; i < maxTicks && !died; i++) {
            if (ok()) return true;
            const d: any = s.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) {
                const opt = (d.options ?? []).find((o: any) => pats.some(re => re.test(o.text)));
                void s.sdk.sendClickDialog(opt ? opt.index : 0);
            }
            await waitTicks(s, 1);
        }
        return ok();
    };
    // Talk until ok(); then wait until the dialog closes (3 shut ticks) so the next click is not dropped.
    // The NPC list only covers about 15 tiles, so the bot walks toward `home` (the spawn) when the NPC is not in it.
    const talk = async (label: string, re: RegExp, pats: RegExp[], ok: () => boolean, maxTicks = 60, home = LAWGOF): Promise<void> => {
        for (let i = 0; i < 3; i++) {
            await guard(label);
            if (!npc(re)) await walk(`${label} approach`, [{ x: home.x, z: home.z, tol: 6 }]);
            const n = npc(re);
            if (!n) await fail(`${label}: no npc ${re}`);
            // A click the server drops (inside a p_delay) is sent again after 3 ticks with no step and no dialog.
            for (let k = 0; k < 8 && !dialogOpen() && !died; k++) {
                const m = npc(re) ?? n;
                await talkTo(m);
                let at0 = '', still = 0;
                for (let w = 0; w < 25 && !dialogOpen() && !died; w++) {
                    await waitTicks(s, 1);
                    const at = `${pos()?.worldX},${pos()?.worldZ}`;
                    still = at === at0 ? still + 1 : 0;
                    at0 = at;
                    if (still >= 3) break;
                }
            }
            let shut = 0;
            await converse(pats, () => { shut = dialogOpen() ? 0 : shut + 1; return (ok() && !dialogOpen()) || shut >= 3; }, maxTicks);
            if (ok()) return;
        }
        await fail(`talk ${label}`);
    };

    const walk = async (label: string, pts: PathPoint[]): Promise<void> => {
        const goal = pts[pts.length - 1]!;
        const tol = goal.tol ?? 2;
        for (let i = 0; i < 3 && !near(goal.x, goal.z, tol); i++) {
            await guard(label);
            const r = await walkPath(walker, i === 0 ? pts : [goal], { stop: () => died || T() > CAP });
            walkTicks += r.ticks;
            if (!r.ok && !near(goal.x, goal.z, tol)) await s.bot.walkTo(goal.x, goal.z, tol, { timeout: 400_000 });
        }
        if (!near(goal.x, goal.z, tol + 1)) await fail(`walk ${label}`);
    };
    const climb = async (label: string, l: { id: number; x: number; z: number }, re: RegExp, arrived: () => boolean): Promise<void> => {
        await step(label, () => {
            const k = findLoc(x => x.id === l.id && x.x === l.x && x.z === l.z);
            return opLoc(l, opIndex(k, re));
        }, arrived, 15, 4);
    };
    const teleport = async (label: string, comp: string, x: number, z: number): Promise<void> => {
        await step(label, () => s.direct({ type: 'clickComponent', componentId: componentId(comp), reason: 'SDK' }), () => near(x, z, 6), 8, 3);
    };

    const walker = await sessionWalker(s as any);

    // 1. Commander: "Yeah, I'd love to help." sets 1 and gives six railings (lawgof2.rs2:30-41).
    await talk('commander 1', /^dwarf commander$/i, [/love to help/i], () => cnt(ITEM.railing) >= 6);
    milestone(1);

    // 2. Six broken railings. Each try: two 2-tick searches, a choice, 2 ticks, then a Crafting roll (railings.rs2:66-91).
    // Sending the loc click from where the bot stands lets the client route to the railing in the same input.
    // The next railing click goes out on the tick the success message lands; a click the server drops inside the
    // p_delay(2) is sent again when no search message comes within 3 ticks.
    const OK_RAIL = /replace the railing with no problems|already fixed this railing/i;
    const FAIL_RAIL = /fail and cut yourself/i;
    const SEARCH = /you search the railing/i;
    for (const r of RAILINGS) {
        const ok0 = msgCount(OK_RAIL);
        const fixed = () => msgCount(OK_RAIL) > ok0;
        for (let i = 0; i < 25 && !fixed(); i++) {
            await guard(`railing ${r.x},${r.z}`);
            const fails0 = msgCount(FAIL_RAIL);
            const search0 = msgCount(SEARCH);
            railTries++;
            let searched = false;
            for (let k = 0; k < 6 && !searched && !died; k++) {
                await opLoc(r);
                const at0 = `${pos()?.worldX},${pos()?.worldZ}`;
                for (let w = 0; w < 12 && !died; w++) {
                    await waitTicks(s, 1);
                    if (msgCount(SEARCH) > search0 || fixed()) { searched = true; break; }
                    if (w >= 2 && `${pos()?.worldX},${pos()?.worldZ}` === at0) break;
                }
            }
            if (fixed()) break;
            const choice = () => dialogOpen() && (s.sdk.getDialog()?.options ?? []).some((o: any) => /replace the railing/i.test(o.text));
            if (!(await waitUntil(s, () => died || choice() || fixed(), { timeoutTicks: 10 }))) continue;
            if (fixed()) break;
            const opt = (s.sdk.getDialog()?.options ?? []).find((o: any) => /replace the railing/i.test(o.text));
            if (opt) void s.sdk.sendClickDialog(opt.index);
            await waitUntil(s, () => died || fixed() || msgCount(FAIL_RAIL) > fails0, { timeoutTicks: 8 });
            if (msgCount(FAIL_RAIL) > fails0) railFails++;
        }
        if (!fixed()) await fail(`railing ${r.x},${r.z} not fixed`);
    }
    milestone('railings');

    // 3. Commander again: all six bits (getbit_range 5-10 = 63) set 2 (lawgof2.rs2:47-56).
    await talk('commander 2', /^dwarf commander$/i, [], () => sawText(/check up on a guard|watch tower/i));
    milestone(2);

    // 4. Watch tower: ladder up twice, the remains on level 2 (obj 0 at 2567,3444,2, maps/m40_53.jm2), ladders down.
    // A double gate (loc 1557/1558 at 2567-2568,3458) shuts the fence: the client cannot route a loc click through it,
    // so walkPath (which opens it) goes first.
    await walk('to tower', [{ x: LOC.towerLadder.x, z: LOC.towerLadder.z - 1, tol: 1 }]);
    await climb('tower up 1', LOC.towerLadder, /climb-up/i, () => lvl() === 1);
    await climb('tower up 2', LOC.towerLadder1, /climb-up/i, () => lvl() === 2);
    await step('remains', () => {
        const g = (st()?.groundItems ?? []).find((x: any) => x.id === ITEM.remains);
        return s.direct({ type: 'pickupItem', x: g?.x ?? 2567, z: g?.z ?? 3444, itemId: ITEM.remains, reason: 'SDK' });
    }, () => has(ITEM.remains), 10, 4);
    await climb('tower down 2', LOC.towerTop2, /climb-down/i, () => lvl() === 1);
    await climb('tower down 1', LOC.towerTop1, /climb-down/i, () => lvl() === 0);

    // 5. Commander: the remains set 3 (lawgof2.rs2:80-86).
    await talk('commander 3', /^dwarf commander$/i, [], () => !has(ITEM.remains) && sawText(/seek out the goblins base|hide out/i));
    milestone(3);

    // 6. Goblin cave by the Fishing Guild sets 4; the crate frees the child and his talk sets 5 (mcannon_crate.rs2:3-21).
    const inCave = () => (pos()?.worldZ ?? 0) > 9000;
    await walk('to cave', [{ x: LOC.cave.x, z: LOC.cave.z + 1, tol: 2 }]);
    await step('cave', () => opLoc(LOC.cave), inCave, 12, 4);
    milestone(4);
    await walk('to crate', [{ x: LOC.crate.x, z: LOC.crate.z + 1, tol: 2 }]);
    // Only the message counts: %mcannon = 5 is set after it, and a walk click before the last page cancels the script.
    const freed = () => msgCount(/runs off into the caverns/i) > 0;
    await step('crate', async () => {
        await opLoc(LOC.crate);
        await waitUntil(s, () => dialogOpen() || died, { timeoutTicks: 15 });
        await converse([], freed, 20);
    }, freed, 5, 4);
    milestone(5);
    // From 2615,9802 the client could not route a click to the mud pile ("I can't reach that!"): walk beside it first.
    await walk('to mud pile', [{ x: LOC.mud.x - 1, z: LOC.mud.z + 1, tol: 1 }]);
    await step('mud pile', () => opLoc(LOC.mud), () => !inCave(), 10, 4);

    // 7. Commander: "Ok, I'll see what I can do." gives the tool kit and sets 6 (lawgof2.rs2:119-125).
    await walk('to commander', [{ x: LAWGOF.x, z: LAWGOF.z + 1, tol: 3 }]);
    await talk('commander 4', /^dwarf commander$/i, [/see what i can do/i], () => has(ITEM.toolkit));
    milestone(6);

    // 8. The shed door (mcannondoor1), then the cannon: the first inspect sets 7; each later inspect rolls, lists the
    // parts, and the chosen part rolls again; with all four bits the inspect sets 8 (mcannon_broken_cannon.rs2).
    const doorShut = () => !!findLoc(l => l.id === LOC.shedDoor.id && l.x === LOC.shedDoor.x && l.z === LOC.shedDoor.z);
    await step('shed door', () => opLoc(LOC.shedDoor, opIndex(findLoc(l => l.id === LOC.shedDoor.id), /open/i)), () => !doorShut(), 10, 4);
    await step('inspect 1', async () => {
        await opLoc(LOC.cannon);
        await waitUntil(s, () => sawText(/better fix it with the toolkit/i) || died, { timeoutTicks: 15 });
        await converse([], () => !dialogOpen(), 4);
    }, () => sawText(/better fix it with the toolkit/i), 3, 4);
    milestone(7);
    // The inspect click sent on the tick after "manage to fix it" lands inside p_delay(2) and is dropped (MEASURED
    // practice: 16 idle ticks per part). So it is sent again every 2 ticks until the inspect message comes.
    const INSPECT = /you see that there are some damaged|can't quite find the problem|you inspect the multi cannon/i;
    const inspect = async (): Promise<void> => {
        const n0 = msgCount(INSPECT);
        for (let k = 0; k < 10 && msgCount(INSPECT) <= n0 && !died; k++) {
            await opLoc(LOC.cannon);
            await waitUntil(s, () => msgCount(INSPECT) > n0 || died, { timeoutTicks: 2 });
        }
    };
    const fixedMsg = /manage to fix it|already fixed this part/i;
    for (const part of PARTS) {
        const fixed0 = msgCount(fixedMsg);
        for (let i = 0; i < 30 && msgCount(fixedMsg) <= fixed0; i++) {
            await guard(`repair ${part}`);
            const noFind0 = msgCount(/can't quite find the problem/i);
            const hard0 = msgCount(/too hard you fail/i);
            await inspect();
            const menu = () => dialogOpen() && (s.sdk.getDialog()?.options ?? []).some((o: any) => new RegExp(`^${part}$`, 'i').test(o.text));
            await waitUntil(s, () => died || menu() || msgCount(/can't quite find the problem/i) > noFind0, { timeoutTicks: 15 });
            if (msgCount(/can't quite find the problem/i) > noFind0) { inspectFails++; continue; }
            if (!menu()) continue;
            const opt = (s.sdk.getDialog()?.options ?? []).find((o: any) => new RegExp(`^${part}$`, 'i').test(o.text));
            if (opt) void s.sdk.sendClickDialog(opt.index);
            await waitUntil(s, () => died || msgCount(fixedMsg) > fixed0 || msgCount(/too hard you fail/i) > hard0, { timeoutTicks: 8 });
            if (msgCount(/too hard you fail/i) > hard0) repairFails++;
        }
        if (msgCount(fixedMsg) <= fixed0) await fail(`repair ${part}`);
    }
    const working = () => sawText(/seems to be in working order/i);
    await step('inspect done', async () => {
        await inspect();
        await waitUntil(s, () => working() || died, { timeoutTicks: 6 });
    }, working, 3, 4);
    milestone(8);

    // 9. Commander: "Ok then, just for you!" sets 9 (lawgof2.rs2:139-175). The shed door shuts behind the bot
    // (~open_and_close_door) and no planned walk opens it, so the bot ops it from inside (west wall of 2576,3461).
    await step('shed door out', () => opLoc(LOC.shedDoor, opIndex(findLoc(l => l.id === LOC.shedDoor.id), /open/i)), () => (pos()?.worldX ?? 2576) < 2576, 10, 4);
    await walk('out of shed', [{ x: LAWGOF.x + 1, z: LAWGOF.z, tol: 2 }]);
    await talk('commander 5', /^dwarf commander$/i, [/just for you/i], () => sawText(/speak to nulodion|nulodion, the dwarf cannon/i), 80);
    milestone(9);

    // 10. Falador teleport (2965,3378), walk to Nulodion; his talk gives the notes and the mould and sets 10.
    await teleport('falador teleport', 'magic:falador_teleport', 2965, 3378);
    // Nulodion's room opens only by the quest door, which no planned walk opens: the porch, then the door by hand.
    await walk('to nulodion porch', [{ x: LOC.nulodionDoor.x, z: LOC.nulodionDoor.z, tol: 0 }]);
    await step('nulodion door', () => opLoc(LOC.nulodionDoor, opIndex(findLoc(l => l.id === LOC.nulodionDoor.id), /open/i)), () => (pos()?.worldX ?? 3015) < 3015, 10, 4);
    await talk('nulodion', /^nulodion$/i, [], () => has(ITEM.notes) && has(ITEM.mould), 60, NULODION);
    milestone(10);

    // 11. Camelot teleport (2757,3478), walk back; the commander takes both and queues the reward (lawgof2.rs2:177-201).
    await teleport('camelot teleport', 'magic:camelot_teleport', 2757, 3478);
    await walk('back to commander', [{ x: LAWGOF.x, z: LAWGOF.z + 1, tol: 3 }]);
    const rewarded = () => xp('Crafting') - craft0 >= 18_750;
    await talk('commander 6', /^dwarf commander$/i, [], () => rewarded() || (!has(ITEM.notes) && !has(ITEM.mould)), 60);
    await waitUntil(s, () => rewarded() || died, { timeoutTicks: 10 });
    if (rewarded()) milestone(11);

    off();
    const gained = xp('Crafting') - craft0;
    console.log(`RATE crafting ${gained} ${T()}`);
    const gains = SK.map(k => [k, xp(k) - xp0[k]!] as const).filter(([, g]) => g > 0).map(([k, g]) => `${k.toLowerCase()}=${g}`).join(',');
    const ok = rewarded() && !died;
    await finish([s], ok, `craftingXp=${gained} xp=${gains} ${detail()}`);
} catch (e) { await finish([s], false, String(e)); }
