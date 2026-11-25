// The pending-update mark lives in packages/core/src/live-update-pending.ts: the worker supervisors
// (packages/practice/src/supervise.ts) read it too, and a lower package must not import fleet code.
export {
    PENDING_MAX_AGE_MS,
    clearPendingUpdate,
    drainedFiles,
    pendingUpdateFile,
    pendingUpdateReader,
    readPendingUpdate,
    workerDrain,
    writePendingUpdate,
} from '../../../core/src/live-update-pending';
export type { PendingUpdate } from '../../../core/src/live-update-pending';
