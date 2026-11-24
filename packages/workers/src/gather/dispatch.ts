// Skill dispatcher for unified WorkerModule<GatherConfig> sessions and CLI runs.
import type { Session } from '../../../core/src/inprocess';
import {
    GATHER_METHOD_MAP,
    type GatherConfig,
    type GatherSessionOutcome,
    VALID_GATHER_SKILLS,
    normalizeGatherConfig,
} from './types';

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
            return (await import('./fishing')).runFishingSession(s, cfg, stop);
        case 'woodcutting':
            return (await import('./woodcutting')).runWoodcuttingSession(s, cfg, stop);
        case 'mining':
            return (await import('./mining')).runMiningSession(s, cfg, stop);
        case 'thieving':
            return (await import('./thieving')).runThievingSession(s, cfg, stop);
        case 'foraging':
            return (await import('./foraging')).runForagingSession(s, cfg, stop);
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
            return (await import('./fishing')).runFishingCli(account, cfg);
        case 'woodcutting':
            return (await import('./woodcutting')).runWoodcuttingCli(account, cfg);
        case 'mining':
            return (await import('./mining')).runMiningCli(account, cfg);
        case 'thieving':
            return (await import('./thieving')).runThievingCli(account, cfg);
        case 'foraging':
            return (await import('./foraging')).runForagingCli(account, cfg);
    }
}
