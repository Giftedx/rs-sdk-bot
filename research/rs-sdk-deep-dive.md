# rs-sdk deep dive

Source: `vendor/rs-sdk` (MaxBittker/rs-sdk, MIT), HEAD `b565f2d9`. All paths below are relative to
`vendor/rs-sdk/` unless noted.

**Evidence level.** Everything here comes from reading source files and docs. Nothing was installed,
built, or run. Where the docs and the code disagree, the code wins, and the note says so.

---

## 1. Architecture and data flow

```
 SDK script / MCP execute_code / sdk/cli.ts            (Bun process, sdk/index.ts BotSDK + sdk/actions.ts BotActions)
        |  WebSocket JSON  (sdk_connect / sdk_action / sdk_state / sdk_action_result)
        v
 Gateway  server/gateway/gateway.ts   ws+http :7780 (AGENT_PORT); optional deflate listener GATEWAY_PUBLIC_PORT
        |  WebSocket JSON  (connected / state / actionResult / action / save_and_disconnect)
        v
 Game client = "bot client"  (one per bot)
   a) browser botclient: server/webclient/src/bot/* inside the full TS client, page view/bot.ejs at http://<engine>:8888/bot?bot=&password=
   b) headless lite client: server/webclient/src/lite/runner.ts (same StateCollector/ActionExecutor, no rendering)
        |  RS289 binary game protocol (RSA/ISAAC login) over WebSocket to the engine web port
        v
 Engine  server/engine/src/app.ts   web :8888 (game WS + pages + /gateway relay), TCP :43594 (Java client), mgmt :8898, hiscores :8889
```

Key facts:

- **The SDK never talks to the engine.** It talks to the gateway. The gateway routes by username to the
  one bot client registered for that name (`botSessions` map, `server/gateway/gateway.ts` ~line 230).
  Without a client, a script exits with `No game client is attached` (`sdk/runner.ts`
  `requireLiveClient`, waits 10 s for a new `tick`).
- **Engine `/gateway` relay.** `server/engine/src/web/websocket.ts:116` proxies `/gateway` to
  `ws://localhost:7780/` (hardcoded port; it ignores `AGENT_PORT`). The demo uses
  `wss://rs-sdk-demo.fly.dev/gateway`, or the direct deflate port `wss://rs-sdk-demo.fly.dev:7443`
  (`DIRECT_GATEWAYS` in `sdk/index.ts:92` and `lite/runner.ts:369`).
- **Controller pre-emption.** "Last controller wins." A new `control`-mode SDK connection kicks the
  existing controller (`gateway.ts` ~line 209). `observe` mode is read-only plus the `say` action. It
  never pre-empts and is never pre-empted (`sdk/chat.ts` uses it). MCP and a standalone script on the
  same bot fight each other.
- **Auth.** `LOGIN_SERVER=true` makes the gateway check credentials against the login server on
  `LOGIN_HOST:LOGIN_PORT` (default `localhost:43500`, message `sdk_auth`, 15 s timeout). With it off,
  the gateway accepts every connection ("development mode", `authenticateSDK`). Bind address is
  `GATEWAY_HOSTNAME` (default `0.0.0.0`).
- **Outdated-client hint.** The engine records refused old-revision logins on mgmt `:8898
  /outdated-client?username=`. The gateway reports this through `sdk_error`. Public `/api/version`
  returns `{revision}` (289). The lite runner checks it and exits with code **3** on a mismatch.

### Gateway message formats (`server/gateway/types.ts`)

| Direction | `type` values | Notable fields |
|---|---|---|
| bot client -> gateway (`BotClientMessage`) | `connected`, `state`, `actionResult`, `setGoal`, `screenshot_response` | `username`, `password`, `state: BotWorldState`, `actionId`, `result`, `maxMessageLength` |
| gateway -> bot client (`SyncToBotMessage`) | `action`, `thinking`, `error`, `status`, `screenshot_request`, `save_and_disconnect` | `action: BotAction`, `actionId`, `actionTimeoutMs` |
| SDK -> gateway (`SDKMessage`) | `sdk_connect`, `sdk_action`, `sdk_screenshot_request` | `username`, `password`, `mode: 'control'\|'observe'`, `action`, `actionId`, `actionTimeoutMs` |
| gateway -> SDK (`SyncToSDKMessage`) | `sdk_connected`, `sdk_state`, `sdk_action_result`, `sdk_error`, `sdk_screenshot_response`, `sdk_info` | `state`, `stateReceivedAt`, `result`, `mode`, `maxMessageLength` |

`BotAction` is a discriminated union in `sdk/types.ts:604`, and a copy lives in
`server/webclient/src/bot/types.ts`. Each action needs an `ActionExecutor` case (PATCHES invariant 4).
The variants are `none, wait, talkToNpc, interactNpc, interactPlayer, clickDialogOption (+guard
{pageId,componentId}), clickComponent (IF_BUTTON), clickComponentWithOption (INV_BUTTON),
acceptCharacterDesign, randomizeCharacterDesign, walkTo, useInventoryItem, useEquipmentItem, dropItem,
pickupItem, interactGroundItem, interactLoc, shopBuy, shopSell, closeShop, closeModal, setCombatStyle,
useItemOnItem, useItemOnLoc, useItemOnNpc, say, privateMessage, spellOnNpc, spellOnPlayer, spellOnItem,
spellOnGroundItem, setTab, bankDeposit, bankWithdraw, searchGE, submitCountDialog, scanNearbyLocs,
scanGroundItems, togglePrayer`. Every variant carries a `reason: string`.

