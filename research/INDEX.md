# Research: start here

Use the [current plan](../docs/plans/joined-plan.md) for priorities and the [research-first gate](../AGENTS.md#research-first-gate) for source selection and reuse. This index routes readers to relevant sections. `knowledge/*.json` is generated game data, not a notes folder.

## Task lookup

| Question | Existing source |
|---|---|
| How must new scripts and accounts work? | [Swarm script contract](../docs/script-contract.md): reuse, observations, recovery, progress and proof |
| Find and deliver a reusable script | [Capability checks](../docs/script-contract.md#deliver-a-capability): `bun run deliver --list`; installed workers, native outcomes and their consumers |
| Food, funding, transfers and refill | [food-chain](food-chain.md), [supply-logistics](supply-logistics.md), [supply-costs](supply-costs.md) |
| Main route and board rules | [haggis-run](haggis-run.md), [boards-special](boards-special.md), [overall-board](overall-board.md), [gap-closers](gap-closers.md) |
| Tick methods, movement and hazards | [pro-playbook](pro-playbook.md), [walking](walking.md), [gathering-tricks](gathering-tricks.md), [levelup-cost](levelup-cost.md) |
| Skill rates and combat | [skill-rows-measured](skill-rows-measured.md), [combat-measure](combat-measure.md), [agility](agility.md), [supply-floors](supply-floors.md) |
| Quest prerequisites and routes | [quest-plan](quest-plan.md), [quest-route](quest-route.md), [quest-xp](quest-xp.md), [heroes-partner](heroes-partner.md) |
| Runtime and host capacity | [bot-host](bot-host.md), [random-events](random-events.md), [rs-sdk-deep-dive](rs-sdk-deep-dive.md) |
| How does each dashboard part compare with RuneLite? | [runelite-parity](runelite-parity.md): RuneLite source, copy/adapt/reject and open gap per part; `packages/dashboard/parity.test.ts` keeps it complete |
| Which external work should we use? | [Project use map](project-use-map.md#find-and-port-a-solution) — exact source entry points, local consumers, saved commits and porting recipe; grouped inventory below; [ecosystem evidence](botting-ecosystem-2026-10-23.md), [local upstream review](community-and-upstream.md) |
| Measured waste and open owner requests | [learning-report](learning-report.md) (generated), [owner-requests](owner-requests.md) |

Find narrower topics with `rg --files research`. Preserve paths cited by code and dashboards.

## Source and status

| Decision | Read first | Limit |
|---|---|---|
| What may run? | User instructions → AGENTS → current plan | Research cannot authorize execution. |
| What exists here? | Pinned content + engine + patches + configuration | Local source does not prove live deployment. |
| What can this account do? | Dated account/server observations → requirements | Unknown is not false. Ready is not reserved. |
| What worked? | Source-bound raw receipts | Practice does not prove live contention. |
| What should we try? | Existing consumer → topic evidence → external use map | A lead is not verified code or a measured gain. |

Use `true / false / null` for requirement facts: met / unmet / unknown. Keep unsupported separate from unobserved.
Name the server, source revision, observation time, units and validity conditions beside a claim. Cash is not item value or full net profit.
Task context: acceptance check, consumer path, relevant evidence, unresolved dependency. Expand only when needed.

## Lessons that change decisions

| Lesson | Use it this way | Evidence |
|---|---|---|
| XP caps hide productive work | Four thieves have200m XP: use carried stock for live visibility and matched bank receipts for output; zero XP/t alone is not a stall | Dashboard work metric; `.practice/combat-expansion/live-proof.json` keeps level gains separate |
| Short proofs overstated readiness | Require the claimed path: loot, bank, refill, return, recovery and logout | Antigravity `aa053d24`: ore proof banked 0; combat proof looted 0; [food-chain](food-chain.md) |
| Empty practice worlds hide shared-resource failures | Add depletion and competing actors; measure a bounded live segment | [live-thieving](live-thieving-2026-10-23.md), [grape-gold](grape-gold.md), paused mining evidence |
| Only the main account’s logged-in ticks consume its clock | Helper preparation while the main is offline is separate; count the main’s login, handoffs and travel. Quest Points also has a clock | [boards-special](boards-special.md), [haggis-run](haggis-run.md) |
| Holding stock is not staging it | Track item, quantity, holder, observation time, reservation and destination | [preparation-report](../scripts/preparation-report.ts) |
| Starting items can resemble quest rewards | Require the observed completion flag. Resume from the current item/stage evidence | [Rune Mysteries](../scripts/generated/quest-runemysteries.ts), [quest plan](quest-plan.md) |
| Logout can erase useful telemetry | Retain account/server journal observations with their own date; fresh status cannot refresh old unlock evidence | [Native and live retention](../.practice/quest-expansion/journal-live-proof.json); `status.ts`, `goal-readiness.ts` |
| A route proved once can fail now | Bind account, direction, server, age, combat and remaining costs | [Courier receipt replay](../.practice/shared-supply/courier-replay.json) |

## Freshness and writing

Topic files are research evidence, not fleet instructions. Counts, targets, role assignments and model totals expire. Read current source and raw state before acting. A code read, model, practice run and live run prove different things.

Update the existing topic with **claim; conditions; evidence; remaining gap**. Replace a stale conclusion in place; git keeps the old one (AGENTS.md, No diary). Keep failed results that still apply. A new file needs a distinct reusable purpose. Do not hand-edit `learning-report.md` or generated data.

## Open conflicts that affect use

- `haggis-run` and `gap-closers` contain different dated model totals. Neither proves feasibility or impossibility; recompute against one pinned input set. Equipment tie/order acceptance is unresolved, not a proved outright win.
- Run energy depends on `NODE_INFINITE_RUN`. The playbook now states this condition. Live configuration remains unverified.
- The dashboard labels `owner-requests` as historical and separates file edits from verification. Its rows remain history; use the joined plan for current work.

Unsettled entries remain leads.
