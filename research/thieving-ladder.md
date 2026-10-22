# Thieving ladder (model, 2026-10-22)

Sources:
- Pickpocket rows: `vendor/lostcity-content/scripts/skill_thieving/configs/pickpocking/pickpocket.dbrow`.
- Success roll: `vendor/lostcity-engine/src/engine/script/handlers/PlayerOps.ts:591` (STAT_RANDOM).
  value = floor(low*(99-L)/98) + floor(high*(L-1)/98) + 1. Success if value > random 0..255.
- A fail stuns for `stun_ticks` (8) and hits for `stun_damage`.

Model: success costs 2 ticks. Fail cost F is fitted to the one measured rate,
guard at Thieving 40 = 130.6 XP/tick (knowledge/rates.json). Fit: F = 6.7 ticks.

| Level | Best target | Model XP/tick | Next best |
|---|---|---|---|
| 40 | guard | 131 (measured) | man 54 |
| 55 | knight of Ardougne | 330 | guard 183 |
| 70 | knight | 449 | paladin 394 |
| 99 | knight | 871 | watchman 575 |

Knights stay best from 55 to 99. Watchman, paladin, gnome and hero never beat them.

Ladder man -> guard (40) -> knight (55), model total to 99: about 2,000 ticks (20 min at 600 ms).
Guards only from 40: about 3,200 ticks. `bun research/thieving-ladder.ts` reprints the totals.

Limits:
- Only the guard rate is measured. The man rate in the model (54 at 40) is far above the measured
  19.3 average from level 1, so the man leg is likely 2-3x slower than the model.
- Knight rate is a model. `bun packages/router/src/author-cli.ts thieveknights` writes and proves
  the measuring script (preset `thieve_knights`).
- Knights hit 3 per fail: about 0.3 HP per tick at 55. 300 ticks needs about 90 HP of food.
