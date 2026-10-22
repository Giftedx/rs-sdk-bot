import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { practiceDir, rsSdkRoot } from './paths';
import { killTree, waitReady } from './stack';

export interface LiteHandle {
    name: string;
    pid: number;
    stop(): Promise<void>;
}

function liteFile(): string {
    return join(practiceDir(), 'lite.json');
}

function readLite(): Record<string, number> {
    return existsSync(liteFile()) ? JSON.parse(readFileSync(liteFile(), 'utf8')) : {};
}

function writeLite(map: Record<string, number>): void {
    writeFileSync(liteFile(), JSON.stringify(map));
}

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

export function isLiteRunning(name: string): boolean {
    const pid = readLite()[name];
    return pid !== undefined && alive(pid);
}

export async function stopLite(name: string): Promise<void> {
    const map = readLite();
    const pid = map[name];
    if (pid !== undefined) await killTree(pid);
    delete map[name];
    writeLite(map);
}

export async function startLite(name: string, timeoutMs = 120_000): Promise<LiteHandle> {
    const log = join(practiceDir(), 'logs', `lite-${name}.log`);
    writeFileSync(log, '');
    const proc = Bun.spawn(['bun', 'src/lite/runner.ts', name], {
        cwd: join(rsSdkRoot(), 'server', 'webclient'),
        stdout: Bun.file(log),
        stderr: Bun.file(log),
    });
    writeLite({ ...readLite(), [name]: proc.pid });
    try {
        await waitReady(proc, 'lite', log, timeoutMs);
    } catch (e) {
        await stopLite(name);
        throw e;
    }
    return { name, pid: proc.pid, stop: () => stopLite(name) };
}
