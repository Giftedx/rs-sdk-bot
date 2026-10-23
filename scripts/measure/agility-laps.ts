// Agility laps as fast as the engine allows, on the LOCAL practice server.
// Usage: bun scripts/measure/agility-laps.ts <bot> <course: gnome|barbarian|wilderness> [laps=10] [cap=600]
// Presets: agility_<course>_<level> in packages/practice/src/presets.ts.
//
// Code facts (rev 289, CODE-READ):
// - OpLocHandler drops a loc click while the player is delayed (OpLocHandler.ts:14-18), so the earliest useful
//   click is on the first tick after the obstacle script ends. The bot sends the next click on the tick it sees the
//   obstacle XP (the script grants XP at its end), and re-sends it after 2 still ticks with no progress.
// - Fail chance: stat_random(agility, low, high) succeeds when floor(low*(99-L)/98)+floor(high*(L-1)/98)+1 > rand(256)
//   (PlayerOps.ts:591-600).
// - XP is in tenths (stat_advance), x25 on this server (WorldConfig.ts:102).
// Prints LAP lines and one RESULT line: laps, ticks, ticksPerLap, xpPerTick, fails, hpLost, eats.
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

const s = await openBot(bot!).catch(e => finish([], false, `login: ${String(e)}`));
try {
    await waitTicks(s, 3);
    const st = () => s.sdk.getState()!;
    const me = () => st().player!;
    const xp = () => s.sdk.getSkillXp('Agility') ?? 0;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const maxHp = s.sdk.getSkill('Hitpoints')?.baseLevel ?? 10;
    const lvl0 = s.sdk.getSkill('Agility')?.baseLevel ?? 1;
    console.log(`START ${courseArg} agility=${lvl0} hp=${hp()}/${maxHp} at=${me().worldX},${me().worldZ},${me().level}`);
    const seen = new Set<string>();
    let failMsgs = 0;
    s.onTick(() => {
        for (const m of (st().gameMessages ?? []) as any[]) {
            const k = `${m.observationId ?? ''}:${m.tick}:${m.text}`;
            if (seen.has(k)) continue;
            seen.add(k);
            if (FAIL_MSG.test(m.text) && !/carefully|safely|skilfully|skillfully/i.test(m.text)) failMsgs++;
            if (process.env.AGI_DEBUG === '1') console.log(`NOTE t=${s.tick()} msg: ${m.text}`);
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
        return { ...c, op };
    };
    let clicks = 0, closes = 0;
    const click = async (step: { id: number; x: number; z: number; alt?: any[] }) => {
        if (st().dialog?.isOpen) { await s.direct({ type: "closeModal", reason: "SDK" } as any); closes++; }
        const t = target(step);
        clicks++;
        if (process.env.AGI_DEBUG === "1") console.log(`NOTE click ${t.id}@${t.x},${t.z} t=${s.tick() - t0}`);
        await s.direct({ type: 'interactLoc', x: t.x, z: t.z, locId: t.id, optionIndex: t.op, reason: 'SDK' } as any);
    };

    const xpStart = xp();
    const t0 = s.tick();
    let i = 0, laps = 0, fails = 0, hpLost = 0, eats = 0, pitClimbs = 0, lastLapTick = t0, lastHp = hp();
    const lapTicks: number[] = [];
    let stepXp = xp(), lastPos = '', still = 0, inPit = false;
    await click(C.steps[0]!);
    while (laps < LAPS && s.tick() - t0 < CAP) {
        await waitTicks(s, 1);
        const p = me();
        const pos = `${p.worldX},${p.worldZ},${p.level}`;
        still = pos === lastPos ? still + 1 : 0;
        lastPos = pos;
        const h = hp();
        if (h < lastHp) { hpLost += lastHp - h; fails++; }
        lastHp = h;
        const gained = xp() - stepXp;
        if (gained > 0) {
            // A lap bonus arrives in the same tick as the last obstacle's XP.
            if (C.bonus > 0 ? gained >= (C.bonus * 25) / 10 * 0.9 : i === C.steps.length - 1) {
                laps++;
                lapTicks.push(s.tick() - lastLapTick);
                console.log(`CYCLE lap=${laps} ticks=${s.tick() - lastLapTick} xp=${xp() - xpStart} t=${s.tick() - t0}`);
                lastLapTick = s.tick();
            }
            if (process.env.AGI_DEBUG === "1") console.log(`NOTE step ${C.steps[i]!.name} done t=${s.tick() - t0} pos=${pos}`);
            stepXp = xp();
            i = (i + 1) % C.steps.length;
            if (h < maxHp * 0.5) await eat();
            await click(C.steps[i]!);
            still = 0;
            continue;
        }
        // 0-XP steps (barbarian ladder, wilderness rocks without a full lap): done when the plane or z changes past the loc.
        const step = C.steps[i]!;
        if (step.xp === 0 && still >= 1) {
            const done = step.name === 'ladder' ? p.level === 0 && p.worldX <= 2533 : p.worldZ < step.z - 1 && p.worldZ < 9000;
            if (done) { i = (i + 1) % C.steps.length; stepXp = xp(); await click(C.steps[i]!); continue; }
        }
        if (C.pit && p.worldZ > C.pit.minZ) { inPit = true; if (still >= 1) { pitClimbs++; await click(C.pit.ladder); still = -2; } continue; }
        if (still >= 1 && C.resume) {
            const r = C.resume(p, i, inPit);
            inPit = false;
            if (r !== null && r !== i) { if (process.env.AGI_DEBUG === '1') console.log(`NOTE resume ${C.steps[i]!.name} -> ${C.steps[r]!.name} at ${pos}`); i = r; stepXp = xp(); await click(C.steps[i]!); still = -1; continue; }
        }
        if (still >= 2) {
            if (h < maxHp * 0.5) await eat();
            await click(step);
            still = -1;
        }
    }
    async function eat() {
        const f = (s.sdk.getInventory() ?? []).find((x: any) => FOOD.test(x.name)) as any;
        if (!f) return;
        eats++;
        await s.direct({ type: 'useInventoryItem', slot: f.slot, optionIndex: 1, reason: 'SDK' } as any).catch(() => undefined);
    }
    const ticks = lastLapTick - t0;
    const gained = xp() - xpStart;
    const lapXp = laps ? Math.round((xp() - xpStart) / Math.max(1, laps)) : 0;
    const sorted = [...lapTicks].sort((a, b) => a - b);
    await finish([s], laps > 0, `${courseArg} agility=${lvl0}->${s.sdk.getSkill('Agility')?.baseLevel} laps=${laps} ticks=${ticks} ticksPerLap=${(ticks / Math.max(1, laps)).toFixed(1)} bestLap=${sorted[0] ?? 0} medianLap=${sorted[Math.floor(sorted.length / 2)] ?? 0} xp=${gained} xpPerLap=${lapXp} xpPerTick=${(gained / Math.max(1, s.tick() - t0)).toFixed(1)} lapXpPerTick=${(laps ? ((xp() - xpStart) / ticks) : 0).toFixed(1)} fails=${fails} failMsgs=${failMsgs} hpLost=${hpLost} eats=${eats} pit=${pitClimbs} clicks=${clicks} closes=${closes} hpEnd=${hp()}/${maxHp}`);
} catch (e) { await finish([s], false, String(e)); }
