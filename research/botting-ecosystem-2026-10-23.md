# Botting ecosystem survey (2026-10-23): code and data we can reuse

Scope: RS2 (2004) and OSRS bot clients, script repos, walkers, RuneLite tick plugins, RS2 server and client
projects, headless clients and simulators, data dumps, AI projects, and other rs-sdk forks. This file extends
`research/wider-ecosystem.md` and `research/community-and-upstream.md`. It does not repeat their rows; it gives
new findings and re-checks license and activity.

Method: read-only. GitHub metadata and files came from `gh api` (repo, tree, contents, compare, commits) and
`raw.githubusercontent.com` read as text to stdout. `wiki/world.json` was streamed through `jq` and not saved.
Nothing was cloned, installed or run. Dates are the repo `pushed_at` date on 2026-10-23.

Evidence levels: **WEB** (a page or repo file read today) unless a row says **CODE-READ** (we checked the claim
in our own `vendor/` or `knowledge/`). **UNVERIFIED** marks a claim we could not check.

## Main findings

1. **A rival speedrun team publishes its whole plan.** `bleugreen/rs-sdk` (MIT, pushed 2026-10-23, 656 commits
   ahead of upstream) has a `speedrun/` package and `docs/speedrun/` with a run order, a step manifest, helper
   playbooks, quest notes, competitor forensics and a measured engine sweep. Its expected run is 38,742 ticks
   (best case 31,324), against stunbaron's 35,916. It names the techniques it uses: wine without a level check,
   Charge without a cooldown, dialogue bursts, knife-on-log tick manipulation, five-packet interleaving.
   It is the highest-value find in this survey. https://github.com/bleugreen/rs-sdk/blob/main/docs/speedrun/research/competitors/public-code.md
2. **UberMouse's world index is valid for our content.** The fork is MIT. `world.json` was built from content
   commit `fb264971` (2026-10-11), and upstream has not changed `server/content` since. Our vendor HEAD is
   `b565f2d9` (2026-10-19), and the compare `b565f2d9...main` shows 0 content files (CODE-READ + WEB). The
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

