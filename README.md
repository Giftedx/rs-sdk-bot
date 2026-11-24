# rs-sdk-bot

Bot scripts and tooling for the rs-sdk (MaxBittker/rs-sdk, MIT) demo and local practice server. Built on the pinned rs-sdk submodule.

Start with [the working guide](AGENTS.md), [current plan](docs/plans/joined-plan.md), and [research map](research/INDEX.md).
Use the [swarm script contract](docs/script-contract.md) for reusable scripts, account admission, progress and recovery.
Open the [Fleet System Map](docs/fleet-system-map.html) in a browser for the control paths, job choices, recovery and shared fleet data.

## Setup

Prerequisites: Bun 1.3.x, Git for Windows (or any Git), Node is not required.

```
git clone --recurse-submodules <this repo>
cd rs-sdk-bot
git -C vendor/rs-sdk config core.autocrlf false
bun install
```

The `core.autocrlf false` line matters: rs-sdk's `bots/create-bot.ts --local` only matches LF text. See `patches/rs-sdk.md` item 1.

Already cloned without `--recurse-submodules`? Run `git submodule update --init` and then the `core.autocrlf` line.

## Commands

| Command | What it does |
|---|---|
| `bun run typecheck` | `tsc --noEmit` over `scripts/`, `packages/*/src`, `packages/*/test`, `tools/` |
| `bun test ./scripts ./packages ./tools` | Unit tests; report the current pass/skip/fail counts |
| `bun run check-pin` | Checks the `vendor/rs-sdk` checkout against `rs-sdk.pin` |
| `bun packages/brain/src/shadow-cli.ts` | Full-fleet offline Fleet Brain shadow verification (zero live logins) |
| `bun packages/fleet/src/watchdog.ts` | Runs one watchdog pass (status pruning, controller health, standalone session recovery) |
| `bun packages/fleet/src/hygiene.ts` | Scans stale auto-stops, expired holds, and dead locks (`--apply` cleans safe findings) |

The Fleet Brain (`packages/brain/`) owns deterministic account planning, supply prioritization, and slot scheduling across all fleet sides. Runtime execution lives in `packages/fleet/` (`swarm.ts`, `fleet-agent.ts`, `fleet-sync.ts`, `cloud-side.ts`, `session-recovery.ts`) and the nine unified worker engines in `packages/workers/`. See [fleet-brain-architecture.md](docs/plans/fleet-brain-architecture.md) and [script-contract.md](docs/script-contract.md).

## Safety

- The default server is the local practice server (`localhost:8888`). Connecting anywhere else needs `DEMO_OK=1` set on purpose (`packages/core/src/bot.ts`).
- The dashboard listens on `127.0.0.1` only. `DASH_HOST=0.0.0.0` opens it to the network on purpose; its state shows bot positions, inventories, banks and account names.
- `bot.env` holds bot credentials. It is gitignored. Never commit it or print its `PASSWORD=` line.
- The core attempts logout before exit. Check `LOGOUT logged-out`: failed logout can leave scored playtime running until the server timeout. Stop-file handling is in `packages/core/src/bot.ts`. Preserve bots owned by another task.

## Layout

