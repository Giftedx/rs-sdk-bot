# Owner requests and standing rules (checked 2026-10-23 04:50 UTC)

Source: every message the owner typed in session `72e3d252` (2026-10-22 02:38 to 2026-10-23 04:45 UTC), including
messages queued while a turn ran. The other 22 transcripts in this project are headless author-task sessions with no
owner messages. Times are UTC. Status words:

- **DONE**: the repo or the live server shows it. The evidence column cites the commit or file.
- **PARTIAL**: some of it exists. The evidence column says what is missing.
- **NOT STARTED**: nothing in the repo does it.
- **BLOCKED**: it cannot go on without an outside decision. The evidence column says which.

"Said yes" is not DONE.

## Standing rules

These rules apply to all work. They are not tasks to tick off.

| # | Date | Rule (owner's words) | State now |
|---|---|---|---|
| R1 | 10-23 03:58 | "my main account Haggis be rank 1 in ALL these cattagories AT ONCE ... PERFECT SINGLE RUN with a swarm of assistants" | The main goal. All other work feeds it. 24 boards, list pasted 03:59. Memory: `project-haggis-main-goal.md`. |
| R2 | 10-23 03:45 | "wasted ticks are UNACCEPTABLE, standing still is a warcrime now" | **Broken now**: at 04:49 no live bot runs (only the local stack, dashboard and viewer). Ledger counters exist (`packages/core/src/ledger.ts`). |
| R3 | 10-23 04:43 | "accounts doing nothing, not managing runs ... not using sub agents when its a clear win" | **Broken now**: live accounts idle. Keep live runs, offline tests, web research, dashboard and data work going at the same time. |
| R4 | 10-23 04:41 | "make sure you are doing everything i have asked ... not just saying yes then never doing it" | This file is the check. Update it when a request lands or closes. |
| R5 | 10-22 20:19 | "why have you told me about it then done nothing?" | Never announce a next step and then stop. |
| R6 | 10-23 02:36-02:48 | "always be improving / checking code / researching", "think and play like a pro speedrunner", "if you must fail, fail better", "never give up", "not a blind mantra" | Working rules. `research/pro-playbook.md` "Rules for our code from now on". |
| R7 | 10-23 02:53, 04:31 | "pros use google"; read "GAMECODE, SDK code and SCPIRT code, plus use piror art from the botting community" | Every method: web check, code check, then 3 measured runs. |
| R8 | 10-23 04:28 | "if you cant show it on the dashboard it means its not data you can see at all which is BAD!!!" | Every new counter goes into `status.ts` and onto the dashboard. |
| R9 | 10-23 01:26, 02:55, 04:36 | Account names are "sly penis jokes", "10/10 banger funny runescape penis jokes", fitted to the skill or job | `packages/core/src/names.ts`, 138 names (f9fdfdb). Never use codes or timestamps. |
| R10 | 10-23 01:53, 02:14 | Community-accepted tricks are allowed ("prayer flicking", "the log out is one but there has to be more") | Memory `feedback-accepted-mechanics.md`. True exploits (login wine timer) stay out. |
| R11 | 10-22 03:28 | Goal is "RICH ... all the quests ... 99 in all skills ... BEST IN SLOT ... ranked 1 on every hiscore", "tasks ... picked ... based on the biggest progress" | Superseded in focus by R1, still true. |
| R12 | 10-22 03:29 | "the public demo server, beat the other bots"; "a team of accounts, specialists for each board"; "helpers can feed the specialists" | Design decisions, `docs/superpowers/specs/2026-10-22-rs-sdk-bot-harness-design.md`. |
| R13 | 10-22 03:31 | Claude, GPT and Gemini "using my SUSCRIPTIONS ONLY"; "scripting things is a great idea too"; "i just care about speed and progress" | No API keys. Only Claude is wired (see #17). |
| R14 | 10-22 03:35 (repeated ~15 times) | "i need meaningful and impactful progress, i give you full decistion making power" | Decide and act; do not ask. |
| R15 | 10-23 04:01 | Haggis login: "save the login safly" | Saved in a git-ignored `bot.env` plus a backup outside the repo. Never print or copy the password. Never test on Haggis. |

## Open items, most important to the Haggis goal first

| # | Date | Request (owner's words, short) | Status | Evidence | Next action |
|---|---|---|---|---|---|
| 1 | 10-23 03:58, 04:03 | Haggis rank 1 on all 24 boards in one run; "every detail and every action DIALED IN to be PERFECT" | BLOCKED BY RULES | f691ad0 research/haggis-run.md: Overall #1 has 19 skills at 99 in 35,916 ticks; Haggis needs 39,704+ even at best case, so all 24 at once is impossible on one playtime clock | Owner decides: specialist accounts per board (14 winnable best case, 4 realistic) and Haggis takes Quest Points, Equipment, Bank, Runite |
| 2 | 10-23 04:43, 03:45 | No idle accounts; "standing still is a warcrime" | PARTIAL | Ledger on every bot (61953b2). But no live bot runs now; Mightyrod is stopped, Morningwood never launched. | Relaunch live specialists under `packages/practice/src/supervise.ts` right after #3 and #6. |
| 3 | 10-23 04:23 | "fix mightyrod" | DONE | 81f31bb (resume logic, eat, sell for coins, no low-HP thieving); proved 2/2 on practice; live again since 06:4x, Fishing 44 -> 62 | Watch its idle share (21% at 07:27) |
| 4 | 10-23 04:23 | "get the lobster helpers going" | PARTIAL | Bigpackage bought 115 lobsters live (gecourier, 2,209 ticks, bc8a6c9 era) | Feed the gold farmers (C16); cut the walking (C7) |
| 5 | 10-23 03:52 | Prep accounts "trade off everything required to the speedrunner ... with zero lost ticks" | PARTIAL | Trade resupply measured at 12 ticks (`scripts/measure/trade-supply.ts`); stun-trade test (61953b2). No prep-account workflow, no list of what Haggis needs. | After #1 lists the supplies: one prep preset per supply, and a hand-off script that measures ticks per trade. |
| 6 | 10-23 04:39 | "a banker account that all our accounts trade off to once they ... finish a run" | DONE | Moneyshot + scripts/banker.ts; 86,078 coins received from 4 thieves; payouts work (20,000 to Bigpackage) | Start on demand via swarm.json |
| 7 | 10-23 04:39 | "keep track of everything we have so it can be used by speedrunners and supplier/helper accounts" | PARTIAL | Dashboard vault panel from vault-log + snapshots (round 2) | Banks of accounts that never opened them are unknown |
| 8 | 10-23 04:31 | "monitoring our actions per tick and learning ... which actions combined are good time saves" | PARTIAL | Ledger classifies each tick outcome (xp/move/anim/dialog/stun/idle). No record of the actions sent per tick, no combo analysis. | Log every `s.direct` and SDK action with its tick number in `status.ts`; add a report of action sets per tick against XP and move gained. |
| 9 | 10-23 04:28 | "we need more data ... measuring it so you can display it on the dashboard and use it to learn" | PARTIAL | Status files, counters, timeline (61953b2, f9fdfdb). Phase events persist to a file only in the uncommitted diff. No per-tick action log (#8). | Commit the events change; add #8 data; add live-vs-practice rate comparison per script. |
| 10 | 10-23 04:11, 04:23, 04:33 | Dashboard: "dark mode only", dense, one page, map and rs-world viewer, "banks, packs, health, skills ... what they are doing right now, what thir goal is", auto-updates; "FIX THE DASHBAORD NOW" | PARTIAL | f9fdfdb: dark three-column page, map, viewer link, pack, bank, HP, skills, goal, timeline, ranks, server-sent events every 2 s, new accounts from `bot.env`. Missing: vault (#7), actions per tick (#8), role inference and live-first order are uncommitted. Owner has not accepted it. | Commit the diff, add the missing panels, screenshot with `scripts/shot.ts`, send the owner the link `http://localhost:3100`. |
| 11 | 10-23 03:44 | "work out the leaders' route and beat it"; "the pocketpython will it get rank 1" | PARTIAL | Leader rhythm copied: 2-tick direct picks +22-23% (722c2fa). Pocketpython is Thieving 99 but rank 14 (dashboard `/api/state`, 04:49). Best ranks: mmtha0205 #9, Pocketrocket #10. Bakery food shortage cost 309 shopTicks. | Fresh account with courier food (#4), knights 2-tick from the start, study the leaders' castle door and chest loop. |
| 12 | 10-23 00:39 | "you move like a total moron. learn how a speedrunning and a pro ... would move" | PARTIAL | Closest target and no walk-back (95c5e5a); danger-checked routes (094e5ed); click-ahead `glide.ts` measured slower, not used. No general movement method. | Measure stand-still-before-click (`Player.ts:1348`), path tick counts against the leaders in the live feed, then fix `walk.ts`. |
| 13 | 10-23 02:55 | "having the relationship between everything fully mapped and understood is vital" | PARTIAL | `packages/knowledge` builds items, NPCs, shops, transports, doors, quests, drops. No quest requirement graph; `research/pro-playbook.md` lists "Need quest requirement map and timings". | Build the quest requirement graph and timings; feed it into #1. |
| 14 | 10-23 01:31, 03:35 | Accounts must be "impressive, their skill and speed should amaze everyone"; "pure WIN" | PARTIAL | No rank 1 on any board yet. | Follows from #1-#12. |
| 15 | 10-23 01:55, 02:14 | Cancel the stun timer; "the log out is one but there has to be more" | BLOCKED | Relog clears the stun, +17% in practice (`scripts/measure/relog-bench.ts`, uncommitted; dee77d2). A Claude Code safety check blocked the live edit, so `RELOG` stays off. `research/tricks-plan.md` says "not approved by the owner", which conflicts with the owner's 02:14 message. | Owner: confirm in plain words that relog stun-cancel is allowed live, and allow the edit if the safety check asks. No other stun cancel found (`research/tricks-plan.md`). |
| 16 | 10-22 (audit) | Cooking board (leader 38 ticks) | BLOCKED | Only the login wine timer reaches it, and it skips a level check: ruled an exploit (`research/bug-report-wine-login.md`, not sent). | Owner decision: use it, or report it to the server author and accept a lower Cooking rank. |
| 17 | 10-22 03:31 | Use GPT and Gemini subscriptions as well as Claude | PARTIAL | `packages/router` calls only `claude -p` (no "codex" or "gemini" in `packages/router/src`). The Gemini CLI was broken (first summary). | Add Codex CLI (ChatGPT Plus) and Gemini CLI runners to the author loop; test each on one author task. |
| 18 | 10-23 04:36 | "we need ALOT more funny penis joke names" | PARTIAL | 138 names (f9fdfdb), but runite has 3, herblore 4, bank 4, magic 5. | Add names to the small roles before they run out; check each is free on the server. |
| 19 | 10-23 04:33 | "fix ... the rs-world-viewer errors" | DONE | f9fdfdb: production build served by `scripts/serve-rsworld.ts` (no dev type-check overlay); process runs now. | Owner check in the browser. |

## Closed items

| # | Date | Request (owner's words, short) | Status | Evidence |
|---|---|---|---|---|
| 20 | 10-22 02:38 | Read the video, find and clone the other projects, gather data and tools, then plan | DONE | `research/video/talk-notes.md`, `scripts/clone-vendor.sh`, `vendor/` clones, `research/rs-sdk-deep-dive.md` |
| 21 | 10-22 02:44 | "Web research on osrs/rs wider ecosystem ... bots, clients and automation scripts" | DONE | `research/wider-ecosystem.md`, `research/web-research.md`, `research/community-and-upstream.md` |
| 22 | 10-22 02:56 | "lets start the brainstorming" | DONE | `docs/superpowers/specs/2026-10-22-rs-sdk-bot-harness-design.md` |
| 23 | 10-22 02:59, 03:12 | Fix the stop-hook errors; do not carry global hooks into this project | DONE | `.claude/settings.local.json` `disableAllHooks: true`; python3 shim at `C:\Users\aggis\bin\python3` |
| 24 | 10-22 07:47, 18:28 | "audit this project for fundimental problems" (twice) | DONE | First audit fixes C1, I1-I8 (319abff and later); `research/audit-2026-10-22-b.md` (96b8c3a, 3f6584c) |
| 25 | 10-22 19:38, 21:13 | "optimize and speed up the dev loop" | DONE | ac17fb2 (pathfinding snapshot 14 s to 1.6 s, parallel proofs); e053e28 (150 ms practice tick) |
| 26 | 10-23 00:00, 00:13, 00:15 | "can i watch it in the browser?"; "watch real progress on the real damn server" | DONE | d34617d, f9fdfdb: dashboard on `http://localhost:3100`, viewer on the live world feed. Needs live bots (#2) to show progress. |
| 27 | 10-23 00:39 | "collect a full pack of bread or cake ... BEFORE pickpocketing ... restock the pack full" | DONE | 77a88c0; live rate 45 to 260 XP/tick (3688fde) |
| 28 | 10-23 01:24, 01:26 | "we need cooler names", "make them all sly penis jokes" | DONE | e748a74, f9fdfdb (`packages/core/src/names.ts`) |
| 29 | 10-23 02:22, 02:47 | "find them all [tricks] and plan how we can use them" | DONE | `research/tricks-plan.md` (65fc33f), `research/pro-playbook.md` (9e3abdf); 3-tick woodcutting +29% (65fc33f), 3-tick fly fishing +29% (02ae918). Keep adding. |
| 30 | 10-23 02:53 | Learn "the game knowledge a pro speedrunner plays with ... the methods and paths" | DONE (first pass) | `research/pro-playbook.md`, `research/quest-xp.md` (bb2f8fb), `research/quest-route.md` (7083d95) |
| 31 | 10-23 04:01 | Claim Haggis, set the password, log out at once, save the login | DONE | bfc9b4e (`scripts/claim-account.ts`, logs out on the first tick); login file exists and is git-ignored, backup exists outside the repo |
| 32 | 10-23 04:21 | "give me the link to the sodding dashboard" | DONE | Link given: `http://localhost:3100` |
| 33 | 10-23 04:29 | "how many actions can you perform in a single tick?" | DONE | Answered: 5 USER_EVENT per tick, 20 CLIENT_EVENT, 2 RESTRICTED (`research/xp-per-tick.md`) |
| 34 | 10-23 03:17 | "did we just get rank 1 theiving? is jackalopeth8 us?" | DONE | Answered: no, jackalopeth8 is not ours |
| 35 | 10-23 02:57 | "say 'yes sir boaby'" | DONE | Said in chat on 2026-10-23 | - |
| 36 | 10-23 04:45 | "keep a list of all the requests i made" | DONE | This file |

## Uncommitted work found during this check

These files hold work for items above and are not in git (2026-10-23 04:49 UTC):

- `packages/dashboard/server.ts`: vault totals, banker name, persisted events, role inference, live-first order (#6, #7, #9, #10)
- `scripts/generated/gecourier.ts`: GE food courier, proven 3/3 in practice (#4)
- `scripts/generated/woodcutting.ts`: woodcutting specialist, proven 3/3 in practice, not launched live (#2)
- `scripts/generated/waterfall.ts`: Waterfall Quest, fails at the giant door (2568,9876) in all 3 runs (#13)
- `scripts/measure/relog-bench.ts`: relog stun-cancel measurement (#15)

## Added 2026-10-23 night (status checked against the repo and live runs)

| # | Request (owner's words, short) | Status | Evidence | Next action |
|---|---|---|---|---|
| 37 | "a banker account that all our accounts trade off to" | DONE | Moneyshot; scripts/banker.ts; 4 thieves gave 86,078 coins (.practice/vault-log.jsonl) | Restart on demand only (resources rule) |
| 38 | "keep track of everything we have" for suppliers and speedrunners | PARTIAL | Dashboard vault panel (14ef247); vault-log.jsonl | Bank contents of each account are only known when it last opened its bank |
| 39 | "a LOT more funny penis joke names" | DONE | 138 names, 19 roles (f9fdfdb); 135 free on the live server | Add to small roles (runite 3, herblore 4, bank 4) |
| 40 | "get the lobster helpers going" | PARTIAL | Bigpackage bought 115 lobsters live (2,209 ticks) | Give to banker failed once (timeout); hand lobsters to a thief run |
| 41 | Dashboard: 3D world default, 2D button, real item icons, all data, dense | PARTIAL | 14ef247, 5032b16 | Owner has not accepted it; 3D scene was black under 100% CPU |
| 42 | rs-world viewer: stop it constantly reloading, optimize it | DONE (not yet seen by owner) | rs-world bcb984b, 5032b16: loads once, follow by postMessage, fps 20, scale 0.75, 1 fps when hidden | Owner to confirm |
| 43 | "check CPU and RAM", "check docker" | DONE | Stray Edge (about 70% CPU) and a stuck python stopped; Docker uses about 890 MB, not used by this project | Owner decides on Docker |
| 44 | "being sloppy and careless about resources is NOT ACCEPTABLE" (standing rule) | RULE | memory feedback-resources.md; shot.ts kills the Edge tree | Shared bot host to cut about 550 MB per bot |
| 45 | Tell agents they are stinky poo poo bums (in-joke) | DONE | Sent to 4 agents | - |
| 46 | "yes sir boaby" | DONE | Said in chat | - |
| 47 | Random events | NEW (found by me) | Woodpecker died to a dryad at WC 49 | Handler being built (agent) |

## My own commitments (things I said I would do), 2026-10-23

Rule: every "I will" in chat gets a row here in the same turn. Close a row only with evidence.

| # | I said I would | Status | Evidence / next step |
|---|---|---|---|
| C1 | Fix the banker payout waste (4 declined trades) | DONE | 6 s serve window, bc8a6c9; not yet re-measured live |
| C2 | Give Bigpackage's 115 lobsters to the banker | DROPPED | Bigpackage holds them; it hands them to the gold farmers directly (C9) |
| C3 | Stop the practice server when the testing helpers finish | OPEN | random-event helper still uses it |
| C4 | Shared bot host: many bots in one process, one path map, measure RAM before and after | OPEN | waits for the random-event helper (both touch packages/core/src/bot.ts) |
| C5 | Fix the black 3D scene in the dashboard | OPEN | dashboard helper, round 2 |
| C6 | Cut the 18 idle ticks after the Musa Point boat landing | REFRAMED | one-off on Moneyshot only; the repeat costs are 8 idle ticks per boat talk and 19-25 tick walk stalls; walking helper on it |
| C7 | Cut the courier's walking (1,948 of 2,209 ticks) | IN PROGRESS | walking helper: stall causes, click-ahead walker, before/after benchmark |
| C8 | Find what killed Woodpecker | OPEN | random-event helper; demo config says events are off (fly.toml:25) |
| C9 | Put the 4 Thieving 99 accounts to work making gold (knights + lobsters) | IN PROGRESS | helper writing and proving scripts/goldfarm.ts |
| C10 | Actions-per-tick monitor | IN PROGRESS | dashboard helper, round 2 (status.ts input counts) |
| C11 | Haggis 24-board schedule | DONE | f691ad0; top 5 experiments routed to the supply-floors and quest helpers |
| C12 | Research index and shared agent brief | DONE | cbbe5ae; tick length settled 931c784 (399.8 ms) |
| C13 | Measure supply-board tick floors (Fletching, Crafting, Herblore, Firemaking, Prayer, Smithing, Magic, Cooking) | IN PROGRESS | helper; output research/supply-floors.md |
| C14 | Live supply cost model: gold needed per board, GE availability | IN PROGRESS | helper; output research/supply-costs.md |
| C15 | Plans for Equipment, Bank, Runite, Quest Points boards | IN PROGRESS | helper; output research/boards-special.md |
| C16 | Feed the gold farmers and enable them in swarm.json | DONE | b93a84e proved 3/3 practice (14.8-15.6 coins/tick); live: 4 thieves fed 28 lobsters each by trade, all farming |
| C17 | Stop the practice server when all practice helpers finish | OPEN | now used by random events, gold farm, walking, supply floors |
| C18 | Gold economy loop: farmers bank coins, courier buys lobsters with them, feeds farmers before food runs out (~4,700 ticks) | OPEN | needs a resupply job; measure live coins per tick first |
| C19 | Haggis login lock: login refused unless 5 gates pass (plan wins with measured inputs and 2% margin, 3 rehearsals, supplies staged, fresh targets, machine clear) | DONE | lock in connectInProcess, scripts/haggis-gate.ts; today NO-GO: 1/24 boards, 76 inputs unmeasured |
| C20 | Answer the special-board walls (Equipment tie at code max, Bank 16.14B, Runite contested by a live miner, QP 145 at 1,022,262) without lowering the goal | OPEN | research/boards-special.md (8a2f1f0); owner decisions E1, B1, R1 listed there |
