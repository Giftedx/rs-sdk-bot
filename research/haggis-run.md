# Haggis run: 24-board schedule (2026-10-23)

Model: `packages/planner/src/haggis.ts` with travel (`packages/planner/src/travel.ts`). Inputs:
`packages/planner/src/haggis-boards.json` (each number has `evidence` and `source`; each row has a place) and the leg
cache `packages/planner/src/haggis-travel.json`. Deadlines: `research/hiscores-live.json` (taken 2026-10-23T08:26:19.899Z), row 1
of each board. Reprint every table here with
`bun packages/planner/src/haggis-cli.ts research/hiscores-live.json --order --supplies --evidence --levers --travel`.

## Verdict

**Rank 1 on all 24 boards at once is not possible under the board rules.** The numbers:

- Every skill board stamps the account's total playtime at the level-up (`Player.ts:1904-1905`,
  `LoginServer.ts:155-181`). One account has one clock. Each board that Haggis trains adds its ticks to the stamp
  of every board that comes after it.
- The Overall #1 (`stunbaron`) has all 19 skills at 99 in 35,916 ticks. With every safe lever, the travel legs and
  the legal Cooking route (2026-10-23), Haggis reaches Overall at **34,208 ticks at floor rates (slack +1,708)** and
  **44,089 at realistic rates (slack -8,173)**. ESTIMATE (the model; most rows are code-read or rival figures).
- Travel adds 5,640 ticks before the last 99 (4,545 of walks between rows, 1,095 of walks inside rows: bank trips,
  altar and fishing-spot changes). The same table without travel (`--no-travel`) gives 28,568 / 38,449. The rival
  plan prices 2,283 of legs and about 1,789 of allowances (`research/rival-gap-list.md`). Our legs are longer
  because the EDF order does not group rows by place and the model has no teleports.
- At floor rates 18 of 20 clock boards are late in the EDF order (only Herblore and Overall win). At realistic
  rates all 20 are late.
- The three scenarios now give the same numbers. Login wine, the cocktail route to Cooking 35, pyre logs and
  Charge spam are content bugs (owner rule) and are marked OUT in the table; stun relog changes nothing in this
  order.

**Best achievable set** (largest set of boards that can all win, generalised Moore-Hodgson in `bestSet`):

| Rates | Boards Haggis wins | Count |
|---|---|---|
| Floor (best case) | Overall, Defence, Hitpoints, Runecraft + Equipment, Bank, Runite (no clock, targets unknown) | 4 + 3 |
| Realistic | Runecraft + Equipment, Bank, Runite (targets unknown) | 1 + 3 |

The set is the same in all three scenarios. Quest Points cannot win: the #1 has all 145 QP (see the rule below).

## Board rules used

| Board | Rule | Source |
|---|---|---|
| 19 skills | Level desc, then playtime at the level-up | `RankedHiscoresWorker.ts:19`, `Player.ts:1905`, `LoginServer.ts:155-181` |
| Overall | Total level desc, then playtime at the last level-up | `LoginServer.ts:120-150` |
| Quest Points | Points desc, then playtime ascending, stamped at the save after the total changed (`RankedHiscoresWorker.ts:19`, `LoginServer.ts:200-216`). Corrected 2026-10-23: #1 `avery` now has 145 of 145 at 1,022,262 ticks, so the only win is all 145 QP saved at 1,022,261 ticks or less (research/quest-plan.md, research/boards-special.md) | `hiscores.ts:313`; `quest.constant:72-139` |
| Equipment | Worn value desc. No clock | `hiscores.ts:620` |
| Bank | Bank value desc. No clock | `hiscores.ts:981` |
| Lava Maze Runite | Ore count desc, ties by first to reach it. All-time, 7-day and 24-hour windows | `hiscores.ts:781-828` |

A board where Haggis ties the #1 time is not counted as a win (the order of equal rows is not defined).

## Scenario tables

Slack = deadline - finish. Positive = Haggis beats #1. All three scenarios use EDF order with prerequisites, all
safe levers on, owner levers off, travel on.

### (a) No unapproved tricks

| Board | Deadline | Finish floor | Slack floor | Finish realistic | Slack realistic |
|---|---|---|---|---|---|
| Cooking | 38 | 148 | -110 | 179 | -141 |
| Fletching | 58 | 177 | -119 | 212 | -154 |
| Crafting | 197 | 257 | -60 | 425 | -228 |
| Herblore | 447 | 352 | **+95** | 731 | -284 |
| Firemaking | 664 | 980 | -316 | 1,451 | -787 |
| Prayer | 1,281 | 18,847 | -17,566 | 23,942 | -22,661 |
| Magic | 1,324 | 15,471 | -14,147 | 20,036 | -18,712 |
| Smithing | 1,337 | 2,693 | -1,356 | 3,354 | -2,017 |
| Runecraft | 2,354 | 4,278 | -1,924 | 5,073 | -2,719 |
| Thieving | 2,935 | 14,433 | -11,498 | 18,741 | -15,806 |
| Woodcutting | 3,181 | 18,732 | -15,551 | 23,797 | -20,616 |
| Fishing | 3,425 | 21,817 | -18,392 | 27,883 | -24,458 |
| Mining | 3,964 | 24,884 | -20,920 | 32,136 | -28,172 |
| Attack | 4,728 | 7,658 | -2,930 | 11,290 | -6,562 |
| Strength | 4,966 | 26,413 | -21,447 | 33,672 | -28,706 |
| Ranged | 5,595 | 28,737 | -23,142 | 37,383 | -31,788 |
| Agility | 6,772 | 32,626 | -25,854 | 41,760 | -34,988 |
| Defence | 7,974 | 34,208 | -26,234 | 44,089 | -36,115 |
| Hitpoints | 17,058 | 28,094 | -11,036 | 36,418 | -19,360 |
| Overall | 35,916 | 34,208 | **+1,708** | 44,089 | -8,173 |
| Quest Points | 145 QP by 1,022,261 | never 145 (142 QP in the table) | NEVER | never | NEVER |
| Equipment, Bank, Runite | no clock | 55,608-56,583 | target unknown | 105,440-107,445 | target unknown |

Worst five boards (realistic slack): Defence -36,115, Agility -34,988, Ranged -31,788, Strength -28,706,
Mining -28,172. At floor: Defence -26,234, Agility -25,854, Ranged -23,142, Strength -21,447, Mining -20,920.

### (b) With login wine, (c) all tricks

Same as (a). Login wine and pyre logs are OUT (content bugs), so the tricks have no row to use. Stun relog is
not chosen: the stun guests use more stun ticks than relog saves.

### Each board alone (a fresh account that trains only this board first)

This is the specialist view (scenario c, travel on). It shows which leaders our methods can beat at all.

| Board | Deadline | Finish floor | Slack floor | Finish realistic | Slack realistic |
|---|---|---|---|---|---|
| Attack | 4,728 | 3,934 | **+794** | 6,557 | -1,829 |
| Defence | 7,974 | 5,811 | **+2,163** | 10,479 | -2,505 |
| Strength | 4,966 | 6,257 | -1,291 | 10,417 | -5,451 |
| Hitpoints | 17,058 | 10,403 | **+6,655** | 17,931 | -873 |
| Ranged | 5,595 | 2,776 | **+2,819** | 4,163 | **+1,432** |
| Prayer | 1,281 | 7,687 | -6,406 | 9,012 | -7,731 |
| Magic | 1,324 | 35,728 | -34,404 | 47,358 | -46,034 |
| Cooking | 38 | 148 | -110 | 179 | -141 |
| Woodcutting | 3,181 | 2,996 | **+185** | 3,496 | -315 |
| Fletching | 58 | 64 | -6 | 77 | -19 |
| Fishing | 3,425 | 4,072 | -647 | 5,514 | -2,089 |
| Firemaking | 664 | 638 | **+26** | 730 | -66 |
| Crafting | 197 | 158 | **+39** | 291 | -94 |
| Smithing | 1,337 | 1,685 | -348 | 1,872 | -535 |
| Mining | 3,964 | 4,433 | -469 | 5,880 | -1,916 |
| Herblore | 447 | 173 | **+274** | 384 | **+63** |
| Agility | 6,772 | 6,507 | **+265** | 9,611 | -2,839 |
| Thieving | 2,935 | 10,083 | -7,148 | 13,596 | -10,661 |
| Runecraft | 2,354 | 1,588 | **+766** | 1,722 | **+632** |

Cooking, Fletching, Strength, Prayer, Magic, Smithing, Fishing, Mining and Thieving lose even alone at floor rates.
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
| 6 | Fletch arrows and darts | 157 | 212 | Fletching 212 |
| 7 | Cut gems | 212 | 425 | Crafting 425 |
| 8 | Finish potions | 425 | 731 | Herblore 731 |
| 9 | Burn logs | 731 | 1,451 | Firemaking 1,451 |
| 10 | Smith platebodies at the Varrock West anvil (incl. 640 of bank trips; walk 151 before) | 1,614 | 3,354 | Smithing 3,354 |
| 11 | Runecraft, air then nature (incl. 240 of walk and boat; walk 149 before) | 3,503 | 5,073 | Runecraft 5,073 |
| 12 | Tree Gnome Village, Agility 25, The Grand Tree, Fight Arena, Monkey Madness | 5,565 | 16,523 | |
| 13 | Pickpocket ladder (Magic enchants inside the stuns) | 16,643 | 18,741 | Thieving 18,741, Magic 20,036 |
| 14 | 3-tick woodcutting (Prayer inside) | 20,397 | 23,797 | Woodcutting 23,797, Prayer 23,942 |
| 15 | Sea Slug, fishing (Barbarian Village, then Catherby) | 24,288 | 27,883 | Fishing 27,883 |
| 16 | The Dig Site, power-mine iron | 28,231 | 32,136 | Mining 32,136 |
| 17 | Waterfall, Dwarf Cannon | 32,635 | 34,540 | Strength 33,672 |
| 18 | Ranged + cannon | 34,886 | 37,383 | Hitpoints 36,418, Ranged 37,383 |
| 19 | Wilderness course | 37,718 | 41,760 | Agility 41,760 |
| 20 | Melee top-up to Defence 99 | 42,095 | 44,089 | Defence and Overall 44,089 |
| 21 | Witch's House, short quests, Dragon Slayer, Scorpion Catcher, Merlin, Grail, the rest of the quests | 44,153 | 105,420 | Quest Points 142 |
| 22 | Gear, bank wealth, Lava Maze runite | 105,420 | 107,445 | Equipment, Bank, Runite |

## Travel model (2026-10-23)

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
(a). Item names for potion secondaries and enchant runes are the OSRS recipes (ESTIMATE); levels and XP are from
this server's config files.

| Board | Method | Helper supplies |
|---|---|---|
| Cooking | Cook's Assistant (Cooking 30), 1 stew and 1 shrimp on the cook-o-matic range (35), 1 hand-made wine at Al Kharid bank, 20-tick timer ferments the bank. The cocktail route is OUT (no level check) | 600 noted unfermented wine, egg, bucket of milk, pot of flour, 3 uncooked stew, 2 raw shrimps, 10 coins (toll), 1 grapes, 1 jug of water |
| Fletching | Arrows (15 per action) and darts (10 per action), 5 per tick, all stackable | 1,290 headless arrows, 2,360 feathers, arrowtips: bronze 60, iron 45, steel 135, mithril 240, adamant 495, rune 315; dart tips: iron 40, rune 1,520 |
| Crafting | Gem cutting, 5 per tick | Uncut: opal 5, jade 2, red topaz 2, sapphire 3, emerald 3, ruby 5, diamond 11, dragonstone 305 (10% margin); chisel |
| Herblore | Unf potion + secondary, 5 per tick | 176 torstol (unf) + 176 jangerberries; about 90 lower-tier unf + secondary pairs (CLI `--supplies`) |
| Firemaking | Burn logs, 4 ticks per log | Logs 27, oak 4, willow 7, maple 13, yew 25, magic 107; tinderbox |
| Prayer | Bury dragon bones, 2 ticks each | 560 dragon bones |
| Smithing | Platebodies, 5 ticks each | Bars: bronze 34, iron 35, steel 95, mithril 280, adamantite 345; hammer |
| Magic | Enchant ladder, 3 ticks per cast | 546 cosmic, 6,807 water, 7,175 earth, 86 air, 80 fire, 5 mind runes; 12 sapphire, 27 emerald, 16 ruby, 38 diamond rings; 453 dragonstone amulets |
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
   stew, 2 raw shrimps, 10 coins, 1 grapes, 1 jug of water, and all fletching stock above (9 stack types).
2. **Trade loop for Crafting:** 305 uncut dragonstones plus the lower gems, packed 27 per trade, with a chisel.
3. **Trade loop for Herblore:** about 266 unf potions and 266 secondaries, 14 + 14 per trade.
4. **Logs, bones, bars, jewellery, runes:** packed per inventory, one helper per board, each standing at the next
   bank or anvil before Haggis arrives.
5. **Runecraft:** 4,213 essence and a rotation of about 8 helpers, plus all talismans in Haggis's pack.
6. **Gear:** rune axe, rune pickaxe, fly rod, knife, tinderbox, hammer, cannon, armour, 610 lobsters in total.

Wine supply is the hardest part: no shop sells grapes, and the live GE had 0 sellers (`cooking-board.md`).
Dragonstone, torstol, adamantite bar and cosmic rune also had 0 sellers on 2026-10-22 (`board-ranking.md`).
`research/supply-costs.md` will replace these notes when it lands.

## Infeasible boards and why

| Board | Why it fails | By how much (floor / realistic) |
|---|---|---|
| Cooking | Legal route: tutorial, trade, Cook's Assistant, 2 cooks, walk to a bank (79), wine timer. The leader (38) used the login wine or the cocktails, both content bugs | -110 / -141 (alone the same) |
| Fletching | 49-55 ticks of actions after a 15-22 tick start. The leader's 58 total is below our start + action floor | -6 / -19 alone |
| Magic, Thieving, Mining | Slower than the leader even as the first board | -205, -366, -2,057 at floor alone |
| Firemaking, Prayer, Smithing, Runecraft | Win alone at floor, but each one comes after 300-6,000 ticks of earlier boards | see table (a) |
| Woodcutting to Defence | Each needs 3,000-7,000 ticks and comes after 9,000+ ticks of earlier boards | -9,338 to -27,910 at floor |
| Overall | Wins at floor with every safe lever; late at realistic rates | +1,708 / -8,173 (all scenarios) |

## Unknowns and the experiment that closes each

| Number | Value now | Evidence | Experiment |
|---|---|---|---|
| Tutorial skip | 10 | MEASURED | Re-measure on the live server; check Haggis's current playtime (claimed and logged out on the first tick) |
| Trade of 28 stacks | 5 / 12 | floor ESTIMATE, realistic MEASURED | Pre-opened trade, helper accepts on the same tick, 3 runs |
| Cooking to 35, legal | Cook's Assistant 12 / 28 + 2-3 cooks 6 / 9 | ESTIMATE / CODE-READ | Cook's Assistant with burst dialogue and the cook-o-matic cooks from a fresh account, 3 runs |
| Travel legs | 4,545 + 1,095 inside rows | path model, calibrated on MEASURED practice | Time 3 of the long legs (Varrock East mine -> Almera, Ardougne -> Draynor, Lumbridge -> Ardougne) with walkPath |
| Fletching action ticks | 49 / 55 | CODE-READ | Fletch the full ladder with `s.direct` at 5 per tick, 3 runs |
| Crafting | 80 / 213 | CODE-READ / MEASURED | Tight bank cycle and level-up dialog clearing (`crafting-board.md`) |
| Herblore | 95 / 306 | ESTIMATE | Bank cycle with 14 + 14, 3 runs |
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
1. Herblore bank cycle with 14 + 14: decides Herblore (floor +342, realistic +131 alone).
2. Dwarf Cannon quest time and cannon + ranged XP per tick: decides Ranged and Hitpoints.
3. Crafting tight bank cycle and one-step dialog clearing: decides Crafting (floor +107, realistic -26 alone).
4. Platebody cycle at an anvil fed by trade: decides Smithing (alone +414 / +227).
5. Durations of the 8 short quests and Witch's House: decides Hitpoints and every quest-fed combat board.

## Decisions the owner must make

1. **SUPERSEDED 2026-10-23: the goal is not up for change** (owner: "the goal is the goal", "do not lower the bar"). The infeasibility below is a gap to close, not a decision point; research/gap-closers.md already turns Overall into a win at floor rates. Original text kept for the record. Options:
   (a) Haggis takes the best set (3-6 skill boards + Quest Points + the 3 value boards), or (b) fresh specialist
   accounts take the boards that win alone (14 at floor rates, 4 at realistic rates), and Haggis takes Quest Points, Equipment,
   Bank and Runite.
2. **Drop login wine and stun relog.** Neither one changes which boards win (login wine saves 1 tick; Cooking is
   still late). Recommend: report the wine bug (`bug-report-wine-login.md`) and do not use either trick on Haggis.
3. **Wilderness risk for Haggis.** The Agility route (Wilderness course), the Lava Maze runite board and the chaos
   altar are in PvP areas. A death can lose the worn best-in-slot set. Decide if Haggis goes there, and if it goes
   before or after the gear for the Equipment board is worn.

## How to update

Edit numbers in `packages/planner/src/haggis-boards.json` (keep `evidence` and `source`), then rerun the CLI.
Rows with a `pending` field wait for `research/supply-floors.md` or `research/boards-special.md`. Neither file
existed when this was written, so those rows stay ESTIMATE or CODE-READ.
