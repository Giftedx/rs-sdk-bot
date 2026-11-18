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
| The worn items are a black wizard hat, a monk's robe top and bottom and a dragon dagger (p). | 1,288, 1,376 and 1,145 appearance blocks hold that set. One block of Sugma after its death holds the hat and the dagger only. | `kit.worn`, `death` | The pack is not in the feed. |
| The dagger poison starts at 4. | 108 poison splats of 4 and 12 of other sizes on players within 2 ticks of an attack. | `kit.weaponPoison` | None. |
| The food heals 20: a shark. | 27 eats with a splat before and after each one. | `kit.food` | None. |
| The pack holds 11 sharks (Goondelf) and 13 (Sugma). | The eats of the live meeting, in which the food of both ran out. | `kit.foodCount` | One meeting. A refill at the bank would add to the count. The pack of Ligma is `unknown`: it ate 6 and its food did not run out. |
| A gang account also plays the eat animation when it needs no Hitpoints. | 8 such animations at 96 Hitpoints or more, or far from a fight. A drink plays the same animation (`anti_poison.rs2:3`). | `kit.consumesNotForHitpoints` | The item is `unknown`: a potion or a food item from loot. |
| A Strength prayer is on, and no Strength potion is in use. | The highest attack splat on a player with no Protect from Melee is 20, 19 and 18. The highest special splat is 23, 23 and 22. The limits are 21 and 24 with Ultimate Strength, and 25 and 28 with a super strength too (`pvp_melee.rs2:31-33`). | `attack.damage` | A potion in a fight that the traces do not hold. |

### Attack and special

| Claim | Conditions | Evidence | Gap |
|---|---|---|---|
| The dagger attacks each 4 ticks. | 1,042 of 1,138, 991 of 1,165 and 876 of 975 intervals are 4 ticks. | `attack.ticksBetweenAttacks` | None. |
| An eat delays the next attack by 3 ticks. | 21 of 22 intervals with an eat between the two attacks are 7 ticks. | `attack.ticksBetweenAttacksWithAnEat` | None. |
| 12% to 14% of the attacks are specials. | 141 of 1,158, 162 of 1,222 and 147 of 1,021 attacks. | `attack.specials` | None. |
| The first special is the second attack of a fight in most fights. | The count of attacks before the first special is 0 in 43 fights, 1 in 91 and 2 in 13, of 162 fights with a special. | `attack.specials.attacksBeforeTheFirst` | None. |
| A gang account does not keep the special for a low target. | The Hitpoints of the player before a special are spread over all levels: 96 of 450 specials at 90 to 99, 22 at 39 or less. | `attack.specialAtTargetHp` | None. |
| A gang account attacks a player that runs. | In 2,619 of 3,089 pairs of attacks the player moved between the two attacks. In 689 pairs it moved 8 tiles. | `targets.targetTilesMovedBetweenTwoAttacks` | None. |

### Prayer

| Claim | Conditions | Evidence | Gap |
|---|---|---|---|
| A gang account turns on the protect prayer for the weapon that it sees, 1 to 4 ticks after the weapon change. | The opponent faced the gang account: 1 tick in 41 changes, 2 in 30, 3 in 9, 4 in 5. | `prayer.ticksFromWeaponChangeToPrayer` | Our account Mightyrod is the opponent in most samples. |
| Many weapon changes get no prayer change before the next weapon change. | 33, 5 and 18 weapon changes with no change in 8 ticks, against 17, 10 and 58 with one. | `prayer.ticksFromWeaponChangeToPrayer.noChangeIn8Ticks` | The cause is `unknown`: a slow reaction or no prayer points. |
| Against a bow and a dagger in strict turns the right prayer is on at few attacks. | Goondelf 1 of 55 attack animations, Ligma 1 of 16, Sugma 37 of 95. | `retreat.prayedAgainst` | One live meeting. |
| A protect prayer goes off 3 to 61 ticks after it came on, when no other protect prayer replaces it. | 36 holds: the median is 15 to 18 ticks. | `prayer.ticksAProtectPrayerStaysOn.toOff` | None. |
| A gang account does not flick its protect prayer. | 14 of 139 holds last 2 ticks or less. | `prayer.ticksAProtectPrayerStaysOn.twoTicksOrLess` | A prayer with no head icon is not in the feed. |
| The Monastery is the place where the gang goes more often than the Chaos Temple altar. | 13 visits to the Monastery and 8 to the altar in 14 hours. | `prayer.monasteryVisits`, `prayer.chaosAltarVisits` | The prayer points are `unknown`. |

### Eating

| Claim | Conditions | Evidence | Gap |
|---|---|---|---|
| A gang account eats at 74 Hitpoints or less, and at no higher level. | 33 eats with a splat in the 20 ticks before: 43 to 74 Hitpoints. The median is 66, 64 and 71. | `eating.hpAtEat` | The live meeting holds most of the 33. |
| The eat comes 2 to 4 ticks after the splat in 20 of 33 eats, and 7 to 14 ticks after it in 10. | Counted from the first splat that left 74 or less. The other 3 eats come 37 to 78 ticks after it. | `eating.ticksFrom74HpOrLessToTheEat` | None. |
| A gang account does not eat two items in one tick. | No two eats are 3 ticks or less apart, of 41 eats. | `eating.eatsWithin3TicksOfAnEat` | None. |

### Movement

| Claim | Conditions | Evidence | Gap |
|---|---|---|---|
| The post is (3078, 3640), Wilderness 16, a single-way tile. A gang account stands on it in 64% to 68% of the frames. | 12,349 roster frames. | `group.post`, `movement.place` | None. |
| One gang account is away while two stand on the post in 21% of the frames. All three are away in 22%. | 12,349 frames: 0 away 6,065, 1 away 2,545, 2 away 982, 3 away 2,757. | `group.accountsOffThePostInOneFrame` | The rule that sends one account or three is `unknown`. |
| A gang account leaves the post about 200 times in 14 hours. An attack follows in 38, 50 and 49 of the trips. | The trips with no attack go to a player that leaves the Wilderness, or to the tile (2934, 3516). | `movement.trips` | None. |
| The first attack comes 6 to 419 ticks after the leave. The median is 136, 76 and 96 ticks. | The player is 4 to 317 tiles from the post. The median is 107, 68 and 109 tiles. The edge north of Edgeville is 112 tiles from the post. | `movement.trips.ticksFromLeaveToFirstAttack` | None. |
| A gang account is back on the post 13 to 1,724 ticks after its last attack. The median is 125 to 143 ticks. | 137 trips with an attack. | `movement.trips.ticksFromLastAttackToPost` | None. |
| 98% of the steps are run steps. | 104,498 run steps and 2,334 walk steps. | `movement.steps` | None. |
| A gang account goes up to 323, 317 and 422 tiles from the post. | Roster frames. | `movement.farthestFromPost` | None. |

