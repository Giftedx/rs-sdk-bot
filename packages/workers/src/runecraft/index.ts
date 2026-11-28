// Unified WorkerModule<RunecraftConfig> entrypoint, CLI wrapper, and runecraft compatibility exports.
import { existsSync, readFileSync } from 'node:fs';
import { countItems, finish as defaultFinish, openBot as defaultOpenBot } from '../../../core/src/bot';
import type { Session } from '../../../core/src/inprocess';
import {
    type RunOutcome,
    type SessionCore,
    type WorkerAccountView,
    type WorkerModule,
    type WorkerWorldView,
} from '../contracts';
import { isStopFilePresent, watchWorkerStop } from '../stop';
import { craftAirRunes, exitAirAltar } from './air';
import { carrierAltar, insideAirAltar } from './altars';
import { runeBankOptions, runeBankTarget, runRuneBankCraft } from './bank-craft';
import { runeCarrierMeasurePacks, runeCarrierRoster, runeCarrierStaged } from './carrier-roster';
import { mainRuneStage } from './carrier-stage';
import { runRuneCarriers } from './carriers';
import { runecraftEstimate, runecraftPreflight, toRunecraftWorkerOutcome } from './preflight';
import { natureRouteJob, runNatureTrips } from './shilo';
import { runRuneSupply, runeSupplyTarget } from './supply';
import {
    type NatureJob,
    type NormalizedRunecraftConfig,
    type RunecraftConfig,
    type RunecraftExternalDeps,
    type RunecraftMode,
    type RunecraftSessionOutcome,
    normalizeRunecraftConfig,
} from './types';

function outcomeFromFailure(mode: RunecraftMode, detail: string): RunecraftSessionOutcome['kind'] {
    if (/next acquisition|shortage|needs\d+|exhausted|missing/i.test(detail)) return 'missing_supply';
    if (/stopped/i.test(detail)) return 'stopped';
    if (/refused|route refusal|unknown|requires|must be/i.test(detail)) return 'refused';
    return 'failed';
}

export async function runRunecraftSession(
    s: Session,
    rawCfg: RunecraftConfig = {},
    stop: () => boolean = () => false,
): Promise<RunecraftSessionOutcome> {
    const cfg: NormalizedRunecraftConfig = normalizeRunecraftConfig(rawCfg);
    if (cfg.mode === 'air') {
        const res = await craftAirRunes(s, stop);
        const stoppedAir = !res.ok && stop();
        return {
            ok: res.ok,
            kind: res.ok ? 'completed' : stoppedAir ? 'stopped' : 'failed',
            mode: 'air',
            unitsCompleted: res.consumed,
            xpGained: res.xp,
            itemsDelta: { 1436: -res.consumed, 556: res.runes },
            detail: `airRunes=${res.runes} essence=0 runecraftXp=${res.xp} ticks=${res.ticks}${stoppedAir ? ' (stopped)' : ''}`,
            data: res,
        };
    }
    if (cfg.mode === 'bank-craft') {
        const res = await runRuneBankCraft(s, runeBankTarget(cfg.targetLevel), {
            cap: cfg.cap,
            altar: cfg.altar,
            essenceTarget: cfg.essenceTarget,
            stop,
            deps: cfg.deps,
        });
        const detail = 'failure' in res && res.failure ? String(res.failure) : `runecraft=${res.level} trips=${res.trips} consumed=${res.consumed} crafted=${res.crafted}`;
        return {
            ok: res.ok,
            kind: res.ok ? 'completed' : stop() ? 'stopped' : outcomeFromFailure('bank-craft', detail),
            mode: 'bank-craft',
            unitsCompleted: res.consumed,
            xpGained: typeof res.xp === 'number' ? res.xp : undefined,
            detail,
            data: res,
        };
    }
    if (cfg.mode === 'nature') {
        const job = cfg.natureJob ?? (cfg.jobPath ? (JSON.parse(readFileSync(cfg.jobPath, 'utf8')) as NatureJob) : undefined);
        if (!job) {
            const res = await runRuneBankCraft(s, runeBankTarget(cfg.targetLevel), {
                cap: cfg.cap,
                altar: 'nature',
                essenceTarget: cfg.essenceTarget,
                stop,
                deps: cfg.deps,
            });
            const detail = 'failure' in res && res.failure ? String(res.failure) : `runecraft=${res.level} trips=${res.trips} consumed=${res.consumed} crafted=${res.crafted}`;
            return {
                ok: res.ok,
                kind: res.ok ? 'completed' : stop() ? 'stopped' : outcomeFromFailure('nature', detail),
                mode: 'nature',
                unitsCompleted: res.consumed,
                xpGained: typeof res.xp === 'number' ? res.xp : undefined,
                detail,
                data: res,
            };
        }
        const res = await runNatureTrips(s, job, stop, cfg.deps.runBankProfile);
        return {
            ok: res.ok,
            kind: res.ok ? 'completed' : stop() ? 'stopped' : outcomeFromFailure('nature', res.auditFailure),
            mode: 'nature',
            unitsCompleted: res.completed,
            xpGained: typeof res.runecraftXp === 'number' ? res.runecraftXp : undefined,
            detail: res.auditFailure !== '-' ? res.auditFailure : `completed=${res.completed} runecraftXp=${res.runecraftXp}`,
            data: res,
        };
    }
    if (cfg.mode === 'supply') {
        const res = await runRuneSupply(s, runeSupplyTarget(cfg.targetLevel), { cap: cfg.cap, stop, deps: cfg.deps });
        const detail = 'failure' in res && res.failure ? String(res.failure) : `mined=${res.mined} consumed=${res.consumed} crafted=${res.crafted}`;
        return {
            ok: res.ok,
            kind: res.ok ? 'completed' : stop() ? 'stopped' : outcomeFromFailure('supply', detail),
            mode: 'supply',
            unitsCompleted: res.consumed,
            xpGained: res.xp?.runecraft,
            detail,
            data: res,
        };
    }
    return {
        ok: false,
        kind: 'refused',
        mode: cfg.mode,
        detail: `multi-account runecraft mode ${cfg.mode} must run via runRunecraftCli / runRuneCarriers`,
    };
}

