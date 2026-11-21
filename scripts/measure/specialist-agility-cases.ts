// Practice bench cases for the Agility specialist levers (scripts/agility-specialist.ts).
import type { BenchCase } from './aio-bench-cases';
import type { SaveConfig } from '../../packages/practice/src/presets';
import {
    ITEMS,
    TOURIST_TRADE_1,
    MONKEYBARS_TRADE_1,
    MONKEYBARS_TRADE_1_NOPOT,
    GNOME_TRADE_1,
    GNOME_TRADE_1_NOPRAY,
    STACKABLE_IDS,
    type SupplyEntry,
} from '../agility-specialist';

const ok = (s: string) => /^RESULT ok\b/m.test(s) && /\bagility=1->99\b/.test(s) && s.includes('LOGOUT logged-out');

function expandInventory(entries: readonly SupplyEntry[]): { id: number; count: number }[] {
    const out: { id: number; count: number }[] = [];
    for (const e of entries) {
        if (STACKABLE_IDS.has(e.id)) out.push({ id: e.id, count: e.count });
        else for (let k = 0; k < e.count; k++) out.push({ id: e.id, count: 1 });
    }
    return out;
}

export const FRESH_TUTORIAL_START: SaveConfig = {
    position: { x: 3094, z: 3106, level: 0 },
    varps: { 281: 0 },
};

const TOURIST_COMPANION = {
    suffix: 'b',
    preset: 'fresh_lumbridge',
    presetConfig: {
        position: { x: 3222, z: 3219, level: 0 },
        skills: { Hitpoints: 99, Prayer: 43, Magic: 99, Agility: 52 },
        inventory: [
            ...expandInventory(TOURIST_TRADE_1),
            { id: ITEMS.glory4, count: 1 },
            { id: ITEMS.superEnergy4, count: 1 },
        ],
        bank: [
            { id: ITEMS.bronzeBar, count: 22 },
            { id: ITEMS.hammer, count: 1 },
            { id: ITEMS.desertShirt, count: 1 },
            { id: ITEMS.desertRobe, count: 1 },
            { id: ITEMS.desertBoots, count: 1 },
            { id: ITEMS.shantayPass, count: 2 },
            { id: ITEMS.waterskin4, count: 2 },
            { id: ITEMS.feather, count: 200 },
            { id: ITEMS.prayerPot4, count: 6 },
            { id: ITEMS.pineapplePizza, count: 6 },
            { id: ITEMS.shark, count: 8 },
            { id: ITEMS.chocolateCake, count: 7 },
            { id: ITEMS.agilityPot4, count: 8 },
            { id: ITEMS.superEnergy4, count: 12 },
        ],
    },
};

