> Current authority: all gameplay techniques are authorized. Wine, cocktails, pyre oil, Charge, relogs and tick manipulation need no further approval. Missing supplies create acquisition work, never a route exclusion. Where a restriction or model total below conflicts with this, this applies. See [AGENTS.md](../AGENTS.md).

# Rival gap list: bleugreen/rs-sdk against our Haggis plan

Source: `bleugreen/rs-sdk` (MIT, "Copyright (c) 2025 Lost City"), branch `main` at commit `3bd2ab0a`
(committed 07:44:55Z). We read `docs/speedrun/` and `speedrun/README.md` as raw text through GitHub. We did not
clone, download, copy or run any file from that repository. Every number from that repository is third-party data.
For our clock it is **ESTIMATE**, even where the rival labels it "m" (measured on their lab or the demo).

Rival labels: **m** measured, **r** read in code, **i** inferred, **e** estimated. Our labels: MEASURED, CODE-READ,
ESTIMATE (`research/INDEX.md`). Paths that start with `C/` are in `vendor/rs-sdk/server/content/scripts/`. Paths
that start with `E/` are in `vendor/rs-sdk/server/engine/src/`. Every cited line was read.

Short names for the rival files:

- `RO` = `docs/speedrun/RUN-ORDER.md` (the scored run, steps S00-S27).
- `ES` = `docs/speedrun/research/engine-sweep.md` (section 8 is the measured top ten).
- `QR` = `docs/speedrun/quests/README.md` (quest value table).
- `SP` = `docs/speedrun/research/stun-pack.md`.
- `TM` = `docs/speedrun/skills/tick-manipulation.md`.
- `IL` = `docs/speedrun/skills/interleaving.md`.

## 1. The rival plan in numbers

| Figure | Ticks | Label | Source |
|---|---|---|---|
| Steps and legs, knife on | 33,882.7 expected, 32,578.9 best | m/i | RO section 2, last row |
| Legs (27 travel rows) inside that sum | 2,283.3 | m | RO section 2, `T..` rows (our sum) |
| Row in force (supply forecast) | **35,671.7 expected, 33,111.0 best** | i | RO section 7 |
| Expected plus Monkey Madness bad case plus S13 railings at p90 | 36,083.0 | i | RO section 7 |
| Knife loops off all night | 37,844.0 expected | i | RO headline |
| Record they chase (stunbaron) | 35,916 | MEASURED live | RO line 6 |

The scored account is one account with a helper fleet (22 altar givers, a mule, bone and wine givers).
Three board leaders are rival demo test accounts: `cairn_ashes` (Firemaking 664, RO S03), `cairn_chops`
(Woodcutting, RO S07) and `cairn_casts` (Fishing, RO). So those three records are rival single-skill runs.

## 2. Techniques: status, ticks on our clock, engine code, class

"Lever" is the id in `packages/planner/src/haggis-boards.json`. "Saved" is the Overall finish saving in scenario a,
from the HEAD table plus the rival rows (script in section 7). "Alone" = only that rival lever on, with all existing
safe levers. "Last" = that lever switched off from all on. Floor / realistic. All ESTIMATE.

| # | Technique (rival figure) | Our status | Lever | Saved alone | Saved last | Engine code in our copy | Class |
|---|---|---|---|---|---|---|---|
| 1 | Knife starter on a 6-rock iron rotation at the Ardougne zoo (2602-2605,3233-3237): 3.00 ticks/ore at respawn 13, 3.50 at respawn 19 = 292 / 250 XP/tick (m, `skills/mining.md` section 1, TM section 1) | **built, practice only**: `scripts/mining-rotation.ts` (MINING_KNIFE=1) mines 3.19 to 3.22 ticks/ore = 272 to 274 XP/tick MEASURED practice at the zoo at seen respawn 18; no knife 4.32 (202), the drop worker 9.36 (93) (`research/aio-bench.md`, "The knife reset on the Ardougne zoo iron"). Not run live | `rival-knife-mine` | 3,023 / 3,887 | 3,023 / 3,887 | `C/skill_fletching/scripts/cut_logs.rs2:83-84` sets `%action_delay` to now + 2. `C/skill_mining/scripts/mining.rs2:118-120` keeps an `%action_delay` already in the future. `E/engine/entity/Player.ts:876-879` `closeModal` clears the weak queue, so the fletch never runs. Respawn scales by player count (`C/general/scripts/player_count.rs2:4`) | accepted (tick manipulation, R10) |
| 2 | Altar room Runecraft: helper trades 27 essence beside the altar, 7-tick cycle, 22 givers. Air 1-44 in 60, nature/body 44-99 in 1,136 (m lab, RO S06, S21) | **missing**. We MEASURED a 19-tick cycle (`runecraft-ladder.md`) | `rival-altar-room-rc` | 60 / 1,422 | 60 / 1,422 | `C/skill_runecraft/scripts/runecraft.rs2:95` grants XP before `p_delay(3)` at `:99`. Trades are normal | accepted (helper swarm) |
| 3 | Monkey Madness reward option 1: 35,000 base Strength and Hitpoints, 20,000 Attack and Defence. 4,790.5 expected, 4,565.7 best, never run end to end (RO S15) | **missing** from every plan file | `rival-monkey-madness` (row `rival-mm`) | -2,433 / -1,381 | -823 / +1,427 | `C/quests/quest_mm/scripts/mm_daero.rs2:294-302` (`stat_advance` 350000 = 875,000 XP at 25x) | accepted (quest) |
| 4 | Stun pack at post-MM stats: Thieving 57-99 in 1,908 / 2,098 / 1,997 (3 runs), HP 97, with Charge, arrows and bones inside the stuns (m lab, SP section 1). Thieving 1-57 comes from Fight Arena | **code-read only**. Our `stun-guests` lever is ESTIMATE. Live fresh run 6,169 MEASURED live | `rival-stun-pack` (row `rival-fight-arena`) | 574 / 1,519 | 604 / 2,056 | Stun 8 ticks: `C/skill_thieving/configs/pickpocking/pickpocket.dbrow:87`. Fight Arena XP: `C/quests/quest_arena/scripts/quest_arena.rs2:270-271` | accepted |
| 5 | Bury every bone in the free ticks of the 3-tick knife Woodcutting loop: Prayer 1-99 costs +145 (RO S25b, IL rule 6) | **MEASURED practice**: `scripts/generated/woodcutting.ts` buries one bone in each knife cycle with no roll lost; Woodcutting 1-99 and Prayer 1-99 in 3,431 / 3,223 / 3,334 ticks (seeds 7 / 8 / 9) with a bone giver at the trees (`extra:woodcut-givers-block5`, [aio-bench.md](aio-bench.md#bones-from-a-giver-at-the-trees)), 3,757 / 3,803 / 3,790 with bank trips (`extra:woodcut-bury-block5`) | `rival-bury-in-knife-wc` | 1,054 / 636 | 1,054 / 1,155 | `C/skill_prayer/scripts/bury_bone.rs2:10` `p_delay(0)`. `C/skill_woodcutting/scripts/woodcut.rs2:153-154` 3-tick reroll | accepted |
| 6 | The Grand Tree before the Agility laps: 197,500 Agility (to 75) and 460,000 Attack. 1,259 fastest browser chain (RO S11b) | **have the row**, but `combat-hp-bound` sets it to serve Quest Points only, so it runs after Overall | `rival-grandtree-agility` | -778 / -2,858 | 825 / 0 | `C/quests/quest_grandtree/scripts/quest_grandtree.rs2:199-201` | accepted |
| 7 | Dialogue bursts: up to 5 blind continues a tick. Burst saved 879 of 11,689 fixed quest ticks, 7.52% (RO:106-109) | **missing**. `scripts/generated/waterfall.ts:200,213` clicks one page per loop | `rival-dialogue-burst` | 91 / 249 | 68 / 181 | `E/network/game/client/handler/ResumePauseButtonHandler.ts:7-21` (no page id, no delay check). `E/network/game/client/model/ResumePauseButton.ts:5` is a USER_EVENT. `E/engine/entity/NetworkPlayer.ts:141-142` counts only successes | accepted (client speed) |
| 8 | Wilderness lap 66 ticks lab, 74 demo inferred: Agility 75-99 in 4,114 = 197 XP/tick (RO S17, `skills/agility.md` section 1) | **estimate only** (67-90 ticks from the web) | `rival-agility-lap` | 0 / 876 | 0 / 726 | `C/.../wilderness_course.rs2:17-176` (our row source) | accepted |
| 9 | Sea Slug: 179,375 Fishing (to 74) in 304 browser / 495 stock (RO S19, QR) | **missing** | `rival-sea-slug` (row `rival-seaslug`) | 87 / 67 | 87 / 67 | `C/areas/area_ardougne_east/scripts/caroline.rs2:45`. Firemaking 30 gate: `C/quests/quest_seaslug/scripts/quest_seaslug.rs2:43` | accepted |
| 10 | Charge with no cooldown: 163-165 casts, Magic 80-99, inside the stuns. Mage Arena 382 expected, 336 best (RO S16, S18c) | **code-read**: owner lever `charge-spam` | `charge-spam` (Mage Arena ticks patched to 336 / 581) | owner | owner | `C/skill_magic/scripts/spells/charge.rs2:1-27`, see section 5 | **owner decision** |
| 11 | Login wine: two arming relogs ferment the banked wine, Cooking 30-99 in 81 (RO S25c, `research/wine-window.md`) | **MEASURED practice** (`cooking-board.md`), authorized by the owner | trick `loginWine` (no change) | about 1 tick in the model | | `C/skill_cooking/scripts/cooking_inv/scripts/wine/wine.rs2:8,22-70,72-73`, `C/login_logout/login.rs2:70`, see section 5 | **eligible gameplay mechanic** |
| 12 | Five-packet interleaving: at most 4 user events a tick, helpers first and the click last, no helpers while walking, delayed actions only in free ticks (IL checklist 1-8) | **partial**. We know the 5-event cap (INDEX fact 1) and `s.direct`. The 4-not-5 rule and the backlog effect (205 dead ticks, IL rule 2) are new | enables rows 4 and 5 | | | `E/network/game/client/ClientGameProtCategory.ts:5-6` (20 client, 5 user). `E/engine/entity/NetworkPlayer.ts:136-147` | accepted |
| 13 | Refused USER events spend CLIENT slots (20), not USER slots (5): over-sending is free (ES section 8 #6, m) | **code-read** (INDEX fact 1) | none | | | `E/engine/entity/NetworkPlayer.ts:141-147` | accepted |
| 14 | Level-ups never stall a delay-free item-on-item burst: each OPHELDU closes the chat (ES #4, m: 27 gems over 31 levels at the level-99 rate) | **MEASURED practice** (`levelup-cost.md`). Settles C5 for item-on-item. Bank opens still pay | none | | | `E/network/game/client/handler/OpHeldHandler.ts:54-55` `clearPendingAction` | accepted |
| 15 | One make-X completion a tick: a second one drops packets for that tick and the next, and loses the first product (ES #7, m) | **missing** as a rule | none (a guard) | | | `C/.../chat.rs2:734-738` per rival (not read by us) | rule |
| 16 | Inventory op with the bank open: the server accepts it, the SDK refuses it client-side. 0 ticks saved with their client, about 1 tick per bank cycle with a blind raw sender, 45-75 over four skills (ES #5, i) | **missing** | none | | | `E/network/game/client/handler/OpHeldHandler.ts:54-55` | accepted (engine allows it) |
| 17 | Battlestaves 5 a tick, 687.5 base per tick; Ugthanki kebab 5 a tick, 600 base per tick from Cooking 37; magic potion 2-5 ticks (ES #2, #3, #8, m) | **missing** (supply fallbacks) | none | | | kebab: `C/skill_cooking/scripts/cooking_inv/scripts/ugthanki_kebab/ugthanki_kebab.rs2:127,135` (a roll, no level gate) | battlestaves accepted. Kebab: **content bug** (no Cooking gate) |
| 18 | Agility Arena tickets: 140,000 base in one tick, but tickets are untradeable (ES #1) | closed by them | none | | | per rival `agilityarena_tickettrader.rs2:60-68` (not read by us) | content bug, no use |

Not modelled because the planner rows have no slot for them: rival Magic 1-59 in 213 ticks (4 strikes and 60
enchants of high-tier jewellery, RO S02-S04), Superheat in the stuns (Smithing 1-55, RO S18), the cannon session to
Ranged 50 before MM (RO S14, 118), and Dragon Slayer before the Defence finish (RO S26).

## 3. The Overall finish after the rival rows

Scenario a, all safe levers on, `research/hiscores-live.json`. The commit holds only rows that this file adds or
patches, on top of HEAD `3315824` (which already has Waterfall at 1,030 / 1,037 from commit `34b1c24`).

| Table | Floor | Realistic | Evidence |
|---|---|---|---|
| HEAD `24eefdb` (start of this work) | 31,140 (slack +4,776) | 45,916 (gap 10,000) | ESTIMATE (model) |
| HEAD `3315824` (Waterfall cut, before the rival rows) | 31,010 (slack +4,906) | 45,789 (gap 9,873) | ESTIMATE |
| **HEAD + rival rows (this commit)** | **27,722 (slack +8,194)** | **38,195 (gap 2,279)** | ESTIMATE |
| HEAD `3315824`, all safe + all owner levers + all tricks | 28,139 | 43,822 | ESTIMATE |
| HEAD + rival rows, all safe + all owner levers + all tricks | 27,053 | 37,643 | ESTIMATE |

The rival rows save 3,288 floor and 7,594 realistic. The per-lever savings in section 2 are the same on both HEADs.

CLI line (`bun packages/planner/src/haggis-cli.ts research/hiscores-live.json --levers`):
`| Overall (#1 stunbaron) | 35,916 | 27,722 | +8,194 WIN | 38,195 | -2,279 LATE |`.

Caveats:

- The rival figures are lab runs at 300 ms with 1-tick reactions. Our live reactions cost more. Our realistic
  column takes the rival figure where we had nothing better, so realistic is optimistic for rows 1, 2, 3 and 4.
- The model still prices almost no travel. The rival prices 2,283 ticks of legs and about 1,789 of allowances
  (35,671.7 - 33,882.7). Our floor is optimistic by up to about 4,000 ticks for that reason alone.
- Monkey Madness has never run end to end for the rival. Its temple trapdoor killed their account once in 3 tries
  (`quests/monkey_madness.md`, Risks).
- The `--levers` table in the CLI does not list the rival levers, because `LEVERS` in
  `packages/planner/src/haggis.ts` (not owned here) does not name them. So its "none" row includes them. The lines
  to add are in section 8.

## 4. Run order, board by board

"Rival 99 at" is the cumulative step tick at the end of the step that finishes the board (RO section 2 expected,
legs included, allowances not included). "Rival ticks" is the step cost. "Ours HEAD" is the realistic segment cost
in the HEAD plan (CLI `--order`). "Ours now" is the same after the rival rows.

| Board | Rival 99 at | Rival ticks (expected) | Ours HEAD realistic | Ours now realistic (floor) |
|---|---|---|---|---|
| Firemaking | 755 | 661 (m demo) | 720 | 720 (628) |
| Woodcutting | 4,278 | 3,055 knife | 2,957 flinch | 2,957 (2,071) |
| Prayer | 4,481 | 145 inside S07 | 0 foreground (1,300 inside stuns) | 145 (115) |
| Mining | 8,229 | 3,577 (Doric 17, Plague City 403, knife 3,157) | 7,851 (Dig Site 1,500, iron 6,351) | 3,851 (2,665) |
| Attack | 11,086 | 1,204 (TGV 678, Fight Arena 526) | 3,783 (Waterfall 1,164, melee 2,619) | 5,220 quests, 0 melee (2,423) |
| Thieving | 19,948 | 2,026 (+ Fight Arena) | 6,169 | 2,098 + 720 (1,908 + 499) |
| Magic | 19,948 | 595 (strikes, enchants, Mage Arena) + Charge in stuns | 781 spill (1,119 inside stuns) | 1,295 spill (1,038) |
| Fletching | 19,948 | 0 (inside stuns) | 55 | 55 (49) |
| Runecraft | 21,964 | 1,196 (+ 224 legs) | 2,976 | 1,554 (1,196) |
| Fishing | 23,994 | 2,625 (Sea Slug 311, Fishing Contest 319, knife 1,995) | 3,130 | 3,063 (2,092) |
| Smithing | 25,711 | 940 (+ Superheat in stuns) | 1,100 | 1,100 (913) |
| Crafting | 25,802 | 91 (+ Dwarf Cannon quest 918, Crafting 1-42) | 213 | 213 (80) |
| Herblore | 25,969 | 167 (+ Druidic Ritual) | 306 | 306 (95) |
| Cooking | 26,050 | 93 (Cook's Assistant 12, login wine 81) | 20 | 20 (19) |
| Strength | 27,430 | MM 4,790 + Dragon Slayer 1,338 | 2,619 melee | MM 5,052 (4,566), 0 melee |
| Defence, Ranged, Hitpoints | 29,583 | cannon 118 + finish 1,972 | 5,782 (def 3,994, ranged 533, HP 355, Witch 900) | 5,323 (3,189), no cannon side XP now |
| Agility | 33,883 (last) | 4,228 (+ Grand Tree 1,352) | 6,532 | 4,164 (3,636) + Grand Tree 3,000 (1,259) |
| Overall | 35,671.7 in force | | 45,916 | 38,195 (27,722) |

### The 10 biggest differences (HEAD realistic minus rival expected)

1. **Mining, +4,274.** Rival: quest XP to 64, then the knife rotation at 292 XP/tick. Ours: 97 XP/tick on 3 rocks.
   Recommendation: build the zoo rotation with the knife starter and measure it in practice (3 runs, respawn set to
   13). Lever `rival-knife-mine` holds the estimate.
2. **Thieving, +3,617.** Rival thieves after Monkey Madness (HP 97, no food stops) from Thieving 57 (Fight Arena).
   Ours starts at Thieving 1 with 10 HP. Recommendation: move Thieving after the HP quests. Measure Ardougne knights
   from 57 at HP 90+. Lever `rival-stun-pack`.
3. **Melee and Hitpoints, +3,270.** Rival: Monkey Madness, then Dragon Slayer, then a cannon finish. Ours: Waterfall
   and melee top-ups, Dragon Slayer after Overall. Recommendation: script Monkey Madness (largest single XP lump,
   2,250,000 combat XP). Put Dragon Slayer before the Defence top-up. Lever `rival-monkey-madness`.
4. **Agility, +2,304.** Rival does the Grand Tree first (Agility 75) and laps at 66-74 ticks. Ours runs the Grand Tree
   after Overall. Recommendation: measure a Wilderness lap live, and measure the Grand Tree with Fire Bolt under
   Protect from Melee. Our realistic 3,000 for it is a guess. Levers `rival-grandtree-agility`, `rival-agility-lap`.
5. **Runecraft, +1,556.** Rival: 7-tick altar-room cycle with givers. Ours: 19-tick cycle. Recommendation: put the
   giver beside the altar and send the craft on a fixed tick. Count how many helpers keep the cycle at 7 (the rival
   needs 22). Lever `rival-altar-room-rc`.
6. **Travel and allowances, -4,072 (ours lower).** The rival prices 2,283 of legs and about 1,789 of allowances. Our
   model prices almost none. Recommendation: add one travel row per leg, using our own walks where measured.
   This is the largest error in our floor.
7. **Fishing, +505.** Rival: Sea Slug and Fishing Contest to 78, then knife fly fishing at 3.80 ticks a catch.
   Recommendation: add Sea Slug after Firemaking 30. Measure flinch fishing live against the knife figure.
   Lever `rival-sea-slug`.
8. **Magic, +186 foreground (board time differs more).** Rival: Magic 1-59 in 213 ticks at the start (strikes,
   then 60 enchants of sapphire to diamond jewellery). Recommendation: copy the order (cheap early Magic for the
   combat spells), and keep Charge as the owner decision.
9. **Smithing, +160.** Rival: Superheat inside the stuns takes Smithing 1 to 53-55. Recommendation: add Superheat as
   a stun guest after the stun pack is measured.
10. **Herblore +139 and Crafting +122.** Rival: Druidic Ritual first, then supply-safe potions in 167. Crafting
    1-42 from Dwarf Cannon, which we also do. Recommendation: let the Dwarf Cannon XP shorten the Crafting row (the
    row has fixed ticks, so prior XP does not reduce it now).

Smaller: Firemaking +59, Woodcutting -98 (ours better if flinch holds live), Cooking -73 (ours better, and the
rival uses the login wine), Prayer -145 foreground (ours hides it in the stuns, which the stun pack now needs).

## 5. Server mechanics eligible for use

1. **Login wine** (rival S25c uses it). `wine.rs2:8` checks Cooking 35 only when the player makes a wine.
   `wine.rs2:22-70`, the fermentation timer, has no Cooking check. It ferments every unfermented wine in the bank in
   15 batch rolls (`:26-41`) plus the inventory. `login.rs2:70` calls `~ferment_wines_login` (`wine.rs2:72-73`),
   which starts the 20-tick timer on every login, with or without a wine made on that login. It is worth about 1 tick in our
   model.
2. **Charge with no cooldown and no delay** (rival S18c uses it). `charge.rs2:1-27` has no `p_delay`. Every other XP
   spell has one (`research/leader-forensics.md:144-146`). The recast check at `charge.rs2:8-12` is commented out
   with the note "this was added sometime in 2005". Rev 289 is dated January 2005 (`research/web-research.md:237`), so
   a missing recast check fits this revision (`research/gap-closers.md:117`). The missing delay has no such note.
   The commented check also reads `%charge_god_spell`, but the spell sets `%magearena_charge` (`charge.rs2:18`), so
   the check would not stop a recast even if it ran. Verdict: the recast is authentic for the revision. Five casts a
   tick is a probable content bug. On our clock (working tree CLI): `charge-spam` saves 882 / 647 alone and
   669 / 551 last.
3. **Gnome cocktail finishing has no Cooking check** (NEW). `C/skill_cooking/scripts/gnome_cooking/gnome_cocktail_finish.rs2:30`
   grants 600 tenths with no `stat` check (the rival lists it in ES Table 2). Our "legal" `cook-35` row uses it to
   reach Cooking 35. It is the same family as the wine bug (a missing level check). The owner should rule on it,
   because the Cooking board (leader 38 ticks) depends on it.
4. **Ugthanki kebab has no Cooking check**. `ugthanki_kebab.rs2:127` is a success roll, not a gate. The rival keeps
   it as a fallback if grapes run out. Not in our plan.
5. **Pyre logs have no Firemaking check** (`fm-pyre`, already the `sacredOil` trick).

Accepted mechanics (no owner decision): knife tick manipulation, dialogue bursts, 5-event packing and over-sending,
interface buttons during a delay, prayer flicking with zero drain, helper trades inside the stun and the altar room.

## 6. Quest pitfalls in the rival notes that we have not hit yet

Our quest list is `research/quest-plan.md` section 3. Each pitfall cites the rival note (`docs/speedrun/quests/`).
"Checked" means we read the line in our copy.

1. **Black Knights' Fortress needs 12 QP.** `C/areas/area_falador/scripts/sir_amik_varze.rs2:14` (checked).
   `quest-plan.md:121` says the 8 short quests have no requirement. Put Black Knights' Fortress after 12 QP.
2. **The Grand Tree black demon deletes itself** when its player is gone or more than 17 tiles away
   (`C/quests/quest_grandtree/scripts/grandtree_black_demon.rs2:15-21`, checked). A logout or a retreat between the
   trapdoor and the kill replays Glough's scene. The demon does not attack first. Protect from Melee at Prayer 43
   lasts about 215 ticks (`grand_tree.md`).
3. **The Grand Tree Agility 25 check uses the boosted level** (`quest_grandtree.rs2:25` per rival). Agility 22 and a
   potion pass. The quest needs 2 free slots for bark and book and 4 for the twigs. The foreman quiz and the
   translation have fixed answers. A wrong translation does not move the stage (`grand_tree.md`).
4. **Tree Gnome Village scenes drop clicks.** The Commander scene holds the player about 5 ticks. The ceremony is
   silent for about 17 ticks. A bot that reads a closed chat box as "done" stops early (`tree_gnome_village.md`).
5. **Fight Arena death hooks need the player inside the arena.** Arena monsters live 500 ticks and other players
   share them. On the live server other bots can be in the arena (`fight_arena.md`, `quest_arena.rs2:207,244` per
   rival).
6. **Waterfall: do not walk away from Golrie mid-dialogue.** He pauses twice before he gives the pebble
   (`golrie.rs2:7-15` per rival). The statue without all 18 runes drops a boulder for 20. The rope crossing spawns
   locs for 8 ticks, so do not log out there (`waterfall.md`).
7. **Dragon Slayer: a death after sailing resets Ned and the planks** (`dragonslayer_ned.rs2:23-24` per rival).
   Oziach gives the maze key only if none is in the inventory or the bank. Ask Oziach all three map questions, or
   Wormbrain does not talk. Fight Elvarg at 60+ HP (1 death in 2 at 40/40/40) (`dragon_slayer.md`).
8. **Dwarf Cannon: railing fails cost up to 3 HP each.** The shed door shuts. Dwarf remains respawn in 100 ticks, so
   on the live server another player can take them first (`dwarf_cannon.md`).
9. **Dig Site: the chest relocks 300 ticks after the key** (`C/quests/quest_itexam/scripts/area_digsite.rs2:787`,
   checked), and the key is used up. Do not log out between the chest and the powder. Dropped chemicals explode for
   25-65. The level-3 dig refuses with a full inventory. The finds have a long tail (p99 about 1,500)
   (`digsite.md`).
10. **Merlin's Crystal: Morgan Le Faye's interrupt fails if the player is delayed** (`sir_mordred.rs2:10` per rival).
    Then Mordred respawns in 50 ticks. The Thrantax words are shuffled, so pick by text. The quest intercepts the bat
    bones drop (`opheld5`), so an SDK drop helper hangs (`merlins_crystal.md`).
11. **Holy Grail: the Entrana boat refuses weapons and armour, even in the inventory.** There is no deposit box.
    The bell needs a maiden within 4 tiles. Keep two whistles. Wear Excalibur when the Titan reaches 0 HP
    (`holy_grail.md`).
12. **Witch's House: if the witch sees the player,** she teleports them out, deletes the key and the ball, and
    resets the stage (`quest_points.md`).
13. **Logout is refused for 16 ticks after combat** (`C/login_logout/logout.rs2:28`, checked:
    `p_preventlogout(..., 16)`). 16 of 159 quest varps are temporary and reset on logout (Monkey Madness cutscenes,
    the Regicide still, the Mort'ton temple) (`primitives.md` section 8).
14. **Monkey Madness: the temple trapdoor** is boxed in by five level-167 guards (1 death in 3 tries). Two forced jail
    cycles cost 55-73 ticks each. Gate: Narnode starts it only after the Grand Tree and Tree Gnome Village
    (`king_narnode.rs2:7-10` per rival) (`monkey_madness.md`).

## 7. What changed in `packages/planner/src/haggis-boards.json`

All new values are ESTIMATE and cite `bleugreen/rs-sdk@3bd2ab0a` and the file. No existing number changed unless a
rival lever is on, except the owner-lever patch on `mage-arena`.

- New rows (lever `add`): `rival-fight-arena`, `rival-mm`, `rival-seaslug`. Their QP is 0 because their points are
  already inside `quests-rest` (142 total). Without that, the model counted 148 QP and showed a false Quest Points win.
- Patches: `mine` (knife rates), `runecraft` (1,196 / 1,554), `dig`, `cannon`, `witch`, `dragon`, `scorpion`,
  `qp-filler`, `merlin`, `grail`, `quests-rest` (ticks x 0.9248 for the burst), `grandtree` (serves Agility, floor
  1,259), `tree` (floor 665), `prayer` (inside `woodcut`), `woodcut` (dead ticks 1,054 / 1,155), `agility`
  (realistic 197), `thieve` (1,908 / 2,098, dead ticks, requires Fight Arena and MM), `thieving-25` (after Fight
  Arena), `fish` (82.0% of the flinch ticks, after Sea Slug), `mage-arena` (owner lever `charge-spam`: 336 / 581).
- Waterfall has no burst patch. It is MEASURED (1,030-1,037 since `34b1c24`), and a fixed patch would go stale when the script changes.
- Test: `packages/planner/test/haggis.test.ts`, "rival levers ...": 9 lever ids, ESTIMATE rows with the rival
  source, no blocks with the levers on or off, 142 QP.

The deltas in section 2 come from a scratch script that runs `schedule()` with each rival lever in `disable`, on HEAD
plus these rows. It is not in the repo.

## 8. Open items

- `LEVERS` in `packages/planner/src/haggis.ts` needs 9 lines so the CLI table shows the rival levers:
  `rival-knife-mine`, `rival-altar-room-rc`, `rival-dialogue-burst`, `rival-grandtree-agility`,
  `rival-bury-in-knife-wc`, `rival-agility-lap`, `rival-stun-pack`, `rival-monkey-madness`, `rival-sea-slug`, each
  `owner: false`.
- Two rival levers lose time alone: `rival-monkey-madness` (-2,433 / -1,381) and `rival-grandtree-agility`
  (-778 / -2,858). They pay only with the stun pack and the melee rows they replace. Monkey Madness loses 823 at
  floor even last. Keep them on for realistic, and measure before the run order commits to them.
- `rival-bury-in-knife-wc` is priced on the rival 3-tick loop. Our Woodcutting row assumes the 2-tick flinch, which
  has fewer free ticks. Not checked.
- Not costed by us: the rival travel legs, Doric's Quest and Plague City for Mining 1-64, the Magic 1-59 opening,
  Superheat in the stuns, the cannon finish.
- The survey says the rival expects 38,742 (best 31,324) (`research/botting-ecosystem-2026-10-23.md:19-20`).
  RO at `3bd2ab0a` says 35,671.7 expected and 33,111.0 best for the row in force. We did not find 38,742 in RO.
