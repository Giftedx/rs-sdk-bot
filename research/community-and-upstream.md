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
| [MaxBittker/rs-sdk](https://github.com/MaxBittker/rs-sdk) | `db0cc51e` | MIT | our submodule pin; `patches/rs-sdk-working.patch` applies on it |
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
| Test start state | lab engine, full chain from the start | 276 saves, live snapshot without logout | presets built from specs (`packages/practice/src/presets*.ts`) and a practice save library (`packages/practice/saves/`, snapshot without logout); no live snapshot | UberMouse's: a test does not walk to its spot or rebuild earlier steps |
| Offline checks | not published | unit tests on scripted worlds; replay of recorded runs | unit tests; practice at 150 ms | UberMouse's replay cuts review and requalify work |
| Sessions and recovery | operator and main by hand; one death from two orders | gateway lease plus `--takeover` | admission, recovery and permit code, 1,016 lines (`packages/core/src/session-*.ts`), waits up to the server's 200 s lost-session drop (`worker-release.ts:124`) | theirs are simpler; a takeover server skips the wait (change 4) |
| Accounts and RAM | one scored account, helpers on one VPS | one main bot, workers | accounts on three fleet sides (this PC's cap 17, `AGENTS.md`); 137 MB a bot in one host against 547 MB alone (`research/bot-host.md`) | ours is ahead on fleet density |
| Method choice | thread per question, engine code reads | measured XP/h per method against a floor | planner rows with MEASURED and ESTIMATE labels (`packages/planner/src/haggis-boards.json`) | ours is ahead on a whole-run model; theirs measure more methods live |
| Run host | us-east-1, 3 ms | local | this PC, 100-370 ms to the Fly edge (section 7) | Cairn's; already a plan item |
| Model use | ~180 agents average, six Max plans | one conductor plus subagents | one Claude and Codex coordinator plus one session per plan lane (`docs/plans/joined-plan.md` Lanes) | Cairn's by about 36 times (`research/rival-rune-fast.md`) |

Where we are ahead: paired receipts and reconciled assets; fleet sides with cross-side orders; one bot host process for many bots; pinned-content knowledge (`packages/knowledge`); a whole-run planner priced against Cairn's route (`packages/planner/src/cairn-cli.ts`); guards for the failures that ended Cairn attempts 1, 2 and 5 (logout under attack, noted deliveries, one controller per account).

### 8.6 Ranked changes that would most speed up our progress

1. **Bind a live release to each capability's import closure, not the whole tree.** Evidence: `workerSourceRevision` hashes four whole roots (`packages/core/src/worker-release.ts:11,15-38`); `assertCompatibleWorkers` holds live starts on any mismatch; a pending recovery fails with `recovery source changed` when that hash moves (`packages/core/src/session-recovery-permit.ts:117`, `session-recovery.ts:261`), so one merge can both hold live starts and void recoveries; the plan's requalify blocker; Cairn ran each live run at a named commit with no fleet-wide pin. Files: `packages/core/src/worker-release.ts`, `packages/core/src/session-recovery{,-permit}.ts`, `packages/router/src/coordinator-live.ts`, `packages/router/tasks/*.json`. Check: an edit to a file outside a capability's closure leaves its pin and its live slots unchanged; an edit inside changes it.
2. **Make the next job of a qualified chain deterministic, with no model call.** Evidence: every coordinator task comes from a model planning round (`planWork`, `packages/router/src/coordinator-planner.ts:183`), run on a new receipt or every 30 minutes (`IDLE_PLAN_MS`, `coordinator-cli.ts:48`); run tasks are finite and the planner may never set `repeat:true` (`coordinator-planner.ts:107`); the plan's blocker "The coordinator is paused by `.practice/stop-coordinator`". So a paused coordinator, a model limit or a slow planner stops a proven production chain at its next step. Cairn lost 6 hours when a run stopped and nothing restarted it (`story.md` section 5) and switched models mid-run to keep going. UberMouse plans loop phases chosen by pure `when` predicates with no LLM (`conductor/README.md` "Plans"). Our deterministic planner `packages/planner/src/autopilot.ts` plans only accounts no hand job names. Files: `packages/planner/src/autopilot.ts`, `scripts/swarm.ts`, `packages/router/src/coordinator-live.ts`. Check: with the coordinator stopped, a qualified chain (for example goldfarm to bank to next batch) starts its next finite batch on the receipt.
3. **A save library with live snapshots, and practice rehearsal of the record route's early segments.** Snapshot a live or practice player's save without a logout and load it under a practice account, so a qualification or route rehearsal starts at step N. Evidence: UberMouse 276 saves and the management endpoints (`conductor/docs/parallel-bots.md`); Cairn's full-chain rehearsal took 9 h 19 m. Files: `packages/practice/src/presets.ts`, `packages/practice/src/stack.ts`, a management route in our practice engine patch set. License: MIT (UberMouse); rewrite, keep the notice if code is adapted. The plan's Main lane already names "the first five route steps on practice"; saved states let each step start without the steps before it. Check: a saved Monkey Madness mid-state loads and the worker resumes from it on practice. Practice part in place: `packages/practice/src/save-endpoint.ts` (engine preload, `GET /save/<name>` between ticks), `save-library.ts` (snapshot, list, load), `rehearse.ts` (segment runs with engine ticks against a plan). Not built: live snapshots and the Monkey Madness mid-state.
4. **Take the upstream takeover commits and shrink recovery.** The submodule pin is `db0cc51e`. A held live session still waits for the authenticated recovery path, because the demo server's takeover behaviour is not proven.
   - Claim: on the pinned engine a re-login attaches to the Player still in the world. Conditions: practice engine from `db0cc51e` plus `patches/rs-sdk-working.patch`, 400 ms ticks, account `tkoprove3`, client killed with `taskkill /T /F` and no logout, re-login 7,534 ms after the kill. Evidence: `.practice/takeover-db0cc51e/tkoprove3/` (`run.log`, `first.log`, `second.log`, `engine.log`). Before the kill the client stood at 3226,3218 with slot 1 and had dropped its 3 bread in memory (the save on disk still had them at 3222,3218). After the re-login: slot 1, 3226,3218, no bread, no "Welcome to RuneScape." message (`[login,_]` did not run). The engine logged one `removePlayer()`, for the second client's own logout, which ended `logged-out`. Gap: combat lock, death and delays were not exercised; one run.
   - Control on the old pin `b565f2d9`, same steps (`.practice/takeover-db0cc51e/tkoold1/`): the re-login also kept the in-memory tile and inventory, but by reload. The engine logged `removePlayerWithoutSave() ... (session takeover)` and the second client got "Welcome to RuneScape.". So the old engine already let a re-login recover a died client; `97725db3` makes it attach, so a death, duel, delay or combat lock carries on instead of being dropped (its commit message), and `db0cc51e` sends LOGOUT to the replaced client so two clients cannot bounce the account.
   - Live server: not proven. `/api/version` returns only the content revision (`server/engine/src/web/pages/api.ts:43`). The live lifecycle records (`.practice/session-lifecycle/live/`) hold no re-login onto a Player still in the world after `db0cc51e`: 15 accounts ended `disconnected` within 106 ms at 06:33:49 UTC on the day after `db0cc51e`, which is a server restart, and every later fast re-login followed a session that sent logout. The discriminating signal for a later read-only check is the login message: an attach sends none, a reload sends "Welcome to RuneScape.".
   - Code: `packages/core/src/session-takeover.ts` `TAKEOVER_SERVERS` is the gate; it is empty. With a server listed, `liveLogoutRef` admits a held session by re-login when no owner process after the last confirmed logout runs (`docs/script-contract.md` "Recover a session"). Check that remains: one read-only live observation of a re-login without the welcome message, then list the server.
   - Also in this pin range: upstream `fly.toml` sets `NODE_TICKRATE` 400 and `MAX_PLAYERS_PER_IP` 50 (`58ff80def`); bank 576 slots and 12 GE offer slots (`3e86cdb01`). The demo server's actual tick length was not measured here.
5. **Make review non-blocking for builds inside their owned files, backed by tick replay.** Record each worker run's observations and sent commands; a replay runs changed code on the record and reports the first different command (UberMouse `replay.ts`, about 2.8 MB an hour). Run the practice qualification and the bounded pilot at once with review, and block only on the review's concrete-defect list. Evidence: Cairn's `build` recipe merged 910 times with no review agent; our contract requires one review per build (`docs/script-contract.md` "Review"), and the coordinator pairs every build with a fresh reviewer (`packages/router/src/coordinator-planner.ts:107`). Files: `docs/script-contract.md`, `packages/core/src/{bot,act,ticks}.ts`, `packages/router/src/coordinator-worker.ts`, `packages/router/src/coordinator-planner.ts`. Check: time from build done to first live pilot, before and after, on the next three builds. This changes the acceptance contract, so it is an owner decision.

Not ranked because it is already in the plan: a us-east run host (Cairn's largest stated gain). Worth a trial after these five: the Supalosa lockstep clock for faster practice.

### 8.7 Leads from the parallel Codex pass

| Lead | Check | Decision |
|---|---|---|
| Cairn roles: planning, execution host, builders, supply helpers, private rehearsals, VPS near the server | rune.fast `bbde3707` `story.md` sections 3-5, `attempts-timeline.json` L2 | confirmed; section 8.2 |
| TestingPurposes/rs-sdk-fleet: browserless clients, sharded execution, offline tests of real worker loops | `3cb9a526`, no commits after 3 August; no license; numbers self-reported (`research/botting-ecosystem-2026-10-23.md` section 4) | confirmed as ideas only; our bot host covers the memory side (`research/bot-host.md`) |
| Skyvern-AI/jevscape: bounded catalogue, cheap corrective decisions, random baseline | `8fe4d373`, unchanged; no license (section 1) | confirmed; ideas only |
| samheutmaker/lumbridge-ai: persistent supervisor, standing instructions | `210b7ac9`, unchanged; MIT (section 2) | confirmed; separate server, rates do not compare |
| RuneBench: isolated accelerated environments; best 15-second window is not our objective | `99afc8f5`; `research/runebench-and-harbor.md` | confirmed |

| Codex priority | Decision and evidence |
|---|---|
| Stage supplies from existing coin wealth | confirmed as plan work, not a loop change: 75,500 coins and 125 sharks banked with no consumer; bank staging 5/73 (`docs/plans/joined-plan.md`) |
| Measure action-to-effect latency from this PC against a host near the server | confirmed, already in the Main lane; edge latency 100-370 ms measured, ticks per reaction not measured (section 7) |
| Rehearse a record route's early segments on practice | confirmed; merged into change 3 |
| Measure overlapping skills against standalone runs | not in this list: in-game method measurement for the in-game session; the contract already requires three matched runs per condition |
| Deterministic qualified job transitions so a model outage does not stop proven chains | confirmed; change 2 |

## 9. Further community sources

Checked with `gh api` (forks of MaxBittker/rs-sdk with commits ahead of upstream, `gh search repos`, commit lists). No downloaded code was run.

### 9.1 What to fold in

| Source (license, commit) | What it holds | Local consumer | Decision | Check |
|---|---|---|---|---|
| [TestingPurposes/rs-stun-toolkit](https://github.com/TestingPurposes/rs-stun-toolkit) (MIT, `4e40de3d`) | 69 quest launchers with notes (`run-<quest>.share.md`: prerequisites, kit, sim ticks, limits); a browserless rev-289 client; an offline brain sim; a lockstep engine with seeded chaos switches; a navgrid with door tables | `scripts/generated/quest-<name>.ts`, `packages/practice/src/presets-*.ts` | adapt: port the quest logic into `quest-lib.ts`, one quest at a time; reject the client and engine overlay (they patch upstream files we pin) | a practice run per port, then the coverage row |
| [UberMouse/rs-sdk](https://github.com/UberMouse/rs-sdk) (MIT, `9df2d4c9`) `wiki/quests/`, `wiki/training/` | 51 of 61 quests marked promoted; per-quest run times from a save; training floors per skill | quest scripts in the `named` stage; `haggis-boards.json` floors | adapt: read the page before fixing a failing quest | the quest's practice run |
| [Spenny12/rs-sdk](https://github.com/Spenny12/rs-sdk) (MIT, `c257bd88`) `learnings/quest-route-combat.md` | A combat-quest order for a fresh account (Vampire Slayer, Priest in Peril, Waterfall, Merlin's Crystal, Holy Grail), dialogue lines, drained shops | Haggis route rehearsal | adapt as a cross-check | route rehearsal on practice |
| [CraziedAres/rs-sdk](https://github.com/CraziedAres/rs-sdk) (MIT) `sdk/processing.ts`, `sdk/tick-clock.ts` | Item-on-item and drop helpers that send up to 5 actions per tick; spell periods (alchemy 5, superheat and enchant 3) | `research/xp-per-tick.md` | check first: our burst rules are in `xp-per-tick.md`; take only what is missing | a unit test against our tick model |
| MaxBittker/rs-sdk upstream `42739f45`, `09679918` (MIT) | `42739f45`: the server checks that a used item is still in its slot before an item-on-X op, and clamps count-dialog input. `09679918`: 1 gp alchemy value on quest items an NPC gives again for free | our pin `db0cc51e` has neither | check whether the live server runs them before a plan depends on the old rules | a read-only live check |

Rejected: `babaali131718-spec/rs2b0t-quest-forge` (no license, only an HTML page and generated commits: treat as a lure); `index-rs/LC-bankvalue`, `ineedbots/lc-headless` (no license); joshualparris, bogocat, Pursche forks (nothing we lack).

### 9.2 Quest coverage the toolkit closes

The toolkit holds four quests our folders lacked: Tai Bwo Wannai Trio (`qp/south/`), Watch Tower (`qp/west/`), Hero's Quest (`qp/spine/`, two accounts) and Legends' Quest (`legends/`, sim only, not run live by its authors). `quest-tbwt.ts`, `quest-itwatchtower.ts`, `quest-hero.ts` and `quest-legends.ts` are ported.

**Claim:** `quest-tbwt.ts` completes Tai Bwo Wannai Trio in 1,462, 1,483 and 1,469 ticks (3 of 3, MEASURED practice). Conditions: preset `quest_tbwt` (every skill 99), the practice server, `0e2ea7d1`. Evidence: `.practice/tbwt-port/run4.log`, `run5.log` (`RESULT ok qp=2`, "Congratulations! Quest complete!"). The toolkit reports 1,468-1,509 ticks in its lockstep sim at agility 60 and magic 50. Gap: not run live; at agility below 99 the log bridge and the stones drop the bot more often.

**Claim:** `quest-itwatchtower.ts` completes Watch Tower in 1,953, 1,998 and 1,970 ticks (3 of 3, MEASURED practice). Conditions: preset `quest_itwatchtower` (every skill 99, rune set with the anti-dragon shield, jangerberries and 2 ropes in the kit), the practice server, `f141e461`. Evidence: `.practice/watchtower-port/proof-1.log`, `proof-2.log`, `proof-3.log` (`RESULT ok qp=4`, "Congratulations! Quest complete!"; lowest hitpoints 72, no food eaten). Gap: not run live; not run at the quest's minimum levels; the shield and combat 126 stand in for their Protect from Magic and pinning-ogre handling, so a weaker account needs both checked.

**Claim:** `quest-hero.ts` completes Hero's Quest on both accounts in one process: Black Arm 1,641, 1,643 and 1,645 ticks, Phoenix 1,532, 1,580 and 1,535 ticks (3 of 3, MEASURED practice). Conditions: presets `quest_hero` and `quest_hero_helper` (every skill 99, nothing worn, both outside the guild door, the toolkit kit with 6 lobsters), the practice server, `ad432a5d`. Evidence: `.practice/hero-port/proof-1.log`, `proof-2.log`, `proof-3.log` (`RESULT ok qp=1 ... mainDone=true helperDone=true`; no food eaten; lowest hitpoints 43, at the Ice Queen, in one run). The toolkit reports 1,745-1,803 ticks in its lockstep sim. Gap: not run live; not run at the quest's minimum levels; magic 99 stands in for their 150-cast rune stock and retries; the Phoenix side needs a second account with 55 QP in the Phoenix Gang.

**Claim:** `quest-legends.ts` completes Legends' Quest from the guild gate in 3,996, 3,878 and 4,221 ticks (3 of 3, MEASURED practice). Conditions: preset `quest_legends` (every skill 99, combat rune set worn, the carry kit with 4 sharks), helpers `quest_legends_kit_b` and `quest_legends_kit_c` at the meeting tile 2816,2947, the practice server, `51f87a21`. Evidence: `.practice/legends-port/proof-1.log`, `proof-2.log`, `proof-3.log` (`RESULT ok qp=4`, "Congratulations! Quest complete!"; lowest hitpoints 69, no food eaten). The toolkit reports 3,883-4,305 ticks in its lockstep sim and never ran it live. Each training pick gives 191,250 XP. Gap: not run live; not run at the quest's minimum levels, where the map, forge, trial and planting rolls fail often and the source's spare gold bars and Re-get seed recovery are needed (the port carries 2 bars and fails if every seed withers); the helpers start at the meeting tile with the kits, so a live run must stage them there.

### 9.3 Protocol rules from the toolkit guide that our docs do not state

Their claims (`GUIDE.md` "Pitfalls and practices"):

- Op 1 on a door that is already open closes many doors again. Track door state before a click. Confirmed: `[oploc1,_door_open_and_close]` runs the same toggle for both states (`doors/scripts/open_and_close_doors.rs2`).
- Withdraw-X requests sent in one tick can be merged by the server. Prefer the fixed bank buttons. Not checked; the fixed buttons are confirmed (section 9.4).
- An opened door can swing onto the next tile, and static collision assumes it is closed. Not checked.

### 9.4 Facts from the second source pass

Each row was checked against the pinned engine or content, unless the row says otherwise.

| Claim | Source | Evidence | Local consumer | Decision |
|---|---|---|---|---|
| The first trade offer can go out with obj 0, because `tradeside` has not arrived; the server refuses it silently and the offer times out | Supalosa `02dd934c` (MIT, leases branch) | `InvButtonHandler.ts:44` refuses on `!hasAt` | `serveTrades` in `scripts/fleet-trade.ts` | lead: no local log shows this timeout; patch only after a receipt shows it |
| Bank amounts can use the fixed 10, 5, 1 and All buttons with no count dialog | CraziedAres `sdk/processing.ts` (MIT) | `bank.rs2:1-5,41` | `withdrawN` in `scripts/measure/floor-lib.ts`; `trip.ts` uses X | candidate: needs three matched runs on a bank-bound skill |
| A rise in `opRejectedCount` does not always mean refused: `p_stopaction` raises it for accepted ops | CraziedAres `processing.ts`, Supalosa `4536c573` | `PlayerOps.ts:430`, `Player.ts:1079-1081`, `StateCollector.ts:217-223` | `packages/core/src/act.ts` | applied as a comment; callers already opt out |
| `drop` has no delay, so 5 drops fit in one tick | CraziedAres `processing.ts` | `drop.rs2:1-25` | `fishing30.ts`, `gather.ts` | low: early fishing only |
| 26 shape 10 doors and gates are not in `knowledge/doors.json`; `pathcache.ts` opens only shape 9 | StechWasTaken `b0e743f9` (MIT) | their data; not checked in the engine | `packages/core/src/pathcache.ts` | lead: check when a walk stops at one |
| `HINT_ARROW` carries the agility arena's active pillar | Supalosa `d0cea1ff` | `agilityarena.rs2:22,47` | none | wait for a consumer |
| The kebab seller sells by dialogue for 1 gp | Spenny12 `learnings/` | `kebab_seller.rs2:20-25` | `research/supply-logistics.md` | low: we use sharks |

Do not copy: CraziedAres says Withdraw-All shifts later bank slots, but `Inventory.remove` only nulls the slot and compaction runs on bank open and close (`Inventory.ts:152-204`, `bank.rs2:18-31`). Spenny12 calls furnace 2785 inert, but `category=smithing_furnace` accepts item-on-loc (`smelting.loc:12-18`).

### 9.5 Quest failures closed with toolkit routes

Each quest failed the full practice batch. Conditions: the quest's preset (every skill 99), practice server. Evidence: `.practice/tbwt-port/proof-<quest>.log`. Gap: not run live.

| Quest | Cause | Fix | Ticks, 3 of 3 |
|---|---|---|---|
| Plague City | The Rehnison door needs Ted within 7 tiles and answered pages; the door shuts behind the bot; Bravek must be within 7 tiles when the clerk's "really needs to" page is continued | Answer the pages, open the door to leave, hold the clerk page at 2529,3317 | 418, 434, 434 |
| Biohazard | The bot stayed inside Elena's house, whose door shuts behind it | Leave by the door, then sail to Port Sarim (ships keep the sample; 60 coins) | 1,389, 1,300, 1,279 |
| Family Crest | Three crossings planned as open: the double gate at 3105,9944, Chronozon's gate at 3089,9945, Varrock's east gate at 3264,3405 | Op each gate; short legs round the rock | 1,097, 1,039, 1,058 |
| The Tourist Trap | The curtain at 3291,3031 closes Siad's building from the south; the anvil loop could click during the 8-tick forge | Open the curtain from 3291,3030 both ways; wait for the roll; 5 bars | 1,187, 1,215, 1,226 |

The anvil cause is inferred: 2 of 3 runs failed before the change and 3 of 3 passed after it, with two more bars in the same change. The Clock Tower failure (`walk to trough`) is not addressed here.

### 9.6 Rival repos and published scripts

No public source was found for any top-15 hiscore name (202 names checked as GitHub logins; code search on the 18 most unique names). The items below are public tools and write-ups.

| Claim | Source | Check | Our row | Decision |
|---|---|---|---|---|
| Two rats 2 ticks apart give a Woodcutting roll every 2 ticks at the south Falador oaks | [Lost City Labs](https://www.lostcitylabs.com/skillrates) (another server), rs2b0t issue 160 | Rejected for this server: both rats are penned at x 3014-3020, z 3282-3296, and with every door open their 17-tile maxrange reaches 0 multiway tiles (`gathering-tricks.md`, flinch section) | `woodcut` 3,356 / 3,467 against the 3,152 board | reject; knife 3-tick stays |
| Edgeville monkey bars train Agility 15-52 at about 54 XP per tick | rs2b0t PR 492 (another server) | Confirmed: 500 XP a crossing at 25x (`shortcuts.rs2:193`), no fall on this loc. Rate not measured here | `agility-52` 33 XP per tick | candidate: three practice runs; earth warriors and spiders are near |
| Legends Guild mine has iron rocks for 4-tick mining | Lost City Labs | Map scan: 11 rocks at 2691-2715,3328-3334. Tick pattern and stand tiles not checked | `mine` 120 / 97 | site option beside the zoo |
| Deposit, withdraw, close and use can go in one pass at predicted slots | rs2b0t PR 874 (open) | Confirmed by reading `InvButtonHandler.ts:58` | Prayer 6 bank ticks a trip | low: 20-54 ticks on two boards (ESTIMATE) |
| Hero's Quest and Legends' Quest modules with live harnesses | [rs2b2t/rs2b0t](https://github.com/rs2b2t/rs2b0t) `8b7db422` (MIT) `src/bot/api/ai/quests/defs/heroquest/`, `defs/legends/` | Folders confirmed. Harnesses seed varps; no pass record seen | no script | second source for the ports |
| A quest list takes only canary-passed quests; `noteProgress` against `showIntent` stall handling | [jackgolding/rs-sdk](https://github.com/jackgolding/rs-sdk) (MIT) branch `quest/demon` `quest-lab/` | Not checked | quest sweep | idea only |

Checked with no gain: rs2b0t's 76 scripts for Magic, Thieving, Runecraft and Smithing; all 17 UberMouse training pages against our rows, where only 4-rock iron is higher and already recorded; questbench `src/save/` against our save library. Do not open `jabobster/jabobster-rs-sdk` `bots/localman1/bot.env`: it is a committed credential file.

### 9.7 Projects found by web search

Web search found these repos; GitHub search had missed them. Checked with `gh api` and page reads. None holds a route or rate that beats a row of ours. No downloaded code was run.

| Source (license, last push) | What it holds | Decision | Gap |
|---|---|---|---|
| [Acquiredl/rs-sdk](https://github.com/Acquiredl/rs-sdk) (MIT, branch `acquiredl`) | Scripts for early quests, per-area quest fact sheets (`bots/acquiredl/quests/facts/`), run logs (`runs-*.jsonl`), `plans/guild-funnel.md`, ADRs | reject for scripts: we hold these quests; read a fact sheet if one of those quests fails | fact sheets and plans not read |
| [CornThatLefty/OSRSBot](https://github.com/CornThatLefty/OSRSBot) (MIT) | An LLM agent loop on any OpenRouter model, a dashboard, model benchmarks | reject: no game routes; we use subscriptions, not paid APIs | source not read |
| [ken12321/rs-sdk](https://github.com/ken12321/rs-sdk) (MIT, 3 commits ahead) | `bots/_shared/` helpers, `learnings/problems.md` | lead: read `learnings/problems.md` | not read |
| [Kudretg/rs-sdk](https://github.com/Kudretg/rs-sdk) (MIT, 1 commit ahead) | A change to `LoginThread.ts` and `server/PATCHES.md` | lead: compare with upstream login changes | not read |
| [oldschoola/rs-sdk-fleet](https://github.com/oldschoola/rs-sdk-fleet) (no license) | A fork of TestingPurposes/rs-sdk-fleet | reject: rs-stun-toolkit is the MIT source | none |
| [2004sp/2004sp-progressive](https://github.com/2004sp/2004sp-progressive) (no license) | Engine-side bots in a single-player server; the README describes door and toll handling | ideas only: bots run in the engine, not through a client | source not read |
| [99-cooking/rs-sdk](https://github.com/99-cooking/rs-sdk) (MIT) | A separate 25x server, loot.xyz, with its own hiscores | reject: another server, last push in March | none |
| [MaxBittker/runebench](https://github.com/MaxBittker/runebench) (no license found) | Team tasks not in `research/runebench-and-harbor.md`: smith team, dragon team, Arrav duo, with watchers and a kill ledger | ideas only: team coordination tests | source not read |
| [gr8monk3ys/rs-sdk](https://github.com/gr8monk3ys/rs-sdk), Milbaxter/rs-sdk | gr8monk3ys is 0 commits ahead; Milbaxter's compare returned 404 | reject gr8monk3ys; Milbaxter not checked | Milbaxter branches |

Other leads:

- HN user `_vertigo` reports that Claude plays through to Legends' Quest with code it wrote under coaching ([Agents in the Wild case 524](https://agentsinthewildai.com/cases/524-coached-for-hours-claude-now-plays-2004scape-fully-on-its-ow/), unverified). No repo is named.
- The [RuneScape Bench talk transcript](https://delve.town/profile/did:plc:wmhp7mubpgafjggwvaxeozmu/post/3my3qbw3ifk2k) says the server has 2,000 slots, and that its owner is working out how to share them. A slot limit can affect fleet size. Not checked against live behaviour.
- The rs-sdk Discord is linked from the upstream README and was not read.
- The public `worldfeed` is already used by `packages/dashboard/server.ts` and `research/leader-forensics.md`.

### 9.8 Forums, guides and rate sites

No new XP-per-tick method was found for Magic, Thieving, Runecraft, Smithing, Mining or Woodcutting. Sources repeat 12 methods we hold. Gains below are code reads and ESTIMATES; nothing here was run.

| Claim | Source | Check | Our row | Decision |
|---|---|---|---|---|
| Legends' Quest gives four training picks of 7,650 XP, and one skill can take all four: 191,250 XP a pick at 25x, 765,000 in total | [LostHQ guide](https://2004.losthq.rs/?oldurl=&p=questguides&quest=legends) | Confirmed: `quest_legends/scripts/radimus_erkle.rs2:79-122` has `stat_advance($skill, 76500)` and no repeat check | none in `haggis-boards.json` | candidate for Haggis: ESTIMATE about 3,880 ticks on Agility or 1,650 on Thieving; the quest chain cost is not priced |
| Eating inside a stun costs 3 ticks per eat | [Autumn Elegy guide](https://www.youtube.com/watch?v=2QYqNvLwB1g) | Confirmed: `consume.rs2:129-130`. Fits the measured `EATSTUN` loss | `thieving60.ts` eats inside the stun on the live route | done in `thieving60.ts`. MEASURED practice, 3 matched pairs, Thieving 55-80, 10 HP: 15.33 non-pick ticks per stun with the old timing (2,711 ticks, 128 stuns) and 14.86 with the new (2,781 ticks, 140 stuns). The run ranges overlap, so the gain is not proven; evidence `.practice/eat-timing/runs.log` |
| The stun cycle is 11 ticks, not the fitted 12.8 | Same guide, corrected by a code read | Not measured: `thieving.rs2:49-50` sets an 8-tick stun; the T+3 start is from reading `p_delay(0)` calls | F=12.8, 55-99 model 2,061 ticks | not supported: the matched runs above show about 15 non-pick ticks per stun, including dropped clicks and eats |
| A knight can be trapped in the north-east market house | Same guide | Partly: `Npc.ts:730` has a 500-tick stuck counter; house and spawn not checked | 611 `walkTicks` on the live 6,169 run | lead for the live route |
| Running is free, so the Runecraft walking trip is shorter | Forum threads [6748](https://lostcity.rs/t/whats-the-stance-on-the-old-journal-infinite-run-energy-exploit/6748), [17237](https://lostcity.rs/t/energy-stalls-with-ring-of-dueling-etc/17237) | `NODE_INFINITE_RUN` defaults true (`Environment.ts:47`); agility runs show `energyMin=100`; live config not verified | `runecraft-ladder.md` assumes a 150-tick walk and 8 helpers | check the ladder: ESTIMATE an 82-tick trip and 5 helpers; no board ticks |
| A 3-tick willow cycle with one farmer | [Lost City Labs](https://www.lostcitylabs.com/skillrates) (another server) | Partly: roll pattern holds if the NPC attacks every 6 ticks; farmer attackrate not read | `woodcut` 3,356 | low: no XP gain over the knife |

Wrong or absent, do not use: double rolls on moving up to a rock (`Player.ts:1405`), 2-tick eating (`consume.rs2:38`), granite and sandstone (no `mine.dbrow` rows). Not reached: 2004tracker.xyz, the 4-tick mining video (no transcript). No RS2 speedrun records were found.

### 9.9 Second web round and leftover repos

**`bleugreen/rs-sdk` returns 404** through the API and a direct fetch, so the links to it in `research/botting-ecosystem-2026-10-23.md` fail. Web search still indexes its pull request titles and summaries. These are indexed text, not read source:

| Indexed item | What it says | Our use |
|---|---|---|
| PR 102, 79, 76 (`competitors.md`) | A hiscore row stores the tick a level was reached and is published at a clean logout; four early stun accounts show logout values, so those are upper bounds. The rivals' edge was composition, not per-skill speed | check against `research/board-ranking.md` |
| PR 102 | After a dropped client the character stays 500 ticks if the socket closed, 1,000 if it stays open but silent, and indefinitely while a live client sends keepalives | check against our session recovery |
| PR 188 | Smithing 1 to 99 in 1,028 lab ticks with a `swap()` trade helper | compare with `smith` rows; lab figure, not a board time |
| PR 72 | Fastest routes to 99 for Agility, Mining, Woodcutting, Fishing and Thieving (title only) | lead |
| PR 519, 56 | A tick audit of runner, hand-off, walker, dialogue and relog costs; an engine sweep of packet budget and delay matrix | lead |
| PR 708, 483 | Attempt 5 measured table and the final row, 35,787 against a 35,467.4 expected value | already in `research/rival-rune-fast.md` where cited |

Other forks: singulocity/rs-sdk (MIT, 2 commits ahead) adds a spectator feed with live inventory, skills and ground items. Kimmo3223 and CakeRepository are 0 ahead. `elizaOS/eliza-2004scape` and `meisenheimere/rs-sdk` return 404. No Reddit thread, dev log or second rival write-up was found.

Leftover repos, checked against the pinned code unless marked:

| Claim | Source | Check | Decision |
|---|---|---|---|
| The quest journal shows the stage of varps the client never receives, so a script can resume after a stop | Toolkit `legs/qp/journal.ts` (MIT), jackgolding `quest-lab/journal-reader.ts` (MIT) | Confirmed for one quest: `cog_journal.rs2:1-4` builds text from `~get_cog_progress`; general rule not checked | candidate: `q.journal(key)` in `quest-lib.ts`, then resume in the longest quests |
| `walkLeg` keeps a 15-tile stuck-door radius, which opens unrelated gates | barthuijgen `15c444f2` (MIT) | Confirmed in `sdk/actions.ts:1143,1152`; `walkPath` is safe | low: patch to radius 3 if a walk shows it |
| An item-swap loop looks like progress to `stalled()` | lc-headless (no license, idea only) | Confirmed by reading `ledger.ts:83` | low |
| `route:false` interacts "silently drop" at range | jackgolding `4e1f8348` | Partly wrong: the server walks straight at the NPC (`Player.ts:1184-1199`) and reports "I can't reach that!" at an obstacle | do not port |
| Priest in Peril can strand an account on temple level 2 | jackgolding `b1ca8a61` (MIT) | Not checked | low: read if that quest fails |

Clock Tower `walk to trough`: gate 37 at 2595,9657 is `kind:"unknown"` in `knowledge/doors.json`, so the walker keeps it blocked after the lever opens it. A client-routed click to 2588,9656 passes it. Evidence: `quest_cog_gates_and_levers.rs2:38-42`, one swarm run `RESULT ok qp=1 ticks=454`. Gap: no three-run practice proof.

Do not copy: jackgolding `97cafdb9` says Aubury's teleport is ungated, but `essence_mine.rs2:2` needs Rune Mysteries. lc-headless says Scavvo does not restock, but the shop has `restock=yes`. No gain: Ghosts branches, LC-roadmap, bleugreenlab/cairn (BSL 1.1, no game planner).

Third web round: no copy of `bleugreen/rs-sdk` was found. `gh search code` returned no other repo, and the Wayback Machine has no snapshot of its `RUN-ORDER.md` or any path under the repo. `packages/planner/src/cairn-route.json` and `research/botting-ecosystem-2026-10-23.md` hold what we kept. New low-value items: [Ender's paladin journal](https://lostcity.rs/t/ender-s-paladin-journal-agent-shard/18746) (an agent's public log, combat about 90, 12 quest points), and RuneBench's `dragon-team-60m` task (ten bots on the King Black Dragon, with a kill ledger). No arXiv paper on rs-sdk was found.

### 9.10 GitHub census

Method: a script walked every fork of 12 root repos at every depth, read every branch not shared with its root, and compared each fork's content folders with upstream. Then 30 code searches and 22 repo and topic searches covered 1,336 repos. Result: 162 forks of rs-sdk, 108 repos with their own branches, 92 with content read. Forks are mostly old, so a rate there is not evidence for the current server. No board method beat a row of ours. No credential file was opened.

| Claim | Source | Check | Our state | Decision |
|---|---|---|---|---|
| A low-combat miner at the Lava Maze runite rocks (wild 46) can be attacked only by combat 49 or lower, and a pickaxe in the pack is enough | [GoonMachine/rs-sdk](https://github.com/GoonMachine/rs-sdk) `learnings/scarce-goods.md` `9091cd36` (MIT, branch `cloud/ab-a`) | Confirmed: `pvp_combat.rs2:34-41`; not run live. Only the account's own ores count | `boards-special.md` sends Haggis (combat 126) after every stamped board | owner decision: a new option for R1. ESTIMATE 8-14 days for 2,464 ores, uncontested |
| A fresh account stalls in Waterfall at 10 HP, with deaths in the Golrie cave and at White Wolf; Witch's House first gives 158,125 Hitpoints XP | GoonMachine `learnings/ab-results-a.md` `ba76979e` (MIT) | XP confirmed (`quest_priest.rs2:98`, `quest_vampire.rs2:42`, `quest_ball.rs2:202`); deaths are their log only | presets use every skill at 99 | add a low-level `waterfall.ts` preset before the Haggis rehearsal |
| Heroes' Guild runite rocks stand at 2937,9882 and 2941,9884 | GoonMachine `scarce-goods.md` | Confirmed: `m45_154.jm2`, `heroes_entrance.rs2:5`. These ores do not count on the board | no plan uses them | rehearsal site and ore income |
| 25 quest guides with journal progress rules, and 69 rows naming each `journal_script` | [acfrazier/274bot](https://github.com/acfrazier/274bot) `1aa74601` (MIT) `crates/script/paths/289/`, `crates/api/data/game-data/289/quests.json` | One rule confirmed (`cog_journal.rs2:39`); another content commit | no journal code in `quest-lib.ts` | rule data for the reader in 9.9 |
| Script-gated doors are marked `open` in `knowledge/doors.json` | [marcdubs/2004Scape-AP-Logic](https://github.com/marcdubs/2004Scape-AP-Logic) `3303025b` (MIT by file) `rs2004_logic.json` `gatedAreas` | Confirmed for `tbwt_bamboo_door` and the Mort Myre gate; `zanarisdoor` is a false positive | classifier in `packages/knowledge/src/doors.ts` | low: fix when a walk stops at one |
| `raw_lava_eel` has a source | Same file | Confirmed: `lavafish.rs2` | `knowledge/item-sources-gaps.md` lists none | low |
| A script can close the chat, wait, then open the next page | 274bot `docs/scripting/quest-guides.md` | Partly: `IF_CLOSE` then `p_delay` in 39 quest lines | `pagePending` covers text already arrived | low: only if a step ends early |
| A gift fails on a full pack; one unheld item fails the whole offer | GoonMachine `ab-results-b.md` | Partly: "Item not found" at `sdk/actions.ts:2276` | no space check in `fleet-trade.ts` | low: patch after a receipt shows it |

Discord sample: GoonMachine `learnings/discord-meta-2026-08-15.md` (MIT) is a read-only sample of the rs-sdk Discord: `general`, `99str-contest`, `agent-techniques`, `share-progress` and a `pk` search. Claims are third-party and graded there. Reports worth keeping:

- Quest-based combat bootstrap beat pure grinding; a level-3 Waterfall attempt needed a rat and food fallback.
- A four-bot LiteClient pilot used deterministic tick policies, no model call in the hot loop, and a 20-stun stop.
- `1G` used a full browser client for routes with ropes, trees and doors, and a thin client for combat loops.
- A geofenced defensive script guarded a rune rock area, and bots were killed on bank return routes.
- Two agents failed to coordinate Shield of Arrav until told to listen to the partner.
- Medium clues are scripted; hard clues still need help.

Do not copy: GoonMachine King of the Hill formations (replaced by Lava Maze runite upstream), its "no Grand Exchange" note (stale), and "a failed guard pickpocket makes the guard aggro" (the stun path does not). AP-Logic errors: Holy Grail needs `%arthur`, Shilo checks go to Crafting 20, Firemaking 30 is not a hard TBWT gate.

Nothing useful: jrpii/rs-sdk-temporal-planning (two toy tasks, no costs), msalmeida-boomer/runescaper, Dexploarer, saimdlx, nymph-ai, AuburyEssentian, Kimmo3223, Wgelyjr (5x server), jamie-legg, dlhg, maxwelllord/AgentPairRSBench, danmarkmann/runebench, skiller185 (README only), tristinhill26-bit, abuaboud/MoRS (modern OSRS), RecoX/aobench, skulltrick/lclite, DataHoarder6/2004lite, owendirk/runelite-bot-sdk, nrylov/rs2011-ts, rbriphy, halogod35, reclear-io/llmref.

Two-rat flinch is rejected: both rats are penned at x 3014-3020, z 3282-3296, and no tile in their range is multiway (`research/gathering-tricks.md`).
