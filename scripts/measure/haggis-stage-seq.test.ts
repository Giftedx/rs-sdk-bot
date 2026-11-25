import { describe, expect, test } from 'bun:test';
import { RESERVED_ACCOUNTS } from '../../packages/core/src/specialist-boards';
import {
    SUPER_ENERGY_IDS,
    assertSafeStageSeqAccounts,
    buildStageSeqPlan,
    mergeBankStacks,
} from './haggis-stage-seq';
import { OBJ_GLORY_4 } from '../gathering-specialist-lib';

describe('haggis-stage-seq', () => {
    test('mergeBankStacks sums duplicate item stacks across stages cleanly', () => {
        const merged = mergeBankStacks(
            [{ id: OBJ_GLORY_4, count: 1 }, { id: 536, count: 28 }],
            [{ id: OBJ_GLORY_4, count: 2 }, { id: 385, count: 5 }],
        );
        const byId = new Map(merged.map(m => [m.id, m.count]));
        expect(byId.get(OBJ_GLORY_4)).toBe(3);
        expect(byId.get(536)).toBe(28);
        expect(byId.get(385)).toBe(5);
    });

    test('buildStageSeqPlan covers Stage 1..7 supplies, <=3 banker note batches, and zero Super energy potions', () => {
        const plan = buildStageSeqPlan();
        const bankIds = new Set(plan.stage2to7Bank.map(b => b.id));
        const s1Ids = new Set(Object.keys(plan.stage1Supplies).map(Number));
        for (const id of SUPER_ENERGY_IDS) {
            expect(bankIds.has(id)).toBe(false);
            expect(s1Ids.has(id)).toBe(false);
        }
        // Merged Stage 2 transition (1) + Stage 4 (1) + Stage 6 (1) + Stage 7 (2) = 5 Glory(4) in bank.
        const glory = plan.stage2to7Bank.find(b => b.id === OBJ_GLORY_4);
        expect(glory?.count).toBe(5);
        expect(plan.bankerBatches.length).toBeGreaterThan(0);
        expect(plan.bankerBatches.length).toBeLessThanOrEqual(3);
        for (const batch of plan.bankerBatches) {
            expect(batch.length).toBeLessThanOrEqual(28);
        }
        expect(plan.fmHelperChunks.length).toBe(5);
        expect(plan.packLogsCounts.reduce((n, x) => n + x.count, 0)).toBe(26);
    });

    test('assertSafeStageSeqAccounts rejects long/reserved names and returns Stage 1, banker, and FM helpers', () => {
        expect(() => assertSafeStageSeqAccounts('')).toThrow(/required/);
        expect(() => assertSafeStageSeqAccounts('toolongname12')).toThrow(/11 chars/);
        for (const reserved of RESERVED_ACCOUNTS) {
            expect(() => assertSafeStageSeqAccounts(reserved)).toThrow(/reserved/);
        }
        const accounts = assertSafeStageSeqAccounts('hseq01');
        expect(accounts.stage1HelperName).toBe('hseq01h');
        expect(accounts.bankerNames).toEqual(['hseq01k', 'hseq01l', 'hseq01m']);
        expect(accounts.fmHelperNames).toEqual(['hseq01b', 'hseq01c', 'hseq01d', 'hseq01e', 'hseq01f']);
    });
});
