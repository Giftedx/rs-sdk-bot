// The climb table of the squad against the clones of the dagger gang (research/gang-clones.md, "The climb"): one
// row a condition from the kept logs of its bench runs.
//   bun scripts/measure/pk-gang-climb.ts <batch folder> [...]
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
export type Row = { batch: string; condition: string; runs: Run[]; kills: number; gang: number; deaths: number; hpAKill: number | null; ticksARun: number | null; killsAnHour: number | null; accountTicksAKill: number | null; coinsAKill: number | null };

// The RESULT line of the squad script in a case log. A run with a death of ours reads `RESULT fail died squad ...`.
export function parseRun(text: string, seed: number, ticks: number | null): Run | null {
    const line = text.split(/\r?\n/).reverse().find(l => /RESULT (ok|fail)( died)? squad/.test(l));
    if (!line) return null;
    const n = (key: string) => Number(line.match(new RegExp(`${key}=(\\d+)`))?.[1] ?? 0);
    return { seed, accounts: n('accounts'), kills: n('kills'), gangDied: n('gangDied'), died: n('died'), taken: n('taken'), trips: n('trips'), ticks };
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
export function batchRows(dir: string): Row[] {
    const bench = existsSync(join(dir, 'bench.txt')) ? readFileSync(join(dir, 'bench.txt'), 'utf8') : '', ticks = parseTicks(bench), byCase = new Map<string, Run[]>();
    const seeds = readdirSync(dir).filter(d => /^seed-\d+$/.test(d)).map(d => Number(d.slice(5))).sort((a, b) => a - b);
    for (const [at, seed] of seeds.entries()) for (const file of readdirSync(join(dir, `seed-${seed}`)).filter(f => f.endsWith('.log'))) {
        const key = [...ticks.keys()].find(k => k.replace(/[^a-z0-9-]/gi, '_') === file.slice(0, -4)) ?? file.slice(0, -4);
        const run = parseRun(readFileSync(join(dir, `seed-${seed}`, file), 'utf8'), seed, ticks.get(key)?.[at] ?? null);
        if (run) (byCase.get(key) ?? byCase.set(key, []).get(key)!).push(run);
    }
    return [...byCase].sort((a, b) => a[0].localeCompare(b[0])).map(([key, runs]) => row(basename(dir), key, runs, returnTicks()));
}

if (import.meta.main) {
    const dirs = process.argv.slice(2);
    if (!dirs.length) { console.log('usage: bun scripts/measure/pk-gang-climb.ts <batch folder> [...]'); process.exit(2); }
    console.log('| Batch | Condition | Kills | Deaths | Hitpoints lost a kill | Ticks a run | Kills an hour | Account ticks a kill | Food coins a kill | Raw: kills, Hitpoints lost, ticks by seed |\n|---|---|---|---|---|---|---|---|---|---|');
    for (const d of dirs) for (const r of batchRows(d))
        console.log(`| ${r.batch} | \`${r.condition}\` | ${r.kills} of ${r.gang} | ${r.deaths} | ${r.hpAKill ?? '-'} | ${r.ticksARun ?? '-'} | ${r.killsAnHour ?? '-'} | ${r.accountTicksAKill ?? '-'} | ${r.coinsAKill ?? '-'} | ${r.runs.map(x => `${x.kills}, ${x.taken}, ${x.ticks ?? '-'}`).join('; ')} |`);
}
