// Direct Fleet dispatch bridging pure Brain worker routes onto the 9 unified WorkerModule engines.
// Worker family modules are loaded lazily on first use so importing dispatch helpers does not pay
// startup cost for unused worker families while preserving full static import-closure tracking.
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
import type { WorkerFamily, WorkerModule } from '../../workers/src/contracts';
import type * as AgilityMod from '../../workers/src/agility';
import type * as BankArtisanMod from '../../workers/src/bank-artisan';
import type * as CombatMod from '../../workers/src/combat';
import type * as GatherMod from '../../workers/src/gather';
import type * as LogisticsMod from '../../workers/src/logistics';
import type * as MarketMod from '../../workers/src/market';
import type * as PvpMod from '../../workers/src/pvp';
import type * as QuestMod from '../../workers/src/quest';
import type * as RunecraftMod from '../../workers/src/runecraft';

let agilityModCache: typeof AgilityMod | undefined;
let bankArtisanModCache: typeof BankArtisanMod | undefined;
let combatModCache: typeof CombatMod | undefined;
let gatherModCache: typeof GatherMod | undefined;
let logisticsModCache: typeof LogisticsMod | undefined;
let marketModCache: typeof MarketMod | undefined;
let pvpModCache: typeof PvpMod | undefined;
let questModCache: typeof QuestMod | undefined;
let runecraftModCache: typeof RunecraftMod | undefined;

const loadAgilityMod = (): typeof AgilityMod => (agilityModCache ??= require('../../workers/src/agility'));
const loadBankArtisanMod = (): typeof BankArtisanMod => (bankArtisanModCache ??= require('../../workers/src/bank-artisan'));
const loadCombatMod = (): typeof CombatMod => (combatModCache ??= require('../../workers/src/combat'));
const loadGatherMod = (): typeof GatherMod => (gatherModCache ??= require('../../workers/src/gather'));
const loadLogisticsMod = (): typeof LogisticsMod => (logisticsModCache ??= require('../../workers/src/logistics'));
const loadMarketMod = (): typeof MarketMod => (marketModCache ??= require('../../workers/src/market'));
const loadPvpMod = (): typeof PvpMod => (pvpModCache ??= require('../../workers/src/pvp'));
const loadQuestMod = (): typeof QuestMod => (questModCache ??= require('../../workers/src/quest'));
const loadRunecraftMod = (): typeof RunecraftMod => (runecraftModCache ??= require('../../workers/src/runecraft'));

const FAMILY_MODULE_LOADERS: Readonly<Record<WorkerFamily, () => WorkerModule<any, any, any, any>>> = {
    gather: () => loadGatherMod().gatherWorker,
    'bank-artisan': () => loadBankArtisanMod().bankArtisanWorker,
    combat: () => loadCombatMod().combatWorkerModule,
    agility: () => loadAgilityMod().agilityWorker,
    runecraft: () => loadRunecraftMod().runecraftWorker,
    quest: () => loadQuestMod().questModule,
    market: () => loadMarketMod().marketModule,
    logistics: () => loadLogisticsMod().logisticsWorker,
    pvp: () => loadPvpMod().pvpModule,
};

const lazyUnifiedModules = {} as Record<WorkerFamily, WorkerModule<any, any, any, any>>;
for (const family of Object.keys(FAMILY_MODULE_LOADERS) as WorkerFamily[]) {
    const loader = FAMILY_MODULE_LOADERS[family];
    Object.defineProperty(lazyUnifiedModules, family, {
        enumerable: true,
        configurable: false,
        get: loader,
    });
}

export const UNIFIED_WORKER_MODULES: Readonly<Record<WorkerFamily, WorkerModule<any, any, any, any>>> = lazyUnifiedModules;

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

let agilityCourseSetCache: ReadonlySet<string> | undefined;
let runecraftModeSetCache: ReadonlySet<string> | undefined;
let marketModeSetCache: ReadonlySet<string> | undefined;
let validGatherSkillSetCache: ReadonlySet<string> | undefined;
let validArtisanSkillSetCache: ReadonlySet<string> | undefined;
let questerModeMapCache: ReadonlyMap<string, (typeof QuestMod.QUESTER_MODES)[number]> | undefined;
let pvpModeSetCache: ReadonlySet<string> | undefined;

const getAgilityCourseSet = (): ReadonlySet<string> => (agilityCourseSetCache ??= new Set(loadAgilityMod().SUPPORTED_AGILITY_COURSES));
const getRunecraftModeSet = (): ReadonlySet<string> => (runecraftModeSetCache ??= new Set(loadRunecraftMod().RUNECRAFT_MODES));
const getMarketModeSet = (): ReadonlySet<string> => (marketModeSetCache ??= new Set(loadMarketMod().MARKET_MODE_IDS));
const getValidGatherSkillSet = (): ReadonlySet<string> => (validGatherSkillSetCache ??= new Set(loadGatherMod().VALID_GATHER_SKILLS));
const getValidArtisanSkillSet = (): ReadonlySet<string> => (validArtisanSkillSetCache ??= new Set(loadBankArtisanMod().VALID_ARTISAN_SKILLS));
const getQuesterModeMap = (): ReadonlyMap<string, (typeof QuestMod.QUESTER_MODES)[number]> => {
    if (!questerModeMapCache) {
        const m = new Map<string, (typeof QuestMod.QUESTER_MODES)[number]>();
        for (const spec of loadQuestMod().QUESTER_MODES) m.set(spec.mode, spec);
        questerModeMapCache = m;
    }
    return questerModeMapCache;
};
const getPvpModeSet = (): ReadonlySet<string> => {
    if (!pvpModeSetCache) {
        pvpModeSetCache = new Set(loadPvpMod().PVP_MODES.map((m) => m.mode));
    }
    return pvpModeSetCache;
};

