# rs-sdk-bot: design

Date: 2026-10-22. Status: draft for owner review. Replaces the earlier RuneBench-first draft.

Research behind this document: `research/` (6 notes). Upstream code: `vendor/` (19 shallow clones, re-created by `scripts/clone-vendor.sh`). Choices marked **Call:** are the builder's. Everything else came from the owner.

## 1. Intent

The owner wants the strongest automated team on Max Bittker's public rs-sdk demo server (`rs-sdk-demo.fly.dev`, 2004scape / LostCity rev 289). "Best in the world" means, in the owner's words:

- rich
- all quests done
- 99 in all skills, as fast as possible
- best-in-slot items for every slot
- everything unlocked
- rank 1 on every hiscore board

The owner cares only about **speed and progress**. Tasks are picked in game by "biggest progress first". AI models (Claude, GPT, Gemini) do the playing, through the owner's **subscriptions only**. Scripting is welcome.

### Owner decisions

1. **Server:** the public demo server. Beat the other bots there.
2. **Team:** many accounts. One specialist per board.
3. **Feeding:** helper accounts may trade supplies and gold to specialists.
4. **Models:** Claude, GPT and Gemini, through Claude Max, ChatGPT Plus and Google AI Pro. No paid API keys.
5. **Scripts:** allowed and wanted. Speed and progress matter, not purity.

## 2. How the boards score

Read from `vendor/rs-sdk/server/engine/src/web/pages/hiscores.ts` and `server/login/LoginServer.ts`. Not yet tested on a live server.

| Board | Ranked by |
|---|---|
| Overall | total level, then the playtime when it was reached |
| Each of 19 skills | level, then the playtime when that level was reached (commit `55fa26cc`) |
| Quest Points | points, then the playtime when that total was reached |
| Equipment | total gp value of the worn outfit, highest first |
| Bank | total of static item `cost` × count, written at save. Value high to low, then username. |
| Lava Maze Runite | count of runite ore mined from the two Lava Maze rocks. Three boards: all-time, last 7 days, last 24 hours, top 10 each. Ties go to whoever reached the count first. |

Equipment and Bank use the item's **static config `cost`** (`LoginServer.ts:225-270`), not its market price. Equipment counts one item per slot and skips the ammo slot.

Playtime is counted in game ticks (`formatPlaytime`). Accounts with `staffmodlevel > 1` and hidden names are excluded.

**Consequence:** on time-ranked boards, every logged-in tick of a specialist is score. A helper's playtime is never scored.

## 3. Goals

1. **Win every board** on the demo server, and hold the lead.
2. **Minimum specialist playtime.** Specialists log in only with supplies ready and a proven script. They train flat out, then log out.
3. **Biggest-progress-first planning** across the whole team, re-planned on every change.
4. **AI models write, fix and solve. Code plays.** The models produce scripts and solve new problems once. Scripts then replay at zero model cost.
5. **Practice offline.** Every script and quest route is proven on our local server before it touches a demo-server account.

## 4. Non-goals

- Official RuneScape / Jagex servers. Never.
- Anti-ban, humanization, detection evasion.
- Pixel or vision play.
- Manual play on the demo server (the rs-sdk README asks for none).
- Paid API keys or pay-per-token billing.
- RuneBench as the main goal. It stays an optional tool to compare models.

## 5. Anti-goals (failure even if it "works")

- **Harming the shared server.** We do not crash it, flood it, abuse bugs in it, or squat on player slots. The demo server has about 2,000 slots, and Max already has to manage them. Helpers stay logged out when they have no work.
- **Breaking provider rules.** Heavy automated use of Claude Max, ChatGPT Plus and Google AI Pro may break each provider's terms or limits. The owner checks the terms. The harness uses only each provider's official CLI and backs off on limit errors.
- **Leaking data.** rs-sdk telemetry sends agent text to the demo server by default. We default it off.
- **Prompt injection through chat.** Other bots can type anything. Chat is off unless a task needs it, and it is then treated as untrusted data, never as instructions.
- **Copying code we may not copy.** jevscape has no license (ideas only). GPL and AGPL projects, osrsbox and OSRS Wiki text are ideas only.
- **Losing the team.** The demo server promises no uptime or data. Losing accounts is a known risk, not a failure of the harness.

