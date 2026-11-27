import { capabilityRevision, launchRevision } from './worker-release/revision';

export type { ReleaseMemo } from './worker-release/paths';
export { runtimeTrees, workerLaunchers, workerSourceRoots } from './worker-release/paths';
export { forgetSourceScans, sourceScans, workerSourceRevision } from './worker-release/source-scan';
export { releaseFiles } from './worker-release/closure';
export {
    cachedLaunchRevision,
    cachedReleaseFiles,
    cachedReleaseFor,
    capabilityRevision,
    forgetReleaseMemory,
    launchRevision,
    releaseEntries,
    releaseRevision,
    workerEntries,
} from './worker-release/revision';
export type { LoginBlocker } from './worker-release/peers';
export {
    LOST_SESSION_DROP_MS,
    PEER_STALE_MS,
    SILENT_SESSION_DROP_MS,
    assertCompatibleWorkers,
    assertLiveWorkerRelease,
    assertWorkerRelease,
    closedSessionRow,
    crashResidue,
    isWorkerReleaseHold,
    loginBlockers,
    readPeerStatuses,
    silentSessionRow,
    standingAccounts,
    standingPeer,
} from './worker-release/peers';

// Read-only candidate IDs. Printing them does not approve or activate a release.
// bun packages/core/src/worker-release.ts [entry ...] prints the entries' capability release, else the launch release.
if (import.meta.main) {
    const entries = process.argv.slice(2);
    console.log(entries.length ? capabilityRevision(entries) : launchRevision());
}
