> Current authority: all gameplay techniques are authorized. Wine, cocktails, pyre oil, Charge, relogs and tick manipulation need no further approval. Missing supplies create acquisition work, never a route exclusion. See [AGENTS.md](../AGENTS.md).

> Current target check: [all 24 boards refreshed](../.practice/joined-plan/targets-20261026-093155/comparison.json); timed leaders unchanged, realistic model 44,866 versus 35,916. Value-board targets and tie limits are in [boards-special](boards-special.md). No feasible route has been proved for the 24-board goal; the goal is unchanged. Quest Points has a playtime deadline. Use the [current plan](../docs/plans/joined-plan.md) for the current gap and next experiment.

# Haggis run: 24-board schedule

Model: `packages/planner/src/haggis.ts` with travel (`packages/planner/src/travel.ts`). Inputs:
`packages/planner/src/haggis-boards.json` (each number has `evidence` and `source`; each row has a place) and the leg
cache `packages/planner/src/haggis-travel.json`. Deadlines: `research/hiscores-live.json` ), row 1 of each board. Reprint every table here with
`bun packages/planner/src/haggis-cli.ts research/hiscores-live.json --order --supplies --evidence --levers --travel`.

## Verdict

**At the numbers below the schedule does not meet all 24 targets. It does not establish that every possible route fails.** Equipment tie/order semantics require separate validation.

- Every skill board stamps the account's total playtime at the level-up (`Player.ts:1904-1905`,
  `LoginServer.ts:155-181`). One account has one clock. Each board that Haggis trains adds its ticks to the stamp
  of every board that comes after it.
- The Overall #1 (`stunbaron`) has all 19 skills at 99 in 35,916 ticks. With every safe lever, the travel legs,
  the legal Cooking route and the stageable supply rows (`research/supply-logistics.md`), Haggis
  reaches Overall at **38,583 ticks at floor rates (slack -2,667)** and **47,248 at realistic rates (slack
  -11,332)**. ESTIMATE (the model; most rows are code-read or rival figures). The last 99 is Agility at both rates.
- **Route choice by Overall.** `schedule` picks the variant combination with the earliest Overall
  finish for each mode (`chooseRoute` in `haggis.ts`; all combinations when there are 64 or fewer, else one group at
  a time with a re-check; tie-break: the sum of slack over the clock boards). Only the `magic-smithing` group has
  two live options. Floor picks `superheat` (38,583; the raw-tick choice `separate` gives 39,257). Realistic keeps
  `separate` (47,248; `superheat` gives 47,812 there). The CLI prints the route and the last 99 per mode.
- **Superheat route supplies.** `magic-43` trains on the teleport ladder (36 wind strikes, 15
  teleports; 168 / 219 ticks, ESTIMATE): the enchant ladder to 43 needs 28 cosmic runes, more than the 20 that
  can be staged. `magic-top` superheats gold past Smithing 99 (441.7 / 415 Magic XP per tick, 30 gold ore,
  30 nature runes, 120 fire runes): enchant 5 needs dragonstone amulets. Both rows list their supplies, so the
  unsourceable test sees them. The `ranged` row's 850 rune arrows come from `fletch-arrows` (2,595 rune
  arrowtips fletched by Haggis; `Supply.from`), so no helper stages them.
- **Supply rows.** Four rows are OUT because they need items with no legal source at this scale ("no legal
  source at this scale"): `fletch` (rune dart tips 1,520), `craft` (uncut dragonstone 305), `herb` (torstol 176,
  snapdragon 6, toadflax 2), `magic` (cosmic runes 546, dragonstone amulets 453). Replacements, all ESTIMATE:
  `fletch-arrows` (arrows only, 49 / 50 ticks), `craft-diamond` (diamonds 43-99, 229 / 230), `herb-drops`
  (chaos-druid herb drops, 630 / 780), `magic-teleport` (722 law runes, 3,000 / 3,750, outside the
  pickpocket stuns). The table field `unsourceable` lists the items, and `haggis.test.ts` fails if an active row
  needs one. Each replacement row has a `leadTime` note for the helper work.
- Travel adds 4,769 ticks before the last 99 at floor rates and 6,950 over the whole run (4,718 / 6,899 on the
  realistic route): walks between rows plus walks inside rows (bank trips, altar and fishing-spot changes). The
  same table without travel (`--no-travel`) gives 33,814 / 42,530. The rival
  plan prices 2,283 of legs and about 1,789 of allowances (`research/rival-gap-list.md`). Our legs are longer
  because the EDF order does not group rows by place and the model has no teleports.
- At floor and at realistic rates all 20 clock boards are late in the EDF order. Herblore finishes at 1,036 / 1,217 against 447.
- Scenarios (a) and (b) give the same numbers. Login wine, the cocktail route to Cooking 35, pyre logs and
  Charge spam have no row in this model; all are allowed. Scenario (c) is 277 / 304 ticks
  faster (38,306 / 46,944, same routes as (a)): with Magic out of the pickpocket stuns, stun relog saves ticks.

**Current experiment priority (model only).** [Sensitivity](../.practice/shared-supply/sensitivity.json): Overall44,866 versus target 35,916, a gap of8,950ticks. Hypothetical halving saves at most2,660 for Monkey Madness,2,031 Agility,1,733 Woodcutting or1,614 Ranged; these are non-additive model effects, not proved gains. No single tested change meets Overall; all board deadlines must pass together. Retain combat side XP when comparing Ranged methods.

[Strict cache build](../.practice/mm-exit/interface-release-build/build-proof.json) passes with verification enabled and the fixed known GE-fork checksum. Interface bytes match generated source; all6,811zip entries retain their contents. [Fresh actual approaches](../.practice/mm-exit/trace-1793043473883/summary.json) passed3/3 on pin2b85:temple exits39/379/36ticks, including one teleport fallback, then safe bank/logout with amulet retained. This is recovery evidence, not an optimization. Immediate landing NPC snapshots were empty before telemetry repopulated; later footprints expose static route clicks crossing occupied guard rectangles. [Offline geometry](../.practice/mm-exit/trace-1793043473883/footprint-path-run2-552.json) finds a south detour in that observed state. [Guard-aware waypoint candidate](../.practice/mm-exit/guard-candidate/qualification.json) remains isolated:policy/collision restoration and typecheck pass;three native approaches/extractions pass at36/17/46exit ticks. Initial skills,items,varps and positions match the control, but guard layouts differ; this is no statistical speed claim. Each actor retained the amulet at bank with35HP and logout. Two immediate save reads were stale; settled CRC save bytes are archived and the proof harness now waits for required state before teardown. Keep ladder/reroll/teleport recovery and the old417tick tail evidence. Require three matched runs per condition and three full quests before changing model timing. Main stays offline.

The scheduler's selected subset is a model result, not proof of the best possible route. No live rank or all-board win is established. Monkey Madness has native timing evidence in the nested `ticks.source`; its top-level “ticks rival” text is stale and must not override those measurements.

## Board rules used

| Board | Rule | Source |
|---|---|---|
| 19 skills | Level desc, then playtime at the level-up | `RankedHiscoresWorker.ts:19`, `Player.ts:1905`, `LoginServer.ts:155-181` |
| Overall | Total level desc, then playtime at the last level-up | `LoginServer.ts:120-150` |
| Quest Points | Points desc, then playtime ascending, stamped at the save after the total changed (`RankedHiscoresWorker.ts:19`, `LoginServer.ts:200-216`). #1 `avery` has 145 of 145 at 1,022,262 ticks, so the only win is all 145 QP saved at 1,022,261 ticks or less (research/quest-plan.md, research/boards-special.md) | `hiscores.ts:313`; `quest.constant:72-139` |
| Equipment | Worn value desc. No clock | `hiscores.ts:620` |
| Bank | Bank value desc. No clock | `hiscores.ts:981` |
| Lava Maze Runite | Ore count desc, ties by first to reach it. All-time, 7-day and 24-hour windows | `hiscores.ts:781-828` |

A board where Haggis ties the #1 time is not counted as a win (the order of equal rows is not defined).

## Scenario tables

Slack = deadline - finish. Positive = Haggis beats #1. All three scenarios use EDF order with prerequisites, all
safe levers on, owner levers off, travel on. Floor columns use the superheat route, realistic columns the
separate Magic and Smithing rows (route choice by Overall).

### (a) No unapproved tricks

| Board | Deadline | Finish floor | Slack floor | Finish realistic | Slack realistic |
|---|---|---|---|---|---|
| Cooking | 20 | 148 | -128 | 177 | -157 |
| Fletching | 57 | 177 | -120 | 207 | -150 |
| Crafting | 197 | 406 | -209 | 437 | -240 |
| Herblore | 447 | 1,036 | -589 | 1,217 | -770 |
| Firemaking | 664 | 1,764 | -1,100 | 1,970 | -1,306 |
| Prayer | 1,281 | 20,797 | -19,516 | 26,440 | -25,159 |
| Magic | 1,324 | 5,487 | -4,163 | 5,803 | -4,479 |
| Smithing | 1,337 | 5,402 | -4,065 | 7,161 | -5,824 |
| Runecraft | 2,354 | 7,109 | -4,755 | 8,880 | -6,526 |
| Thieving | 2,935 | 17,330 | -14,395 | 22,574 | -19,639 |
| Woodcutting | 3,181 | 20,591 | -17,410 | 26,335 | -23,154 |
| Fishing | 3,425 | 23,767 | -20,342 | 30,381 | -26,956 |
| Mining | 3,964 | 26,834 | -22,870 | 34,634 | -30,670 |
| Attack | 4,728 | 10,555 | -5,827 | 15,123 | -10,395 |
| Strength | 4,966 | 27,636 | -22,670 | 35,495 | -30,529 |
| Ranged | 5,595 | 32,304 | -26,709 | 40,340 | -34,745 |
| Agility | 6,772 | 38,583 | -31,811 | 47,248 | -40,476 |
| Defence | 7,974 | 34,318 | -26,344 | 42,440 | -34,466 |
| Hitpoints | 17,058 | 31,338 | -14,280 | 39,330 | -22,272 |
| Overall | 35,916 | 38,583 | -2,667 | 47,248 | -11,332 |
| Quest Points | 145 QP by 1,022,261 | never 145 (142 QP in the table) | NEVER | never | NEVER |
| Equipment, Bank, Runite | no clock | 61,834-62,809 | target unknown | 108,812-110,817 | target unknown |

Worst five boards (realistic slack): Agility -40,476, Ranged -34,745, Defence -34,466, Mining -30,670,
Strength -30,529. At floor: Agility -31,811, Ranged -26,709, Defence -26,344, Mining -22,870, Strength -22,670.

### (b) With login wine, (c) all tricks

(b) is the same as (a): login wine is eligible, but the model has no row that uses it. (c) gives Overall 38,306
floor / 46,944 realistic, 277 / 304 ticks faster than (a): Magic is not a stun guest (teleports leave the
thieving spot), so stun relog saves ticks. Pyre logs are OUT (content bug).

### Each board alone (a fresh account that trains only this board first)

This is the specialist view (scenario c, travel on). It shows which leaders our methods can beat at all.

| Board | Deadline | Finish floor | Slack floor | Finish realistic | Slack realistic |
|---|---|---|---|---|---|
| Attack | 4,728 | 3,308 | **+1,420** | 6,145 | -1,417 |
| Defence | 7,974 | 12,186 | -4,212 | 15,200 | -7,226 |
| Strength | 4,966 | 8,107 | -3,141 | 11,268 | -6,302 |
| Hitpoints | 17,058 | 15,721 | **+1,337** | 20,091 | -3,033 |
| Ranged | 5,595 | 10,878 | -5,283 | 12,131 | -6,536 |
| Prayer | 1,281 | 11,232 | -9,951 | 12,844 | -11,563 |
| Magic | 1,324 | 3,010 | -1,686 | 3,760 | -2,436 |
| Cooking | 20 | 148 | -128 | 177 | -157 |
| Woodcutting | 3,181 | 2,996 | **+185** | 3,496 | -315 |
| Fletching | 57 | 64 | -7 | 72 | -15 |
| Fishing | 3,425 | 4,767 | -1,342 | 6,060 | -2,635 |
| Firemaking | 664 | 649 | **+15** | 790 | -126 |
| Crafting | 197 | 307 | -110 | 308 | -111 |
| Smithing | 1,337 | 1,444 | -107 | 1,448 | -111 |
| Mining | 3,964 | 4,433 | -469 | 5,880 | -1,916 |
| Herblore | 447 | 708 | -261 | 858 | -411 |
| Agility | 6,772 | 16,075 | -9,303 | 19,577 | -12,805 |
| Thieving | 2,935 | 9,806 | -6,871 | 13,292 | -10,357 |
| Runecraft | 2,354 | 1,588 | **+766** | 1,722 | **+632** |

