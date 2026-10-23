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

const q = await openQuest({ cap: Number(process.env.MM_CAP ?? 9000), eatAt: 15, food: [ITEM.food] });
try {
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
        await ms(70);
    }

    offWalk();
    await q.end(true, `stage=${STOP < 999 ? STOP : 'end'}`);
} catch (e) {
    await q.fail(`error ${String(e).slice(0, 200)}`);
}
