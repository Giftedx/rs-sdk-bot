import { existsSync, readFileSync } from 'node:fs';

// The command line of a live process, or null. Used to check that a saved PID is still our process:
// Windows reuses PIDs, so a stale pids.json could otherwise point at an unrelated program.
export function commandLine(pid: number): string | null {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (process.platform === 'win32') {
        const r = Bun.spawnSync(['powershell', '-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { stdout: 'pipe', stderr: 'ignore' ,windowsHide:true});
        const out = r.stdout.toString().trim();
        return out.length > 0 ? out : null;
    }
    if (existsSync(`/proc/${pid}/cmdline`)) return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim() || null;
    const r = Bun.spawnSync(['ps', '-o', 'command=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' ,windowsHide:true});
    return r.stdout.toString().trim() || null;
}

// Uncached: every kill path (safeKill, safeKillOne, killTree callers) authorizes with this, and a reused PID must
// never pass on an old command line.
export function processMatches(pid: number, marker: string): boolean {
    return commandLine(pid)?.includes(marker) ?? false;
}

// Observation only, never authorization to kill. One PowerShell start per lookup costs about 1.4 s on this PC, and a
// recovery authority check asks for the same two command lines at permit issue and again at child binding a few
// seconds later, so a command line is reused for a short time.
const recentCommandLines = new Map<number, { at: number; line: string | null }>();
export const PROCESS_MATCH_CACHE_MS = 3000;
export function processMatchesRecent(pid: number, marker: string, now = Date.now()): boolean {
    const hit = recentCommandLines.get(pid);
    const line = hit && now - hit.at < PROCESS_MATCH_CACHE_MS ? hit.line : commandLine(pid);
    if (!hit || now - hit.at >= PROCESS_MATCH_CACHE_MS) recentCommandLines.set(pid, { at: now, line });
    return line?.includes(marker) ?? false;
}

// The start time (Unix ms) of each listed PID that runs, from one read of the process table. A process that started
// after a PID was saved is not the saved process. A PID that does not run has no entry. null: the read failed or the
// platform has no reader, so the result proves nothing. One PowerShell start: call it at a slow interval only.
export function processStartTimes(pids: readonly number[]): Map<number, number> | null {
    const ids = [...new Set(pids.filter(p => Number.isSafeInteger(p) && p > 0))], out = new Map<number, number>();
    if (!ids.length) return out;
    if (process.platform !== 'win32') return null;
    // The last line proves that the query ran to its end: a failed query stops the script before it.
    const script = `$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Filter "${ids.map(p => `ProcessId=${p}`).join(' OR ')}" | ForEach-Object { if ($_.CreationDate) { '{0}|{1}' -f $_.ProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } }; 'read'`;
    const r = Bun.spawnSync(['powershell', '-NoProfile', '-Command', script], { stdout: 'pipe', stderr: 'ignore', windowsHide: true });
    const lines = r.stdout.toString().trim().split(/\r?\n/);
    if (r.exitCode !== 0 || lines.pop() !== 'read') return null;
    for (const line of lines) {
        const [pid, at] = line.split('|').map(Number);
        if (Number.isSafeInteger(pid) && Number.isFinite(at)) out.set(pid!, at!);
    }
    return out;
}

// The system gives the id of an ended process to a later process. A record that a process wrote at `savedAt`, about
// itself or about a child that it started, names a process that started before `savedAt`. So a process that holds the
// id and started after `savedAt` is a different process. The slack covers a clock step between the two times.
// `starts` is one processStartTimes read: null, an id that it does not list, or a record with no time proves nothing.
export const PID_START_SLACK_MS = 5000;
export function laterProcessHolds(pid: number, savedAt: number, starts: ReadonlyMap<number, number> | null): boolean {
    const start = starts?.get(pid);
    return start !== undefined && Number.isFinite(savedAt) && start > savedAt + PID_START_SLACK_MS;
}

export async function killTree(pid: number): Promise<void> {
    if (process.platform === 'win32') {
        Bun.spawnSync(['taskkill', '/PID', String(pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore' ,windowsHide:true});
    } else {
        try { process.kill(pid, 'SIGTERM'); } catch {}
    }
}

// Kills the tree only if the PID still runs a command containing `marker`. Returns whether it killed.
// The matching process alone, not its children: a controller whose detached runs must outlive it.
export async function safeKillOne(pid: number, marker: string): Promise<boolean> {
    if (!processMatches(pid, marker)) return false;
    if (process.platform === 'win32') Bun.spawnSync(['taskkill', '/PID', String(pid), '/F'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true });
    else { try { process.kill(pid, 'SIGTERM'); } catch {} }
    for (let i = 0; i < 40 && commandLine(pid) !== null; i++) await Bun.sleep(100);
    return true;
}
export async function safeKill(pid: number, marker: string): Promise<boolean> {
    if (!processMatches(pid, marker)) return false;
    await killTree(pid);
    for (let i = 0; i < 40 && commandLine(pid) !== null; i++) await Bun.sleep(100);
    return true;
}
