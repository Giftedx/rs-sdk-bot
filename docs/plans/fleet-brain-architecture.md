# Fleet Brain & Worker Consolidation Plan

Target architecture and staged migration plan for `rs-sdk-bot`, replacing overlapping planning loops and duplicated scripts with one deterministic Fleet Brain (`packages/brain/`) and nine deep parametric worker engines (`packages/workers/`). Governed by [AGENTS.md](../../AGENTS.md), [GLOSSARY.md](../../GLOSSARY.md), [joined-plan.md](joined-plan.md), and [script-contract.md](../script-contract.md).

## 1. Decisions & Scope

- **Migration strategy**: Clean-cut replacement for the Fleet Brain (`packages/brain/`) combined with phased replace-and-delete consolidation for workers (`packages/workers/`).
- **Autonomous LLM Coordinator**: Removed. One deterministic Fleet Brain owns live account planning, prioritization, and scheduling across all fleet sides. Engineering, script authoring, and code reviews run interactively.
- **Proof gates (two tiers, one bench system)**:
  - **Protected clocks** (`Haggis` and the 19 reserved Specialists in `packages/core/src/specialist-boards.ts`): Require full isolated rehearsal, verified staged supply manifest, and fresh hiscore margin check before live admission.
  - **Ordinary accounts**: Require one passing `bun run bench` case per activity (`practice_passed`). Once `practice_passed`, accounts switch freely across activities using modeled rates from `knowledge/` and the travel cache, refined automatically from measured runs.
- **Foundations retained**: `packages/knowledge/` (rev-289 game truth compiler), `packages/core/` (in-process session, pathing, banking, combat/eat/prayer guards, session logout proofs, Git leases/claims, encrypted `bot.env` vault), `packages/planner/src/gear-progression.ts`, `packages/practice/` (lockstep server, presets, unified bench, rehearsals), the 68 generated quest scripts, `scripts/pk.ts` / `scripts/pk-squad.ts`, and `packages/dashboard/` UI and hosted relay.

## 2. Target Package Layout & Acyclic Dependencies

Dependencies flow strictly downward in a DAG enforced in CI:

```text
packages/
  knowledge/   # Rev-289 game truth compiler (imports: none)
  core/        # Bot session, walk, bank, guards, proofs, vault, preflight (imports: knowledge)
  workers/     # 9 deep parametric WorkerModules + quest defs + PvP (imports: core, knowledge)
  brain/       # Pure Fleet Brain: Snapshot, Catalog, Demand, Planner, Scheduler (imports: core, knowledge, workers types/preflight)
  fleet/       # Execution & multi-side daemons: swarm, fleet-agent, sync, cloud-*, watchdog, recovery (imports: core, brain, workers)
  practice/    # Lockstep engine, presets, unified bench, rehearsals (imports: core, workers)
  dashboard/   # Local UI, publisher, operator inbox writer (imports: brain schema only; reads fleet-state.json)
tools/         # Repo/CI/diagnostic CLI scripts (ci-gate, now, check-pin, typecheck-narrow, worktree-setup, floor probes; never imported by runtime)
```

### Runtime vs. Practice Directory Isolation

- `.practice/live/` holds live account statuses, session lifecycle logout proofs, explicit owner stop files, `fleet-state.json`, `operator-commands/`, and `fleet-data/`.
- `.practice/sim/` holds all practice bench outputs, test bot credentials, temporary proof runs, and rehearsal artifacts. Simulation and test processes never write stop files, status rows, or bot directories into live paths.

## 3. Core Contracts & Data Model

### 3.1 Single Account Lifecycle State Machine (`AccountState`)

Every owned account in `WorldSnapshot` carries one explicit lifecycle state instead of implicit disabled job flags or competing stop files:

```ts
type AccountLifecycle =
  | 'paused_owner'             // Explicit human stop file (no expiry; cleared only by owner)
  | 'reserved'                 // Protected clock (Haggis or fresh Specialist) held for Campaign launch
  | 'dead'                     // Live death; held pending human review
  | 'needs_logout_recovery'    // Held logout proof; auto-queued for session recovery
  | 'needs_location_recovery'  // Stranded off-hub or non-ground plane; auto-runs recovery once logout confirms
  | 'running'                  // Active worker session owned by swarm
  | 'in_trade'                 // Active or reserved fleet transfer owned by fleet-agent
  | 'idle';                    // Eligible for AccountPlanner & FleetScheduler

interface AccountState {
  name: string;
  side: string;
  role: 'auto' | 'army' | 'helper' | 'specialist' | 'main';
  protectedClock: boolean;
  maxLevels?: Record<string, number>;
  lifecycle: AccountLifecycle;

  skills: Record<string, { level: number; xp: number }>;
  quests: Record<string, 'not_started' | 'started' | 'complete'>;
  pos: { x: number; z: number; level: number } | null;

  inventory: Record<number, number>;
  equipment: Record<number, number>;
  bank: { items: Record<number, number>; observedAt: number; trusted: boolean };

  activeJob?: { activityId: string; demandId: string; startedAt: number };
  cooldowns?: Record<string, number>; // Temporary per-item/source cooldowns with expiry timestamps
}
```

Key invariants:
- **Trusted offline banks**: Confirmed-offline account banks stay `trusted: true` until a newer login attempt or settled transfer modifies the account.
- **Expiring system holds**: Every automated cooldown, retry backoff, or maintenance hold carries an explicit TTL; only human `paused_owner` and `dead` flags persist indefinitely.
- **Automatic unblock order**: `needs_logout_recovery` executes first (prioritized by frozen GP and critical supply value so high-value accounts unblock immediately), followed by `needs_location_recovery`, followed by normal planning.

### 3.2 Unified `WorkerModule<Cfg>` Seam

One module contract covers all gameplay activities (`gather`, `bank-artisan`, `combat`, `agility`, `runecraft`, `quest`, `market`, `logistics`, `pvp`), eliminating drift between planner assumptions and worker preconditions:

```ts
type TrustTier = 'experimental' | 'practice_passed' | 'live_proven';

type OutcomeKind =
  | 'target_met'
  | 'missing_supply'
  | 'location_stranded'
  | 'market_unavailable'
  | 'session_unsettled'
  | 'infra_fault'
  | 'worker_defect'
  | 'death';

interface WorkerModule<Cfg> {
  id: string;
  kind: 'train' | 'gather' | 'produce' | 'quest' | 'shop' | 'ge_buy' | 'pk' | 'recover';
  trust: TrustTier;
  protectedAllowed?: boolean;

  preflight(acct: AccountState, cfg: Cfg, world: WorldSnapshot): PreflightResult;
  estimate(acct: AccountState, cfg: Cfg, world: WorldSnapshot): RateEstimate;
  run(session: Session, cfg: Cfg): Promise<RunOutcome>;
}
```

Contract guarantees:
- **Shared `preflight()`**: Both `AccountPlanner` and the worker execute the exact same checks for tile reachability, ferry fares, wearable skill/quest levels, reserve-adjusted stock (`owned - reserve`), GE escrow + reserve math, and combat survivability floors (Defence/HP/food/Prayer).
- **Zero dropped methods in `estimate()`**: Every cataloged activity exposes an initial rate and `setupTicks` estimate derived from `knowledge/` and the travel cache plus a `minBatchUnits` floor (preventing tiny micro-trips). Measured live and practice samples update `RateStore` automatically and override estimates once sufficient samples exist.
- **Typed `RunOutcome` routing** (`OutcomeClassifier`):
  - `target_met`: Updates `RateStore` and unlocks the follow-up step immediately.
  - `missing_supply` / `location_stranded`: Triggers supply acquisition or `needs_location_recovery` prep without retiring the underlying activity.
  - `market_unavailable`: Places `(item, venue)` on a bounded TTL cooldown so `AcquireItem` switches to the next source (shop, donor, or craft).
  - `session_unsettled`: Transitions to `needs_logout_recovery`.
  - `infra_fault` (remote claim authority unreachable, server drain, proxy drop): Trips a global controller circuit breaker with exponential backoff without penalizing per-account records.
  - `worker_defect` / `death`: Quarantines `(activityId, faultSignature)` and emits a structured defect record with log and tick-record paths for interactive repair.

### 3.3 `DemandEngine`: Goals, `Campaign`, and `Mission`