- `packages/knowledge` - builds `knowledge/*.json` from rs-sdk content (`bun packages/knowledge/src/build.ts`)
- `packages/core` - in-process bot session, walking, guards, session proofs, leases, encrypted vault
- `packages/workers` - nine parameterized worker engines (`gather`, `bank-artisan`, `combat`, `agility`, `runecraft`, `quest`, `market`, `logistics`, `pvp`)
- `packages/planner` - route, gear, and board models (`haggis-cli.ts`, `cairn-cli.ts`, `scout-cli.ts`)
- `packages/brain` - deterministic Fleet Brain (`WorldSnapshot`, `ActivityCatalog`, `DemandEngine`, `AccountPlanner`, `FleetScheduler`)
- `packages/fleet` - live controllers and daemons (`swarm.ts`, `fleet-agent.ts`, `fleet-sync.ts`, `cloud-side.ts`, `watchdog.ts`, `session-recovery.ts`, `live-update.ts`)
- `packages/practice` - local practice presets, lockstep bench, supervisors, rehearsals
- `packages/dashboard` - local web dashboard (`bun packages/dashboard/server.ts`) and hosted relay (`packages/dashboard/publish.ts`)
- `scripts/` - AIO dispatchers (`aio*.ts`), generated quest scripts (`scripts/generated/`), and bench runners (`scripts/measure/`)
- `tools/` - repo, CI, and diagnostic CLIs (`now.ts`, `ci-gate.ts`, `check-pin.ts`, `check-no-diary.ts`, `hosted-bench.ts`, `route-audit.ts`)
- `vendor/` - third-party reference clones (`vendor/rs-sdk` is the tracked submodule; others are created by `scripts/clone-vendor.sh`)
- `docs/` and `research/` - design architecture, contract, plans, and measured results (`research/INDEX.md`)
- `patches/rs-sdk.md` - how we work around rs-sdk behaviour

## Codex cloud fleet side

Set `FLEET_SIDE=cloud` in every shell and supply `FLEET_SEED` securely through environment settings. Keep a separate backup of the same seed. The seed derives cloud account passwords; never print it or commit/copy a `bot.env`. Register names on the fleet-data branch through `scripts/fleet-sync.ts` before login. Local-side accounts and Haggis remain outside the cloud controller's ownership.

A fresh checkout applies the repository's SDK setup patch with `git -C vendor/rs-sdk apply ../../patches/rs-sdk-working.patch` after submodule initialization. Do not apply it twice. The patch is setup input; code tasks leave vendor source alone.

The cloud runtime uses Bun's explicit WebSocket proxy option for the game host when `HTTPS_PROXY` is present. Fetch and sockets retain normal TLS verification. GitHub PR creation also needs access to `api.github.com`.

Use a cloud-only swarm plan and point the cloud swarm and sync agent at it:

```bash
export FLEET_SIDE=cloud
export SWARM_PLAN=/workspace/rs-sdk-bot/.practice/cloud-handoff/swarm.json
bun scripts/fleet-sync.ts
git -C .practice/fleet-data config rebase.autoStash true
DEMO_OK=1 bun scripts/fleet-agent.ts --daemon
```

Create that plan before starting the agent; an unreadable or malformed plan stops trading. Preserve the repository's admission limits and include only cloud-owned jobs. The agent excludes enabled jobs in `SWARM_PLAN` and pins each trade child to the current source. Before a trade it removes a stop file the swarm itself wrote for the account (`scripts/swarm.ts` `SWARM_STOP`, left when the planner takes the account off its job for the order), once the account is offline; an owner's stop file holds the trade. Inspect `.practice/fleet-agent.lock` for an existing owner before starting another daemon. Completed finite jobs stay disabled until a new useful assignment is authorized.

Rebuild each cloud account with `bun scripts/fleet.ts create <name>` at session startup, preserving the spelling in `fleet/owners.json`; Linux credential directory names are case sensitive. A tutorial account needs mainland entry before its first production job. Confirm a useful result and `LOGOUT logged-out` separately; a gathered item with a logout timeout is a failed run.

## Claude Code cloud fleet side

The Claude Code cloud environment is the `claude-cloud` side. Its container is fresh each session, so every session starts with the same setup; the commands below are the ones that work there.

```bash
git submodule update --init
git -C vendor/rs-sdk config core.autocrlf false
git -C vendor/rs-sdk apply ../../patches/rs-sdk-working.patch
bun install
(cd vendor/rs-sdk && bun install --frozen-lockfile --production)
(cd vendor/rs-sdk/server/webclient && bun install --frozen-lockfile)
(cd vendor/rs-sdk/server/engine && bun install --frozen-lockfile && bun run build)   # the native practice gates (session recovery) boot this engine
export FLEET_SIDE=claude-cloud
bun scripts/fleet-sync.ts
git -C .practice/fleet-data config rebase.autoStash true
```

