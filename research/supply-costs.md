# Supply costs per board (live GE, 2026-10-23)

Snapshot: `research/market-2026-10-23.json`, taken 2026-10-23T06:53:52Z by `bun scripts/market-snapshot.ts`
(read-only GETs, 2 requests per second at most, 182 items). Tables: `bun scripts/market-snapshot.ts --costs
research/market-2026-10-23.json` (the Appendix below is that output).

Evidence: prices, sellers and volumes are **MEASURED live** (one snapshot). XP per item, shops, restock and
ground spawns are **CODE-READ** (rev 289 content). Coin totals are **ESTIMATE** (a model on top of both).

## How the numbers are made

- Items from level 1 to 99: at each level the method uses its highest-XP tier that is unlocked. XP to the next
  level comes from `packages/planner/src/curve.ts` (99 = 998,458 XP), XP per item x 25. Burns and fails are
  not counted.
- Each input takes the cheapest of: the GE ask (only when sellers > 0), a fixed shop, or a recipe a helper can
  make it from (logs to unstrung bows, flax to bow strings, bars to arrowheads and dart tips, steel bars to
  cannonballs, ores and coal to bars, hides to leather).
- Shop price follows `shop/scripts/shop.rs2:139-200`: each unit bought raises the price by `shop_delta` (10)
  per mille of the base cost, up to 6x. Restock is +1 unit per `stockrate` ticks while below normal stock
  (`engine/src/engine/World.ts:1367-1387`); "+N/h" uses the 400 ms live tick (9,000 ticks per hour).
- GE coins use the ask. The API gives only the lowest sell price and the whole book (`sellValue`), so the
  ask is a lower bound. Each table also shows the book average.
- **Availability counts, not only price.** "Short" is what neither the GE nor the shops hold now. Most
  inputs have 0 sellers. The live GE had 0 raw lobster, raw tuna, raw salmon and raw trout for sale in this
  snapshot (raw shark 0, raw swordfish 0); the coordinator reports 0 cooked lobster too, earlier today.
- A market of 112 active items out of 1,443 tradeable (`/api/market/items` summary) is thin, and some
  prices are set high on purpose (uncut sapphire ask 20,000, base 25; uncut dragonstone bid 1,000,000).

## Per board: cheapest route

