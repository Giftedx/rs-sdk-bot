# Phase 0–1: Practice Server and Knowledge Miner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command starts a local copy of the demo server on Windows, logs in preset bots, and proves a script N times in a row. A second command mines the rev 289 content into `knowledge/*.json` that a spot-check proves correct.

**Architecture:** A Bun workspace. `packages/practice` drives the vendored rs-sdk stack (engine, gateway, lite runner) as child processes and reuses rs-sdk's own `create-bot.ts` and `save-generator.ts`. `packages/knowledge` is pure parsing: content text in, JSON out, every record carrying its source `file:line`.

**Tech Stack:** TypeScript, Bun 1.3.14, `bun test`. rs-sdk at commit `b565f2d920bf6f5ec427bc6f66dc6fd64a2e15c1` in `vendor/rs-sdk`.

**Spec:** `docs/superpowers/specs/2026-10-22-rs-sdk-bot-harness-design.md` (Phases 0 and 1).

## Global Constraints

- Demo settings: `NODE_TICKRATE=300`, `NODE_XPRATE=25` (from `fly.toml`). Faster ticks are allowed for practice only.
- Game data revision 289 only. Read from `vendor/rs-sdk/server/content`, never `vendor/lostcity-content` at 274.
- Every bot env written by us has `TELEMETRY=false` and `SHOW_CHAT=false`.
- Gateway binds `GATEWAY_HOSTNAME=127.0.0.1`.
- Vendor clones use LF line endings (`core.autocrlf=false`). `create-bot.ts --local` breaks on CRLF (seen 2026-10-22).
- Do not edit files under `vendor/` from package code. Our rs-sdk changes go in `patches/rs-sdk.md`.
- Logs and runtime state go to `.practice/` (gitignored).
- The knowledge miner uses no LLM and no network.

## Review Focus

1. **A port is already in use** (8888, 7780, from a crashed run): `up` must fail fast with the port named, not hang for 180 s.
2. **A child process dies during start** (bad build, missing `data/pack`): `up` must report which service died and the last 20 log lines.
3. **A preset is written while the bot is logged in**: the engine overwrites the save on logout. `applyPreset` must refuse when the bot's lite runner is alive.
4. **Content files with CRLF or a trailing comment** (`stock1=a,1,5 // note`): parsers must strip `\r` and `//` comments.
5. **A map square with no NPC section, or an empty file**: `parseJm2` returns empty arrays, it does not throw.

---

### Task 1: Workspace and rs-sdk pin

**Files:**
- Create: `package.json`, `tsconfig.json`, `rs-sdk.pin`, `scripts/check-pin.ts`, `patches/rs-sdk.md`
- Modify: `.gitignore` (add `.practice/`, `knowledge/` stays committed)
- Test: `scripts/check-pin.test.ts`

**Interfaces:**
- Produces: `checkPin(vendorDir: string, pinFile: string): { ok: boolean; expected: string; actual: string }`

- [ ] **Step 1:** Write failing test `checkPin reports mismatch`: a temp git repo at a known commit, a pin file with another SHA → `ok === false`, both SHAs returned.
- [ ] **Step 2:** Run `bun test scripts/check-pin.test.ts`. Expected: FAIL, `checkPin` not defined.
- [ ] **Step 3:** Root `package.json`: `"workspaces": ["packages/*"]`, scripts `test: "bun test"`, `typecheck: "tsc --noEmit"`. `rs-sdk.pin` holds `b565f2d920bf6f5ec427bc6f66dc6fd64a2e15c1`. `checkPin` runs `git -C <vendorDir> rev-parse HEAD`. `patches/rs-sdk.md` lists: (1) LF checkout requirement, (2) `TELEMETRY=false` forced by our bot creation, (3) `staffmodlevel = 0` at `LoginThread.ts:60` left unpatched; presets come from `generateSave`.
- [ ] **Step 4:** Run `bun test scripts/check-pin.test.ts` and `bun scripts/check-pin.ts`. Expected: PASS, and `ok rs-sdk b565f2d9`.
- [ ] **Step 5:** Commit `chore: add bun workspace and rs-sdk pin`.

### Task 2: Practice stack start and stop

