# Coordinator progress export

Fresh fleet stock does not establish which model worker is running or when its last useful live result occurred. A progress export reads coordinator state, receipts and swarm observations without changing queue ownership or enabling work. Consumer: fleet-side ownership and idle/blocker inspection. A completed native qualification is preparation, not live game output.

Source -> local consumer -> reuse -> check: `packages/router/src/coordinator.ts` state and receipt schema, `scripts/fleet-sync.ts` fleet directory sync and `packages/core/src/fleet.ts` side routing -> `packages/router/src/coordinator-progress.ts` side evidence -> reuse the existing queue and fleet transport -> unit fixtures for model attribution, dead or unknown owners, blocked dependencies and stale observations. The process probe checks PID existence only; it never reads command lines or credentials. A PID being alive does not prove its identity.

The exporter and tests live under router tooling, outside the gameplay worker fingerprint. Deploying the observer does not change a qualified worker release.

The planner queue separates dependency-ready tasks, chains waiting on open work, and chains blocked by failed, `superseded` or missing prerequisites. Root counts include downstream pending tasks and finite runs. A task can have more than one root, so those counts do not predict how many runs one repair releases.

Source -> local consumer -> adapt -> check: the coordinator's explicit and account-provision dependencies, plus the reason-path pattern in the project use map -> the existing planner prompt -> count each terminal root once per affected task and include its run ID -> queue tests for two branches sharing a failed root, a failed implicit provision, waiting on an active proof, and independent work. The read-only queue sample in `.practice/planner-root-blockers/queue-summary.json` binds the counts to the observed state by hash. Model decisions and live throughput need separate evidence.
