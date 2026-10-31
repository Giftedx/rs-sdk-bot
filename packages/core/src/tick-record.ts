// Per-tick run record: every state publication and every command a worker sends, one gzip NDJSON file per
// session (`.practice/ticks/<script>/<account>-<startedAt>.ticks.ndjson.gz`). packages/core/src/replay.ts runs
// changed worker code against a record and reports the first different command. The file name follows UberMouse
// conductor `tools/replay.ts` (`*.ticks.ndjson.gz`, MIT); no code is copied.
//
// Lines, in the order they happened:
//   {k:'meta',v,account,server,script,argv,startedAt}
//   {k:'s',t,d,x?}  tick publication: d holds the top-level state keys whose JSON changed, x the removed keys
//   {k:'p',t,d,x?}  publication after an action result, same tick
//   {k:'a',t,i,a,direct?}  command i sent (queued sdk_action, or a direct click such as logout)
//   {k:'r',t,i,r}   result of command i
//   {k:'cut',t,rawBytes}  raw size limit reached; nothing after this line
//   {k:'end',t,reason,ticks,rawBytes,cpuMs}
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { createGzip, gunzipSync } from 'node:zlib';

export const RECORD_VERSION = 1;
// A synthetic skilling run (tick-record-measure.ts) writes about 84 MB of raw JSON and 2.2-2.4 MB of gzip per
// 6,000 ticks, at 0.23-0.25 ms of process CPU per tick. The cap bounds one record to about 36,000 such ticks.
export const RECORD_MAX_RAW_BYTES = 512 * 2 ** 20;
// Records kept per script. Replay reads the newest few; older ones are deleted when a new record starts.
export const RECORD_KEEP = 24;
const repoRoot = resolve(import.meta.dir, '..', '..', '..');
export const recordRoot = (root = repoRoot) => join(root, '.practice', 'ticks');

export interface RecordMeta { account: string; server: string; script: string; argv: string[]; startedAt: number }
export interface TickRecorder {
    publish(tick: number, state: unknown, kind: 's' | 'p'): void;
    action(tick: number, index: number, action: unknown, direct: boolean): void;
    result(tick: number, index: number, result: unknown): void;
    end(tick: number, reason: string): void;
    stats(): { ticks: number; rawBytes: number; cpuMs: number; cut: boolean };
}

// Shallow delta against the previous publication: the JSON of each top-level key, compared as text.
export function stateDelta(previous: Map<string, string>, state: unknown): { d: Record<string, unknown>; x?: string[] } {
    const d: Record<string, unknown> = {};
    const seen = new Set<string>();
    const obj = (state && typeof state === 'object' ? state : {}) as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
        const value = obj[key];
        if (value === undefined) continue;
        seen.add(key);
        const text = JSON.stringify(value);
        if (previous.get(key) !== text) { previous.set(key, text); d[key] = value; }
    }
    const x = [...previous.keys()].filter(k => !seen.has(k));
    for (const k of x) previous.delete(k);
    return x.length ? { d, x } : { d };
}

export function applyDelta(state: Record<string, unknown>, line: { d?: Record<string, unknown>; x?: string[] }): Record<string, unknown> {
    const next = { ...state, ...structuredClone(line.d ?? {}) };
    for (const k of line.x ?? []) delete next[k];
    return next;
}

