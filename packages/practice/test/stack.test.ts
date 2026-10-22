import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStack, waitReady } from '../src/stack';

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
