import type { Session } from '../../../core/src/inprocess';
import type { PathOptions, PathPoint, PathResult } from '../../../core/src/walk';
import { resolveExitRuneTower, resolveOpenQuest, resolveWalkTargetPersist } from './runtime';

export function retainedGhostSkull(
    state: string,
    pack: readonly { id: number; count: number }[],
    worn: readonly { id: number; count: number }[],
) {
    if (state !== 'started') return false;
    let skulls = 0;
    for (let i = 0; i < pack.length; i++) {
        const row = pack[i]!;
        if (row.id === 553) skulls += row.count;
    }
    return skulls === 1 && worn.some((i) => i.id === 552 && i.count === 1);
}

export function retainedGhostBankSkull(
    state: string,
    pack: readonly { id: number; count: number }[],
    worn: readonly { id: number; count: number }[],
    bank: readonly { id: number; count: number }[],
) {
    return (
        state === 'started' &&
        !pack.some((i) => i.id === 553 && i.count > 0) &&
        worn.some((i) => i.id === 552 && i.count === 1) &&
        bank.some((i) => i.id === 553 && i.count > 0)
    );
}

type Position = { worldX: number; worldZ: number; level: number };

export interface GhostBasementExit {
    pos: () => Position | null | undefined;
    openDoor: (label: string, x: number, z: number) => Promise<void>;
    dash: (label: string, x: number, z: number, tol: number) => Promise<void>;
    waitForLadder: () => Promise<boolean>;
    climbLadder: () => Promise<void>;
    waitForLanding: () => Promise<boolean>;
}

type Door = { x: number; z: number };

export interface DoorDash {
    pos: () => Position | null | undefined;
    walk: (x: number, z: number) => Promise<void>;
    arrived: (x: number, z: number, tol: number) => Promise<boolean>;
    closedDoor: (within: number) => Door | undefined;
    open: (door: Door) => Promise<void>;
}

// A try that ends where it started re-opens the nearest closed door within 2 tiles (closed again, loaded late or on the
// next tile) before the next try. A stall with no door to open fails at once instead of idling into the ladder wait.
export async function dashThroughDoor(io: DoorDash, label: string, x: number, z: number, tol: number, tries = 3) {
    const near = () => {
        const p = io.pos();
        return !!p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
    };
    for (let i = 0; i < tries && !near(); i++) {
        const before = io.pos();
        await io.walk(x, z);
        if (await io.arrived(x, z, tol)) return;
        const after = io.pos();
        if (before && after && (before.worldX !== after.worldX || before.worldZ !== after.worldZ || before.level !== after.level)) {
            continue;
        }
        const door = io.closedDoor(2);
        if (!door) {
            throw Error(`ghost exit: ${label} blocked at ${after?.worldX},${after?.worldZ} with no closed door within 2 tiles`);
        }
        await io.open(door);
    }
}

// The Wizards' Tower basement with the skull room (quest_priest.rs2): underground on level 0, x 3100-3125, z 9550-9580.
export const inGhostBasement = (p: Position | null | undefined): boolean =>
    !!p && p.level === 0 && p.worldX >= 3100 && p.worldX <= 3125 && p.worldZ >= 9550 && p.worldZ <= 9580;

// The ghost skull room is underground on level 0. It cannot use a same-floor surface walk.
export async function leaveGhostBasement(io: GhostBasementExit) {
    const p = io.pos();
    if (!p) throw Error('ghost exit: position unknown');
    if (p.level === 0 && p.worldZ < 4000) return;
    if (!inGhostBasement(p)) throw Error('ghost exit: unknown basement');
    await io.openDoor('skull exit door', 3111, 9559);
    await io.dash('skull exit corridor', 3109, 9560, 1);
    await io.dash('skull exit ladder approach', 3104, 9576, 1);
    if (!(await io.waitForLadder())) throw Error('ghost exit: basement ladder unobserved');
    await io.climbLadder();
    const landing = io.pos();
    if (!landing || landing.level !== 0 || landing.worldZ >= 4000) {
        throw Error('ghost exit: surface transition unobserved');
    }
    await resolveExitRuneTower(io, 'skull exit');
}

