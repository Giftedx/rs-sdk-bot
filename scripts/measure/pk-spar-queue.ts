// Runs a list of spar measurements one after another with no one watching: each line of the queue file is the
// arguments of one `bun` command (a climb, a matrix, a ladder). The output of every command goes to the log, and the
// queue ends with a QUEUE_DONE line. A command that fails does not stop the queue.
// Usage: bun scripts/measure/pk-spar-queue.ts <queue file> <log file>
// A queue file line: scripts/measure/pk-spar-climb.ts --case extra:spar-x8 --knobs eatAt
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [queueFile, logFile] = process.argv.slice(2);
if (!queueFile || !logFile) { console.log('usage: bun scripts/measure/pk-spar-queue.ts <queue file> <log file>'); process.exit(2); }
const root = resolve(import.meta.dir, '..', '..'), log = (line: string) => appendFileSync(logFile, line + '\n');
const jobs = readFileSync(queueFile, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
log(`QUEUE_START ${jobs.length} jobs ${new Date().toISOString()}`);
for (const [i, job] of jobs.entries()) {
    log(`QUEUE_JOB ${i + 1}/${jobs.length} ${job}`);
    const child = Bun.spawnSync(['bun', ...job.split(/\s+/)], { cwd: root, env: { ...process.env }, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    for (const line of (child.stdout.toString() + child.stderr.toString()).split(/\r?\n/)) if (/^(CLIMB|MATRIX|SPAR_)/.test(line)) log(line.slice(0, 600));
    log(`QUEUE_JOB_END ${i + 1}/${jobs.length} exit ${child.exitCode}`);
}
log(`QUEUE_DONE ${new Date().toISOString()}`);
