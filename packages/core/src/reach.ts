// Client-side reachability over the loaded 104x104 scene: a breadth-first search on the client's own collision
// flags, so a closed door is a wall and an open one is not. The walker uses it to click only tiles the client can
// route to, and to tell "near the goal" from "near the goal but behind a closed door".
//
// canStepLocal, canReachAdjacentTile and canReachLocal are adapted from rs2b0t
// src/bot/event/webwalk/geometry/localReach.ts (commit ae56ccc9, MIT License, Copyright (c) 2026 N64Jive).
// research/walking.md "Long-route walker: source decision" records the source decision.
import type { Tile } from './world';

export type FlagsAt = (lx: number, lz: number) => number | null;
export type LocalPoint = { lx: number; lz: number };

// CollisionFlag values (vendor/rs-sdk/server/webclient/src/dash3d/CollisionFlag.ts).
const F = {
    W_NW: 0x1, W_N: 0x2, W_NE: 0x4, W_E: 0x8, W_SE: 0x10, W_S: 0x20, W_SW: 0x40, W_W: 0x80,
    PL_WALK_N: 0x280102, PL_WALK_E: 0x280108, PL_WALK_S: 0x280120, PL_WALK_W: 0x280180,
    PL_WALK_NE: 0x28010e, PL_WALK_NW: 0x280183, PL_WALK_SE: 0x280138, PL_WALK_SW: 0x2801e0,
} as const;

const open = (flags: FlagsAt, lx: number, lz: number, mask: number) => { const f = flags(lx, lz); return f !== null && (f & mask) === 0; };

export function canStepLocal(flags: FlagsAt, lx: number, lz: number, dx: number, dz: number): boolean {
    const nx = lx + dx, nz = lz + dz;
    if (dx === 0 && dz === 0) return false;
    if (dx === 0 || dz === 0) {
        if (dx === -1) return open(flags, nx, nz, F.PL_WALK_E);
        if (dx === 1) return open(flags, nx, nz, F.PL_WALK_W);
        if (dz === -1) return open(flags, nx, nz, F.PL_WALK_N);
        return open(flags, nx, nz, F.PL_WALK_S);
    }
    if (dx === -1 && dz === -1) return open(flags, nx, nz, F.PL_WALK_NE) && canStepLocal(flags, lx, lz, -1, 0) && canStepLocal(flags, lx, lz, 0, -1);
    if (dx === 1 && dz === -1) return open(flags, nx, nz, F.PL_WALK_NW) && canStepLocal(flags, lx, lz, 1, 0) && canStepLocal(flags, lx, lz, 0, -1);
    if (dx === -1 && dz === 1) return open(flags, nx, nz, F.PL_WALK_SE) && canStepLocal(flags, lx, lz, -1, 0) && canStepLocal(flags, lx, lz, 0, 1);
    return open(flags, nx, nz, F.PL_WALK_SW) && canStepLocal(flags, lx, lz, 1, 0) && canStepLocal(flags, lx, lz, 0, 1);
}

const DIRS: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];

// Standing on a neighbour of an unwalkable target: only a wall on the target's facing side refuses it.
function canReachAdjacentTile(flags: FlagsAt, nx: number, nz: number, dx: number, dz: number): boolean {
    const f = flags(nx, nz);
    if (f === null) return false;
    const wall = dx === -1 && dz === 0 ? F.W_E : dx === 1 && dz === 0 ? F.W_W : dx === 0 && dz === -1 ? F.W_N : dx === 0 && dz === 1 ? F.W_S
        : dx === -1 && dz === -1 ? F.W_NE | F.W_N | F.W_E : dx === 1 && dz === -1 ? F.W_NW | F.W_N | F.W_W
        : dx === -1 && dz === 1 ? F.W_SE | F.W_S | F.W_E : F.W_SW | F.W_S | F.W_W;
    return (f & wall) === 0;
}

export function canReachLocal(flags: FlagsAt, from: LocalPoint, to: LocalPoint, opts: { maxSteps?: number; adjacentOk?: boolean } = {}): boolean {
    const maxSteps = opts.maxSteps ?? 400, adjacentOk = opts.adjacentOk ?? false;
    if (flags(from.lx, from.lz) === null) return false;
    const key = (lx: number, lz: number) => lx * 256 + lz;
    const seen = new Set<number>([key(from.lx, from.lz)]), queue: LocalPoint[] = [from];
    let expansions = 0;
    for (let head = 0; head < queue.length; head++) {
        const cur = queue[head]!;
        if (cur.lx === to.lx && cur.lz === to.lz) return true;
        if (adjacentOk && Math.abs(cur.lx - to.lx) + Math.abs(cur.lz - to.lz) === 1 && canReachAdjacentTile(flags, to.lx, to.lz, to.lx - cur.lx, to.lz - cur.lz)) return true;
        if (++expansions > maxSteps) return false;
        for (const [dx, dz] of DIRS) {
            const k = key(cur.lx + dx, cur.lz + dz);
            if (!seen.has(k) && canStepLocal(flags, cur.lx, cur.lz, dx, dz)) { seen.add(k); queue.push({ lx: cur.lx + dx, lz: cur.lz + dz }); }
        }
    }
    return false;
}

const SIZE = 104;
type SceneClient = { ensureCollision?(): void; collision?: ({ flags: Int32Array } | null)[]; minusedlevel?: number; mapBuildBaseX?: number; mapBuildBaseZ?: number };
// A reach probe on the client's loaded scene, or null when the client exposes no collision map.
// The answer is null when either tile is outside the scene or on another level.
export function clientReach(client: unknown, me: () => Tile | null): ((to: Tile, opts?: { adjacentOk?: boolean; maxSteps?: number }) => boolean | null) | null {
    const c = client as SceneClient | undefined;
    if (!c || !Array.isArray(c.collision) || typeof c.mapBuildBaseX !== 'number' || typeof c.mapBuildBaseZ !== 'number') return null;
    return (to, opts) => {
        const p = me();
        if (!p || p.level !== to.level) return null;
        c.ensureCollision?.();
        const map = c.collision![c.minusedlevel ?? 0];
        if (!map) return null;
        const bx = c.mapBuildBaseX!, bz = c.mapBuildBaseZ!;
        const inScene = (lx: number, lz: number) => lx >= 0 && lz >= 0 && lx < SIZE && lz < SIZE;
        const from = { lx: p.x - bx, lz: p.z - bz }, dest = { lx: to.x - bx, lz: to.z - bz };
        if (!inScene(from.lx, from.lz) || !inScene(dest.lx, dest.lz)) return null;
        return canReachLocal((lx, lz) => inScene(lx, lz) ? map.flags[lx * SIZE + lz]! : null, from, dest, opts);
    };
}
