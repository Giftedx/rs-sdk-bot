import type { BankProfile, BankRouteJob } from '../../../core/src/bank-trip';
import type { LootDefinition, LootPolicy } from '../../../core/src/loot-policy';
import type { Outcome } from '../../../core/src/act';
import type { Session } from '../../../core/src/inprocess';
import type { Tile } from '../../../core/src/world';

export type GatherSkill = 'fishing' | 'woodcutting' | 'mining' | 'thieving' | 'foraging';

export type GatherHandling = 'bank' | 'drop' | 'cook' | 'soften' | 'handoff';

export interface GatherToolSpec {
    axeId?: number;
    pickaxeId?: number;
    fishingToolId?: number;
    baitId?: number;
    baitCount?: number;
    gloves?: boolean;
}

export interface GatherTargetSpec {
    count?: number;
    level?: number;
    trips?: number;
    capTicks?: number;
}

export interface GatherExternalDeps {
    approach?: (s: Session, to: Tile, stop?: () => boolean) => Promise<Outcome>;
    awayFrom?: (p: { worldX: number; worldZ: number; level?: number } | null | undefined, to: Tile, tiles: number) => boolean;
    walkTargetPersist?: (
        s: Session,
        to: Tile,
        tries?: number,
        walk?: (to: Tile) => Promise<{ ok: boolean; reason?: string; detail?: string }>,
    ) => Promise<{ ok: boolean; reason?: string; detail?: string }>;
    leaveTutorial?: (
        s: Session,
        skip?: () => Promise<{ success: boolean; message?: string }>,
        ready?: () => Promise<unknown>,
        stop?: () => boolean,
    ) => Promise<Outcome | null>;
    leaveRuneStarter?: (s: Session, stop: () => boolean) => Promise<void>;
    walkFar?: (s: Session, world: unknown, to: Tile, legTimeoutTicks?: number, opts?: { signal?: AbortSignal }) => Promise<Outcome>;
    nearestBanks?: (from: { x: number; z: number; level?: number }) => Tile[];
    sendHandoff?: (
        s: Session,
        toName: string,
        server: string,
        items: { id: number; count: number }[],
        trade: () => Promise<unknown>,
        root?: string,
    ) => Promise<number>;
    receiveHandoff?: <T>(s: Session, from: string, server: string, serve: () => Promise<T>, root?: string) => Promise<T>;
    pendingCourierFunding?: (funder: string, courier: string, server: string) => boolean;
    serviceCourierFunding?: (s: Session, courier: string, server: string) => Promise<{ state?: string } | null>;
    cookSharks?: (s: Session, stop: () => boolean) => Promise<{ raw: number; cooked: number; burnt: number }>;
    cookingRecipes?: () => { recipes: any[]; blocked: { name: string; reason: string }[] };
    nativeHeatSources?: () => ReadonlyMap<number, 'range' | 'fire'>;
    runCookingBatch?: (
        d: {
            state: () => import('../../../../vendor/rs-sdk/sdk/types').BotWorldState | null;
            tick: () => number;
            stop: () => boolean;
            heat: (slot: number, source: 'range' | 'fire', r: any) => Promise<boolean>;
            wait: (test: () => boolean, ticks: number) => Promise<boolean>;
            step: () => Promise<void>;
            close: () => Promise<void>;
        },
        r: any,
        o: { maximum: number; cap: number; heat: 'range' | 'fire'; expectedProduct?: number },
    ) => Promise<{ processed: number; cooked: number; burnt: number; products: Record<number, number>; xp: number; ticks: number }>;
    runSoftenClay?: (s: Session, opts: { cap: number; maximum: number; reserve: number }) => Promise<any>;
    runShafts?: (
        s: Session,
        opts: { cap: number; maximum: number; reserve?: number; bankKnife?: boolean; stop?: () => boolean; pause?: () => boolean },
    ) => Promise<any>;
    runHeadless?: (
        s: Session,
        opts: { cap: number; maximum: number; shaftReserve?: number; featherReserve?: number; stop?: () => boolean; pause?: () => boolean },
    ) => Promise<any>;
    runBankProfile?: (s: Session, route: BankRouteJob, profile: BankProfile, stop?: () => boolean) => Promise<any>;
    runBankJob?: (s: Session, job: BankRouteJob, stop?: () => boolean) => Promise<any>;
    attackable?: (a: { z: number; combatLevel: number }, b: { z: number; combatLevel: number }) => boolean;
    defaultSpec?: (kit: any, names?: any) => any;
    fightPlayer?: (s: Session, targetName: string, opts?: Record<string, unknown>) => Promise<unknown>;
    escapeStep?: (level: number, has: { glory: boolean; teleport: boolean }) => 'glory' | 'teleport' | 'run' | 'out';
    hasVarrockTeleport?: (magic: number, inventory: readonly { name: string; count?: number }[], equipment: readonly { name: string }[]) => boolean;
    kitFrom?: (worn: readonly any[], carried: readonly any[], ranged?: RegExp) => any;
}

