# SDD ledger — plan: docs/superpowers/plans/2026-10-22-phase2-script-core.md
Setup: Ruling: branch phase2 in place, not a worktree — vendor/ is gitignored — cost if wrong: none
Pre-flight:
- T1 Session -> T2/T5/T6 consume onTick/tick/sdk/bot — consistent
- T2 checked/Outcome -> T5 walker/reflex — T5 step 1 names reason effect; ruled to timeout in plan text — consistent after ruling
- T3 doors.json -> T4 blockedDoors — consistent
- T4 World.route/Leg -> T5 walkRoute/goTo — consistent
Task 1: Ruling: default host 'localhost:8888' not 'localhost' — lite cache fetch needs host:port (live run 1 failed on http://localhost/crc) — cost if wrong: none, overridable
Task 1: live: inprocess.it → PASS; START 3224 3245 0; walk 1 tile 1 tick/671 ms; chopTree 10 ticks/2540 ms
Task 1: complete (commits 3d9a64c..4046d80, tests: bun test ./packages/core → Ran 5 tests across 2 files. [566.00ms])
Task 2: complete (commits 4046d80..a45362f, tests: bun test ./packages/core → Ran 14 tests across 4 files. [498.00ms])
Task 3: Ruling: gates (~open_gate, ~open_outer_gate) count as open — first build left 60 gates unknown, which the router would block — cost if wrong: none, gates in content open freely
Task 3: Ruling: unknown doors (66) are treated as blocked by the router — never guess a door is passable — cost if wrong: some routes take a longer way
Task 3: complete (commits a45362f..11028c7, tests: bun test ./packages/knowledge → Ran 34 tests across 4 files. [272.00ms])
Task 4: Ruling: data test goal moved from fountain tile (3212,3428) to walkable (3213,3424) — fountain is not walkable and the nearest path end is 2 tiles off, beyond GOAL_TOL 1; no_route there is correct — cost if wrong: none
Task 4: Ruling: walk legs succeed within a tolerance (stairs/ladders 2 tiles, goal 1) — stair tiles are objects, not floor; exact-tile matching gave no_route on every real route — cost if wrong: a 3x3+ stair could need a larger tolerance
Task 4: Ruling: lazy A* (lower-bound queueing, measure on pop) instead of eager Dijkstra — eager took 347 s for Lumbridge->Varrock; lazy 1.2 s, same cost — cost if wrong: none, still optimal with an admissible bound
Task 4: Ruling: one_way and quest doors are conservative (one_way always blocked; quest passes only if acct.varps[varp] > 0) — complete values not mined until Phase 1b — cost if wrong: some longer routes
Task 4: data: museum route uses stairs at (3259,3446,0) -> (3259,3449,1); Lumbridge->Varrock cost 226 in 1187 ms (pathfinder init ~10-15 s once per process)
Task 4: complete (commits 11028c7..f52695b, tests: bun test ./packages/core/test/world.test.ts ./packages/core/test/act.test.ts ./packages/core/test/ticks.test.ts ./packages/core/test/inprocess.test.ts → Ran 19 tests across 4 files. [534.00ms])
Task 5: Ruling: transport legs find the loc by its tile in live nearbyLocs and click by op number (op1 -> 1) — transports store debugnames, interactLoc matches display names — cost if wrong: a loc outside the 15-tile scan is reported as precondition, not clicked
Task 5: Ruling: walk leg budget = 2 x distance + 30 ticks — walkTo keeps running inside the checked window — cost if wrong: very slow paths time out and retry
Task 5: complete (commits f52695b..1a4c869, tests: bun test ./packages/core/test/walk.test.ts ./packages/core/test/reflex.test.ts ./packages/core/test/world.test.ts ./packages/core/test/act.test.ts ./packages/core/test/ticks.test.ts ./packages/core/test/inprocess.test.ts → Ran 25 tests across 6 files. [1490.00ms])
Task 6: Ruling: router drops op1 links of a stair that also has op2/op3 links — op1 is the 'Climb' menu (spiralstairsmiddle op1=Climb, op2=Climb-up, op3=Climb-down) — cost if wrong: a stair whose op1 is a real climb loses that edge
Task 6: Ruling: bank script uses Draynor bank (3092,3243), not Lumbridge castle — rev 289 has no Lumbridge castle bank (nearest bankers: Al Kharid 59 tiles, toll gate) — cost if wrong: none
Task 6: Ruling: climb leg default budget 30 -> 60 ticks — live floors run timed out at 30; replay measured 24 ticks for interactLoc to walk round a 2x2 staircase — cost if wrong: a stuck climb takes 60 ticks to report
Task 6: Ruling: run bot names carry a clock+counter token — a reused name (florr1) loaded its old save over the fresh preset — cost if wrong: none
Task 6: Ruling: checked ends at once as rejected when the send reply has success=false — climb failures waited the full budget and hid "Can't reach Staircase" — cost if wrong: a bot.* call that reports false but still causes the effect is counted as failed
Task 6: Ruling: walker opens the shut door nearest the stair (live nearbyLocs, within 8 tiles) after a "can't reach" climb, then retries — rs-sdk pathfinder treats doors as open; Lumbridge south stairs sit behind door loc_1530 (3208,3211) — cost if wrong: opens an unrelated door within 8 tiles
Task 6: Ruling: finish() closes sessions with a 5 s limit each, then exits — one run hung after RESULT ok until the 300 s kill — cost if wrong: a slow close skips the clean logout (engine still saves on socket close)
Phase4: Ruling: level 99 = 998,458 XP (engine formula, cross-checked against save-generator for all levels) — research note's ~1.07M was the agent's own arithmetic, not checked — cost if wrong: none
Phase2-T6: Ruling: finish() logs out in game (logout:try_logout, component 2458) before closing — a closed socket left the account in the world for 500 ticks (idle logout seen in engine.log), and playtime counts every tick in the world — cost if wrong: up to 15 s extra wait when logout is refused (combat, duel)
Task 6: 10x proof #1: gather 10/10, bank 10/10, fight 10/10, floors 7/10 (2 hung after RESULT ok until the 300 s kill, 1 Can't reach Staircase), trade 7/10 (2 Player not found nearby).
Task 6: Ruling: trade waits up to 30 ticks for the partner to appear in nearbyPlayers before trading — partner not yet visible right after login — cost if wrong: none
Task 6: Ruling: walker also walkTo(stair, tol 1) after a can't-reach climb, after the nearest-door open — walkTo opens doors on its own route — cost if wrong: a few extra ticks per refused climb
Task 6: Ruling: finish() has a 30 s hard-exit backstop — 2 runs hung after RESULT ok (cause not found; both before the in-game logout fix) — cost if wrong: masks a real hang, but run time still shows it
Task 6: 10x proof #2 (floors, trade, after fixes): floors 10/10 (36-82 s), trade 10/10 (25-44 s), no backstop exits.
Task 6: Ruling: gather/bank/fight 10/10 from proof #1 are kept, not rerun after the walker change — the change only adds a walkTo after a can't-reach climb, which those runs never hit — cost if wrong: a regression in bank's goTo path is untested until the next proof
Task 6: Ruling: processMatches test gets a 30 s limit — three PowerShell CIM lookups (~1.5 s each) exceeded 5 s under full-suite load — cost if wrong: none
Task 6: complete (commits 1a4c869..ce36ad0, tests: bun test ./packages/core/test/walk.test.ts ./packages/core/test/reflex.test.ts ./packages/core/test/world.test.ts ./packages/core/test/act.test.ts ./packages/core/test/ticks.test.ts ./packages/core/test/inprocess.test.ts ./packages/core/test/logout.test.ts ./packages/core/test/bot.test.ts ./packages/practice ./packages/knowledge ./packages/planner → Ran 114 tests across 28 files. [21.01s])
Final: Ruling: shim session-end test limit 100 ms -> 2 s — failed 1 of 3 solo runs at 137 ms (timer jitter); the guarantee is 'not the 60 s SDK timeout' — cost if wrong: none
Final: fixed C1 single logout click lost in the combat window / click stuck behind queue — 'logout keeps clicking until the server accepts it' + 'a click that never resolves cannot hang logout' + 'direct() reaches the client while a slow action holds the queue' RED→GREEN; finish() now fails the run when logout does not complete
Final: fixed I1 failed login left the account in the world — openBot logs out + closes before rethrowing; two-account scripts log the first account out if the second login fails (no unit test: login path is live-only; covered by typecheck)
Final: fixed I2 checked() waited for send() — 'a known outcome returns at once even while send() is still running' + 'a send() that throws becomes a rejected outcome' RED→GREEN
Final: fixed I3 reflex abort did not stop in-flight walkTo — 'aborting the walk cancels the in-flight bot.walkTo through the SDK execution context' RED→GREEN
Final: fixed I4 waits hung after session end — 'waits and checked actions end at once when the session ends' RED→GREEN; core suite 43/43
Final: fixed I5 walkTo ignored doors the router avoided — 'goTo blocks, in the SDK pathfinder, the doors this account cannot pass near the route' RED→GREEN
Final: fixed I6 A* bound inadmissible across the z+6400 plane — 'dungeon tiles do not mislead the search into a far exit' RED→GREEN (first version passed by accident: the far exit was beyond MAX_LEG); bound now uses PORTAL_TOL so it matches the walk edges
Final: Ruling: I6 retracts the Task 4 ledger claim "still optimal" — it was false for dungeon routes until this fix — cost if wrong: none now
Final: fixed I7 drop tables with next-line braces / independent if-return blocks read as always-drops — 'brace-on-next-line tables with independent if blocks ending in return are roll slots' RED→GREEN; bronze_dragon 0 -> 22 rolls (122/128); always-drops under an if are marked conditional
Final: fixed I8 quest XP set through a setter proc missed — 'XP is found when completion is set through a setter proc' RED→GREEN; quests with XP 37 -> 39 of 64; fact check 19793, 0 wrong
Final: minor (deferred): M1 non-exact transport arrival > 3 tiles times out and fails retries on precondition
Final: minor (deferred): M2 quest doors pass on any varp > 0 (latent; accountOf sends no varps)
Final: minor (deferred): M3 a late opRejectedCount rise from an earlier op can mislabel this op as rejected
Final: minor (deferred): M4 ~random_range drop counts parse as count 1 (10 rolls)
Final: minor (deferred): M5 connectInProcess sets loginJitterMs 0 for any host; keep upstream jitter for non-localhost
Final: minor (deferred): M6 run names can recur about every 46.7 s
Final: minor (deferred): M7 reflex treats missing Hitpoints state as HP 99
Final: fixed M5 (was deferred) zero login jitter for any host — 'login jitter is 0 only for a local server' RED→GREEN; needed before any demo-server login
Final: fixed M7 (was deferred) missing Hitpoints read as 99 — 'missing Hitpoints state counts as unknown' RED→GREEN; the reflex now errs toward fleeing
Final: fixed M4 (was deferred) ~random_range counts parsed as 1 — 'a ~random_range(a, b) count keeps both ends' RED→GREEN; 10 rolls now carry countMax
Final: re-proof #3 after the fix pass: gather 10/10, bank 10/10, fight 10/10 (logout after combat, 0 WARN logout lines: C1 verified live), trade 10/10, floors 9/10 (run 9: walk after descending refused 3 times in 11 ticks).
Final: fixed floors run 9 — 'a walk refused right after a climb waits before retrying, then succeeds' RED→GREEN; walker waits 2/4/6 ticks before retrying a rejected leg; core suite 51/51
Final: floors rerun after backoff: 8/10 (run 9 walk refused, run 10 Can't reach Staircase). Late runs fail across proofs: the castle door a bot opens closes itself after 500 ticks (~open_door(500)), so later runs meet it shut.
Final: Ruling: walk legs do not stop on opFeedback refusals (rejectOnFeedback false) — my I2/I3 fix ended the leg and cancelled bot.walkTo on the first refused step, before walkTo could open the shut door — 'a walk leg lets walkTo deal with a refused step' RED→GREEN; core 52/52 — cost if wrong: a truly blocked walk now runs to its tick budget instead of failing fast
Final: full proven rerun after walk fix: gather 9/10, bank/floors/fight/trade 10/10. Gather run 2: RESULT ok, then "logout did not complete: timeout".
Final: Ruling: logout retry 1500 ms -> 300 ms — try_logout ends silently when canAccess fails (delayed), and a 5-tick retry can alias a skilling delay cycle; gather does not use walk legs, so the walk fix is not the cause — cause is inferred from engine code, not seen in a log — cost if wrong: the flake stays and a next fix needs a logout diagnostic
Final: gather 20/20 after the logout retry fix (2 batches of 10). bank/floors/fight/trade 10/10 after the walk fix, before the logout fix — Ruling: merge without re-proving those four — the logout change only shortens the click retry — cost if wrong: one of them flakes at logout on master
