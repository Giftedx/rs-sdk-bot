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
| Skilling (gathering, artisan, agility, runecraft) | `scripts/aio-skiller.ts`, `packages/workers/src/{gather,bank-artisan,agility,runecraft}/` |
| Combat, bosses & minigames (KBD, dragons, trawler) | `scripts/aio-fighter.ts`, `scripts/aio-boss.ts`, `packages/workers/src/combat/` |
| Wilderness PvP, tribrid & escort | `scripts/aio-pvp.ts`, `scripts/{pk,pk-squad}.ts`, `packages/workers/src/pvp/` |
| Quests & clues (dialogue, steps, sweep, burst) | `scripts/aio-quester.ts`, `scripts/generated/quest-lib.ts`, `packages/workers/src/quest/` |
| Shops & Grand Exchange | `scripts/aio-market.ts`, `packages/workers/src/market/` |
| Couriers, RC runners, loadouts & relocation | `scripts/aio-logistics.ts`, `packages/workers/src/logistics/` |
| Fleet Brain planning, catalog, demand & scheduler | `packages/brain/src/{snapshot,catalog,demand,planner,scheduler,campaigns,missions}.ts` |
| Accounts, admission, controllers, recovery | `packages/fleet/src/{swarm,fleet-agent,fleet-sync,watchdog,session-recovery,brain-runtime}.ts`, `swarm.json` |
| Status and quest observations | `packages/core/src/{status,quest-status}.ts` |
| Supply demand and routes | `packages/planner/src/{requirements,supply-route}.ts` |
| Whole-run model | `packages/planner/src/haggis.ts`, `haggis-boards.json` |
| Practice server, unified bench and rehearsals | `packages/practice/src/`, `scripts/measure/aio-practice-bench.ts` |

Every game script is in the catalog: `bun scripts/aio.ts --list` prints it. Give a new worker a route in its `scripts/aio-<category>.ts` file. `scripts/aio-reach.test.ts` fails for a script under `scripts/`, `scripts/generated/` or `scripts/pk-live/` that no route reaches. A script that is not game work (a tool, a report, fleet control) goes in `OUTSIDE_CATALOG` of `tools/script-index.ts` with its cause. To find a script by what it does, run `bun tools/script-index.ts [word ...]`: it prints one line for each file under `scripts/`, `tools/` and each command file under `packages/`, with its group and its description (the route description, the `OUTSIDE_CATALOG` cause, the header comment, or last a line in `tools/script-descriptions.ts`).

## Define each worker

| Field | Meaning |
|---|---|
| Entry | Observed skills, quest flags, tools, location and supplies it needs |
| Budget | Tick limit, retries, food, fares and reserved stock |
| Progress | Product, quantity, costs and last useful effect, in its status file |
| Exit | Result, remaining assets and a confirmed logout |

Loop: observe, check requirements, act, confirm the effect, record, repeat. Confirm the product or quest flag; a click, SDK success or animation is not an effect. Bound every wait. On no progress, stop safely and report the first failed step. Never clear a block by restarting.

A repair must bind its evidence to the failed source, entry state and first failed step. Practice must reach that step and prove the repaired behavior with reconciled assets and logout. The next live run needs a finite unmet target, a budget and a named consumer. If the target is complete, replace the job instead of repeating it. A session recovery proves account access and logout. It does not qualify the failed gameplay path.

## Qualify a worker capability

Every worker family in `packages/workers/` implements `WorkerModule<Cfg>` (`preflight()`, `estimate()`, `run()`). Ordinary accounts run any activity whose catalog trust tier is at least `practice_passed`; protected clocks (`Haggis` and reserved specialists in `packages/core/src/specialist-boards.ts`) require isolated rehearsal, verified staged supplies, and a fresh hiscore margin check.

**Acceptance bar.** A capability qualifies when:

1. Its own logic has unit tests that pass.
2. Its `bun run bench` case (or practice proof script) passes on the lockstep practice engine with useful effect in the saved account (XP, item, quest flag, or banked stock).
3. Assets reconcile: nothing is lost beyond the declared costs.
4. Missing supplies, a stop file, or a timeout end the run with a clear `RESULT` and a confirmed logout.

Not required: proof of every failure window, independent decoders, purity of the proof tooling, or live results before the first live pilot.

**Run records.** Every session that `openBot` opens, live or practice, writes a per-tick record to `.practice/ticks/<script>/<account>-<startedAt>.ticks.ndjson.gz` (`packages/core/src/tick-record.ts`): each state publication as a delta of changed top-level keys, each command sent, and each result. Each script keeps its 24 newest records (`TICK_RECORD=0` turns recording off). `bun packages/core/src/replay.ts <record> [--entry <script>]` runs the current worker against a record and prints the first tick where it sends a different command.

