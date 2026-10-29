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

export function processMatches(pid: number, marker: string): boolean {
    return commandLine(pid)?.includes(marker) ?? false;
}

export async function killTree(pid: number): Promise<void> {
    if (process.platform === 'win32') {
        Bun.spawnSync(['taskkill', '/PID', String(pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore' ,windowsHide:true});
    } else {
        try { process.kill(pid, 'SIGTERM'); } catch {}
    }
}

// Kills the tree only if the PID still runs a command containing `marker`. Returns whether it killed.
export async function safeKill(pid: number, marker: string): Promise<boolean> {
    if (!processMatches(pid, marker)) return false;
    await killTree(pid);
    for (let i = 0; i < 40 && commandLine(pid) !== null; i++) await Bun.sleep(100);
    return true;
}
