// Writes client-assets/resources.json for the World plugin's respawn timers (RuneLite's Mining and Woodcutting
// plugins): every mining rock and every tree better than a normal one, with its tile, its name and its base respawn
// time, and the loc ids that a depleted rock or a stump changes into. From the pinned server's content: the map
// squares (maps/m<mx>_<mz>.jm2, LOC lines "level x z: id shape angle"), the mining and woodcutting tables
// (mine.dbrow rock_respawnrate, trees.dbrow respawnrate; 0 means 120 + random 80 ticks) and the loc configs
// (param next_loc_stage_mining / next_loc_stage). The server scales each respawn by the players online
// (general/scripts/player_count.rs2): ticks = base * (4000 - min(players, 2000)) / 4000.
// Run: bun packages/dashboard/gen-resources.ts
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Kind = { name: string; base: number | null; min: number | null; max: number | null };

export function packIds(text: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const line of text.split(/\r?\n/)) { const m = line.match(/^(\d+)=(.+)$/); if (m) out.set(m[2]!.trim(), Number(m[1])); }
    return out;
}

// [name] blocks of a config file, each with its param lines.
export function nextStages(text: string, param: string): Map<string, string> {
    const out = new Map<string, string>();
    let name = '';
    for (const line of text.split(/\r?\n/)) {
        const head = line.match(/^\[(.+)\]$/);
        if (head) { name = head[1]!; continue; }
        const p = line.match(/^param=([a-z_]+),(.+)$/);
        if (p && p[1] === param && name) out.set(name, p[2]!.trim());
    }
    return out;
}

// [table] blocks of a dbrow file: the members (data=<field>,<name>) with the table's label and respawn field.
export function tableRows(text: string, member: string, respawn: string): { table: string; names: string[]; label: string; respawn: number }[] {
    const out: { table: string; names: string[]; label: string; respawn: number }[] = [];
    let cur: { table: string; names: string[]; label: string; respawn: number } | null = null;
    for (const line of text.split(/\r?\n/)) {
        const head = line.match(/^\[(.+)\]$/);
        if (head) { cur = { table: head[1]!, names: [], label: '', respawn: 0 }; out.push(cur); continue; }
        if (!cur) continue;
        const d = line.match(/^data=([a-z_]+),(.+)$/);
        if (!d) continue;
        if (d[1] === member) cur.names.push(d[2]!.trim());
        else if (d[1] === 'ore_name') cur.label = d[2]!.trim();
        else if (d[1] === respawn) cur.respawn = Number(d[2]) || 0;
    }
    return out;
}

const title = (s: string) => s.replace(/^./, c => c.toUpperCase());

export function buildResources(content: string) {
    const ids = packIds(readFileSync(join(content, 'pack', 'loc.pack'), 'utf8'));
    const mining = join(content, 'scripts', 'skill_mining', 'configs'), wc = join(content, 'scripts', 'skill_woodcutting', 'configs');
    const rockNext = nextStages(readFileSync(join(mining, 'rocks.loc'), 'utf8'), 'next_loc_stage_mining');
    const treeNext = new Map<string, string>();
    for (const f of readdirSync(join(wc, 'trees'))) for (const [k, v] of nextStages(readFileSync(join(wc, 'trees', f), 'utf8'), 'next_loc_stage')) treeNext.set(k, v);
    const kinds: Record<number, Kind> = {}, depleted = new Set<number>();
    const add = (name: string, next: string | undefined, kind: Kind) => {
        const id = ids.get(name), stage = next ? ids.get(next) : undefined;
        if (id === undefined || stage === undefined) return;
        kinds[id] = kind; depleted.add(stage);
    };
    for (const row of tableRows(readFileSync(join(mining, 'mine.dbrow'), 'utf8'), 'rock', 'rock_respawnrate'))
        for (const name of row.names) if (row.respawn > 0) add(name, rockNext.get(name), { name: title(row.label || row.table.replace(/_table$/, '')) + ' rock', base: row.respawn, min: null, max: null });
    for (const row of tableRows(readFileSync(join(wc, 'trees.dbrow'), 'utf8'), 'tree', 'respawnrate')) {
        if (/^(normal|burnt|jungle)_tree_table$/.test(row.table)) continue;
        const label = title(row.table.replace(/_tree_table$/, '')) + ' tree';
        for (const name of row.names) add(name, treeNext.get(name), row.respawn > 0 ? { name: label, base: row.respawn, min: null, max: null } : { name: label, base: null, min: 120, max: 199 });
    }
    const tiles: [number, number, number, number][] = [];
    const maps = join(content, 'maps');
    for (const f of readdirSync(maps)) {
        const m = f.match(/^m(\d+)_(\d+)\.jm2$/);
        if (!m) continue;
        const mx = Number(m[1]) * 64, mz = Number(m[2]) * 64;
        let inLoc = false;
        for (const line of readFileSync(join(maps, f), 'utf8').split(/\r?\n/)) {
            if (line.startsWith('====')) { inLoc = line.includes('LOC'); continue; }
            if (!inLoc) continue;
            const l = line.match(/^(\d+) (\d+) (\d+): (\d+)/);
            if (l && kinds[Number(l[4])]) tiles.push([mx + Number(l[2]), mz + Number(l[3]), Number(l[1]), Number(l[4])]);
        }
    }
    return { kinds, depleted: [...depleted].sort((a, b) => a - b), tiles };
}

if (import.meta.main) {
    const content = join(import.meta.dir, '..', '..', 'vendor', 'rs-sdk', 'server', 'content');
    const r = buildResources(content);
    writeFileSync(join(import.meta.dir, 'client-assets', 'resources.json'), JSON.stringify(r));
    console.log(`resources.json: ${Object.keys(r.kinds).length} loc kinds, ${r.depleted.length} depleted forms, ${r.tiles.length} tiles`);
}
