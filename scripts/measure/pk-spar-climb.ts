// Hill climb of the fight options (scripts/pk.ts FightOptions) on batch spars. The champion is the set of options in
// scripts/pk-champion.json. For each knob the climber tries each candidate value against the champion in mirror spars:
// in one batch half of the pairs have the candidate as side A and half as side B (SPAR_SWAP=1), so one run of about a
// minute gives 8 paired samples with no side bias. The measure of a fight is the net damage for each 100 ticks (damage
// the opponent took less damage we took): it moves with every hit, so it separates two settings in far fewer fights
// than a count of kills. A candidate that beats the champion becomes the champion, and the next knob starts from it.
// With --against <profile> the two sides of the case have different jobs or kits (the kit matrix, an escape case): the
// candidate plays side A in every pair against that profile, and so does the champion on the same seed; a sample is
// the candidate's value less the champion's value in the same pair, so a matchup is compared with itself.
// --measure scores takes the spar score (a kill is above 100) where kills matter more than damage.
// Usage: bun scripts/measure/pk-spar-climb.ts [--case extra:spar-x8] [--knobs eatAt,rotation] [--cap 500]
//   [--max-runs 3] [--against <profile>] [--measure nets|scores] [--jobs 3] [--dry]. --dry prints the plan and runs nothing.
// A run takes only the memory that the live fleet does not need (scripts/measure/pk-spar-wait.ts). Every evaluation is one line in .practice/pk-spar/climb.jsonl. The engines use
// ports from 21600 (BENCH_PORT_BASE), apart from the bench's own 21000, so a bench of another session can run beside.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Profile } from '../pk-spar';
import { waitForMemory } from './pk-spar-wait';

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
    { name: 'escapeAt', candidates: [{ escapeAt: 45 }, { escapeAt: 75 }, { escapeAt: 90 }] },
    { name: 'predictPrayer', candidates: [{ predictPrayer: true }] },
    { name: 'styleByArmour', candidates: [{ styleByArmour: true }] },
    { name: 'mixStyles', candidates: [{ mixStyles: true }] },
    { name: 'adapt', candidates: [{ adapt: true }] },
    { name: 'kite', candidates: [{ freeze: true, kiteFrozen: 3 }, { freeze: 'low', kiteFrozen: 3 }, { freeze: true, kiteFrozen: 6 }] },
    { name: 'prayerFlick', candidates: [{ prayerFlick: false }] },
    { name: 'freeFood', candidates: [{ freeFood: true }] },
    { name: 'bowBurst', candidates: [{ bowBurst: 0.6 }, { bowBurst: 0.45 }, { bowBurst: 0.8 }] },
    { name: 'cureNow', candidates: [{ cureNow: true }] },
    // A freeze from half health, once before the target runs, with the armour off for it: it catches a runner and
    // costs nothing against a fighter (docs on the escape and rival cases in research/pvp-fight-loop.md).
    { name: 'freezeLow', candidates: [{ freeze: 'low', freezeBelow: 0.5, freezeEarlyMax: 1, freezeArmour: 'strip' }] },
    { name: 'diagonalFrozen', candidates: [{ freeze: true, diagonalFrozen: true }, { freeze: 'low', diagonalFrozen: true }] },
    { name: 'cutOff', candidates: [{ chase: true, cutOff: 3 }, { chaseBelow: 0.4, cutOff: 3 }] },
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
// A number list of a batch RESULT line, one value for each pair from side A: `nets` (net damage rate) or `scores`.
export function readNets(result: string | null, key = 'nets'): number[] | null {
    const m = new RegExp(`^RESULT ok spar-batch .* ${key}=([-\\d.,]+)`).exec(result ?? '');
    return m ? m[1]!.split(',').map(Number).filter(Number.isFinite) : null;
}
// The candidate's value less the champion's in each pair of one seed.
export const pairedGain = (candidate: readonly number[], champion: readonly number[]) => candidate.slice(0, champion.length).map((v, i) => Number((v - champion[i]!).toFixed(1)));

