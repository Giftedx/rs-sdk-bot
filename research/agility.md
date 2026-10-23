# Agility courses: measured lap rates (rev 289, practice)

Date: 2026-10-23. Evidence: MEASURED practice (local server, presets, 150 ms tick) + CODE-READ.
Boards: Agility, Overall.

## Result

- **Update (V2 script, 60 runs of 20 laps, section "Wilderness V2"):** the Wilderness rate from Agility 52 to 99 is
  190.9 XP/tick (band-weighted, V2), against 178.9 for the first script with the same method. The planner row now
  uses 190.9 realistic and 212.9 floor.
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

## Wilderness V2 (MEASURED practice, 2026-10-23)

Script: `scripts/measure/agility-laps.ts`. `AGI_V1=1` runs the first version ("before"); the default is V2 ("after").
Runner: `RANDOM_EVENTS=0 bun scripts/measure/floor-run.ts scripts/measure/agility-laps.ts agility_wilderness_<L> 10 wilderness 20 2600`.
Each run is a new account, 20 laps. The level climbs in the run (52 to 82, 60 to 83, 76 to 88), so the band rates
below split the XP and ticks by the current level at the start of each obstacle.

### Before and after (10 runs per row)

| Start level | Script | Mean XP/tick | SD | Min-max | Median | Clean lap (median) | Fall messages | Lap bonuses lost |
|---|---|---|---|---|---|---|---|---|
| 52 | V1 | 174.9 | 12.7 | 143.7-194.2 | 176.9 | 71 | 64 | 16 |
| 52 | V2 | **184.2** | 13.3 | 166.1-205.5 | 183.8 | 66 | 77 | 18 |
| 60 | V1 | 177.9 | 12.3 | 152.6-192.2 | 180.4 | 71 | 58 | 17 |
| 60 | V2 | **192.8** | 11.1 | 175.1-214.8 | 192.9 | 66 | 46 | 16 |
| 76 | V1 | 183.7 | 6.2 | 175.7-192.2 | 184.4 | 71 | 39 | 11 |
| 76 | V2 | **194.9** | 13.5 | 171.2-212.9 | 198.4 | 66 | 39 | 17 |

Per run (XP/tick). V1 52: 172.6 194.2 177.1 176.9 143.7 188.7 166.9 177.1 176.9 175.3. V1 60: 192.2 178.8 182.1
190.5 174.1 186.8 188.8 152.6 164.0 168.7. V1 76: 175.7 188.7 186.8 175.8 192.2 190.6 175.8 182.1 188.5 180.3.
V2 52: 195.1 175.1 166.1 195.8 205.5 198.1 182.3 171.7 167.0 185.3. V2 60: 205.5 195.2 181.3 190.0 214.8 175.1 190.6
195.2 197.9 182.8. V2 76: 212.9 203.6 210.7 178.9 171.2 201.6 179.6 195.2 191.3 203.6.
Quote: `run1 RESULT ok wilderness agility=76->88 laps=20 ticks=1342 ... xpPerTick=212.9 ... mode=v2` (V2 76 run 1).
Logs: scratchpad `agi2/before.log`, `agi2/after.log`; parser `agi2/parse.py`.

Pooled band rates (all 30 runs of each script):

| Band | V1 XP/tick (XP / ticks) | V2 XP/tick (XP / ticks) |
|---|---|---|
| 52-59 | 152.7 (293,321 / 1,921) | 172.8 (288,820 / 1,671) |
| 60-75 | 176.3 (2,881,187 / 16,346) | 186.1 (2,870,937 / 15,425) |
| 76-99 (measured to 88) | 180.5 (5,470,172 / 30,314) | 192.5 (5,452,674 / 28,322) |
| **52-99, weighted by the XP of each band** | **178.9** | **190.9** |

Weighted rate = 960,842 / (28,577 / r52 + 136,124 / r60 + 796,141 / r76). The V1 value 178.9 agrees with the old
planner row (178). The 76-99 band has no data above Agility 88; the fail chance falls with level, so 192.5 is low
for 88-99.

### Where the ticks went, and the fixes

