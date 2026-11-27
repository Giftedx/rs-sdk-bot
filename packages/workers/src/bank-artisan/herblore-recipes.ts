// Herblore potion recipes and the choice of recipe from owned stock. No imports: the brain preflight
// (packages/brain/src/preflight.ts) and the worker preflight (./preflight.ts) read the same rule that the brew worker
// (./herblore.ts brew) runs, so a job that the worker would refuse for a missing herb or secondary is refused before login.

export type Stock = Record<number, number>;
export type BrewRecipe = { key: string; level: number; dirty: number; clean: number; unf: number; sec: number; pot: number };

// The secondary that the brew worker buys from a shop when the bank has none (herblore.ts buy): eye of newt.
export const BOUGHT_SECONDARY = 221;

export const RECIPES: Record<string, BrewRecipe> = Object.fromEntries(
    [
        ['attack', 3, 199, 249, 91, 221, 121],
        ['antipoison', 5, 201, 251, 93, 235, 175],
        ['strength', 12, 203, 253, 95, 225, 115],
        ['fishing', 50, 211, 261, 103, 231, 151],
        ['magic', 76, 2485, 2481, 2483, 3138, 3042],
        ['ranging', 72, 217, 267, 109, 245, 169],
        ['energy', 26, 205, 255, 97, 1975, 3010],
        ['prayer', 38, 207, 257, 99, 231, 139],
        ['super_attack', 45, 209, 259, 101, 221, 145],
        ['super_str', 55, 213, 263, 105, 225, 157],
        ['super_def', 66, 215, 265, 107, 239, 163],
    ].map(([key, level, dirty, clean, unf, sec, pot]) => [key, { key, level, dirty, clean, unf, sec, pot }]),
) as Record<string, BrewRecipe>;

const RECIPES_BY_LEVEL_DESC: readonly BrewRecipe[] = Object.values(RECIPES).sort((a, b) => b.level - a.level);

const ownsHerbs = (r: BrewRecipe, stock: Stock) => (stock[r.dirty] ?? 0) > 0 || (stock[r.clean] ?? 0) > 0 || (stock[r.unf] ?? 0) > 0;
const hasSecondary = (r: BrewRecipe, stock: Stock) => r.sec === BOUGHT_SECONDARY || (stock[r.sec] ?? 0) > 0;

// The recipe that a brew run makes next. `auto` takes the highest-level recipe whose herbs and secondary the stock
// holds (the worker buys eyes of newt); `unf` takes the highest-level recipe whose herbs the stock holds, as it needs
// no secondary; a named recipe needs its herbs only, and the brew loop names its missing secondary.
// Throws `secondary missing <id>` when owned herbs at the level have no secondary, and `herbs missing` without herbs.
export function selectRecipe(level: number, stock: Stock, key = 'auto'): BrewRecipe {
    if (key !== 'auto' && key !== 'unf') {
        const r = RECIPES[key];
        if (r && r.level <= level && ownsHerbs(r, stock)) return r;
        throw Error(`herbs missing: no usable owned herbs or unfinished potions for ${key} at level ${level}`);
    }
    let secondaryShort: BrewRecipe | undefined;
    for (const r of RECIPES_BY_LEVEL_DESC) {
        if (r.level > level || !ownsHerbs(r, stock)) continue;
        if (key === 'unf' || hasSecondary(r, stock)) return r;
        secondaryShort ??= r;
    }
    if (secondaryShort) throw Error(`secondary missing ${secondaryShort.sec}`);
    throw Error(`herbs missing: no usable owned herbs or unfinished potions for ${key} at level ${level}`);
}

// The item that a brew run at this level and stock lacks before it can make one potion, or undefined when it can.
// A missing secondary names that secondary; missing herbs name the grimy herb of the named recipe, or of the
// lowest-level recipe for `auto` and `unf`.
export function brewShortfall(level: number, stock: Stock, key = 'auto'): { itemId: number; reason: string } | undefined {
    try {
        const r = selectRecipe(level, stock, key);
        if (key === 'auto' || key === 'unf' || hasSecondary(r, stock)) return undefined;
        return { itemId: r.sec, reason: `secondary missing ${r.sec}` };
    } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        const secondary = /^secondary missing (\d+)$/.exec(reason);
        if (secondary) return { itemId: Number(secondary[1]), reason };
        const named = key !== 'auto' && key !== 'unf' ? RECIPES[key] : undefined;
        return { itemId: (named ?? RECIPES.attack!).dirty, reason };
    }
}

// The item ids whose stock decides brewShortfall: every herb, unfinished potion and secondary of the table.
export const BREW_STOCK_IDS: readonly number[] = [...new Set(Object.values(RECIPES).flatMap(r => [r.dirty, r.clean, r.unf, r.sec]))];
