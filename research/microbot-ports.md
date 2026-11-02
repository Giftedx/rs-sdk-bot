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

These bounded TypeScript behaviours replace Java loops, mouse input and sleeps with structured SDK actions and observed receipts.
The [script contract](../docs/script-contract.md) owns qualification and release requirements.
New workers have source/unit proof unless a separate native receipt qualifies their exact bytes.

| Behaviour | Consumer | Implemented native scope |
|---|---|---|
| Inventory production | [production](../scripts/microbot-production.ts) | 178 profiles: gems, battlestaves, amulets, leather/dhide, glass, bow cutting/stringing, darts, bolts, herbs, mixtures, dough, pies, cakes, stew and pizza |
| Ordinary wine | [wine](../scripts/microbot-wine.ts) | Grapes/water, fresh bank receipts, fermentation and separate good/bad output audit |
| Furnace glass | [glass](../scripts/microbot-glass.ts) | Staged sand/ash, glass, returned buckets and XP |
| Bones to Bananas | [bones](../scripts/microbot-bones.ts) | Finite bank order and exact rune/bone/banana/XP receipts, including native staff substitution |
| Item spells | [item magic](../scripts/microbot-magic-items.ts) | Low/high alchemy, eight Superheat metals and native jewellery conversions |
| NPC spells | [NPC magic](../scripts/microbot-magic-npc.ts), [bank trips](../scripts/microbot-magic-trip.ts) | All 30 player spells, required staves and unlock checks, splash observations, serial alchemy/teleport combinations, finite refills and declared return teleport |
| Teleports | [teleports](../scripts/microbot-magic-teleport.ts) | Seven native destinations with rune/XP/location receipts |
| Action graphs | [actions](../scripts/microbot-a-actions.ts) | Typed target resolvers, declared effects, bounded success/failure edges; no source-code evaluation |
| Cannonballs | [cannonballs](../scripts/microbot-a-cannonballs.ts) | Al Kharid bank/furnace/return, four balls per bar, mould and bank proof |
| Chompies | [Chompy](../scripts/microbot-chompy-trip.ts) | Owned bank kit, finite post-quest bellows/toad/bait/own kill/pluck trips, product banking and original gear/style restoration |
| Blue dragons | [ranged camp](../scripts/microbot-a-ranged-camp.ts) | Bank-owned kit, Taverley key door, safespot, own kill/drop receipts, declared escape and loot banking |
| GE sales | [owned GE sale](../scripts/sell-owned-ge-item.ts), [bank trip](../scripts/microbot-ge-trip.ts) | Staged seller handles partial/full fills, fees, cancellation and collection; bank adapter adds durable lot intent, escrow recovery before bank access, finite return and exact replay asset audit |
| GE suggestions | [price plan](../scripts/microbot-ge-plan.ts) | Finite explicit price suggestions, settle-before-relist, remaining-stock and per-offer tax accounting; Finish retains a freshly observed owned sell offer and reports its escrow separately from banked output |
| GE buy lists | [buy list](../scripts/microbot-ge-buy-list.ts) | Exact native item list, donor percentage steps, explicit unit caps and total budget, durable sequential owned-buy recovery and bank checks |
| Merchant sales | [shop trips](../scripts/microbot-shop-trip.ts) | Finite owned bank lots, native generic or declared custom Trade shops, observed titles/quotes, floor/reserve checks and exact returns; private inventory IDs remain unobserved |
| Nature runes | [Nature trips](../scripts/microbot-rune-trip.ts) | Shilo bank, owned essence/talisman, native ruins/altar/portal, finite refills and rune/XP/asset audit; observed member and quest entry required |
| Nature chest | [chest](../scripts/microbot-b-nature-chest.ts) | Staged trap search, bounded attempts and rune/coin/XP receipts |
| Pickpocketing | [pickpocket](../scripts/microbot-a-pickpocket.ts) | All 12 native target profiles and 39 NPC IDs, multi-row rewards, native failure damage/stun and food accounting |
| Mining | [mining](../scripts/microbot-b-mining.ts), [drop mode](../scripts/microbot-mining-drop.ts), [progressive tiers](../scripts/microbot-mining-progressive.ts) | Native depleting profiles, explicit retained items and exact drop receipts; highest unlocked donor tier reselected after each finite batch on declared native bank/site routes; bank progression and at-site drop mode have separate native cases |
| Essence banking | [essence](../scripts/gather-essence.ts) | Existing mine/portal/Varrock bank loop, all six native picks, fastest eligible owned bank upgrade, native base-Attack wield checks, fresh bank receipts and conserved inferior tools |
| Ground collection | [looting](../scripts/microbot-b-mining-loot.ts), [bank trips](../scripts/microbot-loot-trip.ts) | Visible ID/name/value filters, whole-pile capacity, exact inventory and bank credits; optional bounded native GE quote snapshots and donor strict pile-minimum/unit-maximum rules; no kill-ownership claim |
| Telegrab loot | [combat loot](../scripts/microbot-telegrab.ts) | Optional finite paid collection of wanted walk-unreachable piles in existing combat and Ranged consumers; native capacity, life, range, rune, XP and exact item receipts; ordinary pickup remains the default |
| Fishing | [fishing](../scripts/microbot-b-fishing.ts) | Eight native methods, including karambwan rebaiting; shark uses the existing worker |
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
| Offensive prayer flicking | [combat prayer](../scripts/microbot-prayer-flick.ts) | Finite observed OFF/ON resets during the existing cow worker; original life and prayer ownership, uncertain-outcome stop and observed restoration; no incoming protection or attack prediction |
| Clues | [clue steps](../scripts/microbot-c-clues.ts) | Exact native definitions and supported clue transitions; per-definition gaps retained |
| Clue puzzles | [puzzles](../scripts/microbot-c-clue-puzzle.ts) | Existing Monkey Madness solver, native board, recorded slides and mapped staged turn-ins |
| Clue guardians | [guardians](../scripts/microbot-c-clue-guardian.ts) | All 30 native guardian/casket mappings, new own-target binding and repeat-dig credit; actual fights remain unqualified |

