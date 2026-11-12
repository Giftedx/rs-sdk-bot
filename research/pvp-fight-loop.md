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
frozen target, standing 2 or 5 tiles off, free karambwans, the bow burst at three thresholds). Those spars read the
damage from hit splats, which show half of it (finding 15), and their batches of 8 do not separate two profiles
(Speed of a measurement); findings 19 to 28 are the measured rules. Clearly
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

Run a list of batches with `bun scripts/measure/pk-spar-jobs.ts "<case>|<profile a>|<profile b>|<swap>|<seed>|<options a>" ...`:
it runs each batch in 8 worker processes, takes turns with the matrix and the climb of other sessions, and prints one
result line for each batch.

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
`extra:spar-pure-rock-vs-skiller-x4`. Gaps: the Hitpoints of real skillers; `pure-iban` and `pure-rock` have no quest
route ("Quest routes of the builds"); the tile east of (3055, 3872) is not checked.

## Account builds

The trained builds of `scripts/pk-kits.ts`. Sources for the list of builds: the Old School RuneScape Wiki pages
"Account builds" and "One-defence pure" and theoatrix.net "Types of pures in OSRS". Source -> local consumer -> adapt
-> check: those pages -> `KITS` -> each build keeps its levels and takes the gear that this content has ->
`scripts/pk-kits.test.ts`, `bun scripts/pk-sim.ts --league`, the bench cases `extra:spar-builds-1` to `-4`.

The bench cases hold each of the 53 pairs once, 14 pairs in a case, in 8 processes (`SPAR_PROCS=8`) with a cap of 600
ticks. A case lasts as long as its longest fight, so the pairs stand in the order of the Defence, Hitpoints and food
of their builds (`BUILD_PAIRS`). `bun scripts/measure/pk-spar-matrix.ts --case <case>,<case>,... --parallel 2` runs
two cases at the same time, each on its own engine. Measured: the 4 cases at one seed take 61 to 65 s, and 3 seeds
(159 fights) took 190 s, 1.2 s a fight. One case alone takes about 19 s: 3.6 s of logins and 9 to 13 s of fights.

Where the time of a case went, on `extra:spar-builds-4` (22 clients), from `SPAR_TIMING`, `SIM_ACK_FILE` and a
count of the engine's tick phases:

- The clients take about 3 ms of a tick. The engine's own tick was 27 to 34 ms, 11 to 14 ms of it the read of the
  client messages: 29 prayer clicks a tick (`IfButton`, the prayer guard and the fight loop) at 0.28 ms each.
- The cost of a click was its packets. Outside `processClientsOut()` the engine sent each script packet (varp, sound,
  text; about 1000 a tick) as its own WebSocket frame. A lockstep engine sends one message for each client each tick
  (`patches/rs-sdk.md`, item 10): tick 16 to 19 ms, logins 5.0 s to 3.6 s, the case 34 s to 19 s.
- `openBot` reads the two NPC tables of the prayer guard (1.2 s, synchronous) before the connection. After the
  connection the read held the tick of every other client: logins 6.4 s to 4.9 s.
- One pair in each process (`SPAR_PROCS=11`) gave no gain over 8 processes: 30.2 s against 30.7 s. The logins of 11
  processes took 6.9 s against 5.0 s.

- **What this content has.** The Fremennik helms (Berserker `viking_helmet_crush`, Archer, Warrior, Farseer: Defence
  45 and The Fremennik Trials), the dragon medium helm, chainbody and platelegs (Defence 60, no quest), the dragon
  square shield (Legends' Quest), the granite shield (Defence 50 and Strength 50), the dragon battleaxe (Heroes'
  Quest), the dragon halberd (Regicide, Attack 60, strength bonus 89, one hit each 7 ticks), the rune two-handed
  sword (Attack 40, strength bonus 70, 7 ticks) and black dragonhide (Ranged 70; the body needs Defence 40 and no
  quest) (`levelrequire/scripts/tier*.rs2`).
- **Gear that a quest keeps from a build.** Dragon Slayer gives Defence 88, so no build under Defence 88 wears the
  rune platebody: the body is black dragonhide at Defence 40 and 50 and the dragon chainbody at Defence 60. Legends'
  Quest needs Heroes' Quest and Dragon Slayer, so no such build carries the dragon square shield or the dragon mace.
  The Fremennik Trials give Attack, Strength and Defence 60, so a build with a Fremennik helm has those three levels
  ("Quest routes of the builds").
- **What it lacks.** No obsidian maul, granite maul, rune defender, Barrows armour, Void armour, Initiate armour,
  metal gloves, rune crossbow, mystic robes, Ancient Magicks, Vengeance, Smite or Piety. So the obsidian mauler, the
  Initiate pure, the Void pure, the 13 Defence pure and the Piety build have no kit.
- **Free levels.** With Attack 60 and Strength 99 the melee term of the combat level is 159. Ranged 99 and Magic 99
  give 148, so they add no combat level; they add Hitpoints.
- **Prayer.** Prayer 43 opens the three protect prayers and the 15% prayers for 5 combat levels.

| Kit | Levels besides 1 | Combat | Hitpoints | Fights with | Shop cost |
|---|---|---|---|---|---|
| `pure-dds` | Attack 60, Strength 99 | 72 | 84 | dragon dagger, super attack and strength | 34,044 |
| `pure-dds-msb` | Attack 60, Strength 99, Ranged 99 | 75 | 93 | magic shortbow, dragon dagger | 181,932 |
| `pure-r2h` | Attack 40, Strength 99, Ranged 99 | 71 | 93 | magic shortbow, rune two-handed sword | 221,932 |
| `pure-hally` | Attack 61, Strength 99, Ranged 99, Magic 54, Prayer 43 | 80 | 93 | magic shortbow, dragon halberd | 407,712 |
| `pure-ranger` | Ranged 99 | 69 | 83 | magic shortbow | 238,332 |
| `pure-mage` | Magic 99 | 69 | 83 | Fire Wave, Entangle | 19,613 |
| `pure-tribrid` | Attack 60, Strength 99, Ranged 99, Magic 99 | 76 | 99 | Fire Wave, magic shortbow, dragon dagger | 192,232 |
| `pure-pray` | `pure-dds-msb` with Prayer 43 | 80 | 93 | magic shortbow, dragon dagger | 181,712 |
| `rune-pure` | Attack 60, Strength 99, Defence 40, Ranged 99, Magic 99, Prayer 43 | 91 | 99 | the tribrid kit in rune with a black dragonhide body | 389,352 |
| `dragon` | the same with Defence 60 | 96 | 99 | the tribrid kit with dragon helm, chainbody and legs and the rune kiteshield | 896,672 |
| `zerker` | the same with Defence 60 | 96 | 99 | `dragon` with the Berserker helm | 856,672 |
| `range-tank` | Attack 74, Strength 73, Defence 60, Ranged 99, Magic 99, Prayer 43 | 91 | 94 | magic shortbow and Fire Wave in black dragonhide with the Archer helm | 281,692 |
| `mage-tank` | Defence 60, Magic 99, Prayer 43 | 89 | 84 | Fire Wave in splitbark | 136,112 |

Simulator ranking, 1,000 fights for each pair (`bun scripts/pk-sim.ts --league`; `.practice/pk-builds/sim-pure.txt`
and `sim-def.txt` in the worktree that ran it). Mean is the mean win rate against the other kits of the list.

| Defence 1 bracket | Mean | | Defence 40 to 60 bracket, with two pures and `tribrid-pots` | Mean |
|---|---|---|---|---|
| `pure-pray` | 0.960 | | `tribrid-pots` (combat 126, for scale) | 0.986 |
| `pure-hally` | 0.712 | | `dragon` | 0.663 |
| `pure-dds-msb` | 0.704 | | `zerker` | 0.642 |
| `pure-ranger` | 0.651 | | `range-tank` | 0.634 |
| `pure-dds` | 0.490 | | `rune-pure` | 0.501 |
| `pure-tribrid` | 0.261 | | `pure-pray` | 0.390 |
| `pure-r2h` | 0.208 | | `pure-tribrid` | 0.092 |
| `pure-mage` | 0.002 | | `mage-tank` | 0.089 |

- Candidates from the simulator: Prayer 43 is the largest gain at Defence 1 (`pure-pray` beats `pure-dds-msb` in 75%
  of fights, 5 combat levels higher; `pure-hally`, which has Prayer 43 too, is second). Defence 60 wins over Defence
  40: `dragon` beats `rune-pure` in 84%. The two Defence 60 helms are level: `dragon` beats `zerker` in 53%.
  `range-tank` beats `dragon` in 64% and `zerker` in 65%, and loses to `pure-pray` in 55%.
- Gap: the simulator has no freeze and no movement, and it alternates the bow and a 7-tick weapon where a player
  keeps the slow weapon for the kill. Its ranger result is higher than the bench (finding 18).

Bench ranking. Conditions: lockstep practice engine, Wilderness level 34 at (3125, 3790), both sides on the profile
`snap` (`predictPrayer`, `snapPrayer`; it sets no rotation, so each kit attacks with its own styles), cap 600 ticks,
each pair 3 fights (seeds 1, 2, 3), `extra:spar-builds-1` to `-4`. Evidence: `.practice/pk-builds/set1.txt` and
`rank1.txt` in the worktree that ran them. A build of both brackets has 36 fights, the others 21. Net is the net
damage for each 100 ticks.

