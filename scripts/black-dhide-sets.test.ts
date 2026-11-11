import { expect, test } from 'bun:test';
import { BLACK_HIDE, BLACK_LEATHER, SET_LEATHER, SET_LEVEL, SET_PIECES, SHOP_COINS, TAN_COST, TAN_TRIP, setPlan } from './black-dhide-sets';
import { inventoryRecipes } from './microbot-production';
import { ARMOUR_SETS, LEATHER_LEVEL, SET_HIDES, SET_SHOP, TAN_COIN, catalogue } from '../packages/planner/src/autopilot';

test('a set is a body, chaps and vambraces of six black dragon leather, and the recipes agree', () => {
    expect(SET_LEATHER).toBe(6);
    expect(SET_LEVEL).toBe(84);
    for (const piece of SET_PIECES) {
        const recipe = inventoryRecipes().find(r => r.name === piece.recipe)!;
        expect(recipe.inputs).toEqual([{ id: BLACK_LEATHER, units: piece.leather }]);
        expect(recipe.product).toBe(piece.product);
        expect(recipe.level).toBe(piece.level);
    }
    expect([BLACK_HIDE, BLACK_LEATHER, TAN_COST]).toEqual([1747, 2509, 20]);
    // A tanning trip is a pack of hides and the coins.
    expect(TAN_TRIP).toBe(27);
});

test('a run makes whole sets of the hides and leather the bank holds, as far as the coins tan them', () => {
    // 14 hides: two sets, 12 tanned, thread for six makes and a reel over.
    expect(setPlan(0, 14, 0, 0, 2000)).toEqual({ sets: 2, tan: 12, thread: 3, coins: 12 * TAN_COST + SHOP_COINS });
    // Leather already tanned is used first; thread already held is not bought.
    expect(setPlan(0, 4, 8, 5, 2000)).toEqual({ sets: 2, tan: 4, thread: 0, coins: 4 * TAN_COST });
    // SETS caps the run; coins cap it too (practice: 20 hides and 300 coins made one set).
    expect(setPlan(1, 20, 0, 0, 2000).sets).toBe(1);
    expect(setPlan(0, 20, 0, 0, 300).sets).toBe(1);
    expect(setPlan(0, 20, 0, 0, 100).sets).toBe(0);
    // Fewer than a set, or nonsense: nothing.
    expect(setPlan(0, 5, 0, 0, 2000).sets).toBe(0);
    expect(setPlan(0, Number.NaN, 0, 0, 2000).sets).toBe(0);
    expect(setPlan(-1, 12, 0, 0, 2000).sets).toBe(0);
});

test('the planner asks what the worker needs', () => {
    expect([LEATHER_LEVEL, SET_HIDES, TAN_COIN, SET_SHOP]).toEqual([SET_LEVEL, SET_LEATHER, TAN_COST, SHOP_COINS]);
    const t = catalogue().find(t => t.id === 'army-black-dhide-sets')!;
    expect(t.worker).toBe('scripts/black-dhide-sets.ts');
    expect(t.needs).toMatchObject({ skills: { Crafting: SET_LEVEL }, holds: { dragonhide: SET_LEATHER } });
    expect(t.stock).toEqual({ item: 'dragonhide body', to: ARMOUR_SETS });
});
