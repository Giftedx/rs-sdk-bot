# Agility gap: least ticks to 99 inside the Haggis run, and what closes the gap

Date: 2026-10-23. Boards: Agility, Overall (and every clock board, through the order trade-off).
Evidence: planner runs on the committed rows (MEASURED Agility rates) + CODE-READ of `vendor/lostcity-content`.
No live logins and no practice bots were used for this file. All planner numbers are from the committed
rows at HEAD 65230a9 (`git show HEAD:packages/planner/src/haggis-boards.json`). Another agent's uncommitted rows in
the working tree move the baseline to 40,213 / 44,956; the Agility rows are the same in both.

## Result

- **#1 is stunagile at 6,772 ticks** (`research/hiscores-live.json`, taken 2026-10-23T16:56Z). The deadline rule is
  finish tick < deadline (`packages/planner/src/haggis.ts:96`).
- **Agility last (the current plan): Agility 99 at 40,016 floor / 44,859 realistic**, gap -33,244 / -38,087
  (`bun packages/planner/src/haggis-cli.ts research/hiscores-live.json`, scenario a).
- **Least ticks inside the whole run: Agility first, pure laps: 6,665 floor / 7,323 realistic.**
  Gap = +107 floor / **-551 realistic**. Planner, scenario a, scratch copy with the Agility deadline set to 1
  (EDF puts it first), the `def-at-ranged-spot` lever off, and The Grand Tree XP not counted for Agility.
- **With two more levers (Wilderness mean 202.6, agility potion): 6,176 floor / 6,484 realistic, gap +596 / +288.**
  Lever 2 needs a measurement, and lever 3 is CODE-READ. Both are in the ranked list below.
- **The cost:** with Agility first, 18 other clock boards finish 6,700-7,700 ticks later. Overall is
  +2,406 / +2,616 (42,422 / 47,475). The worst board changes to Ranged at -35,051 / -39,923. Agility is the only
  board that changes to a win, and only at floor. Gap for all boards at once: the 5,900-6,500 ticks of laps and walks must sit
  before tick 6,772. Those same ticks then delay the 16 boards that have earlier deadlines.

## What #1 did (rate needed)

- This server's curve is flatter than the original curve: Agility 99 = 998,458 XP (`packages/planner/src/curve.ts:1-13`,
  copied from `Player.ts:77-99`). Level 52 = 37,616, level 76 = 202,317.
- 998,458 / 6,772 = **147.4 XP/tick average from Agility 1**.
- stunagile: Prayer 43 at tick 67, no QP (`research/leader-forensics.md:296-305`). That fits a pure-lap route:
  bury bones for Protect from Melee, gnome laps to 52, then the Wilderness course. LIKELY, not proven.
- Our measured version of that route: gnome 0-52 at 33 XP/tick = 1,140 ticks, then 52-99 = 960,842 XP at
  178 (mean) = 5,398 ticks or at 202.6 (best) = 4,743 ticks (`research/agility.md`). The rate is not the problem.
  Our laps are as fast as the leader's. The problem is where Agility sits in the whole run.

## Every Agility XP source in rev 289 content (CODE-READ)

`stat_advance` takes tenths of XP and the server multiplies by 25. So 79000 = 7,900 x 25 = 197,500.

