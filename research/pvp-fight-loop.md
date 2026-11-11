# Player fight loop

The PK army's fight loop is `fightPlayer` in `scripts/pk.ts`; `scripts/measure/pk-duel.ts` measures it on practice.
Source -> local consumer -> reuse -> check: the pinned server's PvP scripts (`vendor/rs-sdk/server/content/scripts/skill_combat/scripts/pvp/`) and the
in-process client's player entities (`webclient/src/dash3d/ClientPlayer.ts`, `ClientEntity.ts`) -> `scripts/pk.ts` -> reuse the SDK sends
(`sendInteractPlayer`, `sendSpellOnPlayer`, `sendTogglePrayer`, `sendUseItem`) and read head icons, worn items and the health bar from
`Session.client`, which leaves the SDK state and the swarm's launch release unchanged -> `scripts/pk.test.ts` and the duels below.

## Spar and ladder

`scripts/pk-spar.ts` puts the fight loop on both sides: two own accounts fight each other, each with a named profile
(a set of fight options; `PROFILES`). The bench case `pvp:spar` stages a mirror: both sides get the duel conditions
below, with freeze runes and full special energy. The score is for side A: 200 for a kill and -200 for a death, plus
the damage margin held inside 99 each way; an escape is 100 for the side that got away and -100 for the other; a
fight that reaches the cap scores the margin alone. `scripts/measure/pk-spar-ladder.ts <challenger> [champion]` runs
a case for each seed with the challenger on each side and prints wins, losses, draws and the mean score; a profile
that wins the ladder is the next champion. With `--against <profile>` each of the two plays side A against that
profile, for a case whose sides have different jobs.

Map cases (`--case <key>`), each with the mirror kit:

- `extra:spar-gap`: the two start 12 tiles apart.
- `extra:spar-trees`: the two start 6 tiles apart at Wilderness level 3, at (3099, 3536) and (3105, 3536), with a
  blocker on tiles 3101-3103 between them, so neither has line of sight.
- `extra:spar-escape`: Wilderness level 34 at (3125, 3790), with no monster in view. Side B, the runner, has 3 sharks and a glory; out of food at 60 HP or less
  it runs south to level 30 and rubs the glory. Side A, the hunter, must kill it first.

- `extra:spar-escape-spell`: the same chase with no glory on the runner; it runs about 110 tiles to level 20 and casts
  Varrock Teleport.
- `extra:spar-escape-pots`: the glory chase with a super attack, a super strength and a ranging potion on the hunter.
- Batches of 8: `extra:spar-x8`, `extra:spar-escape-x8`, `extra:spar-escape-pots-x8`, `extra:spar-escape-spell-pots-x8`,
  and with the god-spell kit on the hunter `extra:spar-escape-god-x8` and `extra:spar-escape-spell-god-x8`.

Gap: cover, line of sight as a defence and a second attacker are not measured.

### Builds, the kit matrix and the hill climb

- Builds. `scripts/pk-kits.ts` names each build once: what it wears and carries, its switch weapons and style turns,
  and its shop cost. The builds are `tribrid`, `tribrid-pots`, `melee`, `ranger`, `mage`, and the cheaper tribrids
  `tribrid-adamant` and `tribrid-mithril`. Each build has a mirror batch `extra:spar-kit-<build>-x8`.
- Matrix. `extra:spar-kits-x8` puts the tribrid against every build at once; `bun scripts/measure/pk-spar-matrix.ts`
  runs it for each seed and prints kills, deaths, net damage and cost for each matchup (8 matchups in 65 s).
- Climb. `bun scripts/measure/pk-spar-climb.ts` tries each value of each fight option (`KNOBS`) against the champion
  options in `scripts/pk-champion.json`, in mirror batches with the candidate on side A in half of the pairs
  (`SPAR_SWAP=1`). Its measure is the net damage for each 100 ticks (what the opponent took less what we took). A
  candidate with a t statistic of 2 or more over 16 or more paired fights becomes the champion. One fight's net rate
  has a standard deviation near 13, so 16 fights show a gain of about 6.5 and no less.
- The climb waits for memory: a run needs about 1.7 GB for a minute, and it starts only with 1 GB of dashboard
  headroom and no file `.practice/pk-climb-pause` in the main checkout.

### Server rules found for the climb

Read in the server scripts; each is a knob of the fight loop or a build of `scripts/pk-kits.ts`.

- The magic shortbow special rolls its hit against the attacker's own ranged defence (`pvp_magic_shortbow.rs2:39`
  calls `~player_defence_roll_specific` with no dot; every other special and attack uses the target's). Measured from
  traces, damage for each special: the bow special 11.3 from a build with no helm, body or legs (15 of 16 hit) and
  10.4 from full rune with the platebody off (18 of 24 hit); the dragon dagger special 4.7 against rune armour (8 of 22
  hit) and 8.9 against the bare build. For each 100 special energy that is about 3 for the bow and 1.9 for the dagger
  against rune. The loop's `bowBurst` spends the energy on bow specials with a dagger special between; profile
  `burst` won 10 of 16 against base in the bare build and 8 of 16 in rune.