### Choice of player

| Claim | Conditions | Evidence | Gap |
|---|---|---|---|
| The gang attacks each player that the game lets it attack near the post. | No such player stood 5 frames or more within 30 tiles of a manned post with no attack. | `group.targets.attackableAndNotAttacked` | None. |
| A player of combat 26 to 64 near the post is not a player that the game allows. | The game allows an attack only within as many combat levels as the Wilderness level of the tile. | `group.targets.combatRule` | None. |
| The attacked players have combat 78 to 126. 156 of 236 fights are on a combat 126 player. | The first attack of each fight. | `group.targets.combatOfAttacked` | None. |
| With two or three players in range, the first player attacked is the nearest to the post in 14 of 24 trips. | The players in range at the frame of the leave. | `targets.rankByDistanceFromPostOfTheFirstTarget` | 24 trips. The rule is `unknown`. |
| A gang account keeps its player. | 4 changes to a new player within 40 ticks, in 3,401 attacks. | `targets.targetChange` | None. |
| On a multi-way tile two or three gang accounts hit one player in the same 4 ticks. On a single-way tile one does. | Multi-way: 419 attacks by two and 278 by three, of 1,132. Single-way: 17 of 2,269 by two. | `group.pileOn` | None. |
| A player with no armour on a multi-way tile dies 9 to 20 ticks after the first hit. | 8 kills by two or three gang accounts. | `group.pileOn.kills` | None. |

### Retreat, death and return

| Claim | Conditions | Evidence | Gap |
|---|---|---|---|
| With its food gone, Goondelf attacked for 27 ticks from 39 Hitpoints, then left at 26 Hitpoints from Wilderness level 15. It was out of the Wilderness after 91 ticks and back on the post after 1,431. | The live meeting. | `goondelf.json` `retreat.at40HpOrLess` | One sample. |
| With its food gone, Sugma attacked from 36 Hitpoints to its death 36 ticks later. | The live meeting. | `sugma.json` `retreat.at40HpOrLess` | One sample. The rule that picks retreat or fight is `unknown`. |
| A dead gang account appears at Lumbridge (3222, 3218) and is back on the post after 1,154 ticks in its full kit. | The death of Sugma in the live meeting. | `sugma.json` `death`, `group.returnToPost` | One sample. After its walk out Goondelf was back after 1,431 ticks. |
| A gang account attacks with melee only. | No animation of a gang account is a cast or a shot, of all its animations. | `kit.runes`, `attack.animations` | None. |
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
| Sharks | `kit.foodCount` | 11 | 17: the middle of its range of 6 to 28 | 13 |
| Eat level | the median of `eating.hpAtEat` | 66 | 64 | 71 |
| Style | `kit.runes`: no cast and no shot | melee | melee | melee |
| Special | the highest band of `attack.specialAtTargetHp` | at any Hitpoints | at any Hitpoints | at any Hitpoints |
| Prayer wait, as weights of 0, 1, 2 and 3 extra ticks and of no change in the window | `prayer.ticksFromWeaponChangeToPrayer` | 7, 9, 1, 0 and 33 | 6, 1, 3, 0 and 5 | 28, 20, 5, 5 and 18 |
| Flick | `prayer.ticksAProtectPrayerStaysOn`: under half of the holds are 2 ticks or less | no | no | no |
| Walk out with the food gone | `retreat.at40HpOrLess` of the account itself | at 26 Hitpoints | 33: the middle of its range of 26 to 40 | no: it fought to its death |

A value of one account is never the sample of another account. An account with a sample keeps it in every mode.
An account with no sample has a range in its record:

- The pack of Ligma: from its 6 eats in a fight in which its food did not run out, to the 28 slots of a pack.
- The walk out of Ligma: from the lowest Hitpoints at the last attack of an account that walked out (26), to the 40
  Hitpoints at which the measure starts.

A mode takes one end of a range. Only Ligma has ranges, so a mode changes Ligma only:

| Mode | Ligma walks out at | Ligma has sharks |
|---|---|---|
| `seen` (the base) | 33 | 17 |
| `retreat` | 40 | 17 |
| `stand` | never | 17 |
| `lean` | 33 | 6 |
| `full` | 33 | 28 |

The profiles are `clone-goondelf`, `clone-ligma` and `clone-sugma`, each with `-retreat` and `-stand`.
`scripts/pk-spar.ts` builds one on the first use of its name, so a script that names no clone reads no record.

The squad script gives every gang account one set of options. So a squad case uses the pooled options of the three
clones (`pooledProfile`): the prayer waits and the eat levels as one, and the highest walk out of the three. Each
clone keeps its own levels and sharks. In a squad case the modes are these:

| Mode | Each of the three clones walks out at | Ligma has sharks |
|---|---|---|
| `seen` (the base) | 33 | 17 |
| `retreat` | 40 | 17 |
| `stand` | never | 17 |
| `lean` | 33 | 6 |
| `full` | 33 | 28 |

So in a squad case Goondelf and Sugma do not have their own walk out. A profile for each gang account in the squad
script closes that.

The bench cases:

| Case | What it runs |
|---|---|
| `extra:clone-live-check-x1`, `extra:clone-live-check-noanti-x1` | The live meeting again: one of ours against the three clones on the post |
| `extra:clone-solo-<name>-x2` | One of ours in the kit of the squad pilots against one clone, 2 meetings |
| `extra:clone-3v3-walkin-x1`, `extra:clone-4v3-walkin-x1` | The squad from the Edgeville bank to the multi-way post, the clones hunting it, each clone on its own one of ours |
| `extra:clone-cycle-solo-x1` | 30 game minutes of one account: kill, pick up, bank trip, return |

