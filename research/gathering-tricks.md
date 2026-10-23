# Gathering tricks: flinch 2-tick and delayed-click 3-tick (2026-10-23)

This file checks two tricks from `research/tick-tricks-web.md` (sections 1.2 and 1.3) in the rev 289 code, and
measures them on the local practice server (150 ms tick, presets). Paths start at
`vendor/rs-sdk/server/content/scripts/` unless they start with `engine/` (`vendor/rs-sdk/server/engine/src/`).

All rates are XP per tick at 25x, from `RESULT` lines of `scripts/measure/*.ts`. Each run is a fresh preset
account. A preset run is not a fresh-account run and not a live run.

## Verdicts

| Trick | Verdict | Measured XP/tick (trick vs baseline) | Evidence |
|---|---|---|---|
| (b) Delayed-click 3-tick fishing (knife at T, spot click at T+2) on lobster and harpoon spots | **WORKS** | Lobster from 70: 228.8 / 143.5 / 35.7 vs 101.3 / 89.6 / 101.3 (best run +126%). Harpoon from 55: 133.7 / 193.5 / __H3__ vs 74.6 / 84.3 / __HN3__. Lobster from 40: 145.0 / 169.9 / 98.3 vs 101.3 / 74.6 / 74.6 | MEASURED practice |
| (b) Same-tick knife + click on a lobster spot (the fly-fishing method) | **FAILS** | 0 XP in 152 ticks, 49 cycles | MEASURED practice (1 run) + CODE-READ |
| (a) Flinch 2-tick (two attackers, rapid shortbow, no ammo) | **FAILS on this server for every gathering board** | Not reachable: no place has two aggressive 4-tick attackers next to a resource (see below). One-attacker flinch at Barbarian Village oaks: 53.1 / 0.0 / 59.4 vs knife 3-tick __WCK__ | CODE-READ + MEASURED practice |

## (b) Delayed-click 3-tick: code

- The visible spot op runs the "attempt" label. With `%action_delay < map_clock` it sets clock + 4 (lobster,
  `skill_fishing/scripts/fishing_spots/rarefish.rs2:60-63`) or clock + 5 (harpoon, `rarefish.rs2:164-167`; shark,
  `memberfish.rs2:30-33`). With `%action_delay = map_clock` it rolls at once and does not re-op
  (`rarefish.rs2:70-73`, `:173-179`; `memberfish.rs2:40-43`; net/bait `saltfish.rs2:47-50`). No branch exists for
  clock + 2, so the same-tick knife click does nothing on these spots.
- Knife on a log + "Make 1" sets `%action_delay = map_clock + 2` when it is in the past, and queues the cut as a weak
  queue (`skill_fletching/scripts/cut_logs.rs2:83-86`). A spot click or a modal close clears the weak queue
  (`engine/engine/entity/Player.ts:817-819` closeModal; `engine/network/game/client/handler/CloseModalHandler.ts`).
- `fish_roll` has no delay (`skill_fishing/scripts/fishing.rs2:40-73`).
- Fly fishing is different: its attempt label at `= map_clock` only re-ops to the hidden op 4 and does not roll
  (`freshfish.rs2:37-52`). That is why fly fishing uses the same-tick knife click (tricks-plan.md) and not this method.

Cycle: tick T knife + Make 1 (2 inputs); T+1 drop one fish (or close the modal); T+2 click the spot (it rolls); T+3
the next knife. 3 ticks per roll, against 5 (lobster) or 6 (harpoon) for the best plain clicking.

## (b) Delayed-click 3-tick: measurements

`scripts/measure/fish-delayed.ts`, 600-tick runs. "normal" = the best plain clicking: one spot click every 5 ticks
(cage) or 6 ticks (harpoon), so each click lands 1 tick after the roll. A click also closes a level-up dialog.

