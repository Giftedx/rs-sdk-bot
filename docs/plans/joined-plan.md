# Joined plan

**Live work authorized.** Owner goals: Haggis rank 1 Overall under the record; specialist board wins with priced margins; all quests; all useful items and best-in-slot gear; wealth for them. Helpers work from the route supply bill (`bun packages/planner/src/supply-bill.ts`).

## Scoreboards

Every task names the scoreboard entries it moves and by how much.

| Scoreboard | Now | Source |
|---|---|---|
| Main run gap | 43,726 modelled ticks against the 35,787 record (`cairnmax20x`) | `bun packages/planner/src/haggis-cli.ts research/hiscores-live.json` |
| Boards held | 0 of 24 | `bun packages/planner/src/scout-cli.ts` |
| Coverage | skills 7/19 at 99; quests 3/68 live; items 94/2,756 held; actions 2,325/5,807 named | `bun packages/router/src/coverage.ts` |
| Useful capacity | 75,500 coins and 125 sharks banked with no consumer | delivery receipts |

The planner's best set wins 2 of 24 boards (Quest Points, Hitpoints); no known single run wins all 24. [Cairn's route](../../research/community-and-upstream.md) plans 34,143 ticks; `bun packages/planner/src/cairn-cli.ts` prices it against ours.

## Lanes

Main run, coverage and live work run at once, so no lane starves the others. Every free live slot runs a whole-band batch or supplies a named consumer.

| Lane | Owner | Target | Next |
|---|---|---|---|
| Main Overall | local Codex | Main run gap from 43,726 to under 35,787 modelled ticks, with the route supply bill staged | Deliver the dialogue burst (`Q_BURST=1` in `scripts/generated/quest-lib.ts`; Druidic Ritual -31, Tree Gnome Village -114 ticks on practice, 3/3 each; about 1,500-1,750 across the quests before Overall, estimate). Then Smithing 1-41 by Superheat in the knights' stuns, the first five route steps on practice, and the live reaction delay (a us-east host if most clicks land 2+ ticks late) |
| Coverage | Codex cloud (`cloud` side) | Every scoreboard entry live, then batch | Quests from practice to live on cloud accounts, the four missing quest scripts (Heroes' Quest, Watchtower, Legends' Quest, Tai Bwo Wannai Trio), skills at or near 1 (Magic, Firemaking, Herblore, Ranged, Agility); the offline reachability audit (`scripts/route-audit.ts`) for every quest start, shop, spawn and job tile |
| Autopilot | local Claude; the `claude-cloud` side (Claude Code cloud, README "Claude Code cloud fleet side") runs Quickhandjob, TrouserSnake, TheFullMonty and UnderMyKilt under its planner alone: from a fresh Lumbridge start each trained Thieving 1 to 55 live (`thieving55`) in 1,285, 1,736, 2,274 and 2,215 ticks, banked 607, 826, 550 and 530 coins at Ardougne with `LOGOUT logged-out` and no death, and farmed knights (`goldfarm`, 10.7 to 10.8 coins per tick measured over 4,314 and 6,888 ticks) to Thieving 99 with 67,780 to 114,257 coins banked each, 362,863 in all. When the relayed gateway closes with code 1012 `server_draining`, a farm run ends `RESULT fail session ended: disconnected` and the next run banks the carried pack on its first trip with no coins lost (five such ends, 204 to 2,866 s into the session). The `claude-cloud-2` side (a second Claude Code cloud container) runs Deeppockets, Fatstack and Fingerblastr under its planner: each trained Thieving 1 to 55 live (`thieving55`) in 1,193, 1,288 and 2,014 ticks with hpMin 4, 1 and 1, no death and `LOGOUT logged-out`, banked 459, 532 and 865 coins at Ardougne, and the planner moved each to `goldfarm` on its own knight spot (2652,3318, 2669,3298 and 2671,3313) within 30 s of its RESULT | Every account on every side in a useful job with no hand edits | The planner (`scripts/autopilot.ts`, `packages/planner/src/autopilot.ts`) plans only accounts no hand job names, so a dry run on this swarm.json plans nothing. Pilot: mark two to four weak hand jobs `"autopilot": "local"` (Woodpecker: 0 coins in 5,649 goldfarm ticks; YewFirst: quest chain fails at Murder Mystery) and run `bun scripts/autopilot.ts --daemon` beside the swarm; then widen by batches of four after two useful live results. A `trains` job is written `repeat: false`: its ok RESULT is the target met, the swarm holds the account's `done` end, and the daemon passes within 30 s of that RESULT (`finishedTrainers`) to hand it the job the level unlocks; a trainer's fail RESULT short of the target goes through the supervisor's retries and the swarm's standing retry. A stop file the controller wrote itself (`SWARM_STOP` in `scripts/swarm.ts`: a job that left the plan, stop-swarm) is not an owner pause: the planner plans that account again and removes the file with the job that replaces it, and a standing job retries a `stopped` or `exit unknown` end by itself once the account is offline; an owner's stop file holds both
| Specialist hiscores | local Claude | A first #1 board | Price margins against `research/hiscores-2026-10-29.json`; Shaftshooter Ranged and Polevaulter Agility from fresh starts |
| Wealth / logistics / GE | local Claude | Supplies with named consumers | Goldfarm on split knight spots; lobster chains for the 607 short; cross-side orders (`scripts/fleet-order.ts`) between local and cloud stock |
| Gear / collection | local Claude | Route kit and best-in-slot gear | Combat cleanup and unattended release for Mightyrod; cow Defence batches |
| Efficiency / visibility | Codex cloud | Faster, smaller bot processes and a green test gate | Linux CI (needs GitHub Actions billing); route search memory and time down 30% (`scripts/measure/route-memory.ts`) with a golden route test |

