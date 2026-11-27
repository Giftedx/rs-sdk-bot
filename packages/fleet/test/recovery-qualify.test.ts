import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QUALIFY_RETRY_MS, QUALIFY_RUN_MAX_MS, QUALIFY_SCRIPT, ensureHostedQualification, findDeliveries, qualifyDispatchWait, qualifyStateFile, type Exec, type QualifyRun } from '../src/recovery-qualify';

const dirs: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'recovery-qualify-test-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const SHA = 'f'.repeat(40);
const run = (state: QualifyRun['state'], source: string, at: number): QualifyRun => ({ run: '123', sha: SHA, source, at, state });

test('one run at a time, at most one dispatch for one source in the retry time, and a new source at once', () => {
    const t = 50_000_000, a = 'a'.repeat(64), b = 'b'.repeat(64);
    expect(qualifyDispatchWait(null, a, t)).toBeNull();
    expect(qualifyDispatchWait(run('dispatched', b, 0), a, t)).toBe('run 123 has not finished');
    expect(qualifyDispatchWait(run('imported', a, t - QUALIFY_RETRY_MS + 1), a, t)).toContain('(imported); next dispatch after 30 min');
    expect(qualifyDispatchWait(run('failed', a, t - QUALIFY_RETRY_MS), a, t)).toBeNull();
    expect(qualifyDispatchWait(run('failed', b, t - 1), a, t)).toBeNull();
});

test('only the qualify script delivery folders are found, at any depth', () => {
    const d = scratch();
    for (const p of ['measure-1-x/hosted-rehearse/session-recovery/session-recovery-only-1795600000000/cases',
        'measure-1-x/hosted-rehearse/session-recovery/owned-bank-observation-1795600000000',
        'measure-1-x/specialist-launch/session-recovery-only-notastamp', 'other/session-recovery-only-12']) mkdirSync(join(d, p), { recursive: true });
    expect(findDeliveries(d).map(p => p.slice(d.length + 1).replaceAll('\\', '/')).sort()).toEqual([
        'measure-1-x/hosted-rehearse/session-recovery/owned-bank-observation-1795600000000',
        'measure-1-x/hosted-rehearse/session-recovery/session-recovery-only-1795600000000',
    ]);
});

test('the watchdog dispatches the qualify script to the CI measure job, then imports the deliveries of the finished run', () => {
    const base = scratch(), tmp = scratch();
    let clock = 60_000_000, head = SHA, status = 'in_progress', conclusion: string | null = null, source = 'c'.repeat(64);
    const calls: string[] = [], logs: string[] = [];
    const exec: Exec = cmd => {
        const line = cmd.join(' ');
        calls.push(line);
        if (line === 'git rev-parse HEAD') return { ok: true, out: head + '\n' };
        if (line === 'git rev-parse origin/master') return { ok: true, out: SHA + '\n' };
        if (line.startsWith('git fetch')) return { ok: true, out: '' };
        if (line.startsWith('gh workflow run')) return { ok: true, out: 'https://github.com/o/r/actions/runs/456\n' };
        if (line.startsWith('gh run view')) return { ok: true, out: JSON.stringify({ status, conclusion }) };
        if (line.startsWith('gh run download')) {
            const to = cmd[cmd.indexOf('-D') + 1]!, kept = join(to, 'measure-456-fff', 'hosted-rehearse', 'session-recovery');
            for (const name of ['session-recovery-only-1795600000000', 'owned-bank-observation-1795600000000']) {
                mkdirSync(join(kept, name), { recursive: true });
                writeFileSync(join(kept, name, 'report.json'), JSON.stringify({ id: name }));
            }
            return { ok: true, out: '' };
        }
        return { ok: false, out: `unexpected ${line}` };
    };
    const pass = () => ensureHostedQualification(base, () => clock, l => logs.push(l), { exec, source: () => source, qualified: () => true, scratch: () => tmp });

    // The main checkout is behind master: a run there would qualify a source that the PC does not run.
    head = 'e'.repeat(40);
    pass();
    expect(logs.at(-1)).toBe('recovery qualification: not dispatched: the main checkout is not at origin/master; a live update is due');
    expect(calls.some(c => c.startsWith('gh workflow run'))).toBe(false);

    head = SHA;
    pass();
    expect(calls).toContain(`gh workflow run CI --ref master -f measure_script=${QUALIFY_SCRIPT}`);
    expect(JSON.parse(readFileSync(qualifyStateFile(base), 'utf8'))).toEqual({ run: '456', sha: SHA, source, at: clock, state: 'dispatched' });
    expect(logs.at(-1)).toBe(`recovery qualification: dispatched run 456 at ffffffffff for source cccccccccccc`);

    calls.length = 0;
    pass();
    expect(logs.at(-1)).toBe('recovery qualification: run 456 in_progress');
    expect(calls).toEqual(['gh run view 456 --json status,conclusion']);

    status = 'completed'; conclusion = 'success'; clock += 600_000;
    pass();
    expect(logs.at(-1)).toBe('recovery qualification: run 456 imported owned-bank-observation-1795600000000, session-recovery-only-1795600000000; it qualifies for source cccccccccccc');
    expect(JSON.parse(readFileSync(join(base, '.practice', 'deliveries', 'session-recovery-only-1795600000000', 'report.json'), 'utf8'))).toEqual({ id: 'session-recovery-only-1795600000000' });
    expect(JSON.parse(readFileSync(qualifyStateFile(base), 'utf8')).state).toBe('imported');
    expect(existsSync(join(tmp, 'recovery-qualify-'))).toBe(false);

    // A later deferral for the same source waits for the retry time; a new source dispatches at once.
    pass();
    expect(logs.at(-1)).toContain('not dispatched: run 456 for source cccccccccccc was dispatched 10 min ago (imported)');
    source = 'd'.repeat(64);
    pass();
    expect(logs.at(-1)).toBe(`recovery qualification: dispatched run 456 at ffffffffff for source dddddddddddd`);

    // A failed run is recorded, and its source waits for the retry time.
    conclusion = 'failure';
    pass();
    expect(logs.at(-2)).toBe('recovery qualification: run 456 ended failure');
    expect(logs.at(-1)).toContain('(failed); next dispatch after 30 min');
});

