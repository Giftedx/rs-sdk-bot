# Script contract

Acceptance for workers, shared helpers and accounts. Authority, pauses and account limits are in [AGENTS.md](../AGENTS.md). All gameplay techniques are authorized; a missing supply is acquisition work.

## Choose and reuse

1. Name the goal, the useful output, its consumer and the check.
2. Extend the existing home; parameterize account, server, target, supplies and limits. Never copy a worker per account.
3. Validate IDs, coordinates, XP, prices and quest rules against pinned content (`vendor/rs-sdk/server/content`, `knowledge/`).

| Need | Home |
|---|---|
| Session, actions, waits, walking | `packages/core/src/{bot,act,ticks,reflex,walk}.ts` |
| Quests (dialogue, steps, burst) | `scripts/generated/quest-lib.ts` |
| Accounts, admission, assignments | `scripts/swarm.ts`, `swarm.json`, `scripts/fleet.ts` |
| Status and quest observations | `packages/core/src/{status,quest-status}.ts` |
| Supply demand and routes | `packages/planner/src/{requirements,supply-route}.ts` |
| Whole-run model | `packages/planner/src/haggis.ts`, `haggis-boards.json` |
| Coverage scoreboard | `packages/router/src/coverage.ts`, `knowledge/actions.json` |
| Practice server and presets | `packages/practice/src/` |

## Define each worker

| Field | Meaning |
|---|---|
| Entry | Observed skills, quest flags, tools, location and supplies it needs |
| Budget | Tick limit, retries, food, fares and reserved stock |
| Progress | Product, quantity, costs and last useful effect, in its status file |
| Exit | Result, remaining assets and a confirmed logout |

Loop: observe, check requirements, act, confirm the effect, record, repeat. Confirm the product or quest flag; a click, SDK success or animation is not an effect. Bound every wait. On no progress, stop safely and report the first failed step. Never clear a block by restarting.

## Deliver a capability

Capability definitions live in `packages/router/tasks/<id>.json`: entry point, owned files, consumer and check commands. `bun run deliver <id>` runs the checks without a model call and writes logs to `.practice/deliveries/`. `stage: delivered` means those checks passed on those source bytes. It is not a live release.

**Acceptance bar.** A capability qualifies when:

1. Its own logic has unit tests that pass.
2. A practice run of the real worker CLI shows the useful effect in the saved account (XP, item, quest flag or banked stock).
3. Assets reconcile: nothing is lost beyond the declared costs.
4. Missing supplies, a stop file or a timeout end the run with a clear result and a confirmed logout.

Not required: proof of every failure window, independent decoders, purity of the proof tooling, or live results before the first live pilot.

**Review.** One independent review per build, by the other model. The reviewer approves unless it finds a concrete defect in the claimed scope: a wrong game action, asset loss, a death risk, an unbounded loop, a missing logout, a crash, or a broken existing caller. Each rejection names the file and line, the scenario and the consequence. Concerns outside the work order are notes for a later task, not rejections.

The review blocks delivery unless all of these hold (`reviewGate`, `packages/router/src/model-worker.ts`):

1. The build ran in its own workspace and changed only the capability's owned files.
2. Native qualification passed on that source.
3. The worker replays the 3 newest recorded runs of the capability that started before the build, and each replay is clean. The replay gets the build task's `replayAllow` command types: a command swapped for another within those types at the same tick counts as allowed, and the replay goes on comparing every later command.

The gate runs each replay in a scratch copy of the build's source with its own `.practice`, so a replayed worker never writes live receipts or status. A build that passes the gate delivers at once and writes `review-gate.json` in its run folder. Its review then runs as a `review` task (`<build id>-review`). A rejection stops the next runs of that capability, not a run already started, until a repair build changes the owned files. Those runs stay pending and start when the repair lands. The rejection shows as a failed review task in `bun run coordinate --status`, and the planner reads the held runs in `heldRuns`. Any other build delivers only after an approving verdict.

