import type { TickSource } from './ticks';

export type Outcome =
    | { ok: true; ticks: number }
    | { ok: false; reason: 'precondition' | 'rejected' | 'timeout' | 'aborted'; detail: string; ticks: number };

export type Effect = (before: any, now: any) => boolean;

export interface CheckedSpec {
    name: string;
    pre?: (st: any) => string | null;
    send: () => Promise<unknown>;
    effect: Effect;
    timeoutTicks: number;
    signal?: AbortSignal;
}

const rejectedCount = (st: any): number => st?.opFeedback?.opRejectedCount ?? 0;

// Sends once, then watches each tick for the effect. A rise in opFeedback.opRejectedCount with no effect
// means the server refused the op silently (UNSET_MAP_FLAG, no message), so it ends early as `rejected`.
export async function checked(s: TickSource, spec: CheckedSpec): Promise<Outcome> {
    const before = s.sdk.getState();
    const why = spec.pre?.(before) ?? null;
    if (why) return { ok: false, reason: 'precondition', detail: why, ticks: 0 };
    if (spec.signal?.aborted) return { ok: false, reason: 'aborted', detail: String(spec.signal.reason ?? 'aborted'), ticks: 0 };

    const base = rejectedCount(before);
    const result = new Promise<Outcome>(resolve => {
        let ticks = 0;
        let done = false;
        const finish = (o: Outcome) => { if (!done) { done = true; off(); spec.signal?.removeEventListener('abort', onAbort); resolve(o); } };
        const onAbort = () => finish({ ok: false, reason: 'aborted', detail: String(spec.signal?.reason ?? 'aborted'), ticks });
        spec.signal?.addEventListener('abort', onAbort);
        const off = s.onTick(() => {
            ticks++;
            const now = s.sdk.getState();
            if (spec.effect(before, now)) return finish({ ok: true, ticks });
            if (rejectedCount(now) > base) return finish({ ok: false, reason: 'rejected', detail: `${spec.name}: server refused the op`, ticks });
            if (ticks >= spec.timeoutTicks) return finish({ ok: false, reason: 'timeout', detail: `${spec.name}: no effect in ${ticks} ticks`, ticks });
        });
    });
    await spec.send();
    return result;
}

const skillXp = (st: any, skill: string): number =>
    (st?.skills ?? []).find((k: any) => k.name.toLowerCase() === skill.toLowerCase())?.experience ?? 0;
const countMatching = (st: any, re: RegExp): number =>
    (st?.inventory ?? []).filter((i: any) => re.test(i.name)).reduce((n: number, i: any) => n + i.count, 0);

export const xpGained = (skill: string): Effect => (b, n) => skillXp(n, skill) > skillXp(b, skill);
export const invGained = (re: RegExp): Effect => (b, n) => countMatching(n, re) > countMatching(b, re);
export const levelIs = (level: number): Effect => (_b, n) => n?.player?.level === level;
export const atTile = (x: number, z: number, level: number, tol: number): Effect => (_b, n) => {
    const p = n?.player;
    return !!p && p.level === level && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
};
