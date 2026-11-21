import { describe, expect, test } from 'bun:test';
import { RESERVED_ACCOUNTS } from '../../packages/core/src/specialist-boards';
import { OBJ_FEATHER, OBJ_FLY_ROD } from '../fishing-specialist';
import { OBJ_GLORY_4, OBJ_KNIFE, OBJ_LOGS } from '../gathering-specialist-lib';
import {
    ARDOUGNE_MARKET_START,
    OBJ_SWAMP_PASTE,
    STAGE4_FEATHERS,
    assertSafeStage4Account,
    buildStage4Plan,
} from './haggis-stage4';

describe('haggis-stage4', () => {
    test('buildStage4Plan continues at Ardougne Market after Stage 3 with Sea Slug and Barbarian fly-fishing supplies', () => {
        const plan = buildStage4Plan();
        expect(plan.startingPosition).toEqual(ARDOUGNE_MARKET_START);
        expect(plan.startingSkills).toEqual({
            Cooking: 99,
            Fletching: 99,
            Firemaking: 99,
            Prayer: 43,
            Hitpoints: 10,
            Thieving: 99,
        });
        expect(plan.mainBank).toEqual([
            { id: OBJ_SWAMP_PASTE, count: 1 },
            { id: OBJ_FLY_ROD, count: 1 },
            { id: OBJ_FEATHER, count: STAGE4_FEATHERS },
            { id: OBJ_KNIFE, count: 1 },
            { id: OBJ_LOGS, count: 1 },
            { id: OBJ_GLORY_4, count: 1 },
        ]);
        expect(() => buildStage4Plan(499)).toThrow(/featherCount/);
        expect(() => buildStage4Plan(10_001)).toThrow(/featherCount/);
    });

    test('assertSafeStage4Account rejects empty and reserved live accounts', () => {
        expect(() => assertSafeStage4Account('')).toThrow(/required/);
        expect(() => assertSafeStage4Account('   ')).toThrow(/required/);
        for (const reserved of RESERVED_ACCOUNTS) {
            expect(() => assertSafeStage4Account(reserved)).toThrow(/reserved/);
            expect(() => assertSafeStage4Account(reserved.toUpperCase())).toThrow(/reserved/);
        }
        expect(assertSafeStage4Account(' hs4test ')).toBe('hs4test');
    });
});
