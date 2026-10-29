> Current authority: all gameplay techniques are authorized. Wine, cocktails, pyre oil, Charge, relogs and tick manipulation need no further approval. Missing supplies create acquisition work, never a route exclusion. See [AGENTS.md](../AGENTS.md).

# Botting ecosystem survey: code and data we can reuse

Current cross-survey decisions: [project use map](project-use-map.md). The dated rankings below are evidence history, not an implementation queue.

Scope: RS2 (2004) and OSRS bot clients, script repos, walkers, RuneLite tick plugins, RS2 server and client
projects, headless clients and simulators, data dumps, AI projects, and other rs-sdk forks. This file extends
`research/wider-ecosystem.md` and `research/community-and-upstream.md`. It does not repeat their rows; it gives
new findings and re-checks license and activity.

Method: read-only. GitHub metadata and files came from `gh api` (repo, tree, contents, compare, commits) and
`raw.githubusercontent.com` read as text to stdout. `wiki/world.json` was streamed through `jq` and not saved.
Nothing was cloned, installed or run.

Evidence levels: **WEB** (a page or repo file read) unless a row says **CODE-READ** (we checked the claim
in our own `vendor/` or `knowledge/`). **UNVERIFIED** marks a claim we could not check.

## Main findings

**Decision filter (source inspection only).** The two supplied PDF surveys and linked repositories favour these existing paths; no framework migration is justified:

- [rs-sdk](https://github.com/MaxBittker/rs-sdk): dispatch is not server effect. Capture before/after item counts, ticks and outcome; start with farmer eating and linked supply costs.
- [Microbot](https://github.com/chsami/Microbot/blob/main/docs/ARCHITECTURE.md): per-tick entity snapshots, script lifecycle and blocker recovery. Reuse our session/wait/supervisor code; port only a proved missing behaviour.
- [LostCity Engine/Content](https://github.com/LostCityRS/Engine-TS): extract goal prerequisites and routes from matching pinned revisions. Maps/cache tools aid inspection, not proof of reachability. RuneScriptKt is rejected in favour of [RuneScriptTS](https://github.com/LostCityRS/RuneScriptTS).
- Fleet performance figures remain author claims; no license was reported. Practice simulation needs contention/recovery cases and later bounded live proof. Public LostCity, the modified demo and modern OSRS are distinct environments.

Archived OpenOSRS/Alter clients and WaspLib are historical references. RuneLite/plugin-hub offer module boundaries; Simba/SRL offer optional visual checks. Neither requires a second runtime. Recheck compatibility claims below before import. Wine and level-check techniques are authorized by the current owner decision. Next implementation and proof: [food-chain accounting](food-chain.md#cost-accounting).

1. **A rival speedrun team publishes its whole plan.** `bleugreen/rs-sdk` (MIT, 656 commits
   ahead of upstream) has a `speedrun/` package and `docs/speedrun/` with a run order, a step manifest, helper
   playbooks, quest notes, competitor forensics and a measured engine sweep. Its expected run is 38,742 ticks
   (best case 31,324), against stunbaron's 35,916. It names the techniques it uses: wine without a level check,
   Charge without a cooldown, dialogue bursts, knife-on-log tick manipulation, five-packet interleaving.
   It is the highest-value find in this survey. https://github.com/bleugreen/rs-sdk/blob/main/docs/speedrun/research/competitors/public-code.md
2. **UberMouse's world index is valid for our content.** The fork is MIT. `world.json` was built from content
   commit `fb264971`, and upstream has not changed `server/content` since. Our vendor HEAD is
   `b565f2d9`, and the compare `b565f2d9...main` shows 0 content files (CODE-READ + WEB). The
   reach sets, nearest-bank run ticks and the crossing tables are things our `knowledge/*.json` does not have.
3. **UberMouse's floor model agrees with our measurements** where both exist (section "Floor model check").
   Our measured guard and knight rates are 87% and 93% of its floor; its iron floor matches our 3-rock cap
   formula.
4. **A browserless fleet client exists, but with no license.** `TestingPurposes/rs-sdk-fleet` reports 0.73 MB
   per bot and about 1,800 bots on one 32 GB PC, plus an offline simulator that runs real bot code against a
   ported engine. No license file, so ideas only.
5. **Commercial OSRS clients are mostly gone.** Blogs report that Storm closed and TriBot, PowBot and Inubot
   stopped sales in July 2026; DreamBot still runs (UNVERIFIED, blog sources only). None of them is useful to
   us: they target OSRS through client injection, and their code is closed.

## Ranked table (reuse value for Haggis rank 1 on all 24 boards)

| # | Candidate | License | Lang | What we reuse | Saves us | Risk |
|---|---|---|---|---|---|---|
| 1 | [bleugreen/rs-sdk](https://github.com/bleugreen/rs-sdk) `speedrun/`, `docs/speedrun/` | MIT (file: "Copyright (c) 2025 Lost City") | TS | Run order and leg ticks, helper playbooks (wine, bones, runes, cannon, mule, staging), quest notes for about 35 quests, engine sweep top ten (measured), hiscore stamp forensics, fast send layer (`lib/wait.ts`, `bank.ts`, `trade.ts`, `converse.ts`, `levelup.ts`, `runner/budget.ts`) | Very high: weeks of measurement on the same server and goal | Rival team; content can change or vanish. Some techniques may be "real exploits" under owner rule (owner decision O3). Low code risk if read only |
| 2 | [UberMouse/rs-sdk](https://github.com/UberMouse/rs-sdk) `wiki/` | MIT | TS | `world.json` (reach, nearest bank, connectors, gates, crossings, transports, npc spawn clusters), floor model `wiki/world/model/`, 40 scenario saves, save/kick endpoint `server/engine/src/web/pages/saves.ts` | High: a reach graph and per-site banks we do not have; a checked rate model | Low. A generated 7.7 MB file; pin by commit |
| 3 | [rs2b2t/rs2b0t](https://github.com/rs2b2t/rs2b0t) | MIT | TS | Quest modules (`decide(snapshot) -> step`) and about 22 `docs/decisions/quest-pitfalls-*.md` from live runs, rev 289 | Medium-high: bleugreen estimates 200-500 quest ticks (UNVERIFIED) | Low. Targets a different server (rs2b2t) on the same revision; README table says 289, repo description says 274 |
| 4 | [TestingPurposes/rs-sdk-fleet](https://github.com/TestingPurposes/rs-sdk-fleet) | NONE | TS | Ideas: browserless protocol client, offline simulator `headless/sim/`, navgrid notes ("send the per-tile path raw"), parallel "pyramid" gold merge | Medium-high as design input (our C2 memory problem, a faster simulator) | No license: copying code is not allowed. Rev 274 baseline |
| 5 | [Skretzo/shortest-path](https://github.com/Skretzo/shortest-path) | BSD-2-Clause | Java | Transport TSV schema (already recommended) | Medium | Low; OSRS coordinates differ |
| 6 | [chsami/Microbot](https://github.com/chsami/Microbot) | BSD-2-Clause | Java | State machine and wait helpers (already recommended) | Medium | Low; OSRS client code, port ideas only |
| 7 | [Zoinkwiz/quest-helper](https://github.com/Zoinkwiz/quest-helper) | BSD-2-Clause | Java | Quest step and requirement schema | Medium | Low; OSRS varbits |
| 8 | [markeljan/rs-sdk-dashboard](https://github.com/markeljan/rs-sdk-dashboard) | MIT | TS | Fleet dashboard for a 90-account rs-sdk fleet (per bleugreen) | Low-medium (our dashboard exists) | Low |
| 9 | [jrr97/runescape-ai](https://github.com/jrr97/runescape-ai) | MIT | TS | JSON routine graph schema (already recommended) | Low-medium | Low |
| 10 | [ineedbots/lc-headless](https://github.com/ineedbots/lc-headless) | NONE | C++ | Ideas: a C++ headless LostCity client | Reassessed below: current README and navigation test source saved | No root license found; runtime/compatibility unproved |

Below the top 10 (low value, kept for the record): RuneLite tick plugins, DaxWalker, Parabot, OsrsBot, 2006Scape,
Apollo, RSMod, RuneJS, OSRS data dumps, AI/RL projects. Notes follow.

## Per-candidate notes

### 1. bleugreen/rs-sdk (rival speedrun team)

- Repo: MIT, fork of MaxBittker/rs-sdk, 656 commits ahead, 9 behind (`gh api .../compare/main...bleugreen:rs-sdk:main`).
  Authors in the last 100 commits: bleugreen 95, "Cairn Agent" 5. It uses an agent coordinator ("cairn://p/rs/...").
- `speedrun/README.md` lists a fast layer over raw `sdk.send*`: tick-keyed waits; "fire, then confirm once"
  batching against the 5 USER events per tick; a `TickWindow` user-event budget per step; resumable runs from
  game state; a host gate for the "knife" in-page tick program; reconnect after outage; a demo restart detector.
  https://github.com/bleugreen/rs-sdk/blob/main/speedrun/README.md
- `docs/speedrun/RUN-ORDER.md` (890 KB): steps S00-S27 with labels m/r/i/e per tick figure; states the demo ticks at 400 ms. That agrees with our C2 settlement (399.8 ms).
  https://github.com/bleugreen/rs-sdk/blob/main/docs/speedrun/RUN-ORDER.md
- `docs/speedrun/research/engine-sweep.md` section 8, "Top ten, verified" (lab at `NODE_TICKRATE=300`, 3 samples):
  - Agility Arena ticket button: 5 presses landed in one tick, 140,000 base Agility; closed because tickets
    come one per 98-tick pillar move. Tickets cannot be traded.
  - Battlestaves: 5 per tick, 687.5 base XP per tick inside the burst; fallback when dragonstones are short.
  - Ugthanki kebab: 5 per tick at Cooking 37, 600 base per tick; the fallback if grapes run out.
  - Level-up dialogs do not stall a delay-free item-on-item burst: each OPHELDU closes the open chat and runs.
    Our `research/levelup-cost.md` says "item-on-item still runs with the dialog open": same result.
  - Refused USER events cost CLIENT slots (20 a tick), not USER slots (5) (`NetworkPlayer.ts:141-147`).
  - One make-X completion per tick; a second one in the same tick drops packets and loses the first product.
  - A raw sender that writes OPHELDU item ids blind could put 3 cuts in the bank tick (about 1 tick per cycle,
    inferred by them).
  https://github.com/bleugreen/rs-sdk/blob/main/docs/speedrun/research/engine-sweep.md
- `docs/speedrun/research/competitors.md`: the top 4 Overall accounts (stunbaron, stunhard, stunless, stunking)
  show 3 logout batches. stunbaron: 12,006 (Prayer, WC, Fishing, Mining), 17,697 (artisan skills, QP 13),
  35,916 (combat, Agility, Thieving, Runecraft, Magic, Cooking). Compare with our `research/leader-forensics.md`.
  https://github.com/bleugreen/rs-sdk/blob/main/docs/speedrun/research/competitors.md
- `public-code.md` searched 141 forks and says no account above them has published code. It names our three
  other leads (rs2b0t, rs-sdk-fleet, UberMouse). It also says UberMouse iron is about 5 base XP per tick against
  their measured 11.67 (base XP, so x25 = 292 XP/tick; UNVERIFIED by us).
- Reuse: read and port. Their quest notes (`docs/speedrun/quests/*.md`, 35 files) cover Waterfall, Tree Gnome
  Village, Grand Tree, Monkey Madness, Dragon Slayer, Holy Grail, Mage Arena, Legends and others; these feed
  `research/quest-plan.md`. Their helpers docs map to our helper roles.
- Risk: a rival can see what we do only if we publish; reading their public repo is fine. Some named techniques
  (dialogue bursts, knife-on-log, five-packet interleaving) look like accepted tick mechanics; "wine without a
  level check" and "Charge without a cooldown" are content bugs. Our `research/bug-report-wine-login.md` and owner
  rule on real exploits apply. Owner decision O3.

### 2. UberMouse/rs-sdk wiki fork (detailed)

**Licenses.** UberMouse/rs-sdk: MIT (GitHub API; LICENSE file "MIT License, Copyright (c) 2025 Lost City").
MaxBittker/rs-sdk: MIT, 1,029 stars. A copy with the MIT notice kept is allowed.
https://github.com/UberMouse/rs-sdk/blob/main/LICENSE

**Who and what.** Author Taylor Lodge (commit author). The fork is 665 commits ahead of upstream. It has a
"Conductor" framework (`conductor/`: plans, tasks as generators over an op interpreter, guards, watchdog, tick
recordings and replay) and the generated wiki. Bot names in the training pages: conductor2, conductor2w1,
conductor2w2. They are not in our hiscore snapshots (`rg conductor research/hiscores-*.json`: no match).
https://github.com/UberMouse/rs-sdk/blob/main/conductor/README.md

**Content match (CODE-READ + WEB).** `world.json` `generatedFrom` = `fb264971634d…` (upstream commit "Harden Miscellania transfers"). The latest upstream commit that touches `server/content` is that same commit
(`gh api repos/UberMouse/rs-sdk/commits?path=server/content`). Our `vendor/rs-sdk` HEAD `b565f2d9`
compares to upstream main with 0 content files changed. So the content under `world.json` is our content.

**world.json structure** (format 21, 7,678,917 bytes; top-level keys and counts from `jq`):

| Key | Count | Record shape (first record) |
|---|---|---|
| `areas` | 225 | `{id, name, parent, rects[{x1,z1,x2,z2}], notes}` |
| `features` | 22,665 | `{source: loc, id, config, tile{level,x,z}, shape, rotation, kind, subtype, name}` |
| `sites` | 3,983 | `{id: "rock:varrock-east-mine:0", kind, areaPath, centre, bbox, stand, counts{iron:4,...}, features[], f2p, multiway, wildernessLevel, reach: [[]], nearest{bank{site, runTicks, requires}, furnace{...}}}` |
| `npcSpawns` | 4,537 | `{config, areaPath, centre, bbox, count, f2p, reach: [["quest:regicide>=13","skill:agility:56"]]}` |
| `connectors` | 1,015 | stairs and ladders: `{feature, loc, op, opName, direction, landing, stand, source: "ladders+stairs/scripts/stairs.rs2:474"}` |
| `gates` | 869 | `{trigger, kind, loc, tile, shape, angle, width, length, requires, landings[{stand, landing}], ticks, source}` |
| `crossings` | 816 | scripted moves and teleports: `{via, act{kind, loc, op}, at, from[], landings[{tile, spread}], requires, ticks, source}` |
| `transports` | 27 | ships, carts, sleds: `{kind, npc, from, to, source, fare, requires, paidAt, notes}` |
| `quests` | 68 | `{id, varp, varpId, complete, stages, source}` |
| `loadoutRules` | 3 | e.g. Entrana: no weapons or armour |
| `methods` | 21 | the curated training methods with their floor rates |

Site kinds: tree 797, npc 1,453, connector 906, pickpocket 150, fire 115, shop 111, rock 85, water-source 76,
range 63, fishing-spot 53, altar 26, bank 25, anvil 21, flax 17, furnace 12, thieving-chest 12, rc-altar 11,
rc-ruins 10, spinning-wheel 9, stall 8, pottery-wheel 6, sand-pit 5, pottery-oven 5, tanner 4, agility-course 3.

**Reach.** A site's `reach` is the list of minimal requirement sets for a walk from the Lumbridge spawn to its
stand tile: `[[]]` for none, `[]` for unreachable. Tokens: `quest:<id>[>=stage]`, `skill:<s>:<n>`,
`questpoints:<n>`, `item:<obj>:worn|held`, `coins:<n>`, `consume:<obj>:<n>`, `members`, `loadout:<id>`,
`other:<text>`. At most 24 sets per tile. https://github.com/UberMouse/rs-sdk/blob/main/wiki/world/README.md

**Nearest bank.** Resource and processor sites carry `nearest.bank` (and furnace, range, anvil for ore, fish,
bars): the sink site, run ticks stand to stand, and what the way needs. Crossings cost a fixed `CROSSING_TICKS`
per kind, which the README calls "an estimate". Example: Varrock East mine (4 iron, 9 copper, 6 tin) to
Varrock East bank 46 run ticks; to Lumbridge furnace 73.

**Against our knowledge/*.json** (CODE-READ of our files):

| Topic | Ours | UberMouse | Gap |
|---|---|---|---|
| Stairs and ladders | `transports.json` 542 edges ("ladder and stair edges only", `knowledge/BUILD.md`) | 1,015 connectors | Theirs covers more; the difference is not explained (UNVERIFIED: they may count each op direction) |
| Doors and gates | `doors.json` 2,696 wall locs classified open/key/locked/quest/skill | 869 gate rows with landings, requirement sets and ticks, from a script trigger scan plus a reviewed list | Theirs gives the passage and its cost; ours gives the door state |
| Ships, carts, teleports, scripted moves | none | 27 transports, 816 crossings | We have no data |
| Reach from spawn | none | every site and npc cluster | We have no data |
| Nearest bank per resource | none (our `packages/core` has no nearest-bank logic; `rg nearest packages/core/src/world.ts`: no match) | every resource site | We have no data |
| Banks | Draynor (3092,3243), no Lumbridge castle bank (git fa56f14, ledger removed after) | 25 bank sites; Draynor stand (3092,3243); none in Lumbridge castle | Agrees |
| Drops, shops, items, npcs | `drops.json` 258, `shops.json` 206, `items.json` 2,756, `npcs.json` 1,597 | wiki pages for 1,605 items, 917 npcs, shops | Same source; ours is already machine-readable |
| Quests | `quests.json` 64 with XP | 68 with varp and stages | Close; theirs has stage numbers |

**Floor model check.** `wiki/world/model/server.ts` reads the tick from the engine default `NODE_TICKRATE`
(400 in our `vendor/rs-sdk/server/engine/src/util/Environment.ts:54`, CODE-READ), so 1 hour = 9,000 ticks. The
model formula (`model/rate.ts`): ticks per item = (ticksPerAttempt + (1-p)·failTicks)/p + successTicks; resource
cap = features·n / (n·ticksPerItem + respawnTicks). This is the same form as our mining cap.
`research/supply-floors.md` does not exist; the check uses `research/xp-per-tick.md`, `knowledge/rates.json`,
`research/board-ranking-honest.md`. Their XP/hr divided by 9,000 (ESTIMATE: assumes their measured figures use
the same hour):

| Skill, method | UberMouse floor | UberMouse measured | Ours | Verdict |
|---|---|---|---|---|
| Thieving, Falador guard at 40 | 760k/h = 84 XP/tick | - | 73.85 XP/tick, 3 runs (`knowledge/rates.json`) = 87% of floor | Agrees |
| Thieving, Ardougne knight at 55 | 2.01M/h = 223 | 3.71M at 99 = 412 | 206.9, 6 runs = 93% of floor | Agrees |
| Mining, iron drop, 4 rocks Varrock SE, 99 | 1.43M/h = 159 ("resource" bound) | 1.17M = 130 | 97 measured at 3 rocks; cap "near 120" (`board-ranking-honest.md:10`). 4/3 x 120 = 160 | Agrees (same cap formula) |
| Agility, Wilderness course at 99 | 1.91M/h = 212 = 67 ticks per 14,285-XP lap | 1.16M at 89 = 129 = 111 ticks per lap | "~90 ticks/lap (inferred)" (`xp-per-tick.md`) | Our lap figure sits between their floor and their measurement; measure it |
| Woodcutting, Draynor willow bank at 99 | 2.28M/h = 253 | - | 1,687 XP per log, 4 ticks per roll (`xp-per-tick.md`) | No conflict; their model has no 3-tick trick (`tricks-plan.md` measured +29%) |

Their methods are solo (the account gathers its own supplies). Our plan has helpers supply items, so their
artisan rows (Smithing, Magic superheat, Crafting) are not our best rates. Use their model as a floor check
for gathering skills and travel legs only.

**Tests.** The owner says 1,288 tests (UNVERIFIED). The tree has 72 `wiki/world/test/*.test.ts` files and 99
`conductor/**/*.test.ts` files (237 `.test.ts` files repo-wide).

**Other parts worth taking.** `server/engine/src/web/pages/saves.ts` (Taylor Lodge): `GET /save/:name`
and `POST /kick/:name` on the management port, loopback only, behind `SAVE_ENDPOINTS=true`. Our vendor does not
have it (`rg SAVE_ENDPOINTS vendor/rs-sdk/server/engine/src`: no match). With it, our practice server can snapshot
and restore scenario states. Also 40 `conductor/saves/*.sav` scenario saves.

### 3. rs2b2t/rs2b0t

MIT, 12 stars. A TypeScript bot client for rs2b2t (a 2004scape anarchy fork), rev 289 per the
README table, local engine LostCityRS Engine-TS + Content branch 289. Bots call the client's own `doAction` and
`tryMove`. It has A* over a baked collision pack with a door and transport graph, quest modules as
`decide(snapshot) -> step`, 52 bundled scripts, and `docs/decisions/quest-pitfalls-2..22.md`.
https://github.com/rs2b2t/rs2b0t — Reuse: read the quest pitfall notes against our quest plan. Low porting cost
(TS). Its world-walk graph is a second check of UberMouse's gates and crossings.

### 4. TestingPurposes/rs-sdk-fleet

No license (GitHub API `license: null`). An overlay of 451 files on upstream commit `9f113a42` (rev 274). Claims
(UNVERIFIED): Bun protocol client "~0.73 MB marginal per bot", 400 bots at 444 MB; 1,800 bots on one 32 GB PC;
`headless/sim/` ports `PathingEntity.takeStep()`, the 25-waypoint queue and op timing, with 80 test files that
run real bot loops with no server; a synchronous 570 ms A* in the packet loop starved logins; "the server queues
client waypoints verbatim and never re-paths"; a parallel gold merge of 131.8M gp from 300 bots in 11.5 minutes.
https://github.com/TestingPurposes/rs-sdk-fleet — Reuse: design ideas only, for audit C2 (memory per bot) and for
a faster simulator (`research/rival-atlas-2026-10-16.md` point 2). Writing our own code from the ideas is fine;
copying their code is not.

### 5-7. Skretzo shortest-path, Microbot, Quest Helper

Unchanged from `research/wider-ecosystem.md` section 8; all three are BSD-2-Clause and active (pushed 10-22 or
10-23). UberMouse's gate and crossing tables now cover most of what the shortest-path transport TSV would give
us, and for our content, so shortest-path drops to a schema reference.

### 8. markeljan/rs-sdk-dashboard

MIT. bleugreen says it is "the dashboard a 90-account rs-sdk fleet runs on" and is synced from
a private fork; it names sokobot (all 63 quests) and 0hyl8LmRi (all 99s). Reuse: low; we have a dashboard.
https://github.com/markeljan/rs-sdk-dashboard

### 9. jrr97/runescape-ai

As in `wider-ecosystem.md`. MIT.

### 10. ineedbots/lc-headless

The README exists and describes C++/Python scripting and revisions225/274/289. No root license found in captured tree; not built or run. https://github.com/ineedbots/lc-headless

### Other rs-sdk forks (all MIT by inheritance unless stated)

Checked with `gh api repos/MaxBittker/rs-sdk/forks` (newest 100) and `compare/main...<fork>:main`:

| Fork | Ahead / behind | Notes |
|---|---|---|
| Urnz/rs-sdk | 150 / 66 | Housing, land construction, "simulation-clock" mods. Off-goal |
| saimdlx/nineninemaxxing, jrpii/rs-sdk-temporal-planning, 99-cooking/loot.xyz | ~2,000 / 2,249 | Pre-rewrite history, so the count is not meaningful (bleugreen says upstream rewrote history in March). jrpii has a temporal-planning report (`final-report.md`); loot.xyz is "High-speed rs private server built automation first" with its own `engine/`. Not read further |
| GoonMachine/rs-sdk | MIT | KotH playbooks, quest-XP bootstrap order, a Discord sample (per bleugreen) |
| CraziedAres, bogocat, ken12321, singulocity, natemacfadden, Kudretg | 1-6 ahead | Small fixes |
| Kimmo3223, java-james, SeanVella/pvp-sdk, Ghosts, Supalosa, Acquiredl, CakeRepository, Milbaxter, wheredidmyantsgo, uae1319-ux, bestlund/artscape | 0 ahead on `main` | Work may be on other branches (Acquiredl says "bot files are on the acquiredl branch"); not checked |

Other LostCity / 2004scape discovery leads (earlier blanket low-value rating withdrawn; inspect per use): CornThatLefty/OSRSBot (MIT, LLM agent
for rs-sdk via OpenRouter), vhsgreed/jev-plays-runescape (MIT), DataHoarder6/2004lite and skulltrick/lclite (MIT,
plugin hosts for the LostCity web client, build 274), maxwelllord/AgentPairRSBench (no license),
nrylov/rs2011-ts (no license, rev 634), index-rs/LC-bankvalue (no license, bank value from a .sav),
marcdubs/2004Scape-AP-Logic (Archipelago randomizer logic), PureXYZ/2004scape-sp-mobile (MIT, single player, 274).

### RS2 / Lost City focused source check

Match the **server, revision, protocol, cache and game rules**, not the name “RS2”. Our modified rs-sdk demo, rs2b2t and public Lost City are separate targets. The [public Lost City guide](https://2004.lostcity.rs/guide) prohibits bots and modified clients; research here does not establish compatibility or authorization there.

| Project / evidence | Useful entry point | Application and limit |
|---|---|---|
| [ineedbots/lc-headless](https://github.com/ineedbots/lc-headless) — pinned C++ source and Python scripting docs | `src/Game/Nav/WorldPathFinder.cpp`, `tests/Game/WorldPathFinderTests.cpp`, `docs/scripting/README.md` | README describes shared cache, per-account interpreters, script deadlines/progress and revisions225/274/289. Tests inspected for avoided zones, access-gated stairs, teleport policy and adjacent unreachable goals; tests not run. High navigation-fixture and account-isolation reference. Claimed16 accounts is not measured capacity here. No runtime migration or direct deployment proof. |
| [johnson-cooper/lost-city-progressive](https://github.com/johnson-cooper/lost-city-progressive) — server-side bot mod | `engine/src/engine/bot/{BotGoalPlanner.ts,tasks/CookingTask.ts}` | Cooking checks pack+bank supplies, completes when depleted and lets the planner reassign. Adapt stock-driven handoffs to our planner, with reservations and observed receipts. Weighted personality picks are not global goal optimization. Watchdog recovery and bank access use privileged engine state; do not port teleport recovery or assume ordinary-client feasibility. README requests254 cache. |
| [skulltrick/lclite](https://github.com/skulltrick/lclite) — MIT-labelled mod layer, README/tree captured | `tools/lclite.mjs`, `mods/`, drift-check workflow | Out-of-tree patches and explicit drift detection are useful for pinned-client maintenance; XP/stat/true-tile overlays for dashboard ideas. Not a full bot suite. Claims of surviving updates need patch-conflict tests; no launcher run. |
| [DataHoarder6/2004lite](https://github.com/DataHoarder6/2004lite) — MIT plugin host; README explicitly pre-MVP/build274 | `docs/mvp.md`, `docs/adr/`; event/action facade and canvas overlays | Client adapter/event contracts as future inspection leads. Pre-MVP status excludes treating it as a working automation platform. |
| [Scotho/idlescape](https://github.com/Scotho/idlescape) — public LostCity Client-TS fork, expressly unfinished | Sandboxed script runtime and client-side automation described on repository page | Candidate for script isolation/budget design. Not source-mined or validated in this pass; no reason to replace our deterministic workers. |
| [rs2b2t/rs2b0t](https://github.com/rs2b2t/rs2b0t) — existing highest-fit script source | Existing saved quest decisions, world walker and failure fixtures | Keep as primary bot-logic donor. Indexed pages still say274 while our earlier pinned README says289; bind facts to commit. README excludes pure LostCity/2004scape as supported targets. Do not promise drop-in compatibility. |
| [LostBot seller thread](https://www.sythe.org/threads/lostbot-full-automation-suite-for-2004scape-lostcity-engine-servers-73-profiles-proxy-support/) — historical commercial claim | Title advertises73+ profiles for2004scape/LostCity engines | Author now says project closed and no further sales. No source, working artifact or authenticated leak obtained; not an available dependency. |
| [2006RebottedClient](https://github.com/2006-Scape/2006RebottedClient), [Parabot](https://github.com/Parabot/Parabot) — older RS2/RSPS lineage | Existing RebottedAPI/script and Parabot provider boundaries | Secondary API/worker references. Similar era does not establish packet/cache or content compatibility with225/274/289. |

[Four pinned trees](../.practice/reuse-source-audit/lostcity/git-manifest.json), [10 saved text files](../.practice/reuse-source-audit/lostcity/sources.json). Prioritize **navigation failure fixtures → stock-aware job handoff → client patch drift checks** in existing modules. Source/readme evidence only; no external project built, no server login and no bot changes.

### Bot clients and frameworks (OSRS, closed or Java-injection)

| Client | Status | Reuse |
|---|---|---|
| DreamBot | Still running in July 2026 (UNVERIFIED; https://osrsguru.com/guides/osrs-bot-clients-shutdown-july-2026.html) | API shape only; closed |
| Storm | Closed permanently (UNVERIFIED, same source; https://www.osrsbestinslot.com/blog/osrs-bot-clients-shutdown-july-2026/) | none |
| TriBot, PowBot, Inubot | Sales stopped or shut down; sources disagree (UNVERIFIED, same sources) | none |
| OSBot, RSPeer | No 2026 status found (UNVERIFIED) | none |
| RSBot / Powerbot | `powerbot/powerbot` repo not found (404); history UNVERIFIED | none |
| Parabot | [Parabot/Parabot](https://github.com/Parabot/Parabot) GPL-3.0; 317 API GPL-2.0 | none (copyleft, stale) |
| OsrsBot | [OSRSB/OsrsBot](https://github.com/OSRSB/OsrsBot) GPL-3.0 | none (copyleft) |
| Microbot | BSD-2-Clause, active | see #6 |

These are not drop-in runtimes. Their public APIs, recovery logic and script task decomposition can still help; wrong-era rates/IDs must be replaced. Copyleft is a reuse condition, not evidence of low technical value. The historical shutdown claims above were not verified and must not guide current choices. See the refreshed classification below.

### Walkers

- DaxWalker: [itsdax/Runescape-Web-Walker-Engine](https://github.com/itsdax/Runescape-Web-Walker-Engine),
  Apache-2.0. Ideas only (as in `wider-ecosystem.md` 3.3).
- rsmod pathfinder: vendored. `rsmod/rsmod` ISC.
- UberMouse `wiki/world/reach.ts`, `distance.ts` (MIT) and rs2b0t world-walk (MIT) are new TS options on our
  content. bleugreen `speedrun/lib/paths.ts` and `travel.ts` (MIT) cover gates, spirit trees, gliders, ships.

### RuneLite tick plugins

The Plugin Hub has many tick plugins (`gh api search/code?q=repo:runelite/plugin-hub+tick`): tick-counter
(winterdaze, BSD-2-Clause), tick-fishing-helper, one-tick-flick, one-tick-flick-metronome, audible-2ticking,
game-tick-information, tick-replay-logger, ticktracker, rta-true-tick. RuneLite core has a Metronome plugin
(`runelite-client/.../plugins/metronome/MetronomePlugin.java`). A "Tick Manipulation" and a "Wiki Tile Markers"
plugin were not found under those names (UNVERIFIED). Reuse: none. They are timing aids for human players; our
bots read the server tick directly. The tick-trick knowledge is in `research/tick-tricks-web.md`.

### RS2/317 servers and clients

Earlier references: LostCity, archived 2004Scape, 2006Scape, Apollo, RSMod and RuneJS (see `wider-ecosystem.md` section 4). Their content is not automatically authoritative for our revision, but their engines, bot schedulers and fixtures remain design references. Kronos was found in the expanded review below; the earlier unsuccessful search was not evidence of absence.

### Data dumps

OpenRS2 caches, osrs-dumps (no license), osrsbox-db and osrsreboxed-db (GPL-3.0), OSRS Wiki (CC BY-NC-SA 3.0): as
in `wider-ecosystem.md` section 5. For rev 289 data, UberMouse `world.json` and our `knowledge/` beat all of them.

### AI and agent projects

As in `wider-ecosystem.md` section 6 (Naton1 PvP RL, no license; fight-caves-rl; jrr97). New: CornThatLefty/OSRSBot
and vhsgreed/jev-plays-runescape (both MIT, small). The useful agent work is bleugreen's and UberMouse's agent
coordinators (cairn, conductor), which use deterministic task code with an LLM above it, like our plan.

## Expanded discovery and classification

Search aliases: OSRS, 2007scape, 2004scape, 2009scape, 2010scape, RuneScape, RS2, RSPS; bot/scripts, quests, clients/servers, cache/maps/tiles, pathfinder/walker, simulation. These overlap for discovery, not protocol or data compatibility. Deduplicate forks by lineage; a website, client, server and script API are different deliverables.

[Search/metadata evidence](../.practice/ecosystem-pdfs/discovery-20261026.json) records 12 GitHub queries and 34 targeted lookups, including failures. Additional web searches covered official SDKs, stores, GitLab and public release archives. R = README/docs inspected; C = selected implementation inspected; M = metadata only. No external project was built or run. Licenses below are repository metadata unless noted; imported files and third-party data need their own check.

### Navigation: local movement, world routing and route execution

| Source | Evidence / reuse | Useful part | Application / limit |
|---|---|---|---|
| [Skretzo/shortest-path](https://github.com/Skretzo/shortest-path/blob/master/docs/Cross-plugin-communication.md) | R; BSD-2 | Multi-target search; required carried items; bank detour included in route cost | High: compare whole source→bank→destination trips. Docs explicitly do not track consumed fares/items during search; UNKNOWN targets still get display paths. Neither behaviour can authorize our execution. |
| [itsdax/Web-Walker](https://github.com/itsdax/Runescape-Web-Walker-Engine) | R; Apache-2 | Client-side path execution and recovery; region/global routing explanation | High ideas. Repository is the client wrapper; backend path generation is a service requiring credentials. Do not call it a complete offline solver. |
| [blurite/pathfinder](https://github.com/blurite/pathfinder) | R; ISC | Local BFS and benchmark suite | Compare reach/collision cases with existing rsmod; benchmark excludes collision-map loading. No replacement without a measured bottleneck. |
| [RustCityRS/rs-pathfinder](https://github.com/RustCityRS/rs-pathfinder) | R; MIT | Reach tests, step validation, entity sizes, generation-based BFS reset | Candidate differential-test reference. README requires synchronous tick-thread use of shared state; not a thread-safe fleet drop-in. |
| [mejrs/wasm-pathfinder](https://github.com/mejrs/wasm-pathfinder) | R; license unidentified | Browser/WASM path module in cartography project | Inspect source before ranking; README only gives build instructions. |
| [2003scape/rsc-path-finder](https://github.com/2003scape/rsc-path-finder) | R; AGPL-3 | Mutable walls/objects and asynchronous routing | Classic geometry differs; useful dynamic-obstacle test ideas, not our map data. |
| [OSBot WebWalkEvent](https://osbot.org/api/org/osbot/rs07/event/WebWalkEvent.html) | R; public API | Closest reachable goal, avoided areas, requirement prefetch, interruption during waits | High design value for route safety/recovery; no source implementation proved by API docs. |

### Quests, shared goals and supplies

| Source | Evidence / reuse | Useful part | Application / limit |
|---|---|---|---|
| [Zoinkwiz/quest-helper](https://github.com/Zoinkwiz/quest-helper) | R; BSD-2 | Step requirements, puzzle assistance, bank preparation and Shortest Path integration | High schema reference; a player guide is not an autonomous quest executor. |
| [rs2b2t/rs2b0t](https://github.com/rs2b2t/rs2b0t) | R; MIT | Pure quest decisions, world walking, resume/harness notes | High: README says rev289 and explicitly excludes pure LostCity/2004scape despite stale rev274 repository description. Match mechanics before porting. |
| [Quest pitfalls 32](https://github.com/rs2b2t/rs2b0t/blob/main/docs/decisions/quest-pitfalls-32.md) | R; MIT | Stage-limited shops, one-time grants, dialogue loops, unstandable targets, prerequisite-only false success | Turn each applicable failure into a fixture. In particular, obtaining a prerequisite must not report the final action completed. Facts remain their server's observations. |
| [NotSinan/DreamBotQuester](https://github.com/NotSinan/DreamBotQuester) | R/C sample; MIT | Requirement-gated branches and small acquisition/action leaves; ironman support claimed | Read Cook's Assistant acquisition tree for reusable decomposition. README quest-count/reliability claims are not test evidence. |
| [Iron Compass](https://github.com/gabworknestio-beep/iron-compass) | C; BSD-2 | ALL/ANY/NOT, TRUE/FALSE/UNKNOWN, separate quest/item/varp conditions, primary+secondary goals and dependency traversal | Highest new fit: shared blockers across our six lanes. Selected source: requirement/ConditionEvaluator.java and planner/GoalPlannerService.java. Keep our freshness/ownership rules and pinned facts. |
| [IronQuest](https://github.com/darrenswhite/ironquest/blob/main/server/src/main/java/com/darrenswhite/rs/ironquest/path/algorithm/SmartPriorities.java) | C; Apache-2; archived | Scores quest rewards toward recursively required goals | Useful heuristic for unlock ordering; not proof of globally optimal completion time. Replace raw XP weighting with our tick savings and avoid double-counting shared prerequisites. |
| [Iron Hub](https://github.com/ellismosss/iron-hub) | Search-index README only | Bank-to-goal, owned loadouts and collection planning claims | Hold: direct repository lookup failed. Do not treat its claims as verified code. |

### Bots, clients and script hubs

| Source | Evidence / reuse | Useful part | Application / limit |
|---|---|---|---|
| [PiggyPlugins](https://github.com/rvazarkar/PiggyPlugins), [OzPluginsPublic](https://github.com/xsmar/OzPluginsPublic) | R; AGPL-3 | Item-combining, resource gathering, combat and activity plugins | Public examples of task boundaries; inspect individual code before reuse. Shared Ethan API lineage means these are not independent validations. |
| [2006RebottedClient](https://github.com/2006-Scape/2006RebottedClient) | R; license unidentified | Scriptable client; points to RebottedAPI/Parabot-style scripts | Historical client/API boundary reference. Not a new runtime for our bots. |
| [Luna](https://github.com/luna-rs/luna/blob/master/src/main/java/io/luna/game/model/mob/bot/script/BotScriptStack.java) | C sample; LICENSE.txt MIT + ISC/LostCity notices | Rev377 server bots; ordered script stack, priority insertion, snapshot save/load | High recovery reference: persist work across interruption/restart. Autonomous living-world features are partly goals; server bots may have privileged state unlike clients. |
| [2010scape](https://github.com/nrylov/2010scape) | R; AGPL-3 | Bun/TypeScript rev623 engine, action queues, saves, containers and instances | Comparative engine design. Browser client is planned, not delivered by the website. Same-name lrhunsy11 repo remains M-only. |
| [2010scape-web](https://github.com/nrylov/2010scape-web) | R; license unidentified | Website; explicitly unknown status without working endpoint | Useful status honesty pattern; not a game client or bot engine. |
| [377 browser client](https://github.com/reinismu/runescape-web-client-377/blob/master/readme.md) | R/tree; license unidentified | TypeScript/Rust client and WASM module; links refactored-client-377 and RS317.Sharp | Debugging/portability lead. Author warns dependencies/Rust are dated; setup depends on a sibling Apollo server. No compatibility claim. |
| [ChromaScape](https://github.com/StaticSweep/ChromaScape) | R; GPL-3 | Layered pixel automation; references OSBC, RuneDark and RemoteInput | Optional independent visual checking. No reason to replace known game state with pixels. |
| [DreamBot scripts](https://github.com/viktorstiunovs/osrs-dreambot-scripts), [RuneMate bots](https://github.com/DerkSchooltink/runemate-bots) | R; license unidentified | Concrete farming, banking and progression scripts | Candidate recovery/recipe examples. DreamBot author explicitly says unmaintained; RuneMate README flags unfinished/untested bots. |
| [JevScape](https://github.com/Skyvern-AI/jevscape) | R; license unidentified | Bounded rs-sdk action catalog, event history and action switching | High idea: check state before retrying; README reports blind retries interrupting fishing. Paid model not needed to adopt this deterministic rule. |

### Cache, maps and simulation

| Source | Evidence / reuse | Useful part | Application / limit |
|---|---|---|---|
| [Displee cache library](https://github.com/Displee/rs-cache-library) | R; MIT | Cache containers, compression, XTEA, checksums; legacy317 example | Candidate multi-format reader; container support does not establish correct rev289 definition decoding. |
| [RuneStar/cache](https://github.com/RuneStar/cache), [cs2-scripts](https://github.com/RuneStar/cs2-scripts) | R; MIT / unidentified | Cache access and indexed client-script dumps | UI decoding clues; client scripts do not prove server quest state. |
| [Qodat](https://github.com/Qodat/qodat) | M; GPL-3 | Cache exploration/editing toolkit | Asset/animation inspection lead, no runtime or revision proof. |
| [Wiki maps](https://github.com/osrs-wiki/osrs-wiki-maps), [mejrs/rs3cache](https://github.com/mejrs/rs3cache) | R; GPL-3 / not checked | Cache→versioned map tiles/icons; coherence checks and structured dumps | Provenance/export patterns. Latest OSRS/RS3 output is not our collision map. Existing rs-map-viewer/Explv/OpenRS2 notes still apply. |
| [Wiki DPS calculator](https://github.com/weirdgloop/osrs-dps-calc) | R/tree; GPL-3 | Player→NPC and NPC→player calculation modules; hit/TTK distributions and tests | High: compare gear by survival, kill-time spread and food demand. Re-derive formulas from our engine; no modern OSRS stat import. |
| [Naton PvP RL](https://github.com/Naton1/osrs-pvp-reinforcement-learning) | R; license unidentified | JSON action/observation contracts; simulator separate from training | Narrow simulation fixture design. Live client plugin is explicitly absent; performance is author-reported. |
| [Fight Caves RL](https://github.com/jordanbailey00/fight-caves-rl) | R; license unidentified | Deterministic C simulator, action masks, resource management diagnostics | Good model-validation lessons; reported simulator wins/speed do not prove engine fidelity or our live route. |
| [Jad simulator](https://github.com/downthecrop/JS-OSRS-Jad-Simulator) | R; 0BSD metadata | Small browser combat trainer | Timing/visual replay idea; original assets and upstream components require separate checks. |
| [osrs-unified](https://github.com/ProjectSoulbyTmb/osrs-unified) | R; license unidentified | Simplified skilling model plus separate PvP environment | Explicitly local simulation; models share no packages. Useful contracts/baselines, not a full-engine replacement. |
| [2009scape](https://gitlab.com/2009scape/2009scape) | R; AGPL-3 | Engine/content and single-player environment | Historical [dragon-bot economy issue](https://gitlab.com/2009scape/2009scape/-/issues/81) illustrates resource creation vs real supply accounting. Not evidence of current bot behaviour. |

### Paid, closed, released and alleged leaked material

- Public [RuneMate quest store](https://www.runemate.com/store?search=quester) and [NMZ listing](https://www.runemate.com/store/bots/7874ac33-9fca-4b13-be80-166b05873b97) expose feature claims: quest prerequisites, restocking, repairs and supplies. Use these as coverage checklists, not proof or source access. No purchases or binaries needed.
- [DreamBot PlayerSettings guide](https://dreambot.org/guides/scripter-guide/api/playersettings/) explains server-owned quest varps/varbits. OSBot docs expose route preferences. These sources disprove our earlier blanket dismissal of closed APIs as useless research.
- [Kronos184 public archive](https://github.com/The-RSPS-Archive/184---Kronos-Source) identifies a Rune-Server release by Patrity and item-attribute design. Classify as third-party release archive with unverified provenance/license, not a confirmed leak or reusable dependency.
- “Leaked”, “open source” and “paid” are search labels, not evidence of authorship, completeness or reuse rights. Reuploads, binaries, inaccessible Discord catalogues and decompiled dumps stay separate from inspectable source. No unknown installer or leaked bundle was run/downloaded.

### OpenOSRS automation and paid-source leads

Search result: useful public automation source found; **no verified paid-to-free transition or authenticated leak** in this pass. Free source, paid features, third-party mirrors and RuneLite policy rejection are separate facts. Classify each, rather than calling every automation repo “banned” or “leaked”.

| Source / provenance | Useful implementation or lead | Use / limit |
|---|---|---|
| [Lucid SideloadPlugins](https://github.com/lucid-plugins/SideloadPlugins) — author lists free public source separately from paid private ToA | `src/main/java/com/lucidplugins/lucidcombat/LucidCombatPlugin.java`: `onGameTick`, `restorePrimaries`, `actionTakenThisTick`, inactivity cutoff | Combat priority arbitration: survival before boosts/spec/loot. Keep our tick budgets and observed receipts; action issued is not effect proved. No root license found in captured tree; inspect file rights before copying. Paid ToA source was not obtained. |
| [Illumine](https://github.com/illumineawake/illu-plugins) — public automation examples; GPL-3 root; archives explicitly unsupported | `iblackjack/.../Task.java`, `iherbcleaner/.../tasks/BankItemsTask.java`; `iutils/.../walking/{Pathfinder,TransportLoader}.java` | Reuse eligible-task decomposition and transport adjacency. Banking sample deposits then checks inventory on later ticks, but does not match bank credits. Pathfinder is BFS over tile/transport edges, not fare/time/resource optimization. Preserve our stronger receipts and whole-trip supply state. |
| [Owain94](https://github.com/Owain94/OpenOSRS-external-plugins) — public source; root license saved | `chinmanager/.../biconsumers/{BankingState,ResumeState}.java`; `chinstatemanager/.../Task.java` | Explicit task lifecycle and cancellation on state exit. Implement in existing worker lifecycle; test cancellation before startup, double stop and resume after changed inventory. BankingState dereferences `disposable` without a null guard; caller preconditions still need tracing. Do not import RxJava or assume lifecycle code is flawless. |
| [Ganom ExternalPlugins](https://github.com/Ganom/ExternalPlugins) — public GPL-3 archive with Patreon/Platinum promotion | `ExtUtils`, `OneClick`, `CustomSwapper`, `BossSwapper` modules; README inspected | Mine reusable interactions and ordered action descriptions next. Public source alongside premium offers does not prove premium plugins were released. Illumine's old singular `ExternalPlugin` link is broken; plural repository resolves. |
| [xKylee source mirror](https://github.com/Lul-eee/xkyle-plugins-source) — third-party fork of `myrsghub/plugins` | Tree lists AoE warnings, boss phases, spawn/tick timers, blackjack and socket status modules | Potential encounter-state and team telemetry references. Original `xKylee/plugins-source` returned repository-not-found; mirror lineage, individual headers and implementations need checking. Not an authenticated leak. |
| [Runemker PiggyPlugins](https://github.com/Runemker/PiggyPlugins), [kilotechs fork](https://github.com/kilotechs/PiggyPlugins) — shared Piggy/Ethan lineage | AutoCombat, AutoSmith, Upkeep; kilotechs README describes API/plugin renaming to avoid collisions | Extend existing Piggy entry, not a new independent framework. Inspect version/identity isolation before any reuse; names alone do not isolate mutable runtime state. No paid-to-free evidence. |
| [ImNoOSRS source](https://github.com/ImNoOSRS/plugins-source) — public tree and root license saved | Dense essence, mining markers, unused inventory/profit tracker modules | Source discovery lead for compact overlays and accounting; implementation not read. Reject README “no ban possible” claim as unproved. |
| [hwen3 plugin-releases](https://github.com/hwen3/plugin-releases) — distribution/readme inspected | ToB mechanics, projectile destinations, tick/attack counters and healer state descriptions | Feature checklist only in this pass. Do not count descriptions or release artifacts as inspected source. |
| [Bonfire bon-plugins](https://github.com/Bonfire/bon-plugins) — search-index README only; direct Git lookup failed | Describes animated armour, bone banking, museum cleaning and Blast Furnace pumping; credits Illumine | Useful role leads, not currently saved or verified implementations. Preserve lookup failure rather than treating stale search content as available code. |

Further non-compliant client/plugin leads, same date:

| Source / evidence | What to mine | Local value / limit |
|---|---|---|
| [Devious](https://github.com/jbx5/devious-client) — README explicitly calls it non-compliant; BSD-2 root reported | `LoopedPlugin`, `TaskPlugin`, interaction facade, transports/teleports and minimal client mode | Inspect lifecycle and resource isolation before expanding fleet capacity. README compatibility and RAM claims are not local measurements. Client/API reference, not a paid-source leak or replacement for rs-sdk. |
| [Chaos public plugins](https://github.com/rroarings/chaos-plugins-public) — source saved; author warns of unsupported/broken plugins | `cooking/.../tasks/HandleBank.java`, `shopper/.../tasks/Buy.java`, `utils/.../tasks/Task.java` | Useful task eligibility and shop minimum-stock policies for our production/procurement workers. **Do not copy accounting:** Buy calls `bought(n)` immediately after purchase requests, without observed inventory/coin settlement. Use actual debit/credit receipts, partial-fill handling and a budget. Test no coins, reduced stock, full inventory and a rejected buy. |
| [SpoonLite/spoon-plugins](https://github.com/SpoonLite/spoon-plugins) — captured tree is release JARs, README and metadata, not implementation source | README describes team supply counts, prep thresholds and leader-ordered world hops | Swarm ideas: authenticated partner state, stock quorum and leader acknowledgement with deadlines. Treat predicted teammate stock as uncertain. No JAR fetched or executed. |
| [SpoonLite/plugins-source](https://github.com/SpoonLite/plugins-source) — separate captured source tree, xKylee/myrsghub family | Encounter/tick/socket modules | Do not assume this source builds the separate spoon-plugins releases: correspondence unverified. Deduplicate with xKylee, not a second independent implementation. |
| [sandymandy12/unethicalite-plugins](https://github.com/sandymandy12/unethicalite-plugins) — public source tree | `hoot-agility/.../{Course,Obstacle,ObstacleFactory}.java`, `kebab-buyer-script/.../tasks/ScriptTask.java`; aerial fishing and blackjack modules | Next source candidates for data-driven obstacles and small supply jobs. Paths verified; behaviour not yet inspected. No paid/leak provenance proved. |
| [Paisti seller listing](https://www.sythe.org/threads/paisti-pluginsautoinfernoautocolosseumaccount-builder-2000-231qp-rfd-ironmen-alsofight-caves/) — first-party paid advertisement | Account-builder milestones, recurring farm/birdhouse jobs, inventory setups, slayer assignment cycles, boss entry/refill coverage | Convert advertised features into coverage questions for our goal planner. Prices, long-runtime and achievement claims are not verified outcomes; no public source or paid-to-free release verified. No purchase made. |
| [MeteorLite](https://github.com/MeteorLite/meteor-client) — public repository page | Kotlin/Compose client architecture | Lower priority reference; no plugin implementation or present compatibility established in this pass. |

[Additional pinned trees](../.practice/reuse-source-audit/plugins-more/git-manifest.json) and [11 selected text files](../.practice/reuse-source-audit/plugins-more/sources.json) preserve this pass. Three Chaos implementation files read; other entries are clearly marked tree/README/sales evidence. Searches for alleged leaks did not yield an authenticated premium plugin release. Source visibility, licensing, game compliance and functionality remain separate checks.

Additional source collections and distribution checks:

| Source / classification | Exact useful entry point | Adaptation / evidence limit |
|---|---|---|
| [y-fletch/ocplugins](https://github.com/y-fletch/ocplugins) — public OpenOSRS automation source | `occore/src/main/java/com/yfletch/occore/v2/RunnerPlugin.java`; `ocbankskills`, `ocpickpocket`, `ocblastfurnace` | Sampled runner has ordered rules, deferred interactions, per-tick action counts and status/debug overlays. Adapt bounded action arbitration into existing worker helpers; test duplicate events, stale deferred actions and stop during resolution. Static resolution executor is shared; inspect cancellation/account isolation before porting. README marks stuck logout WIP and alpha plugins unproved. |
| [Magnusrn/Plugins](https://github.com/Magnusrn/Plugins) — public one-click source | `oneclickfurnace/.../OneClickFurnacePlugin.java`; blast furnace, fishing, glass, fungus, sandstone modules | Furnace sample separates UI, bank and production steps, but advances `bankingState` when assigning a menu action. Rebuild transitions from observed inventory/bank effects; failed withdrawal must not advance. Do not copy hard-coded modern widget/animation IDs or timeout constants. |
| [OreoCupcakes/kotori-plugins](https://github.com/OreoCupcakes/kotori-plugins) — author describes ported OpenOSRS source for RuneLite | `aoewarnings`, `fightcaves`, `inferno`, `cerberushelper`, `gwdhelper`, `zulrahoverlay` | Encounter timelines, hazard display and phase models are next inspection candidates. Captured source tree/README, not implementation proof; helpers are not automatically full bots. Port only content that exists on our revision. |
| [moneyprinterbrrr/plugins-1](https://github.com/moneyprinterbrrr/plugins-1) — public collection; README says free | `itemcombiner`, `foodeater`, `autothiever`, `continueclicker`, `eventdebugger`, `jadautoprayer` | Small worker decomposition and event-debugging leads; tree/README inspected only. Shared OpenOSRS lineage, not independent correctness evidence. |
| [tomkeys](https://github.com/BrettMoan/tomkeys) — free binary distribution, source expressly withheld in README | Documented hotkey commands for item/gear/spell/prayer sequences | Feature grammar reference only. GitHub's GPL label does not make absent implementation inspectable; not a source release. |
| [Pluginscape](https://pluginscape.com/) / [terms](https://pluginscape.com/terms) — paid sideloaded plugin seller | Farming/banking/replanting cycle; animated armour, crafting, supply and combat catalog | Coverage checklist only. Terms explicitly sell compiled JAR access, not source. No source release, execution, purchase or performance verification. |

[Four extra pinned trees](../.practice/reuse-source-audit/plugins-extra/git-manifest.json), [10 saved text files](../.practice/reuse-source-audit/plugins-extra/sources.json). Focused code samples: OC runner and Magnusrn furnace; no external code executed. No verified premium-source leak found. RuneLite's [removed-feature history](https://github.com/runelite/wiki/blob/master/Rejected-or-Rolled-Back-Features.md) directly records removal of AoE, Zulrah, Demonic Gorilla and other helpers; this supports historical feature classification, not a claim that each repository was individually banned.

**Port order:** combat action priority → worker cancellation/resume → missing task predicates. Use `scripts/` workers and existing `packages/core/` helpers. For each port, pin upstream commit and file, check its license/header, translate decisions to our observed SDK state, replace modern item/varp/timing data with pinned server facts, and test the failure case offline before practice. Do not replace our stronger bank/handoff receipts with upstream click success. Pathfinding remains the existing supply-aware route work, not a fresh BFS rewrite.

Evidence: [Git lookup results](../.practice/reuse-source-audit/plugins/git-manifest.json), [16 pinned source/README/license files](../.practice/reuse-source-audit/plugins/sources.json). Four trees captured; nine implementation files selected, focused reads only as described above. GitHub API requests hit rate limits; read-only shallow Git retrieval succeeded for four of six attempted repositories. No external plugin was built, installed or run. See [RuneLite's own rejected-feature policy](https://github.com/runelite/runelite/wiki/Rejected-or-Rolled-Back-Features) for policy classification; it does not establish source provenance or compatibility with our server.

### Decisions for our stack

| Priority | Small useful application | Existing destination | Proof before adoption |
|---|---|---|---|
| 1 | One requirement graph with explicit unknowns; show shared unlocks across wealth, gear, quests and boards | knowledge/quests.ts, core/quest-status.ts, dashboard/goal-details.ts | Snapshot fixtures: missing bank/varp, partial quest, alternative items, duplicate prerequisites; no unsupported state becomes ready |
| 2 | Price complete pickup→bank→destination routes with remaining fares/items, locked edges and contention | planner/travel.ts; knowledge/transports.ts | Existing courier route plus blocked/insufficient-fare cases; compare total ticks/cost, not geometric distance |
| 3 | Quest actions return observed product/stage; resume from game state and bound repeated dialogue failures | existing generated quest scripts and route harness | Pinned-content stage/varp fixtures; later practice from mid-quest and missing-item states |
| 4 | Compare combat upgrades by expected loot net of food and risk, plus kill-time spread | research/combat-measure.md and existing combat scripts | Engine formula checks, then matched practice; never transfer simulator win rates |
| 5 | Use replayable action traces and bounded scenario resets; model contention separately | core receipts; practice package | Same input/action/output trace in model and practice; record divergence before using model forecasts |

Local source check: travel.ts already consumes UberMouse nearest-bank data and cached paths; quests.ts already extracts completion conditions. Do not re-import solved pieces. The open gaps are resource-aware whole routes, broader requirement extraction, and action-effect/recovery evidence. All game work remains paused. This replaces earlier import-permission queues and framework-rewrite proposals; no runtime migration is authorized by this survey.
