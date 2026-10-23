// Witch's House from preset quest_ball or quest_ball_partner (beside the boy south of the witch's garden, Taverley;
// leather gloves worn, cheese). Reward: 4 QP, 158,125 Hitpoints XP (quest_ball.rs2:198-204).
// Varp %ballquest (226): 0 -> 1 the boy; 2 the magnet; 3 the magnet on the mouse; 6 the experiment's 4th form dead;
// 7 the ball to the boy (queued completion).
// Server truth: quests/quest_ball/scripts/*.rs2, areas/area_taverly/scripts/boy.rs2, maps/m45_54.jm2, m45_154.jm2.
// The witch (Nora T. Hagg) patrols z 3463 from x 2930 to 2904 and catches a player within 3 tiles in line of sight
// who is north or south of her and not behind a hedge (witch.rs2:1-34). A catch takes the shed key and the ball, sets
// 3 back to 1 and puts the player outside at 2929,3456. A player on her own row (dz 0) is never caught.
import { openQuest } from './quest-lib';

const BOY = { x: 2928, z: 3456 };
const POT = { id: 2867, x: 2900, z: 3474 };               // witchpot: the door key (quest_ball.rs2:1-8)
const FRONT = { id: 2861, x: 2901, z: 3473 };             // witchhousedoor, west wall
const LADDER_DOWN = { id: 1754, x: 2907, z: 3476 };
const LADDER_UP = { id: 1755, x: 2907, z: 9876 };
const GATE = { x: 2902, z: 9873 };                        // shockgatel/r 2865/2866 at 2902,9873-9874, east wall
const CUPBOARD = { x: 2898, z: 9873 };                    // magnetcbshut 2868 -> magnetcbopen 2869
const HOLE = { id: 2870, x: 2903, z: 3466 };              // witchmousehole
const BACK = { id: 2862, x: 2901, z: 3465 };              // witchbackdoor, north wall of 2901,3465
const FOUNTAIN = { id: 2864, x: 2909, z: 3470 };          // op2 Check: the shed key
const SHED = { id: 2863, x: 2934, z: 3463 };              // witchsheddoor, west wall
// The garden (SDK and client collision; the soil and grass patches in the hedge rows z 3461 and 3465 block walking):
// the witch's pen is z 3462-3464, x 2904-2930, shut. A player walks the corridors round it: x 2901 (z 3460-3465),
// z 3460 (x 2901-2933), x 2933 (z 3460-3466), z 3466 (x 2912-2933). Hedge tiles from maps/m45_54.jm2.
const WITCH_X0 = 2904, WITCH_X1 = 2930;
const COVER_S = new Set([2903, 2907, 2908, 2909, 2915, 2916, 2917, 2923, 2924, 2925, 2929, 2930, 2931].map(x => `${x},3461`));
const COVER_N = new Set([2902, 2903, 2904, 2905, 2906, 2907, 2908, 2909, 2911, 2912, 2913, 2914, 2919, 2920, 2921, 2926, 2927, 2928, 2932].map(x => `${x},3465`));
const ITEM = { key: 2409, magnet: 2410, shedKey: 2411, ball: 2407, cheese: 1985, food: 379 };
const PFM = 14;
type Tile = [number, number];
const ROW = 3463;                                          // the witch's patrol row (witches_house.npc patrol1-6)