**Files:**
- Create: `packages/practice/package.json`, `src/paths.ts`, `src/ready.ts`, `src/ports.ts`, `src/stack.ts`
- Test: `packages/practice/test/ready.test.ts`, `test/ports.test.ts`

**Interfaces:**
- Produces:
  - `rsSdkRoot(): string` (absolute `vendor/rs-sdk`), `practiceDir(): string` (absolute `.practice`)
  - `type Service = 'engine' | 'gateway' | 'lite'`
  - `isReady(service: Service, line: string): boolean`. Ready lines, copied from real runs: engine `World ready`, gateway `Gateway running at`, lite `Gateway connected, registering as`.
  - `portInUse(port: number): Promise<boolean>`
  - `startStack(opts?: { tickMs?: number; xpRate?: number }): Promise<Stack>`. Defaults 300 and 25.
  - `interface Stack { stop(): Promise<void>; logs: Record<'engine' | 'gateway', string> }`
  - `stopStack(): Promise<void>` stops processes recorded in `.practice/pids.json`.

- [ ] **Step 1:** Failing tests: `isReady('engine', '... INFO\t World ready: Visit http://localhost:8888/rs2.cgi') === true`; `isReady('gateway', '[Gateway] Bot/SDK: ws://localhost:7780') === false`; `portInUse` true for a port held by a `Bun.listen` in the test, false after it closes.
- [ ] **Step 2:** Run `bun test packages/practice`. Expected: FAIL.
- [ ] **Step 3:** Implement. `startStack` checks ports 8888 and 7780 first and throws `port 8888 in use` (Review Focus 1). It spawns `bun run quickstart` in `server/engine` with `NODE_TICKRATE`/`NODE_XPRATE`, then `bun run gateway` in `server/gateway` with `GATEWAY_HOSTNAME=127.0.0.1`. stdout+stderr go to `.practice/logs/<service>.log`. It waits up to 180 s per ready line. If a child exits first, it throws `<service> exited with code N` plus the last 20 log lines (Review Focus 2). PIDs go to `.practice/pids.json`. On Windows, stop uses `taskkill /PID <pid> /T /F`, because killing the `bun run` parent does not end the child.
- [ ] **Step 4:** Run `bun test packages/practice`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(practice): start and stop local stack`.

### Task 3: Bots, presets and lite runners

**Files:**
- Create: `packages/practice/src/bots.ts`, `src/presets.ts`, `src/lite.ts`
- Test: `packages/practice/test/bots.test.ts`

**Interfaces:**
- Consumes: `rsSdkRoot()`, `practiceDir()`, `isReady('lite', …)`
- Produces:
  - `createBot(name: string): Promise<{ name: string; envPath: string }>`. It runs `bun bots/create-bot.ts <name> --local --no-chat` in rs-sdk, then rewrites `TELEMETRY=` to `false`. If the bot exists, it only enforces the two env values.
  - `startLite(name: string): Promise<LiteHandle>`, `interface LiteHandle { name: string; pid: number; stop(): Promise<void> }`. It waits for the lite ready line and records the PID in `.practice/lite.json`.
  - `isLiteRunning(name: string): boolean`
  - `applyPreset(name: string, preset: SaveConfig): Promise<string>`. It calls `generateSave` from `vendor/rs-sdk/sdk/test/utils/save-generator.ts` with cwd = rs-sdk root, and returns the save path. It throws `bot <name> is logged in` when `isLiteRunning(name)` (Review Focus 3).
  - `PRESETS: Record<string, SaveConfig>` with `fresh_lumbridge` (position 3222,3218, tutorial varp 281 set to done) and `wc_lumbridge` (same plus bronze axe in inventory).

- [ ] **Step 1:** Failing tests: `createBot('t_envfix')` leaves an env with `TELEMETRY=false`, `SHOW_CHAT=false`, `SERVER=localhost:8888` (no network needed). `applyPreset` throws when `.practice/lite.json` lists that bot with a live PID (use the test process's own PID).
- [ ] **Step 2:** Run `bun test packages/practice/test/bots.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Read the tutorial-done value for varp 281 from `save-generator.ts` or its callers in `sdk/test/` instead of guessing it.
- [ ] **Step 4:** Run the test. Expected: PASS. Delete the `t_envfix` bot folder in test teardown.
- [ ] **Step 5:** Commit `feat(practice): bots, presets, lite runners`.

