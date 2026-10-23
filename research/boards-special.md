# Equipment, Bank, Lava Maze Runite and Quest Points boards (2026-10-23)

These four boards are not skill boards. Only Quest Points uses the playtime clock as its tie-break.
Lava Maze Runite uses a wall-clock tie-break. Equipment and Bank use no time at all.
Code cites are in `vendor/rs-sdk/server/engine/src` (engine) and `vendor/rs-sdk/server/content/scripts`
(content), unless a path is given in full. Live data is from read-only GETs at 2026-10-23T06:30-06:40Z.

Caveat on the code: the live Quest Points page shows the tooltip "N ticks normalized to 400 ms per tick".
The vendored `web/pages/hiscores.ts:60-69` has no such text. So the live server runs newer code than our
vendor copy (see INDEX contradiction C13). Every CODE-READ below is for the vendored copy.

## Rank rules and deadlines

Each row gives the full ORDER BY from the code, what the time key is, and the latest playtime at which
Haggis must reach the value to rank above the current #1.

| Board | Primary key | Tie-break | Time key | Latest playtime for Haggis |
|---|---|---|---|---|
| Quest Points | QP DESC | `playtime` ASC (`web/pages/RankedHiscoresWorker.ts:19`); no third key | `player.playtime` at the **save** (logout or autosave) where the QP total changed, not the tick of the quest complete (`server/login/LoginServer.ts:203-219`, written at `:213`/`:215`) | 145 QP saved at playtime **<= 1,022,261 ticks** (avery: 145 at 1,022,262, MEASURED live 06:37Z). At exactly 1,022,262 the order is undefined. 145 is the maximum, so a time win is the only win |
| Equipment | value DESC | none (`web/pages/hiscores.ts:620`, then `LIMIT 50`) | none. The row has a `date` column (`db/types.ts:118-125`) but the query does not sort on it | Not applicable. Playtime cannot break the tie at 1,366,450 |
| Bank | value DESC | `account.username` ASC (`web/pages/hiscores.ts:981-982`) | none | Not applicable. A tie at 16,139,489,874 goes to the name that sorts first: `haggis` sorts before `nickai3`, so a tie wins (username case not verified) |
| Lava Maze Runite | ore count DESC | `MAX(runite_mine.timestamp)` ASC, "ties go to whoever reached the count first" (`web/pages/hiscores.ts:795-801`) | wall clock: `Date.now()` when each ore is mined (`engine/World.ts:2815-2822`), not playtime | Not a playtime deadline. Haggis needs more ores than the leader, or the same count with an earlier last-ore wall-clock time than the leader's last ore |

Quest Points: the owner note says the leader has 141 of 145. That was true in
`research/hiscores-2026-10-22.json` (avery 141 at 921,761). Live at 06:37Z, avery has 145 at 1,022,262.
So 142+ is no longer enough; Haggis needs 145 below 1,022,262.

## Summary

| Board | Rule (CODE-READ) | Live #1 (MEASURED live) | Our cheapest route | Cost | Owner decision |
|---|---|---|---|---|---|
| Equipment | Sum of `ObjType.cost` (config base price) of worn items, ammo slot skipped; snapshot at logout and autosave; `ORDER BY value DESC`, no tiebreak | nickai3 1,366,450, tied with soko 1,366,450 | Wear the maximum set (below). 1,366,450 is the code maximum, so we can only tie | About 0.95M coins in shops plus 4 drops, or about 754M coins on the GE | **Yes (E1)**: a strict #1 is impossible |
| Bank | Sum of `ObjType.cost x count` over bank slots; same snapshot; ties by username A-Z, so `haggis` wins a tie | nickai3 16,139,489,874 | No legitimate route found. Value is base cost, so it equals wealth in coins | About 16.2B coins of value; about 40 days of 100 gold bots (ESTIMATE) | **Yes (B1)**: concede, or approve a source |
| Lava Maze Runite | Count of runite ores mined from 2 rocks, all time; ties by the earliest last ore (wall clock) | xulvexi 1,928 (309 in the last 24 h) | Mine last, after every stamped board; playtime no longer matters then | 1,929+ ores; about 6.2 days of 24/7 mining if xulvexi stops; never closes at a 50/50 share | **Yes (R1)**: PvP against the leader, or wait |
| Quest Points | QP from 68 quests (145 total); ties by `playtime` ASC at the save that changed the total | avery 145 at 1,022,262 ticks (deadline: 145 saved at <= 1,022,261) | All 145 QP with total playtime below 1,022,262; log out right after the last quest | Quest playtime is not measured | No; follow the rule on the logout stamp |