- A cooked karambwan has no eat delay and adds nothing to the attack timer (`consume.rs2:38`); it suspends the eater
  for 2 ticks (`consume_messages.dbrow` message_delay). Eaten on every free tick (`freeFood`) the karambwan build lost
  to the shark build: 6 kills and 10 deaths in 16 spars, net damage -4.5 and -7.7 for each 100 ticks. In the suspended
  ticks the loop cannot switch its prayer.
- Prayer drain is a 5-tick timer that starts when the first prayer goes on and is cleared when none is on
  (`skill_prayer/scripts/prayer.rs2:30-43`). All prayers off and on again inside 5 ticks would cost no points. Not in
  the loop: gap.
- The dragon spear special moves the target one tile and suspends it for 4 ticks (`pvp_dragon_spear.rs2`
  `.p_delay(4)`): it cannot eat, walk or teleport. Not in the loop or a build: gap.
- The dragon mace special is 150% damage at 125% accuracy against crush defence; the dragon longsword 125% damage.
  Not measured: gap.
- A freeze ends when its caster is more than 10 tiles from the target (`pvp_magic.rs2` walktrigger).
- There is no Smite: the prayer list ends at Protect from Melee.

Gap: in two batches of the mirror, side A won 7 of 8 with either profile on it; with the logins of a pair in order
(side A first, then side B first) the kills were 5 to 3 and 3 to 5. The cause of a side's advantage is not found. The
climber and the ladder put each profile on both sides.

### What each build is worth

Each build against the standard tribrid, 16 spars (8 on each side of the map), both sides on the base profile
(`extra:spar-duel-<build>-x8`, seeds 1 and 2). Net is the build's net damage for each 100 ticks.

