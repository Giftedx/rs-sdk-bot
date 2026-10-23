# Combat XP per tick, cannon, stun guests (2026-10-23)

Measurements 1, 2 and 3 of `research/gap-closers.md`. All runs are MEASURED practice: the local server, preset
accounts (not fresh accounts), one bot at a time, `RANDOM_EVENTS=0`. Rates are in ticks, so the 150 ms practice tick
does not matter. The quest helper can add cannon rows from Dwarf Cannon under "Cannon"; name the script and preset.

Paths start at `vendor/rs-sdk/server/content/scripts/`.

## Result

| Planner row (`packages/planner/src/haggis-boards.json`) | Before (ESTIMATE) floor / realistic | Now (MEASURED) floor / realistic |
|---|---|---|
| `att-top`, `str-top` style XP per tick | 400 / 250 | **156.7 / 139.6** (band 90) |
| `def-top` style XP per tick (Defence 1 to 99) | 400 / 250 | **150.6 / 134.5** (XP-weighted bands) |
| `hp-top` Hitpoints XP per tick | 133 / 83 | **51.8 / 46.2** (band 90) |
| `cannon-melee`: style XP per tick with the cannon (band 90) | unchanged rate, +0.6 Ranged per style XP | **120.7 / 113.8**, +0.585 Ranged per style XP |
| `cannon-melee`: `def-top` with the cannon | +0.6 | **113.3 / 103.1**, +0.693 |
| `cannon-melee`: `hp-top` with the cannon | +1.8 Ranged per HP XP | **39.9 / 37.6** HP XP per tick, +1.77 |
| `thieve` `deadTicks` (stun-guests) | 1,509 / 2,419 | **1,511 / 2,611** |

Overall finish (`bun packages/planner/src/haggis-cli.ts --levers`, all safe levers):

