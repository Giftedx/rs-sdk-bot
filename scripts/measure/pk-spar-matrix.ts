// Kit matrix: one batch case puts side A's kit against a different kit in each pair (scripts/pk-kits.ts, the case's
// SPAR_KITS), so one run of about a minute covers every matchup once. This runs the case for each seed and prints,
// for each matchup, side A's kills, deaths, mean net damage for each 100 ticks and the shop cost of each kit.
// Usage: bun scripts/measure/pk-spar-matrix.ts [--case extra:spar-kits-x8[,<case>...]] [--parallel 1] [--seeds 1,2] [--a <profile>] [--b <profile>]
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { benchCases } from './aio-bench-cases';
import { kitCost } from '../pk-kits';
import { waitForMemory } from './pk-spar-wait';

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
    const keys = (value('--case') ?? 'extra:spar-kits-x8').split(','), seeds = (value('--seeds') ?? '1,2').split(',').map(Number), a = value('--a') ?? 'champion', b = value('--b') ?? 'champion';
    // --parallel n: n cases at the same time, each on its own engine. The cases share no world.
    const parallel = Math.max(1, Math.min(keys.length, Number(value('--parallel') ?? 1)));
    const root = resolve(import.meta.dir, '..', '..'), out = '.practice/pk-spar/matrix-run.json';
    mkdirSync(resolve(root, '.practice/pk-spar'), { recursive: true });
    const kits: string[] = [], size: number[] = [];
    for (const key of keys) {
        const args = benchCases().find(c => c.key === key)?.scriptArgs ?? [];
        const list = (name: string) => args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1).split(',');
        const pairs = list('SPAR_KITS'), league = list('SPAR_B_PROFILES');
        if (!pairs) { console.log(`no matrix case ${key}`); process.exit(2); }
        // A league case names side B's profile after its kit: tribrid-pots:melee/base.
        kits.push(...pairs.map((pair, i) => (league ? `${pair}/${league[i % league.length]}` : pair)));
        size.push(pairs.length);
    }
    const runs: { nets: number[]; scores: number[] }[] = [];
    for (const seed of seeds) {
        await waitForMemory(root, undefined, parallel);
        Bun.spawnSync(['bun', 'scripts/measure/aio-practice-bench.ts', `^(${keys.join('|')})$`, '--parallel', String(parallel), '--no-keep', '--seed', String(seed), '--set', `SPAR_A=${a}`, '--set', `SPAR_B=${b}`],
            { cwd: root, env: { BENCH_PORT_BASE: '21600', ...process.env, BENCH_OUT: out }, stdout: 'ignore', stderr: 'inherit', windowsHide: true });
        let rows: { case: string; ok: boolean; result: string | null }[] = [];
        try { rows = JSON.parse(readFileSync(resolve(root, out), 'utf8')).rows; } catch { /* the bench wrote no row */ }
        // The fights of a seed stand in the order of the cases. A case that failed leaves its places empty.
        const nets: number[] = [], scores: number[] = [];
        let failed = 0;
        keys.forEach((key, k) => {
            const row = rows.find(r => r.case === key), at = size.slice(0, k).reduce((n, m) => n + m, 0);
            if (!row?.ok) { failed++; console.log(`MATRIX_RUN_FAILED seed ${seed} ${key}: ${String(row?.result).slice(0, 200)}`); return; }
            readList(row.result, 'nets').forEach((n, i) => { nets[at + i] = n; });
            readList(row.result, 'scores').forEach((n, i) => { scores[at + i] = n; });
        });
        if (failed < keys.length) runs.push({ nets, scores });
        if (failed) process.exitCode = 1;
    }
    for (const cell of matrix(kits, runs)) {
        const [ka, kb] = cell.matchup.split('/')[0]!.split(':');
        console.log(`MATRIX ${JSON.stringify({ ...cell, costA: kitCost(ka!), costB: kitCost(kb!) })}`);
    }
    process.exit(process.exitCode ?? 0);
}