type ContestWalkIO = {
    pos: () => { worldX: number; worldZ: number; level: number } | undefined;
    dash: (label: string, x: number, z: number, tol?: number) => Promise<void>;
    locAt: (x: number, z: number) => any;
    opLoc: (loc: any, opIndex?: number) => Promise<unknown>;
    step: (label: string, fn: () => Promise<unknown>, ok: () => boolean, tries?: number, wait?: number) => Promise<void>;
    walk: (label: string, points: PathPoint[]) => Promise<void>;
};

// quest_fishingcompo.rs2:22-35 moves a winner from the west gate tile to its east neighbour.
// A walk planner cannot perform this controlled crossing. The return stays east of McGrubor's gate.
export async function returnFishingContestTrophy(q: ContestWalkIO): Promise<void> {
    const gate = { id: 47, x: 2642, z: 3442 };
    await q.dash('contest exit approach', gate.x, gate.z, 0);
    await q.step(
        'contest gate exit',
        () => q.opLoc(q.locAt(gate.x, gate.z) ?? gate, 1),
        () => {
            const p = q.pos();
            return p?.level === 0 && p.worldX === gate.x + 1 && p.worldZ === gate.z;
        },
        8,
        4,
    );
    await q.walk('trophy to west dwarf', [
        { x: 2645, z: 3459, tol: 2 },
        { x: 2666, z: 3462, tol: 2 },
        { x: 2679, z: 3472, tol: 2 },
        { x: 2731, z: 3484, tol: 3 },
        { x: 2820, z: 3487, tol: 2 },
    ]);
}

// knowledge/doors.json gives the rat cage gate (loc 37 at 2595,9657) kind unknown, so the door policy keeps it shut
// after the lever opens it for 500 ticks (quest_cog_gates_and_levers.rs2:28-42). The policy plan then ends at the
// cage bars (2588,9661), and walkPath crosses them in a straight line. One client-routed click goes through the gate.
export const CLOCK_TROUGH = { x: 2588, z: 9656 };

export async function walkClockTowerTrough(q: { dash: (label: string, x: number, z: number, tol?: number) => Promise<void> }): Promise<void> {
    await q.dash('to trough', CLOCK_TROUGH.x, CLOCK_TROUGH.z, 1);
}

// Brother Kojo wanders between his room (z >= 3246) and the middle room through door loc 1530 at 2567,3245 (north
// wall, maps/m40_50.jm2). When it is shut and he is across it, the SDK finds no local route: interactNpc returns
// cant_reach and sends nothing, so talk() sees no "can't reach" message and opens no door (Wandwaver at 2570,3248,0,
// Kojo at 2568,3245). Open it from the bot's side before the talk; an open door is left alone.
export const KOJO_DOOR = { x: 2567, z: 3245 };

type KojoDoorIO = {
    pos: () => { worldX: number; worldZ: number; level: number } | undefined;
    near: (x: number, z: number, r: number) => boolean;
    walk: (label: string, points: PathPoint[]) => Promise<void>;
    shutAt: (x: number, z: number) => any;
    openDoor: (label: string, x: number, z: number) => Promise<void>;
    npc: (re: RegExp) => any;
};

export async function openKojoDoor(q: KojoDoorIO): Promise<void> {
    const side = { x: KOJO_DOOR.x, z: (q.pos()?.worldZ ?? 0) > KOJO_DOOR.z ? KOJO_DOOR.z + 1 : KOJO_DOOR.z };
    if (!q.near(side.x, side.z, 0)) await q.walk('kojo door side', [{ ...side, tol: 0 }]);
    const shut = !!q.shutAt(KOJO_DOOR.x, KOJO_DOOR.z);
    await q.openDoor('kojo middle door', KOJO_DOOR.x, KOJO_DOOR.z);
    const k = q.npc(/^brother kojo$/i);
    const p = q.pos();
    console.log(
        `CLOCK_KOJO_DOOR ${JSON.stringify({ shut, open: !q.shutAt(KOJO_DOOR.x, KOJO_DOOR.z), kojo: k && { x: k.x, z: k.z }, at: p && { x: p.worldX, z: p.worldZ, level: p.level } })}`,
    );
}

