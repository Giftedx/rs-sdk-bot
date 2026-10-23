# Quest Points board: every quest in rev 289 and the planner's QP rows (2026-10-23)

## Result

- The content has **68 quests and 145 QP**. 145 is the maximum. 146 QP cannot be reached. (CODE-READ)
- The #1, avery, has 145 QP stamped at playtime 1,022,262 (`research/boards-special.md`, MEASURED live). So the
  only win is all 68 quests, with the save that changes the total at playtime 1,022,261 or less.
- Before this change, the planner's row `quests-rest` gave 87 QP, so the run ended at 142 QP and the board was
  NEVER. That row was sized for the old target (beat 141). The row now gives 90 QP for the 46 quests that are on
  no other row, plus 7 QP of 4 quests whose own rows carry `qp: 0`. The run ends at 145 QP and the board is WIN.
- There is no "cheapest set": all 68 quests are mandatory for 145. The 3 QP that the plan lacked were never
  specific quests. They were an under-count in the aggregate row.

Code cites are under `vendor/rs-sdk/server/content/scripts/` (the server's content). The files used here are the
same in `vendor/lostcity-content/scripts/`: `general/configs/quest.constant` and `general/scripts/quests.rs2`
are identical, and `diff -rq` of the two `quests/` trees shows only 2 different files (Mort'ton
`razmire_keelgan.rs2`, Troll Romance `quest_troll_love.obj`). Quest cites below are relative to `quests/`.

## How the QP total is computed (CODE-READ)

- `[proc,count_questpoints]` (`general/scripts/quests.rs2:96-302`) adds one `^<quest>_questpoints` constant per
  completed quest. `[proc,update_questpoints]` (`:89-94`) writes the count to `%qp`.
- The 68 constants are at `general/configs/quest.constant:72-139`. Their sum is 145. The 68 names in the proc
  are the same 68 constants, with none left out (checked with `diff`).
- Shield of Arrav counts once (`quests.rs2:170`): `%blackarmgang = ^blackarmgang_complete | %phoenixgang = ^phoenixgang_complete`
  gives `^blackarmgang_questpoints` (1 QP). Both gangs do not give 2.
- QP gates: Black Knights' Fortress 12 QP (`areas/area_falador/scripts/sir_amik_varze.rs2:15`), Champions'
  Guild / Dragon Slayer 32 QP (`areas/area_varrock/scripts/champions_guild.rs2:2`,
  `quest_dragon/scripts/dragon_journal.rs2:7`), Heroes' Quest 55 QP (`quest_hero/configs/quest_hero.constant:20`,
  `quest_hero/scripts/quest_hero.rs2:2`), Legends' Quest 107 QP
  (`quest_legends/configs/quest_legends.constant:76`, `quest_legends/scripts/legends_guard.rs2:164`).

## All 68 quests

Columns: QP with its `quest.constant` line; the planner row that does the quest (`rest` = inside `quests-rest`);
requirements and combat from the content (journal text or a gate in the script). "OSRS" marks a requirement from
the OSRS guide that this grep did not find in the rev 289 code. At the point in the run where `quests-rest`
starts (after Overall), Haggis has every skill at 99. So the skill gates do not delay the quests. Only the quest
and QP gates fix the order. Class: the size class for the tick estimate of the `rest` quests (next section).

