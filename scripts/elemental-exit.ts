// Leaves the Elemental Workshop basement and odd-wall stairwell on foot for Seers' Village bank.
import type { Outcome } from '../packages/core/src/act';
import type { Session } from '../packages/core/src/inprocess';
import { waitUntil } from '../packages/core/src/ticks';
import { sessionWalker, walkPath } from '../packages/core/src/walk';

export const ELEMENTAL_STAIRS_UP = { id: 3416, x: 2716, z: 9888 };
export const ELEMENTAL_ODD_WALL = { id: 3391, x: 2709, z: 3495 };
export const SEERS_BANK = { x: 2725, z: 3492, level: 0 };

type Pos = { worldX: number; worldZ: number; level?: number } | null | undefined;
export function inElementalBasement(p: Pos): boolean {
    return !!p && (p.level ?? 0) === 0 && p.worldX >= 2700 && p.worldX <= 2745 && p.worldZ >= 9860 && p.worldZ <= 9915;
}
export function inElementalStairwell(p: Pos): boolean {
    return !!p && (p.level ?? 0) === 0 && p.worldX >= 2708 && p.worldX <= 2712 && p.worldZ >= 3496 && p.worldZ <= 3499;
}
export function inElementalWorkshop(p: Pos): boolean {
    return inElementalBasement(p) || inElementalStairwell(p);
}

export interface ElementalExitOps {
    walkToStairs?: (s: Session) => Promise<void>;
    interact?: (s: Session, loc: any, option: number | RegExp) => Promise<unknown>;
    wait?: (s: Session, pred: () => boolean, timeoutTicks: number) => Promise<boolean>;
}

const nearbyLoc = (s: Session, match: (l: any) => boolean) =>
    (s.sdk.getState()?.nearbyLocs ?? []).filter(match).sort((a: any, b: any) => (a.distance ?? 0) - (b.distance ?? 0))[0];

export async function leaveElementalWorkshop(s: Session, stop: () => boolean = () => false, ops: ElementalExitOps = {}): Promise<Outcome | null> {
    const pos = () => s.sdk.getState()?.player;
    if (!inElementalWorkshop(pos())) return null;
    const start = s.tick?.() ?? 0;
    const elapsed = () => Math.max(0, (s.tick?.() ?? start) - start);
    const interact = ops.interact ?? ((sess, loc, option) => sess.bot.interactLoc(loc, option));
    const wait = ops.wait ?? ((sess, pred, timeoutTicks) => waitUntil(sess, () => stop() || pred(), { timeoutTicks }));
    const walkToStairs = ops.walkToStairs ?? (async sess => {
        await walkPath(await sessionWalker(sess), [{ x: ELEMENTAL_STAIRS_UP.x, z: ELEMENTAL_STAIRS_UP.z, tol: 2 }], { maxTicks: 60 });
    });
    const fail = (detail: string): Outcome => ({ ok: false, reason: stop() ? 'aborted' : 'precondition', detail, ticks: elapsed() });

    if (inElementalBasement(pos())) {
        let stairs = nearbyLoc(s, l => l.id === ELEMENTAL_STAIRS_UP.id || (/stair/i.test(l.name ?? '') && l.z >= 9880));
        if (!stairs) {
            await walkToStairs(s);
            if (stop()) return fail('stopped walking to Elemental Workshop stairs');
            stairs = nearbyLoc(s, l => l.id === ELEMENTAL_STAIRS_UP.id || (/stair/i.test(l.name ?? '') && l.z >= 9880));
        }
        for (let i = 0; i < 4 && inElementalBasement(pos()) && !stop(); i++) {
            const target = nearbyLoc(s, l => l.id === ELEMENTAL_STAIRS_UP.id || (/stair/i.test(l.name ?? '') && l.z >= 9880)) ?? stairs;
            if (!target) break;
            await interact(s, target, 1);
            await wait(s, () => !inElementalBasement(pos()), 10);
        }
        if (inElementalBasement(pos())) return fail('failed to climb Elemental Workshop stairs');
    }

    if (inElementalStairwell(pos())) {
        for (let i = 0; i < 4 && inElementalStairwell(pos()) && !stop(); i++) {
            const wall = nearbyLoc(s, l => l.id === ELEMENTAL_ODD_WALL.id || l.id === 3390 || (/odd looking wall/i.test(l.name ?? '') && l.z === ELEMENTAL_ODD_WALL.z));
            if (!wall) break;
            await interact(s, wall, 1);
            await wait(s, () => (pos()?.worldZ ?? 9999) <= ELEMENTAL_ODD_WALL.z, 10);
        }
        if (inElementalStairwell(pos())) return fail('failed to push Elemental Workshop exit wall');
    }

    return stop() ? fail('stopped during Elemental Workshop exit') : { ok: true, ticks: elapsed() };
}
