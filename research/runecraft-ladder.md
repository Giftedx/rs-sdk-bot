# Runecraft ladder (model)

Sources:
- Altar rows: `vendor/lostcity-content/scripts/skill_runecraft/configs/runecraft.dbrow`.
- Craft logic: `vendor/lostcity-content/scripts/skill_runecraft/scripts/runecraft.rs2:48-100`.
  XP = essence count x altar experience. Rune count does not change XP. All altars take the same `blankrune`.
- Measured cycle: 19 ticks per pack (rates.json `craft_air_runes_trade_loop`).

**Body altar pack cycle:** a pack takes 10.05 to 10.32 ticks without a level-up and about 2.1 ticks more with one, after a first pack of 6 or 7 ticks. **Conditions:** hosted CI lockstep, seeds 7, 8, 9, `bun scripts/hosted-bench.ts '^extra:rune-carriers-body-(44-56|80-82)$' --seeds 7,8,9`; one crafter and 6 or 8 carriers with 27 essence each; the crafter asks the helper in the same tick as the helper asks the crafter (`scripts/rune-carrier-trade.ts`, the default; `RUNE_RECIPROCAL=0` sends the helper's request only). **Evidence:** `RUNE_CARRIERS_RESULT` rows in `.practice/hosted-bench/<run>/bench-p1-s<seed>-*/aio-bench/output/extra_rune-carriers-body-<from>-<to>.log`. Crossed requests, run 44479866696: Runecraft 44 to 56 (about 12 level-ups in 6 packs) takes 73, 74, 74 ticks, 12.0, 12.0, 12.0 a pack after a first pack of 6, 6, 7; 80 to 82 (2 level-ups in 8 packs) takes 92, 89, 90 ticks, 11.14, 10.71, 11.0 a pack after a first pack of 7, 7, 6. Single request, run 44479230095: 77, 77, 76 ticks, 12.4, 12.2, 12.2 a pack, first pack 8, 9, 8; and 96, 91, 95 ticks, 11.43, 10.86, 11.43 a pack, first pack 9, 7, 8. Crossed requests also win the air case `extra:rune-carriers-air-1-44` (84, 84, 83 ticks against 92, 90, 93) and the fire case `extra:rune-carriers-fire-14-40` (131, 130, 129 against 133, 133, 134), runs 44480033589 and 44480033278. From pack 2 on the crossed request alone does not open the trade (`responseSent` true in `RC_TRADE_WAIT`), so the crafter next to the helper answers the helper's request at once. A 2-tick wait before that answer takes 111, 112, 111 ticks in the 80 to 82 case (run 44479610373). The engine trace of the second pack (`BENCH_TRACE`): the altar click at tick 20, `runecraft.rs2:99` `p_delay(3)`, the level-up window closed in the tick the bot sees it, the helper's requests at ticks 21, 23, 25, 27 refused until the close is processed at 26, then 3 ticks of trade. **Gap:** `RUNE_HANDOFF_PIPELINE=1` with `RUNE_CRAFT_AFTER=trade-message` gives no gain: packs 2 to 4 of the 80 to 82 case take 11, 12, 12 / 10, 12, 10 / 11, 11, 12 ticks (mean 11.2), against 10, 11, 12 / 10, 11, 11 / 12, 11, 11 (mean 11.0) without it, on one hosted run each (`bun scripts/hosted-bench.ts`, runs 44476113857 and 44476114786, seeds 7, 8, 9). The pipeline opens its request 4 publications after the craft (`pipelineOpeningReady` in `scripts/rune-pipeline.ts`), which is no earlier than the plain request. It also stops at the first level-up: the helper's request gets "is busy at the moment." 7 times and the pipeline path sends no retry, so every case fails with `combined essence handoff and craft did not reconcile`. The 7-tick lab cycle of the rival is not reproduced. Ticks differ between a loaded local PC and the hosted runner by up to 13 ticks for the same seed (80 to 82: 102 local, 89 to 93 hosted), so compare only runs of one host.

The table assumes 19 ticks per pack at every altar. A switch must save more crafting time than its travel,
entry and helper restocking cost. This assumption does not prove a sustained route rate.
XP per essence (x25): air 125, fire 175, body 187.5, chaos 212.5, nature 225, law 237.5.

| Altars used | Ticks to 99 | Minutes at 600 ms |
|---|---|---|
| air only | 5,621 | 56 |
| free altars (air to body) | 3,749 | 37 |
| + chaos, nature, law | 2,976 | 30 |

`bun research/runecraft-ladder.ts` reprints the table. 28 essence instead of 27 (drop the talisman
inside) saves about 3.6%.

Access:
- Death (65): not usable. Its enter and exit coords equal the altar coord (0_50_50_21_18), so no ruins lead in.
- Cosmic (27): ruins in Zanaris. Zanaris needs the Lost City quest. Cosmic (80) is below chaos (85) at 35, so skip it.
- Chaos (35): exit coords are at z 3584+, in the Wilderness. PvP risk on the demo server. Not verified.
- Nature (44): Karamja. Law (54): Entrana (no weapons or armour allowed on the boat).
- Members altars need a members world. `vendor/rs-sdk/fly.toml` sets `NODE_MEMBERS = "true"`. I have not
  verified that this is the demo server's config.

Hidden cost (not in the 19-tick rate):
- The helper holds only one pack. The measured 12-tick resupply assumed the helper already has essence.
  A helper must bank and come back each pack. So the 19-tick cycle needs a rotation of several helpers.
  The helper trip time is not measured.
- Each altar needs a talisman to enter, for the crafter and for each helper inside.

Talisman sources (game scripts):
- Nature and chaos talismans: only from the shared rare drop table
  (`vendor/lostcity-content/scripts/drop tables/scripts/shared_droptables.rs2:71-74`). A monster
  underground (z above 6400) drops chaos. A monster on the surface drops nature. Rare: plan to buy them.
- Law talisman: each crafter and helper needs its own Troll Stronghold reward
  (`vendor/rs-sdk/server/content/scripts/quests/quest_troll/scripts/quest_troll.rs2:368`).
  `skill_runecraft/configs/runecraft.obj` sets `tradeable=no` on `law_talisman`; an owned partner cannot
  supply it by trade. The public market item endpoint for 1458 returns 404, consistent with that config.
  A law route needs each participant's observed quest reward and altar access; those route checks are open.
- So the order is: free altars first (3,749 ticks to 99). Add nature and law only when a talisman is in hand.

Helper rotation estimate (not measured):
- Air ruins exit: 0_46_51_39_24 = (2983, 3288). Nearest bankers: Falador east (3011-3015, 3353), knowledge/npcs.json banker1/banker2. Distance 65 tiles.
- Walking round trip about 134 ticks, plus bank and ruins about 15: about 150 ticks per helper per pack.
- To keep one crafter at 19 ticks per pack: about 150 / 19 = 8 helpers. The design caps online accounts at 30.
- Running halves the walk, but run energy runs out. Measure a real helper trip before sizing the team.
