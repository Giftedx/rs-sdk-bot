import { test, expect } from 'bun:test';
import { BotSDK } from '../../../vendor/rs-sdk/sdk/index';
import { BotActions } from '../../../vendor/rs-sdk/sdk/actions';
import { createShim, type ClientLike, type Session } from '../src/inprocess';
import { openBot } from '../src/bot';
import { waitTicks } from '../src/ticks';
import { replayRecord } from '../src/replay';
import { tickRecorder, stateDelta, applyDelta, createTickRecorder, readRecord } from '../src/tick-record';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';

const turn = () => new Promise<void>(r => setImmediate(r));

// A worker in the shape of scripts/*.ts: open, wait on ticks, send commands, log out with a direct click.
async function worker(open: () => Promise<Session>, secondWalk: number, logout = 2458) {
    const s = await open();
    await waitTicks(s, 2);
    await s.sdk.sendWalk(3200, 3200);
    await waitTicks(s, 3);
    const xp = s.sdk.getState()?.skills?.[0]?.experience ?? 0;
    await s.sdk.sendWalk(xp > 0 ? secondWalk : 1, 3201);
    await waitTicks(s, 1);
    await s.direct({ type: 'clickComponent', componentId: logout, reason: 'SDK' });
}

// Records one run of `worker` on a fake client: results come one tick after each command; xp rises at tick 3.
async function record(): Promise<any[]> {
    const lines: any[] = [];
    let tick = 0, cb = null as (() => void) | null;
    const held: { done: number; resolve: (v: unknown) => void }[] = [];
    const client: ClientLike = {
        collectBotState: (t: number) => ({ tick: t, inGame: true, player: { worldX: 3222, worldZ: 3218, level: 0 }, skills: [{ name: 'Attack', experience: t >= 3 ? 50 : 0 }], inventory: [] }),
        setOnGameTickCallback(f) { cb = f; },
        executeBotAction(a: any) { return a.type === 'clickComponent' ? { success: true } : new Promise(r => held.push({ done: tick + 1, resolve: r })); },
    };
    const sdk = new BotSDK({ botUsername: 'Replayer', password: 'x', autoLaunchBrowser: false, autoReconnect: false } as any);
    const shim = createShim(client, sdk);
    shim.start();
    shim.record(tickRecorder({ account: 'Replayer', server: 'localhost:8888', script: 'scripts/fixture.ts', argv: ['Replayer', '3300'], startedAt: 1 }, { write: l => lines.push(JSON.parse(l)), close() {} }));
    const s: Session = { name: 'Replayer', sdk, bot: new BotActions(sdk), tick: () => shim.tick(), onTick: f => shim.onTick(f), direct: a => shim.direct(a), ended: new Promise(() => {}), async close() {} };
    let done = false;
    void worker(async () => s, 3300).then(() => { done = true; });
    for (let k = 0; k < 6; k++) await turn();
    for (let i = 0; i < 20 && !done; i++) {
        tick++; cb?.();
        for (let k = 0; k < 6; k++) await turn();
        for (const h of held.splice(0)) if (h.done <= tick) h.resolve({ success: true, message: 'walked' }); else held.push(h);
        for (let k = 0; k < 6; k++) await turn();
    }
    shim.stop('logged-out');
    return lines;
}

test('the state delta stores only changed top-level keys and rebuilds the state', () => {
    const prev = new Map<string, string>();
    const a = { tick: 1, player: { x: 1 }, inventory: [] };
    expect(stateDelta(prev, a)).toEqual({ d: a });
    const b = { tick: 2, player: { x: 1 } };
    const delta = stateDelta(prev, b);
    expect(delta).toEqual({ d: { tick: 2 }, x: ['inventory'] });
    expect(applyDelta(applyDelta({}, { d: a }), delta)).toEqual(b);
});

