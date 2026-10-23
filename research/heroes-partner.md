# Heroes' Quest partner: account, route and timing (2026-10-23)

Tracker row C26 (`research/owner-requests.md`). Heroes' Quest needs two accounts. Haggis does the Black Arm side.
The partner does the Phoenix side. Without the partner, Heroes' Quest, Throne of Miscellania and Legends' Quest are
lost, and the Quest Points total stops at 139 (`research/quest-plan.md` section 1l).

Code cites are under `vendor/rs-sdk/server/content/scripts/`. Evidence levels follow `research/INDEX.md`. No live
login, practice bot or planner change was made for this file.

## Result

- **Partner: Bigchopper.** Woodcutting 99 is done (rank 17 at 11,315 ticks, `research/hiscores-live.json`), so the
  Lost City gate (Woodcutting 36) is met and questing costs it no board time.
- **Route: 24 quests, 55 QP.** 21 quests have a MEASURED practice script. 3 quests have no script: Lost City
  (mandatory), Witch's House and Cook's Assistant.
- **Ticks: about 13,300 / 14,700 for the quests and the skill gates (floor / realistic).** 11,776 / 12,179 of that
  is MEASURED. Travel between quests is not counted. With travel the total is about 16,000-19,000 ticks
  (ESTIMATE), or 1.8-2.1 hours at 399.8 ms per tick.
- **Timing rule:** the partner cannot finish Shield of Arrav before Haggis does Arrav, because the partner's
  certificate comes from Haggis's curator visit. So Haggis must do the `quest-arrav` pair early. Today the planner
  puts it after `quests-rest`, which holds Heroes' Quest. That order is wrong for Haggis too (see "Timing").

## 1. Account choice

Status files `.practice/status/<name>.json`, read 2026-10-23. Every account below is on `rs-sdk-demo.fly.dev`.

| Account | Skills above 1 (not Hitpoints) | Combat, HP | Position | Use now | Verdict |
|---|---|---|---|---|---|
| **Bigchopper** | Woodcutting 99, Fletching 32, Thieving 35 | 3, 8/10 | 3206,3239 (Lumbridge) | idle (`fail stop file`); proposed log and arrow supplier in `research/supply-logistics.md:158,170` | **chosen** |
| Woodpecker | Woodcutting 49, Thieving 22 | 3, 0/10 (died) | 3233,3243 | Woodcutting board run, not finished | no: its board is still open |
| Moneyshot | Thieving 23 | 3, 10/10 | 2655,3283 | banker that holds the vault (`scripts/banker.ts`) | no: busy |
| mmsmk1232 | no status file | - | - | smoke-test account (`research/demo-smoke-2026-10-22.md:3`) | possible spare |
| new account | none | 3, 10 | Lumbridge | - | second choice |

Reasons for Bigchopper:

1. Woodcutting 99 meets the dramen tree gate (`quests/quest_zanaris/scripts/quest_zanaris.rs2:37`). A new account
   needs 11,704 XP for Woodcutting 36 (`packages/planner/src/curve.ts`).
2. Skill boards rank by the playtime tick at which each level was reached (`Player.ts:337` `levelPlaytime`, memory
   note "board time frozen"). Bigchopper's Woodcutting time stays at 11,315.
3. It starts in Lumbridge, beside the first 5 quests of the route.
4. Its combat is the same as a new account (combat 3, Hitpoints 10). The route builds combat from quest XP.

Cost: the log and arrow supply in `supply-logistics.md` must move to another account or wait for the gaps in the
quest route. The food-chain accounts (Mightyrod, Bigpackage, Pocketrocket, mmtha0205, Pocketpython, mmthv2350) and
Haggis are not used.

## 2. What the partner needs (CODE-READ)

- Achietties starts Heroes' Quest only if `%qp >= 55`, Lost City, Dragon Slayer and Merlin's Crystal are complete,
  and one gang of Shield of Arrav is complete (`quests/quest_hero/scripts/quest_hero.rs2:1-7`,
  `areas/areas_heroes_guild/scripts/achietties.rs2:39-44`).
- Dragon Slayer needs 32 QP for the Champions' Guild door (`champions_guild.rs2:1-3`).
- Grip can be attacked only at `%heroquest >= 4` and `%phoenixgang >= 10`, which is Arrav complete
  (`quests/quest_hero/scripts/npcs/grip.rs2:59-65`). His death moves the killer from stage 4 to 5 only if the
  killer is at stage 4 exactly (`drop tables/scripts/grip.rs2:1-10`).

Combat the partner meets. Max hit = ((strength + 9) x (strength bonus + 64) + 320) / 640
(`research/quest-plan.md` section 1e):

| NPC | Quest | Stats (file) | Max hit | Under Protect from Melee |
|---|---|---|---|---|
| Tree spirit | Lost City | attack 90, strength 95, 85 HP, crush (`quest_zanaris/configs/tree_spirit.npc`) | 10 | 0 |
| Elvarg | Dragon Slayer | 70/70/70, 120 HP, slash (`quest_dragon/configs/quest_dragon.npc`) | 8 melee, dragonfire 10 with the anti-dragon shield (`quest-plan.md` 1i) | melee 0, fire 10 |
| Sir Mordred | Merlin's Crystal | 33/33/33, 38 HP, bonuses 20/16 (`keep_le_faye.npc`) | 5 | 0 |
| Grip | Heroes' stage 4 | 18/18/17, 25 HP, bonuses 5/7, slash (`quest_hero/configs/quest_hero.npc:127-158`) | 3 | 0 |
| Weaponsmaster | Arrav, Phoenix side | 21/21/21, 20 HP, bonuses 8/10 (`area_varrock/configs/varrock.npc`) | 3 | 0 |
| Count Draynor | Vampire Slayer | 30/30/25, 35 HP (`quest_vampire.npc`) | 3 | 0 |

The tree spirit spawns at 2860,9737 in the Entrana dungeon (`quest_zanaris.rs2:41`, coord `0_44_152_44_9`).
Entrana takes no weapon or armour (`monk_of_entrana.rs2`, `quest-plan.md` 1k). So the partner fights it with Fire
Bolt runes and no staff, or unarmed, under Protect from Melee.

Quest XP lumps give the partner its combat (levels from `curve.ts`):

| Quest | Reward | Level from 1 |
|---|---|---|
| Waterfall | 343,750 Attack, 343,750 Strength | 83, 83 |
| Witch's House | 158,125 Hitpoints | 72 |
| Tree Gnome Village | 286,250 Attack | Attack 92 after Waterfall |
| Dragon Slayer | 466,250 Strength, 466,250 Defence | Defence 88 |
| Imp Catcher | 21,875 Magic | 44 |
| Goblin Diplomacy | 5,000 Crafting | 25 |

Before Dragon Slayer the partner has Defence 1, so it cannot wear the rune armour of the Dragon Slayer proof. The
partner uses Protect from Melee in Melzar's maze and on Crandor instead.

## 3. Route to Heroes' Quest readiness

Ticks: MEASURED practice = best / worst of 3 proof runs from a preset beside the first NPC. The walk to that NPC is
not counted. ESTIMATE rows use the planner rows in `packages/planner/src/haggis-boards.json`.

Most proofs ran with every skill at 99 (`presets-short.ts`, `presets-medium.ts`, `presets-dragon.ts`). Waterfall
ran at 10 HP. Tree Gnome Village and The Grand Tree ran at combat 1, 10 HP, Magic 43, Prayer 43, which is the
partner's state. Column "Re-prove" marks the scripts that must run again at the partner's levels.

### Skill gates first

| Gate | Needed by | XP | Method and rate | Ticks |
|---|---|---|---|---|
| Prayer 60 | Protect from Melee (43) with 60 points, so 300 ticks of protection | 66,193 | bury dragon bones, 669.7 XP/tick (row `prayer-43`, rate MEASURED) | 99 (ESTIMATE from the rate) |
| Magic 45 | Fire Bolt (35), Camelot teleport (45) | 892 after Imp Catcher | teleports | about 10 (ESTIMATE) |
| Crafting 31 | dramen staff (`quest_zanaris.rs2:78`) | 2,952 after Goblin Diplomacy | cut gems (row `craft`, 1-99 in 194 ticks MEASURED) | about 10 (ESTIMATE) |
| Agility 25 | The Grand Tree (`quest_grandtree.rs2:25`) | 4,863 | gnome course, 33 XP/tick (row `agility-25`, MEASURED) | 148 |
| Fishing 10 | Fishing Contest (`hemenster_fishing.rs2:70`) | 980 | shrimp | about 30 (ESTIMATE) |
| Total | | | | **about 300** |

Prayer 43 is the minimum (11 bones, 30 ticks). Prayer 60 costs 69 ticks more and gives 17 more points for the
maze, Crandor and the tree spirit. The banker supplies the bones (37 for Prayer 60: row `prayer-43` gives 11 bones for 19,684 XP).

### Quests

| # | Quest | QP | Total QP | Gate | Script | Ticks best / worst | Evidence | Re-prove |
|---|---|---|---|---|---|---|---|---|
| 1 | Imp Catcher | 1 | 1 | none | `quest-imp.ts` | 38 / 38 | MEASURED | no |
| 2 | Rune Mysteries | 1 | 2 | none | `quest-runemysteries.ts` | 432 / 449 | MEASURED | no |
| 3 | The Restless Ghost | 1 | 3 | none | `quest-priest.ts` | 516 / 519 | MEASURED | yes (the skeleton) |
| 4 | Sheep Shearer | 1 | 4 | none | `quest-sheep.ts` | 70 / 70 | MEASURED | no |
| 5 | Cook's Assistant | 1 | 5 | none | none | 12 / 28 | ESTIMATE (row `cooks-assistant`) | script needed |
| 6 | Witch's Potion | 1 | 6 | none | `quest-hetty.ts` | 78 / 80 | MEASURED | no (one rat) |
| 7 | Doric's Quest | 1 | 7 | none | `quest-doric.ts` | 30 / 30 | MEASURED | no |
| 8 | Goblin Diplomacy | 5 | 12 | none | `quest-gobdip.ts` | 169 / 177 | MEASURED | no |
| 9 | Druidic Ritual | 4 | 16 | none | `quest-druid.ts` | 244 / 248 | MEASURED | no |
| 10 | Waterfall Quest | 1 | 17 | none | `waterfall.ts` | 1,030 / 1,037 | MEASURED at 10 HP | no |
| 11 | Witch's House | 4 | 21 | none | none | 300 / 900 | ESTIMATE (row `witch`) | script needed |
| 12 | Pirate's Treasure | 2 | 23 | none | `quest-hunt.ts` | 460 / 474 | MEASURED | yes (the gardener) |
| 13 | Vampire Slayer | 3 | 26 | none | `quest-vampire.ts` | 330 / 338 | MEASURED | yes (Count Draynor) |
| 14 | Romeo & Juliet | 5 | 31 | none | `quest-rj.ts` | 307 / 314 | MEASURED | no |
| 15 | Gertrude's Cat | 1 | 32 | none | `quest-fluffs.ts` | 369 / 397 | MEASURED | no |
| 16 | Shield of Arrav, Phoenix part | 0 now | 32 | none | `quest-arrav.ts` (helper role) | 371 / 400 | MEASURED | yes (weaponsmaster) |
| 17 | Monk's Friend | 1 | 33 | none | `quest-drunkmonk.ts` | 327 / 328 | MEASURED | no |
| 18 | Fishing Contest | 1 | 34 | Fishing 10 | `quest-fishingcompo.ts` | 415 / 415 | MEASURED | no |
| 19 | Tree Gnome Village | 2 | 36 | Prayer 43, Magic 35 | `quest-tree.ts` | 782 / 829 | MEASURED at the partner's state | no |
| 20 | The Grand Tree | 5 | 41 | Agility 25, Tree Gnome Village | `quest-grandtree.ts` | 2,001 / 2,083 | MEASURED at the partner's state | no |
| 21 | Merlin's Crystal | 6 | 47 | Prayer 43 | `quest-merlin.ts` | 868 / 897 | MEASURED | yes (Mordred, Wilderness altar) |
| 22 | Holy Grail | 2 | 49 | Merlin's Crystal, Attack 20 | `quest-grail.ts` | 1,451 / 1,479 | MEASURED | yes (Titan, HP) |
| 23 | Lost City | 3 | 52 | Woodcutting 36, Crafting 31 | none | 900 / 1,300 | ESTIMATE (medium class, `quest-points-board.md`) | script needed |
| 24 | Dragon Slayer | 2 | 54 | 32 QP, Prayer 43 | `quest-dragon.ts` | 1,488 / 1,577 | MEASURED | yes (no rune armour) |
| 25 | Shield of Arrav, certificate | 1 | **55** | Haggis's Arrav | the king (`king_roald.rs2:11-26`) | about 30 | ESTIMATE | - |

Totals:

| Part | Floor | Realistic | Evidence |
|---|---|---|---|
| 21 scripted quest parts (rows 1-4, 6-10, 12-22, 24) | 11,776 | 12,179 | MEASURED practice |
| 3 unscripted quests (rows 5, 11, 23) | 1,212 | 2,228 | ESTIMATE |
| Skill gates | about 300 | about 300 | ESTIMATE on MEASURED rates |
| Certificate claim | about 30 | about 30 | ESTIMATE |
| **Sum without travel** | **about 13,300** | **about 14,700** | |
| Travel between 24 starts | about 3,000 | about 4,500 | ESTIMATE (about 125-190 ticks per start) |
| **Sum with travel** | **about 16,000** | **about 19,000** | ESTIMATE |

Order notes:

- Waterfall comes before the first fight with real damage (Witch's House, Vampire Slayer, Pirate's Treasure). The
  Waterfall proof ran at 10 HP, with HP min 3-4 (`quest-plan.md` section 1).
- The Phoenix part of Arrav (row 16) stays in the pack until Haggis comes. The partner gives the 2 crossbows and
  the Phoenix half at the tramp. The partner finishes Arrav only after Haggis trades it the second certificate
  (`research/quest-points-board.md`, "Shield of Arrav as a pair").
- Dragon Slayer is last because it needs 32 QP. The partner has 49 QP after row 22, so Lost City can move
  before or after it.

Spares, if a quest on the route fails:

- Dwarf Cannon, 1 QP, 888 / 925 MEASURED (`dwarfcannon.ts`, row `cannon`, Magic 45 for the teleports).
- Ernest the Chicken 4, Sheep Herder 4, Prince Ali Rescue 3, Black Knights' Fortress 3 (12 QP gate). They have no
  script. Haggis needs them anyway (row `qp-filler`, 300 / 900 each, ESTIMATE). When they are scripted, they can
  replace The Grand Tree and Holy Grail (3,562 / 3,452 ticks for 7 QP) at a lower cost per QP.

## 4. Inside Heroes' Quest: what the partner does for Haggis

Stages from `quest_hero.constant`. Cites in `research/quest-plan.md` section 1l.

| Step | Partner (Phoenix) | `%heroquest` | Haggis (Black Arm) at the same time | Ticks (partner) |
|---|---|---|---|---|
| P0 | Claim the certificate from King Roald after Haggis's Arrav | - | Haggis's own route | about 30 |
| P1 | Achietties in the Heroes' Guild, Burthorpe | 1 | - | about 30 + walk |
| P2 | Straven in the Phoenix HQ, Varrock: the word "gherkin" (`straven.rs2:152-159`) | 2 | - | about 20 + walk |
| P3 | Travel to Brimhaven. Alfonse: "Do you sell Gherkins?" (`alfonse_the_waiter.rs2:4-19`) | 3 | - | about 400 |
| P4 | Kitchen door (2788,3189). Charlie: "I want to steal Scarface Pete's candlesticks." (`charlie_the_cook.rs2:22-25`) | 4 | - | about 30 |
| P5 | Panel (2787,3190). Wait in Mr Olbors' garden at the side door (2781,3197). Stay at stage 4. | 4 | H0-H3: Achietties, Katrine, Grubor, Trobert, black armour, Garv, Grip takes the papers (11), `misc_key` | 0 (log out while waiting) |
| P6 | Enter by the side door: Haggis uses `misc_key` on it, or trades the key (`brimhaven_scarface_mansion.rs2:45-50`) | 4 | opens the door | about 5 |
| P7 | Attack Grip (2774,3192) until he dies | 5 | waits beside him | about 10-20 |
| P8 | done (the armband from Straven is optional) | 5 | takes `grip_keys` from the floor, opens the treasure door, the chest | - |

All partner ticks in this table are ESTIMATE: about 700-900 ticks with the walks. They are not on Haggis's clock.
Only P6 and P7 are, about 15-25 ticks of waiting for Haggis.

Two rules from the code fix the order of P7:

1. Grip must be alive when Haggis gives the papers and asks for duties. So Grip dies only after Haggis has
   `misc_key`. If Grip dies too early, he respawns after 100 ticks (`respawnrate=100`).
2. The keys drop "for anyone" (`obj_addall`, `grip.rs2` drop script). Haggis picks them up inside the loot
   duration. The keys open the treasure door only at Haggis's stage 11 or more
   (`brimhaven_scarface_mansion.rs2:61-71`).

## 5. Timing against Haggis's run

Planner order (`bun packages/planner/src/haggis-cli.ts research/hiscores-live.json --levers --order`, 2026-10-23):
Holy Grail ends at tick 58,062. `quests-rest` runs 58,062-132,138 and holds Heroes' Quest and Lost City. The
`quest-arrav` pair runs 132,138-132,375.

- Haggis's own Heroes' start needs Arrav complete. So the planner order is wrong for Haggis as well as for the
  partner. Recommendation (no planner change made): put `quest-arrav` at the start of `quests-rest`, at about
  58,062.
- The partner does rows 1-15 and 17-24 before Haggis reaches Arrav. That is 16,000-19,000 partner ticks against
  58,062 Haggis ticks of slack. The partner can start at any time and runs on its own clock.
- At Haggis's Arrav, the partner has done the Phoenix part (row 16) and waits at the tramp. Haggis pays one trade
  (14 ticks, MEASURED). After Haggis's quest, Haggis trades the second certificate. The partner does P0-P5 while
  Haggis does other `quests-rest` quests and its own Lost City, so the partner waits at the side door before Haggis
  reaches H3.
- Fallback if Haggis's Arrav must stay late (CODE-READ, not run): the Phoenix chest gives a new half to any Phoenix
  member who has not finished and holds no half (`quest_blackarmgang.rs2:34-41`). The halves and crossbows are
  tradeable. So the partner can finish Arrav early with a throwaway Black Arm account, after it first fetches a
  second half and 2 crossbows and trades them to Haggis to keep in the bank.

## 6. Risks

1. **Lost City has no script.** It is mandatory for both accounts. Not read: the Entrana dungeon NPCs on the way to
   the tree, the Shamus tree and shed steps, and how the tree spirit takes Fire Bolt with no staff.
2. **Re-proofs at the partner's levels.** 7 scripts ran only with every skill at 99. Dragon Slayer ran in rune
   armour. The partner has Defence 1 and must keep the prayer on in the maze and on Crandor. 60 prayer points last
   300 ticks. The maze leg alone was 334 ticks in the proof, so the script needs prayer potions or a prayer
   restore stop.
3. **Elvarg's dragonfire is 10 with the shield.** The partner must have more than 10 HP before Crandor. Witch's
   House (HP 72) covers this. If Witch's House is not scripted, the partner needs combat XP for Hitpoints first.
4. **Witch's House and Cook's Assistant have no script.** Haggis needs both scripts anyway (rows `witch`,
   `cooks-assistant`).
5. **Merlin's Crystal goes into the Wilderness** to the chaos altar (3239,3608). On the live server, PKers can kill
   the partner there. The practice proofs had no other players.
6. **55 QP is exact.** If one quest fails, use a spare from section 3.
7. **Supplies.** About 12,000 coins for Dragon Slayer, the helper items of each preset, dragon bones, prayer
   potions, lobsters and teleport runes. They come from the banker (Moneyshot) before each block.
8. **Bigchopper's supply job** (`supply-logistics.md:158,170`) moves to another account or waits.
