# Phase 2 recon: in-process control, pathfinding, doors, drops, XP, quests

Date 2026-10-22. Read from `vendor/rs-sdk` at b565f2d9 by three read-only agents. Nothing here was run unless it says so. Paths: `sdk/`, `server/` are under `vendor/rs-sdk`. `content/` is `vendor/rs-sdk/server/content`.

## 1. In-process control (no gateway)

- `lite/session.ts:103` `startSession({ host, username, password, cacheDir, quiet, onEnd, loginJitterMs })` → `LiteSession { client: LiteClient; stop(); stopped: Promise<SessionEnd> }`. It resolves after login. A 20 ms loop pumps packets.
- Use the client-owned bridge, not a hand-built collector (lite README:152-160): `client.collectBotState(serverTick)` (LiteClient.ts:913) and `client.executeBotAction(action)` (LiteClient.ts:959).
- Ticks: `client.setOnGameTickCallback(cb)` (LiteClient.ts:419). One slot only, so our shim owns it.
- BotSDK has no pluggable transport (`sdk/index.ts:272`, WebSocket only). The shim:
  1. Create `new BotSDK({ botUsername, password, autoLaunchBrowser: false, autoReconnect: false })` and never call `connect()`.
  2. Set private fields `ws = { readyState: OPEN, close(){} }`, `connectionState = 'connected'`, `authenticated = true`.
  3. Override `send`. It receives `{type:'sdk_action', actionId, action}`. Queue the actions and run one at a time, as `runner.ts:186-249` does. Count `wait` actions down in ticks. Answer with `sdk.handleMessage(JSON.stringify({type:'sdk_action_result', actionId, result}))`, then push a fresh state.
  4. On each tick, push `{type:'sdk_state', state: client.collectBotState(++tick), stateReceivedAt: Date.now()}`.
  5. Push `{type:'sdk_info', maxMessageLength}` once.
  6. Run `new BotActions(sdk)`.
  The vendor test `sdk/test/action-dispatch-failure.test.ts:9-18` uses the same pattern.
- Import `lite/dom-shim.ts` first (session.ts:15 does). Call `initPathfinding()` once (heavy, sync).
- Always pass `cacheDir`. On Windows `HOME` may be unset and the default becomes `undefined/.cache/...`.
- The tick counter must stay monotonic across re-logins, or `waitForTicks` stalls.
- opFeedback counts UNSET_MAP_FLAG only on the first collect per tick number, and only if the player tile did not change.
- Limits: about 13.8 MB and 0.42 % of one core per bot, measured with 8 bots (lite README:13-19). All bots share one event loop. Leave 1.5 s between logins (swarm.ts:432).
- One login per account. Do not also run `runner.ts` for the same bot. Wait at least 5 s before re-login after a drop. `onEnd` fires once; anything but `stopped` is a death.
- Close: `setOnGameTickCallback(null)`, `stop()`, `await stopped`. Do not call `sdk.disconnect()`; it waits for a close event that never comes.

## 2. Pathfinding

- `sdk/pathfinding.ts:156` `findLongPath(level, srcX, srcZ, destX, destZ, maxWaypoints = 500, blockedDoors = [])` → turn-point waypoints `{x,z,level}[]`. One level only. `moveNear` is true, so check that the last waypoint equals the goal. Length = sum of `max(|dx|,|dz|)` between points.
- `initPathfinding()` (:85) loads `sdk/collision-data.json` (27.5 MB): `tiles` `[level,x,z,flags]` (L0 997k, L1 182k, L2 66k, L3 22k), `zones`, and `doors` `[level,x,z,shape,angle,blockrange]` (2,696 doors: L0 2,501, L1 164, L2 31). It opens every door except 5 hardcoded `ONE_WAY_DOORS` (:73-79).
- The level-0 "mainland fill" (:101-109, x 2304-3392, z 2944-3584) makes unmapped zones walkable. Underground areas are level 0 with z + 6400.
- `walkTo` (`sdk/actions.ts:1069`) replans up to 50 times. It opens doors found along the path. A "locked" message blocks the door for 30 s. It never uses items on doors.

## 3. Doors in content (`content/scripts/doors/` and many area and quest scripts)

- A door config has `op1=Open`, a `category=` and `param=next_loc_stage,<loc>`. Triggers are `[oploc1,<locname>]` or the category trigger `[oploc1,_<category>]`. The loc-named trigger wins.
- Kinds and examples:
  - two-way: `[oploc1,_door_closed] ~open_door(500);`
  - walk-through: `_door_open_and_close`, which uses `~check_axis`
  - quest: `elenadoor2` checks `%elenaquest`
  - key: `brasskeydoor` uses `[oplocu,brasskeydoor]` with `edgevilledungeonkey`
  - skill: `miningguilddoor` checks `stat(mining) < 60`
  - always locked: `lockeddoor1`
  - one-way: `haunteddoorl/r` checks `coordz(coord) > coordz(loc_coord)`; also `funexit`
- How to classify: find the door's trigger body, then look for `stat(`, `%<quest>`, `inv_total`, `last_useitem`, `check_axis` paired with a refusal, or `mes(".*locked`.

## 4. Drops (`[ai_queue3,<npc or _category>]`, 78 files in `drop tables/scripts` plus about 88 in areas and quests)

- Each table rolls `random(128)` once and uses cumulative `if ($x < N)` thresholds. A remainder below 128 means no drop. `param=death_drop` (default `bones`) always drops.
- Sub-tables are procs in `drop tables/scripts/shared_droptables.rs2`: `~randomherb`, `~randomjewel`, `~ultrarare_getitem`, `~megararetable`, `~randomjunk`. Labels let NPCs share a table (`@goblin_drop_table`).
- Conditions: `map_members`, quest varps (`rat.rs2:9`).

## 5. XP per action (values are in tenths; awarded by `stat_advance`)

| Skill | Source of level and XP |
|---|---|
| Woodcutting | `skill_woodcutting/configs/trees.dbtable` and `.dbrow`: `levelrequired`, `productexp` (normal tree 0 / 250, oak 15 / 375, willow 30 / 675) |
| Mining | `skill_mining/configs/mine.dbtable` and `.dbrow`: `rock_level`, `rock_exp`, `rock_respawnrate` (copper 1 / 175, iron 15 / 350) |
| Fishing | obj param `fishing_struct` → `fishing.struct` `productexp`. Level is hardcoded in the spot scripts (`freshfish.rs2:26` trout 20). |
| Smelting | `smelting.struct` `levelrequired`, `productexp` (bronze 1 / 62, iron 15 / 125) |
| Smithing (anvil) | `smithing.dbrow` level and `bar_amount` × `smithing.struct` `xpperbar` |
| Cooking | `cooking_source/cooking_generic.dbtable` (58 rows: level, experience, successchance) |
| Others with dbtables | fletching, runecraft, gem, leather, magic, prayers, pickpocket, stalls, trapped chests, locked doors |

## 6. Quests

- One perm varp per quest (`quests/quest_<x>/configs/quest_<x>.varp`). Ids are in `pack/varp.pack` (`29=cookquest`, `101=qp`).
- Complete values and quest points are in `general/configs/quest.constant` (`^cook_complete = 2`, `^cook_questpoints = 1`).
- `[proc,count_questpoints]` (`general/scripts/quests.rs2:96-302`) lists the varp, complete value and QP of every quest. Names are in `general/configs/quest.enum`.
- XP rewards are `stat_advance` calls in the completion queue (Cook's Assistant: `stat_advance(cooking, 3000)` = 300 XP).
- Requirements are inline checks (`%qp < 32`, `stat(...) <`).
