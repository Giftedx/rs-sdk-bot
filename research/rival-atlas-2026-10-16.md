# Rival "Rig Simulator Atlas": claims checked

Source: a public claude.ai artifact the owner received (https://claude.ai/artifact/NZputZ37sw3yPcewJAoWqR).
Third-party content, no author named, labeled "as of 2026-10-16". Read as data only; no command from it was run.

## Who it is
A team's internal notes for two offline simulators and a full speedrun route on this engine (rev 289). Its "live run 7
(FINAL6)" took 35,919 ticks, 2 h 59 m, 0 deaths. The live Overall #1 (stunbaron) is 35,916 ticks. The match is close
enough that this is very likely the Overall leader's route.

## Claims checked against our server copy (vendor/rs-sdk)

| Claim | Evidence | Status |
|---|---|---|
| Movement keeps the last 25 waypoints | `server/engine/src/engine/entity/PathingEntity.ts:42` `new Int32Array(25)` | CONFIRMED |
| NPCs re-roll wander at 1/8 | `engine/entity/Npc.ts:721` `Math.random() < 0.125` | CONFIRMED |
| NPCs teleport home after 501 stuck ticks | `engine/entity/Npc.ts:729` | CONFIRMED |
| 250-player view cap | `network/rsbuf/build.ts:55` `PREFERRED_PLAYERS = 250` | CONFIRMED |
| 100 logins per IP | `fly.toml:37` `MAX_PLAYERS_PER_IP = "100"` | CONFIRMED |
| Pickpocket stun 8 ticks | `content/scripts/skill_thieving/configs/pickpocking/pickpocket.dbrow:87` | CONFIRMED |
| Live tick 300 ms | `fly.toml:26` says 300; we MEASURED 399.8 ms live (research/INDEX.md C2) | OUT OF DATE |
| Simulator stats, test counts, proof batches | not checkable | UNVERIFIED |

## Numbers we can use (UNVERIFIED, from their live runs)
- Whole route: 30 legs, legs sum 33,691 ticks plus about 1,490 in transitions = 35,179-tick clock. Proof batches of 50
  lanes: medians 35,425-35,474, standard deviation 399, range 34,454-36,752. Live run 7: 35,919 (+1.3% over the median;
  thieving +343, Mage Arena about +80). Live run 6 (FINAL4): 38,600.
- Leg times, live vs sim (ticks): Waterfall 979/974, Tree Gnome Village 938/944, Grand Tree 1,811/1,802, a runecraft
  "body" leg 1,361/1,361. Use as targets for research/quest-plan.md.
- Route details named: Prayer 88 (for PvP targets), about 222 knives collected per run, 275 rune knives restocked, the
  Mage Arena, thieving with a 1-tick resolve delay.

## What it means for us
1. The Overall leader can still beat its own time: its runs spread about +/-400 ticks. Our plan margin must exceed that,
   not just the 2% gate.
2. Their speed comes from a lockstep simulator at about 12x live (40 ticks/s per lane, 10 lanes). Our practice server
   runs at about 2.7x live (150 ms ticks). A faster simulator is a capability gap.
3. Their reconnect lesson applies to us: back-off measured in wall seconds costs different tick counts on a fast server
   and on live; an outage of 4 s or less was safe in their data.