| Preset (start level) | Mode | Runs: XP/tick (ticks, catches, logs left of 15) |
|---|---|---|
| `lobster_delayed_40` (Musa Point, 40) | normal | 101.3 (600, 27), 74.6 (603, 20), 74.6 (603, 20) |
| `lobster_delayed_40` | delayed | 145.0 (543, 35, 0 of 5), 169.9 (331, 25, 0 of 15), 98.3 (412, 18, 0 of 15) |
| `lobster_delayed_70` (Musa Point, 70) | normal | 101.3 (600, 27), 89.6 (603, 24), 101.3 (600, 27) |
| `lobster_delayed_70` | delayed | 228.8 (600, 61, 15), 143.5 (392, 25, 0), 35.7 (126, 2, 0) __L70X__ |
| `harpoon_delayed_55` (Musa Point, 55) | normal | 74.6 (603, 21), 84.3 (605, 22), __HN3__ |
| `harpoon_delayed_55` | delayed | 133.7 (602, 36, 15), 193.5 (602, 53, 15), __H3__ |
| `shark_delayed_80` (Catherby, 80) | normal / delayed | __SHARK__ |

Quoted lines (examples):
`RESULT ok mode=delayed opt=^cage$ gap=2 xp0=133230 gained=137250 ticks=600 perTick=228.8 cycles=200 catches=61 drops=61 logs=15 lvl=80`;
`RESULT ok mode=normal opt=^cage$ gap=2 xp0=133230 gained=60750 ticks=600 perTick=101.3 cycles=120 catches=27 drops=19 logs=15 lvl=75`;
`RESULT ok mode=delayed opt=^harpoon$ gap=2 xp0=46534 gained=116500 ticks=602 perTick=193.5 cycles=199 catches=53 drops=53 logs=15 lvl=72`;
`RESULT fail mode=same opt=^cage$ gap=2 xp0=15789 gained=0 ticks=152 perTick=0.0 cycles=49 catches=0 lvl=40`.

**Timing is the risk.** The method needs the 2 knife inputs in one tick and the click exactly 2 ticks later. When the
practice host was loaded (12-17 bots, 1.5-4 GB free RAM, `.practice/monitor.json`), the burst split across ticks: the
spot saw clock + 1, did not roll, and the fletch queue ran and used a log. A used log is the marker of a missed cycle.
Every run that kept all 15 logs scored 133-229 XP/tick; runs that used all logs scored 36-170 and stopped early when
the logs ran out. Live (400 ms tick, network latency) is not measured.

Note: the normal runs repeat exact totals (60,750 three times, 45,000 three times), so the practice RNG appears to
repeat for identical input timing. The delayed runs differ because their timing differs.

## (a) Flinch 2-tick: code

What works in code:
- An NPC melee swing, hit or miss, queues `playerhit_n_retaliate` with delay 0 (`skill_combat/scripts/npc/npc_combat_melee.rs2:28-48`).
  NPCs run before players (`engine/engine/World.ts:414,425`), and a delay-0 queue runs that tick
  (`engine/engine/entity/Player.ts` processQueue: `delay <= 0`).
- With auto-retaliate on, the queue sets `%action_delay = map_clock + attackrate/2 - 1` on rapid
  (`skill_combat/scripts/player/auto_retaliate.rs2:9-22`). The shortbow has the default attackrate 4
  (`skill_combat/configs/combat.param:76-78`), so the delay is clock + 1. A resource click on the next tick rolls at once
  (woodcutting `skill_woodcutting/scripts/woodcut.rs2:55, 97`; mining `skill_mining/scripts/mining.rs2:76-86`; lobster/harpoon/shark
  attempt labels as above; fly fishing only through the hidden op 4).

What stops it:
1. **busy2.** The flinch runs only when `busy2 = false` (`auto_retaliate.rs2:7`), and busy2 is
   `hasInteraction() || hasWaypoints()` (`engine/engine/script/handlers/PlayerOps.ts:956-958`). Woodcutting and mining re-op
   after every roll (`woodcut.rs2:101, 160`; `mining.rs2:86, 124`), so the bot must send a clear input (an item-on-item
   with no script, for example pot on bucket) on every hit tick. That is one extra input per hit, and it works.
2. **Single-way combat.** Outside a multiway zone, a second NPC cannot attack a player who fought another NPC in the
   last 8 ticks (`skill_combat/scripts/npc/npc_combat.rs2:382-390`). Two attackers need `maps/multiway.csv`.
