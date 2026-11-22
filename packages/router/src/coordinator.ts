// Durable orchestration above the existing author, delivery and swarm paths.
// Task counts are coordination metrics, never percentages of game completion.
export {
 boundAccounts,
 GOALS,
 NEW_EVIDENCE_MAX,
 ARCHIVE_AFTER_MS,
 finishedAt,
 usefulLiveReceipt,
 initialState,
 provisionRefs,
 type GoalId,
 type Effect,
 type CoordTask,
 type Receipt,
 type TaskRecord,
 type CapabilityChange,
 type CoordinatorState,
} from './coordinator/types';
export {
 validateTask,
 addTasks,
 replaceTasks,
 compactState,
 startTask,
 finishTask,
} from './coordinator/tasks';
export {
 orderOnlyDependency,
 coveredQualification,
 dependencyMet,
 needsFreshQualification,
 recoverySlotBusy,
 deadRoots,
 preparedProvisionRuns,
 preparedProvisionClaims,
} from './coordinator/dependencies';
export {
 preparedNativeDelivery,
 FOCUS_FAILURE_LIMIT,
 failedBuildStreak,
 BUILD_HOLD_MS,
 repeatedBuildFault,
 heldBuilds,
 activeBuildFocus,
} from './coordinator/builds';
export {
 qualificationDemand,
 qualificationRefreshCapabilities,
 refreshQualifications,
} from './coordinator/qualifications';
export {
 fleetExpansion,
 chooseTask,
 buildWorkOrder,
} from './coordinator/schedule';
export {
 boundedWorkerEndMessage,
 acceptStatus,
} from './coordinator/status';
