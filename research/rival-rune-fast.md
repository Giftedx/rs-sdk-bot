# Rival: rune.fast (bleugreen)

**Claim:** an AI agent swarm took a fresh account to 99 in all 19 skills on the demo server in 35,787 logged-in ticks (3 h 58 min 34 s at 400 ms a tick) and held #1 Overall from 26 October 2026.
**Evidence:** https://github.com/bleugreen/rune.fast (README; `data/summary.json`, `data/tricks.json`, `data/route-plan.json`). License: the map viewer in `packages/world/` is BSD 2-Clause (dennisdev; the text at https://rune.fast/licenses/LICENSE.txt); the repository states no license for its own files. The owner knows the author and states that the author shared the project on Discord for others to use, so its methods, routes and data are used here.

| Fact | Value |
|---|---|
| Scale | 3,761 agent runs, 19,967 turns, 3,071 sessions, 544 merged issues, 20-26 October |
| Agent time | 1,258 agent-days in 7 days (about 180 agents at once on average) |
| Spend | $17,679 list-price tokens on 6 Claude Max plans and 1 ChatGPT Pro plan |
| Run order | 35,467 ticks expected, 33,064.5 best case (their RUN-ORDER.md at 1420515) |
| Run host | Ashburn, Virginia, 3 ms from the server: 123 to 180 reactions measured |

Their measured techniques against our default AIO routes (`SKILLER_ROUTES` in `scripts/aio-skiller.ts`):

| Technique (their saving) | Our state | Evidence |
|---|---|---|
| Unchecked wine | used | `scripts/cook-wine.ts:13-48` |
| Free logged-out time | used | `scripts/cook-wine.ts:48` |
| Tutorial skip (547 to 6 ticks) | used | `scripts/gather-ore.ts:141` |
| Five dialogue clicks in one tick (878 ticks over all quests) | present, off unless `Q_BURST=1` | `scripts/generated/quest-lib.ts:43-44` |
| Level-up page answered at once (3 to 0) | in two scripts only | `scripts/fishcook.ts:375`, `scripts/generated/woodcutting.ts:302` |
| Knife reset (5.53 to 4.23 ticks a willow log; 2,739 ticks over their run) | in two scripts that are not a default route | `scripts/fishcook.ts:858-861`, `scripts/generated/woodcutting.ts:292-303` |
| Work inside the Thieving stun (470 to 510 ticks) | not in a route: the stun handler eats or waits | `scripts/goldfarm.ts:361-365`; measured only in `scripts/measure/stun-guest.ts` |
| Bury between woodcutting rolls (2.07 to 0.23 ticks a bone) | not in a route | no bury call in `woodcut-supply.ts`, `gather-ore.ts`, `gather-yews.ts` |
| Charge recast (Magic 80 to 99 in 32 to 33 ticks) | not in a route | no Charge cast in `magic-order.ts` or `microbot-magic-*.ts` |
| Five-click banking (24 to 5 ticks) | not in core: one deposit per item id | `packages/core/src/deposit.ts:63-71` |
| Burst trading (29 to 8 ticks) | not measured here | `scripts/rune-carrier-trade.ts:167` accepts eagerly |
| Helper-carried cannon | measured only | `scripts/measure/combat-melee.ts` |
| Relog world on the first tick (20 to 1) | not measured here | `scripts/measure/relog-bench.ts` |

**Gap:** our run host latency is unmeasured; their scale is about 36 times our concurrent agents.
