import type { RateEstimate, WorkerAccountView, WorkerWorldView } from '../contracts';
import { COMBAT_SITES, estimateSetupTicks } from './preflight';
import { COMBAT_MODE_SET, type CombatConfig, type CombatMode } from './types';

type BaseRateSpec = {
    xpPerTick: number;
    skill: string;
    unitsPerTick: number;
    gpPerTick: number;
    minBatchUnits: number;
    riskPerHour?: number;
    outputsPerUnit?: Readonly<Record<number, number>>;
    inputsPerUnit?: Readonly<Record<number, number>>;
};

const BASE_RATES: Readonly<Record<CombatMode, BaseRateSpec>> = {
    chicken: { xpPerTick: 45, skill: 'Strength', unitsPerTick: 0.08, gpPerTick: 1, minBatchUnits: 10, outputsPerUnit: { 314: 10, 526: 1 } },
    cow: { xpPerTick: 85, skill: 'Strength', unitsPerTick: 0.06, gpPerTick: 2, minBatchUnits: 8, outputsPerUnit: { 1739: 1, 526: 1 } },
    druid: { xpPerTick: 110, skill: 'Attack', unitsPerTick: 0.05, gpPerTick: 12, minBatchUnits: 15, outputsPerUnit: { 207: 0.12, 563: 0.25 } },
    unicorn: { xpPerTick: 95, skill: 'Attack', unitsPerTick: 0.04, gpPerTick: 8, minBatchUnits: 4, outputsPerUnit: { 237: 1 } },
    wizard: { xpPerTick: 80, skill: 'Attack', unitsPerTick: 0.05, gpPerTick: 4, minBatchUnits: 20, outputsPerUnit: { 1444: 0.02 } },
    giant: { xpPerTick: 160, skill: 'Strength', unitsPerTick: 0.04, gpPerTick: 6, minBatchUnits: 15, outputsPerUnit: { 532: 1, 225: 0.1 } },
    trooper: { xpPerTick: 260, skill: 'Strength', unitsPerTick: 0.055, gpPerTick: 0, minBatchUnits: 20, outputsPerUnit: { 526: 1 } },
    taverley_druid: { xpPerTick: 115, skill: 'Attack', unitsPerTick: 0.05, gpPerTick: 14, minBatchUnits: 15, outputsPerUnit: { 207: 0.15, 211: 0.1 } },
    taverley_black_knight: { xpPerTick: 130, skill: 'Attack', unitsPerTick: 0.04, gpPerTick: 16, minBatchUnits: 15, outputsPerUnit: { 560: 0.15, 562: 0.25 } },
    taverley_scales: { xpPerTick: 15, skill: 'Hitpoints', unitsPerTick: 0.04, gpPerTick: 16, minBatchUnits: 20, outputsPerUnit: { 243: 1 } },
    taverley_blue_dragon: { xpPerTick: 150, skill: 'Attack', unitsPerTick: 0.02, gpPerTick: 22, minBatchUnits: 10, riskPerHour: 0.1, outputsPerUnit: { 536: 1, 1751: 1 } },
    taverley_black_dragon: { xpPerTick: 170, skill: 'Attack', unitsPerTick: 0.015, gpPerTick: 26, minBatchUnits: 5, riskPerHour: 0.12, outputsPerUnit: { 536: 1, 1747: 1 } },
    taverley_giant: { xpPerTick: 170, skill: 'Strength', unitsPerTick: 0.04, gpPerTick: 10, minBatchUnits: 15, outputsPerUnit: { 532: 1 } },
    chaos_wine: { xpPerTick: 65, skill: 'Magic', unitsPerTick: 0.04, gpPerTick: 22, minBatchUnits: 12, outputsPerUnit: { 245: 1 }, inputsPerUnit: { 563: 1 } },
    'fire-giant': { xpPerTick: 190, skill: 'Hitpoints', unitsPerTick: 0.025, gpPerTick: 10, minBatchUnits: 1, riskPerHour: 0.05, outputsPerUnit: { 532: 1 } },
    'fire-combat': { xpPerTick: 210, skill: 'Attack', unitsPerTick: 0.025, gpPerTick: 12, minBatchUnits: 1, riskPerHour: 0.08, outputsPerUnit: { 532: 1 } },
    imp: { xpPerTick: 25, skill: 'Attack', unitsPerTick: 0.05, gpPerTick: 1, minBatchUnits: 1, outputsPerUnit: { 592: 1 } },
    shade: { xpPerTick: 120, skill: 'Attack', unitsPerTick: 0.025, gpPerTick: 10, minBatchUnits: 1, riskPerHour: 0.06, outputsPerUnit: { 3404: 1 } },
    chompy: { xpPerTick: 85, skill: 'Ranged', unitsPerTick: 0.02, gpPerTick: 0, minBatchUnits: 1, outputsPerUnit: { 2876: 1, 314: 15 } },
    'chompy-at-site': { xpPerTick: 95, skill: 'Ranged', unitsPerTick: 0.025, gpPerTick: 0, minBatchUnits: 1, outputsPerUnit: { 2876: 1, 314: 15 } },
    ranged: { xpPerTick: 140, skill: 'Ranged', unitsPerTick: 0.05, gpPerTick: 0, minBatchUnits: 10, inputsPerUnit: { 884: 2 } },
    'ranged-starter': { xpPerTick: 90, skill: 'Ranged', unitsPerTick: 0.04, gpPerTick: 0, minBatchUnits: 5 },
    'ranged-gather': { xpPerTick: 125, skill: 'Ranged', unitsPerTick: 0.045, gpPerTick: 4, minBatchUnits: 10 },
    'ranged-camp': { xpPerTick: 165, skill: 'Ranged', unitsPerTick: 0.035, gpPerTick: 14, minBatchUnits: 5, riskPerHour: 0.04 },
    cannon: { xpPerTick: 450, skill: 'Ranged', unitsPerTick: 0.12, gpPerTick: -15, minBatchUnits: 25, riskPerHour: 0.12, inputsPerUnit: { 2: 2 } },
    'loot-trip': { xpPerTick: 0, skill: 'Hitpoints', unitsPerTick: 0.12, gpPerTick: 15, minBatchUnits: 10 },
    kbd: { xpPerTick: 140, skill: 'Attack', unitsPerTick: 0.012, gpPerTick: 20, minBatchUnits: 1, riskPerHour: 0.25, outputsPerUnit: { 536: 1, 1747: 1 } },
    'black-dragon': { xpPerTick: 160, skill: 'Ranged', unitsPerTick: 0.014, gpPerTick: 24, minBatchUnits: 1, riskPerHour: 0.08, outputsPerUnit: { 536: 1, 1747: 1 } },
    'blue-dragon': { xpPerTick: 150, skill: 'Ranged', unitsPerTick: 0.018, gpPerTick: 20, minBatchUnits: 4, riskPerHour: 0.1, outputsPerUnit: { 536: 1, 1751: 1 } },
    'green-dragon': { xpPerTick: 185, skill: 'Attack', unitsPerTick: 0.022, gpPerTick: 28, minBatchUnits: 4, riskPerHour: 0.35, outputsPerUnit: { 536: 1, 1753: 1 } },
    trawler: { xpPerTick: 35, skill: 'Crafting', unitsPerTick: 0.015, gpPerTick: 8, minBatchUnits: 1 },
    'trawler-at-site': { xpPerTick: 35, skill: 'Crafting', unitsPerTick: 0.02, gpPerTick: 0, minBatchUnits: 1 },
    'magic-order': { xpPerTick: 110, skill: 'Magic', unitsPerTick: 0.16, gpPerTick: -8, minBatchUnits: 10 },
    'magic-npc': { xpPerTick: 95, skill: 'Magic', unitsPerTick: 0.14, gpPerTick: -6, minBatchUnits: 1 },
    'magic-splash': { xpPerTick: 115, skill: 'Magic', unitsPerTick: 0.2, gpPerTick: -5, minBatchUnits: 20 },
    'magic-splash-coop': { xpPerTick: 65, skill: 'Magic', unitsPerTick: 0.18, gpPerTick: 0, minBatchUnits: 10 },
    'prayer-flick': { xpPerTick: 90, skill: 'Attack', unitsPerTick: 0.04, gpPerTick: 2, minBatchUnits: 1 },
};