Only Attack, Hitpoints, Woodcutting, Firemaking and Runecraft win alone at floor rates; only Runecraft wins alone at
realistic rates. Herblore alone loses: 708 / 858 against 447.
Cooking alone is 148 / 179: the legal route is tutorial 10, trade 5-12, walk 13, Cook's Assistant 12-28, 2-3 cooks
6-9, walk to Al Kharid bank 79, deposit and wine 3-6, timer 20-22.

## Timeline, scenario (a), realistic rates

Tick = Haggis playtime. "Walk" rows are travel legs (`walk A -> B` in `--order`). Full list: CLI `--order`.

| # | Activity | Start | End | Board stamped |
|---|---|---|---|---|
| 1 | Tutorial skip | 0 | 10 | |
| 2 | Trade 1: wine notes, Cook's Assistant items, stew and shrimp, fletching tips | 10 | 22 | |
| | Walk spawn -> Lumbridge kitchen (13) | 22 | 35 | |
| 3 | Cook's Assistant (Cooking 30) | 35 | 63 | |
| 4 | Stew, then shrimp, on the cook-o-matic range (Cooking 35) | 63 | 72 | |
| | Walk kitchen -> Al Kharid bank through the toll gate (79) | 72 | 151 | |
| 5 | Deposit wine notes, make 1 wine; timer lands 22 later | 151 | 157 | Cooking 179 |
| 6 | Fletch arrows only (no darts) | 157 | 207 | Fletching 207 |
| 7 | Cut gems, diamonds from 43 | 207 | 437 | Crafting 437 |
| 8 | Finish potions from dropped herbs | 437 | 1,217 | Herblore 1,217 |
| 9 | Burn logs | 1,217 | 1,997 | Firemaking 1,997 |
| 10 | Bury dragon bones to Prayer 31 | 1,997 | 2,009 | |
| 11 | Teleport ladder to Magic 99 (outside the pickpocket stuns) | 2,009 | 5,759 | Magic 5,759 |
| 12 | Smith platebodies at the Varrock West anvil (walk 151 before) | 5,910 | 7,226 | Smithing 7,226 |
| 13 | Runecraft, air then nature (walk 149 before) | 7,375 | 8,945 | Runecraft 8,945 |
| 14 | Tree Gnome Village, Agility 25, The Grand Tree, Fight Arena, Monkey Madness | 9,437 | 20,395 | Attack 15,162 |
| 15 | Pickpocket ladder | 20,515 | 22,613 | Thieving 22,613 |
| 16 | 3-tick woodcutting (Prayer inside) | 22,974 | 26,374 | Woodcutting 26,374, Prayer 26,479 |
| 17 | Sea Slug, fishing (Barbarian Village, then Catherby) | 26,825 | 30,420 | Fishing 30,420 |
| 18 | The Dig Site, power-mine iron | 30,768 | 34,673 | Mining 34,673 |
| 19 | Melee top-up to Strength 99, Dwarf Cannon | 34,867 | 36,805 | Strength 35,534 |
| 20 | Ranged + cannon, melee top-up to Defence 99 | 37,151 | 42,479 | Hitpoints 39,369, Ranged 40,379, Defence 42,479 |
| 21 | Wilderness course | 42,814 | 46,856 | Agility and Overall 46,856 |
| 22 | Witch's House, Waterfall, short quests, Dragon Slayer, Scorpion Catcher, Merlin, Grail, the rest of the quests | 47,143 | 108,400 | Quest Points 142 |
| 23 | Gear, bank wealth, Lava Maze runite | 108,400 | 110,425 | Equipment, Bank, Runite |

## Travel model

Source -> local consumer -> reuse -> check: the scheduler's existing deadline relaxation and route search -> the Overall planner, supply bill and launch check -> compare the usual order with a six-board relaxation and retain the earlier Overall finish -> a fixture checks both start locations and keeps the actual skill record deadlines. The bounded search in `.practice/hiscore-target/priority-beam.json` evaluates 999 deadline sets against a hashed snapshot and route model. The selected order is a model result.

