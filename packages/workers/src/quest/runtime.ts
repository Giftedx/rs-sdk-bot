import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BankObservation, Session } from '../../../core/src/inprocess';
import { selectQuestFood } from '../../../core/src/sustain';
import type { TickSource } from '../../../core/src/ticks';
import { waitUntil } from '../../../core/src/ticks';
import type { Account, Tile } from '../../../core/src/world';
import { REPO_ROOT } from './types';

export type OwnedKitLike = {
    bank: { x: number; z: number; level: number };
    pack: { id: number; count: number }[];
    wear: { id: number; count: number; slot: number }[];
    cap: number;
    maximumMoves: number;
};

export interface NpcSpellLike {
    name: string;
    component: string;
    level: number;
    runes: Record<number, number>;
    debuff: boolean;
    members: boolean;
    requiredWorn?: number;
}

export interface NativeTeleportLike {
    name: string;
    component: string;
    level: number;
    members: boolean;
    runes: Record<number, number>;
    to: { x: number; z: number; level: number };
}

export type PracticeSaveLike = {
    position: { x: number; z: number; level: number };
    skills: Array<{ name: string; index?: number; level: number; xp?: number }>;
    vars: Record<number, number>;
    inventories: Record<number, Array<{ id: number; count: number; slot?: number }>>;
};

export interface GateDepsLike {
    left: (label: string) => void;
    live: () => void;
    health: () => Promise<void>;
}

export interface ShiloTransitLike {
    protect(on: boolean, stop: () => boolean): Promise<void>;
    walkNative(goal: { x: number; z: number }, stop: () => boolean): Promise<void>;
    returnVillage(stop: () => boolean): Promise<void>;
    outbound(stop: () => boolean): Promise<void>;
    pending(): boolean;
}

export interface QuestRuntimeDeps {
    validateOwnedKit?: (value: unknown) => OwnedKitLike;
    runOwnedLoadout?: (s: Session, value: unknown, stop?: () => boolean) => Promise<{ ok: boolean; reason?: string; [k: string]: unknown }>;
    createShiloTransit?: (s: Session, j: { protectMelee?: boolean }, alive: () => boolean) => ShiloTransitLike;
    crossStrongholdGate?: (s: Session, d: GateDepsLike) => Promise<unknown>;
    selectGiantBow?: (stock: readonly { id: number; count: number }[], ranged: number) => { id: number; level: number } | undefined;
    selectGiantArrows?: (stock: readonly { id: number; count: number }[], ranged: number, bowLevel: number) => number | undefined;
    acquireExclusiveLease?: (file: string, runId: string) => () => void;
    readPracticeSave?: (path: string) => PracticeSaveLike;
    waitPracticeSave?: (path: string, match: (s: PracticeSaveLike) => boolean, opts?: { timeoutMs?: number }) => Promise<{ matched: boolean; save: PracticeSaveLike }>;
    leaveRuneStarter?: (s: Session, stop?: () => boolean) => Promise<unknown>;
    exitRuneTower?: (io: { waitForLanding: () => Promise<boolean>; openDoor: (label: string, x: number, z: number) => Promise<void>; dash: (label: string, x: number, z: number, tol: number) => Promise<void> }, label?: string) => Promise<void>;
    nativeNpcSpell?: (name: string) => NpcSpellLike;
    runNpcMagic?: (s: Session, spell: NpcSpellLike, opts: Record<string, unknown>) => Promise<{ ok: boolean; failure?: string; [k: string]: unknown }>;
    nativeTeleport?: (name: string) => NativeTeleportLike;
    elementalRuneCost?: (runeId: number, quantity: number, worn: readonly { id: number; slot: number }[], members?: boolean) => number;
    completeCook?: (q: unknown) => Promise<{ ok: true; detail: string; [k: string]: unknown }>;
    completeHetty?: (s: Session, cap: number, stop?: () => boolean) => Promise<{ ok?: boolean; [k: string]: unknown }>;
    openQuest?: (opts?: Record<string, unknown>) => Promise<any>;
    walkTargetPersist?: (s: Session, to: Tile, tries?: number, walk?: (to: Tile) => Promise<{ ok: boolean; reason?: string; detail?: string }>) => Promise<{ ok: boolean; reason?: string; detail?: string }>;
    sweep?: (account: string, quest: string, fresh?: string, options?: any, deps?: any) => Promise<unknown>;
}

