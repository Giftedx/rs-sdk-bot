# Runebench and Harbor: how the benchmark works and how to use it as our eval

Sources are the local clones under `F:\dev-on-f\osrs-rs-research\rs-sdk-bot\vendor\`:

- `runebench` at commit `3100b56`
- `harbor` at commit `d4038de` (version `0.24.0` in `pyproject.toml`)
- `terminal-bench` at commit `d28711d`
- `rs-sdk`, for the MCP server and the wiki

All paths below are relative to `vendor\`. Nothing here was run in Docker. The numbers come from the committed result files.

---

## 1. The runebench repository

### 1.1 Layout

| Path | Purpose |
|---|---|
| `runebench/generate-tasks.ts` | The only source of truth for tasks. It writes `tasks/<slug>/` (gitignored). |
| `runebench/dataset.toml` | Harbor dataset manifest `maxbittker/runebench`. It lists the 32 skill tasks (16 × 15m and 16 × 30m), with digests. |
| `runebench/shared/check_skill_xp.ts` | The skill verifier. It computes the peak XP rate. |
| `runebench/shared/check_xp_rate.ts` | The agent-facing CLI that prints the current score. It is copied to `/app/benchmark/shared/`. |
| `runebench/shared/skill_tracker.ts` | The root-owned daemon. It samples all skills and gold every `SAMPLE_INTERVAL_MS`. |
| `runebench/shared/check_gold.ts` | The gold verifier. It reads the `.sav` file directly. |
| `runebench/shared/agents.md` | The guide that becomes `/app/agents.md`, `/app/CLAUDE.md` and `/app/GEMINI.md` in the image. |
| `runebench/shared/agent*.sav` | Starting saves: `agent.sav` for skills, plus 4 gold starting conditions. |
| `runebench/shared/pricing.ts` | Per-model token prices for `cost_usd`. |
| `runebench/docker/` | `Dockerfile.base`, `Dockerfile`, `entrypoint.sh`, `ensure-services.sh`, `launch-bot.ts`, `build.sh`. |
| `runebench/agents/` | Harbor agent adapters: `opencode_adapter.py` (base class), `codex_adapter.py`, and about 40 per-provider subclasses. |
| `runebench/scripts/` | `run-skills-30m.sh`, `run-skills-15m.sh`, `run-gold.sh`, `run.sh`, `run-common.sh`, and per-model scripts. |
| `runebench/extractors/` | `extract-skill-results.ts` and `extract-gold-results.ts`. They read `jobs/` and write `results/`. |
| `runebench/results/` | `skills-30m/` (`_data.js` plus one `<model>.json` for each of 101 model rows), and `skills-15m/`, `skills-10m/` and `gold/` (`_data.js` only). |
| `runebench/app/`, `index.html`, `views/` | The results website (Preact and htm), which is deployed to GitHub Pages. |

### 1.2 How a task is defined

`generate-tasks.ts` writes the following for each `VariantTask`:

- `task.toml` (from `generateVariantTaskToml`):
  - `[agent] timeout_sec = horizon*60 + 120` and `user = "agent"` (not root)
  - `[verifier] timeout_sec = 400`
  - `[environment] cpus = 2`, `memory_mb = 8192`, `storage_mb = 10240`, `allow_internet = true`
  - one `[[environment.mcp_servers]]` entry: `name = "rs-agent"`, `transport = "stdio"`, `command = "bun"`, `args = ["run", "/app/mcp/server.ts"]`
- `instruction.md`: `SKILL_XP_INSTRUCTION(skill, minutes)` or `GOLD_INSTRUCTION(...)`.
- `tests/test.sh`: this script kills ffmpeg and every agent-spawned `bun` process (`VERIFIER_CLEANUP`). Then it runs `/ensure-services.sh`, then `SKILL_NAME=<Skill> bun run /tests/check_skill_xp.ts`.
- `environment/Dockerfile`: a thin layer, as follows.

  ```
  FROM ghcr.io/maxbittker/rs-agent-benchmark:v71
  ENV SAMPLE_INTERVAL_MS=15000          # 5000 for gold tasks
  ENV GATEWAY_URL=ws://localhost:7780
  ENV BENCHMARK_DURATION_SECS=<horizon*60>
  COPY agent.sav /app/server/engine/data/players/main/agent.sav
  ```

### 1.3 The exact scoring formula

The per-task score comes from `runebench/shared/check_skill_xp.ts`, in `computePeakXpRate` and `peakWindowStart`:

1. The tracker writes samples `s_0..s_n` to `/logs/tracking/skill_tracking.json` every 15 s. Each sample has `elapsedMs` and `skills[name].xp`, which is raw server XP.
2. For each `i ≥ 1`, the window start `k` is the nearest earlier sample with `elapsedMs_i − elapsedMs_k ≥ MIN_PEAK_WINDOW_MS (12000)`. On the normal cadence, `k = i−1`. A shorter gap appears only after a tracker restart. In that case, samples merge into one window of at least 12 s.
3. The verifier computes `ΔXP = xp_i − xp_k` and `Δt = elapsedMs_i − elapsedMs_k`. It skips the window if `ΔXP ≤ 0` or `Δt ≤ 0`.
4. `rate = (ΔXP / Δt) × 60000 / 8 / 25`. This is real-game XP/min. The divisor 8 is game speed and 25 is the server XP multiplier, so the total divisor is 200.
5. `peakXpRate = round(max rate)`. This value goes to `/logs/verifier/reward.txt`. The verifier also writes `reward.json` with `{skill, peakXpRate, xp, level, verifierStartTime, tracking}`.

Windows are aligned to the tracker clock, not sliding. The tracker starts in `entrypoint.sh` before the agent starts, so the first samples cover setup time.

The cross-skill aggregate is in `app/components/Heatmap.js` (lines 79–98), `CostTable.js`, `CostScatter.js` and `ReleaseScatter.js`:

```
logMean(model) = (1/16) × Σ_{skill ∈ 16 skills} ln(1 + peakXpRate[skill])
```

A missing skill counts as 0, which gives `ln 1 = 0`. Models are sorted by `logMean` in descending order. `ReleaseScatter.js` shows the linear version, `exp(logMean) − 1`, as "XP/min (geometric mean)". Cost is `avgCost = mean over skills of tokenUsage.costUsd`, in $ per skill run.

The gold score (`check_gold.ts`) is `max(peak tracker sample gold, final save read)`. Gold is inventory coins + bank coins + worn coins. The tracker samples gold every 5 s. The aggregate is again the mean of `ln(1 + gold)` (`GoldMatrix.js`).

There is also a drift guard: `scripts/check-xp-normalization-sync.ts` keeps the ÷200 and the 12 s minimum the same in the verifier, CLI, extractor and website.

### 1.4 Tick rate and normalization

- `docker/Dockerfile` sets `ENV NODE_TICKRATE=50`. rs-sdk's engine default is `NODE_TICKRATE = 400` ms (`rs-sdk/server/engine/src/util/Environment.ts:54`), so 400/50 gives **8× speed**. Note that the authentic game tick is 600 ms, so against real RS the speed is 12×. The Dockerfile comment says "vs default 420ms", but that comment is stale.
- The XP multiplier is `xpRate: 25` (`rs-sdk/server/engine/src/util/WorldConfig.ts:102`, override `NODE_XPRATE`).
- A 30-minute wall-clock run is therefore about 4 h of game time at the 400 ms tick.

### 1.5 Time horizons and the task list

`generate-tasks.ts` builds `VARIANTS` from these groups:

- **Smoke task**: `woodcutting-xp-5m`.
- **Skill XP, 15 m and 30 m**: `{skill}-xp-15m` and `{skill}-xp-30m` for 16 skills. The skills are Attack, Defence, Strength, Hitpoints, Ranged, Prayer, Magic, Woodcutting, Fishing, Mining, Cooking, Fletching, Crafting, Smithing, Firemaking and Thieving. Agility, Herblore and Runecraft are not included.
- **Gold, 15 m and 30 m**: `gold-{vanilla, smith-alch, fish, fletch-alch}-{15m,30m}`, which gives 8 tasks. Each condition has its own save and a hint in the instruction:
  - smith-alch: Falador, 99 Mining, 99 Smithing and 99 Magic, a pickaxe, 100 nature runes and 500 fire runes
  - fish: Catherby, 50 Fishing, a small net
  - fletch-alch: Seers Village, 50 Fletching, 50 Magic, a knife and alch runes
- There are **no quest tasks or item tasks**. Quests appear only as an exploit inside the skill tasks (see section 3). The file header still mentions "2h" gold tasks, but the code does not generate them. `results/skills-10m` is a legacy horizon.
- The headline board is **skills-30m**. `dataset.toml` publishes only the skill tasks, not the gold tasks.

### 1.6 How the server starts inside Docker

The image chain is `debian:bookworm-slim` → `rs-agent-benchmark-base:v2` → `rs-agent-benchmark:v71`.

`Dockerfile.base` adds chromium, a headless JRE, xvfb, ffmpeg, pulseaudio and bun. It is about 1.6 GB.

`Dockerfile` does the following:

1. It clones rs-sdk with `git clone --depth 1 --branch $RS_SDK_REF`. Image v71 is built from branch `bench-v71`, which is v70's SDK `56b73e08f` plus an MCP console-capture cap (`runebench/CLAUDE.md`). Our local `vendor/rs-sdk` can differ from that pin.
2. It runs `bun install` for the root, the engine, the gateway and the webclient, and copies the webclient build into the engine's `public/bot`.
3. It removes `/app/scripts` and `/app/sdk/test`, and replaces the upstream agent docs with `shared/agents.md`.
4. It packs the cache (`bun run build`), boots the engine once, and fails the build if `/versionlist0` does not serve.
5. It installs Claude Code into `/opt/claude` and writes `/app/.mcp.json`.
6. It creates the `agent` user (uid 1000) and locks `/app/server`, `/app/sdk`, `/app/mcp` and `/app/benchmark` read-only for that user.

At runtime, `docker/entrypoint.sh` does the following:

1. It starts Xvfb `:99` and PulseAudio with a null sink.
2. It starts the engine: `cd /app/server/engine && bun run src/app.ts`, then waits for `:8888`.
3. It starts the gateway: `cd /app/server/gateway && bun run gateway.ts`, then waits for `:7780`.
4. It starts the bot client: `bun run launch-bot.ts`. This is a non-headless chromium on Xvfb that logs in as `agent`/`test` (`docker/bot.env`). The script then sleeps 20 s for the tutorial skip.
5. It starts the root-owned skill tracker, which writes `/logs/tracking/skill_tracking.json`. The directory mode is 755.
6. It starts ffmpeg, which records the screen at 1 fps, 400×300, to `/logs/verifier/recording.mp4`.
7. It starts a watchdog that runs every 5 s and restarts the engine, gateway and bot up to 10 times. Agents run `pkill bun`, so the watchdog is necessary. The watchdog adopts only a tracker that root owns.

Anti-tamper (image v70 or newer): the agent cannot write the engine, the saves, the SDK, the tracker or the tracking file. The verifier does not read the agent-writable copy at `/logs/verifier/skill_tracking.json`. Blocked tamper methods (also in `CLAUDE.md` and the Dockerfile comments): fake tracking JSON, running the tracker at a 1 s cadence, overwriting `agent.sav` with the save generator.

---

## 2. What the agent receives inside the task

### 2.1 Instruction text

The instruction is `SKILL_XP_INSTRUCTION` in `generate-tasks.ts`, lines 135–181. It contains these points:

- "Train {Skill} as efficiently as possible for N minutes … (8x speed)."
- The score is the **peak real-game XP/min over a single 15-second sampling window**. Raw XP ≈ 200× the score. Samples use a fixed 15 s cadence and are not sliding.
- The agent can check its score with `bun /app/benchmark/shared/check_xp_rate.ts {Skill}`. The output shows the peak, the best window, the time elapsed and remaining, and the seconds until the next sample.
- Control is through the `rs-agent` MCP server, with `execute_code` and `bot_name: "agent"`. The globals are `bot` (BotActions) and `sdk` (BotSDK). The agent must read the MCP resources "Bot API" and "SDK API". The instruction says not to invent `mineRock`, `fish` or similar methods, and to use `interactLoc`, `interactNpc` and `useItemOnLoc`.
- The first call should be `await bot.skipTutorial();`, then one `bot.chopTree()`, then loops.
- For long runs, the agent writes `/tmp/my_script.ts` and runs it with `bun … > /tmp/train.log 2>&1 &`. The instruction says not to use `timeout`, because its SIGTERM kills the game connection.
- RULES: legitimate in-game actions only. Do not modify the server or saves. Do not use cheat commands. The agent runs unprivileged and must put its scripts in `/tmp` or `/app/bots/agent/`.

The gold instruction (`GOLD_INSTRUCTION`) is similar. It lists money-making ideas and says "do NOT write one giant script", and it gives banking advice.

### 2.2 Tools

The MCP server is `rs-sdk/mcp/server.ts`. It exposes these tools:

- `execute_code(bot_name, code, timeout?)`, with a default of 2 min and a maximum of 60 min. The code is TypeScript with the globals `bot`, `sdk` and `Spells`. A world-state summary is appended to every result: position, skills, inventory, nearby entities, dialogs and messages. A new call cancels the running call.
- `disconnect_bot` and `list_bots`.
- `get_market` (`market-tools.ts`).

The resources are `sdk/API.md` (SDK API Reference) and `sdk/MARKET.md`.

The agent also has its harness's own shell, file and search tools. The process runs in `/app`.

### 2.3 Documents in the image

- `/app/agents.md`, which is copied to `/app/CLAUDE.md` because Claude Code auto-loads only that name. It is also copied to `/app/GEMINI.md` with a note that tells Gemini not to use heredocs. The guide covers workflow (`bun sdk/cli.ts agent`, short scripts, fail fast), quick-reference tables for `bot.*` and `sdk.*`, and troubleshooting.
- `/app/wiki/`, generated in rs-sdk, with the folders `items/`, `npcs/`, `shops/`, `skills/` and `quests/` (59 quest walkthroughs, with XP rewards).
- `/app/learnings/`, with notes on banking, combat, cooking, dialogs, fishing, fletching, mining, smithing, thieving, walking, woodcutting and so on.
- `/app/sdk/*.ts`, which agents can read. One agent read the game source to find item spawns (`InterestingTrajectories.js`).

### 2.4 Harnesses used

- **Claude models**: Harbor's built-in `claude-code` agent (`-a claude-code`). It registers the task's MCP servers through `_build_register_mcp_servers_command` in `harbor/src/harbor/agents/installed/claude_code.py`, and runs `claude --verbose --output-format=stream-json --print` with the instruction on stdin.
- **OpenAI models**: `agents/codex_adapter.py:CodexWithTimeout`. This adapter adds a Modal exec timeout, passes OAuth through `CODEX_AUTH_JSON_B64`, and cleans up `$CODEX_HOME`.
- **Gemini 3.x**: `gemini-cli`, pinned to `--ak version=0.38.2`.
- **All other models**: `agents/opencode_adapter.py:OpenCodeAdapter` subclasses. The adapter writes `/app/opencode.json` with the provider and MCP config, and sets a 180 s timeout for each API call. It runs `opencode run --format=json "<instruction>"` inside a bash **restart loop**. If the agent stops early and at least 180 s remain, the loop restarts it with "You were previously working on this task but stopped early … CONTINUE training. Do NOT write a summary — keep grinding." The loop stops after 3 fast failures (shorter than 10 s). The OpenCode built-in system prompts are in `agents/opencode_prompts/*.txt`.

### 2.5 How results are stored and published

1. Harbor writes `jobs/<job>/<task>__<id>/`, which contains `result.json` (with `agent_result.n_input_tokens` and the other token counts), `agent/` (agent logs and the ATIF `trajectory.json`), and `verifier/` (`reward.json`, `reward.txt`, `test-stdout.txt` and `recording.mp4`). `jobs/` is gitignored.
2. `bun scripts/postprocess-costs.ts` backfills `cost_usd` from tokens with `shared/pricing.ts`. This step is needed for claude-code, codex and gemini-cli. OpenCode reports cost itself.
3. `bun extractors/extract-skill-results.ts --horizon 30m` writes three outputs:
   - `results/skills-30m/_data.js` (`window.COMBINED_DATA`, a summary)
   - `<model>.json` per model, which holds the samples, a trajectory capped at 200 steps (`shared/trajectory.ts:112`), tokens, `toolCalls`, `videoUrl` and timings
   - `_combined.json`, which is gitignored
4. The videos go to Cloudflare R2 (`scripts/upload-videos.ts`, `pub-…r2.dev/30m/<model>/<skill>.mp4`).
5. The website is `index.html` plus `app/`, prerendered by `scripts/prerender.ts`. It is deployed by `.github/workflows/pages.yml` on every push that touches `app/`, `views/` or `results/`, and it is served at https://maxbittker.github.io/runebench/.

   The page has these components: a heatmap that you can sort by `logMean` with a "best row per model" toggle, a cost table, a cost scatter with the Pareto frontier, a release-date scatter, a gold matrix, and a trajectory modal (`TrajectoryModal.js`) that syncs video, XP curve and transcript.

---

## 3. Results data in the repository

### 3.1 The skills-30m leaderboard

This table comes from `results/skills-30m/_data.js`: 101 model rows × 16 skills, with one trial each (`-k 1`). The values were recomputed with the website formula above. The cost is the average $ per skill run.

| # | Row | ⟨ln(1+r)⟩ | geomean XP/min | Σ peak | $/run |
|---|---|---|---|---|---|
| 1 | gpt6astra-high (GPT-6 Astra, high) | 7.26 | 1419 | 34063 | 15.26 |
| 2 | gpt6astra (medium) | 6.91 | 1002 | 29661 | 15.55 |
| 3 | gemini4argon (OpenCode) | 6.91 | 998 | 22406 | 4.17 |
| 4 | gpt61sol-high | 6.88 | 968 | 31001 | **1.86** |
| 5 | gpt61sol (medium) | 6.79 | 885 | 21772 | 1.71 |
| 6 | gpt61sol-low | 6.75 | 849 | 20972 | 1.52 |
| 7 | opus55-xhigh (Claude Opus 5.5) | 6.66 | 781 | 19792 | 5.18 |
| 8 | opus55 | 6.63 | 758 | 18333 | 3.36 |
| 9 | gpt6sol-high | 6.44 | 628 | 14207 | 4.84 |
| 11 | grok46 | 6.28 | 535 | 12757 | 5.11 |
| 12 | fable51-xhigh | 6.14 | 465 | 12692 | 9.29 |
| 20 | deepseek41flash1017 | 5.83 | 341 | 9986 | **0.09** |
| 33 | sonnet55-xhigh | 5.52 | — | 5834 | 2.30 |
| 43 | beam (Reflection Beam 1.0) | 5.26 | — | 5467 | 0.60 |
| 67 | opus (Opus 4.6) | 4.42 | — | 2013 | 3.16 |
| 101 | gpt4o | 0.33 | — | 200 | 2.08 |

On the Pareto frontier, the obvious points are deepseek41flash1017 (about $0.09), the gpt61sol family (about $1.5–1.9) and gpt6astra-high (the top score at about $15). Opus 5.5 is dominated by gpt61sol-high on both axes.

The best cell per skill, with the method from the trajectories in `<model>.json`:

| Skill | Best | Row | Method |
|---|---|---|---|
| Attack | 6875 | gpt61sol-high | Waterfall Quest reward, after Vampire Slayer |
| Strength | 6875 | gpt61sol-high | Waterfall Quest reward (13,750 Str) |
| Smithing | 6363 | gpt6astra-high | Knight's Sword completion: 318,125 raw XP in one window |
| Firemaking | 5924 | gpt6astra-high | 39 magic logs in 15 s: 300 ms tinderbox inputs, alternating fire lanes, instant bank refills |
| Thieving | 5268 | gpt6astra | Ardougne knights pickpocket loop to 99 |
| Cooking | 3675 | gpt61sol-low | Rapid sharks at Catherby, synced to the sample clock |
| Fishing | 3587 | gemini4argon | — |
| Hitpoints | 3235 | gpt6astra-high | Witch's House reward + combat in the same window |
| Fletching | 3065 | gpt6astra | — |
| Magic | 2061 | gemini4argon | — |
| Woodcutting | 1250 | gpt56terra-xhigh | — |
| Crafting | 1225 | opus55-xhigh | — |
| Ranged | 748 | gpt6astra-high | — |
| Mining | 650 | gpt6astra-high | — |
| Defence | 624 | gpt6astra-high | — |
| Prayer | 623 | opus55-xhigh | Many rows sit at exactly 563, which is the Restless Ghost reward (1,125 × 0.5) |

**The quest exploit in numbers.** A quest reward of Q real XP becomes 25Q raw XP. If the whole reward lands in one 15 s window, the score is `25Q × 4 / 200 = 0.5 × Q`. These values match the data exactly:

- Waterfall: 13,750 → 6875
- Knight's Sword: 12,725 → 6363
- Restless Ghost: 1,125 → 563
- Vampire Slayer: 4,825 → about 2413 (gemini4argon Attack is 2414)

The largest quest reward for each skill in `rs-sdk/wiki/quests/` is:

| Quest | Reward |
|---|---|
| Dragon Slayer | 18,650 Str and 18,650 Def |
| Grand Tree | 18,400 Att |
| Digsite | 15,300 Mining |
| Watchtower | 12,000 Magic |
| Holy Grail | 11,000 Prayer |
| Temple of Ikov | 10,500 Ranged and 8,000 Fletching |
| Sea Slug | 7,175 Fishing |
| Elemental Workshop | 5,000 Crafting |
| Fight Arena | 3,375 Thieving |
| Monk's Friend | 2,000 Woodcutting |

No one has used these rewards for Defence, Mining, Magic, Prayer or Ranged yet. The current top scores there are 624, 650, 2061, 623 and 748. Most of these quests are probably out of reach in 30 minutes because of their quest requirements. I have not verified this.

### 3.2 Strategies noted by the author

These come from `app/components/InterestingTrajectories.js` and `Discussion.js`:

- GPT-5.4 reverse-engineered the 15 s sampler and timed its smithing bursts to land right after a tracker tick.
- Gemini Flash tried 4 fishing methods and sold fish to pay for feathers. It also bootstrapped a crafting supply chain: pickpocket for coins, kill cows for hides, tan at Al Kharid, then buy gems.
- Opus 4.6 needed a knife, read the wiki and the game source, and found that muggers drop knives.
- Sonnet 4.5 is the anti-pattern. It wrote one mega-script and rewrote it repeatedly without validating any step. It scored 0 XP in 30 minutes.
- Gemini 3.1 died in the Wilderness while it looked for runite and then recovered.
- The author chose **peak rate** over **total XP** because total XP rewarded mindless grinding. Peak rate rewards strategy discovery.
- The author lists these limitations: long runtimes, models that front-load planning (shorter horizons punish this), slow inference, and noise from n=1.
- The author grew rs-sdk itself through automated failure analysis over batches of agent runs.
- Future work in the author's notes: multi-agent supply chains, and knowledge transfer (one agent writes a guide that a second agent uses).

### 3.3 Other boards

- `skills-15m` and `skills-10m` are older and use fewer models. The top 15m rows are geminiflash (⟨ln⟩ 3.64), opus (3.60) and sonnet46 (3.57).
- The gold board has Anthropic models only. The best 30 m peak-gold results are:

  | Condition | Model | Gold | Cost |
  |---|---|---|---|
  | vanilla | opus | 11,170 | $4.33 |
  | fish | opus47 | 21,828 | — |
  | smith-alch | opus | 22,738 | — |
  | fletch-alch | opus | 24,467 | — |

---

## 4. Harbor

### 4.1 Requirements

- Python 3.12 or later. Install with `uv tool install harbor` or `pip install harbor` (`harbor/README.md`).
- Docker is the default environment (`-e docker`). Harbor also supports modal, daytona, e2b, runloop, gke and others; the full list is in `harbor/src/harbor/models/environment_type.py`. Runebench itself runs on **Modal** (`--env modal --ek sandbox_timeout_secs=7200`).
- Each task needs 2 CPUs and 8 GB RAM, with 4 GB as the baseline. The image is about 2.6 GB (base about 1.6 GB plus the app layer about 1 GB). The task needs internet access for model APIs.
- On this Windows machine, use Docker Desktop with the WSL2 backend. Run Harbor and `bun generate-tasks.ts` from WSL or Git Bash. The Dockerfile and the run scripts are bash. The image is public on GHCR (`ghcr.io/maxbittker/rs-agent-benchmark:v71`), so the thin `environment/Dockerfile` only pulls it and copies the save.

### 4.2 Run one runebench task locally

```bash
cd vendor/runebench
bun install && bun generate-tasks.ts          # writes tasks/ (gitignored)

# Smoke test with Claude Code, local Docker
export ANTHROPIC_API_KEY=...
harbor run -p tasks -i woodcutting-xp-5m -a claude-code \
  -m anthropic/claude-opus-5-5 -e docker -n 1 -k 1 --job-name smoke-wc

# One 30 m skill
harbor run -p tasks -i fishing-xp-30m -a claude-code -m anthropic/claude-opus-5-5 -e docker

# All 16 skills, 30 m, 4 at a time (needs about 32 GB RAM)
harbor run -p tasks $(for s in attack defence strength hitpoints ranged prayer magic woodcutting \
  fishing mining cooking fletching crafting smithing firemaking thieving; do echo -n "-i $s-xp-30m "; done) \
  -a claude-code -m anthropic/claude-opus-5-5 -e docker -n 4 -k 1

harbor view ./jobs                              # browse trials
bun scripts/postprocess-costs.ts && bun extractors/extract-skill-results.ts --horizon 30m
```

The repository wrappers are `./scripts/run-skills-30m.sh -m opus55 -s fishing -k 4` and `./scripts/run.sh -t woodcutting-xp-15m`. Both default to `--env modal`.

The flags are defined in `harbor/src/harbor/cli/jobs.py`:

| Flag | Meaning |
|---|---|
| `-p/--path` | Task or dataset directory |
| `-i/--include-task-name` | Task name to include |
| `-t/--task` | Task |
| `-d/--dataset` | Registry dataset |
| `-a/--agent` | Agent name or `module:Class` |
| `-m/--model` | Model |
| `--ak` | Agent kwarg |
| `--ae` | Agent environment variable |
| `--ek` | Environment kwarg |
| `-e/--env` | Environment type |
| `-n/--n-concurrent` | Concurrent trials |
| `-k/--n-attempts` | Attempts per task |
| `--mcp-config` | MCP config |

### 4.3 Built-in agents

The built-in agents are listed in `harbor/src/harbor/models/agent/name.py`. They include claude-code, codex, gemini-cli, opencode, openhands, goose, aider, mini-swe-agent, terminus-2, cursor-cli, kimi-cli, qwen-coder, copilot-cli and pi.

The installed agents are in `harbor/src/harbor/agents/installed/*.py`. Each one installs a CLI in the container and pipes the instruction into it. The pass-throughs for claude-code (`claude_code.py`) are:

| Option | Maps to |
|---|---|
| `--ak reasoning_effort=` | `--effort` |
| `--ak max_turns=` | `--max-turns` |
| `allowed_tools` | `--allowedTools` |
| `permission_mode` | `--permission-mode` |

Agents that support MCP register the task's MCP servers automatically.

### 4.4 Plug in our own harness

There are two options. The reference is `harbor/docs-mintlify/agents/custom-agents.mdx`.

- **Installed agent**, which is preferred. Subclass `harbor.agents.installed.base.BaseInstalledAgent`. Implement `name()`, `install(env)` and `run(instruction, env, ctx)`. Use `exec_as_agent`/`exec_as_root` to run commands. Override `populate_context_post_run` to emit tokens and the ATIF trajectory.

  `runebench/agents/opencode_adapter.py` is the best template. It writes a config file, runs the CLI in a time-budgeted restart loop, and parses JSONL into ATIF `Trajectory`/`Step`/`Metrics`. `beam_adapter.py` shows how to add a custom OpenAI-compatible provider in about 60 lines.
- **External agent**. Subclass `harbor.agents.base.BaseAgent`. The loop runs on the host and drives the container through `environment.exec(...)`.

To run a custom agent:

```bash
PYTHONPATH=path/to/our_agents harbor run -p tasks -i fishing-xp-30m \
  -a our_harness:OurAgent -m anthropic/claude-opus-5-5 --ak run_timeout_sec=1800
```

Runebench's scripts use `--agent-import-path 'module:Class'`. Harbor 0.24 still accepts that flag but marks it deprecated in favor of `-a` (`jobs.py:1634`).

**Version caveat.** Runebench targets an older, locally patched Harbor. `codex_adapter.py` says "rewritten for harbor 0.4.0", and `task.toml` comments mention patches to `modal.py` and `claude_code.py`. The vendored Harbor 0.24.0 verifier **rejects non-numeric values in `reward.json`**, and it prefers `reward.json` over `reward.txt` (`harbor/src/harbor/verifier/verifier.py:96-122, 299-302`). Runebench's `reward.json` contains `skill` (a string) and `tracking` (an object). So on 0.24.0, every trial should fail with `VerifierOutputParseError` until one of these fixes is applied:

- The verifier writes only numeric keys, for example `{"peakXpRate": N}`, and moves the tracking data to another file such as `tracking.json`.
- We pin Harbor to the version the author used. That version is unknown. Check `uv tool list` on the author's machine or ask on Discord.

I inferred this from the code and did not run it.

---

## 5. Terminal-bench task criteria (summary)

The rubric is `harbor/src/harbor/cli/quality_checker/default-rubric.toml`, the same as `terminal-bench/terminal_bench/cli/tb/quality_checker/models.py`. Run it with `harbor check <task-dir>`. Static checks run with `harbor lint`. A good task meets these criteria:

1. Everything the tests check is stated in the instruction, including names, schemas and interfaces.
2. Everything the instruction asks for is tested.
3. The test code has a clear structure, with sections that say what they check.
4. **It resists cheating.** The agent cannot edit data files, grep for answers, or use leaky network resources, and the answers are not in the image.
5. Structured outputs have an explicit schema.
6. Python dependencies are pinned. Apt packages are not.
7. There are no typos in paths or names.
8. `tests/` and `solution/` are not copied into the image.
9. Test-only dependencies are installed in `test.sh` and not in the image.
10. The oracle solution derives the answer and does not echo it.
11. Output filenames are named in the instruction.

The terminal-bench README also requires an instruction, a test script and an oracle solution for each task. Tasks must be "hard, realistic". Runebench passes criteria 4 and 8. It has no oracle solution, because the score is a continuous rate and not pass/fail. It also depends on mutable `main` unless you build from a pinned branch.

---

## 6. Using runebench as our objective eval

### 6.1 Protocol

1. **Freeze the environment.** Use image `v71`, keep `SAMPLE_INTERVAL_MS=15000`, and do not edit the verifier. Record the image SHA, the model and the effort with every run.
2. **Primary metric**: `⟨ln(1+peakXpRate)⟩` over the 16 skills at 30 m, so our numbers compare directly with the public board. **Secondary metrics**: $ per skill run, `toolCalls`, time to first nonzero XP (from `samples`), the final level, and the number of zero-XP skills.
3. **Control model**: run our harness and the stock `claude-code` with the **same model**, for example Opus 5.5 (public row: 6.63 at $3.36, or 6.66 xhigh). The score difference is the harness effect. The public board already shows large harness and effort effects. Gemini 4 Argon on OpenCode scores 6.91, and the GPT-6 rows on codex lead.
4. **Noise**: the board uses n=1 per cell. Use `-k 3` or more on a fixed subset during development and report mean ± spread for each skill. Each skill's ln term carries 1/16 of the weight. A zero costs ln(1+r) in full. Moving one skill from 0 to 100 adds 0.29 to the mean, and moving one from 1000 to 2000 adds only 0.04. **Avoiding zeros matters most.**
5. **Cost**: a 30 m × 16 sweep runs 8 container-hours and costs about $30–250 in tokens, based on the public $/run × 16. For development, use the 5 m smoke task and 15 m runs on 4 representative skills. Good candidates are Fishing for gathering, Smithing for a production chain, Attack for combat with a quest option, and Thieving.
6. **Fix the Harbor reward.json incompatibility** (section 4.4) before the first run.

### 6.2 What a top-scoring harness has to do

This list comes from the winning trajectories and the scoring mechanics.

1. **Get a nonzero baseline within 1–2 minutes** for every skill. Never finish with a zero. The instruction already says this, but weak harnesses still front-load planning.
2. **Understand the metric.** The score is the peak over one aligned 15 s window, and **lumps count**. A quest reward scores 0.5 × its real XP. Bursting a whole inventory of actions inside one window can beat a steady rate several times over: 39 logs per window for Firemaking, and timed batches of sharks or smithing. The harness should give the model the `check_xp_rate.ts` timing ("next sample in ~Ns") and a burst-scheduler helper that starts the action queue right after a tick.
3. **Use a quest-reward lookup.** For each target skill, the harness should list the quests with an XP reward and their requirements. The source is `/app/wiki/quests/*.md`, which can be parsed into a table. The harness should rank options by `0.5 × reward` against the estimated completion time. The proven routes are Waterfall (Att/Str 6875), Knight's Sword (Smithing 6363), Witch's House (HP), Vampire Slayer (Att) and Restless Ghost (Prayer). Untapped high-value routes appear to be the Grand Tree (Att 18,400 → 9200), Dragon Slayer (Str/Def → 9325) and Digsite (Mining → 7650). Feasibility in 30 minutes is not verified.
4. **Stack rewards in one window.** One option is to finish the quest during an active skilling burst, as gpt6astra did on Hitpoints with Witch's House plus combat. Another is to stage two quest hand-ins and complete both inside one window.
5. **Iterate fast on the API.** Use small `execute_code` probes, then background `bun` scripts for loops, and poll the log and the CLI. Do not use `timeout`. Validate each part of a supply chain before combining them. Sonnet 4.5's 0 XP is the failure case.
6. **Survive.** The bot needs food logic and death recovery (re-equip, walk back). The watchdog restarts services if a script kills `bun`, but only up to 10 times.
7. **Prepare a playbook for each skill before the run.** Our harness may ship its own knowledge, such as skill routes, tuned click delays and quest scripts, as harness files or skills. Runebench's rules forbid only server or save tampering and cheat commands. We should still record the size of the bundled knowledge, so that a "harness" score and a "model" score stay separate.
8. **Keep the agent running.** Use a restart loop like OpenCode's "keep grinding" prompt, so the agent does not stop at minute 12 with a summary.

### 6.3 Ideas for harder evals

All of these use the same Harbor task format, so `generate-tasks.ts` can be extended with new `VariantTask` entries.

- **Total-XP or sustained-rate variant**: score the XP gained over the horizon, or the median 15 s rate over the last 10 minutes. This removes the quest and burst lumps and tests steady automation.
- **Quest-completion tasks**: "complete Dragon Slayer from a fresh account in 60 min". The verifier reads the quest varp in the `.sav` file, in the way `check_gold.ts` parses the save, and gives partial credit by quest stage.
- **Multi-skill or total-level tasks**: maximize total level, or reach N in skill A and M in skill B. These test planning across dependencies, such as Crafting needing gold, hides and a tanner.
- **Gold under constraints**: no alching, or start with no items. The gold tasks already exist, but no non-Anthropic model has run them.
- **Micro-tasks of 2–5 minutes**: "buy a knife", "get to Ardougne", "make one bronze bar". These are pass/fail with an oracle and resolve the noise and runtime limitation the author lists.
- **Unseen-world generalization**: hide `wiki/` and `learnings/`, or change NPC spawns and shop stock, so the agent must explore instead of recall.
- **Multi-agent supply chain**: two bots, one gathers and one processes, scored on a combined rate (from `Discussion.js`).
- **Knowledge transfer**: agent A writes a guide, and agent B's score with the guide is the metric (from `Discussion.js`).
- **Adversarial robustness**: random world events such as random-event NPCs, a crowded bank or a moved spawn, injected during the run.
- **Long horizon**: 2 h or more with checkpoints. The header of `generate-tasks.ts` already mentions 2 h gold. This tests whether the harness keeps its context and memory over a long run.