| Source | XP at 25x | Level gate | Rate or ticks | Use for Haggis |
|---|---|---|---|---|
| Wilderness course (`skill_agility/scripts/wilderness_course.rs2:76-176`) | 14,285 per clean lap; gates 375 each (`:17,40`) | ridge gate `stat(agility) < 52` (`:2`), pipe `< 49` every lap (`:53`) | 202.6 best / 178 mean MEASURED | main route 52-99 |
| Gnome course (`gnome_course.rs2:95,108`) | 2,162.5 per lap | none | 33.0 MEASURED | 1-52 |
| Barbarian course (`barbarian_course.rs2:30-154`) | 3,487.5 per lap | Barcrawl (`outpost_gate.rs2:2`), wall 35 (`:126`) | 54.0 MEASURED | no: Barcrawl ticks > the 230 ticks it saves on 35-49 (ESTIMATE) |
| Brimhaven arena rope swing (`agilityarena.rs2:119-179`) | 500 per swing | none ("no restriction" comment, `:174`) | 72.5 at 75 and 90 MEASURED; fail at L1 61%, a fall drops a floor and hits 5% + 2 HP (`:162-171`) | no: below gnome at low level, below Wilderness at high level |
| Arena tickets (`agilityarena_tickettrader.rs2:36-67`, `agilityarena.rs2:50-84`) | 6,000-8,000 per ticket (1 / 10 / 25 / 100 / 1,000 tickets) | 1 ticket per pillar move, every 98 ticks (`agilityarena_clerk.rs2:85`) | 61-82 XP/tick from tickets alone (CODE-READ arithmetic) | no; tickets are untradeable (`research/agility.md` Open 1) |
| Other arena obstacles (`agilityarena.rs2:117-501`, `agilityarena_zones.rs2:146-285`) | 150-750 each | none read | not measured | no data |
| Shortcuts (`shortcuts.rs2:22-270`) | 25-625 each | Agility 5-20 and others | single crossings | no |
| Karamja and Yanille dungeons (`karam_dungeon.rs2:200-341`, `agility_dungeon.rs2:28,82`) | 188-563 each | dungeon gates | single obstacles | no |
| Gnome ball (`gnomeball_shoot.rs2:43`) | 750 per goal | none read | not measured | open, see Next measurements 5 |
| Regicide (`quest_regicide.rs2:852`) | 343,750 | Agility 56 (`:404`) | quest chain (Underground Pass, Biohazard, Plague City) | QP route needs it; too late for Agility |
| The Tourist Trap (`quest_desertrescue/scripts/irena.rs2:76-90`) | **116,250 x 2 = 232,500** if Agility is picked twice | Fletching 10, Smithing 20 (`desertrescue_journal.rs2:9,14`; `quest_desertrescue.rs2:603,655`) | quest ticks not measured | lever 6 |
| Troll Romance (`quest_troll_love.rs2:223,294,305`) | 200,000 + 2 x 625 = 201,250 | Agility 28 (`:2`) | needs Troll Stronghold | lever 7 |
| The Grand Tree (`quest_grandtree.rs2:199`) | 197,500 | Agility 25, Prayer 43, Magic 35 gates | 2,001-2,083 MEASURED | Overall lever, see below |
| Underground Pass (`quest_upass.rs2:800`, `upass_obstacles.rs2:77,366`) | 75,000 + 75 x 2 | - | long quest | no |
| The Fremennik Trials (`quest_viking.rs2:143`) | 70,310 | - | long quest | no |
| Small quest XP (Troll Stronghold, Zombie Queen, Druid Spirit, Horror, Dig Site, Watchtower) | 12-375 each | - | - | no |

- **Agility potion: +3 Agility** (`player/configs/consumption/consume_effects.dbrow:288-294`, `stat_change,agility,3,0`).
  The course gates use `stat(agility)`, the current level. `stat_random` also uses the current level
  (`lostcity-engine/src/engine/script/handlers/PlayerOps.ts:594`). So a potion opens the Wilderness gate at base 49,
  and it also makes falls less likely. The potion is a members item (`potions.obj:1415-1427`) and has no
  `tradeable=no` line, so helpers can trade it in. Herblore 34, toadflax + toad's legs. It has no live GE price
  (`research/supply-costs.md:392`).
- Contradiction: `research/quest-xp.md:11` gives quest Agility 686,560 (level 93) and leaves out The Tourist Trap
  (a choice reward) and Troll Romance. With them, quest Agility XP is 1,120,310, which is more than the 998,458
  for 99. The quests that give it (Regicide chain, Fremennik, Underground Pass) are thousands of ticks each and are
  not measured, so quest XP alone is not a fast route.

## Orderings tested (planner, scenario a, scratch copies, no committed row changed)

Each row is one full 24-board schedule. "Other boards" = the change in finish of the other clock boards against
the baseline.

