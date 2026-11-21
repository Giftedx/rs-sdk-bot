import { describe, expect, test } from 'bun:test';
import { RESERVED_ACCOUNTS } from '../../packages/core/src/specialist-boards';
import { FLETCHING_SPECIALIST_SUPPLIES, OBJ_HEADLESS_ARROW } from '../fletching-specialist';
import {
    assertSafeRehearsalAccounts,
    buildFirstFiveSupplies,
    DEFAULT_WINE_COUNT,
    OBJ_EGG,
    OBJ_FLOUR,
    OBJ_MILK,
    OBJ_WINE_NOTED,
} from './haggis-first-five';

describe('haggis-first-five', () => {
    test('buildFirstFiveSupplies fits tutorial clearance slots and carries wine notes, Cook items, teleports, and fletching ladder', () => {
        const supplies = buildFirstFiveSupplies();
        const keys = Object.keys(supplies).map(Number);
        expect(keys.length).toBe(14);
        expect(supplies[OBJ_WINE_NOTED]).toBe(DEFAULT_WINE_COUNT);
        expect(supplies[OBJ_EGG]).toBe(1);
        expect(supplies[OBJ_MILK]).toBe(1);
        expect(supplies[OBJ_FLOUR]).toBe(1);
        expect(supplies[OBJ_HEADLESS_ARROW]).toBe(FLETCHING_SPECIALIST_SUPPLIES[OBJ_HEADLESS_ARROW]);
        expect(() => buildFirstFiveSupplies(0)).toThrow(/invalid wineCount/);
    });

    test('assertSafeRehearsalAccounts refuses every reserved account and colliding names', () => {
        for (const reserved of RESERVED_ACCOUNTS) {
            expect(() => assertSafeRehearsalAccounts(reserved, 'helper1')).toThrow(/reserved/);
            expect(() => assertSafeRehearsalAccounts('main1', reserved)).toThrow(/reserved/);
        }
        expect(() => assertSafeRehearsalAccounts('same', 'SAME')).toThrow(/differ/);
        expect(assertSafeRehearsalAccounts('hagmain1', 'haghelp1')).toEqual({
            mainName: 'hagmain1',
            helperName: 'haghelp1',
        });
    });
});
