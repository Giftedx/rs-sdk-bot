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
hunt it, each clone on its own one of ours (`extra:clone-squad-*`). `scripts/measure/pk-gang-climb.ts` makes the table
from the case logs.

Conditions: hosted runners, lockstep, each condition on seeds 1, 2 and 3 (run 44258391927). The three squads in the
kit `chainbind` and each mode of the clones also ran on seeds 4, 5 and 6 (run 44259940425). A run has three gang
accounts, so three seeds are 9 possible kills. No account of ours died in any of the 153 runs.

Two columns need care:

- **Kills an hour.** A dead gang account is back on its post after 1,154 ticks (`group.returnToPost`, one sample).
  The kills of an hour are 9,000 ticks times the kills of a run, over the ticks of a run plus that wait. The wait
  bounds each squad that kills all three.
- **With the bias.** On the bench an attack of ours does 1.13 times the live damage on the gang (the fidelity table).
  The column gives the Hitpoints of a kill and the kills of an hour with the ticks of a run and the Hitpoints lost
  times 1.13. Read this column as the live estimate, not the bench value.

Each number is provisional where a fight option that the clones do not have yet would change it: the wait before an
eat, the tick between our weapon change and our attack, and the login order of the players.

| Condition (seeds) | Kills | Hitpoints lost a kill | With the bias | Ticks a run | Kills an hour | With the bias | Account ticks a kill |
|---|---|---|---|---|---|---|---|
| 3 of ours, `chainbind` (1 to 6) | 18 of 18 | 28 | 32 | 585 | 15.5 | 14.9 | 585 |
| 4 of ours, `chainbind` (1 to 6) | 18 of 18 | 17 | 19 | 516 | 16.2 | 15.5 | 688 |
| 5 of ours, `chainbind` (1 to 6) | 18 of 18 | 16 | 18 | 480 | 16.5 | 15.9 | 800 |
| 6 of ours, `chainbind` (1 to 3) | 9 of 9 | 13 | 15 | 481 | 16.5 | 15.9 | 961 |
| 4 of ours against the four other modes (1 to 6) | 71 of 72 | 19 | 21 | 533 | 15.8 | 15.2 | 721 |
| 5 of ours against the four other modes (1 to 6) | 72 of 72 | 16 | 18 | 472 | 16.6 | 16.0 | 787 |
| 3 of ours, no rune and no antipoison (`chainbare`) (1 to 3) | 6 of 9 | 58 | 66 | 685 | 9.8 | 9.3 | 1,028 |
| 4 of ours, `chainbare` (1 to 3) | 9 of 9 | 22 | 25 | 546 | 15.9 | 15.2 | 728 |
| 4 of ours, full rune (1 to 3) | 9 of 9 | 19 | 21 | 498 | 16.3 | 15.7 | 664 |
| 4 of ours, dragonhide (1 to 3) | 9 of 9 | 35 | 40 | 487 | 16.5 | 15.8 | 650 |
| 4 of ours, two members with no bow (1 to 3) | 9 of 9 | 36 | 41 | 578 | 15.6 | 14.9 | 770 |
| 4 of ours, no member with a bow (1 to 3) | 4 of 9 | 173 | 195 | 755 | 6.3 | 6.0 | 2,264 |
| 4 of ours, melee only (1 to 3) | 7 of 9 | 120 | 136 | 721 | 11.2 | 10.7 | 1,236 |
| 4 of ours, ranged only (1 to 3) | 9 of 9 | 27 | 31 | 622 | 15.2 | 14.5 | 829 |
| 4 of ours, the gang's single-way post (1 to 3) | 7 of 9 | 95 | 107 | 695 | 11.4 | 10.8 | 1,192 |
| 4 of ours, the east multi-way post (1 to 3) | 8 of 9 | 38 | 43 | 684 | 13.1 | 12.5 | 1,026 |
| 4 of ours, no freeze (1 to 3) | 9 of 9 | 18 | 20 | 522 | 16.1 | 15.5 | 696 |
| 4 of ours, the freeze on a low health bar (1 to 3) | 9 of 9 | 20 | 23 | 548 | 15.9 | 15.2 | 731 |
| 4 of ours, the special from the first health bar (1 to 3) | 9 of 9 | 12 | 14 | 511 | 16.2 | 15.6 | 682 |
| 4 of ours, eat at 50 (1 to 3) | 8 of 9 | 20 | 23 | 601 | 13.7 | 13.1 | 902 |
| 4 of ours, eat at 70 (1 to 3) | 9 of 9 | 16 | 18 | 539 | 15.9 | 15.3 | 719 |
| 4 of ours, no chase (1 to 3) | 9 of 9 | 15 | 17 | 519 | 16.1 | 15.5 | 692 |
| 4 of ours, a runner in focus at 0.7 (1 to 3) | 9 of 9 | 15 | 17 | 519 | 16.1 | 15.5 | 692 |
| 4 of ours in the pilots' kit, no march and no pull (1 to 3) | 9 of 9 | 23 | 26 | 550 | 15.8 | 15.2 | 734 |
| 4 of ours in the pilots' kit on the single-way post (1 to 3) | 3 of 9 | 297 | 336 | 711 | 4.8 | 4.6 | 2,845 |

