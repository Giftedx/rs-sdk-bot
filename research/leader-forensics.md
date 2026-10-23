# Leader forensics for the lost and close boards (2026-10-23)

This file records how the #1 accounts on 13 boards got their times, and what we must build to match them.
Live data is from read-only GETs at 2026-10-23 about 07:00Z: 13 board pages, then 59 player pages (the top 5 of
each board), 1.1 s between requests. A world-feed watch ran for about 4 minutes (roster, then a 32x32 `sub`
rectangle around 7 online accounts, 25 s each). Raw data is not committed (session scratchpad).

Code cites: `engine/` = `vendor/rs-sdk/server/engine/src`, content paths start at
`vendor/rs-sdk/server/content/scripts` unless they start with `maps/` or `pack/` (`vendor/rs-sdk/server/content`).
The live server runs newer code than the vendored copy (INDEX C13), so every CODE-READ is for the vendored copy.

Confidence labels: **CONFIRMED** = code and live evidence agree. **LIKELY** = code allows it and the evidence
fits, but no direct observation. **GUESS** = fits some evidence only.

## Three facts that change how to read a player page

1. **Old stamps are logout stamps, not level-up stamps.** The hiscore playtime is `levelPlaytime[stat]`, which
   `addXp` sets at the level-up tick (`engine/engine/entity/Player.ts:1904-1905`). If it is 0 ("reached before this
   was tracked", `Player.ts:337-339`), the save uses `player.playtime` at the logout or autosave instead
   (`engine/server/login/LoginServer.ts:162`). Once stamped, the time does not change while the level stays the
   same (`LoginServer.ts:171`). So a group of skills with the **same** stamp is one save, and the real level-up
   was earlier. Examples (MEASURED live): stunbaron has Prayer, Woodcutting, Fishing, Mining at 12,006; Fletching,
   Firemaking, Crafting, Smithing, Herblore at 17,697; the other 10 skills and Overall at 35,916. miner3 has Mining
   99, Attack 42, Strength 40, Hitpoints 40 all at 3,964. These leader times are upper limits; the true times are
   lower or equal. CONFIRMED (code + identical stamps).
2. **The Quest Points row shows quests that the board pages hide.** A player page lists QP with its own save
   stamp (`LoginServer.ts:203-219`). Skills below 15 are not shown (`LoginServer.ts:160`), so a quest that gives
   XP only to the trained skill is visible only as a QP count. Single-skill leaders with QP: Herblore (4 QP),
   Magic (1 QP), Crafting #3-#5 (1 QP), Mining #3 and #4 (2 and 1 QP). See the boards below.
3. **Respawn timers shrink with the live player count.** `~scale_by_playercount(base)` returns
   `base * (4000 - min(playercount, 2000)) / 4000` (`general/scripts/player_count.rs2:1-4`); `playercount` is
   `World.getTotalPlayers()` (`engine/engine/script/handlers/ServerOps.ts:126-127`). Rocks
   (`skill_mining/scripts/mining.rs2:159,204,249`) and trapped chests (`skill_thieving/scripts/thieving.rs2:156`; stalls at `:64`) use
   it. The world feed counted **1,351** players (MEASURED live), so iron respawn is 20 x 0.66 = about **13 ticks**
   live. The practice server has a few players, so its respawn is about 20. Our measured 97 XP/tick for iron
   (`board-ranking-honest.md:10`) is a practice number and is low for live. CODE-READ.

## Families seen on the boards and in the world feed

Board accounts in the top 5 of these 13 boards: jackalope* (12 rows), nick* (19), stun* (17), cairn_* (5),
lach* (5), plus miner3, crab26eba2, edwardmage1. Nearly every non-Overall leader is a **single-skill account**:
Overall total level 126 = one 99 and every other skill at 1 (Hitpoints 10).

World feed at about 07:00Z (MEASURED live, roster of 1,351): 27 family accounts online. Jackalope helpers named
by job: `jackalopemkt`, `jackalopebnk`, `jackaloperun`, `jackalopees1`/`es2` at the Varrock west GE (3182-3185,
3436-3439); `jackalopees3` (2891,4846) and `jackalopecrf` (2892,4812) in the rune essence mine area;
`jackalopevin` at (3144,3451, level 2); `jackalopebk2` at the Ardougne baker stall (2655,3283); `jackalopett1`
at the Ardougne knights (2669,3310); `jackalopegp1`/`gp2`, `jackalopehb5`, `jackalopegt1` (combat 89-111).
These are supplier accounts: market, bank, essence, wine, food. CONFIRMED that the family runs suppliers
(names, positions); the job of each one is LIKELY.

`jackalopevin` stands next to the grape spawn on the top floor of the Cooks' Guild: `maps/m49_53.jm2:10243`
`2 8 58: 1987 1` = obj 1987 `grapes` (`pack/obj.pack:1988`) at (3144,3450, level 2). Our `cooking-board.md`
lists only the (2509,3493) spawns. The Cooks' Guild spawn is a grape source we did not have. CONFIRMED (code +
position).

