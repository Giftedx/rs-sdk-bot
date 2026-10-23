# Run learnings, 2026-10-23

Source: every run log on this machine on 2026-10-23 ~05:45. That is 60 `*.log` files in the session scratchpad
(`E:/moved/temp/claude/F--dev-on-f-osrs-rs-research-rs-sdk-bot/72e3d252-.../scratchpad`), `.practice/logs/*`
and `.practice/status/*.json`. `.practice` has no `runs/` directory and no events file.

Line numbers refer to the working tree at that time. `scripts/generated/fishing30.ts` and `thieving60.ts` had
uncommitted edits, so recheck the numbers before you change the code.

## Coverage gap: the tick ledger

Only 2 runs printed a `LEDGER` line: live Mightyrod (fishing30) and live Pocketpython (thieving60, run 2). The
ledger arrived in commit 61953b2 (05:12). All author proofs ran before it (woodcutting 04:57, gecourier 04:54).
`packages/practice/src/prove.ts:143` already keeps `LEDGER` lines in the proof tail, so a new proof gets them
with no code change. The waste numbers below therefore come mostly from the scripts' own counters (`walkTicks`,
`shopTicks`, `waits`, `approachTicks`, ...). Only the 2 ledger lines give idle, dialog and stun shares directly.

| Bot | Ticks | xp | move | anim | dialog | stun | idle | Longest idle streaks |
|---|---|---|---|---|---|---|---|---|
| Mightyrod (fishing30, live run 3) | 1705 | 81 (4.8%) | 174 (10.2%) | 72 | 19 (1.1%) | 0 | **1359 (79.7%)** | 104@3234,3219; 104@3233,3209; 97; 95; 93 |
| Pocketpython (thieving60, live) | 1871 | 254 (13.6%) | **639 (34.2%)** | 257 | 3 (0.2%) | 343 (18.3%) | 375 (20.0%) | 45@2652,3320; 45@2620,3298; 25; 25; 22 |

## Author task results

| Task | Script | Attempts | Proof | Cost | Ticks (3 runs) | Notes |
|---|---|---|---|---|---|---|
| woodcutting (TARGET 45) | `scripts/generated/woodcutting.ts` | 1 | 3/3 PASS | $2.572 | 1556 / 957 / 1586 | Only run 2 got the knife and the iron axe. Runs 1 and 3: `WARN no knife`, `WARN only 54 coins: keeping the bronze axe` |
| gecourier (DRY=1) | `scripts/generated/gecourier.ts` | 1 | 3/3 PASS | $0.826 | 1030 / 1031 / 1031 | `lobsterNotes=0`: a dry run. The buy and collect path is not proven (the practice server has no sellers) |

Both RESULT lines:

```
RESULT ok woodcutting=45 target=45 xp=24375 ticks=957 ... axe=iron walkTicks=191 thiefTicks=140 shopTicks=72 chopTicks=291 approachTicks=188 ... milestones=knife@206,ironaxe@278,level15@354,level30@722,level45@957
RESULT ok lobsterNotes=0 coins=19880 ticks=1030 walkTicks=907 boatTicks=111 geTicks=9 dry=true search=true screen=catalog at=2654,3303,0 dist=1 hpMin=10 died=false
```

Earlier author tasks in the same logs, for comparison: boatardy 3/3 ($0.88), thieveknights 3/3 ($0.31, plus one
infra failure at $0.48: "Unable to connect"), fishing30 3/3 after 3 attempts ($4.90), waterfall **0/3 after 3
attempts ($10.82)**.

## Per-script tables

### woodcutting.ts (author proof, practice server, parallel 3)

| Run | Result | Ticks | walk | thief | shop | chop | approach | Uncounted | Axe / knife |
|---|---|---|---|---|---|---|---|---|---|
| 1 | PASS | 1556 | 208 (13%) | 162 (10%) | 0 | 577 (37%) | 296 (19%) | 313 (20%) | bronze / none |
| 2 | PASS | 957 | 191 (20%) | 140 (15%) | 72 (8%) | 291 (30%) | 188 (20%) | 75 (8%) | iron / knife |
| 3 | PASS | 1586 | 210 (13%) | 152 (10%) | 0 | 586 (37%) | 325 (20%) | 313 (20%) | bronze / none |

Trees chopped: `{"tree":31,"willow":5}`, `{"tree":17,"willow":3}`, `{"tree":36,"willow":5}`. No oaks, because
`BOX` (`woodcutting.ts:24`) has no oak in it. Levels 15 to 30 therefore use 1-log trees.