All 276 native clue descriptors identify an executor and entry ID.
They contain 222 direct steps, 30 guardian steps, 18 puzzle originals/boxes and six challenge companion items linked to their original clue.
The direct steps contain 42 digs, 68 searches, 32 talks, six numeric challenges and 74 casket opens.
Source mappings do not prove that their access routes, guardian mitigation or runtime observations pass on the server.

Inventory production banks each confirmed product and returned container. Fragile gem failures count as losses.
Thread debits zero or one per native five-use cycle. Multi-output recipes require an explicit output batch multiple.
Ten darts are ten products, not ten recipe actions. Bank-per-action production has no throughput qualification.

Staged workers require the stated site, access, skills, tools, runes, food and owned inputs.
Output remains held unless the worker explicitly proves banking. A staged result does not prove an unattended bank/refill route.
Existing walking, supply and chain workers can compose these jobs. Untested compositions remain unqualified.

## Native practice proof

The actual CLI passes all 178 unique inventory-production profiles at a staged Al Kharid bank, with 298 products banked.
The independent saved-state audit checks exact inputs, products, returned containers, optional thread, XP, HP and confirmed logout.
The large-oyster command is `bolt-tips:pearl_bolttips:bigoysterpearls`; it produces 24 tips. The small-oyster command produces 6.

The staged native checks also pass all 23 furnace-jewellery recipes, 21 item-spell profiles, six tanning recipes and furnace glass.
They check saved item/coin/XP changes and logout. They do not prove travel, replenishment or live release.
Native cooking passes all 55 useful table rows and 16 gnome ingredient cases, including its fire-only row and Tinsay reward gate.
Thorough karambwan requires the private native Tinsay reward state; otherwise the server cooks the poisonous variant.
Gnome toad variants can publish XP one tick ahead of their item change; XP alone never credits output.

Evidence stays in `.practice/microbot-ports/native-sweep-3/`, `native-furnace-cooking/`, `native-magic-tanning/` and `native-cooking-final/`.
Each directory holds worker hashes, actual CLI logs and CRC-checked saves. The inventory sweep also holds `saved-audit.json`.
These runs use a separate members practice server at 150 ms per tick, XP rate 1, required skills 99 and staged owned fixture stock.
Worker hashes bind the recorded entry files. These receipts do not bind every imported runtime byte or qualify an unattended release.
Retained failed and incomplete fixtures remain failures; a wrapper exit code alone is not proof.

