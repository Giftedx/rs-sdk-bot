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
(`extra:spar-duel-<build>-x8`, seeds 1 and 2). Net is the build's net damage for each 100 ticks. The two mace rows ran
with Heroes' Quest set (`kitVarps`), so the mace goes back on after a bow turn; the other rows need no quest but
Lost City and Dragon Slayer.

| Build | Shop cost | Sharks | Wins of 16 | Net |
|---|---|---|---|---|
| `melee` (dagger, strength amulet, super attack and strength) | 252,755 | 22 | 13 | -8.5 |
| `tribrid-pots` (three boost potions) | 441,315 | 15 | 11 | +13.6 |
| `ranger` (d'hide, magic shortbow, ranging potion) | 241,915 | 23 | 10 | -21.4 |
| `tribrid-mace-pots` | 467,315 | 15 | 6 | -9.1 |
| `tribrid-dlong` (dragon longsword) | 517,355 | 18 | 5 | +6.3 |
| `tribrid-mace` (dragon mace) | 467,355 | 18 | 1 | -19.3 |
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
each pair 3 fights (seeds 1, 2, 3), `extra:spar-builds-1` to `-4`, the repeatable setup, the fight loop with the
event fix of finding 71. No kit of the bracket needs a quest that `kitVarps` did not set (`pure-hally` sets Regicide
and the viking helm builds The Fremennik Trials in their own varps; `dragon` wears a rune kiteshield). Evidence:
`.practice/kits/builds-matrix.log` (`.practice/kits/matrix-from-seeds.ts` from the seed rows, then
`bun scripts/measure/pk-build-rank.ts`). A build of both brackets has 36 fights, the others 21. Net is the net damage
for each 100 ticks.

| Kit | Combat | Fights | Wins | Losses | Draws | Net |
|---|---|---|---|---|---|---|
| `dragon` | 96 | 21 | 18 | 3 | 0 | +75.0 |
| `zerker` | 96 | 21 | 15 | 6 | 0 | +65.0 |
| `pure-pray` | 80 | 36 | 25 | 11 | 0 | +75.8 |
| `range-tank` | 91 | 21 | 14 | 6 | 1 | +59.5 |
| `pure-hally` | 80 | 21 | 12 | 9 | 0 | +41.8 |
| `rune-pure` | 91 | 21 | 12 | 9 | 0 | +29.5 |
| `pure-ranger` | 69 | 36 | 20 | 15 | 1 | -22.1 |
| `pure-dds` | 72 | 21 | 11 | 10 | 0 | +4.3 |
| `pure-dds-msb` | 75 | 36 | 18 | 18 | 0 | -31.3 |
| `pure-tribrid` | 76 | 21 | 7 | 14 | 0 | -24.1 |
| `pure-r2h` | 71 | 21 | 4 | 17 | 0 | -89.0 |
| `mage-tank` | 89 | 21 | 2 | 19 | 0 | -57.1 |
| `pure-mage` | 69 | 21 | 0 | 21 | 0 | -143.2 |

- **Defence 1: Prayer 43 wins.** `pure-pray` won 18 of 21 against the Defence 1 builds and `pure-hally` 12;
  `pure-hally` took 2 of 3 from `pure-pray`. `pure-dds-msb`, the bow and dagger with no prayer, won 3 of 3 against
  `pure-hally` and 1 of 3 against `pure-pray`.
- **A pure against Defence 40 to 60.** `pure-pray` won 7 of 15 against those builds, 9 to 16 combat levels above it:
  3 of 3 against `mage-tank`, 2 of 3 against `rune-pure`, 1 of 3 against `zerker` and `range-tank`, 0 of 3 against
  `dragon`.
- **Defence 40 to 60: no build is clear.** In this run `dragon` won 18 of 21 (2 of 3 against `zerker`, 1 of 3
  against `range-tank`), `zerker` 15, `range-tank` 14, `rune-pure` 12; an earlier loop gave `zerker` 18 and `dragon`
  13, and a run before that both 16. The order inside this bracket swings between runs.
- **A build with one style from range loses.** `pure-mage` won 0 of 21 and `mage-tank` 2 of 21. `pure-ranger` won
  2 of 17 against the two Prayer 43 pures and the rune, zerker, dragon and range-tank builds (both from
  `pure-hally`), and every fight against the other builds.
- **The two-handed sword loses.** `pure-r2h` won 4 of 21. The loop alternates the bow and the 7-tick weapon; a loop
  that keeps the slow weapon for the kill is not measured. The halberd has the same attack time, and its build
  wins 12 of 21 with Prayer 43.
- The simulator and the bench agree on `pure-pray` at the top of the Defence 1 bracket and on the last build of
  each bracket; this run also has the simulator's order `dragon`, `zerker`, `range-tank`, `rune-pure`, which the
  bench runs do not hold from run to run.
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
- **Attack.** The lunge of the dagger each 4 ticks (630 of 667 intervals in the long record), on a target that runs too. On a single-way
  tile the first account to hit holds the target; a second one follows it and tries again each few ticks.
- **Special.** 113 of 725 attacks in a record of 23,000 ticks (`trace-long-1.jsonl`, 48 fights) are specials. The
  first special is the second attack in 24 of 40 fights that have one, and the first attack in 7. A fight often opens
  with attack and special in turns (attack, special, attack, special, attack, special, special, attack) until the
  energy is gone. They use the special on a target under Protect from Melee too.
- **Food.** Goondelf ate once, at 74 HP, for 20 HP (a shark), and its next attack came 3 ticks late. It did not eat at
  82 HP.
- **Protect prayers.** Sugma turned Protect from Missiles on one tick after a hit from a player that held a magic
  shortbow, and off 33 ticks later. Ligma turned Protect from Magic on in the tick before a spell landed on it, and
  off 13 to 17 ticks later. In a hunt of a target that did not hit back, no protect prayer came on.
- **Prayer points.** Ligma prayed at the Chaos Temple altar (2948, 3820) after a hunt, and Goondelf came into the
  Wilderness from the Monastery (3045, 3489) at full Hitpoints.
- **Damage.** In the long record: 227 splats on targets under Protect from Melee, highest 12; 45 on targets with no
  such prayer, highest 22 (a special). With no Strength boost the dagger hits up to 18, and up to 10 under the prayer
  (`pvp_melee.rs2:31-33`); with Ultimate Strength up to 21 and 12, and a special 15% more. So they use a Strength
  prayer. With a super strength too a hit goes up to 25 and 15 under the prayer, and no such splat is in the record.
- **Two or three at once.** On a multi-way tile they hit one target together: a combat 126 player with no armour
  died 18 ticks after the first hit at (3219, 3629), Wilderness level 14, and a combat 96 player at the runite rocks
  in 12 ticks. On a single-way tile one of them fights.
- **Where the time goes.** In 24,150 ticks each account stands on the post for 62% to 67% of the roster frames and is
  out in the Wilderness for the rest; under 2% is outside it. 96% of their steps are run steps: a chase does not end
  on run energy. They left the post 100 times.
- **How fast they come.** From the first roster frame with a target in range to the first attack: 61, 81, 107 and
  133 ticks, for targets 112 to 250 tiles from the post. They come to a target, so the target chooses the tile.
- **The edge.** A combat 126 player at Wilderness level 1 or 2 north of Edgeville, 112 tiles south of the post, drew
  21 fights of up to 320 ticks and left each one alive; it died in 64 ticks at level 52. The Wilderness north of
  Edgeville is single-way from x 3008 to 3135 (`multiway.csv` has no zone of map squares 47_55 and 48_55).
- **Nobody hits back.** The 28 splats on the gang in the record are 1 to 8 damage with no player facing it. What a
  gang account does under a real attack is not in any record but one eat of Goondelf.
- **End of a hunt.** In the long record 3 targets died (two of them on multi-way tiles), 14 fights ended when the
  target left view, and the others when the attacks stopped. A combat 109 player in rune armour under Protect from
  Melee stood 380 ticks of attacks and left. No gang account died or ate; the lowest Hitpoints of one was 76.

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
  `extra:gang-ganker-escape-x4` and `extra:gang-ganker-escape-worn-x4` are the way out with a glory.

### One account against the gang

A meeting is one of ours against the three on the post tile (`scripts/pk-gang.ts`), 4 meetings a run. `ganker-max`
holds 1,677 HP in its three packs. On a single-way tile one gang account fights at a time; the others take over when it
does not attack for 8 ticks (two eats in a row), so the three eat their packs at the same rate and die close together.

The kit `gang-hunter` on the profile `gang-hunter` clears `ganker-max` in 32 of 32 meetings, with no death and no use
of its way out (`extra:gang-ganker-max-gang-hunter-x4`, seeds 1 to 8): 96 kills, 849 to 964 ticks a run, 228 to 417 HP
lost, 2 to 12 of its 21 sharks left, no prayer potion carried. It clears the gang as the feed shows it (`ganker-dds`)
in 12 of 12 meetings with 12 or more sharks left (`extra:gang-ganker-gang-hunter-x4`, seeds 1 to 3). The kit costs
71,928 coins at shop value (`kitCost`): dragon dagger (p) 24,000, amulet of glory 17,625, adamant platebody 12,800,
21 sharks 6,300, mithril helm, legs and shield 6,240, 150 steel arrows 1,800, magic shortbow 1,600, five potions 1,550.

What decided it, each measured against `ganker-max`:

- **A super defence and the armour kept on for a bow shot.** The champion on the snare kit, the hybrid and a hybrid
  with a glory died in 6 of 12 meetings. With the armour kept on (`castArmour: 'keep'`) and no super defence: 5 deaths
  in 8. With both: no death in 8. The gang attacks with stab only, and the platebody is the largest part of the stab
  defence.
- **The account that fights.** A gang account that takes over shows no hit until it lands one, and the game refuses
  each attack on the account that fought before ("I'm already under attack."). Our account turns to the gang account
  that starts an attack animation, and to another one after a refused attack. Runs went from 1,159 and 1,205 ticks
  to 741 through 859.
- **A super antipoison.** The gang's daggers are poisoned. In full adamant our account lost 337 HP a meeting with no
  antipoison (6 of 8 cleared, 2 left by glory) and 257 HP with one (8 of 8).
- **A prayer flick each 2 ticks, with no Protect Item** (`flickEvery: 2`, `protectItem: false`). The drain timer fires
  5 ticks after the prayers came on, and a bow on Rapid gives one cooldown tick each 3 ticks. With a flick each 4
  ticks the account drank 4 or 5 doses of prayer potion a meeting; with a flick each 2 ticks none, with 44 or more
  prayer points left. The two potion slots hold sharks.
- **The worn glory is the way out.** The loop takes it off and rubs it (the game rubs a glory only from the pack), so
  the pack holds no second one: 8 of 8 got away from `ganker-max` with 3 sharks at the start
  (`extra:gang-ganker-escape-worn-x4`).

The cost of the kit against the result on `ganker-max` (meetings cleared; the rest left by the way out, none died):

| Kit | Coins | Cleared | Least sharks left |
| --- | --- | --- | --- |
| Rune armour with dragon med helm and platelegs, rune arrows, 3 prayer potions | 678,060 | 64 of 64 | 2 |
| Rune armour, rune arrows | 347,260 | 8 of 8 | 4 |
| Rune platebody, adamant helm, legs and shield | 161,020 | 8 of 8 | 1 |
| Adamant armour, no antipoison | 108,820 | 6 of 8 | 0 |
| Adamant armour, antipoison, worn glory, 2 prayer potions | 84,465 | 16 of 16 | 2 |
| Adamant platebody, mithril helm, legs and shield, mithril arrows, no prayer potion | 75,565 | 32 of 32 | 3 |
| The same with steel arrows, cape of legends, ranger boots | 72,565 | 32 of 32 | 2 |
| `gang-hunter`: the same with a plain cape and leather boots | 71,928 | 32 of 32 | 2 |
| Mithril armour | 67,965 | 30 of 32 | 0 |
| Teleport runes for the glory (3 pack slots), adamant armour | 69,797 | 7 of 8 | 0 |
| Adamant scimitar for the dragon dagger | 54,125 | 8 of 12 | 0 |

Rejected against `ganker-max`: rune knives with the shield kept on (2 deaths in 8, runs of 1,400 ticks); no boost
potions for three more sharks (11 of 12); a rune scimitar (370 HP lost a meeting against about 300); the freeze with
3 tiles kept (`adapt`, one meeting of 8 not cleared against `ganker-dds`).

### The walk-in: one pack, no step out of the Wilderness

The account drinks its four boosts at the bank, banks them, takes sharks for their slots and walks to the gang
(`SPAR_PRETRIP=1` of `scripts/pk-gang.ts`). No option lets it leave the Wilderness; its way out is a teleport. All
results are against `ganker-max` with the profile `gang-hunter`.

- **The boosts drunk at the bank.** The kit `gang-hunter` at the post: 2 to 12 sharks left of 21 with the potions in
  its pack (32 meetings), 8 to 13 left of 25 after the bank (`extra:gang-ganker-max-gang-hunter-prepot-x2`, seeds 1
  and 2, 4 meetings).
- **Runes for the glory.** Camelot Teleport (5 air runes and 1 law rune, two pack slots, 120 coins) is the way out of
  an account with no glory; one account of 16 in full steel used it and got away. The kit `gang-walker` (57,348 coins:
  the `gang-hunter` armour, an amulet of power, the runes, 23 sharks after the bank) cleared 16 of 16 meetings with no
  death and no use of the way out at the post: 13 sharks eaten a meeting, 3 to 14 left, 823 to 905 ticks
  (`extra:gang-ganker-max-gang-walker-prepot-x2`, seeds 1 to 8). On a single-way tile 26 tiles from the bank it
  cleared 16 of 16 more, with 1 to 13 sharks left (`extra:gang-ganker-max-gang-walker-prepot-near-x2`, seeds 1 to 8).
- **Cheaper armour does not hold.** With the same runes: full mithril (49,748 coins) cleared 23 of 24 and left by
  teleport once; full steel (42,708 coins) cleared 20 of 24 and left by teleport 4 times. No account died.
- **The fight options**, 6 meetings each (seeds 1 to 3), ticks to clear and sharks eaten: the champion's style choice
  883 and 13; bow and dagger in strict turns 859 and 13; the special from the first health bar 847 and 13; a shark at
  40 HP 884 and 13, at 60 HP 852 and 14; strict turns with the early special 829 and 13; those two with the shark at
  40 HP 807 and 12. The profile has the last set. Gap: 6 meetings a set, and a later batch of 16 gave 863 ticks.
- **Strict turns hold against a gang that keeps its prayer.** The profile `ganker-sticky` keeps a protect prayer for
  20 ticks (in the feed a gang account kept one for 13 to 33 ticks; its rule against two styles is in no record).
  Against it, 6 meetings each (`extra:gang-ganker-max-gang-walker-sticky-near-x2`, seeds 1 to 3): strict turns 857
  ticks and 13 sharks, the champion's learnt style choice 942 and 14, the learnt choice with no random pick 898 and
  15. Against `ganker` the learnt choice has 863 ticks and 15 sharks where strict turns have 811 and 13 (4 meetings).
- **Karambwans give no gain.** 19 cooked karambwans for the sharks with `freeFood`: 838 ticks and 16 eaten in 4
  meetings, 4 left at the least.
- **A dead target pulls the attacker.** An attack click that is in hand when the target dies walks our account
  toward the target's respawn point in Lumbridge, out of the Wilderness. The fight loop ends the click with a walk to
  its own tile when the kill message comes, and the meeting sends an account with no gang in view back to its tile.

### The edge: a step south and a bank trip

At Wilderness level 1 north of Edgeville our account walks south over the edge when its food is gone at 60 HP or
less (`escapeWalk`), banks 25 tiles south and comes back (`SPAR_TRIPS`). The gang's food does not come back, and the
bench gang waits at its tile. Against `ganker-max`, with no death in any run:

- The kit `edge-hunter` (57,828 coins) with 8 sharks at the start: 4 of 4 accounts walked out at 53 to 58 HP, banked
  and cleared on the second meeting (`extra:gang-ganker-max-edge-trips-x4`, seed 1).
- Steel armour and an adamant scimitar with no amulet (18,223 coins): 4 of 4 cleared in 2 trips, about 1,340 ticks
  and 27 sharks a clear. Steel armour with the dragon dagger (39,663 coins): 4 of 4, about 1,030 ticks, 22 sharks.
- Gap: 4 meetings a kit. A real gang goes back to its post while its target is out, and it can stand 112 tiles away
  when the target comes back; the bench gang stands at the edge.

### The gang in a long fight

One live meeting of our account (kit `live-walker-iron`, profile `gang-hunter` options) with all three at the post,
read from the world feed: 1 kill (Sugma), no death of ours, 23 of 24 sharks eaten in 1,689 ticks; the owner stopped
it at 42 HP. A 104,570 tick record holds it (`.practice/rival-dds/trace-long-1.jsonl`; rows in `live-fight-3.txt`,
counts from `live-fight.ts`, `lag.ts` and `lowhp.ts` in the same folder of the main checkout).

- **Eats.** Sharks (a gang account went from 72 to 91 HP in one eat). The HP at 30 eats in the fight is 43 to 74, 14
  of them 69 to 74, none over 74: the eat level is 74. Goondelf ate 11 sharks, Ligma 6, Sugma 13 (Sugma's include the
  trip below). The pack of `ganker-dds` (12 sharks) fits.
- **With the food gone.** Goondelf fought on with no shark from 39 HP to 26 HP (24 ticks), then ran south. It was out
  of the Wilderness 89 ticks after its first drop to 40 HP or less, and back on the post 1,430 ticks after it. Sugma
  ran with it at 72 HP and was back on the post alone 295 ticks after it left. Ligma had left 50 ticks before, to
  another target at (3052, 3528).
- **After a death.** Sugma died on the post and was back on it 1,130 ticks later.
- **Prayer.** Each change of our weapon got the protect prayer for it 1 tick later in the feed in 51 of 105 changes,
  2 ticks in 35, 3 in 11, 4 in 6, more in 2.
- **Specials.** 7 of Goondelf's 63 attacks, 17 of Ligma's 249, 17 of Sugma's 124.
- **Poison.** 139 of the 455 damage in the splats on our account was poison. Our antipoison was not drunk: the fight
  loop drinks a potion only in a tick with 3 ticks to the next attack, and bow and dagger turns back to back give
  none.
- **Who hits them.** In the whole record only our account took a gang account to 40 HP or less (166 of the 192
  attacks on them that the feed shows).

The bench copy of this gang: profile `ganker-live` (a shark at 74 HP or less; the prayer wait above, as extra ticks
0 to 3 with the weights 48, 35, 11, 5 on the bench's own wait; with no food a walk south at 30 HP or less) and
`scripts/pk-gang.ts` `SPAR_B_TRIPS` (the bank trip and the return), `SPAR_B_FOLLOW=1` (the others go too),
`SPAR_B_REST` (the wait of the one that ran) and `SPAR_WAIT` (our account waits on the tile). The case is
`extra:gang-live-check-x2` (`-x1`: one group, for a PC with little memory free).

- **Our prayer runs out.** In the live meeting our protect prayer went off for good at about tick 730 of the
  meeting; the last 1,040 ticks had none. The flick each 2 ticks does not stop the drain: it flicks only on a
  cooldown tick before the tick of our attack, and no fight loop flicks while our account waits between two fights.
- **The bench against the live meeting** (`extra:gang-live-check-x1`, profile `gang-hunter`, seeds 1 and 2): seed 2
  gave 1 kill, 22 sharks eaten, the food gone and the teleport out at 54 HP in 2,760 ticks, the prayer gone at tick
  663; seed 1 gave 2 kills and 14 sharks in 1,514 ticks, the prayer gone at tick 891. Live: 1 kill, 23 sharks, the
  prayer gone at about tick 730. In both seeds one gang account walked out at 26 to 29 HP and came back; it was not
  killed. Gap: 2 seeds.

The levers for our side: `cureNow` (an antipoison in the first tick after the poison),
`chaseBelow` (a run after a target that flees with a low health bar), and `specBelow` (keep the special energy for a
low target).

### The cost of a kill

What one kill of a gang account uses, against the live-like gang (profile `ganker-live`, kit `ganker-dds`: the gang
walks out with its food gone and comes back). Our account has profile `gang-hunter` with the options
`{"cureNow":true,"eatAt":60,"freeze":"flee","focusRunner":0.4,"chaseBelow":0.4}`, the snare runes, a dragon dagger,
a magic shortbow, iron arrows and an amulet of power. It drinks its boosts at the Edgeville bank and walks to the post
(`SPAR_PRETRIP=1`). The cases are `extra:gang-live-fast-snare-x2` and `extra:gang-live-cheap-<kit>-x2`; each row is
seeds 1 to 8 (16 meetings), run with `.practice/gang-cheap/set.sh` and summed by `use2.ts` in the same folder (raw
lines in `round1.txt` to `round7.txt`). No account of ours died in any row. Worn gear is bought once and kept, so the
cost of a kill is what it eats, shoots and drinks. Each HP lost is eaten back before the next meeting, so the food of a
kill is its HP lost / 20 sharks.

| Kit (`live-walker-iron-snare-...`) | Gang | Kills | HP lost a kill | Arrows a kill | Entangles a kill | Ticks a kill | Coins a kill |
| --- | --- | --- | --- | --- | --- | --- | --- |
| (base) adamant body and legs, 3 boosts, antipoison | 3 | 17 | 142 | 50 | 2.5 | 582 | 2,900 |
| `nopot`: no boost | 3 | 16 | 146 | 44 | 1.8 | 592 | 2,700 |
| `noanti`: no antipoison | 3 | 8 | 188 | - | - | 556 | - |
| `bare`: neither | 3 | 8 | 197 | - | - | 589 | - |
| `addy`: adamant arrows | 3 | 16 | 102 | 37 | 1.5 | 520 | 4,800 |
| `rune`: rune arrows | 3 | 20 | 122 | - | - | - | - |
| `snarep`: dagger (p), super antipoison | 3 | 16 | 110 | - | - | - | - |
| `helm-nopot`: adamant helm too | 3 | 15 | 136 | - | - | - | - |
| `runeshop-nopot`: adamant helm, rune body and legs | 3 | 15 | 114 | 45 | 1.4 | 590 | 2,000 |
| `runeshop-cape-nopot`: the same, cape of legends | 3 | 16 | 104 | 42 | 1.6 | 576 | 2,000 |
| `rune-nopot`: rune helm, body and legs | 3 | 15 | 97 | 40 | 1.7 | 577 | 1,900 |
| `rune-nopot` (`-duo` case) | 2 | 16 | 89 | 38 | 1.6 | 491 | 1,700 |
| `rune-nopot` (`-solo` case) | 1 | 15 | 75 | 29 | 1.6 | 260 | 1,500 |

Coins are shop values (`knowledge/items.json`): a shark 300, an iron arrow 3, an adamant arrow 80, an Entangle 120
(5 earth, 5 water, 4 nature runes), a dose of antipoison 96 and of the three boosts 213 together, one of each a
meeting. A dash is not counted (4 seeds, or a log that a later run replaced). Gap: 15 to 20 kills a row; the base
lost 115 HP a kill on seeds 1 to 4 and 171 on seeds 5 to 8, so a difference under about 15 HP is noise.

- **Rune armour is the largest cut.** Full rune loses 97 HP a kill where adamant body and legs lose 142 to 146: about
  2 sharks less a kill. NPC shops sell the rune platebody (Oziach, `runeplateshop`, Dragon Slayer) and platelegs
  (`runiteshop`), but no rune full helm (smithing only: `smithing_rune4`); the adamant helm is `helmetshop`.
- **The antipoison pays; the boosts do not.** Without an antipoison our account loses about 45 HP more a kill (8
  meetings a row). The boosts save nothing over 16 meetings (146 HP a kill without, 142 with), and they are the one
  supply that no shop sells (super attack, strength and defence are herblore only); the regular antipoison is sold
  by `junglestore`.
- **Better arrows cost more than they save.** Adamant arrows save about 40 HP (2 sharks, 600 coins) a kill and cost
  about 3,000 coins more in arrows. Four arrows in five land on the tile of the player hit (`pvp_ranged.rs2`
  `ranged_dropammo_pvp`, `^dropammo_chance` 5) and a drop lasts 200 ticks (`lootdrop.constant`), less than a meeting.
- **One or two of the gang at a time.** With one gang account a kill takes 260 ticks and 75 HP; with three, 577 ticks
  and 97 HP. A gang account that is frozen hands the fight to the next one (the 8-tick takeover), so a freeze and a
  step away (`"freeze":true,"kiteFrozen":3` or `6`) ends the meeting in 70 to 290 ticks with our account away and
  1 kill in 16 (`round2.txt`).
- **Three of ours against the three.** On the single-way post an account fights one enemy at a time, so three of
  ours, each against its own gang account (`scripts/pk-team.ts` `SPAR_A_PICK=pair`, `SPAR_B_PICK=pair`), make three
  solo meetings at once (`extra:team-3v3-gang-rune-x2`, profile `ganker-live`, seeds 1 to 8,
  run with `.practice/gang-cheap/teamset.sh`): 16 of 16 groups won, 39 of the 48 gang accounts killed (the rest walked out),
  no death of ours, 80 HP lost a kill, about 260 ticks a meeting. Without the freeze 37 kills and 93 HP a kill; in
  the adamant kit (`live-walker-iron-snare-nopot`) 42 kills and 103 HP a kill. Two of ours against the three
  (`extra:team-2v3-gang-rune-x2`, `SPAR_TEAM_B=3`): 16 of 16 groups won, 36 kills of 48, no death, 91 HP a kill; the
  third gang account takes over a pair when its gang account dies or walks out. Each account taking the lowest health
  bar in view (`-low`, seeds 1 to 4) won 7 of 8 groups, 15 kills of 24, 114 HP a kill. The team loop stops a fight on
  a refused attack ("I'm already under attack.") and leaves that enemy out for 8 ticks; before that, two of ours
  against three stood still in 6 runs of 16 until the bench stopped them.
- **Bind does the freeze's work.** In the three-against-three case (seeds 1 to 8) the freeze capped at Snare
  (`"freezeMagicCap":78`) gave 39 kills and 81 HP a kill, at Bind (`49`) 38 and 78, against Entangle's 39 and 80 and
  no freeze's 37 and 93. A Bind (3 earth, 3 water, 2 nature runes) costs 64 coins where an Entangle costs 120, and it
  needs Magic 20.
- **Multi-way is cheaper still.** The same three against the three on a multi-way tile, each side on the lowest bar
  (Bind for the freeze, seeds 1 to 8): at the team cases' (3150, 3560) 16 of 16 groups won, 45 kills of 48, no death,
  54 HP a kill (`extra:team-3v3-gang-rune-multi-x2`); in the multi-way zone 12 tiles west of the post (x 3064 to
  3071, z 3624 to 3663, Wilderness 14 to 18, `maps/multiway.csv`) 13 won and 3 drawn, 41 kills, no death, 65 HP a kill
  (`extra:team-3v3-gang-rune-west-x2`). Three of ours hit one gang account at once and kill it before it eats. Two of
  ours against three there leave at once (`escapeOutnumbered`), with no kill and no death
  (`extra:team-2v3-gang-rune-west-x2`). Four of ours against the three there: 15 of 16 groups won, 47 kills of 48,
  no death, 35 HP a kill, under 2 sharks (`extra:team-4v3-gang-rune-west-x2`); four in the adamant kit 48 kills and
  53 HP a kill (`-addy-`), and four in adamant with no antipoison and no freeze 48 kills and 76 HP a kill (`-bare-`).
  More of ours cut both the HP and the time of a kill (rune kit, Bind, seeds 1 to 8; the 6 and 9 cases hold one group
  an engine): five 48 kills of 48 and 24 HP a kill, 168 ticks a meeting (`extra:team-5v3-gang-rune-west-x2`); six 24
  of 24, 22 HP, 116 ticks (`-6v3-...-x1`); nine 24 of 24, 14 HP, 59 ticks (`-9v3-...-x1`); against four's 35 HP and
  218 ticks. Account-ticks a kill fall from 290 with four to 177 with nine. No death of ours in any of them. Four on
  the least build the post allows (combat 111: Attack 75, Prayer 43, Magic 49, kit
  `live-walker-iron-snare-rune-nopot-b111`): 35 kills of 48, 68 HP a kill, 541 ticks a meeting.
  Three in the adamant kit: 41 kills, 75
  HP a kill (`extra:team-3v3-gang-addy-west-x2`). Gap: the bench gang follows its target into multi-way; no record
  shows whether the live gang does.
- **The loot.** The live gang skulls. A skulled account keeps no item at death, or its dearest one with Protect Item
  (`death.rs2` `pvp_death_lose_items`); one with no skull keeps its 3 dearest, which is why a bench gang account
  (`ganker-dds`) drops its hat and bones only. With the kit `ganker-dds-skull` (varp 78, `%pk_skull`, put back on at
  login) and `SPAR_B_OPTS={"protectItem":false}`, our account with `SPAR_PICKUP=1` took the dragon dagger(p) after 8
  of 8 kills (`extra:gang-live-cheap-rune-nopot-solo-skull-x2`, seeds 1 to 4): 24,000 coins at shop value, about 16
  times the supplies of the kill, and the weapon of a PK account. Four of ours in the multi-way zone
  (`extra:team-4v3-gang-skull-west-x2`, `scripts/pk-team.ts` `SPAR_PICKUP=1`, seeds 1 to 8) killed 44 of 48 with no
  death, 36 HP a kill, and took 40 daggers and 49 sharks. The pickup takes the dearest item first and eats a shark to
  free a slot (the rune kit fills 27 of the 28): taking the nearest first, a shark filled the pack and the dagger
  stayed (31 of 48). It runs on after the last kill, which ends the meeting, and after any death of the account's
  target, since the loop can stop on the death before the kill message comes. A gang with Protect Item keeps the dagger and drops a
  hat, two robes (72 coins) and what food it has left. Whether the gang uses Protect Item does not show (no head icon).

- **The squad script.** `scripts/pk-squad.ts` (`aio-pvp.ts squad`) runs the method on live accounts: the accounts
  walk to the multi-way post (3067, 3640), every one fights the target account in view with the lowest health bar,
  takes the dearest drops after each kill, and banks at Edgeville and walks back when its fight loop leaves; it stops
  on `.practice/stop-pk-squad`, `MAX_MINUTES` or `MAX_KILLS`, refuses the main account and a post that is not
  multi-way, and runs live only with `DEMO_OK=1` (openBot). Its default options turn off the champion's
  `dropForStrip`, which dropped a shark before each account's first freeze. Against the bench gang (`SQUAD_GANG=3`,
  seeds 1 to 4): four of ours killed all three in each run with no death, about 33 HP a kill
  (`extra:squad-4-gang-x1`); six, all three, about 23 HP a kill (`extra:squad-6-gang-x1`); four against the skulled
  gang with no Protect Item, 12 of 12 and 11 dragon daggers(p) (`extra:squad-4-gang-skull-x1`); four on the gang's
  own single-way post (`POST=3075,3640 ALLOW_SINGLE=1`, for a gang that does not follow into multi-way), 11 of 12, no
  death, about 37 HP a kill (`extra:squad-4-gang-single-x1`). Two of ours with 3 sharks each, outnumbered, made 4
  bank trips in 8 minutes with no fault and no death (`extra:squad-2-gang-trips-x1`).
- **The first live pilot** (four of ours, combat 126, rune chainbody, no antipoison, few water runes, 10 minutes):
  4 gang deaths in the world feed, matching the 4 kill messages, no death of ours, 995 HP lost, about 249 a kill.
  The gang met the squad on the walk in, at about (3072, 3610), one tile east of the multi-way area (x 3040-3071,
  z 3600 and north). On single-way tiles each gang account took one of ours, so the kills were long one-on-one fights.
  The same kit on the bench (`live-walker-iron-rune-chain-bare`, seeds 1 to 4): four on the lowest bar in multi-way,
  20 kills of 24 at 36 HP a kill (`extra:team-4v3-gang-chainbare-west-x2`); four on single-way tiles, each gang
  account on one of ours (`SPAR_*_PICK=pair`), 5 kills of 24 at 454 HP a kill (`-chainbare-split-`). Where the fight
  happens costs more than the kit.
- **Marching and pulling.** The squad moves as a march: its post steps `STEP` (default 12) tiles at a time toward the
  goal, and on only when every account stands within 4 tiles of the step or after 60 ticks there. A march to a
  multi-way goal goes first to the nearest multi-way tile (`multiEntry`). An account on a single-way tile with a
  target in view, while the goal is multi-way and within 40 tiles, walks on into multi-way and eats instead of
  fighting (`PULL`), for at most 20 ticks at a stretch. A squad account takes only a target the game lets it attack
  (`attackable`); one that walked out of the Wilderness held three of ours at its edge. With `SQUAD_GANG_HUNT=1` the
  bench gang walks to the nearest of ours, as the live gang did. Seeds 1 to 8, no death in any:
  - the walk-in from the Edgeville bank against the hunting gang: 24 of 24 at about 34 HP a kill
    (`extra:squad-4-gang-hunted-x1`); with `MARCH=0 PULL=0`, 23 of 24 at about 31. The bench gang did not split
    the squad on the way, so the bench shows no gain from the march and the pull; the live split is their reason.
  - the same walk-in in the pilot's kit against `ganker-max` (23 sharks, boosts, prayer potions), each gang account
    hunting its own one of ours (`SQUAD_GANG_SPLIT=1`, `extra:squad-4-gangmax-hunted-chain-x1`), seeds 1 to 8:
    march and pull 19 kills at about 80 HP a kill, neither 20 at 78, pull only 22 at 72, march only 15 kills in 5
    runs at 65. The four sit within the noise; this copy of the gang costs 65 to 80 HP a kill where the live split
    cost about 249.
  - `FOLLOW=1` from (3150, 3560), 110 tiles away, past the gang's single-way post: 19 of 24 at about 60 HP a kill
    (`extra:squad-4-gang-follow-x1`; seeds 1 to 4: 38, seeds 5 to 8: 84). Seeds 1 to 4 only: straight in, 81;
    gathered once 10 tiles short, 48.
- **Following the gang.** The gang roams (the first live pilot's feed showed it 250 tiles from its post). `FOLLOW=1`
  marches the squad, once no target has been in view for 30 ticks, to the nearest multi-way tile within 24 tiles of
  the targets that the world feed shows, at Wilderness level `MAX_WILD` or less (`meetTile`, the feed through
  scripts/pk-roam.ts `Radar`). On the bench, which serves no world feed, the bench gang's own tiles fill the radar.
- **The freeze matters most to a small squad.** Three of ours in rune chainbody (the kit of the first live pilot)
  in the multi-way zone, seeds 1 to 8: with no freeze runes 25 kills of 48 and 7 of 16 groups, 74 HP a kill
  (`extra:team-3v3-gang-chain-west-x2`); with Bind runes 44 kills and 14 groups, 64 HP a kill
  (`-chainbind-`); four with no freeze runes 37 kills and 11 groups, 35 HP a kill (`extra:team-4v3-gang-chain-west-x2`).
  No death in any. A gang account that walks out at low HP gets away unless a freeze holds it or more of ours hit it.

The cheapest method measured: full rune (or the shop set with the cape of legends), iron arrows, Bind runes, a
regular antipoison and no boost, against one or two gang accounts when the world feed shows the others away, or three such accounts against the three
at once, each against its own, or best, four such accounts on the multi-way tiles west of the post (35 HP a kill,
about 700 coins of supplies), where the bench gang follows. Every
consumable has a source with no Grand Exchange: sharks by fishing and cooking, iron arrows from the archery shops
(`archeryshop` 1,500, `archeryshop2` 800), earth and water runes from the rune shops (`runeshop` 2,000), nature runes
from `magearena_runeshop` and `magicguildshop`, the antipoison from `junglestore` (10). The gear: the dragon dagger
from `dragonswordshop` (Lost City), the rune body and legs as above, the magic shortbow by fletching (no shop), the
amulet of power by crafting and Enchant (the `amuletshop` holds none).

### Options against the gang

Each lever of a meeting, with what is measured. A lever with no result is a test to run on `ganker-max`.

- **The tile.** The gang comes to its target, so our account picks the ground.
  - Single-way or multi-way: single-way only. Measured on the post tile and on one tile at the edge.
  - The edge of the Wilderness north of Edgeville (level 1 to 3, single-way, bank 25 tiles south at (3092, 3496)): one
    step south ends every attack, and the bank gives food that the gang does not get back. Measured above.
  - A tile that a melee attacker cannot stand beside (all four side tiles blocked, a clear line for the bow): not
    searched in the map. One such tile makes the gang harmless.
  - The lines at level 20 (teleport spells) and 30 (glory): the post is under both.
- **The time.** One or two of the three are away at times (the Chaos Temple altar, the Monastery, the tile at
  (2934, 3516)), and the world feed shows where each one is. A meeting with one or two of them is `SPAR_GANG=1` or
  `2` of `scripts/pk-gang.ts`. Measured in "The cost of a kill": with one, a kill takes 260 ticks and 75 HP; with three,
  577 ticks and 97 HP.
- **Before the meeting.** The four boost potions drunk at the bank leave four pack slots for sharks. The server drops
  a boost at logout (`PlayerLoading.ts:99`), so a bench start state cannot hold one: the bench account goes to the
  bank first. Measured above.
- **Movement.** Their steps are run steps, so no kite wins on run energy. A step under the attacker (finding 39) and
  a step out of the Wilderness and back between two shots are not measured. The freeze with distance kept (`adapt`)
  is rejected above.
- **Which account to fight.** Measured: the one that starts an attack animation.
- **Armour and weapons.** Measured in the cost table above.
- **Supplies.** Measured: super defence, super antipoison, the three boosts, no prayer potion, sharks. A pineapple
  pizza heals 20 a slot in two bites, as a shark does in one (`consume_normal.dbrow`).
- **Prayer.** Measured: Protect from Melee, the Defence prayer, the melee prayers on melee turns, the flick each 2
  ticks, no Protect Item. Smite in place of Protect from Melee is not measured: it gives up the 40% cut.
- **The way out.** Measured: the worn glory, a glory in the pack, Camelot Teleport (2 pack slots) and the walk over
  the edge. Varrock Teleport takes 3 pack slots.
- **A second account.** On a single-way tile an account that hits ours each 8 ticks keeps every other attacker off
  it, and ours then cannot attack either (`pvp_combat.rs2:104-131`). It protects and does not kill. Not measured.

Gaps:

- The pack of a gang account is not visible: the number of sharks, and whether it holds potions. `ganker-dds` has an
  estimate; `ganker-max` is the upper limit.
- Prayers with no head icon (Protect Item, the Strength, Attack and Defence prayers) are not visible. The bench
  accounts use all of them.
- The eat level is 74 HP from 30 eats in one live meeting ("The gang in a long fight").
- One live meeting shows a gang account under a dagger, at low Hitpoints and after its death ("The gang in a long
  fight"): it prays against melee, it runs with its food gone, and it is back on the post 1,130 to 1,430 ticks
  later. One meeting is one sample of each.
- The bench's own prayer wait is not measured against the feed's: the weights of `ganker-live` take the bench wait as
  1 tick.
- The post is a single-way tile. A meeting on a multi-way tile, where the three hit at once, is not measured: our
  account must meet the gang on single-way tiles only.
- `ganker-max` has no antipoison and casts no spell (Magic 37 allows Bind). A gang that cures our poison lives longer.

## Server rules the loop follows

- Protect prayers cut a player's max hit by 40%, not 100% (`pvp_melee.rs2:32`, `pvp_ranged.rs2:38`, `pvp_magic.rs2:182`).
- Run energy does not drain on the practice bench: the engine's `NODE_INFINITE_RUN` defaults to true
  (`server/engine/src/util/Environment.ts:47`), and a runner chase reads `run=100` on each of its ticks (`PK_TRACE=1`).
  Every chase result here assumes that; a server with the flag off would slow a long chase to a walk.
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
40. **A dagger user that never gives up cannot be kept out of reach by freezes alone.** `kiteMelee` (freezes and
    steps only: a freeze within 10 tiles with a line of sight, the account still until the hold shows, a run away
    while the target is free or immune) takes 41 to 162 damage a meeting of 650 to 1,500 ticks; the champion kills
    the same attacker in about 150 ticks for 20 to 107. Conditions: `extra:kite-chase-x4` (the gang meeting with a gang
    of 1, `ganker` profile, so the attacker walks back to our tile each time it loses sight), seed 1, the lockstep
    engine. The leak is the freeze hit rate: of the freezes cast, 22% hold in rune armour (`castArmour: 'keep'`), 40%
    with the cast armour stripped and 46% in the mage kit (`extra:kite-chase-mage-x4`). The magic roll is
    (Magic + 9) x (bonus + 64) against (0.7 Magic + 0.3 Defence + 8) x (bonus + 64), with no magic prayer
    (`player_combat_stat.rs2`), so plate leaves the roll near 0. Each miss costs the 5-tick spell delay and a tick
    stood still, and an attacker beside us at equal speed is not shaken by a run. Four faults that kept freezes from
    going out are fixed in `scripts/pk.ts`: a walk click in the ticks after the cast clears the spell while the server
    re-queues it for our attack delay (`pvp_magic.rs2` `pvp_combat_spell_checks`); the chase walked back to the
    target; an eat or a potion click (`OpHeld`) cleared the spell; and a cast with no line of sight
    (`GameMap.ts` `isApproached`) walks the account toward the target. Evidence: `.practice/climb/kite-*.log`, engine
    traces `.practice/climb/ktrace*/`. Gap: seed 1 only; the hold rate varies from run to run (12% to 40% in rune);
    no kit with a magic bonus and melee defence was tried.
41. **A spar batch with many accounts does not repeat exactly on one seed.** `extra:spar-rivals-tribrid-snare-x12`
    (24 accounts in one process), seed 1, the same options: 9 kills and 3 deaths, then 10 and 2, run alone; 11 and 1,
    then 10 and 2 with the lockstep client of `master`. The fight loop's own choices are seeded (`mixSeed`); the lite
    client ages animations on its 20 ms loop, not on game ticks (`patches/rs-sdk.md` item 10), and the attack and prayer
    reads use those animations. The 4-account gang case (`extra:gang-live-fast-x1`) repeated exactly in two runs.
    Consequence: a comparison of spar batches needs 8 seeds or more, or the paired statistics of
    `scripts/measure/pk-spar-climb.ts`; a gap of 3 or 4 kills in 32 fights is within the noise. Causes found with
    the engine traces (`BENCH_TRACE`, two runs of seed 1 aligned on the last login): npcs wander and draw random
    numbers through the login phase, whose length in ticks follows the machine (81 and 85 ticks); a session answers a
    tick before its script acts when any other session of the process waits; a fight starts 11 to 14 ticks after the
    last login; the prayer guard of each account flicks on a 3-tick cycle counted from its own login; and the
    client's wall clock ages animations. The repeatable setup takes these out: `SPAR_NPC_NEAR=1` (the bench
    engine's `SIM_NPC_NEAR`), `SPAR_SERIAL_LOGIN=1` (one login after another, and every fight starts when the last
    account in has seen `SPAR_START_TICK` ticks), `PRAYER_GUARD=0` and `EAT_GUARD=0` (the fight loop does both), and
    the tick clock of `packages/core/src/inprocess.ts` and the engine's timer restart at the anchor login
    (`patches/rs-sdk.md` item 10: a player's hitpoint regen and other timers ran from its own login tick, and
    `PK_TRACE=1` showed 83 and 84 HP at fight tick 71 with the same hits). Two runs of seed 1 then give the same
    fight trace line for line (12,157 lines, `PK_TRACE=1`); four seeds at once, run twice, give the same kills and
    deaths and differ in two fights' scores of 48 (`.practice/climb/set-det2-*`). The route cases (hunt, roam, army:
    `pvp-with-targets.ts` with the route in a second process) repeat too once the fight loop seeds its random
    choices from `BENCH_SEED` and the account's role when it has no `mixSeed` (it used `Math.random`), the bench
    engine's `SIM_NPC_NEAR` is 1, and the count-dialog wait holds the tick from the dialog's opening to its submit:
    two runs of `extra:hunt-defend` with seed 1 differ in 4 of 3,852 engine inputs, at the end. Gap: under the load
    of parallel seeds a little remains.
42. **Freezes need their own armour rule, and the champion freezes once from half health.** With `castArmour: 'keep'`
    the freeze kept plate on too, and the champion killed 0 of 64 runners (`extra:spar-escape-tribrid-snare-x8`, seeds
    1-8, runner on `base`). `freezeArmour` (default `'torso'`) now rules a freeze. Against the runner, seeds 1-4: freeze
    from 70% health with the armour off and at most 2 early freezes, 14 of 32 (12 of 32 on seeds 5-8); the same
    without the cap, 11 and 7. The champion's rule (freeze from 50% health, at most 1 early freeze, armour off)
    gives 7 of 32 against the runner and, seeds 1-8 against the three rival builds
    (`extra:spar-rivals-tribrid-snare-x12`), 94 kills and 1 death in 96 fights against 87 and 5 without it; mirror
    neutral (mean +3.1, t 0.67). The gang set (snare kit, freeze flee, `focusRunner` 0.4) kills 15 of 16 over seeds
    1-8 with the torso rule, 12 of 16 before. Gap: finding 41's noise; the rival comparison is one run per seed.
43. **A mirror winner can lose to every real opponent.** The mirror climb on the champion of finding 42 accepted
    `standOff: 5` (mean +22.7, t 2.86, 16 samples, `extra:spar-x8`). Seeds 1-8 against the three rival builds it gave
    12 kills and 39 deaths in 60 fights where the champion had 85 and 8 in 96, and against the runner 12 of 64 where
    the champion had 26. The champion keeps no stand-off. Rule: a patch joins the champion only after the mirror and
    the rival and runner cases (`.practice/climb/dual.sh`, 8 seeds) agree. Gap: one seed of the rival batch at
    stand-off 5 gave no result (12 fights in the first half).
44. **A hold on a runner shows two ticks after the cast, and reading it one tick early halves the catches.** The
    server casts in the tick after our click, and a runner can step once more before the freeze stops it
    (`pvp_magic.rs2` `pvp_freeze_effect`: `p_walk` to its own tile and a 0-delay queue). The loop read a hold from the
    target's tile at the cast, so a hold that landed read as a splash and the next turn went on a held target. With the
    tile taken two ticks after the cast: 36 of 128 runners (`extra:spar-escape-tribrid-snare-x8`, seeds 1-16, runner
    on `base`, `SPAR_CAP=900`) against 25, and 178 kills and 12 deaths in 192 rival fights
    (`extra:spar-rivals-tribrid-snare-x12`) against 175 and 15. Of the freezes cast at a fled runner, about 45% hold.
    A hold at level 30 or lower converts nothing (0 of 14, seeds 13-16): the runner rubs its glory while frozen;
    above level 30, 4 of 14. The champion's 4 dragon dagger specials all go out near 53% health, before the runner
    breaks, so a hold above 30 meets bow shots only. `freezeStill` (a freeze only within 10 tiles with a line of
    sight, from a stand, no walk or item click until the hold shows) gives 13 of 128 runners and 179 and 13 against
    the rivals: a cast past 10 tiles makes the server walk the account in and cast on arrival, a chase that costs no
    click. Special energy kept for the runner costs the fights that need it: no special above 30% health unless the
    target fled gives 43 of 128 runners and 168 kills, 23 deaths against the rivals; above 0%, 44 and 156, 32.
    `specReserve` 250 gives 38 and 168, 21; `specReserve` 500 gives 83 of 248 runners (seeds 1-32) against 73 of 256,
    178 and 13 against the rivals, and in the mirror (`extra:spar-x8`, `SPAR_B=champion`, seeds 1-16) 40 kills and
    68 deaths in 128 fights where the champion has 49 and 67, so it stays out of the champion (finding 43 rule).
    Evidence: `.practice/climb/still2.out`, `save.out`, `reserve.out`, `reserve2.out`, `mirror-res.out`,
    `.practice/climb/fix-logs/`, `.practice/climb/held-escape.ts`. Gap: finding 41's noise; one run per seed.
45. **A Saradomin cape in the snare kit catches more runners at no cost elsewhere.** The snare kit freezes with the
    glory's +10 magic attack alone once its plate is off; the Saradomin cape (Mage Arena) adds +10 magic attack and
    +10 magic defence for the Legends cape's +7 to each defence. `tribrid-snare-sara` against the runner
    (`extra:spar-escape-tribrid-snare-sara-x8`, champion against `base`, `SPAR_CAP=900`, seeds 1-8, the repeatable
    setup of finding 41): 26 of 64 where `tribrid-snare` has 19; against the rival builds 92 kills, 4 deaths in 96
    where `tribrid-snare` has 93 and 3; head to head (`extra:spar-head-snare-sara-x12`, both champion, sides swapped
    every two pairs) 46 wins and 50 losses in 96. The same kit with a mystic fire staff in hand for each freeze
    (`freezeWithStaff`, one shark less) gives 22 of 64 runners and 88 kills, 8 deaths against the rivals. The game
    has no mystic robes; the wearables with magic attack of 5 or more are the staves, the glory, the amulet of magic
    and the god capes (+10 each), the splitbark body (+9), the Zamorak book (+8) and the splitbark legs (+6).
    Poisoned dagger(p) carries 255 in every bonus but is a staff item (`appearance.rs2` checks `staffmodlevel >= 3`)
    with no drop or shop. Evidence: `.practice/climb/kit-esc.out`, `kit-riv.out`, `set-head-sara-*`. Gap: one run
    per seed; the god cape needs the Mage Arena (Magic 60, Kolodion), a supply step outside this test.
46. **Three maxed tribrids kill one maxed tribrid in multi-way combat at no loss; in single-way combat they lose
    accounts and take three times as long.** `extra:army-tribrid-x4` (four groups of three `tribrid-snare` against
    one `tribrid-snare` on the champion, `GANKER_POST`, Wilderness level 16, single-way) and
    `extra:army-tribrid-multi-x4` (the same at 3150,3560, level 6, multi-way), seeds 1-4, the repeatable setup.
    Single-way: on the `ganker` profile the army kills 13 of 16 and loses 8 accounts, the batch ends at the 900-tick
    cap; on the champion it kills 16 and loses 7 in 515 to 836 ticks. Multi-way: 16 kills and no losses on both
    profiles, the batch over in 252 to 370 ticks on `ganker` and 188 to 252 on the champion. In single-way combat
    one attacker at a time can hit (`pvp_combat.rs2:103-133`), and the target eats all 18 sharks in every meeting
    (about 450 damage taken). The champion's three accounts read the same health bar, so their specials go out on
    the same tick. Evidence: `.practice/climb/set-army-*`, `set-armym-*`. Gap: the batch tick is the slowest group;
    one run per seed; no army option of its own (a style for each member, a special stack held for a knock-out).
47. **A dragon spear stunner does not speed the army's kill; waiting to stack the specials does a little.** In the
    multi-way army case the target eats 17.1 of its sharks on average before it dies (16 meetings, seeds 1-4, the
    repeatable setup, army on the champion). With the army's specials from 35% target health (`specBelow: 0.35`)
    it eats 14.9, from 45% 15.9; seeds 5-8 repeat it (15.4 and 13.9). The `army` profile of `scripts/pk-spar.ts` is
    the champion with `specBelow: 0.35`. With one army account on `tribrid-snare-spear` (`extra:army-spear-multi-x4`,
    `SPAR_KITS` naming a kit for each account) the target eats 19.1 when the spear's special goes out at once and
    18.2 when it goes out from 55% health: the special holds the target 5 ticks with no input
    (`pvp_dragon_spear.rs2` `p_delay(4)`), and the spear account gives up the dagger's specials and hits every 6
    ticks. No meeting lost an army account. Evidence: `.practice/climb/set-army-*`. Against a target that leaves,
    three or four spears of five accounts are what kill (finding 67). Gap: one run per seed.
48. **A lone account in multi-way combat survives three maxed attackers only by leaving at once.** On the champion
    our account dies in all 16 army meetings (`extra:army-tribrid-multi-x4`, army on `army`, seeds 1-4). With
    `escapeOutnumbered: 2` (in multi-way combat, hits from two players within 8 ticks start the escape whatever the
    food: the worn glory comes off and is rubbed at level 6) it escapes in all 16, 22 to 60 ticks into the meeting.
    Without the multi-way test the option throws fights away: against the dagger gang in single-way combat
    (`extra:gang-ganker-x4`) the champion clears 16 of 16 groups (48 kills), and with the option escapes from them
    (1 kill at threshold 2, 19 at threshold 3); with the test it clears 16 of 16 again. In single-way combat one
    player at a time can hit (`pvp_combat.rs2:103-133`). The champion takes `escapeOutnumbered: 2`; of the bench
    spots only the army spot (3150,3560) is multi-way (`scripts/pk.ts` `isMulti`, `maps/multiway.csv`). The escape
    counts the allies in view (finding 49), so the `army` profile keeps it. Evidence: `.practice/climb/set-esc-out*`, `set-gk-out*`. Gap: no case of two of ours
    against two, where a hit from both enemies sends an account away from its ally.
49. **Two against two in multi-way combat: leaving once outnumbered halves the deaths for fewer kills.**
    `extra:team-2v2-multi-x4` (`scripts/pk-team.ts`: four groups of two `tribrid-snare` against two at 3150,3560,
    each account on the lowest health bar in view), side B on the champion, seeds 1-8, 64 accounts a side, the
    repeatable setup. Side A on the champion: 17 wins, 15 losses, 15 of its accounts dead and 19 of side B's. Side A
    with `escapeOutnumbered: null`: 16 wins, 14 losses, 2 draws, 35 dead and 31 of side B's. The champion's escape
    counts its allies (`allies`: each own account within 10 tiles takes one attacker off the count), so an account
    stays while its ally stands with it and leaves once the ally is down and two enemies hit it. Evidence:
    `.practice/climb/set-team-*`. Side A on `army` (specials from 35% target health): 12 wins, 20 losses, 24 dead
    and 15 of side B's, so the held specials pay only when the army outnumbers its target (finding 47). Three
    against three (`extra:team-3v3-multi-x3`, three groups, seeds 1-8, 72 accounts a side): with the escape 11 wins,
    7 losses, 6 draws, 22 dead and 24 of side B's; with it off 11, 9, 4, 33 dead and 30. Focus fire pays: on the
    repeatable runs two against two, side A taking the lowest health bar in view wins 20, loses 10, with 16 dead and
    26 of side B's; taking the nearest enemy (`SPAR_A_PICK=near`) 14, 16, with 18 and 17 (side A stands two tiles
    east, so the mirror is not even). Gap: no run of the escape with the allies not counted.
