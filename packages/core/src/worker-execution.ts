import { executionContext } from '../../../vendor/rs-sdk/sdk/execution-context';
import type { Session } from './inprocess';

// Adapt the SDK runner/MCP execution lifetime to hosted workers. Cleanup is run
// outside the cancelled work scope so logout and retained-stock settlement work.
// A call made by cancelled work parks: a catch-all loop cannot flood the host.
export function workerExecution(log: (level: 'log' | 'warn' | 'error', args: unknown[]) => void) {
    const controller = new AbortController();
    const context = { signal: controller.signal, log };
    const cancelled = () => { const caller = executionContext.getStore(); return !!caller && (controller.signal.aborted || caller.signal.aborted); };
    const guarded = <T extends object>(object: T): T => new Proxy(object, {
        get(target, property) {
            const value = Reflect.get(target, property, target);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => {
                if (cancelled()) return new Promise(() => {});
                return value.apply(target, args);
            };
        },
    });
    return {
        signal: controller.signal,
        run<T>(work: () => T): T { return executionContext.run(context, work); },
        cleanup<T>(work: () => T): T { return executionContext.exit(work); },
        stop(reason: unknown) { if (!controller.signal.aborted) controller.abort(reason); },
        bind(session: Session): Session {
            session.sdk = guarded(session.sdk);
            session.bot = guarded(session.bot);
            const direct = session.direct.bind(session);
            session.direct = action => cancelled()
                ? new Promise(() => {}) : direct(action);
            const listen = session.onTick.bind(session);
            session.onTick = cb => {
                if (controller.signal.aborted) return () => {};
                const caller = executionContext.getStore();
                if (caller?.signal.aborted) return () => {};
                const signals = [...new Set([controller.signal, caller?.signal].filter((signal): signal is AbortSignal => !!signal))];
                const off = listen(() => {
                    if (!signals.some(signal => signal.aborted)) caller ? executionContext.run(caller, cb) : cb();
                });
                const stop = () => { off(); for (const signal of signals) signal.removeEventListener('abort', stop); };
                for (const signal of signals) signal.addEventListener('abort', stop, { once: true });
                return stop;
            };
            return session;
        },
    };
}
