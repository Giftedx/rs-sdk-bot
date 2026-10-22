import type { DbTable } from './dbtables';

// One planner-ready row per skill action, read from the skill dbtables. XP is whole XP: content stores
// tenths (stat_advance(stat, value) awards value / 10). `xp: null` means the table does not hold the XP
// (smithing XP lives in smithing.struct, not mined yet).
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

export function buildSkillActions(tables: DbTable[]): SkillAction[] {
    const out: SkillAction[] = [];
    for (const m of SKILL_TABLES) {
        const t = tables.find(x => x.table === m.table);
        if (!t) continue;
        for (const r of t.rows) {
            const first = (col: string) => r.data[col]?.[0]?.[0];
            const firsts = (col: string) => (r.data[col] ?? []).map(v => v[0]!).filter(Boolean);
            const lvl = first(m.level);
            if (lvl === undefined) continue;
            const rawXp = m.xp ? first(m.xp) : undefined;
            out.push({
                skill: m.skill,
                table: m.table,
                row: r.name,
                level: Number(lvl),
                xp: rawXp === undefined ? null : Number(rawXp) / 10,
                inputs: (m.inputs ?? []).flatMap(firsts),
                outputs: (m.outputs ?? []).flatMap(firsts),
                at: { ...(m.locs ? { locs: firsts(m.locs) } : {}), ...(m.npcs ? { npcs: firsts(m.npcs) } : {}) },
                src: { level: r.src[m.level]![0]!, ...(m.xp && r.src[m.xp] ? { xp: r.src[m.xp]![0]! } : {}), row: r.def },
            });
        }
    }
    return out;
}
