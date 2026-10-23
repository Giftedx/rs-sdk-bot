# Supply logistics for the Haggis run (2026-10-23)

Gate 3 of `scripts/haggis-gate.ts` ("supplies staged") needs every item that the main account uses, held by a
helper at the right place before Haggis logs in. This file lists the items, the cheapest legal source of each,
the helper job that gets it, and the gold and helper-hours in total.

Evidence levels:

- **MEASURED live**: `research/market-2026-10-23.json` (snapshot 06:53Z) and 6 read-only GETs to
  `/api/market/items/<id>` at 12:25Z (jug_empty, lobster, rune_arrow, unicorn_horn, chocolate_bar,
  blue_dragon_scale).
- **MEASURED practice**: rates from `research/supply-floors.md`, `research/gathering-tricks.md`,
  `research/board-ranking-honest.md`.
- **CODE-READ**: rev 289 content (`vendor/rs-sdk/server/content`), `knowledge/*.json`,
  `knowledge/ubermouse/world.json`.
- **ESTIMATE**: every rate, time and coin total that no run measured. Each one says what it rests on.

Content-bug methods are out: login wine, Charge spam, cocktails and pyre oil without a level check.

## Summary

1. **Four manifest lines have no legal source at the scale the planner asks for (CODE-READ).** The planner's
   exact manifest cannot pass gate 3. These lines need a planner change before staging starts:
   - **Torstol, 176.** The only source in rev 289 is the Yanille agility dungeon chest. It gives 1 torstol per
     sinister key (`areas/area_yanille/scripts/agility_dungeon.rs2:103-120`). The key drops from Salarin the
     Twisted at 10/128 (`drop tables/scripts/salarin_the_twisted.rs2:17,45-46`). That is about 2,250 Salarin
     kills. `randomherb` has no torstol, toadflax or snapdragon (`drop tables/scripts/shared_droptables.rs2:2-34`).
   - **Snapdragon 6 and toadflax 2.** No drop, shop, spawn or chest gives them. The only hits are the skill guide
     and the agility arena text (`grep` over `scripts/`, 2026-10-23).
   - **Uncut dragonstone, 305 for Crafting, plus 453 for the dragonstone amulets of the Magic band.** The only
     source is the Taverley crystal chest, 1 per crystal key (`areas/area_taverly/scripts/crystal_chest.rs2:24`).
     A key needs two key halves, and each half is 1/128 of the `randomjewel` roll (`shared_droptables.rs2:58-65`).
     The GE has 0 sellers and 100 bid at 1,000,000 (MEASURED live).
   - **Cosmic runes, 546.** One shop holds 20 (Mage Arena, restock 1 per 100 ticks). The GE has 1 seller at
     10,000 (MEASURED live). Lvl-5 enchant needs the dragonstone amulets anyway, so this line goes when the
     Magic method changes.
2. **Rune dart tips (1,520) have no seller and no shop.** Smithing them needs runite bars, Smithing 89 and
   Tourist Trap (`research/supply-costs.md:47-49`). Rune arrows give the same XP per action (4,687.5 against 4,700,
   `supply-floors.md:88-89`). Replace the dart band with rune arrows. The cost is 2,280 more rune arrowtips from
   2 shops, about 6.3 hours of restock. The rune arrows that the main makes also cover the 850 Ranged arrows.
3. **The critical path is not the main clock.** Gate 3 needs every item staged before tick 0. So the longest
   lead time decides the staging date, not the tick at which the main uses the item. The longest jobs are the
   rune arrowtip restock (6.3 h), the herb kills for the replacement Herblore plan (about 5 h with 2 accounts),
   the mithril, adamant and coal mining (about 4.5 h with 2 accounts), and gold (about 5.6 h of farming).
4. **Totals (ESTIMATE).** About 62 helper-hours. About 5.0M coins, against 1.1M held. The gap is 3.9M, which is
   about 5.6 h of the gold farm at 700k per hour. The earliest full staging of the substituted manifest is about
   **2026-10-23 20:00Z**, if 11 accounts start at 13:00Z today and the shops and spawns have no competition.
   Allow until 2026-10-24 00:00Z for hand-offs to the staging points.
   Dragon bones by GE purchase over time move the date to about 2026-10-30. Dragon bones by kills need a combat
   helper that has the anti-dragon shield (not verified how).
