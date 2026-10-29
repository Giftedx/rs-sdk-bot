# Supply-board tick floors, measured on practice

The account starts at level 1 (or the level named) with every supply in its pack or bank. It converts the supplies
as fast as the tick rules allow. Each script sends its inputs with `s.direct`, up to 5 per tick. The result is the
number of logged-in ticks from the first input to the level-99 stamp.

- Evidence: **MEASURED practice** (150 ms tick, presets, `RANDOM_EVENTS=0`), unless a row says ESTIMATE or
  CODE-READ. Compare in ticks only.
- A preset loads the supplies. Delivery by helpers (trade 12 ticks realistic, `research/crafting-board.md`) is
  **not** in these figures. Herblore 1-3 and Magic 1-7 are not in them either (see each section).
- Scripts: `scripts/measure/floor-<skill>.ts`, runner `scripts/measure/floor-run.ts` (one bot at a time, a fresh
  account per run, waits for `.practice/monitor.json` to show fewer than 6 bots and 5 GB free). Shared code:
  `scripts/measure/floor-lib.ts`. Bands and exact supply counts: `scripts/measure/floor-bands.ts`
  (`bun scripts/measure/floor-bands.ts <skill>`; curve `packages/planner/src/curve.ts`, 25x).
- Presets: `floor_<skill>` in `packages/practice/src/presets.ts`.
- Quoted lines are the scripts' `FLOOR`, `CYCLE`, `BAND` and `LEVELUP` output.

## Summary

| Skill | Our ticks to 99 (runs) | #1 ticks | Margin | Method | Evidence |
|---|---|---|---|---|---|
| Fletching | **49** (49, 49, 49) | 58 | **+9** | Arrows and darts from stacks, open loop 5 per tick | MEASURED |
| Crafting | **194** (194, 194, 195) | 197 | **+3** | Gems from a booth, 27 per trip | MEASURED |
| Herblore | **246** from Herblore 3 (246, 246, 246) | 447 | **+201** (less the ticks to reach 3) | Potions from a booth, 14 per trip | MEASURED |
| Smithing | **1,312** (1,312, 1,313, 1,316) with a helper trading at the anvil; bank loop 1,572 x3 | 1,337 | **+25** (bank loop -235) | Platebodies at the Varrock west anvil | MEASURED |
| Firemaking | **667** mean of 13 runs on two lines (642-706); north of Lumbridge 662, 646, 678 | 664 (live file) | **-3** mean; 6 of 13 runs under 664 | 157-tile line, 27 logs in the pack, helpers drop the rest; no bank | MEASURED |
| Prayer | **1,260** (1,260, 1,260, 1,260) | 1,281 | **+21** | Bury dragon bones from a booth | MEASURED |
| Magic | **1,762** from Magic 7 (1,762, 1,765, 1,762); 1,670 from 44 (1 run) | 1,513 (live file 1,324) | **-249** (-438 against 1,324), plus the ticks to reach 7 | Enchant jewellery from a booth | MEASURED |
| Cooking (normal) | **339-375** (339, 375, 343) | 38 | **about -300** | Fish on a fire to 35, then hand-made wine | MEASURED |

Margins are for a one-board account that starts the board at tick 0 with all supplies in place. Haggis has one
clock for all boards (`research/haggis-run.md`), so only the first board it trains can keep these margins.
#1 ticks are from the task brief; `research/hiscores-live.json` (2026-10-23T09:56Z) has the same values except
Magic 1,324 and Firemaking 664.

## Level-up dialogs (settles INDEX C5)

Each level-up queues `[label,levelup]` on the engine queue (`Player.ts:1944-1946`). The engine queue runs only when
`canAccess()` is true (`Player.ts:713-721, 882-888`), so the next page opens only after the current one closes.
`CLOSE_MODAL` drops the paused page at once (`Player.closeModal`, `Player.ts:817-835`, applied in
`processQueues` before `processEngineQueue`, `World.ts:785-793`). A continue click resumes one page; the client
allows one resume per page (`Client.ts:2537-2556`), so pages with unlock text cost a click each.

Test: `scripts/measure/floor-levelup.ts`, preset `gems_dragonstone` (Crafting 55, 27 uncut dragonstones, 15 levels).

| Mode | Runs (clear ticks for 15 levels) | Ticks per level |
|---|---|---|
| `click`: one continue click per tick | 40, 39, 39 | 2.6-2.67 |
| `close`: CLOSE_MODAL every tick | 10, 10, 10 | **0.67** |
| `during`: 4 cuts + 1 CLOSE_MODAL per tick, then `close` | 8, 8 | **0.53** |

`LEVELUP mode=close levels=15 cutTicks=7 clearTicks=10 perLevel=0.67` and
`LEVELUP mode=click levels=15 cutTicks=7 clearTicks=39 perLevel=2.60`.

- Item-on-item does **not** close the dialog, but it runs with the dialog open: 27 cuts took 7 ticks with 15
  level-ups queued. So **C5 claim A** (`tricks-plan.md:29`, "item-on-item closes the level-up modal") is wrong.
