# Wider OSRS / RuneScape ecosystem: what we can reuse

Historical survey. For current reuse decisions, use the [project use map](project-use-map.md). Our target is pinned rev289; coordinates, mechanics and permissions require validation. Corrections from the 2026-10-26 source review: the RuneLite XP table is **not reusable as-is** here (`planner/src/curve.ts` uses exponent L/10, not L/7); use `vendor/rs-sdk/server/content`, not the standalone rev274 clone. Abortable actions and bounded walking already exist. Old import rankings, client-status claims and categorical dismissals below are not current work orders.

Date: 2026-10-22. Scope: projects outside rs-sdk / runebench (covered elsewhere) that can give a TypeScript, 2004-era (LostCity build 274, Nov 2004) agent harness ideas, algorithms, data, or code. Antiban and humanization are out of scope.

Method: `gh api repos/<x>` for stars, license, and last push (all numbers read on 2026-10-22). Raw-file reads of READMEs and sample data files. WebSearch and Exa for research projects. Nothing was cloned.

Evidence tags:
- **[seen]**: I read the file, README, or API response myself.
- **[meta]**: only the GitHub metadata was checked.
- **[unverified]**: from memory or a third-party summary. Check before you rely on it.

License key for code reuse into our (presumably MIT-compatible) harness:
- **OK**: MIT, BSD-2, ISC, Apache-2.0. Copy with attribution.
- **COPYLEFT**: GPL-3.0, AGPL-3.0. Ideas and facts only, unless we accept copyleft. Plain facts (coordinates, IDs, rates) are generally not copyrightable, but the expression and compilation can be. Treat bulk dumps with care.
- **NONE**: no license file, so all rights are reserved by default. Ideas only.
- **CLOSED**: closed source. Ideas only.
- **CC BY-NC-SA**: OSRS Wiki content. Non-commercial, share-alike, attribution required.

## 0. Key facts that frame everything

