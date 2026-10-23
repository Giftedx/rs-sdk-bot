# Food chain for the gold farm (2026-10-23)

The live gold farm (`scripts/goldfarm.ts`, 4 Thieving 99 farmers on the Ardougne knights) is paused. Five farmers
died on 2026-10-23; the last two died on stall food trips. The live GE has almost no food. This file designs and
proves a food chain from accounts we own: Mightyrod fishes and cooks, Bigpackage carries notes to Ardougne, and each
farmer takes its food by trade and never uses the stall.

Evidence levels: MEASURED practice (local server, 150 ms tick, presets), CODE-READ (rev 289 content), ESTIMATE.
All tick counts are game ticks. A live hour is 9,000 ticks (400 ms).

## Result

| Quantity | Value | Evidence |
|---|---|---|
| Cooked fish banked, steady state | **50.7 / 52.5 / 51.9 per 1,000 ticks** (454 / 438 / 443 ticks per 23-fish pack) | MEASURED practice, 3 runs |
| Cooked fish banked, first run from Cooking 1 | **60 / 55 / 58** in 1,779 / 1,724 / 1,740 ticks (33.7 / 31.9 / 33.3 per 1,000) | MEASURED practice, 3 runs |
| Food per live hour, steady | about **465** cooked trout and salmon | ESTIMATE from the steady rate |
| Burn rate, first 1,750 ticks | 5.8% / 13.0% / 4.3% (Cooking 1 to 66-68) | MEASURED practice |
| Courier cycle Ardougne - Draynor - Ardougne | **607 / 625 / 609 ticks**, 100 notes each, 100 feathers bought on the way | MEASURED practice, 3 runs |
| Farmer hand-off at Ardougne | courier 24 ticks; farmer trade at t=73 / 78 / 66, then 26 food in the pack, 34 in the bank | MEASURED practice, 3 runs |
| Farmers fed by one cook | about **9** at the live eat rate (5.5 per 1,000 ticks), about **5** at the practice rate (9.2) | ESTIMATE |

Four farmers eat 22-37 fish per 1,000 ticks. One cook makes about 51. The chain feeds the 4-farmer farm with a
margin of 1.4x to 2.3x.

## Content facts (CODE-READ, rev 289)

- **Lumbridge castle range needs Cook's Assistant.** `cooksquestrange` (`quests/quest_cook/scripts/quest_cook.rs2:93-100`)
  refuses the use until `%cookquest = ^cook_complete`. Mightyrod has not done the quest.
- **Fireplaces cook with no gate.** `fireplace` is `category=cooking_fire` (`skill_cooking/configs/cooking_source/cooking_sources.loc`),
  and `[oplocu,_cooking_fire]` (`skill_cooking/scripts/cooking.rs2:2`) only gates the Fremennik fires. The nearest
  one to the fly spot is inside the Lumbridge general store at **(3214,3249)**, 25 tiles west of the spot, north of
  the spider bank. Other cooking locs near Lumbridge: range (3230,3196), fire (3245,3246) in the goblin camp east of
  the river, fireplace (3100,3256) in Draynor (map scan with `packages/knowledge/src/jm2.ts`).
- **Levels and XP** (`cooking_generic.dbrow`): raw chicken 1 (30 XP), trout 15 (70 XP), salmon 25 (90 XP). At 25x
  that is 750 / 1,750 / 2,250 XP. Cooking 15 is 1,860 XP on this curve (`xpForLevel`), so 3 cooked chickens reach it.
- **Burn chance** (`stat_random`, `engine/script/handlers/PlayerOps.ts:591-599`: success if
  `floor(lo*(99-L)/98) + floor(hi*(L-1)/98) + 1 > rand(256)`; fire values, no range row for fish):

  | Item (lo, hi) | L1 | L15 | L25 | L30 | L40 | L50 | No burns from |
  |---|---|---|---|---|---|---|---|
  | Chicken (128, 512) | 50% | 71% | 87% | 95% | 100% | 100% | 34 |
  | Trout (88, 432) | - | 54% | 67% | 74% | 88% | 100% | 49 |
  | Salmon (68, 392) | - | - | 58% | 64% | 77% | 90% | 58 |

  Measured: Cooking went 1 -> 66-68 in the first 1,750 ticks, so burns stop in the second pack.
