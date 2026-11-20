import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
    canPreClickNextObstacle,
    GNOME_TRADE_1,
    GNOME_TRADE_1_NOPRAY,
    inventorySlotsNeeded,
    ITEMS,
    MONKEYBARS_TRADE_1,
    MONKEYBARS_TRADE_1_NOPOT,
    nextWildernessProgress,
    resolveAgilityRouteConfig,
    shouldDrinkAgilityPotion,
    SMITH_TO_20_SEQUENCE,
    STACKABLE_IDS,
    startedWildernessObstacle,
    TOURIST_TRADE_1,
    TOURIST_TRADE_2,
    TOURIST_TRADE_3,
    trade1ForConfig,
} from './agility-specialist';
import { SPECIALIST_AGILITY_CASES, FRESH_TUTORIAL_START } from './measure/specialist-agility-cases';
import { benchCoverage } from './measure/aio-bench-cases';
import { intentForEntry } from '../packages/planner/src/progression-catalog';
import { xpForLevel } from '../packages/planner/src/curve';
import {
    AGILITY_SPECIALIST_KIT,
    parseKitArg,
    parseSupplierCliArgs,
    resolveSupplierKitPlan,
} from './specialist-supplier';

const ROOT = resolve(import.meta.dir, '..');

describe('Agility specialist supply bills and item IDs', () => {
    const items = JSON.parse(readFileSync(join(ROOT, 'knowledge/items.json'), 'utf8')) as {
        id: number; name: string; tradeable?: boolean; def?: { stackable?: boolean };
    }[];
    const byId = new Map(items.map(i => [i.id, i]));

    test('every trade batch and chocolate cake part exists in knowledge/items.json with exact tradeable ID', () => {
        for (const batch of [TOURIST_TRADE_1, TOURIST_TRADE_2, TOURIST_TRADE_3, MONKEYBARS_TRADE_1, MONKEYBARS_TRADE_1_NOPOT, GNOME_TRADE_1, GNOME_TRADE_1_NOPRAY]) {
            for (const entry of batch) {
                const row = byId.get(entry.id);
                expect(row, `item ${entry.id} (${entry.name})`).toBeDefined();
                expect(row!.name).toBe(entry.name);
                expect(row!.tradeable).toBe(true);
            }
        }
        for (const cakeId of ITEMS.chocolateCakeParts) {
            const row = byId.get(cakeId);
            expect(row).toBeDefined();
            expect(row!.tradeable).toBe(true);
        }
    });

    test('every trade batch and companion inventory fits within 28 slots and covers tourist bank demand', () => {
        expect(inventorySlotsNeeded(TOURIST_TRADE_1, STACKABLE_IDS)).toBeLessThanOrEqual(26);
        expect(inventorySlotsNeeded(TOURIST_TRADE_2, STACKABLE_IDS)).toBeLessThanOrEqual(25);
        expect(inventorySlotsNeeded(TOURIST_TRADE_3, STACKABLE_IDS)).toBeLessThanOrEqual(24);
        expect(inventorySlotsNeeded(MONKEYBARS_TRADE_1, STACKABLE_IDS)).toBe(28);
        expect(inventorySlotsNeeded(MONKEYBARS_TRADE_1_NOPOT, STACKABLE_IDS)).toBe(21);
        expect(inventorySlotsNeeded(GNOME_TRADE_1, STACKABLE_IDS)).toBe(28);
        expect(inventorySlotsNeeded(GNOME_TRADE_1_NOPRAY, STACKABLE_IDS)).toBe(28);
        expect(trade1ForConfig({ route: 'gnome', usePrayer: false })).toEqual(GNOME_TRADE_1_NOPRAY);
        expect(trade1ForConfig({ route: 'monkeybars', usePrayer: true, usePotion: false })).toEqual(MONKEYBARS_TRADE_1_NOPOT);

        for (const bench of SPECIALIST_AGILITY_CASES) {
            for (const c of bench.companions ?? []) {
                expect(c.presetConfig?.inventory?.length ?? 0).toBeLessThanOrEqual(28);
            }
        }
        const touristCase = SPECIALIST_AGILITY_CASES.find(c => c.scriptArgs.some(a => a.includes('tourist')))!;
        const touristBank = new Map<number, number>(
            (touristCase?.companions?.[0]?.presetConfig?.bank ?? []).map(b => [b.id, b.count]),
        );
        const need = new Map<number, number>();
        for (const batch of [TOURIST_TRADE_2, TOURIST_TRADE_3]) {
            for (const entry of batch) need.set(entry.id, (need.get(entry.id) ?? 0) + entry.count);
        }
        for (const [id, req] of need) {
            expect(touristBank.get(id) ?? 0, `bank short on item ${id}`).toBeGreaterThanOrEqual(req);
        }
    });
});