test('the recorder stops at its raw size limit and reports its cost', () => {
    const lines: string[] = [];
    let clock = 0;
    const r = tickRecorder({ account: 'a', server: 's', script: 'x.ts', argv: [], startedAt: 1 }, { write: l => lines.push(l), close() {} }, { maxRawBytes: 400, now: () => clock++ });
    for (let t = 1; t <= 20; t++) r.publish(t, { tick: t, filler: 'x'.repeat(40) }, 's');
    r.end(20, 'logged-out');
    expect(lines.some(l => l.includes('"k":"cut"'))).toBe(true);
    const end = JSON.parse(lines.at(-1)!);
    expect(end).toMatchObject({ k: 'end', reason: 'logged-out', ticks: 20 });
    expect(end.cpuMs).toBeGreaterThan(0);
});

test('an unchanged worker replays its record clean', async () => {
    const lines = await record();
    expect(lines.filter(l => l.k === 'a').length).toBe(3);
    const out = await replayRecord(lines, () => worker(() => openBot('Replayer'), 3300));
    expect(out.status).toBe('clean');
    expect(out.commands).toBe(3);
});

test('a changed worker reports the first tick where its command differs', async () => {
    const lines = await record();
    const second = lines.filter(l => l.k === 'a')[1];
    const out = await replayRecord(lines, () => worker(() => openBot('Replayer'), 3301));
    expect(out.status).toBe('differ');
    expect(out.difference).toMatchObject({ tick: second.t, index: 1, expected: { a: { type: 'walkTo', x: 3300 } }, actual: { t: second.t, a: { type: 'walkTo', x: 3301 } } });
});

test('a worker that stops sending reports the missing command', async () => {
    const lines = await record();
    const out = await replayRecord(lines, async () => { const s = await openBot('Replayer'); await waitTicks(s, 2); }, { actionWaitMs: 200 });
    expect(out.status).toBe('differ');
    expect(out.difference).toMatchObject({ index: 0, actual: null });
});

test('the replay command runs a worker file against a gzip record', async () => {
    const lines = await record();
    const dir = mkdtempSync(join(tmpdir(), 'replay-')), file = join(dir, 'replayer-1.ticks.ndjson.gz');
    writeFileSync(file, gzipSync(lines.map(l => JSON.stringify(l) + '\n').join('')));
    const run = (args: string[]) => {
        const child = Bun.spawnSync([process.execPath, 'packages/core/src/replay.ts', '--json', file, ...args], { cwd: join(import.meta.dir, '..', '..', '..'), windowsHide: true });
        return { code: child.exitCode, out: JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!) };
    };
    const ok = run(['--entry', 'packages/core/test/fixtures/replay-worker.ts']);
    expect(ok.out).toMatchObject({ status: 'clean', commands: 3 });
    expect(ok.code).toBe(0);
    const missing = run(['--entry', 'packages/core/test/fixtures/no-such-worker.ts']);
    expect(missing.out.status).toBe('error');
    expect(missing.code).toBe(2);
});

test('an allowed command swap is counted and every later command is still compared', async () => {
    const lines = await record();
    const swap = await replayRecord(lines, () => worker(() => openBot('Replayer'), 3301), { allow: ['walkTo'] });
    expect(swap).toMatchObject({ status: 'clean', allowed: 1, commands: 3 });
    const later = await replayRecord(lines, () => worker(() => openBot('Replayer'), 3301, 9999), { allow: ['walkTo'] });
    expect(later.status).toBe('differ');
    expect(later.allowed).toBe(1);
    expect(later.difference).toMatchObject({ index: 2, expected: { a: { componentId: 2458 }, direct: true }, actual: { a: { componentId: 9999 } } });
});

test('a record file is complete once its flush resolves', async () => {
    const root = mkdtempSync(join(tmpdir(), 'record-flush-'));
    const r = createTickRecorder({ account: 'Flusher', server: 'localhost:8888', script: 'scripts/flush.ts', argv: [], startedAt: 7 }, { root, env: {} })!;
    for (let t = 1; t <= 50; t++) r.publish(t, { tick: t, inventory: [{ id: t }] }, 's');
    r.end(50, 'logged-out');
    await r.flushed;
    const lines = readRecord(r.file);
    expect(lines[0]).toMatchObject({ k: 'meta', account: 'Flusher' });
    expect(lines.at(-1)).toMatchObject({ k: 'end', reason: 'logged-out', ticks: 50 });
});