## Equipment

### Rule

- Value = sum of `objType.cost` for each worn item, one item per slot. Slot 13 (quiver) is skipped
  (`server/login/LoginServer.ts:229`, `:235`; `^wearpos_quiver = 13` at content `player/configs/equip.constant:15`).
  `cost` is the config base price; the default is 1 (`cache/config/ObjType.ts:147`). No GE price is used.
- Written by `updateWealthHiscores` (`LoginServer.ts:222-254`). It runs at logout (`updateHiscores`,
  `LoginServer.ts:196-197`, called at `:746`) and at each autosave (`LoginServer.ts:747-763`). Autosave is
  every 1,500 ticks (`engine/World.ts:130`, `:478`). The board is a snapshot, not a live value.
- Ranked by `ORDER BY hiscore_outfit.value DESC LIMIT 50` with no second key (`web/pages/hiscores.ts:615-621`).
  The order of tied rows is not defined in SQL. Live, tied rows are not in name order (goo017, goo008,
  goo019 ... at 491,658), so the order is likely row storage order. Not verified.

### The maximum set (CODE-READ, content `*.obj`)

The largest `cost` per worn slot. Dragon halberd (250,000) is two-handed (`wearpos2=lefthand`) and blocks the
500,000 shield, so the one-handed battleaxe wins.

| Slot | Item | Cost | Source (cheapest) | Wear requirement |
|---|---|---|---|---|
| hat | Dragon med helm | 100,000 | KBD drop (`areas/area_wilderness/scripts/king_black_dragon.rs2:31`), rare drop table (`drop tables/scripts/shared_droptables.rs2:103`); GE ask 13.9M | Defence 60 |
| back | Cape of legends | 450 | Legends' Guild shop, 675 coins (`areas/area_ardougne_east/configs/legends_guild/legends_guild.inv:28`, sell x1.5) | Legends' Quest |
| front | Dragon necklace | 18,375 | Craft: dragonstone + gold bar, Crafting 72; uncut dragonstone has 0 GE sellers | none found |
| righthand | Dragon battleaxe | 200,000 | Heroes' Guild shop, 200,000 coins, stock 2 (`areas/areas_heroes_guild/configs/heroes_guild.inv:7`, sell x1.0 at `heroes_guild.npc:65-66`) | Heroes' Quest, Attack 60 (`levelrequire/scripts/tier60.rs2:6`) |
| torso | Dragon chainbody | 250,000 | Kalphite Queen drop (`drop tables/scripts/kalphite_queen.rs2:107`); GE ask 350M, 2 sellers | Defence 60 (`tier60.rs2:14`) |
| lefthand | Dragon sq shield | 500,000 | Right half from the Legends' Guild shop, 750,000 coins (`legends_guild.inv:27`); left half from the rare drop table (`shared_droptables.rs2:129`) or GE ask 150M; join at an anvil, Smithing 60 (`skill_smithing/scripts/smithing/dragon_sq.rs2:21-50`) | Legends' Quest, Defence 60 (`tier60.rs2:13`) |
| legs | Dragon platelegs | 270,000 | Bronze, iron, steel dragon drops (`drop tables/scripts/bronze_dragon.rs2:12` and others); GE ask 240M | Defence 60 (`tier60.rs2:15`) |
| hands | Splitbark gauntlets | 5,000 | Wizard in the Wizards' Tower: 1 hollow bark + 1 fine cloth + 1,000 coins (`areas/area_wizard_tower/scripts/armourmaking_wizard.rs2:118-133`) | Magic 40, Defence 40 (`levelrequire/scripts/tier40.rs2:88`) |
| feet | Splitbark greaves | 5,000 | Same wizard, same inputs (`armourmaking_wizard.rs2:134-147`) | Magic 40, Defence 40 (`tier40.rs2:87`) |
| ring | Ring of wealth | 17,625 | Dragonstone ring (Crafting 55), then enchant; the enchant level is not verified | not verified |
| **Total** | | **1,366,450** | | |

The live #1 and #2 (nickai3, soko) wear exactly this set: 1,366,450 (MEASURED live). The #3 (hoplite,
1,355,713) has a glory, goldsmith gauntlets and climbing boots instead.

### Plan

1. Get Heroes' Quest and Legends' Quest on the QP route. Both are needed anyway for 145 QP.
2. Buy in shops: battleaxe 200,000, right shield half 750,000, cape 675. Make the splitbark pieces
   (2,000 coins plus 2 bark and 2 fine cloth). Craft the necklace and the ring (2 dragonstones).
