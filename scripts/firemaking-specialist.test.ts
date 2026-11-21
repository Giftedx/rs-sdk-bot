import { describe, expect, test } from 'bun:test';
import {
    FIREMAKING_SPECIALIST_SUPPLIES,
    LUMBRIDGE_FM_PATH,
    OBJ_LOGS,
    OBJ_MAGIC_LOGS,
    OBJ_MAPLE_LOGS,
    OBJ_OAK_LOGS,
    OBJ_WILLOW_LOGS,
    OBJ_YEW_LOGS,
    buildFiremakingSupplierConfigs,
    firemakingSupplierBatches,
    planFiremakingRoute,
} from './firemaking-specialist';
import { xpForLevel } from '../packages/planner/src/curve';

describe('firemaking specialist ground-line route', () => {
    test('optimal log ladder hits 99 in ~157 logs with zero drop or bank trips', () => {
        const { steps, counts, totalXp } = planFiremakingRoute();
        expect(totalXp).toBeGreaterThanOrEqual(xpForLevel(99));
        expect(steps.length).toBeGreaterThanOrEqual(157);
        expect(steps.length).toBeLessThanOrEqual(LUMBRIDGE_FM_PATH.length);
        expect(steps[0]!.x).toBe(3222);
        expect(steps[0]!.z).toBe(3222);
        expect(counts[OBJ_LOGS]).toBe(2);
        expect(counts[OBJ_OAK_LOGS]).toBe(4);
        expect(counts[OBJ_WILLOW_LOGS]).toBe(7);
        expect(counts[OBJ_MAPLE_LOGS]).toBe(13);
        expect(counts[OBJ_YEW_LOGS]).toBe(24);
        expect(counts[OBJ_MAGIC_LOGS]).toBeGreaterThanOrEqual(107);
        expect(FIREMAKING_SPECIALIST_SUPPLIES).toEqual(counts);
    });

    test('path has distinct tiles and splits cleanly into 28-log supplier drops', () => {
        const seen = new Set(LUMBRIDGE_FM_PATH.map(([x, z]) => `${x},${z}`));
        expect(seen.size).toBe(LUMBRIDGE_FM_PATH.length);
        const { steps } = planFiremakingRoute();
        const batches = firemakingSupplierBatches(steps, 28);
        expect(batches.length).toBe(6);
        expect(batches.every(b => b.length <= 28)).toBe(true);
    });

    test('multi-supplier wave configs keep inventories <= 28 slots and cover exact log counts', () => {
        const cfgs = buildFiremakingSupplierConfigs();
        expect(cfgs.map(c => c.role)).toEqual(['starter', 'runner']);
        const logTotals: Record<number, number> = {};
        for (const cfg of cfgs) {
            expect(cfg.inventory.length).toBeLessThanOrEqual(28);
            for (const item of [...cfg.inventory, ...cfg.bank]) {
                if (item.id in FIREMAKING_SPECIALIST_SUPPLIES) {
                    logTotals[item.id] = (logTotals[item.id] ?? 0) + item.count;
                }
            }
        }
        expect(logTotals).toEqual(FIREMAKING_SPECIALIST_SUPPLIES);
    });
});