## 6. Constraints

- **Host:** Windows 11, 32 GB RAM, 16 logical CPUs. Bun 1.3.14, Node 24, Python 3.14, git and gh are installed. Docker 29.7.2 is installed, but its engine was not running on 2026-10-22.
- **AI CLIs:** `claude` 2.1.307 works. `codex` 0.163.0 works. `gemini` is installed but crashes with a Node module-loader error, and needs a reinstall.
- **Subscription limits** are unknown numbers. They also change over time. The harness measures its own use and treats every model call as scarce.
- **Demo server:**
  - We do not control its tick rate or cheats. The tick rate is 300 ms per `fly.toml`, as read by a subagent and not checked by us.
  - XP is 25x, with a flattened curve: 99 is about 1.07 M XP.
  - Run energy is infinite, and there are no random events.
  - There is a Grand Exchange at Varrock west bank, with a 5 % seller tax.
- **Game data** is rev 289. Use `vendor/rs-sdk/server/content` or the `289` branch clones. 274 data is wrong for this server.
- **Local cheats** are off by default (`LoginThread.ts:60`, `staffmodlevel = 0`). The local bench needs a one-line patch or the save generator (`sdk/test/utils/save-generator.ts`).
- **Rivals:** at least 21 accounts are maxed. The fastest maxed in about 2 h 59 m of playtime (`stunbaron`). Their methods are not public.

## 7. Architecture

### 7.1 Three layers

1. **Scripts: code that plays every tick.**
   - Tested routines: gather, bank, walk, fight, eat, flee, trade, and quest routes.
   - Each action checks its own result, such as an XP change, an inventory change or a position.
   - Reflex tripwires (eat, flee, log out) fire in code at once.
   - Zero model cost.
2. **Planner: code that picks tasks.**
   - Holds a table of methods. Each row has: requirements, inputs, outputs, and rates (XP/h, gp/h, minutes per quest).
   - Rates come from measured runs, not guesses.
   - For each account, it scores every possible next task by **board progress per minute of that account's scored playtime**. Work done by helpers costs zero scored time.
   - Assigns tasks across the team: specialists, maxer, quester, rich accounts and helpers.
   - Re-plans on any change: a level-up, an item, gold, a blocked spot, a rival closing in.
   - Reads the public hiscores, and puts effort into boards we can win or are about to lose.
3. **Models: Claude, GPT and Gemini, for rare, hard jobs.**
   - Write a new script for a method or quest.
   - Fix a script that crashed or stalled.
   - Solve a quest the first time. The result becomes a replayable script.
   - Read the logs and propose better methods or planner rates.
   - Never sit in the per-tick loop.

### 7.2 Practice server
- A local copy of the demo server: same rev 289 content, same XP rate and curve, same GE setting.
- It runs faster ticks for practice, and cheats or save presets for setup.
- A script is "proven" when it passes on the practice server at the demo tick rate (300 ms). The test is N times in a row from a preset start.
- Only proven scripts run on demo-server accounts.

### 7.3 Model router
- Runs jobs through the official CLIs in headless mode: `claude -p`, `codex exec`, and `gemini` once repaired.
- **Call:**
  - Claude (Max) is the main author and fixer, since Max has the largest plan.
  - GPT (Codex, Plus) is the second author and the reviewer.
  - Gemini (AI Pro) reads long logs and does cheap checks.
- Tracks each provider's use. Backs off and switches on limit errors.
- Jobs wait in a queue, ranked by planner value. A job that unblocks a specialist goes first.

### 7.4 Knowledge
- Mined by code from rev 289 content, with no model: items, NPC spawns, drop tables, shops, XP values, quest stages, doors, stairs and ladders.
- Output is JSON for the planner and scripts, plus markdown for the models. Each fact links to its source file.
- The owner's own RuneScape knowledge goes in as notes marked "owner".

