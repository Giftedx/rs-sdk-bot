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

Gap: the fight loop does not choose where to stand, so cover, line of sight as a defence and a second attacker are
not measured.

Spar findings. Conditions: lockstep practice engine, cap 900 ticks, both sides with Lost City and Dragon Slayer done
unless a finding says otherwise; a seed repeats its fight. Evidence: `.practice/pk-spar/*.json` and the traces
`.practice/pk-spar/trace-*.log` in the worktree that ran them.

1. **A mirror fight is a food race.** `pvp:spar`, base against base, seeds 1, 2, 3: kills at 668, 535 and 570 ticks;
   side A, side A, side B won. The loser had eaten all 18 sharks in each fight; the winner 18, 13 and 16.
   Gap: three fights; equal settings win or lose by the seed, so a small gain needs more seeds to show.
2. **A freeze whenever the target is free loses a stand-up spar.** freeze against base, seeds 1, 2, 3 on each side,
   without Dragon Slayer on either side (the platebody stayed off after the first cast): 2 wins, 4 losses, mean score
   -104.2 (scores -175, 126, 163, -268, -244, -227). Gap: six fights; not run with Dragon Slayer done.
3. **The fight loop's `dealt` counter reads low.** One spar: side A `dealt` 102 where side B took 274. The spar
   scores from damage taken. Gap: the cause in the SDK `damage_dealt` events is not found.
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

   Gap: three seeds each; the kill needs more damage inside the freeze (special energy kept for it, the fastest
   ranged turn) and is not tuned.
5. **A start out of sight or far apart does not stop the fight.** One run each at seed 7, base against base, without
   Dragon Slayer: first damage at tick 19 from 2 tiles in the open, 31 from 12 tiles, 11 from 6 tiles with the blocker
   between; kills at 528, 495 and 628 ticks. The server walks an attacker to a tile with line of sight. Gap: one run each.
6. **A side that escapes must not end its fight when the target leaves its view.** In the first escape spar the runner
   returned `lost` 219 ticks in, still deep in the Wilderness. The loop keeps going while it escapes.
7. **An account without Dragon Slayer loses its rune platebody at the first cast.** The loop takes the platebody off
   for a cast and puts it on for a melee turn; the game refused it 35 and 39 times in one spar ("You have not earned
   the right to wear this yet.", `levelrequire.rs2:132`). A PK account needs Dragon Slayer, or a body with no quest.
8. **"I'm already under attack." is not proof of a monster.** A new practice world sends it for the first 8 ticks
   (`pvp_combat.rs2:110`), and both sides then left the fight to attack a monster 15 tiles away. The loop reacts only
   to a monster within 8 tiles that faces a player, and the spar waits 10 ticks before the fight.
9. **Monsters at the fight spot block player hits.** At (3094, 3800) green dragons attacked both sides: "Someone else
   is already fighting your opponent." 14 and 17 times in one spar. The escape case stands at (3125, 3790), where a
   probe saw no attackable monster.

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
