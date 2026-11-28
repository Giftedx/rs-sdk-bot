import { resolve } from 'node:path';
import type { FightOptions as CoreFightOptions } from '../../../core/src/pk-types';

export {
    SPELLS,
    type Kit,
    type SpecConfig,
    type Style,
    type VolleyState,
} from '../../../core/src/pk-types';

export type FightOptions = CoreFightOptions & {
    /** Hard retaliatory-only skull guard: never send an attack on a player who has not provably attacked this account first. */
    neverSkull?: boolean;
    /** External provocation lookup (from squad/gang/team/army NeverSkullGuard) for targets who attacked this account before fightLoop started. */
    provokedBy?: ReadonlySet<string> | ((targetName: string, targetIndex: number) => boolean);
    /** Telemetry callback invoked if ownSkull ever turns true while neverSkull is active. */
    onUnexpectedSkull?: (info: { tick: number; target: string; at: { x: number; z: number }; lostValue: number }) => void;
    /** When true (skulled target's prayer exhausted / Protect Item OFF), bypass spec.below and specReserve and force freeze lock + spec dump. */
    smiteBurst?: () => boolean;
    /** When true (skulled target still has overhead ON with prayer remaining), conserve DPS special energy until smiteBurst fires. */
    holdSpecForDrain?: () => boolean;
    /** Stop immediately when target's health bar hits 0 (isDying) so multi-target callers switch without dead ticks. */
    stopOnDying?: boolean;
};

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