test('a run that cannot be imported, read or finished counts as failed, so a fresh one can be dispatched', () => {
    const base = scratch(), tmp = scratch(), source = 'c'.repeat(64);
    let clock = 70_000_000, view: { ok: boolean; out: string } = { ok: true, out: JSON.stringify({ status: 'completed', conclusion: 'success' }) };
    const logs: string[] = [], calls: string[] = [];
    const exec: Exec = cmd => {
        const line = cmd.join(' ');
        calls.push(line);
        if (line.startsWith('gh run view')) return view;
        if (line.startsWith('gh run download')) return { ok: false, out: 'no valid artifacts found to download' };
        if (line.startsWith('git rev-parse')) return { ok: true, out: SHA + '\n' };
        if (line.startsWith('gh workflow run')) return { ok: true, out: 'https://github.com/o/r/actions/runs/789\n' };
        return { ok: true, out: '' };
    };
    const state = () => JSON.parse(readFileSync(qualifyStateFile(base), 'utf8')) as QualifyRun;
    const write = (v: QualifyRun) => { mkdirSync(join(qualifyStateFile(base), '..'), { recursive: true }); writeFileSync(qualifyStateFile(base), JSON.stringify(v)); };
    const pass = (s = source) => ensureHostedQualification(base, () => clock, l => logs.push(l), { exec, source: () => s, qualified: () => true, scratch: () => tmp });

    // An expired artifact: two passes keep the run, the third counts it as failed, and its source then waits for the retry time.
    write(run('dispatched', source, clock));
    pass();
    expect(logs.at(-1)).toBe('recovery qualification: run 123 not imported: Error: download: no valid artifacts found to download (1 of 3)');
    pass();
    expect(state()).toMatchObject({ state: 'dispatched', faults: 2 });
    pass();
    expect(logs.at(-2)).toContain('not imported: Error: download: no valid artifacts found to download; counted as failed');
    expect(logs.at(-1)).toContain('(failed); next dispatch after 30 min');
    clock += QUALIFY_RETRY_MS;
    pass();
    expect(logs.at(-1)).toBe('recovery qualification: dispatched run 789 at ffffffffff for source cccccccccccc');

    // A deleted run read after the source moved on: counted as failed at once, and the new source dispatches in the same pass.
    write(run('dispatched', 'b'.repeat(64), clock));
    view = { ok: false, out: 'HTTP 404: Not Found' };
    pass();
    expect(logs.at(-2)).toBe('recovery qualification: run 123 unreadable: HTTP 404: Not Found; counted as failed');
    expect(logs.at(-1)).toBe('recovery qualification: dispatched run 789 at ffffffffff for source cccccccccccc');

    // A run that never finishes is waited for up to QUALIFY_RUN_MAX_MS after its dispatch.
    write(run('dispatched', source, clock));
    view = { ok: true, out: JSON.stringify({ status: 'queued', conclusion: null }) };
    clock += QUALIFY_RUN_MAX_MS - 1;
    pass();
    expect(logs.at(-1)).toBe('recovery qualification: run 123 queued');
    clock += 1;
    pass();
    expect(logs.at(-2)).toBe('recovery qualification: run 123 queued 120 min after its dispatch; counted as failed');
    expect(logs.at(-1)).toBe('recovery qualification: dispatched run 789 at ffffffffff for source cccccccccccc');
});

test('an imported run older than the newest deferred end is dispatched again at once; a failed run keeps the wait', () => {
    const source = 'a'.repeat(64), now = 10_000_000;
    const imported = { run: '1', sha: 'b'.repeat(40), source, at: now - 5 * 60_000, state: 'imported' as const };
    // The deferred recovery waits on an end after that run's dispatch: the run qualifies none of it.
    expect(qualifyDispatchWait(imported, source, now, now - 60_000)).toBeNull();
    // An end before the run's dispatch is covered by it: the usual retry wait holds.
    expect(qualifyDispatchWait(imported, source, now, now - 10 * 60_000)).toMatch(/next dispatch after/);
    expect(qualifyDispatchWait(imported, source, now)).toMatch(/next dispatch after/);
    // A failed run of the same source keeps the retry wait, whatever the end.
    expect(qualifyDispatchWait({ ...imported, state: 'failed' }, source, now, now - 60_000)).toMatch(/next dispatch after/);
    expect(qualifyDispatchWait({ ...imported, state: 'dispatched' }, source, now, now - 60_000)).toMatch(/has not finished/);
});
