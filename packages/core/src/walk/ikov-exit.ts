// Temple of Ikov Armadyl Guardian room / McGrubor's shack exit without Shiny key.
// A bot stranded at 2645,9893,0 without ikov_shinykey (85) cannot open ikov_shinykeydoor (2657,3496,0) after climbing
// ladder_from_cellar (2659,9892,0 -> 2659,3492,0). Pushing secretdoor2 (1586 at 2643,9892,0) opens the 41-tile corridor
// to the Shiny key floor spawn (maps/m41_154.jm2:8690, 2628,9859,0); picking it up unlocks the mainland exit.
import type { Account, Tile } from '../world';
import { waitTicks, waitUntil } from '../ticks';
import type { Walker } from '../walk-leg';
import { walkPath } from './path';
import { sessionWalker } from './session';

type Pos = { x: number; z: number; level: number };

export const IKOV_SECRET_DOOR = { id: 1586, x: 2643, z: 9892, level: 0 } as const;
export const IKOV_SHACK_LADDER_DOWN = { id: 1754, x: 2659, z: 3492, level: 0 } as const;
export const IKOV_SHINY_KEY_ID = 85;
export const IKOV_SHINY_KEY_TILE: Tile = { x: 2628, z: 9859, level: 0 };

export const inIkovArmadylPocket = (p: Pos): boolean =>
    p.level === 0 && p.x >= 2620 && p.x <= 2680 && p.z >= 9850 && p.z <= 9920;

export const inIkovShack = (p: Pos): boolean =>
    p.level === 0 && p.x >= 2657 && p.x <= 2661 && p.z >= 3491 && p.z <= 3495;

export function needsIkovShinyKeyExit(from: Tile, to: Tile, acct: Pick<Account, 'items'>): boolean {
    if (!(inIkovArmadylPocket(from) || inIkovShack(from))) return false;
    if (inIkovArmadylPocket(to) || inIkovShack(to)) return false;
    return !acct.items.includes('ikov_shinykey');
}

type IkovSession = Walker & {
    direct?(a: { type: string; [k: string]: unknown }): Promise<unknown>;
    bot: Walker['bot'] & {
        pickupItem?(target: unknown): Promise<{ success?: boolean }>;
    };
};

// 'none' when the account is not stranded in the Ikov pocket without a Shiny key, 'picked' when it now holds
// ikov_shinykey (85), 'stuck' when key acquisition did not complete.
export async function leaveIkovArmadyl(
    s: Walker,
    to: Tile,
    acct: Pick<Account, 'items'>,
    stop: () => boolean = () => false,
): Promise<'none' | 'picked' | 'stuck'> {
    const sess = s as IkovSession;
    const pos = (): Pos | null => {
        const p = s.sdk.getState()?.player;
        return p ? { x: p.worldX, z: p.worldZ, level: p.level } : null;
    };
    const start = pos();
    if (!start || !needsIkovShinyKeyExit(start, to, acct)) return 'none';
    const inv = (): readonly { id: number }[] => (s.sdk.getState()?.inventory ?? []) as { id: number }[];
    const hasKey = () => inv().some(i => i.id === IKOV_SHINY_KEY_ID);
    if (hasKey()) return 'picked';
    if (inv().length >= 28 || typeof sess.direct !== 'function') return 'stuck';

    const done = (r: 'picked' | 'stuck', why: string) => {
        const p = pos();
        console.log(`WALK_IKOV_KEY from=${start.x},${start.z},${start.level} ${r} at=${p?.x},${p?.z} ${why}`);
        return r;
    };

    const moveTo = async (goal: Tile, tol = 1): Promise<boolean> => {
        const p = pos();
        if (!p || p.level !== goal.level) return false;
        if (Math.max(Math.abs(p.x - goal.x), Math.abs(p.z - goal.z)) <= tol) return true;
        if (sess.client) {
            try {
                const deps = await sessionWalker(sess as unknown as Parameters<typeof sessionWalker>[0], { noFareFloat: true });
                const r = await walkPath(deps, [{ x: goal.x, z: goal.z, tol }], { maxTicks: 160, stop });
                if (r.ok) return true;
            } catch {
                // Fall back to direct walkTo when route-worker/pathfinder adapter is unavailable.
            }
        }
        await s.bot.walkTo(goal.x, goal.z, tol);
        const after = pos();
        return !!after && after.level === goal.level && Math.max(Math.abs(after.x - goal.x), Math.abs(after.z - goal.z)) <= tol;
    };

    // Inside McGrubor's shack without the key: descend ladder_cellar (1754 at 2659,3492) to the dungeon first.
    if (inIkovShack(start)) {
        for (let i = 0; i < 3 && !stop() && inIkovShack(pos() ?? start); i++) {
            await sess.direct({ type: 'interactLoc', x: IKOV_SHACK_LADDER_DOWN.x, z: IKOV_SHACK_LADDER_DOWN.z, locId: IKOV_SHACK_LADDER_DOWN.id, optionIndex: 1, reason: 'SDK' });
            await waitUntil(s, () => stop() || inIkovArmadylPocket(pos() ?? start), { timeoutTicks: 10 });
        }
        if (!inIkovArmadylPocket(pos() ?? start)) return done('stuck', 'shack ladder descent unobserved');
    }

    // Inside the Armadyl Guardian room (z >= 9893): push secretdoor2 (1586 at 2643,9892) south into the corridor.
    const cur = pos();
    if (cur && cur.z >= 9893) {
        await moveTo({ x: 2643, z: 9893, level: 0 }, 1);
        for (let i = 0; i < 4 && !stop() && (pos()?.z ?? 9893) >= 9893; i++) {
            await sess.direct({ type: 'interactLoc', x: IKOV_SECRET_DOOR.x, z: IKOV_SECRET_DOOR.z, locId: IKOV_SECRET_DOOR.id, optionIndex: 1, reason: 'SDK' });
            await waitUntil(s, () => stop() || (pos()?.z ?? 9893) <= 9892, { timeoutTicks: 8 });
        }
        if ((pos()?.z ?? 9893) >= 9893) return done('stuck', 'secretdoor2 exit unobserved');
    }

    if (!(await moveTo(IKOV_SHINY_KEY_TILE, 2))) return done('stuck', 'shiny key room unreachable');

    // Wait for the Shiny key ground spawn at 2628,9859 and pick it up.
    const findKey = () => ((s.sdk.getState()?.groundItems ?? []) as { id: number; x: number; z: number }[])
        .find(g => g.id === IKOV_SHINY_KEY_ID && Math.max(Math.abs(g.x - IKOV_SHINY_KEY_TILE.x), Math.abs(g.z - IKOV_SHINY_KEY_TILE.z)) <= 3);

    for (let attempt = 0; attempt < 3 && !stop() && !hasKey(); attempt++) {
        if (!findKey()) await waitUntil(s, () => stop() || !!findKey(), { timeoutTicks: 40 });
        const item = findKey();
        if (!item) break;
        if (typeof sess.bot.pickupItem === 'function') {
            await sess.bot.pickupItem(item);
        } else {
            await sess.direct({ type: 'pickupItem', x: item.x, z: item.z, itemId: item.id, reason: 'SDK' });
            await waitUntil(s, () => stop() || hasKey(), { timeoutTicks: 10 });
        }
        if (!hasKey()) await waitTicks(s, 1);
    }
    return hasKey() ? done('picked', 'shiny key held') : done('stuck', 'shiny key pickup unobserved');
}
