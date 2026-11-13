# Combat XP per tick, cannon, stun guests

Measurements 1, 2 and 3 of `research/gap-closers.md`. All runs are MEASURED practice: the local server, preset
accounts (not fresh accounts), one bot at a time, `RANDOM_EVENTS=0`. Rates are in ticks, so the 150 ms practice tick
does not matter. The quest helper can add cannon rows from Dwarf Cannon under "Cannon"; name the script and preset.

Paths start at `vendor/rs-sdk/server/content/scripts/`.

## Result

| Planner row | MEASURED floor / realistic |
|---|---|
| `att-top`, `str-top` style XP per tick | **203.3 / 185.3** (ice warriors, band 90, section 4) |
| `def-top` style XP per tick (Defence 1 to 99) | **179.5 / 162.9** (best spot per band) |
| `hp-top` Hitpoints XP per tick | **67.3 / 61.4** (ice warriors) |
| `cannon-melee` on `att-top`, `str-top` | **94.0 / 86.7, +2.125 Ranged per style XP** (fixed top-up, section 5) |
| `cannon-melee` on `def-top` | **94.0 / 86.7, +2.125** (band 90 rate for all bands) |
| `cannon-melee` on `hp-top` | **31.1 / 28.7, +6.42** Ranged per HP XP |
| `thieve` `deadTicks` (stun-guests) | 1,511 / 2,611 |

Overall finish (scenario a, all safe levers, `haggis-cli.ts --levers`; the "without" column disables `cannon-melee`).

| Table | Floor | Realistic | Without `cannon-melee`, floor / realistic |
|---|---|---|---|
| HEAD + these rows (committed) | 38,100 (late 2,184) | 45,580 (late 9,664) | 37,805 / 45,266 |
| Working tree (these rows + uncommitted rows of other agents) | 38,191 (late 2,275) | 45,540 (late 9,624) | 37,896 / 45,226 |

Faster melee hardly moves Overall now. In the current schedule, Attack and Strength are already 99 when "Melee to
Attack 99" starts (0 ticks), "Combat top-up to Hitpoints 99" takes 0 ticks, and Defence needs only 671 ticks after
the `ranged` row. The critical path is the `ranged` row (4,808 ticks, cannon + melee) and the short quests (6,659
ticks). `cannon-melee` costs 295 / 314 ticks: it slows `def-top` from 162.9 to 86.7 style XP per tick, and the
Ranged it adds is not needed at that point.

## Live cow training and the level table

- **Level table.** This server's level table is `floor(level + 300 * 2^(level / 10))`, summed and divided by 4
  (`server/engine/src/engine/entity/Player.ts:82-88`; the standard curve uses `2^(level / 7)`). So 99 costs 998,458 XP:
  level 46 is 24,475, 60 is 66,193, 70 is 133,230 and 90 is 534,888. The live server's xpRate is 25
  (`server/engine/src/util/WorldConfig.ts:102`).
- **Live cow training.** Dipstick (claude-cloud-4), `scripts/gather-combat.ts Dipstick 3000 cow` with
  `TRAIN_SKILL=Strength COW_BANK_PROFILE=north MAX_KILLS=8`, 4 runs, all `RESULT ok` with 8 kills, no deaths, no
  food, logged out:

  | Run | Ticks | Strength XP | Strength level |
  |---|---|---|---|
  | 1 | 486 | 6,700 | 1 -> 28 |
  | 2 | 412 | 6,500 | 28 -> 37 |
  | 3 | 366 | 6,500 | 37 -> 43 |
  | 4 | 398 | 6,400 | 43 -> 46 |

  Total 1,662 ticks for 26,100 Strength XP (15.7 per tick) and about 5.1 Hitpoints XP per tick. A kill gives 815 XP live
  against 34 on practice at xpRate 1. Ticks per level reach 133 by level 43.
- **What it implies.** At that rate, Strength 46 to 99 is about 62,000 ticks; at the ice warriors' 185 style XP per tick
  (section 4) it is about 5,300. Cows suit levels up to about 45, then a better trainer.
- **Two accounts share the north field.** Practice, 3 pairs run at once. Each account started at the knight spot
  (2653, 3300) with a farm pack (20,000 coins and 27 cake pieces), Hitpoints 50 and Strength 1, with its sword and shield
  banked. `COW_STAGE=1` banked the pack, keeping 2 whole cakes. All 6 runs ended `RESULT ok` with 8 kills, Strength
  1 -> 28 or 29 and no food eaten, in 558/702, 487/554 and 562/552 ticks. This needs the target rule that skips only a
  cow with another player within 2 tiles: with a 12-tile rule, live claude-cloud TrouserSnake sat 198 ticks with no
  target beside TheFullMonty.
- **Three accounts share the north field.** Practice, 3 triples at once, same start. All 9 runs ended `RESULT ok` with 8
  kills, no deaths and no food eaten, in 600/611/544, 590/550/620 and 618/514/551 ticks. The per-bot median is 590,
  against 550 solo (3 solo runs: 550, 594, 550). This needs cow mode to give a cow up and pick another. It releases one
  that has been in someone else's combat for 12 ticks, or one with no own XP and no combat for 40. Without the release,
  one bot in each triple stopped on `target/loot timeout` after another account took its cow. Gap: practice only.
- **Six accounts share the north field.** Practice, 3 sets of six fresh accounts at once (every combat skill 1,
  Hitpoints 10, started at the knight spot with the kit and 20 trout banked). All 18 runs ended `RESULT ok` with 8
  kills and Strength 1 -> 28 or 29, at most 2 trout eaten and lowest HP 6, in 718/761/764/783/839/882,
  678/703/703/790/805/821 and 734/744/774/793/826/844 ticks. The per-bot median is 779, against 590 with three, so six
  make about 1.5 times the field output of three (6/779 against 3/590 runs a tick). The pen holds ten cows. This needs
  cow mode to give up a cow that another account killed: it gives this account no drops, and a new cow takes its
  index. Without that, 2 of 18 runs waited out the 200-tick window after 4-5 kills and ended on `target/loot timeout`,
  in each of two such measurements. Evidence: `.practice/starter/many.ts` (`six.out`, `six-crowd.out`, `six-release.out`);
  `scripts/gather-combat.test.ts` (a cow another account kills). Gap: practice only; more than six is not measured.
- **Gap.** One account and one skill; the rate at levels above 46 is not measured.

## Troopers with an army account's own kit

- **Claim.** On practice at xpRate 25, an army-shaped account trains Strength 60 -> 72-73 on the Gnome battlefield Khazard
  troopers in about 1,585 ticks (61-63 Strength XP per tick). That is about 4 times the cows' 16. It uses only a bronze
  sword and wooden shield (the market has no rune scimitar sellers) and eats 0-3 sharks.
- **Conditions.** `scripts/gather-combat.ts <bot> 1500 trooper` with `TRAIN_SKILL=Strength TARGET_LEVEL=99 GIANT_FOOD=10`
  (runGiants with `TROOPER_SITE`). Start at the Ardougne north bank with Attack 69, Strength 60, Defence 61, Hitpoints
  84, the sword, shield and 30 sharks banked. Ticks include the walk out from the bank.

  | Run | Kills | Strength | XP | Ticks | XP per tick | Sharks eaten | Lowest HP |
  |---|---|---|---|---|---|---|---|
  | 1 | 43 | 60 -> 72 | 96,500 | 1,584 | 60.9 | 0 | 50 |
  | 2 | 45 | 60 -> 73 | 98,800 | 1,585 | 62.3 | 2 | 41 |
  | 3 | 46 | 60 -> 73 | 100,500 | 1,585 | 63.4 | 3 | 41 |