1. **Click latency, 5 ticks per lap (fixed).** In a per-tick trace (`AGI_TRACE=1`), V1's click on the XP tick moved
   the player only after one more still tick on 4 of the 5 obstacles (rope swing, stones, log, rocks). V2 sends the
   next obstacle's click on every tick once the current obstacle script has visibly started (start tiles in
   `STARTED`). The server drops a click while the player is delayed (`OpLocHandler.ts:14-18`) and reads packets before
   it ends a delay (`World.ts:402,425,776`), so the extra clicks do nothing until the first tick that can accept one.
   Clean lap: 71 to 66 ticks (medians; 137 / 136 / 147 clean V1 laps, 141 / 160 / 165 clean V2 laps).
2. **Rope swing falls: the lap bonus (not fixable).** A rope swing fall leaves progress at 1, so that loop gives no
   4,989-tenths bonus (12,472 XP, `wilderness_course.rs2:170-178`). Each costs about 65 ticks. There were 16-18 per
   200 laps. No route goes back to the swing's start side: from the stones' west end the client routes only to the
   swing's north landing ("You cannot do that from here", `:82-84`), and the log ends on a ledge that leads only to the
   rocks. The full loop (log, rocks, pipe) is the only way back.
3. **Pit falls (fixed in part).** V2 clicks the ladder on the landing tick (`agility_instant_fail` has no delay,
   `agility.rs2:142-145`) and clicks the next obstacle on the ladder exit tick. Out of the pit it walks north of the
   lava to the log (the ladder exit and the stones' west end join by land, z 3962-3966) and does not do the stepping
   stones again: after a fall the stones add no progress (progress is 1 or 3). That saves about 5 ticks and one 15%
   (Agility 52) stones roll per pit fall, for 500 XP.
4. **Not losses:** run energy stayed at 100 in every run (`energyMin=100`). Eating: 0.8-2.1 eats per run in V1,
   1.0-5.5 in V2. NPCs in the course also hit the player (block animation 424); V1 counted those HP drops as falls,
   V2 counts the fail messages.
5. **Stones falls** cost 16.5-17 ticks each (fall to the stones XP); the bot already clicks on the first useful tick.

RNG: practice has one global `JavaRandom` seeded once from `Math.random` at server start
(`engine/src/util/JavaRandom.ts:65-70,126`), shared by every player and NPC. There is no per-run seed. No two of the
60 runs had the same lap sequence (parser check), so Open 2 (repeated runs) did not occur in these matrices.

### Agility potion at base 49 (MEASURED practice)

Preset `agility_wilderness_49pot`: Agility 49 south of the ridge gate (2998,3916), 2 agility potion(4) (obj 3032).
`AGI_POTION=1` drinks one dose, then clicks the gate. 5 runs of 10 laps, plus 1 run of 3 laps at base 49 inside the
course with no potion (preset `agility_wilderness_49`).

- **The gate opens at boosted 52 with base 49: 5 of 5 runs.** Quote: `NOTE potion Agility potion(4) agility 49->52 base=49`,
  `NOTE GATE inside=true ticks=20 agility=52 base=49 doses=1`. One dose per run. Gate ticks 20, 45, 45, 20, 20: the
  45-tick runs lost the first gate click on the tick after the drink and clicked again after 3 still ticks.
  The ridge did not fail in these 5 runs (roll 200/250 at the current level, `wilderness_course.rs2:12`).
- **The pipe works at base 49 with no boost** (`stat(agility) < 49` check, `:53`): the no-potion run did the pipe at
  Agility 49 (`step pipe done t=13`), and every pipe in all 6 runs gave XP. In the potion runs the level is never below
  52 while the boost lasts; one lap (14,285 XP) takes the base past 52 (7,249 XP) before the boost decays
  (1 level per 100 ticks, `login.rs2:36`, `stat.rs2:45`).
- **Rate:** potion runs 185.1, 200.9, 204.7, 179.1, 179.1 XP/tick (mean 189.8, 10 laps from 49 to 73).
  Band 49-51: 198.7 XP/tick in the potion runs (70,738 XP / 356 ticks), 186.0 with the no-potion run (85,023 / 457).
  The band is the first lap only, so it is a small sample.
- Planner effect (lever 3, gnome to 49, then the Wilderness row): see `research/agility-gap.md`.

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