- **C5 claim B** (`levelup-cost.md:9-21`, 40-42 clicks, "a cheaper way ... not found yet") is right for clicks, and
  the cheaper way is CLOSE_MODAL each tick: 0.67 ticks per level instead of 2.7. `sendCloseModal` "did not clear in
  5 ticks" (`levelup-cost.md`) because each close clears one page and the next level-up opens the next tick.
- What a dialog blocks: the bank booth, the anvil (use bar on anvil), bury (opheld) while a page shows, and NORMAL
  timers (wine). What it does not block: item-on-item (gems, potions, arrows, darts).
- Rule for every script: send CLOSE_MODAL each tick from the first level-up until the page stays shut, before any
  blocked action. Fletching does not need it before 99 (the stamp is set when the XP lands).

## Wine timer and modals (settles INDEX C6)

The fermenting timer is a NORMAL timer (`settimer`, `wine.rs2:20`). NORMAL timers run only when `canAccess()` is
true (`Player.ts processTimers`: "soft timers can execute while busy, normal cannot"), and `busy()` is "delayed or a
modal is open" (`Player.ts:878-880`). The timer is late, not lost: it fires on the first free tick after 20.

Measured with a scratch probe (preset `floor_wine35`): 28 wines made and banked, the bank interface left open. For
30 ticks after the last wine, Cooking XP stayed at +0 and the bank kept `1995:28` (unfermented):
`NOTE t+30 xp+0 bank=1995:28 invWine=0`. So **C6 claim A** (`xp-per-tick.md:38`, a level-up chat blocks the wine
timer) holds for any modal, and claim B (`levelup-cost.md:19`, the timer "pays nothing") is wrong: an open page or
bank delays the XP until it closes. Overlapping the timer with fletching (`tick-tricks-web.md:364-365`) works only
if the fletcher closes every level-up page.

## Fletching

| Method | Band | Actions | XP per action (x25) |
|---|---|---|---|
| Bronze arrowheads on headless arrows (15) | 1-15 | 4 | 487.5 |
| Iron arrows | 15-22 | 2 | 937.5 |
| Iron darts (10 tips + 10 feathers) | 22-30 | 4 | 950 |
| Steel arrows | 30-45 | 9 | 1,875 |
| Mithril arrows | 45-60 | 15 | 2,812.5 |
| Adamant arrows | 60-75 | 33 | 3,750 |
| Rune arrows | 75-81 | 21 | 4,687.5 |
| Rune darts | 81-99 | 151 | 4,700 |

Content: `skill_fletching/configs/arrows/arrows.dbrow`, `darts/darts.dbrow` (experience in tenths, 15 arrows or 10
darts per action), `scripts/arrows.rs2`, `scripts/darts.rs2` (no delay). Bolts are worse (10 per action, 3.2 XP).

Measured (preset `floor_fletching`, every stack in the pack, Lumbridge):

| Variant | Ticks to 99 (runs) | XP per tick | Actions per tick | Inputs sent / actions |
|---|---|---|---|---|
| Open loop: the plan in order, 5 inputs per tick, no wait for the level | **49, 49, 49** | 20,379 | 4.88 | 265 / 239 |
| Per band, wait to see the level, no CLOSE_MODAL | 59, 59 | 16,925 | 4.05 (rune darts 4.72-4.78) | 294 / 246 |
| Per band, 1 of 5 inputs spent on CLOSE_MODAL | 72 | 13,868 | 3.80 in rune darts | 351 / 247 |

`BAND Fletching open loop (all bands) xp=998575 ticks=49 actions=239 xpPerTick=20379.1 actionsPerTick=4.88`.
The server runs the 5 inputs of a tick in order, so an action that needs a level reached by an earlier action in
the same tick still works. Waiting one tick per band costs 10 ticks. The 26 ticks of level-up pages after 99 are
not on the stamp. No bank, no walk.

Supplies (exact, from level 1): bronze arrowheads 60, iron arrowheads 30, steel 135, mithril 225, adamant 495,
rune 315, headless arrows 1,260, iron dart tips 40, rune dart tips 1,510, feathers 1,550.

## Crafting

| Method | Band | Actions | XP per action (x25) |
|---|---|---|---|
| Cut opal (can smash) | 1-13 | 8 (+2 spare) | 375 |
| Cut jade (can smash) | 13-16 | 3 (+2) | 500 |
| Cut red topaz (can smash) | 16-20 | 3 (+2) | 625 |
| Cut sapphire | 20-27 | 3 | 1,250 |
| Cut emerald | 27-34 | 2 | 1,687.5 |
| Cut ruby | 34-43 | 5 | 2,125 |
| Cut diamond | 43-55 | 10 | 2,687.5 |
| Cut dragonstone | 55-99 | 277 | 3,437.5 |

Content: `skill_crafting/configs/gem/gem.dbrow` (levels, experience, `success_rate` for opal, jade, red topaz),
`scripts/gem/uncut_gem.rs2` (no delay). Air battlestaves (66, 137.5 XP) tie dragonstones but need 2 items per action,
so 14 per trip instead of 27.

