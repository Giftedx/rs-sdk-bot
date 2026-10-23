# Haggis run: 24-board schedule (2026-10-23)

Model: `packages/planner/src/haggis.ts`. Inputs: `packages/planner/src/haggis-boards.json` (each number has
`evidence` and `source`). Deadlines: `research/hiscores-2026-10-22.json`, row 1 of each board.
Reprint every table here with `bun packages/planner/src/haggis-cli.ts --order --supplies --evidence`.

## Verdict

**Rank 1 on all 24 boards at once is not possible under the board rules.** The numbers:

- Every skill board stamps the account's total playtime at the level-up (`Player.ts:1904-1905`,
  `LoginServer.ts:155-181`). One account has one clock. Each board that Haggis trains adds its ticks to the stamp
  of every board that comes after it.
- The Overall #1 (`stunbaron`) has all 19 skills at 99 in 35,916 ticks. Haggis needs the sum of all 19 skill routes
  below that. At **floor** rates (best case, mostly code-read) the sum is 39,704-40,263 ticks. Overall is late by
  3,788-4,347 ticks even if every unmeasured number is at its best case. At realistic rates it is late by about
  31,000 ticks.
- All 20 clock boards (19 skills + Overall) are late in every scenario at realistic rates. At floor rates, 18 of 20
  are late in the EDF order (only Crafting and Herblore win).
- The unapproved tricks change almost nothing. Login wine saves 1 tick on Cooking (still late by 1 at floor). Stun
  relog saves 560-900 ticks on Thieving (still late by 6,273). Sacred oil is never chosen: the Mort'ton quest
  stage costs more than it saves.

**Best achievable set** (largest set of boards that can all win, generalised Moore-Hodgson in `bestSet`):

| Rates | Boards Haggis wins | Count |
|---|---|---|
| Floor (best case) | Crafting, Herblore, Smithing, Ranged, Hitpoints, Quest Points + Equipment, Bank, Runite (no clock, targets unknown) | 6 + 3 |
| Realistic | Herblore, Ranged, Quest Points + Equipment, Bank, Runite (targets unknown) | 3 + 3 |

The set is the same in all three scenarios. Order for the floor set: tutorial (10), gems (to 90), potions (to 185),
platebodies (to 1,098), Dwarf Cannon + ranged/cannon (to 3,063), short quests + combat to Hitpoints 99 (10,273),
then every other skill, then the rest of the quests.

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

Slack = deadline - finish. Positive = Haggis beats #1. All three scenarios use EDF order with prerequisites.

### (a) No unapproved tricks

| Board | Deadline | Finish floor | Slack floor | Finish realistic | Slack realistic |
|---|---|---|---|---|---|
| Cooking | 38 | 39 | -1 | 52 | -14 |
| Fletching | 58 | 68 | -10 | 85 | -27 |
| Crafting | 197 | 148 | **+49** | 298 | -101 |
| Herblore | 447 | 243 | **+204** | 604 | -157 |
| Firemaking | 673 | 871 | -198 | 1,324 | -651 |
| Prayer | 1,281 | 2,040 | -759 | 2,624 | -1,343 |
| Smithing | 1,337 | 2,953 | -1,616 | 3,724 | -2,387 |
| Magic | 1,513 | 4,661 | -3,148 | 5,624 | -4,111 |
| Runecraft | 2,354 | 5,917 | -3,563 | 8,600 | -6,246 |
| Thieving | 2,935 | 9,767 | -6,832 | 14,769 | -11,834 |
| Woodcutting | 3,329 | 12,667 | -9,338 | 18,169 | -14,840 |
| Fishing | 3,425 | 15,717 | -12,292 | 21,769 | -18,344 |
| Mining | 3,964 | 21,532 | -17,568 | 29,742 | -25,778 |
| Attack | 4,728 | 23,932 | -19,204 | 35,742 | -31,014 |
| Strength | 4,966 | 28,190 | -23,224 | 47,934 | -42,968 |
| Ranged | 5,595 | 30,155 | -24,560 | 51,331 | -45,736 |
| Agility | 6,772 | 33,709 | -26,937 | 56,099 | -49,327 |
| Defence | 7,974 | 35,884 | -27,910 | 61,198 | -53,224 |
| Hitpoints | 17,058 | 40,263 | -23,205 | 68,214 | -51,156 |
| Overall | 35,916 | 40,263 | -4,347 | 68,214 | -32,298 |
| Quest Points | 145 QP by 1,022,261 | 56,263 (142 QP; stale row, see the rule above) | rerun needed | 116,214 | rerun needed |
| Equipment, Bank, Runite | no clock | after QP | target unknown | after QP | target unknown |

