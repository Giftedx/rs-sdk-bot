> Authority: all gameplay techniques are authorized. Wine, cocktails, pyre oil, Charge, relogs and tick manipulation need no further approval. Missing supplies create acquisition work, never a route exclusion. Model totals below that assume a technique restriction do not apply. See [AGENTS.md](../AGENTS.md).

> Correction: the Almera “10 grapes” entry below is the Waterfall raft location, not an item spawn. Use [grape-gold.md](grape-gold.md) for that source. Quantities and prices below are research values, not current stock or quotes. GE is authorized; reprice proposals before use. The grape-dependent schedule is invalid; do not use its ETA.

**New consumer enrolment:** wait for fresh `waiting-for-food`, bank observation from this run and bank-distance ≤3 before adding courier demand. Fresh bank data alone races receiver readiness (zero-transfer failure: `.practice/fleet-expansion/first-delivery-attempt.json`). Two live deliveries after the wait each reconciled160 sender debit=recipient credit; pilots returned to bank. `.practice/fleet-expansion/attach-ready.ts` checks enrolment; it is not a general runtime readiness fix. Promote the Thieving55-qualified earner after clean bootstrap handover; bootstrap60 timed out live and is failed. Food purchase cost is unknown.


The coordinator plans Overall supplies from the route bill's demand and the latest available helper observations. A recent balance uses the status time for pack and worn items, and the original bank observation time for bank items. The planner lists older or undated holdings for verification, observed shortfalls separately, and unresolved item names separately. Neither a recent balance nor a route bill assigns or reserves stock.

Source -> local consumer -> adapt -> check: the bank observation time in status, the preparation report's five-minute window, and Microbot's bank freshness pattern in the project use map -> the coordinator's supply summary -> preserve bank time through fleet sync and keep unverified holdings visible -> a planner test reads local and published snapshots with recent, stale and absent bank times. A read-only live-data comparison is in `.practice/planner-supply-freshness/summary.json`. A verified balance still needs a transfer and consumer receipt.

Source -> local consumer -> reuse -> check: the status producer's equipment observation flag, the route preparation reader, and Iron Compass's explicit requirement facts in the project use map -> preparation unlock facts -> leave unobserved equipment unknown and reject bank or journal evidence dated after its status row -> the preparation fixture checks observed empty equipment, unknown equipment, a known bank alternative and date order. The read-only replay in `.practice/goal-readiness-observations/replay.json` compares retained status rows at their observation times and at replay time.

Source -> local consumer -> reuse -> check: the pinned item catalog and the measured Ranged preset's black dragonhide IDs -> Overall supplies, planner, dashboard and launch staging -> split the cannon and ranged kit into eight pinned item IDs -> fixtures reject a different colour with the same display name, and the CLI readback in `.practice/exact-overall-kit/readback.json` checks the bill and preparation report. The IDs are procurement requirements. They need bank and transfer evidence for staging.

Source -> local consumer -> reuse -> check: the route bill's selected Overall schedule and Autopilot's current demand calculation -> coordinator planning prompt -> compute the same current requirements and report the hiscore observation time separately -> a fixture leaves a legacy bill beside the current input and verifies the planner uses the route. If the route is unavailable, the live prompt has no supply bill. Saved bills remain readable for historical inspection.

Source -> local consumer -> reuse -> check: the preparation report's overlap rule and the separate status and bank observation times -> route supply bill, Autopilot demand and coordinator assets -> take the larger count of carried or banked stock per account and base item -> a fixture covers noted stock, pack and equipment, and a second holder. The same-input replay in `.practice/supply-snapshot-overlap/verified.json` shows where separate observations leave demand uncovered. It does not establish exact current ownership.


The Overall supply bill, Autopilot demand, preparation report, dashboard and launch manifest use the route rows that start before the modeled last 99. The full route remains available for later quest, gear and bank goals. If the model has no Overall finish, it cannot produce an Overall supply bill.

Source -> local consumer -> reuse -> check: the route scheduler's selected variants and last-99 tick, plus the launch gate's start-time boundary -> all Overall supply consumers -> apply the existing requirement tally to the scheduled prefix -> test a row that straddles the finish, a later producer and an unchosen variant. The isolated bill and preparation runs are compared in `.practice/overall-route-supply-scope/scope-proof.json`. The comparison proves bill scope on the modeled route. It does not establish staged items or launch readiness.

The supply bill adds demands with the same resolved base item IDs before checking stock. It preserves the alternate labels for planning and reports partly overlapping matches as unresolved. A combined count covers base stock. The handoff still needs to verify the form each consumer needs.

Source -> local consumer -> adapt -> check: the planner's pinned item resolver and the shared-stock accounting pattern in Iron Compass from the project use map -> supply bill, coordinator and Autopilot -> combine demand before assigning a stock balance -> regressions for 1,200 units of demand against 600 owned, an overlapping match, and a cached bill round trip. These checks do not reserve or transfer stock.

## Market policy (current)

Owner decision: use GE for progression and wealth whenever it beats other sources. Account ownership and evidence requirements still apply.

- **Choose the source:** compare owned stock, GE, NPC shop, spawn, gathering, crafting and reachable drops. Include cash, travel/delivery, supplies, competition, failure risk, fill delay and useful XP/unlocks. Value saved ticks using a measured alternative rate; unknown rates stay unknown. An urgent unlock can justify paying more.
- **Use this server's data:** refresh bid/ask and listed quantities before orders; compare completed prices, quantities and trade counts across 1/7/30 days, with hourly/daily history and observation age. Missing history is unknown. Listed quantity is not depth at the best price; volume is units, trades are matched fills, not unique traders. Base price, one tiny trade and unrealised inventory value do not prove fair value or profit.
- **Buy now:** a needed item at a justified executable price gets a capped purchase, with return/delivery costs reserved. Do not grind merely because the old route gathered it. No asks means no demonstrated immediate supply.
- **Wait:** nonurgent demand, poor value or expensive items/orders over10m default to bounded low bids. Over10m is a value/urgency review threshold, not a ban. Set quantity, limit price, total commitment, review time, deadline and alternative source. Do not chase every rival bid or idle online waiting.
- **Merchandise:** seek spreads, mispricing, predictable repricing and supply gaps using real fills. Sell genuine surplus; reserve quest, equipment and production stock first. Start with a small affordable lot; scale only after realised after-tax profit and repeat fills. Price impact and competitors' response are uncertain; a quoted spread is not a guaranteed exit or proof of market control. Self-matched volume cannot validate demand.
- **Protect working capital:** name a buyer/seller, goal, cash reserve, maximum exposure/loss and exit for each strategy. Escrow and unsold stock consume capital. Pending orders are not acquired supplies; accepted offers are not fills. Reconcile cash/items through offer ID, partial fill, cancellation, refund, collection and bank/delivery. Inspect unknown outcomes before retrying.

Reuse `vendor/rs-sdk/sdk/{market.ts,MARKET.md}`, `scripts/market-snapshot.ts` and the existing GE actions. Public reads need no account login. Native GE qualification must include partial fill/cancel/collect/reconnect; then a bounded live pilot. Practice proves mechanics, not live liquidity. Current pinned workers are not automatically GE-capable just because policy changed.

