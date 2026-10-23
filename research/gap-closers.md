# Gap closers for Haggis's single clock (2026-10-23)

Goal: Haggis has rank 1 on all 24 boards from one run. Every skill board stamps Haggis's total playtime when the level
is reached, so all boards share one clock. Overall #1 (`stunbaron`) has all 19 skills at 99 at **35,916** ticks.

Model: `packages/planner/src/haggis.ts` and `packages/planner/src/haggis-boards.json`. To reprint every number in this
file, run:

```
bun packages/planner/src/haggis-cli.ts --order --evidence --levers
```

Paths start at `vendor/rs-sdk/server/`: `C/` is `content/scripts/` and `E/` is `engine/src/`. Evidence levels are
MEASURED, CODE-READ and ESTIMATE. A code read is not a measurement. All lever numbers are model output (ESTIMATE),
and each one takes its inputs from the rows named below.

## Result

| Overall finish (ticks) | Floor (best case) | Realistic |
|---|---|---|
| Before this work (`haggis-run.md` table a) | 40,263 (gap 4,347) | 68,214 (gap 32,298) |
| **All safe levers** | **30,580 (slack +5,336, WIN)** | 46,252 (gap 10,336) |
| Safe levers + all owner levers + all tricks | 27,709 (slack +8,207) | 44,285 (gap 8,369) |
| Safe levers + wild-iron only + all tricks (best realistic) | 28,527 (slack +7,389) | **43,703 (gap 7,787)** |

Boards that flip: **Overall flips to WIN at floor rates** with the safe levers alone. Crafting and Herblore still win at
floor rates. At realistic rates, no clock board wins yet. The 18 other skill boards stay late in both modes: their
early deadlines (38 to 7,974 ticks) are before the work that comes ahead of them on the one clock.

At realistic rates the gap fell from 32,298 to 10,336 ticks (safe), or to 7,787 with the Wilderness iron spot. The
largest realistic blocks left are Mining 6,351, Thieving 6,169, Agility 5,754, Defence top-up 3,994, Fishing 3,130,
Runecraft 2,976 and Woodcutting 2,957 (CLI `--order`, realistic).

## Levers, ranked by ticks saved on the Overall deadline

"Alone" means only that lever is on. "Last" means the saving when this lever is added after all the other safe levers.
The numbers come from the `--levers` table.

| # | Lever | Class | Saved alone, floor / realistic | Saved last, floor / realistic | Boards flipped |
|---|---|---|---|---|---|
| 1 | `combat-hp-bound` | safe (order effect) | 5,395 / 17,033 | 6,480 / 18,640 | Overall at floor (with the others: margin +5,336) |
| 2 | `wild-iron` | OWNER DECISION (Wilderness PvP risk) | 2,053 / 2,548 | 2,053 / 2,548 | none alone |
| 3 | `flinch-gather` | safe (accepted tick-manipulation class) | 1,700 / 913 | 1,700 / 913 | none alone |
| 4 | `stun-guests` | safe | 1,500 / 2,407 | 1,500 / 2,407 | none alone |
| 5 | `cannon-melee` | safe | 3 / 2 | 1,088 / 1,609 | none alone (it needs lever 1) |
| 6 | `charge-spam` | OWNER DECISION (no recast check) | 818 / 28 | 818 / -582 | none |
| - | login wine, stun relog, sacred oil (existing tricks) | OWNER DECISION | 0-1 | 0-1 | none |

### 1. `combat-hp-bound`: combat is limited by Hitpoints, so the melee quests move after Overall

- Mechanism (CODE-READ, `C/skill_combat/scripts/combat.rs2:143-167`): each damage point gives 4 x base XP to the one
  style skill and 1.33 x base XP to Hitpoints. The cannon gives no Hitpoints XP. So Hitpoints 99 needs about 30,000
  points of damage dealt by the player (997,000 / 33.25), whatever the source of Attack, Strength and Defence XP.
- The old schedule put Tree Gnome Village, The Grand Tree, the 7 short quests, Dragon Slayer, Scorpion Catcher,
  Merlin's Crystal and Holy Grail before Overall, and then ran a pure Hitpoints top-up of 4,379 ticks (floor). Those
  quests give style XP that combat makes anyway, and no Hitpoints XP.
- New route before Overall: Waterfall (687,500 Attack + Strength, kept because it is faster than combat), Dwarf Cannon,
  Witch's House on its own (158,125 Hitpoints, `C/quests/quest_ball/scripts/quest_ball.rs2:202`, 4 QP at
  `quest.constant:74`), then melee to 99 in Attack, Strength and Defence (new row `att-top`). The other quests run after
  Overall for Quest Points. (Corrected 2026-10-23: a 142nd QP does NOT win at any time; the leader has 145 of 145 at 1,022,262 ticks, so the board needs all 145 QP saved by 1,022,261. Moving these quests after Overall still fits that deadline by a wide margin, about 97,000 ticks estimated in research/quest-plan.md.)
