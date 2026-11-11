// Hill climb of the fight options (scripts/pk.ts FightOptions) on batch spars. The champion is the set of options in
// scripts/pk-champion.json. For each knob the climber tries each candidate value against the champion in mirror spars:
// in one batch half of the pairs have the candidate as side A and half as side B (SPAR_SWAP=1), so one run of about a
// minute gives 8 paired samples with no side bias. The measure of a fight is the net damage for each 100 ticks (damage
// the opponent took less damage we took): it moves with every hit, so it separates two settings in far fewer fights
// than a count of kills. A candidate that beats the champion becomes the champion, and the next knob starts from it.
// Usage: bun scripts/measure/pk-spar-climb.ts [--case extra:spar-x8] [--knobs eatAt,rotation] [--cap 500]
//   [--max-runs 3] [--kit <kit>] [--dry]. --dry prints the plan and runs nothing.
// A run needs about 1.5 GB of free memory; the climber waits while the dashboard reports less headroom than
// CLIMB_HEADROOM_GB (default 1), and while the file .practice/pk-climb-pause exists in the main checkout, so another
// session can take the practice slot. Every evaluation is one line in .practice/pk-spar/climb.jsonl. The engines use
// ports from 21600 (BENCH_PORT_BASE), apart from the bench's own 21000, so a bench of another session can run beside.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Profile } from '../pk-spar';

export type Knob = { name: string; candidates: Profile[] };
// Every option that can change during a fight, with the values worth a try. A candidate is a patch on the champion.
export const KNOBS: readonly Knob[] = [
    { name: 'eatAt', candidates: [{ eatAt: 35 }, { eatAt: 42 }, { eatAt: 58 }, { eatAt: 66 }] },
    { name: 'restorePrayerAt', candidates: [{ restorePrayerAt: 8 }, { restorePrayerAt: 35 }] },
    { name: 'rotation', candidates: [
        { rotation: ['magic', 'melee', 'ranged'] }, { rotation: ['ranged', 'magic', 'melee'] }, { rotation: ['magic', 'ranged'] },
        { rotation: ['magic', 'melee'] }, { rotation: ['magic', 'magic', 'ranged', 'melee'] }, { rotation: ['magic', 'ranged', 'magic', 'melee'] },
    ] },
    { name: 'readOverheads', candidates: [{ readOverheads: false }] },
    { name: 'specBelow', candidates: [{ specBelow: 0.3 }, { specBelow: 0.5 }, { specBelow: 0.8 }, { specBelow: 1 }] },
    { name: 'freeze', candidates: [{ freeze: 'flee' }, { freeze: 'low' }, { freeze: true }] },
    { name: 'castArmour', candidates: [{ castArmour: 'keep' }, { castArmour: 'strip' }] },
    { name: 'defencePrayer', candidates: [{ defencePrayer: false }] },
    { name: 'standOff', candidates: [{ standOff: 2 }, { standOff: 5 }] },
];

