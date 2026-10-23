# Agility courses: measured lap rates (rev 289, practice)

Date: 2026-10-23. Evidence: MEASURED practice (local server, presets, 150 ms tick) + CODE-READ.
Boards: Agility, Overall.

## Result

- Agility stays the last skill on the Haggis clock. The Wilderness course is the fastest route.
  Measured on practice: 202.6 XP/tick in the best runs, 178 XP/tick as the mean of 9 runs at Agility 70 and 90.
- The plan reaches the Wilderness step at Agility 76 (202,363 XP: gnome laps to 25 = 4,863 XP, then
  The Grand Tree = 197,500 XP). From 76 to 99 the plan needs 796,095 XP.

| Route from Agility 76 to 99 | XP/tick | Ticks | PvP risk |
|---|---|---|---|
| Wilderness course, best runs (floor) | 202.6 | 3,930 | yes (level 52 course is in the Wilderness) |
| Wilderness course, mean of 9 runs (realistic) | 178 | 4,473 | yes |
| Brimhaven Agility Arena rope swings, no tickets | 72.5 | 10,981 | no |
| Barbarian course (needs Alfred Grimhand's Barcrawl) | 54.0 | 14,743 | no |
| Gnome course | 33.0 | 24,125 | no |

Ticks = ceil(796,095 / XP per tick). The PvP risk is an owner decision.

Planner (`bun packages/planner/src/haggis-cli.ts research/hiscores-live.json --levers --order`, scenario a, Overall),
run on a copy of HEAD ed12531 code with each table. Another agent has uncommitted `haggis.ts` changes; with
them the working tree gives 38,427 / 47,313 for the measured table.

| Table | Floor | Realistic | Last skill | Next to last |
|---|---|---|---|---|
| HEAD ed12531 (ESTIMATE rows: 224 / 167, rival lever 197) | 38,764 | 46,856 | Agility | Defence 34,875 / 42,479 |
| Measured Wilderness rates (this change) | 39,206 | 47,313 | Agility | Defence 34,941 / 42,505 |
| No Wilderness: arena rope swings 72.5 (scratch copy, not committed) | 46,257 | 53,821 | Agility | Defence 34,941 / 42,505 |

The Overall #1 is stunbaron at 35,916. The no-Wilderness row does not model the trip to Brimhaven or the
200-coin entry fee (`agilityarena_clerk.rs2:19`).

## Method

- Script: `scripts/measure/agility-laps.ts`. The bot sends the next obstacle click on the tick it sees the
  obstacle XP, and sends it again after 2 still ticks. It climbs out of the pit after a fall and eats below
  half HP.
- Runner: `bun scripts/measure/floor-run.ts scripts/measure/agility-laps.ts agility_<course>_<level> 3 <course> 10 800`,
  with `RANDOM_EVENTS=0`. Each run is 10 laps or 800 ticks, whichever comes first.
- Presets: `agility_<course>_<level>` in `packages/practice/src/presets.ts` (Hitpoints 70, Defence 70, food).
- `xpPerTick` is all XP divided by all ticks of the run. `lapXpPerTick` counts only full laps.
- One practice bot at a time. Practice tick is 150 ms; all numbers are in ticks.

## Measured runs (MEASURED practice)

Each line is one run. Values are from the `RESULT` lines in the scratchpad logs `matrix.log` (first matrix) and
`matrix2.log` (second matrix, after the pit and resume fixes in `agility-laps.ts`).

### Gnome Stronghold course (no fail rolls, `gnome_course.rs2`)

| Level | Run | Laps | Ticks | Ticks/lap | Best lap | XP | XP/tick | Fails |
|---|---|---|---|---|---|---|---|---|
| 1 | 1-3 | 10 | 658, 658, 658 | 65.8 | 62 | 21,625 | 32.9, 32.9, 32.9 | 0 |
| 70 | 1-3 | 10 | 656, 656, 657 | 65.6-65.7 | 62-63 | 21,625 | 33.0, 33.0, 32.9 | 0 |
| 90 | 1-3 | 10 | 656, 657, 656 | 65.6-65.7 | 62 | 21,625 | 33.0, 32.9, 33.0 | 0 |

Quote: `run1 RESULT ok gnome agility=1->44 laps=10 ticks=658 ticksPerLap=65.8 bestLap=62 medianLap=66 xp=21625 ... fails=0`.

### Barbarian Outpost course (`barbarian_course.rs2`)

| Level | Run | Laps | Ticks | XP | XP/tick | lapXpPerTick | Fails | HP lost |
|---|---|---|---|---|---|---|---|---|
| 35 (matrix 2) | 1 | 10 | 665 | 34,875 | 52.4 | 52.4 | 1 | 7 |
| 35 (matrix 2) | 2 | 7 | 475 | 25,412 | 31.8 | 53.5 | 4 | 34 |
| 35 (matrix 2) | 3 | 10 | 706 | 34,875 | 49.4 | 49.4 | 4 | 31 |
| 70 | 1 | 10 | 664 | 34,875 | 52.5 | 52.5 | 1 | 7 |
| 70 | 2 | 10 | 646 | 34,875 | 54.0 | 54.0 | 0 | 0 |
| 70 | 3 | 10 | 664 | 34,875 | 52.5 | 52.5 | 1 | 7 |
| 90 | 1-3 | 10 | 646, 646, 646 | 34,875 | 54.0, 54.0, 54.0 | 54.0 | 0 | 0 |

Best lap 61 ticks at every level. The first matrix at level 35 failed (laps 0, 1, 1; the script stalled after
a fall). The second matrix replaces it.

### Wilderness course (`wilderness_course.rs2`)

| Level | Matrix | Run | Laps | Ticks | XP | XP/tick | lapXpPerTick | Fails | HP lost | Pit climbs | Eats |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 52 | 2 | 1 | 8 | 742 | 117,405 | 146.8 | 158.2 | 7 | 60 | 4 | 3 |
| 52 | 2 | 2 | 7 | 751 | 105,245 | 131.6 | 140.1 | 7 | 52 | 6 | 1 |
| 52 | 2 | 3 | 10 | 782 | 144,162 | 184.4 | 184.4 | 2 | 12 | 2 | 0 |
| 70 | 2 | 1 | 9 | 757 | 131,690 | 164.6 | 174.0 | 3 | 24 | 4 | 0 |
| 70 | 2 | 2 | 10 | 765 | 143,350 | 187.4 | 187.4 | 3 | 28 | 2 | 0 |
| 70 | 2 | 3 | 8 | 732 | 117,905 | 147.4 | 161.1 | 6 | 40 | 7 | 0 |
| 90 | 1 | 1 | 10 | 796 | 144,162 | 181.1 | 181.1 | 3 | 26 | 2 | 0 |
| 90 | 1 | 2 | 9 | 757 | 131,690 | 164.6 | 174.0 | 3 | 23 | 4 | 0 |
| 90 | 1 | 3 | 9 | 757 | 131,690 | 164.6 | 174.0 | 3 | 22 | 4 | 0 |
| 90 | 2 | 1 | 10 | 765 | 143,350 | 187.4 | 187.4 | 2 | 24 | 2 | 0 |
| 90 | 2 | 2 | 10 | 705 | 142,850 | 202.6 | 202.6 | 1 | 1 | 0 | 0 |
| 90 | 2 | 3 | 10 | 705 | 142,850 | 202.6 | 202.6 | 0 | 0 | 0 | 0 |

- Planner realistic 178 = mean XP/tick of the 9 runs at 70 and 90 (164.6, 187.4, 147.4, 181.1, 164.6, 164.6,
  187.4, 202.6, 202.6). Levels 70 and 90 bracket the 76-99 band.
- Planner floor 202.6 = the best runs. The first matrix also had 202.6 at level 70 run 3
  (`laps=10 ticks=705 ... fails=0`). Its other level-70 runs stalled (laps 0 and 2) and are not used.
- Clean lap XP is 14,285 = (125 + 200 + 200 + 200 + 4,989) / 10 x 25 (`wilderness_course.rs2:76,102,125,148,176`).
  A lap with a rope swing fall loses the 4,989 bonus.
- Quote: `run3 RESULT ok wilderness agility=90->93 laps=10 ticks=705 ticksPerLap=70.5 bestLap=66 medianLap=71 xp=142850 xpPerLap=14285 xpPerTick=202.6 ... fails=0`.

### Brimhaven Agility Arena rope swings (`agilityarena.rs2:119-179`)

| Level | Run | Laps (2 swings) | Ticks | XP | XP/tick | Fails |
|---|---|---|---|---|---|---|
| 75 | 1-3 | 10 | 138, 138, 138 | 10,000 | 72.5, 72.5, 72.5 | 0 |
| 90 | 1-3 | 10 | 138, 138, 138 | 10,000 | 72.5, 72.5, 72.5 | 0 |

Each swing gives 20 XP x 25 = 500 and takes 6-7 ticks (best lap 12, median 14). The swing has no use timer
and no level check. The preset puts the bot on the arena floor, so the run does not include the ladder, the fee,
or pillar tickets. Quote: `run1 RESULT ok arenaswing agility=90->90 laps=10 ticks=138 ticksPerLap=13.8 bestLap=12 medianLap=14 xp=10000 ... fails=0`.

## Theoretical minimum against measured

The script clicks on the first tick after the obstacle script ends (`OpLocHandler.ts:14-18` drops clicks while
the player is delayed). The best measured lap is the lower bound that we can show.

| Course | Best lap | Measured clean lap (median) | XP/tick at best lap | Best measured run XP/tick |
|---|---|---|---|---|
| Gnome | 62 | 66 | 34.9 | 33.0 |
| Barbarian | 61 | 65 | 57.2 | 54.0 |
| Wilderness | 66 | 71 | 216.4 | 202.6 |
| Arena rope swings | 12 | 14 | 83.3 | 72.5 |

We did not prove that 62 / 61 / 66 / 12 is the engine minimum. The 4-5 tick spread between best and median laps
is not explained yet.

## Fail chances (CODE-READ)

`stat_random(agility, low, high)` succeeds when `floor(low*(99-L)/98) + floor(high*(L-1)/98) + 1 > rand(256)`
(`PlayerOps.ts:591-600`). Wilderness rolls: rope swing 200/250, stepping stones 180/250, log 200/250. Arena swing 100/310.

| Level | Wilderness fail % (swing / stones / log) | Lap with no fail | Arena swing fail % |
|---|---|---|---|
| 52 | 11.7 / 15.2 / 11.7 | 66.1% | 18.4 |
| 70 | 7.8 / 10.2 / 7.8 | 76.4% | 3.1 |
| 76 | 7.0 / 8.6 / 7.0 | 79.0% | 0.0 |
| 90 | 3.9 / 4.7 / 3.9 | 88.0% | 0.0 |
| 99 | 2.0 / 2.0 / 2.0 | 94.3% | 0.0 |

Wilderness falls stay frequent at high levels because the low and high values are close. Faster recovery
after a fall is the remaining lever on that course.

## Open

1. Arena pillar tickets are not measured. The pillar moves every 98 ticks (`agilityarena_clerk.rs2:79-85`).
   Tickets are not tradeable (`agilityarena.obj`, `tradeable=no`). A ticket is worth 240-320 XP x 25 = 6,000-8,000
   XP (`agilityarena_tickettrader.rs2:36-49`). ESTIMATE: swings plus one ticket per 98 ticks could give about
   110-130 XP/tick. That is still below the Wilderness course. It is the best no-PvP candidate.
2. Practice RNG repeats between runs: Wilderness 90 matrix 1 runs 2 and 3 are identical, matrix 2 runs 2 and 3
   are identical, and matrix 2 level 70 run 1 equals matrix 1 level 90 run 2. The runs are not fully
   independent samples.
3. Not measured: the Wilderness course on the live server, PKers, the walk in and out, and a level 76-89 preset.
4. The `rival-grandtree-agility` lever (Grand Tree quest ticks) is not an Agility lap rate and stays ESTIMATE.

## Contradiction

- `research/tick-tricks-web.md:195,399`: Wilderness lap 601.4 XP, about 224 XP/tick (67-tick web lap); gnome about 50 ticks per lap (old `agility-25` row source).
  Measured and code: 571.4 XP per clean lap (14,285 at 25x; the 3 runs of 705 ticks show `xpPerLap=14285`).
  601.4 counts the two entry gates (15 + 15, `wilderness_course.rs2:17,40`), which are not part of the lap loop.
  Measured: 202.6 XP/tick best and 66-71-tick laps; gnome laps 62-66 ticks. Settled by measurement.