All five owner goals (`main_supply`, `specialist_prep`, `quest_board`, `gear_collection`, `pk_army`) plus operational `squad_supply` and `coin_fund` emit `GoalDemand` items scored on one currency: **normalized goal value per total end-to-end hour** (including travel, acquisition, setup, and execution).

- **`Campaign` (Main & Specialists)**: Declarative manifest (`{ id, account, protectedClock, board, requiredSupplies, stagingHolder, rehearsalProof, hiscoreMargin, state }`) that injects finite shortfall demands directly into `DemandEngine`, replacing ad-hoc per-launch scripts and JSONs.
- **`Mission` (PK Squad & Multi-Account Operations)**: Declarative manifest (`{ id, participants, state: 'staging' | 'ready' | 'running' | 'paused', kitTargets, consumables, weight }`). A `paused` mission emits zero demand; active missions compete proportionally with other goals.
- **Comparative advantage & post-max endgame roles**: `FleetScheduler` evaluates each account's actual skill, quest, and position profile so specialized veterans naturally match high-leverage deficits (e.g., high-quest-count accounts finishing the Quest Board, high-artisan accounts filling supply bill shortages, maxed tribrids staging endgame/PK/boss output) while unassigned (`role: 'auto'`) accounts pick the highest-value bootstrap or supply chain.

### 3.4 `AccountPlanner`, `FleetScheduler`, and Safe Logistics

- **`AccountPlanner`**: Solves 1-to-3-step dependency chains per account (`recover -> acquire/gear -> unlock -> target work`) and evaluates gear upgrades strictly by net XP/tick payback over the remaining band vs. acquisition ticks.
- **Unified `AcquireItem` resolver**: Evaluates `Own Bank -> NPC Shop -> GE -> Stationed Hub Banker -> Craft/Gather`, preserving an operating coin float (~1,000 gp) per active account for ferry fares.
- **`FleetScheduler`**: Performs global slot, shared-spot capacity, and transfer allocation with hysteresis (+15% retention margin for healthy running work) across one unified output plan + transfer queue.
- **Safe transfers**: Prefer self-supply over 2-account trades; route unavoidable transfers through stationed hub bankers at Varrock West and Ardougne; require both parties `idle` with confirmed logout; prohibit sending any item the donor holds demand for or recently received (anti-ping-pong); drain active trades before `live-update` reloads.
- **Symmetric multi-side operation**: Every fleet side runs the identical `packages/brain/` code against its `maxBots` budget; stale remote claims/plans expire cleanly by lease TTL.

### 3.5 Dashboard & Operator Control Seam

- **Read contract**: The Fleet Brain emits one versioned `.practice/live/fleet-state.json` containing account states, lifecycle flags, active chains, idle reasons, goal/campaign/mission progress, pending transfers, and quarantined worker defects. `packages/dashboard/` renders directly from this state.
- **Write contract**: Operator pause/resume/override/campaign actions write to `.practice/live/operator-commands/`, processed directly by the Brain and `packages/fleet/` without any Coordinator dependency.

## 4. Deep Worker Consolidation (`packages/workers/`)

Every gameplay family collapses into one parameterized `WorkerModule`:

| Engine | Replaces | Configuration Surface |
|---|---|---|
| `gather` | Gathering scripts across mining, fishing, woodcutting, flax, essence, stalls/chests, pickpocketing | Spot, skill, banking/drop/cook mode, target |
| `bank-artisan` | Bank-standing & furnace/anvil scripts (cooking, wines, smelting, smithing, fletching, crafting, glass, jewellery, herblore, tanning, spinning, firemaking, alching, bone burying) | Recipe ID (`knowledge/dbtables.json`), target batch, reserves |
| `combat` | Combat trainers, safespot ranged, multicannon, magic splash, monster drop farms, boss trips | Target NPC/boss, combat style, survivability floor, loot/prayer rules |
| `agility` | Agility course runners and lap/level scripts | Course ID, target level/laps |
| `runecraft` | Solo altar crafters and runner/carrier orchestration | Altar, carrier roster/mode, target |
| `quest` | Quest sweep/chain executors backed by declarative quest scripts and staging definitions | Quest slug(s), sustain/keep contracts |
| `market` | Shop buyers/sellers and GE single/bulk traders | Shop profile or GE item/quantity/limit/escrow |
| `logistics` | Couriers, fleet trade workers, stationed hub bankers, bank relocators, trap recovery, inspection | Operation (`trade`, `hub_bank`, `stage`, `walk`, `recover`, `inspect`) |
| `pvp` | Scattered PK hunt/roam/squad/kit-staging scripts | Kit loadout, fight profile, squad post/targets |

