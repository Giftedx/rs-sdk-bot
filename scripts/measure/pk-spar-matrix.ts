// Kit matrix: one batch case puts side A's kit against a different kit in each pair (scripts/pk-kits.ts, the case's
// SPAR_KITS), so one run of about a minute covers every matchup once. This runs the case for each seed and prints,
// for each matchup, side A's kills, deaths, mean net damage for each 100 ticks and the shop cost of each kit.
// Usage: bun scripts/measure/pk-spar-matrix.ts [--case extra:spar-kits-x8] [--seeds 1,2] [--a <profile>] [--b <profile>]
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { benchCases } from './aio-bench-cases';
import { kitCost } from '../pk-kits';

export type Cell = { matchup: string; fights: number; kills: number; deaths: number; net: number };
// The numbers of one `key=a,b,c` list in a batch RESULT line.
export const readList = (result: string | null, key: string): number[] => (new RegExp(` ${key}=([-\\d.,]+)`).exec(result ?? '')?.[1] ?? '').split(',').filter(Boolean).map(Number);
// One row for each matchup over all runs. A kill scores above 100 and a death under -100 (scripts/pk-spar.ts sparScore).
export function matrix(matchups: readonly string[], runs: readonly { nets: number[]; scores: number[] }[]): Cell[] {
    return [...new Set(matchups)].map(matchup => {
        const at = matchups.flatMap((m, i) => (m === matchup ? [i] : []));
        const nets = runs.flatMap(r => at.map(i => r.nets[i]).filter((n): n is number => n !== undefined));
        const scores = runs.flatMap(r => at.map(i => r.scores[i]).filter((n): n is number => n !== undefined));
        return { matchup, fights: scores.length, kills: scores.filter(s => s > 100).length, deaths: scores.filter(s => s < -100).length,
            net: Number((nets.reduce((a, b) => a + b, 0) / Math.max(1, nets.length)).toFixed(1)) };
    });
}

if (import.meta.main) {
    const argv = process.argv.slice(2);
    const value = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
    const key = value('--case') ?? 'extra:spar-kits-x8', seeds = (value('--seeds') ?? '1,2').split(',').map(Number), a = value('--a') ?? 'champion', b = value('--b') ?? 'champion';
    const root = resolve(import.meta.dir, '..', '..'), out = '.practice/pk-spar/matrix-run.json';
    mkdirSync(resolve(root, '.practice/pk-spar'), { recursive: true });
    const kits = benchCases().find(c => c.key === key)?.scriptArgs.find(arg => arg.startsWith('SPAR_KITS='))?.slice('SPAR_KITS='.length).split(',');
    if (!kits) { console.log(`no matrix case ${key}`); process.exit(2); }
    const runs: { nets: number[]; scores: number[] }[] = [];
    for (const seed of seeds) {
        Bun.spawnSync(['bun', 'scripts/measure/aio-practice-bench.ts', `^${key}$`, '--parallel', '1', '--no-keep', '--seed', String(seed), '--set', `SPAR_A=${a}`, '--set', `SPAR_B=${b}`],
            { cwd: root, env: { BENCH_PORT_BASE: '21600', ...process.env, BENCH_OUT: out }, stdout: 'ignore', stderr: 'inherit', windowsHide: true });
        let row: { ok: boolean; result: string | null } | undefined;
        try { row = JSON.parse(readFileSync(resolve(root, out), 'utf8')).rows[0]; } catch { /* the bench wrote no row */ }
        if (row?.ok) runs.push({ nets: readList(row.result, 'nets'), scores: readList(row.result, 'scores') });
        else console.log(`MATRIX_RUN_FAILED seed ${seed}: ${String(row?.result).slice(0, 200)}`);
    }
    for (const cell of matrix(kits, runs)) {
        const [ka, kb] = cell.matchup.split(':');
        console.log(`MATRIX ${JSON.stringify({ ...cell, costA: kitCost(ka!), costB: kitCost(kb!) })}`);
    }
    process.exit(runs.length === seeds.length ? 0 : 1);
}
