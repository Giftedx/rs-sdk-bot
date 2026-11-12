# Gang climb results

Hill climb of our side's fight options against the live-like dagger gang on the practice bench.

- Case: `extra:gang-live-fast-x2` (two meetings in one engine, each our account against three gang accounts at (3078, 3640)). Our profile `gang-hunter`, kit `live-walker-iron`; gang profile `ganker-live`, kit `ganker-dds`.
- Command per run: `FLEET_SIDE=local BENCH_OUT=... timeout 600 bun scripts/measure/aio-practice-bench.ts '^extra:gang-live-fast-x2$' --parallel 1 --no-keep --seed <1..4> --set SPAR_A=gang-hunter [--set SPAR_A_OPTS=<json>] [--set SPAR_IDLE_PRAYER_OFF=1]`, one bench at a time, on a cloud container with 15 GB RAM and 4 cores. Proof level: practice bench only.
- `FLEET_SIDE=local`: the container sets `FLEET_SIDE=claude-cloud`. The bench's generated `aiob*` accounts are not in `fleet/owners.json`, so they count as `local`, and `openBot` refuses them (`error: fleet: aiobfxuo701 belongs to the local side; this controller is claude-cloud`). The runner (`.practice/climb/run-set.ts`) deletes the `aiob*` saves and bot folders before each run, so each run logs in to its own preset saves.
- Columns: kills, deaths and sharks come from the `RESULT` line (`kills`, `died`, the sum of `eaten`). Ticks per run is the `RESULT` `ticks`. The three walk-out columns count distinct gang accounts in the case log: a `PK walks out of the Wilderness` line, followed by a `PK escaped` line or a `PK kill` of that account. Seconds per run is `elapsedMs` from the BENCH_OUT row. Sets are ranked by kills per meeting, then deaths, then sharks per meeting, then ticks.

## Results (seeds 1 to 4 for each set, 8 meetings per set)

| label | options | idle prayer off | runs (ok) | meetings | kills | kills/meeting | deaths | walked out | walked out, escaped | walked out, killed | sharks eaten mean / meeting | sharks / kill | ticks mean / run | ticks / kill | s per run (max) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| cure-eat60 | `{"cureNow":true,"eatAt":60}` | no | 4 (4) | 8 | 3 | 0.38 | 0 | 10 | 7 | 3 | 4.4 | 11.7 | 947 | 1263 | 104 (122) |
| cure | `{"cureNow":true}` | no | 4 (4) | 8 | 3 | 0.38 | 0 | 11 | 9 | 3 | 6.8 | 18.0 | 1056 | 1408 | 85 (93) |
| cure-chase50 | `{"cureNow":true,"chaseBelow":0.5}` | no | 4 (4) | 8 | 3 | 0.38 | 0 | 13 | 10 | 3 | 6.9 | 18.3 | 1149 | 1532 | 112 (142) |
| all4 | `{"cureNow":true,"chaseBelow":0.35,"specBelow":0.45}` | yes | 4 (4) | 8 | 2 | 0.25 | 0 | 9 | 7 | 2 | 3.9 | 15.5 | 1045 | 2091 | 100 (102) |
| base | `{}` | no | 4 (4) | 8 | 2 | 0.25 | 0 | 11 | 10 | 1 | 5.1 | 20.5 | 965 | 1931 | 100 (103) |
| cure-eat30 | `{"cureNow":true,"eatAt":30}` | no | 4 (4) | 8 | 2 | 0.25 | 0 | 13 | 11 | 2 | 6.1 | 24.5 | 1092 | 2184 | 104 (112) |
| idle | `{}` | yes | 4 (4) | 8 | 2 | 0.25 | 0 | 12 | 11 | 1 | 6.4 | 25.5 | 1099 | 2197 | 104 (137) |
| spec45 | `{"specBelow":0.45}` | no | 4 (4) | 8 | 1 | 0.13 | 0 | 9 | 8 | 1 | 3.4 | 27.0 | 865 | 3459 | 101 (111) |
| cure-spec60 | `{"cureNow":true,"specBelow":0.6}` | no | 4 (4) | 8 | 1 | 0.13 | 0 | 10 | 9 | 1 | 4.5 | 36.0 | 985 | 3938 | 98 (134) |
| chase35 | `{"chaseBelow":0.35}` | no | 4 (4) | 8 | 1 | 0.13 | 0 | 10 | 9 | 1 | 4.6 | 37.0 | 813 | 3252 | 97 (102) |
| cure-eat50 | `{"cureNow":true,"eatAt":50}` | no | 4 (4) | 8 | 0 | 0.00 | 0 | 10 | 10 | 0 | 4.0 | - | 932 | - | 107 (135) |
| cure-spec30 | `{"cureNow":true,"specBelow":0.3}` | no | 4 (4) | 8 | 0 | 0.00 | 0 | 12 | 12 | 0 | 5.9 | - | 1205 | - | 100 (132) |