`FLEET_SEED` is a secret in the environment's settings (the cloud environment menu in the session's title bar, then Edit, under environment variables), the same rule as the Codex side. A session reads it only when it starts after the secret is saved; a running session cannot pick it up. Without it `bun scripts/fleet.ts create <name>` writes a random password that no other session can rebuild, so create no account until `[ -n "$FLEET_SEED" ]` is true.

Automated coordinator provisioning needs a synced `.practice/fleet-data` worktree and, on cloud sides, `FLEET_SEED`. It checks the prepared first job and publishes an exclusive name reservation in `fleet/owners.json` before creating credentials. A name outside the fleet registry can already exist on the server. If the reservation or login result is uncertain, inspect the retained run identity before any retry.

The environment sets `HTTPS_PROXY`. Fetch inherits it; `packages/core/src/websocket-proxy.ts` gives the game WebSocket the same proxy for every non-local side. The relayed gateway `wss://rs-sdk-demo.fly.dev/gateway` opens through the proxy; the direct gateway port `7443` does not, and the SDK's own 3 s check falls back to the relay (`GATEWAY_DIRECT=false` skips the check).

Run only `claude-cloud` jobs, from a plan outside the code checkout, with the repository's admission limits (`maxBots` 4, `minFreeGB` 4). `scripts/swarm.ts` runs Fleet Brain (`packages/brain/`) automatically for all accounts owned by `claude-cloud` in `fleet/owners.json`:

```bash
mkdir -p .practice/cloud-handoff .practice/status .practice/swarm-logs .practice/live   # the release check reads .practice/status
export SWARM_PLAN=$PWD/.practice/cloud-handoff/swarm.json
bun scripts/fleet.ts create <name>      # a name from packages/core/src/names.ts; writes vendor/rs-sdk/bots/<name>/bot.env
# add {"side": "claude-cloud", "server": "rs-sdk-demo.fly.dev"} under that name in .practice/fleet-data/fleet/owners.json, then:
bun scripts/fleet-sync.ts
# first login: registers the name and skips Tutorial Island (about 10 ticks, lands at Lumbridge 3222,3222, logs out)
DEMO_OK=1 WORKER_RELEASE=$(bun packages/core/src/worker-release.ts) bun scripts/measure/tutorial.ts <name>
printf '{\n  "maxBots": 4,\n  "minFreeGB": 4,\n  "jobs": []\n}\n' > .practice/cloud-handoff/swarm.json
DEMO_OK=1 bun scripts/swarm.ts .practice/cloud-handoff/swarm.json
DEMO_OK=1 bun scripts/fleet-agent.ts --daemon
```

Live in-process logins claim the same remote Git ref `refs/heads/fleet-trade-claim/<lowercase-account>` before login. This includes direct scripts and registration. Only one process can hold the claim. Drain older workers before rolling out this rule across the fleet. The receiver proves the exact transfer, bank credit and logout. The sender proves the exact debit and logout. Fleet sync releases a terminal trade claim after it publishes the matching receipt. Other workers release their claim after they record the matching server logout and close the session.

If a trade needs reconciliation, keep the claim and the order reservation. A trade claim does not expire. Read the latest claim with `readFleetTradeClaim` in `packages/core/src/fleet-trade-claim.ts`. Confirm that the attempt did not connect, or reconcile both accounts and confirm logout. Release only the matching nonce with `releaseFleetTradeClaim`. Fleet sync does this by itself in three cases (`droppedTradeClaims` in `scripts/fleet-sync.ts`), each with the account's own receipt naming the claim, counting 0 and showing no change of its stack. One: the partner's receipt is terminal and `failed` (its logout is proved and it moved nothing), and the account's own worker is gone: its receipt reads `reconcile`, or it reads `prepared` and the order's window ended an hour ago. Two: the window is over, the account's own receipt reads `reconcile`, the partner has no receipt, and the partner's side published its fleet data two minutes or more after the window's end. A party writes its `prepared` receipt when it takes its claim and takes none after the window, so the partner never came. Three: the window is over, the account's own receipt reads `reconcile` and records `screen: false`: its worker saw no trade screen open in its whole session, so the trade did not connect, whatever the partner's receipt reads. Use a new order ID for a retry. Fleet Brain gives both parties of an open order no conflicting non-order job (`packages/brain/src/scheduler.ts`). After its window an order closes without a matched pair of receipts in two cases (`windowClosures` in `scripts/fleet-trade-settlement.ts`): one party failed with nothing moved and the other has no receipt, or a retry for the same parties, item and count holds the other half of the transfer. A receipt that is not terminal (`prepared`, or `reconcile`) counts as no receipt once its trade claim is released by this procedure; while the claim is held, it holds the order. Any other mismatch holds both accounts until it is reconciled.

