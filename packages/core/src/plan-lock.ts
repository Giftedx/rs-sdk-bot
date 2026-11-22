// Shared account-plan write lock and atomic JSON helpers: one writer of swarm.json at a time across controllers and dashboard commands.
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { laterProcessHolds, processStartTimes } from './proc';

export const planLockDir = join(resolve(import.meta.dir, '../../..'), '.practice/live');
export const ownerPlanPath = (root: string, file = process.env.SWARM_PLAN) => resolve(root, file || 'swarm.json');
export function atomicJson(file: string, value: unknown): void {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, file);
}
const lockPath = (directory: string) => join(directory, 'plan-write-lock.json');
const intentPath = (directory: string, nonce: string) => join(directory, `plan-write-${nonce}.intent.json`);
const archivePath = (directory: string) => join(directory, 'plan-lock-recovery');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const processAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } };

type StartReader = (pids: readonly number[]) => ReadonlyMap<number, number> | null;
// A writer holds the lock for one short write. A lock younger than this is a write in progress: no start time is read.
export const OWNER_START_READ_AFTER_MS = 5000;
// The start time of one owner record is read one time in this interval.
export const OWNER_START_READ_EVERY_MS = 60_000;
const startReads = new Map<string, { owner: string; at: number; later: boolean }>();
// True when the owner of the lock record does not run. The owner wrote `at` itself, so a process that holds its id and
// started after `at` is a later process (laterProcessHolds). The read of a start time starts a process, and a waiting
// writer makes this check each 25 ms. Thus the read is made only for a lock older than OWNER_START_READ_AFTER_MS, and
// its result is kept: "a later process" for as long as the record is there, "the owner" for OWNER_START_READ_EVERY_MS.
function ownerGone(file: string, owner: { pid: number; nonce?: unknown; at?: unknown }, alive: (pid: number) => boolean, starts: StartReader, now: number): boolean {
    if (!alive(owner.pid)) return true;
    if (typeof owner.at !== 'number' || !Number.isFinite(owner.at) || now - owner.at < OWNER_START_READ_AFTER_MS) return false;
    const key = `${owner.pid}|${String(owner.nonce)}|${owner.at}`, last = startReads.get(file);
    if (last?.owner === key && (last.later || now - last.at < OWNER_START_READ_EVERY_MS)) return last.later;
    const later = laterProcessHolds(owner.pid, owner.at, starts([owner.pid]));
    startReads.set(file, { owner: key, at: now, later });
    return later;
}

/** Serialize account-plan writes across independently running live jobs. */
export async function withPlanWrite<T>(
    action: () => T | Promise<T>, directory = planLockDir, timeoutMs = 15000,
    recover?: (directory: string) => boolean,
): Promise<T> {
    mkdirSync(directory, { recursive: true }); const file = lockPath(directory), nonce = randomUUID(), deadline = Date.now() + timeoutMs;
    const intent = intentPath(directory, nonce); let acquired = false;
    // Publish complete ownership atomically: a killed writer cannot leave an empty
    // lock whose owner the dispatcher cannot identify.
    writeFileSync(intent, JSON.stringify({ pid: process.pid, nonce, at: Date.now() }), { flag: 'wx' });
    try {
        for (;;) {
            try { linkSync(intent, file); acquired = true; break; }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                if (Date.now() >= deadline) throw Error('account plan writer waits for its existing owner');
                if (!recover?.(directory)) await Bun.sleep(25);
            }
        }
        return await action();
    } finally {
        try { if (acquired) { const owner = JSON.parse(readFileSync(file, 'utf8')); if (owner.pid !== process.pid || owner.nonce !== nonce) throw Error('account plan write ownership changed'); unlinkSync(file); } }
        finally { unlinkSync(intent); }
    }
}
/** Only the single dispatcher recovers abandoned write leases; workers wait. */
export function recoverPlanWrite(directory = planLockDir, alive = processAlive, starts: StartReader = processStartTimes, now = Date.now()) {
    const file = lockPath(directory); if (!existsSync(file)) return false;
    let owner: any; try { owner = JSON.parse(readFileSync(file, 'utf8')); } catch { return false; }
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !ownerGone(file, owner, alive, starts, now)) return false;
    const archive = archivePath(directory); mkdirSync(archive, { recursive: true }); renameSync(file, join(archive, `${Date.now()}-${randomUUID()}.json`));
    if (typeof owner.nonce === 'string' && /^[a-f0-9-]{36}$/.test(owner.nonce)) { const intent = intentPath(directory, owner.nonce); if (existsSync(intent)) unlinkSync(intent); }
    return true;
}

/** Independent fleet-data writers compete for the dead owner's unique intent before touching the shared lock. */
export function recoverConcurrentPlanWrite(directory: string, alive = processAlive, starts: StartReader = processStartTimes, now = Date.now()): boolean {
    const file = lockPath(directory);
    let raw: string, owner: {pid: number; nonce: string; at?: unknown};
    try { raw = readFileSync(file, 'utf8'); owner = JSON.parse(raw); } catch { return false; }
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.nonce !== 'string' || !uuid.test(owner.nonce) || !ownerGone(file, owner, alive, starts, now)) return false;

    const intent = intentPath(directory, owner.nonce), prefix = `plan-recover-${owner.nonce}-`;
    let source = intent;
    if (!existsSync(intent)) {
        // A recoverer can die between taking the ticket and archiving the lock. Take over only that dead recoverer's ticket.
        // New ticket names retain their recoverer's time. Legacy names have no time and remain signal-check only.
        const ticket = readdirSync(directory).find(name => name.startsWith(prefix) && name.endsWith('.intent.json'));
        const match = ticket?.slice(prefix.length).match(/^(\d+)-(?:(\d+)-)?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.intent\.json$/);
        const pid = Number(match?.[1]), at = match?.[2] === undefined ? undefined : Number(match[2]);
        if (!ticket || !match || !Number.isSafeInteger(pid) || pid < 1 || at !== undefined && (!Number.isSafeInteger(at) || at < 1)
            || !ownerGone(join(directory, ticket), {pid, nonce: ticket, at}, alive, starts, now)) return false;
        source = join(directory, ticket);
    }
    const archive = archivePath(directory), id = randomUUID();
    mkdirSync(archive, { recursive: true });
    const owned = join(directory, `${prefix}${process.pid}-${Date.now()}-${id}.intent.json`);
    // rename moves this exact, unique source once. A delayed recoverer cannot take a later writer's intent.
    try { renameSync(source, owned); } catch (error) { if (missing(error)) return false; throw error; }
    let removeTicket = false;
    try {
        let current: string;
        try { current = readFileSync(file, 'utf8'); }
        catch (error) { if (!missing(error)) throw error; removeTicket = true; return false; }
        if (current !== raw) { removeTicket = true; return false; }
        renameSync(file, join(archive, `${Date.now()}-${id}.json`));
        removeTicket = true;
        return true;
    } finally {
        if (removeTicket) unlinkSync(owned);
        else renameSync(owned, intent);
    }
}
