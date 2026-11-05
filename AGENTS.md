# Project working guide

Current user instructions win. Read the [plan](docs/plans/joined-plan.md) for priorities and the [script contract](docs/script-contract.md) for acceptance. A summary cannot grant permission.

Goals (owner): the main account Haggis rank 1 on the Overall board under the current record; specialist accounts rank 1 on each skill board they can win by a priced margin; every quest done; every useful item and best-in-slot gear held; wealth to buy them. Helper levels count only when they produce a route supply, an unlock or a specialist win. Rank 1 on all 24 boards at once is not reachable against the specialist records, so it is not a target.

## Work loop

1. Check branch, dirty files, process ownership and fresh state. Preserve others' edits. One owner per account, server and generated output.
2. Pick the task that moves a scoreboard most per hour (`bun packages/router/src/coverage.ts`, the plan's scoreboards). Name its useful game outcome and consumer. Every build needs a finite live consumer.
3. Read the exact code path before changing it. After two similar failures, change the method or get a new observation.
4. Run the cheapest check that reaches the change, with a timeout. Do not run game suites for docs.
5. Report source, proof level (unit, practice, live), useful output, cost, blocker and next action. Tests, practice and live prove different things. Tools, notes and tests are not game progress.

Ask only for a decision that changes the result. Do not add design docs, approval rounds or task boards.

The [coordinator](docs/script-contract.md#autonomous-coordination) owns its queue, assignments and children. Check its state and leases before taking those resources. Never start a second controller. Extend existing workers and capability definitions; do not copy a worker per account.

On Windows every background subprocess uses `windowsHide:true`. Run only the services a job needs. Check ownership before stopping a process.

## Several agents

Several agents work at once: sessions on this PC (Claude Code, Codex) and cloud sessions (Codex, Claude Code). Each takes work from the lane the [plan](docs/plans/joined-plan.md) Lanes table gives it.

- One change, one branch `<agent>/<topic>`, one PR to `master`. Before work, check `gh pr list` and open a draft PR, so two agents never edit the same files. Merge when `bun run typecheck` and `bun test ./scripts ./packages` pass; never force-push `master`. The hosted `linux` check proves this; if it stays queued (hosted minutes used up), `bun scripts/ci-gate.ts --post` runs the same checks on the PC and posts `local-gate`, which counts the same.
- A local agent works in its own worktree (`git worktree add ../rs-sdk-bot-<agent> -b <agent>/<topic>`). Only the main checkout runs the local swarm, coordinator and fleet agent.
- Each machine runs bots only for its own fleet side (Accounts, below). Cross-side resources move through fleet orders, never by logging in another side's account.

## Research-first gate

For a new approach, check local code and [project use map](research/project-use-map.md) first. Search upstream only for an unresolved boundary or a repeated failure. Record **source -> local consumer -> reuse/adapt/reject -> check** in the topic file. Check license and attribution before copying code.

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
