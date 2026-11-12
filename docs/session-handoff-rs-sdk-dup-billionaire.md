# Session handoff: rs-sdk item-dupe finding, live proof, and Billionaire

Written for the agent that continues this work after the current session loses context. All paths
are absolute against the main checkout root; do not rewrite them relative.

## 1. Project objective and intended end state

The repository is a research-and-operations project that plays rs-sdk (rev 289 RuneScape-emulator,
MIT, `vendor/rs-sdk`) with a fleet of bot accounts toward owner-defined scoreboard goals. Knowledge
rules live in `AGENTS.md` (root) and the plan in `docs/plans/joined-plan.md`. This session added a
security-audit thread on top: find where items can duplicate in the pinned engine, prove findings at
increasing proof levels (source -> in-sandbox live -> live public server), and register a new
owner-named account (`Billionaire`) on the live rs-sdk dev server (`rs-sdk-demo.fly.dev`).

Intended end state for this thread: the duplication finding is documented, verified at the strongest
practical level in the repository's research records, its PRs are merged, the shared dev stack is
healthy, the account is durably owned and tracked, and every follow-on item either has a fresh
evidence-backed disposition or is explicitly blocked with the smallest unblocking step.

## 2. Constraints, decisions, user preferences, prohibited actions

Repository-wide (from `AGENTS.md`, binding): no diary prose in committed docs (enforced by
`bun scripts/check-no-diary.ts`); one change -> one branch `<agent>/<topic>` -> one PR to `master`;
merge only when `bun run typecheck` and `bun test ./scripts ./packages` pass; never force-push
master; credentials never in git and never printed; one owner per account/server/generated output;
only the main checkout runs the local swarm/coordinator; every background subprocess uses
`windowsHide:true`; raw logs and temporary runners live under `.practice/<task>/`.

Session decisions made by the owner:
- The name `Billionaire` overrides the standing joke-name standard for live accounts
  (`packages/core/src/names.ts` gate) by explicit owner instruction. It is deliberately NOT added to
  `names.ts`; the exception must not be generalized.
- The owner asked to prove the dupe bug live: first in a private sandbox, then on
  `rs-sdk-demo.fly.dev`. Crash-window recovery from the earlier audit was rejected by the owner's
  implicit acceptance of honest proof chains.
- Owner direct live starts are authorized stand-alone runs: the repo's release gate for non-local
  servers is bypassed in-process by `STANDING=1` (packages/core/src/worker-release.ts, the standing
  owner-job path). Manual live jobs still require `DEMO_OK=1`.

Prohibited / do-not: do not run the shared localhost:8888 dev stack down on purpose (it was once
killed by a too-broad process pattern match; restore immediately and verify). Do not edit `vendor/`
outside the patch lane. Do not test on the main scoreboard account. Do not mint items on any machine
whose World is shared with workers: the only sanctioned mint demonstration is the isolated sandbox
under `.practice/dup-test/`. Do not print credential content from any `bot.env`.

## 3. Relevant paths, components, commands, tools, environment facts

- Engine under audit: `F:\dev-on-f\osrs-rs-research\rs-sdk-bot\vendor\rs-sdk\server\engine\src`
  (pinned by `rs-sdk.pin` = `db0cc51e...`; vendor submodule is empty in opencode worktrees, populated
  in the main checkout).
