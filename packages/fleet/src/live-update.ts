// Fast-forwards master to origin/master and tells affected fleet daemons to reload cleanly.
// Usage: bun packages/fleet/src/live-update.ts [--dry]   Env: LIVE_UPDATE=0 turns it off. .practice/stop-live-update pauses it.
import { resolve } from 'node:path';
import { runLiveUpdateCli } from './live-update/reload';

export type { Dirty, LiveRun, RebasedFiles, UpdateInput } from './live-update/inspect';
export {
    REBASED_FILE,
    addedPreloads,
    gitIn,
    importClosure,
    mergeText,
    mergedDeliveryCopies,
    parseStatus,
    preloadOnlyChange,
    readCheckout,
    readRebased,
    rebasableDeliveryEdits,
} from './live-update/inspect';

export {
    SDK,
    SDK_PATCH,
    patchChangedFiles,
    patchCollisions,
    patchSections,
    resetVendor,
    vendorExact,
    vendorReleaseFiles,
    vendorState,
} from './live-update/vendor';

export type { LiveRunsOptions, UpdatePlan } from './live-update/plan';
export {
    LIVE_ROW_MS,
    LIVE_SERVER,
    TRADE_ENTRY,
    TRADE_HOLD_MS,
    coordinatorHolds,
    liveRuns,
    planUpdate,
    qualificationSource,
    releaseClosure,
} from './live-update/plan';

export { applyUpdate } from './live-update/adopt';
export { DAEMONS, reloadsFor } from './live-update/reload';

if (import.meta.main) {
    process.exit(await runLiveUpdateCli(resolve(import.meta.dir, '../../..')));
}