### Task 4: Proving runner and CLI

**Files:**
- Create: `packages/practice/src/prove.ts`, `src/cli.ts`, `scripts/wc-loop.ts` (the Phase 0 proof script)
- Test: `packages/practice/test/prove.test.ts`, `packages/practice/test/stack.it.test.ts` (runs only when `PRACTICE_IT=1`)

**Interfaces:**
- Consumes: everything from Tasks 2 and 3
- Produces:
  - `prove(opts: { bot: string; script: string; runs: number; preset?: string; pass: (stdout: string) => boolean }): Promise<ProveReport>`
  - `interface ProveReport { runs: number; passes: number; results: { ok: boolean; seconds: number; tail: string }[] }`
  - CLI `bun packages/practice/src/cli.ts up [--tick N] | down | status | bot <name> | prove <bot> <script> <runs> [--preset P]`
  - `scripts/wc-loop.ts` prints `RESULT chops=<n> wcXpGained=<xp>`, as the 2026-10-22 spike did.

- [ ] **Step 1:** Failing unit test: `prove` with a fake script that prints `RESULT ok` on odd runs reports `passes` = ceil(runs/2). Inject the spawn function, so no game is needed.
- [ ] **Step 2:** Run `bun test packages/practice/test/prove.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Each run: stop the lite runner, apply the preset, start the lite runner, run `bun <script>` with cwd rs-sdk root and a 300 s timeout, record pass and fail. The default `pass` for wc-loop is `wcXpGained` > 0.
- [ ] **Step 4:** Run the unit test. Expected: PASS. Then run the integration test: `PRACTICE_IT=1 bun test packages/practice/test/stack.it.test.ts`, which does `up` and `prove practice1 scripts/wc-loop.ts 10 --preset wc_lumbridge`, then `down`. Expected: `passes: 10`. **This is the Phase 0 done-check.**
- [ ] **Step 5:** Commit `feat(practice): proving runner and CLI`.

### Task 5: Content readers (packs, configs, maps)

**Files:**
- Create: `packages/knowledge/package.json`, `src/paths.ts`, `src/text.ts`, `src/pack.ts`, `src/config.ts`, `src/jm2.ts`
- Test: `packages/knowledge/test/readers.test.ts`

**Interfaces:**
- Produces:
  - `contentRoot(): string` (absolute `vendor/rs-sdk/server/content`)
  - `cleanLines(text: string): string[]` strips `\r` and `//` comments, keeps line numbers by returning `''` for removed lines (Review Focus 4)
  - `parsePack(text: string): Map<number, string>` for `id=name` lines
  - `interface ConfigBlock { name: string; props: Record<string, string[]>; file: string; line: number }` (a key may repeat, so values are arrays)
  - `parseConfigs(text: string, file: string): ConfigBlock[]` for `[name]` and `key=value` blocks
  - `listConfigFiles(ext: string): string[]` uses the same file set the engine pack tool loads (`tools/pack/PackFile.ts` `loadDirExtFull`)
  - `interface Spawn { id: number; x: number; z: number; level: number; src: string }`
  - `parseJm2(fileName: string, text: string): { npcs: Spawn[]; locs: (Spawn & { shape: number; angle: number })[]; objs: (Spawn & { count: number })[] }`. World coords: file `m<MX>_<MZ>.jm2`, x = MX*64 + localX, z = MZ*64 + localZ. Lines: NPC `level x z: id`, LOC `level x z: id shape angle`, OBJ `level x z: id count`.

- [ ] **Step 1:** Failing tests:
  - `parseJm2('m35_74.jm2', '==== NPC ====\n0 30 23: 1070\n')` → npc `{id:1070, x:2270, z:4759, level:0}`
  - LOC line `0 14 6: 3738 10 3` → `shape 10, angle 3`
  - empty text → three empty arrays (Review Focus 5)
  - `parseConfigs('[knife]\nname=Knife\ncost=6\n', 'f.obj')` → `props.cost[0] === '6'`
  - `cleanLines('a=1 // c\r\n')[0] === 'a=1'`
