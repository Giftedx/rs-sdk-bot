import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOST_SESSION_DROP_MS, PEER_STALE_MS, SILENT_SESSION_DROP_MS, assertCompatibleWorkers, closedSessionRow, loginBlockers, silentSessionRow } from '../src/worker-release';
import { beginSessionAttempt } from '../src/session-lifecycle';

const server = 'rs-sdk-demo.fly.dev', pin = 'a'.repeat(64), other = 'b'.repeat(64);
const owner = (pid: number) => ({ pid, coordinatorRunId: null, workerRelease: null, script: 'scripts/aio-fighter.ts', role: null, participants: null });

test('each kind of unfinished row: what holds every login and what does not', () => {
    const root = mkdtempSync(join(tmpdir(), 'peer-rows-'));
    try {
        const floor = Number(beginSessionAttempt({ account: 'Probe', server }, { root, now: () => 0 }).attemptId.slice(0, 13));
        const base = Math.max(Date.now(), floor), now = base + LOST_SESSION_DROP_MS;
        const start = (account: string, pid: number) => { const a = beginSessionAttempt({ account, server }, { root, owner: owner(pid), now: () => base }); a.record('connected'); a.record('ready'); return a; };
        const dead = start('Dead', 41), live = start('Live', 42), drained = start('Drained', 43);
        drained.record('logout', 'logged-out'); drained.record('ended', 'logged-out');
        const alive = (pid: number) => pid === 42;
        const closed = (r: any) => closedSessionRow(r, server, { root }, alive, now);
        const row = (a: { account: string; attemptId: string } | null, at: number, extra: object = {}) =>
            ({ name: a?.account ?? 'Legacy', server, result: '', at, workRevision: pin, sessionAttemptId: a?.attemptId ?? null, ...extra });
        const blocks = (r: object) => { try { assertCompatibleWorkers(pin, server, [r], now, closed); return false; } catch (e) { return /peer state unknown/.test(String(e)); } };

        // A dead owner past the server's lost-session drop.
        expect(blocks(row(dead, base))).toBe(false);
        // A live owner that beats: a fresh row is a known peer on the same release.
        expect(blocks(row(live, now - 1_000))).toBe(false);
        // A live owner silent past the beat: unknown, until the server's no-response logout has surely passed.
        expect(blocks(row(live, now - PEER_STALE_MS))).toBe(true);
        expect(blocks(row(live, now - SILENT_SESSION_DROP_MS + 1))).toBe(true);
        expect(blocks(row(live, now - SILENT_SESSION_DROP_MS))).toBe(false);
        // A legacy row with no lifecycle attempt.
        expect(blocks(row(null, now - LOST_SESSION_DROP_MS))).toBe(true);
        expect(blocks(row(null, now - SILENT_SESSION_DROP_MS))).toBe(false);
        // A run a drain stopped: its logout ended the session, with or without the RESULT in its row.
        expect(blocks(row(drained, now - PEER_STALE_MS))).toBe(false);
        expect(blocks(row(drained, now - PEER_STALE_MS, { result: 'RESULT fail stop file' }))).toBe(false);
        // A row dated in the future is never silent.
        expect(silentSessionRow(row(null, now + SILENT_SESSION_DROP_MS), now)).toBe(false);
        expect(blocks(row(null, now + 1))).toBe(true);
        // The safety the gate keeps: a fresh peer on another release refuses a mixed rollout.
        expect(() => assertCompatibleWorkers(pin, server, [row(live, now - 1_000, { workRevision: other })], now, closed)).toThrow('coordinated rollout');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loginBlockers names the rows that refuse logins, with the owner of each', () => {
    const base = mkdtempSync(join(tmpdir(), 'peer-blockers-'));
    try {
        const live = join(base, '.practice', 'live'), legacy = join(base, '.practice', 'status'), status = join(live, 'status');
        mkdirSync(status, { recursive: true }); mkdirSync(legacy, { recursive: true });
        const now = Date.now();
        const a = beginSessionAttempt({ account: 'Hung', server }, { root: join(live, 'session-lifecycle'), owner: owner(process.pid) });
        a.record('connected'); a.record('ready');
        const write = (dir: string, name: string, row: object) => writeFileSync(join(dir, `${name}.json`), JSON.stringify({ name, server, result: '', workRevision: pin, ...row }));
        write(status, 'Hung', { at: now - 60_000, sessionAttemptId: a.attemptId });
        write(status, 'Beating', { at: now - 1_000 });
        write(status, 'Finished', { at: now - 60_000, result: 'RESULT ok' });
        write(legacy, 'Old', { at: now - 90_000 });
        write(legacy, 'Ancient', { at: now - SILENT_SESSION_DROP_MS - 1 });
        // The live directory wins over a legacy row of the same account.
        write(legacy, 'Beating', { at: now - 90_000 });
        const rows = loginBlockers(server, base, now, pid => pid === process.pid).sort((x, y) => x.name.localeCompare(y.name));
        expect(rows.map(r => [r.name, r.dir === status ? 'live' : 'legacy', r.ageMs, r.ownerPid, r.ownerAlive])).toEqual([
            ['Hung', 'live', 60_000, process.pid, true],
            ['Old', 'legacy', 90_000, null, null],
        ]);
        expect(loginBlockers('localhost:8888', base, now)).toEqual([]);
    } finally { rmSync(base, { recursive: true, force: true }); }
});
