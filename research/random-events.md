# Random events on the rs-sdk server (rev 289, LostCity)

Source: `vendor/rs-sdk/server/content/scripts/macro events/` (scripts and configs), the engine
(`server/engine/src/engine/World.ts`, `entity/Npc.ts`, `script/handlers/PlayerOps.ts`), and the packs in
`server/content/pack/`. Read on 2026-10-23. The handler is `packages/core/src/randomevents.ts`.

Live state is NOT VERIFIED (INDEX C1). Checked on 2026-10-23: the Woodpecker run log names no dryad (it only
shows `died ... hp=0` at 3233,3243); no event NPC and no event reward (lamp, strange box, axe handle, kebab and
beer) is in the inventory or bank of any of the 7 demo bots in `.practice/status/`. The vendored
`vendor/rs-sdk/fly.toml:25` sets `NODE_RANDOM_EVENTS = "false"`, but that file is not the live config (it sets
tick 300; live runs 400 ms). The Woodpecker death was not a giant spider either: the river separates its tile
from the spiders (section 6). Its cause is still unknown. The handler does nothing when no event spawns.
Our local practice engine has events off: `NODE_RANDOM_EVENTS` is unset, so `map_random_events` is false.
The handler is safe either way: with no events it only reads state.

## 1. When an event fires

1. Every 500 ticks the engine rolls each player (`World.ts:694`). The chance is 1/24. It is 1/12 when the
   player's AFK-zone counter is at its cap (`Player.zonesAfk()`: the player stayed in the same 21x21 zone
   for 1000 zone updates). A success sets `afkEventReady`.
2. The `afk_event` command returns true, and clears the flag, only for a player with staff level below 2
   (or on a debug world).
3. The flag is used by the first of these that runs:
   - the login timer `[timer,general_macro_events]`, every 500 ticks: a general event;
   - a skill action that calls `afk_event`: woodcutting (each swing), fishing, mining, pickpocket, stalls,
     trapped chests, the Ape Atoll market, bone burying. These pick a skill event or a general event;
   - cooking, alching, spinning, jewellery, charge orb, picking (flax and similar): a general event.
4. `~macro_event_allowed` must be true: random events on, not in the duel arena, gnomeball, trawler,
   Tutorial Island, games room or Castle Wars, `%macro_event` is 0 (no friendly event is waiting), and no
   greegree.

Expected rate on the demo: about one event per 2 hours of play, one per hour for a bot that stays in one zone.

### Skill event tables (`count` = 8 on a members world, 7 on free)

| Action | Roll | Skill events (each 1 in the roll) | Otherwise |
|---|---|---|---|
| Woodcutting | random(count+3) | dryad, ent, lost axe | general |
| Woodcutting, achey tree | random(count+2) | dryad, lost axe | general |
| Fishing | random(count+3) | big fish, river troll, whirlpool (if the spot has one; else big fish or troll) | general |
| Mining | random(count+3) | lost pickaxe, gas, rock golem | general |
| Mining, rune essence | random(count+2) | lost pickaxe, rock golem | general |
| Pickpocket, stalls | random(count+1) | watchman | general |
| Trapped chest | random(count+2) | poisonous gas, watchman | general |
| Bury bones | random(count+2) | zombie, shade | general |

On a members world each woodcutting skill event is 1/11 of all woodcutting events. A general event is 8/11.

### General event table (`~macro_event_set_random`)

Roll 1-8. Rolls 7 and 8 (the teleport events) are kept 25% of the time and never above Wilderness level 20;
otherwise the roll is redone in 1-6. Roll 5 (triffid) is rerolled on a free world.

| Roll | Event | Members chance |
|---|---|---|
| 1 | Swarm | 5/32 |
| 2 | Genie | 5/32 |
| 3 | Drunken dwarf | 5/32 |
| 4 | Mysterious old man, gift | 5/32 |
| 5 | Strange plant (triffid) | 5/32 |
| 6 | Mysterious old man, strange box (becomes the maze if the pack is full) | 5/32 |
| 7 | Mysterious old man, mime (teleport) | 1/32 |
| 8 | Mysterious old man, maze (teleport) | 1/32 |

## 2. How a hostile event ends

