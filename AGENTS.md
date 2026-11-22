# Project working guide

Current user instructions win. Read [GLOSSARY.md](GLOSSARY.md) for domain terms, the [plan](docs/plans/joined-plan.md) for priorities and the [script contract](docs/script-contract.md) for acceptance. Carry forward explicit authorization. Verify current state before acting.

Goals (owner, detailed in [the plan](docs/plans/joined-plan.md)): Haggis rank 1 Overall under the record; specialist rank 1 on each winnable skill board by a priced margin (not all 24 at once); every quest; useful items and best-in-slot gear; a maxed-tribrid PK army holding the Wilderness. Gold and helper levels count only when they supply a route, unlock, kit, or specialist win.

## Complete authorized work

A request to fix or implement a change includes the routine steps needed to deliver it. Inspect, edit, check, commit, push, open a ready PR, merge and deploy within that scope. Continue without repeated approval when the applicable checks pass. Do not stop at an open PR when the live system needs the fix.

Owner pauses, account leases, resource limits and launch gates still apply. Never force-push `master`, discard another agent's work, expose secrets or waive a failed check. Ask only for missing authority or a choice that changes the result. When a check rejects valid work, find the cause and repair it with evidence. Do not bypass it.

A failure starts repair work within the authorized scope. The responsible agent reads the raw result and traces the first failed step. Reproduce the cause with the cheapest focused check. Prove gameplay repairs on practice before a finite live retry through the owning controller. If the target is complete or the method cannot serve it, plan the next useful consumer. Continue independent goal work while the repair runs.

## Work loop

