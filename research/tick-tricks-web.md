# Tick tricks and speed methods: web catalog checked against rev 289 (2026-10-23)

Scope: known tick-manipulation and speedrun methods per skill (mostly Old School RuneScape sources), each checked
against this server's content (`vendor/rs-sdk/server/content/scripts`, abbreviated `c/`) and engine
(`vendor/rs-sdk/server/engine/src`, abbreviated `e/`). Companion files: `research/tricks-plan.md` (measured
tricks), `research/pro-playbook.md`, `research/quest-xp.md`, `research/runecraft-ladder.md`.

Status words:
- **measured**: measured on this server (from `research/tricks-plan.md`; not re-run for this file).
- **code**: read in this server's code; not measured. A code read is not proof that the trick works live.
- **no**: the code shows that the trick does not work here.
- **UNVERIFIED**: I could not check it in code or in a fetched source.

All XP figures are base XP (before the 25x server rate) unless the row says x25.
`stat_advance` takes tenths of XP (`stat_advance(agility, 4989)` = 498.9 XP).

## 0. Engine rules that decide every trick

| Rule | Evidence | Effect for bots |
|---|---|---|
| `p_delay(n)` sets `delayedUntil = tick + 1 + n` | `e/engine/script/handlers/PlayerOps.ts:376-379` | |
| Client input is decoded **before** the delay flag is cleared in the same tick | `e/engine/World.ts:402` (`processClientsIn`) runs before `:425` (`processPlayers`); the flag clears at `:776` | An action with `p_delay(n)` accepts the next input **n + 2 ticks** later. Input sent earlier is dropped |
| A delayed player cannot use items, locs, NPCs or objs | `e/network/game/client/handler/OpHeldUHandler.ts:16-17`, same check in `OpLocHandler.ts:14`, `OpNpcHandler.ts:16`, `OpObjHandler.ts:14`, `InvButtonHandler.ts:15` | Send the next input on the exact tick. Retries during the delay are wasted |
| Item-on-item runs its script at once, during input decode | `OpHeldUHandler.ts:117-118` (`player.executeScript` in the handler) | Instant actions placed **before** a delaying action in the same tick still run (see 9.3) |
| Gathering, firemaking, flinch and some crafting share one variable, `%action_delay` | `c/skill_mining/scripts/mining.rs2:76`, `c/skill_woodcutting/scripts/woodcut.rs2:55`, `c/skill_firemaking/scripts/firemaking.rs2:54`, `c/skill_combat/scripts/player/auto_retaliate.rs2:9-22`, `c/skill_fletching/scripts/cut_logs.rs2:83-84` | Any action that writes `%action_delay` can time another skill's roll |