### gecourier.ts (author proof, DRY=1)

| Run | Result | Ticks | walk | boat | GE | Legs (tick of jump) |
|---|---|---|---|---|---|---|
| 1-3 | PASS | 1030-1031 | 907-909 (88%) | 110-111 (11%) | 9 | dock 60, Musa to Sarim 242, GE 536, Sarim to Musa 842, Brimhaven to Ardougne 1002, back 1030 |

The legs are the route itself, so the walking is the cost of the trip and not idle time. The open risk is the
non-dry path (`placeGEOffer`, `collectGE`).

### thieving60.ts (practice tests and live rank runs)

| Log | Result | Ticks | Level | shop | walk | waits x10 | chases | stuns | Last / cause |
|---|---|---|---|---|---|---|---|---|---|
| th60-t6a,c,d,e | PASS x4 | 1969, 2430, 2188, 1589 | 60 | - | - | 1-15 | - | 155-220 | ok |
| th60-t6b, t6f | FAIL x2 | 245, 258 | 22-23 | - | - | 1 | - | 30-33 | **died walk to Port Sarim** (3120-3122,3251-3254) |
| th6x (5 runs) | FAIL x5 | 2470-2499 (3), 422, killed | 53-55 | - | - | 3-26 | - | 185-204 | thieving < 60 at cap; 1 death on walk; 1 `Bread is out of stock` |
| th7 (2), th8 (4) | PASS x4, killed x2 | 1883-2484 | 60 | - | - | 3-14 | - | 176-193 | ok; 2 runs hit the 200 s kill with no RESULT |
| gl-gle / gl-glf | FAIL / PASS | 870 / 719 | 26 / 30 | - | 67 / 58 | 0 | 28 / 17 | 58 / 24 | gle: stunned at cap |
| wa-wab / wa-waa | PASS / none | 886 | 40 | - | 39 | 0 | 16 | 100 | waa: 2x `cant_reach NPC #6027` then no RESULT |
| live-thv | FAIL | 6996 | 66 | - | - | **100** | - | 259 | `buy:out_of_stock:Bread is out of stock` |
| live-thv2 | FAIL | 53 | 66 | - | - | 0 | - | 0 | **died**: a resumed account in Ardougne walked toward Port Sarim (fixed: `inArdougne`, thieving60.ts:176-179) |
| live-thv4 / thv5 | stop file / PASS | 2873 / 143 | 97 / 99 | - | - | 0 | 8 | 208 / 0 | - |
| live-tha | PASS | 6169 | 99 | - | 611 | 20 | 207 | **448** | - |
| live-pr / pr2 / pr3 | stop / stop / PASS | 3975 / 1706 / 1689 | 76 / 85 / 99 | - / 427 / 195 | 441 / 267 / 79 | 3 / 17 / 3 | 126 / 47 / 60 | 275 / 77 / 89 | - |
| live-py | stop file | 6364 | 90 | **1397 (22%)** | 788 | **111** | 368 | 115 | `shop:Timed out waiting for shop to open` |
| live-py2 | PASS | 1866 | 99 | 309 (17%) | 269 | 22 | 85 | 32 | LEDGER idle 20%, move 34%, stun 18% |

Thieving benches (all PASS): es-* (K=1, eat-in-stun 158-260 xp/tick), pc-*, ph-*, pl-* (K sweep, best K=1 321 xp/tick
at hp 57), kh-* and knights2 (knights 300 ticks, 57-118k xp), gd-* (guards 16-27k xp in 300 ticks).

### fishing30.ts

| Log | Result | Ticks | walk | fish | bank | thief | Cause |
|---|---|---|---|---|---|---|---|
| author attempt 1, runs 1-3 | FAIL x3 | 517, 520, 529 | 394-410 (76%) | 0 | 0 | 80-113 | `walk to Draynor net spot` |
| author attempt 2, runs 1-2 | FAIL x2 | 724, 768 | 395-412 | 226-258 | 0 | 74-87 | **died netting** at 3086,3230 (dark wizards) |
| author attempt 2, run 3 | FAIL (RESULT ok) | 1278 | 767 (60%) | 364 | 36 | 74 | `WARN logout did not complete: timeout` |
| author attempt 3, runs 1-3 | PASS x3 | 1383, 1513, 1504 | 764-779 (51-55%) | 468-609 | 37 | 67-80 | - |
| live-mr run 1 (Mightyrod) | FAIL | 1403 | **1022 (73%)** | 362 | 155 | 66 | target 99 for a 30 script; `pickup Logs: Timed out`; `drops=200000` (busy loop) |
| live-mr run 2 | FAIL | 1374 | 74 | 0 | 0 | **1300 (95%)** | `only 0 coins` after 192 steals |
| live-mr run 3 | FAIL | 1700 | 55 | 0 | 0 | **1645 (97%)** | `only 0 coins`; LEDGER idle 79.7% |
| live-mr run 4 | none | - | - | - | - | - | stopped (`SUPERVISE run 4 exit 255`) |

