import type { SourceCatalog } from './lookup';
import { cost, r3, type DropSource } from './model';

type KnowledgeDrop = SourceCatalog['drops'][number];

// npc_combat.param: death_drop default=bones (line 31).
const DEATH_DEFAULT = { item: 'bones', src: 'scripts/skill_combat/configs/npc_combat.param:31' };
// A branch nested only in `if (map_members = ^true)` is open on this members world (vendor/rs-sdk/fly.toml).
const MEMBERS_ONLY = /^(\}\s*else\s*)?if\s*\(\s*map_members\s*=\s*\^?true\s*\)\s*\{?$/;

type DropRow = { item: string; chance: number; count: number; countMax: number; conditional: boolean; src: string; via: string | null };
type ProcRow = { item?: string; ref?: string; chance: number; count: number; conditional: boolean; src: string };

// The nearest `if` that encloses a content line (less indented, up to 6 lines above), or null.
function enclosingIf(src: string, linesOf: (rel: string) => string[]): string | null {
    const i = src.lastIndexOf(':'), lines = linesOf(src.slice(0, i)), at = Number(src.slice(i + 1)) - 1;
    const indent = (s: string) => s.match(/^\s*/)![0].length;
    for (let k = at - 1; k >= Math.max(0, at - 6); k--) if (/\bif\s*\(/.test(lines[k]!) && indent(lines[k]!) < indent(lines[at]!)) return lines[k]!.trim();
    return null;
}

// Shared drop procs (drop tables/scripts/shared_droptables.rs2): cumulative `$random < T` branches over random(N),
// each ending in `return (item, count)` or `return (~proc)`. A branch with a further `if` is conditional.
function parseProcTables(linesOf: (rel: string) => string[]): Map<string, ProcRow[]> {
    const procTables = new Map<string, ProcRow[]>();
    const file = 'scripts/drop tables/scripts/shared_droptables.rs2';
    let name = '', die = 0, prev = 0, at = 0, cond = false;
    linesOf(file).forEach((line, i) => {
        const h = line.match(/^\[proc,(\w+)\]/);
        if (h) { name = h[1]!; die = 0; prev = 0; procTables.set(name, []); return; }
        if (!name) return;
        for (const m of line.matchAll(/random\((\d+)\)/g)) die = Math.max(die, Number(m[1]));
        const t = line.match(/\$random < (\d+)/);
        if (t) { prev = at; at = Number(t[1]); cond = false; return; }
        if (/^\s+if\s*\(/.test(line) && !/^\s+if\s*\(\s*map_members\s*=\s*\^true\s*\)\s*\{?\s*$/.test(line)) cond = true;
        const ret = line.match(/return\s*\((?:(\w+),\s*(\d+)|~(\w+))\)/);
        if (ret && die && at) {
            const chance = (at - prev) / die;
            procTables.get(name)!.push(ret[3]
                ? { ref: ret[3], chance, count: 1, conditional: cond, src: `${file}:${i + 1}` }
                : { item: ret[1]!, chance, count: Number(ret[2]), conditional: cond, src: `${file}:${i + 1}` });
        }
    });
    return procTables;
}

function procRows(procTables: ReadonlyMap<string, ProcRow[]>, name: string, factor: number, depth = 0): DropRow[] {
    return (procTables.get(name) ?? []).flatMap(r => r.ref
        ? (depth < 3 ? procRows(procTables, r.ref, factor * r.chance, depth + 1) : [])
        : [{ item: r.item!, chance: factor * r.chance, count: r.count, countMax: r.count, conditional: r.conditional, src: r.src, via: name }]);
}

function rowsOf(
    labels: ReadonlyMap<string, KnowledgeDrop>,
    procTables: ReadonlyMap<string, ProcRow[]>,
    d: { always: any[]; rolls: any[]; uses?: string },
    factor = 1,
    via: string | null = null,
    depth = 0,
): DropRow[] {
    const out: DropRow[] = [];
    for (const a of d.always) out.push({ item: a.item, chance: factor, count: a.count, countMax: a.count, conditional: a.conditional, src: a.src, via });
    for (const r of d.rolls) {
        if (r.item) out.push({ item: r.item, chance: factor * r.chance, count: r.count ?? 1, countMax: r.countMax ?? r.count ?? 1, conditional: r.conditional, src: r.src, via });
        else if (r.table && labels.has(r.table) && depth < 2) out.push(...rowsOf(labels, procTables, labels.get(r.table)!, factor * r.chance, r.table, depth + 1));
        else if (r.table && procTables.has(r.table)) out.push(...procRows(procTables, r.table, factor * r.chance).map(x => ({ ...x, conditional: x.conditional || r.conditional })));
    }
    if (d.uses && labels.has(d.uses) && depth < 2) out.push(...rowsOf(labels, procTables, labels.get(d.uses)!, factor, d.uses, depth + 1));
    return out;
}

export function buildDropSources(catalog: SourceCatalog): Map<string, DropSource[]> {
    const procTables = parseProcTables(catalog.linesOf);
    // Drop tables by npc, with shared label tables and drop procs expanded.
    const labels = new Map(catalog.drops.filter(d => d.trigger.startsWith('label:')).map(d => [d.trigger.slice(6), d]));
    const dropSources = new Map<string, DropSource[]>();

    const addDrop = (trigger: string, names: string[], row: DropRow) => {
        if (!catalog.needed.has(row.item)) return;
        // A condition on a varp (%name) is quest or account state: a gate. Area or inventory conditions are kept as text only.
        const condition = row.conditional ? enclosingIf(row.src, catalog.linesOf) : null;
        if (condition && MEMBERS_ONLY.test(condition)) row = { ...row, conditional: false };
        const gate = row.conditional && (condition === null || condition.includes('%')) ? `state condition: ${condition ?? 'not found near the drop line'}` : null;
        const places = names.map(catalog.npcPlace).filter(p => p.spawns > 0);
        const combat = names.map(n => catalog.npcByName.get(n)?.combat).filter((c): c is number => typeof c === 'number');
        const avg = (row.count + row.countMax) / 2, wild = places.length > 0 && places.every(p => p.wilderness);
        let list = dropSources.get(row.item);
        if (!list) { list = []; dropSources.set(row.item, list); }
        list.push({
            kind: 'drop', npc: trigger, combat: combat.length ? Math.min(...combat) : null, chance: Math.round(row.chance * 1e6) / 1e6, countMin: row.count, countMax: row.countMax,
            conditional: row.conditional, condition: row.conditional ? condition : null, via: row.via, places, src: row.src, gate,
            blocked: places.length === 0 ? 'no spawn of this npc in the maps' : null,
            cost: cost({
                ticksNote: `${r3(1 / (row.chance * avg))} kills per unit (content drop rate); kill time not modelled: npc hitpoints are not in knowledge/npcs.json`,
                coinsPerUnit: 0, coinsBasis: 'content', coinsNote: 'no coins spent; food and ammunition are not counted',
                risk: null, riskBasis: wild ? 'model' : 'unknown', riskNote: `npc combat ${combat.length ? Math.min(...combat) : '?'}; death chance not modelled${wild ? '; every spawn is in the Wilderness, so a death loses carried items' : ''}`,
            }),
        });
    };

    const tabled = new Set<string>();
    for (const d of catalog.drops) {
        if (d.trigger.startsWith('label:')) continue;
        const names = catalog.npcsFor(d.trigger);
        names.forEach(n => tabled.add(n));
        for (const row of rowsOf(labels, procTables, d)) {
            if (row.item !== 'death_drop') { addDrop(d.trigger, names, row); continue; }
            // npc_param(death_drop): each npc's own param, default bones.
            const byItem = new Map<string, string[]>();
            for (const n of names) {
                const dd = catalog.deathDrop.get(n) ?? DEATH_DEFAULT;
                if (dd.item !== 'null') {
                    let list = byItem.get(dd.item);
                    if (!list) { list = []; byItem.set(dd.item, list); }
                    list.push(n);
                }
            }
            for (const [item, ns] of byItem) addDrop(d.trigger, ns, { ...row, item, src: row.src, via: `death_drop param (${(catalog.deathDrop.get(ns[0]!) ?? DEATH_DEFAULT).src})` });
        }
    }

    // Attackable npcs with no drop table of their own die by npc_default_death (npc_combat.rs2:97-101): their death_drop.
    for (const n of catalog.attackable) {
        if (tabled.has(n)) continue;
        const dd = catalog.deathDrop.get(n) ?? DEATH_DEFAULT;
        if (dd.item !== 'null') addDrop(n, [n], { item: dd.item, chance: 1, count: 1, countMax: 1, conditional: false, src: dd.src, via: 'npc_default_death (scripts/skill_combat/scripts/npc/npc_combat.rs2:97)' });
    }
    return dropSources;
}
