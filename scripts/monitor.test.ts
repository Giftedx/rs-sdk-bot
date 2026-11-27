import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cycle, readStatusSnapshots } from './monitor';

test('monitor reads .practice/live/status with fallback to .practice/status and counts sim practice bots', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'monitor-test-'));
    const now = 1_700_000_000_000;
    try {
        mkdirSync(join(tempRoot, '.practice', 'live', 'status'), { recursive: true });
        mkdirSync(join(tempRoot, '.practice', 'status'), { recursive: true });
        mkdirSync(join(tempRoot, '.practice', 'sim', 'status'), { recursive: true });

        writeFileSync(join(tempRoot, '.practice', 'status', 'Alpha.json'), JSON.stringify({
            name: 'Alpha', server: 'rs-sdk-demo.fly.dev', at: now - 60_000, phase: 'stale-legacy', timeline: 'a',
        }));
        writeFileSync(join(tempRoot, '.practice', 'live', 'status', 'Alpha.json'), JSON.stringify({
            name: 'Alpha', server: 'rs-sdk-demo.fly.dev', at: now - 5_000, phase: 'fresh-live', timeline: 'ab',
        }));
        writeFileSync(join(tempRoot, '.practice', 'status', 'LegacyOnly.json'), JSON.stringify({
            name: 'LegacyOnly', server: 'rs-sdk-demo.fly.dev', at: now - 10_000, phase: 'fallback', timeline: 'c',
        }));
        writeFileSync(join(tempRoot, '.practice', 'sim', 'status', 'PracBot.json'), JSON.stringify({
            name: 'PracBot', server: 'localhost:8888', practice: true, at: now - 5_000,
        }));

        const rows = readStatusSnapshots(tempRoot);
        expect(rows.find(r => r.name === 'Alpha')?.phase).toBe('fresh-live');
        expect(rows.find(r => r.name === 'LegacyOnly')?.phase).toBe('fallback');

        const snap = cycle(tempRoot, { now, list: [], alertLog: false });
        expect(snap.practiceBots).toBe(1);
        expect((snap.bots as any[]).map(b => `${b.name}:${b.phase}`).sort()).toEqual(['Alpha:fresh-live', 'LegacyOnly:fallback']);

        const written = JSON.parse(readFileSync(join(tempRoot, '.practice', 'monitor.json'), 'utf8'));
        expect(written.at).toBe(now);
        expect(written.practiceBots).toBe(1);
    } finally {
        rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('monitor raises no second died alert for a session whose bot wrote its own death alert', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'monitor-test-'));
    const now = 1_700_000_000_000;
    try {
        mkdirSync(join(tempRoot, '.practice', 'live', 'status'), { recursive: true });
        const status = (name: string) => writeFileSync(join(tempRoot, '.practice', 'live', 'status', `${name}.json`), JSON.stringify({
            name, server: 'rs-sdk-demo.fly.dev', at: now - 5_000, started: now - 600_000, result: 'fail died=true', timeline: 'a',
        }));
        status('DeadSelf');
        status('DeadQuiet');
        writeFileSync(join(tempRoot, '.practice', 'alerts.jsonl'), JSON.stringify({ at: now - 60_000, level: 'error', key: `died-DeadSelf-${now - 60_000}`, bot: 'DeadSelf', text: 'DeadSelf died: DEATH' }) + '\n');
        const snap = cycle(tempRoot, { now, list: [] });
        // Only the died- keys: a low-RAM test machine also writes a ram alert.
        const keys = readFileSync(join(tempRoot, '.practice', 'alerts.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).key).filter(k => k.startsWith('died-'));
        expect(keys).toEqual([`died-DeadSelf-${now - 60_000}`, `died-DeadQuiet-${now - 600_000}`]);
        // The bot's own alert still shows in monitor.json.
        expect((snap.alerts as any[]).map(a => a.key).filter(k => k.startsWith('died-')).sort()).toEqual([`died-DeadQuiet-${now - 600_000}`, `died-DeadSelf-${now - 60_000}`]);
    } finally {
        rmSync(tempRoot, { recursive: true, force: true });
    }
});
