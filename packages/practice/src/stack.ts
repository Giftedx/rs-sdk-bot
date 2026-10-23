import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { practiceDir, rsSdkRoot } from './paths';
import { canBind, portInUse } from './ports';
import { killTree, safeKill } from './proc';
import { isReady, type Service } from './ready';

export interface Stack {
    stop(): Promise<void>;
    logs: Record<'engine' | 'gateway', string>;
}

// Proof tick. Measured 2026-10-22 on scripts/generated/thieveguards.ts, 3 runs each: 150 ms gives the same tries
// (114-121 vs 118-124) and XP range as 300 ms, in 68 s instead of 108 s per run. 50 ms does not: every run read
// the same 46209 XP, so the bot loses ticks at that speed.
export const PROOF_TICK_MS = 150;

export interface StackOptions {
    tickMs?: number;
    xpRate?: number;
    ports?: { engine: number; gateway: number };
    readyTimeoutMs?: number;
}

const DEFAULT_PORTS = { engine: 8888, gateway: 7780 };

function tail(file: string, lines = 20): string {
    if (!existsSync(file)) return '';
    return readFileSync(file, 'utf8').split(/\r?\n/).slice(-lines - 1).join('\n');
}

// Resolves when the log shows the service's ready line. Rejects if the child exits first or the timeout passes.
export async function waitReady(proc: Subprocess, service: Service, logFile: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const text = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
        if (text.split(/\r?\n/).some(l => isReady(service, l))) return;
        if (proc.exitCode !== null) {
            throw new Error(`${service} exited with code ${proc.exitCode}\n${tail(logFile)}`);
        }
        await Bun.sleep(250);
    }
    throw new Error(`${service} not ready after ${timeoutMs} ms\n${tail(logFile)}`);
}

export { killTree } from './proc';

// Saved with each PID so a stale pids.json never kills an unrelated process (Windows reuses PIDs).
export const MARKERS = { engine: 'src/app.ts', gateway: 'gateway.ts' } as const;
type Saved = Record<string, { pid: number; marker: string }>;

function pidsFile(): string {
    return join(practiceDir(), 'pids.json');
}

export async function startStack(opts: StackOptions = {}): Promise<Stack> {
    const ports = opts.ports ?? DEFAULT_PORTS;
    for (const port of [ports.engine, ports.gateway]) {
        if (!canBind(port)) throw new Error(`port ${port} in use`);
    }
    const root = rsSdkRoot();
    const logs = {
        engine: join(practiceDir(), 'logs', 'engine.log'),
        gateway: join(practiceDir(), 'logs', 'gateway.log'),
    };
    const timeout = opts.readyTimeoutMs ?? 180_000;
    const spawn = (cwd: string, cmd: string[], env: Record<string, string>, log: string) => {
        writeFileSync(log, '');
        return Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: Bun.file(log), stderr: Bun.file(log) });
    };

    // Spawn the server files directly (package.json `quickstart` and `gateway` are plain `bun run <file>`),
    // so the saved PID is the server itself, not a wrapper whose child could outlive it.
    const engine = spawn(join(root, 'server', 'engine'), ['bun', MARKERS.engine], {
        NODE_TICKRATE: String(opts.tickMs ?? PROOF_TICK_MS),
        NODE_XPRATE: String(opts.xpRate ?? 25),
        WEB_PORT: String(ports.engine),
    }, logs.engine);
    const saved: Saved = { engine: { pid: engine.pid, marker: MARKERS.engine } };
    writeFileSync(pidsFile(), JSON.stringify(saved));
    try {
        await waitReady(engine, 'engine', logs.engine, timeout);
    } catch (e) {
        await killTree(engine.pid);
        throw e;
    }

    const gateway = spawn(join(root, 'server', 'gateway'), ['bun', MARKERS.gateway], {
        GATEWAY_HOSTNAME: '127.0.0.1',
        AGENT_PORT: String(ports.gateway),
    }, logs.gateway);
    saved.gateway = { pid: gateway.pid, marker: MARKERS.gateway };
    writeFileSync(pidsFile(), JSON.stringify(saved));
    try {
        await waitReady(gateway, 'gateway', logs.gateway, timeout);
    } catch (e) {
        await killTree(gateway.pid);
        await killTree(engine.pid);
        throw e;
    }

    return { logs, stop: stopStack };
}

export async function stopStack(): Promise<void> {
    if (!existsSync(pidsFile())) return;
    const saved = JSON.parse(readFileSync(pidsFile(), 'utf8')) as Saved;
    for (const [name, p] of Object.entries(saved)) {
        if (!(await safeKill(p.pid, p.marker))) console.warn(`stop: ${name} pid ${p.pid} is not running ${p.marker}; left alone`);
    }
    rmSync(pidsFile());
}
