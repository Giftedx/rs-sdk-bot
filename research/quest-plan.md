# Quest plan for the combat boards and Quest Points (2026-10-23)

Sources: `research/quest-xp.md` (XP per quest at 25x), `research/quest-route.md` (routes and OSRS requirements),
`knowledge/quests.json`, the rev 289 quest scripts under `vendor/rs-sdk/server/content/scripts/quests/`, and the
leader snapshot `research/hiscores-2026-10-22.json`. Evidence levels follow `research/INDEX.md`.

## 1. Measured: Waterfall Quest

Script `scripts/generated/waterfall.ts`, preset `quest_waterfall` (beside Almera, 10 HP, 2 ropes, 6 air, earth and
water runes, 18 lobsters, 500 coins). Practice server, 150 ms tick, one bot at a time.

3/3 PASS with the final script (MEASURED practice, 2026-10-23). The three proof runs are `g1`, `h1`, `h2`;
the script did not change between them. Run `g1` ran before a power cut, `h1` and `h2` after it.

| Run | RESULT line (cut) | Ticks | Attack XP | Strength XP | Eats | HP min |
|---|---|---|---|---|---|---|
| g1 | `RESULT ok attackXp=343750 strengthXp=343750 at=2603,9912,0 ticks=1160 hpMin=4 eats=7 lobsters=11 died=false milestones=1,2,3,4,5,6,8,10` | 1,160 | 343,750 | 343,750 | 7 | 4 |
| h1 | `RESULT ok attackXp=343750 strengthXp=343750 at=2603,9912,0 ticks=1164 hpMin=4 eats=7 lobsters=11 died=false milestones=1,2,3,4,5,6,8,10` | 1,164 | 343,750 | 343,750 | 7 | 4 |
| h2 | `RESULT ok attackXp=343750 strengthXp=343750 at=2603,9912,0 ticks=1160 hpMin=2 eats=12 lobsters=6 died=false milestones=1,2,3,4,5,6,8,10` | 1,160 | 343,750 | 343,750 | 12 | 2 |

Every run ends with `Congratulations! Quest complete!`; the quest gives 1 QP (`quest.constant`
`^waterfall_questpoints = 1`, CODE-READ; the QP varp is not in the SDK state, so not read in the run).
XP per tick of quest time: 687,500 / 1,161 = **592 combat XP per tick** (296 Attack + 296 Strength). The Attack #1
averaged 998,458 / 4,728 = 211 Attack XP per tick; the Strength #1, 998,458 / 4,966 = 201. Waterfall alone gives
34% of each 99 in 1,161 ticks, 25% of the Attack leader's time.

Earlier, 0/3 in 3 author attempts and 8 deaths (`research/run-learnings-2026-10-23.md:97-103`). Before the final
proof: 1 FAIL with the door fix but 10 lobsters and `bot.walkTo` in the falls
(`RESULT fail died during walk 2564,9880 ... eats=10 lobsters=0`); 2 PASS from the `quest_waterfall_falls` preset
(135 and 140 ticks from the crate).

Run h2 had HP 2. The low point is not traced (no `WF_TRACE` in proof runs). 6 lobsters were left, so food was not
the limit; one more spider hit at that tick could kill. This is the main risk left.

### Cut 1: click-ahead walking, one-tick rune drops, a combat shield (MEASURED practice, 3/3)

Changes in `waterfall.ts`: every overland and maze walk uses `walkPath` (`packages/core/src/walk.ts`) before the old
`bot.walkTo` fallback; the three rune stacks drop in one tick and come back one pickup per tick; the bot waits up to
12 ticks at the giant-room door for a spider or rat hit before it runs, so that single-way combat covers the run;
low-HP points print as `WARN hp`.

| Run | RESULT line (cut) | Ticks | LEDGER idle | walkPath ticks |
|---|---|---|---|---|
| m1 | `RESULT ok attackXp=343750 strengthXp=343750 at=2603,9912,0 ticks=1030 hpMin=3 eats=10 lobsters=8 died=false` | 1,030 | 213 (20.6%) | 611 |
| m2 | `RESULT ok attackXp=343750 strengthXp=343750 at=2603,9912,0 ticks=1037 hpMin=4 eats=9 lobsters=9 died=false` | 1,037 | 223 (21.4%) | 604 |
| m3 | `RESULT ok attackXp=343750 strengthXp=343750 at=2603,9912,0 ticks=1031 hpMin=4 eats=8 lobsters=10 died=false` | 1,031 | 216 (20.8%) | 609 |

Before: 1,160, 1,164, 1,160. After: 1,030, 1,037, 1,031, so 129 ticks (11%) faster. 343,750 Attack + 343,750
Strength in 1,033 ticks = **666 combat XP per tick**. The rival's 979 (UNVERIFIED) is now 54 ticks ahead.

The cut by segment (m1 against h1): Hadley to the gnome cellar fell from 270 to 236 ticks (h1 126-396, m1 113-349), the maze out and the walk to the tombstone from 302 to 241
(h1 522-824, m1 454-695), the tombstone idle from 15 + 14 to 11 + 9 ticks.

Low-HP points, traced (`WARN hp`): HP 3 at 2585,9878 in the south falls room (shadow spider in combat, two
skeleton mages and a skeleton beside it); HP 4 twice in Glarial's tomb next to a moss giant in combat (2545,9841 and
2542,9816). One run before the shield (k1) had HP 3 at 2565,9887 inside the giant room with a fire giant in combat:
a giant hit for 7. In m1 and m2 the shield hit came at once (`shield=true waited=0`); in m3 no spider came and the
bot waited the full 12 ticks (`shield=false waited=12`, 14 idle ticks at 2564,9881). The run of h2 that fell to HP 2
was not traced; it ran before the `WARN hp` line existed.

Still open for the rival's time: the 12-tick shield wait when no spider comes (cap it lower or lure one), the
tombstone idle (20 ticks), the chest in the tomb (up to 20 idle at 2555,9844 in m2), and the Hudon dialogue (7 idle).

### Where the ticks go, against the rival's 979

`research/rival-atlas-2026-10-16.md:28` gives a live Waterfall leg of 979 ticks (UNVERIFIED third-party). Ours is
1,160-1,164 from a preset start, so we are about 181 ticks slower. Run h1, by milestone and position jump:

| Segment | Ticks (h1) | Note |
|---|---|---|
| Almera, raft, Hudon, ropes, barrel, Hadley's book | 0-126 | Hudon line never seen (WARN in every run), 7 idle ticks on the island |
| Walk to the gnome village and the maze | 126-396 | 270 ticks of walking, the largest segment |
| Gnome cellar: crate, gate, Golrie, gate | 396-522 | 126 |
| Maze out and walk to Glarial's tombstone, drop runes | 522-824 | 302 ticks; 15 idle at the tombstone (rune drop) |
| Tomb: chest, coffin, ladder | 824-914 | 90; 8 idle at the chest |
| Pick up runes, raft, ropes, ledge door | 914-1029 | 115; 14 idle at the tombstone (rune pickup) |
| Falls: crate, double door, giant door, pillars, statue, chalice | 1029-1164 | 135; 59 of them on the 6 pillars |

Idle is 236-251 ticks per run (LEDGER `idlePct=20.0-21.5`). The cuts to try, in order of size: (1) the two
gnome-village walks (572 ticks): check the route against the shortest path and the maze waypoints; (2) the rune
drop and pickup at the tombstone (about 29 idle ticks): have a helper hand over the runes after the tomb, or
drop and pick up with direct ops in one tick each; (3) the pillars (59 ticks for 18 rune uses): send the next use
on the tick after the rune lands; (4) the Hudon dialogue wait.

### Cause of the 8 deaths at the giant door

The earlier runs did not die to one big hit. They died because the bot could not reach the giant door at all.

1. A closed double door (loc 1516 and 1519, "Large door", at 2564,9881 and 2565,9881; `maps/m40_154.jm2`, LOC
   lines `0 4 25` and `0 5 25`) shuts the fire giant room from the south room. CODE-READ.
2. The SDK collision data masks every door (`Pathfinding initialized ... 2691 doors masked`), so `bot.walkTo` and
   `research/route-danger.ts` plan a path through it. The client route (`webclient/src/lite/movement.ts`) does not
   pass a closed door. So a key use on the giant door from the south room had no route. The server answered
   `I can't reach that!` (`engine/src/engine/entity/Player.ts:1351`), and a walk click came back
   `client_rejected`. MEASURED practice (4 of 4 key uses, every walk click from 2569,9876).
3. The bot then stood in the south room. Shadow spiders and skeletons hit it for 1-5 each 4 ticks until the 10
   lobsters ran out (`RESULT fail died during giant door ... eats=10 lobsters=0`). MEASURED practice.
4. The fire giants (max hit 11, `all.npc` firegiant strength 65) were never the first cause. In the test runs a
   shadow spider from the south room followed the bot into the giant room and kept it in combat. In single-way
   combat a second NPC cannot attack a player that another NPC attacked in the last 8 ticks
   (`npc_check_notcombat`, `scripts/.../npc_combat.rs2:382-391`). In the one traced crossing (`WF_TRACE=1`) no giant
   attacked; the spider was the attacker. MEASURED practice (1 traced run; the shield is not proven) + CODE-READ.

Fix in `waterfall.ts`: open the double door from its south tile (2564,9880), run with client-routed walk clicks to
the giant door's own tile (2568,9893), and use the key there. That tile and 2568,9892 are a 1-wide corridor, which a
size-2 fire giant cannot enter. The falls legs use client walk clicks (`dash`), because `bot.walkTo` stalled 26
ticks at 2581,9875 among the spiders. A run that starts inside the falls resumes at step 6 (preset
`quest_waterfall_falls`), so the crossing can be tested alone.

## 2. Combat boards: what quests give and what the leaders need

Leaders (`research/hiscores-2026-10-22.json`): Attack 4,728 ticks, Strength 4,966, Defence 7,974, Ranged 5,595,
Agility 6,772, Hitpoints 17,058, Quest Points 141 QP at 921,761. Level 99 = 998,458 XP.

To beat Attack, an account must average 998,458 / 4,728 = 211 Attack XP per tick from its first tick. Strength
needs 201 per tick, Defence 125.

| Board | Quest set that reaches 99 | XP (25x, CODE-READ) | Estimated quest ticks | Leader |
|---|---|---|---|---|
| Attack | Waterfall 343,750 + Tree Gnome Village 286,250 + Fight Arena 304,375 + Vampire Slayer 120,625 | 1,055,000 | 1,161 (MEASURED practice) + 1,200 + 1,300 + 500, plus about 900 travel = about 5,060 (ESTIMATE), 7% over 4,728 | 4,728 |
| Strength | Waterfall 343,750 + Dragon Slayer 466,250 + Scorpion Catcher 165,625 + 22,833 from combat | 998,458 | Dragon Slayer needs 32 QP first (`dragon_journal.rs2:7`, `%qp < 32` gate): about 9 short quests ahead of it | 4,966 |
| Defence | Dragon Slayer 466,250 + Holy Grail 382,500 + Hero's 76,875 + Viking 70,310 + 2,523 from combat | 998,458 | Holy Grail needs Merlin's Crystal; Hero's needs a long chain | 7,974 |
| Hitpoints | Witch's House 158,125 + Hero's 76,875 + Viking 70,310 + Druid Spirit 50,000 (to level 85), then combat | 392,185 from quests | combat gives 1.33 HP XP per damage | 17,058 |
| Agility | Regicide 343,750 + Grand Tree 197,500 + Underground Pass 75,000 + Viking 70,310 (to 93) | 686,560 | Regicide needs Underground Pass and Agility 56 | 6,772 |

Fight Arena XP: `quest_arena.rs2:270-271` (`stat_advance(attack, 121750)` = 12,175 x 25 = 304,375 Attack, and
54,375 Thieving). `knowledge/quests.json` has no XP row for Fight Arena or Waterfall (their `stat_advance` lines
are not in the miner's output), so `research/quest-xp.md` undercounts Attack by 648,125.

Result: only Attack is near reach from quests alone. The four Attack quests take about 5,060 ticks at our speed
(ESTIMATE, 7% over 4,728) and about 4,300 at the rival's leg times (979 + 938 + our 1,300 + 500 + 600 travel,
ESTIMATE). So Attack needs the quests at the start of the clock and the Waterfall cuts listed in section 1. Strength and Defence need Dragon Slayer, which needs 32 QP; 32 QP of short
quests takes about 6,000-9,000 ticks (ESTIMATE), so those quests land after the 4,966 and 7,974 deadlines.
Strength and Defence are then a combat-training question, not a quest question. Quests still give them a large
lump that shortens the combat training.

## 3. Quest order for Haggis

The order maximizes board progress per tick. The combat-quest block runs first, because Attack (4,728) and
Strength (4,966) are among the earliest deadlines on the one clock. QP comes for free on the way: every quest adds
QP, and the QP deadline (921,761) is far away.

| # | Quest | Requirements (rev 289 gate, else OSRS guide) | Helper supplies | Reward at 25x | Ticks | Danger |
|---|---|---|---|---|---|---|
| 1 | Waterfall Quest | none | 2 ropes, 6 air + 6 earth + 6 water runes, 18 lobsters | 343,750 Attack, 343,750 Strength, 1 QP | 1,160-1,164 MEASURED practice, 3 runs (preset start at Almera; travel from Lumbridge not counted); rival live 979 UNVERIFIED | south falls room: shadow spiders, skeletons (chip damage); fire giants (max 11) if no spider shield; Glarial's tomb skeletons (one earlier run died at the tomb ladder) |
| 2 | Tree Gnome Village | none (OSRS) | 6 normal logs (Commander Montai), food | 286,250 Attack, 2 QP | 1,200 ESTIMATE; rival live 938 UNVERIFIED (maze, 3 trackers, ballista, fortress) | Khazard warlord (level 112) fight for the orb; Khazard troopers in the fortress |
| 3 | Fight Arena | none (OSRS) | Khazard armour is in the quest; food, a weapon | 304,375 Attack, 54,375 Thieving, 2 QP | 1,300 ESTIMATE | four arena fights: Khazard ogre (63), scorpion (44), Bouncer (137), General Khazard (112); needs HP above 10 or a safespot |
| 4 | Vampire Slayer | none | garlic, hammer, beer (Dr Harlow), food | 120,625 Attack, 3 QP | 500 ESTIMATE | Count Draynor (34) |
| 5 | Witch's House | none | cheese, leather gloves, food | 158,125 Hitpoints, 4 QP | 600 ESTIMATE | the experiment (4 forms) |
| 6 | 8 short quests to 32 QP: Romeo & Juliet 5, Goblin Diplomacy 5, Druidic Ritual 4, Sheep Herder 4, Black Knights' Fortress 3, Prince Ali Rescue 3, Ernest the Chicken 4, plus 4 from the quests above | none | quest items (dyes, rat meat and others), coins | 32 QP total | 300-900 each ESTIMATE (`haggis-boards.json` row) | Black Knights' Fortress guards; Ernest: none |
| 7 | Dragon Slayer | 32 QP (`%qp < 32`, CODE-READ) | anti-dragon shield (Duke Horacio), 3 map pieces, 3 planks, 90 steel nails, hammer, unfired bowl, wizard's mind bomb, lobster pot, silk, 10,000 coins for the boat | 466,250 Strength, 466,250 Defence, 2 QP | 4,000 ESTIMATE | Elvarg (83) dragonfire, Melzar's maze (lesser demon 82, zombies, ghosts), Crandor skeletons |
| 8 | Scorpion Catcher | Prayer 31 (OSRS) | scorpion cage, food | 165,625 Strength, 1 QP | 1,500 ESTIMATE | Taverley dungeon: poison spiders, black knights |
| 9 | The Grand Tree | Agility 25 (`stat(agility) < 25` gate, CODE-READ) | food | 460,000 Attack, 197,500 Agility, 53,750 Magic, 5 QP | 2,500 ESTIMATE | Black demon (172) in the mine: needs protect from melee (Prayer 43) or a safespot |
| 10 | Merlin's Crystal, Holy Grail | Holy Grail: Merlin's Crystal, Attack 20 (OSRS) | bat bones, black candle, insect repellent, bread | 382,500 Defence, 275,000 Prayer, 8 QP | 4,000 ESTIMATE together | Sir Mordred (39), Black Knight Titan (120, needs Excalibur) |
| 11 | Dwarf Cannon | none | cannon parts in the quest | 18,750 Crafting, 1 QP; unlocks the cannon for Ranged | not measured | goblins (low) |
| 12 | The rest, about 50 quests | see `research/quest-route.md` | per quest | to 145 QP | about 60,000 ESTIMATE | per quest |

## 4. Quest Points: a dedicated account

Rule (CODE-READ): the board ranks by points, then by playtime ascending (`engine/src/web/pages/RankedHiscoresWorker.ts:19`).
The playtime is stamped only when the QP total changes, at the save after the quest
(`engine/src/server/login/LoginServer.ts:200-216`), not at the quest-complete tick. Content has 68 quests and 145 QP
(sum of `scripts/general/configs/quest.constant:72-139`).

Leader: `avery` had 141 QP at 921,761 ticks in `research/hiscores-2026-10-22.json`. Live at 06:37Z on 2026-10-23
`avery` has **145 QP at 1,022,262 ticks** (`research/boards-special.md:19,25`, MEASURED live). 145 is the maximum.

- The only win is 145 QP saved at a playtime of 1,022,261 ticks or less. More points is not possible.
- While a leader is below 145, 142+ QP is rank 1 only until the leader gains a point (status HOLD in
  `packages/planner/src/haggis.ts`, rule `kind: 'qp'`, `MAX_QP = 145`). A secure win is 145 before the leader's
  playtime stamp.
- Log out (or wait for the autosave) right after the last quest, so the stamp is the finish tick.

A dedicated QP account quests from its first tick. Estimate: 68 quests at a mean of 1,200 ticks = 81,600 ticks,
plus about 15,000 ticks of skill training for the quest gates (Legends' Quest, Regicide, Underground Pass, Eadgar's
Ruse, Haunted Mine). It reaches 142 QP at about 85,000 ticks and 145 QP at about 97,000 ticks (ESTIMATE). The 1,200
mean is 1.0x the one measured quest (Waterfall, about 1,160 ticks from a preset), so the estimate is weak. Even at
5x that mean (about 485,000 ticks) it stays under 1,022,261. Haggis can also take the board: the schedule model
reaches 142 QP at 56,263 (floor) and 116,214 (realistic) ticks (`bun packages/planner/src/haggis-cli.ts`,
2026-10-23), and the last 3 QP need the quests that are not in the model yet. The model still reads the 141-QP
snapshot; with the live 145 leader, the board is WIN only when all 145 land before 1,022,262.

## 5. Next quests to automate (top 5 by XP per tick)

XP per tick = combat-board XP / estimated ticks. Waterfall, measured, is the reference.

| Rank | Quest | Board XP | Ticks | XP per tick | Why next |
|---|---|---|---|---|---|
| ref | Waterfall | 687,500 | 1,161 MEASURED practice | 592 | done |
| 1 | The Grand Tree | 711,250 (Attack, Agility, Magic) | 2,500 ESTIMATE (rival live 1,811 UNVERIFIED: 393 per tick) | 285 | feeds three boards; black demon is the risk |
| 2 | Fight Arena | 304,375 Attack (+54,375 Thieving) | 1,300 ESTIMATE | 234 (276 with Thieving) | third Attack quest |
| 3 | Witch's House | 158,125 Hitpoints | 600 ESTIMATE | 264 | first Hitpoints lump; no requirement |
| 4 | Tree Gnome Village | 286,250 Attack | 1,200 ESTIMATE | 239 | second Attack quest; needed before Grand Tree in `haggis-boards.json` |
| 5 | Vampire Slayer | 120,625 Attack | 500 ESTIMATE | 241 | closes Attack 99 with the three above |

Dragon Slayer (932,500 at about 4,000 ticks = 233 per tick) is the next after these, but it needs 32 QP first.

## Open

- Quest ticks other than Waterfall are not measured (ESTIMATE). The 8 short quests, Witch's House and Dwarf Cannon
  have no script yet.
- Waterfall ticks are from a preset at Almera. The walk from Lumbridge to Almera and the helper trade are not in
  the count.
- OSRS requirements (Prayer 31 for Scorpion Catcher, Attack 20 for Holy Grail, Crafting 35 for Haunted Mine) are
  not checked in the rev 289 scripts; the gate grep found only the Grand Tree, Watchtower, Viking and Dragon
  Slayer gates.
- `research/quest-route.md` says the Grand Tree needs Tree Gnome Village. The rev 289 Grand Tree script gates only
  Agility 25 (CODE-READ grep). Not verified in a run.
