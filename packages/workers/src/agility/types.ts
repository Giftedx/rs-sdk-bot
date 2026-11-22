// Types, configuration normalization, and outcome shapes for the unified Agility worker.
import type { accountOf, finish, getWorld, openBot } from '../../../core/src/bot';

export type CourseName = 'gnome' | 'barbarian' | 'wilderness';
export type AgilityCourseId = CourseName | 'brimhaven' | 'progressive' | 'ape-atoll';
export type Course = CourseName;

export interface TileRect {
    readonly x1: number;
    readonly x2: number;
    readonly z1: number;
    readonly z2: number;
    readonly level: number;
}

export interface Step {
    readonly name: string;
    readonly id: number;
    readonly x: number;
    readonly z: number;
    readonly zero?: boolean;
}

export interface CourseDefinition {
    readonly start: { readonly x: number; readonly z: number };
    readonly steps: Step[];
    readonly pit?: Step;
}

export interface AgilityOptions {
    course: AgilityCourseId;
    target: number;
    maxLaps: number;
    stopOnMaxLaps?: boolean;
    maxTicks: number;
    progressTicks: number;
    entryTicks: number;
    potion: boolean;
    barcrawl?: number;
    tradeTickets?: boolean;
}

export interface AgilityEntrySummary {
    route: 'none' | 'walk' | 'draynor' | 'brimhaven';
    fares: number;
    foodBought: number;
    coinsSpent: number;
    eats: number;
    gate: { opens: number; femi: number; at: string; tick: number } | null;
}

export interface AgilityResult {
    ok: boolean;
    at: string;
    course: AgilityCourseId;
    target: number;
    beforeLevel: number;
    level: number;
    xpGained: number;
    laps: number;
    falls: number;
    pitExits: number;
    eats: number;
    finalHp: number;
    entry: AgilityEntrySummary;
    ticks: number;
    tickets?: number;
}

export interface AgilitySessionOutcome {
    ok: boolean;
    kind: 'completed' | 'failed' | 'refused' | 'died' | 'aborted';
    detail: string;
    delta?: {
        xp?: Record<string, number>;
        items?: Record<number, number>;
        coins?: number;
        elapsedTicks?: number;
    };
    result?: AgilityResult;
}

export interface AgilityExternalDeps {
    openBot?: typeof openBot;
    finish?: (...args: Parameters<typeof finish>) => Promise<unknown>;
    getWorld?: typeof getWorld;
    accountOf?: typeof accountOf;
    readSave?: (path: string) => { vars: Record<number, number>; skills: readonly { level: number }[] };
}

export interface AgilityConfig {
    course?: string;
    method?: string;
    targetLevel?: number;
    maxLaps?: number;
    stopOnMaxLaps?: boolean;
    maxTicks?: number;
    entryTicks?: number;
    progressTicks?: number;
    usePotion?: boolean;
    barcrawl?: number;
    tradeTickets?: boolean;
    saveName?: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string | undefined>>;
    deps?: AgilityExternalDeps;
}

export interface NormalizedAgilityConfig extends AgilityConfig {
    course: string;
    targetLevel: number;
    args: readonly string[];
    env: Readonly<Record<string, string | undefined>>;
}

export function resolveAgilitySetting(
    args: readonly string[],
    env: Readonly<Record<string, string | undefined>>,
    key: string,
): string | undefined {
    const prefix = `${key}=`;
    const fromArg = args.find(a => a.startsWith(prefix))?.slice(prefix.length);
    if (fromArg !== undefined && fromArg !== '') return fromArg;
    const direct = env[key];
    return direct !== undefined && direct !== '' ? direct : undefined;
}

export function canonicalCourseName(raw: string): string {
    const s = raw.trim().toLowerCase().replace(/_/g, '-');
    if (s === 'apeatoll' || s === 'ape-atoll' || s === 'ape') return 'ape-atoll';
    if (s === 'arena' || s === 'brimhaven-arena' || s === 'agility-arena') return 'brimhaven';
    if (s === 'barb') return 'barbarian';
    if (s === 'wildy') return 'wilderness';
    return s;
}

export function normalizeAgilityConfig(rawCfg: AgilityConfig = {}): NormalizedAgilityConfig {
    const args = rawCfg.args ?? [];
    const env = rawCfg.env ?? {};
    const positionals = args.filter(a => !a.includes('=') && !a.startsWith('--'));
    let rawCourse = rawCfg.course;
    let positionalTarget: string | undefined;

    if (!rawCourse) {
        if (rawCfg.method && rawCfg.method !== 'order') {
            rawCourse = rawCfg.method;
            positionalTarget = positionals[0];
        } else {
            rawCourse = resolveAgilitySetting(args, env, 'AGI_COURSE')
                ?? resolveAgilitySetting(args, env, 'COURSE')
                ?? (positionals[0] && !/^\d+$/.test(positionals[0]) ? positionals[0] : undefined)
                ?? 'gnome';
            positionalTarget = positionals.length > 1
                ? positionals[1]
                : (positionals[0] && /^\d+$/.test(positionals[0]) ? positionals[0] : undefined);
        }
    } else {
        positionalTarget = positionals.find(p => /^\d+$/.test(p));
    }

    const rawTarget = rawCfg.targetLevel
        ?? Number(resolveAgilitySetting(args, env, 'TARGET_LEVEL') ?? resolveAgilitySetting(args, env, 'TARGET') ?? positionalTarget ?? 99);

    const maxLapsRaw = rawCfg.maxLaps
        ?? (resolveAgilitySetting(args, env, 'AGI_MAX_LAPS') !== undefined || resolveAgilitySetting(args, env, 'MAX_LAPS') !== undefined
            ? Number(resolveAgilitySetting(args, env, 'AGI_MAX_LAPS') ?? resolveAgilitySetting(args, env, 'MAX_LAPS'))
            : undefined);

    return {
        ...rawCfg,
        course: canonicalCourseName(String(rawCourse)),
        targetLevel: rawTarget,
        ...(maxLapsRaw !== undefined && Number.isSafeInteger(maxLapsRaw) && maxLapsRaw > 0
            ? { maxLaps: maxLapsRaw, stopOnMaxLaps: rawCfg.stopOnMaxLaps ?? (rawCfg.targetLevel === undefined && positionalTarget === undefined) }
            : {}),
        args,
        env,
    };
}
