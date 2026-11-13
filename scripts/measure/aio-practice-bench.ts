// AIO practice-server benchmark & optimization harness.
// Starts the native 150 ms / 25x practice stack in-process, runs each AIO dispatcher route
// through proveInProcess (START-matched preset + RESULT ok + outcome tail), compares wall time
// against the equivalent direct worker, and verifies save outcomes (XP / items / quest flags).
//
// Usage (from repo root):
//   bun scripts/measure/aio-practice-bench.ts
// Cases come from aio-bench-cases.ts, one per AIO catalog route. AIO_BENCH_COVERAGE lists the routes with no case.
// Prints AIO_BENCH_RESULT JSON lines per case + AIO_BENCH_SUMMARY, and writes the rows to BENCH_OUT. Exit 0 iff every case passes.
// Env: BENCH_RUNS (per-case runs, default 1), BENCH_TIMEOUT_MS (per-run timeout, default 600000),
// BENCH_ONLY (regex on the case key), BENCH_CONCURRENCY (cases at once, default 1; above 1 the cases share NPCs
// and rocks, so use it to find which cases pass, not to compare ticks), BENCH_COVERAGE_ONLY (print coverage and stop).
//
// Only openBot (in-process) routes run here: proveInProcess runs workers via
// realInProcessDeps with cwd = repo root (see prove.ts REPO_ROOT), which is the
// cwd the swarm supervisor and chain.ts use. Lite-runner scripts (runScript,
// e.g. wc-loop.ts) need the lite harness (prove(), cwd vendor/rs-sdk for
// join(cwd, 'bots', ...) in vendor runner.ts) and are deliberately excluded.
// Woodcut-supply and similar library-only workers (no import.meta.main) are
// benched via aio-skiller bank-job JSON profiles, which is their supported
// process boundary (direct in-process runBankJob).
//
// Shop cases are excluded: Hickton's shop stock is shared engine state across
// sequential bench cases, so a direct-vs-AIO comparison is confounded by
// restock waits (idle 38-66% in both workers). Quest and bank-trip cases use
// per-account bank/pack/equipment and are comparable on a shared stack.
// Boss/pvp/market/logistics readiness is benched offline (planner timing)
// because their live setups (kits, duel targets, GE intents, coop accounts)
// need multi-account fixtures the single-account bench cannot stage.
//
// localhost quirk: in this Windows sandbox `localhost` resolves to ::1 first
// while the practice engine listens on IPv4 only, so fetch('http://localhost:8888/crc')
// resets. Bench bots are therefore pinned to 127.0.0.1 after createBot.
import {startStack} from '../../packages/practice/src/stack';
import {proveInProcess} from '../../packages/practice/src/prove';
import {createBot} from '../../packages/practice/src/bots';
import {applyPreset, PRESETS} from '../../packages/practice/src/presets';
import {benchCases, benchCoverage, rivalTicks, BENCH_JOB_FILES, SMOKE_KEYS, type BenchCase} from './aio-bench-cases';
import {FISHING_BENCH_CASES} from './fishing-bench-cases';
import {practiceDir, rsSdkRoot} from '../../packages/practice/src/paths';
import {readFileSync, writeFileSync, rmSync, mkdirSync, existsSync, watch} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join, resolve} from 'node:path';
import {FREE_FLOOR_GB} from '../../packages/core/src/memory';
import {freeGB, unitsThatFit} from '../heavy-admission';
import {BENCH_CASE_GB, START_REFUSED_EXIT, admitStart} from './bench-start-check';
import {BUDGET_EXIT, BUDGET_MIN, budgetRefusal, estimateRun, parseAckStats, parseSimStat, readElapsed, readSince, recordElapsed} from './bench-budget';
import {
  discoverBankedProduction,
  planProgressiveSkiller,
  planAutoFighterBand,
  assessBossReadiness,
  pvpCombatBracket,
  assessTribridReadiness,
  assessQuestReadiness,
  prioritizeQuestsForAccount,
  planGeRestockOrders,
  planFleetDistribution,
  resolveAioStep,
} from '../aio';

const root = resolve(import.meta.dir, '..', '..');

