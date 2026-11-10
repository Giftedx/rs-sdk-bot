// Spar ladder: is a challenger fight profile better than the champion? It runs the bench case pvp:spar
// (scripts/pk-spar.ts) once for each seed with the challenger as side A and once as side B, one engine at a time,
// and prints the challenger's wins, losses, draws and mean score. A profile that wins the ladder is the next champion.
// Usage: bun scripts/measure/pk-spar-ladder.ts <challenger> [champion, default base] [--seeds 1,2,3]
//   [--opts '<json>'] [--champion-opts '<json>']. Profiles: scripts/pk-spar.ts PROFILES; --opts adds fight options
// to the challenger, so one number can be tried with no new profile: base base --opts '{"eatAt":60}'.
// Each engine needs about 1.5 GB of free memory. Raw rows go to .practice/pk-spar/.
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type Fight = { seed: number; side: 'a' | 'b'; ok: boolean; winner?: 'a' | 'b' | 'draw'; score?: number; ticks?: number; result: string | null };
// One bench RESULT line of scripts/pk-spar.ts, read for the side the challenger played.
export function readFight(seed: number, side: 'a' | 'b', ok: boolean, result: string | null): Fight {
    const m = result && /^RESULT ok spar winner=(a|b|draw) score=(-?\d+) ticks=(\d+)/.exec(result);
    if (!ok || !m) return { seed, side, ok: false, result };
    return { seed, side, ok: true, winner: m[1] as 'a' | 'b' | 'draw', score: Number(m[2]), ticks: Number(m[3]), result };
}
// The ladder from the challenger's side: a fight as side B counts the champion's score with the sign turned.
export function ladderSummary(fights: readonly Fight[]) {
    const valid = fights.filter(f => f.ok), scores = valid.map(f => (f.side === 'a' ? f.score! : -f.score!));
    const wins = valid.filter(f => f.winner === f.side).length, draws = valid.filter(f => f.winner === 'draw').length;
    const mean = scores.length ? scores.reduce((n, s) => n + s, 0) / scores.length : 0;
    const failed = fights.length - valid.length;
    // Better only with every fight valid, more wins than losses and a positive mean score.
    const verdict = failed ? 'invalid' : wins > valid.length - wins - draws && mean > 0 ? 'challenger' : 'champion';
    return { fights: fights.length, failed, wins, losses: valid.length - wins - draws, draws, mean: Number(mean.toFixed(1)), scores, verdict };
}

if (import.meta.main) {
    const argv = process.argv.slice(2);
    const value = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
    const seeds = (value('--seeds') ?? '1,2,3').split(',').map(Number), opts = value('--opts'), championOpts = value('--champion-opts');
    const [challenger, champion = 'base'] = argv;
    if (!challenger || seeds.some(n => !Number.isSafeInteger(n))) { console.log('usage: bun scripts/measure/pk-spar-ladder.ts <challenger> [champion] [--seeds 1,2,3] [--opts json] [--champion-opts json]'); process.exit(2); }
    const root = resolve(import.meta.dir, '..', '..'), dir = '.practice/pk-spar';
    mkdirSync(resolve(root, dir), { recursive: true });
    const fights: Fight[] = [];
    for (const seed of seeds) for (const side of ['a', 'b'] as const) {
        const other = side === 'a' ? 'b' : 'a', out = `${dir}/${challenger}-vs-${champion}-seed${seed}-${side}.json`;
        const set: Record<string, string | undefined> = {
            [`SPAR_${side.toUpperCase()}`]: challenger, [`SPAR_${other.toUpperCase()}`]: champion,
            [`SPAR_${side.toUpperCase()}_OPTS`]: opts, [`SPAR_${other.toUpperCase()}_OPTS`]: championOpts,
        };
        const sets = Object.entries(set).flatMap(([k, v]) => (v === undefined ? [] : ['--set', `${k}=${v}`]));
        const child = Bun.spawnSync(['bun', 'scripts/measure/aio-practice-bench.ts', '^pvp:spar$', '--seed', String(seed), '--parallel', '1', ...sets],
            { cwd: root, env: { ...process.env, BENCH_OUT: out }, stdout: 'ignore', stderr: 'inherit', windowsHide: true });
        let row: { ok: boolean; result: string | null } | undefined;
        try { row = JSON.parse(readFileSync(resolve(root, out), 'utf8')).rows[0]; } catch { /* the bench wrote no row */ }
        const fight = readFight(seed, side, !!row?.ok, row?.result ?? `bench exit ${child.exitCode}`);
        fights.push(fight);
        console.log(`SPAR_FIGHT ${JSON.stringify({ challenger, champion, ...fight })}`);
    }
    const summary = ladderSummary(fights);
    console.log(`SPAR_LADDER ${JSON.stringify({ challenger, champion, opts, championOpts, seeds, ...summary })}`);
    process.exit(summary.failed ? 1 : 0);
}