| Ordering | Agility 99 floor / realistic | Agility gap floor / realistic | Overall floor / realistic | Other boards | Worst board (realistic) |
|---|---|---|---|---|---|
| Baseline: Agility last (committed) | 40,016 / 44,859 | -33,244 / -38,087 | 40,016 / 44,859 | - | Agility -38,087 |
| Baseline, `def-at-ranged-spot` off | 38,002 / 42,759 | -31,230 / -35,987 | 40,113 / 45,051 | Defence +4,362 / +5,000 | Defence |
| Agility deadline 4,000 (before Ranged) | 32,521 / 37,042 | -25,749 / -30,270 | 39,908 / 44,846 | 4 boards +4,157-4,938 | Ranged -37,294 |
| Agility deadline 3,000 | 23,218 / 25,183 | -16,446 / -18,411 | 39,995 / 44,933 | 8 boards +4,244-5,025 | Ranged -37,381 |
| Agility deadline 2,400 (before Thieving and later boards) | 15,363 / 16,311 | -8,591 / -9,539 | 39,972 / 44,790 | 10-12 boards +4,221-6,354 | Ranged -37,238 |
| Agility deadline 1,400 | 13,679 / 14,493 | -6,907 / -7,721 | 40,095 / 44,913 | 11-13 boards +3,356-12,645 | Ranged -37,361 |
| **Grand Tree at Agility 25, early** (gnome to 25, Tree Gnome Village, The Grand Tree to 76, then Wilderness) | 10,610 / 11,399 | -3,838 / -4,627 | **40,645 / 45,463** | 18 boards +1,031-13,195 | Ranged -37,911 |
| Agility deadline 700, pure laps | 8,292 / 9,016 | -1,520 / -2,244 | 42,242 / 47,198 | 13 boards +6,491-7,441 | Ranged -39,646 |
| **Agility first, pure laps** | **6,665 / 7,323** | **+107 / -551** | 42,422 / 47,475 | 18 boards +6,671-7,718 | Ranged -39,923 |

- The baseline cannot move Agility early with `def-at-ranged-spot` on. That lever makes `agility-52` require `def-top`
  (`haggis-boards.json:2435`, `research/combat-measure.md:338`), so Agility always follows Defence. It saves only
  97 / 192 Overall ticks. Any Agility-early order must turn it off.
- Agility first, realistic order: walk Lumbridge to the gnome course 451, gnome 0-52 from tick 461 to 1,605,
  walk to the Wilderness course 320, Wilderness from 1,925 to 7,323 (5,398 ticks at 178).
- The Grand Tree XP lands after Agility 99 in the Agility-first order, so its 197,500 Agility XP is lost
  (197,500 / 178 = 1,110 lap ticks). That loss is most of the +2,616 Overall cost.
- The "Grand Tree at 25, early" order is the Overall-friendly middle: Overall is only +629 / +604, but Agility is
  4,600 ticks late.
- Sum of negative slack over all clock boards: baseline -305,041, Agility first -407,090, Grand Tree early -353,304
  (realistic). Agility first wins 1 board (Agility) at floor, and the other orders win 0 boards. With lever 2 it
  also wins Agility at realistic.

## Levers for the Agility board, ranked by ticks saved

Ticks saved are against the Agility-first, pure-laps schedule (7,323 realistic), except lever 1.

| # | Lever | Agility ticks saved (floor / realistic) | Overall effect | Evidence | Needs |
|---|---|---|---|---|---|
| 1 | Agility first (order), `def-at-ranged-spot` off | 33,351 / 37,536 (against the baseline) | +2,406 / +2,616; 18 boards +6,671-7,718 | planner on MEASURED rows | owner choice of the order |
| 2 | Wilderness mean 178 -> 202.6 (the best measured runs): fewer stalls and a faster climb out of the pit after a fall | 302 / 655 | -302 / -655 (the same ticks) | MEASURED best runs; the mean is not reached yet | measurement 1 |
| 3 | Agility potion: open the Wilderness gate at base 49, not 52 (gnome 49-52 = 7,249 XP = 220 ticks moves to the course) | 184 / 179 | the same | CODE-READ (`consume_effects.dbrow:288-294`, `wilderness_course.rs2:2,53`, `PlayerOps.ts:594`); the fall-rate gain from +3 is not modelled | measurement 2, potion supply |
| 4 | The Tourist Trap with Agility picked twice, placed before the laps: 232,500 XP = 1,306 Wilderness ticks | up to 1,306 minus the quest ticks | the same; the quest is in the 142-QP set anyway (`quests-rest`) | CODE-READ XP; quest ticks not measured (ESTIMATE) | measurement 3 |
| 5 | Troll Romance before the laps: 201,250 XP = 1,131 ticks | 1,131 minus the Troll Stronghold chain ticks | the same | CODE-READ XP; chain ticks not measured | measurement 3; probably negative |
| 6 | Walk legs: Lumbridge to gnome 451, gnome to Wilderness 320 (771 in total) | unknown; no faster legal route found in content | the same | travel model ESTIMATE | measurement 4 |
| 7 | Regicide + Underground Pass (418,750 XP = 2,353 ticks) | negative: the chain is much longer (ESTIMATE) | - | CODE-READ XP | - |
| 8 | Barbarian course for 35-49 (54 vs 33 XP/tick) | 230 minus the Barcrawl ticks: negative (ESTIMATE) | - | MEASURED rates, Barcrawl not measured | - |
| 9 | Arena swings or tickets | negative (72.5 at 75+ only; 61-82 from tickets) | - | MEASURED / CODE-READ | - |
| - | Correction, not a lever: the planner uses 178 from level 52, but the measured level-52 mean is 154.3 (3 runs) | -47 / -83 (Agility first: 6,712 / 7,406) | the same | MEASURED | measurement 1 at Agility 52-60 |

