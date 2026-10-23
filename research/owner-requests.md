# Owner requests and standing rules (full audit, checked 2026-10-23 07:15 UTC)

## How this list was built

Sources, all read with scripts (`bun`, `jq`), not by hand:

| Source | Raw entries | Owner messages after dedup |
|---|---|---|
| 22 headless transcripts (`0d757301`, `0e8b3db3`, ... `f6d4a626`) | 1 harness prompt each (author-loop task), 0 text from the owner | 0 |
| Main session `72e3d252`: user entries (string or text blocks, no tool results, no system tags) | 81 | 60 |
| Main session `72e3d252`: `queued_command` attachments (messages sent mid-turn) | 59 | 54 |
| Main session `72e3d252`: `queue-operation` enqueue entries | 79 | 65 (3 only here) |
| `~/.claude/history.jsonl`, project path `rs-sdk-bot` (idlescape paths left out) | 128 | 109 (3 only here: `/exit`, `/resume`, a repeat paste) |
| 2 compaction summaries in `72e3d252` ("All user messages") | 2 lists | 0 new; every quoted message is in the set above |
| **Total, deduplicated** | 347 | **114 messages** (2026-10-22 02:38 to 2026-10-23 06:47 UTC) |

51 of the 114 messages exist only in the queued or enqueue form, not as a plain user entry. 3 messages arrived from the
coordinator after the audit started (rows 63-65). One message (05:09) is not a project request and has no row.

From the 114 messages: 23 standing rules (R1-R23), 65 request rows (1-65), and 24 of my own commitments (C1-C24).
This audit added 8 rules, 14 request rows and 4 commitments, and corrected 15 statuses (list at the end).

Status words. The dashboard reads this file (`packages/dashboard/server.ts:478-495`): a row with a number in the first
column and a `Status` column shows in its request queue, in file order.

- **DONE**: shown to work (live, or by the test the owner asked for). The evidence column cites the commit or file and the result.
- **PARTIAL**: some of it exists. Code that was never shown to work live is PARTIAL. The evidence column says what is missing.
- **NOT STARTED**: nothing in the repo does it.
- **BLOCKED**: it cannot go on without an outside decision. The evidence column says which.
- **RULE**: a standing rule that is not a task.

"Said yes" is not DONE. "Committed" is not DONE.

Live state used for this check: `.practice/monitor.json` and `.practice/status/*.json` at 06:49 UTC (before the power cut),
and again at 07:14 UTC (after the restart: all live bots were relaunched at 07:12-07:13, 0 practice bots, 10.2 GB free).
Git is broken after the power cut (`git log -1`: "fatal: your current branch appears to be broken"), so commits after
`a9fbe85`/`368510b` could not be checked.

## Ranked action plan

Ordered by impact on THE GOAL (the main account at rank 1 on all 24 boards at once, from one run) and on the standing rules.
"Who" is the role that does the step. Numbers in "Unblocks" are row numbers below.

