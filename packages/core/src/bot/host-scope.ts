// The hosted bot that owns the running code, for code the bot host (host.ts) does not rewrite. host.ts rewrites only
// the script file. A helper module (a worker under scripts/aio-skiller.ts) that calls finish(), openBot(),
// console.log() or process.exit() reaches the shared module instead. Without this, a helper's finish() ends no
// hosted bot (the host waits for ever) and its RESULT line has no `[bot]` prefix for supervise-host.ts.
// Each hosted bot runs inside its own execution context (worker-execution.ts). Nested contexts copy the parent
// (`{ ...parent, signal }`), so the context's `log` function names the bot wherever the work goes.
import { executionContext } from '../../../../vendor/rs-sdk/sdk/execution-context';
import type { Session } from '../inprocess';
import type { FinishDetail } from './rules';

export interface HostedScope {
    name: string;
    log(line: string): void;
    finish(sessions: Session[], ok: boolean, detail: FinishDetail): Promise<never>;
    openBot(name: string, opts?: object): Promise<Session>;
    exit(code?: number): never;
}

type ContextLog = NonNullable<NonNullable<ReturnType<typeof executionContext.getStore>>['log']>;
const scopes = new WeakMap<ContextLog, HostedScope>();

export function bindHostedScope(log: ContextLog, scope: HostedScope): void {
    scopes.set(log, scope);
}

export function currentHostedScope(): HostedScope | undefined {
    const log = executionContext.getStore()?.log;
    return log ? scopes.get(log) : undefined;
}