**Publish.** A delivered coordinator build writes its owned files into the main checkout (`publishWorkspace`, `packages/router/src/build-workspace.ts`).

1. Builds with overlapping owned files run one at a time (`buildOverlap`, `packages/router/src/coordinator.ts`). `chooseTask` holds a build while another build of the same capability, or a build that owns one of the same files, runs or waits to publish (`publish-request.json`). Builds on disjoint files run in parallel up to `coordination.maxActive`.
2. Publish compares each main file with the bytes the build started from (`.workspace-base/` in the workspace). An unchanged file is copied.
3. A main file that changed because an earlier delivery wrote it (its hash is in `.practice/coordinator/delivered-files.json`) gets a three-way merge of the build's change (`git merge-file`). Overlapping edits refuse the publish, and the error names the conflicting lines in main and in the build. Any other change to a main file refuses the publish.

**Delivery to master.** After a publish, the worker stages a pull request in `.practice/coordinator/delivery-prs/<task id>.json` (`packages/router/src/delivery-pr.ts`). It copies the build's version of each published file to `delivered/` in its run folder, and the bytes the build started from to `delivered-base/`. The coordinator then applies the build's change (base to build) to those files onto current `origin/master` with a three-way merge, in a temporary git worktree. It commits them to `coordinator/<task id>`, pushes that branch and opens a PR with `gh`. The PR body holds the task id and the qualification and review receipts.

- A master edit that overlaps the build's change stops the PR with state `conflict` and event `delivery-pr-conflict`, which name the lines. The owner resolves it by hand. The step never overwrites a newer master line.
- A request without base snapshots (staged by an older coordinator) stops with state `conflict`. The owner commits its `delivered/` files by hand.
- An earlier delivery of a file the build's source can run (the capability release of its entry, which follows literal worker paths, plus the import closure of its owned files; `deliverySourceSet`), staged before the build's workspace was prepared, is a prerequisite: the build's source already held its change. The PR opens only after each prerequisite PR merged (or had nothing to commit). Until then the request waits and checks again every 5 minutes.
- The commit never includes `swarm.json` or `.practice/`. The step never pushes master, never force-pushes and never merges.
- If the branch already exists on the remote, the step opens the PR from it and does not push again.
- If `git` or `gh` fails, the request stays `pending` and retries after 2, 4, 8 ... minutes, at most one hour apart. The coordinator opens PRs apart from its dispatch loop, so a failure never holds live delivery. Events: `delivery-pr-opened`, `delivery-pr-failed`.

**Run records.** Every session that `openBot` opens, live or practice, writes a per-tick record to `.practice/ticks/<script>/<account>-<startedAt>.ticks.ndjson.gz` (`packages/core/src/tick-record.ts`): each state publication as a delta of changed top-level keys, each command sent and each result. A synthetic skilling run (`tick-record-measure.ts`) costs 0.23-0.25 ms of process CPU per tick and 2.2-2.4 MB of gzip per 6,000 ticks. Each script keeps its 24 newest records. `TICK_RECORD=0` turns recording off. `bun packages/core/src/replay.ts <record> [--entry <script>]` runs the current worker against a record and prints the first tick where it sends a different command. A decision that reads the wall clock can differ on replay with no code change, and a replay serves one account per record.

**Live release.** Live starts need a `WORKER_RELEASE` pin (`packages/core/src/worker-release.ts`) that matches the qualified source. The first live run is a bounded pilot. A worker is batch-ready after two useful live runs.

**Release scope.** A release hash covers the files one process can run, not the whole tree (`releaseFiles`, `capabilityRevision`, `launchRevision`). An edit outside those files leaves the release, the qualification and live admission unchanged.

- The files are the entries, then every file they reach: relative imports (resolved like bun: exact path, `.js` to `.ts`, added `.ts`/`.tsx`/`.d.ts`/`.js`/`.mjs`/`.cjs`/`.json`, a folder's `package.json` `main` or `index`) and string literals that name a file or folder under `knowledge/`, `scripts/` or `packages/`, or a file under `vendor/` (`'../knowledge/npcs.json'`, `'scripts/generated'`, `'packages/core/src/host.ts'`, `'rsmod_bg.wasm'`). Consecutive literal arguments of one call are one path: `join(root,'knowledge','npcs.json')` names that file, and `join(root,'knowledge',name)` names the folder. A named code file is followed in turn. A named folder adds every file in it. A worker that reads data by a path built at runtime must name its folder in a literal. The literals of `worker-release.ts` and `launch-evidence.ts` do not count: they name files only to hash them.
- Every worker that imports the core pathing reads all of `knowledge/` (`packages/core/src/world.ts` `loadJson(name)`, `packages/knowledge/src/paths.ts` `knowledgeDir()`), so an edit to any knowledge file changes those releases.
- Every release also covers `vendor/rs-sdk/sdk`, `vendor/rs-sdk/server/webclient/src`, `package.json`, `bun.lock` and `tsconfig.json`. Test files are never in a release.
- An unresolved relative import, an import outside the repository or an `@rsbot/` workspace import stops the release with `no worker progress: release ...`. It is never skipped.
- The capability release (`capabilityRevision`) adds the worker launchers `packages/practice/src/supervise.ts` and `supervise-host.ts` to the job's entries. The entries are the job script and every job argument that names a repository code file (`workerEntries`: a `scripts/chain.ts` job's step scripts). The swarm starts each worker with `WORKER_RELEASE` and `WORKER_ENTRY` (the entries, comma-separated); the status row records both (`workRevision`, `workEntry`). `delivery-cli.ts` records the capability release of its entry as `runtimeRevision`; the coordinator compares deliveries, provision gates and live results, and a recovery permit compares its delivery, with the capability release of the same entry.
- The launch release (`launchRevision`) covers `scripts/swarm.ts`, both launchers and the recovery runner `packages/core/src/session-recovery.ts`. The controller runs with it, `swarm-owner.json` stores it, and a recovery permit, its runner and its lifecycle receipt bind to it. A process with no `WORKER_ENTRY` is checked against the launch release.
- A live start is held while an unfinished non-standing peer on the same server runs a stale release of its own entries (its `workRevision` differs from the current release of its `workEntry`). A row with no `workEntry` is compared with the launch release, so a worker started before the scoped release holds starts until it ends. Standing peers keep their exemption.
- The practice proofs in `packages/practice/src/*-proof.ts` and `scripts/supply-chain.ts` keep the whole-tree `workerSourceRevision` for their own evidence; it does not gate live starts.

## Prove and measure

Bind results to source, server, tick speed and starting state. Speed claims need three matched runs per condition with raw times and spread. Level, XP, bank value and net profit are different measures.

## Recover a session

A live start needs the account's logout proof (`packages/core/src/session-admission.ts` `liveLogoutRef`): the newest producer attempt ended `logged-out`. A session without that proof is held.

- On a server in `TAKEOVER_SERVERS` (`packages/core/src/session-takeover.ts`), a held session may start again by re-login when the attempt is the recorded latest and no owner process of an attempt after the last confirmed logout still runs. The new login attaches to the Player in the world; its own logout writes the next proof. A repair never uses this path.
- On every other server, a held session recovers only through the authenticated recovery path (`packages/core/src/session-recovery.ts`, `session-recovery-permit.ts`): one permitted login, modal cleanup, logout, producer proof. The live server is not in `TAKEOVER_SERVERS`.
- Add a server to `TAKEOVER_SERVERS` only with evidence that a re-login there attaches to the Player in the world, recorded in `research/community-and-upstream.md` 8.6. Never kill or take over a live session to collect it.

## Autonomous coordination

