# The AIO bench: findings

Command and rules: [script contract](../docs/script-contract.md#the-aio-bench). Engine patch: `patches/rs-sdk.md` item 10. Raw results: `.practice/aio-bench/`.

## Lockstep engine

**Claim:** a lockstep engine with one seed and a new engine for each case gives the same tick count on each run. **Conditions:** `bun run bench --smoke --no-keep`, seed 7, six engines at a time, three runs. **Evidence:** 15 of 15 cases equal in the three runs (`.practice/aio-bench/smkw1.log` to `smkw3.log`); the per-tick world traces of `crest` and `dwarfcannon` are byte-identical between two runs (`trA/`, `trB/`). **Gap:** a case with a partner account is not in the three-run check.

**Claim:** a shared engine makes one case change the result of the next. **Conditions:** seed 7, same engine build. **Evidence:** `dwarfcannon` 823 ticks after 20 earlier cases (`lockfull1.json`), 762 ticks on a new engine (`fresh1.json` to `fresh3.json`).

**Claim:** the lockstep tick counts agree with the 150 ms engine. **Conditions:** quests, one account, seed 7 against one 150 ms run. **Evidence:** `walk-to` 84 against 85; `barcrawl` 1401 against 1398; `biohazard` 1293 against 1292; `blackknight` 287 against 291 (`quests-base-s7.json`, `pass1.json`). **Gap:** combat quests differ by the random rolls, and no run on a 400 ms engine exists.

**Claim:** 64 quests run in under 10 minutes. **Conditions:** six engines, this PC, no other load. **Evidence:** 588 s and 571 s wall (`quests-base-s7.log`, `quests-burst-s7.log`). The same quests took about 70 minutes on one 150 ms engine with four accounts in one world.

**Claim:** a shorter client loop is not usable. **Conditions:** `LOOP_MS` 1 and 5 against 20 in `vendor/rs-sdk/server/webclient/src/lite/session.ts`. **Evidence:** `biohazard` 1626 and 1595 ticks against 1294; wall time 25% lower. The client counts one frame for each loop, and animations end by frame count.

## Routes

**Claim:** 109 bench cases pass at seed 7; they cover 107 of 221 catalog routes. **Evidence:** `.practice/aio-bench/baseline-seed7.json`; `bun run bench --coverage` lists the routes with a cause and the routes with no case.

**Claim:** five quests fail on a random roll they do not recover from, and two fail at every seed. **Conditions:** seeds 7 to 10. **Evidence:** `troll` fails at 7 and 10; `mm` at 7 and 9; `eadgar` at 7 and 9; `fluffs`, `hauntedmine` and `zanaris` at 7 on a shared engine (`weak-seed8.json`, `weak-seed9.json`); `waterfall` stops in the maze at 2538,3145 and `viking` retreats with no food at every seed. **Gap:** no fix exists for any of them.

**Claim:** `Q_BURST=1` breaks 20 quests that pass without it and saves 0.7% on the rest. **Conditions:** seed 7, 64 quests. **Evidence:** 44 of 67 pass with the flag against 61 of 64 without; 30,203 ticks against 30,426 on the 41 quests that pass both ways; the errors are `dialogue click refused` and a failed talk step (`quests-burst-s7.json`). Three of the failures repeat on the 150 ms engine. Largest gains: `chompybird` 772 to 474, `murder` 261 to 204.

## Recorded dialogue plans

**Claim:** a recorded dialogue plan makes ten quests faster: 12,632 ticks against 13,912 over nine of them at three seeds (9.2% fewer). **Conditions:** seeds 7, 8 and 9, a new engine for each case; `scripts/generated/talk-plans.json` holds the clicks each talk took in a passing run, and `talk` sends them in one write. **Evidence:** `cook` 8 against 18; `imp` 9 against 22; `hetty` 53, 48, 48 against 68, 66, 62; `hauntedmine` 791, 853, 823 against 929, 1052, 1181; `cog`, `arena`, `grail`, `ikov` and `murder` fewer in total (`.practice/aio-bench/seed-7.json` to `seed-9.json` against `quests-seeds-7-10.log`). `fluffs` fails at one seed of three with and without a plan. **Gap:** a plan breaks a talk whose step check reads page text: the plan answers pages before the client shows them, and 35 of 50 quests failed with their recorded plans (`quests-plans.log`). Reading the text from the packets repairs most of them and removes the gain. The sweep mode does not use the plans.

## Burst banking

**Claim:** one "deposit all" for each item id in the same tick does not make a bench case faster. **Conditions:** seed 7, `depositPack` in `packages/core/src/deposit.ts` with the burst against one item id a tick; the three cases that call it. **Evidence:** `market:shop-buy` 575 ticks with the burst against 420 without; `skiller:fletching:arrows` and `skiller:thieving:knights` end at their tick cap in both, and the knights case makes no bank trip in 1,500 ticks (`.practice/aio-bench/burst1.log`, `burst0.log`). The change is not in the code. **Gap:** no bench case banks a pack of many item ids, so the bench cannot show the gain the rival states (24 to 5 ticks for 24 item ids); `market:shop-buy` gave 402 and 420 ticks in two runs of the same code.

## Rival comparison

**Claim:** rs-stun-toolkit states fewer ticks than ours on 11 quests; the causes are a planned dialogue burst and an amulet of glory in the kit. **Conditions:** their lockstep sim with their kit and stats against our `quest_<slug>` presets at seed 7; code read on both sides, nothing of theirs run here. **Evidence:** their `run-<quest>.share.md` medians in `RIVAL_QUEST_TICKS` (`scripts/measure/aio-bench-cases.ts`); estimated savings: `mortton` 400 to 550, `dragon` 220 to 270, `grail` 200 to 280, `squire` 150, `scorpion` 130, `merlin` 110 to 130, `fishingcompo` 100, `hunt` 60 to 80, `gobdip` 25 to 30, `cook` and `sheep` 10 each. **Gap:** every saving is an estimate until its port runs on the bench; their `mortton` run carries the materials that ours buys.

**Claim:** their bot layer sends more per tick than ours in three places. **Evidence:** a whole conversation with its choice clicks in one write (`speedrun/legs/q-lib.ts` `talk`) against one page a tick (`scripts/generated/quest-lib.ts` `converse`); deposits and withdrawals in one burst (`speedrun/core.ts` `bankSwap`) against one deposit for each item id (`packages/core/src/deposit.ts` `depositPack`); up to five inventory actions a tick (`core.ts` `burst`) against one. **Gap:** none is measured here.
