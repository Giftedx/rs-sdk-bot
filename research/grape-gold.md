# Grape gold: is the grape bid a gold lever? (2026-10-23)

Verdict: **no.** The "10 grapes every 80 ticks at Almera's house" spawn does not exist. The two real grape
spawns give 1 grape each, need a quest or a level that our idle accounts do not have, and 4 to 6 other players
already stand on each one. The bid is real and fills at once, but a picker earns at most about 16 coins per tick
alone at a spawn, and about 2 coins per tick when it shares the spawn with the campers we saw.

## 1. Spawn facts (CODE-READ)

| Claim | Fact | Source |
|---|---|---|
| 10 grapes at (2509,3493), respawn 80 | **Wrong.** The line `0 13 37: 1987 10` is in the `==== LOC ====` section (starts at line 4671; the file has no OBJ section). It is loc 1987 `lograft_waterfall_quest`, shape 10: the Waterfall quest log raft. Our own `scripts/generated/waterfall.ts:14` uses `raft: { id: 1987, x: 2509, z: 3493 }` | `maps/m39_54.jm2:4671,5026`; `pack/loc.pack:1988` |
| Grape spawn 1 | 1 grape at (3144,3450, level 2), Cooks' Guild top floor | `maps/m49_53.jm2:10228` (OBJ section), `:10243` `2 8 58: 1987 1` |
| Grape spawn 2 | 1 grape at (3237,9761, level 0), Phoenix Gang hideout under Varrock, behind `phoenixdoor` (3247,9779) | `maps/m50_152.jm2:4121` (OBJ section), `:4122` `0 37 33: 1987 1`; world.json gate `phoenixdoor`, `quest_blackarmgang.rs2:17` |
| Other grape spawns | None. All three `1987` hits in `maps/` are listed above | `grep -rn "\b1987\b" maps` |
| Respawn | `respawnrate=80` on `[grapes]`; `World.removeObj` scales it by `(4000 - min(players, 2000)) / 4000`, rounded down | `wine.obj` `[grapes]`; `engine/src/engine/World.ts:1750,2061-2065` |
| Pick needs | Cooks' Guild: Cooking 32 **and** a worn chef's hat to pass the `chefdoor` from outside. Hideout: joined the Phoenix Gang (Shield of Arrav stage). No skill check on the pickup itself (`pickup.rs2`: inventory space only) | `skill_cooking/scripts/cooking_guild.rs2:1-18`; `player/scripts/pickup.rs2` |
| Chef's hat source | No map spawn (the 1949 hits in `m45_52`, `m45_55` are LOC lines). Fancy clothes store stock 0. NPC drops: goblin, imp, pirate. Live GE: 0 sellers, one bid of 20 | `knowledge/shops.json:5605`; `drop tables/scripts/goblin.rs2:45`, `imp.rs2:71`, `pirate.rs2:53`; `/api/market/items/1949` |
| Noted grapes | `cert_grapes` (1988) exists, and the GE takes the noted form from the backpack | `pack/obj.pack:1989`; `engine/src/engine/market/GrandExchange.ts:132-138` |
| Other sources | Goblin drop 1/128 (`goblin.rs2:121`). No shop sells grapes | `knowledge/shops.json` (no grapes row) |

Our idle accounts (status files, 2026-10-23): Mightyrod Cooking 1, Bigchopper Cooking 1. Neither can enter the
Cooks' Guild. Phoenix Gang membership is not recorded for either; not verified.

## 2. GE bid (MEASURED live, 2026-10-23 about 13:35Z)

`GET /api/market/items/1987`:

```
bid: 1000  ask: null  buyQuantity: 96282  sellQuantity: 0  volume: 4317  gross: 4840014  tax: 241997
trades: 170  lastPrice: 1000  lastTradeAt: 1792758332687  vwap: 1121.15
```

- The bid fell from 96,859 (supply-logistics.md:51) to 96,282: other players sell into it now.
- Daily history (`/history?interval=86400000`): 16, 1,845, 1,038, 1,418 grapes on the last 4 days. Hourly
  history: 24 to 228 grapes per hour; the last two hours 147 and 228.
- Match rule (CODE-READ, `engine/src/engine/market/MarketStore.ts:137-170`): a sell offer at a price at or
  below the best bid fills at once at the **resting bid price** (`executionPrice = resting.price`). Tax is
  `floor(gross / 20)` cumulative per sell offer: 5%. So 28 grapes sold at any price up to 1,000 give
  28,000 - 1,400 = **26,600 coins**, 950 per grape.

## 3. Competition (MEASURED live, world feed, 300 s, roster of 1,218 players, `tickMs=400`)

`wss://rs-sdk-demo.fly.dev/worldfeed`, roster on, players within 1 tile of a spawn for all 30 roster frames
(ticks 148,250 to 148,540):