- Each row of `haggis-boards.json` has `at` (a place, `anywhere`, or `bank` = the nearest bank), and may have
  `endAt`, `via` and `bankTrips`. The scheduler adds the walk from the player's place to the next row.
- Leg price: world.json `nearest.bank` run ticks (UberMouse, MIT, format 21) where the place has a site; else a
  path leg from the rs-sdk pathfinder (`travel-gen.ts`, offline, cached); else Chebyshev x 0.6. Each leg adds 2
  start ticks. Islands (Karamja, Entrana) add the boat (18 ticks, MEASURED practice for Karamja). The Al Kharid
  toll gate adds 10 ticks (ESTIMATE); gates behind a quest or skill are listed in the cache as `locked`.
- Running is 2 tiles per tick (`research/walking.md`: every measured leg is tiles / 2 + 1 to 6 ticks).
- Calibration against `research/walking.md` (MEASURED practice, 3 runs per leg): the rule "tiles / 2 + 2" is
  within 2.0% and 0.8% of the two legs whose tile counts were logged. The pathfinder legs are 2.5%, 2.8% and 5.4%
  short on the three legs that follow the shortest path, and 34% short on Port Sarim <-> GE, because the bench
  route goes through Lumbridge (474 tiles, not the 312 of the shortest path). The Chebyshev estimate is +4.0% to
  -17.3% on shortest-path legs. Reprint with `--travel`.
- Not in the model: teleports, fletching while walking, a place-aware order (EDF ignores places).

## Method and helper supplies per board

Counts come from the tier tables in `haggis.ts` (greedy best item per level, `planSkill` from `plan.ts`), scenario
(a); Herblore is a fixed drop mix in the row. Every row is stageable: no active row needs an item of the
`unsourceable` list in `haggis-boards.json` (`research/supply-logistics.md`). Item names for potion secondaries and enchant runes are the OSRS recipes (ESTIMATE); levels and XP are from
this server's config files.

| Board | Method | Helper supplies |
|---|---|---|
| Cooking | Cook's Assistant (Cooking 30), 1 stew and 1 shrimp on the cook-o-matic range (35), 1 hand-made wine at Al Kharid bank, 20-tick timer ferments the bank. The cocktail route is eligible | 600 noted unfermented wine, egg, bucket of milk, pot of flour, 3 uncooked stew, 2 raw shrimps, 10 coins (toll), 1 grapes, 1 jug of water |
| Fletching | Arrows only (15 per action), 5 per tick, all stackable. Darts are OUT: rune dart tips have no seller or shop | 3,615 headless arrows; arrowtips: bronze 60, iron 90, steel 135, mithril 240, adamant 495, rune 2,595 (shop only, about 6.3 h of restock) |
| Crafting | Gem cutting, 5 per tick, diamonds from 43. Dragonstones are OUT (crystal chest only) | Uncut: opal 5, jade 2, red topaz 2, sapphire 3, emerald 3, ruby 5, diamond 401 (10% margin; 365 without); chisel. GE bids, 4-7 days |
| Herblore | Unf potion + secondary, 14 per inventory, herbs from chaos-druid drops (1,080 herb rolls). Torstol, snapdragon and toadflax are OUT (no source at scale) | Unf: guam 270, harralander 119, ranarr 93, irit 68, avantoe 51, kwuarm 43; eye of newt 338, red spiders' eggs 119, snape grass 144, limpwurt root 43. About 2,420 kills, about 5.6 helper-hours |
| Firemaking | Burn logs, 4 ticks per log | Logs 27, oak 4, willow 7, maple 13, yew 25, magic 107; tinderbox |
| Prayer | Bury dragon bones, 2 ticks each | 560 dragon bones |
| Smithing | Platebodies, 5 ticks each | Bars: bronze 34, iron 35, steel 95, mithril 280, adamantite 345; hammer |
| Magic | Teleport ladder (Varrock 25 to Camelot 45-99), 4-5 ticks per cast (ESTIMATE), staff of air. Enchant is OUT: cosmic runes and dragonstone amulets have no source at scale | 722 law runes, 36 mind, 4 fire, 5 earth, 9 water runes; staff of air |
| Runecraft | Highest altar, helpers trade 27 essence per cycle | 4,213 rune essence; air, fire, body, nature, law talismans; about 8 helpers in rotation (runecraft-ladder.md) |
| Thieving | Pickpocket ladder, knights from 55 | 300 lobsters |
| Woodcutting | 3-tick knife + log | Rune axe, knife, 5 logs |
| Fishing | 3-tick fly fishing | Fly fishing rod, 800 feathers, knife, 20 logs |
| Mining | The Dig Site, then iron | Rune pickaxe |
| Attack, Strength, Defence | Quests (Waterfall, Tree Gnome Village, Grand Tree, Dragon Slayer, Scorpion Catcher, Holy Grail) + melee top-ups | Quest items (not listed yet), rune armour, anti-dragon shield, 60 lobsters |
| Ranged | Dwarf Cannon, ranged + cannon | Cannon set, 3,000 cannonballs, 5,000 rune arrows, maple shortbow |
| Agility | Grand Tree XP, Wilderness course | 50 lobsters |
| Hitpoints | Witch's House + combat | 200 lobsters |
| Equipment, Bank | Helpers trade in gear and wealth after the last 99 | Target values unknown (not in the snapshot) |
| Runite | Mine the 2 Lava Maze rocks | Rune pickaxe; #1 count unknown |