Wine and Bones to Bananas pass a separate bank check with five finished products each, no held output, unchanged coins and HP, and confirmed logout.
The saved XP gains are 550 Cooking and 25 Magic. Bones banking waits through the native spell delay and the following publication boundary.
Evidence: `.practice/microbot-ports/native-bank-final-2/`, including the independent `saved-audit.json`.
This run also binds and rechecks 11,034 core, SDK, engine and content files, with worker hashes in `result.json`.
It remains a bounded staged practice result, not live or unattended release.

The bank-job controller passes all eleven supported job families in one native batch.
All eleven records in `.practice/microbot-ports/bank-job-native-profile-refactor-1793584619841/result.json` pass with the exact recipes and outcomes.
Moving jobs complete three separate bank/site trips. The saved assets, HP, XP and logout checks pass for each family.
All 11,507 recorded dependency hashes remain unchanged. Cannonballs have a separate proof.
These are bounded members practice runs at 150 ms per tick and XP rate 1.
They prove the listed recipe/site combinations. Other locations, access requirements and live repeat release remain separate checks.

The existing cannonball worker passes three steel bars to twelve banked balls.
Its saved mould, coins and HP remain unchanged. Saved integer Smithing XP increases by 112, and logout is confirmed.
Evidence: `.practice/microbot-ports/cannon-native-final/result.json`; all 11,347 recorded dependency hashes remain unchanged.

The full legacy Trawler CLI wins and banks all five catch items: raw manta ray, raw lobster, raw shark, glass and a pot.
It uses 96 paste and two ropes, fills 63 buckets and keeps HP at 50.
The trip takes 1,656 ticks. Saved integer Fishing XP increases by 317 and Crafting XP by 10.
Net excursions require zero visible leaks and water≤10. Each attempt returns to the hold before another net trip.
A separate test with the same source banks all 40 overflow items.
The urgent GUI remainder returns within 100 ticks. An owned 12-item relay returns within 300 ticks and becomes public after 100 ticks.
Both runs pass exact saved-asset, CRC and logout checks. All 11,191 recorded dependency hashes remain unchanged.
Evidence: `.practice/microbot-ports/trawler-{native-1793563470312,overflow-1793563483732}/result.json`.
These are bounded members practice runs at 80 ms per tick and XP rate 1.
Other crew conditions, throughput and live repeat release remain unqualified.

Merchant sales use a fresh native Value response before each unit. The SDK's base price does not include native shop-stock changes.
The Al Kharid CLI sells four bronze daggers across two bank trips for 13 coins and keeps two daggers reserved.
The Dommik CLI sells four ring moulds across two bank trips for 12 coins. Exact saved assets, empty packs, HP and logout pass for both.
Evidence: `.practice/microbot-ports/shop-trip-native-1793583304870/` and `dommik-trip-native-1793583338643/`, including `proof.json`, `saved-bank-audit.json` and `source-check.json`.
Conditions: isolated members practice server, 150 ms ticks, XP rate 1, owned stock and native shop contracts. These runs do not qualify contested prices, other merchants or live repeats.

The GE bank adapter passes partial and full native matching, cumulative tax, lost placement/cancel/collect replies, relog recovery and exact bank return.
The partial three-log lot sells two, banks 192 net coins and the unsold log, and retains two reserved logs. Recovery uses one initial withdrawal across three sessions.
The full actual CLI lot banks 96 net coins and retains two reserved logs. Both settled replays prohibit market and withdrawal calls.
Both owned accounts log out with empty packs and exact saved bank totals, including their gold bars.
Evidence: `.practice/microbot-ports/ge-trip-native-1793593287177/proof.json`, `saved-bank-audit.json` and `runtime-check.json`; 11,410 runtime dependencies and 306 worker closure files remain unchanged during the check.
Conditions: members practice at 150 ms per tick, XP rate 1, fixed owned lots and resting owned buy offers. These checks prove finite execution, not outside demand, profitable trading or live release.

The explicit GE price plan passes malformed-journal failure logout, Finish, fresh resting-offer replay, cancel/collect/relist, full actual CLI and stopped-order checks. Its three-log order fills one at 119 coins, then relists and fills two at 101 coins: gross 321, per-offer tax 15 and net 306. During Finish, the two remaining logs and 114 collectable coins stay reported as unsettled escrow, not banked output. Terminal replay makes no market or withdrawal calls. Exact CRC-checked assets, reserves, gear, HP and logout pass. Evidence: `.practice/microbot-ports/ge-trip-native-1793594882322/proof.json` and `runtime-check.json`; 11,483 runtime and 307 worker files remain unchanged.

