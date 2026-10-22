import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { practiceDir, rsSdkRoot } from './paths';
import { killTree, processMatches, safeKill } from './proc';
import { waitReady } from './stack';

export interface LiteHandle {
    name: string;
    pid: number;
    stop(): Promise<void>;
}

export const LITE_MARKER = 'src/lite/runner.ts';
type Saved = Record<string, { pid: number; marker: string }>;

function liteFile(): string {
    return join(practiceDir(), 'lite.json');
}

function readLite(): Saved {
    return existsSync(liteFile()) ? JSON.parse(readFileSync(liteFile(), 'utf8')) : {};
}

function writeLite(map: Saved): void {
    writeFileSync(liteFile(), JSON.stringify(map));
}

// True only if the saved PID still runs our lite runner (Windows reuses PIDs).
export function isLiteRunning(name: string): boolean {
    const p = readLite()[name];
    return p !== undefined && processMatches(p.pid, p.marker);
}

export async function stopLite(name: string): Promise<void> {
    const map = readLite();
    const p = map[name];
    if (p !== undefined) await safeKill(p.pid, p.marker);
    delete map[name];
    writeLite(map);
}

export async function startLite(name: string, timeoutMs = 120_000): Promise<LiteHandle> {
    const log = join(practiceDir(), 'logs', `lite-${name}.log`);
    writeFileSync(log, '');
    const proc = Bun.spawn(['bun', LITE_MARKER, name], {
        cwd: join(rsSdkRoot(), 'server', 'webclient'),
        stdout: Bun.file(log),
        stderr: Bun.file(log),
    });
    writeLite({ ...readLite(), [name]: { pid: proc.pid, marker: LITE_MARKER } });
    try {
        await waitReady(proc, 'lite', log, timeoutMs);
    } catch (e) {
        await killTree(proc.pid);
        const map = readLite();
        delete map[name];
        writeLite(map);
        throw e;
    }
    return { name, pid: proc.pid, stop: () => stopLite(name) };
}