50. **On repeatable runs two specials kept for a runner catch a third more runners for a fight or two elsewhere.**
    With the timer restart of finding 41, `specReserve: 500` on the champion with `tribrid-snare-sara`
    (`.practice/climb/dual-sara.sh`, seeds 1-8): 30 of 64 runners where the champion catches 22, 91 kills and 5
    deaths against the rival builds where it has 92 and 4, and in the mirror against the champion (`extra:spar-x8`)
    35 kills and 29 deaths where the champion has 37 and 27. Finding 44's numbers for the same option came from runs
    that did not repeat. The champion takes `specReserve: 500`. Gap: 8 seeds; the mirror and the rivals each lose 1
    or 2 fights.
51. **No single knob of the champion beats it on the runner and the rivals at once.** Repeatable runs, the champion
    with `tribrid-snare-sara`, seeds 1-8 (`.practice/climb/dual-sara.sh`): the champion catches 30 of 64 runners and
    has 91 kills, 5 deaths in 96 rival fights, and a second run gives the same. Each change (runner of 64; rival kills
    and deaths of 96): `eatAt` 55: 28; 87, 9. `eatAt` 65: 35; 87, 8. `chaseBelow` 0.5: 30; 91, 5 (no change).
    `mixStyles: false`: 21; 91, 5. `adaptStyles: false`: 29; 87, 8. `freezeEarlyMax` 0: 19; 90, 6.
    `freezeBelow` 0.4: 18; 92, 4. `freezeBelow` 0.55: 28; 88, 8. `specReserve` 750: 34; 90, 6. The early freeze from
    half health holds 11 of the 30 runner kills. A special in the tick after the target's eat animation
    (`human_eat`, seq 829: it cannot eat again for 3 ticks), past `specBelow` and `specReserve`, while its health
    bar shows 70% or lower: 27; 84, 12. At 50%: 26; 89, 7. At 30%: 30; 91, 5, the champion's own result, since at
    30% its specials already go out. Gap: one knob at a time; 8 seeds.