// Mean, standard deviation and t statistic of the paired samples: positive means that the candidate is better.
export function stats(nets: readonly number[]) {
    const n = nets.length, mean = n ? nets.reduce((a, b) => a + b, 0) / n : 0;
    const sd = n > 1 ? Math.sqrt(nets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
    return { n, mean: Number(mean.toFixed(2)), sd: Number(sd.toFixed(2)), t: Number((sd > 0 ? mean / (sd / Math.sqrt(n)) : 0).toFixed(2)) };
}
// Accept at t of 2 or more with 16 or more samples. Reject at once when the first batch is clearly worse (t of -1 or
// less), and once the mean is not above 0 with 16 or more; else one more run. A run is the scarce thing: each needs
// about 1.7 GB of free memory for a minute.
export function verdict(nets: readonly number[], runs: number, maxRuns: number): 'accept' | 'reject' | 'more' {
    const s = stats(nets);
    if (s.n >= 8 && s.t <= -1) return 'reject';
    if (s.n >= 16 && s.t >= 2) return 'accept';
    if (s.n >= 16 && (s.mean <= 0 || s.t < 1)) return 'reject';
    return runs >= maxRuns ? 'reject' : 'more';
}
// The `nets=` list of a batch RESULT line: one net damage rate for each pair, from the candidate's side.
export function readNets(result: string | null): number[] | null {
    const m = /^RESULT ok spar-batch .* nets=([-\d.,]+)/.exec(result ?? '');
    return m ? m[1]!.split(',').map(Number).filter(Number.isFinite) : null;
}

if (import.meta.main) {
    const argv = process.argv.slice(2);
    const value = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
    const key = value('--case') ?? 'extra:spar-x8', cap = value('--cap') ?? '500', maxRuns = Number(value('--max-runs') ?? 3), kit = value('--kit');
    const only = value('--knobs')?.split(','), dry = argv.includes('--dry');
    const root = resolve(import.meta.dir, '..', '..'), dir = resolve(root, '.practice/pk-spar'), championFile = resolve(root, 'scripts/pk-champion.json');
    mkdirSync(dir, { recursive: true });
    const knobs = KNOBS.filter(k => !only || only.includes(k.name));
    if (dry) { for (const k of knobs) console.log(`${k.name}: ${k.candidates.map(c => JSON.stringify(c)).join(' ')}`); process.exit(0); }
    // The main checkout holds the pause file and the dashboard: a worktree under .claude/worktrees is three levels down.
    const main = /[\\/]\.claude[\\/]worktrees[\\/]/.test(root) ? resolve(root, '..', '..', '..') : root;
    const wait = async () => {
        for (;;) {
            let headroom = Infinity;
            try { headroom = (await (await fetch('http://127.0.0.1:3100/api/state', { signal: AbortSignal.timeout(4000) })).json() as { capacity?: { headroomGB?: number } }).capacity?.headroomGB ?? Infinity; } catch { /* no dashboard: no limit known */ }
            const paused = existsSync(resolve(main, '.practice/pk-climb-pause'));
            if (!paused && headroom >= Number(process.env.CLIMB_HEADROOM_GB ?? 1)) return;
            console.log(`CLIMB wait ${paused ? 'pause file' : `headroom ${headroom.toFixed(2)} GB`}`);
            await Bun.sleep(30_000);
        }
    };
    let seed = Number(process.env.CLIMB_SEED ?? 1);
    const batch = async (patch: Profile): Promise<number[] | null> => {
        await wait();
        const out = '.practice/pk-spar/climb-run.json';
        const set = { SPAR_A: 'champion', SPAR_A_OPTS: JSON.stringify(patch), SPAR_B: 'champion', SPAR_SWAP: '1', SPAR_CAP: cap, ...(kit ? { SPAR_A_KIT: kit, SPAR_B_KIT: kit } : {}) };
        Bun.spawnSync(['bun', 'scripts/measure/aio-practice-bench.ts', `^${key}$`, '--parallel', '1', '--no-keep', '--seed', String(seed++), ...Object.entries(set).flatMap(([k, v]) => ['--set', `${k}=${v}`])],
            { cwd: root, env: { BENCH_PORT_BASE: '21600', ...process.env, BENCH_OUT: out }, stdout: 'ignore', stderr: 'inherit', windowsHide: true });
        try { const row = JSON.parse(readFileSync(resolve(root, out), 'utf8')).rows[0]; return row?.ok ? readNets(row.result) : null; } catch { return null; }
    };
    for (const knob of knobs) {
        for (const patch of knob.candidates) {
            const champion = JSON.parse(readFileSync(championFile, 'utf8')) as Profile;
            // A candidate equal to the champion's own value measures nothing.
            if (Object.entries(patch).every(([k, v]) => JSON.stringify((champion as Record<string, unknown>)[k]) === JSON.stringify(v))) continue;
            const nets: number[] = [];
            let runs = 0, failed = 0, outcome: 'accept' | 'reject' | 'more' | 'invalid' = 'more';
            while (outcome === 'more') {
                const got = await batch(patch);
                // A run that gave no fights (the engine did not start, a fight was not valid) is tried again after a
                // pause; five in a row end the candidate as invalid.
                if (!got) { if (++failed >= 5) outcome = 'invalid'; else await Bun.sleep(30_000); continue; }
                runs++; failed = 0;
                nets.push(...got);
                outcome = verdict(nets, runs, maxRuns);
            }
            const line = { case: key, kit, knob: knob.name, patch, ...stats(nets), runs, outcome };
            appendFileSync(resolve(dir, 'climb.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...line }) + '\n');
            console.log(`CLIMB ${JSON.stringify(line)}`);
            if (outcome === 'accept') writeFileSync(championFile, JSON.stringify({ ...champion, ...patch }, null, 2) + '\n');
        }
    }
    console.log(`CLIMB_DONE ${readFileSync(championFile, 'utf8').replace(/\s+/g, ' ')}`);
}
