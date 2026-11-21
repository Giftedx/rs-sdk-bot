import { describe, expect, test } from 'bun:test';
import { RESERVED_ACCOUNTS } from '../../packages/core/src/specialist-boards';
import { OBJ_DUELING_8, OBJ_KNIFE, OBJ_LOGS } from '../gathering-specialist-lib';
import { OBJ_CLAY, OBJ_COPPER_ORE, OBJ_IRON_ORE, OBJ_RUNE_PICKAXE } from '../mining-specialist';
import {
    BARBARIAN_FLY_START,
    STAGE5_DEFAULT_LOGS,
    assertSafeStage5Account,
    buildStage5Plan,
} from './haggis-stage5';

describe('haggis-stage5', () => {
    test('buildStage5Plan continues at Barbarian Village river after Stage 4 with Doric and Ardougne Zoo mining supplies', () => {
        const plan = buildStage5Plan();
        expect(plan.startingPosition).toEqual(BARBARIAN_FLY_START);
        expect(plan.startingSkills).toEqual({
            Cooking: 99,
            Fletching: 99,
            Firemaking: 99,
            Prayer: 43,
            Hitpoints: 10,
            Thieving: 99,
            Fishing: 99,
        });
        expect(plan.mainBank).toEqual([
            { id: OBJ_RUNE_PICKAXE, count: 1 },
            { id: OBJ_KNIFE, count: 1 },
            { id: OBJ_LOGS, count: STAGE5_DEFAULT_LOGS },
            { id: OBJ_DUELING_8, count: 1 },
            { id: OBJ_CLAY, count: 6 },
            { id: OBJ_COPPER_ORE, count: 4 },
            { id: OBJ_IRON_ORE, count: 2 },
        ]);
        expect(() => buildStage5Plan(0)).toThrow(/extraLogs/);
        expect(() => buildStage5Plan(11)).toThrow(/extraLogs/);
    });

    test('assertSafeStage5Account rejects empty and reserved live accounts', () => {
        expect(() => assertSafeStage5Account('')).toThrow(/required/);
        expect(() => assertSafeStage5Account('   ')).toThrow(/required/);
        for (const reserved of RESERVED_ACCOUNTS) {
            expect(() => assertSafeStage5Account(reserved)).toThrow(/reserved/);
            expect(() => assertSafeStage5Account(reserved.toUpperCase())).toThrow(/reserved/);
        }
        expect(assertSafeStage5Account(' hs5test ')).toBe('hs5test');
    });
});