5. **Gold lever, not counted (MEASURED live bid, ESTIMATE rate).** Grapes have a standing GE bid of 1,000 coins
   for 96,859. The Almera grape stack respawns 10 grapes every 80 ticks (`maps/m39_54.jm2:5026`,
   `wine.obj` `respawnrate=80`). That is up to 1,125 grapes, 1.1M coins, per hour, if the bid fills and no one
   else picks there. That beats the 4 thieving farmers together. Measure one hour before the plan uses it.

## 1. Manifest

Source: `bun packages/planner/src/haggis-cli.ts research/hiscores-live.json --levers --supplies` (scenario a, the
realistic supply list) and `--order` (scenario a, realistic start ticks). The three scenarios print the same
supply list. Counts are CODE-READ from the planner. "Needed at" is the start tick of the first activity that uses
the item, on the main clock. "Trade 1" is the trade at tick 10.

### Early boards (Trade 1 to tick 3,055)

| Item | Count | Activity | Needed at |
|---|---|---|---|
| bronze arrowtips | 60 | Fletching (row 7) | Trade 1, tick 10 |
| headless arrows | 1,290 | Fletching | 10 |
| iron arrowtips | 45 | Fletching | 10 |
| iron dart tips | 40 | Fletching | 10 |
| feathers | 2,360 | Fletching (darts) and fly fishing | 10 |
| steel arrowtips | 135 | Fletching | 10 |
| mithril arrowtips | 240 | Fletching | 10 |
| adamant arrowtips | 495 | Fletching | 10 |
| rune arrowtips | 315 | Fletching | 10 |
| rune dart tips | 1,520 | Fletching | 10 |
| unfermented wine (noted) | 600 | Cooking wine timer (rows 5-6) | 10 |
| grapes, jug of water | 1 each | Cooking: the one hand-made wine | 10 |
| egg, bucket of milk, pot of flour | 1 each | Cook's Assistant (row 3) | 10 |
| uncooked stew 3, raw shrimps 2, coins 10 | - | Cooking 30 to 35 (row 4), toll gate | 10 |
| chisel | 1 | Crafting (row 8) | 206 |
| uncut opal 5, jade 2, red topaz 2, sapphire 3, emerald 3, ruby 5, diamond 11 | 31 | Crafting 1-55 | 206 |
| uncut dragonstone | 305 | Crafting 55-99 | 206 |
| unfinished potions: guam 1, marrentill 1, tarromin 2, harralander 3, ranarr 7, toadflax 2, irit 5, avantoe 6, kwuarm 12, snapdragon 6, cadantine 7, lantadyme 15, dwarf weed 13 | 80 | Herblore (row 9) | 401 |
| torstol potion (unf) | 176 | Herblore 78-99 | 401 |
| secondaries: eye of newt 4, unicorn horn dust 3, limpwurt 9, red spiders' eggs 7, chocolate dust 2, white berries 9, toad's legs 2, snape grass 7, mort myre fungus 4, dragon scale dust 13, wine of zamorak 13, potato cactus 7 | 80 | Herblore | 401 |
| jangerberries | 176 | Herblore 78-99 | 401 |
| logs 27, oak 4, willow 7, maple 13, yew 25, magic 107 | 183 | Firemaking (row 11) | 647 |
| tinderbox | 1 | Firemaking | 647 |
| dragon bones | 560 | Prayer 31 (row 12, a few bones), rest row 24 | 1,427 (few) / 19,814 (rest) |
| bronze 34, iron 35, steel 95, mithril 280, adamantite 345 bars | 789 | Smithing (row 13) | 1,590 |
| hammer | 1 | Smithing | 1,590 |
| rune essence | 4,213 | Runecraft (row 14) | 3,055 |
| air, fire, body, nature, law talismans | 1 each | Runecraft | 3,055 |

### Late boards (tick 5,117 and later)