1. **Coordinates transfer, IDs do not.** OSRS and RS2-2004 share the same world tile coordinate system (for example, Lumbridge castle stairs at 3222,3218 in Microbot's route table match the RS2 layout). Object, NPC, and item IDs come from different caches (OSRS build 1+ vs RS2 build 274), so every OSRS ID needs remapping, usually by name plus location. [seen: coords in Microbot/Shortest Path files; ID divergence is general knowledge, unverified per-ID]
2. **The OSRS world is a superset with gaps.** It has many post-2004 additions: Grand Exchange (2007), fairy rings, spirit trees, gnome gliders (most), POH, Zeah, Varlamore, minigames. It also has OSRS-only rebalances (drop tables, XP rates, shops). Any OSRS data must be filtered to what existed in Nov 2004.
3. **The best 2004-accurate data is already vendored.** `vendor/lostcity-content/scripts/` holds `doors/`, `ladders+stairs/`, `drop tables/`, `shop/`, `quests/`, `areas/`, `skill_*`, and more, as RuneScript (MIT) [seen: directory listing]. External OSRS projects give us **schemas, algorithms, and API shapes**. The data itself should be regenerated from LostCity Content.
4. **OpenRS2 archive has genuine 2004 caches.** The earliest RS2 build is 243 (2004-06-21). **Build 274 is cache id 922 (2004-11-25)**, which matches LostCity's `-b 274` branch. Others: 244, 245, 252, 254, 270, 289 [seen: `archive.openrs2.org/caches.json`]. Use these to cross-check maps and collision against LostCity.

## 1. Bot frameworks and script APIs

### 1.1 Microbot (chsami/Microbot): the most relevant single project
- URL: https://github.com/chsami/Microbot. 208 stars, **BSD-2-Clause (OK)**, pushed 2026-10-21. RuneLite fork. [meta+seen]
- It has become an **LLM-agent-first bot framework**. The repo carries `AGENTS.md`, `CLAUDE.MD`, `.claude/skills/debug`, `docs/AGENTIC_TESTING_LOOP.md`, `docs/AGENT_SERVER.md`, `docs/AGENT_SCRIPT_TOOLS.md`, `docs/F2P_WEBWALKER_HARNESS.md`, and a `microbot-cli`. [seen]
- Reusable ideas [seen]:
  - **Agent Server**: localhost HTTP (port 8081, or a UDS socket) with handlers per domain: Bank, Dialogue, GroundItem, Inventory, Npc, Object, Login, QuestHelper, Screenshot, Script, ScriptHeartbeat, DynamicScriptDeploy, StateMachineDebug. The same split by domain fits an MCP tool surface.
  - **StateMachineScript<S extends Enum>**: guarded transitions built as `Transition.from(S).when(supplier,"expr").because("reason").goTo(S)`. Transitions are evaluated top-down each tick, and the first match fires. Guards must be pure. Every transition logs its reason and is exposed at `GET /statemachine/{script}`. Their doc states the rationale: "agent-generated scripts: a structured schema is easier for LLMs than ad-hoc loops." **Port this pattern directly to TS.**
  - **Condition-wait helpers** (`util/Global.java`): `sleepUntil(cond, timeout)`, `sleepUntil(cond, action, timeout, poll)` (retry action until cond), `sleepUntilTrue(cond, resetCond, poll, timeout)` (extends the timeout while resetCond holds, for example while still animating), `sleepUntilNotNull(callable)`, `sleepUntilNextTick()`. The tick-aware variants and the "reset condition" variant are worth copying.
  - **Agentic testing loop**: JVM flags `microbot.test.mode/script/timeout/output` produce `result.json` plus screenshots plus logs. The agent then builds, launches, reads, fixes, and repeats.
  - **Web-walker regression harness**: fixed route table F2P-01..F2P-17 (from/to tile, coverage note: stairs/plane change, bridge, Draynor Manor door, sewers). Run fail-fast, rerun only the failed leg. **Most routes are valid in 2004.** F2P-10/11 use the Grand Exchange, which did not exist yet, so replace them.
  - `util/` package list (bank, depositbox, dialogues, equipment, grounditem, inventory, magic, npc, combat, walker...) is a good checklist of the "verbs" a high-level API needs. Also see `api/QUERYABLE_API.md` (queryable entity caches).
- Fit: **High** (design and ideas; Java code not directly portable).

### 1.2 OpenOSRS (open-osrs/runelite, open-osrs/plugins)
- runelite fork: 327 stars, BSD-2, **archived**, last push 2023-03-04. Plugins: 43 stars, **GPL-3.0**, 2022-08-06. [meta]
- Historical only. Its injected-API design is superseded by Microbot. Fit: **Low**.

### 1.3 OsrsBot (OSRSB/OsrsBot)
- 167 stars, **GPL-3.0 (COPYLEFT)**, pushed 2025-02-07. "RuneLite bot automation extension API". [meta]
- RSBot-style method contexts (inventory/bank/walking). Ideas only. Fit: **Low-Medium**.

### 1.4 Closed-source clients: API design ideas only (CLOSED) [unverified unless noted]
- **DreamBot**: `TaskScript` + `TaskNode` (`accept()` / `execute()` / `priority()`), and community Tree-Branch-Leaf frameworks (the `Bonfire/DreamBot-Delayed-TBL` link was in search results but now 404s). Pattern: a priority list of guard+action nodes, which is close to Microbot's transitions.
- **RuneMate**: `LoopingBot`, `TaskBot` (Task.validate/execute), `TreeBot` (BranchTask with `validate()` → success/failure child, LeafTask executes). This is a binary decision tree re-evaluated from the root every loop. Community hybrid: `matteblackcodes/TaskMachine` (0 stars, NONE, Kotlin, "hybrid State Machine/TaskBot") [meta+seen README].
- **TRiBot**: Script SDK with query builders, `Waiting.waitUntil`, and a global walker (DaxWalker originated here). Doc search failed, so this is unverified.
- **OSBot / PowBot**: similar Script/loop APIs. `PTYB/OpenQuester` (6 stars, **AGPL-3.0**, archived 2022) is an open quest-completion script for PowBot. It is an example of encoding quests as step sequences [meta].
- Takeaway common to all of them: (a) **re-evaluate a priority-ordered guard list from scratch each loop**, which is robust to interruptions; (b) **query builders** (`npcs().name("Cow").within(10).nearest()`); (c) **blocking wait-until with timeout**; (d) **bank/inventory DSL** (`withdraw(item, qty)`, `depositAllExcept(...)`, `contains(...)`). Fit: **High** as API design, zero code.

### 1.5 Script collections (DreamBot/OSBot/TriBot/RuneMate repos on GitHub)
- Examples: `Nezzima/DreamBot` (11 stars), `viktorstiunovs/osrs-dreambot-scripts` (7), `DerkSchooltink/runemate-bots` (14, Kotlin), `Krulvis/powbot-scripts-public` (3). **All NONE license** [meta]. Small, stale, and tied to the client API. Fit: **Low**. Skim at most for per-skill loop logic (for example, a woodcutting bank loop).

## 2. RuneLite and plugins

All below are **BSD-2-Clause (OK)** unless noted.

| Project | Stars / push | What to reuse | 2004 fit |
|---|---|---|---|
| runelite/runelite | 5499 / 2026-10-21 | `runelite-api/.../Experience.java` (XP table; the formula is unchanged since RS2, so reusable as-is); `CollisionDataFlag.java` (flag bit layout; RS2 uses the same scheme, verify against LostCity); `plugins/mining/Rock.java` (respawn timings; OSRS values); `plugins/worldmap/*Location.java` (mining sites with rock counts, fishing spots, agility courses, dungeons: a seed list of POIs); `plugins/agility/Obstacles.java` (obstacle IDs; OSRS IDs); `xptracker` (XP/hr and time-to-level logic) [seen paths] | Medium. Logic yes, IDs no. |
| Skretzo/shortest-path | 35 / 2026-10-20 | See section 3.1. Transport TSV schema and data, collision-map.zip, destination lists (bank.tsv, altar.tsv, anvil.tsv) [seen] | **High** (schema), Medium (data) |
| Zoinkwiz/quest-helper | 312 / 2026-10-18 | 191 quest dirs. Typed step model: `NpcStep`, `ObjectStep`, `ItemStep`, `DigStep`, `EmoteStep`, `ConditionalStep`, `OwnerStep`, `PuzzleStep`. Requirements: `ItemRequirement` (with alternates, `canBeObtainedDuringQuest`, `setConditionToHide`), `ZoneRequirement(Zone(WorldPoint,WorldPoint))`, `VarbitRequirement`, `DialogRequirement("exact dialog text")` [seen CooksAssistant.java] | **High** as a schema for a quest DSL. The F2P 2004 quests exist here. Map varbits to LostCity varps. |
| weirdgloop/WikiSync | 12 / 2026-03-26 | Server-driven manifest of which varbits/varps to sync. Pattern: the remote decides what state to read [seen README] | Low |
| runelite/plugin-hub | 399 / 2026-10-22 | Index of about 1000+ third-party plugins; each plugin has its own license (count unverified) | Low (discovery only) |
| Ground Items / NPC Indicators | inside runelite | Highlight/value filtering logic. Trivial for us, since we read state directly | Low |
| Sleepywalker69/OSRS-MCP-Companion | 4 / 2026-06-09 | RuneLite plugin exposing a local HTTP API plus an MCP server [meta] | Low-Medium (MCP tool naming ideas) |
| nickbeddows-ctrl/osrs-mcp-plugin | 2 / 2026-04-15 | Same idea [meta] | Low |
| ShakyPizza/osrs-mcp | 1 / 2026-04-10, NONE | MCP: screen vision plus RuneLite HTTP plus wiki lookup plus GE prices plus XP planning tools [seen README] | Low (tool list ideas) |

## 3. Pathfinding and world data

### 3.1 Skretzo Shortest Path: transport table schema (recommended to copy)
- [seen] `src/main/resources/transports/*.tsv`: `transports.tsv` (6190 lines: doors, gates, stairs, ladders), `ships.tsv`, `charter_ships.tsv`, `boats.tsv`, `canoes.tsv`, `minecarts.tsv`, `agility_shortcuts.tsv`, `teleportation_spells.tsv`, `teleportation_items.tsv`, `teleportation_levers.tsv`, `wilderness_obelisks.tsv`, `magic_carpets.tsv`, `gnome_gliders.tsv`, `spirit_trees.tsv`, `fairy_rings.tsv`, plus `teleport_restrictions.tsv`, `collision-map.zip`, `routing-cuts.bin`.
- Row schema (transports.tsv): `Origin(x y plane) | Destination | "menuOption menuTarget objectID" | Skills | Items | Quests | Varbits | VarPlayers | Duration(ticks) | Display info`. Example: `3097 3107 0  3098 3107 0  Open Door 9398 ... 1`. Ships: `3029 3217 0 → 2956 3146 0 "Musa Point Captain Tobias 14979" COINS=30 dur 10`. Spells: `3213 3424 0  AIR_RUNE=3&&FIRE_RUNE=1&&LAW_RUNE=1  25 Magic  dur 4  wildy-level 20`.
- 2004 fit: **schema high, data medium**. Coordinates for doors, stairs, ships (Port Sarim–Karamja, Musa Point), levers, obelisks, and spell destinations mostly hold. Object IDs, varbits, and many transports do not exist (fairy rings, spirit trees, quetzals, POH). **Plan:** adopt the TSV schema, then generate rows from `lostcity-content/scripts/ladders+stairs/` and `doors/`, using Skretzo's coordinates only as a cross-check.
- Microbot vendors a modified copy under `plugins/microbot/shortestpath/` (adds `Restriction`, `PurchasableItemCatalog`, ETA overlays) [seen paths].

### 3.2 rsmod pathfinder: already vendored
- `2004Scape/rsmod-pathfinder`: 1 star, **ISC (OK)**, 2024-10-26; npm `@2004scape/rsmod-pathfinder`, also a crate. "Ported from Kotlin: rsmod/rsmod engine/pathfinder." A BFS pathfinder with the game's exact rules [seen README]. This is what LostCity uses. Fit: **High**, already present in `vendor/rsmod-pathfinder`. Upstream `rsmod/rsmod`: 191 stars, ISC, pushed 2025-10-01 (OSRS emulator, Kotlin) [meta].

### 3.3 DaxWalker
- `itsdax/Runescape-Web-Walker-Engine`: 104 stars, **Apache-2.0 (OK)**, pushed 2026-03-11. A TriBot client [seen README].
- The path generation runs on **Dax's server** (needs API keys; the server code is not in the repo). The README says: Dijkstra for region limiting, A* for the path, teleports folded into the A* heuristic, wayports need Dijkstra, requirement filters (agility level, gold, quests), directed one-way nodes (Draynor Manor door), BFS path randomization, about 90% world coverage, <200 ms over about 10M tiles.
- Reuse: the **algorithm design** (hierarchical region graph plus tile A* plus transport edges with requirement predicates). The client code depends on the TriBot API. Fit: **Medium** (ideas).

### 3.4 Other pathfinders and map data
| Project | Meta | Notes | Fit |
|---|---|---|---|
| dQw4w9WgXcQ/osrs-pathfinder | 17 stars, NONE, 2026-05-19 | "Pathfinding REST service for OSRS" [meta]. Ideas only | Low |
| OlZe/osrs_pathfinder | 3 stars, NONE, 2024-01-18 | [meta] | Low |
| superptzl/AdvancedWalking | 0 stars, NONE, 2016 | Navmesh walker for TriBot. A navmesh is an alternative to tile BFS [meta+search] | Low |
| mejrs/mejrs.github.io | 31 stars, NONE, 2026-08-02 | "RuneScape Cartography": tiled map viewer with collision/transport overlays (unverified detail) | Low-Medium (viz ideas) |
| dennisdev/rs-map-viewer | 157 stars, BSD-2, 2026-08-03 | Historical-cache map viewer, already vendored. Can load OpenRS2 2004 caches (claim unverified) | Medium |
| Joshua-F/osrs-dumps, abextm/osrs-cache | 31 / 26 stars, NONE, both pushed 2026-10-20 | Text dumps of OSRS caches (configs, scripts). OSRS only | Low |
| OpenRS2 archive (archive.openrs2.org) | n/a | Caches as disk.zip / flat-file, keys JSON, map.png. **RS2 builds 243–274 for 2004 are present** [seen] | **High** for validating 2004 maps and collision |

## 4. Private-server engines

| Engine | Meta | Era / build | 2004-accurate data? | Fit |
|---|---|---|---|---|
| **LostCityRS Engine-TS / Content / Server** | Server 316 stars MIT 2026-07-08; Engine-TS 38 stars MIT 2026-09-30; Content 33 stars MIT 2026-10-18 | build 274 branch (Nov 2004) | **Yes, the reference.** RuneScript for doors, ladders, drop tables, shops, quests | Already vendored |
| 2004scape/Server (old org) | 387 stars, MIT, **archived**, "Moving to LostCityRS/Server" [meta] | 2004 | Superseded by LostCity | None |
| 2006-Scape/2006Scape | 245 stars, **GPL-3.0**, 2026-10-17 | 2006 (Java 8, PI-style) | Partly 2006. Quests and skills close to 2004 but not exact. Bundles Parabot bot support for local play [seen README] | Low-Medium (cross-check facts) |
| RuneJS/server | 300 stars, **GPL-3.0**, 2026-09-03 | **build 435 (Oct 2006)** [seen] | No. TypeScript, though, so its plugin/action-hook architecture is worth a read | Low-Medium (TS architecture ideas only) |
| apollo-rsps/apollo | 194 stars, ISC, 2023-05-18 | 377 by default (2005–06) [seen] | Little content | Low |
| rsmod/rsmod | 191 stars, ISC, 2025-10-01 | modern OSRS | No (OSRS) | Low (pathfinder already taken) |
| 2009scape (gitlab.com/2009scape/2009scape; mirror downthecrop/2009scape-mirror) | mirror 13 stars, **AGPL-3.0**, 2026-10-22 | build 530 (2009) (unverified) | Large content base, 2009-era. Has single-player builds and a bot system (unverified) | Low (copyleft, wrong era) |
| openrs2/openrs2 | 58 stars, ISC, 2026-09-05 | build 550 (late 2009) [seen] | No. The value is the cache archive and tooling | Medium (cache tools) |
| Open-RSC/Core-Framework | 287 stars, **AGPL-3.0**, 2026-10-18 | RuneScape Classic | Different game | None |
| Elvarg RSPS | not checked | OSRS-ish 317 | Base for two RL projects below | Low |
| Hyperion, Kronos | repos not found under the guessed names | — | **Unverified**, skip | — |

## 5. Data dumps and APIs

| Source | License | What | OSRS vs 2004 | Fit |
|---|---|---|---|---|
| OSRS Wiki MediaWiki API (`oldschool.runescape.wiki/api.php`) | **CC BY-NC-SA 3.0** [seen siteinfo] | Infoboxes, quick guides, transcripts (exact NPC dialogue, useful for `DialogRequirement`-style matching), Bucket queries (`action=bucket`; bucket `dropsline` exists, field names need checking) [seen] | OSRS. Many quests and dialogues are near-identical for 2004 F2P content. Drop rates and shops were rebalanced, so do not trust them for 2004 | Medium (knowledge files, with NC-SA attribution) |
| OSRS Wiki prices API (`prices.runescape.wiki/api/v1/osrs/latest`) | API terms; needs a descriptive User-Agent | OSRS GE prices [seen working] | Wrong economy: our server has its own GE and public market API | Schema ideas only; use our server's prices |
| osrsbox/osrsbox-db | 245 stars, **GPL-3.0**, last push 2022-08-07 | Items (27+ props), monsters (44 props plus drops), prayers | OSRS, stale | Low |
| 0xNeffarion/osrsreboxed-db | 56 stars, **GPL-3.0**, 2025-01-07 | Maintained fork; PyPI `osrsreboxed` plus REST [seen README] | OSRS | Low (schema ideas for item/monster JSON) |
| osrs-wiki/cache-mediawiki | 2 stars, GPL-3.0, 2026-10-01 | Cache → wiki content converters | OSRS | Low |
| RuneScape Classic / RS3 wikis | CC BY-NC-SA | `classic.runescape.wiki` (RSC), `runescape.wiki` (RS3, with some history pages) | Neither is RS2-2004 | Low |
| 2004-era fan sites (Tip.it, RuneHQ, Zybez) | copyright | Only through the Wayback Machine. No structured dump found | 2004-true but unstructured | Low (spot-check only) |
| XP table | formula (public) | `Experience.java` in RuneLite (BSD-2) | **Same in 2004** | High, trivial |
| LostCity Content `drop tables/`, `shop/` | MIT | Authoritative 2004 drops and shops | **2004-true** | **High**, parse into JSON |

No dedicated 2004scape/LostCity wiki was found by search (two queries). LostCity's own Discord or site may host one. Unverified.

## 6. AI / RL research on RuneScape

| Project | Meta | Method | Result | Reuse |
|---|---|---|---|---|
| Naton1/osrs-pvp-reinforcement-learning | 185 stars, **NONE**, 2024-02-11 | PPO plus self-play, PyTorch, Gym-style env. Java sim built on the Elvarg RSPS with a socket `RemoteEnvironmentServer` (login/logout/step/reset). Env action/obs **JSON contracts** shared by sim and trainer. YAML experiment configs [seen README via WebFetch and Exa] | Reported about 99% LMS win rate, #1 PvP Arena rank. Trained "5 years of game time" in simulation (Sythe post). Compute not stated | **Ideas: medium.** A gym-style step/reset socket on a headless server, plus JSON action/obs contracts. Our LostCity server is already headless and bot-only, so a fast-forward tick mode is the analogue |
| jordanbailey00/fight-caves-rl | 2 stars, NONE, 2026-06-24 | Deterministic C re-implementation of Fight Caves, PufferLib 4.0, 4096 parallel envs, about 1.9M steps/s, PPO plus MinGRU, W&B sweeps [Exa summary] | 94.9% peak Jad kill rate, 3B steps in about 26 min on one RTX 5070 Ti (self-reported) | Low for us. Lesson: RL works on narrow sub-tasks only with a purpose-built fast sim |
| Aivarass/sarsa-rsps-agent | 1 star, NONE, 2026-05-30 | SARSA with a tiny handwritten NN over an RSPS REST API. Behavioural-cloning warm start tried [Exa summary] | Avg reward 9.71/10 after 5000 fights. Learned "eat when low HP" | Low (toy). The BC warm-start finding: helps early, no gain later |
| "dreambot-ai" (lordbasilaiassistant-sudo) | **repo 404 now** | Hierarchical goal-conditioned RL, 93 discrete actions, 301-dim state, evolutionary search plus PPO, Java GameSim [Exa snapshot only] | Self-reported. Unverifiable | None (gone). Its action list is a decent checklist of macro-actions |
| Gavin29/osrs-ai-bot | **repo 404 now** | Screen-capture imitation learning plus OpenCV plus RL on Elvarg; DreamBot-style `BotContext` [Exa snapshot] | None reported | None |
| jrr97/runescape-ai | 9 stars, **MIT (OK)**, 2026-10-17 | Agent CLI → HTTP runtime → RuneMate gateway → RuneLite. **Routines are JSON graphs**: `inputs`/`outputs` schemas, `entry`, `nodes` of type `action`/`call`/`wait`/`return`, `$inputs.x` / `$nodes.n.field` references, per-node `retry {maxAttempts, backoffMs}`, `expectedRevision` (optimistic state check), reusable `components` (for example `survival.eat-if-needed`), plus a `method` block (xpPerHour range, supplies, recovery policy) [seen JSON] | No benchmark | **High.** A declarative, LLM-authorable routine format with retry and stale-state guards. MIT, so the schema can be copied |
| harmindersinghnijjar/RunescapeGPT | 28 stars, NONE, 2024-01-30 | GPT helps write bot scripts [meta] | — | Low |
| slyautomation/osrs_yolov5 (and v3/v8 forks) | 36 stars, NONE, 2024 | YOLO object detection of on-screen entities [meta] | — | None (we have structured state) |
| Lumbridge (samheutmaker/lumbridge-ai) | already vendored | rs-sdk fork for multi-agent | — | covered elsewhere |
| Academic papers | — | WebSearch and Exa found **no peer-reviewed RuneScape RL or LLM paper** (3 queries) | — | — |

Synthesis: every successful RS RL result targets a **narrow combat sub-task inside a custom fast simulator**. None does open-world progression. Open-world play by LLM agents (RuneBench, Microbot agent server, jrr97) uses **code or declarative routines over structured state**. That supports the rs-sdk approach. The reusable increments are: state machines with logged reasons, JSON routine graphs, regression route suites, and transport tables.

## 7. Recommendations by harness layer

1. **Navigation**: keep the vendored rsmod BFS for tile paths. Add a **transport edge layer** in Skretzo's TSV schema (origin, destination, menu option/target/loc, skill/item/quest requirements, duration), generated from LostCity `doors/` and `ladders+stairs/` scripts. Add a Dax-style region graph only if long routes get slow.
2. **Behaviour structure**: offer a TS `StateMachine<S>` with guarded, reasoned, logged transitions (Microbot), and a priority guard list re-evaluated every loop (DreamBot/RuneMate pattern). Expose the current state and last transition reason to the agent through MCP.
3. **Waits**: `waitUntil(cond, {timeoutTicks, pollTicks, extendWhile})`, `waitTicks(n)`, `retryUntil(action, cond)`, all tick-based, not ms-based.
4. **Routines**: a JSON routine/component format (jrr97) for agent-authored, reusable, retry-aware procedures. `expectedRevision` maps to an rs-sdk state-sequence number.
5. **Quests**: a quest DSL modelled on Quest Helper's step and requirement types. Fill it from LostCity `quests/` scripts plus wiki quick-guides (NC-SA).
6. **Testing**: a fixed route regression suite (Microbot F2P-01..17, with the GE legs replaced) and a fail-fast runner that reruns single legs. Also a test mode that writes `result.json`.
7. **Data**: parse LostCity `drop tables/` and `shop/` into JSON for the knowledge folder. Use the OSRS Wiki only for prose and dialogue, never for 2004 rates.

## 8. Top 10 to pull in (ranked)

| # | Item | URL | License | What to pull | Form | 2004 fit |
|---|---|---|---|---|---|---|
| 1 | LostCity Content scripts (doors, ladders+stairs, drop tables, shop, quests) | github.com/LostCityRS/Content (vendored) | MIT | Parse into transport TSV plus drops/shops/quest JSON | Code + data | **High** (authoritative) |
| 2 | Skretzo Shortest Path transport schema | github.com/Skretzo/shortest-path | BSD-2 | TSV column schema plus requirement grammar (`ITEM=n&&...`, skills, quests, duration). Coordinates as a cross-check | Schema, some data | High schema / Med data |
| 3 | Microbot StateMachineScript plus Transition builder | github.com/chsami/Microbot (`plugins/microbot/statemachine`) | BSD-2 | Port to TS: pure guards, `because()` reasons, snapshot endpoint | Design / port | High |
| 4 | Microbot wait helpers (`Global.java`) | same, `util/Global.java` | BSD-2 | `sleepUntil` with action/reset-condition/next-tick variants, made tick-based | Port | High |
| 5 | jrr97 JSON routine graph format | github.com/jrr97/runescape-ai (`agent/routines`, `agent/components`) | MIT | Routine/component schema with retry, refs, `expectedRevision`, `method` metadata | Schema copy | High |
| 6 | Microbot web-walker regression harness plus route table | Microbot `docs/F2P_WEBWALKER_HARNESS.md` | BSD-2 | Route list (minus GE), fail-fast runner, single-leg rerun, `result.json` | Ideas + data | High |
| 7 | Quest Helper step/requirement model | github.com/Zoinkwiz/quest-helper | BSD-2 | NpcStep/ObjectStep/ItemStep/ConditionalStep, ItemRequirement (alternates, obtainable-during-quest), ZoneRequirement, DialogRequirement | Schema; F2P quest step data as a cross-check | High (schema) |
| 8 | OpenRS2 build-274 cache (id 922) and builds 243–289 | archive.openrs2.org | archive terms; Jagex data | Validate LostCity collision/maps; render with rs-map-viewer | Data | High |
| 9 | Microbot Agent Server / CLI surface | Microbot `docs/AGENT_SERVER.md`, `AGENT_SCRIPT_TOOLS.md` | BSD-2 | Observe/act tool split, heartbeat/stall detection, dynamic script deploy, screenshot-on-fail | Design | Medium-High |
| 10 | DaxWalker algorithm notes plus Naton1 gym-socket design | github.com/itsdax/Runescape-Web-Walker-Engine ; github.com/Naton1/osrs-pvp-reinforcement-learning | Apache-2.0 ; NONE | Hierarchical Dijkstra+A* with requirement-filtered transport edges; step/reset socket plus JSON action/obs contracts for any later RL on sub-tasks | Ideas | Medium |

Not recommended: OSRS item/monster DBs (GPL, wrong era), external OSRS GE prices (different economy; our GE is authorized), YOLO/vision bots (we have structured state), 2009scape/Open-RSC/2006Scape code (copyleft and wrong era), closed clients beyond their API shapes.

## Open items
- Hyperion and Kronos repo locations not found. Skipped.
- DreamBot, RuneMate, and TriBot doc pages were not reachable or not found (dreambot.org DNS failed). Their API descriptions in section 1.4 are from memory.
- 2009scape license is from the mirror metadata (AGPL-3.0). The GitLab LICENSE file was not read.
- Exa-only projects (dreambot-ai, Gavin29) now 404. Their claims cannot be checked.