### (b) With login wine

Same as (a) except: Cooking 39 / 51 (slack -1 / -13), and every later board 1 tick earlier at realistic rates.
Overall 40,263 / 68,213.

### (c) All tricks optional (login wine, stun relog, sacred oil)

Same as (b) except Thieving and every later board. Thieving 9,208 / 13,872 (slack -6,273 / -10,937). Overall
39,704 / 67,317 (slack -3,788 / -31,401). Sacred oil is not chosen: the Mort'ton stage (800-2,000 ticks) plus pyre
logs (250-330) is slower than burning (628-720).

### Each board alone (a fresh account that trains only this board first)

This is the specialist view. It shows which leaders our methods can beat at all.

| Board | Deadline | Floor | Realistic | Board | Deadline | Floor | Realistic |
|---|---|---|---|---|---|---|---|
| Cooking | 38 | -1 | -13 | Thieving | 2,935 | -366 | -2,348 |
| Fletching | 58 | -6 | -19 | Woodcutting | 3,329 | +419 | -81 |
| Crafting | 197 | +107 | -26 | Fishing | 3,425 | +365 | -185 |
| Herblore | 447 | +342 | **+131** | Mining | 3,964 | -2,057 | -4,272 |
| Firemaking | 673 | +35 | -57 | Attack | 4,728 | +2,236 | -1,404 |
| Prayer | 1,281 | +102 | -29 | Strength | 4,966 | +89 | -8,748 |
| Smithing | 1,337 | +414 | **+227** | Ranged | 5,595 | +3,620 | **+2,188** |
| Magic | 1,513 | -205 | -397 | Agility | 6,772 | +1,326 | -2,628 |
| Runecraft | 2,354 | +1,088 | -632 | Defence | 7,974 | +1,289 | -9,835 |
| | | | | Hitpoints | 17,058 | +8,937 | **+1,535** |

Cooking, Fletching, Magic, Thieving and Mining lose even alone at floor rates. The leaders use a method that our
data does not have. Mining needs about 250 XP per tick for 3,964 ticks; our measured cap is 97-120.

## Timeline, scenario (a), realistic rates

Tick = Haggis playtime. "Lands" = when the XP arrives (a timer lands later than its foreground part ends).