| Board | Cheapest route found | Items | Coins at ask | Buyable now | Short now | Helper work that replaces buying |
|---|---|---|---|---|---|---|
| Fletching | cut and string longbows, yew logs from 70 | 231 yew logs, 293 bow strings, small low tiers | **95,472** | yes, except 30 maple + 8 logs | maple logs 30 (0 sellers) | chop logs; pick and spin flax (Crafting 10) |
| Crafting | spin flax into bow strings from 10 | 2,660 flax | **63,840** | 537 flax (12,888) | 2,123 flax (1.8 days at the 7-day rate) | pick flax (Seers' field) |
| Herblore | no buy route | 176 torstol + 176 jangerberries for 78-99, plus 19 lower tiers | **~9,000** for what exists | almost nothing | every tier from 5 up | kill herb-dropping NPCs; pick secondaries (spawns) |
| Firemaking | logs ladder, yew from 60 | 185 yew logs | **70,471** | yes, except 13 maple + 2 logs | maple 13 | chop |
| Prayer | dragon bones (only bone with sellers) | 555 dragon bones | **10,545,000** | 16 (304,000) | 539 (6.4 days at the 7-day rate) | kill dragons; big bones (2,663 needed, 0 sellers) from giants |
| Smithing | steel bars from 30 | 1,058 steel bars | **1,591,144** | yes (4,175 sellers) | none | gold ore with goldsmith gauntlets: 699 gold ore, ~17,000 coins, but 1 seller, so a helper mines it (Family Crest needed) |
| Magic | teleports with a staff of air, Camelot from 45 | 722 law runes | **74,498** from shops; **1,947,234** at GE ask | GE 423 laws; shops 1,500 | none (GE: 299, 0.3 days) | a helper with Magic 66 buys laws in the Magic Guild shop |
| Cooking | fish ladder (no wine) | 140 raw sharks, 70 raw swordfish, ~10 lower fish | **~600** | almost none | raw fish 0 sellers | fish (sharks, swordfish); grapes for wine have 0 sellers |
| Runecraft | highest altar, law from 54 | 4,234 rune essence | **245,572** | 1,627 (94,366) | 2,607 (0.0 days at the 7-day rate, but 379,841 are bid for) | mine rune essence |
| Ranged | dwarf multicannon (ESTIMATE 8 damage per ball) | 2,497 cannonballs = 625 steel bars | **938,750** + cannon set **750,000** (ESTIMATE) | yes | none | smith cannonballs from mined iron + coal |
| Attack, Strength, Defence, Hitpoints | no bought-supply XP method; quest XP and combat | food only | - | - | - | - |

Detail per board (all CODE-READ for XP, MEASURED live for market):

- **Fletching.** Fast item-on-item routes (5 per tick) are blocked: rune dart tips have 0 sellers and need
  Tourist Trap plus Smithing 89 (`skill_smithing/scripts/smithing/smithing.rs2:225-226`,
  `configs/smithing/smithing.dbrow:1178-1187`). Rune arrows need 2,592 rune arrowtips: shops hold 250
  (Catherby archery 100, Ranging Guild 150) and restock 375 per hour together, so 2,342 short is about 6.2
  hours of restock (arrows route 155,466 coins). Magic longbows from 85 cost 338,241 (cut and string) or
  675,959 (string only); yew-only is 3.5x cheaper. Cutting has an animation delay; the tick cost is not
  checked. Unstrung yew longbows: 571 sellers at 473; bow strings: 591 at 146; flax: 537 at 24.
- **Crafting.** The fast routes have no supply. Dragonstone: 277 needed, 0 sellers, 100 bid at 1,000,000.
  Air battlestaves: 262 needed; battlestaffs only in two shops (5 each, +90 and +100 per hour, base 7,000,
  so about 1.9M coins), and air orbs have 0 sellers (a helper charges them: 3 cosmic runes each, cosmic has 1
  seller at 10,000). Dragon leather and molten glass: 0 sellers. Flax spinning is cheap but slow (2-3 ticks
  per spin, `spinning.rs2:87-98`), so it does not beat the 197-tick leader.
- **Herblore.** Herbs on the GE: guam 14 at 2,000, grimy guam 106 at 2,707, grimy marrentill 117 at 2,800,
  tarromin 39 at 3,000, harralander 9 at 3,000. No torstol, no unfinished potions, almost no secondaries.
  Unfinished potions give 0 XP and need the Herblore level of the herb, so the main makes them itself.
  Vials of water and eye of newt are in shops.
- **Firemaking.** Magic logs from 75 cost 250,581 (107 logs, 56,003 sellers at 2,250) and save 78 burns
  against yew, about 312 ticks at 4 ticks per log (`firemaking.rs2:79-131`). Leader 673 ticks.
- **Prayer.** Burying is the only Prayer XP in rev 289 (no ectofuntus, no altar offering found). Dragon bones
  bid 5,000 for 1,253; big bones bid 1,000 for 4,972 with 0 sellers. Other operators compete for bones.
- **Smithing.** Mithril, adamant and rune bars have 0 sellers. Superheat also gets the gauntlet bonus
  (`skill_magic/scripts/spells/superheat.rs2:57`), so superheated gold ore gives Smithing 56.25 and Magic 53
  base XP per ore for one nature rune (Magic Guild shop, base 20; GE 627,517 sellers at 621).
- **Magic.** Law-rune shops are gated: Magic Guild needs Magic 66 (`areas/area_yanille/scripts/magic_guild.rs2:11`),
  Mage Arena shop needs the arena, the Ape Atoll shop needs Monkey Madness. Shop laws restock 30 per hour
  each. Charge from 80 (Mage Arena) cuts laws to 195 and adds 489 blood runes: 97,941 coins from shops.
  Staff of air: shops only (2 each, base 1,500), 0 GE sellers.
- **Cooking.** Wine from 35 needs 360 unfermented wines: grapes have 0 sellers and 96,859 bid at 1,000.
  Shark (80, 210 XP) and swordfish (45, 140 XP) are the fish ladder; all raw fish had 0 sellers. Canifis
  sells raw shark (1, +9 per hour). Raw fish shops elsewhere start at 0 stock (they only buy).
- **Runecraft.** Law talisman returns 404 on the market API (not in the tradeable catalog). Rune essence bid:
  379,841 wanted at 55, so cheap essence goes fast.
- **Ranged.** `cannon_fire.rs2:117-119`: hit = randominc(0..30), capped by NPC HP, 2 XP per damage. 8 damage
  per ball is a guess. The cannon set is sold by Nulodion (`areas/area_falador/configs/dwarven_workshop.inv`,
  base 187,500 per part; the shop price multiplier is not checked). Needs the Dwarf Cannon quest.

## Bank and Equipment boards (CODE-READ, leaders MEASURED live)

Rule (`vendor/rs-sdk/server/engine/src/server/login/LoginServer.ts:222-287`):

- **Equipment** = sum of `objType.cost` (the item's fixed config cost) over worn slots, one item per slot,
  stacks count once, ammo slot 13 skipped.
- **Bank** = sum of `objType.cost x count` over bank slots.
- GE prices do not count. Both refresh on autosave and on logout; an empty bank replaces the old row.

Leaders on 2026-10-23T06:53Z:

| Board | #1 | #2 / #3 | Top items of #1 |
|---|---|---|---|
| Bank | nickai3 16,139,489,874 | banker 8,020,911,771; nickai 2,147M | air rune 1B (7,693,244,540), raw shark 7M (2,144,679,600), coins 2B, raw bass 10M, mind rune 247M |
| Equipment | nickai3 1,366,450 (tie with soko) | hoplite 1,355K | dragon sq shield 500,000, dragon platelegs 270,000, dragon chainbody 250,000, dragon battleaxe 200,000, dragon med helm 100,000 |

## Total gold

Coins at the ask for each board's cheapest buy route, full need (including units that must wait for sellers):

| Board | Coins |
|---|---|
| Fletching | 95,472 |
| Crafting (flax) | 63,840 |
| Herblore | 0 (no buy route) |
| Firemaking (yew) | 70,471 |
| Prayer (dragon bones) | 10,545,000 |
| Smithing (steel) | 1,591,144 |
| Magic (shop laws) | 74,498 |
| Cooking | ~600 |
| Runecraft | 245,572 |
| Ranged (cannonballs + cannon set, ESTIMATE) | 1,688,750 |
| **Total** | **14,375,347** |

- Without Prayer (helpers kill for bones): **3,830,347**.
- With GE law runes instead of gated shops: +1,872,736.
- Gold farm model (4 accounts at Thieving 99 on knights, 18.8 coins per tick per account, about 169,200 per
  account-hour, **ESTIMATE, not measured**): 676,800 per hour for the team. 14,375,347 coins = **21.2 hours**
  (85 account-hours). Without Prayer: **5.7 hours**. The banker holds 66,078 coins today.
- Coins do not buy what is not for sale. Even with the gold, these inputs need helper work: dragon bones (539),
  Herblore herbs and secondaries (all tiers), raw fish (Cooking), grapes (wine), dragonstones and air orbs
  (fast Crafting), maple logs, rune dart tips and most rune arrowtips (fast Fletching), gold ore.

## Open

- Shop prices on the live server can be higher: shops are shared, and other players may hold the stock low.
- The GE ask is a lower bound; buying a large share of a book costs more (see the book average column).
- Time per board is not in this file. A cheap route (flax, yew) can be too slow to win.
- One snapshot. Rerun `bun scripts/market-snapshot.ts` before a buy plan; the market moves daily.

## Appendix: generated tables

Snapshot research/market-2026-10-23.json taken 2026-10-23T06:53:52.921Z. 99 = 998,458 XP, 25x.

#### Fletching: darts (tip + feather)
TOTAL 41,777 coins for what can be bought now; SHORT: Mithril dart tip 252, Adamant dart tip 476, Rune dart tip 1,516; NO PRICE for tiers: mithril dart (252), adamant dart (476), rune dart (1,516). Source: darts.dbrow, darts.rs2:41-62.

| Tier | Levels | XP each (25x) | Items | Coins each (first unit) |
|---|---|---|---|---|
| bronze dart | 1-22 | 45 | 84 | 3 |
| iron dart | 22-37 | 95 | 94 | 24 |
| steel dart | 37-52 | 188 | 134 | 152 |
| mithril dart | 52-67 | 280 | 252 | - |
| adamant dart | 67-81 | 375 | 476 | - |
| rune dart | 81-99 | 470 | 1,516 | - |

| Item | Need | GE ask | GE book avg | GE sellers | GE 7-day volume | Coins to fill now | Short | Shops (stock, restock) | Ground |
|---|---|---|---|---|---|---|---|---|---|
| Bronze bar (bronze_bar) | 8 | - | - | 0 | 0 | 72 (shop 9, GE 0) |  | shantayshop 10 (+18/h); junglestore 10 (+18/h); shilojunglestore 10 (+18/h) | - |
| Feather (feather) | 2,556 | 70 | 86 | 535 | 870 | 18,587 (shop 2,556, GE 0) |  | shantayshop 500 (+180/h); misc_fishmonger 1000 (+9,000/h); etc_fishmonger 1000 (+9,000/h); fishingshop 1000 (+9,000/h); shilofishingshop 800 (+9,000/h); viking_fishmonger 1000 (+9,000/h); fishingguild 1500 (+9,000/h) | - |
| Iron ore (iron_ore) | 19 | 110 | 114 | 22 | 556,998 | 2,090 (shop 0, GE 19) |  | - | - |
| Steel bar (steel_bar) | 13 | 1502 | 1,502 | 4,175 | 74,114 | 21,028 (shop 0, GE 14) |  | - | - |
| Mithril dart tip (mithril_dart_tip) | 252 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 252; no trades in 7 days | - | - |
| Adamant dart tip (adamant_dart_tip) | 476 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 476; no trades in 7 days | - | - |
| Rune dart tip (rune_dart_tip) | 1,516 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 1,516; no trades in 7 days | - | - |

#### Fletching: arrows (arrowheads + headless arrow)
TOTAL 155,466 coins for what can be bought now; SHORT: Arrow shaft 2,585, Adamant arrowtips 91, Rune arrowtips 2,342. Source: arrows.dbrow, arrows.rs2:46,70-86.

| Tier | Levels | XP each (25x) | Items | Coins each (first unit) |
|---|---|---|---|---|
| bronze arrow | 1-15 | 33 | 58 | 4 |
| iron arrow | 15-30 | 63 | 88 | 5 |
| steel arrow | 30-45 | 125 | 124 | 9 |
| mithril arrow | 45-60 | 188 | 232 | 19 |
| adamant arrow | 60-75 | 250 | 491 | 43 |
| rune arrow | 75-99 | 313 | 2,592 | 203 |

| Item | Need | GE ask | GE book avg | GE sellers | GE 7-day volume | Coins to fill now | Short | Shops (stock, restock) | Ground |
|---|---|---|---|---|---|---|---|---|---|
| Bronze bar (bronze_bar) | 4 | - | - | 0 | 0 | 32 (shop 4, GE 0) |  | shantayshop 10 (+18/h); junglestore 10 (+18/h); shilojunglestore 10 (+18/h) | - |
| Arrow shaft (arrow_shaft) | 3,585 | - | - | 0 | 226 | 4,500 (shop 1,000, GE 0) | 2,585; 80.1 d at 7-day trade rate | ranging_guild_bowshop 1000 (+180/h) | - |
| Feather (feather) | 3,585 | 70 | 86 | 535 | 870 | 30,935 (shop 3,585, GE 0) |  | shantayshop 500 (+180/h); misc_fishmonger 1000 (+9,000/h); etc_fishmonger 1000 (+9,000/h); fishingshop 1000 (+9,000/h); shilofishingshop 800 (+9,000/h); viking_fishmonger 1000 (+9,000/h); fishingguild 1500 (+9,000/h) | - |
| Iron arrowtips (iron_arrowheads) | 88 | - | - | 0 | 0 | 176 (shop 88, GE 0) |  | archeryshop2 800 (+450/h); lathastrainingstore 800 (+450/h); gnomeshop_gulluck 180 (+450/h); ranging_guild_bowshop 400 (+450/h) | - |
| Steel arrowtips (steel_arrowheads) | 124 | - | - | 0 | 0 | 839 (shop 124, GE 0) |  | archeryshop2 600 (+225/h); lathastrainingstore 800 (+225/h); gnomeshop_gulluck 160 (+225/h); ranging_guild_bowshop 300 (+300/h) | 1 spawns |
| Mithril arrowtips (mithril_arrowheads) | 232 | - | - | 0 | 12 | 4,974 (shop 232, GE 0) |  | archeryshop2 400 (+225/h); lathastrainingstore 800 (+113/h); gnomeshop_gulluck 140 (+113/h); ranging_guild_bowshop 200 (+225/h) | - |
| Adamant arrowtips (adamant_arrowheads) | 491 | - | - | 0 | 0 | 31,760 (shop 400, GE 0) | 91; no trades in 7 days | archeryshop2 200 (+225/h); ranging_guild_bowshop 200 (+180/h) | - |
| Rune arrowtips (rune_arrowheads) | 2,592 | - | - | 0 | 0 | 82,250 (shop 250, GE 0) | 2,342; no trades in 7 days | archeryshop2 100 (+225/h); ranging_guild_bowshop 150 (+150/h) | - |

#### Fletching: string longbows (unstrung + bow string)
TOTAL 675,959 coins for what can be bought now; SHORT: Longbow 16, Maple longbow 60; NO PRICE for tiers: longbow (16), maple longbow (60). Source: stringing/bows.dbrow.

| Tier | Levels | XP each (25x) | Items | Coins each (first unit) |
|---|---|---|---|---|
| headless arrow (shaft + feather) | 1-10 | 25 | 40 | 3 |
| longbow | 10-25 | 250 | 16 | - |
| oak longbow | 25-40 | 625 | 18 | 43 |
| willow longbow | 40-55 | 1,038 | 30 | 64 |
| maple longbow | 55-70 | 1,455 | 60 | - |
| yew longbow | 70-85 | 1,875 | 131 | 403 |
| magic longbow | 85-99 | 2,288 | 272 | 2,274 |

| Item | Need | GE ask | GE book avg | GE sellers | GE 7-day volume | Coins to fill now | Short | Shops (stock, restock) | Ground |
|---|---|---|---|---|---|---|---|---|---|
| Arrow shaft (arrow_shaft) | 40 | - | - | 0 | 226 | 40 (shop 40, GE 0) |  | ranging_guild_bowshop 1000 (+180/h) | - |
| Feather (feather) | 40 | 70 | 86 | 535 | 870 | 80 (shop 40, GE 0) |  | shantayshop 500 (+180/h); misc_fishmonger 1000 (+9,000/h); etc_fishmonger 1000 (+9,000/h); fishingshop 1000 (+9,000/h); shilofishingshop 800 (+9,000/h); viking_fishmonger 1000 (+9,000/h); fishingguild 1500 (+9,000/h) | - |
| Longbow (unstrung_longbow) | 16 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 16; no trades in 7 days | - | - |
| Flax (flax) | 527 | 24 | 25 | 537 | 8,081 | 12,648 (shop 0, GE 527) |  | - | - |
| Oak logs (oak_logs) | 18 | 19 | 19 | 27 | 661 | 342 (shop 0, GE 18) |  | - | - |
| Willow logs (willow_logs) | 30 | 40 | 40 | 67 | 550 | 1,200 (shop 0, GE 30) |  | - | - |
| Maple longbow (unstrung_maple_longbow) | 60 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 60; no trades in 7 days | - | - |
| Yew logs (yew_logs) | 131 | 379 | 379 | 48,462 | 352,859 | 49,649 (shop 0, GE 131) |  | - | - |
| Magic logs (magic_logs) | 272 | 2250 | 2,250 | 56,003 | 9,769 | 612,000 (shop 0, GE 272) |  | - | - |

#### Fletching: cut and string longbows (log + bow string)
TOTAL 338,241 coins for what can be bought now; SHORT: Logs 8, Maple logs 30; NO PRICE for tiers: longbow (8), maple longbow (30). Source: cut_logs.dbrow + bows.dbrow; cutting has an animation delay (time not checked).

| Tier | Levels | XP each (25x) | Items | Coins each (first unit) |
|---|---|---|---|---|
| headless arrow (shaft + feather) | 1-10 | 25 | 40 | 3 |
| longbow | 10-25 | 500 | 8 | - |
| oak longbow | 25-40 | 1,250 | 9 | 43 |
| willow longbow | 40-55 | 2,075 | 15 | 64 |
| maple longbow | 55-70 | 2,913 | 30 | - |
| yew longbow | 70-85 | 3,750 | 66 | 403 |
| magic longbow | 85-99 | 4,575 | 136 | 2,274 |

| Item | Need | GE ask | GE book avg | GE sellers | GE 7-day volume | Coins to fill now | Short | Shops (stock, restock) | Ground |
|---|---|---|---|---|---|---|---|---|---|
| Arrow shaft (arrow_shaft) | 40 | - | - | 0 | 226 | 40 (shop 40, GE 0) |  | ranging_guild_bowshop 1000 (+180/h) | - |
| Feather (feather) | 40 | 70 | 86 | 535 | 870 | 80 (shop 40, GE 0) |  | shantayshop 500 (+180/h); misc_fishmonger 1000 (+9,000/h); etc_fishmonger 1000 (+9,000/h); fishingshop 1000 (+9,000/h); shilofishingshop 800 (+9,000/h); viking_fishmonger 1000 (+9,000/h); fishingguild 1500 (+9,000/h) | - |
| Logs (logs) | 8 | - | - | 0 | 247 | 0 (shop 0, GE 0) | 8; 0.2 d at 7-day trade rate | - | 25 spawns |
| Flax (flax) | 264 | 24 | 25 | 537 | 8,081 | 6,336 (shop 0, GE 264) |  | - | - |
| Oak logs (oak_logs) | 9 | 19 | 19 | 27 | 661 | 171 (shop 0, GE 9) |  | - | - |
| Willow logs (willow_logs) | 15 | 40 | 40 | 67 | 550 | 600 (shop 0, GE 15) |  | - | - |
| Maple logs (maple_logs) | 30 | - | - | 0 | 36,945 | 0 (shop 0, GE 0) | 30; 0.0 d at 7-day trade rate | - | - |
| Yew logs (yew_logs) | 66 | 379 | 379 | 48,462 | 352,859 | 25,014 (shop 0, GE 66) |  | - | - |
| Magic logs (magic_logs) | 136 | 2250 | 2,250 | 56,003 | 9,769 | 306,000 (shop 0, GE 136) |  | - | - |

#### Fletching: cut and string longbows, yew from 70 (no magic)
TOTAL 95,472 coins for what can be bought now; SHORT: Logs 8, Maple logs 30; NO PRICE for tiers: longbow (8), maple longbow (30). Source: cut_logs.dbrow + bows.dbrow.

| Tier | Levels | XP each (25x) | Items | Coins each (first unit) |
|---|---|---|---|---|
| headless arrow (shaft + feather) | 1-10 | 25 | 40 | 3 |
| longbow | 10-25 | 500 | 8 | - |
| oak longbow | 25-40 | 1,250 | 9 | 43 |
| willow longbow | 40-55 | 2,075 | 15 | 64 |
| maple longbow | 55-70 | 2,913 | 30 | - |
| yew longbow | 70-99 | 3,750 | 231 | 403 |

| Item | Need | GE ask | GE book avg | GE sellers | GE 7-day volume | Coins to fill now | Short | Shops (stock, restock) | Ground |
|---|---|---|---|---|---|---|---|---|---|
| Arrow shaft (arrow_shaft) | 40 | - | - | 0 | 226 | 40 (shop 40, GE 0) |  | ranging_guild_bowshop 1000 (+180/h) | - |
| Feather (feather) | 40 | 70 | 86 | 535 | 870 | 80 (shop 40, GE 0) |  | shantayshop 500 (+180/h); misc_fishmonger 1000 (+9,000/h); etc_fishmonger 1000 (+9,000/h); fishingshop 1000 (+9,000/h); shilofishingshop 800 (+9,000/h); viking_fishmonger 1000 (+9,000/h); fishingguild 1500 (+9,000/h) | - |
| Logs (logs) | 8 | - | - | 0 | 247 | 0 (shop 0, GE 0) | 8; 0.2 d at 7-day trade rate | - | 25 spawns |
| Flax (flax) | 293 | 24 | 25 | 537 | 8,081 | 7,032 (shop 0, GE 293) |  | - | - |
| Oak logs (oak_logs) | 9 | 19 | 19 | 27 | 661 | 171 (shop 0, GE 9) |  | - | - |
| Willow logs (willow_logs) | 15 | 40 | 40 | 67 | 550 | 600 (shop 0, GE 15) |  | - | - |
| Maple logs (maple_logs) | 30 | - | - | 0 | 36,945 | 0 (shop 0, GE 0) | 30; 0.0 d at 7-day trade rate | - | - |
| Yew logs (yew_logs) | 231 | 379 | 379 | 48,462 | 352,859 | 87,549 (shop 0, GE 231) |  | - | - |

#### Fletching: string longbows, yew from 70 (no magic)
TOTAL 189,648 coins for what can be bought now; SHORT: Longbow 16, Flax 49, Maple longbow 60; NO PRICE for tiers: longbow (16), maple longbow (60). Source: stringing/bows.dbrow.

| Tier | Levels | XP each (25x) | Items | Coins each (first unit) |
|---|---|---|---|---|
| headless arrow (shaft + feather) | 1-10 | 25 | 40 | 3 |
| longbow | 10-25 | 250 | 16 | - |
| oak longbow | 25-40 | 625 | 18 | 43 |
| willow longbow | 40-55 | 1,038 | 30 | 64 |
| maple longbow | 55-70 | 1,455 | 60 | - |
| yew longbow | 70-99 | 1,875 | 462 | 403 |

| Item | Need | GE ask | GE book avg | GE sellers | GE 7-day volume | Coins to fill now | Short | Shops (stock, restock) | Ground |
|---|---|---|---|---|---|---|---|---|---|
| Arrow shaft (arrow_shaft) | 40 | - | - | 0 | 226 | 40 (shop 40, GE 0) |  | ranging_guild_bowshop 1000 (+180/h) | - |
| Feather (feather) | 40 | 70 | 86 | 535 | 870 | 80 (shop 40, GE 0) |  | shantayshop 500 (+180/h); misc_fishmonger 1000 (+9,000/h); etc_fishmonger 1000 (+9,000/h); fishingshop 1000 (+9,000/h); shilofishingshop 800 (+9,000/h); viking_fishmonger 1000 (+9,000/h); fishingguild 1500 (+9,000/h) | - |
| Longbow (unstrung_longbow) | 16 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 16; no trades in 7 days | - | - |
| Flax (flax) | 586 | 24 | 25 | 537 | 8,081 | 12,888 (shop 0, GE 537) | 49; 0.0 d at 7-day trade rate | - | - |
| Oak logs (oak_logs) | 18 | 19 | 19 | 27 | 661 | 342 (shop 0, GE 18) |  | - | - |
| Willow logs (willow_logs) | 30 | 40 | 40 | 67 | 550 | 1,200 (shop 0, GE 30) |  | - | - |
| Maple longbow (unstrung_maple_longbow) | 60 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 60; no trades in 7 days | - | - |
| Yew logs (yew_logs) | 462 | 379 | 379 | 48,462 | 352,859 | 175,098 (shop 0, GE 462) |  | - | - |

#### Crafting: cut gems
TOTAL 90,100 coins for what can be bought now; SHORT: Uncut opal 4, Uncut jade 2, Uncut emerald 2, Uncut diamond 10, Uncut dragonstone 277; NO PRICE for tiers: opal (4), jade (2), diamond (10), dragonstone (277). Source: gem.dbrow, uncut_gem.rs2:15-63 (opal, jade, red topaz can smash).

| Tier | Levels | XP each (25x) | Items | Coins each (first unit) |
|---|---|---|---|---|
| opal | 1-13 | 375 | 4 | - |
| jade | 13-16 | 500 | 2 | - |
| red topaz | 16-20 | 625 | 2 | 10,000 |
| sapphire | 20-27 | 1,250 | 3 | 25 |
| emerald | 27-34 | 1,688 | 3 | 50 |
| ruby | 34-43 | 2,125 | 5 | 10,000 |
| diamond | 43-55 | 2,688 | 10 | - |
| dragonstone | 55-99 | 3,438 | 277 | - |

| Item | Need | GE ask | GE book avg | GE sellers | GE 7-day volume | Coins to fill now | Short | Shops (stock, restock) | Ground |
|---|---|---|---|---|---|---|---|---|---|
| Uncut opal (uncut_opal) | 4 | - | - | 0 | 9,793 | 0 (shop 0, GE 0) | 4; 0.0 d at 7-day trade rate | - | - |
| Uncut jade (uncut_jade) | 2 | - | - | 0 | 5,886 | 0 (shop 0, GE 0) | 2; 0.0 d at 7-day trade rate | - | - |
| Uncut red topaz (uncut_red_topaz) | 2 | 10000 | 10,000 | 99 | 1,243 | 20,000 (shop 0, GE 2) |  | - | - |
| Uncut sapphire (uncut_sapphire) | 3 | 20000 | 20,000 | 11,988 | 4,383 | 20,050 (shop 2, GE 1) |  | gemshop2 1 (+0/h); gemshop 1 (+0/h) | 2 spawns |
| Uncut emerald (uncut_emerald) | 3 | - | - | 0 | 705 | 50 (shop 1, GE 0) | 2; 0.0 d at 7-day trade rate | gemshop2 1 (+0/h) | - |
| Uncut ruby (uncut_ruby) | 5 | 10000 | 10,000 | 23 | 1,306 | 50,000 (shop 0, GE 5) |  | - | - |
| Uncut diamond (uncut_diamond) | 10 | - | - | 0 | 592 | 0 (shop 0, GE 0) | 10; 0.1 d at 7-day trade rate | - | - |
| Uncut dragonstone (uncut_dragonstone) | 277 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 277; no trades in 7 days | - | - |

#### Crafting: gems to 54, then battlestaves (staff + orb)
TOTAL 161,800 coins for what can be bought now; SHORT: Uncut opal 4, Uncut jade 2, Uncut emerald 2, Uncut diamond 15, Battlestaff 267, Earth orb 7, Fire orb 7, Air orb 262; NO PRICE for tiers: opal (4), jade (2), diamond (15), earth battlestaff (7), air battlestaff (262). Source: battlestaves.struct.

| Tier | Levels | XP each (25x) | Items | Coins each (first unit) |
|---|---|---|---|---|
| opal | 1-13 | 375 | 4 | - |
| jade | 13-16 | 500 | 2 | - |
| red topaz | 16-20 | 625 | 2 | 10,000 |
| sapphire | 20-27 | 1,250 | 3 | 25 |
| emerald | 27-34 | 1,688 | 3 | 50 |
| ruby | 34-43 | 2,125 | 5 | 10,000 |
| diamond | 43-58 | 2,688 | 15 | - |
| earth battlestaff | 58-62 | 2,813 | 7 | - |
| fire battlestaff | 62-66 | 3,125 | 8 | 7,300 |
| air battlestaff | 66-99 | 3,438 | 262 | - |

| Item | Need | GE ask | GE book avg | GE sellers | GE 7-day volume | Coins to fill now | Short | Shops (stock, restock) | Ground |
|---|---|---|---|---|---|---|---|---|---|
| Uncut opal (uncut_opal) | 4 | - | - | 0 | 9,793 | 0 (shop 0, GE 0) | 4; 0.0 d at 7-day trade rate | - | - |
| Uncut jade (uncut_jade) | 2 | - | - | 0 | 5,886 | 0 (shop 0, GE 0) | 2; 0.0 d at 7-day trade rate | - | - |
| Uncut red topaz (uncut_red_topaz) | 2 | 10000 | 10,000 | 99 | 1,243 | 20,000 (shop 0, GE 2) |  | - | - |
| Uncut sapphire (uncut_sapphire) | 3 | 20000 | 20,000 | 11,988 | 4,383 | 20,050 (shop 2, GE 1) |  | gemshop2 1 (+0/h); gemshop 1 (+0/h) | 2 spawns |
| Uncut emerald (uncut_emerald) | 3 | - | - | 0 | 705 | 50 (shop 1, GE 0) | 2; 0.0 d at 7-day trade rate | gemshop2 1 (+0/h) | - |
| Uncut ruby (uncut_ruby) | 5 | 10000 | 10,000 | 23 | 1,306 | 50,000 (shop 0, GE 5) |  | - | - |
| Uncut diamond (uncut_diamond) | 15 | - | - | 0 | 592 | 0 (shop 0, GE 0) | 15; 0.2 d at 7-day trade rate | - | - |
| Battlestaff (battlestaff) | 277 | - | - | 0 | 0 | 71,400 (shop 10, GE 0) | 267; no trades in 7 days | memberstaffshop 5 (+90/h); magicguildshop 5 (+100/h) | - |
| Earth orb (earth_orb) | 7 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 7; no trades in 7 days | - | - |
| Fire orb (fire_orb) | 8 | 300 | 300 | 1 | 0 | 300 (shop 0, GE 1) | 7; no trades in 7 days | - | - |
| Air orb (air_orb) | 262 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 262; no trades in 7 days | - | - |

#### Crafting: glass to 57, then dragonhide (per leather)
TOTAL 0 coins for what can be bought now; SHORT: Molten glass 63, Dragon leather 31, Dragon leather 37, Dragon leather 44, Dragon leather 349; NO PRICE for tiers: beer glass (22), vial (18), orb (23), green d-hide vamb (31), blue d-hide vamb (37), red d-hide vamb (44), black d-hide vamb (349). Source: glass.struct, leather.dbrow (vambraces 1 leather; bodies 3 leather, same XP per leather).

| Tier | Levels | XP each (25x) | Items | Coins each (first unit) |
|---|---|---|---|---|
| beer glass | 1-33 | 438 | 22 | - |
| vial | 33-46 | 875 | 18 | - |
| orb | 46-57 | 1,313 | 23 | - |
| green d-hide vamb | 57-66 | 1,550 | 31 | - |
| blue d-hide vamb | 66-73 | 1,750 | 37 | - |
| red d-hide vamb | 73-79 | 1,950 | 44 | - |
| black d-hide vamb | 79-99 | 2,150 | 349 | - |

| Item | Need | GE ask | GE book avg | GE sellers | GE 7-day volume | Coins to fill now | Short | Shops (stock, restock) | Ground |
|---|---|---|---|---|---|---|---|---|---|
| Molten glass (molten_glass) | 63 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 63; no trades in 7 days | - | - |
| Dragon leather (dragon_leather) | 31 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 31; no trades in 7 days | - | - |
| Dragon leather (dragon_leather_blue) | 37 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 37; no trades in 7 days | - | - |
| Dragon leather (dragon_leather_red) | 44 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 44; no trades in 7 days | - | - |
| Dragon leather (dragon_leather_black) | 349 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 349; no trades in 7 days | - | - |

#### Crafting: leather gloves to 10, then spin flax into bow strings
TOTAL 13,146 coins for what can be bought now; SHORT: Flax 2,123. Source: leather.dbrow, spinning.struct (15 XP, level 10); spinning.rs2:87-98 weakqueue 2-3 ticks.

| Tier | Levels | XP each (25x) | Items | Coins each (first unit) |
|---|---|---|---|---|
| leather gloves | 1-10 | 345 | 3 | 86 |
| bow string (spin flax) | 10-99 | 375 | 2,660 | 24 |

| Item | Need | GE ask | GE book avg | GE sellers | GE 7-day volume | Coins to fill now | Short | Shops (stock, restock) | Ground |
|---|---|---|---|---|---|---|---|---|---|
| Cowhide (cow_hide) | 3 | 85 | 2,106 | 50 | 1,014 | 255 (shop 0, GE 3) |  | - | - |
| coins (coins) | 3 | - | - | - | - | 3 (shop 0, GE 0) |  | - | - |
| Flax (flax) | 2,660 | 24 | 25 | 537 | 8,081 | 12,888 (shop 0, GE 537) | 2,123; 1.8 d at 7-day trade rate | - | - |

#### Crafting: glassblowing only
TOTAL 0 coins for what can be bought now; SHORT: Molten glass 783; NO PRICE for tiers: beer glass (22), vial (18), orb (743). Source: glass.struct.

| Tier | Levels | XP each (25x) | Items | Coins each (first unit) |
|---|---|---|---|---|
| beer glass | 1-33 | 438 | 22 | - |
| vial | 33-46 | 875 | 18 | - |
| orb | 46-99 | 1,313 | 743 | - |

| Item | Need | GE ask | GE book avg | GE sellers | GE 7-day volume | Coins to fill now | Short | Shops (stock, restock) | Ground |
|---|---|---|---|---|---|---|---|---|---|
| Molten glass (molten_glass) | 783 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 783; no trades in 7 days | - | - |

#### Herblore: finish potions (unf or herb + vial, plus secondary)
TOTAL 8,826 coins for what can be bought now; SHORT: Unicorn horn dust 3, Unfinished potion 2, Limpwurt root 9, Herb 2, Red spiders' eggs 7, Unfinished potion 7, White berries 9, Unfinished potion 2, Toad's legs 2, Snape grass 7, Unfinished potion 5, Unfinished potion 6, Mort myre fungi 4, Unfinished potion 12, Dragon scale dust 13, Unfinished potion 6, Unfinished potion 7, Unfinished potion 15, Unfinished potion 13, Wine of zamorak 13, Potato cactus 7, Unfinished potion 176, Jangerberries 176; NO PRICE for tiers: antipoison (1), strength potion (2), restore potion (1), defence potion (2), agility potion (2), prayer potion (5), super attack (3), superantipoison (2), fishing potion (2), super energy (4), super strength (7), weapon poison (5), super restore (6), super defence (7), antifire (8), ranging potion (13), magic potion (7), zamorak brew (176). Source: brew_potion.struct.

| Tier | Levels | XP each (25x) | Items | Coins each (first unit) |
|---|---|---|---|---|
| attack potion | 1-5 | 625 | 1 | 2,005 |
| antipoison | 5-12 | 938 | 1 | - |
| strength potion | 12-22 | 1,250 | 2 | - |
| restore potion | 22-26 | 1,563 | 1 | - |
| energy potion | 26-30 | 1,688 | 2 | 4,004 |
| defence potion | 30-34 | 1,875 | 2 | - |
| agility potion | 34-38 | 2,000 | 2 | - |
| prayer potion | 38-45 | 2,188 | 5 | - |
| super attack | 45-48 | 2,500 | 3 | - |
| superantipoison | 48-50 | 2,658 | 2 | - |
| fishing potion | 50-52 | 2,813 | 2 | - |
| super energy | 52-55 | 2,938 | 4 | - |
| super strength | 55-60 | 3,125 | 7 | - |
| weapon poison | 60-63 | 3,438 | 5 | - |
| super restore | 63-66 | 3,563 | 6 | - |
| super defence | 66-69 | 3,750 | 7 | - |
| antifire | 69-72 | 3,938 | 8 | - |
| ranging potion | 72-76 | 4,063 | 13 | - |
| magic potion | 76-78 | 4,313 | 7 | - |
| zamorak brew | 78-99 | 4,375 | 176 | - |

| Item | Need | GE ask | GE book avg | GE sellers | GE 7-day volume | Coins to fill now | Short | Shops (stock, restock) | Ground |
|---|---|---|---|---|---|---|---|---|---|
| Guam leaf (guam_leaf) | 1 | 2000 | 2,000 | 14 | 0 | 2,000 (shop 0, GE 1) |  | - | - |
| Vial of water (vial_water) | 5 | - | - | 0 | 0 | 10 (shop 5, GE 0) |  | adventurershop 500 (+300/h); junglestore 50 (+45/h); shilojunglestore 50 (+45/h); viking_general_store 10 (+45/h); lighthouseshop 100 (+18/h); razmiregeneralstore 100 (+90/h) | - |
| Eye of newt (eye_of_newt) | 4 | - | - | 0 | 0 | 12 (shop 4, GE 0) |  | herbloreshop2 50 (+450/h); magicshop 300 (+900/h); herbloreshop 800 (+450/h); herbloreshopogre 50 (+450/h) | - |
| Herb (unidentified_marentill) | 1 | 2800 | 2,800 | 117 | 0 | 2,800 (shop 0, GE 1) |  | - | - |
| Unicorn horn dust (unicorn_horn_dust) | 3 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 3; no trades in 7 days | - | - |
| Unfinished potion (tarrominvial) | 2 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 2; no trades in 7 days | - | - |
| Limpwurt root (limpwurt_root) | 9 | - | - | 0 | 4 | 0 (shop 0, GE 0) | 9; 15.8 d at 7-day trade rate | - | - |
| Herb (unidentified_harralander) | 3 | 4000 | 4,000 | 1 | 0 | 4,000 (shop 0, GE 1) | 2; no trades in 7 days | - | - |
| Red spiders' eggs (red_spiders_eggs) | 7 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 7; no trades in 7 days | - | 15 spawns |
| Chocolate dust (chocolate_dust) | 2 | - | - | 0 | 0 | 4 (shop 2, GE 0) |  | gnomeshop_heck 5 (+90/h); gnomeshop_hudo 5 (+90/h) | - |
| Unfinished potion (ranarrvial) | 7 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 7; no trades in 7 days | - | - |
| White berries (white_berries) | 9 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 9; no trades in 7 days | - | 3 spawns |
| Unfinished potion (toadflaxvial) | 2 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 2; no trades in 7 days | - | - |
| Toad's legs (toads_legs) | 2 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 2; no trades in 7 days | - | - |
| Snape grass (snape_grass) | 7 | - | - | 0 | 3 | 0 (shop 0, GE 0) | 7; 16.3 d at 7-day trade rate | - | 3 spawns |
| Unfinished potion (iritvial) | 5 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 5; no trades in 7 days | - | - |
| Unfinished potion (avantoevial) | 6 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 6; no trades in 7 days | - | - |
| Mort myre fungi (mortmyremushroom) | 4 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 4; no trades in 7 days | - | - |
| Unfinished potion (kwuarmvial) | 12 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 12; no trades in 7 days | - | - |
| Dragon scale dust (dragon_scale_dust) | 13 | - | - | 0 | 1 | 0 (shop 0, GE 0) | 13; 91.0 d at 7-day trade rate | - | - |
| Unfinished potion (snapdragonvial) | 6 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 6; no trades in 7 days | - | - |
| Unfinished potion (cadantinevial) | 7 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 7; no trades in 7 days | - | - |
| Unfinished potion (lantadymevial) | 15 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 15; no trades in 7 days | - | - |
| Unfinished potion (dwarfweedvial) | 13 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 13; no trades in 7 days | - | - |
| Wine of zamorak (wine_of_zamorak) | 13 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 13; no trades in 7 days | - | 1 spawns |
| Potato cactus (cactus_potato) | 7 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 7; no trades in 7 days | - | 8 spawns |
| Unfinished potion (torstolvial) | 176 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 176; no trades in 7 days | - | - |
| Jangerberries (jangerberries) | 176 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 176; no trades in 7 days | - | 4 spawns |

#### Firemaking: burn logs
TOTAL 250,581 coins for what can be bought now; SHORT: Logs 2, Maple logs 13; NO PRICE for tiers: logs (2), maple (13). Source: firemaking.obj, firemaking.rs2:79-131 (roll every 4 ticks).

| Tier | Levels | XP each (25x) | Items | Coins each (first unit) |
|---|---|---|---|---|
| logs | 1-15 | 1,000 | 2 | - |
| oak | 15-30 | 1,500 | 4 | 19 |
| willow | 30-45 | 2,250 | 7 | 40 |
| maple | 45-60 | 3,375 | 13 | - |
| yew | 60-75 | 5,063 | 25 | 379 |
| magic | 75-99 | 7,595 | 107 | 2,250 |

| Item | Need | GE ask | GE book avg | GE sellers | GE 7-day volume | Coins to fill now | Short | Shops (stock, restock) | Ground |
|---|---|---|---|---|---|---|---|---|---|
| Logs (logs) | 2 | - | - | 0 | 247 | 0 (shop 0, GE 0) | 2; 0.1 d at 7-day trade rate | - | 25 spawns |
| Oak logs (oak_logs) | 4 | 19 | 19 | 27 | 661 | 76 (shop 0, GE 4) |  | - | - |
| Willow logs (willow_logs) | 7 | 40 | 40 | 67 | 550 | 280 (shop 0, GE 7) |  | - | - |
| Maple logs (maple_logs) | 13 | - | - | 0 | 36,945 | 0 (shop 0, GE 0) | 13; 0.0 d at 7-day trade rate | - | - |
| Yew logs (yew_logs) | 25 | 379 | 379 | 48,462 | 352,859 | 9,475 (shop 0, GE 25) |  | - | - |
| Magic logs (magic_logs) | 107 | 2250 | 2,250 | 56,003 | 9,769 | 240,750 (shop 0, GE 107) |  | - | - |

#### Firemaking: burn logs, yew from 60 (no magic)
TOTAL 70,471 coins for what can be bought now; SHORT: Logs 2, Maple logs 13; NO PRICE for tiers: logs (2), maple (13). Source: firemaking.obj.

| Tier | Levels | XP each (25x) | Items | Coins each (first unit) |
|---|---|---|---|---|
| logs | 1-15 | 1,000 | 2 | - |
| oak | 15-30 | 1,500 | 4 | 19 |
| willow | 30-45 | 2,250 | 7 | 40 |
| maple | 45-60 | 3,375 | 13 | - |
| yew | 60-99 | 5,063 | 185 | 379 |

| Item | Need | GE ask | GE book avg | GE sellers | GE 7-day volume | Coins to fill now | Short | Shops (stock, restock) | Ground |
|---|---|---|---|---|---|---|---|---|---|
| Logs (logs) | 2 | - | - | 0 | 247 | 0 (shop 0, GE 0) | 2; 0.1 d at 7-day trade rate | - | 25 spawns |
| Oak logs (oak_logs) | 4 | 19 | 19 | 27 | 661 | 76 (shop 0, GE 4) |  | - | - |
| Willow logs (willow_logs) | 7 | 40 | 40 | 67 | 550 | 280 (shop 0, GE 7) |  | - | - |
| Maple logs (maple_logs) | 13 | - | - | 0 | 36,945 | 0 (shop 0, GE 0) | 13; 0.0 d at 7-day trade rate | - | - |
| Yew logs (yew_logs) | 185 | 379 | 379 | 48,462 | 352,859 | 70,115 (shop 0, GE 185) |  | - | - |

#### Prayer: bury big bones (no dragon bones)
TOTAL 0 coins for what can be bought now; SHORT: Big bones 2,663; NO PRICE for tiers: big bones (2,663). Source: bones.obj.

| Tier | Levels | XP each (25x) | Items | Coins each (first unit) |
|---|---|---|---|---|
| big bones | 1-99 | 375 | 2,663 | - |

| Item | Need | GE ask | GE book avg | GE sellers | GE 7-day volume | Coins to fill now | Short | Shops (stock, restock) | Ground |
|---|---|---|---|---|---|---|---|---|---|
| Big bones (big_bones) | 2,663 | - | - | 0 | 29 | 0 (shop 0, GE 0) | 2,663; 642.8 d at 7-day trade rate | - | 7 spawns |

#### Prayer: bury bones
TOTAL 304,000 coins for what can be bought now; SHORT: Dragon bones 539. Source: bones.obj, bury_bone.rs2:1-15 (2 ticks per bone).

| Tier | Levels | XP each (25x) | Items | Coins each (first unit) |
|---|---|---|---|---|
| dragon bones | 1-99 | 1,800 | 555 | 19,000 |

| Item | Need | GE ask | GE book avg | GE sellers | GE 7-day volume | Coins to fill now | Short | Shops (stock, restock) | Ground |
|---|---|---|---|---|---|---|---|---|---|
| Dragon bones (dragon_bones) | 555 | 19000 | 19,000 | 16 | 585 | 304,000 (shop 0, GE 16) | 539; 6.4 d at 7-day trade rate | - | - |

#### Smithing: smith bars at an anvil (XP per bar)
TOTAL 42,582 coins for what can be bought now; SHORT: Mithril bar 81, Adamantite bar 157, Runite bar 331; NO PRICE for tiers: mithril (81), adamant (157), rune (331). Source: smithing.struct xpperbar, smithing.rs2:271-301 (5 ticks per item).

| Tier | Levels | XP each (25x) | Items | Coins each (first unit) |
|---|---|---|---|---|
| bronze | 1-15 | 313 | 6 | 8 |
| iron | 15-30 | 625 | 9 | 220 |
| steel | 30-50 | 938 | 27 | 1,502 |
| mithril | 50-70 | 1,250 | 81 | - |
| adamant | 70-85 | 1,563 | 157 | - |
| rune | 85-99 | 1,875 | 331 | - |

| Item | Need | GE ask | GE book avg | GE sellers | GE 7-day volume | Coins to fill now | Short | Shops (stock, restock) | Ground |
|---|---|---|---|---|---|---|---|---|---|
| Bronze bar (bronze_bar) | 6 | - | - | 0 | 0 | 48 (shop 6, GE 0) |  | shantayshop 10 (+18/h); junglestore 10 (+18/h); shilojunglestore 10 (+18/h) | - |
| Iron ore (iron_ore) | 18 | 110 | 114 | 22 | 556,998 | 1,980 (shop 0, GE 18) |  | - | - |
| Steel bar (steel_bar) | 27 | 1502 | 1,502 | 4,175 | 74,114 | 40,554 (shop 0, GE 27) |  | - | - |
| Mithril bar (mithril_bar) | 81 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 81; no trades in 7 days | - | - |
| Adamantite bar (adamantite_bar) | 157 | - | - | 0 | 114 | 0 (shop 0, GE 0) | 157; 9.6 d at 7-day trade rate | - | - |
| Runite bar (runite_bar) | 331 | - | - | 0 | 1,619 | 0 (shop 0, GE 0) | 331; 1.4 d at 7-day trade rate | - | - |

#### Smithing: steel bars from 30 to 99
TOTAL 1,591,144 coins for what can be bought now; SHORT: none. Source: smithing.struct xpperbar.

| Tier | Levels | XP each (25x) | Items | Coins each (first unit) |
|---|---|---|---|---|
| bronze | 1-15 | 313 | 6 | 8 |
| iron | 15-30 | 625 | 9 | 220 |
| steel | 30-99 | 938 | 1,058 | 1,502 |

| Item | Need | GE ask | GE book avg | GE sellers | GE 7-day volume | Coins to fill now | Short | Shops (stock, restock) | Ground |
|---|---|---|---|---|---|---|---|---|---|
| Bronze bar (bronze_bar) | 6 | - | - | 0 | 0 | 48 (shop 6, GE 0) |  | shantayshop 10 (+18/h); junglestore 10 (+18/h); shilojunglestore 10 (+18/h) | - |
| Iron ore (iron_ore) | 18 | 110 | 114 | 22 | 556,998 | 1,980 (shop 0, GE 18) |  | - | - |
| Steel bar (steel_bar) | 1,058 | 1502 | 1,502 | 4,175 | 74,114 | 1,589,116 (shop 0, GE 1,058) |  | - | - |

#### Smithing: bronze bars to 40, then gold ore with goldsmith gauntlets (needs Family Crest (gauntlets_of_goldsmithing))
TOTAL 17,198 coins for what can be bought now; SHORT: Gold ore 698. Source: smelting.struct (gold 22.5), smelting.rs2:216 (x2.5), superheat.rs2:57 (also x2.5).

| Tier | Levels | XP each (25x) | Items | Coins each (first unit) |
|---|---|---|---|---|
| bronze | 1-15 | 313 | 6 | 8 |
| iron | 15-30 | 625 | 9 | 220 |
| steel | 30-40 | 938 | 10 | 1,502 |
| gold ore smelt (gauntlets) | 40-99 | 1,406 | 699 | 150 |

| Item | Need | GE ask | GE book avg | GE sellers | GE 7-day volume | Coins to fill now | Short | Shops (stock, restock) | Ground |
|---|---|---|---|---|---|---|---|---|---|
| Bronze bar (bronze_bar) | 6 | - | - | 0 | 0 | 48 (shop 6, GE 0) |  | shantayshop 10 (+18/h); junglestore 10 (+18/h); shilojunglestore 10 (+18/h) | - |
| Iron ore (iron_ore) | 18 | 110 | 114 | 22 | 556,998 | 1,980 (shop 0, GE 18) |  | - | - |
| Steel bar (steel_bar) | 10 | 1502 | 1,502 | 4,175 | 74,114 | 15,020 (shop 0, GE 10) |  | - | - |
| Gold ore (gold_ore) | 699 | 150 | 150 | 1 | 0 | 150 (shop 0, GE 1) | 698; no trades in 7 days | - | 8 spawns |

#### Magic: teleports with a staff of air (needs staff of air (elemental runes free))
TOTAL 74,498 coins for what can be bought now; SHORT: none. Source: magic_spells.dbrow; wind strike XP excludes damage XP.

| Tier | Levels | XP each (25x) | Items | Coins each (first unit) |
|---|---|---|---|---|
| wind strike | 1-25 | 138 | 36 | 3 |
| Varrock teleport | 25-31 | 875 | 4 | 44 |
| Lumbridge teleport | 31-37 | 1,025 | 5 | 44 |
| Falador teleport | 37-45 | 1,200 | 9 | 44 |
| Camelot teleport | 45-99 | 1,388 | 704 | 40 |

| Item | Need | GE ask | GE book avg | GE sellers | GE 7-day volume | Coins to fill now | Short | Shops (stock, restock) | Ground |
|---|---|---|---|---|---|---|---|---|---|
| Mind rune (mindrune) | 36 | - | - | 0 | 96 | 108 (shop 36, GE 0) |  | magearena_runeshop 140 (+180/h); magicshop 1000 (+900/h); runeshop 1000 (+900/h); magicguildshop 3000 (+500/h) | 4 spawns |
| Law rune (lawrune) | 722 | 2697 | 2,698 | 423 | 7,814 | 74,318 (shop 722, GE 0) |  | magearena_runeshop 250 (+30/h); magicguildshop 1000 (+30/h); mm_magic_shop 250 (+30/h) | - |
| Fire rune (firerune) | 4 | - | - | 0 | 6,398 | 16 (shop 4, GE 0) |  | magearena_runeshop 200 (+180/h); magicshop 1000 (+900/h); runeshop 2000 (+900/h); magicguildshop 3000 (+500/h); mm_magic_shop 1000 (+900/h) | 8 spawns |
| Earth rune (earthrune) | 5 | - | - | 0 | 3,208 | 20 (shop 5, GE 0) |  | magearena_runeshop 200 (+180/h); magicshop 1000 (+900/h); runeshop 2000 (+900/h); magicguildshop 3000 (+500/h); mm_magic_shop 1000 (+900/h) | 3 spawns |
| Water rune (waterrune) | 9 | - | - | 0 | 4,407 | 36 (shop 9, GE 0) |  | magearena_runeshop 200 (+180/h); magicshop 1000 (+900/h); runeshop 2000 (+900/h); magicguildshop 3000 (+500/h); mm_magic_shop 1000 (+900/h) | 3 spawns |

#### Magic: teleports to 80, then Charge (needs staff of air; Mage Arena for Charge)
TOTAL 97,941 coins for what can be bought now; SHORT: none. Source: charge.rs2:1-26 (no p_delay).

| Tier | Levels | XP each (25x) | Items | Coins each (first unit) |
|---|---|---|---|---|
| wind strike | 1-25 | 138 | 36 | 3 |
| Varrock teleport | 25-31 | 875 | 4 | 44 |
| Lumbridge teleport | 31-37 | 1,025 | 5 | 44 |
| Falador teleport | 37-45 | 1,200 | 9 | 44 |
| Camelot teleport | 45-80 | 1,388 | 177 | 40 |
| Charge | 80-99 | 4,500 | 163 | 162 |

| Item | Need | GE ask | GE book avg | GE sellers | GE 7-day volume | Coins to fill now | Short | Shops (stock, restock) | Ground |
|---|---|---|---|---|---|---|---|---|---|
| Mind rune (mindrune) | 36 | - | - | 0 | 96 | 108 (shop 36, GE 0) |  | magearena_runeshop 140 (+180/h); magicshop 1000 (+900/h); runeshop 1000 (+900/h); magicguildshop 3000 (+500/h) | 4 spawns |
| Law rune (lawrune) | 195 | 2697 | 2,698 | 423 | 7,814 | 10,932 (shop 195, GE 0) |  | magearena_runeshop 250 (+30/h); magicguildshop 1000 (+30/h); mm_magic_shop 250 (+30/h) | - |
| Fire rune (firerune) | 493 | - | - | 0 | 6,398 | 2,859 (shop 493, GE 0) |  | magearena_runeshop 200 (+180/h); magicshop 1000 (+900/h); runeshop 2000 (+900/h); magicguildshop 3000 (+500/h); mm_magic_shop 1000 (+900/h) | 8 spawns |
| Earth rune (earthrune) | 5 | - | - | 0 | 3,208 | 20 (shop 5, GE 0) |  | magearena_runeshop 200 (+180/h); magicshop 1000 (+900/h); runeshop 2000 (+900/h); magicguildshop 3000 (+500/h); mm_magic_shop 1000 (+900/h) | 3 spawns |
| Water rune (waterrune) | 9 | - | - | 0 | 4,407 | 36 (shop 9, GE 0) |  | magearena_runeshop 200 (+180/h); magicshop 1000 (+900/h); runeshop 2000 (+900/h); magicguildshop 3000 (+500/h); mm_magic_shop 1000 (+900/h) | 3 spawns |
| Blood rune (bloodrune) | 489 | 1447 | 1,447 | 117 | 14,591 | 83,986 (shop 489, GE 0) |  | magicguildshop 1000 (+30/h) | 4 spawns |

#### Cooking: cook food (no burns counted)
TOTAL 193 coins for what can be bought now; SHORT: Raw herring 2, Raw tuna 2, Uncooked pizza 2, Uncooked cake 12, Uncooked curry 134; NO PRICE for tiers: herring (2), tuna (2), pizza (2), cake (12), curry (134). Source: cooking_generic.dbrow.

| Tier | Levels | XP each (25x) | Items | Coins each (first unit) |
|---|---|---|---|---|
| sardine | 1-5 | 1,000 | 1 | 10 |
| herring | 5-15 | 1,250 | 2 | - |
| trout | 15-25 | 1,750 | 2 | 26 |
| salmon | 25-30 | 2,250 | 2 | 65 |
| tuna | 30-35 | 2,500 | 2 | - |
| pizza | 35-40 | 3,575 | 2 | - |
| cake | 40-60 | 4,500 | 12 | - |
| curry | 60-99 | 7,000 | 134 | - |

| Item | Need | GE ask | GE book avg | GE sellers | GE 7-day volume | Coins to fill now | Short | Shops (stock, restock) | Ground |
|---|---|---|---|---|---|---|---|---|---|
| Raw sardine (raw_sardine) | 1 | - | - | 0 | 0 | 10 (shop 1, GE 0) |  | misc_fishmonger 200 (+9,000/h); etc_fishmonger 200 (+9,000/h); fishingshop 200 (+9,000/h); viking_fishmonger 200 (+9,000/h) | - |
| Raw herring (raw_herring) | 2 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 2; no trades in 7 days | - | - |
| Raw trout (raw_trout) | 2 | - | - | 0 | 0 | 52 (shop 2, GE 0) |  | werewolfstore1 5 (+18/h) | - |
| Raw salmon (raw_salmon) | 2 | - | - | 0 | 0 | 131 (shop 2, GE 0) |  | werewolfstore1 5 (+18/h) | - |
| Raw tuna (raw_tuna) | 2 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 2; no trades in 7 days | - | - |
| Uncooked pizza (uncooked_pizza) | 2 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 2; no trades in 7 days | - | - |
| Uncooked cake (uncooked_cake) | 12 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 12; no trades in 7 days | - | - |
| Uncooked curry (uncooked_curry) | 134 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 134; no trades in 7 days | - | - |

#### Cooking: fish only (helpers can fish all of it)
TOTAL 593 coins for what can be bought now; SHORT: Raw tuna 4, Raw lobster 3, Raw swordfish 70, Raw shark 139; NO PRICE for tiers: tuna (4), lobster (3), swordfish (70). Source: cooking_generic.dbrow.

| Tier | Levels | XP each (25x) | Items | Coins each (first unit) |
|---|---|---|---|---|
| sardine | 1-15 | 1,000 | 2 | 10 |
| trout | 15-25 | 1,750 | 2 | 26 |
| salmon | 25-30 | 2,250 | 2 | 65 |
| tuna | 30-40 | 2,500 | 4 | - |
| lobster | 40-45 | 3,000 | 3 | - |
| swordfish | 45-80 | 3,500 | 70 | - |
| shark | 80-99 | 5,250 | 140 | 390 |

| Item | Need | GE ask | GE book avg | GE sellers | GE 7-day volume | Coins to fill now | Short | Shops (stock, restock) | Ground |
|---|---|---|---|---|---|---|---|---|---|
| Raw sardine (raw_sardine) | 2 | - | - | 0 | 0 | 20 (shop 2, GE 0) |  | misc_fishmonger 200 (+9,000/h); etc_fishmonger 200 (+9,000/h); fishingshop 200 (+9,000/h); viking_fishmonger 200 (+9,000/h) | - |
| Raw trout (raw_trout) | 2 | - | - | 0 | 0 | 52 (shop 2, GE 0) |  | werewolfstore1 5 (+18/h) | - |
| Raw salmon (raw_salmon) | 2 | - | - | 0 | 0 | 131 (shop 2, GE 0) |  | werewolfstore1 5 (+18/h) | - |
| Raw tuna (raw_tuna) | 4 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 4; no trades in 7 days | - | - |
| Raw lobster (raw_lobster) | 3 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 3; no trades in 7 days | - | - |
| Raw swordfish (raw_swordfish) | 70 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 70; no trades in 7 days | - | - |
| Raw shark (raw_shark) | 140 | - | - | 0 | 1 | 390 (shop 1, GE 0) | 139; 973.0 d at 7-day trade rate | werewolfstore1 1 (+9/h) | - |

#### Cooking: food to 35, then hand-made wine (bank ferment)
TOTAL 203 coins for what can be bought now; SHORT: Raw tuna 2, Unfermented wine 360; NO PRICE for tiers: tuna (2), wine (360). Source: wine.rs2:8-70; research/cooking-board.md.

| Tier | Levels | XP each (25x) | Items | Coins each (first unit) |
|---|---|---|---|---|
| sardine | 1-15 | 1,000 | 2 | 10 |
| trout | 15-25 | 1,750 | 2 | 26 |
| salmon | 25-30 | 2,250 | 2 | 65 |
| tuna | 30-35 | 2,500 | 2 | - |
| wine | 35-99 | 2,750 | 360 | - |

| Item | Need | GE ask | GE book avg | GE sellers | GE 7-day volume | Coins to fill now | Short | Shops (stock, restock) | Ground |
|---|---|---|---|---|---|---|---|---|---|
| Raw sardine (raw_sardine) | 2 | - | - | 0 | 0 | 20 (shop 2, GE 0) |  | misc_fishmonger 200 (+9,000/h); etc_fishmonger 200 (+9,000/h); fishingshop 200 (+9,000/h); viking_fishmonger 200 (+9,000/h) | - |
| Raw trout (raw_trout) | 2 | - | - | 0 | 0 | 52 (shop 2, GE 0) |  | werewolfstore1 5 (+18/h) | - |
| Raw salmon (raw_salmon) | 2 | - | - | 0 | 0 | 131 (shop 2, GE 0) |  | werewolfstore1 5 (+18/h) | - |
| Raw tuna (raw_tuna) | 2 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 2; no trades in 7 days | - | - |
| Unfermented wine (jug_unfermented_wine) | 360 | - | - | 0 | 0 | 0 (shop 0, GE 0) | 360; no trades in 7 days | - | - |

#### Runecraft: free altars only (air to body)
TOTAL 94,366 coins for what can be bought now; SHORT: Rune essence 3,705. Source: runecraft.dbrow.

| Tier | Levels | XP each (25x) | Items | Coins each (first unit) |
|---|---|---|---|---|
| air | 1-2 | 125 | 1 | 58 |
| mind | 2-5 | 138 | 3 | 58 |
| water | 5-9 | 150 | 4 | 58 |
| earth | 9-14 | 163 | 6 | 58 |
| fire | 14-20 | 175 | 9 | 58 |
| body | 20-99 | 188 | 5,309 | 58 |

| Item | Need | GE ask | GE book avg | GE sellers | GE 7-day volume | Coins to fill now | Short | Shops (stock, restock) | Ground |
|---|---|---|---|---|---|---|---|---|---|
| Rune essence (blankrune) | 5,332 | 58 | 58 | 1,627 | 683,027 | 94,366 (shop 0, GE 1,627) | 3,705; 0.0 d at 7-day trade rate | - | - |

#### Runecraft: craft essence at the highest altar (needs talismans; cosmic needs Lost City; nature, law members)
TOTAL 94,366 coins for what can be bought now; SHORT: Rune essence 2,607. Source: runecraft.dbrow, runecraft.rs2:68-99.

| Tier | Levels | XP each (25x) | Items | Coins each (first unit) |
|---|---|---|---|---|
| air | 1-2 | 125 | 1 | 58 |
| mind | 2-5 | 138 | 3 | 58 |
| water | 5-9 | 150 | 4 | 58 |
| earth | 9-14 | 163 | 6 | 58 |
| fire | 14-20 | 175 | 9 | 58 |
| body | 20-27 | 188 | 15 | 58 |
| cosmic | 27-35 | 200 | 26 | 58 |
| chaos | 35-44 | 213 | 49 | 58 |
| nature | 44-54 | 225 | 99 | 58 |
| law | 54-99 | 238 | 4,022 | 58 |

| Item | Need | GE ask | GE book avg | GE sellers | GE 7-day volume | Coins to fill now | Short | Shops (stock, restock) | Ground |
|---|---|---|---|---|---|---|---|---|---|
| Rune essence (blankrune) | 4,234 | 58 | 58 | 1,627 | 683,027 | 94,366 (shop 0, GE 1,627) | 2,607; 0.0 d at 7-day trade rate | - | - |

#### Ranged: dwarf multicannon (ESTIMATE 8 damage per ball) (needs Dwarf Cannon quest; cannon set)
TOTAL 938,750 coins for what can be bought now; SHORT: none. Source: cannon_fire.rs2:117-119.

| Tier | Levels | XP each (25x) | Items | Coins each (first unit) |
|---|---|---|---|---|
| cannonball | 1-99 | 400 | 2,497 | 376 |

| Item | Need | GE ask | GE book avg | GE sellers | GE 7-day volume | Coins to fill now | Short | Shops (stock, restock) | Ground |
|---|---|---|---|---|---|---|---|---|---|
| Steel bar (steel_bar) | 624 | 1502 | 1,502 | 4,175 | 74,114 | 938,750 (shop 0, GE 625) |  | - | - |

#### Bank and Equipment leaders (value = obj cost, not GE price)
- bank: nickai3 16,139,489,874 gp; Air rune 1B (7,693,244,540 gp); Raw shark 7M (2,144,679,600 gp); Coins 2B (2,144,530,899 gp); Raw bass 10M (1,294,519,920 gp); Mind rune 247M (743,151,684 gp); Oyster 2M (421,077,800 gp)
- bank: banker 8,021,093,226 gp; Shark 18M (5,413,407,000 gp); Coins 2B (2,147,483,647 gp); Fire rune 65M (263,488,444 gp); Yew logs 418K (66,985,120 gp); Air rune 6M (26,222,448 gp); Earth rune 2M (11,467,444 gp)
- bank: nickai 2,147,884,615 gp; Coins 2B (2,147,300,616 gp); Hardleather body 1K (247,180 gp); Rune platelegs (64,000 gp); Rune chainbody (50,000 gp); Staff of iban (42,500 gp); Rune essence 9K (36,436 gp)
- equipment: nickai3 1,366,450 gp; Dragon med helm (100,000 gp); Cape of legends (450 gp); Dragon necklace (18,375 gp); Dragon battleaxe (200,000 gp); Dragon chainbody (250,000 gp); Dragon sq shield (500,000 gp)
- equipment: soko 1,366,450 gp; Dragon med helm (100,000 gp); Cape of legends (450 gp); Dragon necklace (18,375 gp); Dragon battleaxe (200,000 gp); Dragon chainbody (250,000 gp); Dragon sq shield (500,000 gp)
- equipment: hoplite 1,355,713 gp; Dragon med helm (100,000 gp); Cape of legends (450 gp); Amulet of glory(3) (17,625 gp); Dragon battleaxe (200,000 gp); Dragon chainbody (250,000 gp); Dragon sq shield (500,000 gp)