52. **The PK army runs as one route: a roaming leader and followers that fight its target.** `scripts/pk-army.ts`
    (aio-pvp mode `army`): the leader runs the roam hunt (`scripts/pk-roam.ts` `huntOnce`, the army in its friends);
    each follower keeps within `FOLLOW` tiles of it and, while the leader's target is in view, fights that target on
    the `army` profile with the other accounts as allies; when the leader escapes, dies or ends its hunt the
    followers leave by glory or a run south. `pvp:army` (leader and two followers at the Edgeville ditch, one target
    with no food in multi-way combat at level 6): a kill and no death on seeds 1-5, 17 to 42 s a run; the first hit
    is the leader's freeze, and the kill falls to the leader or a follower. Gap: practice only; one target; the
    follower walks to the leader's tile with no formation, and `MAX_MINUTES` runs on the wall clock.
53. **A target that leaves by its glory when two hit it escapes the army at low level.** `extra:army-route-defend`
    (the army route of finding 52 against a target with 10 sharks and a glory on the champion's fight loop:
    `pvp-with-targets.ts` `TARGET_PROFILE=champion`): the target escapes on seeds 1-3, rubbing its glory at 98 or 99
    HP once the leader and a follower have hit it. With the followers on `army-alpha` (every special on contact) it
    escapes on seeds 1-3 too: the followers walk in after the leader's first hit, and a teleport is not interrupted.
    Gap: the army opens one account at a time; no run above level 30, where a glory does not work, or with all three
    striking in one tick.
