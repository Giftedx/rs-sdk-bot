// Shared configuration, route taxonomy, and dependency injection types for the unified bank-artisan WorkerModule.
import type { Session } from '../../../core/src/inprocess';
import type { SessionCore } from '../contracts';
export type { Session };

export const ARTISAN_METHOD_MAP = {
    cooking: ['food', 'stock', 'wine', 'mixed-wine', 'batch', 'ge-cook'],
    firemaking: ['order', 'line', 'ge'],
    fletching: ['arrows', 'shafts', 'worker'],
    smithing: ['smelt', 'anvil', 'cannonballs'],
    crafting: [
        'bowstrings',
        'jewellery',
        'jewellery-trip',
        'legacy-jewelry',
        'glass',
        'tanning',
        'black-dhide-sets',
        'soften-clay',
        'inventory',
        'progressive',
    ],
    herblore: ['potions', 'meats'],
    prayer: ['bury'],
    magic: ['items', 'teleport', 'trip', 'orbs', 'orbs-at-site', 'bones', 'earth-production', 'alch-train'],
    foraging: ['care', 'miscellania-coffer', 'qol'],
    'bank-job': ['run'],
} as const;

export type ArtisanSkill = keyof typeof ARTISAN_METHOD_MAP;

export const VALID_ARTISAN_SKILLS = Object.keys(ARTISAN_METHOD_MAP) as ArtisanSkill[];

export interface ArtisanExternalDeps {
    workScript?: string;
    runBankProfile?: (s: unknown, j: unknown, p: unknown, requestStop?: () => boolean) => Promise<{
        ok: boolean;
        completed: number;
        trips: number;
        atBank: boolean;
        failure: string;
        ticks?: number;
        durationTicks?: number;
    }>;
    runBankJob?: (s: unknown, job: unknown, requestStop?: () => boolean) => Promise<{
        ok: boolean;
        completed: number;
        trips: number;
        atBank: boolean;
        failure: string;
        [k: string]: unknown;
    }>;
    validateBankJob?: (j: unknown) => void;
    actionSessionOwner?: (raw: unknown, stop?: () => boolean, exists?: (path: string) => boolean, options?: { allowDamage?: boolean }) => unknown;
    finishActionSession?: (owner: unknown, ok: boolean, detail: string) => Promise<unknown>;
    nativeNpcSpell?: (name: string) => {
        name: string;
        component: string;
        level: number;
        runes: Record<number, number>;
        debuff: boolean;
        members: boolean;
        requiredWorn?: number;
    };
    runNpcMagic?: (s: unknown, spell: unknown, opts: Record<string, unknown>) => Promise<{
        ok: boolean;
        stop: string;
        failure: string;
        casts: number;
        ticks: number;
    }>;
    combatTeleportAllowed?: (p: { worldX: number; worldZ: number; level: number }) => boolean;
    reconcileLoadout?: (s: unknown, opts: Record<string, unknown>) => Promise<unknown>;
    withdrawFireOwned?: (s: unknown, id: number, amount: number) => Promise<unknown>;
    installOrbFloorBridge?: (client: unknown, approach: { x: number; z: number }) => () => void;
    monitorWildernessLevel?: (p: { worldX: number; worldZ: number; level: number } | undefined) => number | undefined;
    enterAirAltar?: (s: unknown) => Promise<void>;
    craftAirRunes?: (s: unknown, stop?: () => boolean) => Promise<{ ok: boolean; consumed: number; runes: number; xp: number; ticks: number }>;
    exitAirAltar?: (s: unknown, stop?: () => boolean) => Promise<unknown>;
    insideAirAltar?: (p: { worldX: number; worldZ: number; level: number } | null | undefined) => boolean;
    openQuest?: (opts: { session?: Session; name?: string; cap: number; eatAt: number; lumbridgeOk: boolean }) => Promise<any>;
    walkTargetPersist?: (s: any, to: { x: number; z: number; level: number }) => Promise<{ ok: boolean; reason?: string; detail?: string }>;
}

export interface ArtisanConfig {
    skill: ArtisanSkill;
    method: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string | undefined>>;
    stop?: () => boolean;
    deps?: ArtisanExternalDeps;
}

export interface NormalizedArtisanConfig {
    skill: ArtisanSkill;
    method: string;
    args: string[];
    env: Record<string, string | undefined>;
    stop?: () => boolean;
    deps?: ArtisanExternalDeps;
}

export interface ArtisanSessionOutcome {
    ok: boolean;
    summary: string;
    ticks: number;
    produced: number;
    failure?: string;
    metrics?: Record<string, number | string | boolean>;
}

export type SessionLike = SessionCore & {
    client?: unknown;
    name?: string;
    tick: () => number;
    onTick?: (cb: () => void) => () => void;
    ended?: Promise<unknown>;
    direct?: (action: Record<string, unknown>) => Promise<unknown>;
    bankObservation?: () => { generation?: number; items: { id: number; name?: string; count: number }[]; at?: number } | null | undefined;
    sdk: Record<string, any>;
    bot: Record<string, any>;
};

export function parseArtisanTokens(tokens: readonly string[]): { args: string[]; env: Record<string, string> } {
    const args: string[] = [];
    const env: Record<string, string> = {};
    for (const token of tokens) {
        const setting = token.match(/^([A-Z][A-Z0-9_]*)=([\s\S]*)$/);
        if (setting) env[setting[1]!] = setting[2]!;
        else args.push(token);
    }
    return { args, env };
}

export function normalizeArtisanConfig(cfg: ArtisanConfig): NormalizedArtisanConfig {
    const skill = String(cfg.skill ?? '').trim().toLowerCase() as ArtisanSkill;
    const method = String(cfg.method ?? '').trim().toLowerCase();
    const parsed = parseArtisanTokens(cfg.args ?? []);
    const env: Record<string, string | undefined> = { ...parsed.env, ...(cfg.env ?? {}) };
    return {
        skill,
        method,
        args: parsed.args,
        env,
        stop: cfg.stop,
        deps: cfg.deps,
    };
}

export function resolveArtisanSetting(cfg: NormalizedArtisanConfig, key: string, fallback?: string): string | undefined {
    const val = cfg.env[key];
    if (val !== undefined && val !== '') return val;
    return fallback;
}
