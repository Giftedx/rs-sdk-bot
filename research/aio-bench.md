# The AIO bench: findings

Command and rules: [script contract](../docs/script-contract.md#the-aio-bench). Engine patch: `patches/rs-sdk.md` item 10. Raw results: `.practice/aio-bench/`.

## Lockstep engine

**Claim:** a lockstep engine with one seed and a new engine for each case gives the same tick count on each run. **Conditions:** `bun run bench --smoke --no-keep`, seed 7, six engines at a time, three runs. **Evidence:** 15 of 15 cases equal in the three runs (`.practice/aio-bench/smkw1.log` to `smkw3.log`); the per-tick world traces of `crest` and `dwarfcannon` are byte-identical between two runs (`trA/`, `trB/`). **Gap:** a case with a partner account is not in the three-run check.

**Claim:** a shared engine makes one case change the result of the next. **Conditions:** seed 7, same engine build. **Evidence:** `dwarfcannon` 823 ticks after 20 earlier cases (`lockfull1.json`), 762 ticks on a new engine (`fresh1.json` to `fresh3.json`).

**Claim:** the lockstep tick counts agree with the 150 ms engine. **Conditions:** quests, one account, seed 7 against one 150 ms run. **Evidence:** `walk-to` 84 against 85; `barcrawl` 1401 against 1398; `biohazard` 1293 against 1292; `blackknight` 287 against 291 (`quests-base-s7.json`, `pass1.json`). On a wall-clock engine at 400 ms a tick, the live tick length, `biohazard` takes 1315 ticks against 1293 on lockstep, `blackknight` 292 against 287 and `imp` 9 against 9 (`.practice/aio-bench/bio400.json`, one run, `BENCH_TICK_MS=400 bun run bench <pattern> --wall-clock`). **Gap:** three quests and one run; combat quests differ by the random rolls.

**Claim:** 64 quests run in under 10 minutes. **Conditions:** six engines, this PC, no other load. **Evidence:** 588 s and 571 s wall (`quests-base-s7.log`, `quests-burst-s7.log`). The same quests took about 70 minutes on one 150 ms engine with four accounts in one world.

**Claim:** a shorter client loop is not usable. **Conditions:** `LOOP_MS` 1 and 5 against 20 in `vendor/rs-sdk/server/webclient/src/lite/session.ts`. **Evidence:** `biohazard` 1626 and 1595 ticks against 1294; wall time 25% lower. The client counts one frame for each loop, and animations end by frame count.

**Claim:** when a case gives two tick counts with one seed, the engine is not the cause. **Conditions:** `troll`, seed 7, two runs, each on a new engine with the per-tick world trace. **Evidence:** the two traces are byte-identical over 852 ticks (player and npc tile hashes, random draws for each tick), and the script reports 703 ticks in one run and 551 in the other (`.practice/aio-bench/trollA/`, `trollB/`). From about tick 400 the player tile does not change and the draw count is the same in both: the fight step makes no progress in either run. **Gap:** the part of the fight step that ends on the wall clock is not found; `bot.attack` in the SDK has limits in milliseconds.

## Routes

**Claim:** every catalog route is in one of three groups: 181 of 216 have a case that passes at seed 7, 33 cannot run as one case and name the cause, and 2 have a case that fails with a recorded error (`waterfall`, `mm`). **Conditions:** lockstep, a new engine for each case; the start state of each case comes from the worker's entry checks, a proof or the map files. **Evidence:** `bun run bench --coverage`; `.practice/aio-bench/baseline-seed7.json`; the 105 non-quest cases run in 271 s on six engines. **Gap:** a case proves one small job from one start state, not the route at every level or place.

**Claim:** `viking`, `squire` and `zanaris` pass at every seed tried. **Conditions:** seeds 7 to 10, a new engine for each case. **Evidence:** `viking` passes at 7, 8 and 9 (3001, 2727, 2787 ticks): the retreat rule fired in Koschei's fight, which ends at 0 hp by design, and `planLowHp` in `quest-lib` now switches the rule off for that fight. `squire` passes at four seeds with a wider bound on the cupboard search, and `zanaris` with a wider bound on the axe hunt.

**Claim:** `fluffs` fails when the kitten is in the west crate. **Conditions:** seed 9. **Evidence:** the crate at 3298,3514 is the one of six the bot does not reach: `bot.walkTo` answers "Stuck at (3307, 3506)", and `walkPath` clicks 120 times at that tile with no move (`.practice/aio-bench/output/quester_quest_fluffs.log`). **Gap:** the way round to that crate is not found.

**Claim:** `waterfall` stops at the Tree Gnome Village maze. **Evidence:** the walk to the maze mouth 2505,3190 ends at 2509,3187 at any tolerance; the planner has no route from there to the first maze waypoint 2512,3190; the route search to the goal goes round the hedge to 2529,3140, where the client refuses the walk. **Gap:** the tile where the maze opens is not found.

**Claim:** five quests fail at one or two of four seeds on a random roll they do not recover from. **Conditions:** seeds 7 to 10, a new engine for each case. **Evidence:** `eadgar` fails at 7 and 9 (retreat with no food, death); `mm` at 7 and 9 (`talk garkor`); `legends` at 9 and 10; `totem` at 10; `troll` at 7 and 10 in one run and passes at 7 in another (`.practice/aio-bench/quests-seeds-7-10.log`). **Gap:** no fix exists for any of them.

**Claim:** `Q_BURST=1` breaks 20 quests that pass without it and saves 0.7% on the rest. **Conditions:** seed 7, 64 quests. **Evidence:** 44 of 67 pass with the flag against 61 of 64 without; 30,203 ticks against 30,426 on the 41 quests that pass both ways; the errors are `dialogue click refused` and a failed talk step (`quests-burst-s7.json`). Three of the failures repeat on the 150 ms engine. Largest gains: `chompybird` 772 to 474, `murder` 261 to 204.

## Recorded dialogue plans

**Claim:** a recorded dialogue plan makes ten quests faster: 12,632 ticks against 13,912 over nine of them at three seeds (9.2% fewer). **Conditions:** seeds 7, 8 and 9, a new engine for each case; `scripts/generated/talk-plans.json` holds the clicks each talk took in a passing run, and `talk` sends them in one write. **Evidence:** `cook` 8 against 18; `imp` 9 against 22; `hetty` 53, 48, 48 against 68, 66, 62; `hauntedmine` 791, 853, 823 against 929, 1052, 1181; `cog`, `arena`, `grail`, `ikov` and `murder` fewer in total (`.practice/aio-bench/seed-7.json` to `seed-9.json` against `quests-seeds-7-10.log`). `fluffs` fails at one seed of three with and without a plan. **Gap:** a plan breaks a talk whose step check reads page text: the plan answers pages before the client shows them, and 35 of 50 quests failed with their recorded plans (`quests-plans.log`). Reading the text from the packets repairs most of them and removes the gain. The sweep mode names its quest script in `QUEST_SCRIPT_ID`, so it uses the same plans: Cook's Assistant through the sweep takes 8 ticks against 18.

## Burst banking

**Claim:** one "deposit all" for each item id in the same tick does not make a bench case faster. **Conditions:** seed 7, `depositPack` in `packages/core/src/deposit.ts` with the burst against one item id a tick; the three cases that call it. **Evidence:** `market:shop-buy` 575 ticks with the burst against 420 without; `skiller:fletching:arrows` and `skiller:thieving:knights` end at their tick cap in both, and the knights case makes no bank trip in 1,500 ticks (`.practice/aio-bench/burst1.log`, `burst0.log`). The change is not in the code. **Gap:** no bench case banks a pack of many item ids, so the bench cannot show the gain the rival states (24 to 5 ticks for 24 item ids); `market:shop-buy` gave 402 and 420 ticks in two runs of the same code.

## Rival comparison

**Claim:** rs-stun-toolkit states fewer ticks than ours on 11 quests; the causes are a planned dialogue burst and an amulet of glory in the kit. **Conditions:** their lockstep sim with their kit and stats against our `quest_<slug>` presets at seed 7; code read on both sides, nothing of theirs run here. **Evidence:** their `run-<quest>.share.md` medians in `RIVAL_QUEST_TICKS` (`scripts/measure/aio-bench-cases.ts`); estimated savings: `mortton` 400 to 550, `dragon` 220 to 270, `grail` 200 to 280, `squire` 150, `scorpion` 130, `merlin` 110 to 130, `fishingcompo` 100, `hunt` 60 to 80, `gobdip` 25 to 30, `cook` and `sheep` 10 each. **Gap:** every saving is an estimate until its port runs on the bench; their `mortton` run carries the materials that ours buys.

**Claim:** their bot layer sends more per tick than ours in three places. **Evidence:** a whole conversation with its choice clicks in one write (`speedrun/legs/q-lib.ts` `talk`) against one page a tick (`scripts/generated/quest-lib.ts` `converse`); deposits and withdrawals in one burst (`speedrun/core.ts` `bankSwap`) against one deposit for each item id (`packages/core/src/deposit.ts` `depositPack`); up to five inventory actions a tick (`core.ts` `burst`) against one. **Gap:** none is measured here.

## The engine drops a skill action when an AFK event is ready

**Claim:** the pinned engine sets `afkEventReady` for a player on a roll every 500 ticks. The next cooking, mining or other skill script that tests `afk_event` then returns with no message and no effect. With `NODE_RANDOM_EVENTS` off, no event spawns, so the action is lost for nothing. The local patch makes `afk_event` false when `NODE_RANDOM_EVENTS` is off. **Conditions:** lockstep, seed 7, `quester:mode:tbwt-owned`. **Evidence:** `.practice/aio-bench/trace/quester_mode_tbwt-owned.actions` shows `OpLocU` at tick 806 and `ran=true` at tick 807, and the bot gets no cook message; `vendor/rs-sdk/server/content/scripts/skill_cooking/scripts/cooking.rs2` returns after `afk_event`; with the patch the case passes in 1346 ticks. **Gap:** a server without this patch still drops the action, so a worker must send a skill action again when it has no effect; 35 content scripts test `afk_event`.

## The action trace

**Claim:** `BENCH_TRACE=<dir> bun run bench <pattern>` writes `<case>.actions` beside `<case>.trace`. A line with `in` is one message from a bot and the result of its handler. A line with `act` is one tick in which the player holds a target: `access` is false when the player is delayed, protected or has a window open, `ran` is true when the engine started the script for the action. **Conditions:** lockstep engine, `SIM_ACTION_FILE` set by the practice stack. **Evidence:** `vendor/rs-sdk/server/engine/src/simseed.ts`, `NetworkPlayer.ts`, `Player.ts`. A line with `hunt` is one NPC that could hunt the player: `candidate`, or `skip=` with the check that refused (`too-strong`, `player-in-combat`, `npc-in-combat`, `var`, `inv`, `player-busy`, `player-afk`). **Gap:** the trace has no line for a script that an NPC runs.

## A shade attack locks out other shades for 100 ticks

**Claim:** a shadow that attacks sets bit 4 of `%morttonmulti` on the player, and the hunt rule of every shadow skips a player with that bit set until `shadeattack_reset` clears it 100 ticks later. A shadow by the entrance door of the Fiyr lair can set it while the bot walks in, so no shadow in the hunt room attacks for up to 100 ticks. The worker waits `SHADE_INCOMING_TICKS` (125) for its first shade. **Conditions:** lockstep, seed 7, `fighter:shade`. **Evidence:** `.practice/aio-bench/trace/fighter_shade.actions` has `hunt npc=shadeshadow_level5 ... candidate` at tick 277 at the door and `skip=var 340&16:536870928` on each later tick in the hunt room; `vendor/rs-sdk/server/content/scripts/minigames/game_mortton/scripts/mortton_shades.rs2`; the case passes in 744 ticks. **Gap:** one seed.

## The knife reset on a fresh woodcutter

**Claim:** from a fresh account to Woodcutting 45, the knife reset takes 6.9% fewer ticks than plain chopping: 984, 880 and 716 ticks against 1064, 948 and 758 at seeds 7, 8 and 9 (2580 against 2770). **Conditions:** lockstep, `skiller:woodcutting:fresh45`, preset `wc_fresh`, XP rate 25; plain chopping is the same case with `--set WC_KNIFE=0`. **Evidence:** `bun run bench '^skiller:woodcutting:fresh45$' --all --seeds 7,8,9`, then the same with `--set WC_KNIFE=0`. **Gap:** the run includes the walk, the pickpocket for coins and the axe purchase, so the saving on the chop alone is larger than 6.9%.

## XP for each 1,000 ticks

**Claim:** each run prints `xpGain`, the XP over all skills that the account gained, on its `LEDGER` line, and the bench table shows it for each 1,000 ticks. Every case has this speed number with no pattern for each case. **Conditions:** XP rate 25 on practice; a case that ends after one unit of work has a rate that is mostly its walk. **Evidence:** `packages/core/src/ledger.ts`, `scripts/measure/aio-practice-bench.ts`. **Gap:** a route that makes gold or supplies and no XP shows 0.
