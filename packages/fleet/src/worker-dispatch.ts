// Direct Fleet dispatch bridging pure Brain worker routes onto the 9 unified WorkerModule engines.
import {
    resolveAccountWorkerPlan,
    resolvePlannedStepWorkerRoute,
    type ResolvedWorkerPlan,
    type WorkerExecutionMode,
    type WorkerRouteStep,
    type WorkerRoutingContext,
} from '../../brain/src/index';
import { formatStep, type Step } from '../../core/src/chain-step';
import type { AccountPlan, PlannedStep } from '../../brain/src/contracts';
import { agilityWorker, normalizeAgilityConfig, SUPPORTED_AGILITY_COURSES } from '../../workers/src/agility';
import { ARTISAN_METHOD_MAP, bankArtisanWorker, VALID_ARTISAN_SKILLS, type ArtisanSkill } from '../../workers/src/bank-artisan';
import { COMBAT_MODE_SET, combatWorkerModule } from '../../workers/src/combat';
import type { WorkerFamily, WorkerModule } from '../../workers/src/contracts';
import { GATHER_METHOD_MAP, gatherWorker, normalizeGatherConfig, VALID_GATHER_SKILLS, type GatherSkill } from '../../workers/src/gather';
import { findLogisticsRole, logisticsWorker, resolveLogisticsStep } from '../../workers/src/logistics';
import { MARKET_MODE_IDS, marketModule } from '../../workers/src/market';
import { PVP_MODES, pvpModule, resolvePvpStep } from '../../workers/src/pvp';
import { QUESTER_MODES, questModule, resolveQuesterStep } from '../../workers/src/quest';
import { normalizeRunecraftConfig, RUNECRAFT_MODES, runecraftWorker, type RunecraftMode } from '../../workers/src/runecraft';

export const UNIFIED_WORKER_MODULES: Readonly<Record<WorkerFamily, WorkerModule<any, any, any, any>>> = {
    gather: gatherWorker,
    'bank-artisan': bankArtisanWorker,
    combat: combatWorkerModule,
    agility: agilityWorker,
    runecraft: runecraftWorker,
    quest: questModule,
    market: marketModule,
    logistics: logisticsWorker,
    pvp: pvpModule,
};

export interface DispatchedStepInvocation {
    readonly account: string;
    readonly family: WorkerFamily;
    readonly workerId: string;
    readonly stepKind: PlannedStep['stepKind'];
    readonly executionMode: WorkerExecutionMode;
    readonly step: Step;
    readonly argv: readonly string[];
    readonly chainStepText: string;
    readonly warnings: readonly string[];
}

export interface DispatchedAccountPlan {
    readonly account: string;
    readonly demandId?: string;
    readonly route: ResolvedWorkerPlan;
    readonly steps: readonly DispatchedStepInvocation[];
    readonly combinedStep: Step | null;
    readonly argv: readonly string[];
    readonly warnings: readonly string[];
}

const VALID_SCRIPT_PATH = /^scripts\/[\w./-]+\.ts$/;
const AGILITY_COURSE_SET: ReadonlySet<string> = new Set(SUPPORTED_AGILITY_COURSES);
const RUNECRAFT_MODE_SET: ReadonlySet<string> = new Set(RUNECRAFT_MODES);
const MARKET_MODE_SET: ReadonlySet<string> = new Set(MARKET_MODE_IDS);
const VALID_GATHER_SKILL_SET: ReadonlySet<string> = new Set(VALID_GATHER_SKILLS);
const VALID_ARTISAN_SKILL_SET: ReadonlySet<string> = new Set(VALID_ARTISAN_SKILLS);

export function resolveWorkerModule(family: WorkerFamily): WorkerModule<any, any, any, any> {
    const mod = UNIFIED_WORKER_MODULES[family];
    if (!mod || mod.family !== family) {
        throw new Error(`Missing unified WorkerModule for family "${family}"`);
    }
    return mod;
}

function standaloneFromConfig(route: WorkerRouteStep): string | undefined {
    const candidate = typeof route.config.standaloneScript === 'string'
        ? route.config.standaloneScript
        : undefined;
    return candidate && VALID_SCRIPT_PATH.test(candidate) ? candidate : undefined;
}