3. **No usable attackers.** A scan of every gathering resource in a multiway zone
   (one-off scan, not committed: map locs through `packages/knowledge/src/jm2.ts`, `knowledge/npcs.json` spawns,
   `.npc` configs, `maps/multiway.csv` 8x8 zones) finds:
   - No runite, lobster, harpoon or shark spot in any multiway zone except two Ape Atoll memberfish spots (2694,2706 and
     2780,2741). No runite rock is in a multiway zone, so Lava Maze runite cannot use two attackers.
   - The only aggressive attackers with attackrate 4 in multiway zones are on Ape Atoll (jungle snakes, spiders,
     scorpions: `quests/quest_mm/configs/quest_mm.npc:1650-1663`, huntrange 1) and inactive rock crabs. Huntrange 1 means
     they attack only a player next to their spawn. In practice at the 2780,2741 spot nothing attacked in 300 ticks:
     `RESULT fail mode=flinch res=fish ... attackers=0 hitTicks=0 ... prayer=19/99 lvl=80` (Protect from Melee drained
     80 prayer points in that time). Ape Atoll also needs Monkey Madness.
   - Multiway oaks, willows, a Falador yew (2996,3311), coal and the Barbarian Village fly spots have only
     non-aggressive NPCs nearby. Barbarians have attackrate 5 (`_unpack/225/all.npc:446`), jail guards 5
     (`areas/area_draynor/configs/draynor.npc:183`), goblins and barbarian women 6. Non-aggressive NPCs stop
     attacking after the bot stops fighting back.

Measured one-attacker flinch, `scripts/measure/flinch.ts`, preset `flinch_oak_15` (Barbarian Village oak, Woodcutting 15,
steel axe, HP 40, Defence 20), 300 ticks:
- `RESULT ok mode=flinch xp0=1860 gained=15937 ticks=300 perTick=53.1 setupTicks=111 phaseTries=6 hitTicks=60 clicks=55 clears=232 drops=12 eats=0 dmgTaken=25 hp=19/40 oaks=11 lvl=41`
- `RESULT fail mode=flinch xp0=1860 gained=0 ticks=300 perTick=0.0 setupTicks=128 phaseTries=8 period=4 attackers=2 hitTicks=0 clicks=0 clears=299 ... dmgTaken=1 hp=40/40 oaks=0 lvl=15` (both barbarians stopped attacking)
- `RESULT ok mode=flinch xp0=1860 gained=17812 ticks=300 perTick=59.4 setupTicks=49 phaseTries=1 period=5 attackers=2 hitTicks=80 clicks=52 clears=232 drops=11 eats=4 dmgTaken=41 hp=18/40 oaks=13 lvl=42`

In every run only one barbarian kept attacking, every 5 ticks, so the bot rolled every 5 ticks: the click on hit
tick + 1 rolled (clicks about equal to hit ticks). Cost: 25-41 HP lost per 300 ticks, 4 lobsters, 49-128 setup ticks.
Knife 3-tick on the same oak and preset: __WCK__. One-attacker flinch is slower than the knife (5 ticks per roll
against 3) and costs food. Verdict: FAILS for every board.

## Best method per gathering board

Ticks to 99 are banded estimates from measured rates (`xpForLevel` from `packages/planner/src/curve.ts`). They are
ESTIMATE built on MEASURED practice rates, not a fresh-account run.

__BOARDS__

## What a script needs for delayed-click 3-tick fishing

- Inventory: knife, lobster pot or harpoon, 2+ logs (a log is used only on a missed cycle; carry 10-15 as a buffer),
  free slots. No bank: drop one fish on tick T+1 of each cycle.
- Stand next to the spot before the cycle starts. Re-find the spot index each cycle (spots move).
- Per cycle with `s.direct` (`packages/core/src/inprocess.ts`): T `useItemOnItem(knife, log)` and
  `clickComponent(skill_multi3:make1_a)`; T+1 `dropItem(fish)` or `closeModal`; T+2 `interactNpc(spot, visible op)`.
- Count logs as a health check. If logs drop, the inputs are splitting across ticks: cut load or stop.
- Level-up dialogs need no handling: the knife and the spot click close them.
