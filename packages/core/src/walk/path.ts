// Minimap click-ahead path stepper (research/walking.md): clicks ahead along a precomputed path,
// opens shut doors along the planned path, and detours around live hunter squares.
import { executionContext } from '../../../../vendor/rs-sdk/sdk/execution-context';
import { watchTickStream } from '../tick-stream';

export interface PathTile { x: number; z: number }
export interface PathPoint extends PathTile { tol?: number }
export interface PathLoc { x: number; z: number; id: number; name?: string; optionsWithIndex?: { text: string; opIndex: number }[] }
export interface PathDeps {
    tick?(): number | undefined;
    pos(): { x: number; z: number; level: number } | null;
    onTick(cb: () => void): () => void;
    ended?: Promise<unknown>;
    walk(x: number, z: number): unknown;
    interactLoc(loc: PathLoc, op: number): unknown;
    // Clicks the run button on (controls:com_5). Sent once, before the first walk click.
    runOn?(): unknown;
    locs(): PathLoc[];
    messages?(): readonly { text: string; tick: number; observationId?: number }[];
    blockDoor?(level: number, loc: PathTile): boolean;
    doorBlocked?(level: number, loc: PathTile): boolean;
    // Path corners from `from` to `to`, without `from` (the rs-sdk findLongPath format). `avoid` tiles are closed
    // for this query; `from` and `to` stay open.
    plan(level: number, from: PathTile, to: PathTile, avoid?: readonly PathTile[]): PathTile[];
    // Visible monsters that hunt this account, each with the square the walk keeps out of (danger.ts liveHunters).
    hunters?(): readonly { x: number; z: number; r: number }[];
    // The harm verdict of a planned path (danger/exposure.ts walkVerdict) and whether its first tile is already in a
    // hunter's reach. walkPath does not start a `refuse` walk from outside a hunter's reach.
    danger?(level: number, tiles: readonly PathTile[]): { verdict: 'clear' | 'eat' | 'refuse'; start: boolean; summary: { zone: string; damage: number; need: number; needHeal: number } };
    // Whether the client can walk from the bot's tile to `to` in its loaded scene (reach.ts); null when unknown.
    reach?(to: { x: number; z: number; level: number }, opts?: { adjacentOk?: boolean }): boolean | null;
    // A paid crossing at this door tile (travel.ts fareCrossings): its Open starts a dialogue that takes the fare.
    // With `dialog` and `answer` the walk answers its choices; `coins` is the pack's coins, null when unknown.
    fare?(level: number, loc: PathTile): { coins: number; choices: readonly string[]; label: string; waived?: boolean } | null;
    coins?(): number | null;
    dialog?(): { isOpen: boolean; isWaiting?: boolean; text?: string; options: { index: number; text: string }[] } | null;
    answer?(index: number): unknown;
    // Runs once before the walk plans (sessionWalker: the fare float at the start bank, fare-float.ts).
    prepare?(goal: { x: number; z: number; level: number }): Promise<unknown>;
}
export interface PathOptions {
    signal?: AbortSignal;
    idleMs?: number;        // monotonic deadline for a client that stops publishing game ticks
    look?: number;          // tiles ahead to click (default 20; the client routes inside its 104x104 scene)
    reclickAt?: number;     // click again when this many tiles of the last click remain (default 6: 3 ticks running)
    maxTicks?: number;      // tick budget (default: path tiles + 60)
    immediateHunterDetours?: boolean; // take a complete live-hunter detour immediately instead of waiting for a short one
    stop?: () => boolean;   // checked on every tick (death, abort)
    log?: (msg: string) => void;
}
// `next` is the index of the first point the bot has not passed yet: a retry can start from points.slice(next).
export interface PathResult { ok: boolean; ticks: number; still: number; clicks: number; repaths: number; doors: number; next: number; detail?: string }

interface HunterSquare { x: number; z: number; r: number }