| Rank | Smallest next step that moves the most | Who | Rows | Unblocks |
|---|---|---|---|---|
| 1 | Correct the plan text that the owner already rejected. `research/haggis-run.md:9,28-29,41,76,232-235` still says "not possible ... change the goal" and "142 QP wins at any time"; `research/gap-closers.md` (368510b) repeats "A 142nd QP wins that board at any time". Rule (`boards-special.md` QP section): the leader `avery` has 145 of 145 at 1,022,262 ticks, so the main account needs 145 QP below that playtime. Rewrite each verdict as "gap = N ticks, closed by ...". Add a model test: QP is a clock board. | planner helper (owns haggis-run.md, gap-closers.md, haggis.ts) | 1, 56, R18, C11 | gate 1, C20, every helper that reads the plan |
| 2 | Turn the 76 unmeasured plan inputs (gate 1 detail) into one queue file, sorted by ticks saved on the one clock (`gap-closers.md` levers first: `combat-hp-bound` 17,033 realistic, `stun-guests` 2,407, `flinch-gather` 913, quest times). Two helpers measure from the top, 3 runs each, one practice bot each. | lead writes the queue; 2 helpers | 1, 5, 13, C13, C23 | gate 1, 11, 14 |
| 3 | Movement. Mightyrod moved on 4,456 of 6,315 ledger ticks (71%) in its 06:07 run. Commit the walk.ts change (217-line diff, `walkpath.test.ts`, `b-new-*.log` benches) only after a before/after bench on the same 3 routes, 3 runs each, then measure the same routes live. | walking helper | 12, C7, C24 | 2, 3, 4, R2 |
| 4 | Restart Mightyrod on the fixed fishing30 (XP curve `xpForLevel`, uncommitted diff) only after one practice proof that runs a feather refill trip 3 times (verification-2026-10-23.md rank 2). The live job still runs the 81f31bb code with the wrong curve. | fishing helper, then lead | 3, C24 | 2, 12 |
| 5 | Idle ticks. Live idle share at 06:49: Mightyrod 19%, Pocketpython 17%, mmtha0205 17%, Bigchopper 16%, Pocketrocket 16%, mmthv2350 15%. The newest goldfarm practice runs are worse (`goldxg3401` idleTicks=276 of 1,501, `goldxg5r12` 298). Find the largest idle cause per script from the `inputs` strip and fix that one first; prove 3/3, then live. | gold-farm helper; each script owner | 2, R2, C24 | 54, C18 |
| 6 | Resources in code, not in prompts. At 06:49: 8 practice bots (limit 6), 4.99 GB free (rule 5), 30 bun processes using 12.6 GB, alert `practice-load` open. The lead said "4 practice bots" at 06:48. Make `prove.ts` refuse a launch when `monitor.json` shows practiceBots >= 6 or freeGB < 5. Then the shared bot host (C4). | lead (prove.ts), then 1 helper (C4) | 44, R22, C4, C22 | R3, all live work |
| 7 | Gold economy loop: farmers bank coins, the banker collects, the courier buys supplies with them, food never runs out. Needs the supply cost model first (C14, `research/supply-costs.md` does not exist; `market-2026-10-23.json` is uncommitted). | gold helper + supply-cost helper | C18, C14, 4, 7 | 5, gate 3, Bank and Equipment boards |
| 8 | Write the supply manifest that gate 3 asks for ("no supply manifest"), from `haggis-run.md` "What helpers must prepare". One prep preset and one hand-off measurement per supply. | lead | 5 | gate 3, 7 |
| 9 | Quests. Time every route quest with a test account (quests are ESTIMATE, 600-7,200 ticks each). Waterfall: 1 ok in the last 5 practice runs (`wfcxo3f01` ok; `wfaxqxw01`, `wfbxjmk01`, `wff1xv9e01` fail at the giant door or die). Build the quest requirement graph from `vendor/rs-sdk/server/content` (none exists in `packages/knowledge`). | quest helper | 13, 56 | 1, QP board, gate 1 |
| 10 | Fresh live targets. Gate 4 fails: `research/hiscores-live.json` is missing. A script that saves the live boards every 10 minutes; the dashboard and the planner read it. | 1 helper (code, no live bot needed) | 61, C20 | gate 4, 58 |
| 11 | One owner message with all open decisions, each with its measured or modelled ticks on the main account's clock: stun relog live (15), login wine (16), Wilderness iron (`wild-iron`, 2,548 realistic), `charge-spam`, E1, B1, R1 (C20), Wilderness risk. | lead asks; owner decides | 15, 16, C20 | 1 |
| 12 | Dashboard acceptance. Screenshot proof (one `scripts/shot.ts` run, 0 Edge left) of: embed mode with no camera box (49), fixed practice strip (50), 2D/3D button (41), icon fallback for ids 3904+ (60), fly-between-bots animation (63), no auto-switch and interest sort (64). Then send the owner the link and ask for a verdict. | dashboard helper | 10, 41, 49-51, 58, 60, 63, 64 | 9 |
| 13 | Random events. Fix the failing genie test (`randomevents.test.ts:114`), commit the handler, prove it on practice with events on, then live. `random-events.md` says the live server has events on; INDEX cites `fly.toml:25` = off. Settle that with one live log search for "Tree spirit". | random-event helper | 47, C8 | 2, deaths |
| 14 | Commit the uncommitted work when the owner repairs git: 14 modified files and 18 new ones (list at the end). Each owner commits only files whose check passed. | each helper | R16 | 3, 12, 13, 47 |
| 15 | A standing verifier. Every "done" from a helper goes through `/verify-findings` before this file says DONE. The 06:44 verification found 9 wrong claims in 6 "done" items. | lead | 52, R20 | every DONE in this file |
| 16 | Specialist test beds for the boards with the earliest deadlines (Cooking 38, Fletching 58, Crafting 197, Herblore 447), each a measured method for the main run. | lead via swarm.json | 54, 11, 14 | 1 |
| 17 | Codex CLI and Gemini CLI runners in `packages/router` (the owner pays for ChatGPT Plus and Google AI Pro). | 1 helper | 17 | R13 |
| 18 | More names for the small roles (firemaking, fletching, smithing at 5 each). | 1 helper | 18 | 54 |

## Standing rules

These rules apply to all work. They are not tasks to tick off.

