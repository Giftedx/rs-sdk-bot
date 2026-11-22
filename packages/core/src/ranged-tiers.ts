import type { Gear } from '../../knowledge/src/gear';
import { loadGear } from '../../knowledge/src/gear-query';

const STANDARD_ARROW_RE = /^(bronze|iron|steel|mithril|adamant|rune)_arrow(_p)?$/;
const STANDARD_BOW_RE =
    /^(shortbow|longbow|oak_shortbow|oak_longbow|willow_shortbow|willow_longbow|maple_shortbow|maple_longbow|yew_shortbow|yew_longbow|magic_shortbow|magic_longbow)$/;

let cachedGear: readonly Gear[] | undefined;
function gearList(): readonly Gear[] {
    return (cachedGear ??= loadGear());
}

export function standardBowTiers(): { level: number; ids: number[] }[] {
    const byLevel = new Map<number, Gear[]>();
    for (const g of gearList()) {
        if (g.slot !== 'righthand' || !STANDARD_BOW_RE.test(g.debugname)) continue;
        const level = g.requires.skills.ranged ?? 1;
        byLevel.set(level, [...(byLevel.get(level) ?? []), g]);
    }
    return [...byLevel]
        .sort((a, b) => b[0] - a[0])
        .map(([level, bows]) => ({
            level,
            ids: bows.sort((a, b) => (a.attackRate ?? 4) - (b.attackRate ?? 4) || a.id - b.id).map((g) => g.id),
        }));
}

export function standardArrowTiers(): { level: number; id: number; strength: number }[] {
    return gearList()
        .filter((g) => g.slot === 'quiver' && STANDARD_ARROW_RE.test(g.debugname) && !g.debugname.endsWith('_p'))
        .sort((a, b) => b.bonuses.rangeStrength - a.bonuses.rangeStrength || a.id - b.id)
        .map((g) => ({ level: g.tier ?? 1, id: g.id, strength: g.bonuses.rangeStrength }));
}

export const GIANT_BOWS: readonly { level: number; ids: readonly number[] }[] = standardBowTiers();
export const GIANT_ARROWS: readonly { level: number; id: number }[] = standardArrowTiers().map(({ level, id }) => ({ level, id }));
export const GIANT_AMMO_RUN = 50;

const stockOf = (stock: readonly { id: number; count: number }[], id: number) =>
    stock.filter((i) => i.id === id).reduce((n, i) => n + i.count, 0);

export function selectGiantBow(stock: readonly { id: number; count: number }[], ranged: number) {
    for (const tier of GIANT_BOWS) {
        if (tier.level <= ranged) {
            for (const id of tier.ids) if (stockOf(stock, id) > 0) return { id, level: tier.level };
        }
    }
    return undefined;
}

export function selectGiantArrows(stock: readonly { id: number; count: number }[], ranged: number, bowLevel: number) {
    const fires = GIANT_ARROWS.filter((a) => a.level <= Math.min(ranged, bowLevel) && stockOf(stock, a.id) > 0);
    return (fires.find((a) => stockOf(stock, a.id) >= GIANT_AMMO_RUN) ?? [...fires].sort((a, b) => stockOf(stock, b.id) - stockOf(stock, a.id))[0])?.id;
}
