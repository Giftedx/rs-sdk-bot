// Keeps the autonomous loop running until the whole game is done (scoreboard progress.done). Run every 5 minutes by
// the Windows task "rs-sdk-coordinator-watchdog" (packages/router/src/watchdog-install.ts). Each run, in about a second:
// 1. Honours owner stops: with .practice/stop-coordinator or .practice/stop-swarm it does nothing.
// 2. Restarts the coordinator hidden and detached when its owner process is gone.
// 3. Records the scoreboard progress numbers, and writes .practice/coordinator/stall.json when none rose for
//    STALL_MS; the planner reads it and must change lane or method. A gain removes the note.
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnDetached } from './coordinator-store';
import { freshScoreboard, improved, type Progress } from './coverage';

export const STALL_MS = 6 * 3600_000;
const root = resolve(import.meta.dir, '../../..'), dir = join(root, '.practice', 'coordinator');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } };

export function stalled(history: { at: number; progress: Progress }[], now: number, stallMs = STALL_MS): { since: number; last: Progress } | null {
    if (!history.length || now - history[0]!.at < stallMs) return null;
    let lastGain = history[0]!.at;
    for (let i = 1; i < history.length; i++) if (improved(history[i - 1]!.progress, history[i]!.progress)) lastGain = history[i]!.at;
    return now - lastGain >= stallMs ? { since: lastGain, last: history.at(-1)!.progress } : null;
}

if (import.meta.main) {
    const now = Date.now(), log = (line: string) => appendFileSync(join(dir, 'watchdog.log'), `${new Date(now).toISOString()} ${line}\n`);
    if (['stop-coordinator', 'stop-swarm'].some(f => existsSync(join(root, '.practice', f)))) { log('owner stop present; nothing started'); process.exit(0); }
    const owner = existsSync(join(dir, 'owner.json')) ? JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')) : null;
    if (!owner?.pid || !alive(owner.pid)) {
        const token = 'watchdog-' + randomUUID(), stamp = now;
        const pid = spawnDetached([process.execPath, 'packages/router/src/coordinator-cli.ts', '--run', token], root, join(dir, `daemon-${stamp}.out.log`), join(dir, `daemon-${stamp}.err.log`));
        log(`coordinator restarted pid=${pid} token=${token} (previous pid=${owner?.pid ?? 'none'})`);
    }
    const board = freshScoreboard(root), file = join(dir, 'scoreboard-history.jsonl');
    appendFileSync(file, JSON.stringify({ at: now, progress: board.progress }) + '\n');
    const history = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => now - r.at <= 3 * STALL_MS);
    const stall = stalled(history, now), note = join(dir, 'stall.json');
    if (board.progress.done) log('scoreboard done: the whole game is covered');
    if (stall) writeFileSync(note, JSON.stringify({ at: now, since: stall.since, hours: Math.round((now - stall.since) / 360_000) / 10, progress: stall.last }, null, 1));
    else if (existsSync(note)) unlinkSync(note);
}