An uncertain logout keeps the account claimed. The same checkout can replace a worker claim through session recovery only when the recovery permit matches the prior attempt and its worker process is dead. Trade and worker admission both accept an exact confirmed worker logout from the owning checkout. The owning checkout can replace a dead pre-login trade or worker claim if the exact pending marker survives and there is no matching session receipt. A pending recovery preserves its prior uncertain hold. A swarm claim left by a container that is gone can be replaced by another side that now owns the account in `fleet/owners.json`, once the claim and the claiming side's controller lease have both stood unrenewed for an hour (`ORPHAN_CLAIM_MS` in `packages/core/src/fleet-trade-claim.ts`). A fresh container of the same side replaces it on the same terms, judged by the claiming checkout's own renewals on the side's lease ref: its newest record is an hour old, or it has none there while another checkout holds the lease. The claiming checkout itself recovers only through session recovery, a side with no lease ref gives no takeover, and a trade claim never qualifies. A replacement trade uses a new order ID. Read the current holder with `readFleetAccountClaim`.

One container runs the side. Before the swarm starts work, it acquires `refs/heads/fleet-lease/<side>` on `origin` with a normal fast-forward push. The controller renews every three minutes. A renewal that does not land is tried again every 20 seconds while the remote ref still ends in this controller's last record, or cannot be read; the lease is lost, new work stops and owned workers are asked to log out when the ref shows another record or the eight minutes pass. If the controller dies, the local lease expires eight minutes after the last confirmed renewal. After that, workers refuse logins and request logout. Another checkout can take over after ten minutes. Keep host clocks synchronized. Each swarm needs push access to its lease ref.

Stop all old controllers for the side before moving it to this lease scheme. The first acquisition checks the existing fleet-data heartbeat, which can take 15 minutes to expire. Fleet sync still publishes that heartbeat for older readers.

The plan starts with an empty jobs list; a hand-written placeholder job with `"enabled": false` makes Brain treat the account as held out of automated scheduling. A fresh account on the mainland trains Thieving (`thieving55` via `scripts/generated/thieving60.ts`, Lumbridge men then Ardougne) because its knight farm yield outweighs feather pens once spots are available. `packages/brain/src/scheduler.ts` allocates shared spots up to `maxConcurrentAccounts` (`packages/brain/src/preflight.ts`). `fleet/claims/<side>.json` on `fleet-data`, which `scripts/fleet-sync.ts` writes from the side's plan (`SWARM_PLAN`) and Brain assignments, lists each held resource across sides so sides stay within each spot's capacity (claims older than two hours expire). An account pending `session_recovery` (`packages/fleet/src/session-recovery.ts`) preserves its claim until recovery completes. A side opts accounts into combat training toward the PK army via `army` in its plan (`packages/core/src/army-roster.ts`; never the main account, a specialist, or an owner-paused account), and `armyBatch` controls how many sub-90 melee accounts admit into combat bands. `FleetScheduler` fills up to `maxBots` slots (highest-priority bands and demand-driven work first), and admits practice-only AIO routes listed in the plan's `aio` array (`aio: ["aio-flax"]`). A useful live result is a bank or inventory gain in `.practice/status/<name>.json` after a bounded run with `LOGOUT logged-out`; sync after each so the snapshot carries the fresh observation.