Bot-client side: `BotActionQueue` (`server/webclient/src/bot/ActionQueue.ts`) holds at most 64 pending
entries with a 55 s TTL. The SDK default `actionTimeout` is 60 s (`sdk/index.ts:218`).

### Gateway HTTP endpoints (`gateway.ts` ~line 896-1180)

`GET /status`, `GET /status/:username` (controllers, observers, state age), `GET /chat/:username?limit=&system=1`,
`GET /state/:username` (authenticated, last cached state), `POST /say/:username {"text"}`,
`POST /dm/:username {"to","text"}`, `GET /traffic`, `GET /traffic/fields` (internal only).
The `/state` endpoint lets a harness read state without opening a control connection.

### Lite client (`server/webclient/src/lite/`, see its `README.md`)

- It is a facade over the browser `Client`. `StateCollector.ts` and `ActionExecutor.ts` run against it
  **unmodified**, so `BotWorldState` is the same in both clients. The README measured 13.8 MB and
  0.42 % CPU per bot.
- No rendering, no screenshots (`sendScreenshot` cannot work), no minimenu, no OnDemand models.
- Entity positions snap to `routeX[0]` (no interpolation). This is more accurate than the browser.
- Collision rebuilds lazily after `LOC_ADD_CHANGE`/`LOC_DEL` (~15 ms, on the next route).
- Ends loudly: `SessionEnd` is `stopped|logged-out|disconnected|idle|error`. `runner.ts` exits non-zero
  on anything except `stopped`. A runner supervises one bot only, so re-login is the caller's job.
- `swarm.ts` runs N lite clients in one process with an **in-process** tick loop and no gateway. The
  file header measures a pickpocket at "about 2.0s per attempt" through the gateway against prod,
  versus 2 ticks in-process. This is the best model for a low-latency harness.
- Cache: `${process.env.HOME}/.cache/rs-sdk-lite` (`lite/session.ts:109`). **Windows risk:** if `HOME`
  is unset (PowerShell), this path becomes `undefined/.cache/...` relative to cwd. Not verified.
  Git Bash sets `HOME`.

---

## 2. State observation (`BotWorldState`, `sdk/types.ts:558`, built in `server/webclient/src/bot/StateCollector.ts:148`)

| Field | Content |
|---|---|
| `tick` | **Client-local counter**: it goes up by one on each `PLAYER_INFO` packet (`BotOverlay.ts:81`, `lite/runner.ts:63`). It is not the server tick, and it resets when the client restarts. |
| `revision` | Monotonic publication counter. Can advance more than once per tick (after action results). |
| `inGame`, `player` | name, combatLevel, hp/maxHp, x/z (local) and worldX/worldZ, `level` (plane), runEnergy, runWeight, animId, spotanimId, `combat {inCombat,targetIndex,targetType,lastDamageTick}`, isDead, lifeId, respawnCount, lastDeathTick |
| `skills[]` | name, level (boosted), baseLevel, experience |
| `inventory[]`, `equipment[]` | slot, id, name, count, `optionsWithIndex[{text,opIndex}]`. The array is **compacted**: always use `.slot`, never the array index. |
| `nearbyNpcs[]` | kind:'npc', id (type), **index** (world slot, used by packets), name, combatLevel, x/z (render), tileX/tileZ (authoritative SW tile), size, distance, hp/maxHp/healthPercent (null until revealed), targetIndex, inCombat, lastCombatTick, animId, spotanimId, options, **reachable** |
| `nearbyPlayers[]` | kind:'player', index, name, combatLevel, x/z, distance, reachable, combatTarget* |
| `nearbyLocs[]` | id, name, x, z, level, distance, options, reachable. Default scan radius **15 tiles**, Chebyshev distance, clipped to the 104x104 build area (`StateCollector.ts:1088`). |
| `groundItems[]` | id, name, count, x, z, distance, reachable. Radius 15. |
| `gameMessages[]` | type (0 system, 1/2 public, 3 PM in, 6 PM out, 7 crowned PM), text, sender, tick, observationId, fromSelf. Capped at **50** (`MAX_GAME_MESSAGES`). The SDK keeps **500** of history (`sdk/chat-history.ts`). |
| `recentDialogs[]` | text lines, tick, interfaceId |
| `dialog` | isOpen, options[{index (1-based, server-assigned), text, componentId, buttonType}], isWaiting, pageId, text, allComponents |
| `interface` | isOpen, interfaceId, options[{index (1-based label), text, componentId}] (crafting menus) |
| `shop`, `bank`, `trade`, `ge` | shop items with prices (haggle formula reimplemented at `StateCollector.ts:1561`), bank items plus `noteMode` (varp 115), trade screens, private GE state |
| `modalOpen`, `modalInterface` | from `mainModalId` |
| `combatStyle` | currentStyle, weaponName, styles, tabInterfaceId, known |
| `combatEvents[]` | at most 50, expire after 50 ticks |
| `prayers` | activePrayers[15], prayerPoints, prayerLevel |
| `isSkulled` (varp 78), `autoRetaliateEnabled` (varp 172) | |
| `opFeedback` | mapFlagUnsetCount, opRejectedCount (an `UNSET_MAP_FLAG` that arrives while the player stands still means a probable server refusal), last ticks |
| `fastKbd*`, `combatTargetTelemetryVersion` | fleet-specific (King Black Dragon) lite-runner telemetry |

