// The climb table of the squad against the clones of the dagger gang (research/gang-clones.md, "The climb"): one
// row a condition from the kept logs of its bench runs.
//   bun scripts/measure/pk-gang-climb.ts <batch folder> [...]
// A folder with no `bench.txt` is the artifact of a hosted bench run: one seed a condition.
// A batch folder holds `bench.txt` (the output of `bun run bench <pattern> --seeds 1,2,3`) and `seed-<n>/<case>.log`
// (the case logs, each with the RESULT line of scripts/pk-squad.ts). A condition is a case of a batch.
// The cycle: a dead gang account is back on its post after the ticks of the record (group.json `returnToPost`), so a squad that holds
// the post kills each of the three once in the ticks of a run plus that wait. A server hour has 9,000 ticks of 400 ms.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const HOUR_TICKS = 9000, SHARK_COINS = 300, SHARK_HEAL = 20;
// The wait for a dead gang account: the median of the record's ticks from a death to the post (group.json).
export function returnTicks(file = join(import.meta.dir, '..', 'pk-gang-record', 'group.json')): number {
    const f = JSON.parse(readFileSync(file, 'utf8')).returnToPost, a = [...((f?.value?.ticksAfterADeath ?? []) as number[])].sort((x, y) => x - y);
    if (!a.length) throw Error('pk-gang-climb: the record holds no return of a dead gang account (group.json returnToPost)');
    return a[Math.floor(a.length / 2)]!;
}
export type Run = { seed: number; accounts: number; kills: number; gangDied: number; died: number; taken: number; trips: number; ticks: number | null };
export type SquadMetrics = {
    accounts: number; kills: number; deaths: number; taken: number; trips: number;
    avgKillTicks: number | null; minHp: number | null; sharksEaten: number; karamEaten: number;
    freezesCast: number; freezesLanded: number; escapes: number;
};
export type RichRun = Run & { metrics?: SquadMetrics | null };
export type Row = { batch: string; condition: string; runs: Run[]; kills: number; gang: number; deaths: number; hpAKill: number | null; ticksARun: number | null; killsAnHour: number | null; accountTicksAKill: number | null; coinsAKill: number | null };
export type RichRow = Row & {
    avgKillTicks: number | null; ticksPerKill: number | null; minHp: number | null;
    sharksEaten: number; karamEaten: number; freezesCast: number; freezesLanded: number;
    freezePct: number | null; suppliesPerKill: number | null; escapes: number; hasMetrics: boolean;
};

