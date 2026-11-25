// Runtime worker release enforcement, live cohort compatibility checks, and peer lifecycle closure rules.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isLocalServer } from '../localserver';
import { lifecycleRootForRead, liveRoot, statusReadDirs } from '../practice-paths';
import { commandLine } from '../proc';
import { listAttempts, readLogoutProof, resolveLifecycleRoot, type LogoutProof } from '../session-lifecycle';
import { root, type ReleaseMemo } from './paths';
import { cachedReleaseFor, releaseEntries } from './revision';

// The pin must equal the current release of the process's WORKER_ENTRY, or the launch release when it has none.
export function assertWorkerRelease(env: Record<string, string | undefined> = process.env, base = root, memo: ReleaseMemo = new Map()): string {
    const pin = env.WORKER_RELEASE;
    if (!pin || !/^[a-f0-9]{64}$/.test(pin)) throw Error('no worker progress: release pin missing; live starts paused');
    if (cachedReleaseFor(releaseEntries(env.WORKER_ENTRY), base) !== pin) throw Error('no worker progress: release source changed; live starts paused');
    return pin;
}

// A standing peer runs the source its swarm pinned at start and is exempt from release equality, like its own start
// (assertLiveWorkerRelease). It must be an account a standing job in swarm.json names, carry a revision, and have no
// run id. Any other unfinished peer on another release (a manual session, a managed run) is incompatible.
export function standingPeer(row: any, standingAccounts: ReadonlySet<string>): boolean {
    return typeof row?.name === 'string' && standingAccounts.has(row.name.toLowerCase()) && row.coordinatorRunId == null
        && typeof row.workRevision === 'string' && /^[a-f0-9]{64}$/.test(row.workRevision);
}
// current gives a peer's current release; assertLiveWorkerRelease uses the release of the peer's own workEntry.
export function assertCompatibleWorkers(pin: string, server: string, statuses: readonly any[], now = Date.now(), closed: (row: any) => boolean = () => false, standing: (row: any) => boolean = () => false, current: (row: any) => string = () => pin): void {
    const unfinished = statuses.filter(s => s?.server === server && !s.result && !closed(s));
    if (unfinished.some(s => !Number.isFinite(s.at) || s.at <= 0 || s.at > now || now - s.at >= 30_000))
        throw Error('no worker progress: release peer state unknown; verify offline before rollout');
    if (unfinished.some(s => !standing(s) && s.workRevision !== current(s)))
        throw Error('no worker progress: active legacy/different release; wait offline for coordinated rollout');
}
// Every standing job counts, on or off: a job just turned off still owns its open session. Unreadable means none.
export function standingAccounts(base = root): Set<string> {
    try {
        const jobs = JSON.parse(readFileSync(join(base, 'swarm.json'), 'utf8')).jobs;
        return new Set((Array.isArray(jobs) ? jobs : []).filter((j: any) => j?.standing === true)
            .flatMap((j: any) => j.accounts ?? (j.account ? [j.account] : [])).filter((a: unknown) => typeof a === 'string').map((a: string) => a.toLowerCase()));
    } catch { return new Set(); }
}

export function isWorkerReleaseHold(result: string): boolean {
    return /^RESULT fail (?:Error: )?no worker progress: (?:release (?:pin missing|source changed|peer state unknown|build in progress)|active legacy\/different release)/.test(result);
}

