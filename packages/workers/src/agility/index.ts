// Unified WorkerModule<AgilityConfig> entrypoint, CLI wrapper, and preserved compatibility exports.
import { basename } from 'node:path';
import { finish as defaultFinish, openBot as defaultOpenBot } from '../../../core/src/bot';
import type { Session } from '../../../core/src/inprocess';
import {
    type RunOutcome,
    type SessionCore,
    type WorkerAccountView,
    type WorkerModule,
    type WorkerWorldView,
} from '../contracts';
import { agilityOptions } from './courses';
import { agilityEstimate, evaluateAgilityPreflight, toAgilityWorkerOutcome } from './preflight';
import { runAgility, runAgilitySession } from './runner';
import {
    type AgilityConfig,
    type AgilityExternalDeps,
    normalizeAgilityConfig,
} from './types';

export const agilityWorker: WorkerModule<AgilityConfig, WorkerAccountView, WorkerWorldView, SessionCore> = {
    id: 'agility:unified',
    family: 'agility',
    kind: 'train',
    trust: 'practice_passed',
    protectedAllowed: false,

    preflight(acct, cfg, world) {
        return evaluateAgilityPreflight(acct, cfg, world);
    },

    estimate(acct, cfg, world) {
        return agilityEstimate(acct, cfg, world);
    },

    async run(session, cfg): Promise<RunOutcome> {
        const s = session as Session;
        const norm = normalizeAgilityConfig(cfg);
        const startTick = s.tick?.() ?? 0;
        let ended = false;
        void s.ended?.then(() => { ended = true; });
        const outcome = await runAgilitySession(s, {
            ...norm,
            stop: () => ended || Boolean(norm.stop?.()),
        });
        const elapsed = Math.max(0, (s.tick?.() ?? startTick) - startTick);
        return toAgilityWorkerOutcome(outcome, s.name ?? 'unknown', norm, elapsed);
    },
};

export async function runAgilityCli(
    argv: readonly string[],
    env: Readonly<Record<string, string | undefined>> = process.env,
    deps: AgilityExternalDeps = {},
): Promise<number> {
    const positionals = argv.filter(a => !a.includes('=') && !a.startsWith('--'));
    const [name, rawCourse, rawTarget] = positionals;
    const courseArg = rawCourse ?? env.AGI_COURSE ?? env.COURSE;
    const targetArg = rawTarget ?? env.TARGET_LEVEL ?? env.TARGET;
    if (!name || !courseArg || !targetArg || !/^[a-z0-9]{1,12}$/i.test(name)) {
        throw Error('usage: agility-order.ts <account> <course> <target> [--save=<own-save>]');
    }
    const o = agilityOptions(courseArg, targetArg, env);
    const saveArg = argv.find(a => a.startsWith('--save='))?.slice(7);
    if (saveArg) {
        if (basename(saveArg).toLowerCase() !== `${name.toLowerCase()}.sav`) {
            throw Error('save must belong to account');
        }
        if (!deps.readSave) throw Error('--save inspection requires save reader dependency');
        const saved = deps.readSave(saveArg);
        o.barcrawl = saved.vars[77] ?? 0;
    }

    const open = deps.openBot ?? defaultOpenBot;
    const fin = deps.finish ?? defaultFinish;
    let s: Session | undefined;
    let stopped = false;
    try {
        s = await open(name, { onStop: async () => { stopped = true; } });
        const result = await runAgility(s, { ...o, stop: () => stopped });
        console.log('AGILITY_ORDER_RESULT ' + JSON.stringify(result));
        await fin([s], true, `agility-order ${result.course} level=${result.level} target=${result.target} xp=${result.xpGained}`);
        return 0;
    } catch (error) {
        await fin(s ? [s] : [], false, String(error));
        return 1;
    }
}

export * from './types';
export {
    BRIMHAVEN_ARENA,
    COURSES,
    EAT_DELAY_TICKS,
    OBSTACLE_SETTLE,
    SUPPORTED_AGILITY_COURSES,
    agilityOptions,
    agilityPreflight,
    eatReady,
    inBrimhavenArena,
    inBrimhavenPit,
    onCourse,
    progressiveCourseForLevel,
    resumeStep,
    wildernessStarted,
    type Pos,
} from './courses';
export {
    DRAYNOR_ENTRY,
    STRONGHOLD_GATE,
    brimhavenPaid,
    buyEntryFood,
    crossStrongholdGate,
    draynorFunds,
    gnomeApproachRoute,
    gnomeEntry,
    needsCourseApproach,
    payBrimhavenFee,
    travelAgilityEntry,
    type EntryFoodDeps,
    type EntryTravelControls,
    type GateDeps,
    type Point,
} from './entry';
export { runAgility, runAgilitySession } from './runner';
export { agilityEstimate, evaluateAgilityPreflight, toAgilityWorkerOutcome } from './preflight';
