// Overall 1-tick PvP relog combat practice cases (Strength, Attack, Defence, Ranged 1->99 at Deserted Keep).
import type { SaveConfig } from '../../packages/practice/src/presets';
import type { BenchCase } from './bench-case-types';

const PVP_TANK_SKILLS: SaveConfig['skills'] = {
    Attack: 78,
    Strength: 78,
    Defence: 1,
    Hitpoints: 99,
    Prayer: 1,
    Magic: 1,
    Ranged: 1,
};

function pvpTankPresetConfig(index: number): SaveConfig {
    return {
        position: index % 2 === 0 ? { x: 3155, z: 3924, level: 0 } : { x: 3154, z: 3923, level: 0 },
        skills: PVP_TANK_SKILLS,
        varps: { 172: 1 }, // Disable auto-retaliate so wave tanks never counter-attack.
        inventory: [
            { id: 3016, count: 1 }, // Super energy(4)
            ...Array.from({ length: 27 }, () => ({ id: 391, count: 1 })), // Manta ray
        ],
        equipment: [{ id: 1381, count: 1, slot: 3 }], // Staff of air
        bank: [
            { id: 391, count: 5000 }, // Manta ray
            { id: 3016, count: 200 }, // Super energy(4)
            { id: 563, count: 100 }, // Law rune
            { id: 2552, count: 50 }, // Ring of dueling(8)
        ],
    };
}

const MELEE_PVP_INV: SaveConfig['inventory'] = [
    { id: 1309, count: 1 }, // Iron 2h sword
    { id: 1311, count: 1 }, // Steel 2h sword
    { id: 1313, count: 1 }, // Black 2h sword
    { id: 1315, count: 1 }, // Mithril 2h sword
    { id: 1317, count: 1 }, // Adamant 2h sword
    { id: 1319, count: 1 }, // Rune 2h sword
    { id: 1725, count: 1 }, // Amulet of strength
    { id: 3105, count: 1 }, // Climbing boots
];

const RANGED_PVP_EQUIP: SaveConfig['equipment'] = [
    { id: 837, count: 1, slot: 3 },    // Crossbow (1->39; no Ranged lvl req)
    { id: 881, count: 5000, slot: 13 }, // Barbed bolts (+46 rangeStr)
    { id: 1704, count: 1, slot: 2 },   // Amulet of glory
    { id: 1167, count: 1, slot: 0 },   // Leather cowl
    { id: 1129, count: 1, slot: 4 },   // Leather body
    { id: 1061, count: 1, slot: 10 },  // Leather boots
    { id: 1063, count: 1, slot: 9 },   // Leather vambraces
    { id: 1095, count: 1, slot: 7 },   // Leather chaps
];

const RANGED_PVP_INV: SaveConfig['inventory'] = [
    { id: 857, count: 1 }, // Yew shortbow (lvl 40)
    { id: 861, count: 1 }, // Magic shortbow (lvl 50)
    { id: 892, count: 5000 }, // Rune arrow (lvl 40)
    { id: 1169, count: 1 }, // Coif
    { id: 1133, count: 1 }, // Studded body
    { id: 1065, count: 1 }, // Green d'hide vambraces
    { id: 2487, count: 1 }, // Blue d'hide vambraces
    { id: 2489, count: 1 }, // Red d'hide vambraces
    { id: 2491, count: 1 }, // Black d'hide vambraces
    { id: 1099, count: 1 }, // Green d'hide chaps
    { id: 2493, count: 1 }, // Blue d'hide chaps
    { id: 2495, count: 1 }, // Red d'hide chaps
    { id: 2497, count: 1 }, // Black d'hide chaps
    { id: 2499, count: 1 }, // Blue d'hide body
    { id: 2501, count: 1 }, // Red d'hide body
    { id: 2503, count: 1 }, // Black d'hide body
];

const passPvp = (skill: string, level: number) => (s: string): boolean =>
    /^RESULT ok\b/m.test(s)
    && /^LOGOUT (?:logged-out ?)+$/m.test(s)
    && new RegExp(`\\bskill=${skill}\\b`).test(s)
    && new RegExp(`\\blevel=${level}\\b`).test(s)
    && /\btotalTicks=\d+/.test(s);

function companionsOf(suffixes: readonly string[]): BenchCase['companions'] {
    return suffixes.map((suffix, i) => ({
        suffix,
        preset: 'tutorial_done',
        presetConfig: pvpTankPresetConfig(i),
    }));
}

