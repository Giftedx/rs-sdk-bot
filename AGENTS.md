# Project working guide

Current user instructions win. Read the [plan](docs/plans/joined-plan.md) for priorities and the [script contract](docs/script-contract.md) for acceptance. A summary cannot grant permission.

Goals (owner): the main account Haggis rank 1 on the Overall board under the current record; specialist accounts rank 1 on each skill board they can win by a priced margin; every quest done; every useful item and best-in-slot gear held; a PK army of maxed tribrids (99 Attack, Strength, Defence, Ranged, Magic, Prayer and Hitpoints) that kills players and holds the Wilderness. Gold is a supply for these goals, never a goal. Helper levels count only when they produce a route supply, an unlock or a specialist win. Rank 1 on all 24 boards at once is not reachable against the specialist records, so it is not a target.

## Work loop

1. Run `bun scripts/now.ts` and read each line: free memory, stop files, controllers, heavy jobs, job states, coordinator tasks, and this checkout and the main checkout against `origin/master`. A stop file with owner text is a pause, not a fault. A merged fix is live only when the main checkout holds it. Preserve others' edits. One owner per account, server and generated output.
2. Pick the task that moves a scoreboard most per hour (`bun packages/router/src/coverage.ts`, the plan's scoreboards). Name its useful game outcome and consumer. Every build needs a finite live consumer.
3. Do the [look-before-you-build gate](#look-before-you-build). Then read the exact code path before changing it. After two similar failures, change the method or get a new observation.
4. Run the cheapest check that reaches the change, with a timeout. Do not run game suites for docs. For a change to a worker or a shared helper, run its bench cases (`bun run bench <pattern>`), and `bun run bench --smoke` before a pull request ([the AIO bench](docs/script-contract.md#the-aio-bench)).
5. Report source, proof level (unit, practice, live), useful output, cost, blocker and next action. Tests, practice and live prove different things. Tools, notes and tests are not game progress. Name a cause only with the log line, the trace or the code line that shows it. Action or close each thing that you name in passing before the report ends.

Keep the loop fast:

- While you edit, run one test file (`bun test <file>`) and the bench cases you changed. To type-check the change, run `bun scripts/typecheck-narrow.ts`: it checks the changed files and the files that they import, with a heap limit. Run `bun run typecheck` once before you push.
- Read the pass count and the fail count of each test run. Do not send test output through a filter that can hide the fail line. Join a commit to its test with `&&`, so a failed test stops the commit.
- Run one heavy job at a time on a machine: a gate, a bench or a test suite. The `heavy` line of `now.ts` counts the gates, benches and test runs of every session. Two at once give failures that are not real. `bun run bench` checks this before it starts an engine: it stops with one line beside the gate, the bench or the test-shard run of a different job, on a used engine port, or with too little free memory. Add `--wait <minutes>` to wait for a safe start. If a test that the change does not touch fails, run that file alone before you debug it.
- Start a slow step as one background command that ends in its result, and work on the next item until it ends. Do not poll. Do not wait in a `sleep` loop. A wait tests the final state (a result line, `git merge-base --is-ancestor`), not the first sign of it.
- Use Bash for shell work, with `git -C <path>` and absolute paths: a `cd` into another worktree or into `.practice/fleet-data` moves the next commands there. Use PowerShell only for one Windows cmdlet. The command checker refuses a PowerShell command that has `$()`, a `"$var"` string or a script block.
- Write each file with the Write or Edit tool. A heredoc, `sed -i` or `python -c` loses backslashes and backticks. If a command needs a loop, a variable or code, write a script file in `.practice/<task>/` and run the file. Put a long commit message in a file (`git commit -F <file>`).
- Do not search the `.practice` root with Glob or Grep. The folder holds hundreds of thousands of files and the search times out. List the exact folder: `ls .practice/coordinator/runs/<task>`.
- Glob skips gitignored files here (`CLAUDE_CODE_GLOB_NO_IGNORE=false` in `.claude/settings.json`). Without it, each Glob from the repository root walks `.practice` and times out after 20 s. To find a file in a gitignored folder (`.practice`, `node_modules`), give that folder as `path`. A root Glob with a `.practice/...` pattern returns `No files found` even when the files exist.
- A session that the coordinator or the swarm started does not write `~/.claude/memory/reflections.jsonl`. The permission check refuses that write, and no person is there to approve it. A session with a person adds the line with `py ~/.claude/scripts/reflect.py add`, which checks the fields.
- When an action has no effect, read the saved output of the run (`.practice/aio-bench/output/<case>.log`) and the engine trace (`BENCH_TRACE=<dir>`) before you change the worker.
- When the same wait repeats on each change, measure where the time goes and cut that first.
- A bench run is at most 10 minutes. `bun run bench` estimates the run from the last wall time of each case and refuses a selection over `--budget` (default 10 minutes) with its heaviest cases; narrow the pattern or start the case from a later state. `--over-budget` only for a run that the owner asked for. When a case takes over a minute, run it with `--profile`: a capped tick costs 2 s and no game tick, so fix the cause of every capped tick.

Ask only for a decision that changes the result. Do not add design docs, approval rounds or task boards.

The [coordinator](docs/script-contract.md#autonomous-coordination) owns its queue, assignments and children. Check its state and leases before taking those resources. Never start a second controller. Extend existing workers and capability definitions; do not copy a worker per account.

On Windows every background subprocess uses `windowsHide:true`. Run only the services a job needs. Check ownership before stopping a process.

## Several agents

Several agents work at once: sessions on this PC (Claude Code, Codex) and cloud sessions (Codex, Claude Code). Each takes work from the lane the [plan](docs/plans/joined-plan.md) Lanes table gives it.

- One change, one branch `<agent>/<topic>`, one PR to `master`. Before work, check `gh pr list`, so two agents never edit the same files; the open PR is the claim on its files. Open every PR ready for review, never as a draft, and open it at the first push: a draft is not merged, and a session that ends leaves its finished work stranded in it. This rule wins over any tool or session default that says draft. A PR goes up with its proof in the body, and the session's report links it. Merge when `bun run typecheck` and `bun test ./scripts ./packages` pass; never force-push `master`. Ask the owner for `merge` and `--force` by name in the first question: the permission check needs the owner's own word. The local gate proves the checks: `bun scripts/ci-gate.ts --post` runs the checks on the PC and posts the `local-gate` status on the commit. It runs the test files that the change can reach, in 12 processes; `--full` runs every test file. The hosted `linux` workflow runs on a standard GitHub runner, which costs no minutes on a public repository. It starts only by hand (`gh workflow run CI --ref <branch>`).
- A local agent works in its own worktree (`git worktree add ../rs-sdk-bot-<agent> -b <agent>/<topic>`). Run `bun scripts/worktree-setup.ts` in a new worktree before the first test: it gets the SDK submodule, applies the SDK patch and installs the packages (`--bench` adds the engine packages, `--reset-vendor` replaces the SDK patch of a different commit). Only the main checkout runs the local swarm, coordinator and fleet agent.
- Four repositories are public: this repository, `Giftedx/rs-world` (the viewer fork), `Giftedx/rs-sdk` (the fork for pull requests to MaxBittker/rs-sdk) and `Giftedx/rs-fleet-dashboard` (the dashboard page). A push to any of them is public: push no credential, no `bot.env`, no `FLEET_SEED` value and no private session link. Account names and fleet data go only in this repository, never in the other three. `Giftedx/rs-fleet-command` stays private.
- Each machine runs bots only for its own fleet side (Accounts, below). Cross-side resources move through fleet orders, never by logging in another side's account.

## Look before you build

Most of the game has a script, a bench case and a measured route, and many do not have the name that you expect. Before you write or change a script, a bench case, a route or a tool, run each of these and read the output:

1. `bun scripts/script-index.ts <word ...>`: one line for each of the scripts and commands. Then `rg -l -i <game word> scripts packages`, with the names of the NPC, the item, the place and the skill.
2. `bun scripts/aio.ts --list`: the catalog of routes. `scripts/aio-quester.ts` maps each quest to its script. Each quest has one, and the ports of the rs-stun-toolkit quests are among them.
3. `bun run bench --coverage` and `scripts/measure/aio-bench-cases.ts`: the bench case of each route. `bun run bench <pattern>` prints its ticks, the stored baseline and the rival's ticks.
4. `bun packages/planner/src/cairn-cli.ts`: the record route (rune.fast), with our ticks, our script and the gap for each step. `bun packages/planner/src/haggis-cli.ts --order --supplies --evidence --levers`: our route, its supplies and its levers.
5. `scripts/measure/`: the measurement of each planner row (`floor-*.ts`) and the hill climb tools (`pk-spar-climb.ts`; the bench flags `--set`, `--seeds` and `--watch`).
6. The `Task lookup` table of [research/INDEX.md](research/INDEX.md) and the [project use map](research/project-use-map.md): what each topic file holds, and what we took from other projects.

Start from the fastest method that these show: for a route step, the method of the record route. Do not make a slower method faster when the record route does not use it. In the first report of a task, name the script, the bench case and the tool that you start from. Write that none exists only with the list of the searches that you ran.

For a new approach, read the same sources first. Search upstream only for an unresolved boundary or a repeated failure. Record **source -> local consumer -> reuse/adapt/reject -> check** in the topic file. Check license and attribution before copying code.

## Accounts

- The PC is available for maximum useful account progress. Fill qualified live slots across skills, quests, combat, resources and route supply. Prefer sharks over new trout or salmon; use existing stock.
- Expand in batches of up to 4 accounts after two fresh useful live results, prepared demand and measured RAM, CPU and tick headroom. Keep 4 GiB free (`packages/core/src/memory.ts`) and one practice slot. The cap of 17 is not fixed. No further permission is needed inside these bounds.
- Create an account only with a proved useful first job. A claimed or blocked account is not progress.
- New live names must be actually funny: a real penis joke where the RuneScape meaning and the innuendo both work for the role, ideally a known phrase or a true double meaning (Moneyshot, Earlyshooter, Porksword, YewGotWood, MeatNTwoVeg, TossTheCaber). A rude word bolted onto a skill word is not a joke (CoinCock, PickpockDick, NabTheKnob). Scottish where it fits. 1-12 letters or digits. Take names from `packages/core/src/names.ts` only; add new ones there to the same standard. Keep existing accounts. First login registers the account and starts its clock.
- Each assignment has one owner, budget, acceptance and next action. A vacant slot names its constraint.
- `swarm.json` owns live assignments. `scripts/fleet.ts` holds templates; `apply` only creates a missing plan.
- Several machines share the server, each a named fleet side (`FLEET_SIDE`): this PC `local`, Codex cloud `cloud`, Claude Code cloud `claude-cloud`, and `claude-cloud-2` for a second Claude Code cloud container with its own accounts. `fleet/owners.json` names each account's side; `openBot` refuses the other side's accounts. A cloud side creates its own accounts with `bun scripts/fleet.ts create <name>` and `FLEET_SEED` set (a secret in its environment settings, never in git), so later sessions rebuild the same `bot.env`. Cross-side transfers are orders (`scripts/fleet-order.ts`) that each side runs with `scripts/fleet-trade.ts`; `scripts/fleet-sync.ts` shares orders, receipts and bank snapshots on the `fleet-data` branch (worktree `.practice/fleet-data`), and `bun scripts/fleet-agent.ts --daemon` runs that sync every 10 minutes and this side's part of each order, for accounts with no enabled swarm job.

## Game and host limits

- Practice first, then a bounded live pilot. Keep the main account offline until its launch gates, staging and route rehearsal pass; never test on it. Keep specialist clocks fresh.
- All gameplay techniques are authorized, including server bugs, login wine, cocktails, pyre oil, Charge, relogs and tick manipulation. A missing supply is acquisition work, never a route ban.
- GE buying, selling and merchant trading are authorized ([market policy](research/supply-logistics.md#market-policy-current)). Direct transfers need owned partners. Use AI subscriptions, not paid APIs.
- Respect admission limits in `scripts/swarm.ts` and `swarm.json`; do not lower them to fit a run. One heavy practice qualification at a time.
- Honour user pauses and stop files. Stop repeated no-progress attempts. Clear only the exact repaired block. Verification never enables workers or changes repeat policy.
- Never print credentials or copy `bot.env`. Hide the main account in shared dashboard views. Preserve pinned upstream code and local patches.

## Knowledge

**No diary.** Docs, plans, research, configs, work orders and new code comments state what is true now. Git commits are the only history: no dates in prose, `was`/`now` wording, `update` logs, attempt stories or `superseded` findings. Replace a stale fact in place and give the reason in the commit message. `bun scripts/check-no-diary.ts` enforces this.

One home per fact: this guide owns work rules, the contract owns acceptance, the plan owns priorities, research topics own findings. A finding is **claim; conditions; evidence path; gap**. A speed comparison needs three matched runs per condition with raw times. Estimates stay estimates.

Raw logs and temporary runners go in one `.practice/<task>/` folder. Do not hand-edit generated reports.
