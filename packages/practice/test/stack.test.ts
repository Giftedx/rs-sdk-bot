import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { practiceDir } from '../src/paths';
import { engineCommand, MARKERS, startStack, waitReady } from '../src/stack';

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
