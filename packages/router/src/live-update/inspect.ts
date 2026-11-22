// Compatibility shim re-exporting packages/fleet/src/live-update/inspect.ts.
export type { Dirty, Git, LiveRun, RebasedFiles, UpdateInput } from '../../../fleet/src/live-update/inspect';
export {
    REBASED_FILE,
    addedPreloads,
    few,
    gitHash,
    gitIn,
    importClosure,
    mergeText,
    mergedDeliveryCopies,
    parseStatus,
    preloadOnlyChange,
    readCheckout,
    readRebased,
    rebasableDeliveryEdits,
} from '../../../fleet/src/live-update/inspect';
