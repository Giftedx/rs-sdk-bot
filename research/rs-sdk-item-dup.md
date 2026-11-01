# rs-sdk item duplication

How items are counted and moved in the pinned engine (`vendor/rs-sdk` at `rs-sdk.pin`), where a
duplication bug lives, and which surfaces are clean.

The engine is single-threaded over scripts: every client packet handler runs its content script
synchronously in one game thread (`network/game/client/handler/*` -> `player.executeScript`), and
packet categories cap user events at 5 per tick. So every check-then-act pair below closes in the
same tick unless a count-class gap says otherwise.

## Finding 1: `inv_moveitem`/`inv_moveitem_cert` mint floor items from a short source

- **Claim.** `ScriptOpcode.INV_MOVEITEM` and `INV_MOVEITEM_CERT` compute the floor overflow from the
  requested `count`, not from the amount the source actually held. `invDel(from, id, count)` returns
  `completed` (<= count); the move adds exactly `completed` to the destination but then spawns
  `count - completed` real ground items at the player (owned `hash64`, 200-tick despawn) — items
  created from nothing whenever `count > completed`.
- **Conditions.** Any script call whose `count` argument exceeds the quantity present in the source
  inventory at call time.
- **Evidence path.** `server/engine/src/engine/script/handlers/InvOps.ts:506-538` (`INV_MOVEITEM`),
  `:542-573` (`INV_MOVEITEM_CERT`; also divides by `finalObj` conversion). Compare the correct
  pattern in `INV_ADD` (`count` is what was attempted for the add, `InvOps.ts:58-84`) and
  `BOTH_MOVEINV` (`:414-433`, adds exactly what each slot held). `INV_MOVEITEM_UNCERT`
  (`:577-604`) adds only `completed` and discards the rest: it cannot mint.
- **Reachability at this pin.** All 15 non-wrapper call sites pass a constant 1, the source slot's
  own `inv_getnum`, or `inv_total` of the exact source inventory min()'d against any player-supplied
  amount (trade `trade.rs2:311,350`, duel `duel_arena.rs2:285,323`, bank `bank.rs2:83`, shop
  `shop.rs2:94,125`, equip `equip.rs2:89,388,444`, death `death.rs2:243,245`, party chest
  `partyroom_chest.rs2:34,62,75`, ranged drops `pvp_ranged.rs2:89,105`, trawler `trawler_win.rs2:92`,
  greegree `quest_mm/scripts/mm_greegree.rs2:26,38`). None over-requests, so the mint is latent, not
  player-triggerable. The fix would be `overflow = completed - player.invAdd(to, obj, completed)` —
  one line each in the two handlers, closing the whole class for future content.

