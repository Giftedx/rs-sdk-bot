// Pure bot session configuration, work normalization, death detection, and stop-reason rules.
import { resolve } from 'node:path';
import type { connectInProcess, Session } from '../inprocess';
import { isLocalServer } from '../localserver';

// Ticks without xp, an item change, dialog or a walk of FAR_WALK tiles (ledger.ts) before a session counts as stalled
// and stops (STALL_TICKS=0: never).
export const STALL_TICKS = Number(process.env.STALL_TICKS ?? 900);
export const repoRoot = resolve(import.meta.dir, '..', '..', '..', '..');

export type LifeFields = { isDead?: boolean; respawnCount?: number; lifeId?: number } | undefined;

export interface BotRecord {
    script: string;
    argv: string[];
    workArgs?: string[];
    env?: Record<string, string | undefined>;
}

export interface OpenBotOptions {
    log?: (line: string) => void;
    onStop?: (s: Session, detail: string) => Promise<unknown>;
    // The caller handles a death itself (scripts/pk-hunt.ts re-kits): a death prints one DEATH line and starts a new baseline
    // instead of ending the session, and the stop file, the lease and the stall checks stay live.
    continueAfterDeath?: boolean;
    onSessionEnd?: (s: Session, detail: string) => Promise<unknown>;
    record?: BotRecord;
    trade?: Parameters<typeof connectInProcess>[0]['trade'];
}

export type FinishDetail = string | ((ok: boolean) => string);
export type SettlementOptions = {
    log?: (line: string) => void;
    onReported?: (okNow: () => boolean) => void;
    logout?: (rawSession: Session) => Promise<string>;
};

// Opens an in-process session for a bot created by packages/practice (reads its bot.env),
// waits until it is in game, and prints `START x z level` for the proving harness.
// The bot's server from its bot.env SERVER line; empty or missing means our local practice server.
export function serverFromEnv(env: string): string {
    const v = env.match(/^SERVER=(.*)$/m)?.[1]?.trim();
    return v ? v : 'localhost:8888';
}

// rs-sdk's bot.env template defaults to the public demo server, so a practice bot whose --local rewrite failed
// would silently log in there. Anything but our local server needs DEMO_OK=1, set on purpose by the caller.
export function assertServerAllowed(server: string, env: Record<string, string | undefined> = process.env): void {
    if (isLocalServer(server)) return;
    if (env.DEMO_OK === '1') return;
    throw new Error(`refusing to connect to ${server}: not the local practice server; set DEMO_OK=1 to allow it on purpose`);
}

// `RELEASE <first 12 hex of the worker release>`, or `RELEASE unpinned` for a run that the swarm did not start.
export const releaseLine = (release: string | undefined) =>
    `RELEASE ${/^[0-9a-f]{12,}$/i.test(release ?? '') ? release!.slice(0, 12).toLowerCase() : 'unpinned'}`;

export function sessionDied(initial: any, now: any): boolean {
    return !!now && (now.isDead === true || (now.respawnCount ?? 0) > (initial?.respawnCount ?? 0)
        || (initial?.lifeId !== undefined && now.lifeId !== undefined && now.lifeId !== initial.lifeId));
}

// One tick of the death check of openBot. With `keep` (opts.continueAfterDeath) the caller handles its own death: the first tick of a
// death asks for one DEATH line, the new life becomes the baseline once the account is alive in it, and `died` is false, so
// every other stop reason stays live. Without it a death is a stop (the default).
export function deathStep(born: LifeFields, now: LifeFields, keep: boolean, seen: boolean): { died: boolean; born: LifeFields; seen: boolean; announce: boolean } {
    const dead = sessionDied(born, now);
    if (!dead || !keep) return { died: dead, born, seen: false, announce: false };
    const alive = !!now && now.isDead !== true;
    return { died: false, born: alive ? now : born, seen: !alive, announce: !seen };
}

// The reason that a tick ends the session, or null: a death, a stop file, a lost fleet lease or no progress. The checks of
// the stop file and the lease run every 25 ticks and the stall check every 50.
export function stopReasonOf(o: { died: boolean; stopTicks: number; stopFile: () => boolean; leaseLost: () => boolean; stalled: () => boolean; stallTicks: number }): string | null {
    return o.died ? 'died' : o.stopTicks % 25 === 0 && o.stopFile() ? 'stop file'
        : o.stopTicks % 25 === 0 && o.leaseLost() ? 'fleet controller lease unavailable'
        : o.stopTicks % 50 === 0 && o.stalled() ? `no progress: ${o.stallTicks} ticks without xp, items, dialog or a journey` : null;
}

export function watchUnexpectedEnd(
    s: Pick<Session, 'ended'>,
    isSettling: () => boolean,
    stopRequested: () => boolean,
    onEnd: (detail: string) => Promise<unknown>,
): void {
    void s.ended.then(end => {
        if (!isSettling() && !stopRequested()) void onEnd(`session ended: ${end.reason}`).catch(e => console.error('Session end cleanup failed', e));
    });
}

// Recorded argv is the complete CLI. A composed entry can supply its step arguments separately.
export function botWork(name: string, record?: BotRecord, argv: readonly string[] = process.argv, env: Record<string, string | undefined> = process.env) {
    const args = record?.argv ?? argv.slice(2);
    return {
        script: record?.script ?? argv[1] ?? '',
        args: [...(record?.workArgs ?? (args[0]?.toLowerCase() === name.toLowerCase() ? args.slice(1) : args))],
        env: record?.env ?? { ...env },
    };
}

export const countItems = (s: Session, re: RegExp): number =>
    (s.sdk.getState()?.inventory ?? []).filter((i: { name: string }) => re.test(i.name)).reduce((n: number, i: { count: number }) => n + i.count, 0);