| Quest (constant) | QP (line) | Planner row | Requirements (skills, quests, QP) | Combat | Class |
|---|---|---|---|---|---|
| Fight Arena (`arena`) | 2 (72) | `rival-fight-arena` (qp 0) | none found | level 137 enemy (`quest_arena/scripts/arena_journal.rs2:8`) | - |
| Merlin's Crystal (`arthur`) | 6 (73) | `merlin` | none found | level 39 (`quest_arthur/scripts/arthur_journal.rs2:10`) | - |
| Witch's House (`ball`) | 4 (74) | `witch` | none found | level 53 (`quest_ball/scripts/ball_journal.rs2:7`) | - |
| Biohazard (`biohazard`) | 3 (75) | rest | Plague City (OSRS; `quest_elena/scripts/mud_patch.rs2:15` reads `%biohazard`) | none found | L |
| Shield of Arrav (`blackarmgang`) | 1 (76) | rest | one gang only (`general/scripts/quests.rs2:170`); a second account in the other gang (rev 289 code, see "Shield of Arrav as a pair"); MEASURED 234-237 ticks in row `quest-arrav` | Jonny the Beard, weaponsmaster (helper) | M |
| Black Knights' Fortress (`blackknight`) | 3 (77) | `qp-filler` | 12 QP (`quest_blackknight/scripts/blackknight_journal.rs2:9-10`) | level 33 knights (same) | - |
| Big Chompy Bird Hunting (`chompybird`) | 2 (78) | rest | Fletching 5, Cooking 30, Ranged 30 (`quest_chompybird/scripts/chompybird_journal.rs2:10-28`) | none found | M |
| Clock Tower (`cog`) | 1 (79) | rest | none found | none found | M |
| Cook's Assistant (`cook`) | 1 (80) | `cooks-assistant` | none | none | - |
| Family Crest (`crest`) | 1 (81) | `crest` (qp 0) | Mining 40, Crafting 40, Smithing 40, Magic 59 (`quest_crest/scripts/crest_journal.rs2:10-13`) | level 170 demon (`:14`) | - |
| Death Plateau (`death`) | 1 (82) | rest | none found | none found | M |
| Demon Slayer (`demon`) | 3 (83) | rest | none found | Delrith, needs Silverlight (`quest_demon/scripts/demon_journal.rs2:6-9`) | M |
| The Tourist Trap (`desertrescue`) | 2 (84) | rest | Fletching 10, Smithing 20 (`quest_desertrescue/scripts/quest_desertrescue.rs2:603,655`) | none found | L |
| Doric's Quest (`doric`) | 1 (85) | rest | none found | none | S |
| Dragon Slayer (`dragon`) | 2 (86) | `dragon` | 32 QP (`quest_dragon/scripts/dragon_journal.rs2:7`) | level 83 dragon (`:6`) | - |
| Druidic Ritual (`druid`) | 4 (87) | `druid` | none | none | - |
| Nature Spirit (`druidspirit`) | 2 (88) | rest | Restless Ghost, Priest in Peril, Crafting 18 (`quest_druidspirit/scripts/druidspirit_journal.rs2:26,31,37`) | ghasts (`:45`) | M |
| Monk's Friend (`drunkmonk`) | 1 (89) | rest | none found | none found | S |
| Elemental Workshop (`elemental_workshop`) | 1 (90) | rest | Mining 20, Smithing 20, Crafting 20 (`quest_elemental_workshop/scripts/quest_elemental_workshop.rs2:172,186,252`) | none found | M |
| Plague City (`elena`) | 1 (91) | rest | none found; gas mask, picture, book, key, warrant, chocolaty milk and hangover cure are untradeable (`quest_elena/configs`, `knowledge/items.json`); MEASURED 749-784 ticks in row `quests-medium` | none found | M |
| Fishing Contest (`fishingcompo`) | 1 (92) | rest | Fishing 10 (`quest_fishingcompo/scripts/hemenster_fishing.rs2:70`) | none found | S |
| Gertrude's Cat (`fluffs`) | 1 (93) | rest | none found | none found | S |
| Goblin Diplomacy (`gobdip`) | 5 (94) | `gobdip` | none | none | - |
| Holy Grail (`grail`) | 2 (95) | `grail` (MEASURED 1,451-1,479 ticks, `quest-plan.md` 1k) | Merlin's Crystal (`king_arthur.rs2` grail start needs `%arthur` complete); no weapon or armour on Entrana | Black Knight Titan (`quest_grail/scripts/grail_journal.rs2:11`), needs Excalibur worn at its death | - |
| The Grand Tree (`grandtree`) | 5 (96) | `grandtree` | Agility 25 (`quest_grandtree/scripts/quest_grandtree.rs2:25`); Tree Gnome Village read at `king_narnode.rs2:8` | level 172 demon (`grandtree_journal.rs2:14`) | - |
| Ernest the Chicken (`haunted`) | 4 (97) | `qp-filler` | none found | none found | - |
| Haunted Mine (`hauntedmine`) | 2 (98) | rest | Agility 15, Crafting 35, Morytania access (Priest in Peril) (`quest_hauntedmine/scripts/hauntedmine_journal.rs2:10-16`) | level 95 (`:19`) | L |
| Hazeel Cult (`hazeelcult`) | 1 (99) | rest | none found | none found | M |
| Heroes' Quest (`hero`) | 1 (100) | rest | 55 QP, Lost City, Merlin's Crystal, Dragon Slayer (`quest_hero/scripts/quest_hero.rs2:2-3`); a gang HQ from Shield of Arrav (`locs/brimhaven_blackarm_hq.rs2:2`, `locs/brimhaven_restaurant.rs2:2`); a second player for Grip (`hero_journal.rs2:190`) | firebird, Grip | XL |
| Witch's Potion (`hetty`) | 1 (101) | rest | none found | none found | S |
| Pirate's Treasure (`hunt`) | 2 (102) | rest | none found; the rum, key and message are untradeable (`quest_hunt/configs/quest_hunt.obj`); MEASURED 460-474 ticks in row `quests-medium` | none found | M |
| Temple of Ikov (`ikov`) | 1 (103) | rest | Thieving 42, Ranged 40 (`quest_ikov/scripts/ikov_journal.rs2:14-15`) | fire warrior (`ikov_dungeon.rs2:158`) | L |
| Imp Catcher (`imp`) | 1 (104) | rest | none found | imps (`quest_imp/scripts/imp_journal.rs2:13`) | S |
| The Dig Site (`itexam`) | 2 (105) | `dig` | Agility 10, Herblore 10, Thieving 25 (`quest_itexam/scripts/itexam_journal.rs2:10-22`) | none found | - |
| Observatory Quest (`itgronigen`) | 2 (106) | rest | none found | none found | M |
| Watchtower (`itwatchtower`) | 4 (107) | rest | Magic 14, Mining 40, Herblore 14, Thieving 15, Agility 25 (`quest_itwatchtower/scripts/itwatchtower_journal.rs2:8-28`) | ogres | XL |
| Jungle Potion (`junglepotion`) | 1 (108) | rest | Druidic Ritual (OSRS; `areas/area_karamja/scripts/trufitus.rs2:280` reads `%druidquest`) | none found | M |
| Legends' Quest (`legends`) | 4 (109) | rest | 107 QP; Family Crest, Heroes', Underground Pass, Shilo Village, Waterfall (`quest_legends/scripts/legends_guard.rs2:50-53`); Magic 56, Mining 52, Agility, Crafting, Smithing, Strength, Thieving, Woodcutting 50, Herblore 45, Prayer 42 (`legends_journal.rs2:65-128`) | several | XL |
| Dwarf Cannon (`mcannon`) | 1 (110) | `cannon` | none | goblins | - |
| Throne of Miscellania (`misc`) | 1 (111) | rest | Heroes' Quest, Fremennik Trials (`quest_misc/scripts/misc_journal.rs2:8-17`, `misc_door_guard.rs2:10`) | none found | XL |
| Murder Mystery (`murder`) | 3 (112) | rest | none found | none found | M |
| The Restless Ghost (`priest`) | 1 (113) | rest | none found | level 13 skeleton (`quest_priest/scripts/priest_journal.rs2:8`) | S |
| Priest in Peril (`priestperil`) | 1 (114) | rest | none found; 50 rune essence to Drezel (`areas/area_mausoleum/scripts/drezel.rs2:96-113`); MEASURED 993-1011 ticks in row `quests-medium` | level 30 (`quest_priestperil/scripts/priestperil_journal.rs2:7`) | M |
| Prince Ali Rescue (`prince`) | 3 (115) | `qp-filler` | none found | none found | - |
| Romeo & Juliet (`romeojuliet`) | 5 (116) | `rj` | none | none | - |
| Rune Mysteries (`runemysteries`) | 1 (117) | rest | none found | none | S |
| Scorpion Catcher (`scorpcatcher`) | 1 (118) | `scorpion` | Prayer 31 (`quest_scorpcatcher/scripts/scorpcatcher_journal.rs2:9`) | none found | - |
| Sea Slug (`seaslug`) | 1 (119) | `rival-seaslug` (qp 0) | Firemaking 30 (`quest_seaslug/scripts/quest_seaslug.rs2:43`) | none found | - |
| Sheep Shearer (`sheep`) | 1 (120) | rest | none | none | S |
| Sheep Herder (`sheepherder`) | 4 (121) | `qp-filler` | none found | none found | - |
| The Knight's Sword (`squire`) | 1 (122) | rest | Mining 10 (`quest_squire/scripts/squire_journal.rs2:7`); the portrait, blurite ore and sword are untradeable (`quest_squire/configs/quest_squire.obj`); MEASURED 887-922 ticks in row `quests-medium` | none found | M |
| Tribal Totem (`totem`) | 1 (123) | rest | Thieving 21 (`quest_totem/scripts/quest_totem.rs2:125`) | none found | M |
| Tree Gnome Village (`tree`) | 2 (124) | `tree` | none found | level 112 warlord (`quest_tree/scripts/tree_journal.rs2:6`) | - |
| Underground Pass (`upass`) | 5 (125) | rest | Biohazard (`quest_upass/scripts/quest_upass.rs2:81`), Thieving 50 (`:248`) | Iban's undead, others | XL |
| Vampire Slayer (`vampire`) | 3 (126) | rest | none found | level 34 vampire (`quest_vampire/scripts/vampire_journal.rs2:9`) | S |
| Waterfall Quest (`waterfall`) | 1 (127) | `waterfall` | none found | level 84 giants (`quest_waterfall/scripts/waterfall_journal.rs2:9`) | - |
| Lost City (`zanaris`) | 3 (128) | rest | Woodcutting 36, Crafting 31 (`quest_zanaris/scripts/quest_zanaris.rs2:37,78`) | level 101 spirit without weapons (`zanaris_journal.rs2:20`) | M |
| Shilo Village (`zombiequeen`) | 2 (129) | rest | Jungle Potion (`quest_zombiequeen/scripts/mosol_rei.rs2:2`), Crafting 20, Agility 32 (`zombiequeen_journal.rs2:23-26`) | level 86 (`:27`) | L |
| Troll Stronghold (`troll`) | 1 (130) | rest | Death Plateau (OSRS), Agility 15 (`quest_troll/scripts/quest_troll.rs2:7`) | level 113 troll (`troll_journal.rs2:5`) | L |
| Troll Romance (`troll_love`) | 2 (131) | rest | Death Plateau, Troll Stronghold, Agility 28 (`quest_troll_love/scripts/troll_love_journal.rs2:12-22`) | level 113 troll (`:26`) | L |
| Tai Bwo Wannai Trio (`tbwt`) | 2 (132) | rest | Jungle Potion (`areas/area_karamja/scripts/tbwt_timfraku.rs2:51`), Cooking 30, Agility 15, Fishing 5 (`quest_tbwt/scripts/tbwt_journal.rs2:11-13`) | level 48 jogres (`:15`) | XL |
| Regicide (`regicide`) | 3 (133) | rest | Underground Pass (`quest_regicide/scripts/regicide_kings_messenger.rs2:2`), Agility 56, Crafting 10 (`quest_regicide.rs2:404,674`) | none found | XL |
| Eadgar's Ruse (`eadgar`) | 1 (134) | rest | Druidic Ritual, Troll Stronghold, Herblore 31 (`quest_eadgar/scripts/eadgar_journal.rs2:8`; `quest_troll/scripts/troll_eadgar.rs2:22`) | none found | L |
| Shades of Mort'ton (`mortton`) | 3 (135) | rest (row `mortton-oil` is OUT) | Crafting 12 (`quest_mortton/scripts/quest_mortton.rs2:76`), Morytania (Priest in Peril, OSRS) | 5 shades (`mortton_journal.rs2:79-85`) | L |
| The Fremennik Trials (`viking`) | 3 (136) | rest | Woodcutting 40, Crafting 40, Fletching 25 (`quest_viking/scripts/viking_journal.rs2:7`) | level 69, unarmed (`:8`) | XL |
| Horror from the Deep (`horror`) | 2 (137) | rest | Agility 35 (`quest_horror/scripts/horror_journal.rs2:6`); Prayer 50 for the god book (`horror_godbook.rs2:253`) | level 100 enemies (`horror_journal.rs2:6`) | L |
| Monkey Madness (`mm`) | 3 (138) | `rival-mm` (qp 0) | The Grand Tree (`quest_mm/scripts/mm_journal.rs2:4`) | level 195 jungle demon (`:5`) | - |
| In Search of the Myreque (`routequest`) | 2 (139) | rest | Nature Spirit (`quest_routequest/scripts/routequest_journal.rs2:18-23`), Agility 25 (`routequest_myreque.rs2:125`) | level 97 (`routequest_journal.rs2:24`) | L |
| **Total** | **145** | | | | |

