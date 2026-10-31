> Current authority: all gameplay techniques are authorized. Wine, cocktails, pyre oil, Charge, relogs and tick manipulation need no further approval. Missing supplies create acquisition work, never a route exclusion. See [AGENTS.md](../AGENTS.md).

# Project use map

Decision map. Scope: projects/providers named across repository research, supplied PDFs and the user's list. This is a consolidation, not a claim that every lead was inspected or that all available projects were found. Detailed evidence stays in [ecosystem](botting-ecosystem-2026-10-23.md), [wider ecosystem](wider-ecosystem.md), [local upstream review](community-and-upstream.md), [web research](web-research.md) and [discovery records](../.practice/ecosystem-pdfs/discovery-20261026.json).

## Find and port a solution

**Implementation:** [source decisions and actual integrations](repo-reuse.md). Rewrites reach worker cancellation/session cleanup, real tick dispatch, quest food/walking, finite nonbronze smelting, directed resource-aware routes, cache integrity, counted gear, cumulative GE accounting and exact drop ranges. Local native observations prove27essence->27air runes and an exact2gold-bar order with1ore reserved; saved bytes and source hashes are linked. Coverage, failed attempts, final check state and remaining source comparisons stay explicit there. Named boundary review does not mean every file was read. Live workers and release holds remain unchanged.