54. **Above level 30 the defending target still outruns three maxed tribrids: it leaves at once, eats, and reaches
    level 30 in about 16 ticks of running.** `extra:army-route-defend-deep` (the target of finding 53 at 3166,3784,
    Wilderness level 34, multi-way; the army from level 28; seeds 1-4): the target escapes in every run, 19 to 60
    ticks after the first hit, with 52 to 66 HP on `army` followers, 56 to 94 on `army-alpha`, and 57 to 62 with
    followers that only hit (`ARMY_OPTS={"freeze":false}`, the leader's freeze alone). All three accounts cast a
    freeze at the same target on the same ticks, so two of three casts meet a held or immune target. The target's
    10 sharks heal 200 HP, more than the army deals in a 16-tick hold. One freeze for the army (`freezeShare`, on
    by default in `scripts/pk-army.ts`, `FREEZE_SHARE=0` turns it off: no cast before the last freeze and its
    immunity end) changes little: escapes at 53, 83, 54 and 44 HP. The army's prey is a target that does not leave
    at the first two hits or has no food. `OPEN_TOGETHER=1` (the army holds its fire on a new target until all
    three stand within 3 tiles of it, 10 ticks at most; followers on `army-alpha`): escapes at 55, 72, 87 and 58 HP.
    The opening still spreads over about 20 ticks: the leader's chase froze before the hold took hold, and the
    followers' first specials, armed out of melee reach, went out 7 ticks later. Gap: more accounts; the leader's
    first freeze (pk-roam's chase) does not use the shared freeze.
55. **Three, four or five maxed tribrids all let the target go that leaves a crowd at level 34.**
    `extra:army-deep-x3`, `-x4` and `-x5` (gang mode at 3166,3784, Wilderness level 34, multi-way; our account on
    the champion with 18 sharks, a glory and its escape from a crowd, a run south to level 30; the army on `army`;
    two groups; seeds 1-4): each size kills the target in 1 of 8 meetings, and it escapes in 7. Gang mode starts a
    new fight of the loop for our account whenever another of the gang hits it (`pvp_combat.rs2` single-way rule),
    and an escape begun in one call was lost in the next: with that, the sizes killed it in 2, 4 and 6 of 8. The
    loop takes `escapeLatch`, and gang mode passes one for each meeting and stops no fight once the escape has
    begun. The army lost no account. Gap: one run per seed.
56. **In the army route five accounts lose the running target as well.** `extra:army-route-defend-deep-x5` (the route of finding 52 with a leader and four followers
    from level 28 against the target of finding 54 at level 34, multi-way; seeds 1-4): the target escapes in every
    run, 21 to 23 ticks after the first hit, with 56 to 68 HP. With `OPEN_TOGETHER=1` the hold releases when all
    five stand within 3 tiles (14 to 15 ticks after the leader first sees the target) and the target still escapes
    with 39 to 79 HP; with the gang target's kit (`TARGET_KIT=tribrid-snare`: glory worn, 18 sharks) it escapes 31
    to 37 ticks in with 53 to 67 HP, and with the army started next to the target (`ARMY_AT=near`) with 41 to 87.
    Gang mode agrees once the target's escape outlives a fight restart (finding 55).
57. **A crowd's attackers are counted by facing, not by hit source: the client names a hit's source by the entity we
    face.** `StateCollector` gives each damage splat the player we face as its source, so in a crowd every hit
    counted for one player: `escapeOutnumbered` fired at 49 to 65 HP against five, and the overhead protected
    against the player we faced. The fight loop now reads each nearby non-ally player's `faceEntity`: one that faces
    an index not in our own nearby list faces us (we are not in it) and counts for the escape; one that faces us or
    an ally sets the crowd's prayer; one that faces some other visible player (another fight close by) counts for
    neither. `crowdPrayer` (multi-way combat, two or more of those: the overhead covers the style most of them hold)
    joins the champion. Two against two, side B on the champion, seeds 1-8: side A on the champion wins 17, loses 11,
    draws 4, with 5 dead and 16 of side B's; without `crowdPrayer` 9, 17, 6, with 18 dead and 9. Three against three
    (`extra:team-3v3-multi-x3`, seeds 1-8): 8, 11, 5, with 10 dead and 17 of side B's; without it 5, 14, 5, with 11
    dead and 12. Against five at level 34
    (`extra:army-deep-x5`, seeds 1-4) the champion sees the crowd at 99 HP in half the meetings and leaves alive in
    4 of 8 where the hit count let it leave in 2 (both without the escape latch of finding 55). The army case of finding 46 holds: 16 kills, no losses, the target
    eats 15.5 sharks. Gap: a target out of view counts as us; no run on the live server.
58. **A maxed roamer fights better on the champion's options, and an unknown hit source is not a second
    attacker.** `extra:roam-defend` (the roam route against a target with 18 sharks and a glory on the champion's
    fight loop, Wilderness level 8, single-way; seeds 1-6): every fight of the roam ended on `PK danger: 2 players
    hitting`. A hit's source is the entity the player faces (finding 57), and -1, no one, counted as a second
    player; `dangerReason` and the crowd escape now leave out a source below 0. The roam's own fight options then
    deal 307 and take 404 in the first fight, summed over the six seeds; with the champion's (`ROAM_PROFILE=champion`)
    379 and 360. No fight ends in a kill within the roam's 120-tick cap: two maxed accounts with food need longer.
    `ROAM_PROFILE` defaults to `auto`: the champion for an account of combat 115 or more, the roam's own options
    below that (finding 37); the army leader (`scripts/pk-army.ts`) takes the same rule. Gap: six seeds.
59. **The hunt route fights better on the champion's options too.** `extra:hunt-defend` (the hunt route from the
    Edgeville bank against a target with 18 sharks and a glory on the champion's fight loop, Wilderness level 3,
    single-way; seeds 1-6): on the hunt's own options the hunter's first fight deals 320 and takes 419, summed; on
    the champion's (`HUNT_PROFILE`, default `auto`: the champion for combat 115 or more) 1,024 and 715. Every fight
    ends with the hunter leaving on its danger check (`exitOnDanger`, "losing the race": 30 or more taken, twice what
    it dealt, in the last 30 ticks, under 60% HP), and none ends in a kill. With the race read over 60 ticks
    (`raceWindow`, `HUNT_RACE_WINDOW=60`) the fights go 859 dealt, 779 taken, and still end on the check. Gap: six
    seeds.
60. **The danger check's damage race costs the hunter its kills: without it the hunter wins the even fight and
    most of the hard one.** `extra:hunt-defend` (finding 59, the hunter on the champion's options; seeds 1-6): with
    the race (`raceExit` on) every first fight ends on the danger check and none in a kill. With `raceExit: false`
    (the check keeps its no-food, two-attacker and no-prayer rules) the hunter kills the even target in 5 of 6 and
    leaves once on no food; with no danger check at all, 6 of 6, no death. Against a stronger target
    (`TARGET_STRONG=1`: boost potions and 24 sharks) the race gives 6 danger exits and no kill; without it, 3 kills
    in one run of six and 2 in another, with one death of the hunter (seed 4) and the other fights left on no food.
    A kill drops the target's kit (about 250,000 coins of loot in `pvp:army`), a death costs ours. The champion
    takes `raceExit: false`, so the hunt, the roam and the army leader (champion options for combat 115 or more)
    fight on past a lost race; with it from the profile the hunter kills the even target in 3 of 6 and leaves on no
    food in 3 (route cases run several processes and repeat less exactly than spar batches); a later run of the same
    setup, counting the target's outcome too, gives 5 kills and no death against the even target and 4 kills and no
    death against the stronger one. On repeatable route runs (finding 41: `SPAR_NPC_NEAR=1`, the bench-seeded
    choices) the champion's hunter kills the even target in 3 of 6 with one death (seed 1: it left on no food and
    died on the way out) and the stronger target in 3 of 6 with none. `pressLow: 0.3` (the no-food exit waits while
    the target's bar shows 30% or less and no one else hits us) gives the same seed for seed against both, and stays
    off. Leaving with no food at twice the opponent's estimated max hit (`noFoodAt: 2`, the check's default 1.5)
    keeps every target dead (3 of 6 against each, one of them after the hunter has left) and the hunter alive in all
    12 fights, where 1.5 lost it once; the champion takes `noFoodAt: 2`. Gap: six seeds; no target stronger than
    potions and food.
61. **The hunt left a danger exit standing where it was; with the escape in place it kills the softer target first.**
    `extra:hunt-pick` (the hunt route against two targets at its first spot, both on the champion's fight loop: one
    in rune with 18 sharks and a glory next to the spot, one in monk robes, kit `ganker-dds`, four tiles on; seeds
    1-6): a fight that ended on the danger check (no food at twice the opponent's max hit) left the hunter beside its
    attacker, and each new hit started a fight that stopped at the same check, so it died there. The hunt now runs
    the fight loop's escape at once after a danger exit (glory, teleport or a run; the glory took it out in 7 ticks).
    Taking the softest armour first (`HUNT_PICK`, default `soft`) kills 10 targets of 12 (all six soft ones) for one
    death of the hunter; the nearest first 9 for one. That death came after the hunt's own tick cap ended a fight
    (`timeout`): the hunt stopped beside its attacker. The hunt now also escapes after a timeout in the Wilderness,
    with `flee` (the fight loop only escapes, whatever the food) and its own 200-tick cap: 8 targets of 12 (all six
    soft ones) and no death. `HUNT_MIN_FOOD` (no fight of the hunter's own choosing below
    that much food) changes nothing here, because the first kill costs little food. Pure builds: in the
    `pure-dds` mirror (`extra:spar-kit-pure-dds-x8`, seeds 1-8, against `base`) `base` and `snap` give 32 kills and
    30 deaths in 64, the champion 30 and 32, `specBelow` 1 or 0.5 31 to 33 kills, and `hunter` (a freeze on flight
    with no freeze runes) 15 and 46. The roam picks its prey from the world feed's roster before the target is in
    view, so the client shows no armour then: an armour term in `preyScore` left the first pick unchanged on
    `extra:roam-pick` (the same two targets at level 8, seeds 1-6; the roam took the armoured one first in all six)
    and is not kept. Two runs of `extra:roam-pick` with seed 1 part at tick 8 after the last login, at the roam's
    first walk: `scripts/pk-roam.ts` `Radar` holds the last world-feed frame, which comes on its own socket, so
    whether a tick's frame is read before or after that tick's game packets follows the machine, and the game socket
    carries no engine tick to align them by. Gap: six seeds; one pair of targets; a repeatable roam needs the feed
    frames tied to the game tick.
62. **The roam takes the softer of two targets once both are in view: 6 kills in 6 seeds, against 1 in 6.**
    `extra:roam-pick` (two targets defending on the champion at Wilderness level 8: one in rune with 18 sharks and a
    glory, 219 stab defence; one in monk robes with a dragon dagger, 0; seeds 1-6, `.practice/roam-switch/`): the
    roam picks the rune one from the feed by reach in every seed. With the switch (`scripts/pk-roam.ts` chase: before
    its first fight, an idle attackable player in view with at least `ROAM_SOFTER` (40) less stab defence takes the
    chase) it kills the robed one in all six and dies in none; with `ROAM_SWITCH=0`, 1 kill and no death. The
    single-target roam cases, the hunt cases and the army routes pass at seed 1 and none of them switches. Six seeds
    run in 55 to 59 s on `--seeds 1,2,3,4,5,6 --seed-jobs 6`, so a roam change is measured over seeds although one
    seed does not repeat (finding 61). Gap: one pair of targets; a softer target that fights back harder than its
    armour shows (a pure with a godsword) is not in a case.
63. **The roam's danger exit walked out with no prayer, and its own check read every fight as a lost race.**
    `extra:roam-defend-low` (the roam with 4 sharks and a worn glory against the rune target with 18 sharks and a
    glory, defending on the champion at Wilderness level 8; seeds 1-6, `.practice/roam-switch/low-*`). The roam's
    `escape` walks south and rubs only a glory in the pack, so with the glory worn it ran: on its no-food exits it lost
    7 to 38 HP on the way out. The fight loop's escape (`flee`, as the hunt uses since finding 61: protect prayer, food,
    the worn glory) loses 0 to 6 HP in five of six and 30 in one; `ROAM_FLEE=0` restores the walk. Between fights the
    roam's `survive` has no count of damage dealt, so a race check there reads `dealt 0` after any fight and ends the
    hunt on `losing the race` at about HP 50 (three of six seeds with `ROAM_RACE=1`); `survive` runs no race check and
    takes the profile's `noFoodAt`. Then every exit is a no-food exit and every
    roam escapes alive. Damage dealt before the exit is within noise: means of 120 (walk), 100 (flee) and 110 (flee,
    no race) a seed. Gap: no kill in any of these runs (4 sharks against 18 and a glory); six seeds.
64. **A hold spell's result shows as a graphic on its target in the tick the server casts it, and the tile read takes
    a target that stands still for a hold.** `pvp_magic.rs2` puts `entangle_impact` (179), `snare_impact` (180) or
    `bind_impact` (181) on a target that a hold spell hits and `failedspell_impact` (85) on one it splashes
    (`magic_combat_spells.dbrow`, `pack/spotanim.pack`); the client keeps it as the player's `spotanimId`
    (`observePlayer` `spotanim`). The fight loop reads holds and splashes from it first, for every caster's hold
    (`SPOT_READ=0` leaves the tile read alone). At an army's opening (`extra:army-route-defend-deep`, the target
    still standing) the tile read took a splash for a hold and blocked the others' freezes. In single fights the
    graphic read changes nothing: the champion with `tribrid-snare-sara` catches 30 of 64 runners and has 91 kills
    and 5 deaths in 96 rival fights with it and without it (seeds 1-8, the repeatable setup of finding 41,
    `.practice/climb/set-spot*`). A hold also ends once its caster stands more than 10 tiles from the target
    (`pvp_frozen` walk trigger). Gap: the graphic of a later spell or arrow on the target replaces the impact
    graphic, so a hold that another graphic hides is read by the tile.
