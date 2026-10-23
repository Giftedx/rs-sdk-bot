// Monkey Madness from preset quest_mm (beside King Narnode, Grand Tree ground floor), at the planner's state for the
// rival-mm row: The Grand Tree (varp 150 = 160) and Tree Gnome Village (varp 111 = 9) complete, Attack 99, Magic 99,
// Prayer 43, Strength, Defence 1. Research and stage list: research/quest-plan.md section 1h.
// Stages (MM_FROM=<n> starts later, from a debug preset with the quest varps set):
//   10 Narnode starts the quest (%mm_main 1, the royal seal)       20 glider to Gandius, shipyard gate, Caranock
//   30 glider back, Narnode's orders                               40 Daero (three topics, Leave), the hangar, Waydar
//   50 the reinitialisation puzzle (raw OPHELD5, mm-puzzle.ts)     60 Daero, Waydar's glider to Crash Island
//   70 Lumdo, Waydar orders him: chapter 2 cutscene, Ape Atoll (2801,2707)
// MM_STOP=<n> ends the run (as a pass) at that milestone.
import { openQuest } from './quest-lib';
import { componentId } from '../../packages/core/src/logout';
import { solve, solved, applyClick } from './mm-puzzle';

const ITEM = {
    seal: 4004, orders: 4005, dentures: 4006, encBar: 4007, mould: 4020, amulet: 4021, amuletUnstrung: 4022,
    talisman: 4023, greegree: 4031, backpackMonkey: 4033, sigil: 4035, goldBar: 2357, wool: 1759, bones: 3183,
    banana: 1963, prayerPot: [2434, 139, 141, 143], food: 385,
};
const NARNODE = { x: 2466, z: 3497 };                  // grandtree_narnode, Grand Tree l0
const TREE_LADDER = { x: 2466, z: 3495 };              // l0 ladder, l1 laddermiddle, l2 grandtree_laddermiddle, l3 top
const PILOT = { x: 2464, z: 3501 };                    // l3 gnomepilot (^ta_quir_priw 3_38_54_33_45)
const GANDIUS = { x: 2971, z: 2969 };                  // ^gandius 0_46_46_27_25 (glider.constant:1)
const GANDIUS_PILOT = { x: 2970, z: 2973 };
const SHIP_GATE = { x: 2945, z: 3041 };                // grandtree_fencegate_l
const CARANOCK = { x: 2956, z: 3025 };
const DAERO = { x: 2484, z: 3486 };                    // l1, the Grand Tree bar
const HANGAR = { x: 2393, z: 9892 };                   // 0_37_154_25_36 (mm_daero.rs2:234)
const PANEL = { x: 2394, z: 9883 };                    // bunker_controlpanal
const HANGAR_ON = { x: 2649, z: 4507 };                // 0_41_70_25_27, powered hangar (mm_puzzle.rs2:190)
const CRASH_ISLAND = { x: 2893, z: 2725 };             // 0_45_42_13_37 (mm_waydar.rs2:116)
const ATOLL = { x: 2801, z: 2707 };                    // 0_43_42_49_19 (quest_mm.rs2:12)
const PUZZLE_COM = componentId('reinitialisation_puzzle:com_3');
const GLIDER_GANDIUS = 'glidermap:com_21';
const GLIDER_TREE = 'glidermap:com_22';