Apply the [research-first gate](../AGENTS.md#research-first-gate) when choosing or changing an approach. Continue from an inspected decision while its assumptions hold. This map selects code to inspect; summaries alone do not validate a port.

**Source audit:** [catalog](../.practice/reuse-source-audit/manifest.json) records current commit/tree IDs for all27 requested projects and two additional script collections. Per-project JSON contains searchable paths. [Saved sources](../.practice/reuse-source-audit/sources.json) records61 selected files, immutable URLs and SHA-256; [local sources](../.practice/reuse-source-audit/local-sources.json) records9 files from existing clones, their commits and clean status. These are reference snapshots, not installed dependencies. Explv tiles returned a truncated tree; coverage is incomplete. A tree proves a path exists, not its behaviour. Only the implementation examples below received focused code reads.

OpenOSRS automation follow-up: [public/premium/mirror classification and exact port candidates](botting-ecosystem-2026-10-23.md#openosrs-automation-and-paid-source-leads). Prioritize combat action arbitration and cancellable task lifecycles; keep our stronger transfer receipts. No verified premium-source release or leak found.

Lost City/RS2-specific donors: [revision-aware source check](botting-ecosystem-2026-10-23.md#rs2--lost-city-focused-source-check). Headless navigation fixtures and stock-driven server-bot handoffs merit selective adaptation; privileged server recovery is not client behaviour.
Offline adoption check: `packages/planner/test/supply-route.test.ts` checks24 fare/food boundary combinations and14 invalid-evidence mutations across both legs. Existing courier/receipt integration:16 tests pass,122 assertions. Runtime source pin unchanged. This proves budget/fallback behaviour only, not tile reachability or live throughput; no new pathfinder is justified by these results.


### Practical reuse queue

**Deeper pass:** [seven-repository catalog](../.practice/reuse-source-audit/deep/manifest.json), [33 saved files](../.practice/reuse-source-audit/deep/sources.json). New leads: BotWithUs XAPI, Loadout Lab and the bank-aware DPS optimizer. Four existing leads now have pinned implementation samples. Files were read, not executed; tests below are inspected upstream tests, not passing local tests. The original27-project table remains the inventory; this queue is the implementation shortlist.

| Current gap | Read this exact source | Rewrite here / acceptance |
|---|---|---|
| Supply readiness and stale bank state | Local Microbot `util/bank/Rs2Bank.java`: `awaitBankContainerSnapshotSince`, bank event epoch; WaspLib `templates/bank_script.simba`: `GetState` | Existing courier/handoff and bank-demand helpers: bind receiver readiness to the current session and observed bank state. Keep matched debit/credit receipts. Reproduce delayed receiver, logout and stale-bank cases; no duplicate delivery. |
| Smelting and food production batches | Prefer rs2b0t `src/bot/scripts/SmelterBot/SmelterBotLogic.ts`: `withdrawFor`, `canSmelt`, `smeltStalled`; WaspLib bank template | Existing `scripts/smelt-bars.ts` / `fishcook.ts`: derive feasible batches from every ingredient, available slots and reservations. Replace fixed28 slots, name-substring matching and milliseconds with exact IDs and bounded ticks. Preserve exact-target versus best-effort modes; prove final bank, depletion and assets. |
| Loadout staging | Microbot `util/Rs2InventorySetup.java`; `dillydill123/inventory-setups/src/main/java/inventorysetups/{InventorySetupsItem.java,serialization/InventorySetupPortable.java}` saved from the hub's exact commit | `requirements.ts` and preparation report: item alternatives, quantities, equipment versus pack and reserved stock. Unknown bank is not missing stock; two consumers cannot reserve one item. Portable serialization is saved for a later focused review, not yet adopted. |
| Arrav/Heroes partner progression | Local Quest Helper `helpers/quests/{shieldofarrav,heroesquest}/`; `steps/ConditionalStep.java`; `requirements/item/ItemRequirement.java` | Existing quest workers and shared requirements: ordered conditions, gang-specific branches, partner-held items and restart from flags. Re-derive flags/dialogue from pinned rev289 content. Native two-account proof; never substitute the protected main. |
| Supply-aware transport | Local shortest-path `docs/Transport-TSV-format.md`; `TransportItemsSatisfactionTest.java` | Existing `supply-route.ts` / courier routes: directed edges, AND/OR requirements, duration, fare and remaining stock. Preserve explicit unknowns; test a cheap outbound route that makes return impossible. Coordinates and search semantics need separate checks. |
| Dense dashboard symbols | RuneLite `game/{SkillIconManager,ItemManager}.java`; Explv `js/model/Position.js`, `js/map.js` | Existing dashboard: cached icons, consistent item identity and plane-aware coordinates. Use local permitted assets and our XP curve. Show evidence age; icons must not conceal unknown progress. Paths verified; icon implementations not yet inspected. |

Source findings are not blanket endorsements. WaspLib's template still contains placeholder conditions. The DreamBot iron script requires a Ring of Forging and can stop when the bank lacks a ring even if one is equipped. Its animation loop is not a receipt. Microbot's `setupSoftMinStackTarget` permits some underfilled presets: retain hard minima for our fares, food reserves and quest inputs. Keep the state decomposition; reject incompatible assumptions. Do not import anti-ban sleeps, random clicks or mouse motion into structured SDK workers.

### Failure cases worth porting next

| Inspected implementation | What it teaches | Local rewrite and discriminating check |
|---|---|---|
| rs2b0t `test/scripts/Firemaker/FiremakerBanking.test.ts` | A deposit needs a newer bank snapshot before stock checks. Pending refresh survives another loop. An unready bank does not spend a withdrawal retry. | Our bank/refill helpers: carry pending mutation generation across retries. Delayed credit must not mean exhausted stock; stock-present withdrawal failure needs a different reason. Add a global deadline so readiness cannot wait forever. |
| rs2b0t `SmelterBotLogic.ts` | Partial stock can still yield useful output; primary ore alone does not imply a feasible recipe. | OreElse: calculate `min(slot capacity, each available ingredient / recipe quantity, requested remainder)`. Subtract reservations first. Exact orders fail explicitly when short; best-effort jobs can bank a partial batch. Iron consumption without a bar must be accounted separately. |
| rs2b0t `AIOQuesterLogic.ts`: `selectSustainConsumable`, `resolveSustainPolicy` | Food eligibility belongs to the quest policy; partly eaten forms remain food. A small fitting heal can precede an oversized heal. | Quest sustain: protect edible quest inputs; use exact permitted IDs and current damage risk. Test cake forms, reserved food, an emergency and an unknown HP observation. Do not copy its automatic gang/reward defaults. |
| rs2b0t `docs/decisions/quest-pitfalls-32.md` | Prerequisite acquisition is not final output; object names can hide distinct states; dialogue menus can loop; a reachable neighbour matters more than a nonzero exit mask. | Quest actions return the actual produced effect; use pinned object IDs/stages, spend one-shot dialogue choices and check an interaction tile. Turn one applicable failure into a fixture before porting the full quest. Their server observations are hypotheses here. |
| NotSinan/DreamBotQuester `framework/bank/BankOnceLeaf.java` | Small leaves are easy to inspect, but its static `emptied` flag is not scoped to account/session. | Borrow branch decomposition, not the static flag or blanket equipment deposit. Test two accounts and restart with changed inventory. Keep protected kit. |
| BotWithUs XAPI `script/permissive/node/TreeNode.java`: `toJson`, `traverse` | A decision tree can expose the chosen branch, description and latest validation for diagnostics. Its traversal catches leaf exceptions and prints them. | Existing worker status: compact decision/reason/next effect, bound to observation time. Exceptions must propagate to our bounded recovery; logging is not recovery. No new tree framework needed. |
| Dax `walker_engine/WalkerEngine.java` | Separates walking attempts, obstacles and path progression; has a three-attempt failure threshold. | Compare our `walk.ts` recovery at the same obstruction. Count observed movement/edge completion, not dispatch. Its remote route service and UI helpers are dependencies, not portable algorithms. |
| buderw/osrs-dps-optimize `src/lib/{Bank,LoadoutOptimizer}.ts` | Retains unmatched bank entries, normalizes equipment identities, filters owned gear and searches combinations with beam width12. | Gear preparation: candidates must be owned, accessible, unreserved and equippable. Unknown items stay visible. Replace modern combat data with pinned mechanics; compare a tiny exhaustive search before using heuristic pruning. Beam search is not guaranteed optimal. |
| AKAddons/runelite-loadout-lab `docs/ENGINE-GAPS.md` | Records scenario-specific discrepancies against another calculator instead of claiming universal accuracy. | Existing combat research: retain per-scenario model/native differences and rank total bank/refill output, not DPS alone. Their reported99-vector results were not rerun and do not validate our engine. |
| blurite/pathfinder `reach/DefaultReachStrategy.kt`, `Route.kt`; rsmod `reach/RectangularExclusiveReachStrategyTest.kt` | Reach varies by shape, rotation, actor size and blocked approach side. Routes expose `alternative` separately from `success`. Tests check allowed borders rather than distance alone. | Existing `walk.ts` and pinned pathfinder: distinguish travel tolerance from interaction reach. Test blocked side, rotated rectangle, diagonal corner and alternate endpoint. A partial route does not prove the requested interaction. Keep x/z/plane conversion explicit. |
| rs2b0t `MuleCrafterLogic.ts`, its test file | Configured partner normalization; explicit essence/empty offer classification. `essencePerTrade` ignores its size/talisman arguments and always returns27. | Existing courier/handoff: use owned partner identity plus current session, item IDs, actual free slots and reserved kit. Test full receiver, changed offer and another supplier. Offer classification is not a settled transfer; retain paired receipts. |
| LostCityRS/RuneScriptTS `NodeSourceLocation.ts`, diagnostics and symbol table | AST locations retain file, start/end line and column; symbols support source-aware inspection. | Extend existing wiki/knowledge builders only where config parsing loses conditional rules. Carry source span, revision and preconditions with extracted facts; unknown branches stay unknown. Do not add a compiler merely to extract simple config fields. |
| skillbert/rsmv `src/scripts/testdecode.ts`, `src/parser/jsonschemas.ts` | Decoder failures can retain original file, offsets, parser state and bounded error counts; historical decoding tests vary cache build. | Cache/interface checksum investigation: retain the exact input and first failing offset; compare expected format/revision before repair. RS3 schemas are not rev289 schemas, and a decoded client cache does not establish server recipes or quest rules. |
| Iron Compass `goal/GoalDependencyResolver.java` | Returns an explainable prerequisite path; detects recursion cycles; requires TRUE readiness. Missing prerequisite references are skipped by this resolver. | Existing `requirements.ts`/goal-readiness: keep the reason path and reject unresolved references explicitly. Test cycle, missing node and unknown fact. Do not copy its single selected-goal ordering into fleet scheduling. |
| Iron Compass `training/BankedGoalService.java` | Projects observed stock through recipes, subtracting ingredients so later recipes cannot reuse them. Selects currently unlocked recipes by XP/action. | Existing preparation/planner: subtract fleet reservations and compare useful outputs, travel, losses and unlocking value. Model later level unlocks separately. Two goals sharing ore must not each claim it. Banked XP is an estimate, not completed progress or a global optimum. |
| Wizard-Fish/Ironman-Progression `BankItemCache.java`, `ProgressionAdvisor.java` | Session-synced bank flag is distinct from item presence; unrecognized quest/skill keys block completion. Manual steps have separate evidence. | Existing status/dashboard: retain dated historical stock, invalidate current-session readiness, expose unsupported keys. Do not erase history on logout or count a manual checkbox as observed completion. Its bank cache is a set, not quantities: use our counted stock. |
| Luna `bot/script/BotScriptStack.java`, `BotScriptSnapshot.java` | Ordered snapshots, head/tail priority and deferred priority preserve queued work. Restore failures are logged and omitted; unsaved dynamic jobs disappear. | Existing swarm/supervisors: persist stable job IDs, schema/release, goal and last settled receipt. Reconcile state before resume; failed migration becomes a visible recovery hold. Test restart mid-transfer, duplicate IDs and unsupported versions. Do not copy reflection-based class restoration or silently lose jobs. |

**Reach/data pass:** [four-repository catalog](../.practice/reuse-source-audit/reach/manifest.json), [22 saved files](../.practice/reuse-source-audit/reach/sources.json), including additional files from the pinned rs2b0t. New lead `skillbert/rsmv` is a decoder/debugging reference; blurite, rsmod and RuneScriptTS deepen existing leads. Focused reads covered the table entries, not all repository code. Upstream tests were inspected, not run. Source inspection establishes candidate patterns, not local compatibility or speed.

The saved rsmv root tree exposes no license file; reuse terms remain unresolved. Keep it as an inspection reference. RuneScriptTS includes both `LICENSE` and `LICENSE.neptune`; preserve applicable notices if code is adapted.

**Goal/recovery pass:** [catalog](../.practice/reuse-source-audit/goals/manifest.json), [14 saved files](../.practice/reuse-source-audit/goals/sources.json). Three repositories resolved; `ellismosss/iron-hub` returned404 despite a search-index feature page, so it remains unavailable. Wizard Fish is a new source; Iron Compass and Luna now have focused implementation reads. This adds adoption evidence, not another scheduler. Preserve all goal lanes: shared-resource accounting is reusable; a single-character recommendation order is not a multi-account optimizer.

**Revision correction:** rs2b0t commit `6e747f8bda494d9f75365b5533cf758d353dcc3b` README states rev289; search snippets still say274. It supports its own rs2b2t server, not our deployment. Match pinned mechanics even when revision numbers agree. Its advertised dual-gang Arrav supplier is not an approved shortcut here.

**Already solved locally:** `packages/core/src/deposit.ts::depositObserved` already requires a newer generation and matched pack debit/bank credit. Reuse it. The new research targets caller recovery and receiver enrolment, not another deposit implementation. `smelt-bars.ts` already has a protected bronze batch/final-bank path; extend that path for recipes rather than replacing it with a foreign worker.

**Source review before coding:** read saved Microbot `Rs2Bank.java` (`2c802e4`, snapshot wait and open-bank caller) and rs2b0t `SmelterBotLogic.ts` plus tests: await updated observations; size work from all ingredients. Keep our paired receipts and exact IDs; extend existing production helpers instead of accumulating fixed-batch scratch workers. The [Microbot release search](https://github.com/chsami/Microbot/releases) flags withdraw-X confirmation fixes for a focused follow-up; release notes alone are not implementation proof.

**Saved license texts:** rs2b0t/DreamBotQuester MIT; Dax Apache-2.0; Loadout Lab BSD-2-Clause; XAPI and buderw optimizer GPL-3.0. Check per-file and bundled notices before incorporating code. A language translation is not a license reset. No external code is incorporated by this research update.

**Next implementation order:** bank refresh/readiness → stock-aware smelting → quest food/partner recovery → owned-gear candidates. These close current blockers using existing modules. Scheduler diagnostics and dashboard symbols follow where they explain a real stall. No performance gain has been measured from this research alone.

### Trading sources: accounting before strategy

[Three new repositories](../.practice/reuse-source-audit/trading/manifest.json), [14 pinned files](../.practice/reuse-source-audit/trading/sources.json), source-read2026-10-26. No trades placed; upstream tests inspected, not run. These complement the requested client/plugin projects with accounting implementations.

| Source / exact entry | Borrow | Adapt here / prove |
|---|---|---|
| `y5c/ge-bridge`, `OfferTracker.java`, `OfferTrackerPropertyTest.java` | First sight is a baseline, not new income; cumulative fill deltas; separate collection totals; offline observation windows; decreasing fills become anomalies. | Existing GE receipts and `net-costs.ts`: use server offer IDs instead of slot/item/price heuristics. Replay duplicate snapshots, reconnect, partial collection and slot reuse; book each fill once. A cleared offer with missing history stays unknown. |
| `StefanMikael/osrs-trade-tracker`, `OsrsTradeTrackerPlugin.java`, `OfferSnapshot.java` | Separate offer changes and fill quantity/cash deltas, with per-character persistence. | Keep exact delta coins and quantity; its integer `deltaGp / deltaQty` is only a display average. Test mixed-price fills and cancellation refund. Escrow return is not revenue; filled is not yet collected or delivered. |
| `Flipping-Utilities/rl-plugin`, `HistoryManager.java`, `AccountWideCrossAccountFlipsTest.java` | Aggregate owned-account history before matching purchases and sales; use wide totals. The test covers buying on alts and selling on another account. | Preserve item lots/cost basis through our paired handoffs. Internal movement is neither fleet revenue nor expense. Aggregate `min(bought,sold)` alone cannot identify consumed, gifted or unknown-opening stock. Test cross-account sale, retained inventory and unknown basis. |

**Integration boundary:** current `net-costs.ts` already cancels an owned funding transfer and leaves opening food cost unknown. Preserve that behaviour. A future GE adapter should feed the same ledger, not create another profit total. Use this server's cumulative tax/offer semantics; OSRS slot counts, tax rules and prices do not transfer. Recipe flips require consumed-input costs, actual output, losses and fees. Quoted spreads and inventory marks are not realised earnings. These sources improve accounting evidence; none proves a profitable strategy on our server.

## Broader botting search: reusable slices

Web search2026-10-26 covered script frameworks, tutorial/bootstrap, quests, visual control, walking, simulation and scheduling. [Catalog](../.practice/reuse-source-audit/broad/manifest.json) and [dependency follow-up](../.practice/reuse-source-audit/broad/fc/manifest.json):11 resolved repositories, one404 and one API rate-limit result. [Sources](../.practice/reuse-source-audit/broad/sources.json) plus [FC samples](../.practice/reuse-source-audit/broad/fc/sources.json) retain25 files. No foreign code was executed. This is a targeted survey, not exhaustive coverage of all botting.

| Candidate and source entry | Useful slice → local consumer | Evidence / exclusion |
|---|---|---|
| `maximedelboo/WaspQuests`, `backend/solveSteps.simba` | Separate action attempt, wait condition and completion predicate → existing quest steps | Code read: explicit `CompletionCondition` can differ from `actionSucceeded`. Replace pixel detection and sleeps with SDK observations/ticks; test false-success dispatch and restart mid-step. |
| `fmorris2/fc-questing`, `data/QuestLoader.java` | Registry filters completed/unstartable missions → quest assignment | Code read. Registry imports separate framework/mission packages; it is not a self-contained quest engine. Do not hide missing prerequisite work merely because the final mission cannot start. |
| `fmorris2/fc-framework`, `task/ItemsRequiredTask.java`; `fc-cooks-assistant`, `prereq_missions/pot_of_flour/GetPotOfFlour.java` | Named input contracts and acquire-pot→wheat→mill→collect subgoal → existing shared requirements/acquisition workers | Code read; output predicate checks flour held. Preserve bank/owned-stock alternatives, exact IDs and the distinction between acquiring flour and completing Cook's Assistant. Missing APIs/licenses still need resolution before code reuse. |
| `DerkSchooltink/runemate-bots`, `free/summoning/tasks/WithdrawPreset.kt` | Small validate/execute tasks and bank preparation → production stage design | Code read; RS3 preset call has no local receipt proof. Reuse decomposition, not preset API or distance-only readiness. Collection mixes games and includes unfinished work. |
| `mdennis281/OSRS-CV-Bot`, `core/control.py::guard` | Central pause/terminate boundary → cancellation coverage review | Code read; decorator checks before invoking the function, not inside a long-running body. Preserve our cancellation checks at awaited action boundaries; test pause during travel/banking. Pixel confidence thresholds are not SDK success criteria. |
| `rohangpta/runescape-ability-solver`, `main.py` | Time-indexed action variables, occupancy/cooldown/resource constraints → offline schedule comparison | Code read; RS3 combat model, global solver state and300-second limit are unsuitable defaults. If needed, model one bottleneck with local instances, existing resources and measured durations; compare with current planner before adding OR-Tools. |
| `ArtemisRS/hunllef`, `src/lib.rs` | Simulated success, fish-use and elapsed-time distributions → combat food-budget research | Code read; modern boss/prayers and perfect-execution assumptions do not transfer. Fit pinned mechanics and compare native traces; use uncertainty/tails, not just mean DPS. |
| `Benzymee/RS2B2T-Quests` | Per-quest bundles and prerequisite-oriented documentation → locate route examples | README/tree only; author explicitly calls quests work in progress. Same rs2b0t family is not independent validation. Prefer original engine source over opaque bundled scripts. |
| `slackydev/rswalker`, `Walker.simba`, `libWalker` | Visual localization and map-walk API → optional independent UI diagnosis | Saved reference, no algorithm review. Structured state already supplies position; do not add DLLs or a second controller for ordinary routing. |
| `rene-ott/vanilla-bot`, `vb-core-contracts`, `vb-cjci-model` | Client contract/mapping separation → version-boundary reference | README/tree only; Classic reflection/instrumentation is not our SDK. No present migration case. |

**Unavailable is not inspected:** Explv/Tutorial-Island direct lookup returned404 despite a cached source page. `fmorris2/fc-rune-mysteries` was discovered in the owner's repository listing but tree retrieval hit403 rate limit; do not call it missing. Saved [owner listing](../.practice/reuse-source-audit/broad/fc-discovery.json) locates other mission dependencies. Search-only simulation leads retained here: `Hirmuolio/runescape-equipment-tool`, `RustCityRS/rs-majula`, `iangogentic/osrs-lumbridge`; inspect only for a named differential case. Existing Fight Caves RL notes remain simulation evidence, not live performance.

**Cross-language rule:** retain state predicates, resource accounting, cancellation and diagnostic cases; replace client APIs and game constants. Callback Java/Kotlin, sequential Pascal, Python guards and Rust simulation are different expressions of these contracts. A public script or a successful model cannot establish compatible mechanics, licensed reuse or live reliability.

### Every requested project: what to mine

Paths below are repository-relative search entry points from the saved trees. Rows marked **reference** need a focused implementation read before adoption. Same-family forks do not count as independent proof.

| Project | Useful part / local use | Boundary |
|---|---|---|
| AlterRSPS/Runelite | `runelite-api`, `runelite-client`, cache loaders: RSPS client adaptation and event contracts | Reference; compare fork diff only for a named client defect |
| OSRSB/OsrsBot | `docs/rsb/methods/{Bank,Walking}.html`, script lifecycle docs: API coverage checklist | Documentation reference; docs do not prove available implementation |
| open-osrs/runelite | Client events, plugin lifecycle, interaction abstractions | Reference; no client migration or duplicate framework |
| runelite/plugin-hub | `plugins/*`: repository URL + commit discovery | Follow the manifest to actual source; hub is not the plugin code |
| runelite/runelite | Skill/item managers, events, cache definitions; the dashboard's plugins | Reference; modern IDs, XP and UI differ. Dashboard parts: [runelite-parity](runelite-parity.md) |
| MaxBittker/rs-sdk | `sdk`, `learnings`, `server/content`, SDK tests | First choice; use our pinned checkout and patches, not upstream HEAD blindly |
| dennisdev/rs-map-viewer | `src/rs/pathfinder`, `src/rs/scene/CollisionMap.ts`: collision and map inspection | Reference; a rendered tile does not prove reachability |
| Explv/Explv.github.io | `js/model`, `js/controls`: coordinates, regions, planes, route overlays | Reference; port coordinate model, validate map origin/zoom |
| Explv/osrs_map_tiles | Tile hierarchy: map background and offline visual checks | Reference; huge/truncated index, wrong-era tiles possible; fetch only needed regions |
| Dezinater/osrscachereader | `src/cacheReader`, `scripts/dumpNames.js`: definition extraction | Reference; match container and definition revisions separately |
| openrs2/openrs2 | `cache`, `protocol`, protocol tests: decoding and malformed-input cases | Reference; not a ready source of our quest/production scripts |
| LostCityRS/Launcher | Small launcher project: distribution/startup reference | Low priority; no worker-planning gain established |
| LostCityRS/RuneScriptLanguage | `src/provider`, `src/diagnostics`: symbol lookup and content navigation | Reference; helps find authoritative rules, not execute quests |
| neptune-ps/neptune | Compiler/parser and symbol tables | Reference; useful for extraction diagnostics, not a replacement bot runtime |
| LostCityRS/RuneScriptKt | Compiler AST/control-flow sources | Rejected; use RuneScriptTS or the pinned toolchain |
| LostCityRS/Client-Java | `jagex2/dash3d/CollisionMap.java`: reach/collision comparison | Reference; translate semantics and test diagonal/object cases |
| LostCityRS/Client-TS | `src/dash3d/{CollisionMap,CollisionFlag}.ts` | Reference; compare with our vendored client before changing it |
| LostCityRS/OS1 | `jagex3/dash3d/CollisionMap.java`, client scripts | Reference; 2013 client behaviour is not rev289 truth |
| LostCityRS/Server | Setup and component composition | Reference; our practice stack already exists |
| LostCityRS/Engine-TS | `src/engine/{routefinder,script,entity}` | First-line semantics through our pinned engine; upstream branch may differ |
| LostCityRS/Content | Quest, area, skill scripts and configurations | First-line recipes/dialogue through `vendor/rs-sdk/server/content`; standalone clone can be rev274 |
| lesleyrs/Client3 | `src/collisionmap.c`: portable client/collision implementation | Reference; useful differential cases, not a reason to port the client |
| Villavu/Simba | `Source/script`, imports: bounded scripting/runtime tooling | Reference; pixel control only for an actual structured-state gap |
| Villavu/SRL-Development | `osr/bank.simba`: bank interface abstraction | Saved reference; separate perception from task policy |
| Torwent/WaspLib | `templates/{bank_script,walker_script}.simba`, `main/basescript.simba` | Bank template inspected; port explicit states and supply exhaustion, not pixel timing |
| chsami/Microbot | Bank, walker and inventory setup utilities | Bank freshness inspected locally; reuse contracts, retain our receipt guarantees |
| open-osrs/plugins | Individual plugin modules | Reference; mine one relevant plugin, not the whole collection |

**Additional sources saved:** `rHilkner/runescript-dreambot` has concrete smithing, cooking, firemaking and gathering scripts; inspect the narrow worker plus its shared services. `pashpashpash/RunescapeBots` contains fishing/woodcutting source under `src/`; retain as a lower-priority workflow example. Neither root tree exposed a license file: no code incorporation until reuse terms are established. Source availability and a rewrite do not remove attribution or license obligations. No binary, paid-script dump or external build was executed.

### Porting recipe for future work

1. Search the existing worker and this map for the missing behaviour. Use `rg --files vendor/<repo>` for filenames; `rg -n '<state|method|item>' <selected-file>` for implementation. For saved trees, search the per-project JSON, then use its immutable commit URL. Follow plugin-hub manifests instead of guessing repositories.
2. Read the function, callers, state model and relevant tests. Record source commit/path, license, local consumer and one expected gain in the existing topic. Save only useful files plus notices; do not duplicate a clone already present.
3. Extract the decision table: entry facts → action → observed effect → timeout/recovery → exit. Separate algorithm from client API, coordinates, IDs, time units and economy assumptions.
4. Map Java/Pascal callbacks to our observed-state TypeScript steps. Replace static client access with the existing bot context; sleeps with bounded tick/effect waits; booleans with met/unmet/unknown where evidence can be absent. Preserve ordered quest conditions.
5. Use pinned game data for constants. Keep our session ownership, cancellation, reservations and paired receipts. Put reusable logic in the existing helper; parameterize accounts. Translate the smallest missing behaviour, not a whole framework.
6. Port a useful failure case as well as the happy path. Check restart, stale observations, exhausted stock, blocked travel and partial transfers. Then native full-cycle proof and bounded live proof. Claim speed gains only from matched measurements.

The target is fewer unproved decisions, not more imported code. Existing implementations can still contain bugs; none guarantees that all goals already have a compatible turnkey solution.

## Select by gain, not by project count

Use existing code first. A candidate earns implementation time only if it closes a named gap and has a discriminating check. Prefer lower expected main-clock ticks, higher delivered net output, better survival or lower host cost; account for engineering effort, uncertainty and ongoing maintenance. These are separate outcomes, not a fabricated combined score. No numerical gain is claimed before matched measurement.

| Order | Combine | Smallest useful result here | Acceptance / stop rule |
|---|---|---|---|
| 1 | Pinned rs-sdk content + Iron Compass + Quest Helper | Shared requirements with TRUE/FALSE/UNKNOWN; one blocked quest/gear/supply chain feeds dashboard and planner | Missing/stale bank or quest flags never imply ready; alternatives, cycles and shared prerequisites covered. Stop adding schema once the selected chain works. |
| 2 | Existing receipts/reservations + Skretzo + UberMouse + Dax execution ideas | Source→pickup→bank→consumer route with remaining food, fares and inventory slots | A nearer bank may lose to a cheaper whole trip; spending/reservation changes invalidate the plan. Compare against current courier route. |
| 3 | rs2b0t + Microbot + JevScape + Luna | Resumable steps with explicit product, cancellation and bounded recovery | Interrupted quest/trade resumes from observed state without double spending, duplicate action or false completion. Native proof after pause. |
| 4 | bleugreen + IronQuest + our whole-clock model | Reorder one allowed speedrun segment using shared XP/unlocks and helper staging | Recompute every affected board deadline, not only Overall. All gameplay techniques are eligible; do not sum overlapping savings. |
| 5 | Engine combat + Wiki DPS + narrow simulator methods | Compare two feasible gear/food setups by damage taken, kill-time spread and net loot | Matched practice, at least three runs per condition; include bank/refill and failure. Model alone cannot promote combat. |
| 6 | RuneBench/Harbor + existing practice + fleet simulator lessons | Replayable fixture for the hardest unresolved route/quest state | Model and engine agree on state/action/effect; add depletion/competition. Build a separate simulator only if measured practice cost justifies it. |

Orders are marginal-value judgments, not a waterfall: source-only hiscore research can proceed while a supply experiment is blocked. Only one heavy game qualification at a time; current execution authority comes from the joined plan.

First slice (offline): `goalRequirementsFor` retains shared consumers; preparation merges aliases without double-counting stock. Whole-trip checks cover stock, fares, food and capacity. [Courier replay](../.practice/shared-supply/courier-replay.json) binds one saved Draynor→Ardougne return to its account, cash/cargo deltas, recipient and timing: 60 coins, 295 travel ticks, 159 delivered. [68 tests](../.practice/shared-supply/courier-tests.txt). Outbound costs, quest-flag readiness and comparative game gains remain unproved.

## Grouped inventory of retained leads

**Keep** = retain the existing dependency or reference; **Trial** = a candidate for a named gap; **Reference** = inspect for a named defect; **Hold** = no present adoption case. These labels are recommendations, not proof that code was integrated. Group membership does not imply equal evidence or compatible licenses.

### 1. Native foundation and same-environment work

- **Keep:** MaxBittker/rs-sdk; MaxBittker/rsmod-pathfinder; MaxBittker/rs-world; dennisdev/rs-map-viewer; LostCityRS/Engine-TS, LostCityRS/Content, LostCityRS/Client-TS, LostCityRS/Server and LostCityRS/RuneScriptTS. Use the pinned rev289 content with engine, patches and target configuration; separate LostCity clones may be rev274. Viewer/setup projects are not game mechanics.
- **Keep + targeted trial:** UberMouse/rs-sdk. Nearest-bank data already has a consumer in `packages/planner/src/travel.ts`; review only missing reach/connectors, route requirements, scenarios or model assumptions. Do not repeat the old full-import proposal.
- **Unavailable:** bleugreen/rs-sdk returns 404; `rival-gap-list.md` at `3bd2ab0a` is the last read. Its process record is bleugreen/rune.fast (no license, facts only); see [other teams' setups](community-and-upstream.md#8-other-teams-setups-tooling-and-process-against-ours).
- **Trial (process):** UberMouse/rs-sdk conductor (MIT): save library with live snapshots, tick recordings with replay, guards at every tick wait. MaxBittker/rs-sdk `db0cc51e` takeover commits. Supalosa/rs-sdk `codex/lockstep-clock` (MIT). Table below.
- **Reference:** samheutmaker/lumbridge-ai (tripwires/coordination); Skyvern-AI/jevscape (bounded actions, goal/reflex separation); TestingPurposes/rs-sdk-fleet (memory/supervision/simulation ideas); chrisbremmer/rs-fleet; markeljan/rs-sdk-dashboard. Keep our runtime/dashboard; license and evidence vary.
- **Hold unless a concrete gap:** ineedbots/lc-headless, OpenChatGit/CScape, dginovker/LostCityClientBot, dginovker/LostCityServerBots, AndresI19/rs-mcp-server, CornThatLefty/OSRSBot, vhsgreed/jev-plays-runescape, maxwelllord/AgentPairRSBench. These are leads, not proved upgrades.

**Development-loop sources** (source -> local consumer -> reuse/adapt/reject -> check). Evidence and ranking: [community-and-upstream.md section 8](community-and-upstream.md#86-ranked-changes-that-would-most-speed-up-our-progress).

| Source | Local consumer | Decision | Check |
|---|---|---|---|
| Cairn `run.ts` at a named commit per live run (rune.fast `attempts-timeline.json` R3) | `packages/core/src/worker-release.ts` whole-tree pin | adapt: pin each capability's import closure | an edit outside a capability's closure leaves its pin and live slots unchanged |
| UberMouse plans: phases chosen by pure `when` predicates, no LLM (`conductor/README.md` "Plans") | `packages/planner/src/autopilot.ts`, `scripts/swarm.ts`, `packages/router/src/coordinator-live.ts` | adapt: the next job of a qualified chain needs no model round | with the coordinator stopped, a qualified chain starts its next finite batch on the receipt |
| UberMouse `conductor/tools/{save,load,library}.ts`, engine `GET /save`, `POST /kick` (`9df2d4c9`, MIT) | `packages/practice/src/presets.ts`, `stack.ts` | adapt: rewrite; keep notice if code is copied | a saved mid-quest state loads on practice and the worker resumes |
| UberMouse `conductor/tools/replay.ts`, `*.ticks.ndjson.gz` | `packages/core/src/{bot,act,ticks}.ts`, `packages/router/src/coordinator-worker.ts` | adapt | a no-behaviour refactor replays clean on 3 recorded runs |
| MaxBittker/rs-sdk `97725db3`, `2c7d4607`, `db0cc51e` (MIT) | `vendor/rs-sdk` pin `db0cc51e`, `packages/core/src/session-takeover.ts` | reused: pin moved; live gate off | practice: a killed client's re-login attached (`research/community-and-upstream.md` 8.6); demo behaviour unproven |
| Cairn `build` recipe, no review node (910 runs) | `docs/script-contract.md` Review, `packages/router/src/coordinator-planner.ts:107` | adapt: owner decision | build-done to first pilot time on the next 3 builds |
| Supalosa `codex/lockstep-clock` `40358da0` (MIT) | `packages/practice/src/stack.ts` | trial after the above | practice ticks per wall second against 150 ms ticks |
| Spenny12 `walk-speed` `46cdcb1e` (MIT) | `packages/core/src/walk.ts` | reject: `walk.ts:295` already avoids per-corner `walkTo` waits | none |

### 2. Quests, progression and goal planning

- **Trial:** rs2b2t/rs2b0t; Zoinkwiz/quest-helper; gabworknestio-beep/iron-compass; darrenswhite/ironquest; NotSinan/DreamBotQuester. Respectively: resumable decisions/failure cases, requirement/step representation, shared blockers/unknowns, reward ordering, acquisition/action decomposition.
- **Reference:** marcdubs/2004Scape-AP-Logic (dependency/reachability lead); LostCityRS/RuneScriptLanguage (symbols/references); neptune-ps/neptune (parser/compiler architecture); LostCityRS/RuneScriptKt (rejected; use RuneScriptTS first).
- **Hold:** ellismosss/iron-hub (search-index claims; direct lookup failed); Rune-Agent-LostCity (forum/video lead). No automatic quest completion claim from a guide or interface highlight.

### 3. Paths, transport and maps

- **Trial:** Skretzo/shortest-path, itsdax/Runescape-Web-Walker-Engine. Use destination requirements, whole-trip bank selection, recovery and route interruption. Dax's public code is a client wrapper; Skretzo's documented search does not track items spent en route and may display unknown-requirement routes. Our execution must revalidate both.
- **Reference:** rsmod/rsmod, blurite/pathfinder, RustCityRS/rs-pathfinder, mejrs/wasm-pathfinder, 2003scape/rsc-path-finder, dQw4w9WgXcQ/osrs-pathfinder, OlZe/osrs_pathfinder, superptzl/AdvancedWalking. Compare interaction reach, dynamic obstacles, multi-tile entities and corner cases; replace existing BFS only after measured benefit.
- **Reference:** Explv/Explv.github.io, Explv/osrs_map_tiles, mejrs/mejrs.github.io, osrs-wiki/osrs-wiki-maps. Coordinate inspection and versioned imagery. A tile picture is not collision, access permission or a route execution proof.

### 4. Bot frameworks, public scripts and plugin hubs

- **Trial patterns:** chsami/Microbot (per-tick queries, state transitions, blocker handling), jrr97/runescape-ai (routine contracts and stale-state checks). Existing `act`, `walk`, `reflex`, status and supervisor modules already cover parts; extend only a demonstrated gap.
- **Reference:** runelite/runelite, runelite/plugin-hub, OSRSB/OsrsBot, Parabot/Parabot, rvazarkar/PiggyPlugins, xsmar/OzPluginsPublic, 2006-Scape/2006RebottedClient, dginovker/RebottedAPI, viktorstiunovs/osrs-dreambot-scripts, DerkSchooltink/runemate-bots. Read individual routines for supplies, banking, partial failures and recovery. Hub listings and fork counts are not independent validation.
- **Historical reference:** AlterRSPS/Runelite, open-osrs/runelite, open-osrs/plugins, RSBot/Powerbot. Injection/client abstractions; no runtime replacement justified. Missing/dead links remain historical leads.
- **Public docs/store reference:** DreamBot, OSBot, RuneMate, TriBot, RSPeer, PowBot, Inubot, Storm; ShadowLib/shadowlib. Feature/API contracts can reveal gaps even when source is closed. Store claims, current availability and implementation must remain distinct; old shutdown claims are unverified.
- **Hold:** RSCEmulation/RSC Bot and other generic macro examples from the PDFs. Inspect only for a specific perception or lifecycle problem.

### 5. Visual automation

- **Reference:** Villavu/Simba, Villavu/SRL-Development, Torwent/WaspLib, StaticSweep/ChromaScape, OSBC/osrs_color_bot (also referenced as kelltom/OS-Bot-COLOR), cemenenkoff/runedark-public, slyautomation/osrs_yolov5 and related versions, Vroomfrondal/Runescape-bot, Brandon-T/RemoteInput.
- Use for an independent UI check when structured state is incomplete, or to reproduce a client-only discrepancy. Pixel control, mouse humanisation and a second full controller offer no demonstrated gain for our current structured-state server. Same-family names/forks may be aliases; do not count them as separate evidence.

### 6. Clients and alternate engines

- **Trial reference:** luna-rs/luna: persistent script queue and interruption/restart handling. Server-side autonomous bots can bypass client constraints; that is not evidence our client can do the same work.
- **Reference:** LostCityRS/Launcher, Client-Java and OS1; lesleyrs/Client3; reinismu/runescape-web-client-377; Promises/refactored-client-377; HelloKitty/RS317.Sharp; DataHoarder6/2004lite; skulltrick/lclite; Razgals/2004Kit and LostKit; PureXYZ/2004scape-sp-mobile.
- **Reference:** 2004Scape/Server and ServerOld; 2006-Scape/2006Scape; RuneJS/server; apollo-rsps/apollo; 2009scape/2009scape on GitLab (downthecrop mirror); nrylov/2010scape; nrylov/rs2011-ts; openrs2/openrs2; Open-RSC/Core-Framework; Elvarg. Use comparative lifecycle, content and protocol cases, not wholesale wrong-era data.
- **Hold:** lrhunsy11/2010scape (metadata-only); nrylov/2010scape-web (website, not client); Hyperion/Moparscape (unresolved leads); The-RSPS-Archive/184---Kronos-Source (public-release archive, provenance/license not established). Do not describe an archive as a confirmed leak.

### 7. Game data, cache and economics

- **Keep:** pinned rs-sdk generated wiki/content, local knowledge builders, owned snapshots and saved receipts. **Reference:** LostCityRS/Markets; index-rs/LC-bankvalue; jaidenw/2004scape-drop-search. Useful data extraction and bank-value semantics; base item value is not cash earnings.
- **Reference:** OpenRS2 Archive, LostCity cache archive/roadmap, Dezinater/osrscachereader, Displee/rs-cache-library, RuneStar/cache, RuneStar/cache-names, RuneStar/cs2-scripts, Qodat/qodat, villermen/runescape-cache-tools, mejrs/rs3cache, Joshua-F/osrs-dumps, abextm/osrs-cache, osrs-wiki/cache-mediawiki. Match container format, definition format and revision separately; assets and code can have different rights.
- **Reference:** osrsbox/osrsbox-db, osrsbox/osrsbox-python, 0xNeffarion/osrsreboxed-db, OSRS Wiki/API, RS3 and Classic wikis, LostHQ, garlichq wiki, LostCity guides/forums, Tip.it, RuneHQ, Zybez/Wayback. Schema, dialogue and historical comparison; verify facts against pinned source.
- **No direct economic substitution:** OSRS Wiki prices, old GE snapshots and guide profit rates. Use this server's live/history API, source comparison and actual receipts under the [market policy](supply-logistics.md#market-policy-current); GE is authorized. External prices remain context or schema examples.

### 8. Simulation and evaluation

- **Trial methods:** weirdgloop/osrs-dps-calc; Naton1/osrs-pvp-reinforcement-learning; jordanbailey00/fight-caves-rl; TestingPurposes fleet simulator; third-party Rig Simulator Atlas. Use narrow contracts, damage/TTK distributions, differential traces and failure cases. Atlas attribution and results remain unverified; old closeness to a leaderboard time does not prove authorship.
- **Reference:** downthecrop/JS-OSRS-Jad-Simulator; ProjectSoulbyTmb/osrs-unified; Aivarass/sarsa-rsps-agent; harmindersinghnijjar/RunescapeGPT. Simplified worlds and author-reported win rates cannot establish native engine fidelity.
- **Hold/dead leads:** lordbasilaiassistant-sudo/dreambot-ai; Gavin29/osrs-ai-bot. Existing notes report unavailable repositories; no deliverable inferred from search summaries.
- **Keep/reference:** MaxBittker/runebench / MaxBittker/rs-bench (names in research), harbor-framework/harbor. Use reproducible starting states and final-state checks; peak-window benchmark XP is not our speedrun clock or sustained net output.

### 9. Adjacent agent research

- **Reference:** MineDojo/Voyager, MineDojo/MineDojo, kolbytn/mindcraft, JackHopkins/factorio-learning-environment, agent-wow/agent-wow, BALROG. Useful executable skills, curriculum, observations and evaluation ideas; no need to add these runtimes.
- **Hold as automation designs:** ghuntley/how-to-ralph-wiggum, anthropics/claude-plugins-official ralph-loop. A loop must obey pause, budget and failure bounds; more iterations are not evidence of progress. No new agent loop is justified here.

### 10. Forks and small leads retained without invented value

Not implementation priorities; original evidence is in ecosystem/web research. Inspect a specific diff only if it promises a missing capability:

- Urnz/rs-sdk; saimdlx/nineninemaxxing; jrpii/rs-sdk-temporal-planning; 99-cooking/loot.xyz; GoonMachine/rs-sdk. Temporal-planning and quest-bootstrap reports are targeted leads; housing/engine variants are currently off-goal.
- CraziedAres, bogocat, ken12321, singulocity, natemacfadden, Kudretg; Kimmo3223, java-james, Ghosts, Supalosa, Acquiredl, CakeRepository, Milbaxter, wheredidmyantsgo, uae1319-ux; SeanVella/pvp-sdk; bestlund/artscape. These are fork owners/references recorded in the earlier survey, not newly verified repository identities. “Zero ahead on main” does not rule out branch work.
- Darryll2022/rs-agent-lab; danmarkmann/runebench; runemic/runebench; dlhg/rs-sdk; jamie-legg/rs-sdk; milady-ai/milady; elizaOS/knowledge. No demonstrated marginal gain yet.

Search-result-only names in discovery JSON are not promoted into this inventory as researched candidates. Paid/leaked/reuploaded material needs provenance, an inspectable implementation and applicable reuse terms before adoption. Public availability alone establishes none of those.

## Target architecture, not a claim of current coverage

1. **One versioned fact layer:** pinned content produces items, quests, sources, recipes and routes. External data is an attributed hypothesis until matched. Unknown and unavailable differ.
2. **One account/resource layer:** fresh state, item holder, bank/cargo location, reservation, cost basis and observed handoffs. Owned transfers cancel at fleet scope. Time and unsold stock are separate from realised cash.
3. **One goal graph:** requirements and alternative methods share unlocks/resources. Never spend the same stock twice. Show which lanes an action advances; keep specialist and simultaneous-board goals distinct.
4. **One scheduler over existing workers:** choose feasible methods using measured rates, travel, contention and recovery. Helper labour can happen off the main clock but still costs time/resources. Re-plan only affected dependants after receipts change.
5. **One evidence path:** intent → bounded action → observed effect → receipt → state/cost update. Model, practice and live remain separate. Existing dashboard shows that same state rather than maintaining its own truth.

Use Pareto comparisons first: reject a method that is no better on time, cost, risk or readiness. Compare surviving methods under the actual goal's clock and resource constraints. Sensitivity-test uncertain rates; do not sum independent best cases. A schedule that wins Overall but misses an earlier skill deadline does not solve the 24-board goal.

Current boundary: account-level readiness checks shared Rune Mysteries credit/access, alternative picks and Heroes/Legends gear prerequisites; missing facts and cycles stay explicit. The runner does not treat a talisman as quest completion and can resume the package→notes gap. Transport checks bind direction/account/server/combat evidence and preserve unknown costs. [95 offline tests](../.practice/shared-supply/combined-tests.txt); [allowed hiscore analysis](../.practice/shared-supply/goal-analysis.json) is 8,950 model ticks late. That offline slice did not prove native recovery, outbound costs or competitive gains. Native/live evidence belongs in the joined plan. Existing cancellation is retained. Qualify missing supplies, depletion and competing actors under current authority; no client migration or full simulator is justified.
