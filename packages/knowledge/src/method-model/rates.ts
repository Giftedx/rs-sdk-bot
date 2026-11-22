import type { Band, Roll, Timing } from './types';

// Engine facts (repo-relative paths).
export const XP_RATE = 25;
export const XP_RATE_SRC = 'vendor/rs-sdk/server/engine/src/util/WorldConfig.ts:102';
export const ACTIONS_PER_TICK = 5; // USER_EVENT decode limit per tick
export const ACTIONS_PER_TICK_SRC = 'vendor/rs-sdk/server/engine/src/network/game/client/ClientGameProtCategory.ts:6';
export const STAT_RANDOM_SRC = 'vendor/rs-sdk/server/engine/src/engine/script/handlers/PlayerOps.ts:591';
// p_delay(n) sets delayedUntil = tick + 1 + n; a suspended script resumes on that tick, and a new client action is
// refused on that tick because packets are decoded before the flag clears.
export const P_DELAY_SRC = 'vendor/rs-sdk/server/engine/src/engine/script/handlers/PlayerOps.ts:378';
// A weak queue entry with delay d added while the weak queue runs fires d + 1 ticks later (delay-- before the test).
export const WEAKQUEUE_SRC = 'vendor/rs-sdk/server/engine/src/engine/entity/Player.ts:975';

/** Chance that `stat_random(stat, low, high)` passes at a level (engine formula, `value > floor(random * 256)`). */
export function statRandomChance(level: number, low: number, high: number): number {
    const l = Math.min(Math.max(level, 1), 99);
    const value = Math.floor((low * (99 - l)) / 98) + Math.floor((high * (l - 1)) / 98) + 1;
    return Math.min(Math.max(value, 0), 256) / 256;
}

/**
 * Ticks a run of `p_delay` calls costs: each resumes after `n + 1` ticks; a run that ends the action and waits
 * for a new client action adds one more tick for the refused decode.
 */
export function pDelayTicks(delays: number[], reclick: boolean): number {
    return delays.reduce((a, n) => a + n + 1, 0) + (reclick ? 1 : 0);
}

/** Expected ticks per successful action at a level with the best roll usable at that level (`toolLevel <= level`). */
export function ticksPerSuccess(t: Timing, level: number): number | null {
    if (!t.rolls.length) return t.ticksPerTry;
    let best: number | null = null;
    for (const r of t.rolls) {
        if (r.toolLevel > level) continue;
        const p = r.fixedChance ?? statRandomChance(level, r.low!, r.high!);
        if (p <= 0) continue;
        const ticks = (r.rollTicks + (1 - p) * r.failTicks) / p;
        if (best === null || ticks < best) best = ticks;
    }
    return best;
}

/** Derived XP per tick at 25x for a level; null when XP or timing is unknown. */
export function modelXpPerTickAt(xpPerAction: number | null, t: Timing | null, level: number): number | null {
    if (xpPerAction === null || !t) return null;
    const ticks = ticksPerSuccess(t, level);
    return ticks === null || ticks <= 0 ? null : Math.round((xpPerAction * XP_RATE / ticks) * 100) / 100;
}

/** The best roll usable at a level (lowest expected ticks per success), or null without rolls. */
export function bestRoll(t: Timing, level: number): Roll | null {
    let best: Roll | null = null, bestTicks = Infinity;
    for (const r of t.rolls) {
        if (r.toolLevel > level) continue;
        const p = r.fixedChance ?? statRandomChance(level, r.low!, r.high!);
        const ticks = p > 0 ? (r.rollTicks + (1 - p) * r.failTicks) / p : Infinity;
        if (ticks < bestTicks || (ticks === bestTicks && best !== null && r.toolLevel > best.toolLevel)) { best = r; bestTicks = ticks; }
    }
    return best;
}

/**
 * Model XP per tick over levels `from..99`, split at each 10-level boundary and where the best tool changes.
 * A rung with no success roll has one flat band.
 */
export function modelBands(xpPerAction: number | null, t: Timing | null, from: number): Band[] {
    if (xpPerAction === null || !t) return [];
    const start = Math.max(1, Math.min(99, from));
    if (!t.rolls.length) { const v = modelXpPerTickAt(xpPerAction, t, start); return [{ from: start, to: 99, tool: null, xpPerTickFrom: v, xpPerTickTo: v }]; }
    const bands: Band[] = [];
    let cur: Band | null = null;
    for (let l = start; l <= 99; l++) {
        const tool = bestRoll(t, l)?.tool ?? null;
        if (!cur || tool !== cur.tool || l % 10 === 0) {
            cur = { from: l, to: l, tool, xpPerTickFrom: modelXpPerTickAt(xpPerAction, t, l), xpPerTickTo: null };
            bands.push(cur);
        }
        cur.to = l;
        cur.xpPerTickTo = modelXpPerTickAt(xpPerAction, t, l);
    }
    return bands;
}

/** Content coord `level_mx_mz_lx_lz` as a world tile. */
export function coordTile(s: string): { x: number; z: number; level: number } | null {
    const p = s.split('_').map(Number);
    return p.length === 5 && p.every(n => Number.isFinite(n)) ? { level: p[0]!, x: p[1]! * 64 + p[3]!, z: p[2]! * 64 + p[4]! } : null;
}
