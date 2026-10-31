# Community and upstream repos: what to reuse

All paths are relative to `F:\dev-on-f\osrs-rs-research\rs-sdk-bot\vendor\` unless stated. Every clone except `rsmod-pathfinder` is shallow, so `git log` history is truncated.

## 0. Repo facts

Size is `du -sh` of the clone (includes `.git` and, for rs-sdk / lumbridge-ai, the vendored server content). Last commit message is `git log -1 --format=%s`.

| Repo | Origin | License | Size | Tracked files | Branch | Last commit message |
|---|---|---|---|---|---|---|
| rs-sdk | MaxBittker/rs-sdk | MIT (`LICENSE`, "Copyright (c) 2025 Lost City") | 241M | 13,897 | main | "Raise world feed capacity and expire idle clients" |
| jevscape | Skyvern-AI/jevscape | **none** (no LICENSE file, no `license` in package.json) | 119M | 463 | main | "Cover: JevScape image ..." |
| lumbridge-ai | samheutmaker/lumbridge-ai | MIT (`LICENSE`, inherited from rs-sdk) | 227M | 13,179 | main | "bot changes + website" |
| rs-world | MaxBittker/rs-world | BSD-2-Clause (dennisdev) | 17M | 333 | main | "Add world feed heartbeat and reconnect control" |
| rs-map-viewer | dennisdev/rs-map-viewer | BSD-2-Clause | 11M | 316 | master | "Updated undescriptive locations and added some new" |
| rsmod-pathfinder | MaxBittker/rsmod-pathfinder (npm `@2004scape/rsmod-pathfinder` 5.0.4) | ISC (`LICENSE.md`, "Copyright (c) 2020 RS Mod"; package.json says ISC) | 1.8M | 57 | main | "2048 grid, generation counter, u16 maxWaypoints" |
| lostcity-engine | LostCityRS/Engine-TS | MIT | 12M | 574 | **274** | "Updated client bundle with socket fix" |
| lostcity-content | LostCityRS/Content | MIT for code; assets are Jagex IP (README) | 111M | 9,393 | **274** | "fix: only one player occasionally getting sent to arena when full (#764)" |
| lostcity-client | LostCityRS/Client-TS | MIT | 2.1M | 110 | **274** | "fix: Better ClientStream logic" |
| lostcity-server | LostCityRS/Server | MIT | 173K | 13 | main | "Updated revision list" |
| lostcity-runescript | LostCityRS/RuneScriptTS | MIT + `LICENSE.neptune` (MIT, Joshua Filby) | 1.2M | 143 | main | "infer constant type from concrete sibling ..." |
| lostcity-markets | LostCityRS/Markets | MIT per `composer.json` only; no LICENSE file | 41M | 4,375 | main | "remove stats tab and related code" |

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
- Player status is sampled every tick (lines 327-334): `dead | under_attack (HP fell in last 6 s) | skilling (target matches fishing spot/tree/rock) | in_combat | in_dialog | animating | moving | idle`. It comes with `idle_for_seconds`, `seconds_since_last_xp`, the last server message and its age, and `recent_events` (the last 8 events). `under_attack` exists so that a dark wizard attack does not read as "fishing".
- In tick mode, fishing scripts click once and hold (`ctx.hold`). Every re-click is a model `restart_current`.
- rs-sdk patches: `walkTo(x, z, tol, signal?)` cancellation (adds two `signal?.aborted` checks in `sdk/actions.ts`), and the real level curve 2^(level/7) in place of rs-sdk's 2^(level/10). `--xprate 1` restores real XP; rs-sdk's default multiplier is 25.

### Dashboard (`live.ts` + `live.html`, port 7790)

The controller appends `events.jsonl` (`start`, `deciding` with the full snapshot and candidates, `decision` with the probability map, `outcome`, `log`, `summary`). `live.ts` streams the file over Server-Sent Events. The page embeds the bot's own browser game client beside a sidebar. Simple view: task, level, XP to next level, ranked choices with percentages. Developer view: snapshot, probability bars, latency, tokens, controller log. Only one tab may load the game client, and Chrome must keep it visible during login. `?nogame=1` shows the panel only.

### Claimed results (README, 15-min tasks, 16 skills, local runner, 20 ticks/s, one run per skill)

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

The clone holds 20 commits, 19 by Sam Heutmaker and 1 by Sam Hogan. The fork point is older than current rs-sdk. Most of the 3,896 differing paths (`diff -rq --strip-trailing-cr`) are rs-sdk's later work: content rev 274 vs 289, the world feed, the GE/market. Those are not lumbridge additions.

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

## 7. Cairn record run and live network delay

**Claim: the overall record is 35,787 ticks.** `cairnmax20x` (Cairn swarm) beat stunbaron's 35,916 by 129 ticks. Evidence: https://rune.fast/. Gap: compare with the target in `research/hiscores-live.json` before the next plan update.

**Claim: host location was their largest gain.** The write-up says each reaction landed 2-3 ticks late from California, and on the next tick from an AWS us-east-1 VPS. Conditions: their script, their client. Evidence: write-up only, no raw data.

**Claim: from this PC, a request to the game app takes 100-370 ms.** Conditions: this PC, HTTPS `GET /` to `rs-sdk-demo.fly.dev`. The Fly edge is London (`fly-request-id` ends `-lhr`, two `via: fly.io` hops), so the game app is elsewhere. TCP connect to the edge took 25-58 ms (8 runs). On one reused connection, 11 requests took 100-301 ms to first byte (median 175 ms). Gap: the game socket can differ from `GET /`. Reaction delay in ticks is not measured live. `research/agility.md` lost 1 tick per click, but that was practice (local, 150 ms tick).

**Their failures to guard against:** logout refused while under attack; rings delivered as notes; prayer at 0 among poison spiders; two orders to the same account at once (operator "log out" against coordinator "takeover"), which left the body undriven and dead.

**Claim: Cairn's route is public, with ticks per step.** Evidence: https://rune.fast/route. Their plan sums to 34,143 ticks. Their real run took 35,787. The overruns were the spiders (+947, 541 of them while the body died), iron mining (+313, rock competition), the body altar (+233), fly fishing (+203) and the knights (+189). Our model (`.practice/workflow-repair-20261028/unrestricted-result.json`) is 45,570 ticks, 11,427 more than their plan. Next decision: price each of their steps in our planner and list the steps we cannot yet run.

| Step | Skills | Plan | Took |
|---|---|---|---|
| Tutorial skip, trade, Wind Strike at the coop | Magic 1-8 | 135 | 140 |
| Firemaking on the castle row, helpers drop logs | FM 1-99 | 661 | 661 |
| Enchant rings from 3 helpers | Magic 8-59 | 198 | 196 |
| Doric's Quest | Mining 1-49 | 69 | 66 |
| Air altar, 7 essence helpers | RC 1-44 | 207 | 206 |
| Woodcutting with knife reset, bury bones between rolls | WC 1-99, Prayer 1-99 | 3,296 | 3,391 |
| Plague City | Mining 49-64 | 591 | 595 |
| Iron by the Ardougne zoo, knife reset | Mining 64-99 | 3,157 | 3,470 |
| Tree Gnome Village | Attack 1-80 | 734 | 805 |
| Gnome course to 25, The Grand Tree | Agility 1-76, Attack 80-94 | 1,582 | 1,633 |
| Fight Arena | Attack 94-99, Thieving 1-57 | 607 | 594 |
| Dwarf Cannon | Crafting 1-42 | 1,027 | 986 |
| Cannon at the poison spiders | Ranged 1-50 | 488 | 511 |
| Monkey Madness | Str 1-97, HP 42-97, Def 1-89 | 4,563 | 4,113 |
| Mage Arena | Magic 77-81 | 547 | 637 |
| Ardougne knights; Charge, Superheat, arrows in the stuns | Thieving 57-99, Magic 81-99, Fletching 1-99 | 2,099 | 2,288 |
| Sea Slug, Fishing Contest | Fishing 1-78 | 859 | 791 |
| Body altar, essence rota | RC 44-99 | 1,279 | 1,512 |
| Fly fishing at Lumbridge, knife reset | Fishing 78-99 | 2,054 | 2,257 |
| Cook's Assistant, Druidic Ritual, Goblin Diplomacy, Romeo and Juliet | Cooking 1-30, Herblore 1-28 | 752 | 750 |
| Platebodies at the Varrock west anvil | Smithing 41-99 | 903 | 1,018 |
| Bank booth: Crafting, Herblore, banked wine | Crafting 48-99, Herblore 28-99, Cooking 30-99 | 513 | 571 |
| Dragon Slayer | Str 97-99, Def 89-98 | 1,370 | 1,430 |
| Cannon and magic shortbow at the spiders | Def, Ranged 55-99, HP 99 | 2,152 | 3,099 |
| Wilderness Agility Course | Agility 76-99 | 4,300 | 4,067 |

**Claim: our largest extra costs against Cairn's plan are combat and Smithing, plus walking.** Conditions: `bun packages/planner/src/cairn-cli.ts`, scenario a realistic, travel on, `research/hiscores-live.json`; prices include the walk into each row. Evidence: spiders and melee top-ups 6,535 against 2,152 (+4,383); Family Crest plus superheat 4,078 against an anvil 903 (+3,175); The Dig Site 1,993, which Cairn skips (Doric's Quest and Plague City instead); Monkey Madness +938; the four early quests +859; The Grand Tree +851. Walking totals 8,254. Our iron (-639) and knights (-136) rows are cheaper than Cairn's plan, so they may be optimistic. Gap: 9 of 25 steps lack a planner row, a worker script, or the script file their capability names (Wind Strike start, castle-row fires, rings, Doric's Quest, air altar, Plague City, first spiders, Mage Arena, anvil). Next decision: price the anvil Smithing route and Cairn's combat order in the planner.

**Claim: the anvil route saves 1,844 ticks, and the planner chooses it.** Conditions: scenario a realistic, travel on, `research/hiscores-live.json`. Option `magic-smithing=anvil` (`packages/planner/src/haggis-boards.json` rows `smith-anvil`, `magic-anvil`): platebodies 1-99 with a helper trading bars at the Varrock west anvil (MEASURED 1,316 ticks practice), enchant 7-80 without dragonstone in the foreground (183 casts, ESTIMATE from the MEASURED cast rate), then Mage Arena and Charge 80-99. Evidence: Overall 45,570 -> 43,726 (floor 43,135 -> 41,158); Magic and Smithing rows 3,131 ticks with walks against 4,453 for Family Crest plus superheat. The old `separate` option never finishes: its Magic row is a stun guest of thieving, and thieving needs Monkey Madness, which needs Magic 75. Gap: Cairn's anvil is 903 ticks against our 1,316 from 1 (they arrive at Smithing 41 from Superheat in the stuns and trade in bursts); no worker script exists for the anvil or Mage Arena. Next decision: Smithing 1-41 by Superheat inside the knights' stuns, and the combat order (spiders and melee top-ups, +4,383).

**Claim: Cairn's combat order does not help in our model; their combat gain is quest speed.** Conditions: scenario a realistic, travel on, `research/hiscores-live.json`; lever `rival-dragon-combat` (Dragon Slayer before the top-ups, a measured 30-tick Doric's Quest for the 32nd QP). Evidence: Overall 43,726 default, 44,354 with the lever (floor 41,158 -> 41,805). Dragon Slayer (2,003 with walk) replaces the Strength and Defence top-ups (2,961), but Goblin Diplomacy, Romeo and Juliet and Doric move before it, and Hitpoints then needs Witch's House at the end (772). The planner QP counter keeps the Fight Arena, Monkey Madness and Sea Slug points in quests-rest, so the lever sets Dragon Slayer's `minQp` to 0 and requires the 12 rows that give the real 32 QP. Our quest rows cost more than Cairn's: Monkey Madness 5,501 against 4,563 (their one-tick dialogue client saved 450), The Grand Tree with Agility 1-25 2,433 against 1,582, Tree Gnome Village 1,321 against 734. Ranged rates are close: their Ranged 1-99 took about 325 XP per tick without the death (998,458 XP over 3,069 ticks, which also trained Defence and Hitpoints); our row is 309. Next decision: measure our dialogue speed (ticks per page) and the walk into each quest.

**Dialogue pace:** MEASURED practice, 16 pages in 32 ticks with our client and 15 with a raw burst; see `research/quest-plan.md` ("Dialogue burst").

## 8. Other teams' setups: tooling and process against ours

Scope: public setups of other people who bot rs-sdk or the demo server. In-game methods are in `research/rival-gap-list.md` and `research/rival-rune-fast.md`. Sources were read through `gh api` and web search. Nothing was cloned into the repo and nothing from them was run. Copies of the rune.fast data files are in the session scratchpad only.

### 8.1 Sources

| Source | Commit read | License | State |
|---|---|---|---|
| [bleugreen/rune.fast](https://github.com/bleugreen/rune.fast) (Cairn swarm record: `data/story.md`, `data/harness.json`, `data/summary.json`, `data/attempts-timeline.json`, `data/billing.json`) | `bbde3707` | none: facts only, no code | active |
| [bleugreen/rs-sdk](https://github.com/bleugreen/rs-sdk) | none | MIT when last read | `gh api repos/bleugreen/rs-sdk` returns 404. `research/rival-gap-list.md` at `3bd2ab0a` is the last read; no later commits can be checked. bleugreen's harness, Cairn, is a closed product (`bleugreen/cairn-releases`) |
| [UberMouse/rs-sdk](https://github.com/UberMouse/rs-sdk) (`AGENTS.md`, `conductor/README.md`, `conductor/docs/parallel-bots.md`, `.claude/skills/conductor/SKILL.md`) | `9df2d4c9` | MIT | 991 ahead, 19 behind upstream; commits daily |
| [Supalosa/rs-sdk](https://github.com/Supalosa/rs-sdk) branches `codex/lockstep-clock` (`40358da0`), `codex/runtime-sdk-609472364` (`c4ec61d4`) | as named | MIT | branches only; `main` equals upstream |
| [Spenny12/rs-sdk](https://github.com/Spenny12/rs-sdk) branch `walk-speed` | `46cdcb1e` | MIT | one commit |
| [MaxBittker/rs-sdk](https://github.com/MaxBittker/rs-sdk) | `db0cc51e` | MIT | our submodule pin `b565f2d9` is 19 commits behind |
| [MaxBittker/runebench](https://github.com/MaxBittker/runebench) | `99afc8f5` | none | new model rows only; PR 25 adds subscription-only Codex login |
| [rs2b2t/rs2b0t](https://github.com/rs2b2t/rs2b0t) | `4c4d03e1` | MIT | quest stall recovery fixes (#905, #907) |

Checked and not relevant to process: 157 forks of MaxBittker/rs-sdk listed with `gh api repos/MaxBittker/rs-sdk/forks`. Of the 24 pushed after 20 October, 13 have 0 commits ahead. Wgelyjr (23 ahead) is web-client UI. SeanVella/pvp-sdk is PvP and a GE ledger. Urnz is a simulated society. HazAT, loopwork and mitchellm are pre-rewrite history. CharlieSteer/2004scape-harness is an upstream copy. TestingPurposes/rs-sdk-fleet (pushed 3 August), markeljan/rs-sdk-dashboard (14 October), samheutmaker/lumbridge-ai and Skyvern-AI/jevscape have no new commits since sections 1, 2 and `research/botting-ecosystem-2026-10-23.md`. Web search found no other public write-up ([search 1](https://maxbittker.github.io/runebench/), [search 2](https://github.com/MaxBittker/rs-sdk/wiki)).

### 8.2 Cairn swarm (bleugreen): #1 Overall in 5 d 13 h

**Claim: one operator ran an issue-driven agent swarm that went from a first message to #1 Overall in 5 days 13 hours.** Conditions: 20-26 October; one operator, 765 operator messages. Evidence: `data/story.md` section 1; `data/harness.json` `.totals`. Gap: self-reported; the store behind it is private.

- **Agent loop.** A `main` thread plans and rules. A `host` thread runs the VPS and the scored account. Builders write scripts. Coordinators merge. Work is a GitHub-style issue on a recipe (`.recipes`): `build` (Trigger, Builder, PR) ran 910 times; `planbuild` (Planner, Plan, Builder, PR, Review) ran 20 times; `coordinator` 23; `thread` 6; `memory-triage` 3. So 910 of 962 executions merged without a separate review agent. Findings land as committed Markdown, never only in chat (tenet 3).
- **Scale and cost.** 3,761 agent runs, 900 issues, 532 merged PRs in 5.9 days (about 90 a day), median merged issue $5.38 at list price. Peak 87 agents producing output in one 5-minute bucket; Thursday peak 61. List-price total $17,679 (Opus $12,779, Fable $3,157, gpt-6-astra $1,671). The bill was six Claude Max plans and one ChatGPT Pro plan, $1,400 a month. When Claude limits ran out, the operator moved agents to Codex and back (`story.md` sections 3, 5, 6).
- **Testing.** A lab engine at 150 ms on the operator's Mac. A full-chain dress rehearsal, lab run L2, went from start to total level 1,881 in 9 h 19 m (`attempts-timeline.json` L2). Live attempts 1-4 failed and continued as live rehearsals of the unproved later steps (A3, R3, A4).
- **Hosting and sessions.** One run host in AWS us-east-1, 3 ms from the server. Every live run starts `run.ts` at a named commit (R3: "run commit 1e536f76"). Logged-out time is free, so main ruled to hold logged out when iron rocks were taken and through a 6-hour gap ("wall clock is free, ticks are not", `story.md` section 5).
- **Failures.** Attempt 1 lost to logout refused under attack. Attempt 2 to rings delivered as notes. Attempt 3 to a full pack when bury fell behind. Attempt 5 died when the operator's "log out" and main's "takeover" orders reached `host` together (`story.md` section 6).
- **Method choice.** One `thread` per question ("per-skill max xp/tick on this server", "helper swarm logistics + hiscore timing"); tricks found by reading engine code (`story.md` section 2).

### 8.3 UberMouse conductor: one Claude Code session, deterministic tasks, save library

**Claim: UberMouse tests every change from a saved game state on a throwaway worker account, and re-runs new code against recorded runs without a server.** Conditions: one main bot, local engine with `SAVE_ENDPOINTS=true`, GE off locally. Evidence: `conductor/README.md` ("Parallel testing", "How it learns"), `conductor/docs/parallel-bots.md`. Gap: no hiscore entry found for their bot; their XP-per-hour figures are their own.

- **Agent loop.** An Opus conductor session (`.claude/skills/conductor`) picks goals and dispatches subagents: `task-runner` (owns one goal, writes and runs plans), `task-author`, `task-review` (5 lens reviewers plus a verifier), `knowledge-curator`, and a `retrospective` every 10 runs that reads agent transcripts. Bot code is deterministic: tasks are generators that yield ops; an interpreter runs them against the live game or a scripted timeline.
- **Testing.** Unit tests on scripted worlds with no server (`bun test conductor`). Integration smoke runs against the local engine. 276 scenario saves in `conductor/saves/`. `save.ts snapshot` exports a live player's save without a logout through the engine management port (`GET /save/<name>`, `POST /kick/<name>`). `load.ts <worker> lib:<save>` loads any save under another name. A recent commit proved Pirate's Treasure from a library save to quest done in 416 s and promoted the plan the same day (`7d949f6f`).
- **Replay.** Every run writes `<runId>.ticks.ndjson.gz` (about 2.8 MB an hour) with what the code observed and every command it sent. `replay.ts` re-runs the current task code on it and prints the first command that differs.
- **Sessions.** The gateway refuses a second controller unless it asks for takeover. Guards (death, wilderness, low HP, dialog) run at every tick wait, so tasks hold no threat handling of their own.
- **Method choice.** `stats.ts --methods` sets each method's measured XP per hour beside its floor in `wiki/world/methods.ts`; the conductor explores, then exploits the fastest measured method.

### 8.4 Smaller sources

- **Supalosa `codex/lockstep-clock`:** an opt-in lockstep clock and action batching in `sdk/clock.ts`, `server/engine/src/engine/World.ts` and `server/webclient/src/lite/test-clock.ts` (210 added lines). It is the same idea as the Rig Atlas simulator that ran about 12 times live (`research/rival-atlas-2026-10-16.md` point 2). Gap: no speed figure published; not run here.
- **Spenny12 `walk-speed`:** `walkTo` on the hosted gateway took 148 ticks for 35 tiles (ideal about 18) because it waited for an ack at each corner; the fix aims at the farthest waypoint within 40 tiles and chains hops. Our `packages/core/src/walk.ts:295` already replaces per-corner `bot.walkTo` clicks, so this is a cross-check, not a gap.
- **Upstream engine, 19 commits past our pin:** `97725db3` attaches a second login to the Player already in the world, like a reconnect; `2c7d4607` makes takeover wait for a safe logout point (up to 50 ticks); `db0cc51e` logs out the client a takeover replaces; `58ff80de` sets the tick to 400 ms and the per-IP cap to 50. Gap: whether the demo server runs these commits is not checked.
- **rs2b0t:** quest runs recover from stalled quest progress and gather missing inputs (#905, #907, #908).

### 8.5 Comparison with our setup

| Point | Cairn | UberMouse | Ours | Faster or simpler |
|---|---|---|---|---|
| Idea to live | first live attempt on day 4; #1 on day 6 | library save to quest done in 416 s, plan promoted same day | build in workspace, native delivery, review, qualification, `WORKER_RELEASE` pin, bounded pilot (`docs/script-contract.md`) | theirs: fewer gates before a live run |
| Release binding | each run at a named commit | current code; replay checks decisions | one hash over all of `scripts/`, `packages/` (except dashboard, router), `vendor/rs-sdk/sdk`, `vendor/rs-sdk/server/webclient/src` (`packages/core/src/worker-release.ts:11,15-38`); any edit there changes the pin; peers must match | theirs: a change does not hold unrelated workers. The plan blocker "fresh-rune-supply-order needs a new practice qualification: its file `quest-lib.ts` changed" is this cost |
| Review | 910 of 962 recipe runs with no review agent | 5-lens review before commit, on task code only | one independent cross-model review per build | Cairn's is simpler |
| Test start state | lab engine, full chain from the start | 276 saves, live snapshot without logout | presets built from specs (`packages/practice/src/presets*.ts`); no live snapshot | UberMouse's: a test does not walk to its spot or rebuild earlier steps |
| Offline checks | not published | unit tests on scripted worlds; replay of recorded runs | unit tests; practice at 150 ms | UberMouse's replay cuts review and requalify work |
| Sessions and recovery | operator and main by hand; one death from two orders | gateway lease plus `--takeover` | admission, recovery and permit code, 1,016 lines (`packages/core/src/session-*.ts`), waits up to the server's 200 s lost-session drop (`worker-release.ts:124`) | theirs are simpler; upstream `97725db3` may remove the wait |
| Accounts and RAM | one scored account, helpers on one VPS | one main bot, workers | accounts on three fleet sides (this PC's cap 17, `AGENTS.md`); 137 MB a bot in one host against 547 MB alone (`research/bot-host.md`) | ours is ahead on fleet density |
| Method choice | thread per question, engine code reads | measured XP/h per method against a floor | planner rows with MEASURED and ESTIMATE labels (`packages/planner/src/haggis-boards.json`) | ours is ahead on a whole-run model; theirs measure more methods live |
| Run host | us-east-1, 3 ms | local | this PC, 100-370 ms to the Fly edge (section 7) | Cairn's; already a plan item |
| Model use | ~180 agents average, six Max plans | one conductor plus subagents | one Claude and Codex coordinator plus one session per plan lane (`docs/plans/joined-plan.md` Lanes) | Cairn's by about 36 times (`research/rival-rune-fast.md`) |

Where we are ahead: paired receipts and reconciled assets; fleet sides with cross-side orders; one bot host process for many bots; pinned-content knowledge (`packages/knowledge`); a whole-run planner priced against Cairn's route (`packages/planner/src/cairn-cli.ts`); guards for the failures that ended Cairn attempts 1, 2 and 5 (logout under attack, noted deliveries, one controller per account).

### 8.6 Ranked changes that would most speed up our progress

1. **Bind a live release to each capability's import closure, not the whole tree.** Evidence: `workerSourceRevision` hashes four whole roots (`packages/core/src/worker-release.ts:11,15-38`); `assertCompatibleWorkers` holds live starts on any mismatch; a pending recovery fails with `recovery source changed` when that hash moves (`packages/core/src/session-recovery-permit.ts:117`, `session-recovery.ts:261`), so one merge can both hold live starts and void recoveries; the plan's requalify blocker; Cairn ran each live run at a named commit with no fleet-wide pin. Files: `packages/core/src/worker-release.ts`, `packages/core/src/session-recovery{,-permit}.ts`, `packages/router/src/coordinator-live.ts`, `packages/router/tasks/*.json`. Check: an edit to a file outside a capability's closure leaves its pin and its live slots unchanged; an edit inside changes it.
2. **A save library with live snapshots for practice.** Snapshot a live or practice player's save without a logout and load it under a practice account, so a qualification or route rehearsal starts at step N. Evidence: UberMouse 276 saves and the management endpoints (`conductor/docs/parallel-bots.md`); Cairn's full-chain rehearsal took 9 h 19 m. Files: `packages/practice/src/presets.ts`, `packages/practice/src/stack.ts`, a management route in our practice engine patch set. License: MIT (UberMouse); rewrite, keep the notice if code is adapted. Check: a saved Monkey Madness mid-state loads and the worker resumes from it on practice.
3. **Record ticks and replay decisions.** Write each worker run's observations and sent commands; a replay runs changed code on the record and reports the first different command. Reviews and requalifies then use recorded runs instead of a new practice run where the replay matches. Evidence: UberMouse `replay.ts`, about 2.8 MB an hour. Files: `packages/core/src/{bot,act,ticks}.ts`, `packages/router/src/coordinator-worker.ts`. Check: a refactor with no behaviour change replays clean on three recorded runs; a changed decision is reported at its tick.
4. **Take the upstream takeover commits and shrink recovery.** Move the submodule pin from `b565f2d9` to `db0cc51e`, check on practice that a re-login attaches to the Player in the world, and check the demo server does the same. Then a recovery is one re-login instead of a hold up to the 200 s drop. Evidence: upstream `97725db3`, `2c7d4607`, `db0cc51e` messages. Files: `vendor/rs-sdk`, `packages/core/src/session-recovery.ts`, `session-recovery-permit.ts`, `session-admission.ts`. Check: practice proof that a killed client's account resumes control on re-login with position, combat lock and inventory kept.
5. **Make review non-blocking for builds inside their owned files.** Run the practice qualification and the bounded pilot at once with review, and block only on the review's concrete-defect list. Evidence: Cairn's `build` recipe merged 910 times with no review agent; our contract requires one review per build (`docs/script-contract.md` "Review"), and the coordinator pairs every build with a fresh reviewer (`packages/router/src/coordinator-planner.ts:107`). Files: `docs/script-contract.md`, `packages/router/src/coordinator-worker.ts`, `packages/router/src/coordinator-planner.ts`. Check: time from build done to first live pilot, before and after, on the next three builds. This changes the acceptance contract, so it is an owner decision.

Not ranked because it is already in the plan: a us-east run host (Cairn's largest stated gain). Worth a trial after these five: the Supalosa lockstep clock for faster practice.
