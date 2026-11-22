import type { Step } from '../../../core/src/chain-step';
import type { BankObservation, SessionCore } from '../contracts';

export type CombatTile = {
    x: number;
    z: number;
    level: number;
};

export type CombatSession = SessionCore;

export type CombatLevels = {
    Attack: number;
    Strength: number;
    Defence: number;
    Hitpoints: number;
    Ranged?: number;
    Magic?: number;
    Prayer?: number;
};

export type CombatTrainSkill = 'Attack' | 'Strength' | 'Defence' | 'Hitpoints' | 'Ranged' | 'Magic';

export const ORDINARY_COMBAT_MODES = [
    'chicken',
    'cow',
    'druid',
    'unicorn',
    'wizard',
    'giant',
    'trooper',
    'taverley_druid',
    'taverley_black_knight',
    'taverley_scales',
    'taverley_blue_dragon',
    'taverley_black_dragon',
    'taverley_giant',
    'chaos_wine',
    'fire-giant',
    'fire-combat',
    'imp',
    'shade',
    'chompy',
    'chompy-at-site',
    'ranged',
    'ranged-starter',
    'ranged-gather',
    'ranged-camp',
    'cannon',
    'loot-trip',
    'kbd',
    'black-dragon',
    'blue-dragon',
    'green-dragon',
    'trawler',
    'trawler-at-site',
    'magic-order',
    'magic-npc',
    'magic-splash',
    'magic-splash-coop',
    'prayer-flick',
] as const;

export type CombatMode = (typeof ORDINARY_COMBAT_MODES)[number];

export const COMBAT_MODE_SET: ReadonlySet<string> = new Set(ORDINARY_COMBAT_MODES);

export interface CombatConfig {
    readonly mode: CombatMode;
    readonly account?: string;
    readonly args?: readonly string[];
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly targetSkill?: CombatTrainSkill;
    readonly targetLevel?: number;
    readonly capTicks?: number;
    readonly maxKills?: number;
    readonly spot?: string;
    readonly bank?: string;
    readonly members?: boolean;
    readonly maxRiskPerHour?: number;
}

export interface FighterProfileSpec {
    target: string;
    script: string;
    defaultArgs?: readonly string[];
    defaultEnv?: Readonly<Record<string, string>>;
    description: string;
}

export interface BossEncounterSpec {
    boss: string;
    script: string;
    defaultArgs?: readonly string[];
    defaultEnv?: Readonly<Record<string, string>>;
    description: string;
}

export type CombatSiteMeta = {
    readonly mode: CombatMode;
    readonly family: 'combat';
    readonly kind: 'train' | 'gather';
    readonly activityId: string;
    readonly anchor: CombatTile;
    readonly membersOnly: boolean;
    readonly minCombatStats?: Readonly<Partial<Record<string, number>>>;
    readonly requiredQuests?: readonly string[];
    readonly minFood?: number;
    readonly minFreeSlots?: number;
    readonly riskPerHour?: number;
    readonly defaultCapTicks: number;
    readonly stepTemplate?: Step;
};

export type CombatProgressionHook = (
    account: string,
    target: number,
    options?: Record<string, unknown>,
) => Promise<{
    step?: Step;
    decision?: unknown;
    blocked?: boolean;
    reason?: string;
}>;

export type RangedExternalHooks = {
    buyAtShop?: (session: CombatSession, item: { name: string; count: number }) => Promise<number>;
    buyGeItem?: (session: CombatSession, itemId: number, maxPrice?: number) => Promise<boolean>;
    leaveStarter?: (session: CombatSession) => Promise<void>;
    selectProgression?: CombatProgressionHook;
};

export type CombatBankSnapshot = BankObservation;