export const runecraftWorker: WorkerModule<RunecraftConfig, WorkerAccountView, WorkerWorldView, SessionCore> = {
    id: 'runecraft:unified',
    family: 'runecraft',
    kind: 'produce',
    trust: 'practice_passed',
    protectedAllowed: false,

    preflight(acct, cfg, world) {
        return runecraftPreflight(acct, cfg, world);
    },

    estimate(acct, cfg, world) {
        return runecraftEstimate(acct, cfg, world);
    },

    async run(session, cfg): Promise<RunOutcome> {
        const s = session as Session;
        const norm = normalizeRunecraftConfig(cfg);
        const startTick = s.tick?.() ?? 0;
        const { isStopped } = watchWorkerStop(s, cfg.stop);
        await Promise.resolve();
        if (isStopped()) {
            return toRunecraftWorkerOutcome(
                { ok: false, kind: 'stopped', mode: norm.mode, detail: 'stop or session end requested' },
                s.name ?? 'unknown',
                norm,
                0,
            );
        }
        try {
            const outcome = await runRunecraftSession(s, norm, isStopped);
            const finalOutcome = !outcome.ok && isStopped() ? { ...outcome, kind: 'stopped' as const } : outcome;
            const ticksElapsed = Math.max(0, (s.tick?.() ?? startTick) - startTick);
            return toRunecraftWorkerOutcome(finalOutcome, s.name ?? 'unknown', norm, ticksElapsed);
        } catch (error) {
            await Promise.resolve();
            const detail = String(error);
            const ticksElapsed = Math.max(0, (s.tick?.() ?? startTick) - startTick);
            return toRunecraftWorkerOutcome(
                { ok: false, kind: isStopped() ? 'stopped' : outcomeFromFailure(norm.mode, detail), mode: norm.mode, detail },
                s.name ?? 'unknown',
                norm,
                ticksElapsed,
            );
        }
    },
};

/**
 * CLI runner supporting all consolidated runecraft routes:
 * - bank-craft: `<account> [target=99]`, `--carriers`, `--body-continuation`, `--body-measure=N`, `--staged=altar:level`, `--rune-carriers`, `--rune-opening`
 * - nature: `<account> <job.json>`
 * - supply: `<account> [target=20]` plus `RUNE_AIR_EXIT_DIAGNOSTIC` / `RUNE_COOK_DIAGNOSTIC`
 * - air: `<account>` inside the Air altar
 */