- XP per tick (ESTIMATE, existing rows): melee 400 / 250 style XP plus 133 / 83 Hitpoints XP.
- Cost: the Grand Tree's 197,500 Agility now comes from the course (agility-52 trains from 25 at 80 / 50 XP per tick).
  Holy Grail's 275,000 Prayer comes from bones.
- Why the saving is large at realistic rates: the old realistic route spent about 25,000 ticks on quests before
  Overall (quest ticks are ESTIMATE, 600-7,200 each). This lever is a correction of the schedule more than a game
  trick. Its size depends on those unmeasured quest times.

### 2. `wild-iron` (OWNER DECISION): the 5-rock iron tile

- Mechanism: the iron floor rate of 120 XP per tick is the 3-rock respawn cap (`mine.dbrow:72`, row `mine`). The only
  tile next to 5 iron rocks is (3100,3767), in the Wilderness (`research/iron-spots.ts`). Rates are scaled by 5/3 to
  200 / 162 XP per tick (ESTIMATE).
- It is not an exploit. It is a risk decision: PvP death in the Wilderness (owner decision 3 in `haggis-run.md`).

### 3. `flinch-gather`: 2-tick woodcutting and fishing

- Mechanism (CODE-READ, `C/skill_combat/scripts/player/auto_retaliate.rs2:9-22`; method in
  `research/tick-tricks-web.md` 1.3): an NPC hit sets `%action_delay` to half the weapon speed, so a click lands a roll
  every 2 ticks. The knife method rolls every 3 ticks.
- Rows: woodcutting 2,900 / 3,400 changes to 2,071 / 2,957. Fishing 3,050 / 3,600 changes to 2,179 / 3,130 (divided
  by 1.4 floor and 1.15 realistic, ESTIMATE).
- Class: OSRS tick manipulation, which is in the accepted class (owner rule R10). It is UNVERIFIED live, and it needs 2
  aggressive NPCs with a 4-tick attack next to the tree or spot.
- Mining gets no gain: its floor rate is limited by respawn, not by the roll.

### 4. `stun-guests`: Prayer and Magic inside the pickpocket stun

- Mechanism (CODE-READ): a failed pickpocket sets only the varps `%stunned` and `%action_delay` to clock + 8, plus a
  walk trigger (`C/skill_thieving/scripts/thieving.rs2:49-51`). It is not a `p_delay`. `bury_bone.rs2` and
  `enchant.rs2` do not read either varp (grep of `%action_delay` and `%stunned` in `C/`). So the player can bury
  dragon bones (`p_delay(0)`, 2-tick cycle) or cast enchants (`p_delay(1)`, 3-tick cycle,
  `C/skill_magic/scripts/spells/enchant.rs2:53`) during each stun.
- Capacity: the live fresh run spent about 3,584 of 6,169 ticks stunned (448 stuns, MEASURED live,
  `research/live-thieving-2026-10-23.md:74`). Usable share 0.75 x 0.9 = 0.675 (eating, and one helper trade per 10
  stuns to refill bones and jewellery: ESTIMATE). This gives a capacity of 1,509 ticks at floor and 2,419 realistic.
- Prayer (1,169 / 1,300) fits in full. Magic fills the rest. The overflow runs after Thieving.
- New scheduler feature: `deadTicks` on the host and `inside` on the guest (`haggis.ts`, tests in `haggis.test.ts`).
  When the guests use more ticks than stun relog saves, the scheduler does not use stun relog. That is why the stun
  relog trick is now worth 0.

### 5. `cannon-melee`: Ranged XP from the cannon during every melee top-up

- Mechanism (CODE-READ): `[timer,cannon_rotate]` turns the cannon one direction per tick and fires at most once per tick
  (`C/quests/quest_mcannon/scripts/cannon_fire.rs2:1-91`). It gives 2 Ranged XP per damage with no Hitpoints XP (line
  119), with a max hit of 30.
- It is a normal player timer. It runs while the player melees and pauses while the player is `p_delay`'d or has a
  modal open (`E/engine/entity/Player.ts:1010`). Melee does not delay the player. In a single-way area the cannon
  passes `~player_in_combat_check` (`C/skill_combat/scripts/player/player_combat.rs2:101-116`) only for the NPC you
  fight, so use a multiway area.
- Modelled as side XP on `att-top`, `str-top` and `def-top` (0.6 Ranged per style XP) and on `hp-top` (1.8). This is
  150 Ranged XP per tick at the realistic melee rate (ESTIMATE). The same ratio is used at floor, which is conservative.
- It saves little alone, because the old route had almost no melee ticks before Overall.

### 6. `charge-spam` (OWNER DECISION)

- Mechanism (CODE-READ): the Charge spell is an `if_button` with no `p_delay` (`C/skill_magic/scripts/spells/charge.rs2:1-26`).
  The recast check is commented out with the note "added sometime in 2005" (lines 7-12).