## Fidelity

The engine of a clone case serves the world feed (`WORLD_FEED=true`). `scripts/pk-gang.ts` writes the feed beside
the case output (`SPAR_FEED`) and prints the measures of each meeting into the case log (`FEED_MEETING`).
`scripts/measure/pk-gang-fidelity.ts` reads the bench feed and the live trace with one reader, so each measure has
one definition on both sides.

### The live meeting against the bench

The live meeting is the one of the kit `live-walker-iron` with the three at the post
(`.practice/rival-dds/trace-long-1.jsonl`). Bench: hosted runners, lockstep seeds 1, 2 and 3, one meeting each
(run 44265559154). The error is the bench mean against the live value.

The reader: a meeting is the gang attacks on our account with no gap of 300 ticks. A trace gives its meeting with the
most gang attacks, from the first gang attack to the last. Poison after the last attack and a later meeting are not
counted. The live trace holds two short meetings before the long one. The rows "all meetings" count every meeting
(`--all`).

Both bench cases are stated. In the live meeting our account carried an antipoison and did not drink it.

| Measure | Live | No antipoison in the pack | Error | Antipoison in the pack | Error |
|---|---|---|---|---|---|
| Kills | 1 | 1.3 | +30% | 0.7 | -30% |
| Ticks from the first gang attack to the last | 1,082 | 773 | -29% | 783 | -28% |
| Hitpoints lost | 514 | 380 | -26% | 250 | -51% |
| Sharks eaten by ours | 20 | 15.0 | -25% | 10.0 | -50% |
| Hitpoints lost a gang attack | 3.2 | 3.9 | +22% | 2.1 | -34% |
| Gang attacks in 100 ticks | 15.1 | 12.5 | -17% | 15.0 | -1% |
| Gang specials in 100 attacks | 15.3 | 21.6 | +41% | 19.3 | +26% |
| Damage on the gang an attack of ours | 6.2 | 6.5 | +5% | 6.9 | +11% |
| Gang eats in 1,000 damage on it | 29.3 | 35.3 | +20% | 38.9 | +33% |
| Our attacks on the right prayer in 100 | 23.6 | 11.5 | -51% | 6.9 | -71% |
| Poison in 100 Hitpoints lost | 29.2 | 26.7 | -9% | 19.3 | -34% |
| Hitpoints lost, all meetings | 539 | 425 | -21% | 404 | -25% |
| Sharks eaten by ours, all meetings | 20 | 16.0 | -20% | 17.0 | -15% |
| Kills, all meetings | 1 | 2.0 | +100% | 1.0 | 0% |

The clones take 21% to 51% fewer Hitpoints from our account than the live gang did, by the case and the reader. The
live gang took 1.27 to 2.05 times the Hitpoints that the clones take: 1.35 times in the case with no antipoison.
Our attacks do 1.05 to 1.11 times the live damage on the gang. Three bench meetings and one live meeting: a
difference under about 20% is not separated.

### The squad pilots against the bench

The live side is two reported figures, not a trace: the two squad pilots lost 249 and 260 Hitpoints a kill in
one-on-one fights of 114 to 386 ticks (`group.walkIn`, `reported`). So this comparison has no common reader.
The bench fight is one of ours in the pilots' kit against one clone (`extra:clone-solo-<name>-x2`). Each clone has
6 meetings on seeds 1, 2 and 3. No account of ours died.

| Clone | Kills of 6 | Hitpoints lost | Poison in it | Ticks of the 6 fights |
|---|---|---|---|---|
| Goondelf | 3 | 642 | 249 | 150 to 206 |
| Ligma | 1 | 613 | 258 | 168 to 268 |
| Sugma | 6 | 448 | 120 | 179 to 231 |
| All three | 10 of 18 | 1,703: 170 a kill | 627 | 150 to 268 |

The bench gives 170 Hitpoints a kill against 249 and 260 reported: -32% and -35%. Each bench fight is inside the
reported range.

### What the bench does not copy

| Gap | Numbers | Cause | What closes it |
|---|---|---|---|
| The right prayer of the gang meets fewer of our attacks | 6.9 to 11.5 in 100 on the bench, 23.6 live | Live, our attack comes a tick or more after our weapon change, so a late prayer is in time. On the bench our account changes its weapon and attacks in one tick. | A fight option that waits one tick between the weapon change and the attack (`scripts/pk.ts`) |
| A clone eats more for the same damage | 35.3 to 38.9 eats in 1,000 damage, 29.3 live | A clone eats its whole pack and takes more at its bank. Live, Ligma ate 6 and left for another player. A clone eats in the first tick at its eat level. Live, the eat comes 2 to 4 ticks later in 20 of 33 eats. | A fight option for the wait before an eat (`scripts/pk.ts`), and a clone that leaves for another player |
| A hit of a clone always shows one tick after its animation | Bench: 113 of 113 attacks. Live: 1,334 in the tick of the animation and 1,501 one tick later | The engine takes the players in the order of their slots. On the bench our account logs in first. | A case in which the clones log in first |
| Our antipoison | 150 Hitpoints of poison live. On the bench with the potion in the pack: 48 a meeting (run 44265559154) | The fight loop drinks only in a tick with 3 ticks to the next attack. | `cureNow` in the live options; the squad options have it |
| A dead clone does not come back | Live: back on the post after 1,154 ticks | The harness ends a clone at its death | A return of a dead gang account in `scripts/pk-squad.ts` |
| One set of options for the three clones in a squad case | The prayer wait differs: 33 of 50 changes with no prayer for Goondelf, 18 of 76 for Sugma. The walk out differs: 26, a range, never | `scripts/pk-squad.ts` names one profile for the gang | A profile for each gang account in `scripts/pk-squad.ts` |

The offline simulator `scripts/pk-sim.ts` is not used for these numbers. It has no model of the walk out, of the
prayer wait or of poison. Each of the three moves the cost of a kill.

## The climb

The squad (`scripts/pk-squad.ts`) walks from the Edgeville bank to the multi-way post (3067, 3640). The three clones
hunt it, each clone on its own one of ours (`extra:clone-squad-*`). Each case passes the squad script no argument
of the fight, so the post, the march, the pull and the options are the defaults of the script.
`scripts/measure/pk-gang-climb.ts` makes the tables from the case logs.

