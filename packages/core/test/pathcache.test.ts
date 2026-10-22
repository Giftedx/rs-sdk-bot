import { test, expect } from 'bun:test';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const probe = join(import.meta.dir, 'fixtures', 'pathcache-probe.ts');
async function run(file: string): Promise<{ restored: boolean; ms: number; paths: string[] }> {
    const p = Bun.spawn(['bun', probe, file], { stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(p.stdout).text();
    await p.exited;
    const line = out.split(/\r?\n/).find(l => l.startsWith('PROBE '));
    if (!line) throw new Error(`no PROBE line: ${out.slice(-400)}`);
    return JSON.parse(line.slice(6));
}

// Seen 2026-10-22: three proof runs built the snapshot at once and wrote the same file. A cut-off file must be
// rebuilt, never restored as a partial map.
test('a truncated snapshot is rebuilt, not restored', async () => {
    const { readFileSync, writeFileSync } = await import('node:fs');
    const file = join(mkdtempSync(join(tmpdir(), 'pathcache-')), 'rsmod.snap');
    const cold = await run(file);
    const full = readFileSync(file);
    writeFileSync(file, full.subarray(0, Math.floor(full.length / 2)));
    const again = await run(file);
    expect(again.restored).toBe(false);
    expect(again.paths).toEqual(cold.paths);
}, 120_000);

// Pathfinding setup takes about 14 s per process (12.8 s of it is allocating 136,704 zones in rsmod's wasm memory).
// A saved copy of that memory must give the same paths, and load much faster.
test('a restored pathfinding snapshot gives the same paths as a cold build, and loads fast', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'pathcache-')), 'rsmod.snap');
    const cold = await run(file);
    expect(cold.restored).toBe(false);
    expect(existsSync(file)).toBe(true);
    const warm = await run(file);
    expect(warm.restored).toBe(true);
    expect(warm.paths).toEqual(cold.paths);
    expect(warm.paths.every(p => p.length > 0)).toBe(true);
    expect(warm.ms).toBeLessThan(3000);
}, 120_000);