**Freshness and timing.**
- The bot client publishes on every `PLAYER_INFO` (once per server tick), and again right after each
  action result. The gateway drops a second frame from the same tick when it is identical except for
  `revision` (`server/gateway/state-fanout.ts`).
- The frame is the **full JSON state every tick**. There are no deltas.
- `getStateAge()` mixes gateway and local clocks (`stateReceivedAt`). The runner compares ticks instead.
- Default tick is **400 ms** (`NODE_TICKRATE`, `server/engine/src/util/Environment.ts:54`). The authentic
  value is 600 ms. The API docs still say "~300ms each" (`waitForTicks`, `waitForStateUpdate`): that
  text is stale.
- `reachable` comes from a flood fill on the client collision map for each collect
  (`server/webclient/src/bot/reach.ts`). `setReachabilityEnabled(false)` turns it off for swarms.
- `menuActions` exists in the browser state but the SDK does not read it.
- Not observed: other players' equipment, NPC drop tables, the minimap, ground items beyond radius 15
  (use `scanGroundItems(radius)`), and anything off the current plane.

---

## 3. Action API (`sdk/API.md`, generated by `sdk/generate-api-docs.ts`; CI fails on drift)

The rule (`sdk/API.md` "Execution model"):
- `bot.*` (porcelain, `sdk/actions.ts`, 5051 lines) tries to observe method-specific evidence.
- `sdk.send*` (plumbing, `sdk/index.ts`) confirms only that the **client dispatched** the packet.
- `ActionResult.phase` is `validation|routing|dispatch|observation|completion`, and it says how far
  the evidence goes.

### bot.* (59 rows in API.md)

| Category | Methods | Evidence of effect |
|---|---|---|
| Grand Exchange | `openGE, searchGE, placeGEOffer, cancelGEOffer, collectGEOffer, collectGE` | Server receipt token. `outcome:'confirmed'\|'unknown'`. `placeGEOffer` never retries confirmation. |
| UI and dialog | `skipTutorial({randomizeAppearance}), dismissBlockingUI, waitForDialogClose, navigateDialog(choices)` | dialog state |
| Doors | `openDoor(target?)` | loc change; reasons `already_open`, `open_failed`, ... |
| Other | `useItemOnLoc, useItemOnNpc, dropItem(target, amount\|'all'), closeInterface` | dropItem re-resolves the slot and waits for each drop. useItemOn*: weak (timeout/cant_reach). |
| Woodcutting / Firemaking | `chopTree(target?), burnLogs(logs?)` | logs in inventory; Firemaking XP |
| Items | `pickupItem(target)` | item in inventory; `taken_by_other` |
| NPC / object | `talkTo, interactLoc(target, option), interactNpc(target, option), pickpocketNpc` | interact*: an animation, dialog or interface counts as success ("action started"), so this is weak. pickpocket: XP vs stun, plus `rejected`/`dispatch_failed`. |
| Movement | `walkTo(x, z, tolerance=3, {timeout=120s})` | position within tolerance; aborts on death or stale state |
| Shopping | `openShop, closeShop, buyFromShop, sellToShop` | inventory delta. `partial`, `amountBought`/`amountSold`. |
| Banking | `openBank, closeBank, depositItem, withdrawItem(target, amount, {asNote})` | inventory/bank delta, `partial` |
| Trading | `tradeWith, offerTradeItems, acceptTrade, declineTrade, trade(target, {give,want,accept}), serveTrades` | inventory delta (`gave`/`received`), confirm-screen recheck |
| Combat / equipment | `equipItem, unequipItem, getEquipment, findEquippedItem, eatFood, attack, attackPlayer, castSpell, castSpellOnPlayer` | eat: hpGained. castSpell: Magic XP (a splash counts as success, `hit:false`). attack: engagement, not a kill. |
| Waiting | `waitForSkillLevel, waitForInventoryItem, waitForIdle` | state predicates |
| Crafting / smithing | `fletchLogs(product), craftLeather, smithAtAnvil(product), craftJewelry, enchantItem, stringAmulet` | XP and product |
| Mining | `mineRock(target)` | ore in inventory plus Mining XP (strong) |
| Prayer | `activatePrayer, deactivatePrayer, deactivateAllPrayers` | prayer varps |

There are **no** porcelain helpers for smelting (`interactLoc 'smelt'` plus the dialog), fishing
(`interactNpc 'net'`), cooking, burying bones, alchemy (`sdk.sendSpellOnItem`), runecrafting, agility,
herblore, stairs or ladders (`interactLoc` treats a level change as evidence, `actions.ts:4179`),
quests, or death/gravestone recovery. Integration scripts in `sdk/test/*.ts` (agility, alchemy,
runecrafting, herblore, cooking, ...) show the raw patterns.