- **Cooking delay**: `p_delay(1)` per item, then the raw item is deleted (`cooking.rs2:178-181`). Measured 4.3-4.5 ticks
  per item (about 100 ticks per 23-item pack). One use per tick and one use after each deletion gave the same 104
  ticks for 23 items (1 run each, 600- and 900-tick test runs).
- **Chickens** (`drop tables/scripts/chicken.rs2`): always 1 raw chicken; feathers 15 at 1/4, 5 at 1/4 (5 per kill
  on average). Pen at 3225-3235, 3297-3300 (9 spawns).
- **Feathers**: fly fishing uses 1 per fish. Gerrant (Port Sarim, `port_sarim.inv` fishingshop) stocks 1,000 at base
  price 2; the price rises as the stock falls. Measured: 100 feathers and 4 boat fares took 358 coins (238 for the
  feathers, 2.4 each). Live GE ask is 70 per feather (`research/market-2026-10-23.json`).

## The chain

```
Mightyrod (scripts/fishcook.ts)                      Bigpackage (scripts/foodcourier.ts)          farmers (goldfarm.ts)
fly spot (3239,3251) -> fireplace (3214,3249)        Ardougne -> Brimhaven -> Musa -> Port Sarim  FOOD_FROM=Bigpackage
  -> Draynor bank (3092,3243) -> fly spot              (Gerrant: feathers) -> Draynor bank        FOOD_ONLY_TRADE=1
  each bank visit: GIVE_TO=Bigpackage in range?  ->  notes (trade), feathers back                 serve one trade at
     withdraw all cooked fish as notes, trade          -> Port Sarim -> Musa -> Brimhaven ->      the south bank, bank
                                                       Ardougne south bank -> trade each farmer  the notes, eat fish
```

### 1. Mightyrod: `scripts/fishcook.ts`

- Fly fishing with the 3-tick method from `scripts/generated/fishing30.ts` (knife on logs + Make 1 + Lure in one
  tick), only at spots with z >= 3248 (the giant spiders at (3243,3236) and (3245,3232) killed Mightyrod at
  (3240,3243) live). Practice: 23 fish in about 80 ticks.
- Pack: rod, feathers, knife, 2 logs, so 23 fish per pack.
- Cooks every raw item the level allows on the general store fireplace, closes level-up pages in the same tick.
- Banks at Draynor (route north of the jail guards and east of the dark wizards, from fishing30.ts).
- Below Cooking 15 with nothing to cook: kills chickens for 8 raw chicken, cooks them (Cooking 22-27 after 8).
  Measured bootstrap: 7-9 kills, 302-330 ticks.
- Feathers below `FEATHER_MIN` (3): banks the catch, then kills chickens to `FEATHER_FILL` (60). This is a fallback:
  a trip gave 5-50 feathers in about 300 ticks. The courier's feathers are the supply.
- `GIVE_TO=<courier>`: at each bank visit, when the courier stands within 12 tiles, withdraw every cooked fish as
  notes and trade them (the courier gives its feathers in the same trade). `HANDOFF_ONLY=1` only does the hand-off.

Steady pack, from the three runs (pack 2 -> pack 3): fish about 80 ticks, cook about 100, walk about 255, bank about 10.
Walking is 48% of all ticks (`walkTicks` 841-846 of 1,724-1,779).

### 2. Bigpackage: `scripts/foodcourier.ts`