| Build | Shop cost | Sharks | Wins of 16 | Net |
|---|---|---|---|---|
| `melee` (dagger, strength amulet, super attack and strength) | 252,755 | 22 | 13 | -8.5 |
| `tribrid-pots` (three boost potions) | 441,315 | 15 | 11 | +13.6 |
| `ranger` (d'hide, magic shortbow, ranging potion) | 241,915 | 23 | 10 | -21.4 |
| `tribrid-dlong` (dragon longsword) | 517,355 | 18 | 5 | +6.3 |
| `tribrid-mace-pots` | 467,315 | 15 | 2 | +1.8 |
| `tribrid-mace` (dragon mace) | 467,355 | 18 | 1 | -7.3 |
| `tribrid-bare` (no helm, body or legs) | 222,755 | 18 | 1 | -25.1 |
| `tribrid-bare-pots` | 222,715 | 15 | 1 | -15.5 |
| `mage` (splitbark, Fire Wave) | 177,555 | 20 | 0 | -5.1 |
| `tribrid-adamant` | 99,071 | 18 | 0 | -18.6 |
| `tribrid-mithril` | 35,691 | 18 | 0 | -38.2 |

- Food wins a stand-up fight. The melee and ranger builds deal less net damage than the tribrid and still win,
  with 4 and 5 more sharks: the tribrid's staff, bow and five rune stacks take the slots.
- The three boost potions are worth more than the three sharks they replace: 11 wins of 16, net +13.6.
- The dagger is the best special weapon here: the mace and the longsword builds win less.
- Rune armour is worth its cost: the bare, adamant and mithril builds win 0 or 1 of 16.

Gap: 16 spars for each row; the builds that trade the freeze runes for sharks or potions (`tribrid-food`,
`tribrid-lean`, `hybrid`) and every build against `melee` are not measured.

The climb, mirror and matrix, 16 or more paired spars for each candidate: no option beat the base loop in the tribrid
mirror (style orders, eat level 35 to 66, prayer restore level, special threshold 0.3 to 1, freeze rule, kiting a
frozen target, standing 2 or 5 tiles off, prayer flick, free karambwans, the bow burst at three thresholds). Clearly
worse: every armour piece off for each cast (net -18.3), kiting a frozen target (-7.2 to -9.1), no Defence prayer
(-4.3), the torso kept on for casts (-6.0). In the `tribrid-pots` mirror the special at 50% health was accepted
(+7.5, t 2.07); with about sixty candidates tried, one such result is expected by chance.

### Hit timing

All three styles share one attack timer (`%action_delay`): a spell sets it 5 ticks ahead, a melee or ranged attack
its weapon's rate. Damage lands later for a projectile: a spell after floor((46 + 10 * tiles) / 30) + 1 ticks, an
arrow after floor((46 + 5 * tiles) / 30) ticks, a melee hit at once (`pvp_magic.rs2:230`, `pvp_ranged.rs2:50-72`,
`projectile.rs2:25`). So a spell and a melee hit cannot land on one tick at melee range, and the two hits of a dragon
dagger special are the burst of this content.

### Speed of a measurement

Use a batch case for every comparison: `extra:spar-x8` and `extra:spar-escape-x8` run 8 spars at once in one world,
at the same spot (a player blocks no tile, and a fight loop names its one target). The ladder takes a batch key as
any other case.

- Cost. One spar alone: about 62 ms for each game tick with 2 accounts, so 44 s for a 711-tick mirror fight and
  about 20 s for an escape fight. A batch of 8 escape fights: 36 s, and a 16-fight ladder 69 s (4.3 s a fight).
- Where the time went, from a CPU profile of the worker (`BUN_OPTIONS="--cpu-prof-md --cpu-prof-dir=<dir>"`) and the
  engine's `.practice/logs/sim-stat.log`:
  - A script that waits for its logins with no tick wait open holds each lockstep tick for the busy limit (2 s): 16
    accounts took 38 s to log in. The spar counts the login wait as a tick wait and logs the accounts in together.
  - The status file of each account, written every 5 ticks: 10% of the run. A lockstep world writes it every 100.
  - The reach flood fill behind the `reachable` flag of the state: 9%. The spar turns it off on its clients.
- A CPU profile gives each function its share of the CPU time, not of the run. The worker of an 8-pair run used
  about 2.6 s of CPU in 32 s; the rest of the run is the wait between the engine and its 16 clients (the engine
  waited 40-100 ms for each tick; a client held a tick 9 ms at the median and 24 ms at the 90th percentile).
- One unpack of the game archives for all clients of a process (`bunzip2` in `webclient/src/io/JagFile.ts`, a third
  of the worker's CPU time) gave no gain outside the noise: 34 s against 35-36 s for the batch. It is not in the
  vendor patch.
- The wait of a tick is the clients of one worker process: they share one thread, and each held a tick 12 to 20 ms
  behind the others (`SIM_ACK_FILE`). With 16 clients in one process the engine waits 54 ms for each tick; with the
  pairs in 8 processes (`SPAR_PROCS=8`) it waits 12 ms. `extra:spar-x8`, seed 1: 89 s in one process, 64 s in 4, 54 s
  in 8.
- A lockstep client reads its socket as soon as bytes arrive (`packages/core/src/inprocess.ts`), not on the 20 ms
  loop of the session: 60 ms to 50 ms for each tick with 16 clients in one process.
- `extra:spar-x16` runs 16 pairs in 8 processes: 16 full fights in 71 s (4.4 s a fight; the x8 batch in one process
  takes 11.1 s a fight). It takes about 3.5 GB of memory while it runs.
- The engine's own tick is the rest: 24 to 41 ms with 32 players (`NODE_DEBUG_PROFILE=true`), of which 11 to 15 ms move
  every NPC of the world and 4 to 9 ms read the clients.
- The order of the logins changes with the number of processes, so a seed gives one fight only at one `SPAR_PROCS`.
  Compare two profiles at the same setting.
- Two batches of 8 fights of base against base gave 7 kills to 1 and 2 kills to 5. A batch of 8 does not separate two
  profiles; use 16 pairs and three seeds.
- The state of a tick was 2.0 ms for each client, and the scans of locs and ground items were 1.35 ms of it. The fight
  loop reads neither, so the spar turns the two scans off on its clients (`SPAR_FULL_STATE=1` keeps them): 0.65 ms.
  `extra:spar-x16`: 55 to 67 s for 16 fights (3.4 to 4.2 s a fight), by the load of the PC.
- The spar cases give a turn only to an npc within about 64 tiles of a player (`SIM_NPC_NEAR=64`, `engineEnv` of the
  case): the npc part of an engine tick is 2 ms, against 11 to 15 ms. It gave no gain in wall time on its own.
- A timer of 1 ms takes 15 ms in bun on Windows (`setTimeout(1)` and `Bun.sleep(1)`: median 15.3 ms). Keep timers
  off the path of a tick. A client that checks a busy tick on every turn of the event loop for 50 ms made the batch
  slower (74 s): eight processes that spin take the cores from the engine.
- The rest of a tick, with 32 players: the engine reads the clients in 11 to 17 ms (the scripts of their packets), and
  waits 20 to 35 ms for the clients while the live fleet loads the PC (79% CPU, 36 bun processes).
- The bench makes the account folders of a case with 5 or more accounts 8 at a time and every save in one process.
  A batch of 8 full fights with `SPAR_PROCS=8` takes 34 to 42 s; four batches in one list take about 3 minutes.
- `pk-spar-matrix.ts` and `pk-spar-climb.ts` wait while `.practice/pk-climb-pause` exists. A session that makes that
  file must not start them before it removes the file: the run then waits for itself.
- Gap: no run on an idle PC; a seed does not repeat a fight when the pairs run in several processes.

Spar findings. Conditions: lockstep practice engine, cap 900 ticks, both sides with Lost City and Dragon Slayer done
unless a finding says otherwise; a seed repeats its fight. Evidence: `.practice/pk-spar/*.json` and the traces
`.practice/pk-spar/trace-*.log` in the worktree that ran them.

1. **A mirror fight is a food race.** `pvp:spar`, base against base, seeds 1, 2, 3: kills at 668, 535 and 570 ticks;
   side A, side A, side B won. The loser had eaten all 18 sharks in each fight; the winner 18, 13 and 16.
   Gap: three fights; equal settings win or lose by the seed, so a small gain needs more seeds to show.
2. **No single setting beats the base loop in a stand-up mirror.** `extra:spar-x8`, 16 fights for each profile against
   base (8 on each side):

   | Profile | Change | Wins | Losses |
   |---|---|---|---|
   | `freeze` | a freeze whenever the target is free | 6 | 10 |
   | `eat-40` | eat at 40 HP, not 50 | 6 | 10 |
   | `eat-65` | eat at 65 HP | 8 | 8 |
   | `spec-late` | special at 35% health, not 65% | 8 | 8 |
   | `no-read` | no read of the overhead prayer | 7 | 9 |

   The hunters (`scripts/pk-hunt.ts`, `scripts/pk-roam.ts`) cast the freeze only when the target runs (`freeze: 'flee'`).
   Gap: 16 fights for each row separate a clear loss only; the climber measures the rest by net damage.
3. **Damage dealt is read from the splats on the target.** The SDK publishes a `damage_dealt` event only while our
   player faces the target at the tick the splat shows (`bot/StateCollector.ts`), so an arrow or a spell that lands
   after a gear switch was not counted: one spar read 102 dealt where the other side took 274. The loop now reads the
   target's splats from the client (`newSplats`): two spars read 109 against 116 taken and 140 against 140.
4. **A hunter that chases, freezes on the flight and keeps its special kills 1 runner in 3; the plain hunter kills
   none.** `extra:spar-escape`, seeds 1, 2, 3, runner on base. Base hunter: the runner got away 3 of 3. Hunter
   `freeze-flee` (a freeze only while the target runs): 3 of 3 got away. `freeze-flee` with `specBelow` 0.4: 1 kill
   (156 ticks), 2 got away. What a trace showed:
   - A cast leaves the hunter where it stands until its next turn, 5 ticks for a spell, while the runner covers 2
     tiles a tick and leaves view. The loop now runs after a fleeing target between turns.
   - The first freeze on a runner can miss; the third landed and held the runner 12 ticks (half time under Protect
     from Magic), 3 tiles short of level 30. In those 12 ticks the hunter dealt 6 damage: its 4 specials were spent
     while the runner still had food.
   - A melee turn against a frozen target spends the freeze on a walk. The loop now attacks from range unless the
     target is within 2 tiles.

   - The freeze misses often: in one trace the first three casts on a runner missed. Rune platelegs, kiteshield and
     full helm take 21, 8 and 6 off the magic attack; the loop takes them off for a freeze on a target that has fled.

   Kill rates from batch runs, 16 fights each (two batches of 8, seeds 1 and 2), runner on base. `hunter`: a freeze on
   the flight, the special kept for 40% health or a target that has fled. `hunter-low`: the same with a freeze from
   62% health. Potions: a super attack, a super strength and a ranging potion on the hunter, for 3 of its 18 sharks.

   | Runner | Hunter | Potions | Kills in 16 |
   |---|---|---|---|
   | glory, about 30 tiles to level 30 | `hunter` | no | 1 |
   | glory | `hunter-low` | no | 3 |
   | glory | `hunter` | yes | 6 |
   | glory | `hunter-low` | yes | 5 |
   | glory | `hunter-low`, `specBelow` 0.25 | yes | 4 |
   | no glory, about 110 tiles to level 20 | `hunter-low` | yes | 9 |
   | no glory | `hunter-low` | no | 14 |
   | glory | `hunter-low`, Flames of Zamorak under Charge | yes | 5 |
   | no glory | `hunter-low`, Flames of Zamorak under Charge | yes | 10 |

   Flames of Zamorak under Charge hits up to 30 where Fire Wave hits up to 20 (Zamorak staff and cape worn, the Mage
   Arena done; `pvp/spells/scripts/flames_of_zamorak.rs2:27`). The loop casts Charge (`charge`); every hunter of a
   batch got "You feel charged with magic power." The rate did not move at 16 fights: 5 against 5-6 for the glory
   runner, 10 against 9 for the runner with no glory.

   The base hunter killed 0 of 8 against the glory runner. Boost potions and the length of the run decide the rate;
   the freeze and special settings do not separate at 16 fights. Variants that showed no gain at 5 fights each: magic
   only or magic and ranged once the target has fled, with and without the specials; the freeze cast with the weapon
   in hand, so that the runner has no Protect from Magic up. Each style alone against the base fighter dealt, for
   each 100 ticks: magic 25.4 and 24.2, melee 15.1 and 14.3, ranged 8.0 and 18.3.
   Gap: 16 fights for each row. The no-glory rows disagree with the glory rows on potions (14 without, 9 with), so
   either row can be chance, or the three turns that the potions take cost more in a long chase than they give.

   A special on a target that runs waits: for the freeze while one is ready, and for bow range (7 tiles for a
   shortbow, `bows.obj` attackrange) when it is a bow special. A bow special on a runner beyond that range stays
   armed with its energy, and the loop then spent each turn on it and cast no freeze: 3 such turns in one batch of 8,
   0 in two batches with the wait. The rates did not move: 6 of 16 against the glory runner and 8 of 16 against the
   runner with no glory, `hunter-low` with potions.
5. **A start out of sight or far apart does not stop the fight.** One run each at seed 7, base against base, without
   Dragon Slayer: first damage at tick 19 from 2 tiles in the open, 31 from 12 tiles, 11 from 6 tiles with the blocker
   between; kills at 528, 495 and 628 ticks. The server walks an attacker to a tile with line of sight. Gap: one run each.
6. **A side that escapes must not end its fight when the target leaves its view.** In the first escape spar the runner
   returned `lost` 219 ticks in, still deep in the Wilderness. The loop keeps going while it escapes.
7. **An account without Dragon Slayer keeps its rune platebody on.** The loop takes the torso off for a cast and puts
   it on for a melee turn, and the game refuses such an account ("You have not earned the right to wear this yet.",
   `levelrequire.rs2:132`): 35 and 39 refusals in one spar. The loop reads the quest journal and leaves the body on;
   `extra:spar-no-slayer` had 0 refusals. Such an account casts at -30 magic attack, so Dragon Slayer is worth doing.
8. **"I'm already under attack." is not proof of a monster.** A new practice world sends it for the first 8 ticks
   (`pvp_combat.rs2:110`), and both sides then left the fight to attack a monster 15 tiles away. The loop reacts only
   to a monster within 8 tiles that faces a player, and the spar waits 10 ticks before the fight.
9. **Monsters at the fight spot block player hits.** At (3094, 3800) green dragons attacked both sides: "Someone else
   is already fighting your opponent." 14 and 17 times in one spar. The escape case stands at (3125, 3790), where a
   probe saw no attackable monster.

## Pure builds

A pure has Defence 1 and Hitpoints 10. The kits are `pure-iban`, `pure-rock` and `pure-bolt` in `scripts/pk-kits.ts`;
`skiller` is their target. Evidence for every row is the server code. Gap: no practice run and no live run.

- **Combat level.** 0.25 x (Defence + Hitpoints + half Prayer) + 0.325 x the largest of Attack + Strength, 1.5 x Ranged and
  1.5 x Magic (`Player.ts` `getCombatLevel`). A second style is free while its term stays under the first. Prayer 43
  adds 5 levels, so the kits keep Prayer 1.
- **Quest XP sets the levels.** The server multiplies XP by 25 (`WorldConfig.ts` `xpRate`), and a quest reward gives no
  Hitpoints XP. Underground Pass or Death Plateau gives Attack 61 from level 1. Scorpion Catcher gives Strength 73.
  No quest reward stops at Attack 40, so a rune scimitar pure has no quest route.
- **Hitpoints rise in PvP.** Each point of damage on a player gives 1.33 Hitpoints XP times 25 (`pvp_combat.rs2:175`).
  Level 11 needs 152 XP, so the first 5 damage end Hitpoints 10. About 64 damage give Hitpoints 20 and about 445 give
  Hitpoints 40. Four Hitpoints levels add 1 combat level. The cannon gives no Hitpoints XP (`cannon_fire.rs2:119`).
- **Weapons in the content pack.** Dragon dagger, longsword, mace, battleaxe, spear and halberd, magic shortbow and
  Iban's staff exist. There is no dragon scimitar, abyssal whip, granite maul, crystal bow or Ancient Magicks.

| Kit | Levels | Combat | Attack | Attacks combat 3 from Wilderness level |
|---|---|---|---|---|
| `pure-iban` | Attack 61, Ranged 50, Magic 50 | 27 | Iban Blast, max hit 25 (Magic 50 and Attack 50 for the staff, `levelrequire.rs2:172`); magic shortbow | 24 |
| `pure-rock` | Attack 61, Strength 73, Magic 80 | 46 | dragon dagger special; Flames of Zamorak under Charge, max hit 30; Entangle | 43 (the rune rocks are level 46) |
| `pure-bolt` | Magic 35 | 19 | Fire Bolt, max hit 12 | 16 |

Bench cases: `extra:spar-pure-iban-vs-skiller-x4`, `extra:spar-pure-bolt-vs-skiller-x4` and
`extra:spar-pure-rock-vs-skiller-x4`. Gaps: the Hitpoints of real skillers; Underground Pass at Hitpoints 10 with no
Hitpoints XP; the Mage Arena fight for the god spell gives Hitpoints XP; the tile east of (3055, 3872) is not checked.

## Server rules the loop follows

- Protect prayers cut a player's max hit by 40%, not 100% (`pvp_melee.rs2:32`, `pvp_ranged.rs2:38`, `pvp_magic.rs2:182`).
- The attackable gap is the shallower player's Wilderness level, (z - 3520) / 8 + 1 on the surface (`wilderness_levels.rs2:4-16`, `pvp_combat.rs2:32-48`).
- The killer gets one of eleven messages naming the loser (`pvp_combat.rs2:203-222`); the SDK emits no kill event for a player.
- Head icon bits (`player/configs/headicon.constant`): 0 skull, 3 Protect from Melee, 4 Protect from Missiles, 5 Protect from Magic.
- A glory rubbed from the inventory teleports up to Wilderness level 30 (`amulet_of_glory.rs2`); the content has no Teleblock, Vengeance or Ancient Magicks.
- Dragon weapons need Lost City complete (`%zanaris` 6, `levelrequire.rs2:156`).
- `PlayerState.x` and `z` are scene-local; `worldX` and `worldZ` are tiles.

## Findings

Conditions for every duel: practice server at 150 ms ticks; both accounts 99 Attack, Strength, Defence, Ranged, Magic, Prayer
and Hitpoints, rune full helm, platebody, platelegs, kiteshield, glory, cape of legends, ranger boots, Lost City done; both at
(3094/3096, 3555), Wilderness level 5. The tribrid carries a mystic fire staff, a magic shortbow with rune arrows, a dragon dagger (p),
Fire Wave runes, 2 prayer potions and 18-19 sharks, and rotates magic, ranged and melee. The dummy has no food and only
auto-retaliates with a dragon dagger (p). Times are ticks from the first tick to the kill message.

1. **The loop kills a maxed player.** 32 of 32 duels with food ended in a kill; the tribrid ate 0-7
   sharks (one outlier of 14). Evidence: `.practice/pk/*.txt` in the Claude cloud container that ran them. Gap: the dummy neither
   eats nor switches; no mirror match; no live fight.
2. **Hitting off the opponent's overhead prayer kills sooner.** Dummy on Protect from Magic: reading the overhead (the loop then
   casts no magic) 191, 224, 180 ticks; ignoring it 379, 214, 331. Medians 191 against 331. Gap: three runs each, wide spread.
3. **Protecting from the opponent's worn weapon cuts food use.** Against the dagger dummy, Protect from Melee chosen from the
   worn weapon: 2, 3, 2 sharks eaten; Protect from Magic at range: 7, 7, 0. Gap: the second set also froze, so the two changes are
   confounded; food use, not survival, is measured.
4. **A freeze in a stand-up duel does not speed the kill.** Freeze whenever the dummy is free: 358, 312, 706; no freeze: 305, 381, 244.
   The loop freezes only when asked (`freeze`). Gap: chases and escapes, where a freeze should matter, are not measured.
5. **The dragon dagger special fires but shows no gain.** Full energy, special at the dummy's health bar 50% or less: 4-5 specials
   a fight, energy 1000 -> 750 -> 500 -> 250; times 323, 289, 241 against 239, 369, 254 without. In one logged duel the health bar
   read 47/99 before and after four specials in a row. Gap: whether the specials hit, and whether the bar refreshes on every hit.
6. **The glory escape works.** No food, escape at 60 HP: the loop rubbed the glory at 59 HP, chose Edgeville and left the
   Wilderness 82 ticks into the fight. One run.
7. **The hunter runs a whole trip.** `scripts/pk-hunt.ts` on practice: start at Edgeville bank with the kit banked, restock
   (18 sharks, runes, potions, glory, staff, bow), walk to (3094, 3540), engage a maxed dummy at Wilderness level 4, kill it in
   174 ticks and loot 5 piles (rune arrows, rune scimitar, rune full helm, shark) at the dummy's last tile until the inventory
   was full, then hunt on to the tick cap and log out. One clean run after four fixes:
   - wait for the drop;
   - loot at the target's last tile, not where the fight began;
   - heal before a new fight;
   - move a hunt spot that rejected walks.

   Gap: no live run; no opponent that eats, prays or flees; a death ends the run.
8. **A range pure runs the hunter from Ardougne.** Practice, one run. A combat-78 pure (Attack 69, Strength 1, Defence 1,
   Ranged 99, Magic 48, Prayer 75, Hitpoints 83) in coif, black d'hide chaps and vambraces, with a magic shortbow. It started at
   Ardougne with a glory, rubbed to Edgeville, and restocked a staff of fire, a rune scimitar and Fire Bolt runes (`PK_KIT`,
   `PK_TRIP`, `PK_SPELL`). It killed a combat-76 melee dummy at Wilderness level 4 in 128 ticks and looted 4 piles. Gap: one
   run; no live run.
9. **Without a glory, a teleport spell travels and escapes.** The live market has no sellers of glories, d'hide, coif, staff
   of fire or rune scimitars (claude-cloud's market read of `/api/market/items/<id>`), so a pure may have none of them.
   Practice, one run each, Varrock Teleport (1 law, 3 air, 1 fire; up to Wilderness level 20, `teleport.rs2:17`):
   - The hunter started a range pure at Ardougne with only a magic shortbow, rune arrows and the teleport runes. It
     teleported, walked to Edgeville bank, restocked sharks, killed the combat-76 dummy with ranged alone in 113 ticks and
     looted 4 piles.
   - With no food and no glory, the fight loop cast the teleport at 53 HP and left the Wilderness 136 ticks into the fight.

   Gap: one run each; the walk from Varrock to Edgeville is not checked live.
10. **Live: the hunter's trip works, and the shallow Wilderness by Edgeville had no target.** UnderMyKilt (claude-cloud),
    one run of 1,500 ticks:
    - Kit: magic shortbow, 66 rune arrows, sharks and Varrock Teleport runes, bought for 478,785 coins.
    - Trip: it cast Varrock Teleport, walked to Edgeville, restocked once and cycled the three spots at Wilderness levels 3-7.
    - Result: 0 fights and 0 deaths; it ended at the cap and logged out (`RESULT ok hunt cap kills 0`).
    - Evidence: `.practice/pk-pilot/pk-hunt.log` in the claude-cloud container.
    - Gap: the run logged no seen players, so it cannot tell an empty area from out-of-range or busy players. The hunter
      now logs every player it sees with its verdict (`HUNT seen`).
11. **Deeper than a teleport reaches, the loop runs south first.** Practice, one duel at Wilderness level 36 with no food:
    it ran south, rubbed the glory at 48 HP once at level 30, and left the Wilderness 199 ticks into the fight.
12. **The SDK reports an NPC's damage from someone else as `damage_taken`** with `targetType` npc and `sourceIndex` -1. A
    hunter that read it as an attack started a fight in watch-only mode. Only `damage_taken` with `targetType` player and a
    player source index counts as an attack.
13. **Live scout: the deep Wilderness held one player, out of range.** UnderMyKilt (combat 78), watch-only (`PK_OBSERVE=1`),
    one run, about 1,800 ticks on a route from Edgeville to the Lava Maze (`PK_SPOTS`):
    - Seen: one player, Goondelf, combat 126 at (3078, 3640), Wilderness level 16, out of range for combat 78.
    - Spots: the spots at levels 5, 16, 26 and 36 were reached. The walk to (3060, 3870) by the runite rocks stopped at
      (3055, 3872) twice ("Failed to walk"; the maze's lava walls), so the rocks need a routed approach. xulvexi was not seen.
    - Damage and loss: no NPC damage.
    - End: the session dropped at level 45 (the gateway's drain).
    - Evidence: `.practice/pk-pilot/pk-scout.log` in the claude-cloud container.
    - Gap: one run; the agility course spot was not reached.
14. **A dropped session ends the hunt.** After that drop, the hunt loop spun on failed walks (47,220 lines). Its stale status
    then blocked other workers' logins until the run was killed. `nextTick` resolves false when the session ends, and
    the fight loop and the hunter now stop on it. On practice, closing the hunter's session mid-run ended the hunt at once
    (`end: session ended`, 13 log lines). Gap: a hand run outside the swarm leaves no supervisor end record, so
    cloud-recover waits on it. Restoring the account's swarm job lets the swarm write one, and cloud-recover takes it.
15. **The client's hit splats show about half of the damage.** In a traced mirror spar of 520 ticks, the HP of side A fell
    436 in total and the splat count of the fight loop gave 244; side B fell 387 against 194. The spar takes the damage
    of a side from its HP drops tick by tick (`spar` in `scripts/pk-spar.ts`), and the net damage of the climb uses that.
    Evidence: `SPAR_TRACE=1` on `extra:spar-x8`, then the sum of the HP drops in the `TRACE` lines against `taken` in
    the `SPAR` line. Gap: a hit in the tick of a bite of food shows a smaller drop.
16. **An overhead prayer that follows the weapon is late for most hits of a side that switches styles.** The weapon change
    and the hit come in one tick. In the tick of the roll a ranger build had the right overhead for 32 of 196 hits of a
    tribrid (magic 12 of 54, ranged 3 of 66, melee 17 of 76; four spars of `extra:spar-duel-ranger-x8`, seed 1). The
    drops under a right overhead stay at or below 60% of the max hit (magic 11, melee 12), and the other drops reach
    the full max hit (20, 22, 23). By the tick of the HP drop the overhead is right for 188 of 196, so the prayer at
    the drop says nothing. Gap: the roll tick comes from the hit delay of each style, one tick before the drop for
    melee, two for ranged, three for magic at one tile.
17. **Prayer points are the clock of a fight.** Both sides of a spar that ends in a kill near tick 670 hold 0 prayer points
    (`prayerLeft` in the `SPAR` lines of `extra:spar-duel-melee-x8`). The overhead, Steel Skin and the two melee prayers
    drain 12 each for a tick, and 60 + 2 x prayer bonus of drain costs one point, so 99 points and eight doses of
    restore last about 700 ticks. The first side with no points takes full hits. Gap: no bench run with more restore
    potions or with prayer bonus gear.
18. **The offline simulator agrees with the bench on tribrid kits, not on one-style builds.** `bun scripts/pk-sim.ts --table 1000`
    runs 16,000 fights in seconds with the server's hit, prayer, food and special rules. Against the tribrid it gives the
    potion kit, the lean kit and the hybrid a win and the mage, adamant and mithril kits a loss, as the bench does, and
    its mirror lasts 694 ticks where the bench mirror lasts about 650. Gap: it gives the ranger 17% where the bench
    gives it 14 of 24, and the melee build an even fight where the bench gives it 18 of 24. In the simulator the
    tribrid deals about 100 damage for each 100 ticks to the ranger; on the bench it deals 77 (eight spars). It has no
    movement and no freeze. A result from it is a candidate for the bench, not a measurement.
19. **An overhead that changes one tick before the opponent's attack wins the mirror.** The `snap` profile (`predictPrayer`
    with `snapPrayer`) holds the overhead for the weapon the opponent shows and changes to the predicted style one
    tick before the opponent's next attack is due. Against the base profile it has 42 kills and 6 deaths in 48 spars
    (15 to 1, 14 to 2, 13 to 3); base against base has 24 and 24 (8 to 8, 7 to 9, 9 to 7) (`extra:spar-x16`, seeds 1,
    2 and 3, `SPAR_SWAP=1`). The tick decides it: in batches of 8, a change two ticks before has 10 kills and 6
    deaths in 16 spars, and a change in the tick of the attack has 8 and 8. Against the `mix` profile, which picks its
    style at random, it has 9 kills and 7 deaths in 16 spars, the same as base. The hunter, the roamer and the
    champion profile use it. Gap: 16 spars each against the melee build (10 to 6; base 8 to 8) and the ranger (11 to
    5; base 10 to 6) do not separate it from base.
20. **Random attack styles beat an overhead that predicts.** Both sides hold the `snap` profile; side A also picks each
    style at random among the open ones (`mixStyles`). Side A has 29 kills and 3 deaths in 32 spars (15 to 1, 14 to 2;
    `extra:spar-x16`, seeds 1 and 2). Against an opponent that only follows the weapon, random styles gave no gain
    (mean net +1.65, t 0.56, 24 spars). The champion profile is `predictPrayer`, `snapPrayer` and `mixStyles`.
    Gap: the champion against itself is even (7 to 9), so the mirror gives no more gain from the overhead.
21. **The place of a pair in a batch moves its result.** With the `snap` profile on both sides and 2 pairs in each
    of 8 worker processes, side B won 11 of 16 even pairs and side A won 12 of 16 odd pairs (two batches). A swap of
    the profiles on every second pair put one profile on the weak place of every pair: base against base read as 9
    kills to 23. The swap goes by two pairs at a time (`scripts/pk-spar.ts`), and the duel cases put their kits the
    same way; the control then reads 8 to 8 and 7 to 9. Results before this rule that favoured side A stand (the
    fault worked against side A); a result that favoured side B does not. Gap: the cause of the place effect.
22. **More prayer restore for less food does not win.** The kit with four restore potions and 16 sharks has 5 kills and
    10 deaths in 16 spars against the tribrid kit, both on the `snap` profile (`extra:spar-duel-tribrid-pray4-x8`,
    seeds 1 and 2, kits on the weak place of each pair).
23. **Bow and dagger only beat the three-style rotation.** The champion with the rotation ranged, melee (no spell turn)
    has 26 kills and 6 deaths in 32 spars against the champion with all three styles (15 to 1, 11 to 5;
    `extra:spar-x16`, seeds 1 and 2). In the potion kit against the builds that beat the tribrid on food
    (`extra:spar-rivals-x12`, seeds 1, 2 and 3) it has 27 kills and 9 deaths: 10 to 2 against the melee build, 5 to 7
    against the hybrid, 12 to 0 against the ranger. With all three styles the champion had 2 kills and 10 deaths
    there, and none in 16 spars against the hybrid over four profiles. A spell takes 5 ticks; the bow takes 3 and
    the dagger 4. The champion profile and the hunter use the two-style rotation; the hunter keeps magic for the
    freeze. Gap: the hybrid still wins 7 of 12; no kit yet that trades the wave runes and the staff for food.
24. **Changes that did not win.** The special attack from 50% health: 4 kills and 12 deaths in 16 spars against the
    champion. Three restore potions and 17 sharks: 11 kills and 11 deaths in 22 decided spars against the tribrid
    kit. Against the three rival builds, 12 spars each: body armour kept on for a shot or a cast 4 to 6, freeze and
    kite of a melee opponent (`adapt`) 4 to 8; the hybrid won all four spars in each.
