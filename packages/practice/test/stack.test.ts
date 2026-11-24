import { test, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { practiceDir } from '../src/paths';
import { ISOLATED_ENGINE_ENV } from '../src/rehearse';
import { engineCommand, MARKERS, pidsFile, startStack, waitHttpReady, waitReady } from '../src/stack';

test('quest proof carries private endpoints through stack, fresh account and real CLI without changing the parent', async () => {
    const { selectQuestSweepProofEndpoints, questSweepProofAccountEnv, startQuestSweepProofStack, questSweepChildConfiguration } = await import('../src/quest-sweep-proof');
    const checked: number[] = [], samples = [0, 0.01];
    const endpoints = selectQuestSweepProofEndpoints(port => { checked.push(port); return port !== 20003; }, () => samples.shift()!);
    expect(checked).toEqual([20000, 20001, 20002, 20003, 20200, 20201, 20202, 20203]);
    expect(endpoints.ports).toEqual({ engine: 20200, gateway: 20201, management: 20202, tcp: 20203 });
    expect(endpoints.instance).toMatch(/^quest-sweep-[a-z0-9]{20}$/);
    const original = 'SERVER=localhost:8888\r\nGATEWAY_URL=ws://localhost:7780\r\nTELEMETRY=false\r\n';
    expect(questSweepProofAccountEnv(original, endpoints)).toBe(`SERVER=${endpoints.server}\r\nGATEWAY_URL=${endpoints.gateway}\r\nTELEMETRY=false\r\n`);
    expect(() => questSweepProofAccountEnv(original.replace('localhost:8888', 'rs-sdk-demo.fly.dev'), endpoints)).toThrow('new practice account required');
    const previous = Object.fromEntries(Object.keys(endpoints.env).map(k => [k, process.env[k]]));
    let stops = 0;
    const owned = { logs: { engine: '', gateway: '' }, stop: async () => { stops++; } };
    const stack = await startQuestSweepProofStack(endpoints, async opts => {
        expect(opts).toEqual({ ports: endpoints.ports, instance: endpoints.instance, tickMs: 150, readyTimeoutMs: 60000 });
        for (const [k, v] of Object.entries(endpoints.env)) expect(process.env[k]).toBe(v);
        return owned;
    });
    expect(stack).toBe(owned);
    expect(Object.fromEntries(Object.keys(endpoints.env).map(k => [k, process.env[k]]))).toEqual(previous);
    await stack.stop();
    expect(stops).toBe(1);
    await expect(startQuestSweepProofStack(endpoints, async () => { throw Error('startup refused'); })).rejects.toThrow('startup refused');
    expect(Object.fromEntries(Object.keys(endpoints.env).map(k => [k, process.env[k]]))).toEqual(previous);
    const child = questSweepChildConfiguration('qswfixture', 'sheep', endpoints, { GATEWAY_URL: 'ws://localhost:7780', WEB_MANAGEMENT_PORT: '8898', NODE_PORT: '43594' });
    expect(child.cmd).toEqual(['bun', 'scripts/aio-quester.ts', 'qswfixture', 'sweep', 'sheep']);
    expect(child.env).toMatchObject({ ...endpoints.env, GATEWAY_URL: endpoints.gateway, QUEST_SWEEP_OBSERVE_BANK: '', RANDOM_EVENTS: '0' });
    expect(child.env.GE_DATABASE).toBe(`data/market-${endpoints.instance}.sqlite`);
    expect(child.windowsHide).toBe(true);
    let attempts = 0;
    expect(() => selectQuestSweepProofEndpoints(() => { attempts++; return false; }, () => 0)).toThrow('owned practice ports unavailable');
    expect(attempts).toBe(100);
}, 10000);

test('default engine launch has no preload; a diagnostic preload is explicit and keeps the marker', () => {
    expect(engineCommand({}, 8888)).toEqual({ cmd: ['bun', MARKERS.engine], env: { NODE_TICKRATE: '150', NODE_XPRATE: '25', WEB_PORT: '8888', ACTION_TRACE_FILE: join(practiceDir(), 'action-trace.log') } });
    const module = join(import.meta.dir, '../src/shark-fishing-diagnostic.ts');
    const r = engineCommand({ tickMs: 150, xpRate: 25, enginePreload: { module, env: { SHARK_FISHING_DIAGNOSTIC_OUT: 'x' } } }, 8888);
    expect(r.cmd).toEqual(['bun', '--preload', module, MARKERS.engine]);
    expect(r.env.SHARK_FISHING_DIAGNOSTIC_OUT).toBe('x');
    expect(() => engineCommand({ enginePreload: { module: 'relative.ts', env: {} } }, 8888)).toThrow(/not found/);
    expect(() => engineCommand({ enginePreload: { module, env: { NODE_TICKRATE: '1' } } }, 8888)).toThrow(/cannot replace/);
});

test('startStack fails fast naming the busy port', async () => {
    const holder = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const t0 = Date.now();
    await expect(startStack({ ports: { engine: holder.port, gateway: 1 } })).rejects.toThrow(`port ${holder.port} in use`);
    expect(Date.now() - t0).toBeLessThan(2000);
    holder.stop(true);
});

test('waitReady reports a child that exits before its ready line, with log tail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stack-'));
    const log = join(dir, 'engine.log');
    writeFileSync(log, '');
    const proc = Bun.spawn(['bun', '-e', 'console.log("boot failed: no data/pack"); process.exit(3)'], {
        stdout: Bun.file(log),
        stderr: Bun.file(log),
    });
    await expect(waitReady(proc, 'engine', log, 10_000)).rejects.toThrow(/engine exited with code 3[\s\S]*boot failed/);
});