- The duplication finding: `ScriptOpcode.INV_MOVEITEM`/`INV_MOVEITEM_CERT` compute floor overflow
  from the requested `count` instead of the removed `completed`
  (`.../script/handlers/InvOps.ts:506-538` and `:542-573`). One-line fix:
  `overflow = completed - player.invAdd(to, obj, completed)`. Reachability at this pin is latent:
  every current script caller clamps. Full write-up with the audit result and loss-bug table:
  `research/rs-sdk-item-dup.md` (on branch `opencode/sdk-item-dup`, draft PR #106).
- Sandbox proof world: `.practice/dup-test/` — `engine/` (copy of the pinned engine with a file-login
  `staffmodlevel=4` patch), `content/` (copy of the vendor content tree plus the fixture
  `scripts/_test/scripts/cheats/cheat_dupe.rs2`), runners `setup-dup.ts`, `compile-dup.ts`,
  `check-*.ts`, `read-save.ts`, and the evidence `result.txt` and `engine-tail.log`.
  FACTS THE NEXT AGENT MUST KNOW: new rs2 scripts only get ids when added to
  `content/pack/script.pack` (the registry maps name -> id; the lib appends automatically once one
  new id exists); player checkpoints live in `engine/data/market.sqlite*` (accounts table), not just
  flat `data/players/<profile>/<name>.sav`; a normal session's logout re-saves over generated saves.
  Sandbox fixture trigger: `say('::~dupe <count>')` sends a real CLIENT_CHEAT; debugprocs need
  `!production && staffModLevel>=4`; the `inv` inventory is unprotected, `bank`/`worn` are
  protected (unprotected source required for a sandbox-only fixture to pass the handler gate).
- Sandbox world ports: web 18888, game 14394, management 18998, hiscores 18889. Kill only processes
  whose command line is verified as the sandbox engine (see item H-1 for the correct way).
- Shared dev stack (this machine): `bun packages/practice/src/cli.ts up|down|status` from the main
  checkout; engine listens on 8888, gateway 7780; pids recorded under `.practice/pids.json`; logs
  under `.practice/logs/`.
- Billionaire: creds at `vendor/rs-sdk/bots/Billionaire/bot.env` (never printed/committed); runners
  `.practice/billionaire-claim/{claim.ts,pickpocket-cheat.ts}`; evidence `live-run.txt`.
- Fleet registries: shared truth = `fleet/owners.json` on branch `fleet-data`, worktree at
  `.practice/fleet-data` (sync/push with `bun scripts/fleet-sync.ts` from the main checkout; the
  Billionaire row is commit `f99704d`). Master seed copy = `fleet/owners.json` (PR #108). Local
  verified-login ledger = `.practice/owned-accounts.json` (auto-recorded by the session guard).
- Run book for a manual live login: `DEMO_OK=1 STANDING=1 bun <runner>`; the repo's own thieving
  worker is `scripts/generated/thieving60.ts <bot>` with env `TARGET` (thieving level) and `CAP`
  (ticks). Their server rate-limits repeated logins (`rateLimitDeviceLogin=5`): wait ~75 s after a
  refused login before retrying.
- Open PRs by this session: #106 (`opencode/sdk-item-dup`, research doc + INDEX row) and #108
  (`opencode/billionaire-owner`, master owners-row + owner-requests row 65). Both draft.
- Pathfinding artifact: the environment exposes a completed shell stream when a background job ends;
  notification lines reference shell ids like `sh_<hex>` whose outputs are stored under
  `C:\Users\aggis\.local\share\opencode\shell\<session>\`.

## 4. Completed work that the next agent must preserve

- `research/rs-sdk-item-dup.md` (on PR #106 branch): the audited surface map (bank, trade, ground
  items, death, shops, GE, rewards), Finding 1 (the mint), Finding 2 (blind `inv_del` in deferred
  production queues), the loss-bug table, and the trade retarget desync note. Treat this as the
  canonical audit unless fresh code contradicts it.
- Sandbox live proof: 100 coins -> one debugproc call -> a ground stack of 999,999,900 coins
  (reported by the client state as a u16-clamped `Coinsx65535`) -> 1,000,000,000 coins in the
  backpack after pickup, on the isolated engine copy; evidence in `.practice/dup-test/result.txt`.
- Billionaire live facts: created and claimed twice on `rs-sdk-demo.fly.dev` (identity, save, and
  re-login work); pickpocket run via the repo worker: `RESULT ok thieving=23 xp=4200 ticks=490
  tries=47 stuns=3 died=false relogs=0 deposits banked`, then a withdraw-probe session showed 163
  coins in the backpack; both cheat packets (`::~dupe 1000000000`, `::give coins 1000`) were fired
  through the real CLIENT_CHEAT path and refused with zero coin change, because their live pack
  lacks the trigger script and the account is not staff. Evidence: `.practice/billionaire-claim/live-run.txt`.
- Fleet ownership: Billionaire row pushed to the `fleet-data` branch (commit `f99704d`), and the
  local `owned-accounts.json` ledger entry recorded automatically. The master-seed copy and the
  owner-requests ledger row (request 65) await merge through PR #108.

## 5. Unfinished-work inventory

- **U-1 Verify the shared dev stack is healthy (uncertain).**
  Intent: after the accidental kill and the follow-up restart, the shared engine (8888) and gateway
  (7780) must be up for the swarm's jobs.
  State: a restart job (`bun packages/practice/src/cli.ts up`) was started in the background and no
  completion evidence has been observed in this session's context.
  Remaining: run `bun packages/practice/src/cli.ts status` (or check `.practice/pids.json` plus
  ports). If down: `bun packages/practice/src/cli.ts up` from the main checkout, then confirm two
  swarm jobs can reach it (a status probe is enough; do not start new live jobs).
  Risks: killing an in-flight worker session by restarting; use `down` only if `up` reports a port
  conflict from a stale pids entry. Acceptance: `status` prints engine `up`, gateway `up`.
  Verification: direct command output. Priority P1.
- **U-2 Upgrade `research/rs-sdk-item-dup.md` with the live proof and refresh PR #106.**
  Intent: the research file predates the sandbox proof and the debugproc-gate facts; the strongest
  evidence should live at the finding's home.
  State: file as written in the first session (Finding 1 marked latent/provable). Missing: the
  sandbox mint run (1e9 coins from 100), the `script.pack` id-registry mechanism, the
  staff-4 gate mechanics that a live-world proof requires, and the pointer to
  `.practice/dup-test/result.txt`.
  Remaining: add a short proof section under Finding 1 (no-diary compliant), then push the branch
  (#106) so the PR carries the updated file.
  Risks: diary-rule flags (dates, was/now wording); run `bun scripts/check-no-diary.ts` before commit.
  Acceptance: PR #106 body lists the proof artifact and the research file contains it.
  Verification: `gh pr diff 106` and the no-diary check. Priority P1.
- **U-3 Merge PR #108 (master seed row + owner-requests row 65).**
  Intent: the durable master-seed registry row for Billionaire and the owner-request ledger entry.
  State: draft PR open on branch `opencode/billionaire-owner`.
  Remaining: verify branch tip still matches `fleet/owners.json` (valid JSON, row present), run
  `bun run typecheck` and `bun test ./scripts ./packages`, remove the draft flag, merge, delete the
  branch, prune the worktree if recreated.
  Risks: `check-no-diary` may flag an unrelated `swarm.json` job note at repo state; that flag is
  pre-existing and must not be "fixed" silently on this branch.
  Acceptance: PR #108 merged with green checks; `fleet/owners.json` on master contains the row.
  Verification: `git log origin/master -- fleet/owners.json` and `gh pr view 108`. Priority P2.
- **U-4 Owner-requests ledger: record the live-job disposition for Billionaire.**
  Intent: request row 65 says "give it a useful first job through the plan"; the pickpocket run and
  the cheat refusal were one-off owner jobs, not plan work.
  State: row untouched since PR #108 was opened.
  Remaining: either extend row 65's evidence path with `.practice/billionaire-claim/live-run.txt`
  (marking the one-off done, plan job still pending), or leave the row as the open plan-work item.
  Uncertain: which framing the owner wants for `Billionaire`'s next job; do not author a plan job
  without an owner decision.
  Acceptance: the ledger row references the live-run evidence. Priority P3 (fold into U-3's PR
  before merge if the owner confirms the exact wording).
- **U-5 Engine fix decision (one-line overflow patch) (deferred, uncertain).**
  Intent: retire the latent mint (`InvOps.ts:528` and `:568`, `overflow = count - invAdd(...)`
  should be `completed - invAdd(...)`).
  State: no patch was written into the vendor patch lane (`patches/rs-sdk-working.patch`, which
  carries pack CRC-sensitive changes) and no upstream issue was filed to MaxBittker/rs-sdk.
  Remaining: owner decides (a) upstream report only, (b) local patch lane fix with a pack CRC
  re-validation if the pack rebuild touches scripts, or (c) leave it documented and latent. Evidence
  for upstream: the sandbox proof, the line refs, and the exact latent-reachability argument.
  Dependencies: U-2 (evidence path), vendor-submodule workflow in `AGENTS.md` and `patches/rs-sdk.md`.
  Acceptance: one of the three outcomes visible in a commit/research line with fresh evidence paths.
  Priority P3 (zero exploit reachability today; decision hygiene only).
- **U-6 Sandbox hygiene (verify, then optionally purge).**
  Intent: the tamper sandbox contains a compiled staff-gated mint fixture; it must never leak into a
  machine state where `staffModLevel` could be grantable or the pack could be loaded by a real world.
  State: `.practice/dup-test/` remains on disk (engine copy with `data/market.sqlite*`, the fixture
  in `content/`, logs). Sandbox engine was stopped, but no evidence exists that nothing replicated
  the copies elsewhere (the data copy is 62+ MB with the fleet's practice saves inside, and both
  `engine/` and `market.sqlite*` deletions from the repo root were verified only by line-output).
  Remaining: verify (a) no bun process whose working directory is `.practice/dup-test/engine` is
  running (use `Get-CimInstance Win32_Process` and match the full command line plus a port check on
  18888/14394/18998), (b) no stray `engine/` or `market.sqlite*` sits at the repo root, (c) then
  either delete `.practice/dup-test/` or leave it with a top-level README that states who may reuse
  it, that its pack alone is inert behind staff gating, and that its data dir contains no credentials.
  Acceptance: port check returns nothing, repo root clean, disposition visible on disk.
  Verification: commands above. Priority P2 (do it before any random package could reference the
  tree).
- **U-7 Billionaire's plan slot (deferred, no owner decision).**
  Intent: the account pipeline requires a proved useful first job; a claimed idle account is not
  progress (`AGENTS.md` admission rules, batch caps, RAM budget checks in
  `packages/core/src/memory.ts`).
  State: no `swarm.json` assignment was created; the owners row is the only registration.
  Remaining: only after the owner names the role; then follow the plan's lane rules and
  `scripts/fleet.ts templates` rather than editing `swarm.json` by hand.
  Acceptance: absent an owner decision, this item stays open with a recorded blocker.
  Priority defer (P0 if the owner later asks for a wealth-board route).

## 6. Persistent goal for the new long-horizon agent

You are the continuation agent for the rs-sdk research workspace at
`F:\dev-on-f\osrs-rs-research\rs-sdk-bot` (main checkout; the branch checkout
`C:\Users\aggis\.local\share\opencode\worktree\15b6fb\eager-otter` is one of several agent
worktrees and is NOT the shared-state root). Your goal is to drive the unfinished-work inventory of
this handoff to terminal states, section by section, without inventing work.

Method requirements:
- First read `AGENTS.md`, `docs/plans/joined-plan.md`, `docs/script-contract.md`, and any research
  note your task touches, then inspect the actual workspace and `git status` per checkout before
  editing. Record the initial state in the journal before acting.
- Validate every inventory item against code, tests, docs, git history, and runtime evidence;
  correct or reject items when evidence contradicts them, and record why. Never take the inventory's
  word blindly — the audit claims in `research/rs-sdk-item-dup.md` were themselves corrected once
  (a "crash dup" candidate was disproved by the atomic checkpoint design).
- Maintain the journal at `.practice/handoff/journal.md` (create the folder on first use). One
  entry per action: item id, command run, evidence path, result. Journal files are raw scratch
  (ignored); summary claims still belong in the proper research/ledger files.
- Dependency order: U-1 (stack health) first because later evidence needs the live world; then U-2
  and U-3/U-4 in parallel-safe file areas (`research/` versus `fleet/` and `research/owner-requests.md`
  — note both U-2 and U-4 may touch `research/`, keep their commits in separate branches); then
  U-6 hygiene; then U-5 and U-7 only after, or answered as blocked with the question recorded for
  the owner. Use `bun run deliver --list`/plan boards if you need work while waiting on owner inputs;
  the repo's scoreboard coverage tool is `bun packages/router/src/coverage.ts`.
- For every bounded slice: reproduce or establish a baseline first (read the exact code path),
  run the cheapest check that reaches it (focused `bun test <file>`), and run broader checks
  (`bun run typecheck`, `bun test ./scripts ./packages`, `bun scripts/check-no-diary.ts`) before
  merging or declaring progress. Rerun affected checks after any later edit that invalidates them.
- Do not repeat a failed method more than twice; switch methods after two similar failures and get
  a new observation (this rule already saved this thread once: the first coin probe crashed mid
  runner, the second one read bank state, the third found the SQLite checkpoint store overwrite).
- Adversarially verify every recorded claim for missed consumers, false passes, security
  implications (this workspace touches an emulator's economy code), and unsupported language. A
  truthful rejected/obsolete item is acceptable; a fabricated completion is not.
- Stop conditions (only these): every validated item has fresh acceptance evidence; a real owner,
  credential, external-service, or safety boundary blocks it (record the exact blocker and the
  smallest unblocking step); or evidence proves an item invalid or harmful. Termination without one
  of those states, or termination because the work is hard, is a failure.
- Completion contract: a final item-by-item status table (id, accepted/blocked/rejected with the
  evidence path), a changed-file summary per branch/PR, the exact verification commands and their
  results, any measured improvements, remaining blockers with unblocking steps, and residual risks —
  plus one final fresh verification pass (status check, checks on merged state, port checks) after
  the last change. Write the contract into the journal and reference it from the research docs it
  touched.

## 7. Session provenance recap (for the journal)

Accepted evidence produced by this session: PR #106 + #108 (draft), `fleet-data` commit `f99704d`,
`.practice/dup-test/result.txt`, `.practice/billionaire-claim/live-run.txt`, branch
`opencode/billionaire-owner` commit `6caeea4`, branch `opencode/sdk-item-dup` commit `75af34e`.
Environment quirks met and handled: Windows PowerShell quoting (no `head`, `grep`, `cat`,
`Select-Object -Index 1..3`), bun direct-run imports needing absolute or file-URL paths from the
worktree, the fleet release gate (`WORKER_RELEASE`/`STANDING`), the server's device login rate
limit, save loading preferring the market-db checkpoint over the flat file, and PowerShell
`Set-Content` mangling JSON when fed -replace output (use the edit tool on config files, verify with
`JSON.parse`, and never hand-edit generated reports).
