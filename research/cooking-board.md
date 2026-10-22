# Cooking board: what it takes (2026-10-22)

## Method (proven on the practice server)
- Using grapes on a jug of water makes one unfermented wine (needs Cooking 35) and starts a 20-tick timer.
  When it fires, every unfermented wine in the bank ferments (`skill_cooking/.../wine/wine.rs2`).
- Measured: 300 banked wines took Cooking 35 -> 96 (+827,750 XP) in 25 ticks. About 2,759 XP per wine at 25x.
- 99 from 35 needs 358 banked wines. Level 35 needs 10,847 XP; Cook's Assistant gives 7,500 at 25x (level 30).

## Board
- #1 `jackalopeck3`: 99 in 38 ticks of playtime (research/hiscores-2026-10-22.json).
- To beat it: reach 35 in under ~12 ticks, then ferment 358+ wines. The route to 35 is still open.

## Supply is the real limit
- No shop sells grapes. Ground spawns: (2509,3493) x10 and two single grapes. NPC drop: Goblin Village goblins
  only, 1/128 (`drop tables/scripts/goblin.rs2:121`), so about 46,000 kills for 358 grapes.
- Live GE (api/market/items/1987): bids for 98,738 grapes at 1,000 gp, zero sellers, last price 1,000 gp.
  Other operators already use this method and are buying every grape.
- Verdict: a supply war. Not a first target.

## Update: the login timer (proven 2026-10-22)
- Every login runs `~ferment_wines_login` (`login_logout/login.rs2:70`), which sets the 20-tick
  `fermenting_wine` timer (`wine.rs2:72`) with **no level check**.
- Practice server, account with no Cooking levels and 600 unfermented wines banked, doing nothing after login:
  two runs, both **99 Cooking at session tick 22** (+1,650,000 and +1,320,000 XP). At level 1 most batch rolls
  fail, so the count matters: 600 was enough twice; fewer is untested.

## Plan to beat the 38-tick #1
1. Session A (scored): new account clears the tutorial, takes a trade of noted unfermented wine from a helper
   next to a bank, deposits it. Budget: under ~15 ticks. Tutorial-skip ticks are not measured yet.
2. Log out (in game, so playtime stops).
3. Session B (scored): log in, wait 20 ticks, 99 at about tick 22. Total = A + ~22.
4. Supply: 600 grapes. GE has zero sellers. Ground spawn (2509,3493) x10 is the helper job; its respawn time
   and contention are not measured yet.