const DETOUR = 15, HOLD = 50, SHORT = 4;
const d8 = (a: PathTile, b: PathTile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
const tileKey = (x: number, z: number) => (x + 131072) * 262144 + (z + 131072);
// Open chests and cupboards are not route edges. Legacy path adapters omit names;
// live SDK locations supply them. Preserve unnamed adapters' door contract.
const DOOR_OR_GATE_RE = /\b(?:doors?|gates?)\b/i;
const OPEN_OPT_RE = /^open$/i;
const openOp = (l: PathLoc) => l.name && !DOOR_OR_GATE_RE.test(l.name)
    ? undefined : (l.optionsWithIndex ?? []).find(o => OPEN_OPT_RE.test(o.text));
const messageKey = (m: { text: string; tick: number; observationId?: number }) => `${m.observationId ?? m.tick}:${m.text}`;
const normText = (x: string) => x.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');

// Corners to single tiles. rs-sdk path segments are straight or diagonal, so a step by sign is exact for them.
export function expandPath(from: PathTile, corners: PathTile[]): PathTile[] {
    const out: PathTile[] = [];
    let cx = from.x, cz = from.z;
    for (const c of corners) {
        while (cx !== c.x || cz !== c.z) {
            cx += Math.sign(c.x - cx);
            cz += Math.sign(c.z - cz);
            out.push({ x: cx, z: cz });
        }
    }
    return out;
}

function collectHunterSquares(hunters: readonly HunterSquare[] | undefined, p: PathTile, look: number): { squares: HunterSquare[]; inside: boolean } {
    const squares: HunterSquare[] = [];
    let inside = false;
    for (const h of hunters ?? []) {
        const d = d8(h, p);
        if (d > look * 2) continue;
        if (d > h.r) squares.push(h);
        else { inside = true; if (d >= 1) squares.push({ x: h.x, z: h.z, r: d - 1 }); }
    }
    return { squares, inside };
}

function expandClosedSquares(squares: readonly HunterSquare[]): PathTile[] {
    const out: PathTile[] = [];
    for (let s = 0; s < squares.length; s++) {
        const h = squares[s]!;
        for (let x = h.x - h.r; x <= h.x + h.r; x++) {
            for (let z = h.z - h.r; z <= h.z + h.r; z++) out.push({ x, z });
        }
    }
    return out;
}

function buildSegmentedPath(
    deps: PathDeps,
    level: number,
    from: PathTile,
    points: readonly PathPoint[],
    firstPoint: number,
    blockedDoor: (loc: PathTile) => boolean,
    avoid: readonly PathTile[] = [],
): { tiles: PathTile[]; seg: number[]; planned: boolean } {
    const tiles: PathTile[] = [], seg: number[] = [];
    let cur = from, planned = true;
    for (let k = firstPoint; k < points.length; k++) {
        // rs-sdk's collision map can call the bot's own tile blocked (seen: 2774,3228 beside the Brimhaven
        // customs officer gives 0 waypoints). Then take the straight line: the client routes each click itself.
        const corners = avoid.length ? deps.plan(level, cur, points[k]!, avoid) : deps.plan(level, cur, points[k]!);
        if (!corners.length && d8(cur, points[k]!) > 0) planned = false;
        const t = expandPath(cur, corners.length ? corners : [points[k]!]);
        // A door coordinate anchors a wall edge, not a blocked floor tile.
        // Trust a nonempty edge-aware plan; only an unverified straight
        // fallback must reject a known blocked anchor.
        if (!corners.length && t.some(blockedDoor)) return { tiles: [], seg: [], planned: false };
        for (const x of t) { tiles.push(x); seg.push(k); }
        if (t.length) cur = t[t.length - 1]!;
    }
    return { tiles, seg, planned };
}

const shutDoorAheadMap = new Map<number, number>();
function findShutDoorAt(
    deps: PathDeps,
    level: number,
    tiles: readonly PathTile[],
    from: number,
    to: number,
    blockedDoor: (loc: PathTile) => boolean,
): { l: PathLoc; i: number } | null {
    const startIdx = Math.max(0, from), endIdx = Math.min(tiles.length - 1, to);
    const ahead = shutDoorAheadMap;
    ahead.clear();
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = startIdx; i <= endIdx; i++) {
        const t = tiles[i]!;
        if (t.x < minX) minX = t.x;
        if (t.x > maxX) maxX = t.x;
        if (t.z < minZ) minZ = t.z;
        if (t.z > maxZ) maxZ = t.z;
        ahead.set(tileKey(t.x, t.z), i);
    }
    // A shut door on the tile the bot stands on blocks it as well, and the path's tiles leave that tile out. Live:
    // Doric's Quest ends on his doorway (door 1530 at 2952,3453), and every walk click out was refused.
    // It counts only when the client cannot reach the next path tile: the wall of a door is on one edge of its
    // tile, and a bot past that edge is not blocked. The Karamja shipyard gate (2438 at 2945,3041) puts the
    // player on the gate tile, inside the yard; an Open from there moves the player out again
    // (quest_grandtree.rs2 open_shipyard_gate), away from the foreman.
    const here = deps.pos();
    let hereKey = -1;
    if (here && here.level === level) {
        const hk = tileKey(here.x, here.z);
        if (!ahead.has(hk)) {
            hereKey = hk;
            ahead.set(hk, startIdx);
            if (here.x < minX) minX = here.x;
            if (here.x > maxX) maxX = here.x;
            if (here.z < minZ) minZ = here.z;
            if (here.z > maxZ) maxZ = here.z;
        }
    }
    if (ahead.size === 0) return null;
    let hereBlocks: boolean | undefined;
    const blocksHere = (): boolean => {
        if (hereBlocks === undefined) {
            const next = tiles[startIdx];
            hereBlocks = !next || deps.reach?.({ x: next.x, z: next.z, level }) !== true;
        }
        return hereBlocks;
    };
    let best: { l: PathLoc; i: number } | null = null;
    const locs = deps.locs();
    for (let k = 0; k < locs.length; k++) {
        const l = locs[k]!;
        if (l.x < minX || l.x > maxX || l.z < minZ || l.z > maxZ) continue;
        const lk = tileKey(l.x, l.z);
        const i = ahead.get(lk);
        if (i !== undefined && (!best || i < best.i) && openOp(l) && !blockedDoor(l) && (lk !== hereKey || blocksHere())) best = { l, i };
    }
    return best;
}

