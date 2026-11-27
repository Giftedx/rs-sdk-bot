// A blocked event loop cannot time itself: a synchronous search or flood that never returns stops every timer, the
// status heartbeat too, and the supervisor sees the stall only after 15 minutes with no output (Swordinhand's
// aio-fighter run, pid 27940: alive at 75% of one core, no heartbeat from 12:30:29). The main loop stores the time and
// its last log line in shared memory each second; a worker thread (loop-watchdog-worker.ts) reads them. When the loop
// has not beaten for LOOP_STALL_MS, the worker prints a RESULT fail line with the last log line, marks each status file
// of the process as stalled, and ends the process, so the supervisor and the release gate see the stall at once.
const PHASE_BYTES = 1024;
export const DEFAULT_LOOP_STALL_MS = 60_000;
export const loopStallMs = () => { const v = Number(process.env.LOOP_STALL_MS ?? DEFAULT_LOOP_STALL_MS); return Number.isFinite(v) ? v : DEFAULT_LOOP_STALL_MS; };

export type WatchdogOptions = {
    stallMs?: number;
    // How often the main loop beats and the worker looks (ms).
    beatMs?: number;
    // End the process on a stall (default true). A test may keep it to read the outputs.
    exit?: boolean;
};
type Shared = { beat: Float64Array; phaseLength: Int32Array; phase: Uint8Array };
let running: { worker: Worker; timer: ReturnType<typeof setInterval>; shared: Shared; files: Set<string> } | null = null;
let lastLine = '';
const encoder = new TextEncoder();

// The last log line of the process: the phase a stall report names.
export function noteLoopPhase(line: string): void { lastLine = line; }

function beat(shared: Shared): void {
    shared.beat[0] = Date.now();
    const bytes = encoder.encode(lastLine.slice(0, PHASE_BYTES / 4));
    const n = Math.min(bytes.length, PHASE_BYTES);
    shared.phase.set(bytes.subarray(0, n));
    Atomics.store(shared.phaseLength, 0, n);
}

/** Starts the one watchdog of this process (a no-op when one runs or LOOP_STALL_MS is 0). */
export function startLoopWatchdog(o: WatchdogOptions = {}): void {
    const stallMs = o.stallMs ?? loopStallMs();
    if (running || stallMs <= 0) return;
    const shared: Shared = {
        beat: new Float64Array(new SharedArrayBuffer(8)),
        phaseLength: new Int32Array(new SharedArrayBuffer(4)),
        phase: new Uint8Array(new SharedArrayBuffer(PHASE_BYTES)),
    };
    beat(shared);
    const beatMs = o.beatMs ?? 1000;
    const worker = new Worker(new URL('./loop-watchdog-worker.ts', import.meta.url).href) as Worker & { unref?(): void };
    worker.postMessage({ kind: 'start', beat: shared.beat, phaseLength: shared.phaseLength, phase: shared.phase, stallMs, beatMs, exit: o.exit ?? true, pid: process.pid });
    worker.unref?.();
    const timer = setInterval(() => beat(shared), beatMs);
    (timer as { unref?(): void }).unref?.();
    running = { worker, timer, shared, files: new Set() };
}

// A status file that the watchdog marks as stalled (status.ts startStatus adds its file and removes it on stop).
export function watchStatusFile(file: string): () => void {
    if (!running) return () => {};
    const r = running;
    r.files.add(file);
    r.worker.postMessage({ kind: 'files', files: [...r.files] });
    return () => { if (running !== r) return; r.files.delete(file); r.worker.postMessage({ kind: 'files', files: [...r.files] }); };
}

export function stopLoopWatchdog(): void {
    if (!running) return;
    clearInterval(running.timer);
    void running.worker.terminate();
    running = null;
}
