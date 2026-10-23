# Combat XP per tick, cannon, stun guests (2026-10-23)

Measurements 1, 2 and 3 of `research/gap-closers.md`. All runs are MEASURED practice: the local server, preset
accounts (not fresh accounts), one bot at a time, `RANDOM_EVENTS=0`. Rates are in ticks, so the 150 ms practice tick
does not matter. The quest helper can add cannon rows from Dwarf Cannon under "Cannon"; name the script and preset.

Paths start at `vendor/rs-sdk/server/content/scripts/`.

## Result (second pass)

| Planner row | First pass, floor / realistic | Now (MEASURED), floor / realistic |
|---|---|---|
| `att-top`, `str-top` style XP per tick | 156.7 / 139.6 (Gnome battlefield) | **203.3 / 185.3** (ice warriors, band 90, section 4) |
| `def-top` style XP per tick (Defence 1 to 99) | 150.6 / 134.5 | **179.5 / 162.9** (best spot per band) |
| `hp-top` Hitpoints XP per tick | 51.8 / 46.2 | **67.3 / 61.4** (ice warriors) |
| `cannon-melee` on `att-top`, `str-top` | 120.7 / 113.8, +0.585 Ranged per style XP | **94.0 / 86.7, +2.125** (fixed top-up, section 5) |
| `cannon-melee` on `def-top` | 113.3 / 103.1, +0.693 | **94.0 / 86.7, +2.125** (band 90 rate for all bands) |
| `cannon-melee` on `hp-top` | 39.9 / 37.6, +1.77 | **31.1 / 28.7, +6.42** Ranged per HP XP |
| `thieve` `deadTicks` (stun-guests) | 1,511 / 2,611 | unchanged |