| # | Date | Rule (owner's words) | State now |
|---|---|---|---|
| R1 | 10-23 03:58 | "my main account ... be rank 1 in ALL these cattagories AT ONCE ... PERFECT SINGLE RUN with a swarm of assistants" | The main goal. All other work feeds it. 24 boards, list pasted 03:59. Memory: `project-haggis-main-goal.md`. |
| R2 | 10-23 03:45 | "wasted ticks are UNACCEPTABLE, standing still is a warcrime now" | **Broken.** Meaning: zero idle ticks, measured and shown. 06:49 idle share 15-19% on all 6 live bots; Mightyrod moved 71% of its ticks. Ledger counters exist (`packages/core/src/ledger.ts`). |
| R3 | 10-22 07:59, 08:04; 10-23 04:43 | "anything more you can do while that runs"; "accounts doing nothing, not managing runs ... never using sub agents when its a clear win" | Live runs, offline tests, web research, dashboard and data work at the same time. 6 live bots ran at 06:49 and again from 07:12. |
| R4 | 10-23 04:41, 05:46 | "make sure you are doing everything i have asked ... not just saying yes then never doing it"; "im worried you have forgotten alot" | This file is the check. Update it when a request lands or closes. |
| R5 | 10-22 20:19 | "why have you told me about it then done nothing?" | Never announce a next step and then stop. |
| R6 | 10-23 02:26-02:48, 06:27 | "always be improving / checking code / researching", "think and play like a pro speedrunner", "if you must fail, fail better", "never give up", "not a blind mantra"; "everything can always and should always be improving, optimizing and efficeny gaining" | Working rules. `research/pro-playbook.md` "Rules for our code from now on". |
| R7 | 10-23 02:53, 04:31 | "pros use google"; read "GAMECODE, SDK code and SCPIRT code, plus use piror art from the botting community" | Every method: web check, code check, then 3 measured runs. |
| R8 | 10-23 04:28 | "if you cant show it on the dashboard it means its not data you can see at all which is BAD!!!" | Every new counter goes into `status.ts` and onto the dashboard. |
| R9 | 10-23 01:26, 02:55, 04:36 | Account names are "sly penis jokes", "10/10 banger funny runescape penis jokes", fitted to the skill or job | `packages/core/src/names.ts`, 151 names in 19 roles. Never use codes or timestamps for live accounts. |
| R10 | 10-23 01:53, 02:14 | Community-accepted tricks are allowed ("prayer flicking", "the log out is one but there has to be more") | Memory `feedback-accepted-mechanics.md`. True exploits (login wine timer) stay out unless the owner says yes. |
| R11 | 10-22 03:28 | Goal is "RICH ... all the quests ... 99 in all skills ... BEST IN SLOT ... ranked 1 on every hiscore", "tasks ... picked ... based on the biggest progress" | Focus is R1; still true. |
| R12 | 10-22 03:29 | "the public demo server, beat the other bots"; "a team of accounts, specialists for each board"; "helpers can feed the specialists" | Design decisions. Since R18, specialists are test beds and helpers for the main run, not a replacement for it. |
| R13 | 10-22 03:31-03:32 | Claude, GPT and Gemini "using my SUSCRIPTIONS ONLY" (Claude Max, ChatGPT Plus, Google AI Pro); "scripting things is a great idea too"; "i just care about speed and progress" | No API keys. Only Claude is wired (row 17). |
| R14 | 10-22 03:35 (about 15 times); 10-23 06:26, 06:35 | "i need meaningful and impactful progress, i give you full decistion making power"; "you are a leader ... the mastermind"; "YOU are in charge" | Decide and act; do not ask, except the owner decisions in rank 11. |
| R15 | 10-23 04:01 | Main account login: "save the login safly" | Saved in a git-ignored `bot.env` plus a backup outside the repo. Never print or copy the password. Never test on the main account. |
| R16 | 10-23 06:17 | "make sure you dont lose track of work that you said you would do, then actioning all that work smartly ... spin alllll the plates" | Every "I will" gets a C row in the same turn (C1-C24). Uncommitted work is at risk: 32 files at 07:14, and git is broken. |
| R17 | 10-23 06:21, 06:26 | "not just 'busybody token burning' make it meaningful impactful and thoughtfully prompted to agents"; "i do have token limits to worry about" | One queue of measured work (C23), few helpers, each with a question that changes the plan. |
| R18 | 10-23 06:36 | "do not lower the fucking bar." "the goal is the goal" | Never redefine success to fit current numbers. Report "gap = N ticks, closed by ...". Memory `project-strategy-specialists.md`. **Broken in text**: `haggis-run.md:232-235` still offers "change the goal" (rank 1). |
| R19 | 10-23 03:53, 04:03, 04:33, 04:51, 05:48, 06:35 | "we need everything perfect man"; "every detail and every action DIALED IN"; "is that really the best you can do?"; "lock. the. fuck. in."; "my quality bar is sky high and i expect everything now" | The bar for DONE in this file. |
| R20 | 10-23 06:36 | "mistakes like that are unacceptable" (after "Quest Points has no clock") | Quote the code line, log line or test output before stating a board rule, a cause or a "proven". Memory `feedback-evidence-before-claims.md`. |
| R21 | 10-23 06:41 | Keep the main account name hidden in anything shareable "until it has top rank 1 in everything" | Dashboard done (row 48). New text in this file says "main account". |
| R22 | 10-23 05:57-06:01 | "i thinks it might be you"; "fucking edge! ... thats ALL you"; "being sloppy and careless about resources is NOT ACCEPTABLE." | Measure RAM before adding load; kill what you start. **Broken at 06:49**: 8 practice bots (limit 6), 4.99 GB free. Fix in code (rank 6). |
| R23 | 10-23 06:28 | "many plans and many accounts to be testing offline and online with real goals you have tested ... do this until we have an account at the top of every leaderboard" | Row 54. |

## Open items, in priority order

