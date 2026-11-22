// Compatibility shim re-exporting packages/fleet/src/live-update/plan.ts.
export type { LiveRunsOptions, UpdatePlan } from '../../../fleet/src/live-update/plan';
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
} from '../../../fleet/src/live-update/plan';
