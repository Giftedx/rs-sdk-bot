// Writes client-assets/item-stats.json: what each food and potion does, by item name, from the pinned server's
// consumption table (content/scripts/player/configs/consumption). Run: bun packages/dashboard/gen-item-stats.ts
import {readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const content = join(import.meta.dir, '../../vendor/rs-sdk/server/content/scripts');
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const signed = (n: number) => (n > 0 ? '+' : '') + n;

/** One effect line for a consumable row. A restore of more than six stats by one amount is one "all stats" part. */
export function effectText(rows: string[][]): string {
    const parts: string[] = [], restores = new Map<string, string[]>();
    for (const [kind, stat, a, b] of rows) {
        const n = Number(a), pct = Number(b);
        if (kind === 'healenergy') parts.push('run energy ' + signed(Number(stat) / 100) + '%');
        else if (kind === 'stat_heal' && stat === 'hitpoints') { if (n || pct) parts.push('heals ' + [n ? String(n) : '', pct ? pct + '%' : ''].filter(Boolean).join(' + ')); }
        else if (kind === 'stat_heal') { const amount = [n ? String(n) : '', pct ? pct + '%' : ''].filter(Boolean).join(' + '); restores.set(amount, [...(restores.get(amount) || []), cap(stat!)]); }
        else if (kind === 'stat_change') parts.push(cap(stat!) + ' ' + [n ? signed(n) : '', pct ? signed(pct) + '%' : ''].filter(Boolean).join(' '));
    }
    for (const [amount, stats] of restores) parts.push('restores ' + (stats.length > 6 ? 'all stats' : stats.join(', ')) + ' ' + amount);
    return parts.join(' · ');
}

function files(dir: string, ext: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, {withFileTypes: true})) {
        if (e.isDirectory()) files(join(dir, e.name), ext, out);
        else if (e.name.endsWith(ext)) out.push(join(dir, e.name));
    }
    return out;
}

/** The sections of a config file: [id] and its key=value lines. */
function sections(text: string): {id: string; lines: string[]}[] {
    const out: {id: string; lines: string[]}[] = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim(), head = /^\[(.+)\]$/.exec(line);
        if (head) out.push({id: head[1]!, lines: []});
        else if (line && !line.startsWith('//') && out.length) out.at(-1)!.lines.push(line);
    }
    return out;
}

if (import.meta.main) {
    const names = new Map<string, string>();
    for (const f of files(content, '.obj')) for (const s of sections(readFileSync(f, 'utf8'))) {
        const name = s.lines.find(l => l.startsWith('name='));
        if (name) names.set(s.id, name.slice(5));
    }
    const stats: Record<string, string> = {}, clash = new Set<string>();
    for (const f of files(join(content, 'player/configs/consumption'), '.dbrow')) for (const s of sections(readFileSync(f, 'utf8'))) {
        if (!s.lines.includes('table=consume_table')) continue;
        const data = s.lines.filter(l => l.startsWith('data=')).map(l => l.slice(5).split(','));
        const text = effectText(data.filter(d => d[0] !== 'consumable' && d[0] !== 'consume_sound'));
        if (!text) continue;
        for (const d of data.filter(d => d[0] === 'consumable')) {
            const name = names.get(d[1]!);
            if (!name) continue;
            if (stats[name] && stats[name] !== text) clash.add(name);
            stats[name] = text;
        }
    }
    // Two items with one name and different effects: the name alone cannot say which, so the page shows neither.
    for (const name of clash) delete stats[name];
    const sorted = Object.fromEntries(Object.entries(stats).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(join(import.meta.dir, 'client-assets/item-stats.json'), JSON.stringify(sorted, null, 0) + '\n');
    console.log(Object.keys(sorted).length + ' items, ' + clash.size + ' names left out');
}