**Live release.** Live starts need a `WORKER_RELEASE` pin (`packages/core/src/worker-release.ts`) matching the current checkout. Release hashes cover the runtime closure of the entry scripts and `knowledge/`, `vendor/rs-sdk/sdk`, `vendor/rs-sdk/server/webclient/src`, `package.json`, `bun.lock`, and `tsconfig.json`. Test files and `packages/dashboard/` are excluded from worker release hashes. An unresolved relative import, an import outside the repository, or an `@rsbot/` workspace import stops the release with `no worker progress: release ...`.

A live start is held while an unfinished non-standing peer on the same server runs a stale release of its own entries (`workRevision` differs from the current release of its `workEntry`). Standing peers keep their exemption.

### Specialist launch

Shaftshooter uses the Ranged board, Polevaulter the Agility board and Hiltsdeep the Attack board (`packages/core/src/specialist-boards.ts`; a name there is never given to an ordinary account). The coordinator accepts one reserved account with a level 99 target and no prior live session attempt. The first login requires fresh bound evidence and a ticket for the installed run, worker release and exact assignment. The first-login window is at most 10 minutes. The same active run can reconnect within its original deadline after a ready session records a server-confirmed logout for that ticket. A stop file, terminal result or uncertain logout holds the run.

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
- **Engine.** A run uses the lockstep engine ([patches/rs-sdk.md](../patches/rs-sdk.md) item 10) with one seed and a new engine for each case. Lockstep (`SIM_LOCKSTEP=1`), Windows fine timers (`SIM_FINE_TIMERS=0` opts out), and no-gateway in-process connections (`gateway: false`) are the permanent defaults across `bun run bench` and isolated rehearsals (`packages/practice/src/rehearse.ts`; `REHEARSE_REALTIME=1` opts out). With these conditions a case gives the same tick count on each run, so one run for each condition is a comparison. The three-run rule above applies to a wall-clock engine (`--wall-clock`; `BENCH_TICK_MS` sets its tick length, 150 by default and 400 for the live length).
- **Budget and profile.** A bench run is at most 10 minutes by default (`--budget`), estimated from the last wall time of each case (`--over-budget` only for an owner-requested run). When a case takes over a minute, run it with `--profile`: a capped tick costs 2 s wall time and 0 game ticks, so fix the cause of every capped tick.
- **Start check.** Before its first engine a run checks that the start is safe (`scripts/measure/bench-start-check.ts`). The run stops with one line and exit code 2 for each of three causes. The line names the cause.
  - A different heavy job runs on the machine: a `bun` process outside this run that runs `aio-practice-bench.ts`, `ci-gate.ts` or `test-shards.ts`. The line gives each pid and script.
  - An engine port of the run has a listener. The first engine uses `BENCH_PORT_BASE` (21000 by default), and each further engine uses a port 10 higher.
  - The free memory is under the floor of `tools/heavy-admission.ts` plus 0.9 GiB for each engine of the run.

  Of two benches that start at one time, the first runs. `--wait <minutes>` checks again each 10 s. It starts the run when the start is safe, and it stops with the same line when the time is over. `--force` skips the check. A run that has a kept result for each case starts no engine and does no check.
