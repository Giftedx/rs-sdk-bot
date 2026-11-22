import { resolve } from 'node:path';

export {
    SPELLS,
    type FightOptions,
    type Kit,
    type SpecConfig,
    type Style,
    type VolleyState,
} from '../../../core/src/pk-types';

/** Repository root resolved from `packages/workers/src/pvp/`. */
export const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..');

export const PVP_MODES_LIST = [
    'fight',
    'spar',
    'gang',
    'army',
    'squad',
    'team',
    'hunt',
    'roam',
    'pilot',
    'standby',
    'stage-kit',
    'escort-ore',
    'microbot-pvp',
    'special-swap',
    'monitor',
] as const;

export type PvpMode = (typeof PVP_MODES_LIST)[number];
export type PvpOperation = PvpMode;

export interface PvpModeSpec {
    mode: PvpMode;
    script: string;
    defaultArgs?: readonly string[];
    defaultEnv?: Readonly<Record<string, string>>;
    description: string;
}

export interface PvpRequiredItem {
    id: number;
    itemName?: string;
    count: number;
}

export interface PvpConfig {
    mode: PvpMode;
    target?: string;
    capTicks?: number;
    maxMinutes?: number;
    maxWilderness?: number;
    foodFloor?: number;
    requireEscape?: boolean;
    requireBankTrusted?: boolean;
    minHitpointsLevel?: number;
    minCoins?: number;
    requiredItems?: readonly PvpRequiredItem[];
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
    timeoutMs?: number;
    execute?: boolean;
    stop?: () => boolean;
}