**Native qualification:** existing SDK actions passed [unfilled cancel/refund](../.practice/ge-qualification/native-receipt.json) and [partial fill/reconnect/collect](../.practice/ge-qualification/fill-proof.json). Buyer escrow240 → items2 + refund40; seller gross200 → tax10 + proceeds190; cancelled remainder1 returned. Both slots clear. Reuse offer IDs and matched pack deltas; assert cumulative sell tax `floor(gross/20)`, not per-fill rounding. Local isolated market only: live liquidity, bank entry/return, delivery and uncertain-dispatch recovery remain unproved.

Pinned GE mechanics: six slots;5% seller fee; offline matching; orders have no automatic expiry. Cancelled remainder becomes collectible escrow, not carried cash. Thus set review deadlines in our controller, keep persistent offer IDs, collect before reusing slots, and price the fee/rounding into every resale. Reconfirm these rules from live receipts; do not substitute OSRS rules.

[Live check](../.practice/market-policy/live.json): GE enabled. Eight checked items had no asks. Seven-day lobster volume4,070/124 fills; steel bars82,800/210 fills. Rune sword had one40,000gp trade: too thin to establish fair value. Sword availability remains open; consider patient bids and broader weapon alternatives. No orders placed by this check.

[Broader check](../.practice/market-policy/opportunities.json): adamant scimitar ask47,500, four listed, seven fills/7days; candidate to unblock combat after weapon/delivery qualification, not an automatic purchase. Coal ask485 and iron ore151 reopen buy-versus-mine comparisons; OreElse already owns iron, so do not buy duplicate stock. Lobster1-day VWAP294.85 versus30-day232.00 shows why an old average alone is a poor urgent-buy limit. Quotes are dated, depth at ask unknown. Next: qualify GE receipts/restart; reprice gear and named supplies; test small merchant lots only with an actual executable exit.