// Command line: `bun run bench [pattern] [--smoke] [--all] [--seed n] [--parallel n] [--set KEY=value]... [--save-baseline]
// [--no-keep] [--wall-clock] [--wait minutes] [--force]`. A pattern is a regular expression on the case key ("cook", "^quester:quest:").
// The defaults give comparable numbers with nothing to remember: the lockstep engine, a fresh engine per case, seed 7,
// kept results, and one engine per 1.5 GiB of free memory above the 4 GiB reserve (at most 6).
// --set changes one environment setting for the workers (an A/B run); the table at the end shows each case against
// the stored baseline. --wall-clock runs the 150 ms engine with one shared world instead.
// Before its first engine the run does the start check (bench-start-check.ts): it stops with one line and exit code 2
// beside another heavy job, on a used engine port, or with too little free memory. --wait <minutes> waits for a safe
// start for that long at most, and --force skips the check.
// Time budget (scripts/measure/bench-budget.ts): a run is at most --budget <minutes> (default 10). The run estimates
// its wall time from the last time of each case, refuses a selection over the budget before its first engine (exit
// code 3, with the heaviest cases), and starts no case after the deadline. --over-budget runs it anyway. --seeds gives
// each seed an equal share. --profile runs one engine with no kept results and prints AIO_BENCH_PROFILE for each case: engine start,
// startup and game wait of the engine, ticks the client held, ticks capped at SIM_BUSY_MS, and client time.
const SET_KEYS: string[] = [];
if (import.meta.main) {
  const argv = process.argv.slice(2), env = process.env;
  const value = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
  const has = (flag: string) => { const i = argv.indexOf(flag); if (i < 0) return false; argv.splice(i, 1); return true; };
  for (let set = value('--set'); set !== undefined; set = value('--set')) {
    const at = set.indexOf('=');
    if (at < 1) throw new Error(`--set needs KEY=value, got ${set}`);
    env[set.slice(0, at)] = set.slice(at + 1);
    SET_KEYS.push(set.slice(0, at));
  }
  // The start check reads these in each run, and a run that --watch or --seeds starts gets them with the environment.
  if (argv.includes('--wait')) {
    const wait = value('--wait');
    if (!(Number(wait) >= 0)) throw new Error(`--wait needs minutes, got ${wait}`);
    env.BENCH_WAIT_MIN = wait;
  }
  if (has('--force')) env.BENCH_FORCE = '1';
  if (argv.includes('--budget')) {
    const budget = value('--budget');
    if (!(Number(budget) > 0)) throw new Error(`--budget needs minutes, got ${budget}`);
    env.BENCH_BUDGET_MIN = budget;
  }
  if (has('--over-budget')) env.BENCH_OVER_BUDGET = '1';
  // A kept result runs nothing, so a profile reads no kept result.
  if (has('--profile')) { env.BENCH_PROFILE = '1'; env.BENCH_PARALLEL = '1'; env.BENCH_CACHE = '0'; }
  // --watch runs the selection, then runs it again each time a file under scripts/ or packages/ changes.
  if (has('--watch')) {
    const run = () => Bun.spawnSync(['bun', import.meta.path, ...process.argv.slice(2).filter(a => a !== '--watch')], { cwd: root, env, stdout: 'inherit', stderr: 'inherit', windowsHide: true });
    for (;;) {
      run();
      console.log('\nwatching scripts/ and packages/ for a change (Ctrl+C ends)');
      await new Promise<void>(done => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const watchers = ['scripts', 'packages'].map(dir => watch(resolve(root, dir), { recursive: true }, (_event, file) => {
          if (!file || !/\.(ts|json)$/.test(String(file)) || /node_modules/.test(String(file))) return;
          clearTimeout(timer);
          timer = setTimeout(() => { for (const w of watchers) w.close(); done(); }, 400);
        }));
      });
    }
  }
  // --seeds 7,8,9 runs the same selection once for each seed and prints one row per case: how many seeds pass and the
  // tick count at each. A case that passes at some seeds and fails at others depends on a random roll it cannot recover from.
  // Each child gets every --set again: the setting is part of the key of a kept result, so a child with no --set
  // would print the kept result of the run without the setting.
  const seeds = value('--seeds');
  if (seeds) {
    const list = seeds.split(',').map(Number);
    if (!list.length || list.some(n => !Number.isSafeInteger(n))) throw new Error(`--seeds needs integers, got ${seeds}`);
    const table = new Map<string, string[]>();
    // Each seed gets an equal share of the budget.
    env.BENCH_BUDGET_MIN = String(Number(env.BENCH_BUDGET_MIN ?? BUDGET_MIN) / list.length);
    for (const one of list) {
      const out = `.practice/aio-bench/seed-${one}.json`;
      const child = Bun.spawnSync(['bun', import.meta.path, ...argv, '--seed', String(one), ...SET_KEYS.flatMap(k => ['--set', `${k}=${env[k]}`])], { cwd: root, env: { ...env, BENCH_OUT: out }, stdout: 'ignore', stderr: 'inherit', windowsHide: true });
      if (child.exitCode === BUDGET_EXIT) process.exit(BUDGET_EXIT);
      if (child.exitCode !== 0 && child.exitCode !== 1) throw new Error(`seed ${one}: bench exited with code ${child.exitCode}`);
      for (const r of JSON.parse(readFileSync(resolve(root, out), 'utf8')).rows as { case: string; ok: boolean; ledgerTicks: number[] }[]) {
        table.set(r.case, [...(table.get(r.case) ?? []), r.ok ? String(r.ledgerTicks.at(-1) ?? '?') : 'FAIL']);
      }
    }
    const rows = [...table].sort(([a], [b]) => a.localeCompare(b)).map(([key, cells]) => [key, `${cells.filter(c => c !== 'FAIL').length}/${list.length}`, ...cells]);
    const head = ['case', 'pass', ...list.map(n => `seed ${n}`)];
    const width = head.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? '').length)));
    const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(width[i]!) : c.padStart(width[i]!))).join('  ');
    console.log([line(head), line(width.map(w => '-'.repeat(w))), ...rows.map(line)].join('\n'));
    const weak = rows.filter(r => r[1] !== `${list.length}/${list.length}`).map(r => `${r[0]} ${r[1]}`);
    console.log(weak.length ? `\nnot passing at every seed: ${weak.join(', ')}` : `\nevery case passes at every seed`);
    process.exit(weak.length ? 1 : 0);
  }
  const seed = value('--seed'), parallel = value('--parallel');
  if (has('--smoke')) env.BENCH_SMOKE = '1';
  if (has('--all')) env.BENCH_ALL = '1';
  if (has('--save-baseline')) env.BENCH_SAVE_BASELINE = '1';
  if (has('--no-keep')) env.BENCH_CACHE = '0';
  if (has('--coverage')) env.BENCH_COVERAGE_ONLY = '1';
  const wallClock = has('--wall-clock') || env.BENCH_LOCKSTEP === '0';
  if (argv.length > 1 || argv[0]?.startsWith('--')) throw new Error(`unknown arguments: ${argv.join(' ')}`);
  if (argv[0]) env.BENCH_ONLY = argv[0];
  if (wallClock) { env.BENCH_LOCKSTEP = '0'; env.BENCH_FRESH ??= '0'; }
  else {
    env.BENCH_LOCKSTEP = '1';
    env.BENCH_FRESH ??= '1';
    env.BENCH_SEED = seed ?? env.BENCH_SEED ?? '7';
    if (env.BENCH_FRESH === '1') env.BENCH_PARALLEL = parallel ?? env.BENCH_PARALLEL ?? String(unitsThatFit(6, BENCH_CASE_GB, freeGB(), FREE_FLOOR_GB));
  }
}

