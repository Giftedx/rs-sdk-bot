import { describe, expect, test } from 'bun:test';
import {
    WOODCUTTING_SPECIALIST_SUPPLIES,
    BARB_OAK_CENTERS,
    BARB_NORMAL_CENTERS,
    OBJ_RUNE_AXE,
    OBJ_KNIFE,
    OBJ_LOGS,
    OBJ_DRAGON_BONES,
    OBJ_PRAYER_POTION_4,
    OBJ_HOLY_SYMBOL,
    OBJ_COINS,
    planWoodcuttingTotals,
} from './woodcutting-specialist';
import { xpForLevel } from '../packages/planner/src/curve';

describe('woodcutting specialist hybrid 2t/3t route', () => {
    test('supply inventory fits cleanly inside the 25 free slots after dropping tutorial junk', () => {
        // Stackable Air/Mind runes and Coins take 1 slot each; 15 junk items dropped leave 25 slots for the 25-slot kit.
        const stackables = new Set([556, 558, OBJ_COINS]);
        const slotsUsed = Object.entries(WOODCUTTING_SPECIALIST_SUPPLIES)
            .reduce((n, [id, count]) => n + (stackables.has(Number(id)) ? 1 : count), 0);
        expect(slotsUsed).toBeLessThanOrEqual(25);
        expect(WOODCUTTING_SPECIALIST_SUPPLIES[OBJ_RUNE_AXE]).toBe(1);
        expect(WOODCUTTING_SPECIALIST_SUPPLIES[OBJ_KNIFE]).toBe(1);
        expect(WOODCUTTING_SPECIALIST_SUPPLIES[OBJ_LOGS]).toBe(1);
        expect(WOODCUTTING_SPECIALIST_SUPPLIES[OBJ_COINS]).toBe(30);
        expect(WOODCUTTING_SPECIALIST_SUPPLIES[556]).toBe(150);
        expect(WOODCUTTING_SPECIALIST_SUPPLIES[558]).toBe(150);
        expect(WOODCUTTING_SPECIALIST_SUPPLIES[OBJ_DRAGON_BONES]).toBe(11);
        expect(WOODCUTTING_SPECIALIST_SUPPLIES[OBJ_PRAYER_POTION_4]).toBe(4);
        expect(WOODCUTTING_SPECIALIST_SUPPLIES[OBJ_HOLY_SYMBOL]).toBe(1);
    });

    test('normal-to-oak totals hit level 99 in 3 normal + 1,064 oak logs across multiway Draynor Jail oaks', () => {
        const totals = planWoodcuttingTotals();
        expect(totals.normalLogs).toBe(3);
        expect(totals.oakLogs).toBe(1064);
        expect(totals.totalXp).toBeGreaterThanOrEqual(xpForLevel(99));
        expect(BARB_OAK_CENTERS.length).toBe(3);
        expect(BARB_NORMAL_CENTERS.length).toBe(4);
    });
});
