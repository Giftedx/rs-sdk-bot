# Gang climb results (in progress)

Bench case `extra:gang-live-fast-x2`, our profile `gang-hunter`, gang profile `ganker-live`, practice engine only. Round 1 done; round 2 (from `cure`) running.

| label | options | idle prayer off | runs (ok) | meetings | kills | kills/meeting | deaths | walked out | walked out, escaped | walked out, killed | sharks eaten mean / meeting | sharks / kill | ticks mean / run | ticks / kill | s per run (max) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| cure | `{"cureNow":true}` | no | 4 (4) | 8 | 3 | 0.38 | 0 | 11 | 9 | 3 | 6.8 | 18.0 | 1056 | 1408 | 85 (93) |
| all4 | `{"cureNow":true,"chaseBelow":0.35,"specBelow":0.45}` | yes | 4 (4) | 8 | 2 | 0.25 | 0 | 9 | 7 | 2 | 3.9 | 15.5 | 1045 | 2091 | 100 (102) |
| base | `{}` | no | 4 (4) | 8 | 2 | 0.25 | 0 | 11 | 10 | 1 | 5.1 | 20.5 | 965 | 1931 | 100 (103) |
| idle | `{}` | yes | 4 (4) | 8 | 2 | 0.25 | 0 | 12 | 11 | 1 | 6.4 | 25.5 | 1099 | 2197 | 104 (137) |
| spec45 | `{"specBelow":0.45}` | no | 4 (4) | 8 | 1 | 0.13 | 0 | 9 | 8 | 1 | 3.4 | 27.0 | 865 | 3459 | 101 (111) |
| chase35 | `{"chaseBelow":0.35}` | no | 4 (4) | 8 | 1 | 0.13 | 0 | 10 | 9 | 1 | 4.6 | 37.0 | 813 | 3252 | 97 (102) |
BEST {"label":"cure","opts":{"cureNow":true},"idlePrayerOff":false}
