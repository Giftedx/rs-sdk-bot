# Coordinator progress export

Fresh fleet stock does not establish which model worker is running or when its last useful live result occurred. A progress export reads coordinator state, receipts and swarm observations without changing queue ownership or enabling work. Consumer: fleet-side ownership and idle/blocker inspection. A completed native qualification is preparation, not live game output.

Source -> local consumer -> reuse -> check: `packages/router/src/coordinator.ts` state and receipt schema, `scripts/fleet-sync.ts` fleet directory sync and `packages/core/src/fleet.ts` side routing -> `packages/router/src/coordinator-progress.ts` side evidence -> reuse the existing queue and fleet transport -> unit fixtures for model attribution, dead or unknown owners, blocked dependencies and stale observations. The process probe checks PID existence only; it never reads command lines or credentials. A PID being alive does not prove its identity.

The exporter and tests live under router tooling, outside the gameplay worker fingerprint. Deploying the observer does not change a qualified worker release.

Source -> local consumer -> adapt -> check: the repository's LF checkout rule and the existing three-way merge -> delivery PR application -> compare the three text inputs with LF line endings -> a Windows fixture keeps an unrelated master edit and the staged build edit. The saved snapshot replay in `.practice/delivery-root-blockers/merge-replay.json` separates clean courier and magic merges from overlapping rune edits and a combat snapshot with a missing base. The replay leaves the delivery records and live checkout untouched.

The planner queue separates dependency-ready tasks, chains waiting on open work, and chains blocked by failed, `superseded` or missing prerequisites. Root counts include downstream pending tasks and finite runs. A task can have more than one root, so those counts do not predict how many runs one repair releases.

Source -> local consumer -> adapt -> check: the coordinator's explicit and account-provision dependencies, plus the reason-path pattern in the project use map -> the existing planner prompt -> count each terminal root once per affected task and include its run ID -> queue tests for two branches sharing a failed root, a failed implicit provision, waiting on an active proof, and independent work. The read-only queue sample in `.practice/planner-root-blockers/queue-summary.json` binds the counts to the observed state by hash. Model decisions and live throughput need separate evidence.

Source -> local consumer -> reuse -> check: the coordinator's sequence at worker settlement -> the planner trigger -> keep a receipt watermark at planner launch and a separate completion time for cooldowns -> test a late receipt with an older producer timestamp while the planner runs. The event sample in `.practice/planner-root-blockers/receipt-window.json` counts overlap and the time to the next plan. It does not identify why each plan starts.

The deterministic rules pass uses that same settled-receipt sequence. Archive compaction cannot hide a settlement or trigger a rules pass on its own. The five-minute recheck still covers other changes.

Source -> local consumer -> reuse -> check: the coordinator receipt watermark -> rules dispatch -> compare the watermark rather than retained receipt count -> a fixture archives one receipt and settles one while the count stays at two. It also checks the periodic recheck boundary.


Autopilot keeps the standing assignment for an account shadowed by the coordinator, including a parked coordinator job. That account is ineligible for reassignment, coin funding and trainer polling while the overlay holds it.

Source -> local consumer -> reuse -> check: the coordinator job overlay and Luna's stable job ownership pattern in the project use map -> Autopilot -> preserve standing job bytes and exclude held accounts before planning or funding -> a release fixture and an isolated CLI pass preserve the held job and its assignment history while placing a free account. The CLI proof is in `.practice/autopilot-coordinator-ownership/cli-proof.json`. A live handoff needs separate evidence.

The swarm writes a hashed job marker at each supervisor start. Autopilot reads complete result lines from matching marked runs. A finite coordinator job, a standing job with different arguments, or old unmarked output does not count as evidence to retire a standing job or advance its trainer.

Source -> local consumer -> reuse -> check: the swarm's mission signature and Luna's stable job identity pattern in the project use map -> the Autopilot result reader -> mark the existing log with a hash of the mission and planner assignment -> a mixed log fixture verifies legacy, foreign, matching and incomplete results. The dry CLI output in `.practice/autopilot-job-log-identity` distinguishes coordinator failures from standing failures. The periodic pass still reads skill observations when a log has no matching marker.

A bounded worker failure receipt keeps the supervisor's terminal reason and the worker's result if the current status matches the same account, server, source and run before that end. If the status is missing or mismatched, the receipt keeps only the supervisor reason.

Source -> local consumer -> reuse -> check: the coordinator's live acceptance identity check and Luna's settled job evidence pattern -> the failure receipt and planner -> reuse the identity check for a bounded diagnostic -> a regression covers the matching failure, another run, an older source and a later observation. The diagnostic does not count as acceptance or authorize a retry.

Source -> local consumer -> reuse -> check: the build workspace's recorded SHA-256 base and publish's preflight -> staged delivery merge -> recover a missing base from main only while its bytes match the recorded hash -> a carried build fixture publishes and stages both the original and changed bytes. A run's pre-author copy may already contain carried edits, so it cannot stand in for the original base without a hash match.

## Planner rounds and dead tasks

Over 7 days the coordinator started 1,117 planning rounds. Each round has a prompt of about 150 KB and a median length of 130 s. In the 48 hours to the same point, 86 of 178 accepted rounds added no task. A success whose consumer was already queued started 252 rounds in the 7 days, and 192 of those added no task. A replay of the receipts gives 1,119 rounds under the old trigger and 727 under `plannerDue` with the 5-minute gap. Conditions: `.practice/coordinator/events.jsonl` and `state.json`, plan length fixed at 130 s. Gap: the replay counts rounds. It does not measure how much later a repair starts.

All 64 pending tasks in `state.json` depended on a failed task, and none could start. The queue section of the prompt falls from 64 KB to 26 KB when the 37 tasks with a root older than 24 hours retire. Gap: the replay ran on a copy of the state. The first live retirement is not observed.

Of 536 finished runs in 7 days, 336 failed, for 12.4 hours of run time. The worker refused 43 of them at start because the newest review of the capability rejected its source. Those runs now wait in the queue. A retry system for `live admission waiting: memory` has no value: the 23 such failures in the record have no consumer.

A full disk on the checkout's volume stopped the coordinator for about 35 hours, with 4,059 ENOSPC events. `DISK_FLOOR_GB` is 2 GiB by judgement. No measurement sets that number.

`packages/router/test/coordinator-composed-recovery.test.ts` reads the free memory of the host. It fails with `live admission waiting: memory` when RAM is low, on master and on this change.
