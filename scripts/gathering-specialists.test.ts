import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { xpForLevel } from '../packages/planner/src/curve';
import { intentForEntry } from '../packages/planner/src/progression-catalog';
import { planFletchingActionCounts, pickNextFletchTier, FLETCHING_SPECIALIST_SUPPLIES, OBJ_HEADLESS_ARROW } from './fletching-specialist';
import { FISHING_SPECIALIST_SUPPLIES } from './fishing-specialist';
import { MINING_SPECIALIST_SUPPLIES, remainingIronOresTo99, IRON_ORE_XP_25X } from './mining-specialist';
import { THIEVING_SPECIALIST_SUPPLIES, THIEVING_PIZZAS, selectPickpocketTier } from './thieving-specialist';
import { OBJ_GAMES_8, OBJ_PINEAPPLE_PIZZA, OBJ_SUPER_ENERGY_4 } from './gathering-specialist-lib';
import { expandSupplyInventory, SPECIALIST_GATHERING_CASES } from './measure/specialist-gathering-cases';
import { benchCases, benchCoverage } from './measure/aio-bench-cases';
import {
    hasExactKit,
    kitSlotTotal,
    parseKitOption,
    SPECIALIST_KITS,
    type KitSpecItem,
} from './specialist-supplier';

const ROOT = resolve(import.meta.dir, '..');
const ITEMS: { id: number; name: string; tradeable?: boolean }[] = JSON.parse(
    readFileSync(join(ROOT, 'knowledge', 'items.json'), 'utf8'),
);

describe('gathering specialists supply & progression plans', () => {
    test('fletching ladder hits 99 in 240 actions using 7 stackable slots', () => {
        const plan = planFletchingActionCounts();
        expect(plan.actions).toBe(240);
        expect(plan.xp).toBeGreaterThanOrEqual(xpForLevel(99));
        expect(plan.byTier).toEqual({
            bronze: 4,
            iron: 6,
            steel: 9,
            mithril: 15,
            adamant: 33,
            rune: 173,
        });
        expect(expandSupplyInventory(FLETCHING_SPECIALIST_SUPPLIES).length).toBe(7);
        expect(FLETCHING_SPECIALIST_SUPPLIES[OBJ_HEADLESS_ARROW]).toBeGreaterThanOrEqual(240 * 15);
    });

    test('fletching tier picker obeys level unlocks and tip stock', () => {
        const counts = { ...FLETCHING_SPECIALIST_SUPPLIES };
        expect(pickNextFletchTier(0, counts)?.name).toBe('bronze');
        expect(pickNextFletchTier(xpForLevel(75), counts)?.name).toBe('rune');
        expect(pickNextFletchTier(xpForLevel(75), { ...counts, 44: 10 })?.name).toBe('adamant');
        expect(pickNextFletchTier(0, { ...counts, [OBJ_HEADLESS_ARROW]: 14 })).toBeNull();
    });

    test('supply inventories fit within companion 28 slots and main free space after drops', () => {
        const fletchSlots = expandSupplyInventory(FLETCHING_SPECIALIST_SUPPLIES).length;
        const fishSlots = expandSupplyInventory(FISHING_SPECIALIST_SUPPLIES).length;
        const mineSlots = expandSupplyInventory(MINING_SPECIALIST_SUPPLIES).length;
        const thieveSlots = expandSupplyInventory(THIEVING_SPECIALIST_SUPPLIES).length;

        expect(fletchSlots).toBe(7);
        expect(fishSlots).toBeLessThanOrEqual(14);
        expect(mineSlots).toBe(21);
        expect(thieveSlots).toBe(28);
        expect(MINING_SPECIALIST_SUPPLIES[OBJ_GAMES_8]).toBe(1);
        expect(MINING_SPECIALIST_SUPPLIES[OBJ_SUPER_ENERGY_4]).toBe(2);
        expect(THIEVING_PIZZAS).toBe(25);
        expect(THIEVING_SPECIALIST_SUPPLIES[OBJ_PINEAPPLE_PIZZA]).toBe(25);
        // 18 tutorial slots -> main drops 0 (fletch), 10 (fish), 13 (mine), 18 (thieve).
        expect(28 - 18).toBeGreaterThanOrEqual(fletchSlots);
        expect(28 - (18 - 10) - fishSlots).toBeGreaterThanOrEqual(1);
        expect(28 - (18 - 13) - mineSlots).toBeGreaterThanOrEqual(1);
        expect(28 - (18 - 18) - thieveSlots).toBeGreaterThanOrEqual(0);
    });

    test('mining iron count from Doric reward covers level 99', () => {
        const doricXp = 32_500;
        const ores = remainingIronOresTo99(doricXp);
        expect(ores).toBe(1104);
        expect(doricXp + ores * IRON_ORE_XP_25X).toBeGreaterThanOrEqual(xpForLevel(99));
        expect(doricXp + (ores - 1) * IRON_ORE_XP_25X).toBeLessThan(xpForLevel(99));
    });

    test('thieving pickpocket ladder selects optimal Ardougne targets', () => {
        expect(selectPickpocketTier(1).name).toBe('man');
        expect(selectPickpocketTier(24).name).toBe('man');
        expect(selectPickpocketTier(25).name).toBe('warrior');
        expect(selectPickpocketTier(39).name).toBe('warrior');
        expect(selectPickpocketTier(40).name).toBe('guard');
        expect(selectPickpocketTier(54).name).toBe('guard');
        expect(selectPickpocketTier(55).name).toBe('knight');
        expect(selectPickpocketTier(99).name).toBe('knight');
    });
});

