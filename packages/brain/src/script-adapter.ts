// Thin disposable ScriptAdapter mapping catalog ActivityDefinitions and AccountPlan PlannedSteps
// onto current live scripts/aio-*.ts / live worker invocations so Phase 2 cuts over before worker consolidation finishes.
import { formatStep, type Step } from '../../core/src/chain-step';
import type { WorkerFamily } from '../../workers/src/contracts';
import {
    DEFAULT_OPERATING_COIN_FLOAT,
    HUB_BANKER_LOCATIONS,
    type AccountPlan,
    type AcquireSourceKind,
    type ActivityDefinition,
    type PlannedStep,
} from './contracts';

export interface ScriptAdapterContext {
    readonly activities?: readonly ActivityDefinition[];
    readonly activityById?: ReadonlyMap<string, ActivityDefinition>;
    readonly catalog?: { get(id: string): ActivityDefinition | undefined };
}

export type AdaptedExecutionMode = 'script' | 'session_recovery' | 'fleet_trade' | 'chain';

export interface AdaptedStepInvocation {
    readonly account: string;
    readonly stepKind: PlannedStep['stepKind'];
    readonly mode: AdaptedExecutionMode;
    readonly step: Step;
    readonly argv: readonly string[];
    readonly chainStepText: string;
    readonly warnings: readonly string[];
}

export interface AdaptedAccountPlan {
    readonly account: string;
    readonly demandId?: string;
    readonly steps: readonly AdaptedStepInvocation[];
    readonly combinedStep: Step | null;
    readonly argv: readonly string[];
    readonly warnings: readonly string[];
}

const VALID_SCRIPT_PATH = /^scripts\/[\w./-]+\.ts$/;

function sanitizeEnv(raw: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, val] of Object.entries(raw)) {
        if (val === undefined || val === null) continue;
        const upper = key.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
        if (!/^[A-Z][A-Z0-9_]*$/.test(upper)) continue;
        out[upper] = typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean'
            ? String(val)
            : JSON.stringify(val);
    }
    return out;
}

function normalizeScriptPath(script: string | undefined, fallback: string): { script: string; warning?: string } {
    if (script && VALID_SCRIPT_PATH.test(script)) return { script };
    if (script && /^[\w./-]+\.ts$/.test(script)) return { script: `scripts/${script}` };
    return {
        script: fallback,
        ...(script ? { warning: `invalid script path "${script}", using ${fallback}` } : {}),
    };
}

function inferSkillMethodFromId(activityId: string): { skill?: string; method?: string } {
    const colon = activityId.indexOf(':');
    const tail = colon >= 0 ? activityId.slice(colon + 1) : activityId;
    const parts = tail.split(/[:/]/);
    if (parts.length >= 2) {
        return { skill: parts[0], method: parts[1] };
    }
    const dashParts = tail.split('-');
    if (dashParts.length >= 2) {
        return { skill: dashParts[0], method: dashParts.slice(1).join('-') };
    }
    return { method: tail };
}

function defaultScriptForFamily(family: WorkerFamily): string {
    switch (family) {
        case 'gather':
        case 'bank-artisan':
        case 'agility':
        case 'runecraft':
            return 'scripts/aio-skiller.ts';
        case 'combat':
            return 'scripts/aio-fighter.ts';
        case 'quest':
            return 'scripts/aio-quester.ts';
        case 'market':
            return 'scripts/aio-market.ts';
        case 'logistics':
            return 'scripts/aio-logistics.ts';
        case 'pvp':
            return 'scripts/aio-pvp.ts';
    }
}

