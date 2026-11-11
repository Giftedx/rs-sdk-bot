# Prayer guard findings

The guard is `packages/core/src/prayer-guard.ts`. Its bench cases are the `extra:guard-*` cases of `scripts/measure/aio-bench-cases.ts`. Each finding is: claim; conditions; evidence path; gap.

## Engine rules

- A prayer costs no points when every prayer is off for a moment at least each 4 ticks; practice engine, lockstep; `skill_prayer/scripts/prayer.rs2:30-43,163`, case `extra:guard-three`; the live server can deliver an input one tick late, which is not measured.
- A protection prayer cuts the largest hit of a player by 40% and does not stop it; a scimitar, a shortbow and Wind Strike in the Wilderness, 200 ticks each; `pvp_melee.rs2:31`, cases `extra:guard-rival`, `extra:guard-rival-bow`, `extra:guard-rival-staff` (Hitpoints 60 to 36, 39 and 48); other spells and special attacks are not measured.
- A click on a fishing spot acts on three ticks of `%action_delay` only: it starts the timer, it casts one tick later, and on a sea spot it rolls on the last tick. On each other tick it ends the fishing (sea spot) or takes the place of the roll (river spot). The server refuses the hidden option that continues; `fishing_spots/saltfish.rs2`, `freshfish.rs2`, engine `OpNpcHandler.ts`; cases `extra:guard-fish`, `extra:guard-fish-scorpion`, `extra:guard-fish-cage`; river bait is one run (`GUARD_STAND_FISH=riverBait:4`: 4 fish in 68 ticks, 0 points).
- A click on a rock or a tree continues on every tick; `skill_mining/scripts/mining.rs2:76`, `skill_woodcutting/scripts/woodcut.rs2:55`; cases `extra:guard-mine`, `extra:guard-chop`.
- The state keeps `hp` 0 on an NPC slot after a death until the next NPC in that slot shows its health; chaos druids in Edgeville Dungeon; guard trace of `extra:guard-druid` (an attack on an NPC with `hp` 0 dealt damage two ticks later); the time until the first health update is not measured.
- A hunt needs a line of sight for hunt mode `ranged`, and a melee NPC that cannot path to the player targets it and never hits; the centre of the dark wizards' circle and the tile 3295,3310 between three iron rocks; engine class `HuntIterator`, runs with `targeted=` above 180 and 0 damage with the guard off; no gap.

- Each button of Rapid Restore and Rapid Heal sets its regen timer again: off sets it to 100 ticks and on to 50. A flick each 3 ticks keeps the timer from its end, so no stat and no Hitpoints come back; the guard sends no flick while one of the two is on, and the prayers drain; `skill_prayer/scripts/prayers/rapidrestore.rs2:18-19,35-36`, `rapidheal.rs2:17-18,34-35`, `player/scripts/stat.rs2:30-61`, unit test in `packages/core/test/prayer-guard.test.ts`; no engine run. The decay of a boosted stat has its own timer (`stat_boost_restore`), which these buttons do not set.

## Measurements

Practice engine, lockstep, seeds 1 to 3 unless a line says one seed.

- Auto-retaliate off during a skill action gives no gain; 25 iron ore under scorpions: 263, 280, 272 ticks against 265, 281, 252 (rune pickaxe) and 392, 400, 392 against 333, 356, 314 (bronze pickaxe, Mining 15); 12 willow logs under dark wizards: 409, 473, 11 logs at the cap of 500 against 454, 450, 362; 12 fish in a net beside a scorpion: 95, 110, 100 against 100, 106, 103; cases `extra:guard-mine`, `extra:guard-chop-wizard`, `extra:guard-fish-scorpion` with `GUARD_STAND_RETALIATE=off`; a hit with auto-retaliate on sets `%action_delay` 2 ticks ahead (`auto_retaliate.rs2`), which shortens the start of a slow pickaxe.
- The Strength and Attack prayers of the guard show no gain in druid kills in 600 ticks; 23, 27, 22 kills with them against 24, 23, 22 without (`PRAYER_OFFENCE=0`), one guard-off run 24; case `extra:guard-druid`; three runs for each condition do not resolve a gain below about 3 kills.
- The guard does not slow woodcutting or fishing; one seed; 8 oak logs in 39 ticks with the guard and 39 with the prayer held (7 points); 8 trout or salmon in 101 ticks against 150 (29 points); cases `extra:guard-chop`, `extra:guard-fish` with `PRAYER_GUARD=0`; one seed only.
- Each guard case has a control with the guard off that shows the attack is real: the worker dies in `extra:guard-wizard`, `extra:guard-thrower`, `extra:guard-chop-wizard`, `extra:guard-rival-staff`, and the mining worker stops in `extra:guard-mine`.

## Limits

- With 3 or 4 prayers on during fishing, the two-tick flick needs a start each 4 ticks and the fishing cycle has 5: the guard keeps the points and loses most rolls.
- With 5 or more prayers on, the guard holds them and they drain.
- With Rapid Restore or Rapid Heal on, the guard holds every prayer and they drain.
- The count of `I'm already under attack!` messages is known only with the guard trace on (15 at druid seed 1, 0 at seed 3); a run with the guard off prints no messages, so the two conditions are not compared.
- Four scripts need every prayer off at their start and stop the guard there with `releasePrayerGuard`: `quest-itwatchtower-owned.ts`, `quest-legends-owned.ts`, `microbot-chompy-trip.ts`, `microbot-pvp.ts`. They get no free prayers. The bench cases `pvp:microbot-pvp` and `fighter:chompy-at-site` pass with that stop; the two quest scripts have no bench case.
- No run on the live server uses the fishing cycle or the stale-health rule.