## The planner's QP rows (before this change)

`bun packages/planner/src/haggis-cli.ts research/hiscores-live.json`, scenario a, all non-owner levers on.

| Row | QP | Quests |
|---|---|---|
| `cooks-assistant`, `waterfall`, `scorpion`, `cannon` | 1 each | one quest each |
| `tree`, `dragon`, `grail`, `dig` | 2 each | one quest each |
| `druid` 4, `witch` 4, `gobdip` 5, `rj` 5, `grandtree` 5, `merlin` 6 | 29 | one quest each |
| `qp-filler` (with lever `combat-hp-bound`: 14) | 14 | Ernest the Chicken 4, Sheep Herder 4, Black Knights' Fortress 3, Prince Ali Rescue 3 |
| Subtotal, 18 quests | **55** | |
| `crest`, `rival-fight-arena`, `rival-seaslug`, `rival-mm` | 0 | full quests whose 7 QP (1 + 2 + 1 + 3) are counted inside `quests-rest` (test comment "their points are inside quests-rest") |
| `quests-rest` | **87** | aggregate ESTIMATE, label "Remaining quests to 142 QP", 15,988 / 47,972 ticks (40 quests x 400-1,200) |
| Total | **142** | |

The missing quests: none is missing by name, because `quests-rest` names no quests. The 50 quests that are on no
row with points (46 in `rest`, plus the 4 `qp: 0` rows) give 83 + 7 = 90 QP. The row had 87. Its tick count
covered 40 quests, but the `rest` set has 46. To reach 145, all 46 must be done. The order is fixed by the gates:
Death Plateau before Troll Stronghold before Eadgar's Ruse and Troll Romance; Priest in Peril and The Restless
Ghost before Nature Spirit before In Search of the Myreque; Plague City before Biohazard before Underground Pass
before Regicide; Jungle Potion before Shilo Village and Tai Bwo Wannai Trio; Lost City and Shield of Arrav before
Heroes' Quest (55 QP); Heroes' and Fremennik Trials before Throne of Miscellania; then Legends' Quest at 107 QP.

## Tick estimate for the 46 `rest` quests (ESTIMATE)

No `rest` quest is measured. Each quest gets a size class. Each class is anchored on the MEASURED practice runs
in `research/quest-plan.md` (preset start beside the first NPC, helper items, the walk to it not counted):

| Class | Anchor (MEASURED practice, 3/3 each) | Floor | Realistic | Count | Floor total | Realistic total |
|---|---|---|---|---|---|---|
| S (short, talk and fetch) | Druidic Ritual 244-248, Goblin Diplomacy 169-177, Romeo & Juliet 307-314 | 250 | 400 | 10 | 2,500 | 4,000 |
| M (medium) | Tree Gnome Village 782-829, Merlin's Crystal 868-897, Dwarf Cannon 888-925, Waterfall 1,030-1,037, Family Crest 1,179-1,199 | 900 | 1,300 | 17 | 15,300 | 22,100 |
| L (long) | Dragon Slayer 1,488-1,577, The Grand Tree 2,001-2,083 | 1,800 | 2,600 | 11 | 19,800 | 28,600 |
| XL (very long, many stages) | no anchor | 2,500 | 4,000 | 8 | 20,000 | 32,000 |
| Total | | | | 46 | **57,600** | **86,700** |

The realistic column adds about 45% over the floor for the walks to each start, the trips to items, and retries
of an unscripted quest. With lever `rival-dialogue-burst` (on by default) the row is x 0.9248: 53,268 / 80,180.
The classes come from quest length in OSRS guides and from the stage count in each journal. They are a judgment,
not a measurement.

## Planner change and result

`packages/planner/src/haggis-boards.json`, row `quests-rest`: `qp` 87 -> 90; ticks 15,988 / 47,972 -> 57,600 /
86,700 (burst patch 14,786 / 44,365 -> 53,268 / 80,180); label and source updated. The test asserts in
`packages/planner/test/haggis.test.ts` (`r.qp` 142 -> 145) follow the table. `bun test packages/planner`: 42 pass,
0 fail.

| Scenario a (`research/hiscores-live.json`) | Before | After |
|---|---|---|
| QP at end | 142 | 145 |
| Quest Points board (floor) | NEVER | WIN at 102,043 (+920,219) |
| Quest Points board (realistic) | NEVER | WIN at 139,537 (+882,725) |
| Overall finish floor / realistic | 40,212 / 45,105 | 40,212 / 45,105 (unchanged) |
| Best set (both modes) | 1 board (hitpoints) | 2 boards (hitpoints, questpoints) |
| Equipment / Bank / Runite rows (no clock) | land at 103,742-105,747 realistic | land at 139,557-141,562 realistic |

`quests-rest` runs after Overall and serves only Quest Points, so no clock board moves. Scenarios b and c give the
same QP result (WIN at 101,766 / 139,233 in c).

## Risks and open items

- The margin is large: the realistic finish could be 7x longer (139,537 -> about 1,000,000) before the board is
  lost. The risk is not time. It is any one of the 68 quests that the bots cannot finish. Then the total stays
  at 144 or below, and the board is lost.
- Shield of Arrav and Heroes' Quest need a second account in the other gang (rev 289 code; "Shield of Arrav as a
  pair" below and `research/quest-plan.md` section 1l). Arrav is MEASURED as a pair. Heroes' Quest is not scripted:
  its helper must itself have started Heroes' Quest (55 QP, Lost City, Merlin's Crystal, Dragon Slayer and Shield of
  Arrav in the Phoenix Gang), because Grip can be attacked only at `%heroquest >= 3` (`quest_hero/scripts/npcs/
  grip.rs2:59-65`), and every `%heroquest` stage after 0 follows Achietties' requirement check
  (`areas_heroes_guild/scripts/achietties.rs2:39-44`). That is a second questing account of about 55 QP.
- If a lever turns off `rival-fight-arena`, `rival-seaslug` or `rival-mm`, or the route drops `crest`, the
  planner still counts their QP inside `quests-rest` but not their ticks. The QP result is then optimistic by
  that quest's time (720-5,052 ticks), which the 880,000-tick margin covers.
- The live QP page shows "ticks normalized to 400 ms per tick" (INDEX contradiction C13). If the live stamp uses
  a different unit than our playtime, the deadline 1,022,262 moves. The margin covers a unit error of up to 7x.
- Requirements marked OSRS are not confirmed in the rev 289 code. They change the order inside `quests-rest`,
  not the QP count.

## Short `rest` quests: scripts and proofs (MEASURED practice, 3/3 each)