export async function runRunecraftCli(
    method: RunecraftMode,
    account: string,
    args: readonly string[] = [],
    env: Readonly<Record<string, string | undefined>> = process.env,
    deps: RunecraftExternalDeps = {},
): Promise<number> {
    const open = deps.openBot ?? defaultOpenBot;
    const fin = deps.finish ?? defaultFinish;

    if (method === 'bank-craft') {
        const allArgs = [account, ...args];
        if (['--rune-carriers', '--rune-opening'].includes(allArgs.at(-1) ?? '')) {
            const prevExitCode = process.exitCode;
            process.exitCode = 0;
            try {
                await mainRuneStage(allArgs, deps);
                return process.exitCode ? Number(process.exitCode) : 0;
            } finally {
                process.exitCode = prevExitCode;
            }
        }
        if (allArgs.includes('--carriers')
            || allArgs.includes('--body-continuation')
            || allArgs.some(a => a.startsWith('--body-measure') || a.startsWith('--staged'))) {
            try {
                const roster = runeCarrierRoster(allArgs), staged = runeCarrierStaged(allArgs.at(-1));
                const capVal = Number(env.CAP ?? 2800);
                const r = await runRuneCarriers(roster, capVal, {
                    bodyContinuation: allArgs.includes('--body-continuation'),
                    measurePacks: runeCarrierMeasurePacks(allArgs.at(-1)),
                    ...(staged ? { staged: { altar: carrierAltar(staged.altar), target: staged.target } } : {}),
                    deps,
                });
                console.log('RUNE_CARRIERS_RESULT ' + JSON.stringify(r));
                await fin([], r.ok, 'failure' in r ? r.failure ?? 'carrier route failed' : `runecraft=${r.level} batches=${r.batches}`);
                return r.ok ? 0 : 1;
            } catch (error) {
                await fin([], false, String(error));
                return 1;
            }
        }
        const target = runeBankTarget(Number(args[0] ?? env.TARGET_LEVEL ?? 99));
        if (!account) throw Error('account argument required');
        const options = runeBankOptions({
            cap: Number(env.CAP ?? 20000),
            altar: env.RUNE_ALTAR,
            essenceTarget: env.ESSENCE_TARGET === undefined ? undefined : Number(env.ESSENCE_TARGET),
            deps,
        });
        let stopped = false;
        const s = await open(account, { onStop: async () => { stopped = true; } });
        try {
            const r = await runRuneBankCraft(s, target, { ...options, stop: () => stopped || isStopFilePresent(account) });
            console.log('RUNE_BANK_CRAFT_RESULT ' + JSON.stringify(r));
            await fin([s], r.ok, `runecraft=${r.level} trips=${r.trips} consumed=${r.consumed} crafted=${r.crafted}${'failure' in r ? ' ' + r.failure : ''}`);
            return r.ok ? 0 : 1;
        } catch (error) {
            await fin([s], false, String(error));
            return 1;
        }
    }

    if (method === 'nature') {
        const jobPath = args[0];
        if (!account) throw Error('usage: runecraft nature <account> [job.json]');
        if (!jobPath) {
            return runRunecraftCli('bank-craft', account, [], { ...env, RUNE_ALTAR: 'nature' }, deps);
        }
        const job = JSON.parse(readFileSync(jobPath, 'utf8')) as NatureJob;
        natureRouteJob(job);
        let stopped = false;
        const s = await open(account, { onStop: async () => { stopped = true; } });
        try {
            const result = await runNatureTrips(
                s,
                job,
                () => stopped || isStopFilePresent(account, ['.practice/stop-microbot-rune-trip']),
                deps.runBankProfile,
            );
            console.log('NATURE_TRIP ' + JSON.stringify(result));
            await fin([s], result.ok, JSON.stringify(result));
            return result.ok ? 0 : 1;
        } catch (error) {
            await fin([s], false, String(error));
            return 1;
        }
    }

    if (method === 'supply') {
        if (!account) throw Error('account argument required');
        const target = runeSupplyTarget(Number(args[0] ?? env.TARGET_LEVEL ?? 20));
        let stopped = false;
        const s = await open(account, { onStop: async () => { stopped = true; } });
        try {
            if (env.RUNE_AIR_EXIT_DIAGNOSTIC) {
                if (stopped || existsSync(`.practice/stop-${s.name}`)) throw Error('air diagnostic stopped');
                const diagMode = env.RUNE_AIR_EXIT_DIAGNOSTIC;
                if (!insideAirAltar(s.sdk.getState()?.player)) throw Error('air diagnostic requires observed altar entry');
                if (diagMode === 'refused') {
                    const portal = s.sdk.findNearbyLoc(/^portal$/i, { withOption: /^use$/i });
                    if (!portal) throw Error('air diagnostic portal absent');
                    const reply = await s.bot.interactLoc(portal, /^unsupported-air-recovery-option$/);
                    const ok = !stopped && !existsSync(`.practice/stop-${s.name}`) && !reply.success && reply.reason === 'no_matching_option' && insideAirAltar(s.sdk.getState()?.player);
                    console.log('AIR_EXIT_REJECTION ' + JSON.stringify({ ok, reply, position: s.sdk.getState()?.player }));
                    await fin([s], ok, 'air rejected-option diagnostic');
                    return ok ? 0 : 1;
                }
                if (diagMode === 'exit') {
                    await exitAirAltar(s, () => stopped || existsSync(`.practice/stop-${s.name}`));
                    await fin([s], true, 'air exit observation diagnostic');
                    return 0;
                }
                throw Error('unknown air exit diagnostic');
            }
            if (env.RUNE_COOK_DIAGNOSTIC === '1') {
                const { cookStarterChicken } = await import('../gather');
                const r = await cookStarterChicken(s, () => stopped || existsSync(`.practice/stop-${s.name}`));
                console.log('RUNE_COOK_DIAGNOSTIC_RESULT ' + JSON.stringify(r));
                await fin([s], true, JSON.stringify(r));
                return 0;
            }
            const r = await runRuneSupply(s, target, { cap: Number(env.CAP ?? 30000), stop: () => stopped || isStopFilePresent(account), deps });
            console.log('RUNE_SUPPLY_RESULT ' + JSON.stringify(r));
            await fin([s], r.ok, JSON.stringify(r));
            return r.ok ? 0 : 1;
        } catch (error) {
            await fin([s], false, String(error));
            return 1;
        }
    }

    if (method === 'air') {
        if (!account) throw Error('account argument required');
        let stopped = false;
        const s = await open(account, { onStop: async () => { stopped = true; } });
        try {
            const r = await craftAirRunes(s, () => stopped || isStopFilePresent(account));
            console.log(`RATE runecraft ${r.xp} ${r.ticks}`);
            await fin([s], r.ok, `airRunes=${countItems(s, /^air rune$/i)} essence=${countItems(s, /^rune essence$/i)} runecraftXp=${r.xp} ticks=${r.ticks}`);
            return r.ok ? 0 : 1;
        } catch (error) {
            await fin([s], false, String(error));
            return 1;
        }
    }

    if (method === 'carriers' || method === 'staged' || method === 'body-continuation' || method === 'body-measure') {
        // staged and body-measure take an optional leading number (level or pack count) before the roster.
        const counted = (method === 'staged' || method === 'body-measure') && /^[0-9]+$/.test(args[0] ?? '');
        const n = counted ? args[0] : undefined, roster = counted ? args.slice(1) : args;
        const flag = method === 'staged'
            ? `--staged=${env.RUNE_ALTAR ?? 'body'}:${n ?? 99}`
            : method === 'body-measure'
                ? `--body-measure=${n ?? 12}`
                : method === 'body-continuation'
                    ? '--body-continuation'
                    : '--carriers';
        return runRunecraftCli('bank-craft', account, [...roster, flag], env, deps);
    }

    if (method === 'stage-carriers' || method === 'stage-opening') {
        const flag = method === 'stage-opening' ? '--rune-opening' : '--rune-carriers';
        const prevExitCode = process.exitCode;
        process.exitCode = 0;
        try {
            await mainRuneStage([account, ...args, flag], deps);
            return process.exitCode ? Number(process.exitCode) : 0;
        } finally {
            process.exitCode = prevExitCode;
        }
    }

    throw Error(`unknown runecraft CLI method: ${String(method)}`);
}

export * from './types';
export * from './altars';
export * from './air';
export * from './bank-craft';
export * from './shilo';
export * from './supply';
export * from './carrier-trade';
export * from './carrier-bank';
export * from './carrier-roster';
export * from './carrier-stage';
export * from './carriers';
export * from './preflight';
