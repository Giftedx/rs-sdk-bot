// Runtime worker release enforcement, live cohort compatibility checks, and peer lifecycle closure rules.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isLocalServer } from '../localserver';
import { lifecycleRootForRead, liveRoot, statusReadDirs } from '../practice-paths';
import { commandLine, laterProcessHolds, processStartTimes } from '../proc';
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
    const unfinished = openPeerRows(server, statuses, now, closed);
    if (unfinished.some(s => unknownPeerRow(s, now)))
        throw Error('no worker progress: release peer state unknown; verify offline before rollout');
    if (unfinished.some(s => !standing(s) && s.workRevision !== current(s)))
        throw Error('no worker progress: active legacy/different release; wait offline for coordinated rollout');
}
// A live session's row beats every 5 s (status.ts statusHeartbeatMs); a row older than PEER_STALE_MS names a peer whose
// state the gate does not know.
export const PEER_STALE_MS = 30_000;
// The server forces the logout of a client that sent no bytes for 1000 ticks, 400 s at its 400 ms tick (engine World.ts
// TIMEOUT_NO_RESPONSE), whatever the state of its socket. A session's status row beats on the same event loop that
// sends the client's packets, so a row silent for that long names no session on the server: its process is dead, its
// session is closed or its event loop is blocked. The margin covers a server whose ticks run up to half slow. Such a row
// is closed whatever its producer lifecycle or owner PID show, so a hung or killed worker, or a legacy row with no
// lifecycle, cannot refuse every login on the server. A peer that comes back from a blocked loop checks its own release
// again before it logs in (assertLiveWorkerRelease).
export const SILENT_SESSION_DROP_MS = 600_000;
export const silentSessionRow = (row: any, now = Date.now()): boolean =>
    Number.isFinite(row?.at) && row.at > 0 && row.at <= now && now - row.at >= SILENT_SESSION_DROP_MS;
const unknownPeerRow = (s: any, now: number) => !Number.isFinite(s.at) || s.at <= 0 || s.at > now || now - s.at >= PEER_STALE_MS;
const openPeerRows = (server: string, statuses: readonly any[], now: number, closed: (row: any) => boolean) =>
    statuses.filter(s => s?.server === server && !s.result && !silentSessionRow(s, now) && !closed(s));
// Every standing job counts, on or off: a job just turned off still owns its open session. Unreadable means none.
export function standingAccounts(base = root): Set<string> {
    try {
        const jobs = JSON.parse(readFileSync(join(base, 'swarm.json'), 'utf8')).jobs;
        return new Set((Array.isArray(jobs) ? jobs : []).filter((j: any) => j?.standing === true)
            .flatMap((j: any) => j.accounts ?? (j.account ? [j.account] : [])).filter((a: unknown) => typeof a === 'string').map((a: string) => a.toLowerCase()));
    } catch { return new Set(); }
}

export function isWorkerReleaseHold(result: string): boolean {
    return /^RESULT fail (?:login: )?(?:Error: )?no worker progress: (?:release (?:pin missing|source changed|peer state unknown|build in progress|update pending)|active legacy\/different release)/.test(result);
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
    const memo: ReleaseMemo = new Map(), pin = assertWorkerRelease(env, base, memo), statuses = readPeerStatuses(base).map(s => s.row);
    const owners = standingAccounts(base);
    // A peer whose entries are gone or do not resolve has no current release, so it counts as stale.
    const releases = new Map<string, string>(), current = (row: any) => {
        const key = typeof row?.workEntry === 'string' ? row.workEntry : '';
        if (!releases.has(key)) { let value = ''; try { value = cachedReleaseFor(releaseEntries(key), base); } catch { /* stale */ } releases.set(key, value); }
        return releases.get(key)!;
    };
    assertCompatibleWorkers(pin, server, statuses, Date.now(), peerClosed(server, base), row => standingPeer(row, owners), current);
}
// The status rows the release gate reads: the live directory first, then the legacy one; one row per account file.
export function readPeerStatuses(base = root): { dir: string; row: any }[] {
    const out: { dir: string; row: any }[] = [], seenEntries = new Set<string>();
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
                out.push({ dir: statusDir, row: JSON.parse(raw.toString('utf8')) });
            }
        }
        if (!foundStatusDir) throw Error('missing status directories');
    } catch { throw Error('no worker progress: release peer state unknown; unreadable status evidence'); }
    return out;
}
const peerClosed = (server: string, base: string) => (row: any) =>
    closedSessionRow(row, server, { root: typeof row?.name === 'string' ? resolveLifecycleRoot(row.name, server, base) : lifecycleRootForRead(server, base) });
export type LoginBlocker = { name: string; dir: string; ageMs: number | null; attemptId: string | null; ownerPid: number | null; ownerAlive: boolean | null };
// Read only: the rows that make assertLiveWorkerRelease refuse "peer state unknown" on `server` now, with the owner of
// each row's own lifecycle attempt. tools/now.ts prints them.
export function loginBlockers(server: string, base = root, now = Date.now(), alive: (pid: number) => boolean = pidAlive): LoginBlocker[] {
    const rows = readPeerStatuses(base), closed = peerClosed(server, base);
    const open = new Set(openPeerRows(server, rows.map(r => r.row), now, closed).filter(s => unknownPeerRow(s, now)));
    return rows.filter(r => open.has(r.row)).map(({ dir, row }) => {
        const attemptId = typeof row.sessionAttemptId === 'string' && row.sessionAttemptId ? row.sessionAttemptId : null;
        let ownerPid: number | null = null;
        if (attemptId && typeof row.name === 'string') {
            try {
                const pid = listAttempts(row.name, server, { root: resolveLifecycleRoot(row.name, server, base) }).find(a => a.attemptId === attemptId)?.receipt?.owner?.pid;
                if (Number.isSafeInteger(pid) && pid! > 0) ownerPid = pid!;
            } catch { /* no readable attempt: the owner is not known */ }
        }
        return { name: String(row.name), dir, ageMs: Number.isFinite(row.at) && row.at > 0 ? now - row.at : null, attemptId, ownerPid, ownerAlive: ownerPid === null ? null : alive(ownerPid) };
    });
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
// stand on the server), holds the row. A live PID whose process started after the attempt was created is a later process
// (the owner wrote createdAt itself, so it started before it), also when its command line reads as empty, as a system
// process's does. A start time that cannot be read proves nothing; then an unreadable command line or missing producer
// script cannot prove a live PID changed owner.
export function closedSessionRow(row: any, server: string, opts: { root?: string; commandLine?: (pid: number) => string | null; starts?: (pids: readonly number[]) => ReadonlyMap<number, number> | null } = {}, alive: (pid: number) => boolean = pidAlive, now = Date.now()): boolean {
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
            if (laterProcessHolds(pid, a.receipt!.createdAt, (opts.starts ?? processStartTimes)([pid]))) continue;
            if (typeof owner?.script !== 'string' || !owner.script.endsWith('.ts')) return false;
            const line = (opts.commandLine ?? commandLine)(pid);
            if (!line?.trim() || normalize(line).includes(normalize(owner.script))) return false;
        }
        return true;
    } catch { return false; }
}
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } }
