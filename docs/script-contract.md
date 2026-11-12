# Script contract

Acceptance for workers, shared helpers and accounts. Authority, pauses and account limits are in [AGENTS.md](../AGENTS.md). All gameplay techniques are authorized; a missing supply is acquisition work.

## Choose and reuse

1. Name the goal, the useful output, its consumer and the check.
2. Extend the existing home; parameterize account, server, target, supplies and limits. Never copy a worker per account.
3. Validate IDs, coordinates, XP, prices and quest rules against pinned content (`vendor/rs-sdk/server/content`, `knowledge/`).

| Need | Home |
|---|---|
| Session, actions, waits, walking | `packages/core/src/{bot,act,ticks,reflex,walk}.ts` |
| Sustain, bank trips, order journals | `packages/core/src/{sustain,bank-trip,order-journal}.ts` |
| All-in-one dispatcher & catalog | `scripts/aio.ts` |
| Skilling (15 skills, gathering, artisan, RC, support) | `scripts/aio-skiller.ts`, `scripts/microbot-bank-jobs.ts` |
| Combat & monster drop farming | `scripts/aio-fighter.ts`, `scripts/gather-combat.ts` |
| Bosses & minigames (KBD, Blue Dragon, Black Dragon, Trawler) | `scripts/aio-boss.ts`, `scripts/microbot-combat-trip.ts`, `scripts/black-dragon-camp.ts` |
| Wilderness PvP, tribrid & escort | `scripts/aio-pvp.ts`, `scripts/{pk,pk-hunt,pk-roam}.ts` |
| Quests & clues (dialogue, steps, sweep, burst) | `scripts/aio-quester.ts`, `scripts/generated/quest-lib.ts` |
| Shops & Grand Exchange | `scripts/aio-market.ts`, `scripts/{shop-buyer,buy-owned-ge-item}.ts` |
| Couriers, RC runners, loadouts & relocation | `scripts/aio-logistics.ts`, `scripts/courier-handoff.ts` |
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

- A planner-created or updated capability definition has a recorded transition in `.practice/coordinator/capability-history`. When the build qualifies that exact definition, the delivery includes its bytes and the recorded base. The PR can apply the qualified definition over its recorded base or find it already present. A different master definition stops the PR for reconciliation.

- A master edit that overlaps the build's change stops the PR with state `conflict` and event `delivery-pr-conflict`, which name the lines. The owner resolves it by hand. The step never overwrites a newer master line.
- A request without base snapshots (staged by an older coordinator) stops with state `conflict`. The owner commits its `delivered/` files by hand.
- An earlier delivery of a file the build's source can run (the capability release of its entry, which follows literal worker paths, plus the import closure of its owned files; `deliverySourceSet`), staged before the build's workspace was prepared, is a prerequisite: the build's source already held its change. The PR opens only after each prerequisite PR merged (or had nothing to commit). Until then the request waits and checks again every 5 minutes.
- The commit never includes `swarm.json` or `.practice/`. The step never pushes master, never force-pushes and never merges.
- When reusing a remote branch or an existing PR, the step checks the staged qualified definition at the observed head commit. A missing or different definition stops the delivery as a conflict. A matching head is reused without another push.
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

### Specialist launch

Shaftshooter uses the Ranged board. Polevaulter uses the Agility board. The coordinator accepts one reserved account with a level 99 target and no prior live session attempt. The first login requires fresh bound evidence and a ticket for the installed run, worker release and exact assignment. The first-login window is at most 10 minutes. The same active run can reconnect within its original deadline after a ready session records a server-confirmed logout for that ticket. A stop file, terminal result or uncertain logout holds the run.