export const OVERALL_PVP_CASES: BenchCase[] = [
    {
        key: 'extra:overall-pvp-attack-40',
        engineEnv: { NODE_MEMBERS: 'true' },
        script: 'scripts/pvp-relog-combat.ts',
        preset: 'tutorial_done',
        presetConfig: {
            position: { x: 3154, z: 3924, level: 0 },
            skills: { Attack: 1, Strength: 1, Defence: 1, Hitpoints: 10, Prayer: 43, Magic: 80, Ranged: 1 },
            varps: { 172: 1 },
            inventory: MELEE_PVP_INV,
        },
        companions: companionsOf(['t', 'u', 'v', 'w', 'x']),
        scriptArgs: ['attack', '40', 'TANKS={bot}t,{bot}u,{bot}v,{bot}w,{bot}x', '--own-tanks', 'CAP=800'],
        timeoutMs: 300_000,
        output: /\btotalTicks=(\d+)/,
        pass: passPvp('Attack', 40),
    },
    {
        key: 'extra:overall-pvp-strength',
        engineEnv: { NODE_MEMBERS: 'true' },
        script: 'scripts/pvp-relog-combat.ts',
        preset: 'tutorial_done',
        presetConfig: {
            position: { x: 3154, z: 3924, level: 0 },
            skills: { Attack: 40, Strength: 1, Defence: 1, Hitpoints: 40, Prayer: 43, Magic: 80, Ranged: 1 },
            varps: { 172: 1 },
            inventory: MELEE_PVP_INV,
        },
        companions: companionsOf(['t', 'u', 'v', 'w', 'x']),
        scriptArgs: ['strength', '99', 'TANKS={bot}t,{bot}u,{bot}v,{bot}w,{bot}x', '--own-tanks', 'CAP=2000'],
        timeoutMs: 600_000,
        output: /\btotalTicks=(\d+)/,
        pass: passPvp('Strength', 99),
    },
    {
        key: 'extra:overall-pvp-attack',
        engineEnv: { NODE_MEMBERS: 'true' },
        script: 'scripts/pvp-relog-combat.ts',
        preset: 'tutorial_done',
        presetConfig: {
            position: { x: 3154, z: 3924, level: 0 },
            skills: { Attack: 1, Strength: 99, Defence: 1, Hitpoints: 80, Prayer: 43, Magic: 80, Ranged: 1 },
            varps: { 172: 1 },
            inventory: MELEE_PVP_INV,
        },
        companions: companionsOf(['t', 'u', 'v', 'w', 'x']),
        scriptArgs: ['attack', '99', 'TANKS={bot}t,{bot}u,{bot}v,{bot}w,{bot}x', '--own-tanks', 'CAP=2000'],
        timeoutMs: 600_000,
        output: /\btotalTicks=(\d+)/,
        pass: passPvp('Attack', 99),
    },
    {
        key: 'extra:overall-pvp-defence',
        engineEnv: { NODE_MEMBERS: 'true' },
        script: 'scripts/pvp-relog-combat.ts',
        preset: 'tutorial_done',
        presetConfig: {
            position: { x: 3154, z: 3924, level: 0 },
            skills: { Attack: 99, Strength: 99, Defence: 1, Hitpoints: 80, Prayer: 43, Magic: 80, Ranged: 1 },
            varps: { 172: 1 },
            inventory: MELEE_PVP_INV,
        },
        companions: companionsOf(['t', 'u', 'v', 'w', 'x']),
        scriptArgs: ['defence', '99', 'TANKS={bot}t,{bot}u,{bot}v,{bot}w,{bot}x', '--own-tanks', 'CAP=2000'],
        timeoutMs: 900_000,
        output: /\btotalTicks=(\d+)/,
        pass: passPvp('Defence', 99),
    },
    {
        key: 'extra:overall-pvp-ranged',
        engineEnv: { NODE_MEMBERS: 'true' },
        script: 'scripts/pvp-relog-combat.ts',
        preset: 'tutorial_done',
        presetConfig: {
            position: { x: 3154, z: 3924, level: 0 },
            skills: { Attack: 99, Strength: 99, Defence: 99, Hitpoints: 88, Prayer: 43, Magic: 80, Ranged: 1 },
            varps: { 172: 1 },
            equipment: RANGED_PVP_EQUIP,
            inventory: RANGED_PVP_INV,
        },
        companions: companionsOf(['t', 'u', 'v', 'w', 'x']),
        scriptArgs: ['ranged', '99', 'TANKS={bot}t,{bot}u,{bot}v,{bot}w,{bot}x', '--own-tanks', 'CAP=2000'],
        timeoutMs: 900_000,
        output: /\btotalTicks=(\d+)/,
        pass: passPvp('Ranged', 99),
    },
];