Conditions: hosted runners, lockstep. Every condition ran on seeds 1, 2 and 3 (run 44265865486). The squads of
three, four and five in each mode also ran on seeds 4, 5 and 6 (run 44265870254). A run has three gang accounts, so
three seeds are 9 possible kills.

How to read the columns:

- **Kills an hour.** A dead gang account is back on its post after 1,154 ticks (`group.returnToPost`, one sample).
  The kills of an hour are 9,000 ticks times the kills of a run, over the ticks of a run plus that wait. The wait
  bounds each squad that kills all three.
- **Times 1.35.** The live gang took 1.35 times the Hitpoints from our account that the clones take (the fidelity
  table, the case with no antipoison; the range is 1.27 to 2.05). The column is the live estimate of the Hitpoints
  of a kill.
- **With ticks times 1.1.** Our bench attacks do about 1.1 times the live damage on the gang (1.05 to 1.11). The
  column is the kills of an hour with the ticks of a run times 1.1.
- **The spread of one condition.** A seed gives the same squad another result after a change of the case list. The base (four of ours) lost 20, 27 and 113 Hitpoints on seeds 1, 2 and 3. A difference between two rows of under about 20 Hitpoints a kill, or of one kill in nine, is
  inside that spread.

Each number is provisional where a fight option that the clones do not have yet would change it: the wait before an
eat, the tick between our weapon change and our attack, and the login order of the players.

### Squad size and clone mode, seeds 1 to 6

| Squad, kit `chainbind` | Clone mode | Kills | Deaths of ours | Hitpoints lost a kill | Times 1.35 | Ticks a run | Kills an hour | With ticks times 1.1 |
|---|---|---|---|---|---|---|---|---|
| 3 of ours | base | 14 of 18 | 1 | 41 | 55 | 677 | 11.5 | 11.1 |
| 4 of ours | base | 18 of 18 | 0 | 18 | 24 | 556 | 15.8 | 15.3 |
| 4 of ours | `retreat` | 18 of 18 | 0 | 26 | 35 | 563 | 15.7 | 15.2 |
| 4 of ours | `stand` | 18 of 18 | 0 | 19 | 26 | 540 | 15.9 | 15.4 |
| 4 of ours | `lean` | 17 of 18 | 0 | 23 | 31 | 556 | 14.9 | 14.5 |
| 4 of ours | `full` | 16 of 18 | 0 | 31 | 42 | 548 | 14.1 | 13.7 |
| 5 of ours | base | 18 of 18 | 0 | 16 | 22 | 483 | 16.5 | 16.0 |
| 5 of ours | `retreat` | 18 of 18 | 0 | 21 | 28 | 480 | 16.5 | 16.1 |
| 5 of ours | `stand` | 18 of 18 | 0 | 18 | 24 | 464 | 16.7 | 16.2 |
| 5 of ours | `lean` | 18 of 18 | 0 | 17 | 23 | 475 | 16.6 | 16.1 |
| 5 of ours | `full` | 18 of 18 | 0 | 18 | 24 | 468 | 16.6 | 16.2 |

- **Five of ours kill 90 of 90 gang clones with no death of ours**, over six seeds and the five modes.
- **Four of ours kill 87 of 90 with no death of ours.** The lost kills are against Ligma with 28 sharks (2) and with
  6 sharks (1).
- **Three of ours are not safe.** They kill 14 of 18, and one account of ours died (seed 6: 1 kill, 1 death). It
  died at Wilderness level 2 on its way out, at 1 Hitpoint.

### Every condition, seeds 1 to 3

The last column is the Hitpoints lost of each seed.

