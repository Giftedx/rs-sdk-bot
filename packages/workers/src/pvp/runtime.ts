import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Session } from '../../../core/src/inprocess';
import { runDirectChild } from '../../../core/src/run-child';
import { REPO_ROOT } from './types';

export interface AltarLike {
    id: number;
    x: number;
    z: number;
    level: number;
    label: string;
}

export interface ActionSessionOwnerLike {
    readonly raw: Session;
    readonly session: Session;
    own: () => boolean;
    identity: () => boolean;
    sameLife: () => boolean;
    settled: () => void;
}

export interface PvpRuntimeDeps {
    runDirectChild?: (
        args: readonly string[],
        env?: Record<string, string | undefined>,
    ) => Promise<string>;
    nearestAltar?: (at: { x: number; z: number; level: number }) => AltarLike;
    prayAtAltar?: (s: Session, altar: AltarLike) => Promise<{ ok: boolean; detail: string }>;
    enableSpecial?: (
        s: Session,
        bar: string,
        energy: number,
        cap: number,
        stopped: () => boolean,
    ) => Promise<{ ok: boolean; detail: string }>;
    actionSessionOwner?: (
        raw: Session,
        stop: () => boolean,
        fileExists?: (path: string) => boolean,
        opts?: { allowDamage?: boolean },
    ) => ActionSessionOwnerLike;
    finishActionSession?: (
        owner: ActionSessionOwnerLike,
        ok: boolean,
        detail: string,
        settler?: any,
        logout?: any,
    ) => Promise<boolean>;
    tapFeed?: (url: string, file: string, rect: { x: number; z: number; w: number; h: number }, first?: unknown) => () => void;
    contentNames?: () => { obj: (id: number) => string; seq: (id: number) => string };
    feedMeetings?: (text: string, obj: (id: number) => string, seq?: (id: number) => string, all?: boolean) => unknown[];
    runPkFightCli?: (args: readonly string[], env: Record<string, string | undefined>) => Promise<number>;
    runPkSquadCli?: (args: readonly string[], env: Record<string, string | undefined>) => Promise<number>;
}

const moduleCache = new Map<string, Promise<Record<string, unknown>>>();

/** Imports a repository script lazily across package boundaries without static edges. */
export async function importRepoModule<T = Record<string, unknown>>(relPath: string): Promise<T> {
    let loaded = moduleCache.get(relPath);
    if (!loaded) {
        loaded = import(pathToFileURL(resolve(REPO_ROOT, relPath)).href);
        moduleCache.set(relPath, loaded);
    }
    return (await loaded) as T;
}

/** Hookable runtime bridges used across `packages/workers/src/pvp/`. */
export const pvpRuntime: PvpRuntimeDeps = {};

export async function runDirectChildBridge(
    args: readonly string[],
    env?: Record<string, string | undefined>,
): Promise<string> {
    if (pvpRuntime.runDirectChild) return pvpRuntime.runDirectChild(args, env);
    return runDirectChild([...args], env);
}

export async function loadAltarOps(): Promise<{
    nearestAltar: NonNullable<PvpRuntimeDeps['nearestAltar']>;
    prayAtAltar: NonNullable<PvpRuntimeDeps['prayAtAltar']>;
}> {
    if (pvpRuntime.nearestAltar && pvpRuntime.prayAtAltar) {
        return { nearestAltar: pvpRuntime.nearestAltar, prayAtAltar: pvpRuntime.prayAtAltar };
    }
    const mod = await import('../logistics/recover');
    return {
        nearestAltar: pvpRuntime.nearestAltar ?? mod.nearestAltar,
        prayAtAltar: pvpRuntime.prayAtAltar ?? mod.prayAtAltar,
    };
}

export async function loadEnableSpecial(): Promise<NonNullable<PvpRuntimeDeps['enableSpecial']>> {
    if (pvpRuntime.enableSpecial) return pvpRuntime.enableSpecial;
    const mod = await import('../bank-artisan');
    return mod.enableSpecial as NonNullable<PvpRuntimeDeps['enableSpecial']>;
}

export async function loadActionSessionHelpers(): Promise<{
    actionSessionOwner: NonNullable<PvpRuntimeDeps['actionSessionOwner']>;
    finishActionSession: NonNullable<PvpRuntimeDeps['finishActionSession']>;
}> {
    if (pvpRuntime.actionSessionOwner && pvpRuntime.finishActionSession) {
        return {
            actionSessionOwner: pvpRuntime.actionSessionOwner,
            finishActionSession: pvpRuntime.finishActionSession,
        };
    }
    const mod = await importRepoModule<{
        actionSessionOwner: NonNullable<PvpRuntimeDeps['actionSessionOwner']>;
        finishActionSession: NonNullable<PvpRuntimeDeps['finishActionSession']>;
    }>('scripts/microbot-a-actions.ts');
    return {
        actionSessionOwner: pvpRuntime.actionSessionOwner ?? mod.actionSessionOwner,
        finishActionSession: pvpRuntime.finishActionSession ?? mod.finishActionSession,
    };
}

export async function loadGangCollectTap(): Promise<NonNullable<PvpRuntimeDeps['tapFeed']>> {
    if (pvpRuntime.tapFeed) return pvpRuntime.tapFeed;
    const mod = await importRepoModule<{ tapFeed: NonNullable<PvpRuntimeDeps['tapFeed']> }>('scripts/measure/pk-gang-collect.ts');
    return mod.tapFeed;
}

export async function loadGangFidelityOps(): Promise<{
    contentNames: NonNullable<PvpRuntimeDeps['contentNames']>;
    feedMeetings: NonNullable<PvpRuntimeDeps['feedMeetings']>;
}> {
    if (pvpRuntime.contentNames && pvpRuntime.feedMeetings) {
        return { contentNames: pvpRuntime.contentNames, feedMeetings: pvpRuntime.feedMeetings };
    }
    const mod = await importRepoModule<{
        contentNames: NonNullable<PvpRuntimeDeps['contentNames']>;
        feedMeetings: NonNullable<PvpRuntimeDeps['feedMeetings']>;
    }>('scripts/measure/pk-gang-fidelity.ts');
    return {
        contentNames: pvpRuntime.contentNames ?? mod.contentNames,
        feedMeetings: pvpRuntime.feedMeetings ?? mod.feedMeetings,
    };
}
