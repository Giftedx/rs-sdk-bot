// Replays a per-tick run record (tick-record.ts) against the current worker code and reports the first tick where
// the worker sends a different command. The worker runs unchanged: its openBot() gets a session whose client feeds
// the recorded states tick by tick and returns the recorded results. A refactor with no behaviour change replays
// clean. The idea and the `*.ticks.ndjson.gz` name come from UberMouse conductor `tools/replay.ts` (MIT); no code is copied.
//
//   bun packages/core/src/replay.ts <record.ticks.ndjson.gz> [--entry scripts/x.ts] [--json]
//
// Exit 0 clean, 1 a different command, 2 the replay could not run.
// Limits: a worker decision that reads the wall clock (Date.now, Bun.sleep) or files written during the run can
// differ on replay with no code change. One record is one session; a second account's openBot refuses.
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BotSDK } from '../../../vendor/rs-sdk/sdk/index';
import { BotActions } from '../../../vendor/rs-sdk/sdk/actions';
import { createShim, inProcessSdkConfig, type ClientLike, type Session } from './inprocess';
import { openHooks, finishHooks } from './bot';
import { applyDelta, readRecord, RECORD_VERSION, type TickRecorder } from './tick-record';

export interface ReplayCommand { t: number; a: unknown; direct: boolean }
export interface ReplayDifference { tick: number; index: number; expected: ReplayCommand | null; actual: ReplayCommand | null }
export interface ReplayResult {
    status: 'clean' | 'differ' | 'error';
    account: string; script: string; ticks: number; commands: number; cut: boolean;
    difference?: ReplayDifference; error?: string;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const turn = () => new Promise<void>(r => setImmediate(r));

// `run` starts the worker (the CLI imports its entry). `actionWaitMs` bounds the wait for each recorded command;
// path searches run off-thread, so a command can need several event-loop turns.
export async function replayRecord(lines: any[], run: () => Promise<unknown>, opts: { actionWaitMs?: number; settleTurns?: number } = {}): Promise<ReplayResult> {
    const meta = lines[0];
    if (meta?.k !== 'meta' || meta.v !== RECORD_VERSION) throw new Error('not a version ' + RECORD_VERSION + ' tick record');
    const waitMs = opts.actionWaitMs ?? 3000, settleTurns = opts.settleTurns ?? 6;
    const expected = lines.filter(l => l.k === 'a');
    const firstPublish = lines.find(l => l.k === 'p' || l.k === 's');
    const offset = firstPublish?.t ?? 0;
    const result: ReplayResult = { status: 'clean', account: meta.account, script: meta.script, ticks: 0, commands: 0, cut: false };
    let state: Record<string, unknown> = {};
    let next = 0, directNext: number | null = null;
    const queued: number[] = [];
    const waiters = new Map<number, (r: unknown) => void>(), results = new Map<number, unknown>();
    let tickCb: (() => void) | null = null;

    const differ = (d: ReplayDifference) => { if (!result.difference) { result.difference = d; result.status = 'differ'; } };
    const compare: TickRecorder = {
        publish() {}, result() {}, end() {},
        stats: () => ({ ticks: 0, rawBytes: 0, cpuMs: 0, cut: false }),
        action(tick, index, action, direct) {
            if (result.difference) return;
            const want = expected[next], t = tick + offset;
            const actual = { t, a: action, direct };
            if (!want || want.t !== t || !same(want.a, action) || !!want.direct !== direct) {
                differ({ tick: Math.min(t, want?.t ?? t), index, expected: want ? { t: want.t, a: want.a, direct: !!want.direct } : null, actual });
                return;
            }
            next++; result.commands++;
            if ((action as { type?: string })?.type === 'wait') return;
            if (direct) directNext = want.i; else queued.push(want.i);
        },
    };
    const client: ClientLike = {
        collectBotState: () => state,
        setOnGameTickCallback(cb) { tickCb = cb; },
        executeBotAction() {
            const index = directNext ?? queued.shift();
            directNext = null;
            if (index === undefined || result.difference) return new Promise(() => {});
            if (results.has(index)) return results.get(index);
            return new Promise(r => waiters.set(index, r));
        },
    };

    let endResolve!: (v: { reason: string }) => void;
    const ended = new Promise<{ reason: string }>(r => { endResolve = r; });
    const sdk = new BotSDK(inProcessSdkConfig({ name: meta.account, password: 'replay', server: meta.server }));
    const shim = createShim(client, sdk);
    const session: Session = {
        name: meta.account, sdk, bot: new BotActions(sdk), tick: () => shim.tick(), onTick: cb => shim.onTick(cb),
        direct: a => shim.direct(a), ended, bankObservation: () => shim.bankObservation(),
        async close() { shim.stop('stopped'); },
    };
    const key = String(meta.account).toLowerCase();
    let opened = false;
    openHooks.set(key, async () => {
        if (opened) throw new Error('replay serves one session per record');
        opened = true;
        shim.start();
        shim.record(compare);
        return session;
    });
    finishHooks.set(key, () => {});

    let li = 1;
    // The record starts with the session's first publication; the worker opens on that state.
    if (firstPublish?.k === 'p') { state = applyDelta(state, firstPublish); li = lines.indexOf(firstPublish) + 1; }
    let workerError: unknown = null;
    void Promise.resolve().then(run).catch(e => { workerError = e; });
    try {
        for (let k = 0; k < 200 && !opened && !workerError; k++) await turn();
        if (!opened) throw workerError ?? new Error('worker did not open its recorded account ' + meta.account);
        // The worker resumes from openBot before the first recorded tick, as it did live.
        for (let k = 0; k < settleTurns; k++) await turn();
        for (; li < lines.length && !result.difference; li++) {
            const l = lines[li];
            if (l.k === 's') {
                state = applyDelta(state, l); result.ticks++;
                tickCb?.();
                for (let k = 0; k < settleTurns; k++) await turn();
            } else if (l.k === 'p') {
                state = applyDelta(state, l);
            } else if (l.k === 'a') {
                const at = expected.indexOf(l), deadline = Date.now() + waitMs;
                while (next <= at && !result.difference && Date.now() < deadline) await turn();
                if (next <= at) differ({ tick: l.t, index: l.i, expected: { t: l.t, a: l.a, direct: !!l.direct }, actual: null });
            } else if (l.k === 'r') {
                // pump() delivers a result and then publishes; apply that publication first.
                const after = lines[li + 1];
                if (after?.k === 'p' && after.t === l.t) { state = applyDelta(state, after); li++; }
                const waiter = waiters.get(l.i);
                if (waiter) { waiters.delete(l.i); waiter(l.r); } else results.set(l.i, l.r);
                for (let k = 0; k < settleTurns; k++) await turn();
            } else if (l.k === 'cut') {
                result.cut = true; break;
            } else if (l.k === 'end') {
                endResolve({ reason: l.reason });
                for (let k = 0; k < settleTurns; k++) await turn();
            }
        }
        if (!result.difference && !result.cut && next < expected.length) {
            const want = expected[next];
            differ({ tick: want.t, index: want.i, expected: { t: want.t, a: want.a, direct: !!want.direct }, actual: null });
        }
        if (result.difference?.actual === null && workerError) result.error = String(workerError);
    } catch (error) {
        result.status = 'error'; result.error = String(error);
    } finally {
        openHooks.delete(key); finishHooks.delete(key);
        endResolve({ reason: 'replay finished' });
        shim.stop('replay finished');
    }
    return result;
}

export function formatDifference(r: ReplayResult): string {
    if (r.status === 'clean') return `clean ${r.commands} commands over ${r.ticks} ticks${r.cut ? ' (record cut)' : ''}`;
    if (r.status === 'error') return `error ${r.error}`;
    const d = r.difference!;
    return `differ at tick ${d.tick} command ${d.index}: recorded ${JSON.stringify(d.expected)} replayed ${JSON.stringify(d.actual)}`;
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const json = args.includes('--json');
    const entryAt = args.indexOf('--entry');
    const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--entry');
    const realExit = process.exit.bind(process);
    if (!file) { console.error('usage: bun packages/core/src/replay.ts <record.ticks.ndjson.gz> [--entry scripts/x.ts] [--json]'); realExit(2); }
    let out: ReplayResult;
    try {
        const lines = readRecord(file!);
        const repoRoot = resolve(import.meta.dir, '..', '..', '..');
        const entry = resolve(repoRoot, entryAt >= 0 ? args[entryAt + 1]! : lines[0].script);
        process.env.REPLAY_ONLY = '1';
        process.env.TICK_RECORD = '0';
        process.argv = [process.argv[0]!, entry, ...(lines[0].argv ?? [])];
        // A worker that exits stops itself, not the replay.
        process.exit = ((code?: number) => { throw new Error(`worker exited ${code ?? 0}`); }) as typeof process.exit;
        out = await replayRecord(lines, () => import(pathToFileURL(entry).href));
    } catch (error) {
        out = { status: 'error', account: '', script: '', ticks: 0, commands: 0, cut: false, error: String(error) };
    }
    console.log(json ? JSON.stringify({ file: join(file!), ...out }) : formatDifference(out));
    realExit(out.status === 'clean' ? 0 : out.status === 'differ' ? 1 : 2);
}