| Item | Count | Activity | Needed at |
|---|---|---|---|
| lobster | 610 | Food for quests and combat (rows 15-37) | 5,117 |
| rune armour set | 1 | Combat (Monkey Madness row 20, melee rows 29-33) | 11,023 |
| air 86, mind 5, cosmic 546, water 6,807, fire 80, earth 7,175 runes | 14,699 | Enchant jewellery (row 22) | 16,195 |
| sapphire rings 12, emerald rings 27, ruby rings 16, diamond rings 38, dragonstone amulets 453 | 546 | Enchant jewellery | 16,195 |
| rune axe, knife 2 | - | 3-tick woodcutting (row 23) | 19,814 |
| fly fishing rod, lobster pot, harpoon | 1 each | Fishing (row 26) | 24,477 |
| rune pickaxe | 1 | Mining (row 28) | 29,049 |
| anti-dragon shield (quest) | 1 | Dragon Slayer (row 43) | 51,761 |
| cannon (base, stand, barrels, furnace) | 1 | Ranged (row 32) | 33,991 |
| cannonballs | 1,700 | Ranged | 33,991 |
| rune arrows 850, magic shortbow, yew shortbow | - | Ranged | 33,991 |
| black d'hide body, chaps, vambraces; coif | 1 set | Ranged | 33,991 |
| best-in-slot worn set | 1 | Equipment (row 48) | 105,240 |
| coins and high-value items above the #1 bank | 1 | Bank (row 49) | 105,299 |

### Proposed substitutions (the manifest that can pass gate 3)

| Planner line | Replace with | Effect on the main (ESTIMATE) | Evidence |
|---|---|---|---|
| rune dart tips 1,520 + 1,520 feathers | 2,280 rune arrowtips + 2,280 headless arrows (152 actions of 15) | Same XP per action, same 5 per tick. Fletching stays at 49 ticks. The 2,595 rune arrows cover the 850 Ranged arrows | CODE-READ `darts.dbrow`, `arrows.dbrow` via `supply-floors.md:78-108` |
| iron dart tips 40 (band 22-30) | 60 iron arrowtips + 60 headless arrows (4 actions) | 937.5 against 950 XP per action. The same 4 actions | CODE-READ `supply-floors.md:83-84` |
| torstol 176, jangerberries 176, snapdragon 6, toadflax 2 | Herbs from `randomherb` drops, each made into its best potion with a secondary that exists at scale (below) | About 1,080 potions instead of about 420. Herblore rises from 246 to about 630 ticks, against #1 447. **The board loses** | CODE-READ drop tables + ESTIMATE |
| uncut dragonstone 305 | uncut diamonds, 354 for 55-99 (2,687.5 XP each), GE purchase over time | About +35 main ticks. Crafting rises from 194 to about 230 against #1 197. **The board loses** | MEASURED live (diamond 592 trades in 7 days) + ESTIMATE |
| 546 jewellery items and 546 cosmic runes (Magic) | Teleports with law runes, the route in `supply-costs.md:39`: 722 law runes from 45 | Cast rate not measured. Magic is already late by 18,129 in the run | CODE-READ + MEASURED live (laws: 423 sellers at 2,697) |

Herblore replacement detail (CODE-READ `shared_droptables.rs2:2-34`, XP from `supply-floors.md:145-166`):

- Use 6 herbs: guam (32/128 of drops, attack potion with eye of newt, 625 XP), harralander (14/128, restore with
  red spiders' eggs, 1,562.5), ranarr (11/128, prayer with snape grass, 2,187.5), irit (8/128, super attack with
  eye of newt, 2,500), avantoe (6/128, fishing with snape grass, 2,812.5), kwuarm (5/128, super strength with
  limpwurt, 3,125).
- That is 925 XP per herb drop on average. Herblore 3 to 99 is 998,291 XP, so about 1,080 herb drops.
- Chaos druids give 0.445 herb rolls per kill (0.2734 + 0.0859 + 0.0859, `knowledge/drops.json` `chaos_druid`).
  So about 2,420 kills.
- Secondaries for 1,080 drops: eye of newt 340 (Taverley herb shop, 800 stock), red spiders' eggs 120 (15 ground
  spawns, 7 of them inside the Edgeville dungeon at 3117-3129, 9948-9958), snape grass 145 (3 spawns at
  2906-2917, 3274-3297, respawn 30 ticks), limpwurt 42 (hill giants, 0.0859 per kill, about 490 kills. The same
  dungeon has 12 giants), vials of water 1,080 (Ardougne adventurer shop, 500 stock, 1 per 30 ticks).
- Adding cadantine (white berries), marrentill (unicorn horn dust) and tarromin (limpwurt) cuts the kills to about
  1,610. Each one adds a secondary chain: white berries spawn in the Wilderness at about level 37
  (3214,3809 and 3218,3814), unicorns drop 1 horn each (`drop tables/scripts/unicorn.rs2`), and tarromin needs
  about 300 more giant kills.
