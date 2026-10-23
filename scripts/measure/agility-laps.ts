// Agility laps as fast as the engine allows, on the LOCAL practice server.
// Usage: bun scripts/measure/agility-laps.ts <bot> <course: gnome|barbarian|wilderness> [laps=10] [cap=600]
// Presets: agility_<course>_<level> in packages/practice/src/presets.ts.
// Env: AGI_V1=1 runs the first version (research/agility.md matrices). AGI_POTION=1 drinks an agility potion at the
// Wilderness ridge gate when the level is below 52. AGI_DEBUG=1 prints clicks and messages, AGI_TRACE=1 one line per tick.
//
// Code facts (rev 289, CODE-READ):
// - OpLocHandler drops a loc click while the player is delayed (OpLocHandler.ts:14-18), and the server reads client
//   packets before it ends a delay (World.ts:402,425,776). So the earliest useful click is on the first tick after the
//   obstacle script ends. V1 sends the next click on the tick it sees the obstacle XP; on 4 of the 5 Wilderness obstacles
//   that click is 1 tick late. V2 (Wilderness) sends the next obstacle's click on every tick after the current obstacle
//   script has started, so the first tick that accepts a click gets one.
// - Fail chance: stat_random(agility, low, high) succeeds when floor(low*(99-L)/98)+floor(high*(L-1)/98)+1 > rand(256)
//   (PlayerOps.ts:591-600). The roll uses the current (boosted) level.
// - XP is in tenths (stat_advance), x25 on this server (WorldConfig.ts:102).
// Prints CYCLE and NOTE LAP lines (ticks and falls per lap) and one RESULT line: laps, ticks, xpPerTick, fails,
// fallTicks, pitTicks, bonusLost and XP/ticks per level band (b<low>_<high>=<xp>/<ticks>).
import { openBot, finish } from '../../packages/core/src/bot';
import { waitTicks } from '../../packages/core/src/ticks';