Dryad, river troll, rock golem, zombie, shade, watchman, swarm and the angry triffid all use
`npc_setmode(opplayer2)` after a 1-3 tick delay. Their `ai_timer` runs every 20 ticks and deletes the NPC when
`~macro_event_lost_hostile` is true: the NPC is in WANDER mode and is more than 3 tiles from the player (or on
another level).

The NPC goes back to WANDER when its target check fails (`Npc.ts targetWithinMaxRange`, op branch): the
player is more than `maxrange + 1` tiles (Chebyshev) from the NPC's **spawn tile** on either axis, or exactly
on the `maxrange + 1` corner. These NPCs have no hunt mode, so a NPC in WANDER never takes the target again.

The rule for a bot: walk to a tile at Chebyshev distance `maxrange + 2` from the spawn tile, wait until the
NPC's `targetIndex` is -1, then go back to work. The NPC wanders near its spawn and is harmless.

| Event | maxrange | Safe distance from spawn |
|---|---|---|
| Dryad, river troll, rock golem, zombie, watchman | 5 | 7 |
| Shade, angry triffid | 3 | 5 |
| Swarm | 15 | 17 |
| Angry drunken dwarf | 10000 | none: talk to it (talking still works when it is angry) |

The NPC level follows the player's combat level (`~macro_event_combat_level`): combat 3-10 gets the level 14
version, 11-20 level 29, 21-40 level 49, 41-60 level 79, 61-90 level 120, 91+ level 159.

## 3. Event table

Detection uses world state only: NPC type id (`nearbyNpcs[].id`), `targetIndex` (raw face entity: a player
target is slot + 32768), items, ground items, locs, interfaces. A NPC targets **us** when its target is a
player slot that is not in `nearbyPlayers` (the list excludes our own player). NPC overhead text is not in
the state.

Ticks are the handler's cost, measured on the local test engine (section 5) where measured, else estimated.

