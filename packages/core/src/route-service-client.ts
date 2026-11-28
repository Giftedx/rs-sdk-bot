// Discovery and launch helpers for the checkout's shared route-service.ts process.
// Kept free of world/trip/danger/route-worker imports so route-query.ts and world/pathfinding.ts stay acyclic.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { leanBunEnv } from './lean-bun-env';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
export const SERVICE_FILE = join(repoRoot, '.practice', 'cache', 'route-service.json');

export type ServiceInfo = { pid: number; port: number; rev: string; dataKey: string; workers: number; started: number };

// The commit of this checkout. A service of another commit plans with other code, so a bot does not use it.
let revMemo: string | null = null;
export function clearCheckoutRevMemo(): void { revMemo = null; }
export function checkoutRev(root = repoRoot): string {
    if (root === repoRoot && revMemo !== null) return revMemo;
    const r = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    const rev = r.status === 0 ? r.stdout.trim() : '';
    if (root === repoRoot) revMemo = rev;
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
    spawn(process.execPath, [join(root, 'packages', 'core', 'src', 'route-service.ts'), '--launch'], {
        cwd: root, detached: true, windowsHide: true, stdio: 'ignore', env: routeServiceEnv(process.env),
    }).unref();
}