describe('bench registration and catalog integration', () => {
    test('all 4 specialist bench cases are registered with fresh tutorial=0 fixtures and strict pass checks', () => {
        const cases = benchCases();
        for (const key of ['skiller:fletching:specialist', 'skiller:fishing:specialist', 'skiller:mining:specialist', 'skiller:thieving:specialist']) {
            const c = cases.find(x => x.key === key);
            expect(c, key).toBeDefined();
            expect(c!.presetConfig?.varps?.[281]).toBe(0);
            expect(c!.companions?.length).toBe(1);
            expect(c!.pass('LOGOUT logged-out\nRESULT ok level=99 ticks=53')).toBe(true);
            expect(c!.pass('LOGOUT logged-out logged-out\nRESULT ok level=99 ticks=53')).toBe(true);
            expect(c!.pass('LOGOUT logged-out\nRESULT ok level=98 ticks=53')).toBe(false);
            expect(c!.pass('LOGOUT logged-out\nRESULT ok helper supplied\nRESULT fail cap')).toBe(false);
            expect(c!.pass('RESULT ok level=99 ticks=53')).toBe(false);
        }
        expect(SPECIALIST_GATHERING_CASES.length).toBe(4);
        expect(benchCoverage().gaps).toEqual([]);
    });

    test('gathering kits match supply bills, cataloged tradeable names, and --kit option parsing', () => {
        const byId = new Map(ITEMS.map(item => [item.id, item]));
        const suppliesBySkill = {
            fletching: FLETCHING_SPECIALIST_SUPPLIES,
            fishing: FISHING_SPECIALIST_SUPPLIES,
            mining: MINING_SPECIALIST_SUPPLIES,
            thieving: THIEVING_SPECIALIST_SUPPLIES,
        } as const;
        for (const [skill, supplies] of Object.entries(suppliesBySkill) as [keyof typeof suppliesBySkill, Record<number, number>][]) {
            const parsed = parseKitOption(['holder', 'spec', `--kit=${skill}`]);
            expect(parsed).not.toBeNull();
            expect(parsed!.name).toBe(skill);
            const kit: readonly KitSpecItem[] = SPECIALIST_KITS[skill];
            expect(parsed!.kit).toBe(kit);
            const expanded = expandSupplyInventory(supplies);
            expect(kitSlotTotal(kit)).toBe(expanded.length);
            expect(hasExactKit(expanded, kit)).toBe(true);
            for (const spec of kit) {
                const entry = byId.get(spec.id);
                expect(entry, `${skill}:${spec.id}`).toBeDefined();
                expect(entry!.tradeable).toBe(true);
                expect(entry!.name).toBe(spec.name);
                expect(supplies[spec.id]).toBe(spec.count);
            }
        }
        expect(parseKitOption(['holder', 'spec'])).toBeNull();
        expect(parseKitOption(['holder', 'spec'], 'attack').name).toBe('attack');
        expect(() => parseKitOption(['--kit=bogus'])).toThrow('unknown --kit=bogus');
    });

    test('planner catalog treats specialist routes as bounded service intents even with skill accept targets', () => {
        for (const [script, skill] of [
            ['scripts/fletching-specialist.ts', 'fletching'],
            ['scripts/fishing-specialist.ts', 'fishing'],
            ['scripts/mining-specialist.ts', 'mining'],
            ['scripts/thieving-specialist.ts', 'thieving'],
        ] as const) {
            const intent = intentForEntry(script, ['botb'], {}, { skills: { [skill]: 99 } });
            expect(intent).toEqual({ kind: 'service', objective: `fresh-clock ${skill} 99 specialist`, units: 1 });
        }
    });
});