- Create `.practice/specialist-launch`. Save a current 400 ms record snapshot with `bun packages/planner/src/scout-cli.ts --out=.practice/specialist-launch/hiscores.json --fresh-account=shaftshooter --fresh-account=polevaulter`. The snapshot and exact-account HTTP 404 observation must be under one hour old. For a level 99 record, both the planned and rehearsed clock must beat the record by at least 2%.
- In `vendor/rs-sdk/server/engine`, install the pinned engine dependencies with `bun install --frozen-lockfile --production --ignore-scripts`.
- Run `bun packages/practice/src/rehearse.ts --specialist <segment.json> --start --out <new-.practice-directory>`. Set `id`, `specialist`, `start: {fresh: true}`, `script`, `plan: {ticks, source}` and `expect: {skills: {<board>: 99}}`. Use the live worker’s `args` and `env`. Set the worker tick cap for the full route. Set `timeoutMs` above the planned ticks times 400 ms, with time for login and logout. The isolated engine uses 400 ms ticks and 25x XP. The runner uses a new practice account with no save and disables the GE.
- The runner writes a `.candidate.json` and `.receipt.json` after one continuous run reaches level 99 and logs out. It binds the saved clock, engine trade ledger and worker tick record. If the candidate lists external stock, attach verified `staging` before using it as the launch plan.
- Use `.practice/specialist-launch/<lowercase-account>.json` with `version: 1`, `account`, `board` (the skill name), `context`, `planTicks`, `requirements`, and a hash binding `rehearsal`. The context is `specialistContext(account, source, mission, requirements)`. Use the installed job's mission signature with an empty `COORDINATOR_RUN_ID`. A requirement has `item`, `count`, and an optional exact `itemId`.
- Bind one complete fresh-clock practice run of the same route. Use the main rehearsal receipt shape with the skill name as the sole board stamp. The receipt and its matching raw `REHEARSAL` record include `externalSupplies` from the rehearsal's observed external inputs. The raw log also records a successful result. A route that draws stock needs a `staging` hash binding with exact reservations, owned delivery and bank observations for that specialist. An empty requirement list is for a route that draws no external stock.

## Prove and measure

Bind results to source, server, tick speed and starting state. Speed claims need three matched runs per condition with raw times and spread. Level, XP, bank value and net profit are different measures.

### The AIO bench

`bun run bench [pattern]` measures AIO routes on practice and prints one table: the ticks of each case, the stored baseline, the change, the XP over all skills for each 1,000 ticks, and the rival's stated ticks where one is known.

- **Cases.** `scripts/measure/aio-bench-cases.ts` holds one case for each AIO catalog route that has one: the dispatcher, its arguments and the start preset. A case marked `known` cannot pass and names the cause; a default run skips it and coverage does not count it. `bun run bench --coverage` lists the routes with no case.
- **Engine.** A run uses the lockstep engine ([patches/rs-sdk.md](../patches/rs-sdk.md) item 10) with one seed and a new engine for each case. With these conditions a case gives the same tick count on each run, so one run for each condition is a comparison. The three-run rule above applies to a wall-clock engine (`--wall-clock`; `BENCH_TICK_MS` sets its tick length, 150 by default and 400 for the live length).
- **Trace.** `BENCH_TRACE=<dir>` writes two engine files for each case: `<case>.trace`, a hash of the world for each tick, and `<case>.actions`, what the engine did with each message from a bot and which NPC could hunt it. Read `<case>.actions` first when an action has no effect.
- **Selection.** A pattern is a regular expression on the case key (`cook`, `^quester:quest:`). `--smoke` runs the short set that touches each category. `--all` includes the `known` cases.
- **A change.** Run the cases the change touches. `--set KEY=value` sets one worker environment value for the run. A change is accepted for a case when the case passes and its ticks are not above the baseline. `--save-baseline` stores the results of the run as the baseline for its seed.
- **A case that ends at a tick cap.** Its ticks show no speed. The case names the useful amount in its RESULT line (`output`: coins, items, kills), and the table shows the amount for each 1,000 ticks against the baseline.
- **Several seeds.** `--seeds 7,8,9` runs the selection once for each seed and prints the pass count of each case. A case that fails at some seeds depends on a random roll it does not recover from.
- **Watch.** `--watch` runs the selection again each time a file under `scripts/` or `packages/` changes.
- **Output.** `.practice/aio-bench/output/<case>.log` holds the whole output of the last run of each case.
- **Kept results.** A result is kept under a hash of the seed, the case, its preset, the worker script with the files it imports, the vendor patch and the `Q_*` and `--set` values. A case with no change in these returns its kept result. A change to a data file a worker reads at run time is not in the hash; use `--no-keep` after one.
- **Limits.** The bench shows ticks on a practice engine with every skill at the preset level. It does not show a live result. A lockstep tick holds while a script works off the tick clock, up to `SIM_BUSY_MS`; a wall-clock sleep in a worker therefore costs real time and no ticks.