A second container that runs its own accounts beside the `claude-cloud` controller is the `claude-cloud-2` side: the same commands with `FLEET_SIDE=claude-cloud-2` in every shell and `"side": "claude-cloud-2"` in `owners.json`, so its lease, claim, plan and snapshot never touch the `claude-cloud` files. A new name must be absent from every version of `fleet/owners.json` (`git -C .practice/fleet-data log -S'"<Name>"' -- fleet/owners.json` prints nothing) and from the hiscores: `https://rs-sdk-demo.fly.dev/hiscores/player/<name in lower case>?profile=main` answers 200 for a registered name and 404 for a free one, and only the lower-case form matches. A name another side registered answers its first login with code 3 (invalid username or password), because this seed cannot rebuild that side's password.

The cloud container can restart and kill its daemons and workers. Keep the checkout's `.practice` files so the next process can read its session evidence. On an authorized resume, start the daemons from the same checkout on `master`. A farm with an uncertain logout needs authenticated recovery before the worker can log in again.

The session's agent proxy drains its relay tunnels from time to time and closes the game WebSocket with code 1012 (`server_draining`); `curl -sS "$HTTPS_PROXY/__agentproxy/status"` lists each close under `recentRelayFailures`. The worker then ends `LOGOUT disconnected`, the account's fleet claim stays held and every later login fails `fleet account claim held by swarm` until an authenticated recovery confirms the logout. A Claude Code cloud container is also reclaimed about five minutes after its session goes idle, whatever daemons run, so the session keeps a `run_in_background` watchdog running at all times.

### One account pool across sides

Every side plans only the accounts `fleet/owners.json` gives it, with the same planner, so moving an owner row hands an account over completely. Three parts make any account usable from any side:

- **Credentials.** `packages/core/src/fleet-vault.ts` seals each `bot.env` with AES-256-GCM into `fleet/vault/<name>.json` on the `fleet-data` branch; the key is `FLEET_VAULT_KEY` (32 random bytes, base64), never in git. `openBot` restores a missing `bot.env` from it, and `bun scripts/fleet.ts create` restores before it would write a password and seals each new account. The main account is never sealed. Set it up once: `bun scripts/fleet-vault.ts keygen` on the PC writes `.practice/fleet-vault-key.txt`; put that value in `FLEET_VAULT_KEY` on the PC and in every cloud environment's settings, then run `bun scripts/fleet-vault.ts put --all-here` on each machine that holds `bot.env` files (the PC holds the local accounts' random passwords). `bun scripts/fleet-vault.ts status` lists, for each account, whether this machine has its `bot.env` and whether the vault holds it.
- **Adoption.** A side that runs its controller publishes a card, `fleet/sides/<side>.json`: its capacity (the plan's `fleetCapacity`, else `maxBots`), the accounts its owner paused with a stop file, and whether its owner stopped the swarm. In each sync after its push it adopts, up to that capacity, the accounts of a side whose lease has been silent for an hour, when their claim is free and it can log them in, and marks them with their `home` side. It hands an adopted account back once its home side renews its lease again, has room on its card and the account is idle. The main and specialist accounts, paused accounts, a stopped side's accounts and accounts in a held trade claim never move. `bun scripts/fleet-sync.ts --adopt-dry [--capacity <n>]` prints what the next pass would move; `FLEET_ADOPT=0` turns adoption off for a side.
- **Shared data.** Everything a side's planner, swarm and fleet agent decide from is on the `fleet-data` branch: owners, the vault, snapshots (each account's bank, pack, worn items, skill levels and quests), resource claims, plans, orders and receipts, leases and side cards. A side's card also lists its accounts whose last swarm end was a death, so no side adopts and restarts one. An account that changed side can stand in two snapshot files; `packages/core/src/fleet-snapshots.ts` gives every reader (the planner, fleet sync, the supply bill, the scoreboard and the dashboard) one row for it: the owner side's row, else the freshest. Fleet sync carries an adopted account's last row into its new side's snapshot, so the new side plans it from its real levels and bank. Machine-local files stay local: status files, logs, the coordinator queue, session lifecycle proofs and the planner's per-machine assignment record.
- **Cloud sessions from the PC.** `bun scripts/cloud-side.ts --side <side>` is the whole job of a cloud session: the setup, the side's credentials, its plan (`.practice/cloud-handoff/swarm.json`), the swarm, fleet agent and planner as detached daemons, then a quiet watch that restarts a dead daemon (at most six starts an hour) and prints one `RESULT` line after `--watch-minutes` (110). The daemons outlive the command. With `--stop-at-end` it stops the swarm with its own stop text at the end, so each worker logs out (a Codex task, whose container ends with it). An owner's `stop-swarm` makes it start nothing and print `RESULT stop`. The PC's watchdog runs `bun scripts/cloud-launch.ts --once` on each pass when `.practice/cloud-launch/config.json` exists (`.practice/stop-cloud-launch` keeps it off; `--dry` shows what it would start). It starts a configured side whose lease is silent while it owns accounts or some side's accounts are stranded: at most `maxClaude` (1) Claude Code and `maxCodex` (1) Codex sessions live or starting, one launch per side per 40 minutes, twelve a day. A failed bootstrap permits diagnosing its saved log, applying an existing proved repair, and running a focused check before one changed retry while preserving source/vendor edits and credentials. An SDK reset requires fresh classification and a verified recovery copy (retain diagnostics if unresolved).