describe('Setup XP curves and threshold calculations', () => {
    test('skill setup targets exceed 25x level requirements cleanly', () => {
        // 10 bronze bars smithed -> 3,125 XP >= Level 20 (3,105 XP)
        expect(10 * 12.5 * 25).toBeGreaterThanOrEqual(xpForLevel(20));
        expect(SMITH_TO_20_SEQUENCE.at(-1)!.targetXp).toBe(3105);
        // 150 headless + 150 bronze arrowtips -> 10 actions * 19.5 * 25 = 4,875 XP >= Level 20 (3,105 XP)
        expect(10 * 19.5 * 25).toBeGreaterThanOrEqual(xpForLevel(20));
        // 11 dragon bones -> 11 * 72 * 25 = 19,800 XP >= Level 43 (19,684 XP)
        expect(11 * 72 * 25).toBeGreaterThanOrEqual(xpForLevel(43));
        // Imp Catcher (875 * 25 = 21,875 XP) + 1 Emerald ring enchant (37 * 25 = 925 XP) >= Level 35 (22,406 XP)
        expect(875 * 25 + 37 * 25).toBeGreaterThanOrEqual(xpForLevel(35));
    });
});

describe('Wilderness pre-clicks, progress transitions, and Agility potion logic', () => {
    test('recognizes start tiles for all 5 Wilderness obstacles including rocks', () => {
        expect(startedWildernessObstacle('pipe', { worldX: 3004, worldZ: 3940 })).toBe(true);
        expect(startedWildernessObstacle('ropeswing', { worldX: 3005, worldZ: 3953 })).toBe(true);
        expect(startedWildernessObstacle('stones', { worldX: 3000, worldZ: 3960 })).toBe(true);
        expect(startedWildernessObstacle('log', { worldX: 2998, worldZ: 3945 })).toBe(true);
        expect(startedWildernessObstacle('rocks', { worldX: 2994, worldZ: 3935 })).toBe(true);
        expect(startedWildernessObstacle('rocks', { worldX: 2994, worldZ: 3933 })).toBe(true);
        expect(startedWildernessObstacle('pipe', { worldX: 3004, worldZ: 3937 })).toBe(false);
    });

    test('recognizes arrival and transition zones for pre-clicking next obstacle', () => {
        expect(canPreClickNextObstacle('pipe', { worldX: 3004, worldZ: 3949 })).toBe(true);
        expect(canPreClickNextObstacle('pipe', { worldX: 3004, worldZ: 3940 })).toBe(false);
        expect(canPreClickNextObstacle('ropeswing', { worldX: 3005, worldZ: 3958 })).toBe(true);
        expect(canPreClickNextObstacle('stones', { worldX: 2996, worldZ: 3960 })).toBe(true);
        expect(canPreClickNextObstacle('log', { worldX: 2994, worldZ: 3945 })).toBe(true);
        expect(canPreClickNextObstacle('rocks', { worldX: 2994, worldZ: 3934 })).toBe(true);
    });

    test('tracks %wilderness_course_progress increments and resets after rocks', () => {
        let p = 0;
        p = nextWildernessProgress(p, 'pipe');
        expect(p).toBe(1);
        p = nextWildernessProgress(p, 'stones');
        expect(p).toBe(1); // Cannot skip ropeswing
        p = nextWildernessProgress(p, 'ropeswing');
        p = nextWildernessProgress(p, 'stones');
        p = nextWildernessProgress(p, 'log');
        expect(p).toBe(4);
        p = nextWildernessProgress(p, 'rocks');
        expect(p).toBe(0);
    });

    test('triggers +3 Agility potion before ridge gate < 52 and maintains >= +2 boost', () => {
        expect(shouldDrinkAgilityPotion(49, 49, true)).toBe(true);
        expect(shouldDrinkAgilityPotion(50, 51, true)).toBe(true);
        expect(shouldDrinkAgilityPotion(49, 52, true)).toBe(false);
        expect(shouldDrinkAgilityPotion(55, 57, false)).toBe(true);
        expect(shouldDrinkAgilityPotion(55, 58, false)).toBe(false);
        expect(shouldDrinkAgilityPotion(77, 77, false)).toBe(true);
        expect(shouldDrinkAgilityPotion(77, 78, false)).toBe(true);
        expect(shouldDrinkAgilityPotion(77, 79, false)).toBe(false);
        expect(shouldDrinkAgilityPotion(97, 98, false)).toBe(false);
        expect(shouldDrinkAgilityPotion(99, 99, false)).toBe(false);
    });
});