- Herb level checks: identify needs the herb's level (`identify.rs2` `attempt_identify_herb`), and the unfinished
  potion needs the struct level (`brew_potion.rs2:121-132`). A helper with low Herblore cannot clean or mix herbs
  above its level. Either the main identifies and mixes (item-on-item, 0 XP, about +100 to +200 main ticks,
  ESTIMATE) or a helper trains Herblore first.

## 2. Source and helper per item

"Ask" is the lowest GE sell price. "Shop a@b" means a in stock, 1 restocked every b ticks (CODE-READ
`knowledge/shops.json`). A shop sells above base cost when its stock is low (`shop/scripts/shop.rs2:139-200`).
9,000 ticks = 1 live hour.

| Item | Cheapest legal source | Helper | Evidence |
|---|---|---|---|
| bronze, iron, steel, mithril arrowtips (60, 105, 135, 240) | Shop: Catherby archery shop `archeryshop2` (2822,3442, Catherby bank 13 tiles): 1000@10, 800@20, 600@40, 400@40 | Mightyrod | CODE-READ |
| adamant arrowtips 495 | Shop: Catherby 200@40 + Ranging Guild 200@50 (2670,3435, Ranged 40). 400 at once, the rest in under 1 h | Mightyrod + N3 | CODE-READ |
| rune arrowtips 2,595 (315 + 2,280 swap) | Shop only, GE 0 sellers. Catherby 100@40 + Ranging Guild 150@60: 250 at once + 375 per hour = **6.3 h**. Catherby alone: 225 per hour = 11.1 h. Price about 330-500 each (the first 250 cost 82,250) | Mightyrod (Catherby), N3 (Ranging Guild) | CODE-READ + MEASURED live (0 sellers) + ESTIMATE (price) |
| headless arrows 3,570 (1,290 + 2,280 swap) | Make: arrow shafts (15 per normal log) + feathers. 238 logs. GE 0 sellers | Bigchopper (WC 99) chops and fletches | CODE-READ + ESTIMATE (about 0.8 h: chop 238 logs, cut, attach) |
| feathers about 4,370 (main fishing + headless arrows) | Shop: Port Sarim fishing shop 1000@1 (3013,3225); GE 535 at 70 | Bigpackage | CODE-READ + MEASURED live |
| grapes 601 | Ground spawn: 10 at (2509,3493) near Almera's house, respawn 80 ticks; 1 in the Cooks' Guild (3144,3450,2), Cooking 32. GE 0 sellers, 96,859 bid at 1,000 | N1 (new, no level) | CODE-READ (`m39_54.jm2:5026`, `m49_53.jm2:10243`, `wine.obj`) + MEASURED live; rate ESTIMATE 1,125 per hour, contested |
| jugs of water 601 | Empty jugs: 22 general stores, 2 each, 1 per 100 ticks; imps 1/64. Jug of water: Shantay 10, Bedabin 5. Fill at a fountain. GE 0 sellers (12:25Z) | Bigpackage (store circuit) | CODE-READ + MEASURED live; ESTIMATE 250-350 jugs per hour, about 2 h |
| unfermented wine 600 | Make: grapes on a jug of water, Cooking 35, instant (`wine.rs2:7-20`). The maker's 20-tick timer ferments the maker's own pack and bank (`wine.rs2:22-70`), and each make resets it (`settimer`). The maker must trade each batch to a courier within 20 ticks. A courier that never made wine has no timer | N2 (new, Cook's Assistant + stew and shrimp to 35, the main's route) + Bigpackage | CODE-READ; ESTIMATE 30 ticks per 14 wines, about 0.15 h |
| Cook's Assistant items, stew 3, shrimps 2 | Lumbridge farm and shops | Bigpackage | ESTIMATE 0.3 h |
| uncut opal, jade, red topaz, sapphire, emerald, ruby, diamond (31) | GE purchase over time. Bids must beat the standing 2,500 (3,500 for diamonds). 7-day trades: opal 9,793, jade 5,886, sapphire 4,383, ruby 1,306, red topaz 1,243, emerald 705, diamond 592 | Moneyshot places bids | MEASURED live; ESTIMATE 1-2 days, about 150k coins |
| uncut dragonstone 305 | **No legal source at scale** (Summary item 1). Substitute: 354 uncut diamonds by GE over time, about 1.8M coins, 4-7 days | Moneyshot | CODE-READ + ESTIMATE |
| herbs (substituted plan) | Kills: chaos druids, Edgeville dungeon (3110,9936, 11 spawns, combat 13, 20 HP, respawn 50 ticks), Taverley dungeon (6). GE now: about 285 low herbs at 2,000-4,000 (too costly) | N4a, N4b (new combat accounts) | CODE-READ; kill rate ESTIMATE 500 per hour per account |
| torstol, snapdragon, toadflax | **No legal source at scale** | - | CODE-READ |
| herb secondaries | See section 1, Herblore replacement detail | N4a, N4b + Bigpackage (shops) | CODE-READ + ESTIMATE |
| jangerberries 176 (planner plan only) | Ground spawns: 4 at Yanille (2510-2517, 3080-3090), respawn 30 ticks, up to 1,200 per hour | N1 | CODE-READ |
| logs 27, maple 13 | Chop. GE 0 sellers. Seers' maples | Bigchopper | CODE-READ + MEASURED live |
| oak 4, willow 7, yew 25, magic 107 | GE now: 27 at 19, 67 at 40, 48,462 at 379, 56,003 at 2,250 | Bigpackage | MEASURED live; 251k coins |
| dragon bones 560 | GE now: 16 at 19,000 (304k). GE over time: 585 trades in 7 days, standing bid 5,000 for 1,253, so about 7 days at a bid near 8,000 (4.5M). Kills: every dragon drops 1 bone and 1 hide (`all.npc` `death_drop`). Green dragons: 5 spawns at Wilderness level about 37 (3078-3118, 3810-3821), 75 HP, respawn 60 ticks. Dragonfire hits up to 50 without the anti-dragon shield and 5 with it (`npc/scripts/dragon.rs2:110-125`). The Duke gives the shield only at a Dragon Slayer stage (`duke_horacio.rs2:4`) | Buy 16 now: Moneyshot. Rest: N4 after it gets the shield, or GE over time | CODE-READ + MEASURED live; kill rate ESTIMATE 150-250 per hour |
| bronze bars 34 | Shop: Shantay 10@500, 2 jungle stores 10@500 | Bigpackage | CODE-READ |
| iron bars 35 | Smelt from GE iron ore (22 at 110 now; 556,998 trades in 7 days) | N5 (it smelts iron to train Smithing) | MEASURED live + CODE-READ |
| steel bars 95 | GE now: 4,175 at 1,502 (143k) | Bigpackage | MEASURED live |
| mithril bars 280, adamantite bars 345 | Mine and smelt. Bars and ores have 0 sellers. Mithril ore 280 (Mining 55), adamantite ore 345 (Mining 70), coal 3,190 (280 x 4 + 345 x 6). Coal has 0 sellers and a 6.8M bid at 80. Mining Guild (Mining 60) for coal and mithril | N5 (miner and smelter), N6 (coal) | CODE-READ + MEASURED live; ore rates ESTIMATE: mithril 0.04, adamantite 0.025, coal 0.08 ore per tick |
| hammer, chisel, tinderbox, knife 2 | General stores, 2-5 each | Bigpackage | CODE-READ |
| rune essence 4,213 | GE now: 1,627 at 58 (94k). A 355,515 bid at 55 competes, so buy now. Rest 2,586: mine at the essence mine (Rune Mysteries quest) | Bigpackage (buy), N6 (mine) | MEASURED live; ESTIMATE 0.3-0.5 essence per tick, about 1.3 h |
| talismans (air, fire, body, nature, law) | Air: GE 1 at 3. Fire, body: 0 sellers. Nature: 0 sellers, bid 50,000. Law: not in the market catalog (404). Drops: body talisman from giants 0.0156; nature talisman from `randomjewel` | not resolved | MEASURED live + CODE-READ; open |
| lobsters 610 | GE: 20 at 152 now, bid 120, 1,303 traded in 7 days (12:25Z). Bigpackage holds 115 notes (swarm.json note, not checked). Or fish at Catherby: 27 lobsters in 600 ticks at Fishing 70 = 405 per hour, plain clicks; cooking needs Cooking 40 | Bigpackage (GE) or Mightyrod (fish between arrowtip buys) | MEASURED live + MEASURED practice (`gathering-tricks.md:44`) |
| water 6,807, earth 7,175 runes (only for enchant) | Shops: Aubury (3253,3402) 2000@10, Betty Port Sarim (3012,3259) 1000@10. About 3,600 per hour together for both runes | Bigpackage | CODE-READ; about 100k coins ESTIMATE |
| law runes 722 (Magic teleport substitute) | GE: 423 at 2,697 (1.14M). Shops: Magic Guild 1000@300 (Magic 66), Mage Arena 250@300, Ape Atoll 250@300 (Monkey Madness) | Moneyshot (GE) | MEASURED live + CODE-READ |
| cosmic runes 546, jewellery 546 | **No source at scale** for the dragonstone amulets (453). Drop the enchant method | - | CODE-READ |
| rune armour set | Oziach rune platebody 2@500 (3069,3517); Champions' Guild platelegs and coif (3191,3351, 32 QP) | Bigpackage | CODE-READ; price not quoted (rerun `market-snapshot.ts` with the ids) |
| rune pickaxe | Nurmof (2998,9844) 1@700 | Bigpackage | CODE-READ |
| rune axe | No shop. GE not quoted. Bigchopper may own one (not checked) | Bigchopper | open |
| magic shortbow, yew shortbow | Fletch from logs + bow strings (bow strings GE 591 at 146), or GE (not quoted) | Bigchopper | MEASURED live (strings) |
| black d'hide set, coif | Black dragon leather 0 sellers, black hides 0 sellers. Coif: Ranging Guild armour shop 10@50 | open | MEASURED live + CODE-READ |
| cannon parts 4 | Nulodion (3011,3453), 5 each, 1 per 100 ticks, base 187,500 each, needs Dwarf Cannon complete | N7 or the main after row 31 | CODE-READ; 750k coins ESTIMATE (sell multiplier not checked) |
| cannonballs 1,700 | Make: 4 per steel bar (`smelting/cannonballs.rs2:38`), 425 steel bars from the GE (638k). Needs the Dwarf Cannon ammo mould | N7 (Dwarf Cannon quest) | CODE-READ + MEASURED live; Smithing level not checked |
| anti-dragon shield | Duke Horacio, free at the Dragon Slayer stage | the main | CODE-READ |
| Equipment set | Shops: dragon battleaxe 200,000 and right shield half 750,000 (Heroes', Legends' quests). Drops or GE asks for the helm, chainbody, platelegs, left half: about 754M | out of reach (owner decision E1) | CODE-READ + MEASURED live (`boards-special.md:56-81`) |
| Bank value | 16.2B of base cost | out of reach (owner decision B1) | `boards-special.md:134-150` |