Launcher config: a Claude Code side is best started through a scheduled task's API trigger (`"via": "routine"`). On claude.ai/code create a scheduled task on this repository with no schedule, the side's environment (with `FLEET_SIDE`, `FLEET_SEED` and `FLEET_VAULT_KEY`) and the smallest model that follows the prompt, and paste the prompt `bun scripts/cloud-launch.ts --prompt claude <side>` prints; add an API trigger and save its token, shown once, in the file the config's `tokenFile` names. `"via": "cli"` runs `claude --cloud` instead, which uses the default environment chosen with `/remote-env`. A Codex side needs `codex login` on the PC and its environment id from `codex cloud`; its task runs `--watch-minutes 50 --stop-at-end` (a side's `watchMinutes` changes it). On Windows npm installs the CLIs as `.cmd` shims, which the launcher cannot start without a shell that would split the prompt: set the side's `bin` to the native executable.

```json
{ "enabled": true, "maxClaude": 1, "maxCodex": 1, "sides": [
  { "side": "claude-cloud", "kind": "claude", "via": "routine", "routine": "trig_...", "tokenFile": ".practice/cloud-launch/claude-cloud.token" },
  { "side": "cloud", "kind": "codex", "env": "<codex environment id>" } ] }
```

A launched session spends few tokens: its prompt has it start the one command in the background and start it again when it ends, about thirteen short turns a day, and read nothing. The setup sets `submodule.vendor/rs-sdk.ignore dirty`, so the patched SDK does not read as uncommitted work and a stop hook does not wake the session after each turn.

### Running standalone recovery & watchdog

`packages/fleet/src/swarm.ts` runs Fleet Brain planning cycles on both local and cloud sides (unless in bounded recovery/inspection mode), publishes `.practice/live/fleet-state.json`, and tracks held sessions in `.practice/swarm-deaths.json`.

- `bun packages/fleet/src/session-recovery.ts` (and `bun scripts/cloud-recover.ts`) recovers held live sessions through controlled recovery permits (`packages/core/src/session-recovery-permit/`) without burning the 2-attempt budget on infrastructure outages or missing native qualifications, and clears stale recovery leases and swarm-authored stop files under active `swarm` ownership.
- `bun packages/fleet/src/watchdog.ts` prunes aged practice status rows, keeps `dashboard-publish` and down controllers running when no `.practice/stop-swarm` or `.practice/stop-coordinator` pause exists, and invokes `runStandaloneRecoveryPass` on the local side. `.practice/stop-session-recovery` pauses recovery calls while keeping controllers running.