export function adaptActivityToStep(
    activity: Pick<ActivityDefinition, 'id' | 'family' | 'kind' | 'skill' | 'questSlug' | 'config'>,
    extraEnv: Readonly<Record<string, string>> = {},
): { step: Step; warnings: string[] } {
    const cfg = (activity.config ?? {}) as Record<string, unknown>;
    const warnings: string[] = [];

    const explicitArgs = Array.isArray(cfg.defaultArgs)
        ? (cfg.defaultArgs as unknown[]).map(String)
        : Array.isArray(cfg.args)
            ? (cfg.args as unknown[]).map(String)
            : null;
    const baseEnv = {
        ...(cfg.defaultEnv && typeof cfg.defaultEnv === 'object' ? sanitizeEnv(cfg.defaultEnv as Record<string, unknown>) : {}),
        ...(cfg.env && typeof cfg.env === 'object' ? sanitizeEnv(cfg.env as Record<string, unknown>) : {}),
        ...extraEnv,
    };

    const aioCategory = typeof cfg.aioCategory === 'string' ? cfg.aioCategory.toLowerCase() : undefined;
    const aioRoute = typeof cfg.aioRoute === 'string' ? cfg.aioRoute : undefined;

    // Direct Phase 1A config mapping: prefer aio-* dispatcher when aioCategory + aioRoute exist,
    // or direct script when valid and self-contained.
    if (aioCategory && aioRoute) {
        if (aioCategory === 'skiller') {
            const [skillPart, methodPart] = aioRoute.split(':');
            const skill = (typeof cfg.skill === 'string' ? cfg.skill : skillPart ?? activity.skill ?? 'mining').toLowerCase();
            const method = typeof cfg.method === 'string' ? cfg.method : methodPart;
            const args = [skill, ...(method ? [method] : []), ...(explicitArgs ?? [])];
            return { step: { script: 'scripts/aio-skiller.ts', args, env: baseEnv }, warnings };
        }
        if (aioCategory === 'fighter') {
            const target = typeof cfg.target === 'string' ? cfg.target : aioRoute;
            return { step: { script: 'scripts/aio-fighter.ts', args: [target, ...(explicitArgs ?? [])], env: baseEnv }, warnings };
        }
        if (aioCategory === 'boss') {
            const boss = typeof cfg.boss === 'string' ? cfg.boss : aioRoute;
            return { step: { script: 'scripts/aio-boss.ts', args: [boss, ...(explicitArgs ?? [])], env: baseEnv }, warnings };
        }
        if (aioCategory === 'pvp') {
            const mode = typeof cfg.mode === 'string' ? cfg.mode : aioRoute;
            return { step: { script: 'scripts/aio-pvp.ts', args: [mode, ...(explicitArgs ?? [])], env: baseEnv }, warnings };
        }
        if (aioCategory === 'quester') {
            const slug = typeof cfg.questSlug === 'string' ? cfg.questSlug : activity.questSlug ?? aioRoute;
            const mode = typeof cfg.mode === 'string' ? cfg.mode : 'sweep';
            const args = mode === 'sweep' ? ['sweep', slug, ...(explicitArgs ?? [])] : [slug, ...(explicitArgs ?? [])];
            return { step: { script: 'scripts/aio-quester.ts', args, env: baseEnv }, warnings };
        }
        if (aioCategory === 'market') {
            const mode = typeof cfg.mode === 'string' ? cfg.mode : aioRoute;
            return { step: { script: 'scripts/aio-market.ts', args: [mode, ...(explicitArgs ?? [])], env: baseEnv }, warnings };
        }
        if (aioCategory === 'logistics') {
            const role = typeof cfg.role === 'string' ? cfg.role : aioRoute;
            return { step: { script: 'scripts/aio-logistics.ts', args: [role, ...(explicitArgs ?? [])], env: baseEnv }, warnings };
        }
    }

    if (typeof cfg.script === 'string') {
        const norm = normalizeScriptPath(cfg.script, defaultScriptForFamily(activity.family));
        if (norm.warning) warnings.push(norm.warning);
        return {
            step: {
                script: norm.script,
                args: explicitArgs ?? [],
                env: baseEnv,
            },
            warnings,
        };
    }

    const inferred = inferSkillMethodFromId(activity.id);
    switch (activity.family) {
        case 'gather':
        case 'bank-artisan': {
            const skill = (typeof cfg.skill === 'string' ? cfg.skill : activity.skill ?? inferred.skill ?? 'mining').toLowerCase();
            const method = typeof cfg.method === 'string' ? cfg.method : inferred.method;
            return {
                step: {
                    script: 'scripts/aio-skiller.ts',
                    args: [skill, ...(method ? [method] : []), ...(explicitArgs ?? [])],
                    env: baseEnv,
                },
                warnings,
            };
        }
        case 'agility': {
            const course = typeof cfg.course === 'string'
                ? cfg.course
                : typeof cfg.method === 'string'
                    ? cfg.method
                    : inferred.method ?? 'gnome';
            return {
                step: {
                    script: 'scripts/aio-skiller.ts',
                    args: ['agility', 'order', course, ...(explicitArgs ?? [])],
                    env: baseEnv,
                },
                warnings,
            };
        }
        case 'runecraft': {
            const method = typeof cfg.method === 'string' ? cfg.method : inferred.method ?? 'bank-craft';
            return {
                step: {
                    script: 'scripts/aio-skiller.ts',
                    args: ['runecraft', method, ...(explicitArgs ?? [])],
                    env: baseEnv,
                },
                warnings,
            };
        }
        case 'combat': {
            const boss = typeof cfg.boss === 'string'
                ? cfg.boss
                : /^(?:boss:)?(kbd|black-dragon|green-dragon|trawler)$/.exec(activity.id)?.[1];
            if (boss) {
                return {
                    step: {
                        script: 'scripts/aio-boss.ts',
                        args: [boss, ...(explicitArgs ?? [])],
                        env: baseEnv,
                    },
                    warnings,
                };
            }
            const target = typeof cfg.target === 'string' ? cfg.target : inferred.method ?? 'cow';
            return {
                step: {
                    script: 'scripts/aio-fighter.ts',
                    args: [target, ...(explicitArgs ?? [])],
                    env: baseEnv,
                },
                warnings,
            };
        }
        case 'quest': {
            const slug = typeof cfg.questSlug === 'string'
                ? cfg.questSlug
                : activity.questSlug ?? activity.id.replace(/^quest:/, '');
            return {
                step: {
                    script: 'scripts/aio-quester.ts',
                    args: ['sweep', slug, ...(explicitArgs ?? [])],
                    env: baseEnv,
                },
                warnings,
            };
        }
        case 'market': {
            const mode = typeof cfg.mode === 'string' ? cfg.mode : inferred.method ?? 'ge-buy';
            return {
                step: {
                    script: 'scripts/aio-market.ts',
                    args: [mode, ...(explicitArgs ?? [])],
                    env: baseEnv,
                },
                warnings,
            };
        }
        case 'logistics': {
            const role = typeof cfg.role === 'string' ? cfg.role : inferred.method ?? 'walk-to';
            return {
                step: {
                    script: 'scripts/aio-logistics.ts',
                    args: [role, ...(explicitArgs ?? [])],
                    env: baseEnv,
                },
                warnings,
            };
        }
        case 'pvp': {
            const mode = typeof cfg.mode === 'string' ? cfg.mode : inferred.method ?? 'pilot';
            return {
                step: {
                    script: 'scripts/aio-pvp.ts',
                    args: [mode, ...(explicitArgs ?? [])],
                    env: baseEnv,
                },
                warnings,
            };
        }
    }
}