function findNearestPathIndex(
    deps: PathDeps,
    level: number,
    tiles: readonly PathTile[],
    idx: number,
    look: number,
    p: PathTile,
    blockedDoor: (loc: PathTile) => boolean,
): { i: number; d: number } {
    let best = { i: Math.max(0, idx), d: Infinity };
    const hi = Math.min(tiles.length - 1, Math.max(0, idx) + look * 2);
    // A path that folds back past a shut door has later tiles as near as the door tile. A tie must not
    // cross the first shut door, or the door leaves the open lookahead and the client refuses the click.
    // A strictly nearer tile still crosses it: the door can shut again behind a bot that walked through.
    const door = findShutDoorAt(deps, level, tiles, idx, hi, blockedDoor)?.i ?? Infinity;
    for (let i = Math.max(0, idx); i <= hi; i++) {
        const d = d8(tiles[i]!, p);
        if (d < best.d || (d === best.d && !(best.i <= door && i > door))) best = { i, d };   // a tie goes forward
    }
    return best;
}

function lineHitsSquare(from: PathTile, to: PathTile, squares: readonly HunterSquare[]): boolean {
    let cx = from.x, cz = from.z;
    while (cx !== to.x || cz !== to.z) {
        cx += Math.sign(to.x - cx);
        cz += Math.sign(to.z - cz);
        for (let i = 0; i < squares.length; i++) {
            const h = squares[i]!;
            if (Math.max(Math.abs(cx - h.x), Math.abs(cz - h.z)) <= h.r) return true;
        }
    }
    return false;
}

function selectClickIndex(
    deps: PathDeps,
    level: number,
    tiles: readonly PathTile[],
    idx: number,
    span: number,
    squares: readonly HunterSquare[],
    inside: boolean,
    held: number,
    look: number,
): number {
    // The furthest tile within `span` the client can reach; a tile behind a closed door or out of the scene is
    // skipped (rs2b0t selectClickTarget). Without a reach probe, the tile `span` ahead.
    let top = Math.min(tiles.length - 1, Math.max(0, idx) + span);
    // The client routes each click itself, not always along the straight line (seed 5: a 20-tile click round a
    // giant spider went north first, at it). With a live square within one lookahead a click goes at most SHORT
    // tiles ahead, and one whose straight line crosses a square is moved back along the path until the line
    // clears it. No clear tile ahead: hold (-1), unless a square holds the bot.
    const here = deps.pos();
    if (squares.length && here && top > Math.max(0, idx)) {
        if (squares.some(h => d8(h, here) <= look + h.r)) top = Math.min(top, Math.max(0, idx) + SHORT);
        let clear = top;
        while (clear > Math.max(0, idx) && lineHitsSquare(here, tiles[clear]!, squares)) clear--;
        if (clear > Math.max(0, idx)) top = clear;
        else if (!inside && held < HOLD) return -1;
    }
    if (!deps.reach) return top;
    for (let i = top; i > Math.max(0, idx); i--) if (deps.reach({ ...tiles[i]!, level }) !== false) return i;
    return top;
}