1. Run `bun tools/now.ts` and read each line: free memory, stop files, controllers, heavy jobs, job states, coordinator tasks, and this checkout and the main checkout against `origin/master`. A stop file with owner text is a pause, not a fault. A merged fix is live only when the main checkout holds it. Preserve others' edits. One owner per account, server and generated output.
2. Pick the task that moves a scoreboard most per hour (`bun packages/router/src/coverage.ts`, the plan's scoreboards). Name its useful game outcome and consumer. Every build needs a finite live consumer.
3. Do the [look-before-you-build gate](#look-before-you-build). Then read the exact code path before changing it. After two similar failures, change the method or get a new observation.
4. Run the cheapest check that reaches the change, keeping local verification strictly under 3 minutes (`bun test <changed-files>`, `bun tools/typecheck-narrow.ts`, `bun tools/check-no-diary.ts --list`). Do not run game suites for docs. Run ALL full CI suites (`gh workflow run CI --ref <branch>`) and ALL bench verifications (`gh workflow run CI --ref <branch> -f bench_pattern="..."` or `bun tools/hosted-bench.ts`) on GitHub Actions free standard runners ([the AIO bench](docs/script-contract.md#the-aio-bench)).
5. Report source, proof level (unit, practice, live), useful output, cost, blocker and next action. Tests, practice and live prove different things. Tools, notes and tests are not game progress. Name a cause only with the log line, the trace or the code line that shows it. Fix task blockers within scope. Report unrelated findings without taking work from another owner.

Keep the loop fast:

- Local checks are strictly limited to super-light `< 3 min` checks: `bun test <changed-files>`, `bun tools/typecheck-narrow.ts`, and `bun tools/check-no-diary.ts --list`. Do NOT run `bun tools/ci-gate.ts --full`, multi-minute test shards, full `bun run typecheck`, or local `bun run bench`; run full CI and all bench suites on GitHub Actions free standard runners. Document-only changes need document checks only.
- Read the pass and fail counts of every test run without filtering out fail lines. Join a commit to its test with `&&` so a failed test stops the commit.
- Run at most one lightweight local check at a time (`now.ts` `heavy` line). Run an unrelated failing test file alone before debugging it.
- Start a slow hosted step once (`gh workflow run CI --ref <branch>`) and work on another item until it finishes. Collect results with bounded harness waits; never use repeated starts or a `sleep` loop.
- Use the shell the session exposes: when Bash is available, prefer Bash with `git -C <path>` and absolute paths (`/mnt/c`, `/mnt/f` in WSL) and use PowerShell only for Windows cmdlets; in `pwsh`-only harnesses (such as Antigravity on Windows), run Windows `git` and `bun` natively with Windows paths.
- Edit files with the session's file-editing tools rather than shell text munging. Put scripted loops or long commit messages (`git commit -F <file>`) in `.practice/<task>/`.
- Never search `.practice` from its root (it holds hundreds of thousands of files); list or search an exact subfolder such as `.practice/coordinator/runs/<task>`. Pass `--hidden` or `--no-ignore` to `rg` only on a named subfolder.
- Do not make reflection or memory writes a completion gate; write memory only when the owner asks.
- When a hosted bench action has no effect, read `.practice/sim/aio-bench/output/<case>.log` and `BENCH_TRACE=<dir>` before changing the worker. When a wait repeats across edits, measure and cut the wait first.
- Practice and bench rules (hosted execution via `gh workflow run CI --ref <branch> -f bench_pattern="..."` or `bun tools/hosted-bench.ts` on GitHub Actions free standard runners, 10-minute `--budget`, `--seeds` parallelism, `--profile` on >1-minute runs to eliminate 2 s capped ticks, lockstep/fine-timer/no-gateway defaults) live in [the AIO bench](docs/script-contract.md#the-aio-bench).

Ask only for a decision that changes the result. Do not add design docs, approval rounds or task boards.

The [coordinator](docs/script-contract.md#autonomous-coordination) owns its queue, assignments and children. Check its state and leases before taking those resources. Never start a second controller. Extend existing workers and capability definitions; do not copy a worker per account.

On Windows every background subprocess uses `windowsHide:true`. Run only the services a job needs. Check ownership before stopping a process.

## Several agents

Several agents work at once: local sessions on this PC (Claude Code, Codex, Antigravity) and cloud sessions (Codex, Claude Code). Each takes work from its lane in [the plan](docs/plans/joined-plan.md) (or coordinates via `gh pr list` and `bun tools/now.ts` when unassigned).

- One change, one branch `<agent>/<topic>`, one PR to `master`. Check `gh pr list` for file ownership before editing. Open a ready PR at the first push with proof in its body; never leave finished work in draft.
- Merge authorized changes once applicable GitHub Actions checks pass: code needs full `gh workflow run CI --ref <branch>` (`linux`, `windows`, and `route-key-parity`); docs need document checks (`bun tools/check-no-diary.ts --list`). Do not ask for repeated approval on routine merges or deployments.
- After merge, run `bun packages/fleet/src/live-update.ts` in the main checkout while preserving local edits and honoring holds. Verify main holds the merged files and affected controllers reload and produce the intended behavior; a merged PR alone is not live proof.
- GitHub-Actions-first CI: local checks cover fast unit and syntax verification under 3 minutes (`bun test <changed-files>`, `bun tools/typecheck-narrow.ts`, `bun tools/check-no-diary.ts --list`). Trigger full CI (`gh workflow run CI --ref <branch>`) and all bench verifications (`gh workflow run CI --ref <branch> -f bench_pattern="..."` or `bun tools/hosted-bench.ts`) on GitHub Actions free standard runners.
- For clean-runner practice proofs (`-f native_practice=true` or `-f native_quest=false`) and hosted multi-seed benches (`gh workflow run CI --ref <branch> -f bench_pattern="..."` or `bun tools/hosted-bench.ts`), follow [the AIO bench](docs/script-contract.md#the-aio-bench). Check saved source hashes; practice proofs still require separate live admission and useful-output checks.
- Work locally in an isolated worktree (`git worktree add ../rs-sdk-bot-<agent> -b <agent>/<topic>`) and run `bun tools/worktree-setup.ts` before the first test (`--bench` for engine packages, `--reset-vendor` across SDK commits). Only the main checkout runs the local swarm, coordinator and fleet agent.
- Four repos are public: this repository, `Giftedx/rs-world`, `Giftedx/rs-sdk` and `Giftedx/rs-fleet-dashboard`. Never push credentials, `bot.env`, `FLEET_SEED`, `FLEET_VAULT_KEY`, private session links, or (outside this repo) account names and fleet data. The sealed vault on `fleet-data` (`fleet/vault/`, AES-256-GCM via `packages/core/src/fleet-vault.ts`) is the sole exception. `Giftedx/rs-fleet-command` stays private.
- Each machine runs bots only for its own fleet side (Accounts, below). Cross-side resources move through fleet orders, never by logging in another side's account.

## Look before you build

Most of the game has a script, a bench case and a measured route. Before changing a script, bench case, route or tool, check the sources below and reuse unchanged task results (document-only changes skip gameplay checks):

1. `bun tools/script-index.ts <word ...>` and `rg -l -i <game word> scripts packages` for NPC, item, place and skill names.
2. `bun scripts/aio.ts --list` and `scripts/aio-quester.ts` for routes and quest mappings (including rs-stun-toolkit ports).
3. `bun run bench --coverage`, `scripts/measure/aio-bench-cases.ts` and `bun run bench <pattern>` for bench cases, baselines and rival ticks.
4. `bun packages/planner/src/cairn-cli.ts` (`rune.fast` comparison) and `bun packages/planner/src/haggis-cli.ts --order --supplies --evidence --levers`.
5. `tools/measure/` (`floor-*.ts` row measurements) and `scripts/measure/` (`pk-spar-climb.ts` hill-climb tools).
6. The `Task lookup` table of [research/INDEX.md](research/INDEX.md) and the [project use map](research/project-use-map.md).
7. `bun tools/gear.ts find|show|best|compare|kit` (`knowledge/gear.json` from `bun packages/knowledge/src/build.ts`): read the full output before claiming any wearable item or best-in-slot piece does not exist.

Start from the fastest method shown (the record route's method for route steps) rather than optimizing slower paths. State your starting script, bench case and tool in the first report, or list every search run if none exists. Search upstream only for an unresolved boundary or repeated failure, and record **source -> local consumer -> reuse/adapt/reject -> check** in the topic file after verifying license and attribution.

## Accounts

- Fill qualified live slots on the PC across skills, quests, combat, resources and route supply. Prefer existing shark stock over new trout or salmon.
- Expand in batches of up to 4 accounts after two fresh useful live results, prepared demand and measured RAM, CPU and tick headroom. Keep 4 GiB free (`packages/core/src/memory.ts`) and one practice slot; the cap of 17 is not fixed.
- Create an account only with a proved useful first job; a claimed or blocked account is not progress. First login registers the account and starts its clock.
- When creating a new live account, pick or add a name following the 1-12 character naming standard and examples at the top of `packages/core/src/names.ts`. Keep existing accounts.
- Every assignment names one owner, budget, acceptance and next action; a vacant slot names its constraint. `swarm.json` owns live assignments (`scripts/fleet.ts` holds templates; `apply` only creates a missing plan).
- Each named fleet side (`FLEET_SIDE`: `local`, `cloud`, `claude-cloud`, `claude-cloud-2`) owns its accounts in `fleet/owners.json`; `openBot` refuses other sides, and main and specialist accounts never move (`packages/core/src/fleet-assign.ts`, `scripts/fleet-sync.ts`). Cross-side transfers use fleet orders (`scripts/fleet-order.ts`, `scripts/fleet-trade.ts`, `scripts/fleet-agent.ts --daemon`). See [README.md](README.md#one-account-pool-across-sides) for vault (`FLEET_VAULT_KEY`), adoption, `FLEET_SEED`, cloud-side launch/bootstrap (`scripts/cloud-side.ts`, `scripts/cloud-launch.ts`), SDK-reset recovery, and `fleet-data` sync procedures.

## Game and host limits

- Practice first, then a bounded live pilot. Keep the main account offline until its launch gates, staging and route rehearsal pass; never test on it. Keep specialist clocks fresh.
- All gameplay techniques are authorized, including server bugs, login wine, cocktails, pyre oil, Charge, relogs and tick manipulation. A missing supply is acquisition work, never a route ban.
- GE buying, selling and merchant trading are authorized ([market policy](research/supply-logistics.md#market-policy-current)). Direct transfers need owned partners. Use AI subscriptions, not paid APIs.
- Respect admission limits in `scripts/swarm.ts` and `swarm.json`; do not lower them to fit a run. One heavy practice qualification at a time.
- Honour explicit user pauses and stop files. An authorized resume applies only to its stated scope. Diagnose failure ends through the repair work above. Clear only the exact repaired block through the supported controller path. Stop repeated no-progress attempts. Verification alone never enables workers or changes repeat policy.
- Never print credentials or copy `bot.env`. Hide the main account in shared dashboard views. Preserve pinned upstream code and local patches.

## Knowledge

**No diary.** Docs, plans, research, configs, work orders and new code comments state what is true now. Git commits are the only history: no dates in prose, `was`/`now` wording, `update` logs, attempt stories or `superseded` findings. Replace a stale fact in place and give the reason in the commit message. `bun tools/check-no-diary.ts` enforces this.

One home per fact: this guide owns work rules, the contract owns acceptance, the plan owns priorities, research topics own findings. A finding is **claim; conditions; evidence path; gap**. A speed comparison needs three matched runs per condition with raw times. Estimates stay estimates.

Raw logs and temporary runners go in one `.practice/<task>/` folder. Do not hand-edit generated reports.
