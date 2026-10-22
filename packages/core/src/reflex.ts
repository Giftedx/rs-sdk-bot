import type { TickSource } from './ticks';
import type { Tile } from './world';

export interface ReflexRules { eatBelowHp: number; fleeBelowHp: number; foods: RegExp; safeTile: Tile }

export interface Reflexive extends TickSource {
    bot: {
        eatFood(target: RegExp): Promise<unknown>;
        walkTo(x: number, z: number, tolerance?: number): Promise<unknown>;
    };
}

const hp = (st: any): number => (st?.skills ?? []).find((k: any) => k.name === 'Hitpoints')?.level ?? 99;
const hasFood = (st: any, re: RegExp): boolean => (st?.inventory ?? []).some((i: any) => re.test(i.name));

// Checked every tick. Eating comes first; with no food left and HP below the flee line, the signal aborts
// whatever checked action is running and the bot walks to the safe tile.
export function startReflexes(s: Reflexive, rules: ReflexRules): { stop(): void; aborted: AbortSignal } {
    const ac = new AbortController();
    let busy = false;
    const off = s.onTick(() => {
        if (busy) return;
        const st = s.sdk.getState();
        const h = hp(st);
        if (h < rules.eatBelowHp && hasFood(st, rules.foods)) {
            busy = true;
            void s.bot.eatFood(rules.foods).finally(() => { busy = false; });
        } else if (h < rules.fleeBelowHp && !ac.signal.aborted) {
            ac.abort('reflex: low HP, no food');
            busy = true;
            void s.bot.walkTo(rules.safeTile.x, rules.safeTile.z, 2).finally(() => { busy = false; });
        }
    });
    return { stop: off, aborted: ac.signal };
}
