// Discovery and launch helpers for the checkout's shared route-service.ts process.
// Kept free of world/trip/danger/route-worker imports so route-query.ts and world/pathfinding.ts stay acyclic.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { leanBunEnv } from './lean-bun-env';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
export const SERVICE_FILE = join(repoRoot, '.practice', 'cache', 'route-service.json');

export type ServiceInfo = { pid: number; port: number; rev: string; dataKey: string; workers: number; started: number };

const SHA40_RE = /^[0-9a-f]{40}$/i;

// Fast direct .git HEAD resolution without spawning git: supports normal checkouts, worktrees, and packed-refs.
export function readCheckoutRevDirect(root: string): string | null {
    try {
        const dotGit = join(root, '.git');
        if (!existsSync(dotGit)) return null;
        let gitDir = dotGit;
        if (statSync(dotGit).isFile()) {
            const ptr = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
            if (!ptr) return null;
            gitDir = resolve(root, ptr);
        }
        const headText = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
        if (SHA40_RE.test(headText)) return headText.toLowerCase();
        const refMatch = headText.match(/^ref:\s*(\S+)$/);
        if (!refMatch) return null;
        const refName = refMatch[1]!;
        let commonDir = gitDir;
        const commonPtr = join(gitDir, 'commondir');
        if (existsSync(commonPtr)) {
            const rel = readFileSync(commonPtr, 'utf8').trim();
            if (rel) commonDir = resolve(gitDir, rel);
        }
        for (const base of commonDir === gitDir ? [gitDir] : [gitDir, commonDir]) {
            const loose = join(base, ...refName.split('/'));
            if (existsSync(loose)) {
                const sha = readFileSync(loose, 'utf8').trim();
                if (SHA40_RE.test(sha)) return sha.toLowerCase();
            }
        }
        const packed = join(commonDir, 'packed-refs');
        if (existsSync(packed)) {
            for (const line of readFileSync(packed, 'utf8').split(/\r?\n/)) {
                if (!line || line[0] === '#' || line[0] === '^') continue;
                const sp = line.indexOf(' ');
                if (sp === 40 && line.slice(sp + 1).trim() === refName) {
                    const sha = line.slice(0, 40);
                    if (SHA40_RE.test(sha)) return sha.toLowerCase();
                }
            }
        }
        return null;
    } catch {
        return null;
    }
}

// The commit of this checkout. A service of another commit plans with other code, so a bot does not use it.
const revMemoByRoot = new Map<string, string>();
export function clearCheckoutRevMemo(): void { revMemoByRoot.clear(); }
export function checkoutRev(root = repoRoot): string {
    const key = resolve(root);
    const cached = revMemoByRoot.get(key);
    if (cached !== undefined) return cached;
    const direct = readCheckoutRevDirect(root);
    if (direct !== null) {
        revMemoByRoot.set(key, direct);
        return direct;
    }
    const r = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 3_000 });
    const rev = r.status === 0 ? r.stdout.trim() : '';
    revMemoByRoot.set(key, rev);
    return rev;
}

export const pidAlive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException)?.code === 'EPERM'; }
};

export function readServiceInfo(file = SERVICE_FILE): ServiceInfo | null {
    try {
        const v = JSON.parse(readFileSync(file, 'utf8')) as ServiceInfo;
        return Number.isInteger(v?.pid) && Number.isInteger(v?.port) && typeof v.rev === 'string' && typeof v.dataKey === 'string' ? v : null;
    } catch { return null; }
}

// The info of a live service that plans with this process's code and route data, or null.
export function usableService(info: ServiceInfo | null, rev: string, dataKey: string, alive = pidAlive): ServiceInfo | null {
    return info && rev && info.rev === rev && info.dataKey === dataKey && alive(info.pid) ? info : null;
}

// Route service runs lean GC/WASM thread settings while keeping DFG JIT enabled and avoiding a low bot RAM cap.
export function routeServiceEnv(env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
    const out = leanBunEnv({ ...env, BUN_JSC_useDFGJIT: '1' });
    delete out.BUN_JSC_forceRAMSize;
    return out;
}

// Starts one detached service through a launcher that exits at once. The service's parent is then a dead process, so
// a tree kill of the bot that asked for it (taskkill /T) does not stop the service that other bots use.
export function launchService(root = repoRoot): void {
    spawn(process.execPath, ['--smol', join(root, 'packages', 'core', 'src', 'route-service.ts'), '--launch'], {
        cwd: root, detached: true, windowsHide: true, stdio: 'ignore', env: routeServiceEnv(process.env),
    }).unref();
}
