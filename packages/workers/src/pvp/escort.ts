// The escort: the squad (scripts/pk-squad.ts with ESCORT_HOLD=1) holds the post by the dagger gang and writes the escort
// state file ESCORT_STATE each few ticks. A route that enters the Wilderness waits at its entry until the file is fresh
// and says that the gang is suppressed (escortGate). With no ESCORT_STATE the gate returns at once, so a route with no
// escort does not change.
// The file holds what the squad sees: the players in the view of each member, the kill lines of its fight loops and
// the world feed (on the bench, the gang sessions in place of the feed, as FOLLOW=1 does).
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { writeAtomicFile } from '../../../core/src/atomic-file';
import { wildernessLevel } from '../../../core/src/prayer-guard';
import { waitTicks, type TickSource } from '../../../core/src/ticks';

export type GangStatus = 'dead' | 'present' | 'away';
export type EscortSighting = { tick: number; x: number; z: number; by: 'view' | 'radar' };
export interface EscortGang { name: string; status: GangStatus; diedTick: number | null; seen: EscortSighting | null }
export interface EscortState {
    v: 1;
    // Wall time (ms) and squad tick of the write.
    at: number;
    tick: number;
    post: { x: number; z: number };
    // `alive`: the members with a session that are alive in the Wilderness and still hold.
    squad: { size: number; alive: number };
    // The world feed was fresh at the write: an `away` gang account is then known to be out of the Wilderness or offline.
    radar: boolean;
    kills: number;
    gang: EscortGang[];
    // False after the hold ends (deadline, release signal, stop file): the gate then stays closed.
    holding: boolean;
    suppressed: boolean;
    why: string;
}

// A sighting of a gang account in the ticks after its kill line is the dying player, not a new life.
export const ESCORT_DEATH_GRACE = 10;
// A dead gang account counts as dead for this many ticks with no new sighting. The one live sample of a return to the
// post after a death is 1,130 to 1,430 ticks (research/gang-clones.md).
export const ESCORT_DEAD_TICKS = 1100;
// The smallest squad that killed the clones with no death of ours (scripts/pk-gang-record/squad-candidate.json: four
// kill 87 of 90, three lost an account).
export const ESCORT_MIN_SQUAD = 4;
export const ESCORT_EVERY_TICKS = 5;
export const ESCORT_MAX_AGE_MS = 30_000;
// The longest wait of the gate. It stays under the 900-tick stall limit of a session (packages/core/src/bot/rules.ts).
export const ESCORT_WAIT_TICKS = 750;

/** The published hold. It ends at the hold deadline (MAX_MINUTES), not when the retreat after it ends: members still count as alive until they leave the Wilderness, so a later end would open the gate while the escort leaves. */
export const escortHolding = (stopped: boolean, tick: number, deadline: number): boolean => !stopped && tick < deadline;

/** The status of one gang account at `tick`: present when the view or a fresh world feed shows it in the Wilderness, dead after a kill line of ours, else away. */
export function gangStatus(o: {
    tick: number; diedTick: number | null; view: EscortSighting | null; radar: { fresh: boolean; at: { x: number; z: number } | null };
    graceTicks?: number; deadTicks?: number;
}): GangStatus {
    const grace = o.graceTicks ?? ESCORT_DEATH_GRACE;
    const alive = (t: number) => o.diedTick === null || t > o.diedTick + grace;
    const inView = !!o.view && o.view.tick >= o.tick - 1 && wildernessLevel(o.view.x, o.view.z) > 0 && alive(o.view.tick);
    const onFeed = o.radar.fresh && !!o.radar.at && wildernessLevel(o.radar.at.x, o.radar.at.z) > 0 && alive(o.tick);
    if (inView || onFeed) return 'present';
    if (o.diedTick !== null && o.tick - o.diedTick <= (o.deadTicks ?? ESCORT_DEAD_TICKS)) return 'dead';
    return 'away';
}

/** The squad's rule: enough members hold, no gang account is in the Wilderness, and an away account is known to be away (fresh world feed). */
export function escortSuppression(o: { squad: { size: number; alive: number }; gang: readonly { name: string; status: GangStatus }[]; radar: boolean; minSquad?: number }): { ok: boolean; why: string } {
    const need = Math.max(1, Math.min(o.squad.size, o.minSquad ?? ESCORT_MIN_SQUAD));
    if (o.squad.alive < need) return { ok: false, why: `squad ${o.squad.alive} of ${o.squad.size} hold, ${need} needed` };
    const present = o.gang.filter(g => g.status === 'present').map(g => g.name);
    if (present.length) return { ok: false, why: `${present.join(',')} present` };
    const unknown = o.radar ? [] : o.gang.filter(g => g.status === 'away').map(g => g.name);
    if (unknown.length) return { ok: false, why: `${unknown.join(',')} away with no world feed` };
    return { ok: true, why: o.gang.map(g => `${g.name} ${g.status}`).join(', ') || 'no gang' };
}