| Condition | Kills | Deaths of ours | Hitpoints lost a kill | Times 1.35 | Ticks a run | Kills an hour | With ticks times 1.1 | Account ticks a kill | Hitpoints lost by seed |
|---|---|---|---|---|---|---|---|---|---|
| `pilot-4-chainbare-nomarch` | 9 of 9 | 0 | 17 | 23 | 558 | 15.8 | 15.3 | 744 | 37, 51, 61 |
| `pilot-4-chainbare-single` | 1 of 9 | 0 | 1460 | 1971 | 810 | 1.5 | 1.4 | 9724 | 525, 113, 822 |
| `squad-3-chainbare` | 6 of 9 | 0 | 115 | 155 | 759 | 9.4 | 9 | 1139 | 278, 178, 236 |
| `squad-3-chainbind` | 7 of 9 | 0 | 49 | 66 | 717 | 11.2 | 10.8 | 922 | 70, 155, 116 |
| `squad-3-dhide` | 9 of 9 | 0 | 32 | 43 | 487 | 16.5 | 16 | 487 | 71, 93, 123 |
| `squad-3-rune` | 7 of 9 | 0 | 50 | 68 | 742 | 11.1 | 10.7 | 954 | 80, 138, 130 |
| `squad-4-chainbare` | 7 of 9 | 0 | 29 | 39 | 568 | 12.2 | 11.8 | 974 | 51, 93, 61 |
| `squad-4-chainbind-east` | 8 of 9 | 0 | 29 | 39 | 717 | 12.8 | 12.3 | 1076 | 53, 72, 108 |
| `squad-4-chainbind-eat50` | 9 of 9 | 0 | 17 | 23 | 524 | 16.1 | 15.6 | 699 | 33, 34, 83 |
| `squad-4-chainbind-eat70` | 8 of 9 | 0 | 23 | 31 | 542 | 14.2 | 13.8 | 813 | 38, 48, 94 |
| `squad-4-chainbind-focus7` | 9 of 9 | 0 | 19 | 26 | 546 | 15.9 | 15.4 | 728 | 53, 27, 94 |
| `squad-4-chainbind-freezelow` | 9 of 9 | 0 | 16 | 22 | 535 | 16 | 15.5 | 713 | 60, 31, 55 |
| `squad-4-chainbind-full` | 7 of 9 | 0 | 42 | 57 | 567 | 12.2 | 11.8 | 972 | 155, 44, 94 |
| `squad-4-chainbind-lean` | 8 of 9 | 0 | 17 | 23 | 563 | 14 | 13.6 | 845 | 45, 51, 42 |
| `squad-4-chainbind-melee` | 8 of 9 | 0 | 80 | 108 | 701 | 12.9 | 12.4 | 1052 | 157, 136, 348 |
| `squad-4-chainbind-nobow` | 7 of 9 | 0 | 91 | 123 | 707 | 11.3 | 10.9 | 1213 | 240, 220, 175 |
| `squad-4-chainbind-nobow2` | 9 of 9 | 0 | 35 | 47 | 580 | 15.6 | 15.1 | 773 | 99, 102, 111 |
| `squad-4-chainbind-nochase` | 7 of 9 | 0 | 41 | 55 | 574 | 12.2 | 11.8 | 983 | 53, 28, 203 |
| `squad-4-chainbind-nofreeze` | 8 of 9 | 0 | 27 | 36 | 597 | 13.7 | 13.2 | 896 | 47, 64, 107 |
| `squad-4-chainbind-nomarch` | 9 of 9 | 0 | 18 | 24 | 528 | 16.1 | 15.6 | 704 | 38, 28, 94 |
| `squad-4-chainbind-ranged` | 9 of 9 | 0 | 25 | 34 | 643 | 15 | 14.5 | 857 | 44, 79, 106 |
| `squad-4-chainbind-retreat` | 9 of 9 | 0 | 15 | 20 | 548 | 15.9 | 15.4 | 731 | 45, 35, 58 |
| `squad-4-chainbind-single` | 7 of 9 | 0 | 100 | 135 | 689 | 11.4 | 11 | 1181 | 283, 270, 147 |
| `squad-4-chainbind-spec1` | 7 of 9 | 0 | 15 | 20 | 537 | 12.4 | 12 | 920 | 33, 44, 26 |
| `squad-4-chainbind-stand` | 9 of 9 | 0 | 15 | 20 | 539 | 15.9 | 15.4 | 719 | 42, 46, 51 |
| `squad-4-chainbind` | 9 of 9 | 0 | 18 | 24 | 572 | 15.6 | 15.1 | 762 | 20, 27, 113 |
| `squad-4-dhide` | 9 of 9 | 0 | 31 | 42 | 469 | 16.6 | 16.1 | 625 | 104, 41, 130 |
| `squad-4-rune` | 9 of 9 | 0 | 24 | 32 | 552 | 15.8 | 15.3 | 736 | 38, 72, 102 |
| `squad-5-chainbare` | 9 of 9 | 0 | 24 | 32 | 509 | 16.2 | 15.7 | 849 | 56, 82, 82 |
| `squad-5-chainbind-anti0-food` | 9 of 9 | 0 | 16 | 22 | 506 | 16.3 | 15.8 | 843 | 41, 34, 72 |
| `squad-5-chainbind-anti0` | 9 of 9 | 0 | 30 | 41 | 464 | 16.7 | 16.2 | 773 | 94, 49, 124 |
| `squad-5-chainbind-anti1` | 9 of 9 | 0 | 26 | 35 | 493 | 16.4 | 15.9 | 822 | 75, 79, 79 |
| `squad-5-chainbind-anti2-food` | 9 of 9 | 0 | 28 | 38 | 480 | 16.5 | 16 | 799 | 93, 79, 80 |
| `squad-5-chainbind-anti2` | 9 of 9 | 0 | 19 | 26 | 488 | 16.4 | 15.9 | 813 | 78, 30, 62 |
| `squad-5-chainbind-full` | 9 of 9 | 0 | 17 | 23 | 469 | 16.6 | 16.1 | 782 | 32, 45, 77 |
| `squad-5-chainbind-lean` | 9 of 9 | 0 | 12 | 16 | 494 | 16.4 | 15.9 | 823 | 11, 52, 41 |
| `squad-5-chainbind-retreat` | 9 of 9 | 0 | 22 | 30 | 483 | 16.5 | 16 | 806 | 88, 47, 65 |
| `squad-5-chainbind-stand` | 9 of 9 | 0 | 17 | 23 | 460 | 16.7 | 16.2 | 767 | 45, 52, 56 |
| `squad-5-chainbind` | 9 of 9 | 0 | 16 | 22 | 490 | 16.4 | 15.9 | 817 | 45, 45, 58 |
| `squad-5-dhide` | 9 of 9 | 0 | 39 | 53 | 541 | 15.9 | 15.4 | 901 | 270, 33, 45 |
| `squad-5-rune` | 9 of 9 | 0 | 18 | 24 | 480 | 16.5 | 16 | 799 | 42, 48, 73 |
| `squad-6-chainbare` | 9 of 9 | 0 | 22 | 30 | 490 | 16.4 | 15.9 | 981 | 55, 71, 68 |
| `squad-6-chainbind` | 9 of 9 | 0 | 16 | 22 | 471 | 16.6 | 16.1 | 941 | 46, 44, 53 |
| `squad-6-dhide` | 8 of 9 | 0 | 24 | 32 | 435 | 15.1 | 14.7 | 980 | 68, 62, 64 |
| `squad-6-rune` | 9 of 9 | 0 | 16 | 22 | 445 | 16.9 | 16.4 | 891 | 35, 56, 54 |

The names: `squad-<n>-<kit>` is n of ours in a kit. `chainbind` is the kit that the accounts hold (rune helm,
chainbody and legs, dragon dagger, magic shortbow, Bind runes, antipoison). `chainbare` has no rune and no
antipoison. `rune` is full rune with snare runes. `dhide` is dragonhide. `nobow` and `nobow2`: no bow on any
member, or on two. `single`: the gang's own single-way post. `east`: the east multi-way post. `anti2`, `anti1`
and `anti0`: an antipoison on the first two members, the first one, none. `-food`: sharks in the free slots of a
pack with no potion (22 against 20). `pilot-4-chainbare-*`: four of ours in the kit of the squad pilots, with no
march and no pull.

What these rows show, beyond the spread of one condition:

- **The gang's single-way post costs more.** Four of ours kill 7 of 9 there at 100 Hitpoints a kill, against 9 of 9
  at 18 on the multi-way post. In the pilots' kit on the single-way post four of ours kill 1 of 9.
- **A squad needs its bows, and melee alone is worse.** No bow on any member: 7 of 9 at 91 Hitpoints a kill. Melee
  only: 8 of 9 at 80. Two members with no bow: 9 of 9 at 35.