- Each cast gives 1,800 tenths x 25 = 4,500 Magic XP and costs 3 blood, 3 fire and 3 air runes. It needs level 80
  (`C/skill_magic/configs/magic_spells.dbrow:206-212`) and Mage Arena progress (`%magearena`, line 4).
- IfButton is not refused while delayed, and user events are capped at 5 per tick
  (`E/network/game/client/ClientGameProtCategory.ts:5-8`). So the cap is 22,500 XP per tick (floor) or 4,500 with 1
  cast per tick (realistic).
- Modelled as enchants to 80, then the Mage Arena (400 / 1,200 ticks, ESTIMATE, Wilderness), then Charge to 99.
- At realistic rates the Mage Arena costs more than the lever saves (-582). About 2,100 blood runes are needed.
- It is marked OWNER DECISION because the 2004 rule (no recast check) plus the 5-per-tick button rate makes this an
  XP source that no 2004 player used. Owner: decide whether it is in the accepted class.

## Searched and not found (CODE-READ)

- **No XP lands while logged out.** Only two login and logout triggers exist (`C/login_logout/login.rs2:1`,
  `logout.rs2:1`).
  - The only XP on the login path is `~ferment_wines_login` (`login.rs2:70`). It pays 20 ticks after login, while the
    player is online. It is already ruled an exploit (`bug-report-wine-login.md`).
  - `cleanup()` clears all queues and timers at logout (`E/engine/entity/Player.ts:509-513`), and `save()` stores none
    of them.
  - Playtime counts once per tick in `processClientsIn` (`E/engine/World.ts:692`). The login tick is not counted. The
    logout tick is counted.
- **No other dual-XP action** except superheat (Magic + Smithing, already a variant row) and combat (style +
  Hitpoints).
  - No barbarian fishing, combination runes, ectofuntus or bone-on-altar exists in this revision.
  - Knife on log gives Fletching XP (`C/skill_fletching/scripts/cut_logs.rs2`), but Fletching is done first anyway.
- **Item and spell actions cancel melee.** OpHeld, OpHeldU and OpHeldT call `clearPendingAction`
  (`E/network/game/client/handler/OpHeldHandler.ts:55`, `OpHeldUHandler.ts:86`, `OpHeldTHandler.ts:57`). So the player cannot enchant or bury between melee swings without losing the interaction. Auto-retaliate
  re-targets the NPC on its next hit (`auto_retaliate.rs2:1-26`). This is a possible small lever, not modelled.
- **Mining**: no granite or sandstone. Iron (`mining_rock_fast`) rolls every 3 ticks with a rune pickaxe. The respawn
  of 20 ticks, scaled by player count, is the limit.

## Contradictions

| Claim A | Claim B | What settles it |
|---|---|---|
| "Rank 1 on all 24 boards at once is not possible"; Overall late by at least 3,788 at floor (`research/haggis-run.md:9-16`) | Overall wins at floor by +5,336 with safe levers (this file, CLI `--levers`). The old floor schedule did melee quests before Overall that make no Hitpoints XP | Time Waterfall, Witch's House, Dwarf Cannon and the Dig Site, and measure melee damage per tick (measurements 1 and 4) |
| Ranged row: side Hitpoints 0.2 per Ranged XP (`haggis-boards.json`, row `ranged`) | Own ranged shots give 1.33 Hitpoints per 4 Ranged (0.33); the cannon gives 0 (`combat.rs2:143-167`, `cannon_fire.rs2:119`). The 0.2 mixes the two at an unmeasured split | Measure the cannon Ranged XP per tick (measurement 2) |

## The 5 measurements that matter most next

1. **Melee damage per tick and Hitpoints XP per tick** at one multiway spot, from a fresh account, 300 ticks, 3 runs.
   Combat is Hitpoints-bound, and floor 133 vs realistic 83 HP XP per tick is the largest single spread on the clock.
   It is worth about 4,000 ticks on the realistic Overall.
2. **Cannon Ranged XP per tick while meleeing** at the same spot, 3 runs. This gives the side ratio (0.6 / 1.8 now).
   If the cannon gives at least 158 XP per tick at floor, the whole Ranged row folds into melee.
3. **Usable stun ticks**: run the knight ladder and bury dragon bones and cast enchants inside each stun, 3 runs.
   Record the Prayer and Magic XP per stun and the refill trades. This sets `deadTicks` (1,509 / 2,419 now).
4. **Durations of the quests before Overall**: Waterfall, Witch's House, Dwarf Cannon, The Dig Site, each from a
   prepared test account (not Haggis), 3 runs each. These are 2,100-4,800 ESTIMATE ticks on the clock.
5. **Flinch 2-tick rate** for woodcutting and fishing in practice, 3 runs each. Use 2 aggressive 4-tick NPCs and a
   rapid shortbow with no ammo. This sets the 1.4 / 1.15 factors (1,700 / 913 ticks).
