# Runecraft ladder (model)

Sources:
- Altar rows: `vendor/lostcity-content/scripts/skill_runecraft/configs/runecraft.dbrow`.
- Craft logic: `vendor/lostcity-content/scripts/skill_runecraft/scripts/runecraft.rs2:48-100`.
  XP = essence count x altar experience. Rune count does not change XP. All altars take the same `blankrune`.
- Measured cycle: 19 ticks per pack (rates.json `craft_air_runes_trade_loop`).

**Carrier pack cycle:** 8 ticks from one craft to the next, with or without level-ups, after a first pack of 4 or 5 ticks. **Conditions:** hosted CI lockstep, seeds 7, 8, 9, `bun scripts/hosted-bench.ts '^extra:rune-carriers-' --seeds 7,8,9`; one crafter and 2 to 8 carriers with 27 essence each, beside the altar; the tick-driven trade (`tickTransfer` in `scripts/rune-carrier-trade.ts`, the default of `scripts/rune-carriers.ts`; `RUNE_TICK_TRADE=0` keeps the polled transfer). **Evidence:** `RUNE_CARRIER_BATCH` and `RC_TICK_TRADE` rows in `.practice/hosted-bench/44485487430/bench-p1-s<seed>-*/aio-bench/output/extra_rune-carriers-<case>.log`. Air 1 to 44 (7 packs) takes 59, 59, 59 ticks; body 44 to 56 (6 packs, 12 level-ups) 50, 51, 52; body 80 to 82 (8 packs, 2 level-ups) 67, 66, 67; fire 14 to 40 (2 carriers that bank between packs) 125, 124, 126. The polled transfer on master takes 84, 84, 83 / 73, 74, 74 / 94, 92, 96 / 131, 130, 129 on the same host (runs 44480033589, 44479866696, 44482952779, 44480033278).

Why 8 ticks (engine trace, `BENCH_TRACE`, and the engine sources):
- The craft runs `p_delay(3)` (`runecraft.rs2:99`), which sets `delayedUntil` to the craft tick + 4 (`PlayerOps.ts` `P_DELAY`). Client input decodes before the flag clears in `processPlayers` (`World.ts` `processClientsIn`), so the crafter's request in that tick is dropped. The trade opens at craft + 5.
- An offer resets both accepts (`trade.rs2` `movetotrade`), so the helper offers and accepts at craft + 6. The crafter accepts the offer screen and clicks confirm in one tick; `Player.openMainModal` opens the confirm screen at once, so the confirm click in the same decode is valid. The helper clicks confirm each tick from the tick after its offer; the server refuses it until the confirm screen is open. The trade ends at craft + 7 in both read orders.
- The crafter crafts at craft + 8. An altar click under the confirm screen closes it (`OpLocHandler`: `clearPendingAction` closes the modal) and cancels the trade, unless the helper's confirm decodes first. Players of one address decode in login order (`World.ts:1248-1254`), so the crafter logged in after its helpers could craft at craft + 7.
- A level-up window opens after the craft delay and makes the crafter busy. The crafter closes it and asks in the same tick; the close decodes first, so the request sees a free crafter. Level-ups add no tick.
- Each actor clicks in its own tick listener. In the lockstep engine a session acknowledges a tick when its script waits (`packages/core/src/inprocess.ts` `acknowledgeTick`), and its clicks of that tick leave with the acknowledgement. In the polled transfer the helper's acknowledgement could leave before its click, so its offer and its confirm each slipped one tick.

**Gap:** a run of 194 packs with banking carriers is not measured. In the fire case the crafter waits 102 ticks for the first carrier's bank trip before pack 3 (`waiting` in `RUNE_CARRIER_BATCH`), so a rota needs enough carriers to cover a bank trip. The craft at craft + 7 (crafter logged in last) is not built: live player addresses are not proved to share one bucket.

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
