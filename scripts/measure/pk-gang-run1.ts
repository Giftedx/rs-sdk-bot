// The first live squad run against its bench replay (research/gang-clones.md, "Fidelity of the first live squad run"):
// the measures of the squad log of a run, from the SQUAD lines and the PK kill lines of scripts/pk-squad.ts.
//   bun scripts/measure/pk-gang-run1.ts live <squad log>               the measures of the live log
//   bun scripts/measure/pk-gang-run1.ts table <live log> <case log> [...]   the table of a case at its seeds beside the live run
import { readFileSync } from 'node:fs';

export type Run = { kills: number; taken: number; hpAKill: number | null; killTicks: number[]; meanKillTicks: number | null; takenBy: number[]; membersHit: number; deaths: number };
// The measures of one squad log. `takenBy` is the Hitpoints that each member lost, in the order of the SQUAD lines.
export function parseSquadLog(text: string): Run {
    const members = text.split(/\r?\n/).flatMap(l => { const i = l.indexOf('SQUAD {'); if (i < 0) return []; try { return [JSON.parse(l.slice(i + 6)) as { kills: number; taken: number; died?: boolean }]; } catch { return []; } });
    const killTicks = [...text.matchAll(/PK kill \S+ after (\d+) ticks/g)].map(m => Number(m[1]));
    const result = text.split(/\r?\n/).reverse().find(l => /RESULT (ok|fail)( died)? squad/.test(l)) ?? '';
    const num = (key: string) => Number(result.match(new RegExp(`${key}=(\\d+)`))?.[1] ?? 0);
    const kills = num('kills'), taken = num('taken'), takenBy = members.map(m => m.taken);
    return { kills, taken, hpAKill: kills ? Math.round(taken / kills) : null, killTicks, meanKillTicks: killTicks.length ? Math.round(killTicks.reduce((a, b) => a + b, 0) / killTicks.length) : null, takenBy, membersHit: takenBy.filter(t => t > 0).length, deaths: num('died') };
}
const pct = (bench: number | null, live: number | null) => (bench === null || !live ? '-' : `${bench >= live ? '+' : ''}${Math.round((100 * (bench - live)) / live)}%`);
// One row for each measure: the live value, the bench mean over the runs and the error of the bench.
export function runTable(live: Run, runs: Run[]): string[] {
    const mean = (pick: (r: Run) => number | null) => { const v = runs.map(pick).filter((x): x is number => x !== null); return v.length ? Math.round((10 * v.reduce((a, b) => a + b, 0)) / v.length) / 10 : null; };
    const rows: [string, number | null, number | null][] = [
        ['kills a run', live.kills, mean(r => r.kills)], ['Hitpoints lost a kill', live.hpAKill, mean(r => r.hpAKill)], ['ticks of a fight to its kill', live.meanKillTicks, mean(r => r.meanKillTicks)],
        ['members that lost Hitpoints', live.membersHit, mean(r => r.membersHit)], ['deaths of ours', live.deaths, mean(r => r.deaths)],
    ];
    return rows.map(([m, l, b]) => `| ${m} | ${l ?? '-'} | ${b ?? '-'} | ${pct(b, l)} |`);
}

if (import.meta.main) {
    const [mode, liveFile, ...logs] = process.argv.slice(2);
    if (!mode || !liveFile) { console.log('usage: bun scripts/measure/pk-gang-run1.ts live <squad log> | table <live log> <case log> [...]'); process.exit(2); }
    const live = parseSquadLog(readFileSync(liveFile, 'utf8'));
    console.log(`LIVE ${JSON.stringify(live)}`);
    if (mode === 'table') {
        const runs = logs.map(f => parseSquadLog(readFileSync(f, 'utf8')));
        for (const [i, r] of runs.entries()) console.log(`RUN ${i + 1} ${JSON.stringify(r)}`);
        console.log('| Measure | Live | Bench mean | Error |\n|---|---|---|---|');
        for (const row of runTable(live, runs)) console.log(row);
    }
}