// The RESULT line of the squad script in a case log. A run with a death of ours reads `RESULT fail died squad ...`.
export function parseRun(text: string, seed: number, ticks: number | null): Run | null {
    const line = text.split(/\r?\n/).reverse().find(l => /RESULT (ok|fail)( died)? squad/.test(l));
    if (!line) return null;
    const n = (key: string) => Number(line.match(new RegExp(`${key}=(\\d+)`))?.[1] ?? 0);
    return { seed, accounts: n('accounts'), kills: n('kills'), gangDied: n('gangDied'), died: n('died'), taken: n('taken'), trips: n('trips'), ticks };
}
/** Parses the last SQUAD_METRICS {...} JSON line from a squad log, or null if absent. */
export function parseSquadMetrics(text: string): SquadMetrics | null {
    const line = text.split(/\r?\n/).reverse().find(l => /^SQUAD_METRICS \{/.test(l));
    if (!line) return null;
    try { return JSON.parse(line.slice('SQUAD_METRICS '.length)) as SquadMetrics; } catch { return null; }
}
export function parseRichRun(text: string, seed: number, ticks: number | null): RichRun | null {
    const base = parseRun(text, seed, ticks);
    return base ? { ...base, metrics: parseSquadMetrics(text) } : null;
}
// The ticks of each case at each seed from the table that the bench prints for a set of seeds.
export function parseTicks(bench: string): Map<string, (number | null)[]> {
    const out = new Map<string, (number | null)[]>();
    for (const l of bench.split(/\r?\n/)) { const m = l.match(/^(\S+:\S+)\s+\d+\/\d+\s+(.*)$/); if (m) out.set(m[1]!, m[2]!.trim().split(/\s+/).map(v => (/^\d+$/.test(v) ? Number(v) : null))); }
    return out;
}
// One row: the sums over the runs. `gangSize` is the gang accounts of a run, `returnTicks` the wait for a dead one.
export function row(batch: string, condition: string, runs: Run[], returnTicks: number, gangSize = 3): Row {
    const sum = (pick: (r: Run) => number) => runs.reduce((a, r) => a + pick(r), 0), kills = sum(r => r.kills), timed = runs.filter(r => r.ticks !== null);
    // The rates use the runs with a tick count only, so the kills and the ticks of a rate are of the same runs.
    const timedKills = timed.reduce((a, r) => a + r.kills, 0);
    const ticksARun = timed.length ? sum(r => r.ticks ?? 0) / timed.length : null, hpAKill = kills ? sum(r => r.taken) / kills : null, accounts = runs[0]?.accounts ?? 0;
    return { batch, condition, runs, kills, gang: runs.length * gangSize, deaths: sum(r => r.died), hpAKill: hpAKill === null ? null : Math.round(hpAKill), ticksARun: ticksARun === null ? null : Math.round(ticksARun),
        killsAnHour: ticksARun === null ? null : Math.round((10 * HOUR_TICKS * (timedKills / timed.length)) / (ticksARun + returnTicks)) / 10,
        accountTicksAKill: ticksARun === null || !timedKills ? null : Math.round((accounts * ticksARun * timed.length) / timedKills), coinsAKill: hpAKill === null ? null : Math.round((hpAKill / SHARK_HEAL) * SHARK_COINS) };
}
/** Aggregates base squad stats and optional SQUAD_METRICS across a candidate's runs. */
export function richRow(batch: string, condition: string, runs: readonly RichRun[], waitTicks: number, gangSize = 3): RichRow {
    const base = row(batch, condition, [...runs], waitTicks, gangSize);
    const withMetrics = runs.map(r => r.metrics).filter((m): m is SquadMetrics => !!m);
    const hasMetrics = withMetrics.length > 0;
    const sumM = (f: (m: SquadMetrics) => number) => withMetrics.reduce((n, m) => n + f(m), 0);
    const sharksEaten = sumM(m => m.sharksEaten), karamEaten = sumM(m => m.karamEaten);
    const freezesCast = sumM(m => m.freezesCast), freezesLanded = sumM(m => m.freezesLanded), escapes = sumM(m => m.escapes);
    const minHps = withMetrics.map(m => m.minHp).filter((v): v is number => v !== null);
    const weightedKillTicks = withMetrics.reduce((acc, m) => (m.avgKillTicks !== null && m.kills > 0 ? { ticks: acc.ticks + m.avgKillTicks * m.kills, kills: acc.kills + m.kills } : acc), { ticks: 0, kills: 0 });
    const avgKillTicks = weightedKillTicks.kills > 0 ? Math.round((weightedKillTicks.ticks / weightedKillTicks.kills) * 10) / 10 : null;
    const timed = runs.filter(r => r.ticks !== null), timedKills = timed.reduce((n, r) => n + r.kills, 0);
    const fallbackTicksPerKill = timedKills > 0 ? Math.round((timed.reduce((n, r) => n + (r.ticks ?? 0), 0) / timedKills) * 10) / 10 : null;
    return {
        ...base,
        avgKillTicks,
        ticksPerKill: avgKillTicks ?? fallbackTicksPerKill,
        minHp: minHps.length ? Math.min(...minHps) : null,
        sharksEaten, karamEaten, freezesCast, freezesLanded, escapes, hasMetrics,
        freezePct: freezesCast > 0 ? Math.round((freezesLanded / freezesCast) * 1000) / 10 : null,
        suppliesPerKill: hasMetrics && base.kills > 0 ? Math.round(((sharksEaten + karamEaten) / base.kills) * 10) / 10 : null,
    };
}
function readHostedEntries(dir: string): { condition: string; run: RichRun }[] {
    const find = (d: string, want: string): string | null => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) { if (p.replace(/\\/g, '/').endsWith(want)) return p; const deep = find(p, want); if (deep) return deep; } } return null; };
    const output = find(dir, 'aio-bench/output'), cases = find(dir, 'bench-cases'), bench = cases && existsSync(join(cases, 'bench.log')) ? readFileSync(join(cases, 'bench.log'), 'utf8') : '';
    if (!output) return [];
    const seed = Number(bench.match(/lockstep seed=(\d+)/)?.[1] ?? 0), ticks = new Map<string, number | null>(), keyByFile = new Map<string, string>();
    const sanitize = (k: string) => k.replace(/[^a-z0-9-]/gi, '_');
    for (const l of bench.split(/\r?\n/)) { const m = l.match(/^(\S+:\S+)\s+(pass|FAIL)\s+(\d+|-)/); if (m) { ticks.set(sanitize(m[1]!), m[3] === '-' ? null : Number(m[3])); keyByFile.set(sanitize(m[1]!), m[1]!); } }
    if (cases && existsSync(join(cases, 'cases.json'))) {
        try {
            const parsed = JSON.parse(readFileSync(join(cases, 'cases.json'), 'utf8')) as { rows?: { case: string; ledgerTicks?: number[] }[] };
            for (const r of parsed.rows ?? []) {
                const fileKey = sanitize(r.case);
                keyByFile.set(fileKey, r.case);
                if (!ticks.has(fileKey) && r.ledgerTicks?.length) ticks.set(fileKey, r.ledgerTicks.at(-1) ?? null);
            }
        } catch { /* ignore malformed cases.json */ }
    }
    return readdirSync(output).filter(f => f.endsWith('.log')).sort().flatMap(f => {
        const stem = f.slice(0, -4), condition = keyByFile.get(stem) ?? stem.replace(/^(extra|pvp)_/, '$1:');
        const run = parseRichRun(readFileSync(join(output, f), 'utf8'), seed, ticks.get(stem) ?? null);
        return run ? [{ condition, run }] : [];
    });
}
function readBatchEntries(dir: string): Map<string, RichRun[]> {
    const bench = existsSync(join(dir, 'bench.txt')) ? readFileSync(join(dir, 'bench.txt'), 'utf8') : '', ticks = parseTicks(bench), byCase = new Map<string, RichRun[]>();
    const seeds = readdirSync(dir).filter(d => /^seed-\d+$/.test(d)).map(d => Number(d.slice(5))).sort((a, b) => a - b);
    for (const [at, seed] of seeds.entries()) for (const file of readdirSync(join(dir, `seed-${seed}`)).filter(f => f.endsWith('.log'))) {
        const key = [...ticks.keys()].find(k => k.replace(/[^a-z0-9-]/gi, '_') === file.slice(0, -4)) ?? file.slice(0, -4);
        const run = parseRichRun(readFileSync(join(dir, `seed-${seed}`, file), 'utf8'), seed, ticks.get(key)?.[at] ?? null);
        if (run) (byCase.get(key) ?? byCase.set(key, []).get(key)!).push(run);
    }
    return byCase;
}
function readHostedRunEntries(dir: string): Map<string, RichRun[]> {
    const byCase = new Map<string, RichRun[]>();
    for (const sub of readdirSync(dir).filter(d => /^bench-p\d+-s\d+/.test(d)).sort()) for (const { condition, run } of readHostedEntries(join(dir, sub))) (byCase.get(condition) ?? byCase.set(condition, []).get(condition)!).push(run);
    return byCase;
}
// The rows of the artifact of a hosted bench run (`gh run download <id> --dir <dir>`): `aio-bench/output/<case>.log`
// and `bench-cases/bench.log`, whose table has one seed (the `lockstep seed=` of its start line).
export function hostedRows(dir: string, name = basename(dir)): Row[] {
    return readHostedEntries(dir).map(({ condition, run }) => row(name, condition, [run], returnTicks()));
}
export function batchRows(dir: string): Row[] {
    return [...readBatchEntries(dir)].sort((a, b) => a[0].localeCompare(b[0])).map(([key, runs]) => row(basename(dir), key, runs, returnTicks()));
}