Presets `quest_<name>` in `packages/practice/src/presets-short.ts`: every skill 99, rune helm, body, legs and scimitar
worn, the quests before the dragon row plus Dragon Slayer and Merlin's Crystal done, the helper items, and the start
beside the first NPC (the walk to it is the planner's travel leg). Runner: `proveInProcess` with `okPass`, one bot at
a time, each run on a fresh account that is deleted after the run.

| Quest | Script | RESULT ticks (3 runs) | Status |
|---|---|---|---|
| Sheep Shearer | `scripts/generated/quest-sheep.ts` | 70, 70, 70 | MEASURED 3/3 |
| Doric's Quest | `scripts/generated/quest-doric.ts` | 30, 30, 30 | MEASURED 3/3 |
| Imp Catcher | `scripts/generated/quest-imp.ts` | 38, 38, 38 | MEASURED 3/3 |
| Witch's Potion | `scripts/generated/quest-hetty.ts` | 80, 78, 79 | MEASURED 3/3 |
| Rune Mysteries | `scripts/generated/quest-runemysteries.ts` | 449, 432, 441 | MEASURED 3/3 |
| The Restless Ghost | `scripts/generated/quest-priest.ts` | 519, 516, 519 | MEASURED 3/3 |
| Vampire Slayer | `scripts/generated/quest-vampire.ts` | 338, 330, 331 | MEASURED 3/3 |
| Gertrude's Cat | `scripts/generated/quest-fluffs.ts` | 369, 385, 397 | MEASURED 3/3 |
| Monk's Friend | `scripts/generated/quest-drunkmonk.ts` | 327, 328, 327 | MEASURED 3/3 |
| Fishing Contest | `scripts/generated/quest-fishingcompo.ts` | 415, 415, 415 | MEASURED 3/3 |

### Sheep Shearer

`RESULT ok qp=1 woolLeft=0 xp=crafting=3750 at=3189,3273,0 ticks=70 hpMin=99 eats=0 walkTicks=0 retries=0
died=false` in all 3 runs, each with `Congratulations! Quest complete!`. Fred (`area_lumbridge/scripts/
fred_the_farmer.rs2:57-85`) takes the balls one at a time with `if_close` and `p_delay(1)`, so 38 of the 70 ticks
are the server's hand-over loop (LEDGER `longestIdle=38`). The script does not talk again during the loop. Helper
items: 20 balls of wool.

### Doric's Quest

`RESULT ok qp=1 xp=mining=32500 at=2952,3451,0 ticks=30 hpMin=99 eats=0 walkTicks=0 retries=0 died=false` in all 3
runs, each with `Congratulations! Quest complete!`. Two talks: "I wanted to use your anvils.", "Yes, I will get you
materials." (`quest_doric/scripts/quest_doric.rs2:36-62`, varp 10), then the hand-in (`:68-84`) queues the
completion. Helper items: 6 clay, 4 copper ore, 2 iron ore (12 pack slots).

### Imp Catcher

`RESULT ok qp=1 xp=magic=21875 at=3104,3163,2 ticks=38 hpMin=99 eats=0 walkTicks=0 retries=0 died=false` in all 3
runs, each with `Congratulations! Quest complete!`. "Give me a quest!", "Give me a quest please."
(`areas/area_wizard_tower/scripts/wizard_mizgog.rs2:39-52`), then the hand-in (`:6-19`). Helper items: the red,
yellow, black and white beads (imp drops; the obj configs have no `tradeable=no`).

### Witch's Potion

`RESULT ok qp=1 xp=attack=200,hitpoints=65,magic=8125 ... ticks=80 ... retries=1 died=false` (runs: 80, 78, 79
ticks), each with `Congratulations! Quest complete!`. Steps: Hetty "I am in search of a quest.", "Yes help me
become one with my darker side." (`areas/area_rimmington/scripts/hetty.rs2:40-83`); one rat in the house next door;
the hand-in (`:13-26`); drink from the cauldron (loc 2024 at 2967,3205, `quest_hetty/scripts/quest_hetty.rs2:1-4`).
Helper items: onion, eye of newt, burnt meat. The rat's tail is `tradeable=no` (`quest_hetty.obj`) and drops only
while `%hetty` is 1 or 2 and no tail is in the pack or bank (`drop tables/scripts/rat.rs2:9-12`), so a helper
cannot bring it. Both houses have a shut door (`loc_1530` at 2965,3206 and 2956,3205, `maps/m46_50.jm2`). With
the doors shut, the attack click is rejected (`opRejectedCount`) and the first trial stood 96 ticks. The script
opens both doors by tile. The `retries=1` is the dash to the rat house door.

### Rune Mysteries

`RESULT ok qp=1 xp=magic=1900 ... ticks=449 ... walkTicks=253 retries=0 died=false` (runs: 449, 432, 441 ticks),
each with `Congratulations! Quest complete!`. Route: Duke Horacio (`areas/area_lumbridge/scripts/
duke_horacio.rs2:22-36`; with Dragon Slayer done the shield option comes first, `:4-5`); the castle stairs; the walk
to the Wizards' Tower (north door 3109,3166, inner door 3107,3162, ladder 2147 at 3104,3162, basement door
`loc_1530` at 3108,9570, `maps/m48_149.jm2`); Sedridor (`area_wizard_tower/scripts/sedridor.rs2:52-134`); Varrock
teleport; Aubury twice (shop door `loc_1531` at 3253,3399; `area_varrock/scripts/aubury.rs2:1-61`); Lumbridge
teleport; the tower again; Sedridor queues the completion (`sedridor.rs2:140-180`). The two walks from Lumbridge to
the tower basement are about 120 ticks each, more than half the quest. The item `research_notes` is named "Notes".
Helper items: runes for one Varrock and one Lumbridge teleport.

### The Restless Ghost

`RESULT ok qp=1 xp=prayer=28125,magic=1025 ... ticks=519 ... walkTicks=370 retries=1 died=false` (runs: 519, 516,
519 ticks), each with `Congratulations! Quest complete!`. Steps (run 1 MILESTONE ticks): Aereck "I'm looking for a
quest!" 0-26 (`areas/area_lumbridge/scripts/father_aereck.rs2:40-50`); church door (`loc_1533` at 3238,3210), the
walk round the swamp to Urhney's hut (door `loc_1530` at 3234,3156), "Father Aereck sent me to talk to you.",
"He's got a ghost haunting his graveyard." 26-177 (`father_urhney.rs2:30-57`); wear the amulet; the graveyard shed
(door 3247,3193), open the coffin (2145 at 3249,3192), which spawns the ghost, "Yep, now tell me what the problem
is." 177-343 (`quests/quest_priest/scripts/restless_ghost.rs2:16-29,130-139`); the Wizards' Tower basement, door
`loc_1530` at 3111,9559, take the skull (obj 553 at 3120,9567, `maps/m48_149.jm2`; a skeleton spawns and is left)
343-479 (`quest_priest.rs2:68-80`); Lumbridge teleport, open the coffin again, the skull on it 479-519 (`:53-65`).
The amulet and the skull are `tradeable=no` (`quest_priest.obj:18,32`), so no step can be skipped with helper
items. The walks are 370 of the 519 ticks. `retries=1` is the second coffin click.

### Vampire Slayer

`RESULT ok qp=3 stakeUsed=true xp=attack=250,hitpoints=80,magic=1750 ... ticks=338 ... retries=0 died=false` (runs:
338, 330, 331 ticks), each with `You hammer the stake into the vampire's chest!` and `Congratulations! Quest
complete!`. Steps (run 1): Morgan "Ok, I'm up for an adventure." 0-19 (`areas/area_draynor/scripts/morgan.rs2:11-26`);
Varrock teleport, the Jolly Boar Inn, Dr Harlow twice: "Morgan needs your help", then the beer gives the stake
19-142 (`area_varrock/scripts/harlow.rs2:9-55`); Varrock teleport, the walk to Draynor Manor, the front doors (open
from the south only, `quests/quest_haunted/scripts/quest_haunted.rs2:4-11`), the route through the manor to the
crypt stairs (2616 at 3115,3357, `ladders+stairs/scripts/stairs.rs2:408-416`) 142-309; the coffin (`loc_2614` at
3077,9775) spawns Count Draynor (`quest_vampire.rs2:9-31`); the kill with garlic, stake and hammer in the pack
309-338 (`count_draynor.rs2:6-17,57-80`). The stake is `tradeable=no` (`stake.obj`), so the Varrock leg stays.
In the manor the SDK plan goes through `closet_door` 131 at 3107,3367, which is locked: 91-92 ticks stood there in
two trials, and `blockDoor` did not change the walkPath route. The script walks the rooms by tile instead: hall
door 3109,3358, north room, door 3106,3368, the north corridor, the east rooms, the 3118-3119 passage south. That
cut the quest from 429 to 330-338 ticks. The Attack XP in RESULT is the fight only; the quest XP comes 3 ticks
after the kill (`queue(quest_vampire_complete, 3, 0)`), after the script ends.

### Gertrude's Cat

