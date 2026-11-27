import { executionContext } from '../../../vendor/rs-sdk/sdk/execution-context';
import { atTile, checked, type Outcome } from './act';
import type { TickSource } from './ticks';
import type { Tile } from './world-types';

/** Session surface needed to walk or interact along a single route leg. */
export interface Walker extends TickSource {
    client?:unknown;
    sdk: TickSource['sdk'] & { blockDoorTemporarily?(level: number, x: number, z: number, ttlMs?: number): boolean };
    bot: {
        walkTo(x: number, z: number, tolerance?: number): Promise<unknown>;
        interactLoc(target: unknown, option?: number | string | RegExp): Promise<unknown>;
        openDoor?(target?: unknown): Promise<unknown>;
    };
}

// planBudgetMs bounds the route search (world.ts ROUTE_BUDGET_MS when absent); a search over budget is 'no route (budget)'.
// noFareFloat: the walk takes no fare float at its start bank (walk/fare-float.ts), for a worker that counts its pack.
// noHarmCheck: goTo does not price the route against the hunters along it (walk/harm.ts). noFoodStage: a walk that the
// harm check refuses takes no food from a bank first.
export interface WalkOptions { maxRetriesPerLeg?: number; legTimeoutTicks?: number; signal?: AbortSignal; planBudgetMs?: number; noJewelry?: boolean; noFareFloat?: boolean; noHarmCheck?: boolean; noFoodStage?: boolean; offPlanReplans?: number }

export const cheb = (a: Tile, b: { worldX: number; worldZ: number }) => Math.max(Math.abs(a.x - b.worldX), Math.abs(a.z - b.worldZ));

// Runs one leg's bot.* call inside its own SDK execution context (sdk/execution-context.ts). The context's
// signal fires when the leg's outcome is decided or the caller aborts (reflex), so a long bot.walkTo stops
// instead of fighting the flee walk.
export async function cancellable(opts: WalkOptions, leg: (send: (f: () => Promise<unknown>) => () => Promise<unknown>, signal: AbortSignal) => Promise<Outcome>): Promise<Outcome> {
    const ac = new AbortController();
    const parent = executionContext.getStore();
    const parents = [...new Set([opts.signal, parent?.signal].filter((s): s is AbortSignal => !!s))];
    const listeners = parents.map(signal => {
        const abort = () => ac.abort(signal.reason ?? 'aborted');
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
        return () => signal.removeEventListener('abort', abort);
    });
    const wrap = (f: () => Promise<unknown>) => () => executionContext.run({ ...parent, signal: ac.signal }, f).catch(e => ({ success: false, message: String(e) }));
    try {
        return await executionContext.run({ ...parent, signal: ac.signal }, () => leg(wrap, ac.signal));
    } finally {
        for (const off of listeners) off();
        if (!ac.signal.aborted) ac.abort('leg done');
    }
}

/** Walks one bounded single-plane leg inside its own cancellable execution context. */
export function walkLeg(s: Walker, to: Tile, opts: WalkOptions,tolerance:number): Promise<Outcome> {
    return cancellable(opts, (wrap, signal) => walkLegInner(s, to, { ...opts, signal }, wrap,tolerance));
}

function walkLegInner(s: Walker, to: Tile, opts: WalkOptions, wrap: (f: () => Promise<unknown>) => () => Promise<unknown>,tolerance:number): Promise<Outcome> {
    const p = s.sdk.getState()?.player;
    // A long walk keeps running inside walkTo, so the budget grows with distance.
    const budget = opts.legTimeoutTicks ?? (p ? cheb(to, p) * 2 + 30 : 60);
    return checked(s, {
        name: `walk to ${to.x},${to.z},${to.level}`,
        pre: st => (st?.player?.level === to.level ? null : `on level ${st?.player?.level}, leg is on level ${to.level}`),
        send: wrap(() => s.bot.walkTo(to.x, to.z, tolerance)),
        rejectOnFeedback: false,
        effect: atTile(to.x, to.z, to.level, tolerance),
        timeoutTicks: budget,
        signal: opts.signal,
    });
}
