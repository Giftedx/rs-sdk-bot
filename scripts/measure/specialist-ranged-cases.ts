// Bench cases for the fresh-clock Ranged 99 specialist route and weapon A/B comparisons.
import type { BenchCase } from './aio-bench-cases';
import { PRESETS } from '../../packages/practice/src/presets';
import { COOK_JOB_NATIVE_NULL_VARPS } from '../../packages/practice/src/quest-items-order-proof';
import {
    kitSlotTotal,
    RANGED_SPECIALIST_MSB_TRADE1,
    RANGED_SPECIALIST_MSB_TRADE2,
    RANGED_SPECIALIST_TRADE1,
    RANGED_SPECIALIST_TRADE2,
    type KitSpecItem,
} from '../ranged-specialist';

const FRESH_NATIVE_LUMBRIDGE = {
    ...PRESETS.fresh_lumbridge!,
    varps: { ...COOK_JOB_NATIVE_NULL_VARPS },
};

const kitToSaveInventory = (kit: readonly KitSpecItem[], expectedSlots: number) => {
    const items = kit.flatMap(item =>
        item.stackable
            ? [{ id: item.id, count: item.count }]
            : Array.from({ length: item.count }, () => ({ id: item.id, count: 1 })),
    );
    if (items.length !== expectedSlots || kitSlotTotal(kit) !== expectedSlots || items.length > 28) {
        throw Error(`specialist-ranged-cases: expected ${expectedSlots} slots (<=28), got ${items.length}`);
    }
    return items;
};

const rangedSpecialistPass = (s: string): boolean => {
    const logged = (s.match(/^LOGOUT .*$/gm) ?? []);
    return /^RESULT ok\b/m.test(s)
        && /\branged=99\b/.test(s)
        && /\bpicked=true\b/.test(s)
        && logged.length === 1
        && logged[0]!.trim() === 'LOGOUT logged-out';
};

export const SPECIALIST_RANGED_CASES: readonly BenchCase[] = [
    {
        key: 'fighter:ranged-specialist',
        script: 'scripts/aio-fighter.ts',
        preset: 'fresh_lumbridge',
        presetConfig: FRESH_NATIVE_LUMBRIDGE,
        scriptArgs: ['ranged-specialist', 'CAP=5200', 'VARIANT=knives', 'BENCH_SUPPLIER={bot:b}', 'BENCH_SUPPLIER2={bot:c}'],
        pass: rangedSpecialistPass,
        timeoutMs: 900_000,
        output: /\brangedXp=(\d+)/,
        companions: [
            {
                suffix: 'b',
                preset: 'fresh_lumbridge',
                presetConfig: {
                    position: { x: 3223, z: 3222, level: 0 },
                    inventory: kitToSaveInventory(RANGED_SPECIALIST_TRADE1, 27),
                },
            },
            {
                suffix: 'c',
                preset: 'fresh_lumbridge',
                presetConfig: {
                    position: { x: 3089, z: 3496, level: 0 },
                    inventory: kitToSaveInventory(RANGED_SPECIALIST_TRADE2, 18),
                },
            },
        ],
    },
    {
        key: 'extra:ranged-specialist-msb',
        script: 'scripts/ranged-specialist.ts',
        preset: 'fresh_lumbridge',
        presetConfig: FRESH_NATIVE_LUMBRIDGE,
        scriptArgs: ['CAP=5200', 'VARIANT=msb', 'BENCH_SUPPLIER={bot:b}', 'BENCH_SUPPLIER2={bot:c}'],
        pass: rangedSpecialistPass,
        timeoutMs: 900_000,
        output: /\brangedXp=(\d+)/,
        companions: [
            {
                suffix: 'b',
                preset: 'fresh_lumbridge',
                presetConfig: {
                    position: { x: 3223, z: 3222, level: 0 },
                    inventory: kitToSaveInventory(RANGED_SPECIALIST_MSB_TRADE1, 27),
                },
            },
            {
                suffix: 'c',
                preset: 'fresh_lumbridge',
                presetConfig: {
                    position: { x: 3089, z: 3496, level: 0 },
                    inventory: kitToSaveInventory(RANGED_SPECIALIST_MSB_TRADE2, 19),
                },
            },
        ],
    },
];
