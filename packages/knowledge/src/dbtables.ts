import type { ConfigBlock } from './config';

// Generic reader for RuneScript dbtables (`column=name,type,...`) and dbrows (`table=x`, `data=col,v1,v2`).
// Skill tables (trees, rocks, cooking, fletching, pickpocket, ...) are all in this shape, so the planner
// gets levels, XP and products for every table from one reader. Values stay strings; XP is in tenths.

export interface DbColumn { name: string; types: string[] }
export interface DbRow {
    name: string;
    data: Record<string, string[][]>; // column -> one string[] per data= line (list columns repeat)
    src: Record<string, string[]>; // column -> file:line per value line
    def: string; // file:line of the [row] header
}
export interface DbTable { table: string; columns: DbColumn[]; def: string | null; rows: DbRow[] }

export function buildDbTables(tableBlocks: ConfigBlock[], rowBlocks: ConfigBlock[]): DbTable[] {
    const tables = new Map<string, DbTable>();
    for (const b of tableBlocks) {
        const columns = (b.props.column ?? []).map(c => {
            const [name, ...types] = c.split(',');
            return { name: name!, types };
        });
        tables.set(b.name, { table: b.name, columns, def: `${b.file}:${b.line}`, rows: [] });
    }
    for (const b of rowBlocks) {
        const table = b.props.table?.[0];
        if (!table) continue;
        if (!tables.has(table)) tables.set(table, { table, columns: [], def: null, rows: [] });
        const row: DbRow = { name: b.name, data: {}, src: {}, def: `${b.file}:${b.line}` };
        (b.props.data ?? []).forEach((d, i) => {
            const [col, ...vals] = d.split(',');
            (row.data[col!] ??= []).push(vals);
            (row.src[col!] ??= []).push(`${b.file}:${b.propLines.data![i]}`);
        });
        tables.get(table)!.rows.push(row);
    }
    return [...tables.values()].sort((a, b) => a.table.localeCompare(b.table));
}
