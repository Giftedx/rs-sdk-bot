# Game tricks on this server, and how we use them (2026-10-23)

Sources: a web catalog of known RuneScape tricks (OSRS wiki and others; every rate there is an Old School figure),
and a code check of this server (`vendor/rs-sdk/server`). Status: **proven** = measured here; **code** = read in
the code, not measured; **no** = does not work here.

| Trick | Status | Evidence | Use |
|---|---|---|---|
| 3-tick gathering: knife on a log + "Make 1" + click the resource, all in one tick | **proven** for woodcutting: +29% (oaks, 3 runs each: 55.9/49.8/61.4 vs 42.6/42.4/44.5 XP/tick). No log used | `scripts/measure/wc-3tick.ts`; delay set at `skill_fletching/scripts/cut_logs.rs2:83`, log removed only in the queue | Woodcutting board (leader 3,329; model 3,852 x 0.75 = about 2,900). Next: fishing (5-6 -> 3 ticks), mining below rune |
| 3-tick fly fishing (Lure, knife on log, Make 1, all one tick) | **measured** about +29%: normal 107.0/67.5/106.3, 3-tick 119.2/105.1/139.9 XP/tick (Lumbridge river, from Fishing 20, 300 ticks). 1-2 logs used per 300 ticks (missed clicks let the fletch finish) | `scripts/measure/fish-3tick.ts`; `freshfish.rs2:37-50` | Fishing board (leader 3,425). Net spots: plain and hidden-op clicks both failed on the Draynor net spot (0 XP); not understood yet |
| The 3 messages must go in one tick | **proven** | shim queue spreads SDK actions over ticks (`packages/core/src/inprocess.ts` pump); `s.direct` gives 3 in one tick | Every tick trick uses `s.direct` |
| Instant item-on-item, 5 per tick | code | herblore, bow stringing, arrows/darts (15 per action), gem cutting have no delay (`skill_fletching/scripts/arrows.rs2:68-86` and others) | Fletching, Herblore, Crafting boards; supply is the limit |
| Prayer flicking | code | 5-tick drain timer, cleared when all prayers go off (`skill_prayer/scripts/prayer.rs2:30-43,163`) | Combat accounts: free protection prayers |
| Infinite run | code + seen | `NODE_INFINITE_RUN` defaults true (`engine/src/util/Environment.ts:47`); energy stayed 100 | Always run |
| Aggression tolerance (about 10 min) | code | `updateAfkZones` 1,000 ticks (`engine/src/engine/entity/Player.ts:2189-2217`) | Combat camps |
| Melee safespots | code | NPCs path naive (`Npc.ts:78`) | Combat training |
| Karambwan / potions: no eat delay | code | `consume.rs2:29-40,94-106` | Combat and thieving food: no attack delay |
| Normal food adds 3 to the action delay | code | `consume.rs2:110-131` | Eat only inside stuns or between actions |
| Click locs while standing still | code | loc ops run in the arrival tick only if no steps (`Player.ts:1348`) | Saves 1 tick per first click |
| Pickpocket stun cancel | **no** | only thieving writes `%stunned`; it also blocks walking | Eat inside the stun |
| Lockpick doors (no stun) | measured, no gain | 29-34 XP/tick at 16-36 (`scripts/measure/door-bench.ts`) | none |
| Relog clears the stun; offline waits are free | measured (practice) | 1 playtime tick per relog; +17% thieving | **Not used live**: not approved by the owner |
| Attack-delay reset, agility skips, cooking/smithing speed-ups | **no** | fixed `p_delay` / `%action_delay` | none |