## Recover a session

A live start needs the account's logout proof (`packages/core/src/session-admission.ts` `liveLogoutRef`): the newest producer attempt ended `logged-out`. A session without that proof is held.

- On a server in `TAKEOVER_SERVERS` (`packages/core/src/session-takeover.ts`), a held session may start again by re-login when the attempt is the recorded latest and no owner process of an attempt after the last confirmed logout still runs. The new login attaches to the Player in the world; its own logout writes the next proof. A repair never uses this path.
- On every other server, a held session recovers only through the authenticated recovery path (`packages/core/src/session-recovery.ts`, `session-recovery-permit.ts`): one permitted login, modal cleanup, logout, producer proof. The live server is not in `TAKEOVER_SERVERS`.
- Add a server to `TAKEOVER_SERVERS` only with evidence that a re-login there attaches to the Player in the world, recorded in `research/community-and-upstream.md` 8.6. Never kill or take over a live session to collect it.

## Autonomous coordination

`packages/router/src/coordinator-cli.ts` runs one queue of `build`, `qualify`, `review`, `provision` and finite `run` tasks for Claude and Codex. `swarm.json.coordination` sets parallelism and planner limits; `swarm.json.jobs` holds the owner's live assignments and limits, and the coordinator never writes that file.

- The coordinator's own live state lives in `.practice/coordinator/jobs.json` (`packages/core/src/coordinator-jobs.ts`): the `run` jobs it installs (`coordinatorOwner: "coordinator"`, same job shape), the owner jobs it parks for a recovery, the delivery focus (`focusCapability`, `focusSince`), the granted fleet expansion (`expansion.maxBots` over the owner's `maxBots`; an owner edit of `maxBots` discards it) and the standing accounts a controller rollout pauses. `scripts/swarm.ts`, `scripts/fleet-agent.ts`, the planner and the recovery permit read both files as one plan: the owner's jobs, then each coordinator job in install order, each taking its accounts away from the owner job that names them. A coordinator that finds coordinator-owned jobs or focus settings in `swarm.json` moves them into its file at start.

