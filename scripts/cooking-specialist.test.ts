import { describe, expect, test } from 'bun:test';
import {
    COOKING_FERMENT_TICKS,
    COOKING_SPECIALIST_COCKTAILS,
    COOKING_SPECIALIST_SUPPLIES,
    COOKING_SPECIALIST_WINES,
    OBJ_CERT_UNFERMENTED_WINE,
    OBJ_LEMON_SLICES,
    OBJ_UNFINISHED_FRUIT_BLAST,
    cookingWineBatchOdds,
    minBankedWinesForSingleBatch99,
    planCookingSummary,
} from './cooking-specialist';
import { OBJ_DUELING_8 } from './gathering-specialist-lib';
import { xpForLevel } from '../packages/planner/src/curve';

describe('cooking specialist route plan', () => {
    test('supply inventory fits cleanly in the 10 free tutorial slots', () => {
        const slotUsage =
            1 + // noted unfermented wine
            1 + // ring of dueling
            COOKING_SPECIALIST_SUPPLIES[OBJ_UNFINISHED_FRUIT_BLAST]! +
            COOKING_SPECIALIST_SUPPLIES[OBJ_LEMON_SLICES]!;
        expect(slotUsage).toBeLessThanOrEqual(10);
        expect(COOKING_SPECIALIST_SUPPLIES[OBJ_CERT_UNFERMENTED_WINE]).toBe(COOKING_SPECIALIST_WINES);
        expect(COOKING_SPECIALIST_SUPPLIES[OBJ_DUELING_8]).toBe(1);
        expect(COOKING_SPECIALIST_SUPPLIES[OBJ_UNFINISHED_FRUIT_BLAST]).toBe(COOKING_SPECIALIST_COCKTAILS);
        expect(COOKING_SPECIALIST_SUPPLIES[OBJ_LEMON_SLICES]).toBe(COOKING_SPECIALIST_COCKTAILS);
    });

    test('one passing wine batch reaches level 99 and 4 Fruit Blasts cut all-fail odds below 0.01%', () => {
        const plan = planCookingSummary();
        expect(plan.minTotalWines).toBe(5460);
        expect(COOKING_SPECIALIST_WINES).toBeGreaterThanOrEqual(plan.minTotalWines);
        expect(plan.perBatchXp).toBeGreaterThanOrEqual(xpForLevel(99));
        expect(plan.boostedLevel).toBeGreaterThanOrEqual(24);
        expect(plan.batchOdds).toBeGreaterThan(cookingWineBatchOdds(1));
        expect(plan.allFailProb).toBeLessThan(0.0001);
        expect(COOKING_FERMENT_TICKS).toBe(20);
    });
});
