// Blocks its own event loop under the watchdog (loop-watchdog.test.ts). Argument: the status file to watch.
// HOSTED=1 logs the last line as a hosted session does (host.ts botSink -> status.ts noteStatusLine).
import { writeFileSync } from 'node:fs';
import { noteLoopPhase, startLoopWatchdog, watchStatusFile } from '../../src/loop-watchdog';
import { noteStatusLine } from '../../src/status';

const file = process.argv[2]!;
writeFileSync(file, JSON.stringify({ name: 'fixture', result: '', at: Date.now() }));
startLoopWatchdog({ stallMs: Number(process.env.STALL_MS ?? 1500), beatMs: 100 });
watchStatusFile(file);
if (process.env.HOSTED === '1') noteStatusLine('Fixture', 'WALK fixture phase before the block');
else noteLoopPhase('WALK fixture phase before the block');
console.log('READY');
// Let the watchdog thread start and the main loop beat once with the phase.
setTimeout(() => {
    const end = Date.now() + Number(process.env.BLOCK_MS ?? 30_000);
    while (Date.now() < end) { /* a synchronous search that does not return */ }
    console.log('UNBLOCKED');
}, 500);
