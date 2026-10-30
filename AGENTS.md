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

## Research-first gate

For a new approach, check local code and [project use map](research/project-use-map.md) first. Search upstream only for an unresolved boundary or a repeated failure. Record **source -> local consumer -> reuse/adapt/reject -> check** in the topic file. Check license and attribution before copying code.

## Accounts

- The PC is available for maximum useful account progress. Fill qualified live slots across skills, quests, combat, resources and route supply. Prefer sharks over new trout or salmon; use existing stock.
- Expand in batches of up to 4 accounts after two fresh useful live results, prepared demand and measured RAM, CPU and tick headroom. Keep 4 GiB free (`packages/core/src/memory.ts`) and one practice slot. The cap of 17 is not fixed. No further permission is needed inside these bounds.
- Create an account only with a proved useful first job. A claimed or blocked account is not progress.
- New live names must be actually funny: a real penis joke where the RuneScape meaning and the innuendo both work for the role, ideally a known phrase or a true double meaning (Moneyshot, Earlyshooter, Porksword, YewGotWood, MeatNTwoVeg, TossTheCaber). A rude word bolted onto a skill word is not a joke (CoinCock, PickpockDick, NabTheKnob). Scottish where it fits. 1-12 letters or digits. Take names from `packages/core/src/names.ts` only; add new ones there to the same standard. Keep existing accounts. First login registers the account and starts its clock.
- Each assignment has one owner, budget, acceptance and next action. A vacant slot names its constraint.
- `swarm.json` owns live assignments. `scripts/fleet.ts` holds templates; `apply` only creates a missing plan.

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