function lookupActivity(activityId: string, ctx?: ScriptAdapterContext): ActivityDefinition | undefined {
    if (ctx?.catalog) {
        const hit = ctx.catalog.get(activityId);
        if (hit) return hit;
    }
    if (ctx?.activityById) {
        const hit = ctx.activityById.get(activityId);
        if (hit) return hit;
    }
    return ctx?.activities?.find((a) => a.id === activityId);
}

function inferFamilyFromActivityId(activityId: string): WorkerFamily {
    const prefix = activityId.split(':')[0]?.toLowerCase() ?? '';
    switch (prefix) {
        case 'gather': return 'gather';
        case 'bank-artisan':
        case 'artisan': return 'bank-artisan';
        case 'combat':
        case 'fighter':
        case 'boss': return 'combat';
        case 'agility': return 'agility';
        case 'runecraft': return 'runecraft';
        case 'quest':
        case 'quester': return 'quest';
        case 'market': return 'market';
        case 'logistics': return 'logistics';
        case 'pvp': return 'pvp';
        default: return 'gather';
    }
}

function adaptAcquireOrGearSource(
    params: {
        source: AcquireSourceKind;
        itemId: number;
        quantity: number;
        shopId?: string;
        transferOrderId?: string;
        activityId?: string;
        coinFloatPreserved?: number;
    },
    ctx?: ScriptAdapterContext,
): { step: Step; mode: AdaptedExecutionMode; warnings: string[] } {
    const warnings: string[] = [];
    const reserve = String(params.coinFloatPreserved ?? DEFAULT_OPERATING_COIN_FLOAT);
    switch (params.source) {
        case 'own_bank':
            return {
                step: {
                    script: 'scripts/aio-logistics.ts',
                    args: ['loadout'],
                    env: { ITEM_ID: String(params.itemId), QUANTITY: String(params.quantity) },
                },
                mode: 'script',
                warnings,
            };
        case 'npc_shop':
            return {
                step: {
                    script: 'scripts/aio-market.ts',
                    args: ['shop-buy', params.shopId ?? 'ardy', '3000'],
                    env: {
                        ITEM_ID: String(params.itemId),
                        MAX_ITEMS: String(params.quantity),
                        COIN_RESERVE: reserve,
                        NO_BUY_TICKS: '25',
                    },
                },
                mode: 'script',
                warnings,
            };
        case 'ge':
            return {
                step: {
                    script: 'scripts/aio-market.ts',
                    args: ['ge-buy'],
                    env: {
                        ITEM_ID: String(params.itemId),
                        QUANTITY: String(params.quantity),
                        COIN_RESERVE: reserve,
                    },
                },
                mode: 'script',
                warnings,
            };
        case 'hub_banker':
            return {
                step: {
                    script: 'scripts/aio-logistics.ts',
                    args: ['fleet-trade', ...(params.transferOrderId ? [params.transferOrderId] : [])],
                    env: { ITEM_ID: String(params.itemId), QUANTITY: String(params.quantity), STALL_TICKS: '0' },
                },
                mode: 'fleet_trade',
                warnings,
            };
        case 'craft_gather': {
            if (params.activityId) {
                const act = lookupActivity(params.activityId, ctx);
                if (act) {
                    const adapted = adaptActivityToStep(act, {
                        CAP: String(Math.max(1000, params.quantity * 10)),
                        TARGET_COUNT: String(params.quantity),
                    });
                    return { step: adapted.step, mode: 'script', warnings: adapted.warnings };
                }
                const family = inferFamilyFromActivityId(params.activityId);
                const adapted = adaptActivityToStep(
                    { id: params.activityId, family, kind: 'gather', config: {} },
                    { TARGET_COUNT: String(params.quantity) },
                );
                warnings.push(`activity "${params.activityId}" not found in catalog; inferred ${family} invocation`);
                return { step: adapted.step, mode: 'script', warnings };
            }
            warnings.push('craft_gather step missing activityId; defaulting to skiller');
            return {
                step: {
                    script: 'scripts/aio-skiller.ts',
                    args: ['mining', 'ore'],
                    env: { TARGET_COUNT: String(params.quantity) },
                },
                mode: 'script',
                warnings,
            };
        }
    }
}