describe('Route config, AIO catalog, and bench coverage', () => {
    test('parses env and CLI overrides consistently', () => {
        expect(resolveAgilityRouteConfig('Polevaulter', [], {})).toEqual({
            route: 'monkeybars',
            usePotion: true,
            usePrayer: true,
            alignPipe: false,
            cap: 9000,
            supplier: 'Polevaulterb',
        });
        expect(resolveAgilityRouteConfig('test1', ['test1b', 'AGI_ROUTE=monkeybars', 'AGI_POTION=0', 'CAP=7500'], {})).toEqual({
            route: 'monkeybars',
            usePotion: false,
            usePrayer: true,
            alignPipe: false,
            cap: 7500,
            supplier: 'test1b',
        });
    });

    test('registers skiller:agility:specialist across catalog, intentForEntry, and bench coverage', () => {
        expect(intentForEntry('scripts/agility-specialist.ts', [], {})).toEqual({
            kind: 'service',
            objective: 'skiller:agility:specialist',
            units: 1,
        });
        expect(intentForEntry('scripts/agility-specialist.ts', [], {}, { skills: { Agility: 99 } })).toEqual({
            kind: 'service',
            objective: 'skiller:agility:specialist',
            units: 1,
        });
        expect(benchCoverage().gaps).toEqual([]);
        const mainCase = SPECIALIST_AGILITY_CASES.find(c => c.key === 'skiller:agility:specialist')!;
        expect(mainCase.pass('LOGOUT logged-out\nRESULT ok route=tourist agility=1->99 ticks=5100')).toBe(true);
        expect(mainCase.pass('LOGOUT logged-out\nRESULT ok route=tourist agility=1->98 ticks=9000')).toBe(false);
        expect(mainCase.pass('RESULT ok route=tourist agility=1->99 ticks=5100')).toBe(false);

        const extCase = SPECIALIST_AGILITY_CASES.find(c => c.key === 'extra:specialist-agility')!;
        expect(extCase).toBeDefined();
        expect(extCase.script).toBe('scripts/measure/specialist-bench.ts');
        expect(extCase.pass('LOGOUT logged-out\nRESULT ok route=monkeybars agility=1->99 ticks=5800')).toBe(true);
    });

    test('every bench case in SPECIALIST_AGILITY_CASES starts at FRESH_TUTORIAL_START', () => {
        for (const bench of SPECIALIST_AGILITY_CASES) {
            expect(bench.presetConfig).toEqual(FRESH_TUTORIAL_START);
        }
    });

    test('specialist-supplier supports agility kit via CLI and inventory match', () => {
        expect(parseKitArg(['--kit=agility'])).toBe('agility');
        expect(parseSupplierCliArgs(['Holder', 'Polevaulter', '--kit=agility'])).toEqual({
            kitArg: 'agility',
            cap: undefined,
            outArg: undefined,
            bankX: undefined,
            bankZ: undefined,
            positional: ['Holder', 'Polevaulter'],
        });
        const plan = resolveSupplierKitPlan('agility');
        expect(plan.name).toBe('agility');
        expect(plan.combined).toEqual(AGILITY_SPECIALIST_KIT);
        expect(plan.legs.length).toBe(1);
    });

    test('agility-specialist task consumer threshold is tightened to 6,031 ticks', () => {
        const taskPath = join(ROOT, 'packages/router/tasks/agility-specialist.json');
        const task = JSON.parse(readFileSync(taskPath, 'utf8'));
        expect(task.consumer).toContain('within 6,031 ticks');
    });
});
