import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
    VIKING_DRAUGEN_FIGHT_TICKS,
    VIKING_DRAUGEN_PHASE_TICKS,
    VIKING_DRAUGEN_SPAWNS,
    VIKING_FOOD_IDS,
    VIKING_LOCATE_STEPS,
    VIKING_RESERVED_FOOD,
    VIKING_SPOTS,
    shouldAttackDraugen,
} from './quest-viking';
import { wildernessLevel } from '../../packages/core/src/prayer-guard';

describe('The Fremennik Trials quest script', () => {
    test('importing quest-viking does not execute top-level login outside main or QUEST_SESSION', () => {
        expect(typeof shouldAttackDraugen).toBe('function');
        const source = readFileSync('scripts/generated/quest-viking.ts', 'utf8');
        expect(source).toContain('if (import.meta.main || !!(globalThis as { QUEST_SESSION?: unknown }).QUEST_SESSION)');
    });

    test('meal acceptance supports live sweep food while keeping all edible quest ingredients reserved', () => {
        for (const reservedId of Object.keys(VIKING_RESERVED_FOOD).map(Number)) {
            expect((VIKING_FOOD_IDS as readonly number[]).includes(reservedId)).toBe(false);
        }
        expect(VIKING_FOOD_IDS).toContain(385);
        expect(VIKING_FOOD_IDS).toContain(379);
        expect(VIKING_FOOD_IDS).toContain(373);
    });

    test('shouldAttackDraugen refreshes combat cleanly before the 6-tick prayer-offence grace expires', () => {
        expect(shouldAttackDraugen(7, 100, -1, -99, false)).toBe(true);
        expect(shouldAttackDraugen(7, 102, 7, 100, true)).toBe(false);
        expect(shouldAttackDraugen(7, 102, 7, 100, false)).toBe(true);
        expect(shouldAttackDraugen(7, 105, 7, 100, true)).toBe(true);
        expect(shouldAttackDraugen(8, 102, 7, 100, true)).toBe(true);
    });

    test('Draugen budgets separate search steps from multi-spawn 1,000-tick combat retries', () => {
        expect(VIKING_LOCATE_STEPS).toBeGreaterThanOrEqual(300);
        expect(VIKING_DRAUGEN_SPAWNS).toBeGreaterThanOrEqual(12);
        expect(VIKING_DRAUGEN_FIGHT_TICKS).toBeGreaterThan(1000);
        expect(VIKING_DRAUGEN_PHASE_TICKS).toBeLessThan(24000);
        const source = readFileSync('scripts/generated/quest-viking.ts', 'utf8');
        expect(source).toContain('await q.attack(cur);');
        expect(source).not.toContain('q.s.bot.attack');
        expect(source).toContain('msgs(/moved elsewhere/i) > moved0');
        expect(source).toContain("if (!up()) await q.walk('to arena ladder', [{ x: 2671, z: 10098, tol: 3 }]);");
    });

    test('every NPC and loc anchor in quest-viking stays strictly outside the Wilderness', () => {
        expect(VIKING_SPOTS.length).toBeGreaterThan(10);
        for (const spot of VIKING_SPOTS) {
            expect(wildernessLevel(spot.x, spot.z)).toBe(0);
        }
    });
});
