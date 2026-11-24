// Runecraft worker types, mode normalization, external dependency injection, and server XP table.
import type { BankProfile, BankRouteJob } from '../../../core/src/bank-trip';
import type { Session } from '../../../core/src/inprocess';

export const RUNECRAFT_MODES = [
    'bank-craft',
    'nature',
    'supply',
    'air',
    'carriers',
    'staged',
    'body-continuation',
    'body-measure',
    'stage-carriers',
    'stage-opening',
] as const;

export type RunecraftMode = (typeof RUNECRAFT_MODES)[number];

export interface NatureJob {
    target: number;
    batch: number;
    cap: number;
    returnTicks: number;
    reserve: number;
    members: boolean;
    protectMelee?: boolean;
    xpRate?: number;
}

export interface RunecraftStageOwnershipDeps {
    readCoordinatorState: () => any;
    readSwarmJobs: () => any[];
    readStatus: (name: string) => any;
}

export interface RunecraftExternalDeps {
    openBot?: typeof import('../../../core/src/bot').openBot;
    finish?: (...args: Parameters<typeof import('../../../core/src/bot').finish>) => Promise<unknown>;
    settle?: typeof import('../../../core/src/bot').settle;
    getWorld?: typeof import('../../../core/src/bot').getWorld;
    accountOf?: typeof import('../../../core/src/bot').accountOf;
    runBankProfile?: (
        session: Session,
        job: BankRouteJob,
        profile: BankProfile,
        stop?: () => boolean,
    ) => Promise<any>;
    runRuneMysteries?: (
        session: Session,
        options?: { cap?: number; stop?: () => boolean; food?: number[]; eatAt?: number },
    ) => Promise<{ ok: boolean; [key: string]: unknown }>;
    trainChickens?: (
        session: Session,
        ticks: number,
        bank: 'draynor' | 'varrock',
        combatLevel: number,
        options?: { rawChicken?: number; stop?: () => boolean },
    ) => Promise<{ ok: boolean; [key: string]: unknown }>;
    leaveRuneStarter?: (session: Session, stop?: () => boolean) => Promise<void>;
    stageOwnership?: RunecraftStageOwnershipDeps;
}

export interface RunecraftConfig {
    mode?: RunecraftMode;
    target?: number;
    targetLevel?: number;
    altar?: string;
    essenceTarget?: number;
    cap?: number;
    members?: boolean;
    natureJob?: NatureJob;
    jobPath?: string;
    roster?: readonly string[];
    measurePacks?: number;
    stagePurpose?: string;
    xpRate?: number;
    args?: readonly string[];
    env?: Readonly<Record<string, string | undefined>>;
    stop?: () => boolean;
    deps?: RunecraftExternalDeps;
}

export interface NormalizedRunecraftConfig {
    mode: RunecraftMode;
    targetLevel: number;
    altar?: string;
    essenceTarget?: number;
    cap: number;
    members: boolean;
    natureJob?: NatureJob;
    jobPath?: string;
    roster: readonly string[];
    measurePacks?: number;
    stagePurpose?: string;
    xpRate: number;
    args: readonly string[];
    env: Readonly<Record<string, string | undefined>>;
    deps: RunecraftExternalDeps;
}

export interface RunecraftSessionOutcome {
    ok: boolean;
    kind: 'completed' | 'refused' | 'missing_supply' | 'stopped' | 'failed';
    mode: RunecraftMode;
    detail?: string;
    unitsCompleted?: number;
    xpGained?: number;
    itemsDelta?: Readonly<Record<number, number>>;
    missing?: readonly { itemId: number; required: number; available: number }[];
    data?: unknown;
}

const LEVEL_XP_TABLE: number[] = (() => {
    const t: number[] = [];
    let acc = 0;
    for (let i = 0; i < 99; i++) {
        const level = i + 1;
        acc += Math.floor(level + Math.pow(2.0, level / 10.0) * 300.0);
        t.push((Math.floor(acc / 4) * 10) / 10);
    }
    return t;
})();

/** Return whole XP required for `level` (1..99) on this rev-289 server curve. */
export function xpForLevel(level: number): number {
    if (level <= 1) return 0;
    return LEVEL_XP_TABLE[Math.min(level, 99) - 2]!;
}

/** Return the rev-289 skill level corresponding to `xp`. */
export function levelForXp(xp: number): number {
    for (let i = 97; i >= 0; i--) {
        if (xp >= LEVEL_XP_TABLE[i]!) return Math.min(i + 2, 99);
    }
    return 1;
}

export function normalizeRunecraftConfig(cfg: RunecraftConfig = {}): NormalizedRunecraftConfig {
    const env = cfg.env ?? {};
    const mode = cfg.mode ?? 'bank-craft';
    const rawTarget = cfg.targetLevel ?? cfg.target;
    const defaultTarget = mode === 'supply' ? 20 : 99;
    const targetLevel = rawTarget ?? defaultTarget;
    const defaultCap = mode === 'supply' ? 30000 : mode === 'carriers' || mode === 'staged' || mode === 'body-continuation' || mode === 'body-measure' ? 2800 : mode === 'stage-carriers' || mode === 'stage-opening' ? 1600 : 20000;
    const cap = cfg.cap ?? (env.CAP !== undefined ? Number(env.CAP) : defaultCap);
    const altar = cfg.altar ?? env.RUNE_ALTAR;
    const essenceTarget = cfg.essenceTarget ?? (env.ESSENCE_TARGET !== undefined ? Number(env.ESSENCE_TARGET) : undefined);
    const xpRate = cfg.xpRate ?? (env.XP_RATE !== undefined ? Number(env.XP_RATE) : 25);

    return {
        mode,
        targetLevel,
        altar,
        essenceTarget,
        cap,
        members: cfg.members ?? (env.MEMBERS === '0' || env.MEMBERS === 'false' ? false : true),
        natureJob: cfg.natureJob,
        jobPath: cfg.jobPath,
        roster: cfg.roster ?? [],
        measurePacks: cfg.measurePacks,
        stagePurpose: cfg.stagePurpose ?? env.RUNE_STAGE_PURPOSE,
        xpRate: Number.isFinite(xpRate) && xpRate > 0 ? xpRate : 25,
        args: cfg.args ?? [],
        env,
        deps: cfg.deps ?? {},
    };
}