## 3. Job list

Order: earliest "needed at" first, then the longest job first. **CP** marks a critical-path job: it finishes
last or it holds a gate-3 line that has no other source. N1-N7 are new accounts from
`packages/core/src/names.ts`. A new account starts on Tutorial Island with the starter kit only.

| # | Account | Job | Location | Items per hour (ESTIMATE) | Hours | Prerequisites | Script |
|---|---|---|---|---|---|---|---|
| 1 | Moneyshot, Bigpackage | Buy now everything that has sellers: essence 1,627, magic 107, yew 25, oak 4, willow 7, steel bars 95, dragon bones 16, lobsters 20 | GE, Varrock west | one trip | 0.5 | about 800k coins from the banker | exists: `gecourier.ts` (lobsters only); must add an item list |
| 2 **CP** | Mightyrod | Buy rune and adamant arrowtips every restock; fish lobsters between visits | Catherby archery shop and bank | 225 rune tips | 6.3 (11.1 alone) | coins | must write: restock-aware shop loop |
| 3 **CP** | N3 | Train Ranged 40, then buy rune and adamant arrowtips | Ranging Guild | 150 rune tips | 0.2 + 6.3 | Ranged 40 (15,789 XP) | must write: shop loop (same as 2) |
| 4 **CP** | Bigpackage | Feathers, tools, quest items, bronze bars, runes | Port Sarim, Lumbridge, Shantay Pass, Varrock | - | 1.5 | coins | must write: shop loop |
| 5 | Bigchopper | Chop 238 + 27 logs and 13 maples, cut 3,570 shafts, make 3,570 headless arrows | Lumbridge or Draynor trees, Seers' maples | about 4,500 headless arrows | 1.0 | feathers from job 4 | exists: `woodcutting.ts`; must write: fletch loop |
| 6 **CP** | N1 | Pick 601 grapes (and 176 jangerberries if the planner keeps them) | (2509,3493), bank nearby (not checked) | 1,125 grapes if no one else picks | 1.5 | none | must write: spawn picker |
| 7 | Bigpackage | Buy 601 empty jugs on a general-store circuit, fill them | Lumbridge, Varrock, Falador, Al Kharid stores | 250-350 | 2.0 | coins | must write: store circuit |
| 8 | N2 + Bigpackage | Cooking 35, make 600 wines in batches of 14, trade each batch to Bigpackage within 20 ticks, note them | any bank | 1,700 wines | 0.3 + 0.15 | Cook's Assistant items | must write: wine maker and hand-off |
| 9 | Moneyshot | Place GE bids for the 31 low gems (and 354 diamonds if Crafting takes that substitute) | GE | market flow | 0.3 active, 1-7 days wait | coins | must write: GE bid script |
| 10 **CP** | N4a, N4b | Waterfall Quest, then kill chaos druids and hill giants; pick red spiders' eggs; bank herbs | Edgeville dungeon (3110,9936) | 500 kills = 220 herbs per account | 0.3 + 2.5 each | Attack and Strength from Waterfall; food | exists: `waterfall.ts`; must write: kill-and-loot loop |
| 11 | Bigpackage | Herb secondaries: eye of newt 340, vials 1,080, snape grass 145 | Taverley, Ardougne, snape spawns | - | 2.0 | coins | must write: shop loop + spawn picker |
| 12 **CP** | N5 | Mining 1 to 70 on iron; smelt 104 iron bars (Smithing to 50, 35 bars kept); mine 280 mithril and 345 adamantite; smelt 625 bars (Smithing 50 to 70 from mithril) | Mining Guild, Falador furnace and bank | 360 mithril or 225 adamantite ore | 0.2 + 0.3 + 3.5 + 0.3 | rune pickaxe (job 4) | exists: `scripts/measure/gather.ts` (iron, measure only); must write: mine, bank, smelt |
| 13 **CP** | N6 | Mining to 60, mine 3,190 coal; then Rune Mysteries and 2,586 rune essence | Mining Guild; essence mine | 720 coal; 2,000 essence | 0.2 + 4.4 + 0.2 + 1.3 | pickaxe | must write: mine loop, Rune Mysteries script |
| 14 | N7 | Dwarf Cannon quest, buy the 4 cannon parts, make 1,700 cannonballs from 425 GE steel bars | Ice Mountain dwarves, a furnace | 600 cannonballs | 0.3 + 0.2 + 0.3 | 1.39M coins | exists: `dwarfcannon.ts` (preset at Haggis levels, not a fresh account); must write: cannonball smelter |
| 15 | Bigpackage | Rune armour, rune pickaxe, bows, coif | Edgeville, Champions' Guild, Dwarven Mine | - | 0.8 | coins; 32 QP for the Champions' Guild (helper has none) | must write: shop loop |
| 16 | Moneyshot | Law runes for the Magic substitute (423 on the GE, rest by bids) | GE | market flow | 0.3 | 1.2M coins | GE bid script (job 9) |
| 17 | 4 gold farmers | Keep farming gold | Ardougne market | 600-800k coins together | 5.6 | - | exists: `goldfarm.ts` host job |
| 18 | open | Dragon bones 544 by kills | green dragons, Wilderness 37 | 150-250 | 2.5-4 | combat 70+ (ESTIMATE), anti-dragon shield | must write |