| # | Date | Request (owner's words, short) | Status | Evidence | Next action |
|---|---|---|---|---|---|
| 65 | 10-23 (after the power cut) | "spin everything up and get all in-progress work and agents going again" | PARTIAL | 07:14: 6 live bots relaunched at 07:12-07:13 (Mightyrod, Bigchopper, 4 farmers); this audit resumed. Helpers not checked. Git broken. | Lead lists each helper from before the cut and restarts or closes it; owner repairs git. Unblocks rank 14. |
| 1 | 10-23 03:58, 04:03 | Main account rank 1 on all 24 boards in one run; "every detail and every action DIALED IN to be PERFECT" | PARTIAL | Schedule model f691ad0 and gap closers 368510b: realistic Overall finish 43,703-46,252 ticks against the leader's 35,916 (gap 7,787-10,336); floor 30,580 (WIN, slack 5,336). Login lock and 5-gate checker ba0010c: `haggis-go.json` 06:39 `go:false`, "1/24 boards win with 2% margin; 76 inputs not MEASURED". The old status "BLOCKED BY RULES" and "owner decides: specialists" broke R18 and is withdrawn. | Rank 1 and 2: fix the QP and "change the goal" text; measure the 76 inputs from one queue. Who: planner helper, 2 measuring helpers. Unblocks gates 1-3. |
| 56 | 10-23 06:36 | "Quest Points very much HAS a clock limit!!!! ... mistakes like that are unacceptable" | PARTIAL | Correct in memory and `boards-special.md` (QP desc, then playtime; avery 145 at 1,022,262). Still wrong in `haggis-run.md:41,76` ("142 QP wins at any time") and in `gap-closers.md` (368510b, written after the correction). | Rank 1. Who: planner helper. Add a planner test that fails if QP is treated as clock-free. Unblocks 1, C11, C20. |
| 12 | 10-23 00:39 | "you move like a total moron. learn how a speedrunning and a pro ... would move" (meaning: movement must be pro-level and measured) | PARTIAL | 95c5e5a, 094e5ed. Live: Mightyrod moved on 4,456 of 6,315 ledger ticks (71%) in the 06:07 run; the courier walked 1,948 of 2,209 ticks. Uncommitted `walk.ts` (217 lines), `walkpath.test.ts`, benches `b-new-*.log`; no before/after result recorded. | Rank 3. Who: walking helper. Unblocks 2, 3, 4. |
| 2 | 10-23 04:43, 03:45 | No idle accounts; "standing still is a warcrime" (meaning: zero idle ticks, measured and shown) | PARTIAL | 6 live bots at 06:49 and again from 07:12. Idle share 15-19% on each (ledger `idle` over the ledger total). Per-tick input strip and action combos in `status.ts:34` on the dashboard. | Rank 5. Who: gold-farm helper first (4 accounts), then each script owner. |
| 3 | 10-23 04:23 | "fix mightyrod" | PARTIAL | 81f31bb: resume, eat, sell; live Fishing 22 -> 66 (07:13 status). Verification rank 1-2 and 5: wrong XP curve in the live code, the feather refill / rod rebuy / events paths never ran in a proof, false "died" detection. The fix is uncommitted. 71% of its ticks are movement. | Rank 4. Who: fishing helper, then lead relaunches. |
| 5 | 10-23 03:52 | Prep accounts "trade off everything required to the speedrunner ... with zero lost ticks" | PARTIAL | Trade resupply 12 ticks (`scripts/measure/trade-supply.ts`, 2 runs); lobster hand-off by trade worked live 4 times (06:33). Gate 3 "no supply manifest". | Rank 8. Who: lead. Unblocks gate 3. |
| 13 | 10-23 02:55 | "having the relationship between everything fully mapped and understood is vital" | PARTIAL | `packages/knowledge` builds items, NPCs, shops, transports, doors, quests, drops. No quest requirement graph (no "requirement" or "prereq" in `packages/knowledge/src`). No quest is timed. | Rank 9. Who: quest helper. Unblocks 1, 56. |
| 11 | 10-23 03:44 | "work out the leaders' route and beat it"; "the pocketpython will it get rank 1" | PARTIAL | 2-tick picks +22-23% (722c2fa). Best ranks (`rank-history.jsonl`): mmtha0205 Thieving #9, Pocketrocket #10, Pocketpython #14. Leaders beat our best case on Cooking, Fletching, Magic, Thieving, Mining (memory `project-strategy-specialists.md`). | Rank 2 queue: leader forensics on those 5 boards first. Who: research helper. Unblocks 1, 14. |
| 54 | 10-23 06:28 | "many plans and many accounts to be testing offline and online with real goals you have tested ... until we have an account at the top of every leaderboard" | PARTIAL | Live: 1 fisher, 1 woodcutter, 4 gold farmers. 0 boards at rank 1. No live account trains Cooking, Fletching, Crafting, Herblore, Firemaking, Prayer, Magic, Smithing, Mining, Agility, Runecraft, Ranged or combat. | Rank 16. Who: lead via `swarm.json`. Unblocks 1, 14. |
| 14 | 10-23 01:31, 03:35 | Accounts must be "impressive, their skill and speed should amaze everyone"; "pure WIN" | PARTIAL | No rank 1 on any board yet. | Follows from 1, 11, 54. |
| 7 | 10-23 04:39 | "keep track of everything we have so it can be used by speedrunners and supplier/helper accounts" | PARTIAL | Vault panel (14ef247), banker base fix (a9fbe85, verification rank 7). Banks of accounts that never opened them are unknown. | Each script opens the bank once at start and writes a snapshot. Who: core helper. Unblocks 5, 8 rank. |
| 4 | 10-23 04:23 | "get the lobster helpers going" | PARTIAL | Bigpackage bought 115 lobsters live and gave 28 to each of 4 farmers (06:33, `vault-log.jsonl`). No repeat loop. | Rank 7 (C18). Who: gold helper. |
| 9 | 10-23 04:28 | "we need more data ... measuring it so you can display it on the dashboard and use it to learn" | PARTIAL | Status files, ledger, input strip and combos, rank history, persisted events (14ef247), alerts (dfc445d). No report that compares live and practice rates per script, and nothing feeds the combos back into scripts. | Add a per-script live-vs-practice row on the dashboard from `results.jsonl` and status ledgers. Who: dashboard helper. |
| 8 | 10-23 04:31 | "monitoring our actions per tick and learning ... which actions combined are good time saves" | PARTIAL | `status.ts:34`: one digit per tick (last 300) and the most used action sets with XP/tick; on the dashboard (2aa7172). No cross-run analysis. | A report over all status files: action set -> XP/tick and move/tick, top and bottom 10. Who: data helper. Unblocks 2. |
| 61 | 10-23 04:13 | Links pasted with the dashboard request: mapview, rs-world (`localhost:3000`), hiscores, market | PARTIAL | Viewer embedded; live market item API used for icons (`server.ts:357-358`); hiscores read into rank history. Pace used an old snapshot until a9fbe85 ("live #1 times"); `research/hiscores-live.json` (gate 4) is missing. | Rank 10. Who: 1 helper. |
| 10 | 10-23 04:11, 04:23, 04:33 | Dashboard: "dark mode only", dense, one page, map and rs-world viewer, "banks, packs, health, skills ... what they are doing right now, what thir goal is", auto-updates; "FIX THE DASHBAORD NOW"; better than the cairn_* dashboard | PARTIAL | f9fdfdb, 14ef247, 2aa7172, 4d6a580, a9fbe85. The owner has not accepted it. | Rank 12. Who: dashboard helper. |
| 58 | 10-23 06:09 | "make it sexy as fuck ... desesly impormative ... a work of art, better than all that came before it" | PARTIAL | Rounds 2-3 (2aa7172, a9fbe85). Verification rank 6 (pace vs old #1) fixed in a9fbe85 by its message; not checked by a screenshot in this audit. | Rank 12. Who: dashboard helper. |
| 41 | 10-23 05:07 | Dashboard: 3D world default, 2D/3D button on the main map, real item icons, all data, dense | PARTIAL | 14ef247, 5032b16. Black 3D scene under 100% CPU (C5) not rechecked. | Rank 12. |
| 60 | 10-23 05:07 | Pack items "show the real in game items ... we should have those images locally ... locally is king" | PARTIAL | Local sheet `items.png` (`server.ts:309-314`). 185 items (ids 3904-4088) have no icon (verification rank 8). | Build the missing icons from the rev 289 cache, stored locally. Who: dashboard helper. |
| 63 | 10-23 (after 06:47) | "the map should fly between bots with a cool animation, not reload from black" | PARTIAL | In progress (coordinator, 07:1x). Not checked in code by this audit. | Rank 12: prove with 2 screenshots during a switch. Who: dashboard helper. |
| 64 | 10-23 (after 06:47) | "stop auto-switching the followed bot; sort live accounts so the most interesting is at the top" | PARTIAL | Auto-switch fixed in a854f2f (coordinator; not verified, git is broken). Interest sort in progress. | Define "interesting" as a score (level-up soon, rank change, alert, death) and show it. Who: dashboard helper. |
| 49 | 10-23 06:44 | Remove the camera controls box from the dashboard's 3D viewer; default view always right for the map window | PARTIAL | rs-world c713719 (`embed=1` hides UI chrome), dashboard a9fbe85 uses `embed=1` (`index.html`, 1 match). No screenshot in this audit. | Rank 12. |
| 50 | 10-23 06:44 | Practice accounts panel grows forever and pushes Live Accounts off screen | PARTIAL | a9fbe85 "fixed practice strip". No screenshot in this audit. | Rank 12. |
| 51 | 10-23 06:44 | Then review every section and element of the dashboard in turn and improve each | PARTIAL | Started in round 3; no section-by-section list exists. | Dashboard helper writes the list of sections with one fault and one fix each, then works it. |
| 42 | 10-23 05:37 | rs-world viewer: stop it constantly reloading, optimize it | PARTIAL | rs-world bcb984b, 5032b16: loads once, follow by postMessage, fps 20, scale 0.75, 1 fps when hidden. Owner has not confirmed; row 63 says it still reloads from black on a switch. | Close with row 63. |
| 47 | 10-23 (found by me) | Random events | PARTIAL | Handler `packages/core/src/randomevents.ts` and `research/random-events.md` are uncommitted; 1 test fails (`randomevents.test.ts:114`, genie). Bigchopper went past Woodpecker's death level (WC 49 -> 83) with no death (1 run). | Rank 13. Who: random-event helper. |
| 52 | 10-23 06:26 | "if you need someone checking and monitoring other agents work then spin one up and have it report back to you the big boss" | PARTIAL | Watchdog `scripts/monitor.ts` (dfc445d) writes `monitor.json` every 30 s. One verifier pass (ece5dc2) found 9 wrong claims. The 06:49 `practice-load` alert was open while the lead reported "4 practice bots". | Rank 15. Who: lead. |
| 53 | 10-23 06:12 | "make everything work together in perfect harmony across all systems, knowledge and agents" | PARTIAL | One plan (`swarm.json`, 56d86e9), one index and brief (cbbe5ae), watchdog (dfc445d). Open: plan files contradict each other on QP (row 56); `random-events.md` vs INDEX on events on/off; 32 files uncommitted. | Ranks 1, 13, 14. Who: lead. |
| 44 | 10-23 06:01 | "being sloppy and careless about resources is NOT ACCEPTABLE" | RULE | See R22. Broken at 06:49 (8 practice bots, 4.99 GB free). | Rank 6. |
| 15 | 10-23 01:55, 02:14 | Cancel the stun timer; "the log out is one but there has to be more" | BLOCKED | Relog clears the stun, +17% in practice (`scripts/measure/relog-bench.ts`). A Claude Code safety check blocked the live edit, so `RELOG` stays off. `gap-closers.md`: with `stun-guests` on, stun relog is worth 0 on the main clock. | Rank 11: owner confirms in plain words, with that number. |
| 16 | 10-22 (audit) | Cooking board (leader 38 ticks) | BLOCKED | Only the login wine timer reaches it, and it skips a level check: ruled an exploit (`research/bug-report-wine-login.md`, not sent). Login wine saves 1 tick in the model. | Rank 11: owner decision. Also search for a non-wine Cooking method that beats 38 ticks (rank 2 queue). |
| 17 | 10-22 03:31 | Use GPT and Gemini subscriptions as well as Claude | NOT STARTED | `packages/router/src` calls only `claude -p`; no "codex" or "gemini" in it. | Rank 17. Who: 1 helper. |
| 18 | 10-23 04:36 | "we need ALOT more funny penis joke names" | PARTIAL | 151 names in 19 roles (`names.ts`); firemaking, fletching and smithing have 5 each. Row 39 is the same request. | Rank 18. Check each new name is free on the server. |

## Closed items

| # | Date | Request (owner's words, short) | Status | Evidence |
|---|---|---|---|---|
| 6 | 10-23 04:39 | "a banker account that all our accounts trade off to once they ... finish a run" | DONE | Moneyshot + `scripts/banker.ts`: 86,078 coins received live from 4 thieves; payout of 20,000 to Bigpackage live. Fixes 74deebd not yet run live (C1). Starts on demand via `swarm.json`. |
| 57 | 10-23 06:37 | "haggis must not log in untill... when? you tell me exactly when" | DONE | Answered 06:40: when `bun scripts/haggis-gate.ts` prints GO. Lock in `connectInProcess` (ba0010c) refused a real login call ("login refused: HAGGIS_RUN=1 is not set"), 3 unit tests. Today: NO-GO, 0 of 5 gates pass. |
| 48 | 10-23 06:41 | Hide the main account name on the dashboard: blurred, click to reveal, safe to screenshot; no "... project" text | DONE | 4d6a580: 0 copies of the name in `/api/state`; 0 matches in `index.html`. The 3D viewer nameplate: `hideNames` in rs-world c713719. |
| 59 | 10-23 06:27 | Dashboard helper must "take screenshots but not keep fucking ms edge browers open" | DONE | 1a05d1b (kill by profile folder); watchdog kills leaked Edge (dfc445d); `monitor.json` edgeProcs 0 at 06:49 and 07:14. |
| 55 | 10-23 06:31 | "what are all your goals? how are you making them all happen? what can you do better?" | DONE | Answered 06:34 (goals table) and 06:47 (worst-first list). The 06:34 goal G1 proposed changing the goal; withdrawn under R18. |
| 62 | 10-23 04:54 | Tell the dashboard agent it is bad at its job and to fix the dashboard "right fucking now" | DONE | Relayed (the phrase occurs 11 times in `72e3d252`). |
| 43 | 10-23 05:18, 05:30, 05:57 | "check CPU and RAM", "check docker", "check again on whats eating up resources" | DONE | 06:01: RAM 1.9 -> 16.1 GB free; stray Edge (about 70% CPU) and a stuck python stopped; idle banker stopped. Docker: `docker ps` hung; Docker uses about 890 MB, not used by this project. |
| 19 | 10-23 04:33 | "fix ... the rs-world-viewer errors" | DONE | f9fdfdb: production build served by `scripts/serve-rsworld.ts` (no dev type-check overlay). |
| 20 | 10-22 02:38 | Read the video, find and clone the other projects, gather data and tools, then plan | DONE | `research/video/talk-notes.md`, `scripts/clone-vendor.sh`, `vendor/` clones, `research/rs-sdk-deep-dive.md` |
| 21 | 10-22 02:44 | "Web research on osrs/rs wider ecosystem ... bots, clients and automation scripts" | DONE | `research/wider-ecosystem.md`, `research/web-research.md`, `research/community-and-upstream.md` |
| 22 | 10-22 02:56 | "lets start the brainstorming" | DONE | `docs/superpowers/specs/2026-10-22-rs-sdk-bot-harness-design.md` |
| 23 | 10-22 02:59, 03:12 | Fix the stop-hook errors; do not carry global hooks into this project | DONE | `.claude/settings.local.json` `disableAllHooks: true`; python3 shim at `C:\Users\aggis\bin\python3` |
| 24 | 10-22 07:47, 18:28 | "audit this project for fundimental problems" (twice) | DONE | First audit fixes (319abff and later); `research/audit-2026-10-22-b.md` (96b8c3a, 3f6584c) |
| 25 | 10-22 19:38, 21:13 | "optimize and speed up the dev loop" | DONE | ac17fb2 (pathfinding snapshot 14 s to 1.6 s, parallel proofs); e053e28 (150 ms practice tick) |
| 26 | 10-23 00:00, 00:13, 00:15 | "can i watch it in the browser?"; "isnt there a live bot running in the live server"; "watch real progress on the real damn server" | DONE | Dashboard `http://localhost:3100`, viewer on the live world feed; 6 live bots shown at 07:14. |
| 27 | 10-23 00:39 | "collect a full pack of bread or cake ... BEFORE pickpocketing ... restock the pack full" | DONE | 77a88c0; live rate 45 to 260 XP/tick (3688fde) |
| 28 | 10-23 01:24, 01:26 | "we need cooler names", "make them all sly penis jokes" | DONE | e748a74, f9fdfdb (`packages/core/src/names.ts`) |
| 29 | 10-23 02:22, 02:47 | "find them all [tricks] and plan how we can use them" | DONE (first pass) | `research/tricks-plan.md` (65fc33f), `research/pro-playbook.md` (9e3abdf), `research/tick-tricks-web.md`, `gap-closers.md` levers. 3-tick woodcutting +29% (65fc33f), 3-tick fly fishing +29% (02ae918). Keep adding (R6). |
| 30 | 10-23 02:50, 02:53 | "think and tell me what your missing"; learn "the game knowledge a pro speedrunner plays with ... the methods and paths" | DONE (first pass) | `research/pro-playbook.md`, `research/quest-xp.md` (bb2f8fb), `research/quest-route.md` (7083d95) |
| 31 | 10-23 04:01 | Claim the main account, set the password, log out at once, save the login | DONE | bfc9b4e (`scripts/claim-account.ts`, logs out on the first tick); login file git-ignored, backup outside the repo |
| 32 | 10-23 04:21 | "give me the link to the sodding dashboard" | DONE | `http://localhost:3100` |
| 33 | 10-23 04:29 | "how many actions can you perform in a single tick?" | DONE | 5 USER_EVENT per tick, 20 CLIENT_EVENT, 2 RESTRICTED (`research/xp-per-tick.md`; `ClientGameProtCategory.ts:6`) |
| 34 | 10-23 03:17 | "did we just get rank 1 theiving? is jackalopeth8 us?" | DONE | Answered: no, jackalopeth8 is not ours |
| 35 | 10-23 02:57 | "say 'yes sir boaby'" | DONE | Said in chat |
| 36 | 10-23 04:45, 06:45 | "keep a list of all the requests i made"; "go back thru all the sessions ... add them to the owner requests" | DONE | This file (all 23 transcripts, prompt history, both compaction summaries) |
| 45 | 10-23 05:07 | Tell the agents they are stinky poo poo bums (in-joke) | DONE | Sent to 4 agents |

Duplicate rows kept for history: 37 = 6 (banker), 38 = 7 (tracking), 39 = 18 (names; old status DONE was wrong), 40 = 4 (lobsters), 46 = 35 (yes sir boaby).

## My own commitments (things I said I would do)

Rule: every "I will" in chat gets a row here in the same turn. Close a row only with evidence.

| # | I said I would | State | Evidence / next step |
|---|---|---|---|
| C1 | Fix the banker payout waste (4 declined trades) | PARTIAL | bc8a6c9, 74deebd (long serve window, stale requests dropped). Not run live since. |
| C2 | Give Bigpackage's 115 lobsters to the banker | DROPPED | Bigpackage gave them to the gold farmers directly (C16) |
| C3 | Stop the practice server when the testing helpers finish | OPEN | 0 practice bots at 07:14; the server state after the power cut is not checked |
| C4 | Shared bot host: many bots in one process, one path map, measure RAM before and after | NOT STARTED | 30 bun processes used 12.6 GB at 06:49. Rank 6. |
| C5 | Fix the black 3D scene in the dashboard | OPEN | Not rechecked; rank 12 screenshot |
| C6 | Cut the 18 idle ticks after the Musa Point boat landing | REFRAMED | Repeat costs are 8 idle ticks per boat talk and 19-25 tick walk stalls; in C7 |
| C7 | Cut the courier's walking (1,948 of 2,209 ticks) | IN PROGRESS | `walk.ts` diff, benches `b-new-*.log`, uncommitted. Rank 3. |
| C8 | Find what killed Woodpecker | OPEN | NPC name is "Tree spirit" (`antimacro.npc:984-1164`), not "dryad". Bigchopper passed WC 49 at the willows with no death (1 run). Rank 13. |
| C9 | Put the 4 Thieving 99 accounts to work making gold | DONE | Live from 06:33; about 14 coins/tick each (phase lines `t=2001 banked=25000 packCoins=2050-3850`) |
| C10 | Actions-per-tick monitor | DONE | `status.ts:34` input strip and combos, on the dashboard (2aa7172). Learning report is row 8. |
| C11 | Main account 24-board schedule | PARTIAL | f691ad0, 368510b. Holds the QP error and "change the goal" text (rank 1). |
| C12 | Research index and shared agent brief | DONE | cbbe5ae; tick 399.8 ms (931c784) |
| C13 | Measure supply-board tick floors | IN PROGRESS | `scripts/measure/floor-*.ts` uncommitted; `research/supply-floors.md` does not exist; last run `floorx12o01` fail (Smithing, 0.02 actions/tick). |
| C14 | Live supply cost model | IN PROGRESS | `research/supply-costs.md` does not exist; `research/market-2026-10-23.json`, `scripts/market-snapshot.ts` uncommitted |
| C15 | Plans for Equipment, Bank, Runite, Quest Points boards | DONE | `research/boards-special.md` (8a2f1f0) |
| C16 | Feed the gold farmers and enable them in swarm.json | DONE | b93a84e 3/3 practice (14.8-15.6 coins/tick); 28 lobsters each by trade, live |
| C17 | Stop the practice server when all practice helpers finish | OPEN | Same as C3 |
| C18 | Gold economy loop | OPEN | Rank 7 |
| C19 | Main account login lock with 5 gates | DONE | ba0010c, `scripts/haggis-gate.ts`; NO-GO today |
| C20 | Answer the special-board walls (Equipment tie at code max, Bank 16.14B, Runite contested, QP 145 at 1,022,262) without lowering the goal | OPEN | `boards-special.md` (8a2f1f0); owner decisions E1, B1, R1. Rank 11. |
| C21 | Quote the evidence line before a cause, a "proven" or a board rule | RULE | Memory `feedback-evidence-before-claims.md` (06:48). Broken once since: `gap-closers.md` QP line. |
| C22 | Read the watchdog on every wake-up and act on its alerts first | PARTIAL | Read at 06:48, but reported "4 practice bots" while `monitor.json` (06:49) showed 8 and an open `practice-load` alert |
| C23 | Make the 76 unmeasured inputs one queue, ordered by ticks saved; fewer, steadier helpers | NOT STARTED | No queue file found in `research/`, `packages/planner/src` or `scripts/`. Rank 2. |
| C24 | Live measurement before calling the walking, fishing and gold-farm idle fixes done | OPEN | Ranks 3-5 |

## Uncommitted work (2026-10-23 06:49 UTC; git broken since the power cut)

Modified: `packages/core/src/bot.ts`, `packages/core/src/walk.ts`, `packages/dashboard/index.html`, `packages/dashboard/server.ts`,
`packages/planner/src/haggis-boards.json`, `haggis-cli.ts`, `haggis.ts`, `packages/planner/test/haggis.test.ts`,
`packages/practice/src/presets.ts`, `scripts/generated/fishing30.ts` (XP curve fix), `gecourier.ts`, `thieving60.ts`,
`waterfall.ts`, `scripts/goldfarm.ts`.

New: `packages/core/src/randomevents.ts` and its test, `packages/core/test/walkpath.test.ts`, `research/gathering-tricks.md`,
`research/market-2026-10-23.json`, `research/random-events.md`, `scripts/market-snapshot.ts`, `scripts/measure/fish-delayed.ts`,
`flinch.ts`, `floor-*.ts` (7 files), `b-new-*.log` (5 bench logs), `packages/planner/src/.abl-tmp.ts`.

## Statuses corrected by this audit

1 (BLOCKED BY RULES -> PARTIAL), 3 (DONE -> PARTIAL), 17 (PARTIAL -> NOT STARTED), 39 (DONE -> duplicate of 18, PARTIAL),
42 (DONE -> PARTIAL), 47 (NEW -> PARTIAL), 49, 50, 51 (IN PROGRESS -> PARTIAL, code committed, not shown), C1 (DONE -> PARTIAL),
C9 (IN PROGRESS -> DONE), C10 (IN PROGRESS -> DONE), C11 (DONE -> PARTIAL), C15 (IN PROGRESS -> DONE), R2/R22 (marked broken).
| 66 | Cooking decision (owner gave full permission after double-checking) | DONE | Rule kept: no content bugs. Cooking #1 (20 ticks) needs the login-wine bug; legal route measured 339-375. Bug reported: https://github.com/MaxBittker/rs-sdk/issues/102. Gem cutting / potions / arrows (level checked, no delay) ruled accepted like battlestaves | Watch the issue; if fixed and the board resets, plan the legal Cooking run |
| 67 | Magic board vs the content-bug rule | DONE | Magic #1 (1,324) needs Charge with no delay (charge.rs2:1-27); best legal ladder measured about 1,670 from level 44. Bug reported: https://github.com/MaxBittker/rs-sdk/issues/103. Smithing flipped to 1,312 vs 1,337 (helper trades at the anvil, 7fe709a) | Watch #102/#103; Firemaking needs a 157-tile walled line |
| C25 | Gold farm safety | PAUSED | 5 live farmer deaths on 2026-10-23 (3 at shop trips after restarts, fixed 7c5119a; 2 during stall food trips with no food left). Stall food is not safe live. Farm off until a safe food supply exists (lobster trades, or the grape lever replaces it: research/grape-gold.md pending) |