test('a lockstep engine on Windows preloads fine timers by default unless SIM_FINE_TIMERS=0; other engines and platforms do not', () => {
    const timers = join(import.meta.dir, '../../core/src/timer-resolution.ts');
    expect(engineCommand({ lockstep: { seed: 7 } }, 8888, 'win32', undefined).cmd).toEqual(['bun', '--preload', timers, MARKERS.engine]);
    expect(engineCommand({ lockstep: { seed: 7 } }, 8888, 'win32', '1').cmd).toEqual(['bun', '--preload', timers, MARKERS.engine]);
    expect(engineCommand({ lockstep: { seed: 7 } }, 8888, 'win32', '0').cmd).toEqual(['bun', MARKERS.engine]);
    expect(engineCommand({ lockstep: { seed: 7 } }, 8888, 'linux', undefined).cmd).toEqual(['bun', MARKERS.engine]);
    expect(engineCommand({ lockstep: { seed: 7 } }, 8888, 'linux', '1').cmd).toEqual(['bun', MARKERS.engine]);
    expect(engineCommand({}, 8888, 'win32', undefined).cmd).toEqual(['bun', MARKERS.engine]);
    expect(engineCommand({}, 8888, 'win32', '1').cmd).toEqual(['bun', MARKERS.engine]);
    const module = join(import.meta.dir, '../src/shark-fishing-diagnostic.ts');
    expect(engineCommand({ lockstep: {}, enginePreload: { module, env: {} } }, 8888, 'win32', undefined).cmd).toEqual(['bun', '--preload', timers, '--preload', module, MARKERS.engine]);
});

test('waitHttpReady retries ConnectionRefused until delayed HTTP server serves 200', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stack-http-'));
    const log = join(dir, 'engine.log');
    writeFileSync(log, 'World ready\n');
    const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    const proc = Bun.spawn(['bun', '-e', 'setTimeout(() => {}, 10000)'], { stdout: Bun.file(log), stderr: Bun.file(log) });
    let server: ReturnType<typeof Bun.serve> | undefined;
    const starter = setTimeout(() => {
        server = Bun.serve({
            hostname: '127.0.0.1',
            port,
            fetch(req) {
                return new URL(req.url).pathname === '/crc' ? new Response('/crc') : new Response('not found', { status: 404 });
            },
        });
    }, 200);
    try {
        await expect(waitHttpReady(proc, `http://127.0.0.1:${port}/crc`, log, 5000)).resolves.toBeUndefined();
    } finally {
        clearTimeout(starter);
        server?.stop(true);
        proc.kill();
        await proc.exited;
    }
});

test('waitHttpReady fails fast with exit code and log tail if process exits early', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stack-http-fail-'));
    const log = join(dir, 'engine.log');
    writeFileSync(log, '');
    const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    const proc = Bun.spawn(['bun', '-e', 'console.log("web transport aborted"); process.exit(4)'], { stdout: Bun.file(log), stderr: Bun.file(log) });
    await expect(waitHttpReady(proc, `http://127.0.0.1:${port}/crc`, log, 5000)).rejects.toThrow(/engine exited with code 4[\s\S]*web transport aborted/);
});

test('ISOLATED_ENGINE_ENV disables live reload and startup builds so practice trades are never interrupted', () => {
    expect(ISOLATED_ENGINE_ENV.BUILD_LIVE_RELOAD).toBe('false');
    expect(ISOLATED_ENGINE_ENV.BUILD_STARTUP).toBe('false');
});

test('startStack removes its pids file when the engine exits before becoming ready', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stack-fail-'));
    const preload = join(dir, 'abort.ts');
    writeFileSync(preload, 'console.log("aborted boot"); process.exit(2);\n');
    const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    const instance = `test-fail-${process.pid}`;
    try {
        await expect(startStack({
            ports: { engine: port, gateway: port + 1 },
            gateway: false,
            instance,
            enginePreload: { module: preload, env: {} },
            readyTimeoutMs: 5000,
        })).rejects.toThrow(/exited with code 2/);
        expect(existsSync(pidsFile(instance))).toBe(false);
    } finally {
        rmSync(pidsFile(instance), { force: true });
        rmSync(join(practiceDir(), 'logs', `engine-${instance}.log`), { force: true });
        rmSync(dir, { recursive: true, force: true });
    }
});
