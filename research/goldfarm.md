# Goldfarm: knights of Ardougne

Worker: `scripts/goldfarm.ts`. Planner spots: `KNIGHT_SPOTS` in `packages/planner/src/autopilot.ts`. Server:
rs-sdk-demo.fly.dev, 400 ms ticks.

Evidence folder: `.practice/goldfarm-view/` in the main checkout. It holds the feed recordings and the scripts that
read them. The live run logs are `.practice/swarm-logs/<Account>.log`.

## Engine rules

- One knight spawns at each of 2652,3318, 2653,3300, 2669,3298 and 2671,3313 (the market) and at 2582,3297 (west).
  Each has 52 Hitpoints and a wander range of 15 tiles (`all.npc`, `knight_of_ardougne`).
- A client sees an NPC that is 15 tiles or less away on each axis (`PREFERRED_VIEW_DISTANCE`, `network/rsbuf/build.ts`).
  The state collector of the client lists each such NPC, with no limit (`bot/StateCollector.ts`, `collectNearbyNpcs`).
- A dead NPC returns after its respawn time, which the engine scales by the player count (`World.ts`, `removeNpc` and
  `scaleByPlayerCount`). Live, a dead knight is away for 32 ticks.
- A pickpocket does not hold the knight: any number of thieves pick one knight in the same tick.
- The server has a read-only feed of each player and NPC in a rectangle, tick by tick (`web/worldfeed.ts`). A move
  record holds only the steps. A reader must add them to the last tile.

## Where the ticks go

Full live runs of 9,000 ticks with the idle split in the RESULT line, by the `KNIGHT_SPOT` of the run
(`bun .practice/goldfarm-view/by-spot.ts .practice/swarm-logs`):

| Spot | Runs | Coins a tick | No knight in view | Knight rests | Click, knight far | Picks | Knights in view |
|---|---|---|---|---|---|---|---|
| 2582,3297 (west) | 5 | 11.95 | 0.0% | 1.1% | 0.7% | 25.4% | 1.02 |
| 2652,3318 | 10 | 6.71 | 28.2% | 7.6% | 4.8% | 13.6% | 0.73 |
| 2653,3300 | 11 | 6.54 | 17.2% | 10.2% | 8.2% | 12.9% | 1.03 |
| 2669,3298 | 3 | 6.92 | 11.5% | 15.9% | 8.3% | 13.6% | 1.13 |
| 2671,3313 | 10 | 7.32 | 10.4% | 13.5% | 7.6% | 14.5% | 1.13 |

The percentages are shares of the ticks of the run. The lowest share of "no knight in view" in one market run is
7.5%. Each of the 5 west runs has 0.0%.

## Causes

### 1. Players kill the market knights

- Claim: players kill the four market knights with swords, one after the other, without a stop. No player attacks
  the west knight.
- Conditions: live server. One recording of 1,022 ticks (server ticks 587475 to 588496). Two fight recordings of
  301 and 748 ticks.
- Evidence: `feed-2.ndjson` with `analyze.ts`. The four market knights were in the world for 53.0%, 55.6%, 65.6%
  and 66.2% of the ticks. They had 50 absences, each 32 ticks long, and took 477 hits. Two or fewer of the four
  were alive on 55.5% of the ticks. The west knight was in the world on each tick and took 0 hits. A mean of 51
  players stood within one tile of it.
  `fights-1.ndjson` and `fights-2.ndjson` with `fights.ts`: three players, Fc3qru1lo, Johngotti and Sammythebull,
  did each `human_sword_slash` (animation 390) at a knight: 220, 133 and 122 slashes. The knights left the feed
  50 times in those 1,049 ticks. No account of this fleet did a sword slash or a punch (`anims.ts`).
- Gap: the reason that no player attacks the west knight is not known. If a player starts, the west spot has the
  same loss.

### 2. A thief with a dead knight sees no other knight

- Claim: the "no knight in view" ticks of a market thief are the 32 ticks after the death of the knight that it
  works. The thief waits where it stands, because each live knight is more than 15 tiles away.
- Conditions: the same recording, 16 thieves of this fleet at the four market spots and 2 at the west.
- Evidence: `feed-2.ndjson` with `analyze.ts <name>=<spot>`. The output is `feed-2-report.txt`.
  - The 16 market thieves had no knight within 15 tiles on 19.3% of their ticks. One thief had 4.5% to 31.7%.
  - An unbroken wait is 32 ticks at most.
  - 81% of those ticks are in a wait that starts on the tick that a knight in view leaves the world.
  - On each of those ticks one market knight or more was alive. The nearest was at a median of 16 to 21 tiles
    from the thief, and never nearer than 16.
  - The west knight was alive on each tick. The west thieves had no knight in view on 1.7% and 4.4% of their
    ticks. On those ticks the thief was more than 15 tiles from the knight.
  - The spot 2652,3318 is the worst (30.6% to 31.7%). The other three market spawns are 18 tiles or more from it.