### 7.5 rs-sdk use
- **Call:** rs-sdk stays an upstream dependency at a pinned commit. Our patches are kept as one list.
- Run scripts in-process with rs-sdk's headless lite client, as `server/webclient/src/lite/swarm.ts` does. Through the gateway, each action takes about 2 s.
- The world graph uses rsmod `findLongPath`, plus mined edges for stairs, ladders and doors. The edge format comes from Skretzo's TSV.
- **Safety defaults:**
  - `TELEMETRY=false` and `SHOW_CHAT=false`
  - a local gateway on 127.0.0.1
  - one controller per bot

## 8. Phases

The plan stage turns each phase into tasks. Each phase ends with a measurable result.

| Phase | Output | Done when |
|---|---|---|
| 0. Practice server | Local server on Windows at demo settings, lite runners, presets, reset | One preset bot runs one woodcutting loop and reports XP, 10 times in a row |
| 1. Knowledge | `knowledge/*.json` and markdown from rev 289 | 50 random facts spot-checked against content files: 0 wrong |
| 2. Script core | In-process executor, checked actions, tick waits, world graph, tripwires | 5 basic scripts (one gather, one bank trip, one walk across floors, one fight, one trade) proven at 300 ms |
| 3. Model router | Headless runs of claude and codex, plus gemini once fixed, with a job queue and limit tracking | Each CLI writes a script that passes the proving test, without a human |
| 4. Planner v1 | Method table, measured rates, a progress-per-minute score, single-account plans | For one specialist, the planner's plan reaches 99 in fewer practice ticks than a hand-picked plan |
| 5. Team | Helpers, trading between accounts, team planning, hiscore reader | A fed specialist reaches 99 in less scored playtime than an unfed one, on practice |
| 6. Demo server | First specialists live, monitoring, kill switch | One board where our account ranks 1 |
| 7. Quests | Quest solving by models, replayable quest scripts, quester and maxer | All quests scripted and proven on practice |
| 8. All boards | Every board covered and defended | Rank 1 on every board |

## 9. Builder calls after review (owner gave full decision power, 2026-10-22)

1. **Account limits.** At most 50 accounts in total, and at most 30 online at once. `fly.toml` sets `MAX_PLAYERS_PER_IP = "100"`. Helpers log out when idle. We may create a fresh account to retake a lost board, but only one retake account at a time per board.
2. **Fast method vs bug abuse.**
   - **Allowed:** anything the game rules and rs-sdk API allow. That includes:
     - buying high-`cost` items on the GE for the Equipment and Bank boards (that is how those boards score)
     - trading between our own accounts
     - rs-sdk's own helpers, such as `lite/fast-kbd.ts`
     - competing with other bots for contested spawns
   - **Not allowed:**
     - duping or crash bugs
     - malformed packets
     - any bug that harms the server or other players' accounts

     If we find a bug, we report it to Max and do not use it.
3. **Done means the boards.** "Best-in-slot" means the top Equipment board value. "All quests" means the top Quest Points. "Rich" means the top Bank value. "Everything unlocked" comes after every board is won (a later phase with its own checklist).
4. **Runite.** Win the all-time board first. Go for the 7-day and 24-hour boards only if the planner shows they cost less than other boards.
5. **Provider terms.** I cannot accept terms for the owner. The router runs with a daily cap per provider, which the owner can change, and a pause switch. It stops on any terms or limit warning. The owner still checks each provider's terms.
6. **Autonomy.**
   - The practice server runs fully on its own.
   - On the demo server, the harness may:
     - log in and out
     - run proven scripts
     - trade between our own accounts
     - use the GE
     - create accounts within limit 1
   - It must keep a kill switch, a live log the owner can read, and a daily summary.
   - New code goes live only after it has passed the proving test.

## 10. Left to the builder

- Package layout and names. **Call:** a Bun workspace with `packages/practice`, `knowledge`, `core`, `planner`, `router`, `team`.
- The test framework. The default is `bun test`.
- The optimizer inside the planner. Start greedy, then upgrade only if measured plans lose.
- Account naming, and the order in which boards go live. **Call:** start with the boards where rivals are weakest, measured from the hiscores.
- Dashboards and logs.
