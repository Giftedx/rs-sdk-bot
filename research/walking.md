# Walking without stalls (2026-10-23)

Owner complaint: "you move like a total moron. learn how a speedrunner and a pro at the game would move and
master it." This file gives the stall causes in the old walk, the new walker `walkPath`
(`packages/core/src/walk.ts`), and the measured gain. All tick counts are in game ticks.

Evidence levels: MEASURED practice (local server, 150 ms tick), CODE-READ, MEASURED live (logs from earlier live
runs only; this task did not connect to the live server).

## How a fast player moves

- A player clicks ahead on the minimap before the run ends. The character never stops between clicks.
- Running covers 2 tiles per tick. The floor for a route is tiles / 2.
- A player clicks a door or gate once. The character runs to it and opens it. On the tick it opens, the player
  clicks past it.
- A player who sees the character stop clicks again at once. A player does not wait for a timer.

## Stall causes in the old walk (bot.walkTo per waypoint)

The old walk is the `walk()` helper in `gecourier.ts` and `thieving60.ts`: up to 3 `bot.walkTo(x, z, tol)` calls per
waypoint. `bot.walkTo` is `_walkToRoute` in `vendor/rs-sdk/sdk/actions.ts:1080-1322`.

| # | Cause | Code | Cost (MEASURED practice) |
|---|---|---|---|
| 1 | **Waits for arrival at each path corner before the next click.** `walkStepToward` sends one walk to a corner, then `waitForMovementComplete` waits until the bot is within 2 tiles of it. The run then ends early, so the bot takes 1 step, or none, in that tick. | `actions.ts:1289`, `actions-helpers.ts:382-411`, `:294-373` | Musa Point to Brimhaven: 32 one-step ticks of 131; Port Sarim to GE: 59 one-step ticks of 291 (trace `TRACE ... d=1`) |
| 2 | **Door handling waits on the server, then 1 more tick.** `openDoorAt` sends the open, waits for the loc to change (`waitForCondition`, up to 8 s), then `waitForTicks(1)`, then the next walk click. | `actions.ts:1243-1246`, `actions-helpers.ts:436-500` | 3 to 4 still ticks per door or gate: gate 1597 (2816,3183), door 1530 (3228,3240), gate 1551 (3236,3296), gate 1596 (2816,3182) |
| 3 | **Opens doors that are not on the route.** The SDK opens every door on or next to a path tile (`findDoorsAlongPath` checks 4 neighbours). | `actions.ts:1216-1243`, `sdk/pathfinding.ts:235-259` | Brimhaven to Musa Point: door 350 at 2813,3178 opened, then gate 1596: 6 still ticks. The live log has `cant_reach` on locs 1530, 368 and 350. |
| 4 | **Stuck detection takes 2 ticks.** When a corner click does not move the bot, `waitForMovementComplete` waits `STUCK_TICKS = 2` ticks before the next click. | `actions-helpers.ts:302`, `:362-365` | 3 still ticks at 3150,3264 and at 3210,3333 on every Port Sarim to GE run |
| 5 | **Start of walk.** The first click shows in the state after 2 ticks. The old and new walks both have it. | server tick + state collected before the position snap (`lite/LiteClient.ts:256-279`) | 2 ticks per walk, both walkers |
| 6 | **Pathfinder calls the start tile blocked.** rs-sdk collision says 2774,3228 (beside the Brimhaven customs officer) is not walkable, so `findLongPath` gives 0 waypoints. | `sdk/pathfinding.ts:205-208` | Old walk: `PATHFINDING FAILED: no waypoints - from (2774, 3228) to (2800, 3200)`, the walk fails in 3 ticks. The live courier log has the same failure from (2792,3203). |

Causes that are not the walk:

- **Boat trip, about 8 idle ticks.** The 7-tick `p_delay($delay)` of the voyage (`server/content/scripts/interface_boat/scripts/sail.rs2:22`, delay 7 for the Port Sarim sailors at `areas/area_port_sarim/scripts/sailors.rs2:31` and the customs officers at `areas/area_karamja/scripts/customs_officer.rs2:82-84`). The bot cannot act inside it.
- **The 19 to 25 tick live idles (Bigpackage).** They are not in the practice traces: the longest still streak on practice was 4 ticks. The live log has a 24-tile jump in one tick, `784:3114,3264->3138,3264`, right after the 25-tick idle at t759 (3114,3264). The client saw no movement for many ticks and then all of it at once. The cause is a burst of server packets after a pause of our process or of the network, not the walk logic. The ledger reads the position before the client snaps it (`lite/protocol/incoming.ts:357` calls `notifyGameTick` inside the packet loop; the snap runs after the loop, `lite/LiteClient.ts:256-261`), so a burst shows as idle ticks and then a jump. Live tick traces of a walk are needed to tell real server idle from this. ESTIMATE from MEASURED live logs.
- `findLongPath` is not slow: 0.1 to 10 ms per leg after the first call (562 ms for the first call in a process). MEASURED practice (scratchpad `pftime.ts`).

## The new walker: walkPath

`walkPath(deps, points, opts)` in `packages/core/src/walk.ts`, with `sessionWalker(session)` for an in-process session.

1. Plan once: `findLongPath` from the bot through every point, expanded to single tiles. If the planner gives 0
   waypoints (cause 6), take the straight line; the client routes each click itself.
2. Decide on every tick, from the tick callback. Send at most one input per tick, straight to the client
   (`session.direct`), not through the SDK action queue.