Cycle lengths that follow from rule 2: bury bones `p_delay(0)` = 2 ticks; low alch, superheat and enchant
`p_delay(1)` = 3 ticks; high alch `p_delay(3)` = 5 ticks. These match the OSRS cast times (for example, Lvl-5
Enchant is 3 ticks, https://oldschool.runescape.wiki/w/Enchant_Level_5_Jewellery). That supports the reading.

---

## 1. Gathering: woodcutting, fishing, mining

Web source for all OSRS gathering tricks: https://oldschool.runescape.wiki/w/Tick_manipulation (fetched). It lists:
3-tick fishing and woodcutting (herb + tar, knife + teak, or eating food sets the skilling timer to 3), 3-tick mining,
2-tick harpoon with two rats and a 2-tick weapon on auto-retaliate, 2-tick teaks on Ape Atoll with birds, 1.5-tick
teaks, and 1-tick trap resets.

### 1.1 How the roll works here

Every gathering "attempt" label has the same shape:

```
if (%action_delay < map_clock) { %action_delay = map_clock + rate; re-op; return; }   // start
... (some spots: special branches for map_clock + 3 / + 4 / + 2)
if (%action_delay = map_clock) { roll }                                               // roll due now
```

Mining: `c/skill_mining/scripts/mining.rs2:76-86` (attempt), `:118-124` (loop). Woodcutting:
`c/skill_woodcutting/scripts/woodcut.rs2:55-59, 97, 153-154`. The setter only writes when `%action_delay < map_clock`.
A click on the tick where `%action_delay = map_clock` rolls at once.

Two setters write a short delay from outside the skill:
- Knife on log + "Make 1": `%action_delay = map_clock + 2` if it is in the past (`c/skill_fletching/scripts/cut_logs.rs2:83-86`).
  The log is used only when the weak queue fires 2 ticks later. Any loc or NPC click cancels the queue. **measured**: woodcutting +29%, fly fishing about +29%.
- Auto-retaliate flinch: when an NPC hits you and `%action_delay < map_clock`,
  `%action_delay = map_clock + attackrate / 2`, minus 1 on the ranged "rapid" style
  (`c/skill_combat/scripts/player/auto_retaliate.rs2:9-22`). Shortbow attackrate is the default 4
  (`c/skill_combat/configs/combat.param:76-78`; `bows.obj:30-57` has no attackrate param). Rapid shortbow gives
  **+1**. Unarmed gives +2. Longbow (attackrate 6, `bows.obj:23`) gives +3, or +2 on rapid.

### 1.2 Fishing spots: which entry branch they have

| Spot (label) | Normal roll period | Branches in attempt | Knife same-tick click works? | Knife, then click 2 ticks later |
|---|---|---|---|---|
| Fly / bait rod, trout-salmon-pike (`freshfish.rs2:37-50, 102-115`) | 5 | +4, +3, **+2**, else continue | **measured** +29% | not needed |
| Waterfall (`waterfall.rs2:25, 83`) | 5 | has a **+2** branch | code: yes | not needed |
| Net / bait sea, shrimp-sardine (`saltfish.rs2:37-49, 101-117`) | 5-6 | +4/+3, **= clock -> roll** | **no** (`research/tricks-plan.md`) | **code: should roll** (UNVERIFIED live) |
| Lobster cage (`rarefish.rs2:60-73`) | 5 | +3, **= clock -> roll** | no | **code: should roll** |
| Harpoon tuna/swordfish (`rarefish.rs2:164-177`) | 6 | +4, **= clock -> roll** | no | **code: should roll** |
| Shark harpoon, big net (`memberfish.rs2:30-43, 102-113`) | 6 / 5 | +4 or +3, **= clock -> roll** | no | **code: should roll** |
| Karambwan / karambwanji (`tbwt.rs2:41-51, 83-85`) | 5-6 | +3, **= clock -> roll** | no | **code: should roll** |

**New method (code, UNVERIFIED live): "delayed-click 3-tick" for every spot type.**
- Tick T: knife on log, "Make 1" (2 inputs). This sets `%action_delay = T+2`.
- Tick T+1: free. Drop a fish here (instant).
- Tick T+2: click the spot (opnpc1 or opnpc3). The attempt label sees `%action_delay = map_clock` and rolls.
  It does not re-queue, so the bot owns the next click.
- Tick T+3: knife on log again (`%action_delay = T+2 < T+3`, so it sets T+5). The cycle is 3 ticks.

The earlier test failed because the click came in the same tick as the knife. The roll branch needs the click
**on** the due tick. Lobster, swordfish and shark go from a 5-6 tick period to 3 ticks (+67% to +100% rolls).

### 1.3 2-tick gathering with flinch (code, UNVERIFIED live)

This is the OSRS "2-tick harpoon" and "2-tick teaks" method (Tick_manipulation page). Here it has this form:
- Wield a shortbow with no arrows. Set the Rapid style. Turn auto-retaliate on.
- Two aggressive NPCs with a 4-tick attack speed must hit you on alternate ticks (one hit every 2 ticks).
- On hit tick H, the flinch sets `%action_delay = H+1` (only if `%action_delay < H`).
- Tick H+1: click the rock, tree or fishing spot. Roll.
- Tick H+2: the second NPC hits. `%action_delay = H+1 < H+2`, so it sets H+3. Click at H+3. Roll.
- Result: one roll every 2 ticks on any spot with a `= clock` branch. That is 1.5x the knife method and 2-3x normal.
- Mining note: a successful roll runs `p_delay(0)` (`mining.rs2:157`), so input on the next tick is dropped. Flinch
  is set by the NPC hit queue, not by input, so the next H+1 click still lands 2 ticks later. With the knife,
  a success costs 4 ticks, not 3.
- Risks: HP loss (eat karambwan; it has no skill delay, per `research/tricks-plan.md`). The retaliate script also
  issues `p_opnpc(2)` (attack), and the bot's click must replace it. `busy2` must be false: no open modal.
- Where this is worth the most: Lava Maze runite (Wilderness; the roll rate is the limit), Fishing and Woodcutting boards.

### 1.4 Mining specifics

| Item | Evidence | Status |
|---|---|---|
| Pickaxe rates: bronze 7, iron 6, steel 5, mithril 4, adamant 3, rune 2 | `c/skill_mining/configs/pickaxes.obj:25,60,93,163,128,198` | code |
| Rune pick already rolls every 3 ticks on fails. The knife adds nothing; flinch gives 2 | mining.rs2:118-124 | code |
| Adamant: knife gives 3 ticks on a fail, 4 on a success (`p_delay(0)` after a success, `:157`), against 4/5 normal | | code |
| Runite rock: level 85, 125 XP, success roll `stat_random(1, 18)`, respawn 2,400 ticks scaled by player count | `c/skill_mining/configs/mine.dbrow:157-160`; `c/general/scripts/player_count.rs2:1-4` (`respawn x (4000 - players) / 4000`) | code |
| The Lava Maze hiscore hook | `mining.rs2:172` `runite_mined(loc_coord)` | code |
| OSRS 1.5-tick and 4-tick granite methods | need the OSRS movement-tick interaction. The roll here only fires on `= clock` | UNVERIFIED (probably no) |

### 1.5 Woodcutting

| Item | Evidence | Status |
|---|---|---|
| Knife 3-tick | `research/tricks-plan.md` | **measured** +29% |
| Flinch 2-tick (Ape Atoll birds in OSRS) | same flinch code. Needs 2 aggressive NPCs near the trees | code, UNVERIFIED |
| 1.5-tick teaks | OSRS Fossil Island farm trees; no such trees in 2004 | no |

---

## 2. Cooking

| Technique | OSRS source | Rev 289 | Status |
|---|---|---|---|
| 1-tick karambwan | Tick_manipulation page; karambwan cooking released 14 Sep 2004 (https://oldschool.runescape.wiki/w/Karambwan) | Karambwan goes through the same `cook_item` label with `p_delay(1)` (`c/skill_cooking/scripts/cooking.rs2:36-49, 172`) | **no** |
| Normal cooking speed | OSRS 4 ticks | One item per use-on-range; `p_delay(1)` gives 3 ticks per item (rule 2). No Make-X loop in `cook_item` | code: 3 ticks per item |
| 2-tick "one raw food" OSRS method | Tick_manipulation page | The delay comes from `p_delay`, not from a skill timer. You cannot shorten it | no |
| Wine by hand (grapes on jug of water) | standard | Instant, no delay: 5 per tick (`c/skill_cooking/scripts/cooking_inv/scripts/wine/wine.rs2:6-20`). XP comes when the `fermenting_wine` timer fires 20 ticks later. It ferments every unfermented wine in the inventory **and the bank** (`:21-70`), 110 XP each (`stat_advance(cooking, 1100)`). Needs Cooking 35 | code |
| Login wine (no level check) | — | `wine.rs2:72-73`, see `research/bug-report-wine-login.md` | measured locally. **Owner decision; not used** |

Legal hand-made wine at Cooking 35+: 14 grapes + 14 jugs per inventory, 3 ticks to make, then bank. About
363 wines to 99 at x25 (998,458 / 2,750; see the XP curve in section 16). UNVERIFIED tick count per bank loop.

## 3. Fletching

| Technique | Rev 289 evidence | Ticks/action | Status |
|---|---|---|---|
| String bows, arrows (15 per action), headless arrows, darts, bolts | `c/skill_fletching/scripts/bows.rs2`, `arrows.rs2:46,85`, `darts.rs2`, `bolts.rs2:36`: no `p_delay`, no queue | 0 (5 per tick) | code (see `research/tricks-plan.md`) |
| Cut logs with a knife | `cut_logs.rs2:83-104`: weak queue every 2 ticks | 2 | code |
| OSRS "1-tick fletching" | not needed: stringing is already instant | | — |

## 4. Smithing

| Technique | Evidence | XP per tick (base) | Status |
|---|---|---|---|
| Anvil: 5 ticks per item, any item | `c/skill_smithing/scripts/smithing/smithing.rs2:272` `p_delay(1)` + `:286` `p_delay(2)`. XP = bars x XP per bar | rune platebody 375/5 = **75**; adamant plate 62.5; mithril plate 50; steel plate 37.5 | code |
| Always smith 5-bar items (platebodies) | same 5 ticks for 1 or 5 bars | 5x the XP of a 1-bar item | code |
| Furnace: about 4 ticks per bar (Make-X loop) | `smelting.rs2:157-164, 184-188, 205-227` | iron 50% failure without ring of forging (`:201-209`) | code |
| Goldsmith gauntlets: gold bar 2.5x XP | `smelting.rs2:216`; superheat `superheat.rs2:57`. Gauntlets come from Family Crest (`quests/quest_crest`) | gold 56.2 XP per bar | code |
| Superheat gold with gauntlets | `superheat.rs2:55-67`: 53 Magic + 56.2 Smithing, `p_delay(1)` = 3 ticks | 17.7 Magic + 18.7 Smithing per tick | code. Two boards at once |
| Cannonballs | `cannonballs.rs2:29-34`: about 8 ticks | low | code |
| OSRS tick tricks | none apply: every delay is `p_delay` | | no |

## 5. Crafting

| Technique | Evidence | Ticks | XP | Status |
|---|---|---|---|---|
| Battlestaves (orb on staff) | `c/skill_crafting/scripts/battlestaves/battlestaves.rs2:15-38`: no delay | 0 (5 per tick) | air 137.5 (66), fire 125 (62), earth 112.5 (58), water 100 (54) (`configs/battlestaves/*.struct`) | code |
| Gem cutting | `gem/uncut_gem.rs2:14-63`: no delay. Gems can smash on a failed roll (`:52-58`, only gems that have a success_rate) | 0 | dragonstone 137.5, diamond 107.5 (`configs/gem/*.dbrow`) | code |
| Studded leather, snelms, stringing amulets | `studded.rs2:41-56`, `snelm.rs2:15`, `stringing.rs2:71`: no delay | 0 | | code |
| Leather (needle), glassblowing, pottery | weak queue +2 (`leather.rs2:139-142`, `glass.rs2:87-90`, `pottery.rs2:83-86`) | 2 | | code |
| Gold jewellery, silver, spinning | `jewellery.rs2:220, 271, 324`; `spinning.rs2:87-98` | 3-4 | | code |

Fastest Crafting here: battlestaves or gems at 5 per tick. Supply is the limit. Air orbs need Charge Air Orb
(`c/skill_magic/scripts/spells/charge_orb.rs2`, `p_delay(2)` = 4 ticks, 76 Magic XP), so helpers must make the orbs.

## 6. Firemaking

| Item | Evidence | Status |
|---|---|---|
| First log: roll 3 ticks after the first attempt. After a success or a failure, the next roll is 4 ticks later | `c/skill_firemaking/scripts/firemaking.rs2:54-75, 98-116` | code: **4 ticks per log** at best |
| Success roll `stat_random(64, 512)`: about 25% at level 1, 100% at about 43 | `firemaking.rs2:61,105`; the OSRS wiki gives 65/256 at 1 and 256/256 at 43 (https://oldschool.runescape.wiki/w/Firemaking) | code + web agree |
| Line-up: the player is pushed west, then east, south, north | `firemaking.rs2:145-174`; the same order is on the OSRS wiki page | code |
| Knife-on-log before the first light | sets `%action_delay = T+2`, so the first roll comes 1 tick sooner. Saves 1 tick per line, not per log | code (small) |
| Tick tricks below 4 ticks | the success branch always sets +4 | **no** |

## 7. Herblore

| Item | Evidence | Status |
|---|---|---|
| Unfinished and finished potions, grinding, identify: no delay | `c/skill_herblore/scripts/brewing/brew_potion.rs2`, `grinding/grind_ingredient.rs2`, `identifying/identify.rs2` (no `p_delay` or queue; grep result) | code: 5 per tick |
| OSRS tick-manipulation tar | swamp tar did not exist in 2004; the knife gives the same 2-tick timer | not needed |

## 8. Agility

Courses and XP sources in rev 289: gnome, barbarian, wilderness (`c/skill_agility/scripts/*_course.rs2`), shortcuts
(`shortcuts.rs2`), Brimhaven Agility Arena (`c/minigames/game_agilityarena`), Yanille and Karamja dungeons, gnomeball,
and quests. There is **no** Ape Atoll, Werewolf or Agility Pyramid course (no scripts found).

| Course | Lap XP here (code) | Lap ticks | x25 XP per tick | Status |
|---|---|---|---|---|
| Gnome Stronghold | obstacles + 39.0 bonus (`gnome_course.rs2:95,108`) | UNVERIFIED (about 50) | about 40 | code (XP) |
| Barbarian Outpost (35) | 20+12.5+20+12.5+10 + 42 bonus (`barbarian_course.rs2:30-154`) | UNVERIFIED | | code (XP) |
| Wilderness (52) | 15+15+12.5+20+20+20 + 498.9 bonus = **601.4** (`wilderness_course.rs2:17-176`) | 67 theoretical (OSRS wiki, https://oldschool.runescape.wiki/w/Wilderness_Agility_Course) | **about 224** | code (XP) + web (ticks) |
| Agility Arena tickets | flat XP per ticket, **not level-scaled**: 1 ticket 240 XP, 10 for 2,480, 25 for 6,500, 100 for 28,000, 1,000 for 320,000 (`agilityarena_tickettrader.rs2:38-67`) | one ticket per pillar move; the pillar moves every **98 ticks** (`agilityarena_clerk.rs2:79-85`) | about 61-82 + obstacle XP | code. Tickets are `tradeable=no` (`configs/agilityarena.obj:15`): helpers cannot farm them |
| Gnomeball win | 30 Agility + 30 Ranged per 5-goal win (`gnomeball_shoot.rs2:40-46`) | UNVERIFIED | low | code |

Use: quests give Agility 93 (`research/quest-xp.md`). Then the Wilderness course to 99, which is about 4x the gnome
course per tick. PvP and failure risk are UNVERIFIED on the demo server. Arena tickets help only at the lowest levels
(1 ticket = 6,000 XP at x25 at any level): they meet the Grand Tree Agility 25 requirement with 2 tickets.

## 9. Magic

### 9.1 Cycle times (rule 2)

| Spell | Delay | Ticks | Base XP (`c/skill_magic/configs/magic_spells.dbrow`) | XP per tick |
|---|---|---|---|---|
| Lvl-5 enchant (68) | `enchant.rs2:53` `p_delay(1)` | 3 | 78 | **26.0** |
| Lvl-4 enchant (57) | same | 3 | 67 | 22.3 |
| Lvl-3 enchant (49) | same | 3 | 59 | 19.7 |
| Lvl-2 enchant (27) | same | 3 | 37 | 12.3 |
| Superheat (43) | `superheat.rs2:67` `p_delay(1)` | 3 | 53 (+ Smithing) | 17.7 (+18.7 Smithing with gold + gauntlets) |
| Watchtower / Trollheim teleport (58/61) | `teleport.rs2:61,65` `p_delay(1)` + `p_delay(0)` | 4 (UNVERIFIED: post-teleport checks) | 68 | 17.0 |
| Camelot teleport (45) | same | 4 | 55.5 | 13.9 |
| High alch (55) | `alchemy.rs2:37` `p_delay(3)` | 5 | 65 | 13.0 |
| Low alch (21) | `alchemy.rs2:69` `p_delay(1)` | 3 | 31 | 10.3 |
| Charge air orb (66) | `charge_orb.rs2:44` `p_delay(2)` | 4 | 76 | 19.0 (needs the obelisk) |
| Telegrab | `telegrab.rs2:70,77` | about 6 | 43 | low |

Finding: enchanting is the fastest non-combat Magic here, 2x the rate of high alch. The OSRS rates are the same
(Lvl-5 Enchant is 3 ticks, about 2,000 casts per hour; https://oldschool.runescape.wiki/w/Enchant_Level_5_Jewellery).
Supply: cut gems + gold bars to make jewellery (Crafting), so a helper team can feed both boards.
XP is given **before** the delay (`alchemy.rs2:23`, `enchant.rs2:43`), on the cast tick.

### 9.2 Inputs per tick for an enchant loop
- Tick T: open nothing; send `opheldt` (spell on item) for the next item. 1 input.
- Ticks T+1 and T+2: input is dropped (delayed). Send nothing.
- Tick T+3: the next cast.

### 9.3 Instant actions before a delayed action, in the same tick (code, UNVERIFIED live)
The handlers check `player.delayed` per packet (rule 3), and item-on-item scripts run during decode (rule 4). So in the
tick a cast becomes possible, the bot can send up to 4 instant actions (for example, string 4 bows) and then the cast
as the 5th input. This trains Fletching or Crafting and Magic in the same ticks. It costs 16 instant actions of
throughput per 3-tick cycle, so it pays only when the main account must train both boards anyway.

## 10. Prayer

| Technique | Rev 289 | Status |
|---|---|---|
| Bones on an altar (gilded altar, POH) | POH came in 2006. The only altar script restores points (`c/skill_prayer/scripts/altar.rs2:1-20`) | **no** |
| Ectofuntus | no `ectofuntus` script; Ghosts Ahoy is not in `c/quests/` | **no** |
| Bury bones | `bury_bone.rs2:10-15`: `p_delay(0)`, so 2 ticks per bone. Dragon bones 72 XP (`configs/bones.obj:82`) | code: 36 XP per tick (900 at x25) |
| Prayer flicking | 5-tick drain timer, cleared when all prayers are off (`skill_prayer/scripts/prayer.rs2:30-43,163`) | code (`research/tricks-plan.md`) |
| Quest XP | Holy Grail and other quests (`research/quest-xp.md`) | code |

## 11. Runecraft

| Technique | Rev 289 | Status |
|---|---|---|
| Essence pouches, Abyss | no `pouch` items in `c/skill_runecraft`. The pouch hits are quest items only | **no** |
| Best altar per pack | XP = essence x altar XP; the same cycle at every altar (`research/runecraft-ladder.md`; `c/skill_runecraft/scripts/runecraft.rs2:48-100`) | code + measured cycle 19 ticks |
| Helper trades essence at the altar | `research/runecraft-ladder.md` | plan |

## 12. Combat (Attack, Strength, Defence, Hitpoints, Ranged, Magic)

| Technique | Evidence | Status |
|---|---|---|
| 4 XP per damage in the chosen style + 1.33 Hitpoints. No NPC gives a **bonus** multiplier: every `combat_xp_multiplier` in content is below 1000 (random-event NPCs 25, two quest NPCs 25/100) | `c/skill_combat/scripts/combat.rs2:88-166`; grep of `combat_xp_multiplier` | code |
| Dwarf multicannon fires while you melee or cast: 2 Ranged XP per damage, no Hitpoints XP | `c/quests/quest_mcannon/scripts/cannon_fire.rs2:119`; OSRS wiki https://oldschool.runescape.wiki/w/Dwarf_multicannon (one turn per tick, up to 8 shots per revolution) | code + web. **Ranged board while training melee** |
| Chompy bird kills: 30,000 Ranged XP at kill 4,000 | `quests/quest_chompybird/scripts/chompy_bird.rs2:211-212` | code (too slow) |
| Ranging Guild targets | `minigames/game_ranging/scripts/target.rs2:20-45`, `p_delay(2)` per shot | code (low) |
| Prayer flicking, safespots, aggression timer | `research/tricks-plan.md` | code |
| Attack-delay reset | fixed weapon delay (`player_melee.rs2:57-59`) | no |
| Rock crabs | NPC config exists only for Horror from the Deep (`quests/quest_viking/configs/horror_rockcrab.npc`) | UNVERIFIED spawns |

## 13. Thieving

Measured already (`research/tricks-plan.md`, `research/thieving-ladder.md`): 2-tick direct pickpocketing (+22%),
the stun does not block trading, eat inside the stun. OSRS H.A.M. trapdoor manipulation: the H.A.M. hideout came later
than 2004. UNVERIFIED (not searched in content).

## 14. Logout and offline time

| Technique | Evidence | Status |
|---|---|---|
| Relog clears the stun | `research/tricks-plan.md` (+17% thieving in practice) | measured. **Not approved by the owner** |
| **Wait offline**: boards count only logged-in playtime. The main account logs in only when a helper is ready to trade, and logs out while rocks respawn or helpers gather | 1 playtime tick per relog (`research/tricks-plan.md`). Runite respawn is 1,800-2,400 ticks (section 1.4) | measured cost; plan. This is normal logout use, not a bug. Get the owner's OK |
| Ferment wine at login | `research/bug-report-wine-login.md` | measured locally; not used |

## 15. Quest Points board

Quest point values in this content (`c/general/configs/quest.constant:72-...`, `^<quest>_questpoints`) sum to
**145 QP** over 68 quests. Requirement constants are excluded: `hero_required_questpoints = 55`,
`legends_required_questpoints = 107`. QP-dense quests (OSRS-style short quests; times UNVERIFIED here):

| QP | Quests |
|---|---|
| 6 | Merlin's Crystal (`arthur`) |
| 5 | Romeo and Juliet, Goblin Diplomacy, The Grand Tree, Underground Pass |
| 4 | Sheep Herder, Witch's House (`ball`), Druidic Ritual (`druid`), Ernest the Chicken (`haunted`), Watchtower, Legends' Quest |
| 3 | Black Knights' Fortress, Demon Slayer, Prince Ali Rescue, Vampire Slayer, Lost City (`zanaris`), Biohazard, Murder Mystery, Monkey Madness, Regicide, Fremennik Trials (`viking`), Shades of Mort'ton |

Route rules from the web: group quests by area and teleport, train only the skill floor, and use quest XP to skip
grinding (https://osrsguru.com/guides/osrs-quest-speedrun-order-2026.html,
https://osrsguru.com/guides/osrs-quest-cape-fastest-route-guide-2026.html; both are low-authority guides, and their
routes use OSRS travel that 2004 lacks). Romeo and Juliet and Goblin Diplomacy give 10 QP for two short quests
near Varrock and Draynor. Do them first. The search found no verified per-quest speedrun times.

---

## 16. How the fast-board leaders did it (Cooking 38, Fletching 58, Crafting 197, Herblore 447, Firemaking 673)

### 16.1 Three engine facts that explain the boards

1. **Custom XP curve.** `e/engine/entity/Player.ts:77-85` uses `2^(level/10)`, not the OSRS `2^(level/7)`.
   Level 99 needs **998,458 XP** (my run of that formula; the same figure is in `research/quest-route.md`). At x25
   that is **39,938 base XP**. In OSRS it is 13.03M. Every "ticks to 99" figure must use this curve.
2. **The stamp is the account's playtime when it reached the level.** `Player.ts:1904-1905` sets
   `levelPlaytime[stat] = playtime` on each level-up. `LoginServer.ts:162-181` writes that value. `playtime` counts every
   logged-in tick of the account (`World.ts:692`). A leader is a fresh account that trained **one** board first.
   For a single main account, the board trained first gets the lowest stamp, and each later board adds its time on
   top. Background timers (wine fermentation) run while the foreground trains another skill.
3. **5 successful user events per tick.** `e/network/game/client/ClientGameProtCategory.ts` (USER_EVENT limit 5);
   `NetworkPlayer.ts:69, 141-146`: only a **successful** user event counts. Failed packets count against the
   client limit (20). Bank buttons, close-modal and item-on-item are all user events
   (`network/game/client/model/*.ts`).

### 16.2 Lower bound per board: 5 instant actions per tick, no banking

Simulation with the curve above, best item at each level, x25 (a throwaway script outside the repo; it ignores supply delivery, failed rolls and level-up dialogs):

| Board | Leader | Method | Pure action ticks | What limits the rest |
|---|---|---|---|---|
| Cooking | 38 | Login wine: unfermented wine in the bank, 20-tick timer (`wine.rs2:72-73`) | 22 (measured locally, `research/bug-report-wine-login.md`) | the time to get wine into the bank (about 16 ticks for the leader) |
| Fletching | 58 | Arrows (15 per action) and darts (10 per action), `arrows.rs2:61-85`, `darts.rs2`. Tips, headless arrows, feathers and darts all **stack**: one inventory holds the whole run, so no banking | **49** (245 actions) | supply delivery at the start |
| Herblore | 447 | Unfinished potion + secondary, instant (`herblore.rs2:10-24`). Unfinished potions give 0 XP (`brew_potion.struct`), so helpers make them, and the main does only the finishing step | **51** (255 actions) | banking: 14 + 14 per inventory, about 18 bank trips |
| Crafting | 197 | Gems (`uncut_gem.rs2`), battlestaves from 54 (`battlestaves.rs2`) | **62** (310 actions) | banking: 27 gems per inventory, about 12 trips |
| Firemaking | 673 | Burning logs: 4 ticks per log (section 6) | **628** at 100% success | the 4-tick cycle; the leader is near this floor |

Conclusion: Fletching, Herblore and Crafting leaders are near "5 actions per tick + banking". Firemaking is near the
4-tick burn floor. To beat them, cut the banking time (16.3) or use a different XP path (16.4).

### 16.3 Tight bank cycle (code, UNVERIFIED live)

Bank ops: `c/interface_bank/scripts/bank.rs2:1-5` (withdraw 1/5/10/All/X), `bank_deposit.rs2:1-5` (deposit
1/5/10/All/X of one item type). There is no "deposit inventory" button in this revision.
- Tick A: click the bank booth while you stand next to it (1 event). The bank opens that tick.
- Tick A+1: deposit All of the product (1), withdraw All of the input (1), close modal (1), then 2 instant actions = 5 events.
- Next ticks: 5 actions per tick until the inventory is empty. Then go back to tick A.
- Gems: 27 per cycle in about 7 ticks. Crafting estimate: about 80 ticks to 99 (leader 197).
- Herblore needs 14 + 14: withdraw X of the unfinished potion (button + count dialog = 2 events), withdraw All of the
  secondary, so the first actions move to the next tick. About 5 ticks per 14 potions: about 90-100 ticks to 99
  (leader 447).

### 16.4 Firemaking without burning: sacred-oil pyre logs (code, UNVERIFIED live; owner decision)

`c/minigames/game_mortton/scripts/mortton_pyre.rs2:1-41`: sacred oil on logs makes pyre logs. It is an
**instant** item-on-item and gives Firemaking XP (`:41`): logs 20, oak 20, willow 40, maple 40, yew 60, magic 60
(`game_mortton/configs/*.struct`, `pyre_create_experience` in tenths: 200-600). It needs 2-4 oil doses per log.
- Gate: only `%morttonquest >= ^mortton_created_sacred_oil` (65, `quests/quest_mortton/configs/quest_mortton.constant:31`).
  The main must reach that stage of Shades of Mort'ton.
- **The level is read but never checked**: `def_int $level_req = struct_param($struct, pyre_level)` at `:18` is never
  used. A low-level account can make magic pyre logs (60 XP) at once. OSRS requires the level. This is a content
  gap, so treat it as an exploit until the owner decides.
- Sacred oil is tradeable (only shade keys are `tradeable=no` in `game_mortton/configs/*.obj`). Helpers can supply oil (4) and logs.
- Rate: 5 x 60 = 300 base XP per tick, so 133 action ticks to 99, plus banking (logs and oil do not stack: 14 + 14).
  Estimate: about 250 ticks against the leader's 673. Even with the level respected, it beats burning from level 65 up.
- Burning the pyre itself (`:201`, up to 404.5 XP) needs shade remains and keys: slow.

### 16.5 Planning for one main account on many boards

- The order of boards decides the stamps. Put the shortest boards first and the long ones last.
- Overlap background XP with foreground actions: start the wine timer (20 ticks), then fletch arrows inside those
  ticks. Cooking and Fletching then cost about 49 ticks together, not 71.
- Even then, the main cannot beat a one-board account on a second 5-action board: Fletching (49 floor) after Cooking
  loses to 58 unless supply delivery takes under about 9 ticks. Tell the owner: "rank 1 on all boards at once" cannot
  include more than one or two of the instant-action boards. This follows from the stamp rule (16.1 point 2).

### 16.6 Random events (`c/macro events/`)

- Off on the demo deploy if `vendor/rs-sdk/fly.toml:25` (`NODE_RANDOM_EVENTS = "false"`) is the live config.
  The engine default is false (`e/util/Environment.ts:53`). Content checks `map_random_events`
  (`macro events/scripts/macro_events.rs2:66,87`, `login_logout/login.rs2:40`). Live state UNVERIFIED.
- Even when on: one roll every 500 ticks at a 1/24 chance (1/12 in an unchanged aggro zone)
  (`World.ts:146-148, 694-695`), so about one event per 12,000 ticks. Too rare to plan around.
- Rewards: dryad (woodcutting) drops axes on `random(128)`: mithril 20/128, steel 10/128, adamant 8/128,
  **rune 4/128** (`woodcutting/macro_event_dryad.rs2:32-42`). Genie lamp: base level x 10 XP in one skill (x25 applies:
  24,500 XP at level 98) (`general/scripts/xplamp/xplamp.rs2:110`). The river troll drops bait, feathers or raw fish
  (`fishing/macro_event_river_troll.rs2:32-98`). Maze gives an XP reward that drops 1% per tick (`general/macro_event_maze.rs2:16-45`).
  None of these beats a helper trade.

---

## 17. Ranked: highest value for the 24-board goal

Tick savings are rough estimates from the rates above and the leader ticks in `research/pro-playbook.md`.

| # | Finding | Boards | Estimated saving | Status |
|---|---|---|---|---|
| 1 | Board order + stamp rule: each board stamps the account's playtime at the level-up. Do the short boards first; overlap the 20-tick wine timer with instant actions | all | decides which boards one main can win at all | code (`Player.ts:1904-1905`, `LoginServer.ts:162-181`) |
| 2 | Wait offline for supplies and respawns; log in only to trade and process | Herblore, Crafting, Fletching, Smithing, Runecraft, Cooking, Lava runite, Bank value | Large: waiting leaves the clock (1,800-2,400 ticks per runite respawn) | measured relog cost; owner decision |
| 3 | Sacred-oil pyre logs: instant Firemaking XP, 5 per tick, no level check | Firemaking | about 670 -> about 250 ticks | code, UNVERIFIED live; level gap = owner decision |
| 4 | Tight bank cycle: open the booth, then deposit All + withdraw All + close + 2 actions in one tick | Herblore, Crafting | Herblore 447 -> about 100; Crafting 197 -> about 80 | code, UNVERIFIED live |
| 5 | Flinch 2-tick gathering (rapid shortbow, no ammo, 2 NPC attackers) | Fishing, Mining, Woodcutting, Lava runite | 1/3 of the roll time against the knife 3-tick | code, UNVERIFIED live |
| 6 | Delayed-click 3-tick for lobster, harpoon, shark, net and karambwan spots (knife at T, click at T+2) | Fishing | 40-50% of high-level fishing time against 5-6 tick rolls | code, UNVERIFIED live |
| 7 | Stackable fletching supplies (tips, headless arrows, feathers): no banking, 49 action ticks to 99 | Fletching | matches the leader (58); wins only as the first board | code + simulation |
| 8 | Enchant jewellery, 3 ticks, 2x high alch | Magic | about half of non-quest Magic time | code + web |
| 9 | Wilderness course 601.4 XP per lap, about 224 XP per tick at x25 | Agility | about 4x the gnome rate above 52 | code (XP) + web (lap time) |
| 10 | Smith only 5-bar items; superheat gold with goldsmith gauntlets; cannon while meleeing | Smithing, Magic, Ranged | 5x against 1-bar items; second boards at no extra ticks | code (+ web for cannon) |

Also: instant actions before a cast in the same tick (section 9.3), battlestaves and gems at 5 per tick (section 5).

Negative findings that save wasted effort: no 1-tick karambwan (cooking is fixed at 3 ticks per item), no bone altar
or Ectofuntus, no pouches or Abyss, no firemaking faster than 4 ticks per log, Arena tickets cannot be traded, and no
NPC gives bonus combat XP.
