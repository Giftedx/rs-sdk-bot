import { expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

test('the status row is written on the clock while no game tick arrives, so the release gate still sees a live peer', async () => {
    process.env.STATUS_HEARTBEAT_MS = '20';
    process.env.WORKER_RELEASE = 'a'.repeat(64);
    const { startStatus } = await import('../src/status');
    const { assertCompatibleWorkers } = await import('../src/worker-release');
    const name = `StatusBeat${process.pid}`;
    const file = resolve(import.meta.dir, '../../../.practice/status', `${name}.json`);
    const state: any = { inventory: [], skills: [], player: { worldX: 2613, worldZ: 3345, level: 0 } };
    // A session whose tick stream has frozen: onTick never fires, tick stays at 531.
    const s: any = { name, sdk: { getState: () => state }, tick: () => 531, onTick: () => () => {} };
    const status = startStatus(s, 'localhost:8888');
    try {
        const first = JSON.parse(readFileSync(file, 'utf8'));
        await new Promise(r => setTimeout(r, 120));
        const later = JSON.parse(readFileSync(file, 'utf8'));
        expect(later.at).toBeGreaterThan(first.at);
        expect(later.tick).toBe(531);
        // The gate reads the row within 30 s of its last write as a known peer on the current release.
        expect(() => assertCompatibleWorkers(process.env.WORKER_RELEASE!, 'localhost:8888', [later], later.at + 1_000)).not.toThrow();
        // Without the clock a 60-second hold would read as unknown.
        expect(() => assertCompatibleWorkers(process.env.WORKER_RELEASE!, 'localhost:8888', [first], first.at + 60_000)).toThrow(/peer state unknown/);
    } finally { status.stop(); rmSync(file, { force: true }); rmSync(file + '.tmp', { force: true }); }
});
