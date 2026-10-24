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
| Fight Arena (`arena`) | 2 (72) | `rival-fight-arena` (qp 0), MEASURED 628-637 (`research/quest-plan.md` 1m) | none found | level 137 enemy (`quest_arena/scripts/arena_journal.rs2:8`); Fire Wave under Protect from Melee, 0 damage | - |
| Merlin's Crystal (`arthur`) | 6 (73) | `merlin` | none found | level 39 (`quest_arthur/scripts/arthur_journal.rs2:10`) | - |
| Witch's House (`ball`) | 4 (74) | `witch` | none found | level 53 (`quest_ball/scripts/ball_journal.rs2:7`) | - |
| Biohazard (`biohazard`) | 3 (75) | rest | Plague City (OSRS; `quest_elena/scripts/mud_patch.rs2:15` reads `%biohazard`); a teleport destroys the plague sample (`skill_magic/scripts/spells/teleport.rs2:94-97`); MEASURED 1,655-1,672 ticks in row `quests-medium` | none found | L |
| Shield of Arrav (`blackarmgang`) | 1 (76) | rest | one gang only (`general/scripts/quests.rs2:170`); a second account in the other gang (rev 289 code, see "Shield of Arrav as a pair"); MEASURED 234-237 ticks in row `quest-arrav` | Jonny the Beard, weaponsmaster (helper) | M |
| Black Knights' Fortress (`blackknight`) | 3 (77) | `qp-filler` | 12 QP (`quest_blackknight/scripts/blackknight_journal.rs2:9-10`) | level 33 knights (same) | - |
| Big Chompy Bird Hunting (`chompybird`) | 2 (78) | rest | Fletching 5, Cooking 30, Ranged 30 (`quest_chompybird/scripts/chompybird_journal.rs2:10-28`) | none found; MEASURED 483-583 ticks in row `quests-medium` | M |
| Clock Tower (`cog`) | 1 (79) | rest | none found; MEASURED 468-486 ticks in row `quests-medium` | none found | M |
| Cook's Assistant (`cook`) | 1 (80) | `cooks-assistant` | none | none | - |
| Family Crest (`crest`) | 1 (81) | `crest` (qp 0) | Mining 40, Crafting 40, Smithing 40, Magic 59 (`quest_crest/scripts/crest_journal.rs2:10-13`) | level 170 demon (`:14`) | - |
| Death Plateau (`death`) | 1 (82) | rest | none found; MEASURED 1,192-1,201 ticks in row `quests-medium` | none found | M |
| Demon Slayer (`demon`) | 3 (83) | rest | none found; keys and Silverlight untradeable (`quest_demon/configs/demon.obj`); MEASURED 877-899 ticks in row `quests-medium` | Delrith, needs Silverlight (`quest_demon/scripts/demon_journal.rs2:6-9`) | M |
| The Tourist Trap (`desertrescue`) | 2 (84) | rest | Fletching 10, Smithing 20 (`quest_desertrescue/scripts/quest_desertrescue.rs2:603,655`) | none found; MEASURED 1,604-1,624 ticks in row `quests-long` | L |
| Doric's Quest (`doric`) | 1 (85) | rest | none found | none | S |
| Dragon Slayer (`dragon`) | 2 (86) | `dragon` | 32 QP (`quest_dragon/scripts/dragon_journal.rs2:7`) | level 83 dragon (`:6`) | - |
| Druidic Ritual (`druid`) | 4 (87) | `druid` | none | none | - |
| Nature Spirit (`druidspirit`) | 2 (88) | rest | Restless Ghost, Priest in Peril, Crafting 18 (`quest_druidspirit/scripts/druidspirit_journal.rs2:26,31,37`); MEASURED 791-830 ticks in row `quests-medium` | ghasts (`:45`) | M |
| Monk's Friend (`drunkmonk`) | 1 (89) | rest | none found | none found | S |
| Elemental Workshop (`elemental_workshop`) | 1 (90) | rest | Mining 20, Smithing 20, Crafting 20 (`quest_elemental_workshop/scripts/quest_elemental_workshop.rs2:172,186,252`); MEASURED 194-209 ticks in row `quests-medium` | none found | M |
| Plague City (`elena`) | 1 (91) | rest | none found; gas mask, picture, book, key, warrant, chocolaty milk and hangover cure are untradeable (`quest_elena/configs`, `knowledge/items.json`); MEASURED 749-784 ticks in row `quests-medium` | none found | M |
| Fishing Contest (`fishingcompo`) | 1 (92) | rest | Fishing 10 (`quest_fishingcompo/scripts/hemenster_fishing.rs2:70`) | none found | S |
| Gertrude's Cat (`fluffs`) | 1 (93) | rest | none found | none found | S |
| Goblin Diplomacy (`gobdip`) | 5 (94) | `gobdip` | none | none | - |
| Holy Grail (`grail`) | 2 (95) | `grail` (MEASURED 1,451-1,479 ticks, `quest-plan.md` 1k) | Merlin's Crystal (`king_arthur.rs2` grail start needs `%arthur` complete); no weapon or armour on Entrana | Black Knight Titan (`quest_grail/scripts/grail_journal.rs2:11`), needs Excalibur worn at its death | - |
| The Grand Tree (`grandtree`) | 5 (96) | `grandtree` | Agility 25 (`quest_grandtree/scripts/quest_grandtree.rs2:25`); Tree Gnome Village read at `king_narnode.rs2:8` | level 172 demon (`grandtree_journal.rs2:14`) | - |
| Ernest the Chicken (`haunted`) | 4 (97) | `qp-filler` | none found | none found | - |
| Haunted Mine (`hauntedmine`) | 2 (98) | rest | Agility 15, Crafting 35, Morytania access (Priest in Peril) (`quest_hauntedmine/scripts/hauntedmine_journal.rs2:10-16`); MEASURED 1,011-1,574 ticks in row `quests-medium` | level 95 (`:19`) | L |
| Hazeel Cult (`hazeelcult`) | 1 (99) | rest | none found; MEASURED 426-435 ticks in row `quests-medium` (good side) | none found | M |
| Heroes' Quest (`hero`) | 1 (100) | rest | 55 QP, Lost City, Merlin's Crystal, Dragon Slayer (`quest_hero/scripts/quest_hero.rs2:2-3`); a gang HQ from Shield of Arrav (`locs/brimhaven_blackarm_hq.rs2:2`, `locs/brimhaven_restaurant.rs2:2`); a second player for Grip (`hero_journal.rs2:190`) | firebird, Grip | XL |
| Witch's Potion (`hetty`) | 1 (101) | rest | none found | none found | S |
| Pirate's Treasure (`hunt`) | 2 (102) | rest | none found; the rum, key and message are untradeable (`quest_hunt/configs/quest_hunt.obj`); MEASURED 460-474 ticks in row `quests-medium` | none found | M |
| Temple of Ikov (`ikov`) | 1 (103) | rest | Thieving 42, Ranged 40 (`quest_ikov/scripts/ikov_journal.rs2:14-15`) | fire warrior (`ikov_dungeon.rs2:158`) | L |
| Imp Catcher (`imp`) | 1 (104) | rest | none found | imps (`quest_imp/scripts/imp_journal.rs2:13`) | S |
| The Dig Site (`itexam`) | 2 (105) | `dig`, MEASURED 1,535-1,851 (`research/quest-plan.md` 1p) | Agility 10 at the winch, Herblore 10 in the chemistry, Thieving 25 at the pocket (`quest_itexam/scripts/area_digsite.rs2:617`, `itexam_chemistry.rs2:21`, `digsite_workman.rs2:62`); the rock samples, brush, trowel, talisman, chemicals and tablet are untradeable, so the account fetches them | none found | - |
| Observatory Quest (`itgronigen`) | 2 (106) | rest | none found; MEASURED 550-555 ticks in row `quests-medium` | none found | M |
| Watchtower (`itwatchtower`) | 4 (107) | rest | Magic 14, Mining 40, Herblore 14, Thieving 15, Agility 25 (`quest_itwatchtower/scripts/itwatchtower_journal.rs2:8-28`) | ogres | XL |
| Jungle Potion (`junglepotion`) | 1 (108) | rest | Druidic Ritual (`areas/area_karamja/scripts/trufitus.rs2:280` reads `%druidquest`); MEASURED 649-651 ticks in row `quests-medium` | none found | M |
| Legends' Quest (`legends`) | 4 (109) | rest | 107 QP; Family Crest, Heroes', Underground Pass, Shilo Village, Waterfall (`quest_legends/scripts/legends_guard.rs2:50-53`); Magic 56, Mining 52, Agility, Crafting, Smithing, Strength, Thieving, Woodcutting 50, Herblore 45, Prayer 42 (`legends_journal.rs2:65-128`) | several | XL |
| Dwarf Cannon (`mcannon`) | 1 (110) | `cannon` | none | goblins | - |
| Throne of Miscellania (`misc`) | 1 (111) | rest | Heroes' Quest, Fremennik Trials (`quest_misc/scripts/misc_journal.rs2:8-17`, `misc_door_guard.rs2:10`) | none found | XL |
| Murder Mystery (`murder`) | 3 (112) | rest | none found; MEASURED 270-395 ticks in row `quests-medium` (random murderer; all 6 suspects proved) | none found | M |
| The Restless Ghost (`priest`) | 1 (113) | rest | none found | level 13 skeleton (`quest_priest/scripts/priest_journal.rs2:8`) | S |
| Priest in Peril (`priestperil`) | 1 (114) | rest | none found; 50 rune essence to Drezel (`areas/area_mausoleum/scripts/drezel.rs2:96-113`); MEASURED 993-1011 ticks in row `quests-medium` | level 30 (`quest_priestperil/scripts/priestperil_journal.rs2:7`) | M |
| Prince Ali Rescue (`prince`) | 3 (115) | `qp-filler` | none found | none found | - |
| Romeo & Juliet (`romeojuliet`) | 5 (116) | `rj` | none | none | - |
| Rune Mysteries (`runemysteries`) | 1 (117) | rest | none found | none | S |
| Scorpion Catcher (`scorpcatcher`) | 1 (118) | `scorpion`, MEASURED 910-942 (`research/quest-plan.md` 1o) | Prayer 31 (`quest_scorpcatcher/scripts/scorpcatcher_journal.rs2:9`); Alfred Grimhand's Barcrawl for the Barbarian Outpost gate (`area_barbarian_outpost/scripts/outpost_gate.rs2:1-5`; row `barcrawl` MEASURED 1,466-1,486); the dusty key (untradeable) for scorpion A in Taverley dungeon (`research/quest-plan.md` 1o) | none found | - |
| Sea Slug (`seaslug`) | 1 (119) | `rival-seaslug` (qp 0), MEASURED 449-455 (`research/quest-plan.md` 1n) | Firemaking 30 (`quest_seaslug/scripts/quest_seaslug.rs2:43`); the lite client needs the bridged-tile fix `packages/core/src/bridgefix.ts` for the broken glass room door | none found | - |
| Sheep Shearer (`sheep`) | 1 (120) | rest | none | none | S |
| Sheep Herder (`sheepherder`) | 4 (121) | `qp-filler` | none found | none found | - |
| The Knight's Sword (`squire`) | 1 (122) | rest | Mining 10 (`quest_squire/scripts/squire_journal.rs2:7`); the portrait, blurite ore and sword are untradeable (`quest_squire/configs/quest_squire.obj`); MEASURED 887-922 ticks in row `quests-medium` | none found | M |
| Tribal Totem (`totem`) | 1 (123) | rest | Thieving 21 (`quest_totem/scripts/quest_totem.rs2:125`); Plague City for Ardougne Teleport (`skill_magic/scripts/spells/teleport.rs2:22-35`); MEASURED 340-352 ticks in row `quests-medium` | none found | M |
| Tree Gnome Village (`tree`) | 2 (124) | `tree` | none found | level 112 warlord (`quest_tree/scripts/tree_journal.rs2:6`) | - |
| Underground Pass (`upass`) | 5 (125) | rest | Biohazard (`quest_upass/scripts/quest_upass.rs2:81`), Thieving 50 (`:248`); MEASURED 2,764-2,898 ticks in row `quests-long` | Iban's undead, others | XL |
| Vampire Slayer (`vampire`) | 3 (126) | rest | none found | level 34 vampire (`quest_vampire/scripts/vampire_journal.rs2:9`) | S |
| Waterfall Quest (`waterfall`) | 1 (127) | `waterfall` | none found | level 84 giants (`quest_waterfall/scripts/waterfall_journal.rs2:9`) | - |
| Lost City (`zanaris`) | 3 (128) | rest | Woodcutting 36, Crafting 31 (`quest_zanaris/scripts/quest_zanaris.rs2:37,78`) | level 101 spirit without weapons (`zanaris_journal.rs2:20`) | M |
| Shilo Village (`zombiequeen`) | 2 (129) | rest | Jungle Potion (`quest_zombiequeen/scripts/mosol_rei.rs2:2`), Crafting 20, Agility 32 (`zombiequeen_journal.rs2:23-26`); MEASURED 2,133-2,478 ticks in row `quests-long` | level 86 (`:27`) | L |
| Troll Stronghold (`troll`) | 1 (130) | rest | Death Plateau (`quest_death/scripts/death_ig_commander.rs2:5-9` offers the troll talk only at `%death_equiproom` 80), Agility 15 (`quest_troll/scripts/quest_troll.rs2:7`), worn climbing boots (`:8-11`, `quest_death/scripts/quest_death.rs2:159-176`), Thieving 30 (`troll_stronghold_camp_guard.rs2:46`); MEASURED 788-847 ticks in row `quests-long` | level 101 Dad, level 113 general (`pack` combat; `troll_journal.rs2:5`) | L |
| Troll Romance (`troll_love`) | 2 (131) | rest | Death Plateau, Troll Stronghold, Agility 28 (`quest_troll_love/scripts/troll_love_journal.rs2:12-22`) | level 113 troll (`:26`) | L |
| Tai Bwo Wannai Trio (`tbwt`) | 2 (132) | rest | Jungle Potion (`areas/area_karamja/scripts/tbwt_timfraku.rs2:51`), Cooking 30, Agility 15, Fishing 5 (`quest_tbwt/scripts/tbwt_journal.rs2:11-13`) | level 48 jogres (`:15`) | XL |
| Regicide (`regicide`) | 3 (133) | rest | Underground Pass (`quest_regicide/scripts/regicide_kings_messenger.rs2:2`), Agility 56, Crafting 10 (`quest_regicide.rs2:404,674`) | none found; research notes in "Regicide: research notes"; CLAIMED by long-quest helper 1 | XL |
| Eadgar's Ruse (`eadgar`) | 1 (134) | rest | Druidic Ritual, Troll Stronghold, Herblore 31 (`quest_eadgar/scripts/eadgar_journal.rs2:8`; `quest_troll/scripts/troll_eadgar.rs2:22`) | none found; CLAIMED by long-quest helper 2 | L |
| Shades of Mort'ton (`mortton`) | 3 (135) | rest (row `mortton-oil` is OUT) | Crafting 12 (`quest_mortton/scripts/quest_mortton.rs2:76`), Morytania (Priest in Peril, OSRS); MEASURED 1,908-1,956 ticks in row `quests-medium` | 5 shades (`mortton_journal.rs2:79-85`) | L |
| The Fremennik Trials (`viking`) | 3 (136) | rest | Woodcutting 40, Crafting 40, Fletching 25 (`quest_viking/scripts/viking_journal.rs2:7`) | level 69, unarmed (`:8`) | XL |
| Horror from the Deep (`horror`) | 2 (137) | rest | Agility 35 (`quest_horror/scripts/horror_journal.rs2:6`); Prayer 50 for the god book (`horror_godbook.rs2:253`) | level 100 enemies (`horror_journal.rs2:6`) | L |
| Monkey Madness (`mm`) | 3 (138) | `rival-mm` (qp 0) | The Grand Tree (`quest_mm/scripts/mm_journal.rs2:4`) | level 195 jungle demon (`:5`) | - |
| In Search of the Myreque (`routequest`) | 2 (139) | rest | Nature Spirit (`quest_routequest/scripts/routequest_journal.rs2:18-23`), Agility 25 (`routequest_myreque.rs2:125`); MEASURED 819-852 ticks in row `quests-medium` | level 97 (`routequest_journal.rs2:24`) | L |
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
| Biohazard | `scripts/generated/quest-biohazard.ts` | 1662, 1655, 1672 | MEASURED 3/3 |
| Nature Spirit | `scripts/generated/quest-druidspirit.ts` | 823, 830, 791 | MEASURED 3/3 |
| In Search of the Myreque | `scripts/generated/quest-routequest.ts` | 819, 852, 846 | MEASURED 3/3 |
| Haunted Mine | `scripts/generated/quest-hauntedmine.ts` | 1423, 1304, 1574, 1017, 1163, 1011 | MEASURED 6/6 |
| Demon Slayer | `scripts/generated/quest-demon.ts` | 899, 877, 882 | MEASURED 3/3 |
| Jungle Potion | `scripts/generated/quest-junglepotion.ts` | 651, 650, 649 | MEASURED 3/3 |
| Tribal Totem | `scripts/generated/quest-totem.ts` | 340, 352, 343 | MEASURED 3/3 |
| Elemental Workshop | `scripts/generated/quest-elemental.ts` | 206, 209, 194 | MEASURED 3/3 |
| Shades of Mort'ton | `scripts/generated/quest-mortton.ts` | 1908, 1944, 1956 | MEASURED 3/3 |

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

