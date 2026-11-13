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

// The [name] blocks of a config file as {name, params}: `param=key,value` lines, and `data=key,value` lines of a dbrow.
export function configBlocks(text: string): { name: string; p: Map<string, string> }[] {
    return text.split(/^\[/m).slice(1).map(block => {
        const p = new Map<string, string>();
        for (const m of block.matchAll(/^(?:param|data)=([a-z0-9_]+),(.*)$/gm)) p.set(m[1]!, m[2]!.trim());
        return { name: block.slice(0, block.indexOf(']')), p };
    });
}
const num = (v: string | undefined, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const times = (debug: string | undefined, n: number) => debug && n > 0 ? Array.from({ length: n }, () => debug) : [];

// Smithing and Herblore keep their actions in structs and a dbtable (XP in tenths, as stat_advance takes it):
// - smelting.struct: product, levelrequired, productexp, ingredient x bar_count, ingredient_secondary x its count
//   (skill_smithing/scripts/smelting/smelting.rs2).
// - smithing.dbrow: product x product_amount from bar x bar_amount at levelrequired; the XP is bar_amount times the
//   xpperbar of the bar's smithing.struct (skill_smithing/scripts/smithing/smithing.rs2:283).
// - brew_potion.struct: brew_potion_ingredient and brew_potion_solvent make brew_potion_mixture at brew_potion_level
//   for brew_potion_exp (an unfinished potion gives none).
// - herbs.obj: identifying a herb gives identified_herb_exp at identified_herb_level (identify.param: default 3). The
//   input is the unidentified herb that identify.rs2 turns into it ([opheld1,unidentified_guam] calls
//   ~attempt_identify_herb(guam_leaf, ...)). Every unidentified herb is named "Herb": the item ids tell them apart.
export function contentRows(c: { smelting: string; smithingStruct: string; smithingRows: string; brewing: string; herbs: string; identify?: string; identifyParams?: string }): SkillRow[] {
    const rows: SkillRow[] = [];
    for (const { name, p } of configBlocks(c.smelting)) {
        if (!p.get('product')) continue;
        rows.push({ skill: 'smithing', row: name, level: num(p.get('levelrequired'), 1), xp: num(p.get('productexp')) / 10,
            inputs: [...times(p.get('ingredient'), num(p.get('bar_count'), 1)), ...times(p.get('ingredient_secondary'), num(p.get('ingredient_secondary_count'), 1))], outputs: [p.get('product')!] });
    }
    const perBar = new Map(configBlocks(c.smithingStruct).filter(b => b.p.get('namedobj')).map(b => [b.p.get('namedobj')!, num(b.p.get('xpperbar'))]));
    for (const { name, p } of configBlocks(c.smithingRows)) {
        const bar = p.get('bar'), amount = num(p.get('bar_amount'), 1), product = p.get('product');
        if (!bar || !product || !perBar.get(bar)) continue;
        rows.push({ skill: 'smithing', row: name, level: num(p.get('levelrequired'), 1), xp: amount * perBar.get(bar)! / 10, inputs: times(bar, amount), outputs: times(product, num(p.get('product_amount'), 1)).slice(0, 1) });
    }
    for (const { name, p } of configBlocks(c.brewing)) {
        const xp = num(p.get('brew_potion_exp'));
        if (!xp || !p.get('brew_potion_mixture')) continue;
        rows.push({ skill: 'herblore', row: name, level: num(p.get('brew_potion_level'), 1), xp: xp / 10, inputs: [p.get('brew_potion_ingredient'), p.get('brew_potion_solvent')].filter(Boolean) as string[], outputs: [p.get('brew_potion_mixture')!] });
    }
    const unid = new Map([...(c.identify ?? '').matchAll(/\[opheld1,([a-z0-9_]+)\]\s*~attempt_identify_herb\(([a-z0-9_]+)/g)].map(m => [m[2]!, m[1]!]));
    const herbLevel = num((c.identifyParams ?? '').match(/\[identified_herb_level\][^[]*?default=(\d+)/)?.[1], 1);
    for (const { name, p } of configBlocks(c.herbs)) {
        const xp = num(p.get('identified_herb_exp'));
        if (xp > 0) rows.push({ skill: 'herblore', row: name, level: num(p.get('identified_herb_level'), herbLevel), xp: xp / 10, inputs: unid.has(name) ? [unid.get(name)!] : [], outputs: [name] });
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
    const scripts = join(root, 'vendor', 'rs-sdk', 'server', 'content', 'scripts'), read = (p: string) => readFileSync(join(scripts, p), 'utf8');
    const objs = (d: string): [string, string][] => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? objs(p) : f.endsWith('.obj') ? [[p, readFileSync(p, 'utf8')] as [string, string]] : []; });
    const actions = skillActions([...knowledge, ...objParamRows(objs(scripts), debug => tradeable.has(debug)),
        ...contentRows({
            smelting: read('skill_smithing/configs/smelting/smelting.struct'), smithingStruct: read('skill_smithing/configs/smithing/smithing.struct'),
            smithingRows: read('skill_smithing/configs/smithing/smithing.dbrow'), brewing: read('skill_herblore/configs/brewing/brew_potion.struct'), herbs: read('skill_herblore/configs/herbs.obj'),
            identify: read('skill_herblore/scripts/identifying/identify.rs2'), identifyParams: read('skill_herblore/configs/identifying/identify.param'),
        })], names, XP_RATE, ids);
    writeFileSync(join(import.meta.dir, 'client-assets', 'skill-actions.json'), JSON.stringify(actions));
    console.log(`skill-actions.json: ${Object.values(actions).reduce((n, l) => n + l.length, 0)} actions in ${Object.keys(actions).length} skills`);
}
