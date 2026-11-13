// Writes client-assets/skill-actions.json for the XP Tracker's Skill Calculator (RuneLite's Skill Calculator): the
// actions of each skill that the pinned server's tables define (knowledge/skills.json), as {skill: [[name, level, xp,
// inputs, outputs], ...]} with item display names. An action is named after its first output, or after its table row
// when several rows of the skill give the same first output (each pickpocket target gives Coins). (knowledge/items.json). The XP is the XP that one action gives on this
// server: the table's base XP times the server's XP rate (XP_RATE, 25).
// Run: bun packages/dashboard/gen-skill-actions.ts
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { XP_RATE } from '../knowledge/src/method-model';

// counts: how many of each input one action uses (1 when absent), from the row's dbrow line (inputCounts).
export type SkillRow = { skill: string; row: string; level: number; xp: number; inputs?: string[]; outputs?: string[]; counts?: number[] };
// [name, level, XP, input names, output names, input item ids]: an input that one action uses several of is listed that
// many times. The ids tell apart items that share a name (four dragon leathers are all "Dragon leather").
export type Action = [string, number, number, string[], string[], number[]];

// The count of each input in a row's dbrow block ("data=leather,dragon_leather,3": a body uses 3 leathers).
export function inputCounts(inputs: string[], block: string): number[] {
    return inputs.map(i => Number(block.match(new RegExp(`^data=[a-z0-9_]+,${i},(\\d+)\\s*$`, 'm'))?.[1]) || 1);
}

// "limestone_rock1_table" is "Limestone rock": a rock or tree number is a map variant, not a different action.
const label = (row: string) => row.replace(/_table$/, '').replace(/(rock|tree)\d+$/, '$1').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

export function skillActions(rows: SkillRow[], names: Map<string, string>, rate = XP_RATE, ids: Map<string, number> = new Map()): Record<string, Action[]> {
    const name = (debug: string) => names.get(debug) ?? debug.replace(/_/g, ' ');
    const out: Record<string, Action[]> = {};
    const firstOut = (r: SkillRow) => r.skill + '|' + (r.outputs?.[0] ?? '');
    const uses = new Map<string, number>();
    for (const r of rows) if (r.outputs?.[0]) uses.set(firstOut(r), (uses.get(firstOut(r)) ?? 0) + 1);
    for (const r of rows) {
        if (!r.skill || !Number.isFinite(r.level) || !(r.xp > 0)) continue;
        const debugIn = (r.inputs ?? []).flatMap((d, k) => Array.from({ length: Math.max(1, r.counts?.[k] ?? 1) }, () => d));
        const outputs = (r.outputs ?? []).map(name), inputs = debugIn.map(name), inputIds = debugIn.map(d => ids.get(d) ?? 0);
        // A row with no output (a bone buried, a log burnt) is named after its input.
        const action: Action = [outputs[0] && uses.get(firstOut(r)) === 1 ? outputs[0] : !outputs.length && inputs[0] ? inputs[0] : label(r.row), Math.max(1, r.level), Math.round(r.xp * rate * 10) / 10, inputs, outputs, inputIds];
        // Map variants of one action (Limestone rock 1 to 3) give one row.
        const list = (out[r.skill] ??= []);
        if (!list.some(a => a[0] === action[0] && a[1] === action[1] && a[2] === action[2])) list.push(action);
    }
    for (const list of Object.values(out)) list.sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0].localeCompare(b[0]));
    return out;
}

// Skills that knowledge/skills.json has no table for keep their XP in item params of the content's .obj files:
// burying a bone gives oc_param(bone_exp) Prayer XP (skill_prayer/scripts/bury_bone.rs2), lighting a log gives
// oc_param(productexp) Firemaking XP at oc_param(levelrequire) (skill_firemaking/scripts/firemaking.rs2). A param is the
// XP in tenths, as stat_advance takes it; a row holds whole XP. files is [path, text]; tutorial and test items are left
// out, and keep drops the rest: the page keeps the tradeable items, as the quest and minigame variants share their names
// (seven "Monkey bones" of Monkey Madness).
export function objParamRows(files: [string, string][], keep: (debug: string) => boolean = () => true): SkillRow[] {
    const rows: SkillRow[] = [];
    for (const [path, text] of files) {
        if (/[\\/](tutorial|_test)[\\/]/.test(path)) continue;
        for (const block of text.split(/^\[/m).slice(1)) {
            const debug = block.slice(0, block.indexOf(']'));
            if (!keep(debug)) continue;
            const param = (k: string) => Number(block.match(new RegExp(`^param=${k},(\\d+)`, 'm'))?.[1]);
            const bone = param('bone_exp'), fire = param('productexp');
            if (bone > 0) rows.push({ skill: 'prayer', row: debug, level: 1, xp: bone / 10, inputs: [debug], outputs: [] });
            if (fire > 0 && /skill_firemaking/.test(path)) rows.push({ skill: 'firemaking', row: debug, level: param('levelrequire') || 1, xp: fire / 10, inputs: [debug], outputs: [] });
        }
    }
    return rows;
}

if (import.meta.main) {
    const root = join(import.meta.dir, '..', '..');
    const items: { debugname?: string; name?: string; tradeable?: boolean }[] = JSON.parse(readFileSync(join(root, 'knowledge', 'items.json'), 'utf8'));
    const tradeable = new Set(items.filter(i => i.tradeable && i.debugname).map(i => i.debugname!));
    const names = new Map(items.filter(i => i.debugname && i.name).map(i => [i.debugname!, i.name!]));
    const ids = new Map(items.filter(i => i.debugname && Number.isInteger((i as { id?: number }).id)).map(i => [i.debugname!, (i as { id: number }).id]));
    // Each knowledge row points at its dbrow line (src.row); the block from there holds the input counts.
    const content = join(root, 'vendor', 'rs-sdk', 'server', 'content'), fileCache = new Map<string, string[]>();
    const block = (src?: string) => { const m = src?.match(/^(.*):(\d+)$/); if (!m) return ''; const lines = fileCache.get(m[1]!) ?? readFileSync(join(content, m[1]!), 'utf8').split(/\r?\n/); fileCache.set(m[1]!, lines); const from = Number(m[2]) - 1, end = lines.findIndex((l, k) => k > from && l.startsWith('[')); return lines.slice(from, end < 0 ? undefined : end).join('\n'); };
    const knowledge = (JSON.parse(readFileSync(join(root, 'knowledge', 'skills.json'), 'utf8')) as (SkillRow & { src?: { row?: string } })[]).map(r => ({ ...r, counts: inputCounts(r.inputs ?? [], block(r.src?.row)) }));
    const scripts = join(root, 'vendor', 'rs-sdk', 'server', 'content', 'scripts');
    const objs = (d: string): [string, string][] => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? objs(p) : f.endsWith('.obj') ? [[p, readFileSync(p, 'utf8')] as [string, string]] : []; });
    const actions = skillActions([...knowledge, ...objParamRows(objs(scripts), debug => tradeable.has(debug))], names, XP_RATE, ids);
    writeFileSync(join(import.meta.dir, 'client-assets', 'skill-actions.json'), JSON.stringify(actions));
    console.log(`skill-actions.json: ${Object.values(actions).reduce((n, l) => n + l.length, 0)} actions in ${Object.keys(actions).length} skills`);
}
