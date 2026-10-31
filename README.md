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
- `packages/dashboard` - local web dashboard (`bun packages/dashboard/server.ts`); `scripts/dashboard-publish.ts` relays its state to the hosted dashboard (the rs-fleet-command repository) and applies the owner's commands from it
- `packages/router` - authors bot scripts through a Claude CLI loop (`packages/router/src/author-cli.ts`)
- `scripts/` - bot scripts; `scripts/generated/` and `scripts/measure/` are produced or measured runs
- `vendor/` - third-party reference clones. `vendor/rs-sdk` is the tracked submodule; the others are gitignored, re-created by `scripts/clone-vendor.sh`
- `docs/` and `research/` - design notes and measured results. `research/INDEX.md` lists the research files.
- `patches/rs-sdk.md` - how we work around rs-sdk behaviour