## Summary

Leader XP/tick = 998,458 / leader ticks (the whole run, setup included). "Ours" = the board done alone on a fresh
account, floor / realistic, from `haggis-run.md:94-104` (ESTIMATE), unless marked MEASURED.

| Board | #1 now (ticks) | Inferred method | Conf. | Leader XP/tick | Ours XP/tick (ticks) | Build to match or beat |
|---|---|---|---|---|---|---|
| Cooking | jackalopeck3 (38) | Login wine timer on banked wine; grapes from the Cooks' Guild spawn | LIKELY | 26,275 | 25,601 / 19,577 (39 / 51) | Cocktails to 35 + hand-made wine (legal); a faster session A |
| Fletching | jackalopefr1 (58) | Arrows and darts, 5 actions per tick, no quest | LIKELY | 17,215 | 15,601 / 12,967 (64 / 77) | Items in the pack at the tutorial exit; cut the 15-22 tick start |
| Magic | **jackalopemg3 (1,324)** | Imp Catcher (1 QP, to 44), spell ladder to 80, Mage Arena, Charge 5 per tick to 99 | LIKELY | 754 | 581 / 523 (1,718 / 1,910) | Imp Catcher beads, Mage Arena run, Charge (163 casts) |
| Thieving | jackalopeth8 (2,935) | Knights at low HP; how they reach 55 fast is unknown | GUESS | 340 | 302 / 189 (3,301 / 5,283); live 162 MEASURED (6,169) | Measure the 1-55 leg; relog-on-stun (R10) on knights |
| Mining | miner3 (<= 3,964) | Power-mine iron at the 5-rock Wilderness tile with combat 40 for safety; live respawn about 13 | GUESS | >= 252 | 166 / 121 (6,021 / 8,236); 97 MEASURED practice | Doric's Quest to 49; measure iron live at full player count; the 5-rock tile |
| Firemaking | **cairn_ashes (664)** | Log ladder, 4 ticks per log | LIKELY | 1,504 | 1,565 / 1,368 (638 / 730) | Tighter start and log supply only |
| Herblore | jackalopehl2 (447) | Druidic Ritual (4 QP) then potions, 5 per tick | CONFIRMED (QP) / LIKELY (order) | 2,234 | 9,509 / 3,160 (105 / 316) | Skip the quest (no gate in code); supply |
| Crafting | nickgemcut (197) | Gem cutting from 1, no quest | LIKELY | 5,068 | 11,094 / 4,477 (90 / 223) | Bank cycle; uncut dragonstone supply |
| Prayer | stunpray (1,281) | Bury dragon bones, 2 ticks each | LIKELY | 779 | 847 / 762 (1,179 / 1,310) | 560 dragon bones; zero-wait restock |
| Smithing | stunsmither (1,337) | Platebodies, 5 ticks each, no quest | LIKELY | 747 | 1,082 / 900 (923 / 1,110) | Bar supply (adamant 0 sellers) |
| Runecraft | jackaloperc6 (2,354) | Essence relay from the jackalope essence helpers | LIKELY | 424 | 789 / 334 (1,266 / 2,986) | Helper rotation; trip time |
| Agility | stunagile (6,772) | Prayer 43 at tick 67 (11 dragon bones) for Protect from Melee, then the Wilderness course | LIKELY | 147 | 183 / 106 (5,446 / 9,400) | Bones first, Protect from Melee, Wilderness laps |
| Overall | stunbaron (<= 35,916) | Specialist sessions: 4 skills by 12,006, 9 by 17,697, 19 by 35,916; 13 QP | CONFIRMED (stamps) | - | 40,263 / 68,214 ticks (all boards, `haggis-run.md:75`) | Whole Haggis plan; the stamps are upper limits |

