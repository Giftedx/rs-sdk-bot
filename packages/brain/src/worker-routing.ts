// Pure worker-family route compilation from Brain AccountPlans onto the 9 unified worker families.
import { GENERIC_COMBAT_MODES } from '../../workers/src/combat/types';
import { WORKER_FAMILIES, type WorkerFamily } from '../../workers/src/contracts';
import {
    DEFAULT_OPERATING_COIN_FLOAT,
    HUB_BANKER_LOCATIONS,
    type HubBankId,
    type AccountPlan,
    type AcquireSourceKind,
    type ActivityDefinition,
    type PlannedStep,
} from './contracts';
import { GE_LIMIT_BUFFER, SHOP_BUY_CAP_TICKS, shopRestockTicks } from './acquire';
import { loadItemsMap } from './preflight';
import { stallTicksForRate } from '../../core/src/ledger';

export interface WorkerRoutingContext {
    readonly activities?: readonly ActivityDefinition[];
    readonly activityById?: ReadonlyMap<string, ActivityDefinition>;
    readonly catalog?: { get(id: string): ActivityDefinition | undefined };
}

export type WorkerExecutionMode = 'worker' | 'session_recovery' | 'fleet_trade';

export interface WorkerRouteStep {
    readonly account: string;
    readonly stepKind: PlannedStep['stepKind'];
    readonly executionMode: WorkerExecutionMode;
    readonly family: WorkerFamily;
    readonly workerId: string;
    readonly activityId?: string;
    readonly routeKey: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly config: Readonly<Record<string, unknown>>;
    readonly warnings: readonly string[];
}

export interface ResolvedWorkerPlan {
    readonly account: string;
    readonly demandId?: string;
    readonly steps: readonly WorkerRouteStep[];
    readonly warnings: readonly string[];
}

const WORKER_FAMILY_SET: ReadonlySet<string> = new Set(WORKER_FAMILIES);
const BOSS_ID_RE = /^(?:(?:boss|combat):)?(?:boss-)?(kbd|black-dragon|blue-dragon|green-dragon|trawler(?:-at-site)?)$/;
const GATHER_SKILLS = new Set(['fishing', 'woodcutting', 'mining', 'thieving', 'foraging']);
const ARTISAN_SKILLS = new Set(['cooking', 'firemaking', 'fletching', 'smithing', 'crafting', 'herblore', 'prayer', 'magic']);
const STANDALONE_NON_AIO_SCRIPT_RE = /^scripts\/(?!aio-)[\w./-]+\.ts$/;

export function isSupportedWorkerFamily(value: unknown): value is WorkerFamily {
    return typeof value === 'string' && WORKER_FAMILY_SET.has(value);
}

