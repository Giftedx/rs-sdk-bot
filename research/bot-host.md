# Bot host: many bots in one process (2026-10-23)

Evidence: MEASURED practice (local server, 150 ms tick) + CODE-READ. Boards: infra (all).

## Summary

- One bot process costs about 520-650 MB RSS. About 470 MB of that is static data that every bot process loads
  again: the collision JSON, the rsmod pathfinder wasm memory, and the JS that `initPathfinding()` builds. One
  logged-in session adds only about 30-50 MB.
- `packages/core/src/host.ts` runs N bot scripts in one process. The bots share the pathfinder, the collision
  data, the world graph, the webclient config cache and (new) one loc index. Scripts run unchanged.
- 4-bot proof, 3 rounds on practice: 4 bots in one host use 546 MB mean (137 MB per bot) against 2,188 MB (547 MB
  per bot) for 4 separate processes, 4.0x less. Coins/tick 15.07 vs 14.40 and idle 5.5% vs 5.4%; all 24 bot runs
  `RESULT ok`.

## 1. Where the memory goes (one bot, one process)

Measured with `process.memoryUsage()` and `bun:jsc heapStats()` after `Bun.gc(true)` at each stage, one fresh
`goldfarm_knights` account, `RANDOM_EVENTS=0`, practice server. Script: session scratchpad `mem.ts` (not
committed). Output lines (MB):

```
MEM bun start                    rss=79.5  heapSize=0.2   extra=0.0   arrayBuffers=0.0  objects=3040
MEM webclient modules            rss=107.1 dRss=27.6  heapSize=7.0   objects=26958
MEM sdk modules (+collision json) rss=303.3 dRss=196.2 heapSize=107.6 objects=2849037
MEM rsmod wasm module            rss=305.6 dRss=2.3   wasmMem=1.1
MEM pathfinding init             rss=552.6 dRss=247.1 heapSize=311.1 extra=201.2 arrayBuffers=99.6 wasmMem=99.6 restored=true ms=582
MEM core modules                 rss=553.2 dRss=0.6
MEM world graph                  rss=554.7 dRss=1.5
MEM session 1 in game            rss=649.6 dRss=94.9  heapSize=341.8 extra=218.3
MEM session 1 +60 ticks          rss=516.4 dRss=-133.1 heapSize=341.6
MEM after close                  rss=521.0
```

| Part | RSS | What it is | Shared in the host |
|---|---|---|---|
| Bun runtime | 80 MB | empty process | yes (one process) |
| Webclient modules | 28 MB | lite client code, dom shim | yes |
| SDK modules | 196 MB | `sdk/index.ts` imports `sdk/pathfinding.ts` (index.ts:37), which imports the 27.5 MB `collision-data.json` as a module (pathfinding.ts:4): 2.8 M JS objects, about 100 MB of heap, kept for the life of the process | yes |
| Pathfinding init | 247 MB | rsmod wasm memory 99.6 MB (snapshot restore, `pathcache.ts`) plus about 100 MB of JS heap from `initPathfinding()` (`populatedZones` set, door index) | yes |
| World graph | 1.5 MB | `getWorld()` | yes (bot.ts module memo) |
| One session | about 30 MB heap, 17 MB extra | LiteClient state, SDK state, ledger, status, random events, plus a 14 MB loc index read per session (`session.ts:119`) | per bot; the loc index is shared by the host |

The status file writer, ledger and random event watcher are inside the "one session" row; they do not show as a
separate step. RSS peaks near 650 MB at login and settles near 520 MB.

So about 470 MB of each bot process is the same static data. The marginal cost of one more bot in a process that
already has it is the session row only.

## 2. Design

Order of effort:

