import { executionContext } from '../../../vendor/rs-sdk/sdk/execution-context';
import { atTile, checked, levelIs, type Outcome } from './act';
import { waitTicks } from './ticks';
import type { TickSource } from './ticks';
import type { Account, Leg, Tile, World } from './world';

export interface Walker extends TickSource {
    sdk: TickSource['sdk'] & { blockDoorTemporarily?(level: number, x: number, z: number, ttlMs?: number): boolean };
    bot: {
        walkTo(x: number, z: number, tolerance?: number): Promise<unknown>;
        interactLoc(target: unknown, option?: number | string | RegExp): Promise<unknown>;
        openDoor?(target?: unknown): Promise<unknown>;
    };
}

export interface WalkOptions { maxRetriesPerLeg?: number; legTimeoutTicks?: number; signal?: AbortSignal }

const cheb = (a: Tile, b: { worldX: number; worldZ: number }) => Math.max(Math.abs(a.x - b.worldX), Math.abs(a.z - b.worldZ));

// Runs route legs in order. Each leg is a checked action; a leg is retried from wherever the bot really is,
// so a non-exact arrival (Review Focus 4) just becomes the next leg's start.
export async function walkRoute(s: Walker, legs: Leg[], opts: WalkOptions = {}): Promise<Outcome> {
    const retries = opts.maxRetriesPerLeg ?? 3;
    let total = 0;
    for (const leg of legs) {
        let last: Outcome | null = null;
        for (let attempt = 0; attempt < retries; attempt++) {
            last = leg.kind === 'walk' ? await walkLeg(s, leg.to, opts) : await climbLeg(s, leg, opts);
            total += last.ticks;
            if (last.ok || last.reason === 'aborted') break;
            // Right after a climb the server refuses movement until the arrival delay ends (seen live: 3 quick
            // retries all refused within 11 ticks). Wait a little longer before each retry.
            if (last.reason === 'rejected') await waitTicks(s, 2 * (attempt + 1));
            // rs-sdk's pathfinder treats every door as open, so a walk can stop behind a shut one and the
            // client then refuses the climb with "Can't reach". Open the shut door nearest the stair and retry.
            if (leg.kind === 'transport' && last.reason === 'rejected' && /reach/i.test(last.detail)) {
                await openNearestDoor(s, leg.at);
                // walkTo opens doors on its own route, which covers a shut door outside the 8-tile search.
                await s.bot.walkTo(leg.at.x, leg.at.z, 1);
            }
        }
        if (!last!.ok) return { ...last!, ticks: total };
    }
    return { ok: true, ticks: total };
}

async function openNearestDoor(s: Walker, near: Tile): Promise<void> {
    const doors = (s.sdk.getState()?.nearbyLocs ?? [])
        .filter((l: any) => l.level === near.level && (l.options ?? []).some((o: string) => /^open$/i.test(o)))
        .map((l: any) => ({ l, d: Math.max(Math.abs(l.x - near.x), Math.abs(l.z - near.z)) }))
        .filter((x: { d: number }) => x.d <= 8)
        .sort((a: { d: number }, b: { d: number }) => a.d - b.d);
    if (doors.length > 0 && s.bot.openDoor) await s.bot.openDoor(doors[0].l);
}

// Runs one leg's bot.* call inside its own SDK execution context (sdk/execution-context.ts). The context's
// signal fires when the leg's outcome is decided or the caller aborts (reflex), so a long bot.walkTo stops
// instead of fighting the flee walk.
async function cancellable(opts: WalkOptions, leg: (send: (f: () => Promise<unknown>) => () => Promise<unknown>, signal: AbortSignal) => Promise<Outcome>): Promise<Outcome> {
    const ac = new AbortController();
    const onAbort = () => ac.abort(opts.signal?.reason ?? 'aborted');
    if (opts.signal?.aborted) onAbort(); else opts.signal?.addEventListener('abort', onAbort);
    const wrap = (f: () => Promise<unknown>) => () => executionContext.run({ signal: ac.signal }, f).catch(e => ({ success: false, message: String(e) }));
    try {
        return await leg(wrap, ac.signal);
    } finally {
        opts.signal?.removeEventListener('abort', onAbort);
        if (!ac.signal.aborted) ac.abort('leg done');
    }
}

function walkLeg(s: Walker, to: Tile, opts: WalkOptions): Promise<Outcome> {
    return cancellable(opts, (wrap, signal) => walkLegInner(s, to, { ...opts, signal }, wrap));
}