### Biohazard

`RESULT ok qp=3 xp=attack=2000,hitpoints=660,magic=3050,thieving=31250 ... ticks=1662 ... walkTicks=1002 retries=9
died=false` (runs: 1662, 1655, 1672 ticks; a passing trial before the proof: 1559; an earlier 3-run proof was 2/3, the
first run failed on the pigeon pickup, fixed below), each with `Congratulations! Quest complete!`. Steps (proof run 1
MILESTONE ticks; `quests/quest_biohazard/scripts/` unless named): Elena "I'll try to retrieve it for you." (1,
`areas/area_ardougne_east/scripts/elena.rs2:118-134`) 0-24; out of her door (`elenadoor2` 2054 at 2592,3339), Jerico's
door (`loc_1530` at 2610,3324), Jerico (2, `jerico.rs2:34-44`) 24-90; his cupboard (2056 at 2611,3326) gives the
birdfeed, a pigeon cage (obj 424 at 2618,3323-3325), the birdfeed on the watch tower (2067, 3), the cage opened in its
zone (4, `quest_biohazard.rs2:24-52`) 90-183; Omart "Ok, lets do it." over the wall (5, `areas/area_ardougne_west/
scripts/omart.rs2`) 183-229; the rotten apple (obj 1984 at 2535,3333), the fence climbed (`mournerstewfence` 2068 at
2541,3331, `general_use/scripts/fence.rs2`), the apple in the cauldron (2043 at 2543,3332, 6) 229-316; the nurse's
cupboard (2062 at 2517,3276, hut door at 2519,3275) gives the doctors' gown, worn; the HQ door (2036 at 2551,3320), the
stairs room door (`loc_1530` at 2546,3325), the stairs, the upstairs door (2034); the sick mourner (level 13) killed for
the key (`areas/area_ardougne_west/scripts/mourner.rs2:68-79`) 316-540; the key on the gate (2060 at 2551,3325,1), the
crate (2064 at 2554,3327,1) gives the distillator (7) 540-553; Ardougne teleport, Elena (10: three vials and the sample,
`elena.rs2:61-99`) 553-639; the walk to Rimmington, the chemist's door (`loc_1533` at 2932,3213), "It's ok, I'm Elena's
friend.", "I just need some touch paper for a guy called Guidor." (12, `chemist.rs2:50-91`) 639-1046; the vials to
Hops (broline), Chancy (honey), DeVinci (ethenea) 1046-1100; the walk to Varrock, the east gate (2050 at 3264,3405;
the guard searches, `areas/area_varrock/scripts/east_gate.rs2:9-37`), the vials back at the Dancing Donkey Inn
1100-1386; the priest gown and robe worn, Guidor's door (2032 at 3282,3382), Guidor (14, `guidor.rs2:15-72`) 1386-1455;
Ardougne teleport, Elena (15) 1455-1559; the castle stairs (1722 at 2571,3295), King Lathas's door (`loc_1536` at
2575,3293,1), "I don't understand..." queues the completion (`areas/area_ardougne_east/scripts/king_lathas.rs2:41-68`)
1559-1662.
Findings:
- A teleport destroys the plague sample (`skill_magic/scripts/spells/teleport.rs2:94-97`), and the chemist and Guidor
  both need it (`chemist.rs2:52-54`, `guidor.rs2:47-50`). So East Ardougne to Rimmington (407 ticks) and Rimmington to
  Varrock (about 290 ticks with the inn) are walked: 700 of the 1,660 ticks.
- The Dancing Donkey Inn and Guidor's house are outside the Varrock east gate; from Rimmington the walk can reach them
  only through that gate. The guard searches the bot on each pass (state 10-13). In a trial the walker clicked the gate
  again after the search, went back in, and repeated it to the tick cap; the script clicks it once and waits.
- Elena's script closes the dialog twice with a `p_delay(2)` before it gives the vials (`elena.rs2:70-99`). A new click
  in that gap cancels it: a trial handed her the distillator twice and got no sample. The script clicks once and waits.
- Doors shut by default on this route: Elena's (it walks the bot through and shuts behind it), Jerico's, the nurse's
  hut, the HQ stairs room, the chemist's and King Lathas's. Each shut door gave "I can't reach that!" or a stall of
  50-270 ticks in a trial; the script opens each by tile.
- From the HQ upstairs the walk out stalled twice (92 and 272 ticks) in the stairs room with five mourners round the
  door. An Ardougne teleport from upstairs is quicker and skips Kilron's ladder.
- The three pigeon cages lie on 2618,3323-3325; the nearest got "I can't reach that!" in proof run 1 of the first proof,
  so the pickup tries the next pile on each retry.
- Untradeable: birdfeed, pigeons, key, distillator, the vials, sample, touch paper, doctors' gown
  (`quest_biohazard.obj`). Helper items: priest gown and robe, runes for two Ardougne teleports (all tradeable).

### Nature Spirit

`RESULT ok qp=2 pouch=0 xp=attack=13500,hitpoints=4465,prayer=2250,agility=1875 ... ticks=823 ... walkTicks=317 retries=4
died=false` (runs: 823, 830, 791 ticks; a passing trial before the proof: 795), each with `Congratulations! Quest
complete!`. Preset `quest_druidspirit`: beside Drezel in the mausoleum (spawn 3440,9895, `maps/m53_154.jm2`), The
Restless Ghost done (107 = 5) with the amulet of ghostspeak worn, Priest in Peril done (302 = 60), the wolfbane dagger
and a silver sickle in the pack. Steps (proof run 1 MILESTONE ticks; `quests/quest_druidspirit/scripts/` unless named):
Drezel twice, the barrier talk (302 = 61, `areas/area_mausoleum/scripts/drezel.rs2:8-19,138-147`), then "Is there
anything else interesting to do around here?", "Well, what is it, I may be able to help?", "Yes, I'll go and look for
him.", "Yes, I'm sure." (5, `drezel.rs2:275-332`) 0-55; the holy barrier (3443 at 3440,9886) to 3423,3485
(`holy_barrier.rs2:1-9`), the Mort Myre gate (3506/3507 at 3443-3444,3458; 10, `quest_druidspirit.rs2:4-16`) 55-83;
the walk round the swamp to 3440,3327 and the bridge jump (`druidjump_loc` 3522, `quest_druidspirit.rs2:26-61`) 83-160;
the bowl (obj 2964 at 3437,3337) puts the mirror under it (`:63-78`); the grotto entrance (3516 at 3440,3337) spawns
Filliman, "How long have you been a ghost?" (20, `filliman.rs2:255-261`) 160-202; the mirror on him (25,
`filliman.rs2:271-293`) 202-220; the grotto tree (3517 at 3439,3338) gives the journal (`quest_druidspirit.rs2:84-90`),
the journal on him and "How can I help?" give the bloom spell (30, 35, `filliman.rs2:294-348`) 220-259; the bridge, the
gate, the trapdoor by the barrier exit (3432 at 3422,3485 to 3440,9887, `holy_barrier.rs2:11-20`), Drezel blesses the
bot (40, `drezel.rs2:228-245`) 259-394; the barrier, the gate, the bloom spell cast on 3430,3330 next to the rotting log
(3508 at 3429,3331), the fungus picked (45, 50, `quest_druidspirit.rs2:196-233,383-394`) 394-494; the bridge, the
grotto entrance, Filliman (55, `filliman.rs2:63-77`) 494-537; the fungus on the nature stone (3527 at 3439,3336), the
used spell on the spirit stone (3529 at 3441,3336), the bot on the faith stone (3440,3335), "I think I've solved the
puzzle!" (60, `quest_druidspirit.rs2:135-194`, `filliman.rs2:384-407`) 537-563; the grotto (65), its Search spawns
Filliman, who transforms (70), a second Search with the sickle blesses it and gives the empty pouch (75,
`filliman.rs2:26-58,165-195`) 563-611; out, the bridge, the sickle's Cast Bloom on 3430,3330 (80), three harvests (85),
the pouch filled (90, `quest_druidspirit.rs2:235-331`) 611-650; three ghasts (95-105, `ghast.rs2:1-37,131-142,204-216`)
650-769; the bridge, the grotto, the Nature Spirit queues the completion (`filliman.rs2:129-160`) 769-823.
Findings:
- Filliman's camp (3434-3448,3330-3344) has no walk path from the north: the SDK planner finds none from inside the
  camp to the swamp. The only way in or out is the bridge jump at 3440-3441,3329-3331. From the camp the bot must click
  the bridge end at 3440,3331; a click on the far end gets "I can't reach that!" (a trial lost 85 ticks there).
- The mirror stays in the pack after Filliman takes it (`filliman.rs2:284-291` has no `inv_del`); the journal goes
  (`:313`). Each of these uses opens a multi-page dialog, so the step waits for the dialog, not the item.
- The Mort Myre gate walls lie on the south edge of 3443-3444,3458: outside is z 3458 and up, not 3459.
- Ghasts are aggressive to any combat level (`all.hunt` `aggressive_melee`: `check_nottoostrong=off`) and attack at
  most once per 26 ticks (`ghast.rs2:14`); with a charged pouch the attacker turns visible. The 3 kills took 93-121
  ticks in the proof. The script also uses the pouch on a hidden ghast within 6 tiles (`ghast.rs2:39-45`); which of
  the two turned each ghast visible is not logged.
- In Search of the Myreque needs a druid pouch with 5 charges or more (`quest_routequest/scripts/
  routequest_morton.rs2:191-200`). The script picks a pear (3 charges) before a stem (2) or a fungus (1)
  (`quest_druidspirit.rs2:302-319`); runs 2 and 3 ended with 6 charges, run 1 with 0 (the cause is not logged). The
  pouch is tradeable (`quest_druidspirit.obj`), so a helper can bring one.
- The silver sickle is tradeable (`skill_crafting/configs/jewellery/silver.obj`); the blessed sickle, mirror, journal,
  spells and harvests are not (`quest_druidspirit.obj`). Helper items: silver sickle. The wolfbane dagger must be in the
  pack, bank or worn, or Drezel gives a new one first (`drezel.rs2:9-18`).

### In Search of the Myreque