Measured (preset `floor_crafting`, Draynor bank, chisel in the pack): **194, 194, 195** ticks.

| Item | Measured |
|---|---|
| Steady cycle at 80-98 (27 gems) | 12 ticks: booth to gems in pack 5 (booth 2, deposit-All 1 + withdraw 10+10+5+1+1 = 6 inputs), cut 7 |
| Cut rate | 27 gems in 7 ticks = 3.9 per tick (one tick is the round trip after the withdraw) |
| XP per tick in the dragonstone band | 5,911 |
| Level-up pages | 38-42 ticks per run, mostly at cycles 2-3 (levels 41 -> 75) |
| Bank ticks | 63 per run (12 trips) |
| Inputs | 510 sent, 0 refused, at most 17 queued in one tick |

`FLOOR Crafting level=99 xp=1002915 ticks=194 actions=317 ... levelTicks=38 levelClears=5 bankTicks=63 bankCycles=12`.

Supplies: uncut opal 8, jade 3, red topaz 3, sapphire 3, emerald 2, ruby 5, diamond 10, dragonstone 277 (the
preset banks 2 extra smash-prone gems each). Expected smashes use `stat_random` (`PlayerOps.ts:591-599`).

## Herblore

| Method (unfinished potion + secondary) | Band | Actions | XP per action (x25) |
|---|---|---|---|
| Attack (guam + eye of newt) | 3-5 | 1 | 625 |
| Antipoison (marrentill + unicorn horn dust) | 5-12 | 1 | 937.5 |
| Strength (tarromin + limpwurt) | 12-22 | 2 | 1,250 |
| Restore (harralander + red spiders' eggs) | 22-26 | 1 | 1,562.5 |
| Energy (harralander + chocolate dust) | 26-30 | 1 | 1,687.5 |
| Defence (ranarr + white berries) | 30-34 | 2 | 1,875 |
| Agility (toadflax + toad's legs) | 34-38 | 2 | 2,000 |
| Prayer (ranarr + snape grass) | 38-45 | 4 | 2,187.5 |
| Super attack (irit + eye of newt) | 45-48 | 2 | 2,500 |
| Super antipoison (irit + unicorn horn dust) | 48-50 | 2 | 2,657.5 |
| Fishing (avantoe + snape grass) | 50-52 | 2 | 2,812.5 |
| Super energy (avantoe + mort myre fungi) | 52-55 | 3 | 2,937.5 |
| Super strength (kwuarm + limpwurt) | 55-60 | 6 | 3,125 |
| Weapon poison (kwuarm + dragon scale dust) | 60-63 | 5 | 3,437.5 |
| Super restore (snapdragon + red spiders' eggs) | 63-66 | 5 | 3,562.5 |
| Super defence (cadantine + white berries) | 66-69 | 6 | 3,750 |
| Antifire (lantadyme + dragon scale dust) | 69-72 | 8 | 3,937.5 |
| Ranging (dwarf weed + wine of zamorak) | 72-76 | 12 | 4,062.5 |
| Magic (lantadyme + potato cactus) | 76-78 | 7 | 4,312.5 |
| Zamorak (torstol + jangerberries) | 78-99 | 175 | 4,375 |

Content: `skill_herblore/configs/brewing/brew_potion.struct` (level, exp), `scripts/brewing/brew_potion.rs2`,
`scripts/herblore.rs2` (no delay). Unfinished potions give 0 XP, so helpers make them.

**Herblore 1-3 is not a supply band.** Identify needs level 3 (`configs/identifying/identify.param` default 3, and
identify guam measured: "You need a higher Herblore level"), and brewing needs 3 (`brew_potion.param` default 3).
The account needs quest XP first (Druidic Ritual: `quests/quest_druid/scripts/quest_druid.rs2:3` `stat_advance(herblore, 2500)` = 250 XP, x25 = 6,250, past level 3).

Measured (preset `floor_herblore`, Herblore 3, Draynor bank): **246, 246, 246** ticks from Herblore 3 to 99.

| Item | Measured |
|---|---|
| Trip 1 (13 potion types, 24 withdraw inputs) | 25 ticks for 14 potions |
| Steady cycle at 86-98 (14 + 14) | 10 ticks: booth 2, bank 4 (deposit-All 1 + withdraw 10+1+1+1+1 twice + close = 12 inputs, 3 ticks to decode at 5 per tick), brew 4 |
| XP per tick in the zamorak band | 5,537 |
| Level-up pages | 26 ticks per run (CLOSE_MODAL every tick) |
| Bank ticks | 117 per run (18 trips) |
| Inputs | 614 sent, 0 refused |

Variants (1 run each): 10 + 10 per trip (2 withdraw inputs): 278 ticks (7 ticks per 10 potions, the same 0.7 ticks
per potion); continue clicks instead of CLOSE_MODAL: 301 ticks (84 level-up ticks instead of 26-39).

`FLOOR Herblore level=99 xp=1001044 ticks=246 actions=247 ... levelTicks=26 levelClears=8 bankTicks=117 bankCycles=18`.

Supplies (from 3): unfinished guam 1, marrentill 1, tarromin 2, harralander 2, ranarr 6, toadflax 2, irit 4,
avantoe 5, kwuarm 11, snapdragon 5, cadantine 6, lantadyme 15, dwarf weed 12, torstol 175; eye of newt 3,
unicorn horn dust 3, limpwurt root 8, red spiders' eggs 6, chocolate dust 1, white berries 8, toad's legs 2,
snape grass 6, mort myre fungi 3, dragon scale dust 13, wine of zamorak 12, potato cactus 7, jangerberries 175.

## Smithing

| Method | Band | Actions | XP per action (x25) |
|---|---|---|---|
| Bronze dagger (1 bar) | 1-9 | 3 | 312.5 |
| Bronze warhammer (3) | 9-18 | 2 | 937.5 |
| Bronze platebody (5) | 18-24 | 2 | 1,562.5 |
| Iron warhammer (3) | 24-33 | 2 | 1,875 |
| Iron platebody (5) | 33-48 | 6 | 3,125 |
| Steel platebody (5) | 48-68 | 19 | 4,687.5 |
| Mithril platebody (5) | 68-88 | 56 | 6,250 |
| Adamant platebody (5) | 88-99 | 68 | 7,812.5 |

Content: `skill_smithing/configs/smithing/smithing.dbrow` (`levelrequired`, `bar_amount`), `smithing.struct`
(`xpperbar` 12.5-75), `scripts/smithing/smithing.rs2:271-301` (`p_delay(1)` + `p_delay(2)` per item, Make 5/10
continues on its own). A 5-bar platebody takes the same 5 ticks as a 1-bar dagger.

Measured (preset `floor_smithing`, Varrock west bank (3185,3436) and the smithy anvil (3188,3426)):
**1,572, 1,572, 1,572** ticks (second series, with the booth fix below; the first series was 1,593, 1,594, 1,593).

| Item | Measured |
|---|---|
| Smith | 5 ticks per item exactly (24 ticks for 5 platebodies after the click): `smithTicks=754` for 158 items |
| Steady cycle (5 platebodies) | 47 ticks: bank 14 (walk back + booth + deposit + withdraw 25 bars), walk to the anvil + interface 9, smith 24 |
| Walk + bank share | 818 of 1,572 ticks (52%): bank 494, walk to the anvil 324 |
| Level-up pages | queued during Make-X (the player is delayed), they open after the last item; 67 ticks per run (99 in the first series) |
| Booth clicks lost | the first booth click after the last anvil delay is dropped (player still delayed); the first series clicked again after 10 ticks (`NOTE booth re-click at +10`, 105 times in 3 runs); the second clicks again every 2 ticks until the player moves, which saved 21 ticks per run |

`FLOOR Smithing level=99 xp=998750 ticks=1572 actions=158 ... refused=35 ... levelTicks=67 bankTicks=494 bankCycles=36 walkTicks=324 smithTicks=754`.

This bank loop loses to the #1 (1,337) by 235 ticks. A trip is still 14 bank ticks, because the walk back from the
anvil (about 10 tiles) is in it. Cut, not yet measured:

- A helper trades 25 bars at the anvil instead of the bank walk: smith 754 + 36 trades x 12 ticks (realistic,
  `research/crafting-board.md`) + level-up pages = about 1,290 ticks; with 5-tick trades about 1,040. ESTIMATE from
  MEASURED parts.

Supplies: bronze bars 19, iron 36, steel 95, mithril 280, adamantite 340.

## Prayer

| Method | Band | Actions | XP per action (x25) |
|---|---|---|---|
| Bury dragon bones | 1-99 | 555 | 1,800 |

Content: `skill_prayer/configs/bones.obj` (`bone_exp` 720 tenths), `scripts/bury_bone.rs2` (`p_delay(0)`, the bone
is deleted **after** the delay, no level check). No altar or Ectofuntus bonus in rev 289 (`tick-tricks-web.md` 10).
Big bones (15 XP) would need 2,663 bones and 5,400+ ticks.

Measured (preset `floor_prayer`, Draynor bank, 560 dragon bones banked): **1,260, 1,260, 1,260** ticks.

| Input pattern | Ticks per bone (28 bones) |
|---|---|
| `burst`: bury on 5 different bone slots each tick | **2.04** (57 ticks per 28) |
| `every`: bury on the first bone slot each tick | 3.0 (84 ticks per 28) |
| `two`: bury every 2 ticks | 4.0 (111 ticks per 28) |

The `every` and `two` patterns lose because the bone under the delay is still in its slot (it is deleted after
`p_delay(0)`), so a second input on the same slot is wasted. A pro clicks the next bone.

| Item | Measured (burst, full run) |
|---|---|
| Bury | 1,130 ticks for 555 bones (2.04 per bone) |
| Bank trip (booth, withdraw-All 28 = 1 input, close) | 121 ticks for 20 trips (6 per trip) |
| Level-up pages | 9 ticks per run |

`FLOOR Prayer level=99 xp=999000 ticks=1260 actions=555 ... levelTicks=9 levelClears=3 bankTicks=121 bankCycles=20 mode=burst buryTicks=1130`.

Supplies: 555 dragon bones (0 GE sellers live, `research/board-ranking.md`).

## Magic

| Method | Band | Actions | XP per action (x25) |
|---|---|---|---|
| Lvl-1 enchant, sapphire ring | 7-27 | 12 | 437.5 |
| Lvl-2 enchant, emerald ring | 27-49 | 27 | 925 |
| Lvl-3 enchant, ruby ring | 49-57 | 16 | 1,475 |
| Lvl-4 enchant, diamond ring | 57-68 | 37 | 1,675 |
| Lvl-5 enchant, strung dragonstone amulet | 68-99 | 453 | 1,950 |

Content: `skill_magic/configs/magic_spells.dbrow` (levels 7/27/49/57/68, experience 175-780 tenths, runes),
`scripts/spells/enchant.rs2` (XP on the cast, then `p_delay(1)`). Low alch (21-27) and superheat (43-49) are left
out: they save 3-8 casts and superheat needs Smithing 15.

**Magic 1-7 is not a supply band.** Every spell below 7 needs a target (strikes, confuse). ESTIMATE: a few
casts, or quest XP.

Measured (preset `floor_magic`, Magic 7, Draynor bank, runes as stacks in the pack): **1,762, 1,765, 1,762** ticks from
Magic 7 to 99.

| Item | Measured |
|---|---|
| Cast | 2.96 ticks per cast (1,611 ticks for 545 casts, `burst`: 3 cast inputs on 3 items per tick) |
| Trip (23 items: 28 slots - 5 rune stacks) | 74 ticks: bank 6, cast 68 |
| Bank | 151 ticks for 24 trips |
| XP per tick, lvl-5 band | 605 |

`FLOOR Magic level=99 xp=999732 ticks=1762 actions=545 ... bankTicks=151 bankCycles=24 mode=burst castTicks=1611 ticksPerCast=2.96`.

Supplies: sapphire rings 12, emerald rings 27, ruby rings 16, diamond rings 37, strung dragonstone amulets 453,
cosmic runes 545, water runes 6,807, earth runes 7,165, air runes 81, fire runes 80. A staff of earth or water
would free a slot (24 per trip) and the rune counts.

## Cooking (normal method, no login timer)

| Method | Band | Actions | XP per action (x25) |
|---|---|---|---|
| Raw sardine on a fire (burns) | 1-5 | 1 + burns | 1,000 |
| Raw herring | 5-15 | 3 + burns | 1,250 |
| Raw trout | 15-25 | 3 + burns | 1,750 |
| Raw salmon | 25-35 | 4 + burns | 2,250 |
| Hand-made wine (grapes on jug of water) | 35-99 | 366 (60-100% ferment) | 2,750 |

Content: `skill_cooking/scripts/cooking.rs2:99-131` (`p_delay(1)` per item, then the raw item is deleted),
`configs/cooking_source/cooking_generic.dbrow` (levels, XP, `successchance`), `scripts/cooking_inv/scripts/wine/wine.rs2`
(instant, Cooking 35, `settimer(fermenting_wine, 20)`, ferments pack and bank at `stat_random(48, 352)`).

Measured (preset `floor_cooking`, Draynor bank, fire lit 6 tiles north): **339, 375, 343** ticks to 99.

| Item | Measured |
|---|---|
| Fire | 6-22 ticks to light (Firemaking 1, 25% roll) |
| Fish 1-35 | 32-44 ticks: 7 cooked + 1-4 burnt, 4.0 ticks per item (one input per tick on the first fish slot; the item is deleted after the delay, so 3 is possible) |
| Wine 35-99 | 376 wines in 271 ticks: 29 trips of 13 (tinderbox kept), 9-tick cycle (bank 5, make 4) |
| Timer | XP lands 20 ticks after the last wine (`timerWait=20`, all 3 runs) |

`FLOOR Cooking level=99 xp=1046500 ticks=356 ... bankTicks=152 bankCycles=29 fishTicks=32 wineTicks=291 timerWait=20 wines=376 ticksTo99=339`.

The #1 (38) used the login timer. By the normal method Cooking is about 300 ticks late. The schedule model's legal
route (helpers bank wine notes, `haggis-boards.json` `bank-wine` + `wine-timer`) avoids the 271 make ticks; this
file measured only the timer part of it (20 ticks).

Supplies: raw sardine 1, herring 3, trout 3, salmon 4 (plus spares for burns; the runs burnt 3-10), 366 grapes,
366 jugs of water (376 made; 17 more than needed).

## Firemaking

| Method | Band | Logs | XP per log (x25) |
|---|---|---|---|
| Logs | 1-15 | 2 | 1,000 |
| Oak logs | 15-30 | 4 | 1,500 |
| Willow logs | 30-45 | 7 | 2,250 |
| Maple logs | 45-60 | 13 | 3,375 |
| Yew logs | 60-75 | 24 | 5,062.5 |
| Magic logs | 75-99 | 107 | 7,595 |

Content: `skill_firemaking/configs/firemaking.obj` (`levelrequire`, `productexp`; no teak or mahogany in rev 289),
`scripts/firemaking.rs2:98-131` (first roll 3 ticks after the attempt, every later roll 4 ticks after the last
success or failure, `stat_random(64, 512)`; a failed roll keeps the log and rolls again, so fails cost ticks, not
logs). Sacred-oil pyre logs are left out (owner decision, `tick-tricks-web.md` 16.4).

Measured (presets `floor_firemaking` Firemaking 1 and `floor_fm75` Firemaking 75, Draynor bank, line west from
(3099,3249)):

| Item | Runs | Measured |
|---|---|---|
| First trip, 27 logs, levels 1 -> 61 | 4 | 126, 118, 110, 166 burn ticks (4.67, 4.37, 4.07, 6.15 per log) |
| Magic logs at 75 -> 85, 27 logs | 2 of 3 | 110, 110 burn ticks (**4.07 per log**); run 2 stuck after 4 logs (blocked tile) |
| Bank trip from the bank side | 5 | 5-7 ticks; walk to the line start 6 |
| Bank trip from the line end (27 tiles west) | 1 | 18 ticks (walk back + booth), then 6 to the line start |

`CYCLE 1 logs=27 level=85 clear=0 bank=5 walk=6 burn=110 perLog=4.07 total=121`.

No full 1 -> 99 run passed: the second line (rows 3250 and 3251) ran into blocked tiles and old fires
(`WARN log not lit at job 51`, `CYCLE 2 logs=24 ... burn=331 perLog=13.79`). ESTIMATE from the measured parts:
first trip 118 + 130 logs x 4.07 = 529 + 5 more trips x 24 = 120 + first bank 13 = **about 780 ticks**.
A line spot with 27 free tiles in 2-3 rows next to a booth (or a helper who trades 27 logs at the line start)
is the open item. Even at 4.07 ticks per log and no banking, 157 logs need 639 ticks: Firemaking is at best
level with the #1 (664-673).

Supplies: logs 2, oak 4, willow 7, maple 13, yew 24, magic 107, tinderbox.

## What these numbers leave out

- Supply delivery: every preset puts the supplies in place. A helper trade is 12 ticks realistic, 5 floor
  (`research/crafting-board.md`, `haggis-boards.json` `trade-start`).
- Herblore 1-3 and Magic 1-7 (no supply method; quest XP or a few combat casts).
- Random events: all runs used `RANDOM_EVENTS=0` (INDEX C1).
- Practice runs at 150 ms; live is 400 ms. Tick counts carry over only if the live server takes 5 inputs per tick
  the same way. Not measured live.

## INDEX contradictions settled

- **C5**: CLOSE_MODAL clears level-up pages at 0.53-0.67 ticks per level (3 + 2 runs); continue clicks cost
  2.6 ticks per level (3 runs); item-on-item does not close the page but runs with it open. Claim A is wrong;
  claim B is right about clicks and is answered: CLOSE_MODAL each tick is the cheap way.
- **C6**: a modal (bank, level-up page) holds the NORMAL wine timer (probe: 30 ticks, xp +0, bank open);
  with no modal, Cooking 99 lands 20 ticks after the last wine (3 runs). Claim A holds; claim B is wrong.

## Flip attempts for the three losing boards

### Smithing: helper trades bars at the anvil (FLIPPED on practice)

`scripts/measure/floor-smith-trade.ts`, presets `floor_smith_trade` (smither beside the Varrock west anvil, hammer)
and `floor_smith_helper` (helper `<bot>b` at Varrock west bank with the bars). The smither never banks or walks:
per load, both players send "Trade with" every tick until the screen opens (the second request opens it,
`interface_trade/scripts/trade.rs2`), the helper offers All of each bar, the smither offers the products back in
the same trade, both accept both screens, then the smither uses a bar on the anvil and picks Make 1/5/10. The
helper banks for the next load while the smither works; its ticks are not on the smither's board.

| Runs | Ticks to 99 | Steady cycle (5 platebodies) |
|---|---|---|
| 1,312, 1,313, 1,316 | **1,312** against #1 1,337: **+25** | 37 ticks: trade 11, anvil use 2, smith 24 |

`FLOOR Smithing level=99 xp=998750 ticks=1312 actions=158 ... waitTicks=14 tradeTicks=362 useTicks=157 smithTicks=779`.

- Overlap: a trade cannot open during the smith delay. With the helper requesting every tick through the
  Make-X (`FLOOR_OVERLAP=1`), 0 of 31 trades opened while smithing (`overlapOpened=0`) and the total stayed
  1,312. `trade.rs2` refuses a busy partner (`.busy`: delayed or a modal). The pickpocket-stun case differs: a
  stun is not a `p_delay`.
- Harness rules: a second request after the screen opened resets the trade (the
  offer-to-confirm switch reads closed for one tick), and Make 5 / Make 10 run on until the bars run out, so ask
  only for 1, 5 or 10.
- The margin is 25 ticks for a board trained first. Supply delivery to the helper and the first trade are in
  the figure; the helper's bank walks are not.

### Firemaking: ground logs, no banking (NOT flipped)

- Measured: a helper drops one log per tile and the firemaker lights each where it lies (`[opobj4,_category_22]`,
  `scripts/measure/floor-fm-ground.ts`). 27 magic logs on row z=3248 took 110 ticks, **4.07 per log**, the same as
  from the pack. Player drops show to others after 100 ticks and last 300 (`WorldConfig.ts:115`, `drop.rs2:22`).
- The hard floor is the roll: 157 logs x 4 ticks + the first 3-tick roll + low-level fails is about 645 ticks
  against #1 664. Any supply overhead above about 20 ticks loses.
- Three-row path at Draynor (`floor-fm-rows.ts`, 1 run, failed at log 69): rows heading east cost about 5.7 ticks
  per log (the push goes west first, so the player walks back to each log), and the start of a new row was out
  of the firemaker's ground-item view.
- Snake field (`floor-fm-snake.ts`): the walk map search found one walled rectangle with 168 tiles,
  x 3041-3068, z 3290-3295. It is a cabbage patch: cabbages stand on every even x of the odd rows
  (`NOTE locs cabbage@3066,3295 ...`), and lighting there fails with "You can't light a fire here"
  (`map_locaddunsafe`, active locs). The even rows (3290, 3292, 3294; 84 tiles) are free.
- Open: a 157-tile snake of lightable tiles with walls at both row ends, or two shorter snakes joined by a short
  walk. Without it, the best measured route stays at about 780 ticks.

### Firemaking on a line: line search and helper drops

Scripts: `scripts/measure/fm-line-search.ts` (map scan), `scripts/measure/floor-fm-line.ts` (the burn),
`scripts/measure/fm-line-run.ts` (builds the saves, one firemaker plus 5 helpers in one process, waits for
`.practice/monitor.json` to show fewer than 6 bots). All runs: practice, `RANDOM_EVENTS=0`, fresh accounts,
Firemaking 1, run on (varp 173).

Method. The firemaker starts on the line with a tinderbox and the first 27 logs (2 logs, 4 oak, 7 willow, 13 maple,
1 yew). Helpers `<bot>b`-`<bot>f` each hold one 28-log chunk of the other 130 (23 yew, 107 magic). Helper k drops
its chunk one log per tile when the firemaker is 36 logs before the chunk (drops show after 100 ticks and last 300).
The firemaker lights each ground log where it lies. It never banks or trades.

Rules found on the way (CODE-READ `firemaking.rs2`, MEASURED practice):
- A lightable tile: no active loc on it (`map_locaddunsafe`; a loc is active when it has an op or a model with no
  shape suffix, `LocType.ts` postDecode), no `WALK_BLOCKED` flag, not in a bank zone (`bank_zones.dbrow`).
- Fires are `blockwalk=no`, so the push (a teleport west, then east, south, north) never stops on a fire. At a
  row end it moves the player east onto the fire just lit. East rows therefore need a walk for every log.
- The push shows in the state one tick before the XP (`p_delay(0)` between the push and `stat_advance`).
- Turns: a walk that arrives too late starts a fresh 3-tick attempt ("You attempt to light the logs"). With run on
  and the next op sent when the push shows, a turn of up to 4 steps costs 0 ticks (`turnLogTicks=5/5/5/5`:
  the turn log is 5 ticks and the log before it 3). A 6-step turn cost 4 ticks (`turnLogTicks=8/8/9`).
- At level 45+ every roll succeeds (`stat_random(64, 512)`), so the ticks over 4 per log there are overhead
  (`extraAt45`). It was 0 in 12 of the 13 runs below and 4 in one.

Line search (`bun scripts/measure/fm-line-search.ts`, about 3 min with `--turns 5`): 4,042 west rows of 20+
tiles on reachable level-0 land. No straight 157-tile row exists outside the Wilderness. Danger = spawns with a
huntmode within huntrange + wanderrange (default 5); `--safe` drops Wilderness and desert-heat tiles.

| # | Line (rows z: x east -> west) | Turns (steps) | Start | Tiles from Lumbridge spawn (Chebyshev) | Danger |
|---|---|---|---|---|---|
| 1 | z3629 2785-2746, z3632 2746-2732, z3630 2735-2682, z3632 2687-2654, z3636 2659-2641 (Fremennik) | 4 (14) | 2785,3629 | 437 | 0 |
| 2 | z3306 3211-3182, z3307 3185-3171, z3311 3176-3098, z3312 3103-3071 (north of Lumbridge) | 3 (12) | 3211,3306 | 88 | 0 |
| 3 | z3276 3080-3033, z3277 3038-3022, z3276 3027-2987, z3278 2992-2977, z3279 2978-2944 | 4 (13) | 3080,3276 | 142 | 2 highwaymen |
| 4 | z3627 2769-2729 ... z3627 2647-2623 (Fremennik) | 5 (20) | 2769,3627 | 453 | 5 viking wolves |
| 5 | z3588 3220-3064, straight (Wilderness level 9) | 0 | 3220,3588 | 370 | WILD; scorpion, thug |
| 6 | z3647 3245-3089, straight (Wilderness) | 0 | 3245,3647 | 429 | WILD; brown bear |
| 7 | z3616 3162-3059, z3614 3062-2984 (Wilderness) | 1 | 3162,3616 | 398 | WILD |
| 8 | z3398 3026-2942 (85 tiles, too short alone) | - | 3026,3398 | 196 | 0 |
| 9 | z3311 3181-3098 (84 tiles, part of line 2) | - | 3181,3311 | 93 | 0 |
| 10 | z3460 3184-3105 (80 tiles, too short alone) | - | 3184,3460 | 242 | 0 |

Runs (`FLOOR Firemaking level=99 xp=1001790 ticks=...`, from the first input to level 99):

| Line | Runs | Ticks to 99 | Overhead at 45+ |
|---|---|---|---|
| 2, north of Lumbridge | 3 | **662, 646, 678** | 0, 0, 0 |
| 1, Fremennik (5 rows) | 10 | 682, 658, 666, 706, 650, 642, 678, 682, 642, 678 | 0 in 9, 4 in 1 |
| 5, Wilderness straight | 1 | 654 | not logged |
| Fremennik 4-row variant (6-step turns, run off) | 4 | 663, 667, 651, 643 | 13 each |

`FLOOR Firemaking level=99 xp=1001790 ticks=646 ... waitTicks=0 walkTicks=0 failRetriesEst=5 worstLogTicks=14
extraAt45=0 turnLogTicks=5/5/5 ... rows=137/60/316/133` (line 2, run 2). In all three line-2 runs the rows after
the first took the same 60/316/133 ticks; only the first row (levels 1-60) differs.

Result. The line, the turns and the supply cost 0 ticks. What is left is the roll: 157 logs at 4 ticks plus the
failed rolls below level 45. Mean of the 13 runs (12 with 0 overhead) **667**, best 642; 6 of 13 under 664 (line 2:
2 of 3). A model of the rolls (curve.ts, `stat_random` from `PlayerOps.ts`, 20,000 trials) gives mean 657,
5th-95th percentile 635-691, 72% under 664; the measured mean is 10 ticks higher (2 standard errors; cause not
found). The board is a coin flip for a firemaker that starts at tick 0 on the line. Haggis also has the tutorial
(10 ticks) and the walk to the line (line 2: 88 tiles from the spawn, 55 ticks in the planner estimate), so Haggis does not win
Firemaking by burning on this evidence. Planner row `fm-burn`: floor 642, realistic 667, at
`fm-line-lumbridge-north` (`packages/planner/src/haggis-boards.json`).

- Planner (`bun packages/planner/src/haggis-cli.ts research/hiscores-live.json`, scenario a, on a tree that also
  held other uncommitted planner edits): Firemaking finish floor 1,675 -> 1,764, realistic 1,997 -> 1,970;
  Overall floor 38,556 -> 38,583, realistic 47,313 -> 47,248 (#1 35,916). The floor rises because the old row
  burned "anywhere" at 639 and the new one walks to the line. Done first, Firemaking alone: 707 floor, 732
  realistic, against 664.
- Supply for a live run: 5 helper loads of 28 logs, staged at the line before Haggis arrives (off Haggis's clock).
  One helper with bank trips also works if the bank is near: a chunk burns for 112 ticks.
- Open: Wilderness lines are straight but carry PK risk on the live server. The 10-tick gap between the model and
  the runs. A live measure (400 ms tick).

### Magic: legal start and cast rate (NOT flipped)

- Cast rate: enchant is `p_delay(1)` (`enchant.rs2:53`), so a cast every 3 ticks is the engine limit. Measured
  2.96. Alternating items, more inputs per tick or a helper cannot beat it.
- Fastest legal start: Imp Catcher, 875 XP x25 = 21,875 (`quests/quest_imp/scripts/quest_imp.rs2:4`), level 44 at
  once (quest ticks not measured). Without the quest, 1-7 needs a few combat casts on an NPC (strikes; ESTIMATE
  about 15-20 ticks).
- Measured from Magic 44 (preset `floor_magic44`, 1 run): **1,670** ticks to 99, 516 casts, 23 trips, bank 142
  ticks. `FLOOR Magic level=99 xp=999347 ticks=1670 ... bankTicks=142 bankCycles=23 mode=burst castTicks=1528`.
- Against #1 1,324 this loses by about 346 ticks before the quest time. The leader's route uses Charge at
  5 per tick (`leader-forensics.md` Magic), which is out (content bug, owner rule). No legal supply method
  reaches 30 base XP per tick: Lvl-5 enchant gives 26.