// Keep the donor route/task distinction (Scotho/idlescape tutorial enter-mine;
// rs2b2t/rs2b0t quest-pitfalls-32): finishing a prerequisite/partial leg is not
// finishing its route. Our PathResult.next supplies the existing resume cursor.
// A retry retains every unfinished corridor point and the original deadline.
export async function walkQuestCorridor(
    io: {
        tick: () => number;
        stop: () => boolean;
        near: (point: PathPoint, tolerance: number) => boolean;
        walk: (points: PathPoint[], options: PathOptions) => Promise<PathResult>;
        onAttempt?: (attempt: number, result: PathResult) => void;
    },
    points: PathPoint[],
    deadline: number,
): Promise<{ ok: boolean; detail?: string }> {
    if (!points.length) return { ok: false, detail: 'empty quest corridor' };
    const goal = points[points.length - 1]!;
    const tolerance = goal.tol ?? 2;
    let cursor = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
        if (io.stop() || io.tick() >= deadline) return { ok: false, detail: 'quest corridor stopped/deadline' };
        if (io.near(goal, tolerance)) return { ok: true };
        const remaining = points.slice(cursor);
        const budget = deadline - io.tick();
        const r = await io.walk(remaining, { maxTicks: budget, stop: () => io.stop() || io.tick() >= deadline });
        io.onAttempt?.(attempt, r);
        if (r.detail?.startsWith('tick stream stalled:')) return { ok: false, detail: r.detail };
        if (io.stop()) return { ok: false, detail: 'quest corridor stopped/deadline' };
        if (!Number.isSafeInteger(r.next) || r.next < 0 || r.next > remaining.length) {
            return { ok: false, detail: 'invalid quest corridor cursor' };
        }
        if (r.ok) {
            return io.tick() <= deadline && io.near(goal, tolerance + 1)
                ? { ok: true }
                : { ok: false, detail: 'quest corridor arrival unobserved' };
        }
        if (io.tick() >= deadline || r.detail === 'stopped') return { ok: false, detail: 'quest corridor stopped/deadline' };
        cursor += r.next;
        if (cursor === points.length) return { ok: false, detail: 'quest corridor arrival unobserved' };
    }
    return { ok: false, detail: 'quest corridor exhausted bounded retries' };
}

export const DUSTY_KEY = 1590;
export const JAIL_KEY = 1591;

