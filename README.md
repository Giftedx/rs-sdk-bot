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

Create that plan before starting the agent; an unreadable or malformed plan stops trading. Preserve the repository's admission limits and include only cloud-owned jobs. The agent excludes enabled jobs in `SWARM_PLAN` and pins each trade child to the current source. Inspect `.practice/fleet-agent.lock` for an existing owner before starting another daemon. Completed finite jobs stay disabled until a new useful assignment is authorized.

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

One container runs the side. Before the swarm starts work, it acquires `refs/heads/fleet-lease/<side>` on `origin` with a normal fast-forward push. The controller renews every three minutes. If renewal fails, new work stops and owned workers are asked to log out. If the controller dies, the local lease expires eight minutes after the last confirmed renewal. After that, workers refuse logins and request logout. Another checkout can take over after ten minutes. Keep host clocks synchronized. Each swarm needs push access to its lease ref.

Stop all old controllers for the side before moving it to this lease scheme. The first acquisition checks the existing fleet-data heartbeat, which can take 15 minutes to expire. Fleet sync still publishes that heartbeat for older readers.

The plan starts with an empty jobs list; a hand-written placeholder job with `"enabled": false` would make the planner treat the account as paused. A fresh account on the mainland gets `thieving55` (`scripts/generated/thieving60.ts`, Lumbridge men, then the Ardougne boat and market): its share of the knight farm it unlocks is worth more per tick than feathers, so the planner takes a feather pen only when every knight spot is reserved. `fleet/claims/<side>.json` on the fleet-data branch, which every `scripts/fleet-sync.ts` run writes from the side's plan (`SWARM_PLAN`), keeps each side off the pens and spots another side holds; a claim older than two hours does not count. One session runs a side's swarm, planner and fleet agent; every other session of that side (a fresh container beside it) only reads: its sync with an empty plan keeps the side's published claim and plan, and keeps every snapshot row it has no fresher status for, and its planner reads those snapshot rows in place of the status files it lacks. A useful live result is a bank or inventory gain in `.practice/status/<name>.json` after a bounded run with `LOGOUT logged-out`; sync after each so the snapshot carries the fresh observation.

A second container that runs its own accounts beside the `claude-cloud` controller is the `claude-cloud-2` side: the same commands with `FLEET_SIDE=claude-cloud-2` in every shell and `"side": "claude-cloud-2"` in `owners.json`, so its lease, claim, plan and snapshot never touch the `claude-cloud` files. A new name must be absent from every version of `fleet/owners.json` (`git -C .practice/fleet-data log -S'"<Name>"' -- fleet/owners.json` prints nothing) and from the hiscores: `https://rs-sdk-demo.fly.dev/hiscores/player/<name in lower case>?profile=main` answers 200 for a registered name and 404 for a free one, and only the lower-case form matches. A name another side registered answers its first login with code 3 (invalid username or password), because this seed cannot rebuild that side's password.

The cloud container is reclaimed when its session goes idle and can also restart while a turn or background task is running; every daemon and bot dies with it, and the files under `.practice` survive. A farm cut off this way ends with `RESULT fail session ended: disconnected` in its account's status file (`settle` in `packages/core/src/bot.ts`), so the swarm's standing retry (`standingRetryable` in `scripts/swarm.ts`) restarts it once that file is 15 minutes old. After a restart, start the three daemons again from a checkout of `master`; to restart the farms sooner, give each account one bounded run that ends with a confirmed logout, `DEMO_OK=1 WORKER_RELEASE=$(bun packages/core/src/worker-release.ts) bun scripts/walk-to.ts <name> 2655 3283`, and the standing retry restarts it 2 minutes later.
