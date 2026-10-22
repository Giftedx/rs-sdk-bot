# Crafting board: what it takes (measured 2026-10-22, practice server, 300 ms ticks)

Live #1: `nickgemcut`, 99 in 197 ticks of playtime (research/hiscores-2026-10-22.json).

## Measured
| What | Result |
|---|---|
| Tutorial skip, fresh account | 10 ticks, lands at Lumbridge (3222,3222) |
| Cut 27 uncut dragonstones, chisel, all sent at once | 7 ticks, +92,812 XP (both runs) |
| Helper trades 27 uncut gems to the specialist | 12 specialist ticks (both runs) |
| Draynor bank loop, 3 cycles (open, deposit, withdraw 27, close, cut) | 15, 54, 24 ticks |

## What it means
- Trade-then-cut loop: 19 ticks per 27 gems. Planner (gem ladder from skills.json): 213 ticks to 99, 223 with the
  tutorial. Loses to 197.
- Bank loop: cycle 1 (no deposit) was 15 ticks; the deposit step made cycles 2-3 slow. `bot.depositItem(pattern, -1)`
  appears to deposit slot by slot. With a 10-tick cycle the planner gives 112 + 10 ticks, plus the walk to a bank.
- Next: a one-click deposit-all of one item (bank interface option) and re-measure. If a cycle reaches ~10 ticks, the
  board is winnable with ~50 ticks to spare.
- Lower gems (opal, jade, red topaz) can smash; the ladder needs those amounts plus a margin.