// MM_LOG=<file>: every console line also goes to that file (the prove tail keeps 16 lines).
if (process.env.MM_LOG) {
    const { appendFileSync } = await import('node:fs');
    const log0 = console.log.bind(console);
    console.log = (...a: unknown[]) => { log0(...a); try { appendFileSync(process.env.MM_LOG!, a.map(String).join(' ') + '\n'); } catch { /* the log is a debug aid */ } };
}
const q = await openQuest({ cap: Number(process.env.MM_CAP ?? 9000), eatAt: 20, food: [ITEM.food] });
try {
    // HIT lines: each HP drop with the NPCs within 3 tiles, so the damage source on the atoll is in the log.
    let hp0 = q.hp();
    q.s.onTick(() => {
        const h = q.hp();
        if (h > 0 && h < hp0) {
            const p = q.pos();
            const near = (q.st()?.nearbyNpcs ?? []).filter((n: any) => p && Math.max(Math.abs(n.x - p.worldX), Math.abs(n.z - p.worldZ)) <= 3).map((n: any) => n.name).join('/');
            console.log(`HIT ${hp0}->${h} t=${q.T()} at=${p?.worldX},${p?.worldZ},${p?.level} near=${near}`);
        }
        hp0 = h;
    });
    const FROM = Number(process.env.MM_FROM ?? 0);
    const STOP = Number(process.env.MM_STOP ?? 999);
    const ms = async (k: number | string): Promise<void> => { q.milestone(k); if (typeof k === 'number' && k >= STOP) await q.end(true, `stopped at ${k}`); };
    const near3 = (l: any, p: { x: number; z: number }, r: number) => Math.max(Math.abs(l.x - p.x), Math.abs(l.z - p.z)) <= r;
    const level = (): number => q.lvl();
    const z = (): number => q.pos()?.worldZ ?? 0;
    const shutDialog = () => q.converse([], () => !q.dialogOpen(), 10);
    const client: any = (q.s as any).client;

    // A page that opens during a walk (a level-up, a stray NPC line) is clicked through, so the walk goes on.
    let walking = false;
    const offWalk = q.s.onTick(() => {
        if (!walking) return;
        const d: any = q.s.sdk.getDialog();
        if (d?.isOpen && !d.isWaiting && !(d.options ?? []).some((o: any) => !/click here to continue/i.test(o.text))) void q.s.sdk.sendClickDialog(0);
    });
    const inTrunk = (x: number, zz: number): boolean => x >= 2463 && x <= 2468 && zz >= 3493 && zz <= 3498;
    const exitTree = async (): Promise<void> => {
        await q.dash('to tree door inside', 2465, 3493, 0, 12);
        await q.step('tree door out', () => { const d = q.findLoc(l => /tree door/i.test(l.name) && near3(l, { x: 2465, z: 3492 }, 2)); return d ? q.opLoc(d, q.opIndex(d, /open/i)) : q.waitTicks(1); }, () => z() <= 3491, 10, 4);
    };
    const walk = async (label: string, pts: { x: number; z: number; tol?: number }[]): Promise<void> => {
        const g = pts[pts.length - 1]!;
        const p0 = q.pos();
        if (level() === 0 && p0 && inTrunk(p0.worldX, p0.worldZ) && !inTrunk(g.x, g.z)) await exitTree();
        walking = true;
        try { await q.walk(label, pts); } finally { walking = false; }
    };
    const ladder = async (label: string, p: { x: number; z: number }, dir: 'up' | 'down', to: number): Promise<void> => {
        const direct = dir === 'up' ? /^climb[- ]up/i : /^climb[- ]down/i;
        await q.step(label, async () => {
            const k = q.findLoc(l => /ladder|stair|tree/i.test(l.name) && near3(l, p, 1) && (l.optionsWithIndex ?? []).some((o: any) => /climb/i.test(o.text)));
            if (!k) return q.waitTicks(1);
            const op = (k.optionsWithIndex ?? []).find((o: any) => direct.test(o.text)) ?? (k.optionsWithIndex ?? []).find((o: any) => /climb/i.test(o.text));
            await q.opLoc(k, op.opIndex);
            await q.waitUntil(() => level() === to || q.dialogOpen(), 12);
            if (q.dialogOpen()) await q.converse([dir === 'up' ? /^climb up/i : /^climb down/i], () => level() === to, 8);
        }, () => level() === to, 4, 5);
        await shutDialog();
    };
    const enterTree = async (): Promise<void> => {
        if (level() !== 0 || z() >= 3493 || z() > 6400) return;
        await walk('to tree door', [{ x: 2465, z: 3490, tol: 1 }]);
        await q.step('tree door', () => { const d = q.findLoc(l => /tree door/i.test(l.name) && near3(l, { x: 2465, z: 3492 }, 2)); return d ? q.opLoc(d, q.opIndex(d, /open/i)) : q.waitTicks(1); }, () => z() >= 3493, 10, 4);
    };
    const treeTo = async (to: number): Promise<void> => {
        if (level() === 0 && to > 0) await enterTree();
        if (level() === 0 && to > 0) await walk('to tree ladder', [{ x: TREE_LADDER.x + 1, z: TREE_LADDER.z, tol: 1 }]);
        while (level() < to) await ladder(`tree up ${level()}`, TREE_LADDER, 'up', level() + 1);
        while (level() > to) await ladder(`tree down ${level()}`, TREE_LADDER, 'down', level() - 1);
    };
    // Talk; answer with `choose` (the option index for this page, or -1 for continue); stop when ok().
    const talkChoose = async (label: string, re: RegExp, choose: (opts: string[]) => number, ok: () => boolean, max: number, home?: { x: number; z: number }): Promise<void> => {
        for (let i = 0; i < 3 && !ok(); i++) {
            await q.guard(label);
            if (i > 0) q.stats.retries++;
            let n = q.npc(re);
            if (!n && home) { await walk(`${label} approach`, [{ x: home.x, z: home.z, tol: 4 }]); n = q.npc(re); }
            if (!n) { await q.waitTicks(2); continue; }
            await q.talkTo(n);
            await q.waitUntil(() => q.dialogOpen(), 20);
            let lastSig = '', lastAt = -9;
            for (let t = 0; t < max && !ok() && !q.stats.died; t++) {
                const d: any = q.s.sdk.getDialog();
                const opts: string[] = (d?.options ?? []).map((o: any) => String(o.text ?? ''));
                const sig = opts.join('|');
                // The page can read the same for a tick after a click: the same menu is not clicked twice in 3 ticks.
                if (d?.isOpen && !d.isWaiting && !(sig === lastSig && t - lastAt < 3 && opts.length > 1)) {
                    lastSig = sig; lastAt = t;
                    const real = opts.some(o => !/click here to continue/i.test(o));
                    let k = real ? choose(opts) : -1;
                    if (real && k < 0) console.log(`WARN ${label} no choice: ${opts.join(' | ')}`);
                    void q.s.sdk.sendClickDialog(k >= 0 ? (d.options[k].index ?? k + 1) : 0);
                } else if (!d?.isOpen && t > 3) {
                    break;
                }
                await q.waitTicks(1);
            }
        }
        if (!ok()) await q.fail(`talk ${label}`);
    };
    const pick = (...res: RegExp[]) => (opts: string[]): number => {
        for (const re of res) { const k = opts.findIndex(o => re.test(o)); if (k >= 0) return k; }
        return -1;
    };
    const glide = async (label: string, pilotAt: { x: number; z: number }, comp: string, land: { x: number; z: number }, landLevel: number): Promise<void> => {
        // The map opens with no dialog (modalInterface reads -1 in the lite state), so the pick itself is the signal.
        let picked = false;
        const choose = pick(/take me on the glider/i);
        await talkChoose(`${label} pilot`, /^gnome pilot/i, o => { const k = choose(o); if (k >= 0) picked = true; return k; }, () => picked && !q.dialogOpen(), 20, pilotAt);
        await q.waitTicks(1);
        await q.step(`${label} fly`, () => q.s.direct({ type: 'clickComponent', componentId: componentId(comp), reason: 'SDK' }), () => q.near(land.x, land.z, 8) && level() === landLevel, 12, 3);
        await shutDialog();
    };
    // The open main modal (the glider map, the puzzle): state.modalInterface (LiteClient.ts:949-950).
    const isMain = (name: string): boolean => q.st()?.modalInterface === componentId(name);

    // Poison (Karamja jungle spiders): an antipoison on the first "You have been poisoned!" after the last dose.
    const ANTIPOISON = [2446, 175, 177, 179];
    let poisonSeen = Math.max(-1, ...(q.st()?.gameMessages ?? []).map((m: any) => m.observationId ?? -1));
    let antipoisons = 0;
    const offPoison = q.s.onTick(() => {
        const m = (q.st()?.gameMessages ?? []).filter((x: any) => x.type === 0 && /you have been poisoned/i.test(x.text) && (x.observationId ?? -1) > poisonSeen);
        if (m.length === 0) return;
        poisonSeen = Math.max(...m.map((x: any) => x.observationId ?? -1));
        const pot = ANTIPOISON.find(id => q.has(id));
        if (pot !== undefined) { antipoisons++; void q.s.direct({ type: 'useInventoryItem', slot: q.slot(pot)!, optionIndex: 1, reason: 'SDK' }); }
    });
    const PFM = 14;
    const pfmOn = (): boolean => !!q.st()?.prayers?.activePrayers?.[PFM];
    const setPfm = async (on: boolean): Promise<void> => {
        if (pfmOn() === on) return;
        await q.step(`protect from melee ${on ? 'on' : 'off'}`, () => q.s.direct({ type: 'togglePrayer', prayerIndex: PFM, reason: 'SDK' }), () => pfmOn() === on, 3, 3);
    };

    // 10. Narnode: "Yes" to "Start Monkey Madness?" (mm_narnode.rs2:124-137): the royal seal.
    if (FROM < 10) {
        await talkChoose('narnode start', /^king narnode/i, pick(/^yes$/i), () => q.has(ITEM.seal) && !q.dialogOpen(), 80, NARNODE);
        await ms(10);
    }

    // 20. Glider to Gandius; the shipyard worker sees the seal and opens the gate (mm_caranock.rs2:45-61); Caranock.
    if (FROM < 20) {
        await treeTo(3);
        await walk('to pilot', [{ x: PILOT.x + 1, z: PILOT.z - 1, tol: 1 }]);
        await glide('gandius', PILOT, GLIDER_GANDIUS, GANDIUS, 0);
        q.milestone('gandius');
        // Jungle spiders and jogres on the way (melee; a spider poisoned the bot 35 -> 20 HP in a test run).
        await setPfm(true);
        await walk('to shipyard gate', [{ x: SHIP_GATE.x - 2, z: SHIP_GATE.z, tol: 1 }]);
        for (let i = 0; i < 3 && (q.pos()?.worldX ?? 0) < SHIP_GATE.x; i++) {
            await q.guard('shipyard gate');
            const g = q.findLoc(l => /gate/i.test(l.name) && near3(l, SHIP_GATE, 1));
            if (!g) { await q.waitTicks(1); continue; }
            await q.opLoc(g, q.opIndex(g, /open/i));
            await q.waitUntil(() => q.dialogOpen(), 10);
            await q.converse([], () => (q.pos()?.worldX ?? 0) >= SHIP_GATE.x, 40);
        }
        if ((q.pos()?.worldX ?? 0) < SHIP_GATE.x) await q.fail('shipyard gate');
        await setPfm(false);
        await talkChoose('caranock', /caranock/i, () => -1, () => q.sawText(/see personally to the decommission/i) && !q.dialogOpen(), 60, CARANOCK);
        await ms(20);
    }

    // 30. Back by the Gandius glider; Narnode writes the orders (mm_narnode.rs2:143-202).
    if (FROM < 30) {
        await setPfm(true);
        await walk('to gandius pilot', [{ x: GANDIUS_PILOT.x, z: GANDIUS_PILOT.z - 2, tol: 2 }]);
        await setPfm(false);
        await glide('tree', GANDIUS_PILOT, GLIDER_TREE, PILOT, 3);
        await treeTo(0);
        await talkChoose('narnode orders', /^king narnode/i, () => -1, () => q.has(ITEM.orders) && !q.dialogOpen(), 80, NARNODE);
        await ms(30);
    }

    // 40. Daero (l1): the orders, the three topics (Leave appears only after all three, mm_daero.rs2:129-133), the
    // blindfold to the hangar; Daero introduces Waydar (%mm_daero 5, started_reinit).
    if (FROM < 40) {
        await treeTo(1);
        // A topic counts as opened when its submenu is seen (mm_daero.rs2:135-145 set the bit on entry).
        const seen = new Set<string>();
        const daeroMenu = (opts: string[]): number => {
            if (opts.some(o => /south of karamja/i.test(o))) seen.add('journey');
            if (opts.some(o => /who is garkor/i.test(o))) seen.add('10th squad');
            if (opts.some(o => /who is caranock/i.test(o))) seen.add('caranock');
            let k = opts.findIndex(o => /^leave/i.test(o));
            if (k >= 0) return k;
            k = opts.findIndex(o => /who is it/i.test(o));
            if (k >= 0) return k;
            k = opts.findIndex(o => /return to previous menu/i.test(o));
            if (k >= 0) return k;
            for (const t of ['journey', '10th squad', 'caranock']) {
                k = opts.findIndex(o => new RegExp(`talk about (the )?${t}`, 'i').test(o));
                if (k >= 0 && !seen.has(t)) return k;
            }
            return opts.findIndex(o => /^talk about/i.test(o));
        };
        await talkChoose('daero orders', /^daero$/i, daeroMenu, () => q.near(HANGAR.x, HANGAR.z, 12) && z() > 6400, 160, DAERO);
        await shutDialog();
        q.milestone('hangar');
        await talkChoose('daero hangar', /^daero$/i, () => -1, () => q.sawText(/wait till reinitialisation is complete/i) && !q.dialogOpen(), 80);
        await ms(40);
    }

    // 50. The puzzle: the panel opens reinitialisation_puzzle; each click is OPHELD5 on com_3 (the lite client sends
    // INV_BUTTON5 for a non-inventory component, which no script handles; the real client sends OPHELD5,
    // Client.ts:11577). The last slide starts the hangar cutscene (timer 3, then 0_41_70_25_27, mm_puzzle.rs2:152-192).
    if (FROM < 50) {
        const board = (): number[] | null => {
            const com = client?.ifType?.(PUZZLE_COM);
            if (!com?.linkObjType) return null;
            const b: number[] = [];
            for (let i = 0; i < 25; i++) {
                const raw = com.linkObjType[i] ?? 0;
                b.push(raw > 0 ? (raw - 1 - 3904) / 2 + 1 : 0);
            }
            return b.every(x => Number.isInteger(x) && x >= 0 && x <= 24) ? b : null;
        };
        const { ClientProt } = await import('../../vendor/rs-sdk/server/webclient/src/io/ClientProt.ts');
        const click = (b: number[], slot: number): void => {
            const objId = 3904 + 2 * (b[slot]! - 1);
            client.writeOpcode(ClientProt.OPHELD5);
            client.out.p2(objId);
            client.out.p2(slot);
            client.out.p2(PUZZLE_COM);
        };
        await walk('to panel', [{ x: PANEL.x, z: PANEL.z + 1, tol: 1 }]);
        const panelOpen = (): boolean => { const b = board(); return !!b && b.some(x => x > 0); };
        await q.step('open panel', () => { const p = q.findLoc(l => /control panel|panel/i.test(l.name) && near3(l, PANEL, 3)); return p ? q.opLoc(p, 1) : q.waitTicks(1); }, panelOpen, 10, 4);
        let moves = 0;
        const t0 = q.T();
        const slid = (): boolean => q.msgCount(/slide the final piece into place/i) > 0;
        for (let round = 0; round < 12 && !slid() && !q.near(HANGAR_ON.x, HANGAR_ON.z, 10); round++) {
            const b = board();
            if (!b) { await q.waitTicks(1); continue; }
            if (solved(b)) break;
            const path = solve(b);
            if (!path) await q.fail('puzzle: no solution');
            console.log(`PUZZLE round ${round} solution ${path!.length} moves`);
            const sim = b.slice();
            for (let i = 0; i < path!.length; i += 4) {
                for (const s of path!.slice(i, i + 4)) { click(sim, s); applyClick(sim, s); moves++; }
                client.flush?.();
                await q.waitTicks(1);
            }
            await q.waitUntil(slid, 3);
            if (slid()) break;
            const now = board();
            if (now && now.join() !== sim.join()) console.log(`WARN puzzle drift after round ${round}: ${now.join(',')}`);
        }
        console.log(`PUZZLE moves=${moves} ticks=${q.T() - t0}`);
        await q.waitUntil(() => q.near(HANGAR_ON.x, HANGAR_ON.z, 10), 40);
        if (!q.near(HANGAR_ON.x, HANGAR_ON.z, 10)) await q.fail('puzzle: no hangar cutscene');
        await ms(50);
    }

    // 60. Daero ("break Glough's code", %mm_daero 7), Waydar "Yes" (mm_waydar.rs2:5-20): Crash Island.
    if (FROM < 60) {
        await talkChoose('daero reinit', /^daero$/i, () => -1, () => q.sawText(/good luck/i) && !q.dialogOpen(), 60);
        await talkChoose('waydar fly', /^waydar$/i, pick(/^yes$/i), () => q.near(CRASH_ISLAND.x, CRASH_ISLAND.z, 8), 40);
        // Jungle scorpions (38, melee) roam Crash Island: one took the bot 35 -> 11 HP and broke the Lumdo talk.
        await setPfm(true);
        await shutDialog();
        await ms(60);
    }

    // 70. Waydar ("Where are we?"), Lumdo (refuses), Waydar orders him: the chapter 2 cutscene, then Ape Atoll.
    if (FROM < 70) {
        await talkChoose('waydar island', /^waydar$/i, () => -1, () => q.sawText(/did our glider survive|of course/i) && !q.dialogOpen(), 30);
        await talkChoose('lumdo', /^lumdo$/i, () => -1, () => q.sawText(/will not take orders from you/i) && !q.dialogOpen(), 60);
        // The cutscene runs in region 0_40_71 (2560-2623, 4544-4607); its pages are continued like any dialog.
        const inCut = (): boolean => { const p = q.pos(); return !!p && p.worldX >= 2560 && p.worldX < 2624 && p.worldZ >= 4544 && p.worldZ < 4608; };
        await talkChoose('waydar lumdo', /^waydar$/i, pick(/cannot convince lumdo/i), () => inCut() || q.near(ATOLL.x, ATOLL.z, 6), 60);
        await q.converse([], () => q.near(ATOLL.x, ATOLL.z, 6), 250);
        if (!q.near(ATOLL.x, ATOLL.z, 6)) await q.fail('chapter 2 cutscene');
        await shutDialog();
        await setPfm(false);
        await ms(70);
    }

    // ---- Ape Atoll (stages 80-120). A human is attacked by most of the island; the overhead prayer follows the
    // nearest threat (ranged: archers; melee: guards, zombies, scorpions, spiders), and a prayer potion goes in at 6 points.
    const PFMISS = 13;
    const prayOn = (i: number): boolean => !!q.st()?.prayers?.activePrayers?.[i];
    const setPrayer = async (i: number, on: boolean): Promise<void> => {
        if (prayOn(i) === on) return;
        await q.step(`prayer ${i} ${on ? 'on' : 'off'}`, () => q.s.direct({ type: 'togglePrayer', prayerIndex: i, reason: 'SDK' }), () => prayOn(i) === on, 3, 4);
    };
    const pts = (): number => q.st()?.prayers?.prayerPoints ?? 0;
    let potCool = 0, potionsAtoll = 0;
    const offPot = q.s.onTick(() => {
        if (potCool > 0) { potCool--; return; }
        if (pts() > 6 || (want === null && !q.st()?.prayers?.activePrayers?.some((a: boolean) => a))) return;
        const pot = ITEM.prayerPot.find(id => q.has(id));
        if (pot === undefined) return;
        potCool = 4; potionsAtoll++;
        void q.s.direct({ type: 'useInventoryItem', slot: q.slot(pot)!, optionIndex: 1, reason: 'SDK' });
    });
    // Overhead prayer: `want` is a fixed prayer, null (no choice), or 'auto': Protect from Melee when an aggressive melee
    // NPC (huntmode aa_aggressive_melee in quest_mm.npc) is within 2 tiles, Protect from Missiles when an archer is in
    // its hunt range (ravine 15, posted and monkey archers 6), else off after 3 quiet ticks (the drain is 1 point per
    // 5 ticks for each). A monkey (greegree) needs none (mm_archer.rs2:24, aa_monkey_guard.rs2:27).
    let want: number | 'auto' | null = null;
    let quiet = 0;
    const MELEE = /scorpion|spider|snake|zombie|skeleton|^monkey guard$/i;
    const offWant = q.s.onTick(() => {
        if (want === null || pts() <= 0) return;
        let w: number | null = typeof want === 'number' ? want : null;
        if (want === 'auto' && !greegree()) {
            const p = q.pos();
            if (p) {
                const d = (n: any) => Math.max(Math.abs(n.x - p.worldX), Math.abs(n.z - p.worldZ));
                const npcs: any[] = q.st()?.nearbyNpcs ?? [];
                // A posted archer hits up to 18 (26 to 8 in one practice hit), a spider or scorpion about 5-10: the
                // archer wins.
                if (npcs.some(n => /archer/i.test(n.name) && d(n) <= (n.x <= 2731 && n.z <= 2765 ? 15 : 7))) w = PFMISS;
                else if (npcs.some(n => MELEE.test(n.name) && d(n) <= 4)) w = PFM;
            }
        }
        if (w !== null) { quiet = 0; if (!prayOn(w)) void q.s.direct({ type: 'togglePrayer', prayerIndex: w, reason: 'SDK' }); return; }
        if (++quiet >= 3) for (const i of [PFM, PFMISS]) if (prayOn(i)) { void q.s.direct({ type: 'togglePrayer', prayerIndex: i, reason: 'SDK' }); break; }
    });
    const greegree = (): boolean => (q.st()?.equipment ?? []).some((e: any) => e?.id === ITEM.greegree);
    const inCell = (): boolean => { const p = q.pos(); return !!p && p.level === 0 && p.worldX >= 2770 && p.worldX <= 2776 && p.worldZ >= 2793 && p.worldZ <= 2795; };
    const { walkPath, sessionWalker } = await import('../../packages/core/src/walk');
    const walker = await sessionWalker(q.s as any);
    // A walk that stops when `stop()` holds (a knockout teleport, a cutscene).
    const walkStop = async (label: string, pts0: { x: number; z: number; tol?: number }[], stop: () => boolean): Promise<void> => {
        const g = pts0[pts0.length - 1]!;
        for (let i = 0; i < 3 && !stop() && !q.near(g.x, g.z, g.tol ?? 2); i++) {
            await q.guard(label);
            walking = true;
            try {
                const r = await walkPath(walker, i === 0 ? pts0 : [g], { stop: () => stop() || q.stats.died || q.T() > 20000 });
                q.stats.walkTicks += r.ticks;
            } finally { walking = false; }
        }
    };
    // Knockout by the ravine archers (1 in 20 arrows, mm_archer.rs2:51-53), then the cell lock (2771,2795;
    // stat_random(thieving, 95, 295), mm_jail.rs2:1-11). The patrol guards (Aberab, Trefaji) knock a human back in
    // from 1 tile in line of sight (mm_jail.rs2:181-203), so the bot picks only when neither is within 2 tiles.
    const DOOR = { x: 2771, z: 2795 };
    const knockout = async (label: string): Promise<void> => {
        want = PFMISS;
        if (!inCell()) {
            await walkStop(`${label} to ravine`, [{ x: 2721, z: 2757, tol: 2 }], inCell);
            for (let t = 0; t < 400 && !inCell(); t++) {
                await q.guard(label);
                await q.waitTicks(1);
            }
            if (!inCell()) await q.fail(`${label}: no knockout`);
        }
        q.milestone(`${label} jailed`);
        const fails0 = q.msgCount(/fail to pick the lock/i);
        for (let i = 0; i < 160 && inCell(); i++) {
            await q.guard(`${label} lock`);
            const d: any = q.s.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) { void q.s.sdk.sendClickDialog(0); await q.waitTicks(1); continue; }
            const g = (q.st()?.nearbyNpcs ?? []).filter((n: any) => /^(aberab|trefaji)$/i.test(n.name) && Math.max(Math.abs(n.x - DOOR.x), Math.abs(n.z - (DOOR.z + 1))) <= 3);
            if (g.length > 0) { await q.waitTicks(1); continue; }
            const door = q.findLoc(l => l.x === DOOR.x && l.z === DOOR.z && /jail door/i.test(l.name));
            if (!door) { await q.waitTicks(1); continue; }
            await q.opLoc(door, q.opIndex(door, /pick|open/i));
            const f1 = q.msgCount(/fail to pick the lock/i);
            await q.waitUntil(() => !inCell() || q.msgCount(/fail to pick the lock/i) > f1, 6);
        }
        if (inCell()) await q.fail(`${label}: lock`);
        console.log(`NOTE ${label} out at ${q.T()} lockFails=${q.msgCount(/fail to pick the lock/i) - fails0}`);
    };

    // A village walk as a human: a patrol guard or a summoned guard can knock the bot back into the cell on the way, so
    // a jailing picks the lock again and walks on (up to 3 times).
    let rejails = 0;
    const walkAtoll = async (label: string, pts0: { x: number; z: number; tol?: number }[]): Promise<void> => {
        const g = pts0[pts0.length - 1]!;
        for (let i = 0; i < 7 && !q.near(g.x, g.z, g.tol ?? 2); i++) {
            if (inCell()) { rejails++; await knockout(`${label} rejail`); }
            await walkStop(label, pts0, inCell);
        }
        if (!q.near(g.x, g.z, (g.tol ?? 2) + 1)) await q.fail(`walk ${label}`);
    };
    // The royal seal is needed only by the shipyard worker and Lumdo (mm_caranock.rs2:50, mm_lumdo.rs2:39): its slot goes
    // to food.
    if (q.has(ITEM.seal)) { await q.s.direct({ type: 'dropItem', slot: q.slot(ITEM.seal)!, reason: 'SDK' } as any); await q.waitTicks(1); }
    // 80. Knockout, jail, lock.
    if (FROM < 80) {
        await knockout('jail1');
        want = 'auto';
        await ms(80);
    }
    // converse without the double click: a page that still reads the same one tick after a click is not clicked again
    // for 3 ticks (a second click on a choice page closed it with no effect in the crate tests).
    const converse1 = async (pats: RegExp[], ok: () => boolean, maxTicks: number): Promise<boolean> => {
        let sig0 = '', at0 = -9;
        for (let i = 0; i < maxTicks && !q.stats.died; i++) {
            if (ok()) return true;
            const d: any = q.s.sdk.getDialog();
            if (!d?.isOpen && sig0.includes("|") && !ok()) { const p: any = q.pos(); console.log(`CLOSE t=${q.T()} tick=${q.s.tick()} dmg=${p?.combat?.lastDamageTick} last=${sig0.split("#")[0]} npcs=${(q.st()?.nearbyNpcs ?? []).filter((k: any) => k.distance <= 10).map((k: any) => `${k.name}@${k.x},${k.z}`).join(" ")}`); sig0 = ""; }
            if (d?.isOpen && !d.isWaiting) {
                const opts: any[] = d.options ?? [];
                const sig = opts.map(o => o.text).join('|') + '#' + (d.text ?? '') + (d.allComponents ?? []).map((c: any) => c.text ?? '').join('');
                if (!(sig === sig0 && i - at0 < 3)) {
                    sig0 = sig; at0 = i;
                    const opt = opts.find(o => pats.some(re => re.test(o.text)));
                    if (opts.some(o => !/click here to continue/i.test(o.text)) && !opt) console.log(`WARN no option match: ${opts.map(o => o.text).join(' | ')}`);
                    void q.s.sdk.sendClickDialog(opt ? opt.index : 0);
                }
            }
            await q.waitTicks(1);
        }
        return ok();
    };
    // Talk with converse1: answers `pats`, tolerates a closed tick between pages (a p_delay, a fade), stops at ok() or
    // after 6 shut ticks, then talks again (up to `tries`).
    const talk1 = async (label: string, re: RegExp | (() => any), pats: RegExp[], ok: () => boolean, maxTicks: number, home?: { x: number; z: number }, tries = 4, must = true): Promise<void> => {
        for (let i = 0; i < tries && !ok(); i++) {
            await q.guard(label);
            if (i > 0) { q.stats.retries++; console.log(`NOTE ${label} talk try ${i}`); }
            const find = (): any => typeof re === "function" ? re() : q.npc(re);
            let n = find();
            if (!n && home) { await walk(`${label} approach`, [{ x: home.x, z: home.z, tol: 3 }]); n = find(); }
            if (!n) { await q.waitTicks(2); continue; }
            if (!q.dialogOpen()) {
                await q.talkTo(n);
                await q.waitUntil(() => q.dialogOpen() || ok(), 20);
            }
            let shut = 0;
            await converse1(pats, () => { shut = q.dialogOpen() ? 0 : shut + 1; return ok() || shut >= 6; }, maxTicks);
        }
        if (must && !ok()) await q.fail(`talk ${label}`);
    };
    // A loc on a named tile: op it, click through pages (answers `pats`), until ok().
    // A hit closes the open dialog even at 0 damage (npc_combat_melee.rs2:36, npc_combat_ranged.rs2:48), so the
    // aggressive pests within `r` tiles (warehouse spiders 2 HP, scorpions 15, spiders and snakes 35) die by Fire Wave
    // before a dialog step. Not as a monkey: the greegree hides the spellbook (quest_mm.rs2:1148-1155).
    const FIRE_WAVE = componentId('magic:fire_wave');
    let pestCasts = 0;
    const clearPests = async (label: string, r = 2): Promise<void> => {
        let last = -99;
        for (let t = 0; t < 60 && !greegree(); t++) {
            await q.guard(`${label} pests`);
            const p = q.pos()!;
            const dd = (k: any) => Math.max(Math.abs(k.x - p.worldX), Math.abs(k.z - p.worldZ));
            const n = (q.st()?.nearbyNpcs ?? []).filter((k: any) => (MELEE.test(k.name) && !/monkey guard/i.test(k.name) && dd(k) <= r))
                .sort((a: any, b: any) => a.distance - b.distance)[0];
            if (!n) return;
            if (q.dialogOpen()) void q.s.sdk.sendClickDialog(0);
            if (q.T() - last >= 5) { last = q.T(); pestCasts++; await q.s.direct({ type: 'spellOnNpc', npcIndex: n.index, spellComponent: FIRE_WAVE, reason: 'SDK' }); }
            await q.waitTicks(1);
        }
    };
    const locOp = async (label: string, at: { x: number; z: number }, re: RegExp, op: RegExp, pats: RegExp[], ok: () => boolean, ticks = 30, tries = 8, pests = true): Promise<void> => {
        for (let i = 0; i < tries && !ok(); i++) {
            await q.guard(label);
            if (i > 0) q.stats.retries++;
            if (pests && q.near(at.x, at.z, 5)) await clearPests(label, 1);
            if (i > 0) console.log(`NOTE ${label} try ${i} npcs=${(q.st()?.nearbyNpcs ?? []).filter((k: any) => k.distance <= 6).map((k: any) => `${k.name}@${k.x},${k.z}`).join(' ')}`);
            const l = q.findLoc(k => k.x === at.x && k.z === at.z && re.test(k.name)) ?? q.findLoc(k => Math.max(Math.abs(k.x - at.x), Math.abs(k.z - at.z)) <= 2 && re.test(k.name) && (k.optionsWithIndex ?? []).some((o: any) => op.test(o.text)));
            if (!l) { console.log(`WARN ${label}: no loc at ${at.x},${at.z} near=${q.locs().filter((k: any) => Math.max(Math.abs(k.x - at.x), Math.abs(k.z - at.z)) <= 4).map((k: any) => `${k.name}@${k.x},${k.z}[${(k.optionsWithIndex ?? []).map((o: any) => o.text).join("/")}]`).join(" ")}`); await walk(`${label} approach`, [{ x: at.x, z: at.z, tol: 3 }]); continue; }
            await q.opLoc(l, q.opIndex(l, op));
            await q.waitUntil(() => q.dialogOpen() || ok(), 15);
            let shut = 0;
            await converse1(pats, () => { shut = q.dialogOpen() ? 0 : shut + 1; return ok() || shut >= 4; }, ticks);
        }
        if (!ok()) await q.fail(`loc ${label}`);
        await shutDialog();
    };
    const inCellar = (): boolean => z() > 9152 && z() < 9216 && level() === 0;

    // 90. Garkor (2805,2762): his story sends you to Zooknock (%mm_garkor 2, mm_garkor.rs2:95-126). The dentures from the
    // crate (2767,2769) from its east tile: the sleeping guard calls guards on a human in 2762-2767,2767-2772
    // (mm_sleeping_monkey_guard.rs2:1-14). The crate over the hole (2769,2765) drops to the cellar (quest_mm.rs2:964-992),
    // the mould crate (2782,9172), the western rope (2764,9165) up (quest_mm.rs2:1012-1017).
    if (FROM < 90) {
        want = 'auto';
        await walkAtoll('to garkor', [{ x: 2804, z: 2770, tol: 1 }, { x: 2806, z: 2764, tol: 1 }]);
        await talkChoose('garkor', /^garkor$/i, () => -1, () => q.sawText(/just go and find my squad mage/i) && !q.dialogOpen(), 80, { x: 2805, z: 2762 });
        q.milestone('garkor');
        await walkAtoll('to denture crate', [{ x: 2806, z: 2767, tol: 1 }, { x: 2784, z: 2764, tol: 1 }, { x: 2764, z: 2763, tol: 0 }, { x: 2765, z: 2765, tol: 0 }, { x: 2769, z: 2766, tol: 0 }, { x: 2769, z: 2768, tol: 0 }, { x: 2768, z: 2769, tol: 0 }]);
        await locOp('dentures', { x: 2767, z: 2769 }, /crate/i, /search/i, [/^yes$/i], () => q.has(ITEM.dentures) && !q.dialogOpen(), 30, 10);
        // The hole crate from its south tile: the warehouse spider (2 HP, respawnrate 4, huntrange 1) spawns at 2770,2766,
        // beside the north and east tiles, and each of its hits closes the crate's choice.
        await walk('to hole south', [{ x: 2770, z: 2765, tol: 0 }, { x: 2769, z: 2764, tol: 0 }]);
        await locOp('hole', { x: 2769, z: 2765 }, /crate/i, /search/i, [/^yes, i'm sure/i], () => inCellar(), 40, 10);
        q.milestone('cellar');
        await walk('to mould crate', [{ x: 2782, z: 9171, tol: 1 }]);
        await locOp('mould', { x: 2782, z: 9172 }, /crate/i, /search/i, [/^yes$/i], () => q.has(ITEM.mould) && !q.dialogOpen());
        // The eastern rope (2798,9169): the western one lands in a warehouse whose only ground door (2744,2767) is locked
        // (quest_mm.rs2:1019-1020). The eastern lands within 2 of 2764,2769, inside the sleeping guard's zone, so the bot
        // runs south out of it at once (a guard call means a knockout and the jail, which toDungeon handles).
        await walk('to east rope', [{ x: 2797, z: 9169, tol: 1 }]);
        await locOp('east rope', { x: 2798, z: 9169 }, /rope/i, /climb/i, [], () => z() < 6400, 10);
        await q.s.direct({ type: 'walkTo', x: 2764, z: 2765, running: true, reason: 'SDK' });
        await q.waitUntil(() => z() <= 2766 || inCell(), 4);
        await ms(90);
    }
    // The village to the landing: the bridge ladder (2803,2734) up to level 2, the end of the bridge (2803,2727) drops
    // to 2803,2724 (quest_mm.rs2:1022-1043); then the dungeon ladder (2763,2703) down to 2763,9103.
    // The dungeon route (about 535 tiles), every 4th corner of the SDK path from the entrance ladder to Zooknock; a
    // single far goal sent the walker into a dead end (2786,9090) on a retry.
    const DUNGEON_IN = '2773,9102 2785,9103 2774,9108 2764,9120 2788,9118 2803,9098 2809,9125 2778,9129 2761,9131 2741,9135 2725,9137 2716,9134 2735,9129 2737,9124 2729,9122 2710,9119 2712,9112 2718,9110 2724,9108 2739,9104 2739,9095 2713,9094 2700,9094 2694,9105 2694,9121 2696,9127 2715,9146 2725,9146 2775,9144 2792,9141 2803,9145'
        .split(' ').map(s => { const [x, zz] = s.split(',').map(Number); return { x: x!, z: zz!, tol: 2 }; });
    const DUNGEON_OUT = [...DUNGEON_IN].reverse().slice(1).concat([{ x: 2763, z: 9104, tol: 1 }]);
    const toDungeon = async (label: string): Promise<void> => {
        if (inCell()) await knockout(`${label} jail`);
        if (z() < 6400 && z() > 2727) {
            await walkAtoll(`${label} to bridge ladder`, [{ x: 2803, z: 2735, tol: 1 }]);
            await locOp(`${label} bridge ladder`, { x: 2803, z: 2734 }, /ladder/i, /climb/i, [], () => level() === 2, 10);
            await walk(`${label} bridge`, [{ x: 2803, z: 2728, tol: 0 }]);
            await locOp(`${label} jump`, { x: 2803, z: 2727 }, /end of bridge/i, /jump/i, [], () => level() === 0 && z() <= 2725, 10);
        }
        if (z() < 6400) {
            await walk(`${label} to dungeon ladder`, [{ x: 2763, z: 2704, tol: 1 }]);
            await locOp(`${label} dungeon down`, { x: 2763, z: 2703 }, /ladder/i, /climb/i, [], () => z() > 9000, 10);
        }
        await walk(`${label} to zooknock`, DUNGEON_IN.slice(0, -1).concat([{ x: 2803, z: 9145, tol: 1 }]));
    };
    const ZOOKNOCK = { x: 2804, z: 9145 };
    const giveZooknock = async (label: string, id: number, ok: () => boolean): Promise<void> => {
        for (let i = 0; i < 4 && q.has(id); i++) {
            await q.guard(label);
            await clearPests(label, 1);
            if (q.dialogOpen()) { await (q.s.sdk as any).sendCloseModal?.(); await q.waitTicks(1); }
            const n = q.npc(/^zooknock$/i);
            if (!n) { await walk(`${label} approach`, [{ x: ZOOKNOCK.x, z: ZOOKNOCK.z - 2, tol: 2 }]); continue; }
            await q.useOnNpc(id, n);
            await q.waitUntil(() => !q.has(id) || q.dialogOpen(), 15);
        }
        if (q.has(id)) await q.fail(`${label}: not taken`);
        let shut = 0;
        await converse1([], () => { shut = q.dialogOpen() ? 0 : shut + 1; return (ok() && !q.dialogOpen()) || shut >= 8; }, 40);
    };

    // 100. To Zooknock (2804,9145) through the dungeon (about 535 tiles): his story, and Garkor's request gives the
    // mission (%mm_zooknock 5, mm_zooknock.rs2:304-316, needs %mm_garkor 2). Then the dentures, the gold bar and the mould
    // (opnpcu, :48-96): the enchanted bar and the mould back (:163-201); the monkey bones go now too (the talisman
    // half is open from :315).
    if (FROM < 100) {
        want = 'auto';
        await toDungeon('zooknock1');
        q.milestone('dungeon1');
        const optSeen = (re: RegExp): boolean => (q.s.sdk.getDialog()?.options ?? []).some((o: any) => re.test(o.text));
        await talk1('zooknock', /^zooknock$/i, [], () => optSeen(/need for the monkey amulet/i), 200, ZOOKNOCK);
        await giveZooknock('dentures', ITEM.dentures, () => true);
        await giveZooknock('gold bar', ITEM.goldBar, () => true);
        await giveZooknock('mould', ITEM.mould, () => q.has(ITEM.encBar));
        await giveZooknock('bones', ITEM.bones, () => true);
        if (!q.has(ITEM.encBar) || !q.has(ITEM.mould)) await q.fail('zooknock: no enchanted bar');
        await ms(100);
    }
    const topUp = async (min: number): Promise<void> => {
        for (let i = 0; i < 4 && q.hp() < min && q.has(ITEM.food); i++) {
            const h0 = q.hp();
            await q.s.direct({ type: 'useInventoryItem', slot: q.slot(ITEM.food)!, optionIndex: 1, reason: 'SDK' });
            await q.waitUntil(() => q.hp() > h0, 3);
            q.stats.eats++;
        }
    };
    const wear = async (label: string, id: number): Promise<void> => {
        await q.step(`wear ${label}`, () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(id)!, optionIndex: 2, reason: 'SDK' }), () => !q.has(id), 4, 3);
    };
    const inAuntA = (x: number, zz: number): boolean => x >= 2740 && x <= 2746 && zz >= 2792 && zz <= 2798;
    // The aunt calls guards on a human within 5 tiles when both stand inside her garden (2740-2746,2792-2798) or both
    // outside it (mm_monkeys_aunt.rs2:5-30). She patrols (quest_mm.npc [mm_monkeys_aunt]): 2742,2794 (15 ticks),
    // 2743,2792 (30) by the child, then south and round through her house (2733-2737) and back in from the west. So the
    // bot is in the garden only while she is away from it (margin: 2737-2747,2791-2799) and waits at 2746,2800, outside
    // it and more than 5 tiles from her route, while she is there. A tick hook pulls it out when she comes back.
    const auntNear = (): boolean => { const a = q.npc(/monkey's aunt/i); return !!a && a.x >= 2737 && a.x <= 2747 && a.z >= 2791 && a.z <= 2799; };
    const meInA = (): boolean => { const p = q.pos(); return !!p && inAuntA(p.worldX, p.worldZ); };
    const OUTSIDE = { x: 2746, z: 2800 };
    let auntWatch = false, auntExits = 0;
    q.s.onTick(() => {
        if (!auntWatch || !meInA() || !auntNear()) return;
        auntExits++;
        void q.s.direct({ type: 'walkTo', x: OUTSIDE.x, z: OUTSIDE.z, running: true, reason: 'SDK' });
    });
    const auntClear = async (max: number): Promise<void> => {
        for (let t = 0; t < max && auntNear(); t++) await q.waitTicks(1);
    };
    const CHILD = { x: 2743, z: 2795 };
    // A cutscene (quest_mm.rs2:279-360, 382-482, 510-637) advances one page per click; a page closed by anything else
    // (an eat, a potion) leaves it waiting for the walktrigger, so a step to the next tile restarts it. Ends when the
    // player is back outside the cutscene region.
    const cutscene = async (inCut: () => boolean): Promise<void> => {
        let shut = 0;
        for (let t = 0; t < 600 && inCut(); t++) {
            await q.guard('cutscene');
            const d: any = q.s.sdk.getDialog();
            shut = d?.isOpen ? 0 : shut + 1;
            if (d?.isOpen && !d.isWaiting) void q.s.sdk.sendClickDialog(0);
            if (shut >= 4) { const p = q.pos()!; shut = 0; void q.s.direct({ type: 'walkTo', x: p.worldX + 1, z: p.worldZ, running: false, reason: 'SDK' }); }
            await q.waitTicks(1);
        }
        await shutDialog();
    };

    // 110. Back to the landing (dungeon exit ladder 2763,9103), the second knockout and lock; the temple: its south
    // ladder (2794,2773) up, level 1 to 2806,2785, the east ladder top (2805,2785) drops on the trapdoor's access tile
    // (quest_mm.rs2:766-771; the 2x2 trapdoor guards box it at level 0); the trapdoor (2807,2785, mm_temple.rs2:1-17);
    // the enchanted bar on the fire with the mould (quest_mm.rs2:1066-1082), wool on the amulet (:1084-1089); the rope
    // (2808,9201) up; the amulet worn; the monkey child (mm_monkey_child.rs2): uncle, bananas, the toy after the
    // 100-tick timer: the talisman; the dungeon to Zooknock: the talisman (the bones went in stage 100): the Karamjan
    // greegree and the chapter 3 cutscene (mm_zooknock.rs2:203-228, quest_mm.rs2:169-210).
    if (FROM < 105) {
        want = 'auto';
        if (z() > 6400) {
            await walk('to dungeon exit', DUNGEON_OUT);
            await locOp('dungeon up', { x: 2763, z: 9103 }, /ladder/i, /climb/i, [], () => z() < 6400, 10);
        }
        await knockout('jail2');
        want = 'auto';
        await walkAtoll('to temple ladder', [{ x: 2794, z: 2772, tol: 0 }]);
        // The temple and the fire room: the religious guards (level 167) and the zombie guards hit 10-12 through a late
        // toggle, so Protect from Melee stays on and the bot eats up to 30 first.
        await topUp(30);
        want = PFM;
        await locOp('temple ladder', { x: 2794, z: 2773 }, /ladder/i, /climb/i, [], () => level() === 1, 10);
        await walk('temple roof', [{ x: 2806, z: 2785, tol: 0 }]);
        await locOp('temple drop', { x: 2805, z: 2785 }, /ladder/i, /climb/i, [], () => level() === 0, 10);
        await locOp('trapdoor open', { x: 2807, z: 2785 }, /trapdoor/i, /open/i, [], () => !!q.findLoc(l => l.x === 2807 && l.z === 2785 && /climb/i.test((l.optionsWithIndex ?? []).map((o: any) => o.text).join())), 6);
        await locOp('trapdoor down', { x: 2807, z: 2785 }, /trapdoor/i, /climb/i, [], () => z() > 9152, 10);
        q.milestone('fire room');
        for (let i = 0; i < 4 && q.has(ITEM.encBar); i++) {
            await q.guard('fire');
            // The wall of flame has no ops, so it may not be in nearbyLocs: mm_iban_firewall_straight (4765) at 2809,9191.
            const f = q.findLoc(l => /flame|fire/i.test(l.name) && l.x >= 2809 && l.x <= 2813 && l.z >= 9189 && l.z <= 9193) ?? { id: 4765, x: 2809, z: 9191 };
            if (!f) { await walk('to fire', [{ x: 2809, z: 9195, tol: 1 }]); continue; }
            await q.useOnLoc(ITEM.encBar, f);
            await q.waitUntil(() => q.has(ITEM.amuletUnstrung), 15);
        }
        if (!q.has(ITEM.amuletUnstrung)) await q.fail('fire: no amulet');
        await q.step('string amulet', () => q.useOnItem(ITEM.wool, ITEM.amuletUnstrung), () => q.has(ITEM.amulet), 6, 3);
        q.milestone(105);
    }
    if (FROM < 107) {
        want = PFM;
        // Out of the fire room through the warehouse cellar if the level-1 collision (the fire room and the cellar are
        // bridged tiles in m43_143) joins them: the client-routed walk to the eastern rope. Else the temple rope.
        for (let i = 0; i < 6 && !q.near(2797, 9170, 2); i++) {
            await q.guard('to cellar');
            await q.s.direct({ type: 'walkTo', x: 2797, z: 9170, running: true, reason: 'SDK' });
            await q.waitUntil(() => q.near(2797, 9170, 2), 10);
        }
        console.log(`NOTE fire room to cellar: ${q.near(2797, 9170, 2) ? 'joined' : 'not joined'} at ${q.pos()?.worldX},${q.pos()?.worldZ}`);
        if (q.near(2797, 9170, 2)) {
            await locOp('east rope 2', { x: 2798, z: 9169 }, /rope/i, /climb/i, [], () => z() < 6400, 10);
            await q.s.direct({ type: 'walkTo', x: 2764, z: 2765, running: true, reason: 'SDK' });
            await q.waitUntil(() => z() <= 2766 || inCell(), 4);
        }
        if (z() > 6400) await walk('to temple rope', [{ x: 2807, z: 9201, tol: 1 }]);
        // The rope is a bridged level-1 loc (map m43_143) and is not in nearbyLocs, so the op goes by id
        // (mm_climbing_rope_bottom_temple 4881). It lands on a random tile within 2 of the trapdoor (mm_temple.rs2:28),
        // inside the box of the 2x2 trapdoor guards (blockwalk=all, wanderrange 1). The way out is the ladder beside it
        // (2805,2785) to level 1, then the south ladder top (2794,2773) down; a landing with no way to the ladder goes
        // back down the trapdoor and up the rope again for a new tile.
        const ropeUp = async (): Promise<void> => {
            for (let i = 0; i < 5 && z() > 6400; i++) {
                await q.guard('temple rope');
                const r = q.findLoc(l => /rope/i.test(l.name) && Math.abs(l.x - 2808) <= 2 && Math.abs(l.z - 9201) <= 2) ?? { id: 4881, x: 2808, z: 9201 };
                await q.opLoc(r, 1);
                await q.waitUntil(() => z() < 6400, 10);
            }
            if (z() > 6400) await q.fail('temple rope');
        };
        await ropeUp();
        for (let roll = 0; roll < 6 && level() !== 1 && q.near(2806, 2785, 2); roll++) {
            for (let t = 0; t < 15 && level() !== 1; t += 3) {
                await q.guard('temple up');
                const lad = q.findLoc(l => l.x === 2805 && l.z === 2785 && /ladder/i.test(l.name)) ?? { id: 4772, x: 2805, z: 2785 };
                await q.opLoc(lad, 1);
                await q.waitUntil(() => level() === 1, 3);
            }
            if (level() === 1) break;
            console.log(`NOTE temple landing ${q.pos()?.worldX},${q.pos()?.worldZ} boxed: down and up again`);
            for (let t = 0; t < 20 && z() < 6400; t += 4) {
                const td = q.findLoc(l => l.x === 2807 && l.z === 2785 && /trapdoor/i.test(l.name));
                if (td) await q.opLoc(td, q.opIndex(td, /climb|open/i));
                await q.waitUntil(() => z() > 6400, 4);
            }
            if (z() > 6400) { await q.waitTicks(1); await ropeUp(); }
        }
        if (level() !== 1) await q.fail('temple up');
        await walk('temple roof back', [{ x: 2794, z: 2774, tol: 1 }]);
        await locOp('temple down', { x: 2794, z: 2773 }, /ladder/i, /climb-down/i, [], () => level() === 0, 10);
        want = 'auto';
        await wear('amulet', ITEM.amulet);
        q.milestone(107);
    }
    if (FROM < 110) {
        want = 'auto';
        const toOutside = async (): Promise<void> => {
            if (inCell()) await knockout('jail child');
            if (!q.near(OUTSIDE.x, OUTSIDE.z, 1) && !meInA()) await walkAtoll('to garden', [{ x: 2749, z: 2800, tol: 1 }, { x: OUTSIDE.x, z: OUTSIDE.z, tol: 0 }]);
        };
        const childTalk = async (label: string, pats: RegExp[], ok: () => boolean, tries: number): Promise<void> => {
            for (let i = 0; i < tries && !ok(); i++) {
                await q.guard(label);
                await toOutside();
                await auntClear(150);
                await talk1(label, /^monkey child$/i, pats, ok, 60, CHILD, 1, false);
            }
            if (!ok()) await q.fail(`${label}: not done`);
        };
        auntWatch = true;
        await childTalk('child', [/monkey's uncle/i, /how many bananas/i], () => !q.has(ITEM.banana), 10);
        const gaveAt = q.T();
        await converse1([], () => !q.dialogOpen(), 20);
        console.log(`NOTE bananas given at ${gaveAt}`);
        await toOutside();
        await q.waitUntil(() => q.T() - gaveAt >= 100, 110);
        await childTalk('child toy', [], () => q.has(ITEM.talisman), 6);
        await converse1([], () => !q.dialogOpen(), 20);
        auntWatch = false;
        console.log(`NOTE child done auntExits=${auntExits}`);
        q.milestone('talisman');
        await toDungeon('zooknock2');
        await topUp(26);   // an eat inside the cutscene closes its page
        await giveZooknock('talisman', ITEM.talisman, () => q.has(ITEM.greegree));
        // A hit closes his talisman pages before the spell; asking about the talisman runs the same check again
        // (mm_zooknock.rs2:282-284, both parts are already his).
        if (!q.has(ITEM.greegree)) await talk1('zooknock greegree', /^zooknock$/i, [/need for the monkey talisman/i], () => q.has(ITEM.greegree), 60, ZOOKNOCK);
        // The chapter 3 cutscene runs in region 0_41_71 (2624-2687, 4544-4607) and returns the player to the coord
        // saved at its start (%mm_cutscene_coord).
        const inCut3 = (): boolean => { const p = q.pos(); return !!p && p.worldX >= 2624 && p.worldX < 2688 && p.worldZ >= 4544 && p.worldZ < 4608; };
        await q.waitUntil(() => inCut3(), 30);
        await cutscene(inCut3);
        if (!q.has(ITEM.greegree) || inCut3()) await q.fail('chapter 3');
        await ms(110);
    }
    // ---- Chapter 3: a monkey. The Karamjan greegree works only in the greegree zones (the atoll, its dungeons, the
    // Ardougne zoo; quest_mm.rs2:1102-1108) and drops back into the pack outside them (mm_greegree.rs2:12-40); a monkey
    // is ignored by the archers and the guards (mm_archer.rs2:24, aa_monkey_guard.rs2:27). It takes the weapon slot.
    const wearGreegree = async (label: string): Promise<void> => {
        for (let i = 0; i < 12 && !greegree(); i++) {
            await q.guard(label);
            const s = q.slot(ITEM.greegree);
            if (s === undefined) await q.fail(`${label}: no greegree`);
            await q.s.direct({ type: 'useInventoryItem', slot: s!, optionIndex: 2, reason: 'SDK' });
            // "You cannot use this whilst in combat" for 10 ticks after a hit (mm_greegree.rs2:6-9).
            await q.waitUntil(() => greegree(), 3);
        }
        if (!greegree()) await q.fail(`${label}: greegree not worn`);
    };
    const unwearGreegree = async (): Promise<void> => {
        await q.step('greegree off', () => q.s.direct({ type: 'useEquipmentItem', slot: 3, optionIndex: 1, reason: 'SDK' } as any), () => !greegree(), 4, 3);
    };
    // The west gate (2719-2721,2766) opens only for a monkey (quest_mm.rs2:1110-1146): Kruk's line, then a forcemove
    // 3 tiles north.
    const throughGate = async (label: string): Promise<void> => {
        await walk(`${label} to gate`, [{ x: 2720, z: 2763, tol: 1 }]);
        await locOp(`${label} gate`, { x: 2719, z: 2766 }, /bamboo gate/i, /open/i, [], () => z() >= 2768 && !q.dialogOpen(), 20, 6, false);
    };
    // The village to the landing by the one-way bridge (quest_mm.rs2:1022-1043).
    const toLanding = async (label: string): Promise<void> => {
        if (z() < 6400 && z() > 2727) {
            await walk(`${label} to bridge ladder`, [{ x: 2803, z: 2735, tol: 1 }]);
            await locOp(`${label} bridge ladder`, { x: 2803, z: 2734 }, /ladder/i, /climb/i, [], () => level() === 2, 10);
            await walk(`${label} bridge`, [{ x: 2803, z: 2728, tol: 0 }]);
            if (greegree()) await unwearGreegree();   // "You do not want to do that as a monkey" (quest_mm.rs2:1036-1040)
            await locOp(`${label} jump`, { x: 2803, z: 2727 }, /end of bridge/i, /jump/i, [], () => level() === 0 && z() <= 2725, 10);
        }
    };
    const ELDER = { x: 2801, z: 2757 };
    // mm_elder_guard_2 (2801,2757) talks; mm_elder_guard_1 (2798,2760) only growls. Both are "Elder Guard".
    const elder2 = (): any => (q.st()?.nearbyNpcs ?? []).filter((n: any) => /^elder guard$/i.test(n.name))
        .sort((a: any, b: any) => (Math.abs(a.x - ELDER.x) + Math.abs(a.z - ELDER.z)) - (Math.abs(b.x - ELDER.x) + Math.abs(b.z - ELDER.z)))[0];
    // Awowogei's hall: 2800-2804,2759-2765; its door (2802,2759) opens south onto the elder guards.
    const inThrone = (): boolean => q.near(2802, 2762, 3) && z() >= 2759;
    const throne = async (label: string, ok: () => boolean): Promise<void> => {
        await locOp(label, { x: 2802, z: 2765 }, /awowogei/i, /talk/i, [], ok, 80, 4, false);
    };
    const leaveThrone = async (): Promise<void> => {
        if (!inThrone()) return;
        await q.dash('to hall door', 2802, 2759, 0, 10);
        await talk1('elder leave', elder2, [/leave now/i], () => !inThrone() && !q.dialogOpen(), 20, undefined, 3);
    };
    const inCage = (): boolean => { const p = q.pos(); return !!p && p.worldX >= 2598 && p.worldX <= 2606 && p.worldZ >= 3274 && p.worldZ <= 3282; };
    const spirit = async (label: string, at: { x: number; z: number }, pats: RegExp[], land: { x: number; z: number }): Promise<void> => {
        await walk(`to ${label}`, [{ x: at.x, z: at.z - 2, tol: 2 }]);
        for (let i = 0; i < 3 && !q.near(land.x, land.z, 8); i++) {
            await q.guard(label);
            const t = q.findLoc(l => /tree/i.test(l.name) && near3(l, at, 2) && (l.optionsWithIndex ?? []).length > 0);
            if (!t) { await q.waitTicks(1); continue; }
            await q.opLoc(t, 1);
            await q.waitUntil(() => q.dialogOpen(), 15);
            await converse1(pats, () => q.near(land.x, land.z, 8), 40);
        }
        if (!q.near(land.x, land.z, 8)) await q.fail(label);
        await shutDialog();
    };

    // 115. As a monkey: the dungeon back, the gate, Garkor (the Karamjan monkey: seek an alliance, mm_garkor.rs2:60-76,
    // 128-140), the elder guard (Kruk's name, mm_elder_guard.rs2:43-51), Kruk on the west watchtower bridge (level 2,
    // by the west tower ladder 2713,2766, quest_mm.rs2:803-808; he escorts the envoy to Awowogei, mm_kruk.rs2:10-25),
    // Awowogei's mission (mm_awowogei.rs2:63-92).
    if (FROM < 115) {
        want = 'auto';
        await wearGreegree('greegree');
        q.milestone('monkey');
        if (z() > 6400) {
            await walk('to dungeon exit 2', DUNGEON_OUT);
            await locOp('dungeon up 2', { x: 2763, z: 9103 }, /ladder/i, /climb/i, [], () => z() < 6400, 10);
        }
        await throughGate('gate1');
        await walk('to garkor m', [{ x: 2804, z: 2770, tol: 1 }, { x: 2806, z: 2764, tol: 1 }]);
        await talk1('garkor monkey', /^garkor$/i, [], () => q.sawText(/must win his trust/i) && !q.dialogOpen(), 60, { x: 2805, z: 2762 });
        await walk('to elder', [{ x: 2802, z: 2755, tol: 1 }]);
        await talk1('elder kruk', elder2, [], () => q.sawText(/name of kruk/i) && !q.dialogOpen(), 30, ELDER);
        await walk('to west tower', [{ x: 2714, z: 2766, tol: 0 }]);
        await locOp('west tower up', { x: 2713, z: 2766 }, /ladder/i, /climb/i, [], () => level() === 2, 10);
        // Kruk walks the closed yard east of the gate (2726-2732,2760-2769, level 0): over the bridge (level 2) and
        // down the east tower (2729,2766, quest_mm.rs2:824-829).
        await walk('tower bridge', [{ x: 2728, z: 2766, tol: 0 }]);
        await locOp('east tower down', { x: 2729, z: 2766 }, /ladder/i, /climb/i, [], () => level() === 0, 10);
        await talk1('kruk', /^kruk$/i, [], () => inThrone() && !q.dialogOpen(), 40, { x: 2728, z: 2765 });
        q.milestone('awowogei');
        await throne('awowogei mission', () => q.sawText(/with one of the captives/i) && !q.dialogOpen());
        await ms(115);
    }

    // 120. The zoo trip: out by the elder guard, the bridge to the landing, Lumdo to Crash Island (mm_lumdo.rs2:5-16;
    // the greegree drops off), Waydar to the Gnomeball pitch (mm_waydar.rs2:58-68, 121-127), the stronghold spirit tree
    // to the Battlefield of Khazard (spirit_tree.rs2:1-23), the zoo (2600,3277): the greegree on (the zoo is a greegree
    // zone), the Monkey Minder cages the "monkey" (mm_monkey_minder.rs2:28-50), a zoo monkey jumps in the backpack
    // (mm_zoo_monkey.rs2:1-35), the greegree off, the minder lets the human out (:6-25). Back with the monkey (a spirit
    // tree or a teleport deletes it, teleport.rs2:109-112): walk to the Grand Tree, Daero's blindfold, Waydar, Lumdo,
    // the gate, the elder guard (Kruk has spoken: straight in, mm_elder_guard.rs2:30-41), Awowogei (:39-51), Garkor:
    // the chapter 4 cutscene (mm_garkor.rs2:128-138, quest_mm.rs2:211-256) and then the sigil (:25-47).
    if (FROM < 120) {
        want = 'auto';
        await leaveThrone();
        await toLanding('zoo');
        await talk1('lumdo out', /^lumdo$/i, [], () => (q.pos()?.worldX ?? 0) > 2880, 20, { x: 2803, z: 2707 });
        await shutDialog();
        await talk1('waydar home', /^waydar$/i, [/return to your kingdom/i], () => q.near(2393, 3466, 10), 40, { x: 2897, z: 2727 });
        await shutDialog();
        await spirit('stronghold tree', { x: 2461, z: 3444 }, [/where can i go/i, /battlefield of khazard/i], { x: 2555, z: 3259 });
        // Round the locked door of the Khazard building (2567-2569,3237-3239) that the SDK plans through.
        await walk('to zoo', [{ x: 2561, z: 3241, tol: 2 }, { x: 2566, z: 3232, tol: 2 }, { x: 2576, z: 3230, tol: 2 }, { x: 2581, z: 3248, tol: 2 }, { x: 2598, z: 3268, tol: 2 }, { x: 2603, z: 3272, tol: 2 }]);
        await wearGreegree('zoo greegree');
        const minder = (): any => q.npc(/^monkey minder$/i);
        await talk1('minder cage', minder, [], () => inCage() && !q.dialogOpen(), 40, { x: 2602, z: 3274 });
        const zooMonkey = (): any => (q.st()?.nearbyNpcs ?? []).filter((n: any) => /^monkey$/i.test(n.name) && (n.optionsWithIndex ?? []).some((o: any) => /talk/i.test(o.text)))
            .sort((a: any, b: any) => a.distance - b.distance)[0];
        await talk1('zoo monkey', zooMonkey, [], () => q.has(ITEM.backpackMonkey) && !q.dialogOpen(), 60);
        await unwearGreegree();
        await talk1('minder out', minder, [], () => !inCage() && !q.dialogOpen(), 40);
        q.milestone('zoo');
        // The stronghold's south gate (gnome_areagate 190 at 2459,3383, gnome_gate.rs2) is not a door in the SDK
        // collision, so the walk goes to it, through it by op, then north to the Grand Tree.
        await walk('zoo to gate', [{ x: 2604, z: 3294, tol: 2 }, { x: 2593, z: 3306, tol: 2 }, { x: 2571, z: 3322, tol: 2 }, { x: 2559, z: 3337, tol: 2 }, { x: 2512, z: 3340, tol: 2 }, { x: 2482, z: 3358, tol: 2 }, { x: 2463, z: 3369, tol: 2 }, { x: 2461, z: 3381, tol: 1 }]);
        // Femi asks for help with her boxes at the gate the first time (femi.rs2:75-90): "Sorry, I'm a bit busy."
        for (let i = 0; i < 8 && z() < 3385; i++) {
            await q.guard('stronghold gate');
            if (q.dialogOpen()) { await converse1([/bit busy/i], () => !q.dialogOpen(), 20); continue; }
            await q.opLoc(q.findLoc(l => /gate/i.test(l.name) && near3(l, { x: 2460, z: 3383 }, 2)) ?? { id: 190, x: 2459, z: 3383 }, 1);
            await q.waitUntil(() => z() >= 3385 || q.dialogOpen(), 8);
        }
        if (z() < 3385) await q.fail('stronghold gate');
        await walk('gate to tree', [{ x: 2460, z: 3410, tol: 2 }, { x: 2460, z: 3443, tol: 2 }, { x: 2458, z: 3463, tol: 2 }, { x: 2465, z: 3489, tol: 2 }]);
        await enterTree();
        await treeTo(1);
        await talk1('daero hangar', /^daero$/i, [/^yes/i], () => z() > 4400 && level() === 0, 40, DAERO);
        await shutDialog();
        await talk1('waydar back', /^waydar$/i, [/^yes/i], () => q.near(CRASH_ISLAND.x, CRASH_ISLAND.z, 8), 40);
        await shutDialog();
        await talk1('lumdo back', /^lumdo$/i, [], () => q.near(2802, 2707, 6), 20, { x: 2891, z: 2724 });
        await shutDialog();
        await wearGreegree('atoll greegree');
        await throughGate('gate2');
        await walk('to elder 2', [{ x: 2802, z: 2755, tol: 1 }]);
        await talk1('elder in', elder2, [/speak with awowogei again/i], () => inThrone() && !q.dialogOpen(), 30, ELDER);
        await throne('awowogei captive', () => q.sawText(/we will contact you when we are ready/i) && !q.dialogOpen());
        q.milestone('awowogei done');
        await leaveThrone();
        await walk('to garkor 3', [{ x: 2804, z: 2770, tol: 1 }, { x: 2806, z: 2764, tol: 1 }]);
        // The chapter 4 cutscene runs in 1_41_71 (2624-2687, 4544-4607, level 1) and returns to the saved coord.
        const inCut4 = (): boolean => { const p = q.pos(); return !!p && p.level === 1 && p.worldX >= 2624 && p.worldX < 2688 && p.worldZ >= 4544 && p.worldZ < 4608; };
        await talk1('garkor ch4', /^garkor$/i, [], () => inCut4(), 60, { x: 2805, z: 2762 });
        await cutscene(inCut4);
        await talk1('garkor sigil', /^garkor$/i, [], () => q.has(ITEM.sigil) && !q.dialogOpen(), 60, { x: 2805, z: 2762 });
        // The fight gear back: the staff of fire (the greegree comes off with it) and the amulet of magic.
        await wear('staff', 1387);
        await wear('amulet of magic', 1727);
        await ms(120);
    }

    // The atoll helpers stop here: the battle keeps its own prayer and potions.
    want = null; offWant(); offPot();
    console.log(`NOTE atoll done antipoisons=${antipoisons} potions=${potionsAtoll} pestCasts=${pestCasts} rejails=${rejails}`);
    // 140. Wear the sigil (OPHELD2, mm_demon.rs2:1-5; timer 10, then the battle zone 1_42_143, a corner by player count,
    // :35-92). The jungle demon spawns 5-10 tiles away (:160). Its waves (max 31) are 0 under Protect from Magic
    // (:349-354); it melees only within 2 tiles (:332-336), so the bot keeps 4+ tiles away. Fire Wave (Magic 75, max 20)
    // with the staff of fire; the squad's hits (0-1) can never kill it (:403-417), and the kill counts only for the
    // top damage dealer (npc_findhero, :379).
    const PFMAGIC = 12;
    const pmOn = (): boolean => !!q.st()?.prayers?.activePrayers?.[PFMAGIC];
    const points = (): number => q.st()?.prayers?.prayerPoints ?? 0;
    let potions = 0;
    const keepPrayer = async (): Promise<void> => {
        if (points() > 6) return;
        const pot = ITEM.prayerPot.find(id => q.has(id));
        if (!pot) return;
        const p0 = points();
        potions++;
        await q.step('prayer potion', () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(pot)!, optionIndex: 1, reason: 'SDK' }), () => points() > p0, 3, 2);
    };
    const inBattle = (): boolean => { const p = q.pos(); return !!p && p.level === 1 && p.worldX >= 2688 && p.worldX < 2752 && p.worldZ >= 9152 && p.worldZ < 9216; };
    let fightTicks = 0, casts = 0;
    if (FROM < 140) {
        await q.step('wear sigil', () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(ITEM.sigil)!, optionIndex: 2, reason: 'SDK' }), () => inBattle(), 40, 2);
        q.milestone('battle');
        const demon = () => q.npc(/^jungle demon$/i);
        // Garkor's "Ready yourself" page comes first (garkor_final_battle, :146-152); the demon queue runs after it.
        // The prayer goes on as soon as the arrival delay lets it (a hit for 5 landed before the demon showed in a
        // test run; a toggle inside the p_delay of :90-100 is dropped).
        await q.converse([], () => {
            if (!pmOn() && points() > 0) void q.s.direct({ type: 'togglePrayer', prayerIndex: PFMAGIC, reason: 'SDK' });
            return !!demon() && pmOn();
        }, 80);
        if (!demon()) await q.fail('no jungle demon');
        await q.step('protect from magic', () => q.s.direct({ type: 'togglePrayer', prayerIndex: PFMAGIC, reason: 'SDK' }), pmOn, 3, 3);
        const WAVE = componentId('magic:fire_wave');
        const lastMsg = (re: RegExp): number => Math.max(-1, ...(q.st()?.gameMessages ?? []).filter((m: any) => m.type === 0 && re.test(m.text)).map((m: any) => m.observationId ?? m.tick));
        const runes0 = lastMsg(/do not have enough/i);
        const t0 = q.T();
        let seenDead = 0, lastCast = -99, lastStep = -99;
        for (let t = 0; t < 1500; t++) {
            await q.guard('demon');
            const d: any = q.s.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) void q.s.sdk.sendClickDialog(0);
            await keepPrayer();
            if (!pmOn() && points() > 0) await q.s.direct({ type: 'togglePrayer', prayerIndex: PFMAGIC, reason: 'SDK' });
            const n = demon();
            if (!n) { if (++seenDead >= 3) break; await q.waitTicks(1); continue; }
            seenDead = 0;
            const p = q.pos()!;
            const cx = n.tileX !== undefined ? n.tileX + 1 : n.x, cz = n.tileZ !== undefined ? n.tileZ + 1 : n.z;
            const dist = Math.max(Math.abs(p.worldX - cx), Math.abs(p.worldZ - cz));
            if (dist <= 3 && q.T() - lastStep >= 3) {
                // Step 6 tiles straight away from the demon's centre, inside the zone.
                const dx = Math.sign(p.worldX - cx) || 1, dz = Math.sign(p.worldZ - cz) || 1;
                const tx = Math.min(2749, Math.max(2690, p.worldX + 6 * dx)), tz = Math.min(9213, Math.max(9154, p.worldZ + 6 * dz));
                lastStep = q.T();
                await q.s.direct({ type: 'walkTo', x: tx, z: tz, running: true, reason: 'SDK' });
                await q.waitTicks(1);
                continue;
            }
            if (!q.dialogOpen() && q.T() - lastCast >= 5 && q.T() - lastStep >= 2) {
                casts++; lastCast = q.T();
                await q.s.direct({ type: 'spellOnNpc', npcIndex: n.index, spellComponent: WAVE, reason: 'SDK' });
            }
            if (lastMsg(/do not have enough/i) > runes0) await q.fail('out of runes');
            await q.waitTicks(1);
        }
        fightTicks = q.T() - t0;
        if (demon()) await q.fail('demon: not dead');
        console.log(`NOTE demon down after ${fightTicks} ticks casts=${casts} prayer=${points()} potions=${potions} hp=${q.hp()}`);
        await q.s.direct({ type: 'togglePrayer', prayerIndex: PFMAGIC, reason: 'SDK' });
        await ms(140);
    }

    // 150. Varrock Teleport out of the battle zone (the squad deletes itself when the player leaves, :212-220; %mm_main
    // is already 6), the Varrock young tree, the village tree to the stronghold, Narnode (mm_narnode.rs2:14-31).
    if (FROM < 150) {
        await q.converse([], () => !q.dialogOpen(), 10);
        await q.teleport('varrock teleport', 'magic:varrock_teleport', 3213, 3424);
        const spiritTree = async (label: string, at: { x: number; z: number }, pats: RegExp[], land: { x: number; z: number }): Promise<void> => {
            await walk(`to ${label}`, [{ x: at.x, z: at.z - 2, tol: 2 }]);
            for (let i = 0; i < 3 && !q.near(land.x, land.z, 8); i++) {
                await q.guard(label);
                const t = q.findLoc(l => /tree/i.test(l.name) && near3(l, at, 2) && (l.optionsWithIndex ?? []).length > 0);
                if (!t) { await q.waitTicks(1); continue; }
                await q.opLoc(t, 1);
                await q.waitUntil(() => q.dialogOpen(), 15);
                await q.converse(pats, () => q.near(land.x, land.z, 8), 40);
            }
            if (!q.near(land.x, land.z, 8)) await q.fail(label);
            await shutDialog();
        };
        await spiritTree('varrock tree', { x: 3177, z: 3506 }, [/^yes please/i], { x: 2542, z: 3169 });
        await spiritTree('village tree', { x: 2543, z: 3168 }, [/where can i go/i, /gnome stronghold/i], { x: 2461, z: 3443 });
        await enterTree();
        await ms(150);
    }

    // 160. Narnode: the report, the reward (3 free slots, mm_narnode.rs2:89-100), the completion; Daero (l1): option 1
    // "Focus on increasing strength and stamina" (mm_daero.rs2:240-302): 35,000 Strength and Hitpoints, 20,000 Attack and
    // Defence base XP (x25).
    let questDone = false;
    const offDone = q.s.onTick(() => { if (q.msgCount(/quest complete|completed the\s+'?monkey madness/i) > 0) questDone = true; });
    if (FROM < 160) {
        await treeTo(0);
        await talkChoose('narnode report', /^king narnode/i, () => -1, () => (questDone || q.sawText(/sign up for training|you had better sign up/i)) && !q.dialogOpen(), 120, NARNODE);
        await ms(160);
    }
    const str0 = q.xp('Strength');
    await treeTo(1);
    await talkChoose('daero training', /^daero$/i, pick(/strength and stamina/i), () => q.xp('Strength') > str0, 80, DAERO);
    offDone();
    q.milestone('training');
    offWalk();
    await q.end(q.xp('Strength') > str0, `qp=3 questMsg=${questDone} fightTicks=${fightTicks} casts=${casts} potions=${potions} prayerLeft=${points()}`);
} catch (e) {
    await q.fail(`error ${String(e).slice(0, 200)}`);
}