const RUNS = Number(process.env.BENCH_RUNS ?? 1);
const TIMEOUT = Number(process.env.BENCH_TIMEOUT_MS ?? 600_000);
const CONCURRENCY = Math.max(1, Number(process.env.BENCH_CONCURRENCY ?? 1));
const ONLY = process.env.BENCH_ONLY ? new RegExp(process.env.BENCH_ONLY) : undefined;
const OUT = process.env.BENCH_OUT ?? '.practice/aio-bench/last.json';
// BENCH_LOCKSTEP=1 runs the lockstep engine; BENCH_SEED (default 1) seeds its random rolls from each bench login.
const LOCKSTEP = process.env.BENCH_LOCKSTEP === '1';
const SEED = Number(process.env.BENCH_SEED ?? 1);
// BENCH_FRESH=1 starts a new engine for each case, so one case cannot change the world the next case meets.
// BENCH_TRACE=<dir> writes two lockstep engine files for each case there (needs BENCH_FRESH=1): <case>.trace, the
// per-tick world hash, and <case>.actions, what the engine did with each message from a bot.
const FRESH = process.env.BENCH_FRESH === '1';
// BENCH_PARALLEL=<n> (with BENCH_FRESH=1) runs n cases at once, each on its own engine and ports. One case uses
// about 1.5 GB; the cases share no world, so their ticks stay the same as in a serial run.
const PARALLEL = Math.max(1, Number(process.env.BENCH_PARALLEL ?? 1));
const SLOT_PORT = Number(process.env.BENCH_PORT_BASE ?? 21000);
const TRACE_DIR = process.env.BENCH_TRACE;

// Kept results: a lockstep case on a fresh engine with one seed gives the same row each time, so the row is stored
// under a hash of everything that can change it: the seed, the case, its preset, the Q_* environment, the vendor
// patch, and the content of the worker script with every file it imports by a relative path. A data file a worker
// reads at run time (knowledge/, vendor content) is not in the hash: use BENCH_CACHE=0 after such a change.
const CACHE = FRESH && LOCKSTEP && process.env.BENCH_CACHE !== '0';
const CACHE_DIR = '.practice/aio-bench/cache';
function importClosure(entry: string, seen = new Set<string>()): Set<string> {
  const file = resolve(root, entry);
  if (seen.has(file) || !existsSync(file)) return seen;
  seen.add(file);
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const base = resolve(dirname(file), m[1]!);
    for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
      if (existsSync(candidate) && !candidate.endsWith(dirname(candidate))) { if (/\.(ts|js|json)$/.test(candidate)) importClosure(candidate, seen); break; }
    }
  }
  return seen;
}
// The start check and the run both ask for the hash of a case, so one run computes it once.
const caseHashes = new Map<string, string>();
function caseHash(c: BenchCase): string {
  let hash = caseHashes.get(c.key);
  if (!hash) caseHashes.set(c.key, hash = computeCaseHash(c));
  return hash;
}
function computeCaseHash(c: BenchCase): string {
  let worker = c.script;
  const category = /aio-([a-z]+)\.ts$/.exec(c.script)?.[1];
  if (category) { try { worker = resolveAioStep(category, c.scriptArgs).script; } catch { /* a dispatcher-only case hashes the dispatcher */ } }
  const h = createHash('sha256');
  h.update(JSON.stringify({ seed: SEED, key: c.key, script: c.script, args: c.scriptArgs, preset: c.presetConfig ?? PRESETS[c.preset], runs: RUNS,
    env: Object.entries(process.env).filter(([k]) => k.startsWith('Q_') || k === 'SIM_BUSY_MS' || SET_KEYS.includes(k)).sort() }));
  h.update(readFileSync(resolve(root, 'patches/rs-sdk-working.patch')));
  for (const file of [...new Set([...importClosure(c.script), ...importClosure(worker)])].sort()) { h.update(file.slice(root.length)); h.update(readFileSync(file)); }
  return h.digest('hex').slice(0, 32);
}