- [ ] **Step 2:** Run `bun test packages/knowledge`. Expected: FAIL.
- [ ] **Step 3:** Implement. For `listConfigFiles`, read `loadDirExtFull` in `server/engine/src` or `tools`, and mirror its rules for which `_unpack/<rev>` folders count.
- [ ] **Step 4:** Run the tests, plus the real-data check `every name in pack/obj.pack appears in parseConfigs over listConfigFiles('.obj')`. Expected: PASS, 0 missing names.
- [ ] **Step 5:** Commit `feat(knowledge): content readers`.

### Task 6: Knowledge build (items, NPCs, spawns, shops, transports)

**Files:**
- Create: `packages/knowledge/src/build.ts`, `src/items.ts`, `src/npcs.ts`, `src/shops.ts`, `src/transports.ts`
- Create (generated, committed): `knowledge/items.json`, `knowledge/npcs.json`, `knowledge/shops.json`, `knowledge/transports.json`, `knowledge/BUILD.md`
- Test: `packages/knowledge/test/build.test.ts`

**Interfaces:**
- Consumes: Task 5 readers
- Produces (JSON shapes, all with `src: "path:line"` relative to the content root):
  - `items.json`: `{ id, name, debugname, cost, members, tradeable, src }[]`. `cost` is the static value the Equipment and Bank boards score.
  - `npcs.json`: `{ id, name, debugname, combat, spawns: {x,z,level,src}[], src }[]`
  - `shops.json`: `{ inv, file, stock: { item, count, restockTicks }[], src }[]` from `stockN=item,count,restock` lines in `.inv` files
  - `transports.json`: `{ locName, from: {x,z,level}, to: {x,z,level}, option: 'op1', src }[]`. These are the ladder and stair edges. They are computed from each loc spawn plus the `p_teleport(movecoord(coord, dx, dlevel, dz))` or `~climb_ladder(movecoord(coord(), dx, dlevel, dz), …)` offsets in `scripts/ladders+stairs/scripts/*.rs2`. Each `switch_int (loc_angle)` case maps that angle to its offset. A handler the parser cannot read is listed in `BUILD.md` as skipped, never guessed.
  - `bun packages/knowledge/src/build.ts` writes all files and prints counts.

- [ ] **Step 1:** Failing tests on small inline fixtures:
  - an `.inv` with `stock1=dragon_battleaxe,2,500` gives `{item:'dragon_battleaxe',count:2,restockTicks:500}`
  - the `shipladder_angled` handler text from `ladders.rs2`, with a loc at (3000,3000,0) angle 1, gives `to (3002,3000,1)`
  - an unknown handler shape is reported as skipped
- [ ] **Step 2:** Run `bun test packages/knowledge`. Expected: FAIL.
- [ ] **Step 3:** Implement and run `bun packages/knowledge/src/build.ts`. The item count must equal the line count of `pack/obj.pack`, and the NPC count must equal `pack/npc.pack`.
- [ ] **Step 4:** Run the tests. Expected: PASS. The build prints counts, and `BUILD.md` lists the skipped handlers.
- [ ] **Step 5:** Commit `feat(knowledge): build items, npcs, shops, transports`.

### Task 7: Spot-check (Phase 1 done-check)

**Files:**
- Create: `packages/knowledge/src/spotcheck.ts`
- Test: `packages/knowledge/test/spotcheck.test.ts`

**Interfaces:**
- Consumes: `knowledge/*.json`
- Produces: `spotcheck(n: number, seed: number): { checked: number; wrong: { fact: string; src: string; line: string }[] }`. It picks n random records across all four files. For each, it re-reads the `src` line from content and asserts the line contains the fact's raw value (the id, the cost, the coordinate or the stock entry).

- [ ] **Step 1:** Failing test: a record with a deliberately wrong `cost` and a real `src` is reported in `wrong`.
- [ ] **Step 2:** Run `bun test packages/knowledge/test/spotcheck.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Run `bun packages/knowledge/src/spotcheck.ts 50 1`.
- [ ] **Step 4:** Expected: `checked 50, wrong 0`. **This is the Phase 1 done-check** for the categories built here.
- [ ] **Step 5:** Commit `feat(knowledge): spot-check`.

## Out of scope for this plan (next plan: Phase 1b)

Drop tables (RuneScript `random(128)` chains), quest stages and varps, XP values per action (tenths), and door state. These need a RuneScript-aware reader. Phase 2's world graph needs only `transports.json` from this plan.