// Match both raw metacharacters and single-escaped i.re.source strings used by selectItems().
function escapeRegExp(literal: string): string {
    return literal.replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\\\?\\${ch}`);
}

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

function inferSkillMethodFromId(activityId: string): { skill?: string; method?: string } {
    const colon = activityId.indexOf(':');
    const tail = colon >= 0 ? activityId.slice(colon + 1) : activityId;
    const parts = tail.split(/[:/]/);
    if (parts.length >= 2) {
        return { skill: parts[0], method: parts.slice(1).join(':') };
    }
    const dashParts = tail.split('-');
    if (dashParts.length >= 2) {
        return { skill: dashParts[0], method: dashParts.slice(1).join('-') };
    }
    return { method: tail };
}

function inferFamilyFromActivityId(activityId: string, configSkill?: string): WorkerFamily {
    const prefix = activityId.split(':')[0]?.toLowerCase() ?? '';
    switch (prefix) {
        case 'gather':
            return 'gather';
        case 'bank-artisan':
        case 'artisan':
            return 'bank-artisan';
        case 'combat':
        case 'fighter':
        case 'boss':
            return 'combat';
        case 'agility':
            return 'agility';
        case 'runecraft':
            return 'runecraft';
        case 'quest':
        case 'quester':
            return 'quest';
        case 'market':
            return 'market';
        case 'logistics':
            return 'logistics';
        case 'pvp':
            return 'pvp';
        case 'skiller': {
            const skill = (configSkill ?? inferSkillMethodFromId(activityId).skill ?? '').toLowerCase();
            if (skill === 'agility') return 'agility';
            if (skill === 'runecraft') return 'runecraft';
            if (GATHER_SKILLS.has(skill)) return 'gather';
            if (ARTISAN_SKILLS.has(skill)) return 'bank-artisan';
            return 'gather';
        }
        default:
            return 'gather';
    }
}

function lookupActivity(activityId: string, ctx?: WorkerRoutingContext): ActivityDefinition | undefined {
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

function explicitStandaloneScript(cfg: Record<string, unknown>): string | undefined {
    const raw = typeof cfg.standaloneScript === 'string'
        ? cfg.standaloneScript
        : typeof cfg.script === 'string'
            ? cfg.script
            : undefined;
    return raw && STANDALONE_NON_AIO_SCRIPT_RE.test(raw) ? raw : undefined;
}

export function resolveActivityWorkerRoute(
    activity: Pick<ActivityDefinition, 'id' | 'family' | 'kind' | 'skill' | 'questSlug' | 'config'> & Partial<Pick<ActivityDefinition, 'outputs' | 'baselineRate'>>,
    extraEnv: Readonly<Record<string, string>> = {},
): Omit<WorkerRouteStep, 'account' | 'stepKind' | 'executionMode'> {
    const cfg = (activity.config ?? {}) as Record<string, unknown>;
    const warnings: string[] = [];
    const explicitArgs = Array.isArray(cfg.defaultArgs)
        ? (cfg.defaultArgs as unknown[]).map(String)
        : Array.isArray(cfg.args)
            ? (cfg.args as unknown[]).map(String)
            : [];
    const env = {
        ...(cfg.defaultEnv && typeof cfg.defaultEnv === 'object' ? sanitizeEnv(cfg.defaultEnv as Record<string, unknown>) : {}),
        ...(cfg.env && typeof cfg.env === 'object' ? sanitizeEnv(cfg.env as Record<string, unknown>) : {}),
        ...extraEnv,
    };
    const standaloneScript = explicitStandaloneScript(cfg);
    const aioCategory = typeof cfg.aioCategory === 'string' ? cfg.aioCategory.toLowerCase() : undefined;
    const aioRoute = typeof cfg.aioRoute === 'string' ? cfg.aioRoute : undefined;
    const inferred = inferSkillMethodFromId(activity.id);

    switch (activity.family) {
        case 'gather':
        case 'bank-artisan': {
            const routeParts = aioRoute ? aioRoute.split(':') : [];
            let skill = (
                typeof cfg.skill === 'string'
                    ? cfg.skill
                    : routeParts[0] || activity.skill || inferred.skill || 'mining'
            ).toLowerCase();
            let rawMethod = typeof cfg.method === 'string'
                ? cfg.method
                : routeParts[1] && routeParts[1] !== 'skill-action'
                    ? routeParts[1]
                    : inferred.method;
            let args = standaloneScript
                ? [...explicitArgs]
                : [skill, ...(rawMethod ? [rawMethod] : []), ...explicitArgs];

            if (activity.family === 'bank-artisan' && !standaloneScript) {
                if (routeParts[1] === 'skill-action' && typeof cfg.method !== 'string') {
                    if (skill === 'smithing') {
                        const table = typeof cfg.table === 'string' ? cfg.table : undefined;
                        const row = typeof cfg.row === 'string' ? cfg.row : undefined;
                        if (table === 'smelting.struct' && row) {
                            rawMethod = 'smelt';
                            const bar = row.replace(/^smelting_/, '').replace(/_bar$/, '');
                            if (env.BAR_TYPE === undefined) env.BAR_TYPE = bar;
                            args = [skill, rawMethod, extraEnv.CAP ?? '1500', bar];
                        } else {
                            rawMethod = 'anvil';
                            const productId = typeof cfg.productId === 'number' ? cfg.productId : undefined;
                            if (productId !== undefined && env.PRODUCT_ID === undefined) {
                                env.PRODUCT_ID = String(productId);
                            }
                            if (env.ORDER_ACTION === undefined) env.ORDER_ACTION = 'smith';
                            args = [skill, rawMethod, ...(explicitArgs.length > 0 ? explicitArgs : [extraEnv.CAP ?? '1500'])];
                        }
                    } else if (skill === 'crafting' && typeof cfg.table === 'string' && cfg.table === 'gem_cutting_table' && typeof cfg.row === 'string') {
                        rawMethod = 'inventory';
                        const gem = cfg.row.replace(/_cutting$/, '');
                        args = [skill, rawMethod, `cut-${gem}`];
                    } else if (skill === 'herblore') {
                        const row = typeof cfg.row === 'string' ? cfg.row : undefined;
                        if (row && /^(?:unf_|3dose)/.test(row)) {
                            skill = 'crafting';
                            rawMethod = 'inventory';
                            if (env.MEMBERS === undefined) env.MEMBERS = '1';
                            args = [skill, rawMethod, `brew:${row}`];
                        } else {
                            rawMethod = 'potions';
                            args = [skill, rawMethod, ...explicitArgs];
                        }
                    }
                }
                if (skill === 'smithing' && rawMethod === 'anvil') {
                    if (env.ORDER_ACTION === undefined) env.ORDER_ACTION = 'smith';
                    if (env.BAR_RESERVE === undefined) env.BAR_RESERVE = '0';
                    const rawUnits = extraEnv.TARGET_COUNT ?? extraEnv.BATCH_UNITS;
                    const units = Number(rawUnits);
                    if (rawUnits && extraEnv.MAX_MAKE === undefined && Number.isSafeInteger(units) && units > 0) {
                        env.MAX_MAKE = String(units);
                    }
                    if (extraEnv.CAP && args.length >= 3) {
                        args[2] = extraEnv.CAP;
                    } else if (extraEnv.CAP === undefined && Number.isSafeInteger(units) && units > 1 && args.length >= 3) {
                        args[2] = String(Math.max(Number(args[2]) || 1500, units * 25 + 400));
                    }
                } else if (skill === 'smithing' && rawMethod === 'smelt') {
                    if (env.ORE_RESERVE === undefined) env.ORE_RESERVE = '0';
                    const rawUnits = extraEnv.TARGET_COUNT ?? extraEnv.BATCH_UNITS;
                    const units = Number(rawUnits);
                    if (rawUnits && extraEnv.MAX_MAKE === undefined && Number.isSafeInteger(units) && units > 0) {
                        env.MAX_MAKE = String(units);
                    }
                    if (extraEnv.CAP && args.length >= 3) {
                        args[2] = extraEnv.CAP;
                    } else if (extraEnv.CAP === undefined && Number.isSafeInteger(units) && units > 28 && args.length >= 3) {
                        args[2] = String(Math.max(Number(args[2]) || 1500, units * 20 + 400));
                    }
                } else if (skill === 'crafting' && rawMethod === 'inventory') {
                    if (extraEnv.TARGET_COUNT) {
                        env.MAX_MAKE = extraEnv.MAX_MAKE ?? extraEnv.TARGET_COUNT;
                    } else if (extraEnv.BATCH_UNITS && extraEnv.MAX_MAKE === undefined) {
                        // A work step makes the units the planner sized to the shortfall and staged inputs for. The
                        // catalog MAX_MAKE '1' made one herb a login. A bank short of the staged inputs ends the run
                        // after what it holds (best-effort); a run that makes nothing still fails.
                        const units = Number(extraEnv.BATCH_UNITS);
                        const productUnits = activity.outputs?.[0]?.countPerUnit ?? 1;
                        if (Number.isSafeInteger(units) && units > 0 && Number.isSafeInteger(productUnits) && productUnits > 0) {
                            env.MAX_MAKE = String(units * productUnits);
                            if (extraEnv.CAP === undefined) env.CAP = String(Math.max(Number(env.CAP) || 0, unlockTickCap(units)));
                            if (env.ORDER_MODE === undefined) env.ORDER_MODE = 'best-effort';
                        }
                    }
                } else if (skill === 'crafting' && rawMethod === 'tanning' && args.length >= 4) {
                    const units = Number(extraEnv.TARGET_COUNT ?? extraEnv.BATCH_UNITS);
                    if (Number.isSafeInteger(units) && units > 0) {
                        args[3] = String(units);
                        if (extraEnv.CAP !== undefined && args.length >= 5) args[4] = extraEnv.CAP;
                        else if (args.length >= 5) args[4] = String(Math.max(Number(args[4]) || 200, units * 8 + 120));
                    }
                } else if (skill === 'fletching' && rawMethod === 'arrows' && (env.MODE === 'headless' || env.MODE === 'native-arrows')) {
                    // Arrow runs make MAX_MAKE arrows in sets of 15 (fletching.ts runHeadless/runNativeArrows): the
                    // planned count rounded up to a whole set, not the worker default.
                    const units = Number(extraEnv.TARGET_COUNT ?? extraEnv.BATCH_UNITS);
                    if (extraEnv.MAX_MAKE === undefined && Number.isSafeInteger(units) && units > 0) {
                        env.MAX_MAKE = String(Math.ceil(units / 15) * 15);
                    }
                } else if (skill === 'crafting' && rawMethod === 'jewellery-trip') {
                    const rawUnits = extraEnv.TARGET_COUNT ?? extraEnv.BATCH_UNITS;
                    const units = Number(rawUnits);
                    if (rawUnits && extraEnv.TARGET === undefined && Number.isSafeInteger(units) && units > 0) {
                        env.TARGET = String(units);
                    }
                    const retTicks = Number(env.RETURN_TICKS ?? 100);
                    if (extraEnv.CAP) {
                        const capNum = Math.max(retTicks + 150, Number(extraEnv.CAP));
                        env.CAP = String(capNum);
                    } else if (Number.isSafeInteger(units) && units > 1) {
                        env.CAP = String(Math.max(retTicks + 150, Number(env.CAP) || 1500, units * 30 + 300));
                    }
                } else if (skill === 'magic' && rawMethod === 'items' && args.length >= 4) {
                    const rawUnits = extraEnv.TARGET_COUNT ?? extraEnv.BATCH_UNITS;
                    const units = Number(rawUnits);
                    if (rawUnits && Number.isSafeInteger(units) && units > 0) {
                        args[4] = String(units);
                    }
                    if (extraEnv.CAP) {
                        args[5] = extraEnv.CAP;
                    } else if (Number.isSafeInteger(units) && units > 1 && args.length >= 6) {
                        args[5] = String(Math.max(Number(args[5]) || 1200, units * 12 + 300));
                    }
                }
            }

            // A bank production run stops once it changes nothing for the window of its expected rate
            // (ledger.ts stallTicksForRate), not after the 900-tick session default.
            if (activity.family === 'bank-artisan' && env.STALL_TICKS === undefined) {
                const stall = stallTicksForRate(activity.baselineRate?.unitsPerTick);
                if (stall !== undefined) env.STALL_TICKS = String(stall);
            }
            const routeKey = rawMethod ? `${skill}:${rawMethod}` : skill;
            return {
                family: activity.family,
                workerId: activity.family,
                activityId: activity.id,
                routeKey,
                args,
                env,
                config: {
                    ...cfg,
                    skill,
                    ...(rawMethod ? { method: rawMethod } : {}),
                    ...(standaloneScript ? { standaloneScript } : {}),
                },
                warnings,
            };
        }
        case 'agility': {
            const routeParts = aioRoute ? aioRoute.split(':') : [];
            const course = typeof cfg.course === 'string'
                ? cfg.course
                : typeof cfg.method === 'string' && cfg.method !== 'order' && cfg.method !== 'specialist'
                    ? cfg.method
                    : routeParts[1] && routeParts[1] !== 'order' && routeParts[1] !== 'specialist' && routeParts[1] !== 'skill-action'
                        ? routeParts[1]
                        : inferred.method && inferred.method !== 'order' && inferred.method !== 'specialist'
                            ? inferred.method
                            : 'gnome';
            const method = typeof cfg.method === 'string' ? cfg.method : routeParts[1] ?? 'order';
            const agilityTarget = explicitArgs[0] ?? env.TARGET_LEVEL ?? env.TARGET ?? '99';
            const agilityEnv = env.TARGET_LEVEL || env.TARGET ? env : { ...env, TARGET_LEVEL: agilityTarget };
            const args = standaloneScript
                ? explicitArgs
                : ['agility', 'order', course, ...(explicitArgs.length > 0 ? explicitArgs : [agilityTarget])];
            return {
                family: 'agility',
                workerId: 'agility',
                activityId: activity.id,
                routeKey: `agility:${method === 'specialist' ? 'specialist' : course}`,
                args,
                env: agilityEnv,
                config: {
                    ...cfg,
                    course,
                    method,
                    ...(standaloneScript ? { standaloneScript } : {}),
                },
                warnings,
            };
        }
        case 'runecraft': {
            const routeParts = aioRoute ? aioRoute.split(':') : [];
            const method = typeof cfg.method === 'string'
                ? cfg.method
                : routeParts[1] && routeParts[1] !== 'skill-action'
                    ? routeParts[1]
                    : inferred.method ?? 'bank-craft';
            const args = standaloneScript ? explicitArgs : ['runecraft', method, ...explicitArgs];
            return {
                family: 'runecraft',
                workerId: 'runecraft',
                activityId: activity.id,
                routeKey: `runecraft:${method}`,
                args,
                env,
                config: {
                    ...cfg,
                    method,
                    ...(standaloneScript ? { standaloneScript } : {}),
                },
                warnings,
            };
        }
        case 'combat': {
            const boss = typeof cfg.boss === 'string'
                ? cfg.boss
                : BOSS_ID_RE.exec(activity.id)?.[1];
            if (boss) {
                const args = standaloneScript ? explicitArgs : [boss, ...explicitArgs];
                return {
                    family: 'combat',
                    workerId: 'combat',
                    activityId: activity.id,
                    routeKey: `boss:${boss}`,
                    args,
                    env,
                    config: {
                        ...cfg,
                        boss,
                        mode: boss,
                        ...(standaloneScript ? { standaloneScript } : {}),
                    },
                    warnings,
                };
            }
            const magicSkill = typeof cfg.skill === 'string' && cfg.skill.toLowerCase() === 'magic';
            if (aioCategory === 'skiller' && magicSkill) {
                const method = typeof cfg.method === 'string' ? cfg.method : inferred.method ?? 'splash';
                const mode = method.startsWith('magic-') ? method : `magic-${method}`;
                return {
                    family: 'combat',
                    workerId: 'combat',
                    activityId: activity.id,
                    routeKey: `magic:${method}`,
                    args: standaloneScript ? explicitArgs : ['magic', method, ...explicitArgs],
                    env,
                    config: {
                        ...cfg,
                        skill: 'magic',
                        method,
                        mode,
                        ...(standaloneScript ? { standaloneScript } : {}),
                    },
                    warnings,
                };
            }
            const target = typeof cfg.target === 'string'
                ? cfg.target
                : aioRoute && aioCategory === 'fighter'
                    ? aioRoute
                    : inferred.method ?? 'cow';
            return {
                family: 'combat',
                workerId: 'combat',
                activityId: activity.id,
                routeKey: target,
                args: standaloneScript ? explicitArgs : [target, ...explicitArgs],
                // The bank trips of a generic combat job bank the items that an earlier job left in the pack.
                env: GENERIC_COMBAT_MODES.has(target) && env.BANK_PACK === undefined ? { ...env, BANK_PACK: '1' } : env,
                config: {
                    ...cfg,
                    target,
                    mode: target,
                    ...(standaloneScript ? { standaloneScript } : {}),
                },
                warnings,
            };
        }
        case 'quest': {
            const explicitSlug = typeof cfg.questSlug === 'string' ? cfg.questSlug : activity.questSlug;
            const modeFromRoute = aioRoute?.startsWith('mode:') ? aioRoute.slice(5) : undefined;
            const mode = typeof cfg.mode === 'string' ? cfg.mode : modeFromRoute ?? 'sweep';
            const slug = explicitSlug ?? (modeFromRoute ? undefined : activity.id.replace(/^quest:/, ''));
            const args = standaloneScript
                ? explicitArgs
                : slug && mode === 'sweep'
                    ? ['sweep', slug, ...explicitArgs]
                    : [mode, ...(slug && slug !== mode ? [slug] : []), ...explicitArgs];
            return {
                family: 'quest',
                workerId: 'quest',
                activityId: activity.id,
                routeKey: slug ? `quest:${slug}` : `mode:${mode}`,
                args,
                env,
                config: {
                    ...cfg,
                    mode,
                    ...(slug ? { questSlug: slug } : {}),
                    ...(standaloneScript ? { standaloneScript } : {}),
                },
                warnings,
            };
        }
        case 'market': {
            const mode = typeof cfg.mode === 'string'
                ? cfg.mode
                : aioRoute ?? inferred.method ?? 'ge-buy';
            return {
                family: 'market',
                workerId: 'market',
                activityId: activity.id,
                routeKey: mode,
                args: [mode, ...explicitArgs],
                env,
                config: { ...cfg, mode },
                warnings,
            };
        }
        case 'logistics': {
            const role = typeof cfg.role === 'string'
                ? cfg.role
                : aioRoute ?? inferred.method ?? 'walk-to';
            if (role === 'charge-glory') {
                const rawUnits = extraEnv.TARGET_COUNT ?? extraEnv.BATCH_UNITS;
                const units = Number(rawUnits);
                if (rawUnits && extraEnv.MAX_GLORIES === undefined && Number.isSafeInteger(units) && units > 0) {
                    env.MAX_GLORIES = String(units);
                }
                if (extraEnv.CAP === undefined && Number.isSafeInteger(units) && units > 1) {
                    env.CAP = String(Math.max(Number(env.CAP) || 2000, Math.ceil(units / 28) * 600 + 800));
                }
            }
            return {
                family: 'logistics',
                workerId: 'logistics',
                activityId: activity.id,
                routeKey: role,
                args: [role, ...explicitArgs],
                env,
                config: { ...cfg, role },
                warnings,
            };
        }
        case 'pvp': {
            const mode = typeof cfg.mode === 'string'
                ? cfg.mode
                : aioRoute ?? inferred.method ?? 'pilot';
            return {
                family: 'pvp',
                workerId: 'pvp',
                activityId: activity.id,
                routeKey: mode,
                args: standaloneScript ? explicitArgs : [mode, ...explicitArgs],
                env,
                config: {
                    ...cfg,
                    mode,
                    ...(standaloneScript ? { standaloneScript } : {}),
                },
                warnings,
            };
        }
    }
}

// A planned shop step waits this long between purchases for the shelf to restock. The engine
// adds one unit each stockrate ticks (World.ts: tick % stockrate), and Vial of water at the
// Ardougne Adventurers' Store restocks each 30 ticks, so the wait spans more than one restock.
export const PLANNED_SHOP_NO_BUY_TICKS = 100;
const MARKET_WORK_NO_BUY_TICKS = 25;
// A shelf that restocks one unit in more ticks than the planned wait gives no unit in a wait: the Ardougne gem stall
// restocks a ruby each 60000 ticks, and Fatstack waited 100 ticks at its empty shelf. Such a shop is polled this long.
export const SLOW_RESTOCK_NO_BUY_TICKS = 5;

export function shopNoBuyTicks(itemId: number, shopId: string | undefined, plannedOrder: boolean): number {
    const wait = plannedOrder ? PLANNED_SHOP_NO_BUY_TICKS : MARKET_WORK_NO_BUY_TICKS;
    const restock = shopId ? shopRestockTicks(itemId, shopId) : undefined;
    return restock !== undefined && restock > PLANNED_SHOP_NO_BUY_TICKS ? SLOW_RESTOCK_NO_BUY_TICKS : wait;
}

function resolveAcquireOrGearSource(
    account: string,
    stepKind: 'acquire' | 'gear_upgrade',
    params: {
        source: AcquireSourceKind;
        itemId: number;
        itemName?: string;
        quantity: number;
        stockTarget?: number;
        ownedBefore?: number;
        shopId?: string;
        transferOrderId?: string;
        activityId?: string;
        estimatedCoinCost?: number;
        coinFloatPreserved?: number;
    },
    ctx?: WorkerRoutingContext,
    // A prep step feeds the next step of its chain, so its shop order must fill. A market work step
    // is the demand's own progress, so a partial purchase passes and the demand keeps the rest.
    plannedOrder = true,
): WorkerRouteStep {
    const reserveNum = Math.max(0, Math.floor(params.coinFloatPreserved ?? DEFAULT_OPERATING_COIN_FLOAT));
    const reserve = String(reserveNum);
    const resolvedItemName = params.itemName ?? loadItemsMap().get(params.itemId)?.name;
    switch (params.source) {
        case 'own_bank':
            return {
                account,
                stepKind,
                executionMode: 'worker',
                family: 'logistics',
                workerId: 'logistics',
                routeKey: 'loadout',
                args: ['loadout'],
                env: {
                    ITEM_ID: String(params.itemId),
                    QUANTITY: String(params.quantity),
                    ...(resolvedItemName ? { ITEM_NAME: resolvedItemName } : {}),
                    ...(stepKind === 'gear_upgrade' ? { EQUIP: '1' } : {}),
                },
                config: { role: 'loadout', itemId: params.itemId, quantity: params.quantity },
                warnings: [],
            };
        case 'npc_shop': {
            const floatAmount = Math.max(20_000, reserveNum + Math.max(0, Math.ceil(params.estimatedCoinCost ?? 0)) + 1_000);
            const profile = params.shopId ?? 'ardy';
            const escapedItemName = resolvedItemName ? escapeRegExp(resolvedItemName) : undefined;
            const items = escapedItemName ?? String(params.itemId);
            // A gear upgrade wants one owned copy; an acquire names the owned total its consumer needs.
            const stockTarget = !plannedOrder ? undefined : stepKind === 'gear_upgrade' ? 1 : params.stockTarget;
            const noBuyTicks = shopNoBuyTicks(params.itemId, params.shopId, plannedOrder);
            return {
                account,
                stepKind,
                executionMode: 'worker',
                family: 'market',
                workerId: 'market',
                routeKey: 'shop-buy',
                args: ['shop-buy', profile, String(SHOP_BUY_CAP_TICKS)],
                env: {
                    ITEM_ID: String(params.itemId),
                    ...(escapedItemName ? { ITEMS: escapedItemName } : {}),
                    MAX_ITEMS: String(params.quantity),
                    ...(stockTarget !== undefined ? { STOCK_TARGET: String(stockTarget) } : {}),
                    COIN_RESERVE: reserve,
                    FLOAT: String(floatAmount),
                    NO_BUY_TICKS: String(noBuyTicks),
                    STOP_AT_TARGET: '1',
                    ...(plannedOrder ? { FILL_ORDER: '1' } : {}),
                    BANK_PACK: '1',
                },
                config: {
                    mode: 'shop-buy',
                    profile,
                    cap: SHOP_BUY_CAP_TICKS,
                    items,
                    maxItems: params.quantity,
                    ...(stockTarget !== undefined ? { stockTarget } : {}),
                    coinReserve: reserveNum,
                    float: floatAmount,
                    noBuyTicks,
                    stopAtTarget: true,
                    ...(plannedOrder ? { fillOrder: true } : {}),
                    bankPack: true,
                    shopId: profile,
                    itemId: params.itemId,
                    quantity: params.quantity,
                },
                warnings: [],
            };
        }
        case 'ge': {
            const unitLimit = params.estimatedCoinCost && params.estimatedCoinCost > 0
                ? Math.max(1, Math.ceil((params.estimatedCoinCost / Math.max(1, params.quantity)) * GE_LIMIT_BUFFER))
                : undefined;
            // The owned count that the plan saw. The GE worker refuses a held item without it.
            const expectedOwned = stepKind === 'acquire' && params.ownedBefore !== undefined ? params.ownedBefore : undefined;
            const ownedPart = expectedOwned !== undefined ? `-o${expectedOwned}` : '';
            const orderKey = unitLimit
                ? `brain-${params.itemId}-${params.quantity}${ownedPart}-p${unitLimit}`
                : `brain-${params.itemId}-${params.quantity}${ownedPart}`;
            return {
                account,
                stepKind,
                executionMode: 'worker',
                family: 'market',
                workerId: 'market',
                routeKey: 'ge-buy',
                args: ['ge-buy'],
                env: {
                    ORDER_KEY: orderKey,
                    ITEM_ID: String(params.itemId),
                    QUANTITY: String(params.quantity),
                    CASH_RESERVE: reserve,
                    COIN_RESERVE: reserve,
                    ...(unitLimit ? { LIMIT_PRICE: String(unitLimit) } : {}),
                    ...(expectedOwned !== undefined ? { EXPECTED_OWNED: String(expectedOwned) } : {}),
                },
                config: { mode: 'ge-buy', itemId: params.itemId, quantity: params.quantity, ...(expectedOwned !== undefined ? { expectedOwned } : {}) },
                warnings: [],
            };
        }
        case 'hub_banker':
            return {
                account,
                stepKind,
                executionMode: 'fleet_trade',
                family: 'logistics',
                workerId: 'logistics',
                routeKey: 'fleet-trade',
                args: ['fleet-trade', ...(params.transferOrderId ? [params.transferOrderId] : [])],
                env: { ITEM_ID: String(params.itemId), QUANTITY: String(params.quantity), STALL_TICKS: '0' },
                config: {
                    role: 'fleet-trade',
                    itemId: params.itemId,
                    quantity: params.quantity,
                    ...(params.transferOrderId ? { transferOrderId: params.transferOrderId } : {}),
                },
                warnings: [],
            };
        case 'craft_gather': {
            if (params.activityId) {
                const act = lookupActivity(params.activityId, ctx);
                if (act) {
                    const resolved = resolveActivityWorkerRoute(act, {
                        CAP: String(Math.max(1000, params.quantity * 10)),
                        TARGET_COUNT: String(params.quantity),
                        // Inventory production makes only what the bank lacks of this owned total.
                        ...(params.stockTarget !== undefined ? { PRODUCT_TARGET: String(params.stockTarget) } : {}),
                    });
                    return { account, stepKind, executionMode: 'worker', ...resolved };
                }
                const family = inferFamilyFromActivityId(params.activityId);
                const resolved = resolveActivityWorkerRoute(
                    { id: params.activityId, family, kind: 'gather', config: {} },
                    { TARGET_COUNT: String(params.quantity) },
                );
                return {
                    account,
                    stepKind,
                    executionMode: 'worker',
                    ...resolved,
                    warnings: [
                        `activity "${params.activityId}" not found in catalog; inferred ${family} worker route`,
                        ...resolved.warnings,
                    ],
                };
            }
            return {
                account,
                stepKind,
                executionMode: 'worker',
                family: 'gather',
                workerId: 'gather',
                routeKey: 'mining:ore',
                args: ['mining', 'ore'],
                env: { TARGET_COUNT: String(params.quantity) },
                config: { skill: 'mining', method: 'ore' },
                warnings: ['craft_gather step missing activityId; defaulting to gather mining:ore'],
            };
        }
    }
}

// Inventory production makes one unit per bank trip. The bench case extra:inventory-unlock-level identifies
// 14 herbs in 78 ticks (5.6 a unit); the cap allows about twice that.
const UNLOCK_TICKS_PER_UNIT = 12;

function unlockTickCap(units: number): number {
    return Math.max(1000, units * UNLOCK_TICKS_PER_UNIT);
}

// The next chain step needs the unlock level, so inventory production passes only at that level, ends when
// its inputs end, and a chain rerun at the level makes nothing (ORDER_MODE=level). Smelting reads
// ORDER_MODE as exact or best-effort, so other routes keep their own rule.
function unlockLevelOrder(
    resolved: Omit<WorkerRouteStep, 'account' | 'stepKind' | 'executionMode'>,
    targetLevel: number | undefined,
): Omit<WorkerRouteStep, 'account' | 'stepKind' | 'executionMode'> {
    if (!targetLevel || resolved.routeKey !== 'crafting:inventory') return resolved;
    return { ...resolved, env: { ...resolved.env, ORDER_MODE: 'level' } };
}

function applyTargetLevelArg(
    resolved: Omit<WorkerRouteStep, 'account' | 'stepKind' | 'executionMode'>,
    targetLevel: number | undefined,
): Omit<WorkerRouteStep, 'account' | 'stepKind' | 'executionMode'> {
    if (!targetLevel || !Number.isFinite(targetLevel)) return resolved;
    if (
        (resolved.routeKey === 'magic:splash' || resolved.routeKey === 'magic:splash-coop')
        && resolved.args[0] === 'magic'
        && resolved.args.length >= 3
    ) {
        const nextArgs = [...resolved.args];
        nextArgs[2] = String(targetLevel);
        return { ...resolved, args: nextArgs };
    }
    if (resolved.routeKey === 'magic:alch-train' && resolved.args[0] === 'magic' && resolved.args.length >= 3) {
        const nextArgs = [...resolved.args];
        nextArgs[2] = String(Math.max(55, targetLevel));
        return { ...resolved, args: nextArgs };
    }
    if (resolved.family === 'agility' && resolved.args[0] === 'agility' && resolved.args[1] === 'order' && resolved.args.length >= 4) {
        const nextArgs = [...resolved.args];
        nextArgs[3] = String(targetLevel);
        return { ...resolved, args: nextArgs };
    }
    return resolved;
}

// The reason of a location recovery for an account inside a walled place (snapshot.ts WALLED_REGIONS). The
// recovery runs the quest that opens the place instead of the walk to a hub.
export function walledRecoveryReason(region: { readonly id: string; readonly openedByQuest: string }): string {
    return `walled in ${region.id}; exit by quest:${region.openedByQuest}`;
}

function walledRecoveryQuest(reason: string): string | undefined {
    // openedByQuest is a quest-journal name (snapshot.ts questComplete ignores case and a "quest_" prefix); the
    // catalog quest id is lower case without the prefix.
    return /^walled in \S+; exit by quest:([a-z0-9_-]+)$/i.exec(reason)?.[1]?.toLowerCase().replace(/^quest_/, '');
}

export function resolvePlannedStepWorkerRoute(
    account: string,
    planned: PlannedStep,
    ctx?: WorkerRoutingContext,
): WorkerRouteStep {
    switch (planned.stepKind) {
        case 'recover': {
            if (planned.recoveryKind === 'logout') {
                return {
                    account,
                    stepKind: 'recover',
                    executionMode: 'session_recovery',
                    family: 'logistics',
                    workerId: 'logistics',
                    routeKey: 'logout',
                    args: [],
                    env: { RECOVERY_REASON: planned.reason },
                    config: { recoveryKind: 'logout', reason: planned.reason },
                    warnings: [],
                };
            }
            if (planned.recoveryKind === 'stage' && planned.targetTile) {
                // The walk withdraws STAGE_KIT into the pack at the nearest bank first (logistics module walk-to).
                const tile = planned.targetTile;
                const kit = (planned.kit ?? []).map((k) => `${k.itemId}:${k.count}`).join(',');
                return {
                    account,
                    stepKind: 'recover',
                    executionMode: 'worker',
                    family: 'logistics',
                    workerId: 'logistics',
                    routeKey: 'walk-to',
                    args: ['walk-to', String(tile.x), String(tile.z), String(tile.level)],
                    env: {
                        RECOVERY_REASON: planned.reason,
                        ...(kit ? { STAGE_KIT: kit } : {}),
                        ...(planned.keep || planned.keepCounts
                            ? { STAGE_KEEP: [...(planned.keep ?? []).map(String), ...(planned.keepCounts ?? []).map((k) => `${k.itemId}:${k.count}`)].join(',') }
                            : {}),
                    },
                    config: { role: 'walk-to', tile, ...(planned.kit ? { kit: planned.kit } : {}) },
                    warnings: [],
                };
            }
            const walledQuest = walledRecoveryQuest(planned.reason);
            if (walledQuest) {
                // No walk crosses the wall of a walled place, so the walk to a hub has no route. The quest that opens
                // the place has its own exit (quest-biohazard.ts outByKilron or its Ardougne teleport).
                const act = lookupActivity(`quest:${walledQuest}`, ctx);
                const resolved = act
                    ? resolveActivityWorkerRoute(act)
                    : {
                        family: 'quest' as const,
                        workerId: 'quest',
                        activityId: `quest:${walledQuest}`,
                        routeKey: `quest:${walledQuest}`,
                        args: ['sweep', walledQuest],
                        env: {},
                        config: { mode: 'sweep', questSlug: walledQuest },
                        warnings: [],
                    };
                return {
                    account,
                    stepKind: 'recover',
                    executionMode: 'worker',
                    ...resolved,
                    env: { ...resolved.env, RECOVERY_REASON: planned.reason },
                };
            }
            const hub = planned.targetHub ?? 'varrock_west';
            const tile = HUB_BANKER_LOCATIONS[hub].bankTile;
            // The planner picks the hub by distance and runs no route search. The walk searches the route for the
            // account: its levels close the ground of monsters that would kill it, and its coins pay the boats. From
            // Burthorpe a 10 HP account has no route to Ardougne (White Wolf Mountain) but has one to Varrock West.
            // When the search finds no route, the walk tries the other hub, then the known banks nearest the account.
            const others = (Object.keys(HUB_BANKER_LOCATIONS) as HubBankId[]).filter(id => id !== hub).map(id => HUB_BANKER_LOCATIONS[id].bankTile);
            const or = others.map(t => `${t.x},${t.z},${t.level}`).join(';');
            return {
                account,
                stepKind: 'recover',
                executionMode: 'worker',
                family: 'logistics',
                workerId: 'logistics',
                routeKey: 'walk-to',
                args: ['walk-to', String(tile.x), String(tile.z), String(tile.level), ...(or ? [`--or=${or}`] : []), '--or-bank'],
                env: { RECOVERY_TARGET_HUB: hub },
                config: { role: 'walk-to', targetHub: hub, tile, fallbacks: others, orBank: true },
                warnings: [],
            };
        }
        case 'acquire':
            return resolveAcquireOrGearSource(account, 'acquire', planned, ctx);
        case 'gear_upgrade':
            return resolveAcquireOrGearSource(
                account,
                'gear_upgrade',
                {
                    source: planned.source,
                    itemId: planned.itemId,
                    itemName: planned.itemName,
                    quantity: 1,
                    shopId: planned.shopId,
                    transferOrderId: planned.transferOrderId,
                    activityId: planned.activityId,
                    estimatedCoinCost: planned.estimatedCoinCost,
                    coinFloatPreserved: planned.coinFloatPreserved,
                },
                ctx,
            );
        case 'unlock': {
            const act = lookupActivity(planned.activityId, ctx);
            if (planned.unlockKind === 'quest') {
                if (act) {
                    const resolved = resolveActivityWorkerRoute(act);
                    return { account, stepKind: 'unlock', executionMode: 'worker', ...resolved };
                }
                const slug = planned.questSlug ?? planned.activityId.replace(/^quest:/, '');
                return {
                    account,
                    stepKind: 'unlock',
                    executionMode: 'worker',
                    family: 'quest',
                    workerId: 'quest',
                    activityId: planned.activityId,
                    routeKey: `quest:${slug}`,
                    args: ['sweep', slug],
                    env: {},
                    config: { mode: 'sweep', questSlug: slug },
                    warnings: [],
                };
            }
            // A sized unlock makes the units that the planner staged inputs for, as a craft_gather step
            // makes its quantity.
            const env: Record<string, string> = {
                ...(planned.skill ? { TRAIN_SKILL: planned.skill } : {}),
                ...(planned.targetLevel ? { TARGET_LEVEL: String(planned.targetLevel) } : {}),
                ...(planned.batchUnits ? { TARGET_COUNT: String(planned.batchUnits), CAP: String(unlockTickCap(planned.batchUnits)) } : {}),
            };
            if (act) {
                const resolved = applyTargetLevelArg(resolveActivityWorkerRoute(act, env), planned.targetLevel);
                return { account, stepKind: 'unlock', executionMode: 'worker', ...unlockLevelOrder(resolved, planned.targetLevel) };
            }
            const family = inferFamilyFromActivityId(planned.activityId, planned.skill);
            const resolved = applyTargetLevelArg(resolveActivityWorkerRoute(
                { id: planned.activityId, family, kind: 'train', skill: planned.skill, config: {} },
                env,
            ), planned.targetLevel);
            return { account, stepKind: 'unlock', executionMode: 'worker', ...unlockLevelOrder(resolved, planned.targetLevel) };
        }
        case 'work': {
            const cfg = (planned.config ?? {}) as Record<string, unknown>;
            if (
                (planned.activityId === 'market:shop-buy' || planned.activityId === 'market:ge-buy')
                && Number.isSafeInteger(cfg.itemId)
                && Number.isSafeInteger(cfg.quantity)
                && Number(cfg.quantity) >= 1
            ) {
                const routed = resolveAcquireOrGearSource(
                    account,
                    'acquire',
                    {
                        source: planned.activityId === 'market:shop-buy' ? 'npc_shop' : 'ge',
                        itemId: Number(cfg.itemId),
                        itemName: typeof cfg.itemName === 'string' ? cfg.itemName : undefined,
                        quantity: Number(cfg.quantity),
                        shopId: typeof cfg.shopId === 'string' ? cfg.shopId : undefined,
                        estimatedCoinCost: typeof cfg.estimatedCoinCost === 'number' ? cfg.estimatedCoinCost : undefined,
                        coinFloatPreserved: typeof cfg.coinFloatPreserved === 'number' ? cfg.coinFloatPreserved : undefined,
                        ownedBefore: Number.isSafeInteger(cfg.ownedBefore) && Number(cfg.ownedBefore) >= 0 ? Number(cfg.ownedBefore) : undefined,
                    },
                    ctx,
                    false,
                );
                return {
                    ...routed,
                    stepKind: 'work',
                    activityId: planned.activityId,
                    env: {
                        ...routed.env,
                        DEMAND_ID: planned.demandId,
                        BATCH_UNITS: String(planned.batchUnits),
                    },
                };
            }
            const act = lookupActivity(planned.activityId, ctx);
            const targetLevel = typeof cfg.targetLevel === 'number' && Number.isFinite(cfg.targetLevel)
                ? Math.trunc(cfg.targetLevel)
                : undefined;
            const env: Record<string, string> = {
                ...(typeof cfg.trainSkill === 'string' ? { TRAIN_SKILL: cfg.trainSkill } : {}),
                ...(targetLevel !== undefined ? { TARGET_LEVEL: String(targetLevel) } : {}),
                DEMAND_ID: planned.demandId,
                BATCH_UNITS: String(planned.batchUnits),
            };
            if (act) {
                const resolved = applyTargetLevelArg(resolveActivityWorkerRoute(act, env), targetLevel);
                return { account, stepKind: 'work', executionMode: 'worker', ...resolved };
            }
            const skill = typeof cfg.skill === 'string' ? cfg.skill : undefined;
            const family = inferFamilyFromActivityId(planned.activityId, skill);
            const resolved = applyTargetLevelArg(resolveActivityWorkerRoute(
                {
                    id: planned.activityId,
                    family,
                    kind: 'train',
                    skill,
                    questSlug: typeof cfg.questSlug === 'string' ? cfg.questSlug : undefined,
                    config: cfg,
                },
                env,
            ), targetLevel);
            return {
                account,
                stepKind: 'work',
                executionMode: 'worker',
                ...resolved,
                warnings: [
                    `activity "${planned.activityId}" not found in catalog; routed via ${family}`,
                    ...resolved.warnings,
                ],
            };
        }
    }
}

export function resolveAccountWorkerPlan(
    plan: AccountPlan,
    ctx?: WorkerRoutingContext,
): ResolvedWorkerPlan {
    let resolvedCtx = ctx;
    if (ctx && !ctx.catalog && !ctx.activityById && ctx.activities && plan.steps.length > 1) {
        const activityById = new Map<string, ActivityDefinition>();
        for (const a of ctx.activities) activityById.set(a.id, a);
        resolvedCtx = { ...ctx, activityById };
    }
    const steps = plan.steps.map((s) => resolvePlannedStepWorkerRoute(plan.account, s, resolvedCtx));
    return {
        account: plan.account,
        ...(plan.demandId ? { demandId: plan.demandId } : {}),
        steps,
        warnings: steps.flatMap((s) => s.warnings),
    };
}
