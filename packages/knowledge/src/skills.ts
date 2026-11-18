import type { ConfigBlock } from './config';
import type { DbTable } from './dbtables';

// One planner-ready row per skill action, read from the skill dbtables. XP is whole XP: content stores
// tenths (stat_advance(stat, value) awards value / 10). `xp: null` means the content holds no XP for the row.
export interface SkillAction {
    skill: string;
    table: string;
    row: string;
    level: number;
    xp: number | null;
    inputs: string[];
    outputs: string[];
    at: { locs?: string[]; npcs?: string[] };
    src: { level: string; xp?: string; row: string };
}

interface Mapping { table: string; skill: string; level: string; xp?: string; inputs?: string[]; outputs?: string[]; locs?: string; npcs?: string }

export const SKILL_TABLES: Mapping[] = [
    { table: 'woodcutting_trees', skill: 'woodcutting', level: 'levelrequired', xp: 'productexp', outputs: ['product'], locs: 'tree' },
    { table: 'mining_table', skill: 'mining', level: 'rock_level', xp: 'rock_exp', outputs: ['rock_output'], locs: 'rock' },
    { table: 'cooking_generic', skill: 'cooking', level: 'levelrequired', xp: 'experience', inputs: ['uncooked'], outputs: ['cooked'] },
    { table: 'smithing', skill: 'smithing', level: 'levelrequired', inputs: ['bar'], outputs: ['product'] },
    { table: 'fletching_table', skill: 'fletching', level: 'level', xp: 'experience', inputs: ['item'], outputs: ['product'] },
    { table: 'craft_leather_table', skill: 'crafting', level: 'levelrequired', xp: 'productexp', inputs: ['leather'], outputs: ['product'] },
    { table: 'gem_cutting_table', skill: 'crafting', level: 'level', xp: 'experience', inputs: ['uncut_gem'], outputs: ['cut_gem'] },
    { table: 'runecraft_table', skill: 'runecraft', level: 'level', xp: 'experience', outputs: ['rune'] },
    { table: 'magic_spell_table', skill: 'magic', level: 'levelrequired', xp: 'experience' },
    { table: 'pickpocket', skill: 'thieving', level: 'level', xp: 'experience', outputs: ['loot'], npcs: 'npc' },
    { table: 'stealing', skill: 'thieving', level: 'level', xp: 'experience', outputs: ['loot'], locs: 'loc' },
    { table: 'trapped_chest', skill: 'thieving', level: 'level', xp: 'experience', outputs: ['loot'], locs: 'loc' },
];

export function buildSkillActions(tables: DbTable[], sources?: ConfigSources): SkillAction[] {
    const out: SkillAction[] = [];
    // An anvil row gives bar_amount x xpperbar of the bar's struct (smithing.rs2 `smithing_anvil`).
    const anvil = sources ? anvilXpPerBar(sources) : new Map<string, { xp: number; src: string }>();
    for (const m of SKILL_TABLES) {
        const t = tables.find(x => x.table === m.table);
        if (!t) continue;
        for (const r of t.rows) {
            const first = (col: string) => r.data[col]?.[0]?.[0];
            const firsts = (col: string) => (r.data[col] ?? []).map(v => v[0]!).filter(Boolean);
            const lvl = first(m.level);
            if (lvl === undefined) continue;
            const rawXp = m.xp ? first(m.xp) : undefined;
            const bar = m.table === 'smithing' ? anvil.get(first('bar') ?? '') : undefined, bars = Number(first('bar_amount') ?? 1);
            out.push({
                skill: m.skill,
                table: m.table,
                row: r.name,
                level: Number(lvl),
                xp: rawXp !== undefined ? Number(rawXp) / 10 : bar ? bars * bar.xp : null,
                inputs: (m.inputs ?? []).flatMap(firsts),
                outputs: (m.outputs ?? []).flatMap(firsts),
                at: { ...(m.locs ? { locs: firsts(m.locs) } : {}), ...(m.npcs ? { npcs: firsts(m.npcs) } : {}) },
                src: { level: r.src[m.level]![0]!, ...(m.xp && r.src[m.xp] ? { xp: r.src[m.xp]![0]! } : bar ? { xp: bar.src } : {}), row: r.def },
            });
        }
    }
    if (sources) out.push(...buildConfigSkillActions(sources));
    return out;
}

