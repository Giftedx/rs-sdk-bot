// The engines and worker processes of the bench cases in flight, and the stop that ends all of them
// (aio-practice-bench.ts stops for the live fleet: bench-start-check.ts fleetStop).
// After the stop no engine and no worker of this run is left: a worker that is running is ended, an engine that is
// ready is stopped, an engine that is starting is ended through `end` without a wait for its ready line, and a case
// that asks for an engine or a worker after the stop gets none.
// This file is tooling. No worker imports it, so a change here does not change a worker release.
export type Stoppable = { stop(): Promise<void> };
export type Killable = { pid: number; kill(): void };

export function runTracker(killWorker: (proc: Killable) => void) {
    const workers = new Set<Killable>(), engines = new Set<Stoppable>(), starting = new Map<Promise<Stoppable>, () => Promise<void>>();
    let stopping = false;
    return {
        get stopping() { return stopping; },
        counts: () => ({ workers: workers.size, engines: engines.size, starting: starting.size }),
        // Starts one engine. `end` ends the engine from the outside at any time after `start` was called (the stack's
        // stop by instance name), so a stop does not wait for the ready line. null: the run is stopping and no engine
        // of this call is left.
        async engine<T extends Stoppable>(start: () => Promise<T>, end: () => Promise<void>): Promise<T | null> {
            if (stopping) return null;
            const begun = start();
            starting.set(begun, end);
            try {
                const engine = await begun;
                if (stopping) { await engine.stop().catch(() => {}); return null; }
                engines.add(engine);
                return engine;
            } catch (error) {
                if (stopping) return null; // the stop ended the engine while it started
                throw error;
            } finally { starting.delete(begun); }
        },
        async release(engine: Stoppable): Promise<void> { engines.delete(engine); await engine.stop(); },
        // Registers a worker process that was just started. false: the run is stopping and the worker was ended.
        worker(proc: Killable): boolean {
            if (stopping) { killWorker(proc); return false; }
            workers.add(proc);
            return true;
        },
        done(proc: Killable): void { workers.delete(proc); },
        // Ends every worker and engine of the run. Safe to call two times.
        async stop(): Promise<void> {
            stopping = true;
            for (const proc of workers) killWorker(proc);
            workers.clear();
            const ends = [...starting.values()].map(end => end().catch(() => {}));
            const stops = [...engines].map(engine => engine.stop().catch(() => {}));
            engines.clear();
            await Promise.all([...ends, ...stops]);
            // An engine whose start resolves after this point is stopped in engine(), which reads `stopping`.
            await Promise.allSettled([...starting.keys()]);
        },
    };
}