// The rows of a run of scripts/hosted-bench.ts (.practice/hosted-bench/<run id>): one folder a pattern and a seed,
// each as the artifact of hostedRows. The runs of one case at its seeds are one row.
export function hostedRunRows(dir: string): Row[] {
    return [...readHostedRunEntries(dir)].sort((a, b) => a[0].localeCompare(b[0])).map(([key, runs]) => row(basename(dir), key, runs.sort((a, b) => a.seed - b.seed), returnTicks()));
}
/** Reads any batch or hosted-bench directory into RichRows (including SQUAD_METRICS summaries). */
export function readRichRows(dir: string, gangSize = 3): RichRow[] {
    const name = basename(dir), wait = returnTicks();
    if (existsSync(join(dir, 'bench.txt'))) return [...readBatchEntries(dir)].sort((a, b) => a[0].localeCompare(b[0])).map(([k, runs]) => richRow(name, k, runs, wait, gangSize));
    if (readdirSync(dir).some(x => /^bench-p\d+-s\d+/.test(x))) return [...readHostedRunEntries(dir)].sort((a, b) => a[0].localeCompare(b[0])).map(([k, runs]) => richRow(name, k, runs.sort((a, b) => a.seed - b.seed), wait, gangSize));
    return readHostedEntries(dir).map(({ condition, run }) => richRow(name, condition, [run], wait, gangSize));
}
// The bench against live, from the fidelity table of research/gang-clones.md. Two factors, because they differ:
//   damage  our attacks do this many times the live damage on the gang ("damage on the gang an attack of ours"), so a
//           live run takes that many times the ticks;
//   hp      the live gang took this many times the Hitpoints from our account that the clones take ("Hitpoints lost").
// The Hitpoints of a kill times `hp`, and the kills of an hour with the ticks of a run times `damage`.
export const biased = (r: Row, damage: number, hp: number, wait: number) => ({ hpAKill: r.hpAKill === null ? null : Math.round(r.hpAKill * hp),
    killsAnHour: r.ticksARun === null || r.killsAnHour === null ? null : Math.round((10 * r.killsAnHour * (r.ticksARun + wait)) / (r.ticksARun * damage + wait)) / 10 });

