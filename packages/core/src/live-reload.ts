// A long-lived daemon loads its code once. scripts/live-update.ts writes .practice/live-update.json when it moves the
// checkout to a newer master, with the names of the daemons whose code changed. A daemon reads that file on each pass
// and starts a copy of itself when it is named in an update newer than its own start.
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

export type LiveUpdateMark = { at: number; from: string; to: string; files: number; reload: string[] };
export const liveUpdateFile = (root: string) => join(root, '.practice', 'live-update.json');

export function readLiveUpdate(root: string): LiveUpdateMark | null {
    try {
        const mark = JSON.parse(readFileSync(liveUpdateFile(root), 'utf8'));
        return Number.isFinite(mark?.at) && Array.isArray(mark.reload) ? mark : null;
    } catch { return null; }
}

export function reloadDue(root: string, name: string, startedAt: number): boolean {
    const mark = readLiveUpdate(root);
    return !!mark && mark.at > startedAt && mark.reload.includes(name);
}

// Starts a detached copy of this daemon that appends to `log`. The caller releases its own lock first and exits after.
export function respawnDaemon(root: string, args: readonly string[], log: string): number | undefined {
    mkdirSync(dirname(log), { recursive: true });
    const out = openSync(log, 'a');
    try {
        const child = spawn(process.execPath, [...args], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', out, out], env: process.env });
        child.unref();
        return child.pid;
    } finally { closeSync(out); }
}