### waterfall.ts (author, 3 attempts x 3 runs)

| Attempt | Runs | Ticks | Causes |
|---|---|---|---|
| 1 | FAIL, FAIL, PASS | 1072, 1080, 1185 | 2x died during walk 2568,9892 (fire giant room) |
| 2 | FAIL x3 | 1096, 561, 866 | died at the giant door; `step golrie gate`; died at the tomb ladder (2542,9813) |
| 3 | FAIL x3 | 1111, 1072, 1119 | 2x died at the giant door (2567-2568,9875-9876); `step giant door` (`msgs=I can't reach t...`) |

Every run printed `WARN forced dialogue ended without the Hudon line` and `WARN Hudon dialogue not seen` (all 9
runs), but milestone 2 still landed at tick 120-124. The runes waited 100-138 ticks on the ground. That is the
tomb trip, not waste.

### Other scripts

| Script / log | Runs | Result | Notes |
|---|---|---|---|
| boatardy | 3 | 3/3 PASS, 380-385 ticks | - |
| cakestall (cake.log) | 3 | 0/3 | `waits=240/300`, `162/213`, `239/300` (79% waiting); `Nothing happened interacting with Baker's stall`; run 2 attacked |
| gather (proven-par .. par5) | 50 | 38 PASS | par: 6/10 fail; par4: `"No tree found":13-16`, `"Tree was felled by someone else"`; par5 10/10 after the fix |
| gather / bank (proven-all, gatherA/B) | 34 | 33 PASS | proven-all run 2: RESULT ok but `WARN logout did not complete: timeout` |
| floors (floors4, fl-*) | 13 | 13/13 PASS | up 39-44 ticks, down 17-26 |
| mining (mi-*, mj-*) | 5 | 3 PASS | mi-r: no RESULT in 400 s; mi-r2: `Mining operation was rejected`; mj-r: `no rock in reach` |
| travel.log | 1 | FAIL | 4 deaths on the overland walk Lumbridge to Ardougne, 2198 ticks |

## Recurring errors

