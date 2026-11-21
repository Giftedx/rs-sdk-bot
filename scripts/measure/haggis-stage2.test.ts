import { describe, expect, test } from 'bun:test';
import { RESERVED_ACCOUNTS } from '../../packages/core/src/specialist-boards';
import {
    OBJ_DRAGON_BONES,
    OBJ_TINDERBOX,
    STAGE2_CHUNK,
    STAGE2_PACK,
    assertSafeStage2Accounts,
    buildStage2Plan,
} from './haggis-stage2';
import { OBJ_GLORY_4 } from '../gathering-specialist-lib';

describe('haggis-stage2', () => {
    test('buildStage2Plan packs Glory + tinderbox + 26 logs (28 slots) and 5 helper drop chunks totaling 157 logs', () => {
        const plan = buildStage2Plan();
        expect(plan.totalLogs).toBe(157);
        expect(plan.packLogs.length).toBe(STAGE2_PACK);
        expect(plan.mainInventory.length).toBe(28);
        expect(plan.mainInventory[0]).toEqual({ id: OBJ_GLORY_4, count: 1 });
        expect(plan.mainInventory[1]).toEqual({ id: OBJ_TINDERBOX, count: 1 });
        expect(plan.helperChunks.length).toBe(5);
        for (let i = 0; i < 4; i++) expect(plan.helperChunks[i]!.length).toBe(STAGE2_CHUNK);
        expect(plan.helperChunks[4]!.length).toBe(157 - STAGE2_PACK - 4 * STAGE2_CHUNK);
        expect(plan.mainBank).toEqual([{ id: OBJ_DRAGON_BONES, count: 28 }]);
        expect(() => buildStage2Plan(10)).toThrow(/dragon bones/);
    });

    test('assertSafeStage2Accounts rejects reserved main or helper accounts and invalid helper counts', () => {
        for (const reserved of RESERVED_ACCOUNTS) {
            expect(() => assertSafeStage2Accounts(reserved)).toThrow(/reserved/);
            if (reserved.length > 1) {
                const stem = reserved.slice(0, -1);
                if (reserved.endsWith('b')) {
                    expect(() => assertSafeStage2Accounts(stem, 2)).toThrow(/reserved/);
                }
            }
        }
        expect(() => assertSafeStage2Accounts('hagmain', 0)).toThrow(/helperCount/);
        expect(() => assertSafeStage2Accounts('hagmain', 6)).toThrow(/helperCount/);
        expect(assertSafeStage2Accounts('hagtest')).toEqual({
            mainName: 'hagtest',
            helperNames: ['hagtestb', 'hagtestc', 'hagtestd', 'hagteste', 'hagtestf'],
        });
    });
});
