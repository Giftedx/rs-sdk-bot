import {runCoordinatorCli} from './coordinator-cli/loop';

export {
 OWNER_START_SLACK_MS, WORKER_CHECK_MS, WORKER_START_SLACK_MS,
 coordinatorAccountPaused, ownerHolds, plannerAgent, plannerHolds, plannerPaused, recoveryRuns, waitForWork, workerHolds,
} from './coordinator-cli/holds';

export {
 REVISION_FRESH_MS, START_PLAN_WAIT_MS,
 archiveFinishedTasks, claimCoordinatorState, currentRevision, migrateCoordinatorJobs, migrateJobsAtStart, pauseCoordinator, plannerState, reconcile,
} from './coordinator-cli/state';

export {
 intakeRequests, settlePlanner,
} from './coordinator-cli/intake';

export {
 rulePassDue,
} from './coordinator-cli/rules';

export {
 fleetExpansionDemand, nativeDispatchReady,
} from './coordinator-cli/dispatch';

if(import.meta.main)await runCoordinatorCli().catch(e=>{console.error(String(e));process.exitCode=1;});
