# Level-up dialogs cost scored playtime (measured on the practice server, 300 ms ticks)

## Mechanism (content/scripts/levelup/scripts/levelup.rs2)
Each level-up runs `[label,levelup]`: a message, `if_openchat` of the level-up dialog, then `p_pausebutton`, and for
levels that unlock something, more pages from `~levelup_unlocks`. The script pauses until "continue" is clicked.

## Measured: one pack of 27 uncut dragonstones from Crafting 55
| Test | Result |
|---|---|
| Cutting with dialogs piling up | 27 gems in 7 ticks (cutting is not blocked) |
| Levels gained | 55 -> 70 (15 level-ups) |
| Continue clicks to clear, one per tick | 42 and 40 clicks = 42 and 40 ticks (two runs) |
| Walk one tile instead (`bot.walkTo`), then click | walkTo took 70 ticks (it dismisses dialogs itself), 12 clicks after: 82 ticks |
| `sendCloseModal` | did not clear the dialog within 5 ticks |

## Rule for the planner
- Item-on-item actions run with the dialog open. Opening a bank (and other loc or NPC ops) waits for every page.
- Cost when the next action is blocked: about 2.7 ticks per level gained (40-42 ticks for 15 levels here).
- A method whose XP lands without any later blocked action (the wine login timer) pays nothing.
- This explains most of the gap between the XP-per-tick model (Crafting 79 ticks) and the live #1 (197).
- Open: a cheaper way to clear queued pages.