(a) **Bot host (built).** One bun process, N sessions. The static data is module state, so it is loaded once per
process already: `loadPathfinding()` memoizes (`pathcache.ts`), `connectInProcess` initializes it once
(`inprocess.ts`, `pathfindingReady`), `getWorld()` memoizes (`bot.ts`), `loadCache()` memoizes (`cache.ts:64`).
The upstream lite client is built for this: `swarm.ts` runs N lite clients in one process. The one gap was the loc
index, which `session.ts` loads per session; `LocIndex.ts:9-10` says it is meant to be shared and its data is read
only (overlays live in each client's `SceneLite`). The host memoizes `LocIndex.load` per cache file.

The hard part is that the scripts are top-level programs: they read `process.argv[2]`, print with `console.log`,
and end with `finish()`, which calls `process.exit`. The host keeps them unchanged:

- It imports each script once per bot as `<script>?hostscript=<id>`. Bun evaluates each query as a new module, so
  each bot has its own script state. Every other module (bot.ts, pathfinding, ticks, world) is shared.
- A runtime `Bun.plugin` rewrites that one script file at load: `process.argv`, `process.env`, `process.exit` and
  `console.log/error/warn/info` go to per-bot values, and the import of `packages/core/src/bot` goes to a per-bot
  wrapper that re-exports bot.ts and overrides only `openBot` (per-bot log) and `finish`.
- The hosted `finish` runs `settle()` (RESULT, ledger, events, logout, close) and then returns a promise that never
  resolves, so nothing after `finish()` runs, the same as after a process exit.
- `AsyncLocalStorage` was the first plan. It does not reach module top-level code in Bun 1.3.14, and
  `enterWith()` crashed Bun (segfault). Source rewrite was the working method.

Additive changes outside host.ts (single-bot runs keep the same output and exit codes):

- `bot.ts`: `openBot(name, opts?)` takes an optional `log` for START/LOGOUT. `finish()` is split into `settle()`
  (no exit, returns the final ok) plus the same exit and 30 s backstop as before.
- `status.ts`: `noteStatusLine(name, line)` keeps MILESTONE and RESULT per bot. Without it every hosted bot's
  dashboard phase would show the last line of any bot. Bots with no entry use the old process-wide lines.

Limits:

- Only the script file is rewritten. A helper module that calls `finish()` or reads `process.argv[2]` sees the host
  values.
- `process.env` per bot is a copy taken at start; the CLI gives every bot the host's env.
- One bot's uncaught error is logged as `[host] ...` and does not stop the others. If a script throws at top level,
  the host logs out that bot's sessions (a crashed single process drops them without logout).
- Vendor log lines (`Pathfinding initialized`, `[lite] ... session ended`) are not prefixed with the bot name.
- `WordFilter.enabled` is process-wide (`session.ts` comment); we do not set it.

Usage:

```
bun packages/core/src/host.ts scripts/goldfarm.ts botA botB botC botD [--stagger-ms N] [--mem-every-s N]
```

Output: `[bot] line` on stdout, and the bare lines in `.practice/logs/host-<bot>.log`. `HOST done ok=k/N ...
peakRssMB=...` at the end; exit 0 when every script finished ok.

## 3. 4-bot proof

Setup: `scripts/goldfarm.ts`, preset `goldfarm_knights`, `TICKS=600`, `RANDOM_EVENTS=0`, 4 fresh accounts per run,
local practice server. Each round ran a host run (one `bun packages/core/src/host.ts` process, 4 bots) and then a
separate run (4 `bun scripts/goldfarm.ts <bot>` processes). 3 rounds. Memory is the Windows working set of every
child process, summed, sampled every 5 s (`Get-Process`); "mean" and "peak" use only samples with every process
alive. Runner: scratchpad `cmp.ts` / `series.sh` (not committed). Launches waited for `.practice/monitor.json`
practiceBots + 4 <= 6 and freeGB >= 5.

Memory (MB, 4 bots):

| Run | Host mean | Host peak | Separate mean | Separate peak (per process) |
|---|---|---|---|---|
| 1 | 560 | 676 | 2,263 | 2,347 (575, 595, 576, 600) |
| 2 | 582 | 826 | 2,136 | 2,241 (578, 595, 527, 559) |
| 3 | 497 | 723 | 2,165 | 2,266 (546, 544, 596, 596) |
| Mean | **546 (137 per bot)** | 742 | **2,188 (547 per bot)** | 2,285 |

The host uses 4.0x less memory for 4 bots. The host's own `HOST done` lines report peak RSS 879, 758, 762 MB
(Bun's RSS, sampled every 1 s, so it sees the login spike the 5 s working-set sample misses).

Behaviour (each bot's `RESULT` and `LEDGER` line; coins/tick and ledger idle %):

| Run | Host bots: coins/tick | Host idle % | Separate: coins/tick | Separate idle % |
|---|---|---|---|---|
| 1 | 14.67, 14.25, 14.31, 15.14 | 8.4, 5.6, 8.9, 4.1 | 15.17, 14.39, 13.56, 16.00 | 3.5, 8.9, 6.6, 3.6 |
| 2 | 10.42, 14.31, 12.73, 12.91 | 10.1, 5.3, 4.3, 7.1 | 14.75, 12.92, 13.56, 13.73 | 6.3, 7.4, 3.3, 5.1 |
| 3 | 17.17, 17.67, 17.67, 19.55 | 3.3, 3.3, 3.0, 2.5 | 15.06, 13.37, 15.22, 15.06 | 5.6, 5.8, 5.6, 3.5 |
| Mean | 15.07 | 5.5 | 14.40 | 5.4 |

All 24 bot runs printed `RESULT ok`, ran 600-612 ticks, and logged out (`LOGOUT logged-out`); every host run
printed `HOST done ok=4/4`; every process exited 0. No `WARN`, no `[host] unhandled` line. Example host line
(run 1): `[h1x6n223] RESULT ok ticks=600 picks=180 ... coinsPerTick=14.67 ...` and
`[h1x6n223] LEDGER ticks=605 xp=177 move=159 anim=142 dialog=0 stun=76 idle=51 idlePct=8.4 ...`.

Reading: per-tick behaviour is the same within run-to-run spread (4 bots share the same knights, so the spread is
large: host run 2 had one bot at 10.42). The host does not slow ticks: every bot saw 600 ticks in 96-102 s in both
modes. 4 bots at 600 ticks is a short proof; longer runs, banking trips and more bots per host are not measured.

## 4. What (b), a slimmer client, would take

The lite client is already browserless. Upstream measured 13.8 MB marginal per bot with 8 bots in one process
(`vendor/rs-sdk/server/webclient/src/lite/README.md`, CODE-READ of their note, not our measurement). Our per-bot
cost is the SDK's pathfinding data, not the client. rs-sdk-fleet's 0.73 MB per bot (WEB, rev 274, no license, so
ideas only) is the same idea taken further: no SDK state per bot.

Steps, cheapest first, for a single-bot process (the host already pays these once):

1. Drop the collision JSON after a snapshot restore (about 100-200 MB per process). The snapshot holds every tile
   flag; save the door list and the zone list in it too, and import the JSON only on a cold build. Needs a change
   in `vendor/rs-sdk/sdk/pathfinding.ts` (static import at line 4), so it is an upstream patch or a fork.
2. Bots that do not walk (banker, trader) skip pathfinding: needs `sdk/index.ts:37` to import pathfinding lazily.
   Same vendor change.
3. Pathfinding as one shared service (one process answers path queries for all bots over a local socket). Only
   worth it if bots must stay in separate processes; the host makes this unnecessary.

Recommendation: use the host. 4 bots in one host cost about one bot process plus the sessions.

## Open

- More than 4 bots per host not measured. CPU per host not measured.
- The supervisor and swarm launchers still start one process per bot; moving them to the host is a separate task.
- Live runs not done (practice only).