| Event | NPC / item ids | What it does | Response (handler) | Ticks | Fail penalty | Rewards |
|---|---|---|---|---|---|---|
| Dryad ("Tree spirit") | npc 438-443 | Attacks the woodcutter. "Leave these woods and never return!" | Flee to 7 from spawn, wait for target -1, return | 6 to escape (measured), plus the walk back | Damage until it is lost or killed; killed a bot at 5 HP | If killed (128ths): mithril axe 20, steel axe 10, adamant axe 8, rune axe 4, 22 nature runes 31, smaller nature stacks 5, banana 12, knife 1, herb 29 (members), jewel |
| Ent | npc 444-452, named like the tree, op "Chop down" | The tree turns into an NPC for 60 ticks; the player keeps chopping it. Every 7th swing on an ent breaks the axe ("Broken axe") | Click another tree of the same name; scripts may not click the ent | 1 | Broken axe (repair at Bob) | None |
| Lost axe | handle obj 492 "Axe handle", heads 508-520 "Axe head" | The axe becomes a handle (in the hand if it was worn); the head lands within 7 tiles | Unequip the handle if worn, pick up the head, use the handle on the head, wield the axe again | about 6 (estimate) | No axe until fixed | None |
| River troll | npc 391-396 | Attacks the fisher. "Fishies be mine, leave dem fishies!" | Flee to 7 | about 6 | Damage | If killed: bait, feathers, raw fish, oyster shells, casket, fisher potion (members) |
| Big fish | npc 390 (the spot changes for 5 ticks) | Knocks the fishing tool out of the pack onto a tile within 7 | Pick the tool up again | about 4 | Tool lost when the ground item expires | None |
| Whirlpool | npc 403-406, still named "Fishing spot" | The spot is a whirlpool for 60 ticks. The 5th click on it deletes the tool | Click another fishing spot; scripts may not click the whirlpool | 1 | Tool deleted | None |
| Rock golem | npc 413-418 | Attacks the miner (melee near, ranged throw) | Flee to 7 | about 6 | Damage | If killed: runes, ores, bars, stout, hammer; level 120/159 adds pickaxes and gems |
| Gas (exploding rock) | loc 2119-2140 (the rock changes for 60 ticks) | The 5th ore from it explodes: 10 damage and a broken pickaxe | Mine another rock; scripts may not click the gas rock | 1 | 10 HP and a broken pickaxe | None |
| Lost pickaxe | handle obj 466 "Pickaxe handle", heads 480-490 | As lost axe | As lost axe | about 6 | No pickaxe | None |
| Watchman | npc 431-436 | Attacks the thief. "<name>, you are under arrest!" | Flee to 7 | about 6 | Damage | If killed: coins, runes, steel bars, mithril med helm |
| Poisonous gas | loc 2141 (chest) | 2-3 damage every 4 ticks within 1 tile of the chest, for 100 ticks. Player says "I better run!" | Step 2 tiles away; scripts may not click the chest | 2 | Damage | None |
| Zombie | npc 419-424 | Attacks the bone burier. "Brainsssss..." | Flee to 7 | about 6 | Damage | If killed: big bones, bait, chaos/cosmic runes, coins, swordfish |
| Shade | npc 425-430 | Attacks the bone burier. "Leave this place mortal!" | Flee to 5 | about 4 | Damage | If killed (members): black robe top or bottom, 50% nothing |
| Swarm | npc 411 | Follows and attacks | Flee to 17 | about 10 | Damage | None |
| Genie | npc 409, op "Talk-to" | Follows. Warnings at 20, 40, 60 ticks; at 80 ticks "No one ignores me!" and a fail teleport | Talk at once, click through the chat. Then rub the lamp (obj 2528) on the skill this run trains | 4 to talk (measured on the dwarf and old man), about 6 for the lamp | Fail teleport (`macro_event_fail_teleport`) | Lamp: base level x 10 XP in one skill |
| Drunken dwarf | npc 956, op "Talk-to" | Follows. Warnings every 10 ticks; at 50 ticks he attacks (maxrange 10000) | Talk at once | 4 (measured) | He attacks until he despawns | Kebab and beer |
| Mysterious old man, gift | npc 410, op "Talk-to" | Follows. Warnings at 20, 40, 60; at 80 a fail teleport | Talk once he stays 3 ticks (the other variants vanish in 1-2 ticks) | 4 to 7 (measured) | Fail teleport | Kebab, spinach roll, 240 coins or a casket (members table 150) |
| Strange box | obj 3062 "Strange box", interface 6554 | Put in the pack. It cannot be dropped. Every 150 ticks it copies itself (up to 28) | Open it, read the question and the three model objs, click the right answer | about 4 per box | A wrong answer adds a box; boxes fill the pack | Coins (80-640), uncut sapphire/emerald/ruby/diamond, 240 coins, key half |
| Mime | npc 1056, region x 1984-2047, z 4736-4799 | Teleport to the theatre. Copy the mime's emote 4 times in a row | Read the mime's emote animation, click the matching button (6546-6553) when the panel opens | 4 cycles of 32 ticks at best (about 130); NOT RELIABLE, see section 5 | None: the player stays until it is done | A mime costume piece, an emote, or 500 coins |
| Maze | region x 2880-2943, z 4544-4607 | Teleport to the maze. Touch the centre shrine (loc 3634 at 2911,4575) to return | Path to the shrine through the wall-doors (op "Open"), block a door that says "not the right way", stand at local (30,32), open its door, touch the shrine | 183 measured (17 doors) | None: the player stays until it is done; the reward drops 1% each 5 ticks | 3 rolls of coins, feathers, arrows, runes, noted coal or mithril ore, scaled by total level and time left |
| Strange plant (triffid), members | npc 407 "Strange plant", then 408 | Grows for 45 ticks, ripe until 90 ticks, then attacks (maxrange 3) | Pick it at 47-86 ticks after it appears (needs one free slot); if it turns, flee to 5 | 2 | Damage | Strange fruit (464) |

## 4. Fail teleports

`[queue,macro_event_fail_teleport]` moves the player to a random tile from `macro_event_fail_teleports_members`
or `macro_event_fail_teleports_free` (`configs/macro_events_teleports.enum`). Only the genie and the gift old
man use it, after 80 ticks of being ignored. A teleport ends a speedrun route, so the handler talks to both at
once. The mime and maze teleports are part of those events; they return the player to the start tile on
completion (`%macro_event_target_coord`).

## 5. Handler design and test

- `watchRandomEvents(s)` runs on every tick of every bot from `openBot` (disable with `RANDOM_EVENTS=0`).
  `finish()` prints `EVENTS {counts}`.
- Each event becomes a job. One job runs at a time; a flight from a hostile NPC goes first.
- While a job needs the player, `busy()` is true and a gate holds the script's `s.direct` calls and queued SDK
  actions; they run when the job ends (or fail after 50 ticks). `RANDOM_EVENTS_GATE=0` turns the gate off.
