# Community and upstream repos: what to reuse

Survey date: 2026-10-22. All paths are relative to `F:\dev-on-f\osrs-rs-research\rs-sdk-bot\vendor\` unless stated. Every clone except `rsmod-pathfinder` is shallow, so `git log` history is truncated.

## 0. Repo facts

Size is `du -sh` of the clone (includes `.git` and, for rs-sdk / lumbridge-ai, the vendored server content). Last commit is `git log -1 --format=%ci`.

| Repo | Origin | License | Size | Tracked files | Branch | Last commit |
|---|---|---|---|---|---|---|
| rs-sdk | MaxBittker/rs-sdk | MIT (`LICENSE`, "Copyright (c) 2025 Lost City") | 241M | 13,897 | main | 2026-10-19 "Raise world feed capacity and expire idle clients" |
| jevscape | Skyvern-AI/jevscape | **none** (no LICENSE file, no `license` in package.json) | 119M | 463 | main | 2026-09-18 "Cover: JevScape image ..." |
| lumbridge-ai | samheutmaker/lumbridge-ai | MIT (`LICENSE`, inherited from rs-sdk) | 227M | 13,179 | main | 2026-08-17 "bot changes + website" |
| rs-world | MaxBittker/rs-world | BSD-2-Clause (dennisdev) | 17M | 333 | main | 2026-10-19 "Add world feed heartbeat and reconnect control" |
| rs-map-viewer | dennisdev/rs-map-viewer | BSD-2-Clause | 11M | 316 | master | 2026-08-02 "Updated undescriptive locations and added some new" |
| rsmod-pathfinder | MaxBittker/rsmod-pathfinder (npm `@2004scape/rsmod-pathfinder` 5.0.4) | ISC (`LICENSE.md`, "Copyright (c) 2020 RS Mod"; package.json says ISC) | 1.8M | 57 | main | 2026-02-11 "2048 grid, generation counter, u16 maxWaypoints" |
| lostcity-engine | LostCityRS/Engine-TS | MIT | 12M | 574 | **274** | 2026-08-20 "Updated client bundle with socket fix" |
| lostcity-content | LostCityRS/Content | MIT for code; assets are Jagex IP (README) | 111M | 9,393 | **274** | 2026-09-24 "fix: only one player occasionally getting sent to arena when full (#764)" |
| lostcity-client | LostCityRS/Client-TS | MIT | 2.1M | 110 | **274** | 2026-08-20 "fix: Better ClientStream logic" |
| lostcity-server | LostCityRS/Server | MIT | 173K | 13 | main | 2026-07-08 "Updated revision list" |
| lostcity-runescript | LostCityRS/RuneScriptTS | MIT + `LICENSE.neptune` (MIT, Joshua Filby) | 1.2M | 143 | main | 2026-07-29 "infer constant type from concrete sibling ..." |
| lostcity-markets | LostCityRS/Markets | MIT per `composer.json` only; no LICENSE file | 41M | 4,375 | main | 2026-06-18 "remove stats tab and related code" |

**Revision trap.** The LostCity clones are on branch `274`. rs-sdk vendors rev **289** (`rs-sdk/server/PATCHES.md`: "upgraded from 274 on 2026-10-09"; `rs-sdk/server/content/.github/workflows/content.yml` pins `ref: '289'`). For data mining, read `rs-sdk/server/content/`, not `lostcity-content/`. rs-sdk content has quests, areas and drop tables that the 274 clone lacks (for example `quest_hauntedmine`, `quest_troll_love`, `area_miscellania`, `drop tables/scripts/iron_dragon.rs2`).

**jevscape license.** No license means all rights reserved. Read it for ideas. Do not copy code.

---

## 1. jevscape (Skyvern-AI)

### What it is

A fork of RuneBench (`runebench/`, MaxBittker's benchmark) plus a harness at `jevscape/agents/jev/` that lets TypeSafe's "Jev" play. Jev is a non-generative "System One" model. It answers typed questions only: `choice` (one option plus a probability per option), `noul` (P(true)), and `score` (rubric level). It cannot write code or call tools. So the harness inverts the usual rs-sdk setup: "code owns the actuators, Jev owns the judgment" (`agents/jev/README.md`).

Files (line counts): `catalog.ts` 1,736, `controller.ts` 1,023, `live.html` 526, `jev-client.ts` 146, `live.ts` 89, `local-bench.sh` 241, `live-stack.sh` 98, `patches/rs-sdk-walkto-cancel.patch`, `patches/rs-sdk-real-level-curve.patch`.

### Bounded action catalog (`agents/jev/catalog.ts`)

- `HUBS` (lines 21-52): 31 named coordinates checked on the live map, for example `draynor_fishing {x:3087, z:3230}` and `al_kharid_gate {x:3267, z:3228, '10 coins'}`. The README notes that the first Varrock oak hub walked the bot past the dark wizards and killed it. Hand-verified places beat wiki coordinates.
- `ActionSpec` (line 89):
  ```ts
  interface ActionSpec {
    key: string; skills: readonly string[];          // '*' = every task
    available: (s, ctx) => boolean;                   // hard preconditions in code
    describe: (s, ctx) => { what; where; requires; gives; notes };  // same 5 fields on every option
    run: (ctx, budgetMs) => Promise<Outcome>;         // Outcome {ok, message, reps, xpGained, seconds, stop}
  }
  ```
- `CATALOG` (line 529) has 43 literal keys plus 9 generated ones (`set_combat_style_{attack,strength,defence}`, `fight_{chickens,cows,goblins,giant_rats}_lumbridge`, `shoot_{chickens,cows}_lumbridge`), so 52 in total. The READMEs say 49 and "about 50". Examples: `net_fish_draynor`, `buy_fly_fishing_rod_and_feathers_port_sarim`, `tan_cowhides_al_kharid`, `smelt_bronze_bars_lumbridge_furnace`, `pickpocket_guards_falador`, `sell_unneeded_gear_lumbridge`, `close_dialog`, `eat_food`.
- Each routine walks to its hub (`goTo`, walks capped at 25 s by `walkCapped`), handles its mechanical preconditions (toll gate, equip by combat style, tanner pages), then repeats a unit step inside `burst()` until the budget runs out, an exhaustion condition fires (inventory full, no materials), or three consecutive failures occur. `StopReason = 'budget'|'exhausted'|'failed'|'blocked'|'done'|'deadline'|'switched'`.
- `candidates()` (line 1726) filters the catalog by task skill, suppression, and `available()`.
- Descriptions state facts only (level, XP per unit, distance, what is consumed). Nothing ranks the options.
- Code-owned rules: suppress an action for 90 s after two consecutive dead ends, or after three picks with no task XP; eat at 3 HP; wait out death; compose `eat_first` noul at a 0.6 threshold.
- `REFERENCE` (line 1626) is a small per-skill table lifted from `rs-sdk/wiki/skills/*.md`.

### Tick-mode controller (`agents/jev/controller.ts`)

- **Burst mode** (benchmark): one decision, then the action runs for about 20 s (8x speed) or 60 s (1x).
- **Tick mode** (live): Jev is polled every N game ticks (`--poll-every N`). One poll asks three questions (`buildQuestions`, line 955):
  - `next_action`: the goal. The running action appears as `CURRENT`, with runtime, XP drops and status. The same answer keeps it running. A different answer aborts it through an `AbortSignal` (`ctx.signal`).
  - `this_tick`: `do_nothing | close_dialog | eat_food | restart_current`. These act beside the goal and do not change it. The split exists because Jev once picked `close_dialog` as a *goal* after a level-up. That aborted fishing and the bot stood idle for 25 s.
  - `poll_again_in_ticks`: N, 2N, 5 or 10. The model sets its own polling cadence.
- The answer timeout equals the poll interval. A late answer keeps the current action. Tick mode never blocks on the model.
- Player status is sampled every tick (lines 327-334): `dead | under_attack (HP fell in last 6 s) | skilling (target matches fishing spot/tree/rock) | in_combat | in_dialog | animating | moving | idle`. It comes with `idle_for_seconds`, `seconds_since_last_xp`, the last server message and its age, and `recent_events` (the last 8 events). `under_attack` was added after a dark wizard killed the bot while the state still looked like "fishing".
- In tick mode, fishing scripts click once and hold (`ctx.hold`). Every re-click is a model `restart_current`.
- rs-sdk patches: `walkTo(x, z, tol, signal?)` cancellation (adds two `signal?.aborted` checks in `sdk/actions.ts`), and the real level curve 2^(level/7) in place of rs-sdk's 2^(level/10). `--xprate 1` restores real XP; rs-sdk's default multiplier is 25.

### Dashboard (`live.ts` + `live.html`, port 7790)

The controller appends `events.jsonl` (`start`, `deciding` with the full snapshot and candidates, `decision` with the probability map, `outcome`, `log`, `summary`). `live.ts` streams the file over Server-Sent Events. The page embeds the bot's own browser game client beside a sidebar. Simple view: task, level, XP to next level, ranked choices with percentages. Developer view: snapshot, probability bars, latency, tokens, controller log. Only one tab may load the game client, and Chrome must keep it visible during login. `?nogame=1` shows the panel only.

### Claimed results (README, 2026-09-18, 15-min tasks, 16 skills, local runner, 20 ticks/s, one run per skill)

| Policy | Mean peak XP/min | Mean total XP |
|---|---:|---:|
| random over same catalog | 235 | 110,919 |
| Jev (`jev-1.13.0`) | 197 | 230,242 |
| best complete leaderboard model (Claude Opus via OpenCode) | 118 | n/a |

Cost for the sweep: 1,307 decisions, 4.14M input tokens, $0.17. Jev beat random on Fishing (920 vs 725), Fletching (213 vs 0) and Crafting (48 vs 0). These tasks need chains such as "sell gear, then thieve coins, then buy a fly rod and feathers". Jev lost peak score elsewhere because it kept repeating whatever had just worked. The authors say it plainly: "The catalog carries the game knowledge. This comparison mostly measures the action space, not the model." Tick mode at 1x is about $1/hour. Evidence level: one run per cell, self-reported, no confidence intervals.

### How it differs from plain rs-sdk usage

Plain rs-sdk (and RuneBench's OpenCode adapter) has the LLM write TypeScript against `bot.*`/`sdk.*` through the `execute_code` MCP tool, then read results and iterate. jevscape removes program synthesis entirely. The model picks from a pre-filtered menu of tested macros, at a fixed cadence, with structured state.

### Ideas worth stealing

1. **A random-policy baseline over our own action set.** It is the only honest way to separate catalog quality from model quality.
2. **Goal / reflex / cadence split** (`next_action` / `this_tick` / `poll_again_in_ticks`). Interrupts stay cheap and never discard set-up work.
3. **Abortable actions.** `AbortSignal` goes through every long wait, plus the `walkTo` cancel patch.
4. **A derived status enum** (`under_attack`, `skilling`, `idle_for_seconds`, `seconds_since_last_xp`). Raw state does not tell "silently skilling" from "stuck".
5. **A uniform 5-field option description** (`what/where/requires/gives/notes`), facts only.
6. **Suppression rules** for actions that dead-end, so the model cannot loop.
7. **Hand-verified hubs** with safety notes.
8. **Per-world TPS check** (`tickrate.ts`, abort below `MIN_TPS` 15). An isolated `GE_DATABASE` per world, because the engine prefers `data/market.sqlite` over `.sav`.
9. **A timeout equal to the poll interval** that keeps the current action, so the agent never stalls on latency.

---

## 2. lumbridge-ai vs rs-sdk

The clone holds 20 commits (2026-08-16 to 2026-08-17), 19 by Sam Heutmaker and 1 by Sam Hogan. The fork point is older than current rs-sdk. Most of the 3,896 differing paths (`diff -rq --strip-trailing-cr`) are rs-sdk's later work: content rev 274 vs 289, the world feed, the GE/market. Those are not lumbridge additions.

**Present in rs-sdk, absent in lumbridge-ai (newer upstream):** `sdk/ge-actions.ts`, `sdk/market.ts`, `sdk/MARKET.md`, `mcp/market-tools.ts`, `mcp/execute-code.ts`, `server/engine/src/web/worldfeed.ts`, `server/engine/src/engine/market/`, the hiscores pages, `learnings/`, and the 289 content.

**Added by lumbridge-ai (only in lumbridge-ai):**

| Area | Paths | What it is |
|---|---|---|
| Swarm runtime (LLM agents) | `bots/agents/` (≈249K): `supervisor.ts`, `orchestrator.ts`, `bot-agent.ts`, `tools.ts`, `jobs.ts`, `blackboard.ts`, `tripwires.ts`, `watchdog.ts`, `provider.ts`, `prompts/{bot-system,orchestrator-system}.ts` | One "Pi" agent per bot plus a fleet orchestrator that reads `learnings/swarm/PLAN.md` and nudges agents. The model provider is inference.net (`BASE_URL https://api.inference.net/v1`, needs `INFERENCE_API_KEY`). |
| Blackboard | `bots/agents/blackboard.ts` | One SQLite file (`runtime/agents/swarm.sqlite`) is the source of truth for agents (role, status, pid, cycle, spend_usd, heartbeat, password) and holds a mailbox: instructions go down, reports (`progress/milestone/blocked/idle/error`) go up. |
| Tripwires | `bots/agents/tripwires.ts` | Agent-configured deterministic interrupts, polled every 2 s, at most 10: `hp_below, player_near, xp_stall, dialog_stuck, inventory_full, outside_area, in_combat, expr(js)`. The action is `wake` or `wake_and_kill_job`, with an optional `flee:{x,z}`. The reflex walks away at once, because "an LLM turn takes 20-60s; a PKer hits every ~2s". Commits `c85040a`, `ea7e7d5` came from a "CowboyPure ambush". |
| Intent executor | `bots/swarm-agent/` (≈655K): `planner.ts`, `executor.ts`, `coordinator.ts`, `scheduler.ts`, `policy.ts`, `trades.ts`, `quartermaster.ts`, `store.ts`, `intents/{bank,combat,gather,move,observe,passive,pk-drill}.ts` | A typed `ControllerCommand` union (`move_to_area, interact_npc, interact_loc, wait_ticks, train_combat, open_bank, deposit_item, ...`). Handlers return `{completed, evidence[], actions, error{code: action_failed|action_rejected|target_disappeared|evidence_missing, retryable}}`. Evidence types: `observation, position, inventory_delta, skill_delta, waited, yielded`. |
| Evaluation gate | `bots/swarm-agent/EVALUATION.md`, `evaluation.ts`, `evaluation.config.json` | Pre-registered paired trials of the LLM planner against the deterministic baseline, with shadow mode (any mutation is a hard fail) and halt/hold/promote/remove decisions on a confidence bound of "readiness per fleet-hour after inference cost". |
| Watchtower UI | `dashboard/` (Vite), `bots/swarm-dashboard.ts`, port 4174 | Live browser sessions per bot, fleet monitor (cycle, heartbeat, spend), orchestrator thread, optional OpenCode pane. |
| Ops / hosting | `server/supervisor.ts`, `server/engine/src/web/{management-web,runtime-state,security-limits,cloudflare-ranges}.ts`, `server/engine/src/server/login/{AuthLimiter,PlayerSaveStore,PlayerSaveVerify}.ts`, `server/engine/src/engine/{Koth,entity/AllowRepath}.ts`, `docs/runbooks/`, `website/`, `fly.toml` | A public persistent world at `rs.lumbridge.ai`: 250 ms ticks (commit `58024a1`), Prometheus metrics, Cloudflare real-IP handling, login rate limits, save verification, a KOTH mode. |
| SDK | `sdk/control-ownership.ts`, tests `tutorial-skip-*`, `gateway-url.test.ts` | Newest control connection replaces the previous controller. Observe mode for read-only tools. |

**Worth stealing:** tripwires with a deterministic flee reflex; evidence-typed intent results; the blackboard schema for multi-bot coordination; the shadow-mode evaluation protocol for the question "is the LLM layer worth its cost?".

---

## 3. rs-world and rs-map-viewer

### rs-world (live 3D viewer, fork of rs-map-viewer)

The useful part for an agent is the **engine-side feed**, which already ships in rs-sdk: `rs-sdk/server/engine/src/web/worldfeed.ts` (627 lines). It is off unless `WORLD_FEED=true`, and is served at `ws(s)://<host>/worldfeed`. The viewer side is `rs-world/src/live/` (`WorldFeedClient.ts`, `protocol.ts`, `LiveWorld.ts`). Design notes are in `rs-world/DESIGN.md`.

Protocol v1 (JSON text frames):
```
client -> {t:'sub', x, z, w, h}          tiles [x,x+w) x [z,z+h), all levels, max 384x384
client -> {t:'roster', on}
server -> {t:'hello', v, rev, tick, tickMs, players}
server -> {t:'tick', k, ms, p?, n?, rp?, rn?, reset?}     every tick while subscribed
server -> {t:'roster', k, p:[[slot,name,x,z,level,combat],...], npcs}
```
Entity record keys: `i` slot/nid, `f:1` first sight (full record), `t` npc type, `x z l` tile, `m` [walkDir, runDir], `tp` teleport/jump, `ap` appearance (base64), `an` [seq,delay], `sp` spotanim, `fe`/`fs` facing, `hm` hitmarks + `hp` [cur,max], `sy` forced text, `ch` public chat, `em` exact move.
Env: `WORLD_FEED_TOKEN`, `WORLD_FEED_MAX_CLIENTS` (128), `WORLD_FEED_IDLE_TIMEOUT_MS` (120000). The roster interval is `ROSTER_INTERVAL_TICKS = 10` in code; DESIGN.md says "every 5 ticks". Measured cost: +4.0 ms average cycle time with 20 viewers. Separately, `/playerpositions` (`rs-sdk/server/engine/src/web/index.ts:133`) publishes every player's position.

**Agent value: high, as a second sensor.** The bot SDK's `BotWorldState` shows what the client sees. The feed gives per-tick server truth over a 384x384 area: npc HP bars, who is attacking whom (`fe`), hitsplats on other entities, npc type changes, and other players' chat. Uses:
- threat detection beyond client view (PKers approaching, aggressive npcs targeting us);
- respawn timing and occupancy of resource spots (count players at a rock or tree before walking there);
- a server-side event log for post-hoc trajectory analysis.

It is read-only and needs no login. It runs on our own engine, or on a server started with `WORLD_FEED=true`.

### rs-map-viewer (dennisdev, osrs.world)

A WebGL2 cache renderer. Static data files an agent can use directly:
- `src/mapviewer/data/npc/npc-spawns-2004.json` holds 5,731 entries `{id, name, x, y, level}` ("y" is the z coordinate). The source is the 2004scape server, under its MIT license (`npc-spawns-2004.json.LICENSE.txt`). It is a weaker duplicate of the `.jm2` NPC sections described in section 5, and it may predate rev 289.
- `src/mapviewer/data/obj/obj-spawns.json` holds `{id, count, x, y, plane}` from the **OSRS** wiki (includes x=1512, which is OSRS-only). It is not reliable for 2004.
- `src/components/rs/worldmap/locations.json` holds map label names. The equivalent for our revision is `maps/labels.txt` in content.
- `src/rs/pathfinder/` contains a TS pathfinder (credits Blurite).

**Agent value: low.** The rendering is for humans. Everything structured is better sourced from LostCity content.

---

## 4. rsmod-pathfinder

Rust, compiled to WASM (`dist/rsmod-pathfinder_bg.wasm`) and ported from rsmod's Kotlin. rs-sdk vendors it at `rs-sdk/server/vendor/rsmod-pathfinder` and wraps it in `rs-sdk/sdk/pathfinding.ts`. The SDK loads collision from `rs-sdk/sdk/collision-data.json` (27.5 MB) into the global flag map through `allocateIfAbsent` + `__set`, and applies doors per session through `changeWall`.

**Algorithm** (`src/rsmod/pathfinder.rs`): a BFS flood over a square local grid centred on the source. A ring-buffer queue (`ring_buffer_size` must be a power of 2) stores the direction and distance per cell. There are separate specialised loops for entity size 1, size 2 and size N (`find_path_1/2/n`). Each step checks the 8 neighbour directions against collision flags, with diagonals requiring both cardinals clear. The search ends when a `reach` strategy (`src/rsmod/reach/`) reports the destination reachable. Reach is shape-aware: walls, wall decorations, rectangles, and `blockAccessFlags` for loc approach sides. If the destination is unreachable and `moveNear` is set, the search picks the closest visited tile (within 10 tiles of the destination, lowest cost up to 1000, scanning all visited tiles since commit `df7ec08`). The path is then traced backwards through direction changes, so only turning points become waypoints.
- `findPath`: 128x128 grid (`DEFAULT_SEARCH_MAP_SIZE`), ring buffer 4096, reach ±64.
- `findLongPath`: `PathFinder::with_size(2048, 524288)` in `src/lib.rs`, reach ±1024 tiles. The README is stale and still says 512x512 / ±256. A generation counter avoids clearing the 4M-cell grid on every call.
- `findNaivePath`: the npc-style dumb step toward a target.

**API** (`dist/rsmod-pathfinder.d.ts`):
```ts
findPath(y, srcX, srcZ, destX, destZ, srcSize, destWidth, destHeight, angle, shape,
         moveNear, blockAccessFlags, maxWaypoints, collision: CollisionType): Uint32Array
findLongPath(...same...)            // maxWaypoints is u16 here
findNaivePath(y, srcX, srcZ, destX, destZ, srcW, srcH, destW, destH, extraFlag, collision)
reached(y, srcX, srcZ, destX, destZ, destW, destH, srcSize, angle, shape, blockAccessFlags): boolean
canTravel(y, x, z, offX, offZ, size, extraFlag, collision): boolean
hasLineOfSight / hasLineOfWalk / lineOfSight / lineOfWalk(...)
allocateIfAbsent / deallocateIfPresent / isZoneAllocated(x, z, y)
changeWall / changeLoc / changeFloor / changeRoof / changeNpc / changePlayer(..., add)
isFlagged(x, z, y, masks); __set(x, z, y, mask)
enum CollisionType { NORMAL=0, BLOCKED=1, INDOORS=2, OUTDOORS=3, LINE_OF_SIGHT=4 }
```
Waypoints are packed as `z & 0x3fff | (x & 0x3fff) << 14 | (level & 3) << 28` (`src/rsmod/coord_grid.rs`; unpacked in `rs-sdk/sdk/pathfinding.ts:274`). Benchmark (README): 2.8 µs/path native, 7.0 µs in WASM, on a 10-tile path in a full Lumbridge mapsquare.

**Agent implications:** path queries are cheap enough to cost every candidate target. Rank resources by *path length*, not Euclidean distance. The pathfinder knows only static collision plus the doors the SDK applies. Multi-level transitions (stairs, ladders) are not edges, so a world-model planner needs its own transition graph (see `ladders+stairs/` in section 5).

---

## 5. LostCity content: where data lives and how to mine it

Mine `rs-sdk/server/content/` (rev 289). The structure matches `lostcity-content/` (rev 274), and the paths below exist in both unless noted. The examples come from `lostcity-content/`.

### Layout

| Path | Contents |
|---|---|
| `pack/{obj,npc,loc,inv,seq,varp,...}.pack` | Stable numeric id to config name, one `id=name` per line. Counts: `obj.pack` 3,894, `npc.pack` 1,359, `loc.pack` 4,671. |
| `scripts/_unpack/<rev>/all.{obj,npc,loc,inv,seq,varp,...}` | Base configs unpacked from the original cache, one dir per revision (225, 244, 245, 254, 274; 289 in rs-sdk). Each config is defined once across all files (0 duplicate `[name]` headers among npc/obj/loc/inv). |
| `scripts/<area or skill>/configs/*.{obj,npc,loc,inv,param,dbtable,dbrow,enum,constant,varp}` | Hand-written or overriding configs, grouped by feature. |
| `scripts/<feature>/scripts/*.rs2` | RuneScript server logic: triggers such as `[opnpc1,x]`, `[ai_queue3,npc]`, `[label,x]`, `[proc,x]`, `[queue,x]`. 1,416 `.rs2` files. |
| `scripts/drop tables/scripts/*.rs2` | One drop script per npc family (`chaos_druid.rs2`, `black_dragon.rs2`, ...). `configs/lootdrop.constant` sets `^lootdrop_duration = 200`. |
| `scripts/shop/scripts/{shop,generalshop}.rs2` | Shop logic. Stock lives in area `.inv` files. |
| `scripts/quests/quest_<name>/{configs,scripts}/` | Per-quest varp, locs, dialogue and logic. `scripts/general/configs/quest.constant` holds completion values. `scripts/general/scripts/quests.rs2` holds the quest list and points. |
| `scripts/skill_<name>/configs/*.dbtable|*.dbrow` | Skill data tables (levels, XP, products, tool success rates). |
| `scripts/ladders+stairs/`, `scripts/doors/` | Level transitions and door locs. These are the missing edges for a multi-level navigation graph. |
| `maps/m<X>_<Z>.jm2` | 483 text map squares (64x64 tiles). Each has sections `==== MAP ====`, `==== LOC ====`, `==== NPC ====`, `==== OBJ ====`. |
| `maps/labels.txt` | 136 world-map labels: `=Lumbridge,3239,3233,1`. |
| `maps/free2play.csv` | F2P zone list (`0_47_47_32_32` = level_mapX_mapZ_localX_localZ). |

Config syntax is INI-like: `[name]` headers, then `key=value` lines. `//` comments often cite the classic wiki source, which is useful for provenance.

### Item ids and stats

`pack/obj.pack` gives `0=mcannonremains`. Config, from `scripts/skill_woodcutting/configs/axes/axes.obj`:
```
[bronze_axe]
name=Bronze axe
cost=16
iop2=Wield
wearpos=righthand
category=weapon_axe
```
Merge `_unpack/*/all.obj` with every other `*.obj` under `scripts/`. `cert_*` noted variants appear in `obj.pack` (3,894 ids) but have no config of their own (2,629 configs). `cost` drives shop and alch prices.

### NPC stats and spawn locations

Config (`scripts/_unpack/225/all.npc`):
```
[chaos_druid]
name=Chaos druid
op2=Attack
vislevel=13
respawnrate=50
hitpoints=20
attack=8
strength=8
defence=12
magic=10
huntmode=ranged
huntrange=3
param=damagetype,^crush_style
```
Spawns are in the `.jm2` NPC section, format `level localX localZ: npcId` (written by `lostcity-engine/tools/map/ImportNpcCsv.ts:92`):
```
==== NPC ====          (maps/m50_50.jm2)
0 0 38: 59
```
World coordinates: `x = mapX*64 + localX`, `z = mapZ*64 + localZ`, so `m50_50` covers x 3200-3263, z 3200-3263 (Lumbridge). Resolve `59` through `pack/npc.pack`. OBJ section: `level x z: objId count` (ground spawns). LOC section: `level x z: locId shape angle` (shape defaults to 10, angle to 0; `lostcity-engine/tools/pack/map/Pack.js:101-105`). LOC entries give every tree, rock, bank booth, range, furnace and anvil with exact tiles. Join them with the skill dbrows to get "all willow trees" or "all iron rocks".

### Drop tables

These are imperative RuneScript, not data (`scripts/drop tables/scripts/chaos_druid.rs2`):
```
[ai_queue3,chaos_druid]
obj_add(npc_coord, npc_param(death_drop), 1, ^lootdrop_duration);   // always drop (param on npc)
def_int $random = random(128);
if ($random < 7)  { obj_add(npc_coord, lawrune, 2, ^lootdrop_duration); }
else if ($random < 10) { obj_add(npc_coord, airrune, 36, ^lootdrop_duration); }
...
else if ($random < 52) { obj_add(npc_coord, ~randomherb, ^lootdrop_duration); }      // sub-table proc
else if ($random < 90 & %itgronigen >= ^itgronigen_complete) { ... unholy_symbol_mould ... }  // quest-gated
```
Extraction: for each `if/else if ($random < N)` chain, P = (N − previous N)/denominator, item and count from `obj_add`. Keep `~proc` calls as sub-table references (`~randomherb`, `~randomjewel`, in `shared_droptables.rs2`), and keep `& %varp` guards as conditions. `death_drop` comes from `param=death_drop,<obj>` on the npc config. There is also a `drop_table.dbtable` (`column=drop,namedobj,int,int,LIST`) for table-driven drops.

### Shop stock

Area `.inv` files, for example `scripts/areas/area_alkharid/configs/alkharid.inv`:
```
[scimitarshop]
scope=shared
size=40
restock=yes
stock1=bronze_scimitar,5,100      # obj, initial count, restock rate (InvConfig.ts:67-88)
stock2=iron_scimitar,3,200
```
Shop to owner link: npc config `param=owned_shop,generalshop3` (`area_alkharid/configs/alkharid.npc:186`). The owner's `.jm2` NPC entry gives the shop location. Buy and sell prices derive from obj `cost` plus the logic in `shop/scripts/shop.rs2`.

### XP rates and skill data

Skill dbtables, for example `scripts/skill_woodcutting/configs/trees.dbtable`:
```
[woodcutting_trees]
column=levelrequired,int
column=tree,loc,LIST,INDEXED,REQUIRED
column=productexp,int
column=product,namedobj
column=respawnrate,int
column=successchance,namedobj,int,int,LIST
```
with rows in `trees.dbrow` (`data=productexp,250`, `data=successchance,bronze_axe,64,200`). XP is stored in **tenths**: `stat_advance(woodcutting, db_getfield($data, woodcutting_trees:productexp, 0))` gives 25.0 XP for a normal tree, and Cook's Assistant `stat_advance(cooking, 3000)` gives 300 XP. `successchance obj,low,high` are the low/high success numerators for the tool, interpolated by level. Together with tree `respawnrate` this lets us compute expected XP/hour per (level, tool, tree). Analogous tables: `skill_smithing/configs/smithing/smithing.dbrow` (`bar`, `bar_amount`, `levelrequired`), and `skill_fishing/configs/fishing.{npc,struct,param,enum}` with `fishing_movement.enum` (spot movement).

### Quest scripts

`scripts/quests/quest_cook/`:
- `configs/quest_cook.varp`: `[cookquest] scope=perm`, the progress variable.
- `scripts/general/configs/quest.constant`: `^cook_complete = 2`.
- `scripts/quest_cook.rs2`: labels per stage (`[label,cooks_assistant_start]`, `..._inprogress`), item checks `inv_total(inv, pot_flour) > 0 & inv_total(inv, egg) > 0 & inv_total(inv, bucket_milk) > 0`, stage writes `%cookquest = 1`, and the reward `[queue,cooks_quest_complete] %cookquest = ^cook_complete; stat_advance(cooking, 3000);`.

Extraction: per quest, collect the varp name, the values written (`%varp = N` sites, with the enclosing trigger and npc), the items checked by `inv_total`, `stat_advance` rewards, and level checks (`stat(...)`). The result is a stage machine `varp value → (npc to talk to, items required, next value)`. Reading the player's varp then tells the agent the exact next step. The SDK does not currently expose varps; that would need verification or a small gateway addition.

### What rs-sdk already mines

`rs-sdk/wiki/generate-{items,npcs,shops}.ts` already parse `server/content` (`.obj` from `_unpack/225/all.obj` plus overrides, `.npc`, `.inv`, `.jm2`, drop `.rs2`). They emit Markdown: 1,582 `wiki/items/*.md`, 807 `wiki/npcs/*.md`, 119 `wiki/shops/*.md`. `wiki/quests/*.md` and `wiki/skills/*.md` look hand-written; no generator exists for them. Example output, `wiki/npcs/chaos-druid.md`: stats, "Coordinate samples" by map square, and a drops table in /128. Gaps for an agent:
- The output is Markdown for reading, not a queryable JSON store.
- It gives coordinate *samples*, not every spawn.
- Quest gates on drops are lost (`unholy_symbol_mould` gate), and sub-tables are flattened to "Herbs (varies)", listed three times.
- There are no loc indexes (trees, rocks, ranges, banks), no XP/success tables, and no quest stage machines.
- `generate-items.ts:556` reads base configs only from `_unpack/225`, so items first added in later revisions come only from area files.

### Proposed extraction (deterministic, no LLM)

Write one Bun script, `tools/mine-content.ts`, that reads `rs-sdk/server/content` and writes `knowledge/*.json`:
1. `ids.json`: every `pack/*.pack` as `{type: {id: name}}`.
2. `objs.json`, `npcs.json`, `locs.json`, `invs.json`: merge `_unpack/*/all.*` with all `scripts/**/*.<ext>`, parsing `key=value` (repeated keys become arrays; `param=k,v` becomes a map).
3. `spawns.json`: from every `.jm2`, emit `{npc|obj|loc, id, name, level, x, z, shape?, angle?, count?}` in world coordinates.
4. `drops.json`: a regex or AST pass over `drop tables/scripts/*.rs2`. `lostcity-runescript/src/antlr/RuneScriptParser.g4` and `src/parser/ast/` provide a real parser if regex proves brittle.
5. `shops.json`: `.inv` stock joined to the `owned_shop` npc and its spawn.
6. `skills.json`: every `*.dbtable` schema plus its `*.dbrow` rows, with XP/10.
7. `quests.json`: varp, completion constant, `%varp = N` transitions, `inv_total` checks, `stat_advance` rewards.
8. `nav-transitions.json`: locs from `ladders+stairs/` and `doors/` scripts, mapped to the destination coordinates in their `.rs2` (`p_telejump` / `coord` literals). This adds cross-level edges to rsmod's single-level BFS.

The whole pipeline is code, re-runnable on each revision bump. Validate it against the live game: a spawn should appear in `sdk.findNearbyNpc`, a stock item in `bot.openShop`.

---

## 6. Recommendations for our harness

1. Adopt jevscape's **catalog plus a random baseline**, its **abortable actions**, and its **goal / this_tick / poll cadence** split. Reimplement them, because jevscape has no license.
2. Adopt lumbridge-ai's **tripwires with a deterministic flee reflex** and its **evidence-typed action results** (MIT).
3. Use rs-sdk's **world feed** as a second, server-truth sensor for threats and spot occupancy (`WORLD_FEED=true` on our engine).
4. Use `findLongPath` path length as the distance metric. Add a stairs and ladders transition graph mined from content.
5. Build `knowledge/*.json` from `rs-sdk/server/content` (rev 289), not from the 274 `lostcity-content` clone. Extend rather than replace `rs-sdk/wiki/generate-*.ts`.
