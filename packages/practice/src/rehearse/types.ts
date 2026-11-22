import { resolve } from 'node:path';
import type { Binding } from '../../../core/src/launch-evidence';
import type { SaveConfig } from '../presets';
import { SAVE_PORT_ENV } from '../save-endpoint';
import type { SaveSummary } from '../save-library';

export const REHEARSE_ROOT = resolve(import.meta.dir, '..', '..', '..', '..');

// Every port the engine and its login/friend/logger workers open, moved off the shared practice slot.
export const ISOLATED = {engine: 8910, gateway: 7791, save: 8912} as const;
export const ISOLATED_ENGINE_ENV: Record<string, string> = {
    WEB_MANAGEMENT_PORT: '8911', NODE_PORT: '18910', LOGIN_PORT: '18911', FRIEND_PORT: '18912', LOGGER_PORT: '18913',
    BUILD_LIVE_RELOAD: 'false', BUILD_STARTUP: 'false',
    [SAVE_PORT_ENV]: String(ISOLATED.save),
};

export type Where = 'inventory' | 'bank' | 'worn' | 'any';

export interface SupplierSpec {
    save: SaveConfig;
    script: string;
    args?: string[];
    env?: Record<string, string>;
}

export interface Segment {
    id: string;
    route?: {file: string; step: string};
    start: {snapshot: string} | {preset: string} | {save: SaveConfig} | {fresh: true};
    script: string;
    args?: string[];
    env?: Record<string, string>;
    supplier?: SupplierSpec;
    suppliers?: SupplierSpec[];
    // Absent for a seed run that only captures a state.
    plan?: {ticks: number; source: string};
    expect: {
        skills?: Record<string, number>; // minimum saved level
        items?: Record<string, {min?: number; max?: number; in?: Where}>; // keyed by obj id
        position?: {x: number; z: number; level: number; radius: number};
    };
    // Stores a library save: when `when` (an expectation on the endpoint save, read each poll) holds, after `afterTicks`, else the end save.
    capture?: {name: string; segment: string; afterTicks?: number; when?: Segment['expect']};
    timeoutMs?: number;
}

export const SUPPLIER_ONLINE_TIMEOUT_MS = 45_000;

export interface RehearsalReport {
    ok: boolean;
    segment: string;
    route?: Segment['route'];
    account: string;
    start: Segment['start'];
    plan: Segment['plan'];
    ticks: {used: number | null; enter: number | null; leave: number | null; overPlan: number | null; afterCapture?: number | null};
    child: {code: number; timedOut: boolean};
    checks: Record<string, boolean>;
    end: SaveSummary | null;
    captured?: {name: string; via: string; tick: number | null};
    scope: string;
    specialist?: {receipt: Binding; candidate: Binding};
}

export type ScoredRun = {account: string; board: string; source: string; mission: string; ledger: string; engineLog: string};

export interface HelperProcHandle {
    readonly pid: number;
    readonly exitCode: number | null;
    readonly exited: Promise<unknown>;
}
