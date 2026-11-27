// The watchdog thread of loop-watchdog.ts. It runs while the main loop is blocked: it reads the main loop's last beat
// from shared memory, and after `stallMs` with no beat it reports the stall and ends the process.
import { readFileSync, writeSync } from 'node:fs';
import { basename } from 'node:path';
import { writeAtomicFile } from './atomic-file';

type Start = { kind: 'start'; beat: Float64Array; phaseLength: Int32Array; phase: Uint8Array; stallMs: number; beatMs: number; exit: boolean; pid: number };
type Files = { kind: 'files'; files: string[] };
declare const self: { onmessage: ((e: MessageEvent<Start | Files>) => void) | null };

let files: string[] = [];
const decoder = new TextDecoder();

function report(m: Start, blockedMs: number): void {
    const n = Atomics.load(m.phaseLength, 0), phase = decoder.decode(m.phase.slice(0, n)).replace(/\s+/g, ' ').trim();
    const result = `fail stalled: event loop blocked for ${Math.round(blockedMs / 1000)} s; last log line: ${phase || '-'}`;
    // supervise.ts reads the bare RESULT line; supervise-host.ts reads one `[account] RESULT` line for each hosted
    // account (keptHostLine), named here by the account's status file.
    const hosted = files.map(f => `[${basename(f, '.json')}] RESULT ${result}\n`).join('');
    try { writeSync(1, `LOOP_STALL ${JSON.stringify({ pid: m.pid, blockedMs: Math.round(blockedMs), phase })}\nRESULT ${result}\n${hosted}`); } catch { /* stdout closed */ }
    for (const file of files) {
        try {
            const doc = JSON.parse(readFileSync(file, 'utf8'));
            doc.result = result.slice(0, 300);
            doc.stalled = { at: Date.now(), blockedMs: Math.round(blockedMs), phase };
            doc.at = Date.now();
            writeAtomicFile(file, JSON.stringify(doc));
        } catch { /* a missing or busy status file must not stop the exit */ }
    }
}

self.onmessage = e => {
    const m = e.data;
    if (m.kind === 'files') { files = m.files; return; }
    let reported = false;
    setInterval(() => {
        const blocked = Date.now() - m.beat[0]!;
        if (reported || blocked < m.stallMs) return;
        reported = true;
        report(m, blocked);
        // A blocked main loop cannot run an exit handler: the process is ended from here.
        if (m.exit) process.kill(m.pid, 'SIGKILL');
    }, Math.max(50, Math.min(m.beatMs, 1000)));
};