- Boat legs and gangplanks copied from `scripts/generated/gecourier.ts` (that route ran live). Four fares of 30.
- `FEATHERS=<n>`: buys n feathers at Gerrant on the way out, in chunks of 50, keeping 60 coins for the fares home.
- At Draynor bank: serves trades from `FROM` (the cook) for up to `WAIT` ticks and gives its feathers in them.
- Back at the Ardougne south bank: `FARMERS=a,b,...` gives each an even share (or `PER=n`) by trade.
- Practice legs (3 runs): Port Sarim at 194-197, Draynor at 319-334, notes at 335-350, Ardougne at 607-625.

### 3. Farmers: `scripts/goldfarm.ts` changes

- Bank food is trout, salmon, then lobster, in that withdraw order (`BANK_FOOD`). Notes of any of them are banked.
- Eats the biggest food whose heal the HP loss uses in full, else the smallest (trout 7, salmon 9, lobster 12).
- `FOOD_ONLY_TRADE=1`: never the stall or the shop. Out of food in the pack and the bank, it serves one more trade
  from `FOOD_FROM` (180 s) when the last trade brought food; else it ends the run with `no food (FOOD_ONLY_TRADE)`
  and logs out with HP to spare.
- New result fields: `tradesIn`, `tradeTicks`, `bigFood` (was `lobsters`), `bankFood` in BANK lines.

## Numbers

Food demand. Live farmers ate 5-6 per 1,000 ticks (task brief; `mmtha0205` ate 56 cakes and pieces in 7,380 ticks).
Practice hand-off farmers ate 11, 10 and 11 trout in 1,200 ticks (18-22 failed picks of 3 damage each). A 9,000-tick
farm run needs about 50 fish per farmer at the live rate, about 200 for four.

Supply. 200 fish is about 3,900 ticks of steady fishcook (51 per 1,000), or 4,700 ticks from Cooking 1.

Courier. One cycle (about 610 ticks practice; leg times scale with walking, so live should be close in ticks)
carries any number of notes in one slot. One cycle per 9,000-tick farm run is enough. Cost per cycle: 120 coins of
fares plus about 2.4 coins per feather (about 465 feathers per live hour of fishing, about 1,100 coins).

## Practice proofs (quoted)

Fish and cook, preset = the live Mightyrod kit (Fishing 99, Cooking 1, Attack 5, Thieving 51, rod, knife, 2 logs)
with 300 feathers at (3239,3251); `bun scripts/measure/food-chain.ts fish 3 1`:

```
run 1 | RESULT ok ticks=1779 caught=61 cooked=65 burnt=4 burnPct=5.8 banked=60 bankFish=60 given=0 foodPerKTicks=33.7 cooking=1->68 fishXp=86250 packs=3 cycles=91 kills=9 feathersGot=5 fishTicks=279 cookTicks=300 walkTicks=846 bankTicks=31 chickenTicks=323 ... died=false
run 2 | RESULT ok ticks=1724 caught=61 cooked=60 burnt=9 burnPct=13.0 banked=55 bankFish=55 given=0 foodPerKTicks=31.9 cooking=1->66 fishXp=86750 packs=3 cycles=79 kills=7 feathersGot=50 fishTicks=242 cookTicks=301 walkTicks=845 bankTicks=34 chickenTicks=302 ... died=false
run 3 | RESULT ok ticks=1740 caught=61 cooked=66 burnt=3 burnPct=4.3 banked=58 bankFish=58 given=0 foodPerKTicks=33.3 cooking=1->68 fishXp=90250 packs=3 cycles=78 kills=7 feathersGot=35 fishTicks=239 cookTicks=301 walkTicks=841 bankTicks=29 chickenTicks=330 ... died=false
BANK lines: run 1 pack=2 t=1201, pack=3 t=1655; run 2 t=1171, t=1609; run 3 t=1173, t=1616
```

`cooked` counts chickens too; `banked` counts fish only. The loop checks `TICKS` (1,500) between steps, so a run
ends after its last bank trip.