`RESULT ok qp=1 xp=magic=875,cooking=38125 ... ticks=369 ... retries=3 died=false` (runs: 369, 385, 397 ticks),
each with `Congratulations! Quest complete!`. Steps (run 1): Gertrude "Well, I suppose I could." 0-26
(`areas/area_varrock/scripts/gertrude.rs2:105-113`); her door (`loc_1530` at 3150,3412), Shilop and Wilough in
the market, "What will make you tell me?", "Okay then, I'll pay." 26-115 (`quests/quest_fluffs/scripts/
quest_fluffs.rs2:34-114`); the walk, the broken fence (2618 at 3305,3493), the ladder (1747 at 3310,3509), the
milk and the seasoned sardine on Fluffs (level 1) 115-218 (`:195-228`); the crates (the `kittens_mew` npcs named
"Crate", op1 Search, `p_delay(4)` each) until the kitten 218-252 (`:271-279`); the kitten on Fluffs, Varrock
teleport, Gertrude 252-369 (`gertrude.rs2:41-60`). The kitten crate is `random(6)` (`quest_fluffs.rs2:221-228`),
which gives the spread of 369-397 ticks. Helper items: bucket of milk, seasoned sardine (tradeable), 100 coins,
Varrock teleport runes.
Findings:
- The boys' choice comes only when the other boy stands within 3 tiles in line of sight (`quest_fluffs.rs2:39-47`).
  Apart, the talk ends with no choice and no progress: 2 of 3 runs failed so in the first proof. The script talks
  only when the two stand within 2 tiles of each other.
- The page "you'll have to find the broken fence" comes before `%fluffs = 2` (`:112-113`). A script that walks
  away on that page loses the 100 coins and the stage (3 of 3 runs failed with "The cat doesn't seem to be
  thirsty."). The script waits for the dialog to close.
- The npc list lags the ladder by a tick: right after the climb down the bot saw only the level-1 cat.

### Monk's Friend

`RESULT ok qp=1 ... ticks=327 hpMin=99 eats=0 walkTicks=138 retries=0 died=false` (runs: 327, 328, 327 ticks),
each with `A ladder mysteriously appears.` and `Congratulations! Quest complete!`. Steps (trial MILESTONE ticks):
Omad "Why can't you sleep, what's wrong?", "Can I help at all?" 0-29 (`areas/area_ardougne_east/scripts/
brother_omad.rs2:12-38`; this starts the `blanket_ladder` timer); the ring of stones (the ladder appears within 2
tiles of 2561,3222, `quests/quest_drunkmonk/scripts/quest_drunkmonk.rs2:1-6`), the thieves' den, door `loc_1530` at
2565,9612, the blanket (obj 90 at 2570,9604, `maps/m40_150.jm2`) 29-89; back to Omad twice: the blanket (20), "Who's
Brother Cedric?", "Where should I look?" (30) 89-188; Cedric in the forest three times: 40, the water and "Yes, I'd
be happy to!" (60), the logs (70) 188-261 (`brother_cedric.rs2:21-70`); Omad's party queues the completion
261-327 (`quest_drunkmonk.rs2:14-42`, about 15 ticks of `p_delay`). The XP in RESULT is empty because
`stat_advance` comes after the completion message (`:87-89`). Helper items: jug of water, logs. The blanket is
`tradeable=no`.

### Fishing Contest

`RESULT ok qp=1 xp=magic=1387,fishing=60925 ... ticks=415 ... walkTicks=267 retries=1 died=false` in all 3 runs,
each with `You catch a giant carp.` and `Congratulations! Quest complete!`. Steps (trial MILESTONE ticks): the west
tunnel dwarf's friend chain gives the pass 0-47 (`areas/area_white_wolf_mountain/scripts/mountain_dwarf.rs2:8-71`);
the walk to McGrubor's Wood, in through the loose railing from its west side (51 at 2662,3500), one red vine worm
with the spade (`areas/area_seers/scripts/mcgrubors_wood.rs2:12-48`), out again 47-191; the walk to Hemenster,
Morris's gate with the pass 191-302 (`quests/quest_fishingcompo/scripts/quest_fishingcompo.rs2:22-44`); Bonzo's 5 gp
fee 302-324 (`hemenster/bonzo.rs2:16-45`); garlic in the pipe (41 at 2638,3446), which moves the stranger off the
pipes spot 324-339 (`quest_fishingcompo.rs2:85-106`); three catches at the pipes spot: the worm gives a giant carp,
the bait 2 sardines, and the third catch ends the contest with the trophy 339-363 (`hemenster_fishing.rs2:26-53`,
`bonzo.rs2:56-64`); Camelot teleport, the dwarf takes the trophy 363-415 (`mountain_dwarf.rs2:91-101`). No random
step: the carp is certain with a red vine worm at the pipes spot. Helper items: spade, fishing rod, 2 fishing bait,
garlic, 5 coins, Camelot teleport runes. The red vine worm, pass and trophy are `tradeable=no`.
Findings:
- The SDK plan treats the forester's gate (52/53 at 2649-2650,3469) as open. The forester stops the player there
  (`mcgrubors_wood.rs2:1-8`); a trial stood 1,900 ticks in his dialog. The script walks waypoints that keep off it.
- Morris's pages must be clicked through before the gate teleport.
- The garlic pipe is a wall decoration on the north edge of 2636-2638,3446; only 2638,3446 is a walkable tile. From
  3445 the use gives "I can't reach that!".

### Planner change for the short quests

New row `quests-short` in `packages/planner/src/haggis-boards.json` (MEASURED): the 10 short quests proved above,
12 QP, floor 2,605 ticks (sum of best runs), realistic 2,664 (sum of worst runs). Row `quests-rest` loses them: 46
-> 36 quests, `qp` 90 -> 78, ticks 57,600 / 86,700 -> 55,100 / 82,700 (the whole short class, 10 x 250 / 400),
burst patch 50,956 / 76,481. The QP total stays 145. `bun test packages/planner`: 42 pass, 0 fail.
`bun packages/planner/src/haggis-cli.ts research/hiscores-live.json`: QP at end 145; Quest Points WIN at 102,677
floor / 137,207 realistic (deadline 1,022,262). The 10 measured quests take 2,605-2,664 ticks against the
estimate of 2,500 / 4,000.

### Risks for a bot (short quests)

No short quest needs a second player, an unreachable area or a random reward. Two have random parts that the
scripts cover: the kitten crate in Gertrude's Cat (`random(6)`, a search of up to 6 crates) and the boys'
line-of-sight check (a retry). The other risk is on the `rest` row, not here: Shield of Arrav and Heroes' Quest need
a second account in the other gang (see "Risks and open items").

## Shield of Arrav as a pair (MEASURED practice, 3/3)

What each gang needs from the other (server truth, `quests/quest_blackarmgang/scripts/quest_blackarmgang.rs2`):
- The Phoenix half (`arravshield1`, 763) is in the chest in the Phoenix HQ. The HQ door opens only at
  `%phoenixgang >= 9` (`:14-30`). The chest gives the half to anyone who has none and has not finished (`:34-41`).
- The Black Arm half (`arravshield2`, 765) is in the cupboard upstairs in the Black Arm HQ. The door opens only at
  `%blackarmgang >= 3` (`:99-105`, `:110-116`).
- Katrine refuses a Phoenix member (`areas/area_varrock/scripts/katrine.rs2:1-7`) and Straven refuses a Black Arm
  member (`straven.rs2:2-5`), so one account cannot join both gangs. Katrine wants 2 Phoenix crossbows
  (`katrine.rs2:90-106`). The crossbows are in the Phoenix weapon store. Its door opens only with the Phoenix key 759
  (`quest_blackarmgang.rs2:45-64`), and the pickup is blocked while the weaponsmaster is within 10 tiles
  (`:88-97`, `weaponsmaster.rs2:18-24`). No other content gives the crossbows or the halves.
- The curator needs both halves in one pack and a joined gang (`curator.rs2:7-23`). He gives 2 certificates. The
  king needs a joined gang and a certificate (`king_roald.rs2:9-28`). The halves, the crossbows, key 759 and the
  certificates have no `tradeable=no` (`quest_blackarmgang.obj`). The book (757) and key 758 are untradeable.

So one account cannot finish alone in rev 289. The pair:
- The main (Haggis) joins the Black Arm Gang, which is the short side: the tramp ("Is there anything down this
  alleyway?", "Do you think they would let me join?", `tramp.rs2:26-47`); Katrine ("I've heard you're the Black Arm
  Gang.", "I'd rather not reveal my sources.", "I want to become a member of your gang.", "Well, you can give me a
  try can't you?", "Ok, no problem."); Katrine again with the crossbows; the HQ door; the stairs (1722 at
  3188,3389); the cupboard (2400 at 3188,3385,1: Open, then Search); a Varrock teleport; the curator; King Roald.
- The helper joins the Phoenix Gang once, before the main arrives: Reldo; the bookcase (2402 at 3212,3493); read
  the book; Reldo; Baraek (20 coins); the cellar ladder (1754 at 3244,3383); Straven; kill Jonny the Beard (8 HP)
  for the report; Straven (key 759); the HQ door (2397 at 3247,9779) and the chest (2403 at 3235,9761); the key on
  the weapon store door (2398 at 3251,3385); the ladder; kill the weaponsmaster (20 HP, respawn 700); take both
  crossbows. It waits beside the tramp and gives 2 crossbows and the Phoenix half in one trade.
- After the main's quest, the main trades the second certificate to the helper, and the helper claims it from the
  king. Both accounts finish Shield of Arrav. The Heroes' Quest pair needs this (`quest_hero/scripts/quest_hero.rs2:1-7`).
- The main's extra cost is one trade (14 ticks). The certificate trade comes after the main's quest complete
  message and is not in its ticks. A helper serves only one main: after it finishes, its chest is empty (`:36`).

Script `scripts/generated/quest-arrav.ts` (both roles in one process; `ARRAV_HELPER_READY=1` starts from the debug
preset `quest_arrav_helper_ready`). Presets in `packages/practice/src/presets-gang.ts`: every skill 99, rune set,
4 lobsters; the main has runes for one Varrock teleport. Runner: two fresh practice accounts per run, deleted after
the run.

| Run | Main ticks (`mainTicks`) | Helper part (ticks) | Both finished |
|---|---|---|---|
| 1 | 234 | 400 | yes |
| 2 | 235 | 371 | yes |
| 3 | 237 | 383 | yes |

`RESULT ok qp=1 mainTicks=234 helperPrep=400 helper=ok helperDone=true helperTicks=675 xp=magic=875 ... retries=1
died=false milestones=trade,1,2,3,half2,4,5` (run 1; run 2 `mainTicks=235 helperPrep=371`, run 3 `mainTicks=237
helperPrep=383`). Main milestones in a trial: trade 14, tramp 33, Katrine 95-104, joined 105-114, Black Arm half
133-138, certificates 187, king 233-238. The Varrock teleport from the cupboard cut the main from 267-277 to 232-237
ticks (the walk from the HQ door to the museum was 56 ticks).

Findings:
- Katrine's room is reached from the east through two shut doors (`loc_1530` at 3196,3384 and 3190,3384,
  `maps/m49_52.jm2`). With them shut, the SDK reported "no route" and the talk failed.
