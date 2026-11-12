// The long-lived controllers that a person starts by hand, in one table, and the lease that says one of them runs.
// The watchdog (packages/router/src/watchdog.ts) starts a controller whose lease no live process holds, and the
// dashboard (packages/dashboard) shows the same state. The coordinator and the swarm have their own owner files.
//
// A lease is a file that holds a process id. Its holder sets the file time again on each pass, so the file time is a
// heartbeat. The lease is held while that process is alive and the file is newer than LEASE_STALE_MS. Windows gives
// the id of an ended process to a new one, so a live id alone proves nothing. A holder that finds another id in its
// lease has lost it and must exit: two controllers of one kind must never run.
//
// One process at a time can change a lease. The take, the heartbeat and the release all happen at a gate (atGate
// below): a process puts down a ticket file with a name of its own, then looks, and goes in only when no different
// live process has a ticket there. At the gate it reads the lease again. A take replaces only a lease that is not
// held, and a heartbeat sets the time only of a lease that still names its process.
// A process that does not get the lease gets false.
//
// A launch record is a file that a daemon writes when it starts: its arguments and the LAUNCH_ENV settings of its
// environment. The watchdog starts a controller only from its record, with the same plan, side and login permission.
// A one-shot pass writes no record, so it never becomes a daemon.
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

// The fleet agent's pass is 10 minutes and its sync can wait for the network. 25 minutes is two passes and a margin.
export const LEASE_STALE_MS = 25 * 60_000;
// A process is at the gate for a few file operations. A ticket older than one minute is of a process that ended.
export const GATE_STALE_MS = 60_000;

const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } };
const errno = (e: unknown) => (e as NodeJS.ErrnoException).code;
const pidOf = (text: string) => { const pid = Number(text.trim()); return Number.isSafeInteger(pid) && pid > 0 ? pid : null; };
type LeaseDeps = { now?: number; alive?: (pid: number) => boolean; staleMs?: number };
type Seen = { text: string; at: number };

// The content and the time of a file: together they name one exact file, also when a later file has the same content.
function seen(file: string): Seen | null {
    try { return { text: readFileSync(file, 'utf8'), at: statSync(file).mtimeMs }; } catch { return null; }
}
// Creates `file` with `text` in one step, or returns false when the file is there. The link publishes the whole
// content, so no reader finds an empty file.
function createExclusive(file: string, text: string): boolean {
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, text, { flag: 'wx' });
    try { linkSync(tmp, file); return true; }
    catch (e) { if (errno(e) !== 'EEXIST') throw e; return false; }
    finally { unlinkSync(tmp); }
}
// Removes `file` only when it is still the file in `was`. A rename moves one file one time, so two processes cannot
// both remove it. A different file that took its place goes back, unless a third file is there already.
function removeExact(file: string, was: Seen): boolean {
    const moved = `${file}.${process.pid}.${randomUUID()}.old`;
    try { renameSync(file, moved); } catch (e) { if (errno(e) === 'ENOENT') return false; throw e; }
    const now = seen(moved), same = now !== null && now.text === was.text && now.at === was.at;
    if (!same) try { linkSync(moved, file); } catch (e) { if (errno(e) !== 'EEXIST') throw e; }
    unlinkSync(moved);
    return same;
}

export function readLease(file: string): { pid: number; at: number } | null {
    const s = seen(file), pid = s ? pidOf(s.text) : null;
    return s && pid !== null ? { pid, at: s.at } : null;
}

// The process id of the live holder, or null.
export function leaseHolder(file: string, deps: LeaseDeps = {}): number | null {
    const lease = readLease(file), now = deps.now ?? Date.now();
    if (!lease || now - lease.at >= (deps.staleMs ?? LEASE_STALE_MS)) return null;
    return (deps.alive ?? pidAlive)(lease.pid) ? lease.pid : null;
}