`RESULT ok qp=2 pouch=8 xp=attack=20500,strength=15000,defence=15000,hitpoints=16822,crafting=15000 ... ticks=819 ...
walkTicks=302 retries=2 died=false` (runs: 819, 852, 846 ticks; a passing trial before the proof: 824), each with
`Congratulations! Quest complete!`. Class L in `quests-rest`, but the row `quests-medium` holds it with the other
measured `rest` quests. Preset `quest_routequest`: in the Hair of the Dog inn, Canifis, beside Vanstrom Klause (spawn
3503,3477), Nature Spirit done (307 = 110) with the blessed sickle and a druid pouch of 6 charges, 302 = 61; helper items
the 6 steel weapons, 6 planks, 30 steel nails, a hammer and 20 coins. Steps (proof run 1 MILESTONE ticks;
`quests/quest_routequest/scripts/` unless named): Vanstrom "Why do they need help? Are they in trouble?", "Perhaps I
could help you out here.", "Yes, I'll do it!" (5, `routequest_vanstorm.rs2:74-153`) 0-36; the Mort Myre gate, the walk to
the Nature Spirit bloom spot (3430,3330), the sickle's Cast Bloom and the pouch filled (`quest_druidspirit/scripts/
quest_druidspirit.rs2:235-331`) 36-183; the walk to Mort'ton, Cyreg Paddlehorn "Well, I guess they'll just die without
weapons.", "Resourceful enough to get their own steel weapons?", "If you don't tell me, their deaths are on your
head!", "What kind of a man are you to say that you don't care?" (10, 15), the pouch and "Give wooden planks to Cyreg."
(20, `routequest_morton.rs2:57-221`) 183-373; the boat (5051 at 3523,3284), "Yes, I'll pay ten gold." to the Hollows
(25, `:1-55`) 373-395; the tree (5005 at 3502,3426) up, the three rungs at 3502,3428-3430 repaired, the tree at 3502,3431
down (52, `routequest_hollow.rs2:48-185`) 395-458; Curpile Fyod "I've come to help the Myreque, I've brought weapons.",
three questions (55, `:236-395`) 458-504; the door (5060/5061 at 3509-3510,3447) to 3500,9811 (60, `:1-29`) 504-518; the
stalagmite (5050 at 3492,9824) to level 3, Veliaf (65), Sani, Harold, Radigad, Polmafi and Ivan, each "Ok, thanks."
(`routequest_myreque.rs2:118-407`) 518-652; Veliaf takes the weapons, the cutscene (70, 80, `route_cutscene.rs2`)
652-715; the skeleton hellhound (level 97) killed (85, `routequest_myreque.rs2:584-616`) 715-739; Veliaf "How do I get
out of here?" (90, `:502-527`) 739-761; the tunnel (5046 at 3505,9831), the wall (5052 at 3480,9837; 95), the ladder
(5054 at 3477,9846) to Canifis (97, `:29-53,100-112`) 761-787; the stranger in the inn queues the completion
(`routequest_vanstorm.rs2:33-72`) 787-819.
Findings:
- Cyreg wants a druid pouch with 5 charges or more (`routequest_morton.rs2:191-200`), and each ghast attack in Mort Myre
  spends a charge (`ghast.rs2:24-26`). The walk from Canifis to Mort'ton goes through the swamp past Filliman's bridge,
  so the script tops up the pouch at the Nature Spirit bloom spot with the blessed sickle (inside the 147-tick
  leg from Vanstrom; the top-up alone is not timed). The pouch had 11-12 charges after the top-up and at Cyreg; it
  ended with 8-11.
- The rope bridge rungs (`swamp_bridge1` 5002 at 3502,3427-3430, a bridge level in `maps/m54_53.jm2`) are not in the
  SDK's nearby locs (`WARN rung locs: 5005@3502,3426 Climb up/Climb down`). The script sends Repair (op5) by tile.
- Curpile asks 3 of 6 questions at random (`routequest_hollow.rs2:357-366`); the answer depends on the question, and
  "Sani Piliu" is an option in 4 of them, so the script reads the question header before it picks.
- The 5 members stand on level 3 before the ambush and on level 0 after it (`knowledge/npcs.json` spawns); the cutscene
  ends on level 0 with the hellhound at 3506,9834 (`route_cutscene.rs2:183-189`).
- Helper items (all tradeable): steel longsword, 2 steel swords, steel dagger, steel mace, steel warhammer, 6 wooden
  planks, 30 steel nails, a hammer. The blessed sickle and the pouch come from Nature Spirit.

### Haunted Mine

`RESULT ok qp=2 shard=false xp=hitpoints=3350,magic=18862 ... ticks=1017 hpMin=47 eats=1 walkTicks=377 retries=5
died=false` (6 runs in a row with the final script, two 3-run proofs: 1,423, 1,304, 1,574, 1,017, 1,163, 1,011 ticks;
the earlier fight logic measured 1,092, 1,225, 1,018 in its one 3/3 proof),
each with `You cut a shard from the crystal. / Congratulations! Quest complete!`. Class L in `quests-rest`; the row
`quests-medium` holds it. Preset `quest_hauntedmine`: south of the Zealot (spawn 3444,3258, `maps/m53_50.jm2`) at
3444,3256, the state after In Search of the Myreque (107 = 5, 302 = 61, 307 = 110), a staff of fire (1387) in the weapon
slot, 40 blood and 200 air runes (Fire Wave), a chisel, 21 sharks (385). Debug preset `quest_hauntedmine_lift` with
`HM_FROM=lift` starts at the cart-end ladder with the lift key and a fungus. Steps (proof run 1 MILESTONE ticks;
`quests/quest_hauntedmine/scripts/` unless named): the Zealot, Saradomin, "I come seeking challenges and quests.", "What
quest is that then?" (1), "Is there any other way into the mines?" (the key bit, `zealot.rs2:1-201`), Pickpocket for
the lift key (`:287-304`) 0-67; over the cart obstacle and in by the secondary entrance (3, `hauntedmine_locs.rs2:1-8`)
67-87; out by back entrance 1 to the ledge, in by back entrance 2, two ladders and the cart-1 lane to the fungus area
87-203; a glowing fungus into the cart, the controls read, the levers set, the cart sent (`hauntedmine_points.rs2`,
`hauntedmine_fungus.rs2:54-69`) 203-349; back out the same way, in by back entrance 1, two ladders to the cart end and
the fungus (`hauntedmine_fungus.rs2:71-82`) 349-533; the cart-4 lane, the key on the valve (4) and the lift (5,
`hauntedmine_lift.rs2:8-91`) 533-635; the east dark stairs with the fungus (7, `hauntedmine_darkstairs.rs2:34-47`)
635-660; the boss door and the key (8, `hauntedmine_boss_ghost.rs2:18-92`) 660-684; Treus Dayth killed with Fire Wave
(9, `:244-254`) and the key taken 684-973; out, down the light stairs, up the west stairs to the reward door (10,
`hauntedmine_crystals.rs2:1-29`) 973-1036; a crystal cut (complete, `:39-56`) 1036-1092.
Findings:
- The map has four walk areas joined by ladders and crawl holes (SDK collision, `maps/m53_150`, `m43_71`, `m42_70`,
  `m43_70`): the fungus area (mushrooms, cart start, the controls and the 8 levers) joins the lift side only through the
  surface, and a fungus crumbles when its carrier crawls out (`hauntedmine_fungus.rs2:38-52`). So the fungus goes by
  cart: success needs bits b=1, a=1, c=0, d=0, j=0 (`hauntedmine_points.rs2:18-30`), lever n toggles bit n
  (`:130-148`; a = bit 2, b = 1, c = 3, d = 4, j = 7, `hauntedmine.constant:14-21`). The varp is not transmitted;
  the script reads the bits from the controls' models (`if_setmodel` 4914-2n, mirrored 4915-2n, `:6-13`) through
  `LiteClient.ifMutable(com).model1Id`.
- The haunted carts (`hauntedmine.npc:300-355`) patrol one-tile lanes and push a player on the tile ahead
  (`hauntedmine_cart.rs2:1-13`). Cart 1 (x 2727, z 4491-4509) blocks the only way to the fungus-area ladder; the
  script waits beside the lane (side steps 2728,4503 and 2726,4496 from the SDK collision), lets the cart pass and
  runs. Cart 4 (x 2739, z 4528-4531) blocks the way to the lift area; the script goes when the cart is one tile from
  its south stop, because NPCs move before players in a tick.
- The boss fight was the fragile part: 6 earlier 3-run proofs of earlier fight logic passed 2, 2, 1, 0, 2 and 1 runs.
  Causes found (logs `hm-*` of this work, BOSS lines):
  - Each 5 ticks the ghost attacks by where the PLAYER stands (`hauntedmine_boss_ghost.rs2:112-147`): on a track zone a
    cart pushes the player along the track (`:157-195`), near a crane the crane hits, else a pickaxe (max 15, 10 under
    Protect from Missiles, `:228-241`). The pushes along the z 4462 track end in the north-east corner (x 2791-2797,
    z 4457-4461), which joins the room only across the z 4456 track; a cart on that track holds the player there.
  - Fire Wave is an ap trigger (`skill_combat/scripts/player/player_magic.rs2:40`); the server walks the caster until
    it has line of sight (`engine/src/engine/GameMap.ts:485-487`). The SDK collision has no projectile flags in this
    room (0 tiles with `LOC_PROJ_BLOCKER`), so it cannot predict the line of sight; a first version that cast only
    from SDK line-of-sight tiles stood still and cast dry (no Magic XP) from 2783,4454.
  - A ghost killed while it is faded stays at 0 hitpoints: the retaliation queue (the move with the fade, 1 in 2) runs
    before the damage queue of the same hit (`player_magic.rs2:227-231`, `npc_combat.rs2:367-368`), and only
    `hauntedmine_boss_ghost` has the death queue (`hauntedmine_boss_ghost.rs2:247-249`). The NPC list then shows
    `Treus Dayth hp=0/100`, more casts do nothing, and the key is blocked while it lives (`:23-26`). This happened once in
    3 of the 6 final runs and up to 3 times a fight in the trials; a fight that waits it out runs out of food.
  The kept logic: Protect from Missiles on in the room; per ghost spot (`:308-342`) a cast tile that hit in the trials
  (E 2794,4454 / 2794,4453; NE 2796,4457; N 2787,4461 by the z 4461 row from its west end; NW 2780,4459 / 2779,4458;
  W 2786,4454; S 2786,4446 by the x 2786 column), a tile with a dry cast or a failed walk is skipped; off a track or
  out of the corner at once; a ghost at 0 hitpoints for 8 ticks: out of the door, past the door zone (x 2799-2807,
  `:101-105,117-123`) to 2809,4453 and back, so the timer deletes the ghost and the key wakes a new one (up to 4
  rounds); from the corner the walk to the key waits for the cart to leave the z 4456 track; 21 sharks (heal 20),
  eat at 55. The 6 final runs: hpMin 41-54, eats 1-11, 0-1 stuck-ghost rounds each.
- Agility 15 and Crafting 35 are journal text only; no script checks them (`hauntedmine_journal.rs2:77-81`; no
  `stat` check in the quest scripts). The quest XP is 22,000 Strength (`hauntedmine_crystals.rs2:54`); the RESULT
  `xp=` field did not show a Strength gain (not explained).
- Helper items (tradeable): staff of fire, blood and air runes, chisel, lobsters. The keys, fungus and shard are quest
  items (`hauntedmine.obj`).

### Demon Slayer

Preset `quest_demon` in `packages/practice/src/presets-rest.ts` (the base of the qp-filler presets: every skill 99, the
combat rune set, the quests before the dragon row plus Dragon Slayer, Merlin's Crystal and Fight Arena done).
`RESULT ok qp=3 xp=attack=700,hitpoints=230,magic=875 ... ticks=899 ... walkTicks=474 retries=6 died=false` (runs: 899,
877, 882 ticks), each with `Prysin hands you an impressive looking sword.` and `Congratulations! Quest complete!`.
Steps (run 1 MILESTONE ticks): Gypsy Aris, 1 coin, "Who's Delrith?", "Okay, where is he?" sets 1 0-70
(`areas/area_varrock/scripts/gypsy.rs2:159-232`); Sir Prysin in the palace's south-west room (door `loc_1536` 3206,3472)
"Gypsy Aris said...", "I need to find Silverlight.", "So give me the keys!" sets 2 70-160 (`sir_prysin.rs2:78-123`);
the walk to the Wizards' Tower, Traiborn on level 1 "I need to get a key...", "Well, have you got any keys knocking
around?", "I'll get the bones for you." sets 3, then 25 bones, one per `p_delay(1)`, give key 1 160-476
(`areas/area_draynor/scripts/traiborn.rs2:1-32,130-215`); Varrock Teleport, Captain Rovin on palace level 2 "Yes, I
know, but this is important.", "There's a demon..." gives key 2 476-596 (`captain_rovin.rs2:27-45`); the bucket spawn on
level 1 above the kitchen (3221,3497,1, behind the door `loc_1530` 3221,3496), filled at the kitchen sink (3224,3494) and
poured down the drain (3225,3495) drops key 3 at 3225,9897 for 300 ticks 596-656 (`quest_demon/scripts/demon_slayer.rs2:
31-47`); the manhole east of the palace (3237,3458, `general_use/scripts/manholes.rs2:1-10`), key 3, the ladder out
656-739; Prysin takes the 3 keys and gives Silverlight (29) 739-813; Silverlight wielded, Delrith in the stone circle
south of Varrock, at 0 HP the incantation "Carlem Aber Camerinthum Purchai Gabindo" (option 4,
`quest_demon/scripts/delrith.rs2:15-55`) 813-899.
Findings:
- The 28 slots hold 25 bones, 1 coin, 1 law and 1 fire rune (Varrock Teleport with a staff of air wielded). So the
  preset carries no food and no bucket. Traiborn must come before the Varrock Teleport: the bones need 25 slots, and the
  teleport runes do not fit with a bucket of water as well.
- The keys and Silverlight are `tradeable=no` (`demon.obj`). Delrith can be attacked only with Silverlight wielded
  (`skill_combat/scripts/npc/npc_combat.rs2:174-186`). The incantation is fixed in rev 289 (`gypsy.rs2:240-246`).
- Explicit tiles fixed 5 failed trials: the SDK walker took the bot round the outside of the tower's west wall (the doors
  3109,3166 and 3107,3162 are now named); the kitchen stairs need the kitchen door 3223,3491; the bucket room door
  3221,3496,1; the ladder 3230,3504 north-east of the palace stands inside a walled ruin with no way in, so the bot uses the
  manhole; Traiborn's bones close the dialog for each `p_delay(1)`, so the bot clicks the pages and does not talk again.
- Helper items: 25 bones, 1 coin, 1 law rune, 1 fire rune, staff of air. All are tradeable (`knowledge/items.json`).

### Jungle Potion

Preset `quest_junglepotion` in `packages/practice/src/presets-rest.ts`: beside Trufitus in Tai Bwo Wannai, Druidic Ritual
done, 6 lobsters, no helper items. `RESULT ok qp=1 xp=herblore=19687 ... ticks=651 ... walkTicks=458 retries=1
died=false` (runs: 651, 650, 649 ticks; a trial before the proof: 653), each with `Congratulations! Quest complete!`.
Steps (trial MILESTONE ticks): Trufitus "It's a nice village, where is everyone?", "Me? How can I help?", "It sounds like
just the challenge for me." sets 1 0-37 (`areas/area_karamja/scripts/trufitus.rs2:233-309`); then for each herb a Search
(op2) of its loc, Identify, and "Of course!" to Trufitus (`quests/quest_junglepotion/scripts/quest_junglepotion.rs2:3-75`,
`trufitus.rs2:311-397`): snake weed at the marshy jungle vine 2760,3014 37-165; ardrigal at the palm 2870,3115 165-262;
sito foil at the scorched earth 2789,3047 262-355; volencia moss at the rock 2851,3035 355-442; rogues purse in the
caverns (Search the rocks 2824,3118, "Yes, I'll enter the cave.", the cavern wall 2869,9517, the hand holds 2830,9522
out) 442-643; the last give runs on into the completion 643-653 (`trufitus.rs2:389-423`).
Findings:
- A herb gives its "found" stage only when it is picked at its own "get" stage (`quest_junglepotion.rs2:51-75`), so the
  5 herbs are 5 trips from Trufitus. A helper cannot pre-pick them.
- The picked loc turns empty for 100 ticks (`:67-72`); each herb has 2-4 locs, so the bot searches the nearest full one.
- Trufitus takes only the identified herb (`trufitus.rs2:322-325`); Herblore 99 identifies all 5.

### Tribal Totem

Preset `quest_totem` in `packages/practice/src/presets-rest.ts`: beside Kangai Mau in Brimhaven, Plague City done (165 =
30) for Ardougne Teleport; 2 law and 2 water runes, 30 coins, 4 lobsters. `RESULT ok qp=1 xp=magic=1525,thieving=44375
... ticks=340 ... walkTicks=147 retries=4 died=false` (runs: 340, 352, 343 ticks; a trial before the proof: 350), each
with `Congratulations! Quest complete!`. Steps (trial MILESTONE ticks): Kangai Mau "I'm in search of adventure!", "Ok, I
will get it back." sets 1 0-20 (`areas/area_brimhaven/scripts/kangai_mau.rs2:16-54`); Ardougne Teleport, the label from
the horn crate (2650,3273) onto the teleport crate (2650,3271) in the RPDT depot sets 2 20-72
(`quests/quest_totem/scripts/quest_totem.rs2:8-31`); the RPDT employee "So, when are you going to deliver this crate?"
sets 3 72-82 (`areas/area_ardougne_east/scripts/rdpt_employee.rs2:1-8`); Wizard Cromperty "So what have you
invented?", "Can I be teleported please?", "Yes, that sounds good. Teleport me!" lands the bot beside the crate in
Handelmort's mansion (2638,3321) and sets 4 82-148 (`wizard_cromperty.rs2:23-81`); the crate room door 2636,3323, the
combination lock KURT (lock 1 +10, locks 2-4 -6 / -9 / -7, one button a tick, `quest_totem.rs2:33-120`) 148-189; Search
the stairs (Thieving 21, `:142-154`), climb, the chest on level 1 (2638,3324) 189-230; down, out by the totem door
(opens from inside, `:1-6`), Captain Barnaby to Brimhaven (30 coins, `captain_barnaby.rs2:1-2`), Kangai Mau takes the
totem 230-350 (`kangai_mau.rs2:66-74`).
Findings:
- The label and the totem are quest items; the totem cannot come from a helper before stage 4 (`kangai_mau.rs2:68`).
- An unsearched stairs drops the bot through a trap for 20% HP (`quest_totem.rs2:122-140`); Search first.
- The Cromperty teleport closes the dialog for a `p_delay(4)`; trial 1 tried to talk again inside it, so the bot now
  waits for the arrival tile. The 32 lock clicks are the longest idle (32-35 ticks); several clicks a tick are not tried.
- The planner puts `quests-rest` before `quests-medium` (`haggis-cli.ts --order`: rows 54 and 56), so this quest's
  Ardougne Teleport needs Plague City first. In `quests-medium` it comes after Plague City.

### Elemental Workshop

Preset `quest_elemental` in `packages/practice/src/presets-rest.ts`: in the Seers' Village house beside the bookcase; a
knife, needle, leather, thread, hammer, rune pickaxe, 4 coal and 6 lobsters from a helper. `RESULT ok qp=1
xp=attack=3500,hitpoints=1157,crafting=125000,smithing=125700 ... ticks=206 ... walkTicks=129 retries=0 died=false` (runs:
206, 209, 194 ticks; a trial before the proof: 200), each with `You make an Elemental Shield.` and `Congratulations! Quest
complete!`. The quest has no NPC talk; varp `%elemental_workshop_bits` (299) holds one bit a step. Steps (trial MILESTONE
ticks): the bookcase gives the battered book, read it, the knife on its spine gives the key 0-5
(`quests/quest_elemental_workshop/scripts/quest_elemental_workshop.rs2:1-12`, `elemental_workshop_shield_book.rs2:1-24`);
the key on the odd wall (2709,3495) and the stairs down 5-21 (`quest_elemental_workshop.rs2:14-45`); the stone bowl from
box 1, the right valve, then the left valve, then the water lever 21-52 (`:46-130`); the bellows (needle, leather,
thread) and the air lever 52-75 (`:132-183`); lava from the trough into the furnace 75-105 (`:150-162,208-221`); a Mine
click on an elemental rock wakes an earth elemental, its death drops the elemental ore 105-158 (`:185-206`,
`elemental_earth.rs2:1-7`); the ore and 4 coal in the furnace, the bar on the workbench with the book and the hammer
158-200 (`:226-268`).
Findings:
- The right valve toggles only while the left one is off (`:85-87`); so the order is right, left, lever.
- Earth elementals also roam the mine and drop no ore (`elemental_earth.rs2:9-27`). Trial 2 killed roaming ones (28,100 Attack XP) and got no
  ore, so the bot attacks only the elemental that appears beside it after its own Mine click.
- The key p_teleports the bot through the double door; trial 1 stopped on the door tile, so the step repeats until the
  bot is north of the wall.
- Helper items: knife, needle, leather, thread, hammer, rune pickaxe, coal. All are tradeable (`knowledge/items.json`).

### Clock Tower

Preset `quest_cog` in `packages/practice/src/presets-rest.ts`: beside Brother Kojo, north of the tower (spawn 2569,3249);
a bucket of water and 4 lobsters from a helper. `RESULT ok qp=1 xp= ... ticks=486 ... walkTicks=364 retries=1
died=false` (runs: 486, 472, 468 ticks; a trial before the proof: 487), each with `Congratulations! Quest complete!`.
Varp `%cogquest` (10) bits 0-3 count the stage (1 after Kojo, +1 a cog, 5 all four, 8 complete) and bit 4 is the rat
gate; `%cog_bits` (35) has one bit a cog (`quests/quest_cog/scripts/locs/quest_cog_spindles.rs2:1-75`,
`configs/quest_cog.constant:1-14`). One cog at a time (`objs/cogs.rs2:42-57`). The cellar parts join only through
one-way ladders (`knowledge/transports.json`), so each cog has its own way in and out. Steps (proof run 1 MILESTONE
ticks): Kojo, "OK old monk, what can I do?" 0-30 (`npcs/brother_kojo.rs2:9-18`); the tower ladder 2566,3242 down, water
on the black cog 2613,9639, take it, the black spindle 2570,9642 30-120 (`objs/cogs.rs2:16-40`); the red cog 2583,9613,
back up the ladder, the red spindle 2568,3243 on level 0 120-206; down again, the rat poison 2564,9662, the lever
2591,9661 opens gate 2595,9657, the poison on the trough 2586,9654 sets the gate bit 206-274
(`locs/quest_cog_gates_and_levers.rs2:28-42`, `locs/quest_cog_food_trough.rs2:1-18`); the gate 2579,9656, the white cog
2577,9655, the ladder 2575,9655 up to 2575,3255, the stairs to level 2, the white spindle 2567,3241 274-319; the ladder
2621,3261 east of the tower, the tunnel south and west, push the wall 2575,9631 from the east, the blue cog 2574,9633,
the ladder 2572,9631 up to 2572,3231, the blue spindle 2569,3240 on level 1 319-469; Kojo 469-486
(`brother_kojo.rs2:44-48`).
Findings:
- The black cog needs a bucket of water used on the ground item (OPOBJU, `objs/cogs.rs2:30-40`). The SDK has no
  item-on-ground-item action, so the script writes the OPOBJU packet on the lite client (field order from
  `engine/src/network/game/client/codec/OpObjUDecoder.ts`). Ice gloves also cool it but are untradeable (id 1580).
- Trial 1 stopped at the tower ladder with "I can't reach that!": doors (loc 1530) at 2574,3250 and 2567,3245 close
  Kojo's room and the middle room, so the script opens them by tile. The boarded-up closet door 2566,3237 never opens;
  the script marks it as a wall for the SDK plan.
- Helper item: a bucket of water (tradeable). The cogs and the rat poison are untradeable quest items.

### Hazeel Cult

Preset `quest_hazeelcult` in `packages/practice/src/presets-rest.ts`: beside Sir Ceril Carnillean in his house (spawn
2565,3271); no helper items, 4 lobsters. `RESULT ok qp=1 xp=attack=2500,hitpoints=827 ... ticks=435 ... walkTicks=177
retries=0 died=false` (runs: 435, 426, 435 ticks; a trial before the proof: 434), each with `Congratulations! Quest
complete!`. The bot takes the good side: one raft trip, against two hideout visits and the house chest on the evil side
(`quests/quest_hazeelcult/scripts/clivet.rs2:239-258`, `alomone.rs2:15-73`). Varp `%hazeelcultquest` (223). Steps (proof
run 1 MILESTONE ticks): Ceril, "What's wrong?", "Yes, of course, I'd be happy to help." sets 2 0-40
(`ceril_carnillean.rs2:8-31`); the 5 sewer valves 2572,3263, 2562,3247, 2585,3245 (turn left), 2597,3263, 2609,3243 (the
others turn right) set the 5 bits of `%hazeelcult_valves` (224) 40-151 (`quest_hazeelcult.rs2:42-70`); the cave
2585,3233, Clivet, "What do you mean?", "You're crazy, I'd never help you." sets 4 and side 0 151-222
(`clivet.rs2:147-158,228-272`); the raft 2567,9679 goes to the hideout end 2606,9692 with all 5 bits
(`quest_hazeelcult.rs2:11-40`), Alomone's talk turns him hostile, his death sets 6 and drops the armour 222-273
(`alomone.rs2:1-10,100-123`); a raft back to the cave mouth, the stairs 2570,9683 out to 2587,3237, the walk to the
house, upstairs, Ceril takes the armour (7, the "kind of completed" scroll) 273-373 (`ceril_carnillean.rs2:108-139`,
`quest_hazeelcult.rs2:159-167`); the cupboard 2573,3267 opened and searched with Ceril and Jones near completes the quest
373-435 (`quest_hazeelcult.rs2:81-122,169-175`).
Findings:
- Auto retaliate is off in the quest scripts, so the bot attacks Alomone itself after his "DIE!!!" line.
- The proof logs show no Thieving gain in `xp=` although the reward queue calls `stat_advance(thieving, 15000)`
  (`quest_hazeelcult.rs2:172`); the run ends on the quest-complete message, so the XP may land after the snapshot. Not
  checked further; the QP comes from the quest varp.

### Murder Mystery

Preset `quest_murder` in `packages/practice/src/presets-rest.ts`: beside the guard inside the Sinclair Mansion (spawn
2739,3577); 3 pots of flour, a law and 5 air runes (one Camelot Teleport) and 2 lobsters from a helper. `RESULT ok qp=3
xp=magic=1387,crafting=35150 ... ticks=302 ... walkTicks=133 retries=0 died=false` (runs: 302 (Bob), 345 (David), 338
(David) ticks; a trial before the proof: 271 (Bob)), each with `The finger prints are an exact match to ...` and
`Congratulations! Quest complete!`. The guard's start picks the murderer at random (`%murdersus` 1-6,
`quests/quest_murder/scripts/murder_guard.rs2:8-14`) and the bot cannot read varps, so the script finds the murderer
from the evidence. Steps (proof run 1 MILESTONE ticks): the guard, "Sure, I'll help." 0-28; the dagger 2746,3578 and the
thread on the window 2747,3577; its colour names two suspects (green Anna or David, red Bob or Carol, blue Elizabeth or
Frank) 28-55 (`quest_murder.rs2:228-256`); 2 flypapers from the sacks 2731,3582, flour and flypaper on the dagger give the
murderer's print 55-97 (`:204-215,292-324`); the first suspect's barrel item, flour, flypaper and the print check; a
mismatch destroys the print and the bot does the second suspect 97-126 (`:105-175,326-337`); Camelot Teleport, the poison
salesman 2737,3491, "Who did you sell Poison to at the house?" 126-167 (`area_seers/scripts/poison_salesman.rs2:32-36`);
the walk back, the murderer's "Why'd you buy poison the other day?" 167-231 (`anna.rs2:34-39`, the same in each suspect's
script); a search of the murderer's own loc (compost, beehive, drain, spiders' nest, fountain or crest) 231-251
(`quest_murder.rs2:1-103`); the guard, "I know who did it!" with all three proofs 251-302
(`murder_guard.rs2:36-53,132-152`).
Findings:
- The 3 proof runs drew Bob once and David twice. Debug presets `quest_murder_anna` .. `quest_murder_frank` start
  the quest (varp 192 `%murderquest` = 1) with the murderer forced (varp 195 `%murdersus` = 1-6; the guard rolls it at
  random, `murder_guard.rs2:12`). One run each, `RESULT ok qp=3`, each with `The finger prints are an exact match to
  <suspect>'s.` and `Congratulations! Quest complete!`: Anna 289, Carol 353, Elizabeth 395, Frank 288 ticks. A fresh
  `quest_murder` run after the script change drew Anna: 270 ticks. Elizabeth is the worst case: the second suspect of
  her pair (frank/elizabeth) and both barrels on level 1, then her poison loc, the fountain at 2747,3563, outside.
  The forced presets skip the start roll, but the guard step took 8-29 ticks in them against 18-28 fresh, so the
  forced runs are counted as they are. Row `quests-medium` now takes Murder Mystery as 302/345/338/270/289/353/395/288:
  floor 270, realistic 395; the row is 18 quests, 31 QP, floor 14,239 / realistic 15,258. `bun test
  packages/planner`: 42 pass, 0 fail. `haggis-cli.ts research/hiscores-live.json --levers`: QP at end 145; Quest Points
  WIN at 105,178 floor / 124,993 realistic.
