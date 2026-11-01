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
| NPC spells | [NPC magic](../scripts/microbot-magic-npc.ts) | Damage/debuff/bind spells, splash observations and serial alchemy/teleport combinations |
| Teleports | [teleports](../scripts/microbot-magic-teleport.ts) | Seven native destinations with rune/XP/location receipts |
| Action graphs | [actions](../scripts/microbot-a-actions.ts) | Typed target resolvers, declared effects, bounded success/failure edges; no source-code evaluation |
| Cannonballs | [cannonballs](../scripts/microbot-a-cannonballs.ts) | Al Kharid bank/furnace/return, four balls per bar, mould and bank proof |
| Chompies | [Chompy](../scripts/microbot-a-chompy.ts) | Staged post-quest bellows/toad/bait/own kill/pluck/pickup |
| Blue dragons | [ranged camp](../scripts/microbot-a-ranged-camp.ts) | Staged safespot, own kill/drop receipts and return to safespot |
| Merchant sales | [shop sale](../scripts/microbot-a-shop-sell.ts) | Explicit shop/item/quantity/floor/reserve and exact asset receipts |
| Nature chest | [chest](../scripts/microbot-b-nature-chest.ts) | Staged trap search, bounded attempts and rune/coin/XP receipts |
| Pickpocketing | [pickpocket](../scripts/microbot-a-pickpocket.ts) | All 12 native target profiles and 39 NPC IDs, multi-row rewards, native failure damage/stun and food accounting |
| Mining | [mining](../scripts/microbot-b-mining.ts) | Native depleting ore/metal/gem/limestone/quest profiles and perfect-gold context; essence reuses its existing worker |
| Ground collection | [looting](../scripts/microbot-b-mining-loot.ts) | Visible ID/name/static-value filters, whole-pile capacity and exact inventory credits; no kill-ownership claim |
| Fishing | [fishing](../scripts/microbot-b-fishing.ts) | Eight native methods, including karambwan rebaiting; shark uses the existing worker |
| KBD | [KBD](../scripts/microbot-b-kbd.ts) | One staged encounter, explicit gear/potion/prayer policy, attributed drops and emergency teleport |
| Furnace jewellery | [jewellery](../scripts/microbot-b-jewellery.ts) | All 23 native gold/perfect-gold/silver recipes and native menu/asset receipts |
| Cooking | [cooking](../scripts/microbot-b-cooking.ts) | Native useful cooking table, heat restrictions, cooked/burnt accounting and containers |
| Legacy Trawler | [Trawler](../scripts/microbot-b-trawler.ts) | Staged net repair, leak patching and bailing; not the complete trip/reward controller |
| Tanning | [tanning](../scripts/microbot-c-tanner.ts) | All six native outputs with hide/coin/product receipts |
| Orb charging | [orbs](../scripts/microbot-c-orbs.ts) | Four obelisks, native staff costs and recorded spell-on-location dispatch |
| Stall theft | [stalls](../scripts/microbot-c-stalls.ts) | All 13 native stall rows, loot/XP and stock checks |
| Player monitor | [monitor](../scripts/microbot-c-player-monitor.ts) | Finite radius/ignore/new-player policy, stop or confirmed logout |
| Kitten/kingdom care | [care](../scripts/microbot-c-care.ts) | Owned kitten feed/wool/stroke; Miscellania herb weeding with sickle and Herblore 35 |
| QOL actions | [QOL](../scripts/microbot-c-qol.ts) | Finite special attack, prayer hold/restoration and owned cannon refill |
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
| Supported native integration | Bank/refill/escape routes, guardian mitigation, clue access requirements and full Trawler rewards remain explicit integration or qualification gaps. Clue handlers and puzzle turn-in mappings have finite consumers. |
| GE policy | SDK sell/search/place/cancel/collect exists. Owned sale-order escrow/recovery and portfolio repricing remain policy/integration work alongside the GE owner's PR. Protocol availability does not prove profitable flipping. |
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