Bold = a new #1 since `research/hiscores-2026-10-22.json` (see Contradictions in INDEX).

## Cooking (38 ticks)

Evidence (MEASURED live): jackalopeck3 Cooking 99 at 38, Overall 126, no QP. stuncook 51 and stuncookv2 53 are
the same shape. jackalopeck2 (99 at 142) and jackalopeck1 (99 at 155) are online now, idle at (3242,3248) and
(3092,3242). Family supplier `jackalopevin` stands at the Cooks' Guild grape spawn.

Method: LIKELY the login timer. Every login calls `~ferment_wines_login` (`login_logout/login.rs2:70`), which
sets the 20-tick `fermenting_wine` timer with no level check (`skill_cooking/scripts/cooking_inv/scripts/wine/
wine.rs2:72-73`). The timer ferments every banked unfermented wine in 15 batch rolls (`wine.rs2:22-41`) and
every wine in the pack one by one (`wine.rs2:56-68`). 38 = a short first session to bank the wine, a relog,
then about 22 ticks (`cooking-board.md`, MEASURED practice: 99 at session tick 22). Noted wine does not count in
the pack: `inv_total(inv, jug_unfermented_wine)` reads unnoted jugs only, so the wine must be banked.

Code check: works in this engine (CODE-READ + MEASURED practice). XP: 1,100 tenths x 25 = 2,750 per wine.

Ours: the login route is ruled out (`owner-requests.md`, R10). The legal route is in `haggis-run.md:116-120`:
8 finished cocktails (`gnome_cooking/gnome_cocktail_finish.rs2:29-30`, 600 tenths = 1,500 XP each, no level
check, no delay) take Cooking to 36, then one hand-made wine (`wine.rs2:7-20`, needs 35) starts the same timer.
The cocktails cost about 2 ticks and replace the relog, so the legal route is within about 1 tick of the login
route (floor 39 vs 38).

Build: (1) put the bank deposit and the cocktail finish into the first 16 ticks after the tutorial;
(2) get grapes from the Cooks' Guild spawn with a Cooking 32 helper, as jackalopevin does (respawn time not
measured); (3) measure the tutorial skip live (`haggis-run.md:206`).

## Fletching (58 ticks)

Evidence: jackalopefr1 99 at 58, stunfletch 66, nickfeather 98, lachbow003 136. All single-skill, no QP.
nickmax and nickoverall have Fletching 99 at 287 and 312 on maxed accounts, so they also did Fletching first.

Method: LIKELY arrows (15 per action, `skill_fletching/scripts/arrows.rs2:70-86`) and darts (10 per action,
`skill_fletching/scripts/darts.rs2:20-43`), up to 5 actions per tick. Dart XP per action at 25x: bronze 450
(level 1) to rune 4,700 (level 81) (`skill_fletching/configs/darts/darts.dbrow:4-42`). No quest helps:
no quest gives only Fletching XP in `quest-xp.md`.

Code check: works (CODE-READ). Cap: 5 x 4,700 = 23,500 XP/tick at the top tier.

Ours: 64 floor / 77 realistic alone (`haggis-run.md:97`). The leader's 58 is below our start plus action
floor (`haggis-run.md:196`), so its start (tutorial plus first trade) is faster than ours.

Build: have every arrow and dart item ready in one trade at the tutorial exit; measure the live tutorial skip
and the first trade. Supply list: `haggis-run.md:154`.

## Magic (1,324 ticks; was 1,513)

Evidence (MEASURED live):