if (import.meta.main) {
    const argv = process.argv.slice(2);
    const value = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
    const key = value('--case') ?? 'extra:spar-x8', maxRuns = Number(value('--max-runs') ?? 3), against = value('--against'), measure = value('--measure') ?? 'nets';
    // A mirror is cut at 500 ticks: the net rate needs no kill. A case with jobs runs to its end.
    const cap = value('--cap') ?? (against ? '900' : '500');
    const only = value('--knobs')?.split(','), dry = argv.includes('--dry');
    const root = resolve(import.meta.dir, '..', '..'), dir = resolve(root, '.practice/pk-spar'), championFile = resolve(root, 'scripts/pk-champion.json');
    mkdirSync(dir, { recursive: true });
    const knobs = KNOBS.filter(k => !only || only.includes(k.name));
    if (dry) { for (const k of knobs) console.log(`${k.name}: ${k.candidates.map(c => JSON.stringify(c)).join(' ')}`); process.exit(0); }
    const wait = () => waitForMemory(root);
    const firstSeed = Number(process.env.CLIMB_SEED ?? 1);
    // --jobs n evaluates n candidates of a knob at once, each on its own bench slots (BENCH_SLOT_BASE), engine ports,
    // output folder and row file. A spar batch waits on its bots more than on the CPU, so a knob ends in about the time
    // of its slowest candidate. Default 3.
    const jobs = Math.max(1, Number(value('--jobs') ?? 3));
    const sample = async (patch: Profile, seed: number, slot = 0): Promise<number[] | null> => {
        await wait();
        const out = `.practice/pk-spar/climb-run-${slot}.json`;
        const set = { SPAR_A: 'champion', SPAR_A_OPTS: JSON.stringify(patch), SPAR_B: against ?? 'champion', ...(against ? {} : { SPAR_SWAP: '1' }), SPAR_CAP: cap };
        await Bun.spawn(['bun', 'scripts/measure/aio-practice-bench.ts', `^${key}$`, '--parallel', '1', '--no-keep', '--seed', String(seed), ...Object.entries(set).flatMap(([k, v]) => ['--set', `${k}=${v}`])],
            { cwd: root, env: { BENCH_PORT_BASE: '21600', ...process.env, BENCH_OUT: out, BENCH_SLOT_BASE: String(slot * 8), BENCH_OUTPUT_DIR: `.practice/pk-spar/output-${slot}` }, stdout: 'ignore', stderr: 'inherit', windowsHide: true }).exited;
        try { const row = JSON.parse(readFileSync(resolve(root, out), 'utf8')).rows[0]; return row?.ok ? readNets(row.result, measure) : null; } catch { return null; }
    };
    // The champion's own values for each seed, kept until the champion changes.
    let baseline = new Map<number, number[]>();
    const batch = async (patch: Profile, run: number, slot: number): Promise<number[] | null> => {
        const seed = firstSeed + run;
        if (!against) return sample(patch, seed, slot);
        const got = await sample(patch, seed, slot);
        return got && baseline.has(seed) ? pairedGain(got, baseline.get(seed)!) : null;
    };
    // One candidate to its verdict on slot `slot`.
    const evaluate = async (knob: Knob, patch: Profile, slot: number) => {
        const nets: number[] = [];
        let runs = 0, failed = 0, outcome: 'accept' | 'reject' | 'more' | 'invalid' = 'more';
        while (outcome === 'more') {
            const got = await batch(patch, runs, slot);
            // A run that gave no fights (the engine did not start, a fight was not valid) is tried again after a
            // pause; five in a row end the candidate as invalid.
            if (!got) { if (++failed >= 5) outcome = 'invalid'; else await Bun.sleep(5_000); continue; }
            runs++; failed = 0;
            nets.push(...got);
            outcome = verdict(nets, runs, maxRuns);
        }
        const line = { case: key, against, measure, knob: knob.name, patch, ...stats(nets), runs, outcome };
        appendFileSync(resolve(dir, 'climb.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...line }) + '\n');
        console.log(`CLIMB ${JSON.stringify(line)}`);
        return line;
    };
    for (const knob of knobs) {
        const champion = JSON.parse(readFileSync(championFile, 'utf8')) as Profile;
        // A candidate equal to the champion's own value measures nothing.
        const todo = knob.candidates.filter(patch => !Object.entries(patch).every(([k, v]) => JSON.stringify((champion as Record<string, unknown>)[k]) === JSON.stringify(v)));
        if (!todo.length) continue;
        // Against a fixed opponent, the champion's own values on each seed come first, on all slots at once.
        if (against) await Promise.all(Array.from({ length: maxRuns }, async (_, run) => {
            const seed = firstSeed + run;
            if (!baseline.has(seed)) { const own = await sample({}, seed, run % jobs); if (own) baseline.set(seed, own); }
        }));
        const lines: Awaited<ReturnType<typeof evaluate>>[] = [];
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(jobs, todo.length) }, async (_, slot) => { while (next < todo.length) lines.push(await evaluate(knob, todo[next++]!, slot)); }));
        // Of the candidates of this knob that beat the champion, the one with the best mean becomes the champion.
        const best = lines.filter(l => l.outcome === 'accept').sort((a, b) => b.mean - a.mean)[0];
        if (best) { writeFileSync(championFile, JSON.stringify({ ...champion, ...best.patch }, null, 2) + '\n'); baseline = new Map(); }
    }
    console.log(`CLIMB_DONE ${readFileSync(championFile, 'utf8').replace(/\s+/g, ' ')}`);
}