| Kit | Combat | Fights | Wins | Losses | Draws | Net |
|---|---|---|---|---|---|---|
| `zerker` | 96 | 21 | 18 | 3 | 0 | +68.9 |
| `range-tank` | 91 | 21 | 16 | 4 | 1 | +52.5 |
| `pure-hally` | 80 | 21 | 15 | 5 | 1 | +52.2 |
| `pure-pray` | 80 | 36 | 23 | 12 | 1 | +69.1 |
| `dragon` | 96 | 21 | 13 | 8 | 0 | +45.5 |
| `rune-pure` | 91 | 21 | 13 | 8 | 0 | +44.0 |
| `pure-dds-msb` | 75 | 36 | 19 | 17 | 0 | -26.6 |
| `pure-ranger` | 69 | 36 | 18 | 18 | 0 | -8.8 |
| `pure-dds` | 72 | 21 | 10 | 11 | 0 | -8.8 |
| `pure-tribrid` | 76 | 21 | 6 | 15 | 0 | -31.8 |
| `pure-r2h` | 71 | 21 | 4 | 17 | 0 | -78.4 |
| `mage-tank` | 89 | 21 | 2 | 18 | 1 | -59.7 |
| `pure-mage` | 69 | 21 | 0 | 21 | 0 | -142.1 |

- **Defence 1: Prayer 43 wins.** The two builds with it lead the bracket: `pure-hally` won 15 of 21 and `pure-pray`
  17 of 21 against the Defence 1 builds. They drew level with each other (1 to 1 and a draw). `pure-dds-msb`, the
  bow and dagger with no prayer, won 3 of 3 against `pure-hally` and 2 of 3 against `pure-pray`, and lost 8 of 9 to
  the rune, zerker and dragon builds.
- **A pure against Defence 40 to 60.** `pure-pray` won 6 of 15 against those builds, 9 to 16 combat levels above it:
  3 of 3 against `mage-tank`, 1 of 3 against `rune-pure`, `dragon` and `range-tank`, and 0 of 3 against `zerker`.
- **Defence 40 to 60: no build is clear.** `zerker` won 18 of 21, `range-tank` 16, `dragon` 13 and `rune-pure` 13.
  `zerker` won 3 of 3 against `dragon`, which wears the same body and legs; a run of the same cases before this one
  gave `dragon` 2 of 3 against `zerker` and both builds 16 of 21. So the order inside this bracket is not decided.
- **A build with one style from range loses.** `pure-mage` won 0 of 21 and `mage-tank` 2 of 21. `pure-ranger` won
  0 of 18 against the two Prayer 43 pures and the rune, zerker, dragon and range-tank builds, and every fight
  against the other builds.
- **The two-handed sword loses.** `pure-r2h` won 4 of 21. The loop alternates the bow and the 7-tick weapon; a loop
  that keeps the slow weapon for the kill is not measured. The halberd has the same attack time, and its build
  wins with Prayer 43.
- The simulator and the bench agree on the Prayer 43 pures at the top of the Defence 1 bracket and on the last
  build of each bracket. They differ on the order of the Defence 40 to 60 bracket.
- Control for the side of a pair: the same build on both sides (`extra:spar-kit-dragon-x8` and
  `extra:spar-kit-pure-pray-x8`, profile `snap`, seeds 1, 2, 3, 48 fights). Side A won 26, lost 21 and drew 1
  (`dragon` 11 to 13, `pure-pray` 15 to 8). 26 of 47 is inside the chance range of an even fight, so the table has
  no side correction. Evidence: `.practice/pk-builds/control.txt` and `control-dragon.txt`.
- Gap: 3 fights for each pair say nothing about one pair. No fight against the maxed tribrid: combat 126 is out of
  range of these builds at Wilderness level 34.
- Gap: Hitpoints assume trained levels. Quest XP gives no Hitpoints, so a quest route gives a lower combat level.
- **The Berserker helm build has Defence 60.** The Fremennik Trials give 2,812.4 XP each in Attack, Defence,
  Strength and Hitpoints (`quest_viking`), 70,310 at the server's rate of 25: level 60 from level 1. So no build
  wears a Fremennik helm at Defence 45, and `zerker` is `dragon` with the Berserker helm.
- **A build in the plan.** The `builds` object of `swarm.json` names a kit for an army account
  (`"builds": { "<account>": "pure-pray" }`). `scripts/autopilot.ts` `buildCaps` turns each kit into its levels, and
  `packages/planner/src/autopilot.ts` `buildBand` gives such an account only bands that train one skill and stop at
  the level of the build: the cow and trooper bands with `TARGET_LEVEL` and no buried bones, and the held-bones
  Prayer band with the level as its target. It refuses stock bands, kill-count bands, bought-bone bands and every
  quest band that is not on the route of the kit ("Quest routes of the builds"). Evidence: `packages/planner/test/autopilot.test.ts`, `scripts/autopilot.test.ts`. Proof level: unit.
- Gap: no live run of a build account under the planner.

### Quest routes of the builds

Claim: every kit of `scripts/pk-kits.ts` has a quest route, but `pure-iban` and `pure-rock`, which say why they have none. A route is the quests that the items and varps of the
kit need, with the quests that those need. It is valid when the rewards of all those quests together take none of
Attack, Strength, Defence, Ranged, Magic, Prayer and Hitpoints over the level of the kit.

Conditions: XP rate 25 (`WorldConfig.ts` `xpRate`), the level curve of `packages/planner/src/curve.ts`, the rewards
counted from level 1. `stat_advance` takes tenths of XP. `kitRoute` in `scripts/pk-kits.ts` works each route out
from the wear rules (`ITEM_QUEST`, `VARP_QUEST`), the quest conditions (`QUEST_CHAIN`) and the rewards
(`knowledge/quests.json`).

What the wear rules ask (`levelrequire/scripts/levelrequire.rs2` and `tier*.rs2`):

- Lost City: the dragon dagger and the dragon longsword (`tier60.rs2:2-5`).
- Dragon Slayer: the rune platebody (`tier40.rs2:26`) and the green dragonhide body (`tier40.rs2:65`). The black
  dragonhide body needs Ranged 70 and Defence 40 and no quest (`tier70.rs2:6`). The dragon medium helm, chainbody
  and platelegs need Defence 60 and no quest (`tier60.rs2:12-15`).
- Heroes' Quest: the dragon mace and the dragon battleaxe (`tier60.rs2:4,6`). It asks for Lost City, Dragon Slayer,
  Merlin's Crystal and Shield of Arrav (`quest_hero.rs2:2-4`).
- Legends' Quest: the dragon square shield (`tier60.rs2:13`). The guard asks for Family Crest, Heroes' Quest, Shilo
  Village, Underground Pass, Waterfall Quest and 107 quest points (`legends_guard.rs2:50-53`).
