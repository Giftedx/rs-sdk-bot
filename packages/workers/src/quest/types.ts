import { resolve } from 'node:path';
import type { Tile } from '../../../core/src/world';
import type { QuestFlag } from '../../../core/src/quest-status';

export const REPO_ROOT = resolve(import.meta.dir, '../../../..');

export type QuestSaveItem = { id: number; count: number; slot?: number };

export interface QuestSavePreset {
    position?: { x: number; z: number; level?: number };
    skills?: Record<string, number>;
    varps?: Record<number, number>;
    inventory?: QuestSaveItem[];
    equipment?: Array<{ id: number; count: number; slot: number }>;
    bank?: Array<{ id: number; count: number }>;
    coins?: number;
}

export type SaveConfig = QuestSavePreset;

export type Pt = readonly [x: number, z: number, tol?: number];
export type SweepApiOptions = { cap: number; prepareTicks: number; xpRate: number; maximumCasts?: number };

export type QuestOperation =
    | 'sweep'
    | 'order'
    | 'chain'
    | 'items'
    | 'cook-job'
    | 'generated'
    | 'seaslug-leave'
    | 'dusty-key'
    | 'clue'
    | 'clue-puzzle'
    | 'clue-guardian'
    | 'hero-owned'
    | 'legends-owned'
    | 'tbwt-owned'
    | 'watchtower-owned';

export interface QuestConfig {
    readonly operation: QuestOperation;
    readonly quest?: string;
    readonly quests?: readonly string[];
    readonly clueId?: number;
    readonly puzzleId?: number;
    readonly npcIndex?: number;
    readonly spell?: string;
    readonly maxCasts?: number;
    readonly ambientDamage?: number;
    readonly cap?: number;
    readonly savePath?: string;
    readonly timeoutMs?: number;
    readonly orderPath?: string;
    readonly fresh?: string;
    readonly apiOptions?: SweepApiOptions;
    readonly args?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly exitOnComplete?: boolean;
    readonly stop?: () => boolean;
}

export interface QuestModeSpec {
    readonly mode: string;
    readonly script: string;
    readonly defaultArgs?: readonly string[];
    readonly defaultEnv?: Readonly<Record<string, string>>;
    readonly description: string;
}

export interface QuestStep {
    readonly script: string;
    readonly args: string[];
    readonly env: Record<string, string>;
}

export interface QuestReadinessAssessment {
    readonly quest: string;
    readonly slug: string;
    readonly name: string | null;
    readonly alreadyComplete: boolean;
    readonly ready: boolean;
    readonly skillsMet: boolean;
    readonly questsMet: boolean;
    readonly pairRequired: boolean;
    readonly missingItems: Record<number, number>;
    readonly blockers: string[];
    readonly step: QuestStep | null;
}

export interface PrioritizedQuestsResult {
    readonly readyNow: QuestReadinessAssessment[];
    readonly needsItems: QuestReadinessAssessment[];
    readonly blocked: QuestReadinessAssessment[];
    readonly complete: QuestReadinessAssessment[];
}

export interface QuestOrderSpecMeta {
    readonly key: string;
    readonly questName: string;
    readonly varpId: number;
    readonly qpVarpId: number;
    readonly complete: number;
    readonly questPoints: number;
    readonly script: string;
    readonly items: readonly { id: number; name: string }[];
    readonly start: Tile;
    readonly bank: { x: number; z: number; level: number };
    readonly corridor: readonly { x: number; z: number; tol: number }[];
    readonly startRadius: number;
    readonly questCap: number;
    readonly bankCap: number;
}

export type QuestStateSnapshot = QuestFlag['state'];