Hand-off at Ardougne, farmer preset Thieving 99 with no food at (2654,3283), courier with 60 noted trout;
`bun scripts/measure/food-chain.ts handoff` (goldfarm `FOOD_FROM=<courier> FOOD_ONLY_TRADE=1 TICKS=1200`, courier
`GIVE=Trout:60 bun scripts/give-to-banker.ts <courier> <farmer>`):

```
courier | RESULT ok trades=1 slots=1 coins=200 left=0
farmer | TRADE max_trades Completed 1 trade(s) (1 session(s)) notes=60 bigFood=0 t=73
farmer | BANK trip=2 banked=0 bigFood=26 bankFood=34 t=80
farmer | RESULT ok ticks=1200 picks=302 fails=22 ... eaten=11 bankTrips=2 ... stallTrips=0 ... shopTrips=0 ... hpMin=4 died=false ... bigFood=15 food=15 tradesIn=1 tradeTicks=68
farmer | TRADE max_trades Completed 1 trade(s) (1 session(s)) notes=60 bigFood=0 t=78
farmer | RESULT ok ticks=1201 picks=363 fails=18 ... eaten=10 ... stallTrips=0 ... hpMin=4 died=false ... bigFood=17 food=17 tradesIn=1 tradeTicks=73
farmer | TRADE max_trades Completed 1 trade(s) (1 session(s)) notes=60 bigFood=0 t=66
farmer | RESULT ok ticks=1200 picks=324 fails=22 ... eaten=11 ... stallTrips=0 ... hpMin=4 died=false ... bigFood=15 food=15 tradesIn=1 tradeTicks=61
```

No-food end path (`bun scripts/measure/food-chain.ts alone`: farmer with 300 coins, no food, `FOOD_FROM` names an
absent account): it waits 180 s for the trade, then logs out without a stall or shop trip:

```
farmer | TRADE timeout Serving window ended after 0 completed trade(s) (0 session(s)) notes=0 bigFood=0 t=1207
farmer | RESULT fail no food (FOOD_ONLY_TRADE) ticks=1211 picks=0 ... stallTrips=0 ... shopTrips=0 ... hpMin=10 died=false ... tradeTicks=1200 hp=10
```

The 180 s wait is wall time: 1,200 ticks on practice, 450 ticks live.

Courier cycle, courier at the Ardougne south bank with 500 coins, cook preset at Draynor bank with 100 cooked trout
banked (`HANDOFF_ONLY=1 GIVE_TO=<courier>`); `bun scripts/measure/food-chain.ts courier` (`FEATHERS=100`):

```
courier | RESULT ok ticks=607 received=100 ... coins=142 walkTicks=456 boatTicks=111 waitTicks=16 featherTicks=34 feathersBought=100 feathersLeft=0 legs=sarim@195,draynor@319,received100@335,ardougne@607 hpMin=9 died=false
cook | RESULT ok ticks=335 ... given=100 ... feathers=200 ... died=false
courier | RESULT ok ticks=625 received=100 ... legs=sarim@197,draynor@334,received100@350,ardougne@625 hpMin=8 died=false
courier | RESULT ok ticks=609 received=100 ... legs=sarim@194,draynor@319,received100@335,ardougne@609 hpMin=8 died=false
```

Paths these proofs ran: chicken bootstrap from Cooking 1, 3-tick fly fishing, fireplace cooking with level-ups,
Draynor banking, hand-off by notes at Draynor with feathers back, both boat legs, Gerrant feathers, give-to-banker
notes to a farmer, farmer note banking and withdraw, trout eating. Paths NOT run: `GIVE_TO` during a normal
fishcook loop (the proof used `HANDOFF_ONLY`), the chicken feather top-up (`FEATHER_MIN`), the foodcourier `FARMERS`
hand-out (the farmer leg was proved with give-to-banker), river troll and whirlpool
events, a live run of any part.

## Launch (lead runs live; none of this was run live)

1. Mightyrod (live: Lumbridge 3231,3259, Cooking 1, 27 feathers, 13 coins, 5 raw fish):
   `DEMO_OK=1 TICKS=9000 GIVE_TO=Bigpackage bun scripts/fishcook.ts Mightyrod`.
   It bootstraps Cooking with chickens, then fishes; with 27 feathers it reaches the chicken top-up after about one
   pack, so start the courier soon.
