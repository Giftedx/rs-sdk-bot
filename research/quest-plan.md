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
| `rival-mm` | prayer 43 | jungle demon 170 attack, strength, magic, 170 HP; waves with max hit 31, 0 under Protect from Magic (Prayer 37) (`quest_mm/scripts/mm_demon.rs2:349-353`); melee only within 2 tiles (`mm_demon.rs2:332-336`). Ape Atoll guards and the damage source are not read |
| `crest` | magic 59, prayer 43 | Chronozon: attack 173, strength 172, slash (`quest_crest/configs/quest_crest.npc:45-52`); the MEASURED proof ran at Hitpoints 97, not under the prayer |
| `merlin` | prayer 43 | Sir Mordred: 33/33, 38 HP, slash, max hit 4 (`quest_arthur/configs/keep_le_faye.npc:77-87`) |
| `grail` | attack 20, prayer 43 | Black Knight Titan: 91/100, 142 HP, crush, max hit 11 (`quest_grail/configs/fisher_realm.npc:293-308`) |
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
| 10 | Merlin's Crystal, Holy Grail | Holy Grail: Merlin's Crystal, Attack 20 (OSRS) | bat bones, black candle, insect repellent, bread | 382,500 Defence, 275,000 Prayer, 8 QP | 4,000 ESTIMATE together | Sir Mordred (39), Black Knight Titan (120, needs Excalibur) |
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
