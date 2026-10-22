import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { practiceDir, rsSdkRoot } from './paths';
import { portInUse } from './ports';
import { isReady, type Service } from './ready';

export interface Stack {
    stop(): Promise<void>;
    logs: Record<'engine' | 'gateway', string>;
}

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

// On Windows, killing the `bun run` parent leaves the real server running, so kill the whole tree.
export async function killTree(pid: number): Promise<void> {
    if (process.platform === 'win32') {
        Bun.spawnSync(['taskkill', '/PID', String(pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore' });
    } else {
        try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
    }
}

function pidsFile(): string {
    return join(practiceDir(), 'pids.json');
}

export async function startStack(opts: StackOptions = {}): Promise<Stack> {
    const ports = opts.ports ?? DEFAULT_PORTS;
    for (const port of [ports.engine, ports.gateway]) {
        if (await portInUse(port)) throw new Error(`port ${port} in use`);
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

    const engine = spawn(join(root, 'server', 'engine'), ['bun', 'run', 'quickstart'], {
        NODE_TICKRATE: String(opts.tickMs ?? 300),
        NODE_XPRATE: String(opts.xpRate ?? 25),
        WEB_PORT: String(ports.engine),
    }, logs.engine);
    writeFileSync(pidsFile(), JSON.stringify({ engine: engine.pid }));
    try {
        await waitReady(engine, 'engine', logs.engine, timeout);
    } catch (e) {
        await killTree(engine.pid);
        throw e;
    }

    const gateway = spawn(join(root, 'server', 'gateway'), ['bun', 'run', 'gateway'], {
        GATEWAY_HOSTNAME: '127.0.0.1',
        AGENT_PORT: String(ports.gateway),
    }, logs.gateway);
    writeFileSync(pidsFile(), JSON.stringify({ engine: engine.pid, gateway: gateway.pid }));
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
    const pids = JSON.parse(readFileSync(pidsFile(), 'utf8')) as Record<string, number>;
    for (const pid of Object.values(pids)) await killTree(pid);
    rmSync(pidsFile());
}
