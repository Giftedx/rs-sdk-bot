// The armour swap and the single-way tile of the threat radar (packages/core/src/pvp-threat.ts decideAdapt).
// The swap picks, for each armour slot, the item of the pack that has a better defence bonus against the style of the threat than the worn
// one (knowledge/gear.json, scripts/gear.ts: a mage is met with the magic defence, an archer with the ranged defence, a melee player with
// the three melee defences). It wears only what the account's levels allow and what the pack holds: a squad with no spare armour has no swap.
import type { CombatStyle } from '../packages/core/src/opponent';
import type { CounterSwap } from '../packages/core/src/pvp-threat';
import type { Bonus, Gear, Skill } from '../packages/knowledge/src/gear';
import { canWear, loadGear, score } from './gear';

// Slots the swap may change. The weapon, the shield (a two-handed weapon covers it), the ring and the ammunition are not armour for this.
export const SWAP_SLOTS = ['hat', 'torso', 'legs', 'back', 'feet', 'hands'] as const;
// The bonuses that count against each style of attacker.
export const DEFENCE_WEIGHTS: Record<CombatStyle, Partial<Record<Bonus, number>>> = {
    magic: { magicDefence: 1 },
    ranged: { rangeDefence: 1 },
    melee: { stabDefence: 1, slashDefence: 1, crushDefence: 1 },
};
// A swap must gain at least this much defence bonus over the slots together, or it is not worth the tick.
export const MIN_SWAP_GAIN = 6;

let cache: Gear[] | undefined;
const gearOf = () => (cache ??= loadGear());

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

// The worn items that a swap takes off: the ones in the slots of `wear`, so that wearing them again undoes the swap.
export function restoreFor(worn: readonly number[], wear: readonly number[], gear: readonly Gear[] = gearOf()): number[] {
    const byId = new Map(gear.map(g => [g.id, g]));
    const slots = new Set(wear.map(id => byId.get(id)?.slot));
    return worn.filter(id => slots.has(byId.get(id)?.slot));
}

type Wearer = { sdk: { getInventory(): { id: number; slot: number; optionsWithIndex: { text: string; opIndex: number }[] }[]; sendUseItem(slot: number, op: number): Promise<unknown> } };
// Wears each of `ids` from the pack (its Wear or Wield option), one input and one tick each. Returns the ids that it could not wear.
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

// The nearest single-way Wilderness tile to `at`, searched ring by ring up to `radius` tiles; among the tiles of the first ring that has any,
// the one farthest from the tiles to avoid (the threats). Null when none. Whether a path reaches it is the walker's to say.
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
