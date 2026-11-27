import { expect, test } from 'bun:test';
import { createActivityCatalog } from '../src/catalog';

// A hand-written activity that makes an item needs at least the level of the game-data recipe row that makes the
// same item in the same skill. A lower level admits accounts that the worker refuses at entry.
test('no hand-written activity needs a lower level than the game-data recipe of its output', () => {
    const all = createActivityCatalog().list();
    const levelOf = (a: (typeof all)[number]) => Number(a.config.requiredLevel ?? 1);
    const recipeMin = new Map<string, number>();
    for (const a of all.filter((x) => x.id.startsWith('bank-artisan:skill:'))) {
        for (const o of a.outputs ?? []) {
            const key = `${String(a.config.skill)}:${o.itemId}`;
            recipeMin.set(key, Math.min(recipeMin.get(key) ?? 99, levelOf(a)));
        }
    }
    expect(recipeMin.size).toBeGreaterThan(10);
    const low: string[] = [];
    for (const a of all.filter((x) => !x.id.startsWith('bank-artisan:skill:'))) {
        for (const o of a.outputs ?? []) {
            const min = recipeMin.get(`${String(a.config.skill ?? '')}:${o.itemId}`);
            if (min !== undefined && levelOf(a) < min) low.push(`${a.id} makes ${o.itemId} at level ${levelOf(a)}, the recipe needs ${min}`);
        }
    }
    expect(low).toEqual([]);
});
