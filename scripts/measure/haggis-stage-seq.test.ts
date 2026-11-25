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

    test('buildStageSeqPlan includes all Stage 2..7 banks and zero Super energy potions', () => {
        const plan = buildStageSeqPlan();
        const bankIds = new Set(plan.mainBank.map(b => b.id));
        const invIds = new Set(plan.mainInventory.map(i => i.id));
        for (const id of SUPER_ENERGY_IDS) {
            expect(bankIds.has(id)).toBe(false);
            expect(invIds.has(id)).toBe(false);
        }
        // Merged Stage 4 (1) + Stage 6 (1) + Stage 7 (2) = 4 Glory(4) in bank.
        const glory = plan.mainBank.find(b => b.id === OBJ_GLORY_4);
        expect(glory?.count).toBe(4);
        expect(plan.helperChunks.length).toBe(5);
        expect(plan.startingVarps).toEqual({ 29: 2, 173: 1 });
    });

    test('assertSafeStageSeqAccounts rejects reserved names', () => {
        expect(() => assertSafeStageSeqAccounts('')).toThrow(/required/);
        for (const reserved of RESERVED_ACCOUNTS) {
            expect(() => assertSafeStageSeqAccounts(reserved)).toThrow(/reserved/);
        }
        expect(assertSafeStageSeqAccounts('hseq01').helperNames).toEqual(['hseq01b', 'hseq01c', 'hseq01d', 'hseq01e', 'hseq01f']);
    });
});
