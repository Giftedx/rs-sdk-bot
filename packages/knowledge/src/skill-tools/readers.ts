import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { contentRoot, knowledgeDir } from '../paths';
import type { AppliesTo, Cite, Rung, ToolRecord } from './types';

const fileCache = new Map<string, string[]>();

/** Cached lines of a content-relative file. */
export function lines(rel: string): string[] {
    let l = fileCache.get(rel);
    if (!l) {
        const p = join(contentRoot(), rel);
        l = existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/) : [];
        fileCache.set(rel, l);
    }
    return l;
}

/** First line matching `re` (after the first line matching `after`, when given). */
export function cite(rel: string, re: RegExp, after?: RegExp): Cite | null {
    const l = lines(rel);
    let i = 0;
    if (after) {
        i = l.findIndex(x => after.test(x));
        if (i < 0) return null;
    }
    for (; i < l.length; i++) if (re.test(l[i]!)) return { src: `${rel}:${i + 1}`, text: l[i]!.trim() };
    return null;
}

export interface ObjBlock { name: string; line: number; params: Record<string, { value: string; line: number }> }

/** Parse `[section]` blocks and their `param=` / `key=` fields with 1-based lines. */
export function configBlocks(rel: string): Map<string, ObjBlock> {
    const out = new Map<string, ObjBlock>();
    let cur: ObjBlock | null = null;
    lines(rel).forEach((t, i) => {
        const h = /^\[([^\]]+)\]\s*$/.exec(t);
        if (h) { cur = { name: h[1]!, line: i + 1, params: {} }; out.set(h[1]!, cur); return; }
        if (!cur) return;
        const p = /^param=([a-z_0-9]+),(.*)$/.exec(t);
        if (p) cur.params[p[1]!] = { value: p[2]!.trim(), line: i + 1 };
        const kv = /^([a-z_0-9]+)=(.*)$/.exec(t);
        if (kv && kv[1] !== 'param' && !(kv[1]! in cur.params)) cur.params[kv[1]!] = { value: kv[2]!.trim(), line: i + 1 };
    });
    return out;
}

/** Sorted content-relative paths ending with `ext` under `rel`. */
export function walk(rel: string, ext: string): string[] {
    const abs = join(contentRoot(), rel);
    if (!existsSync(abs)) return [];
    const out: string[] = [];
    for (const n of readdirSync(abs)) {
        const r = `${rel}/${n}`;
        if (statSync(join(abs, n)).isDirectory()) out.push(...walk(r, ext));
        else if (n.endsWith(ext)) out.push(r);
    }
    return out.sort();
}

let itemIds: Map<string, number> | null = null;

/** Lookup an item id by debugname from `knowledge/items.json`. */
export function itemId(debugname: string): number | null {
    if (!itemIds) {
        itemIds = new Map();
        const p = join(knowledgeDir(), 'items.json');
        if (existsSync(p)) for (const it of JSON.parse(readFileSync(p, 'utf8')) as { id: number; debugname: string }[]) itemIds.set(it.debugname, it.id);
    }
    return itemIds.get(debugname) ?? null;
}

/** Load ladder rungs from `knowledge/ladders.json`. */
export function loadRungs(): Rung[] {
    const p = join(knowledgeDir(), 'ladders.json');
    if (!existsSync(p)) return [];
    const j = JSON.parse(readFileSync(p, 'utf8')) as { ladders: Record<string, Rung[]> };
    return Object.values(j.ladders).flat();
}

/** Output path for the generated `knowledge/skill-tools.json` artifact. */
export function skillToolsJsonPath(): string {
    return join(knowledgeDir(), 'skill-tools.json');
}

/** Match rungs belonging to `skill` and `kinds`/`idPattern`. */
export function applies(rungs: Rung[], skill: string, kinds: string[], idPattern?: RegExp): AppliesTo {
    const hit = rungs.filter(r => r.skill === skill && (kinds.length === 0 || kinds.includes(r.kind)) && (!idPattern || idPattern.test(r.id)));
    return { kinds, idPattern: idPattern ? idPattern.source : null, rungs: (kinds.length || idPattern) ? hit.map(r => r.id) : [] };
}

/** Construct an empty `ToolRecord` skeleton. */
export function emptyRecord(id: string, skill: string, appliesTo: AppliesTo, src: string): ToolRecord {
    return { id, skill, appliesTo, minLevel: null, levelSrc: null, items: [], consumed: [], locs: [], conditions: [], gaps: [], src };
}

/** Attack level to wield, from `levelrequire/scripts/*.rs2` `[opheld2,<obj>]`. */
export function wieldAttack(obj: string): { level: number | null; src: string | null; gap?: string } {
    for (const f of walk('scripts/levelrequire/scripts', '.rs2')) {
        const c = cite(f, new RegExp(`^\\[opheld2,${obj}\\]`));
        if (!c) continue;
        const m = /@levelrequire_attack\((\d+),/.exec(c.text);
        if (m) return { level: Number(m[1]), src: c.src };
        if (/@tutorial_island_equip/.test(c.text)) {
            const t = cite('scripts/tutorial/scripts/tutorial.rs2', /^@levelrequire_attack\((\d+), \$slot\)/, /^\[label,tutorial_island_equip\]/);
            if (t) return { level: Number(/\((\d+),/.exec(t.text)![1]), src: t.src };
        }
        return { level: null, src: c.src, gap: `${obj}: wield trigger ${c.src} does not call levelrequire_attack` };
    }
    return { level: null, src: null, gap: `${obj}: no [opheld2,${obj}] trigger in levelrequire/scripts` };
}
