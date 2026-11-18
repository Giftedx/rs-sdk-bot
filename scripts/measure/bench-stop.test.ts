import { expect, test } from 'bun:test';
import { runTracker, type Killable, type Stoppable } from './bench-stop';

const engine = (log: string[], name: string): Stoppable => ({ stop: async () => { log.push('stop ' + name); } });
const worker = (pid: number): Killable => ({ pid, kill() {} });
const deferred = <T>() => { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('a stop ends the running workers and the ready engines, and leaves none', async () => {
    const log: string[] = [], run = runTracker(p => log.push('kill ' + p.pid));
    const a = await run.engine(async () => engine(log, 'a'), async () => { log.push('end a'); });
    expect(a).not.toBeNull();
    expect(run.worker(worker(11))).toBe(true);
    expect(run.worker(worker(12))).toBe(true);
    run.done(worker(99));
    await run.stop();
    expect(log.sort()).toEqual(['kill 11', 'kill 12', 'stop a']);
    expect(run.counts()).toEqual({ workers: 0, engines: 0, starting: 0 });
    expect(run.stopping).toBe(true);
});

test('an engine that is starting is ended at once, with no wait for its ready line', async () => {
    const log: string[] = [], run = runTracker(() => {}), ready = deferred<Stoppable>();
    // The start resolves only when the engine is ended from the outside, as a stack whose process was killed rejects.
    const pending = run.engine(() => ready.promise, async () => { log.push('end by name'); ready.reject(Error('engine exited')); });
    expect(run.counts().starting).toBe(1);
    const stopped = run.stop();
    expect(log).toEqual(['end by name']); // called in the same turn as the stop: no wait for the ready line
    await stopped;
    expect(await pending).toBeNull();
    expect(run.counts()).toEqual({ workers: 0, engines: 0, starting: 0 });
});

test('an engine whose start resolves after the stop is stopped and not handed to its case', async () => {
    const log: string[] = [], run = runTracker(() => {}), ready = deferred<Stoppable>();
    const pending = run.engine(() => ready.promise, async () => { log.push('end by name'); });
    const stopped = run.stop();
    ready.resolve(engine(log, 'late'));
    await stopped;
    expect(await pending).toBeNull();
    expect(log).toEqual(['end by name', 'stop late']);
    expect(run.counts()).toEqual({ workers: 0, engines: 0, starting: 0 });
});

test('after the stop a case gets no engine, and a worker that was just started is ended', async () => {
    const log: string[] = [], run = runTracker(p => log.push('kill ' + p.pid));
    await run.stop();
    let started = false;
    expect(await run.engine(async () => { started = true; return engine(log, 'x'); }, async () => {})).toBeNull();
    expect(started).toBe(false);
    expect(run.worker(worker(21))).toBe(false);
    expect(log).toEqual(['kill 21']);
    expect(run.counts()).toEqual({ workers: 0, engines: 0, starting: 0 });
});

test('a failed engine start is still an error while the run is not stopping; a released engine is stopped once', async () => {
    const log: string[] = [], run = runTracker(() => {});
    await expect(run.engine(async () => { throw Error('port in use'); }, async () => {})).rejects.toThrow('port in use');
    const a = (await run.engine(async () => engine(log, 'a'), async () => {}))!;
    await run.release(a);
    await run.stop();
    expect(log).toEqual(['stop a']);
});
