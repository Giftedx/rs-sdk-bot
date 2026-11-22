// One matched same-job case beside the live fleet (research/aio-bench.md, "Routes that do the same job").
// bun scripts/measure/same-job-bench.ts <case key> <seed>     one case, one practice engine, ports 21800 to 21803
// bun scripts/measure/same-job-bench.ts --check               the room check alone
// The script reads the room once, immediately before the case, and does not wait: exit 3 means no room. Room is
// freeGB above 8 in .practice/swarm-state.json of the main checkout, and no account with lifecycle
// "needs_logout_recovery" or active recovery job in .practice/live/fleet-state.json. A file that does not parse,
// or a fleet state without schemaVersion=1 / accounts object, is no room. Run one case, then check again: a
// practice engine and its worker hold 1 to 2 GB, and a live recovery that finds no memory is refused.
// The output of the run goes to .practice/same-job/<case>-s<seed>.log, and the worker output to logs/ beside it.
// A case marked `known` runs too: the key names it. A run that prints no result row for the case ends with exit 4.
import {readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync} from 'node:fs';
import {freemem} from 'node:os';
import {dirname, resolve} from 'node:path';
import {fleetStateFile} from '../../packages/core/src/practice-paths';

const root = resolve(import.meta.dir, '..', '..');
export type Room = {ok: boolean; freeGB?: number; osFreeGB?: number; recoveries?: string[]; error?: string};

// `main` is the checkout that runs the swarm and the Fleet Brain controller.
export function room(main: string, osFreeGB = freemem() / 2 ** 30, read: (path: string) => string = p => readFileSync(p, 'utf8')): Room {
  try {
    const swarm = JSON.parse(read(resolve(main, '.practice/swarm-state.json'))) as {freeGB?: unknown};
    const state = JSON.parse(read(fleetStateFile(main))) as {schemaVersion?: unknown; accounts?: unknown};
    if (typeof swarm.freeGB !== 'number' || state.schemaVersion !== 1 || !state.accounts || typeof state.accounts !== 'object' || Array.isArray(state.accounts)) {
      return {ok: false, error: 'state shape unknown'};
    }
    const recoveries = Object.entries(state.accounts as Record<string, any>)
      .filter(([, row]) => row?.lifecycle === 'needs_logout_recovery' || row?.activeJob?.activityId === 'recovery:session')
      .map(([name, row]) => `${row?.activeJob ? 'running' : 'pending'}:${name}`);
    return {ok: swarm.freeGB > 8 && osFreeGB > 8 && recoveries.length === 0, freeGB: Number(swarm.freeGB.toFixed(2)), osFreeGB: Number(osFreeGB.toFixed(2)), recoveries};
  } catch (e) { return {ok: false, error: String(e)}; }
}

// The bench command of one case. `--all` is there because the bench leaves out a case marked `known` without it.
export const benchCommand = (key: string, seed: string) => ['bun', 'scripts/measure/aio-practice-bench.ts', `^${key}$`, '--all', '--seed', seed, '--parallel', '1'];
export type Row = {case: string; ok: boolean; kept?: boolean; ledgerTicks?: number[]; output: number | null; xp: number | null; result: string | null};
// The result rows of `key` in the bench output.
export const resultRows = (stdout: string, key: string): Row[] =>
  stdout.split(/\r?\n/).filter(l => l.startsWith('AIO_BENCH_RESULT ')).map(l => JSON.parse(l.slice(17)) as Row).filter(r => r.case === key);

if (import.meta.main) {
  const [key, seed] = process.argv.slice(2);
  const common = Bun.spawnSync(['git', '-C', root, 'rev-parse', '--git-common-dir'], {stdout: 'pipe', stderr: 'pipe', windowsHide: true});
  if (common.exitCode !== 0) throw new Error(`git rev-parse failed: ${common.stderr.toString().trim()}`);
  const main = dirname(resolve(root, common.stdout.toString().trim()));
  const before = room(main);
  console.log(`ROOM ${JSON.stringify(before)}`);
  if (key === '--check') process.exit(before.ok ? 0 : 3);
  if (!key || !/^\d+$/.test(seed ?? '')) throw new Error('usage: same-job-bench.ts <case key> <seed> | --check');
  if (!before.ok) { console.log('NO_ROOM'); process.exit(3); }

  const name = key.replace(/[^a-z0-9-]/gi, '_'), dir = resolve(root, '.practice/same-job');
  mkdirSync(resolve(dir, 'logs'), {recursive: true});
  const child = Bun.spawn(benchCommand(key, seed!),
    {cwd: root, env: {...process.env, BENCH_PORT_BASE: '21800', BENCH_OUT: `.practice/same-job/${name}-s${seed}.json`}, stdout: 'pipe', stderr: 'pipe', windowsHide: true});
  // A worker that does not end must not hold its memory: the whole tree stops after 4 minutes.
  const deadline = setTimeout(() => {
    console.log('DEADLINE 4 minutes: the bench is stopped');
    Bun.spawn(['taskkill', '/PID', String(child.pid), '/T', '/F'], {stdout: 'ignore', stderr: 'ignore', windowsHide: true});
  }, 4 * 60_000);
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const code = await child.exited;
  clearTimeout(deadline);
  writeFileSync(resolve(dir, `${name}-s${seed}.log`), stdout + stderr);
  const rows = resultRows(stdout, key);
  for (const row of rows) {
    const log = resolve(root, '.practice/aio-bench/output', `${name}.log`);
    if (!row.kept && existsSync(log)) copyFileSync(log, resolve(dir, 'logs', `${name}-s${seed}.log`));
    console.log(`ROW seed=${seed} ${row.case} ok=${row.ok}${row.kept ? ' kept' : ''} ticks=${row.ledgerTicks?.join(',')} output=${row.output} xp=${row.xp}\n    ${row.result}`);
  }
  if (stderr.trim()) console.log(`STDERR ${stderr.trim().slice(-600)}`);
  if (!rows.length) console.log(`NO_ROW the bench printed no result row for ${key}`);
  console.log(`DONE code=${code} ${JSON.stringify(room(main))}`);
  process.exit(rows.length ? code ?? 1 : code || 4);
}