Combined (planner, scratch): levers 1 + 2 + 3 = 6,176 floor / 6,484 realistic, gap **+596 / +288**.
Levers 1 + 3 = 6,481 / 7,144, gap +291 / -372. Levers 1 + 2 = 6,363 / 6,668, gap +409 / +104.
Overall with levers 1 + 2 + 3: 41,933 / 46,636 (+1,917 / +1,777 against the baseline).

So: **Agility gap = 551 realistic ticks with Agility first. Lever 2 closes it alone (655), or levers 3 + 4 close it if
The Tourist Trap runs in less than 934 ticks.** The cost is the whole-run trade-off above: about 7,000 ticks later
for 18 other boards, and Overall +2,616 (with levers 2 and 3: +1,777).

## Next measurements (practice, when a slot is free)

1. **Wilderness lap mean (lever 2, and the 52-70 correction).** Use `scripts/measure/agility-laps.ts` with
   `RANDOM_EVENTS=0`. Run 10 runs each at Agility 52, 60 and 76 (new presets `agility_wilderness_60`,
   `agility_wilderness_76`), 20 laps per run. Log ticks per fall: the ticks from the fall to the next pipe click,
   and the number of pit climbs. Target: mean >= 198.3 XP/tick over 52-99. That is the rate at which Agility first
   reaches 6,771 realistic: (6,771 - 1,925) ticks for 960,842 XP. Also check the RNG repeat between runs
   (`research/agility.md` Open 2): set a new seed or a new start tick for each run.
2. **Agility potion gate (lever 3).** Use a preset at Agility 49 with 2 agility potion(4) beside the ridge gate.
   Drink, pass `loc_2309` at current level 52, then run 10 laps. Check: the gate opens, the pipe opens at base 49
   after the boost decays, the XP per tick in the 49-52 band, and the fall count against the level-52 runs.
3. **The Tourist Trap and Troll Romance playtime (levers 4, 5).** Run each quest 3 times on practice from a preset
   that meets the gates, Agility picked twice at Irena. Lever 4 pays only if the quest takes less than
   1,306 ticks.
4. **Walk legs.** Time Lumbridge spawn to the gnome course and the gnome course to the Wilderness ridge gate,
   3 runs each, with run energy as in the real start.
5. **Gnome ball** (`gnomeball_shoot.rs2:43`, 7,500 XP per goal). Read the full script, then measure the goals per
   tick if it has no content-bug part. At 750 XP per goal it beats gnome laps (33 XP/tick) only at one goal per
   22 ticks or faster.

## Planner rows

No planner row was changed. Lever 3 is CODE-READ, but it is a new order with a supply (potions), not a change to an
existing row, so it waits for measurement 2. `bun test packages/planner`: 41 pass, 0 fail (2026-10-23, on the
working tree).

Scratch script (not committed): `final.ts` in the session scratchpad, run as `bun final.ts boards-head.json`. They copy
`haggisActivities()` and change only the Agility deadline, the `grandtree` serves, `agility-52.toLevel` and the
Wilderness rate.