## Blockers

- The coordinator runs under `.practice/coordinator/owner.json`; `bun run coordinate --stop` pauses it. A change to the swarm's own code (`scripts/swarm.ts` and its imports) forces a controller rollout that pauses every standing job, so controller fixes ship in one batch. The practice server is shared: one heavy practice qualification at a time.
- `fresh-rune-supply-order` needs a new practice qualification: its file `scripts/generated/quest-lib.ts` changed.
- Main launch gates fail: plan wins, rehearsal, staged supplies, fresh targets (`research/hiscores-live.json` predates the record), machine clear. Bank staging is 5/73. The main account stays offline.
- [Monkey Madness](../../.practice/mm-exit/guard-candidate/full-1793062289389/proof.json) passes 2/3 full runs; installed qualification and rehearsal are open. [Arrav](../../research/heroes-partner.md) needs route, sustain or Magic prerequisites.
- [GE](../../.practice/ge-origin/qualified.json): origin and bounded offer/refund qualify; two webclient errors and shared ownership recovery are open.

## Evidence

- Live earning: eight actors banked 75,500 coins in 600-tick batches with reconciled receipts, life and logout ([proof](../../.practice/overnight-fleet-20261028/live-earning/proof.json)); one cohort, not unattended repeats.
- Sharks: Mightyrod banked 125 cooked sharks live with confirmed logout.
- [Wine](../../.practice/deliveries/wine-order-1793163518046-KvlTfl/report.json): Cooking 99 at 400 ms on practice; live pilot needs owned ingredients.
- [Ammo](../../.practice/deliveries/ammo-order-1793161432055-5O690E/report.json): 90 tips to 90 iron arrows on practice; live qualification is open.
- [Ranged](../../.practice/ranged-entry/repair-release/live/proof.json): level 7 live. [Rune Mysteries](../../.practice/quest-expansion/rune/live-proof.json) done live. [Swordinhand](../../.practice/quest-expansion/journal-live-proof.json): Defence 20, Strength 20.
- Blocks to preserve: combat failure 1792955012008, Woodpecker 1792972599531, all stop files.
