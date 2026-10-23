# Supply-board tick floors, measured on practice (2026-10-23)

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
| Smithing | **1,593** (1,593, 1,594, 1,593) | 1,337 | **-256** | Platebodies, Varrock west bank + anvil | MEASURED |
| Firemaking | see section | 673 | see section | Logs in lines at Draynor | MEASURED (pending runs) |
| Prayer | see section | 1,281 | see section | Bury dragon bones at a booth | MEASURED (pending runs) |
| Magic | see section | 1,513 | see section | Enchant jewellery at a booth | MEASURED (pending runs) |
| Cooking (normal) | see section | 38 | see section | Fish on a fire to 35, then hand-made wine | MEASURED (pending runs) |

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
The account needs quest XP first (Druidic Ritual: 250 XP x25 = 6,250, past level 3; `research/quest-xp.md`).

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
**1,593, 1,594, 1,593** ticks.

| Item | Measured |
|---|---|
| Smith | 5 ticks per item exactly (24 ticks for 5 platebodies after the click): `smithTicks=754` for 158 items |
| Steady cycle (5 platebodies) | 47 ticks: bank 14 (walk back + booth + deposit + withdraw 25 bars), walk to the anvil + interface 9, smith 24 |
| Walk + bank share | 839 of 1,593 ticks (53%) |
| Level-up pages | queued during Make-X (the player is delayed), they open after the last item; 99 ticks per run |
| Booth clicks lost | the first booth click after the last anvil delay is dropped (player still delayed); the script clicked again after 10 ticks: `NOTE booth re-click at +10`, 105 times in 3 runs |

`FLOOR Smithing level=99 xp=998750 ticks=1593 actions=158 ... levelTicks=99 bankTicks=515 bankCycles=36 walkTicks=324 smithTicks=754`.

This bank loop loses to the #1 (1,337) by 256 ticks. Cuts, not yet measured:

- Click the booth again every 2 ticks until the player moves (fix in `floor-lib.ts`, rerun pending): about 6 ticks
  per trip x 36 = about 216 ticks. ESTIMATE.
- A helper trades 25 bars at the anvil instead of the bank walk: smith 754 + 36 trades x 12 ticks (realistic,
  `research/crafting-board.md`) + level-up pages = about 1,290 ticks; with 5-tick trades about 1,040. ESTIMATE from
  MEASURED parts.

Supplies: bronze bars 19, iron 36, steel 95, mithril 280, adamantite 340.
