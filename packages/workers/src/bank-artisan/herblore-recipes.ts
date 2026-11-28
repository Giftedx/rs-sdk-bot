// Herblore potion recipes and the choice of recipe from owned stock. No imports: the brain preflight
// (packages/brain/src/preflight.ts) and the worker preflight (./preflight.ts) read the same rule that the brew worker
// (./herblore.ts brew) runs, so a job that the worker would refuse for a missing herb or secondary is refused before login.

export type Stock = Record<number, number>;
export type BrewRecipe = { key: string; level: number; dirty: number; clean: number; unf: number; sec: number; pot: number };

// The secondary that the brew worker buys from a shop when the bank has none (herblore.ts buy): eye of newt.
export const BOUGHT_SECONDARY = 221;
export const PESTLE_AND_MORTAR = 233;

// Grindable secondaries (verified against vendor/rs-sdk/server/content/pack/obj.pack & grindables.obj):
// unicorn_horn (237) -> unicorn_horn_dust (235), chocolate_bar (1973) -> chocolate_dust (1975),
// blue_dragon_scale (243) -> dragon_scale_dust (241).
export const GRINDABLE_SECONDARIES: Readonly<Record<number, { raw: number; tool: number }>> = {
    235: { raw: 237, tool: PESTLE_AND_MORTAR },
    1975: { raw: 1973, tool: PESTLE_AND_MORTAR },
    241: { raw: 243, tool: PESTLE_AND_MORTAR },
};

export const RECIPES: Record<string, BrewRecipe> = Object.fromEntries(
    [
        ['attack', 3, 199, 249, 91, 221, 121],
        ['antipoison', 5, 201, 251, 93, 235, 175],
        ['strength', 12, 203, 253, 95, 225, 115],
        ['energy', 26, 205, 255, 97, 1975, 3010],
        ['prayer', 38, 207, 257, 99, 231, 139],
        ['super_attack', 45, 209, 259, 101, 221, 145],
        ['super_antipoison', 48, 209, 259, 101, 235, 181],
        ['fishing', 50, 211, 261, 103, 231, 151],
        ['super_str', 55, 213, 263, 105, 225, 157],
        ['weapon_poison', 60, 213, 263, 105, 241, 187],
        ['super_def', 66, 215, 265, 107, 239, 163],
        ['ranging', 72, 217, 267, 109, 245, 169],
        ['magic', 76, 2485, 2481, 2483, 3138, 3042],
    ].map(([key, level, dirty, clean, unf, sec, pot]) => [key, { key, level, dirty, clean, unf, sec, pot }]),
) as Record<string, BrewRecipe>;

export const PVP_POTION_KEYS = [
    'antipoison',
    'super_antipoison',
    'prayer',
    'super_attack',
    'super_str',
    'weapon_poison',
    'super_def',
    'ranging',
] as const;

export type DecantFamily = { key: string; dose4: number; dose3: number; dose2: number; dose1: number };

// Pinned 4/3/2/1-dose IDs for core PvP potions (vendor/rs-sdk/server/content/pack/obj.pack).
export const PVP_DECANT_FAMILIES: readonly DecantFamily[] = [
    { key: 'prayer', dose4: 2434, dose3: 139, dose2: 141, dose1: 143 },
    { key: 'super_attack', dose4: 2436, dose3: 145, dose2: 147, dose1: 149 },
    { key: 'super_str', dose4: 2440, dose3: 157, dose2: 159, dose1: 161 },
    { key: 'super_def', dose4: 2442, dose3: 163, dose2: 165, dose1: 167 },
    { key: 'ranging', dose4: 2444, dose3: 169, dose2: 171, dose1: 173 },
    { key: 'antipoison', dose4: 2446, dose3: 175, dose2: 177, dose1: 179 },
    { key: 'super_antipoison', dose4: 2448, dose3: 181, dose2: 183, dose1: 185 },
];

const RECIPES_BY_LEVEL_DESC: readonly BrewRecipe[] = Object.values(RECIPES).sort((a, b) => b.level - a.level);

export function effectiveSecondaryCount(secId: number, stock: Stock): number {
    const direct = stock[secId] ?? 0;
    const grind = GRINDABLE_SECONDARIES[secId];
    if (!grind || (stock[grind.tool] ?? 0) < 1) return direct;
    return direct + (stock[grind.raw] ?? 0);
}

const ownsHerbs = (r: BrewRecipe, stock: Stock) => (stock[r.dirty] ?? 0) > 0 || (stock[r.clean] ?? 0) > 0 || (stock[r.unf] ?? 0) > 0;
const hasSecondary = (r: BrewRecipe, stock: Stock) => r.sec === BOUGHT_SECONDARY || effectiveSecondaryCount(r.sec, stock) > 0;

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

// The item ids whose stock decides brewShortfall: every herb, unfinished potion, secondary, pestle and grindable raw secondary.
export const BREW_STOCK_IDS: readonly number[] = [
    ...new Set([
        ...Object.values(RECIPES).flatMap(r => [r.dirty, r.clean, r.unf, r.sec]),
        PESTLE_AND_MORTAR,
        ...Object.values(GRINDABLE_SECONDARIES).map(g => g.raw),
    ]),
];
