# Coordinator progress export

Fresh fleet stock does not establish which model worker is running or when its last useful live result occurred. A progress export reads coordinator state, receipts and swarm observations without changing queue ownership or enabling work. Consumer: fleet-side ownership and idle/blocker inspection. A completed native qualification is preparation, not live game output.

Source -> local consumer -> reuse -> check: `packages/router/src/coordinator.ts` state and receipt schema, `scripts/fleet-sync.ts` fleet directory sync and `packages/core/src/fleet.ts` side routing -> `packages/router/src/coordinator-progress.ts` side evidence -> reuse the existing queue and fleet transport -> unit fixtures for model attribution, dead or unknown owners, blocked dependencies and stale observations. The process probe checks PID existence only; it never reads command lines or credentials. A PID being alive does not prove its identity.

The exporter and tests live under router tooling, outside the gameplay worker fingerprint. Deploying the observer does not change a qualified worker release.

The planner queue separates dependency-ready tasks, chains waiting on open work, and chains blocked by failed, `superseded` or missing prerequisites. Root counts include downstream pending tasks and finite runs. A task can have more than one root, so those counts do not predict how many runs one repair releases.

Source -> local consumer -> adapt -> check: the coordinator's explicit and account-provision dependencies, plus the reason-path pattern in the project use map -> the existing planner prompt -> count each terminal root once per affected task and include its run ID -> queue tests for two branches sharing a failed root, a failed implicit provision, waiting on an active proof, and independent work. The read-only queue sample in `.practice/planner-root-blockers/queue-summary.json` binds the counts to the observed state by hash. Model decisions and live throughput need separate evidence.

Source -> local consumer -> reuse -> check: the coordinator's sequence at worker settlement -> the planner trigger -> keep a receipt watermark at planner launch and a separate completion time for cooldowns -> test a late receipt with an older producer timestamp while the planner runs. The event sample in `.practice/planner-root-blockers/receipt-window.json` counts overlap and the time to the next plan. It does not identify why each plan starts.

The swarm writes a hashed job marker at each supervisor start. Autopilot reads complete result lines from matching marked runs. A finite coordinator job, a standing job with different arguments, or old unmarked output does not count as evidence to retire a standing job or advance its trainer.

Source -> local consumer -> reuse -> check: the swarm's mission signature and Luna's stable job identity pattern in the project use map -> the Autopilot result reader -> mark the existing log with a hash of the mission and planner assignment -> a mixed log fixture verifies legacy, foreign, matching and incomplete results. The dry CLI output in `.practice/autopilot-job-log-identity` distinguishes coordinator failures from standing failures. The periodic pass still reads skill observations when a log has no matching marker.