// Skill actions that the dbtables do not hold. Levels are whole levels; `xp` is whole XP (content stores tenths).
// - firemaking: one row per log object with `param=levelrequire` and `param=productexp` (skill_firemaking/configs/firemaking.obj).
// - herblore: one row per brew struct with `brew_potion_mixture` (skill_herblore/configs/brewing/brew_potion.struct);
//   a struct with no `brew_potion_level` has level 0, with no `brew_potion_exp` it gives no XP.
// - smithing, smelting: one row per `smelting_*` struct (`levelrequired`, `productexp`; skill_smithing/configs/smelting).
// The `table` of the rows that buildConfigSkillActions writes.
export const CONFIG_SKILL_TABLES: ReadonlySet<string> = new Set(['firemaking.obj', 'brew_potion.struct', 'smelting.struct']);

export interface ConfigSources {
    objs: readonly ConfigBlock[];
    structs: readonly ConfigBlock[];
}

// A `param=key,value` line of an object or struct block: its values, and the line of the first one.
const pv = (b: ConfigBlock, key: string): string[] => (b.props.param ?? []).flatMap(v => v.startsWith(key + ',') ? [v.slice(key.length + 1)] : []);
const at = (b: ConfigBlock, key: string) => `${b.file}:${b.propLines.param![(b.props.param ?? []).findIndex(v => v.startsWith(key + ','))]}`;
const num = (b: ConfigBlock, key: string): number | undefined => (pv(b, key)[0] === undefined ? undefined : Number(pv(b, key)[0]));

export function buildConfigSkillActions({ objs, structs }: ConfigSources): SkillAction[] {
    const out: SkillAction[] = [];
    for (const b of objs) {
        if (!b.file.startsWith('scripts/skill_firemaking/') || num(b, 'levelrequire') === undefined || num(b, 'productexp') === undefined) continue;
        out.push({
            skill: 'firemaking', table: 'firemaking.obj', row: b.name, level: num(b, 'levelrequire')!, xp: num(b, 'productexp')! / 10,
            inputs: [b.name], outputs: [], at: {},
            src: { level: at(b, 'levelrequire'), xp: at(b, 'productexp'), row: `${b.file}:${b.line}` },
        });
    }
    for (const b of structs) {
        if (b.file.startsWith('scripts/skill_herblore/configs/brewing/') && pv(b, 'brew_potion_mixture').length) {
            const hasLevel = pv(b, 'brew_potion_level').length > 0, hasXp = pv(b, 'brew_potion_exp').length > 0;
            out.push({
                skill: 'herblore', table: 'brew_potion.struct', row: b.name, level: hasLevel ? num(b, 'brew_potion_level')! : 0, xp: hasXp ? num(b, 'brew_potion_exp')! / 10 : null,
                inputs: [...(pv(b, 'brew_potion_solvent')), ...(pv(b, 'brew_potion_ingredient'))], outputs: pv(b, 'brew_potion_mixture'), at: {},
                src: { level: hasLevel ? at(b, 'brew_potion_level') : `${b.file}:${b.line}`, ...(hasXp ? { xp: at(b, 'brew_potion_exp') } : {}), row: `${b.file}:${b.line}` },
            });
        } else if (b.file.startsWith('scripts/skill_smithing/configs/smelting/') && num(b, 'levelrequired') !== undefined && num(b, 'productexp') !== undefined) {
            out.push({
                skill: 'smithing', table: 'smelting.struct', row: b.name, level: num(b, 'levelrequired')!, xp: num(b, 'productexp')! / 10,
                inputs: [...(pv(b, 'ingredient')), ...(pv(b, 'ingredient_secondary'))], outputs: pv(b, 'product'), at: {},
                src: { level: at(b, 'levelrequired'), xp: at(b, 'productexp'), row: `${b.file}:${b.line}` },
            });
        }
    }
    return out;
}

// The anvil XP of each bar: a bar object names its `smithing_anvil_struct`, which holds `xpperbar` (tenths).
export function anvilXpPerBar({ objs, structs }: ConfigSources): Map<string, { xp: number; src: string }> {
    const xpOf = new Map(structs.filter(s => pv(s, 'xpperbar').length).map(s => [s.name, { xp: Number(pv(s, 'xpperbar')[0]) / 10, src: at(s, 'xpperbar') }]));
    const out = new Map<string, { xp: number; src: string }>();
    for (const o of objs) {
        const x = xpOf.get(pv(o, 'smithing_anvil_struct')[0] ?? '');
        if (x) out.set(o.name, x);
    }
    return out;
}