- Cooks' Guild spawn (3143-3144,3450-3451,2): Jackalopevin, V62fw09, V62fw04, Fablescout, Acq973tvlg, Cairn H46.
  **6 campers.**
- Hideout spawn (3237,9762,0): Jenkins39, V62fw03, V62fw10, Tmvintner1. **4 campers.**
- Almera tile (2480-2540, 3465-3525 subscription): no player in 300 s.

## 4. Loop and route (CODE-READ + pathfinder)

Loop (`scripts/grapes.ts`): stand on the spawn floor; pick the grape on the tick it shows; at `BANK_AT`
grapes climb the ladder and the staircase, walk out of the chefdoor to Varrock west bank, deposit, walk back.
Every loop path awaits a tick. Bank later as notes; a GE trip needs no extra walk (the GE is in that bank).

Route: `bun research/route-danger.ts 3143,3443 3185,3436` gives
`ROUTE 3143,3443 -> 3185,3436: 75 tiles, 0 danger spawns in reach (margin 3)`.

## 5. Practice runs (MEASURED practice, preset `grapes_cooksguild`, 1,500 ticks, one bot)

Practice has few players, so the respawn is the full 80 ticks.

| Run | Bot | BANK_AT | Grapes | Banked | Bank trips | Gaps between picks | Line |
|---|---|---|---|---|---|---|---|
| 1 | grapesxxhb01 | 26 | 19 | 0 | 0 | 18 x 82 | `RESULT ok ticks=1500 picks=19 banked=0 held=19 bankTrips=0 ... gaps=82,...,82 ... grapesPer1kTicks=12.67` |
| 2 | grapesxqk101 | 5 | 18 (from milestones) | 15 | 3 | - | `MILESTONE bank 385 banked=5`, `810 banked=10`, `1235 banked=15` (the RESULT line was cut by the harness filter) |
| 3 | grapesc3x01 | 5 | 18 (from milestones) | 15 | 3 | - | `MILESTONE bank 384 banked=5`, `809 banked=10`, `1234 banked=15` (same filter issue) |
| 4 | grapesd4x01 | 5 | 18 | 15 | 3 | 82, and 97 after each bank trip | `RESULT ok ticks=1500 picks=18 banked=15 held=3 bankTrips=3 tries=18 lost=0 walkTicks=240 ... hpMin=10 grapesPer1kTicks=12.00` |

- A pick lands 82 ticks after the last one: 80 respawn + 2 ticks for the pickup (`pickupItem` waits 1 tick
  before it sends).
- One bank trip is 80 ticks (`walkTicks=240` for 3 trips) and costs 15 ticks of respawn (gap 97).
- Rate on practice: 18-19 grapes per 1,500 ticks, 12.0-12.7 per 1,000 ticks. With `BANK_AT 26`: 26 grapes per
  25 x 82 + 97 = 2,147 ticks (ESTIMATE from these gaps).
- No HP loss in any run (`hpMin=10`).

## 6. Coins per tick (ESTIMATE from the numbers above)

Live respawn at the roster count of 1,191 to 1,218: `floor(80 x (4000 - 1,218) / 4000)` = 55 ticks; gap about
57 ticks.

| Case | Grapes per tick | Coins per tick (950 net each) | Coins per live hour (9,000 ticks) |
|---|---|---|---|
| Alone at one spawn, BANK_AT 26 | 26 / (25 x 57 + 97) = 0.0171 (the 80-tick bank trip is longer than the respawn) | **16.2** | 146k |
| Shared with the 6 Cooks' Guild campers (1/7) | 0.0024 | **2.3** | 21k |
| Old claim (10 per 80 ticks at Almera) | 0.125 | 119 | 1.07M |

Gold farmers: 9-15 coins per tick each (`research/learning-report.md`). A grape picker matches one farmer only
when it is alone at a spawn, needs Cooking 32 and a chef's hat (or Phoenix Gang), and cannot scale: there are
2 spawns of 1 grape in the game. The whole market sold 24 to 228 grapes per hour on the live server, which fits
the 2 spawns (about 160 each per hour at most) already being taken.

## 7. Live micro-test: not run

The task allows it only if steps 1-4 show the method works. Step 1 shows the Almera spawn does not exist, and
neither Mightyrod nor Bigchopper can enter either real spawn (Cooking 1, no chef's hat; Phoenix Gang not
verified). No account was logged in to the live server. No grapes were sold, so "coins received" is not
measured; the 950-per-grape figure is CODE-READ.

## 8. Open

- Whether the Haggis supply plan still needs 601 grapes: the only routes are these 2 contested spawns (about
  160 per hour each, shared) or the GE, where we would compete with a 96k bid at 1,000.
- `supply-logistics.md:51-54`, `:160` and `cooking-board.md:14,32` still cite the Almera spawn (INDEX C20).
