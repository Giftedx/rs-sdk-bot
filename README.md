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
- `packages/dashboard` - local web dashboard (`bun packages/dashboard/server.ts`)
- `packages/router` - authors bot scripts through a Claude CLI loop (`packages/router/src/author-cli.ts`)
- `scripts/` - bot scripts; `scripts/generated/` and `scripts/measure/` are produced or measured runs
- `vendor/` - third-party reference clones. `vendor/rs-sdk` is the tracked submodule; the others are gitignored, re-created by `scripts/clone-vendor.sh`
- `docs/` and `research/` - design notes and measured results. `research/INDEX.md` lists the research files.
- `patches/rs-sdk.md` - how we work around rs-sdk behaviour

## Cloud fleet side

Set `FLEET_SIDE=cloud` in every shell and supply `FLEET_SEED` securely through environment settings. Keep a separate backup of the same seed. The seed derives cloud account passwords; never print it or commit/copy a `bot.env`. Register names on the fleet-data branch through `scripts/fleet-sync.ts` before login. Local-side accounts and Haggis remain outside the cloud controller's ownership.

A fresh checkout applies the repository's SDK setup patch with `git -C vendor/rs-sdk apply ../../patches/rs-sdk-working.patch` after submodule initialization. Do not apply it twice. The patch is setup input; code tasks leave vendor source alone.

The cloud runtime uses Bun's explicit WebSocket proxy option for the game host when `HTTPS_PROXY` is present. Fetch and sockets retain normal TLS verification. GitHub PR creation also needs access to `api.github.com`.

Use a cloud-only swarm plan and point both controllers at it:

```bash
export FLEET_SIDE=cloud
export SWARM_PLAN=/workspace/rs-sdk-bot/.practice/cloud-handoff/swarm.json
bun scripts/fleet-sync.ts
git -C .practice/fleet-data config rebase.autoStash true
DEMO_OK=1 bun scripts/fleet-agent.ts --daemon
```

Create that plan before starting the agent; an unreadable or malformed plan stops trading. Preserve the repository's admission limits and include only cloud-owned jobs. The agent excludes enabled jobs in `SWARM_PLAN` and pins each trade child to the current source. Inspect `.practice/fleet-agent.lock` for an existing owner before starting another daemon. Completed finite jobs stay disabled until a new useful assignment is authorized.

Rebuild each cloud account with `bun scripts/fleet.ts create <name>` at session startup, preserving the spelling in `fleet/owners.json`; Linux credential directory names are case sensitive. A tutorial account needs mainland entry before its first production job. Confirm a useful result and `LOGOUT logged-out` separately; a gathered item with a logout timeout is a failed run.
