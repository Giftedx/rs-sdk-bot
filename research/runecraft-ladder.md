# Runecraft ladder (model)

Sources:
- Altar rows: `vendor/lostcity-content/scripts/skill_runecraft/configs/runecraft.dbrow`.
- Craft logic: `vendor/lostcity-content/scripts/skill_runecraft/scripts/runecraft.rs2:48-100`.
  XP = essence count x altar experience. Rune count does not change XP. All altars take the same `blankrune`.
- Measured cycle: 19 ticks per pack (rates.json `craft_air_runes_trade_loop`).

**Body altar pack cycle:** the carrier pipeline takes 9 or 10 ticks for the first pack and 12 to 14 ticks for each later pack (average 13.1 over 15 packs; per seed after the first: 13.2, 13.4, 12.8). **Conditions:** lockstep, seeds 7, 8, 9, `bun run bench '^extra:rune-carriers-body-44-56 A switch must save more crafting time than its travel,
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
 --seeds 7,8,9 --seed-jobs 3`: one crafter at Runecraft 44, 7 carriers with 27 essence, 6 packs, the case ends at 76, 76 and 73 ticks. **Evidence:** `RUNE_CARRIERS_RESULT` rows `ticks` and `tradeTicks` in `.practice/aio-bench/output-seed-<n>/extra_rune-carriers-body-44-56.log`; the engine trace (`BENCH_TRACE`, seed 7) of the second pack: the crafter clicks the altar at tick 20 and `runecraft.rs2:99` `p_delay(3)` holds it; the level-up window shows in the bot state 3 ticks after the click (the cause of the 3 ticks is not traced; `p_delay(3)` is the likely one) and the crafter closes it in the tick that the bot sees it (`RC_DBG` log); the helper asks for the trade at ticks 21, 23, 25 and 27 (`OpPlayer`, `ran=true`) and the crafter answers only after its `CloseModal` is processed at tick 26; the trade then takes 3 ticks (offer 25 to 28). So a later pack is the craft click, the 3-tick delay, the level-up window (about 3 ticks with the 1-tick lag of the state and 1 tick of the close) and the 3-tick trade. **Gap:** the close cannot go before the bot sees the window; the helper's request each tick instead of each second tick could save at most 1 tick a pack. `RUNE_HANDOFF_PIPELINE=1` with `RUNE_CRAFT_AFTER=trade-message` fails at all three seeds (`pipeline handoff needs the previous exact craft boundary and combined crafting`), so the lab 7-tick cycle of the rival is not reproduced. The row `runecraft` holds 194 packs x 12.8 to 13.4 ticks plus the rival air leg, ESTIMATE: no run with banking and many carriers exists.

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