function pinLoopbackToIpv4(envPath: string, enginePort = 8888) {
  const text = readFileSync(envPath, 'utf8');
  const next = text
    .replace(/^SERVER=.*$/gm, `SERVER=127.0.0.1:${enginePort}`)
    .replace(/^GATEWAY_URL=.*$/gm, 'GATEWAY_URL=ws://127.0.0.1:7780');
  if (next !== text) writeFileSync(envPath, next);
}

function benchPlanners() {
  const rows: unknown[] = [];
  const time = (label: string, fn: () => unknown) => {
    const t0 = performance.now();
    const out = fn();
    const ms = performance.now() - t0;
    rows.push({ label, ms: Number(ms.toFixed(2)), ok: true });
    return out;
  };

  const bank = { 383: 100, 2357: 10, 1607: 10, 1592: 1, 436: 15, 438: 15, 1593: 20, 1609: 20 };
  time('discoverBankedProduction', () => discoverBankedProduction({ Cooking: 80, Crafting: 50, Fletching: 60, Smithing: 40 }, bank, { reserve: 5 }));
  for (const skill of ['firemaking', 'woodcutting', 'fishing', 'cooking', 'agility', 'thieving', 'prayer', 'runecraft']) {
    time(`planProgressiveSkiller:${skill}`, () => planProgressiveSkiller(skill, 1, 99));
  }
  time('planAutoFighterBand:chicken', () => planAutoFighterBand({ Attack: 1, Strength: 1, Defence: 1, Hitpoints: 10 }));
  time('planAutoFighterBand:cow', () => planAutoFighterBand({ Attack: 20, Strength: 20, Defence: 20, Hitpoints: 25 }));
  time('planAutoFighterBand:giant', () => planAutoFighterBand({ Attack: 40, Strength: 40, Defence: 40, Hitpoints: 42 }));
  time('assessBossReadiness:kbd', () => assessBossReadiness('kbd', { skills: { Attack: 99, Defence: 40 }, ownedItems: { 1333: 1 } }));
  time('assessBossReadiness:trawler', () => assessBossReadiness('trawler', { skills: { Fishing: 20 }, ownedItems: { 954: 1, 1941: 30, 583: 1 } }));
  time('pvpCombatBracket:126@20', () => pvpCombatBracket({ Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Prayer: 99, Ranged: 99, Magic: 99 }, 20));
  time('assessTribridReadiness:empty', () => assessTribridReadiness({}));
  time('assessQuestReadiness:cook', () => assessQuestReadiness('cook', { 1944: 1, 1927: 1, 1933: 1 }));
  time('prioritizeQuestsForAccount:73quests', () => prioritizeQuestsForAccount({ 1944: 1, 1927: 1, 1933: 1 }, new Set()));
  time('planGeRestockOrders', () => planGeRestockOrders({
    actor: 'OreElse', server: 'rs-sdk-demo.fly.dev', goalPrefix: 'pvp-restock',
    shortfalls: { 385: { quantity: 20, limitPrice: 1200 }, 1333: { quantity: 1, limitPrice: 30000 } },
    coinsAvailable: 30000, coinReserve: 1000,
  }));
  time('planFleetDistribution', () => planFleetDistribution(
    [{ account: 'Moneyshot', held: 100000, reserve: 10000 }],
    [{ account: 'OreElse', held: 5000, target: 45000 }, { account: 'Shaftmaker', held: 0, target: 60000 }],
  ));
  console.log(`AIO_BENCH_PLANNERS ${JSON.stringify({ rows })}`);
  return rows;
}

