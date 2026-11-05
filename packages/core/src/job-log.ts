import { createHash } from 'node:crypto';
import { missionSignature } from './session-admission';

type LoggedJob = Parameters<typeof missionSignature>[0] & { autopilot?: string; template?: string };
const PREFIX = 'SWARM_JOB ';

function jobLogKey(job: LoggedJob): string {
    // Keep job arguments and environment values out of the log.
    return createHash('sha256').update(JSON.stringify([
        missionSignature(job), job.autopilot ?? null, job.template ?? null,
    ])).digest('hex');
}

export function jobLogStart(job: LoggedJob): string {
    // The previous supervisor may have ended without a trailing newline.
    return '\n' + PREFIX + jobLogKey(job) + '\n';
}

export function matchingJobLines(lines: readonly string[], job: LoggedJob): string[] {
    const expected = PREFIX + jobLogKey(job), result: string[] = [];
    let matches = false;
    for (const line of lines) {
        if (line.startsWith(PREFIX)) matches = line === expected;
        else if (matches) result.push(line);
    }
    return result;
}
