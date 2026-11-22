// Skill dispatcher for unified WorkerModule<GatherConfig> sessions and CLI runs.
import type { Session } from '../../../core/src/inprocess';
import { runFishingCli, runFishingSession } from './fishing';
import { runForagingCli, runForagingSession } from './foraging';
import { runMiningCli, runMiningSession } from './mining';
import { runThievingCli, runThievingSession } from './thieving';
import {
    GATHER_METHOD_MAP,
    type GatherConfig,
    type GatherSessionOutcome,
    VALID_GATHER_SKILLS,
    normalizeGatherConfig,
} from './types';
import { runWoodcuttingCli, runWoodcuttingSession } from './woodcutting';

export async function runGather(
    s: Session,
    rawCfg: GatherConfig,
    stop: () => boolean = () => false,
): Promise<GatherSessionOutcome> {
    const cfg = normalizeGatherConfig(rawCfg);
    if (!VALID_GATHER_SKILLS.includes(cfg.skill)) {
        return {
            ok: false,
            kind: 'refused',
            detail: `unknown gather skill: ${String(rawCfg.skill)}`,
            delta: { elapsedTicks: 0 },
            recoverable: false,
        };
    }
    if (!GATHER_METHOD_MAP[cfg.skill].includes(cfg.method)) {
        return {
            ok: false,
            kind: 'refused',
            detail: `unknown ${cfg.skill} method: ${String(rawCfg.method)}`,
            delta: { elapsedTicks: 0 },
            recoverable: false,
        };
    }
    switch (cfg.skill) {
        case 'fishing':
            return runFishingSession(s, cfg, stop);
        case 'woodcutting':
            return runWoodcuttingSession(s, cfg, stop);
        case 'mining':
            return runMiningSession(s, cfg, stop);
        case 'thieving':
            return runThievingSession(s, cfg, stop);
        case 'foraging':
            return runForagingSession(s, cfg, stop);
    }
}

export async function runGatherCli(account: string, rawCfg: GatherConfig): Promise<number> {
    const cfg = normalizeGatherConfig(rawCfg);
    if (!VALID_GATHER_SKILLS.includes(cfg.skill)) {
        throw Error(`unknown gather skill: ${String(rawCfg.skill)}`);
    }
    if (!GATHER_METHOD_MAP[cfg.skill].includes(cfg.method)) {
        throw Error(`unknown ${cfg.skill} method: ${String(rawCfg.method)}`);
    }
    switch (cfg.skill) {
        case 'fishing':
            return runFishingCli(account, cfg);
        case 'woodcutting':
            return runWoodcuttingCli(account, cfg);
        case 'mining':
            return runMiningCli(account, cfg);
        case 'thieving':
            return runThievingCli(account, cfg);
        case 'foraging':
            return runForagingCli(account, cfg);
    }
}