const runtime: QuestRuntimeDeps = {};

export function registerQuestRuntime(deps: Partial<QuestRuntimeDeps>): void {
    Object.assign(runtime, deps);
}

export function getQuestRuntime(): Readonly<QuestRuntimeDeps> {
    return runtime;
}

const moduleCache = new Map<string, Promise<any>>();

export async function importRepoModule<T = any>(...relParts: string[]): Promise<T> {
    const abs = resolve(REPO_ROOT, ...relParts);
    const key = abs.replace(/\\/g, '/');
    let p = moduleCache.get(key);
    if (!p) {
        p = import(pathToFileURL(abs).href);
        moduleCache.set(key, p);
    }
    return p as Promise<T>;
}

export function scriptRelPath(...parts: string[]): string {
    return join(REPO_ROOT, ...parts);
}

export const NATURE_REF = {
    bank: { x: 2852, z: 2955, level: 0 },
    site: { x: 2865, z: 3022, level: 0 },
    ruins: { id: 2460, x: 2868, z: 3018, angle: 0 },
    altar: { id: 2486, x: 2399, z: 4840, angle: 1 },
    portal: { id: 2473, x: 2400, z: 4834, angle: 0 },
    essence: 1436,
    talisman: 1462,
    rune: 561,
} as const;

export const STRONGHOLD_GATE_REF = {
    id: 190,
    x: 2459,
    z: 3383,
    south: { x: 2461, z: 3382 } as Tile,
    north: { x: 2461, z: 3385 } as Tile,
    femi: /^ok then\.?$/i,
    attempts: 4,
    waitTicks: 30,
    quietTicks: 8,
    femiSettle: { box: { x: 2461, z: 3380 }, ticks: 11 },
} as const;

export function combatTeleportAllowed(p: { worldX: number; worldZ: number; level: number }): boolean {
    if (p.worldX < 2944 || p.worldX > 3391) return true;
    const bottom =
        p.worldZ >= 9920 && p.worldZ <= 12799 && p.level === 0
            ? 9920
            : p.worldZ >= 3520 && p.worldZ <= 6399 && p.level <= 3
              ? 3520
              : undefined;
    return bottom === undefined || Math.floor((p.worldZ - bottom) / 8) + 1 <= 20;
}

