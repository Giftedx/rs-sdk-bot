// A long-lived daemon loads its code once. packages/fleet/src/live-update.ts writes .practice/live-update.json when it moves the
// checkout to a newer master, with each daemon's latest code-change time. A daemon reads that file on each pass
// and starts a copy of itself when its code changed after its own start. Later unrelated updates retain that request.
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { leanBunEnv } from './lean-bun-env';

export type LiveUpdateMark = { at: number; from: string; to: string; files: number; reload: string[]; reloadAt?: Record<string, number> };
export const liveUpdateFile = (root: string) => join(root, '.practice', 'live-update.json');

export function readLiveUpdate(root: string): LiveUpdateMark | null {
    try {
        const mark = JSON.parse(readFileSync(liveUpdateFile(root), 'utf8'));
        return Number.isFinite(mark?.at) && Array.isArray(mark.reload) ? mark : null;
    } catch { return null; }
}

export function reloadDue(root: string, name: string, startedAt: number): boolean {
    const mark = readLiveUpdate(root);
    if (!mark) return false;
    const remembered = mark.reloadAt?.[name];
    return Math.max(Number.isFinite(remembered) ? remembered! : 0, mark.reload.includes(name) ? mark.at : 0) > startedAt;
}

// Keep pending reload times across updates. A daemon compares its own start time, so no acknowledgement can clear
// another daemon's request, and a successor does not repeat a reload it already incorporates. Legacy marks are kept.
export function writeLiveUpdate(root: string, mark: LiveUpdateMark): LiveUpdateMark {
    const previous = readLiveUpdate(root), reloadAt: Record<string, number> = Object.create(null);
    for (const [name, at] of Object.entries(previous?.reloadAt ?? {})) if (Number.isFinite(at) && at >= 0) reloadAt[name] = at;
    for (const [at, names] of [[previous?.at, previous?.reload], [mark.at, mark.reload]] as const) {
        if (!Number.isFinite(at)) continue;
        for (const name of names ?? []) if (typeof name === 'string') reloadAt[name] = Math.max(reloadAt[name] ?? 0, at!);
    }
    const next = { ...mark, reloadAt }, file = liveUpdateFile(root);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(next));
    return next;
}

export const daemonSpawnArgs = (args: readonly string[]): string[] =>
    args.includes('--smol') ? [...args] : ['--smol', ...args];

// Starts a detached copy of this daemon that appends to `log`. The caller releases its own lock first and exits after.
export function respawnDaemon(root: string, args: readonly string[], log: string): number | undefined {
    mkdirSync(dirname(log), { recursive: true });
    const out = openSync(log, 'a');
    try {
        const child = spawn(process.execPath, daemonSpawnArgs(args), { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', out, out], env: leanBunEnv(process.env) });
        child.unref();
        return child.pid;
    } finally { closeSync(out); }
}