- The Fremennik Trials: the four Fremennik helms (`levelrequire.rs2:124`).
- Regicide: the dragon halberd (`tier60.rs2:10`). It needs Underground Pass, as Iban's staff does.
- The Mage Arena: the god staff and cape. It is a minigame with no XP reward; its casts give Magic XP ("The Mage
  Arena" below).

Rewards in the seven combat skills (`knowledge/quests.json`; the line of each `stat_advance`):

| Quest | Reward XP at rate 25 | Level from 1 | Source |
|---|---|---|---|
| Monk's Friend, Murder Mystery | Woodcutting and Crafting only | none | `quest_drunkmonk.rs2:89`, `quest_murder.rs2:428` |
| Lost City | none | none | `quest_zanaris.rs2:103-106` |
| Dragon Slayer | Strength 466,250, Defence 466,250 | 88, 88 | `quest_dragon.rs2:33-34` |
| The Fremennik Trials | Attack, Strength, Defence, Hitpoints 70,310 each | 60 each | `quest_viking.rs2:135-138` |
| Heroes' Quest | Attack, Strength, Defence, Hitpoints 76,875 each; Ranged 51,875 | 62 each; 56 | `quest_hero.rs2:29-33` |
| Underground Pass | Attack 75,000 | 61 | `quest_upass.rs2:801` |
| Regicide | Agility only | none | `knowledge/quests.json` |
| Waterfall Quest | Attack 343,750, Strength 343,750 | 83, 83 | `quest_waterfall.rs2:491-492` |
| Legends' Quest | four times 191,250 in a skill the player picks; Woodcutting and Crafting are on the list | none needed | `radimus_erkle.rs2:122` |
| Merlin's Crystal, Shield of Arrav, Family Crest, Shilo Village, Jungle Potion, Biohazard | no combat skill | none | `knowledge/quests.json` |
| Holy Grail | Prayer 275,000, Defence 382,500 | 80, 85 | `quest_grail.rs2:116-117` |

The route of each kit with levels of its own (`BUILD_QUESTS`):

| Route | Kits |
|---|---|
| no quest | `pure-bolt`, `pure-r2h`, `pure-ranger`, `pure-mage`, `pure-scim`, `mage-tank`, `baby-pure`, `low-ranger`, `low-mage`, `low-addy`, `skiller` |
| Lost City | `pure-dds`, `pure-dds-msb`, `pure-tribrid`, `pure-pray`, `pure-pray31`, `pure-dlong`, `pure-knives`, `pure-max`, `addy-pure`, `rune-pure`, `def50`, `dragon` |
| Lost City, The Fremennik Trials | `zerker` |
| The Fremennik Trials | `range-tank`, `tank-range` |
| Regicide (with Underground Pass) | `pure-hally` |
| Mage Arena | `pure-god` |

The kits with no levels of their own are maxed (`tribrid` and its forms, `melee`, `ranger`, `mage`): Dragon Slayer,
Lost City and Heroes' Quest give nothing over 99.

How a kit keeps its route:

- A build under Defence 88 wears no rune platebody and carries no dragon square shield and no dragon mace: those
  need Dragon Slayer. Dragon Slayer and Heroes' Quest together give Attack 62, Strength 90 and Defence 90, and the
  whole chain of Legends' Quest Attack 88, Strength 97 and Defence 90.
- A build with a Fremennik helm has Attack 60, Strength 60 and Defence 60 or more. The range tanks have Attack 74
  and Strength 73: the melee term (147) stays under the Ranged term (148), so `range-tank` is 91 and `tank-range`
  102 with those levels and with Attack 1 and Strength 1. They need the levels for the quest: Koschei is an unarmed
  fight, and each of his forms leaves after 1,000 ticks (`viking_thorvald.rs2:180,232,252,262`).
- A route counts the XP of the fights of a quest where the quest script sets the style (`FIGHT_XP`): The Fremennik
  Trials 35,000 Strength XP. `levelsBeforeRoute` gives the levels a build may have before its quests: `range-tank`
  Attack 68, Strength 60 and Defence 7; `tank-range` the same with Defence 99; `zerker` Attack 7, Strength 99 and
  Defence 7.
- The halberd build has Attack 61, what Underground Pass gives. Its combat level stays 75.
- The Fremennik Trials leave 698 XP under level 61, so a build with Attack 60 or Defence 60 does the quest before
  any other XP in that skill.
- The fights of Lost City give XP too: 4 XP times 25 for a point of damage, so the tree spirit (85 Hitpoints,
  `tree_spirit.npc`) gives 8,500 XP and an Entrana zombie (30 Hitpoints) 3,000 to the skill of the melee style the
  account has set. Attack 60 to 61 is 4,815 XP and Defence 1 to 2 is 80 XP. `scripts/generated/quest-zanaris.ts`
  sets the style that trains only Strength before each fight (`strengthStyle` of `quest-lib.ts`, the choice of
  `giantStyle`): Kick for the zombies, which it fights with bare hands, and Hack for the tree spirit with the bronze
  axe. A weapon with no such style ends the quest before the first hit.
- Lost City on a `pure-pray` account keeps the build. Conditions: practice, the levels of `kitSkills('pure-pray')`
  with Woodcutting 56 and Crafting 51 (what Monk's Friend and Murder Mystery give), nothing worn, the pack of the
  preset `quest_zanaris` (2 prayer potions, 6 lobsters, the runes of the Lumbridge teleport), lockstep engine.

  | Seed | Ticks | Zombies | Food eaten | Lowest Hitpoints of 93 | XP |
  |---|---|---|---|---|---|
  | 7 | 1,174 | 4 | 0 | 87 | Strength 14,200, Hitpoints 4,692 |
  | 1 | 844 | 3 | 0 | 73 | Strength 17,600, Hitpoints 5,812 |
  | 2 | 911 | 3 | 0 | 88 | Strength 11,700, Hitpoints 3,870 |
  | 3 | 955 | 5 | 0 | 84 | Strength 23,700, Hitpoints 7,842 |

  Each run ended with the quest complete and no death. No run gave XP to Attack, Defence, Ranged, Magic or Prayer.
  With Magic 1 the account does not cast the Lumbridge teleport: it walks from the Wilderness to the swamp shed.
  The band `army-quest-lostcity` has a second set of needs for such an account (`LOST_CITY_BUILD`): Attack 60,
  Strength 99, Prayer 43, Hitpoints 93, 2 prayer potions and 6 meals. Evidence: `bun run bench lostcity-pure-pray`
  (case `extra:lostcity-pure-pray` of `scripts/measure/aio-bench-cases.ts`), one run for each seed.

- The Fremennik Trials on a range tank keep the build. Conditions: practice, lockstep engine, the whole quest from
  the preset `quest_viking` (nothing worn, the quest pack, 4 sharks), the levels of `levelsBeforeRoute` with every
  other skill 99, the bench cases `extra:viking-range-tank` and `extra:viking-tank-range`.

  | Kit | Seed | Ticks | Strength XP of the fights | Result |
  |---|---|---|---|---|
  | `range-tank` | 1, 2, 3 | 3,433, 3,456, 3,455 | 23,100, 25,200, 24,200 | quest complete, no death |
  | `tank-range` | 1, 2, 3 | 3,510, 3,476, 3,570 | 26,300, 24,700, 26,800 | quest complete, no death |

  Each run gave 70,310 XP to Attack and to Defence, the reward alone. The maxed preset (`quester:quest:viking`)
  passes with the same script in 2,921 ticks and 29,400 Strength XP from the fights. A run takes 72 to 90 s.
- What the quest script does for a build (`scripts/generated/quest-viking.ts`), each from a failed practice run:
  - It sets the style that trains only Strength (Kick) before the Draugen and before Koschei. Without it the fights
    gave 17,100 and 6,400 Attack XP.
  - It does not stop to close a level-up window in the Koschei fight. The wait cost about 300 ticks, the form healed
    to full, and the prayer guard, which sends no prayer with a window open, held Protect from Melee until the points
    ran out: a build with Defence 7 died to the third form.
  - It sends each attack as one input and sends it again when the health bar of a new form is live. A new form shows
    the empty bar of the form before it, the prayer guard reads an attack on such a target as an input that is not an
    attack, and it then holds the prayer for the rest of the fight (`packages/core/src/prayer-guard.ts`
    `attackTarget`). With the fix the guard flicked 289 to 332 times and the points stayed 43.
  - It waits up to 4,000 ticks for the fight.
- `zerker` passes with new starts of the trial. With Attack 7 it lands about 9 damage in 100 ticks, and each form of
  Koschei leaves after 1,000 ticks. When Koschei is gone for 30 ticks the bot climbs the arena ladder up and down,
  which starts the trial again with the first form (`viking_warrior_ladder_up`, `spawn_viking_enemy`), at most 8
  times. The whole quest at seeds 1, 2 and 3 (`extra:viking-zerker`): 6,267, 4,597 and 9,253 ticks with 2, 1 and 3
  tries, quest complete, no death, 70,310 Attack and Defence XP (the reward alone), 23,500 to 56,400 Strength XP from
  the fights. One more run of seed 3, with a limit of 4 tries, lost the third form 4 times. Weapons, armour and
  runes are refused at the arena ladder (`can_enter_thorvald_trial`), and Peer banks every item before it.
- The two stages with a fight pass alone for the range tanks: `extra:viking-range-tank-draugen` 1,330 ticks and
  `extra:viking-tank-range-draugen` 1,424 ticks (`--set VK_FROM=draugen`, one run each).
- The fights of Underground Pass and Regicide, on the maxed presets (`quester:quest:upass`, 2,483 ticks;
  `quester:quest:regicide`, 3,273 ticks; one run each): Underground Pass gives 53,400 XP to the style of the fights
  (534 damage) and 17,690 Hitpoints XP beside its reward; Regicide gives 11,100 XP and 3,677 Hitpoints XP. So a
  build needs a skill at 99 for that XP.
- An account that brings 50 or more rune or iron arrows fights both quests with the bow, the magic shortbow when
  the pack holds one, in the style that trains only Ranged (`RANGED_ARROWS` in `quest-upass.ts` and
  `quest-regicide.ts`, `styleOnly` in `quest-lib.ts`). Any other account takes the rune scimitar.
- `pure-hally` passes both quests. Conditions: practice, lockstep engine, nothing worn, a magic shortbow and 600
  rune arrows in the pack; Thieving 50, Agility 68 and every other skill outside the build at level 1 (Regicide:
  Crafting 10); Underground Pass from the levels before the route (Attack 11, Magic 53) with two prayer potions in
  the place of two sharks, Regicide with Attack 61. Cases `extra:upass-pure-hally` and `extra:regicide-pure-hally`.

  | Quest | Seeds | Ticks | Sharks eaten | Lowest Hitpoints of 93 | XP of the fights and spells | Result |
  |---|---|---|---|---|---|---|
  | Underground Pass | 1, 2, 3 | 2,697, 2,858, 2,811 | 4, 8, 4 | 35, 33, 35 | Ranged 95,200, 85,700, 91,900 | quest complete, no death |
  | Regicide | 1, 2, 3 | 3,242, 3,229, 3,250 | 11, 10, 10 | 38, 40, 43 | Ranged 11,000, 11,000, 11,100; Magic 4,250 | quest complete, no death |

  Underground Pass gave 75,000 Attack XP, the reward alone: Attack 61 from 11.
- The least Agility is 68. A collapsed bridge of the pass rolls `stat_random(agility, 160, 300)`
  (`upass_obstacles.rs2:374`). The engine passes the roll when `floor(160 * (99 - level) / 98) + floor(300 * (level
  - 1) / 98) + 1` is over a number from 0 to 255 (`PlayerOps.ts` `STAT_RANDOM`): the value is 256 from level 68 and
  255 at level 67. A failed roll puts the account on the floor of the chasm (2335,9821 or 2333,9866), and the quest
  scripts do not leave it: the next step ends the run. The script of Underground Pass crosses such a bridge 11 times, and
  the script of Regicide 6 times in its two trips through the pass. Underground Pass at seeds 1, 2 and 3: Agility 56 passed 1 of 3 (the runs ended
  "step bridge west 2 back" and "step bridge cat 2"), Agility 62 passed 2 of 3 ("step bridge cat 2"), Agility 69
  passed 3 of 3, Agility 68 passed 3 of 3. Regicide at Agility 56, one run: "step bridge temple 1.1". The rope swing
  (`stat_random(agility, 100, 410)`, `:113`) cannot fail from level 51. The other Agility rolls of the two quests,
  and the Thieving rolls of the traps (90 in 100 at Thieving 50), cost Hitpoints and a new try.
- Two changes to the scripts, each from a failed practice run at these levels:
  - The woodspring trap of Tirannwn rolls `stat_random(agility, 30, 155)` (`quest_regicide.rs2:32`): 45 in 100 at
    Agility 68 and 61 in 100 at 99. `quest-regicide.ts` tries it 12 times; with 4 tries a run ended "step to
    catapult P:2235,3181".
  - A failed disarm of the orb trap hits inside its delay, the game drops an eat sent in that delay, and the eater
    of the quest ended the run with "food debit unobserved". The eater of the quest scripts sends such an eat again,
    twice at most (`dropRetries` in `packages/core/src/sustain.ts`, set in `quest-lib.ts`).
- The quest sweep brings the pack of the build (`scripts/quest-sweep.ts` `BUILD_PACK`, `buildPack`). An account with
  Defence under 40, Ranged 50 or more and Ranged over Attack takes a magic shortbow and 600 rune arrows for
  Underground Pass and for Regicide, and for Underground Pass two prayer potions and 12 sharks; for Regicide 8
  sharks, which leaves the slot of the coins for the shops. The sweep banks what such an account wears. Conditions:
  practice, lockstep engine, the account at the Ardougne north bank with the kit worn (bow and 300 arrows worn).

  | Case | In the bank | Seeds | Ticks with the bank and shop pass | Sharks eaten | Result |
  |---|---|---|---|---|---|
  | `extra:sweep-upass-pure-hally` | the quest pack, 600 rune arrows, 2 prayer potions, 12 sharks | 1, 2, 3 | 2,711, 2,887, 2,913 | 7, 8, 4 | quest complete, no death, Attack 61 |
  | `extra:sweep-regicide-pure-hally` | 600 rune arrows, the runes, 30 sharks, 8 coal, a cooked rabbit, a limestone, 2 iron fire arrows, a pestle and mortar, 2 ropes, 5,000 coins; the King's message in the pack | 1, 2, 3 | 3,772, 3,847, 3,775 | 9, 10, 10 | quest complete, no death |

  The Regicide sweep buys a rope, a shortbow, a tinderbox, a pot and 4 balls of wool in shops and takes a spade
  from its spawn. Runs with less in the bank ended: "missing 2532:2,3211:1" (no shop sells the iron fire arrows and
  the limestone), "Ogre merchant shop did not open" (the seller that the sweep picks for the pestle and mortar),
  "bank items coal=8" (the quest script takes a second rope out of the bank at Falador), and with 10 sharks "input
  capacity short: free 25, required 26".
- The two trainers of the route, at the levels of the build before it: `extra:thieve-50-pure-hally` (Thieving 1 to
  50 at the Ardougne market with `scripts/generated/thieving60.ts`, seeds 1, 2, 3: 485, 757 and 695 ticks, lowest
  Hitpoints 63, 43 and 49 of 93, no death) and `extra:agility-68-pure-hally` (Agility 60 to 68 on the Gnome
  Stronghold course with `scripts/agility-order.ts`: 1,353 ticks and 49,688 XP at each seed, 23 laps of 2,162 XP).
  Level 68 from level 1 is 115,881 XP, 54 laps: about 3,200 ticks at that pace (an estimate, no run).
- What the build needs, each from a failed practice run:
  - Prayer 43. With Prayer 1 and a shortbow with iron arrows the account died to the demon Holthion after 17 sharks,
    and in Regicide to a Tyras guard after 10.
  - Prayer potions in Underground Pass. The prayer guard holds Protect from Melee with a window open, 43 points ran
    out before the blessed spiders, and the account had no food left there. The script drinks a dose under 12 points.
  - Magic 51 in Regicide, for the Falador and Ardougne teleports. With a lower level the walk out of Tirannwn ended
    "quest corridor exhausted bounded retries". The two casts give 4,250 Magic XP (`FIGHT_XP`), so the kit has Magic
    54.
  - The cave of Underground Pass is single combat, and a blessed spider (level 39) attacks an account of combat 78
    or less: before the Attack reward the build has combat 76. The bot kills what attacks it before it attacks
    Kalrag, and it keeps looking for Kalrag when a spider stops its walk.
- `pure-iban` has no route, and the kit says so (`noRoute`): it stays for the bench comparison with a skiller, and
  the planner gives it no quest. It has no skill at 99 for the XP of the fights (`SINK_XP`: a kit with Underground
  Pass or Regicide on its route needs Strength, Ranged or Magic at 99), and the Hitpoints XP takes Hitpoints 10 to
  42. The 53,400 XP in Magic give Magic 63 and combat 41; split between Ranged and Magic they give level 58 in each
  and combat 39 (estimates from the curve, no run). The case `extra:upass-pure-iban` is marked `known`.

Planner: `BUILD_QUESTS` in `packages/planner/src/autopilot.ts` holds the routes by kit name, `scripts/autopilot.ts`
`buildQuests` and `buildBefore` give each account of the `builds` object the route of its kit and its levels before
the route, and `buildBand` passes a quest band only when its quest is on that route and no skill of the account is
over its level before the route. While a quest of the route is open, a training band stops at the level before the
route. Every other quest band stays refused (Holy Grail: Prayer 80 and Defence 85). The planner has two quest bands
for a build: `army-quest-lostcity` and `army-quest-fremennik` (the chain `drunkmonk,murder,viking`; a pilot; for
build accounts only; it asks Prayer 43, Hitpoints 90, Fletching 25, and Attack 60 with Strength 60 or Strength 99). A build
with Regicide on its route has four more bands, all pilots for build accounts only (`ROUTE_BEFORE` puts Underground
Pass on that route): `army-thieve-50` and `army-agility-68` train to the two levels; `army-quest-upass` runs the
chain `elena,biohazard,upass` and asks Ranged 99, Prayer 43, Hitpoints 90, Thieving 50, Agility 68, 5,000 coins, a
magic shortbow, 600 rune arrows, 2 prayer potions and 12 meals; `army-quest-regicide` runs the chain
`murder,regicide` (Murder Mystery gives the Crafting of the loom) after Underground Pass and asks Magic 51, the same
bow pack, the runes of two teleports, 30 meals and `REGICIDE_PACK` (8 coal, a cooked rabbit, a limestone, 2 iron
fire arrows, a pestle and mortar, 2 ropes). A quest band names the skills that its chain gives XP in (`gives`), and
only those are held to the level before the route: Regicide is not refused for the Attack 61 that Underground Pass
gave. `KIT_PRICE_CAPS` has every item of the two kits that the Grand Exchange lists for a use: the bow, the rune
arrows, the prayer potions, the meals, the runes and coal (17,157 listed from 499). The bank snapshots of the sides
hold 3 magic shortbows, 814 rune arrows and no prayer potion. The band
`army-fletch-25` brings that Fletching level to a build with the quest on its route: a walk to the Ardougne north
bank, then 210 headless arrows from 310 banked arrow shafts and 310 feathers with the fletching worker
(`scripts/fletch-arrows.ts`, mode `headless`). Practice: 210 arrows in 26 ticks and 5,250 XP, over the 4,863 of
level 25 (`extra:fletch-headless-25`, one run). The worker does not walk: 25 tiles from the bank it ended "bank did
not open", so the band has the walk step. The Grand Exchange lists no arrow shafts and no logs. The bank snapshots
of the sides hold 42,000 arrow shafts (`local` 41,880) and 74,670 feathers, and the kit tier orders the band's
items from a donor account.

Evidence: `scripts/pk-kits.test.ts` ("every kit has a quest route, and the planner holds the route of every build")
fails when a kit wears an item whose quest gives a level over the kit, and when `BUILD_QUESTS` differs from
`kitRoute`; `packages/planner/test/autopilot.test.ts` and `scripts/autopilot.test.ts` hold the planner rule. Proof
level: unit, and practice for the Lost City run of `pure-pray`, the Fremennik runs of the two range tanks and the
Underground Pass and Regicide runs of `pure-hally`, with their sweep cases and the two trainer cases, and the Mage
Arena runs of `pure-god`.

Gaps:

- `kitRoute` counts quest rewards and the fights of `FIGHT_XP`. Underground Pass and Regicide have fights with no
  style rule.
- The path of `pure-hally` is proved in parts on practice and not as one run: no account ran the four bands in
  order, and no run started Underground Pass from an account that the chain took through Plague City and
  Biohazard, or Regicide from an account that the chain took through Murder Mystery. The Regicide cases start with
  the King's message in the pack; on a live account a messenger brings it.
- No job brings four items of `REGICIDE_PACK`: the limestone, the 2 iron fire arrows, the cooked rabbit and the
  pestle and mortar. The Grand Exchange lists none of them, so `army-quest-regicide` waits until the account holds
  them. The sweep picks the ogre merchant for the pestle and mortar, and that shop does not open.
- The quest scripts do not leave the floor of the chasm after a fall from a bridge, so the route asks Agility 68.
  With a way back up, Regicide could start at its own Agility 56.
- The Agility case covers levels 60 to 68. No run took a build account from Agility 1 to 68 or from Ardougne to
  the course; `skiller:agility:order` has the first levels on a plain account.
- The planner has no band for the Mage Arena, so `pure-god` gets it from no job.
- One more run of `extra:upass-pure-hally` ended at its start, "no npc king lathas", with the account on the ground
  floor at Hitpoints 99: the preset was not on the account. The cause is not found; the next run of that seed passed.
- The two steps of `army-fletch-25` ran together one time through `scripts/chain.ts`, from 25 tiles east of the
  bank: the walk took 52 ticks and the worker made 210 arrows in 26 ticks ("RESULT ok chain rounds=1 ok=2
  failed=0"). The bench holds no case for it: its start check reads the START line of one worker, and a chain has
  none. No live run. One account holds 41,640 of the 42,000 arrow shafts.
- No live run of `army-quest-fremennik`, and no practice run of the chain `drunkmonk,murder,viking` through the quest
  sweep from an army account's state: the cases start at Brundt with the pack in hand.
- The quest points that a quest asks (Dragon Slayer 32, Heroes' Quest 55, Legends' Quest 107) are not in the route:
  only the maxed kits need those quests.
- No live run of Lost City by an account with Defence 1. The practice case starts at the warrior with the pack in
  hand: no run of the chain `drunkmonk,murder,zanaris` through the quest sweep by such an account, so the bank pass
  and Monk's Friend and Murder Mystery at those levels are not proved.
- The Hitpoints XP of the fights (3,870 to 7,842 a run) can take a build account from Hitpoints 93 to 94.
- No shop sells a prayer potion and the bank snapshots of the sides hold none. The kit tier buys the two potions on
  the Grand Exchange: 38 listed from 250,000 coins, bids at 25,000 (`KIT_PRICE_CAPS` 260,000; one read).
- Normal bones for the Prayer 43 of a build: 175 bones (19,684 XP at 112.5 a bone); the held-bones band starts at
  100. The Grand Exchange lists 2,549 at 45,125 coins each (bids at 150, last trade at 150), so 175 cost 7.9 million
  coins. `KIT_PRICE_CAPS` holds no price for normal bones for that reason: a buy at a cap near the bids fills
  nothing. The bank snapshots of the sides hold 611 normal bones (`local` 328, `claude-cloud` 229, `claude-cloud-4`
  52, `cloud` 2), and the kit tier of the planner orders a missing band item from a donor account. A cow leaves
  bones on each kill, and a build band runs with `GIANT_BURY=0`, which takes none. Evidence:
  `/api/market/items/526` of the demo server and `fleet/snapshots/*.json` on the `fleet-data` branch, one read each.
- **The Mage Arena.** Facts from the server content (`vendor/rs-sdk/server/content/scripts/areas/area_mage_arena/`,
  short names below) and from practice runs of `scripts/generated/quest-magearena.ts`.
  - Entry: Kolodion (`arenamage1`, 2541,4715, in the cellar with the bank) refuses a base Magic under 60
    (`scripts/kolodion.rs2:6`) and a player who wears or carries armour, a melee or ranged weapon, arrows, logs,
    clue items or cannon parts (`scripts/mage_arena.rs2:100-138`). The list has no staff, rune, potion, food or
    knife. He sets `%magearena` (varp 267) to 1 and sends the player to 3105,3934 (`kolodion.rs2:99,133`;
    `configs/mage_arena.constant:9`), Wilderness level 52.
  - There is no lever. A ladder joins the cellar (2542,4713) and a hut at 3091,3957, Wilderness level 55
    (`mage_arena.rs2:1-12`, `maps/m39_73.jm2`, `maps/m48_61.jm2`). Two webs close the hut (3093,3957 and 3095,3957);
    a knife or a slash weapon cuts one with a chance of 1 in 2 (`general_use/scripts/web.rs2:10-33`). The portal at
    3105,3953 lets a player in from the north with `%magearena` 6 or more and no armour or weapon
    (`mage_arena.rs2:82-97`).
  - Kolodion has five forms (`configs/mage_arena.npc`; `%magearena` 2 to 5 names the next form, 6 the end,
    `scripts/kolodion_fight.rs2:30,54,78,102,128`):

    | Form | Hitpoints | Defence | Magic | Range of its spell |
    |---|---|---|---|---|
    | man (`kolhuman`) | 3 | 20 | 15 | 3 |
    | ogre (`kologre`) | 65 | 72 | 50 | 5 |
    | spider (`kolspider`, 3 by 3 tiles) | 78 | 47 | 70 | 5 |
    | ghost (`kolethereal`) | 78 | 58 | 30 | 5 |
    | demon (`koldemon`, 3 by 3 tiles) | 107 | 105 | 80 | 5 |

    Each form casts one of the three god spells once in 5 ticks, also from the next tile: no form has a melee attack
    (`kolodion_fight.rs2:1-11`). The max hit is 20 (`skill_combat/configs/magic/magic_combat_spells.dbrow:478-527`).
    A hit of Flames of Zamorak lowers Magic by 5 percent, Claws of Guthix Defence by 5 percent and Saradomin Strike
    Prayer by 1. A form that dies becomes the next form on the same tile; the player who did the most damage must
    be the player of the fight (`kolodion_fight.rs2:23-46`). A player who comes back with `%magearena` 2 to 5 meets
    the form of that stage (`kolodion.rs2:15-16,135`). In the arena only spells may attack
    (`skill_combat/scripts/npc/npc_combat.rs2:133-136`).
  - Protect from Magic (Prayer 37) makes each spell of an NPC fail: no damage and no stat loss
    (`skill_combat/scripts/npc/npc_combat_magic.rs2:37-43`).
  - After the demon the player lands at 2540,4716 (`mage_arena.rs2:146-158`). The pool at 2541,4719 takes a player
    with `%magearena` 6 or more to the chamber (`mage_arena.rs2:15,47-77`). A prayer at a statue sets 7 and puts
    the cape of that god on the tile in front for 200 ticks; a player with a god cape gets no answer
    (`scripts/chamber.rs2:5-22`). The statue of Zamorak is at 2516,4721. The guardian (2508,4696) gives the staff of
    the god of the cape and sets 8 (`scripts/chamber_guardian.rs2:4-17`). A cape and a staff of two gods do not go
    on together, and a dropped cape is lost (`scripts/god_gear.rs2:1-33`).
  - A god spell needs its staff (`magic_combat_spells.dbrow:485,503,521`) and Magic 60. Flames of Zamorak costs 4
    fire, 2 blood and 1 air rune and gives 35 XP a cast before the rate. Outside the arena it needs `%zamomage`
    (varp 270) at 99. Each cast at an NPC with the player in the arena adds 1, hit or miss, and the cast at 98 sets
    99: 99 casts (`skill_combat/scripts/player/spells/scripts/flames_of_zamorak.rs2:9-38`). The arena is four
    rectangles (`configs/mage_arena.dbrow`). Charge needs `%magearena` 8 and Magic 80, and under it the spell
    hits up to 30 with the cape and staff of its god on (`skill_magic/scripts/spells/charge.rs2:4-18`,
    `flames_of_zamorak.rs2:19-25`).
  - The targets of the casts are the battle mages (Hitpoints 120, Magic 50, three of each god,
    `maps/m48_61.jm2`). Each casts its god spell, max hit 20, from 5 tiles. A mage attacks a player with
    `%magearena` 6 or more who comes within 3 tiles; a mage of the god whose cape and staff the player wears does
    so only after the player attacks it (`scripts/battle_mage.rs2:36-71`, `configs/mage_arena.hunt`). The arena is
    single combat: a cast at one mage while another attacks is refused and does not count.
  - The worker `scripts/generated/quest-magearena.ts` ends with the cape and the staff of Zamorak worn and
    Flames of Zamorak open outside the arena, in the cellar by the bank. It starts beside Kolodion with a staff of
    fire worn and, in the pack, air, fire and blood runes, a knife, prayer potions and sharks (preset
    `quest_magearena`: Magic 80, Prayer 43, Hitpoints 50, the other skills 1). It casts Fire Wave at Kolodion
    (Magic 75, max hit 20, 42.5 XP a cast before the rate; Fire Blast under Magic 75, which needs death runes) with
    Protect from Magic on, and then Flames of Zamorak at the battle mage that attacks it. The god spells need the
    god staff, and Iban Blast needs Underground Pass, so Fire Wave is the strongest spell the fight allows. Practice,
    lockstep engine, one run for each seed (`bun run bench quester:quest:magearena --seed n`):

    | Seed | Ticks | Kolodion: ticks, casts | 99 casts: ticks | Damage taken | Prayer points used | Magic XP | Hitpoints XP |
    |---|---|---|---|---|---|---|---|
    | 7 | 1,020 | 299, 59 | 516 | 0 | 4 | 189,975 | 34,695 |
    | 1 | 985 | 266, 52 | 521 | 0 | 2 | 184,300 | 35,150 |
    | 2 | 1,053 | 331, 65 | 521 | 0 | 2 | 199,562 | 36,142 |
    | 3 | 1,024 | 301, 59 | 521 | 0 | 2 | 192,337 | 35,545 |

    Each run ended with the cape, the staff and the spell, no death, no food eaten and no potion drunk: the
    prayer guard of `packages/core` turns the prayer on only for the tick of each spell. The fight with Kolodion
    alone gave 61,175 to 74,987 Magic XP and about 11,000 Hitpoints XP. The run gives no XP to another skill.
  - `pure-god` passes with Prayer 37. Conditions: the same preset at the levels of the kit (Magic 99, Prayer 37,
    Hitpoints 83), case `extra:magearena-pure-god`, seeds 1, 2 and 3: 982, 1,062 and 1,012 ticks, no damage, 1 or 2
    prayer points used, Magic XP 185,400, 194,125 and 189,112 (no level over 99), Hitpoints XP 35,892, 31,815 and
    34,820. `kitRoute` counts 205,000 Magic XP for the arena (`FIGHT_XP`) and asks Prayer 37 of a kit with the
    arena on its route.
  - With Prayer 1 the arena is not safe. The worker has a second method for a test (`MA_MODE=leash`). An NPC
    drops a target that is more than maxrange + attackrange tiles from the tile where the NPC came into the world
    and walks no more than maxrange tiles from it (`server/engine/src/engine/entity/Npc.ts`
    `targetWithinMaxRange`); the forms of Kolodion have 10 and 5. The floor of the arena is 25 tiles wide, the
    west wall has a gap on rows 3933 and 3934, and the bot casts from a tile on that row 17 tiles west of the start
    tile of the form. Each form comes where the form before it ended, 5 to 10 tiles nearer to the gap, and the walk
    behind the gap ends at x 3084, so a late form often has no such tile.

    | Kit levels | Seed | Result |
    |---|---|---|
    | Magic 99, Prayer 1, Hitpoints 83, 23 sharks | 7 | pass, 1,408 ticks: Kolodion 667 ticks, 61 casts, 14 damage; the 99 casts 547 ticks, 274 damage, 13 sharks eaten |
    | the same | 1 | died at the spider (start tile x 3100), all 23 sharks eaten by tick 513 |
    | the same | 2 | no XP for 900 ticks |
    | the same | 3 | died at the demon (start tile x 3099), all 23 sharks eaten by tick 703 |
    | `pure-rock`: Magic 80, Prayer 1, Hitpoints 10 | 7 | died to Kolodion |

    The leash does not work at the battle mages: a mage of another god follows the player into the gap, and its
    reach ends west of x 3084. An account with no prayer stands there and eats: 274 and 349 damage in two runs of
    the 99 casts at Hitpoints 83.
  - `pure-rock` does not pass and the kit says so (`noRoute`). It needs Prayer 37, which makes it combat 50, over
    the 46 of the rune rocks. With the prayer the run takes no damage, so Hitpoints 10 can stay; the run gives about
    35,000 Hitpoints XP, which takes Hitpoints 10 to about 51 (estimate from the curve, no run), and 205,000 Magic
    XP, so the account starts the arena at Magic 60 with Fire Blast (estimate, no run). The case
    `extra:magearena-pure-rock` is marked `known`.
  - Gaps: practice only, on an empty world; the Wilderness walk to the hut (level 55) is not in the worker, which
    starts in the cellar; no run with Fire Blast; the leash method fails at 3 seeds of 4; the planner has no band
    for the arena; no bank step for more food.

### Bench cases for the planner's jobs

Claim: every worker script that a template of the planner's catalogue starts has a bench case or an AIO route with
one. Conditions: the 77 templates of `catalogue()`; 17 name an AIO route with a case, and the 60 others start 11
worker scripts. `scripts/alch-train.ts` (3 bands) and `scripts/splash-train.ts` (1 band) are the AIO routes
`skiller:magic:alch-train` and `skiller:magic:splash`. Evidence: their cases (Magic 54 to 56, Low Alchemy then High
Alchemy, 63 ticks; Magic 19 to 21, 79 ticks) pass through the dispatcher, one run each at seed 1. Gap:
a case for a worker is not a case for each band of that worker, and the `chain` bands run only their first step's
worker in a case of their own.

### Second set of builds

Sources for the list: the Old School RuneScape Wiki pages "Account builds", "One-defence pure", "50 Defence Build"
and "Free-to-play account builds", and theoatrix.net "Types of pures in OSRS". Those pages name about 60 builds.
Source -> local consumer -> adapt -> check: those pages -> `KITS` -> a build gets a kit when this content has the
gear that its level cap exists for -> `scripts/pk-kits.test.ts`, the bench cases `extra:spar-builds2-1` to `-5`.

- **Builds with no kit, and the reason.** Attack 50 (granite maul), Attack 70 (whip) and Attack 75 (godsword): the
  weapon is not in this content, so the levels add combat for nothing. The obsidian mauler and the free-to-play
  Strength pure: no weapon with a high strength bonus at Attack 1. Defence 13, 20 and 25 (gloves, Initiate, infinity
  robes) and Defence 42 (Void): the gear is not in this content. Defence 70 and 75 (Barrows, Piety): the same. A
  pure with the dragon mace: the mace needs Heroes' Quest, which gives Defence XP (`levelrequire/scripts/tier60.rs2:4`).
  Defence 50 with a Fremennik helm: The Fremennik Trials give Defence 60. The Defence pure and the skillers do not
  attack.

| Kit | Levels besides 1 | Combat | Fights with |
|---|---|---|---|
| `pure-scim` | Attack 40, Strength 99, Ranged 99 | 71 | magic shortbow, rune scimitar |
| `pure-dlong` | Attack 60, Strength 99, Ranged 99 | 75 | magic shortbow, dragon longsword |
| `pure-knives` | Attack 60, Strength 99, Ranged 99 | 75 | rune knives, dragon dagger |
| `pure-pray31` | `pure-dds-msb` with Prayer 31 | 78 | magic shortbow, dragon dagger, Ultimate Strength |
| `pure-god` | Magic 99, Prayer 37 | 73 | Flames of Zamorak under Charge |
| `pure-max` | Attack 99, Strength 99, Ranged 99, Prayer 43 | 94 | magic shortbow, dragon dagger |
| `addy-pure` | the rune pure with Defence 30 | 89 | the tribrid kit in adamant |
| `def50` | the rune pure with Defence 50 | 94 | the rune pure's kit with the granite shield |
| `tank-range` | Attack 74, Strength 73, Defence 99, Ranged 99, Magic 99, Prayer 43 | 102 | magic shortbow and Fire Wave in black dragonhide with the Archer helm |
| `baby-pure` | Attack 40, Strength 70, Ranged 70 | 52 | magic shortbow, rune scimitar |
| `low-ranger` | Ranged 70 | 47 | magic shortbow |
| `low-mage` | Magic 59 | 39 | Fire Blast |
| `low-addy` | Attack 40, Strength 70, Defence 30, Ranged 70, Magic 70 | 60 | maple shortbow, rune scimitar, Fire Blast in adamant |

Bench ranking of the second set. Conditions: as the first set (profile `snap`, Wilderness level 34, cap 600 ticks,
seeds 1, 2, 3). Four brackets (`BUILD_BRACKETS_2`): the five new Defence 1 builds with `pure-pray`, `pure-dds-msb`
and `pure-ranger`; the four new builds of combat 89 to 102 with `dragon`, `zerker`, `rune-pure` and `pure-pray`; the
four builds under combat 61; and `top`, `tank-range` and `dragon` against the maxed tribrid with and without boost
potions. A pair of two builds of the first set does not run again. 58 pairs in 5 cases, 174 fights, 234 s of run
time. Rank the logs with `bun scripts/measure/pk-build-rank.ts <log> ...`. Evidence: `.practice/pk-builds/set2.txt`,
`rank2.txt` and `head.txt` in the worktree that ran them. The rows of the builds of the first set hold only their
fights of this set.

| Kit | Combat | Fights | Wins | Losses | Draws | Net |
|---|---|---|---|---|---|---|
| `baby-pure` | 52 | 9 | 8 | 1 | 0 | +68.7 |
| `pure-ranger` | 69 | 15 | 12 | 3 | 0 | +11.4 |
| `tribrid-pots` | 126 | 9 | 7 | 2 | 0 | +41.0 |
| `pure-pray31` | 78 | 21 | 16 | 5 | 0 | +86.8 |
| `pure-dds-msb` | 75 | 15 | 11 | 4 | 0 | +28.6 |
| `pure-pray` | 80 | 27 | 19 | 8 | 0 | +41.5 |
| `low-ranger` | 47 | 9 | 6 | 3 | 0 | +49.8 |
| `zerker` | 96 | 12 | 8 | 4 | 0 | +32.6 |
| `tank-range` | 102 | 27 | 16 | 11 | 0 | +39.9 |
| `pure-max` | 94 | 21 | 12 | 9 | 0 | -33.3 |
| `dragon` | 96 | 18 | 10 | 8 | 0 | +1.5 |
| `tribrid` | 126 | 9 | 5 | 4 | 0 | -9.6 |
| `pure-knives` | 75 | 21 | 11 | 10 | 0 | -90.8 |
| `rune-pure` | 91 | 12 | 6 | 6 | 0 | +4.4 |
| `def50` | 94 | 21 | 10 | 11 | 0 | -0.6 |
| `low-addy` | 60 | 9 | 4 | 5 | 0 | +10.3 |
| `pure-dlong` | 75 | 21 | 8 | 13 | 0 | -1.5 |
| `pure-scim` | 71 | 21 | 5 | 16 | 0 | +7.4 |
| `addy-pure` | 89 | 21 | 0 | 21 | 0 | -44.8 |
| `pure-god` with Prayer 1 | 69 | 21 | 0 | 21 | 0 | -92.3 |
| `low-mage` | 39 | 9 | 0 | 9 | 0 | -128.8 |

- **Combat 80 to 102: no build is clear.** `tank-range` won 16 of 27: 3 of 3 against `def50` and `addy-pure`, 2 of
  3 against `zerker`, `pure-max` and `pure-pray`, and 1 of 3 against `rune-pure` and `dragon`. `zerker` won 8 of 12
  and `dragon` 10 of 18.
- **`tank-range` beats `dragon`: 29 of 42.** The pair alone, 14 pairs in a case with each build on side A in 7
  (`extra:spar-head-tank-dragon-x14`, seeds 1, 2, 3): 15 to 6 with `tank-range` on side A and 14 to 7 on side B. In
  the build cases the same pair gave 1 to 2: 3 fights decide nothing for one pair.
- **The maxed tribrid with boost potions beats both.** `tribrid-pots` won 3 of 3 against `tank-range` and against
  `dragon`. The tribrid with no boost potions won 2 of 3 against `dragon` and 1 of 3 against `tank-range`.
- **Attack 99 at Defence 1 holds against the Defence builds.** `pure-max` won 12 of 21: 3 of 3 against `addy-pure`
  and `rune-pure`, 2 of 3 against `zerker`, and 1 of 3 against `def50`, `dragon`, `tank-range` and `pure-pray`.
- **Defence 30 in adamant loses.** `addy-pure` won 0 of 21. It carries 15 sharks against 21 to 23 of a pure.
- **Defence 1: no new build is clear of the Prayer 43 pure.** `pure-pray31` won 16 of 21 and lost 1 of 3 to
  `pure-pray`. Rune knives won 11 of 21 with a net damage of -90.8: they win on food, not on damage. The dragon
  longsword (8 of 21) and the rune scimitar (5 of 21) are worse than the dragon dagger beside the bow.
- **Magic alone loses again.** `pure-god` won 0 of 21 and `low-mage` 0 of 9.
- **Under combat 61: a bow wins.** `baby-pure` won 8 of 9 and `low-ranger` 6 of 9; `baby-pure` won 3 of 3 against
  `low-ranger`. `low-addy`, with 8 to 13 more combat levels, won 4 of 9.
- Gap: 3 fights for each pair outside the head-to-head case. The low bracket has 4 builds and 18 fights.

## Rivals: the dagger gang

Goondelf, Ligma and Sugma are accounts of another owner. They hunt every player in their combat range in the
Wilderness with dragon daggers. Sources: the world feed (`wss://rs-sdk-demo.fly.dev/worldfeed`; a record of 63
minutes is `.practice/rival-dds/trace-3.jsonl` in the main checkout), the hiscore pages (`hs-<name>.html` in that
folder) and one earlier feed record of Goondelf (`goondelf-fordmine4.txt`). `scripts/measure/pk-rival-feed.ts`
makes such a record (`record`) and prints its fights and the numbers that the bench copies (`digest`), so a longer
record checks the copy again.

What the sources show:

- **Levels.** Attack, Strength, Defence and Hitpoints 99; Prayer 99 (Goondelf) or 90 (Ligma, Sugma); Magic 37 or 28;
  no Ranged level. Combat 126 and 125.
- **Worn items.** Black wizard hat, monk's robe top and bottom, dragon dagger (p). No other slot holds an item. The
  robes give Prayer bonus 11 and no defence. Each account shows a skull after an attack.
- **Post.** Between hunts the three stand on one tile, (3078, 3640), Wilderness level 16, a single-way tile. They leave
  it together, run on the same tiles, and return to it after each hunt.
- **Targets.** They ran 230 tiles to a combat 123 player at level 45 and to a combat 96 player at the runite rocks
  (level 46). Players of combat 26 to 64 passed within 20 tiles of the post and no account moved. They also run to
  (2934, 3516), where a combat 113 player stands 5 tiles outside the Wilderness, and return with no attack: 4 such
  trips in the record.
- **Attack.** The lunge of the dagger each 4 ticks (15 of 15 intervals), on a target that runs too. On a single-way
  tile the first account to hit holds the target; a second one follows it and tries again each few ticks.
- **Special.** Goondelf used 4 specials in its first 8 attacks on a miner: attack, special, attack, special, attack,
  special, special, attack. Sugma used none in 15 attacks on a target under Protect from Melee; the record starts
  inside that fight, so its special energy is not known.
- **Food.** Goondelf ate once, at 74 HP, for 20 HP (a shark), and its next attack came 3 ticks late. It did not eat at
  82 HP.
- **Protect prayers.** Sugma turned Protect from Missiles on one tick after a hit from a player that held a magic
  shortbow, and off 33 ticks later. Ligma turned Protect from Magic on in the tick before a spell landed on it, and
  off 13 to 17 ticks later. In a hunt of a target that did not hit back, no protect prayer came on.
- **Prayer points.** Ligma prayed at the Chaos Temple altar (2948, 3820) after a hunt, and Goondelf came into the
  Wilderness from the Monastery (3045, 3489) at full Hitpoints.
- **Damage.** On a target under Protect from Melee: 15 attacks, 7 hits, highest 10. On a target with no such prayer:
  one hit of 13. With no Strength boost the dagger hits up to 18, and up to 10 under the prayer (`pvp_melee.rs2:31-33`).
- **End of a hunt.** Each hunt in the record ended when the target left view or got away. No kill and no death is in
  the record.

The bench copies this (`scripts/pk-kits.ts`, `scripts/pk-spar.ts`, `scripts/pk-gang.ts`):

- Kit `ganker-dds`: the worn items, the levels of Goondelf and 12 sharks. Profile `ganker`: melee only, a special on
  each attack from the first health bar, a shark at 79 HP or less, no prayer flick, the protect prayer for the weapon
  of the opponent. Profile `ganker-bare`: the same with no protect prayer.
- Kit `ganker-max`: the same worn items and levels with a super attack, a super strength, two prayer potions and 23
  sharks. It is the most the gang can be with the items the feed shows, so a method that clears it does not depend
  on the gaps below.
- `extra:spar-ganker-x12` and `extra:spar-ganker-bare-x12`: one of ours against one of the gang, 12 pairs, on the post
  tile. `extra:gang-ganker-x4`, `extra:gang-ganker-bare-x4` and `pvp:gang`: one of ours against three on one tile; the
  engine's single-way rule decides which of the three fights (`pvp_combat.rs2:104-131`). `extra:gang-ganker-<kit>-x4`
  and `extra:gang-ganker-max-<kit>-x4` run the kits `hybrid` and `gang-hunter`, and each kit against `ganker-max`.
  `extra:gang-ganker-escape-x4` is the way out with a glory.

Gaps:

- The pack of a gang account is not visible: the number of sharks, and whether it holds potions. `ganker-dds` has an
  estimate; `ganker-max` is the upper limit.
- Prayers with no head icon (Protect Item, the Strength, Attack and Defence prayers) are not visible. The bench
  accounts use all of them.
- The eat level is between 75 and 81 HP from one eat.
- No record shows a gang account under a melee weapon, at low Hitpoints, or after its death: whether it prays against
  melee, whether it runs, and how long it takes to return to the post are not known.

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
17. **With no flick, prayer points are the clock of a fight; with the flick, food is.** With `prayerFlick: false` both
    sides of a spar that ends in a kill near tick 670 hold 0 prayer points (`prayerLeft` in the `SPAR` lines of
    `extra:spar-duel-melee-x8`): the overhead, Steel Skin and the two melee prayers drain 12 each for a tick, 60 + 2
    x prayer bonus of drain costs one point, so 99 points and eight doses of restore last about 700 ticks, and the
    first side with no points takes full hits. The fight loop flicks by default (every prayer off and on in one tick,
    each 4 ticks): the sides of `extra:spar-rivals-tribrid-snare-x12` end with 23 to 46 points after 54 to 150
    flicks, and more restore potions for less food do not win (finding 22). Gap: the flick does not hold every
    point; where the rest drains is not measured.
18. **The offline simulator agrees with the bench on tribrid kits, not on one-style builds.** `bun scripts/pk-sim.ts --table 1000`
    runs 16,000 fights in seconds with the server's hit, prayer, food and special rules. Against the tribrid it gives the
    potion kit, the lean kit and the hybrid a win and the mage, adamant and mithril kits a loss, as the bench does, and
    its mirror lasts 694 ticks where the bench mirror lasts about 650. It uses the levels of each kit, so it ranks
    the trained builds too (`--league <kit,kit,...>`). Gap: it gives the ranger 87% where the bench gives it 14 of
    24, and the melee build 37% with 27% of fights at the cap where the bench gives it 18 of 24. It has no movement
    and no freeze, and it does not play the champion profile (no prayer flick, no `snapPrayer`, `counterRead` or
    `adaptStyles`). A result from it is a candidate for the bench, not a measurement.
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
    (mean net +1.65, t 0.56, 24 spars). The champion profile has `mixStyles`; findings 32 and 33 give what an
    opponent can read from a random choice among the open styles, and the rule that answers it.
21. **The place of a pair in a batch moves its result.** With the `snap` profile on both sides and 2 pairs in each
    of 8 worker processes, side B won 11 of 16 even pairs and side A won 12 of 16 odd pairs (two batches). A swap of
    the profiles on every second pair put one profile on the weak place of every pair: base against base read as 9
    kills to 23. The swap goes by two pairs at a time (`scripts/pk-spar.ts`), and the duel cases put their kits the
    same way; the control then reads 8 to 8 and 7 to 9. Results before this rule that favoured side A stand (the
    fault worked against side A); a result that favoured side B does not. The effect holds for the champion in the
    snare kit: with no swap, side A won 4 of 16 even pairs and 10 of 17 odd pairs (`extra:spar-mirror-snare-x12`,
    seeds 11 to 13). The order of the two logins of a pair is not the cause: with side B logged in first
    (`SPAR_LOGIN=b`, the `START` lines show it) side A won 5 of 16 even pairs and 8 of 17 odd pairs (seeds 21 to 23).
    Gap: the cause; an even pair is the first pair of its worker process, and that is the lead not yet tested.
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
25. **A kit with no staff and no wave runes wins more.** `tribrid-snare` (bow, dagger, the freeze runes, boosts, 18
    sharks) on the champion profile has 20 kills and 4 deaths in 24 spars against the melee build (6 to 2), the hybrid
    (6 to 2) and the ranger (8 to 0); the hybrid kit (no freeze, 21 sharks) has 21 and 3; the potion kit (staff, wave
    runes, 15 sharks) has 27 and 9 in 36 (`extra:spar-rivals-tribrid-snare-x12`, `extra:spar-rivals-hybrid-x12`,
    seeds 1 and 2). Against a target that leaves by glory at 60 health from Wilderness level 34, the hunter in the
    snare kit kills 9 of 24 and in the potion kit 7 of 24 (`extra:spar-escape-tribrid-snare-x8`,
    `extra:spar-escape-tribrid-pots-x8`, seeds 1, 2 and 3). A kit with the runes of a freeze and no staff casts it
    with the weapon in hand (`castFreeze` in `scripts/pk.ts`); before that rule the snare kit cast none and killed 0
    of 16. Gap: the live hunter still restocks the staff kit; no whole hunter trip in the snare kit.
26. **A whole hunter trip passes in the snare kit.** From Edgeville bank with an empty pack, the hunter restocks the
    snare trip (`SNARE_TRIP` in `scripts/pk-hunt.ts`: bow, 50 earth, 50 water and 40 nature runes, two prayer
    potions, a glory, the boosts and the sharks), walks to the first hunt spot, kills the target that stands there in
    173 ticks with 24 shots and 25 dagger hits, and takes 12 piles (`extra:hunt-trip-snare`, seed 1, 27 s). The staff
    kit passes the same case (`extra:hunt-trip-staff`, 24 s). `PK_KIT=snare` selects the kit and its trip for
    `scripts/pk-hunt.ts`. Gap: the target stands and has no food, so the case proves the trip and not the fight;
    the live hunter keeps the staff trip until a side's bank holds the snare runes.
27. **An early freeze kills more targets that run and loses fights against targets that stay.** The hunter in the
    snare kit against a target that leaves by glory at 60 health from Wilderness level 34
    (`extra:spar-escape-tribrid-snare-x8` and `-x12`, seeds 1 to 10): with the freeze only when the target runs, 33
    kills in 104 spars; with the freeze from 70% health (`freeze: 'low'`, `freezeBelow: 0.7`), 56 in 104. Against
    the melee build, the hybrid and the ranger the same rule has 18 kills and 18 deaths in 36 spars, where the freeze
    on a target that runs has 30 and 6 (`extra:spar-rivals-tribrid-snare-x12`, seeds 1 to 3): the hunter cast 188
    freezes in those 36 spars, and each takes a turn of 5 ticks. A cap on the early casts (`freezeEarlyMax`) lands
    between the two on both: cap 2 has 10 kills in 24 against the target that runs and 15 kills to 9 against the
    three builds; cap 3 has 9 in 24 and 15 to 9. Other rules against the target that runs: the freeze from 80%, 11 in
    24; from 80% with the armour off for each cast, 8 in 16; the bow special as a burst, 1 in 8 and 2 in 8. The
    hunter keeps the freeze on a target that runs: at its hunt spots (Wilderness levels 3 to 7) a glory works at
    once and no freeze stops it. Gap: no rule that tells a target that will run from one that will stay before it
    runs; the target of the case fights back until it leaves, as a fighter does.
28. **Adamant arrows cost a quarter of the kit less and lose about 12 points.** 300 rune arrows are 120,000 of the snare
    kit's 392,715 coins; 300 adamant arrows are 24,000. On the champion profile against the melee build, the hybrid
    and the ranger, the snare kit with rune arrows has 55 kills and 17 deaths in 72 spars (76%) and
    `tribrid-snare-addy` has 54 kills, 29 deaths and a draw in 84 (64%) (`extra:spar-rivals-tribrid-snare-x12`,
    `extra:spar-rivals-tribrid-snare-addy-x12`, seeds 1 to 7). Gap: z is 1.6, so the 12 points are likely and not
    sure; two more rune batches (8 to 4 and 12 to 0) ran beside a second bench and are left out.
29. **The champion in the snare kit beats every build of the league.** 16 kills and no death in 16 spars against the
    eight league opponents (`extra:spar-league-snare-x8`, seeds 1 and 2): the tribrid with potions on the base and
    reader profiles, the lean tribrid with random styles, the melee build, the hybrid, the ranger, the mage and the
    food tribrid. Gap: two spars for each opponent; every opponent is our own fight loop, and none plays the
    champion profile.
30. **The eat level does not move the mirror.** Champion against champion with side A eating at 40 health has 9 kills and
    7 deaths in 16 spars; at 60 it has 6 kills, 8 deaths and 2 draws (`extra:spar-x16`, seed 1; the default is 50).
31. **The hunter takes the snare trip where its bank holds it.** With no kit named, each restock reads the bank and takes
    the snare trip when the bank holds all of `SNARE_TRIP`, else the staff trip (`pickTrip` in
    `scripts/pk-hunt.ts`). `extra:hunt-trip-auto` has the snare stock and passes with `HUNT trip snare` in 29 s.
    Gap: no live run.
32. **Against an opponent that reads our overhead, its next attack is the style our overhead does not show.** The fight
    loop does not attack with a style the opponent's overhead covers. An opponent with two styles then has one left.
    `counterRead` predicts that style for an opponent that has shown two styles, and the overhead changes to it one
    tick before the attack. The champion with it has 33 kills and 3 deaths in 36 spars against the champion without it
    (10 to 2, 12 to 0, 11 to 1; `extra:spar-mirror-snare-x12`, seeds 1 to 3, `SPAR_SWAP=1`), where the control has
    13 and 11 in 24. Against the melee build, the hybrid and the ranger it has 23 kills and 1 death in 24 spars
    (`extra:spar-rivals-tribrid-snare-x12`, seeds 1 and 2), where the champion without it has 55 and 17 in 72;
    against the league, 16 and 0. The champion profile and the hunter use it. Gap: every bench opponent reads the
    overhead; against one that ignores it and picks at random the rule guards half of its attacks.
33. **The attack learns in the fight which way the opponent's overhead goes.** Our own attack had the hole of finding 32:
    it never used a style the opponent's overhead covered, so an opponent with `counterRead` met most of it.
    `adaptStyles` keeps, for two ways to choose a style, the share of attacks that met the right overhead in the
    tick after the attack: `avoid` (a style the overhead does not show) and `into` (the style it shows, which an
    opponent that predicts is about to leave). The next attack takes the way with the lower share, and one attack in
    ten tries the other (`StyleArms` in `scripts/pk-read.ts`). The champion with it has 34 kills and 2 deaths in 36
    spars against the champion without it (11 to 1, 11 to 1, 12 to 0; `extra:spar-mirror-snare-x12`, seeds 1 to 3).
    Against an opponent whose overhead follows the weapon it has 12 kills and no death in 12, where the champion
    without it has 10 and 2. Against the melee build, the hybrid and the ranger it has 22 kills and 2 deaths in 24
    (23 and 1 without it); against the league 7 and 1 in 8 (16 and 0 in 16 without it); against itself 7 and 5. The
    champion profile and the hunter use it. A fixed rule lost: the style the overhead shows after 4 of 6 guarded
    attacks had 16 kills and 8 deaths against a counter-reader and 7 and 5 against the champion without `counterRead`, which
    `counterRead` alone beat 33 to 3. Other rules against the champion, 12 spars each: the bow alone 2 to 10; the
    bow alone from 3 tiles 4 to 8; the special from 30% health 7 to 5; the special as soon as it is ready 5 to 7.
    Gap: the one attack in ten that tries the other way may cost a little against an opponent that never predicts
    (22 to 2 against 23 to 1, and one league loss): not settled.
34. **In a stand-up fight three more sharks beat the freeze runes.** The hybrid kit (bow, dagger, boosts, 21 sharks, no
    runes) has 33 kills and 13 deaths against the snare kit (the same with the runes of Entangle and 18 sharks), both
    on the champion profile (`extra:spar-duel-snare-hybrid-x12`, seeds 1 to 5, kits placed by two pairs at a time).
    Up to Wilderness level 30 a glory works at once and no freeze holds a target, and the hunt spots are at levels 3
    to 7. The hunter with no kit named takes the bow trip at such spots (`BOW_TRIP` in `scripts/pk-hunt.ts`: bow, two
    prayer potions, a glory, three more sharks), the snare trip at deeper spots where the bank holds it, else the
    staff trip. `extra:hunt-trip-auto` passes with `HUNT trip bow` and a kill in 81 ticks. Gap: no live run; no run
    at a spot deeper than level 30.
35. **The learnt style choice costs nothing against the builds that do not predict, and the special at 50% does nothing.**
    The champion with `adaptStyles` has 23 kills and 1 death in 24 spars against the league (seeds 1 to 3) and 33
    kills and 3 deaths in 36 against the melee build, the hybrid and the ranger (seeds 1 to 3); without it the
    champion has 16 and 0 in 16 and 23 and 1 in 24. The special from 50% health against the champion: 8 to 4 and 3
    to 9, 11 kills and 13 deaths in 24 (`extra:spar-mirror-snare-x12`, seeds 1 and 2).
36. **The fighter beats the Defence 99 range tank.** The hybrid kit on the champion profile has 24 kills and no death in
    24 spars against `tank-range` on the same profile, at Wilderness level 34 (`extra:spar-duel-hybrid-tank-range-x12`,
    seeds 1 and 2, kits placed by two pairs at a time).
37. **The champion's reading options do not carry over to the low builds, so the roamer keeps its options.** In kit
    mirrors, the `snap` profile with `counterRead`, `adaptStyles` and `mixStyles` against the `snap` profile, 8 spars
    each with `SPAR_SWAP=1`: `pure-dds-msb` 2 kills and 6 deaths, `pure-tribrid` 2 kills, 3 deaths and 3 draws,
    `zerker` 7 kills and 1 death (`extra:spar-kit-<kit>-x8`, seed 1). A pure's fight ends near tick 240, and the
    learnt style choice has few attacks to learn from. `scripts/pk-roam.ts` keeps `predictPrayer` and `snapPrayer`
    alone. Gap: one seed for each build.
38. **A spar batch in 8 worker processes takes about 5.7 GB.** Free memory fell from 8.7 GB to 3.0 GB during a batch of 12
    pairs: about 1.5 GB for the engine and the bench and 0.55 GB for each worker process. `pk-spar-jobs.ts` sets the
    number of processes from the free memory so that 4 GB stay free (`procsFor`: 8 from 9.9 GB, 5 at 8.7 GB, none
    under 6.1 GB, where the batch waits and then does not run).
39. **Two players on one tile: the engine's reach rule is the entity rule.** A player's melee turn needs
    `reachedEntity` to its target (`inOperableDistance` in the engine's `Player.ts`, `rsmod.reached` with shape -2).
    Gap: whether that rule refuses a target on the attacker's own tile is not measured; no fight option steps under
    a target, and no spar tests line of sight or two against one.