Job 18 is not in the totals. The GE route for dragon bones (job 9 bids, about 7 days) replaces it until a helper
has the shield.

## 4. Totals

Helper-hours (ESTIMATE, the sum of the "Hours" column, jobs 1-17): about **62**. Of these, 22.4 are the gold farm,
12.6 are the 2 arrowtip shop loops (mostly waiting for restock), and 5.6 are the herb kills.

Gold (ESTIMATE from MEASURED live asks):

| Line | Coins |
|---|---|
| Rune arrowtips 2,595 | about 1.0M (0.86-1.3M) |
| Other arrowtips, feathers, tools, quest items, bronze bars | about 0.1M |
| Logs (magic, yew, oak, willow) | 251k |
| Steel bars 95 + iron ore 104 | 154k |
| Dragon bones 16 (GE now) | 304k |
| Low gems 31 | 150k |
| Rune essence 1,627 | 94k |
| Lobsters 475 | 76k |
| Water and earth runes | 100k |
| Law runes 722 (Magic substitute) | 1.2M |
| Cannon parts + 425 steel bars for cannonballs | 1.39M |
| Rune armour, pickaxe, bows | 200k |
| **Core total** | **about 5.0M** |
| Optional: 354 diamonds (Crafting substitute) | +1.8M |
| Optional: 544 dragon bones on the GE | +4.5M |
| Out of reach: Equipment dragon pieces, Bank 16.2B | 754M, 16.2B |