- Gap: the recording gives the knights that the server shows to a player at the tile of the thief. It does not read
  the client of the thief. The RESULT lines of the runs give the client view: 17.9% over the 34 market runs. The
  feed number includes the ticks of a walk, which the worker does not count as idle.

### Not a cause

- A bank trip, a stall trip or a food buy does not leave the thief away from the knights. The worker walks to its
  spot after each trip, and 81% of the ticks with no knight start at a knight death.
- The knights do not wander out of view while they live. A wait with no knight in view is 32 ticks at most, which
  is the respawn time.
- The client does not drop knights from its list. The collector has no limit, and `idleFar` and `idleUnreach` are
  0.0% at each spot.
- The count of thieves at one knight is not the cause. About 51 players stand at the west knight, and a thief
  of this fleet makes 11.95 coins a tick there.
- The accounts of this fleet do not kill the knights: none did an attack animation in the fight recordings.

## The refuge rule

`scripts/goldfarm.ts` counts the ticks of knight work that have no knight in view. When a window of 500 ticks
has 6% or more of them, the thief moves to `KNIGHT_REFUGE`. The default is 2582,3297. The thief stays there until
the run ends. One dead knight with no other knight in view is 32 ticks, so the first such death in a window moves the
thief. `KNIGHT_REFUGE=0` turns the rule off.

The log has one `REFUGE` line for the move. The RESULT line has `spot=` (the spot at the end of the run) and
`refugeAt=` (the tick of the move, -1 for no move).

- Claim: a market thief that moves to the west knight makes about 12 coins a tick in place of about 7.
- Conditions: the players that kill the market knights stay, and no player attacks the west knight.
- Evidence: the table above, 5 west runs against 34 market runs. The rule has a unit test
  (`scripts/goldfarm.test.ts`).
- Gap: no live run has the rule yet. The bench (`skiller:thieving:knights`) has one thief and no player that
  kills a knight, so it cannot show the gain. The first full live runs with `refugeAt=` above -1 show it:
  compare their coins a tick with the market rows of the table. The bank and the Baker's stall are about 70
  tiles from the west spot. The 5 west runs include that walk.

## Open losses

- The knight rests (`idleBanned`): 7.6% to 15.9% of ticks at the market, 1.1% at the west. The cause is not
  measured.
- A click near a knight gives no pick (`noopNear`): 6.9% to 9.1% of ticks at each spot. The cause is not measured.
  One part of it is known: an NPC option is reached from a side tile only. The engine's reach check
  (`reachedEntity`, rsmod `reached` with shape -2) gives true on the 4 side tiles of a 1x1 NPC and false on the 4
  corner tiles (`.practice/goldfarm-noop/reach.ts`). `scripts/goldfarm.ts` counts a corner (Chebyshev distance 1)
  as near, so a corner click spends a tick on a step. Waiting one more tick after a corner click does not help:
  bench `skiller:thieving:knights`, seeds 7, 8, 9, 1,500 ticks: 16.56, 16.67, 15.58 coins a tick before; 15.23,
  16.70, 13.47 with the wait (`noopNear` 59, 60, 71 before; 48, 49, 64 with it). Gap: a step to a side tile, or a
  choice of the knight on a side tile, is not measured.
- The planner gives each market spot four thieves and the west spot four (`KNIGHT_SHARE`). The refuge rule
  moves a thief inside its run. The spot list of the planner does not rank the west spot first.

## Measure again

```
bun .practice/goldfarm-view/record.ts .practice/goldfarm-view/feed.ndjson 15
bun .practice/goldfarm-view/analyze.ts .practice/goldfarm-view/feed.ndjson <account>=<x,z> ...
bun .practice/goldfarm-view/record-fights.ts .practice/goldfarm-view/fights.ndjson 5
bun .practice/goldfarm-view/fights.ts .practice/goldfarm-view/fights.ndjson
bun .practice/goldfarm-view/anims.ts .practice/goldfarm-view/fights.ndjson 390
bun .practice/goldfarm-view/by-spot.ts .practice/swarm-logs
```