65. **No opening of three or five maxed tribrids kills the target that eats 10 sharks and leaves a crowd at level 34.**
    `extra:army-route-defend-deep` (three accounts) and `-x5` (five), seeds 1-6, `.practice/roam-switch/`. The
    target defends on the champion and runs as soon as two of the army face it; it reaches level 30, where its glory
    works, in 16 to 20 ticks. Held casts land at level 29 or 30 when the freeze waits for the run (the champion's
    `freeze: 'low'`). Options added to `scripts/pk-army.ts`, each off by default: `VOLLEY=1` (the first special on
    a target waits until every account stands next to it with one ready), `FREEZE_STAGGER=1` (a cast blocks the
    others for one tick until its caster sees the hold), `BURST_HOLD=1` (every special goes while the shared freeze
    holds the target), `OPEN_FREEZE=1` (each account's first turn is a freeze) and `OPEN_TOGETHER=1`. Kills of 6,
    three accounts: none 0, `VOLLEY` 1, `VOLLEY` with `FREEZE_STAGGER` 0, with `OPEN_TOGETHER` too 0, `BURST_HOLD`
    with `FREEZE_STAGGER` and `OPEN_TOGETHER` 0, all five with the graphic read 0; five accounts: none 1, all five
    0. With all five and the graphic read the army holds the target at level 33 or 34 in three seeds of six and
    lands 13 specials, and it still leaves with 54 to 70 HP: three dragon dagger specials into Protect from Melee
    and rune armour deal less than the target heals from its sharks. Escape HP (three accounts, mean of 6): none 78,
    `OPEN_FREEZE` set 61, all five with the graphic read 76. The army's prey stays the target with no food or no
    escape (findings 52 to 56). Gap: no kit with another special weapon (`pvp_special_attack.rs2` also has the dragon longsword, dragon mace, rune claws and dragon halberd) was tried; 6 seeds a setup.
66. **The roam and the army left the Wilderness on foot with their glory worn.** The game rubs a glory only from the
    pack (`amulet_of_glory.rs2` has no worn option). The roam's escape rubbed only a glory in the pack, so with the
    glory worn it ran south; on `extra:army-route-defend-deep` seed 1 a blocked walk stood 908 ticks at level 14 and the
    bench's no-progress check failed the run. The army's `leave` took a worn glory off first, but into a pack full of
    kit, so the removal failed and the follower stood 120 ticks. Both now eat a food to free a slot when the pack is
    full, take the glory off (three tries), rub it, and else walk, stepping 10 tiles to the side when a walk moves
    them nowhere. `extra:army-route-defend-deep` seeds 1-6: the leader and both followers reach Edgeville at the end
    of the hunt in all six, from levels 3 to 33, with no stand longer than 9 ticks. Gap: the fight loop's own escape
    is not checked with a full pack.
67. **Spears on a melee tile at the opening kill the target that eats and leaves a crowd at level 34: 18 of 18.**
    The dragon spear's special has no hit roll: it pushes the target a tile and holds it with `p_delay(4)`, no
    move, no eat and no glory rub, for 25% energy (`pvp_dragon_spear.rs2`). `extra:army-route-defend-deep-x5` (the
    target of finding 54 with 10 sharks and a glory, Wilderness level 34, multi-way; leader on the dragon dagger,
    four followers; `.practice/roam-switch/x5*`), kills of the target: followers on `army-alpha`, `OPEN_TOGETHER=1`
    and `OPEN_RANGE=1` (the army walks onto melee tiles with its fire held, then opens), with `ARMY_SPEARS` (the
    first n followers on kit `tribrid-snare-spear`) 0: 1 of 12; 1: 0 of 6; 2: 6 of 12; 3: 15 of 18; 4: 18 of 18;
    with the fight loop's event fix of finding 71 (on both sides: the target fights with the same loop) four spears
    kill 10 of 12 (seeds 1-12), and in the two misses the target leaves at 25 HP once the spears' energy is spent;
    with the leader's specials at any health as well (`LEADER_SPEC=all`, the default with the lock) 17 of 18.
    Four spears with no opening options: 1 of 6; with `army-alpha` alone: 0 of 6; with the opening but not
    `army-alpha`: 0 of 6; without `LEADER_SPEC=all` (the leader's specials at any health), before the event fix: 6 of 6. The two spear
    specials a tick or two apart keep the target from acting between them; on `army` the specials wait for low
    health and the lock never starts. Three accounts (two spears) kill none of 6: the leader's hits alone are too
    few in the lock. No account of the army died. `army-alpha`'s `specBelow: 1` holds before the target's first
    hit since `lowHealth` takes a fraction of 1 as any health; a check that needs the health bar to show makes the
    first special of the opening wait 5 ticks for the first hit. Case `extra:army-route-spear-x5` (four spears).
    `scripts/pk-army.ts` opens with the lock by default when two or more followers wield a dragon spear: four
    spears with no settings given, 6 of 6. Where the glory works (`extra:army-route-spear-low-x5`, the same army
    and target at 3150,3560, Wilderness level 6, multi-way; seeds 1-6): four spears 6 of 6 with no glory rub by the
    target, no spears 2 of 6 with 10 rubs: a held target cannot rub. A leader and three followers (`extra:army-route-spear-x4`, seeds 1-6):
    three spears 2 of 6, two 1 of 6, three with `LEADER_SPEC=all` 1 of 6: the lock needs five accounts. Spears that stun in turn on one shared clock (`STUN_SHARE=1`: a spear specials
    only once the last hold has ended, and hits between) kill 0 of 6 with four spears of five accounts and 1 of 6
    with three of four: the next spear is often still in its attack delay when a hold ends, and the target eats
    or runs in the gap; overlapping holds leave none. In an even fight the spear loses: two of ours against two on the snare
    kit in multi-way combat (`extra:team-2v2-multi-x4` and `extra:team-2v2-spear-x4`, seeds 1-4, side B on the
    champion), wins, losses and draws of 16 groups: dragon dagger on the champion 10, 4, 2; spear on the champion
    5, 8, 3; spear on `army-alpha` 4, 11, 1; one spear and one dagger (`extra:team-2v2-mixed-x4`, kits joined by `+`
    in `scripts/pk-team.ts`) on the champion 5, 11, 0. No account dies in these fights: each ends when one side
    leaves, and a hold deals no damage. Supply: the only drop of a dragon spear is the mega-rare table, 3 of its 128
    rolls (`shared_droptables.rs2` `megararetable`), so the army's four spears are a market purchase. Gap: a
    single-way spot (one attacker at a time) has no lock; the target's own escape does not answer the lock; four
    spears leave the army with one dagger.
68. **Against two targets together the spear army kills 10 of 12, once its leader stops banking an empty pack.**
    `extra:army-route-spear-pair-x5` (the spear army of finding 67 against two of finding 54's targets two tiles
    apart at Wilderness level 34, multi-way; seeds 1-6): four spears 8 of 12 targets and no death of ours, no spears
    0 of 12. Between the targets the leader walked to the bank and back (156 ticks) with nothing to deposit: the
    roam banked whenever 2 slots or fewer were free, and the fight kit leaves no more. It banks a full pack only
    with loot in it: 10 of 12. The roam's escape and the army's leave take a worn glory off to rub it; the rubbed
    glory is a new item, so the bank trip deposited it as loot and the next trip had none. They wear it again after
    the teleport (`wearGlory`). The roam's 120-tick fight cap costs nothing here: `LEADER_CAP=400` kills 8 of 12.
    Gap: 6 seeds.
69. **The spear lock catches a target that runs at its first hit, and nothing catches one that leaves on sight.**
    The spear army of finding 67 (`extra:army-route-spear-x5` at level 34 and `-low-x5` at level 6, seeds 1-6)
    against its target set to escape only (`TARGET_OPTS={"flee":true}`): 6 of 6 at each level and no glory rub,
    since the first contact is a spear's hold and a held target cannot run or rub. With the target leaving as soon
    as any other player is within 12 tiles (`TARGET_SIGHT=12`, `scripts/measure/pvp-with-targets.ts`): 0 of 6 at
    each level, with or without the opening hold (`OPEN_TOGETHER=0`). At level 6 it rubs its glory at full health
    and is gone 6 ticks after it sees the army, before any account is within the 10 tiles of a freeze; at level 34
    it runs to level 30 and rubs there. The army's prey is a target that is busy (skilling, fighting) or slow to
    see it. A delay before it leaves (`TARGET_SIGHT_DELAY`) of 3, 6 or 10 ticks still gives 0 of 6 at level 6: from
    the first sight at 12 tiles the army takes about 15 ticks to stand all on melee tiles (`"open"` at t61 after the
    rub); at 16 ticks 5 of 6, at 22 ticks 6 of 6. The time goes to the followers: they keep with the leader by
    walks to its last tile, and when the leader stands at the target they are 15 tiles behind it (`ARMY_TRACE=1`,
    each account's distance on each tick of the hold). With the leader's chase waiting while a follower is more
    than 4 tiles from it (`PACE`, default 4 with the opening hold) and the followers running to the target's tile
    as the leader sees it (`FOLLOW_TARGET`), all five come into view together and stand on melee tiles 6 ticks later:
    a delay of 10 ticks gives 4 of 6, 16 ticks 6 of 6, 6 ticks 0 of 6, and the target that does not run 6 of 6.
    The opening hold also ends when the target runs (its tile moves 2 tiles in a tick, `OPEN_ON_RUN`), and the pace
    holds only until the fight opens; above level 30 the target that leaves on sight still gets away (0 of 6, every
    hold at level 30): with 12 tiles' start at the army's speed it never comes within a freeze's 10 tiles before it
    reaches level 30. The army comes from the south, the side the target runs to, and the target runs past it: the
    casts go out at 8, 12 and 14 tiles as it passes (`.practice/roam-switch/run-open34b`). Gap: a target that leaves
    within 6 ticks of the first sight; an army that waits in the runner's path; the test target runs straight south
    where a player picks its way round.
70. **The roam's bank trips deposited nothing: its loot is the same items as its kit.** `extra:roam-field` (the
    roam against four maxed targets with no food at levels 6, 6, 17 and 17, two single-way and two multi-way spots;
    seeds 1-6, `.practice/roam-switch/field*`): 3 kills in its minute in every seed, no death, a kill about every
    300 ticks (kills at ticks 183 to 283, 408 to 599, 668 to 927). Each kill's loot (rune arrows, a mystic staff,
    rune armour, a dragon dagger, a glory, runes: about 256,000 gp) set off a bank trip that deposited nothing,
    because the bank kept every item id of the kit, and the loot stayed in the pack. The kit is the pack's count of
    each item at the start, by name without its dose or charge (a drunk Prayer potion(2) or a rubbed glory is
    kit); the bank takes the rest. Then each trip deposits the loot (`Rune arrow x307`, `Dragon dagger(p) x1`, ...)
    and keeps the kit's potions; the third kill comes at a mean of 911 ticks against 832 (four seeds of six reach
    it). Of the 300 ticks between kills, the loot takes 30 to 40 and the bank trip about 50. Gap: the targets stand
    still; 6 seeds.
