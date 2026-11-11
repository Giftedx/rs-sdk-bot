// Spar ladder: is a challenger fight profile better than the champion? It runs a spar bench case (scripts/pk-spar.ts),
// one engine at a time. Head to head (the default): once for each seed with the challenger as side A and once as side
// B; it prints the challenger's wins, losses, draws and mean score. With --against <profile>: the two sides of the case
// have different jobs (a hunter and a runner), so the challenger and the champion each play side A against that
// profile on each seed, and the higher mean score wins. A profile that wins the ladder is the next champion.
// Usage: bun scripts/measure/pk-spar-ladder.ts <challenger> [champion, default base] [--seeds 1,2,3]
//   [--case <bench key, default pvp:spar>] [--against <profile>] [--opts '<json>'] [--champion-opts '<json>'].
// Profiles: scripts/pk-spar.ts PROFILES; --opts adds fight options to the challenger, so one number can be tried with
// no new profile: base base --opts '{"eatAt":60}'.
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
// Each profile played side A against the same opponent: the higher mean score is the better profile.
export function againstSummary(challenger: readonly Fight[], champion: readonly Fight[]) {
    const mean = (fights: readonly Fight[]) => { const s = fights.filter(f => f.ok).map(f => f.score!); return s.length ? Number((s.reduce((n, v) => n + v, 0) / s.length).toFixed(1)) : 0; };
    const failed = [...challenger, ...champion].filter(f => !f.ok).length, wins = (fights: readonly Fight[]) => fights.filter(f => f.ok && f.winner === 'a').length;
    const a = mean(challenger), b = mean(champion);
    return { fights: challenger.length + champion.length, failed, challenger: { mean: a, wins: wins(challenger), scores: challenger.map(f => f.score ?? null) },
        champion: { mean: b, wins: wins(champion), scores: champion.map(f => f.score ?? null) }, verdict: failed ? 'invalid' : a > b ? 'challenger' : 'champion' };
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
    const key = value('--case') ?? 'pvp:spar', against = value('--against');
    const [challenger, champion = 'base'] = argv;
    if (!challenger || seeds.some(n => !Number.isSafeInteger(n))) { console.log('usage: bun scripts/measure/pk-spar-ladder.ts <challenger> [champion] [--seeds 1,2,3] [--case key] [--against profile] [--opts json] [--champion-opts json]'); process.exit(2); }
    const root = resolve(import.meta.dir, '..', '..'), dir = '.practice/pk-spar';
    mkdirSync(resolve(root, dir), { recursive: true });
    const label = key.replace(/[^a-z0-9-]/gi, '_');
    // One fight: the profile and the options of each side, on one seed.
    const run = (seed: number, side: 'a' | 'b', a: [string, string | undefined], b: [string, string | undefined], tag: string): Fight => {
        const out = `${dir}/${label}-${tag}-seed${seed}.json`;
        const set: Record<string, string | undefined> = { SPAR_A: a[0], SPAR_A_OPTS: a[1], SPAR_B: b[0], SPAR_B_OPTS: b[1] };
        const sets = Object.entries(set).flatMap(([k, v]) => (v === undefined ? [] : ['--set', `${k}=${v}`]));
        const child = Bun.spawnSync(['bun', 'scripts/measure/aio-practice-bench.ts', `^${key}$`, '--seed', String(seed), '--parallel', '1', ...sets],
            { cwd: root, env: { ...process.env, BENCH_OUT: out }, stdout: 'ignore', stderr: 'inherit', windowsHide: true });
        let row: { ok: boolean; result: string | null } | undefined;
        try { row = JSON.parse(readFileSync(resolve(root, out), 'utf8')).rows[0]; } catch { /* the bench wrote no row */ }
        const fight = readFight(seed, side, !!row?.ok, row?.result ?? `bench exit ${child.exitCode}`);
        console.log(`SPAR_FIGHT ${JSON.stringify({ case: key, a: a[0], b: b[0], ...fight })}`);
        return fight;
    };
    if (against) {
        const first = seeds.map(seed => run(seed, 'a', [challenger, opts], [against, undefined], `${challenger}-against-${against}`));
        const second = seeds.map(seed => run(seed, 'a', [champion, championOpts], [against, undefined], `${champion}-champion-against-${against}`));
        const summary = againstSummary(first, second);
        console.log(`SPAR_LADDER ${JSON.stringify({ case: key, profiles: { challenger, champion, against }, opts, championOpts, seeds, ...summary })}`);
        process.exit(summary.failed ? 1 : 0);
    }
    const fights: Fight[] = [];
    for (const seed of seeds) {
        fights.push(run(seed, 'a', [challenger, opts], [champion, championOpts], `${challenger}-vs-${champion}-a`));
        fights.push(run(seed, 'b', [champion, championOpts], [challenger, opts], `${challenger}-vs-${champion}-b`));
    }
    const summary = ladderSummary(fights);
    console.log(`SPAR_LADDER ${JSON.stringify({ case: key, challenger, champion, opts, championOpts, seeds, ...summary })}`);
    process.exit(summary.failed ? 1 : 0);
}