- Held: about 1.1M (dashboard economy panel, task brief). Gap: 3.9M. At 600-800k per hour that is
  4.9-6.5 h, about 5.6 h at 700k.
- Earliest staging of the core substituted manifest: start at 13:00Z on 2026-10-23. Four chains run in
  parallel: the arrowtip loop (N3, 6.5 h), Bigpackage's serial queue (jobs 1, 4, 7, 8, 11, 15: about 7 h), N6
  (6.1 h) and the gold gap (5.6 h). Purchases in the last hour wait for the gold. Result: about
  **2026-10-23 20:00Z**, and 2026-10-24 00:00Z with time for hand-offs. This needs 11 accounts (Mightyrod,
  Bigchopper, Bigpackage, Moneyshot, N1-N7) and no competition at the shops or spawns. A second courier cuts
  Bigpackage's queue to about 3.5 h. With the diamond substitute: about 2026-10-28. With GE dragon bones:
  about 2026-10-30, and 4.5M more coins (about 6.4 h more farming, which fits in that wait).
- The planner's exact manifest has no staging date. Torstol, snapdragon, toadflax, dragonstones and the
  dragonstone amulets have no legal source at scale.

### The 5 jobs to start first

1. **Job 1, buy now** (Moneyshot, Bigpackage): essence, magic and yew logs, steel bars, 16 dragon bones,
   lobsters. Competing bids exist for essence (355,515 at 55) and dragon bones (1,253 at 5,000).