2. Bigpackage (live: Ardougne south bank, 1,505 coins): `DEMO_OK=1 FROM=Mightyrod FEATHERS=300 WAIT=1500
   bun scripts/foodcourier.ts Bigpackage`. 300 feathers cost about 1,000 coins (ESTIMATE; Gerrant's live stock is
   shared). It waits at Draynor up to 1,500 ticks for Mightyrod's next bank visit (one pack is about 450 ticks).
3. When Bigpackage prints `MILESTONE ardougne`, start each farmer with
   `DEMO_OK=1 FOOD_FROM=Bigpackage FOOD_ONLY_TRADE=1 bun scripts/goldfarm.ts <farmer>` and give its share with
   `DEMO_OK=1 GIVE=Trout:<n>,Salmon:<m> bun scripts/give-to-banker.ts Bigpackage <farmer>` (the proved path), or
   run step 2 with `FARMERS=Pocketpython,Pocketrocket,mmtha0205,mmthv2350` while the farmers serve.
4. Repeat step 2 once per farm run (about 50 fish per farmer per 9,000 ticks).

## Open

- Live rates: Mightyrod's fly spot, the chickens and Gerrant's feathers are shared with other players.
- Walking is 48% of the cook's ticks. Handing the pack to a courier waiting at the fly spot would cut the Draynor
  walk (about 185 ticks of the 445-tick cycle); not built.
- Cooking runs at 4.3 ticks per item; the content allows 2 (`p_delay(1)`); not found why.
- The courier hand-out needs the farmers to serve at the right time; the lead sequences it by hand.
- Farmer eat rate per 1,000 ticks: live 5-6 vs practice 9.2; measure on the first live run.

## Live run 1 (2026-10-23)

- Mightyrod `fishcook.ts` with `GIVE_TO=Bigpackage`: Cooking 1 to 45 by t=377. It gave 2 Trout and 7 Salmon at t=511. This proves the hand-off inside the normal loop on live.
- Bigpackage `foodcourier.ts`: `RESULT ok ticks=741 received=9 ... coins=5 ... feathersBought=260 ... hpMin=9 died=false`. The round trip took 741 ticks. `FEATHERS=300` spent 1,500 of its 1,505 coins. Later trips must use `FEATHERS=0`.
- Pocketrocket `goldfarm.ts` with `FOOD_FROM=Bigpackage FOOD_ONLY_TRADE=1`: `TRADE max_trades Completed 1 trade(s) ... notes=9` at t=90 (from `give-to-banker.ts` with `GIVE=Trout:2,Salmon:7`).
- The first trip carried only 9 fish because Mightyrod had cooked only 9 by then. The next trip waits for a full load.

## Live run 2 (2026-10-23)

- Trip 2 failed first: `RESULT fail needs 120 coins for four boat fares` (coins=5 after trip 1's feathers). Fix 84b83ab: the courier takes 500 coins from its bank when the pack has fewer than 120. mmtha0205 gave 1,000 coins through `banker.ts Bigpackage`.
- Courier: `RESULT ok ticks=984 received=129 ... coins=380 walkTicks=445 boatTicks=114 waitTicks=418`. It waited 418 ticks at Draynor for Mightyrod's fish.
- Mightyrod: `BANK pack=7 banked=138 bankFish=129 t=3553`, then `MILESTONE gave 58 Trout, 71 Salmon t=3582`. Cooking 1 to 80 in 3,455 ticks.
- Pocketrocket: `TRADE max_trades Completed 1 trade(s) (1 session(s)) notes=129 bigFood=1 t=2999`. It waited 155 ticks with 1 food.
- Eat rate: Pocketrocket ate 15 food in its first 2,000 ticks (7.5 per 1,000 ticks). 129 fish last about 17,000 ticks.
