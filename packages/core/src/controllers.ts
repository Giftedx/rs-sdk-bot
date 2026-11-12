// The long-lived controllers that a person starts by hand, in one table, and the lease that says one of them runs.
// The watchdog (packages/router/src/watchdog.ts) starts a controller whose lease no live process holds, and the
// dashboard (packages/dashboard) shows the same state. The coordinator and the swarm have their own owner files.
//
// A lease is a file that holds a process id. Its holder writes it again on each pass, so the file time is a heartbeat.
// The lease is held while that process is alive and the file is newer than LEASE_STALE_MS. Windows gives the id of
// an ended process to a new one, so a live id alone proves nothing. A holder that finds another id in its lease has
// lost it and must exit: two controllers of one kind must never run.
//
// A launch record is a file that a daemon writes when it starts: its arguments and the LAUNCH_ENV settings of its
// environment. The watchdog starts a controller only from its record, with the same plan, side and login permission.
// A one-shot pass writes no record, so it never becomes a daemon.
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