- **Three of ours kill fewer in every kit but dragonhide**: 7, 6 and 7 of 9 in `chainbind`, `chainbare` and `rune`.
- **No single fight option beats the default set.** No freeze, the early special, the eat level, no chase and the
  wider focus lie inside the spread of the base, or kill fewer.

### The antipoison

Five of ours in `chainbind` with fewer potions (`squad-5-chainbind-anti*`, seeds 1, 2 and 3). A gang account hunts
member i, so the first members are the ones that the gang hits first.

| Antipoison on | Kills | Deaths of ours | Hitpoints lost a kill | Times 1.35 | Hitpoints lost by seed |
|---|---|---|---|---|---|
| each of the 5 members | 9 of 9 | 0 | 16 | 22 | 45, 45, 58 |
| the first 2 members | 9 of 9 | 0 | 19 | 26 | 78, 30, 62 |
| the first 2 members, food | 9 of 9 | 0 | 28 | 38 | 93, 79, 80 |
| the first member | 9 of 9 | 0 | 26 | 35 | 75, 79, 79 |
| no member | 9 of 9 | 0 | 30 | 41 | 94, 49, 124 |
| no member, food | 9 of 9 | 0 | 16 | 22 | 41, 34, 72 |

- **A squad of five with two potions, one or none kills all three clones with no death: 45 of 45.**
- The rows with fewer potions lose up to 14 Hitpoints a kill more than the row with five. That is inside the spread
  of one condition, so the table does not separate two potions from none.
- The squad RESULT line holds no count of food and no source of damage. The food of a kill is its Hitpoints lost
  over 20. In the one-against-three meeting with no cure, poison is 27 of 100 Hitpoints lost on the bench and 29 live.

The poison in the content:

- A dragon dagger (p) has poison strength 20 (`daggers.obj:554`). A hit over 0 poisons in 1 of 4 (`pvp_melee.rs2:50`).
- A poisoned player takes a splat each 30 ticks (`poison.rs2:74`). The splat is the strength plus 4, over 5, and
  the strength then falls by 1 (`poison.rs2:29-30`). From 20 that is 20 splats in 600 ticks and 50 Hitpoints.
- A new poisoning puts the strength back to 20 (`poison.rs2:17`).
- Only a death (`death.rs2:72`) or an antipoison (`anti_poison.rs2:5`) ends it. The end of a fight, a bank trip
  and a logout do not: the timer starts again at login (`poison.rs2:69-70`). A dose also gives 5 timer turns with
  no poison, 150 ticks.

### The rune throwing axe special

Five of ours in the bind kit, with the axe stack in place of one shark (`live-walker-iron-rune-chain-bind-axe`,
`PK_AXE=1`), against the same five with the dagger special. Hosted runs 44401683105 (control) and 44403565131 (axe),
seeds 1, 2 and 3. `spec1` fires the special from the first health bar; the squad default waits for a target at 45%
Hitpoints or less. The axe special costs 10% energy and chains onto up to 4 more players on multi-way tiles
(`pvp_rune_thrownaxe.rs2`).

| Special | Kills | Deaths of ours | Hitpoints lost a kill | Times 1.35 | Ticks a run | Kills an hour | Hitpoints lost by seed |
|---|---|---|---|---|---|---|---|
| dagger, default | 9 of 9 | 0 | 17 | 23 | 477 | 16.6 | 38, 33, 79 |
| dagger, `spec1` | 9 of 9 | 0 | 12 | 16 | 466 | 16.7 | 38, 27, 45 |
| axe, default | 8 of 9 | 0 | 37 | 50 | 615 | 13.6 | 90, 79, 124 |
| axe, `spec1` | 6 of 9 | 0 | 63 | 85 | 647 | 10.0 | 148, 120, 107 |

In the axe runs the axe special went out 156 and 165 times, and the dagger special 82 and 86 times (the bow turns
and a plain melee turn use the other weapons). In the first run of the axe cases the squad kit held no axe, and the
special was the dagger's: `kitFrom` (`scripts/pk-roam.ts`) builds the squad kit from the items of the account, and
takes the axe only with `PK_AXE=1`.

The axe special does not beat the dagger special against the clones at the multi-way post: it kills fewer and loses
more Hitpoints in each seed. A throw is a ranged roll that the clones meet with Protect from Missiles when they have
seen a bow, and one dagger special is two hits. The chain adds hits only when a second gang account stands within 3
tiles of the first target on a multi-way tile.

### The winner

`scripts/pk-gang-record/squad-candidate.json`: five of ours in the kit rule `gang-chain-bind`, three strung bows or
more, the multi-way post, every argument of the squad script at its default. On the bench it kills 90 of 90 with no
death of ours, at 16 to 21 Hitpoints a kill (22 to 28 times 1.35) and 16.5 kills an hour (16.0 with the ticks times
1.1). It has not run live.

Not measured:

- Lobsters: `squad-<n>-chainbind-lobster` ends with no fight. The bank trip of the squad takes sharks only.
- A style rule for each gang account, and a kill order. The squad script has one option set and takes the lowest health bar.
- Arrows and runes a kill: the RESULT line of the squad does not hold them.
- The repeat cycle of 30 minutes: a dead clone does not come back.
- A hold on the Monastery side of the gang's walk: the clones make no walk to the Monastery.
- The squad pilots at squad size. Four of ours in the pilots' kit lose 17 Hitpoints a kill on the bench with the
  march and 1 kill of 9 on the single-way post. The pilots lost 249 and 260. The first live squad run is the check of
  the clones at squad size (`scripts/measure/pk-gang-drift.ts squad`).

## The first live squad run

Reported by the gang-hunt-ops session (its log `.practice/gang-hunt/squad-run-1.log` and the kill receipts under
`.practice/kill-receipts/live/` are in the main checkout). The feed record is `.practice/gang-record/feed-1795038250687.jsonl`,
which the collector wrote during the run.

- **Run.** Five of ours in the kit rule `gang-chain-bind`, 21:56 to 22:03 UTC, the defaults of `scripts/pk-squad.ts`
  (post 3067, 3640). Four fought. A fifth dropped out in its first minute with a fault of its start trip. The run
  ended after about 8 of 30 minutes on `halted=no progress: 900 ticks`.