type Step = { name: string; id: number; x: number; z: number; xp: number; alt?: { id: number; x: number; z: number }[] };
// Loc ids: vendor/rs-sdk/server/content/pack/loc.pack. Positions: maps/m<mx>_<mz>.jm2 LOC sections.
type Pos = { worldX: number; worldZ: number; level: number };
// resume: after a fail, the step to retry from (null = retry the same step). afterPit is true on the first still tick out of the pit.
const COURSES: Record<string, { steps: Step[]; bonus: number; pit?: { minZ: number; ladder: { id: number; x: number; z: number } }; resume?: (p: Pos, i: number, afterPit: boolean) => number | null }> = {
    // gnome_course.rs2: no fail rolls. Lap bonus 39 XP (390 tenths) after the pipe.
    gnome: {
        bonus: 390,
        steps: [
            { name: 'log', id: 2295, x: 2474, z: 3435, xp: 75 },
            { name: 'net', id: 2285, x: 2473, z: 3425, xp: 75, alt: [{ id: 2285, x: 2471, z: 3425 }, { id: 2285, x: 2475, z: 3425 }] },
            { name: 'branch', id: 2313, x: 2473, z: 3422, xp: 50 },
            { name: 'rope', id: 2312, x: 2478, z: 3420, xp: 75 },
            { name: 'treedown', id: 2314, x: 2486, z: 3419, xp: 50 },
            { name: 'net2', id: 2286, x: 2485, z: 3426, xp: 75, alt: [{ id: 2286, x: 2483, z: 3426 }, { id: 2286, x: 2487, z: 3426 }] },
            { name: 'pipe', id: 154, x: 2484, z: 3431, xp: 75, alt: [{ id: 4058, x: 2487, z: 3431 }] },
        ],
    },
    // barbarian_course.rs2: lap bonus 42 XP at the last wall (2542,3553). Needs Alfred Grimhand's Barcrawl to enter.
    barbarian: {
        bonus: 420,
        // Rope swing fail: pit at (2550,9949), ladder_from_cellar (2547,9951) up to the course (ladders.rs2:87-94).
        // Ledge fail: ground floor under the ledge, so the net comes first again.
        pit: { minZ: 9000, ladder: { id: 1755, x: 2547, z: 9951 } },
        resume: (p, i) => (i === 3 && p.level === 0 ? 2 : null),
        steps: [
            { name: 'ropeswing', id: 2282, x: 2551, z: 3550, xp: 200 },
            { name: 'log', id: 2294, x: 2550, z: 3546, xp: 125 },
            { name: 'net', id: 2284, x: 2538, z: 3545, xp: 75 },
            { name: 'ledge', id: 2302, x: 2535, z: 3547, xp: 200 },
            { name: 'ladder', id: 3205, x: 2532, z: 3545, xp: 0 },
            { name: 'wall1', id: 1948, x: 2536, z: 3553, xp: 125 },
            { name: 'wall2', id: 1948, x: 2539, z: 3553, xp: 125 },
            { name: 'wall3', id: 1948, x: 2542, z: 3553, xp: 125 },
        ],
    },
    // wilderness_course.rs2: lap bonus 498.9 XP after the rocks (the rocks give 0 XP themselves).
    // Rope swing and log fails drop the player into the pit below (z + 6400); ladder_from_cellar at (3005,10363).
    wilderness: {
        bonus: 4989,
        pit: { minZ: 9000, ladder: { id: 1755, x: 3005, z: 10363 } },
        // The pit ladder lands north of the rope swing, beside the stepping stones (z - 6400): go on from the stones. After a
        // rope swing fail the lap bonus is lost (update_wilderness_varp needs the swing), but the course loops on.
        resume: (p, i, afterPit) => (afterPit || (i === 1 && p.worldZ >= 3955) ? 2 : null),
        steps: [
            { name: 'pipe', id: 2288, x: 3004, z: 3938, xp: 125 },
            { name: 'ropeswing', id: 2283, x: 3005, z: 3952, xp: 200 },
            { name: 'stones', id: 2311, x: 3001, z: 3960, xp: 200 },
            { name: 'log', id: 2297, x: 3001, z: 3945, xp: 200 },
            { name: 'rocks', id: 2328, x: 2994, z: 3936, xp: 0, alt: [{ id: 2328, x: 2993, z: 3936 }, { id: 2328, x: 2995, z: 3936 }] },
        ],
    },
    // Brimhaven Agility Arena (game_agilityarena/scripts/agilityarena.rs2:119-179): the two rope swings between the
    // pillars (2761,9568) and (2772,9568) face opposite ways, 20 XP each, no use timer. A "lap" here is one swing each
    // way (bonus 0: a lap is counted when the step list wraps). Pillar tickets are not taken.
    arenaswing: {
        bonus: 0,
        steps: [
            { name: 'swingEast', id: 3566, x: 2766, z: 9569, xp: 200 },
            { name: 'swingWest', id: 3566, x: 2767, z: 9567, xp: 200 },
        ],
    },
};

const [bot, courseArg, lapsArg, capArg] = process.argv.slice(2);
const C = COURSES[courseArg ?? ''];
if (!C) { console.log(`usage: agility-laps.ts <bot> <${Object.keys(COURSES).join('|')}> [laps] [cap]`); process.exit(2); }
const LAPS = Number(lapsArg ?? 10), CAP = Number(capArg ?? 600);
const FOOD = /^(lobster|swordfish|shark|trout|salmon)$/i;
const FAIL_MSG = /slip|lose your footing|lost your balance|fall|bites you|stumble/i;

// AGI_V1=1 restores the first script (re-send after 2 still ticks, the full loop after a rope swing fall).
const V1 = process.env.AGI_V1 === '1';
const DEBUG = process.env.AGI_DEBUG === '1', TRACE = process.env.AGI_TRACE === '1';
// Level bands for the XP-per-tick split (current level when each obstacle starts).
const BANDS = [[1, 48], [49, 51], [52, 59], [60, 75], [76, 87], [88, 99]] as const;
const bandOf = (l: number) => BANDS.findIndex(([a, b]) => l >= a && l <= b);
// Wilderness: the tiles that show an obstacle script has started (wilderness_course.rs2). Pipe: first exactmove to z 3940 (:68).
// Rope swing: teleport to the start tile (3005,3953) (:87). Stones: first jump west of 3002 (:109). Log: teleport to (3002,3945)
// (:130). Rocks: forcemove onto the loc tile, z 3936 and south (:155-156).
type P2 = { worldX: number; worldZ: number };
const STARTED: Record<string, (p: P2) => boolean> = {
    pipe: p => p.worldX === 3004 && p.worldZ >= 3940 && p.worldZ <= 3950,
    ropeswing: p => p.worldX === 3005 && p.worldZ >= 3953 && p.worldZ <= 3958,
    stones: p => p.worldZ === 3960 && p.worldX >= 2996 && p.worldX <= 3001,
    log: p => p.worldZ === 3945 && p.worldX >= 2994 && p.worldX <= 3002,
    rocks: p => p.worldX >= 2993 && p.worldX <= 2995 && p.worldZ >= 3933 && p.worldZ <= 3936,
};

