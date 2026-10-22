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
