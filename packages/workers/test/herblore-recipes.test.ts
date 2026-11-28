import { describe, expect, test } from 'bun:test';
import { brewShortfall, selectRecipe } from '../src/bank-artisan/herblore-recipes';
import { artisanPreflight } from '../src/bank-artisan/preflight';
import { nearestBank } from '../src/bank-artisan/runtime';
import type { WorkerAccountView, WorkerWorldView } from '../src/contracts';

// A brew run picks a recipe whose herbs and secondary the bank holds, and the worker preflight refuses a job that
// holds neither set, so the run cannot log in and stop with `secondary missing`.

function account(herblore: number, bank: Record<number, number>): { acct: WorkerAccountView; world: WorkerWorldView } {
    const acct = {
        name: 'BrewProbe',
        side: 'local',
        protectedClock: false,
        skills: { Herblore: { level: herblore, xp: 0 }, Hitpoints: { level: 30, xp: 0 } },
        quests: { druid: 'complete' },
        pos: { x: 3092, z: 3243, level: 0 },
        inventory: {},
        equipment: {},
        bank: { items: bank, observedAt: 999_000, trusted: true },
    } as unknown as WorkerAccountView;
    return { acct, world: { at: 1_000_000, side: 'local', server: 'localhost:8888', accounts: { BrewProbe: acct } } as WorkerWorldView };
}

describe('selectRecipe', () => {
    test('auto skips a recipe whose secondary the stock lacks', () => {
        expect(selectRecipe(54, { 199: 5, 203: 5 }).key).toBe('attack');
        expect(selectRecipe(54, { 199: 5, 203: 5, 225: 5 }).key).toBe('strength');
    });

    test('auto names the missing secondary when no owned herb has one', () => {
        expect(() => selectRecipe(54, { 203: 5 })).toThrow('secondary missing 225');
    });

    test('unf needs no secondary', () => {
        expect(selectRecipe(54, { 203: 5 }, 'unf').key).toBe('strength');
    });

    test('auto selects super_antipoison and weapon_poison when herbs and ground or raw secondaries exist', () => {
        expect(selectRecipe(48, { 209: 5, 235: 5 }).key).toBe('super_antipoison');
        expect(selectRecipe(48, { 209: 5, 237: 5, 233: 1 }).key).toBe('super_antipoison');
        expect(selectRecipe(60, { 213: 5, 241: 5 }).key).toBe('weapon_poison');
        expect(selectRecipe(60, { 213: 5, 243: 5, 233: 1 }).key).toBe('weapon_poison');
    });
});

describe('brewShortfall', () => {
    test('names the secondary, the herb or nothing', () => {
        expect(brewShortfall(54, { 203: 5 })).toEqual({ itemId: 225, reason: 'secondary missing 225' });
        expect(brewShortfall(54, {})?.itemId).toBe(199);
        expect(brewShortfall(54, { 203: 5, 225: 5 })).toBeUndefined();
        expect(brewShortfall(54, { 203: 5 }, 'strength')?.itemId).toBe(225);
        expect(brewShortfall(54, { 199: 5 })).toBeUndefined();
    });
});

describe('artisanPreflight herblore potions', () => {
    const blockers = (bank: Record<number, number>) => {
        const { acct, world } = account(54, bank);
        return artisanPreflight(acct, { skill: 'herblore', method: 'potions', args: [] }, world).blockers.flatMap(b => (b.kind === 'missing_supply' ? [b.itemId] : []));
    };

    test('tarromin without limpwurt root is refused before login', () => {
        expect(blockers({ 203: 20 })).toEqual([225]);
    });

    test('tarromin with limpwurt root passes', () => {
        expect(blockers({ 203: 20, 225: 20 })).toEqual([]);
    });
});

describe('nearestBank from below the surface', () => {
    test('the Edgeville dungeon ranks the banks from the surface above it', () => {
        const below = nearestBank({ x: 3129, z: 9953, level: 0 });
        expect(below).toEqual(nearestBank({ x: 3129, z: 3553, level: 0 }));
        expect(Math.abs(below.z - 3553)).toBeLessThan(100);
    });
});