`packages/router/src/coordinator-cli.ts` runs one queue of `build`, `qualify`, `review`, `provision` and finite `run` tasks for Claude and Codex. `swarm.json.coordination` sets parallelism and planner limits; `swarm.json.jobs` holds the owner's live assignments and limits, and the coordinator never writes that file.

- The coordinator's own live state lives in `.practice/coordinator/jobs.json` (`packages/core/src/coordinator-jobs.ts`): the `run` jobs it installs (`coordinatorOwner: "coordinator"`, same job shape), the owner jobs it parks for a recovery, the delivery focus (`focusCapability`, `focusSince`), the granted fleet expansion (`expansion.maxBots` over the owner's `maxBots`; an owner edit of `maxBots` discards it) and the standing accounts a controller rollout pauses. `scripts/swarm.ts`, `scripts/fleet-agent.ts`, the planner and the recovery permit read both files as one plan: the owner's jobs, then each coordinator job in install order, each taking its accounts away from the owner job that names them. A coordinator that finds coordinator-owned jobs or focus settings in `swarm.json` moves them into its file at start.

- The planner reads the scoreboard, the plan and the queue. Every task names the scoreboard entries it moves. A planning round starts on a failure, on a success with no open consumer that can still run, or on a request, otherwise every 30 minutes. Outcomes wait until 5 minutes after the last round, so a burst shares one round; a request does not wait. A receipt that settles during a round counts as an outcome for the next one. After a failed round the next waits 1, 2, 4 ... minutes, at most 30 (`plannerDue`, `packages/router/src/coordinator-decisions.ts`).
- A pending task that depends on a task that can never succeed (status `failed` or `superseded`, or missing) retires 24 hours after that root ended (`retireDeadTasks`): its status becomes `superseded` with `supersededBy: dead-dependency:<root>`, and the coordinator writes a `tasks-retired` event. A run behind a failed `refresh-` qualification stays, because a source change links a new one. Main and specialist launches stay.
- Below 2 GiB free on the checkout's volume (`DISK_FLOOR_GB`) the coordinator starts no planner and no task. Running tasks finish. The events are `disk-low` and `disk-recovered`.
- Rules in `packages/router/src/coordinator-rules.ts` add the next finite run of a qualified chain with no model call, before any planning round and also when the planner fails. Rule `next-band`: the newest finished live run of a capability succeeded in the last 24 hours with one skill target on one ordinary account, and no supply run of another capability fed it; the rule queues the same worker on the same account to the next band (the next method unlock at least 5 levels up, else 10 levels, at most 99). It needs the current qualification source and an approved newest review. It adds no second open run of a capability for an account, keeps open rule runs within the live limit, and stops for a capability when its newest finished run is not a success. The planner keeps new capabilities, builds, repairs and supply.
- A build authors and proves in its own workspace (`../rs-sdk-bot-build/<capability>`, `packages/router/src/build-workspace.ts`). Only publishing its declared files into the main checkout waits for a drained fleet, so live runs continue during builds. Publish rules and delivery to master: [Deliver a capability](#deliver-a-capability), **Publish**.
- A focus capability holds development until its first useful live result or three failed builds in a row.
- Two failed builds of one capability in a row with one fault (the failing check and its failed cases, tests or error, `packages/router/src/build-fault.ts`) hold that capability's builds for 24 hours from the last failure. Host faults and timeouts do not count. A build task with `newEvidence` passes the first hold. A third matching failure waits out the time. The coordinator writes a `build-held` event, and the planner reads `heldBuilds`.
- A run needs a current qualification of the same capability. State, receipts and model output live in `.practice/coordinator/`. A finished task older than two days moves from `state.json` to the append-only `archive/tasks.jsonl`, unless an open task names it or it is the newest finished task of its capability and kind. A planner run's `input.json` names `state.json`; it does not copy it.

Commands: `bun run coordinate --status`, `--submit <proposal.json>`, `--plan`, `--stop`. To resume after a pause, remove `.practice/stop-coordinator` and start `bun run coordinate --run <owner-token>`.
