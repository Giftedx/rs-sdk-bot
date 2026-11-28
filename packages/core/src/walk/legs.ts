// Ordered route leg execution: bounded walk legs, long walkPath legs, transport climbs, and travel edges.
import { atTile, checked, levelIs, type Outcome } from '../act';
import { accountForSdk } from '../door-policy';
import { waitTicks } from '../ticks';
import { cancellable, cheb, walkLeg, type WalkOptions, type Walker } from '../walk-leg';
import { canonicalTransportLeg, interactionApproach, transportAllowed, type Leg, type Tile } from '../world';
import { walkPath } from './path';

export type { WalkOptions, Walker } from '../walk-leg';

// A long walk leg (a world-graph region can span hundreds of tiles) goes through walkPath: one findLongPath plan,
// then 20-tile client clicks. bot.walkTo re-queries a 500-waypoint path every step, which used 183 s of CPU on an
// Ardougne-to-Varrock leg and froze the session ('walk to 2897,3428,0: no effect in 100 ticks').
export const FAR_WALK_TILES = 30;

// Runs route legs in order. Each leg is a checked action; a leg is retried from wherever the bot really is,
// so a non-exact arrival (Review Focus 4) just becomes the next leg's start.
export async function walkRoute(s: Walker, legs: Leg[], opts: WalkOptions = {}): Promise<Outcome> {
    const start = s.tick();
    return cancellable(opts, async (_wrap, signal) => {
        try { return await walkRouteInner(s, legs, { ...opts, signal }); }
        catch (error) {
            if (signal.aborted) return { ok: false, reason: 'aborted', detail: String(signal.reason ?? 'aborted'), ticks: s.tick() - start };
            throw error;
        }
    });
}