export interface GatherConfig {
    skill: GatherSkill;
    method: string;
    spot?: string;
    region?: string;
    tool?: GatherToolSpec;
    handling?: GatherHandling;
    progressive?: boolean;
    target?: GatherTargetSpec;
    escort?: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string | undefined>>;
    deps?: GatherExternalDeps;
}

export interface NormalizedGatherConfig extends GatherConfig {
    skill: GatherSkill;
    method: string;
    args: readonly string[];
    env: Readonly<Record<string, string | undefined>>;
}

export type GatherMethodCatalogEntry = {
    skill: GatherSkill;
    method: string;
    minLevel: number;
    levelSkill?: string;
    members?: boolean;
    requiredQuest?: string;
    minCombat?: number;
    tools?: readonly number[];
    altTools?: readonly number[];
    bait?: number;
    outputItems: readonly number[];
    baseXpPerAction: number;
    estimatedTicksPerAction: number;
    estimatedItemsPerAction?: number;
    estimatedCoinsPerAction?: number;
};

export type MiningAction =
    | { type: 'interactLoc'; x: number; z: number; locId: number; optionIndex: number }
    | { type: 'useItemOnItem'; sourceSlot: number; targetSlot: number }
    | { type: 'clickComponent'; componentId: number }
    | { type: 'dropItem'; slot: number }
    | { type: 'walkTo'; x: number; z: number }
    | { type: 'closeModal' };

export interface MiningDriver {
    state(): import('../../../../vendor/rs-sdk/sdk/types').BotWorldState | null;
    tick(): number;
    stop(): boolean;
    mine(l: import('../../../../vendor/rs-sdk/sdk/types').NearbyLoc): Promise<boolean>;
    wait(test: () => boolean, ticks: number): Promise<boolean>;
    step(): Promise<void>;
    clearModal?(): Promise<void>;
    send?(actions: readonly MiningAction[]): Promise<void>;
}

export interface MiningProfile {
    name: string;
    rocks: number[];
    products: number[];
    level: number;
    respawn: number;
    gemRock: boolean;
    perfect: boolean;
    essence: boolean;
    excludedRocks: string[];
}

export type GatherLootOutcome = {
    units: number;
    pickups: number;
    acquired: Record<number, number>;
    staticValue: number;
    valueSource: string;
    ticks: number;
    banked: number;
    attribution: string;
    policy?: LootPolicy;
    definition?: (id: number) => LootDefinition | undefined;
};

export type GatherSessionOutcome = {
    ok: boolean;
    kind: 'completed' | 'failed' | 'refused' | 'died' | 'aborted';
    detail: string;
    delta?: {
        items?: Record<number, number>;
        xp?: Record<string, number>;
        coins?: number;
        elapsedTicks?: number;
    };
    recoverable?: boolean;
    summary?: object;
    resultLine?: string;
    formatFinish?: (finalOk: boolean) => string;
};

export type GatherOutcome = GatherSessionOutcome;

export const VALID_GATHER_SKILLS: readonly GatherSkill[] = [
    'fishing',
    'woodcutting',
    'mining',
    'thieving',
    'foraging',
];

export const GATHER_METHOD_MAP: Readonly<Record<GatherSkill, readonly string[]>> = {
    fishing: ['shark', 'cage', 'harpoon', 'fishcook', 'village', 'staged'],
    woodcutting: ['yews', 'edgeville', 'woodcut-supply', 'loop'],
    mining: ['ore', 'essence', 'at-site', 'drop', 'progressive', 'loot', 'lava-maze'],
    thieving: ['knights', 'knights-stable', 'pickpocket', 'pickpocket-at-site', 'stalls', 'blood-chest', 'nature-chest'],
    foraging: ['flax', 'wool', 'feathers', 'spawn', 'grapes', 'crystal-chest'],
};

export function normalizeGatherConfig(cfg: GatherConfig): NormalizedGatherConfig {
    return {
        ...cfg,
        skill: cfg.skill.toLowerCase() as GatherSkill,
        method: cfg.method.toLowerCase(),
        args: cfg.args ?? [],
        env: cfg.env ?? {},
    };
}

export function resolveSetting(cfg: Pick<NormalizedGatherConfig, 'args' | 'env'>, key: string): string | undefined {
    const direct = cfg.env[key];
    if (direct !== undefined && direct !== '') return direct;
    const prefix = `${key}=`;
    return cfg.args.find(a => a.startsWith(prefix))?.slice(prefix.length);
}
