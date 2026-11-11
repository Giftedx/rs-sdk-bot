// Ranks kits from the MATRIX lines of scripts/measure/pk-spar-matrix.ts: for each kit its fights, wins, losses and
// draws over all pairs, its mean net damage for each 100 ticks, and its result against each other kit.
// Usage: bun scripts/measure/pk-build-rank.ts <matrix log> [<matrix log> ...]
import { readFileSync } from 'node:fs';
import { combatLevel, KITS, kitSkills } from '../pk-kits';

export type RankRow = { kit: string; combat: number | null; fights: number; wins: number; losses: number; draws: number; winRate: number; net: number; against: Record<string, string> };
type Cell = { matchup: string; fights: number; kills: number; deaths: number; net: number };

// `lines` are log lines; a line that is not a MATRIX line is skipped. Side A of a matchup is its first kit. A
// matchup with a profile (`a:b/base`) counts for its two kits.
export function rankKits(lines: readonly string[]): RankRow[] {
    const rows = new Map<string, { fights: number; wins: number; losses: number; draws: number; net: number }>();
    const row = (kit: string) => rows.get(kit) ?? rows.set(kit, { fights: 0, wins: 0, losses: 0, draws: 0, net: 0 }).get(kit)!;
    const pairs = new Map<string, { first: string; second: string; winsFirst: number; winsSecond: number }>();
    for (const line of lines) {
        if (!line.startsWith('MATRIX {')) continue;
        const m = JSON.parse(line.slice(7)) as Cell;
        const [a, b] = m.matchup.split('/')[0]!.split(':') as [string, string], draws = m.fights - m.kills - m.deaths;
        const ra = row(a), rb = row(b);
        ra.fights += m.fights; ra.wins += m.kills; ra.losses += m.deaths; ra.draws += draws; ra.net += m.net * m.fights;
        // A kit against itself is one row: side B's results are side A's turned over.
        if (a !== b) { rb.fights += m.fights; rb.wins += m.deaths; rb.losses += m.kills; rb.draws += draws; rb.net -= m.net * m.fights; }
        const [first, second] = [a, b].sort() as [string, string], key = `${first}:${second}`;
        const p = pairs.get(key) ?? pairs.set(key, { first, second, winsFirst: 0, winsSecond: 0 }).get(key)!;
        if (first === a) { p.winsFirst += m.kills; p.winsSecond += m.deaths; } else { p.winsFirst += m.deaths; p.winsSecond += m.kills; }
    }
    const against = new Map<string, Record<string, string>>();
    const versus = (kit: string) => against.get(kit) ?? against.set(kit, {}).get(kit)!;
    for (const p of pairs.values()) { versus(p.first)[p.second] = `${p.winsFirst}-${p.winsSecond}`; if (p.first !== p.second) versus(p.second)[p.first] = `${p.winsSecond}-${p.winsFirst}`; }
    return [...rows].map(([kit, r]) => ({ kit, combat: KITS[kit] ? combatLevel(kitSkills(kit)) : null, fights: r.fights, wins: r.wins, losses: r.losses, draws: r.draws,
        winRate: Number((r.wins / Math.max(1, r.fights)).toFixed(2)), net: Number((r.net / Math.max(1, r.fights)).toFixed(1)), against: versus(kit) }))
        .sort((x, y) => y.winRate - x.winRate || y.net - x.net || x.kit.localeCompare(y.kit));
}

if (import.meta.main) {
    const files = process.argv.slice(2);
    if (!files.length) { console.log('usage: bun scripts/measure/pk-build-rank.ts <matrix log> [<matrix log> ...]'); process.exit(2); }
    const ranked = rankKits(files.flatMap(f => readFileSync(f, 'utf8').split(/\r?\n/)));
    for (const { against, ...r } of ranked) console.log(`RANK ${JSON.stringify(r)}`);
    for (const r of ranked) console.log(`PAIRS ${r.kit} ${Object.entries(r.against).map(([k, v]) => `${k} ${v}`).join(', ')}`);
}
