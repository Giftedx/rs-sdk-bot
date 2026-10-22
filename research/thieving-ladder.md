# Thieving ladder (model, 2026-10-22)

Sources:
- Pickpocket rows: `vendor/lostcity-content/scripts/skill_thieving/configs/pickpocking/pickpocket.dbrow`.
- Success roll: `vendor/lostcity-engine/src/engine/script/handlers/PlayerOps.ts:591` (STAT_RANDOM).
  value = floor(low*(99-L)/98) + floor(high*(L-1)/98) + 1. Success if value > random 0..255.
- A fail stuns for `stun_ticks` (8) and hits for `stun_damage`.

Model: success costs 2 ticks. Fail cost F is fitted to the one measured rate,
guard at Thieving 40 = 130.6 XP/tick (knowledge/rates.json). Fit: F = 6.7 ticks.

| Level | Best target | Model XP/tick | Next best |
|---|---|---|---|
| 40 | guard | 131 (measured) | man 54 |
| 55 | knight of Ardougne | 330 | guard 183 |
| 70 | knight | 449 | paladin 394 |
| 99 | knight | 871 | watchman 575 |

Knights stay best from 55 to 99. Watchman, paladin, gnome and hero never beat them.

Ladder man -> guard (40) -> knight (55), model total to 99: about 2,000 ticks (20 min at 600 ms).
Guards only from 40: about 3,200 ticks. `bun research/thieving-ladder.ts` reprints the totals.

Limits:
- Only the guard rate is measured. The man rate in the model (54 at 40) is far above the measured
  19.3 average from level 1, so the man leg is likely 2-3x slower than the model.
- Knight rate is a model. `bun packages/router/src/author-cli.ts thieveknights` writes and proves
  the measuring script (preset `thieve_knights`).
- Knights hit 3 per fail: about 0.3 HP per tick at 55. 300 ticks needs about 90 HP of food.

## Measured knight rate (2026-10-22)

`scripts/generated/thieveknights.ts`, 3/3 runs from Thieving 55: median 378.6 XP/tick (model said 330).

## Live plan: one trip to Ardougne, then stay

Everything for the ladder is in the Ardougne market (knowledge/npcs.json):
- Men: ardougnian_male1 at (2614,3318), (2621,3293). Woman at (2612,3316).
- Guards: ardougne_guard at (2651-2665, 3300-3318), 7 spawns.
- Knights: knight_of_ardougne at (2652,3318), (2653,3300), (2669,3298), (2671,3313).
- Food: bread and cake in the Ardougne bakery shop (`area_ardougne_east/configs/ardougne_east.inv:15`).

So the specialist travels once, at level 1, and never walks far again. Death respawns in Lumbridge,
which costs the whole trip again, so it must eat. A fresh account has 10 HP.

Router route from Lumbridge (3222,3222) to the market (2654,3304): 3 walk legs via (3099,3266) and
(2884,3397), 880 tiles. No wolves on that corridor. Hobgoblins (28) and dark wizards (20) are near it.

Budget against the leader (99 at 2,935 ticks):
- Tutorial 13 + trip (measuring) + ladder about 2,000 (model, knight leg scaled by the measured rate).
- If the trip is about 600 ticks with running, the total is about 2,600: a margin of about 300 ticks.

## Trip measured on the practice server (2026-10-22)

`scripts/measure/travel.ts` with a fresh account (preset floors_lumbridge, 10 HP), router land route:
FAIL after 2,198 ticks. The account died 4 times and ended in Lumbridge. The land route is not usable at 10 HP.

Boat route (not measured yet), from game scripts and knowledge/npcs.json:
1. Lumbridge to Port Sarim seamen (seaman_lorris 3028,3221 / seaman_thresnor 3026,3217): about 195 tiles.
   Fare 30 coins (`areas/area_port_sarim/scripts/sailors.rs2`).
2. Ship lands at Musa Point. Walk to the Brimhaven customs officer (2772,3225-3231): about 185 tiles.
3. Customs officer, fare 30 coins, sails to Ardougne (1_41_51_59_4 = 2683,3268, ship deck level 1)
   (`areas/area_karamja/scripts/customs_officer.rs2:81-82`). Then about 40 tiles to the market.