async function walkRouteInner(s: Walker, legs: Leg[], opts: WalkOptions): Promise<Outcome> {
    const retries = opts.maxRetriesPerLeg ?? 3;
    let total = 0;
    for (let li = 0; li < legs.length; li++) {
        const leg = legs[li]!;
        // Coalesce consecutive same-plane walk legs that exceed FAR_WALK_TILES into one continuous multi-point
        // walkPath run, eliminating stop/start dead ticks and duplicate sessionWalker setup between segments.
        if (leg.kind === 'walk' && typeof (s as { direct?: unknown }).direct === 'function') {
            let end = li;
            const p = s.sdk.getState()?.player;
            let span = p && p.level === leg.to.level ? cheb(leg.to, p) : 0;
            while (end + 1 < legs.length && legs[end + 1]!.kind === 'walk' && (legs[end + 1] as Extract<Leg, { kind: 'walk' }>).to.level === leg.to.level) {
                const prev = (legs[end] as Extract<Leg, { kind: 'walk' }>).to;
                const next = (legs[end + 1] as Extract<Leg, { kind: 'walk' }>).to;
                span += Math.max(Math.abs(next.x - prev.x), Math.abs(next.z - prev.z));
                end++;
            }
            if (end > li && p && p.level === leg.to.level && span > FAR_WALK_TILES) {
                const chain = legs.slice(li, end + 1) as Extract<Leg, { kind: 'walk' }>[];
                const points = chain.map(w => ({ x: w.to.x, z: w.to.z, tol: w.tolerance ?? 2 }));
                let last: Outcome | null = null;
                let nextIdx = 0;
                for (let attempt = 0; attempt < retries; attempt++) {
                    const r = await walkFarPoints(s, points.slice(nextIdx), leg.to.level, opts);
                    last = r.outcome;
                    total += last.ticks;
                    if (last.ok || last.reason === 'aborted' || opts.signal?.aborted) break;
                    nextIdx = Math.min(points.length - 1, nextIdx + r.next);
                    if (last.reason === 'rejected') await waitTicks(s, 2 * (attempt + 1));
                    if (opts.signal?.aborted) break;
                }
                if (!last!.ok) return opts.signal?.aborted ? { ok: false, reason: 'aborted', detail: String(opts.signal.reason ?? 'aborted'), ticks: total } : { ...last!, ticks: total };
                li = end;
                continue;
            }
        }
        let last: Outcome | null = null;
        for (let attempt = 0; attempt < retries; attempt++) {
            last = leg.kind === 'walk' ? await (farWalk(s, leg.to) ? walkFar(s, leg.to, opts, leg.tolerance ?? 2) : walkLeg(s, leg.to, opts, leg.tolerance ?? 2))
                : leg.kind === 'travel' ? await (await import('./travel')).travelLeg(s, leg, opts) : await climbLeg(s, leg, opts);
            total += last.ticks;
            if (last.ok || last.reason === 'aborted' || opts.signal?.aborted || leg.kind === 'travel' && leg.travel.run.how === 'npc' && leg.travel.run.button) break;
            // Right after a climb the server refuses movement until the arrival delay ends (seen live: 3 quick
            // retries all refused within 11 ticks). Wait a little longer before each retry.
            if (last.reason === 'rejected') await waitTicks(s, 2 * (attempt + 1));
            if (opts.signal?.aborted) break;
            // rs-sdk's pathfinder treats every door as open, so a walk can stop behind a shut one and the
            // client then refuses the climb with "Can't reach". Open the shut door nearest the stair and retry.
            if (leg.kind === 'transport' && last.reason === 'rejected' && /reach/i.test(last.detail)) {
                await openNearestDoor(s, leg.at);
                // walkTo opens doors on its own route, which covers a shut door outside the 8-tile search.
                await s.bot.walkTo(leg.at.x, leg.at.z, 1);
            }
        }
        if (!last!.ok) return opts.signal?.aborted ? { ok: false, reason: 'aborted', detail: String(opts.signal.reason ?? 'aborted'), ticks: total } : { ...last!, ticks: total };
        // An edge with several landings (travel.ts pocketExitTravel) that ended on another one than the plan's: the
        // legs after it start from the wrong place, so the walk stops and goTo plans again from where it stands. As the
        // last leg it must end within 2 tiles of the plan's landing (the essence mine exit's map_findsquare radius).
        const p = leg.kind === 'travel' && leg.travel.lands?.length ? s.sdk.getState()?.player : undefined;
        if (p && leg.kind === 'travel' && (p.level !== leg.to.level || cheb(leg.to, p) > (legs[legs.length - 1] === leg ? 2 : 8))) {
            return { ok: false, reason: 'precondition', detail: `${leg.travel.name}: landed at ${p.worldX},${p.worldZ},${p.level}, off the plan`, ticks: total, offPlan: true };
        }
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

function farWalk(s: Walker, to: Tile): boolean {
    const p = s.sdk.getState()?.player;
    return !!p && p.level === to.level && cheb(to, p) > FAR_WALK_TILES && typeof (s as { direct?: unknown }).direct === 'function';
}

async function walkFarPoints(s: Walker, points: { x: number; z: number; tol: number }[], level: number, opts: WalkOptions): Promise<{ outcome: Outcome; next: number }> {
    const start = s.tick(), p = s.sdk.getState()?.player;
    let dist = 0, cur = p ? { x: p.worldX, z: p.worldZ } : points[0]!;
    for (const pt of points) { dist += Math.max(Math.abs(pt.x - cur.x), Math.abs(pt.z - cur.z)); cur = pt; }
    const budget = Math.max(opts.legTimeoutTicks ?? 0, dist * 3 + 60);
    const { sessionWalker } = await import('./session');
    // goTo took the fare float before it planned; a leg of its route takes none.
    const deps = await sessionWalker(s as unknown as Parameters<typeof sessionWalker>[0], { noFareFloat: true });
    const r = await walkPath(deps, points, { maxTicks: budget, signal: opts.signal });
    const goal = points[points.length - 1]!;
    return {
        outcome: r.ok ? { ok: true, ticks: s.tick() - start }
            : { ok: false, reason: opts.signal?.aborted ? 'aborted' : 'timeout', detail: `far walk to ${goal.x},${goal.z},${level}: ${r.detail ?? 'not arrived'}`, ticks: s.tick() - start },
        next: r.next,
    };
}

async function walkFar(s: Walker, to: Tile, opts: WalkOptions, tolerance: number): Promise<Outcome> {
    return (await walkFarPoints(s, [{ x: to.x, z: to.z, tol: tolerance }], to.level, opts)).outcome;
}

function climbLeg(s: Walker, leg: Extract<Leg, { kind: 'transport' }>, opts: WalkOptions): Promise<Outcome> {
    const canonical = canonicalTransportLeg(leg);
    if (!canonical) return Promise.resolve({ ok: false, reason: 'precondition', detail: 'legacy transport destination does not match its canonical physical route', ticks: 0 });
    return cancellable(opts, (wrap, signal) => climbLegInner(s, canonical, { ...opts, signal }, wrap));
}

function climbLegInner(s: Walker, leg: Extract<Leg, { kind: 'transport' }>, opts: WalkOptions, wrap: (f: () => Promise<unknown>) => () => Promise<unknown>): Promise<Outcome> {
    const findLoc = (st: any) => (st?.nearbyLocs ?? []).find((l: any) => l.x === leg.at.x && l.z === leg.at.z && l.level === leg.at.level && (!leg.interaction || l.id === leg.interaction.id));
    const arrive = atTile(leg.to.x, leg.to.z, leg.to.level, leg.exact ? 0 : 3);
    const onLevel = levelIs(leg.to.level);
    return checked(s, {
        name: `${leg.loc} ${leg.option} at ${leg.at.x},${leg.at.z},${leg.at.level}`,
        pre: st => leg.interaction && st?.player?.level !== leg.at.level ? 'transport is on another plane' : !transportAllowed(leg, accountForSdk(s.sdk)) ? 'transport prerequisites not observed' : leg.entry && (st?.player?.worldX !== leg.entry.x || st?.player?.worldZ !== leg.entry.z || st?.player?.level !== leg.entry.level) ? 'not at required transport entry' : (findLoc(st) ? null : `no loc at ${leg.at.x},${leg.at.z},${leg.at.level}`),
        send: wrap(async () => {
            const op = Number(leg.option.replace(/^op/, ''));
            let reply: unknown;
            if (leg.interaction && !leg.entry) {
                const endpoint = await interactionApproach(s.sdk, leg.at, leg.interaction);
                if (opts.signal?.aborted) return { success: false, message: 'transport approach cancelled' };
                if (!endpoint) return { success: false, message: 'no operable transport approach' };
                const atEndpoint = () => { const p = s.sdk.getState()?.player; return p?.level === endpoint.level && p.worldX === endpoint.x && p.worldZ === endpoint.z; };
                if (!atEndpoint()) {
                    const moved = await walkLeg(s, endpoint, opts, 0);
                    if (!moved.ok) return { success: false, message: `transport approach failed: ${moved.detail ?? moved.reason}` };
                }
                if (opts.signal?.aborted) return { success: false, message: 'transport approach cancelled' };
                const fresh = await interactionApproach(s.sdk, leg.at, leg.interaction), state = s.sdk.getState(), p = state?.player;
                if (opts.signal?.aborted) return { success: false, message: 'transport approach cancelled' };
                if (!fresh || !p || p.level !== fresh.level || p.worldX !== fresh.x || p.worldZ !== fresh.z || !findLoc(state) || !transportAllowed(leg, accountForSdk(s.sdk))) return { success: false, message: 'transport approach or prerequisites changed' };
                const send = (s.sdk as any).sendInteractLoc;
                if (typeof send !== 'function') return { success: false, message: 'geometry transport dispatch unavailable' };
                // BotActions pre-walks toward the anchor when its distance>2,
                // which can leave the only allowed face of a large staircase.
                reply = await send.call(s.sdk, leg.at.x, leg.at.z, leg.interaction.id, op);
            } else reply = await s.bot.interactLoc(findLoc(s.sdk.getState()), op);
            const r = reply as { success?: boolean; reason?: string; message?: string } | null;
            // The SDK's idle grace can end before a stair transition is published.
            // Its generic map-flag rejection has the same ambiguity. Neither proves refusal.
            const pending = r?.success === false && (
                (r.reason === 'timeout' && /^(Nothing happened|Timed out) interacting with /i.test(r.message ?? '')) ||
                (r.reason === 'rejected' && /^Server discarded the interaction with /i.test(r.message ?? '')));
            return pending ? undefined : reply;
        }),
        // Arrival also clears the map flag. Only the requested floor AND landing prove this leg.
        rejectOnFeedback: false,
        effect: (b, n) => leg.landing ? !!n?.player && n.player.level === leg.landing.level && n.player.worldX >= leg.landing.minX && n.player.worldX <= leg.landing.maxX && n.player.worldZ >= leg.landing.minZ && n.player.worldZ <= leg.landing.maxZ : onLevel(b, n) && arrive(b, n),
        // interactLoc first walks round to a usable side of the loc (24 ticks measured for a 2x2 staircase).
        timeoutTicks: opts.legTimeoutTicks ?? 60,
        signal: opts.signal,
    });
}
