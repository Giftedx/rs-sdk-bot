// Shared layout for .practice/live/ runtime state and .practice/sim/ simulation, bench, and test artifacts.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isLocalServer } from './localserver';

export const repoRoot = resolve(import.meta.dir, '..', '..', '..');

export const practiceRoot = (base = repoRoot): string => join(base, '.practice');
export const liveRoot = (base = repoRoot): string => join(base, '.practice', 'live');
export const simRoot = (base = repoRoot): string => join(base, '.practice', 'sim');

// Live runtime paths under .practice/live/
export const liveStatusDir = (base = repoRoot): string => join(liveRoot(base), 'status');
export const liveStatusArchiveDir = (base = repoRoot): string => join(liveRoot(base), 'status-archive');
export const liveLifecycleRoot = (base = repoRoot): string => join(liveRoot(base), 'session-lifecycle');
export const liveFleetDataDir = (base = repoRoot): string => join(liveRoot(base), 'fleet-data');
export const fleetStateFile = (base = repoRoot): string => join(liveRoot(base), 'fleet-state.json');
export const operatorCommandsDir = (base = repoRoot): string => join(liveRoot(base), 'operator-commands');
export const liveStopFile = (flag: string, base = repoRoot): string => join(liveRoot(base), `stop-${flag}`);

// Simulation, practice, bench, and test paths under .practice/sim/
export const simStatusDir = (base = repoRoot): string => join(simRoot(base), 'status');
export const simLifecycleRoot = (base = repoRoot): string => join(simRoot(base), 'session-lifecycle');
export const simStopFile = (flag: string, base = repoRoot): string => join(simRoot(base), 'stops', `stop-${flag}`);
export const simBotsDir = (base = repoRoot): string => join(simRoot(base), 'bots');
export const simBenchDir = (base = repoRoot): string => join(simRoot(base), 'aio-bench');
export const simProofsDir = (base = repoRoot): string => join(simRoot(base), 'proofs');
export const simRehearseDir = (base = repoRoot): string => join(simRoot(base), 'rehearse');
export const simLogsDir = (base = repoRoot): string => join(simRoot(base), 'logs');
export const simCacheDir = (base = repoRoot): string => join(simRoot(base), 'cache');

export const statusDirForServer = (server: string, base = repoRoot): string =>
    isLocalServer(server) ? simStatusDir(base) : liveStatusDir(base);

export const lifecycleRootForServer = (server: string, base = repoRoot): string =>
    isLocalServer(server) ? simLifecycleRoot(base) : liveLifecycleRoot(base);

export const statusReadDirs = (base = repoRoot): string[] => [
    liveStatusDir(base),
    join(practiceRoot(base), 'status'),
];

export const lifecycleReadRoots = (base = repoRoot): string[] => [
    liveLifecycleRoot(base),
    join(practiceRoot(base), 'session-lifecycle'),
];

export function lifecycleRootForRead(server: string, base = repoRoot): string {
    if (isLocalServer(server)) return simLifecycleRoot(base);
    const preferred = liveLifecycleRoot(base);
    const legacy = join(practiceRoot(base), 'session-lifecycle');
    return existsSync(preferred) || !existsSync(legacy) ? preferred : legacy;
}

export function resolveFleetDataDir(base = repoRoot): string {
    const preferred = liveFleetDataDir(base);
    const legacy = join(practiceRoot(base), 'fleet-data');
    return existsSync(preferred) || !existsSync(legacy) ? preferred : legacy;
}

// Backwards-compatible stop lookup across .practice/live/stop-* and root .practice/stop-*.
export function stopFilePaths(flag: string, base = repoRoot): string[] {
    const names = flag.toLowerCase() === flag ? [`stop-${flag}`] : [`stop-${flag}`, `stop-${flag.toLowerCase()}`];
    const dirs = [liveRoot(base), practiceRoot(base)];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const dir of dirs) {
        for (const name of names) {
            const full = join(dir, name);
            const key = process.platform === 'win32' ? full.toLowerCase() : full;
            if (!seen.has(key)) {
                seen.add(key);
                out.push(full);
            }
        }
    }
    return out;
}

export function findStopFile(flag: string, base = repoRoot): string | null {
    for (const candidate of stopFilePaths(flag, base)) {
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

export const hasStopFile = (flag: string, base = repoRoot): boolean => findStopFile(flag, base) !== null;

export function readStopFile(flag: string, base = repoRoot): string | undefined {
    const file = findStopFile(flag, base);
    if (!file) return undefined;
    try { return readFileSync(file, 'utf8'); } catch { return undefined; }
}

export function simStopPaths(flag: string, base = repoRoot): string[] {
    const names = flag.toLowerCase() === flag ? [`stop-${flag}`] : [`stop-${flag}`, `stop-${flag.toLowerCase()}`];
    const out: string[] = [];
    for (const dir of [join(simRoot(base), 'stops'), practiceRoot(base)]) {
        for (const name of names) out.push(join(dir, name));
    }
    return out;
}

export const hasSimStopFile = (flag: string, base = repoRoot): boolean =>
    simStopPaths(flag, base).some(p => existsSync(p));

export type StopFileEntry = {
    name: string;
    flag: string;
    path: string;
    location: 'live' | 'legacy' | 'sim';
    text: string;
};

export function listStopEntries(base = repoRoot): StopFileEntry[] {
    const roots: readonly { dir: string; location: StopFileEntry['location'] }[] = [
        { dir: liveRoot(base), location: 'live' },
        { dir: practiceRoot(base), location: 'legacy' },
        { dir: join(simRoot(base), 'stops'), location: 'sim' },
    ];
    const entries: StopFileEntry[] = [];
    for (const { dir, location } of roots) {
        if (!existsSync(dir)) continue;
        let files: string[] = [];
        try { files = readdirSync(dir); } catch { continue; }
        for (const name of files) {
            if (!name.startsWith('stop-')) continue;
            const path = join(dir, name);
            let text = '';
            try { text = readFileSync(path, 'utf8'); } catch { continue; }
            entries.push({ name, flag: name.slice('stop-'.length), path, location, text });
        }
    }
    return entries;
}

export function resolveBotEnvPath(name: string, base = repoRoot): string {
    const simPath = join(simBotsDir(base), name, 'bot.env');
    if (existsSync(simPath)) return simPath;
    return join(base, 'vendor', 'rs-sdk', 'bots', name, 'bot.env');
}