function dispatchSingleRoute(route: WorkerRouteStep): { step: Step; warnings: string[] } {
    resolveWorkerModule(route.family);
    const warnings = [...route.warnings];
    const baseEnv = { ...route.env };

    if (route.executionMode === 'session_recovery') {
        return {
            step: {
                script: 'scripts/cloud-recover.ts',
                args: [],
                env: baseEnv,
            },
            warnings,
        };
    }

    const standalone = standaloneFromConfig(route);
    if (standalone) {
        return {
            step: {
                script: standalone,
                args: [...route.args],
                env: baseEnv,
            },
            warnings,
        };
    }

    switch (route.family) {
        case 'gather': {
            const skill = String(route.config.skill ?? route.args[0] ?? 'mining').toLowerCase();
            const method = String(route.config.method ?? route.args[1] ?? 'ore').toLowerCase();
            if (VALID_GATHER_SKILL_SET.has(skill)) {
                const norm = normalizeGatherConfig({
                    skill: skill as GatherSkill,
                    method,
                    args: route.args.slice(2),
                    env: baseEnv,
                });
                const knownMethods = GATHER_METHOD_MAP[norm.skill] as readonly string[];
                if (!knownMethods.includes(norm.method) && !route.config.table) {
                    warnings.push(`gather method "${norm.skill}:${norm.method}" is not in GATHER_METHOD_MAP`);
                }
            } else {
                warnings.push(`gather skill "${skill}" is not in VALID_GATHER_SKILLS`);
            }
            return {
                step: { script: 'scripts/aio-skiller.ts', args: [...route.args], env: baseEnv },
                warnings,
            };
        }

        case 'bank-artisan': {
            const skill = String(route.config.skill ?? route.args[0] ?? 'cooking').toLowerCase();
            const method = typeof route.config.method === 'string'
                ? route.config.method.toLowerCase()
                : route.args[1]?.toLowerCase();
            if (VALID_ARTISAN_SKILL_SET.has(skill)) {
                const validMethods = ARTISAN_METHOD_MAP[skill as ArtisanSkill] as readonly string[];
                if (method && !validMethods.includes(method) && !(skill === 'prayer' && method === 'flick') && !route.config.table) {
                    warnings.push(`bank-artisan method "${skill}:${method}" is not in ARTISAN_METHOD_MAP`);
                }
            } else {
                warnings.push(`bank-artisan skill "${skill}" is not in VALID_ARTISAN_SKILLS`);
            }
            return {
                step: { script: 'scripts/aio-skiller.ts', args: [...route.args], env: baseEnv },
                warnings,
            };
        }

        case 'combat': {
            if (typeof route.config.boss === 'string') {
                const boss = route.config.boss.toLowerCase();
                if (!COMBAT_MODE_SET.has(boss)) {
                    warnings.push(`boss encounter "${boss}" is not in COMBAT_MODE_SET`);
                }
                return {
                    step: { script: 'scripts/aio-boss.ts', args: [...route.args], env: baseEnv },
                    warnings,
                };
            }
            if (typeof route.config.skill === 'string' && route.config.skill.toLowerCase() === 'magic') {
                const mode = String(route.config.mode ?? 'magic-splash');
                if (!COMBAT_MODE_SET.has(mode)) {
                    warnings.push(`magic combat mode "${mode}" is not in COMBAT_MODE_SET`);
                }
                return {
                    step: { script: 'scripts/aio-skiller.ts', args: [...route.args], env: baseEnv },
                    warnings,
                };
            }
            const target = String(route.config.target ?? route.config.mode ?? route.args[0] ?? 'cow');
            if (!COMBAT_MODE_SET.has(target)) {
                warnings.push(`combat target "${target}" is not in COMBAT_MODE_SET`);
            }
            return {
                step: { script: 'scripts/aio-fighter.ts', args: [...route.args], env: baseEnv },
                warnings,
            };
        }

        case 'agility': {
            const norm = normalizeAgilityConfig({
                course: typeof route.config.course === 'string' ? route.config.course : undefined,
                method: typeof route.config.method === 'string' ? route.config.method : undefined,
                args: route.args.slice(2),
                env: baseEnv,
            });
            if (!AGILITY_COURSE_SET.has(norm.course)) {
                warnings.push(`agility course "${norm.course}" is not in SUPPORTED_AGILITY_COURSES`);
            }
            return {
                step: { script: 'scripts/aio-skiller.ts', args: [...route.args], env: baseEnv },
                warnings,
            };
        }

        case 'runecraft': {
            const rawMode = String(route.config.method ?? route.args[1] ?? 'bank-craft');
            if (RUNECRAFT_MODE_SET.has(rawMode)) {
                normalizeRunecraftConfig({
                    mode: rawMode as RunecraftMode,
                    altar: baseEnv.RUNE_ALTAR,
                    args: route.args.slice(2),
                    env: baseEnv,
                });
            } else {
                warnings.push(`runecraft mode "${rawMode}" is not in RUNECRAFT_MODES`);
            }
            return {
                step: { script: 'scripts/aio-skiller.ts', args: [...route.args], env: baseEnv },
                warnings,
            };
        }

        case 'quest': {
            const mode = typeof route.config.mode === 'string' ? route.config.mode.toLowerCase() : 'sweep';
            const modeSpec = QUESTER_MODES.find((m) => m.mode === mode);
            const slug = typeof route.config.questSlug === 'string' ? route.config.questSlug : undefined;
            if (modeSpec && (!modeSpec.orderFile || route.args.length > 1)) {
                const rest = route.args[0]?.toLowerCase() === mode ? route.args.slice(1) : route.args;
                const resolved = resolveQuesterStep(mode, rest);
                return {
                    step: {
                        script: resolved.script,
                        args: [...resolved.args],
                        env: { ...resolved.env, ...baseEnv },
                    },
                    warnings,
                };
            }
            if (!modeSpec && !slug) {
                warnings.push(`quest mode "${mode}" is not in QUESTER_MODES`);
            }
            return {
                step: { script: 'scripts/aio-quester.ts', args: [...route.args], env: baseEnv },
                warnings,
            };
        }

        case 'market': {
            const mode = String(route.config.mode ?? route.args[0] ?? 'ge-buy');
            if (!MARKET_MODE_SET.has(mode)) {
                warnings.push(`market mode "${mode}" is not in MARKET_MODE_IDS`);
            }
            return {
                step: { script: 'scripts/aio-market.ts', args: [...route.args], env: baseEnv },
                warnings,
            };
        }

        case 'logistics': {
            const role = String(route.config.role ?? route.args[0] ?? 'walk-to');
            if (findLogisticsRole(role)) {
                const rest = route.args[0]?.toLowerCase() === role ? route.args.slice(1) : route.args;
                if (role !== 'loadout-import' || rest.length === 2) {
                    const resolved = resolveLogisticsStep(role, rest);
                    return {
                        step: {
                            script: resolved.script,
                            args: [...resolved.args],
                            env: { ...resolved.env, ...baseEnv },
                        },
                        warnings,
                    };
                }
                return {
                    step: { script: 'scripts/aio-logistics.ts', args: [...route.args], env: baseEnv },
                    warnings,
                };
            }
            warnings.push(`logistics role "${role}" is not in LOGISTICS_ROLES`);
            return {
                step: { script: 'scripts/aio-logistics.ts', args: [...route.args], env: baseEnv },
                warnings,
            };
        }

        case 'pvp': {
            const mode = String(route.config.mode ?? route.args[0] ?? 'pilot').toLowerCase();
            if (PVP_MODES.some((m) => m.mode === mode)) {
                const rest = route.args[0]?.toLowerCase() === mode ? route.args.slice(1) : route.args;
                const resolved = resolvePvpStep(mode, rest);
                return {
                    step: {
                        script: resolved.script,
                        args: [...resolved.args],
                        env: { ...resolved.env, ...baseEnv },
                    },
                    warnings,
                };
            }
            warnings.push(`pvp mode "${mode}" is not in PVP_MODES`);
            return {
                step: { script: 'scripts/aio-pvp.ts', args: [...route.args], env: baseEnv },
                warnings,
            };
        }
    }
}