| Error | Count | Where |
|---|---|---|
| `[bot] cant_reach: ... no route, so nothing was sent` | 50 lines | live-mr 17 (NPC #2842 x16), live-pr 9, live-thv 5, live-tha 4, live-py 3, live-pr2 3, live-py2 2, live-thv3 2, live-thv4 2, wa-waa 2, gl-gle 1. Targets: NPC #2842, #6027, #3552, #2847, #2832; locs 376 (x9), 352 (x8), 350 (x4), 1530 (x3), 2566 (x2) |
| `WARN logout did not complete` | 6 | timeout x4 (fishing30, proven-all, proven-par, waterfall), disconnected x2 (proven-par fight run 9, proven-par2 bank run 3). Each one turns an ok run into a FAIL, and the account stays in the world for up to 500 ticks |
| `Bread is out of stock` / `Timed out waiting for shop to open` | 3 | live-thv, th6x run 2, live-py |
| `Server discarded the pickpocket op ... stunned, mid-action, or a modal is open` | 3 | t6f, th6x run 3, live-thv4 |
| Run killed with no RESULT | 6 | th8 x2, th6x x1, mi-r, wa-waa, live-thv3 |

## Top 10 waste causes, ranked by ticks lost

These are measured ticks: whole failed runs, or counter and ledger ticks that gave no XP. "Fixed" means that a
later log shows that the cause is gone.

| # | Cause | Ticks lost | Evidence | Status |
|---|---|---|---|---|
| 1 | Waterfall: 10-HP account dies to fire giants (max hit 11) at the giant door; the door is "can't reach" | **7,977** (8 failed runs) + $10.82 | `RESULT fail died during giant door at=2568,9876,0 ... hpMin=1 eats=10 lobsters=0 died=true`; `msgs=I can't reach t` | open |
| 2 | fishing30 author: route to the Draynor net spot failed, then deaths to the dark wizards at the net spot | **3,058** (5 failed runs) | `RESULT fail walk to Draynor net spot ... walkTicks=394`; `RESULT fail died netting ... at=3086,3230,0` | fixed in attempt 3 (wizard check, fishing30.ts:359-361) |
| 3 | fishing30 live: a resumed run restarts at step 0 and pickpockets for coins it does not need. The pack is full (28/28), so no coins stack can land. At HP <= 2 it rests 10 ticks with bread and shrimps in the pack | **2,945** (thiefTicks 1300 + 1645) | `RESULT fail only 0 coins ... thiefTicks=1645 ... steals=154 ... coins=0 feathers=24`; `LEDGER ... idle=1359 idlePct=79.7 longestIdle=104@t409(3234,3219)`; status: 28 items, Thieving 50, HP 2/10 | partly fixed in the working tree (`coinsNeeded`, `sellJunk`, `eat`) |
| 4 | thieving60: `rest()` waits 10 ticks while HP <= 1 and the pack has no food | **2,760** (276 waits on live runs) | live-py `waits=111`, live-thv `waits=100`, py2 `waits=22`; ledger streaks `45@t1235(2652,3320)`, `45@t1468(2620,3298)` | open |
| 5 | thieving60: Baker trips. One bread restocks per 100 ticks and several bots share the shelf | **2,328** (shopTicks, live) + 1 run ended at Thieving 66 | live-py `shopTicks=1397` of 6364, `last=shop:Timed out waiting for shop to open`; live-thv `last=buy:out_of_stock` | open |
| 6 | woodcutting: the knife was gone (a parallel run took it) and the thief loop stopped at 54 of 56 coins (stop at HP < 3), so the run used no 3-tick and the bronze axe | **1,228** (1556+1586 vs 957) | `WARN no knife: chopping without the 3-tick trick | WARN only 54 coins: keeping the bronze axe` (runs 1 and 3) | open |
| 7 | thieving60: deaths on the walk Lumbridge to Port Sarim, and a resumed Ardougne account that walked back | **978** (245+258+422+53) | `RESULT fail walk to Port Sarim ... hp=0 ... died=true` | fixed (route-danger route thieving60.ts:240-243, `inArdougne` :176-179; no deaths in th7, th8 or later live runs) |
| 8 | woodcutting: levels 15-30 on 1-log normal trees, one approach for each log | **809** approachTicks (296+188+325), 20% of each run | `approaches=36` / `20` / `41`; `trees={"tree":31,"willow":5}` | open |
| 9 | cakestall: no safe tile (a Baker within 5 tiles with line of sight refuses the steal) | **641** of 813 ticks | `waits=240 ... last=timeout:Nothing happened interacting with Baker's stall` | open |
| 10 | thieving60: movement while thieving (chases of wandering targets, unreachable targets) | **639** move ticks of 1871 (34%) in py2; chases 85-368 a run | `LEDGER ... move=639`; `chases=368` (live-py); `cant_reach NPC #6027`, loc 352/376 | open |

Not ranked, because the ticks are not measured:

- Stuns: `stun=343` (18%) in py2, and 448 stuns in live-tha (about 3,584 ticks at 8 each). This is an accepted
  mechanic. `RELOG` (thieving60.ts:96, 302) is off in every live run (`relogs=0`).
- Logout failures: 6 events. Each one can keep the account in the world for up to 500 ticks of scored playtime
  (up to 3,000 ticks). The cost is a bound, not a measurement.
- gecourier: 88% walking. This is the length of the route, not waste.

## Fix proposals

| # | File:line | Change |
|---|---|---|
| 1 | `scripts/generated/waterfall.ts:398-457`, `packages/practice/src/presets.ts:80`, `packages/router/src/author-cli.ts:69` | The comment at waterfall.ts:96 says that fire giants hit 11 and the preset gives 10 HP, so one hit can kill from full HP. Before the bot spends more author money, prove the crossing on its own with a preset at the falls crate (2589,9887). For the `I can't reach` fail, walk to the door's south tile (2568,9892) before `useOnLoc(ITEM.baxKey, LOC.giantDoor)` at :454, and do not let the server path from 2568,9876. The rat-shield block (:402-441) does not appear in the logged tails (INFO lines are filtered), so its effect is not known. Print it as WARN or MILESTONE so that the proof tail shows it. |
| 2 | `scripts/generated/fishing30.ts:359-361` (done) | No change. Attempt 3 and later runs show no wizard deaths. Keep `research/route-danger.ts` in the author prompt for every new walk. |
| 3 | `scripts/generated/fishing30.ts:267-276` | The working tree already has `coinsNeeded` (:252), `sellJunk` (:265) and `eat` (:270). Still needed: (a) at :271, filter `n.reachable !== false` (NPC #2842 was unreachable 16 times); (b) before :273, if `invLen() >= 28` and `coins() === 0`, sell or drop junk first, because a stolen coin cannot land in a full pack; (c) at :274, use the direct `interactNpc` 2-tick click from thieving60.ts:154-157 in place of `bot.pickpocketNpc`; (d) prove with the `fish_resume` preset (presets.ts:98). |
| 3b | `scripts/generated/fishing30.ts:420-423` | `dropItem(/^raw (trout|salmon)$/i)` then `continue` with no wait. When the pack is full of non-fish items, nothing drops and the loop spins (live-mr run 1 `drops=200000`). If `invLen()` did not fall, drop junk or end with a reason. |
| 4 | `scripts/generated/thieving60.ts:174`, `:330-331` | Do not rest at the knights. With HP <= 1 and no food: walk to the Baker (2654,3311) and buy the first bread that comes back, or steal from the cake stall when it is fixed (#9). A stall fail does not hit, so it needs no HP and gives food and XP. |
| 5 | `scripts/generated/thieving60.ts:323`, `:266-296` | Refill before the pack is empty: `food() <= 3 && cheb(BAKER, pos) <= 15`, so the trip is short and comes before the HP crash. For the swarm, feed lobster notes from `gecourier.ts` or a banker (`scripts/banker.ts`, untracked) and do not depend on one bread every 100 ticks shared by all bots. On an `openShop` timeout (:270), set `shopRetryAt` from the stock last seen and not a flat 30. |
| 6 | `scripts/generated/woodcutting.ts:127`, `:153-160` | (a) A fail costs 1 HP, so stealing at HP 2 is safe. Change `hp() >= 3` to `hp() >= 2`, at least while `coins()` is within 6 of the goal (54 of 56 cost about 600 ticks a run). (b) Do not give up on the knife after 15 tries. Chop the first normal logs, then come back for the knife when it respawns (find the respawn time in the map data first), or poll `findGroundItem(/^knife$/i)` on each drop. |
| 7 | `scripts/generated/thieving60.ts:176-179`, `:240-243` (done) | No change. Keep `inArdougne` and the route-danger route. |
| 8 | `scripts/generated/woodcutting.ts:24` | Add a checked oak area for levels 15-30. Use `bun research/route-danger.ts` first, because the giant spiders at 3200,3238 and 3203,3239 were the reason for the narrow box. An oak gives about 8 logs from 1 approach. Measure with the `measure_oaks` preset (presets.ts:29). |
| 9 | `scripts/generated/cakestall.ts:73-84` | 79% of the ticks are `waits` with no safe tile. Add the tiles where the Baker has no line of sight (the 2x2 stall blocks it) to the candidates, or step 1 tile away and come back while the Baker wanders. Only then use the stall as the no-HP food source for #4. |
| 10 | `scripts/generated/thieving60.ts:134-146` | Filter `n.reachable !== false` (`cant_reach NPC #6027`, locs 352/376). Prefer targets at `distance <= 1`. If the nearest target is 2 or more tiles away, wait 1 tick when one usually comes close, and chase only when none comes in N ticks. Accept the change only if the ledger `move` share falls below 34% and xp/tick does not fall. |
| L | `packages/core/src/bot.ts:98-101` | When `logoutSession` returns `timeout`, try once more before the FAIL. With `disconnected`, open the session again and log out, because the server keeps the account for up to 500 ticks. |
| S | `scripts/generated/thieving60.ts:96`, `scripts/measure/relog-bench.ts` | Run relog-bench (untracked) on the practice server to get the relog cost. Turn `RELOG=1` on for live only if one relog costs less than the 8-tick stun. |

## Next measurements

1. Run the woodcutting and gecourier proofs again to get `LEDGER` lines (prove.ts:143 already keeps them). Then
   rank the causes again with idle and move shares in place of counter estimates.
2. Prove fishing30 on the `fish_resume` preset before the next live Mightyrod run.
3. gecourier with DRY unset on a server that has sellers. The buy and collect path has not been run.