| # | Candidate | License | Last push | Lang | What we reuse | Saves us | Risk |
|---|---|---|---|---|---|---|---|
| 1 | [bleugreen/rs-sdk](https://github.com/bleugreen/rs-sdk) `speedrun/`, `docs/speedrun/` | MIT (file: "Copyright (c) 2025 Lost City") | 2026-10-23 | TS | Run order and leg ticks, helper playbooks (wine, bones, runes, cannon, mule, staging), quest notes for about 35 quests, engine sweep top ten (measured), hiscore stamp forensics, fast send layer (`lib/wait.ts`, `bank.ts`, `trade.ts`, `converse.ts`, `levelup.ts`, `runner/budget.ts`) | Very high: weeks of measurement on the same server and goal | Rival team; content can change or vanish. Some techniques may be "real exploits" under owner rule (owner decision O3). Low code risk if read only |
| 2 | [UberMouse/rs-sdk](https://github.com/UberMouse/rs-sdk) `wiki/` | MIT | 2026-10-23 | TS | `world.json` (reach, nearest bank, connectors, gates, crossings, transports, npc spawn clusters), floor model `wiki/world/model/`, 40 scenario saves, save/kick endpoint `server/engine/src/web/pages/saves.ts` | High: a reach graph and per-site banks we do not have; a checked rate model | Low. A generated 7.7 MB file; pin by commit |
| 3 | [rs2b2t/rs2b0t](https://github.com/rs2b2t/rs2b0t) | MIT | 2026-10-22 | TS | Quest modules (`decide(snapshot) -> step`) and about 22 `docs/decisions/quest-pitfalls-*.md` from live runs, rev 289 | Medium-high: bleugreen estimates 200-500 quest ticks (UNVERIFIED) | Low. Targets a different server (rs2b2t) on the same revision; README table says 289, repo description says 274 |
| 4 | [TestingPurposes/rs-sdk-fleet](https://github.com/TestingPurposes/rs-sdk-fleet) | NONE | 2026-08-03 | TS | Ideas: browserless protocol client, offline simulator `headless/sim/`, navgrid notes ("send the per-tile path raw"), parallel "pyramid" gold merge | Medium-high as design input (our C2 memory problem, a faster simulator) | No license: copying code is not allowed. Rev 274 baseline |
| 5 | [Skretzo/shortest-path](https://github.com/Skretzo/shortest-path) | BSD-2-Clause | 2026-10-22 | Java | Transport TSV schema (already recommended) | Medium | Low; OSRS coordinates differ |
| 6 | [chsami/Microbot](https://github.com/chsami/Microbot) | BSD-2-Clause | 2026-10-23 | Java | State machine and wait helpers (already recommended) | Medium | Low; OSRS client code, port ideas only |
| 7 | [Zoinkwiz/quest-helper](https://github.com/Zoinkwiz/quest-helper) | BSD-2-Clause | 2026-10-22 | Java | Quest step and requirement schema | Medium | Low; OSRS varbits |
| 8 | [markeljan/rs-sdk-dashboard](https://github.com/markeljan/rs-sdk-dashboard) | MIT | 2026-10-14 | TS | Fleet dashboard for a 90-account rs-sdk fleet (per bleugreen) | Low-medium (our dashboard exists) | Low |
| 9 | [jrr97/runescape-ai](https://github.com/jrr97/runescape-ai) | MIT | 2026-10-17 | TS | JSON routine graph schema (already recommended) | Low-medium | Low |
| 10 | [ineedbots/lc-headless](https://github.com/ineedbots/lc-headless) | NONE | 2026-10-21 | C++ | Ideas: a C++ headless LostCity client | Low (README not readable: 404) | No license; native code; do not run |

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
- `docs/speedrun/RUN-ORDER.md` (890 KB): steps S00-S27 with labels m/r/i/e per tick figure; states the demo has
  ticked at 400 ms since 2026-10-22 19:56:29Z. That agrees with our C2 settlement (399.8 ms).
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
MaxBittker/rs-sdk: MIT, 1,029 stars, pushed 2026-10-23. A copy with the MIT notice kept is allowed.
https://github.com/UberMouse/rs-sdk/blob/main/LICENSE

**Who and what.** Author Taylor Lodge (commit author). The fork is 665 commits ahead of upstream. It has a
"Conductor" framework (`conductor/`: plans, tasks as generators over an op interpreter, guards, watchdog, tick
recordings and replay) and the generated wiki. Bot names in the training pages: conductor2, conductor2w1,
conductor2w2. They are not in our hiscore snapshots (`rg conductor research/hiscores-*.json`: no match).
https://github.com/UberMouse/rs-sdk/blob/main/conductor/README.md

**Content match (CODE-READ + WEB).** `world.json` `generatedFrom` = `fb264971634d…` (upstream commit, 2026-10-11,
"Harden Miscellania transfers"). The latest upstream commit that touches `server/content` is that same commit
(`gh api repos/UberMouse/rs-sdk/commits?path=server/content`). Our `vendor/rs-sdk` HEAD `b565f2d9` (2026-10-19)
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
| Banks | ledger ruling: Draynor (3092,3243), no Lumbridge castle bank (`docs/superpowers/ledgers/2026-10-22-phase2-script-core.md:25`) | 25 bank sites; Draynor stand (3092,3243); none in Lumbridge castle | Agrees |
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

**Other parts worth taking.** `server/engine/src/web/pages/saves.ts` (Taylor Lodge, 2026-10-09): `GET /save/:name`
and `POST /kick/:name` on the management port, loopback only, behind `SAVE_ENDPOINTS=true`. Our vendor does not
have it (`rg SAVE_ENDPOINTS vendor/rs-sdk/server/engine/src`: no match). With it, our practice server can snapshot
and restore scenario states. Also 40 `conductor/saves/*.sav` scenario saves.

### 3. rs2b2t/rs2b0t

MIT, 12 stars, pushed 2026-10-22. A TypeScript bot client for rs2b2t (a 2004scape anarchy fork), rev 289 per the
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

MIT, pushed 2026-10-14. bleugreen says it is "the dashboard a 90-account rs-sdk fleet runs on" and is synced from
a private fork; it names sokobot (all 63 quests) and 0hyl8LmRi (all 99s). Reuse: low; we have a dashboard.
https://github.com/markeljan/rs-sdk-dashboard

### 9. jrr97/runescape-ai

As in `wider-ecosystem.md`. MIT, pushed 2026-10-17.

### 10. ineedbots/lc-headless

No license, C++, pushed 2026-10-21, description "A C++ headless client for LostCity private servers". README
fetch returned 404 (no README on `main`). Do not build or run it. https://github.com/ineedbots/lc-headless

### Other rs-sdk forks (all MIT by inheritance unless stated)

Checked with `gh api repos/MaxBittker/rs-sdk/forks` (newest 100) and `compare/main...<fork>:main`:

| Fork | Ahead / behind | Notes |
|---|---|---|
| Urnz/rs-sdk | 150 / 66 | Housing, land construction, "simulation-clock" mods. Off-goal |
| saimdlx/nineninemaxxing, jrpii/rs-sdk-temporal-planning, 99-cooking/loot.xyz | ~2,000 / 2,249 | Pre-rewrite history, so the count is not meaningful (bleugreen says upstream rewrote history in March). jrpii has a temporal-planning report (`final-report.md`); loot.xyz is "High-speed rs private server built automation first" with its own `engine/`. Not read further |
| GoonMachine/rs-sdk | MIT, 2026-08-17 | KotH playbooks, quest-XP bootstrap order, a Discord sample (per bleugreen) |
| CraziedAres, bogocat, ken12321, singulocity, natemacfadden, Kudretg | 1-6 ahead | Small fixes |
| Kimmo3223, java-james, SeanVella/pvp-sdk, Ghosts, Supalosa, Acquiredl, CakeRepository, Milbaxter, wheredidmyantsgo, uae1319-ux, bestlund/artscape | 0 ahead on `main` | Work may be on other branches (Acquiredl says "bot files are on the acquiredl branch"); not checked |

Other LostCity / 2004scape repos found by `gh search repos` (all low value): CornThatLefty/OSRSBot (MIT, LLM agent
for rs-sdk via OpenRouter), vhsgreed/jev-plays-runescape (MIT), DataHoarder6/2004lite and skulltrick/lclite (MIT,
plugin hosts for the LostCity web client, build 274), maxwelllord/AgentPairRSBench (no license),
nrylov/rs2011-ts (no license, rev 634), index-rs/LC-bankvalue (no license, bank value from a .sav),
marcdubs/2004Scape-AP-Logic (Archipelago randomizer logic), PureXYZ/2004scape-sp-mobile (MIT, single player, 274).

### Bot clients and frameworks (OSRS, closed or Java-injection)

| Client | Status | Reuse |
|---|---|---|
| DreamBot | Still running in July 2026 (UNVERIFIED; https://osrsguru.com/guides/osrs-bot-clients-shutdown-july-2026.html) | API shape only; closed |
| Storm | Closed permanently (UNVERIFIED, same source; https://www.osrsbestinslot.com/blog/osrs-bot-clients-shutdown-july-2026/) | none |
| TriBot, PowBot, Inubot | Sales stopped or shut down; sources disagree (UNVERIFIED, same sources) | none |
| OSBot, RSPeer | No 2026 status found (UNVERIFIED) | none |
| RSBot / Powerbot | `powerbot/powerbot` repo not found (404); history UNVERIFIED | none |
| Parabot | [Parabot/Parabot](https://github.com/Parabot/Parabot) GPL-3.0, last push 2021-11-27; 317 API GPL-2.0, 2022 | none (copyleft, stale) |
| OsrsBot | [OSRSB/OsrsBot](https://github.com/OSRSB/OsrsBot) GPL-3.0, 2025-02-07 | none (copyleft) |
| Microbot | BSD-2-Clause, active | see #6 |

None of these helps the goal. They inject into the OSRS client; our server already gives us structured state.
Their script stores sell OSRS scripts, whose methods (OSRS rates, OSRS IDs) do not fit rev 289.

### Walkers

- DaxWalker: [itsdax/Runescape-Web-Walker-Engine](https://github.com/itsdax/Runescape-Web-Walker-Engine),
  Apache-2.0, pushed 2026-03-11. Ideas only (as in `wider-ecosystem.md` 3.3).
- rsmod pathfinder: vendored. `rsmod/rsmod` ISC, pushed 2025-10-01.
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

Unchanged from `wider-ecosystem.md` section 4: LostCity (MIT, vendored), 2004Scape/Server (MIT, archived),
2006Scape (GPL-3.0, pushed 2026-10-17), Apollo (ISC, 2023-05-18), RSMod (ISC), RuneJS (GPL-3.0, rev 435). Hyperion
and Moparscape sources: not found by search (UNVERIFIED). None adds value over the rev 289 content we run.

### Data dumps

OpenRS2 caches, osrs-dumps (no license), osrsbox-db and osrsreboxed-db (GPL-3.0), OSRS Wiki (CC BY-NC-SA 3.0): as
in `wider-ecosystem.md` section 5. For rev 289 data, UberMouse `world.json` and our `knowledge/` beat all of them.

### AI and agent projects

As in `wider-ecosystem.md` section 6 (Naton1 PvP RL, no license; fight-caves-rl; jrr97). New: CornThatLefty/OSRSBot
and vhsgreed/jev-plays-runescape (both MIT, small). The useful agent work is bleugreen's and UberMouse's agent
coordinators (cairn, conductor), which use deterministic task code with an LLM above it, like our plan.

## Recommended next steps

| # | What to pull in or port | Where in our repo | License condition | Owner decision |
|---|---|---|---|---|
| 1 | Read bleugreen `docs/speedrun/` (RUN-ORDER, engine-sweep, competitors, quests, helpers) and write a gap list of their measured tricks against ours | `research/rival-bleugreen-2026-10-23.md` (new) | MIT: cite, keep notice if any text or code is copied | O3: which of their techniques count as "real exploits" |
| 2 | Import `world.json` sites with `reach` and `nearest`, connectors, gates, crossings, transports, pinned to UberMouse commit and content `fb264971` | `knowledge/world-ubermouse.json` plus a loader in `packages/knowledge/src/` | MIT: keep the copyright notice in a `knowledge/THIRD-PARTY.md` | O1: download of a 7.7 MB file into the repo |
| 3 | Port the floor formulas (`model/rate.ts`, `families/*.ts` for mining, woodcutting, fishing, thieving, agility) as a check beside `research/xp-per-tick.md` | `packages/planner/src/floor.ts` | MIT notice in file header | none (we write the code; short port) |
| 4 | Port the save/kick endpoint to our practice server; use it for scenario snapshots | our practice package (`packages/practice/`), engine patch kept as a diff | MIT | O2: patching the vendored engine |
| 5 | Read rs2b0t quest pitfall notes against our quest plan | `research/quest-plan.md` (owner of that file) | MIT | none |
| 6 | Measure the Wilderness agility lap (their floor 67, their measured 111, our inferred 90 ticks) | `research/` agility note | n/a | none |
| 7 | Design our own browserless client and lockstep simulator from rs-sdk-fleet ideas | `packages/core/` design doc first | No license on rs-sdk-fleet: ideas only, write new code | O4: approve the work |
| 8 | Do not take: closed OSRS clients, GPL OSRS DBs, Parabot/OsrsBot, lc-headless (no license, native) | - | - | - |

Downloads that need the owner's yes:

- **O1**: `wiki/world.json` from UberMouse/rs-sdk (7,678,917 bytes, MIT, at a pinned commit) into `knowledge/`.
- **O2**: copy `server/engine/src/web/pages/saves.ts` (UberMouse, MIT) into our practice engine.
- **O5**: any code file from bleugreen/rs-sdk `speedrun/lib/` (MIT), if step 1 finds one worth copying verbatim.
- No download is needed for steps 3, 5, 6, 7: they are reads and our own code.