Overall finish (scenario a, all safe levers, `haggis-cli.ts --levers`; the "without" column disables
`cannon-melee`). Other agents changed the table between the passes (the Dwarf Cannon helper's `ranged` row "Cannon
+ melee to Ranged 99", the Fight Arena row, rival levers), so the first-pass totals below are not comparable.

| Table | Floor | Realistic | Without `cannon-melee`, floor / realistic |
|---|---|---|---|
| HEAD before this pass | 37,995 (late 2,079) | 45,473 (late 9,557) | 37,868 / 45,342 |
| **HEAD + these rows (committed)** | **38,100 (late 2,184)** | **45,580 (late 9,664)** | **37,805 / 45,266** |
| Working tree (these rows + other agents' uncommitted rows) | 38,191 (late 2,275) | 45,540 (late 9,624) | 37,896 / 45,226 |

Faster melee hardly moves Overall now. In the current schedule, Attack and Strength are already 99 when "Melee to
Attack 99" starts (0 ticks), "Combat top-up to Hitpoints 99" takes 0 ticks, and Defence needs only 671 ticks after
the `ranged` row. The critical path is the `ranged` row (4,808 ticks, cannon + melee) and the short quests (6,659
ticks). `cannon-melee` costs 295 / 314 ticks: it slows `def-top` from 162.9 to 86.7 style XP per tick, and the
Ranged it adds is not needed at that point.

## Result (first pass)

| Planner row (`packages/planner/src/haggis-boards.json`) | Before (ESTIMATE) floor / realistic | First pass (MEASURED) floor / realistic |
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

## 4. Higher-HP multiway targets (bands 70 and 90)

Search (CODE-READ, a scratch script over `maps/multiway.csv` and the npc configs): every NPC with 35-130 HP in a
non-Wilderness multiway zone. Quest-locked areas (Legends' death wings, lighthouse dagannoths, Shilo undead ones) and
single spawns are left out. Measured candidates, same gear and script as section 1, 3 x 300 ticks:

- **iw**: Ice Queen lair, 6 ice warriors at 2864-2868, 9948-9951 (`_unpack/225/all.npc` `icewarrior_queen`: HP 59,
  attack, strength and defence 47, slash defence 40, `huntmode=cowardly`, huntrange 5, respawn 60). They attack
  first. Preset `combat_iw_<band>`, start 2866,9946. The walk into the lair was not checked.
- **ks**: Kalphite lair, 5 soldiers within 10 tiles at 3463-3469, 9476-9489, plane 2 (`kalphite.npc:62-95`: HP 90,
  attack, strength and defence 70, poison 20, cowardly, huntrange 5). Preset `combat_ks_<band>`.
- **sk**: Temple of Ikov dungeon, 9 skeletons at 2637-2660, 9885-9894 (`all.npc` id 93: HP 59, defence 36, cowardly,
  huntrange 1). Preset `combat_sk_<band>`. Entry may need the Temple of Ikov quest (not checked).

| Spot | Band | Style XP/tick (runs) | Mean | HP XP/tick (runs) | Mean | Lobsters used (of 20) | In combat |
|---|---|---|---|---|---|---|---|
| iw | 90 | 189.7 / 163.0 / 203.3 | **185.3** | 62.9 / 54.0 / 67.3 | **61.4** | 0 / 0 / 0 | 0.95 |
| iw | 70 | 136.7 / 127.7 / 110.3 | 124.9 | 45.3 / 42.3 / 36.5 | 41.4 | 0 / 2 / 3 | 0.94 |
| ks | 90 | 132.3 / 109.3 / 129.7 | 123.8 | 43.8 / 36.2 / 43.0 | 41.0 | 6 / 5 / 5 | 0.92-0.93 |
| ks | 70 | 84.3 / 95.3 / 75.7 | 85.1 | 27.9 / 31.6 / 25.1 | 28.2 | 8 / 4 / 15 | 0.73-0.90 |
| sk | 90 | 146.0 / 201.3 / 154.0 | 167.1 | 48.3 / 66.7 / 51.0 | 55.3 | 0 / 0 / 0 | 0.94-0.96 |
| sk | 70 | 107.3 / 138.0 / 162.7 | 136.0 | 35.5 / 45.7 / 53.9 | 45.0 | 0 / 0 / 0 | 0.93-0.96 |
| gb (section 1) | 70 | 154.0 / 146.7 / 111.0 | 137.2 | | 45.5 | 0 | 0.92-0.93 |
| gb (section 1) | 90 | 126.0 / 156.7 / 136.0 | 139.6 | | 46.2 | 0 | 0.91-0.92 |

Example line (iw 90, run 3): `RESULT ok cannon=false ticks=300 styleXp=61000 styleXpPerTick=203.3 hpXp=20200
hpXpPerTick=67.3 ... inCombat=286 inCombatShare=0.953 attacks=13 ... food=20`.

- Best band 90: the ice warriors, 185.3 (+33% on the battlefield). They stand within 4 tiles and attack first, so
  the bot hardly walks (13-14 attacks per 300 ticks). Food: 0 at band 90. At band 70, at most 3 lobsters per 300
  ticks, about 90 per live hour of 9,000 ticks (ESTIMATE from 3 runs).
- Best band 70: the battlefield (137.2) and the skeletons (136.0) are equal. Kalphite soldiers are worst: high
  defence and hard hits (up to 15 lobsters in 300 ticks at band 70).
- Many iw, ks and sk runs ended `exit=1` after `RESULT ok`: the logout did not complete because aggressive NPCs
  kept the account in combat. The XP numbers are valid. A real run must walk out of reach before it logs out.

## 5. Cannon policy (fixed top-up)

The Dwarf Cannon helper found that the 20-tick top-up in section 2 never landed: the next attack click replaced the
walk to the cannon, and Fire on the next tick broke the reload after an empty cannon (`research/quest-plan.md`
section 1b). Its fix is now in `scripts/measure/combat-melee.ts` (commit 2c0f205): no attack click until "You load
the cannon" or 8 ticks pass, Fire only after the load lands, top-up every 30 ticks. Section 2 numbers come from the
broken handling. The script also tries a spiral of tiles when the 3x3 is blocked (commit afd2e2b).

Policies, band 90, 3 x 300 ticks:

- **A**: the fixed top-up every 30 ticks, targets within 10 tiles of the cannon (`RELOAD=30`, the default).
- **B**: as A, but targets only within 2 tiles of the cannon, and a timed top-up only from a tile next to the
  cannon or between targets (`NEAR=2 TOPUP_ADJ=1`).

| Spot, policy | Style XP/tick (runs) | Mean | Ranged XP/tick (runs) | Mean | HP XP/tick mean | Ranged per style XP | In combat |
|---|---|---|---|---|---|---|---|
| gb, none (section 1) | 126.0 / 156.7 / 136.0 | 139.6 | 0 | 0 | 46.2 | - | 0.91-0.92 |
| gb, A | 94.0 / 73.0 / 93.0 | **86.7** | 179.8 / 193.2 / 179.5 | **184.2** | 28.7 | **2.125** | 0.74-0.77 |
| gb, B | 50.0 / 52.0 / 59.0 | 53.7 | 195.2 / 152.0 / 178.7 | 175.3 | 17.7 | 3.27 | 0.35-0.49 |
| iw, none (section 4) | 189.7 / 163.0 / 203.3 | 185.3 | 0 | 0 | 61.4 | - | 0.95 |
| iw, A | 116.3 / 138.0 / 148.3 | 134.2 | 81.2 / 76.3 / 49.5 | 69.0 | 44.4 | 0.514 | 0.89-0.91 |
| iw, B | 145.3 / 102.3 / 105.7 | 117.8 | 70.2 / 70.3 / 108.7 | 83.1 | 39.0 | 0.705 | 0.47-0.84 |

Example line (gb, A, run 2): `RESULT ok cannon=true ticks=300 styleXp=21900 styleXpPerTick=73.0 hpXp=7237
hpXpPerTick=24.1 rangedXp=57950 rangedXpPerTick=193.2 ... reloads=10 refires=1 setupTicks=14 balls=882`.

- Policy A at the battlefield is the best cannon session: 271 XP per tick in all (86.7 style + 184.2 Ranged), and
  Ranged 1 to 58 in 300 ticks. This agrees with the helper's 207.7 Ranged and 91.7 style (different stats). It
  costs 38% of the melee rate.
- Policy B idles while no NPC stands within 2 tiles of the cannon, and it adds no Ranged. Not used.
- At the ice warriors the cannon sees few targets. The 3x3 had to go 1 tile south of the group (2866,9945), and
  the cannon scans one of 8 directions per tick (`cannon_fire.rs2:1-91`), so most directions are empty.
- So the choice depends on the board: no cannon at the ice warriors for the melee boards (185 style XP per tick), or
  the cannon at the battlefield when Ranged is the target (184 Ranged + 87 style).

## 6. Ranged: bow plus the fixed cannon

Presets `combat_rb_<band>` and `combat_rb_<band>_cannon` (Gnome battlefield, Ranged, Defence and Hitpoints at the
band). Band 40: yew shortbow and green d'hide; bands 70 and 90: magic shortbow and black d'hide; coif, amulet of
power, 3,000 rune arrows. Same script (`TARGET='^khazard trooper$'`), 3 x 300 ticks per arm. The fight signal is
now Hitpoints XP (own hits only; the cannon gives none). "Balls" counts the balls loaded during the window.

| Arm | Band | Ranged XP/tick (runs) | Mean | Defence XP/tick mean | HP XP/tick mean | Arrows per 1k Ranged XP | Balls per 1k Ranged XP | Food |
|---|---|---|---|---|---|---|---|---|
| Bow (rapid) only | 40 | 110.7 / 101.7 / 105.3 | 105.9 | 0 | 34.9 | 2.31-2.53 | 0 | 0 |
| Bow (rapid) only | 70 | 144.7 / 139.0 / 172.3 | 152.0 | 0 | 50.2 | 1.66-2.13 | 0 | 0 |
| Bow (rapid) only | 90 | 198.3 / 204.7 / 199.3 | 200.8 | 0 | 66.4 | 1.43-1.49 | 0 | 0 |
| Bow (rapid) + cannon | 40 | 345.2 / 334.2 / 296.3 | 325.2 | 0 | 31.6 | 0.61-0.72 | 1.22-1.27 | 0-1 |
| Bow (rapid) + cannon | 70 | 371.5 / 353.3 / 388.5 | 371.1 | 0 | 41.8 | 0.63-0.68 | 1.24-1.46 | 0 |
| Bow (rapid) + cannon | 90 | 386.7 / 394.7 / 397.3 | **392.9** | 0 | 49.8 | 0.61-0.65 | 1.17-1.29 | 0 |
| Bow (longrange) + cannon | 40 | 274.2 / 224.5 / 206.0 | 234.9 | 39.2 | 25.9 | 0.69-0.89 | 1.54-1.74 | 0 |
| Bow (longrange) + cannon | 70 | 331.5 / 282.5 / 295.2 | 303.1 | 57.9 | 38.3 | 0.68-0.75 | 1.41-1.64 | 0 |
| Bow (longrange) + cannon | 90 | 307.7 / 321.0 / 324.7 | **317.8** | 56.4 | 37.3 | 0.61-0.66 | 1.40-1.58 | 0 |
| Cannon + melee (section 5) | 90 | 179.8 / 193.2 / 179.5 | 184.2 | (86.7 style) | 28.7 | - | about 2.3 (helper) | 0 |

Example line (rapid + cannon, band 90, run 3): `RESULT ok cannon=true ticks=300 ... hpXp=16837 hpXpPerTick=56.1
rangedXp=119200 rangedXpPerTick=397.3 ... arrowsUsed=73 arrowsPer1kRanged=0.61 ballsUsed=139 ballsPer1kRanged=1.17
foodUsed=0`.

- Bow + cannon is about twice cannon + melee for Ranged: 392.9 vs 184.2 at band 90 (rapid). Ranged went up 25-28
  levels per 300-tick run at band 40, so "band 40" covers about 40-68.
- Ranged 1 to 99, XP-weighted (4.7 / 22.1 / 73.2%): rapid 392.5 / 384.2 (floor / realistic), longrange
  323.4 / 309.4 Ranged plus 0.180 Defence and 0.119 Hitpoints per Ranged XP.
- Planner, scenario a, from HEAD with each `ranged` row (other agents' uncommitted rows left out):

| `ranged` row | Ranged finish, floor / realistic | Overall, all safe levers | Overall, without `cannon-melee` |
|---|---|---|---|
| Cannon + melee 215.7 / 207.7, side Defence 0.441 (before) | 33,392 / 40,060 | 38,235 / 45,443 | 37,940 / 45,129 |
| Bow rapid + cannon 392.5 / 384.2, no Defence | 31,307 / 37,851 | 40,834 / 48,313 | 38,308 / 45,623 |
| **Bow longrange + cannon 323.4 / 309.4, side Defence 0.180 (committed)** | **31,851 / 38,480** | **39,466 / 46,869** | **37,851 / 45,149** |

- Defence finishes last, so Overall follows Defence. Rapid drops the Defence side XP the old row gave, and Overall
  gets later. Longrange keeps part of it: Ranged lands 1,541 / 1,580 ticks earlier and Overall is the same as before
  when `cannon-melee` is off. With `cannon-melee` on, every variant is later, because the lever slows `def-top` to
  86.7 style XP per tick. `cannon-melee` loses ticks in every table measured; switch it off (the lever list is
  in `packages/planner/src/haggis.ts`, not changed here).
- Supplies for Ranged 99 (longrange): about 1,557 cannonballs and 709 rune arrows (row: 1,700 and 850 with spare).
- Logout: `combat-melee.ts` now walks 18 tiles away and waits until 17 ticks pass with no hit before logout. All 27
  runs in this section ended `exit=0`.

## 7. Why Defence finished last, and two levers that fix it

Planner run: `bun packages/planner/src/haggis-cli.ts research/hiscores-live.json --levers --order`, scenario a.
Before this section (HEAD 3a53608): Overall 37,851 floor (late 1,935) / 45,149 realistic (late 9,233), Defence last,
then Hitpoints (36,137 / 43,260).

### Why Defence was last (ESTIMATE, planner)

Defence XP in the plan before Overall comes from 3 rows only:

| Source | Defence XP | Row |
|---|---|---|
| Monkey Madness, reward option 1 (`quest_mm/scripts/mm_daero.rs2:296`, 20,000 x 25) | 500,000 | `rival-mm`, lands at 16,971 realistic |
| Longrange side XP, 0.180 per Ranged XP (section 6) | 179,700 | `ranged`, 34,887-38,480 realistic |
| Melee top-up, Defence 93 to 99 | 318,758 | `def-top` |

EDF puts `def-top` (deadline 7,974) after the Agility rows (deadline 6,772). So the plan walks from the Ranged spot to
the Wilderness course (335 ticks), trains Agility, walks back (335 ticks), and then trains Defence (1,957 ticks
realistic). Agility ended at 42,857 and Hitpoints at 43,260; only Defence was later.

### Every Defence XP source in rev 289 content (CODE-READ, `stat_advance` is in tenths, x25 on this server)

| Source | Defence XP at 25x | Cite | In the plan |
|---|---|---|---|
| Monkey Madness, option 1 / option 2 | 500,000 / 875,000 | `quest_mm/scripts/mm_daero.rs2:296`, `:305` | option 1 (row `rival-mm`) |
| Dragon Slayer | 466,250 | `quest_dragon/scripts/quest_dragon.rs2:34` | after Overall (`combat-hp-bound`) |
| Holy Grail | 382,500 | `quest_grail/scripts/quest_grail.rs2:117` | after Overall |
| Hero's Quest | 76,875 | `quest_hero/scripts/quest_hero.rs2:30` | inside `quests-rest` |
| The Fremennik Trials | 70,310 | `quest_viking/scripts/quest_viking.rs2:136` | inside `quests-rest` |
| Nature Spirit | 50,000 | `quest_druidspirit/scripts/quest_druidspirit.rs2:425` | inside `quests-rest` |
| Observatory, Virgo sign only (random sign) | 21,875 | `quest_itgronigen/scripts/quest_itgronigen.rs2:228` | inside `quests-rest` |
| In Search of the Myreque | 15,000 | `quest_routequest/scripts/quest_routequest.rs2:27` | inside `quests-rest` |
| Genie lamp (random event only), base level x 10 | 23,250 at Defence 93 | `general/scripts/xplamp/xplamp.rs2:110-111` | no: not plannable |
| Melee, defensive style: 4 x base per damage | 100 per damage | `skill_combat/scripts/combat.rs2:150` | `def-top` |
| Melee, controlled: 1.33 x base each to Attack, Strength, Defence | 33.25 per damage | `combat.rs2:154` | no |
| Ranged, longrange: 2 x base each to Ranged and Defence | 50 per damage | `combat.rs2:159` | `ranged` side XP |
| Magic with the defensive melee style set: 1.33 Magic + 1 Defence x base | 25 per damage | `combat.rs2:164`, `player/player_magic.rs2:205-208` | no: a quarter of melee |

Checked and rejected (planner, realistic): Monkey Madness option 2 gives +375,000 Defence (no `def-top` at all) but
-375,000 Strength and -375,000 Hitpoints, which costs a 835-tick Strength top-up and about 5,300 ticks of Hitpoints (ESTIMATE, hand count).
Dragon Slayer before Overall needs 32 QP first (`qp-filler`, `druid`, `gobdip`). The cannon during `def-top` is the
retired `cannon-melee` lever (an LP check with the measured rates: its value per tick is 0.92 of the bow + melee mix).

### Measurement: Defence style at the plan's stats (MEASURED practice)

Presets `combat_gb_def93`, `combat_iw_def93` (new; Attack, Strength, Hitpoints 99, Defence 93, the section 1 gear,
20 lobsters), `STYLE=3` (rune scimitar "block", Defence XP), 3 x 300 ticks each, `RANDOM_EVENTS=0`:

| Spot | Defence XP/tick (runs) | Mean | HP XP/tick (runs) | Food | In combat |
|---|---|---|---|---|---|
| Ice warriors (iw) | 192.3 / 171.0 / 145.3 | **169.5** | 63.8 / 56.7 / 48.1 | 0 | 0.95 |
| Gnome battlefield (gb) | 158.3 / 153.0 / 144.0 | **151.8** | 52.4 / 50.6 / 47.6 | 0 | 0.91-0.92 |

Example lines:
`RESULT ok cannon=false ticks=300 styleXp=57700 styleXpPerTick=192.3 hpXp=19130 hpXpPerTick=63.8 ... inCombatShare=0.950 attacks=14 ... foodUsed=0 ... lv=99/99/94/99/1` (iw run 1)
`RESULT ok cannon=false ticks=300 styleXp=47500 styleXpPerTick=158.3 hpXp=15730 hpXpPerTick=52.4 ... inCombatShare=0.913 attacks=25 ... foodUsed=0 ... lv=99/99/94/99/1` (gb run 1)

- The defensive style at Attack and Strength 99 is near the band 90 aggressive rate (iw 185.3, gb 139.6): the higher
  levels make up for the lost +3 Strength style bonus.
- The `def-top` row used a 1-99 XP-weighted rate (179.5 / 162.9). With Monkey Madness on, the row starts at
  Defence 93, so only the band 90 rate applies.

### Levers (`packages/planner/src/haggis.ts` LEVERS, `owner: false`; patches in `haggis-boards.json`)

- **`def-at-ranged-spot`**: `def-top` requires `ranged`; `agility-52` requires `def-top`. Defence trains at the
  Ranged spot right after the Ranged row (both rows are at the same place), so the walk back from the Wilderness course
  is gone. Rate: the gb measurement above (158.3 / 151.8), because the Ranged row is measured at the Gnome battlefield.
- **`waterfall-late`**: Waterfall serves Quest Points only, so it moves after Overall; `att-top` and `str-top` require
  `tree`, `grandtree` and `rival-mm` in place of `waterfall`. Attack is 99 without Waterfall: Tree Gnome Village
  286,250 + The Grand Tree 460,000 + Fight Arena 304,375 = 1,050,625. Strength: Monkey Madness 875,000, then a
  123,458 XP top-up (667 ticks at 185.3) in place of Waterfall (1,037 ticks) and its 535 walk ticks.

Overall finish (scenario a, all safe levers; the same numbers from HEAD + these rows and from the working tree with
other agents' uncommitted rows):

| Table | Floor | Realistic | Last skill, then |
|---|---|---|---|
| Before (HEAD 3a53608) | 37,851 (late 1,935) | 45,149 (late 9,233) | Defence; Hitpoints 36,137 / 43,260 |
| `def-at-ranged-spot` only | 37,434 (late 1,518) | 44,784 (late 8,868) | Defence; Agility 35,323 / 42,492 |
| `waterfall-late` only | 37,754 (late 1,838) | 44,957 (late 9,041) | Agility; Defence 33,865 / 40,580 |
| **Both (committed)** | **37,337 (late 1,421)** | **44,592 (late 8,676)** | **Agility; Defence 33,448 / 40,215** |

Saved as the last lever: `waterfall-late` 417 / 365, `def-at-ranged-spot` 97 / 192 (CLI `--levers`).

- Agility is now the last skill. Its rows are ESTIMATE (lap times not measured). Hitpoints 99 lands at
  30,468 / 37,105.
- The iw rate in the same order would save 356 / 219 more ticks than the gb rate (planner, without `waterfall-late`), but the Ranged row is at the
  battlefield, and the walk into the Ice Queen lair is not checked. Not modelled.
- Scorpion Catcher (165,625 Strength) in place of the Strength top-up: 277 floor ticks against 608, but 832
  realistic against 667 (ESTIMATE quest time). Not modelled.

## Open

- Measure Agility lap times (the Wilderness course row is now on the critical path).
- The real places of the combat rows: `str-top`, `ranged`, `def-top` are all at `falador-white-knights` in the
  travel model, but the rates come from the Gnome battlefield and the Ice Queen lair.
- Ranged 1 to 40 with a lower bow (1.6% of the XP; not measured).
- The walk into the Ice Queen lair and the Temple of Ikov dungeon (access rules not checked).
- The fixed cannon handling at bands 40 and 70 (only band 90 measured; `def-top` uses the band 90 cannon rate).
- Stun guests from a fresh ladder (Thieving 1 to 99), with real Prayer and Magic level-up pages and refill trades.
- `kills` and `dmgTaken` in the RESULT lines are not reliable (the SDK did not report kill events; damage events
  repeat). The rates use XP deltas only.
