# Microbot ports

## Coverage

The [catalog](microbot-ports.json) covers both pinned public Microbot production namespaces, including plugins without a `Script` suffix.
Tests, resources, unrelated RuneLite plugins, private repositories and other third-party repositories are outside this scope.

| Repository | Commit | Java files | Groups | Script files |
|---|---|---:|---:|---:|
| [Microbot](https://github.com/chsami/Microbot) | `13b518350c4c81d64e4cfbb45b3d5d2f38488825` | 1,444 | 44 | 11 |
| [Microbot-Hub](https://github.com/chsami/Microbot-Hub) | `cd648f48d536c01c58aa82aa4d353fb31ce6e102` | 1,567 | 173 | 212 |

Both recursive trees report `truncated=false`. All 217 groups and 223 Script-suffix files have source decisions.
Root Java classes count as individual groups. These counts are not a count of runnable bots.
The coverage gate rejects missing groups, nested scripts, source evidence, consumers and blockers.
Source review is complete within this scope. Full donor parity, native qualification and live release are incomplete.
`partial` does not mean the server lacks the whole activity. `source-reviewed` does not mean game-tested.

The decisions live in `microbot-decisions-{core,a,b,c}.json`. The catalog is generated from them and the pinned trees.
Do not hand-edit the catalog. Exact [negative searches](microbot-server-search-a.ndjson) identify native scopes and patterns.

```powershell
bun scripts/microbot-catalog.ts --summary
bun scripts/microbot-catalog.ts --show crafting
bun scripts/microbot-catalog.ts --show cluesolver
bun scripts/microbot-catalog.ts --blocked
bun scripts/microbot-catalog.ts --remaining
```

## Native consumers

These bounded TypeScript behaviours replace Java loops, mouse input and sleeps with structured SDK actions and observed receipts. Each cited native receipt retains its captured worker and dependency hashes. Source-impact checks can explain later shared-helper changes; they do not turn an older complete manifest into current unchanged bytes.
The [script contract](../docs/script-contract.md) owns qualification and release requirements.
New workers have source/unit proof unless a separate native receipt qualifies their exact bytes.

| Behaviour | Consumer | Implemented native scope |
|---|---|---|
| Inventory production | [production](../scripts/microbot-production.ts) | 180 profiles: gems, battlestaves, amulets, leather/dhide, glass, bow cutting/stringing, darts, bolts, herbs, mixtures, dough, pies, cakes, stew and pizza |
| Ordinary wine | [wine](../scripts/microbot-wine.ts) | Grapes/water, fresh bank receipts, fermentation and separate good/bad output audit |
| Furnace glass | [glass](../scripts/microbot-glass.ts) | Staged sand/ash, glass, returned buckets and XP |
| Bones to Bananas | [bones](../scripts/microbot-bones.ts) | Finite bank order and exact rune/bone/banana/XP receipts, including native staff substitution |
| Item spells | [item magic](../scripts/microbot-magic-items.ts) | Low/high alchemy, eight Superheat metals and native jewellery conversions |
| Combat loot alchemy | [alchemy policy](../scripts/microbot-combat-alch.ts) | Optional finite profitable-loot processing after an exact owned pickup, with actor/server-bound quotes, reserves, blacklist and bank accounting |
| Combat potion upkeep | [upkeep](../scripts/microbot-combat-potions.ts) | Opt-in serialized potion policies in the existing generic, cow and Ranged loops, with one session dose budget, cooldowns, exact stock and confirmed same-target resume |
| NPC spells | [NPC magic](../scripts/microbot-magic-npc.ts), [bank trips](../scripts/microbot-magic-trip.ts) | All 30 player spells, required staves and unlock checks, splash observations, serial alchemy/teleport combinations, finite refills and declared return teleport |
| Teleports | [teleports](../scripts/microbot-magic-teleport.ts) | Seven native destinations with rune/XP/location receipts |
| Action graphs | [actions](../scripts/microbot-a-actions.ts) | Typed target resolvers, declared effects, bounded success/failure edges; no source-code evaluation |
| Cannonballs | [cannonballs](../scripts/microbot-a-cannonballs.ts) | Al Kharid bank/furnace/return, four balls per bar, mould and bank proof |
| Chompies | [Chompy](../scripts/microbot-chompy-trip.ts) | Owned bank kit, finite post-quest bellows/toad/bait/own kill/pluck trips, product banking and original gear/style restoration |
| Blue dragons | [ranged camp](../scripts/microbot-a-ranged-camp.ts) | Bank-owned kit, Taverley key door, safespot, own kill/drop receipts, declared escape and loot banking |
| GE sales | [owned GE sale](../scripts/sell-owned-ge-item.ts), [bank trip](../scripts/microbot-ge-trip.ts) | Staged seller handles partial/full fills, fees, cancellation and collection; bank adapter adds durable lot intent, escrow recovery before bank access, finite return and exact replay asset audit |
| GE suggestions | [price plan](../scripts/microbot-ge-plan.ts) | Finite explicit price suggestions, settle-before-relist, remaining-stock and per-offer tax accounting; Finish retains a freshly observed owned sell offer and reports its escrow separately from banked output |
| GE buy lists | [buy list](../scripts/microbot-ge-buy-list.ts) | Exact native item list, donor percentage steps, explicit unit caps and total budget, durable sequential owned-buy recovery and bank checks |
| Automatic bank sales | [bank seller](../scripts/microbot-bank-seller.ts) | Finite bank-wide native selection, protected original kit/offers and reserves, frozen public guide prices, durable owned lots and optional bounded leftover liquidation |
| Owned loadouts | [loadout](../scripts/microbot-owned-loadout.ts) | Exact owned bank kit, noted withdrawals, stacked thrown weapons, original bank mode and compatible combat style; no travel or acquisition |
| Merchant sales | [shop trips](../scripts/microbot-shop-trip.ts) | Finite owned bank lots, native generic or declared custom Trade shops, observed titles/quotes, floor/reserve checks and exact returns; private inventory IDs remain unobserved |
| Nature runes | [Nature trips](../scripts/microbot-rune-trip.ts) | Shilo bank, owned essence/talisman, native ruins/altar/portal, finite refills and rune/XP/asset audit; observed member and quest entry required |
| Nature chest | [chest](../scripts/microbot-b-nature-chest.ts) | Staged trap search, bounded attempts and rune/coin/XP receipts |
| Pickpocketing | [pickpocket](../scripts/microbot-a-pickpocket.ts) | All 12 native target profiles and 39 NPC IDs, multi-row rewards, native failure damage/stun and food accounting |
| Pickpocket bank trips | [bank trips](../scripts/microbot-pickpocket-trip.ts) | Finite owned food refills, original target/life, known failure and stun recovery, exact coin banking, stop and logout |
| Paired player combat | [owned pair](../scripts/microbot-pvp.ts) | Finite declared gear, prayers, tank, melee, Ranged, native spells, specials, walk-under and observed animation prerequisites; exact pair/cost/HP and original kit restoration |
| Mining | [mining](../scripts/microbot-b-mining.ts), [drop mode](../scripts/microbot-mining-drop.ts), [progressive tiers](../scripts/microbot-mining-progressive.ts) | Native depleting profiles, explicit retained items and exact drop receipts; highest unlocked donor tier reselected after each finite batch on declared native bank/site routes; bank progression and at-site drop mode have separate native cases |
| Essence banking | [essence](../scripts/gather-essence.ts) | Existing mine/portal/Varrock bank loop, all six native picks, fastest eligible owned bank upgrade, native base-Attack wield checks, fresh bank receipts and conserved inferior tools |
| Ground collection | [looting](../scripts/microbot-b-mining-loot.ts), [bank trips](../scripts/microbot-loot-trip.ts) | Visible ID/name/value filters, whole-pile capacity, exact inventory and bank credits; optional bounded native GE quote snapshots and donor strict pile-minimum/unit-maximum rules; no kill-ownership claim |
| Telegrab loot | [combat loot](../scripts/microbot-telegrab.ts) | Optional finite paid collection of wanted walk-unreachable piles in existing combat and Ranged consumers; native capacity, life, range, rune, XP and exact item receipts; ordinary pickup remains the default |
| Fishing | [fishing](../scripts/microbot-b-fishing.ts) | Ten native methods, including karambwan rebaiting, Big Net primary fish and separate byproducts, and oily-rod Lava Eel; shark uses the existing worker. Protected karambwan and Lava routes have finite two-trip Native proof. Big Net has two same-account episodes; Village composition passes eight finite Native cases in the row below. Other sites retain their own qualification gaps |
| Village fish processing | [village fishing](../scripts/microbot-village-fishing.ts) | Fly/pike times four raw/cooked bank/drop modes: [eight Native CLI cases](../.practice/microbot-ports/village-fishing-native-1793688514822/result.json), two bank trips each, exact raw/CRC assets and XP, HP99, kit/retaliation/style, home and logout. Native range north-face route replaces absent modern fire; skills99, XP25, 100ms practice conditions; live repeats remain unqualified |
| Gathered wood processing | [wood composition](../scripts/fletch-worker.ts) | [Five Native CLI cases](../.practice/microbot-ports/wood-composition-native-1793689233387/result.json): gather/cut/bank, string/drop, burn at99, Seers willow and Magic cut/bank; two logs each, exact raw/CRC products, XP, reserves, HP99, gear, Native bank return and child logouts. Captured BE46 source, skills99/XP1/100ms; modern forestry, arbitrary sites and live repeats remain unqualified |
| Progressive production | [progressive production](../scripts/microbot-production-progressive.ts) | Native bow/staff/glass tiers and full owned ingredient bread/stew/cake preparation; reselect after finite batches without lower-stock fallback. Native boundary checks remain pending |
| Firemaking | [firemaking](../scripts/firemaking-order.ts) | Six native log families, tier reselection and explicit log-count burning at level99; bank/refill and exact burn receipts |
| GE regular fires | [GE firemaking](../scripts/microbot-ge-firemaking.ts) | Native GE-area bank, finite ordinary burning and refills reuse the firemaking worker; three Native CLI cases pass. Modern bonfire feeding has no matching native handler |
| KBD | [KBD](../scripts/microbot-b-kbd.ts) | Bank-owned kit, Wilderness ladder/lever entry, bounded encounter, gear/potion/prayer policy, attributed drops, legal escape and loot banking |
| Furnace jewellery | [jewellery](../scripts/microbot-b-jewellery.ts) | All 23 native gold/perfect-gold/silver recipes and native menu/asset receipts |
| Cooking | [cooking](../scripts/microbot-b-cooking.ts) | Native useful cooking table, heat restrictions, cooked/burnt accounting and containers |
| Legacy Trawler | [Trawler](../scripts/microbot-trawler-trip.ts) | Owned bank kit, boarding, complete legacy trip, repair/bail transitions, catch recovery and bank return |
| Tanning | [tanning](../scripts/microbot-c-tanner.ts) | All six native outputs with hide/coin/product receipts |
| Orb charging | [orbs](../scripts/microbot-c-orbs.ts) | Four obelisks, owned elemental staves, finite ordinary energy doses, paid spell or charged Glory return, exact native costs and recorded spell-on-location dispatch |
| Stall theft | [stalls](../scripts/microbot-c-stalls.ts) | All 13 native stall rows, loot/XP and stock checks |
| Player monitor | [monitor](../scripts/microbot-c-player-monitor.ts) | Finite radius/ignore/new-player and native wilderness-zone filters; stop, confirmed logout or one exact configured inventory action with declared item effect; global/account/role stops enforced |
| Kitten/kingdom care | [care](../scripts/microbot-c-care.ts) | Owned kitten feed/wool/stroke; Miscellania herb weeding with sickle and Herblore 35 |
| Kingdom coffers | [coffer deposit](../scripts/microbot-misc-coffer.ts) | Optional native noted-resource collection with exact report/pack credits and capacity admission, then one exact owned coin deposit with observed completed quest/member entry and native balance/count-dialog receipts |
| QOL actions | [QOL](../scripts/microbot-c-qol.ts) | Finite special attack, prayer hold/restoration and owned cannon refill |
| Special weapon swaps | [special swap](../scripts/microbot-special-swap.ts) | One funded native special, exact ammo and energy costs, one cancellation, original gear/style restoration and declared NPC escape; multi-target execution has a separate qualification |
| Offensive prayer flicking | [combat prayer](../scripts/microbot-prayer-flick.ts) | Finite observed OFF/ON resets during the existing cow worker; original life and prayer ownership, uncertain-outcome stop and observed restoration; no incoming protection or attack prediction |
| Incoming protection | [protection](../scripts/microbot-prayer-flick.ts) | Opt-in finite native Farmer melee protection before the first spell, observed attack timing, conservative re-enable and original prayer restoration |
| Clues | [clue steps](../scripts/microbot-c-clues.ts) | Exact native definitions and supported clue transitions; per-definition gaps retained |
| Clue puzzles | [puzzles](../scripts/microbot-c-clue-puzzle.ts) | Existing Monkey Madness solver, native board, recorded slides and mapped staged turn-ins |
| Clue guardians | [guardians](../scripts/microbot-c-clue-guardian.ts) | All 30 native guardian/casket mappings, new own-target binding and repeat-dig credit; actual fights remain unqualified |

All 276 native clue descriptors identify an executor and entry ID.
They contain 222 direct steps, 30 guardian steps, 18 puzzle originals/boxes and six challenge companion items linked to their original clue.
The direct steps contain 42 digs, 68 searches, 32 talks, six numeric challenges and 74 casket opens.
Source mappings do not prove that their access routes, guardian mitigation or runtime observations pass on the server.

The [bank sorter](../scripts/microbot-bank-sort.ts) sorts the flat native bank with exact swap or insertion receipts.
The default policy sorts names. The optional `donor` policy orders categories, production workflows, native levels/stages, tiers, runes, doses and fuzzy name groups.
Native practice sorts 30 mixed stacks against an independent fixed order, including equal names, sparse slots and the level-15 ashes mixture.
Swap takes 26 moves/52 ticks. Insertion takes 23 moves/46 ticks. Assets, gear, HP99, zero XP, mode and logout pass.
The proof is `.practice/microbot-ports/bank-sort-donor-native-1793603372250/result.json`. Its source check covers 11,469 files without changes.
Native bank tabs do not exist. Normal deposits convert notes to base items. Unknown or malformed bank IDs stop before a drag.

Inventory production banks each confirmed product and returned container. Fragile gem failures count as losses.
Thread debits zero or one per native five-use cycle. Multi-output recipes require an explicit output batch multiple.
Ten darts are ten products, not ten recipe actions. Bank-per-action production has no throughput qualification.

Staged workers require the stated site, access, skills, tools, runes, food and owned inputs.
Output remains held unless the worker explicitly proves banking. A staged result does not prove an unattended bank/refill route.
Existing walking, supply and chain workers can compose these jobs. Untested compositions remain unqualified.

## Native practice proof

All six native arrow metals pass two actual CLI batches each in `.practice/microbot-ports/arrows-six-native-1793641235025/result.json`. Each case banks 30 new arrows, uses 30 headless arrows and 30 tips, and keeps the declared reserves. Independent CRC saves check native raw XP, all assets, other XP0, HP99, kit, controls and logout. The source check records 11,518 unchanged entries; 57 compiled-cache checks remain unchanged. This proof binds `fletch-arrows.ts` source `998272abc3a4447aab32158cd7bae0e1612d056d564bc34fc5214972297a5bd1` with owned inputs, skills99 and practice XP25. Input acquisition and live repeats remain unqualified.

Firemaking passes seven actual CLI cases in `.practice/microbot-ports/firemaking-six-native-1793638724632/result.json`: two logs from each of six native families and a level44-to45 Willow/Maple change. Independent saves reconcile exact log debits, native raw XP, other XP0, original kit, HP99, bank return and logout. The source check records 11,519 unchanged files; 57 compiled-cache checks remain unchanged. Worker `54111570fcc6002db75a0a6cd8bfe42d4d0da6b6d2c04fade613a53e319bae25` includes explicit log-count mode; the level99 gathered-wood composition has a separate pending Native check.

Automatic bank sales pass four actual CLI cases in `.practice/microbot-ports/bank-seller-native-1793638922670/result.json`: full sale nets232 coins, partial sale nets76, original stop pays0 and declared leftover liquidation nets3. Independent CRC saves reconcile both owned actors, all stock, original kit, other XP0, HP99, controls and logout. Worker `8772bdf56bb54dee14cf80a419c43f1a7a6228921bdb1f8c574887a3ba0244f6` and 11,542 source/cache entries remain unchanged; 42 compiled server-cache files match before startup, after readiness and at exit. Pre-existing foreign offers remain protected, matching the donor policy. These cases use an owned matching buyer and do not prove outside demand or profit.

The owned loadout CLI passes three cases in `.practice/microbot-ports/owned-loadout-native-1793621632981/result.json`, bound to worker `43eb1c0f3032d7b3db4642b2f6df7f291146926c06ca618451713368dd39739d` with no source changes. A full pack changes to a two-handed kit in nine moves/24 ticks. Native notes and stacked throwing weapons take nine moves/23 ticks. Missing stock refuses before asset moves. CRC saves, original controls, all assets, XP0, HP99 and logout pass. This proves a declared owned kit at a bank; travel and acquisition are separate.

The special-swap CLI passes eight cases in `.practice/microbot-ports/special-swap-native-1793622341898/result.json`, bound to worker `7f5d613ec2f605493daa772d06a8e24ec2929218ad507192f26f7daec17f3c5b`; `source-check.json` records 11,506 unchanged files. Halberd, dagger, shortbow and solo thrownaxe have exact paid costs, one cancellation, positive damage/XP, restored kits, HP99, declared escape and logout. Battleaxe and Excalibur prove their self effects. Stop and low energy refuse without payment. The independent energy check includes native regeneration during the exit. The separate actual-CLI thrownaxe case in `.practice/microbot-ports/special-swap-multi-native-1793624168093/result.json` confirms two hits, one projectile and 200 special energy, original kit/style, HP99, declared escape and logout. This is a finite staged multi-target case.

The generic combat CLI passes owned public pickup, alchemy and banking in `.practice/microbot-ports/combat-alch-native-1793621653343/result.json`; `source-check.json` records 11,493 unchanged files. One profitable Limpwurt root and one Nature rune become four banked coins and 65 Magic XP with the owned Fire staff. Unprofitable and blacklisted roots bank intact without a cast. Independent CRC saves reconcile both actors, all assets, other XP0, HP99, gear and logout. Quotes are declared immutable unit costs bound to the actor and server. The separate Ranged CLI proof in `.practice/microbot-ports/ranged-alch-native-1793622203892/result.json` covers an owned Chicken kill, loot and banking with default, unprofitable and blacklist settings. Native Chicken loot cannot fund profitable alchemy under the declared positive costs; the two configured cases correctly bank loot without a cast. Exact ammo, food, runes, all assets, raw combat XP, HP99 and logout pass. Its selected rapid style remains selected. These are finite practice checks; neither proves outside profit, GE liquidity or live release.

Orb player detection passes four cases in `.practice/microbot-ports/orb-player-native-1793622852196/proof.json`; `source-check.json` records 11,439 unchanged files, including trip worker `ae3e39ef0d5b3e4de125d588a5c63e3f2c8f085dcac4f550de06d89cee7904bb`. An eligible owned nonattacking peer triggers escape, banking, control restoration and logout during charging and walking. These interrupted targets correctly return failure. Ineligible combat level and observed Air staff cases complete without a false escape. CRC saves reconcile paid spells, output, all stock, other XP0, HP99 and both actors' logout. Attacking peers and live use remain unqualified.

The paired-player CLI passes all eight declared cases in `.practice/microbot-ports/pvp-native-1793639996151/result.json`, bound to worker `63c19ab702bfee747c5f9f95e6b833c97a879952b115c8ecf2b9a39ca7000153`. Melee with prayer and tank kit, Ranged, Wind Strike, dagger special, Iban charges four to two, poisoned dagger with an owned partner antidote, initial stop and post-animation walk-under pass. The last case records one attack, one cancellation and one actual `walkTo` onto the owned partner tile, with no partner gameplay input. Independent CRC saves reconcile both actors, exact paid costs, raw/public XP, HP bounds, restored kit/style/prayers and logout. The source check records 11,511 unchanged entries and 57 compiled-cache checks remain unchanged. The pair occupies declared clear low-Wilderness tiles away from NPC spawns. The Iban balance is private fixture evidence; the worker reports a source-inferred debit. Misses remain misses without retry. Hostile players and live use remain unqualified.

The pickpocket bank CLI passes six trips and twelve successes in `.practice/microbot-ports/pickpocket-trip-native-1793626892630/result.json`, with six native failures and five Lobsters eaten. It banks 36 coins and gains 96 Thieving XP, retaining 73 total coins and 80 Lobsters. Independent CRC saves check all assets, other XP, HP99, controls and logout. Missing food refuses before withdrawal; a stop after the first two-success batch banks six coins and makes no second refill. This qualifies the staged Man route, not bank routes for all twelve target profiles.

The incoming-protection CLI passes its declared Farmer case and initial-stop case in `.practice/microbot-ports/incoming-prayer-native-1793632641306/result.json`. Three Wind Strikes and one Varrock return spend exactly three Mind, one Law and one Fire rune with the owned Air staff. Five attack animations are observed with melee protection active; four reset cycles spend one prayer point over 45 ticks. Saved HP99, exact stock and XP, original kit/prayers/controls and logout pass. Initial stop makes zero gameplay inputs. The source check records 11,217 unchanged entries. This is a fixed native Farmer melee case, not mixed-style prediction, a bank route or a speed comparison.

Combat potion upkeep passes three actual Ranged CLI cases in `.practice/microbot-ports/combat-potion-native-1793632585400/result.json`. The enabled case drinks one ranged dose, raises level five to nine, drops the returned vial, waits for confirmed consumption and resumes the same owned Chicken once. It banks bones, raw chicken and five feathers, with 300 Ranged XP, exact saved stock and raw combat XP, HP99, original gear/prayers/retaliation and logout. Threshold-skip and default controls make zero potion inputs. All 11,497 source entries and 57 compiled-cache entries match; the rebuilt ZIP has identical entry names and contents. This qualifies the declared Ranged case. Other combat potion configurations and generic/cow integration retain their own proof levels.

The actual CLI passes all 180 unique inventory-production profiles at a staged Al Kharid bank, with 300 products banked.
The independent saved-state audit checks exact inputs, products, returned containers, optional thread, XP, HP and confirmed logout.
The large-oyster command is `bolt-tips:pearl_bolttips:bigoysterpearls`; it produces 24 tips. The small-oyster command produces 6.

The staged native checks also pass all 23 furnace-jewellery recipes, 21 item-spell profiles, six tanning recipes and furnace glass.
They check saved item/coin/XP changes and logout. They do not prove travel, replenishment or live release.

The jewellery-order CLI passes four native composition cases: cut the owned gem deficit and bank three sapphire rings; make three silver symbols without cutting; cut, forge and string three sapphire amulets; refuse missing gold before production. Each positive furnace stage refills for batches of two and one. Whole assets, exact Crafting XP, reserves, equipment, HP99, controls, bank return and logout reconcile. Evidence: `.practice/microbot-ports/jewellery-trip-native-1793665812857/result.json`, `source-check.json` and `compiled-end-check.json`; 11,531 dependencies and all 57 compiled-cache files remain unchanged. This qualifies the composed order for these cases, not every composed recipe or a live production release.
The Seers spinning CLI passes five native cases: reserve50 refusal, one new string from51 flax with reserve50, thirty new strings across two loads, thirty from noted flax with seven preexisting noted strings, and a pre-existing stop. Exact raw Crafting XP is zero, 3,750, 112,500, 112,500 and zero respectively at25x. All assets, kit, HP99, run/retaliation controls, Native bank-booth arrival, ordered production/deposits and logout reconcile. The stop case sends only terminal logout and keeps its original position. Evidence: `.practice/microbot-ports/spin-bowstrings-native-1793667085890/result.json`, per-case `raw-audit.json`, `source-check.json` and `compiled-check.json`; 11,478 dependencies and all57 compiled-cache files remain unchanged. This is finite practice qualification; fleet pins and live repeat release remain separate gates.
Native cooking passes all 55 useful table rows and 16 gnome ingredient cases, including its fire-only row and Tinsay reward gate.
Thorough karambwan requires the private native Tinsay reward state; otherwise the server cooks the poisonous variant.
Gnome toad variants can publish XP one tick ahead of their item change; XP alone never credits output.

The inventory sweep is `.practice/microbot-ports/native-sweep-current-core-1793632598954/`. Its independent audit passes all 180 cases with zero failures. `runtime-source-check.json` binds 11,516 unchanged entries, including the worker closure and all 42 compiled native server-cache files; the cache also matches after startup and before the first actor. Furnace, item-magic/tanning and cooking receipts stay in `.practice/microbot-ports/{native-furnace-cooking,native-magic-tanning,native-cooking-final}/`.
Each directory holds worker hashes, actual CLI logs and CRC-checked saves. The inventory sweep also holds `saved-audit.json`.
The inventory, furnace, item-magic/tanning and cooking sweeps use a separate members practice server at 150 ms per tick, XP rate 1, required skills 99 and staged owned fixture stock. The jewellery-order and Seers spinning cases use 100 ms ticks and XP rate 25.
The inventory sweep binds its full captured source and compiled-server-cache manifest. The other staged receipts bind their recorded entry files and stated dependency scope. None qualifies an unattended release.
The item-spell bank proof is `.practice/microbot-ports/item-magic-bank-native-1793779568789/`. All21 recipes pass42 casts across42 bank trips: low/high alchemy, eight Superheat metals and eleven jewellery conversions. `independent-reconcile.json` reparses42 CRC saves and21 complete owned raw logs against native costs/conversions/XP, including Superheat Smithing XP, reserve1, worn Fire staff, HP99, controls, banked output and logout. Conditions are members, Magic/Smithing/Crafting99,100ms ticks and XP25 at Al Kharid bank. `source-check.json` binds11,604 unchanged entries; `compiled-cache-ready-check.json` binds42 server-cache files before the first actor. This receipt has no57-file client-cache, other-site, live or repeat qualification.
Retained failed and incomplete fixtures remain failures; a wrapper exit code alone is not proof.

Wine and Bones to Bananas pass a separate bank check with five finished products each, no held output, unchanged coins and HP, and confirmed logout.
The saved XP gains are 550 Cooking and 25 Magic. Bones banking waits through the native spell delay and the following publication boundary.
Evidence: `.practice/microbot-ports/native-bank-final-2/`, including the independent `saved-audit.json`.
This run also binds and rechecks 11,034 core, SDK, engine and content files, with worker hashes in `result.json`.
It remains a bounded staged practice result, not live or unattended release.

The bank-job controller passes all eleven supported job families in one native batch.
All eleven records in `.practice/microbot-ports/bank-job-native-profile-refactor-1793630053094/result.json` pass with the exact recipes and outcomes.
Eight moving families complete three separate bank/site trips each. Inventory, wine and bones delegate to their existing bank workers and report zero controller travel trips. Saved assets, HP, XP and logout checks pass for each family.
All 11,721 recorded source/cache entries remain unchanged, including 42 compiled native server-cache files checked before startup and after readiness. Cannonballs have a separate proof. The separate fishing search case in `.practice/microbot-ports/bank-job-native-fishing-search-1793630069032/result.json` also passes, with 11,711 unchanged source/cache entries.
These are bounded members practice runs at 150 ms per tick and XP rate 1.
They prove the listed recipe/site combinations. Other locations, access requirements and live repeat release remain separate checks.

The existing cannonball worker passes three steel bars to twelve banked balls.
Its saved mould, coins and HP remain unchanged. Saved integer Smithing XP increases by 112, and logout is confirmed.
Evidence: `.practice/microbot-ports/cannon-native-final/result.json`; all 11,347 recorded dependency hashes remain unchanged.

The full legacy Trawler CLI wins and banks all five catch items, including junk, in `.practice/microbot-ports/trawler-native-1793624178169/result.json`.
It repairs 101 leaks and seven nets, bails 57 times and completes in 1,627 ticks.
Independent CRC saves check all catch, paste, rope, buckets, native Fishing/Crafting XP, other XP0, HP50, original gear, bank return and logout.
The shared-server full-trip receipt in `.practice/microbot-ports/trawler-native-1793843743555/result.json` banks six catch/junk items after77 leak repairs,three net repairs and18 bails in1,602 ticks. CRC saves reconcile all assets and declared repair costs,positive Fishing XP,HP50 and logout;11,136 enumerated source entries remain unchanged. This150ms/XP25 case binds its recorded source subset and shared-server disk state,not a fresh engine-load hash or the stronger exact-XP audit of the separate isolated case.
Net excursions require zero visible leaks and water≤10. Each attempt returns to the hold before another net trip.
The separate actual CLI case in `.practice/microbot-ports/trawler-overflow-1793624188353/result.json` banks all 40 items in 434 ticks.
The urgent GUI remainder returns in 38 of 100 ticks. The owned relay returns in 204 of 300 ticks; its contents become public after 100 ticks.
Both checks retain 11,199 unchanged source dependencies and exact saved-asset audits.
These are bounded members practice runs at 80 ms per tick and XP rate 1. Modern crew/tentacle content, other crew conditions, throughput and live repeat release remain unqualified.

Merchant sales use a fresh native Value response before each unit. The SDK's base price does not include native shop-stock changes.
The Al Kharid CLI sells four bronze daggers across two bank trips for 13 coins and keeps two daggers reserved.
The Dommik CLI sells four ring moulds across two bank trips for 12 coins. Exact saved assets, empty packs, HP and logout pass for both.
Evidence: `.practice/microbot-ports/shop-trip-native-1793583304870/` and `dommik-trip-native-1793583338643/`, including `proof.json`, `saved-bank-audit.json` and `source-check.json`.
Conditions: isolated members practice server, 150 ms ticks, XP rate 1, owned stock and native shop contracts. These runs do not qualify contested prices, other merchants or live repeats.

The GE bank adapter passes partial and full native matching, cumulative tax, lost placement/cancel/collect replies, relog recovery and exact bank return.
The partial three-log lot sells two, banks 192 net coins and the unsold log, and retains two reserved logs. Recovery uses one initial withdrawal across three sessions.
The full actual CLI lot banks 96 net coins and retains two reserved logs. Both settled replays prohibit market and withdrawal calls.
Both owned accounts log out with empty packs and exact saved bank totals, including their gold bars.
Evidence: `.practice/microbot-ports/ge-trip-native-1793624203209/proof.json`, `saved-bank-audit.json` and `runtime-check.json`; 11,498 runtime dependencies and 312 worker closure files remain unchanged during the check.
Conditions: members practice at 150 ms per tick, XP rate 1, fixed owned lots and resting owned buy offers. These checks prove finite execution, not outside demand, profitable trading or live release.

The explicit GE price plan passes malformed-journal failure logout, Finish, fresh resting-offer replay, cancel/collect/relist, full actual CLI and stopped-order checks. Its three-log order fills one at 119 coins, then relists and fills two at 101 coins: gross 321, per-offer tax 15 and net 306. During Finish, the two remaining logs and 114 collectable coins stay reported as unsettled escrow, not banked output. Terminal replay makes no market or withdrawal calls. Exact CRC-checked assets, reserves, gear, HP and logout pass. Evidence: `.practice/microbot-ports/ge-trip-native-1793624213401/proof.json` and `runtime-check.json`; 11,499 runtime and 313 worker files remain unchanged.

The configured buy-list CLI buys and banks two Logs and three Air runes for five coins from owned resting sellers. A lost-placement case recovers two of three requested Logs, banks the exact partial result, skips the next item and never withdraws again; settled replay makes no market calls. Exact CRC-checked assets, zero XP, HP50 and logout pass. Evidence: `.practice/microbot-ports/ge-buy-list-native-1793624223558/proof.json` and `source-check.json`; 11,482 dependencies remain unchanged during the check. Donor percentage steps use native integer price rounding and explicit unit caps and total budgets. Price advice from the donor's external Copilot service is not present in the donor bundle; these consumers accept finite explicit orders and do not claim profitable selection.

The Magic bank CLI passes 41 native cases across 82 bank trips: all 30 NPC spells, seven teleports and four splash or combined cases.
Independent CRC-checked saves confirm exact rune and item costs, reserves, bank return, empty packs, gear, HP99, prayer and retaliation restoration, and no XP outside Magic and Hitpoints.
Iban's Blast spends exactly two staff charges. NPC casting arrives at the exact declared site before checking the target.
Evidence: `.practice/microbot-ports/magic-bank-native-1793590999060/result.json`, `saved-bank-audit.json` and `source-check.json`; all 11,483 recorded dependency hashes remain unchanged during the check.
Conditions: members practice, 100 ms ticks, XP rate 1, combat, Magic, Prayer and Agility 99, owned staves and native spell unlocks, and 40 observed Quest Points for Champions Guild access. These are finite practice proofs, not live repeat release.

The Nature CLI passes two bank trips: four essence become eight banked Nature runes, with two essence reserved and 36 Runecraft XP.
The talisman, 15 coins, gold bar, HP99, other XP and empty final pack/equipment pass the saved-state audit. Prayer and retaliation are restored; logout passes.
The route uses the native Shilo wooden gate, metal gate and broken cart in both directions. It rejects partial path endpoints and uses the existing coastal pathfinder.
Evidence: `.practice/microbot-ports/nature-trip-native-1793585025334/proof.json`, `saved-bank-audit.json` and `source-check.json`; 11,432 recorded dependency files remain unchanged during the check.
Conditions: members practice, 150 ms ticks, XP rate 1, all relevant skills 99, completed Rune Mysteries and Shilo Village, declared melee protection through the undead enclosure. Lower-combat and live repeat release remain unqualified.

All four native orb routes pass two bank/refill trips each. Earth, air, fire and water each bank two charged orbs.
The saved bank retains two raw orbs and the owned gold bar reserve per account. Packs are empty.
Attack, Defence, Strength, Hitpoints and Ranged XP remain unchanged. Each account restores its original retaliation setting and logs out.
Evidence: `.practice/microbot-ports/orb-native-1793590776688/proof.json`, `saved-bank-audit.json` and `source-check.json`; five cases cover the four default routes and an owned air staff with paid spell return. The worker also passes two air-orb trips with an owned air staff, finite native run energy, ordinary energy doses and an owned charged Glory. Its saved assets prove two charged orbs banked and Glory charges reduced from four to two, with exact rune costs, reserve items, restored controls and logout. Evidence: `.practice/microbot-ports/orb-native-finite-energy-1793589741862/proof.json`, `saved-bank-audit.json` and `source-check.json`; both checks retain 11,427 unchanged dependency files.
These are finite members practice routes. Live repeat release and encounters with other players remain unqualified.

The Chompy CLI passes two bank/refill trips. It banks two raw Chompies and 38 feathers, spends four arrows, recovers three and uses two prayer doses. Native ticks and CRC-checked saves reconcile bellows, bait, ammo, potion containers, all assets, 80 Ranged XP, 26.5 Hitpoints XP, HP99, original gear, prayer and retaliation. The final recorded game state confirms the original unarmed combat style 2; the native server does not persist this setting in its save. Logout passes. Evidence: `.practice/microbot-ports/chompy-bank-native-1793590661874/saved-bank-audit.json`, `tick-oracle.json` and `source-drift.json`; 11,209 dependency files remain unchanged. Conditions: members practice, 80 ms ticks, XP rate 1, combat and Prayer 99, completed Chompy quest, owned bow/arrows/bellows, declared melee protection, prayer-bonus gear and two owned four-dose prayer potions. The independent audit checks the native save rules; the fixture's failed saved-style expectation remains in `result.json`. Live repeats and lower-budget kits remain unqualified. Optional finite energy use has a separate three-case actual-CLI proof: `.practice/microbot-ports/chompy-energy-native-1793602576994/result.json`, with per-case `tick-oracle.json`, CRC saves and `source-drift.json`; 11,220 recorded source/config files remain unchanged, including 311 worker-closure files and Chompy source `52c5d16d098d5affe9327e8e4194a79b18862234832225eb31bc8eb337e2ae39`. With `NODE_INFINITE_RUN=false`, maximum two uses below99 and one owned energy supply staged per kill, ordinary energy uses two doses for +10 each and banks two raw/28 feathers; super energy uses two doses for +20 each and banks two raw/42 feathers; two strange fruits give +30 each and bank two raw/38 feathers. Ordinary/super cases return one full and one half-dose bottle; the fruit case continues after proved local depletion and refills for its second trip. Prayer doses are3/3/2, shots4/5/6 are all recovered, Ranged XP is80 each and Hitpoints XP is26.4/26.4/26.3. All three retain HP99, exact assets, original gear/prayer/retaliation and observed style2, empty packs, final bank and logout. Whole-pack/fresh potion text and measured receipt-interval passive recovery bound consumption; unknown stock or effects stop without another input. These are scoped gameplay proofs, not a speed comparison; modern stamina, other thresholds/kits/camps and live repeats remain outside qualification.

The mining drop CLI discards 26 declared iron ores, retains its owned Rune pickaxe, then mines two ores for 70 Mining XP in 63 ticks. The general looter CLI collects four owned public Law runes and banks all four over two trips. Exact saved assets, other XP, HP99 and logout pass for the miner, drop supplier and collector. Evidence: `.practice/microbot-ports/mining-loot-native-1793593331707/result.json` and `source-check.json`. These checks use staged native sites and finite orders; they do not qualify unattended collection from contested drops.

Progressive bank mining crosses the native level-15 threshold, banks one Tin ore, reselects Iron and banks one Iron ore in 256 ticks. Exact saved assets, 52.5 Mining XP, zero other XP, HP99, gear, bank return and logout pass. Evidence: `.practice/microbot-ports/mining-progressive-native-1793593506494/saved-bank-audit.json` and `source-check.json`; 11,209 dependencies remain unchanged. The independent audit treats absent and empty equipment containers as the same empty gear state; the fixture's failed representation comparison remains in `result.json`. Conditions: members practice, 100 ms ticks, XP rate 1, Mining one XP below level 15, a bank-owned Bronze pickaxe and declared Tin/Iron sites at Varrock. The combined progressive/drop CLI also passes the same tier change: it discards 26 declared Tin ores, retains the pickaxe and 37 coins, then holds one Tin and one Iron ore at the declared Iron site after 133 ticks. Exact saved assets, raw XP, HP, controls and logout pass in `.practice/microbot-ports/mining-progressive-drop-native-1793594537246/result.json` and `source-check.json`, with 11,209 unchanged dependencies. Higher-tier routes and other kits need their own native qualification.

The GE-valued looter passes an actual owned trade and pickup case. Two Law runes trade at four coins each; the collector selects their public pile at total value eight with a strict pile minimum five and strict unit maximum five, then banks both. Native static value 240 per rune would reject this pile. All three actors preserve exact assets, XP and HP99 and log out. Evidence: `.practice/microbot-ports/loot-ge-native-1793592861851/result.json` and `source-check.json`; 11,211 dependency files remain unchanged. Quotes cover a declared universe of at most 16 native items and remain fixed for the finite job; they do not assert present fair value or outside liquidity.

Offensive prayer flicking passes the actual cow worker, bank return and saved-state audit. Both flick and hold accounts bank one hide, bones and beef. Flicking spends zero prayer points across 23 reset cycles and 24 observed same-target attack resumptions; the held-prayer control spends 11 points. Exact stock, HP99, original prayer and logout pass. Evidence: `.practice/microbot-ports/prayer-flick-native-resume-1793593343250/result.json` and `source-check.json`; 11,198 dependencies remain unchanged. Conditions: members practice, 100 ms ticks, XP rate 1, Attack 20, Strength 1, Defence/Hitpoints/Prayer/Agility 99, owned bronze sword/shield and two trout. This is an action and resource proof, not a speed comparison or incoming-damage protection.

The player monitor passes a two-owned-player native check. Its wilderness-only filter skips a town peer without input. With that filter disabled, the same peer triggers one attack-potion action, transforming item 121 into 123 and raising Attack 20 to 25. All assets, zero XP, HP99 and both logouts pass. Evidence: `.practice/microbot-ports/player-monitor-item-native-1793592083801/result.json` and `source-check.json`; 11,193 dependencies remain unchanged. Configured actions need a fresh exact item/menu match and a declared inventory effect.

The charged-Glory escape passes nine native cases: all four destinations, the last charge, a spare owned Glory, wilderness-level-31 refusal, short-budget refusal and escape after an incoming Skeleton hit. The damage case records HP99 to HP97, Skeleton 90 targeting the actor, exact Edgeville arrival, unchanged life and both owned logouts. Each successful escape spends exactly one charge and sends one destination choice. Whole assets, XP and controls reconcile; 11,079 dependencies and the 42 server-cache files remain unchanged. Evidence: `.practice/microbot-monitor-helper/native-1793664204953/result.json`, `source-check.json` and `compiled-cache-ready-check.json`. Interrupted-menu reopening has unit and source checks only; this run uses one Rub per escape. Teleport tablets, other jewelry and live hostile-player escape remain unqualified.

Core travel passes all seven supported ordinary gnome-glider journeys through its public route planner: four departures from the Grand Tree and three returns. Each uses the actual pilot, map 802, one exact destination button and the matching landing, with assets, XP, HP99, equipment, controls and logout reconciled. Evidence: `.practice/microbot-ports/glider-go-to-native-1793665551623/result.json`; source and compiled-cache differences are empty. The eighth direction, completed-quest Digsite to Grand Tree, is blocked by the pilot's explicit refusal in `gnome_glider.rs2:170–175`. The quest-stage-90 crash flight is a separate quest consumer. This proof does not qualify a complete fishing-and-bank journey.

The Kingdom coffer CLI collects 1,020 maple notes and deposits exactly 50,000 owned coins in one native trip. The saved coffer rises from 1,000 to 51,000; 10,000 coins, two gold bars, worn staff, HP99 and all XP remain exact. Logout passes. Evidence: `.practice/microbot-ports/next-native-gaps/misc-coffer-native-1793589000895/result.json` and `source-drift.json`. Conditions: members practice, a completed native quest, the native kingdom-visit flag, 2,048 resource points and ten wood workers. This proves collection of existing resources; it does not prove daily resource accrual or bank delivery.

The shared Telegrab loot action passes a native bank-loop check with two owned actors. One actor drops two Law runes behind the Varrock vault; the collector spends one Air and one Law, collects both Law runes and banks the result without moving during the spell. Saved Magic XP rises by 43; other XP, HP99, gear and reserves remain exact, and both actors log out. Evidence: `.practice/microbot-ports/telegrab-native-1793589020023/result.json`. This proves the actual shared loot action composed with the bank loop. A full combat CLI kill route with Telegrab remains unqualified.

Generic druid/giant travel uses [the shared Edgeville transitions](../scripts/microbot-edgeville-travel.ts): native trapdoor1568/1570 at3097,3468 and ladder1755 at3096,9867. The orb floor dispatch is reused with its original export, and the executor is bound before potion-session ownership. Ordinary walks remain on their surface or dungeon region; exact observed transitions, native geometry, original life, whole-pack/gear receipts and bounded waits guard each crossing. The combat CLI rejects invalid finite caps before login. Optional `MAX_KILLS` bounds the full kill/loot/return job, reserves200 ticks for owned bank recovery and preserves the cap-based entry when omitted. Unknown paid loot outcomes park recovery. Stopped cleanup permits only the observed Bank option on pinned native banker types, while new combat, stale NPC identity and out-of-range banker input remain refused. Native NPC binding selects Giant117 or Chaos druid181 with a fresh reachable, free-combat target; the donor Hill giant name is not a native identity. The82 focused checks in `.practice/microbot-ports/edgeville-integration-focused.log` cover route composition, lost replies, unknown outcomes, stop/life/owner replacement, asset changes and orb/loot/potion compatibility. Stopped cleanup passes the natural Shilo banker499 BankOP3 case in `.practice/microbot-ports/combat-alch-native-1793843649710/result.json`: one banker input,banked37 coins and one untouched Attack potion,zero paid casts/doses,whole CRC assets/zeroXP and logout. The separate96-tick surface return in `.practice/microbot-ports/combat-alch-native-1793843677988/result.json` observes core's stop callback during87 walking ticks and banks the same stock. Each checks11,545 unchanged source entries; the short Shilo case does not claim the25-tick callback. The actual generic CLI passes one Giant117 kill and banks its big bone in `.practice/microbot-ports/combat-alch-native-1793843146714/result.json`: trapdoor entry, ladder return, exact saved Attack/Hitpoints XP, original solo life, whole assets/gear, declared bank position and confirmed logout. Minimum HP is99;11,545 source entries remain unchanged. Conditions are Rune kit, relevant skills99,150ms shared Native server and XP25. Shared-server evidence binds admission disk bytes, not a fresh engine-load hash. Druid, lower-level, live and unattended repeats remain unqualified. Gameplay uses the guarded cleanup view; final settlement uses the original session so core can close its recorder and retain lifecycle ownership.


The blue dragon route passes a full Falador bank-owned trip through the dusty-key door to the Taverley safespot.
It gains 432 saved Ranged XP, spends 57 bolts and banks bones, one blue hide and 440 coins, with final HP94 and exact asset totals.
Evidence: the blue case in `.practice/microbot-ports/combat-native-final-13-merged-1793596619335/result.json`, `independent-audit.json` and `runtime-source-check.json`; all 11,370 recorded dependencies remain unchanged. Refill repeats, other players and live release remain unqualified.

The KBD rune-sword route passes the full owned bank kit, Wilderness entry, kill, loot, Varrock escape and bank return.
Saved gains are 972 Attack XP, 322.1 Hitpoints XP and 35 teleport Magic XP. It banks bones, black hide and seven Death runes, consumes two sharks including the return route, and finishes with HP71 and an empty pack.
Potion containers, gear, runes and all assets reconcile. The account logs out.
Evidence: the KBD case in `.practice/microbot-ports/combat-native-final-13-merged-1793596619335/result.json`, `independent-audit.json` and `runtime-source-check.json`; all 11,370 recorded dependencies remain unchanged.
A separate stopped entrance-pit case proves legal lever escape and bank return without fighting: `.practice/microbot-ports/combat-native-final-7/2.log`.
Both combat proofs use a members practice server at 100 ms per tick, XP rate 1 and base combat skills 99.
These finite proofs do not qualify lower skill levels, other equipment, contested encounters, death recovery or live repeats.

Finite potion care and Druid pouch filling pass all 23 actual Native CLI cases in `.practice/microbot-ports/potion-prayer-native-1793651405921/result.json`. Worker `8cae6782e71f5379bece8c6996639c7fccef76755c0fc93460dff7b0822df6cf` retains the 13 potion/pouch cases and adds percentage boundaries, disabled care, drop-only-after-dose cleanup, first-owned-family selection, missing-family fallback, no owned family and invalid-policy refusal. Super Restore checks all 18 affected native skills, including Runecraft at slot20; ordinary Restore checks all five affected skills. Independent CRC saves reconcile exact doses, vials, stock, XP0, HP99, gear, bank, controls, position and logout. Invalid mixed policy fails before login. The source check binds 11,515 unchanged files, including 42 compiled server cache files checked at readiness and end. Conditions are members practice, 100ms ticks, XP1, owned stock and declared current/base skills. This qualifies the independent `nmz/PrayerPotionScript.java` helper through the existing worker. It does not qualify the absent NMZ encounter, Moonlight potion, donor wall-clock cadence or live repeats.

Ordinary native furnace smelting passes four actual `smelt-bars.ts` CLI cases in `.practice/microbot-ports/smelt-bars-native-1793655284503/result.json`: silver28 with loads27+1, adamantite6 with loads3+3 and runite5 with loads3+2; missing coal refuses with zero furnace input. Independent raw bank receipts and CRC saves reconcile all ore/coal debits, bars banked, reserve1, exact Smithing XP, other XP0, HP99, gear, controls, bank return and confirmed logout. Runtime hashes are `a9fe72cdbb1bc0afccc161336a77fa549216c4efe789c30e51688fc3b4f42245` for the batch and `6616832c1d99db3d40688f5937d97e44df45cfce66439f0693cf9162e9f8c97f` for the CLI, with guarded canonical settlement through Core `6131ef60c83956881b57854ec035b5d52caa4f3f632daed164f4d53af1eb4683`. All 11,483 captured dependencies remain unchanged. The 57 compiled-cache checks retain identical content, including the ZIP entries; ZIP metadata-only byte changes are recorded separately. Conditions are owned staged stock, members practice, 100ms ticks, XP25, Smithing99 and the Al Kharid bank/furnace. This proves ordinary native furnace bank/refill composition; Blast Furnace mechanics and live repeats remain outside this proof.

Optional smelting gear passes three bounded Native cases in `.practice/microbot-ports/smelt-bars-native-1793686058938/result.json`: two gold bars with owned goldsmith gauntlets, 141 iron bars with a natural forging-ring melt and bank replacement, and an expected partial stop at140 bars with `MAX_RINGS=1`. The first two CLIs exit0; the partial stop exits1 as required. CRC saves and raw actions reconcile whole assets, ore, reserves, restored gear, HP99, home bank and logout. Raw Smithing XP is28100/440625/437500 at XP25. Source11483 and compiled57/server42 contents remain unchanged. The worker does not read private ring charges. Original ring1635 restoration has Native proof; original forging-ring restoration has unit proof. Runtime hashes and exact conditions are in the catalog's `smelting.proof.bonus` record. Other locations, starting conditions and live repeats retain separate qualification gaps.

Declared local smelting has a [Falador silver28 case](../.practice/microbot-ports/smelt-bars-native-1793688250528/result.json), with explicit native furnace and legal stand. [Shilo access](../.practice/microbot-ports/smelt-bars-native-1793690721399/result.json) banks28 silver across26+2 loads with two20coin entries, fresh paid dialogue/landings, free exits and37coins retained. [Nearest selection](../.practice/microbot-ports/smelt-bars-native-1793691426915/result.json) runs the actual CLI with no route JSON from2974,3369, choosing furnace2781 at2975,3368 and bank2947,3368;28 silver across27+1 loads, no fees. Both new cases use members Native practice,100ms ticks,XP25 and Smithing99. Each independently reconciles raw paired bank operations, two CRC saves,95900raw Smithing XP at XP25, otherXP0, whole assets, kit/gear, HP99, controls, home and logout. Shilo/nearest captures check11483/11484source files and57compiled/server42 cache files unchanged. Source hashes and prerequisite conditions are in `smelting.proof.shilo` and `.nearest`; other locations and live repeats remain unqualified.

## Reuse and blockers

Core session admission, owned actions, waits, cancellation, logout, status, replay and bank observations remain their existing consumers.
Existing mining, woodcutting, flax, wool, fish/shark, food, Firemaking, Prayer, rune supply and native quest workers remain in use.
`scripts/agility-order.ts` already covers Gnome, Barbarian and Wilderness courses.
Native quests use `scripts/generated/quest-lib.ts`, quest workers and requirements.
The [Watchtower worker](../scripts/generated/quest-itwatchtower-owned.ts) passes one full Native practice route from quest0 through reward13 and teleport-scroll14. It earns four quest points, raw Magic XP3,825,000 and coins4,980 net. Five wall climbs, two return swings and the paid bridge account for exactly41,500 raw Agility XP at25x. All quest items are earned from ordinary staged ingredients. Tested skills are Attack, Strength, Defence, Hitpoints, Magic, Mining, Herblore, Thieving and Agility99. The account uses no food, keeps one life, reaches minimum HP94, preserves declared stock and gear, and logs out. Evidence: `.practice/microbot-ports/watchtower-native-1793681609878/result.json`; source11,521 and compiled57 contents remain unchanged, excluding ZIP metadata. Heroes and Legends retain full-route qualification work. This is practice proof; live and repeat release remain separate.

The [Trio worker](../scripts/generated/quest-tbwt-owned.ts) passes a Native route from quest0 through all brother rewards: two quest points,2,000 coins,seven paid Monkey casts,exact XP/assets/gear/controls and confirmed logout. Independent CRC and complete raw audits pass in `.practice/microbot-ports/tbwt-native-1793842402151/result.json`; the Tinsay doorway exit reaches Tiadeche for the final Fishing reward. Conditions are Combat99/Agility99,staged ordinary prequest supplies,150ms shared Native server and XP25. All11,534 source entries and42 compiled-cache disk entries remain unchanged. Shared-server evidence binds admission disk bytes,not a fresh engine-load hash. Live,repeat and lower-level conditions remain unqualified.
The existing [smithing worker](../scripts/smith-batch.ts) resolves all 129 native anvil products, including six claw products and dart tips.
Its native quest checks require completed Death Plateau for claws and completed Tourist Trap for ordinary dart admission.
An explicit dart probe permits one attempt for an incomplete quest; refusal returns the bars without another input.
Four native cases cover completed-quest darts, completed-quest claws, learned dart production and a locked dart refusal.
The three production cases each earn 25 Smithing XP. The locked case earns no XP and preserves its bars.
Exact assets, HP99, bank return and logout pass in `.practice/microbot-ports/smith-quest-native-1793596534375/result.json`.
Its `source-check.json` records 11,471 unchanged dependencies during the check. Other products retain source coverage rather than this four-case runtime proof.
See the [project use map](project-use-map.md) for existing utility decisions.

The catalog entry's `review.blockers`, `scriptDecisions`, variants and native evidence own each exact blocker.
Use `--show <name>` for the full record. Do not reduce all partial entries to “unsupported”.

| Boundary | Distinction |
|---|---|
| Missing modern content | Fossil Island ammonites, Wintertodt, Tempoross, Sailing and modern Hunter sites have exact donor requirements and native searches attached to their entries. |
| Different native mechanics | Native Miscellania uses sickle/herb weeding, not the donor rake/fairy-ring route. Native Trawler lacks the enormous-tentacle contribution mechanic. |
| Supported native integration | Bank/refill/escape qualification, guardian mitigation and clue access requirements remain explicit per-consumer gaps. Native full Trawler trip and catch banking have practice proof. Clue handlers and puzzle turn-in mappings have finite consumers. |
| GE policy | Native buy lists, explicit price-plan relisting, Finish and owned escrow recovery have finite native proof. The donor obtains portfolio advice from an external Copilot service; its bundle contains no local price-selection algorithm. Owned matching does not prove outside demand or profitable flipping. |
| Client presentation | Java applets/JARs, Swing, overlays, hotkeys, desktop recordings and OSRS widget constants are not gameplay ports. Underlying game actions have separate decisions. |
| Shared resources | Another owner can hold the practice slot. A blocked qualification does not authorize a second controller, server replacement or account takeover. |
| Evidence | Source inspection, simulated SDK loops, native saved-state proof and live pilots prove different things. Missing native/live proof remains a release gap. |

New bank adapters reject non-bank modals and stale observations before withdrawal.
Per-session native bridges keep the ownership guard and command recorder, then restore the original executor.
Orb dispatch follows native `OPLOCT`; puzzle slides follow native `OPHELD5`.
Message receipts must be fresh native messages. Player chat cannot supply them.
Finite NPC spell batches reject repeating autocast before spending runes.

## Checks and use

```powershell
bun run typecheck
bun test ./scripts ./packages
```

Focused tests live in `scripts/microbot-*.test.ts`. Adapter regressions exercise SDK calls against simulated state, not only recipe arithmetic.
The actual server is required for native effects, saved-state and logout proof. No job is enabled by this research or its tests.

Example finite pie-shell order at a staged bank:

```powershell
$env:MAX_MAKE='5'
$env:CAP='500'
bun scripts/microbot-production.ts <owned-account> pie-shell
```

The [bank-job controller](../scripts/microbot-bank-jobs.ts) reuses the finite workers for eleven job families.
It supports jewellery, cooking, tanning, glass, item magic, inventory production, wine, bones, mining, fishing and stalls.
It withdraws owned inputs, travels to the site, banks the output and refills within one tick budget.
`returnTicks` reserves time for the return. Damage stops production. The controller keeps stock for bank recovery.
Mining and stall jobs require explicit `bank` and `site` tiles. Other families have default sites.
A recipe needs its native skills, membership and quest access. A configured site does not prove access.

For an owned practice actor, put this finite gold-ring order in `job.json`:

```json
{"family":"jewellery","recipe":"gold_ring","target":3,"batch":1,"cap":1200,"returnTicks":250,"members":true,"reserve":1}
```

Stage the actor at Al Kharid bank with four gold bars and one ring mould in its bank.
Use the native Crafting requirement for this recipe. The order keeps one gold bar in reserve.

```powershell
bun scripts/microbot-bank-jobs.ts <owned-practice-account> job.json
```

The protected karambwan route uses the same CLI. This finite order passes Native practice with Fishing, combat, Prayer and Agility99, completed Grand Tree/Jungle Potion/Trio, and real Lubufu vessel access. Supply one vessel3157, seven separate bait3150, and five four-dose prayer potions2434. Keep the potion stock in the bank. The order keeps one bank reserve and permits at most eight doses.

```json
{"family":"fishing","recipe":"karambwan","xpRate":25,"fishingProtection":{"prayer":14,"potionsPerUnit":2,"maximumDoses":8},"target":2,"batch":1,"reserve":1,"cap":2200,"returnTicks":600,"members":true,"bank":{"x":2449,"z":3482,"level":1},"site":{"x":2899,"z":3118,"level":0}}
```

Evidence: `.practice/microbot-ports/karambwan-glider-bank-native-1793668236693/result.json`. Two trips bank two fish through four glider legs, using three bait and two prayer doses. Whole assets, raw Fishing XP52,500 at25x, HP99, equipment, original prayer OFF at bank and logout reconcile. The 54 Shaikahan targeting observations are frames, not attack counts. The check binds 11,584 unchanged dependencies and57 unchanged compiled-cache contents; ZIP metadata is excluded. Other stats, starting sites and live repeat need their own qualification.

The protected Lava route uses the same worker with an owned oily rod1585, dusty key1590, bait313 and worn anti-dragon shield1540. The finite Native order stages five full prayer potions2434 and three full antifire potions2452 in the bank, plus one oily rod, one key and31 bait. One raw eel in the bank is the retained product reserve. The tested account has Fishing, combat, Prayer and Agility99. Real potion effects protect the route; no resistance state is seeded.

```json
{"family":"fishing","recipe":"lava","xpRate":25,"fishingProtection":{"prayer":14,"potionsPerUnit":2,"maximumDoses":16,"antifire":true},"target":2,"batch":1,"reserve":1,"cap":2200,"returnTicks":600,"members":true,"bank":{"x":2945,"z":3369,"level":0},"site":{"x":2889,"z":9765,"level":0}}
```

Evidence: `.practice/microbot-ports/fishing-bank-all-native-1793677817240/result.json`. Two trips bank two eels with two bait, raw Fishing XP30,000 at25x, HP99, unchanged gear and foreign XP, preserved whole stock and reserves, original prayer OFF and logout. Seven doses comprise five prayer and two antifire doses; all partial potions return to the bank. Dusty-key entry, legal adjacent shore, reverse gate/ladder and refill pass. The check binds11,585 unchanged files, including42 compiled-cache files. This qualifies that finite Falador route; other starting sites and live repeat retain separate gates.

`MEMBERS=1` selects an explicit members-world scope. Native content still enforces membership and quest access.
That setting is not proof of a successful action. Read each worker's prerequisites before composing a route.
Live execution requires a qualified release. Main-account launch gates remain authoritative.

## Source and reproduction

The [BSD notice](microbot-ports-LICENSE.txt) covers adapted Microbot-Hub behaviour.
No foreign JVM runtime, anti-ban delay framework or pathfinder is installed.
Native definitions use the SDK base commit `db0cc51e0a8f9f0d6a7d60c44e534412bb0601bb`.
The local vendor checkout has other owners' patches and generated-state changes. A base commit does not bind those bytes.
Qualification must bind the actual source files and runtime release.

Save each pinned tree as `{sha,truncated,paths}`, where `paths` contains every blob path.
With all four decision files present, generate the catalog:

```powershell
bun scripts/microbot-catalog.ts <core-tree.json> <hub-tree.json> research/microbot-ports.json --require-reviewed
```

Raw archives, inspected source, reference checks and test logs stay in `.practice/microbot-ports/`.
The original tree snapshots also exist in that task folder in the main checkout.
Code and review remain on `codex/microbot-ports`, [draft PR 114](https://github.com/Giftedx/rs-sdk-bot/pull/114).

The staged quest CLIs keep their upstream entry paths. The `quest-hero-owned.ts`, `quest-itwatchtower-owned.ts` and `quest-tbwt-owned.ts` modules expose the owned routes. Quest sweep accepts finite options for owned Trio/Watchtower staging; the CLI without options uses its existing preset route. Captured receipts bind their recorded source. The owned Trio receipt includes the merged dependency closure and doorway exit; other merged quest closures retain their separate renewal gaps.

Legends has distinct entries: the [staged CLI](../scripts/generated/quest-legends.ts) accepts main/kit-helper account names; the [owned API](../scripts/generated/quest-legends-owned.ts) accepts its finite order contract. The staged CLI is retained byte-for-byte from master. [PR214](https://github.com/Giftedx/rs-sdk-bot/pull/214) reports three all99 Native completions with prepared helpers at commit16161109. The current CLI strengthens helper logout confirmation after those runs; that delta and the owned API retain separate qualification. Live, minimum levels and helper supply staging remain unqualified.
