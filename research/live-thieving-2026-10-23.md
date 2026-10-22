# First live specialist run, 2026-10-23

Account `mmthv2350` (fresh), `DEMO_OK=1 TARGET=99 CAP=7000 bun scripts/generated/thieving60.ts mmthv2350`,
server rs-sdk-demo.fly.dev. Ended at the tick cap with a clean in-game logout, no death.

| Milestone | Live tick | Practice tick (150 ms, 6 runs) |
|---|---|---|
| tutorial skip | ok | n/a (preset starts in Lumbridge) |
| 60 coins | 497 | 113-210 |
| Ardougne | 908 | 499-604 |
| Thieving 40 | 2,255 | 962-1,388 |
| Thieving 55 | 5,018 | 1,437-2,053 |
| Thieving 60 | 5,468 | 1,589-2,484 |
| Thieving 65 | 6,069 | - |
| End | 6,996 at Thieving 66 (107,087 XP) | - |

Hiscores: Thieving 66 at 40m 39s (= 6,097 ticks at 400 ms). Rank: below every 99 on the board.

Cause of the slowdown (from the RESULT line): `tries=546` in 6,996 ticks (one per 12.8 ticks; practice about
one per 5.7), `waits=100`, last failure `buy:out_of_stock:Bread is out of stock`, HP 2 at the end. The script only
pickpockets when HP is above the stun damage, so with no bread it waits for HP to regenerate. On the practice
server one bot has the bakery to itself; live, the bakery's stock (bread 10, cake 3, chocolate slice 8) runs out.

Next fix: a food supply that does not depend on one shop's stock. Options: bring food from the start, a helper
that trades food, or a second food source in Ardougne.
