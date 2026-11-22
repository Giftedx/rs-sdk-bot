// Compatibility shim forwarding watchdog orchestration to packages/fleet/src/watchdog.ts.
import { resolve } from 'node:path';
import { runWatchdogPass } from '../../fleet/src/watchdog';

export type { WatchdogDeps, WatchdogProgress } from '../../fleet/src/watchdog';
export { STALL_MS, stalled, restartCommand, recoveryLog, publisherRepo, runWatchdogPass } from '../../fleet/src/watchdog';

if (import.meta.main) {
    await runWatchdogPass(resolve(import.meta.dir, '../../..'));
}
