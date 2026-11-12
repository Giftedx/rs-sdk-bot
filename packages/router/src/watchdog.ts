// Keeps the autonomous loop running until the whole game is done (scoreboard progress.done). Run every 5 minutes by
// the Windows task "rs-sdk-coordinator-watchdog" (packages/router/src/watchdog-install.ts). Each run, in about a second:
// 1. Honours owner stops: with .practice/stop-coordinator or .practice/stop-swarm it does nothing.
// 2. Restarts the coordinator hidden and detached when its owner process is gone.
// 3. Restarts the fleet agent and the autopilot from their launch records when no live process holds the lease
//    (packages/core/src/controllers.ts). A daemon writes its record when a person starts it, so a machine where
//    none was started gets none. .practice/stop-fleet-agent and .practice/stop-autopilot keep each one stopped.
// 4. Records the scoreboard progress numbers, and writes .practice/coordinator/stall.json when none rose for
//    STALL_MS; the planner reads it and must change lane or method. A gain removes the note.
// Before the owner-stop check, it restarts the hosted dashboard's publisher (packages/dashboard/publish.ts) when the
// publisher has a clone in .practice/fleet-command/repo and its lock names no live process. Nothing else starts it
// after a reboot, and a stopped publisher leaves the hosted page on its last file. .practice/stop-dashboard-publish
// keeps it stopped. The coordinator stop files do not: they stop game work, not the page.
// Also before that check, it moves the old rows of practice accounts out of .practice/status
// (packages/router/src/status-prune.ts), because each controller reads that whole folder.
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnDetached } from './coordinator-store';
import { freshScoreboard, improved, type Progress } from './coverage';
import { pruneStatus } from './status-prune';
import { CONTROLLERS, controllerState, readLaunch, type Controller, type Launch } from '../../core/src/controllers';

export const STALL_MS = 6 * 3600_000;
const root = resolve(import.meta.dir, '../../..'), dir = join(root, '.practice', 'coordinator');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } };

export function stalled(history: { at: number; progress: Progress }[], now: number, stallMs = STALL_MS): { since: number; last: Progress } | null {
    if (!history.length || now - history[0]!.at < stallMs) return null;
    let lastGain = history[0]!.at;
    for (let i = 1; i < history.length; i++) if (improved(history[i - 1]!.progress, history[i]!.progress)) lastGain = history[i]!.at;
    return now - lastGain >= stallMs ? { since: lastGain, last: history.at(-1)!.progress } : null;
}

// The command that starts a controller again from its launch record, or the reason that it cannot start.
// The autopilot record holds one argument, its plan file. A daemon on a different plan would write jobs that the
// running swarm does not read, so a record without that file starts nothing.
export function restartCommand(name: Controller['name'], launch: Launch, exists: (path: string) => boolean = existsSync): string[] | string {
    if (name === 'fleet-agent') return ['scripts/fleet-agent.ts', '--daemon'];
    const plan = launch.args[0];
    if (launch.args.length !== 1 || plan === undefined || plan.startsWith('--') || !exists(plan)) return `its recorded plan is not a file: ${launch.args.join(' ').slice(0, 160)}`;
    return ['scripts/autopilot.ts', plan, '--daemon'];
}

// owner/name of the hosted dashboard repository from the publisher clone's origin URL.
export function publisherRepo(remote: string): string | null {
    const m = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
    return m ? m[1]! : null;
}

