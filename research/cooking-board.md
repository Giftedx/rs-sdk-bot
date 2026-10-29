> Authority: all gameplay techniques are authorized. Wine, cocktails, pyre oil, Charge, relogs and tick manipulation need no further approval. Missing supplies create acquisition work, never a route exclusion. See [AGENTS.md](../AGENTS.md).

> Correction: the Almera “10 grapes” entry below is a map-location misread, not an item spawn. See [grape-gold.md](grape-gold.md). Preset/session timings exclude full fresh-account preparation and do not prove a whole-clock hiscore attempt. Login wine is authorized.

# Cooking board: what it takes

## Reusable wine order

`bun scripts/cook-wine.ts <account> [target=99] [fermentation-deadline=80]` replaces the two scratch commands. It reuses `depositObserved` and `settle`. It waits for observed effects, confirms logout before reconnecting in the same process, and stops at the exact target. Unused bulk stays owned when the starter reaches the target. An all-bad starter can consume stock without XP, so the worker checks its item outcome before rejecting it.

[Final native delivery](../.practice/deliveries/wine-order-1793163518046-KvlTfl/report.json) passed at 400ms/25x with 150 raw starter wines and 600 noted bulk wines. Saved state reached Cooking99, reconciled good/bad wine and retained stock, preserved HP and confirmed both logouts. This is one native result on final source, not a live record, unattended qualification or a comparative speed result. Earlier raw results remain in `.practice/workflow-repair-20261028/`.

Source decision: [rune.fast techniques](https://rune.fast/tricks) and [harness](https://rune.fast/harness) -> existing cooking/session helpers -> adapt event-driven work, same-process relog and completion through the consumer. No external code was copied. Reject fixed waits, forcing a second login after the target, and making another client before measuring a missing capability. Our `inprocess.ts` already publishes state before tick listeners. Next: owned ingredient acquisition and a supplied live pilot, separate from the protected main.

## Method (proven on the practice server)
- Using grapes on a jug of water makes one unfermented wine (needs Cooking 35) and starts a 20-tick timer.
  When it fires, every unfermented wine in the bank ferments (`skill_cooking/.../wine/wine.rs2`).
- Measured: 300 banked wines took Cooking 35 -> 96 (+827,750 XP) in 25 ticks. About 2,759 XP per wine at 25x.
- 99 from 35 needs 358 banked wines. Level 35 needs 10,847 XP; Cook's Assistant gives 7,500 at 25x (level 30).

## Board
- #1 `jackalopeck3`: 99 in 38 ticks of playtime (research/hiscores-2026-10-22.json).
- To beat it: reach 35 in under ~12 ticks, then ferment 358+ wines. The route to 35 is still open.

## Supply is the real limit
- No shop sells grapes. Ground spawns: two single grapes; the alleged (2509,3493) x10 spawn was a raft-map misread ([correction](grape-gold.md)). NPC drop: Goblin Village goblins
  only, 1/128 (`drop tables/scripts/goblin.rs2:121`), so about 46,000 kills for 358 grapes.
- Live GE (api/market/items/1987): bids for 98,738 grapes at 1,000 gp, zero sellers, last price 1,000 gp.
  Other operators already use this method and are buying every grape.
- Verdict: a supply war. Not a first target.

## The login timer (proven on the practice server)
- Every login runs `~ferment_wines_login` (`login_logout/login.rs2:70`), which sets the 20-tick
  `fermenting_wine` timer (`wine.rs2:72`) with **no level check**.
- Practice server, account with no Cooking levels and 600 unfermented wines banked, doing nothing after login:
  two runs, both **99 Cooking at session tick 22** (+1,650,000 and +1,320,000 XP). At level 1 most batch rolls
  fail, so the count matters: 600 was enough twice; fewer is untested.

## Rejected historical login-wine proposal — do not execute
1. Session A (scored): new account clears the tutorial, takes a trade of noted unfermented wine from a helper
   next to a bank, deposits it. Budget: under ~15 ticks. Tutorial-skip ticks are not measured yet.
2. Log out (in game, so playtime stops).
3. Session B (scored): log in, wait 20 ticks, 99 at about tick 22. Total = A + ~22.
4. Supply: 600 grapes. GE has zero sellers. The proposed (2509,3493) x10 helper source does not exist; this supply plan is invalid.
