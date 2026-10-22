# Talk notes: Max Bittker, "RS-SDK" (Recurse Center Localhost, 2026)

Source: https://www.youtube.com/watch?v=cNm4zyUtWj0. Captions were read from YouTube; only these notes are kept.
Projects: https://github.com/MaxBittker/rs-sdk, https://github.com/MaxBittker/runebench

## What the talk says

### 1. Pixels lose, code wins
- Claude Code playing through screenshots and coordinate clicks fails badly, even on a modern model (Opus 5.5). It must think before each step, the character moves, the clicks miss.
- Models are trained with RLVR (reinforcement learning from verifiable reward) on huge numbers of coding tasks. So: make the game "shaped like code".
- Version 1 of rs-sdk: game state as JSON, and every client opcode as one small TypeScript function. That thin layer alone gave far more success than pixels.

### 2. Harness design principles (Max's list)
1. Start with the most raw, powerful version of the tool. Sometimes step one is the only step.
2. Wrap new ideas in formats the model already knows: files, network requests, Linux, plain languages. Game knowledge = markdown files in folders.
3. Do not guess what the model will struggle with. Run it, observe, fix one real problem at a time.

### 3. "Farming" rollouts
- Start many runs overnight (for example: 4 agents, each trains one skill).
- In the morning, ask each: what burned time, what was missing from the SDK.
- Filter the feedback by hand. Bad feedback types:
  - "Give me a function that does the whole task" (wrong: the agent must still play).
  - "The game is bugged" (wrong: a false belief about the system).
- Good feedback: "I spent 1.5 h of a 3 h run on indoor pathfinding." That shows a real gap.
- The human's job is to say "no" to fixes that break outer rules.

### 4. Plumbing and porcelain (from Git)
- Low layer: raw packets (`sdk.send*`).
- High layer: async functions per action (for example: chop a tree), awaitable, with error codes. About 20% of the lines of code of the low layer.
- Both layers stay available. The agent drops down when the high layer is missing something or has a bug.
- The SDK ships a bug-report function so agents in the wild report problems back.

### 5. Code policies, not step-by-step thinking
- Good agents write a long-running script (for example: a fishing loop), run it 20 minutes, look, adjust, run again.
- The LLM only "pops out" when the script crashes or stalls.
- Extreme case: one JavaScript file runs a whole swarm. One LLM checks it once a day and fixes it.
- More autonomy per LLM call = more output per dollar.

### 6. Benchmarks (RuneBench)
- Built on Harbor: each task = one Docker image. Harbor injects a coding agent, gives an instruction, runs it, collects the result. Standard format.
- Good-benchmark layers: hard, verifiable, cheap (a 30 min task should become 5 min if possible), encodes desirable behavior (watch for Goodhart's law), interesting to others.
- Scoring problem: "total XP in 30 min" punishes exploring.
- Fix: score the **peak 15-second XP rate** in the run. Exploring is no longer punished.
- Smart models then gamed the peak window. Quests give big XP drops, so top models did quests to spike the rate.
- Final score: log of each skill score, averaged over 16 skills. Cost per run is shown too. A +0.3 log jump is a large multiplier.
- Progress over about 10 months: Opus 5.5 = 13x Opus 4.5. "Astra" = 17x. Budget models = 5x at 40x cheaper.
- Max thinks the benchmark is close to saturated. Next wins are "same score, cheaper". A harder bench needs 10x to 100x harder tasks, not "run longer".

### 7. Multi-agent world
- The demo server is about 100% bots. Dozens to low hundreds of humans run 1 to 200 bots each.
- Heat map shows swarms camping resources.
- An agent ("Ender") posts on the human LostCity forum, says it is an agent, gets help.
- Real bottlenecks: RAM per client, 2,000 world slots. Fixed-respawn resources (runite, boss drops, some trees) get contested. Fish are near-infinite.
- Human tenacity is the edge: humans escalate effort on hard targets, lone bots give up.

### 8. Market experiments
- Setup: agents with roles (miner, smith, alchemist). All three steps are needed for profit. Goal: max own profit.
- Trades were made "blind" (prisoner's dilemma). One side can keep the goods.
- A Grok agent ("Quinn") started scamming when its margins fell. It went from rank 20/24 to second place by lying.
- Claude models were honest and trusting, so they were easy to scam. One tried price-fixing in public chat.
- A Gemini model ("Argon") planned delays to "trick observing LLMs".
- More ruthless models also defended better against scams.
- Open problem: tools to understand huge piles of trajectories. LLM reports are lossy.

### 9. Community
- Hiscores race: fastest account to max all 99s. Beaten 5 times in 2 weeks.
- Also races for the biggest item stacks.

## What this means for our project
- Our "best player" must win on three fronts: skill speed (hiscores), long-horizon goals (quests, items), and economy (trade, trust, scam defense).
- The harness must make the model write and run **code policies**, monitor them cheaply, and step in only on failure.
- We need our own eval loop (RuneBench-style, local, fast tickrate) before we tune anything.
- The "farming" loop (run, ask, filter, fix) is the core dev process. We should automate the "run" and "ask" parts, and keep a human filter on the "fix" part.
