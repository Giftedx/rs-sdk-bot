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

## Food options checked

- Bakery restock (knowledge/shops.json): bread 1 per 100 ticks, cake 1 per 800, chocolate slice 1 per 200. Knights
  cost about 0.3 HP per tick (about 30 HP per 100 ticks); one bread heals 5. The shop cannot keep up even alone.
- Baker's stall (`scripts/generated/cakestall.ts`, model-written, 0/3): 1 steal per 300 ticks. A baker_merchant or
  ardougne_guard is almost always within 5 tiles (stealing.rs2:98-121); one run was hit by a guard. Not usable.
- Live GE (2026-10-23): Lobster 258 for sale, ask 160. Swordfish, tuna, trout, salmon, cake, cooked meat: 0 for sale.
  GE stand: (3181,3443), Varrock (`vendor/rs-sdk/sdk/ge-actions.ts:9`).
- Ardougne banks: bankers at (2657,3280-3286) and (2614-2619,3330), next to the market.

Plan: a helper carries lobster notes from the GE to Ardougne (boat route) and trades them to the specialist,
who banks the notes and withdraws lobsters. Only the specialist's playtime counts on its board. Food need from
Thieving 66 to 99 is roughly 110-180 lobsters (18-29k coins); knights pay 50 coins per success.