export function resolveWorkerModule(family: WorkerFamily): WorkerModule<any, any, any, any> {
    const loader = FAMILY_MODULE_LOADERS[family];
    const mod = loader ? loader() : undefined;
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
                args: [`--account=${route.account}`],
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
            const gatherMod = loadGatherMod();
            const skill = String(route.config.skill ?? route.args[0] ?? 'mining').toLowerCase();
            const method = String(route.config.method ?? route.args[1] ?? 'ore').toLowerCase();
            if (getValidGatherSkillSet().has(skill)) {
                const norm = gatherMod.normalizeGatherConfig({
                    skill: skill as GatherMod.GatherSkill,
                    method,
                    args: route.args.slice(2),
                    env: baseEnv,
                });
                const knownMethods = gatherMod.GATHER_METHOD_MAP[norm.skill] as readonly string[];
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
            const artisanMod = loadBankArtisanMod();
            const skill = String(route.config.skill ?? route.args[0] ?? 'cooking').toLowerCase();
            const method = typeof route.config.method === 'string'
                ? route.config.method.toLowerCase()
                : route.args[1]?.toLowerCase();
            if (getValidArtisanSkillSet().has(skill)) {
                const validMethods = artisanMod.ARTISAN_METHOD_MAP[skill as BankArtisanMod.ArtisanSkill] as readonly string[];
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
            const combatModeSet = loadCombatMod().COMBAT_MODE_SET;
            if (typeof route.config.boss === 'string') {
                const boss = route.config.boss.toLowerCase();
                if (!combatModeSet.has(boss)) {
                    warnings.push(`boss encounter "${boss}" is not in COMBAT_MODE_SET`);
                }
                return {
                    step: { script: 'scripts/aio-boss.ts', args: [...route.args], env: baseEnv },
                    warnings,
                };
            }
            if (typeof route.config.skill === 'string' && route.config.skill.toLowerCase() === 'magic') {
                const mode = String(route.config.mode ?? 'magic-splash');
                if (!combatModeSet.has(mode)) {
                    warnings.push(`magic combat mode "${mode}" is not in COMBAT_MODE_SET`);
                }
                return {
                    step: { script: 'scripts/aio-skiller.ts', args: [...route.args], env: baseEnv },
                    warnings,
                };
            }
            const target = String(route.config.target ?? route.config.mode ?? route.args[0] ?? 'cow');
            if (!combatModeSet.has(target)) {
                warnings.push(`combat target "${target}" is not in COMBAT_MODE_SET`);
            }
            return {
                step: { script: 'scripts/aio-fighter.ts', args: [...route.args], env: baseEnv },
                warnings,
            };
        }

        case 'agility': {
            const agilityMod = loadAgilityMod();
            const norm = agilityMod.normalizeAgilityConfig({
                course: typeof route.config.course === 'string' ? route.config.course : undefined,
                method: typeof route.config.method === 'string' ? route.config.method : undefined,
                args: route.args.slice(2),
                env: baseEnv,
            });
            if (!getAgilityCourseSet().has(norm.course)) {
                warnings.push(`agility course "${norm.course}" is not in SUPPORTED_AGILITY_COURSES`);
            }
            return {
                step: { script: 'scripts/aio-skiller.ts', args: [...route.args], env: baseEnv },
                warnings,
            };
        }

        case 'runecraft': {
            const rcMod = loadRunecraftMod();
            const rawMode = String(route.config.method ?? route.args[1] ?? 'bank-craft');
            if (getRunecraftModeSet().has(rawMode)) {
                rcMod.normalizeRunecraftConfig({
                    mode: rawMode as RunecraftMod.RunecraftMode,
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
            const questMod = loadQuestMod();
            const mode = typeof route.config.mode === 'string' ? route.config.mode.toLowerCase() : 'sweep';
            const modeSpec = getQuesterModeMap().get(mode);
            const slug = typeof route.config.questSlug === 'string' ? route.config.questSlug : undefined;
            if (modeSpec && (!modeSpec.orderFile || route.args.length > 1)) {
                const rest = route.args[0]?.toLowerCase() === mode ? route.args.slice(1) : route.args;
                const resolved = questMod.resolveQuesterStep(mode, rest);
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
            if (!getMarketModeSet().has(mode)) {
                warnings.push(`market mode "${mode}" is not in MARKET_MODE_IDS`);
            }
            return {
                step: { script: 'scripts/aio-market.ts', args: [...route.args], env: baseEnv },
                warnings,
            };
        }

        case 'logistics': {
            const logisticsMod = loadLogisticsMod();
            const role = String(route.config.role ?? route.args[0] ?? 'walk-to');
            if (logisticsMod.findLogisticsRole(role)) {
                const rest = route.args[0]?.toLowerCase() === role ? route.args.slice(1) : route.args;
                if (role !== 'loadout-import' || rest.length === 2) {
                    const resolved = logisticsMod.resolveLogisticsStep(role, rest);
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
            const pvpMod = loadPvpMod();
            const mode = String(route.config.mode ?? route.args[0] ?? 'pilot').toLowerCase();
            if (getPvpModeSet().has(mode)) {
                const rest = route.args[0]?.toLowerCase() === mode ? route.args.slice(1) : route.args;
                const resolved = pvpMod.resolvePvpStep(mode, rest);
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