| # | Activity | Start | End | Lands | Board stamped |
|---|---|---|---|---|---|
| 1 | Tutorial skip | 0 | 10 | | |
| 2 | Trade 1: wine notes, cocktails, all fletching tips | 10 | 22 | | |
| 3 | Bank: deposit wine notes | 22 | 27 | | |
| 4 | 8 cocktails to Cooking 35, make 1 wine | 27 | 30 | | |
| 5 | Wine timer (background) | 30 | 30 | 52 | Cooking 52 |
| 6 | Fletch arrows and darts, inside the wine timer | 30 | 85 | | Fletching 85 |
| 7 | Cut gems | 85 | 298 | | Crafting 298 |
| 8 | Finish potions | 298 | 604 | | Herblore 604 |
| 9 | Burn logs | 604 | 1,324 | | Firemaking 1,324 |
| 10 | Bury dragon bones | 1,324 | 2,624 | | Prayer 2,624 |
| 11 | Smith platebodies | 2,624 | 3,724 | | Smithing 3,724 |
| 12 | Enchant jewellery | 3,724 | 5,624 | | Magic 5,624 |
| 13 | Runecraft, essence traded in | 5,624 | 8,600 | | Runecraft 8,600 |
| 14 | Pickpocket ladder | 8,600 | 14,769 | | Thieving 14,769 |
| 15 | 3-tick woodcutting | 14,769 | 18,169 | | Woodcutting 18,169 |
| 16 | 3-tick fishing | 18,169 | 21,769 | | Fishing 21,769 |
| 17 | Gnome course to Agility 25 | 21,769 | 21,891 | | |
| 18 | The Dig Site (382,500 Mining) | 21,891 | 23,391 | | |
| 19 | Power-mine iron | 23,391 | 29,742 | | Mining 29,742 |
| 20 | Waterfall, Tree Gnome Village, The Grand Tree | 29,742 | 35,742 | | Attack 35,742 |
| 21 | 8 short quests to 32 QP, Dragon Slayer, Scorpion Catcher, melee top-up | 35,742 | 47,934 | | Strength 47,934 |
| 22 | Dwarf Cannon, ranged + cannon | 47,934 | 51,331 | | Ranged 51,331 |
| 23 | Wilderness course (Grand Tree XP already gave Agility 52+) | 51,331 | 56,099 | | Agility 56,099 |
| 24 | Merlin's Crystal, Holy Grail, melee top-up | 56,099 | 61,198 | | Defence 61,198 |
| 25 | Combat top-up | 61,198 | 68,214 | | Hitpoints and Overall 68,214 |
| 26 | About 40 more quests (88 QP) | 68,214 | 116,214 | | Quest Points 142 |
| 27 | Wear best-in-slot gear, receive bank wealth | 116,214 | 116,274 | | Equipment, Bank |
| 28 | Lava Maze runite (placeholder 10 ores) | 116,274 | 117,774 | | Runite |

## Method and helper supplies per board

Counts come from the tier tables in `haggis.ts` (greedy best item per level, `planSkill` from `plan.ts`), scenario
(a). Item names for potion secondaries and enchant runes are the OSRS recipes (ESTIMATE); levels and XP are from
this server's config files.

| Board | Method | Helper supplies |
|---|---|---|
| Cooking | 8 cocktail finishes to 35 (1,500 XP each, `gnome_cocktail_finish.rs2:28-29`, no level check), 1 hand-made wine, 20-tick timer ferments the bank | 600 noted unfermented wine, 8 unfinished pineapple punch (stage 3) + 8 orange slices, 1 grapes, 1 jug of water |
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

1. **Trade 1 (one trade, 28 slots, all stackable):** 600 noted unfermented wine, 8 unfinished pineapple punch
   (stage 3), 8 orange slices, 1 grapes, 1 jug of water, and all fletching stock above (9 stack types).
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
| Cooking | Tutorial 10 + trade 5-12 + bank 2-5 + 20-tick timer. The leader beats this by 1 tick, so its trade or tutorial is faster | -1 / -13 (alone the same) |
| Fletching | 49-55 ticks of actions after a 15-22 tick start. The leader's 58 total is below our start + action floor | -6 / -19 alone |
| Magic, Thieving, Mining | Slower than the leader even as the first board | -205, -366, -2,057 at floor alone |
| Firemaking, Prayer, Smithing, Runecraft | Win alone at floor, but each one comes after 300-6,000 ticks of earlier boards | see table (a) |
| Woodcutting to Defence | Each needs 3,000-7,000 ticks and comes after 9,000+ ticks of earlier boards | -9,338 to -27,910 at floor |
| Overall | Sum of the 19 routes is above 35,916 even at floor | -3,788 / -31,401 (scenario c) |

## Unknowns and the experiment that closes each

| Number | Value now | Evidence | Experiment |
|---|---|---|---|
| Tutorial skip | 10 | MEASURED | Re-measure on the live server; check Haggis's current playtime (claimed and logged out on the first tick) |
| Trade of 28 stacks | 5 / 12 | floor ESTIMATE, realistic MEASURED | Pre-opened trade, helper accepts on the same tick, 3 runs |
| Cooking to 35 by cocktails | 2-3 ticks | CODE-READ | 8 cocktail finishes from a fresh account, 3 runs; check the stage-3 item is tradeable |
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