## What helpers must prepare before Haggis logs in

Haggis pays playtime for every tick it is logged in. Helpers pay nothing that counts. So all of this is ready, in
a helper's pack, next to the Lumbridge tutorial exit, before the first login:

1. **Trade 1 (one trade, 28 slots):** 600 noted unfermented wine, egg, bucket of milk, pot of flour, 3 uncooked
   stew, 2 raw shrimps, 10 coins, 1 grapes, 1 jug of water, and all fletching stock above (7 stack types).
2. **Trade loop for Crafting:** 401 uncut diamonds plus the lower gems, packed 27 per trade, with a chisel.
3. **Trade loop for Herblore:** 644 unf potions and 644 secondaries, 14 + 14 per trade.
4. **Logs, bones, bars, law runes and the staff of air:** packed per inventory, one helper per board, each standing at the next
   bank or anvil before Haggis arrives.
5. **Runecraft:** 4,213 essence and a rotation of about 8 helpers, plus all talismans in Haggis's pack.
6. **Gear:** rune axe, rune pickaxe, fly rod, knife, tinderbox, hammer, cannon, armour, 610 lobsters in total.

Wine supply is the hardest part: no shop sells grapes, and the live GE had 0 sellers (`cooking-board.md`).
Dragonstone, torstol, adamantite bar and cosmic rune also had 0 sellers on the live GE (`board-ranking.md`).
The staging plan per item, helper and hour is `research/supply-logistics.md`.

## Infeasible boards and why

| Board | Why it fails | By how much (floor / realistic) |
|---|---|---|
| Cooking | Legal route: tutorial, trade, Cook's Assistant, 2 cooks, walk to a bank (79), wine timer. The leader (38) used the login wine or the cocktails, both content bugs | -110 / -141 (alone the same) |
| Fletching | 49-55 ticks of actions after a 15-22 tick start. The leader's 58 total is below our start + action floor | -6 / -19 alone |
| Magic, Thieving, Mining | Slower than the leader even as the first board. Magic: teleports, because enchant needs cosmic runes and dragonstone amulets that have no source at scale | -1,686, -6,871, -469 at floor alone |
| Herblore, Crafting | Supply-bound: no legal torstol, snapdragon, toadflax or dragonstone at scale (`research/supply-logistics.md`). Drop herbs (630 / 780) and diamonds (229 / 230) are slower than the leaders (447, 197) | -261 / -411 and -110 / -111 alone |
| Firemaking, Prayer, Smithing, Runecraft | Win alone at floor, but each one comes after 300-6,000 ticks of earlier boards | see table (a) |
| Woodcutting to Defence | Each needs 3,000-7,000 ticks and comes after 9,000+ ticks of earlier boards | -9,338 to -27,910 at floor |
| Overall | Late at both rates with every safe lever and the stageable supply rows | -2,667 / -11,332 (a, b); -2,390 / -11,028 (c) |

## Unknowns and the experiment that closes each