### sdk.* (116 rows in API.md)

- **Connection:** `connect, disconnect, onConnectionStateChange, onStateUpdate, isConnected,
  isAuthenticated, getConnectionState, getReconnectAttempt, getConnectionMode, isBotConnected,
  checkBotStatus, launchBrowser, waitForBotConnection, waitForConnection, waitForReady`.
- **State:** `getState, getStateReceivedAt, getStateAge, getSkill/getSkillXp/getSkills,
  getInventoryItem/findInventoryItem/getInventory/countInventoryItems, getEquipmentItem/findEquipmentItem/getEquipment,
  getBankItem/findBankItem/getBankItems/isBankOpen, getNearbyNpc/findNearbyNpc/getNearbyNpcs,
  findNearbyPlayer/getNearbyPlayers, getNearbyLoc/findNearbyLoc/getNearbyLocs, findGroundItem/getGroundItems,
  getDialog, getTradeState, getPrayerState/isPrayerActive/getActivePrayers, getGEState`.
  `find*` takes `FindOptions {reachable, withOption}`. The shortest matching name wins, then the
  nearest, and reachable targets are preferred.
- **Chat:** `getChat, getNewChat (cursor), getChatFrom, waitForChat, waitForTradeRequest, say, dm,
  sendSay, sendPrivateMessage`. The cap is 400 chars, and the server takes one social packet per tick.
- **Waiting:** `waitForCondition(pred, timeout)` (**throws** on timeout), `waitForStateChange,
  waitForStateUpdate, waitForTicks(n)`.
- **Scanning (async):** `scanNearbyLocs(radius), scanGroundItems(radius), scanFindNearbyLoc,
  scanFindGroundItem`.
- **Pathfinding:** `findPath(x, z, maxWaypoints=500)` (sync, local collision), `sendFindPath` (async
  alias), `blockDoorTemporarily, isDoorTemporarilyBlocked`.
- **Raw actions (dispatch only):** `sendWalk, sendInteractLoc, sendInteractNpc, sendInteractPlayer,
  sendTalkToNpc, sendPickup, sendUseItem(slot, option, interfaceId?), sendUseEquipmentItem, sendDropItem,
  sendUseItemOnItem, sendUseItemOnLoc, sendUseItemOnNpc, sendClickDialog(index; 0 = continue),
  clickDialogByText (page-guarded), sendClickComponent, sendClickComponentWithOption,
  sendClickInterfaceOption(0-based array position), clickInterfaceOption(selector),
  sendAcceptCharacterDesign, sendRandomizeCharacterDesign, sendShopBuy/Sell, sendCloseShop,
  sendCloseModal, sendCountDialog, sendTradeRequest, sendOfferItem, sendRetractItem, sendAcceptTrade,
  sendDeclineTrade, sendSetCombatStyle, sendTogglePrayer, sendSpellOnNpc/OnPlayer/OnTarget/OnItem/OnGroundItem,
  sendSetTab, sendWait, sendBankDeposit/Withdraw, sendScreenshot (browser only), sendGESearch`.
- **Market (HTTP, no bot needed):** `getGEAvailability, getMarketItems, getMarketItem, getMarketHistory`.

Index traps the docs call out:
- `DialogOption.index` is 1-based and server-assigned.
- `sendClickInterfaceOption` takes a 0-based array position, but `InterfaceOption.index` is a 1-based
  label.
- Skill dialogs publish four buttons per product (Make X/10/5/name).
- A modal (bank/shop) hides the inventory, and the server **silently** drops inventory packets.

### The two silent failure modes (`CLAUDE.md` Troubleshooting)

1. The client cannot route, so it returns `cant_reach` and sends no packet. Check `reachable` first.
2. The server refuses the op (mid-action, stunned, target gone, bad option). It answers only
   `UNSET_MAP_FLAG`. When a modal blocks, the server accepts the op and never runs the trigger. Compare
   `state.opFeedback.opRejectedCount` before and after.

---

## 4. Pathfinding and collision

- **SDK side** (`sdk/pathfinding.ts`): rsmod-pathfinder compiled to WASM
  (`server/vendor/rsmod-pathfinder/rsmod_bg.wasm`). It loads `sdk/collision-data.json` (27.5 MB,
  `{tiles, zones, doors}`), exported from the engine `/api/exportCollision`
  (`bun run fetch-collision-data -- --force --server=http://localhost:8888`, default server is the demo).
- `findLongPath` runs a 2048x2048 BFS (+/-1024 tiles) on **one plane** (`level` taken from the
  player), size 1x1, `CollisionType.NORMAL`, at most 500 waypoints.
