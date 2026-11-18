# The dagger gang: behaviour record and bench clones

Goondelf, Ligma and Sugma are the accounts of another owner that kill our accounts in the Wilderness
([Rivals: the dagger gang](pvp-fight-loop.md#rivals-the-dagger-gang)). This file is the record of what each gang
account does, with the evidence for each value. The bench clones of the gang take their numbers from the record.
The counts in this file are those of the committed data files.

## Files and tools

| File | Content |
|---|---|
| `scripts/pk-gang-record/goondelf.json`, `ligma.json`, `sugma.json` | One gang account: levels, kit, attack, prayer, eating, movement, choice of player, retreat, death, schedule |
| `scripts/pk-gang-record/group.json` | The three as a group: the post, the pile-on, the chase of our accounts, the unknowns |
| `scripts/pk-gang-record/squad-candidate.json` | The squad that the climb ranks first, as arguments of `scripts/pk-squad.ts` |
| `scripts/measure/pk-gang-record.ts` | Builds the four files from the sources (`build`), lists the tick records (`scan`), saves the hiscore pages (`hiscores`) |
| `scripts/measure/pk-gang-collect.ts` | Records the gang from the public world feed: one socket, the roster and one rectangle that follows the gang |

Each value in a data file is a finding with a status:

- `measured`: a value from a source on this PC, with its sample size `n` and its evidence.
- `reported`: a value from a run whose raw data is not on this PC.
- `unknown`: no data shows the value. The finding names the observation that closes it (`closes`) and the range that
  the bench copy takes in its place (`cloneRange`).

The sources are in the main checkout:

- `.practice/rival-dds/trace-3.jsonl` and `trace-long-1.jsonl`: the whole Wilderness for 6,540 and 107,920 ticks (13 hours).
  The long trace holds one live meeting of our account Mightyrod with the three at the post.
- `.practice/gang-record/feed-*.jsonl`: the files of the collector.
- `.practice/gang-record/hs-<name>-<day>.html`: the hiscore pages.
- `.practice/ticks/`: the tick records of our accounts. The `scan` mode lists the records with a gang account near
  our account in the Wilderness.

A server tick is 400 ms: 10 ticks between two roster frames take 4,017 ms.

To build the record again:

```
bun scripts/measure/pk-gang-collect.ts 12 <main checkout>/.practice/gang-record
bun scripts/measure/pk-gang-record.ts hiscores --data <main checkout>
bun scripts/measure/pk-gang-record.ts scan --data <main checkout>
bun scripts/measure/pk-gang-record.ts build --data <main checkout>
```

## Findings

Each row is: claim, conditions, evidence path, gap. The evidence path is a key of the data files. Counts are for
Goondelf, Ligma and Sugma in that order.

### Kit and levels

| Claim | Conditions | Evidence | Gap |
|---|---|---|---|
| Attack, Strength, Defence and Hitpoints are 99. Prayer is 99, 90 and 90. Magic is 37, 28 and 28. Ranged and Herblore have no level. | Two hiscore pages six days apart show the same combat levels. | `levels.skills` | None. |
| The worn items are a black wizard hat, a monk's robe top and bottom and a dragon dagger (p). | 1,258, 1,355 and 1,114 appearance blocks hold that set. One block of Sugma after its death holds the hat and the dagger only. | `kit.worn`, `death` | The pack is not in the feed. |
| The dagger poison starts at 4. | 107 poison splats of 4 and 12 of other sizes on players within 2 ticks of an attack. | `kit.weaponPoison` | None. |
| The food heals 20: a shark. | 27 eats with a splat before and after each one. | `kit.food` | None. |
| The pack holds 11 sharks (Goondelf) and 13 (Sugma). | The eats of the live meeting, in which the food of both ran out. | `kit.foodCount` | One meeting. A refill at the bank would add to the count. The pack of Ligma is `unknown`: it ate 6 and its food did not run out. |
| A gang account also plays the eat animation when it needs no Hitpoints. | 8 such animations at 96 Hitpoints or more, or far from a fight. A drink plays the same animation (`anti_poison.rs2:3`). | `kit.consumesNotForHitpoints` | The item is `unknown`: a potion or a food item from loot. |
| A Strength prayer is on, and no Strength potion is in use. | The highest attack splat on a player with no Protect from Melee is 20, 19 and 18. The highest special splat is 23, 23 and 22. The limits are 21 and 24 with Ultimate Strength, and 25 and 28 with a super strength too (`pvp_melee.rs2:31-33`). | `attack.damage` | A potion in a fight that the traces do not hold. |

### Attack and special

| Claim | Conditions | Evidence | Gap |
|---|---|---|---|
| The dagger attacks each 4 ticks. | 1,019 of 1,113, 974 of 1,148 and 856 of 954 intervals are 4 ticks. | `attack.ticksBetweenAttacks` | None. |
| An eat delays the next attack by 3 ticks. | 21 of 22 intervals with an eat between the two attacks are 7 ticks. | `attack.ticksBetweenAttacksWithAnEat` | None. |
| 12% to 14% of the attacks are specials. | 136 of 1,134, 158 of 1,206 and 142 of 998 attacks. | `attack.specials` | None. |
| The first special is the second attack of a fight in most fights. | The count of attacks before the first special is 0 in 41 fights, 1 in 89 and 2 in 13, of 156 fights with a special. | `attack.specials.attacksBeforeTheFirst` | None. |
| A gang account does not keep the special for a low target. | The Hitpoints of the player before a special are spread over all levels: 94 of 436 specials at 90 to 99, 22 at 39 or less. | `attack.specialAtTargetHp` | None. |
| A gang account attacks a player that runs. | In 2,586 of 3,034 pairs of attacks the player moved between the two attacks. In 676 pairs it moved 8 tiles. | `targets.targetTilesMovedBetweenTwoAttacks` | None. |

### Prayer

| Claim | Conditions | Evidence | Gap |
|---|---|---|---|
| A gang account turns on the protect prayer for the weapon that it sees, 1 to 4 ticks after the weapon change. | The opponent faced the gang account: 1 tick in 41 changes, 2 in 30, 3 in 9, 4 in 5. | `prayer.ticksFromWeaponChangeToPrayer` | Our account Mightyrod is the opponent in most samples. |
| Many weapon changes get no prayer change before the next weapon change. | 33, 5 and 18 weapon changes with no change in 8 ticks, against 17, 10 and 58 with one. | `prayer.ticksFromWeaponChangeToPrayer.noChangeIn8Ticks` | The cause is `unknown`: a slow reaction or no prayer points. |
| Against a bow and a dagger in strict turns the right prayer is on at few attacks. | Goondelf 1 of 55 attack animations, Ligma 1 of 16, Sugma 37 of 95. | `retreat.prayedAgainst` | One live meeting. |
| A protect prayer goes off 3 to 61 ticks after it came on, when no other protect prayer replaces it. | 35 holds: the median is 15 to 18 ticks. | `prayer.ticksAProtectPrayerStaysOn.toOff` | None. |
| A gang account does not flick its protect prayer. | 14 of 138 holds last 2 ticks or less. | `prayer.ticksAProtectPrayerStaysOn.twoTicksOrLess` | A prayer with no head icon is not in the feed. |
| The Monastery is the place where the gang goes more often than the Chaos Temple altar. | 13 visits to the Monastery and 5 to the altar in 14 hours. | `prayer.monasteryVisits`, `prayer.chaosAltarVisits` | The prayer points are `unknown`. |

### Eating

| Claim | Conditions | Evidence | Gap |
|---|---|---|---|
| A gang account eats at 74 Hitpoints or less, and at no higher level. | 33 eats with a splat in the 20 ticks before: 43 to 74 Hitpoints. The median is 66, 64 and 71. | `eating.hpAtEat` | The live meeting holds most of the 33. |
| The eat comes 2 to 4 ticks after the splat in 20 of 33 eats, and 7 to 14 ticks after it in 10. | Counted from the first splat that left 74 or less. The other 3 eats come 37 to 78 ticks after it. | `eating.ticksFrom74HpOrLessToTheEat` | None. |
| A gang account does not eat two items in one tick. | No two eats are 3 ticks or less apart, of 41 eats. | `eating.eatsWithin3TicksOfAnEat` | None. |

### Movement

| Claim | Conditions | Evidence | Gap |
|---|---|---|---|
| The post is (3078, 3640), Wilderness 16, a single-way tile. A gang account stands on it in 64% to 68% of the frames. | 12,295 roster frames. | `group.post`, `movement.place` | None. |
| One gang account is away while two stand on the post in 21% of the frames. All three are away in 22%. | 12,295 frames: 0 away 6,065, 1 away 2,544, 2 away 981, 3 away 2,705. | `group.accountsOffThePostInOneFrame` | The rule that sends one account or three is `unknown`. |
| A gang account leaves the post about 200 times in 14 hours. An attack follows in 38, 50 and 49 of the trips. | The trips with no attack go to a player that leaves the Wilderness, or to the tile (2934, 3516). | `movement.trips` | None. |
| The first attack comes 6 to 419 ticks after the leave. The median is 136, 76 and 96 ticks. | The player is 4 to 317 tiles from the post. The median is 107, 68 and 109 tiles. The edge north of Edgeville is 112 tiles from the post. | `movement.trips.ticksFromLeaveToFirstAttack` | None. |
| A gang account is back on the post 13 to 1,724 ticks after its last attack. The median is 125 to 143 ticks. | 137 trips with an attack. | `movement.trips.ticksFromLastAttackToPost` | None. |
| 98% of the steps are run steps. | 103,365 run steps and 2,303 walk steps. | `movement.steps` | None. |
| A gang account goes up to 323, 317 and 422 tiles from the post. | Roster frames. | `movement.farthestFromPost` | None. |

### Choice of player

| Claim | Conditions | Evidence | Gap |
|---|---|---|---|
| The gang attacks each player that the game lets it attack near the post. | No such player stood 5 frames or more within 30 tiles of a manned post with no attack. | `group.targets.attackableAndNotAttacked` | None. |
| A player of combat 26 to 64 near the post is not a player that the game allows. | The game allows an attack only within as many combat levels as the Wilderness level of the tile. | `group.targets.combatRule` | None. |
| The attacked players have combat 78 to 126. 150 of 226 fights are on a combat 126 player. | The first attack of each fight. | `group.targets.combatOfAttacked` | None. |
| With two or three players in range, the first player attacked is the nearest to the post in 14 of 24 trips. | The players in range at the frame of the leave. | `targets.rankByDistanceFromPostOfTheFirstTarget` | 24 trips. The rule is `unknown`. |
| A gang account keeps its player. | 4 changes to a new player within 40 ticks, in 3,338 attacks. | `targets.targetChange` | None. |
| On a multi-way tile two or three gang accounts hit one player in the same 4 ticks. On a single-way tile one does. | Multi-way: 397 attacks by two and 278 by three, of 1,107. Single-way: 16 of 2,231 by two. | `group.pileOn` | None. |
| A player with no armour on a multi-way tile dies 9 to 20 ticks after the first hit. | 8 kills by two or three gang accounts. | `group.pileOn.kills` | None. |

### Retreat, death and return

| Claim | Conditions | Evidence | Gap |
|---|---|---|---|
| With its food gone, Goondelf attacked for 27 ticks from 39 Hitpoints, then left. It was out of the Wilderness after 91 ticks and back on the post after 1,431. | The live meeting. | `goondelf.json` `retreat.at40HpOrLess` | One sample. |
| With its food gone, Sugma attacked from 36 Hitpoints to its death 36 ticks later. | The live meeting. | `sugma.json` `retreat.at40HpOrLess` | One sample. The rule that picks retreat or fight is `unknown`. |
| A dead gang account appears at Lumbridge (3222, 3218) and is back on the post after 1,154 ticks in its full kit. | The death of Sugma in the live meeting. | `sugma.json` `death` | One sample. |
| A skull stays about 2,000 ticks after the last attack on a new player. | 54 skulls: the median is 2,028 to 2,060 ticks. | `skull` | Whether Protect Item is on is `unknown`. |

### Reaction to our accounts

| Claim | Conditions | Evidence | Gap |
|---|---|---|---|
| A gang account runs after an account of ours that runs, and it does not catch it. | Three combat 126 accounts ran 132 to 138 tiles from (3065, 3659) to the Wilderness edge. Two gang accounts ran after each one and stayed 5 to 15 tiles behind. Our accounts lost no Hitpoints. | `group.nearOurAccounts` | Three walks on one day. |
| A gang account runs across multi-way tiles in a chase. | In the same three walks the gang accounts stood on multi-way tiles in 177 chase ticks. | `group.followsIntoMultiWay` | A fight on a multi-way tile against a squad is `unknown`. |
| After the impact of an Entangle, no gang account attacked in the next 60 ticks. The first step came 5 to 38 ticks after the impact. | 5 impacts by other players. | `targets.frozen` | Bind and Snare have no sample. The caster and its distance are not measured. |
| The gang meets a squad on its walk in, and each gang account fights one of ours on single-way tiles. | Two squad pilots: 4 and 6 kills, 249 and 260 Hitpoints lost a kill, fights of 114 to 386 ticks. | `group.walkIn` (`reported`) | The pilot logs are not on this PC. |

### Schedule

| Claim | Conditions | Evidence | Gap |
|---|---|---|---|
| All three are online in each hour that the traces hold. | The hours 04 to 17 UTC of one day and one hour of a second day. | `schedule` | The other hours and the days of a week are `unknown`. The collector closes this gap. |

## The clones

`scripts/pk-gang-clone.ts` turns the record into a clone of each gang account. A clone has no number of its own.

| Part of a clone | Source in the record | Goondelf | Ligma | Sugma |
|---|---|---|---|---|
| Levels | `levels.skills` | Prayer 99, Magic 37 | Prayer 90, Magic 28 | Prayer 90, Magic 28 |
| Sharks | `kit.foodCount`; the mean of the measured packs for an account with none | 11 | 12 | 13 |
| Eat level | the highest value of `eating.hpAtEat` | 74 | 72 | 74 |
| Prayer wait, as weights of 0, 1, 2 and 3 extra ticks and of no change | `prayer.ticksFromWeaponChangeToPrayer` | 7, 9, 1, 0 and 33 | 6, 1, 3, 0 and 5 | 28, 20, 5, 5 and 18 |
| Walk out with the food gone | `retreat.at40HpOrLess` | at 26 Hitpoints | at 26 Hitpoints (the sample of Goondelf) | no: it fights to its death |

The profiles are `clone-goondelf`, `clone-ligma` and `clone-sugma` of `scripts/pk-spar.ts`. An unknown value is a mode:

- `retreat`: each clone walks out with its food gone. `stand`: none does.
- `lean`: 6 sharks each, the low end of the range of an unknown pack. `full`: 23 sharks each.

The bench cases:

| Case | What it runs |
|---|---|
| `extra:clone-live-check-x1`, `extra:clone-live-check-noanti-x1` | The live meeting again: one of ours against the three clones on the post |
| `extra:clone-solo-<name>-x2` | One of ours in the kit of the squad pilots against one clone, 2 meetings |
| `extra:clone-3v3-walkin-x1`, `extra:clone-4v3-walkin-x1` | The squad from the Edgeville bank to the multi-way post, the clones hunting it, each clone on its own one of ours |
| `extra:clone-squad-<n>-<kit>-x1`, `extra:clone-squad-<n>-chainbind-<mode>-x1` | The same for 3 to 6 of ours in four kits, and against each mode |
| `extra:clone-cycle-solo-x1` | 30 game minutes of one account: kill, pick up, bank trip, return |

The squad script gives every gang account one set of options. So the squad cases use the pooled options of the three
clones (`pooledProfile`), and each clone keeps its own levels and sharks.

## Fidelity

The engine of a clone case serves the world feed (`WORLD_FEED=true`), and `scripts/pk-gang.ts` writes it beside
the case output (`SPAR_FEED`). `scripts/measure/pk-gang-fidelity.ts` reads the bench feed and the live trace with
one reader, so each measure has one definition on both sides.

### The live meeting against the bench

The live meeting is the one of the kit `live-walker-iron` with the three at the post
(`.practice/rival-dds/trace-long-1.jsonl`, the meeting with the most gang attacks on our account). In it our account
did not drink its antipoison. The bench case with no antipoison in the pack is the nearest to the recorded actions.
Bench: seeds 1, 2 and 3, one meeting each. The error is the bench mean against the live value.

| Measure | Live | Bench, no antipoison | Error | Bench, antipoison | Error |
|---|---|---|---|---|---|
| Kills | 1 | 1.3 | +30% | 0.7 | -30% |
| Deaths of ours | 0 | 0 | none | 0 | none |
| Ticks from the first gang attack to the last | 1,082 | 831 | -23% | 808 | -25% |
| Hitpoints lost | 514 | 427 | -17% | 189 | -63% |
| Sharks eaten by ours | 20 | 18 | -10% | 7.3 | -63% |
| Hitpoints lost a gang attack | 3.2 | 3.8 | +19% | 1.8 | -44% |
| Gang attacks in 100 ticks | 15.1 | 13.5 | -11% | 12.9 | -15% |
| Gang specials in 100 attacks | 15.3 | 19.4 | +27% | 21.2 | +39% |
| Damage on the gang an attack of ours | 6.2 | 7.0 | +13% | 7.3 | +18% |
| Gang eats in 1,000 damage on it | 29.3 | 38.3 | +31% | 38.3 | +31% |
| Our attacks on the right prayer in 100 | 23.6 | 6.8 | -71% | 5.7 | -76% |
| Poison in 100 Hitpoints lost | 29.2 | 22.9 | -22% | 0 | -100% |

Raw bench values, no antipoison: Hitpoints lost and kills by seed are in the `BENCH_MEETING` lines of
`bun scripts/measure/pk-gang-fidelity.ts table <trace> mightyrod <feed files>`. With the antipoison left out, as it was live,
the clone is within 20% of the live meeting on Hitpoints lost and on sharks eaten.

### The squad pilots against the bench

The two squad pilots lost 249 and 260 Hitpoints a kill in one-on-one fights of 114 to 386 ticks (`reported`,
`group.walkIn`). The bench fight is one of ours in the pilots' kit against one clone
(`extra:clone-solo-<name>-x2`). Each clone has 6 meetings on seeds 1, 2 and 3. No account of ours died.

| Clone | Kills of 6 | Hitpoints lost | Poison in it | Ticks of the 6 fights |
|---|---|---|---|---|
| Goondelf | 0 (it walks out) | 425 | 143 | 139 to 203 |
| Ligma | 0 (it walks out) | 586 | 260 | 153 to 241 |
| Sugma | 6 | 415 | 108 | 171 to 212 |
| All three | 6 of 18 | 1,426: 238 a kill | 511 | 139 to 241 |

The bench gives 238 Hitpoints a kill against 249 and 260 live: an error of -4% and -8%. Each bench fight is inside the
live range of 114 to 386 ticks.

### What the bench does not copy

| Gap | Numbers | Cause | What closes it |
|---|---|---|---|
| The right prayer of the gang meets fewer of our attacks | 6.8 in 100 on the bench, 23.6 live | Live, our attack comes a tick or more after our weapon change, so a late prayer is in time. On the bench our account changes its weapon and attacks in one tick. | A fight option that waits one tick between the weapon change and the attack (`scripts/pk.ts`) |
| A clone eats more for the same damage | 38.3 eats in 1,000 damage, 29.3 live | A clone eats in the first tick at its eat level. Live, the eat comes 2 to 4 ticks later in 20 of 33 eats and 7 to 14 ticks later in 10. | A fight option for the wait before an eat (`scripts/pk.ts`) |
| A hit of a clone always shows one tick after its animation | Bench: 113 of 113 attacks. Live: 1,334 in the tick of the animation and 1,501 one tick later | The engine takes the players in the order of their slots. On the bench our account logs in first. | A case in which the clones log in first |
| Our antipoison | 150 Hitpoints of poison live, none on the bench with the potion | On the bench the fight loop finds a tick for the drink. Live it found none. | `cureNow` in the live options; the squad options have it |
| A dead clone does not come back | Live: back on the post after 1,154 ticks | The harness ends a clone at its death | A return of a dead gang account in `scripts/pk-squad.ts` |
| One set of options for the three clones in a squad case | The prayer wait differs: 33 of 50 changes with no prayer for Goondelf, 18 of 76 for Sugma | `scripts/pk-squad.ts` names one profile for the gang | A profile for each gang account in `scripts/pk-squad.ts` |

The offline simulator `scripts/pk-sim.ts` is not used for these numbers. It has no model of the walk out, of the
prayer wait or of poison. Each of the three moves the cost of a kill.

## The climb

The squad (`scripts/pk-squad.ts`) walks from the Edgeville bank to the multi-way post (3067, 3640). The three clones
hunt it, each clone on its own one of ours (`extra:clone-squad-*`). `scripts/measure/pk-gang-climb.ts` makes the table
from the case logs.

Conditions of the table: one hosted bench run a condition, lockstep seed 7. One run does not separate two conditions,
so the table ranks candidates and makes no win claim. The hosted bench takes no seed input. Three matched seeds a
condition are the next step.

A dead gang account is back on its post after 1,154 ticks (`death`). So the kills of an hour are 9,000 ticks times
the kills of a run, over the ticks of a run plus 1,154. That wait bounds each squad that kills all three.

No account of ours died in any of the 42 conditions.

| Condition | Kills of 3 | Hitpoints lost a kill | Ticks a run | Kills an hour | Account ticks a kill |
|---|---|---|---|---|---|
| 3 of ours, rune chainbody kit with Bind and antipoison (`chainbind`) | 3 | 34 | 589 | 15.5 | 589 |
| 4 of ours, `chainbind` (the base) | 3 | 39 | 543 | 15.9 | 724 |
| 5 of ours, `chainbind` | 3 | 16 | 459 | 16.7 | 765 |
| 6 of ours, `chainbind` | 3 | 12 | 445 | 16.9 | 890 |
| 4 of ours, no rune and no antipoison (`chainbare`) | 1 | 83 | 603 | 5.1 | 2,412 |
| 5 of ours, `chainbare` | 2 | 160 | 792 | 9.2 | 1,980 |
| 4 of ours, full rune | 3 | 42 | 570 | 15.7 | 760 |
| 4 of ours, dragonhide | 3 | 17 | 464 | 16.7 | 619 |
| 4 of ours, two members with no bow | 3 | 42 | 549 | 15.9 | 732 |
| 4 of ours, no member with a bow | 3 | 52 | 661 | 14.9 | 881 |
| 4 of ours, the gang's single-way post | 2 | 121 | 688 | 9.8 | 1,376 |
| 4 of ours, the east multi-way post | 3 | 38 | 715 | 14.4 | 953 |
| 4 of ours, melee only | 3 | 41 | 669 | 14.8 | 892 |
| 4 of ours, ranged only | 3 | 51 | 614 | 15.3 | 819 |
| 4 of ours, no freeze | 3 | 26 | 545 | 15.9 | 727 |
| 4 of ours, no chase | 2 | 22 | 553 | 10.5 | 1,106 |
| 4 of ours, eat at 50 | 3 | 35 | 561 | 15.7 | 748 |
| 4 of ours, eat at 70 | 2 | 190 | 716 | 9.6 | 1,432 |
| 4 of ours, the special from the first health bar | 3 | 35 | 518 | 16.1 | 691 |
| 4 of ours against clones that all walk out (`retreat`) | 3 | 14 | 520 | 16.1 | 693 |
| 4 of ours against clones that all stand (`stand`) | 3 | 38 | 559 | 15.8 | 745 |
| 4 of ours against clones with 6 sharks (`lean`) | 2 | 25 | 519 | 10.8 | 1,038 |
| 4 of ours against clones with 23 sharks (`full`) | 3 | 25 | 501 | 16.3 | 668 |
| 5 of ours against each of the four modes | 3 | 14 | 439 | 16.9 | 732 |

What the table shows on this seed:

- **The freeze runes and the antipoison decide a small squad.** Four in the kit with neither kill 1 of 3. Four with both kill 3 of 3.
- **Five of ours kill all three in each mode of the clones.** Four lose one kill against the clones with 6 sharks.
- **The multi-way post is cheaper than the gang's own post.** 39 Hitpoints a kill against 121.
- **Bow and dagger in turns is not worse than one style.** 39 Hitpoints a kill against 41 for melee only and 51 for ranged only.
- **More accounts cut the Hitpoints of a kill and not its account ticks.** Three of ours need 589 account ticks a kill and six need 890.

The candidate squad is `scripts/pk-gang-record/squad-candidate.json`: five of ours in the kit rule `gang-chain-bind`,
the multi-way post, the default options of the squad script.

The pilot again: four of ours in the pilots' kit with no march and no pull lose 46 Hitpoints a kill on the bench
(`extra:clone-pilot-4-chainbare-nomarch-x1`), against 249 live. On the gang's single-way post the same four kill
none and lose 631 Hitpoints (`extra:clone-pilot-4-chainbare-single-x1`). The live pilot lies between the two: it
fought on single-way tiles on the walk in. The squad script of the pilot had no rule that leaves a refused fight;
the script of the bench has it. So the squad cases do not copy the pilots, and the first live squad run is the check
of the clones at squad size (`scripts/measure/pk-gang-drift.ts squad`).

Not measured:

- Three matched seeds a condition, and the winner over more seeds.
- Lobsters: the two cases end with no fight. The bank trip of the squad takes sharks only.
- A style rule for each gang account, and a kill order. The squad script has one option set and takes the lowest health bar.
- Arrows and runes a kill: the RESULT line of the squad does not hold them.
- The repeat cycle of 30 minutes: a dead clone does not come back.

## Keep it true

`scripts/measure/pk-gang-drift.ts` compares new observations with the record:

- `feed <trace ...>`: the measures of new collector files against the record. It prints a `DRIFT` line for a new worn
  item, a changed combat level or a higher hit. It prints one too for a higher eat level, a prayer that changes less
  often or a new post.
  A share with under 20 samples does not drift.
- `squad <kills> <Hitpoints lost> <ticks> <bench output ...>`: one live squad run against the mean of the clone
  runs. It prints `DRIFT` when the cost of a kill is more than 50% away from the prediction.

After a `DRIFT` line, build the record again, run the clone cases, and climb again from the new clones.

## Unknowns

Each unknown has the observation that closes it in its data file (`closes`).

| Unknown | Observation that closes it |
|---|---|
| The pack: the number of sharks, potions, runes | A tick record of a squad run that takes a gang account to its retreat: the eats of one fight are its pack |
| The prayer points, and the prayers with no head icon | A tick record of a long fight: the tick at which the head icon goes off for good under attack |
| Whether the gang attacks a squad on a multi-way tile | A tick record of a squad run on the multi-way tiles west of the post |
| What a gang account does under Bind | A squad run with Bind runes, or a freeze impact on a gang account in a collector file |
| The rule that picks one of several players | More trips with two or more players in range in the collector files |
| The rule that picks retreat or a fight to the death | More fights that take a gang account to 40 Hitpoints or less |
| The hours of a week | The collector for 7 days |