export function combatEstimate(acct: WorkerAccountView, cfg: CombatConfig, _world: WorkerWorldView): RateEstimate {
    const mode: CombatMode = COMBAT_MODE_SET.has(cfg.mode) ? cfg.mode : 'cow';
    const site = COMBAT_SITES[mode];
    const spec = BASE_RATES[mode];
    const trainSkill = cfg.targetSkill ?? spec.skill;
    const relevantLevel = acct.skills[trainSkill]?.level ?? 1;
    const scale = 0.4 + 0.6 * Math.min(99, Math.max(1, relevantLevel)) / 99;
    const xpPerTick = Math.round(spec.xpPerTick * scale);
    const unitsPerTick = Number((spec.unitsPerTick * (0.6 + 0.4 * scale)).toFixed(4));
    const setupTicks = estimateSetupTicks(acct, site);

    return {
        xpPerTick,
        skillXpPerTick: xpPerTick > 0 ? { [trainSkill]: xpPerTick, Hitpoints: Math.round(xpPerTick * 0.33) } : undefined,
        unitsPerTick,
        gpPerTick: spec.gpPerTick,
        setupTicks,
        minBatchUnits: spec.minBatchUnits,
        ...(spec.riskPerHour !== undefined ? { riskPerHour: spec.riskPerHour } : {}),
        confidence: 'practice',
        ...(spec.outputsPerUnit ? { outputsPerUnit: spec.outputsPerUnit } : {}),
        ...(spec.inputsPerUnit ? { inputsPerUnit: spec.inputsPerUnit } : {}),
    };
}
