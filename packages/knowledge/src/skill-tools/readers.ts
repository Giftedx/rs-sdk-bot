import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { contentRoot, knowledgeDir } from '../paths';
import type { AppliesTo, Cite, Rung, ToolRecord } from './types';

const fileCache = new Map<string, { sig: string; lines: string[] }>();
const blockCache = new Map<string, { sig: string; blocks: Map<string, ObjBlock> }>();

function statSig(absPath: string): string | null {
    try {
        const st = statSync(absPath);
        return `${st.mtimeMs}:${st.size}`;
    } catch {
        return null;
    }
}

/** Cached lines of a content-relative file. */
export function lines(rel: string): string[] {
    const root = contentRoot();
    const p = join(root, rel);
    const key = `${root}\0${rel}`;
    const sig = statSig(p);
    if (!sig) {
        fileCache.delete(key);
        return [];
    }
    const cached = fileCache.get(key);
    if (cached && cached.sig === sig) return cached.lines;
    const l = readFileSync(p, 'utf8').split(/\r?\n/);
    fileCache.set(key, { sig, lines: l });
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
    const root = contentRoot();
    const p = join(root, rel);
    const key = `${root}\0${rel}`;
    const sig = statSig(p);
    if (!sig) {
        blockCache.delete(key);
        return new Map();
    }
    const cached = blockCache.get(key);
    if (cached && cached.sig === sig) return cached.blocks;
    const out = new Map<string, ObjBlock>();
    let cur: ObjBlock | null = null;
    const ls = lines(rel);
    for (let i = 0; i < ls.length; i++) {
        const t = ls[i]!;
        if (t.charCodeAt(0) === 91 /* '[' */) {
            const h = /^\[([^\]]+)\]\s*$/.exec(t);
            if (h) { cur = { name: h[1]!, line: i + 1, params: {} }; out.set(h[1]!, cur); continue; }
        }
        if (!cur || !t) continue;
        if (t.startsWith('param=')) {
            const c = t.indexOf(',', 6);
            if (c > 6) {
                const k = t.slice(6, c);
                if (/^[a-z_0-9]+$/.test(k)) cur.params[k] = { value: t.slice(c + 1).trim(), line: i + 1 };
            }
            continue;
        }
        const eq = t.indexOf('=');
        if (eq > 0) {
            const k = t.slice(0, eq);
            if (k !== 'param' && /^[a-z_0-9]+$/.test(k) && !(k in cur.params)) {
                cur.params[k] = { value: t.slice(eq + 1).trim(), line: i + 1 };
            }
        }
    }
    blockCache.set(key, { sig, blocks: out });
    return out;
}

/** Sorted content-relative paths ending with `ext` under `rel`. */
export function walk(rel: string, ext: string): string[] {
    const root = contentRoot();
    const abs = join(root, rel);
    if (!existsSync(abs)) return [];
    const out: string[] = [];
    const visit = (dirRel: string, dirAbs: string) => {
        for (const e of readdirSync(dirAbs, { withFileTypes: true })) {
            const r = `${dirRel}/${e.name}`;
            if (e.isDirectory()) visit(r, join(dirAbs, e.name));
            else if (e.name.endsWith(ext)) out.push(r);
        }
    };
    visit(rel, abs);
    return out.sort();
}

let itemIdsCache: { key: string; sig: string; map: Map<string, number> } | null = null;