71. **The fight loop counted the last fight's hits as its own, and a roam that does not loot kills 28% faster.**
    The loop read every combat event in the client's history at its first tick as new: the hits of a fight that had
    just ended came in as damage taken now and as attackers. A fight that starts soon after another (the roam with
    no loot pause, the army, gang mode's restarts) then met a false danger: in `extra:roam-field` with `LOOT=0` every
    second fight ended in its third tick on `2 players hitting` with nothing taken, and the roam left after one
    kill in each seed. The loop skips events from before its start, as it skips messages. The field case runs
    1,000 game ticks (`MAX_TICKS`, `scripts/pk-roam.ts`; one minute of wall time gave 213 to 3,169 ticks). Kills
    in 1,000 ticks, seeds 1-6: loot and bank (default) 18, the third kill at a mean of 826 ticks; `LOOT=0` 21, the
    third at 596; `BANK_AT=2000000` (bank only a big load) 19, the third at 860. The worn glory counts as kit too,
    so one that the escape rubbed is not banked. The quick sweep (20) and the gang cases (23) pass. Gap: the loot
    is the supply of arrows, runes and food that a long hunt needs; no case prices that against the kills.
72. **Dragon armour with the Saradomin cape beats the rune kit on the runner and the rivals at once.** The champion
    with each kit (`.practice/kits/run.sh`, `extra:spar-escape-<kit>-x8` against a `base` runner and
    `extra:spar-rivals-<kit>-x12`, seeds 1-8, the repeatable setup; bonuses from `bun scripts/gear.ts kit`), runners
    caught of 64 and rival kills and deaths of 96: `tribrid-snare-sara` (rune, Saradomin cape) 28 to 30, 91, 5;
    `tribrid-dragon-sara` (dragon med helm, chainbody, platelegs and square shield, Saradomin cape) 31, 94, 1;
    `tribrid-dragon` (the same with the Legends cape and black dragonhide vambraces) 22, 95, 1; the dragon kit with
    14 sharks 31, 88, 8; the dragon kit that wears the Saradomin cape for each freeze (`freezeWear`,
    `tribrid-dragon-capeswap`) 26, 92, 4; `tribrid-snare-dhide` (black dragonhide body and chaps) 23, 93, 3;
    `tribrid-snare-swap` (rune for melee, dragonhide for bow turns) 17, 90, 5; `tribrid-snare-sara-mlb` (magic
    longbow special: no hit roll, 10 tiles, `pvp_magic_longbow.rs2`) 27, 89, 7; `tribrid-sara-mace` 21, 89, 7;
    `tribrid-sara-dls` 24, 89, 7. A kit's fixture sets the completion varp of each quest its items need
    (`kitVarps`, `QUEST_VARP`): a dragon mace or square shield put back on after the two-handed bow is checked by
    `levelrequire.rs2`, and without Legends' Quest the dragon kits fought with no shield after their first bow turn
    (dragon with the Saradomin cape then 28, 88, 7; the mace kit 1, 0, 81). The runner is caught by freezes, set by
    what stays on at the cast: with 18 sharks the pack has one free slot, so the strip takes off one piece, the
    largest penalty first (each item's own from `knowledge/gear.json`). `dropForStrip` (a freeze on a target that
    fled, at 70% health or more with 8 food kept, drops a food until 5 slots are free) gives `tribrid-dragon-sara` 34,
    94, 1 and `tribrid-snare-sara` 31, 91, 5; the champion takes it. The melee style: one combat style index serves
    every weapon (index 1 is the bow's rapid and the dagger's aggressive stab, +3 Strength; `combat.dbrow`
    `weapon_stab_table`); `meleeStyle: 0` (accurate stab, +3 Attack, on melee turns and specials, rapid on bow turns,
    a packet for each change) gives `tribrid-dragon-sara` 33, 94, 2: no gain. The champion's knobs on
    `tribrid-dragon-sara`: `freezeBelow` 0.6 34, 95, 1; `specReserve` 750 36, 93, 3; neither is clear of 34, 94, 1. Gap: 8 seeds; the hunt, roam and army
    routes still stage the rune kit.
73. **Dragon armour wins more team fights; in the hunt it takes about as much damage as rune. The hunt's fixed kit
    dropped any other shield.** `extra:hunt-defend` (the hunt route against a target defending on the champion with 18
    sharks and a glory, seeds 1-12), the hunter in rune (the fixture) or in `tribrid-dragon-sara`'s armour
    (`HUNTER_KIT`, which gives the fixture a kit's equipment and quest varps): kills 11 and 11, deaths 0 and 0, damage
    dealt 5,224 and 5,310, damage taken 4,493 and 4,130 (seeds 1-6: 2,655 against 1,954; seeds 7-12: 1,838 against
    2,176, so the difference is in the noise; the `HUNT` lines of `.practice/roam-switch/hunt-*`). The hunt's kits
    name the rune kiteshield in their melee lists, so a hunter in any other shield lost it at its first bow turn for
    good; the hunt puts the shield it wears at its start in that place. Two against two in multi-way combat (side B on
    the snare kit, both sides on the champion, seeds 1-8, 32 groups): side A in `tribrid-dragon-sara` wins 21, loses
    9, draws 2 (`extra:team-2v2-dragon-x4`); on the snare kit 16, 9, 7 (`extra:team-2v2-multi-x4`, the same runs).
    Three against three (seeds 1-4, 12 groups): side A in dragon armour 4, 4, 4 (`extra:team-3v3-dragon-x3`), on the
    snare kit 4, 4, 4, and one dragon spear with two in dragon armour 4, 6, 2 (`extra:team-3v3-spear-x3`). Supply (the drop scripts; `knowledge/drops.json` leaves out
    the shared tables): dragon platelegs from a steel, iron or bronze dragon 1 in 256, 512 or 1,024 kills
    (`steel_dragon.rs2` and the others), the dragon chainbody from the Kalphite Queen 1 in 128 (`kalphite_queen.rs2`),
    the dragon med helm from the King Black Dragon 1 in 128 (`king_black_dragon.rs2`) and the shared rare table, the
    left half of the dragon square shield (`dragonshield_a`) 4 in 128 rolls of the mega-rare table. Gap: the roam and
    the army in dragon armour; the square shield's other half is not traced.
