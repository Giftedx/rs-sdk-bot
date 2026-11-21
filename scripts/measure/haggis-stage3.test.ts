import { describe, expect, test } from 'bun:test';
import { RESERVED_ACCOUNTS } from '../../packages/core/src/specialist-boards';
import { OBJ_DUELING_8, OBJ_PINEAPPLE_PIZZA } from '../gathering-specialist-lib';
import { DRAYNOR_BANK } from './haggis-stage2';
import {
    STAGE3_PIZZA_COUNT,
    assertSafeStage3Account,
    buildStage3Plan,
} from './haggis-stage3';

describe('haggis-stage3', () => {
    test('buildStage3Plan continues at Draynor bank after Stage 2 with Ring of dueling(8) and pineapple pizzas', () => {
        const plan = buildStage3Plan();
        expect(plan.startingPosition).toEqual(DRAYNOR_BANK);
        expect(plan.startingSkills).toEqual({ Cooking: 99, Fletching: 99, Firemaking: 99, Prayer: 43, Hitpoints: 10 });
        expect(plan.mainBank).toEqual([
            { id: OBJ_DUELING_8, count: 1 },
            { id: OBJ_PINEAPPLE_PIZZA, count: STAGE3_PIZZA_COUNT },
        ]);
        expect(() => buildStage3Plan(9)).toThrow(/pizzaCount/);
        expect(() => buildStage3Plan(27)).toThrow(/pizzaCount/);
    });

    test('assertSafeStage3Account rejects empty and reserved live accounts', () => {
        expect(() => assertSafeStage3Account('')).toThrow(/required/);
        expect(() => assertSafeStage3Account('   ')).toThrow(/required/);
        for (const reserved of RESERVED_ACCOUNTS) {
            expect(() => assertSafeStage3Account(reserved)).toThrow(/reserved/);
            expect(() => assertSafeStage3Account(reserved.toUpperCase())).toThrow(/reserved/);
        }
        expect(assertSafeStage3Account(' hs3test ')).toBe('hs3test');
    });
});