- **Evidence.** `.practice/troopers/run.ts` in the Claude cloud container that ran them.
- **Gap.** Practice only; one skill; a better weapon (section 1's rune gear gives 137 at band 70) is not available on
  the market.
- **Claim.** Fourteen accounts train on the troopers at once, each at about 60% of the solo rate (nine at about
  80%), when each picks its own trooper. Accounts that stand together otherwise all take the nearest free trooper and
  split every kill. Each added account lowers the others' rate and raises the field total.
- **Conditions.** The run above, six, nine or fourteen accounts started together, 3 sets each. "Nearest" is the trainer taking
  the nearest free trooper. "Spread" is `roamTarget`: with another player within 20 tiles, each account ranks the free
  troopers by distance plus its own fixed offset of 0-7 tiles, and leaves a trooper that faces another player before
  its own first hit lands (`anothersFight`). Strength XP per tick an account, sorted, cap 1,500:

  | At once | Rule | Set | XP per tick an account | Field total | Sharks eaten |
  |---|---|---|---|---|---|
  | 6 | nearest | 1 | 37.8, 39.3, 40.8, 41.7, 50.4, 53.3 | 263.3 | 1 |
  | 6 | nearest | 2 | 26.2, 26.4, 29.0, 42.1, 56.7, 59.9 | 240.3 | 1 |
  | 6 | nearest | 3 | 45.3, 45.5, 46.8, 51.0, 54.0, 58.7 | 301.3 | 2 |
  | 6 | spread | 1 | 55.2, 55.3, 56.5, 57.1, 58.7, 60.2 | 343.0 | 9 |
  | 6 | spread | 2 | 53.7, 53.7, 54.6, 57.0, 60.1, 65.2 | 344.3 | 6 |
  | 6 | spread | 3 | 51.0, 54.1, 55.4, 56.9, 60.8, 62.1 | 340.3 | 5 |
  | 9 | nearest | 1 | 13.4, 14.8, 15.3, 33.9, 41.8, 45.0, 48.9, 54.7, 59.7 | 327.5 | 3 |
  | 9 | nearest | 2 | 18.4, 22.7, 26.0, 31.3, 34.0, 35.4, 42.8, 50.1, 54.5 | 315.2 | 1 |
  | 9 | nearest | 3 | 32.2, 35.3, 36.1, 37.8, 38.7, 39.5, 41.1, 48.8, 52.4 | 361.9 | 0 |
  | 9 | spread | 1 | 48.6, 49.7, 50.2, 50.7, 50.8, 52.2, 55.1, 55.8, 57.4 | 470.5 | 7 |
  | 9 | spread | 2 | 41.3, 45.2, 45.3, 46.0, 47.5, 49.0, 51.3, 53.4, 57.1 | 436.1 | 3 |
  | 9 | spread | 3 | 42.0, 42.8, 43.7, 44.4, 48.8, 49.0, 50.3, 50.8, 54.5 | 426.3 | 7 |
  | 14 | spread | 1 | 32.7, 35.0, 36.0, 36.0, 36.1, 36.8, 37.5, 38.1, 38.3, 40.0, 40.9, 41.0, 41.0, 44.3 | 533.7 | 1 |
  | 14 | spread | 2 | 29.5, 32.3, 32.3, 33.7, 34.2, 35.8, 38.8, 39.6, 39.6, 41.0, 41.2, 43.8, 44.4, 44.5 | 530.7 | 1 |
  | 14 | spread | 3 | 31.0, 34.4, 36.6, 37.3, 37.4, 37.7, 38.5, 39.0, 39.2, 39.2, 40.4, 42.1, 44.5, 45.5 | 542.8 | 2 |

  All 132 runs ended `RESULT ok` on the cap; the lowest HP was 40. Medians: six 45.4 nearest and 56.7 spread, nine 37.8
  nearest and 49.7 spread, fourteen 38.4 spread. Under "nearest" an account credited up to 97 kills a run, most of
  them shared; under "spread" 40-50, its own, and 39-62 with fourteen. With fourteen about half the runs took 1,770
  to 1,840 ticks against 1,575 to 1,610, the walk back included.
- **Evidence.** `.practice/troopers/run.ts`, six, nine or fourteen started in one shell loop (`six.out`, `nine.out`,
  `six-spread.out`, `nine-spread.out`, `fourteen.out`); `scripts/gather-combat-giant.test.ts` (accounts in company
  spread).
- **Gap.** Practice only; all melee Strength; more than fourteen at once and a mix with Ranged trainers are not
  measured. Live, with burying on: nine at once with bronze swords gave 28-50 XP per tick an account, and twelve at
  once gave 46.7-73.7 (the two at the top held adamant scimitars), every run `RESULT ok`.
- **Claim.** Bones buried on the field: with `GIANT_BURY=1` the trooper trainer buries the bones of almost every own
  kill, about 2.5 Prayer XP per tick an account, for 16% of the Strength rate. Troopers drop bones on every kill
  (`npc_combat.param` `death_drop`), 112 or 113 Prayer XP each at this server's rate.
- **Conditions.** Six accounts at once with the spread rule, 3 sets, cap 1,500, Prayer 74 at the start. "Wait" takes
  the bones with the bot's pickup, buries them and waits for the Prayer XP before the next attack. "No wait" sends the
  pickup itself and the next attack at once. Strength XP per tick an account, sorted:

  | Burying | Set | XP per tick an account | Bones buried a run | Prayer XP a run |
  |---|---|---|---|---|
  | off | 1-3 | median 56.7 (the spread rows above) | 0 | 0 |
  | wait | 1 | 43.8, 47.6, 48.1, 48.2, 49.6, 51.2 | 34-36 | 3,825-4,050 |
  | wait | 2 | 45.0, 46.7, 47.5, 47.7, 48.0, 52.3 | 34-37 | 3,825-4,162 |
  | wait | 3 | 44.4, 45.7, 46.1, 47.8, 51.2, 52.0 | 32-38 | 3,600-4,275 |
  | no wait | 1 | 31.3, 32.2, 33.3, 33.7, 35.0, 41.2 | 24-29 | 2,700-3,262 |
  | no wait | 2 | 33.3, 33.8, 34.8, 35.8, 37.5, 39.3 | 26-30 | 2,925-3,375 |
  | no wait | 3 | 36.7, 37.7, 38.9, 39.3, 40.3, 40.7 | 29-33 | 3,262-3,712 |

  All 36 burying runs ended `RESULT ok`. Medians: 47.8 with the wait, 36.2 without it, so the trainer waits: the
  attack sent during the dig is lost. A run credits 32-39 kills with the wait against 40-49 with burying off, about 9
  more ticks a kill. The trainer stops burying at Prayer 99.
- **Evidence.** `.practice/troopers/run.ts` with `GIANT_BURY=1` (`six-bury.out`, `six-bury2.out`);
  `scripts/gather-combat-giant.test.ts` (with GIANT_BURY a trooper kill's bones are taken and buried).
- **Gap.** Practice only; Strength only: a bow kills at range, so the walk to the bones is longer and that cost is
  not measured. Where the 9 ticks go is not measured.
- **Claim.** A cow leaver trains on the troopers on its own raw beef: with `TROOPER_COOK=1` the trooper job first
  cooks banked raw beef at the range north-east of the Ardougne north bank (2642,3355, cooked from the tile north of
  it) and the trainer eats the cooked meat, 3 HP a piece. A 1,500-tick run eats 5-7 pieces.
- **Conditions.** Three accounts at once, each Attack, Strength and Defence 62, Hitpoints 63, Cooking 1, a bronze
  sword, 300 raw beef banked and no other trooper food, `GIANT_FOOD=20`, `GIANT_BURY=1`, cap 1,500:

  | Account | Cook stage: cooked, burnt, ticks | Strength XP per tick | Kills | Meat eaten | Lowest HP |
  |---|---|---|---|---|---|
  | 1 | 79, 5, 528 | 46.1 | 35 | 5 | 31 |
  | 2 | 82, 2, 523 | 42.4 | 34 | 7 | 31 |
  | 3 | 81, 3, 523 | 51.0 | 37 | 6 | 30 |

  All three ended `RESULT ok`, Strength 62 to 71-72. The stage cooks three packs when the account owns fewer than 20
  pieces of trooper food, about 40 ticks to the range, 31 back and 3-4 ticks a cook; 84 raw beef last about 13 runs.
  The range in the house south of the bank (2617,3317) is behind a locked door and has no route.
- **Evidence.** `.practice/troopers/cook.ts` (`cook-b.out`, `cook-c.out`, `cook-d.out`), `.practice/troopers/range.ts`;
  `scripts/trooper-food.test.ts`; `scripts/gather-combat-giant.test.ts` (a bite whose heal a hit hides; out of food
  at low HP).
- **Gap.** Practice only, one set of three; Ranged on cooked meat and a run that starts under Defence 60 are not
  measured.
- **Claim.** With its beef gone a trooper account feeds itself at the Ardougne baker's stalls: the food stage steals
  cake, bread and chocolate slices, and the trainer eats cake a bite at a time.
- **Conditions.** Accounts at 62/62/62, Hitpoints 63, Thieving 60, a bronze sword, no beef and no food banked,
  `TROOPER_COOK=1 GIANT_FOOD=20 GIANT_BURY=1`, cap 1,500. The stage steals until the pack holds 24 food items or 500
  ticks pass, from a stall side tile with no guard within 6 tiles:

  | Run | At the stalls at once | Stolen, refused | Stage ticks | Bites owned | Strength XP per tick | Bites eaten | Lowest HP |
  |---|---|---|---|---|---|---|---|
  | 1 | 1 | 12, 2 | 582 | 28 | 45.5 | 0 | 34 |
  | 2 | 2 | 8, 8 | 574 | 20 | 47.6 | 5 | 30 |
  | 3 | 2 | 8, 8 | 573 | 18 | 52.1 | 3 | 31 |

  All three ended `RESULT ok` with the food account exact. A steal is refused for 10 ticks after any combat hit
  (`stealing.rs2`), so the stage keeps away from guards and does not fight them; two thieves share one stall's
  8-tick restock. A cake is 3 bites of 4 HP, bread and a chocolate slice 5 HP.
- **Evidence.** `.practice/troopers/stall.ts` (`stall.out`, `stall2.out`); `scripts/trooper-food.test.ts`;
  `scripts/gather-combat-giant.test.ts` (trooper food is counted in bites).
- **Gap.** Practice only. More than two at the stalls at once is not measured, and the stage stops at 500 ticks short
  of a full pack.
- **Claim.** A melee-maxed account trains Prayer on the troopers at about 3.8 Prayer XP per tick: it kills them only
  for their bones and buries each on the spot.
- **Conditions.** Three accounts at once, every melee skill 99, an adamant scimitar, sharks banked, Prayer 89.
  Trooper mode with `TRAIN_SKILL=Hitpoints GIANT_KILLS=500 GIANT_FOOD=20 GIANT_BURY=1`, cap 1,500 (the planner's
  `army-trooper-prayer-99`):

  | Account | Kills | Bones buried | Prayer XP | Ticks | Prayer XP per tick | Sharks eaten | Lowest HP |
  |---|---|---|---|---|---|---|---|
  | 1 | 54 | 54 | 6,075 | 1,584 | 3.84 | 0 | 78 |
  | 2 | 56 | 55 | 6,187 | 1,684 | 3.67 | 0 | 81 |
  | 3 | 59 | 58 | 6,525 | 1,680 | 3.88 | 0 | 89 |

  All three ended `RESULT ok` on the cap. Prayer 89 to 99 is about 500,000 XP at this server's rate, about 130,000
  ticks at this rate. The Hill Giant camp south of Ardougne has two giants in its room (`maps/m39_49.jm2`), so big
  bones there serve one account at most.
- **Evidence.** `.practice/troopers/prayer.ts` (`prayer.out`); `packages/planner/test/autopilot.test.ts` (a
  melee-maxed army account buries trooper bones).
- **Gap.** Practice only; one set of three. A faster bone source for many accounts at once is not found. Of the
  ticks a buried kill costs, about 4 go to the pickup and 2 to the bury; sending the pickup packet directly gave no
  gain (median 3.75 against 3.84 Prayer XP per tick).
- **Claim.** The trainer banks pack coins with its drops before every walk out, so a death on the field cannot lose
  them. **Conditions.** The same run from 5,000 coins in the pack, cap 400: `RESULT ok`, 8 kills, 2 bank trips; the
  pack held 0 coins and the bank 5,000 afterwards. **Evidence.** `.practice/troopers/coins.ts` and `peek.ts`;
  `scripts/gather-combat-giant.test.ts` (coins held at entry). **Gap.** One practice run; worn gear and carried
  arrows still ride to the field.
- **Claim.** The game drops an eat sent within 2 ticks of the last one, with no message. The trainer therefore
  spaces every eat of a run by 3 ticks, its own bites and the first eat of a walk's sustain, and eats up to its eat
  level before it walks out. **Conditions.** `consume.rs2` `player_consume_item` sets `%eat_delay` to
  `map_clock + 2` and returns on an eat at or under it. A small food shows it: cooked meat heals 3, so one bite leaves
  a low account under its eat level and the next eat follows at once. **Evidence.** Live claude-cloud: PocketPool
  started three trooper runs at low HP after a dropped session and each ended `quest sustain: food debit unobserved`
  within 28 ticks. `scripts/gather-combat-giant.test.ts` reproduces that error with an account at 30 of 75 HP on
  cooked meat, and with the spacing it takes three bites 3 ticks apart and none is dropped. **Gap.** Not rerun
  live. A practice save cannot set current HP, so no practice run starts low.

## The army's blade

- **Claim.** An army account that fights with a bronze sword gains a quarter to a third in maximum hit from an
  adamant scimitar, and the planner buys it one (`kit-buy:army-weapon`, before its Ranged band, two accounts away at
  a time).
- **Conditions.** `combat.rs2` `combat_maxhit`: (effective level x (64 + strength bonus) + 320) / 640, effective level
  107 on an accurate or defensive style and 110 on an aggressive one at Strength 99. Strength bonus: bronze sword 5,
  mithril sword 17, adamant sword 24, adamant scimitar 28, rune scimitar 44 (`melee/scimitars.obj`). That gives 12
  for the bronze sword, 15 or 16 for the adamant scimitar and 18 for the rune scimitar on the accurate style, all at
  the same attack rate. The trainer already wields the best blade an account owns.
- **Market (live claude-cloud read).** Adamant scimitar: 42 listed at 72,000, bids at 33,068, volume-weighted
  price 38,089. Rune scimitar: one listed at 567,227. Mithril scimitar: one at 49,999. No adamant or mithril sword
  or longsword is listed. The Varrock sword shop holds 2 adamant swords (one back per 12,000 ticks) and 3 mithril.
- **Evidence.** `packages/planner/test/autopilot.test.ts` (who buys, the order, two at a time). The trooper results on
  claude-cloud name the weapon: `"weapon":"Bronze sword"` on Deeppockets, Fatstack, KnightRider and PocketPool.
- **Live (claude-cloud).** Fingerblastr and Knightstick each bought one for 72,000 (`RESULT ok`, `acquired` 1,
  8,000 refunded). Fatstack's buy failed twice on the trip: its last run had been cut on the trooper field and the
  market travel found no route from 2529,3236.
- **Claim.** A market buy that starts on the Gnome battlefield first walks to the Ardougne north bank with
  auto-retaliate off, then makes its guarded trip. **Conditions.** The trip aborts on the first lost hit point, and a
  trooper hits an account that stands on the field: practice, from 2529,3236, `travel-abort` at tick 64 and `no route
  to 3185,3436,0`, as live. With the exit: three accounts from the same tile left the field in 90 ticks and reached
  Varrock West (`travel-returned` ok, 951 ticks from the start); the order was then placed and found no seller on
  practice. **Evidence.** `.practice/travel/ge.ts` (`f1`, `g1`-`g3`) in the Claude cloud container that ran them;
  `scripts/buy-owned-ge-item.test.ts`.
- **Claim.** A trip east from elsewhere in Kandarin (the Catherby, Seers' Village and Yanille banks, the battlefield)
  first walks to the Ardougne north bank, then takes the fare and the two ferries (`scripts/walk-to.ts`
  `walkWithFerryFallback`). **Conditions.** The eastbound ferry step knew only a start inside Ardougne; from anywhere
  else the pack held no fare and the planner found no route (live: UnderMyKilt's scimitar buy failed twice from
  2807,3441 near the Catherby bank). Practice with the walk home: a market buy from the Catherby bank reached Varrock
  West at tick 1,039, from the Seers' Village bank at 974 and from the Yanille bank at 1,041. **Evidence.**
  `.practice/travel/ge.ts` (`k1`-`k3`); `scripts/walk-to.test.ts`.
- **Claim.** A dragon weapon is refused to an account without Lost City, whatever its Attack. **Conditions.**
  `levelrequire.rs2` `levelrequire_zanaris_quest`: `%zanaris` under complete prints "You have not earned the right to
  wear this yet." and "You need to complete the Lost City Of Zanaris Quest." before the Attack 60 check. Practice, an
  account with Attack 99 and no quests: dragon longsword and dragon dagger not worn, rune scimitar worn; with varp 147
  at 6 all three are worn. **Evidence.** `.practice/lostcity/wield.ts` in the Claude cloud container that ran it.
  **Consumer.** `army-quest-lostcity` (research/quest-points-board.md, Lost City, from an army account's state).
- **Market and shop (live claude-cloud read).** No dragon longsword or dagger is listed (last trades 425,000 and
  299,000). Jakut in the Zanaris market stocks 2 dragon longswords and 2 daggers, one back per 500 ticks
  (`area_lostcity/configs/lostcity.inv`), base cost 100,000 and 30,000; the market door asks one cut diamond an entry
  (`doorman.rs2`) and the market ladder leaves to Al Kharid (`ladder_fairy.rs2`).
- **Claim.** One run brings dragon longswords from Jakut to the Al Kharid bank. **Conditions.**
  `scripts/shop-buyer.ts` profile `jukat`: the dramen staff, a diamond and the coins from the bank, the swamp shed,
  the market door from the west (3237,9558; the engine refuses a walk round it: a walk from the entry to Jakut
  stopped on 3237,9560), the doormen's dialogue, the shop, the ladder, the weapon the staff took the place of wielded
  again outside. The first sword costs 100,000 and one from an emptied shelf 101,000. **Evidence.** Bench
  `extra:shop-jukat` (three swords from Ardougne, a rune scimitar worn at the start and at the end).
- **Claim.** Other players empty Jakut's shelf on the live server, and a buy request sent each tick takes a
  restocked unit before a buyer that looks first. **Conditions.** A live run that looked every 15 ticks saw no sword
  for 600 ticks. `BLIND_BUY=1` sends one request a tick; the engine adds a restocked unit at the end of a tick and
  runs a buy when it reads the packet in the next. **Evidence.** Bench `extra:shop-jukat-rival-look`, `-blind`
  (two swords each against a second buyer) and `-ahead` (none against a blind buyer that logged in first).
- **Gap.** No live sword. `army-jakut-swords` buys a diamond on the market (1,219 listed from 145,000, cap 150,000)
  for an account with Lost City done and a dramen staff, then runs the visit with `BLIND_BUY=1`, a stock target of 2
  and 3,000 ticks of waiting with no buy. A visit that buys nothing still costs its diamond.
- **Gap.** No seller on practice, so a fill is proved live only. Kills per tick with each blade are not measured.

## Black dragonhide from Taverley's black dragons

- **Claim.** Black dragonhide armour has to be made: no market lists it and no shop sells it. **Conditions.** Live
  claude-cloud market read by item id (every colour of dragonhide shares the names "Dragonhide body", "Dragonhide
  chaps" and "Dragon vambraces"): black body 2503, chaps 2497 and vambraces 2491 unlisted, last trades about 313,000
  to 350,000, 250,000 to 300,000 and 120,000 to 145,000; black dragon leather 2509 never traded. Shops stock green
  only (`edgeville.inv`, `champions_guild.inv`). The hide (1747) drops from every black dragon and from nothing else
  bar the King Black Dragon (`drop tables/scripts/black_dragon.rs2`); the Al Kharid tanner makes leather of it for 20
  coins (`scripts/microbot-c-tanner.ts black`); vambraces, chaps and body ask Crafting 79, 82 and 84 and 1, 2 and 3
  leathers (`skill_crafting/configs/leather/leather.dbrow`, `scripts/microbot-production.ts`). Wearing it asks
  Ranged 70, and the body Defence 40 (`levelrequire/scripts/tier70.rs2`).
- **Claim.** A ranged account kills Taverley's black dragons from the corridor south of their cave and takes no
  melee. **Conditions.** `black_dragon` (npc 54): size 4, level 227, 190 hitpoints, Defence 200, ranged defence 50,
  respawn 60 ticks (`_unpack/225/all.npc`); two spawn, at 2829,9826 and 2835,9824 (`maps/m44_153.jm2`). A dragon
  attacks only a player beside it, one attack in four with fire (up to 30, or 50 on a failed roll; 5 behind an
  anti-dragon shield, 10 under Protect from Magic), and has no attack from a distance (`npc/scripts/dragon.rs2`). By
  the engine's collision rules a 4x4 mover reaches 29 south-west tiles in the cave and none in the corridor, which is
  three tiles wide (2834-2836, 9818-9821); from 2835,9820 the nearest dragon footprint is two tiles away
  (`scripts/black-dragon-camp.test.ts`). The row north of it is beside dragon ground: an account that stepped to
  2835,9821 fell from 96 to 22 hitpoints in 20 ticks, and one that stood east of the Obelisk ladder at 2843,9824 fell
  from 99 to 13 in 25.
- **Evidence (practice, 150 ms ticks, Ranged 99, magic shortbow on rapid, mithril arrows, nothing else worn).**
  `scripts/black-dragon-camp.ts` with `STAGED=1`, four kills a run: 1,339 and 1,465 ticks (335 and 366 a kill, with
  the fetch of each pile), 4 hides and 4 dragon bones each, `hpMin` 89 and 77, no food, 271 and 311 arrows (about 70 a
  kill net of the arrows taken back from the pile). Raw runs: `.practice/blackdragon/camp-run.ts` (`a`-`d`) in the
  Claude cloud container that ran them.
- **Claim.** The fetch of a pile is the camp's one exposure, and Protect from Magic bounds it. **Conditions.** The
  other dragon comes as near the camp tile as it can, which is beside the pile (south-west tile 2835,9823 against a
  pile on 2835,9822). `dragon.rs2`: one attack in four is a breath of up to 30, or 50 on a lost roll, and 10 under
  Protect from Magic; the rest is melee (Strength 200, about 21 at most). Under Protect from Melee, six kills:
  `DRAGON_CAMP hit t=595 hp=99->74 at=2835,9822 pray=1 by=["Black dragon@2835,9823"]`. The fetch runs under Protect
  from Magic and starts at 75 hitpoints or more, so three attacks cost at most 63. Three six-kill camps with it, two
  of them at once on the tile: 18 kills, 18 hides, `hpMin=99`. The camp logs every lost hitpoint (`DRAGON_CAMP hit`):
  a steady 4 to 6 every 30 ticks on the tile with no attacker is the poison of the spiders on the way in (one trip
  arrived at 89 and fell to 58 before its first kill, eating two sharks).
- **Claim.** An attack on a dragon that walks out of the tile's reach walks the account after it.
  **Conditions.** `DRAGON_CAMP stray t=1286 at=2834,9822 target=2828,9824 hp=99`: one step onto dragon ground in a
  six-kill camp, the target seven tiles west by then. The camp checks the target's tile every tick and ends the
  attack with a walk to its own tile when the dragon is out of reach; two six-kill camps after that, no stray.
  Raw runs: `.practice/blackdragon/camp-run.ts` (`hit`, `mag`, `st1`, `st2`).
- **Claim.** A shot at a dragon more than five tiles away can walk the shooter off its tile. **Conditions.** From
  2835,9820 the first shot at a dragon on 2828,9824, seven tiles west and in sight by the collision data, walked the
  account to 2834,9822. The camp shoots only a dragon whose south-west tile is within five tiles and in sight
  (`canShoot`); the dragon that spawns on 2835,9824 always is. With that rule, 1,339 ticks without a step off the tile.
- **Claim.** The way in is the dusty key gate, the blue dragon lair, out of the lair's south end and round by the
  black demons and the poison spiders. **Conditions.** `scripts/microbot-combat-trip.ts` `blackDragonEntry`: the
  Taverley ladder (1759 at 2884,3397), the gate (2623 at 2924,9803, dusty key 1590), then `BLACK_ENTRY`. The lair has
  no way straight west: a walk from 2895,9793 to 2850,9809 stopped at 2881,9810. The key cannot be traded;
  `scripts/dusty-key.ts` gets it (the Jailer, Velrak's cell, the dialogue): practice from the Ardougne north bank,
  `RESULT ok dustyKey=1`, 950 ticks, `hpMin=99`; from inside Zanaris (3220,9592), 589 ticks. The worker takes only
  Taverley dungeon's map squares for the dungeon: live, a run that started in Zanaris looked for the Jailer there.
- **Claim.** One bank-owned trip brings the hides home. **Conditions.** `scripts/black-dragon-camp.ts` without
  `STAGED`: the shared walker to the Falador west bank, then `combatTrip` kind `black` (everything worn and carried
  banked, the bow, 700 arrows, the key, one Varrock teleport's runes and 6 sharks taken), the ground walk to the
  Taverley ladder, the gate, the lair's south end, the corridor, the camp, the teleport and the Varrock West bank.
  Practice from the Ardougne north bank with `KILLS=3`: `RESULT ok black-dragon-trip kills=3 hides=3 bones=3
  ammoUsed=196 hpMin=90 banked=true ticks=1337` (628 more for the walk to Falador before it); staged at tick 26,
  down the ladder at 109, through the gate at 243, in the corridor at 318 with 90 hitpoints, banked at 1,336; the
  bank then held 3 black dragonhides and 3 dragon bones and the kit's debit matched to the rune. The trip must not
  start at a far bank with the kit packed: from the Ardougne north bank the shared planner took a Camelot teleport
  with the trip's law rune (and air from the bank), and the run made its three kills and could not leave. Raw runs:
  `.practice/blackdragon/trip-run.ts` (`a`-`d`).
- **Claim.** The trip needs prayer points and gets them itself. **Conditions.** The camp fetches a pile only under
  a protection prayer when a dragon stands within two tiles of it, and takes its arrows back from the pile. Live
  (claude-cloud, TrouserSnake, straight after Lost City, 215 arrows): `RESULT ok black-dragon-trip kills=1 hides=0
  bones=0 ammoUsed=176 hpMin=84 banked=true ticks=937`, `DRAGON_CAMP pile left at 2835,9822: no prayer and a dragon
  beside it`, no `stray` line. With fewer than 50 points (`BLACK_PRAYER`, about what nine kills use) the trip prays
  at the Altar of Guthix in Taverley (410 at 2925,3483) between the bank and the ladder. Practice from 0 points:
  prayed at tick 93, down the ladder at 146 (109 with no altar visit), `RESULT ok black-dragon-trip kills=3 hides=3
  bones=3 ammoUsed=185 hpMin=99 banked=true ticks=1323`. Raw run: `.practice/blackdragon/trip-run.ts` (`pray`).
- **Claim.** The way home is the Varrock teleport, clicked until the account is there, and an account found in the
  dungeon at a trip's start leaves by it first. **Conditions.** `teleport.rs2`: the spell's button does nothing, with
  no message, when the player is busy on the tick the click arrives. Live (claude-cloud, UnderMyKilt, 300 arrows):
  the altar visit at tick 123, `DRAGON_CAMP kill 1 t=208 ... arrows=233`, `kill 2 t=538 ... arrows=169`, `kill 3
  t=903 ... arrows=91`, no stray, `hpMin=99`, then `RESULT fail black-dragon-trip kills=3 hides=3 bones=3 ammoUsed=181
  hpMin=99 banked=false ticks=1321 failure=Error: combat emergency return missing`: one click, 20 ticks of waiting,
  and a logout on the camp tile with the loot and the teleport's runes in the pack. The trip clicks up to 6 times, 8
  ticks apart (`varrockTeleport`). `scripts/black-dragon-camp.ts` run for an account that stands underground
  teleports, banks its pack at Varrock West and then starts the trip; `LEAVE=1` ends there. Practice from the camp
  tile with three hides: `RESULT ok black-dragon-leave hides=3 bones=3 banked=true`, 31 ticks; without `LEAVE`,
  `RESULT ok black-dragon-trip kills=1 hides=1 bones=1 ... banked=true`. No walker plans a way out of the cave: a
  planned route can cross dragon ground. Raw runs: `.practice/blackdragon/leave-run.ts` (`a`, `b`).
- **Claim.** A hunter's arrows and teleport runes come from two Varrock shops in one run, and the run leaves a
  shelf it has emptied. **Conditions.** `army-hunt-supply` (`scripts/chain.ts`): `scripts/shop-buyer.ts lowe` to 1,200
  iron and 1,200 bronze arrows owned (`archeryshop`: 1,500 iron in stock, one back every 15 ticks; 2,000 bronze, one
  every 10), then `aubury` to 60 air and 60 fire runes, each banked at Varrock east. The first three runs below
  bought iron alone. Practice from the Varrock west bank, 60 arrows banked, three runs in a row on
  one shelf: (a) spend 12,000: 890 arrows for 11,984 coins in 260 ticks (3 coins an arrow from the full shelf, 18
  from a drained one), then 120 runes for 569 coins in 79; (b) spend 21,000 and a 25-tick wait: 822 arrows for 14,796
  coins in 2,523 ticks, the shelf at 0 and the run buying one arrow every 15 ticks until its cap; (c) a 10-tick wait
  on the empty shelf: 31 arrows, `stop=stock-wait noBuyTicks=10`, 119 ticks, then the runes in 77. With bronze
  arrows in the same step (`ITEMS=iron.arrow|bronze.arrow`, an 8-tick wait, spend 28,000), two runs in a row on fresh
  shelves: (d) 2,340 arrows (1,140 iron, 1,200 bronze) for 22,132 coins in 357 ticks, `stop=stock-target`; (e) 1,261
  arrows for 12,366 coins in 266 ticks, both shelves at 0, `stop=stock-wait noBuyTicks=8`. Raw runs:
  `.practice/huntsupply/run.ts` (`a`-`e`).
- **Claim.** Six banked hides become a set of black dragonhide armour in one run at Al Kharid, and any account
  with Ranged 70 and Defence 40 wears it. **Conditions.** `levelrequire/scripts/tier70.rs2`: the body asks Ranged 70
  and Defence 40, the chaps and vambraces Ranged 70, and none a quest (the green body alone asks Dragon Slayer,
  `tier40.rs2`). `leather.dbrow`: body 3 leather at Crafting 84, chaps 2 at 82, vambraces 1 at 79; the Tanner (804 at
  3276,3193) takes 20 coins a hide; Dommik (545 at 3322,3194) sells needles and thread. `scripts/black-dhide-sets.ts`
  on practice, Crafting 84: from the Al Kharid bank with 14 hides and 2,000 coins, `RESULT ok sets=2 banked=2
  bodies=2 chaps=2 vambraces=2 tanned=12 spent=243`, 230 ticks, Crafting 84 to 85 (25,800 XP); from the Varrock west
  bank with 20 hides and 300 coins, the one set the coins tan, `sets=1 ... tanned=6 spent=123 hidesLeft=14`, 374
  ticks, 201 of them the walk; at Crafting 83, `RESULT fail Crafting 83, a set asks 84` at tick 0. Raw runs:
  `.practice/dhide/run.ts` (`a`-`c`).
- **Claim.** A hunter reaches Crafting 84 on flax in about 10,000 ticks (estimate from the runs below). **Conditions.**
  Spinning gives 375 Crafting XP a flax at the server's rate, so 825 flax from level 54. Practice, a hunter-shaped
  account with Crafting 54 at the Varrock west bank: `army-leather-flax` (`scripts/gather-flax.ts`, 1,800 ticks)
  banked 338 flax, 975 of its ticks walking; `army-leather-spin` (`scripts/spin-bowstrings.ts`, `MAX_MAKE=168`) made
  168 bow strings in 901 and 925 ticks for 63,000 XP each. The spinning worker refused its own logout when run as a
  process of its own: the random event gate puts the session's `direct` back at settlement and the worker took that
  for another owner (`ACTION_SETTLEMENT_DEFERRED`, no RESULT line; the lockstep bench has no gate swap). With the
  swap allowed after cleanup began: `LOGOUT logged-out`, `RESULT ok ticks=205 made=28`. Raw runs:
  `.practice/dhide/level-run.ts` (`a`), `.practice/dhide/spin-run.ts` (`a`-`h`).
- **Claim.** Bronze arrows kill as well as iron from the camp, and two hunters at once use about 90 arrows a kill.
  **Conditions.** Practice, two accounts with Ranged 99 on the camp tile at once, each a whole trip from the Varrock
  west bank with a magic shortbow, 600 arrows and `KILLS=9`: on iron, `RESULT ok black-dragon-trip kills=6 hides=6
  bones=6 ammoUsed=600 hpMin=80 banked=true ticks=3844`; on bronze, `kills=7 hides=7 bones=7 ammoUsed=600 hpMin=56
  banked=true ticks=4494`. Both ended on their arrows. The bronze account's lost hitpoints are the spiders' poison
  from the way in (`DRAGON_CAMP hit` 2 to 3 every 30 ticks on the tile, `pray=0`), and the camp eats at 60. Raw
  runs: `.practice/blackdragon/arrow-run.ts` (`ir`, `bz`). One run each: not a rate.
- **Gap.** One live trip with loot, brought home by a second run (`LEAVE=1`); no live trip has banked its own loot,
  and neither the supply run nor the armour run has a live run. A player of another fleet on the tile, or another
  player's kill, is not run.
  Lowe's shelves give back 4 iron and 6 bronze arrows a minute at 0.6 s a tick, under what two hunters fire
  (about 1,200 arrows in 45 minutes, from the trips above); the other arrow shelves (Hickton's, Dargaud's) are not
  in the run.

## Ranged on the troopers

- **Claim.** On practice at xpRate 25, an army-shaped account trains Ranged 1 -> 63-66 on the Khazard troopers in about
  1,690 ticks (49.6-59.9 Ranged XP per tick) with a shortbow and iron arrows. It eats 0-2 sharks and uses about 5.4
  arrows per 1,000 XP, so 1 -> 99 needs about 5,400 iron arrows at that rate.
- **Conditions.** `scripts/gather-combat.ts <bot> 1500 trooper` with `TRAIN_SKILL=Ranged TARGET_LEVEL=99 GIANT_FOOD=10`
  (default `GIANT_AMMO=500`). TheFullMonty's shape: Attack 69, Strength 61, Defence 62, Hitpoints 62, Ranged 1, a bronze
  sword worn. A shortbow, 600 iron arrows and 30 sharks banked; start at the north bank. Three bots ran at once. Ticks
  include the walk out and the retreat.

  | Run | Kills | Ranged | XP | Ticks | XP per tick | Sharks eaten | Lowest HP |
  |---|---|---|---|---|---|---|---|
  | k | 52 | 1 -> 66 | 101,600 | 1,696 | 59.9 | 0 | 35 |
  | l | 41 | 1 -> 64 | 91,800 | 1,687 | 54.4 | 1 | 29 |
  | n | 43 | 1 -> 63 | 84,100 | 1,696 | 49.6 | 2 | 31 |

  A fourth run on the same code: 35 kills, 1 -> 62, 78,200 XP, 424 arrows used.
- **What the bow needed.** Each was a failure in an earlier practice set; the trainer handles it now.
  - From Ranged 1, every kill gives several levels, and the level-up dialog held the attack (337 of 681 ticks under one).
    The fight loop dismisses it and attacks again. This applies to melee too: Strength 60 -> 73 at 60.6 XP per tick,
    against 60.9-63.4 before.
  - A bow needs line of sight. One run stood 289 ticks on a trooper it could not hit, so a target with no own XP for
    40 ticks is given up.
  - A trooper killed by someone else (a gnome, another bot) never pays the XP the credit waits for, so it is let go.
    Live, TheFullMonty's first melee trooper run ended on the no-progress timeout after 32 kills (Strength 61 -> 70, one
    shark). So these release rules and the walk back to the spot apply to every trooper run, melee as well.
    Practice melee with them, three bots at once: 63, 58 and 51 kills, Strength 60 -> 72-74 at 56.0, 57.2 and 65.7 XP
    per tick, all ok.
  - A bot that stands to shoot drifted to the west edge with no trooper in view (two runs idled 307 ticks). After 10
    ticks without a target it walks back to the spot.
- **Live (claude-cloud).** TheFullMonty's first Ranged run went Ranged 1 -> 61 in 1,507 ticks: 34 kills, 74,800 XP
  (49.6 per tick), 409 bronze arrows, 3 sharks, lowest HP 34. Its retreat failed with a trooper still fighting
  (`bank retreat failed`), and the session then dropped on the battlefield. The account next logged in at Lumbridge.
  The retreat now turns auto-retaliate off, tries the walk up to three times while each ends closer, and turns it back
  on (`RETREAT ... autoRetaliateRestored=true`). Practice, three bots at a 700-tick cap: all ok, retreats of 83-200
  ticks.
- **Arrow supply.** Live, the GE has no iron or adamant arrows listed. It asks 746 for mithril and 10,000 for rune, and
  Aemad's Ardougne shop holds 450 bronze (the planner's source, below). The shops hold more (`scripts/shop-buyer.ts` profiles; practice, 100 each):
  - `lowe` (Varrock): bronze 2,000, iron 1,500, steel 1,000 in stock. 100 iron for 399.
  - `catherby_arrows` (Hickton): bronze 1,000, iron 800. 100 iron for 399.
  - `dargaud` (Ranging Guild, Ranged 40 at the door): every arrow to rune (mithril 500, adamant 450, rune 400 in stock)
    and willow shortbows. 100 mithril for 4,711; 100 rune and 100 adamant for 71,600, about 600 a rune arrow. Below
    Ranged 40 the door holds and the run ends `RESULT fail` at its cap.
- **Evidence.** `.practice/trooper-ranged/` and `.practice/arrow-shops/` in the Claude cloud container that ran them.
- **Gap.** Practice only. The rate above Ranged 66 is not measured, and better bows and arrows (willow to yew,
  mithril to rune) are not in the army's hands. At the cap a trooper still fighting holds the retreat about 100 ticks.

### Fired arrows taken back

- **Claim.** The bow trainer takes its fired arrows back after each kill. It loses about two fifths as many arrows
  for the same XP (median 1.90 against 4.90 per 1,000 XP) at about 15% less XP per tick (median 44.7 against 52.3).
- **Why it works.** A fired arrow lands on the target's tile four times in five (`player_ranged.rs2`
  `ranged_dropammo_npc`, `^dropammo_chance` 5) and lies there 200 ticks (`^lootdrop_duration`), one stack a tile for
  its owner (`World.addObj`). A trooper closes on the archer, so most of a fight's arrows lie on one or two tiles.
- **Conditions.** Practice at xpRate 25. `scripts/gather-combat.ts <bot> 1500 trooper` with `TRAIN_SKILL=Ranged
  TARGET_LEVEL=99 GIANT_FOOD=10`, no burying. Attack 69, Strength 61, Defence 62, Hitpoints 62, Ranged 1; a shortbow,
  600 bronze arrows and 30 sharks banked; start at the north bank. Three bots at once for each condition.
  `GIANT_AMMO_PICKUP=0` turns the pickup off. Arrows lost is the owned count before less the owned count after.

  | Pickup | Run | Kills | Ranged | XP | Ticks | XP per tick | Arrows lost | Taken back | Lost per 1,000 XP |
  |---|---|---|---|---|---|---|---|---|---|
  | off | n1 | 40 | 1 -> 63 | 87,000 | 1,659 | 52.4 | 408 | 0 | 4.69 |
  | off | n2 | 32 | 1 -> 60 | 69,100 | 1,585 | 43.6 | 405 | 0 | 5.86 |
  | off | n3 | 38 | 1 -> 63 | 82,600 | 1,578 | 52.3 | 405 | 0 | 4.90 |
  | on | q1 | 29 | 1 -> 59 | 65,000 | 1,582 | 41.1 | 131 | 250 | 2.02 |
  | on | q2 | 35 | 1 -> 62 | 77,500 | 1,660 | 46.7 | 52 | 297 | 0.67 |
  | on | q3 | 32 | 1 -> 60 | 70,700 | 1,583 | 44.7 | 134 | 237 | 1.90 |

- **The rule.** After a kill it takes at most 2 stacks of 3 or more arrows within 3 tiles, the largest first, and puts
  arrows back in the quiver only when it holds fewer than 50. With the quiver empty, and once more before it leaves
  the field, it takes any stack. A pick costs 3-5 ticks whatever it holds: in two instrumented runs 12 of 30 picks
  brought 14 of 247 arrows. Taking every stack and re-equipping after every kill gave 34.1, 39.6 and 43.3 XP per tick
  for 1.81, 1.59 and 0.70 arrows lost per 1,000 XP: slower for little more.
- **Evidence.** `.practice/arrows/` (`run.ts`, sets `n1-n3`, `q1-q3`, `p1-p3`, `d1-d2`) in the Claude cloud container
  that ran them; `scripts/gather-combat-giant.test.ts` (the stack choice).
- **Gap.** Practice only, three accounts on the field, no burying. The rate with 12 accounts and burying is not
  measured. Arrows fired at a trooper the trainer lets go lie where they fell until a later kill is near them.

### The first arrows

- **Claim.** An army account buys its Ranged band's arrows at Aemad's shop in East Ardougne (`army-arrows-ardy`:
  `scripts/shop-buyer.ts <bot> ardy 400` with `ITEMS='bronze arrow' STOCK_TARGET=500 BANK_AT=0`), and the Ranged
  template then starts from the south bank where the shop run ends.
- **Conditions.** Practice. The account above at the north bank with 50,000 coins, a shortbow, 25 bronze arrows and 30
  cooked meat banked. The shelf holds 500 bronze arrows and gives one back every 10 ticks (`adventurershop`), shared
  by every player. Each shop run was followed by the Ranged template at a 700-tick cap.

  | Run | Shelf | Bought | Ticks | Coins | Stop | Ranged run after it |
  |---|---|---|---|---|---|---|
  | s4 | full | 475 | 161 | 2,166 | stock-target | ok, 5 kills, 82 lost, 94 taken back |
  | s3 | emptied | 141 | 433 | 846 | cap | ok, 8 kills, 49 lost, 110 taken back |
  | s5 | emptied | 164 | 438 | 984 | cap | ok, 10 kills, 37 lost, 122 taken back |

  Every shop run ended `RESULT ok` with the arrows banked. An arrow costs 4.6 coins from a full shelf and 6 from an
  emptied one.
- **What the shop run needed.** With the default `BANK_AT` it banked after every 100 arrows (373 ticks for 475). At
  its cap it skipped the last bank trip and logged out with the arrows in the pack; the last trip now runs past the cap.
- **Estimate.** At 1.90 arrows lost per 1,000 XP and 44.7 XP per tick an archer loses about 510 arrows in 6,000
  ticks. The shelf gives back 600 in that time, so this shop carries about one archer once its first 500 are sold.
- **Evidence.** `.practice/arrows/shop.ts` and its `s3`, `s4`, `s5` logs in the Claude cloud container that ran them;
  `packages/planner/test/autopilot.test.ts` (the band order, one account at the shop).
- **Gap.** Practice only. The Ranging Guild shelf (Ranged 40) and Hickton's are not in the planner.
- **Claim.** A second account short of arrows buys them at Lowe's in Varrock (`army-arrows-lowe`:
  `scripts/shop-buyer.ts <bot> lowe 2500` with `ITEMS='iron arrow|bronze arrow' STOCK_TARGET=1000 BANK_AT=0`), and
  the Ranged template then walks back from Varrock East and trains with the iron arrows.
- **Conditions.** Practice. The same account at the Ardougne north bank, three at once on one shelf (bronze 2,000,
  iron 1,500). Each shop run was followed by the Ranged template at a 1,600-tick cap.

  | Run | Bought | Coins | Shop run ticks | Stop | Ranged run after it |
  |---|---|---|---|---|---|
  | l1 | 1,107 | 10,797 | 1,431 | stock-wait | ok, 29 kills, Ranged 1 -> 59, 114 iron arrows lost, 233 taken back |
  | l2 | 1,110 | 10,879 | 1,533 | cap (1,500) | ok, 33 kills, Ranged 1 -> 61, 109 lost, 240 taken back |
  | l3 | 1,327 | 12,267 | 1,506 | stock-wait | ok, 24 kills, Ranged 1 -> 57, 147 lost, 213 taken back |

  The three emptied the shelf. Each trip out stood about 300 ticks while the world loaded, 100 on each ferry and 400
  at the Port Sarim dock, where the first plan to Varrock East found no route and the second did
  (`WALK_RETRY try=1 ... no route to 3253,3420,0`). The trip back took 842-916 ticks, inside the Ranged run's food
  stage.
- **Evidence.** `.practice/arrows/shop2.ts` and its `l1`-`l3` logs in the Claude cloud container that ran them;
  `packages/planner/test/autopilot.test.ts` (one account at each shop).
- **Gap.** Practice only. Why the first plan from the Port Sarim dock to Varrock East fails is not found.
- **Claim.** Hickton's shop in Catherby is the nearest large shelf: a walk from Ardougne with no ferry
  (`army-arrows-catherby`: `scripts/shop-buyer.ts <bot> catherby_arrows 600`, the same settings as Lowe's).
- **Conditions.** Practice, the same account from the Ardougne north bank; shelf bronze 1,000 and iron 800. The
  Ranged template followed each shop run.

  | Run | On the shelf | Bought | Coins | Shop run ticks | Stop | Ranged run after it |
  |---|---|---|---|---|---|---|
  | h4 | alone | 1,791 | 14,963 | 526 | stock-wait | ok, 10 kills, Ranged 1 -> 44, iron arrows |
  | h1 | one of three | 710 | 5,341 | 285 | stock-wait | ok, 11 kills, Ranged 1 -> 44 |
  | h2 | one of three | 561 | 4,902 | 359 | stock-wait | ok, 15 kills, Ranged 1 -> 49 |
  | h3 | one of three | 685 | 6,177 | 1,222 | cap (1,200) | ok, 12 kills, Ranged 1 -> 45 |

  h3 stood on the emptied shelf to its cap for one arrow every 10 to 20 ticks, so the job's cap is 600. The walk back
  to the north bank took 139-302 ticks, inside the Ranged run's food stage.
- **Claim.** An account at Ranged 40 buys a willow shortbow and arrows up to mithril at the Ranging Guild
  (`army-arrows-guild`, two shop runs in one `scripts/chain.ts` job) and then trains with them.
- **Conditions.** Practice, the same account at Ranged 45, three at once on one shelf (bronze 1,000; iron, steel and
  mithril 500 each). The door refuses under Ranged 40.

  | Run | Bow | Arrows bought | Coins | Arrow run ticks | Ranged run after it |
  |---|---|---|---|---|---|
  | v2 | 1 for 202 | 1,143 (mithril 253, steel 251, iron 249, bronze 390) | 42,291 | 639 | ok, 28 kills, Ranged 45 -> 61, mithril arrows |
  | v3 | 1 for 200 | 1,233 (mithril 252, steel 257, iron 249, bronze 475) | 44,086 | 531 | ok, 24 kills, Ranged 45 -> 61, mithril arrows |
  | v1 | 1 for 200 | 289 (mithril 10, steel 14, iron 45, bronze 220) | 4,929 | 888, cap | ok, 2 kills, `stop=ammo` on its 10 mithril arrows |

  v1 came last to an emptied shelf. Its Ranged run took the 10 mithril arrows and ended on ammo, so the trainer now
  takes the best kind it holds 50 of, else its largest stack (`selectGiantArrows`). Each run logged two or three
  `WALK fail ... walk rejected` lines at the guild door and went on.
- **Evidence.** `.practice/arrows/shop3.ts` and its `h1`-`h4`, `v1`-`v3` logs in the Claude cloud container that ran
  them; `packages/planner/test/autopilot.test.ts` (one account at each shop, the guild first from Ranged 40);
  `scripts/gather-combat-giant.test.ts` (the arrow choice).
- **Gap.** Practice only. The shelves together give back about 3,700 arrows in 6,000 ticks (Aemad 600, Hickton 900,
  Lowe 1,000, the guild 1,150): an estimate of about seven archers at 510 lost each.

## Sharing stock between army accounts

- **Claim.** The fourteen claude-cloud accounts hold what the others lack (`fleet/snapshots/` on `fleet-data`):
  TheFullMonty (Magic 99) a staff of fire and 500 fire, 374 mind and 757 air runes; TrouserSnake and UnderMyKilt about
  30,000 feathers and about 900 nature runes beyond their own casts; Fingerblastr, Deeppockets and Fatstack 6.1M-8.4M coins
  each. Every adopted account banks a bronze sword, a wooden shield, a shortbow, 25 air and 15 mind runes.
- **Conditions.** A transfer is a fleet order (`scripts/fleet-order.ts`, run by `scripts/fleet-trade.ts`). Its default
  meeting pair is Varrock West, a ferry round trip for an Ardougne account. `MEET=2619,3332` meets at the Ardougne north
  bank instead (`scripts/coin-courier.ts` `meetingTiles`: tiles 2618,3333 and 2617,3333).
- **Evidence.** Practice: two bots walked from the goldfarm knights to that pair, and each opened the bank from its
  tile (`.practice/meet/` in the Claude cloud container). Unit: `scripts/fleet-order.test.ts`.
- **Gap.** `fleet-trade.ts` refuses a local server, so no trade ran at this pair on practice; the exchange itself is the
  one proved live at Varrock West.

## Fresh accounts: cows from Hitpoints 10, Magic from 1

Ten Claude-cloud accounts hold Thieving 99 and 0.5M-8.4M coins; seven of them have every combat skill at 1 and
Hitpoints 10 (`fleet/snapshots/` on `fleet-data`).

- **Claim.** A fresh account runs the army cow band as it is. Practice, `scripts/gather-combat.ts <bot> 3000 cow` with
  `COW_STAGE=1 TRAIN_SKILL=Strength COW_BANK_PROFILE=north MAX_KILLS=8`, started at the goldfarm knights with the bronze
  sword, wooden shield and food banked: 7 of 7 `RESULT ok` with 8 kills, Strength 1 -> 28, 550-659 ticks, at most one
  bite eaten, lowest HP 6, no deaths. Four runs held trout and three held cake only; the last six ran three at once.
- **Claim.** A fresh account reaches Low Alchemy (Magic 21) from the bank with no damage. From the tile 2621,3327, north
  of the Ardougne north bank, the Guard dog (id 99, combat 44) behind the mansion fence takes Wind Strike and cannot
  reach the caster. `scripts/alch-train.ts` casts there below Magic 21 (`strikeStart`), 1 mind and 1 air rune and 137 XP
  a cast, then walks back and alchs.

  | Run | Accounts at once | Magic | Wind Strikes | Low Alchemy | Ticks | Hitpoints |
  |---|---|---|---|---|---|---|
  | j | 1 | 1 -> 31 | 19 | 6 | 258 | 10 -> 13 |
  | k | 2 | 1 -> 31 | 19 | 6 | 415 | 10 -> 13 |
  | l | 2 | 1 -> 31 | 19 | 6 | 338 | 10 -> 13 |

  Ticks include the walk from the knights and the bank stage.
- **Limits found.**
  - Inside the yard the dogs reach the caster: from 2629,3329 and 2624,3322 two casts cost 3 and 6 of 10 HP. The
    trainer stands only on 2621,3327, casts only at a dog it cannot reach, and walks back on any lost Hitpoint.
  - One player at a time can fight the dog. Of three accounts at once, one landed no cast in 200 ticks, in each of three
    sets; the other two took 228-394 ticks. The planner gives the tile to one account (`STRIKE_TILE`, capacity 1).
- **Evidence.** `.practice/starter/` in the Claude cloud container that ran them.
- **Gap.** Practice only.

## Magic by a curse over the fence

Three army accounts hold Magic 21 and no fire rune (`fleet/snapshots/claude-cloud.json` on `fleet-data`). The alchemy
band needs fire for every cast, and the Magic Guild in Yanille, which sells fire runes, a staff of fire and nature
runes, asks Magic 66.

- **Claim.** A stat-lowering spell gives its experience on every cast, hit or miss, and does no damage.
  **Conditions.** `player_magic.rs2` `pvm_default_spell`: the runes go and the experience comes (`pvm_spell_cast`)
  before the hit roll. Curse (Magic 19) costs 1 body, 2 water and 3 earth runes for 725 experience at xpRate 25; Weaken
  (11) and Confuse (3) cost 1 body, 3 water and 2 earth for 525 and 325; Wind Strike (1) 1 mind and 1 air for 137.
  On this server's curve Magic 66 is 100,775 experience: 135 curses from Magic 21, 144 casts from Magic 1 (2 strikes,
  then Confuse, Weaken and Curse), at most 142 body, 291 water and 420 earth runes.
- **Claim.** A cast that hits closes the target to the same spell until the stat grows back, one level every 100
  ticks. **Conditions.** `pvm_debuff_allowed` refuses a cast on a monster whose stat is under its base ("Your foe's
  defence has already been weakened."), with no rune taken; a monster regrows one level every `regenrate` ticks
  (engine `NpcType`, default 100). A cow's magic defence roll is 430 (level 1, bonus -21), so with no armour 9 casts
  in 10 hit at Magic 21. Practice, 40 curses on one cow with no armour: 12 cast, 28 refused, 282 ticks.
- **Claim.** From the tile south of the Ardougne cow field's fence a cast reaches the cows and no cow reaches the
  caster. **Conditions.** 2664,3339, 47 tiles from the north bank. The field holds ten cows (`maps/m41_52.jm2`); a
  cow's footprint comes no nearer than two tiles to the tile (`scripts/splash-train.test.ts` recomputes it with the
  engine's step rule). The run casts at the nearest cow in reach and in sight that it has not cast at or been refused
  on for 25 ticks, and waits when there is none. Practice, no armour, hitpoints 99 of 99 in every run:

  | Run | Accounts | Magic | Casts | Refused | Ticks | Ticks per cast |
  |---|---|---|---|---|---|---|
  | `j` | 1 | 21 -> 66 | 135 | 218 | 2,085 | 15.4 |
  | `i` | 2 at once | 21 -> 66 | 135 | 453 | 4,011 | 29.7 |
  | `h` | 2 at once | 1 -> 65 (tick cap 4,000) | 138 | 458 | 4,043 | 29.3 |

  The ticks are the whole job: the bank, the walk both ways and the casts. Two accounts at once make the same casts
  per tick as one: the cows' regrowth is the limit, about one cast in ten ticks for the field.
- **Evidence.** `.practice/splash/run.ts` (`h`, `i`, `j`), `.practice/splash/probe2.ts` (the fence tile, ranges 5 to
  9), `.practice/splash/probe.ts` (a cow with no armour) in the Claude cloud container that ran them.
- **Claim.** The band starts with ten casts' runes and casts what the account holds; a buy or a send brings what its
  level still casts. **Conditions.** `army-splash-magic-66` needs `SPLASH_START` (10 body, 30 earth, 30 water runes:
  ten casts of any of its spells, the casts of the last level) and `splashKit(level)` sizes the kit buy, a send and
  what the account keeps of its own runes (135 curses from Magic 21, 42 from 61, ten from 65). The run takes from the
  bank the runes its plan needs, as far as they go, and a batch that ran out of runes after a gained level ends `ok`.
  A water shop run is for an account under the start's 30 water runes. A whole kit as the start need held back three
  live accounts that could cast: Magic 61 with 258 water runes (84 needed), Magic 65 with 50 (20 needed) and Magic 21
  with 200. **Evidence.** `packages/planner/test/autopilot.test.ts` (the curse band); the planner replayed on the
  `claude-cloud` snapshot gives the first two the fence. **Gap.** No live run from a part kit.
- **Claim.** From Magic 66 the Magic Guild's shelf is the whole kit of the alchemy band, and the band casts on air
  runes. **Conditions.** `magic_guild.inv`, `runes.obj`, `staves.obj`: a staff of fire (2 in stock, base 1,500
  coins), nature runes (1,000, base 20, one back every 300 ticks), air runes (3,000, base 4); alchemy refuses only
  coins and a few quest items (`alchemy.rs2`). `army-staff-guild` buys the staff, 500 fire runes, nature runes up to
  600 and air runes up to 600; `army-alch-air-magic-99` casts with `ALCH_ITEM=airrune`. Practice from the Ardougne
  north bank, Magic 66, 100,000 coins and no rune of the band: the trip's four steps ended ok in 327, 226, 411 and 240
  ticks (1 staff for 1,500 coins, 500 fire runes for 6,714, 585 nature runes for 44,950, the step's budget, 600 air
  runes for 9,117), then `RESULT ok alch level=99 gained=33 xp=898625 strike=0 low=0 high=553 stop=target
  ticks=3809`. **Evidence.** `.practice/guild/run.ts` (`a`).
- **Claim.** A live run stops when no cow takes a cast, and that ends its batch, not the band. **Conditions.** Live
  (claude-cloud, two accounts at the fence): Magic 21 to 58 and 21 to 36, then each `RESULT fail ... stop=no cast in
  300 ticks`. A run that gained a level and stopped so, or out of runes or ticks, ends ok (`splashBatchDone`), and its
  RESULT carries `cows= reach= players= said=` from the stop. Why no cow took a cast there is not read yet.
- **Gap.** Practice only for a full 21 to 66, one run per condition. More than two accounts at once is not measured. The guild's nature
  shelf holds 1,000 and a trip takes 585, so it serves two accounts in a row at most; five army accounts hold no
  nature rune. With a platebody,
  platelegs, a full helm and a kiteshield of any metal the magic attack bonus is -65 and no cast hits (5 runs, 152
  casts, none refused, about 5 ticks a cast inside the field); the army owns none of those pieces, and the Grand
  Exchange lists one platebody.

## Magic and Prayer from the army's home bank

The tribrid target also needs Magic and Prayer at 99. The claude-cloud army holds Magic 48-62 and Prayer 47-76.
TrouserSnake and UnderMyKilt hold about 15,000 feathers and 1,500-1,700 bones each, and every army account holds 1-4.7M coins
(`fleet/snapshots/claude-cloud.json` on `fleet-data`).

- **Claim.** Alchemy on feathers is the fastest Magic the army can buy: 1,625 Magic XP per High Alchemy cast (65 base at
  xpRate 25) and 775 per Low Alchemy cast (31 base). From Magic 50 to 99 that is 18 Low and about 594 High Alchemy casts,
  about 4,000 ticks at the measured 6.5-7 ticks per cast. A feather is worth 2, so High Alchemy pays 1 coin for it,
  and the cost is the nature runes (1 per cast) plus 5 fire runes per cast, or nothing for fire with a fire staff
  (Zaff, Varrock, stocks 2).
- **Conditions.** Practice, xpRate 25. `scripts/alch-train.ts` started at the Ardougne market knights (the goldfarm spot)
  with a sword and lobsters in the pack. It walked to the north bank, banked the pack, took the supplies and cast there.

  | Run | Magic | Casts (Low / High) | Fire | Ticks | Magic XP per tick |
  |---|---|---|---|---|---|
  | 1 | 50 -> 60 | 18 / 13 | runes | 257 | 136.5 |
  | 2 | 50 -> 60 | 18 / 13 | runes | 257 | 136.5 |
  | 3 | 55 -> 75 | 0 / 88 | staff of fire | 614 | 232.9 |

  The worker in place: 20 High Alchemy casts at Magic 55, 130 ticks (6.5 per cast, 250 XP per tick); 5 Low Alchemy casts
  at Magic 50, 28 ticks.
- **Claim.** Burying the held bones from the north bank takes TrouserSnake Prayer 74 -> 84 and UnderMyKilt 76 -> 84
  (112.5 XP per bone). Practice: `scripts/train-prayer.ts` at the north bank, Prayer 74 -> 75, 113 bones in 251 ticks
  (2.2 ticks per bone with banking), so about 3,700 ticks per account. With `BURY_HELD=1` from the market knights it
  walked to the north bank, buried 114 of 120 bones (6 kept) in 282 ticks and ended ok at Prayer 75 when they ran out.
  From the Gnome battlefield (2525,3242), where a trooper run that lost its session stops, the world walker took it to
  the north bank. It buried 114 of 120 bones in 333 ticks and ended ok at Prayer 75.
- **Evidence.** `.practice/magic-alch/` and `.practice/army-prayer/` in the Claude cloud container that ran them.
- **Gap.** Practice only. The level-up dialog drops a spell sent under it. The trainer clears it between the Low and
  High Alchemy phases. The worker waits 1-2 ticks more per cast than the 5-tick High Alchemy cycle
  (`alchemy.rs2` `p_delay(3)`).
- **Live first runs (claude-cloud).** Quickhandjob's first full alchemy run went Magic 62 -> 88 in 1,601 ticks (250
  High Alchemy casts, `stop=supplies` when its 1,253 fire runes ran out). Quickhandjob's first `BURY_HELD` run buried 118 of 124 bones and ended ok at
  Prayer 47 -> 53 (`gained=6`). UnderMyKilt's alchemy stage took 598 natures, 598 feathers and 404 fire runes. Its first
  two runs failed: it started in Varrock after a fire-rune buy, and the planner has no westbound land route from Varrock
  West to the north bank (practice: "no route to 2619,3332,0"). The stages walk with `walkTargetPersist`, which retries a
  leg from where it stopped while it gets closer. The ferry fallback now starts in Varrock too: Draynor, Port Sarim,
  Karamja, Ardougne. Practice from Varrock West with 200 coins in the pack: north bank reached and Magic 50 -> 52 in
  820 ticks. The ferries need 60 coins in the pack.
- **A walk that starts on a ferry's deck crosses the gangplank first.** Each ferry lands on its ship's deck, level 1
  (Brimhaven 2775,3234; Port Sarim 3032,3217; Ardougne 2683,3268; Musa Point 2956,3143; `knowledge/npc-travel.json`
  `deck`), and the walk crosses the gangplank next. A session cut between the two starts its next walk on the deck,
  and the planner has no route from there. Live (claude-cloud): Kiltlifter stood on the Brimhaven deck until it was
  moved by hand to 2772,3234. Practice, a bot placed on the Brimhaven deck: `no route to 2772,3225,0` at tick 0.
  `goTo` (`packages/core/src/walk.ts` `leaveDeck`) takes the gangplank when the account stands on level 1 within 3
  tiles of one: from each of the four decks `WALK_DECK ... crossed ground at=...` and the walk arrived (4, 56, 54 and
  18 ticks to targets near each dock). Raw runs: `.practice/dhide/deck-probe.ts`. Gap: not run live.
- **Between Ardougne and the east, both ways.** The route planner takes the two ferries itself when the pack holds the
  60-coin fare (eastbound Ardougne -> Brimhaven, then Musa Point -> Port Sarim; 7 legs). With no coins it returns "no
  route" (live, every Grand Exchange kit buy from Ardougne: `no route to 3185,3436,0`) or a route up the Ardougne
  castle stairs that cannot be walked (practice: `walk rejected 3 times`). So `walkWithFerryFallback`
  (`scripts/walk-to.ts`) fetches the fare from the nearest bank before the first plan (`bankFare`), and keeps the fixed
  ferry corridor for a plan that still finds no route. `ferryWalk` carries it into `walkTarget`, fleet trades, the
  Grand Exchange purchase script, the trooper trainer and the Prayer trainer. Practice, accounts with Hitpoints 10:

  | Start | Target | Pack coins | Bank coins | Result | Ticks |
  |---|---|---|---|---|---|
  | Ardougne north bank | Varrock West | 60 | 0 | arrived | 750 |
  | 2584,3293 (Ardougne) | Varrock West | 60 | 0 | arrived | 664 |
  | 2653,3300 (knights) | Varrock West | 60 | 0 | arrived | 635 |
  | 3071,3347 | Ardougne bank meeting tile | 60 | 0 | arrived | 621 |
  | Ardougne north bank | Varrock West | 0 | 500 | arrived, fare fetched first | 666 |
  | Ardougne north bank | Varrock West | 0 | 0 | refused: `ferry needs 60 coins and the bank holds 0` | 10 |
  | 2615,3332, pack full (22 flax, 6 cake slices) | Varrock West | 0 | 11,000 | arrived, one flax banked for the fare's slot | 667, 668, 864, 865 |

  A full pack with no coin stack has no slot for the fare: the withdrawal fails and the walk ends `ferry needs 60 coins
  and the bank holds 11000` (live, a fleet trade; practice, 46 ticks). `bankFare` banks one item of the kind that
  fills the most slots first (`fareSpare`). Of five such trips one ended `no route to 3182,3440,0` on the Port Sarim
  dock after both ferries, and two took the whole 45,000 ms of their first search and went by the fixed corridor. The
  last leg alone, from the dock with a bank snapshot, planned in under 4 seconds in six runs. A failed search prints
  `WALK_NO_ROUTE` with its start tile, its time and its budget. Evidence: `.practice/fare/run.ts`, `dock.ts`, `leg.ts`.
  Gap: the cause of the dock's `no route` (live: 44 at 3029,3217,0) is not found.

  Each trip includes about 300 ticks of world loading at the 150 ms practice tick. A trooper run that starts at Varrock
  West with no coins in the pack and 500 banked ended `RESULT ok` twice (41 and 36 kills, 2,283 ticks each, the trip
  included). Evidence: `.practice/goldfarm-travel/east.ts`, `plan.ts`; `.practice/troopers/shape.ts`;
  `scripts/walk-to.test.ts`. Gap: practice only; the purchase after the trip needs the Grand Exchange service and is
  not practised; the planner's unwalkable route with no coins remains.
- **Magic Guild store (Yanille, upstairs, Magic 66 at the door).** It stocks fire runes 3,000, nature runes 1,000
  (base 20), law, death and blood runes 1,000 each, and 2 staffs of fire, on shelves separate from Zaff's and Aubury's.
  Profile `magic_guild`; shop-buyer walks to an upstairs shop with the world walker. Practice at Magic 99 from the
  Yanille bank: a staff of fire, 100 fire and 100 nature runes for 4,999 coins in all, `RESULT ok` in 193 ticks.
  Below Magic 66 the planner finds no route and the run ends `RESULT fail` at its cap. Live, the GE fills about 80 fire
  runes per order at 100 or less, and Aubury gives 35-42 a visit.
- **Supply (live market, claude-cloud read).** Nature runes ask 250 with 230,923 listed, so 612 natures cost about 153,000.
  Fire runes rose from 91 to 200 after 187 bought, and no fire staff is listed. Aubury's shop sells 2,000 fire runes
  at base 4 (`varrock.inv` `runeshop`; profile `aubury`, `ITEMS='fire rune'`). Zaff sells staffs of fire: practice,
  `MAX_ITEMS=1 bun scripts/shop-buyer.ts <bot> zaff` from Varrock West bought one for 1,500 coins in 45 ticks and banked
  it. Zaff stocks 2, with 1 back per 1,000 ticks.
- **Claim.** An army account with the alchemy band's nature runes and feathers but no fire buys a staff of fire at
  Zaff's from Ardougne and trains with it (`army-staff-zaff`, then `army-alch-magic-99`). **Conditions.** Practice.
  Attack 69, Strength 61, Defence 62, Hitpoints 62, Magic 21 at the Ardougne north bank with 50,000 coins, 60 nature
  runes and 200 feathers banked. `scripts/shop-buyer.ts <bot> zaff 3000` with `ITEMS='staff of fire' STOCK_TARGET=1
  BANK_AT=0`; the shop run takes the two ferries (`scripts/walk-to.ts` `walkTarget`). The alchemy template then starts
  at Varrock West, where the shop run banked.

  | Run | Staff | Coins | Shop run ticks | Alchemy run after it |
  |---|---|---|---|---|
  | z1 | 1 | 1,500 | 914 | ok, Magic 21 -> 56, 60 casts, 1,325 ticks, `stop=supplies` |
  | z2 | 1 | 1,500 | 916 | ok, Magic 21 -> 56, 60 casts, 1,259 ticks, `stop=supplies` |
  | z3 | 1 | 1,530 | 915 | ok, Magic 21 -> 56, 60 casts, 1,259 ticks, `stop=supplies` |

  Each shop run stood about 300 ticks at the start while the world loaded and 100 on each ferry. The alchemy run's
  ticks include the trip back to Ardougne. **Evidence.** `.practice/staff/run.ts` and its `z1`-`z3` logs in the
  Claude cloud container that ran them; `packages/planner/test/autopilot.test.ts` (the kit buy leaves the fire line
  to the shop job; the job's needs). **Gap.** Practice only. Zaff's shelf serves one account per 1,000 ticks once its
  2 staffs are sold; the Magic Guild's 2 are not in the planner.
- **Claim.** On an empty shelf the shop run waits for the staff to come back (`NO_BUY_TICKS=1100`, `STALL_TICKS=0`).
  **Conditions.** Practice, three accounts at once from Ardougne on a shelf of 2. Two bought on arrival (713 ticks
  each). The third logged `SHOP_NONE` with a count of 0, stood 255 ticks at the shop and bought the staff that came
  back: `RESULT ok`, `boughtTotal=1`, 969 ticks. **Evidence.** `.practice/staff/` `w1`-`w3` in the Claude cloud
  container that ran them. **Gap.** The session's idle guard ends a wait at 900 ticks unless `STALL_TICKS=0`.
- **Claim.** Live, Zaff's shelf does not serve the army: another player takes each staff as it comes back, so
  `army-staff-zaff` is a pilot, off unless a plan names it. **Conditions.** claude-cloud, five visits in about an
  hour by UnderMyKilt and Fingerblastr: every `SHOP_NONE` read `"Staff of fire","count":0,"price":1500`, the last after
  a wait of 1,100 ticks (`RESULT ok ticks=1145 boughtTotal=0 stop=stock-wait`). **Evidence.** The cloud side's swarm
  logs for those accounts. **Gap.** The Magic Guild's shelf (2 staffs, Magic 66 at the door) and Aubury's fire runes
  are not tried live; no account under Magic 99 has fire for alchemy.

- **Claim.** The alchemy band gets its feathers and fire from three shelves the army can reach, each a planner job
  that runs after the account holds its nature runes: feathers at Gerrant's in Port Sarim (`army-feathers-sarim`),
  fire runes at Aubury's in Varrock under Magic 66 (`army-fire-aubury`), and from Magic 66 a staff of fire and fire
  runes at the Magic Guild in Yanille (`army-staff-guild`).
- **Conditions.** Practice. Every other combat skill 99, at the Ardougne north bank with 60,000 coins and 1,000
  nature runes banked. Chains f: Magic 21, no feathers. Chains y: Magic 92, 700 feathers, three at once on the guild's
  shelf of 2 staffs. The alchemy template followed (cap 2,500 for f, 1,500 for y).

  | Chain | Shop runs | Alchemy run after them |
  |---|---|---|
  | f1 | 700 feathers, 674 ticks, 5,219 coins; 500 fire runes, 614 ticks, 6,684 coins | ok, Magic 21 -> 72, 56 low and 66 high casts, 1,834 ticks, `stop=supplies` |
  | f2 | 500 feathers, 796 ticks, 6,000 coins (spend cap); 375 fire runes, 672 ticks, 8,987 coins | ok, Magic 21 -> 67, 1,499 ticks, `stop=supplies` |
  | y2 | staff 1,515 coins, 314 ticks; 375 fire runes, 237 ticks, 8,994 coins | Magic 92 -> 97 with the staff, 174 high casts, ended on the 1,500-tick cap |
  | y3 | staff 1,500 coins, 216 ticks; 500 fire runes, 234 ticks, 6,710 coins | Magic 92 -> 97 with the staff, 174 high casts, ended on the 1,500-tick cap |
  | y1 | no staff left (`SHOP_NONE`, count 0), 339 ticks; 375 fire runes, 214 ticks, 9,000 coins | ok, Magic 92 -> 94 on the fire runes, 75 high casts, `stop=supplies` |

  Two accounts on one shelf pay more: the price of feathers and fire runes rises as the shelf empties. 375 to 500
  fire runes take Magic 21 past 66, the Magic Guild door. An account that finds the staff shelf empty still leaves
  with fire runes and comes back when they run under 250.
- **Evidence.** `.practice/magic/chain.ts` and its `f1`, `f2`, `y1`-`y3` logs in the Claude cloud container that ran
  them; `packages/planner/test/autopilot.test.ts` (the order of the three jobs).
- **Gap.** Practice only. Whether another player empties the Magic Guild's staff shelf as Zaff's is not known.

### Prayer from bought bones

- **Claim.** A bought dragon bone buried at the bank is worth 1,800 Prayer XP and a big bone 375, at about 815 and 172
  XP a tick, against 3.84 a tick for burying trooper bones on the field. The planner buys them for an account with
  no other band to start (`kit-buy:army-bury-dragon-99`, then `army-bury-big-99`) and the bury band runs where the
  Grand Exchange buy leaves the account.
- **Conditions.** Practice at xpRate 25, the planner's bury templates (`scripts/train-prayer.ts 99` with
  `BURY_HELD=1 BONE_ID=536|532 BONE_RESERVE=6`). Every melee skill, Ranged and Magic 99; the bones banked.

  | Run | Bones banked | Start | Buried | XP | Prayer | Ticks | XP per tick | Stop |
  |---|---|---|---|---|---|---|---|---|
  | d2 | 264 dragon | Varrock West | 258 | 464,400 | 90 -> 99 | 571 | 813.3 | target-level |
  | d1 | 169 dragon | Varrock West | 163 | 293,400 | 90 -> 96 | 358 | 819.6 | input-insufficient |
  | d3 | 60 dragon | Ardougne north | 54 | 97,200 | 97 -> 98 | 119 | 816.8 | input-insufficient |
  | b1 | 400 big | Ardougne north | 394 | 147,750 | 74 -> 82 | 858 | 172.2 | input-insufficient |

  All four ended `RESULT ok`. The trainer keeps 6 bones and checks the XP of every bury. A held batch ends ok when
  it runs out, with or without a level: from 96 a level is 58,000 to 67,000 XP.
- **Market (live claude-cloud read).** Dragon bones: 1,009 listed from 9,000, mean 9,687. Big bones: 1,686 listed
  from 2,399, mean 2,526. Bones: no real seller (ask 45,125). That is about 2.4 million Prayer XP for about 14
  million coins, about 5.2 coins an XP for dragon bones and 6.5 for big bones; Prayer 74 to 99 is about 820,000 XP an
  account. The side holds 36 million coins.
- **Sizing.** A buy takes what the account's Prayer still needs from its level, or what it can pay for under the
  caps (10,000 and 2,600). The listed dragon bones finish about three accounts (TrouserSnake 237, UnderMyKilt 314,
  TheFullMonty 443 from their levels), so only an account with Ranged and Magic at 90 buys them; one with either
  still under 99 keeps 100,000 coins back for arrows, a staff and a blade.
- **Evidence.** `.practice/bones/run.ts` and its `d1`-`d3`, `b1` logs in the Claude cloud container that ran them;
  `packages/planner/test/autopilot.test.ts` (who buys, how many, the order of the two bones);
  `scripts/train-prayer.test.ts` (dragon bone XP, a batch with no level).
- **Gap.** The buy is not run live and the Grand Exchange is not on practice. The listings above the caps are not
  bought, so less than the listed total is in reach.

## 1. Melee, no cannon

Script `scripts/measure/combat-melee.ts`, runner `scripts/measure/floor-run.ts`, 300 ticks per run,
`TARGET='^khazard trooper$'`.

Spot: the Gnome battlefield (presets `combat_gb_40/70/90`, start 2525,3242). It is multiway
(`maps/multiway.csv` "gnome battlefield") with 41 Khazard troopers on open ground
(`quests/quest_tree/configs/gnome_battlefield.npc:1-40`: HP 22, defence 12-13, attackrate 5-6, no `huntmode`, so
they do not attack first). No melee run ate food (`eats=0` in every RESULT line).

Gear (all tradeable): rune full helm, amulet of strength, rune scimitar, rune chainbody (the platebody needs Dragon
Slayer, `levelrequire/scripts/tier40.rs2:26`), rune kiteshield, rune platelegs, leather gloves and boots. Style 1
(aggressive, Strength XP). Attack, Strength, Defence and Hitpoints all at the band level.

| Band | Run 1 | Run 2 | Run 3 | Mean style XP/tick | HP XP/tick (runs) | Mean HP XP/tick | In combat |
|---|---|---|---|---|---|---|---|
| 40 | 88.0 | 82.0 | 74.0 | 81.3 | 29.1 / 27.1 / 24.4 | 26.9 | 0.93-0.95 |
| 70 | 154.0 | 146.7 | 111.0 | 137.2 | 51.0 / 48.6 / 36.8 | 45.5 | 0.92-0.93 |
| 90 | 126.0 | 156.7 | 136.0 | 139.6 | 41.7 / 51.8 / 45.0 | 46.2 | 0.91-0.92 |

Example output line (band 90, run 2):
`RESULT ok cannon=false ticks=300 styleXp=47000 styleXpPerTick=156.7 hpXp=15552 hpXpPerTick=51.8 ... meleeDmgPerTick=1.567 ... inCombat=274 inCombatShare=0.913 attacks=25`

- Damage per tick = style XP / 100 (4 x base x 25, `skill_combat/scripts/combat.rs2:143-167`): 0.81 / 1.37 / 1.40.
  Hitpoints XP / style XP = 0.331, as the code says (1.33 / 4).
- Band 90 is not faster than band 70 here: a trooper has 22 HP, so a 90 hit is often capped by the HP left, and the
  bot needs about 12 ticks per kill (walk, 2-3 swings). A target with more HP would favour band 90. Not measured.
- "In combat" counts ticks where the target is alive and style XP came in within 10 ticks. The bot re-targets on the
  tick a target dies. 100% of ticks in combat is not reached: walks to the next trooper take 5-10% of ticks.
- `def-top` weights: Defence 1-55 is 4.7% of the XP to 99, 55-80 is 22.1%, 80-99 is 73.2%
  (`packages/planner/src/curve.ts`). Bands 40 / 70 / 90 stand for these ranges.
- Comparison spot: Falador White Knights (`combat_wk_90`, HP 52, multiway): 105.0 style XP per tick in one 300-tick
  trial. The courtyard walls make many knights unreachable. Not used.

## 2. Cannon while meleeing

Same script with `CANNON=1`, presets `combat_gb_<band>_cannon`: `%mcannon` (varp 0) = 11, `%ownedmcannon` (varp 4)
= -1, cannon base / stand / barrels / furnace, 1,000 cannonballs, 16 lobsters. The bot sets up the cannon (14 ticks,
outside the measured window), tops it up with balls every 20 ticks, re-fires after "out of ammo", and picks it up
after the run. A save value of 0 in varp 4 reads as a placed cannon ("You cannot construct more than one Cannon").

| Band | Style XP/tick (runs) | Mean | Ranged XP/tick (runs) | Mean | HP XP/tick mean | Ranged per style XP |
|---|---|---|---|---|---|---|
| 40 | 54.7 / 82.0 / 56.7 / 55.7 | 62.3 | 96.0 / 41.5 / 55.0 / 145.2 | 84.4 | 20.6 | 1.355 |
| 70 | 66.3 / 96.0 / 101.0 | 87.8 | 133.5 / 50.0 / 56.0 | 79.8 | 29.0 | 0.909 |
| 90 | 119.0 / 120.7 / 101.7 | 113.8 | 44.5 / 59.0 / 96.2 | 66.6 | 37.6 | 0.585 |

Example output line (band 90, run 3):
`RESULT ok cannon=true ticks=300 styleXp=30500 styleXpPerTick=101.7 hpXp=10082 ... rangedXp=28850 rangedXpPerTick=96.2 ... reloads=16 refires=3 setupTicks=14`

- Band 40 has 4 valid runs: run 2 of the first batch and 3 reruns. Runs 1 and 3 of the first batch found an older
  cannon on the spot and set up nothing (Ranged XP 0); they are left out. The script now moves 6+ tiles from any
  cannon it sees and checks for "You place the cannon base".
- The cannon lowers the melee rate by 18-36%: each top-up is an item-on-loc that clears the NPC interaction and
  walks to the cannon. It adds 67-84 Ranged XP per tick (1.3-1.7 cannon damage per tick, 50 Ranged XP per damage,
  `quests/quest_mcannon/scripts/cannon_fire.rs2:117-119`). The cannon's hit roll uses the player's current melee
  attack roll (`player_combat.rs2:52-68`), so Ranged level does not matter.
- Spread is large (41-146 Ranged XP per tick). The high runs had more troopers around the cannon. One trial at band
  90 gave 146.7 Ranged and 95.3 style XP per tick.
- Total XP goes up with the cannon (band 90: 139.6 to 180.4 per tick), but the planner rates the Ranged side XP
  below the cost to the melee boards. Open: top up every 30 ticks from the tile next to the cannon, or stand at the
  cannon and let troopers come (aggro); a higher-HP multiway target.

## 3. Stun guests at the Ardougne knights

Script `scripts/measure/stun-guest.ts`, 600 ticks per run, presets `stun_base`, `stun_bury`, `stun_enchant`
(Thieving 99, 10 HP, 5 lobsters). The bot clicks a knight every 2 ticks. Inside each stun (8 ticks after
"You've been stunned!", `skill_thieving/scripts/thieving.rs2:28-51`) it eats at HP 4 or less, else it buries a
dragon bone (Prayer 99, so no level-up page) or casts Lvl-1 Enchant on a sapphire ring (Magic 99).

| Arm | Run 1 | Run 2 | Run 3 | Result |
|---|---|---|---|---|
| Base: Thieving XP/tick, stuns | 748.2, 13 | 593.6, 12 | 495.3, 15 | mean 612.4 |
| Bury, click every 2 ticks (`BURY_GAP=2`) | 646.3; 22 bones in 11 stuns | 741.1; 20 in 10 | 594.4; 22 in 11 (died at 585 ticks, food out) | 2.0 bones per stun |
| Bury, click every tick (`BURY_GAP=1`) | 555.0; 22 bones in 8 stuns | 751.7; 22 in 8 | 783.3; 18 in 6 | **2.83 bones per stun** |
| Enchant, cast when 2 ticks remain | 537.4; 20 casts in 8 stuns | 551.5; 20 in 8 | 642.8; 20 in 8 | **2.5 casts per stun** |

Example output lines:
`RESULT ok mode=bury buryGap=1 ticks=600 thievXp=451005 thievXpPerTick=751.7 stuns=12 stunTicks=96 guests=50 buried=22 ... perStun=8,8,5,8,5,8,5,3,0,0,0,0`
`RESULT ok mode=enchant ticks=600 thievXp=322447 thievXpPerTick=537.4 stuns=10 stunTicks=80 guests=20 ... magicXp=8750 ... perStun=3,2,3,2,3,3,2,2,0,0 ... recoil=20`

- Bones and rings ran out after 6-11 stuns in every guest run, so the per-stun numbers count only the stuns before
  that (bones buried = Prayer XP / 1,800; casts = Magic XP / 437.5).
- Bury: 2.83 bones per 8-tick stun = 5,100 Prayer XP per stun = 637 Prayer XP per stun tick. The bury row runs one
  bone per 2 ticks, so a stun tick is worth 0.71 bury-row ticks. With a click every 2 ticks, half the clicks were
  dropped (2.0 bones per stun); a click every tick lands more.
- Enchant: 2.5 casts per stun (every cast landed), 3 ticks per cast in the enchant row, so a stun tick is worth 0.94
  enchant-row ticks. Lvl-1 gives 137 Magic XP per stun tick; a higher enchant gives more XP per cast at the same
  cadence (`skill_magic/scripts/spells/enchant.rs2:53`, `p_delay(1)`).
- Thieving rate: no drop seen. Base 612 vs bury 661 / 697 vs enchant 577 XP per tick; the spread inside each arm
  (495-783) comes from the stun count (6-16 per run) and is larger than the arm difference.
- `deadTicks`: stunned ticks 3,584 realistic (`research/live-thieving-2026-10-23.md:74`) and 0.58 x 3,850 = 2,233
  floor, x 0.9 for refill trades inside stuns (ESTIMATE: one trade of 4-7 ticks per 8 stuns, commit 61953b2).
  Prayer fills first: 1,300 / 1,169 bury-row ticks need 1,831 / 1,646 stun ticks at 0.71. Magic takes the rest at
  0.94. Capacity 2,611 realistic, 1,511 floor.

## 4. Higher-HP multiway targets (bands 70 and 90)

Search (CODE-READ, a scratch script over `maps/multiway.csv` and the npc configs): every NPC with 35-130 HP in a
non-Wilderness multiway zone. Quest-locked areas (Legends' death wings, lighthouse dagannoths, Shilo undead ones) and
single spawns are left out. Measured candidates, same gear and script as section 1, 3 x 300 ticks:

- **iw**: Ice Queen lair, 6 ice warriors at 2864-2868, 9948-9951 (`_unpack/225/all.npc` `icewarrior_queen`: HP 59,
  attack, strength and defence 47, slash defence 40, `huntmode=cowardly`, huntrange 5, respawn 60). They attack
  first. Preset `combat_iw_<band>`, start 2866,9946. The walk into the lair was not checked.
- **ks**: Kalphite lair, 5 soldiers within 10 tiles at 3463-3469, 9476-9489, plane 2 (`kalphite.npc:62-95`: HP 90,
  attack, strength and defence 70, poison 20, cowardly, huntrange 5). Preset `combat_ks_<band>`.
- **sk**: Temple of Ikov dungeon, 9 skeletons at 2637-2660, 9885-9894 (`all.npc` id 93: HP 59, defence 36, cowardly,
  huntrange 1). Preset `combat_sk_<band>`. Entry may need the Temple of Ikov quest (not checked).

| Spot | Band | Style XP/tick (runs) | Mean | HP XP/tick (runs) | Mean | Lobsters used (of 20) | In combat |
|---|---|---|---|---|---|---|---|
| iw | 90 | 189.7 / 163.0 / 203.3 | **185.3** | 62.9 / 54.0 / 67.3 | **61.4** | 0 / 0 / 0 | 0.95 |
| iw | 70 | 136.7 / 127.7 / 110.3 | 124.9 | 45.3 / 42.3 / 36.5 | 41.4 | 0 / 2 / 3 | 0.94 |
| ks | 90 | 132.3 / 109.3 / 129.7 | 123.8 | 43.8 / 36.2 / 43.0 | 41.0 | 6 / 5 / 5 | 0.92-0.93 |
| ks | 70 | 84.3 / 95.3 / 75.7 | 85.1 | 27.9 / 31.6 / 25.1 | 28.2 | 8 / 4 / 15 | 0.73-0.90 |
| sk | 90 | 146.0 / 201.3 / 154.0 | 167.1 | 48.3 / 66.7 / 51.0 | 55.3 | 0 / 0 / 0 | 0.94-0.96 |
| sk | 70 | 107.3 / 138.0 / 162.7 | 136.0 | 35.5 / 45.7 / 53.9 | 45.0 | 0 / 0 / 0 | 0.93-0.96 |
| gb (section 1) | 70 | 154.0 / 146.7 / 111.0 | 137.2 | | 45.5 | 0 | 0.92-0.93 |
| gb (section 1) | 90 | 126.0 / 156.7 / 136.0 | 139.6 | | 46.2 | 0 | 0.91-0.92 |

Example line (iw 90, run 3): `RESULT ok cannon=false ticks=300 styleXp=61000 styleXpPerTick=203.3 hpXp=20200
hpXpPerTick=67.3 ... inCombat=286 inCombatShare=0.953 attacks=13 ... food=20`.

- Best band 90: the ice warriors, 185.3 (+33% on the battlefield). They stand within 4 tiles and attack first, so
  the bot hardly walks (13-14 attacks per 300 ticks). Food: 0 at band 90. At band 70, at most 3 lobsters per 300
  ticks, about 90 per live hour of 9,000 ticks (ESTIMATE from 3 runs).
- Best band 70: the battlefield (137.2) and the skeletons (136.0) are equal. Kalphite soldiers are worst: high
  defence and hard hits (up to 15 lobsters in 300 ticks at band 70).
- Many iw, ks and sk runs ended `exit=1` after `RESULT ok`: the logout did not complete because aggressive NPCs
  kept the account in combat. The XP numbers are valid. A real run must walk out of reach before it logs out.

## 5. Cannon policy (fixed top-up)

The Dwarf Cannon helper found that the 20-tick top-up in section 2 never landed: the next attack click replaced the
walk to the cannon, and Fire on the next tick broke the reload after an empty cannon (`research/quest-plan.md`
section 1b). Its fix is now in `scripts/measure/combat-melee.ts` (commit 2c0f205): no attack click until "You load
the cannon" or 8 ticks pass, Fire only after the load lands, top-up every 30 ticks. Section 2 numbers come from the
broken handling. The script also tries a spiral of tiles when the 3x3 is blocked (commit afd2e2b).

Policies, band 90, 3 x 300 ticks:

- **A**: the fixed top-up every 30 ticks, targets within 10 tiles of the cannon (`RELOAD=30`, the default).
- **B**: as A, but targets only within 2 tiles of the cannon, and a timed top-up only from a tile next to the
  cannon or between targets (`NEAR=2 TOPUP_ADJ=1`).

| Spot, policy | Style XP/tick (runs) | Mean | Ranged XP/tick (runs) | Mean | HP XP/tick mean | Ranged per style XP | In combat |
|---|---|---|---|---|---|---|---|
| gb, none (section 1) | 126.0 / 156.7 / 136.0 | 139.6 | 0 | 0 | 46.2 | - | 0.91-0.92 |
| gb, A | 94.0 / 73.0 / 93.0 | **86.7** | 179.8 / 193.2 / 179.5 | **184.2** | 28.7 | **2.125** | 0.74-0.77 |
| gb, B | 50.0 / 52.0 / 59.0 | 53.7 | 195.2 / 152.0 / 178.7 | 175.3 | 17.7 | 3.27 | 0.35-0.49 |
| iw, none (section 4) | 189.7 / 163.0 / 203.3 | 185.3 | 0 | 0 | 61.4 | - | 0.95 |
| iw, A | 116.3 / 138.0 / 148.3 | 134.2 | 81.2 / 76.3 / 49.5 | 69.0 | 44.4 | 0.514 | 0.89-0.91 |
| iw, B | 145.3 / 102.3 / 105.7 | 117.8 | 70.2 / 70.3 / 108.7 | 83.1 | 39.0 | 0.705 | 0.47-0.84 |

Example line (gb, A, run 2): `RESULT ok cannon=true ticks=300 styleXp=21900 styleXpPerTick=73.0 hpXp=7237
hpXpPerTick=24.1 rangedXp=57950 rangedXpPerTick=193.2 ... reloads=10 refires=1 setupTicks=14 balls=882`.

- Policy A at the battlefield is the best cannon session: 271 XP per tick in all (86.7 style + 184.2 Ranged), and
  Ranged 1 to 58 in 300 ticks. This agrees with the helper's 207.7 Ranged and 91.7 style (different stats). It
  costs 38% of the melee rate.
- Policy B idles while no NPC stands within 2 tiles of the cannon, and it adds no Ranged. Not used.
- At the ice warriors the cannon sees few targets. The 3x3 had to go 1 tile south of the group (2866,9945), and
  the cannon scans one of 8 directions per tick (`cannon_fire.rs2:1-91`), so most directions are empty.
- So the choice depends on the board: no cannon at the ice warriors for the melee boards (185 style XP per tick), or
  the cannon at the battlefield when Ranged is the target (184 Ranged + 87 style).

## 6. Ranged: bow plus the fixed cannon

Presets `combat_rb_<band>` and `combat_rb_<band>_cannon` (Gnome battlefield, Ranged, Defence and Hitpoints at the
band). Band 40: yew shortbow and green d'hide; bands 70 and 90: magic shortbow and black d'hide; coif, amulet of
power, 3,000 rune arrows. Same script (`TARGET='^khazard trooper$'`), 3 x 300 ticks per arm. The fight signal is
now Hitpoints XP (own hits only; the cannon gives none). "Balls" counts the balls loaded during the window.

| Arm | Band | Ranged XP/tick (runs) | Mean | Defence XP/tick mean | HP XP/tick mean | Arrows per 1k Ranged XP | Balls per 1k Ranged XP | Food |
|---|---|---|---|---|---|---|---|---|
| Bow (rapid) only | 40 | 110.7 / 101.7 / 105.3 | 105.9 | 0 | 34.9 | 2.31-2.53 | 0 | 0 |
| Bow (rapid) only | 70 | 144.7 / 139.0 / 172.3 | 152.0 | 0 | 50.2 | 1.66-2.13 | 0 | 0 |
| Bow (rapid) only | 90 | 198.3 / 204.7 / 199.3 | 200.8 | 0 | 66.4 | 1.43-1.49 | 0 | 0 |
| Bow (rapid) + cannon | 40 | 345.2 / 334.2 / 296.3 | 325.2 | 0 | 31.6 | 0.61-0.72 | 1.22-1.27 | 0-1 |
| Bow (rapid) + cannon | 70 | 371.5 / 353.3 / 388.5 | 371.1 | 0 | 41.8 | 0.63-0.68 | 1.24-1.46 | 0 |
| Bow (rapid) + cannon | 90 | 386.7 / 394.7 / 397.3 | **392.9** | 0 | 49.8 | 0.61-0.65 | 1.17-1.29 | 0 |
| Bow (longrange) + cannon | 40 | 274.2 / 224.5 / 206.0 | 234.9 | 39.2 | 25.9 | 0.69-0.89 | 1.54-1.74 | 0 |
| Bow (longrange) + cannon | 70 | 331.5 / 282.5 / 295.2 | 303.1 | 57.9 | 38.3 | 0.68-0.75 | 1.41-1.64 | 0 |
| Bow (longrange) + cannon | 90 | 307.7 / 321.0 / 324.7 | **317.8** | 56.4 | 37.3 | 0.61-0.66 | 1.40-1.58 | 0 |
| Cannon + melee (section 5) | 90 | 179.8 / 193.2 / 179.5 | 184.2 | (86.7 style) | 28.7 | - | about 2.3 (helper) | 0 |

Example line (rapid + cannon, band 90, run 3): `RESULT ok cannon=true ticks=300 ... hpXp=16837 hpXpPerTick=56.1
rangedXp=119200 rangedXpPerTick=397.3 ... arrowsUsed=73 arrowsPer1kRanged=0.61 ballsUsed=139 ballsPer1kRanged=1.17
foodUsed=0`.

- Bow + cannon is about twice cannon + melee for Ranged: 392.9 vs 184.2 at band 90 (rapid). Ranged went up 25-28
  levels per 300-tick run at band 40, so "band 40" covers about 40-68.
- Ranged 1 to 99, XP-weighted (4.7 / 22.1 / 73.2%): rapid 392.5 / 384.2 (floor / realistic), longrange
  323.4 / 309.4 Ranged plus 0.180 Defence and 0.119 Hitpoints per Ranged XP.
- Planner, scenario a, from HEAD with each `ranged` row (other agents' uncommitted rows left out):

| `ranged` row | Ranged finish, floor / realistic | Overall, all safe levers | Overall, without `cannon-melee` |
|---|---|---|---|
| Cannon + melee 215.7 / 207.7, side Defence 0.441 | 33,392 / 40,060 | 38,235 / 45,443 | 37,940 / 45,129 |
| Bow rapid + cannon 392.5 / 384.2, no Defence | 31,307 / 37,851 | 40,834 / 48,313 | 38,308 / 45,623 |
| **Bow longrange + cannon 323.4 / 309.4, side Defence 0.180 (committed)** | **31,851 / 38,480** | **39,466 / 46,869** | **37,851 / 45,149** |

- Defence finishes last, so Overall follows Defence. Rapid drops the Defence side XP the old row gave, and Overall
  gets later. Longrange keeps part of it: Ranged lands 1,541 / 1,580 ticks earlier and Overall is the same as before
  when `cannon-melee` is off. With `cannon-melee` on, every variant is later, because the lever slows `def-top` to
  86.7 style XP per tick. `cannon-melee` loses ticks in every table measured; switch it off (the lever list is
  in `packages/planner/src/haggis.ts`, not changed here).
- Supplies for Ranged 99 (longrange): about 1,557 cannonballs and 709 rune arrows (row: 1,700 and 850 with spare).
- Logout: `combat-melee.ts` now walks 18 tiles away and waits until 17 ticks pass with no hit before logout. All 27
  runs in this section ended `exit=0`.

## 6a. Ranged: bow plus cannon at the Wilderness poison spiders

Claim: rapid bow plus cannon at the poison spiders takes Ranged 55 to 99 in about 2,000 ticks (476.7 XP per tick) at
Attack 99, 3 of 3 runs. The Attack 1 specialist time is preliminary: 2 valid runs (2,046 and 1,973 ticks), not 3. The
cannon roll follows the worn weapon, so a code read says Attack does not matter while a bow is worn.

Conditions: MEASURED practice, one bot at the site, 150 ms tick, presets `cannon_spiders_*` (start tile 3287,3810,
Wilderness level 37, multiway `maps/multiway.csv` `0_51_59_16_32`), `CANNON=1 TARGET='^poison spider$' STYLE=1 NEAR=8
RELOAD=25 STOP_LEVEL=99`, `PROTECT=1` keeps Protect from Melee on. Script `scripts/measure/combat-melee.ts`. Kit: magic
shortbow, 700 rune arrows, coif, amulet of power, green d'hide, cannon, 1,500 cannonballs. Set-up is 11-12 ticks,
outside the window. Raw logs: `.practice/cannon-spiders/` in the measuring worktree (not in git).

Evidence, Ranged 55 to 99 or death. Balls are balls loaded after the first 30. Potions and antipoisons are doses.

| Run | Set | Ticks | Ranged XP | XP/tick | Balls | Arrows | Sharks | Prayer | Antipoison | HP min | Deaths |
|---|---|---|---|---|---|---|---|---|---|---|---|
| h1 | Haggis, bow, Protect | 1,964 | 952,100 | 484.8 | 1,044 | 605 | 10 | 10 | 4 | 34 | 0 |
| h2 | Haggis, bow, Protect | 1,976 | 951,900 | 481.7 | 1,013 | 608 | 15 | 10 | 1 | 33 | 0 |
| h3 | Haggis, bow, Protect | 2,052 | 952,050 | 464.0 | 993 | 632 | 15 | 10 | 1 | 33 | 0 |
| q5 | Specialist, bow, Protect | 2,046 | 952,550 | 465.6 | 992 | 613 | 6 | 22 | 8 | 18 | 0 |
| q6 | Specialist, bow, Protect | 1,973 | 952,650 | 482.8 | 1,019 | 592 | 5 | 21 | 8 | 18 | 0 |
| q1 | Specialist, bow, Protect | 1,636 | 814,900 | 498.1 | 882 | 498 | 12 | 17 | 0 | 0 | 1 at Ranged 96 |
| s1 | Specialist, bow, no prayer | 586 | 252,150 | 430.3 | 285 | 169 | 18 | 0 | 0 | 0 | 1 at Ranged 81 |
| s2 | Specialist, bow, no prayer | 534 | 215,500 | 403.6 | 271 | 151 | 18 | 0 | 4 | 0 | 1 |
| s3 | Specialist, bow, no prayer | 888 | 380,450 | 428.4 | 449 | 256 | 18 | 0 | 6 | 0 | 1 |

Sets: Haggis = Attack 99, Strength 99, Defence 89, Hitpoints 97, Prayer 99 (`cannon_spiders_h`). Specialist = Attack 1,
Strength 1, Defence 40, Hitpoints 55, with Prayer 43, 12 sharks and 9 prayer potions (`cannon_spiders_sp`) or Prayer 1,
18 sharks and 3 prayer potions (`cannon_spiders_s`). q1 never drank its antipoison: the poison message came in set-up,
before the script looked for it, and 12 sharks ran out. q5, q6, s2 and s3 run the fixed check; h1-h3, q1 and s1 do not.

XP per tick by band, pooled, with the rival's rate from `route-log.json` levels (run 9, S27 start 214):

| Band | Haggis (h1-h3) ticks | Haggis XP/tick | Specialist (q5, q6) ticks | Specialist XP/tick | Rival XP/tick |
|---|---|---|---|---|---|
| 55-60 | 30 / 36 / 57 | 465.0 | 45 / 35 | 495.6 | 289.1 (includes set-up) |
| 60-70 | 144 / 158 / 193 | 404.3 | 188 / 178 | 366.7 | 345.6 |
| 70-80 | 308 / 286 / 307 | 446.3 | 339 / 287 | 428.5 | 513.2 |
| 80-90 | 545 / 541 / 569 | 485.3 | 582 / 556 | 469.4 | 561.3 |
| 90-95 | 452 / 487 / 462 | 474.3 | 427 / 448 | 507.8 | 599.3 |
| 95-99 | 484 / 467 / 463 | 513.8 | 464 / 468 | 519.8 | 548.4 |

Cannon roll, 300-tick runs with a scimitar and no bow, cannon XP only (`cannon_spiders_h_sci`, `cannon_spiders_s_sci`):

| Weapon, Attack | Ranged XP/tick (runs) | Mean | Computed hit chance |
|---|---|---|---|
| Rune scimitar, Attack 99 | 281.5 / 293.0 / 258.5 | 277.7 | 0.80 |
| Iron scimitar, Attack 1 | 35.8 / 20.2 / 23.7 | 26.6 | 0.07 |

- The roll is `~player_npc_hit_roll(%damagetype)` (`quests/quest_mcannon/scripts/cannon_fire.rs2:116`): the worn weapon
  and style decide it. With a bow it is `%com_rangeattack`, Ranged level times ranged bonus (108 in this kit), so the
  chance rises 0.78 at Ranged 55 to 0.87 at Ranged 99 (computed, spider defence roll 4,758).
- Attack level needed: none with a bow. With a rune scimitar, computed against defence roll 4,941 with slash bonus 51
  and armour penalties left out: Attack 40 = 0.55, 60 = 0.68, 87 = 0.77 (equal to the bow at Ranged 55), 94 = 0.79,
  99 = 0.80. A gate at Attack 99 buys 1 point of hit chance over 94.
- Prayer decides survival for a low-Defence account: 3 of 3 runs without it died with 18 sharks eaten. With Protect
  from Melee and antipoison, 2 of 2 reached 99 on 5-6 sharks.
- Projections (ESTIMATE): Haggis 1,997 ticks for 55-99 + 11 set-up. Ranged 1-55 is 46,534 XP, 143 ticks at section 6
  band 40 (325.2): 1-99 about 2,151 ticks. A specialist adds Dwarf Cannon 888-925 (`research/quest-plan.md`), a walk
  (rival leg 188) and the unpriced Prayer 43 and Defence 40: about 3,250 ticks before those two, against board #1 5,595.
- The planner row is 309.4 realistic, about 3,227 ticks for 1-99. This site saves about 1,076 ticks gross (ESTIMATE),
  gives up the row's side Defence (0.18 per Ranged XP, about 180,000) and adds the Wilderness walk. Row not changed.
- Supply, Haggis mean for 55-99: 1,047 balls loaded, 615 arrows, 13.3 sharks, 10 prayer doses, 2 antipoison doses.
  Specialist mean: 1,036 balls, 603 arrows, 5.5 sharks, 21.5 prayer doses, 8 antipoison doses (all it held).
  Coins (ESTIMATE, `research/supply-costs.md` first-unit quotes 376, 203, 390): about 524,000 for Haggis without
  potions, which have no quote. A cannon set is 750,000 (ESTIMATE). The rival kit of 1,500 balls and 700 arrows covers this.

Gap: practice has no rival players at Wilderness level 37, so player-killer risk and spider competition are not
measured. Runs start at the site, so the walk, arrival poison and set-up under attack are not priced. Only 2 specialist
runs with the fixed poison check reached 99. The third slot went to q4, void because a dead run's cannon took the
set-up (bow only, 142.2 XP per tick). A death leaves `%ownedmcannon` set and the next set-up refused. The rival is 7-26%
faster from Ranged 70, and the cause is not known. Our cannon loads 0.53 balls per tick. The archive does not show how
many of the rival's 1,500 balls it fired.

### 6b. The route worker: `scripts/cannon-fight.ts` (bench `fighter:cannon`, `extra:cannon-spiders-r1`)

Claim: the worker takes Haggis from Ranged 55 to 99 at the poison spiders in 1,792-1,973 ticks (mean 1,885, plus 11-12
ticks of set-up), 3 of 3 seeds, against Cairn's 2,152 planned for segment 24. Ranged 1 to 50 with a rune scimitar at
Attack 99 takes 74-78 ticks, against Cairn's 488 for segment 13, which includes the walk from the Dwarf Cannon quest.

Conditions: bench, lockstep engine, seeds 7, 8, 9, one bot at the site. `fighter:cannon` is preset `cannon_spiders_h`
(Attack 99, Defence 89, Hitpoints 97, Prayer 99, rapid magic shortbow, 700 rune arrows) with `SPOT=spiders STYLE=1`.
`extra:cannon-spiders-r1` is Attack 99, Strength 1, Defence 1, Hitpoints 42, Prayer 99, Ranged 1, rune scimitar on
accurate, `STOP_LEVEL=50`. The worker closes each level-up message on the tick it sees it (the message is a chat modal,
`levelup/scripts/levelup.rs2:54`, and a normal timer such as `[timer,cannon_rotate]` waits while one is open,
`engine/src/engine/entity/Player.ts:1069`), stands on the set-up tile and shoots only targets within 7 tiles, tops up
every 20 ticks, and picks up nothing. Raw rows: `.practice/aio-bench/seed-7.json` to `seed-9.json` in the measuring
worktree (not in git).

| Seed | Ticks 55-99 | Ranged XP/tick | HP XP/tick | Balls | Arrows | Sharks | Antipoison doses | Level-up messages |
|---|---|---|---|---|---|---|---|---|
| 7 | 1,973 | 482.9 | 59.0 | 1,052 | 622 | 4 | 8 | 44 |
| 8 | 1,889 | 504.4 | 60.8 | 1,020 | 595 | 4 | 8 | 44 |
| 9 | 1,792 | 531.5 | 67.3 | 1,033 | 561 | 3 | 8 | 44 |

| Band | Ticks (seeds 7 / 8 / 9) | Mean | Ranged XP/tick | Rival XP/tick (6a) |
|---|---|---|---|---|
| 55-60 | 41 / 38 / 44 | 41 | 480 | 289.1 |
| 60-70 | 140 / 163 / 127 | 143 | 468 | 345.6 |
| 70-80 | 285 / 266 / 270 | 274 | 489 | 513.2 |
| 80-90 | 597 / 510 / 514 | 540 | 496 | 561.3 |
| 90-95 | 420 / 438 / 419 | 426 | 521 | 599.3 |
| 95-99 | 490 / 474 / 418 | 461 | 525 | 548.4 |

- Balls are the balls loaded after the first 30. The cannon fires 0.55 balls a tick (1,035 / 1,885), so about half of
  its rotation steps find no spider in reach and sight.
- Hitpoints XP is 115,000-121,000, short of the 129,288 for Hitpoints 97 to 99 (`packages/planner/src/curve.ts`): the
  run ends at Hitpoints 98. Defence XP is 0 (rapid style).
- These rows have no magic shortbow special (`SPECIAL=0`); 6c measures it.

Gap: the bench and the 6a runs use different engines (lockstep against 150 ms), so the gain over 6a (1,885 against
1,997) has no matched A/B and no cause. The planner row for segment 24 (`ranged`, 309.4 Ranged XP a tick at the Gnome
battlefield, plus the melee top-ups) is not changed here.

### 6c. Segment 24 whole: Defence 98-99, Hitpoints 97-99 and Ranged 55-99

Claim: a rune scimitar on block beside the cannon until Defence 99, then the rapid magic shortbow with its special,
finishes all three skills in 1,973-2,053 ticks (mean 2,008, plus 11-12 ticks of set-up), 3 of 3 seeds under Cairn's
2,152. Longrange for Defence is 186-266 ticks slower than melee on each seed, both without the special. The special saves 49-101 ticks on each seed.

Conditions: bench, lockstep engine, seeds 7, 8, 9, one bot at the site, cases `extra:cannon-step24-melee` and
`extra:cannon-step24-long`. Start: Attack 99, Strength 99, Defence 98, Hitpoints 97, Prayer 99, Ranged 55 (Cairn after
Dragon Slayer), the `cannon_spiders_h` kit with a rune scimitar for one shark. Stop: Ranged, Defence and Hitpoints all 99.
`melee` is `PHASES=1333:3:Defence=99;861:1`: block on the scimitar gives 4 Defence XP per damage
(`skill_combat/scripts/combat.rs2:149-150`), and the cannon still rolls with the worn weapon. `long` is
`PHASES=861:2:Defence=99;861:1`: longrange gives 2 Ranged and 2 Defence XP per damage (lines 157-159). The special
(Snapshot) costs 350 of 1,000 energy (`skill_combat/configs/ranged/bows.obj` magic_shortbow `sa_energy`), shoots two
arrows at Ranged + 10 and 10/7 accuracy (`pvm_magic_shortbow_sa`), and energy regains 100 every 50 ticks
(`skill_combat/configs/combat.constant:1-3`). Raw rows: `.practice/cannon-spiders/c3-seed-*.json`, `c4-seed-*.json`
and `c1.log`, `c2.log` in the measuring worktree (not in git).

| Arm | Seed 7 | Seed 8 | Seed 9 | Mean | Done (Defence / Ranged / Hitpoints, seed 8) |
|---|---|---|---|---|---|
| Melee, then rapid bow with the special | 2,053 | 1,973 | 1,999 | **2,008** | 331 / 1,973 / 1,871 |
| Melee, then rapid bow, no special | 2,121 | 2,074 | 2,048 | 2,081 | 357 / 2,068 / 2,074 |
| Longrange, then rapid bow, no special | 2,362 | 2,340 | 2,234 | 2,312 | 991 / 2,229 / 2,340 |

- Supplies, melee with the special: 1,063-1,100 balls after the first 30, 513-527 arrows, 4-5 sharks, 8 antipoison
  doses, 11 specials, no prayer potion, no death, hpMin 35.
- Without the special Hitpoints finishes last (6-74 ticks after Ranged): the bow's own damage is the limit, since the
  cannon gives no Hitpoints XP. The special adds own damage, and Hitpoints finished first on seed 8.
- Melee is faster for Defence than longrange: the scimitar takes Defence 98 to 99 in 331-438 ticks, where longrange
  takes 991-1,100 ticks and gives half its XP to a Ranged that the cannon fills anyway.

Recovery after a death (`extra:cannon-death-reclaim`, seed 7): the account died at tick 42 with no prayer and no food,
respawned, walked back from Lumbridge with the shared walker and picked the cannon up at 3286,3809, 439 ticks in all.
When the walk fails, the worker goes to Nulodion and waits there until the cannon loc's 2,500 ticks end
(`cannon_setup.rs2:129-218`, `cannon.constant:1`), because he replaces a cannon only when its loc is gone
(`npcs/nulodion.rs2:91-143`). `extra:cannon-reclaim-nulodion` checks that step: %ownedmcannon set with no loc,
"The dwarf gives you a new cannon."

Gap: the death case starts at Attack, Strength and Defence 99: with them at 1 the walker found no route back
(`WALK_NO_ROUTE` from 3221,3220; cause not traced), and the Nulodion wait after a failed walk has no bench case. No other player at the site.

## 7. Why Defence finished last, and two levers that fix it

Planner run: `bun packages/planner/src/haggis-cli.ts research/hiscores-live.json --levers --order`, scenario a.
Before this section (HEAD 3a53608): Overall 37,851 floor (late 1,935) / 45,149 realistic (late 9,233), Defence last,
then Hitpoints (36,137 / 43,260).

### Why Defence was last (ESTIMATE, planner)

Defence XP in the plan before Overall comes from 3 rows only:

| Source | Defence XP | Row |
|---|---|---|
| Monkey Madness, reward option 1 (`quest_mm/scripts/mm_daero.rs2:296`, 20,000 x 25) | 500,000 | `rival-mm`, lands at 16,971 realistic |
| Longrange side XP, 0.180 per Ranged XP (section 6) | 179,700 | `ranged`, 34,887-38,480 realistic |
| Melee top-up, Defence 93 to 99 | 318,758 | `def-top` |

EDF puts `def-top` (deadline 7,974) after the Agility rows (deadline 6,772). So the plan walks from the Ranged spot to
the Wilderness course (335 ticks), trains Agility, walks back (335 ticks), and then trains Defence (1,957 ticks
realistic). Agility ended at 42,857 and Hitpoints at 43,260; only Defence was later.

### Every Defence XP source in rev 289 content (CODE-READ, `stat_advance` is in tenths, x25 on this server)

| Source | Defence XP at 25x | Cite | In the plan |
|---|---|---|---|
| Monkey Madness, option 1 / option 2 | 500,000 / 875,000 | `quest_mm/scripts/mm_daero.rs2:296`, `:305` | option 1 (row `rival-mm`) |
| Dragon Slayer | 466,250 | `quest_dragon/scripts/quest_dragon.rs2:34` | after Overall (`combat-hp-bound`) |
| Holy Grail | 382,500 | `quest_grail/scripts/quest_grail.rs2:117` | after Overall |
| Hero's Quest | 76,875 | `quest_hero/scripts/quest_hero.rs2:30` | inside `quests-rest` |
| The Fremennik Trials | 70,310 | `quest_viking/scripts/quest_viking.rs2:136` | inside `quests-rest` |
| Nature Spirit | 50,000 | `quest_druidspirit/scripts/quest_druidspirit.rs2:425` | inside `quests-rest` |
| Observatory, Virgo sign only (random sign) | 21,875 | `quest_itgronigen/scripts/quest_itgronigen.rs2:228` | inside `quests-rest` |
| In Search of the Myreque | 15,000 | `quest_routequest/scripts/quest_routequest.rs2:27` | inside `quests-rest` |
| Genie lamp (random event only), base level x 10 | 23,250 at Defence 93 | `general/scripts/xplamp/xplamp.rs2:110-111` | no: not plannable |
| Melee, defensive style: 4 x base per damage | 100 per damage | `skill_combat/scripts/combat.rs2:150` | `def-top` |
| Melee, controlled: 1.33 x base each to Attack, Strength, Defence | 33.25 per damage | `combat.rs2:154` | no |
| Ranged, longrange: 2 x base each to Ranged and Defence | 50 per damage | `combat.rs2:159` | `ranged` side XP |
| Magic with the defensive melee style set: 1.33 Magic + 1 Defence x base | 25 per damage | `combat.rs2:164`, `player/player_magic.rs2:205-208` | no: a quarter of melee |

Checked and rejected (planner, realistic): Monkey Madness option 2 gives +375,000 Defence (no `def-top` at all) but
-375,000 Strength and -375,000 Hitpoints, which costs a 835-tick Strength top-up and about 5,300 ticks of Hitpoints (ESTIMATE, hand count).
Dragon Slayer before Overall needs 32 QP first (`qp-filler`, `druid`, `gobdip`). The cannon during `def-top` is the
retired `cannon-melee` lever (an LP check with the measured rates: its value per tick is 0.92 of the bow + melee mix).

### Measurement: Defence style at the plan's stats (MEASURED practice)

Presets `combat_gb_def93`, `combat_iw_def93` (new; Attack, Strength, Hitpoints 99, Defence 93, the section 1 gear,
20 lobsters), `STYLE=3` (rune scimitar "block", Defence XP), 3 x 300 ticks each, `RANDOM_EVENTS=0`:

| Spot | Defence XP/tick (runs) | Mean | HP XP/tick (runs) | Food | In combat |
|---|---|---|---|---|---|
| Ice warriors (iw) | 192.3 / 171.0 / 145.3 | **169.5** | 63.8 / 56.7 / 48.1 | 0 | 0.95 |
| Gnome battlefield (gb) | 158.3 / 153.0 / 144.0 | **151.8** | 52.4 / 50.6 / 47.6 | 0 | 0.91-0.92 |

Example lines:
`RESULT ok cannon=false ticks=300 styleXp=57700 styleXpPerTick=192.3 hpXp=19130 hpXpPerTick=63.8 ... inCombatShare=0.950 attacks=14 ... foodUsed=0 ... lv=99/99/94/99/1` (iw run 1)
`RESULT ok cannon=false ticks=300 styleXp=47500 styleXpPerTick=158.3 hpXp=15730 hpXpPerTick=52.4 ... inCombatShare=0.913 attacks=25 ... foodUsed=0 ... lv=99/99/94/99/1` (gb run 1)

- The defensive style at Attack and Strength 99 is near the band 90 aggressive rate (iw 185.3, gb 139.6): the higher
  levels make up for the lost +3 Strength style bonus.
- The `def-top` row used a 1-99 XP-weighted rate (179.5 / 162.9). With Monkey Madness on, the row starts at
  Defence 93, so only the band 90 rate applies.

### Levers (`packages/planner/src/haggis.ts` LEVERS, `owner: false`; patches in `haggis-boards.json`)

- **`def-at-ranged-spot`**: `def-top` requires `ranged`; `agility-52` requires `def-top`. Defence trains at the
  Ranged spot right after the Ranged row (both rows are at the same place), so the walk back from the Wilderness course
  is gone. Rate: the gb measurement above (158.3 / 151.8), because the Ranged row is measured at the Gnome battlefield.
- **`waterfall-late`**: Waterfall serves Quest Points only, so it moves after Overall; `att-top` and `str-top` require
  `tree`, `grandtree` and `rival-mm` in place of `waterfall`. Attack is 99 without Waterfall: Tree Gnome Village
  286,250 + The Grand Tree 460,000 + Fight Arena 304,375 = 1,050,625. Strength: Monkey Madness 875,000, then a
  123,458 XP top-up (667 ticks at 185.3) in place of Waterfall (1,037 ticks) and its 535 walk ticks.

Overall finish (scenario a, all safe levers; the same numbers from HEAD + these rows and from the working tree with
other agents' uncommitted rows):

| Table | Floor | Realistic | Last skill, then |
|---|---|---|---|
| Before (HEAD 3a53608) | 37,851 (late 1,935) | 45,149 (late 9,233) | Defence; Hitpoints 36,137 / 43,260 |
| `def-at-ranged-spot` only | 37,434 (late 1,518) | 44,784 (late 8,868) | Defence; Agility 35,323 / 42,492 |
| `waterfall-late` only | 37,754 (late 1,838) | 44,957 (late 9,041) | Agility; Defence 33,865 / 40,580 |
| **Both (committed)** | **37,337 (late 1,421)** | **44,592 (late 8,676)** | **Agility; Defence 33,448 / 40,215** |

Saved as the last lever: `waterfall-late` 417 / 365, `def-at-ranged-spot` 97 / 192 (CLI `--levers`).

- Agility is now the last skill. Its rows are ESTIMATE (lap times not measured). Hitpoints 99 lands at
  30,468 / 37,105.
- The iw rate in the same order would save 356 / 219 more ticks than the gb rate (planner, without `waterfall-late`), but the Ranged row is at the
  battlefield, and the walk into the Ice Queen lair is not checked. Not modelled.
- Scorpion Catcher (165,625 Strength) in place of the Strength top-up: 277 floor ticks against 608, but 832
  realistic against 667 (ESTIMATE quest time). Not modelled.

## Open

- Measure Agility lap times (the Wilderness course row is now on the critical path).
- The real places of the combat rows: `str-top`, `ranged`, `def-top` are all at `falador-white-knights` in the
  travel model, but the rates come from the Gnome battlefield and the Ice Queen lair.
- Ranged 1 to 40 with a lower bow (1.6% of the XP; not measured).
- The walk into the Ice Queen lair and the Temple of Ikov dungeon (access rules not checked).
- The fixed cannon handling at bands 40 and 70 (only band 90 measured; `def-top` uses the band 90 cannon rate).
- Stun guests from a fresh ladder (Thieving 1 to 99), with real Prayer and Magic level-up pages and refill trades.
- `kills` and `dmgTaken` in the RESULT lines are not reliable (the SDK did not report kill events; damage events
  repeat). The rates use XP deltas only.

## Bounded Ranged entry and live admission

**Published evidence:** `scripts/gather-ranged.ts`, pin `3721e6165924310cc63631be2c3f3b65f5d08566d57eb25e822312a041af9c30`, passed56 focused checks/typecheck and four installed native cases. The first live Bigchopper pilot then refused every target because another player was nearby:471ticks,0kills/XP. Bow1/arrows90/salmon3 and unrelated assets were banked,HP15,logout. Keep that failed result and Bigchopper's hold. Evidence: `.practice/ranged-entry/live/proof.json`; prior release evidence remains `.practice/ranged-entry/release-qualified.json`.

**Reuse:** `rs2b2t/rs2b0t@6e747f8bda494d9f75365b5533cf758d353dcc3b`, `AutoFighter.ts::totalAmmo`, ranged bank caller and `banking.test.ts` → adapt quiver+pack counting and bank/return decomposition. Retain local Session/walk/deposit helpers, exact IDs and paired bank evidence. MIT inspected; no external implementation copied. Reject a whole-client port and first-XP success. The upstream README states rev289; its deployment still differs. Source decision: `.practice/ranged-entry/source.json`.

**Repair method:** replace field-wide player absence with an idle reachable selected Chicken41/1017, explicit attack and bounded own damage credit. Pinned `NpcType.regenrate=100` and `Npc.processRegen` permit at most2 healed HP in180ticks: own3damage out of at most5 establishes majority. At this25x rate require300–500XP in100XP steps, disappearance and fresh paired bones/raw-chicken drops. Disable auto-retaliate during ranging and restore its observed original value. SDK damage attribution is heuristic; object reveal delay is configurable. Neither supplies reliable ownership proof here. Primary source paths and rejected alternatives: `.practice/ranged-entry/presence/source-decision.json`.

**Isolated repair:** `.practice/ranged-entry/presence/candidate.ts`, SHA-256 `7d1569bff1e8098acbcb8107326421643e646a7a040e8c3d9ea21419c34cef3e`. Native local150ms/25x, Ranged1, banked bow1/arrows90/salmon3 and unrelated kit. Passive same-coop bystander:2kills/600XP,351ticks,89arrows/3salmon banked; logout and original auto-retaliate restored. WoundedHP4:2kills/700XP,331ticks,87arrows/2salmon banked; one observed heal. No-ammo refusal:9ticks,0XP/consumption,bank/logout. Owned stop:300ticks,1kill/300XP,90arrows/3salmon retained,loot banked,logout;target unmet remains false. Each is one observation, not a comparative rate. Twelve policy/heal/supervisor checks, candidate typecheck and all four native cases pass. Independent CRC-save parsing checks bank, equipment, unrelated assets and varp172; shot/food balance matches. Evidence: `.practice/ranged-entry/presence/qualification.json`.

**Released live result:** `.practice/ranged-entry/repair-release/live/proof.json` passes on pin `2b85da3588e50523e20a91617fdb0d7870343c82d7c6c2a6e23723cbbdc84862`; installed worker SHA-256 `8ffceba8024b38da514f95cb7aa39b5e70582b629343d077bfa93868a41c8027`. Bigchopper2kills/700XP,Ranged7,476ticks;2bones/2raw chicken/5feathers banked, bow1/arrows86/salmon3 retained,HP15→16,logout. Eleven observed shots =7recovered+4lost; no food consumed. Unrelated assets match. Thirty-seven focused checks/typecheck and four exact installed native cases pass; original auto-retaliate restored in CRC-save checks. Productive earners drained with251,850 gross banked coins, then resumed on controller20380. The release also passes strict cache build with the known GE-fork checksum; no route-time saving follows from that.

**Owner and next action:** goal executor. Bigchopper is offline awaiting alternate Arrav route/sustain qualification. Owned food transfer left Shaftsinker17salmon; no food purchase. Full1–40/99, later equipment, active competitor races, refill and fresh-start rehearsal remain unproved. Preserve Shaftshooter offline and productive earners. Keep failed and prior candidate proofs intact.

## Superheat during pickpocket stuns

Claim: Superheat can produce Smithing and Magic XP during knight stuns. Conditions: native practice at 150 ms and 25x XP, Thieving 55, Magic 43, Smithing 1, Hitpoints 99, a fire staff, staged ores and two lobsters. Saved state confirms Smithing 41, 61 casts, 17,172 Smithing XP, 80,825 Magic XP and zero fire runes consumed. Account playtime rises by 674 ticks; the work loop uses 667 ticks, including 189 ticks for two bank trips. Logout and item accounting pass.

Evidence in the main checkout: `.practice/full-completion/chain-firestaff/stun-results.json`, `account-metrics.json`, `source.ts` and the paired saves. The source copy matches the report hash. Reuse decision: adapt the existing stun-guest worker and `depositObserved`; no external implementation copied. Gap: one finite practice result. Random stun counts differ between conditions. No sustained XP/hr, net route saving, live qualification or specialist record follows from this result. Price helper delivery against the measured bank cost before selecting the method.

## Kalphite Queen completion

Claim: defeating the grounded form does not finish the encounter. Conditions: the pinned content's `kalphite_queen` death handler creates the corpse, changes the same NPC to `kalphite_flyingqueen`, and restores its HP. Source: `vendor/rs-sdk/server/content/scripts/areas/area_kalphite/scripts/kalphite_queen.rs2:36-57`. The pack identities are grounded form 1158, corpse 1159 and flying form 1160 (`knowledge/npcs.json`).

Consumer decision: reuse combat and session helpers, but adapt boss completion to require the terminal form's defeat. A corpse, an NPC type change or the grounded form's death cannot prove a complete encounter. Gap: owned terminal kill credit, native encounter proof and a bounded live consumer remain unverified. Quest completion and ordinary-monster receipts do not fill this gap.