// The long-lived controllers that a person starts by hand, in one table, and the lease that says one of them runs.
// The watchdog (packages/router/src/watchdog.ts) starts a controller whose lease no live process holds, and the
// dashboard (packages/dashboard) shows the same state. The coordinator and the swarm have their own owner files.
//
// A lease is a file that holds a process id. Its holder writes it again on each pass, so the file time is a heartbeat.
// The lease is held while that process is alive and the file is newer than LEASE_STALE_MS. Windows gives the id of
// an ended process to a new one, so a live id alone proves nothing. A holder that finds another id in its lease has
// lost it and must exit: two controllers of one kind must never run.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// The fleet agent's pass is 10 minutes and its sync can wait for the network. 25 minutes is two passes and a margin.
export const LEASE_STALE_MS = 25 * 60_000;

const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } };
type LeaseDeps = { now?: number; alive?: (pid: number) => boolean; staleMs?: number };

export function readLease(file: string): { pid: number; at: number } | null {
    try {
        const pid = Number(readFileSync(file, 'utf8').trim()), at = statSync(file).mtimeMs;
        return Number.isSafeInteger(pid) && pid > 0 ? { pid, at } : null;
    } catch { return null; }
}

// The process id of the live holder, or null.
export function leaseHolder(file: string, deps: LeaseDeps = {}): number | null {
    const lease = readLease(file), now = deps.now ?? Date.now();
    if (!lease || now - lease.at >= (deps.staleMs ?? LEASE_STALE_MS)) return null;
    return (deps.alive ?? pidAlive)(lease.pid) ? lease.pid : null;
}

// Takes the lease for `pid`. False when a different live process holds it.
export function takeLease(file: string, pid = process.pid, deps: LeaseDeps = {}): boolean {
    const holder = leaseHolder(file, deps);
    if (holder !== null && holder !== pid) return false;
    writeFileSync(file, String(pid));
    return true;
}

// The heartbeat. False when the lease names a different process or is gone: the caller has lost it and must exit.
export function renewLease(file: string, pid = process.pid): boolean {
    if (readLease(file)?.pid !== pid) return false;
    writeFileSync(file, String(pid));
    return true;
}

export function releaseLease(file: string, pid = process.pid): void {
    try { if (readLease(file)?.pid === pid) rmSync(file); } catch { /* gone */ }
}

// The arguments that a controller runs with, written by the controller. A restart by the watchdog uses the same ones.
export function saveLaunch(file: string, args: readonly string[]): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ args }));
}
export function readLaunch(file: string): string[] | null {
    try {
        const args = JSON.parse(readFileSync(file, 'utf8'))?.args;
        return Array.isArray(args) && args.every(a => typeof a === 'string' && a.length > 0 && !a.includes('\0')) ? args : null;
    } catch { return null; }
}

export type Controller = {
    name: 'fleet-agent' | 'autopilot'; label: string;
    lease: string;   // the lease file, under the repository root
    ran: string;     // a path that exists only where this controller ran before; the watchdog starts no other
    stop: string;    // the stop file that keeps the watchdog from starting it
    launch?: string; // the record of its arguments (saveLaunch), for a controller that takes some
};
export const CONTROLLERS: readonly Controller[] = [
    { name: 'fleet-agent', label: 'Fleet agent', lease: '.practice/fleet-agent.lock', ran: '.practice/fleet-agent.log', stop: '.practice/stop-fleet-agent' },
    { name: 'autopilot', label: 'Autopilot', lease: '.practice/autopilot.lock', ran: '.practice/autopilot', stop: '.practice/stop-autopilot', launch: '.practice/autopilot/launch.json' },
];

// running: a live process holds the lease. stopped: the owner's stop file is there. never: it did not run on this
// machine. down: it ran before, no stop file is there, and no live process holds the lease.
export type ControllerState = { name: Controller['name']; label: string; state: 'running' | 'stopped' | 'never' | 'down'; pid: number | null; seenAt: number | null };
export function controllerState(root: string, c: Controller, deps: LeaseDeps = {}): ControllerState {
    const lease = join(root, c.lease), pid = leaseHolder(lease, deps);
    let seenAt = readLease(lease)?.at ?? null;
    if (seenAt === null) try { seenAt = statSync(join(root, c.ran)).mtimeMs; } catch { /* did not run here */ }
    const state = pid !== null ? 'running' : existsSync(join(root, c.stop)) ? 'stopped' : existsSync(join(root, c.ran)) ? 'down' : 'never';
    return { name: c.name, label: c.label, state, pid, seenAt };
}
export const controllerStates = (root: string, deps: LeaseDeps = {}): ControllerState[] => CONTROLLERS.map(c => controllerState(root, c, deps));