/** The gate's check of one read of the state file: fresh, the squad holds, and the squad says the gang is suppressed. */
export function escortGateCheck(state: unknown, now: number, maxAgeMs = ESCORT_MAX_AGE_MS): { ok: boolean; why: string } {
    if (!state || typeof state !== 'object') return { ok: false, why: 'no escort state' };
    const s = state as Partial<EscortState>;
    if (s.v !== 1 || typeof s.at !== 'number' || !Number.isFinite(s.at)) return { ok: false, why: 'escort state not readable' };
    if (now - s.at > maxAgeMs) return { ok: false, why: `escort state ${Math.round((now - s.at) / 1000)} s old` };
    if (s.holding !== true) return { ok: false, why: 'squad does not hold' };
    if (s.suppressed !== true) return { ok: false, why: s.why || 'gang not suppressed' };
    return { ok: true, why: s.why || 'gang suppressed' };
}

export function readEscortState(path: string): unknown {
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}
export function writeEscortState(path: string, state: EscortState): void {
    writeAtomicFile(path, `${JSON.stringify(state)}\n`, { ensureDir: true });
}
// The release signal: a file beside the state file (ESCORT_RELEASE names another). The hold ends when it exists.
export const escortReleasePath = (statePath: string, env: Record<string, string | undefined> = process.env) => env.ESCORT_RELEASE || `${statePath}.release`;
export const escortReleased = (releasePath: string) => existsSync(releasePath);
export function releaseEscort(releasePath: string): void { writeAtomicFile(releasePath, `${Date.now()}\n`, { ensureDir: true }); }
export function clearEscortRelease(releasePath: string): void { rmSync(releasePath, { force: true }); }

// The squad's side: the deaths and sightings of each gang account, and the state of one write.
export function createEscortTracker(names: readonly string[], o: { minSquad?: number; graceTicks?: number; deadTicks?: number } = {}) {
    const keys = names.map(n => n.toLowerCase());
    const died = new Map<string, number>(), seen = new Map<string, EscortSighting>();
    return {
        kill(name: string, tick: number) { const k = name.toLowerCase(); if (keys.includes(k)) died.set(k, tick); },
        sight(name: string, x: number, z: number, tick: number, by: EscortSighting['by']) {
            const k = name.toLowerCase();
            if (keys.includes(k)) seen.set(k, { tick, x, z, by });
        },
        state(w: { at: number; tick: number; post: { x: number; z: number }; squad: { size: number; alive: number }; kills: number; holding: boolean;
            radar: { fresh: boolean; at: (name: string) => { x: number; z: number } | null } }): EscortState {
            const gang: EscortGang[] = keys.map(k => {
                const view = seen.get(k) ?? null, diedTick = died.get(k) ?? null;
                const at = w.radar.fresh ? w.radar.at(k) : null;
                const status = gangStatus({ tick: w.tick, diedTick, view: view?.by === 'view' ? view : null, radar: { fresh: w.radar.fresh, at }, graceTicks: o.graceTicks, deadTicks: o.deadTicks });
                return { name: k, status, diedTick, seen: at ? { tick: w.tick, x: at.x, z: at.z, by: 'radar' } : view };
            });
            const rule = escortSuppression({ squad: w.squad, gang, radar: w.radar.fresh, minSquad: o.minSquad });
            const suppressed = w.holding && rule.ok;
            return { v: 1, at: w.at, tick: w.tick, post: w.post, squad: w.squad, radar: w.radar.fresh, kills: w.kills, gang, holding: w.holding,
                suppressed, why: w.holding ? rule.why : 'hold ended' };
        },
    };
}

/**
 * The route's gate before a Wilderness entry. With ESCORT_STATE unset it returns at once. Else it waits a tick at a
 * time until escortGateCheck passes, and throws after ESCORT_WAIT_TICKS so that the route does not enter alone.
 */
export async function escortGate(s: TickSource & { name?: string }, stop: () => boolean, o: {
    env?: Record<string, string | undefined>; now?: () => number; read?: (path: string) => unknown; wait?: () => Promise<unknown>; log?: (line: string) => void;
} = {}): Promise<{ gated: boolean; ticks: number; why: string }> {
    const env = o.env ?? process.env, path = env.ESCORT_STATE;
    if (!path) return { gated: false, ticks: 0, why: 'no escort' };
    const maxAge = Number(env.ESCORT_MAX_AGE_MS ?? ESCORT_MAX_AGE_MS), limit = Number(env.ESCORT_WAIT_TICKS ?? ESCORT_WAIT_TICKS);
    const log = o.log ?? (line => console.log(`[${s.name ?? '?'}] ${line}`));
    const start = s.tick();
    let said = '', saidAt = -1;
    for (;;) {
        const check = escortGateCheck((o.read ?? readEscortState)(path), (o.now ?? Date.now)(), maxAge);
        const waited = s.tick() - start;
        if (check.ok) { log(`ESCORT clear after ${waited} ticks: ${check.why}`); return { gated: true, ticks: waited, why: check.why }; }
        if (stop()) return { gated: true, ticks: waited, why: `stopped: ${check.why}` };
        if (waited >= limit) throw Error(`escort not clear after ${waited} ticks: ${check.why}`);
        if (check.why !== said || waited - saidAt >= 50) { log(`ESCORT wait at ${waited} ticks: ${check.why}`); said = check.why; saidAt = waited; }
        await (o.wait ?? (() => waitTicks(s, 1)))();
    }
}