const s = await openBot(bot!).catch(e => finish([], false, `login: ${String(e)}`));
try {
    await waitTicks(s, 3);
    const st = () => s.sdk.getState()!;
    const me = () => st().player!;
    const xp = () => s.sdk.getSkillXp('Agility') ?? 0;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const agi = () => s.sdk.getSkill('Agility')?.level ?? 1;
    const maxHp = s.sdk.getSkill('Hitpoints')?.baseLevel ?? 10;
    const lvl0 = s.sdk.getSkill('Agility')?.baseLevel ?? 1;
    console.log(`START ${courseArg} agility=${lvl0} hp=${hp()}/${maxHp} at=${me().worldX},${me().worldZ},${me().level} mode=${V1 ? 'v1' : 'v2'} energy=${me().runEnergy}`);
    const seen = new Set<string>();
    let failMsgs = 0, failSeen = 0, cantReach = 0;
    s.onTick(() => {
        for (const m of (st().gameMessages ?? []) as any[]) {
            const k = `${m.observationId ?? ''}:${m.tick}:${m.text}`;
            if (seen.has(k)) continue;
            seen.add(k);
            if (FAIL_MSG.test(m.text) && !/carefully|safely|skilfully|skillfully/i.test(m.text)) { failMsgs++; failSeen++; }
            if (/can't reach|cannot do that from here/i.test(m.text)) cantReach++;
            if (DEBUG) console.log(`NOTE t=${s.tick()} msg: ${m.text}`);
        }
    });

    // Pick the loc instance nearest the player; option index from the scan when visible, else op 1.
    const target = (step: { id: number; x: number; z: number; alt?: { id: number; x: number; z: number }[] }) => {
        const cands = [step, ...(step.alt ?? [])];
        const p = me();
        cands.sort((a, b) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ)) - Math.max(Math.abs(b.x - p.worldX), Math.abs(b.z - p.worldZ)));
        const c = cands[0]!;
        const seenLoc = (st().nearbyLocs ?? []).find((l: any) => l.id === c.id && l.x === c.x && l.z === c.z) as any;
        const op = seenLoc?.optionsWithIndex?.[0]?.opIndex ?? 1;
        return { ...c, op, reachable: seenLoc?.reachable as boolean | undefined };
    };
    let clicks = 0, closes = 0, eats = 0, preClicks = 0, sentTick = -1;
    let t0 = s.tick();
    const click = async (step: { id: number; x: number; z: number; alt?: any[] }) => {
        // A chat modal (the level-up box, levelup.rs2:54-55) makes the player busy, and busy blocks the loc trigger (Player.ts:878-880, 1314).
        if (st().dialog?.isOpen) { await s.direct({ type: 'closeModal', reason: 'SDK' } as any); closes++; }
        const t = target(step);
        clicks++;
        sentTick = s.tick();
        if (DEBUG) console.log(`NOTE click ${t.id}@${t.x},${t.z} t=${s.tick() - t0} reach=${t.reachable}`);
        await s.direct({ type: 'interactLoc', x: t.x, z: t.z, locId: t.id, optionIndex: t.op, reason: 'SDK' } as any);
    };
    async function eat() {
        const f = (s.sdk.getInventory() ?? []).find((x: any) => FOOD.test(x.name)) as any;
        if (!f) return;
        eats++;
        await s.direct({ type: 'useInventoryItem', slot: f.slot, optionIndex: 1, reason: 'SDK' } as any).catch(() => undefined);
    }

    // Ridge gate (wilderness_course.rs2:1-20) when the preset starts south of it. The gate checks stat(agility) >= 52, the
    // current level. AGI_POTION=1 drinks one agility potion dose (+3, consume_effects.dbrow:288-294) first when below 52.
    let potionDoses = 0, gateTicks = 0;
    if (courseArg === 'wilderness' && me().worldZ < 3917) {
        const g0 = s.tick();
        for (let tries = 0; me().worldZ < 3930 && s.tick() - g0 < 150; tries++) {
            if (agi() < 52 && process.env.AGI_POTION === '1') {
                const pot = (s.sdk.getInventory() ?? []).find((x: any) => /agility potion/i.test(x.name)) as any;
                if (pot) {
                    const before = agi();
                    await s.direct({ type: 'useInventoryItem', slot: pot.slot, optionIndex: 1, reason: 'SDK' } as any);
                    potionDoses++;
                    await waitTicks(s, 2);
                    console.log(`NOTE potion ${pot.name} agility ${before}->${agi()} base=${s.sdk.getSkill('Agility')?.baseLevel} t=${s.tick() - g0}`);
                }
            }
            await s.direct({ type: 'interactLoc', x: 2998, z: 3917, locId: 2309, optionIndex: 1, reason: 'SDK' } as any);
            // Re-click after 3 still ticks: a click on the tick after the drink can be lost.
            let ok = false, stillG = 0, lp = `${me().worldX},${me().worldZ}`;
            for (let k = 0; k < 25 && !ok && stillG < 3; k++) {
                await waitTicks(s, 1); ok = me().worldZ >= 3930;
                const q = `${me().worldX},${me().worldZ}`; stillG = q === lp ? stillG + 1 : 0; lp = q;
            }
            console.log(`NOTE gate try=${tries} at=${me().worldX},${me().worldZ} agility=${agi()} ok=${ok} t=${s.tick() - g0}`);
            if (!ok && st().dialog?.isOpen) await s.direct({ type: 'closeModal', reason: 'SDK' } as any);
        }
        gateTicks = s.tick() - g0;
        console.log(`NOTE GATE inside=${me().worldZ >= 3930} ticks=${gateTicks} agility=${agi()} base=${s.sdk.getSkill('Agility')?.baseLevel} doses=${potionDoses}`);
        if (me().worldZ < 3930) await finish([s], false, `gate closed agility=${agi()}`);
        // The ridge XP (stat_advance 150, wilderness_course.rs2:17) lands after the end tile: let it land before the lap count starts.
        await waitTicks(s, 3);
    }

    const xpStart = xp();
    t0 = s.tick();
    let i = 0, laps = 0, fails = 0, hpLost = 0, pitClimbs = 0, lastLapTick = t0, lastHp = hp();
    const lapTicks: number[] = [];
    let stepXp = xp(), lastPos = '', still = 0, inPit = false, energyMin = me().runEnergy;
    // Per lap: falls as "<obstacle>:<recover ticks>[/pit<ticks in pit>]". Recover = ticks from the HP drop to the next XP gain.
    let lapFalls: string[] = [], lapStartLvl = agi();
    let pendingFall: { name: string; t: number; pit: boolean; pitOut?: number } | null = null;
    let fallTicks = 0, pitTicks = 0, bonusLost = 0, preBlock = -1;
    // %wilderness_course_progress as the server keeps it (update_wilderness_varp, wilderness_course.rs2:170-178): an obstacle
    // sets it to its number only when the one before it is done; a fall leaves it as it is; 5 gives the lap bonus and resets it.
    const ORDER: Record<string, number> = { pipe: 1, ropeswing: 2, stones: 3, log: 4, rocks: 5 };
    const nextProg = (pr: number, name: string) => { const n = ORDER[name] ?? 0; const v = pr + 1 >= n ? n : pr; return v === 5 ? 0 : v; };
    let prog = 0, northWalks = 0;
    // V2: out of the pit, walk to the log instead of doing the stepping stones again. The ladder exit (3005,3962) and the stones'
    // west end (2996,3960) join by land north of the lava (the client routes z 3962-3966), and the stones add no progress after a
    // fall: progress is 1 (rope swing fall) or 3 (log fall), and stones only set 3 when progress >= 2 (wilderness_course.rs2:170-173).
    // AGI_STONES=1 keeps the stones.
    const LOG = C.steps.findIndex(x => x.name === 'log');
    const bandXp = BANDS.map(() => 0), bandTicks = BANDS.map(() => 0);
    let lastXpTick = t0, lastXpLvl = agi();
    const isPit = (p: Pos) => !!C.pit && p.worldZ > C.pit.minZ;
    await click(C.steps[0]!);
    while (laps < LAPS && s.tick() - t0 < CAP) {
        await waitTicks(s, 1);
        const p = me();
        const pos = `${p.worldX},${p.worldZ},${p.level}`;
        const moved = pos !== lastPos;
        still = moved ? 0 : still + 1;
        lastPos = pos;
        energyMin = Math.min(energyMin, p.runEnergy);
        const h = hp();
        if (h < lastHp) hpLost += lastHp - h;
        // A fall is a fail message (NPCs in the Wilderness also hit the player, so an HP drop alone is not a fall).
        // V1 counted every HP drop as a fall.
        if (V1 ? h < lastHp : failSeen > 0) {
            failSeen = 0; fails++;
            // A second fall before any XP: close the first one at this tick.
            if (pendingFall) { const r = s.tick() - pendingFall.t; fallTicks += r; lapFalls.push(`${pendingFall.name}:${r}${pendingFall.pit ? `/pit${pendingFall.pitOut ?? '?'}` : ''}`); }
            pendingFall = { name: C.steps[i]!.name, t: s.tick(), pit: false };
            preBlock = s.tick();
            if (C.steps[i]!.name === 'ropeswing') bonusLost++;
            if (DEBUG) console.log(`NOTE fall ${C.steps[i]!.name} t=${s.tick() - t0} at ${pos}`);
        }
        lastHp = h;
        if (TRACE) console.log(`NOTE tr t=${s.tick() - t0} ${pos} anim=${p.animId} step=${C.steps[i]!.name} still=${still} e=${p.runEnergy} hp=${h}`);
        const gained = xp() - stepXp;
        if (gained > 0) {
            const b = bandOf(lastXpLvl);
            if (b >= 0) { bandXp[b] += gained; bandTicks[b] += s.tick() - lastXpTick; }
            lastXpTick = s.tick(); lastXpLvl = agi();
            if (pendingFall) {
                const r = s.tick() - pendingFall.t;
                fallTicks += r;
                lapFalls.push(`${pendingFall.name}:${r}${pendingFall.pit ? `/pit${pendingFall.pitOut ?? '?'}` : ''}`);
                pendingFall = null;
            }
            // A lap bonus arrives in the same tick as the last obstacle's XP.
            if (C.bonus > 0 ? gained >= (C.bonus * 25) / 10 * 0.9 : i === C.steps.length - 1) {
                laps++;
                lapTicks.push(s.tick() - lastLapTick);
                console.log(`CYCLE lap=${laps} ticks=${s.tick() - lastLapTick} xp=${xp() - xpStart} t=${s.tick() - t0}`);
                console.log(`NOTE LAP lap=${laps} lvl=${lapStartLvl} ticks=${s.tick() - lastLapTick} falls=${lapFalls.join(',') || '-'} energy=${p.runEnergy} hp=${h}`);
                lastLapTick = s.tick(); lapFalls = []; lapStartLvl = agi();
            }
            if (DEBUG) console.log(`NOTE step ${C.steps[i]!.name} done t=${s.tick() - t0} pos=${pos}`);
            stepXp = xp();
            prog = nextProg(prog, C.steps[i]!.name);
            i = (i + 1) % C.steps.length;
            if (h < maxHp * 0.5) await eat();
            await click(C.steps[i]!);
            still = 0;
            continue;
        }
        // 0-XP steps (barbarian ladder, wilderness rocks without a full lap): done when the plane or z changes past the loc.
        const step = C.steps[i]!;
        if (!V1 && courseArg === 'wilderness' && step.name === 'rocks') {
            // V2: the rocks end on z 3933 (wilderness_course.rs2:155-156). With the lap bonus due (progress 4), the XP marks the end:
            // it shows 1 tick after the end tile. With no bonus due there is no XP, and a landed pre-click moves the player east
            // before a still tick, so the end tile or a step east of the rocks marks the end.
            const atEnd = p.worldZ <= 3933 && p.worldZ < 9000 && (still >= 1 || p.worldX >= 2996);
            if (atEnd && (prog !== 4 || still >= 3)) {
                if (prog === 4) console.log(`WARN rocks end with no lap bonus seen t=${s.tick() - t0}`);
                prog = nextProg(prog, 'rocks');
                i = (i + 1) % C.steps.length; stepXp = xp(); await click(C.steps[i]!); continue;
            }
        } else if (step.xp === 0 && still >= 1) {
            const done = step.name === 'ladder' ? p.level === 0 && p.worldX <= 2533 : p.worldZ < step.z - 1 && p.worldZ < 9000;
            if (done) { i = (i + 1) % C.steps.length; stepXp = xp(); await click(C.steps[i]!); continue; }
        }
        if (isPit(p)) {
            if (!inPit) { inPit = true; if (pendingFall) pendingFall.pit = true; }
            // V2: click the ladder on the landing tick too (agility_instant_fail has no delay, agility.rs2:142-145).
            if (still >= 1 || (!V1 && moved)) { pitClimbs++; await click(C.pit!.ladder); if (V1) still = -2; }
            continue;
        }
        if (inPit && pendingFall && pendingFall.pitOut === undefined) { pendingFall.pitOut = s.tick() - pendingFall.t; pitTicks += pendingFall.pitOut; }
        // The pre-click block ends on the first move out of the pit after the fail script has ended (the tick after the fall).
        if (preBlock >= 0 && moved && s.tick() > preBlock + 1) preBlock = -1;
        // V2: the ladder script ends on its telejump (ladders.rs2:154-161), so click the resume step on the exit tick.
        if ((still >= 1 || (!V1 && inPit && moved)) && C.resume) {
            let r = C.resume(p, i, inPit);
            if (!V1 && inPit && courseArg === 'wilderness' && process.env.AGI_STONES !== '1' && r !== null && C.steps[r]!.name === 'stones') { r = LOG; northWalks++; }
            inPit = false;
            if (r !== null && r !== i) {
                if (DEBUG) console.log(`NOTE resume ${C.steps[i]!.name} -> ${C.steps[r]!.name} at ${pos} logReach=${target(C.steps[3] ?? C.steps[0]!).reachable}`);
                i = r; stepXp = xp(); await click(C.steps[i]!); still = V1 ? -1 : 0; continue;
            }
        }
        if (cantReach > 0) { cantReach = 0; console.log(`WARN cant reach ${step.name} at ${pos} prog=${prog}`); }
        // V2 wilderness pre-click: once the obstacle script has visibly started, send the NEXT obstacle's click every tick.
        // OpLocHandler drops a click while the player is delayed (OpLocHandler.ts:14-18), and every obstacle script runs under
        // p_delay to its end, so the first click that lands is on the first tick after the script ends. A fall (HP drop or
        // pit) stops the pre-clicks: the fail scripts also end under p_delay (agility.rs2:103-121), so no pre-click lands after one.
        if (!V1 && courseArg === 'wilderness' && preBlock < 0 && STARTED[step.name]?.(p)) {
            if (sentTick !== s.tick()) {
                preClicks++;
                await click(C.steps[(i + 1) % C.steps.length]!);
            }
            continue;
        }
        if (still >= (V1 ? 2 : 1)) {
            if (h < maxHp * 0.5) await eat();
            await click(step);
            still = V1 ? -1 : 0;
        }
    }
    const ticks = lastLapTick - t0;
    const gained = xp() - xpStart;
    const lapXp = laps ? Math.round((xp() - xpStart) / Math.max(1, laps)) : 0;
    const sorted = [...lapTicks].sort((a, b) => a - b);
    const bands = BANDS.map(([a, b], k) => (bandTicks[k] ? `b${a}_${b}=${bandXp[k]}/${bandTicks[k]}` : '')).filter(Boolean).join(' ');
    await finish([s], laps > 0, `${courseArg} agility=${lvl0}->${s.sdk.getSkill('Agility')?.baseLevel} laps=${laps} ticks=${ticks} ticksPerLap=${(ticks / Math.max(1, laps)).toFixed(1)} bestLap=${sorted[0] ?? 0} medianLap=${sorted[Math.floor(sorted.length / 2)] ?? 0} xp=${gained} xpPerLap=${lapXp} xpPerTick=${(gained / Math.max(1, s.tick() - t0)).toFixed(1)} lapXpPerTick=${(laps ? ((xp() - xpStart) / ticks) : 0).toFixed(1)} fails=${fails} failMsgs=${failMsgs} hpLost=${hpLost} eats=${eats} pit=${pitClimbs} clicks=${clicks} pre=${preClicks} closes=${closes} hpEnd=${hp()}/${maxHp} mode=${V1 ? 'v1' : 'v2'} fallTicks=${fallTicks} pitTicks=${pitTicks} bonusLost=${bonusLost} north=${northWalks} energyMin=${energyMin} gate=${gateTicks} doses=${potionDoses} ${bands}`);
} catch (e) { await finish([s], false, String(e)); }