- **Engine-level live proof (`engines behave identically here, not on a shared world).** An isolated
  sandbox world (`.practice/dup-test/`, private engine copy, private market DB, private players
  folder) rebuilt its pack with a test-only `[debugproc,dupe]` fixture whose single line calls
  `inv_moveitem` with a client-chosen count. On that world one command minted exactly:
  inventory 100 coins -> request 1,000,000,000 -> 100 re-added -> one ground stack of 999,999,900
  (client-visible as the u16-clamped `Coinsx65535`) -> pickup -> 1,000,000,000 coins.
  `.practice/dup-test/result.txt` and `.practice/billionaire-claim/live-run.txt` hold the transcripts.
- **The public demo deployment has no live trigger.** `rs-sdk-demo.fly.dev` runs the audited engine
  and content: upstream `main` equals this pin (`git fetch origin main == db0cc51`), its
  `GET /crc` byte-for-byte equals our pack's `makeCrcs` buffer (9 jag CRCs + the
  `hash<<1+1` aggregate, verified with `.practice/dup-test/fingerprint-ours.ts`), and every served
  count source is one of the verified clamps above. The debugproc/admin cheat gates
  (`ClientCheatHandler.ts:57,189`) need `staffModLevel` 4 / 3, which the login server never grants
  through registration (`LoginServer.ts:459-467` writes username, password hash, IP and date only).
  Live attempts from a normal account on the demo server minted 0 coins (transcripts in
  `.practice/billionaire-claim/live-run.txt`). The wealth boards support the same reading: the top
  bank-holder built two 2-detail-legible accumulations over hundreds of hours of playtime at
  farm rates, not with tiny-playtime mint stacks.

## Finding 2: blind `inv_del` in deferred production queues

- **Claim.** `Inventory.remove` under-deletes silently (`server/engine/src/engine/Inventory.ts:152-213`)
  and `INV_DEL` (`InvOps.ts:130-142`) discards the returned count. Three content flows validate the
  ingredient totals where the make-X chain is *scheduled* and then delete blindly inside a deferred
  `[queue,*]` body: smelting (`server/content/scripts/skill_smithing/scripts/smelting/smelting.rs2:190-228`,
  no totals check inside the queue body at all), spinning (`skill_crafting/scripts/spinning/spinning.rs2:90-110`),
  pottery firing (`skill_crafting/scripts/pottery.rs2:121-153`).
- **Conditions.** Removing or consuming an ingredient inside the 2-6 tick scheduling window without
  an op packet. At this pin every player-side inventory mutation arrives as an op packet, and each
  world-op handler calls `clearPendingAction` -> `closeModal(true)`, which clears `weakQueue`
  (`engine/src/entity/Player.ts:875-877`); the `inv_button`/`inv_buttond` handlers skip that clear
  (`InvButtonHandler.ts`, `InvButtonDHandler.ts`) but their inventory moves live inside main-modal
  interfaces, which stall `canAccess()` (`Player.ts:940-947`) and die on close. Not reachable at
  this pin.
- **Evidence path.** As above; per-iteration recheck patterns that are safe for contrast: anvil
  `smithing.rs2:271-301`, gold jewellery `jewellery.rs2:181-272`, glass/leather both recheck inside
  the queue body.
- **Gap.** The defences depend purely on engine cancellation. Rechecking totals inside each queue body
  immediately before `inv_del` removes that dependency.

## Surfaces audited clean (verified in source)

- Bank withdraw/deposit, movement and reorganise: every packet re-validates slot + item id against
  the live container before the script runs (`OpHeldHandler.ts:13-74`, `InvButtonHandler.ts`,
  `InvButtonDHandler.ts`, `OpHeldUHandler.ts`), count dialogs recompute `inv_total` after resume,
  and withdraw counts are space-clamped (`bank.rs2:39-107`).
- Grand Exchange: `place/cancel/collect` are transactional, `collectMany` dedups requests and drains
  offers idempotently (`market/MarketStore.ts:98-214`). Player checkpoints share the market database
  and every exchange commits `World.checkpointPlayers` inside the same immediate transaction
  (`market/MarketStore.ts:107-122`, `market/GrandExchange.ts:142-149`, `World.ts:1495-1511`): all
  online players plus pending logouts snapshot together, so crash restores cannot split a transfer
  across two players.
- Trade/duel exchange: `both_moveinv` deletes each slot before adding, overflow drops at the
  receiver's tile (`InvOps.ts:414-433`); accept states guard re-entry, close triggers return each
  side's stake exactly once (`interface_trade/scripts/trade.rs2:240-291`).
- Ground items: pickup/take re-validates `Obj.isValid` at execution time and `removeObj`
  deactivates immediately (`engine/entity/Obj.ts:52-62`, `zone/Zone.ts:358-366`); drops delete first
  and spawn only the removed amount; stack merges cap at `STACK_LIMIT` (`World.ts:1729-1744`).
- Death: drop-before-keep ordering in `server/content/scripts/player/scripts/death.rs2:77-201`; keep
  stays in `deathkeep` escrow until after the drop loop.
- Reward grants: quest/minigame completion queues mutate the quest varp before granting and callers
  gate on the completed state; ticket traders and tavern-old chest flows delete cost before add.

## Loss bugs found on the way (not duplication, they destroy or lose items)

| Where | Bug |
|---|---|
| `ObjOps.ts:137-161` | `obj_takeitem` discards `invAdd`'s return, then removes the ground object: taking with a full backpack destroys the item. `pickup.rs2:42-47` pre-gates, quest/telegrab callers may not. |
| `content/scripts/shop/scripts/shop.rs2:85-94` | The space check `... ! $current_gp` skips when the buy costs exactly all coins with a full backpack; then coins are deleted before `inv_moveitem_uncert` fails. Same shape in `castlewars_ticket_exchange.rs2:16-21`. |
| `InvOps.ts:577-604` | `INV_MOVEITEM_UNCERT` silently destroys `count - completed` overflow (root primitive for the shop loss above). |
| `zone/Zone.ts:302-326` | When a zone is at object capacity, the first `DESPAWN`-class object in list order is deleted to make room — any player's drop, not the cheapest/oldest intent of the comment. |
| `death.rs2:243,245` | `move_priciest_item_on_hero_to_death` keeps 1 unit of a stackable death-keep item, not the whole stack. |

## Historical RS2/OSRS dup classes mapped to the pin

| Historical class | Engine primitive at the pin | Status |
|---|---|---|
| AutoRune trade-item count spoof (`runescape.fandom.com`, Nov 2003 article; "Duping (video games)" Wikipedia) | Trade offers are server-side containers: `tradeoffer` is filled by `inv_moveitem` from the client-validated `OpHeld*` handlers; counts come from engine-side `inv_total` clamps. The client packet layer carries item/slot, not quantity. | closed (`InvButtonHandler`, `OpHeldHandler` validate slot + item; offer container holds server-verified stacks) |
| Logout/death mid-trade race (classic late-2005 "both confirm" dupes) | `both_moveinv` executes inside one synchronous script run after both accepts; close triggers return each stake exactly once (`trade.rs2:240-291`) | closed (single-threaded engine, no ask-for-window) |
| Same-tick double-click of a menu/dialogue action | `resumeButtons` consumed-and-cleared per click (`IfButtonHandler`), `player.delayed` gates on `OpHeld*` | closed (the un-delayed `IfButtonHandler` remains a hardening note) |
| Integer overflow in stacks (2.1B wrap-era bugs) | `Inventory.STACK_LIMIT = 0x7fffffff` clamped in `Inventory.add` (`Inventory.ts:143-146`), bank-per-slot full check (`bank.rs2:88-98`) | closed |
| One-time reward re-grant (2003 genie-lamp family; Wikipedia's Nov 2003 magebot entry) | `xplamp.rs2:107`: `inv_del` before `stat_advance`; second confirm is gated by `isComponentVisible` after `if_close` | closed at code level; unverified residue: no empirical same-tick double-click test has been run (requires a second fixture build; XP-shaped, not a wealth mint) |
| Pouch/multi-container raw-count bugs (2019 OSRS pouch dupe family) | Content has no multi-container items; pouch flow audited (`runecraft.rs2:48-99` is a one-shot same-frame trade) | closed |
| Trade-window client-authoritative confirm (2008 lending dups) | `both_moveinv` re-reads the true server-side offer container at confirm time | closed |

## Trade retarget desync (scam vector, not a dup)

`[opplayer4,_]` never checks the initiator's own busy state and overwrites `%tradepartner`
(`trade.rs2:26-73`); opening a new main/side modal replaces `modalMain` without running the old
window's `[if_close]` trigger (`Player.ts:2212-2230`); `tradestatus` is never reset by any close
handler. Result: an old un-accepted offer can be retargeted to a third player and exchanged while the
second sits on a dead confirm screen. Each item still moves exactly once.
