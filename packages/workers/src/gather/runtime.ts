// Shared runtime helpers inside packages/workers/src/gather/ using only core/vendor layers.
import { existsSync } from 'node:fs';
import { accountOf, getWorld } from '../../../core/src/bot';
import type { Session } from '../../../core/src/inprocess';
import type { Outcome } from '../../../core/src/act';
import { goTo, sessionWalker, walkPath } from '../../../core/src/walk';
import type { PathResult } from '../../../core/src/walk/path';
import type { Tile } from '../../../core/src/world';
import type { GatherExternalDeps } from './types';

export function awayFrom(
    p: { worldX: number; worldZ: number; level?: number } | null | undefined,
    to: Tile,
    tiles: number,
): boolean {
    return !!p && ((p.level ?? 0) !== to.level || Math.max(Math.abs(p.worldX - to.x), Math.abs(p.worldZ - to.z)) > tiles);
}

export function productionStopRequested(
    actor: string | undefined,
    stop: () => boolean = () => false,
    exists: (path: string) => boolean = existsSync,
    role: string | undefined = process.env.STOP_FILE,
): boolean {
    return stop() || exists('.practice/stop-all') || (!!actor && exists(`.practice/stop-${actor}`)) || (!!role && exists(role));
}

export function watchProductionLife(
    s: Session,
    stop: () => boolean = () => false,
    options: { allowDamage?: boolean } = {},
) {
    const allowDamage = options.allowDamage === true;
    const initial = s.sdk.getState()?.player;
    const initialHp = s.sdk.getSkill('Hitpoints')?.level ?? 0;
    if (!initial || initialHp <= 0 || (allowDamage && !Number.isFinite(initialHp))) {
        throw Error('production life unobserved');
    }
    const initialRespawns = initial.respawnCount ?? 0;
    const initialLife = initial.lifeId;
    let ended = false;
    let why = '';
    void s.ended?.then(() => { ended = true; });
    const reason = () => {
        const p = s.sdk.getState()?.player;
        const hp = s.sdk.getSkill('Hitpoints')?.level ?? 0;
        if (why) return why;
        if (ended) why = 'session ended';
        else if (productionStopRequested(s.name, stop)) why = 'stop requested';
        else if (!p || hp <= 0 || p.isDead || (allowDamage && !Number.isFinite(hp))) why = 'dead or player unavailable';
        else if ((allowDamage ? (p.respawnCount ?? 0) !== initialRespawns : (p.respawnCount ?? 0) > initialRespawns) || (initialLife !== undefined && p.lifeId !== initialLife)) {
            why = 'life changed';
        } else if (!allowDamage && hp < initialHp) {
            why = 'damage observed';
        }
        return why;
    };
    return { reason, stopped: () => !!reason() };
}

export async function defaultApproach(
    s: Session,
    to: Tile,
    stop: () => boolean = () => false,
    deps?: GatherExternalDeps,
): Promise<Outcome> {
    if (deps?.approach) return deps.approach(s, to, stop);
    const cancel = new AbortController();
    const off = s.onTick(() => { if (stop()) cancel.abort('stop requested'); });
    try {
        const world = await getWorld();
        return await goTo(s, world, to, accountOf(s), { maxRetriesPerLeg: 2, legTimeoutTicks: 150, signal: cancel.signal });
    } finally {
        off();
    }
}

export async function defaultWalkTargetPersist(
    s: Session,
    to: Tile,
    tries = 4,
    deps?: GatherExternalDeps,
    walk?: (to: Tile) => Promise<{ ok: boolean; reason?: string; detail?: string }>,
): Promise<{ ok: boolean; reason?: string; detail?: string }> {
    if (!walk && deps?.walkTargetPersist) return deps.walkTargetPersist(s, to, tries);
    let best = Infinity;
    let last: { ok: boolean; reason?: string; detail?: string } = { ok: false };
    const world = walk ? null : await getWorld();
    for (let n = 1; n <= tries; n++) {
        last = walk
            ? await walk(to)
            : await goTo(s, world!, to, accountOf(s), { legTimeoutTicks: 100 });
        if (last.ok) return last;
        const p = s.sdk.getState()?.player;
        const distance = p && p.level === to.level ? Math.max(Math.abs(p.worldX - to.x), Math.abs(p.worldZ - to.z)) : Infinity;
        console.log(`WALK_RETRY try=${n} reason=${last.reason ?? '-'} detail=${last.detail ?? '-'} distance=${distance}`);
        if (distance >= best) break;
        best = distance;
    }
    return last;
}

export async function walkGroundLeg(
    s: Session,
    to: Tile,
    stop: () => boolean,
    maxTicks = 600,
): Promise<PathResult> {
    return walkPath(await sessionWalker(s), [{ ...to, tol: 1 }], { maxTicks, stop });
}

export const BANK_TILES_FALLBACK: readonly Tile[] = [
    { x: 3185, z: 3436, level: 0 },
    { x: 3253, z: 3420, level: 0 },
    { x: 3092, z: 3243, level: 0 },
    { x: 3013, z: 3355, level: 0 },
    { x: 2946, z: 3368, level: 0 },
    { x: 2809, z: 3441, level: 0 },
    { x: 2727, z: 3493, level: 0 },
    { x: 2655, z: 3283, level: 0 },
    { x: 2619, z: 3332, level: 0 },
    { x: 3269, z: 3167, level: 0 },
];

export function defaultNearestBanks(from: { x: number; z: number; level?: number }, deps?: GatherExternalDeps): Tile[] {
    if (deps?.nearestBanks) return deps.nearestBanks(from);
    return [...BANK_TILES_FALLBACK].sort(
        (a, b) => Math.max(Math.abs(a.x - from.x), Math.abs(a.z - from.z)) - Math.max(Math.abs(b.x - from.x), Math.abs(b.z - from.z)),
    );
}