- **Doors are pre-unmasked:** every door wall is removed at init (`changeWall(add=false)`), so routes
  assume every door can open. Exceptions: `ONE_WAY_DOORS` (Draynor Manor front door, Melzar's Maze exit).
  Locked doors are discovered at runtime and blocked for 30 s per SDK session (`TemporaryDoorBlocklist`).
- **Mainland fill hack:** every unallocated zone in x 2304-3392, z 2944-3584 on level 0 is allocated
  as OPEN (walkable). This can create false routes over water or void. `isZoneLikelyLand` exists, but
  `findLongPath` does not use it.
- **walkTo loop** (`sdk/actions.ts:1069-1320`): up to 50 iterations. It re-queries the path, walks
  waypoint by waypoint (`helpers.walkStepToward`, tolerance 2), and opens doors within 15 tiles that
  are on or next to the path. It retries a door 3 times and then blocks it. When a partial path ends at
  the same tile twice, it fails with "locked door or separate room?". After 3 iterations with no
  progress, it tries a door and then fails. It aborts on death (lifeId change) or on state older than
  10 s.
- **Client side:** every interaction first calls `tryMove(..., type=2)` in the client
  (`Client.ts`/`lite/movement.ts`). The engine runs with `clientRoutefinder=true`, so **the server does
  not pathfind to interaction targets** (PATCHES "Walk-before-op"). Client routing covers only the
  104x104 build area.
- **Limits:**
  - No plane transitions: stairs, ladders and trapdoors must be scripted.
  - No transports: boats, ferries (`sdk/test/karamja-ferry.ts`), gnome gliders, fairy rings, carpets.
  - No agility shortcuts.
  - No teleport planning.
  - No danger or wilderness avoidance, no aggro awareness, no cost for closed gates or tolls (the Al
    Kharid toll needs a dialog).
  - The collision snapshot goes stale when content changes (the README mentions a 442-vs-483
    mapsquare drift).
  - Init is synchronous and slow ("tens of seconds on slow hosts", `sdk/runner.ts`), so the runner
    warms it before it opens the socket.
  - The search is BFS with no heuristic. 500 waypoints is enough for most mainland routes, but
    cross-map routes may be partial (`reachedDestination:false`).

---

## 5. MCP server and agent instructions

- **Config:** `.mcp.json` (Claude), `.codex/config.toml`, `.gemini/settings.json`, `opencode.json`.
  All of them run `bun run mcp/server.ts` (stdio, server name `rs-agent-bot`).
- **Tools** (`mcp/server.ts`):
  - `execute_code(bot_name, code, timeout?)`. The timeout is in minutes, default 2, clamped to 0.1-60.
  - `list_bots()`.
  - `disconnect_bot(name)`.
  - `get_market({origin, operation: status|items|item|history, query, item_id, sort, days})`
    (`mcp/market-tools.ts`).
  - Resources: `file://../sdk/API.md`, `file://../sdk/MARKET.md`.
- **execute_code semantics** (`mcp/execute-code.ts`):
  - The `BotManager` (`mcp/api/index.ts`) connects on first use. It reads `bots/<name>/bot.env`
    (`GATEWAY_URL` wins over `SERVER`) and connects in `control` mode with `autoLaunchBrowser:'auto'`:
    if no client has fresh state (<3 s), **it opens a browser tab** at `http://localhost:8888/bot?...`
    (local) or the remote origin. A lite runner that is already running stops the tab from opening.
  - **One execution per bot.** A new call aborts the previous one (`BotExecutions`). Different bots run
    concurrently.
  - Before it runs the code, it waits up to 15 s for fresh or in-game state. If the state is stale, it
    still runs and prints a warning.
  - The code is wrapped as `async (bot, sdk, Spells) => { ... }`, transpiled with `Bun.Transpiler`, and
    run through `new Function`. **There is no sandbox**: the code has full Bun/process/fetch access.
  - `bot` and `sdk` are Proxies. After an abort, every call returns a never-resolving promise. This
    parks the code so a catch-all loop cannot spin. Packets already sent can still take effect.
  - Output has these sections: `── Console ──` (bounded capture), `── Result ──` (JSON, credentials
    redacted), `── Error ──` (7 lines plus the active action), and `── World State ──`
    (`sdk/formatter.ts formatWorldState(..., {brief:true, sinceTick})`, only new messages). When the
    code is longer than 2000 chars, it also suggests a saved script.
- **CLAUDE.md** (`AGENTS.md` and `GEMINI.md` are symlinks to it) tells the agent to:
  - create a bot (`bun bots/create-bot.ts [name] [--local|--server=] [--no-chat]`);
  - start the lite runner for scripts;
  - check state with `bun sdk/cli.ts <name>`;
  - call `bot.skipTutorial()`;
  - write focused scripts under `bots/<name>/` and run them with `bun bots/<name>/x.ts`;
  - start runs at 10 s, then 30-60 s, then 5+ min "sparingly";
  - keep `lab_log.md`;
  - grep `learnings/` and `wiki/`;
  - file bugs **after** a workaround ("the game is not buggy");
  - chat with `bun sdk/chat.ts <name> [--to p] [--watch]` (observe mode).
- **bots/_template/**:
  - `bot.env`: `BOT_USERNAME, PASSWORD, SERVER=rs-sdk-demo.fly.dev, SHOW_CHAT=true, TELEMETRY=true`.
  - `lab_log.md`: Goals / Observations / Next Steps / Possible SDK Bugs.
  - `script.ts`: `runScript(async ({bot, sdk}) => { await bot.skipTutorial(); ... chopTree ... }, {timeout: 60_000})`.
  - `create-bot.ts --local` rewrites the env to `SERVER=localhost:8888` plus `GATEWAY_URL=ws://localhost:7780`.
- **runScript** (`sdk/runner.ts`) env lookup order: process env, then a `bot.env` next to the script,
  then `bots/<arg>/bot.env`. Options: `timeout`, `connection`, `autoConnect`, `disconnectAfter`,
  `printState` (prints a summary afterwards), `onDisconnect: 'error'|'wait'|'ignore'`, and
  `reconnectTimeout`. It never launches a browser (`autoLaunchBrowser:false`).

---

## 6. Knowledge base: `learnings/` and `wiki/`

**learnings/** (15 files, about 1,670 lines, hand-written markdown with `execute_code` snippets):
`README` (environment conventions), `banking`, `chat`, `combat` ("Cow Field Details (Proven from 200+
kills)", auto-train lowest stat, long-run error handling), `cooking`, `dialogs` (level-ups, Al Kharid
toll, kebab seller, stuck detection), `draynor-manor`, `fishing`, `fletching` (17 lines), `jewelry-crafting`,
`mining`, `shops`, `smithing`, `thieving` (men, Al Kharid with kebab sustain), `walking` (waypoint lists,
known routes, key coordinates), `woodcutting`.
- **Gaps:** nothing on magic, ranged, prayer, herblore, agility, runecrafting, firemaking, general
  crafting, quests, GE trading strategy, death recovery, multi-floor navigation, or the wilderness.

**wiki/** (generated plus hand-written):
- `items/` has 1,582 files, `npcs/` 807, and `shops/` 119. They are generated from `server/content`
  by `wiki/generate-{items,npcs,shops}.ts`, so they match the server data.
  - Item format: examine text, type/members/weight/value/equip slot, combat bonuses table, spawn
    locations, sources.
  - NPC format: combat level, HP, aggressive, movement, location with coordinate samples, options,
    drops.
  - Shop format: owner with coordinates, stock, buy/sell price.
  - Weakness: item spawn locations are mapsquare names (`m51_61`), not coordinates.
- `skills/` (18 files) and `quests/` (59 files) look hand-written in OSRS-wiki style. Some claims look
  wrong for this server. For example, `wiki/skills/mining.md` lists runite at "Al Kharid, West
  Lumbridge Swamp, Grand Tree", but the engine's runite hiscore counts only the two Lava Maze rocks
  (PATCHES). Not verified further. There is no `runecraft.md`.
  - Quest pages give requirements, items, rewards and a prose walkthrough. They have no coordinates,
    dialog option text, or varp/stage IDs.
- **Opportunity:** generate quest data, loc coordinates, dialog trees and varp stages straight from
  `server/content/scripts/**.rs2`. The content is the ground truth, and the generators already parse
  configs.

---

## 7. Server modifications (`server/PATCHES.md` plus code)

| Mod | Detail | Where |
|---|---|---|
| XP rate | `node.xpRate = 25` (env `NODE_XPRATE`), applied in `Player.addXp` when `allowMulti` is set | `WorldConfig.ts:102`, `Player.ts:1889` |
| XP curve | `delta = floor(level + 2^(level/10)*300)` (authentic is `/7`). Level 99 = 1,070,140 real XP (10,701,400 fine). Together with 25x, that is roughly 300x faster to 99 than authentic (my arithmetic). The curve is duplicated in webclient `Client.ts` (no x10). | `Player.ts:77-85` |
| Infinite run | `NODE_INFINITE_RUN` default true | `Player.ts:755` |
| No randoms | `NODE_RANDOM_EVENTS` default false, `MAP_RANDOM_EVENTS` opcode plus content gating | `engine.rs2`, `login.rs2`, `macro_events.rs2` |
| Tick rate | `NODE_TICKRATE` default **400** ms. Runtime `::speed <ms>` (minimum 20). The world clamps backlog to 2 ticks. | `Environment.ts:54`, `ClientCheatHandler.ts:154`, `World.ts:389` |
| Chat | 400-char cap (`NODE_MAX_MESSAGE_LENGTH`), global public chat (custom opcode 255), profanity filter toggle `NODE_PROFANITY_FILTER` (lite needs `PROFANITY_FILTER=false` in bot.env) | PATCHES |
| AFK / timeouts | client AFK logout 10 min. `NODE_DEBUG_SOCKET` relaxes the server timeouts (5 / 10 min). | PATCHES |
| GE | Physical exchange at Varrock west bank (3180,3443), teller 3181,3445, 5 % seller tax, `/market` dashboard, `data/market.sqlite`, `GE_ENABLED` (restart only) | `docs/grand-exchange.md`, `sdk/MARKET.md` |
| Safety | No automated mute/ban, choice-dialog resume guard (Al Kharid toll), loaded levels clamped to base | PATCHES |
| Extras | `/api/exportCollision`, `/api/version`, `/playerpositions`, `/mapview/`, `/hiscores`, `/worldfeed` WS (`WORLD_FEED=true`), mgmt `/tickstats`, `/prometheus` | `server/engine/src/web/` |

### Cheat commands: important caveat

`ClientCheatHandler.ts` gates commands on `player.staffModLevel`:
- **>= 4 and `!node.production`:** `::speed <ms>`, `::fly`, `::naive`, `::random`, `::reload`,
  `::rebuild`, and debugprocs `::~<name> args` (run any `[debugproc,...]` RuneScript).
- **>= 3:** `::give <obj> [n]`, `::givemany`, `::givecrap`, `::setstat <stat> <lvl>`,
  `::advancestat <stat> <lvl>`, `::minme`, `::setvar`, `::getvar`, `::locadd`, `::npcadd`, `::openmain`,
  `::openoverlay`, `::closeoverlay`, `::snapshot`, `::serverdrop`.
- **>= 2:** `::getcoord`, `::tele level,mx,mz,lx,lz`, `::ban`, `::kick`.
- `*other`, `broadcast`, `reboot` and `teleto` need `production`.
- `sdk.sendSay('::cmd')` sends `CLIENT_CHEAT`, not chat, in both clients (`lite/actions.ts:780`,
  `Client.ts:2026`).

**In the default local config (login server off), `LoginThread.ts:60` hardcodes `const staffmodlevel =
0;`** ("do not auto-grant dev staffmodlevel on non-production worlds"). So **no `::` command works out
of the box, `::speed` included**, despite what README.md says. Ways to enable it:
1. A one-line local patch: set that value to 4.
2. Run with `LOGIN_SERVER=true` (plus `EASY_STARTUP=true` for the login/friend/logger workers), run
   `bun run sqlite:migrate`, and set `account.staffmodlevel=4` in `db.sqlite`
   (`prisma/singleworld/schema.prisma:30`).
3. Skip cheats. Use `NODE_TICKRATE` for speed and the save generator for state.

**Save generator** (the cheat-free test path): `sdk/test/utils/save-generator.ts`. `generateSave(name,
{position, skills, inventory, equipment, bank, coins, varps, appearance})` writes
`server/engine/data/players/main/<name>.sav` before login. It sets varp 281=1000 (tutorial done). It
also has `TestPresets`, `Items`, `Skills` and `Locations` tables. Run it while the bot is logged out.
Note that the GE market ledger checkpoint can override a `.sav` file (`PlayerLoading.load` prefers
`market.sqlite accounts`, PATCHES "Atomic recovery").

---

## 8. Running a full local stack on Windows

Prerequisites:
- **Bun 1.3.14** (the version CI pins).
- **Java is NOT needed.** The content pack uses the pure-TS `@lostcityrs/runescript` compiler. Java is
  referenced only in `tools/unpack/sound/Generate.ts` (unpack tooling), and the Dockerfile installs no
  JRE.
- Node is not required (the engine runs under Bun; `engines.node >= 24`).
- No MySQL: `db.backend = 'sqlite'` and the login server is off by default.
- None of `node_modules` are installed yet in this checkout, and `server/webclient/out/` does not exist.

The commands run from the `vendor/rs-sdk` root, one terminal each:

```bash
# 0. deps (root: MCP SDK, puppeteer dev-dep; webclient; engine; gateway)
bun install
(cd server/webclient && bun install)
(cd server/engine && bun install)       # `bun run start` also runs bun install
(cd server/gateway && bun install)

# 1. build the web client bundles (engine serves ../webclient/out directly; no copy)
cd server/webclient && bun run build    # or `bun run watch` (dev, rebuilds on change)

# 2. engine (first boot packs the cache from ../content automatically if data/pack is missing)
cd server/engine && bun run start       # = bun install && bun run src/app.ts ; `bun run quickstart` skips install
#   optional pre-pack like CI/Docker:  BUILD_VERIFY=false bun run build

# 3. gateway
cd server/gateway && bun run gateway    # ws/http :7780

# 4. bot + headless client
bun bots/create-bot.ts mybot --local    # SERVER=localhost:8888, GATEWAY_URL=ws://localhost:7780
cd server/webclient && bun src/lite/runner.ts mybot   # wait for "Gateway connected, registering as 'mybot'"

# 5. drive it
bun sdk/cli.ts mybot
bun bots/mybot/script.ts
```

Environment, set in `server/engine/.env` (Bun loads `.env` from the cwd) or in the shell:
- Speed and progression: `NODE_TICKRATE=100`, `NODE_XPRATE`.
- Relaxed timeouts for background tabs: `NODE_DEBUG_SOCKET=true`.
- Chat and GE: `NODE_PROFANITY_FILTER=false`, `GE_ENABLED`.
- Ports: `WEB_PORT` (8888), `WEB_MANAGEMENT_PORT` (8898), `NODE_PORT` (43594).
- Login stack: `LOGIN_SERVER`, `EASY_STARTUP`.
- Build: `BUILD_VERIFY=false`.
- Nested config also lives in `server/engine/data/config/world.json`. Env values win
  (`migrateFromLegacyEnv`).

Gateway env: `AGENT_PORT`, `GATEWAY_HOSTNAME=127.0.0.1` (recommended locally, because it has no auth),
`LOGIN_SERVER`.

Lite env: `GATEWAY_URL`, `GATEWAY_DIRECT=false`, `PROFANITY_FILTER`, `LITE_LOGIN_JITTER_MS`,
`LOGIN_RSAN`/`LOGIN_RSAE`.

Browser alternative: open `http://localhost:8888/bot?bot=mybot&password=<pw>`.

Windows notes (not verified by running):
- `bun run server/start.ts` is the upstream LostCity interactive menu. It `git clone`s and pulls
  upstream repos, so do **not** use it on the vendored tree.
- The `AGENTS.md` and `GEMINI.md` symlinks may check out as text files without symlink support.
- Check `HOME` for the lite cache path (section 1).
- PATCHES warns about case-only filenames (`JagFile.ts` vs `Jagfile.ts`) on case-insensitive file
  systems.
- Integration tests (`HEADLESS=true bun sdk/test/mining.ts`) need Puppeteer/Chromium and a running
  stack.
- Unit tests: `bun run check` (typecheck, typecheck:webclient, test). CI also runs
  `BUILD_VERIFY=false bun run build` in `server/engine` first.

---

## 9. Weaknesses, gaps and opportunities

**Bug-report mechanism.** `bun sdk/bug-report.ts "<text>"` POSTs `{text, sdkVersion: git short sha}`
to `https://rs-sdk-demo.fly.dev/bug-report` (write-only, no auth). It always goes to the demo, even
when playing locally. Opt out with `TELEMETRY=false` (read from process env only). Reports are read
over `fly ssh`. **A harness must keep this off or redirect it**, or agent text will leave the machine.

**TODOs in code:** only `acceptCharacterDesign` should take parameters (gender, kits[7], colours[5])
(`sdk/types.ts:615`, `ActionExecutor.ts:313`). Most of the debt is described in prose, not in TODO
markers.

**Weaknesses that matter for an agent harness:**
1. **Latency.** Each action makes the round trip SDK -> gateway -> client -> engine, and then a
   full-JSON state broadcast. In swarm.ts's measurement, about 2 s per pickpocket through the gateway
   vs 2 ticks in-process. Porcelain methods poll state and add ticks of slack.
2. **Weak verification on generic actions.** `interactLoc`, `interactNpc` and `useItemOn*` succeed
   on "an animation/dialog started". `attack` succeeds on engagement. Only a few methods verify the end
   product (mineRock, chopTree, bank, shop, trade, GE).
3. **No action ack from the server.** `opFeedback` is a heuristic: an `UNSET_MAP_FLAG` while standing
   still. It does not say which op was refused.
4. **Observation gaps.** `tick` is client-local. Entities come only within 15 tiles on the current
   plane. There are no NPC respawn timers, no aggression or danger signals, and no structured "what
   just happened" event stream. `gameMessages` is capped at 50 per frame, and the harness must diff
   them itself (`getNewChat` covers only player chat).
5. **Navigation.** It is single-plane, with no transport or teleport graph, no shortcut or danger
   costs, an "all doors open" assumption, and a mainland-fill hack that can route over water.
6. **Control model.** Last controller wins: a second process silently kills the first. MCP
   `execute_code` has no sandbox and auto-opens browser tabs. The default 2-minute timeout pushes long
   tasks into separate scripts, and those lose MCP's state summaries.
7. **Knowledge.** The quest and skill wiki is hand-written, has no coordinates, and is sometimes
   wrong. Learnings cover about 10 skills. No knowledge is generated from the `.rs2` scripts, which are
   the ground truth.
8. **Docs drift.** "~300ms" tick vs the 400 ms default. README `::speed` vs the hardcoded
   `staffmodlevel=0`.
9. **Fragile coupling.** The BotAction union is duplicated. PATCHES lists many silent-sever risks on
   vendor sync.

**Opportunities for a better harness:**
- Run the agent's executor **in-process with the lite client**, like `lite/swarm.ts`. Keep the gateway
  only for observers. This removes the RTT and the JSON re-broadcast.
- Add a **typed, verified skill library** on top of the porcelain. Each skill has preconditions, the
  effect to observe (XP, inventory delta, position, varp), a timeout, and a rejection classification
  from `opFeedback` and game messages.
- Add an **event stream**: diffs between frames (XP drops, items gained or lost, messages, dialogs,
  damage, deaths), keyed by `revision`, for the LLM context. This replaces raw state dumps.
- Build a **world graph**: a multi-plane pathfinder over the engine's own collision. Add
  stair/ladder/transport edges mined from content `.rs2` loc triggers, and door state from loc config
  (one-way and quest-locked doors).
- Generate knowledge from `server/content` (quest stage varps, dialog text, shop stock, spawn
  coordinates, drop tables), with evidence links. Treat hand-written wiki pages as hints only.
- Build a **fast local test bench**: enable the local cheat patch (staffmodlevel 4) or use
  `generateSave` presets, set `NODE_TICKRATE` to 50-100 ms, use lite runners, and add a scenario runner
  with reset (write the `.sav`, log in, assert). Use `bun run check` as the regression gate.
- Add a **safety layer**: force `TELEMETRY=false` and `SHOW_CHAT=false` by default (prompt injection
  through chat), bind the gateway to `127.0.0.1`, add a single-controller lock, and sandbox the
  agent's code.
- Use the GE market HTTP API (`sdk/market.ts`, `get_market`) for economic planning without a bot
  connection.