// `sink` receives each line; createTickRecorder wires it to a gzip file. Tests pass an array sink.
export function tickRecorder(meta: RecordMeta, sink: { write(line: string): void; close(): void }, opts: { maxRawBytes?: number; now?: () => number } = {}): TickRecorder {
    const max = opts.maxRawBytes ?? RECORD_MAX_RAW_BYTES;
    const clock = opts.now ?? (() => performance.now());
    const previous = new Map<string, string>();
    let rawBytes = 0, cpuMs = 0, ticks = 0, cut = false, ended = false;
    const write = (row: object, tick: number) => {
        if (cut || ended) return;
        const line = JSON.stringify(row) + '\n';
        if (rawBytes + line.length > max) {
            cut = true;
            const mark = JSON.stringify({ k: 'cut', t: tick, rawBytes }) + '\n';
            rawBytes += mark.length;
            sink.write(mark);
            return;
        }
        rawBytes += line.length;
        sink.write(line);
    };
    const timed = (f: () => void) => { const start = clock(); try { f(); } catch { /* a record must never stop the worker */ } cpuMs += clock() - start; };
    write({ k: 'meta', v: RECORD_VERSION, ...meta }, 0);
    return {
        publish(tick, state, kind) { timed(() => { if (kind === 's') ticks++; write({ k: kind, t: tick, ...stateDelta(previous, state) }, tick); }); },
        action(tick, index, action, direct) { timed(() => write(direct ? { k: 'a', t: tick, i: index, a: action, direct: true } : { k: 'a', t: tick, i: index, a: action }, tick)); },
        result(tick, index, result) { timed(() => write({ k: 'r', t: tick, i: index, r: result ?? null }, tick)); },
        end(tick, reason) {
            if (ended) return;
            timed(() => {
                const line = JSON.stringify({ k: 'end', t: tick, reason, ticks, rawBytes, cpuMs: Math.round(cpuMs * 10) / 10 }) + '\n';
                rawBytes += line.length;
                sink.write(line);
            });
            ended = true;
            sink.close();
        },
        stats: () => ({ ticks, rawBytes, cpuMs, cut }),
    };
}

export const scriptKey = (script: string) => basename(script).replace(/\.[cm]?[jt]s$/, '');

// One record per session. TICK_RECORD=0 turns recording off. Returns null when the folder cannot be written.
export function createTickRecorder(meta: RecordMeta, opts: { root?: string; env?: Record<string, string | undefined> } = {}): (TickRecorder & { file: string }) | null {
    const env = opts.env ?? process.env;
    if (env.TICK_RECORD === '0') return null;
    try {
        const dir = join(recordRoot(opts.root), scriptKey(meta.script));
        mkdirSync(dir, { recursive: true });
        pruneRecords(dir, RECORD_KEEP - 1);
        const file = join(dir, `${meta.account.toLowerCase()}-${meta.startedAt}.ticks.ndjson.gz`);
        const gzip = createGzip({ level: 6 });
        const out = createWriteStream(file);
        gzip.pipe(out);
        gzip.on('error', () => {});
        out.on('error', () => {});
        // A repo-relative script, so a replay in a build workspace runs that workspace's copy.
        const rel = relative(opts.root ?? repoRoot, meta.script);
        const script = isAbsolute(meta.script) && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replace(/\\/g, '/') : meta.script;
        return { file, ...tickRecorder({ ...meta, script }, { write: l => { gzip.write(l); }, close: () => { gzip.end(); } }) };
    } catch {
        return null;
    }
}

export function pruneRecords(dir: string, keep: number) {
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).filter(f => f.endsWith('.ticks.ndjson.gz'))
        .map(f => ({ f, at: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.at - a.at);
    for (const { f } of files.slice(keep)) try { unlinkSync(join(dir, f)); } catch { /* in use or gone */ }
}

export function readRecord(file: string): any[] {
    return gunzipSync(readFileSync(file)).toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

// The newest `count` complete records of a script that started before `before` (a build's own qualification
// records start after its build task, so they never vouch for it).
export function recentRecords(script: string, before: number, count: number, root = repoRoot): string[] {
    const dir = join(recordRoot(root), scriptKey(script));
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(f => f.endsWith('.ticks.ndjson.gz'))
        .map(f => ({ file: join(dir, f), at: Number(f.match(/-(\d+)\.ticks\.ndjson\.gz$/)?.[1] ?? NaN) }))
        .filter(r => Number.isFinite(r.at) && r.at < before)
        .sort((a, b) => b.at - a.at).slice(0, count).map(r => r.file);
}