- The alley north of the Black Arm stairs is a dead end (a trial stopped at 3189,3397).
- The bookcase, the chest and the cupboard give the item after their message boxes. The script clicks them through.

Planner: new row `quest-arrav` (qp 1, 234 / 237 MEASURED, the same under `rival-dialogue-burst`). `quests-rest`:
78 -> 77 QP, 36 -> 35 quests, one medium class less: 55,100 / 82,700 -> 54,200 / 81,400 (burst 50,956 / 76,481 ->
50,124 / 75,279). Scenario a (`research/hiscores-live.json`, `--levers`): Quest Points WIN at 102,677 / 137,207
before, 102,079 / 136,242 after. Overall unchanged (40,212 / 45,105). `bun test packages/planner`: 42 pass, 0 fail.

## Medium `rest` quests: scripts and proofs (MEASURED practice, 3/3 each)

Presets `quest_<name>` in `packages/practice/src/presets-medium.ts`, on the same base as the short quests (every
skill 99, rune helm, body, legs and scimitar worn, the quests before the dragon row plus Dragon Slayer and Merlin's
Crystal done, the helper items, the start beside the first NPC). Runner: `proveInProcess` with `okPass`, one bot
at a time, each run on a fresh account that is deleted after the run.

| Quest | Script | RESULT ticks (3 runs) | Status |
|---|---|---|---|
| Pirate's Treasure | `scripts/generated/quest-hunt.ts` | 474, 471, 460 | MEASURED 3/3 |
| The Knight's Sword | `scripts/generated/quest-squire.ts` | 893, 887, 922 | MEASURED 3/3 |
| Plague City | `scripts/generated/quest-elena.ts` | 780, 784, 749 | MEASURED 3/3 |
| Priest in Peril | `scripts/generated/quest-priestperil.ts` | 1010, 993, 1011 | MEASURED 3/3 |

### Pirate's Treasure

`RESULT ok qp=2 xp=attack=700,hitpoints=232,magic=2075 ... ticks=474 ... walkTicks=194 retries=4 died=false`
(runs: 474, 471, 460 ticks; a trial before the proof: 467), each with `and find a little bag of treasure.` and
`Congratulations! Quest complete!`. Steps (trial MILESTONE ticks): Redbeard Frank "I'm in search of treasure." 0-17
(`quests/quest_hunt/scripts/redbeard_frank.rs2:57-66`); Wydin "Can I get a job here?" with the apron in the pack
17-70 (`areas/area_port_sarim/scripts/wydin.rs2:8-10,40-50`); a seaman to Musa Point, 30 coins 70-110
(`areas/area_port_sarim/scripts/sailors.rs2:10-30`); Zambo's shop, one Karamjan rum 110-136; Luthas "Could you offer
me employment on your plantation?", the rum and 10 bananas in his crate (2072 at 2943,3151), Luthas pays 30 coins
and sets `%crate_rum` 2 136-227 (`quest_hunt/scripts/banana_crate.rs2:21-68`, `luthas.rs2:12-33`); the customs
officer searches a pack with no rum, 30 coins to Port Sarim 227-274 (`areas/area_karamja/scripts/customs_officer.rs2:
21-95`); the apron worn, Wydin's back door (2069 at 3012,3204), the crate (2071 at 3009,3207) gives the rum 274-300
(`food_store.rs2:1-37`); Redbeard takes the rum and gives the chest key 300-373 (`redbeard_frank.rs2:32-55`); Varrock
teleport, the Blue Moon Inn stairs (1725 at 3227,3393), the door `loc_1533` at 3222,3395 on level 1, the key on
Hector's chest (2079 at 3218,3396,1), read the message 373-426 (`pirate_message.rs2:1-27`); Falador teleport, the
gardener killed, the spade at 2999,3383 (`general_use/scripts/spade.rs2:3-5`, `dig.rs2:1-24`) 426-467.
Findings:
- The Karamjan rum (431), chest key and message are `tradeable=no` (`quest_hunt.obj`), so a helper cannot bring
  the rum. A teleport breaks it (`skill_magic/scripts/spells/teleport.rs2:88-93`), the customs officer takes it
  (`customs_officer.rs2:13,48-53`) and the Shilo cart loses it (`areas/area_karamja/scripts/captain_shanks.rs2:67-
  70`). The banana crate is the only way off the island.
- A gardener within 10 tiles of the X stops the dig and attacks (`dig.rs2:6-8,26-28`); the spawn at 2996,3381 is 3
  tiles away (`maps/m46_52.jm2`). The script kills him first (the Attack XP in RESULT) and digs again.
- Helper items: 10 bananas, white apron, spade, 200 coins (two fares and the rum), Varrock and Falador teleport
  runes. All are tradeable (`knowledge/items.json`).

### The Knight's Sword

`RESULT ok qp=1 xp=magic=3275,smithing=318125,mining=437 ... ticks=893 ... walkTicks=685 retries=0 died=false` (runs:
893, 887, 922 ticks; a passing trial before the proof: 897), each with `You manage to mine some blurite.` and
`Congratulations! Quest complete!`. Steps (trial MILESTONE ticks): the squire "And how is life as a squire?", "I can
make a new sword if you like...", "So would these dwarves make another one?", "Ok, I'll give it a go." 0-36
(`quests/quest_squire/scripts/quest_squire.rs2:1-60`); Varrock teleport, Reldo "What do you know about the Imcando
dwarves?" 36-107 (`areas/area_varrock/scripts/reldo.rs2:6-9`, `quest_squire.rs2:113-123`); Falador teleport, the
walk to Thurgo, the redberry pie (3) and "Can you make me a special sword?" (4) 107-273 (`areas/area_port_sarim/
scripts/thurgo.rs2:1-6`, `quest_squire.rs2:125-161`); the cellar ladder (1759 at 3008,3150), one blurite ore
(bluriterock 2110 at 3049,9566, `maps/m47_149.jm2`; Mining 10, `skill_mining/configs/mine.dbrow:164-173`), the
ladder up 273-416; the walk to the squire (5) 416-578 (`quest_squire.rs2:75-78`); the tower ladder (1747 at
2994,3341), the stairs (1722 at 2984,3337,1), Vyvin's door `loc_1530` at 2982,3337,2, the cupboard (2271 at
2984,3336,2, `general_use/scripts/cupboards.rs2:22-30`) 578-635; the walk to Thurgo, the portrait (6), the blurite
and 2 iron bars give the sword 635-860 (`quest_squire.rs2:163-207`); Falador teleport, the sword to the squire
860-897 (`quest_squire.rs2:94-104`).
Findings:
- The portrait, blurite ore and sword are `tradeable=no` (`quest_squire.obj`). The blurite is mined on the first
  Thurgo visit (the rock has no quest check), so the second visit gets the sword at once.
- Vyvin's room door is shut; with it shut the cupboard click gets "I can't reach that!" (first trial failed at
  858 ticks). The script opens it by tile. Vyvin within 1 tile stops the search (`quest_squire.rs2:209-217`); the
  script waits while he stands within 2 tiles. In 4 runs he did not block it.
- 680 of the about 890 ticks are walks: the Falador-Thurgo leg three times. No teleport lands nearer to Thurgo.
- Helper items: redberry pie, 2 iron bars, rune pickaxe, Varrock and two Falador teleport runes (all tradeable).

### Plague City

`RESULT ok qp=1 xp=mining=60625 ... ticks=780 ... walkTicks=227 retries=3 died=false` (runs: 780, 784, 749 ticks; a
passing trial before the proof: 640), each with `You climb up the mud pile.` and `Congratulations! Quest complete!`.
Steps (trial MILESTONE ticks, `quests/quest_elena/scripts/`): Edmond "What's happened to her?", "Can I help find
her?" (1, `edmond.rs2:2-8,52-66`); the picture (obj 1510 on the table at 2576,3334, `maps/m40_52.jm2`); Alrena makes
the gas mask from the dwellberries (2, `alrena.rs2:9-29`); Edmond (3); four buckets of water on the mud patch (2531/
2532 at 2566,3331-3333) and the spade drop the bot into the sewer (4-8, `mud_patch.rs2:1-46`) 0-111; the rope on the
grill (2541 at 2530,9701), Edmond pulls it (9-10, `sewerpipe.rs2:24-34`, `edmond.rs2:26-32`) 111-157; the gas mask
worn, the pipe to West Ardougne 157-174 (`sewerpipe.rs2:1-12,36-48`); Jethick takes the picture and gives the book
(20, `jethick.rs2`) 174-206; the Rehnison door takes the book (21, `doors.rs2:97-117`), Ted (22), the stairs (2539 at
2527,3332), Milli (23, `rehnisons.rs2`) 206-334; the plague house door (`loc_2535` at 2533,3272) with a mourner near,
"I fear not a mere plague." (24, `doors.rs2:11-19,51-67`) 334-393; the clerk "I need permission to enter a plague
house.", "This is urgent though!" (25, `areas/area_ardougne_west/scripts/clerk.rs2:1-55`) 393-441; Bravek's door
(2528 at 2530,3314), "This is really important though!", "Do you know what is in the cure?" (26); chocolate dust
into the milk, snape grass into the chocolaty milk (`skill_cooking/scripts/cooking_inv/scripts/cakes/cakes.rs2:20-24,
50-54,138-145`), Bravek drinks the cure (27), "They won't listen to me!" gives the warrant (`bravek.rs2`) 441-499;
the plague house door with the warrant, the barrel key (2530 at 2534,3268), the stairs down, Elena's door with the
key, Elena (28, `plaguehouse.rs2`, `elena.rs2`) 499-568; the stairs up, the manhole (2543 at 2529,3303) into the
sewer, the mud pile (2533 at 2561,9738) to the garden, Edmond queues the completion 568-640 (`edmond.rs2:37-40`).
Findings:
- "This is urgent though!" sets 25 only with Bravek within 7 tiles of the player (`clerk.rs2:52`, the comment says
  "yes its possible this doesnt pop off if hes too far"). The clerk can be talked to only from the west side of his
  desk (from the east the talk is rejected), 9 tiles from Bravek's spawn (2536,3314). The script holds the option
  page until Bravek walks within 6 tiles. That wait is the spread of the runs: 48 ticks in the trial, 198 in proof
  run 1. A bot cannot shorten it.
- Edmond wanders between the garden and his house (door `loc_1530` at 2570,3333; inner door at 2574,3333). With a
  door shut the talk and the picture pickup are rejected ("I can't reach that!"). The script opens the doors by tile.
- With the warrant the mourner talks for 3 pages before the door lets the bot in (`doors.rs2:23-50`); a one-click
  step failed there.
- Untradeable: gas mask, picture, book, key, warrant, note, hangover cure (`quest_elena/configs/*.obj`) and the
  chocolaty milk (`knowledge/items.json`). Helper items: dwellberries, 4 buckets of water, spade, rope, chocolate dust,
  bucket of milk, snape grass (all tradeable).

### Priest in Peril

`RESULT ok qp=1 xp=attack=7000,hitpoints=2317,prayer=35150,magic=1750 ... ticks=1010 ... walkTicks=539 retries=2
died=false` (runs: 1010, 993, 1011 ticks; a passing trial before the proof: 1039), each with `You give the priest your
blank runes.` and `Congratulations! Quest complete!`. Steps (proof run 1 MILESTONE ticks; quest truth in
`quests/quest_priestperil/scripts/` and `areas/area_mausoleum/scripts/`): King Roald "Sure." (1,
`areas/area_varrock/scripts/king_roald.rs2:46-55`) 0-24; the walk to the temple, Knock-at on the door (3489 at
3408,3489), "Roald sent me to check on Drezel.", "Sure." (2, `temple_doors.rs2:22-31,63-82`) 24-174; the trapdoor north of
the temple (1568 at 3405,3507), the temple guardian killed (3, `temple_guardian.rs2:1-11`) 174-225; Varrock teleport,
Roald (4, `king_roald.rs2:69-81`) 225-282; the temple doors open now, a level 30 monk (`priestperilevilmonk3`) killed for
the golden key (`evil_monks.rs2:52-56`) 282-426; the spiral stairs (1738 at 3417,3484), the ladder (1747 at 3410,3485),
Talk-through on the cell door (3463 at 3415,3489,2), "Tell me anyway.", "Yes." (5, `trapped_drezel.rs2:54-67,85-119`)
426-537; the trapdoor, gate 1 (3444 at 3405,9895, open at 5, `gates.rs2`), the golden key on each monument until it swaps
for the iron key (`monuments.rs2:52-66`), the bucket on the well (3485 at 3423,9890, `well.rs2`) 537-611; back up, the
iron key on the cell door (6), Drezel blesses the murky water, the blessed water on the coffin (3480 at 3413,3486,2; 7,
`vampire_coffin.rs2:8-17`), Drezel (8) 611-711; the trapdoor, gates 1 and 2 (3445 at 3431,9897, open at 8), Drezel by the
monuments (10, `drezel.rs2:30-56`), 23 essence used on him 711-831; Varrock teleport, 27 essence from the east bank
(booths at 3252-3256,3419), the walk back, the rest of the essence queues the completion 831-1010.
Findings:
- Drezel takes 50 unnoted essence (`drezel.rs2:96-113`; notes get only a dialogue, `:73-79`). 28 slots hold one
  batch, so a single-account run makes a bank trip (about 180 ticks: 831-1010). In the swarm run a helper at the
  mausoleum with 27 essence would save most of it (not measured).
- The iron key lies in one of 7 monuments at random (`monuments.rs2:31-33`); the golden key swaps only on that one,
  and "Nothing interesting happens." on the others. The script tries them nearest first (at most 7 clicks).
- East of Varrock the SDK plans past `lockeddoor1` at 3268,3435 (`maps/m51_53.jm2`). The server does not let the bot
  through, and the walker clicks the locked door: 251 ticks lost twice per run in two trials. Three waypoints
  (3272,3421; 3282,3428; 3285,3442) take the other way out. A temporary door block did not change the plan.
- King Roald stands west of the throne room wall (door `loc_1536` at 3219,3472); a talk from the throne room is
  rejected, so the preset starts in his room.
- Gates 1 and 2, the cell door and the temple doors walk the bot through when opened (`open_and_close_metal_gate`,
  `open_and_close_double_door2`), so the script checks the side of the door, not the door state.
- Helper items: bucket, 50 rune essence (23 in the pack, 27 in the bank), runes for two Varrock teleports (all
  tradeable). No food: hpMin 98 against the level 30 guardian and monk.

### Planner change for the medium quests

New row `quests-medium` in `packages/planner/src/haggis-boards.json` (MEASURED), after `quests-short`: Pirate's
Treasure (2 QP, 460 / 474), The Knight's Sword (1 QP, 887 / 922), Plague City (1 QP, 749 / 784) and Priest in Peril
(1 QP, 993 / 1,011): 5 QP, floor 3,089 ticks (sum of best runs), realistic 3,191 (sum of worst runs), the same under
`rival-dialogue-burst`. Row `quests-rest` loses them: 35 -> 31 quests, `qp` 77 -> 72, four medium classes less:
54,200 / 81,400 -> 50,600 / 76,200 (burst 50,124 / 75,279 -> 46,795 / 70,470). The QP total stays 145. The row is
written by the helper's `medium-row.ts` from its QUESTS list. `bun test packages/planner`: 42 pass, 0 fail.
`bun packages/planner/src/haggis-cli.ts research/hiscores-live.json --levers` after Priest in Peril: QP at end 145;
Quest Points WIN at 101,857 floor / 134,626 realistic (deadline 1,022,262). Overall 40,230 / 45,107, the same with
and without this change (the HEAD boards file gives the same Overall line).

Next medium quest: Biohazard (`quests/quest_biohazard`; script `scripts/generated/quest-biohazard.ts` and preset
`quest_biohazard` written from the content read, not yet run).

## Cook's Assistant, Witch's House, Lost City (MEASURED practice, 3/3 each)

The main account and the Heroes' Quest partner both need these 3 quests (`research/heroes-partner.md`). Presets in
`packages/practice/src/presets-partner.ts`, two per quest:
- `quest_<name>`: the main account late in the run, on the base of the short quests (every skill 99, the quests
  before the dragon row plus Dragon Slayer and Merlin's Crystal done, this quest's varp at 0).
- `quest_<name>_partner`: Bigchopper (Woodcutting 99, Fletching 32, Thieving 35, combat 3, 10 HP) with the quest XP
  and skill gates of the partner route up to this quest (`heroes-partner.md` section 3).

Runner: `proveInProcess` with `okPass`, one bot at a time, each run on a fresh account that is deleted after the run.

| Quest | Script | Main (3 runs) | Partner (3 runs) | Status |
|---|---|---|---|---|
| Cook's Assistant | `scripts/generated/quest-cook.ts` | 30, 30, 30 | 30, 30, 30 | MEASURED 3/3 both |
| Witch's House | `scripts/generated/quest-ball.ts` | 485, 448, 444 | 522, 454, 448 | MEASURED 3/3 both |

### Cook's Assistant

`RESULT ok qp=1 xp=cooking=7500 at=3209,3214,0 ticks=30 ... walkTicks=0 retries=0 died=false milestones=1,2` in all 6
runs (3 main, 3 partner), each with `Congratulations! Quest complete!`. Two talks to the cook in the Lumbridge castle
kitchen (spawn 3209,3215, `maps/m50_50.jm2`): "What's wrong?", "Yes, I'll help you." sets `%cookquest` 1
(`quests/quest_cook/scripts/quest_cook.rs2:1-36`, `areas/area_lumbridge/scripts/cook.rs2:7-11`); the second talk with
an egg, a bucket of milk and a pot of flour in the pack goes to the hand-in and queues the completion
(`quest_cook.rs2:42-91`). 25 of the 30 ticks are dialog pages (LEDGER `dialog=25`). Helper items: egg (1944), bucket of
milk (1927), pot of flour (1933); all tradeable. The levels do not matter: no step checks a skill.

Planner: row `cooks-assistant` 12 / 28 ESTIMATE -> 30 / 30 MEASURED. The row is early in the run (Cooking 1 -> 30), so
the Cooking board and Overall move by 18 floor / 2 realistic ticks: Overall 40,212 / 45,105 -> 40,230 / 45,107,
Cooking 148 / 177 -> 166 / 179 (`bun packages/planner/src/haggis-cli.ts research/hiscores-live.json --levers`). The
rival's 12-tick floor is not reached: it needs the burst dialog (5 pages per tick), which this script does not use.

### Witch's House

`RESULT ok qp=4 caught=0 witchWait=111 xp=attack=14400,hitpoints=162895 ... ticks=485 ... retries=4 died=false
milestones=1,key,2,3,shedkey,shed,6,ball,7` (main runs: 485, 448, 444 ticks; partner runs: 522, 454, 448), each
with `You finally kill the shapeshifter once and for all.` and `Congratulations! Quest complete!`. The partner runs
had `hpMin=10`: Protect from Melee blocked every hit at 10 HP and Defence 1. Steps (main trial MILESTONE ticks,
`quests/quest_ball/scripts/`): the boy "What's the matter?", "Ok, I'll see what I can do." (1,
`areas/area_taverly/scripts/boy.rs2:3-15`) 0-18; the door key under the pot (2867 at 2900,3474) and the front door
(2861 at 2901,3473) with the key in the pack (`quest_ball.rs2:1-31`) 18-57; the ladder (1754 at 2907,3476), the
electric gate (2865/2866 at 2902,9873-9874) with leather gloves worn (`:33-58`; without them it shocks for HP/10 + 1),
the cupboard (2868 at 2898,9873): Open, then Search gives the magnet (2, `:61-78`) 57-88; the ladder up, the cheese on
the mouse hole (2870 at 2903,3466) spawns the mouse, the magnet on the mouse (3, `:80-117`) 88-117; the back door
(2862 at 2901,3465), the garden to the fountain (2864 at 2909,3470, op2 Check: the shed key, `:162-169`) 117-213; the
shed door (2863 at 2934,3463) with the key spawns the experiment (`:134-160`) 213-235; the 4 forms, each spawned by
the death of the last (`witches_experiement.rs2:37-81`, 21 + 31 + 41 + 51 HP) 235-342; the ball (2407 at 2935,3460,
`quest_ball.rs2:171-183`), the garden back, the house, the boy queues the completion (`boy.rs2:28-33`) 342-460.
Findings:
- The witch (Nora T. Hagg) patrols z 3463 between x 2904 and 2930 (`witches_house.npc`). Each tick she catches a
  player within 3 tiles in line of sight who is north or south of her and has no hedge on the next tile toward her
  row (`witch.rs2:1-34`). A catch takes the shed key and the ball, sets 3 back to 1, and puts the player outside at
  2929,3456. A trial walked the SDK route along z 3460 past her and was caught at tick 133.
- Her row is in a shut pen (z 3462-3464, x 2904-2930). The gaps in the hedge rows z 3461 and 3465 hold soil and grass
  patches (ground decoration 316, 1244, 1245, `maps/m45_54.jm2`) that block walking: the client rejected every walk
  into the pen (`client_rejected`), and the SDK collision agrees. So the garden is 4 corridors round the pen: x 2901,
  z 3460, x 2933 and z 3466. The fountain is reached only by the loop past the shed.
- The script walks the corridors in hops between hidden tiles (a hedge toward her row, or out of her reach). A hop
  goes only when no tile of it is exposed to any position she can reach by then, from her last seen position (the
  npc list covers about 15 tiles; a trial that took "out of sight" as "safe" was caught at tick 183). The waits are
  61-111 ticks of each run and are the spread of the runs.
- Each new form attacks at once, and the attack click on it got "I'm already under attack!". The forms took 7, 32,
  33 and 35 ticks. Auto retaliate on and the latest form as the target did not shorten it.
- Untradeable: door key, magnet, shed key, ball (`quest_ball.obj`). Helper items: leather gloves (1059), cheese (1985).


Planner: row `witch` 300 / 900 ESTIMATE -> 444 / 485 MEASURED (best / worst main run), the same under
`rival-dialogue-burst` (was 277 / 832). The row is not in `quests-rest`, so the QP total stays 145. `bun test
packages/planner`: 42 pass, 0 fail. `haggis-cli --levers`: Quest Points WIN at 102,024 floor / 134,279 realistic
(was 101,857 / 134,626); Overall and Hitpoints unchanged.