// The stored baseline: the tick count of each case at one seed, written by --save-baseline. A run prints each case
// beside it, so a change shows as a tick difference with no file to compare by hand.
const baselineFile = () => `.practice/aio-bench/baseline-seed${SEED}.json`;
type Row = { case: string; ok: boolean; ledgerTicks: number[]; rivalTicks: number | null; output?: number | null; xp?: number | null; result: string | null };
function report(rows: Row[]) {
  const baseline: Record<string, { ok: boolean; ticks: number | null; output?: number | null; xp?: number | null }> = existsSync(baselineFile()) ? JSON.parse(readFileSync(baselineFile(), 'utf8')) : {};
  const ticks = (r: Row) => r.ledgerTicks.at(-1) ?? null;
  const lines = [...rows].sort((a, b) => a.case.localeCompare(b.case)).map(r => {
    const now = ticks(r), base = baseline[r.case];
    const delta = !r.ok ? 'FAIL' : !base ? 'new' : !base.ok ? 'was failing' : now === null || base.ticks === null ? '' : now === base.ticks ? '=' : `${now < base.ticks ? '' : '+'}${now - base.ticks} (${(((now - base.ticks) / base.ticks) * 100).toFixed(1)}%)`;
    // Amount for each 1,000 ticks, and its change against the baseline: the speed of a case that ends at its cap.
    const per = (amount: number | null | undefined, t: number | null | undefined) => (amount != null && t ? (amount * 1000) / t : null);
    const rate = per(r.output, now), baseRate = per(base?.output, base?.ticks);
    const rateCell = rate === null ? '-' : `${rate.toFixed(1)}${baseRate ? ` (${rate >= baseRate ? '+' : ''}${(((rate - baseRate) / baseRate) * 100).toFixed(1)}%)` : ''}`;
    // XP over all skills for each 1,000 ticks: one speed number for every case, with no pattern for each case.
    const xpRate = per(r.xp || null, now), baseXpRate = per(base?.xp || null, base?.ticks);
    const xpCell = xpRate === null ? '-' : `${Math.round(xpRate)}${baseXpRate ? ` (${xpRate >= baseXpRate ? '+' : ''}${(((xpRate - baseXpRate) / baseXpRate) * 100).toFixed(1)}%)` : ''}`;
    return [r.case, r.ok ? 'pass' : 'FAIL', now ?? '-', base?.ticks ?? '-', delta, rateCell, xpCell, r.rivalTicks ?? '-'].map(String);
  });
  const head = ['case', 'result', 'ticks', 'baseline', 'change', 'per 1k ticks', 'xp per 1k', 'rival'];
  const width = head.map((h, i) => Math.max(h.length, ...lines.map(l => l[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(width[i]!) : c.padStart(width[i]!))).join('  ');
  console.log(['', line(head), line(width.map(w => '-'.repeat(w))), ...lines.map(line)].join('\n'));
  const both = rows.filter(r => r.ok && baseline[r.case]?.ok && ticks(r) !== null && baseline[r.case]!.ticks !== null);
  if (both.length) {
    const now = both.reduce((n, r) => n + ticks(r)!, 0), base = both.reduce((n, r) => n + baseline[r.case]!.ticks!, 0);
    console.log(`\n${both.length} cases pass in both: ${now} ticks against baseline ${base} (${now <= base ? '' : '+'}${now - base}, ${(((now - base) / base) * 100).toFixed(2)}%)${SET_KEYS.length ? ` with ${SET_KEYS.map(k => `${k}=${process.env[k]}`).join(' ')}` : ''}`);
  }
  const broke = rows.filter(r => !r.ok && baseline[r.case]?.ok).map(r => r.case);
  if (broke.length) console.log(`BROKEN against baseline: ${broke.join(', ')}`);
  if (process.env.BENCH_SAVE_BASELINE === '1') {
    for (const r of rows) baseline[r.case] = { ok: r.ok, ticks: ticks(r), ...(r.output != null ? { output: r.output } : {}), ...(r.xp != null ? { xp: r.xp } : {}) };
    writeFileSync(baselineFile(), JSON.stringify(Object.fromEntries(Object.entries(baseline).sort()), null, 1));
    console.log(`baseline saved: ${rows.length} cases in ${baselineFile()}`);
  }
}

// Where the wall time of the last case went, for AIO_BENCH_TIMING.
const phase = { prepareMs: 0, scriptMs: 0, cleanupMs: 0 };
const timed = async <T>(key: keyof typeof phase, work: () => Promise<T>): Promise<T> => { const t = Date.now(); try { return await work(); } finally { phase[key] += Date.now() - t; } };

async function runCase(c: BenchCase, bot: string, enginePort = 8888) {
  const t0 = Date.now();
  phase.prepareMs = phase.scriptMs = phase.cleanupMs = 0;
  const bulkReady = new Set<string>();
  // proveInProcess checks the START line against the named preset's tile, so a case fixture is registered under its own name.
  const presetName = c.presetConfig ? `bench:${c.key}` : c.preset;
  if (c.presetConfig) PRESETS[presetName] = c.presetConfig;
  const r = await proveInProcess(
    { bot, script: c.script, runs: RUNS, preset: presetName, scriptArgs: c.scriptArgs, pass: c.pass, timeoutMs: c.timeoutMs ?? TIMEOUT,
      ...(c.companions ? { companions: c.companions.map(k => ({ suffix: k.suffix, preset: k.preset })) } : {}) },
    {
      prepare: (name, preset) => timed('prepareMs', async () => {
        // A partner account is `<bot><suffix>`; it takes its own start state, never the main account's fixture.
        const partner = name === bot ? undefined : c.companions?.find(k => name.endsWith(k.suffix) && preset === k.preset);
        const conf = partner ? partner.presetConfig ?? PRESETS[partner.preset] : c.presetConfig ?? PRESETS[preset!];
        if (!conf) throw new Error(`unknown preset ${preset}`);
        // A case with many accounts (a spar batch has 32): the account folders are made 8 at a time and every save in
        // one process. One account at a time is two process starts each, 9 s for 32 accounts.
        const everyConf = [conf, ...(c.companions ?? []).map(k => k.presetConfig ?? PRESETS[k.preset])];
        // applyPreset writes the varps above 308 itself; a case that sets one keeps the one-account path.
        const plain = everyConf.every(x => x && !Object.keys(x.varps ?? {}).some(k => Number(k) >= 309));
        if (name === bot && (c.companions?.length ?? 0) >= 4 && plain) {
          const all = [{ name: bot, conf }, ...c.companions!.map(k => ({ name: bot + k.suffix, conf: k.presetConfig ?? PRESETS[k.preset]! }))];
          const missing = all.filter(a => !existsSync(join(rsSdkRoot(), 'bots', a.name, 'bot.env')));
          for (let i = 0; i < missing.length; i += 8) await Promise.all(missing.slice(i, i + 8).map(a =>
            Bun.spawn(['bun', 'bots/create-bot.ts', a.name, '--local', '--no-chat'], { cwd: rsSdkRoot(), stdout: 'ignore', stderr: 'ignore', windowsHide: true }).exited));
          const code = `import { generateSave } from './sdk/test/utils/save-generator.ts';
for (const a of JSON.parse(await Bun.file(process.env.BULK_FILE).text())) await generateSave(a.name, a.conf);
console.log('SAVES_DONE');`;
          const bulk = resolve('.practice/aio-bench', `bulk-${bot}.json`);
          mkdirSync(dirname(bulk), { recursive: true });
          writeFileSync(bulk, JSON.stringify(all));
          const made = Bun.spawnSync(['bun', '-e', code], { cwd: rsSdkRoot(), env: { ...process.env, BULK_FILE: bulk }, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
          rmSync(bulk, { force: true });
          if (made.stdout.toString().includes('SAVES_DONE')) for (const a of all) bulkReady.add(a.name);
        }
        const account = await createBot(name);
        if (!bulkReady.has(name)) await applyPreset(name, conf);
        pinLoopbackToIpv4(account.envPath, enginePort);
      }),
      run: (script, name, timeoutMs, args = []) => timed('scriptMs', async () => {
        // A case can name the account of this run, a partner and the save file in its arguments and job files.
        const fill = (text: string) => text.replaceAll('{bot}', name).replace(/\{bot:(\w)\}/g, (_all, suffix) => name + suffix)
          .replaceAll('{save}', `vendor/rs-sdk/server/engine/data/players/main/${name.toLowerCase()}.sav`);
        for (const [path, value] of Object.entries(c.jobFiles ?? {})) { mkdirSync(dirname(fill(path)), { recursive: true }); writeFileSync(fill(path), fill(JSON.stringify(value, null, 1))); }
        const proc = Bun.spawn(['bun', resolve(script), name, ...args.map(fill)], { cwd: root, stdout: 'pipe', stderr: 'pipe', windowsHide: true, env: { ...process.env } }); // Bun.spawn does not pass env set at run time unless given
        // An AIO dispatcher owns a worker child; a timeout must stop the whole tree or the worker keeps its session.
        const timer = setTimeout(() => {
          if (process.platform === 'win32') Bun.spawn(['taskkill', '/PID', String(proc.pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true });
          else proc.kill();
        }, timeoutMs);
        const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        const exitCode = await proc.exited;
        clearTimeout(timer);
        // The whole output of the last run of each case, for a failure the tail does not explain.
        mkdirSync('.practice/aio-bench/output', { recursive: true });
        writeFileSync(`.practice/aio-bench/output/${c.key.replace(/[^a-z0-9-]/gi, '_')}.log`, out + err);
        return { stdout: out + err, exitCode };
      }),
      cleanup: name => timed('cleanupMs', async () => {
        rmSync(join(rsSdkRoot(), 'bots', name), { recursive: true, force: true });
      }),
    },
  );
  const elapsedMs = Date.now() - t0;
  const ok = r.passes === RUNS;
  const tail = r.results.map(x => x.tail).join('\n---\n');
  const ledgerTicks = [...tail.matchAll(/^LEDGER ticks=(\d+)/gm)].map(x => Number(x[1]));
  const xpGains = [...tail.matchAll(/^LEDGER .*? xpGain=(\d+)/gm)].map(x => Number(x[1]));
  const result = tail.split(/\r?\n/).filter(l => /^RESULT /.test(l)).at(-1) ?? null;
  const amount = c.output && result ? Number(c.output.exec(result)?.[1] ?? NaN) : NaN;
  const row = { case: c.key, ok, passes: r.passes, runs: RUNS, elapsedMs, ledgerTicks, rivalTicks: rivalTicks(c.key) ?? null, output: Number.isFinite(amount) ? amount : null, xp: xpGains.at(-1) ?? null, result: result?.slice(0, 400) ?? null };
  console.log(`AIO_BENCH_RESULT ${JSON.stringify(row)}`);
  if (!ok) console.log(`--- tail ${c.key} ---\n${tail.slice(-1500)}\n--- end tail ---`);
  return row;
}

async function main() {
  const prevRandom = process.env.RANDOM_EVENTS, prevLoot = process.env.LOOT_WATCH;
  process.env.RANDOM_EVENTS = '0';
  // A ground-item pickup would move a case's ticks: off unless the run sets LOOT_WATCH=1 (packages/core/src/loot.ts).
  process.env.LOOT_WATCH = prevLoot === '1' ? '1' : '0';
  process.env.DEMO_OK = '';

  mkdirSync(dirname(OUT), { recursive: true });
  for (const [path, job] of Object.entries(BENCH_JOB_FILES)) writeFileSync(path, JSON.stringify(job, null, 2));

  const coverage = benchCoverage();
  console.log(`AIO_BENCH_COVERAGE ${JSON.stringify(coverage)}`);
  if (process.env.BENCH_COVERAGE_ONLY) return;
  benchPlanners();

  // BENCH_SMOKE=1 runs the short smoke set. BENCH_ALL=1 also runs the cases marked `known` (they cannot pass today).
  const smoke = process.env.BENCH_SMOKE === '1' ? new Set(SMOKE_KEYS) : undefined;
  const cases = [...benchCases(), ...FISHING_BENCH_CASES].filter(c => (!ONLY || ONLY.test(c.key)) && (!smoke || smoke.has(c.key)) && (process.env.BENCH_ALL === '1' || !c.known));
  console.log(`AIO_BENCH start cases=${cases.length} runs=${RUNS} concurrency=${CONCURRENCY} timeoutMs=${TIMEOUT} ${LOCKSTEP ? `lockstep seed=${SEED}` : 'tickMs=150'} xpRate=25`);
  if (LOCKSTEP) process.env.SIM_LOCKSTEP = '1'; // bench bots inherit it and acknowledge each tick
  // A fresh-engine slot owns ports SLOT_PORT+10k .. +3 and its own market database, beside the shared stack's 8888.
  const slotPort = (slot: number) => SLOT_PORT + slot * 10;
  const start = (label?: string, slot?: number, caseEnv: Record<string, string> = {}) => startStack({ tickMs: Number(process.env.BENCH_TICK_MS ?? 150), xpRate: 25, readyTimeoutMs: 120_000,
    ...(slot === undefined ? {} : { instance: `aiobench-${slot}`, gateway: false as const, ports: { engine: slotPort(slot), gateway: slotPort(slot) + 1 },
      engineEnv: { WEB_MANAGEMENT_PORT: String(slotPort(slot) + 2), NODE_PORT: String(slotPort(slot) + 3), GE_DATABASE: `data/market-aiobench-${slot}.sqlite`, ...caseEnv } }),
    ...(LOCKSTEP ? { lockstep: { seed: SEED, anchor: '^aiob', ...(TRACE_DIR && label ? { traceFile: resolve(TRACE_DIR, `${label.replace(/[^a-z0-9-]/gi, '_')}.trace`), actionFile: resolve(TRACE_DIR, `${label.replace(/[^a-z0-9-]/gi, '_')}.actions`) } : {}) } } : {}) });
  if (TRACE_DIR) mkdirSync(TRACE_DIR, { recursive: true });
  if (FRESH && CONCURRENCY !== 1) throw new Error('BENCH_FRESH=1 uses BENCH_PARALLEL, not BENCH_CONCURRENCY');
  if (!FRESH && PARALLEL !== 1) throw new Error('BENCH_PARALLEL needs BENCH_FRESH=1');
  // The start check (bench-start-check.ts), before the first engine. A case with a kept result starts no engine, so
  // a run of kept results only has no check. The shared stack of a --wall-clock run checks its own two ports at its start.
  const toRun = cases.filter(c => !(CACHE && existsSync(join(CACHE_DIR, `${caseHash(c)}.json`)))).length;
  const engines = FRESH ? Math.min(PARALLEL, toRun) : Math.min(1, toRun);
  if (engines > 0 && process.env.BENCH_FORCE !== '1') {
    const refusal = await admitStart({ root, engines, ports: FRESH ? Array.from({ length: engines }, (_, slot) => slotPort(slot)) : [] }, Number(process.env.BENCH_WAIT_MIN ?? 0) * 60_000);
    if (refusal) { console.error(refusal); process.exit(START_REFUSED_EXIT); }
  }
  // The time budget: refuse a selection over it before the first engine, and start no case after the deadline.
  const budgetMin = Number(process.env.BENCH_BUDGET_MIN ?? BUDGET_MIN), overBudget = process.env.BENCH_OVER_BUDGET === '1';
  const estimate = estimateRun(cases.filter(c => !(CACHE && existsSync(join(CACHE_DIR, `${caseHash(c)}.json`)))).map(c => c.key), readElapsed(), Math.max(1, engines));
  console.log(`AIO_BENCH_BUDGET ${JSON.stringify({ toRun: estimate.each.length, engines, estimateMin: +(estimate.ms / 60_000).toFixed(1), budgetMin, noRecord: estimate.unknown, over: overBudget })}`);
  const refusedBudget = budgetRefusal(estimate, budgetMin, Math.max(1, engines));
  if (refusedBudget && !overBudget) { console.error(refusedBudget); process.exit(BUDGET_EXIT); }
  const deadline = Date.now() + budgetMin * 60_000;
  const profile = process.env.BENCH_PROFILE === '1';
  const simStatFile = join(practiceDir(), 'logs', 'sim-stat.log');
  if (profile) mkdirSync(join(dirname(OUT), 'profile'), { recursive: true });
  let stack = FRESH ? null : await start();
  const rows: Awaited<ReturnType<typeof runCase>>[] = [];
  try {
    let next = 0;
    const worker = async (slot: number) => {
      for (;;) {
        const i = next++;
        const c = cases[i];
        if (!c) return;
        let own: Awaited<ReturnType<typeof start>> | null = null;
        const kept = CACHE ? join(CACHE_DIR, `${caseHash(c)}.json`) : null;
        try {
          if (kept && existsSync(kept)) {
            const row = { ...JSON.parse(readFileSync(kept, 'utf8')), kept: true };
            // A kept row gives the case a time record when it has none yet.
            if (!(c.key in readElapsed()) && row.elapsedMs > 0) recordElapsed(c.key, row.elapsedMs);
            console.log(`AIO_BENCH_RESULT ${JSON.stringify(row)}`);
            rows.push(row);
          } else if (!overBudget && Date.now() > deadline) {
            const row = { case: c.key, ok: false, passes: 0, runs: RUNS, elapsedMs: 0, ledgerTicks: [], rivalTicks: null, output: null, xp: null, result: `skipped: past the ${budgetMin}-minute budget` };
            console.log(`AIO_BENCH_RESULT ${JSON.stringify(row)}`);
            rows.push(row);
          } else {
            const engineAt = Date.now();
            if (FRESH) own = await start(c.key, slot, c.engineEnv);
            const engineStartMs = Date.now() - engineAt;
            // --profile: the bots of this case write their ACK_STAT lines here; the engine's wait lines are read from
            // the bytes its stat file gains during the case.
            const ackFile = profile ? resolve(dirname(OUT), 'profile', `${c.key.replace(/[^a-z0-9-]/gi, '_')}.ack`) : '';
            if (profile) { rmSync(ackFile, { force: true }); process.env.SIM_ACK_FILE = ackFile; }
            const statFrom = profile && existsSync(simStatFile) ? readFileSync(simStatFile).length : 0;
            const row = await runCase(c, FRESH ? 'aiobf' : `aiob${i}`, FRESH ? slotPort(slot) : 8888);
            if (profile) {
              delete process.env.SIM_ACK_FILE;
              const ack = parseAckStats(readSince(ackFile, 0)), sim = parseSimStat(readSince(simStatFile, statFrom));
              console.log(`AIO_BENCH_PROFILE ${JSON.stringify({ case: c.key, wallMs: row.elapsedMs, engineStartMs, ...phase, engine: sim, client: ack, cappedCostMs: ack.capped * Number(process.env.SIM_BUSY_MS ?? 2000) })}`);
            }
            recordElapsed(c.key, Date.now() - engineAt);
            // One line for each case that ran: the time to start the engine, to write the account, to run the worker
            // script (login to logout) and to delete the account; `otherMs` is the rest of the case.
            if (PARALLEL === 1) console.log(`AIO_BENCH_TIMING ${JSON.stringify({ case: c.key, engineStartMs, ...phase, otherMs: row.elapsedMs - phase.prepareMs - phase.scriptMs - phase.cleanupMs })}`);
            if (kept && row.ok) { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(kept, JSON.stringify(row)); } // a failure is run again each time
            rows.push(row);
          }
        }
        catch (e) { const row = { case: c.key, ok: false, passes: 0, runs: RUNS, elapsedMs: 0, ledgerTicks: [], rivalTicks: null, output: null, xp: null, result: `bench error ${String((e as Error)?.message ?? e).slice(0, 300)}` }; console.log(`AIO_BENCH_RESULT ${JSON.stringify(row)}`); rows.push(row); }
        await own?.stop();
        writeFileSync(OUT, JSON.stringify({ coverage, concurrency: CONCURRENCY, runs: RUNS, rows }, null, 2));
      }
    };
    await Promise.all(Array.from({ length: FRESH ? PARALLEL : CONCURRENCY }, (_, slot) => worker(slot)));
  } finally {
    await stack?.stop();
    if (prevRandom === undefined) delete process.env.RANDOM_EVENTS;
    else process.env.RANDOM_EVENTS = prevRandom;
    if (prevLoot === undefined) delete process.env.LOOT_WATCH;
    else process.env.LOOT_WATCH = prevLoot;
  }
  const passed = rows.filter(r => r.ok).length;
  console.log(`AIO_BENCH_SUMMARY ${JSON.stringify({ ok: passed === rows.length, cases: rows.length, passed, failed: rows.filter(r => !r.ok).map(r => r.case), routes: coverage.routes, covered: coverage.covered })}`);
  report(rows as Row[]);
  process.exit(passed === rows.length ? 0 : 1);
}

if (import.meta.main) {
  main().catch(e => {
    console.error(`AIO_BENCH_ERROR ${String(e?.stack ?? e)}`);
    process.exit(1);
  });
}
