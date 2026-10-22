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
