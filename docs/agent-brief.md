# Shared agent brief

Every subagent in this repo follows these rules. A task brief adds the task, the file ownership and the live
permission. Where the task brief and this file disagree, the task brief wins only for ownership and live access.

<context>
- Repo: `F:\dev-on-f\osrs-rs-research\rs-sdk-bot`. Bots play the rs-sdk demo server (rs-sdk-demo.fly.dev,
  LostCity rev 289, members, 25x XP, 400 ms live tick).
- Main goal: the owner's account Haggis holds rank 1 on all 24 hiscore boards at the same time, from one run.
  Helper accounts supply everything. Every task feeds this goal.
- Boards rank by the account's playtime (logged-in ticks) when it reached the level. One account has one clock.
- The knowledge base is `research/`. Start at `research/INDEX.md`. It lists every file, its evidence level,
  the open contradictions, and the facts every agent must know.
- Owner requests and standing rules: `research/owner-requests.md`.
- This machine runs Windows. Use the shell tool the session gives you.
</context>

<rules>
1. Read `research/INDEX.md` before you start. Read the files it names for your boards. Do not repeat research
   that a file already holds; extend it.
2. Never connect to the live server unless your task brief says so in words. `DEMO_OK=1` is the live switch
   (`packages/core/src/bot.ts:22-26`). Without that permission, never set it.
3. Never print, log, copy or commit a `PASSWORD=` line or any `bot.env` content. Never use the account Haggis
   for a test.
4. Stay inside your task. Do not start bots, servers or long jobs that your task brief does not ask for.
5. Use rev 289 content (`vendor/rs-sdk/server/content`). `vendor/lostcity-*` is rev 274 and is wrong for this
   server.
6. Verify a file, symbol, flag or path in this session before you cite it or open it. If you cannot verify it,
   say "not verified".
7. Use scoped searches (a path or a glob) and reads with an offset and a limit. Files in `research/` can be long.
8. Finish every item in your task. If you must stop, name each item that remains and the reason.
</rules>

<ownership>
- Your task brief lists the files you own. You may edit or create only those files.
- Every other file is read-only for you, including files that other agents have changed and not committed.
  Do not revert, format or stage them.
- If a fix needs a file you do not own, do not edit it. Put the file, the line and the change in your report.
- Results go into `research/<topic>.md` and one row in `research/INDEX.md` (file, what it establishes, evidence
  level, date, what is open, boards). If your result disagrees with another file, add a row to the
  Contradictions section with file:line on both sides and what would settle it. These two edits are allowed
  when your task brief gives you `research/INDEX.md`; if it does not, put the row in your report.
- Commits touch only owned files. Stage files by name (`git add <file>`), never `git add -A` or `git add .`.
  Commit messages are normal, one concern per commit. No agent trailers.
- Commit only when your task brief asks for a commit. Never push, rebase, amend or reset.
</ownership>

<evidence>
- State the evidence level of every claim. Levels, strongest first: MEASURED live, MEASURED practice,
  CODE-READ, WEB, ESTIMATE.
- Never inflate a level. A code read is not a measurement. A practice run is not a live run. A preset run is
  not a fresh-account run. A unit test is not a game run. "Tests pass" is not "it works".
- A rate needs at least 3 runs. Give each run's number, not only the mean.
- Compare times in ticks. The live tick (400 ms) and the practice tick (150 ms) differ.
- Quote the real output line (for example `RESULT ...` or `LEDGER ...`) for every number you report.
- Before you write "done", "fixed" or "works", run the check and quote its output.
</evidence>

<resources>
- Measure free RAM before you add load. One bot process costs about 460-550 MB.
- At most 2 practice bots at the same time, unless your task brief gives a different number.
- One screenshot at a time, with `bun scripts/shot.ts <url> <out.png>`. After each shot, confirm that 0
  `msedge.exe` processes with a `shot-` profile remain. If any remain, stop them.
- Stop every process you start before you report: bots, servers, browsers, watchers. Report what you stopped.
- Do not stop processes that you did not start. Name them in your report instead.
- Put temporary files in the session scratchpad, not in the repo.
- Before EVERY practice bot launch, read .practice/monitor.json (written by scripts/monitor.ts every 30 s). If practiceBots >= 6 or freeGB < 5, wait 30 s and check again. Run at most ONE practice bot at a time per agent. (2026-10-23: 12 practice bots at once left 3.8 GB free and blocked live jobs.)
- Never call a script "proved" for a path the proof did not run. Name the paths the proof exercised (e.g. "resume to Fishing 40, trips=0, events=0").
</resources>

<reporting>
Your final report has these parts, in this order:

1. **Changed**: each file you changed or created, with one line on what changed.
2. **Evidence**: the output that proves each result, quoted, with its evidence level.
3. **Failed or open**: what did not work, what you did not do, and why. Name each remaining item.
4. **Contradictions**: any claim you found that disagrees with another file, with file:line on both sides.
5. **Processes**: what you started and stopped; anything still running.
6. **Commit**: the commit hash, or "no commit" and the reason.

Keep the report short. Facts, not a summary of the diff.
</reporting>