The configured buy-list CLI buys and banks two Logs and three Air runes for five coins from owned resting sellers. A lost-placement case recovers two of three requested Logs, banks the exact partial result, skips the next item and never withdraws again; settled replay makes no market calls. Exact CRC-checked assets, zero XP, HP99 and logout pass. Evidence: `.practice/microbot-ports/ge-buy-list-native-1793593054350/proof.json` and `source-check.json`; 11,417 dependencies remain unchanged. Donor percentage steps use native integer price rounding and explicit unit caps and total budgets. Price advice from the donor's external Copilot service is not present in the donor bundle; these consumers accept finite explicit orders and do not claim profitable selection.

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

The Chompy CLI passes two bank/refill trips. It banks two raw Chompies and 38 feathers, spends four arrows, recovers three and uses two prayer doses. Native ticks and CRC-checked saves reconcile bellows, bait, ammo, potion containers, all assets, 80 Ranged XP, 26.5 Hitpoints XP, HP99, original gear, prayer and retaliation. The final recorded game state confirms the original unarmed combat style 2; the native server does not persist this setting in its save. Logout passes. Evidence: `.practice/microbot-ports/chompy-bank-native-1793590661874/saved-bank-audit.json`, `tick-oracle.json` and `source-drift.json`; 11,209 dependency files remain unchanged. Conditions: members practice, 80 ms ticks, XP rate 1, combat and Prayer 99, completed Chompy quest, owned bow/arrows/bellows, declared melee protection, prayer-bonus gear and two owned four-dose prayer potions. The independent audit checks the native save rules; the fixture's failed saved-style expectation remains in `result.json`. Live repeats and lower-budget kits remain unqualified.

The mining drop CLI discards 26 declared iron ores, retains its owned Rune pickaxe, then mines two ores for 70 Mining XP in 63 ticks. The general looter CLI collects four owned public Law runes and banks all four over two trips. Exact saved assets, other XP, HP99 and logout pass for the miner, drop supplier and collector. Evidence: `.practice/microbot-ports/mining-loot-native-1793593331707/result.json` and `source-check.json`. These checks use staged native sites and finite orders; they do not qualify unattended collection from contested drops.

Progressive bank mining crosses the native level-15 threshold, banks one Tin ore, reselects Iron and banks one Iron ore in 256 ticks. Exact saved assets, 52.5 Mining XP, zero other XP, HP99, gear, bank return and logout pass. Evidence: `.practice/microbot-ports/mining-progressive-native-1793593506494/saved-bank-audit.json` and `source-check.json`; 11,209 dependencies remain unchanged. The independent audit treats absent and empty equipment containers as the same empty gear state; the fixture's failed representation comparison remains in `result.json`. Conditions: members practice, 100 ms ticks, XP rate 1, Mining one XP below level 15, a bank-owned Bronze pickaxe and declared Tin/Iron sites at Varrock. The combined progressive/drop CLI also passes the same tier change: it discards 26 declared Tin ores, retains the pickaxe and 37 coins, then holds one Tin and one Iron ore at the declared Iron site after 133 ticks. Exact saved assets, raw XP, HP, controls and logout pass in `.practice/microbot-ports/mining-progressive-drop-native-1793594537246/result.json` and `source-check.json`, with 11,209 unchanged dependencies. Higher-tier routes and other kits need their own native qualification.

The GE-valued looter passes an actual owned trade and pickup case. Two Law runes trade at four coins each; the collector selects their public pile at total value eight with a strict pile minimum five and strict unit maximum five, then banks both. Native static value 240 per rune would reject this pile. All three actors preserve exact assets, XP and HP99 and log out. Evidence: `.practice/microbot-ports/loot-ge-native-1793592861851/result.json` and `source-check.json`; 11,211 dependency files remain unchanged. Quotes cover a declared universe of at most 16 native items and remain fixed for the finite job; they do not assert present fair value or outside liquidity.