- Provisioning needs a current qualification for a finite first job. For a job with several accounts, the coordinator checks the known participants before dispatch, before the shared name reservation and again in the registration process before it connects. A pause, conflicting assignment or unsettled session holds the claim.
- When the swarm has an owner stop file, autopilot holds its assignments, orders, and account stop files. A dry run can still show the plan.
- The planner reads the scoreboard, the plan and the queue. Every task names the scoreboard entries it moves. A planning round starts on a failure, on a success with no open consumer that can still run, or on a request, otherwise every 30 minutes. Outcomes wait until 5 minutes after the last round, so a burst shares one round; a request does not wait. A receipt that settles during a round counts as an outcome for the next one. After a failed round the next waits 1, 2, 4 ... minutes, at most 30 (`plannerDue`, `packages/router/src/coordinator-decisions.ts`).
- An ordinary pending task retires after both the task and its oldest dead prerequisite are at least 24 hours old (`retireDeadTasks`). A dead prerequisite has status `failed` or `superseded`, or is missing. A missing prerequisite uses the pending task's age. The retired task becomes `superseded` with `supersededBy: dead-dependency:<root>`, and the coordinator writes a `tasks-retired` event. A failed `refresh-` qualification can be replaced when source changes, so it does not start this clock for a run. Main and specialist launches stay.
- Below 2 GiB free on the checkout's volume (`DISK_FLOOR_GB`) the coordinator starts no planner and no task. Running tasks finish. The events are `disk-low` and `disk-recovered`.
- Rules in `packages/router/src/coordinator-rules.ts` add the next finite run of a qualified chain with no model call, before any planning round and also when the planner fails. Rule `next-band`: the newest finished live run of a capability succeeded in the last 24 hours with one skill target on one ordinary account, and no supply run of another capability fed it; the rule queues the same worker on the same account to the next band (the next method unlock at least 5 levels up, else 10 levels, at most 99). It needs the current qualification source and an approved newest review. It adds no second open run of a capability for an account, keeps open rule runs within the live limit, and stops for a capability when its newest finished run is not a success. The planner keeps new capabilities, builds, repairs and supply.
- A build authors and proves in its own workspace (`../rs-sdk-bot-build/<capability>`, `packages/router/src/build-workspace.ts`). The publish of its declared files into the main checkout takes the build lock (`.practice/coordinator/build-lock.json`) and waits up to 45 minutes for another holder. The lock holds new live starts while the files are copied. The publish does not wait for the fleet to drain: a live run keeps the release it started on, so live runs continue during builds. Publish rules and delivery to master: [Deliver a capability](#deliver-a-capability), **Publish**.
- The fleet agent runs `bun packages/router/src/live-update.ts` before each sync. It fast-forwards a main checkout on `master` to `origin/master`. It waits while a qualification runs, a build waits to publish, the build lock is held, a running build owns a changed file, a live coordinator run loads a changed file, or a dependency manifest changes. A live run keeps the release it started on, and a new coordinator run refuses to start beside a run on another release (`assertCompatibleWorkers`). A changed file with a local edit stops the update unless the file already holds the bytes of master (a published delivery); the `RESULT` line names the file. After a move, `.practice/live-update.json` names the daemons whose import closure changed: the fleet agent and the autopilot start a copy of themselves, the coordinator reloads with its children kept, and the coordinator rolls the swarm out when the swarm's own files changed (`ensureSwarm`). `LIVE_UPDATE=0` turns the update off and `.practice/stop-live-update` pauses it.
- A focus capability holds development until its first useful live result or three failed builds in a row.
- Two failed builds of one capability in a row with one fault (the failing check and its failed cases, tests or error, `packages/router/src/build-fault.ts`) hold that capability's builds for 24 hours from the last failure. Host faults and timeouts do not count. A build task with `newEvidence` passes the first hold. A third matching failure waits out the time. The coordinator writes a `build-held` event, and the planner reads `heldBuilds`.
- A run needs a current qualification of the same capability. State, receipts and model output live in `.practice/coordinator/`. A finished task older than two days moves from `state.json` to the append-only `archive/tasks.jsonl`, unless an open task names it or it is the newest finished task of its capability and kind. A planner run's `input.json` names `state.json`; it does not copy it.

Commands: `bun run coordinate --status`, `--submit <proposal.json>`, `--plan`, `--stop`. To resume after a pause, remove `.practice/stop-coordinator` and start `bun run coordinate --run <owner-token>`.

The coordinator saves the validated queue and its pending submission record together, publishes the recorded capability changes, then acknowledges the proposal. A manual submission gets the `.accepted` suffix. A model proposal gets `plan-accepted.json` beside `proposal.json` in its run directory. The coordinator retries the pending submission before dispatch after a failed write or restart. A proposal or definition that conflicts with the saved bytes holds dispatch until the conflict is resolved.