// Runs `body` while this process is the only one at the gate of `file`, or returns null when a different live
// process is there. Each process puts down a ticket with a name of its own, and then looks: it goes in only when it
// finds no ticket of a different live process. Each one writes before it looks, so two processes cannot both find
// the gate empty. Two that look at the same instant both step back. A ticket name is never used twice, so the ticket
// of an ended process can be removed without a risk to a live one.
// The tickets are in a folder of their own, `<lease>.gate`, so a look reads a few names and not the whole .practice folder.
function atGate<T>(file: string, pid: number, alive: (pid: number) => boolean, body: () => T): T | null {
    const dir = `${file}.gate`, mine = `${pid}.${randomUUID()}`;
    mkdirSync(dir, { recursive: true });        // a new checkout has no .practice folder before its first daemon
    writeFileSync(join(dir, mine), '', { flag: 'wx' });
    try {
        for (const name of readdirSync(dir)) {
            if (name === mine) continue;
            const owner = Number(name.split('.')[0]);
            let at: number;
            try { at = statSync(join(dir, name)).mtimeMs; } catch { continue; }      // its owner removed it in this instant
            if (owner !== pid && Number.isSafeInteger(owner) && owner > 0 && Date.now() - at < GATE_STALE_MS && alive(owner)) return null;
            try { unlinkSync(join(dir, name)); } catch { /* removed by a different process */ }
        }
        return body();
    } finally { try { unlinkSync(join(dir, mine)); } catch { /* removed as old by a different process */ } }
}
const pause = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
// Processes that meet at the gate step back and try again after a short random time, GATE_TRIES times at most.
// Null when a different live process was at the gate each time.
export const GATE_TRIES = 8;
function throughGate<T>(file: string, pid: number, alive: (pid: number) => boolean, body: () => T): T | null {
    for (let attempt = 0; attempt < GATE_TRIES; attempt++) {
        if (attempt) pause(20 + Math.floor(Math.random() * 180));
        const result = atGate(file, pid, alive, body);
        if (result !== null) return result;
    }
    return null;
}
// Sets the file time of a lease that names `pid`. It never writes the content. Call it only at the gate.
function touch(file: string, pid: number, now: number): boolean {
    if (readLease(file)?.pid !== pid) return false;
    try { utimesSync(file, now / 1000, now / 1000); } catch (e) { if (errno(e) === 'ENOENT') return false; throw e; }
    return true;
}

// Takes the lease for `pid`. False when a different live process holds it or takes it in this instant.
// The lease file is created, and a lease that is not held is replaced, only at the gate.
export function takeLease(file: string, pid = process.pid, deps: LeaseDeps = {}): boolean {
    const alive = deps.alive ?? pidAlive, now = deps.now ?? Date.now();
    return throughGate(file, pid, alive, () => {
        const lease = seen(file);
        if (lease) {
            const holder = pidOf(lease.text);
            if (holder === pid) return touch(file, pid, now);           // this process, or an ended one that had its id
            if (holder !== null && now - lease.at < (deps.staleMs ?? LEASE_STALE_MS) && alive(holder)) return false;
            if (!removeExact(file, lease)) return false;                 // its holder changed it in this instant
        }
        return createExclusive(file, String(pid));
    }) ?? false;
}

// The heartbeat. False when the lease names a different process or is gone: the caller has lost it and must exit.
// The check and the new file time are one step at the gate, so a take cannot come between them. After a true result
// the lease is new, and no process can take it before LEASE_STALE_MS.
// When a different process stays at the gate, nothing is written: the lease is still held only if it names this
// process and is not old enough to be taken.
export function renewLease(file: string, pid = process.pid, now = Date.now(), deps: LeaseDeps = {}): boolean {
    const renewed = throughGate(file, pid, deps.alive ?? pidAlive, () => touch(file, pid, now));
    if (renewed !== null) return renewed;
    const lease = readLease(file);
    return lease?.pid === pid && now - lease.at < (deps.staleMs ?? LEASE_STALE_MS);
}