Offensive prayer flicking passes the actual cow worker, bank return and saved-state audit. Both flick and hold accounts bank one hide, bones and beef. Flicking spends zero prayer points across 23 reset cycles and 24 observed same-target attack resumptions; the held-prayer control spends 11 points. Exact stock, HP99, original prayer and logout pass. Evidence: `.practice/microbot-ports/prayer-flick-native-resume-1793593343250/result.json` and `source-check.json`; 11,198 dependencies remain unchanged. Conditions: members practice, 100 ms ticks, XP rate 1, Attack 20, Strength 1, Defence/Hitpoints/Prayer/Agility 99, owned bronze sword/shield and two trout. This is an action and resource proof, not a speed comparison or incoming-damage protection.

The player monitor passes a two-owned-player native check. Its wilderness-only filter skips a town peer without input. With that filter disabled, the same peer triggers one attack-potion action, transforming item 121 into 123 and raising Attack 20 to 25. All assets, zero XP, HP99 and both logouts pass. Evidence: `.practice/microbot-ports/player-monitor-item-native-1793592083801/result.json` and `source-check.json`; 11,193 dependencies remain unchanged. Configured actions need a fresh exact item/menu match and a declared inventory effect; this does not qualify teleport tablets or multi-page jewelry dialogs.

The Kingdom coffer CLI collects 1,020 maple notes and deposits exactly 50,000 owned coins in one native trip. The saved coffer rises from 1,000 to 51,000; 10,000 coins, two gold bars, worn staff, HP99 and all XP remain exact. Logout passes. Evidence: `.practice/microbot-ports/next-native-gaps/misc-coffer-native-1793589000895/result.json` and `source-drift.json`. Conditions: members practice, a completed native quest, the native kingdom-visit flag, 2,048 resource points and ten wood workers. This proves collection of existing resources; it does not prove daily resource accrual or bank delivery.

The shared Telegrab loot action passes a native bank-loop check with two owned actors. One actor drops two Law runes behind the Varrock vault; the collector spends one Air and one Law, collects both Law runes and banks the result without moving during the spell. Saved Magic XP rises by 43; other XP, HP99, gear and reserves remain exact, and both actors log out. Evidence: `.practice/microbot-ports/telegrab-native-1793589020023/result.json`. This proves the actual shared loot action composed with the bank loop. A full combat CLI kill route with Telegrab remains unqualified.


The blue dragon route passes a full Falador bank-owned trip through the dusty-key door to the Taverley safespot.
It gains 428 saved Ranged XP, spends 43 bolts and banks bones, one blue hide and one Adamantite ore (449), with HP99 and exact asset totals.
Evidence: `.practice/microbot-ports/combat-native-final-12-blue-1793593404915/result.json`, `independent-audit.json` and `runtime-source-check.json`; all 11,366 recorded dependencies remain unchanged. This fixture contains only the blue-dragon case. Refill repeats, other players and live release remain unqualified.

The KBD rune-sword route passes the full owned bank kit, Wilderness entry, kill, loot, Varrock escape and bank return.
Saved gains are 984 Attack XP, 326.1 Hitpoints XP and 35 teleport Magic XP. It banks bones, black hide and 310 Bronze arrows, consumes six sharks including the return route, and finishes with HP86 and an empty pack.
Potion containers, gear, runes and all assets reconcile. The account logs out.
Evidence: `.practice/microbot-ports/combat-native-final-11-1793592818359/result.json`, `independent-audit.json` and `runtime-source-check.json`; all 11,366 recorded dependencies remain unchanged. This fixture contains only KBD.
A separate stopped entrance-pit case proves legal lever escape and bank return without fighting: `.practice/microbot-ports/combat-native-final-7/2.log`.
Both combat proofs use a members practice server at 100 ms per tick, XP rate 1 and base combat skills 99.
These finite proofs do not qualify lower skill levels, other equipment, contested encounters, death recovery or live repeats.

## Reuse and blockers

Core session admission, owned actions, waits, cancellation, logout, status, replay and bank observations remain their existing consumers.
Existing mining, woodcutting, flax, wool, fish/shark, food, Firemaking, Prayer, rune supply and native quest workers remain in use.
`scripts/agility-order.ts` already covers Gnome, Barbarian and Wilderness courses.
Native quests use `scripts/generated/quest-lib.ts`, quest workers and requirements.
Main-checkout `scripts/smith-batch.ts` supplies configurable native smithing. Its catalog entry records its external path and hash.
Integration remains with that source's owner. It is not duplicated here.
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
