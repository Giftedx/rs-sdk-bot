import type { TickSource } from './ticks';
import type { Tile } from './world';

export interface ReflexRules { eatBelowHp: number; fleeBelowHp: number; foods: RegExp; safeTile: Tile }

export interface Reflexive extends TickSource {
    bot: {
        eatFood(target: RegExp): Promise<unknown>;
        walkTo(x: number, z: number, tolerance?: number): Promise<unknown>;
    };
}

// Missing Hitpoints state is unknown, not healthy: treat it as 0 so the reflex errs toward fleeing.
const hp = (st: any): number => (st?.skills ?? []).find((k: any) => k.name === 'Hitpoints')?.level ?? 0;
const hasFood = (st: any, re: RegExp): boolean => (st?.inventory ?? []).some((i: any) => re.test(i.name));

// Checked every tick. Eating comes first; with no food left and HP below the flee line, the signal aborts
// whatever checked action is running and the bot walks to the safe tile.
export function startReflexes(s: Reflexive, rules: ReflexRules): { stop(): void; aborted: AbortSignal } {
    const ac = new AbortController();
    let busy = false;
    let stopped = false;
    let off = () => {};
    const stop = () => { stopped = true; off(); };
    // Task isolation follows RuneLite Scheduler.run (BSD-2), rewritten for our
    // abort-driven consumers. A failed reflex must end their work, not escape
    // from a tick callback or restart silently on the following tick.
    const run = (name: string, action: () => Promise<unknown>) => {
        busy = true;
        void Promise.resolve().then(() => stopped ? undefined : action()).then(reply => {
            if (reply && typeof reply === 'object' && 'success' in reply && reply.success === false) {
                throw new Error('message' in reply ? String(reply.message) : 'action refused');
            }
        }).catch(error => {
            ac.abort(`reflex: ${name} failed (${String(error)})`);
            stop();
        }).finally(() => { busy = false; });
    };
    off = s.onTick(() => {
        if (stopped || busy) return;
        const st = s.sdk.getState();
        const h = hp(st);
        if (h < rules.eatBelowHp && hasFood(st, rules.foods)) {
            run('eat', () => s.bot.eatFood(rules.foods));
        } else if (h < rules.fleeBelowHp && !ac.signal.aborted) {
            ac.abort('reflex: low HP, no food');
            run('flee', () => s.bot.walkTo(rules.safeTile.x, rules.safeTile.z, 2));
        }
    });
    void s.ended?.then(stop);
    return { stop, aborted: ac.signal };
}
