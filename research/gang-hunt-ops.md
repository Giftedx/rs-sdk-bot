# Gang hunt operations

How the fleet runs the gang squad (`scripts/pk-squad.ts`) against Goondelf, Ligma and Sugma for hours: the
readiness check, the staging of each kit, the job, the watcher and the supplies. The fight itself, the gang and the
live pilots are in [pvp-fight-loop](pvp-fight-loop.md), "Rivals: the dagger gang" and "The cost of a kill".

## The kit and its check

`bun scripts/squad-ready.ts [<account> ...]` reads the status files of the main checkout and logs in nothing. With
no account named it takes each account of this fleet side with 99 in the seven combat skills. For each account it
prints the kit that the account can wear and carry from its own stock, each missing piece with the nearest owned
account that holds a spare one, and `READY` or `NOT READY` with each cause.

The rule `gang-chain-bind` is the bench kit `live-walker-iron-rune-chain-bind` (`scripts/pk-kits.ts`) with each
piece widened to its class. Each check is a fault of a live pilot.

| Check | Passes with | Fault it prevents |
|---|---|---|
| Body armour | a torso piece that the account can wear, melee defence 107 or more (half of a rune chainbody) | - |
| Leg armour | a leg piece, melee defence 74 or more (half of rune platelegs) | an account with no leg armour died |
| Melee weapon | a weapon with a special attack, or a rune blade; a dragon dagger first | - |
| Bow and arrows | a strung bow and 100 or more arrows that it fires (arrow tier at or under the bow's tier) | two accounts shot bronze arrows |
| Escape | Camelot Teleport or Varrock Teleport castable at the post with the runes held (`squadEscapeSpell`) | an account clicked Camelot Teleport with no law runes |
| Freeze | Bind castable with the runes held (`castableFreeze`, Magic capped at 49 by `SQUAD_OPTS`) | a gang account at low HP walked away |
| Antipoison | one antipoison of any dose count on each of the first two accounts of the list; the others need none and carry the extra food (2 lobsters or 1 shark a kill) | poison did 139 of 455 damage; the gang clone bench killed 9 of 9 with a potion on 5, 2, 1 and 0 of five accounts, none died (hosted run 44262314889) |
| Food | a shark or a lobster for each free slot of the pack (20 with the bench pack); at least half of them is enough (`SQUAD_FOOD_FLOOR`) | - |
| Prayer | current Prayer points at 70% of the base level or more (`PRAYER_FLOOR`); the fix is `bun scripts/pray-at-altar.ts <account> ALTAR=3253,3486` (Varrock east church) | four members fought a whole run with 0 points and took twice the damage of the clone replay with points |
| Worn and carried | each piece of the kit is worn, the bow and each supply are in the pack, and the pack holds the food floor (`--before-kit` leaves this out, to write the kit files) | an account whose failed trip had deposited its pack was called ready and fought with no bow, no runes and no escape |
| Bank read | the status file's bank read is 6 hours old or less (`--max-age`) | a plan from stock that is gone |
| Place | not inside West Ardougne, not in the Wilderness | the walker has no route across the West Ardougne wall |

A piece under the bench kit's piece (an adamant platebody, bronze arrows, a willow shortbow) passes with a note and
a wanted piece from a donor. The quest of a piece counts: a rune platebody is no body armour without Dragon Slayer,
and a dragon dagger is no weapon without Lost City (`knowledge/gear.json`).

Facts that the check rests on:

- **The squad takes its pack from what an account holds at login.** `packOf` (`scripts/pk-gang.ts`) reads the pack
  and the quiver at the start, and `bankTrip` asks for the same items at each bank trip. An account that starts out
  of the Wilderness makes a bank trip before its first fight. So an account must wear and carry its whole kit before
  the squad starts. Evidence: `scripts/pk-squad.ts` `hold`.
- **A potion is asked for by its doses.** `packOf` gives a potion row `minDoses` and `maxSlots`, and the trip takes
  the fullest potion that the bank holds. A request by count needs 4 doses in one slot, and `junglestore`, the one
  shop with antipoison, sells it with 3 doses. Conditions: four accounts in the bench kit, start at the Edgeville
  bank, seeds 1 to 3, with the request by count: 0 kills in each run, each account's trip ended
  `bank lacks trip requirements [{"id":2446,"unit":"doses","required":4,"available":3}]`. Evidence:
  `extra:squad-4-gang-hunted-chainbind-x1`, `scripts/pk-gang.test.ts`.
- **Two items have the name "Magic shortbow".** Item 861 is the bow. Item 72 (`unstrung_magic_shortbow`) fires
  nothing, and stringing it needs Fletching 80. A count of magic shortbows by name counts both. The tool reads the
  item id and names an unstrung bow in a note. Evidence: `knowledge/items.json`.
- **The bank trip takes food by a list.** `restock` and `bankTrip` fill the food slots from `FOOD_LIST`
  (`scripts/pk-hunt.ts`): sharks first, then lobsters. The fight loop eats any food (`FOOD_ORDER` in `scripts/pk.ts`).
  The readiness tool counts the same list, and the loadout file holds a row for each kind.
- **A death ends the job as a death.** A run in which an account died ends `RESULT fail died squad ...`
  (`scripts/pk-squad.ts` `squadEnd`). The supervisor (`packages/practice/src/supervise.ts`) ends `died` for it, and
  the swarm does not start those accounts again, with `"repeat": true` too, until a person clears the end. The dead
  account stands at Lumbridge with no kit: stage its kit before the next run.

## Staging

Order of sources for a missing piece: an owned account's spare stock, then a shop, then the Grand Exchange.

1. **Owned stock.** The tool prints one `scripts/fleet-order.ts` command for each donor and receiver pair, with
   `MEET=<bank near the receiver>` and `TAKER_WAITS=1`. A donor that is no squad account gives only what its bank
   holds. A squad account gives only gear over its own kit and keeps its food, runes and arrows. An order's window
   starts when the command runs, so the commands run after the pause is lifted. `--orders <dir>` writes the same
   orders as files for review. The tool refuses the fleet's own orders folder.
   Place the orders of one account one at a time, each after the order before has both receipts. The fleet agent
   gives an account its earliest open order with no receipt from the account (`scripts/fleet-trade.ts` `pickOrder`),
   and an account takes an order role one time (`packages/core/src/fleet-trade-claim.ts` `acquireFleetTradeClaim`).
   An order whose role the account has used with no receipt holds each later order of that account until its window
   ends: the login ends `fleet trade order role already claimed`. A released claim does not free the order. Place a
   new order after the window.
2. **Shops** (`scripts/shop-buyer.ts`, through `bun scripts/aio-market.ts <account> shop-buy <profile> <cap>
   ITEMS=<pattern> STOCK_TARGET=<count> STOP_AT_TARGET=1`. A run with no `ITEMS` and no stock target is refused as
   no finite order):

   | Item | Profile | Shop, shelf | Bench case |
   |---|---|---|---|
   | Antipoison(3) | `jiminua` | `junglestore` on Karamja, 10, one back each 150 ticks; from the Ardougne south bank by Captain Barnaby's ship, 30 coins each way | `extra:shop-jiminua` |
   | Iron arrow | `lowe`, `catherby_arrows` | `archeryshop` 1,500, `archeryshop2` 800 | - |
   | Earth, water and air runes | `aubury`, `betty` | `runeshop` 2,000 each | `market:earth-shop` |
   | Law and nature runes | `magic_guild` (Magic 66) | `magicguildshop` | - |
   | Rune platelegs, rune chainbody | `scavvo` (Champions' Guild, 32 quest points) | `runiteshop`, 1 each | - |
   | Dragon dagger | none: `jukat` holds the dragon longsword line only | `dragonswordshop`, 2 | - |

3. **Grand Exchange** (`scripts/buy-owned-ge-item.ts ITEM_ID=<id> QUANTITY=<n> LIMIT_PRICE=<coins> ...`): the tool
   prints the ask and the count on sale from `.practice/market-all.json` for each piece with no owned spare.
4. **The kit step.** `--loadouts <dir>` writes `<account>.json` for each ready account. With the account within 3
   tiles of the bank that the file names, `bun scripts/aio-logistics.ts <account> loadout <file>` wears each piece
   and takes the exact pack (`scripts/microbot-owned-loadout.ts`, bench case `logistics:loadout`).

An account inside West Ardougne with Biohazard started leaves by the quest script:
`bun scripts/aio-quester.ts <account> biohazard` takes Kilron's rope ladder at step 7 when the account holds no
runes for the Ardougne teleport (bench case `extra:biohazard-step7-kilron`, start tile 2555,3324).

## The job

A hand run, bounded, from the main checkout (PowerShell):

```powershell
$env:DEMO_OK='1'; $env:FLEET_SIDE='local'; $env:WORKER_ENTRY='scripts/pk-squad.ts'
$env:WORKER_RELEASE=(bun packages/core/src/worker-release.ts scripts/pk-squad.ts | Select-Object -Last 1)
bun scripts/pk-squad.ts <a1> <a2> <a3> <a4> TARGETS=goondelf,ligma,sugma POST=3067,3640 MAX_MINUTES=10 TRIPS=1 FOLLOW=1 MARCH=1 PULL=1 RESCUE=1 PICKUP=1 *> .practice/swarm-logs/squad-hand-run.log
```

The same run as a `swarm.json` job. A job with several accounts in one process is an orchestrate job
(`scripts/swarm.ts` `parseJob`): `"accounts"` with `"orchestrate": true`, two accounts or more, no `"host"`.

```json
{
  "accounts": ["<a1>", "<a2>", "<a3>", "<a4>"],
  "orchestrate": true,
  "script": "scripts/pk-squad.ts",
  "args": ["TARGETS=goondelf,ligma,sugma", "POST=3067,3640", "MAX_MINUTES=10", "TRIPS=1", "FOLLOW=1", "MARCH=1", "PULL=1", "RESCUE=1", "PICKUP=1"],
  "role": "pvp",
  "goal": "gang squad: kill Goondelf, Ligma and Sugma from the multi-way post west of their post",
  "enabled": true,
  "repeat": false,
  "standing": true,
  "standingRetry": false,
  "maxRestarts": 0
}
```

The repeating run changes `MAX_MINUTES` to 60 and `TRIPS` to 10. A job that ended `done` with `"repeat": false`
starts again only as a new mission: change an argument, or an env value such as `"env": {"SQUAD_RUN": "2"}`
(`missionSignature` holds the script, the accounts, the arguments and the env). The first
runs keep `"repeat": false`, and the lead starts each next run after it reads the watcher's line.

What the swarm does with this job, from `scripts/swarm.ts` and `packages/practice/src/supervise.ts`:

- **Start.** It runs `bun packages/practice/src/supervise.ts <a1> scripts/pk-squad.ts 0 <a2> <a3> <a4> <args>` in
  one process, with the log `.practice/swarm-logs/<a1>.log`. All four accounts must be startable, or none starts
  (`completeJobCandidates`): no stop file, no end that holds the account, and no status file that a different login
  changed in the last 30 s. The job counts as 4 bots against `maxBots` and reserves 1 GiB for its start. Free RAM
  must stay over the 4 GiB floor.
- **Standing.** While the coordinator owns the plan, the swarm admits an owner job only with `"standing": true`
  (`coordinatedAdmission`). A standing job runs the current source with no release pin. A coordinator job that
  names one of the four accounts turns the whole job off (`shadowAssignments`).
- **Stop files.** `scripts/pk-squad.ts` logs in no account while `.practice/stop-pk-squad` or a `stop-<account>`
  file exists. During a run, `stop-pk-squad` ends every hold and `stop-<account>` ends one. Turning the job off, or
  `.practice/stop-swarm`, writes each account's stop file. On each of these, and at `MAX_MINUTES`, every account
  eats, walks to the Edgeville bank (`leaveWilderness`) and logs out there. No account logs out in the Wilderness.
- **End.** `RESULT ok` ends the job `done`. With `"repeat": false` it does not start again until its arguments
  change. A `RESULT fail` with game ticks ends it `gave-up` at once (`maxRestarts` 0), and one with `stop file` ends it
  `stopped`. `"standingRetry": false` keeps a failed squad down
  until a person looks. A dropped session stops that account only. At the end the script logs it in again and takes
  it out by teleport or on foot (`RESCUE=1`), and the RESULT names it (`dropped=`, `stranded=`).
- **Logout.** The last lines of a run are `LOGOUT` with one word for each account, then the RESULT. Each word must
  be `logged-out`.
- **Start.** Each member stands at the Edgeville bank, which `pk-squad.ts` reads as a trip. The first trip eats to
  within a tenth of full Hitpoints (`eatUp`) and keeps the pack that the member logged in with (`bankTrip` `fresh`):
  a member one meal short starts with what it holds, and one under half of its pack food (`SQUAD_FOOD_FLOOR`) stays
  out. A later trip restocks the pack: it takes the food that the bank holds at or over the same floor, and a restock
  that the bank and the pack together cannot fill deposits nothing. A trip is due at the start and after the member
  has been in the Wilderness (`outTripDue`), not on the first steps of the march, which are outside the Wilderness
  too: a trip there ran a restock before any fight. The bench shows it as `trips=4` for four members.
  A later trip also walks to the nearest safe altar (never one in the Wilderness) when Prayer is under 70 percent of
  the base level (`SQUAD_TRIP_PRAYER_FLOOR`). It is off by default (`SQUAD_TRIP_ALTAR=1` turns it on): in the bench (`extra:squad-2-gang-trips-altar-x1`, floor 1) both members leave for the church together and the post stands empty until they are back. From Edgeville the altar is the Varrock
  east church, about 159 tiles away. A failed prayer does not end the trip: the member fights on without Prayer and the
  log says so. Every walk back goes by the march's legs (`marchLegs`: the edge, the entry of the post's area, the post).
- **Stall.** The stall guard (`packages/core/src/bot.ts`) ends a session with no xp, item, dialog or journey for
  `STALL_TICKS`. `scripts/pk-squad-stall.ts` sets it for the squad to the longest return of a gang account in the
  clone record (`group.returnToPost`) times 1.25 (`STALL_MARGIN`: the spread of the two recorded returns, 1431 over
  1154, rounded up), so a hold at the post while the gang is away is not a stall. A stalled member ends its own
  session only. `stopSquadSession` records it as dropped, so the rescue at the end (`RESCUE=1`) logs it in again and
  takes it out of the Wilderness, and the RESULT names it (`dropped=`).

## The watcher

```powershell
bun scripts/squad-watch.ts .practice/swarm-logs/<a1>.log <a1> <a2> <a3> <a4> NO_KILL_MINUTES=20 QUIET_MINUTES=4 SUMMARY_MINUTES=5 LOW_HP=30
```

It holds no model and starts no process. It prints `SQUAD_WATCH ok ...` every `SUMMARY_MINUTES` with the kills by
target, the deaths, the HP lost between two reads of the status files (a sample), the trips, and each account's HP,
food, arrows, law runes and antipoisons. It exits with `SQUAD_WATCH event=<kind> account=<name> detail=...`:

| Event | Source | First action |
|---|---|---|
| `death` | a `SQUAD died` or `PK died` line, `RESULT fail died ...` or a RESULT with `died=1` or more, an account at the Lumbridge spawn after the Wilderness | stop the squad (`stop-pk-squad`); read the fight lines of the account; stage its kit again |
| `in-danger` | an account in the Wilderness at `LOW_HP` or less with no food, no castable teleport and no glory | read its lines; the fight loop runs south |
| `fail-result` | `RESULT fail ...` | read the detail (`stranded=`, `halted=`, a login refusal) |
| `logout-unconfirmed` | a `LOGOUT` word that is not `logged-out` | check the account's logout proof before the next start |
| `bank-trip` | `SQUAD bank trip: <fault>` or `SQUAD no trips left` | the fault names the item that the bank lacks; restock that account |
| `kit-missing` | an account walked into the Wilderness with no body armour, leg armour, weapon or food | stop that account (`stop-<account>`) |
| `session-dropped` | `SQUAD session ended: ...` | the script rescues the account at the end; check the RESULT |
| `no-kill` | no `PK kill` line in `NO_KILL_MINUTES` | read the `SQUAD follow` lines: the gang is away or out of reach |
| `process-gone` | process `PID` ended, or no log line and no status write for `QUIET_MINUTES` | find the accounts in the status files; a login may leave one in the Wilderness |
| `supervisor-end` | `SUPERVISE end <reason>` that is not `done` | read the reason |
| `ended` | `RESULT ok` with no death (exit code 0) | read the summary; start the next run |

With `REPEAT=1` a `RESULT ok` with no death does not end the watch. The watcher reads only lines written after its
start (`FROM=start` reads the whole file).

## Supplies

What one squad of four uses, and what covers it. Kill rate: two live pilots made 4 kills in 10 minutes and 6 in 11
minutes, so 24 to 33 kills an hour (estimate from two pilots). HP lost a kill: about 250 in the pilots, where the
gang split the squad one-on-one, and the bench numbers below where the squad fights together.

Each case: four of ours in the bench kit `live-walker-iron-rune-chain-bind` against the three of the bench gang
(`ganker-dds`, profile `ganker-live`), seeds 1 to 3, one meeting a run.

| Bench case | Conditions | Kills | Own deaths | HP lost a kill | Raw HP lost | Food eaten |
|---|---|---:|---:|---:|---|---|
| `extra:squad-4-gang-hunted-chainbind-x1` | walk-in from the Edgeville bank, a bank trip first; the gang hunts | 8 of 9 | 0 | 32 | 124, 46, 86 | 3, 1, 4 sharks |
| `extra:squad-4-gang-chainbind-x1` | at the post, 20 sharks an account | 9 of 9 | 0 | 36 | 122, 88, 116 | 3, 3, 6 sharks |
| `extra:squad-4-gang-chainbind-lobster-x1` | at the post, 20 lobsters an account | 9 of 9 | 0 | 27 | 72, 54, 121 | 5, 3, 7 lobsters |

- **Lobsters for sharks.** Claim: with a lobster in place of each shark the squad makes the same kills with no death.
  Conditions: the two cases at the post above, three matched seeds. Evidence: 9 kills of 9 each, 247 HP lost against
  326, 15 lobsters eaten against 12 sharks. The difference in HP is inside the spread of the seeds. Gap: the bench
  fight costs about 30 HP a kill. At the pilots' cost of about 250 HP a kill a pack of 20 lobsters heals 240 HP where
  20 sharks heal 400, so an account eats and banks about 1.7 times as often. That cost is not measured.
- **Supplies a kill.** Over the nine runs (26 kills), from the pack's count less the count in each account's status
  file at the end: 23 arrows (600, less the arrows picked up), 11 earth runes, 11 water runes and 8 nature runes
  (294, 294 and 196: 98 Binds), 0.4 of an antipoison dose (10 doses), 1.2 sharks (20 over 17 kills) or 1.7 lobsters
  (15 over 9 kills), no law rune and no air rune (no account teleported). Gap: one bench gang. The live gang splits
  the squad and costs about 7 times the HP.

Demand lines for the planner, one squad of four, per squad hour. The low number is the bench cost at 24 kills an
hour, the high number the pilot cost at 33 kills an hour (estimates).

| Item | Units a squad hour | Consumer | Source |
|---|---|---|---|
| Shark | 30 to 40 at the bench cost; 300 to 410 at the pilots' cost (250 HP a kill, 20 HP a shark) | the bank trip of each squad account, 20 a trip | the Grand Exchange; `scripts/shark-supply.ts` (Fishing 76 and Cooking 80; no bench case, rate not measured) |
| Lobster, once the bank trip takes it | 40 to 55 at the bench cost; 500 to 690 at the pilots' cost (12 HP a lobster) | the same | owned stock; `scripts/gather-fish.ts cage` and `scripts/cook-food.ts` |
| Iron arrow | 550 to 760 | the quiver, 300 an account | `lowe`, `catherby_arrows` |
| Earth rune | 270 to 375 | Bind, 30 an account a trip | owned stock; `aubury`, `betty` |
| Water rune | 270 to 375 | Bind, 30 an account a trip | `aubury`, `betty` |
| Nature rune | 180 to 250 | Bind, 20 an account a trip | owned stock; `magic_guild` |
| Antipoison(3) | 3 to 5 potions; one in each pack at each trip | the cure of each squad account | `jiminua`: 10 potions for 4,575 coins and 60 coins of fares in 250 ticks from the Ardougne south bank (`extra:shop-jiminua`) |
| Law rune, air rune | 1 law and 5 air for each escape; 2 and 10 in each pack | Camelot Teleport | owned stock; `magic_guild`, `aubury` |

- **Antipoison by Herblore.** Claim: one account makes antipoison(3) at about 65 an hour, and the unicorn horns set
  that rate. Recipe (`brew_potion.struct`): marrentill and a vial of water give an unfinished potion, a unicorn horn
  ground with a pestle and mortar gives the dust, and the two give antipoison(3) at Herblore 5 (Druidic Ritual).
  Conditions: the two unicorns south of Edgeville (npc 89 at 3084,3454 and 3090,3450, 45 tiles from the Edgeville
  bank). The bench account has Attack and Strength 60 and a rune scimitar; the code asks for no level and no weapon
  for the unicorn target. A unicorn always drops one horn, comes back 180 ticks after its death
  (`respawnrate=180`), does not attack first and runs at 6 Hitpoints or less (`retreat,6`). The two tiles are
  outside the Wilderness (z under 3520), so no player can attack there. The zone is multi-way (`scripts/pk.ts`
  `isMulti`), which gives no protection. Evidence, seeds
  7 to 9: `fighter:unicorn` (`scripts/gather-combat.ts` `TARGET=unicorn MAX_KILLS=4`) makes 4 kills and banks 4 horns
  in 293, 297 and 301 ticks, with one wait of 138 ticks for the two to come back; `extra:antipoison-grind`, `-unf` and
  `-brew` (`scripts/microbot-production.ts` recipes `grind:unicorn_horn`, `brew:unf_marrentill_potion`,
  `brew:3doseantipoison`) each make and bank 3 units in 18, 21 and 24 ticks, so a potion costs about 21 ticks at the
  bank. Two horns each 180 ticks are about 65 an hour. Gap: the rate is an estimate from the respawn rate and one wait in each run; no
  live run; another player at the two unicorns takes kills.
- **Marrentill.** The Grand Exchange is the short source: a chaos druid gives a herb in 35 of 128 kills and the herb
  is marrentill in 24 of 128 (`chaos_druid.rs2`, `shared_droptables.rs2` `randomherb`), one marrentill in about 20
  kills. The pestle and mortar and the vials of water have shop lines (`taverley`, `jiminua`).
- **Jiminua's shelf.** Other players empty it: the shelf held 0 antipoisons and, about 650 ticks later, 1, where
  the content gives one back each 150 ticks. The last unit costs 483 coins (cost 288, `shop_sell_multiplier` 1500, `shop_delta` 20, normal stock 10).

The kit holds no prayer potion and no boost: the cheapest measured method uses none
([pvp-fight-loop](pvp-fight-loop.md), "The cost of a kill").

## Runbook

From "fixes merged, pause lifted" to "the squad repeats". Each step names its check. A failed check stops the list.

1. **State.** `bun scripts/now.ts`: no stop file with owner text, the main checkout at `origin/master`, the swarm
   up, free RAM over 4 GiB plus 1 GiB. `.practice/coordinator/jobs.json` names none of the squad accounts.
2. **Fresh status.** Each squad account and each donor has a bank read 6 hours old or less
   (`bun scripts/fleet-inspect.ts <account>` makes one). Check: `bun scripts/squad-ready.ts <a1> <a2> <a3> <a4>`
   prints no `bank read ... old` line.
3. **Stage.** Run the transfer commands that the tool prints, then the shop trips and the Grand Exchange buys for
   each `no owned spare` line. Antipoison first for the first two accounts of the list: the fleet holds 2, and one
   `jiminua` trip buys 10. Check: the tool prints `READY` for all accounts.
4. **Kit.** Each account stands at its bank. `bun scripts/squad-ready.ts <a1> <a2> <a3> <a4> --before-kit --loadouts <dir>`
   (`--ignore-prayer` too while the prayer points are still to restore),
   then `bun scripts/aio-logistics.ts <account> loadout <dir>/<account>.json` for each. Check:
   `OWNED_LOADOUT_RESULT` has `"ok":true` for each, and the tool still prints `READY`.
5. **Practice.** `bun run bench "squad-4-gang-(hunted-)?chainbind" --wait 30` passes on the source that the live run
   uses.
6. **Bounded run.** Start the watcher, then the hand run or the job with `MAX_MINUTES=10` and `TRIPS=1`. Stop
   conditions: any watcher event that is not `ended`. `.practice/stop-pk-squad` stops the squad safely.
7. **Read the run.** RESULT `ok`, `died=0`, no `dropped=` or `stranded=`, `LOGOUT` with four `logged-out`, kills
   over 0, HP lost a kill, the supplies left in the watcher's last summary. On a fault: stop, find the first failed
   line, repair, prove the repair on the bench, then one more bounded run.
8. **Repeat.** After two bounded runs with no fault, `MAX_MINUTES=60` and `TRIPS=10`, with the watcher on each run.
   Before each run: `bun scripts/squad-ready.ts` prints `READY` for all four, and each bank holds the pack again
   for each trip (20 sharks or lobsters an account a trip, the arrows of the quiver, the runes, one antipoison).
9. **Supply.** The demand lines above go to the planner. A supply account works while the squad runs. A transfer to
   a squad account runs between two squad runs, since a fleet order needs both accounts with no enabled job.
