# Joined plan

**Live work authorized.** Keep all owner goals: wealth, all quests and unlocks, all 19 skills at 99, best-in-slot gear, useful and rare items, specialist wins, full game coverage, and the main account rank 1 on all 24 boards at once. Preserve main and fresh clocks, pauses and assets. Follow [AGENTS.md](../../AGENTS.md) and the [script contract](../script-contract.md).

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

| Lane | Target | Next |
|---|---|---|
| Main simultaneous 24 | Main run gap from 43,726 to under 35,787 modelled ticks | Deliver the dialogue burst (`Q_BURST=1` in `scripts/generated/quest-lib.ts`; Druidic Ritual -31, Tree Gnome Village -114 ticks on practice, 3/3 each; about 1,500-1,750 across the quests before Overall, estimate). Then Smithing 1-41 by Superheat in the knights' stuns, the first five route steps on practice, and the live reaction delay (a us-east host if most clicks land 2+ ticks late) |
| Coverage | Every scoreboard entry live, then batch | Quest burst screening (`.practice/quest-burst-coverage-20261029/`), quests from practice to live, the four missing quest scripts (Heroes' Quest, Watchtower, Legends' Quest, Tai Bwo Wannai Trio), skills at or near 1 (Magic, Firemaking, Herblore, Ranged, Agility), domains with no named action (Wilderness, Treasure Trails, Shilo Village) |
| Specialist hiscores | A first #1 board | Price margins against `research/hiscores-2026-10-29.json`; Shaftshooter Ranged and Polevaulter Agility from fresh starts |
| Wealth / logistics / GE | Supplies with named consumers | Spend the 75,500 coins on route supplies (anvil bars, runes); a consuming job for the 125 sharks |
| Gear / collection | Route kit and best-in-slot gear | Combat cleanup and unattended release for Mightyrod; cow Defence batches |
| Efficiency / visibility | Coordinator running with the throughput fixes | Restart after the screening; prove the first workspace build; requalify `fresh-rune-supply-order` |

## Blockers

- The coordinator is paused by `.practice/stop-coordinator`. Isolated build workspaces, build/live overlap, the focus failure limit, the scoreboard and the smaller planner prompt run when it restarts. The practice server is shared, so the restart waits for the quest screening or stops it.
- `fresh-rune-supply-order` needs a new practice qualification: its file `scripts/generated/quest-lib.ts` changed.
- Main launch gates fail: plan wins, rehearsal, staged supplies, fresh targets (`research/hiscores-live.json` predates the record), machine clear. Bank staging is 5/73. The main account stays offline.
- [Monkey Madness](../../.practice/mm-exit/guard-candidate/full-1793062289389/proof.json) passes 2/3 full runs; installed qualification and rehearsal are open. [Arrav](../../research/heroes-partner.md) needs route, sustain or Magic prerequisites.
- [GE](../../.practice/ge-origin/qualified.json): origin and bounded offer/refund qualify; two webclient errors and shared ownership recovery are open.
- `packages/practice/src/cow-progress-order-proof.ts:154` starts a process without `windowsHide`.

## Evidence

- Live earning: eight actors banked 75,500 coins in 600-tick batches with reconciled receipts, life and logout ([proof](../../.practice/overnight-fleet-20261028/live-earning/proof.json)); one cohort, not unattended repeats.
- Sharks: Mightyrod banked 125 cooked sharks live with confirmed logout.
- [Wine](../../.practice/deliveries/wine-order-1793163518046-KvlTfl/report.json): Cooking 99 at 400 ms on practice; live pilot needs owned ingredients.
- [Ammo](../../.practice/deliveries/ammo-order-1793161432055-5O690E/report.json): 90 tips to 90 iron arrows on practice; live qualification is open.
- [Ranged](../../.practice/ranged-entry/repair-release/live/proof.json): level 7 live. [Rune Mysteries](../../.practice/quest-expansion/rune/live-proof.json) done live. [Swordinhand](../../.practice/quest-expansion/journal-live-proof.json): Defence 20, Strength 20.
- Blocks to preserve: combat failure 1792955012008, Woodpecker 1792972599531, all stop files.