export function adaptPlannedStep(
    account: string,
    planned: PlannedStep,
    ctx?: ScriptAdapterContext,
): AdaptedStepInvocation {
    const warnings: string[] = [];
    let step: Step;
    let mode: AdaptedExecutionMode = 'script';

    switch (planned.stepKind) {
        case 'recover': {
            if (planned.recoveryKind === 'logout') {
                mode = 'session_recovery';
                step = {
                    script: 'scripts/cloud-recover.ts',
                    args: [],
                    env: { RECOVERY_REASON: planned.reason },
                };
            } else {
                const hub = planned.targetHub ?? 'varrock_west';
                const tile = HUB_BANKER_LOCATIONS[hub].bankTile;
                step = {
                    script: 'scripts/aio-logistics.ts',
                    args: ['walk-to', String(tile.x), String(tile.z), String(tile.level)],
                    env: { RECOVERY_TARGET_HUB: hub },
                };
            }
            break;
        }
        case 'acquire': {
            const res = adaptAcquireOrGearSource(
                {
                    source: planned.source,
                    itemId: planned.itemId,
                    quantity: planned.quantity,
                    shopId: planned.shopId,
                    transferOrderId: planned.transferOrderId,
                    activityId: planned.activityId,
                    coinFloatPreserved: planned.coinFloatPreserved,
                },
                ctx,
            );
            step = res.step;
            mode = res.mode;
            warnings.push(...res.warnings);
            break;
        }
        case 'gear_upgrade': {
            const res = adaptAcquireOrGearSource(
                {
                    source: planned.source,
                    itemId: planned.itemId,
                    quantity: 1,
                },
                ctx,
            );
            step = res.step;
            mode = res.mode;
            warnings.push(...res.warnings);
            break;
        }
        case 'unlock': {
            if (planned.unlockKind === 'quest') {
                const act = lookupActivity(planned.activityId, ctx);
                if (act) {
                    const adapted = adaptActivityToStep(act);
                    step = adapted.step;
                    warnings.push(...adapted.warnings);
                } else {
                    step = {
                        script: 'scripts/aio-quester.ts',
                        args: ['sweep', planned.questSlug ?? planned.activityId.replace(/^quest:/, '')],
                        env: {},
                    };
                }
            } else {
                const act = lookupActivity(planned.activityId, ctx);
                const env: Record<string, string> = planned.targetLevel ? { TARGET_LEVEL: String(planned.targetLevel) } : {};
                if (act) {
                    const adapted = adaptActivityToStep(act, env);
                    step = adapted.step;
                    warnings.push(...adapted.warnings);
                } else {
                    const family = inferFamilyFromActivityId(planned.activityId);
                    const adapted = adaptActivityToStep(
                        { id: planned.activityId, family, kind: 'train', skill: planned.skill, config: {} },
                        env,
                    );
                    step = adapted.step;
                    warnings.push(...adapted.warnings);
                }
            }
            break;
        }
        case 'work': {
            const act = lookupActivity(planned.activityId, ctx);
            const env: Record<string, string> = {
                DEMAND_ID: planned.demandId,
                BATCH_UNITS: String(planned.batchUnits),
            };
            if (act) {
                const adapted = adaptActivityToStep(act, env);
                step = adapted.step;
                warnings.push(...adapted.warnings);
            } else {
                const family = inferFamilyFromActivityId(planned.activityId);
                const cfg = (planned.config ?? {}) as Record<string, unknown>;
                const adapted = adaptActivityToStep(
                    {
                        id: planned.activityId,
                        family,
                        kind: 'train',
                        skill: typeof cfg.skill === 'string' ? cfg.skill : undefined,
                        questSlug: typeof cfg.questSlug === 'string' ? cfg.questSlug : undefined,
                        config: cfg,
                    },
                    env,
                );
                step = adapted.step;
                warnings.push(`activity "${planned.activityId}" not found in catalog; mapped via ${family}`);
                warnings.push(...adapted.warnings);
            }
            break;
        }
    }

    return {
        account,
        stepKind: planned.stepKind,
        mode,
        step,
        argv: [step.script, account, ...step.args],
        chainStepText: formatStep(step),
        warnings,
    };
}

export function adaptAccountPlan(
    plan: AccountPlan,
    ctx?: ScriptAdapterContext,
): AdaptedAccountPlan {
    const steps = plan.steps.map((s) => adaptPlannedStep(plan.account, s, ctx));
    const warnings = steps.flatMap((s) => s.warnings);
    if (steps.length === 0) {
        return {
            account: plan.account,
            ...(plan.demandId ? { demandId: plan.demandId } : {}),
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
        steps,
        combinedStep,
        argv: [combinedStep.script, plan.account, ...combinedStep.args],
        warnings,
    };
}