// Brings an account that Sea Slug left on the fishing platform or the island back to the Witchaven shore.
export async function runSeaslugLeave(cap = 600, account?: string, existingSession?: Session): Promise<void> {
    const PLATFORM = { x: 2782, z: 3273 };
    const ISLAND = { x: 2800, z: 3320 };
    const SHORE = { x: 2722, z: 3305 };
    const openQuest = await resolveOpenQuest();
    const q = await openQuest({
        cap,
        eatAt: 40,
        ...(account ? { name: account } : {}),
        ...(existingSession ? { session: existingSession } : {}),
    });
    try {
        for (let i = 0; i < 3 && !q.near(SHORE.x, SHORE.z, 12); i++) {
            if (q.near(ISLAND.x, ISLAND.z, 20)) {
                await q.talk(
                    'kent',
                    /^kent$/i,
                    [],
                    () => q.sawText(/thanks kent/i) || q.sawText(/please go back and get my boy/i),
                    { x: 2793, z: 3321 },
                    60,
                );
                await q.converse([], () => !q.dialogOpen(), 20);
                await q.talk('holgart island', /^holgart$/i, [], () => q.near(PLATFORM.x, PLATFORM.z, 6), ISLAND, 40);
                await q.converse([], () => !q.dialogOpen(), 10);
            } else if (q.near(PLATFORM.x, PLATFORM.z, 25)) {
                await q.talk(
                    'holgart platform',
                    /^holgart$/i,
                    [/okay, let'?s go back/i],
                    () => q.near(SHORE.x, SHORE.z, 6) || q.near(ISLAND.x, ISLAND.z, 8),
                    PLATFORM,
                    40,
                );
                await q.converse([], () => !q.dialogOpen(), 10);
            } else {
                break;
            }
        }
        if (existingSession) {
            if (!q.near(SHORE.x, SHORE.z, 12)) throw Error('seaslug-leave: did not reach Witchaven shore');
        } else {
            await q.end(q.near(SHORE.x, SHORE.z, 12), 'seaslug-leave');
        }
    } catch (e) {
        if (existingSession) throw e;
        await q.fail(String(e));
    }
}

// Acquires the untradeable Dusty Key from Taverley Dungeon (Jailer -> Jail key -> Velrak -> Dusty key -> surface).
export async function runDustyKey(cap = 3000, account?: string, existingSession?: Session): Promise<void> {
    const TAV_LADDER = { x: 2884, z: 3397 };
    const LADDER_FOOT = { x: 2884, z: 9797 };
    const JAILER = { id: 201, x: 2933, z: 9693 };
    const JAIL_DOOR = { id: 2631, x: 2931, z: 9690 };
    const VELRAK = { x: 2931, z: 9685 };
    const GATE = { x: 2924, z: 9803 };

    const openQuest = await resolveOpenQuest();
    const walkTargetPersist = await resolveWalkTargetPersist();
    const q = await openQuest({
        cap,
        eatAt: 50,
        lumbridgeOk: false,
        ...(account ? { name: account } : {}),
        ...(existingSession ? { session: existingSession } : {}),
    });
    const failOrThrow = async (msg: string): Promise<never> => {
        if (existingSession) throw Error(msg);
        await q.fail(msg);
        throw Error(msg);
    };
    try {
        const z = () => q.pos()?.worldZ ?? 0;
        const inDungeon = () => {
            const p = q.pos();
            return !!p && p.worldX >= 2816 && p.worldX < 2970 && p.worldZ >= 9664 && p.worldZ < 9920;
        };
        const ladderAt = (at: { x: number; z: number }, re: RegExp) => () =>
            q.findLoc(
                (l: any) =>
                    /ladder/i.test(l.name) &&
                    Math.max(Math.abs(l.x - at.x), Math.abs(l.z - at.z)) <= 1 &&
                    (l.optionsWithIndex ?? []).some((o: any) => re.test(o.text)),
            );
        const npc = (id: number): any =>
            (q.st()?.nearbyNpcs ?? [])
                .filter((n: any) => n.id === id)
                .sort((a: any, b: any) => a.distance - b.distance)[0];
        const ground = (id: number): any =>
            (q.st()?.groundItems ?? [])
                .filter((g: any) => g.id === id)
                .sort((a: any, b: any) => a.distance - b.distance)[0];

        if (q.has(DUSTY_KEY)) {
            if (existingSession) return;
            await q.end(true, 'dusty key held');
        }
        if (!inDungeon()) {
            const there = await walkTargetPersist(q.s, { x: TAV_LADDER.x, z: TAV_LADDER.z + 1, level: 0 });
            if (!there.ok) await failOrThrow(`route to the Taverley ladder: ${there.reason ?? ''} ${there.detail ?? ''}`);
            await q.climb('taverley ladder', ladderAt(TAV_LADDER, /climb-down/i), /climb-down/i, inDungeon);
        }
        q.milestone('dungeon');
        q.blockDoor(0, GATE.x, GATE.z);
        await q.walk('to jailer', [{ x: JAILER.x - 3, z: JAILER.z - 1, tol: 3 }]);
        for (let t = 0; t < 200 && !q.has(JAIL_KEY); t++) {
            await q.guard('jailer');
            const g = ground(JAIL_KEY);
            const n = npc(JAILER.id);
            if (g) {
                if (t % 3 === 0) await q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' });
            } else if (n && (t % 5 === 0 || q.pos()?.targetIndex !== n.index)) {
                await q.attackNpc(n);
            }
            await q.waitTicks(1);
        }
        if (!q.has(JAIL_KEY)) await failOrThrow('jail key');
        q.milestone('jail key');
        const inCell = () => z() < JAIL_DOOR.z;
        await q.step('cell door', () => q.useOnLoc(JAIL_KEY, JAIL_DOOR), inCell, 15, 4);
        await q.talk(
            'velrak',
            /^velrak/i,
            [/know anywhere good to explore/i, /yes please/i],
            () => q.has(DUSTY_KEY),
            VELRAK,
            40,
        );
        q.milestone('dusty key');
        await q.step('leave cell', () => q.opLoc(JAIL_DOOR, 1), () => !inCell(), 15, 4);
        await q.walk('to ladder', [{ x: LADDER_FOOT.x, z: LADDER_FOOT.z + 1, tol: 1 }]);
        await q.climb('ladder up', ladderAt(LADDER_FOOT, /climb-up/i), /climb-up/i, () => z() < 9000);
        q.milestone('surface');
        if (existingSession) {
            if (!q.has(DUSTY_KEY)) throw Error('dustyKey=0');
        } else {
            await q.end(q.has(DUSTY_KEY), `dustyKey=${q.has(DUSTY_KEY) ? 1 : 0}`);
        }
    } catch (e) {
        if (existingSession) throw e;
        await q.fail(String(e));
    }
}
