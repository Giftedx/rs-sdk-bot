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

## Food economics (2026-10-23, later)

Food shops near Ardougne (knowledge/shops.json, stock / restock ticks):
- bakery (east): bread 10/100, cake 3/800, chocolate slice 8/200. adventurershop: cooked meat 2/100.
- generallegends (swordfish 20/200) needs the Legends quest; upassgeneralshop (West Ardougne) needs a quest to enter.
- Brimhaven fish restaurant: herring 5/900 ... lobster 3/2600. Karamja junglestore: bread 10/500.
Sum near the market: about 12 HP of food per 100 ticks. Knights at 10 HP cost about 30 HP per 100 ticks
(practice). The live rate (about 45 XP/tick, practice 207) matches that food ceiling.

Buying lobsters (live GE ask 160) does not pay at max HP 10: a lobster then heals about 5 (eat at 5, cap 10),
so food costs about 32 coins per HP, a knight stun (3 HP) about 96 coins, and a success pays 50.

Raising Hitpoints first (`scripts/measure/hp-train.ts`, cows, sword, practice): HP 10 -> 20 in 656 ticks,
23 at 911 ticks (3.4 HP XP per tick). Costly on a board where the leader's whole run is 2,935 ticks.

Free food that scales: helper accounts that fish and cook shrimps (heal 3, no overheal waste at 10 HP)
and trade them in Ardougne. Only the specialist's playtime counts on its board.

## Full-pack food, live (2026-10-23, later)

Owner's direction: fill the pack with food before pickpocketing and refill only when it is empty.
`thieving60.ts` (commit 77a88c0) buys every food line the Baker has in stock until the pack is full.
Live result on mmthv2350: Thieving 70 -> 97 in 2,873 ticks (747,855 XP = 260 XP/tick; before: about 45),
then 97 -> 99 in 143 ticks (44 tries, 0 stuns). Thieving 99 at 1h 31m 45s playtime (about 13,760 ticks),
outside the board's top 21: most of that playtime came from the slow runs before the fix.

Forecast for a fresh account with this script: about 1,400-2,000 ticks to 55 (practice) + about 3,700 ticks
55 -> 99 at 260 XP/tick = about 5,500 ticks. Board: 7th place 5,666, 8th 7,447 (2026-10-22 snapshot).