export const SPECIALIST_AGILITY_CASES: BenchCase[] = [
    {
        key: 'skiller:agility:specialist',
        script: 'scripts/agility-specialist.ts',
        preset: 'fresh_lumbridge',
        presetConfig: FRESH_TUTORIAL_START,
        scriptArgs: ['{bot:b}', 'AGI_ROUTE=monkeybars', 'AGI_POTION=1', 'AGI_PRAY=1', 'AGI_PIPE_ALIGN=0'],
        companions: [{
            suffix: 'b',
            preset: 'fresh_lumbridge',
            presetConfig: {
                position: { x: 3222, z: 3219, level: 0 },
                inventory: expandInventory(MONKEYBARS_TRADE_1),
            },
        }],
        pass: ok,
        timeoutMs: 900_000,
    },
    {
        key: 'extra:specialist-agility',
        script: 'scripts/measure/specialist-bench.ts',
        preset: 'fresh_lumbridge',
        presetConfig: FRESH_TUTORIAL_START,
        companions: [{
            suffix: 's',
            preset: 'fresh_lumbridge',
            presetConfig: {
                position: { x: 3222, z: 3222, level: 0 },
                inventory: expandInventory(MONKEYBARS_TRADE_1),
            },
        }],
        scriptArgs: ['{bot:s}', 'scripts/agility-specialist.ts', 'SUPPLIER_EXTERNAL=1', 'SUPPLIER_KIT=agility', 'AGI_ROUTE=monkeybars', 'AGI_POTION=1', 'AGI_PRAY=1', 'AGI_PIPE_ALIGN=0'],
        pass: ok,
        timeoutMs: 900_000,
    },
    {
        key: 'extra:agility-specialist-monkeybars',
        script: 'scripts/agility-specialist.ts',
        preset: 'fresh_lumbridge',
        presetConfig: FRESH_TUTORIAL_START,
        scriptArgs: ['{bot:b}', 'AGI_ROUTE=monkeybars', 'AGI_POTION=1', 'AGI_PRAY=1', 'AGI_PIPE_ALIGN=1'],
        companions: [{
            suffix: 'b',
            preset: 'fresh_lumbridge',
            presetConfig: {
                position: { x: 3222, z: 3219, level: 0 },
                inventory: expandInventory(MONKEYBARS_TRADE_1),
            },
        }],
        pass: ok,
        timeoutMs: 900_000,
    },
    {
        key: 'extra:agility-specialist-gnome',
        script: 'scripts/agility-specialist.ts',
        preset: 'fresh_lumbridge',
        presetConfig: FRESH_TUTORIAL_START,
        scriptArgs: ['{bot:b}', 'AGI_ROUTE=gnome', 'AGI_POTION=1', 'AGI_PRAY=1', 'AGI_PIPE_ALIGN=1'],
        companions: [{
            suffix: 'b',
            preset: 'fresh_lumbridge',
            presetConfig: {
                position: { x: 3222, z: 3219, level: 0 },
                inventory: expandInventory(GNOME_TRADE_1),
            },
        }],
        pass: ok,
        timeoutMs: 900_000,
    },
    {
        key: 'extra:agility-specialist-nopray',
        script: 'scripts/agility-specialist.ts',
        preset: 'fresh_lumbridge',
        presetConfig: FRESH_TUTORIAL_START,
        scriptArgs: ['{bot:b}', 'AGI_ROUTE=gnome', 'AGI_POTION=1', 'AGI_PRAY=0', 'AGI_PIPE_ALIGN=1'],
        companions: [{
            suffix: 'b',
            preset: 'fresh_lumbridge',
            presetConfig: {
                position: { x: 3222, z: 3219, level: 0 },
                inventory: expandInventory(GNOME_TRADE_1_NOPRAY),
            },
        }],
        pass: ok,
        timeoutMs: 900_000,
    },
    {
        key: 'extra:agility-specialist-nopot',
        script: 'scripts/agility-specialist.ts',
        preset: 'fresh_lumbridge',
        presetConfig: FRESH_TUTORIAL_START,
        scriptArgs: ['{bot:b}', 'AGI_ROUTE=monkeybars', 'AGI_POTION=0', 'AGI_PRAY=1', 'AGI_PIPE_ALIGN=1'],
        companions: [{
            suffix: 'b',
            preset: 'fresh_lumbridge',
            presetConfig: {
                position: { x: 3222, z: 3219, level: 0 },
                inventory: expandInventory(MONKEYBARS_TRADE_1_NOPOT),
            },
        }],
        pass: ok,
        timeoutMs: 900_000,
    },
    {
        key: 'extra:agility-specialist-noalign',
        script: 'scripts/agility-specialist.ts',
        preset: 'fresh_lumbridge',
        presetConfig: FRESH_TUTORIAL_START,
        scriptArgs: ['{bot:b}', 'AGI_ROUTE=monkeybars', 'AGI_POTION=1', 'AGI_PRAY=1', 'AGI_PIPE_ALIGN=0'],
        companions: [{
            suffix: 'b',
            preset: 'fresh_lumbridge',
            presetConfig: {
                position: { x: 3222, z: 3219, level: 0 },
                inventory: expandInventory(MONKEYBARS_TRADE_1),
            },
        }],
        pass: ok,
        timeoutMs: 900_000,
    },
    {
        key: 'extra:agility-specialist-tourist',
        script: 'scripts/agility-specialist.ts',
        preset: 'fresh_lumbridge',
        presetConfig: FRESH_TUTORIAL_START,
        scriptArgs: ['{bot:b}', 'AGI_ROUTE=tourist', 'AGI_POTION=1', 'AGI_PRAY=1', 'AGI_PIPE_ALIGN=0'],
        companions: [TOURIST_COMPANION],
        pass: ok,
        timeoutMs: 900_000,
    },
];
