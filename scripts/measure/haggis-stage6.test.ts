import { describe, expect, test } from 'bun:test';
import { RESERVED_ACCOUNTS } from '../../packages/core/src/specialist-boards';
import { OBJ_GLORY_4 } from '../gathering-specialist-lib';
import {
    ARDOUGNE_ZOO_START,
    OBJ_CHISEL,
    OBJ_HAMMER,
    assertSafeStage6Account,
    buildStage6Plan,
} from './haggis-stage6';

describe('haggis-stage6', () => {
    test('buildStage6Plan continues at Ardougne Zoo after Stage 5 with full Crafting and Smithing 1->99 kits', () => {
        const plan = buildStage6Plan();
        expect(plan.startingPosition).toEqual(ARDOUGNE_ZOO_START);
        expect(plan.startingSkills).toEqual({
            Cooking: 99,
            Fletching: 99,
            Firemaking: 99,
            Prayer: 43,
            Hitpoints: 10,
            Thieving: 99,
            Fishing: 99,
            Mining: 99,
        });
        expect(plan.mainBank.slice(0, 3)).toEqual([
            { id: OBJ_CHISEL, count: 1 },
            { id: OBJ_HAMMER, count: 1 },
            { id: OBJ_GLORY_4, count: 1 },
        ]);
        expect(plan.mainBank.some(b => b.id === 1631 && b.count === 280)).toBe(true);
        expect(plan.mainBank.some(b => b.id === 2361 && b.count === 345)).toBe(true);
        expect(() => buildStage6Plan(-1)).toThrow(/dragonstoneBuffer/);
        expect(() => buildStage6Plan(21)).toThrow(/dragonstoneBuffer/);
    });

    test('assertSafeStage6Account rejects empty and reserved live accounts', () => {
        expect(() => assertSafeStage6Account('')).toThrow(/required/);
        expect(() => assertSafeStage6Account('   ')).toThrow(/required/);
        for (const reserved of RESERVED_ACCOUNTS) {
            expect(() => assertSafeStage6Account(reserved)).toThrow(/reserved/);
            expect(() => assertSafeStage6Account(reserved.toUpperCase())).toThrow(/reserved/);
        }
        expect(assertSafeStage6Account(' hs6test ')).toBe('hs6test');
    });
});