/** Lookup an item id by debugname from `knowledge/items.json`. */
export function itemId(debugname: string): number | null {
    const dir = knowledgeDir();
    const p = join(dir, 'items.json');
    const sig = statSig(p);
    if (!sig) return null;
    if (!itemIdsCache || itemIdsCache.key !== p || itemIdsCache.sig !== sig) {
        const map = new Map<string, number>();
        for (const it of JSON.parse(readFileSync(p, 'utf8')) as { id: number; debugname: string }[]) map.set(it.debugname, it.id);
        itemIdsCache = { key: p, sig, map };
    }
    return itemIdsCache.map.get(debugname) ?? null;
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

const rungsBySkillCache = new WeakMap<Rung[], Map<string, Rung[]>>();

function rungsForSkill(rungs: Rung[], skill: string): Rung[] {
    let bySkill = rungsBySkillCache.get(rungs);
    if (!bySkill) {
        bySkill = new Map();
        for (let i = 0; i < rungs.length; i++) {
            const r = rungs[i]!;
            let list = bySkill.get(r.skill);
            if (!list) { list = []; bySkill.set(r.skill, list); }
            list.push(r);
        }
        rungsBySkillCache.set(rungs, bySkill);
    }
    return bySkill.get(skill) ?? [];
}

/** Match rungs belonging to `skill` and `kinds`/`idPattern`. */
export function applies(rungs: Rung[], skill: string, kinds: string[], idPattern?: RegExp): AppliesTo {
    const pool = rungsForSkill(rungs, skill);
    const outRungs: string[] = [];
    if (kinds.length || idPattern) {
        for (let i = 0; i < pool.length; i++) {
            const r = pool[i]!;
            if ((kinds.length === 0 || kinds.includes(r.kind)) && (!idPattern || idPattern.test(r.id))) outRungs.push(r.id);
        }
    }
    return { kinds, idPattern: idPattern ? idPattern.source : null, rungs: outRungs };
}

/** Construct an empty `ToolRecord` skeleton. */
export function emptyRecord(id: string, skill: string, appliesTo: AppliesTo, src: string): ToolRecord {
    return { id, skill, appliesTo, minLevel: null, levelSrc: null, items: [], consumed: [], locs: [], conditions: [], gaps: [], src };
}

let levelRequireIndex: { root: string; sig: string; byObj: Map<string, { level: number | null; src: string; gap?: string }> } | null = null;

function getLevelRequireIndex(): Map<string, { level: number | null; src: string; gap?: string }> {
    const root = contentRoot();
    const dirRel = 'scripts/levelrequire/scripts';
    const files = walk(dirRel, '.rs2');
    const sigParts: string[] = [];
    for (const f of files) sigParts.push(`${f}:${statSig(join(root, f)) ?? ''}`);
    const sig = sigParts.join('|');
    if (levelRequireIndex && levelRequireIndex.root === root && levelRequireIndex.sig === sig) {
        return levelRequireIndex.byObj;
    }
    const byObj = new Map<string, { level: number | null; src: string; gap?: string }>();
    let tutLevel: { level: number; src: string } | null | undefined;
    for (const f of files) {
        const ls = lines(f);
        for (let i = 0; i < ls.length; i++) {
            const t = ls[i]!;
            if (!t.startsWith('[opheld2,')) continue;
            const mObj = /^\[opheld2,([a-z0-9_]+)\]/.exec(t);
            if (!mObj) continue;
            const obj = mObj[1]!;
            if (byObj.has(obj)) continue;
            const text = t.trim();
            const src = `${f}:${i + 1}`;
            const m = /@levelrequire_attack\((\d+),/.exec(text);
            if (m) {
                byObj.set(obj, { level: Number(m[1]), src });
            } else if (/@tutorial_island_equip/.test(text)) {
                if (tutLevel === undefined) {
                    const tut = cite('scripts/tutorial/scripts/tutorial.rs2', /^@levelrequire_attack\((\d+), \$slot\)/, /^\[label,tutorial_island_equip\]/);
                    tutLevel = tut ? { level: Number(/\((\d+),/.exec(tut.text)![1]), src: tut.src } : null;
                }
                if (tutLevel) byObj.set(obj, { level: tutLevel.level, src: tutLevel.src });
                else byObj.set(obj, { level: null, src, gap: `${obj}: wield trigger ${src} does not call levelrequire_attack` });
            } else {
                byObj.set(obj, { level: null, src, gap: `${obj}: wield trigger ${src} does not call levelrequire_attack` });
            }
        }
    }
    levelRequireIndex = { root, sig, byObj };
    return byObj;
}

/** Attack level to wield, from `levelrequire/scripts/*.rs2` `[opheld2,<obj>]`. */
export function wieldAttack(obj: string): { level: number | null; src: string | null; gap?: string } {
    const hit = getLevelRequireIndex().get(obj);
    if (hit) return hit;
    return { level: null, src: null, gap: `${obj}: no [opheld2,${obj}] trigger in levelrequire/scripts` };
}