- jackalopemg3 (new #1): Magic 99 at 1,324; **QP 1** stamped at 352. Its other skills (Defence 72, Hitpoints 60,
  Prayer 39, Attack 21, Strength 20) have stamps from 6,860 to 26,585, after the 99. Seen idle in the world feed
  at Edgeville (3094,3489), combat 85.
- stunmage (#2): Magic 99 at 1,513, **Hitpoints 36 at 1,410**, **Prayer 38 at 197**, QP 1 stamped at 490.
- nickmagi2 (#3): Magic only, 3,416. edwardmage1 (#4): 10,045 (all stamps equal = one save).

Inference:

- The 1 QP is Imp Catcher (LIKELY): 875 Magic XP x 25 = 21,875 (`quests/quest_imp/scripts/quest_imp.rs2:4`),
  which is level 44 on this curve, and 1 QP (`general/configs/quest.constant:104`). The beads can come from a
  helper. Witch's Potion is the other 1-QP Magic quest (8,125, level 31) and is weaker.
- Prayer 38 at 197 = 8 dragon bones (8 x 1,800 = 14,400 XP; 7 bones = 12,600 is below level 37 at 12,622).
  Level 37 is Protect from Magic. Hitpoints 36 at 1,410 = combat-spell damage. Both fit the Mage Arena fight:
  Kolodion needs Magic 60 (`areas/area_mage_arena/scripts/kolodion.rs2:6`) and fights with magic. LIKELY.
- Magic 99 only 103 ticks after the last Hitpoints level fits **Charge**: 1,800 tenths = 4,500 XP per cast,
  level 80 (`skill_magic/configs/magic_spells.dbrow:206-212`), unlocked by `%magearena >= ^mage_arena_staff_given`
  (`skill_magic/scripts/spells/charge.rs2:4-7`; the staff step is `areas/area_mage_arena/scripts/
  chamber_guardian.rs2:15`). The script has no `p_delay` (`charge.rs2:1-27`) and the "already charged" check is
  commented out (`charge.rs2:8-12`). Every other XP spell has a delay (`alchemy.rs2:37,69`, `enchant.rs2:53`,
  `superheat.rs2:67`, `telegrab.rs2:70,77`, `teleport.rs2:61,65`, `charge_orb.rs2:44`, `convert_bones.rs2:42`).
  `p_finduid` fails only when the player cannot be accessed (`engine/engine/script/handlers/PlayerOps.ts:88`),
  and without a delay it can be accessed again in the same tick. So 5 casts per tick = **22,500 XP/tick**.
  80 to 99 = 731,289 XP = 163 casts = about 33 ticks. Runes: 3 fire, 3 blood, 3 air per cast (a staff removes
  one kind): 489 blood runes. CONFIRMED in code; that the leader used it is LIKELY.

Ours: the Haggis plan uses the enchant ladder with no Charge (`haggis-run.md:160`): 1,718 floor alone.
44 to 80 with delayed spells is about 245,000 XP at 500-650 XP/tick (enchant ruby to dragonstone at 3 ticks,
`enchant.rs2:53`) = about 400-500 ticks (ESTIMATE).

Build: (1) Imp Catcher with 4 traded beads; (2) 8 dragon bones for Protect from Magic; (3) delayed-spell ladder
44 to 80; (4) walk to the Mage Arena (deep Wilderness, PvP risk), the Kolodion fight, the statue and the staff;
(5) 163 Charge casts at 5 per tick with `s.direct` (INDEX fact 7). The Mage Arena fight time is not measured.

## Thieving (2,935 ticks)

Evidence: jackalopeth8 Thieving 99 at 2,935; Attack, Strength, Defence, Hitpoints 40 stamped 43,503-43,606, long
after the 99 (also `thieving-ladder.md:115-116`). No QP. stunthief 3,253, cairn_steals 3,342, jackalopeth2
3,364, nickpilfer 3,961: all single-skill, no QP. World feed: jackalopeth2 (already 99) walked the Ardougne castle
first floor (2573,3308,1) to (2588,3303), played `human_lockedchest` (seq 537) then `human_openchest` (seq 536)
(`pack/seq.pack:537-538`) at the castle chest, then was at (2660,3289,0) 25 s later. `jackalopett1` was at the
knights (2669,3310). MEASURED live.

Code check:

- Castle chest: level 72, 5,000 tenths = 12,500 XP, respawn 800 scaled (`skill_thieving/configs/chests/
  trapped_chest.dbrow:45-50`). The disarm always succeeds and takes `p_delay(1)` x3 + `p_delay(2)`, then
  teleports the player (`skill_thieving/scripts/thieving.rs2:141-163`). With 2 chests that is about 31 XP/tick:
  money for a 99 account, not a training method. CONFIRMED.
- Castle lock door loc_2555: level 61, 500 tenths = 1,250 XP, success 4..40 of 256 (`skill_thieving/configs/
  doors/locked_door.dbrow:45-52`); a fail returns with no delay (`skill_thieving/scripts/doors/locked_door.rs2:
  169-172`). At 10-16% per tick that is about 125-195 XP/tick, below knights. CONFIRMED in code.
- Knights stay the best pickpocket target (`thieving-ladder.md:12-19`). The stun is `%stunned = map_clock + 8`;
  a relog clears it (`thieving-ladder.md:124-131`).

Inference: GUESS. The leader probably pickpockets knights from 55 at low HP (jackalopett1 does). 2,935 means the
1 to 55 leg is much faster than our measured 1,437-1,816 (`board-ranking-honest.md:9`). The evidence does not
show how.

Build: (1) measure each leg of 1 to 55 live with the ledger (men, warrior women at 25, guards at 40) and find
where we lose; (2) relog on every stun at knights (owner allowed logout, R10; practice +17%,
`thieving-ladder.md:128`); (3) a food courier so the bot never banks.

## Mining (<= 3,964 ticks)

Evidence (MEASURED live):

- miner3: Mining 99, Attack 42, Strength 40, Hitpoints 40, all stamped 3,964 = one save, so the real 99 is at or
  before 3,964. No QP. It trained combat before or during the mining run.
- cairn_rocks 4,317: Mining only, no QP. stunmine 4,575: Magic 45 at 136, **QP 2** at 267. nickquarry 6,015:
  **QP 1** at 763. lachmine003 8,374.

Code check:

- Doric's Quest gives 1,300 x 25 = 32,500 Mining XP = level 49, 1 QP (`quests/quest_doric/scripts/
  quest_doric.rs2:99`, `general/configs/quest.constant:85`). That explains the 1 QP of nickquarry and half of the
  2 QP of stunmine (the other is probably Imp Catcher: Magic 44, and a teleport cast gives the 45th level; GUESS).
  CONFIRMED in code; LIKELY for these accounts.
- Iron: `get_ore_fast` (no `p_delay`), 350 tenths = 875 XP, success 96..350, respawn 20 (`skill_mining/configs/
  mine.dbrow:70-72`, `skill_mining/scripts/mining.rs2:181-214`). Rune pickaxe `mining_rate` 2 = a roll every
  3 ticks (`skill_mining/configs/pickaxes.obj:198`). Success reaches 100% near 99.
- Live respawn about 13 ticks at 1,351 players (fact 3 above). Model cap with 3 rocks: 3 x 875 / (13 + 1) =
  about 187 XP/tick. With the 5-rock tile at (3100,3767) (`research/iron-spots.ts`, deep Wilderness):
  5 x 875 / 15 = about 290 XP/tick, above the 252 needed. ESTIMATE.
- Limestone (loc_4027 to 4029): 265 tenths = 662 XP, level 10; each rock gives 3 ores in a row (stage chain
  `skill_mining/configs/rocks.loc:742-801`), then is empty for 40 ticks (`mine.dbrow:195-223`). About 43 XP/tick
  per rock. Not better than iron. CODE-READ.

Inference: GUESS. miner3 power-mined iron at the 5-rock Wilderness tile, with combat 40 to survive. cairn_rocks
(4,317, no combat, no quest) fits 3-rock iron at the live respawn.

Build: (1) Doric's Quest first (Mining 49, saves the slow low-level rolls); (2) measure 3-rock iron **live** at
the full player count, 3 runs; (3) if it is below 250, test the 5-rock Wilderness tile with Protect from Melee
or combat 40. This needs owner approval for Wilderness risk.

## Firemaking (664 ticks; was 673)

Evidence: cairn_ashes 664 (new #1), jackalopefma 673, cairn_burns 690, jackalopefm4 706, stunfiremake 836. All
single-skill, no QP.

Method: LIKELY the log ladder. A success sets `%action_delay = map_clock + 4`, and the next log rolls when the
delay equals the clock (`skill_firemaking/scripts/firemaking.rs2:98-117`); `stat_random(firemaking,64,512)`
always succeeds from about level 44. So the cap is 4 ticks per log (magic log 303.8 -> 7,595 XP = 1,899 XP/tick).
No quest gives Firemaking only. CONFIRMED in code.

Ours: 638 floor / 730 realistic alone (`haggis-run.md:100`). The leaders are at our floor. A win needs the floor:
no wasted tick on the first light, logs in the pack, no bank.

## Herblore (447 ticks)

Evidence (MEASURED live): jackalopehl2 Herblore 99 at 447, **QP 4 stamped at 450**. stunherblore 99 at 465,
**QP 4 at 467**. jackalopehl1 99 at 1,146, QP 4 at 630. nickherblore 99 at 2,474, QP 4. Both top accounts saved
3 ticks after the 99 (a logout right after the board).

Code check: 4 QP = Druidic Ritual (`general/configs/quest.constant:87`); it gives 2,500 tenths = 6,250 XP, level
28 (`quests/quest_druid/scripts/quest_druid.rs2:3`). The herblore scripts have **no** Druidic Ritual check: no
`%druidquest` read in `skill_herblore` (search on 2026-10-23; the only readers are `area_taverly` and
`area_karamja` NPC scripts). CONFIRMED that they did a 4-QP quest; LIKELY that it is Druidic Ritual.

Inference: the leaders spend part of 447 ticks on a quest that this engine does not need. 6,250 XP is about 2
potion actions at 5 per tick. Their brew part is under 447 ticks.

Ours: 105 floor / 316 realistic alone (`haggis-run.md:99`). This board is winnable. Skip the quest. The limit is
supply (176 torstol and jangerberries, `haggis-run.md:156`).

## Crafting (197 ticks)

Evidence: nickgemcut 197 (no QP), crab26eba2 536 (no QP), nickcrafti 580, nickcrafts 878, nickcrafty 1,195
(each **QP 1**, stamped at the 99 save). Three crab* accounts were in the Dwarven Mine area (3032-3046,
9736-9740) in the world feed.

Code check: the 1 QP is Sheep Shearer (LIKELY): 150 Crafting x 25 = 3,750 XP, level 22, 1 QP
(`quests/quest_sheep/scripts/quest_sheep.rs2:5`, `general/configs/quest.constant:120`). The leader does not use
it. Gem cutting: one gem per action, no delay (`skill_crafting/scripts/gem/uncut_gem.rs2:15-63`).

Method: LIKELY gem cutting from level 1. Ours: 90 floor / 223 realistic alone. Build: the tight bank cycle
and level-up clearing (`crafting-board.md`), and 305 uncut dragonstones (0 GE sellers).

## Prayer (1,281 ticks)

Evidence: stunpray 1,281, nickprays 2,028, lachpray001 2,224: single-skill, no QP. nickmax and nickoverall have
Prayer 99 at 2,037 and 2,725.

Code check: bury is `p_delay(0)` then the XP (`skill_prayer/scripts/bury_bone.rs2:10-15`) = 2 ticks per bone.
Dragon bones are the best bones (720 tenths = 1,800 XP; `skill_prayer/configs/bones.obj`). This content has no
Ectofuntus or bone-on-altar XP (no match for `ectofunt` or `bonemeal` in the scripts). Cap: 900 XP/tick.
555 bones = 1,110 ticks of burying. CONFIRMED in code; LIKELY the leader method.

Ours: 1,179 floor / 1,310 realistic alone. Build: 560 dragon bones and a restock with no idle ticks (a helper
trade inside the bury rhythm).

## Smithing (1,337 ticks)

Evidence: stunsmither 1,337, nickcrucible 1,839, nickforged 1,893, nicktemper 2,021, lachsmith001 2,032. All
single-skill, **no QP**, so not Knight's Sword (318,125 Smithing at 25x, `xp-per-tick.md`, Mining 10 only).

Method: LIKELY platebodies at 5 ticks per item (`xp-per-tick.md`, Smithing). Ours: 923 floor / 1,110 realistic
alone: winnable on rate. Build: bar supply (adamant 0 sellers). Knight's Sword (level 82 at once) is an option for
us that the leaders did not take; its quest time is not measured.

## Runecraft (2,354 ticks)

Evidence: jackaloperc6 2,354, stunrc 2,397, nickaircraft 3,265, nickrc 4,339, nickairrunes 4,668. All
single-skill, no QP. World feed: `jackaloperun`, `jackalopees1`, `jackalopees2` at the GE, `jackalopees3` and
`jackalopecrf` at the essence mine.

Method: LIKELY the essence relay: helpers mine and trade 27 essence per trip; the specialist crafts at the
highest altar it can use (`xp-per-tick.md`, Runecraft). Ours: 1,266 floor / 2,986 realistic. Build: the helper
rotation and a measured trip time (`runecraft-ladder.md`).

## Agility (6,772 ticks)

Evidence: stunagile Agility 99 at 6,772, **Prayer 43 at 67**, no QP. cairn_jumps 7,111 and nickagility 8,476
are single-skill.

Inference: Prayer 43 at tick 67 = 11 dragon bones buried at the start (11 x 1,800 = 19,800 XP; level 43 needs
19,684). Level 43 is Protect from Melee. That is armour for the Wilderness course (level 52, `skill_agility/
scripts/wilderness_course.rs2:76-176`, 14,285 XP per lap at 25x). LIKELY.

Ours: 5,446 floor / 9,400 realistic alone. Build: bury 11 dragon bones first (about 22 ticks), keep Protect from
Melee on in the Wilderness, measure the lap time, 3 runs.

## Overall (<= 35,916 ticks)

Evidence: stunbaron 19 skills at 99, Overall 35,916. Stamp groups (one save each): 12,006 (4 skills), 17,697
(5 skills), 35,916 (10 skills and Overall). QP 13 at 17,695. stunhard, stunless, stunking show the same pattern.
nickoverall (45,443) has distinct stamps, so it was tracked later: Fletching first (312), then Herblore and
Crafting (2,698), Prayer (2,725), Woodcutting (7,653), Firemaking (8,470), combat (18,421-22,087), and Agility last
(45,443).

Inference: CONFIRMED that the stun* Overall stamps are logout stamps (fact 1), so their real totals are lower or
equal. nickoverall's order (fast skills first, Agility last) matches our EDF order (`haggis-run.md`).

Build: the full Haggis plan. Overall slack is -4,347 at floor (`haggis-run.md:75`).

## What the forensics change

1. **Charge is the Magic win**: 22,500 XP/tick from 80 (CONFIRMED in code). Put Imp Catcher, the Mage Arena and
   Charge into the Haggis plan in place of the enchant ladder.
2. **Quest bootstraps** that the leaders use: Imp Catcher (Magic 44), Doric's Quest (Mining 49), Sheep Shearer
   (Crafting 22). Druidic Ritual is a waste in this engine.
3. **Live respawn is about 0.66x** at 1,351 players. Re-measure Mining, and every respawn-limited rate, live.
4. **Grapes**: the Cooks' Guild top-floor spawn (3144,3450,2) feeds the jackalope wine.
5. Leader times on Overall and Mining are logout stamps (upper limits); plan with margin.

## Open

- Mage Arena fight time and route (Wilderness): not measured.
- Thieving 1-55 leg: the leader method is not found.
- Mining: live iron rate at full player count not measured; the 5-rock tile needs Wilderness approval.
- Respawn time of the Cooks' Guild grapes: not measured.
- The world feed shows position, animation and facing only; no XP, so the methods above are inferences.