export async function eatBetweenCasts(
    s: TickSource & { direct(action: { type: string; [k: string]: unknown }): Promise<unknown> },
    o: { food: readonly number[]; eatAt: number; timeoutTicks: number; attempts: number },
) {
    const count = (id: number) =>
        (s.sdk.getState()?.inventory ?? [])
            .filter((i: { id: number }) => i.id === id)
            .reduce((n: number, i: { count: number }) => n + i.count, 0);
    const hp = () => s.sdk.getState()?.skills?.find((k: { name: string }) => k.name === 'Hitpoints')?.level ?? 0;
    const modal = (st: any) => !!st?.dialog?.isOpen || !!st?.modalOpen;
    if (!selectQuestFood(s.sdk.getState(), { food: o.food, eatAt: o.eatAt })) return null;
    let last: { id: number; before: number } | undefined;
    for (let attempt = 1; attempt <= o.attempts; attempt++) {
        if (modal(s.sdk.getState())) {
            await s.direct({ type: 'closeModal', reason: 'SDK' });
            if (!(await waitUntil(s, st => !modal(st), { timeoutTicks: o.timeoutTicks }))) continue;
        }
        const choice = selectQuestFood(s.sdk.getState(), { food: o.food, eatAt: o.eatAt });
        if (!choice) return null;
        const id = choice.item.id;
        const before = count(id);
        const hpBefore = hp();
        last = { id, before };
        const reply = (await s.direct({
            type: 'useInventoryItem',
            slot: choice.item.slot,
            optionIndex: choice.opIndex,
            reason: 'SDK',
        })) as { success?: boolean; message?: string } | undefined;
        if (reply && reply.success === false) throw Error(`eat refused: ${reply.message ?? 'unknown'}`);
        if (await waitUntil(s, () => count(id) !== before, { timeoutTicks: o.timeoutTicks })) {
            if (count(id) !== before - 1) throw Error(`food debit invalid: item${id} ${before}->${count(id)}`);
            return { id, before, after: count(id), hpBefore, hpAfter: hp(), attempts: attempt };
        }
    }
    throw Error(
        `food debit unobserved before the next cast: ${o.attempts} eats, item${last?.id ?? '?'} ${last?.before ?? '?'}->${last ? count(last.id) : '?'}`,
    );
}

export async function resolveOwnedLoadoutDeps() {
    if (runtime.validateOwnedKit && runtime.runOwnedLoadout) {
        return { validateOwnedKit: runtime.validateOwnedKit, runOwnedLoadout: runtime.runOwnedLoadout };
    }
    const mod = await import('../logistics/stage');
    return {
        validateOwnedKit: mod.validateOwnedKit as NonNullable<QuestRuntimeDeps['validateOwnedKit']>,
        runOwnedLoadout: mod.runOwnedLoadout as NonNullable<QuestRuntimeDeps['runOwnedLoadout']>,
    };
}

export async function resolveShiloTransit(s: Session, j: { protectMelee?: boolean }, alive: () => boolean): Promise<ShiloTransitLike> {
    if (runtime.createShiloTransit) return runtime.createShiloTransit(s, j, alive);
    const mod = await import('../runecraft/shilo');
    return mod.createShiloTransit(s, j, alive);
}

export async function resolveCrossStrongholdGate(s: Session, d: GateDepsLike): Promise<unknown> {
    if (runtime.crossStrongholdGate) return runtime.crossStrongholdGate(s, d);
    const mod = await import('../agility/entry');
    return mod.crossStrongholdGate(s, d);
}

export async function resolveGiantCombatHelpers() {
    if (runtime.selectGiantBow && runtime.selectGiantArrows) {
        return { selectGiantBow: runtime.selectGiantBow, selectGiantArrows: runtime.selectGiantArrows };
    }
    const mod = await import('../combat/gear');
    return {
        selectGiantBow: mod.selectGiantBow,
        selectGiantArrows: mod.selectGiantArrows,
    };
}

export async function resolveAcquireExclusiveLease(): Promise<NonNullable<QuestRuntimeDeps['acquireExclusiveLease']>> {
    if (runtime.acquireExclusiveLease) return runtime.acquireExclusiveLease;
    const mod = await import('../../../core/src/exclusive-lease');
    return mod.acquireExclusiveLease;
}

export async function resolvePracticeSaveIo(): Promise<{
    readPracticeSave: NonNullable<QuestRuntimeDeps['readPracticeSave']>;
    waitPracticeSave: NonNullable<QuestRuntimeDeps['waitPracticeSave']>;
}> {
    if (runtime.readPracticeSave && runtime.waitPracticeSave) {
        return { readPracticeSave: runtime.readPracticeSave, waitPracticeSave: runtime.waitPracticeSave };
    }
    const mod = await importRepoModule('packages', 'practice', 'src', 'fleet-player-save.ts');
    return {
        readPracticeSave: mod.readPracticeSave,
        waitPracticeSave: mod.waitPracticeSave,
    };
}