3. Click 20 tiles ahead on the path. Click again when 6 tiles of the last click remain (3 ticks of running), so
   the route never runs out (cause 1).
4. A shut door or gate on the path within 20 tiles (the loc is on a path tile and has "Open"): send one loc click.
   The server runs the bot to it and opens it. On the tick the loc no longer has "Open", click past it (causes 2, 3).
5. One tick with no step: click again. Two ticks with no step: plan again from the bot's tile and click. Four
   ticks next to a shut door that is not on the path: open it (cause 4).
6. Off the path by more than 3 tiles: plan again from the bot.
7. Before the first click, click the run button on (`controls:com_5`, component 153,
   `server/content/scripts/interface_controls/scripts/player_controls.rs2:34-47`). The walk click also sends ctrl
   (run) for each move. Loc clicks have no ctrl, so without the toggle the bot walks to a door at 1 tile per tick.
   Ctrl run needs run energy of 100 or more (`engine/src/network/game/client/handler/MoveClickHandler.ts:34-39`).
8. No timers. A tick budget (path tiles + 60) ends a walk that cannot finish.

Unit tests: `packages/core/test/walkpath.test.ts` (6 tests: tile expansion, 2 tiles per tick with at most one input
per tick, door open and click past, re-click after a stall, budget, planner fallback).

## Before and after (MEASURED practice, 3 runs per cell)

Bench: scratchpad `walk/bench.ts` (old = the scripts' `walk()` loop with `bot.walkTo`; new = `walkPath`). One
fresh preset account per run at the leg start, random events handler off. "Still" = ticks with no tile gained.

| Leg (waypoints as in the scripts) | Old ticks | New ticks | Old still | New still | Floor (tiles / 2) |
|---|---|---|---|---|---|
| Musa Point 2956,3146 to Brimhaven 2774,3228 | 129, 125, 125 | 110, 107, 106 | 5, 2, 2 | 6, 3, 2 | 102-108 |
| Port Sarim 3029,3217 to GE 3181,3440 | 291, 284, 291 | 241, 241, 241 | 15, 11, 16 | 2, 2, 4 | 236-247 |
| GE 3181,3440 to Port Sarim 3029,3217 | 280, 274, 279 | 240, 238, 241 | 9, 4, 9 | 5, 2, 5 | 236-239 |
| Brimhaven 2772,3225 to Musa Point 2956,3146 | 147, 146, 135 | 107, 104, 107 | 12, 10, 4 | 4, 3, 4 | 100-112 |
| Lumbridge 3222,3218 to Port Sarim 3029,3217 | 159, 163, 161 | 142, 143, 143 | 2, 7, 4 | 4, 2, 2 | 139-144 |

Quoted lines (examples):

- `BENCH mode=old leg=sarim ticks=291 tiles=493 still=15 walks=94 ok=true`
- `BENCH mode=new leg=sarim ticks=241 tiles=474 still=2 walks=39 ok=true clicks=39 repaths=5 doors=0`
- `BENCH mode=old leg=karamja ticks=129 tiles=216 still=5 walks=48 ok=true`
- `BENCH mode=new leg=karamja ticks=106 tiles=207 still=2 walks=19 ok=true clicks=19 repaths=3 doors=0`

The new walk is faster on every leg and every run, and sends about 40% of the clicks. It is 1 to 6 ticks above
the floor; the 2-tick start (cause 5) and one door or gate make most of the rest.

## Script proofs (MEASURED practice, 1 run each)

| Script | Preset | Before (earlier proof) | After |
|---|---|---|---|
| `gecourier.ts` DRY=1 | `courier_ardougne` | `ticks=1030-1031 walkTicks=907-909` (3 runs, scratchpad `gecourier.log`) | `RESULT ok ... ticks=865 walkTicks=748 boatTicks=106 geTicks=8 dry=true ...`, `LEDGER ticks=870 ... idle=69 idlePct=7.9` |
| `thieving60.ts` | `floors_lumbridge` | Ardougne at tick 499-604 (`thieving60.ts` comment) | `MILESTONE coins60 122`, `MILESTONE ardougne 455`: the trip took 333 ticks. `RESULT ok thieving=60 xp=66287 ticks=1376 ... died=false` |

The thieving60 proof ran with the random events handler off (`RANDOM_EVENTS=0`), like the benches. One run is not a rate.

## Boat talk (MEASURED practice, Port Sarim seaman to the Musa Point deck)

Ticks from the talk to the landing on the deck, 3 runs each:

| Method | Ticks | Dialog ticks |
|---|---|---|
| Old: `bot.talkTo`, then `sendClickDialog` through the SDK queue and `waitTicks(1)` per page | 18, 20, 17 | 7, 7, 7 |
| Direct: talk and every answer sent with `session.direct` on the tick each page opens | 18, 20, 18 | 7, 10, 7 |

Same-tick answers do not remove the idle ticks. The trace shows a new page every 2 ticks with both methods (page
open, the answer, the server sends the next page). After the last page the bot stands 7 to 8 ticks: that is the
voyage `p_delay(7)` (`sail.rs2:22`). The direct method is not in the scripts, because it was not faster.

## Open

- Live walk traces: tell real server idle from packet bursts (see above). Needs a live run with a per-tick trace.
- The Port Sarim to GE waypoints go through Lumbridge (danger-checked route). `findLongPath` from 3029,3217 to
  3181,3440 is 57 corners on a shorter line; check it with `bun research/route-danger.ts` before use.
- `disembark()` and `sail()` still use the SDK queue. They were not measured slower, but they were not changed.