function walkLegInner(s: Walker, to: Tile, opts: WalkOptions, wrap: (f: () => Promise<unknown>) => () => Promise<unknown>): Promise<Outcome> {
    const p = s.sdk.getState()?.player;
    // A long walk keeps running inside walkTo, so the budget grows with distance.
    const budget = opts.legTimeoutTicks ?? (p ? cheb(to, p) * 2 + 30 : 60);
    return checked(s, {
        name: `walk to ${to.x},${to.z},${to.level}`,
        pre: st => (st?.player?.level === to.level ? null : `on level ${st?.player?.level}, leg is on level ${to.level}`),
        send: wrap(() => s.bot.walkTo(to.x, to.z, 2)),
        rejectOnFeedback: false,
        effect: atTile(to.x, to.z, to.level, 2),
        timeoutTicks: budget,
        signal: opts.signal,
    });
}

function climbLeg(s: Walker, leg: Extract<Leg, { kind: 'transport' }>, opts: WalkOptions): Promise<Outcome> {
    return cancellable(opts, (wrap, signal) => climbLegInner(s, leg, { ...opts, signal }, wrap));
}

function climbLegInner(s: Walker, leg: Extract<Leg, { kind: 'transport' }>, opts: WalkOptions, wrap: (f: () => Promise<unknown>) => () => Promise<unknown>): Promise<Outcome> {
    const findLoc = (st: any) => (st?.nearbyLocs ?? []).find((l: any) => l.x === leg.at.x && l.z === leg.at.z && l.level === leg.at.level);
    const arrive = atTile(leg.to.x, leg.to.z, leg.to.level, leg.exact ? 2 : 3);
    const onLevel = levelIs(leg.to.level);
    return checked(s, {
        name: `${leg.loc} ${leg.option} at ${leg.at.x},${leg.at.z},${leg.at.level}`,
        pre: st => (findLoc(st) ? null : `no loc at ${leg.at.x},${leg.at.z},${leg.at.level}`),
        send: wrap(() => s.bot.interactLoc(findLoc(s.sdk.getState()), Number(leg.option.replace(/^op/, '')))),
        effect: (b, n) => onLevel(b, n) && arrive(b, n),
        // interactLoc first walks round to a usable side of the loc (24 ticks measured for a 2x2 staircase).
        timeoutTicks: opts.legTimeoutTicks ?? 60,
        signal: opts.signal,
    });
}

export async function goTo(s: Walker, world: World, to: Tile, acct: Account, opts: WalkOptions = {}): Promise<Outcome> {
    const p = s.sdk.getState()?.player;
    if (!p) return { ok: false, reason: 'precondition', detail: 'no player state', ticks: 0 };
    const from = { x: p.worldX, z: p.worldZ, level: p.level };
    const r = world.route(from, to, acct);
    if (!r.ok) return { ok: false, reason: 'precondition', detail: `no route to ${to.x},${to.z},${to.level}`, ticks: 0 };
    // The router priced a detour around doors this account cannot pass, but bot.walkTo uses the SDK pathfinder,
    // which treats every door as open. Block those doors there too, for the area this route covers.
    const pts = [from, to, ...r.legs.flatMap(l => (l.kind === 'walk' ? [l.to] : [l.at, l.to]))];
    const MARGIN = 32;
    const minX = Math.min(...pts.map(t => t.x)) - MARGIN, maxX = Math.max(...pts.map(t => t.x)) + MARGIN;
    const minZ = Math.min(...pts.map(t => t.z)) - MARGIN, maxZ = Math.max(...pts.map(t => t.z)) + MARGIN;
    for (const d of world.blockedDoors(acct)) {
        if (d.x >= minX && d.x <= maxX && d.z >= minZ && d.z <= maxZ) s.sdk.blockDoorTemporarily?.(d.level, d.x, d.z, 600_000);
    }
    return walkRoute(s, r.legs, opts);
}

// ---- walkPath: walk through points the way a player clicks ahead on the minimap ----
// bot.walkTo clicks each path corner and waits until the bot is within 2 tiles of it. The bot then takes 1 step
// or none in that tick, and at a door it waits for the open, then 1 more tick (research/walking.md). walkPath
// decides on every tick: it clicks `look` tiles ahead along a precomputed path before the last click runs out,
// opens a shut door on the path with one loc click and clicks past it on the tick it opens, and clicks again
// after 1 tick with no step. It sends at most one input per tick.

export interface PathTile { x: number; z: number }
export interface PathPoint extends PathTile { tol?: number }
export interface PathLoc { x: number; z: number; id: number; optionsWithIndex?: { text: string; opIndex: number }[] }
export interface PathDeps {
    pos(): { x: number; z: number; level: number } | null;
    onTick(cb: () => void): () => void;
    ended?: Promise<unknown>;
    walk(x: number, z: number): unknown;
    interactLoc(loc: PathLoc, op: number): unknown;
    // Clicks the run button on (controls:com_5). Sent once, before the first walk click.
    runOn?(): unknown;
    locs(): PathLoc[];
    // Path corners from `from` to `to`, without `from` (the rs-sdk findLongPath format).
    plan(level: number, from: PathTile, to: PathTile): PathTile[];
}
export interface PathOptions {
    look?: number;          // tiles ahead to click (default 20; the client routes inside its 104x104 scene)
    reclickAt?: number;     // click again when this many tiles of the last click remain (default 6: 3 ticks running)
    maxTicks?: number;      // tick budget (default: path tiles + 60)
    stop?: () => boolean;   // checked on every tick (death, abort)
    log?: (msg: string) => void;
}
// `next` is the index of the first point the bot has not passed yet: a retry can start from points.slice(next).
export interface PathResult { ok: boolean; ticks: number; still: number; clicks: number; repaths: number; doors: number; next: number; detail?: string }