if (import.meta.main) {
    const argv = process.argv.slice(2), flag = (name: string) => { const at = argv.indexOf(name); return at >= 0 ? Number(argv.splice(at, 2)[1]) : 1; };
    const showMetrics = (() => { const at = argv.indexOf('--metrics'); if (at < 0) return false; argv.splice(at, 1); return true; })();
    const damage = flag('--bias-damage'), hp = flag('--bias-hp'), dirs = argv;
    if (!dirs.length || !(damage > 0) || !(hp > 0)) { console.log('usage: bun scripts/measure/pk-gang-climb.ts [--bias-damage <bench damage over live damage>] [--bias-hp <live Hitpoints lost over bench>] [--metrics] <batch folder> [...]'); process.exit(2); }
    const extraHead = showMetrics ? ' Ticks/kill | Freeze% | MinHP | Supplies/kill | Escapes |' : '';
    const extraSep = showMetrics ? '---|---|---|---|---|' : '';
    console.log(`| Batch | Condition | Kills | Deaths | Hitpoints lost a kill | Times ${hp} | Ticks a run | Kills an hour | With ticks times ${damage} | Account ticks a kill | Food coins a kill | Raw: kills, Hitpoints lost, ticks by seed |${extraHead}\n|---|---|---|---|---|---|---|---|---|---|---|---|${extraSep}`);
    for (const d of dirs) for (const r of readRichRows(d)) { const b = biased(r, damage, hp, returnTicks());
        const extraCell = showMetrics ? ` ${r.ticksPerKill ?? '-'} | ${r.freezePct === null ? '-' : `${r.freezePct}%`} | ${r.minHp ?? '-'} | ${r.suppliesPerKill ?? '-'} | ${r.hasMetrics ? r.escapes : '-'} |` : '';
        console.log(`| ${r.batch} | \`${r.condition}\` | ${r.kills} of ${r.gang} | ${r.deaths} | ${r.hpAKill ?? '-'} | ${b.hpAKill ?? '-'} | ${r.ticksARun ?? '-'} | ${r.killsAnHour ?? '-'} | ${b.killsAnHour ?? '-'} | ${r.accountTicksAKill ?? '-'} | ${r.coinsAKill ?? '-'} | ${r.runs.map(x => `${x.kills}, ${x.taken}, ${x.ticks ?? '-'}`).join('; ')} |${extraCell}`); }
}
