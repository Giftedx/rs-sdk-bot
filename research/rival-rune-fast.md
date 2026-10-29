# Rival: rune.fast (bleugreen)

**Claim:** an AI agent swarm took a fresh account to 99 in all 19 skills on the demo server in 35,787 logged-in ticks (3 h 58 min 34 s at 400 ms a tick) and held #1 Overall from 26 October 2026.
**Evidence:** https://github.com/bleugreen/rune.fast (README; `data/summary.json`, `data/tricks.json`, `data/route-plan.json`). No license: facts and ideas only, no code.

| Fact | Value |
|---|---|
| Scale | 3,761 agent runs, 19,967 turns, 3,071 sessions, 544 merged issues, 20-26 October |
| Agent time | 1,258 agent-days in 7 days (about 180 agents at once on average) |
| Spend | $17,679 list-price tokens on 6 Claude Max plans and 1 ChatGPT Pro plan |
| Run order | 35,467 ticks expected, 33,064.5 best case (their RUN-ORDER.md at 1420515) |
| Run host | Ashburn, Virginia, 3 ms from the server: 123 to 180 reactions measured |

Measured techniques we also use: five dialogue clicks in one tick (10 to 2 ticks), unchecked wine, working through the Thieving stun, Charge recast, free logged-out time, relog world on the first tick (20 to 1 ticks), level-up page answered at once (3 to 0), bury between woodcutting rolls, five-click banking (24 to 5), burst trading (29 to 8), one tick per dialogue page, the knife reset (5.53 to 4.23 ticks), tutorial skip (547 to 6 ticks), helper-carried cannon.

**Gap:** our run host latency is unmeasured; their scale is about 36 times our concurrent agents.
