# Board ranking, honest pass

`board-ranking.md` ranks boards from model rates only. It leaves out travel, food, deaths, rock depletion and
money. This file ranks from measurement. "Fresh" means from a new account.

| Board | Leader ticks | Our best evidence | Verdict |
|---|---|---|---|
| Thieving | 2,935 | Fresh to 55: 1,437-1,816 ticks (measured). 55 to 99: about 2,400 (model fitted to measured guard 74 and knight 207 XP/tick). Total about 3,850-4,200. | Not winnable with this method |
| Mining | 3,964 | Iron, rune pickaxe, 3 rocks, no walking: 97 XP/tick (58,625 XP / 604 ticks). Rocks respawn in 20 ticks (`skill_mining/configs/mine.dbrow:72`), so 3 rocks cap the rate near 120. 99 at that rate: about 8,000-10,000 ticks. The only 5-rock tile is (3100,3767), deep Wilderness (`research/iron-spots.ts`). | Not winnable with iron power-mining |
| Runecraft | 2,354 | Model 1,531 (+823). Measured: 27 essence crafted in 5-7 ticks, 12-tick trade. Not measured: helper bank trips (est. 150 ticks, so about 8 helpers). Needs about 4,213 essence (live GE: 1,552 sellers, ask 62) = about 261k coins. | Open. Blocked by money and helpers |
| Crafting | 197 | Measured 27 cuts in 7 ticks. Uncut dragonstone: 0 sellers on the live GE. | Blocked by supply |
| Cooking | 38 | Only the login-timer wine route is fast enough. See bug-report-wine-login.md; the route is authorized. | Not winnable: the record is 20 ticks (`research/hiscores-2026-10-29.json`); the planner models the wine route at 229 |
| Smithing, Herblore, Prayer, Magic | see board-ranking.md | Top-tier inputs have 0 sellers on the live GE. | Blocked by supply |
| Woodcutting, Fishing, Agility | see board-ranking.md | Model margins already negative. | Not winnable with these methods |

What this means:
- The model was optimistic on every board measured so far (Thieving 1.6x, Mining 2-3x).
- Every leader is faster than our best measured method. The leaders know methods we have not found.
- The next useful work is to find out how a leader gets its time, not to build more of our slower methods.
  Example: Mining leader 3,964 ticks needs about 250 XP/tick average, twice our iron cap.