- **Result.** `RESULT fail squad accounts=5 kills=5 killReceipts=5 receiptDomain=live feedMatched=5 died=0 taken=279
  trips=5`. The kills: Goondelf 2, Ligma 2, Sugma 1. No death of ours. 56 Hitpoints lost a kill (279 over 5).
- **By member.** 181 Hitpoints over 3 kills, 98 over 1 kill, 0 over 1 kill and 0 over 0 kills. Two members wear
  dragonhide and two wear rune.

The drift checks, against the clones:

| Check | Clone | Live | Drift |
|---|---|---|---|
| Hitpoints lost a kill, four of ours (`pk-gang-drift.ts squad`, 6 clone runs of four of ours) | 18 | 56 | yes |

So the live run cost 3.1 times the Hitpoints of a kill that the clones predict for four of ours. The factor of 1.35 in
"The climb" came from one meeting of one account against the three: it is not the factor of a squad. One run with 5
kills cannot give a new factor.

The feed check of the collector file (`pk-gang-drift.ts feed`):

| Check | Record | Live run | Reading |
|---|---|---|---|
| Worn sets not in the record: Goondelf with the dagger only, Ligma with hat, dagger and top, Sugma with hat, dagger and legs | the full robe set | 46, 29 and 84 appearance blocks | The gang died 5 times in the run. The record holds the same partial set after a death (`death.wornAfter`), so these are consistent with the kit of an account after a death. |
| Weapon changes with a prayer change in 100, Ligma | 66.7 | 15 (n 20) | A new sample. The record holds 8 changes of Ligma. |

No check of the attack, the special, the eat level, the post or the steps drifts.

The fights of the run in the feed: 11 fights of 0 to 104 ticks, and the gang accounts died in 3 of them at Wilderness
level 15 and 16 (the post and the tiles beside it). A clone run of four of ours takes 539 ticks
for its three kills.

## Fidelity of the first live squad run

The replay: `extra:clone-run1-*` (`scripts/pk-gang-record/run-1.json`). The four members start in the loadouts that the
run started with (the wear and pack of the loadout files of the run), at the Edgeville bank, and march to the post as
the squad script does. The three clones are the base clones. `SQUAD_GANG_PREY=0,1,0` sends the gang to the first two
members, as the feed shows it in the live run. The members had Prayer level 99 and current level 0 (status files of the
four, and `PRAYER_GUARD` points [0,0]): the replay gives them Prayer level 1, the nearest state the bench has to no
points. That state changes the combat level of a member from 126 to 113.

Hosted runners, seeds 1, 2 and 3 (run 44411582416). Live: 5 kills, 279 Hitpoints lost, kills 22 to 54 ticks after the
first attack (mean 34), 2 members lost Hitpoints, no death.

| Measure | Live | Replay | Error |
|---|---|---|---|
| Kills a run (the clones do not come back) | 5 | 3 | not comparable |
| Hitpoints lost a kill | 56 | 72 | +29% |
| Ticks of a fight to its kill | 34 | 62 | +82% |
| Members that lost Hitpoints | 2 | 2.3 | +15% |
| Deaths of ours | 0 | 0 | none |

The raw values by seed (kills, Hitpoints lost by member in the order UnderMyKilt, mmsmk1232, TrouserSnake, TheFullMonty):
3 kills, 74, 117, 0, 0; 3 kills, 79, 104, 0, 0; 3 kills, 94, 178, 1, 0. The replay on six more seeds (run 44415206897)
lost 206, 385 (1 kill), 150, 257, 215 and 204 Hitpoints; the pooled value of those 16 kills is 89 a kill.

What the replay shows:

- **With the live state the bench is as hard as the live run, not softer.** 72 to 89 Hitpoints a kill against 56, with one
  live run of 5 kills. The earlier clone numbers (16 to 21 Hitpoints a kill) came from members with full prayer points
  and one kit.
- **Prayer points halve the Hitpoints lost a kill.** The same replay with full prayer points lost 51, 22 and 37 Hitpoints a
  kill (mean 37, 9 kills; `extra:clone-run1-prayer-x1`).
- **The target pick decides who takes the damage.** With the gang on the nearest member (`extra:clone-run1-nearest-x1`),
  one member took 108 to 225 Hitpoints and the others none: 57 Hitpoints a kill, 1.3 members hit. With the gang on the
  first two members, 2.3 members lost Hitpoints, as live. The live rule that picks among members at the same distance is
  `unknown`: the live gang attacked the two members in dragonhide, in 6 fights, with all four within 1 to 3 tiles in 4
  of them.
- **Two clone behaviours do not explain the length of a fight.** A gang that never eats and a gang with no protect prayer
  have kill times of 57 and 51 ticks against 62 for the base. The live fights are 22 to 54 ticks. The cause is open.

### The fidelity case

`extra:clone-run1-fidelity-x1` passes only when the run has 1 kill or more, 1 to 4 members lose Hitpoints, and a run with 2
kills or more loses 28 to 112 Hitpoints a kill (half to twice the live 56). The band stops a bench that goes soft by
half again, or hard by twice. It is wide because one condition has a spread of 50 to 385 Hitpoints a kill from seed to
seed. A band of 15% is not a test that one seed can pass: the live value is one run of 5 kills, and the replay of the
same condition on two runs of the same seeds also differs.

### The climb on the live state

Seeds 1, 2 and 3, hosted runs 44411582416 and 44413797291. "Rune" is the loadout of TrouserSnake and TheFullMonty
for all four members. "Rune first" puts the two rune loadouts in the members that the gang attacks first, and the
two dragonhide loadouts last.

| Condition | Kills | Deaths of ours | Hitpoints lost a kill | Ticks of a fight | Hitpoints lost by seed |
|---|---|---|---|---|---|
| live loadouts, no prayer points | 9 of 9 | 0 | 72 | 62 | 191, 183, 273 |
| live loadouts, full prayer points | 9 of 9 | 0 | 37 | 52 | 153, 65, 112 |
| rune first, no prayer points | 7 of 9 | 0 | 51 | 82 | 120, 157, 82 |
| rune first, full prayer points | 9 of 9 | 0 | 32 | 56 | 81, 119, 84 |
| all rune, no prayer points | 9 of 9 | 0 | 74 | 71 | 163, 384, 121 |
| all rune, full prayer points | 9 of 9 | 0 | 26 | 47 | 67, 69, 100 |

