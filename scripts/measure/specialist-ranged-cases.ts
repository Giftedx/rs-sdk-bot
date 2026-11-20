// Bench cases for the fresh-clock Ranged 99 specialist route and weapon A/B comparisons.
import type { BenchCase } from './aio-bench-cases';
import { kitSlotTotal, RANGED_SPECIALIST_KIT, RANGED_SPECIALIST_MSB_KIT, type KitSpecItem } from '../ranged-specialist';

const kitToSaveInventory = (kit: readonly KitSpecItem[]) => {
    const items = kit.flatMap(item =>
        item.stackable
            ? [{ id: item.id, count: item.count }]
            : Array.from({ length: item.count }, () => ({ id: item.id, count: 1 })),
    );
    if (items.length !== 28 || kitSlotTotal(kit) !== 28) {
        throw Error(`specialist-ranged-cases: expected 28 slots, got ${items.length}`);
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
        scriptArgs: ['ranged-specialist', 'CAP=5200', 'VARIANT=knives', 'BENCH_SUPPLIER={bot:b}'],
        pass: rangedSpecialistPass,
        timeoutMs: 900_000,
        output: /\brangedXp=(\d+)/,
        companions: [{
            suffix: 'b',
            preset: 'fresh_lumbridge',
            presetConfig: {
                position: { x: 3223, z: 3222, level: 0 },
                inventory: kitToSaveInventory(RANGED_SPECIALIST_KIT),
            },
        }],
    },
    {
        key: 'extra:ranged-specialist-msb',
        script: 'scripts/ranged-specialist.ts',
        preset: 'fresh_lumbridge',
        scriptArgs: ['CAP=5200', 'VARIANT=msb', 'BENCH_SUPPLIER={bot:b}'],
        pass: rangedSpecialistPass,
        timeoutMs: 900_000,
        output: /\brangedXp=(\d+)/,
        companions: [{
            suffix: 'b',
            preset: 'fresh_lumbridge',
            presetConfig: {
                position: { x: 3223, z: 3222, level: 0 },
                inventory: kitToSaveInventory(RANGED_SPECIALIST_MSB_KIT),
            },
        }],
    },
];
