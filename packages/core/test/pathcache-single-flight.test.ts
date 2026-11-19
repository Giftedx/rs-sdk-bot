import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSnapshotBuild, writePathfindingSnapshot } from '../src/pathcache';

const dir = () => mkdtempSync(join(tmpdir(), 'pathcache-flight-'));
const snapshot = (file: string, key: string) => writePathfindingSnapshot(file, key, new Uint8Array(65536).fill(1));

test('the first caller builds under a lock, a second waits, and it sees the snapshot when the builder has written it', async () => {
    const file = join(dir(), 'world.snap');
    const first = await acquireSnapshotBuild(file, 'k');
    expect(first.state).toBe('build');
    expect(existsSync(`${file}.lock`)).toBe(true);
    const second = acquireSnapshotBuild(file, 'k', { pollMs: 20, waitMs: 5000 });
    setTimeout(() => { snapshot(file, 'k'); if (first.state === 'build') first.release(); }, 150);
    expect((await second).state).toBe('ready');
    expect(existsSync(`${file}.lock`)).toBe(false);
});

test('a snapshot of another key is not ready: the caller builds', async () => {
    const file = join(dir(), 'world.snap');
    snapshot(file, 'old');
    const got = await acquireSnapshotBuild(file, 'new', { pollMs: 20, waitMs: 1000 });
    expect(got.state).toBe('build');
    if (got.state === 'build') got.release();
});

test('a lock of a dead owner, or an old lock, is removed; a live young one makes the waiter time out and build itself', async () => {
    const file = join(dir(), 'world.snap');
    writeFileSync(`${file}.lock`, JSON.stringify({ pid: 999999, at: Date.now() }));
    const afterDead = await acquireSnapshotBuild(file, 'k', { pollMs: 20, waitMs: 2000, alive: () => false });
    expect(afterDead.state).toBe('build');
    if (afterDead.state === 'build') afterDead.release();

    writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, at: Date.now() - 10_000 }));
    const afterOld = await acquireSnapshotBuild(file, 'k', { pollMs: 20, waitMs: 2000, staleMs: 5000, alive: () => true });
    expect(afterOld.state).toBe('build');
    if (afterOld.state === 'build') afterOld.release();

    writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, at: Date.now() }));
    const started = Date.now();
    const waited = await acquireSnapshotBuild(file, 'k', { pollMs: 20, waitMs: 300, alive: () => true });
    expect(waited.state).toBe('timeout');
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
});

test('a lock whose file is not written yet is not stale, and a release removes only its own lock', async () => {
    const file = join(dir(), 'world.snap');
    writeFileSync(`${file}.lock`, '');
    expect((await acquireSnapshotBuild(file, 'k', { pollMs: 20, waitMs: 200 })).state).toBe('timeout');
    // Another process took the lock after a stale removal: the first builder's release leaves it.
    const second = join(dir(), 'second.snap');
    const got = await acquireSnapshotBuild(second, 'k');
    expect(got.state).toBe('build');
    if (got.state !== 'build') return;
    writeFileSync(`${second}.lock`, JSON.stringify({ pid: process.pid + 1, at: Date.now() }));
    got.release();
    expect(existsSync(`${second}.lock`)).toBe(true);
});

// The real cold path: three processes start together on an empty cache. One builds the grid (rsmod allocates 136,704
// zones and logs it); the others restore the snapshot that it writes.
test('three processes that start together build the grid once', async () => {
    const probe = join(import.meta.dir, 'fixtures', 'pathcache-probe.ts');
    const file = join(dir(), 'rsmod.snap');
    const run = () => Bun.spawn(['bun', probe, file], { stdout: 'pipe', stderr: 'pipe' });
    const children = [run(), run(), run()];
    const results = await Promise.all(children.map(async child => {
        const out = await new Response(child.stdout).text();
        await child.exited;
        const line = out.split(/\r?\n/).find(l => l.startsWith('PROBE '));
        if (!line) throw new Error(`no PROBE line: ${out.slice(-400)}`);
        return { ...JSON.parse(line.slice(6)) as { restored: boolean; paths: string[] }, built: /136704 zones/.test(out) };
    }));
    expect(results.filter(r => r.built)).toHaveLength(1);
    expect(results.filter(r => r.restored)).toHaveLength(2);
    expect(results[1]!.paths).toEqual(results[0]!.paths);
    expect(results[2]!.paths).toEqual(results[0]!.paths);
    expect(existsSync(`${file}.lock`)).toBe(false);
}, 240_000);