Haggis and Specialist routes compose these engines through thin declarative campaign definitions rather than maintaining separate copies of banking, walking, or shopping loops.

## 5. Staged Migration Roadmap

### Phase 0: Baseline Hygiene & Decoupled Recovery

- Triage the uncommitted tree on `master` into a clean baseline.
- Separate `.practice/sim/` from `.practice/live/`, clear leaked test stop files and expired agent holds, and clear obsolete disabled job locks.
- Extract `watchdog`, `live-update`, `status-prune`, and standalone automatic session-recovery into `packages/fleet/`, independent of any LLM Coordinator daemon.
- Add the controller-level global infra circuit breaker so Git claim, proxy, or server-drain outages back off globally without creating account failures or retirements.

### Phase 1: Build `packages/brain/` + Offline Shadow Verification

- Implement `WorldSnapshot`, `ActivityCatalog`, `DemandEngine` (with `Campaign` and `Mission`), `AccountPlanner` (with shared `Preflight` and `AcquireItem`), `FleetScheduler`, `RateStore`, and `OutcomeClassifier`.
- Implement one thin, disposable `ScriptAdapter` mapping catalog activities onto the currently active live worker scripts so live operations migrate before full worker consolidation.
- Verify with full unit tests and a full-fleet offline shadow diff across all owned accounts (validating fresh accounts, high-quest/artisan veterans, maxed tribrids, `Campaign` supply bills, `Mission` state gating, and recovery ordering) with zero live logins.

### Phase 2: Clean-Cut Brain Cutover & Legacy Deletion

- Point `swarm.ts`, `fleet-agent.ts`, `fleet-sync.ts`, `cloud-side.ts`, and `packages/dashboard/` at `packages/brain/`, `fleet-state.json`, and `operator-commands/`.
- Delete the legacy planning and coordinator layers in the cutover:
  - `scripts/autopilot.ts`, `scripts/autopilot-progression.ts`, `scripts/aio-progression.ts`
  - `packages/planner/src/autopilot/`
  - `packages/planner/src/progression*.ts` (retaining `gear-progression.ts`) and `packages/planner/data/progression-routes.json`
  - `packages/core/src/progression-*.ts`
  - `packages/router/` LLM Coordinator, delivery queue, and `.practice/coordinator/jobs.json`
- Resume live operations in bounded batches (`4 -> 10 -> full host slots`) and verify clean logout proofs, accurate `fleet-state.json` visibility, and healthy transfer settlement.

### Phase 3: Phased Worker Consolidation (Replace + Delete per PR)

Consolidate one family per PR. Every PR requires passing `bun run bench` cases for the family and deletes the replaced legacy and `microbot-*` duplicates in the same PR:

- **3a `market`**: Unified shop/GE module (`~15 -> 1`).
- **3b `logistics`**: Unified trade, hub banker, staging, location recovery, and inspection module (`~30 -> 1`).
- **3c `gather`**: Unified resource-gathering and thieving module (`~25 -> 1`).
- **3d `bank-artisan`**: Unified recipe/production/alch/prayer module (`~30 -> 1`).
- **3e `combat`**: Unified melee/ranged/cannon/splash/boss module (`~20 -> 1`).
- **3f `agility` & `runecraft`**: Unified course and altar/carrier modules (`~16 -> 2`).
- **3g `quest`, `pvp`, & `campaigns`**: Cleanly house quest/PvP modules under `packages/workers/` and convert `.practice/specialist-launch/` one-off scripts into declarative `Campaign` specs.
- **3h Final cleanup**: Move remaining repo/CI utilities into `tools/`, delete the disposable `ScriptAdapter`, and enable the CI acyclic package-dependency check.