if (import.meta.main) {
    const now = Date.now(), log = (line: string) => appendFileSync(join(dir, 'watchdog.log'), `${new Date(now).toISOString()} ${line}\n`);
    const prac = join(root, '.practice'), clone = join(prac, 'fleet-command', 'repo'), pubLock = join(prac, 'dashboard-publish.lock');
    // A failure here must not stop the restarts below.
    try {
        const pruned = pruneStatus(root, { now });
        if (pruned.moved.length || pruned.failed) log(`status rows: moved ${pruned.moved.length} old practice rows to .practice/status-archive, kept ${pruned.kept}${pruned.failed ? `, ${pruned.failed} not moved` : ''}`);
    } catch (e) { log(`status rows not pruned: ${String(e).slice(0, 200)}`); }
    if (!existsSync(join(prac, 'stop-dashboard-publish')) && existsSync(join(clone, '.git'))) {
        const pid = existsSync(pubLock) ? Number(readFileSync(pubLock, 'utf8')) : 0;
        if (!pid || !alive(pid)) {
            const remote = Bun.spawnSync(['git', '-C', clone, 'remote', 'get-url', 'origin'], { stdout: 'pipe', stderr: 'ignore', windowsHide: true }).stdout.toString();
            const repo = publisherRepo(remote);
            if (!repo) log(`publisher not restarted: no GitHub origin in ${clone}`);
            else {
                // --daemon detaches the publisher, appends to .practice/dashboard-publish.log and returns at once.
                const r = Bun.spawnSync([process.execPath, 'packages/dashboard/publish.ts', '--daemon'], { cwd: root, env: { ...process.env, FLEET_COMMAND_REPO: repo }, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
                log(`publisher restarted for ${repo} (previous pid=${pid || 'none'}): ${(r.stdout.toString() + r.stderr.toString()).trim().slice(0, 200)}`);
            }
        }
    }
    if (['stop-coordinator', 'stop-swarm'].some(f => existsSync(join(root, '.practice', f)))) { log('owner stop present; nothing started'); process.exit(0); }
    const owner = existsSync(join(dir, 'owner.json')) ? JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')) : null;
    if (!owner?.pid || !alive(owner.pid)) {
        const token = 'watchdog-' + randomUUID(), stamp = now;
        const pid = spawnDetached([process.execPath, 'packages/router/src/coordinator-cli.ts', '--run', token], root, join(dir, `daemon-${stamp}.out.log`), join(dir, `daemon-${stamp}.err.log`));
        log(`coordinator restarted pid=${pid} token=${token} (previous pid=${owner?.pid ?? 'none'})`);
    }
    // The fleet agent and the autopilot: each one that a person started as a daemon on this machine (its launch
    // record), that has no owner stop file, and whose lease no live process holds (packages/core/src/controllers.ts).
    // The recorded settings go over this task's environment, so the daemon keeps its side, plan and login permission.
    for (const c of CONTROLLERS) {
        if (controllerState(root, c, { now }).state !== 'down') continue;
        const launch = readLaunch(join(root, c.launch));
        if (!launch) continue;
        const start = restartCommand(c.name, launch);
        if (typeof start === 'string') { log(`${c.name} not restarted: ${start}`); continue; }
        const env = { ...process.env, ...launch.env };
        if (c.name === 'fleet-agent') {
            // --daemon detaches the agent, appends to .practice/fleet-agent.log and returns at once.
            const r = Bun.spawnSync([process.execPath, ...start], { cwd: root, env, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
            log(`fleet-agent restarted: ${(r.stdout.toString() + r.stderr.toString()).trim().slice(0, 200)}`);
        } else {
            mkdirSync(join(prac, 'autopilot'), { recursive: true });
            const pid = spawnDetached([process.execPath, ...start], root, join(prac, 'autopilot', `daemon-${now}.out.log`), join(prac, 'autopilot', `daemon-${now}.err.log`), env);
            log(`autopilot restarted pid=${pid} plan=${start[1]}`);
        }
    }
    // The planner reads the Overall route's supply bill against current banks (packages/planner/src/supply-bill.ts).
    const bill = Bun.spawnSync([process.execPath, 'packages/planner/src/supply-bill.ts'], { cwd: root, stdout: 'ignore', stderr: 'pipe', windowsHide: true });
    if (bill.exitCode !== 0) log(`supply bill failed: ${bill.stderr.toString().slice(-200)}`);
    const board = freshScoreboard(root), file = join(dir, 'scoreboard-history.jsonl');
    appendFileSync(file, JSON.stringify({ at: now, progress: board.progress }) + '\n');
    const history = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => now - r.at <= 3 * STALL_MS);
    const stall = stalled(history, now), note = join(dir, 'stall.json');
    if (board.progress.done) log('scoreboard done: the whole game is covered');
    if (stall) writeFileSync(note, JSON.stringify({ at: now, since: stall.since, hours: Math.round((now - stall.since) / 360_000) / 10, progress: stall.last }, null, 1));
    else if (existsSync(note)) unlinkSync(note);
}