## Best set

`cure-eat60`, options for `SPAR_A_OPTS` with `SPAR_A=gang-hunter`:

```json
{"cureNow":true,"eatAt":60}
```

It ties `cure` and `cure-chase50` on 3 kills in 8 meetings with 0 deaths, and wins the tie on sharks: 4.4 per meeting against 6.8, and 11.7 per kill against 18.0.

## What the numbers say

- **Deaths: 0 in all 96 meetings** (48 runs, all `RESULT ok`). Every set is safe against this gang.
- **Kills stay low: 20 in 96 meetings (0.21 per meeting).** The best set gets 3 in 8. The spread between sets is 0 to 3 kills per 8 meetings, and it does not follow the options in order: eatAt 30, 50 and 60 give 2, 0 and 3. With 8 meetings per set, a gap of 1 to 2 kills is within seed noise. The ranking is a lead to test, not a measured gain.
- **The gang gets away when it walks out: 130 walk-outs, 113 of them escaped, 18 killed.** Of the 20 kills, 18 were on an account that had started to walk out. No `chaseBelow`, `specBelow` or `eatAt` value changes this much: `chase35` lets 9 of 10 walk-outs escape, and `cure-chase50` lets 10 of 13 escape.
- The cause is in the engine, not in the options. In a single-way area, an account that took a hit from another player in the last 8 ticks cannot attack anyone else ("I'm already under attack.", `vendor/rs-sdk/server/content/scripts/skill_combat/scripts/pvp/pvp_combat.rs2:103-133`). While a second gang account keeps hitting ours, the runner cannot be attacked. `scripts/pk.ts:649` also ends the fight as `lost` once the target reaches Wilderness level 0, and `scripts/pk.ts:642` sends a chase walk only while our account stands still and the target is more than 5 tiles away. The fix needs fight-loop work on `claude/gang-live2`: spend the special, bow or freeze on the runner inside the 8-tick window, keep special energy for it, freeze the other gang accounts, or meet deeper in the Wilderness. These are untested leads.
- `SPAR_IDLE_PRAYER_OFF=1` alone does not help: `idle` gives 2 kills, as `base` does. Seed 1 gives the same `RESULT` with and without it.

## Timing

- The mean run takes 101 s of bench time (engine start about 1.3 s, account setup about 1 s; the rest is the script). Each batch of 4 seeds took 6 to 7 minutes of wall time.
- Six runs took over 120 s. Each had a long meeting, and the time grows with the ticks the engine runs (about 9.5 to 12.5 ticks a second):

| set | seed | elapsed s | RESULT ticks | ledger ticks max | meeting at the cap |
|---|---|---|---|---|---|
| idle | 2 | 137 | 1375 | 1488 | yes |
| cure-eat50 | 4 | 135 | 1148 | 1261 | no |
| cure-eat60 | 4 | 122 | 1229 | 1342 | no |
| cure-spec30 | 4 | 132 | 1528 | 1641 | yes |
| cure-spec60 | 3 | 134 | 1290 | 1403 | no |
| cure-chase50 | 1 | 142 | 1453 | 1567 | yes |

## Raw lines

`docs/gang-climb-results.txt` has one entry per run: set, seed, options, `elapsedMs`, `ledgerTicks`, the walk-out counts, and the `RESULT` line.