Raw values by seed (kills, Hitpoints lost, ticks) are the last column of
`bun scripts/measure/pk-gang-climb.ts --bias 1.13 .practice/hosted-bench/<run id>`. For the base, four of ours in
`chainbind`: 3, 38, 519; 3, 37, 507; 3, 104, 550; 3, 29, 495; 3, 42, 509; 3, 62, 513. For five of ours: 3, 45, 469;
3, 101, 489; 3, 33, 495; 3, 40, 500; 3, 36, 448; 3, 26, 476.

What the table shows, each from three matched seeds or more:

- **A squad needs its bows.** With no bow on any member the squad kills 4 of 9 and loses 173 Hitpoints a kill. The
  base kills 9 of 9 and loses 20 on the same seeds. The kills by seed are 3, 1 and 0 against 3, 3 and 3. Two members
  with no bow still kill 9 of 9.
- **Bow and dagger in turns beats melee only.** Melee only kills 7 of 9 at 120 Hitpoints a kill.
- **The multi-way post beats the gang's own post.** On the single-way post four of ours kill 7 of 9 at 95 Hitpoints a
  kill. In the pilots' kit there they kill 3 of 9 at 297, which is near the 249 and 260 of the live pilots.
- **Five of ours kill every clone in every mode: 90 of 90 over six seeds.** Four kill 89 of 90. Five end a run in
  fewer ticks than four on 5 of the 6 seeds (480 against 516 on the mean).
- **Three of ours in the full kit also kill 18 of 18, at 28 Hitpoints a kill.** Three with no rune and no antipoison
  kill 6 of 9.
- **No fight option beats the default set by more than the spread of the base.** The base loses 29 to 104 Hitpoints
  a run across its six seeds. No freeze, the early special, eat at 70, no chase and the wider focus all lie inside it.

The winner is `scripts/pk-gang-record/squad-candidate.json`: five of ours in the kit rule `gang-chain-bind`, each
with a strung bow where the fleet has one, the multi-way post, the default options of the squad script. Its kills of
an hour are 16.5 on the bench and 15.9 with the bias. Its food is 0.8 sharks a kill (16 Hitpoints).

### The antipoison

Five of ours in `chainbind` with fewer potions (`extra:clone-squad-5-chainbind-anti*-x1`, hosted run 44262314889,
seeds 1, 2 and 3). A gang account hunts member i, so the first members are the ones that the gang hits first.
"Food" puts sharks in the free slots of a pack with no potion: 22 sharks against 20.

| Antipoison on | Kills | Deaths | Hitpoints lost a kill | With the bias | Ticks a run | Raw: Hitpoints lost by seed |
|---|---|---|---|---|---|---|
| each of the 5 members | 9 of 9 | 0 | 14 | 16 | 476 | 11, 33, 80 |
| the first 2 members | 9 of 9 | 0 | 31 | 35 | 481 | 91, 127, 61 |
| the first 2 members, food | 9 of 9 | 0 | 25 | 28 | 541 | 67, 58, 103 |
| the first member | 9 of 9 | 0 | 24 | 27 | 480 | 77, 61, 80 |
| no member | 9 of 9 | 0 | 30 | 34 | 500 | 94, 82, 93 |
| no member, food | 9 of 9 | 0 | 15 | 17 | 486 | 65, 17, 51 |

- **A squad of five with two potions, one or none kills all three clones with no death: 45 of 45.**
- **Fewer potions cost about 10 to 17 Hitpoints a kill more**, under one shark. The five rows with fewer potions lie
  inside each other's spread, so the table does not separate two potions from none.
- The squad RESULT line holds no count of food and no source of damage. The food of a kill is its Hitpoints lost
  over 20. In the one-against-three meeting with no cure, poison is 23 of 100 Hitpoints lost on the bench and 29 live.

The poison in the content:

- A dragon dagger (p) has poison strength 20 (`daggers.obj:554`). A hit over 0 poisons in 1 of 4 (`pvp_melee.rs2:50`).
- A poisoned player takes a splat each 30 ticks (`poison.rs2:74`). The splat is the strength plus 4, over 5, and
  the strength then falls by 1 (`poison.rs2:29-30`). From 20 that is 20 splats in 600 ticks and 50 Hitpoints.
- A new poisoning puts the strength back to 20 (`poison.rs2:17`).
- Only a death (`death.rs2:72`) or an antipoison (`anti_poison.rs2:5`) ends it. The end of a fight, a bank trip
  and a logout do not: the timer starts again at login (`poison.rs2:69-70`). A dose also gives 5 timer turns with
  no poison, 150 ticks.

Not measured:

- Lobsters: the two cases end with no fight. The bank trip of the squad takes sharks only.
- A style rule for each gang account, and a kill order. The squad script has one option set and takes the lowest health bar.
- Arrows and runes a kill: the RESULT line of the squad does not hold them.
- The repeat cycle of 30 minutes: a dead clone does not come back.
- A hold on the Monastery side of the gang's walk: the clones make no walk to the Monastery.
- The squad pilots at squad size: the squad script of the pilots had no rule that leaves a refused fight. The first
  live squad run is the check of the clones at squad size (`scripts/measure/pk-gang-drift.ts squad`).

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
