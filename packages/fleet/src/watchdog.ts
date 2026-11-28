// Keeps autonomous fleet controllers, publisher, status pruning, and standalone session recovery running with zero LLM Coordinator dependency.
// Honors .practice/stop-coordinator, .practice/stop-swarm, and .practice/live/stop-* owner stop files.
// Usage: bun packages/fleet/src/watchdog.ts
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONTROLLERS, controllerState, readLaunch, type Controller, type Launch } from '../../core/src/controllers';
import { leanBunEnv } from '../../core/src/lean-bun-env';
import { hasStopFile } from '../../core/src/practice-paths';
import { pidStartedAfter } from '../../core/src/proc';
import { ensureHostedQualification, type QualifyDeps } from './recovery-qualify';
import { QUALIFICATION_MISSING, runStandaloneRecoveryPass, type StandaloneRecoveryPassResult } from './session-recovery';
import { pruneStatus } from './status-prune';

export const STALL_MS = 6 * 3600_000;
const root = resolve(import.meta.dir, '../../..');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } };

export interface WatchdogProgress {
    goalVersion?: 1;
    goalMetrics?: Record<string, number>;
    [key: string]: unknown;
}

function progressImproved(before: WatchdogProgress, after: WatchdogProgress): boolean {
    if (before.goalVersion !== 1 || after.goalVersion !== 1) return false;
    return Object.entries(after.goalMetrics ?? {}).some(([key, value]) => Number.isFinite(value)
        && Number.isFinite(before.goalMetrics?.[key]) && value > before.goalMetrics![key]!);
}

export function stalled(history: readonly { at: number; progress: WatchdogProgress }[], now: number, stallMs = STALL_MS): { since: number; last: WatchdogProgress } | null {
    history = history.filter(row => row.progress.goalVersion === 1);
    if (!history.length || now - history[0]!.at < stallMs) return null;
    let lastGain = history[0]!.at;
    const high: WatchdogProgress = { ...history[0]!.progress, goalMetrics: { ...history[0]!.progress.goalMetrics } };
    for (let i = 1; i < history.length; i++) {
        const current = history[i]!.progress;
        if (progressImproved(high, current)) lastGain = history[i]!.at;
        for (const [key, value] of Object.entries(current.goalMetrics ?? {})) {
            if (Number.isFinite(value)) {
                const prior = high.goalMetrics![key];
                high.goalMetrics![key] = Number.isFinite(prior) ? Math.max(prior!, value) : value;
            }
        }
    }
    return now - lastGain >= stallMs ? { since: lastGain, last: history.at(-1)!.progress } : null;
}

function spawnDetached(args: string[], cwd: string, stdout: string, stderr: string, env: NodeJS.ProcessEnv = process.env): number {
    const out = openSync(stdout, 'w'), err = openSync(stderr, 'w');
    try {
        const child = spawn(args[0]!, args.slice(1), { cwd, env, detached: true, windowsHide: true, stdio: ['ignore', out, err] });
        child.unref();
        if (!child.pid) throw Error('detached child did not start');
        return child.pid;
    } finally {
        closeSync(out);
        closeSync(err);
    }
}

export function restartCommand(name: Controller['name'], launch: Launch, exists: (path: string) => boolean = existsSync): string[] | string {
    if (name === 'fleet-agent') return ['scripts/fleet-agent.ts', '--daemon'];
    const plan = launch.args[0];
    if (launch.args.length !== 1 || plan === undefined || plan.startsWith('--') || !exists(plan)) return `its recorded plan is not a file: ${launch.args.join(' ').slice(0, 160)}`;
    return ['scripts/swarm.ts', plan];
}