Total walk about 420 tiles. Needs 60 coins: men pay 3 per pick, so about 20 picks in Lumbridge first.

## Boat route measured (2026-10-22)

`scripts/generated/boatardy.ts`, 3/3 runs, fresh 10 HP account with 60 coins: Lumbridge to the Ardougne
market in 380 / 380 / 385 ticks, no death. Boat jumps at tick ~189 (Port Sarim -> Musa Point) and ~350
(Brimhaven -> Ardougne). The land route died 4 times in 2,198 ticks.

New budget: tutorial 13 + coins in Lumbridge (counted in the ladder) + boat 385 + ladder about 2,000 (model)
= about 2,400 ticks against the leader's 2,935. Proof in progress: author task `thieving60`.

## Correction (2026-10-22, later): the guard and knight rates were too high

`thieveguards.ts` and `thieveknights.ts` read the base XP right after START. Preset stats arrive a few
ticks later, so the base read 0 and the preset XP counted as gained. With the base read after 5 ticks:
- Guard at 40: median 73.9 XP/tick (old 130.6). Runs: 22230 / 26910 / 16380 XP in 300 ticks.
- Knight at 55: median 206.9 XP/tick (old 378.6). HP 10 is not slower than HP 50.
The model fit (F = 6.7) used the wrong guard rate, so its tables above are too high as well.

## Fresh-account runs (`scripts/generated/thieving60.ts`, 150 ms tick, 6 runs)

4 of 6 passed. 2 died on the walk to Port Sarim near Draynor (3120,3254), with HP worn down by the
Lumbridge stuns and no food. Milestone ticks of the passing runs with full logs:

| Run | Ardougne | Level 40 | Level 55 | Level 60 |
|---|---|---|---|---|
| d | 553 | 1020 | 1816 | 2188 |
| e | 553 | 1090 | 1437 | 1589 |

Forecast to 99: 1,437-1,816 (fresh to 55, measured) + about 2,400 (55 to 99: model scaled by the measured
knight rate, 330 -> 207) = about 3,850-4,200 ticks. The leader has 99 at 2,935.
**With this method, the Thieving board is not winnable.** The +600 margin in board-ranking.md is wrong.

## Pickpocket cycle tests (`scripts/measure/pick-cycle.ts`, knights from 55, 150 ms tick)

K = ticks waited after a failed pick before the next try. One run each unless noted.

| Preset | Ticks | K=1 | K=5 | K=6 | K=7 | K=8 | K=9 |
|---|---|---|---|---|---|---|---|
| HP 10, 20 lobsters | 300 | 196.0 | 118.6 | 90.7 | 196.0 | - | - |
| HP 10, 20 lobsters (food ran out) | 1500 | 133.5 | - | - | 244.1 | 127.9 | 122.2 |
| HP 99, 27 lobsters | 1500 | 321.3 | - | 243.1 | 203.0, 186.7 | - | - |

The K results disagree between rows: one run per cell is too few. No K setting is proven better.
What holds in both 1500-tick rows: HP 99 (mean about 239 XP/tick) beats HP 10 (mean about 157). A 10 HP
account eats about every 2 knight fails. Model with corrected rates (S=2, F=12.8, fits guard 76 and
knight 207): 2,852 ticks of pickpocketing to 99, plus about 400 for tutorial and boat. Leader: 2,935.

## Leader facts and more cycle tests (2026-10-22, late)

- Live tick is 400 ms: miner3 Mining 99 at 3,964 ticks shows as 26m 25s (1,585 s / 3,964 = 0.400 s).
  jackalopeth8 Thieving 99: 2,935 ticks = 19m 34s.
- jackalopeth8 reached Attack, Strength, Defence, Hitpoints 40 at about 4h 50m, long after Thieving 99.
  So it thieved with low HP. Its method is faster than ours; we do not know it yet.
- Stalls cap low: XP x 25 / respawn ticks per stall. Best is the bakery stall: 400 XP per 8 ticks = 50 XP/tick.
- Eating inside the stun (EATSTUN=1), HP 10, knights, 600 ticks, 4 bots sharing the knights:
  normal 231.4 and 259.5 XP/tick; eat-in-stun 216.3 and 158.1 (ran out of 20 lobsters). No gain.
