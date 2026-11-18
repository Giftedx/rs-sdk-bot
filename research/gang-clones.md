# The dagger gang: behaviour record

Goondelf, Ligma and Sugma are the accounts of another owner that kill our accounts in the Wilderness
([Rivals: the dagger gang](pvp-fight-loop.md#rivals-the-dagger-gang)). This file is the record of what each gang
account does, with the evidence for each value. The bench copy of the gang takes its numbers from the record.

## Files and tools

| File | Content |
|---|---|
| `scripts/pk-gang-record/goondelf.json`, `ligma.json`, `sugma.json` | One gang account: levels, kit, attack, prayer, eating, movement, choice of player, retreat, death, schedule |
| `scripts/pk-gang-record/group.json` | The three as a group: the post, the pile-on, the chase of our accounts, the unknowns |
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
| The worn items are a black wizard hat, a monk's robe top and bottom and a dragon dagger (p). | 1,184, 1,258 and 1,085 appearance blocks hold that set. One block of Sugma after its death holds the hat and the dagger only. | `kit.worn`, `death` | The pack is not in the feed. |
| The dagger poison starts at 4. | 73 poison splats of 4 and 6 of 3 on players in the tick of an attack. | `kit.weaponPoison` | None. |
| The food heals 20: a shark. | 27 eats with a splat before and after each one. | `kit.food` | The number of sharks in a pack is `unknown`. The most eats of one account in one meeting is 13. |
| A gang account also plays the eat animation when it needs no Hitpoints. | 8 such animations at 96 Hitpoints or more, or far from a fight. A drink plays the same animation (`anti_poison.rs2:3`). | `kit.consumesNotForHitpoints` | The item is `unknown`: a potion or a food item from loot. |
| A Strength prayer is on, and no Strength potion is in use. | The highest attack splat on a player with no Protect from Melee is 20, 19 and 18. The highest special splat is 23, 22 and 22. The limits are 21 and 24 with Ultimate Strength, and 25 and 28 with a super strength too (`pvp_melee.rs2:31-33`). | `attack.damage` | A potion in a fight that the traces do not hold. |

### Attack and special

| Claim | Conditions | Evidence | Gap |
|---|---|---|---|
| The dagger attacks each 4 ticks. | 977 of 1,065, 928 of 1,094 and 840 of 938 intervals are 4 ticks. | `attack.ticksBetweenAttacks` | None. |
| An eat delays the next attack by 3 ticks. | 21 of 22 intervals with an eat between the two attacks are 7 ticks. | `attack.ticksBetweenAttacksWithAnEat` | None. |
| 12% to 14% of the attacks are specials. | 128 of 1,091, 147 of 1,153 and 138 of 986 attacks. | `attack.specials` | None. |
| The first special is the second attack of a fight in most fights. | The count of attacks before the first special is 0 in 37 fights, 1 in 86 and 2 in 12, of 145 fights with a special. | `attack.specials.attacksBeforeTheFirst` | None. |
| A gang account does not keep the special for a low target. | The Hitpoints of the player before a special are spread over all levels: 91 of 413 specials at 90 to 99, 22 at 39 or less. | `attack.specialAtTargetHp` | None. |
| A gang account attacks a player that runs. | In 2,492 of 2,939 pairs of attacks the player moved between the two attacks. In 649 pairs it moved 8 tiles. | `targets.targetTilesMovedBetweenTwoAttacks` | None. |

### Prayer

| Claim | Conditions | Evidence | Gap |
|---|---|---|---|
| A gang account turns on the protect prayer for the weapon that it sees, 1 to 4 ticks after the weapon change. | The opponent faced the gang account: 1 tick in 41 changes, 2 in 30, 3 in 9, 4 in 5. | `prayer.ticksFromWeaponChangeToPrayer` | Our account Mightyrod is the opponent in most samples. |
| Many weapon changes get no prayer change before the next weapon change. | 33, 5 and 18 weapon changes with no change in 8 ticks, against 17, 10 and 58 with one. | `prayer.ticksFromWeaponChangeToPrayer.noChangeIn8Ticks` | The cause is `unknown`: a slow reaction or no prayer points. |
| Against a bow and a dagger in strict turns the right prayer is on at few attacks. | Goondelf 1 of 55 attack animations, Ligma 1 of 16, Sugma 37 of 95. | `retreat.prayedAgainst` | One live meeting. |
| A protect prayer goes off 3 to 61 ticks after it came on, when no other protect prayer replaces it. | 33 holds: the median is 15 to 18 ticks. | `prayer.ticksAProtectPrayerStaysOn.toOff` | None. |
| A gang account does not flick its protect prayer. | 14 of 136 holds last 2 ticks or less. | `prayer.ticksAProtectPrayerStaysOn.twoTicksOrLess` | A prayer with no head icon is not in the feed. |
| The Monastery is the place where the gang goes more often than the Chaos Temple altar. | 11 visits to the Monastery and 4 to the altar in 13 hours. | `prayer.monasteryVisits`, `prayer.chaosAltarVisits` | The prayer points are `unknown`. |

### Eating

| Claim | Conditions | Evidence | Gap |
|---|---|---|---|
| A gang account eats at 74 Hitpoints or less, and at no higher level. | 33 eats with a splat in the 20 ticks before: 43 to 74 Hitpoints. The median is 66, 64 and 71. | `eating.hpAtEat` | The live meeting holds most of the 33. |
| The eat comes 2 to 4 ticks after the splat in 20 of 33 eats, and 7 to 14 ticks after it in 10. | Counted from the first splat that left 74 or less. The other 3 eats come 37 to 78 ticks after it. | `eating.ticksFrom74HpOrLessToTheEat` | None. |
| A gang account does not eat two items in one tick. | No two eats are 3 ticks or less apart, of 41 eats. | `eating.eatsWithin3TicksOfAnEat` | None. |

### Movement

| Claim | Conditions | Evidence | Gap |
|---|---|---|---|
| The post is (3078, 3640), Wilderness 16, a single-way tile. A gang account stands on it in 65% to 69% of the frames. | 11,761 roster frames. | `group.post`, `movement.place` | None. |
| One gang account is away while two stand on the post in 21% of the frames. All three are away in 21%. | 11,761 frames: 0 away 5,813, 1 away 2,491, 2 away 938, 3 away 2,519. | `group.accountsOffThePostInOneFrame` | The rule that sends one account or three is `unknown`. |
| A gang account leaves the post about 200 times in 13 hours. An attack follows in 35, 45 and 47 of the trips. | The trips with no attack go to a player that leaves the Wilderness, or to the tile (2934, 3516). | `movement.trips` | None. |
| The first attack comes 8 to 419 ticks after the leave. The median is 136, 83 and 101 ticks. | The player is 4 to 317 tiles from the post. The median is 107, 73 and 112 tiles. The edge north of Edgeville is 112 tiles from the post. | `movement.trips.ticksFromLeaveToFirstAttack` | None. |
| A gang account is back on the post 13 to 1,724 ticks after its last attack. The median is 112 to 143 ticks. | 127 trips with an attack. | `movement.trips.ticksFromLastAttackToPost` | None. |
| 98% of the steps are run steps. | 98,056 run steps and 2,207 walk steps. | `movement.steps` | None. |
| A gang account goes up to 323, 317 and 422 tiles from the post. | Roster frames. | `movement.farthestFromPost` | None. |

### Choice of player

| Claim | Conditions | Evidence | Gap |
|---|---|---|---|
| The gang attacks each player that the game lets it attack near the post. | No such player stood 5 frames or more within 30 tiles of a manned post with no attack. | `group.targets.attackableAndNotAttacked` | None. |
| A player of combat 26 to 64 near the post is not a player that the game allows. | The game allows an attack only within as many combat levels as the Wilderness level of the tile. | `group.targets.combatRule` | None. |
| The attacked players have combat 78 to 126. 133 of 207 fights are on a combat 126 player. | The first attack of each fight. | `group.targets.combatOfAttacked` | None. |
| With two or three players in range, the first player attacked is the nearest to the post in 13 of 22 trips. | The players in range at the frame of the leave. | `targets.rankByDistanceFromPostOfTheFirstTarget` | 22 trips. The rule is `unknown`. |
| A gang account keeps its player. | 4 changes to a new player within 40 ticks, in 3,230 attacks. | `targets.targetChange` | None. |
| On a multi-way tile two or three gang accounts hit one player in the same 4 ticks. On a single-way tile one does. | Multi-way: 394 attacks by two and 278 by three, of 1,093. Single-way: 16 of 2,137 by two. | `group.pileOn` | None. |
| A player with no armour on a multi-way tile dies 9 to 20 ticks after the first hit. | 8 kills by two or three gang accounts. | `group.pileOn.kills` | None. |

### Retreat, death and return

| Claim | Conditions | Evidence | Gap |
|---|---|---|---|
| With its food gone, Goondelf attacked for 27 ticks from 39 Hitpoints, then left. It was out of the Wilderness after 91 ticks and back on the post after 1,431. | The live meeting. | `goondelf.json` `retreat.at40HpOrLess` | One sample. |
| With its food gone, Sugma attacked from 36 Hitpoints to its death 36 ticks later. | The live meeting. | `sugma.json` `retreat.at40HpOrLess` | One sample. The rule that picks retreat or fight is `unknown`. |
| A dead gang account appears at Lumbridge (3222, 3218) and is back on the post after 1,154 ticks in its full kit. | The death of Sugma in the live meeting. | `sugma.json` `death` | One sample. |
| A skull stays about 2,000 ticks after the last attack on a new player. | 51 skulls: the median is 2,023 to 2,060 ticks. | `skull` | Whether Protect Item is on is `unknown`. |

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