export async function resolveExitRuneTower(
    io: { waitForLanding: () => Promise<boolean>; openDoor: (label: string, x: number, z: number) => Promise<void>; dash: (label: string, x: number, z: number, tol: number) => Promise<void> },
    label = 'tower exit',
): Promise<void> {
    if (runtime.exitRuneTower) return runtime.exitRuneTower(io, label);
    if (!(await io.waitForLanding())) throw Error('Rune Mysteries prerequisite: tower landing objects unobserved');
    await io.openDoor(`${label} inner door`, 3107, 3162);
    await io.dash(`${label} hall`, 3108, 3164, 1);
    await io.openDoor(`${label} north door`, 3109, 3166);
    await io.dash(`${label} outside`, 3109, 3167, 0);
}

export async function resolveNpcMagicModule(): Promise<{
    nativeNpcSpell: NonNullable<QuestRuntimeDeps['nativeNpcSpell']>;
    runNpcMagic: NonNullable<QuestRuntimeDeps['runNpcMagic']>;
}> {
    if (runtime.nativeNpcSpell && runtime.runNpcMagic) {
        return { nativeNpcSpell: runtime.nativeNpcSpell, runNpcMagic: runtime.runNpcMagic };
    }
    const mod = await import('../combat/magic');
    return {
        nativeNpcSpell: mod.nativeNpcSpell,
        runNpcMagic: (s, spell, opts) => mod.runNpcMagic(s, spell, opts as unknown as Parameters<typeof mod.runNpcMagic>[2]),
    };
}

export async function resolveTeleportModule(): Promise<{
    nativeTeleport: NonNullable<QuestRuntimeDeps['nativeTeleport']>;
}> {
    if (runtime.nativeTeleport) return { nativeTeleport: runtime.nativeTeleport };
    const mod = await importRepoModule('scripts', 'microbot-magic-teleport.ts');
    return { nativeTeleport: mod.nativeTeleport };
}

export async function resolveElementalRuneCost(): Promise<NonNullable<QuestRuntimeDeps['elementalRuneCost']>> {
    if (runtime.elementalRuneCost) return runtime.elementalRuneCost;
    const mod = await importRepoModule('scripts', 'microbot-magic-items.ts');
    return mod.elementalRuneCost;
}

export async function resolveLeaveRuneStarter(): Promise<NonNullable<QuestRuntimeDeps['leaveRuneStarter']>> {
    if (runtime.leaveRuneStarter) return runtime.leaveRuneStarter;
    const mod = await importRepoModule('scripts', 'rune-starter.ts');
    return mod.leaveRuneStarter;
}

export async function resolveOpenQuest(): Promise<NonNullable<QuestRuntimeDeps['openQuest']>> {
    if (runtime.openQuest) return runtime.openQuest;
    const mod = await importRepoModule('scripts', 'generated', 'quest-lib.ts');
    return mod.openQuest;
}

export async function resolveWalkTargetPersist(): Promise<NonNullable<QuestRuntimeDeps['walkTargetPersist']>> {
    if (runtime.walkTargetPersist) return runtime.walkTargetPersist;
    const mod = await import('../logistics/walk');
    return mod.walkTargetPersist;
}

export async function resolveCompleteCook(): Promise<NonNullable<QuestRuntimeDeps['completeCook']>> {
    if (runtime.completeCook) return runtime.completeCook;
    const mod = await importRepoModule('scripts', 'generated', 'quest-cook.ts');
    return mod.completeCook;
}

export async function resolveCompleteHetty(): Promise<NonNullable<QuestRuntimeDeps['completeHetty']>> {
    if (runtime.completeHetty) return runtime.completeHetty;
    const mod = await importRepoModule('scripts', 'generated', 'quest-hetty.ts');
    return mod.completeHetty;
}

export type BankObserverCallback = (bank: BankObservation) => void;
export type AccountSkillsShape = Pick<Account, 'skills'>;
