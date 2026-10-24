# Skill rows measured: magic-teleport, woodcut, fish (2026-10-24)

This file records practice measurements for three planner rows in `packages/planner/src/haggis-boards.json`.
Before this work, all three rows were ESTIMATE. Now all three are MEASURED.

All runs were on the local practice server (150 ms tick). Each run used a fresh preset account, made with
`RANDOM_EVENTS=0 bun scripts/measure/floor-run.ts <script> <preset> 1 ...`, and each run was deleted after it
finished. A preset run is not a fresh-account run and not a live run. Paths that start with `skill_` are under
`vendor/rs-sdk/server/content/scripts/`. Paths that start with `engine/` are under `vendor/rs-sdk/server/engine/src/`.

## Summary

| Row | Old ticks (floor / realistic, ESTIMATE) | New ticks (floor / realistic, MEASURED) | Method change |
|---|---|---|---|
| `magic-teleport` (Magic 1-99) | 3,000 / 3,750 | 3,033 / 3,046 | None. A teleport takes 4.00 ticks every cast |
| `magic-43` (Magic 1-43, on the path) | 168 / 219 (117.2 / 89.9 XP/tick) | 212 / 224 (92.8 / 87.9 XP/tick) | None. Wind strike is slower than assumed (5.5-6.3 ticks per cast, not 3-4) |
| `woodcut` (Woodcutting 1-99) | 2,900 / 3,400 | 3,356 / 3,467 | Rune axe from level 1, not 41. Oaks to 72, then willows |
| `fish`, patch `rival-sea-slug` (Fishing 74-99) | 1,788 / 2,568 (+215 via Catherby) | 2,305 / 2,346 (no via leg) | Fly 3-tick only. No lobster or harpoon |

Floor is the best run. Realistic is the mean of 3 runs.

Planner, scenario a. Both runs used the same hiscores snapshot (`research/hiscores-live.json` at 2026-10-24, copied
before the comparison). "Before" is the HEAD boards file and "after" is this change:

| | Overall finish floor | Overall finish realistic | Gate `plan wins` line |
|---|---|---|---|
| Before | 40,503 | 44,964 | 1/24 boards win with 2% margin; 61 inputs not MEASURED; worst Agility -38192 |
| After | 41,100 | 44,393 | 1/24 boards win with 2% margin; 55 inputs not MEASURED; worst Agility -37621 |

The floor became 597 ticks worse because the old fish floor (1,788) came from the flinch model, and flinch FAILS on
this server (`research/gathering-tricks.md`). The realistic finish became 571 ticks better.

## Magic: teleport ladder

Script: `scripts/measure/floor-teleport.ts`. Presets: `floor_tele1` (Magic 1, Lumbridge chicken pen) and
`floor_tele25` (Magic 25, Lumbridge). Both presets have a staff of air worn and rune stacks in the pack.

Mechanism (CODE-READ): `skill_magic/scripts/spells/teleport.rs2:9-48` does nothing unless `p_finduid` succeeds,
and `p_finduid` fails while the player is delayed. After that, `player_teleport_normal` runs `p_delay(1)` and
`p_delay(0)` and then the jump. The script sends one click every tick, and the server takes the first click that it
can.

| Band | Runs (ticks) | Rate |
|---|---|---|
| 25 -> 99 (Varrock 4 casts, Lumbridge 5, Falador 8, Camelot 703) | 2,879 / 2,881 / 2,880 | 4.00 ticks per cast; Camelot 346.5-346.8 XP/tick |
| 25 -> 43 (inside the runs above) | 58 / 58 / 58 | |
| 1 -> 25 wind strike on chickens | 154 / 182 / 162 (28-29 casts) | 26.9-32.8 XP/tick, 5.5-6.3 ticks per cast |

Quoted line: `RESULT ok FLOOR Magic level=99 xp=998500 ticks=2879 actions=720 ... ticksPerCast=4.00`.

A teleport takes 4 ticks, and no input change makes it shorter. The click lands on the first tick after the jump
(`maxSentInTick=2`, `refused=0`). Wind strike follows the combat clock (`skill_combat/scripts/player/player_magic.rs2:188`,
clock + 5). The extra 0.5-1.3 ticks per cast are not explained. A probable cause is retargeting after a chicken dies. One more strike run stopped at
Magic 3 with no XP for 40 ticks (no chicken in reach). That run is not counted.

The superheat route still wins the Magic + Smithing comparison, so `magic-teleport` is not on the scenario a path.
`magic-43` is on the path (row 16).

## Woodcutting: delayed-click 3-tick

Script: `scripts/measure/floor-woodcut.ts`. Presets: `floor_wc1` (level 1, east of Draynor) and `floor_wc85` (85,
Draynor willows). Each preset has a rune axe, a knife and 15 logs, and Attack, Strength, Defence and Hitpoints at 70.

Method changes, with code evidence:

- **Rune axe from level 1.** `skill_woodcutting/scripts/woodcut.rs2:193-235` (`woodcutting_axe_checker`) returns
  the best axe held and does not check the level. The comment says "no wc req in 2004", and the level checks are
  commented out. The row assumed a rune axe only from 41.
- **Oaks to 72, then willows.** With a rune axe at 3 ticks per roll (`stat_random` in
  `engine/engine/script/handlers/PlayerOps.ts:591-600` and the `successchance` rows in
  `skill_woodcutting/configs/trees.dbrow`), the expected rate is oak 313 XP/tick from about 60, which is its cap.
  Willow is 308 at 70, 321 at 75, 334 at 80 and 387 at 99. Maple and yew are slower at every level (208-286 and
  182-256).
- **Delayed click, not same-tick.** Tick T: knife on log and Make 1. This sets `%action_delay = clock + 2`
  (`skill_fletching/scripts/cut_logs.rs2:83-86`). Tick T+1: drop one log. The drop clears the pending action and
  the fletch queue (`engine/network/game/client/handler/OpHeldHandler.ts:54-56`, `Player.ts:817-819`). Tick T+2:
  Chop. The attempt label rolls at once when `%action_delay = map_clock` (`woodcut.rs2:97-99`). The cycle drops one
  log, so the pack never fills.
- **After a move, wait 3 ticks before the first knife.** A plain Chop sets clock + 3 on arrival. A knife before that
  time queues the fletch with a short delay, and the fletch uses a log.

| Band | Runs (ticks) | Notes |
|---|---|---|
| 1 -> 85 | 1,504 / 1,444 / 1,530 | 72 reached at 715 / 649 / 743 |
| 85 -> 99 | 1,969 / 1,912 / 2,040 | willow 330.6 XP/tick inside cycles; moves 239-310 ticks |

Total: floor 1,444 + 1,912 = 3,356. Realistic 1,493 + 1,974 = 3,467.

Tree moves take 15-20% of the ticks, because oaks and willows fall on 1 log in 8 (`woodcut.rs2:168, 184-189`). A run
used 1-6 of its 15 spare logs, one log for each mistimed cycle.

Failure seen: a preset with only Woodcutting died at the Draynor oaks. Jail guards (npc 917 at 3109,3237 and
3120,3238, `maps/m48_50.jm2`) attacked it. The presets now have combat stats at 70. Haggis's combat level at this row is not
checked here.

## Fishing: fly 3-tick from the Sea Slug level

Script: `scripts/measure/floor-fish.ts` (modes `fly`, `cage`, `harpoon`). Preset: `floor_fish_fly74` (Fishing 74,
the level after the Sea Slug XP of 179,375; Lumbridge river; fly rod, 2,000 feathers, knife, 10 logs; combat 70).

Mechanism: in tick T, send 4 inputs in this order: drop one fish, knife on log, Make 1, Lure. The engine takes 5
inputs per tick. The Lure op with clock + 2 goes on to the hidden op 4, which rolls at T+2
(`skill_fishing/scripts/fishing_spots/freshfish.rs2:25-87`). The drop must come first. A drop at T+1 runs
`clearPendingAction` and stops the op-4 chain before it rolls. The hidden op cannot be clicked, because
`engine/network/game/client/handler/OpNpcHandler.ts:40` refuses an op named "hidden".

| Band | Runs (ticks) | Rate |
|---|---|---|
| 74 -> 99 | 2,356 / 2,305 / 2,377 | 346.0-357.2 XP/tick, about 560 feathers and 557-561 catches per run |
| 74 -> 85 (inside) | 618 / 621 / 697 | |

Quoted line: `RESULT ok FLOOR Fishing level=99 xp=999287 ticks=2307 ... mode=fly start=74 ... feathers=1439`.

The old rate was 182.5 at 70 (`research/gathering-tricks.md`). That script dropped the whole pack at 26 items. This
script drops one fish in each knife tick, and the rate is almost double. Lobster and harpoon were not run 3 times.
The code-read rates at 3 ticks per roll are lower than fly at every level from 74 to 99: fly 347-416, harpoon
(swordfish and tuna) 232-296, lobster 211-281, shark 107-147 XP/tick. One delayed-harpoon run with the new script
got no XP in 61 ticks, and it was not investigated. The fish patch therefore drops the Catherby via leg (215 ticks).

Failure seen: a Fishing-only preset (10 Hitpoints) died at the Lumbridge river spot at tick 460 and respawned at
3222,3216. The script now stops when the player is at the respawn point. The fish presets now have combat 70.

## Open

- Live timing (400 ms tick, network latency) of the 4-input fly tick and the 3-tick woodcut cycle is not measured.
- Woodcut moves: a closer group of oaks, or a site where the trees stand within reach of each other, could save
  some of the 450-530 move ticks.
- The base `fish` row (1 -> 99, used when the `rival-sea-slug` lever is off) is still ESTIMATE.
