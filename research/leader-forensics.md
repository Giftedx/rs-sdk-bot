> Authority (owner decision): all gameplay techniques are authorized. Wine, cocktails, pyre oil, Charge, relogs and tick manipulation need no further approval. Missing supplies create acquisition work, never a route exclusion. See [AGENTS.md](../AGENTS.md).

# Leader forensics: how the #1 accounts reach their times

This file records, for every time-ranked board, the leader's time, the inferred method with its evidence, our
modelled time and the gap. Our route optimizer must target methods that can beat these times.

Sources (all read-only, no login):

- Boards: `research/hiscores-2026-10-31.json` (21 boards, top 20 rows, `bun packages/planner/src/scout-cli.ts`).
  Change columns compare with `research/hiscores-2026-10-29.json`.
- Player pages: `https://rs-sdk-demo.fly.dev/hiscores/player/<name>` for the 98 accounts in the top 5 of any
  board, 1.2 s between requests. Raw pages are not committed (session scratchpad).
- World feed: `wss://rs-sdk-demo.fly.dev/worldfeed`, roster for 40 s, then a 24x24 `sub` rectangle around each
  online leader for 25 s.
- Cairn's published route: https://rune.fast/route and https://rune.fast/tricks (operator bleugreen). Facts only;
  the repository has no license (`research/rival-rune-fast.md`). Our mapping: `packages/planner/src/cairn-route.json`,
  priced by `bun packages/planner/src/cairn-cli.ts`.
- Our model: `bun packages/planner/src/haggis-cli.ts research/hiscores-2026-10-31.json`, table "Each board alone,
  done first (scenario c)". These are ESTIMATE figures, not measurements.

Code cites: `engine/` = `vendor/rs-sdk/server/engine/src`; content paths start at
`vendor/rs-sdk/server/content/scripts` unless they start with `maps/` or `pack/`. The live server runs newer code
than the vendored copy, so every CODE-READ is for the vendored copy.

Confidence labels: **CONFIRMED** = code and live evidence agree, or the operator published the method.
**LIKELY** = code allows it and the evidence fits. **GUESS** = fits some evidence only.

## How to read a player page

1. **A player page shows one stamp per skill: the tick of the current level.** No per-level history is public
   (`engine/web/pages/hiscores.ts:166-198` selects one `playtime` per skill). So "ticks between levels" is
   visible only through other skills that stopped rising, quest-point stamps, and Cairn's published segments.
2. **Old stamps are logout stamps, not level-up stamps.** The board time is `levelPlaytime[stat]`, set at the
   level-up tick (`engine/engine/entity/Player.ts:1904-1905`). If it is 0, the save uses `player.playtime`
   (`engine/server/login/LoginServer.ts:162`). Skills with the **same** stamp were saved together, and the real
   level-ups were earlier. The stun* Overall accounts show this: stunbaron has 4 skills at 12,006, 5 at 17,697 and
   10 plus Overall at 35,916. CONFIRMED.
3. **The Quest Points row shows quests that the boards hide.** QP has its own save stamp
   (`LoginServer.ts:203-219`). Skills below 15 are not shown (`LoginServer.ts:160`).
4. **Playtime counts every logged-in tick and nothing else.** `player.playtime++` runs once per tick for each
   player in the world (`engine/engine/World.ts:692`). Logged-out time is free.
5. **Respawn timers shrink with the live player count.** `~scale_by_playercount(base)` = `base * (4000 -
   min(playercount, 2000)) / 4000` (`general/scripts/player_count.rs2:1-4`). The world feed counted 1,301-1,311
   players (MEASURED live), so a 20-tick iron respawn is about 13.5 ticks live. CODE-READ.
6. The live time cell reads `title="N ticks normalized to 400 ms per tick"`. The vendored copy has no such text
   (`engine/web/pages/hiscores.ts:60-68`), so the live server normalizes playtime by a rule we cannot read.

## Board snapshot

Ticks of #1 to #5. "Change" compares #1 with `research/hiscores-2026-10-29.json`. **Bold** = a different #1.

| Board | #1 (ticks) | #2-#5 | Change |
|---|---|---|---|
| Overall | cairnmax20x (35,787) | stunbaron 35,916, stunhard 36,246, stunless 36,325, stunking 38,597 | none |
| Attack | stunattacker (4,728) | stunhitpoint 8,498, nickstriker 10,193, cairnmax20x 11,750, lachatk001 12,073 | none |
| Defence | stundefence (7,974) | nickwarden 9,814, lachdef001 12,333, nickdef 13,674, nickoverall 18,421 | none |
| Strength | stunhitpoint (4,966) | stunstrong 7,553, nickflex 8,284, lachstr001 10,448, nickbrawn 10,961 | none |
| Hitpoints | stunhitpoint (17,058) | nickoverall 18,864, nickmax 21,398, nicktgtbravo 26,340, nicktgtalpha 28,538 | none |
| Ranged | nickslinger (5,595) | nickknives 7,477, lachrange002 8,918, nickarcher 11,754, nickoverall 21,269 | none |
| Prayer | nickprayrec (1,272) | stunpray 1,281, nickprays 2,028, nickmax 2,037, lachpray001 2,224 | none |
| Magic | nickhex (1,262) | jackalopemg3 1,324, stunmage 1,513, nickmagi2 3,416, gortnwylx 9,568 | #5 is a new account |
| Cooking | stuncookv3 (20) | jackalopeck3 38, stuncook 51, stuncookv2 53, jackalopeck2 142 | none |
| Woodcutting | **zog207 (3,069)** | zog206 3,114, nickbough 3,152, zog203 3,178, zog190 3,179 | -83 (nickbough 3,152) |
| Fletching | **nickarrowz (56)** | stunfletchv2 57, jackalopefr1 58, nickqzfletch 61, nickcopse 62 | -1 (stunfletchv2 57) |
| Fishing | nicktrawler (3,328) | cairn_casts 3,425, stunfish 3,956, nickcaster 5,536, jadefish 5,780 | none |
| Firemaking | nickcinder (660) | cairn_ashes 664, jackalopefma 673, nickkindle 673, cairn_burns 690 | none |
| Crafting | nickgemcut (197) | crab26eba2 536, nickcrafti 580, nickcrafts 878, nickcrafty 1,195 | none |
| Smithing | nickironhand (1,281) | stunsmither 1,337, hephaistos 1,557, nickcrucible 1,839, nickforged 1,893 | none |
| Mining | miner3 (3,964) | cairn_rocks 4,317, stunmine 4,575, nickquarry 6,015, lachmine003 8,374 | none |
| Herblore | **nickelixir (424)** | jackalopehl2 447, stunherblore 465, nickherbal 498, jackalopehl1 1,146 | -23 (jackalopehl2 447) |
| Agility | nickstride (6,155) | stunagile 6,772, cairn_jumps 7,111, nickagility 8,476, cairnmax20x 35,787 | none |
| Thieving | nicksnatch (2,635) | jackalopeth8 2,935, stunthief 3,253, cairn_steals 3,342, jackalopeth2 3,364 | none |
| Runecraft | nickrc97 (2,253) | jackaloperc6 2,354, nickrc99 2,355, stunrc 2,397, nickrcquick 2,401 | none |
| Quest Points | **stunquestv3 (145 QP, 73,866)** | qu3st 1,001,957, avery 1,022,262, wodressbot 2,102,484, nickai 2,855,107 | -928,091 (qu3st 1,001,957) |

Woodcutting #2, #4 and #5 are zog accounts that are absent from the 10-29 top 20. Four zog accounts inside 110
ticks of each other point to one script run several times.

## Summary

Leader XP/tick = 998,458 / leader ticks (setup included). "Ours" = the board done alone on a fresh account,
floor / realistic, from the haggis-cli run above (ESTIMATE). Gap = ours floor - leader (negative = we win).

| Board | Leader XP/tick | Inferred method | Conf. | Ours (floor / realistic) | Gap floor | Need to match |
|---|---|---|---|---|---|---|
| Overall | - | Cairn route, 25 segments, quest rewards, helpers at the action, skills overlapped | CONFIRMED (published) | 41,438 / 44,006 (scenario a) | +5,651 | The missing Cairn segments below |
| Attack | 211 | Waterfall (Attack and Strength 83), Tree Gnome Village, Imp Catcher, then melee under Protect from Melee | LIKELY | 14,760 / 15,509 | +10,032 | Quest rewards as the base, not combat |
| Defence | 125 | Waterfall, Imp Catcher, Protect from Melee at 188, then Defence combat | LIKELY | 14,198 / 14,688 | +6,224 | Quest rewards (Dragon Slayer, Monkey Madness) |
| Strength | 201 | Waterfall (Strength 83 at 1,273 on stundefence; 2 QP), then melee | LIKELY | 19,893 / 20,983 | +14,927 | Waterfall first; Monkey Madness option 1 |
| Hitpoints | 58 | Combat on stunhitpoint after Attack and Strength | LIKELY | 13,864 / 15,104 | -3,194 | Already winnable in the model |
| Ranged | 178 | Plain ranged combat, no quest, no cannon (HP 82 = 9,198 damage) | LIKELY | 8,015 / 8,284 | +2,420 | Damage rate of 1.8 per tick at the target; cannon is an option they did not use |
| Prayer | 785 | 555 dragon bones at about 2 ticks each | LIKELY | 9,660 / 10,271 | +8,388 | Model the dragon-bone row alone; 560 bones; zero-wait restock |
| Magic | 791 | Combat spells to about 80 (HP 75 at 1,157), Mage Arena, then Charge in the last 105 ticks | LIKELY (Charge) / GUESS (combat leg) | 1,433 / 1,859 | +171 | A band for the Mage Arena worker; Charge 5 a tick |
| Cooking | 49,923 | Login wine timer; 20 ticks fits one 20-tick timer with the wine already banked | GUESS | 217 / 229 | +197 | Find how the wine reaches the bank at about tick 0 |
| Woodcutting | 325 | Knife reset (4.23 ticks per willow log), no bones | LIKELY | 3,452 / 3,563 | +383 | Knife reset in `woodcutting.ts` |
| Fletching | 17,830 | Arrows and darts, 5 actions a tick, items at the tutorial exit | LIKELY | 64 / 71 | +8 | Tutorial skip plus a one-burst trade |
| Fishing | 300 | Plain fishing, no quest (no Sea Slug); knife reset fits | GUESS | 4,737 / 4,821 | +1,409 | Knife reset on fishing; measure live |
| Firemaking | 1,513 | Log ladder, 4 ticks per log, helpers drop logs ahead | CONFIRMED (Cairn segment 661) | 720 / 745 | +60 | Dropper helpers; level-up answered in the same tick |
| Crafting | 5,068 | Gem cutting from 1, no quest | LIKELY | 272 / 273 | +75 | Uncut dragonstone supply; bank cycle |
| Smithing | 779 | Platebodies at the anvil, bars traded in, no quest | LIKELY | 1,444 / 1,448 | +163 | Anvil-side bar helper |
| Mining | 252 | Knife reset on iron at the 6 rocks south of the Ardougne zoo | LIKELY (Cairn's segment) | 16,467 / 17,761 | +12,503 | Knife reset on mining; the zoo rocks |
| Herblore | 2,355 | Druidic Ritual by tick 281, then potions | CONFIRMED (QP) / LIKELY (order) | 881 / 885 | +457 | Quest worker in 281 ticks; potion supply |
| Agility | 162 | Prayer 43 at 404 (Protect from Melee), small quest XP, Wilderness laps | LIKELY | 20,325 / 21,207 | +14,170 | Wilderness lap worker; bones first |
| Thieving | 379 | Knights from about 55 at about 2,000 ticks; the 1-55 leg in about 600 | GUESS | 21,721 / 22,924; 6,169 MEASURED live | +3,534 (measured) | The 1-55 leg; the stun pack |
| Runecraft | 443 | Altar-room helpers trade essence beside the altar | LIKELY (Cairn's segments) | 1,588 / 1,722 | -665 | Already winnable in the model; helpers |
| Quest Points | - | 145 QP at 73,866 on a combat-trained account | LIKELY | 102,111 / 115,717 (scenario a) | +28,245 | A quest-first route |

## The Overall route, segment by segment

cairnmax20x published every segment with its planned and actual ticks. Its player page confirms the order:
Firemaking 99 at 801 (= 140 + 661), Prayer 99 at 3,622 inside the Woodcutting band, Woodcutting 4,629, Mining
8,725, Attack 11,750, Magic 18,218, Fletching 18,844, Thieving 20,275, Runecraft 22,587, Fishing 24,831, Smithing
26,610, Herblore 27,109, Crafting 27,171, Cooking 27,177, Strength 28,601, QP 34 at 28,622, Defence 30,161,
Hitpoints 31,121, Ranged 31,717, Agility 35,787. Planned sum 34,143; actual 35,787 (`cairn-cli.ts` totals).

"Ours" = our model ticks for the matching rows (`cairn-cli.ts`, scenario a realistic, travel on). "Worker" = the
script file exists. "Delivered" = the coordinator has a succeeded build or qualify for the capability
(`.practice/coordinator/state.json` in the main checkout). "Missing" = no worker or no planner row. Worker proof
levels are not checked here.

| # | Segment | Skills | Cairn plan / took | Ours | Our status | Technique gap |
|---|---|---|---|---|---|---|
| 1 | Tutorial skip, trade, Wind Strike at the coop | Magic 1-8 | 135 / 140 | 22 | missing (no worker) | Tutorial skip (6 ticks lab); one-burst trade |
| 2 | Firemaking on the castle row, helpers drop logs | Firemaking 1-99 | 661 / 661 | 977 | delivered (`firemaking-order`) | Dropper helpers ahead of the line |
| 3 | Enchant rings from 3 helpers | Magic 8-59 | 198 / 196 | 604 | delivered (`magic-order`) | Ring givers beside the account |
| 4 | Doric's Quest | Mining 1-49 | 69 / 66 | not placed | worker (`quest-doric.ts`) | Dialogue bursts |
| 5 | Air altar, 7 essence helpers | Runecraft 1-44 | 207 / 206 | no row | worker (`rcair.ts`) | Altar-room rota |
| 6 | Woodcutting with knife reset, bury bones between rolls | Woodcutting 1-99, Prayer 1-99 | 3,296 / 3,391 | 3,933 | worker (`woodcutting.ts`) | Knife reset and bury-in-loop missing (`rival-gap-list.md` rows 1, 5) |
| 7 | Plague City | Mining 49-64 | 591 / 595 | no row | missing | Quest worker; Ardougne teleport |
| 8 | Iron by the Ardougne zoo, knife reset | Mining 64-99 | 3,157 / 3,470 | 2,518 | worker (`gather-ore.ts`) | Knife reset on mining; 6-rock rotation |
| 9 | Tree Gnome Village | Attack 1-80 | 734 / 805 | 1,321 | worker (`quest-tree.ts`) | Fights with spells under Protect from Melee |
| 10 | Gnome course to 25, The Grand Tree | Agility 1-76, Attack 80-94 | 1,582 / 1,633 | 2,433 | worker (`agility-order` not delivered; `quest-grandtree.ts`) | Dialogue bursts |
| 11 | Fight Arena | Attack 94-99, Thieving 1-57 | 607 / 594 | 818 | worker (`quest-arena.ts`) | Fire Blast under Protect from Melee |
| 12 | Dwarf Cannon | Crafting 1-42 | 1,027 / 986 | 1,271 | worker (`dwarfcannon.ts`) | Railing rolls are luck |
| 13 | Cannon at the poison spiders | Ranged 1-50 | 488 / 511 | priced in 24 | worker (`gather-ranged.ts`, `ranged-train` delivered) | Helper carries the cannon |
| 14 | Monkey Madness | Strength 1-97, HP 42-97, Defence 1-89 | 4,563 / 4,113 | 5,501 | worker (`quest-mm.ts`) | One tick per dialogue page; bursts |
| 15 | Mage Arena | Magic 77-81 | 547 / 637 | 910 | practice: `scripts/generated/quest-magearena.ts`, 985 to 1,053 ticks from the cellar with the 99 casts of Flames of Zamorak | No band in the planner; Charge needs only the staff, so the 99 casts are not on the Magic route |
| 16 | Ardougne knights; Charge, Superheat, arrows in the stuns | Thieving 57-99, Magic 81-99, Fletching 1-99 | 2,099 / 2,288 | 2,126 | worker (`thieveknights.ts`) | Stun pack; courier beside the knights |
| 17 | Sea Slug, Fishing Contest | Fishing 1-78 | 859 / 791 | 801 | worker (`quest-seaslug.ts`, `quest-fishingcompo.ts`) | Contest items cannot be traded |
| 18 | Body altar, essence rota | Runecraft 44-99 | 1,279 / 1,512 | 1,971 | worker for air only (`rcair.ts`) | Body-altar rota |
| 19 | Fly fishing at Lumbridge, knife reset | Fishing 78-99 | 2,054 / 2,257 | 2,663 | worker (`gather-fish.ts`) | Knife reset on fishing |
| 20 | Cook's Assistant, Druidic Ritual, Goblin Diplomacy, Romeo and Juliet | Cooking 1-30, Herblore 1-28 | 752 / 750 | 1,611 | worker (`quest-cook.ts`, `quest-druid.ts`) | 32 QP for the Champions' Guild |
| 21 | Platebodies at the Varrock west anvil | Smithing 41-99 | 903 / 1,018 | 1,454 | missing (no worker) | Bar helper beside the anvil |
| 22 | Bank booth: Crafting, Herblore, banked wine | Crafting 48-99, Herblore 28-99, Cooking 30-99 | 513 / 571 | 750 | worker (`craft-jewelry.ts`, `cook-wine.ts`; `wine-order` qualify failed) | Five-click banking; two wine relogs |
| 23 | Dragon Slayer | Strength 97-99, Defence 89-98 | 1,370 / 1,430 | 1,726 | worker (`quest-dragon.ts`) | Level-up page closed at once |
| 24 | Cannon and magic shortbow at the spiders | Defence 98-99, Ranged 55-99, HP 97-99 | 2,152 / 3,099 | 6,535 | worker (`gather-ranged.ts`) | Cannon plus melee, then the bow |
| 25 | Wilderness Agility Course | Agility 76-99 | 4,300 / 4,067 | 4,397 | worker (`agility-order` not delivered) | 3 ms run host for lap timing |

Cairn's cross-cutting techniques, with lab figures from https://rune.fast/tricks (third-party, ESTIMATE on our
clock): five blind dialogue continues a tick (10 pages in 2 ticks); one tick per dialogue page in a fixed
client (2 to 1); level-up page answered in the same tick (3 to 0 ticks lost); same-page relog (world seen on
tick 1, against 20-22 for a tab reload); five-click banking (24 deposits in 5 ticks); one-burst trades (23
stacks in 8 ticks against 29); knife reset (5.53 to 4.23 ticks per willow log; whole run 37,808 knife off,
35,069 knife on); bury inside the knife loop (0.23 against 2.07 ticks per bone); stun pack (Thieving 57-99 in
1,908-2,098 with Charge, Superheat and arrows inside the stuns); a run host 3 ms from the server (180 of 180
next-tick reactions against 123 of 180 through a relay). Our status for each is in `research/rival-gap-list.md`
section 2.

Cairn's own losses on the live run: Mining +313 (other bots on the zoo rocks), segment 24 +947 (541 ticks of a
death after a refused combat logout), segment 21 +115 (the knights' courier never topped up, so Superheat
stopped at Smithing 41).

## Per board

### Cooking (20 ticks)

Evidence (MEASURED live): stuncookv3 Cooking 99 at 20, no other skill, no QP. jackalopeck3 38, stuncook 51,
stuncookv2 53. Cairn's wine step: two relogs, 45-51 active ticks in the lab.

Method: GUESS. The login timer `~ferment_wines_login` (`login_logout/login.rs2:70`) sets the 20-tick
`fermenting_wine` timer (`skill_cooking/scripts/cooking_inv/scripts/wine/wine.rs2:72-73`), which ferments the
banked unfermented wine with no level check (`wine.rs2:22-41`). 99 needs 364 wines at 2,750 XP. A total of 20
ticks fits one timer firing at session tick 20 with all the wine already in the bank, and no ticks spent before
it. Playtime counts every logged-in tick (fact 4), so a bank-filling session would add its ticks. The evidence
does not show how the wine reaches the bank. The live code is newer (fact 6).

Ours: 217 / 229 modelled. Need: find the zero-tick bank fill, or accept second place.

### Fletching (56 ticks)

Evidence: nickarrowz 56, stunfletchv2 57, jackalopefr1 58, nickqzfletch 61, nickcopse 62. All single-skill, no QP.

Method: LIKELY arrows (15 per action, `skill_fletching/scripts/arrows.rs2:70-86`) and darts (10 per action,
`skill_fletching/scripts/darts.rs2:20-43`) at 5 actions a tick, cap 23,500 XP/tick at rune darts. The leaders
differ only in the start: tutorial skip (6 ticks, Cairn lab) and a one-burst trade (8 ticks).

Ours: 64 / 71. Gap 8 ticks, all in the start.

### Crafting (197 ticks)

Evidence: nickgemcut 197 (no QP). nickcrafti, nickcrafts, nickcrafty have QP 1 stamped at the 99 (Sheep Shearer,
LIKELY: 3,750 XP, `quests/quest_sheep/scripts/quest_sheep.rs2:5`).

Method: LIKELY gem cutting from 1 with no delay (`skill_crafting/scripts/gem/uncut_gem.rs2:15-63`). Ours: 272 /
273. Need: 305 uncut dragonstones and the bank cycle (`crafting-board.md`).

### Herblore (424 ticks)

Evidence (MEASURED live): nickelixir Herblore 99 at 424, **QP 4 at 281**. nickherbal Herblore 99 at 498, **QP 4
at 281**. jackalopehl2 447 (QP 4 at 450), stunherblore 465 (QP 4 at 468).

Method: CONFIRMED that all top four did a 4-QP quest; LIKELY Druidic Ritual (`general/configs/quest.constant:87`,
6,250 XP to level 28, `quests/quest_druid/scripts/quest_druid.rs2:3`). Two nick accounts with the same QP stamp
of 281 show one scripted quest of at most 281 ticks, then at most 143 ticks of potions (992,000 XP, about 6,900
XP/tick, inside the 5-a-tick cap). The vendored herblore scripts have no Druidic Ritual check, but Cairn states
that the quest is what lets an account train Herblore at all, and every leader does it. LIKELY: the live code
gates Herblore on the quest.

Ours: 881 / 885. Need: Druidic Ritual in 281 ticks or less, then the potion supply.

### Firemaking (660 ticks)

Evidence: nickcinder 660, cairn_ashes 664 (Cairn's test of segment 2), jackalopefma 673, nickkindle 673. All
single-skill.

Method: CONFIRMED. Log ladder at 4 ticks per log (`skill_firemaking/scripts/firemaking.rs2:98-117`); Cairn: helpers
drop logs on the tiles ahead, the level-up page is answered in the same tick, and dropped logs become public after
100 ticks. Ours: 720 / 745; `firemaking-order` is delivered. Need: dropper helpers and the same-tick level-up.

### Prayer (1,272 ticks)

Evidence: nickprayrec 1,272, stunpray 1,281. Single-skill, no QP.

Method: LIKELY 555 dragon bones at 2 ticks each = 1,110, plus about 160 ticks of setup and restock
(`skill_prayer/scripts/bury_bone.rs2:10-15`; 1,800 XP a bone). Ours: 9,660 / 10,271: the alone row does not use
dragon bones. Need: a dragon-bone row in `haggis-boards.json` and 560 bones.

### Magic (1,262 ticks)

Evidence (MEASURED live): nickhex Magic 99 at 1,262, **Hitpoints 75 at 1,157**, no QP. jackalopemg3 1,324 (QP 1
at 353); stunmage 1,513 (Prayer 38 at 197, HP 36 at 1,410, QP 1 at 492).

Inference:

- No QP, so no Imp Catcher. Mage Arena is not a quest and gives no QP.
- HP 75 = 188,722 XP; minus the 1,162 start = 5,641 damage at 33.25 HP XP per damage. At 50 Magic XP per damage
  that is 282,000 Magic XP, more than level 80 (267,169). So combat spells explain Magic 1 to 80 (LIKELY). The
  damage rate is 4.9 per tick, above one Fire Wave every 5 ticks (max hit 20). How they deal it is GUESS.
- Magic 99 105 ticks after the last HP level fits Mage Arena plus Charge: 163 casts at 5 a tick = 33 ticks
  (`skill_magic/scripts/spells/charge.rs2:1-27`, no `p_delay`; 4,500 XP a cast). Cairn measured 156-163 casts in
  32-33 ticks. CONFIRMED in code and by Cairn; LIKELY for nickhex.

Ours: 1,433 / 1,859. Gap 171. Need: a planner band for the Mage Arena worker (`scripts/generated/quest-magearena.ts`; Kolodion needs Magic 60,
`areas/area_mage_arena/scripts/kolodion.rs2:6`; Charge unlocks at `%magearena >= ^mage_arena_staff_given`,
`skill_magic/scripts/spells/charge.rs2:4-7`) and a faster combat leg to 80.

### Smithing (1,281 ticks)

Evidence: nickironhand 1,281, stunsmither 1,337. Single-skill, no QP.

Method: LIKELY platebodies at 5 ticks each with bars traded at the anvil (Cairn segment 21: 41-99 in 1,018).
Ours: 1,444 / 1,448. Need: an anvil worker with a bar helper; segment 21 has no worker.

### Runecraft (2,253 ticks)

Evidence: nickrc97 2,253, jackaloperc6 2,354, nickrc99 2,355, stunrc 2,397. All single-skill.

Method: LIKELY the altar-room rota: helpers stand at the altar with essence and trade one load each (Cairn:
air 1-44 in 206 with 7 helpers, body 44-99 in 1,512). Ours: 1,588 / 1,722, a model win of 665. Our measured
figures: 27 essence crafted in 5-7 ticks, a 12-tick trade (`board-ranking-honest.md`). Need: the helper rota and
the essence (about 4,213, `board-ranking-honest.md`).

### Thieving (2,635 ticks)

Evidence: nicksnatch 2,635, single-skill, no QP. jackalopeth8 2,935, stunthief 3,253, cairn_steals 3,342.

Inference: GUESS. Cairn's stun pack takes Thieving 57-99 in 1,908-2,098 (lab, 3 runs). If nicksnatch used knights
at that rate, its 1-57 leg took about 540-730 ticks, with no Fight Arena (no QP). Our measured fresh leg to 55 is
1,437-1,816 (`board-ranking-honest.md`); our whole fresh run is 6,169 MEASURED live.

Need: measure each band of our 1-55 leg live and find the loss; relog on stun; the stun pack.

### Woodcutting (3,069 ticks)

Evidence: zog207 3,069, zog206 3,114, nickbough 3,152, zog203 3,178, zog190 3,179. All single-skill.

Method: LIKELY the knife reset. One tick after each roll the bot uses a knife on a log and picks a fletching option,
which rewrites the action timer, so the next roll comes 3 ticks after the last (`skill_woodcutting/scripts/
woodcut.rs2:153-154`; Cairn: 4.23 against 5.53 ticks per willow log, 131 logs). Ours: 3,452 / 3,563. Need: the
knife reset in `woodcutting.ts`.

### Fishing (3,328 ticks)

Evidence: nicktrawler 3,328 and cairn_casts 3,425, both single-skill, no QP. stunfish 3,956 has QP 2 and Magic 46.

Method: GUESS. No QP rules out Sea Slug and the Fishing Contest. Cairn uses the knife reset on fly fishing too.
Ours: 4,737 / 4,821. Need: the knife reset on fishing, measured live.

### Mining (3,964 ticks)

Evidence: miner3 Mining 99, Attack 42, Strength 40, HP 40, all at 3,964 (one save; the real 99 is earlier).
cairn_rocks 4,317 (single-skill). stunmine 4,575 (QP 2), nickquarry 6,015 (QP 1 at 764: Doric's Quest).

Method: LIKELY the knife reset on iron at the six rocks south of the Ardougne zoo (Cairn segment 8, Mining 64-99
in 3,470 live; `research/rival-gap-list.md` row 1: 3.00 ticks per ore at respawn 13, 292 XP/tick). miner3's
combat 40 fits a contested or dangerous spot. Ours: 16,467 / 17,761; our measured iron is 97 XP/tick on 3 rocks
in practice. Need: the knife reset on mining at the zoo rocks, measured live.

Rejected alternatives (CODE-READ): limestone (loc_4027 to 4029, 662 XP, 3 ores then 40 ticks empty,
`skill_mining/configs/mine.dbrow:195-223`) gives about 43 XP/tick per rock. The 5-rock iron tile (3100,3767) is
deep Wilderness (`research/iron-spots.ts`).

### Attack, Strength, Defence (4,728 / 4,966 / 7,974 ticks)

Evidence (MEASURED live): stunattacker Prayer 43 at 178, Strength 83 at 1,248, Magic 48 at 2,517, QP 4 at 3,427,
Attack 99 at 4,728. stunhitpoint Prayer 43 at 178, Magic 47 at 1,260, QP 2 at 1,538, Strength 99 at 4,966.
stundefence Prayer 43 at 188, Strength 83 at 1,273, Magic 47 at 1,278, QP 2 at 1,420, Defence 99 at 7,974.

Inference: LIKELY. Prayer 43 in the first 200 ticks = 11 dragon bones for Protect from Melee. Strength 83 =
Waterfall Quest (343,750 Attack and Strength at 25x, `xp-per-tick.md`; level 83 is 329,063-352,720). 1 QP.
Magic 47-48 = Imp Catcher (21,875 XP, level 44) plus casting: the second QP. stunattacker's other 2 QP fit Tree
Gnome Village (286,250 Attack). The nick and lach specialists (Attack 99 with Strength 70 and HP 84, no QP) are
slower and use plain combat.

Ours: Attack 14,760, Strength 19,893, Defence 14,198 (floor). The model does not start these boards with Waterfall.
Need: a Waterfall-first row per combat specialist, Protect from Melee first.

### Hitpoints (17,058 ticks)

stunhitpoint reaches HP 99 at 17,058 after Attack and Strength. Ours: 13,864 / 15,104: a model win of 3,194.

### Ranged (5,595 ticks)

Evidence: nickslinger Ranged 99, HP 82, both at 5,595. No QP, so no Dwarf Cannon.

Inference: LIKELY plain ranged combat. HP 82 = 305,825 HP XP = 9,198 damage; at 100 Ranged XP per damage that is
920,000 Ranged XP, close to 99. Rate 1.8 damage per tick. Ours: 8,015 / 8,284. Need: the target and gear that
give 1.8 damage per tick; the cannon (Cairn segments 13 and 24) is faster but needs the quest.

### Agility (6,155 ticks)

Evidence (MEASURED live): nickstride Thieving 20 at 168, Smithing 20 at 336, Prayer 43 at 404, HP 26 at 1,986,
Magic 43 at 1,991, QP 2 at 2,147, Agility 99 at 6,155. stunagile Prayer 43 at 67, Agility 99 at 6,772.

Inference: LIKELY Protect from Melee first, then Wilderness laps (level 52, 14,285 XP a lap,
`skill_agility/scripts/wilderness_course.rs2:76-176`). Cairn's Wilderness segment: 76-99 in 4,067. The 2 QP and
the Thieving and Smithing levels are GUESS (no quest found that gives exactly these). Ours: 20,325 / 21,207.
Need: a delivered `agility-order` with Wilderness laps; measure the lap live.

### Quest Points (145 QP at 73,866 ticks)

Evidence: stunquestv3 has QP 145 at 73,866 and combat 99s (Attack 12,134, Defence 28,641, Strength 32,886,
Agility 55,328, Magic 55,677, HP 61,665). The next account is qu3st at 1,001,957.

Inference: LIKELY a quest-first route with combat trained for the quest bosses. Ours: 102,111 / 115,717 (scenario
a). The QP deadline is 73,865 ticks, not 1,022,261.

### Overall (35,787 ticks)

See the segment table. Ours: 41,438 / 44,006 (scenario a). The biggest model gaps against Cairn's segments: 24
(+4,383), 14 Monkey Madness (+938), 20 four quests (+859), 10 Grand Tree (+851), 18 body altar (+692), 6
Woodcutting (+637).

## World feed

At 23:15Z the roster had 1,311 players. Of the 98 board accounts, only stunquestv3 (3185,3447, Varrock west bank),
qu3st (2734,9690, combat animations 390 and 1156, 12 hits), avery (2708,9435, combat, NPC types 1591-1592) and
wodressbot were online. No specialist leader (nick*, stun* skill accounts, zog*, cairn_*, jackalope*) was online.
A finished account adds nothing to its board time, so the methods above come from stamps and Cairn's pages, not
from observation. MEASURED live.

## Boards where the method is understood and reproducible with our stack

Ranked by the model gap at floor, smallest first, for boards where the method is LIKELY or CONFIRMED and our
stack has a worker for it.

1. **Runecraft**: altar-room rota; model wins by 665. Need helpers and essence.
2. **Hitpoints**: combat after Attack and Strength; model wins by 3,194.
3. **Fletching**: arrows and darts; gap 8 ticks, all in the tutorial skip and the first trade.
4. **Firemaking**: log ladder; gap 60; `firemaking-order` delivered. Need dropper helpers.
5. **Crafting**: gem cutting; gap 75. Need dragonstone supply.
6. **Smithing**: platebodies; gap 163. Need an anvil worker with a bar helper.
7. **Magic**: combat spells, Mage Arena, Charge; gap 171. Need a planner band for the Mage Arena worker.
8. **Woodcutting**: knife reset; gap 383. Need the knife reset in `woodcutting.ts`.
9. **Herblore**: Druidic Ritual then potions; gap 457. Need a 281-tick quest and potion supply.

Not yet understood or not reproducible: Cooking (20 ticks, the bank fill is unknown), Thieving (the 1-55 leg),
Mining and Fishing (knife reset on these skills not built), Prayer (model row missing), the combat boards (no
Waterfall-first rows), Agility (lap worker not delivered), Quest Points.

## Open

- Cooking 20: how the wine reaches the bank with no ticks spent.
- Herblore: whether the live code gates Herblore on Druidic Ritual (the vendored copy does not).
- Magic: how nickhex deals 4.9 damage per tick in the combat leg.
- Thieving: the 1-55 leg of nicksnatch.
- The live playtime normalization rule (fact 6).
