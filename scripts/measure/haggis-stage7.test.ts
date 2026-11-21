import { describe, expect, test } from 'bun:test';
import { RESERVED_ACCOUNTS } from '../../packages/core/src/specialist-boards';
import { OBJ_GLORY_4, OBJ_SHARK } from '../gathering-specialist-lib';
import {
    DRUID_RAW_MEATS,
    IMP_BEAD_IDS,
    OBJ_GAMES_8,
    OBJ_PRAYER_POTION_4,
    STAGE7_START_SPOT,
    assertSafeStage7Account,
    buildStage7Plan,
} from './haggis-stage7';

describe('haggis-stage7', () => {
    test('buildStage7Plan continues at Varrock West Bank after Stage 6 with Magic and Herblore 1->99 kits', () => {
        const plan = buildStage7Plan();
        expect(plan.startingPosition).toEqual(STAGE7_START_SPOT);
        expect(plan.startingSkills).toEqual({
            Cooking: 99,
            Fletching: 99,
            Firemaking: 99,
            Prayer: 43,
            Hitpoints: 10,
            Thieving: 99,
            Fishing: 99,
            Mining: 99,
            Crafting: 99,
            Smithing: 99,
        });
        const countOf = (id: number) => plan.mainBank.find(b => b.id === id)?.count ?? 0;
        expect(countOf(OBJ_GLORY_4)).toBe(2);
        expect(countOf(OBJ_GAMES_8)).toBe(1);
        expect(countOf(OBJ_PRAYER_POTION_4)).toBe(1);
        expect(countOf(OBJ_SHARK)).toBe(5);
        for (const id of IMP_BEAD_IDS) expect(countOf(id)).toBe(1);
        for (const id of DRUID_RAW_MEATS) expect(countOf(id)).toBe(1);
        expect(countOf(1702)).toBe(457);
        expect(countOf(111)).toBe(179);
        expect(countOf(247)).toBe(179);
        expect(() => buildStage7Plan(-1)).toThrow(/magicBuffer/);
        expect(() => buildStage7Plan(0, 21)).toThrow(/herbBuffer/);
    });

    test('assertSafeStage7Account rejects empty and reserved live accounts', () => {
        expect(() => assertSafeStage7Account('')).toThrow(/required/);
        expect(() => assertSafeStage7Account('   ')).toThrow(/required/);
        for (const reserved of RESERVED_ACCOUNTS) {
            expect(() => assertSafeStage7Account(reserved)).toThrow(/reserved/);
            expect(() => assertSafeStage7Account(reserved.toUpperCase())).toThrow(/reserved/);
        }
        expect(assertSafeStage7Account(' hs7test ')).toBe('hs7test');
    });
});
