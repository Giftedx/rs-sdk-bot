// Where the time of a lockstep bench run goes. Runs one bench case (the arguments go to aio-practice-bench.ts) with
// the client's tick log on (SIM_ACK_FILE, packages/core/src/inprocess.ts) and the engine's (SIM_STAT_FILE,
// World.simAwaitAcks), then prints one block: wall time, ticks, ms a tick, the engine's wait for the acks of the
// clients, the ticks that a client held and why, and the time the bot process spent on packets, state and script.
// A tick of a lockstep engine costs what its slowest client takes to answer, so the block names the cost to cut.
// Usage: bun scripts/measure/bench-speed.ts '^extra:gang-live-fast-x1$' [--seed n] [--set K=V ...]
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..', '..');
const dir = join(root, '.practice', 'bench-speed');
mkdirSync(dir, { recursive: true });
const ackFile = join(dir, 'ack.log'), statFile = join(root, '.practice', 'logs', 'sim-stat-aiobench-0.log'), out = join(dir, 'row.json');
for (const f of [ackFile, statFile, out]) rmSync(f, { force: true });

export type AckLine = { tick: number; held: number; capped: boolean; running: boolean; waits: number };
export function parseAck(text: string): { lines: AckLine[]; stats: Record<string, number>[] } {
    const lines: AckLine[] = [], stats: Record<string, number>[] = [];
    for (const l of text.split('\n')) {
        const m = l.match(/^ACK tick=(\d+)(?: bot=\S+)? waits=(\d+) state=\S+ running=(\w+)(?: \S+=\S+)*? held=(\d+)ms( CAPPED)?/);
        if (m) lines.push({ tick: Number(m[1]), waits: Number(m[2]), running: m[3] === 'true', held: Number(m[4]), capped: !!m[5] });
        else if (l.startsWith('ACK_STAT ')) stats.push(JSON.parse(l.slice(9)));
    }
    return { lines, stats };
}
// The engine's lines: `[sim] tick N: last 25 ticks waited X ms each (...)`.
export function parseStat(text: string): { ticks: number; waitMs: number } {
    let ticks = 0, waitMs = 0;
    for (const m of text.matchAll(/last (\d+) ticks waited ([\d.]+) ms each/g)) { ticks += Number(m[1]); waitMs += Number(m[1]) * Number(m[2]); }
    return { ticks, waitMs };
}

if (import.meta.main) {
    const t0 = performance.now();
    const p = Bun.spawnSync(['bun', 'scripts/measure/aio-practice-bench.ts', ...process.argv.slice(2), '--parallel', '1', '--no-keep'],
        { cwd: root, env: { ...process.env, SIM_ACK_FILE: ackFile, BENCH_OUT: out }, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    const wallMs = performance.now() - t0;
    const text = p.stdout.toString();
    const row = text.split('\n').filter(l => l.startsWith('AIO_BENCH_RESULT ')).map(l => JSON.parse(l.slice(17)))[0] ?? {};
    const timing = text.split('\n').filter(l => l.startsWith('AIO_BENCH_TIMING ')).map(l => JSON.parse(l.slice(17)))[0] ?? {};
    const ack = parseAck(existsSync(ackFile) ? readFileSync(ackFile, 'utf8') : '');
    const stat = parseStat(existsSync(statFile) ? readFileSync(statFile, 'utf8') : '');
    const ticks = Math.max(...(row.ledgerTicks ?? [0]), stat.ticks);
    const sum = (k: string) => ack.stats.reduce((n, s) => n + (s[k] ?? 0), 0);
    const held = ack.lines.reduce((n, l) => n + l.held, 0), capped = ack.lines.filter(l => l.capped);
    const f = (n: number) => n.toFixed(1);
    console.log(`BENCH_SPEED ${row.case ?? '?'} ${row.ok ? 'ok' : 'FAIL'} wall ${(wallMs / 1000).toFixed(0)} s, script ${((timing.scriptMs ?? 0) / 1000).toFixed(0)} s, engine start ${((timing.engineStartMs ?? 0) / 1000).toFixed(1)} s`);
    console.log(`  ticks ${ticks}: ${f((timing.scriptMs ?? wallMs) / Math.max(1, ticks))} ms a tick; the engine waited ${f(stat.waitMs / Math.max(1, stat.ticks))} ms a tick for the acks of its clients`);
    console.log(`  client holds over 2 ms: ${ack.lines.length} ticks, ${f(held / 1000)} s in all (${capped.length} capped at SIM_BUSY_MS: the script held the tick with no wait)`);
    console.log(`  bot process: packets ${f(sum('pumpMs') / 1000)} s, state ${f(sum('stateMs') / 1000)} s, script ${f(sum('scriptMs') / 1000)} s over ${ack.stats.length} sessions`);
    const worst = [...ack.lines].sort((a, b) => b.held - a.held).slice(0, 5).map(l => `t${l.tick} ${l.held}ms${l.capped ? ' CAPPED' : ''}${l.running ? ' running' : ''}`);
    if (worst.length) console.log(`  longest holds: ${worst.join(', ')}`);
    const rest = stat.waitMs - held / Math.max(1, ack.stats.length);
    console.log(`  engine wait not explained by client holds: about ${f(Math.max(0, rest) / Math.max(1, stat.ticks))} ms a tick (transport, timers, the slowest client's read)`);
    console.log(`  files: ${ackFile}, ${statFile}`);
}
