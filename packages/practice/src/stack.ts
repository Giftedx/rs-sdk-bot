import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Subprocess } from 'bun';
import { practiceDir, rsSdkRoot } from './paths';
import { canBind, portInUse } from './ports';
import { killTree, safeKill } from './proc';
import { isReady, type Service } from './ready';

export interface Stack {
    stop(): Promise<void>;
    logs: Record<'engine' | 'gateway', string>;
}

// Proof tick. Measured on scripts/generated/thieveguards.ts, 3 runs each: 150 ms gives the same tries
// (114-121 vs 118-124) and XP range as 300 ms, in 68 s instead of 108 s per run. 50 ms does not: every run read
// the same 46209 XP, so the bot loses ticks at that speed.
export const PROOF_TICK_MS = 150;

export interface StackOptions {
    tickMs?: number;
    xpRate?: number;
    ports?: { engine: number; gateway: number };
    readyTimeoutMs?: number;
    // Practice diagnostics only: `bun --preload <module>` for the engine process. Default launches have none.
    enginePreload?: { module: string; env: Record<string, string> };
    // A second stack beside the shared one: its own pids-<instance>.json, <service>-<instance>.log and stop.
    instance?: string;
}

// The engine command line keeps MARKERS.engine, so safeKill still identifies the server.
export function engineCommand(opts: StackOptions, port: number): { cmd: string[]; env: Record<string, string> } {
    const env: Record<string, string> = {
        NODE_TICKRATE: String(opts.tickMs ?? PROOF_TICK_MS),
        NODE_XPRATE: String(opts.xpRate ?? 25),
        WEB_PORT: String(port),
        // The coverage scoreboard reads this trace (patches/rs-sdk.md item 8).
        ACTION_TRACE_FILE: join(practiceDir(), 'action-trace.log'),
    };
    const pre = opts.enginePreload;
    if (!pre) return { cmd: ['bun', MARKERS.engine], env };
    if (!isAbsolute(pre.module) || !existsSync(pre.module)) throw new Error(`engine preload not found: ${pre.module}`);
    for (const key of Object.keys(pre.env)) if (key in env) throw new Error(`engine preload cannot replace ${key}`);
    return { cmd: ['bun', '--preload', pre.module, MARKERS.engine], env: { ...env, ...pre.env } };
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

function suffix(instance?: string): string {
    if (instance === undefined) return '';
    if (!/^[a-z0-9-]{1,32}$/.test(instance)) throw new Error(`invalid stack instance ${instance}`);
    return `-${instance}`;
}

export function pidsFile(instance?: string): string {
    return join(practiceDir(), `pids${suffix(instance)}.json`);
}

export async function startStack(opts: StackOptions = {}): Promise<Stack> {
    const ports = opts.ports ?? DEFAULT_PORTS;
    for (const port of [ports.engine, ports.gateway]) {
        if (!canBind(port)) throw new Error(`port ${port} in use`);
    }
    const root = rsSdkRoot();
    const tag = suffix(opts.instance);
    const logs = {
        engine: join(practiceDir(), 'logs', `engine${tag}.log`),
        gateway: join(practiceDir(), 'logs', `gateway${tag}.log`),
    };
    const timeout = opts.readyTimeoutMs ?? 180_000;
    const spawn = (cwd: string, cmd: string[], env: Record<string, string>, log: string) => {
        writeFileSync(log, '');
        return Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: Bun.file(log), stderr: Bun.file(log) ,windowsHide:true});
    };

    // Spawn the server files directly (package.json `quickstart` and `gateway` are plain `bun run <file>`),
    // so the saved PID is the server itself, not a wrapper whose child could outlive it.
    const launch = engineCommand(opts, ports.engine);
    const engine = spawn(join(root, 'server', 'engine'), launch.cmd, launch.env, logs.engine);
    const saved: Saved = { engine: { pid: engine.pid, marker: MARKERS.engine } };
    writeFileSync(pidsFile(opts.instance), JSON.stringify(saved));
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
    writeFileSync(pidsFile(opts.instance), JSON.stringify(saved));
    try {
        await waitReady(gateway, 'gateway', logs.gateway, timeout);
    } catch (e) {
        await killTree(gateway.pid);
        await killTree(engine.pid);
        throw e;
    }

    return { logs, stop: () => stopStack(opts.instance) };
}

export async function stopStack(instance?: string): Promise<void> {
    const file = pidsFile(instance);
    if (!existsSync(file)) return;
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Saved;
    for (const [name, p] of Object.entries(saved)) {
        if (!(await safeKill(p.pid, p.marker))) console.warn(`stop: ${name} pid ${p.pid} is not running ${p.marker}; left alone`);
    }
    rmSync(file);
}
