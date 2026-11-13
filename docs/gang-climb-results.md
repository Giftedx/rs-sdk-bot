# Gang climb results

Hill climb of our side's fight options against the live-like dagger gang on the practice bench.

- Cases: `extra:gang-live-fast-x2` (two meetings in one engine, each our account against three gang accounts at (3078, 3640)) and its kit variants (`scripts/measure/aio-bench-cases.ts`): `-snarep-x2` (kit `live-walker-iron-snarep`: the Entangle runes, the poisoned dagger and a super antipoison, 17 sharks; on `claude/gang-methods-2`), `-snare-x2` (kit `live-walker-iron-snare`: 17 sharks and the runes of 10 Entangles), `-p-x2` (kit `live-walker-iron-p`: the poisoned dragon dagger) and `-psuper-x2` (kit `live-walker-iron-psuper`: the poisoned dagger and a super antipoison). Our profile `gang-hunter`, kit `live-walker-iron` unless the case names another; gang profile `ganker-live`, kit `ganker-dds`.
- Each set runs seeds 1 to 4 (8 meetings; `r6-snare-focus` and `r6-base` seeds 5 to 8, `r6-snarep-focus` seeds 1 to 8) with `--set SPAR_A=gang-hunter` and its options as `SPAR_A_OPTS`. Practice bench only, on a cloud container with 15 GB RAM and 4 cores, with `FLEET_SIDE=local`: the container sets `FLEET_SIDE=claude-cloud`, and the bench's generated `aiob*` accounts count as `local`, so `openBot` refuses them otherwise.
- **Engine waits.** Sets marked `wall clock` ran before the lockstep fixes of `claude/bench-seed-jobs`: an SDK wait timed out in wall time, so a gang bank call that never came true ended its trip early (`food withdrawal short`, `no walk back`), and the ticks that cost depended on the speed of the machine. Sets marked `ticks` (labels `r5-` to `r7-`) ran with the fixes: SDK waits time out in game ticks, and the 4 seeds of a set ran at once (`--seeds 1,2,3,4 --seed-jobs 4`). Compare sets within one kind only: `cure-eat60` gives 3 kills in 8 meetings under wall-clock waits and 2 (`r5-base`) under tick waits.
- **Round 7** (`r7-`) ran after `freezeArmour` (Giftedx/rs-sdk-bot#804): a freeze takes the torso off by default, where `castArmour: 'keep'` had kept plate on for every freeze.
- Columns: kills, deaths and sharks come from the `RESULT` line (`kills`, `died`, the sum of `eaten`). Ticks per run is the `RESULT` `ticks`. The three walk-out columns count distinct gang accounts in the case log: a `PK walks out of the Wilderness` line, followed by a `PK escaped` line or a `PK kill` of that account. Seconds per run is `elapsedMs` from the bench row. Sets are ranked by the kind of engine waits, then kills per meeting, then deaths, then sharks per meeting, then ticks.

## Results

| label | case | engine waits | options | idle prayer off | runs (ok) | meetings | kills | kills/meeting | deaths | walked out | walked out, escaped | walked out, killed | sharks eaten mean / meeting | sharks / kill | ticks mean / run | ticks / kill | s per run (max) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| r7-snarep-focus | snarep-x2 | ticks | `{"cureNow":true,"eatAt":60,"freeze":"flee","focusRunner":0.4,"chaseBelow":0.4}` | no | 4 (4) | 8 | 8 | 1.00 | 0 | 8 | 0 | 8 | 3.8 | 3.8 | 554 | 277 | 34 (36) |
| r7-snare-focus | snare-x2 | ticks | `{"cureNow":true,"eatAt":60,"freeze":"flee","focusRunner":0.4,"chaseBelow":0.4}` | no | 4 (4) | 8 | 8 | 1.00 | 0 | 8 | 0 | 8 | 3.9 | 3.9 | 576 | 288 | 37 (40) |
| r7-snare-focus-s58 | snare-x2 | ticks | `{"cureNow":true,"eatAt":60,"freeze":"flee","focusRunner":0.4,"chaseBelow":0.4}` | no | 4 (4) | 8 | 7 | 0.88 | 0 | 8 | 1 | 7 | 6.4 | 7.3 | 661 | 377 | 39 (40) |
| r6-snare-focus | snare-x2 | ticks | `{"cureNow":true,"eatAt":60,"freeze":"flee","focusRunner":0.4,"chaseBelow":0.4}` | no | 4 (4) | 8 | 6 | 0.75 | 0 | 10 | 4 | 6 | 5.0 | 6.7 | 846 | 564 | 47 (53) |
| r6-snarep-focus | snarep-x2 | ticks | `{"cureNow":true,"eatAt":60,"freeze":"flee","focusRunner":0.4,"chaseBelow":0.4}` | no | 8 (8) | 16 | 12 | 0.75 | 0 | 21 | 9 | 12 | 5.1 | 6.8 | 793 | 529 | 86 (95) |
| r5-snare-focus | snare-x2 | ticks | `{"cureNow":true,"eatAt":60,"freeze":"flee","focusRunner":0.4,"chaseBelow":0.4}` | no | 4 (4) | 8 | 6 | 0.75 | 0 | 11 | 5 | 6 | 8.1 | 10.8 | 824 | 549 | 41 (47) |
| r5-p-super | psuper-x2 | ticks | `{"cureNow":true,"eatAt":60}` | no | 4 (4) | 8 | 5 | 0.63 | 0 | 13 | 9 | 4 | 5.9 | 9.4 | 962 | 769 | 45 (47) |
| r5-p-dds | p-x2 | ticks | `{"cureNow":true,"eatAt":60}` | no | 4 (4) | 8 | 5 | 0.63 | 0 | 15 | 13 | 3 | 9.3 | 14.8 | 948 | 758 | 46 (52) |
| r5-p-super-focus | psuper-x2 | ticks | `{"cureNow":true,"eatAt":60,"focusRunner":0.4,"chaseBelow":0.4}` | no | 4 (4) | 8 | 4 | 0.50 | 0 | 11 | 8 | 4 | 5.1 | 10.3 | 918 | 918 | 41 (47) |
| r5-snare-focus-cut | snare-x2 | ticks | `{"cureNow":true,"eatAt":60,"freeze":"flee","focusRunner":0.4,"chaseBelow":0.4,"cutOff":3}` | no | 4 (4) | 8 | 4 | 0.50 | 0 | 9 | 5 | 4 | 6.1 | 12.3 | 871 | 871 | 41 (48) |
| r6-snare-diag | snare-x2 | ticks | `{"cureNow":true,"eatAt":60,"freeze":"flee","focusRunner":0.4,"chaseBelow":0.4,"diagonalFrozen":true}` | no | 4 (4) | 8 | 3 | 0.38 | 0 | 9 | 6 | 3 | 3.1 | 8.3 | 654 | 872 | 38 (45) |
| r5-base | x2 | ticks | `{"cureNow":true,"eatAt":60}` | no | 4 (4) | 8 | 2 | 0.25 | 0 | 14 | 12 | 2 | 7.6 | 30.5 | 947 | 1894 | 44 (52) |
| r6-base | x2 | ticks | `{"cureNow":true,"eatAt":60}` | no | 4 (4) | 8 | 2 | 0.25 | 0 | 12 | 10 | 2 | 8.5 | 34.0 | 846 | 1692 | 47 (54) |
| r5-focus | x2 | ticks | `{"cureNow":true,"eatAt":60,"focusRunner":0.4,"chaseBelow":0.4}` | no | 4 (4) | 8 | 2 | 0.25 | 0 | 14 | 11 | 2 | 11.4 | 45.5 | 1191 | 2383 | 53 (57) |
| m-snare-focus-cut | snare-x2 | wall clock | `{"cureNow":true,"eatAt":60,"freeze":"flee","focusRunner":0.4,"chaseBelow":0.4,"cutOff":3}` | no | 4 (4) | 8 | 6 | 0.75 | 0 | 8 | 2 | 6 | 3.8 | 5.0 | 723 | 482 | 86 (101) |
| m-snare-focus | snare-x2 | wall clock | `{"cureNow":true,"eatAt":60,"freeze":"flee","focusRunner":0.4,"chaseBelow":0.4}` | no | 4 (4) | 8 | 4 | 0.50 | 0 | 10 | 6 | 3 | 5.5 | 11.0 | 1031 | 1031 | 114 (134) |
| cure-eat60 | x2 | wall clock | `{"cureNow":true,"eatAt":60}` | no | 4 (4) | 8 | 3 | 0.38 | 0 | 10 | 7 | 3 | 4.4 | 11.7 | 947 | 1263 | 104 (122) |
| cure | x2 | wall clock | `{"cureNow":true}` | no | 4 (4) | 8 | 3 | 0.38 | 0 | 11 | 9 | 3 | 6.8 | 18.0 | 1056 | 1408 | 85 (93) |
| cure-chase50 | x2 | wall clock | `{"cureNow":true,"chaseBelow":0.5}` | no | 4 (4) | 8 | 3 | 0.38 | 0 | 13 | 10 | 3 | 6.9 | 18.3 | 1149 | 1532 | 112 (142) |
| all4 | x2 | wall clock | `{"cureNow":true,"chaseBelow":0.35,"specBelow":0.45}` | yes | 4 (4) | 8 | 2 | 0.25 | 0 | 9 | 7 | 2 | 3.9 | 15.5 | 1045 | 2091 | 100 (102) |
| m-focus-cut | x2 | wall clock | `{"cureNow":true,"eatAt":60,"focusRunner":0.4,"chaseBelow":0.4,"cutOff":3}` | no | 4 (4) | 8 | 2 | 0.25 | 0 | 9 | 7 | 2 | 4.3 | 17.0 | 835 | 1671 | 90 (97) |
| base | x2 | wall clock | `{}` | no | 4 (4) | 8 | 2 | 0.25 | 0 | 11 | 10 | 1 | 5.1 | 20.5 | 965 | 1931 | 100 (103) |
| cure-eat30 | x2 | wall clock | `{"cureNow":true,"eatAt":30}` | no | 4 (4) | 8 | 2 | 0.25 | 0 | 13 | 11 | 2 | 6.1 | 24.5 | 1092 | 2184 | 104 (112) |
| idle | x2 | wall clock | `{}` | yes | 4 (4) | 8 | 2 | 0.25 | 0 | 12 | 11 | 1 | 6.4 | 25.5 | 1099 | 2197 | 104 (137) |
| spec45 | x2 | wall clock | `{"specBelow":0.45}` | no | 4 (4) | 8 | 1 | 0.13 | 0 | 9 | 8 | 1 | 3.4 | 27.0 | 865 | 3459 | 101 (111) |
| m-snare-diag | snare-x2 | wall clock | `{"cureNow":true,"eatAt":60,"freeze":"flee","diagonalFrozen":true}` | no | 4 (4) | 8 | 1 | 0.13 | 0 | 8 | 6 | 1 | 3.9 | 31.0 | 756 | 3022 | 93 (107) |
| m-focus | x2 | wall clock | `{"cureNow":true,"eatAt":60,"focusRunner":0.4,"chaseBelow":0.4}` | no | 4 (3) | 8 | 1 | 0.13 | 0 | 9 | 8 | 1 | 4.1 | 33.0 | 795 | 3178 | 84 (125) |
| e60-bowburst40 | x2 | wall clock | `{"cureNow":true,"eatAt":60,"bowBurst":0.4}` | no | 4 (4) | 8 | 1 | 0.13 | 0 | 10 | 9 | 1 | 4.4 | 35.0 | 891 | 3564 | 93 (105) |
| cure-spec60 | x2 | wall clock | `{"cureNow":true,"specBelow":0.6}` | no | 4 (4) | 8 | 1 | 0.13 | 0 | 10 | 9 | 1 | 4.5 | 36.0 | 985 | 3938 | 98 (134) |
| chase35 | x2 | wall clock | `{"chaseBelow":0.35}` | no | 4 (4) | 8 | 1 | 0.13 | 0 | 10 | 9 | 1 | 4.6 | 37.0 | 813 | 3252 | 97 (102) |
| e60-chase | x2 | wall clock | `{"cureNow":true,"eatAt":60,"chase":true}` | no | 4 (4) | 8 | 1 | 0.13 | 0 | 11 | 10 | 1 | 4.8 | 38.0 | 981 | 3924 | 108 (113) |
| m-snare | snare-x2 | wall clock | `{"cureNow":true,"eatAt":60,"freeze":"flee"}` | no | 4 (4) | 8 | 1 | 0.13 | 0 | 10 | 9 | 1 | 5.5 | 44.0 | 1021 | 4085 | 110 (135) |
| e60-savespec | x2 | wall clock | `{"cureNow":true,"eatAt":60,"specBelow":0.3,"fledSpec":true,"bowBurst":0.4}` | no | 4 (4) | 8 | 1 | 0.13 | 0 | 14 | 13 | 1 | 11.6 | 93.0 | 1303 | 5211 | 113 (147) |
| e60-standoff3 | x2 | wall clock | `{"cureNow":true,"eatAt":60,"standOff":3}` | no | 4 (4) | 8 | 1 | 0.13 | 0 | 10 | 9 | 1 | 14.1 | 113.0 | 1043 | 4172 | 110 (143) |
| cure-eat50 | x2 | wall clock | `{"cureNow":true,"eatAt":50}` | no | 4 (4) | 8 | 0 | 0.00 | 0 | 10 | 10 | 0 | 4.0 | - | 932 | - | 107 (135) |
| cure-spec30 | x2 | wall clock | `{"cureNow":true,"specBelow":0.3}` | no | 4 (4) | 8 | 0 | 0.00 | 0 | 12 | 12 | 0 | 5.9 | - | 1205 | - | 100 (132) |
| e60-fledbow | x2 | wall clock | `{"cureNow":true,"eatAt":60,"fledRotation":["ranged"]}` | no | 4 (4) | 8 | 0 | 0.00 | 0 | 12 | 12 | 0 | 6.6 | - | 1034 | - | 100 (128) |
| e60-fledbow-chase | x2 | wall clock | `{"cureNow":true,"eatAt":60,"fledRotation":["ranged"],"chase":true}` | no | 4 (4) | 8 | 0 | 0.00 | 0 | 12 | 12 | 0 | 6.9 | - | 1194 | - | 99 (130) |

## Best set

`r7-snare-focus`: case `extra:gang-live-fast-snare-x2` (kit `live-walker-iron-snare`), `SPAR_A=gang-hunter`, `SPAR_A_OPTS`:

```json
{"cureNow":true,"eatAt":60,"freeze":"flee","focusRunner":0.4,"chaseBelow":0.4}
```

15 kills in 16 meetings (seeds 1 to 8), 0 deaths, with the freeze armour rule of #804 (the freeze takes the torso off). The same options and kit gave 12 in 16 before that rule (`r5-snare-focus`, `r6-snare-focus`). The snare + poison kit with these options gives 8 in 8 (`r7-snarep-focus`, seeds 1 to 4) and 12 in 16 before the rule (`r6-snarep-focus`). The base `cure-eat60` gives 4 in 16 (`r5-base`, `r6-base`). With the freeze hold read two ticks after the cast (#804, research finding 44) the same options give 16 in 16, 0 deaths, in 550 to 640 ticks a run where r7 took about 730 (`r8-snare-focus`, seeds 1 to 8).

## What the numbers say

- **Deaths: 0 in every meeting.** All runs but one end `RESULT ok`. `m-focus` seed 1 ends `RESULT fail` at 0 ticks with Prayer 1: its accounts logged in without their preset (the failure that a leftover `aiob*` save gives), so `m-focus` has 3 valid runs in its 4.
- **Under tick waits, freezing the runner triples the kills, and seeds 5 to 8 repeat seeds 1 to 4:** 6 kills in 8 meetings for the snare set at both, 2 in 8 for the base at both. Poison alone gives 5 in 8 (`r5-p-dds`, `r5-p-super`). `focusRunner` alone gives 2: our account turns to the runner but cannot hold it with no freeze. `cutOff: 3` on the snare set gives 4, and `diagonalFrozen` gives 3, so neither adds to the freeze.
- **Under wall-clock waits (192 meetings), no option of the existing fight loop moved kills much:** 0 to 3 a set. The cause of most escapes there is target choice: when a low gang account walked out, our account kept fighting the healthy account that had hit it last, which left with it (`SPAR_B_FOLLOW=1`), and took the runner only when it was nearly out of view (`PK lost ... after 11 ticks`). `focusRunner` (`scripts/pk-gang.ts`) fixes that choice.
- **The single-way rule** (`vendor/rs-sdk/server/content/scripts/skill_combat/scripts/pvp/pvp_combat.rs2:103-133`): an account hit by another player in the last 8 ticks cannot attack anyone else. `focusRunner` takes the runner only when that rule lets the attack through.
- **Poison** (`poison.rs2`, `pvp_melee.rs2:50`): a damaging hit of a dagger(p) poisons at 1 in 4 with severity 20, 4 damage each 30 ticks and 50 in all; the gang carries no antipoison, so the poison runs through its walk out. A super antipoison gives 600 ticks with no poison a dose, a plain one 150 (`anti_poison.rs2`).
- **Gap:** 8 or 16 meetings a set, one gang profile (`ganker-live`), practice bench only. The live market has no dragon dagger(p) for sale (`scripts/pk-kits.ts`): weapon poison on a dragon dagger makes one (`weapon_poison.rs2`).

## Timing

- Wall-clock waits: 96 runs, 101 s a run on average, 147 s at most; one set of 4 seeds in series took 6 to 7 minutes.
- Tick waits, seeds at once: 48 runs, 51 s a run on average, 95 s at most; a set of 4 seeds took 49 to 61 s, and the set of 8 seeds took 102 s (8 engines on 4 cores).
- The runs over 120 s (all wall-clock waits) each had a long meeting or a meeting at the tick cap; `bun scripts/measure/bench-speed.ts` on `extra:gang-live-fast-x1` showed that most of their time was ticks held for 2 s each while no session of the bot process counted as waiting (Giftedx/rs-sdk-bot#798).

## Raw lines

`docs/gang-climb-results.txt` has one entry per run: set, seed, case, options, `elapsedMs`, `ledgerTicks`, the walk-out counts, and the `RESULT` line.