- **Prayer points are the one lever outside the spread.** Each pair of rows with the same loadouts loses 2 to 3 times the Hitpoints
  without them.
- **The loadouts and the member order are not separated** by three seeds: 37, 32 and 26 Hitpoints a kill with prayer,
  72, 51 and 74 without, with a spread of 2 to 3 times inside a row.
||||||| 4b839d5e98

## The attackers

Other teams run bots on this server. The attacker library puts attackers of a given kind on the post in place of the
clones (`extra:attack-*`). `SQUAD_GANG_KIT=<kit>+<kit>` gives gang account i the kit `list[i]` of `scripts/pk-kits.ts`,
`SQUAD_GANG_PROFILE` its fight profile (here `champion`, the profile of the hill climb) and `SPAR_B_OPTS` its options.
`SQUAD_GANG_PREY=<member index>` sends each attacker to one member. The squad is the four members of live run 1 in their
own loadouts, with full prayer points unless the case says no prayer. A cell is what the squad run prints: attackers
killed, deaths of ours, Hitpoints lost.

The variants of an attacker, the climb of its own rules:

- **plain**: the champion's options. The attacker leaves when it is outnumbered (`escapeOutnumbered`).
- **fight**: `escapeOutnumbered: null`, the attacker fights to its death.
- **pile**: fight, and every attacker hunts member 1 (`SQUAD_GANG_PREY=1`). A real team does this.

### The matrix: our squad of four on the multi-way post

Hosted run 44418140982, seeds 1, 2 and 3. Raw Hitpoints lost by seed. "D1" is a death of ours in that seed.

| Attacker | plain | fight | pile | pile, squad with no prayer points |
|---|---|---|---|---|
| mage | 0 killed; 0, 1, 28 | 3 killed; 8, 5, 34 | 3 killed; 13, 5, 11 | 3 killed; 35, 13, 10 |
| ranger | 0 killed; 89, 33, 64 | 3 killed; 185, 90, 78 | 3 killed; 173, 130, 111 | 3 killed; 259, 210, 285 |
| tribrid | 2 killed; 8, 18, 16 | 3 killed; 8, 63, 56 | 3 killed; 8, 63, 60 | 3 killed; 101, 98, 208 |
| tribrid with the dragon spear | 0 killed; 0, 11, 53 | 3 killed; 10, 75, 61 | 3 killed; 74, 30, 184 | 3 killed; 142, 252, 143 |
| team of 3 (mage, ranger, tribrid) | 2 of 9 killed; 850, 490, 161 | 6 of 9; 419, 793, 968 | 6 of 9; 780, 689, 891 | 3 of 9; 1014 D1, 976 D1, 916 D1 |
| team of 5 (2 mages, ranger, 2 tribrids) | 1 of 15; 1055, 513, 1255 | 0 of 15; 283, 921, 490 | 1 of 15; 535, 486, 704 | 0 of 15; 158 D1, 1, 257 |

### Our setups against the two teams (pile variant, full prayer points)

Hosted run 44419714637 (seeds 1, 2, 3), compared with the pile column above.

| Our setup | Team of 3: killed of 9; Hitpoints lost | Team of 5: killed of 15; Hitpoints lost |
|---|---|---|
| four members, multi-way post (the base) | 6; 780, 689, 891 | 1; 535, 486, 704 |
| four members, the gang's single-way post | 5; 557, 538, 426 | 3; 542, 759, 938 |
| six members (the four loadouts and two more rune) | 9; 417, 357, 381 | 10; 1113, 1030 D1, 944 |

### The policy table

What the cells support. Each row is evidence from three seeds, not a rule that has run live.

| Threat seen | Setup | Move |
|---|---|---|
| one mage, ranger, tribrid or spear tribrid | the squad of four | Stay and fight. The attacker dies when it fights on (3 of 3 in every variant), at 5 to 34 Hitpoints lost for a mage, 78 to 285 for a ranger, 8 to 208 for a tribrid and 10 to 252 for a spear tribrid. A lone attacker that is outnumbered leaves. |
| a team of 3 piling one member | full prayer points | Fight. 689 to 891 Hitpoints lost, 6 of 9 attackers killed. With six members all 9 are killed at 357 to 417. |
| a team of 3 and the squad has no prayer points | the squad of four | Do not stay. One of ours died in each of the 3 seeds (916 to 1,014 Hitpoints lost). |
| a team of 5 | the squad of four | Do not fight it: 1 of 15 killed at 486 to 704 Hitpoints lost, and with no prayer points 1 death in 3 seeds. |
| a team of 5 | the squad of six | It kills 10 of 15 at 944 to 1,113 Hitpoints lost and 1 of ours died in 3 seeds. |
| any team | the gang's single-way post | No gain on the team of 5 (3 of 15 killed, 542 to 938). The team of 3 costs fewer Hitpoints there (426 to 557) and 5 of 9 die. |

Prayer points are the first rule of every row: a squad with none lost accounts to a team of 3 and 5.

Not done: the third party that arrives in the middle of the gang fight, a retreat rule (walk out) against a team, the
kit of each member against a mage (rune against dragonhide), and the climb of an attacker's own choice of target. The four
pure kits (`pure-iban`, `pure-god`, `pure-ranger`, `pure-dds`) had no fight in 3 seeds in the first run of these cases; the
first cells of that run also gave the attackers the clones' melee rotation, and are not kept. The attackers do not
yet choose a member by armour or by Hitpoints.

## Keep it true

`scripts/measure/pk-gang-drift.ts` compares new observations with the record:

- `feed <trace ...>`: the measures of new collector files against the record. It prints a `DRIFT` line for a new worn
  item, a changed combat level or a higher hit. It prints one too for a higher eat level, a prayer that changes less
  often or a new post. A share with under 20 samples does not drift. The levels come from the newest hiscore page
  (`pk-gang-record.ts hiscores`).
- `squad <kills> <Hitpoints lost> <case log ...>`: one live squad run against the runs of a clone squad case. It reads
  the kills and the Hitpoints lost of each `RESULT` line of the case logs. It prints `DRIFT` when the Hitpoints of
  a kill are more than 50% away from the prediction, and it fails when the logs hold no run.

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