export function recoveryLog(stdout: string, stderr: string, exitCode: number | null): string[] {
    const lines = stdout.split(/\r?\n/)
        .filter(l => l.startsWith('CLOUD_RECOVER ') || l.startsWith('FLEET_RECOVERY '))
        .map(l => {
            const payload = l.startsWith('CLOUD_RECOVER ') ? l.slice('CLOUD_RECOVER '.length, 400) : l.slice('FLEET_RECOVERY '.length, 400);
            return `session recovery: ${payload}`;
        });
    if (exitCode !== 0) lines.push(`session recovery call ${exitCode === null ? 'did not end in time' : `exit ${exitCode}`}: ${stderr.trim().slice(-200)}`);
    return lines;
}

export function publisherRepo(remote: string): string | null {
    const m = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
    return m ? m[1]! : null;
}

export type WatchdogDeps = {
    hasStop?: (flag: string) => boolean;
    prune?: (base: string, opts: { now: number }) => { moved: string[]; kept: number; failed: number };
    recover?: () => Promise<Pick<StandaloneRecoveryPassResult, 'skipped'> | void>;
    restartController?: (c: Controller, start: string[], env: NodeJS.ProcessEnv) => void;
    log?: (line: string) => void;
    now?: () => number;
    qualify?: QualifyDeps;
    // True when the live process with a lease's id started after the lease's last heartbeat (pidStartedAfter).
    reused?: (pid: number, savedAt: number) => boolean;
};

