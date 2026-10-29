# Reusable swarm scripts

Use this contract for new scripts, accounts and shared helpers. It defines acceptance, not proof that existing workers comply.
Follow [AGENTS.md](../AGENTS.md) for authority, pause, ownership and launch limits.

All gameplay techniques are authorized (owner). There is no exploit, community-acceptance or technique-approval gate. Missing supplies become procurement requirements. They never exclude a candidate route. Show quantity, holdings, acquisition method and next consumer separately from runtime evidence.

## Choose and reuse

1. Name the goal, useful output, consumer and acceptance check.
2. Apply the [research-first gate](../AGENTS.md#research-first-gate) for new decisions. Reuse inspected decisions on continuation. Use the [source-to-consumer queue](../research/project-use-map.md#find-and-port-a-solution) for unresolved gaps.
3. Verify external code, revision, license and dependencies before reuse. Retain attribution. Treat advertised results as claims.
4. Check pinned content, engine, local patches and server configuration together. Validate external IDs, coordinates, XP, prices and quest rules.
5. Parameterize account, server, target, supplies and limits. Share the algorithm. Do not copy a worker for each account.

| Need | Existing home |
|---|---|
| Session, action, waits, recovery | `packages/core/src/{bot,act,ticks,reflex,walk}.ts` |
| Accounts, admission, ownership | `scripts/fleet.ts`, `scripts/swarm.ts` |
| Dated state and quest observations | `packages/core/src/{status,quest-status}.ts` |
| Shared prerequisites and supply demand | `packages/planner/src/requirements.ts`, `scripts/{goal-readiness,preparation-report}.ts` |
| Route costs and receipt bindings | `packages/planner/src/supply-route.ts`, `scripts/courier-route-evidence.ts` |
| Action effects and realised costs | `scripts/goldfarm-stable.ts`, `packages/dashboard/net-costs.ts` |
| Whole-clock goals and practice | `packages/planner/src/haggis.ts`, `packages/practice/src/` |

Trace producers, consumers and tests before changing a shared contract. A receipt example is not a universal adapter.
Readiness checks do not reserve stock or schedule workers. Generated data can omit rules. Check the source before treating absence as impossible.

For production, distinguish an exact order from a best-effort batch. Partial available stock can serve the latter; it cannot silently satisfy the former. Compute every ingredient after reservations and free slots. For bank recovery, distinguish unready observation, exhausted stock and failed withdrawal; retain pending mutation identity across retries. Reuse `depositObserved` rather than replacing its paired receipt with animation or SDK success. See the [source failure cases](../research/project-use-map.md#failure-cases-worth-porting-next).

## Deliver a capability

One owner carries a useful game outcome through its consumer. The runnable entry point, shared code, settings and acceptance checks form one delivery. Keep all wealth, quests, skills, gear, collection, specialist and simultaneous-board goals in the current plan.

Find and run saved capability checks:

```powershell
bun run deliver --list
bun run deliver ammo-order
bun run deliver wine-order
```

This uses installed scripts without a model call. It runs regressions, native practice and the consumer check in order. Each command has a timeout. Logs and source hashes go to a fresh `.practice/deliveries/<id>-<time>/` folder. A failed check stops dependent stages. Source changes invalidate the result. The current native task requires free local ports and 12GiB free memory, including startup reserve. It never stops someone else's stack.

Capability definitions live in `packages/router/tasks/`. Each names the existing entry point, owned edit files, useful outcome, consumer and check commands. They describe acceptance, not account assignments or release permission. `swarm.json` remains the live assignment authority. Add a definition only for a real capability being delivered. Do not create placeholder tasks for the whole game.

For authorized script development through the subscription CLI:

```powershell
bun packages/router/src/author-cli.ts --task ammo-order
```

The author may edit the named worker and shared files. The delivery runner owns acceptance commands. A failed consumer check returns to the integrator instead of repeatedly rewriting the producer. Legacy author tasks remain available as exercises. They report `stage: practice-only`, `complete: false`, and exit 3 when their preset passes. Failed model calls cannot validate an old file. Empty proof batches cannot pass.

`stage: delivered` means the task's native outcome and consumer checks passed on those source bytes. It does not mean live release, unattended readiness, a board win or completion of another goal. The ammo task proves owned arrowtips reach the Fletching worker and become banked arrows. Ranged entry and sustained training remain separate dependencies.

The runtime release pin excludes `packages/dashboard` and `packages/router`. Runtime imports into either are refused until the dependency is included deliberately. Shared worker, planner, knowledge, practice, SDK and client changes still require coordinated rollout. This is a shared runtime release, not independent per-worker deployment. Capture a new candidate pin after runtime edits. Do not clear existing holds or enable assignments merely because delivery passed.

Wine entry point: `bun scripts/cook-wine.ts <account> [target=99] [fermentation-deadline=80]`. Stage raw starter wine in its reachable bank and owned noted bulk in its pack. The worker waits for observed fermentation, banks bulk with a matched receipt, confirms logout and reconnects in the same process. It stops as soon as the target is reached. Missing stock or unconfirmed logout fails the order. No fixed fermentation sleeps or scratch-runner paths are required. Native qualification does not establish live supply throughput or a record time.

## Define each worker

Keep these fields in its existing config, code and status. Do not create a second manifest.

| Contract | Required meaning |
|---|---|
| Identity | Account, server, owner, role, work revision and goal |
| Entry | Observed skills, quest flags, tools, location, supplies and host capacity |
| Budget | Tick limit, progress deadline, retries, food, fares, slots and reserved stock |
| Progress | Product, destination, quantity, costs and last useful effect |
| Exit | Verified result, remaining assets, next action and safe logout |

Provision local credentials and a disabled reservation first. First login registers the account and starts its clock; do not confuse those steps. Follow the naming and allocation rules in [AGENTS.md](../AGENTS.md). Validate identity and prerequisites before admission. Enable only within current user authority after qualification.
Keep specialist hiscores and the simultaneous 24-board goal separate. Count helper costs separately from the main clock.

Live worker starts require a fixed `WORKER_RELEASE` source hash. Controller, single/host supervisors and `openBot` reject missing or changed pins. Incompatible peers and unknown unfinished peer status block login; age does not prove logout. Release refusals end as `release-paused`, with no retry; actual worker failures remain blocked. Compute with `workerSourceRevision` in `packages/core/src/worker-release.ts` only for a qualified source set. Refresh a pin only after fresh same-source qualification and a drained coordinated rollout. After authorization, verify old workers offline, qualify both trade partners, then start the controller with the approved pin. This launch gate does not hot-patch processes or freeze runtime files. Preserve the live checkout while legacy workers remain; use isolated development for further runtime edits.

## Execute and recover

Observe → check requirements → choose → act → confirm effect → record → re-evaluate.

- Use observations bound to account, server, source and time. Keep missing, stale and conflicting facts unknown.
- Confirm the product or quest flag. A click, SDK success, animation or reward-shaped item is insufficient.
- Re-evaluate from observed state after interruption. Reconcile uncertain trades before another transfer.
- Price the complete trip. Reserve return fares and food before purchases. Recheck direction, access, stock and costs after changes.
- For sourcing, compare GE with owned stock and other methods under the [market policy](../research/supply-logistics.md#market-policy-current). Record price/history age, quantity, limit, escrow budget, deadline and consumer. Separate accepted orders, fills, collections and delivered stock; retain offer IDs across restart. Count merchant profit only from settled costs/proceeds, with fees and remaining inventory explicit.
- Bound waits and retries. Record a productive wait's cause and deadline. A heartbeat is not useful progress.
- On stalled progress, diagnose the first failed boundary: environment, observation, requirement, action or result.
- Attempt only a supported recovery within budget. Otherwise, record the blocker, repair owner and next evidence, then stop safely.
- Never clear a block through repeated restarts. Resume only after its cause changes and the applicable check passes.

## Keep goals current

Publish through existing status and dashboard paths. Show observation age, target, actual progress, last effect, blocker and next action.
Keep transport health, worker health and goal progress separate. Expired data must display stale or unknown, never healthy progress.
Recompute affected requirements after receipts change. Keep unrelated goals eligible. Do not invent idle work or bypass a pause.
When a supply target is met, choose a stock conversion, unlock or uncovered skill for that account. Keep a fresh-clock specialist separate from its supply helpers. A held assignment must name the missing evidence and next qualification; an account count is not game coverage.
If a field or recovery is absent, record the implementation gap. Documentation cannot supply runtime behaviour.

## Prove and retain

Test applicable failures: missing supplies, full inventory, blocked access, depleted stock, competition, disconnect, restart, duplicate results and cancellation.
Prove entry → work → delivery/bank → refill → resume → logout for the claimed role.
Use saved-state checks while paused. After authorization, qualify in practice, then run a bounded live pilot.
Bind evidence to source hashes, relevant configuration, server revision and starting conditions. A matching source hash alone does not renew qualification. If inputs change, identify the affected claim and rerun its check. Preserve unrelated valid evidence. Compare matched workloads, including recovery and support costs.
Record tick units, XP scale and sample scope. Level, XP, bank value, cash and full net profit are different measures.
Replace stale conclusions in the existing topic. Retain one compact lesson: **failure → cause → reusable fix → evidence → remaining limit**.

## Autonomous coordination

Codex and Claude work continuously through the same durable queue. The daemon records an agent on each new claim, balances build jobs between the two subscription CLIs, and sends a successful build to the other model for review. Codex normally plans while Claude builds; when Codex owns a build, Claude can plan. Receipt/proposal file events wake dispatch immediately, with a one-second fallback. Ready jobs do not wait for the old five-minute chat heartbeat. The heartbeat is retired. A failed independent source review is carried into the next job input and blocks live use of that exact capability source until repair or newer approval. Submit shared work with `--submit`; the daemon remains the only queue-state writer. Native checks and game scripts remain deterministic harness work. A shared runtime writer and native qualification serialize where current source ownership requires it; both models can reason on separate jobs concurrently. The headless Codex worker has its own task context and uses the same goals, guides, queue and receipts as this chat. Keep the PC running.

`packages/router/src/coordinator-cli.ts` connects goals to the existing author, delivery harness and swarm. `swarm.json.coordination` enables it and sets parallelism, planner deadlines and bootstrap work. `swarm.json.jobs` remains the live assignment authority. All six goal lanes remain in durable state; task counts are not game completion.

The director reads dated account state, stock, existing assignments, failures and reusable capability definitions. It proposes a dependency graph of `build`, `qualify`, `provision` and finite `run` tasks. Missing supplies become producer tasks. A build snapshots declared existing files, uses the subscription Claude CLI, runs the declared delivery checks and gets an independent read-only review. Native proof is distinct from a live result. A run requires a current same-capability qualification and checks exact account, run goal, release, timestamps, successful result and useful effects. Composed jobs reserve all participants and pass explicit arguments through the existing supervisor.

The planning snapshot includes all19 skills, the pinned quest catalogue, candidate scripts and every active blocked dependency. It also includes the coverage scoreboard (`packages/router/src/coverage.ts`, `.practice/coordinator/scoreboard.json`): every skill, quest, item and the 5,807 player actions of `knowledge/actions.json` in 154 domains, staged none, named, practice, live. Each task names the entries it moves. Missing catalogue rows remain unknown. A filename does not prove a capability. Compare a ready live outcome, an important unlock/supply bottleneck and an uncovered capability by total cost and useful effect. Expand toward every supported game activity through simple parameterized workers and composed consumers; retain all goal lanes. Create accounts for named absent roles or measured capacity needs, with prepared inputs and a finite first assignment.

New build proposals must lead to a pending finite live consumer in the dependency graph. The entry must be the actual account-parameterized worker; local save files and privileged fixture commands belong in native checks. Those checks must invoke that worker CLI with representative ordinary entry and verify its consumer. Do not label a practice-only command live-ready.

To expand an existing worker or helper scope, submit `capabilityUpdates:[{expectedSource,definition}]` with the complete revised definition and its build task. Use the raw definition SHA-256 in `capabilitySources` as `expectedSource`. One capability can change per proposal. Its current owner must finish first. The daemon preserves the original bytes, rejects stale updates and attaches the build to existing consumers before any new files are read. Entry, file scope and check commands form part of the delivery fingerprint. Changing them requires fresh proof. The normal independent review still applies.

The same claimed build can repair a failed regression up to two times within its model deadline, using retained raw check logs. A native failure, consumer failure or timeout does not trigger a blind source rewrite. Heavy build/qualification dispatch waits for the existing12GiB startup threshold; it does not fail a job just because dispatch observed low memory. Independent eligible live work can proceed under its own admission checks. This does not reserve memory or guarantee that later startup succeeds.

Build authors receive the claimed task's exact `why`, dependency outcomes and raw run path. Proposals may include `replacements:[{from,to}]` for matching kind/capability/goal/account tasks; the daemon reconnects waiting dependencies atomically and retains failed receipts. Running or successful work and provision identities cannot be replaced. Automatic refreshes serve waiting live consumers and replace old refresh edges, including failed ones, without clearing actual repair prerequisites. After fresh native qualification, one ready finite live consumer may precede an unrelated build; that build still drains active live work. Source, review, ownership, pauses and admission checks still run at execution.

State, ownership, raw results and model/reviewer output live in `.practice/coordinator/`. A restart adopts matching child ownership or receipts; it does not recreate a running account or replay successful work. OS liveness protects against transient Windows command-line lookup failures. Failed work remains visible and leaves unrelated goals eligible. Each build authors and proves its capability in its own source workspace (`packages/router/src/build-workspace.ts`, `../rs-sdk-bot-build/<capability>`), so live runs continue from the main checkout. Only the publish of the declared files drains the fleet and holds the build fence; a publish request holds new live starts until it lands, and a main checkout changed since the build started refuses the publish. Practice checks serialize. New live claims obey measured admission limits, retain the chosen identity before credential creation, and require a server claim with confirmed logout. Existing trained helpers and protected clocks take priority over more accounts.

The scoped swarm controller starts coordinator-owned assignments only. It preserves legacy assignments for deliberate qualification and reassignment. Reassigning a completed actor from an ordinary group keeps the other members assigned; a composed worker retains its whole group. Exact failed-end recovery needs fresh post-failure native evidence and the existing controller's scoped repair path. Owner stop files, main launch checks, source pins and the free-memory floor remain enforced. No gameplay technique or supply shortage is a route ban.

The actual CLI entry identifies the producer script; `BOT_GOAL` is a display label. Anonymous legacy logs are diagnostic only. Caller-written success JSON cannot clear a failed-script hold. Until a producer-bound work-result contract is qualified, stored `qualified` fields do not release that script. A proved account cleanup may permit a different role while preserving the failed-script hold.

Source preparation uses11GiB startup admission: an estimated3GiB reserve above the8GiB floor. Native practice and consumer child launches still require12GiB at the launch boundary. A bounded15-minute wait starts no child and records host deferral on expiry. Only full-delivery deferral marks source prepared; diagnostic deferral does not. A later native-ready build may reuse an exact prepared fingerprint, but must rerun every gate and obtain the normal review. Source work remains exclusive against live writers.

`coordination.maxActive` limits development work, not the live fleet. `maxLive` defaults to the measured fleet cap. `preferLive` fills eligible finite live assignments before another source build; a running source writer still excludes live entry. The dispatcher prepares one controller before parallel children start. Account-plan installation and completion use the same cross-process write lease; only the dispatcher recovers a dead owner, retaining its lease evidence. A controller hold leaves independent development eligible.

With `autoExpand`, ready owned accounts and prepared new-role claims create capacity demand. The coordinator raises the cap by at most4 only after two useful live results since the previous increase, a10-minute observation interval, fresh active tick samples at most800ms, host CPU at most85%, no unknown/stale active sample, and the configured free-memory floor plus4GiB practice reserve. Native results and account claims do not satisfy useful-output evidence. Existing admission checks still decide each start. Registration receives the current qualified release pin; it waits for native proof of its prepared first job and cannot overlap a source writer. Each active source build adopts `focusCapability` through its first useful live receipt, then the focus clears; three consecutive failed builds release it (`FOCUS_FAILURE_LIMIT`). Required dependency builds/proofs and read-only reviews stay eligible; unrelated builds and native refreshes wait. A native proof waits when a required source build is ready.

Commands: `bun run coordinate --submit <proposal.json>` submits jobs through the single state owner; `--status` reads state; `--plan` requests a priority refresh; `--stop` pauses and stops owned children. To resume after an authorized pause, remove only `.practice/stop-coordinator` and start `--run <unique-owner-token>`. `--restart` asks the daemon to exit while preserving children; start it again to adopt them. The process survives chat completion, not a PC shutdown. Runtime proof and actual useful live receipts determine progress; a running daemon alone proves neither full coverage nor optimal play.