// Removes the lease of `pid`, at the gate. When a different process stays at the gate, the exact file still goes.
export function releaseLease(file: string, pid = process.pid, deps: LeaseDeps = {}): void {
    const remove = () => { const s = seen(file); if (s && pidOf(s.text) === pid) removeExact(file, s); return true; };
    try { if (throughGate(file, pid, deps.alive ?? pidAlive, remove) === null) remove(); } catch { /* gone */ }
}

// The settings of a daemon's environment that a restart must keep: the fleet side, the plan and fleet folders, the
// agent's pass times, and the permission to log in on the live server (packages/core/src/bot.ts). No secret is here,
// and no other variable is recorded.
export const LAUNCH_ENV = ['FLEET_SIDE', 'SWARM_PLAN', 'FLEET_DIR', 'CYCLE', 'LEAD', 'DEMO_OK'] as const;
export type Launch = { args: string[]; env: Record<string, string> };
const plain = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && !v.includes('\0');

export function saveLaunch(file: string, args: readonly string[], env: Record<string, string | undefined> = process.env): void {
    const kept: Record<string, string> = {};
    for (const key of LAUNCH_ENV) if (plain(env[key])) kept[key] = env[key]!;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ args, env: kept }));
}
// Null when the record is absent or does not have this exact form. A setting outside LAUNCH_ENV makes it invalid.
export function readLaunch(file: string): Launch | null {
    try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        if (!raw || !Array.isArray(raw.args) || !raw.args.every(plain) || !raw.env || typeof raw.env !== 'object' || Array.isArray(raw.env)) return null;
        const env = Object.entries(raw.env);
        if (!env.every(([key, value]) => (LAUNCH_ENV as readonly string[]).includes(key) && plain(value))) return null;
        return { args: raw.args, env: Object.fromEntries(env) as Record<string, string> };
    } catch { return null; }
}

export type Controller = {
    name: 'fleet-agent' | 'autopilot'; label: string;
    lease: string;   // the lease file, under the repository root
    launch: string;  // the launch record, under the repository root
    stop: string;    // the stop file that keeps the watchdog from starting it
};
export const CONTROLLERS: readonly Controller[] = [
    { name: 'fleet-agent', label: 'Fleet agent', lease: '.practice/fleet-agent.lock', launch: '.practice/fleet-agent.launch.json', stop: '.practice/stop-fleet-agent' },
    { name: 'autopilot', label: 'Autopilot', lease: '.practice/autopilot.lock', launch: '.practice/autopilot/launch.json', stop: '.practice/stop-autopilot' },
];
export const controllerNamed = (name: Controller['name']): Controller => CONTROLLERS.find(c => c.name === name)!;

// running: a live process holds the lease. stopped: the owner's stop file is there. never: no daemon of this kind
// was started on this machine (no valid launch record). down: a record is there, no stop file is there, and no live
// process holds the lease. seenAt is the time of the last heartbeat, or of the last start.
export type ControllerState = { name: Controller['name']; label: string; state: 'running' | 'stopped' | 'never' | 'down'; pid: number | null; seenAt: number | null };
export function controllerState(root: string, c: Controller, deps: LeaseDeps = {}): ControllerState {
    const lease = join(root, c.lease), pid = leaseHolder(lease, deps), started = readLaunch(join(root, c.launch)) !== null;
    let seenAt = readLease(lease)?.at ?? null;
    if (seenAt === null && started) try { seenAt = statSync(join(root, c.launch)).mtimeMs; } catch { /* removed in this instant */ }
    const state = pid !== null ? 'running' : existsSync(join(root, c.stop)) ? 'stopped' : started ? 'down' : 'never';
    return { name: c.name, label: c.label, state, pid, seenAt };
}
export const controllerStates = (root: string, deps: LeaseDeps = {}): ControllerState[] => CONTROLLERS.map(c => controllerState(root, c, deps));