const q = await openQuest({ cap: 1500, eatAt: 6, food: [ITEM.food] });
try {
    // The partner (Defence 1, 10 HP) fights under Protect from Melee; the main (Defence 99) does not need it.
    const PARTNER = (q.s.sdk.getSkill('Defence')?.level ?? 1) < 40;
    let questDone = false;
    let caught = 0;
    const off = q.s.onTick(() => {
        if (q.msgCount(/quest complete/i) > 0) questDone = true;
    });
    const boy = /^boy$/i;
    const witch = () => q.npc(/^nora t\. hagg$/i);
    const shut = () => q.converse([], () => !q.dialogOpen(), 10);
    const z = () => q.pos()?.worldZ ?? 0;
    const x = () => q.pos()?.worldX ?? 0;
    const wantPfm = PARTNER;
    const pfmOn = (): boolean => !!q.st()?.prayers?.activePrayers?.[PFM];
    const setPfm = async (on: boolean) => {
        if (pfmOn() === on) return;
        await q.step(`pfm ${on}`, () => q.s.direct({ type: 'togglePrayer', prayerIndex: PFM, reason: 'SDK' }), () => pfmOn() === on, 3, 3);
    };
    // A catch puts the player at 2929,3456 (witch.rs2:29); the boy's side of the hedge is never reached otherwise
    // after step 1.
    let inGarden = false;
    const offCatch = q.s.onTick(() => {
        if (inGarden && q.near(2929, 3456, 1) && q.lvl() === 0) { caught++; inGarden = false; console.log(`WARN caught at ${q.T()}`); }
    });
    // Exposure (witch.rs2:4-8): within 3 tiles of the witch, not on her row, and no cover: a hedge on the tile toward
    // her row (a hedge or hedge corner for a player north of her, a hedge only for a player south of her). Line of
    // sight is not modelled (conservative).
    const exposed = (t: Tile, wx: number): boolean => {
        const [tx, tz] = t;
        if (Math.max(Math.abs(tx - wx), Math.abs(tz - ROW)) > 3 || tz === ROW) return false;
        return !(tz > ROW ? COVER_N.has(`${tx},${tz - 1}`) : COVER_S.has(`${tx},${tz + 1}`));
    };
    const hidden = (t: Tile): boolean => { for (let ax = WITCH_X0; ax <= WITCH_X1; ax++) if (exposed(t, ax)) return false; return true; };
    // Walks `path` (tile by tile, the bot already on path[0]) in hops between hidden tiles. A hop goes only when no tile
    // of it is exposed to any witch position she can reach by then (she walks 1 tile a tick, the bot runs 2). The bot
    // waits on a hidden tile. The client routes each hop along the 1-tile corridor.
    let waited = 0;
    let wLast: number | undefined, wSeen = 0;
    const offWitch = q.s.onTick(() => { const w = witch(); if (w) { wLast = w.x; wSeen = q.T(); } });
    const sneak = async (label: string, path: Tile[]): Promise<void> => {
        let at = 0;
        for (let k = 0; k < 400 && at < path.length - 1; k++) {
            await q.guard(label);
            // The npc list covers about 15 tiles: out of sight, the witch is somewhere her walk since the last sighting
            // allows (anywhere on the patrol before the first sighting).
            const w = witch();
            const drift = wLast === undefined ? 99 : q.T() - wSeen;
            const lo = wLast === undefined ? WITCH_X0 : wLast - drift, hi = wLast === undefined ? WITCH_X1 : wLast + drift;
            let go = -1;
            for (let j = at + 1; j < path.length; j++) {
                const reach = Math.ceil((j - at) / 2) + 1;
                const t = path[j]!;
                const ok = (() => { for (let ax = Math.max(WITCH_X0, lo - reach); ax <= Math.min(WITCH_X1, hi + reach); ax++) if (exposed(t, ax)) return false; return true; })();
                if (!ok) break;
                if (hidden(t) || j === path.length - 1) go = j;
            }
            if (go < 0) { waited++; await q.waitTicks(1); continue; }
            const [gx, gz] = path[go]!;
            if (process.env.Q_TRACE === '1') console.log(`TRACE hop ${label} -> ${gx},${gz} witch ${w?.x ?? '?'} (${lo}-${hi})`);
            await q.dash(`${label} ${gx},${gz}`, gx, gz, 0, 20);
            at = go;
        }
        if (at < path.length - 1) await q.fail(`sneak ${label}`);
    };
    const line = (x0: number, z0: number, x1: number, z1: number): Tile[] => {
        const out: Tile[] = [];
        const n = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
        for (let i = 0; i <= n; i++) out.push([x0 + Math.sign(x1 - x0) * i, z0 + Math.sign(z1 - z0) * i]);
        return out;
    };
    const join = (...ls: Tile[][]): Tile[] => ls.reduce((acc, l) => acc.concat(acc.length ? l.slice(1) : l), [] as Tile[]);

    // 1. The boy: "What's the matter?", "Ok, I'll see what I can do." sets 1 (boy.rs2:3-15).
    await q.talk('boy 1', boy, [/what's the matter/i, /ok, i'll see what i can do/i], () => q.sawText(/thanks (mister|lady)/i), BOY);
    q.milestone(1);

    // 2. The key under the pot outside the front door; the door opens with the key in the pack (quest_ball.rs2:10-31).
    await q.walk('to pot', [{ x: 2899, z: 3474, tol: 1 }]);
    await q.step('pot', () => q.opLoc(POT, 1), () => q.has(ITEM.key), 10, 4);
    await shut();
    await q.step('front door', () => q.opLoc(FRONT, 1), () => x() >= 2901 && z() >= 3466, 8, 4);
    q.milestone('key');

    // 3. The basement: the ladder, the gate (gloves worn), the cupboard: Open, then Search gives the magnet (2).
    await q.openDoor('hall door', 2902, 3474);
    await q.climb('ladder down', () => q.locAt(LADDER_DOWN.x, LADDER_DOWN.z), /climb-down/i, () => z() > 9000);
    await q.walk('to gate', [{ x: GATE.x + 1, z: GATE.z, tol: 0 }]);
    const gate = () => q.findLoc(l => l.x === GATE.x && (l.z === GATE.z || l.z === GATE.z + 1) && /gate/i.test(l.name));
    await q.step('gate in', () => { const g = gate(); return g ? q.opLoc(g, q.opIndex(g, /open/i)) : q.waitTicks(1); }, () => x() <= GATE.x, 8, 4);
    const cb = () => q.findLoc(l => l.x === CUPBOARD.x && l.z === CUPBOARD.z);
    await q.step('cupboard open', () => { const c = cb(); return c ? q.opLoc(c, q.opIndex(c, /open/i)) : q.waitTicks(1); }, () => /search/i.test((cb()?.optionsWithIndex ?? []).map((o: any) => o.text).join(' ')), 10, 4);
    await q.step('cupboard search', () => { const c = cb(); return c ? q.opLoc(c, q.opIndex(c, /search/i)) : q.waitTicks(1); }, () => q.has(ITEM.magnet), 10, 4);
    await shut();
    q.milestone(2);
    await q.step('gate out', () => { const g = gate(); return g ? q.opLoc(g, q.opIndex(g, /open/i)) : q.waitTicks(1); }, () => x() > GATE.x, 8, 4);
    await q.climb('ladder up', () => q.locAt(LADDER_UP.x, LADDER_UP.z), /climb-up/i, () => z() < 9000);

    // 4. The cheese on the mouse hole spawns the mouse; the magnet on the mouse unlocks the back door (3).
    await q.openDoor('hall door 2', 2902, 3474);
    await q.openDoor('porch door', 2902, 3468);
    await q.walk('to hole', [{ x: 2902, z: 3467, tol: 0 }]);
    const mouse = () => q.npc(/^mouse$/i);
    await q.step('cheese', () => q.useOnLoc(ITEM.cheese, HOLE), () => !!mouse(), 8, 4);
    await shut();
    await q.step('magnet', () => { const m = mouse(); return m ? q.useOnNpc(ITEM.magnet, m) : q.waitTicks(1); }, () => !q.has(ITEM.magnet), 8, 4);
    await shut();
    q.milestone(3);

    // 5. The back door, the fountain (shed key), the shed door with the key (spawns the experiment), by the garden
    // corridors round the witch's pen.
    inGarden = true;
    await q.step('back door', () => q.opLoc(BACK, 1), () => z() <= 3465, 8, 4);
    await shut();
    await sneak('to fountain', join(line(2901, 3465, 2901, 3460), line(2901, 3460, 2933, 3460), line(2933, 3460, 2933, 3466), line(2933, 3466, 2912, 3466), [[2912, 3467]]));
    await q.step('fountain', () => q.opLoc(FOUNTAIN, 2), () => q.has(ITEM.shedKey), 12, 4);
    await shut();
    q.milestone('shedkey');
    await q.dash('fountain back', 2912, 3467, 0, 20);
    await sneak('to shed', join([[2912, 3467]], line(2912, 3466, 2933, 3466), line(2933, 3466, 2933, 3463)));
    if (wantPfm) await setPfm(true);
    await q.step('shed door', () => q.useOnLoc(ITEM.shedKey, SHED), () => x() >= SHED.x, 8, 4);
    await shut();
    q.milestone('shed');

    // 6. The 4 forms: each death spawns the next, which attacks (witches_experiement.rs2:37-81).
    const attack = (n: any) => q.s.direct({ type: 'interactNpc', npcIndex: n.index, optionIndex: n.optionsWithIndex?.find((o: any) => /attack/i.test(o.text))?.opIndex ?? 2, reason: 'SDK' });
    const exp = () => q.npc(/^witches experiment/i);
    let killed = false;
    for (let t = 0; t < 400 && !killed; t++) {
        await q.guard('experiment');
        if (q.msgCount(/kill the shapeshifter once and for all/i) > 0) { killed = true; break; }
        const n = exp();
        if (n && t % 4 === 0 && q.pos()?.targetIndex !== n.index) await attack(n);
        await q.waitTicks(1);
    }
    if (!killed) await q.fail('experiment not killed');
    q.milestone(6);
    if (wantPfm) await setPfm(false);

    // 7. The ball, out of the shed, back through the house, the boy (7).
    const ballG = () => (q.st()?.groundItems ?? []).find((g: any) => g.id === ITEM.ball);
    await q.step('ball', () => { const g = ballG(); return g ? q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' }) : q.waitTicks(1); }, () => q.has(ITEM.ball), 12, 4);
    q.milestone('ball');
    await q.step('shed out', () => q.opLoc(SHED, 1), () => x() < SHED.x, 8, 4);
    await sneak('from shed', join(line(2933, 3463, 2933, 3460), line(2933, 3460, 2901, 3460), line(2901, 3460, 2901, 3465)));
    await q.step('back door in', () => q.opLoc(BACK, 1), () => z() >= 3466, 8, 4);
    inGarden = false;
    await q.openDoor('porch door 2', 2902, 3468);
    await q.step('front door out', () => q.opLoc(FRONT, 1), () => x() <= 2900, 8, 4);
    await q.talk('boy 2', boy, [], () => questDone, BOY, 40, true);
    await shut();
    q.milestone(7);
    off(); offCatch(); offWitch();
    await q.end(questDone, `qp=4 caught=${caught} witchWait=${waited} pfm=${wantPfm}`);
} catch (e) { await q.fail(String(e)); }