3. Get the helm, chainbody, platelegs and left shield half from helpers' drops, or buy them on the GE
   (13.9M + 350M + 240M + 150M = about 754M coins at today's asks; ESTIMATE, the asks move).
4. Never wear the set into the Wilderness (PvP; see Runite). Put it on as the last act, then log out.
5. Without the Cape of legends the best is 1,366,250 (Fremennik cloak, 250). That is rank 3.

### OWNER DECISION E1

The code maximum is 1,366,450. Two accounts already hold it. With no tiebreak key, Haggis can tie but
cannot pass them, and the order inside the tie is up to the database. A strict #1 needs an item that is
not in the content or an engine change. Options: accept a tie (the shown rank can be 1, 2 or 3), or drop
the board from the "all 24" goal.

## Bank

### Rule

- Value = sum over bank slots of `objType.cost x count` (`LoginServer.ts:259-272`). Base price, not GE
  price. Coins have the default cost 1 (`ObjType.ts:147`). Inventory and worn items do not count.
- Same snapshot times as Equipment (logout and autosave). An empty bank also replaces the old row
  (`LoginServer.ts:275-285`).
- Ranked by value DESC, then username A-Z (`web/pages/hiscores.ts:974-982`). Accounts with
  `staffmodlevel > 1` are hidden.

### Live board (MEASURED live, top 10)

| # | Name | Value | Top items |
|---|---|---|---|
| 1 | nickai3 | 16,139,489,874 | Air rune 1.92B (7,693,244,540), Raw shark 7.1M (2,144,679,600), Coins 2.14B, Raw bass 10.8M (1,294,519,920), Mind rune 247M (743,151,684), Oyster 2M (421,077,800) |
| 2 | banker | 8,020,900,991 | Shark 18M (5,413,407,000), Coins 2,147,483,647 (the stack cap) |
| 3 | nickai | 2,147,884,615 | Coins 2,147,300,616 |
| 4 | soko | 1,631,807,549 | Coins 1.01B, longbows |
| 5 | stein | 1,504,481,814 | Coins 1.38B, rune armour |
| 6 | kurobanker | 1,481,474,671 | Coins only |
| 7 | hoplite | 928,927,401 | Coins 916M |
| 8 | goo021 | 871,038,687 | Coins 851M |
| 9 | lebek | 765,452,871 | Coins 765M |
| 10 | nickai2 | 680,202,007 | Coins 680M |

The top 50 hold 40.6B together; nickai3 holds 40% of that.

### What the numbers mean

- The 16.1B is **not** a manipulated market price. The board uses base cost: Air rune 4, Raw shark 300,
  Raw bass 120, Mind rune 3 (content `skill_magic/configs/runes.obj:26-50`, `skill_fishing/configs/fishing.obj:589,753`).
  It is real quantity: about 1.92 billion air runes and 7.1 million raw sharks.
- These quantities are far above any gathering rate. The source is not verified. Cheat commands need
  `staffModLevel >= 2` (`network/game/client/handler/ClientCheatHandler.ts:53`), and the boards hide staff
  above 1, so a current staff account is ruled out; a past one is not.
- Coins are the best store of board value. On the live GE, 60 items have sellers. Only tiny lots trade
  below base cost (Yew longbow 571 at 473 against base 640: +95K value in total). Shark asks 533 against
  base 300; Air rune trades at 18 against base 4 (MEASURED live, `/api/market/items`, 1,443 items).
- Shops sell at `shop_sell_multiplier / 1000` of base cost, with a floor of 10% when overstocked
  (content `shop/scripts/shop.rs2:139-148`, `:183-193`). Only 3 shops sell below base: Irksol 50% (ruby
  rings, stock 5, `areas/area_lostcity/configs/lostcity.inv:12-20`), Noterazzo 90% (general store),
  Tiadeche 55% (karambwan items). Their stocks are too small to matter.

### Plan

There is no route that reaches 16.14B with legitimate play in a useful time:

- One coin stack caps at 2,147,483,647, so at least 14.0B must be items, bought at or above base cost.
- The gold model in `scripts/goldfarm.ts:3` (another agent's uncommitted file) gives 18.8 coins per tick
  per bot at Thieving 99 (ESTIMATE). 16.2B / 18.8 = 862M bot-ticks: 100 bots for about 40 days at 400 ms.
- The cheapest step that still helps: at the end, Haggis banks the whole team's wealth (helpers give
  coins and items by trade), keeps nothing in the inventory, and logs out. That ranks Haggis by team
  wealth, which today is far below 16B.

### OWNER DECISION B1

Rule: value = base cost x count; #1 = 16,139,489,874. A legitimate team route needs about 16.2B of
coin value. Options: concede the board, or name a source. Any source that makes billions in hours is
almost certainly an exploit or a dupe, which R10 rules out (`research/owner-requests.md:29`). I did not
plan around one.

## Lava Maze Runite

### Rule

- The mining script calls `runite_mined(loc_coord)` for each runite ore (content
  `skill_mining/scripts/mining.rs2:172`). The engine counts only the two rocks at (3059,3885) and
  (3060,3884), map square m47_60 (`engine/script/handlers/DebugOps.ts:8-9`, `:16-18`), and logs one row
  per ore with a wall-clock timestamp (`engine/World.ts:2813-2823`, table `runite_mine` at `db/types.ts:155-160`).
- Board: `COUNT(*)` per username, ores DESC, then the earliest last ore ASC: "ties go to whoever reached
  the count first" (`web/pages/hiscores.ts:791-802`). Top 10 only, for all time, the last 7 days and the
  last 24 hours (`:776`, `:828`).
- Playtime is not used. The tie-break is wall-clock time of the last ore. Mining time still adds to
  Haggis's playtime clock, which matters only for the boards stamped later.

### Rock facts (CODE-READ, content `skill_mining/configs/mine.dbrow:149-160`)

- Mining 85, 1,250 base XP, success `stat_random(1, 18)`: at level 99 the chance is 19/256 = 7.4% per roll
  (`engine/script/handlers/PlayerOps.ts:591-599`).
- Rune pickaxe `mining_rate` 2 (`skill_mining/configs/pickaxes.obj:198`): a roll every 3 ticks
  (`mining.rs2:118-126`). Uncontested: about 40 ticks per ore (ESTIMATE).
- Respawn = 2,400 x (4000 - min(players online, 2000)) / 4000 ticks (`general/scripts/player_count.rs2:1-4`,
  called at `mining.rs2:161`). The tick-tricks note "1,800-2,400" covers 0-1,000 players.

| Players online | Respawn (ticks) | Ores per day, both rocks, one miner |
|---|---|---|
| 100 | 2,340 | 181 |
| 500 | 2,100 | 202 |
| 1,000 | 1,800 | 235 |
| 1,700 | 1,380 | 304 |
| 2,000 | 1,200 | 348 |

### Live board (MEASURED live)

| # | All time | Last 7 days | Last 24 h |
|---|---|---|---|
| 1 | xulvexi 1,928 | xulvexi 1,928 | xulvexi 309 |
| 2 | goo001 1,847 | goo001 56 | |
| 3 | goo003 1,192 | goo003 54 | |
| 4 | goo002 1,144 | goo002 37 | |
| 5 | redactedmn3 338 | dotbot_4 7 | |
| 6 | redactedckr 211 | dotbot_3 6 | |
| 7 | redactedmn2 175 | basednpc 5 | |
| 8 | not_kadeski 158 | hermitscape 4 | |
| 9 | redactedr1 158 | sokobot 3 | |
| 10 | redactedr3 109 | sokobot/brmsmith | |

xulvexi mined all 1,928 inside the last 7 days and 309 in the last 24 hours. 309 per day fits about
1,700 players online in the table above, or a respawn rule that differs live. Not verified.

### Danger

- Level 46 Wilderness (the board page says so). PvP is on in the content (`skill_combat/scripts/pvp/pvp_combat.rs2`;
  PvP deaths respawn at 1 HP, `player/scripts/death.rs2:65-67`). Haggis at combat 126 can be attacked by
  players from about combat 80 up.
- NPCs: `bun research/route-danger.ts 3059,3885 3060,3884 --margin 8` gives
  `ROUTE 3059,3885 -> 3060,3884: 2 tiles, 0 danger spawns in reach (margin 8)`. The walk from Edgeville
  through the Wilderness is not checked yet.

### Plan

1. Mine runite **after** every playtime-stamped board (19 skills, Overall, Quest Points). The Runite board
   ranks by count, then wall-clock time, so the extra playtime then costs nothing.
2. Carry only a rune pickaxe and food. Never wear the Equipment set here.
3. Stand still on the rock tile and click on the respawn tick (fact 9 in INDEX).
4. Helpers do not help Haggis's count: only Haggis's own ores count. If helpers also mine, they take ores
   from Haggis and xulvexi alike, so the gap does not close.
5. Numbers: if xulvexi stops, Haggis gets about 309 per day and needs 1,929, so about 6.2 days of 24/7
   mining (about 1.35M ticks). If xulvexi stays, each miner wins about half the races (equal roll rate), and
   the 1,928 gap never closes.

### OWNER DECISION R1

Rule: count of ores, wall clock, 2 shared rocks; #1 = 1,928 and rising about 300 per day. With equal miners
the leader keeps the lead. Options: (a) wait until xulvexi stops, then mine about 6 days; (b) attack
xulvexi in the level 46 Wilderness with PvP (a normal game mechanic, but it targets another player);
(c) log in many helper accounts to raise the player count and shorten the respawn for everyone (it raises
both counts equally, so it does not close the gap alone, and it loads the server); (d) concede.

## Quest Points

### Rule

- `%qp` is recounted from quest varps at login and at each quest complete (content
  `general/scripts/quests.rs2:89-94`, `[proc,count_questpoints]` at `:96-302`). 68 quests, **145 QP in total**
  (`general/configs/quest.constant:72-139`, summed).
- The board row is written at logout and at autosave (`LoginServer.ts:203-219`). The playtime is
  `player.playtime` **at that save**, and only when the QP total changed (`:210-215`). It is not the
  tick of the quest complete.
- Ranked by points DESC, then playtime ASC (`web/pages/RankedHiscoresWorker.ts:19`).

### Live board (MEASURED live, top 10)

| # | Name | QP | Playtime |
|---|---|---|---|
| 1 | avery | 145 | 1,022,262 ticks (113h 35m) |
| 2 | nickai | 142 | 2,616,809 |
| 3 | 0hyl8lmri | 135 | 1,261,343 |
| 4 | soko | 135 | 1,880,939 |
| 5 | sokobot | 135 | 2,057,324 |
| 6 | momobot | 135 | 1254h |
| 7 | hoplite | 132 | 1456h |
| 8 | brotha | 129 | 1983h |
| 9 | voltbot | 115 | 145h |
| 10 | sokoalt2 | 115 | 403h |

The task brief and `research/hiscores-2026-10-22.json` say avery had 141 at 921,761. Avery has since
reached the full 145. So Haggis must reach 145 with a lower playtime than 1,022,262 ticks.

### Plan

1. The budget is the full clock: Haggis's total playtime when the 145th point is saved must be below
   1,022,262. The skill boards need far less (the Overall leader is 35,916 ticks, `research/overall-board.md`),
   so about 980,000 ticks are left for quests: about 14,400 ticks (1.6 h) per quest on average (ESTIMATE).
2. Do the quests that give board XP first, inside the skill phase (`research/quest-xp.md`,
   `research/quest-route.md`): Waterfall, Tree Gnome Village, The Grand Tree, Fight Arena, Vampire Slayer
   (Attack); Dragon Slayer, Haunted Mine, Scorpion Catcher (Strength); Holy Grail (Defence, Prayer);
   Regicide (Agility); Observatory/Dig Site `itexam` (Mining); Watchtower (Magic); Eadgar's Ruse (Herblore);
   Temple of Ikov (Ranged, Fletching); The Knight's Sword `squire` (Smithing 318,125).
3. Do every other quest after the skills are 99. Combat and skill checks are then trivial, and quest XP
   no longer moves any level, so no stamp changes (`LoginServer.ts:171` keeps the stamp when the level
   is the same).
4. Gates in this content: Dragon Slayer needs 32 QP (`quests/quest_dragon/scripts/dragon_journal.rs2:7`),
   Heroes' Quest 55 QP (`quests/quest_hero/configs/quest_hero.constant:20`), Legends' Quest 107 QP
   (`quests/quest_legends/configs/quest_legends.constant:76`). Legends' Quest (4 QP) is near the end.
5. Log out on the tick after the last quest completes. If Haggis stays online, the next autosave (up to
   1,500 ticks later) stamps the later playtime.
6. Quest playtime is not measured for any quest. The first measurement is the Waterfall task in progress
   (`research/quest-route.md:27`). Measure each quest's ticks before the run is planned in detail.

### Owner decisions

None needed. The route uses normal quest play.

## Order of the four boards in one Haggis run

1. Skill phase with the quest-XP quests (all skill boards and Overall get their stamps).
2. All remaining quests; log out at 145 QP (Quest Points stamp).
3. Runite camping (wall clock only; carry nothing of value).
4. Bank in all team wealth; wear the maximum Equipment set; log out. The last save sets both boards.
