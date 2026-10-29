# Live specialist runs: Thieving

Server rs-sdk-demo.fly.dev, script `scripts/generated/thieving60.ts`.

## Practice milestones (150 ms tick, 6 runs)

| Milestone | Practice tick |
|---|---|
| 60 coins | 113-210 |
| Ardougne | 499-604 |
| Thieving 40 | 962-1,388 |
| Thieving 55 | 1,437-2,053 |
| Thieving 60 | 1,589-2,484 |

On the practice server one bot has the bakery to itself. Live, the bakery's stock (bread 10, cake 3, chocolate
slice 8) runs out. The script only pickpockets when HP is above the stun damage, so with no food it waits for HP to
regenerate. Without a food supply the live rate was one try per 12.8 ticks (practice about one per 5.7).

## Food options checked

- Bakery restock (knowledge/shops.json): bread 1 per 100 ticks, cake 1 per 800, chocolate slice 1 per 200. Knights
  cost about 0.3 HP per tick (about 30 HP per 100 ticks); one bread heals 5. The shop cannot keep up even alone.
- Baker's stall (`scripts/generated/cakestall.ts`, model-written, 0/3): 1 steal per 300 ticks. A baker_merchant or
  ardougne_guard is almost always within 5 tiles (stealing.rs2:98-121); one run was hit by a guard. Not usable.
- Live GE: Lobster 258 for sale, ask 160. Swordfish, tuna, trout, salmon, cake, cooked meat: 0 for sale.
  GE stand: (3181,3443), Varrock (`vendor/rs-sdk/sdk/ge-actions.ts:9`).
- Ardougne banks: bankers at (2657,3280-3286) and (2614-2619,3330), next to the market.

Design: a helper carries lobster notes from the GE to Ardougne (boat route) and trades them to the specialist,
who banks the notes and withdraws lobsters. Only the specialist's playtime counts on its board. Food need from
Thieving 66 to 99 is roughly 110-180 lobsters (18-29k coins); knights pay 50 coins per success.

## Food economics

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

## Full-pack food, live

`thieving60.ts` (commit 77a88c0) fills the pack with food before pickpocketing and refills only when it is empty. It
buys every food line the Baker has in stock until the pack is full.
Live result on mmthv2350: Thieving 70 -> 97 in 2,873 ticks (747,855 XP = 260 XP/tick; without full-pack food about
45), then 97 -> 99 in 143 ticks (44 tries, 0 stuns).

Estimate for a fresh account with this script: about 1,400-2,000 ticks to 55 (practice) + about 3,700 ticks
55 -> 99 at 260 XP/tick = about 5,500 ticks. Board: 7th place 5,666, 8th 7,447 (`research/hiscores-live.json`).

## Fresh account on the board

`mmtha0205`, fresh, full-pack food: Thieving 99 at 6,169 script ticks, 41m 12s playtime. **Rank 9** on the live
Thieving board (8th: 37m 46s, 7th: 29m 14s, 1st: 19m 34s). Milestones: Ardougne 568, 40 at 1,295, 55 at 1,833,
70 at 2,312, 80 at 3,581, 90 at 4,942, 99 at 6,169. Totals: tries 1,224, stuns 448 (about 3,600 ticks stunned),
eaten 54, bought 44, walkTicks 611, died false.

Practice cannot show the stun-shop gain (no shop contention). Warrior women from 25 (model 1-40: 465 -> 355
ticks) and shop and eat inside the 8-tick stun are in commits 6e4af09 and later: 261 and 189 XP/tick from 66 on
practice, against 199-237 without them.