2. **Jobs 2 and 3, rune arrowtip restock** (Mightyrod, N3): the longest fixed-rate job, 6.3 h.
3. **Jobs 12 and 13, mithril, adamantite and coal** (N5, N6): 4.5-5 h each, and the Smithing board needs
   these bars (no seller).
4. **Jobs 6, 7 and 8, wine** (N1, Bigpackage, N2): needed in Trade 1 at tick 10. Grapes are contested.
5. **Job 10, herb kills** (N4a, N4b), after the planner takes the Herblore substitute. Start the Waterfall
   Quest for both accounts now: it is needed for any combat job.

## Open

- Every kill, mining and shop-loop rate in this file is an ESTIMATE. Measure each one 3 times on practice, then
  1 live hour for contested spawns (grapes, chaos druids).
- The planner must take the substitutions (dart band to rune arrows, Herblore herb set, Crafting, Magic) before
  `.practice/haggis-supplies.json` can list a manifest that can be staged.
- How the Herblore and Crafting leaders (447, 197 ticks) got torstol-level herbs and 277 dragonstones is not
  known. A source outside this content search (a staff account, an earlier market) is possible.
- Talisman sources, the anti-dragon shield stage, the Ranging Guild entry, the cannonball Smithing level, the
  Nulodion price and the rune armour prices are not checked.
- The wine hand-off rule (trade each batch within 20 ticks) is CODE-READ. Test it on practice before use.

## Contradictions

- `research/leader-forensics.md:248-249` says Herblore "is winnable" and the limit is "supply (176 torstol and
  jangerberries)". This file: torstol has one source, 1 per sinister key, about 2,250 Salarin kills for 176
  (`agility_dungeon.rs2:103-120`, `salarin_the_twisted.rs2:45-46`). With legal herbs the floor is about 630
  ticks against 447. What settles it: a practice run of the substituted herb set, 3 runs.
- `research/supply-costs.md:35` says helpers can "kill herb-dropping NPCs" for every Herblore tier. No drop
  table holds torstol, toadflax or snapdragon (`shared_droptables.rs2:2-34`, `knowledge/drops.json`). What
  settles it: the code search above. It is settled for rev 289 content.
