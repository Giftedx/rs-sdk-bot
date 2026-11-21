// Live update: fast-forwards this checkout to origin/master and tells the daemons whose code changed to reload.
// scripts/fleet-agent.ts runs it before each sync, so a fix merged to master reaches the live fleet in one agent cycle.
//
// It moves the checkout only when all of these hold:
//   - the checkout is on master and has no commit that origin/master lacks;
//   - no build waits to publish and no build lock is held (a source change fails those);
//   - no qualification runs while the update changes a file it can check (qualificationSource: the worker source,
//     the coordinator, knowledge data, the SDK patch and the root manifests). A dashboard, docs or test-only update
//     does not wait for a qualification;
//   - no running coordinator build owns a file that the update changes (its publish would refuse);
//   - no live coordinator run loads a file that the update changes. Such a run keeps the release it started on, and
//     every new coordinator run then refuses to start until it ends (assertCompatibleWorkers, worker-release.ts);
//   - no dependency manifest changes (that needs `bun install` by a person);
//   - each changed file that is edited or untracked here already holds the bytes of origin/master. A coordinator build
//     publishes its files here before its pull request merges, so that state is usual. Such a file is adopted.
// A changed file that holds the exact snapshot of a coordinator delivery whose PR merged is adopted too
// (mergedDeliveryCopies): master holds its change. A changed file that holds the snapshot of a delivery that has not
// merged yet (or the merge result written for it by an earlier update) moves on top of master when a three-way merge
// of its edit and master's change is clean (rebasableDeliveryEdits): the update takes master's version, writes the
// merged text and records its hash in .practice/live-update-rebased.json, so a later update knows the file. The
// delivery itself merges from its own snapshot, not from this file. Any other local edit to a changed file stops the
// update, and the RESULT line names the file.
//
// The SDK patch (patches/rs-sdk-working.patch) is applied to vendor/rs-sdk, and git does not move those files. When an
// update changes the patch, this script takes the old patch off vendor/rs-sdk after the move and applies the new
// patch. It touches only the files of the old patch. It does that only when vendor/rs-sdk held exactly the old patch, or no patch, and no local file is where the
// new patch creates one. Other edits and such a file stay, and the RESULT line says so. A patch change that alters a
// file of the worker release (runtimeTrees in worker-release.ts) waits while a live coordinator run goes, as a change
// to any other release file does.
// On a checkout that is current, an unpatched vendor/rs-sdk gets the patch, with the same waits, and a vendor/rs-sdk
// with other edits gets a RESULT line that names it.
//
// After the move it writes .practice/live-update.json (packages/core/src/live-reload.ts). The fleet agent, autopilot,
// dashboard collector and publisher restart themselves from it. The coordinator gets its reload request (`coordinator-cli.ts --restart`,
// which keeps its children). The coordinator restarts the swarm itself when the swarm's files change (ensureSwarm).
// This file is tooling: runtime code starts it as a process and never imports it (packages/core/src/worker-release.ts).
//
// Usage: bun packages/router/src/live-update.ts [--dry]   Env: LIVE_UPDATE=0 turns it off. .practice/stop-live-update pauses it.
import { resolve } from 'node:path';
import { runLiveUpdateCli } from './live-update/reload';

export type { Dirty, LiveRun, RebasedFiles, UpdateInput } from './live-update/inspect';
export {
    REBASED_FILE,
    addedPreloads,
    gitIn,
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