const d8 = (a: PathTile, b: PathTile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
const openOp = (l: PathLoc) => (l.optionsWithIndex ?? []).find(o => /^open$/i.test(o.text));

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

export function walkPath(deps: PathDeps, points: PathPoint[], opts: PathOptions = {}): Promise<PathResult> {
    const look = opts.look ?? 20;
    const reclickAt = opts.reclickAt ?? 6;
    const log = opts.log ?? (() => {});
    const res: PathResult = { ok: false, ticks: 0, still: 0, clicks: 0, repaths: 0, doors: 0, next: 0 };
    const start = deps.pos();
    const goal = points[points.length - 1];
    if (!start) return Promise.resolve({ ...res, detail: 'no position' });
    if (!goal) return Promise.resolve({ ...res, ok: true });
    const level = start.level;
    const goalTol = goal.tol ?? 2;

    // Path tiles through every point in order. seg[i] is the index of the point that tile i leads to.
    let tiles: PathTile[] = [];
    let seg: number[] = [];
    const build = (from: PathTile, firstPoint: number) => {
        tiles = []; seg = [];
        let cur = from;
        for (let k = firstPoint; k < points.length; k++) {
            // rs-sdk's collision map can call the bot's own tile blocked (seen: 2774,3228 beside the Brimhaven
            // customs officer gives 0 waypoints). Then take the straight line: the client routes each click itself.
            const corners = deps.plan(level, cur, points[k]!);
            const t = expandPath(cur, corners.length ? corners : [points[k]!]);
            for (const x of t) { tiles.push(x); seg.push(k); }
            if (t.length) cur = t[t.length - 1]!;
        }
    };
    build(start, 0);
    if (tiles.length === 0 && d8(start, goal) > goalTol) return Promise.resolve({ ...res, detail: `no path to ${goal.x},${goal.z}` });
    const maxTicks = opts.maxTicks ?? tiles.length + 60;

    let idx = -1;          // path tile nearest the bot
    let target = -1;       // path index of the last walk click
    let door: { loc: PathLoc; sentAt: number } | null = null;
    let last = { x: start.x, z: start.z };
    let still = 0;
    let ticks = 0;
    let ranOn = false;
    let sentThisTick = false;

    const nearest = (p: PathTile): { i: number; d: number } => {
        let best = { i: Math.max(0, idx), d: Infinity };
        const hi = Math.min(tiles.length - 1, Math.max(0, idx) + look * 2);
        for (let i = Math.max(0, idx); i <= hi; i++) {
            const d = d8(tiles[i]!, p);
            if (d <= best.d) best = { i, d };   // a tie goes forward
        }
        return best;
    };
    const shutDoorAhead = (from: number, to: number): PathLoc | null => {
        const ahead = new Map<string, number>();
        for (let i = Math.max(0, from); i <= Math.min(tiles.length - 1, to); i++) ahead.set(`${tiles[i]!.x},${tiles[i]!.z}`, i);
        let best: { l: PathLoc; i: number } | null = null;
        for (const l of deps.locs()) {
            const i = ahead.get(`${l.x},${l.z}`);
            if (i !== undefined && openOp(l) && (!best || i < best.i)) best = { l, i };
        }
        return best?.l ?? null;
    };
    const send = (what: string, f: () => unknown): boolean => {
        if (sentThisTick) return false;
        sentThisTick = true;
        try {
            const r = f() as { catch?: (h: () => void) => unknown } | undefined;
            if (r && typeof r.catch === 'function') r.catch(() => {});
        } catch { /* the next tick decides again */ }
        log(what);
        return true;
    };
    const clickAhead = (span: number) => {
        const i = Math.min(tiles.length - 1, Math.max(0, idx) + span);
        const t = tiles[i]!;
        if (send(`walk ${t.x},${t.z}`, () => deps.walk(t.x, t.z))) { target = i; res.clicks++; }
    };
    const replan = (p: PathTile, why: string): boolean => {
        build(p, seg[Math.max(0, idx)] ?? 0);
        idx = -1; target = -1; res.repaths++;
        log(`re-plan: ${why}`);
        if (tiles.length === 0) return false;
        idx = nearest(p).i;
        return true;
    };

    return new Promise<PathResult>(resolve => {
        let done = false;
        const finish = (ok: boolean, detail?: string) => {
            if (done) return;
            done = true;
            off();
            resolve({ ...res, ok, ticks, next: ok ? points.length : (seg[Math.max(0, idx)] ?? 0), detail });
        };
        const decide = () => {
            sentThisTick = false;
            const p = deps.pos();
            if (!p) return finish(false, 'no position');
            if (p.level !== level) return finish(false, `left level ${level}`);
            if (d8(p, goal) <= goalTol) return finish(true);
            if (opts.stop?.()) return finish(false, 'stopped');
            if (ticks > maxTicks) return finish(false, `budget ${maxTicks} ticks at ${p.x},${p.z}`);
            const moved = p.x !== last.x || p.z !== last.z;
            last = { x: p.x, z: p.z };
            still = moved ? 0 : still + 1;
            if (ticks > 0 && !moved) res.still++;

            // The run button does not count as the tick's input: the server takes 5 per tick, and it goes first.
            if (!ranOn && deps.runOn) { ranOn = true; send('run on', () => deps.runOn!()); sentThisTick = false; }

            const n = nearest(p);
            if (n.d > 3) {
                // Off the planned path (the client routed round something): plan again from here.
                if (!replan(p, `off path by ${n.d}`)) return finish(false, `no path from ${p.x},${p.z}`);
            } else idx = n.i;

            // A door the bot asked to open: click past it on the tick it opens.
            if (door) {
                const d = door;
                const shutNow = deps.locs().some(l => l.x === d.loc.x && l.z === d.loc.z && l.id === d.loc.id && openOp(l));
                if (!shutNow) { door = null; log('door open'); clickAhead(look); return; }
                // No step for 3 ticks and the door is still shut: click it again.
                if (still >= 3 && ticks - d.sentAt >= 3) door = null; else return;
            }
            const shut = shutDoorAhead(idx, idx + look);
            if (shut) {
                const op = openOp(shut)!.opIndex;
                if (send(`open ${shut.x},${shut.z} id${shut.id}`, () => deps.interactLoc(shut, op))) { door = { loc: shut, sentAt: ticks }; res.doors++; target = -1; }
                return;
            }
            // No tile gained for 2 ticks: plan again from where the bot stands.
            if (still >= 2) {
                if (!replan(p, `still ${still}`)) return finish(false, `no path from ${p.x},${p.z}`);
                // The client may have routed the bot to a shut door that is not on the path.
                const near = deps.locs().find(l => openOp(l) && d8(l, p) <= 1);
                if (still >= 4 && near) {
                    if (send(`open near ${near.x},${near.z}`, () => deps.interactLoc(near, openOp(near)!.opIndex))) { door = { loc: near, sentAt: ticks }; res.doors++; }
                    return;
                }
                clickAhead(still >= 3 ? Math.ceil(look / 2) : look);
                return;
            }
            if (still >= 1 || target < 0 || target - idx <= reclickAt) {
                // The last click already ends at the goal, and the bot is still moving toward it.
                if (target === tiles.length - 1 && still === 0) return;
                clickAhead(look);
            }
        };
        const off = deps.onTick(() => { ticks++; decide(); });
        void deps.ended?.then(() => finish(false, 'session ended'));
        decide();
    });
}

// PathDeps for an in-process session (packages/core/src/inprocess.ts). Inputs go straight to the client, not
// through the SDK action queue, so a click leaves on the tick it is decided.
export async function sessionWalker(s: { sdk: any; onTick(cb: () => void): () => void; direct(a: { type: string; [k: string]: unknown }): Promise<unknown>; ended?: Promise<unknown> }): Promise<PathDeps> {
    const pf: any = await import('../../../vendor/rs-sdk/sdk/pathfinding');
    return {
        pos: () => { const p = s.sdk.getState()?.player; return p ? { x: p.worldX, z: p.worldZ, level: p.level } : null; },
        onTick: cb => s.onTick(cb),
        ended: s.ended,
        walk: (x, z) => s.direct({ type: 'walkTo', x, z, running: true, reason: 'SDK' }),
        interactLoc: (l, op) => s.direct({ type: 'interactLoc', x: l.x, z: l.z, locId: l.id, optionIndex: op, reason: 'SDK' }),
        runOn: () => s.direct({ type: 'clickComponent', componentId: 153, reason: 'SDK' }),
        locs: () => s.sdk.getState()?.nearbyLocs ?? [],
        // The session's temporary door blocks (doors walkTo found locked) stay walls for this plan too.
        plan: (level, from, to) => pf.findLongPath(level, from.x, from.z, to.x, to.z, 500, s.sdk.temporaryDoorBlocks?.active?.() ?? []),
    };
}
