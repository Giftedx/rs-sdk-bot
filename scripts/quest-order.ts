// Compatibility shim for scripts/quest-order.ts, routed through packages/workers/src/quest/order.
// Usage: bun scripts/quest-order.ts <account> <cook|hetty> [--save=<path>] [--timeout-ms=300000]
import { resolve } from 'node:path';
import { dispatchQuesterCli } from '../packages/workers/src/quest/modes';

export * from '../packages/workers/src/quest/order';

if (import.meta.main) {
    const [account, ...rest] = process.argv.slice(2);
    if (!account) {
        console.error('usage: bun scripts/quest-order.ts <account> <quest> [--save=<path>] [--timeout-ms=300000]');
        process.exit(1);
    }
    try {
        process.exitCode = await dispatchQuesterCli(account, ['order', ...rest.map((a) => (a.startsWith('--save=') ? `--save=${resolve(a.slice(7))}` : a))]);
    } catch (error) {
        console.error(String(error));
        process.exitCode = 1;
    }
}
