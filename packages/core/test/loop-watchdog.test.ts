import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'loop-watchdog-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const child = join(import.meta.dir, 'fixtures', 'loop-stall-child.ts');

const run = async (env: Record<string, string>) => {
    const file = join(dir, `${Object.values(env).join('-')}.json`), t0 = performance.now();
    const p = Bun.spawn([process.execPath, 'run', child, file], { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return { out, code, ms: performance.now() - t0, status: JSON.parse(readFileSync(file, 'utf8')) };
};

test('a blocked event loop is reported with its last log line, marked stalled in the status file, and ends the process', async () => {
    // The loop blocks for 30 s; the watchdog ends it after 1.5 s with no beat.
    const r = await run({ STALL_MS: '1500', BLOCK_MS: '30000' });
    expect(r.out).toContain('READY');
    expect(r.out).not.toContain('UNBLOCKED');
    expect(r.out).toMatch(/RESULT fail stalled: event loop blocked for \d+ s; last log line: WALK fixture phase before the block/);
    expect(r.code).not.toBe(0);
    expect(r.ms).toBeLessThan(20_000);
    expect(r.status.result).toStartWith('fail stalled');
    expect(r.status.stalled.phase).toBe('WALK fixture phase before the block');
}, 60_000);

test('a loop that blocks for less than the stall bound is left alone', async () => {
    const r = await run({ STALL_MS: '5000', BLOCK_MS: '1000' });
    expect(r.out).toContain('UNBLOCKED');
    expect(r.out).not.toContain('RESULT fail stalled');
    expect(r.code).toBe(0);
    expect(r.status.result).toBe('');
}, 60_000);