| Number | Value | Evidence | Experiment |
|---|---|---|---|
| Tutorial skip | 10 | MEASURED | Re-measure on the live server; check Haggis's current playtime (claimed and logged out on the first tick) |
| Trade of 28 stacks | 5 / 12 | floor ESTIMATE, realistic MEASURED | Pre-opened trade, helper accepts on the same tick, 3 runs |
| Cooking to 35, legal | Cook's Assistant 12 / 28 + 2-3 cooks 6 / 9 | ESTIMATE / CODE-READ | Cook's Assistant with burst dialogue and the cook-o-matic cooks from a fresh account, 3 runs |
| Travel legs | 4,545 + 1,095 inside rows | path model, calibrated on MEASURED practice | Time 3 of the long legs (Varrock East mine -> Almera, Ardougne -> Draynor, Lumbridge -> Ardougne) with walkPath |
| Fletching action ticks | 49 / 55 | CODE-READ | Fletch the full ladder with `s.direct` at 5 per tick, 3 runs |
| Crafting, diamonds from 43 | 229 / 230 | ESTIMATE (MEASURED 194 / 195 with dragonstones + 35) | Practice run of the diamond ladder, 3 runs |
| Herblore, drop herbs | 630 / 780 | ESTIMATE (MEASURED 246 with torstol; realistic adds the main's identify and mix) | Practice run of the substituted herb set, 3 runs; kill rate of chaos druids, 3 runs |
| Magic, teleports | 3,000 / 3,750 | ESTIMATE (CODE-READ teleport.rs2 p_delay) | Teleport ladder cast rate, 3 runs |
| Firemaking, Prayer, Smithing, Magic | sims 628-1,708 | CODE-READ | `research/supply-floors.md` (in progress) |
| Runecraft | 1,256 / 2,976 | ESTIMATE / MEASURED | Helper rotation trip time |
| Thieving | 3,850 / 6,169 | MEASURED | Knight 2-tick rhythm with courier food, fresh account |
| Woodcutting, Fishing | 2,900-3,600 | ESTIMATE | Full 1-99 runs with the 3-tick methods |
| Mining | 97-120 XP/tick | MEASURED / CODE-READ | Find the leader's method (needs about 250 XP/tick) |
| Every quest | 300-4,000 ticks | ESTIMATE | Time each route quest with a test account; quests are about 37% of the realistic clock to Overall (25,000 of 68,214) |
| Ranged + cannon | 400-600 XP/tick | ESTIMATE | Cannon + ranged at one spot for 300 ticks, 3 runs |
| Combat top-ups | 250-400 XP/tick, 83-133 HP XP/tick | ESTIMATE | Melee at a safespot for 300 ticks |
| Agility | 167-224 XP/tick | ESTIMATE | Wilderness course laps, 3 runs (PvP risk) |
| Equipment, Bank, Runite #1 values | unknown | none | Read the three boards; `research/boards-special.md` (in progress) |

**Top 5 experiments** (each one can move a board in the best set):
1. A legal torstol or dragonstone source at scale (none found in rev 289): decides Herblore and Crafting. Without
   one, the substituted herb set (3 practice runs) only prices the loss.
2. Dwarf Cannon quest time and cannon + ranged XP per tick: decides Ranged and Hitpoints.
3. Crafting tight bank cycle and one-step dialog clearing: decides Crafting (floor +107, realistic -26 alone).
4. Platebody cycle at an anvil fed by trade: decides Smithing (alone +414 / +227).
5. Durations of the 8 short quests and Witch's House: decides Hitpoints and every quest-fed combat board.

## Decisions the owner must make

1. **Compare login wine and stun relog in the current route.** Both are authorized. Use the current planner and measured runtime before choosing.
2. **Wilderness risk for Haggis.** The Agility route (Wilderness course), the Lava Maze runite board and the chaos
   altar are in PvP areas. A death can lose the worn best-in-slot set. Decide if Haggis goes there, and if it goes
   before or after the gear for the Equipment board is worn.

## How to update

Edit numbers in `packages/planner/src/haggis-boards.json` (keep `evidence` and `source`), then rerun the CLI.
Rows with a `pending` field wait for `research/supply-floors.md` or `research/boards-special.md`. Neither file
existed when this was written, so those rows stay ESTIMATE or CODE-READ.
