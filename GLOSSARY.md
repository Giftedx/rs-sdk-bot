# rs-sdk-bot Glossary

Canonical domain language for the OSRS bot fleet, route planner, practice bench, and cross-side operations. Keep definitions free of implementation details and commit history.

## Language

**Main account**:
`Haggis`, the primary account competing for Overall rank 1. Keep offline for staging and rehearsal until launch gates pass.
_Avoid_: primary bot, test account

**Specialist**:
An account dedicated to reaching rank 1 on a single skill hiscore board within a priced margin over the current record.
_Avoid_: skiller, alt

**Helper**:
An ordinary account whose training or production supplies a route bill item, quest unlock, or specialist clock.
_Avoid_: mule, worker account

**PK army**:
The roster of combat accounts trained toward maxed tribrid stats (99 Attack, Strength, Defence, Ranged, Magic, Prayer, and Hitpoints) to defeat players and control the Wilderness.
_Avoid_: clan, combat bots

**Scoreboard**:
The five-part ledger measuring owner goals: Main Overall, Specialist wins, Every quest, Useful items and best gear, and PK army.
_Avoid_: status board, KPI

**Consumer**:
The finite route, quest, kit, or live task that uses an upstream build, supply batch, or qualification.
_Avoid_: caller, recipient

**Route**:
A timed sequence of game steps, training bands, and supplies that produces a measurable scoreboard effect or quest completion.
_Avoid_: script, strategy

**Cairn**:
The reference external Overall speedrun route (`rune.fast`) used as an independent tick comparison against our Main Overall model.
_Avoid_: baseline, competitor

**Floor**:
A measured lower-bound tick or resource estimate for a planner row from `tools/measure/floor-*.ts`.
_Avoid_: target, best run

**Bench**:
The practice measurement runner (`bun run bench`) that evaluates route cases against stored tick baselines and rival times.
_Avoid_: benchmark suite, unit test

**Preset**:
A reproducible starting save state for the practice server holding specific levels, quests, items, and position.
_Avoid_: fixture, snapshot

**Rehearsal**:
A full or staged clock run of a Main account or Specialist route on the isolated practice engine before live admission.
_Avoid_: dry run, smoke test

**Lockstep**:
Deterministic practice engine execution (`SIM_LOCKSTEP=1`) that advances one game tick per worker action cycle without wall-clock waiting.
_Avoid_: fast mode, speedhack

**Capped tick**:
A practice tick that exceeds its wall-clock busy limit (`SIM_BUSY_MS`) and drops a real tick while spending two seconds of wall time.
_Avoid_: slow tick, lag spike

**Standing job**:
A recurring assignment in `swarm.json` or `.practice/coordinator/jobs.json` managed by the swarm supervisor.
_Avoid_: daemon, background task

**Owner stop file**:
A `.practice/stop-*` pause file carrying explicit user instructions; blocks automation for its named scope unlike controller-written stops.
_Avoid_: fault, error hold

**Fleet side**:
A distinct host identity (`FLEET_SIDE`, such as `local`, `cloud`, `claude-cloud`, or `claude-cloud-2`) owning a subset of fleet accounts.
_Avoid_: host, cluster

**Fleet data**:
The shared `fleet-data` git branch holding owners, vault secrets, bank snapshots, resource claims, orders, receipts, leases, and side cards.
_Avoid_: state repo, sync cache

**Lease**:
The remote branch ref (`refs/heads/fleet-lease/<side>`) renewed by a side's active controller to claim exclusive execution for that side.
_Avoid_: lockfile, heartbeat

**Account claim**:
The remote ref (`refs/heads/fleet-trade-claim/<account>`) held around a live login so at most one worker or trade session connects as that account.
_Avoid_: login lock, session token

**Adopted account**:
An account temporarily planned and run by another active fleet side after its home side's lease stays silent past the adoption threshold.
_Avoid_: borrowed account, reassigned account

**Fleet order**:
A finite cross-side item or coin transfer record settled through matched trade receipts on `fleet-data`.
_Avoid_: trade request, transfer job

**Vault**:
The AES-256-GCM encrypted `bot.env` store on the `fleet-data` branch (`fleet/vault/`) keyed by `FLEET_VAULT_KEY`.
_Avoid_: secret store, env backup

**Local gate**:
The `local-gate` commit status posted by `tools/ci-gate.ts` after running reachable CI checks locally.
_Avoid_: local CI, pre-commit