**Shop to bid.** Claim: some live buy offers stand far above the NPC shop price, and a sale fills at once against them. Fishing bait: bid 218 for about 35,000 units against a shop base of 3; the Port Sarim fishing shop (Gerrant) holds 1,500 and restocks 1 a tick. Conditions: `scripts/shop-to-bid.ts <bot> <profile> <itemIds>` buys from a `shop-buyer.ts` profile (5 shop packets a tick, the server's user-packet limit), walks to Varrock West and sells with `runOwnedSale`; `--scan` lists every profile item whose bid clears `MIN_NET`. Shop prices rise as stock falls, so the run stops an item when its last chunk does not clear `MIN_NET`. Evidence (live pilot observations, Abracadickra, comments on PR 887; each from a full shelf, on a different script version and start, so not matched runs): three 1,500-bait lots gave +287,905 in 603 ticks, +287,909 in 673 ticks and +287,865 in 536 ticks; one Betty lot (chaos, body, mind, water and earth runes) gave +60,218 in 566 ticks, each rune stopping after 250 to 500 units, with no death runes on the shelf. Gap: no matched rate exists, so the comparison with goldfarm (about 10.76 coins a tick) is unqualified; a repeated lot runs on the restock (1 bait a tick), not a full shelf, and is not measured; each bid is finite (the bait bid is worth about 6.7 million coins); the bidders are unknown; no swarm job runs the route.

## Combat weapon source

The [market refresh](../.practice/ge-qualification/quote-1793057494187/market.json) has no Adamant scimitar1331asks. Rune sword1289asks90,000,with one40,000trade. No live order or spend occurred. A pending bid needs a qualified persistent offer,review/deadline,cancellation,collection and delivery path. Neither old price nor native seeded stock proves availability.

[Source decision](../.practice/ge-qualification/scimitar/source-decision.json):pinned rs-sdk `b565f2d9` scimitar config/obj pack and local `fireHomeEntryPoints` → existing Fire combat preparation → adapt normal1331selection and reuse known-bank validation. Reject a new combat framework. MIT notices remain. The path requires fresh bank generation,owned withdrawals,equipment effects,full healing and16departure Salmon. Dungeon recovery guards remain.

[Installed qualification](../.practice/ge-qualification/scimitar/release/qualified.json):15focused checks,root typecheck and one full canonical native route pass. Hypothetical1331was added to the actual Mightyrod profile. The run equipped1331,credited one Fire110corpse,banked one herb201and bone532,used4Salmon for initial healing,and retained other assets. Fight94ticks,total532,minimumHP44,final69,clean logout. Separate CRC-save accounting confirms stock. This is one native observation,not live ownership or a comparative rate. Mightyrod block1792955012008 remains. Live procurement,delivery,kill and repeat proof are still required.

### Rune scimitars from our own runite

- **Claim.** A side with a Smithing 90 account makes rune scimitars from banked runite ore and coal with two existing
  routes: `scripts/smelt-bars.ts <account> <cap> runite` at Al Kharid, then the anvil order `ORDER_ACTION=smith
  PRODUCT_ID=1333` at the Varrock West anvils. A bar takes one runite ore and 8 coal; a blade takes 2 bars and a hammer.
- **Conditions.** Practice, one account, Smithing 99, at the Al Kharid bank with 12 runite ore, 96 coal, a hammer and
  5,000 coins: 12 bars in 198 ticks (`RESULT ok`, exact order), then 6 scimitars in 463 ticks, 337 of them the walk
  through the toll gate (10 coins) to Varrock West (`RESULT ok`). The planner offers both as pilot routes,
  `aio-runite-bars` and `aio-rune-scimitars`, to a plan whose `aio` list names them. The trooper trainer already
  wields the best owned scimitar for the Attack level (`selectGiantWeapon`).
- **Evidence.** `.practice/gear/chain.ts` (`chain-a.out`, `smelt-a.log`, `smith-a.log`);
  `packages/planner/test/autopilot.test.ts` (a smith with runite ore and coal).
- **Gap.** One practice run; no live run. The local side's snapshot shows a Smithing 99 account with 13 runite ore
  and a Mining 99 account with 57, and no coal: 28 bars for 14 blades need 224. Delivery to another side is a fleet
  order per blade and is not run.

### Owned GE consumer

[Source/reuse decision](../.practice/ge-qualification/owned-item/source-decision.json):reuse pinned SDK transactions,observed bank deposits and the earlier GE fill fixture. Existing private order IDs and persistent intent survive logout;pending bids are not stock. The installed `scripts/buy-owned-ge-item.ts` handles one item with a cap,reserve,review/deadline and no automatic retry of unknown mutations. [Releasecba6a021](../.practice/ge-qualification/owned-item/release/qualified.json):19focused tests/46assertions,root/fixture typechecks and nine installed native stages pass. A separate [raw CRC audit](../.practice/ge-qualification/owned-item/native-recovery-1793068865429/independent-audit.json) confirms saved assets,health and logout.

[Installed recovery proof](../.practice/ge-qualification/owned-item/native-recovery-1793068865429/proof.json):never-applied placement refuses and replay sends no second order;lost SDK responses after real placement and collection reconcile by offer ID and exact asset changes. Settled replay credits zero new items/cash. A separate1287order expires while offline,then cancels and refunds45,000despite injected missing cancel/collect responses. Unknown mutations report `escrow:null`,maximum exposure45,000,not a fabricated asset. These are deliberate SDK-response injections over actual native game effects,not spontaneous network failures. Buyer coins50,015→5,015 plus one normal1331banked;seller42,750;expiry actor50,015restored. Gold bars and HP retained,clean logout. MM bytes and account holds are unchanged from parentb77b9247.

Pinned `MarketStore.place` and `market.test.ts::incoming sell receives higher resting bid` set the fixture expectation:an older45,000bid filled by a later40,000ask costs45,000;seller receives42,750,tax2,250. A lower incoming ask does not prove price improvement. Engine source hashes join the worker/runtime binding. Qualification at cba6 covers no live funding,order,collection or delivery. It clears no combat hold. A published pin permits qualification-aware starts;it does not activate workers.

**Funding route and live result:** [reuse decision](../.practice/ge-funding/source-decision.json):adapt `fleet-relocate.ts` Draynor/East waypoints,`buy-owned-sword.ts` East/West approach and `relocate-knight.ts` bank/assets/XP/life guards into `scripts/relocate-bank.ts`. Native routes near a bear and near dark wizards stop on HP loss and pay out nothing. A [read-only native planner probe](../.practice/ge-funding/probe-1793069844010/plans.json) found an incomplete3243,3380endpoint,followed by a western detour. Standalone cache modelling missed it. `look=6` means tiles,not waypoints. The endpoint guard now rejects partial plans before travel. An eastern approach has seven complete native-planned legs outside that dark-wizard area.7focused tests/29assertions,root/fixture typechecks and [installed native route/payout](../.practice/ge-funding/native-1793070177412/proof.json) pass;separate CRC/XP audit agrees. Seeded route388ticks,HP27;not a general low-combat route or comparative speed proof.

[Release74d57f78](../.practice/ge-funding/release/qualified.json) adds only that relocation runtime to parentcba6a021. [Live chain](../.practice/ge-funding/live-1793070395422/proof.json):Pocketrocket→Bigpackage32,000,existing ferry to Draynor,new land leg465ticks,Bigpackage→Abracadickra32,000. Two paired receipts and raw deposits [audit independently](../.practice/ge-funding/live-1793070395422/independent-audit.json). Buyer50,047banked,courier362plus52food notes at Westbank,donor6,681,990;60fare coins,all other assets/gear/XP/HP retained,six clean logouts. This is internal capital movement,not income. [Fresh quote](../.practice/ge-qualification/quote-1793069097598/market.json):no1331asks;Rune sword90,000remains unqualified. The live GE lifecycle is below;item collection,delivery and the combat hold remain open. Current food stock and allocation gap are in food-chain.md.

### In-process GE HTTP origin

Defect found by a funded live pilot ([result](../.practice/ge-qualification/owned-item/live-1793071254528/proof.json): SDK GE entry unavailable,no order placed,coins re-banked):`connectInProcess` constructed the shim's SDK without its game origin;`GEActions.open`→`getGEAvailability`→`MarketClient(buildClientUrl()).status` therefore queried localhost. Native practice hides the defect because its game origin is localhost. Existing SDK market guidance requires the game HTTP origin;no upstream code was copied.

Reuse decision:`sdk/index.ts` four market helpers and `market.ts` origin handling → `packages/core/src/inprocess.ts` SDK construction → adapt with typed `inProcessSdkConfig` and existing `isLocalServer`;reject replacing the SDK or adding a market transport. All four HTTP reads use the configured game origin. Browser launch/reconnect remain disabled;shim actions are unchanged.11focused tests/72assertions,root typecheck,actual [no-login remote read](../.practice/ge-origin/remote-read-proof.json),nine native recovery stages and [raw CRC audit](../.practice/ge-qualification/owned-item/native-recovery-1793071520411/independent-audit.json) pass. [Released87aaa15](../.practice/ge-origin/qualified.json) changes only that runtime file from74d57f78.

[Live pilot](../.practice/ge-qualification/owned-item/live-1793071725598/proof.json) placed offer50659:one1331bid at45,000,5,047banked,HP10/logout retained. [Five-minute review](../.practice/ge-origin/review-1793072032097/proof.json) retained the same open offer with zero new cash/items. The [deadline run](../.practice/ge-origin/review-1793072651917/proof.json) canceled the unfilled order and banked45,000refund:buyer50,047coins,zero acquired/spent/escrow. [Independent lifecycle audit](../.practice/ge-origin/order-audit.json) matches the same ID,bank deposit and full asset balance. Dispatch began25,688ms after the03:43:46UTC deadline;refund was observed48,227ms after. This timing miss is retained,not an on-time claim. No replacement order or weapon delivery. The pilot proves live entry/placement/review/cancel/refund,not liquidity or procurement success. Next:choose a gear source from fresh evidence rather than repeat an empty pilot. Returned food is reconciled in [food-chain](food-chain.md#supply-recovery).

## Owned iron ammunition: live batch

OreElse owns90 banked iron arrowtips40 from the live six-bar proof. Bigchopper's bank holds390 headless arrows53 and Fletching42 at Varrock East bank. Use this closer assembler; preserve Shaftmaker's195 and both fresh specialist clocks. These90 arrows are one supply batch, not full Ranged readiness.

Source decision: `rs2b2t/rs2b0t@6e747f8bda494d9f75365b5533cf758d353dcc3b`, `BankFletcherLogic.ts::attachPlanFor`, `BankFletcher.ts::InstantAttach.execute` and bank-readiness tests → local bounded `fletch-arrows.ts` → adapt iron recipe selection; reject accepting input debits without product, packet bursts and name-only item identity. MIT inspected; no upstream code copied. Pinned `skill_fletching/configs/arrows/arrows.dbrow` and `scripts/arrows.rs2` confirm current-level15, batches15 and product884. Sources, immutable originals and decision: `.practice/ammo-assembly/source.json`.

Candidate stays under `.practice/ammo-assembly/candidate`; live runtime pin remains `18c7d0fb392aa46943fe79c5de9b263f2e1a10b49e8b0c9b2dfe75a81d4bcd0d`. Native local150ms/25x, seeded inputs:90 arrows banked,300 headless retained,90 tips consumed,5,625 XP gained, held quest kit and HP15 preserved, clean logout (`native-proof.json`, exact candidate SHA-256). This does not prove transfer or live assembly.67 fake-session checks across four files cover steel compatibility, iron level/stock/reserves, unknown bank, debits without output, food/item handoff separation, lost replies and races (`candidate-checks.log`).

**Integration qualification:** existing `handoff-inputs.ts` / banker / receiver now have staged opt-in `HANDOFF_ORDER` and `HANDOFF_ITEM_ID`. Default legacy behavior remains; ordered mode uses durable paired item receipts, one transfer attempt and pre-login refusal of a completed order. Native `transfer-native-proof.json`: matched90-tip transfer from West→East bank, recipient bank credit90, then same actor banked90 arrows with300 headless; unrelated inventory/equipment/bank totals and health retained. A duplicate order refused before login/donor start.89 focused checks and candidate typecheck pass; exact hashes and independent asset review are in `.practice/ammo-assembly/qualification.json`. No live transfer claim.

`PlayerLoading.load` prefers the durable `MarketStore.saved` checkpoint over a preset file. Native fixtures seed before first authentication and check saved entry positions/health before transfer. This is a fixture correction, not a game-recovery bypass.

**Release/live:** all eight finite earners banked217,050 gross coins and logged out before installation (`drain-returns.json`). The only remaining child of controller432 was its console host; no bot remained. Installed the existing banker/receiver order integration, shared item-policy factory, finite iron mode and focused tests.124 checks, global typecheck and exact installed-file native transfer/assembly/restart passed. Qualified pin `4941e6afbdddbfe8ca5f9f09476dd9c3b4fc600647aa9e7f0534c0bb45ef784b`; controller27228 restored all original earning/courier repeat flags. Protected block epochs remain unchanged.

Live OreElse→Bigchopper: exact90 tips40 moved with matched debit/credit; receiver bank gained90. Same actor then made/banked90 iron arrows884 in34 ticks, gained5,625 XP and kept300 headless, all other fresh pre/post pack/bank assets and HP15; logout (`.practice/ammo-assembly/live/proof.json`). No specialist logged in. The food-only validator rejects the iron receipt (`proof-before-policy-fix.json`); the strict iron-policy reconciliation accepts it. That separation is a regression criterion. This is one bounded supply batch, not full Ranged readiness, unattended production or a rate comparison.

Next consumer: goal executor. Bigchopper at Eastbank has shortbow1, iron arrows90 and headless300: qualify native Ranged entry, useful XP, supply use, return/bank and logout before touching Shaftshooter's fresh clock; alternate Arrav walking/sustain remains its quest dependency. OreElse at Eastbank has684 iron ore and shortbow1: qualify the existing smelting path and only make further ammo against measured demand. Both completed workers are disabled; eight earning repeats stay active. Source/pin activation and asset proof are recorded in `.practice/ammo-assembly/activation.json` and `release-qualified.json`.

# Supply logistics for the Haggis run

**Owned sword procurement:** `scripts/buy-owned-sword.ts` shares Eastbank cash deposit/transit and Westbank purchase/return. Match bank credits, settle each waypoint, accept arbitrary conserved food, skip already-reached targets; production expiry must retain the cleanup budget. Native purchase and cap-expiry proofs: `.practice/sword-repair/reusable/{integrated,expiry}-native-proof.json`. Live shelf was empty:0 spent,18,047 coins banked, no damage, logout at Westbank (`release/live-proof.json` there). Stay offline; next start uses Westbank mode, not `PREPARE_EAST=1`. Local stock config has2 swords and12000-tick restock (`area_varrock/configs/varrock.inv:68`, engine `World.ts` stock loop); live availability and contention remain unknown. Do not replace that gap with repeated trips. Delivery/combat still need proof.

**Alternative:** same shop sells adamant longsword1301 (base3,200; default stock1; restock12000 ticks, `varrock.inv:74`). Candidate combat fallback adds that owned item after sword1287. One native saved-state trial:1 credited kill,131 fight/584 total ticks, loot banked,4 salmon for initial healing, no death, assets conserved (`.practice/joined-plan/combat-longsword/proof.json`). Seeded weapon/bank start; not acquisition or comparative-rate proof. No stronger spare or Smithing74 account was observed in configured helper snapshots; old banks remain unknown. Buyer candidate now accepts these two exact stock/price profiles:15 offline checks; native longsword purchase3,200 leaving14,847; cap25 returns all18,047 with0 spend (`.practice/sword-repair/longsword/qualification.json`). Receipt includes selected item ID. Installed with the combat fallback (`.practice/sword-repair/longsword/release/activation.json`). Live longsword shelf was also empty;0 spent,18,047 coins conserved at Westbank (`release/live-proof.json`). Do not make another blind single-item trip. Next: broader dated stock observation or a qualified non-shop source; the local12000-tick restock estimate is not live availability. `SWORD_ITEM=1301 MAX_SPEND=4000`, Westbank mode. Do not patch running workers or clear Mightyrod's block yet.

Gate 3 of `scripts/haggis-gate.ts` ("supplies staged") needs every item that the main account uses, held by a
helper at the right place before Haggis logs in. This file lists the items, the cheapest legal source of each,
the helper job that gets it, and the gold and helper-hours in total.

Evidence levels:

- **MEASURED live**: `research/market-2026-10-23.json` (snapshot 06:53Z) and 6 read-only GETs to
  `/api/market/items/<id>` at 12:25Z (jug_empty, lobster, rune_arrow, unicorn_horn, chocolate_bar,
  blue_dragon_scale).
- **MEASURED practice**: rates from `research/supply-floors.md`, `research/gathering-tricks.md`,
  `research/board-ranking-honest.md`.
- **CODE-READ**: rev 289 content (`vendor/rs-sdk/server/content`), `knowledge/*.json`,
  `knowledge/ubermouse/world.json`.
- **ESTIMATE**: every rate, time and coin total that no run measured. Each one says what it rests on.

Content-bug methods are out: login wine, Charge spam, cocktails and pyre oil without a level check.

## Summary

1. **Four manifest lines have no legal source at the scale the planner asks for (CODE-READ).** The planner's
   exact manifest cannot pass gate 3. These lines need a planner change before staging starts:
   - **Torstol, 176.** The only source in rev 289 is the Yanille agility dungeon chest. It gives 1 torstol per
     sinister key (`areas/area_yanille/scripts/agility_dungeon.rs2:103-120`). The key drops from Salarin the
     Twisted at 10/128 (`drop tables/scripts/salarin_the_twisted.rs2:17,45-46`). That is about 2,250 Salarin
     kills. `randomherb` has no torstol, toadflax or snapdragon (`drop tables/scripts/shared_droptables.rs2:2-34`).
   - **Snapdragon 6 and toadflax 2.** No drop, shop, spawn or chest gives them. The only hits are the skill guide
     and the agility arena text (`grep` over `scripts/`).
   - **Uncut dragonstone, 305 for Crafting, plus 453 for the dragonstone amulets of the Magic band.** The only
     source is the Taverley crystal chest, 1 per crystal key (`areas/area_taverly/scripts/crystal_chest.rs2:24`).
     A key needs two key halves, and each half is 1/128 of the `randomjewel` roll (`shared_droptables.rs2:58-65`).
     The GE has 0 sellers and 100 bid at 1,000,000 (MEASURED live).
   - **Cosmic runes, 546.** One shop holds 20 (Mage Arena, restock 1 per 100 ticks). The GE has 1 seller at
     10,000 (MEASURED live). Lvl-5 enchant needs the dragonstone amulets anyway, so this line goes when the
     Magic method changes.
2. **Rune dart tips (1,520) have no seller and no shop.** Smithing them needs runite bars, Smithing 89 and
   Tourist Trap (`research/supply-costs.md:47-49`). Rune arrows give the same XP per action (4,687.5 against 4,700,
   `supply-floors.md:88-89`). Replace the dart band with rune arrows. The cost is 2,280 more rune arrowtips from
   2 shops, about 6.3 hours of restock. The rune arrows that the main makes also cover the 850 Ranged arrows.
3. **The critical path is not the main clock.** Gate 3 needs every item staged before tick 0. So the longest
   lead time decides the staging date, not the tick at which the main uses the item. The longest jobs are the
   rune arrowtip restock (6.3 h), the herb kills for the replacement Herblore plan (about 5 h with 2 accounts),
   the mithril, adamant and coal mining (about 4.5 h with 2 accounts), and gold (about 5.6 h of farming).
4. **Totals (ESTIMATE).** About 62 helper-hours. About 5.0M coins, against 1.1M held. The gap is 3.9M, which is
   about 5.6 h of the gold farm at 700k per hour. The earliest full staging of the substituted manifest is about
   **7 h** after 11 accounts start, if the shops and spawns have no competition.
   Allow 11 h from the start for hand-offs to the staging points.
   Dragon bones by GE purchase over time move this to about 7 days after the start. Dragon bones by kills need a combat
   helper that has the anti-dragon shield (not verified how).
5. **Rejected grape-gold lever.** The alleged Almera x10 spawn is the Waterfall raft. Its 1,125-grapes/hour and 1.1M-coins/hour estimates are invalid. See [grape-gold.md](grape-gold.md). Player-market sales are also outside current policy.

## 1. Manifest

Source: `bun packages/planner/src/haggis-cli.ts research/hiscores-live.json --levers --supplies` (scenario a, the
realistic supply list) and `--order` (scenario a, realistic start ticks). The three scenarios print the same
supply list. Counts are CODE-READ from the planner. "Needed at" is the start tick of the first activity that uses
the item, on the main clock. "Trade 1" is the trade at tick 10.

### Early boards (Trade 1 to tick 3,055)

| Item | Count | Activity | Needed at |
|---|---|---|---|
| bronze arrowtips | 60 | Fletching (row 7) | Trade 1, tick 10 |
| headless arrows | 1,290 | Fletching | 10 |
| iron arrowtips | 45 | Fletching | 10 |
| iron dart tips | 40 | Fletching | 10 |
| feathers | 2,360 | Fletching (darts) and fly fishing | 10 |
| steel arrowtips | 135 | Fletching | 10 |
| mithril arrowtips | 240 | Fletching | 10 |
| adamant arrowtips | 495 | Fletching | 10 |
| rune arrowtips | 315 | Fletching | 10 |
| rune dart tips | 1,520 | Fletching | 10 |
| unfermented wine (noted) | 600 | Cooking wine timer (rows 5-6) | 10 |
| grapes, jug of water | 1 each | Cooking: the one hand-made wine | 10 |
| egg, bucket of milk, pot of flour | 1 each | Cook's Assistant (row 3) | 10 |
| uncooked stew 3, raw shrimps 2, coins 10 | - | Cooking 30 to 35 (row 4), toll gate | 10 |
| chisel | 1 | Crafting (row 8) | 206 |
| uncut opal 5, jade 2, red topaz 2, sapphire 3, emerald 3, ruby 5, diamond 11 | 31 | Crafting 1-55 | 206 |
| uncut dragonstone | 305 | Crafting 55-99 | 206 |
| unfinished potions: guam 1, marrentill 1, tarromin 2, harralander 3, ranarr 7, toadflax 2, irit 5, avantoe 6, kwuarm 12, snapdragon 6, cadantine 7, lantadyme 15, dwarf weed 13 | 80 | Herblore (row 9) | 401 |
| torstol potion (unf) | 176 | Herblore 78-99 | 401 |
| secondaries: eye of newt 4, unicorn horn dust 3, limpwurt 9, red spiders' eggs 7, chocolate dust 2, white berries 9, toad's legs 2, snape grass 7, mort myre fungus 4, dragon scale dust 13, wine of zamorak 13, potato cactus 7 | 80 | Herblore | 401 |
| jangerberries | 176 | Herblore 78-99 | 401 |
| logs 27, oak 4, willow 7, maple 13, yew 25, magic 107 | 183 | Firemaking (row 11) | 647 |
| tinderbox | 1 | Firemaking | 647 |
| dragon bones | 560 | Prayer 31 (row 12, a few bones), rest row 24 | 1,427 (few) / 19,814 (rest) |
| bronze 34, iron 35, steel 95, mithril 280, adamantite 345 bars | 789 | Smithing (row 13) | 1,590 |
| hammer | 1 | Smithing | 1,590 |
| rune essence | 4,213 | Runecraft (row 14) | 3,055 |
| air, fire, body, nature, law talismans | 1 each | Runecraft | 3,055 |

### Late boards (tick 5,117 and later)

| Item | Count | Activity | Needed at |
|---|---|---|---|
| lobster | 610 | Food for quests and combat (rows 15-37) | 5,117 |
| rune armour set | 1 | Combat (Monkey Madness row 20, melee rows 29-33) | 11,023 |
| air 86, mind 5, cosmic 546, water 6,807, fire 80, earth 7,175 runes | 14,699 | Enchant jewellery (row 22) | 16,195 |
| sapphire rings 12, emerald rings 27, ruby rings 16, diamond rings 38, dragonstone amulets 453 | 546 | Enchant jewellery | 16,195 |
| rune axe, knife 2 | - | 3-tick woodcutting (row 23) | 19,814 |
| fly fishing rod, lobster pot, harpoon | 1 each | Fishing (row 26) | 24,477 |
| rune pickaxe | 1 | Mining (row 28) | 29,049 |
| anti-dragon shield (quest) | 1 | Dragon Slayer (row 43) | 51,761 |
| cannon (base, stand, barrels, furnace) | 1 | Ranged (row 32) | 33,991 |
| cannonballs | 1,700 | Ranged | 33,991 |
| rune arrows 850, magic shortbow, yew shortbow | - | Ranged | 33,991 |
| black d'hide body, chaps, vambraces; coif | 1 set | Ranged | 33,991 |
| best-in-slot worn set | 1 | Equipment (row 48) | 105,240 |
| coins and high-value items above the #1 bank | 1 | Bank (row 49) | 105,299 |

### Proposed substitutions (the manifest that can pass gate 3)

| Planner line | Replace with | Effect on the main (ESTIMATE) | Evidence |
|---|---|---|---|
| rune dart tips 1,520 + 1,520 feathers | 2,280 rune arrowtips + 2,280 headless arrows (152 actions of 15) | Same XP per action, same 5 per tick. Fletching stays at 49 ticks. The 2,595 rune arrows cover the 850 Ranged arrows | CODE-READ `darts.dbrow`, `arrows.dbrow` via `supply-floors.md:78-108` |
| iron dart tips 40 (band 22-30) | 60 iron arrowtips + 60 headless arrows (4 actions) | 937.5 against 950 XP per action. The same 4 actions | CODE-READ `supply-floors.md:83-84` |
| torstol 176, jangerberries 176, snapdragon 6, toadflax 2 | Herbs from `randomherb` drops, each made into its best potion with a secondary that exists at scale (below) | About 1,080 potions instead of about 420. Herblore rises from 246 to about 630 ticks, against #1 447. **The board loses** | CODE-READ drop tables + ESTIMATE |
| uncut dragonstone 305 | uncut diamonds, 354 for 55-99 (2,687.5 XP each), GE purchase over time | About +35 main ticks. Crafting rises from 194 to about 230 against #1 197. **The board loses** | MEASURED live (diamond 592 trades in 7 days) + ESTIMATE |
| 546 jewellery items and 546 cosmic runes (Magic) | Teleports with law runes, the route in `supply-costs.md:39`: 722 law runes from 45 | Cast rate not measured. Magic is already late by 18,129 in the run | CODE-READ + MEASURED live (laws: 423 sellers at 2,697) |

Herblore replacement detail (CODE-READ `shared_droptables.rs2:2-34`, XP from `supply-floors.md:145-166`):

- Use 6 herbs: guam (32/128 of drops, attack potion with eye of newt, 625 XP), harralander (14/128, restore with
  red spiders' eggs, 1,562.5), ranarr (11/128, prayer with snape grass, 2,187.5), irit (8/128, super attack with
  eye of newt, 2,500), avantoe (6/128, fishing with snape grass, 2,812.5), kwuarm (5/128, super strength with
  limpwurt, 3,125).
- That is 925 XP per herb drop on average. Herblore 3 to 99 is 998,291 XP, so about 1,080 herb drops.
- Chaos druids give 0.445 herb rolls per kill (0.2734 + 0.0859 + 0.0859, `knowledge/drops.json` `chaos_druid`).
  So about 2,420 kills.
- Secondaries for 1,080 drops: eye of newt 340 (Taverley herb shop, 800 stock), red spiders' eggs 120 (15 ground
  spawns, 7 of them inside the Edgeville dungeon at 3117-3129, 9948-9958), snape grass 145 (3 spawns at
  2906-2917, 3274-3297, respawn 30 ticks), limpwurt 42 (hill giants, 0.0859 per kill, about 490 kills. The same
  dungeon has 12 giants), vials of water 1,080 (Ardougne adventurer shop, 500 stock, 1 per 30 ticks).
- Adding cadantine (white berries), marrentill (unicorn horn dust) and tarromin (limpwurt) cuts the kills to about
  1,610. Each one adds a secondary chain: white berries spawn in the Wilderness at about level 37
  (3214,3809 and 3218,3814), unicorns drop 1 horn each (`drop tables/scripts/unicorn.rs2`), and tarromin needs
  about 300 more giant kills.
- Herb level checks: identify needs the herb's level (`identify.rs2` `attempt_identify_herb`), and the unfinished
  potion needs the struct level (`brew_potion.rs2:121-132`). A helper with low Herblore cannot clean or mix herbs
  above its level. Either the main identifies and mixes (item-on-item, 0 XP, about +100 to +200 main ticks,
  ESTIMATE) or a helper trains Herblore first.

## 2. Source and helper per item

"Ask" is the lowest GE sell price. "Shop a@b" means a in stock, 1 restocked every b ticks (CODE-READ
`knowledge/shops.json`). A shop sells above base cost when its stock is low (`shop/scripts/shop.rs2:139-200`).
9,000 ticks = 1 live hour.

| Item | Cheapest legal source | Helper | Evidence |
|---|---|---|---|
| bronze, iron, steel, mithril arrowtips (60, 105, 135, 240) | Shop: Catherby archery shop `archeryshop2` (2822,3442, Catherby bank 13 tiles): 1000@10, 800@20, 600@40, 400@40 | Mightyrod | CODE-READ |
| adamant arrowtips 495 | Shop: Catherby 200@40 + Ranging Guild 200@50 (2670,3435, Ranged 40). 400 at once, the rest in under 1 h | Mightyrod + N3 | CODE-READ |
| rune arrowtips 2,595 (315 + 2,280 swap) | Shop only, GE 0 sellers. Catherby 100@40 + Ranging Guild 150@60: 250 at once + 375 per hour = **6.3 h**. Catherby alone: 225 per hour = 11.1 h. Price about 330-500 each (the first 250 cost 82,250) | Mightyrod (Catherby), N3 (Ranging Guild) | CODE-READ + MEASURED live (0 sellers) + ESTIMATE (price) |
| headless arrows 3,570 (1,290 + 2,280 swap) | Make: arrow shafts (15 per normal log) + feathers. 238 logs. GE 0 sellers | Bigchopper (WC 99) chops and fletches | CODE-READ + ESTIMATE (about 0.8 h: chop 238 logs, cut, attach) |
| feathers about 4,370 (main fishing + headless arrows) | Shop: Port Sarim fishing shop 1000@1 (3013,3225); GE 535 at 70 | Bigpackage | CODE-READ + MEASURED live |
| grapes 601 | Two single-item spawns with access prerequisites; see [grape-gold.md](grape-gold.md). Almera x10 was a LOC/OBJ misread. | Unassigned pending valid source proof | Corrected source read; old 1,125/hour estimate invalid |
| jugs of water 601 | Empty jugs: 22 general stores, 2 each, 1 per 100 ticks; imps 1/64. Jug of water: Shantay 10, Bedabin 5. Fill at a fountain. GE 0 sellers (12:25Z) | Bigpackage (store circuit) | CODE-READ + MEASURED live; ESTIMATE 250-350 jugs per hour, about 2 h |
| unfermented wine 600 | Make: grapes on a jug of water, Cooking 35, instant (`wine.rs2:7-20`). The maker's 20-tick timer ferments the maker's own pack and bank (`wine.rs2:22-70`), and each make resets it (`settimer`). The maker must trade each batch to a courier within 20 ticks. A courier that never made wine has no timer | N2 (new, Cook's Assistant + stew and shrimp to 35, the main's route) + Bigpackage | CODE-READ; ESTIMATE 30 ticks per 14 wines, about 0.15 h |
| Cook's Assistant items, stew 3, shrimps 2 | Lumbridge farm and shops | Bigpackage | ESTIMATE 0.3 h |
| uncut opal, jade, red topaz, sapphire, emerald, ruby, diamond (31) | GE purchase over time. Bids must beat the standing 2,500 (3,500 for diamonds). 7-day trades: opal 9,793, jade 5,886, sapphire 4,383, ruby 1,306, red topaz 1,243, emerald 705, diamond 592 | Moneyshot places bids | MEASURED live; ESTIMATE 1-2 days, about 150k coins |
| uncut dragonstone 305 | **No legal source at scale** (Summary item 1). Substitute: 354 uncut diamonds by GE over time, about 1.8M coins, 4-7 days | Moneyshot | CODE-READ + ESTIMATE |
| herbs (substituted plan) | Kills: chaos druids, Edgeville dungeon (3110,9936, 11 spawns, combat 13, 20 HP, respawn 50 ticks), Taverley dungeon (6). GE now: about 285 low herbs at 2,000-4,000 (too costly) | N4a, N4b (new combat accounts) | CODE-READ; kill rate ESTIMATE 500 per hour per account |
| torstol, snapdragon, toadflax | **No legal source at scale** | - | CODE-READ |
| herb secondaries | See section 1, Herblore replacement detail | N4a, N4b + Bigpackage (shops) | CODE-READ + ESTIMATE |
| jangerberries 176 (planner plan only) | Ground spawns: 4 at Yanille (2510-2517, 3080-3090), respawn 30 ticks, up to 1,200 per hour | N1 | CODE-READ |
| logs 27, maple 13 | Chop. GE 0 sellers. Seers' maples | Bigchopper | CODE-READ + MEASURED live |
| oak 4, willow 7, yew 25, magic 107 | GE now: 27 at 19, 67 at 40, 48,462 at 379, 56,003 at 2,250 | Bigpackage | MEASURED live; 251k coins |
| dragon bones 560 | GE now: 16 at 19,000 (304k). GE over time: 585 trades in 7 days, standing bid 5,000 for 1,253, so about 7 days at a bid near 8,000 (4.5M). Kills: every dragon drops 1 bone and 1 hide (`all.npc` `death_drop`). Green dragons: 5 spawns at Wilderness level about 37 (3078-3118, 3810-3821), 75 HP, respawn 60 ticks. Dragonfire hits up to 50 without the anti-dragon shield and 5 with it (`npc/scripts/dragon.rs2:110-125`). The Duke gives the shield only at a Dragon Slayer stage (`duke_horacio.rs2:4`) | Buy 16 now: Moneyshot. Rest: N4 after it gets the shield, or GE over time | CODE-READ + MEASURED live; kill rate ESTIMATE 150-250 per hour |
| bronze bars 34 | Shop: Shantay 10@500, 2 jungle stores 10@500 | Bigpackage | CODE-READ |
| iron bars 35 | Smelt from GE iron ore (22 at 110 now; 556,998 trades in 7 days) | N5 (it smelts iron to train Smithing) | MEASURED live + CODE-READ |
| steel bars 95 | GE now: 4,175 at 1,502 (143k) | Bigpackage | MEASURED live |
| mithril bars 280, adamantite bars 345 | Mine and smelt. Bars and ores have 0 sellers. Mithril ore 280 (Mining 55), adamantite ore 345 (Mining 70), coal 3,190 (280 x 4 + 345 x 6). Coal has 0 sellers and a 6.8M bid at 80. Mining Guild (Mining 60) for coal and mithril | N5 (miner and smelter), N6 (coal) | CODE-READ + MEASURED live; ore rates ESTIMATE: mithril 0.04, adamantite 0.025, coal 0.08 ore per tick |
| hammer, chisel, tinderbox, knife 2 | General stores, 2-5 each | Bigpackage | CODE-READ |
| rune essence 4,213 | GE now: 1,627 at 58 (94k). A 355,515 bid at 55 competes, so buy now. Rest 2,586: mine at the essence mine (Rune Mysteries quest) | Bigpackage (buy), N6 (mine) | MEASURED live; ESTIMATE 0.3-0.5 essence per tick, about 1.3 h |
| talismans (air, fire, body, nature, law) | Air: GE 1 at 3. Fire, body: 0 sellers. Nature: 0 sellers, bid 50,000. Law: not in the market catalog (404). Drops: body talisman from giants 0.0156; nature talisman from `randomjewel` | not resolved | MEASURED live + CODE-READ; open |
| lobsters 610 | GE: 20 at 152 now, bid 120, 1,303 traded in 7 days (12:25Z). Bigpackage holds 115 notes (swarm.json note, not checked). Or fish at Catherby: 27 lobsters in 600 ticks at Fishing 70 = 405 per hour, plain clicks; cooking needs Cooking 40 | Bigpackage (GE) or Mightyrod (fish between arrowtip buys) | MEASURED live + MEASURED practice (`gathering-tricks.md:44`) |
| water 6,807, earth 7,175 runes (only for enchant) | Shops: Aubury (3253,3402) 2000@10, Betty Port Sarim (3012,3259) 1000@10. About 3,600 per hour together for both runes | Bigpackage | CODE-READ; about 100k coins ESTIMATE |
| law runes 722 (Magic teleport substitute) | GE: 423 at 2,697 (1.14M). Shops: Magic Guild 1000@300 (Magic 66), Mage Arena 250@300, Ape Atoll 250@300 (Monkey Madness) | Moneyshot (GE) | MEASURED live + CODE-READ |
| cosmic runes 546, jewellery 546 | **No source at scale** for the dragonstone amulets (453). Drop the enchant method | - | CODE-READ |
| rune armour set | Oziach rune platebody 2@500 (3069,3517); Champions' Guild platelegs and coif (3191,3351, 32 QP) | Bigpackage | CODE-READ; price not quoted (rerun `market-snapshot.ts` with the ids) |
| rune pickaxe | Nurmof (2998,9844) 1@700 | Bigpackage | CODE-READ |
| rune axe | No shop. GE not quoted. Bigchopper may own one (not checked) | Bigchopper | open |
| magic shortbow, yew shortbow | Fletch from logs + bow strings (bow strings GE 591 at 146), or GE (not quoted) | Bigchopper | MEASURED live (strings) |
| black d'hide set, coif | Black dragon leather 0 sellers, black hides 0 sellers. Coif: Ranging Guild armour shop 10@50 | open | MEASURED live + CODE-READ |
| cannon parts 4 | Nulodion (3011,3453), 5 each, 1 per 100 ticks, base 187,500 each, needs Dwarf Cannon complete | N7 or the main after row 31 | CODE-READ; 750k coins ESTIMATE (sell multiplier not checked) |
| cannonballs 1,700 | Make: 4 per steel bar (`smelting/cannonballs.rs2:38`), 425 steel bars from the GE (638k). Needs the Dwarf Cannon ammo mould | N7 (Dwarf Cannon quest) | CODE-READ + MEASURED live; Smithing level not checked |
| anti-dragon shield | Duke Horacio, free at the Dragon Slayer stage | the main | CODE-READ |
| Equipment set | Shops: dragon battleaxe 200,000 and right shield half 750,000 (Heroes', Legends' quests). Drops or GE asks for the helm, chainbody, platelegs, left half: about 754M | out of reach (owner decision E1) | CODE-READ + MEASURED live (`boards-special.md:56-81`) |
| Bank value | 16.2B of base cost | out of reach (owner decision B1) | `boards-special.md:134-150` |

Owned Earth production uses the pinned `drop tables/scripts/man.rs2` Earth-talisman table (2/128) and ordinary `goblin.rs2` Air-talisman table (1/128), then `skill_runecraft/scripts/runecraft.rs2` and its altar rows. These sources feed `scripts/earth-production.ts` through the existing refunded Earth-order entry. Reuse the Air actions and observed bank, food and travel helpers; keep the separate crafting and carrier workers unchanged. The source calculation uses the server's flat level curve, 25x XP and each batch's actual rune multiplier. Random access drops, saved conservation, bounded food, altar entry/exit and the final live bank remain distinct checks; practice fixture inputs do not prove procurement.

## 3. Job list

Order: earliest "needed at" first, then the longest job first. **CP** marks a critical-path job: it finishes
last or it holds a gate-3 line that has no other source. N1-N7 are new accounts from
`packages/core/src/names.ts`. A new account starts on Tutorial Island with the starter kit only.

| # | Account | Job | Location | Items per hour (ESTIMATE) | Hours | Prerequisites | Script |
|---|---|---|---|---|---|---|---|
| 1 | Moneyshot, Bigpackage | Buy now everything that has sellers: essence 1,627, magic 107, yew 25, oak 4, willow 7, steel bars 95, dragon bones 16, lobsters 20 | GE, Varrock west | one trip | 0.5 | about 800k coins from the banker | exists: `gecourier.ts` (lobsters only); must add an item list |
| 2 **CP** | Mightyrod | Buy rune and adamant arrowtips every restock; fish lobsters between visits | Catherby archery shop and bank | 225 rune tips | 6.3 (11.1 alone) | coins | must write: restock-aware shop loop |
| 3 **CP** | N3 | Train Ranged 40, then buy rune and adamant arrowtips | Ranging Guild | 150 rune tips | 0.2 + 6.3 | Ranged 40 (15,789 XP) | must write: shop loop (same as 2) |
| 4 **CP** | Bigpackage | Feathers, tools, quest items, bronze bars, runes | Port Sarim, Lumbridge, Shantay Pass, Varrock | - | 1.5 | coins | must write: shop loop |
| 5 | Bigchopper | Chop 238 + 27 logs and 13 maples, cut 3,570 shafts, make 3,570 headless arrows | Lumbridge or Draynor trees, Seers' maples | about 4,500 headless arrows | 1.0 | feathers from job 4 | exists: `woodcutting.ts`; must write: fletch loop |
| 6 **BLOCKED** | Unassigned | Source 601 grapes | See grape-gold.md; Almera is not a grape spawn | Unmeasured | Unknown | Access prerequisites | Replace invalid source and remeasure schedule |
| 7 | Bigpackage | Buy 601 empty jugs on a general-store circuit, fill them | Lumbridge, Varrock, Falador, Al Kharid stores | 250-350 | 2.0 | coins | must write: store circuit |
| 8 | N2 + Bigpackage | Cooking 35, make 600 wines in batches of 14, trade each batch to Bigpackage within 20 ticks, note them | any bank | 1,700 wines | 0.3 + 0.15 | Cook's Assistant items | must write: wine maker and hand-off |
| 9 | Moneyshot | Place GE bids for the 31 low gems (and 354 diamonds if Crafting takes that substitute) | GE | market flow | 0.3 active, 1-7 days wait | coins | must write: GE bid script |
| 10 **CP** | N4a, N4b | Waterfall Quest, then kill chaos druids and hill giants; pick red spiders' eggs; bank herbs | Edgeville dungeon (3110,9936) | 500 kills = 220 herbs per account | 0.3 + 2.5 each | Attack and Strength from Waterfall; food | exists: `waterfall.ts`; must write: kill-and-loot loop |
| 11 | Bigpackage | Herb secondaries: eye of newt 340, vials 1,080, snape grass 145 | Taverley, Ardougne, snape spawns | - | 2.0 | coins | must write: shop loop + spawn picker |
| 12 **CP** | N5 | Mining 1 to 70 on iron; smelt 104 iron bars (Smithing to 50, 35 bars kept); mine 280 mithril and 345 adamantite; smelt 625 bars (Smithing 50 to 70 from mithril) | Mining Guild, Falador furnace and bank | 360 mithril or 225 adamantite ore | 0.2 + 0.3 + 3.5 + 0.3 | rune pickaxe (job 4) | exists: `scripts/measure/gather.ts` (iron, measure only); must write: mine, bank, smelt |
| 13 **CP** | N6 | Mining to 60, mine 3,190 coal; then Rune Mysteries and 2,586 rune essence | Mining Guild; essence mine | 720 coal; 2,000 essence | 0.2 + 4.4 + 0.2 + 1.3 | pickaxe | must write: mine loop, Rune Mysteries script |
| 14 | N7 | Dwarf Cannon quest, buy the 4 cannon parts, make 1,700 cannonballs from 425 GE steel bars | Ice Mountain dwarves, a furnace | 600 cannonballs | 0.3 + 0.2 + 0.3 | 1.39M coins | exists: `dwarfcannon.ts` (preset at Haggis levels, not a fresh account); must write: cannonball smelter |
| 15 | Bigpackage | Rune armour, rune pickaxe, bows, coif | Edgeville, Champions' Guild, Dwarven Mine | - | 0.8 | coins; 32 QP for the Champions' Guild (helper has none) | must write: shop loop |
| 16 | Moneyshot | Law runes for the Magic substitute (423 on the GE, rest by bids) | GE | market flow | 0.3 | 1.2M coins | GE bid script (job 9) |
| 17 | 4 gold farmers | Keep farming gold | Ardougne market | 600-800k coins together | 5.6 | - | exists: `goldfarm.ts` host job |
| 18 | open | Dragon bones 544 by kills | green dragons, Wilderness 37 | 150-250 | 2.5-4 | combat 70+ (ESTIMATE), anti-dragon shield | must write |

Job 18 is not in the totals. The GE route for dragon bones (job 9 bids, about 7 days) replaces it until a helper
has the shield.

## 4. Totals

Helper-hours (ESTIMATE, the sum of the "Hours" column, jobs 1-17): about **62**. Of these, 22.4 are the gold farm,
12.6 are the 2 arrowtip shop loops (mostly waiting for restock), and 5.6 are the herb kills.

Gold (ESTIMATE from MEASURED live asks):

| Line | Coins |
|---|---|
| Rune arrowtips 2,595 | about 1.0M (0.86-1.3M) |
| Other arrowtips, feathers, tools, quest items, bronze bars | about 0.1M |
| Logs (magic, yew, oak, willow) | 251k |
| Steel bars 95 + iron ore 104 | 154k |
| Dragon bones 16 (GE now) | 304k |
| Low gems 31 | 150k |
| Rune essence 1,627 | 94k |
| Lobsters 475 | 76k |
| Water and earth runes | 100k |
| Law runes 722 (Magic substitute) | 1.2M |
| Cannon parts + 425 steel bars for cannonballs | 1.39M |
| Rune armour, pickaxe, bows | 200k |
| **Core total** | **about 5.0M** |
| Optional: 354 diamonds (Crafting substitute) | +1.8M |
| Optional: 544 dragon bones on the GE | +4.5M |
| Out of reach: Equipment dragon pieces, Bank 16.2B | 754M, 16.2B |

- Held: about 1.1M (dashboard economy panel, task brief). Gap: 3.9M. At 600-800k per hour that is
  4.9-6.5 h, about 5.6 h at 700k.
- Earliest staging of the core substituted manifest: start all accounts together. Four chains run in
  parallel: the arrowtip loop (N3, 6.5 h), Bigpackage's serial queue (jobs 1, 4, 7, 8, 11, 15: about 7 h), N6
  (6.1 h) and the gold gap (5.6 h). Purchases in the last hour wait for the gold. Result: about
  **7 h** after the start, and 11 h with time for hand-offs. This needs 11 accounts (Mightyrod,
  Bigchopper, Bigpackage, Moneyshot, N1-N7) and no competition at the shops or spawns. A second courier cuts
  Bigpackage's queue to about 3.5 h. With the diamond substitute: about 5 days after the start. With GE dragon bones:
  about 7 days after the start, and 4.5M more coins (about 6.4 h more farming, which fits in that wait).
- The planner's exact manifest has no staging date. Torstol, snapdragon, toadflax, dragonstones and the
  dragonstone amulets have no legal source at scale.

### The 5 jobs to start first

1. **Job 1, buy now** (Moneyshot, Bigpackage): essence, magic and yew logs, steel bars, 16 dragon bones,
   lobsters. Competing bids exist for essence (355,515 at 55) and dragon bones (1,253 at 5,000).
2. **Jobs 2 and 3, rune arrowtip restock** (Mightyrod, N3): the longest fixed-rate job, 6.3 h.
3. **Jobs 12 and 13, mithril, adamantite and coal** (N5, N6): 4.5-5 h each, and the Smithing board needs
   these bars (no seller).
4. **Jobs 6, 7 and 8, wine** (N1, Bigpackage, N2): needed in Trade 1 at tick 10. Grapes are contested.
5. **Job 10, herb kills** (N4a, N4b), after the planner takes the Herblore substitute. Start the Waterfall
   Quest for both accounts now: it is needed for any combat job.

## Open

- Every kill, mining and shop-loop rate in this file is an ESTIMATE. Measure each one 3 times on practice, then
  1 live hour for contested spawns (grapes, chaos druids).
- The planner must take the substitutions (dart band to rune arrows, Herblore herb set, Crafting, Magic) before
  `.practice/haggis-supplies.json` can list a manifest that can be staged.
- How the Herblore and Crafting leaders (447, 197 ticks) got torstol-level herbs and 277 dragonstones is not
  known. A source outside this content search (a staff account, an earlier market) is possible.
- Talisman sources, the anti-dragon shield stage, the Ranging Guild entry, the cannonball Smithing level, the
  Nulodion price and the rune armour prices are not checked.
- The wine hand-off rule (trade each batch within 20 ticks) is CODE-READ. Test it on practice before use.

## Contradictions

- `research/leader-forensics.md:248-249` says Herblore "is winnable" and the limit is "supply (176 torstol and
  jangerberries)". This file: torstol has one source, 1 per sinister key, about 2,250 Salarin kills for 176
  (`agility_dungeon.rs2:103-120`, `salarin_the_twisted.rs2:45-46`). With legal herbs the floor is about 630
  ticks against 447. What settles it: a practice run of the substituted herb set, 3 runs.
- `research/supply-costs.md:35` says helpers can "kill herb-dropping NPCs" for every Herblore tier. No drop
  table holds torstol, toadflax or snapdragon (`shared_droptables.rs2:2-34`, `knowledge/drops.json`). What
  settles it: the code search above. It is settled for rev 289 content.
