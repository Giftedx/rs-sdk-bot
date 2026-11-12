# rs-sdk-bot

Bot scripts and tooling for the rs-sdk (MaxBittker/rs-sdk, MIT) demo and local practice server. Built on the pinned rs-sdk submodule.

Start with [the working guide](AGENTS.md), [current plan](docs/plans/joined-plan.md), and [research map](research/INDEX.md).
Use the [swarm script contract](docs/script-contract.md) for reusable scripts, account admission, progress and recovery.

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
| `bun run typecheck` | `tsc --noEmit` over `scripts/`, `packages/*/src`, `packages/*/test` |
| `bun test ./scripts ./packages` | Unit tests; report the current pass/skip/fail counts |
| `bun run check-pin` | Checks the `vendor/rs-sdk` checkout against `rs-sdk.pin` |
| `bun run deliver --list` | Lists runnable capability checks |
| `bun run deliver ammo-order` | Checks tip delivery, Fletching consumption, banked arrows and duplicate rejection on local practice accounts |
| `bun run deliver wine-order` | Checks a reusable Cooking order, relog, stock accounting and saved target level |

The persistent coordinator uses `bun run coordinate --run <unique-owner-token>`. Inspect it with `bun run coordinate --status`; pause it with `bun run coordinate --stop`. Its settings and bootstrap tasks live in `swarm.json.coordination`. See the [coordination contract](docs/script-contract.md#autonomous-coordination) for recovery and proof scope.

Use the [delivery path](docs/script-contract.md#deliver-a-capability) to develop and qualify a reusable capability. Native acceptance and live release remain separate.

## Safety

- The default server is the local practice server (`localhost:8888`). Connecting anywhere else needs `DEMO_OK=1` set on purpose (`packages/core/src/bot.ts`).
- The dashboard listens on `127.0.0.1` only. `DASH_HOST=0.0.0.0` opens it to the network on purpose; its state shows bot positions, inventories, banks and account names.
- `bot.env` holds bot credentials. It is gitignored. Never commit it or print its `PASSWORD=` line.
- The core attempts logout before exit. Check `LOGOUT logged-out`: failed logout can leave scored playtime running until the server timeout. Stop-file handling is in `packages/core/src/bot.ts`. Preserve bots owned by another task.

## Layout

- `packages/core` - the in-process bot session, walking, ledger, status
- `packages/practice` - local practice presets, supervisor, host
- `packages/knowledge` - builds `knowledge/*.json` from rs-sdk content (`bun packages/knowledge/src/build.ts`)
- `packages/planner` - rate and board planning
- `packages/dashboard` - local web dashboard (`bun packages/dashboard/server.ts`); `packages/dashboard/publish.ts` relays its state to the hosted dashboard (the rs-fleet-command repository) and applies the owner's commands from it
- `packages/router` - authors bot scripts through a Claude CLI loop (`packages/router/src/author-cli.ts`)
- `scripts/` - bot scripts; `scripts/generated/` and `scripts/measure/` are produced or measured runs
- `vendor/` - third-party reference clones. `vendor/rs-sdk` is the tracked submodule; the others are gitignored, re-created by `scripts/clone-vendor.sh`
- `docs/` and `research/` - design notes and measured results. `research/INDEX.md` lists the research files.
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

Run only `claude-cloud` jobs, from a plan outside the code checkout, with the repository's admission limits (`maxBots` 4, `minFreeGB` 4) and one job per account marked `"autopilot": "claude-cloud"` so the planner owns it:

```bash
mkdir -p .practice/cloud-handoff .practice/status .practice/swarm-logs   # the release check reads .practice/status; a missing directory refuses every live login
export SWARM_PLAN=$PWD/.practice/cloud-handoff/swarm.json
bun scripts/fleet.ts create <name>      # a name from packages/core/src/names.ts; writes vendor/rs-sdk/bots/<name>/bot.env
# add {"side": "claude-cloud", "server": "rs-sdk-demo.fly.dev"} under that name in .practice/fleet-data/fleet/owners.json, then:
bun scripts/fleet-sync.ts
# first login: registers the name and skips Tutorial Island (about 10 ticks, lands at Lumbridge 3222,3222, logs out)
DEMO_OK=1 WORKER_RELEASE=$(bun packages/core/src/worker-release.ts) bun scripts/measure/tutorial.ts <name>
printf '{\n  "maxBots": 4,\n  "minFreeGB": 4,\n  "jobs": []\n}\n' > .practice/cloud-handoff/swarm.json
bun scripts/autopilot.ts .practice/cloud-handoff/swarm.json --dry   # then without --dry: writes one marked standing job per account
DEMO_OK=1 bun scripts/swarm.ts .practice/cloud-handoff/swarm.json
DEMO_OK=1 bun scripts/fleet-agent.ts --daemon
bun scripts/autopilot.ts .practice/cloud-handoff/swarm.json --daemon
```

Live in-process logins claim the same remote Git ref `refs/heads/fleet-trade-claim/<lowercase-account>` before login. This includes direct scripts and registration. Only one process can hold the claim. Drain older workers before rolling out this rule across the fleet. The receiver proves the exact transfer, bank credit and logout. The sender proves the exact debit and logout. Fleet sync releases a terminal trade claim after it publishes the matching receipt. Other workers release their claim after they record the matching server logout and close the session.

If a trade needs reconciliation, keep the claim and the order reservation. A trade claim does not expire. Read the latest claim with `readFleetTradeClaim` in `packages/core/src/fleet-trade-claim.ts`. Confirm that the attempt did not connect, or reconcile both accounts and confirm logout. Release only the matching nonce with `releaseFleetTradeClaim`. Fleet sync does this by itself in three cases (`droppedTradeClaims` in `scripts/fleet-sync.ts`), each with the account's own receipt naming the claim, counting 0 and showing no change of its stack. One: the partner's receipt is terminal and `failed` (its logout is proved and it moved nothing), and the account's own worker is gone: its receipt reads `reconcile`, or it reads `prepared` and the order's window ended an hour ago. Two: the window is over, the account's own receipt reads `reconcile`, the partner has no receipt, and the partner's side published its fleet data two minutes or more after the window's end. A party writes its `prepared` receipt when it takes its claim and takes none after the window, so the partner never came. Three: the window is over, the account's own receipt reads `reconcile` and records `screen: false`: its worker saw no trade screen open in its whole session, so the trade did not connect, whatever the partner's receipt reads. Use a new order ID for a retry. The planner gives both parties of an open order no job (`inOpenOrder` in `scripts/autopilot.ts`). After its window an order closes without a matched pair of receipts in two cases (`windowClosures` in `scripts/fleet-trade-settlement.ts`): one party failed with nothing moved and the other has no receipt, or a retry for the same parties, item and count holds the other half of the transfer. A receipt that is not terminal (`prepared`, or `reconcile`) counts as no receipt once its trade claim is released by this procedure; while the claim is held, it holds the order. Any other mismatch holds both accounts until it is reconciled.

An uncertain logout keeps the account claimed. The same checkout can replace a worker claim through session recovery only when the recovery permit matches the prior attempt and its worker process is dead. Trade and worker admission both accept an exact confirmed worker logout from the owning checkout. The owning checkout can replace a dead pre-login trade or worker claim if the exact pending marker survives and there is no matching session receipt. A pending recovery preserves its prior uncertain hold. A swarm claim left by a container that is gone can be replaced by another side that now owns the account in `fleet/owners.json`, once the claim and the claiming side's controller lease have both stood unrenewed for an hour (`ORPHAN_CLAIM_MS` in `packages/core/src/fleet-trade-claim.ts`); a claim of the caller's own side and a trade claim never qualify. A replacement trade uses a new order ID. Read the current holder with `readFleetAccountClaim`.

One container runs the side. Before the swarm starts work, it acquires `refs/heads/fleet-lease/<side>` on `origin` with a normal fast-forward push. The controller renews every three minutes. A renewal that does not land is tried again every 20 seconds while the remote ref still ends in this controller's last record, or cannot be read; the lease is lost, new work stops and owned workers are asked to log out when the ref shows another record or the eight minutes pass. If the controller dies, the local lease expires eight minutes after the last confirmed renewal. After that, workers refuse logins and request logout. Another checkout can take over after ten minutes. Keep host clocks synchronized. Each swarm needs push access to its lease ref.

Stop all old controllers for the side before moving it to this lease scheme. The first acquisition checks the existing fleet-data heartbeat, which can take 15 minutes to expire. Fleet sync still publishes that heartbeat for older readers.

The plan starts with an empty jobs list; a hand-written placeholder job with `"enabled": false` would make the planner treat the account as paused. A fresh account on the mainland gets `thieving55` (`scripts/generated/thieving60.ts`, Lumbridge men, then the Ardougne boat and market): its share of the knight farm it unlocks is worth more per tick than feathers, so the planner takes a feather pen only when every knight spot holds four farmers. A knight spot takes four farmers (`CAPACITY` in `packages/planner/src/autopilot.ts`), each worth less than the one before, so the empty spots fill first, and a farmer keeps its spot until that spot is full; a pen or a shop takes one. `fleet/claims/<side>.json` on the fleet-data branch, which every `scripts/fleet-sync.ts` run writes from the side's plan (`SWARM_PLAN`), lists each resource once per job that holds it, so the sides together stay within each spot's capacity; a claim older than two hours does not count. A planner pass that changes the resources its plan holds starts a sync at once, so the other sides see the new claim within seconds rather than at the fleet agent's next sync. An account the coordinator is recovering keeps its own job's places in the claim, since it returns to that job. A side opts accounts into combat training toward the PK army by listing them in its plan's `army` array; only those accounts take the planner's goal bands, which come before any coin job. A side admits an AIO route that has practice proof only (`aioTemplates` in `packages/planner/src/autopilot.ts`: `scripts/aio.ts` jobs for flax, bow strings, yew logs, arrow shafts, ore, rune essence, air runes, iron, mithril, adamantite and runite bars, cannonballs, rune scimitars, blood runes and Rune Mysteries) by listing its template id in its plan's `aio` array, for example `"aio": ["aio-flax"]`; the planner gives no such route without it, and each route's place takes one account. One session runs a side's swarm, planner and fleet agent; every other session of that side (a fresh container beside it) only reads: its sync with an empty plan keeps the side's published claim and plan, and keeps every snapshot row it has no fresher status for, and its planner reads those snapshot rows in place of the status files it lacks. A useful live result is a bank or inventory gain in `.practice/status/<name>.json` after a bounded run with `LOGOUT logged-out`; sync after each so the snapshot carries the fresh observation.

A second container that runs its own accounts beside the `claude-cloud` controller is the `claude-cloud-2` side: the same commands with `FLEET_SIDE=claude-cloud-2` in every shell and `"side": "claude-cloud-2"` in `owners.json`, so its lease, claim, plan and snapshot never touch the `claude-cloud` files. A new name must be absent from every version of `fleet/owners.json` (`git -C .practice/fleet-data log -S'"<Name>"' -- fleet/owners.json` prints nothing) and from the hiscores: `https://rs-sdk-demo.fly.dev/hiscores/player/<name in lower case>?profile=main` answers 200 for a registered name and 404 for a free one, and only the lower-case form matches. A name another side registered answers its first login with code 3 (invalid username or password), because this seed cannot rebuild that side's password.

The cloud container can restart and kill its daemons and workers. Keep the checkout's `.practice` files so the next process can read its session evidence. On an authorized resume, start the daemons from the same checkout on `master`. A farm with an uncertain logout needs authenticated recovery before the worker can log in again.

The session's agent proxy drains its relay tunnels from time to time and closes the game WebSocket with code 1012 (`server_draining`); `curl -sS "$HTTPS_PROXY/__agentproxy/status"` lists each close under `recentRelayFailures`. The worker then ends `LOGOUT disconnected`, the account's fleet claim stays held and every later login fails `fleet account claim held by swarm` until an authenticated recovery confirms the logout. A Claude Code cloud container is also reclaimed about five minutes after its session goes idle, whatever daemons run, so the session keeps a `run_in_background` watchdog running at all times.

### Running a side under its coordinator

A side that runs its swarm under its own coordinator recovers a held account while the other farmers keep running: the recovery is a submitted task that the running controller processes.

```bash
(cd vendor/rs-sdk/server/engine && bun install --frozen-lockfile && bun run build)   # the recovery proof runs the native server
mkdir -p .practice/cloud-handoff/nomodel
printf '#!/bin/sh\necho "model CLI disabled" >&2\nexit 1\n' > .practice/cloud-handoff/nomodel/claude
cp .practice/cloud-handoff/nomodel/claude .practice/cloud-handoff/nomodel/codex && chmod +x .practice/cloud-handoff/nomodel/*
git update-index --skip-worktree swarm.json   # the side plan lives in root swarm.json and is never committed
# root swarm.json: the side plan (maxBots 4, minFreeGB 4, the planner's jobs) plus
#   "coordination": {"enabled": true, "maxActive": 1, "maxLive": 4, "plannerIntervalMs": 86400000, "agents": [], "bootstrap": []}
export SWARM_PLAN=$PWD/swarm.json             # for scripts/autopilot.ts, scripts/fleet-agent.ts and scripts/fleet-sync.ts
env -u SWARM_PLAN DEMO_OK=1 PATH="$PWD/.practice/cloud-handoff/nomodel:$PATH" bun packages/router/src/coordinator-cli.ts --run
```

Pull `master` into a side checkout without touching the side plan. `git merge --ff-only origin/master` works while upstream left `swarm.json` alone. When upstream changed it too, a plain pull refuses. Checking out the committed `swarm.json` would hand the swarm the PC's plan, and it would stop the side's farmers with `swarm plan removed or stopped`. Move the index instead, and keep the working file:

```bash
git fetch origin master && old=$(git rev-parse HEAD)
git reset --soft origin/master
git diff --name-only --diff-filter=d "$old" origin/master | grep -vx swarm.json | xargs -r git checkout origin/master --
git diff --name-only --diff-filter=D "$old" origin/master | xargs -r git rm -q --cached --ignore-unmatch   # then delete those files
git update-index --cacheinfo "100644,$(git rev-parse origin/master:swarm.json),swarm.json" && git update-index --skip-worktree swarm.json
```

The coordinator starts `scripts/swarm.ts swarm.json` itself while an enabled standing job exists, and adopts a running swarm through `.practice/coordinator/swarm-owner.json`. The stub makes the coordinator's model planner fail, so it queues no work of its own; it retries with a growing delay. `autoExpand` stays unset, so the coordinator creates no accounts. Switching an existing side over stops its plain swarm with `.practice/stop-swarm` (each worker logs out), removes that file and the controller's `stop-<name>` files, then starts the coordinator.

`bun scripts/cloud-recover.ts`, run by the watchdog with the stub on `PATH`, recovers up to 11 accounts per call, the most one coordinator proposal of 12 tasks holds; more held accounts wait for the next call. It takes an account of this side whose logout proof is held, whose fleet claim is a swarm claim with a dead worker, with no owner stop file and with an end record in `.practice/swarm-deaths.json`. It also takes one with no held claim at all whose end record is the swarm's orphan end for the held attempt: a trade worker that dropped, after fleet sync released its trade claim. It first removes a stop file the swarm itself wrote for the account (`scripts/swarm.ts` `SWARM_STOP`, left when the account's job leaves the plan), because the coordinator refuses a live task while any `stop-<name>` exists; under `stop-swarm` it removes none. It also moves aside a stale recovery lease (`.practice/coordinator/session-recovery/accounts/<name>/lease.json` renamed `lease-stale-<time>.json`): one a held recovery child left, whose process is gone or which recorded no child and whose permit has expired. While that file is there the swarm refuses every recovery and login of the account. A lease whose child still runs, or that cannot be read, keeps the account out of the call. A held attempt newer than the end record normally means the supervisor is still retrying, and the account waits; once a recovery of that end has failed, the newer attempt is that recovery's own session and the account is submitted again. It then submits one qualify task and a recovery run task for each account with fresh ids (`bun run coordinate --submit <proposal>`), waits for the run tasks and a `confirmed` `readLogoutProof`, then releases the accounts. A proposal the coordinator rejects ends the call at once (`submit rejected by the coordinator`). A release archives the parked session checks and leaves in the coordinator's `jobs.json` a parked copy of an owner job whose logout is not confirmed yet (`release left in jobs.json`), so one unsettled account does not hold the others; an enabled job or any other coordinator job still stops the whole release. It refuses with a logged reason when the coordinator is not running, when a death ended the account, or when the end record is gone. The swarm's standing retry deletes the end record once the account's status is 15 minutes old (`BOOTSTRAP_STATUS_AGE_MS`), so a recovery starts within that window; an owner stop file does not keep the record, and the recovery login refuses while `stop-<name>` exists.

A finished recovery leaves a disabled `scripts/session-check.ts` job owned by the coordinator in `.practice/coordinator/jobs.json`. That job shadows the account's planner job (`AUTOPILOT hold <name>: coordinator owns the assignment`, and the side's claim drops the account) until the file changes. The release stops the coordinator (`bun run coordinate --stop`; the swarm and its workers are detached and keep running), waits for the `--run` process to exit, moves `jobs.json` and `.practice/stop-coordinator` into `.practice/coordinator/release-archive/<time>-<account>/` and starts `--run` again, which adopts the running swarm. The account's planner job then starts.