- Forced Anna trial 1 failed at the guard: the nearest guard stood in the hall south of the shut door 2741,3576 (loc
  1533) and the client found no route (`I can't reach that!`). The script now opens that door before the guard talk.
- Trial 1 stood west of Bob's barrel (2733,3578) behind the wall: "I can't reach that!". The script now stands on a
  named tile beside each barrel and the spiders' nest.
- Trial 2: the print mismatch opens a mesbox before the `inv_del` (`quest_murder.rs2:336-337`), so the item-on-item
  helper waits a tick after the dialog closes before it checks the inventory.
- Helper items: pots of flour and runes (tradeable). The flypaper is untradeable (`knowledge/items.json` id 1811) and
  comes from the sacks; each sack search is a mesbox, a choice and a mesbox.

### Observatory Quest

Preset `quest_itgronigen` in `packages/practice/src/presets-rest.ts`: beside the professor in the reception (spawn
2438,3186); 3 planks, a bronze bar, a molten glass and 4 lobsters from a helper. `RESULT ok qp=2 xp=crafting=56250 ...
ticks=550 ... walkTicks=335 retries=4 died=false` (runs: 550, 555, 550 ticks; a trial before the proof: 549), each with
`Congratulations! Quest complete!`. Varp `%itgronigen`. Steps (proof run 1 MILESTONE ticks): the professor, "I'd like to
have a look through that telescope.", "Sounds interesting, what can I do for you?" (1), then one talk each for the
planks, the bronze bar and the glass (2-4) 0-85 (`quests/quest_itgronigen/scripts/observatory_professor.rs2:16-59,132-180`);
the reception ladder 2444,3191 down to the cavern, the walk round to the south-east chest 2428,9419, open and search it
for the keep key 85-223 (`quest_itgronigen.rs2:1-14,40-98`); the key on the keep gate 2391,9457 (locked from the north,
`:100-150`) and the mould under the sack 2389,9454 223-313 (`:164-172`); back out of the gate, up the ladder 2420,9460,
the professor takes the mould and gives the glass back (5), the glass on the mould makes the lens, the lens (6) 313-404
(`observatory_professor.rs2:61-100`, `quest_itgronigen.rs2:174-185`); down again, through the cavern to the ladder
2423,9439 up into the observatory, the telescope with the second professor near, "I can see a constellation." 404-550
(`:152-162,187-270`).
Findings:
- The observatory has no way in on foot (the SDK plan from the reception ends outside, at 2444,3173); its only way in is
  the ladder from the cavern, so the cavern is crossed twice.
- The keep gate is the north wall of 2391,9457 and p_teleports one tile, so the keep side is z <= 9457; trial 1 waited
  for z < 9457 and stopped there.
- The constellation gift is random (`quest_itgronigen.rs2:195,220-260`); run 2 drew Virgo (21,875 Defence XP).
- Helper items: planks, bronze bar, molten glass (tradeable). The keep key, the lens mould and the lens are untradeable
  (`knowledge/items.json` 601-603).

### Death Plateau

Preset `quest_death` in `packages/practice/src/presets-rest.ts`: beside Denulth in the Imperial Guard camp (spawn
2896,3528); 10 bread, 10 trout, an Asgarnian Ale, a Blurberry Special, an iron bar and 500 coins from a helper, no food.
`RESULT ok qp=1 xp=attack=75000 ... ticks=1192 ... walkTicks=665 retries=3 died=false` (runs: 1,192, 1,193, 1,201 ticks;
trials before the proof: 1,304, 1,282, 1,197), each with `Congratulations! Quest complete!`. Two tracks; varps
`%death_equiproom` and `%death_map` (`quests/quest_death/configs/quest_death.constant`). Steps (proof run 1 MILESTONE
ticks): Denulth, "Do you have any quests for me?", "No but perhaps I could try and find one?" (10, Harold's gold set to
100) 0-48 (`death_ig_commander.rs2:91-120`); Eohric on castle level 1 (20), Harold at the Toad and Chicken (30), Eohric
again (40) 48-265 (`death_headservant.rs2:1-55`, `death_guard_equiproom.rs2:264-273`); the ale (50) and the Blurberry
Special (Harold very drunk) 265-404 (`:275-338`); "Would you like to gamble?", a 101-coin bet, the roll; very drunk,
Harold always loses, and a win above his 100 gold gives the IOU (55) 404-455 (`:126-185,207-249`); reading it gives the
combination (60) 455-466 (`quest_death.rs2:27-35`); the 5 stone balls from x 2893 onto the mechanism by the castle door
(Blue 2894,3562, Yellow 2895,3562, Red 2894,3563, Purple 2895,3563, Green 2895,3564) unlock the door (70) 466-537
(`quest_death.rs2:37-44,83-101`); Saba in the hermit cave (map 1), Tenzing (2, his climbing boots), Dunstan (3), Denulth's
certificate (4), Dunstan takes it (5) and spikes the boots for the iron bar 537-912 (`death_saba.rs2:32-56`,
`death_sherpa.rs2:150-178`, `death_smithy.rs2:16-48,187-210`, `death_ig_commander.rs2:157-184`); Tenzing takes the food
and the boots (6) and draws the map (7); the back door, the stile 2817,3562 and the secret way to the zone at 2864,3609
(8) 912-1057 (`death_sherpa.rs2:119-147,181-190`, `quest_death.rs2:46-71,103-118,130-136`); back over the stile and
through the hut, Denulth takes the map and the combination 1057-1192 (`death_ig_commander.rs2:186-221`).
Findings:
- The dice: the roll button (`death_dice:com_28`) needs protected access, so a click inside `harold_roll`'s 3
  `p_delay(2)` gets no effect (Player.ts `runScript`); trial 2 clicked at 7 ticks and lost the bet. The script waits 12
  ticks. The queued `haroldgamble_end` writes the IOU only when the dice modal is closed (Player.ts `processQueue`,
  `canAccess`), so the script closes it after the roll (trial 7).
- The stairs top of the inn (2914,3540) is outside Harold's room; Harold's door (2906,3543) is knocked from the row
  z 3543. Dunstan's smithy door (2921,3571) and Tenzing's two doors are opened by tile.
- The secret way has no way down to Burthorpe (the SDK plan ends at 2881,3596, trial 5), so the bot goes back over the
  stile and through the hut.
- Inventory: 10 bread, 10 trout, coins, the iron bar and the combination leave exactly 5 slots for the stone balls.
- Helper items: bread, trout, ale, Blurberry Special, iron bar, coins (tradeable). The IOU, the combination, the
  certificate, the map and the stone balls are untradeable (`knowledge/items.json` 3102-3104, 3109-3114).
- Row `quests-rest` counted 1 medium quest before this step while the table lists 2 unproven medium rest quests (Big
  Chompy Bird Hunting and Death Plateau); after this delta the row counts 0 medium.

### Planner change for the medium quests

New row `quests-medium` in `packages/planner/src/haggis-boards.json` (MEASURED), after `quests-short`: Pirate's
Treasure (2 QP, 460 / 474), The Knight's Sword (1 QP, 887 / 922), Plague City (1 QP, 749 / 784), Priest in Peril
(1 QP, 993 / 1,011), Biohazard (3 QP, 1,655 / 1,672), Nature Spirit (2 QP, 791 / 830) and In Search of the Myreque
(2 QP, 819 / 852): 12 QP, floor 6,354 ticks (sum of best runs), realistic 6,545 (sum of worst runs), the same under
`rival-dialogue-burst`. Each left `quests-rest` as a delta on the committed row: after Nature Spirit (medium, 900 /
1,300) 28 quests, 64 QP, 47,900 / 72,300; after In Search of the Myreque (long, 1,800 / 2,600) 27 quests, 62 QP,
46,100 / 69,700 (burst 42,633 / 64,459), 9 medium and 10 long. `bun test packages/planner`: 42 pass, 0 fail.
`haggis-cli.ts research/hiscores-live.json --levers`: QP at end 145; Quest Points WIN at 102,037 floor / 132,741
realistic. Row `quests-rest` loses them one medium class (900 /
1,300) each; with Lost City also moved out by another helper it was 29 quests after Biohazard, 66 QP, 48,800 / 73,600 (burst
45,130 / 68,065). The QP total stays 145. The helper's `medium-row.ts` writes `quests-medium`; for `quests-rest` it
assumed a fixed base, so after Lost City moved the Biohazard step was applied as a delta on the committed row
instead. `bun test packages/planner`: 42 pass, 0 fail. `bun packages/planner/src/haggis-cli.ts
research/hiscores-live.json --levers` after Biohazard: QP at end 145; Quest Points WIN at 102,924 floor / 134,446
realistic (deadline 1,022,262); Overall 40,545 / 45,211 at this commit (the other rows moved since Priest in Peril).

After Haunted Mine (long, 1,800 / 2,600) `quests-rest` is 26 quests, 60 QP, 44,300 / 67,100 (burst 40,969 / 62,054),
9 medium and 9 long; `quests-medium` is 8 quests, 14 QP, floor 7,372 / realistic 7,770 (a text splice of the two rows;
the file is no longer `JSON.stringify` format). `bun test packages/planner`: 42 pass, 0 fail. `haggis-cli.ts
research/hiscores-live.json --levers`: QP at end 145; Quest Points WIN at 101,946 floor / 130,524 realistic.

After Demon Slayer (medium, 900 / 1,300) `quests-rest` is 25 quests, 57 QP, 43,400 / 65,800 (burst 40,136 / 60,852), 8
medium and 9 long; `quests-medium` is 9 quests, 17 QP, floor 8,249 / realistic 8,669 (a text splice of the two rows).
`bun test packages/planner`: 42 pass, 0 fail. `haggis-cli.ts research/hiscores-live.json --levers`: QP at end 145; Quest
Points WIN at 105,723 floor / 130,958 realistic.

After Jungle Potion (medium, 900 / 1,300) `quests-rest` is 24 quests, 56 QP, 42,500 / 64,500 (burst 39,304 / 59,650), 7
medium and 9 long; `quests-medium` is 10 quests, 18 QP, floor 8,898 / realistic 9,320. `bun test packages/planner`: 42
pass, 0 fail. `haggis-cli.ts research/hiscores-live.json --levers`: QP at end 145; Quest Points WIN at 106,173 floor /
130,517 realistic.

After Tribal Totem (medium, 900 / 1,300) `quests-rest` is 23 quests, 55 QP, 41,600 / 63,200 (burst 38,472 / 58,447), 6
medium and 9 long; `quests-medium` is 11 quests, 19 QP, floor 9,238 / realistic 9,672. `bun test packages/planner`: 42
pass, 0 fail. `haggis-cli.ts research/hiscores-live.json --levers`: QP at end 145; Quest Points WIN at 106,661 floor /
130,130 realistic.

After Elemental Workshop (medium, 900 / 1,300) `quests-rest` is 22 quests, 54 QP, 40,700 / 61,900 (burst 37,639 /
57,245), 5 medium and 9 long; `quests-medium` is 12 quests, 20 QP, floor 9,432 / realistic 9,881. `bun test
packages/planner`: 42 pass, 0 fail. `haggis-cli.ts research/hiscores-live.json --levers`: QP at end 145; Quest Points WIN
at 106,022 floor / 129,137 realistic.

After Clock Tower (medium, 900 / 1,300) `quests-rest` is 21 quests, 53 QP, 39,800 / 60,600 (burst 36,807 / 56,043), 4
medium and 9 long; `quests-medium` is 13 quests, 21 QP, floor 9,900 / realistic 10,367. `bun test packages/planner`: 42
pass, 0 fail. `haggis-cli.ts research/hiscores-live.json --levers`: QP at end 145; Quest Points WIN at 105,658 floor /
128,421 realistic.

After Hazeel Cult (medium, 900 / 1,300) `quests-rest` is 20 quests, 52 QP, 38,900 / 59,300 (burst 35,975 / 54,841), 3
medium and 9 long; `quests-medium` is 14 quests, 22 QP, floor 10,326 / realistic 10,802. `bun test packages/planner`: 42
pass, 0 fail. `haggis-cli.ts research/hiscores-live.json --levers`: QP at end 145; Quest Points WIN at 105,252 floor /
127,654 realistic.

After Murder Mystery (medium, 900 / 1,300) `quests-rest` is 19 quests, 49 QP, 38,000 / 58,000 (burst 35,142 / 53,638),
2 medium and 9 long; `quests-medium` is 15 quests, 25 QP, floor 10,628 / realistic 11,147. `bun test packages/planner`:
42 pass, 0 fail. `haggis-cli.ts research/hiscores-live.json --levers`: QP at end 145; Quest Points WIN at 104,721 floor /
126,796 realistic.

After Observatory Quest (medium, 900 / 1,300) `quests-rest` is 18 quests, 47 QP, 37,100 / 56,700 (burst 34,310 /
52,436), 1 medium and 9 long; `quests-medium` is 16 quests, 27 QP, floor 11,178 / realistic 11,702. `bun test
packages/planner`: 42 pass, 0 fail. `haggis-cli.ts research/hiscores-live.json --levers`: QP at end 145; Quest Points WIN
at 104,439 floor / 126,149 realistic.

After Death Plateau (medium, 900 / 1,300) `quests-rest` is 16 quests, 41 QP, 33,700 / 51,400 (burst 31,166 / 47,535), 0
medium (see the Death Plateau findings), 9 long and 7 very long; `quests-medium` is 17 quests, 28 QP, floor 12,370 /
realistic 12,903. `bun test packages/planner`: 42 pass, 0 fail. `haggis-cli.ts research/hiscores-live.json --levers`: QP
at end 145; Quest Points WIN at 105,251 floor / 125,347 realistic.

After Big Chompy Bird Hunting `quests-rest` is 14 quests, 36 QP, 30,100 / 46,200 (burst 27,836 / 42,726), 0 medium, 7
long and 7 very long; `quests-medium` is 19 quests, 33 QP, floor 14,722 / realistic 15,841 (a text splice of the two
rows). Class count fix first: the row counted 0 medium and 8 long, but its 15 quests were 7 long (Eadgar's Ruse, Horror
from the Deep, Shilo Village, Temple of Ikov, The Tourist Trap, Troll Romance, Troll Stronghold), 7 very long and Big
Chompy Bird Hunting (medium in the table), so Chompy was counted as long. Fixed to 1 medium and 7 long (-900 / -1,300),
then the medium delta (-900 / -1,300): together one long class off (-1,800 / -2,600). QP 38 - 2 = 36 (11 long + 18 very
long + the 7 QP of the 4 qp-0 rows). `bun test packages/planner`: 42 pass, 0 fail. `haggis-cli.ts
research/hiscores-live.json --levers`: QP at end 145; Quest Points WIN at 103,996 floor / 123,172 realistic.

### Big Chompy Bird Hunting

Preset `quest_chompybird` in `packages/practice/src/presets-rest.ts`: beside Rantz in the Feldip Hills (spawn
2630,2981); a knife, a chisel, an achey log, wolf bones, 8 feathers, 6 ogre arrows, the 6 possible seasonings and 2
lobsters from a helper; 50 ogre arrows worn. Script `scripts/generated/quest-chompybird.ts`. `RESULT ok qp=2
xp=hitpoints=332,ranged=19375,cooking=37105,fletching=6980,crafting=125 ... ticks=491 ... walkTicks=108 retries=0
died=false` (runs: 491, 583, 483 ticks; trials before the proof: 128 (fail), 444), each with `Congratulations! Quest
complete!`. Varp `%chompybird` 0-60, then complete (`quests/quest_chompybird/configs/quest_chompybird.constant`). Steps (proof run 1
MILESTONE ticks): Rantz, "Ok, I'll make you some 'stabbers'." (5) 0-10 (`rantz.rs2:29-49`); knife on the achey log,
chisel on the wolf bones, feathers on the shafts, tips on the flighted arrows (2-6 each, `ogre_arrows.rs2:19-142`; the
made_arrows bit) 10-18; Rantz takes 6 arrows (10) and "How do we make the chompys come?" (15) 18-42
(`rantz.rs2:238-296`); the cave 2629,2998, the rock off the chest 2637,9398 (20, a Strength roll) and the bellows
42-69 (`ogre_chest.rs2`); out, the swamp bubbles at about 2599,2965 and 3 swamp toads inflated 69-128
(`quest_chompybird.rs2:12-41`, `swamp_toad.rs2:24-74`); Rantz sees a toad (25) 128-161 (`rantz.rs2:62-74`); a toad
placed in the clearing 2635,2967 (30) 161-171 (`bloated_toad.rs2:34-88`); the chompy comes (35) and Rantz misses it
(40) 171-295 (`chompy_bird.rs2:1-18,221-253`, `rantz.rs2:760-761`); Rantz, "Come on, let me have a go...", "I'm
actually quite strong... please let me try." gives the bow (45) 295-320 (`rantz.rs2:85-109`); the bow wielded, a toad
placed, the bot shoots the chompy (op5), plucks it (op4) and picks up the raw chompy (50) 320-351
(`chompy_bird.rs2:77-219`); Rantz sees it (55) and names his seasoning 351-386 (`rantz.rs2:129-158`); the cave, Bugs and
Fycie name theirs 386-417 (`bugs.rs2:57-66`, `fycie.rs2:50-62`); out, the raw chompy on the spit roast 2630,2990 (60),
Rantz within 10 tiles takes it and the queue completes the quest 417-491 (`raw_chompy.rs2:14-58,94-220`,
`rantz.rs2:331-344`, `quest_chompybird.rs2:42-51`).
Findings:
- The seasonings are not random on this engine. The content rolls `random(1)` (`rantz.rs2:138`, `bugs.rs2:56`,
  `fycie.rs2:54`), and `random(n)` pushes `JavaRandom.nextDouble() * n` as an int (engine
  `script/handlers/NumberOps.ts:32-35`), so it is always 0: Rantz onion, Bugs equa leaves, Fycie tomato in all 3 proof
  runs. The script still reads each pick from the dialog and logs `cooked with onion, equa leaves, tomato (asked onion,
  equa leaves, tomato)` from the inventory counts. Only those 3 seasonings are needed; the preset carries all 6.
- The tick spread is the chompy spawn: each placed toad rolls 1 in 5 every 25 ticks for 4 rolls
  (`bloated_toad.rs2:89-118`). Run 2 placed a second toad for the bot's own chompy (583 ticks).
- Trial 1 failed at the swamp bubbles: the nearest bubbles were out of reach in the swamp (`I can't reach that!`). The
  script tries the reachable bubbles and toads first.
- Rantz checks only the made_arrows bit and a count of 6 (`rantz.rs2:263-275`), so 2 arrows made from one log and one
  bone set the bit and the helper's 6 arrows make the count. The bow is two-handed; the shield goes to the pack.
- Helper items: all tradeable (knowledge/items.json). The bellows, the bloated toads, the ogre bow and the seasoned
  chompy are untradeable (2871-2875, 2882-2883).

Next for the `presets-rest.ts` helper: the medium class of `quests-rest` is now empty; the 14 quests left are long
(7) and very long (7), and the long ones are claimed by other helpers (Shilo Village, Troll Stronghold).

### Shades of Mort'ton

`RESULT ok qp=3 ops=154 trips=3 xp=...,crafting=107200,herblore=51250 ... ticks=1908 ... died=false` (runs: 1,908,
1,944, 1,956 ticks), each with `Congratulations! Quest complete!`. Each proof run started 9,000+ ticks after the last
wall change of the run before (`flamtaer_temple.rs2:138-153`), and each logged `TEMPLE start
levels=0,0,0,0,0,0,0,0,0,0,0,0,0,0,0`, so every run built the whole temple. Class L in `quests-rest`; the row
`quests-medium` holds it. Preset `quest_mortton` (presets-medium.ts): in Herbi Flax's house beside the shelf, the
state after Haunted Mine, a hammer, a tinderbox, logs, a tarromin, a vial of water, ashes, two serum 207 (3410),
30,000 coins, 2 lobsters. Debug preset `quest_mortton_ulsquire` with `MT_FROM=ulsquire` starts at Razmire's store with
339 = 47. Steps (proof run 1 MILESTONE ticks; `quests/quest_mortton/scripts/` unless named): the diary from the shelf,
read to the last page (5) 0-22; serum 207 (10) 22-26; Razmire with the serum, "What are all these shadow creatures?",
"Yes, I'll dispatch" (15) 26-67; 5 Loar shades and their remains (40) 67-290; Razmire takes 2 (45), the builders' store
and the general store for olive oil 290-353; Ulsquire sees 1 (47) 353-398; "What can you tell me about that temple?"
(50) 398-416; 15 temple walls to level 10 and the stage 60 build (`minigames/game_mortton/scripts/flamtaer_temple.rs2:
44-92`) 416-1809 (154 Repairs, 3 store trips of 2 material sets); the altar lit, the sacred oil, the pyre logs, the
pyre (65-80, `:167-304`, `mortton_pyre.rs2`) 1809-1870; Ulsquire (complete, `ulsquire_shauncy.rs2:106-110`) 1870-1908.
Findings:
- The stage stayed under 50 in the 7 earlier trials because the "ulsquire 2" talk never chose the temple option: the
  save of trial `mt-t7` (account qmtxbph01) held `morttonquest` (varp 339, `pack/varp.pack:340`) = 47, read from the
  engine save file (perm varps after the 133-byte header, `engine/src/engine/entity/Player.ts:209-246`). The old
  script printed MILESTONE 50 whatever its chat returned. With every dialog page logged (DLG lines) the talk reads:
  Ulsquire's thanks, the post-shades menu, "What can you tell me about that temple?", "How can you rebuild a totally
  destroyed temple?", and line 176 sets 50. The first open after the store often fails (the NPC is afflicted again or a
  page is still open), so the script now opens the talk up to 3 times and waits for the "How can you rebuild" page.
- From stage 55 Razmire's talk has "Can you open a store for me?" before the store menu
  (`razmire_keelgan.rs2:132`); the old store trip clicked the first option and never opened the store.
- A temple that another player built (all walls at 10) still needs one build with a material set: the stage moves
  50 -> 55 -> 60 only inside `try_build_temple` (`:76-84`), and the altar needs 10% sanctity (`:176`). A trial on a
  built temple (`mt-f3`) finished in 920 ticks.
- A "~ Repairing the temple ~" page can stay open when the pool empties (`:254-272`); the store trip closes it first.
- The Loar shadows wander 30 tiles (`mortton_shades.npc`) and are often not in view at the house; the script walks a
  loop of 8 spawn points. Shades never attack a player above combat 80 (`vislevel` 40 x 2, `Npc.ts:1011`).
- Swamp paste does not stack, so a trip carries 2 sets (1 plank, 1 limestone brick, 5 paste each, `:274-278`); the
  proof runs used 3-4 trips (6-8 sets) for 152-156 Repairs at Crafting 99 (7-70 resources a build, `:94-118`).
- Helper items (tradeable): hammer, tinderbox, logs, tarromin, vial of water, ashes, serum 207, coins. The diary and the
  shade remains are quest items.

After Shades of Mort'ton (long, 1,800 / 2,600) `quests-rest` is 15 quests, 38 QP, 31,900 / 48,800 (burst 29,501 /
45,130), 0 medium, 8 long and 7 very long; `quests-medium` is 18 quests, 31 QP, floor 14,271 / realistic 15,208 (with
the 6 new Haunted Mine runs, 1,011 / 1,574). A text splice of the two rows (scratchpad `mortton-splice.ts`). `bun test
packages/planner`: 42 pass, 0 fail. `haggis-cli.ts research/hiscores-live.json --levers`: QP at end 145; Quest Points
WIN at 105,487 floor / 125,247 realistic.

Next for the medium-quest helper: the row `mortton-oil` (OUT) can use this script up to stage 65 (the sacred oil);
not checked. Haunted Mine: a ghost killed while faded costs a round (about 300 ticks); no way to stop it was found.

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
| Lost City | `scripts/generated/quest-zanaris.ts` | 595, 796, 668 | 629, 678, 720 | MEASURED 3/3 both |

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

### Lost City

`RESULT ok qp=3 zombies=1 xp=attack=11500,hitpoints=3802,magic=1025 ... ticks=595 hpMin=87 eats=0 ... died=false
milestones=1,2,entrana,dungeon,axe,3,4,5,wilderness,6` (main runs: 595, 796, 668 ticks; partner runs: 629, 678,
720), each with `The world starts to shimmer...` and `Congratulations! Quest complete!`. Partner `hpMin` 60-69 of
72, no food eaten. Steps (main run 1 MILESTONE ticks): the warrior "What are you camped here for?", "What makes you
think it's out here?", "If it's hidden how are you planning to find it?", "Looks like you don't know either." (1,
`areas/area_lumbridge/scripts/warrior_zanaris.rs2:30-72`) 0-40; Shamus's tree (2409 at 3138,3212) with an axe in the
pack spawns Shamus (`quests/quest_zanaris/scripts/quest_zanaris.rs2:11-26`), "How does it fit in a shed then?" (2,
`shamus.rs2:15-25,146-153`) 40-78; the axe dropped, the walk to Port Sarim, the monk "Yes, okay, I'm ready to go."
(`areas/area_port_sarim/scripts/monk_of_entrana.rs2:6-24`), the gangplank 78-186; the cave monk "Well that is a risk
I will have to take." (`areas/area_entrana/scripts/cave_monk.rs2:3-15`) 186-244; Entrana zombies until a bronze axe
drops 244-298; the dramen tree (1292 at 2860,9734) spawns the tree spirit, which is killed with the bronze axe worn
under Protect from Melee (3, `quest_zanaris.rs2:28-55`, `tree_spirit.rs2`) 298-422; the branch (4) and the knife on it
(5, `:56-87`) 422-433; the staff worn, the magic door (2407 at 2874,9750) to 3250,3772 (`entrana_dungeon.rs2:59-62`)
433-446; the walk south to 3250,3676, a Lumbridge teleport, the walk to the swamp shed, the door (2406 at 3202,3169)
with the staff worn queues the completion (`quest_zanaris.rs2:89-106`) 446-595.
Findings:
- No axe passes the Entrana monk: `weapon_axe` is on his list with every weapon and armour class
  (`monk_of_entrana.rs2:26-53`, `axes.obj` category). Shamus's tree needs an axe too (`quest_zanaris.rs2:16`). So the
  bot brings a bronze axe for Shamus and drops it before the monk. On Entrana the axe comes from the zombies:
  `zombie_entranan` drops a bronze axe 50 of 128 kills (`drop tables/scripts/zombie.rs2:102-111`). The kills are the
  spread of the runs (axe at tick 298 / 464 / 324 in the main runs).
- The cave ladder drains Prayer by 95% (`cave_monk.rs2:14`) and goes one way. The only exit is the magic door to
  Wilderness level 32 (`entrana_dungeon.rs2:59-62`). Teleports work at level 20 or less (`skill_magic/scripts/spells/
  teleport.rs2:17`, level = (z - 3520) / 8 + 1), so the bot walks to z 3676 first (about 53 ticks). The practice
  server had no other players there; on the live server PKers can attack in levels 20-32.
- A trial without Protect from Melee (the main, 99 HP) fell to 37 HP and ate 3 lobsters; with it the main stayed at
  87-88 and the partner at 60-69. One prayer potion restores the drained points. The 2 offensive prayers are on while
  points last.
- The SDK route from the Lumbridge teleport to the shed goes round the north of the castle and into the swamp from the
  west (96 ticks). A trial with waypoints south of the castle met a dead end at 3232,3215 and took 118.
- Untradeable: the dramen branch and the dramen staff (`quest_zanaris.obj`); the run makes both. Helper items: bronze axe (1351), knife (946), 2 prayer potions (2434), runes for one Lumbridge teleport, lobsters.

Planner: new row `quest-zanaris` (qp 3, 595 / 796 MEASURED, the same under `rival-dialogue-burst`). `quests-rest`:
72 -> 69 QP, 31 -> 30 quests, one medium class less: 50,600 / 76,200 -> 49,700 / 74,900 (burst 46,795 / 70,470 ->
45,963 / 69,268). The QP total stays 145 (`QP at end 145`). `bun test packages/planner`: 42 pass, 0 fail.
`haggis-cli --levers`: Quest Points WIN at 101,787 floor / 133,873 realistic (was 102,024 / 134,279).


## The `qp-filler` row: Black Knights' Fortress, Ernest the Chicken, Sheep Herder, Prince Ali Rescue

The row runs at tick 47,484 (`haggis-cli --order`, scenario a, row 47), after Romeo & Juliet and after the last 99
(Agility at 44,393). So Haggis has every skill at 99 there; it is not a low-combat row. Presets `quest_<name>` in
`packages/practice/src/presets-filler.ts`: every skill 99, the combat rune set of the gobdip / rj / druid presets worn,
the quests before the row done (34 QP; Monkey Madness left out, no quest here reads it), the helper items, the start
beside the first NPC. Runner: `proveInProcess` with `okPass`, one bot at a time, a fresh account per run, deleted after.
The walks between the 4 quests are not in the counts.

| Quest | Script | RESULT ticks (3 runs) | Status |
|---|---|---|---|
| Black Knights' Fortress | `scripts/generated/quest-blackknight.ts` | 327, 327, 323 | MEASURED 3/3 |
| Ernest the Chicken | `scripts/generated/quest-haunted.ts` | 410, 414, 412 | MEASURED 3/3 |
| Prince Ali Rescue | `scripts/generated/quest-prince.ts` | 638, 621, 607 | MEASURED 3/3 |
| Sheep Herder | `scripts/generated/quest-sheepherder.ts` | 1668, 1580, 1697 | MEASURED 3/3 |

### Black Knights' Fortress

`RESULT ok qp=3 xp=magic=2400 ... ticks=327 hpMin=99 eats=0 walkTicks=138 retries=0 died=false` (runs: 327, 327, 323
ticks), each with `Congratulations! Quest complete!`. Route: Sir Amik "I seek a quest!", "I laugh in the face of
danger!" (`areas/area_falador/scripts/sir_amik_varze.rs2:8-57`; the 12 QP check is `:15`) 0-32; Falador teleport, the
uniform worn, the walk to the fortress 32-130; the guards' door with the uniform (`quest_blackknight.rs2:14-22`); the
grill 130-196; back to the entrance and the cabbage in the hole 196-280; Falador teleport, the castle stairs, Sir Amik
queues the completion (`sir_amik_varze.rs2:67-74`) 280-327.
Findings (`maps/m47_54.jm2`, and the `nearbyLocs` of the trials):
- The grill (`witchgrill` 2342 at 3025,3507) is in a corridor that only the ladder at 3021,3510 reaches. The way there:
  the secret wall north of the entrance (2341 at 3016,3517, pushed from 3016,3516), ladders up at 3015,3519 and
  3016,3519, down at 3017,3516, two shut doors on level 1 (3019,3515 and 3021,3515), up at 3023,3513, down at
  3025,3513, the sturdy door west (2339 at 3025,3511, the knights there attack, `:24-31`), down at 3021,3510.
  Shut, the doors give "I can't reach that!" for the next click. The SDK collision joins rooms that the server keeps
  apart (it plans 3022,3511 -> 3022,3510 in one step), so the script names every ladder and door by tile.
- The hole (2336 at 3031,3507, level 1) is behind the second secret wall (2341 at 3030,3510), which is reached only
  from the level 1 corridor over the banquet hall: the hall door (2338 at 3020,3515, the guard's "I don't care. I'm
  going in anyway." sets the knights on the bot, `:56-81`) and the hall's ladder at 3022,3518. The grill must come
  first (the cabbage needs `%spy` 2, `:99-117`), so the run goes back through the ladders to the entrance (53 ticks).
- The Black Knights (level 33) hit the bot to 95 HP at most. No food was eaten.
- Helper items (tradeable): iron chainbody (1101), bronze med helm (1139), cabbage (1965; the Draynor Manor
  `magic_cabbage` is the wrong one, `:119-129`), runes for two Falador teleports.

### Ernest the Chicken

`RESULT ok qp=4 ... ticks=410 hpMin=99 eats=0 walkTicks=88 retries=3 died=false` (runs: 410, 414, 412 ticks), each
with `Congratulations! Quest complete!`. Route: Veronica "Aha, sounds like a quest. I'll help." (`areas/area_draynor/
scripts/veronica.rs2:8-19`) 0-18; poison on the fish food, the food into the fountain (153 at 3087,3334), the
fountain searched for the gauge (`quest_haunted.rs2:48-93`) 18-47; the spade on the compost heap (152 at 3084,3360)
gives the key (`:16-29`) 47-65; the front door (opens from the south only, `:1-11`), the closet (131 at 3107,3367)
with the key both ways, the tube from its floor 65-117; the bookcase (155 at 3097,3358, searched from the east,
`:95-100`) and the ladder down 117-141; the lever route and the oil can 141-277; the ladder up (it resets the levers,
`:136-145`), the lever out of the secret room (160 at 3096,3357), the stairs, the lab door, Oddenstein twice
(`professor_oddenstein.rs2:63-124`) 277-412.
Findings:
- The basement doors are named for 9 rooms, but rooms 1 and 4 (x >= 3105) are one room and so are 7 and 8 (z < 9758,
  x >= 3100; the ladder, levers A and B) (`maps/m48_152.jm2` wall lines x 3100 / 3105, z 9758 / 9763). With that
  room map, a Dijkstra over room x lever bits (`:168-176` door conditions) gives 23 actions: B, A, door 4to7, D,
  4to5, 5to8, A, B, 5to8, 5to6, 3to6, F, E, 2to3, 1to2, C, 1to2, 2to3, E, 2to3, 2to5, 5to8, 8to9. They take 136
  ticks. The door 8to9 still opens on the way back (E up, F down).
- The fountain adds the gauge after its two chatplayer pages (`:56-60`); the script clicks them through.
- Two shut doors that the SDK plan does not handle: the hall door (loc_1530 at 3109,3358) and the lab door (loc_1530
  at 3108,3364, level 2). A walk to the closet door's tile planned through the locked closet door ("Temporarily
  avoiding locked door") and lost 77 ticks; a shut lab door made 3 of 3 talks to Oddenstein fail.
- Helper items (tradeable): fish food (272), poison (273), spade (952). Untradeable: gauge, key, tube, oil can
  (`quest_haunted.obj`).

### Prince Ali Rescue

`RESULT ok qp=3 xp=attack=6400,hitpoints=2117,magic=4100 ... ticks=638 hpMin=99 eats=0 retries=0 died=false` (runs:
638, 621, 607 ticks), each with `Congratulations! Quest complete!`. Route: Hassan (`areas/area_alkharid/scripts/
hassan.rs2:1-10`) 0-10; Osman, the first thing, "Okay, I better go find some things." (`osman.rs2:56-105`) 10-58;
Lumbridge teleport, the walk to the Draynor jail, Keli's key print with the soft clay (`areas/area_draynor/scripts/
lady_keli.rs2:219-311`) 58-194; Ned's wig from 3 balls of wool (`ned.rs2:104-121`) and the yellow dye on it
(`quest_prince.rs2:1-12`) 194-248; Aggie's paste (`aggie.rs2:25-33, 140-154`) 248-285; Lumbridge teleport, the toll
gate (10 coins), Osman takes the print and the bar (`osman.rs2:107-126`) 285-362; Lumbridge teleport, Leela gives the
key and sets 30 (`leela.rs2:10-37`) 362-444; Joe takes the 3 beers (`joe_guard.rs2:128-155`) 444-498; the rope on
Keli (`quest_prince.rs2:14-32`), the key on the cell door from the north (`:34-44`), the prince takes the disguise
(`prince_ali.rs2:312-335`) 498-526; Lumbridge teleport, the free toll gate, Hassan queues the completion 526-607.
Findings:
- Two round trips are fixed by the varps: Osman makes the key only from a print taken after his first talk
  (`lady_keli.rs2:298`, `osman.rs2:119`), and Hassan pays only after the prince is out (`hassan.rs2:24-26`).
- The jail guards (vislevel 26) are `huntmode=aggressive_melee`. A guard's hit closes the talk: one trial lost 4 Keli
  talks so. The script kills a guard in combat within 3 tiles before each jail talk (the Attack and Hitpoints XP in
  RESULT). Each kill costs a few ticks; the spread of the runs is mostly these fights.
- Keli's rope message is a mesbox before the rope leaves the pack (`quest_prince.rs2:27-32`), so its page must be
  clicked. The cell is x <= 3125, z <= 3243; the corridor tile 3126,3243 is outside it.
- An amulet of glory (Draynor Village and Al Kharid, `amulet_of_glory.rs2:13-34`) would cut the 4 Lumbridge
  teleports' walks (about 60 ticks each to the jail, 50 to Osman). It is not used: no helper's supply of a charged
  glory is proven.
- Helper items (tradeable): 3 balls of wool, yellow dye, pink skirt, rope, soft clay, bronze bar, 3 beers, redberries,
  pot of flour, bucket of water, ashes, runes for 4 Lumbridge teleports, 50 coins. Untradeable: wig, paste, key print,
  key (`quest_prince.obj`).

### Sea Slug (the `rival-seaslug` row)

`RESULT ok qp=1 questMsg=true xp=fishing=179375 ... ticks=452 hpMin=97 eats=0` (runs: 452, 449, 455 ticks), preset
`quest_seaslug`, script `scripts/generated/quest-seaslug.ts`. The broken glass block was a lite client fault on
bridged tiles, not the server (`research/quest-plan.md` 1n, `patches/rs-sdk.md` item 4). Planner: row
`rival-seaslug` 449 / 455 MEASURED (was the rival's 304 / 495 ESTIMATE). Scenario a, `haggis-cli.ts
research/hiscores-live.json --levers`: Overall finish 41,229 / 44,310 -> 41,374 / 44,270 (the rival's 304-tick floor
was faster than ours); QP at end 145; Quest Points WIN at 102,075 / 130,441 -> 102,220 / 130,401. Gate
(`scripts/haggis-gate.ts`): "54 inputs not MEASURED; worst Agility -37538" -> "53 inputs not MEASURED; worst Agility
-37498". `bun test packages/planner`: 42 pass, 0 fail.

### Sheep Herder

`RESULT ok qp=4 ... ticks=1668 hpMin=99 eats=0 walkTicks=183 retries=0 died=false` (runs: 1668, 1580, 1697 ticks),
each with `Congratulations! Quest complete!`. Route: Halgrive "What's wrong?", "I can do that for you." gives the feed
(`quests/quest_sheepherder/scripts/npcs/councillor_halgrive.rs2:18-58`) 0-42; Orbon's suit for 100 coins
(`doctor_orbon.rs2:135-162`), both pieces worn 42-68; the walk to the pen, the cattle prod from the pen floor (2604,3357)
and out, the prod wielded 68-149; the 4 sheep 149-1580/1697; Halgrive queues the completion (`:68-75`).
Each sheep: prods to the gate zone (2592-2594,3360-3363), one more prod there and it jumps the gate
(`diseased_sheep.rs2:81-101`); in through the gate, the feed on it (it dies and drops its bones, `:139-164`), the bones
into the furnace (165 at 2605,3360, `sheepherder_furnace.rs2`), out. Prods per sheep in the 3 runs: 74-95 (sheep 1),
50-78 (2), 59-145 (4), 87-173 (3), against a shortest push path of 46, 31, 44, 58.
Findings:
- A prod moves the sheep one tile away from the bot (`:81-89`); the script plans the push path to the gate zone by BFS
  over the SDK collision (`canTravel`), with the bot's tile behind each step open and free of NPCs. A 2x2 tree
  (2607,3343) covers 2608,3344, which `canTravel` alone passed as a bot tile.
- The sheep wander back toward their spawn (wanderrange 3; the ai_timer resets the mode every 10-30 ticks, `:103-113`).
  This is most of the spread and why the prods are 1.5-3 times the push path. Before each prod the script checks the
  sheep is still on the tile it planned from.
- The jumped sheep is a new NPC that lasts 150 ticks (`npc_add(..., 150)`, `:95`). The first trial herded all 4 and
  then found none to feed; the script feeds and burns each sheep as soon as it is in.
- `walkPath` treats the pen gate as a door and "opens" it: the gate teleports a suited bot into the pen, and one trial
  stood 224 ticks inside it. The walks to the sheep are client-routed dashes.
- A sheep can wander into a pocket with no push (2594,3357 by the fence; 2571,3385). The script waits, and after 10
  tries takes another copy of the same sheep (each has 3 spawns).
- No helper items: feed, suit, prod and bones are untradeable (`quest_sheepherder.obj`). Coins: 100.

### Planner change for `qp-filler`

The row keeps its QP (18, or 14 with lever `combat-hp-bound`). Ticks: floor = the sum of the 4 best runs (323 + 410 +
607 + 1,580 = 2,920), realistic = the sum of the 4 worst (327 + 414 + 638 + 1,697 = 3,076), MEASURED, under
`combat-hp-bound` and `rival-dialogue-burst` (was 1,200 / 3,600 and 1,388 / 4,163 ESTIMATE). Without the lever the
row also holds Witch's House: 3,364 / 3,561 (+444 / 485, row `witch`; was 1,500 / 4,500). The walks between the 4
quests (Draynor, Al Kharid, Ardougne, Falador) are not in the counts.
`haggis-cli research/hiscores-live.json`, scenario a: Overall finish 41,374 floor / 44,270 realistic before and after
(the row is after the last 99). Quest Points finish 102,220 / 130,401 -> 103,752 / 129,314 (WIN either way). QP at end
145. `bun test packages/planner`: 42 pass, 0 fail.
Next: Sheep Herder is 54% of the row. The herd is the lever: prod from the tile 2 behind on straight runs more often,
and herd the far sheep (3, 4) with fewer re-plans. An amulet of glory would cut Prince Ali's 4 teleport walks, if a
helper can supply one charged.

### Alfred Grimhand's Barcrawl (the `barcrawl` row, a requirement of `scorpion`)

A miniquest with no QP (`%barcrawl` 77 is not in `general/configs/quest.constant`). `RESULT ok bars=10 card=false
... ticks=1466 hpMin=73 eats=0` (runs: 1,466, 1,486, 1,472 ticks), preset `barcrawl`, script
`scripts/generated/quest-barcrawl.ts`; route and findings in `research/quest-plan.md` 1o. Planner: new place
`outpost-guard`, new row `barcrawl` 1,466 / 1,486 MEASURED, `scorpion` requires it; `haggis-travel.json`
regenerated (963 lines added, none changed). Scenario a, `--levers`: Overall finish 41,374 / 44,270 -> 41,506 /
44,402; QP at end 145; Quest Points WIN at 102,220 / 130,401 -> 105,679 / 131,261. Gate: "53 inputs not MEASURED;
worst Agility -37498" -> "50 inputs not MEASURED; worst Agility -37630". `bun test packages/planner`: 42 pass,
0 fail. Scorpion Catcher itself is not proven: scorpion B is caught with the Barcrawl done; scorpion A needs the dusty
key.

### Scorpion Catcher (the `scorpion` row)

`RESULT ok qp=1 questMsg=true xp=attack=4700,strength=165625,... ticks=910 hpMin=99 eats=0` (runs: 937, 910, 942
ticks), preset `quest_scorpion`, script `scripts/generated/quest-scorpion.ts`; route and findings in
`research/quest-plan.md` 1o. The locked gate of test run t5 is the dusty key gate (loc 2623 at 2924,9803,
`areas/area_taverly/dungeon/scripts/jail_doors.rs2:31`). The run fetches the dusty key itself (Jailer, jail key on
Velrak's cell door, Velrak) in 271-295 ticks, inside the row. Planner: row `scorpion` 300 / 900 ESTIMATE -> 910 / 942
MEASURED. Scenario a, `--levers`: Overall finish 41,506 / 44,402 before and after; Quest Points WIN at 105,540 /
130,407 -> 106,173 / 130,517 (edc35a8 -> 21e430b); QP at end 145. Gate: "50 inputs not MEASURED; worst Agility -37630" -> "47 inputs not
MEASURED; worst Agility -37630". `bun test packages/planner`: 42 pass, 0 fail.

## Long `rest` quests: scripts and proofs (MEASURED practice, 3/3 each)

Presets `quest_<name>` in `packages/practice/src/presets-long.ts`: every skill 99, the quests before the dragon row plus
Dragon Slayer, Merlin's Crystal and Fight Arena done, the quest's own prerequisites, the helper items, and the start
beside the first NPC. Runner: `proveInProcess` with `okPass`, one bot at a time, each run on a fresh account that is
deleted after the run.

| Quest | Script | RESULT ticks (3 runs) | Status |
|---|---|---|---|
| Underground Pass | `scripts/generated/quest-upass.ts` | 2764, 2859, 2898 | MEASURED 3/3 |
| Troll Stronghold | `scripts/generated/quest-troll.ts` | 847, 788, 824 | MEASURED 3/3 |
| Shilo Village | `scripts/generated/quest-zombiequeen.ts` | 2133, 2478, 2357 | MEASURED 3/3 |
| The Tourist Trap | `scripts/generated/quest-desertrescue.ts` | 1617, 1604, 1624 | MEASURED 3/3 |

### Underground Pass

`RESULT ok qp=5 xp=attack=128400,hitpoints=17687,agility=75075,thieving=225 ... ticks=2764 hpMin=36 eats=5 ...
died=false` (runs: 2764, 2859, 2898 ticks), each with `Congratulations! Quest complete!`. Preset `quest_upass`: in
King Lathas's room (Ardougne castle, level 1); Plague City (165 = 30) and Biohazard (68 = 16) done
(`quest_upass.rs2:81`); worn rune full helm, scimitar, chainbody and platelegs. Helper items (tradeable): shortbow, 5
iron arrows, tinderbox, rope, bucket, spade, 14 sharks.

Steps (run 1 MILESTONE ticks):
- Lathas sets the started bit and a random grid path (`king_lathas.rs2:90-110`; Ranged 25 needed, `:94`) 0-24; the
  West Ardougne doors open after Biohazard (`area_ardougne_west/scripts/doors.rs2:24-40`); Koftik, "I'll take my
  chances." (`koftik.rs2:34-57`) 157; the cave (`upass_caveentrance2` 2433,3313) and 3 rockslides west.
- Koftik at the bridge gives the damp cloth; cloth on an arrow, the tinderbox on that; bow and lit arrow worn; "Fire-at"
  the guide rope from 2447,9722 (the shot needs x > 2443 and z >= 9720, `upass_bridge.rs2:33-79`) 275.
- The rope on the hanging rock (2460,9699) swings the bot east; 2 rockslides to the spike grid 360.
- The spike grid (2467-2476, 9673-9682): 3 column pairs, each safe on one 2-row band of 5; the path is per player in
  `%ibanmulti` bits 22-31 and is not sent to the client (`upass_grid.rs2:47-106`). The bot tries the bands one by one,
  walking (not running) tile by tile; a wrong band drops it into the spike pit (15 damage) and the hand holds put it
  back at 2477,9677. The proofs took 2, 5 and 4 falls (at most 8). It leaves the grid on its last row to x 2466 and
  walks that column to the lever: a server-routed walk from the grid crossed wrong tiles in a trial.
- The lever (2466,9672) opens the portcullis; orbs 4, 2, 3 off the floor, orb 1 under the log trap's flat rock
  ("Yes, I'll give it a go."); the 4 into the furnace (2454,9682); the well (2416,9674) to the second cave.
- The cell lock (2393,9655), the spade on the mud in the cell, the ledge (level-1 bridge locs at 2374,9639-9644), the
  two Thieving 50 cage doors (2380,9619 and 2404,9620), the pipe (2417,9605) to the unicorn; the loose railing from the
  cage on the boulder kills it and jumps the bot 25 tiles west; the smashed cage gives the horn; the tunnel south to
  the paladins.
- Sir Jerro, Sir Carl and Sir Harry (level 62) each drop a coat of arms; the 3 coats and the horn into the well
  (2373,9718) unlock the skull door (2368,9717) to the main cavern (2173,4725, level 1).
- The tunnel down (2150,4545) to the dwarves; Nilhoof sets 6. Up again; 2 broken bridges ("Cross") to the witch's cat;
  the cat on the witch's door draws her off (`kardia.rs2:69-78`); her chest gives the doll (7).
- Othainian (west over 2 bridges), Doomion and Holthion (level 91) drop their amulets at stage 7; the amulets open the
  chest (2136,4578) for the shadow. Down to the dwarves: Klank's gauntlets, the bucket on the brew barrel, the brew
  and the tinderbox on Iban's tomb for the ashes, Kalrag (level 89) killed with the doll in the pack for the blood. Up
  the north-west tunnel (2304,9915); the dove from the cage (2134,4702), gauntlets worn.
- An Iban disciple drops the Zamorak robes; all else off, the robes on, the temple door (2143,4647); the doll on the
  altar kills Iban (9) and throws the bot out; Koftik leads it to the entrance; King Lathas queues the completion.

Findings:
- At level 99 no Agility, Thieving or Ranged roll in the quest fails: each is `stat_random(skill, low >= 100, high >= 260)` on
  256 (`quest_upass.rs2:229,254`, `upass_bridge.rs2:68`, `upass_obstacles.rs2:22,113,162,233,273,307,374`).
- The temple door opens only with the robe top and bottom worn and nothing else (`quest_upass.rs2:586`), so the pack
  needs room for the 5 worn items there. The bot drops the bow and arrows after the bridge, the spade after the mud,
  and the journal and 2 potions from the witch's chest.
- The game-message buffer is capped, so a count of a message can stay flat; the obstacle checks use the message tick
  (`gameMessages[].tick`).
- The brew barrel has `forceapproach=south` at angle 1 (`upass.loc`): the bot uses it from the west tile 2326,9799.
- Auto retaliate is off and a meal stops an attack, so the kill loop sends the attack again every 6 ticks (one click
  left Holthion alive for 260 ticks in a trial). Protect from Melee for the demons and Kalrag; the bot eats to 80-85
  HP before the demons, Kalrag and the temple. A trial with 14 lobsters reached hp 16 (traps, Kalrag, Iban's bolts).
- Iban's bolts push the bot 1 tile and cancel the walk to the altar ("I can't reach that!"); the use is sent again.
- The run walks from Lathas to Koftik (about 140 tiles) and back from the cave exit to Lathas inside its ticks.


Planner: new row `quests-long` in `packages/planner/src/haggis-boards.json` (MEASURED, after `quests-medium`, which
it requires for Biohazard): Underground Pass, 5 QP, floor 2,764 / realistic 2,898 (best / worst run, the same under
`rival-dialogue-burst`). `quests-rest` loses one very long quest: 18 -> 17 quests, 47 -> 42 QP, 37,100 / 56,700 ->
34,600 / 52,700 (burst 34,310 / 52,436 -> 31,998 / 48,737); a text splice of the two rows. Scenario a, `--levers`:
Quest Points WIN at 104,439 / 126,149 -> 104,891 / 125,348; Overall finish 42,486 / 44,866 unchanged; QP at end 145.
`bun test packages/planner`: 42 pass, 0 fail.

### Troll Stronghold

`RESULT ok qp=1 xp=attack=25400,hitpoints=8415,agility=50 ... ticks=847 hpMin=43 eats=3 ... died=false` (runs: 847,
788, 824 ticks), each with `Congratulations! Quest complete!`; the 3 proof saves hold `%troll_quest` (varp 317) = 50
and `%troll_varbit` (318) = 63 (scratchpad `savvars.ts`). Preset `quest_troll`: beside Denulth (2896,3529), Death
Plateau done (314 = 80, 315 = 8), worn rune full helm, scimitar, chainbody, kiteshield, platelegs and climbing boots
(3105, tradeable: Tenzing sells them for 12 coins after Death Plateau, `quest_death/scripts/death_sherpa.rs2:12-25`),
20 sharks. Debug presets `quest_troll_arena`, `quest_troll_inside`, `quest_troll_back` with `TS_FROM`.

Steps (proof run 1 MILESTONE ticks; `quests/quest_troll/scripts/` unless named):
- Denulth: "How goes your fight with the trolls?", "Is there anything I can do to help?", "I'll get Godric back!" (10,
  `quest_death/scripts/death_ig_commander.rs2:62-86`) 0-28.
- North with the boots: the Death Plateau rocks (2880,3594, `quest_death.rs2:169-176`), west to the troll rocks
  (2856,3612, the rockslide; boots checked at z 3611, `quest_troll.rs2:1-13`), the climb east at 2859,3626 and the climb
  down at 2878,3622 (`:15-70`) to the arena's west door 28-150.
- The arena door (2897,3618; a west-wall door, so the bot is inside on x 2897); Dad (level 101) under Protect from
  Melee; below 20 hp he gives up, "I'll be going now." (20, `troll_champion.rs2:114-140`) 150-273.
- The north door (2916,3629), the troll pass (2903,3644 -> 2907,10019; 2906,10036 -> 2908,3654,
  `quest_troll.rs2:121-127`), 157 tiles to the stronghold door (2839,3689 -> 2837,10090 level 2) 273-400.
- A Troll General (level 113) drops the prison key while `%troll_quest` < 30 (`drop tables/scripts/troll_commander.rs2:
  1-7`); the stairs (2843,10108) to level 1; the prison door (2848,10107) takes the key (30, `quest_troll.rs2:222-233`)
  400-635.
- Down the stairs (2852,10107); Twig and Berry pickpocketed for the cell keys (`troll_stronghold_camp_guard.rs2:
  41-75`); Godric's cell (40, `quest_troll.rs2:303-308`) and Eadgar's cell (bit 0) 635-679.
- The back exit (2823,10048 -> 2827,3646, sets the back-exit bit, `:116-119`); the troll rocks at 2833,3628 and
  2856,3612 and the Death Plateau rocks down to Burthorpe 679-760; Dunstan queues the completion
  (`quest_death/scripts/death_smithy.rs2:1-8`) 760-847.

Findings:
- At level 99 a troll climb fails at most 1 time in 256 (`stat_random(agility, 170, 253)`) and the rockslide and the
  pickpocket never fail (`stat_random(agility, 160, 300)`, `stat_random(thieving, 60, 300)`); no climb failed in the 3 proof runs.
- The bot frees Eadgar too (about 8 ticks): his cave entrance puts the player on level 2, where Eadgar stands (spawn
  2890,10086,2), only with that bit set (`quest_troll.rs2:129-131`). Eadgar's Ruse starts with him.
- The stronghold door tile (2839,3688) is blocked; a walk to it idled 268 ticks in a trial. The walk now ends at
  2841,3689.
- The entrance on level 2 is a narrow passage south to 10057; the generals are reached round that loop (about 50 ticks
  each way). The Death Plateau trolls throw rocks at the bot on the way down (hp 41-48).
- Helper items (tradeable): climbing boots, sharks. The keys are quest items.
- The law talisman is the only reward; the quest gives no XP (`quest_troll.rs2:364-369`).

Planner: `quests-long` gets Troll Stronghold (1 QP, floor 788 / realistic 847): 2 quests, 6 QP, 3,552 / 3,745 (the same
under `rival-dialogue-burst`). `quests-rest` loses one long quest: 14 -> 13 quests, 36 -> 35 QP, 30,100 / 46,200 ->
28,300 / 43,600 (burst 27,836 / 42,726 -> 26,172 / 40,321); scratchpad `up/long-rows.ts`. `haggis-cli.ts
research/hiscores-live.json --levers`: QP at end 145; Quest Points WIN. `bun test packages/planner`: 42 pass, 0 fail.

### Shilo Village

`RESULT ok qp=2 xp=attack=52700,hitpoints=17440,crafting=97125,agility=1425 ... ticks=2133 hpMin=41 eats=1 ...
died=false` (runs: 2133, 2478, 2357 ticks), each with `Congratulations! Quest complete!`. Preset `quest_zombiequeen`:
beside Mosol Rei (spawn 2883,2951, east of the Shilo gates), Jungle Potion done (175 = 12, `mosol_rei.rs2:2`), worn
rune full helm, scimitar, chainbody, platelegs. Helper items (tradeable): spade, lit candle, rope, chisel, bronze wire,
3 bones, 14 sharks. Debug presets `quest_zombiequeen_mound`, `_azr`, `_cairn` with `ZQ_FROM`. Varps: `%zombiequeen`
116, `%zq_map_mechanisms` 117.

Steps (proof run 1 MILESTONE ticks; `quests/quest_zombiequeen/scripts/quest_zombiequeen.rs2` unless named):
- Mosol Rei: "Why do I need to run?", "Rashiliyia? Who is she?", "What can we do?", "I'll go to see the Shaman.",
  "Yes, I'm sure..." gives the Wampum belt (`mosol_rei.rs2:21-107`) 0-46. His menus offer "What can we do?" again
  beside the next step, so the bot answers by pattern priority, not by option order.
- Trufitus (2809,3086): the belt on him, "Mosol Rei said something about a legend?", "Why was it called Ah Za Rhoon?",
  "I am going to search for Ah Za Rhoon!", "Yes, I will seriously look..." sets 1 (`areas/area_karamja/scripts/
  trufitus.rs2:85-89,500-543`) 46-208.
- The mound (2921,2999) is in a jungle cut off by vines and trees; the stepping stones (2925,2948-2950, 1 tile per
  Cross, `skill_agility/scripts/shortcuts.rs2:228-271`) cross the river. Search (3), the spade (4), the lit candle (5),
  the rope (6), Search and "Yes, I'll give it a go!" lower the bot to 2898,9401 (7, `:329-483`) 208-466.
- Ah Za Rhoon: the rubble (2887,9373) to the lower cave; the hidden bookcase (2885,9317) gives the tattered scroll, the
  gallows (2934,9325) Zadimus' remains, the sacks (2939,9285) the crumpled scroll; both scrolls read (bits 5, 6); the
  rubble back; the south waterfall path (2940,9349) out to 2929,2946 (8 on leaving, `:977-1064`) 466-938.
- Cairn Isle: the climbing rocks (2794 and 2792, 2979) west, the log bridge, the stacked rocks (2762,2990, "Yes Please")
  into Bervirius' tomb (9, needs the tattered scroll read, `:613-649`); the dolmen (2766,9364) gives the pommel,
  the crystal and the notes; the chisel on the pommel, the wire on the beads: the Beads of the Dead (crumpled scroll
  read, `:1246-1280`); the hand holds out; the bridge and rocks back east 938-1100.
- Zadimus' remains buried in Tai Bwo Wannai (2794-2798, 3087-3090) give the bone shard (`:948-972`) 1100-1214.
- The stones north; the palm trees (2915,3092) show the doors; Search on them (bit 4); the chisel on the shard makes
  the bone key; the key on the doors (10); the beads worn; Open into the tomb (2929,9525) 1214-1490.
- The gate (11; the beads keep Rashiliyia away, `:255-312`); the rocks down; 3 bones in the tomb door (2892,9480; 12,
  `:1399-1447`); the dolmen (2892,9487) raises Nazastarool (level 91, 68, 93) under Protect from Melee; the remains
  (14) 1490-1817.
- Out: the rocks, the gate, the bone key on the exit doors to 2916,3093; the stones south; Cairn Isle again; the
  remains on Bervirius' dolmen queue the completion (`:1120-1143,1630-1635`) 1817-2133.

Findings:
- The Undead Ones (level 61) attack on sight below ground, and a hit during a mesbox dropped the click that resumes it
  (trial t6: 4 rubble searches, the choice never opened). The bot kills any Undead One within 5 tiles that has a
  target before each underground action.
- A slip on the stepping stones (`stat_random(agility, 50, 253)`) swims the bot about 6 ticks and leaves it on the far
  bank at x 2931; proof attempt 1 failed there (2/3), and the bot now waits for the swim to end.
- After the third bone a dialog page can leave the bot on the tomb door tile; Open walks it in (trial t10).
- Dropping a scroll or the crystal opens a confirm dialog (the crystal explodes); the bot keeps them.
- At level 99 each Agility roll here still fails about 1 time in 85-100 (`stat_random(agility, 70-170, 250-253)`); every
  obstacle is retried.

Planner: `quests-long` gets Shilo Village (2 QP, floor 2,133 / realistic 2,478): 3 quests, 8 QP, 5,685 / 6,223 (the
same under `rival-dialogue-burst`). `quests-rest` loses one long quest: 13 -> 12 quests, 35 -> 33 QP, 28,300 / 43,600
-> 26,500 / 41,000 (burst 26,172 / 40,321 -> 24,507 / 37,917); scratchpad `up/long-rows.ts`. `haggis-cli.ts
research/hiscores-live.json --levers`: Quest Points WIN at 103,397 / 121,918 -> 103,865 / 121,992; QP at end 145.
`bun test packages/planner`: 42 pass, 0 fail.

### The Tourist Trap

`RESULT ok qp=2 xp=attack=8000,hitpoints=2650,fletching=250,agility=232500 ... ticks=1617 hpMin=84 eats=0 ...
died=false` (runs: 1617, 1604, 1624 ticks), each with `Congratulations! Quest complete!`. Preset `quest_desertrescue`:
beside Irena (spawn 3303,3113, south of the Shantay Pass, so the pass is not crossed); no quest needed. Worn: a rune
scimitar and the desert shirt, robe and boots (tradeable). Helper items (tradeable): a hammer, 3 bronze bars, 40
feathers, 2 full waterskins, 6 sharks. Debug presets `quest_desertrescue_shabim`, `_ana` with `TT_FROM`. Varps:
`%desertrescue` 197, `%desertrescue_map_mechanisms` 198. Server truth: `quests/quest_desertrescue/scripts/*.rs2`
(`quest_desertrescue.rs2` unless named).

Steps (proof run 1 MILESTONE ticks):
- Irena: "What's the matter?", "Is there a reward if I get her back?", "Okay Irena, calm down." sets 1
  (`irena.rs2:1-66`) 0-26.
- The Mercenary Captain (3270,3029): "Wow! A real captain!", "I'd love to work for a tough guy like you!", "Can't I do
  something...", "Sorry Sir...", "It's a funny captain who can't fight his own battles!" starts a duel
  (`mercenary_captain.rs2:29-67`). The bot attacks only after his first swing: an attack before it asks "Are you
  sure" and the guards dump the player in the desert (`:218-241`, `skill_combat/scripts/npc/npc_combat.rs2:165-167`).
  His death sets 4 and adds the metal key (`:193-216`) 26-176.
- The scimitar off (a guard jails a player with a weapon or armour, `:145-186`); the gate with the key sets 5
  (`:68-131`) 188.
- A male slave on the surface: "I've just arrived.", "Oh yes, that sounds interesting.", "What's that then?", "I can
  try to undo them for you.", "It's funny you should say that...", "Yeah, okay, let's give it a go." (Thieving), "Yes,
  I'll trade."; the worn desert clothes become worn slave clothes (8, `mining_slave.rs2:79-200`) 285.
- The mine doors with the slave clothes worn (9, `:417-445`) 300; the mine guard by the caves (the player must stand in
  3274-3284, 9413-9423): "I'd like to mine in a different area.", "Yes sir, you're quite right sir." (10,
  `camp_guard.rs2:3-17,105-121`) 376; the exit door; the slave clothes off; the gate out.
- Al Shabim (3171,3025): "I am looking for a pineapple.", "Yes, I'm interested." gives the Bedabin key (11,
  `al_shabim.rs2:117-141`) 544.
- Back in; the ladder (3290,3036) to Captain Siad's office; Search on the bookcase (3284,3032) sets the sailing bit;
  Siad: "I wanted to have a chat?", "You seem to have a lot of books!", "So, you're interested in sailing?", "I could
  tell by the cut of your jib." distracts him with no random roll (`captain_siad.rs2:43-81`); Open on the chest with
  the key gives the plans (12, `:308-345`) 785. Out of the camp.
- Al Shabim with the plans, the bar and 10 feathers: "Yes, I'm very interested.", "Yes, I'm kind of curious." (13,
  `al_shabim.rs2:81-90,168-186`) 889; the Bedabin guard lets the bot into the anvil tent
  (`bedabin_nomad_guard.rs2:187-226`); a bar on the experimental anvil, "Yes, I'd like to try." (14, `:577-641`) 969;
  the feathers on the tip (15, `:643-672`) 982; Al Shabim takes the dart and plans and gives the Tenti pineapple (16,
  `al_shabim.rs2:42-74`) 1028.
- Back in, slave clothes on, the mine; the mine guard eats the pineapple (17, `camp_guard.rs2:149-156`) 1179; the cave
  east (`:471-489`); an empty barrel ("Yeah, cool!") and the lower mine cart ("Yes, of course.", Agility) to Ana's side
  (18, `:741-778,808-835`) 1213.
- The barrel on Ana (19, `ana.rs2:56-89`) 1258; Ana in the far cart (20, `:837-850`); the cart back; Search on the
  barrels by the lower cart (21, `:744-769`) 1315; Ana on the lift, "Yes please.", "I said you were very gregarious!"
  (22, `camp_guard.rs2:177-206`) 1362.
- The cave west, the exit; the winch (3279,3017; 23, `:883-894`) and the barrel beside it (3278,3017; 24, `:715-730`)
  1455; Ana on the cart (3287,3023; 25, `:392-400`) 1464; the driver: "Nice cart.", "One wagon wheel...", "'One good
  turn deserves another'", "Fired... no, shot perhaps!", "In for a penny in for a pound.", "Well, you see, it's like
  this...", "Prison riot in ten minutes...", "You can't leave me here, I'll get killed!" (`mine_cart_driver.rs2:258-332`);
  Search on the cart, "Yes, I'll get on." rides out to 3258,3029 with Ana (26, `:358-371`) 1547.
- Irena (27); Ana gives the wrought iron key; two XP picks (Agility twice) queue the completion (`irena.rs2:17-24,77-102`,
  `ana.rs2:1-17`) 1617.

Findings:
- The camp gate is a wall on the east edge of 3273,3028-3029. From inside, Open moves the player onto the gate tile
  (x 3273), not past it (`doors/scripts/open_and_close_double_doors.rs2:143-158`); trial 2 waited for x 3272 and
  failed.
- A walkPath to the tile south of the mine exit door (3278,9426) opened that door, landed the bot on the surface and
  then walked off toward the underground goal for 5,000 ticks (trial 1). The bot sends Open on the exit door from
  where it stands; the server routes to it.
- A guard within 4 tiles of the gate jails a player who leaves in any slave clothes (`:110-118`), so the bot takes them
  off before each exit and puts them on again before the mine doors.
- At level 99 the skill rolls can still fail: the chain lock (`stat_random(thieving, 20, 250)`), the anvil (Smithing
  61/245, wastes a bar), the feathers (Fletching 61/254, waste 10), the cart (Agility 100/250). The bot carries spares
  and repeats each one. No proof run failed one.
- The desert heat does not act in the camp or the Bedabin camp (`area_desert/configs/desert_heat_zones.dbrow`); the
  desert clothes and the waterskins kept the HP at 84 or more.

Planner: `quests-long` gets The Tourist Trap (2 QP, floor 1,604 / realistic 1,624): 4 quests, 10 QP, 7,289 / 7,847
(the same under `rival-dialogue-burst`). `quests-rest` loses one long quest: 12 -> 11 quests, 33 -> 31 QP, 26,500 /
41,000 -> 24,700 / 38,400 (burst 22,843 / 35,512); scratchpad `up/long-rows.ts`. `haggis-cli.ts
research/hiscores-live.json --levers`: Quest Points WIN at 103,865 / 121,992 -> 103,805 / 121,211; Overall finish
42,486 / 44,866 unchanged; QP at end 145. `bun test packages/planner`: 42 pass, 0 fail.

### Regicide: research notes (not scripted)

The long-quest helper read the content and stopped before a script (context). Server truth:
`quests/quest_regicide/scripts/*.rs2`. Varps: `%regicide_quest`, `%regicide_bits` (`quest_regicide.varp`), stages
0-14 (`quest_regicide.constant`).
- Start: the King's messenger spawns on a player timer of 400-1,200 ticks set at login once Underground Pass is
  complete (`login_logout/login.rs2:74`, `regicide_kings_messenger.rs2:1-13`). In a real run the timer fires during
  the quests before this one; a preset can start at `%regicide_quest` 1 with the summons.
- King Lathas sets 2 (`areas/area_ardougne_east/scripts/king_lathas.rs2:30-36`). The way west is the well of voyage
  at 2008,4711 level 1, beside Koftik (caveguide6, 2012,4713), at the far end of the Underground Pass main cavern
  (`quest_regicide.rs2:10-17`: to 2343,9622; the temple exit 2312,9623 to 2312,3216). The walk from the pass
  entrance to the well is not measured.
- Idris and two elves meet the bot in Tirannwn on a timer (3, `idris.rs2:6-72`); Lord Iorwerth (2205,3252) 4; the
  tracker (2257,3149) 5, the pendant from Iorwerth, the tracker 6, the footprints (2240,3150) 7, the tracker 8
  (`regicide_camp_tracker.rs2`, `lord_iorwerth.rs2`).
- The dense forest crossings need Agility 56 (`quest_regicide.rs2:388-471`); a Tyras guard (level 110) at the camp
  crossing (2187,3169) must die (9, `tyras_guard.rs2`); the crossing again sets 10; Iorwerth gives the Big Book o'
  Bangs (11).
- The bomb: coal tar from the tar pit into a barrel (`quest_regicide.rs2:636-647`), the fractionalizing still for the
  naphtha (an interface with pressure and tar valves and coal; `regicide_fractionalizing_still.rs2:1-201`; the
  naphtha comes on close when `%regicide_still_total` >= 26), limestone in the furnace (2193,3146) for quicklime
  (gloves stop 8 damage), the pestle and mortar with an empty pot for the dust, sulphur from the pits (2256-2272,
  3115-3130) ground, 4 balls of wool on the loom (2198,3249) for the cloth; the mixes and the cloth make the fused lid
  (`quest_regicide.rs2:649-788`). The barrel (3216) is untradeable; it lies on the ground in maps m34_49 and m34_50.
- A cooked rabbit (tradeable) to the lazy guard (2181,3184) frees the catapult (2185,3183); the fused lid on it kills
  Tyras (12, `quest_regicide.rs2:495-599`); Iorwerth's message (13); Arianwyn in zone 0_40_51_24_32 on the way home
  (14, `:792-830`); King Lathas queues the completion (`king_lathas.rs2:6-16`, `quest_regicide.rs2:850-855`).
- Traps (woodsprings, tripwires, leaf pits) roll `stat_random(agility, 30, 155)` or `(160, 300)`; at 99 they do not
  fail (`quest_regicide.rs2:31-316`, `regicide_zones.rs2`).
- Helper items (tradeable): coal, limestone, a pestle and mortar, an empty pot (the Quartermaster at 2194,3140 also
  sells pots, `regicide.inv`), 4 balls of wool, a cooked rabbit, gloves, food. Not a blocker for a bot found.