export async function runWatchdogPass(base = root, deps: WatchdogDeps = {}): Promise<{ stoppedByOwner: boolean; pruned: number }> {
    const now = (deps.now ?? Date.now)();
    const baseLogDir = join(base, '.practice', 'fleet');
    mkdirSync(baseLogDir, { recursive: true });
    const log = deps.log ?? ((line: string) => appendFileSync(join(baseLogDir, 'watchdog.log'), `${new Date(now).toISOString()} ${line}\n`));
    const stopped = deps.hasStop ?? (flag => hasStopFile(flag, base));
    const prac = join(base, '.practice'), clone = join(prac, 'fleet-command', 'repo'), pubLock = join(prac, 'dashboard-publish.lock');

    let prunedCount = 0;
    try {
        const pruned = (deps.prune ?? pruneStatus)(base, { now });
        prunedCount = pruned.moved.length;
        if (pruned.moved.length || pruned.failed) {
            log(`status rows: moved ${pruned.moved.length} old practice rows to status-archive, kept ${pruned.kept}${pruned.failed ? `, ${pruned.failed} not moved` : ''}`);
        }
    } catch (e) {
        log(`status rows not pruned: ${String(e).slice(0, 200)}`);
    }

    if (!stopped('dashboard-publish') && existsSync(join(clone, '.git'))) {
        const pid = existsSync(pubLock) ? Number(readFileSync(pubLock, 'utf8')) : 0;
        if (!pid || !alive(pid)) {
            const remote = Bun.spawnSync(['git', '-C', clone, 'remote', 'get-url', 'origin'], { stdout: 'pipe', stderr: 'ignore', timeout: 15_000, windowsHide: true }).stdout.toString();
            const repo = publisherRepo(remote);
            if (!repo) log(`publisher not restarted: no GitHub origin in ${clone}`);
            else {
                const r = Bun.spawnSync([process.execPath, '--smol', 'packages/dashboard/publish.ts', '--daemon'], { cwd: base, env: leanBunEnv({ ...process.env, FLEET_COMMAND_REPO: repo }), stdout: 'pipe', stderr: 'pipe', timeout: 30_000, windowsHide: true });
                log(`publisher restarted for ${repo} (previous pid=${pid || 'none'}): ${(r.stdout.toString() + r.stderr.toString()).trim().slice(0, 200)}`);
            }
        }
    }

    if (stopped('coordinator') || stopped('swarm')) {
        log('owner stop present; nothing started');
        return { stoppedByOwner: true, pruned: prunedCount };
    }

    for (const c of CONTROLLERS) {
        // A process that got the id of an ended fleet agent does not keep the fleet agent down for the lease lifetime.
        // Only a controller whose own takeLease makes the same check gets it: a restarted swarm would still find the
        // reused id live in its takeLease and exit, and the watchdog would start it again on each pass.
        const reused = c.name === 'fleet-agent' ? deps.reused ?? pidStartedAfter : undefined;
        if (controllerState(base, c, { now, reused }).state !== 'down') continue;
        const launch = readLaunch(join(base, c.launch));
        if (!launch) continue;
        const start = restartCommand(c.name, launch, p => existsSync(resolve(base, p)));
        if (typeof start === 'string') { log(`${c.name} not restarted: ${start}`); continue; }
        const env = leanBunEnv({ ...process.env, ...launch.env });
        if (deps.restartController) {
            deps.restartController(c, start, env);
            continue;
        }
        if (c.name === 'fleet-agent') {
            const r = Bun.spawnSync([process.execPath, '--smol', ...start], { cwd: base, env, stdout: 'pipe', stderr: 'pipe', timeout: 30_000, windowsHide: true });
            log(`fleet-agent restarted: ${(r.stdout.toString() + r.stderr.toString()).trim().slice(0, 200)}`);
        } else {
            mkdirSync(join(prac, 'swarm-logs'), { recursive: true });
            const swarmArgs = ['--smol', ...start, `--nonce=${randomUUID()}`];
            const pid = spawnDetached([process.execPath, ...swarmArgs], base, join(prac, 'swarm-logs', `daemon-${now}.out.log`), join(prac, 'swarm-logs', `daemon-${now}.err.log`), env);
            log(`swarm restarted pid=${pid} plan=${start[1]}`);
        }
    }

    if ((process.env.FLEET_SIDE || 'local') === 'local' && !stopped('session-recovery')) {
        try {
            const pass = deps.recover
                ? await deps.recover()
                : await runStandaloneRecoveryPass({
                    root: base,
                    log: msg => log(`session recovery: ${msg.slice(0, 400)}`),
                });
            const waiting = pass?.skipped.filter(s => s.reason.startsWith(QUALIFICATION_MISSING)) ?? [];
            if (waiting.length) {
                const newestEnd = Math.max(0, ...waiting.map(s => s.endedAt ?? 0));
                ensureHostedQualification(base, deps.now ?? Date.now, log, deps.qualify, newestEnd);
            }
        } catch (e) {
            log(`session recovery failed: ${String(e).slice(0, 200)}`);
        }
    }

    if ((process.env.FLEET_SIDE || 'local') === 'local' && existsSync(join(prac, 'cloud-launch', 'config.json')) && !stopped('cloud-launch')) {
        const r = Bun.spawnSync([process.execPath, '--smol', 'scripts/cloud-launch.ts', '--once'], { cwd: base, env: leanBunEnv(process.env), stdout: 'pipe', stderr: 'pipe', timeout: 240_000, windowsHide: true });
        for (const line of `${r.stdout.toString()}\n${r.stderr.toString()}`.split('\n').map(l => l.trim()).filter(Boolean).slice(-6)) {
            log(line.slice(0, 300));
        }
    }

    return { stoppedByOwner: false, pruned: prunedCount };
}

export const WATCHDOG_USAGE = 'usage: bun packages/fleet/src/watchdog.ts (no arguments: one pass of status pruning, controller restarts and standalone session recovery)';

// A pass starts each controller that it finds down as a child of the caller. So an argument never runs a pass:
// --help or -h shows the usage, and any other argument is refused.
export function watchdogArgs(argv: readonly string[]): 'run' | 'help' | 'refuse' {
    if (argv.length === 0) return 'run';
    return argv.every(a => a === '--help' || a === '-h') ? 'help' : 'refuse';
}

if (import.meta.main) {
    const mode = watchdogArgs(process.argv.slice(2));
    if (mode === 'run') await runWatchdogPass(root);
    else if (mode === 'help') console.log(WATCHDOG_USAGE);
    else { console.error(WATCHDOG_USAGE); process.exit(2); }
}