export function dispatchWorkerStep(route: WorkerRouteStep): DispatchedStepInvocation {
    const mod = resolveWorkerModule(route.family);
    const { step, warnings } = dispatchSingleRoute(route);
    return {
        account: route.account,
        family: route.family,
        workerId: mod.id,
        stepKind: route.stepKind,
        executionMode: route.executionMode,
        step,
        argv: [step.script, route.account, ...step.args],
        chainStepText: formatStep(step),
        warnings,
    };
}

export function dispatchPlannedStep(
    account: string,
    planned: PlannedStep,
    ctx?: WorkerRoutingContext,
): DispatchedStepInvocation {
    const route = resolvePlannedStepWorkerRoute(account, planned, ctx);
    return dispatchWorkerStep(route);
}

export function dispatchAccountPlan(
    plan: AccountPlan,
    ctx?: WorkerRoutingContext,
): DispatchedAccountPlan {
    const route = resolveAccountWorkerPlan(plan, ctx);
    const steps = route.steps.map((s) => dispatchWorkerStep(s));
    const warnings = steps.flatMap((s) => s.warnings);
    if (steps.length === 0) {
        return {
            account: plan.account,
            ...(plan.demandId ? { demandId: plan.demandId } : {}),
            route,
            steps: [],
            combinedStep: null,
            argv: [],
            warnings,
        };
    }
    if (steps.length === 1) {
        const single = steps[0]!;
        return {
            account: plan.account,
            ...(plan.demandId ? { demandId: plan.demandId } : {}),
            route,
            steps,
            combinedStep: single.step,
            argv: single.argv,
            warnings,
        };
    }
    const combinedStep: Step = {
        script: 'scripts/chain.ts',
        args: steps.map((s) => s.chainStepText),
        env: { ROUNDS: '1' },
    };
    return {
        account: plan.account,
        ...(plan.demandId ? { demandId: plan.demandId } : {}),
        route,
        steps,
        combinedStep,
        argv: [combinedStep.script, plan.account, ...combinedStep.args],
        warnings,
    };
}
