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

**Review.** One independent review per build. The reviewer approves unless it finds a concrete defect in the claimed scope: a wrong game action, asset loss, a death risk, an unbounded loop, a missing logout, a crash, or a broken existing caller. Each rejection names the file and line, the scenario and the consequence. Concerns outside the work order are notes for a later task, not rejections.

**Live release.** Live starts need a `WORKER_RELEASE` pin (`packages/core/src/worker-release.ts`) that matches the qualified source. The first live run is a bounded pilot. A worker is batch-ready after two useful live runs.

## Prove and measure

Bind results to source, server, tick speed and starting state. Speed claims need three matched runs per condition with raw times and spread. Level, XP, bank value and net profit are different measures.

## Autonomous coordination

`packages/router/src/coordinator-cli.ts` runs one queue of `build`, `qualify`, `review`, `provision` and finite `run` tasks for Claude and Codex. `swarm.json.coordination` sets parallelism and planner limits; `swarm.json.jobs` holds the owner's live assignments and limits, and the coordinator never writes that file.

- The coordinator's own live state lives in `.practice/coordinator/jobs.json` (`packages/core/src/coordinator-jobs.ts`): the `run` jobs it installs (`coordinatorOwner: "coordinator"`, same job shape), the owner jobs it parks for a recovery, the delivery focus (`focusCapability`, `focusSince`), the granted fleet expansion (`expansion.maxBots` over the owner's `maxBots`; an owner edit of `maxBots` discards it) and the standing accounts a controller rollout pauses. `scripts/swarm.ts`, `scripts/fleet-agent.ts`, the planner and the recovery permit read both files as one plan: the owner's jobs, then each coordinator job in install order, each taking its accounts away from the owner job that names them. A coordinator that finds coordinator-owned jobs or focus settings in `swarm.json` moves them into its file at start.

- The planner reads the scoreboard, the plan and the queue. Every task names the scoreboard entries it moves. A planning round starts on a new receipt, failure or request, otherwise every 30 minutes.
- A build authors and proves in its own workspace (`../rs-sdk-bot-build/<capability>`, `packages/router/src/build-workspace.ts`). Only publishing its declared files into the main checkout waits for a drained fleet, so live runs continue during builds. A main checkout changed since the build started refuses the publish.
- A focus capability holds development until its first useful live result or three failed builds in a row.
- A run needs a current qualification of the same capability. State, receipts and model output live in `.practice/coordinator/`. A finished task older than two days moves from `state.json` to the append-only `archive/tasks.jsonl`, unless an open task names it or it is the newest finished task of its capability and kind. A planner run's `input.json` names `state.json`; it does not copy it.

Commands: `bun run coordinate --status`, `--submit <proposal.json>`, `--plan`, `--stop`. To resume after a pause, remove `.practice/stop-coordinator` and start `bun run coordinate --run <owner-token>`.