// Recheck before the network boundary, including workers launched by an old
// in-memory supervisor. Existing connected sessions are never polled or killed.
// A status file of only null bytes (or none) is what a power cut leaves of a write whose data never reached the disk:
// the rename was kept, the bytes were not. Only a crash makes it, and the crash ended its writer. The writer's session
// can still be open on the server until the lost-session window ends, so the file names no peer only once its last
// write is LOST_SESSION_DROP_MS old; before that it stays unknown evidence.
export const crashResidue = (raw: Uint8Array, writtenAt: number, now = Date.now()) => raw.every(b => b === 0) && Number.isFinite(writtenAt) && now - writtenAt >= LOST_SESSION_DROP_MS;
export function assertLiveWorkerRelease(server: string, env: Record<string, string | undefined> = process.env, base = root): void {
    if (isLocalServer(server)) return;
    // A standing owner job (swarm STANDING=1) runs the current source, so neither a publish lock nor release pin holds it.
    if (env.STANDING === '1') return;
    if (existsSync(join(liveRoot(base), 'build-lock.json'))) throw Error('no worker progress: release build in progress; live starts paused');
    const memo: ReleaseMemo = new Map(), pin = assertWorkerRelease(env, base, memo), statuses: any[] = [];
    const seenEntries = new Set<string>();
    let foundStatusDir = false;
    try {
        for (const statusDir of statusReadDirs(base)) {
            if (!existsSync(statusDir)) continue;
            foundStatusDir = true;
            for (const entry of readdirSync(statusDir)) {
                if (!entry.endsWith('.json') || seenEntries.has(entry.toLowerCase())) continue;
                seenEntries.add(entry.toLowerCase());
                const file = join(statusDir, entry), raw = readFileSync(file);
                if (crashResidue(raw, statSync(file).mtimeMs)) continue;
                statuses.push(JSON.parse(raw.toString('utf8')));
            }
        }
        if (!foundStatusDir) throw Error('missing status directories');
    } catch { throw Error('no worker progress: release peer state unknown; unreadable status evidence'); }
    const owners = standingAccounts(base);
    // A peer whose entries are gone or do not resolve has no current release, so it counts as stale.
    const releases = new Map<string, string>(), current = (row: any) => {
        const key = typeof row?.workEntry === 'string' ? row.workEntry : '';
        if (!releases.has(key)) { let value = ''; try { value = cachedReleaseFor(releaseEntries(key), base); } catch { /* stale */ } releases.set(key, value); }
        return releases.get(key)!;
    };
    assertCompatibleWorkers(pin, server, statuses, Date.now(), row => closedSessionRow(row, server, { root: typeof row?.name === 'string' ? resolveLifecycleRoot(row.name, server, base) : lifecycleRootForRead(server, base) }), row => standingPeer(row, owners), current);
}

// The server drops a session whose client is gone after 200 s.
export const LOST_SESSION_DROP_MS = 200_000;
// A live status row without a result is a closed session only when the account's own producer lifecycle says so:
// its newest attempt (the row's attempt or a later one) confirmed logout, or the row is older than the server's
// lost-session drop and every attempt from the row's own onward has a gone owner (a dead process, or a PID reused by a
// different script) and, for a later attempt, a receipt last written before that drop too. A worker killed mid-session
// leaves its row unfinished and its attempt held; a later login the release gate refused leaves a newer held attempt
// with no live owner either, and neither ever confirms logout, while the server dropped the session 200 s after its
// client went. A held attempt whose owner still runs, or whose receipt is younger than the drop (its session may still
// stand on the server), holds the row. An unreadable command line or missing producer script cannot prove a live PID
// changed owner.
export function closedSessionRow(row: any, server: string, opts: { root?: string; commandLine?: (pid: number) => string | null } = {}, alive: (pid: number) => boolean = pidAlive, now = Date.now()): boolean {
    if (typeof row?.name !== 'string' || typeof row.sessionAttemptId !== 'string' || !row.sessionAttemptId) return false;
    let latest: LogoutProof; try { latest = readLogoutProof(row.name, server, opts); } catch { return false; }
    if (latest.state === 'confirmed') return latest.attemptId >= row.sessionAttemptId;
    if (latest.state !== 'held' || latest.attemptId < row.sessionAttemptId || !Number.isFinite(row.at) || now - row.at < LOST_SESSION_DROP_MS) return false;
    try {
        const attempts = listAttempts(row.name, server, opts).filter(a => a.attemptId >= row.sessionAttemptId);
        if (!attempts.some(a => a.attemptId === row.sessionAttemptId)) return false;
        const normalize = (s: string) => s.replaceAll('\\', '/').toLowerCase();
        for (const a of attempts) {
            const owner = a.receipt?.owner, pid = owner?.pid;
            if (!Number.isSafeInteger(pid) || !pid || pid < 1) return false;
            if (a.attemptId !== row.sessionAttemptId && (!Number.isFinite(a.receipt?.updatedAt) || now - a.receipt!.updatedAt < LOST_SESSION_DROP_MS)) return false;
            if (!alive(pid)) continue;
            if (typeof owner?.script !== 'string' || !owner.script.endsWith('.ts')) return false;
            const line = (opts.commandLine ?? commandLine)(pid);
            if (!line?.trim() || normalize(line).includes(normalize(owner.script))) return false;
        }
        return true;
    } catch { return false; }
}
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } }
