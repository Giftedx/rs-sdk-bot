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

## 1b. Measured: Dwarf Cannon

Script `scripts/generated/dwarfcannon.ts`, preset `quest_dwarfcannon`. The preset starts beside the Dwarf Commander
(spawn 2571,3463, `maps/m40_54.jm2`) with Haggis's levels right after Waterfall in the planner order: Attack and
Strength 99, Defence 89, Hitpoints 97, Ranged 1, and Crafting, Smithing and Magic 99. The pack holds 8 lobsters,
500 coins, 2 law, 8 air and 1 water rune. Practice server, 150 ms tick, one bot at a time.

3/3 PASS (MEASURED practice, 2026-10-23):

| Run | RESULT line (cut) | Ticks | LEDGER idle | Railing tries / fails | HP min |
|---|---|---|---|---|---|
| p1 | `RESULT ok craftingXp=18870 xp=magic=2587,crafting=18870 at=2570,3463,0 ticks=897 hpMin=86 eats=0 railTries=10 railFails=4 inspectFails=0 repairFails=0 walkTicks=432 died=false` | 897 | 219 (24.3%) | 10 / 4 | 86 |
| p2 | `RESULT ok craftingXp=18870 xp=magic=2587,crafting=18870 at=2569,3464,0 ticks=925 hpMin=80 eats=0 railTries=12 railFails=6 inspectFails=0 repairFails=0 walkTicks=433 died=false` | 925 | 241 (26.0%) | 12 / 6 | 80 |
| p3 | `RESULT ok craftingXp=18870 xp=magic=2587,crafting=18870 at=2572,3461,0 ticks=888 hpMin=89 eats=0 railTries=9 railFails=3 inspectFails=0 repairFails=0 walkTicks=431 died=false` | 888 | 211 (23.7%) | 9 / 3 | 89 |

Every run ends with `Congratulations! Quest complete!`. XP per run: 18,870 Crafting (18,750 from the reward,
`quest_mcannon.rs2:24-26`, plus 30 for each of the 4 parts) and 2,587 Magic from the two teleports. No other skill
gains XP. Hitpoints never fell below 80 of 97, and the bot ate nothing.

Steps and ticks (run p3, MILESTONE lines):

| Step | Ticks | Note |
|---|---|---|
| Commander, take 6 railings | 0-24 | 11 dialogue pages, 2 ticks each |
| Fix 6 railings | 24-175 | about 12 ticks per try; 151-187 ticks over the 3 runs |
| Commander, watch tower, remains, commander | 175-278 | the fence gate (loc 1557/1558 at 2567-2568,3458) needs walkPath |
| Goblin cave, crate, free the child | 278-385 | 107 tiles to the cave, 69 tiles inside |
| Mud pile, walk back, take the tool kit | 385-504 | 109 tiles |
| Shed door, inspect, 4 repairs, inspect | 504-580 | 15 ticks per part |
| Commander, Falador teleport, Nulodion | 580-725 | 154 tiles from Falador |
| Camelot teleport, walk back, commander | 725-888 | 265 tiles from Camelot |

Random parts and how the script handles them:

1. A railing fix rolls `stat_random(crafting, 60, 150)`: 151/256 at Crafting 99 (`railings.rs2:78`). A fail
   cuts for `stat_base(hitpoints) / 10`, at most 3. The script tries again at once. The fails decide the spread.
2. An inspect and a repair roll `stat_random(smithing, 80, 300) | stat_random(crafting, 80, 350)`
   (`mcannon_broken_cannon.rs2:90-96`). At Smithing or Crafting 99 the roll cannot fail. The script still retries
   both, so it also works at low levels (not run below 99).
3. A click sent on the tick after "manage to fix it" or a railing success lands inside `p_delay(2)`. The server
   drops it. The script sends it again every 2 ticks. Before this fix, each part cost 16 more idle ticks.

Findings from the failed attempts:

- A loc click cannot pass the fence gate or the shed door: the client answers `I can't reach that!`. SDK collision
  treats doors as open, so `walkPath` opens them first.
- The NPC list reaches about 15 tiles. From the far railing the commander was not in it, so `talk` walks toward his
  spawn first.
- The child must finish his last page. `%mcannon = 5` comes after `The dwarf child runs off into the caverns.` A
  walk click on an earlier page cancels it (`dwarfchildtw1.rs2:13-16`).
- Teleports cut the Nulodion trip from 741 + 741 tiles to 154 + 265 tiles (`findLongPath`), about 530 ticks saved.
  They need Magic 45, 2 law, 8 air and 1 water rune.

Still open: a dialogue burst. The lite client sends one continue per page (`webclient/src/lite/actions.ts:466-476`,
`resumedPauseButton`), so 190 of the 888 ticks are dialogue. A raw `RESUME_PAUSEBUTTON` sender could cut about half.
The walk from the Waterfall end to the commander is not counted.

### Cannon session after the quest (MEASURED practice)

Preset `quest_dwarfcannon_gb`: the same levels at the Gnome battlefield (multiway, `maps/multiway.csv`, 23
`khazard_troop` and 16 `khazard_troop_spearmen`), `%mcannon` = 11, cannon parts, 1,000 cannonballs. The bot melees
Khazard troopers with the rune scimitar (aggressive style). Each run is 300 ticks after a 14-tick setup.

With `scripts/measure/combat-melee.ts` as it is (`CANNON=1 TARGET='^khazard trooper$'`):

| Run | Ranged XP/tick | Style XP/tick | HP XP/tick | Balls used |
|---|---|---|---|---|
| c1 | 40.7 | 97.7 | 32.3 | 30 |
| c2 | 49.7 | 117.7 | 39.0 | 30 |
| c3 | 105.5 | 66.3 | 21.9 | 60 |

A traced run showed the cause. The cannon fired 30 balls in about 70 ticks, then stood empty. The 20-tick top-up
never landed: the attack click on the next tick replaces the walk to the cannon. After an empty cannon the reload
also failed when the Fire click came on the next tick. In that run the cannon gave 0 XP from tick 162 to 300.

With the handling fixed (a scratch copy of the same script: no attack click until `You load the cannon` or 8 ticks,
Fire after the load lands, top-up every 30 ticks):

| Run | Ranged XP/tick | Style XP/tick | HP XP/tick | Balls used | Balls per 1,000 Ranged XP |
|---|---|---|---|---|---|
| g1 | 208.2 | 84.0 | 27.8 | 128 | 2.05 |
| g2 | 215.7 | 86.0 | 28.4 | 166 | 2.57 |
| g3 | 199.2 | 105.0 | 34.8 | 131 | 2.19 |

Example line (g1): `RESULT ok cannon=true ticks=300 styleXp=25200 styleXpPerTick=84.0 hpXp=8332 hpXpPerTick=27.8
rangedXp=62450 rangedXpPerTick=208.2 ... reloads=9 refires=0 setupTicks=14 balls=872 hp=94/97 lv=99/99/89/97/59`.

Mean: 207.7 Ranged, 91.7 style and 30.3 Hitpoints XP per tick, 2.27 balls per 1,000 Ranged XP. Ranged 99 needs
about 2,270 balls (11,300 coins at the obj cost of 5). The cannon gives no Hitpoints XP, so the Hitpoints XP is
from melee only. Ranged went from 1 to 58-59 in each run. Per `research/combat-measure.md`, the cannon hit roll uses the melee
attack roll, so the Ranged level does not change the rate (CODE-READ there, not checked here).

The fix belongs in `scripts/measure/combat-melee.ts` (not changed here). With it, the `cannon-melee` lever patches
in the melee rows would read about +2.3 Ranged per style XP, not 0.585.

Planner (`packages/planner/src/haggis-boards.json`): row `cannon` is now 888 / 925 ticks MEASURED, needs Magic 45,
and has no burst patch. Row `ranged` is now "Cannon + melee to Ranged 99" at 215.7 / 207.7 MEASURED, side XP 0.441
Defence (defensive style, CODE-READ) and 0.146 Hitpoints per Ranged XP. Scenario a, `research/hiscores-live.json`,
2026-10-23:

| Board | Before (floor / realistic) | After (floor / realistic) |
|---|---|---|
| Ranged (#1 5,595) | 29,682 / 37,793 | 33,257 / 40,197 |
| Hitpoints (#1 17,058) | 29,039 / 36,828 | 32,518 / 39,429 |
| Overall (#1 35,916) | 38,306 / 47,340 | 37,995 / 45,473 |

Ranged is later because the old row assumed 600 / 400 XP per tick with a bow (ESTIMATE). Overall is earlier because
the cannon session now feeds Defence. A bow plus the cannon is not measured and could be faster.

## 1c. Short quests (the `qp-filler` row)

The schedule (`bun packages/planner/src/haggis-cli.ts research/hiscores-live.json --levers --order`, 2026-10-23,
scenario a) has one ESTIMATE row for the short quests: activity 39, "Short quests to 32 QP", 6,659 ticks
realistic for 7 quests (Romeo & Juliet, Goblin Diplomacy, Druidic Ritual, Ernest, Sheep Herder, Black Knights'
Fortress, Prince Ali), about 951 each, and a separate Witch's House row of 832. Order of work: planned ticks, then
board XP rewards: Druidic Ritual (Herblore), Goblin Diplomacy (Crafting), then the five with no XP, then Witch's
House (Hitpoints, 832 planned).

Shared parts: `scripts/generated/quest-lib.ts` (the dwarfcannon.ts helpers: walkPath first, re-sent clicks, one
dialog page per tick, MILESTONE and WARN lines, death check, `blockDoor` for a locked door that the SDK routes
through). Presets `quest_*` in `packages/practice/src/presets.ts`: Haggis at the `qp-filler` row, every skill 99
(Defence 99 lands at 45,540, the row starts at 46,584), the rune set worn, 22 QP in varp 101, 10 lobsters, and the
helper items. Each run starts beside the quest's first NPC; the walk to it is the planner's travel leg.

At these levels the quest XP is wasted: Herblore and Crafting are 99 already. Only the QP count.

### Druidic Ritual (MEASURED practice, 3/3)

Script `scripts/generated/quest-druid.ts`, preset `quest_druid` (beside Kaqemeex, 4 raw meats from a helper:
beef 2132, rat 2134, bear 2136, chicken 2138; the enchanted meats are untradeable). Practice server, one bot.

| Run | RESULT line (cut) | Ticks | LEDGER idle |
|---|---|---|---|
| p1 | `RESULT ok herbloreXp=6250 xp=herblore=6250 at=2924,3485,0 ticks=244 hpMin=99 eats=0 walkTicks=152 retries=0 died=false` | 244 | 27 (10.9%) |
| p2 | `RESULT ok herbloreXp=6250 xp=herblore=6250 at=2924,3485,0 ticks=248 hpMin=99 eats=0 walkTicks=154 retries=0 died=false` | 248 | 29 (11.6%) |
| p3 | `RESULT ok herbloreXp=6250 xp=herblore=6250 at=2924,3485,0 ticks=244 hpMin=99 eats=0 walkTicks=152 retries=0 died=false` | 244 | 27 (10.9%) |

Every run ends with `Congratulations! Quest complete!`. 6,250 Herblore XP (`quest_druid.rs2:3`
`stat_advance(herblore, 2500)`), 4 QP (`druid_questpoints`, CODE-READ; the QP varp is not in the SDK state). No
damage (HP min 99), 0 deaths, 0 eats. Planned: about 951 (ESTIMATE share); measured 244-248. The rival's lab
figure is 208 fixed (UNVERIFIED, `docs/speedrun/quests/druidic_ritual.md`).

Steps (run p1, MILESTONE ticks): Kaqemeex 0-24; walk, stairs, Sanfew 24-85; stairs, ladder 85-109; prison door
109-130; 4 dips 130-140; door, ladder, stairs, Sanfew 140-197; walk back, Kaqemeex 197-244.

Findings:

- The SDK route from the stone circle to Sanfew runs through the Witch's House front door (`witchhousedoor` 2861 at
  2901,3473), which is locked: up to 211 idle ticks of "The door is locked." in each of the first two tries. The script blocks that
  door for the session (`blockDoor`), so the plan goes round.
- The prison door (`prison_doors.rs2`): from the west the first two opens wake the two suits of armour, the third
  lets the player through. "Inside" is x >= 2889, the door's own tile column. The suits never hit at Defence 99.
- `getDialog().text` was empty on Sanfew's pages, so the hand-in is checked on the inventory (no enchanted meat).
- Kaqemeex queues a 14-page Herblore lesson after the reward; the script closes it.
- Rev 289 has no Druidic Ritual gate on Herblore (`skill_herblore/scripts/identifying/identify.rs2:65`), so the
  planner row `druid` serves Quest Points only. With `serves: herblore` the scheduler pulled the Taverley trip to
  tick 856 for the Herblore deadline, and Overall got later (45,540 to 46,094 realistic).

Planner: new row `druid` (244 / 248 MEASURED, 4 QP, place `kaqemeex`); `qp-filler` loses Druidic Ritual, 4 QP and
one equal share of each ESTIMATE. Overall (scenario a): 38,191 / 45,540 before, 38,235 / 45,443 after (floor /
realistic). Still open in that row: its `rival-dialogue-burst` patch (8 quests x 0.9248) overrides the
`combat-hp-bound` patch (Witch's House split out), so with both levers on the row still counts Witch's House.

### Goblin Diplomacy (MEASURED practice, 3/3)

Script `scripts/generated/quest-gobdip.ts`, preset `quest_gobdip` (beside the Rusty Anchor bartender, Port Sarim;
3 goblin mail 288, orange dye 1769, blue dye 1767, and 1 law, 3 air, 1 water for a Falador teleport, all from a
helper; the dyed mails are untradeable). Route: bartender, both dyes, Falador teleport, run north to General
Wartface (2957,3511), the hut's double door, four talks with him.

Proof with the final script (runs q1-q3):

| Run | RESULT line (cut) | Ticks | LEDGER idle |
|---|---|---|---|
| q1 | `RESULT ok craftingXp=5000 xp=magic=1200,crafting=5000 at=2956,3511,0 ticks=174 hpMin=99 eats=0 walkTicks=70 retries=0 died=false` | 174 | 22 (12.4%) |
| q2 | `RESULT ok craftingXp=5000 xp=magic=1200,crafting=5000 at=2958,3511,0 ticks=169 hpMin=99 eats=0 walkTicks=67 retries=0 died=false` | 169 | 15 (8.7%) |
| q3 | `RESULT ok craftingXp=5000 xp=magic=1200,crafting=5000 at=2956,3511,0 ticks=177 hpMin=99 eats=0 walkTicks=72 retries=0 died=false` | 177 | 22 (12.2%) |

Every run ends with `Congratulations! Quest complete!`. 5,000 Crafting XP (`stat_advance(crafting, 2000)`), a gold
bar, 5 QP (CODE-READ), 1,200 Magic XP from the teleport. No damage, 0 deaths. Planned: about 951 (ESTIMATE share);
measured 169-177. The rival's figure is 51.7 ticks without travel (UNVERIFIED).

Steps (q1): bartender 0-13, dyes 13-17, teleport and run 17-97, Wartface 97-174 (4 talks of about 20 ticks; 80
dialogue ticks in the LEDGER). The dialogue is the largest part left; a burst sender would cut most of it.

The generals' hut has a shut double door in its south wall (loc 1516 at 2957,3509 and 1519 at 2958,3509,
`maps/m46_54.jm2`). The SDK plan treats it as open. Shut, the client cannot route a talk to Wartface, and the click
does nothing: `WARN talk wartface 1 no dialog: npc 2956,3511 d=2 me 2957,3509` in 3 of 3 tries, 4 failed runs in
all. The first proof (172, 167, 172 ticks, committed in 883641e) passed only because an earlier run had left the
door open. The script now opens both leaves by tile (`openDoor`).

Planner: row `gobdip` (169 / 177 MEASURED, 5 QP, places `rusty-anchor` to `goblin-village`, serves Quest Points
only).

### Romeo & Juliet (MEASURED practice, 3/3)

Script `scripts/generated/quest-rj.ts`, preset `quest_rj` (beside Romeo, Varrock Square, at 3211,3424; cadava
berries 753 and Varrock teleport runes from a helper). Juliet first: at stage 0 "I guess I could find him." gives
her message at once (`juliet.rs2`), so Romeo's opening talk is skipped. Then Romeo, Father Lawrence, the Apothecary
twice (berries asked, then the potion), Juliet, a Varrock teleport, Romeo.

| Run | RESULT line (cut) | Ticks | LEDGER idle |
|---|---|---|---|
| p1 | `RESULT ok qp=5 xp=magic=875 at=3210,3424,0 ticks=314 hpMin=99 eats=0 walkTicks=163 retries=0 died=false milestones=20,30,40,50,potion,60,100` | 314 | 27 (8.5%) |
| p2 | `RESULT ok qp=5 xp=magic=875 at=3213,3422,0 ticks=311 hpMin=99 eats=0 walkTicks=162 retries=0 died=false milestones=20,30,40,50,potion,60,100` | 311 | 28 (8.9%) |
| p3 | `RESULT ok qp=5 xp=magic=875 at=3213,3421,0 ticks=307 hpMin=99 eats=0 walkTicks=161 retries=0 died=false milestones=20,30,40,50,potion,60,100` | 307 | 21 (6.8%) |

Every run ends with `Congratulations! Quest complete!`. 5 QP (CODE-READ), no quest XP; 875 Magic XP from the
teleport. No damage, 0 deaths. Planned: about 951 (ESTIMATE share); measured 307-314. The rival's figure is 300
fixed without a teleport (UNVERIFIED).

Steps (p1, milestones): Juliet 0-68; Romeo 68-121; Father Lawrence 121-169; Apothecary twice 169-246; Juliet
246-295; teleport and Romeo 295-314. About 93 ticks are dialogue (LEDGER).

Findings:

- Juliet's house: the SDK plan finds no way into the stairs room (`PATHFINDING FAILED: no waypoints` to 3157,3434),
  and walkPath stood 224 ticks at 3162,3439. The doors (`loc_1533` / `loc_1530`) are opened by tile: the north door
  3160,3440, and upstairs 3156,3431 and 3159,3427. Then the stairs (3156,3435) are clicked from outside.
- The preset tile 3212,3427 is blocked in the SDK collision (the plan from it is empty), so the bot never moved; the
  preset starts at 3211,3424.
- `getDialog().text` is empty and `recentDialogs` held 1 page in a whole run, so `quest-lib.ts` now keeps each
  tick's page text (`text` plus `allComponents[].text`) for `sawText`. Druidic Ritual passed again with it (248
  ticks, 1 run).

Planner: new row `rj` (307 / 314 MEASURED, 5 QP, place `romeo`, Quest Points only). Overall with HEAD (b224452)
plus these rows, scenario a: 37,851 / 45,149, the same as HEAD alone. The short quests come after the last 99, so
they do not move Overall; they move Quest Points and the start of Dragon Slayer (51,262 realistic after these rows).

## 1d. Measured: Family Crest (the `crest` row)

Script `scripts/generated/quest-crest.ts`, preset `quest_crest` (beside Dimintheis, 3280,3403). The quest ends at
Avan with the goldsmith gauntlets that the superheat route needs. Practice server, one bot at a time.

3/3 PASS (MEASURED practice, 2026-10-23):

| Run | RESULT line (cut) | Ticks | LEDGER idle | HP min | Eats |
|---|---|---|---|---|---|
| ra | `RESULT ok qp=1 gauntlets=true questMsg=true xp=hitpoints=40,magic=14635,crafting=3625 at=3293,3282,0 ticks=1182 hpMin=53 eats=4 walkTicks=730 retries=2 died=false` | 1,182 | 124 (10.5%) | 53 | 4 |
| rb | `RESULT ok qp=1 gauntlets=true questMsg=true xp=attack=6400,hitpoints=2162,magic=11185,crafting=3625 at=3292,3282,0 ticks=1179 hpMin=71 eats=0 walkTicks=728 retries=2 died=false` | 1,179 | 123 (10.4%) | 71 | 0 |
| rc | `RESULT ok qp=1 gauntlets=true questMsg=true xp=attack=6400,hitpoints=2155,magic=13767,crafting=3625 at=3295,3282,0 ticks=1199 hpMin=59 eats=3 walkTicks=727 retries=2 died=false` | 1,199 | 135 (11.2%) | 59 | 3 |

Every run ends with `Congratulations! Quest complete!` and the goldsmith gauntlets (776) in the pack. 1 QP
(CODE-READ, `quest_crest.rs2` crest_complete). The quest gives no XP; the XP above is from the blasts (Magic), the
jewellery (Crafting 3,625) and a poison spider (Attack). 0 deaths in the 3 proof runs. Planned: 1,200 / 3,000
(ESTIMATE); measured 1,179-1,199.

Route (run ra, MILESTONE ticks): Dimintheis 0-29; Camelot teleport, Caleb twice (fish, "what happened to the rest")
29-130; Lumbridge teleport, toll gate, gem trader 130-198; Al Kharid furnace, ruby ring and necklace from the
'perfect' bars 198-243; Avan 243-332; Falador teleport, trapdoor at 3019,3450, Boot 332-474; Lumbridge teleport, toll
gate, Avan's piece 474-564; Varrock teleport, Jolly Boar Inn, Johnathon, antipoison 564-684; walk to the Edgeville
trapdoor and through the dungeon 684-827; Chronozon 827-999; Varrock teleport, Dimintheis 999-1059; walk to Avan,
gauntlets 1059-1182.

Helper items (the preset): the 5 cooked fish for Caleb, 2 'perfect' gold bars (2365, tradeable, so a helper mines
and smelts them in the Witchaven dungeon), 2 rubies, ring and necklace moulds, 2 antipoisons, 100 air, 12 water, 15
earth, 70 fire, 24 death and 6 law runes, 100 coins (the toll gate twice), 8 sharks. The crest pieces, the 'perfect'
jewellery and the gauntlets are untradeable (`quest_crest.obj`), so Haggis does every NPC step itself.

Findings:

- **The row cannot run where the floor order put it.** Before this work the floor order ran `crest` at tick 1,872,
  after `prayer-31`, with Magic 1 and 10 Hitpoints. Chronozon dies only after one successful hit of each of Wind,
  Water, Earth and Fire Blast (`crest_chronozon.rs2`, `player_magic.rs2:223`, in `pvm_spell_success`), and Fire
  Blast needs Magic 59. His room is in the Wilderness part of the Edgeville dungeon with poison spiders (64) beside
  him and black demons (172) north of him (`bun research/route-danger.ts 3088,9970 3087,9940`). The row now has
  `minLevel: { magic: 59 }`. The planner does not model Hitpoints; with the gate it puts `crest` after the Grand Tree,
  where Haggis still has about 10 Hitpoints. The preset is Haggis after Monkey Madness (Hitpoints 97, Defence 89)
  with Magic 59, so the proof is for that state, not for a 10-HP account (not run).
- A blast that splashes sets no bit. In the rune set (magic bonus about -50) the blasts splashed until the runes ran
  out in 2 of 6 earlier runs. Chronozon has no magic level, so the script takes off the helm, body, shield and legs
  (4 ticks) before the first blast, and casts each blast until "Chronozon weakens". It then kills him with fire blasts.
- Single-way combat: a poison spider that attacks first blocks every cast ("I'm already under attack!"). The script
  kills it with the scimitar (NPC `targetIndex` 32768 + player index), then goes on. One earlier run died to the
  spider's poison after the teleport out, so the script drinks the second antipoison before the fight.
- Johnathon's `inv_del(inv, last_useitem, 1)` removes the whole 4-dose antipoison.
- The gameMessages list is capped, so the script tells a new message by its `observationId`, not by a count.
- `quest-lib.ts` marks a jump to Lumbridge as a death. The new `lumbridgeOk` option turns that off for scripts that
  use the Lumbridge teleport (respawn count and life id still count).
- The trapdoor north of Falador (loc 1570 `trapdoor_open` at 3019,3450, `maps/m47_53.jm2`) leads to Boot; it is
  not a ladder.

Planner: row `crest` 1,179 / 1,199 MEASURED, `minLevel: { magic: 59 }`, qp 0 (its 1 QP stays inside `quests-rest`;
with qp 1 the realistic end count was 143 and two tests failed). Scenario a, `research/hiscores-live.json`:

| Model | Overall floor | Overall realistic | Route (realistic) |
|---|---|---|---|
| Before (crest 1,200 / 3,000 ESTIMATE, no gate) | 38,583 | 47,248 | separate |
| Measured ticks only, no gate | 38,562 | 46,011 | superheat |
| Measured ticks and the Magic 59 gate (now) | 39,229 | 46,673 | superheat |

Still open: the crest in the order needs a combat state that the planner does not model (Hitpoints); the walk from
the previous activity to Dimintheis is not counted; the Al Kharid toll gate dialogue runs twice (not timed separately)
(a Prince Ali Rescue first makes the gate free); the perfect gold supply (Witchaven dungeon lever puzzle) is not
scripted for a helper.

## 1e. Combat gates on the boss quests (CODE-READ)

The planner places the boss quests while Haggis has Attack, Strength and Defence 1 and 10 Hitpoints. Every boss on
the route attacks with melee. Protect from Melee (Prayer 43, `skill_prayer/configs/prayers.dbrow:121-127`) sets NPC
melee damage to 0 (`skill_combat/scripts/npc/npc_combat_melee.rs2:44-45`). It drains 1 point per 5 ticks
(`skill_prayer/scripts/prayer.rs2:164-174`, effect 12), so 43 points last 215 ticks. Fire Bolt (Magic 35, max hit 12,
`skill_combat/configs/magic/magic_combat_spells.dbrow:134-143`) is the damage source. NPC max hit =
((strength + 9) x (strength bonus + 64) + 320) / 640 (`npc_combat_melee.rs2:2-8`, `combat.rs2:7-12`).

| Row | Gate (`minLevel`) | Boss and evidence |
|---|---|---|
| `tree` | prayer 43, magic 35 | Khazard warlord: attack 75, strength 78, 170 HP, crush, max hit 9 (`quest_tree/configs/gnome_battlefield.npc:103-108`); commander 50/45, stab (`:114-145`); troopers melee |
| `grandtree` | agility 25, prayer 43, magic 35 | black demon from Glough (`quest_grandtree/scripts/glough.rs2:119`): attack 145, strength 148, 157 HP, slash, max hit 16 (`quest_grandtree/configs/quest_grandtree.npc:190-216`) |
| `rival-fight-arena` | prayer 43, magic 35 | ogre 60 HP, scorpion 40, Bouncer 116, General Khazard 170, all melee (`quest_arena/configs/quest_arena.npc`); about 386 HP = about 72 bolts (360 ticks) against 215 ticks of prayer: 2 prayer potions (ESTIMATE) |
| `rival-mm` | prayer 43, magic 75 | jungle demon 170 attack, strength, magic, 170 HP; waves with max hit 31, 0 under Protect from Magic (Prayer 37) (`quest_mm/scripts/mm_demon.rs2:349-353`); melee only within 2 tiles (`mm_demon.rs2:332-336`). Damage source Fire Wave, MEASURED (section 1h) |
| `crest` | magic 59, prayer 43 | Chronozon: attack 173, strength 172, slash (`quest_crest/configs/quest_crest.npc:45-52`); the MEASURED proof ran at Hitpoints 97, not under the prayer |
| `merlin` | prayer 43 | Sir Mordred: 33/33, 38 HP, slash, max hit 4 (`quest_arthur/configs/keep_le_faye.npc:77-87`) |
| `grail` | attack 20, prayer 43 | Black Knight Titan: 91/100, 142 HP, crush, max hit 11 (`quest_grail/configs/fisher_realm.npc:293-308`); MEASURED 1,451-1,479 ticks (section 1k), HP min 99 |
| `dragon` | prayer 43 | Elvarg: 70/70, 120 HP, slash, attack range 8 (`quest_dragon/configs/quest_dragon.npc:15-29`); the dragonfire needs the anti-dragon shield |

New train row `prayer-43` (bury dragon bones to 43, rates of `prayer-31`). Train rows only reorder XP, so the cost
is small. The field `minLevelSource` in `haggis-boards.json` holds each gate's evidence. `Witch's House` (the
experiment) is not read yet.

Overall finish, scenario a, `research/hiscores-live.json`:

| Model | Overall floor | Overall realistic |
|---|---|---|
| Before (crest gate only) | 39,229 | 46,673 |
| Combat gates and `prayer-43` (commit 53a17eb) | 39,243 | 46,690 |
| Gates and Tree Gnome Village MEASURED (782 / 829) | 39,360 | 46,019 |

The floor rises because the old `tree` floor was the rival's 938 (and 665 with the `rival-grandtree-agility`
lever), both UNVERIFIED; the realistic finish drops 671 ticks against the old 1,500 ESTIMATE.

## 1f. Measured: Tree Gnome Village (the `tree` row)

Script `scripts/generated/quest-tree.ts`, preset `quest_tree` (beside King Bolren, 2542,3171). The preset is the
planner state at the row: Attack, Strength, Defence 1, 10 Hitpoints, Magic 43, Prayer 43; staff of fire, 80 chaos and
240 air runes (Fire Bolt), 6 logs, 2 prayer potions, 4 lobsters. Practice server, one bot at a time.

3/3 PASS (MEASURED practice, 2026-10-23):

| Run | RESULT line (cut) | Ticks | LEDGER idle | HP min | Potions |
|---|---|---|---|---|---|
| 1 | `RESULT ok qp=2 amulet=true questMsg=true potions=2 prayerLeft=13 xp=attack=286250,hitpoints=5660,magic=23737 at=2542,3170,0 ticks=782 hpMin=10 eats=0 walkTicks=325 retries=3 died=false` | 782 | 117 (14.9%) | 10 | 2 |
| 2 | `RESULT ok qp=2 amulet=true questMsg=true potions=2 prayerLeft=8 xp=attack=286250,hitpoints=5692,magic=26600 at=2542,3170,0 ticks=810 hpMin=10 eats=0 walkTicks=326 retries=3 died=false` | 810 | 131 (16.1%) | 10 | 2 |
| 3 | `RESULT ok qp=2 amulet=true questMsg=true potions=2 prayerLeft=4 xp=attack=286250,hitpoints=5697,magic=28287 at=2542,3170,0 ticks=829 hpMin=10 eats=0 walkTicks=326 retries=3 died=false` | 829 | 138 (16.6%) | 10 | 2 |

Every run ends with `Congratulations! Quest complete!`, the gnome amulet and 286,250 Attack (`quest_tree.rs2:98`).
No damage in any run (HP min 10). Planned: 938 / 1,500 (ESTIMATE); measured 782-829.

Route (run 1, MILESTONE ticks): Bolren 0-42 (Elkoy then puts the player outside the maze); Montai, logs, trackers
42-116; ballista 116-137; crumbled wall 137-187; ladder, chest, orb 187-229; door out, Elkoy, railing, Bolren
229-363; battlefield, warlord 363-617; Elkoy, railing, Bolren, completion 617-782.

Findings:

- The ballista takes 0004, 0003, 0005 at stage 4 with no tracker talk (`quest_tree.rs2:10-24`). Ballista loc 2181 at
  2508,3210 (`maps/m39_50.jm2`).
- The orb chest is on level 1 (2506,3259). From the crumbled wall the way up is a diagonal door (loc 1530 at
  2505,3256) and the ladder at 2503,3252. The way out is the stronghold door at 2502,3250, which opens only from the
  north side; on the door tile the player is already outside.
- Elkoy drops the player at 2515,3159, south of the village fence. The SDK route from there ends at a fenced dead end
  (2544,3174). The loose railing (loc 2186 at 2515,3161, `gnomevillage_fence.rs2`) is the way in.
- A level-up page blocks the cast. With casts at fixed 5-tick slots a test fight took about 500 ticks and ran out of
  prayer; with the cast sent the tick after the page closes, the battlefield leg (walk and fight, milestones 7 to 8)
  takes 254-300 ticks.
- A trooper hit the bot (10 to 8 HP) at 2468,3270 in a test run with the prayer off, so the prayer goes on before
  the walk through the battlefield. Montai's catapult hits 0-3 near 2524,3238 (`commander_montai.rs2:74-90`); the
  route stays west of it.
- Prayer is the margin: 4-13 points were left. A third potion would remove the risk (not run).

Still open: Monkey Madness has no proved script (`rival-mm` stays ESTIMATE; The Grand Tree is section 1g); the walk
to Bolren is not counted.

## 1g. Measured: The Grand Tree (the `grandtree` row)

Script `scripts/generated/quest-grandtree.ts`, preset `quest_grandtree` (beside King Narnode, 2466,3494). The preset
is the planner state at the row (after `tree` and `agility-25`): Attack 60 (the 286,250 XP of Tree Gnome Village),
Strength, Defence 1, 10 Hitpoints, Magic 43, Prayer 43, Agility 25, varp 111 = 9 (Tree Gnome Village complete, so the
village spirit tree works). Staff of fire worn; 80 chaos, 250 air and 2 law runes (Fire Bolt, Varrock Teleport); 3
prayer potions, 1 antipoison, 4 lobsters. Debug presets `quest_grandtree_s50/s80/s90/s120/s140` set varp 150 to a later
stage (`GT_FROM=<stage>`). Practice server, one bot at a time.

### Stages (CODE-READ)

Varp `%grandtree` is 150 (`pack/varp.pack:151`); stage values are in `quest_grandtree/configs/quest_grandtree.constant`.
Paths below are under `vendor/rs-sdk/server/content/scripts/`; `qgt/` is `quests/quest_grandtree/scripts/`.

| Varp | Step | Where | Evidence |
|---|---|---|---|
| 0 -> 10 | Narnode: "You seem worried", "I'd be happy to help!"; he walks the player under the trapdoor (2463,3497) and back up; bark sample (783), translation book (784) | Grand Tree l0, 2466,3497 | `qgt/king_narnode.rs2:199-246, 271-307` |
| 10 -> 20 | Hazelmere takes the bark and writes the scroll (786) | island east of Yanille, l1, 2678,3086 (ladder 2677,3087) | `areas/area_gnome/scripts/hazelmere.rs2:5-36` |
| 20 -> 30 | Narnode, the translation: "I think so!", "None of the above." twice, "A man came to me with the King's seal.", "I gave the man Daconia rocks.", "And Daconia rocks will kill the tree!" | Grand Tree l0 | `qgt/king_narnode.rs2:170-192, 324-413` |
| 30 -> 40 | Glough in his tree house | l1, 2478,3463 (ladder 2476,3463) | `qgt/glough.rs2:69-81` |
| 40 -> 50 | Narnode: the prisoner is at the top of the tree | Grand Tree l0 | `qgt/king_narnode.rs2:157-165` |
| 50 -> 60 | Charlie in the cage; the l2 ladder's Climb-up adds him for 500 ticks | Grand Tree l3, 2464,3495 | `qgt/charlie.rs2:38-53`, `qgt/quest_grandtree.rs2:17-21`, `ladders+stairs/scripts/ladders.rs2:128-144` |
| 60 -> 70 | Glough's cupboard: Open, Search, the journal (785) | l1, 2476,3465 | `qgt/quest_grandtree.rs2:94-107` |
| 70 -> 80 | Glough calls a guard; the jail with Charlie; Narnode lets the player out | l1 -> l3 | `qgt/glough.rs2:33-68`, `qgt/charlie.rs2:58-83`, `qgt/king_narnode.rs2:420-426` |
| 80 | Gnome pilot: "Take me to Karamja please!"; the glider lands at 2917,3058 | Grand Tree l3, 2464,3501 | `areas/area_gnome/scripts/gnome_glider.rs2:86-114` |
| 80 -> 90 | Shipyard gate: "Glough sent me.", "Ka.", "Lu.", "Min."; the foreman: "Sadly his wife is no longer with us!", "He loves worm holes.", "Anita."; the lumber order (787). A wrong answer starts a fight | Karamja, gate 2945,3041, foreman 2999,3043 | `qgt/shipyardworker.rs2:65-142`, `qgt/foreman.rs2:1-116`, `qgt/quest_grandtree.rs2:112-151` |
| 90 | The stronghold gate guard turns the player away (Femi sneaks the player in) | gate 2459,3383 | `areas/area_gnome/scripts/gnome_gate.rs2:13-20`, `qgt/femi.rs2:8-73` |
| 90 -> 100 | Charlie: Glough's key is at his girlfriend's | Grand Tree l3 | `qgt/charlie.rs2:9-20` |
| 100 | Anita gives Glough's key (788) | l1, 2390,3514 (stairs 2389,3512) | `qgt/anita.rs2:1-21` |
| 100 -> 110 | Key on Glough's chest: the invasion plans (794) | l1, 2482,3462 | `qgt/quest_grandtree.rs2:71-91` |
| 110 -> 120 | Narnode takes the plans and gives 4 twigs (789-792; needs 4 free slots) | Grand Tree l0 | `qgt/king_narnode.rs2:100-118` |
| 120 -> 130 | Up Glough's tree (Agility 25) to l2; twig T, U, Z, O on the pillars 2485, 2486, 2487, 2488 (z 3467) | l1 2484,3464 -> l2 | `qgt/quest_grandtree.rs2:23-51` |
| 130 -> 140 | The trapdoor (2487,3464 l2) to 2491,9864; Glough's cutscene; the black demon (157 HP, melee, `magicdefence -10`) attacks only this player; its death sets 140 | roots | `qgt/quest_grandtree.rs2:53-66`, `qgt/glough.rs2:92-126`, `qgt/grandtree_black_demon.rs2:1-39`, `quest_grandtree/configs/quest_grandtree.npc:190-216` |
| 140 -> 150 | Narnode in the roots; `%daconia_rock_root = random_range(1, 15)` | roots, 2464,9897 | `qgt/king_narnode.rs2:41-72` |
| 150 | Search the roots; the one in `daconia_coords` with that value gives the rock (793) | 15 roots in 2439-2490, 9872-9904 | `qgt/quest_grandtree.rs2:170-193`, `quest_grandtree/configs/daconia_coords.enum` |
| 150 -> 160 | Narnode takes the rock and queues the completion: 197,500 Agility, 460,000 Attack, 53,750 Magic at 25x, 5 QP | roots | `qgt/king_narnode.rs2:15-36`, `qgt/quest_grandtree.rs2:195-203`, `general/configs/quest.constant:96` |

`daconia_coords.enum` gives index 0 and 1 the same tile (2456,9886); `EnumType.values` is a `Map`, so the later entry
(1) wins (`engine/src/cache/config/EnumType.ts:66-87`) and all 15 values 1-15 have a root.

### Proof

3/3 PASS (MEASURED practice, 2026-10-23):

| Run | RESULT line (cut) | Ticks | LEDGER idle | Demon casts | Roots searched |
|---|---|---|---|---|---|
| p1 | `RESULT ok qp=5 questMsg=true roots=13 potions=2 prayerLeft=25 xp=attack=460000,hitpoints=5225,magic=76025,agility=197500 at=2463,9895,0 ticks=2079 hpMin=10 eats=0 walkTicks=1003 retries=6 died=false` | 2,079 | 289 (13.9%) | 28 | 13 |
| p2 | `RESULT ok qp=5 questMsg=true roots=1 potions=2 prayerLeft=9 xp=attack=460000,hitpoints=5222,magic=76587,agility=197500 at=2466,9896,0 ticks=2001 hpMin=10 eats=0 walkTicks=895 retries=5 died=false` | 2,001 | 332 (16.6%) | 29 | 1 |
| p3 | `RESULT ok qp=5 questMsg=true roots=13 potions=2 prayerLeft=22 xp=attack=460000,hitpoints=5222,magic=78837,agility=197500 at=2464,9896,0 ticks=2083 hpMin=10 eats=0 walkTicks=1005 retries=4 died=false` | 2,083 | 296 (14.2%) | 32 | 13 |

Every run ends with `Congratulations! Quest complete!` and the quest XP (460,000 Attack, 197,500 Agility; the Magic
above includes the Fire Bolts). No damage in any run (HP min 10). Planned: 1,811 / 3,000 (ESTIMATE; 1,811 is the
rival's UNVERIFIED live leg); measured 2,001-2,083.

Route (run p1, MILESTONE ticks): Narnode 0-91; out of the stronghold gate 91-158; walk to Hazelmere 158-433; Elkoy,
the railing, the village spirit tree, Narnode (translation) 433-706; Glough 706-756; Narnode 756-800; Charlie 800-835;
journal 835-886; jail and release 886-952; glider 952-974; shipyard gate and foreman 974-1149; Varrock Teleport, the
Varrock and village spirit trees, Charlie 1149-1337; Anita 1337-1419; chest 1419-1489; Narnode, twigs 1489-1539;
pillars 1539-1589; trapdoor and cutscene 1589-1626; black demon 1626-1783; Narnode in the roots 1783-1885; roots
1885-2024; completion 2024-2079.

Findings:

- The walk out to Hazelmere is the largest leg (about 275 ticks). The SDK path runs east along the road under the
  Combat Training Camp gate (2517-2518,3356, locked before Biohazard, `area_combat_training/scripts/combat_training_camp.rs2:36-43`).
  `walkPath` takes the gate for a door on its path and clicked it for 410 ticks in one test run (the guard's page each
  time); `blockDoorTemporarily` on the gate does not change `findLongPath` (path test in the scratchpad: the same 89
  points). A client-routed click from 2509,3355 to 2526,3353 goes past it.
- Hazelmere's island is full of jungle spiders (melee, no poison param, `_unpack/225/all.npc:1585-1607`); a test run
  died there at 10 HP. Protect from Melee is on from 2638,3089 to the ladder and back.
- From the east the SDK path to the village runs through the maze, out at 2549,3171 and south past the giants at
  2545,3144 (one test run: 10 -> 7 HP). Elkoy at the maze entrance (2504,3192) puts the player at 2515,3159 after
  Tree Gnome Village too (`areas/area_gnome/scripts/elkoy.rs2:160-180`); the loose railing is the way in.
- The Grand Tree doors (treedoorl/r at 2464-2466,3492, shape 10, `areas/area_gnome/scripts/gnome_gate.rs2:62-76`)
  are solid to the SDK pathfinder; from the south it routed outside the trunk and failed. Inside, `walkPath` takes the
  trapdoor (2463,3497) for a shut door ("The trapdoor won't open!" for 210 ticks). The script uses the tree doors.
- Charlie's talk is an ap op (`qgt/charlie.rs2:1`): it needs line of sight. The prison door has `blockrange=no`
  (`_unpack/225/all.loc:15100-15105`) but the laddertop (2466,3495) blocks it; from 2465,3495 the talk works.
- Charlie lives 500 ticks; the second visit comes 480-570 ticks after the first, and one test run found him gone.
  No Charlie: down one ladder and up again adds a new one.
- Dialogs with `if_close` + `p_delay` gaps (Glough's guard, Narnode's guard in the roots, 7 ticks) restart when a
  second Talk-to is sent; `quest-lib`'s `talk` sends one after 3 closed ticks. The script sends one Talk-to and then
  clicks pages (`talkOnce`).
- Two jogres hit at the Karamja landing (10 -> 4 HP in one test run): the prayer goes on before the flight. A prayer
  toggle sent during Glough's cutscene did not take, so the prayer goes on before the trapdoor.
- The demon took 28-32 Fire Bolts (about 155 ticks); 2 potions in every run, 9-25 points left.
- After the lumber order the stronghold gate is shut. Varrock Teleport, the young spirit tree at 3177,3506 and the
  village tree (Gnome stronghold) land at 2461,3443, inside the gate, so Femi is not needed.

Planner: row `grandtree` 2,001 / 2,083 MEASURED (also in the `rival-grandtree-agility` lever patch). Scenario a,
`research/hiscores-live.json` (`bun packages/planner/src/haggis-cli.ts research/hiscores-live.json`):

| Model | Overall floor | Overall realistic |
|---|---|---|
| Before (grandtree 1,811 / 3,000 ESTIMATE) | 39,239 | 45,758 |
| Grand Tree MEASURED (2,001 / 2,083) | 39,981 | 44,841 |

The floor rises 742 ticks because the old floor was the rival's UNVERIFIED 1,811; the realistic finish drops 917
ticks.

Still open: the root search is random (1-13 roots, 12-139 ticks); a better tour from the trapdoor (search before
Narnode is not possible, the root is set at 150) is not tried. The walk to Narnode is not counted. The preset has
10 HP; the planner does not model Hitpoints.

## 1h. Monkey Madness (the `rival-mm` row): MEASURED end to end on practice

Script `scripts/generated/quest-mm.ts` (puzzle solver `scripts/generated/mm-puzzle.ts`), presets in
`packages/practice/src/presets-mm.ts`. The preset `quest_mm` is the planner state at the row (scenario a, order row
24, after Fight Arena): Attack 99, Magic 99, Smithing 99, Prayer 43, Agility 57, Thieving 43, Strength, Defence,
Ranged 1, Hitpoints 35 (ESTIMATE: the planner does not model Hitpoints). The Grand Tree and Tree Gnome Village are set
complete in the preset (varp 150 = 160, varp 111 = 9); the Grand Tree helper owns that quest. Worn: wizard hat,
amulet of magic, staff of fire, wizard robe and skirt (all Defence 1). Pack (helper items, 26 of 28 slots: the seal
and the orders take the last two in chapter 1): 200 blood and 1,000 air runes (Fire Wave), 3 law runes, gold bar,
ball of wool, monkey bones, 7 prayer potions, 1 super antipoison, 12 sharks. No bananas: the bot picks 5 from the
trees in the child's garden. The first version (4 potions, 1 antipoison, 10 sharks, 5 bananas) died on the atoll.

Two tool fixes were needed:

- The save generator writes varps 0-308 only (`vendor/rs-sdk/sdk/test/utils/save-generator.ts:314`); the quest's
  varps are 365-374 (`content/pack/varp.pack:366-375`). `applyPreset` now rewrites the varp block when a preset has
  a higher id (`extendVarps` in `presets-mm.ts`; `PlayerLoading.ts:101-111` reads any count).
- The puzzle moves a tile only on OPHELD5 with the puzzle component (`mm_puzzle.rs2:116-150`,
  `reinitialisation_puzzle:com_3` = 11130). The lite client sends INV_BUTTON5 for every component except the
  inventory (`webclient/src/lite/actions.ts:209-220`). The real client sends OPHELD5 with any component id
  (`webclient/src/client/Client.ts:11553-11583`) and the server accepts any operable component with an inventory
  (`OpHeldHandler.ts:20-40`). The script writes that packet on the lite client (`Session.client`, new in
  `packages/core/src/inprocess.ts`) and reads the board from the component's `linkObjType`. It is the packet a person
  sends by clicking the tile. Glough's 200,000-coin shortcut (`mm_glough.rs2:28-29`) still leaves one slide
  (`mm_puzzle.rs2:33-35, 73-75`), so it does not remove the need for this packet.

### Stages (CODE-READ; `%mm_main` is varp 365, the others are bit fields, `quest_mm.varbit`)

| # | Stage | Evidence | State |
|---|---|---|---|
| 10 | Narnode (Grand Tree l0): "Yes" to "Start Monkey Madness?"; royal seal | `king_narnode.rs2:7-9` (needs `%grandtree` 160 and `%treequest` 9); `mm_narnode.rs2:124-137` | MEASURED |
| 20 | Glider l3 to Gandius (`glidermap:com_21`, `gnome_glider.rs2:1-24`); shipyard gate: the worker sees the seal (`mm_caranock.rs2:45-61`, `shipyardworker.rs2:69-71`); Caranock (2956,3025) | | MEASURED |
| 30 | Gandius glider back (`com_22`); Narnode writes the orders (`mm_narnode.rs2:143-202`) | | MEASURED |
| 40 | Daero (2484,3486,l1): the orders; "Leave" shows only after the three topics (`mm_daero.rs2:129-145`); blindfold to the hangar 2393,9892 (`:230-238`); Daero introduces Waydar (`:66-93`) | | MEASURED |
| 50 | Panel (2394,9883): the 5x5 puzzle, a 255-step random walk (`mm_puzzle.rs2:71-85`); weighted A* (49-79 slides, 4 per tick); the last slide starts the hangar cutscene (`:110-192`) | | MEASURED |
| 60 | Daero (reinit complete, `mm_daero.rs2:36-49`); Waydar "Yes": Crash Island 2893,2725 (`mm_waydar.rs2:5-20, 112-118`) | | MEASURED |
| 70 | Waydar; Lumdo refuses (`mm_lumdo.rs2:17-68`); Waydar orders him: chapter 2 cutscene (`mm_waydar.rs2:73-94`, `quest_mm.rs2:123-164, 279-360`); Ape Atoll 2801,2707 | | MEASURED |
| 80 | Walk west to the ravine (2721,2757) until a ravine archer knocks you out (1 in 20 arrows, `mm_archer.rs2:51-53`; the prayer does not stop it); jail 2770-2776,2793-2794 (`:66-82`); pick the lock 2771,2795 (`mm_jail.rs2:1-11`, `stat_random(thieving, 95, 295)`, 0-3 fails at Thieving 43) when no patrol guard is within 3 tiles. The patrol (`mm_jail.rs2:181-259`, route enum `mm_jail_patrol_route`) walks the only exit lane (2772-2773,2796-2801) and knocks a human back in from 1 tile of its south-west tile, with a flyback that costs a fifth of the HP: 0-5 re-jails a run | `quest-mm.ts` `knockout`, `walkAtoll` | MEASURED |
| 90 | Garkor (2805,2762) from the north tile (the elder guards south of him knock out a human, `mm_elder_guard.rs2:52-75`); his talk resumes after a hit closes it (`mm_garkor.rs2:95-126`). Dentures crate (2767,2769) from 2768,2769 (outside the sleeping guard's zone 2762-2767,2767-2772, `mm_sleeping_monkey_guard.rs2:1-14`), in by the warehouse door 2764,2764; the crate over the hole (2769,2765) from its south tile 2769,2764: the warehouse spider (2 HP, `respawnrate=4`, spawn 2770,2766) hits from the other tiles, and any hit closes the choice (`npc_combat_melee.rs2:36`). Cellar, mould crate (2782,9172), the **eastern** rope (2798,9169): the western one lands in a warehouse whose only ground door (2744,2767) is locked (`quest_mm.rs2:1019-1020`); the eastern one lands in the sleeping guard's zone, and the bot runs south out of it | `quest-mm.ts` stage 90 | MEASURED |
| 100 | Bridge ladder 2803,2734 up, jump at 2803,2727,l2 to the landing (`quest_mm.rs2:1022-1043`; not as a monkey); dungeon ladder 2763,2703; Zooknock 2804,9145 by a fixed corner route (about 535 tiles; a single far goal sent the walker into a dead end); Protect from Melee for the whole human pass; his story resumes after hits; dentures, gold bar, mould and the monkey bones on him: enchanted bar and mould back (`mm_zooknock.rs2:48-122, 163-201`) | `quest-mm.ts` stage 100 | MEASURED |
| 110 | Back up; the second knockout and lock; the temple: south ladder (2794,2773) up, level 1 to 2806,2785, the east ladder top drops on the trapdoor's access tile (`quest_mm.rs2:766-771`); trapdoor (2807,2785, `mm_temple.rs2:1-17`); wall of flame (4765 at 2809,9191, not in `nearbyLocs`) with the bar and the mould, wool on the amulet; the rope (4881 at 2808,9201, by id) lands on a random tile within 2 of the trapdoor (`mm_temple.rs2:28`): 2806,2785 takes the ladder, 2807,2783-2787 walk out on the temple floor, a tile boxed by the engaged trapdoor guards goes back down the open trapdoor (it stays open 500 ticks, `mm_temple.rs2:6`) and up the rope for a new tile when it is within 1 tile of the trapdoor, else falls back to Varrock Teleport and the way round (2 of the last 5 full runs; pass 4 used it; one boxed landing at 2805,2784, 2 tiles out, could not reach the trapdoor). The child (2743,2795): 5 bananas from the garden trees, uncle, how many, the bananas, the toy after 100 ticks; the aunt patrols her garden (`quest_mm.npc` `[mm_monkeys_aunt]`: 2742,2794 15 ticks, 2743,2792 30 ticks, then her house), so the bot waits at 2746,2800 while she is there. She calls only when both stand in the garden or both outside it (`mm_monkeys_aunt.rs2:13-17`), so the bot stays in the garden until she walks in: it leaves 13 ticks after she stops at 2737,2794 (she steps in at 2740 18 ticks after she arrives there, practice trace). The child's talks end after 2 shut ticks (was 6), and the bananas go on the child (`opnpcu`, no greeting pages). During the toy's 100-tick timer the bot picks 6-8 more bananas from the other trees (5 a tree), eaten on the walks at 31 HP or less. The dungeon (Protect from Melee), the talisman on Zooknock: the Karamjan greegree; the chapter 3 cutscene (an eat or a potion inside it closes the page; a step restarts it, `quest_mm.rs2:360-375`) | `quest-mm.ts` stages 105-110 | MEASURED |
| 115 | Greegree worn (`mm_greegree.rs2:1-10`, not within 10 ticks of combat); the dungeon back (the zombies hit a monkey too: Protect from Melee); the west gate (2719,2766) opens for a monkey; Garkor (Karamjan monkey: seek an alliance); the talking elder guard (2801,2757); Kruk in the yard east of the gate, reached over the watchtower bridge (west tower ladder 2713,2766 to level 2, east tower 2729,2766 down); he escorts the envoy in; Awowogei's mission | `quest-mm.ts` stage 115 | MEASURED |
| 120 | Out by the elder guard from the hall door 2802,2759; greegree off before the bridge jump; Lumdo to Crash Island; Waydar to the Gnomeball pitch; stronghold spirit tree to the Battlefield; round a locked Khazard door to the zoo; greegree on, the minder cages the "monkey", a zoo monkey in the backpack, greegree off, the minder lets the human out; walk to the stronghold's south gate (`gnome_areagate` 190, op; Femi's boxes: "Sorry, I'm a bit busy") and the Grand Tree; Daero, Waydar, Lumdo; greegree, gate, the elder guard lets Kruk's envoy in; Awowogei; Garkor: chapter 4 cutscene, then the sigil; staff and amulet of magic back on | `quest-mm.ts` stage 120 | MEASURED |
| 140 | Sigil op2 (`mm_demon.rs2:1-5, 16-143`): the battle zone 1_42_143; Protect from Magic on arrival; Fire Wave every 5 ticks from 4+ tiles; kill (`:377-401`) | | MEASURED |
| 150 | Varrock Teleport out (the squad deletes itself, `:212-220`); Varrock young tree, village tree, stronghold, Narnode | | MEASURED |
| 160 | Narnode: report, 10,000 coins and 3 diamonds, completion, 3 QP (`mm_narnode.rs2:14-31, 89-100`, `quest_mm.rs2:1167-1171`); Daero l1, option 1 (`mm_daero.rs2:240-302`) | | MEASURED |

### The damage source and the safe route

- The jungle demon (`quest_mm.npc:1468-1508`): attack, strength, defence, magic 170, 170 HP, +50 slash and magic
  defence, attack range 10, attack rate 6. At range it casts a random wave (max 31), set to 0 under Protect from Magic
  (`mm_demon.rs2:342-354`); within 2 tiles half its attacks are melee (`:332-336`). The squad hits 0-1 and a squad
  killing blow heals it 15 (`:403-417`); the kill counts only if the player is the top damage dealer (`:377-385`).
- Magic 99 and Ranged 1 at this row, so the damage source is Fire Wave (Magic 75, max 20,
  `magic_combat_spells.dbrow:292-295`) with the staff of fire. Hit chance (CODE-READ, `player_combat.rs2:52-68`,
  `npc_combat.rs2:325-334`, `player_combat_stat.rs2:62-89`): player roll (99 + 9) x (bonus + 64), about 9,800 at +27;
  demon roll (170 + 9) x (50 + 64) = 20,406; about 24% per cast. The script keeps 4+ tiles from the demon's centre and
  steps 6 tiles away when it is closer.
- Melee is not a choice: Strength 1 gives a max hit of about 3; the rival's melee test at 70/70/70 died 2 of 2
  (`bleugreen/rs-sdk docs/speedrun/quests/monkey_madness.md`, UNVERIFIED here).
- Gate: `minLevel: { prayer: 43, magic: 75 }`. Prayer 43 is for Protect from Magic (37), Missiles (40) and Melee (43).
  The Magic gate does not move the order (Magic is 99 before the row).
- Route on the atoll (MEASURED, full runs below): a human cannot walk from the landing into the village (one-way
  bridge, the west gate opens only for a monkey, `quest_mm.rs2:1022-1043, 1110-1117`), so the way in is the archers'
  knockout, twice. Protect from Missiles makes the archers harmless (damage 0) but not the knockout.
- The atoll is the damage source at Hitpoints 35, not the demon: posted archers hit up to 18, jungle scorpions 15,
  spiders and snakes 4-10, the jail flyback a fifth of the HP, the dungeon traps 2-3, the wildlife poisons. The
  overhead prayer follows the nearest threat (melee within 2, else an archer in its hunt range, else melee within 4);
  Protect from Melee stays on for the temple and every dungeon pass. Even then the 12 sharks are about all a run has:
  1-4 left at the end. Any hit, even at 0 damage, closes the open dialog, so every long talk and crate is written to
  resume.

### Proof (MEASURED practice, 2026-10-23)

Chapter 1 (preset `quest_mm`, stages 10-70, Narnode to the Ape Atoll landing), 3/3 PASS:

| Run | RESULT line (cut) | Ticks | Puzzle | LEDGER idle |
|---|---|---|---|---|
| 1 | `RESULT ok stage=70 (stages 80-120 not scripted) antipoisons=1 xp= at=2801,2707,0 ticks=692 hpMin=35 eats=0 walkTicks=127 retries=10 died=false` | 692 | 59 slides, 15 ticks | 154 (22.0%) |
| 2 | `RESULT ok stage=70 (stages 80-120 not scripted) antipoisons=1 xp= at=2801,2707,0 ticks=696 hpMin=35 eats=0 walkTicks=127 retries=10 died=false` | 696 | 53 slides, 14 ticks | |
| 3 | `RESULT ok stage=70 (stages 80-120 not scripted) antipoisons=1 xp= at=2801,2707,0 ticks=720 hpMin=35 eats=0 walkTicks=127 retries=10 died=false` | 720 | 71 slides, 18 ticks | 173 (23.9%) |

The battle and the end (preset `quest_mm_s130`: `%mm_main` 5, `%mm_garkor` 6, the sigil; stages 140-160), 3/3 PASS:

| Run | RESULT line (cut) | Ticks | Fight | Casts | Potions |
|---|---|---|---|---|---|
| 1 | `RESULT ok qp=3 questMsg=true fightTicks=447 casts=89 potions=4 prayerLeft=22 xp=attack=500000,strength=875000,defence=500000,hitpoints=880532,magic=99537 at=2482,3481,1 ticks=746 hpMin=35 eats=0` | 746 | 447 | 89 | 4 |
| 2 | `RESULT ok qp=3 questMsg=true fightTicks=347 casts=69 potions=2 prayerLeft=8 xp=attack=500000,strength=875000,defence=500000,hitpoints=879302,magic=77500 at=2482,3481,1 ticks=634 hpMin=35 eats=0` | 634 | 347 | 69 | 2 |
| 3 | `RESULT ok qp=3 questMsg=true fightTicks=514 casts=102 potions=4 prayerLeft=8 xp=attack=500000,strength=875000,defence=500000,hitpoints=880035,magic=111537 at=2482,3481,1 ticks=798 hpMin=35 eats=0` | 798 | 514 | 102 | 4 |

Every end run takes 0 damage in the fight (HP min 35), ends with the quest-complete message and 875,000 Strength,
875,000 Hitpoints, 500,000 Attack, 500,000 Defence (option 1). Findings:

- The demon is slow to kill: 69-102 casts, 347-514 ticks. The squad's chip damage and the 15 HP heal on a squad
  killing blow keep it alive until the player lands the last hit. One test run ran out of runes at 60 casts.
- Prayer is the margin: 2-4 of the 4 potions were used and 8-22 points were left. Six potions would remove the risk
  (not run).
- Karamja jungle spiders poison the bot on the way to the shipyard (one antipoison per run); jungle scorpions (38)
  on Crash Island took one test run from 35 to 11 HP, so Protect from Melee is on there.
- The arrival in the battle zone holds the player in a `p_delay` (`mm_demon.rs2:80-100`): a prayer toggle there is
  dropped, so the script toggles on every tick until it holds.

Planner (first pass of this work, 2026-10-23): row `rival-mm` kept 4,566 / 5,052 ESTIMATE; `minLevel` gained
`magic: 75`.

### Full runs (MEASURED practice, 2026-10-23)

The whole quest from preset `quest_mm` (Narnode to Daero's training reward), one bot at a time, 150 ms ticks,
`scratchpad run.ts` = `prove()` with a 50-minute timeout (`cli.ts prove` stops a script at 300 s). Milestone ticks
are from the start of the run.

| Pass | Script | Ticks | 70 atoll | 80 jail out | 90 cellar, rope | 100 Zooknock | 110 greegree | 115 Awowogei | 120 sigil | 160 Narnode | Fight | Re-jails | HP min | Sharks left |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | c2066f2 | **5,125** | 700 | 772 | 1,144 | 1,651 | 3,006 | 3,622 | 4,498 | 5,062 | 343 (68 casts, 4 potions) | 3 | 11 | 3 |
| 2 | c2066f2 | **5,458** | 694 | 767 | 1,165 | 1,882 | 3,279 | 3,889 | 4,775 | 5,395 | 399 (79 casts, 5 potions) | 5 | 16 | 2 |
| 3 | 2d3ec65 | **5,071** | 694 | 775 | 1,018 | 1,698 | 3,047 | 3,660 | 4,523 | 5,008 | 264 (52 casts, 3 potions) | 5 | 20 | 1 |
| 4 | 2d3ec65 | **5,786** | 700 | 765 | 1,091 | 1,958 | 3,748 | 4,366 | 5,226 | 5,710 | 264 (52 casts, 3 potions) | - | 5 | - |

RESULT lines (cut):

- 1: `RESULT ok qp=3 questMsg=true fightTicks=343 casts=68 potions=4 prayerLeft=11 xp=attack=500000,strength=875000,defence=500000,hitpoints=878470,magic=81562,crafting=5100,thieving=187 at=2482,3481,1 ticks=5125 hpMin=11 eats=15 walkTicks=2399 retries=25 died=false`
- 2: `RESULT ok qp=3 questMsg=true fightTicks=399 casts=79 potions=5 prayerLeft=13 xp=attack=500000,strength=875000,defence=500000,hitpoints=879630,magic=91812,crafting=5100,thieving=262 at=2482,3481,1 ticks=5458 hpMin=16 eats=16 walkTicks=2429 retries=28 died=false`
- 3: `RESULT ok qp=3 questMsg=true fightTicks=264 casts=52 potions=3 prayerLeft=18 xp=attack=500000,strength=875000,defence=500000,hitpoints=879637,magic=62062,crafting=5100,thieving=262 at=2482,3481,1 ticks=5071 hpMin=20 eats=17 walkTicks=2392 retries=25 died=false`
- 4: `RESULT ok qp=3 questMsg=true fightTicks=264 casts=52 potions=3 prayerLeft=9 xp=attack=500000,strength=875000,defence=500000,hitpoints=879227,magic=62337,crafting=5100,thieving=525 at=2482,3481,1 ticks=5786 hpMin=5 eats=16` (boxed at 2807,2786: the Varrock Teleport fallback, about 700 ticks)

Passes 5-7 ran back to back on the final script of 2026-10-24 (`proved 3/3`, one bot):

| Pass | Ticks | 70 atoll | 80 jail out | 90 cellar, rope | 100 Zooknock | 107 temple out | talisman | 110 greegree | 115 Awowogei | 120 sigil | 160 Narnode | Fight | Re-jails | HP min | Extra bananas |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 5 | **5,320** | 716 | 796 | 1,120 | 1,745 | 2,309 | 2,685 | 3,268 | 3,859 | 4,771 | 5,254 | 263 (52 casts, 3 potions) | 10 | 12 | 8 |
| 6 | **5,029** | 695 | 803 | 1,060 | 1,594 | 2,099 | 2,396 | 2,846 | 3,458 | 4,326 | 4,952 | 405 (81 casts, 5 potions) | 2 | 19 | 6 |
| 7 | **5,149** | 697 | 783 | 1,048 | 1,646 | 2,102 | 2,386 | 2,810 | 3,420 | 4,297 | 5,073 | 553 (110 casts, 6 potions) | 1 | 9 | 6 |

- 5: `RESULT ok qp=3 questMsg=true fightTicks=263 casts=52 potions=3 prayerLeft=17 xp=attack=500000,strength=875000,defence=500000,hitpoints=879867,magic=59225,crafting=5100,thieving=450 at=2482,3481,1 ticks=5320 hpMin=12 eats=15 walkTicks=2508 retries=26 died=false`
- 6: `RESULT ok qp=3 questMsg=true fightTicks=405 casts=81 potions=5 prayerLeft=12 xp=attack=500000,strength=875000,defence=500000,hitpoints=879805,magic=88875,crafting=5100,thieving=150 at=2482,3481,1 ticks=5029 hpMin=19 eats=13 walkTicks=2352 retries=26 died=false`
- 7: `RESULT ok qp=3 questMsg=true fightTicks=553 casts=110 potions=6 prayerLeft=9 xp=attack=500000,strength=875000,defence=500000,hitpoints=881550,magic=127650,crafting=5100,thieving=112 at=2482,3481,1 ticks=5149 hpMin=9 eats=16 walkTicks=2369 retries=25 died=false`

Passes 3 and 4 ran back to back on the script of 2d3ec65 (`proved 2/2`). Between passes 2 and 3 one run stopped boxed by the trapdoor guards at 2805,2786
(`RESULT fail temple out ... ticks=2380`); the Varrock Teleport fallback came after it, and pass 3 did not need it
(landing 2806,2784). Six earlier full tries failed while the atoll was being fixed: two deaths in the dungeon with the
food gone (HP 35, 10 sharks, 4 potions), a death at the warehouse door (a 15 hit by a scorpion while the prayer was on
the archers), a Zooknock talk and a Garkor talk closed by hits, a hole crate and a jail on the way. Each fix is in the
stage rows above.

Findings:

- The atoll costs about 3,800 ticks (stages 80-120), not the rival's 2,000. The largest items: two dungeon passes
  each way (about 270 ticks each), the child's garden (the aunt's 45-tick stay by the child, then the 100-tick toy
  timer), the zoo trip and the walk back (about 880 ticks for stage 120), and 3-5 re-jails (about 40 ticks each).
- Food is the limit at Hitpoints 35: every pass ended with 1-3 of 12 sharks. More Hitpoints (not modelled) or a
  smaller atoll exposure is the safety margin; the prayer potions (7) leave 8-18 points after the fight.
- The demon took 264-399 ticks (52-79 casts), as in the battle-only runs.
- Untested: logging out inside a cutscene (`mm_login`, `quest_mm.rs2:1-37`, completes the cutscene on login). The
  three cutscenes cost about 25-60 ticks each here; a relogin in the practice harness is not built. Glough's
  200,000-coin shortcut (`mm_glough.rs2:28-29`) leaves one slide and the solver needs 14-18 ticks, so it cannot
  save more than that minus the walk to Glough: not tried.

Where the atoll ticks go (pass 3 of 2026-10-23, 3,829 ticks for stages 80-120; MEASURED from its milestones and the
`jumps` list): four dungeon passes 269, 281, 303, 293 (1,146; the collision path is 535 tiles each way, `findLongPath`,
and the dungeon has one ladder, `m43_42`/`m43_142` loc 4780/4781); Zooknock's first talk and four gives 219 (dialog pages
are 2 ticks each, click and wait); the zoo trip 863 (zoo to the Grand Tree about 280 tiles walked; a spirit tree or a
teleport deletes the backpack monkey, `post_tele_checks`, `teleport.rs2:109-112`, `spirit_tree.rs2:76`; no glider lands
near the zoo); the child's garden 359 (100 of it the toy timer); the jailings with re-jails about 225. Glough's and the
cutscene relogin were not tried.

Changes of 2026-10-24 and their measured effect:

- Garden (aunt rule, shorter talk ends, bananas on the child): 284-297 ticks from the temple to the talisman in passes 6-7
  and 333 in a segment run, against 359-373 before (passes 1-4 and a segment run). Pass 5: 376 (the aunt's phase).
- Food: 6-8 extra bananas a pass (12-16 HP). HP min 9-19 in passes 5-7. One full pass before this change died in the
  fourth dungeon pass with the 12 sharks gone (HP 35, a Varrock fallback on the way).
- Waydar orders Lumdo only when Lumdo is within 10 tiles of the player (`mm_waydar.rs2:83`): one full run failed there
  (`RESULT fail talk waydar lumdo ... ticks=656`); the bot now stands near Lumdo first.
- Temple: the trapdoor retry for a boxed landing within 1 tile (not yet seen in a run; the one boxed landing since was
  2 tiles out and took the Varrock fallback).
- Not kept: a lock pick only in the patrol's handover window (the lane x 2772-2773, z 2796-2802 is the only way out and
  the patrol holds it for points 2-10, about 90 ticks a guard; the next guard crosses the west room 13-24 ticks after
  the last leaves). Practice: waits of 60-275 ticks a jailing and re-jails from the handover crowd, against about 70 a
  jailing for the old rule (pass 3: 20, 95, 110), so the old rule stays. The re-jails are still the largest variable
  cost (1-10 a pass, about 40 ticks and a fifth of the HP each).

Hitpoints: plan on 35 only with this pack: HP min 5-20 over 7 passes and one death. With a few more Hitpoints levels
(not modelled) or two more sharks (no free slot in chapter 1) the margin is safe. Prayer is near its limit too: pass 7
used 6 potions in the fight and left 9 points.

Planner: row `rival-mm` is now MEASURED 5,029 / 5,320 (best / worst of passes 5-7; was MEASURED 5,071 / 5,786 from
passes 1-4). Scenario a, `bun packages/planner/src/haggis-cli.ts --levers`, Overall finish: 40,545 floor / 45,430
realistic before, 40,503 / 44,964 after (same tree, 2026-10-24). The realistic drop is mostly the Varrock fallback that
none of passes 5-7 needed; it can still happen. `bun test packages/planner`: 42 pass.

Earlier planner change: row `rival-mm` became MEASURED 5,071 / 5,786 (best / worst pass; was ESTIMATE 4,566 / 5,052). Scenario a,
`research/hiscores-live.json`, `bun packages/planner/src/haggis-cli.ts --levers`, Overall finish: 40,040 floor /
44,805 realistic before the change, 40,545 / 45,539 after (both on the same tree, 2026-10-23/24). The
row is slower than the rival's estimate, so the finish moves out by 505 / 734 ticks. `bun test packages/planner`:
42 pass (the rival-lever test now accepts a MEASURED rival row that cites this section).

Next lead (2026-10-24): the re-jails (count the patrol's lane visits: point 10 is the third lane-top stop, so a
pick during that 6-tick stop and a wait in the lane at z 2797-2798 would follow the guard out), a boxed landing 2 tiles
from the trapdoor, and the cutscene relogin. Earlier leads, by size: the stage 120 walk back from the zoo (Ardougne to the Grand Tree, about
250 tiles; no teleport keeps the backpack monkey, `teleport.rs2:109-112`); the re-jails (pick the lock only in the
patrol's handover window); the child's garden wait (arrive while the aunt is in her house); the cutscene relogin
test. Hitpoints at the row is still not modelled (the preset's 35 is an estimate).

## 1i. Measured: Dragon Slayer (the `dragon` row)

Script `scripts/generated/quest-dragon.ts`, preset `quest_dragon` (`packages/practice/src/presets-dragon.ts`, beside
the Guild master inside the Champions' Guild). The planner runs `dragon` after the last 99 (`haggis-cli --order`
row 48, tick 52,855), so the preset has every skill at 99. The guild door needs `%qp >= 32`
(`champions_guild.rs2:1-3`), and `%qp` is recounted at login from the quest varps (`count_questpoints`,
`general/scripts/quests.rs2`), so the preset sets the complete values of 16 quests the planner does earlier (46 QP),
not varp 101. Worn: rune full helm, platebody, platelegs, scimitar. Practice server, one bot at a time.

3/3 PASS (MEASURED practice, 2026-10-23):

| Run | RESULT line (cut) | Ticks | LEDGER idle | HP min | Eats |
|---|---|---|---|---|---|
| 7 | `RESULT ok qp=2 questMsg=true xp=attack=34000,strength=466250,defence=466250,hitpoints=11255,magic=2225 at=2846,9636,0 ticks=1577 hpMin=54 eats=6 walkTicks=857 retries=2 died=false` | 1,577 | 289 (18.3%) | 54 | 6 |
| 8 | `RESULT ok qp=2 questMsg=true xp=attack=33900,strength=466250,defence=466250,hitpoints=11220,magic=2225 at=2846,9636,0 ticks=1531 hpMin=59 eats=1 walkTicks=858 retries=1 died=false` | 1,531 | 250 (16.3%) | 59 | 1 |
| 9 | `RESULT ok qp=2 questMsg=true xp=attack=33900,strength=466250,defence=466250,hitpoints=11225,magic=2225 at=2846,9636,0 ticks=1488 hpMin=66 eats=0 walkTicks=863 retries=1 died=false` | 1,488 | 234 (15.7%) | 66 | 0 |

Every run ends with `Congratulations! Quest complete!` and 466,250 Strength and 466,250 Defence. Planned: 1,387 /
3,699 (ESTIMATE, the `rival-dialogue-burst` patch of 1,500 / 4,000); measured 1,488-1,577.

Stages (varp `%dragonquest` 176, `quest_dragon.constant`), with run 9 MILESTONE ticks:

| # | Stage | Ticks | Evidence |
|---|---|---|---|
| 1 | Guild master: "rune plate mail body" (176 = 1) | 0-16 | `guild_master.rs2` |
| 2 | Walk to Oziach; the shield, find the dragon, pieces 1-3 (176 = 2, %dragon_shield, %dragon_oracle, %dragon_goblin, maze key) | 16-209 | `oziach.rs2` |
| 3 | Oracle on Ice Mountain: "I seek a piece of the map" (%dragon_oracle 2) | 209-328 | `oracle.rs2:15-19` |
| 4 | Ladder at 3019,3450 to the Dwarven mine; magic door (2586 at 3051,9840) takes the mind bomb, unfired bowl, lobster pot, silk; chest (2587 at 3057,9841): map piece 3 | 328-404 | `magic_door.rs2` |
| 5-9 | Falador teleport; Melzar's maze: rat (red key), ghost (orange), skeleton (yellow), zombie (blue), Melzar (magenta), lesser demon (green); chest (2603 at 2935,9657): piece 1 | 404-738 | `melzars_maze.rs2` |
| 10 | Lumbridge teleport; the Duke (level 1): anti-dragon shield | 738-800 | `duke_horacio.rs2:4-5,59-64` |
| 11 | Walk to Port Sarim; Klarense sells the ship, 2,000 coins (176 = 3) | 800-977 | `klarense.rs2:80-95` |
| 12 | Hull hole: 3 planks, 4 nails each, hammer (176 = 7) | 977-1000 | `lady_lumbridge.rs2` |
| 13 | Wormbrain in the jail: piece 2 for 10,000 coins; the three pieces join into the map | 1000-1054 | `wormbrain.rs2`, `crandor_map.rs2` |
| 14 | Ned in Draynor: hired, the map given (176 = 8) | 1054-1185 | `ned.rs2` |
| 15 | The ship's hull (level 3 with Ned): "Yep lets go!" to Crandor (176 = 9) | 1185-1299 | `dragonslayer_ned.rs2` |
| 16 | Crandor: the hole (2609 at 2833,3255) down, the gate (2607 at 2847,9636), Elvarg; quest complete on her death | 1299-1488 | `crandor.rs2`, `elvarg.rs2:1-15` |

Helper items (all tradeable): 12,000 coins, 3 planks, 12 steel nails (the content takes 4 per plank, not 30), a
hammer, the four door items, runes for one Falador and one Lumbridge teleport, 6 lobsters. The map pieces, keys and
the map are untradeable (`quest_dragon.obj`); the shield is tradeable but only the Duke gives it.

Findings:

- Oziach wanders out through his open door. The open leaf then walls him into the pocket south of the hut: in 2 of
  5 runs he stood 1 tile from the bot and every talk gave "I can't reach that!". The script shuts the door when he is
  outside and opens it when he is inside.
- Picking the dialog options: a "Click here to continue" page must not reset the chosen-options list; Oziach's
  multi4 menus repeat the shield option.
- The two chests (Oracle, maze) show the mesbox "You find a map piece" before `inv_add`, so the page is clicked
  through before the piece is in the pack.
- The Lady Lumbridge's gangplank (2593 at 3047,3205) is on map level 1 and is not in the SDK loc list from the dock;
  the click names the loc by id and tile. The ship's ladder 272 is on the deck and is not reachable from the dock.
- quest-helper zones give the blue door as 2931,9644; the map has it at 2931,9643 (`maps/m45_150.jm2 0 51 43`).
- Ned's hire and the map can go in one visit only after the repair (`give_map_to_ned` needs 176 = 7).
- Elvarg: with the shield worn her breath is at most 10 (`elvarg_max_hit`); with Protect from Melee her melee is 0.
  HP min 54-66 in the proof runs comes from the maze and Crandor before the prayer, not from Elvarg.
- The save generator keeps varps 0-308 only (`presets.ts` `generateSave`), so Monkey Madness (365) is not in the
  46 QP.

Planner: row `dragon` 1,488 / 1,577 MEASURED (base ticks and the `rival-dialogue-burst` patch; was 1,500 / 4,000 and
1,387 / 3,699 ESTIMATE). Scenario a, `research/hiscores-live.json`: Overall finish 40,212 floor / 45,105 realistic
before and after (the row runs after the last 99, so it moves the quest rows after it, not the Overall finish; the
39,360 / 46,019 at the start of this work changed because of other rows edited by other sessions). `bun test
packages/planner`: 42 pass.

Still open: the walk to the Champions' Guild is not counted; the route uses the Lumbridge teleport for the Duke
(about 175 tiles from Lumbridge to Port Sarim).

## 1j. Measured: Merlin's Crystal (the `merlin` row)

Script `scripts/generated/quest-merlin.ts`, preset `quest_merlin` (`presets-dragon.ts`, beside King Arthur; every
skill 99, Dragon Slayer done; helper items bucket of wax, bat bones, bread, tinderbox, 500 coins, runes for two
Falador, one Varrock and one Camelot teleport, 6 lobsters). Debug presets `quest_merlin_s3` ... `_s8`
(`MC_FROM=<milestone>`). Practice server, one bot at a time.

3/3 PASS (MEASURED practice, 2026-10-23):

| Run | RESULT line (cut) | Ticks | LEDGER idle | HP min |
|---|---|---|---|---|
| 1 | `RESULT ok qp=6 excalibur=true questMsg=true xp=attack=7700,hitpoints=2552,magic=4662 at=2763,3512,0 ticks=886 hpMin=99 eats=0 walkTicks=448 retries=1 died=false` | 886 | 95 (10.7%) | 99 |
| 2 | `RESULT ok qp=6 excalibur=true questMsg=true xp=attack=3900,hitpoints=1295,magic=4662 at=2766,3512,0 ticks=868 hpMin=99 eats=0 walkTicks=446 retries=1 died=false` | 868 | 91 (10.4%) | 99 |
| 3 | `RESULT ok qp=6 excalibur=true questMsg=true xp=attack=7600,hitpoints=2517,magic=4662 at=2766,3514,0 ticks=897 hpMin=99 eats=0 walkTicks=444 retries=2 died=false` | 897 | 102 (11.3%) | 99 |

Every run ends with `Congratulations! Quest complete!` and Excalibur in the pack. Planned: 555 / 1,387 (ESTIMATE);
measured 868-897. Run 2 MILESTONE ticks: 1 Arthur 20; 2 Gawain 43; 3 Lancelot 104; 4 Morgan 265; 5 candle 369;
6 Excalibur 564; 7 chaos altar 718; 8 Thrantax 778; 9 crystal and Arthur 868.

Findings:

- The Lady of the Lake's name is "The Lady of the Lake"; Lancelot's room on level 1 has the double doors at
  2761-2762,3505 (`maps/m43_54.jm2 1 9 49`); Keep Le Faye has double doors at 2776,3400-3401 between the jetty and
  the stairs (`maps/m43_53.jm2 0 24 8`); the crystal tower door is at 2766,3495.
- The keep crate (64 at 2779,3401) is on map level 1 of the jetty, which is walked as level 0: the bot lands at
  2778,3401,0 and clicks the crate by id and tile from there (like the Lady Lumbridge gangplank in 1i).
- Lancelot's line is "They get all their deliveries by boat from Catherby."
- The chaos altar's op 2 is "Check".
- No damage in any run: Mordred and the renegade knights are melee, and Protect from Melee is on in the keep and at
  the Wilderness altar.

Planner: row `merlin` 868 / 897 MEASURED (base and `rival-dialogue-burst` patch; was 600 / 1,500 and 555 / 1,387
ESTIMATE). Scenario a Overall finish 40,212 floor / 45,105 realistic, unchanged (the row runs after the last 99).
`bun test packages/planner`: 42 pass.

| # | Stage (varp `%arthur` 14; bits in varp 15) | Where | Evidence |
|---|---|---|---|
| 1 | King Arthur: "Knight of the Round Table" | 2764,3515 | `king_arthur.rs2` firstmeet |
| 2 | Sir Gawain: "how Merlin got trapped" | 2763,3506 | `sir_gawain.rs2` case 4 |
| 3 | Sir Lancelot (level 1, wooden stairs at 2750,3510): "into Morgan Le Faye's stronghold" | 2759,3515,1 | `sir_lancelot.rs2` case 4 |
| 4 | Catherby crate (63 at 2801,3442, op 2, "Yes.") to Keep Le Faye 2778,3401; stairs 2769,3404 and 2769,3398 to level 2; Sir Mordred (247); Morgan: "Tell me how to untrap Merlin", "OK I will go do all that." | 2769,3403,2 | `quest_arthur.rs2:2-35`, `sir_mordred.rs2` |
| 5 | Keep crate (64 at 2779,3401,1) back to Catherby; candle maker: "black candles" (bit 1), then the bucket of wax for the unlit black candle; tinderbox lights it | 2800,3439 | `candle_maker.rs2`, `light_source.rs2` |
| 6 | Lady of the Lake: "I seek the sword Excalibur" (bit 2); jeweller's door (59 at 3016,3246) spawns the beggar; "Yes certainly." and bread: Excalibur | 2924,3405; 3016,3246 | `lady_of_the_lake.rs2`, `beggar.rs2` |
| 7 | Chaos altar (thrantaxaltar 61, the only one, at 3239,3608 in the Wilderness), op 2: the words (bit 0) | 3239,3608 | `quest_arthur.rs2:142-148`, `maps/m50_56.jm2 0 39 24` |
| 8 | Bat bones dropped within 1 tile of the magic symbol with the lit black candle; Thrantax; "Snarthon Candtrick Termanto" (%arthur 5) | 2780,3515 | `quest_arthur.rs2:150-206` |
| 9 | Tower ladders 2769,3493 and 2767,3491; Excalibur on the crystal (62 at 2767,3493,2) (%arthur 6); King Arthur queues the completion, 6 QP | 2767,3493,2 | `quest_arthur.rs2:239-276` |

Still open: the walk to Camelot is not counted; the route crosses the Wilderness to the only chaos altar (3239,3608).

## 1k. Measured: Holy Grail (the `grail` row)

Script `scripts/generated/quest-grail.ts`, preset `quest_grail` (`presets-dragon.ts`, beside King Arthur; every
skill 99, Merlin's Crystal done (varp 14 = 7); Excalibur and the rune scimitar in the pack, nothing worn; helper
items 100 coins, runes for three Falador and four Camelot teleports (8 law, 32 air, 4 water), 6 lobsters). Debug
presets `quest_grail_s2` ... `_s9` (`HG_FROM=<milestone>`, `HG_STOP=<milestone>`). Practice server, one bot at a
time, each run on a fresh account deleted after the run.

3/3 PASS (MEASURED practice, 2026-10-23):

| Run | RESULT line (cut) | Ticks | LEDGER idle | HP min |
|---|---|---|---|---|
| 1 | `RESULT ok qp=2 grail=true questMsg=true xp=attack=3575,defence=382500,hitpoints=4745,prayer=275000,magic=9150 at=2766,3512,0 ticks=1473 hpMin=99 eats=0 walkTicks=947 retries=8 died=false` | 1,473 | 261 (17.7%) | 99 |
| 2 | `RESULT ok qp=2 grail=true questMsg=true xp=attack=3575,defence=382500,hitpoints=4745,prayer=275000,magic=9150 at=2762,3511,0 ticks=1451 hpMin=99 eats=0 walkTicks=939 retries=8 died=false` | 1,451 | 254 (17.5%) | 99 |
| 3 | `RESULT ok qp=2 grail=true questMsg=true xp=attack=3575,defence=382500,hitpoints=4735,prayer=275000,magic=9150 at=2765,3511,0 ticks=1479 hpMin=99 eats=0 walkTicks=944 retries=8 died=false` | 1,479 | 268 (18.1%) | 99 |

Every run ends with `Congratulations! Quest complete!`, 382,500 Defence and 275,000 Prayer. Planned: 1,110 / 2,774
(ESTIMATE, the `rival-dialogue-burst` patch of 1,200 / 3,000); measured 1,451-1,479.

Stages (varp `%grail` 5, `quest_grail.constant`), with run 2 MILESTONE ticks:

| # | Stage | Ticks | Evidence |
|---|---|---|---|
| 1 | King Arthur: "Tell me of this quest.", "I'd enjoy trying that." (5 = 2) | 0-24 | `king_arthur.rs2:53-72` |
| 2 | Camelot stairs (2750,3510) to level 1; workshop door (`merlinworkshop` 24 at 2764,3503,1) spawns Merlin; "Thank you for the advice." (5 = 3) | 24-84 | `quest_grail.rs2:1-14`, `merlin.rs2:6-31` |
| 3 | Falador teleport; Port Sarim: Excalibur and the scimitar dropped (300 ticks, `drop.rs2:22`); the monk's ship; the High Priest spawns the crone, "Ok, I will go searching." (5 = 4); ship back; both picked up | 84-330 | `high_priest_of_entrana.rs2:1-13`, `grail_crone.rs2` |
| 4 | Camelot teleport; Galahad (2612,3474): "I seek an item from the realm of the Fisher King.": holy table napkin | 330-434 | `brother_galahad.rs2` |
| 5 | Falador teleport; Draynor Manor front door, stairs (`spookystairs` op "Walk-up"), spiral stairs to level 2; the whistle door (22 at 3106,3361,2) spawns two whistles at 3107,3359,2 | 434-602 | `quest_grail.rs2:28-33` |
| 6 | Camelot teleport; Captain Barnaby (30 coins) to Brimhaven; the whistle at 2742,3235; the Black Knight Titan; the fisherman's bell; the bell into the castle; two doors on level 1; the Fisher King: "You don't look too well." (5 = 8); the whistle back | 602-1010 | `black_knight_titan.rs2`, `grail_fisherman.rs2`, `fisher_king.rs2` |
| 7 | Falador teleport; the Goblin Village sacks (23 at 2960,3507, op 2) spawn Sir Percival; "Your father wishes to speak to you."; a whistle given (5 = 9) | 1010-1108 | `quest_grail.rs2:20-27`, `sir_percival.rs2` |
| 8 | Camelot teleport, Barnaby, the whistle to the restored realm (2678,4715); spiral stairs 2648,4683, ladder 2651,4684 to level 2; the Holy Grail at 2649,4684,2; the whistle back | 1108-1414 | `maps/m41_73.jm2` obj `2 25 12` |
| 9 | Camelot teleport; King Arthur queues the completion | 1414-1451 | `king_arthur.rs2:26-33` |

Findings:

- Entrana takes no weapon or armour (`monk_of_entrana.rs2` `has_entrana_restricted_items`, Excalibur is
  `weapon_slash`). The preset has nothing worn: the merlin row's rune helm, body and legs must go to a bank before
  this row (not counted). The two weapons wait on the Port Sarim dock (about 120 ticks; a drop lasts 300).
- The Titan's death check reads only the worn slot (`defeat_titan`: `inv_total(worn, excalibur)`). The rune scimitar
  does the damage (speed 4, slash 45, strength 44) with Ultimate Strength and Incredible Reflexes; Excalibur goes on
  when the Titan is at 20 HP or less (the scimitar's max hit). Titan fight: about 66 ticks with the scimitar,
  140-200 with Excalibur alone. Magic and ranged do nothing (magic and ranged defence 1000, `fisher_realm.npc`).
  Three prayers empty 99 points in about 160 ticks.
- In the dead realm the fisherman is past the Titan; the bot cannot reach him from the arrival tile.
- The bell works only with a grail maiden within 4 tiles (`opheld1,grail_bell`); the maidens wander inside the
  wall, so the script rings when one is within 3 tiles.
- The Fisher King's room on level 1 is behind door 1530 at 2766,4684 and the diagonal door 1530 at 2766,4688
  (`maps/m43_73.jm2 1 14 12`, `1 14 16`); the SDK plan does not cross the diagonal door.
- No Ardougne teleport: it needs Plague City (`teleport.rs2:22`), which is in `quests-rest`. Each Karamja trip is a
  Camelot teleport and the walk to the Ardougne docks (about 130 ticks to Barnaby).
- The realm has free whistles on the ground (`maps/m43_73.jm2` obj `0 54 38` and others), so one whistle from the
  manor is enough if the spare is picked up there.

Planner: row `grail` 1,451 / 1,479 MEASURED (base and `rival-dialogue-burst` patch; was 1,200 / 3,000 and 1,110 /
2,774 ESTIMATE). Scenario a, `research/hiscores-live.json`: Overall finish 40,212 floor / 45,105 realistic before
and after (the row runs after the last 99). Quest Points board: WIN at 102,043 / 139,537 before, 102,384 / 138,242
after. `bun test packages/planner`: 42 pass.

Still open: the walk to Camelot and the bank trip for the rune armour are not counted. Possible cuts: Galahad from
Seers' Village is still a 75-tick walk; the two Barnaby trips cost about 260 ticks; super attack and strength
potions would shorten the Titan fight.

## 1l. Shield of Arrav and Heroes' Quest: the two-account method

Shield of Arrav is MEASURED as a pair: main 234 / 235 / 237 ticks, helper part 371-400 ticks, 3/3 on practice
(`scripts/generated/quest-arrav.ts`, row `quest-arrav`; evidence and method in `research/quest-points-board.md`,
"Shield of Arrav as a pair"). Haggis joins the Black Arm Gang; the helper joins the Phoenix Gang and gets the second
certificate, so both accounts finish Shield of Arrav. The gang choice is fixed for Heroes' Quest: Haggis does the
Black Arm side and the helper does the Phoenix side.

### Heroes' Quest: what each side needs (CODE-READ, `quests/quest_hero/`)

- Start (both accounts): Achietties sets `%heroquest` 1 only when `has_hero_quest_requirements` is true: 55 QP,
  Lost City, Dragon Slayer, Merlin's Crystal, and Shield of Arrav in either gang (`quest_hero.rs2:1-7`,
  `areas_heroes_guild/scripts/achietties.rs2:39-44`). No other script sets stage 1; every later stage needs it
  (grep of `%heroquest =`). The end needs a firebird feather, a master thief armband and a cooked lava eel
  (`achietties.rs2:12-21`).
- Phoenix side: Straven at stage 1 sets 2 and names Alfonse and the word "gherkin" (`straven.rs2:152-159`);
  Alfonse "Do you sell Gherkins?" sets 3 (`area_brimhaven/scripts/alfonse_the_waiter.rs2:4-19`); the kitchen door
  (2628 at 2788,3189) needs stage >= 3 and `%phoenixgang` 10 (`locs/brimhaven_restaurant.rs2:1-6`); Charlie "I want
  to steal Scarface Pete's candlesticks." sets 4 (`npcs/charlie_the_cook.rs2:22-25`); the panel (2629 at 2787,3190)
  opens at >= 4. Grip can be attacked only by a player at stage >= 4 with `%phoenixgang` 10
  (`npcs/grip.rs2:59-65`, called from `skill_combat/scripts/npc/npc_combat.rs2:147-148` and `:234-235`). His death
  sets the killer to 5 and drops `grip_keys` for anyone (`drop tables/scripts/grip.rs2:1-10`). Straven takes a
  candlestick from a player at stage 5 and gives the armband (`straven.rs2:95-101`, `:139-149`).
- Black Arm side: Katrine at stage 1 sets 7 and gives "four leafed clover" (`katrine.rs2:120-133`); the Brimhaven
  HQ door (2626 at 2811,3170) needs `%blackarmgang` 4 (`locs/brimhaven_blackarm_hq.rs2:1-6`); Grubor "Four leaved
  clover." sets 8 (`npcs/grubor.rs2:22-29`); Trobert "I volunteer to undertake that mission!" gives the ID papers
  and sets 9 (`npcs/trobert.rs2:15-26`); Garv lets in a player at 9 who wears a black full helm, platebody and
  platelegs and has the papers, and sets 10 (`npcs/garv.rs2:39-57`, `quest_hero.rs2:21-25`); Grip takes the papers
  and sets 11 (`npcs/grip.rs2:1-17`); "So what do my duties involve?" then "Anything I can do now?" gives `misc_key`
  (`grip.rs2:38-56`); Grip's keys open the treasure door (2621 at 2764,3197) only at >= 11
  (`locs/brimhaven_scarface_mansion.rs2:61-71`); the chest (2632 at 2766,3199) gives 2 candlesticks and sets 12
  (`:79-91`); Katrine takes a candlestick at stage 12 and gives the armband (`katrine.rs2:134-144`).
- Tradeable (`quest_hero.obj`): `misc_key`, the candlesticks. Untradeable: `grip_keys`, `id_papers`, the armband,
  the feather.

So a Black Arm player cannot kill Grip, and a Phoenix player cannot open the treasure room. One account cannot
finish. Unlike Shield of Arrav, the helper must also pass the 55 QP start check.

### The pair plan (Haggis Black Arm, helper Phoenix)

The helper is a second questing account with 55 QP, Lost City, Dragon Slayer and Merlin's Crystal done, and
Shield of Arrav done in the Phoenix Gang (the certificate from the `quest-arrav` pair). Its Heroes' stages do not
cost Haggis ticks if they are done before Haggis reaches Brimhaven.

| Stage | Haggis (Black Arm) | Helper (Phoenix) |
|---|---|---|
| H0 | Achietties (Heroes' Guild, Burthorpe): start, stage 1 | Achietties: stage 1 |
| H1 | Katrine (Varrock): "Is there any way I can get the rank of master thief?", stage 7 | Straven (Phoenix HQ): stage 2 |
| H2 | Brimhaven HQ door, Grubor "Four leaved clover.", stage 8; Trobert: ID papers, stage 9 | Alfonse "Do you sell Gherkins?" (3); the kitchen, Charlie (4); the panel; wait in Mr Olbors' garden at the side door (2622 at 2781,3197) |
| H3 | Wear black full helm, platebody, platelegs (helper items); Garv, stage 10; Grip: papers (11), duties, "Anything I can do now?" (`misc_key`) | wait |
| H4 | Open the side door from the mansion, or trade `misc_key` to the helper (`oplocu` with `misc_key`, `brimhaven_scarface_mansion.rs2:45-50`) | enter; attack Grip (2774,3192) until he dies (stage 5) |
| H5 | Take `grip_keys` from the floor; the treasure door; the chest: 2 candlesticks (12); trade 1 candlestick to the helper | Straven later: the armband (optional for the helper) |
| H6 | Katrine (Varrock): "I have a candlestick now!", the armband | done |
| H7 | Firebird feather (Entrana firebird drop, `drop tables/scripts/entrana_firebird.rs2:10`; ice gloves worn to pick it up, `objs/fire_feather.rs2:1-13`); lava eel (blamish oil = harralander potion (unf) + blamish snail slime, Herblore 25, `skill_herblore/configs/brewing/brew_potion.struct:207-213`; oil on a fishing rod, `objs/oily_fishing_rod.rs2:4-14`; lava eel spot `skill_fishing/scripts/fishing_spots/lavafish.rs2`; cook it); Achietties with the three items | - |

Open points before a script: the side door rule `coordz(coord) = coordz(loc_coord)` (`brimhaven_scarface_mansion.rs2:
37-43`) compares z coordinates, so which side opens without `misc_key` must be checked in a run; Grip wanders
in a guarded house, and the pirate guards' reaction to the attack is not read; the source of the ice gloves in rev
289 is the Ice Queen's death drop (`_unpack/225/all.npc:5348-5388`), not checked. The feather, the armband, the
cooked lava eel and the blamish oil are untradeable (`quest_hero.obj`, `skill_cooking/configs/cooking_generic/
food_cooked.obj`, `skill_herblore/configs/brewing/potions.obj`), so Haggis gets each one itself; the oily fishing
rod and the ice gloves are not marked untradeable (not found in a non-unpack `.obj` file).

Cost: Haggis's Heroes' row stays ESTIMATE inside `quests-rest` (class XL). The real cost is the helper's 55 QP of
quests, which is not on Haggis's clock but is a full second questing account. Without it, Heroes' Quest (1 QP), Throne of
Miscellania (1) and Legends' Quest (4) are lost (both need Heroes'), and the total stops at 139 QP (`quest_misc/scripts/misc_journal.rs2:8-17`, `quest_legends/scripts/legends_guard.rs2:50-53`).

## 1m. Measured: Fight Arena (the `rival-fight-arena` row)

Script `scripts/generated/quest-arena.ts`, preset `quest_arena` (`packages/practice/src/presets-path.ts`, beside Lady
Servil, 2566,3197). The preset is the planner state at the row (tick 12,267, after The Grand Tree): Attack 94, Magic
99, Prayer 43, Agility 76, Strength, Defence, Thieving 1, 10 Hitpoints. Staff of fire worn; 60 blood and 300 air runes
(Fire Wave), 3 prayer potions, 4 lobsters, 20 coins. Practice server, one bot at a time.

3/3 PASS on the final script (MEASURED practice, 2026-10-24):

| Run | RESULT line (cut) | Ticks | LEDGER idle | Casts | Potions |
|---|---|---|---|---|---|
| u1 | `RESULT ok qp=2 questMsg=true casts=30 potions=1 prayerLeft=18 xp=attack=304375,hitpoints=7187,magic=36350,thieving=54375 at=2566,3197,0 ticks=628 hpMin=10 eats=0 walkTicks=189 retries=4 died=false` | 628 | 176 (27.9%) | 30 | 1 |
| u2 | `RESULT ok qp=2 questMsg=true casts=31 potions=1 prayerLeft=16 xp=attack=304375,hitpoints=7192,magic=37412,thieving=54375 at=2565,3197,0 ticks=634 hpMin=10 eats=0 walkTicks=190 retries=4 died=false` | 634 | 183 (28.7%) | 31 | 1 |
| u3 | `RESULT ok qp=2 questMsg=true casts=31 potions=1 prayerLeft=17 xp=attack=304375,hitpoints=7190,magic=37412,thieving=54375 at=2566,3198,0 ticks=637 hpMin=10 eats=0 walkTicks=190 retries=4 died=false` | 637 | 176 (27.5%) | 31 | 1 |

Every run ends with `Congratulations! Quest complete!` and the quest XP (304,375 Attack and 54,375 Thieving,
`quest_arena.rs2` arena_quest_complete: `stat_advance(attack, 121750)`, `(thieving, 21750)`). No damage (HP min 10).
Planned: 499 / 720 (the rival's ESTIMATE); measured 628-637.

Stages (CODE-READ, varp `%arenaquest` 17, `quest_arena.constant`; paths under `quests/quest_arena/scripts/`): Lady
Servil "Can I help you?" (1, `lady_servil.rs2`); the chest at 2613,3189 gives the Khazard helmet and armour (2,
`quest_arena.rs2:1-29`); the guard at 2615,3141 (`arena_guard2`) wants a drink (3, `khazard_guard.rs2:98-106`); the
barman (2566,3140) sells a Khali brew for 5 coins only at stage 3+ (`khazard_barman.rs2`); the guard drinks it and
gives the cell keys (5, `khazard_guard.rs2:110-125`); the keys on Jeremy's cell door (2617,3167) put the player in the
arena and let the ogre out (6, `jeremy_servil.rs2:57-145`); the ogre's death (8) runs Khazard's pages and the cells
(9, `general_khazard.rs2:226-270`); Hengrad (2598,3142) calls the guard, who walks the player to the scorpion
(`hengrad.rs2`); its death (10) brings Bouncer; Bouncer's death (11) and Khazard's pages set 12 (freed) and Khazard
attacks (`general_khazard.rs2:277-294`). Lady Servil at 12 queues the completion. General Khazard (stage 13) is not
needed.

Route (run u1, MILESTONE ticks): Lady Servil 0-24; chest 24-71; north door, the guard 71-127; west door, barman
127-179; back, the guard and the keys 179-247; cell door, into the arena 247-284; ogre 284-335; cells 335-346; Hengrad,
scorpion, Bouncer, Khazard's pages 346-518; arena door, north door, Lady Servil 518-628.

Findings:

- Fire Wave (Magic 75, max 20, `magic_combat_spells.dbrow:286-295`) under Protect from Melee: 9-12 casts for the
  ogre, 5-8 for the scorpion, 10-16 for Bouncer; about 110-125 ticks of fighting; 1 prayer potion, 12-18 points left.
- The door `fightarena_door1` (2617,3171 and 2585,3141) opens from its own (inside) tile with no talk
  (`door_procs.rs2:77-88` check_axis); from outside the guard lets a player in Khazard armour through. After stage 12
  a click from outside makes the guard attack (`khazard_guard_generals_pet`), so the script leaves by the north door
  and never steps back.
- walkPath takes the cell doors beside the east corridor (2617,3159, 3163, 3167, west walls) for doors on its way and
  clicks them ("The cell gate is securely locked", 79-89 idle ticks each time); `blockDoorTemporarily` did not stop
  it. The corridor is walked with client-routed clicks; south of z 3151 walkPath opens the real doors (2616,3147,
  2609,3143).
- Each cage holds a static spawn (ogre 2608,3165, scorpion 2608,3159, Bouncer 2608,3162). A cast while the NPC is
  still in its cage sent the bot into the gate for line of sight; the gate shut after 6 ticks and every later cast was
  `cant_reach` (run p1). The script casts only when the NPC's tile is west of x 2606, and an NPC already on the player
  (one left out by an earlier failed run) comes first.
- In one run of an earlier script version (r3) the scorpion stayed in its cage for 300 ticks. Jeremy's talk at stages
  9 and 10 runs the cage release again (`jeremy_servil.rs2:39-44`); the final script talks to him after 20 ticks with
  no fighter out. The 3 proof runs did not need it (not exercised).

Planner: row `rival-fight-arena` 628 / 637 MEASURED. Scenario a, `research/hiscores-live.json`:

| Model | Overall floor | Overall realistic |
|---|---|---|
| Before (499 / 720 ESTIMATE, rival) | 41,100 | 44,393 |
| Fight Arena MEASURED (628 / 637) | 41,229 | 44,310 |

Still open: the walk from Narnode to Lady Servil is not counted; the chest-to-guard legs (about 100 ticks) could use
one trip if the guard took the brew at stage 2 (it does not, `khazard_barman.rs2` needs stage 3).

## 1n. Sea Slug (the `rival-seaslug` row): NOT PROVEN, stops at the broken glass

Script `scripts/generated/quest-seaslug.ts` (not proven), preset `quest_seaslug` (beside Caroline, 2717,3302; the
planner state at tick 24,985: Attack 99, Strength 97, Defence 89, Hitpoints 97, Firemaking 99, Fishing 1; swamp
paste 1941 and an unlit torch 596 from a helper, 3 law and 3 air runes). The row stays ESTIMATE (rival 304 / 495).

Stages (CODE-READ, varp `%seaslugquest` 159, `quest_seaslug.constant`): Caroline (1, `area_ardougne_east/scripts/caroline.rs2`);
Holgart wants swamp paste (2) and takes it (3); the row boat to the platform (`holgart_ardougne.rs2:93-117, 152-167`);
Kennith shouted to across the wall upstairs (4, `area_fishing_platform/scripts/kennith.rs2`); Holgart to the island
(5, `holgart_platform.rs2:83-89`); Kent (6, `kent.rs2`); back to the platform; the dry sticks rubbed with the torch
in the pack (7, Firemaking 30, `quest_seaslug.rs2:42-63`); Kennith (8); kick the panel (9); Kennith (10); the crane
(11); Holgart to the shore; Caroline (`caroline.rs2:33-48`, 71,750 Fishing x25 = 179,375). The dry sticks come from
damp sticks (1467) and broken glass (1469), both `tradeable=no`, map spawns at 2784,3289 and at 2765,3278 / 2765,3289
(`maps/m43_51.jm2` OBJ section). The boat from Ardougne and from the island puts a lit torch out.

Test runs t1-t12 (practice, 2026-10-24): stages 1-3 pass in 71-74 ticks; the damp sticks are picked up. Both broken
glass spawns stay "I can't reach that!": a walk-up pickup, a Telekinetic Grab from the pier outside, and a walk into
either room (2765,3277 kitchen, 2765,3287 under Kennith's room) after its door (`loc_1533`, `doors/configs/doors.loc`)
is open; `bot.walkTo` reports "Stuck at (2766, 3287)" and the groundItems entries have `reachable: false`. Both rooms
are on bridged tiles (level-1 land flag 2, `engine/src/engine/GameMap.ts:230-236`), floor overlay 5 where the pier is
42 (`maps/m43_51.jm2`). The cause is not found. The rival's notes mark the quest "blocked for the bot until
cairn://p/rs/54" (scratchpad `rival/quest_points.md:57`), their 304-tick run was in a browser.

Next step: find what blocks the step from 2766,3287 to 2765,3287 on the server (dump the engine collision flags of
those tiles on the practice server, or walk a browser client in), then finish the script from stage 4 (it is written
to the end but not run past the glass).

## 1o. Scorpion Catcher (the `scorpion` row): NOT PROVEN, needs the Barcrawl

Script `scripts/generated/quest-scorpion.ts` (not proven), presets `quest_scorpion` (beside Thormac, 2702,3404,3;
every skill 99, rune set, Falador and Camelot Teleport runes) and `quest_scorpion_s2` (debug, stage 2, outside the
Barbarian Outpost, `SC_FROM=2`). The row stays ESTIMATE (277 / 832).

Stages (CODE-READ, varp `%scorpcatcher` 76): Thormac gives the cage (1, `area_seers/scripts/thormac.rs2:47-56`); a
Seer's looking glass (2, `area_seers/scripts/seer.rs2:56-68`) opens the Taverley dungeon secret wall
(`quest_scorpcatcher.rs2:45-53`, 2875,9799); the three catches have no stage check (`quest_scorpcatcher.rs2:14-39`):
A at 2877,9796 (Taverley dungeon), B at 2552,3570 (Barbarian Outpost), C at 3058,3488,1 (Monastery upstairs, the
ladder needs the order, Prayer 31, `areas/monastery/scripts/prayer_guild.rs2:5-40`); Thormac with the full cage
(463) completes (66,250 Strength x25 = 165,625, `quest_scorpcatcher.rs2:55-60`).

Test runs t1-t4 and d1 (practice, 2026-10-24): Thormac 0-25, the tower and a Seer to 139-226 ticks. Scorpion B is in
the outpost's building behind the outer gate (`barbariangater`/`barbariangatel`, east wall of 2545,3569-3570). The gate
opens only when no Barbarian guard (spawns 2544,3567 and 2544,3571) is within 5 tiles of the player; otherwise the
guard talks and the Barcrawl starts (`area_barbarian_outpost/scripts/outpost_gate.rs2:1-11`,
`barbarian_outpost_guard.rs2`). The guards stand 1-2 tiles from the gate, so the bot was talked to on every click for
700 ticks. The north side of the outpost does not lead into the courtyard (run d1). The planner's `agility-52` row
already notes that the outpost needs Alfred Grimhand's Barcrawl.

Next step: add a Barcrawl row (9 bars, `%barcrawl`, not measured) as a requirement of `scorpion`, or prove that the
guards can be drawn away from the gate; the rest of the script (Taverley dungeon, Monastery, the return) is written
and not run.

## 1p. The Dig Site (the `dig` row): not started

The row stays ESTIMATE (555 / 1,387). Content (CODE-READ, `quests/quest_itexam/scripts/`, about 2,000 lines): the
examiner's three exams (`examiner.rs2`) each need three student errands (`student1.rs2`, `student2.rs2`,
`student3.rs2`; exam 1 needs three untradeable rock samples: the workman's pickpocket, `digsite_workman.rs2:90-92`,
and two digsite searches, `area_digsite.rs2:46-90`; exam 3 needs an opal), then the expert, the permit, the winch
and the chemistry (`itexam_chemistry.rs2`) in `area_digsite.rs2`. The planner gate is Agility 10, Herblore 10,
Thieving 25 (`itexam_journal.rs2:10-22`).

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
| 2 | Tree Gnome Village | Prayer 43 + Magic 35 (combat gate, section 1e) | 6 normal logs (Commander Montai), Fire Bolt runes, staff of fire, 2 prayer potions | 286,250 Attack, 2 QP | 782-829 MEASURED practice, 3 runs (section 1f) | Khazard warlord (level 112) fight for the orb; Khazard troopers in the fortress |
| 3 | Fight Arena | none (OSRS) | Khazard armour is in the quest; food, a weapon | 304,375 Attack, 54,375 Thieving, 2 QP | 1,300 ESTIMATE | four arena fights: Khazard ogre (63), scorpion (44), Bouncer (137), General Khazard (112); needs HP above 10 or a safespot |
| 4 | Vampire Slayer | none | garlic, hammer, beer (Dr Harlow), food | 120,625 Attack, 3 QP | 500 ESTIMATE | Count Draynor (34) |
| 5 | Witch's House | none | cheese, leather gloves, food | 158,125 Hitpoints, 4 QP | 600 ESTIMATE | the experiment (4 forms) |
| 6 | 8 short quests to 32 QP: Romeo & Juliet 5, Goblin Diplomacy 5, Druidic Ritual 4, Sheep Herder 4, Black Knights' Fortress 3, Prince Ali Rescue 3, Ernest the Chicken 4, plus 4 from the quests above | none | quest items (dyes, rat meat and others), coins | 32 QP total | 300-900 each ESTIMATE (`haggis-boards.json` row) | Black Knights' Fortress guards; Ernest: none |
| 7 | Dragon Slayer | 32 QP (`%qp < 32`, CODE-READ) | anti-dragon shield (Duke Horacio), 3 map pieces, 3 planks, 90 steel nails, hammer, unfired bowl, wizard's mind bomb, lobster pot, silk, 10,000 coins for the boat | 466,250 Strength, 466,250 Defence, 2 QP | 4,000 ESTIMATE | Elvarg (83) dragonfire, Melzar's maze (lesser demon 82, zombies, ghosts), Crandor skeletons |
| 8 | Scorpion Catcher | Prayer 31 (OSRS) | scorpion cage, food | 165,625 Strength, 1 QP | 1,500 ESTIMATE | Taverley dungeon: poison spiders, black knights |
| 9 | The Grand Tree | Agility 25 (`stat(agility) < 25` gate, CODE-READ) | food | 460,000 Attack, 197,500 Agility, 53,750 Magic, 5 QP | 2,500 ESTIMATE | Black demon (172) in the mine: needs protect from melee (Prayer 43) or a safespot |
| 10 | Merlin's Crystal, Holy Grail | Holy Grail: Merlin's Crystal, Attack 20 (OSRS) | bat bones, black candle, insect repellent, bread | 382,500 Defence, 275,000 Prayer, 8 QP | 2,319-2,376 MEASURED practice together (868-897 + 1,451-1,479, sections 1j and 1k) | Sir Mordred (39), Black Knight Titan (120, needs Excalibur) |
| 11 | Dwarf Cannon | none | 2 law, 8 air, 1 water rune for two teleports | 18,750 Crafting, 1 QP; unlocks the cannon for Ranged | 888-925 MEASURED practice, 3 runs (section 1b) | goblins (low) |
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

- Quest ticks other than Waterfall and Dwarf Cannon are not measured (ESTIMATE). The 8 short quests and Witch's House have no script yet.
- Waterfall ticks are from a preset at Almera. The walk from Lumbridge to Almera and the helper trade are not in
  the count.
- OSRS requirements (Prayer 31 for Scorpion Catcher, Attack 20 for Holy Grail, Crafting 35 for Haunted Mine) are
  not checked in the rev 289 scripts; the gate grep found only the Grand Tree, Watchtower, Viking and Dragon
  Slayer gates.
- `research/quest-route.md` says the Grand Tree needs Tree Gnome Village. The rev 289 Grand Tree script gates only
  Agility 25 (CODE-READ grep). Not verified in a run.