/** Walks through waypoints the way a player clicks ahead on the minimap. */
export function walkPath(deps: PathDeps, points: PathPoint[], opts: PathOptions = {}): Promise<PathResult> {
    const goal = points[points.length - 1], at = deps.pos();
    if (!deps.prepare || !goal || !at) return walkPathFrom(deps, points, opts);
    return deps.prepare({ x: goal.x, z: goal.z, level: at.level }).then(() => walkPathFrom(deps, points, opts), () => walkPathFrom(deps, points, opts));
}

function walkPathFrom(deps: PathDeps, points: PathPoint[], opts: PathOptions): Promise<PathResult> {
    const look = opts.look ?? 20;
    const reclickAt = opts.reclickAt ?? 6;
    const log = opts.log ?? (() => {});
    const res: PathResult = { ok: false, ticks: 0, still: 0, clicks: 0, repaths: 0, doors: 0, next: 0 };
    const signals = [...new Set([opts.signal, executionContext.getStore()?.signal].filter((signal): signal is AbortSignal => !!signal))];
    if (signals.some(signal => signal.aborted)) return Promise.resolve({ ...res, detail: 'stopped' });
    const start = deps.pos();
    const goal = points[points.length - 1];
    if (!start) return Promise.resolve({ ...res, detail: 'no position' });
    if (!goal) return Promise.resolve({ ...res, ok: true });
    const level = start.level;
    const goalTol = goal.tol ?? 2;
    const failedDoors = new Set<string>();
    const doorKey = (loc: PathTile) => `${level},${loc.x},${loc.z}`;
    const blockedDoor = (loc: PathTile) => failedDoors.has(doorKey(loc)) || deps.doorBlocked?.(level, loc) === true;

    // Path tiles through every point in order. seg[i] is the index of the point that tile i leads to.
    let tiles: PathTile[] = [];
    let seg: number[] = [];
    // Live hunters (deps.hunters): each square within two lookaheads is closed for each plan; one further away moves
    // before the bot gets there. A square that holds the bot shrinks to just inside the bot's distance, so no step
    // goes nearer that monster (seed 5: dropping it let the bot run on to a giant spider), and the bot never holds.
    let squares: HunterSquare[] = [];
    let inside = false;
    const seen = (p: PathTile) => {
        ({ squares, inside } = collectHunterSquares(deps.hunters?.(), p, look));
        return squares;
    };
    // Plans round the live squares; when that finds no plan, plans without them (the walk goes on as before).
    // A way round more than DETOUR tiles longer than the plain plan is refused for the first HOLD ticks of holding:
    // the bot waits at the edge of the square for the monster to wander off. Taking each shortest way round as the
    // Karamja scorpions moved swung the bot between the road and the far side of the volcano for 200 ticks (seed 5).
    let held = 0;
    const endDist = (pathTiles: readonly PathTile[]) => pathTiles.length ? d8(pathTiles[pathTiles.length - 1]!, goal) : Infinity;
    const buildAround = (from: PathTile, firstPoint: number) => {
        if (squares.length) {
            const round = buildSegmentedPath(deps, level, from, points, firstPoint, blockedDoor, expandClosedSquares(squares));
            if (round.planned) {
                const roundEnd = endDist(round.tiles);
                const plain = buildSegmentedPath(deps, level, from, points, firstPoint, blockedDoor);
                const plainEnd = endDist(plain.tiles);
                // Reject an avoidance detour whose corridor is severed short of the goal when the open plan reaches it.
                if (roundEnd > Math.max(3, goalTol + 2) && plain.planned && plainEnd + 3 < roundEnd) {
                    tiles = plain.tiles; seg = plain.seg; return;
                }
                if (opts.immediateHunterDetours || held >= HOLD || !plain.tiles.length || round.tiles.length <= plain.tiles.length + DETOUR) {
                    tiles = round.tiles; seg = round.seg; return;
                }
                tiles = plain.tiles; seg = plain.seg; return;
            }
        }
        const plain = buildSegmentedPath(deps, level, from, points, firstPoint, blockedDoor);
        tiles = plain.tiles; seg = plain.seg;
    };
    seen(start);
    buildAround(start, 0);
    if (tiles.length === 0 && d8(start, goal) > goalTol) return Promise.resolve({ ...res, detail: `no path to ${goal.x},${goal.z}` });
    // A walk whose hunters would take the Hitpoints under the retreat line with the pack food is not started (the
    // caller stages food). A walk that starts in a hunter's reach goes on: standing still there costs more.
    const harm = deps.danger?.(level, tiles);
    if (harm && harm.verdict === 'refuse' && !harm.start) {
        console.log(`WALK_DANGER ${JSON.stringify({ action: 'refuse', from: { ...start }, to: { x: goal.x, z: goal.z, level }, ...harm.summary })}`);
        return Promise.resolve({ ...res, detail: `walk danger: ${harm.summary.zone} needs ${harm.summary.needHeal} heal of food (expected damage ${harm.summary.damage})` });
    }
    const maxTicks = opts.maxTicks ?? tiles.length + 60;

    let idx = -1;          // path tile nearest the bot
    let target = -1;       // path index of the last walk click
    // `acked`: the client has answered the Open dispatch. A client that takes no input (seen for 42 ticks after a
    // practice login in the Clock Tower) leaves the door shut, which is not evidence that the door stays closed.
    // A paid crossing (`fare`) also keeps the dialogue it showed (`talk`), the tile the bot stood on when the dialogue
    // opened (`pre`) and the path index of the door tile (`i`): a bot moved off `pre` to `i` or past it has crossed.
    type DoorTry = { loc: PathLoc; sentAt: number; messages: Set<string>; acked: boolean; i: number;
        fare?: NonNullable<ReturnType<NonNullable<PathDeps['fare']>>>; talk: string[]; pre?: PathTile };
    let door: DoorTry | null = null;
    const doorAttempts = new Map<string, number>();
    let last = { x: start.x, z: start.z };
    let still = 0;
    let ticks = 0;
    let ranOn = false;
    let sentThisTick = false;
    let movementEpoch = 0, rejectedWalks = 0, movementRepaths = 0;
    let rejectionReplan = false, rejectionReplanned = false;
    let dodged = '', dodges = 0;
    let bestGoalDist = d8(start, points[0] ?? goal), maxSeg = 0, progressTick = 0, progressDoors = 0;
    let boxMinX = start.x, boxMaxX = start.x, boxMinZ = start.z, boxMaxZ = start.z, boxRepaths = 0;
    const boxVisited = new Set<number>([tileKey(start.x, start.z)]);
    let walkReply: (reply: unknown, from: { x: number; z: number; level: number }, to: PathTile, epoch: number) => void = () => {};

    const shutDoorAt = (from: number, to: number) => findShutDoorAt(deps, level, tiles, from, to, blockedDoor);
    const shutDoorAhead = (from: number, to: number): PathLoc | null => shutDoorAt(from, to)?.l ?? null;
    const nearest = (p: PathTile) => findNearestPathIndex(deps, level, tiles, idx, look, p, blockedDoor);
    const send = (what: string, f: () => unknown, reply?: (value: unknown) => void): boolean => {
        if (sentThisTick) return false;
        sentThisTick = true;
        try {
            const r = f() as { then?: unknown } | undefined;
            if (r && typeof r.then === 'function') Promise.resolve(r).then(value => reply?.(value), error => reply?.({ success: false, phase: 'dispatch', reason: 'exception', message: String(error) }));
            else reply?.(r);
        } catch (error) { reply?.({ success: false, phase: 'dispatch', reason: 'exception', message: String(error) }); }
        log(what);
        return true;
    };
    const clickAhead = (span: number) => {
        const i = selectClickIndex(deps, level, tiles, idx, span, squares, inside, held, look);
        if (sentThisTick) return;
        const from = deps.pos();
        if (!from) return;
        if (i < 0) {
            // Hold: a bot still running toward its last click is stopped on its own tile, short of the square.
            held++;
            if (still === 0 && send(`hold ${from.x},${from.z}`, () => deps.walk(from.x, from.z))) target = -1;
            return;
        }
        const t = tiles[i]!;
        const epoch = movementEpoch;
        res.clicks++; // Dispatch attempts, including an explicit client refusal.
        if (send(`walk ${t.x},${t.z}`, () => deps.walk(t.x, t.z), reply => walkReply(reply, from, t, epoch))) target = i;
    };
    const replan = (p: PathTile, why: string): boolean => {
        buildAround(p, seg[Math.max(0, idx)] ?? 0);
        idx = -1; target = -1; res.repaths++; boxRepaths++;
        log(`re-plan: ${why}`);
        if (tiles.length === 0) return false;
        idx = nearest(p).i;
        return true;
    };

    return new Promise<PathResult>(resolve => {
        let done = false;
        const abortSubscriptions: (() => void)[] = [];
        const finish = (ok: boolean, detail?: string) => {
            if (done) return;
            done = true;
            off();
            for (const unsubscribe of abortSubscriptions) unsubscribe();
            resolve({ ...res, ok, ticks, next: ok ? points.length : (seg[Math.max(0, idx)] ?? 0), detail });
        };
        const failedDoor = (loc: PathLoc, why: string, p: PathTile) => {
            const attempts = doorAttempts.get(doorKey(loc)) ?? 0;
            const detail = `no progress: door ${loc.id}@${loc.x},${loc.z},${level} stayed closed after ${attempts} Open attempts at=${p.x},${p.z} goal=${goal.x},${goal.z}: ${why}`;
            // A paid crossing that fails is never a silent detour: the line names the fare, the coins and the dialogue,
            // and WALK_DETOUR gives the path tiles left through the crossing and round it.
            const fare = deps.fare?.(level, loc) ?? null, talk = door?.loc === loc ? door.talk : [];
            const through = tiles.length - Math.max(0, idx);
            if (fare) console.log(`WALK_FARE_FAIL ${JSON.stringify({ crossing: fare.label, loc: { x: loc.x, z: loc.z, level }, fare: fare.coins, coins: deps.coins?.() ?? null, at: { x: p.x, z: p.z }, goal: { x: goal.x, z: goal.z }, attempts, why, dialog: talk.slice(-4) })}`);
            failedDoors.add(doorKey(loc));
            const registered = deps.blockDoor?.(level, loc) === true;
            door = null;
            log(detail);
            if (!registered || !replan(p, detail)) return finish(false, detail);
            if (fare) console.log(`WALK_DETOUR ${JSON.stringify({ crossing: fare.label, at: { x: p.x, z: p.z, level }, goal: { x: goal.x, z: goal.z }, throughTiles: through, roundTiles: tiles.length - Math.max(0, idx) })}`);
            clickAhead(look);
        };
        walkReply = (value, from, to, epoch) => {
            const p = deps.pos();
            if (done || epoch !== movementEpoch || !p || p.level !== from.level || d8(p, from) !== 0) return;
            const reply = value as { success?: boolean; phase?: unknown; reason?: unknown; message?: unknown } | null | undefined;
            if (reply?.success !== false) return; // Undefined fakes and accepted dispatches remain movement-checked.
            // A slow reply may arrive after the normal still-path replan. That already spent this attempt.
            if (res.repaths > movementRepaths) { rejectionReplanned = true; rejectionReplan = false; }
            rejectedWalks++;
            const detail = `no progress: walk rejected ${rejectedWalks} times start=${start.x},${start.z},${level} at=${p.x},${p.z},${p.level} target=${to.x},${to.z} reply=${JSON.stringify({ phase: reply.phase, reason: reply.reason, message: reply.message })}`;
            log(detail);
            if (rejectedWalks >= 3) { finish(false, detail); return; }
            if (!rejectionReplanned) rejectionReplan = true;
        };
        const decide = () => {
            sentThisTick = false;
            const p = deps.pos();
            if (!p) return finish(false, 'no position');
            if (p.level !== level) return finish(false, `left level ${level}`);
            // Near the goal is arrival, unless the goal is out of reach and a closed door lies on the path: then
            // the door is opened first (a bot two tiles from an NPC, behind its house wall, cannot talk to it).
            if (d8(p, goal) <= goalTol && !(deps.reach?.({ x: goal.x, z: goal.z, level }, { adjacentOk: true }) === false && shutDoorAt(Math.max(0, idx), tiles.length - 1))) return finish(true);
            if (opts.stop?.()) return finish(false, 'stopped');
            if (ticks > maxTicks) return finish(false, `budget ${maxTicks} ticks at ${p.x},${p.z}`);
            const moved = p.x !== last.x || p.z !== last.z;
            if (moved) { movementEpoch++; rejectedWalks = 0; movementRepaths = res.repaths; rejectionReplan = false; rejectionReplanned = false; }
            last = { x: p.x, z: p.z };
            still = moved ? 0 : still + 1;
            if (ticks > 0 && !moved) res.still++;

            // The run button does not count as the tick's input: the server takes 5 per tick, and it goes first.
            if (!ranOn && deps.runOn) { ranOn = true; send('run on', () => deps.runOn!()); sentThisTick = false; }

            if (rejectionReplan) {
                rejectionReplan = false; rejectionReplanned = true;
                if (!replan(p, 'client walk rejection')) return finish(false, `no path from ${p.x},${p.z}`);
            }
            const n = nearest(p);
            if (n.d > 3) {
                // Off the planned path (the client routed round something): plan again from here.
                if (!replan(p, `off path by ${n.d}`)) return finish(false, `no path from ${p.x},${p.z}`);
            } else idx = n.i;

            const curSeg = seg[Math.max(0, idx)] ?? 0;
            const advancedSeg = curSeg > maxSeg;
            if (advancedSeg) maxSeg = curSeg;
            const activeTarget = points[Math.min(points.length - 1, maxSeg)] ?? goal;
            const gd = d8(p, activeTarget);
            if (advancedSeg || gd <= bestGoalDist - 2 || res.doors !== progressDoors) {
                bestGoalDist = advancedSeg ? gd : Math.min(bestGoalDist, gd);
                progressTick = ticks;
                progressDoors = res.doors;
                boxMinX = boxMaxX = p.x;
                boxMinZ = boxMaxZ = p.z;
                boxRepaths = 0;
                boxVisited.clear();
                boxVisited.add(tileKey(p.x, p.z));
            } else {
                boxMinX = Math.min(boxMinX, p.x); boxMaxX = Math.max(boxMaxX, p.x);
                boxMinZ = Math.min(boxMinZ, p.z); boxMaxZ = Math.max(boxMaxZ, p.z);
                if (boxVisited.size < 32) boxVisited.add(tileKey(p.x, p.z));
                // Require at least two visited tiles so a pure stationary stall still hits its tick budget.
                if (ticks - progressTick >= 120 && boxVisited.size >= 2 && Math.max(boxMaxX - boxMinX, boxMaxZ - boxMinZ) <= 28 && boxRepaths >= 8) {
                    return finish(false, `no progress: walk oscillating near ${p.x},${p.z} target=${goal.x},${goal.z}`);
                }
            }

            // A live hunter's square reaches the next lookahead of path: plan round it, once for each set of squares.
            if (deps.hunters) {
                seen(p);
                if (squares.length) {
                    const lo = Math.max(0, idx), hi = Math.min(tiles.length - 1, lo + look);
                    const hit: HunterSquare[] = [];
                    for (let s = 0; s < squares.length; s++) {
                        const h = squares[s]!;
                        for (let i = lo; i <= hi; i++) if (d8(tiles[i]!, h) <= h.r) { hit.push(h); break; }
                    }
                    if (hit.length) {
                        const key = hit.map(h => `${h.x},${h.z},${h.r}`).join(' ');
                        if (key !== dodged && dodges < 60 && !door) {
                            dodged = key; dodges++;
                            if (!replan(p, `hunter at ${key}`)) return finish(false, `no path from ${p.x},${p.z}`);
                            clickAhead(look);
                            return;
                        }
                    }
                }
            }

            // A door the bot asked to open: click past it on the tick it opens.
            if (door) {
                const d = door;
                const shutNow = deps.locs().some(l => l.x === d.loc.x && l.z === d.loc.z && l.id === d.loc.id && openOp(l));
                if (!shutNow) { door = null; doorAttempts.delete(doorKey(d.loc)); log('door open'); clickAhead(look); return; }
                if (d.fare) {
                    const talk = deps.dialog?.();
                    if (talk?.isOpen) {
                        d.sentAt = ticks; d.pre ??= { x: p.x, z: p.z };
                        const text = (talk.text || talk.options.map(o => o.text).join(' | ')).slice(0, 160);
                        if (text && d.talk[d.talk.length - 1] !== text) d.talk.push(text);
                        if (talk.isWaiting) return;
                        const pick = talk.options.find(o => d.fare!.choices.some(c => normText(c) === normText(o.text)));
                        const index = pick?.index ?? (talk.options.length === 0 ? 0
                            : talk.options.length === 1 && /continue/i.test(talk.options[0]!.text) ? talk.options[0]!.index : undefined);
                        if (index === undefined) return failedDoor(d.loc, `unmapped fare dialogue: ${text}`, p);
                        send(`answer ${index}`, () => deps.answer?.(index));
                        return;
                    }
                    // The gate shuts again on the tick after it moves the bot through (border_gate.rs2 p_teleport).
                    if (d.pre && (p.x !== d.pre.x || p.z !== d.pre.z) && idx >= d.i) {
                        door = null; doorAttempts.delete(doorKey(d.loc)); log(`fare paid: ${d.fare.label}`); clickAhead(look); return;
                    }
                }
                const refusal = deps.messages?.().find(m => !d.messages.has(messageKey(m)) && /\b(?:door|gate).{0,32}\blocked\b|\b(?:cannot|can't) open\b/i.test(m.text));
                if (refusal) return failedDoor(d.loc, refusal.text, p);
                // Open may first walk to the door, then wait for a delayed server
                // action. Count unchanged ticks, not distance or accepted dispatches.
                // A paid crossing tries twice, once when the pack is short (a quest that waives the fare is the only
                // way through then): its dialogue said why it did not open.
                if (d.acked && still >= 6 && ticks - d.sentAt >= 6) {
                    const limit = d.fare ? ((deps.coins?.() ?? Infinity) < d.fare.coins ? 1 : 2) : 3;
                    if ((doorAttempts.get(doorKey(d.loc)) ?? 0) >= limit) return failedDoor(d.loc, d.fare ? 'fare crossing did not move the bot' : 'no open effect observed', p);
                    door = null;
                } else return;
            }
            const ahead = shutDoorAt(idx, idx + look), shut = ahead?.l ?? null;
            if (shut) {
                const op = openOp(shut)!.opIndex;
                const fare = deps.fare?.(level, shut) ?? undefined, held = fare ? deps.coins?.() ?? null : null;
                // Short of the fare, the guard only says so (border_gate.rs2 "I don't actually seem to have enough money").
                if (fare && held !== null && held < fare.coins && !fare.waived) return failedDoor(shut, `fare ${fare.coins} coins, the pack holds ${held}`, p);
                const baseline = new Set((deps.messages?.() ?? []).map(messageKey));
                const entry: DoorTry = { loc: shut, sentAt: ticks, messages: baseline, acked: false, i: ahead!.i, ...(fare ? { fare } : {}), talk: [] };
                if (send(`open ${shut.x},${shut.z} id${shut.id}`, () => deps.interactLoc(shut, op), () => { if (!entry.acked) { entry.acked = true; entry.sentAt = ticks; } })) {
                    door = entry;
                    doorAttempts.set(doorKey(shut), (doorAttempts.get(doorKey(shut)) ?? 0) + 1);
                    res.doors++; target = -1;
                }
                return;
            }
            // No tile gained for 2 ticks: plan again from where the bot stands.
            if (still >= 2) {
                if (rejectedWalks === 0 && !replan(p, `still ${still}`)) return finish(false, `no path from ${p.x},${p.z}`);
                // Only doors on the planned leg are attempted. A nearby unrelated
                // Open option is not evidence that it blocks this route.
                clickAhead(still >= 3 ? Math.ceil(look / 2) : look);
                return;
            }
            if (still >= 1 || target < 0 || target - idx <= reclickAt) {
                // The last click already ends at the goal, and the bot is still moving toward it.
                if (target === tiles.length - 1 && still === 0) return;
                clickAhead(look);
            }
        };
        const off = watchTickStream(deps, () => { ticks++; decide(); }, error => finish(false, error.message), opts.idleMs);
        const onAbort = () => finish(false, 'stopped');
        for (const signal of signals) {
            if (signal.aborted) { onAbort(); break; }
            signal.addEventListener('abort', onAbort, { once: true });
            abortSubscriptions.push(() => signal.removeEventListener('abort', onAbort));
        }
        void deps.ended?.then(() => finish(false, 'session ended'));
        if (!done) decide();
    });
}