| | Floor | Realistic |
|---|---|---|
| Before these rows (same day, other agents' rows included) | 31,140 (slack +4,776, WIN) | 45,916 (gap 10,000) |
| **Now, all safe levers** | **37,361 (gap 1,445, LATE)** | **46,930 (gap 11,014)** |
| Now, all safe levers except `cannon-melee` | 36,271 (gap 355, LATE) | 45,802 (gap 9,886) |

Overall no longer wins at floor rates. The measured melee rate is about 140 style XP per tick, not 250-400. The old
floor assumed 4 damage per tick; the bot deals 1.4-1.6. `cannon-melee` now costs ticks (-1,090 floor, -1,128
realistic as the last lever): with this bot's cannon handling the melee loss is larger than the Ranged gain.
`stun-guests` saves 682 floor / 617 realistic as the last lever (1,514 / 2,611 alone).

## 1. Melee, no cannon

Script `scripts/measure/combat-melee.ts`, runner `scripts/measure/floor-run.ts`, 300 ticks per run,
`TARGET='^khazard trooper$'`.

Spot: the Gnome battlefield (presets `combat_gb_40/70/90`, start 2525,3242). It is multiway
(`maps/multiway.csv` "gnome battlefield") with 41 Khazard troopers on open ground
(`quests/quest_tree/configs/gnome_battlefield.npc:1-40`: HP 22, defence 12-13, attackrate 5-6, no `huntmode`, so
they do not attack first). No melee run ate food (`eats=0` in every RESULT line).

Gear (all tradeable): rune full helm, amulet of strength, rune scimitar, rune chainbody (the platebody needs Dragon
Slayer, `levelrequire/scripts/tier40.rs2:26`), rune kiteshield, rune platelegs, leather gloves and boots. Style 1
(aggressive, Strength XP). Attack, Strength, Defence and Hitpoints all at the band level.

| Band | Run 1 | Run 2 | Run 3 | Mean style XP/tick | HP XP/tick (runs) | Mean HP XP/tick | In combat |
|---|---|---|---|---|---|---|---|
| 40 | 88.0 | 82.0 | 74.0 | 81.3 | 29.1 / 27.1 / 24.4 | 26.9 | 0.93-0.95 |
| 70 | 154.0 | 146.7 | 111.0 | 137.2 | 51.0 / 48.6 / 36.8 | 45.5 | 0.92-0.93 |
| 90 | 126.0 | 156.7 | 136.0 | 139.6 | 41.7 / 51.8 / 45.0 | 46.2 | 0.91-0.92 |

Example output line (band 90, run 2):
`RESULT ok cannon=false ticks=300 styleXp=47000 styleXpPerTick=156.7 hpXp=15552 hpXpPerTick=51.8 ... meleeDmgPerTick=1.567 ... inCombat=274 inCombatShare=0.913 attacks=25`

- Damage per tick = style XP / 100 (4 x base x 25, `skill_combat/scripts/combat.rs2:143-167`): 0.81 / 1.37 / 1.40.
  Hitpoints XP / style XP = 0.331, as the code says (1.33 / 4).
- Band 90 is not faster than band 70 here: a trooper has 22 HP, so a 90 hit is often capped by the HP left, and the
  bot needs about 12 ticks per kill (walk, 2-3 swings). A target with more HP would favour band 90. Not measured.
- "In combat" counts ticks where the target is alive and style XP came in within 10 ticks. The bot re-targets on the
  tick a target dies. 100% of ticks in combat is not reached: walks to the next trooper take 5-10% of ticks.
- `def-top` weights: Defence 1-55 is 4.7% of the XP to 99, 55-80 is 22.1%, 80-99 is 73.2%
  (`packages/planner/src/curve.ts`). Bands 40 / 70 / 90 stand for these ranges.
- Comparison spot: Falador White Knights (`combat_wk_90`, HP 52, multiway): 105.0 style XP per tick in one 300-tick
  trial. The courtyard walls make many knights unreachable. Not used.

## 2. Cannon while meleeing

Same script with `CANNON=1`, presets `combat_gb_<band>_cannon`: `%mcannon` (varp 0) = 11, `%ownedmcannon` (varp 4)
= -1, cannon base / stand / barrels / furnace, 1,000 cannonballs, 16 lobsters. The bot sets up the cannon (14 ticks,
outside the measured window), tops it up with balls every 20 ticks, re-fires after "out of ammo", and picks it up
after the run. A save value of 0 in varp 4 reads as a placed cannon ("You cannot construct more than one Cannon").

| Band | Style XP/tick (runs) | Mean | Ranged XP/tick (runs) | Mean | HP XP/tick mean | Ranged per style XP |
|---|---|---|---|---|---|---|
| 40 | 54.7 / 82.0 / 56.7 / 55.7 | 62.3 | 96.0 / 41.5 / 55.0 / 145.2 | 84.4 | 20.6 | 1.355 |
| 70 | 66.3 / 96.0 / 101.0 | 87.8 | 133.5 / 50.0 / 56.0 | 79.8 | 29.0 | 0.909 |
| 90 | 119.0 / 120.7 / 101.7 | 113.8 | 44.5 / 59.0 / 96.2 | 66.6 | 37.6 | 0.585 |

Example output line (band 90, run 3):
`RESULT ok cannon=true ticks=300 styleXp=30500 styleXpPerTick=101.7 hpXp=10082 ... rangedXp=28850 rangedXpPerTick=96.2 ... reloads=16 refires=3 setupTicks=14`

- Band 40 has 4 valid runs: run 2 of the first batch and 3 reruns. Runs 1 and 3 of the first batch found an older
  cannon on the spot and set up nothing (Ranged XP 0); they are left out. The script now moves 6+ tiles from any
  cannon it sees and checks for "You place the cannon base".
- The cannon lowers the melee rate by 18-36%: each top-up is an item-on-loc that clears the NPC interaction and
  walks to the cannon. It adds 67-84 Ranged XP per tick (1.3-1.7 cannon damage per tick, 50 Ranged XP per damage,
  `quests/quest_mcannon/scripts/cannon_fire.rs2:117-119`). The cannon's hit roll uses the player's current melee
  attack roll (`player_combat.rs2:52-68`), so Ranged level does not matter.
- Spread is large (41-146 Ranged XP per tick). The high runs had more troopers around the cannon. One trial at band
  90 gave 146.7 Ranged and 95.3 style XP per tick.
- Total XP goes up with the cannon (band 90: 139.6 to 180.4 per tick), but the planner rates the Ranged side XP
  below the cost to the melee boards. Open: top up every 30 ticks from the tile next to the cannon, or stand at the
  cannon and let troopers come (aggro); a higher-HP multiway target.

## 3. Stun guests at the Ardougne knights

Script `scripts/measure/stun-guest.ts`, 600 ticks per run, presets `stun_base`, `stun_bury`, `stun_enchant`
(Thieving 99, 10 HP, 5 lobsters). The bot clicks a knight every 2 ticks. Inside each stun (8 ticks after
"You've been stunned!", `skill_thieving/scripts/thieving.rs2:28-51`) it eats at HP 4 or less, else it buries a
dragon bone (Prayer 99, so no level-up page) or casts Lvl-1 Enchant on a sapphire ring (Magic 99).

| Arm | Run 1 | Run 2 | Run 3 | Result |
|---|---|---|---|---|
| Base: Thieving XP/tick, stuns | 748.2, 13 | 593.6, 12 | 495.3, 15 | mean 612.4 |
| Bury, click every 2 ticks (`BURY_GAP=2`) | 646.3; 22 bones in 11 stuns | 741.1; 20 in 10 | 594.4; 22 in 11 (died at 585 ticks, food out) | 2.0 bones per stun |
| Bury, click every tick (`BURY_GAP=1`) | 555.0; 22 bones in 8 stuns | 751.7; 22 in 8 | 783.3; 18 in 6 | **2.83 bones per stun** |
| Enchant, cast when 2 ticks remain | 537.4; 20 casts in 8 stuns | 551.5; 20 in 8 | 642.8; 20 in 8 | **2.5 casts per stun** |

Example output lines:
`RESULT ok mode=bury buryGap=1 ticks=600 thievXp=451005 thievXpPerTick=751.7 stuns=12 stunTicks=96 guests=50 buried=22 ... perStun=8,8,5,8,5,8,5,3,0,0,0,0`
`RESULT ok mode=enchant ticks=600 thievXp=322447 thievXpPerTick=537.4 stuns=10 stunTicks=80 guests=20 ... magicXp=8750 ... perStun=3,2,3,2,3,3,2,2,0,0 ... recoil=20`

- Bones and rings ran out after 6-11 stuns in every guest run, so the per-stun numbers count only the stuns before
  that (bones buried = Prayer XP / 1,800; casts = Magic XP / 437.5).
- Bury: 2.83 bones per 8-tick stun = 5,100 Prayer XP per stun = 637 Prayer XP per stun tick. The bury row runs one
  bone per 2 ticks, so a stun tick is worth 0.71 bury-row ticks. With a click every 2 ticks, half the clicks were
  dropped (2.0 bones per stun); a click every tick lands more.
- Enchant: 2.5 casts per stun (every cast landed), 3 ticks per cast in the enchant row, so a stun tick is worth 0.94
  enchant-row ticks. Lvl-1 gives 137 Magic XP per stun tick; a higher enchant gives more XP per cast at the same
  cadence (`skill_magic/scripts/spells/enchant.rs2:53`, `p_delay(1)`).
- Thieving rate: no drop seen. Base 612 vs bury 661 / 697 vs enchant 577 XP per tick; the spread inside each arm
  (495-783) comes from the stun count (6-16 per run) and is larger than the arm difference.
- `deadTicks`: stunned ticks 3,584 realistic (`research/live-thieving-2026-10-23.md:74`) and 0.58 x 3,850 = 2,233
  floor, x 0.9 for refill trades inside stuns (ESTIMATE: one trade of 4-7 ticks per 8 stuns, commit 61953b2).
  Prayer fills first: 1,300 / 1,169 bury-row ticks need 1,831 / 1,646 stun ticks at 0.71. Magic takes the rest at
  0.94. Capacity 2,611 realistic, 1,511 floor.

## Open

- Melee at a multiway spot with higher-HP targets for band 90 (Kalphite soldiers, HP 90, `kalphite.npc:62-90`; moss
  giants in the Varrock sewer, only 4 spawns).
- Cannon handling that does not break melee (see section 2).
- Stun guests from a fresh ladder (Thieving 1 to 99), with real Prayer and Magic level-up pages and refill trades.
- `kills` and `dmgTaken` in the RESULT lines are not reliable (the SDK did not report kill events; damage events
  repeat). The rates use XP deltas only.