- **Trace.** `BENCH_TRACE=<dir>` writes two engine files for each case: `<case>.trace`, a hash of the world for each tick, and `<case>.actions`, what the engine did with each message from a bot and which NPC could hunt it. Read `<case>.actions` first when an action has no effect.
- **Selection.** A pattern is a regular expression on the case key (`cook`, `^quester:quest:`). `--smoke` runs the short set that touches each category. `--all` includes the `known` cases.
- **A change.** Run the cases the change touches. `--set KEY=value` sets one worker environment value for the run. A change is accepted for a case when the case passes and its ticks are not above the baseline. `--save-baseline` stores the results of the run as the baseline for its seed.
- **A case that ends at a tick cap.** Its ticks show no speed. The case names the useful amount in its RESULT line (`output`: coins, items, kills), and the table shows the amount for each 1,000 ticks against the baseline.
- **Several seeds.** `--seeds 7,8,9` runs the selection once for each seed and prints the pass count of each case. Run the seeds of a set at once (`bun run bench <case> --seeds 1,2,3,4 --seed-jobs 4`), not one after another. A case that fails at some seeds depends on a random roll it does not recover from.
- **Hosted bench and practice.** While live bots run on the PC, use GitHub Actions as the default path for multi-seed optimization and bench runs so local fleet memory stays free: `bun tools/hosted-bench.ts '<pattern> [<pattern> ...]' [--seeds 7,8,9] [--args '--profile --set KEY=value']` runs each pattern and seed on its own clean runner inside the 10-minute budget (workflow inputs `bench_pattern`, `bench_seeds`, `bench_args`, `bench_ref`; read each job result and its saved source hashes). For full quest delivery and fleet receiver proof on a clean runner, run `gh workflow run CI --ref <branch> -f native_practice=true` (add `-f native_quest=false` for the receiver proof alone). Hosted practice proves practice only; live admission and useful output need their own checks.
- **A large selection.** `bun scripts/measure/pvp-sweep.ts [pattern] [--parallel 6] [--budget 3.5] [--batch k]` runs the whole PvP bench (or the pattern) in batches that each end within the budget in minutes (hard limit the budget plus 90 s, so 5 minutes by default; `--batch k` runs one batch alone): it packs the cases longest first by their last wall time (`.practice/pvp-sweep/elapsed.json`, with the measured ratio of batch time to estimate), and a case that a batch did not reach goes into the next batch. The whole PvP bench takes about 32 minutes of 5-minute batches on 4 cores (10 engines at once are no faster than 6), so a change's turns run `--quick` (every `pvp:` route case and one case of each climb, `QUICK_CASES`: 20 cases in about 2.5 minutes) and the whole sweep runs once before the merge.
- **Watch.** `--watch` runs the selection again each time a file under `scripts/` or `packages/` changes.
- **Output.** `.practice/aio-bench/output/<case>.log` holds the whole output of the last run of each case.
- **Kept results.** A result is kept under a hash of the seed, the case, its preset, the worker script with the files it imports, the vendor patch and the `Q_*` and `--set` values. A case with no change in these returns its kept result. A change to a data file a worker reads at run time is not in the hash; use `--no-keep` after one.
- **Limits.** The bench shows ticks on a practice engine with every skill at the preset level. It does not show a live result. A lockstep tick holds while a script works off the tick clock, up to `SIM_BUSY_MS`; a wall-clock sleep in a worker therefore costs real time and no ticks.


## Recover a session

A live start needs the account's logout proof (`packages/core/src/session-admission.ts` `liveLogoutRef`): the newest producer attempt ended `logged-out`. A session without that proof is held.

- On a server in `TAKEOVER_SERVERS` (`packages/core/src/session-takeover.ts`), a held session may start again by re-login when the attempt is the recorded latest and no owner process of an attempt after the last confirmed logout still runs. The new login attaches to the Player in the world; its own logout writes the next proof. A repair never uses this path.
- On every other server, a held session recovers only through the authenticated recovery path (`packages/core/src/session-recovery.ts`, `session-recovery-permit.ts`): one permitted login, modal cleanup, logout, producer proof. The live server is not in `TAKEOVER_SERVERS`.
- Add a server to `TAKEOVER_SERVERS` only with evidence that a re-login there attaches to the Player in the world, recorded in `research/community-and-upstream.md` 8.6. Never kill or take over a live session to collect it.

## Fleet Brain & runtime orchestration

`packages/brain/` (`WorldSnapshot`, `ActivityCatalog`, `DemandEngine`, `AccountPlanner`, `FleetScheduler`) plans 1-to-3-step dependency chains across all owned accounts and emits `.practice/live/fleet-state.json`. `packages/fleet/src/swarm.ts` runs Brain cycles on both local and cloud sides (unless in bounded recovery/inspection mode), dispatches `packages/workers/` modules through `packages/fleet/src/worker-dispatch.ts`, and honors `swarm.json` explicit hand reservations (`Haggis`, reserved specialists, owner holds).

- Operator controls write validated `OperatorCommand` JSON files to `.practice/live/operator-commands/` (`packages/dashboard/operator-control.ts`), which `packages/fleet/src/brain-runtime.ts` drains on each Brain cycle.
- Standalone session recovery (`packages/fleet/src/session-recovery.ts`, `scripts/cloud-recover.ts`) recovers held live sessions through controlled recovery permits (`packages/core/src/session-recovery-permit/`), while honoring owner stop files, attempt budgets, and global `InfraCircuitBreaker` backoff.
- `packages/fleet/src/live-update.ts` fast-forwards `master` to `origin/master` when no live run loads a changed file and no active campaign runs, then writes `.practice/live-update.json` so daemons reload cleanly.
- `packages/fleet/src/watchdog.ts` prunes old practice status rows, keeps `dashboard-publish` and down controllers healthy, runs standalone recovery passes, and skips restarts whenever `.practice/stop-swarm` or `.practice/stop-coordinator` exists.

Diagnostic commands: `bun packages/brain/src/shadow-cli.ts`, `bun packages/fleet/src/hygiene.ts`, `bun tools/now.ts`.
