// Armour counter-swap planner and nearest single-way Wilderness tile helper.
import type { CombatStyle } from '../../../core/src/opponent';
import type { CounterSwap } from '../../../core/src/pvp-threat';
import type { Bonus, Gear, Skill } from '../../../knowledge/src/gear';
import { canWear, loadGear, score } from '../../../knowledge/src/gear-query';

export const SWAP_SLOTS = ['hat', 'torso', 'legs', 'back', 'feet', 'hands'] as const;

export const DEFENCE_WEIGHTS: Record<CombatStyle, Partial<Record<Bonus, number>>> = {
    magic: { magicDefence: 1 },
    ranged: { rangeDefence: 1 },
    melee: { stabDefence: 1, slashDefence: 1, crushDefence: 1 },
};

export const MIN_SWAP_GAIN = 6;

let cache: Gear[] | undefined;
const gearOf = () => (cache ??= loadGear());

/** Selects carried armour swaps that improve defence against `style` by at least `minGain`. */
export function planCounterSwap(o: { worn: readonly number[]; pack: readonly number[]; style: CombatStyle; levels: Partial<Record<Skill, number>>; gear?: readonly Gear[]; minGain?: number }): CounterSwap | null {
    const gear = o.gear ?? gearOf(), byId = new Map(gear.map(g => [g.id, g]));
    const weights = DEFENCE_WEIGHTS[o.style], wear: number[] = [];
    let gain = 0;
    for (const slot of SWAP_SLOTS) {
        const now = o.worn.map(id => byId.get(id)).find(g => g?.slot === slot);
        const have = score(now ?? { bonuses: {} } as Gear, weights);
        let pick: Gear | undefined, pickScore = have;
        for (const id of o.pack) {
            const g = byId.get(id);
            if (!g || g.slot !== slot || g.staffOnly || !canWear(g, o.levels, null)) continue;
            const s = score(g, weights);
            if (s > pickScore) { pick = g; pickScore = s; }
        }
        if (pick) { wear.push(pick.id); gain += pickScore - have; }
    }
    return gain >= (o.minGain ?? MIN_SWAP_GAIN) ? { wear, gain } : null;
}

/** Returns original worn item IDs displaced by equipping `wear`. */
export function restoreFor(worn: readonly number[], wear: readonly number[], gear: readonly Gear[] = gearOf()): number[] {
    const byId = new Map(gear.map(g => [g.id, g]));
    const slots = new Set(wear.map(id => byId.get(id)?.slot));
    return worn.filter(id => slots.has(byId.get(id)?.slot));
}

type Wearer = { sdk: { getInventory(): { id: number; slot: number; optionsWithIndex: { text: string; opIndex: number }[] }[]; sendUseItem(slot: number, op: number): Promise<unknown> } };

/** Equips each item ID from inventory one tick at a time and returns IDs that failed. */
export async function wearIds(s: Wearer, ids: readonly number[], tick: () => Promise<boolean>): Promise<number[]> {
    const failed: number[] = [];
    for (const id of ids) {
        const item = s.sdk.getInventory().find(i => i.id === id), op = item?.optionsWithIndex.find(x => /^(wear|wield)$/i.test(x.text));
        if (!item || !op) { failed.push(id); continue; }
        await s.sdk.sendUseItem(item.slot, op.opIndex);
        if (!await tick()) break;
    }
    return failed;
}

/** Finds the nearest single-way Wilderness tile to `at`, preferring tiles farthest from `avoid`. */
export function nearestSingleWay(at: { x: number; z: number }, o: { multiAt: (x: number, z: number) => boolean; wildAt: (x: number, z: number) => number; avoid?: readonly { x: number; z: number }[]; radius?: number }): { x: number; z: number } | null {
    const far = (t: { x: number; z: number }) => Math.min(...(o.avoid?.length ? o.avoid : [at]).map(a => Math.max(Math.abs(a.x - t.x), Math.abs(a.z - t.z))));
    for (let r = 1; r <= (o.radius ?? 40); r++) {
        let best: { x: number; z: number } | null = null;
        for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
            const t = { x: at.x + dx, z: at.z + dz };
            if (o.wildAt(t.x, t.z) > 0 && !o.multiAt(t.x, t.z) && (!best || far(t) > far(best))) best = t;
        }
        if (best) return best;
    }
    return null;
}