- Clicks on an ent, whirlpool, gas rock or gas chest fail at once (`avoid()` lists them for scripts).
- `RANDOM_EVENTS_LAMP=<skill>` picks the lamp skill; `keep` keeps the lamp; the default is the skill with the
  most XP gained this session.
- Every action prints `EVENT <name> <action> t=<tick>`.

Unit test: `packages/core/test/randomevents.test.ts` (fake session).

Live test on a second local engine with random events on: `NODE_RANDOM_EVENTS=true` and the engine's
`World.AFK_EVENTRATE` set to 50 ticks with chance 1, on separate ports (8890). For forced events the same engine
ran with `NODE_DEBUG=true` and staff level 4 for test bots, so `::~macro_event <n>` and `::random` work. The
launcher and the skilling loop are not in the repo. The loop does not check `busy()`, so it also tests the gate.

Measured on that engine (300 ms ticks), ticks from the first sight of the event:

| Event | Result |
|---|---|
| Dryad (2 runs) | escaped in 6 and 7 ticks, one hit taken |
| River troll | escaped in 9, back at the start tile in 14, no damage |
| Swarm (4 runs) | escaped in 11-18, back in 21-29 |
| Genie (5) | talk 4 ticks; lamp rubbed on Woodcutting about 11 ticks later |
| Drunken dwarf, old man gift (10+ each) | done in 4 to 7 ticks; kebab, beer, casket, coins, gems received |
| Strange box (6) | every box solved at the first answer |
| Ent | redirected to another tree in 1 tick |
| Lost axe | fixed in 9 ticks (pick up head, reattach) |
| Maze | 17 doors, gate, shrine: returned 183 ticks after the teleport, with the rewards |

Faults the live test found and fixed:
- During an attack the client can hold the reported player tile still for 20+ ticks while the server walks the
  player. A flight no longer ends when the NPC leaves view until the position settles.
- A flight ended 17 tiles away beside aggressive Dark wizards and the bot died there. A flight now walks back to
  its start tile, and flight tiles score away from NPCs that hunt players (`loadDanger()`: huntmode
  aggressive, cowardly or ranged in the server `.npc` files).
- "Click here to continue" has server index 1, not 0.
- Every maze wall is a "Wall" with op Open, so the door index takes all 1,459 permanent walls (loc 3626) for
  doors. They are passed as blocked doors. The shrine fills its walled room; the way in is the door on the east
  edge of local (30,32).

Not solved: the mime. The job clicks the right button when it knows the emote, but the mime's emote is
seldom visible to the bot: the state showed it in 3 to 5 of about 10 cycles in two runs, and in 0 of 3 cycles in
a third. A Proxy on the lite client's `SeqType.list` saw no emote lookup either. The event needs 4 correct
answers in a row, so a bot can stay in the mime theatre for a long time. Chance per general event: 1/32.

## 6. Giant spiders at the castle river (not an event)

`giantspider1` (npc 59, `scripts/_unpack/225/all.npc`): level 2, 5 HP, `huntmode=cowardly`, `huntrange=1`,
`wanderrange=10` (so maxrange 12). `cowardly` has `check_nottoostrong=outside_wilderness`: the spider attacks a
player of combat level up to 2 x 2 = 4 (`Npc.ts:1011`), so a fresh combat-3 account is a target. Max hit 1:
strength 1 + 9, times (strengthbonus -10 + 64) = 540, (540 + 320) / 640 = 1 (`npc_combat_melee.rs2`, `combat.rs2`).

Spawns at 3243,3236 and 3245,3232 (`knowledge/npcs.json`). Both are on the east bank. Paths from 3243,3236
(rsmod): the fishing tile 3240,3242 is 8 tiles away (in reach); the willow tiles 3233,3238 and 3233,3243 need
45-50 tiles round the river (out of reach, a spider never leaves 10 tiles of its spawn); the fly spot 3239,3251
is 15 tiles (Chebyshev) from the spawn, past wander 10 + hunt 1.

Safe rule for a combat 4 or lower account on the east bank: keep more than 11 tiles (Chebyshev) from both
spawns, that is z >= 3248 for x 3232-3256. The west-bank willows are safe from the spiders.
